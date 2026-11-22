# Clean installation (D1800)

First installation uses a new site stack and its configured empty volumes. It does
not call `ops_deploy_entry.py` with `mode=emr-introduction`: that mode is for an
existing installation's conversion only. No conversion phase or rehearsal receipt
is an admission condition for a clean install.

1. Backup: preserve the selected installation configuration and signing wrapping
   secrets before installation. For an existing stack, first run
   `python3 scripts/ops_backup.py backup --output <backup-directory>` and keep the
   resulting snapshot. A new empty site has no patient database to back up.
2. Install and migrate under the existing operations lock. Keep one operator's
   Python session open in the configured checkout for steps 2–4; do not launch
   Compose outside that session. Before mutation, compare `socket.gethostname()`,
   `git rev-parse HEAD`, `docker version` and `docker compose version` with the
   selected site's host and approved release/version record. A mismatch stops the
   install. Record those observed values, the selected SHA, configuration/secret
   backup locations and the operator in the private release record.

   ```python
   # Start python3 interactively in the selected checkout.
   import sys, socket
   from pathlib import Path
   sys.path.insert(0, 'scripts')
   import ops_backup as ops
   hold = ops.lock()
   lease = hold.__enter__()  # held across installation, verification and rehearsal
   ops.require_local_docker()
   observed = {'host': socket.gethostname(), 'sha': ops.text(['git', 'rev-parse', 'HEAD']),
               'docker': ops.text(['docker', 'version']),
               'compose': ops.text(['docker', 'compose', 'version'])}
   print(observed)  # compare to the selected site's release record before continuing
   ```

   After that comparison, set `record_path` to the private release record's path
   outside the checkout, `record` to the observed values plus the operator and
   backup locations, and `install_timeout` to the site's measured installation
   hang timeout (seconds). Until the site has its own measurement, use
   `install_timeout = 2400` and `backup_timeout = 600` (a release's first
   backup, also in a rollback project), the values the
   2026-10-31 rehearsal ran with; 600 s is also the existing base-backup helper
   hang timeout (below step 4). Define `clean_env`, `compose_for` and
   `config_matches` from [Site Compose command](#site-compose-command).

   Put `KIN_REVISION=<selected full SHA>` in the checkout's `.env` before the
   build. The API image's revision label comes only from it
   (`VCS_REF: ${KIN_REVISION:-unknown}`, `docker-compose.prod.yml`), because
   `clean_env` drops an exported value. `.env` is not tracked, so `backup()`
   does not count the change as a dirty checkout.

   Put the site's preload disk cap `KIN_PRELOAD_DISK_GB=<GiB>` in the same
   `.env`: a positive number the site decides from the reading PC's free disk
   ([preload-cache.md](preload-cache.md); `.env.example` carries `change-me`).
   The product has no default. Without a valid value the stack still starts, but
   Preload stays off, each study's Preload shows Failed with that reason (a row with a
   refusal of its own, such as a merged exam that cannot be read whole, shows its own)
   and the API logs one startup line naming `KIN_PRELOAD_DISK_GB`; step 3 checks for it.

   Decide signing before Compose starts. Online approvals are enabled at
   installation exactly when the custody configuration
   `/etc/kin-deploy/emr-wrapping-custody.json` is installed (Nightly job). Its
   `c2-wrap-v1` file is then prepared as Enabling online approvals requires, and
   the stack starts with the signing overlay mapping that same file. Without the
   configuration the stack starts without the overlay. Persist the hold and the
   decision before starting Compose:

   ```python
   import re
   assert 'KIN_EMR_WRAPPING_CUSTODY' not in os.environ   # backups in this session read only the installed configuration
   project = ops.ROOT.name                                # a plain invocation in the checkout then names the same project
   assert re.fullmatch(r'[a-z0-9][a-z0-9_-]*', project)
   assert 'COMPOSE_PROJECT_NAME' not in ops.env_names(ops.ROOT / '.env')
   secret_file = None
   if ops.WRAPPING_CUSTODY_CONFIG.is_file():
       secret_file = json.loads(ops.WRAPPING_CUSTODY_CONFIG.read_text(encoding='utf-8'))['files']['c2-wrap-v1']
   files = ['docker-compose.yml', 'docker-compose.prod.yml'] + ([SIGNING_OVERLAY] if secret_file else [])
   compose = compose_for(project, ops.ROOT, files, secret_file)
   lease.retain()
   record.update(status='STARTED', compose_project=project, compose_files=files, wrapping_secret_file=secret_file)
   ops.write_json(record_path, record)
   ops.run(compose + ['up', '-d', '--build'], timeout=install_timeout)
   ```

   A host that must not build (its CPU and memory are shared with other
   services) loads images built elsewhere instead and drops `--build`, as in
   upgrade step 3 below.

   PostgreSQL initializes both `kin` and `keycloak` on the new empty data volume;
   the init SQL does not run again on an existing volume. The API image runs
   `prisma migrate deploy`; do not use schema reset or db push.
3. Verify in the same session: run `ops.run(compose + ['ps'])` and
   check both the API and the Keycloak realm through the configured HTTPS origin:

   ```python
   import subprocess, time
   origin = '<configured-HTTPS-origin>'  # no trailing slash
   readiness_timeout = 134
   deadline = time.monotonic() + readiness_timeout
   failure = None  # (path, curl's own error) of the last request that failed
   while True:
       for path in ['/api/health', '/auth/realms/kin/.well-known/openid-configuration']:
           remaining = deadline - time.monotonic()
           if remaining <= 0:
               where, cause = failure or (path, 'the deadline came before this request')
               raise RuntimeError(f'Installation unverified: HTTPS readiness failed within '
                                  f'{readiness_timeout}s at {where} ({cause}); inspect service logs')
           try:
               result = ops.run(['curl', '--fail', '--silent', '--show-error', '--max-time', str(remaining),
                                 origin + path], timeout=remaining, check=False)
               cause = result.returncode and (f'curl exit {result.returncode}: '
                                              + result.stderr.decode('utf-8', 'replace').strip())
           except subprocess.TimeoutExpired:
               cause = f'no answer within {remaining:.0f}s'
           if cause:
               failure = (path, cause)
               break
       else:
           break  # both requests answered in the same round
       time.sleep(min(3, max(0, deadline - time.monotonic())))
   ```

   The failure names the request that last failed and curl's own error for it,
   never the request that merely found the deadline passed. The 134 s bound is
   `ceil(2 × max(41.7, 45.3, 67.0, 30.5))`: twice the slowest clean-install
   readiness recorded for PR #258 (laptop 41.7, 45.3 and 67.0 s; desktop 30.5 s),
   rounded up to whole seconds. The 3 s pause only
   spaces the rounds; it is not a measured value and the deadline alone decides
   the outcome. Record the site's elapsed readiness time and recheck this bound
   before a larger site; it is an installation wait, not a clinical performance
   requirement.
   Both requests must succeed. A running container and `/api/health` with
   `auth:true` alone do not establish that Keycloak has started: `auth` describes
   the API's authentication configuration. If either request fails, inspect the
   service logs and keep the installation unverified. After correcting the cause,
   repeat this bounded check and preserve the first failure in the release record.
   Then check that the started API has the preload disk cap: its log carries no
   startup line naming the setting.

   ```python
   logs = ops.run(['docker', 'logs', 'kin-api'])
   assert b'KIN_PRELOAD_DISK_GB' not in logs.stdout + logs.stderr, 'Set KIN_PRELOAD_DISK_GB in .env'
   ```

   On failure set the value in `.env`, recreate the API with the same `compose`
   (`ops.run(compose + ['up', '-d', 'api'], timeout=install_timeout)`), then
   repeat the readiness loop and this check.
   Then perform the approved synthetic save/reopen and signing checks
   ([below](#synthetic-savereopen-and-signing-checks)) before clinical handover.
   Save their actual outcomes in the release record.

   **First administrator of each institution.** A hospital administrator manages
   only the members of their own institution, so an institution without an
   active administrator needs its first one from the operator command (see
   [keycloak/README.md, "기관 첫 관리자 지정"](../../keycloak/README.md)):
   `ops.run(compose + ['exec', '-T', 'api', 'node', 'prisma/designate-first-admin.cjs',
   '--institution', '<group>', '--subject', '<Keycloak user id>', '--operator', '<who>',
   '--reason', '<hospital request and how it was confirmed>'])`. The printed
   `designated` matches the exit code. Exit 0: designated and the roster
   confirmed. Exit 2: designated (committed), roster unconfirmed — run
   `node prisma/import-member-rights.cjs --retry-roster` in the same container.
   Exit 1: not designated — refused, or the designation transaction failed
   before it committed or is known not to have committed (no rights granted).
   Exit 3: unknown — the commit answer was lost and this run's audit row is not
   seen; check the institution's members (or the audit log) for this person as
   administrator, then run `--retry-roster` if they are, or the same command
   again if they are not. A failed
   cleanup at the end is printed on its own line and does not change the exit
   code. Record the institution, subject and exit code in the release record.
   Skip institutions that already have one.
4. Backup and restore: after verification, take the **first populated backup**
   with `ops.backup('<backup-directory>')` in this same locked session (the CLI
   equivalent outside this session is `python3 scripts/ops_backup.py backup --output <backup-directory>`).
   Record the exact snapshot directory printed by the backup, then run
   `ops.rehearse(Path('<snapshot-directory>'))`, equivalent to
   `python3 scripts/ops_backup.py rehearse <snapshot-directory>`. When the set's
   manifest has `wrapping_custody`, follow the wrapping custody recovery commands
   below as well; otherwise record them as not applicable (check 2 below). This
   exercises restore even when the site had no database before installation.

   Only after verification and rehearsal succeed, record their raw evidence paths
   and `status=VERIFIED_AND_RESTORED` with `ops.write_json(record_path, record)`,
   then set `lease.retained = False` and call `hold.__exit__(None, None, None)`.
   On failure or interruption, keep the lock and a `NEEDS_ATTENTION` release
   record; inspect the incomplete installation before releasing it. Preserve the
   failed installation and restore the selected snapshot in the recovery
   environment; never overwrite an existing site's volumes with a clean install.

The first site's measured backup size and elapsed time are installation records;
recheck them before a larger site or when the backup approaches the existing 600 s
base-backup helper hang timeout; that timeout still needs the first-site measurement. Conversion commands remain available only when
an existing installation actually needs conversion. This procedure does not claim
an installation or restore was executed by this documentation change.

## Site Compose command

Installation, upgrade, enabling online approvals and rollback start Compose only
in this form. Each Compose project is then fully described by its checkout
directory, that directory's `.env`, its compose file list and at most one
signing file path:
- `env -i` drops every inherited variable, so an exported `POSTGRES_PASSWORD`,
  `KC_WEB_SECRET` or `COMPOSE_PROJECT_NAME` cannot override `.env`. Docker's
  interpolation precedence puts the shell environment above `.env`.
- Only what the Docker client itself needs passes through.
- The signing overlay's one variable is given explicitly, and only together with
  the overlay.

```python
import json, os
from pathlib import Path
SIGNING_OVERLAY = 'emr/deploy/docker-compose.signing.yml'

def clean_env(*assignments):
    keep = [f'{name}={os.environ[name]}' for name in ('PATH', 'HOME', 'DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_CONFIG')
            if name in os.environ]
    return ['env', '-i', *keep, *assignments]

def compose_for(project, directory, files, secret_file):
    """files: paths relative to directory, in merge order; secret_file: the c2-wrap-v1 host file, or None."""
    assert (SIGNING_OVERLAY in files) == bool(secret_file)
    directory = Path(directory)
    signing = [f'KIN_EMR_WRAPPING_SECRET_FILE={secret_file}'] if secret_file else []
    return (clean_env(*signing) + ['docker', 'compose', '-p', project, '--project-directory', str(directory),
                                   '--env-file', str(directory / '.env')]
            + [arg for name in files for arg in ('-f', str(directory / name))])

def config_matches(compose, project):
    """The cleaned environment reaches this session's daemon, and every existing container of the project carries
    the configuration hash this command renders."""
    probe = ['docker', 'info', '--format', '{{.ID}}']
    daemon = ops.text(probe)
    if not daemon or ops.text(clean_env() + probe) != daemon:
        return False
    rendered = dict(line.split(' ', 1) for line in ops.text(compose + ['config', '--hash', '*']).splitlines())
    ids = ops.text(clean_env() + ['docker', 'ps', '-aq', '--filter', f'label=com.docker.compose.project={project}']).split()
    labels = ([item['Config']['Labels'] for item in json.loads(ops.text(clean_env() + ['docker', 'inspect', *ids]))]
              if ids else [])
    return bool(labels) and all(rendered.get(label['com.docker.compose.service']) == label['com.docker.compose.config-hash']
                                for label in labels)
```

`config_matches` compares hashes only, so no configuration value reaches the
log. Compose stores the same service hash in each container's
`com.docker.compose.config-hash` label when it creates the container. Equality
therefore means the command reproduces the running configuration, including
interpolated credentials. The hash leaves out build settings. A different
Compose version can compute it differently. The observed `docker compose version`
is compared with the release record before any of this runs.

Every Docker read in `config_matches` runs under `clean_env`, as Compose will.
It first compares the daemon ID that `docker info` reports under `clean_env` with
the one this session reaches. A cleaned environment that reaches no daemon fails
the command. One that reaches another daemon, or reports an empty ID, returns
`False`. Either way the check fails before anything changes.

## Synthetic save/reopen and signing checks

Three checks make up step 3's "approved synthetic save/reopen and signing
checks". Neither writes a synthetic record into a clinical installation: report
versions are append-only (AGENTS §1.1) and there is no Orthanc delete feature
(AGENTS §6), so whatever a check saved on the site would stay there.

1. **Save/reopen and signed approval: the G3 candidate run of the installed SHA.**
   `.github/workflows/candidate.yml` (`tests/candidate_ci.py`) is the approved
   candidate gate (AGENTS §2). It runs on a disposable synthetic stack that
   `tests/measurement_ci.py` starts with the deployment's own signing overlay and
   a fresh 32-byte `c2-wrap-v1` file (`tests/emr/d/synthetic_stack.py`); each
   synthetic doctor gets a C2 key (`tests/emr/d/provision_synthetic.cjs`). Its
   selection includes `WorklistE2E.test_02_selection_draft_isolation` (draft
   save), `test_11_approved_buttons_stay_disabled_after_reload` (UI Approve,
   reload, the same findings, one version) and
   `RelatedReportModeE2E.test_w5_01_prior_insert_loss_check_back_commit_reopen`
   (save, approval, reopen). An approval there succeeds only through the server
   signing path; a stack without the wrapping mapping answers
   `WrappingSecretConfigurationPending` (see Enabling online approvals). These
   tests do not read `emr_signing.signed_version` themselves; signature
   verification after a PostgreSQL restore is CI's `ServerSigningPg`
   (`tests/emr/c/server_signing_live.py`). Find the run with
   `gh run list --workflow candidate.yml --json databaseId,displayTitle,conclusion,createdAt`.
   Expected: `displayTitle` `candidate <installed SHA> [g3:<nonce>]` and
   `conclusion` `success`. Record the run ID and the `candidate-<SHA>` artifact
   in the release record. A missing or failed run leaves the check NOT_RUN or
   FAIL; a run of another SHA does not count.
2. **Signing recovery on the installed host: step 4's backup and rehearsal.**
   `rehearse` restores the set's wrapping custody copy and unwraps every restored
   private key with the recorded API image's own `unwrapServerPrivateKey`.
   Expected in its printed JSON, besides `success: true`:
   - custody configured (Nightly job): `wrapping_custody.custody` =
     `restored and verified` and `wrapping_custody.keys` = the row count of
     `emr_signing.private_key`. That count is 0 on a clean install and ≥ 1 after
     the admin's first Create Key (Enabling online approvals). Run a new backup
     and rehearsal after that first key; until then the key is not recoverable;
   - no custody configuration and no keys:
     `{"keys": 0, "custody": "not configured; no stored signing keys"}`. Stored
     keys without custody fail the backup itself.

   When the set's manifest has `wrapping_custody`, `restore-wrapping` (Recovery
   and rehearsal) must print the `c2-wrap-v1` → restored file mapping. A set
   without it has no locator: the command stops with `Wrapping custody locator is
   missing` (`ops_backup.wrapping_custody_files`). Record custody restoration as
   not applicable then, with the rehearsal JSON above as the evidence.
3. **Signing path of the running API on the host.** `secret_file` is the host
   path the stack was started with (`None` without the overlay):
   - after installation, an upgrade or Enabling online approvals:
     `record['wrapping_secret_file']`;
   - in a rollback project R, before its entry opens:
     `record['rollback_secret_file']`;
   - on the return from R to N: `record['n_secret_file']`.

   The check applies when `secret_file` is set,
   `/etc/kin-deploy/emr-wrapping-custody.json` exists, or
   `emr_signing.private_key` has rows. Otherwise, record "online approvals not
   enabled". Approvals then answer `WrappingSecretConfigurationPending` (Enabling
   online approvals).

   The check confirms three things:
   - the custody configuration, which the nightly backup copies, names the same
     `c2-wrap-v1` file;
   - `kin-api` runs with the signing overlay's mapping of that file;
   - its own user reads the mapped file and unwraps every stored private key with
     the product code an approval uses (`FileWrappingSecrets.read`, then
     `unwrapServerPrivateKey`).

   ```python
   import json, tempfile
   custody = json.loads(ops.WRAPPING_CUSTODY_CONFIG.read_text(encoding='utf-8'))
   assert secret_file and custody['files'].get('c2-wrap-v1') == secret_file
   api = json.loads(ops.text(['docker', 'inspect', 'kin-api']))[0]
   env = dict(entry.split('=', 1) for entry in api['Config']['Env'] if '=' in entry)
   assert env.get('KIN_EMR_WRAPPING_KEY_ID') == 'c2-wrap-v1'
   assert [m['Source'] for m in api['Mounts']
           if m['Destination'] == '/run/secrets/emr-signing-wrap-v1'] == [secret_file]
   script = """const {FileWrappingSecrets}=require('/app/dist/emr-signature/server-keys');
   const {unwrapServerPrivateKey}=require('/app/dist/emr-signature/server-crypto');
   (async()=>{const rows=JSON.parse(require('node:fs').readFileSync(0,'utf8'));
   const secrets=new FileWrappingSecrets(process.env.KIN_EMR_WRAPPING_KEY_ID,JSON.parse(process.env.KIN_EMR_WRAPPING_KEY_FILES));
   (await secrets.read(secrets.currentId)).fill(0);
   for(const row of rows){const id=row.wrapped.wrappingKeyId,secret=await secrets.read(id);
   try{unwrapServerPrivateKey(row.wrapped,row.kid,id,secret);}finally{secret.fill(0);}}
   process.stdout.write('SIGNING_PATH_READY '+rows.length);})().catch(()=>{process.exitCode=1;});"""
   with tempfile.TemporaryFile() as rows:
       rows.write(json.dumps(ops.signing_keys('kin-db')).encode())
       rows.seek(0)
       print(ops.run(['docker', 'exec', '-i', 'kin-api', 'node', '-e', script], input_file=rows).stdout.decode())
   ```

   Expected: `SIGNING_PATH_READY <n>`, where `n` is the row count of
   `emr_signing.private_key`. `docker exec` runs as the production image's
   `node` user (`api/Dockerfile`, `USER node`). A file that uid 1000 cannot read,
   a missing overlay, a custody configuration naming another file, or bytes that
   differ from the stored keys therefore fail here, not at a doctor's first
   approval or a later restore. The script prints no error text, so no key
   material reaches the log.

The end-to-end signed approval is check 1's synthetic run. Check 3 shows that
the installed API takes the same path to the key. The site's own first signed
approval is a doctor's, not the operator's (AGENTS §1.1). Record its outcome as
the first observation after handover: either a new `emr_signing.signed_version`
row, or the error the doctor saw. No tool performs a save, reopen or signed
approval on the installed host itself. The LiveStack suites run only on a
disposable synthetic stack through `scripts/run-tests.py` (AGENTS §2), not on a
site.

## Draft purpose ledger: first start (CD-09-P/C)

The API keeps its draft destruction ledger in the `purpose-ledger` volume, which
no database backup contains. At every start the API matches the database with
that directory and opens only when they belong together.

Since CD-09-C the API opens behind one retention gate that holds every retention
unit in a fixed order; the draft purpose ledger is its first unit and the report
retention ledger (CD-09-D, [below](#report-retention-ledger-cd-09-d)) its second. The log names the unit and its code, for example
`draft-purpose PurposeLedgerMismatch`. The first unit that cannot open stops the
start: later units are not opened, no sweep runs and the API does not listen.
Each unit reads only its own files in the directory (the draft purpose unit:
`purpose-ledger.jsonl` and `purpose-adoption.json`); another file there neither
opens nor closes it. A held destruction or one the startup sweep could not
finish is logged and the API still opens; the dedicated sweep run reports it.

- A database that never handed out a draft work opens; its first new work
  creates the ledger.
- A server that already had drafts opens on its first start only if the
  operator prepared it **before** the P migration, with the API image of the
  new release and the API's own credential and volume. Use the stack's own
  `compose` ([Site Compose command](#site-compose-command), as in upgrade step 1):

  ```python
  prepared = ops.run(compose + ['run', '--rm', '--no-deps', 'api',
                                'node', 'dist/emr-retention/draft-purpose-prepare.js'], check=False)
  print(prepared.returncode, prepared.stdout.decode())
  ```

  Expected: one line `{"prepared":true,"state":"prepared"}` and exit 0. It
  refuses (exit 1, nothing written) when the directory is not the deployment's
  own, a ledger or an adoption record is already there, the database already
  has the P migration, or the database cannot be reached. The first start
  consumes the record once.
- Closed (the API does not open; the log names the code): drafts with nothing
  prepared (`PurposeLedgerInitializationRequired`), a consumed preparation or an
  initialized database without its ledger (`PurposeLedgerMissing`), a ledger of
  another ID (`PurposeLedgerMismatch`), a ledger shorter than the database saw
  or with another record at the anchor's position (`PurposeLedgerBehind`,
  `PurposeLedgerAnchorMismatch`), or a started destruction this server cannot
  settle (`PurposeIntentIncomplete`). The ledger and every stored draft are
  kept as they are.
- A ledger with the same ID as the database (a restore of the database alone):
  the API re-applies the completed destructions the restored copy holds again,
  confirms them in the committed database, and opens only after that
  confirmation (`PurposeReapplyNotCommitted` or `PurposeReapplyUnconfirmed`
  keep it closed). The completions of both record formats are re-applied.
- Upgrade of a server running the CD-09-P release (1f8249a) to CD-09-C: no
  preparation command. The ledger file stays as it is; its format-1 lines are
  read with their old rules and never rewritten or converted. Every new
  destruction attempt is written in format 2 (its own operation ID, the actual
  time of each phase, the original due day, and whether a delay reason is on
  record). A format-1 started record that the P server left open is closed in
  format 1 from the database anchor when the anchor proves its deletion
  committed, and otherwise keeps the API closed (`PurposeIntentIncomplete`),
  as in CD-09-P.
- Closed on the ledger's records: a record format this build does not know,
  for example written by a later release (`PurposeLedgerFormatUnsupported`; the
  file is kept, run the release that wrote it), and a damaged record, a format-1
  record after format 2, or an attempt closed in another format or operation
  (`PurposeLedgerRecordInvalid`); a damaged header or last line
  (`PurposeLedgerHeaderInvalid`, `PurposeLedgerPartialTail`). Nothing repairs or
  truncates the file.

Every code the draft purpose unit closes with: `PurposeLedgerDirectoryRequired`,
`PurposeLedgerInsideBackup`, `PurposeLedgerInitializationRequired`,
`PurposeLedgerMissing`, `PurposeLedgerMismatch`, `PurposeLedgerBehind`,
`PurposeLedgerAnchorMismatch`, `PurposeLedgerAnchorMissing`,
`PurposeIntentIncomplete`, `PurposeReapplyNotCommitted`,
`PurposeReapplyUnconfirmed`, `PurposeAdoptionNotCommitted`,
`PurposeAdoptionInvalid`, `PurposeLedgerHeaderInvalid`,
`PurposeLedgerPartialTail`, `PurposeLedgerRecordInvalid`,
`PurposeLedgerFormatUnsupported`, `PurposeLedgerWriteFailed`, `PurposeLedgerUnreadable`, and with the
ledger mirror ([below](#retention-ledger-mirror-lost-ledger-file)) `PurposeLedgerMirrorDiverged`,
`PurposeLedgerMirrorWriteFailed`, `PurposeLedgerMirrorDirectoryRequired`,
`PurposeLedgerMirrorInsideBackup`, `PurposeLedgerMirrorInsideLedger`,
`PurposeLedgerRestoreUnrecorded`, `PurposeLedgerRestoreFailed`.

A `completed` record means the work was deleted from the operational database.
It does not say that WAL, dead tuples or a recovery-only backup copy are gone;
those copies end under their own supervision (backup generation supervision is
not part of CD-09-C).

What this covers, in short:
- Supported: a new installation; the prepared first start of a server that had
  drafts; the upgrade from the CD-09-P release above; a restore of the database
  alone beside the same ledger; a lost or damaged ledger file beside its mirror
  ([below](#retention-ledger-mirror-lost-ledger-file)).
- Refused by the product (the API stays closed, ledger and drafts kept): the
  codes above.
- Not supported (the product cannot open it or cannot tell it apart):
  - going back to the CD-09-P image after the first format-2 record (see the
    exception in [Rollback](#rollback-to-the-previous-release-n--n-1));
  - replacing the ledger with an older copy (closed as `PurposeLedgerBehind` or
    `PurposeLedgerAnchorMismatch`, or, for a copy of the database and the volume
    together from before the first start, excluded by the procedure below);
  - a whole-server copy taken before the first start (procedure below).
  No off-box ledger or copy detector exists or is added. The ledger mirror is a
  second copy on this host written with every record, not a backup and not a
  detector of older copies.

The product cannot tell a copy of the database **and** the `purpose-ledger`
volume taken together before the first start from a real first start. That
copy is excluded by procedure:

> 기존 초안이 있는 서버에 CD-09-P를 처음 올릴 때는 migration 전에 준비 명령을 한 번 실행한다. 그 뒤 첫 기동 전에 떠 둔 서버 통째 사본(DB와 `purpose-ledger` 볼륨)은 첫 기동이 끝나면 복원·기동에 쓰지 않는다(원장과 대조 불가). 보관 여부는 운영 결정으로 hold를 유지한다(2026-11-06 결정).
> 업그레이드·재기동은 배포 도구로만 하고, `purpose-ledger`·`ledger-mirror` 볼륨을 사본으로 바꾸거나 지우지 않는다.
> P 도입 전 백업을 복원해 준비 명령을 다시 실행하는 것은 그 서버에서 P 첫 기동이 아직 없었을 때만 쓰는 복구다. 첫 기동 뒤에는 쓰지 않는다.

The deployment tools here are the site Compose command above, which mounts the
volume. The `ops_deploy_*` path does not mount it: a server with draft work
started that way stays closed.

## Report retention ledger (CD-09-D)

The report retention unit destroys an approved native report whose statutory
period ended (5 years from each version's server signature, 시행규칙 제15조①) and
that no hold, reference or draft keeps. Its ledger `report-retention-ledger.jsonl`
lives in the same `purpose-ledger` volume and names only the opaque report unit
(`StudyState.reportUnit`). The study row stays with status `D` (Destroyed); its
versions, head, signatures and signing operations are deleted in one
transaction.

- First start after the D migration (new or existing server alike): the gate
  writes the ledger header under the database's anchor ID and marks the anchor
  initialized. No preparation command: no report destruction can predate the
  migration that created the anchor. Existing reports do not keep it closed.
- Restart before the first destruction: the same ledger, nothing to re-apply.
- Closed (the API does not open; ledger and reports kept): an initialized
  database without its ledger (`ReportLedgerMissing`), a ledger of another ID
  (`ReportLedgerMismatch`), a ledger shorter than the database saw or with another
  record at the anchor's position (`ReportLedgerBehind`,
  `ReportLedgerAnchorMismatch`), a started destruction this server cannot settle
  (`ReportIntentIncomplete`), a re-application not confirmed
  (`ReportReapplyNotCommitted`, `ReportReapplyUnconfirmed`), and the ledger file
  codes of the draft purpose unit with the `ReportLedger` prefix.
- A database restored alone beside the same ledger: the gate re-applies every
  completed destruction the copy holds again and opens only after it is
  confirmed. After the restore, check the log line
  `[KIN API] Retention report-retention: N re-applied`, then run the dedicated
  sweep once, with the stack's own `compose`:

  ```python
  swept = ops.run(compose + ['run', '--rm', '--no-deps', 'api',
                             'node', 'dist/emr-retention/report-retention-sweep.js'], check=False)
  print(swept.returncode, swept.stdout.decode())
  ```

  One JSON line; exit 0 only when every report was destroyed, re-applied, absent,
  not yet due or held. `unconfirmed` (a version without the server signature, a
  report that is not approved, a signature envelope that does not verify under
  its retained key, signs another version, or disagrees with its row's summary),
  `deferred` (a writer held the study or one of its signature rows),
  `commit-unknown` and `refused` are exit 1. An attempt whose
  answer was lost is read back by its operation ID:
  `... report-retention-sweep.js --operation <operationId>`.

Only a backup taken **after the first start of the D migration** can be matched
with the report ledger. A backup from before the migration has no report unit;
migrated again it gets new units and a new anchor ID, so beside the real ledger
it stays closed (`ReportLedgerMismatch`), and without it nothing could re-apply
the destructions it missed. Such a backup is not deleted: it stays on hold, like B
in [Rollback](#rollback-to-the-previous-release-n--n-1) step 2 and the sets of
[After the window](#after-the-window), until a separate retention decision. It is
never restored or started:

> CD-09-D migration 이전에 뜬 DB 백업은 판독 보존 원장과 대조할 수 없으므로 복원·기동에 쓰지 않는다. 그 백업은 폐기하지 않고 보관(hold)을 유지하며(2026-11-06 결정), 보관 종료는 별도 보존 결정으로 정한다(롤백 2단계 B·After the window의 hold 유지와 같다).
> D 첫 기동 이후 백업만 같은 `purpose-ledger` 볼륨 옆에 복원하고, 기동 로그의 재적용 건수와 전용 sweep 결과를 확인한다.

A `completed` report record means the report was deleted from the operational
database. WAL, dead tuples and recovery-only backup copies are not shown gone by
it: the permanent end of those copies (개인정보 보호법 제21조②, 시행령 제16조①1) is
not completed by this unit and stays with the backup procedure above. Reports
another law requires to be kept after their period (제21조① 단서·③) cannot be
identified by the product (no input names them): their separate storage and
management is not provided by this unit; a legal hold keeps such a report whole
in place.

## Retention ledger mirror (lost ledger file)

Both retention ledgers (`purpose-ledger.jsonl` and `report-retention-ledger.jsonl`
in the `purpose-ledger` volume) have a mirror: the same file names in
`KIN_LEDGER_MIRROR_DIR`. `docker-compose.prod.yml` sets it to
`/var/lib/kin-ledger-mirror` on its own `ledger-mirror` volume on the same host;
the base `docker-compose.yml` leaves it empty (one copy). Another location (an
off-host volume) is a separate decision. The mirror is not a backup: no backup
set contains it (`tests/emr/retention/ledger_location_test.py`) and nothing
restores it from one.

- Every record is written to the ledger file and then to the mirror, the same
  bytes, each fsynced; a record counts only when both took it. A mirror that
  cannot take one fails that destruction like any failed record
  (`PurposeLedgerMirrorWriteFailed`, `ReportLedgerMirrorWriteFailed` in the log;
  the sweep reports the unit). The same holds for the ledger header: a first
  draft save or first start whose header the mirror refused does not bind the
  database to the ledger, and neither does a retry or a later start while the
  mirror (or the ledger file) still cannot be written and fsynced. Bytes whose
  fsync failed read back like good ones, so a retry never counts on what a
  failed write left: it writes that place again whole and counts it only when
  that fsync succeeded. The mirror is behind the ledger file only by what a
  write that failed left in the file; the next record, binding or start copies
  that over from the ledger file.
- Every start writes each ledger file and its mirror again whole, the same
  bytes (a temporary file, fsync, rename, the directory), before the gate reads
  on: a ledger or mirror directory the API cannot write keeps it closed
  (`...LedgerWriteFailed`, `...LedgerMirrorWriteFailed`). With the mirror newly
  set beside an existing ledger, that is how the mirror gets its copy. Nothing
  else changes.
- A mirror that is neither the ledger file's bytes nor a prefix of them (longer,
  or other bytes) keeps the API closed (`PurposeLedgerMirrorDiverged`,
  `ReportLedgerMirrorDiverged`): one of the two is not this server's ledger and
  the product cannot tell which. Keep both files as they are; do not copy one
  over the other. Resolving it is a separate decision.
- The setting is refused when it is relative (`...LedgerMirrorDirectoryRequired`),
  inside the backed-up EMR state (`...LedgerMirrorInsideBackup`) or the same as,
  inside or around the ledger directory (`...LedgerMirrorInsideLedger`).
- The draft purpose adoption record is not mirrored: it is read only while no
  ledger exists, and a mirror holds one.

**A lost or damaged ledger file.** The API stays closed (for example
`ReportLedgerMissing`, `PurposeLedgerPartialTail`) only until its next start
reads the mirror. Start it with the stack's own `compose` (as in upgrade step 1);
a lost `purpose-ledger` volume is recreated empty by the same command:

```python
ops.run(compose + ['up', '-d', 'api'], timeout=install_timeout)
print(ops.text(compose + ['logs', '--no-color', 'api'])[-4000:])
```

The gate reads the mirror in the ledger file's place and matches it with this
database exactly as it would the file: the same ledger ID as the database's
anchor, the anchor's record at its position, at least as long as the database
saw, every started attempt settled, and every completed destruction the
database still holds re-applied and confirmed. Only when all of that passed is
the restore written to the audit log, and only after that row is written does
the mirror's copy take the ledger file's place. The log line then ends with
`ledger file restored from the mirror (<the file's code>)`, for example
`[KIN API] Retention report-retention: 0 re-applied; ledger file restored from the mirror (ReportLedgerMissing)`.
A damaged file is kept beside it as `<file>.unreadable-<time>`.

The audit row (`AuditLog`, action `retention.ledger-restore`, actor
`kin.retention`, target the ledger ID) names the unit, the reason, the file, the
mirror, where a damaged file is kept, and the record count, length and sha256
of the bytes that take the file's place. It is not shown in the admin audit
console; read it from the database:

```sql
SELECT at, target, detail FROM "AuditLog" WHERE action = 'retention.ledger-restore' ORDER BY id;
```

A row that cannot be written keeps the API closed and restores nothing
(`...LedgerRestoreUnrecorded`). A replacement that fails after its row
(`...LedgerRestoreFailed`) keeps the API closed, and the startup failure in its
log (`[KIN API] Startup failed.`, the code followed by `{...}`) says what the
API then found: `file` present or absent, `reads` (`yes` or the file's code),
its `ledgerId`, `entries` and `bytes`, `matched` (the file holds exactly the
bytes the gate matched with this database) and `kept` (the damaged file is at
its kept name). The file can still be lost or damaged, or already hold the
mirror's bytes when only the last directory sync failed; a stop at that point
leaves the same states without the line. At the next start a file still lost
or damaged is restored again under another row; a file that reads is read like
any ledger file and nothing more is recorded. Compare the file's length and
sha256 with the last row's to tell whether it holds the restored bytes.

If any check fails the API stays closed with that check's code and the ledger
file is not created: a mirror of another database (`...LedgerMismatch`), shorter
than the database saw (`...LedgerBehind`, `...LedgerAnchorMismatch`), a
re-application not confirmed (`...ReapplyNotCommitted`, `...ReapplyUnconfirmed`),
or a mirror that does not read either (the file's own code, `...LedgerMissing`
for a lost file). Then the procedure of the code above applies, as without a
mirror. With both the ledger volume and the `ledger-mirror` volume lost there is
no recovery in the product.

> 원장 파일이 없어지거나 손상되면 배포 도구로 API를 다시 기동한다. 기동 gate가 `ledger-mirror` 볼륨의 사본을 이 DB의 anchor와 대조하고 완료된 파기를 재적용·확인한 뒤에만 감사 로그(`retention.ledger-restore`)에 먼저 기록하고 원장 자리에 되살리며, 기동 로그에도 그 사실이 남는다.
> 되살리지 못하면 API는 닫힌 채로 둔다. 원장이나 사본을 손으로 복사·편집하지 않고, 원장이나 사본에 맞추려고 옛 DB 백업을 함께 복원하지 않는다(완료된 파기가 되살아난다).
# Rollback to the previous release (N → N-1)

This procedure covers a plain Compose installation whose previous and candidate revisions use the same
retention-ledger format. Use the release's reviewed host-side operator tool. That tool, the host inventory,
credentials and execution evidence are distributed privately; they do not belong in this repository.
The historical one-time upgrade below is not the entry point for a current release.

Browsers need nothing after a release or a rollback: no cache clearing, no forced reload. The proxy lets a
browser keep only viewer files whose name carries their content hash (`/ohif/*.<20 hex>.js`, `*.<20 hex>.wasm`);
the viewer page, `app-config.js` and every other fixed-name file under `/ohif/` are asked for again on each use
(`no-cache`), and the worklist and reading screens (`/worklist/`), images, metadata and API answers keep the
policy their service answers with (images and metadata are `no-store`). The first viewer window after the switch therefore reads the new page and configuration,
which name the new bundles. A test server with a self-signed certificate keeps nothing at all: Chrome does not
cache answers received with a certificate error.

## What to remove from older procedures

Do not judge destruction state while the application is serving, compare two moving fingerprints, infer
quiescence from two equal samples, or infer a moved host job from its filename. Do not restart the full
stack after the final judgement. Do not change the application's destruction retries or recovery code.
Do not try to hold the whole host still: no host-wide enumeration that must equal a declaration, no start
block on every unit, no refusal because a unit or file that does not touch the judgement's inputs changed.
Do not take a state for the procedure's own because it equals the wanted one, and do not use a judgement
that was taken earlier - by an earlier command, or before the protection ended - for a later decision.

## Inputs and read-only preparation

Record the full candidate SHA, the prior SHA, the approved release ref, the reviewed commits that exist
only on the prior release line, the image archive and its digest. The prior release need not be an ancestor
of the candidate: compare the actual old-only commits against the reviewed set. Read the running Compose
project, files, outside-file digests, secret-file paths and daemon from container labels/mounts. Render the
same command in a clean environment and require its configuration hashes to match.

Read all applied migrations and their checksums from PostgreSQL and compare them with the candidate tree.
New migrations must append; a fixed migration count is not a compatibility check. Require the relevant
ledger reader/decoder code to match the release pair. Validate disk capacity and the archive digest.

Read the existing realm through Admin REST. Run the candidate's `check_login_flows` against its current
browser and reset-credentials flow bindings (Keycloak's built-in `browser` and `reset credentials`: no account
is required to have OTP). Bind them back using [the existing-installation instructions](../../keycloak/README.md)
inside the maintenance window, then read them back. Include
realm/client/SMTP display names and all three administrative-event retention values. Import JSON and
container recreation do not update an existing realm. Record the actual values, without credentials.

The `prep` stage is read-only. It does not certify a live ledger as safe for rollback. It does preview
what would refuse the maintenance interval after the entry closed (something the host declaration names
that is not there or cannot be suspended or moved, the marks of a retained maintenance boundary, a database
scheduler, an undeclared process or health check in the database container, an undeclared container that
reaches the ledgers, ledger storage the lock was not verified on, a paused site container, a site that
does not answer on its own ports, a candidate whose Compose file does not carry the recreation label), so
that a window that is going to be refused is refused before it costs a closed entry.

### Security updates

Before the window, read the latest `Dependency audit` run (Actions; weekly on `main`, or run it by hand). It counts
only if it is at most 8 days old and ran on the candidate SHA, or on a commit whose dependency files equal the
candidate's (`git diff --quiet <run-sha> <candidate> -- '*package-lock.json' '*requirements*.txt' '*Dockerfile*'
'*compose*.yml' worklist-v0/legal/licenses/components.json scripts/build-sof3-wasm.py` exits 0); otherwise run it
by hand on the candidate's ref first. An incomplete run (exit 2, "Not checked") is not a check: run it again. For
every line under "Needs action", the private release record names the update this release carries or why the
release goes out without it; do the same for the components under "Not seen by the scanners", against their
vendors' advisories. The run builds the product images with `--pull` on a runner without a build cache; build the
release images with `--pull --no-cache`, so a cached package-install layer cannot keep packages older than what was
checked. The images the stack runs by name (Orthanc, PostgreSQL, Keycloak) are checked as their registry serves
them on the run's day: compare each digest in the run's "Image" column with the image the running container uses,
`docker image inspect --format '{{index .RepoDigests 0}}' "$(docker inspect --format '{{.Image}}' <container>)"`,
and record a difference - a newer local copy of the tag does not change a container that is still running the old
one.

Then read the host's pending operating-system security updates, installing nothing:

```sh
sudo apt-get update      # a failed refresh means "not checked", not "nothing pending"
apt list --upgradable 2>/dev/null | grep -- '-security'
```

Record the list in the private release record. Install host updates only in a maintenance window of their own (a
kernel or Docker update restarts the stack), never between the judgement and the switch of this procedure.

### Storage encryption

Before the window, read where the site's data is stored, changing nothing. Run it in the site's checkout, as the
account that runs the nightly backup and with that job's environment (the nightly job clears it), naming the
directory the nightly job writes to:

```sh
env -i PATH="$PATH" HOME="$HOME" python3 scripts/ops_deploy_preflight.py --storage-only --backup-root <backup-directory>
```

One line names every writable data location of the database, Orthanc and the API (the database files, the EMR
tablespace, the image store, the EMR state, the retention ledgers and their mirror) and the backup root: `encrypted`
when every block device under it reaches a dm-crypt (LUKS) layer, `not-detected` when one does not, `unknown` when
this host cannot see it that way (a cloud provider's volume encryption, a network or ZFS file system, a missing path).
It also judges the backup's destination and encryption key with the nightly backup's own admission: `configured`
means a backup into that directory gets past it (the directory is outside the checkout and, where it exists, a
private directory of this account; the configuration, the identity file and the age program are read; the identity is
outside the checkout and the backup directory; age encrypts and decrypts with it); `absent` means there is no
configuration file; `invalid` means the backup would refuse; `unknown` means this run cannot speak for the backup - no
`--backup-root` was given, or the directory belongs to another account. The API-only preflight carries the same
report in its observation; it does not know the backup directory, so it never says `configured`. This is a report,
not a refusal: for a location that is not `encrypted`, the private release record names how it is protected instead
(for example the provider's volume encryption, with its evidence) or the separate maintenance window in which it will
be moved onto encrypted storage. Never re-partition or encrypt a disk inside this procedure. A backup key that is not
`configured` stops the nightly backup (Nightly job): settle it before the window.

### Network access

Before the window, check that access to the server is limited by network separation, firewall rules and a secure
remote-administration path. What the production Compose set (`docker-compose.yml`, `docker-compose.prod.yml`,
`docker-compose.monitor.yml`) publishes is the whole list of ports the product needs on the server:

- **Open to the outside:** TCP 80 and 443 of the site proxy (`kin-proxy`; 80 only redirects to HTTPS and answers
  certificate renewal). Nothing else of the product. The one other inbound port is the remote-administration path
  below (SSH).
- **Never outside the server:** the database (no host port), the API (no host port), Orthanc (`127.0.0.1:8042`, its DICOM
  port is not published) and Keycloak (`127.0.0.1:8080`; the proxy answers 404 for its administration console and the
  `master` realm). A base-file port (9443, 8081, 5432, 8042, 4242, 8080, 3000) on a non-loopback address means the
  production overlay was left out.
- **Remote administration:** SSH by key only (no passwords), from the administration addresses the private release
  record names. Keycloak and Orthanc are administered only through an SSH tunnel to their loopback ports. The
  product's own administration screens go through 443 (Inputs and read-only preparation).
- **Hospital Gateway host** (a separate machine, `gateway/`): its DICOM port (`GW_DICOM_PORT`, default 4243) answers only
  inside the hospital network; its local REST port stays on loopback; towards the server it needs only outbound HTTPS
  443. Remote support travels over that same outbound connection and the hospital can turn it off
  (`GW_REMOTE_SUPPORT=off`).

Then read what the host itself shows, changing nothing (no root needed):

```sh
python3 -B scripts/ops_deploy_preflight.py --network-only
```

One line lists every listening TCP and bound UDP socket (IPv4 and IPv6) and every port the local Docker publishes for a
running container, each as `loopback`, `public-web` (only the site proxy's own TCP 80->80 and 443->443) or `exposed`
(any other non-loopback address, with the container's name when Docker publishes it). The status is `web-only` when
nothing is `exposed`, `exposed` when something is, and `unknown` when the sockets or the local Docker could not be read
completely (`not read:` names which; a remote Docker context is not asked). SSH shows as `exposed`: that is expected.
For every other `exposed` endpoint the private release record names what it is and why it may stay open, or it is
closed in a maintenance window of its own. The report only shows bindings: whether an endpoint can be reached from
outside is decided by the firewalls, which the host cannot show. So the same report always ends with three operator
checks, never judged by the script, each recorded in the private release record:

- `firewall`: the cloud and host firewall rules (IPv4 and IPv6, and Docker's forwarding rules, which bypass the host
  firewall for published ports) open inbound only TCP 80, 443 and the SSH port, the SSH port only from the
  administration addresses.
- `network-separation`: from a machine outside the server, the database, Orthanc and Keycloak ports do not answer; on
  the hospital side, the Gateway's DICOM port answers only inside the hospital network.
- `remote-administration`: the SSH daemon accepts keys only (`sshd -T` shows `passwordauthentication no`), and the
  administrators with access are the ones the record names.

This is a report, not a refusal; it does not run inside the deployment or rollback stages. Never change firewall rules
inside this procedure.

### The host declaration

The host is not enumerated and nothing on it is blocked. A reviewed host declaration names only what the
procedure itself stops or rewrites:

- `suspend`: the scheduled executors that touch the site - units of the system manager or of an account's
  manager (the scheduler that runs the site's backup or monitor, a timer and the service it starts, a
  certificate-renewal unit that reloads the proxy) and containers of other stacks that reach the site
  (its ledger volumes, the database's data, the container runtime's control socket). Each with a reason.
  What starts a declared unit (its timer, path or socket) must be declared too. A declared unit is stopped
  for the interval and a declared container is paused, and each is put back in the state it was found in:
  one that was already stopped or paused is not started or unpaused.
- `moves_with_site`: the files and account crontabs that name the site directory. They are rewritten when
  the site moves to another directory (a new release, the rollback project, the way back). A scheduled-job
  file or crontab that names the site requires its scheduler to be under `suspend`; a unit file requires
  its unit to be.
- automation that reaches the host from outside (a job on another machine that runs commands here): it is
  named, and one that must not run is stated as suspended by the operator for this window, or the stage
  refuses.
- what the database container may run while it keeps running through the interval: its health check and
  its restart policy. A process in that container is the server's, the declared health check's, or the
  procedure's own lock connection; a name such as `psql` or `sh` admits nothing.

Before anything is closed the declaration is checked against the host: the host name, every declared unit
is loaded, what starts it is declared, every moved file and crontab is there and names the site directory,
no unit file that moves was changed on disk since its manager loaded it, and no running container outside
the site reaches the ledgers without being declared. A manager or a file that cannot be read is a refusal,
never "nothing there". The declaration is fixed when the interval closes; a recovery stage that is given a
different one is refused.

To find what belongs in it, look for the site directory in the cron tables and directories and in the unit
files of both managers (`grep -rl`), list the active timers, and list the running containers with their
mounts. This search is an aid for the reviewer, not a guarantee: an automation the declaration does not
name is not suspended. What protects the judgement against it is the lock on the judgement's inputs,
described next - not the declaration.

### Protecting the inputs of the judgement

A judgement is taken only while every one of its inputs is really closed to writes, and it is used only
while that still holds. Equal fingerprints before and after are an additional check; they never replace
the lock. The inputs are the two retention ledgers, each ledger's mirror copy, the adoption record (that
it is absent is an input too), and the two anchor rows in the database.

- **Files.** The lock is the immutable attribute on the real storage: first on the two ledger directories
  (no entry is created, replaced or removed), then on each file that exists (its content). Each target's
  device, inode and original attribute are written down before its first change. After locking, a write
  attempt that changes nothing is made on every target (the kernel is asked whether a write would pass,
  and a file is opened for writing without any flag that alters it), the inputs are read again, and those
  bytes are what is judged. The container that reads the ledgers for the judgement is created by the
  procedure, checked (image, read-only mounts, no network) and then started; what it read must be the
  locked inodes and bytes. A running container outside the held ones that can change the inputs - by the
  real path of a writable mount, including a parent directory, a sub-path or a symbolic link - refuses.
- **Supported storage.** A plain local volume on ext4. On every host, before the first lock, the same
  attempts are made on a synthetic file beside the ledger - append, truncate, create, replace, remove,
  rename, a descriptor opened before the lock, a writable mapping made before the lock - and the close
  fails if any of them gets through. xfs is not supported: there a descriptor or mapping opened before the
  lock still writes. A volume of another driver, a volume with mount options, or another file system is
  refused before anything is locked.
- **Database.** The access rules reject new TCP connections; that is verified by a real connection attempt
  that was admitted before and is refused now, not by the file or the reload time alone. Existing sessions
  are drained; a session that is not one of the site's (for example one over the local socket) refuses. Then
  one connection takes a `SHARE` lock on the two anchor tables inside a transaction and reads the anchors
  through that same connection; it is kept until the decision that uses the judgement. A `SHARE` lock
  stops an SQL write to those tables whichever way the writer connected. The end of that connection, of
  the operator process, or a restart of the database releases it - and the judgement is void.
- **Until when.** The protection is checked before the judgement, after it, and once more at the decision
  that uses it. Then it is released - the lock connection closed and seen to be gone, every attribute this
  interval added removed (an attribute that was there before stays) - and only afterwards do the writes
  that are intended begin: a migration, a restore, a retention start-up, the resumed writers. The entry
  stays closed across the release. If the release fails, nothing is started. After a death the attributes
  may still be set; the next command of the same record removes exactly those it added, or locks again.

Limits. An independent administrator who removes the attribute, remounts the storage or writes the
database's files directly is not stopped. Storage the lock was not verified on is refused, not assumed.
Host files the declaration does not name are neither read nor changed. A declared automation, an ordinary
new container, a normal restart of a container or of the container runtime, and a local database
connection are **not** among these limits: each is handled above.

## One maintenance interval

All writers of the target DB, ledgers and mirror are in scope: the application containers and one-offs of
the site, other Compose projects of the same release record, the declared executors of the host, DB
schedulers, and DB clients. A separate stack that cannot reach these resources remains running and is not
looked at.

1. Take the site operation lock. Check the declaration against the host again, now under the lock; a
   difference refuses before anything is closed. Before the first change, write down what is there and
   whose interval this is: each container with its state and its start, the activity of each declared
   unit, the bytes, mode and owner of every file and the bytes of every crontab that moves with the site,
   what each manager has loaded, the database's access rules, the commit and `.env` and custody
   configuration the live site is made of, the release record and the attempt. That first state is never
   written again. Then close the proxy (the first change) and block external/debug-port ingress. Stop the
   declared executors: what starts others first, then the schedulers and services; wait for jobs a
   scheduler had already started - a job that does not finish in time refuses, it is not killed. Pause
   the declared containers. Read the declared executors again as suspended: a stop command that succeeded
   is not enough, and what cannot be read is not counted as suspended.

   Every reversible change of the interval is one target - one container's state, one unit's activity,
   one packet-filter rule, the database's access rules, one file, one crontab, one manager's load, one
   attribute of one inode - and goes one way: read the actual value; it must be a value of this
   interval's own change to that target - the preserved original while nothing was changed; while a change
   is not yet confirmed, where it started, where it goes and what it passes through; afterwards only where
   it went. That holds also when the value equals the wanted one: a value somebody else made is refused
   even if it is the goal. Then, if it is the wanted value, nothing is done; otherwise the change is
   recorded, made, read again and confirmed. A container that started again (the same ID, another start)
   is a new generation: it is written down as that, and whatever was paused or judged on the earlier one
   is void. Records are replaced whole and the directory of the rename is synchronised, so a death or a
   power loss leaves the earlier record or the new one. A file is one target (its presence, bytes, mode
   and owner) however many units refer to it; what a manager has loaded is a separate target, brought up
   to date after its files are all in place, and a load that is behind the disk is this interval's own
   only if it changed one of that manager's unit files. An account's crontab is replaced through the
   `crontab` command. What already ran is not taken back: a migration, a retention destruction, a
   database restore, an image load or tag, a realm change.
2. Stop application writers before taking the pre-upgrade backup B. Keep PostgreSQL running for local
   reads/backups, reject new writer connections and drain existing work. An `idle in transaction` backend
   is unfinished. Refuse a DB scheduler that this procedure cannot hold. Protect the inputs and judge:
   both ledgers, their mirrors, the adoption record and both anchors.
3. Take B, rehearse its restore, hold the set and preserve the exact running image IDs under hold tags.
   Include the migration image. Confirm B's manifest has `resumed_services: []`: calling
   `ops_backup.py` with writers already stopped prevents its finally block from restarting them.
4. Load the candidate archive; verify image revision labels. The load moves the project's image names to the
   candidate's images: its intent and what those names were before are recorded first, and it is not taken
   back - the previous release's images stay under their hold tags, and the running containers are not
   affected (they run by image ID; do not recreate them from the previous directory in between). **Prepare the candidate beside the live
   site**: a checkout of its own in a directory that does not exist yet, with a copy of the environment
   file that names the candidate. The live checkout and its `.env` are not written. The place is recorded
   before it is made; nothing the site runs from refers to it until the switch. In the candidate's
   rendered configuration both services that read mounted files must carry the recreation label with the
   candidate's value. A preparation that did not finish is never continued: the reopening removes it, and
   a new window prepares again from nothing.

   Then the decision that uses the first judgement is taken: release the protection, restore the
   database's access rules, flush what was prepared to disk, and write the **switch intent** durably. Only after that record exists is the
   first container created from the prepared directory. From the switch intent on, the preparation is in
   use, the reopening refuses, and the way on after a failure is the rollback - also when the process died
   before its first change, or half-way through creating containers.

   Create the new containers while the proxy stays stopped and check on the containers themselves that
   every named volume the previous release's services had is attached again at the same place (an
   anonymous volume that was left behind proves nothing). Start the application dependencies and API. Wait
   for listening and the current start's retention recovery. Run both retention sweeps to completion.
   Perform the candidate's first backup/rehearsal now with the candidate's own tool, again with the
   writers stopped first. Start the same containers again afterwards; that start precedes step 5.

   One rule covers every stop of a writer in the interval, not only this backup: a container that will be
   started again is stopped only after it finished starting (the API answers, the sign-in server serves
   the realm, the image server answers), and a start-up that cannot be confirmed stops nothing. The
   sign-in server writes its application image during the first start of a newly created container, and
   one stopped in the middle of that start does not start again. A container the stage is going to remove
   is stopped without waiting for it to become healthy; if its start-up was not confirmed at that moment
   it is never started again. What is removed is the container, never a volume.
5. After the last start, wait until every writer finished starting, then pause every target writer
   container. A container that is paused and was not paused by this interval refuses. Block new DB
   connections, wait for outstanding queries and transactions to end. Record each paused container's ID,
   start time and restart count. Protect the inputs and judge the destruction state once at this boundary.
6. On acceptance - still protected - release the protection and see that it is gone, restore the
   database's access rules and see a connection admitted again, read the inputs once more (the files and
   the anchor rows are what was judged), and only then unpause those same IDs. Require their start times
   and restart counts to remain unchanged. If a judged container, or the judged database, started again,
   that pause and that judgement are void: keep the entry closed and take start-up, pause, protection and
   judgement again on what runs now; after repeated restarts, refuse.
   Start only the already-created proxy container itself (`docker start <its ID>`). `docker compose start
   proxy` also starts the finished one-shot dependencies again. Do not run a full `up -d`, recreate a
   container or perform another backup between the last judgement and opening the entry, and compare the
   container events of the whole project over that interval: the proxy's start is the only one.
7. Verify HTTPS, the actual served worklist/viewer files and sign-in theme, image labels, migrations,
   signing-key access and the realm issuer, that the new API's log carries no startup line naming
   `KIN_PRELOAD_DISK_GB` (installation step 3), and that both file-reading services were created from the
   candidate's directory after the switch began. Only after these checks: write what the declaration says
   moves with the site, file by file, load the managers, and let the declared executors go again, the
   schedulers first and, in a later request, what starts others (a timer that catches up on a missed run
   fires then). **The interval ends in this order: the interval's own completion record (written only when
   every target is read at its opened value, no input is locked and no lock connection is left), the final
   release record, and the release of the site lock - read back from the lock file. Success is said only
   after all three.** If one of them fails after the interval's completion record was written, the host is
   open and is not closed again: the stage fails and reports the entry as measured, the status the record
   on disk holds and whether the lock file is still there. If anything fails before that, ask for the
   closed state again - the entry, the declared executors, the ingress rules, each on its own - and record
   what is then measured on the host: never an assumed "closed" or "suspended", nothing about a host that
   could not be measured, and which inputs are still locked.

The file bind mounts for viewer configuration and the realm/theme deserve explicit verification.
`kin.release` labels on Orthanc and Keycloak cause recreation when the revision changes; the word being
somewhere in the Compose file is not that. Read the label from each rendered service before the switch and
from each container afterwards, together with when it was created, and read the actual mounted/served
bytes as well. The served viewer configuration must contain the release's own file byte for byte. Running
containers and HTTP 200 alone do not establish the delivered version.

The host maintenance lock coordinates the authorized operator. It is not an OS sandbox against another
administrator running arbitrary commands. There must be one operator for the target resources throughout
the interval.

## Destruction judgement and failure states

This rollback covers closed draft-purpose destructions only. Reject any report-retention ledger entry
(started, completed or failed), any open attempt in either ledger, an anchor ahead of its ledger, an
anchor naming another ledger/completion, a missing/damaged/unreadable ledger or mirror, unequal copies,
and an invalid/unconsumed adoption record. Use the existing read-only ledger reader and decoder.
Do not call recovery/gate methods to obtain the judgement: they may repair, replay or append.

A failed query, a failed lock or unreadable input must preserve its cause and become
`DestructionRefused`. Do not substitute an empty list or zero count.

- Read-only preflight failure: `NOT_STARTED`; service has not been stopped.
- Refusal after entry closure but before the switch intent: `NOT_STARTED` (or a recorded rollback
  refusal), with entry closed, the lock retained, and all source data preserved.
- Failure/refusal after the switch intent: `NEEDS_ATTENTION`, entry closed, lock and all data retained.
  No automatic restart or automatic back-to-N bypass.
- Something the declaration names that is not there, or a read that fails: refused before the entry is
  closed. The same found while the interval is closed: incomplete operation; never `ROLLED_BACK`.
- Every recovery stage (reopening, rollback after a failed upgrade, return to N) holds the lock from its
  first moment and keeps it through any failure, also one before it changed anything.
- "Entry closed" and "scheduled work suspended" in a failure's row and record are what the failure handling
  measured on the host after it asked for the closed state again. Where one of them is false the row names
  what is open or runs; where nothing could be measured it says so.
- An operator process that died leaves a record without an end state. The interval's own file is intact and
  holds the first state and every recorded change, so the same record continues: before the switch intent,
  the reopening below; after it, the rollback or the return to N.

An operator must inspect the ended command, any outstanding child commands, container state and retained
lock token before manually releasing a stale lock for recovery; the retained lock lies in the checkout the
failed stage ran in. The retained token alone does not prove that its owner finished. Preserve the refused
attempt and reason. Never delete or invent ledger records.

There is one maintenance boundary per closed interval, and it belongs to one release record and one
attempt. A later stage continues that boundary only with that same record and attempt, checked before the
stage changes anything: a copy of the record, or another attempt's record, is refused. No stage captures
the host a second time, and a new operation is refused before it closes anything while the ingress rules
or the database fence of a retained interval are in place. How far the earlier stage got is not a word in
a file: the stage that continues reads the host and admits only values of the interval's own changes.

After a refusal, a failure or a death before the switch intent, the operator may put the same release back
in service - also when the close itself never completed. "Before any switch" is two things, both required:
the interval wrote no switch intent, and the site is measured to be what it was when the interval closed -
the checkout's commit, the bytes of `.env` and of the custody configuration, the same containers made from
the same directory and Compose files. A status alone, or `.env` alone, opens nothing. The containers the
interval found are put back in the state it found them in (the same containers: no creation, no
recreation; a finished one-shot job is not run again; a container that was stopped before its start-up
was confirmed is not reused), the inputs are unlocked, the database's access rules are as they were; what
the refused stage had prepared beside the site is removed; wait until the writers finished starting, then
the proxy, the readiness checks, and only then the declared executors, as in step 7. After a failure the
same step is run again once the operator has inspected and released the lock by hand. This is a deliberate
step after inspection, never an automatic reaction to a refusal, and it does not apply after a switch
intent.

## Restore B into a separate rollback project R

The running N checkout and volumes stay preserved. B supplies PostgreSQL, Orthanc and EMR-state data to
an unused R project. The two retention-ledger volumes are shared current history, deliberately outside
the backup. Do not restore, truncate or replace them with B-era copies. Completed destructions after B
remain effective when either version starts.

Run the rollback inside the directory N was prepared in. N is addressed by the release record - its
project, its directory, its Compose files - not by a running API: after an upgrade that died in the middle
of its switch the containers may come from two directories, or be missing. In that case, inside the closed
interval, the missing containers are created from N's directory without a start and the database alone is
started (no application writer runs), so that N is preserved and judged exactly as a whole N is.

Before closing N's entry: validate and rehearse B and check that the ledger code of the release pair is the
same. Then close the entry, suspend and drain N as above, protect the inputs and judge N at its stopped
boundary. With the entry closed and before anything of N is switched, prepare R **in places this attempt
owns, written into the record before the first of them is made**: confirm that the R name, paths and
volumes are unused and that the prior configuration and held images are available, stage R's checkout and
signing custody, and check that B's credential/catalog inputs match the rendered R configuration. What the
switch and the way back will use is recorded once, when the preparation is whole. A failure in any of
these is a refusal with the entry closed and nothing switched; the same rollback is then run again and
removes what the unfinished preparation had made - only the recorded places, and none a container refers
to - and prepares again from nothing, or the same release is put back in service as described above. The
candidate's containers are going to be removed, so they are stopped without waiting for their start-up.
What the declaration says moves with the site is preserved as it reads for N's directory. Take a held N
preservation backup with no service resumption. Never have N and R write the shared ledgers concurrently.

Before N goes down, the release record holds what of N is preserved - its containers, its named volumes
and binds as they are attached, its images, its checkout, which database is N's (the cluster's own
identifier and its data volume) - and what R is to become. Then the protection is released, the switch
intent is written, and every step of the switch writes its intent before it runs and its completion after.
A rollback that wrote its switch intent is not run a second time: the way on is the return to N.

Create R's checkout from the exact prior SHA, restore B's environment/signing custody in private paths,
and render a separate overlay marking both ledger volumes external with their captured names. Record
that overlay separately from N's outside-file digests. Verify the actual R API mounts match those names.
Restore the database roles, memberships, ACLs, tablespaces, schemas and data through `ops_backup`'s restore
contracts; do not reduce this to row counts or replay an unreviewed role dump. Compare restored migration
checksums, catalog/counts and the anchor ledger identities. Record which database is R's. Restore Orthanc
and EMR state into R's own volumes and check SQLite integrity. Use B's held images when building on the
host is not allowed.

Start R's API with the proxy closed. Its current start must recover beside the preserved ledgers, replay
completed draft destructions and complete both sweeps and the restored EMR expiry operation. The custody
configuration is switched as one file change of the interval (what was there is preserved first). Perform
R's first backup/rehearsal and all restarts before the final pause/judgement.

After acceptance, resume the same containers and start the prepared proxy. For what the declaration says
moves with the site, the expected bytes are **the preserved originals with the site directory they name
replaced by R's path**, written file by file. The declared executors are let go only after the readiness
and signing checks. Only those checks and the completed interval permit `ROLLED_BACK`.

## Return from R to N

Back-to-N is a recovery attempt, not an unconditional escape from a rejected destruction state. Its first
condition is that it continues its own record's interval (the same record, the same attempt) and that the
preserved N is whole: N's volumes, the ledger volumes and the checkout at N.

**Every call looks at both N and R as they are and judges anew.** Nothing an earlier call judged is used
again - also not when that call took R down and then failed, and not after a restart of the container
runtime or the host. What a judgement beside R needs is therefore never removed by this step: R's
containers go down, R's database volume, checkout and configuration stay until N serves again (the
operator removes them afterwards).

The same step also recovers a rollback that failed after N went down, including one that failed before
R's API existed; there is no separate command for that. Whether R's application ever ran is read from the
record's step intents and from the containers that exist, not from R's API being present:

- R never ran - its start was never intended on the record and none of its application containers was ever
  started: nothing of R is fenced, drained or judged. N's own judgement below is not skipped.
- R ran: stop the writers of both N and R, then judge the ledgers beside R's database with the entry
  closed, using a ledger reader image fixed before the switch. If R's containers are gone, start **only
  R's database** from its kept volume and configuration (what is left of N's containers goes first,
  without `-v`); no application of R runs. The database must be the one this rollback restored: the same
  cluster identifier on the same data volume - a database of the same name on another cluster or volume
  is refused. If R's database volume is gone, refuse before anything is touched. A stored anchor value is
  no substitute for the database.

Release that protection, write the switch intent, stop R without `-v`. Put N's custody configuration back
as one file change and create and start N while its proxy stays closed. N's containers are always created
anew for this: whatever is left of them is removed first, without `-v`. Check on the new containers that
every named volume and bind N had is attached again at the same place and that N's database is the one N
had. Read this start's recovery, complete sweeps, pause writers, drain DB transactions, protect the inputs
and judge again - so what N itself wrote in an earlier, failed return is judged beside N's database. A
completed destruction on R must remain absent on N; an unfinished attempt may refuse in both directions.

Resume the identical judged containers and start only N's prepared proxy. Check HTTPS/signing. Then put
what moves with the site back to the **bytes recorded for N's directory**, not a guessed inverse
substitution of R's current contents, and let the declared executors go again. Only then record
`ROLLBACK_ABANDONED`. Failure leaves `NEEDS_ATTENTION` with entry closed; the same step is run again.

Never run `down -v`, volume prune, or remove either ledger volume. A volume still bearing N's project
name can be in use by R. Keep B, N preservation sets, held images, the R overlay and R's volumes through
the rollback window; release their holds only through the approved retention procedure.

## Rehearse and deliver the exact release

Run the host procedure end to end on synthetic data in an isolated rehearsal environment: prior install
→ candidate → R → N → R → candidate. Verify prior rows/files, current and expired sessions, administrator
sign-in by password only, an account's own OTP, password reset, viewer pixels/configuration, drafts/final reports/drawings and signing.
Exercise at least one identifiable completed draft destruction in each direction and verify that exact
content's absence after replay, including drawings and ended-work payloads.

Also exercise refusal of each unsupported destruction state and query failure; an omitted executor; a
writer that tries to change a locked input (a file, an anchor row); no B-time service resume; closed entry
and retained lock on a post-start refusal; a death in the middle of a preparation and in the middle of a
switch, each continued by the command given for it; and unchanged container IDs/start times from final
judgement to entry opening.
Place fault injection in the rehearsal harness, not the deployed operator tool. Judge only the evidence
from that execution directory. Missing, skipped or failed evidence does not pass.

Re-run on the eventual committed release SHA. Preserve commands, exits, original logs, selected revision
and timings in the private execution manifest. An uncommitted procedure rehearsal is development evidence,
not the final SHA's CI or independent review. Actual host DNS/certificates, external mail delivery,
real device/OTP interaction and host-specific inventories still require the approved deployment checks.


# One-time upgrade of the a86ecf1 host

Used once, for the production host as observed on 2026-10-31: a86ecf1 started on
10-15 by the protected entry (`kin-api`'s `config_files` label names root-only
copies under `/var/lib/kin-deploy/compose-entries/<generation>/` plus a
`runtime.yml` with image pins), the Halo overlay
`/etc/kin-deploy/overlays/docker-compose.halo-reports.yml`, and the nightly job
`~/.local/bin/kin-pacs-reviewed-backup`. After it the host runs N in the plain
form, and the sections above apply from N onward.

**Each side uses its own version's tools.** a86ecf1's checkout has no backup
tool that knows its own ledger and no restore command; the main tools do not
know a86ecf1's (no `/app/dist/emr-runtime/application` in its API image, no
`restore_expiry_sweep` in its database). So:
- Up to and including B, and the whole rollback, use the helper production runs
  every night: c7ef074's `ops_backup.py` and `ops_audit_integrity.py`, stored in
  `.git/` and pinned by the nightly wrapper. They import with `ROOT` = the site
  checkout (`Path(__file__).parents[1]`), and the bytes do not change when the
  checkout moves between a86ecf1 and N. Its `backup()` is exactly what the
  nightly CLI runs (`--ready-timeout 240 --no-rotate`), and its daily-set
  `rehearse()` and `restore_snapshot(..., 'post')` restore a role-catalog set into
  a fresh product cluster.
- Compose runs the files of the checked-out version, through `compose_for`.
- N's `scripts/ops_backup.py` runs only against N: its first backup and
  rehearsal (U5), the nightly job from U6 on, and N's set before a rollback (R1).
- Nothing is built on the host. N's images are loaded; a86ecf1's are the
  running images, kept by tag. Every `up` passes `--no-build --pull never`, so a
  missing image stops Compose instead of building or pulling one.

The c7ef074 CLI and N's CLI take the operations lock themselves (`.kin-ops.lock`
in the checkout). An operator session therefore holds the lock only around its
own steps, and a CLI runs only while the session does not hold it.

## Before the window (no change to the running stack)

1. **Fetch and verify N.** The host's repository lacks N (it lacks even
   9bdbb7d), and loaded images bring no Git objects:

   ```bash
   git -C /home/ubuntu/pacs-starter-kit fetch origin main
   git -C /home/ubuntu/pacs-starter-kit cat-file -t <N full SHA>          # commit
   git -C /home/ubuntu/pacs-starter-kit rev-parse --verify '<N full SHA>^{commit}'
   git -C /home/ubuntu/pacs-starter-kit merge-base --is-ancestor <N full SHA> origin/main && echo on-main
   ```

   The full SHA must equal the approved release record's N and be on main. A
   fetch writes only `.git` objects and refs; HEAD stays a86ecf1.
2. **Build N's images on another host**, never on this one (2 vCPU, no swap,
   shared with Halo and the studio). Use a checkout at N in a directory named
   `pacs-starter-kit`, so the images get the site's project names, and a `.env`
   with `KIN_REVISION=<N full SHA>` plus throwaway values for the `:?`
   variables (no site credential leaves the site):

   ```bash
   docker compose -p pacs-starter-kit -f docker-compose.yml -f docker-compose.prod.yml build api api-migrate proxy
   docker save -o kin-n-images.tar pacs-starter-kit-api pacs-starter-kit-api-migrate pacs-starter-kit-proxy
   sha256sum kin-n-images.tar
   ```

   Copy the file to the host outside the checkout and the backup root, and
   compare its sha256 there.
3. **Check the nightly helper and the space.**
   `~/.local/bin/kin-pacs-reviewed-backup --check` must print
   `pins ok c7ef074`. The newest daily set must be `complete: true`. Free space:
   at least two daily sets (B and N's set) plus the image file and the loaded
   images, about 3 GB on 2026-10-31.
4. Schedule the window so that it does not cover the nightly job's 20:00 UTC
   start. During a locked step the job fails on the lock (`O_EXCL`) and writes
   nothing.

## In the window

**Session.** One `python3 -B -E -s` session in `/home/ubuntu/pacs-starter-kit`
(HEAD a86ecf1) as `ubuntu`, the account that owns the backup root:

```python
import hashlib, json, os, socket, sys, time
from pathlib import Path
PINS = {'ops_backup.py': '473c2acc78089aeae43cad8b52e0fc47f21eada1f2238b6267ac3b6fe79c8dbe',
        'ops_audit_integrity.py': '0ec3984285f82e02ada1bfd9ccdec0c78e87abf818ac8a3bb34dd02e486c029f'}
assert all(hashlib.sha256((Path('.git') / name).read_bytes()).hexdigest() == sha for name, sha in PINS.items())
sys.path.insert(0, str(Path('.git').resolve()))
import ops_backup as ops          # the nightly job's c7ef074 helper
assert ops.ROOT == Path.cwd().resolve()
hold = ops.lock()
lease = hold.__enter__()
ops.require_local_docker()
observed = {'host': socket.gethostname(), 'sha': ops.text(['git', 'rev-parse', 'HEAD']),
            'docker': ops.text(['docker', 'version']), 'compose': ops.text(['docker', 'compose', 'version'])}
```

Compare `observed` with the release record, then set `record_path` (outside
the checkout), `record`, `install_timeout = 2400`, `backup_root =
Path('/home/ubuntu/backups/kin-pacs')`, `N = '<N full SHA>'` and
`OLD = 'a86ecf1655c8c587012cef5fd16e233e121ae7dc'`. Define `clean_env`,
`compose_for` and `config_matches` from [Site Compose command](#site-compose-command),
and the readiness loop of installation step 3 as `ready()`. c7ef074's lease has
no `retain()`: keep the lock with `lease.retained = True`, release it with
`lease.retained = False` and `hold.__exit__(None, None, None)`.

- **U1. Adopt the running stack into the plain form.** About 1–2 minutes of
  outage.
  1. Add `KIN_MONITOR_PUBLIC_DIR` and `KIN_REVISION=<OLD>` to `.env`.
     `docker-compose.monitor.yml` requires the first (`:?`), and `compose_for`
     passes nothing else. Its value is in the entry's root-only
     `environment.json`, which holds the literal `.env` values, credentials
     included: read only this key (`sudo -n python3 -c` printing that one
     value) and never print the file.
  2. Name the running images as plain Compose does. The compose files give
     `api`, `api-migrate` and `proxy` no `image:`, so without the names `up`
     would build. The other services name tags; each tag must already be the
     running image, or the recreate would switch it:

     ```python
     project = ops.ROOT.name
     image = {c: ops.text(['docker', 'inspect', '--format', '{{.Image}}', c])
              for c in ('kin-api', 'kin-proxy', 'kin-db', 'kin-orthanc', 'kin-keycloak')}
     for tag, container in (('postgres:16-alpine', 'kin-db'), ('orthancteam/orthanc:24.12.0', 'kin-orthanc'),
                            ('quay.io/keycloak/keycloak:26.7.3', 'kin-keycloak')):
         assert ops.text(['docker', 'image', 'inspect', '--format', '{{.Id}}', tag]) == image[container], tag
     for service, container in (('api', 'kin-api'), ('api-migrate', 'kin-api'), ('proxy', 'kin-proxy')):
         ops.run(['docker', 'tag', image[container], f'{project}-{service}'])
     ```

     `api-migrate` is the same `production` target of `api/` as `api`.
  3. Recreate once with the plain command and the entry's own file list:

     ```python
     files = ['docker-compose.yml', 'docker-compose.prod.yml',
              '/etc/kin-deploy/overlays/docker-compose.halo-reports.yml', 'docker-compose.monitor.yml']
     outside_files = {name: ops.digest(Path(name)) for name in files if Path(name).is_absolute()}
     compose = compose_for(project, ops.ROOT, files, None)   # no custody configuration on this host
     assert not Path('/etc/kin-deploy/emr-wrapping-custody.json').exists()
     lease.retained = True
     record.update(status='ADOPTING', compose_project=project, compose_files=files, outside_files=outside_files,
                   wrapping_secret_file=None)
     ops.write_json(record_path, record)
     ops.run(compose + ['up', '-d', '--no-build', '--pull', 'never'], timeout=install_timeout)
     ready()
     assert config_matches(compose, project)
     ```

     `runtime.yml`'s pins, labels and one-shot names change every container's
     configuration hash, so all of them are recreated, `db` included; volumes
     are kept. `emr-provision` and `api-migrate` run again (no pending
     migration).

     **If any line of U1.3 fails**, bring a86ecf1 back on the entry's own
     generation files with the command that started the VM's
     production-shaped site (run 2, S6): all services from 0dc0d506…, then
     the proxy from 3284076f… (the generations on `kin-api` and `kin-proxy`
     on 2026-10-31):

     ```python
     def entry(generation, *args):
         g = Path('/var/lib/kin-deploy/compose-entries') / generation
         monitor = ops.text(['sudo', '-n', 'python3', '-c',
                             f"import json;print(json.load(open('{g}/environment.json'))['KIN_MONITOR_PUBLIC_DIR'])"])
         return (['sudo', '-n', 'env', '-i', f'PATH={os.environ["PATH"]}', 'HOME=/root', f'KIN_MONITOR_PUBLIC_DIR={monitor}',
                  'docker', 'compose', '--project-directory', str(ops.ROOT), '--project-name', project,
                  '--env-file', str(g / 'inputs.env')]
                 + [arg for i in range(4) for arg in ('-f', str(g / f'source-0{i}.yml'))] + ['-f', str(g / 'runtime.yml'), *args])
     ops.run(entry('0dc0d506cd332aad092a931629b5c0be18ca8661ac3c811fb9ad81623c0770bb', 'up', '-d'), timeout=install_timeout)
     ops.run(entry('3284076f7c7296656167a94b8cdb0890ef56bfb4a08a7bf3ebe5c08b7a9458fc', 'up', '-d', '--no-deps', 'proxy'),
             timeout=install_timeout)
     ready()
     record.update(status='ADOPTION_REVERTED')
     ops.write_json(record_path, record)
     lease.retained = False
     hold.__exit__(None, None, None)
     ```

     The window ends there with a86ecf1 as before; the two `.env` lines of
     U1.1 may stay (the entry reads `inputs.env`), and the nightly job is
     unchanged.

  From then on, never run `/opt/kin-deploy/entry.py compose recreate`: it
  would bring back the entry's recorded generation over the plain stack. Leave
  `/var/lib/kin-deploy` and `/etc/kin-deploy` as they are and record them as
  inert.
- **U2. Take B with the nightly helper, rehearse it, hold it.**

  ```python
  B = ops.backup(str(backup_root), 240)    # what the nightly CLI runs, without rotation
  ops.rehearse(B)                           # expected: "success": true, "shape": "post", catalog equal, emr verified
  b_manifest = json.loads((B / 'manifest.json').read_text(encoding='utf-8'))
  assert b_manifest['git_sha'] == OLD and b_manifest['git_dirty'] is False and b_manifest['role_catalog']
  ops.write_json(B / ops.HOLD_FILE, {'reason': 'rollback-window and original ledger representation', 'release': N})
  hold_tags = []
  for container, entry in b_manifest['running_images'].items():
      tag = f'kin-rollback-hold/{container}:{OLD[:12]}'
      ops.run(['docker', 'tag', entry['id'], tag])
      hold_tags.append(tag)
  record.update(backup_set=str(B), rollback_hold_tags=hold_tags)
  ops.write_json(record_path, record)
  ```

  B holds both databases whole (`kin` with `emr_access` and its one 10-15
  ledger event, `keycloak`), the role catalog and EMR catalog, the EMR state
  volume, the Orthanc storage, `.env`, both base compose files and the sealed
  AuditLog checkpoint. It does not hold the host files: the Halo overlay (its
  sha256 is in the record), `/etc/kin-workflow`, the certificates and the
  entry's state. B's rehearsal restores it into a fresh networkless cluster
  with the role-catalog replay and checks the EMR seal with B's own API image.
  Keep B's hold and tags after the window until a separate retention decision:
  B is the only copy of the ledger in its original (chain) representation.
- **U3. Load N's images.**

  ```python
  ops.run(['docker', 'load', '-i', '<kin-n-images.tar>'], timeout=install_timeout)
  revision = '{{index .Config.Labels "org.opencontainers.image.revision"}}'
  assert all(ops.text(['docker', 'image', 'inspect', '--format', revision, f'{project}-{service}']) == N
             for service in ('api', 'api-migrate'))   # the proxy image carries no revision label
  ```

  The load moves the three project tags to N; B's images keep their hold tags.
- **U4. Upgrade.** Set `KIN_REVISION=<N>` in `.env`, then:

  ```python
  record.update(status='STARTED', release_sha=N)
  ops.write_json(record_path, record)
  ops.run(['git', 'checkout', '--detach', N])
  assert all(ops.digest(Path(name)) == sha for name, sha in record['outside_files'].items())
  ops.run(compose + ['up', '-d', '--no-build', '--pull', 'never'], timeout=install_timeout)
  ready()
  assert ops.text(['docker', 'inspect', '--format', '{{.State.ExitCode}}', 'kin-api-migrate']) == '0'
  ```

  `api-migrate` applies N's 21 migrations to the 46 of a86ecf1. Then check:
  - `_prisma_migrations`: all 67 expected migrations applied and no
    unresolved failure,
    `SELECT count(DISTINCT migration_name) FILTER (WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL), count(*) FILTER (WHERE finished_at IS NULL AND rolled_back_at IS NULL) FROM "_prisma_migrations"`
    returns `67|0`; a rolled-back attempt that M resolved may remain as an
    extra row;
  - the 10-15 probe event moved into the new ledger: one `emr_access.access_entry`
    (stream `viewing`, act `열람`, `viewing2y`) whose payload has executor
    `service`, user `release-probe`, target `system-operation`;
  - Access Review shows it: as `kin_runtime`,
    `SELECT * FROM emr_access.review_entries('kin-center'::text, '2026-10-15T00:00:00Z'::timestamptz, '2026-10-16T00:00:00Z'::timestamptz, false, NULL::bigint, NULL::bigint, 10)`
    returns that row (the admin page reads exactly this function, for the
    caller's own institution, so only a kin-center admin sees it; on
    2026-11-01 production had none: kin-center 2 approved members, 0 admins);
  - `config_matches(compose, project)`.

  If `kin-api-migrate` exits non-zero, go to M below. Any other failure: keep
  the lock, record `NEEDS_ATTENTION`, and choose the rollback.
- **U5. N's own tools from here.** Record `status='UPGRADED'`, set
  `lease.retained = False` and release the lock. Then, as the same account:

  ```bash
  env -i PATH="$PATH" HOME="$HOME" python3 scripts/ops_backup.py backup --output /home/ubuntu/backups/kin-pacs --no-rotate
  env -i PATH="$PATH" HOME="$HOME" python3 scripts/ops_backup.py rehearse <printed set>
  ```

  This is N's first backup. Write `restore-hold.json` in it as well, and run
  checks 2 and 3 of the synthetic checks (no custody: "online approvals not
  enabled"). Enabling online approvals is a later step on the running N.
- **U6. Point the nightly job at N's tool.** The c7ef074 helper still backs up
  N (exit 0, a complete set), but neither tool can verify that set: c7ef074's
  rehearsal finds the restored EMR catalog different, and N's finds the `kin`
  row counts different, because c7ef074 counts only `public` and `emr_access`
  (VM rehearsal, 2026-11-01). Record the current crontab line in the release
  record (`nightly_old`), then replace it with N's tool, without rotation:

  ```
  0 20 * * * /usr/bin/flock -n /home/ubuntu/.kin-backup-cron.lock /usr/bin/env -i PATH=/usr/bin:/bin HOME=/home/ubuntu /usr/bin/python3 -B -E -s /home/ubuntu/pacs-starter-kit/scripts/ops_backup.py backup --output /home/ubuntu/backups/kin-pacs --ready-timeout 240 --no-rotate >> /home/ubuntu/backups/kin-pacs/scheduled.log 2>&1 # kin-pacs-n-backup
  ```

  Record the new line as `nightly_n`. The tool path names the checkout, so the
  line runs whatever version is checked out; the rollback therefore puts
  `nightly_old` back (R7) and Back to N puts `nightly_n` back.

**M. `api-migrate` failed in the window.** The failing file leaves nothing of
itself and the files before it stay applied (VM drill on B: `emr_pg_ledger`,
which opens its own transaction, failed after 48 finished rows and left none of
its tables). N's API has not started (it waits for `api-migrate`), so the doctors
still see the outage, and nothing has written to the database since B.

```python
print(ops.text(compose + ['logs', 'api-migrate']))   # which migration failed
db_log = ops.run(['docker', 'logs', 'kin-db']).stderr.decode('utf-8', 'replace')
print([line for line in db_log.splitlines() if 'ERROR:' in line][-3:])   # PostgreSQL's own error, then the aborted ones
failed = ops.text(['docker', 'exec', 'kin-db', 'psql', '-X', '-U', 'kin', '-d', 'kin', '-qAt', '-c',
                   'SELECT migration_name FROM "_prisma_migrations" WHERE finished_at IS NULL AND rolled_back_at IS NULL'])
```

Prisma prints only `current transaction is aborted` for a migration file
that opens its own transaction (as `20261023180000_emr_pg_ledger` does); the
cause is the `ERROR:` line before those in `kin-db`'s log. Read the whole log:
PostgreSQL follows that line with the failing statement, which is the whole
migration file (474 lines for `20261023180000_emr_pg_ledger`), so a
`--tail 300` showed only the aborted-transaction line on the VM.

Prisma refuses every later `migrate deploy` while that row exists (P3009). The
default is the rollback below. Go forward only when the cause is outside the
data and is corrected (an object in the way, a missing privilege), and record
the cause and the correction. Then mark the attempt rolled back and run the
migration again:

```python
ops.run(compose + ['run', '--rm', '--no-deps', 'api-migrate',
                   './node_modules/.bin/prisma', 'migrate', 'resolve', '--rolled-back', failed])
ops.run(compose + ['up', '-d', '--no-build', '--pull', 'never'], timeout=install_timeout)
```

and continue at U4's checks. `resolve` changes only that history row.

**Rollback from M** (the default). Not run on the VM.
1. Leave the failed state as it is: no `resolve`, no repair, no `down -v`.
   N's volumes are its only copy. Record `status='MIGRATION_FAILED'` and
   `failed`.
2. The lock: this session still holds it (`lease.retained = True` since
   U1.3) and keeps it through R7. If the session is gone, remove the retained
   `.kin-ops.lock` only after inspecting it, as Back to N says, and take it in
   a new session with `hold = ops.lock(); lease = hold.__enter__();
   lease.retained = True`.
3. Run the preflight below in this session (it takes no lock of its own).
   Skip its "rehearse again" (B was rehearsed in U2) and skip R1: N's tool
   cannot back up and rehearse a half-migrated database, and nothing has
   written to the database since B. A preflight failure leaves the stack
   down: keep the lock and record `NEEDS_ATTENTION`.
4. Stop N: at R2 run only `ops.run(compose_n + ['down'])` (no `-v`) and
   record `ROLLING_BACK`.
5. R3–R7 as written, restoring B. U6 has not run, so the crontab stays as
   it is. R7 releases the lock.

## Rollback to a86ecf1

Applies from U4 until N's first change that B cannot represent is accepted
(see the end of this section). R is a new Compose project in the same checkout,
switched back to a86ecf1, with new volumes restored from B and B's own images.
N's volumes are kept and N's project is only stopped. Keeping the one checkout
means certbot's webroot, the monitor and the nightly wrapper keep their paths.

**Preflight, while N serves.** A session as above (pinned import, `observed`,
the definitions), still at N, **without** the lock:

```python
B = Path(record['backup_set'])
directory, manifest = ops.validate_backup(B)              # checksums, archives, B's images present by ID
assert manifest['git_sha'] == OLD and manifest['git_dirty'] is False and manifest['role_catalog']
api = json.loads(ops.text(['docker', 'inspect', 'kin-api']))[0]
n_project = api['Config']['Labels']['com.docker.compose.project']
n_files = record['compose_files']
compose_n = compose_for(n_project, ops.ROOT, n_files, None)
assert config_matches(compose_n, n_project)
R = n_project + '-r1'                                     # unused: no container, no volume with this project
assert not ops.text(['docker', 'ps', '-aq', '--filter', f'label=com.docker.compose.project={R}'])
assert not ops.text(['docker', 'volume', 'ls', '-q', '--filter', f'label=com.docker.compose.project={R}'])
for name in ('docker-compose.yml', 'docker-compose.prod.yml'):
    assert hashlib.sha256(ops.run(['git', 'show', f'{OLD}:{name}']).stdout).hexdigest() == manifest['sha256'][name]
ops.run(['git', 'cat-file', '-e', f'{OLD}:docker-compose.monitor.yml'])
assert all(ops.digest(Path(name)) == sha for name, sha in record['outside_files'].items())
site_env = [l for l in (ops.ROOT / '.env').read_text(encoding='utf-8').splitlines() if not l.startswith('KIN_REVISION=')]
b_env = [l for l in (directory / '.env').read_text(encoding='utf-8').splitlines() if not l.startswith('KIN_REVISION=')]
assert site_env == b_env    # R runs with the credentials B's databases were made with
for tag, container in (('postgres:16-alpine', 'kin-db'), ('orthancteam/orthanc:24.12.0', 'kin-orthanc'),
                       ('quay.io/keycloak/keycloak:26.7.3', 'kin-keycloak')):
    assert ops.text(['docker', 'image', 'inspect', '--format', '{{.Id}}', tag]) == manifest['running_images'][container]['id']
assert not Path('/etc/kin-deploy/emr-wrapping-custody.json').exists()   # see the end of this section
record.update(n_project=n_project, n_files=n_files, rollback_project=R)
ops.write_json(record_path, record)
```

Then `ops.rehearse(directory)` again when B's last rehearsal is not from this
window. Any failure here: record `ROLLBACK_NOT_STARTED`; N keeps serving.

- **R1. Preserve N with N's tool**, still without the session lock:
  `env -i PATH="$PATH" HOME="$HOME" python3 scripts/ops_backup.py backup --output /home/ubuntu/backups/kin-pacs --no-rotate`,
  then its `rehearse`, then `restore-hold.json` in that set (reason
  `rolled-back release`). Record the set. Without a complete N set, stop
  (`ROLLBACK_NOT_STARTED`). When N's `kin-db` does not run, record that N's
  volumes are the only copy and continue.
- **R2. Lock, stop N.** `hold = ops.lock(); lease = hold.__enter__()`,
  `lease.retained = True`, `status='ROLLING_BACK'`, then
  `ops.run(compose_n + ['down'])` without `-v`. Record N's volumes
  (`docker volume ls --filter label=com.docker.compose.project=<n_project>`).
- **R3. Check out a86ecf1 and give R B's images.**

  ```python
  ops.run(['git', 'checkout', '--detach', OLD])
  images = manifest['running_images']
  for service, container in (('api', 'kin-api'), ('api-migrate', 'kin-api'), ('proxy', 'kin-proxy')):
      ops.run(['docker', 'tag', images[container]['id'], f'{R}-{service}'])
  compose_r = compose_for(R, ops.ROOT, record['compose_files'], None)
  ops.run(compose_r + ['config', '--quiet'])
  ops.run(compose_r + ['up', '-d', '--wait', '--no-build', '--pull', 'never', 'db'], timeout=install_timeout)
  ```

  a86ecf1's `db` creates only `kin` (no `keycloak` init script), which is the
  fresh cluster `restore_snapshot` requires.
- **R4. Restore PostgreSQL from B** (c7ef074's daily-set restore, the one its
  rehearsal uses):

  ```python
  source, outside = ops.daily_set_catalog(manifest['role_catalog'])
  print(ops.restore_snapshot('kin-db', directory, 'kin', 'post', source=source), outside)   # outside == []
  assert all(ops.counts('kin-db', db, 'kin') == manifest['counts'][db] for db in ops.PRE_DATABASES)
  assert ops.emr_catalog('kin-db', 'kin') == json.loads((directory / 'emr-catalog.json').read_text(encoding='utf-8'))
  print([row[0] for row in ops.migration_rows('kin-db')][-1])   # 20261011120000_filter_shortcuts
  ```
- **R5. Restore Orthanc and the EMR state.**
  `ops.run(compose_r + ['up', '--no-start', '--no-build', '--pull', 'never'], timeout=install_timeout)`,
  read `orthanc_volume` (`kin-orthanc` at `/var/lib/orthanc/db`) and
  `state_volume` (`kin-api` at `/var/lib/kin-emr`) from the mounts (they must be
  `<R>_orthanc-db` and `<R>_emr-state`), then extract with c7ef074's helper:

  ```python
  for volume, archive in ((orthanc_volume, 'orthanc.tgz'), (state_volume, 'emr-state.tgz')):
      ops.temporary_run(['--network', 'none', '--read-only', '--mount', f'type=volume,source={volume},target=/restore',
                         '--mount', f'type=bind,source={directory},target=/backup,readonly', '--entrypoint', 'tar',
                         manifest['postgres_image'], '-xzf', '/backup/' + archive, '-C', '/restore'], timeout=1800)
  print(ops.temporary_run(['--network', 'none', '--read-only', '--mount', f'type=volume,source={orthanc_volume},target=/restore,readonly',
                           '--entrypoint', 'python3', manifest['orthanc_image'], '-c', ops.SQLITE_CHECK], timeout=300))
  ```

  Expected: `"integrity": "ok"` with B's attachment count.
- **R6. Start R.** `ops.run(compose_r + ['up', '-d', '--no-build', '--pull', 'never', 'api'], timeout=install_timeout)`;
  `kin-emr-provision` and `kin-api-migrate` exit 0 (`No pending migrations to
  apply.`); the API answers on its own port (a86ecf1's API recovers its EMR seal
  before it listens). a86ecf1 has no restored-copy expiry sweep; there is none
  to run. Then `ops.run(compose_r + ['up', '-d', '--no-build', '--pull', 'never'], timeout=install_timeout)`.
- **R7. Verify and hand over.** `ready()`; `config_matches(compose_r, R)`;
  B's data: the `kin` row counts of B's manifest (`keycloak` may differ in
  `jgroups_ping`, Keycloak's own runtime row: 0→1 on the VM), its ledger
  event, Orthanc's instance count. Then R's first backup with R's own tool, the nightly helper:
  `R_set = ops.backup(str(backup_root), 240)`, `ops.rehearse(R_set)`. Put the
  crontab line `nightly_old` back (U6 replaced it). Record
  `status='ROLLED_BACK'`, set `lease.retained = False` and release the lock. The
  nightly wrapper, which names this checkout, now backs up R unchanged.

**Back to N** (after R7, or after a failure from R2 on): in a session holding the
lock (remove a retained `.kin-ops.lock` only after inspecting what its session
left, and record it):

```python
hold = ops.lock(); lease = hold.__enter__(); lease.retained = True   # skip if this session still holds it
compose_r = compose_for(record['rollback_project'], ops.ROOT, record['compose_files'], None)
compose_n = compose_for(record['n_project'], ops.ROOT, record['n_files'], None)
ops.run(compose_r + ['down'])                     # no -v: R's volumes stay for inspection
ops.run(['git', 'checkout', '--detach', record['release_sha']])
ops.run(compose_n + ['up', '-d', '--no-build', '--pull', 'never'], timeout=install_timeout)
ready()
assert config_matches(compose_n, record['n_project'])
```

N's checkout files, `.env` and volumes are as they were at R2, so N comes back
with everything it wrote. Put the crontab line `nightly_n` back if R7 had
restored `nightly_old`. Record `ROLLBACK_ABANDONED`, then
`lease.retained = False` and `hold.__exit__(None, None, None)`; until then
every backup refuses the lock.

**Where this rollback ends.** It restores a86ecf1 without online approvals.
Once a custody configuration is installed on N (Enabling online approvals) or
a doctor has a signing key, it no longer applies (preflight refuses on the
custody file): a86ecf1 cannot use the key, and the sections above, with N's
tools on both sides, cover later releases.

## After the window

- The nightly job runs N's tool with `--no-rotate` (U6). Rotation is a separate
  decision: N's tool keeps seven daily generations by default and would delete
  the older sets on its first rotating run; sets with `restore-hold.json` stay.
- B, its hold file and its `kin-rollback-hold/*` tags stay until a separate
  retention decision. So do N's first set and its hold.
- Remove `kin-n-images.tar` once N's images are confirmed loaded.

# Online signing keys: backup and restore

The per-doctor encrypted private keys are in `kin.emr_signing.private_key`;
`doctor_key`, `key_history` and `signed_version` retain their registration and
verification evidence. Clinical records are in `emr_clinical`, issuance fixed
copies and audit events in `emr_audit`, image preparation records in `emr_image`.
The daily `scripts/ops_backup.py backup` and its `rehearse` compare every table in
`public`, `emr_access`, `emr_signing`, `emr_clinical`, `emr_audit` and `emr_image`,
using the captured counts, not fixed totals; a restored copy missing a row fails.

Wrapping bytes stay outside PostgreSQL and its backup directory. The deployed
`FileWrappingSecrets` mapping must use the same key IDs and bytes as the custody
configuration. The C2 handoff uses ID `c2-wrap-v1` mounted at
`/run/secrets/emr-signing-wrap-v1`; a host source path must be supplied by the
installation operator. This runbook does not claim that any site is configured.

## Enabling online approvals

`emr/deploy/docker-compose.signing.yml` is that mapping for the API container. On
the host, keep one raw 32-byte file per wrapping ID (the file the custody
configuration's `files` entry for `c2-wrap-v1` names). It has two readers: the
API container user (`node`, uid 1000 in the production image) and the backup
account, whose nightly backup copies it into custody. Make it readable by those
two only: `chown 1000:<backup account's group>`, `chmod 0440`. With a backup
account of uid 1000 the owner bit already covers both. A file only uid 1000 can
read makes another backup account's backup fail with `Wrapping source file is
unavailable`. Install the custody configuration (Nightly job) first, so that the
overlay and the nightly custody copy name the same file.

At installation, step 2 adds the overlay itself. On a running stack, use one
locked operator session in the site checkout, as for steps 2–4. Address the stack
as in upgrade step 1, then merge the overlay after the stack's own files, record
the new list and file, and run check 3:

```python
secret_file = json.loads(ops.WRAPPING_CUSTODY_CONFIG.read_text(encoding='utf-8'))['files']['c2-wrap-v1']
files = record['compose_files'] + [SIGNING_OVERLAY]
compose = compose_for(record['compose_project'], ops.ROOT, files, secret_file)
ops.run(compose + ['up', '-d', 'api'], timeout=install_timeout)
record.update(compose_files=files, wrapping_secret_file=secret_file)
ops.write_json(record_path, record)
```

The overlay's own header shows the bare shell form. Use `compose_for` on a site
instead: an exported variable would otherwise override `.env` (Site Compose
command).

A missing variable or file stops Compose; nothing creates replacement bytes. A
stack started without the overlay still serves its other work and answers each
approval with `WrappingSecretConfigurationPending`. The production introduction
tooling's fixed Compose list does not include this overlay yet; adding it there is
part of the approved operational activation, not of this file.

Each doctor's key is then created by the institution's admin: Members → the
member's **Signing Key** → Create Key (Rotate Key replaces it, Retire Key ends it;
each needs a reason). Doctors approve as before with no extra step. Every change
is one `server:doctor-key-management` entry of the access ledger (Access Review),
and earlier signatures keep verifying from the retained public keys. Because the
new private key is wrapped with `c2-wrap-v1`, the next nightly backup must succeed
with this custody configuration before the change is considered recoverable.

## Nightly job

Install a private JSON configuration at `/etc/kin-deploy/emr-wrapping-custody.json`,
using `emr/deploy/wrapping-custody.example.json` as the shape. Both the nightly
backup and the installed release entry read this location; the release entry
clears its environment. A direct invocation can override the configuration path
with `KIN_EMR_WRAPPING_CUSTODY`. `files` maps **all** current and historical wrapping
IDs still used by stored private keys to their absolute host file paths. Each is
the existing raw 32-byte wrapping secret; do not generate replacement bytes for
recovery. `backup_root` is a separate custody location, outside the checkout and
outside the database backup root, writable by the existing backup account.

Run the existing command:

```sh
python3 scripts/ops_backup.py backup --output /srv/kin-backups
```

While writers are paused, the tool copies the configured secrets to
`<backup_root>/<backup-set-name>/wrap-N.key` and records the absolute directory,
key-ID-to-file mapping and checksums in the database set's
`manifest.json` → `wrapping_custody`. That is the exact recovery locator.
Missing configuration when private keys exist, missing IDs, missing files or
invalid key lengths fail the backup; writers still resume through the existing
cleanup path. Held release captures use the same custody function.

Custody directories are not included in ordinary database export. Daily
rotation removes a deleted set's custody directory after the set itself, so an
interrupted removal never leaves a set without its key copy; a cleanup failure is
reported as `custody_cleanup_pending`. Thinned, held, protected and other retained
sets keep their custody directory. Rotation removes only
`<backup_root>/<set-name>` under the configured `backup_root` holding exactly the
recorded `wrap-N.key` files; a set whose custody is elsewhere (for example after
`backup_root` changed) or differs is kept and the run stops as `preserved-stop`.
Moving a snapshot to another host requires moving its custody directory too. Give
the new location with `--source` / `--wrapping-source` below; do not edit the
set's manifest. This unit does not enable offsite transfer or change the
external-backup OFF decision.

### Backup encryption

Every daily set is encrypted with the site's backup key; the nightly backup refuses, before it stops any writer,
when the key cannot be used. Install a private JSON configuration at `/etc/kin-deploy/backup-encryption.json`, using
`scripts/backup-encryption.example.json` as the shape (a direct invocation can name another file with
`KIN_BACKUP_ENCRYPTION`):

- `age`: the absolute path of the age program (v1.3.2, the version the export preparation and CI use; the nightly
  job runs with a cleared environment, so no PATH lookup is involved).
- `files`: each key ID mapped to the absolute path of one age identity file (`age-keygen -o <file>`). Keep it outside
  the checkout, the backup root and every volume a backup copies, readable by the backup account only. Keep a second
  copy of every identity away from the site: a set can only be restored with the identity it names, and losing it
  loses every set encrypted to it. The identity is not the EMR signing wrapping secret; each is kept and restored on
  its own.
- `current`: the key ID new sets are written with. To change keys, add the new identity under a new ID, make it
  `current`, and keep the old ID in `files` until the sets that name it have rotated out.
- `workspace`: a directory outside the backup root (on encrypted storage, or volatile space large enough for two
  sets) where a rehearsal or restore opens an encrypted set. A rehearsal needs the free space of one set's plaintext.
  A rollback needs two: P1 opens B once while validating it and closes it, then opens it again and keeps it; P2
  reuses that opening. Only one opening of B exists at a time, and at R1 the workspace holds B and N together.

An opened set's plaintext, and the wrapping key copies a rehearsal checks, exist only in a private folder
(`kin-open-*` in the workspace, `kin-wrapping-restore-*` in the temporary directory) that the run removes when it
ends. A run that is killed cannot: the next `ops_backup.py` command of the same account (the nightly backup included)
and the next opening in that workspace remove what it left, recognised by the owner record in the folder (host,
process ID and start time) whose process no longer runs; a folder of a run that is still going is not touched. After
killing a rehearsal or a rollback, do not wait for that: run any `ops_backup.py` command, for example
`python3 scripts/ops_backup.py rotate --root <backup-directory> --dry-run`, and check that both places are empty. A
workspace given only on the command line (`--workspace`) is cleared by the next run that is given the same one.

While writers are paused, each component (database dumps, the Orthanc and EMR-state archives, catalogs, `.env` and
the Compose files) goes through age as it is produced; no plaintext component is written into the backup root. The
manifest records the stored (encrypted) bytes, so rotation, monitoring and export inventories compare what is on disk;
the plaintext digests and the cluster's role catalog are sealed inside its `encryption` record, and that record with
the manifest's restore inputs is authenticated by the key. A set that fails to encrypt is not complete, so it is never
rotated in place of an older one. Encrypted sets are never sealed for the audit ledger.

## Recovery and rehearsal

Restore the database as in “Restore B into a separate rollback project R” or, for a
host behind the protected entry, with that mode's rollback. When the set's
manifest has `wrapping_custody`, restore the wrapping files into a new directory
before enabling online approvals. A set without it has no stored keys and no
locator; record custody restoration as not applicable, as in check 2 of the
synthetic checks.

```sh
python3 scripts/ops_backup.py restore-wrapping /srv/kin-backups/SET --destination /srv/kin-signing-restored/SET
python3 scripts/ops_backup.py rehearse /srv/kin-backups/SET
# custody moved to this host at another path:
python3 scripts/ops_backup.py restore-wrapping /srv/kin-backups/SET --source /mnt/custody/SET --destination /srv/kin-signing-restored/SET
python3 scripts/ops_backup.py rehearse /srv/kin-backups/SET --wrapping-source /mnt/custody/SET
```

Both commands first admit the stored set: it is complete and not thinned by rotation
(its Orthanc archive removed), its manifest lists exactly the components its kind
requires, every one of them is there with the size and digest the manifest records, and
no component is an age file unless the manifest carries the `encryption` record. A set
that fails this is not restored from and none of its key copies is written. Rotation
asks the same before it counts a set as a kept generation, together with the set's key
copies: a set a restore would refuse never takes the place of an older one.

An encrypted set (its manifest has an `encryption` record) is opened with the key it
names: `rehearse` checks that key against the record before anything else, then
decrypts every component into a new folder of the configured `workspace` and compares
each with its sealed digest and size, and only then starts the isolated restore; the
folder is removed afterwards. A wrong or missing key, a changed manifest or a changed
component refuses before any container, volume or workspace folder exists. On another
host, or with an identity kept elsewhere, give it for that set:

```sh
python3 scripts/ops_backup.py rehearse /srv/kin-backups/SET --encryption-key /mnt/keys/backup-key-1.txt --workspace /srv/kin-restore-work
```

A set written before encryption existed has no `encryption` record and is validated
and rehearsed as before, without a key. A restore into a rollback project reads an
encrypted B the same way, through `ops_backup.opened_set`: P1 opens B once while
validating it and closes it, then opens it again and keeps it; P2 reuses that opening
(`ops_backup.rehearse_opened`). Only one opening of B exists at a time, and at R1 the
workspace needs room for two sets, B and N. B's `.env`, dumps and archives come from the
opened folder; the hold, records and custody stay with B.

The first command checks the custody files against the snapshot and prints only
the restored ID/path mapping. It reads every custody file before creating the
destination, so a missing or changed file leaves no partial directory. Start the
stack with the restored `c2-wrap-v1` file as `compose_for`'s `secret_file`, and
name the restored files in the custody configuration before R's first backup.
The command refuses to overwrite an existing destination.

Rehearsal first reads the set's custody copies at that same locator (or at
`--wrapping-source`): a missing or changed copy stops it before its isolated restore
starts. It then restores its own temporary custody copy, checks
all restored table counts and calls the existing product key-unwrapping function
for every restored private key using the recorded API image. A copy that cannot
unwrap a restored key fails the rehearsal. Before the restored copy counts as verified it runs the
existing `emr_access.restore_expiry_sweep`: access and failure rows past their
period (개인정보의 안전성 확보조치 기준 제8조제1항, 2 years) are removed unless a hold
or open duty request keeps them, and history rows without ending evidence are kept
and counted. Record retention stays at 의료법 시행규칙 제15조제1항. Its receipt records
`wrapping_custody`, `emr.expiry_sweep` and `success`; secret bytes are never printed. Existing signatures retain public verification
evidence, but successful DB restoration alone does not certify new approvals.

## Upgrading stored login owners

For an existing installation on the preceding schema, keep application writes paused. In the target API image use the installer's `DATABASE_URL` and a private mounted directory for the inputs and report. An empty installation needs no review.

1. Run `node prisma/owner-upgrade.mjs configure unchanged [aliases.json]` only after confirming that every unlisted login had the same owner throughout the history being migrated. Use `unknown` in place of `unchanged` where that history is unavailable. The optional UTF-8 JSON file is an array of pairs, for example `[["former-login","verified-subject"],["reused-login",null]]`. A subject must be verified for **all** stored rows with that exact login. Use null for mixed or unknown authorship. Verify the subject against historical identity records, including for a deleted account whose subject is absent from the current directory. The command stores the review as `pacs.owner_history` on the installer role for this database. Login keys are SHA-256 of the exact UTF-8 string.
2. Run `node prisma/owner-upgrade.mjs before /evidence/owners.json` before `prisma migrate deploy`. Stop on a nonzero exit or an unexpected unresolved count or login hash. The SQL preflight reads a consistent snapshot. Two drafts for one subject and study both keep their original keys and appear in the unresolved count.
3. Before reopening writes run `node prisma/owner-upgrade.mjs after /evidence/owners.json`. A nonzero exit blocks reopening. The comparison covers per-table counts, record keys, exact login strings and expected account assignments. Study rows count once even with several unresolved assignments. Audit actors are included in preservation checks. Keep the report with the private upgrade record and run `node prisma/owner-upgrade.mjs clear` to remove the one-time setting.
