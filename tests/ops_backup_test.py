"""Failure-path checks for backup/restore safety; no Docker mutations in this file.

test_18 verifies new backups need no seal; test_19 and test_21..test_23 exercise existing sealed archives'
restored-copy verification in the real rehearse flow. The isolated verifier boundary is answered with synthetic digest streams (its PostgreSQL
behaviour is tests/audit_store_db_test.py); the manifest the flow wrote is fed to the unchanged ops_monitor.backup_status.
test_24 (OB-06, S7-AUDIT-STORE-F02) runs the real verifier boundary with a short time limit against the test-side fake
docker CLI of tests/ops_audit_integrity_test.py.
"""
from __future__ import annotations

import base64
import contextlib
import copy
from datetime import datetime, timedelta, timezone
import hashlib
import json
import io
import os
from pathlib import Path
import shutil
import subprocess
import stat
import sys
import tarfile
import tempfile
import time
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
sys.path.insert(0, str(Path(__file__).resolve().parent))
import ops_backup as ops
import ops_audit_integrity as audit
import ops_deploy_preflight as preflight
import ops_monitor as monitor
from ops_audit_integrity_test import FakeDocker, verifier_answer

PRESENT = {"state": "present", "statements": {"insert": "accepted", "update": "refused", "delete": "refused",
                                              "truncate": "refused"}}
INEFFECTIVE = {"state": "ineffective", "statements": {"insert": "accepted", "update": "accepted", "delete": "refused",
                                                      "truncate": "refused"}}


def age_program():
    """The pinned age the backup encrypts with (CI: KIN_TEST_AGE); its age-keygen sits beside it."""
    program = os.environ.get("KIN_TEST_AGE") or shutil.which("age")
    if not program:
        raise RuntimeError("Set KIN_TEST_AGE to the pinned age program: every new daily backup is encrypted")
    return Path(program).absolute()


def write_encryption_config(folder, key_ids=("test-1",), current=None, workspace=True):
    """A test-only backup encryption configuration in `folder`: fresh identities, the workspace beside them."""
    folder = Path(folder)
    folder.mkdir(parents=True, exist_ok=True)
    age = age_program()
    keygen = age.with_name("age-keygen" + age.suffix)
    files = {}
    for key_id in key_ids:
        path = folder / (key_id + ".key")
        if not path.exists():
            subprocess.run([str(keygen), "-o", str(path)], check=True, capture_output=True)
        files[key_id] = str(path)
    body = {"format": 1, "age": str(age), "current": current or key_ids[-1], "files": files}
    if workspace:
        (folder / "open").mkdir(exist_ok=True)
        body["workspace"] = str(folder / "open")
    config = folder / "backup-encryption.json"
    config.write_text(json.dumps(body), encoding="utf-8")
    return config


def sealed_metadata(folder):
    """The manifest a restore reads of an encrypted daily set: its sealed role catalog and plaintext digests."""
    manifest = json.loads((Path(folder) / "manifest.json").read_text(encoding="utf-8"))
    return ops.plaintext_manifest(manifest, ops.backup_key(manifest["encryption"]["key_id"]))


def as_plaintext_set(folder):
    """The set as a backup written before encryption existed left it: plaintext components, no encryption record."""
    folder = Path(folder)
    with ops.opened_set(folder) as opened:
        for name in opened.manifest["sha256"]:
            shutil.copyfile(opened.path / name, folder / name)
        ops.write_json(folder / "manifest.json", opened.manifest)
    return json.loads((folder / "manifest.json").read_text(encoding="utf-8"))


def reseal(folder, components):
    """Rewrite components of an encrypted set as only its key holder could: encrypted, sealed and authenticated anew."""
    folder = Path(folder)
    manifest = json.loads((folder / "manifest.json").read_text(encoding="utf-8"))
    key = ops.backup_key(manifest["encryption"]["key_id"])
    plain = ops.plaintext_manifest(manifest, key)
    metadata = {"plaintext": {name: {"sha256": plain["sha256"][name], "bytes": plain["bytes"][name]} for name in plain["sha256"]}}
    if "role_catalog" in plain:
        metadata["role_catalog"] = plain["role_catalog"]
    for name, data in components.items():
        (folder / name).unlink()
        with ops.SealedComponent(folder / name, key) as sink:
            sink.write(data)
        metadata["plaintext"][name] = {"sha256": hashlib.sha256(data).hexdigest(), "bytes": len(data)}
        manifest["sha256"][name], manifest["bytes"][name] = ops.digest(folder / name), (folder / name).stat().st_size
    manifest["encryption"]["sealed"] = base64.b64encode(ops.age_bytes(key, json.dumps(metadata).encode("utf-8"))).decode("ascii")
    manifest["encryption"]["auth"] = ops.manifest_auth(manifest, key)
    ops.write_json(folder / "manifest.json", manifest)
    return manifest


def refused_before_restore(test, folder, pattern, opening, **options):
    """The rehearsal refuses with `pattern` and nothing of a restore happened: no Docker command at all, nothing in
    the opening workspace `opening`, no rehearsal result."""
    before, results = set(opening.iterdir()), set(folder.glob("rehearsal-*.json"))
    with patch.object(ops, "run") as run, patch.object(ops, "text") as text, \
            patch.object(ops, "temporary_run") as helper, contextlib.redirect_stdout(io.StringIO()):
        with test.assertRaisesRegex(RuntimeError, pattern):
            ops.rehearse(folder, **options)
    test.assertEqual((run.call_args_list, text.call_args_list, helper.call_args_list), ([], [], []))
    test.assertEqual(set(opening.iterdir()), before)
    test.assertEqual(set(folder.glob("rehearsal-*.json")), results)


def restore_wrapping_cli(folder, destination, *extra):
    """The standalone `restore-wrapping` command; returns its error (None when it wrote the key copies)."""
    with patch.object(sys, "argv", ["ops_backup.py", "restore-wrapping", str(folder), "--destination", str(destination), *extra]), \
            contextlib.redirect_stdout(io.StringIO()):
        try:
            ops.main()
        except RuntimeError as error:
            return error
    return None


@contextlib.contextmanager
def another_run(source, arguments, environment=None, *, kill):
    """`source` in a new Python process, up to where it prints the private folder it works in and waits; yields that
    folder. Then the process is killed (none of its cleanup code runs) or let to finish normally."""
    child = subprocess.Popen([sys.executable, "-B", "-c", source, str(Path(ops.__file__).parent), *map(str, arguments)],
                             stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                             env={**os.environ, **(environment or {})})
    try:
        line = child.stdout.readline().decode("utf-8").strip()
        if not line:
            child.kill()
            raise AssertionError("the other run did not start: " + child.stderr.read().decode("utf-8", "replace")[-800:])
        yield Path(line)
    finally:
        if kill:
            child.kill()
        else:
            child.stdin.close()
        child.wait()
        for stream in (child.stdin, child.stdout, child.stderr):
            stream.close()


# A run that has an encrypted set open (its plaintext in the opening workspace) ...
OPENING_RUN = """import sys
sys.path.insert(0, sys.argv[1])
import ops_backup as ops
with ops.opened_set(sys.argv[2]) as opened:
    print(opened.path, flush=True)
    sys.stdin.read()
"""
# ... and one inside a rehearsal's check of the wrapping key copies (the keys in a temporary folder).
CUSTODY_RUN = """import json, sys
sys.path.insert(0, sys.argv[1])
import ops_backup as ops
manifest = json.loads(open(sys.argv[2], encoding="utf-8").read())
def unwrap(args, **options):
    mount = next(part for part in args if part.startswith("type=bind,source="))
    print(mount[len("type=bind,source="):].rsplit(",target=", 1)[0], flush=True)
    sys.stdin.read()
    return "WRAPPING_RESTORE_VERIFIED"
ops.signing_keys = lambda *args, **options: [{"kid": "doctor-key", "wrapped": {"wrappingKeyId": "wrap-1"}}]
ops.temporary_run = unwrap
ops.rehearse_wrapping_custody(None, manifest, "unused")
"""


_MODULE_KEYS = None


def setUpModule():
    global _MODULE_KEYS
    _MODULE_KEYS = tempfile.TemporaryDirectory()
    os.environ["KIN_BACKUP_ENCRYPTION"] = str(write_encryption_config(_MODULE_KEYS.name))


def tearDownModule():
    os.environ.pop("KIN_BACKUP_ENCRYPTION", None)
    _MODULE_KEYS.cleanup()


def rows_stream(rows, guard=PRESENT, schema=()):
    """A synthetic isolated-verifier answer: {id: content} as the (id, count, digest) stream."""
    return audit.Evaluation(table=True, rows=[(key, 1, hashlib.sha256(value.encode()).hexdigest())
                                              for key, value in rows.items()], guard=dict(guard), schema=list(schema))


def orthanc_archive():
    stream = io.BytesIO()
    with tarfile.open(fileobj=stream, mode="w:gz") as archive:
        entry = tarfile.TarInfo("./index")
        entry.size = 1
        archive.addfile(entry, io.BytesIO(b"x"))
    return stream.getvalue()


def pg_role(name, *, superuser=False, login=False, inherit=True, connlimit=-1):
    return {"rolname": name, "rolsuper": superuser, "rolcreaterole": superuser, "rolcreatedb": superuser, "rolcanlogin": login,
            "rolreplication": superuser, "rolbypassrls": superuser, "rolinherit": inherit, "rolconnlimit": connlimit,
            "rolvaliduntil": None, "rolconfig": None}


def daily_role_catalog():
    """The role catalog of a post-EMR production cluster (bootstrap superuser kin) as a daily backup reads it (D23): the
    EMR roles and a further NOLOGIN role with a membership that pg_dumpall records as GRANTED BY kin."""
    roles = [pg_role("kin", superuser=True, login=True), pg_role("kin_emr_owner"), pg_role("kin_emr_reader"),
                      pg_role("kin_emr_retention"), pg_role("kin_legacy_group", inherit=False), pg_role("kin_legacy_reader", connlimit=3),
                      pg_role("kin_runtime", login=True)]
    return {"server_major": 16, "unsupported_verifiers": [], "login_verifiers": sorted(row["rolname"] for row in roles if row["rolcanlogin"]), "builtin_roles": [], "settings": [],
            "setting_names": ["search_path", "statement_timeout", "work_mem"],
            "role_comments": [[row["rolname"], None] for row in roles], "roles": roles,
            "memberships": [{"granted": "kin_legacy_group", "member": "kin_legacy_reader", "grantor": "kin", "admin_option": False, "inherit_option": True,
                             "set_option": True}],
            "databases": [{"name": "keycloak", "owner": "kin", "acl": ["=Tc/kin", "kin=CTc/kin"], "attributes": {"datistemplate": False, "datallowconn": True}},
                          {"name": "kin", "owner": "kin", "acl": ["=Tc/kin", "kin=CTc/kin", "kin_legacy_reader=c/kin"], "attributes": {"datistemplate": False, "datallowconn": True}},
                          *[{"name": name, "owner": "kin", "acl": ["=Tc/kin", "kin=CTc/kin"], "attributes": {"datistemplate": False, "datallowconn": True}} for name in ("postgres", "template0", "template1")]],
            "tablespaces": [{"name": "kin_emr_access", "owner": "kin_emr_owner", "location": ops.EMR_TABLESPACE},
                            {"name": "pg_default", "owner": "kin", "location": ""}, {"name": "pg_global", "owner": "kin", "location": ""}],
            "schemas": ["emr_access", "public"]}


def expiry_receipt():
    return {"ran": True, "complete": True, "checkedAt": "2026-10-23T00:00:00Z",
            "deletedEntries": 0, "deletedFailures": 0, "retainedByDutyOrHold": 0,
            "historyRetainedUnknownLifetime": 0}


class DailyCluster:
    """The fresh networkless rehearsal cluster of a daily EMR set restored by the catalog replay (D23): bootstrap superuser
    kin; it applies the CREATE ROLE / GRANT statements sent on stdin, the EMR tablespace and pg_restore --create; its
    databases, tablespaces and schemas are then the snapshot's (or `restored`, a restore that came out differently)."""

    def __init__(self, source, restored=None, expiry=None):
        self.source, self.restored = source, restored
        self.expiry = expiry if expiry is not None else expiry_receipt()
        self.roles = {"kin": next(role for role in source["roles"] if role["rolname"] == "kin")}
        self.memberships, self.tablespace, self.restored_databases, self.statements = [], False, set(), []
        self.verifiers = set()

    def catalog(self):
        base = self.restored or self.source
        whole = self.restored_databases >= {"kin", "keycloak"}
        # A fresh cluster holds the image's postgres and templates and what pg_restore --create brought back: a source
        # database the set does not hold (and a setting scoped to it) never exists there. `restored` is echoed as given.
        present = {"postgres", "template0", "template1", *self.restored_databases}
        databases = base["databases"] if self.restored else [item for item in base["databases"] if item["name"] in present]
        settings = base["settings"] if self.restored else [entry for entry in base["settings"] if entry["database"] in (None, *present)]
        return {**{key: base[key] for key in ("server_major", "unsupported_verifiers", "login_verifiers", "builtin_roles", "setting_names")},
                "settings": settings,
                "login_verifiers": sorted(self.verifiers), "role_comments": [[name, None] for name in sorted(self.roles)], "roles": [self.roles[name] for name in sorted(self.roles)],
                "memberships": sorted(self.memberships, key=lambda item: (item["granted"], item["member"])),
                "databases": databases if whole else [{"name": "kin", "owner": "kin", "acl": []}, {"name": "postgres", "owner": "kin", "acl": []}],
                "tablespaces": base["tablespaces"] if self.tablespace else [item for item in base["tablespaces"] if item["name"].startswith("pg_")],
                "schemas": base["schemas"] if whole else ["public"]}

    def text(self, args, **kwargs):
        joined = " ".join(args)
        if "emr_access.restore_expiry_sweep()" in joined:
            return json.dumps(self.expiry)
        if ops.ROLE_CATALOG_SQL in args:
            return json.dumps(self.catalog())
        if "datname='keycloak'" in joined:
            return "%d:%d" % ("keycloak" in self.restored_databases, "kin" not in self.restored_databases)
        if "FROM pg_largeobject_metadata" in joined:
            return "0"
        raise AssertionError("unexpected rehearsal query " + joined[:80])

    def observe(self, args, input_file):
        import re as pattern
        joined = " ".join(args)
        if "psql" in args and input_file is not None:
            sql = input_file.read().decode("utf-8", errors="replace")
            self.statements.append(sql)
            self.verifiers.update(pattern.findall(r'ALTER ROLE "([^"]+)" PASSWORD ', sql))
            for name, flags in pattern.findall(r'CREATE ROLE "([^"]+)" WITH ([^;]+);', sql):
                words = flags.split()
                self.roles[name] = {**pg_role(name), "rolsuper": "SUPERUSER" in words, "rolcreaterole": "CREATEROLE" in words,
                                    "rolcreatedb": "CREATEDB" in words, "rolcanlogin": "LOGIN" in words, "rolreplication": "REPLICATION" in words,
                                    "rolbypassrls": "BYPASSRLS" in words, "rolinherit": "INHERIT" in words,
                                    "rolconnlimit": int(words[words.index("LIMIT") + 1])}
            for granted, member, admin, inherit, setting in pattern.findall(
                    r'GRANT "([^"]+)" TO "([^"]+)" WITH ADMIN (TRUE|FALSE), INHERIT (TRUE|FALSE), SET (TRUE|FALSE);', sql):
                self.memberships.append({"granted": granted, "member": member, "grantor": "kin", "admin_option": admin == "TRUE",
                                         "inherit_option": inherit == "TRUE", "set_option": setting == "TRUE"})
        elif "CREATE TABLESPACE kin_emr_access" in joined:
            self.tablespace = True
        elif "pg_restore" in args and input_file is not None:
            self.restored_databases.add(Path(input_file.name).name.split(".")[0])


class Host:
    """The fake host of test_14 (all writers running) with a private backup parent beside the repository, recording
    every command and the order of pause, resume, readiness and seal."""

    def __init__(self, temporary):
        self.repo = Path(temporary) / "repo"
        self.repo.mkdir()
        for filename in ops.FILES[3:]:
            (self.repo / filename).write_text("TEST_ONLY=placeholder")
        (self.repo / ".env").write_text("POSTGRES_PASSWORD=synthetic-fixture\nKIN_EMR_RUNTIME_PASSWORD=synthetic-runtime\n")
        self.parent = Path(temporary) / "backups"
        self.parent.mkdir(mode=0o700)
        # Every new daily set is encrypted: the module's test-only key (or, imported elsewhere, this host's own), outside
        # the repository and the backup root.
        configured = os.environ.get("KIN_BACKUP_ENCRYPTION")
        if not configured or not Path(configured).is_file():
            os.environ["KIN_BACKUP_ENCRYPTION"] = str(write_encryption_config(Path(temporary) / "backup-keys"))
        self.encryption = Path(os.environ["KIN_BACKUP_ENCRYPTION"])
        self.info = [{"Name": "/" + name, "State": {"Running": True}, "Image": "sha256:" + "a" * 64,
                      "Config": {"Labels": {"com.docker.compose.project": "fixture",
                                            "com.docker.compose.project.working_dir": str(self.repo)}},
                      "Mounts": [{"Destination": "/var/lib/orthanc/db", "Type": "volume", "Name": "fixture-volume"}, {"Destination": ops.EMR_STATE, "Type": "volume", "Name": "fixture-emr-state"}]}
                     for name in (*ops.CONTAINERS, "kin-proxy")]
        self.events = []
        self.sources = []
        self.catalog = {"synthetic": "catalog"}
        self.restored_catalog = None
        self.restore_answer = "EMR_RESTORE_VERIFIED"
        self.table_counts = {"public.Report": 5}
        # D23: the cluster's role catalog the backup records, and (when set) what a rehearsal's restore comes out with.
        self.role_catalog = daily_role_catalog()
        self.restored_role_catalog = None
        self.restored_expiry = expiry_receipt()
        self.cluster = None
        # Backups a minute apart within the monitor's 30-hour window: the monitor orders manifests by whole seconds.
        self.clock = datetime.now(timezone.utc) - timedelta(hours=1)

    def now(self, tz=None):
        self.clock += timedelta(minutes=1)
        return self.clock

    def init_ledger(self):
        with patch.object(ops, "ROOT", self.repo), contextlib.redirect_stdout(io.StringIO()):
            assert audit.main(["init", str(self.parent)]) == 0

    def fake_text(self, args, **kwargs):
        self.events.append(("command", list(args)))
        if args[:2] == ["docker", "inspect"]:
            return "false" if "--format" in args else json.dumps(self.info)
        if args[:3] == ["docker", "image", "inspect"]:
            return '[{"RepoDigests": []}]'
        if "pg_database_size('kin')" in " ".join(args):
            return "4096"
        if "pg_stat_activity" in " ".join(args):
            return "0"
        if ops.ROLE_CATALOG_SQL in args:
            return json.dumps(self.role_catalog)
        return "" if "status" in args else "a" * 40

    def fake_run(self, args, **kwargs):
        self.events.append(("command", list(args)))
        if "pg_dump" in args or "pg_dumpall" in args:
            kwargs["output"].write(b"fixture dump " + str(time.monotonic_ns()).encode())
        return SimpleNamespace(returncode=0, stdout=b"", stderr=b"")

    def fake_archive(self, args, **kwargs):
        if "-sk" in args:
            return "8 /source"
        if kwargs.get("output") is not None:
            kwargs["output"].write(orthanc_archive())
            return ""
        if any("WRAPPING_RESTORE_VERIFIED" in arg for arg in args):
            return "WRAPPING_RESTORE_VERIFIED"
        return json.dumps({"integrity": "ok", "attachments": 0, "attachment_bytes": 0}) if "python3" in args else self.restore_answer

    def boundary(self, answer):
        def evaluate(source, *args, **kwargs):
            self.events.append(("evaluate", source))
            self.sources.append(source)
            if isinstance(answer, BaseException):
                raise answer
            return answer(source) if callable(answer) else answer
        return evaluate

    def backup(self, answer):
        """One ops.backup run whose seal is answered with `answer`; returns (folder, manifest, error)."""
        before = {entry.name for entry in self.parent.iterdir()}
        error = None
        clock = type("Clock", (datetime,), {"now": staticmethod(self.now)})
        with patch.object(ops, "ROOT", self.repo), patch.object(ops, "datetime", clock), \
                patch.object(ops, "text", side_effect=self.fake_text), \
                patch.object(ops, "run", side_effect=self.fake_run), \
                patch.object(ops, "temporary_run", side_effect=self.fake_archive), \
                patch.object(ops, "emr_catalog", return_value=self.catalog), \
                patch.object(ops, "counts", return_value=self.table_counts), \
                patch.object(ops, "wait_ready", side_effect=lambda *a: self.events.append(("ready",))), \
                patch.object(audit, "evaluate", side_effect=self.boundary(answer)), \
                contextlib.redirect_stdout(io.StringIO()):
            try:
                ops.backup(self.parent)
            except RuntimeError as caught:
                error = caught
        folder = next(self.parent / name for name in {entry.name for entry in self.parent.iterdir()} - before)
        return folder, json.loads((folder / "manifest.json").read_text(encoding="utf-8")), error

    def legacy_backup(self, answer):
        """Construct a pre-cleanup sealed archive (written before encryption existed); new daily backups no longer
        seal and are encrypted."""
        folder, manifest, error = self.backup(answer)
        if error:
            raise error
        manifest = as_plaintext_set(folder)
        with patch.object(audit, 'evaluate', side_effect=self.boundary(answer)):
            alarm = audit.seal(folder, self.parent, manifest)
        return folder, manifest, RuntimeError(alarm) if alarm else None

    def rehearse(self, folder, answer, **options):
        """One ops.rehearse run whose restored-copy verification is answered with `answer`."""
        self.events.clear()
        self.sources.clear()
        error = None
        cleanup = Mock()
        earlier = set(folder.glob("rehearsal-*.json"))
        recorded = json.loads((folder / "manifest.json").read_text(encoding="utf-8")).get("role_catalog")
        self.cluster = DailyCluster(recorded or self.role_catalog, self.restored_role_catalog, self.restored_expiry)

        def rehearsal_run(args, **kwargs):
            self.events.append(("command", list(args)))
            self.cluster.observe(args, kwargs.get("input_file"))
            return SimpleNamespace(returncode=0, stdout=b"", stderr=b"")
        with patch.object(ops, "run", side_effect=rehearsal_run), patch.object(ops, "text", side_effect=self.cluster.text), \
                patch.object(ops, "temporary_run", side_effect=self.fake_archive), \
                patch.object(ops, "emr_catalog", return_value=self.restored_catalog or self.catalog), \
                patch.object(ops, "counts", return_value=self.table_counts), \
                patch.object(ops, "remove_owned_if_present", cleanup), \
                patch.object(audit, "evaluate", side_effect=self.boundary(answer)), \
                contextlib.redirect_stdout(io.StringIO()):
            try:
                ops.rehearse(folder, **options)
            except RuntimeError as caught:
                error = caught
        (written,) = set(folder.glob("rehearsal-*.json")) - earlier
        result = json.loads(written.read_text())
        started = [cmd for kind, cmd in self.events if kind == "command" and cmd[:3] == ["docker", "run", "-d"]]
        container = started[0][started[0].index("--name") + 1] if started else None
        return result, error, container, cleanup

    def status(self):
        return monitor.backup_status(self.parent, self.parent / ".no-lock", int(time.time()))[0]

    def files(self, folder):
        return {path.name: path.read_bytes() for path in folder.iterdir() if not path.name.startswith("rehearsal-")}


class BackupSafetyTests(unittest.TestCase):
    def test_01_dump_failure_resumes_only_originally_running_writers(self):
        """TEST-OPS-01: a partial snapshot must never leave the original writers stopped."""
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / "repo"
            root.mkdir()
            (root / ".env").write_text("TEST_ONLY=placeholder")
            info = []
            for name in (*ops.CONTAINERS, "kin-proxy"):
                info.append({"Name": "/" + name, "State": {"Running": name != "kin-keycloak"},
                             "Image": "sha256:" + "a" * 64,
                             "Config": {"Labels": {"com.docker.compose.project": "fixture",
                                                   "com.docker.compose.project.working_dir": str(root)}},
                             "Mounts": [{"Destination": "/var/lib/orthanc/db", "Type": "volume", "Name": "fixture-volume"}, {"Destination": ops.EMR_STATE, "Type": "volume", "Name": "fixture-emr-state"}]})

            def fake_text(args, **kwargs):
                if args[:2] == ["docker", "inspect"]:
                    return "false" if "--format" in args else json.dumps(info)
                if "pg_database_size('kin')" in " ".join(args):
                    return "4096"
                if args[:3] == ["docker", "image", "inspect"]:
                    return '[{"RepoDigests": []}]'
                if "pg_stat_activity" in " ".join(args):
                    return "0"
                if ops.ROLE_CATALOG_SQL in args:
                    return json.dumps(daily_role_catalog())
                return "" if "status" in args else "a" * 40

            def fake_run(args, **kwargs):
                if "pg_dumpall" in args:
                    kwargs["output"].write(b"synthetic roles")
                if "pg_dump" in args:
                    raise RuntimeError("simulated dump failure")
                return SimpleNamespace(returncode=0, stdout=b"")

            output = Path(temporary) / "backups"
            with patch.object(ops, "ROOT", root), patch.object(ops, "text", side_effect=fake_text), \
                    patch.object(ops, "run", side_effect=fake_run) as commands, \
                    patch.object(ops, "temporary_run", return_value="8 /source"), \
                    patch.object(ops, "emr_catalog", return_value={"synthetic": "catalog"}), \
                    patch.object(ops, "counts", return_value={"public.Report": 5}):
                with self.assertRaisesRegex(RuntimeError, "simulated dump failure"):
                    ops.backup(output)
            starts = [call.args[0] for call in commands.call_args_list if call.args[0][1] == "start"]
            self.assertEqual(starts, [["docker", "start", "kin-api"], ["docker", "start", "kin-orthanc"]])
            manifest = json.loads(next(output.glob("*/manifest.json")).read_text())
            self.assertFalse(manifest["complete"])
            self.assertEqual(manifest["resume_failures"], [])
            self.assertEqual(manifest["backup_error"]["stage"], "dump kin")

    def test_02_secret_backup_inside_repository_is_refused(self):
        with patch.object(ops, "text") as command:
            with self.assertRaisesRegex(RuntimeError, "outside the Git repository"):
                ops.backup(ops.ROOT / "backups")
            command.assert_not_called()

    def test_03_changed_backup_fails_before_restore(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            for name in ops.FILES:
                (directory / name).write_bytes(b"test fixture")
            manifest = {"format": 1, "complete": True, "resume_failures": [],
                        "sha256": {name: ops.digest(directory / name) for name in ops.FILES}}
            ops.write_json(directory / "manifest.json", manifest)
            (directory / "kin.dump").write_bytes(b"corrupted")
            with patch.object(ops, "run") as command:
                with self.assertRaisesRegex(RuntimeError, "checksum mismatch"):
                    ops.validate_backup(directory)
                command.assert_not_called()

    def test_04_cleanup_requires_generated_name_and_ownership(self):
        with patch.object(ops, "text", return_value="someone-else"), patch.object(ops, "run") as command:
            for name in ("kin-db", "kin-rehearsal-another-run"):
                with self.assertRaises(RuntimeError):
                    ops.remove_owned("container", name, "my-token")
                command.assert_not_called()

    def test_05_cleanup_removes_only_owned_temporary_resources(self):
        with patch.object(ops, "text", return_value="my-token"), patch.object(ops, "run") as command:
            ops.remove_owned("container", "kin-rehearsal-owned", "my-token")
            command.assert_called_once()
            self.assertEqual(command.call_args.args[0], ["docker", "rm", "-f", "-v", "kin-rehearsal-owned"])

    def test_06_failed_commands_do_not_echo_secret_output(self):
        result = SimpleNamespace(returncode=1, stdout=b"private value", stderr=b"credential text")
        with patch.object(subprocess, "run", return_value=result):
            with self.assertRaises(RuntimeError) as caught:
                ops.run(["docker", "exec", "credential-in-arguments"])
        self.assertNotIn("credential", str(caught.exception))
        self.assertNotIn("private", str(caught.exception))

    def test_07_remote_docker_refused_before_inspection(self):
        with patch.dict(ops.os.environ, {"DOCKER_HOST": "ssh://remote"}, clear=True), patch.object(ops, "text") as command:
            with self.assertRaises(RuntimeError):
                ops.require_local_docker()
            command.assert_not_called()

    def test_08_operations_lock_does_not_remove_another_owner(self):
        with tempfile.TemporaryDirectory() as temporary, patch.object(ops, "ROOT", Path(temporary)):
            path = Path(temporary) / ".kin-ops.lock"
            with ops.lock():
                with self.assertRaises(FileExistsError):
                    with ops.lock():
                        self.fail("Second operation acquired an existing lock")
                self.assertTrue(path.exists())
            self.assertFalse(path.exists())

    def test_09_daemon_failure_is_not_successful_cleanup(self):
        failure = SimpleNamespace(returncode=1, stdout=b"", stderr=b"Cannot connect to the Docker daemon")
        with patch.object(ops, "run", return_value=failure):
            with self.assertRaisesRegex(RuntimeError, "Could not verify"):
                ops.remove_owned_if_present("container", "kin-rehearsal-owned", "token")

    def test_10_unsafe_archive_is_refused_even_with_matching_checksums(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            for name in ops.FILES:
                (directory / name).write_bytes(b"test fixture")
            with tarfile.open(directory / "orthanc.tgz", "w:gz") as archive:
                entry = tarfile.TarInfo("../outside")
                entry.size = 1
                archive.addfile(entry, io.BytesIO(b"x"))
            ops.write_json(directory / "manifest.json", {
                "format": 1, "complete": True, "resume_failures": [],
                "sha256": {name: ops.digest(directory / name) for name in ops.FILES},
            })
            with patch.object(ops, "run") as command:
                with self.assertRaisesRegex(RuntimeError, "Unsafe Orthanc archive"):
                    ops.validate_backup(directory)
                command.assert_not_called()

    def test_11_existing_shared_or_foreign_parent_is_never_chmodded(self):
        for mode, owner in ((0o1777, 1000), (0o700, 1001)):
            parent = Mock()
            parent.exists.return_value = True
            parent.is_dir.return_value = True
            parent.stat.return_value = SimpleNamespace(st_mode=stat.S_IFDIR | mode, st_uid=owner)
            with self.subTest(mode=mode, owner=owner), patch.object(ops.os, "name", "posix"), \
                    patch.object(ops.os, "geteuid", return_value=1000, create=True):
                with self.assertRaisesRegex(RuntimeError, "must be private"):
                    ops.prepare_backup_parent(parent)
            parent.chmod.assert_not_called()
            parent.mkdir.assert_not_called()

    def test_12_only_new_backup_parent_gets_private_creation_mode(self):
        parent = Mock()
        parent.exists.return_value = False
        ops.prepare_backup_parent(parent)
        parent.mkdir.assert_called_once_with(parents=True, mode=0o700)
        parent.chmod.assert_not_called()

    def test_13_intact_snapshot_remains_usable_when_source_resume_failed(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            for name in ops.FILES:
                (directory / name).write_bytes(b"test fixture")
            with tarfile.open(directory / "orthanc.tgz", "w:gz") as archive:
                entry = tarfile.TarInfo("./index")
                entry.size = 1
                archive.addfile(entry, io.BytesIO(b"x"))
            ops.write_json(directory / "manifest.json", {
                "format": 1, "complete": True, "ready": False, "resume_failures": ["kin-api"],
                "postgres_image": "sha256:" + "a"*64, "orthanc_image": "sha256:" + "b"*64,
                "sha256": {name: ops.digest(directory / name) for name in ops.FILES},
            })
            with patch.object(ops, "run"):
                _, manifest = ops.validate_backup(directory)
            self.assertTrue(manifest["complete"])
            self.assertFalse(manifest["ready"])

    def test_emr_resume_refusal_preserves_snapshot_without_claiming_ready(self):
        with tempfile.TemporaryDirectory() as temporary:
            host = Host(temporary)
            host.init_ledger()
            with patch.object(ops, 'resumed_ledger_ready', side_effect=RuntimeError('synthetic PG unavailable')):
                folder, manifest, error = host.backup(rows_stream({1: 'fixture'}))
            self.assertIsNotNone(error)
            self.assertTrue(manifest['complete'])
            self.assertFalse(manifest['ready'])
            self.assertFalse(manifest['emr']['resumed_pg_ready'])
            self.assertEqual(manifest['resume_failures'], [])
            self.assertTrue((folder/'kin.dump').is_file())

    def test_14_readiness_failure_blocks_deploy_but_preserves_completed_backup(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / "repo"
            root.mkdir()
            for filename in ops.FILES[3:]:
                (root / filename).write_text("TEST_ONLY=placeholder")
            info = [{"Name": "/" + name, "State": {"Running": True}, "Image": "sha256:" + "a"*64,
                     "Config": {"Labels": {"com.docker.compose.project": "fixture",
                                           "com.docker.compose.project.working_dir": str(root)}},
                     "Mounts": [{"Destination": "/var/lib/orthanc/db", "Type": "volume", "Name": "fixture-volume"}, {"Destination": ops.EMR_STATE, "Type": "volume", "Name": "fixture-emr-state"}]}
                    for name in (*ops.CONTAINERS, "kin-proxy")]

            def fake_text(args, **kwargs):
                if args[:2] == ["docker", "inspect"]:
                    return "false" if "--format" in args else json.dumps(info)
                if args[:3] == ["docker", "image", "inspect"]:
                    return '[{"RepoDigests": []}]'
                if "pg_database_size('kin')" in " ".join(args):
                    return "4096"
                if "pg_stat_activity" in " ".join(args):
                    return "0"
                if ops.ROLE_CATALOG_SQL in args:
                    return json.dumps(daily_role_catalog())
                return "" if "status" in args else "a"*40

            def fake_run(args, **kwargs):
                if "pg_dump" in args or "pg_dumpall" in args:
                    kwargs["output"].write(b"fixture dump")
                return SimpleNamespace(returncode=0, stdout=b"")

            def fake_archive(args, **kwargs):
                if "-sk" in args:
                    return "8 /source"
                kwargs["output"].write(b"fixture archive")
                return ""

            output = Path(temporary) / "backups"
            # S7-AUDIT-STORE NR-20: the complete snapshot is sealed after the readiness failure, so the parent holds an
            # initialised ledger and the seal's isolated verifier answers; the readiness error keeps its priority.
            output.mkdir(mode=0o700)
            with patch.object(ops, "ROOT", root), contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(audit.main(["init", str(output)]), 0)
            with patch.object(ops, "ROOT", root), patch.object(ops, "text", side_effect=fake_text), \
                    patch.object(ops, "run", side_effect=fake_run), patch.object(ops, "temporary_run", side_effect=fake_archive), \
                    patch.object(ops, "emr_catalog", return_value={"synthetic": "catalog"}), \
                patch.object(ops, "counts", return_value={"public.Report": 5}), \
                    patch.object(ops, "wait_ready", side_effect=RuntimeError("fixture timeout")), \
                    patch.object(audit, "evaluate", return_value=rows_stream({1: "fixture"})):
                with self.assertRaisesRegex(RuntimeError, "readiness needs recovery"):
                    ops.backup(output)
            manifest = json.loads(next(output.glob("*/manifest.json")).read_text())
            self.assertTrue(manifest["complete"])
            self.assertFalse(manifest["ready"])
            self.assertEqual(manifest["resume_failures"], [])
            self.assertTrue(manifest["proxy_reloaded"])

    def test_17_invalid_proxy_configuration_is_never_reloaded(self):
        with patch.object(ops, "run", side_effect=RuntimeError("invalid proxy config")) as command:
            with self.assertRaisesRegex(RuntimeError, "invalid proxy config"):
                ops.reload_proxy()
            command.assert_called_once_with(["docker", "exec", "kin-proxy", "nginx", "-t"], timeout=30)

    def test_15_binary_archive_stream_does_not_decode_or_buffer_stdout(self):
        payload = b"\x1f\x8b\xff\x00binary archive"
        with tempfile.TemporaryFile() as output:
            def produce(args, **kwargs):
                self.assertIs(kwargs["stdout"], output)
                kwargs["stdout"].write(payload)
                return SimpleNamespace(returncode=0, stdout=None, stderr=b"")

            with patch.object(subprocess, "run", side_effect=produce), \
                    patch.object(ops, "remove_owned_if_present") as cleanup:
                self.assertEqual(ops.temporary_run(["fixture-image"], output=output), "")
            output.seek(0)
            self.assertEqual(output.read(), payload)
            cleanup.assert_called_once()

    def test_16_stream_timeout_still_cleans_the_owned_helper(self):
        with tempfile.TemporaryFile() as output, \
                patch.object(ops, "run", side_effect=subprocess.TimeoutExpired("docker", 1)), \
                patch.object(ops, "remove_owned_if_present") as cleanup:
            with self.assertRaises(subprocess.TimeoutExpired):
                ops.temporary_run(["fixture-image"], output=output, timeout=1)
            cleanup.assert_called_once()


    def test_18_backup_completes_without_an_audit_seal_service(self):
        with tempfile.TemporaryDirectory() as temporary:
            host = Host(temporary)
            folder, manifest, error = host.backup(audit.InputError('seal unavailable'))
            self.assertIsNone(error)
            self.assertTrue(manifest['complete'])
            self.assertTrue(manifest['ready'])
            self.assertEqual(host.sources, [])
            self.assertNotIn('audit', manifest)
            with patch.object(ops, 'run'):
                self.assertTrue(ops.validate_backup(folder)[1]['complete'])

    def test_19_ob02_declared_checkpoint_is_a_validated_component_and_old_backups_stay_valid(self):
        """OB-02 (SE-01, SE-11)."""
        with tempfile.TemporaryDirectory() as temporary:
            host = Host(temporary)
            host.init_ledger()
            folder, manifest, _ = host.backup(rows_stream({1: "a"}))
            # An encrypted daily set is never sealed: the seal refuses before it writes anything.
            with self.assertRaisesRegex(audit.Refused, "encrypted daily backup is not sealed"):
                audit.seal(folder, host.parent, manifest)
            self.assertFalse((folder / audit.CHECKPOINT).exists())
            manifest = as_plaintext_set(folder)
            # Older sealed archives remain readable and retain their declared components.
            with patch.object(audit, 'evaluate', return_value=rows_stream({1: 'a'})):
                audit.seal(folder, host.parent, manifest)
            self.assertEqual(manifest["format"], 1)
            self.assertEqual(manifest["sha256"][audit.CHECKPOINT], ops.digest(folder / audit.CHECKPOINT))
            self.assertEqual(manifest["bytes"][audit.CHECKPOINT], (folder / audit.CHECKPOINT).stat().st_size)
            with patch.object(ops, "run"):
                ops.validate_backup(folder)
                kept = (folder / audit.CHECKPOINT).read_bytes()
                (folder / audit.CHECKPOINT).write_bytes(kept + b" ")
                with self.assertRaisesRegex(RuntimeError, "checksum mismatch"):
                    ops.validate_backup(folder)
                (folder / audit.CHECKPOINT).unlink()
                with self.assertRaisesRegex(RuntimeError, "checksum mismatch"):
                    ops.validate_backup(folder)
                # an older six-file backup (nothing declared) is unchanged, even with a stray undeclared file
                for field in ("sha256", "bytes"):
                    manifest[field].pop(audit.CHECKPOINT)
                ops.write_json(folder / "manifest.json", manifest)
                (folder / audit.CHECKPOINT).write_bytes(b"undeclared")
                ops.validate_backup(folder)






    def test_21_ob04_past_event_restores_verified_current_defect_restores_but_fails(self):
        """OB-04 (SE-05, SE-07, SE-14, RS-08, RS-09) [OP-3 (a)]."""
        with tempfile.TemporaryDirectory() as temporary:
            host = Host(temporary)
            host.init_ledger()
            host.legacy_backup(rows_stream({1: "a", 2: "b"}))
            # (1) a past event: a sealed row changed since the previous seal; this snapshot's own guard and shape are sound
            past, manifest, error = host.legacy_backup(rows_stream({1: "a", 2: "B"}))
            body = json.loads((past / audit.CHECKPOINT).read_text())
            self.assertEqual(body["previous_verification"]["state"], "failed")
            self.assertEqual((body["guard"]["state"], body["schema"]), ("present", []))
            self.assertTrue(manifest["complete"])
            self.assertEqual(manifest.get("backup_error"), {"stage": "audit integrity", "type": "AuditIntegrityMismatch"})
            self.assertIsNotNone(error)
            self.assertEqual(host.status(), ["backup_failed"])
            with patch.object(ops, "run"):
                ops.validate_backup(past)
            result, error, _, _ = host.rehearse(past, rows_stream({1: "a", 2: "B"}))
            self.assertIsNone(error)
            self.assertTrue(result["success"])
            self.assertTrue(result["audit"]["verified"])
            self.assertEqual(result["audit"]["previous_verification"]["state"], "failed")

            # (2) a current defect: this snapshot's own guard is ineffective (variant: an inheritance finding)
            for label, answer in (("guard", rows_stream({1: "a", 2: "B"}, guard=INEFFECTIVE)),
                                  ("inheritance", rows_stream({1: "a", 2: "B"}, schema=["inheritance"]))):
                with self.subTest(label):
                    current, manifest, error = host.legacy_backup(answer)
                    body = json.loads((current / audit.CHECKPOINT).read_text())
                    self.assertEqual((body["guard"], body["schema"]), (answer.guard, answer.schema))
                    self.assertEqual((manifest.get("backup_error") or {}).get("stage"), "audit integrity")
                    self.assertTrue(manifest["complete"])
                    self.assertIsNotNone(error)
                    self.assertEqual(host.status(), ["backup_failed"])
                    with patch.object(ops, "run"):
                        ops.validate_backup(current)
                    before = host.files(current)
                    result, error, _, cleanup = host.rehearse(current, answer)
                    self.assertIsNotNone(error)
                    self.assertFalse(result["success"])
                    self.assertFalse(result["audit"]["verified"])
                    self.assertEqual((result["audit"]["guard"], result["audit"]["schema"]), (answer.guard, answer.schema))
                    self.assertTrue(cleanup.called)
                    self.assertEqual(host.files(current), before, "the snapshot, its manifest and checkpoint are kept")

    def test_22_ob05_rehearse_verifies_the_export_of_its_own_restored_copy(self):
        """OB-05 (RS-01, RS-03, RS-07, RS-08, RS-09, RS-10)."""
        with tempfile.TemporaryDirectory() as temporary:
            host = Host(temporary)
            old, _, _ = host.backup(rows_stream({1: "a"}))            # no ledger: an unsealed snapshot
            result, error, _, _ = host.rehearse(old, rows_stream({1: "a"}))
            self.assertIsNone(error)
            self.assertEqual((result["success"], result["audit"]), (True, "not_sealed"))
            self.assertEqual(host.sources, [])

            host.init_ledger()
            host.legacy_backup(rows_stream({1: "a", 2: "b"}))
            verified, _, _ = host.legacy_backup(rows_stream({1: "a", 2: "b", 3: "c"}))
            past, manifest, _ = host.legacy_backup(rows_stream({1: "a", 2: "B", 3: "c"}))
            self.assertEqual((manifest.get("backup_error") or {}).get("stage"), "audit integrity")
            defect, manifest, _ = host.legacy_backup(rows_stream({1: "a", 2: "B", 3: "c"}, guard=INEFFECTIVE))
            self.assertEqual((manifest.get("backup_error") or {}).get("stage"), "audit integrity")
            cases = {"(a) verified": (verified, rows_stream({1: "a", 2: "b", 3: "c"}), True, "verified"),
                     "(b) past event": (past, rows_stream({1: "a", 2: "B", 3: "c"}), True, "failed"),
                     "(c) restored copy differs": (verified, rows_stream({1: "a", 2: "x", 3: "c"}), False, "verified"),
                     "(d) current guard defect": (defect, rows_stream({1: "a", 2: "B", 3: "c"}, guard=INEFFECTIVE),
                                                  False, "verified"),
                     "(e) input error": (verified, audit.InputError("synthetic export failure"), False, "verified")}
            for label, (folder, answer, success, previous) in cases.items():
                with self.subTest(label):
                    before = host.files(folder)
                    result, error, container, cleanup = host.rehearse(folder, answer)
                    self.assertEqual(len(host.sources), 1, "a sealed backup's rehearsal verifies its restored copy")
                    source = host.sources[0]
                    self.assertIsInstance(source, audit.DatabaseExport, "the restored copy, never the snapshot file")
                    self.assertEqual((source.container, source.database), (container, "kin"))
                    self.assertEqual(result["success"], success)
                    self.assertEqual(result["audit"]["verified"], success)
                    self.assertEqual(error is None, success)
                    self.assertTrue(cleanup.called)
                    self.assertEqual(result["cleanup_failures"], [])
                    self.assertEqual(host.files(folder), before)
                    if label.startswith("(e)"):
                        self.assertEqual(result["audit"]["exit"], 2)
                    else:
                        self.assertEqual(result["audit"]["previous_verification"]["state"], previous)
                    if label.startswith("(c)"):
                        self.assertEqual(result["audit"]["changed"]["ids"], [2])

    def test_23_ob04_an_unrecovered_declaration_is_a_past_event_that_restores_and_stays_reported(self):
        """OB-04 with SE-13 (RS-08, RT-13; S7-AUDIT-STORE-F01): a seal that stopped after its manifest declaration and
        does not continue the ledger makes the next backup alarm with a past event; that snapshot still restores verified,
        the backups after it are sealed without an alarm, and retention keeps reporting the unresolved declaration."""
        with tempfile.TemporaryDirectory() as temporary:
            host = Host(temporary)
            host.init_ledger()
            first, _, _ = host.legacy_backup(rows_stream({1: "a"}))
            ledger = (host.parent / audit.LEDGER).read_bytes()
            broken, _, _ = host.legacy_backup(rows_stream({1: "a", 2: "b"}))
            body = json.loads((broken / audit.CHECKPOINT).read_text())
            body["previous"] = {"backup": first.name, "sha256": "0" * 64, "seq": 1}
            (broken / audit.CHECKPOINT).write_text(json.dumps(body))
            manifest = json.loads((broken / "manifest.json").read_text())
            manifest["sha256"][audit.CHECKPOINT] = ops.digest(broken / audit.CHECKPOINT)
            manifest["bytes"][audit.CHECKPOINT] = (broken / audit.CHECKPOINT).stat().st_size
            ops.write_json(broken / "manifest.json", manifest)
            (host.parent / audit.LEDGER).write_bytes(ledger)        # the seal stopped before its ledger step

            rows = {1: "a", 2: "b", 3: "c"}
            past, manifest, error = host.legacy_backup(rows_stream(rows))
            body = json.loads((past / audit.CHECKPOINT).read_text())
            self.assertEqual(body["previous_verification"], {"state": "unverifiable", "reason": "uncommitted_checkpoint"})
            self.assertEqual((body["guard"]["state"], body["schema"]), ("present", []))
            self.assertEqual(manifest.get("backup_error"), {"stage": "audit integrity", "type": "AuditPreviousUnverifiable"})
            self.assertTrue(manifest["complete"])
            self.assertIsNotNone(error)
            self.assertEqual(host.status(), ["backup_failed"])
            # the snapshot itself is sound: its restored copy verifies and the rehearsal succeeds carrying the past event
            result, error, _, _ = host.rehearse(past, rows_stream(rows))
            self.assertIsNone(error)
            self.assertEqual((result["success"], result["audit"]["verified"]), (True, True))
            self.assertEqual(result["audit"]["previous_verification"]["state"], "unverifiable")

            # the backups after it are sealed and verified against the ledger without an alarm
            later, manifest, error = host.legacy_backup(rows_stream({**rows, 4: "d"}))
            self.assertIsNone(error)
            self.assertNotIn("backup_error", manifest)
            self.assertEqual(json.loads((later / audit.CHECKPOINT).read_text())["previous_verification"],
                             {"state": "verified"})
            self.assertEqual(host.status(), [])
            # and retention still reports the declaration the ledger never received
            output = io.StringIO()
            with contextlib.redirect_stdout(output):
                code = audit.main(["retention", str(host.parent),
                                   "--as-of", (host.clock + timedelta(minutes=1)).isoformat()])
            report = json.loads(output.getvalue())
            self.assertEqual((code, report["uncommitted"], report["latest"]), (1, [broken.name], later.name))

    def test_24_ob06_a_stalled_legacy_rehearsal_fails_within_the_time_limit(self):
        """The legacy archive's real exporter has a 3 s hang limit; cleanup releases the lock."""
        limit, grace = 3, 15
        with tempfile.TemporaryDirectory() as temporary:
            host = Host(temporary)
            host.init_ledger()
            fake = FakeDocker(temporary)
            self.addCleanup(fake.kill_all)
            real_evaluate, real_run, real_text = audit.evaluate, ops.run, ops.text

            def limited(source):
                # the verifier's own docker commands reach the fake CLI even where the flow's other commands are faked
                with patch.object(ops, "run", real_run), patch.object(ops, "text", real_text):
                    return real_evaluate(source, timeout=limit)

            rows = {1: "a", 2: "b"}
            fake.plan(answer=verifier_answer(rows))
            with fake.active():
                sealed, manifest, error = host.legacy_backup(limited)
            self.assertIsNone(error)
            self.assertNotIn("backup_error", manifest)
            self.assertIn(audit.CHECKPOINT, manifest["sha256"])
            self.assertEqual((fake.running(), fake.names("containers")), ([], []))

            def rehearse():
                with patch.object(sys, "argv", ["ops_backup.py", "rehearse", str(sealed)]):
                    ops.main()
            clusters = []

            def rehearsal_run(args, **kwargs):
                # This boundary test simulates provisioning and the catalog replay of the fresh cluster (D23) only; the
                # real verifier/exporter still hits FakeDocker and its watchdog. B L07/L19 exercise these statements on
                # PostgreSQL itself.
                if args[:3] == ["docker", "run", "-d"]:
                    clusters.append(DailyCluster(json.loads((sealed / "manifest.json").read_text(encoding="utf-8"))["role_catalog"]))
                if args[:2] == ["docker", "exec"] and "pg_restore" in args:
                    clusters[-1].observe(args, kwargs.get("input_file"))
                elif args[:2] == ["docker", "exec"] and ("mkdir" in args or "psql" in args):
                    clusters[-1].observe(args, kwargs.get("input_file"))
                    try:
                        answer = clusters[-1].text(args)
                    except AssertionError:
                        answer = ""
                    return SimpleNamespace(returncode=0, stdout=answer.encode(), stderr=b"")
                return real_run(args, **kwargs)
            for label, plan, success in (("sound", dict(answer=verifier_answer(rows)), True),
                                         ("the restored copy's export stalls", dict(exporter="stall"), False)):
                with self.subTest(label):
                    fake.plan(**plan)
                    earlier = set(sealed.glob("rehearsal-*.json"))
                    before = host.files(sealed)
                    with fake.active(), patch.object(ops, "ROOT", host.repo), patch.object(ops, "require_local_docker"), \
                            patch.object(ops, "run", side_effect=rehearsal_run), \
                            patch.object(ops, "emr_catalog", return_value={"synthetic": "catalog"}), \
                            patch.object(ops, "restored_emr_expiry", return_value=expiry_receipt()), \
                            patch.object(ops, "counts", return_value={"public.Report": 5}), \
                            patch.object(ops, "temporary_run", side_effect=host.fake_archive), \
                            patch.object(audit, "evaluate", side_effect=limited), \
                            contextlib.redirect_stdout(io.StringIO()):
                        outcome, elapsed, finished = fake.bounded(rehearse, limit + grace)
                    self.assertTrue(finished, "the rehearsal was still running after its limit and a bounded stop")
                    self.assertEqual(isinstance(outcome.get("error"), RuntimeError), not success, outcome)
                    (written,) = set(sealed.glob("rehearsal-*.json")) - earlier
                    result = json.loads(written.read_text())
                    self.assertEqual((result["success"], result["audit"]["verified"]), (success, success))
                    if not success:
                        self.assertEqual(result["audit"]["exit"], 2)
                        proof = result["audit"]["cleanup"]
                        self.assertTrue(proof["confirmed"], proof)
                        self.assertTrue(proof["steps"]["remote"]["confirmed"], "the restored copy's export was ended")
                        # D23: the restored copy is a cluster whose bootstrap superuser is kin (the catalog replay).
                        self.assertEqual((proof["target"]["database"], proof["target"]["role"]), ("kin", "kin"))
                    self.assertEqual(result["cleanup_failures"], [])
                    self.assertFalse((host.repo / ".kin-ops.lock").exists(), "the operations lock is released")
                    self.assertEqual(fake.running(), [])
                    self.assertEqual((fake.names("containers"), fake.names("volumes")), ([], []))
                    self.assertEqual(host.files(sealed), before)


class EmrRestoreVerification(unittest.TestCase):
    """REQ-EMR-19/20 -> RISK-EMR-LOSS/PRIVILEGE -> TEST-EMR-B-F09.

    Exercise the real backup validation and rehearsal verdict with file corruption and observed catalog differences.
    Only Docker/catalog and ledger IO are synthetic here; L19 verifies the same flow with real PostgreSQL and state.
    Audit-only scratch databases may ignore physical placement; the deployment rehearsal must never do so.
    """

    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.host = Host(temporary.name)
        self.host.catalog = {
            "schema": {"owner": "kin_emr_owner", "acl": "kin_runtime=U/kin_emr_owner"},
            "roles": [{"rolname": name, "rolsuper": False, "rolcanlogin": name != "kin_emr_owner"}
                      for name in ("kin_emr_owner", "kin_runtime", "kin_emr_reader", "kin_emr_retention")],
            "memberships": None,
            "tablespace": {"name": "kin_emr_access", "owner": "kin_emr_owner", "acl": None},
            "tables": [{"name": "member_identity", "owner": "kin_emr_owner", "acl": None,
                        "tablespace": "kin_emr_access"}],
            "functions": [{"signature": "emr_access.append_access(text)", "owner": "kin_emr_owner",
                           "acl": "kin_runtime=X/kin_emr_owner", "security_definer": True,
                           "configuration": ["search_path=pg_catalog, emr_access"]}],
        }
        self.host.init_ledger()
        self.answer = rows_stream({1: "synthetic-audit"})
        self.folder, self.manifest, error = self.host.backup(self.answer)
        self.assertIsNone(error)

    def assert_restore_refused(self):
        before = self.host.files(self.folder)
        result, error, _, cleanup = self.host.rehearse(self.folder, self.answer)
        self.assertIsInstance(error, RuntimeError)
        self.assertFalse(result["success"])
        self.assertEqual(result["cleanup_failures"], [])
        self.assertEqual(cleanup.call_count, 3)
        self.assertEqual(self.host.files(self.folder), before)

    def test_b_layout_and_same_pause_components_restore(self):
        self.assertTrue(self.manifest["emr"]["same_pause"])
        self.assertTrue(set(ops.EMR_FILES).issubset(self.manifest["sha256"]))
        result, error, _, cleanup = self.host.rehearse(self.folder, self.answer)
        self.assertIsNone(error)
        self.assertTrue(result["success"])
        self.assertEqual(result["emr"], {"owner_acl_preserved": True, "database_state_verified": True,
                                          "expiry_sweep": self.host.restored_expiry})
        self.assertEqual(result["audit"], "not_sealed")
        self.assertEqual(cleanup.call_count, 3)

    def test_d1796_unknown_history_is_counted_without_blocking_restore(self):
        self.host.restored_expiry = {**expiry_receipt(), "historyRetainedUnknownLifetime": 1}
        before = self.host.files(self.folder)
        result, error, _, cleanup = self.host.rehearse(self.folder, self.answer)
        self.assertIsNone(error)
        self.assertTrue(result["success"])
        self.assertEqual(result["emr"]["expiry_sweep"], self.host.restored_expiry)
        self.assertEqual(self.host.files(self.folder), before)
        self.assertEqual(cleanup.call_count, 3)

    def test_d1796_sweep_must_run_before_restored_business_readiness(self):
        self.host.restored_expiry = {**expiry_receipt(), "ran": False}
        self.assert_restore_refused()

    def test_tampered_and_partial_components_refuse_before_restore(self):
        for name in ("kin.dump", *ops.EMR_FILES):
            path = self.folder / name
            original = path.read_bytes()
            for missing in (False, True):
                with self.subTest(component=name, missing=missing):
                    try:
                        if missing:
                            path.unlink()
                        else:
                            path.write_bytes(original + b"tampered")
                        with patch.object(ops, "run") as docker_boundary:
                            with self.assertRaises(RuntimeError):
                                ops.validate_backup(self.folder)
                            docker_boundary.assert_not_called()
                    finally:
                        path.write_bytes(original)

    def test_missing_or_moved_tablespace_refused(self):
        for missing in (False, True):
            with self.subTest(missing=missing):
                changed = copy.deepcopy(self.host.catalog)
                if missing:
                    changed["tablespace"] = None
                else:
                    changed["tables"][0]["tablespace"] = None
                self.host.restored_catalog = changed
                self.assert_restore_refused()

    def test_wrong_owner_refused(self):
        for field in ("schema", "tablespace", "tables", "functions"):
            with self.subTest(field=field):
                changed = copy.deepcopy(self.host.catalog)
                item = changed[field][0] if isinstance(changed[field], list) else changed[field]
                item["owner"] = "kin_runtime"
                self.host.restored_catalog = changed
                self.assert_restore_refused()

    def test_changed_acl_refused(self):
        changed = copy.deepcopy(self.host.catalog)
        changed["tables"][0]["acl"] = "kin_runtime=arwdDxt/kin_emr_owner"
        self.host.restored_catalog = changed
        self.assert_restore_refused()

    def test_changed_roles_refused(self):
        changed = copy.deepcopy(self.host.catalog)
        changed["roles"][0]["rolcanlogin"] = True
        self.host.restored_catalog = changed
        self.assert_restore_refused()

    def test_database_external_state_disagreement_refused(self):
        self.host.restore_answer = "unverified"
        self.assert_restore_refused()

    def test_unattested_pause_refused(self):
        self.manifest["emr"]["same_pause"] = False
        (self.folder / "manifest.json").write_text(json.dumps(self.manifest), encoding="utf-8")
        with patch.object(ops, "run") as docker_boundary:
            with self.assertRaises(RuntimeError):
                ops.rehearse(self.folder)
            docker_boundary.assert_not_called()

    def test_missing_state_volume_refuses_before_pause_or_dump(self):
        api = next(item for item in self.host.info if item['Name'] == '/kin-api')
        api['Mounts'] = [mount for mount in api['Mounts'] if mount['Destination'] != ops.EMR_STATE]
        before = set(self.host.parent.iterdir())
        with patch.object(ops, 'ROOT', self.host.repo), patch.object(ops, 'text', side_effect=self.host.fake_text), \
                patch.object(ops, 'run') as commands, patch.object(ops, 'temporary_run') as helpers:
            with self.assertRaisesRegex(RuntimeError, 'Expected one named EMR state volume'):
                ops.backup(self.host.parent)
            commands.assert_not_called()
            helpers.assert_not_called()
        self.assertEqual(set(self.host.parent.iterdir()), before)

    def test_connected_database_client_refuses_dump_and_resumes_writers(self):
        original = self.host.fake_text
        def connected(args, **kwargs):
            return '1' if 'pg_stat_activity' in ' '.join(args) else original(args, **kwargs)
        self.host.events.clear()
        with patch.object(self.host, 'fake_text', side_effect=connected):
            _, manifest, error = self.host.backup(self.answer)
        self.assertIsInstance(error, RuntimeError)
        self.assertIn('Database clients remain', str(error))
        self.assertFalse(manifest['complete'])
        commands = [event[1] for event in self.host.events if event[0] == 'command']
        self.assertFalse(any('pg_dump' in command or 'pg_dumpall' in command for command in commands))
        resumed = [name for command in commands if command[:2] == ['docker', 'start'] for name in command[2:]]
        self.assertCountEqual(resumed, ops.CONTAINERS[:-1])

    def test_d23_a_daily_set_is_rehearsed_by_the_catalog_replay_and_refuses_a_differing_restore(self):
        """D23: a daily EMR set records the cluster's role catalog inside the writer pause; its rehearsal starts a cluster
        whose bootstrap superuser is kin, replays the roles and memberships from that catalog (never pg_dumpall's
        GRANTED BY statements as postgres), compares the restored role catalog and verifies the seal as kin. A restore
        whose catalog differs is refused."""
        self.assertNotIn("role_catalog", self.manifest, "role and database comments and settings stay sealed")
        self.assertEqual(sealed_metadata(self.folder)["role_catalog"], daily_role_catalog())
        kinds =[" ".join(event[1][:2]) if event[0] == "command" else event[0] for event in self.host.events]
        read = next(index for index, event in enumerate(self.host.events) if event[0] == "command" and ops.ROLE_CATALOG_SQL in event[1])
        self.assertLess(kinds.index("docker stop"), read)
        self.assertLess(read, kinds.index("docker start"), "the role catalog is read inside the writer pause")
        result, error, _, cleanup = self.host.rehearse(self.folder, self.answer)
        self.assertIsNone(error, error)
        self.assertTrue(result["success"])
        self.assertEqual(result["audit"], "not_sealed")
        self.assertEqual((result["roles"], result["catalog"]["catalog"]), ("catalog replay", "equal"))
        commands = [event[1] for event in self.host.events if event[0] == "command"]
        started = next(command for command in commands if command[:3] == ["docker", "run", "-d"])
        self.assertIn("POSTGRES_USER=kin", started)
        self.assertFalse(any("-U" in command and command[command.index("-U") + 1] == "postgres" for command in commands),
                         "nothing runs as postgres in the rehearsal cluster")
        self.assertEqual(self.host.cluster.memberships, daily_role_catalog()["memberships"])
        self.assertFalse(any("GRANTED BY" in sql for sql in self.host.cluster.statements))
        changed = daily_role_catalog()
        changed["databases"][1]["acl"] = ["=Tc/kin", "kin=CTc/kin"]
        self.host.restored_role_catalog = changed
        result, error, _, _ = self.host.rehearse(self.folder, self.answer)
        self.assertIsInstance(error, RuntimeError)
        self.assertIn("Restored catalog differs from the snapshot: databases", str(error))
        self.assertFalse(result["success"])

    def test_f_link_12_daily_rehearsal_counts_audit_and_image_rows(self):
        for table in ("emr_audit.fixed_copy", "emr_image.preparation"):
            self.host.table_counts[table] = 1
        folder, manifest, error = self.host.backup(self.answer)
        self.assertIsNone(error)
        self.assertIn("role_catalog", sealed_metadata(folder))
        for table in ("emr_audit.fixed_copy", "emr_image.preparation"):
            self.assertEqual(manifest["counts"]["kin"][table], 1)
            self.host.table_counts[table] = 0
            result, error, _, _ = self.host.rehearse(folder, self.answer)
            self.assertIn("row counts differ", str(error))
            self.assertFalse(result["success"])
            self.host.table_counts[table] = 1

    def test_d23_an_older_daily_set_without_a_role_catalog_keeps_its_previous_rehearsal(self):
        """D23: a set made before the role catalog was recorded is rehearsed as before (pg_dumpall roles as postgres)."""
        manifest = as_plaintext_set(self.folder)
        manifest.pop("role_catalog")
        ops.write_json(self.folder / "manifest.json", manifest)
        result, error, _, _ = self.host.rehearse(self.folder, self.answer)
        self.assertIsNone(error, error)
        self.assertTrue(result["success"])
        commands = [event[1] for event in self.host.events if event[0] == "command"]
        started = next(command for command in commands if command[:3] == ["docker", "run", "-d"])
        self.assertNotIn("POSTGRES_USER=kin", started)
        self.assertTrue(any(command[:3] == ["docker", "exec", "-i"] and "psql" in command and command[command.index("-U") + 1] == "postgres"
                            for command in commands))

    def test_r5_02_a_database_outside_the_daily_set_is_named_and_the_set_still_compared(self):
        """R5-02 (PR #175 CI emr-b, live L19): a daily set dumps kin and keycloak only, so a further database of the
        source cluster (L19's cluster still holds L06's l06_tampered) and a setting scoped to it are outside the set: the
        rehearsal names it instead of refusing a complete set, and replays and compares everything the set holds. A
        restore that yields a database the set does not hold, or whose kin ACL differs, is still refused; a held
        (whole-cluster) capture still refuses the further database."""
        def outside_database(name):
            return {"name": name, "owner": "kin", "acl": ["=Tc/kin", "kin=CTc/kin"], "attributes": {"datistemplate": False, "datallowconn": True}}
        captured = daily_role_catalog()
        captured["databases"] = sorted([*captured["databases"], outside_database("l06_tampered")], key=lambda item: item["name"])
        captured["settings"] = [{"database": "kin", "role": None, "config": ["work_mem=8MB"]},
                                {"database": "l06_tampered", "role": None, "config": ["work_mem=4MB"]}]
        self.host.role_catalog = captured
        folder, manifest, error = self.host.backup(self.answer)
        self.assertIsNone(error, error)
        self.assertEqual(sealed_metadata(folder)["role_catalog"], captured, "the manifest keeps the cluster as captured")
        result, error, _, _ = self.host.rehearse(folder, self.answer)
        self.assertIsNone(error, error)
        self.assertTrue(result["success"])
        self.assertEqual(result["audit"], "not_sealed")
        self.assertEqual((result["databases_outside_set"], result["catalog"]["catalog"]), (["l06_tampered"], "equal"))
        replayed = "".join(self.host.cluster.statements)
        self.assertIn('ALTER ROLE ALL IN DATABASE "kin" SET "work_mem" TO', replayed)
        self.assertNotIn("l06_tampered", replayed)
        in_set = copy.deepcopy(captured)
        in_set["databases"] = [item for item in in_set["databases"] if item["name"] != "l06_tampered"]
        in_set["settings"] = in_set["settings"][:1]
        extra_restored = copy.deepcopy(in_set)
        extra_restored["databases"] = sorted([*extra_restored["databases"], outside_database("kin_scratch")], key=lambda item: item["name"])
        acl_changed = copy.deepcopy(in_set)
        next(item for item in acl_changed["databases"] if item["name"] == "kin")["acl"] = ["=Tc/kin", "kin=CTc/kin"]
        for label, restored in (("a database the set does not hold", extra_restored), ("kin's ACL", acl_changed)):
            with self.subTest(restored=label):
                self.host.restored_role_catalog = restored
                result, error, _, _ = self.host.rehearse(folder, self.answer)
                self.assertIsInstance(error, RuntimeError)
                self.assertIn("Restored catalog differs from the snapshot: databases", str(error))
                self.assertFalse(result["success"])
        with self.assertRaisesRegex(ops.RestoreAdmissionError, "the databases are not exactly kin and keycloak"):
            ops.supported_catalog(captured, shape="post")

    def test_unsafe_emr_archive_refused_despite_matching_checksum(self):
        cases = [('../outside', tarfile.REGTYPE), ('/absolute', tarfile.REGTYPE),
                 ('seal/link', tarfile.SYMTYPE), ('seal/device', tarfile.CHRTYPE)]

        def unsafe(name, kind):
            stream = io.BytesIO()
            with tarfile.open(fileobj=stream, mode='w:gz') as archive:
                entry = tarfile.TarInfo(name)
                entry.type = kind
                entry.linkname = '../outside' if kind == tarfile.SYMTYPE else ''
                archive.addfile(entry)
            return stream.getvalue()
        with ops.opened_set(self.folder) as opened:
            safe = (opened.path / 'emr-state.tgz').read_bytes()
        # An encrypted set whose key holder sealed an unsafe archive: refused after decryption, before any restore.
        for name, kind in cases:
            with self.subTest(encrypted=name):
                reseal(self.folder, {'emr-state.tgz': unsafe(name, kind)})
                with patch.object(ops, 'run') as commands:
                    with self.assertRaisesRegex(RuntimeError, 'Unsafe EMR archive entry'):
                        ops.validate_backup(self.folder)
                    commands.assert_not_called()
        # A set written before encryption: its stored archive is checked as before.
        reseal(self.folder, {'emr-state.tgz': safe})
        self.manifest = as_plaintext_set(self.folder)
        archive_path = self.folder / 'emr-state.tgz'
        for name, kind in cases:
            with self.subTest(name=name):
                archive_path.write_bytes(unsafe(name, kind))
                self.manifest['sha256']['emr-state.tgz'] = ops.digest(archive_path)
                self.manifest['bytes']['emr-state.tgz'] = archive_path.stat().st_size
                ops.write_json(self.folder / 'manifest.json', self.manifest)
                with patch.object(ops, 'run') as commands:
                    with self.assertRaisesRegex(RuntimeError, 'Unsafe EMR archive entry'):
                        ops.validate_backup(self.folder)
                    commands.assert_not_called()


class BackupEncryptionTests(unittest.TestCase):
    """Every new daily set is encrypted; a set written before encryption is still restored as it is; whatever is wrong
    with an encrypted set (key, record, components) refuses before any restore target exists."""

    def setUp(self):
        self.temp = self.enterContext(tempfile.TemporaryDirectory())
        self.keys = Path(self.temp) / "keys"
        self.config = write_encryption_config(self.keys, ("key-a",))
        self.enterContext(patch.dict(os.environ, {"KIN_BACKUP_ENCRYPTION": str(self.config)}))
        self.host = Host(self.temp)
        self.answer = rows_stream({1: "a"})

    def backup(self):
        folder, manifest, error = self.host.backup(self.answer)
        self.assertIsNone(error, error)
        self.assertTrue(manifest["complete"])
        return folder, manifest

    def refused_before_restore(self, folder, pattern, **options):
        refused_before_restore(self, folder, pattern, self.keys / "open", **options)

    def test_a_new_set_holds_no_plaintext_and_restores_like_a_set_written_before_encryption(self):
        folder, manifest = self.backup()
        self.assertEqual(manifest["encryption"]["key_id"], "key-a")
        self.assertNotIn("role_catalog", manifest)
        secrets = [b"synthetic-fixture", b"synthetic-runtime", b"fixture dump", b"TEST_ONLY=placeholder"]
        for path in folder.iterdir():
            data = path.read_bytes()
            self.assertFalse(any(secret in data for secret in secrets), path.name)
            if path.name != "manifest.json":
                self.assertTrue(data.startswith(ops.AGE_HEADER), path.name)
        self.assertEqual(self.host.status(), [])
        result, error, _, _ = self.host.rehearse(folder, self.answer)
        self.assertIsNone(error, error)
        self.assertTrue(result["success"])
        self.assertEqual((result["backup"], result["encryption"]), (folder.name, "key-a"))
        self.assertEqual(list((self.keys / "open").iterdir()), [], "the opened plaintext is removed")
        # The same snapshot as a backup written before encryption left it: restored as before, without any key.
        plain = folder.parent / ("20000101-000000-" + folder.name[-8:])
        shutil.copytree(folder, plain)
        for item in plain.glob("rehearsal-*.json"):
            item.unlink()
        as_plaintext_set(plain)
        self.config.unlink()
        result, error, _, _ = self.host.rehearse(plain, self.answer)
        self.assertIsNone(error, error)
        self.assertTrue(result["success"])
        self.assertEqual(result["encryption"], "none")
        self.refused_before_restore(folder, "configuration is missing")

    def test_a_wrong_or_missing_key_refuses_before_anything_is_opened_or_restored(self):
        folder, _ = self.backup()
        other = write_encryption_config(Path(self.temp) / "other-keys", ("key-a",))
        body = json.loads(self.config.read_text())
        body["files"]["key-a"] = json.loads(other.read_text())["files"]["key-a"]
        self.config.write_text(json.dumps(body))
        self.refused_before_restore(folder, "key does not match this set")
        self.refused_before_restore(folder, "key does not match this set", identity=json.loads(other.read_text())["files"]["key-a"])
        body["files"] = {"key-b": body["files"]["key-a"]}
        body["current"] = "key-b"
        self.config.write_text(json.dumps(body))
        self.refused_before_restore(folder, "No backup key is configured for this set's key ID key-a")

    def test_a_changed_record_or_component_refuses_before_restore(self):
        folder, manifest = self.backup()
        original = copy.deepcopy(manifest)
        changes = {
            "an image the restore would use": lambda m: m["running_images"]["kin-api"].update(id="sha256:" + "b" * 64),
            "the recorded row counts": lambda m: m["counts"]["kin"].update({"public.Report": 6}),
            "the custody locator": lambda m: m.update(wrapping_custody={"directory": "/elsewhere", "files": {}}),
            "a plaintext role catalog beside the record": lambda m: m.update(role_catalog=daily_role_catalog()),
            "the key ID": lambda m: m["encryption"].update(key_id="key-b"),
            "an unknown format": lambda m: m["encryption"].update(format="kin-backup-age-v2"),
            "a removed record": lambda m: m.pop("encryption"),
        }
        for label, change in changes.items():
            with self.subTest(label):
                changed = copy.deepcopy(original)
                change(changed)
                ops.write_json(folder / "manifest.json", changed)
                with patch.object(ops, "run") as run, patch.object(ops, "temporary_run") as helper:
                    with self.assertRaises(RuntimeError):
                        ops.rehearse(folder)
                self.assertEqual((run.call_args_list, helper.call_args_list), ([], []))
        ops.write_json(folder / "manifest.json", original)
        # A component swapped, truncated, extended or removed on disk: its stored digest refuses it first.
        stored = {name: (folder / name).read_bytes() for name in original["sha256"]}
        for label, files in {"swapped": {"kin.dump": stored["keycloak.dump"], "keycloak.dump": stored["kin.dump"]},
                             "truncated": {"orthanc.tgz": stored["orthanc.tgz"][:-20]},
                             "trailing bytes": {"emr-state.tgz": stored["emr-state.tgz"] + b"\0"}}.items():
            with self.subTest(label):
                for name, data in files.items():
                    (folder / name).write_bytes(data)
                self.refused_before_restore(folder, "checksum mismatch")
                for name, data in stored.items():
                    (folder / name).write_bytes(data)
        (folder / ".env").unlink()
        self.refused_before_restore(folder, "checksum mismatch: .env")
        (folder / ".env").write_bytes(stored[".env"])
        # Stored bytes that match an authentic record but do not decrypt to the sealed plaintext (only the key holder can
        # write such a set): refused after decryption, the workspace removed, still before any restore.
        key = ops.backup_key("key-a")
        (folder / "kin.dump").unlink()
        with ops.SealedComponent(folder / "kin.dump", key) as sink:
            sink.write(b"another dump")
        changed = copy.deepcopy(original)
        changed["sha256"]["kin.dump"], changed["bytes"]["kin.dump"] = ops.digest(folder / "kin.dump"), (folder / "kin.dump").stat().st_size
        changed["encryption"]["auth"] = ops.manifest_auth(changed, key)
        ops.write_json(folder / "manifest.json", changed)
        self.refused_before_restore(folder, "did not decrypt to its recorded content: kin.dump")

    def test_the_backup_refuses_before_stopping_writers_without_a_usable_key(self):
        """And the deployment preflight says of each key what the backup does with it: `configured` only for the key
        the backup accepts, judged for the actual backup root and checkout."""
        def reported(*root):
            with patch.object(ops, "ROOT", self.host.repo):
                return preflight.backup_key_state(*root)
        self.assertEqual(reported(self.host.parent), "configured")
        self.assertEqual(reported(), "unknown", "without the backup root nothing is said for the backup")
        self.backup()
        body = json.loads(self.config.read_text())
        broken = {
            "configuration missing": None,
            "key file missing": {**body, "files": {"key-a": str(self.keys / "absent.key")}},
            "not an age identity": {**body, "files": {"key-a": str(self.config)}},
            "an identity whose checksum is wrong": {**body, "files": {"key-a": str(self.keys / "mistyped.key")}},
            "key inside the backup root": {**body, "files": {"key-a": str(self.host.parent / "key-a.key")}},
            "key inside the checkout": {**body, "files": {"key-a": str(self.host.repo / "key-a.key")}},
            "age program missing": {**body, "age": str(self.keys / "no-age")},
        }
        (self.keys / "mistyped.key").write_text("AGE-SECRET-KEY-1" + "Q" * 58 + "\n")
        for inside in (self.host.parent, self.host.repo):
            shutil.copyfile(body["files"]["key-a"], inside / "key-a.key")
        for label, config in broken.items():
            with self.subTest(label):
                if config is None:
                    self.config.unlink(missing_ok=True)
                else:
                    self.config.write_text(json.dumps(config))
                self.host.events.clear()
                before = set(self.host.parent.iterdir())
                with patch.object(ops, "ROOT", self.host.repo), patch.object(ops, "text", side_effect=self.host.fake_text), \
                        patch.object(ops, "run", side_effect=self.host.fake_run):
                    with self.assertRaises(ops.BackupEncryptionError):
                        ops.backup(self.host.parent)
                self.assertEqual(self.host.events, [], "no Docker command, no writer stopped")
                self.assertEqual(set(self.host.parent.iterdir()), before)
                self.assertEqual(reported(self.host.parent), "absent" if config is None else "invalid")

    def test_a_set_opened_directly_is_admitted_like_a_validated_one(self):
        """A caller that restores from a set it opens itself (opened_set alone) gets nothing from a set that lost or
        changed a component: no opened folder, no workspace folder, no command."""
        folder, _ = self.backup()
        plain = folder.parent / ("20000101-000000-" + folder.name[-8:])
        shutil.copytree(folder, plain)
        as_plaintext_set(plain)

        def refused(directory, pattern):
            with patch.object(ops, "run") as run, patch.object(ops, "temporary_run") as helper:
                with self.assertRaisesRegex(RuntimeError, pattern):
                    with ops.opened_set(directory):
                        self.fail("the set was opened")
            self.assertEqual((run.call_args_list, helper.call_args_list, list((self.keys / "open").iterdir())), ([], [], []))
        # A set written before encryption: a component of the same length with other content, then a lost one.
        original = (plain / "kin.dump").read_bytes()
        (plain / "kin.dump").write_bytes(bytes(byte ^ 1 for byte in original))
        refused(plain, "checksum mismatch: kin.dump")
        (plain / "kin.dump").unlink()
        refused(plain, "checksum mismatch: kin.dump")
        (plain / "kin.dump").write_bytes(original)
        with ops.opened_set(plain) as opened:
            self.assertEqual((opened.path, opened.manifest), (plain.resolve(), opened.stored))
        # An encrypted set that lost a component file while its manifest stayed as written.
        (folder / "emr-state.tgz").unlink()
        refused(folder, "checksum mismatch: emr-state.tgz")

    def test_a_removed_record_is_seen_in_the_sets_own_folder_whatever_the_manifest_lists(self):
        earlier, _ = self.backup()
        folder, manifest = self.backup()
        for label, listed in (("no name left", []), ("names of files that are not there", ["notes.txt"])):
            changed = {name: value for name, value in manifest.items() if name != "encryption"}
            changed["sha256"], changed["bytes"] = {name: "0" * 64 for name in listed}, {name: 1 for name in listed}
            ops.write_json(folder / "manifest.json", changed)
            with self.subTest(label):
                self.refused_before_restore(folder, "Encrypted components without an encryption record")
                with self.assertRaisesRegex(ops.BackupEncryptionError, "without an encryption record"):
                    ops.stored_encryption(folder, changed)
                with patch.object(ops, "ROOT", self.host.repo):
                    result = ops.rotate(self.host.parent, 1, dry_run=True)
                self.assertIn("encryption record missing", result["incomplete"][folder.name])
                self.assertEqual((result["generations"], result["would_delete"]), ([earlier.name], []),
                                 "the older set that can be restored stays the kept generation")

    def test_an_encryption_failure_leaves_an_incomplete_set_without_plaintext_and_resumes_writers(self):
        class Failing(ops.SealedComponent):
            def __enter__(self):
                sink = super().__enter__()
                if self.path.name == "orthanc.tgz":
                    self.process.kill()
                return sink
        with patch.object(ops, "SealedComponent", Failing):
            folder, manifest, error = self.host.backup(self.answer)
        self.assertIsInstance(error, ops.BackupEncryptionError)
        self.assertFalse(manifest["complete"])
        self.assertEqual(manifest["backup_error"]["stage"], "archive Orthanc")
        self.assertFalse((folder / "orthanc.tgz").exists())
        for path in folder.iterdir():
            if path.name != "manifest.json":
                self.assertTrue(path.read_bytes().startswith(ops.AGE_HEADER), path.name)
        commands = [event[1] for event in self.host.events if event[0] == "command"]
        self.assertCountEqual([name for command in commands if command[:2] == ["docker", "start"] for name in command[2:]],
                              ops.CONTAINERS[:-1])
        with self.assertRaisesRegex(RuntimeError, "incomplete"):
            ops.validate_backup(folder)

    def test_rotated_keys_open_their_own_sets_and_a_key_kept_elsewhere_opens_an_old_set(self):
        first, _ = self.backup()
        self.config = write_encryption_config(self.keys, ("key-a", "key-b"), current="key-b")
        second, manifest = self.backup()
        self.assertEqual(manifest["encryption"]["key_id"], "key-b")
        for folder, key_id in ((first, "key-a"), (second, "key-b")):
            result, error, _, _ = self.host.rehearse(folder, self.answer)
            self.assertIsNone(error, error)
            self.assertEqual((result["success"], result["encryption"]), (True, key_id))
        body = json.loads(self.config.read_text())
        kept = Path(self.temp) / "offsite" / "key-a.key"
        kept.parent.mkdir()
        shutil.move(body["files"].pop("key-a"), kept)
        self.config.write_text(json.dumps(body))
        self.refused_before_restore(first, "No backup key is configured for this set's key ID key-a")
        result, error, _, _ = self.host.rehearse(first, self.answer, identity=str(kept))
        self.assertIsNone(error, error)
        self.assertEqual((result["success"], result["encryption"]), (True, "key-a"))

    def test_the_opening_workspace_is_required_and_kept_apart_from_the_backups(self):
        folder, _ = self.backup()
        body = json.loads(self.config.read_text())
        body.pop("workspace")
        self.config.write_text(json.dumps(body))
        self.refused_before_restore(folder, "needs an existing workspace")
        self.refused_before_restore(folder, "outside the repository and the backup root", workspace=str(self.host.parent))

    def test_rotation_keeps_older_sets_when_a_new_set_is_not_authentic(self):
        folders = [self.backup()[0] for _ in range(3)]
        manifest = json.loads((folders[-1] / "manifest.json").read_text())
        manifest["counts"]["kin"]["public.Report"] = 99
        ops.write_json(folders[-1] / "manifest.json", manifest)
        with patch.object(ops, "ROOT", self.host.repo), patch.object(ops, "datetime", type("Clock", (datetime,), {"now": staticmethod(self.host.now)})):
            result = ops.rotate(self.host.parent, 1, dry_run=True)
        self.assertIn("not authentic", result["incomplete"][folders[-1].name])
        self.assertEqual(result["generations"], [folders[1].name])
        self.assertNotIn(folders[-1].name, result["would_delete"])

    def test_rotation_never_counts_age_files_whose_record_was_removed(self):
        folders = [self.backup()[0] for _ in range(2)]
        manifest = json.loads((folders[-1] / "manifest.json").read_text())
        manifest.pop("encryption")
        ops.write_json(folders[-1] / "manifest.json", manifest)
        with patch.object(ops, "ROOT", self.host.repo):
            result = ops.rotate(self.host.parent, 1, dry_run=True)
        self.assertIn("encryption record missing", result["incomplete"][folders[-1].name])
        self.assertEqual((result["generations"], result["would_delete"]), ([folders[0].name], []))
        self.refused_before_restore(folders[-1], "Encrypted components without an encryption record")

    def test_custody_restore_of_an_encrypted_set_needs_its_authentic_manifest(self):
        folder, manifest = self.backup()
        changed = copy.deepcopy(manifest)
        changed["wrapping_custody"] = {"directory": str(Path(self.temp) / "elsewhere"), "files": {"wrap-1": {"file": "wrap-0.key", "sha256": "0" * 64, "bytes": 32}}}
        ops.write_json(folder / "manifest.json", changed)
        destination = Path(self.temp) / "restored-custody"
        with patch.object(sys, "argv", ["ops_backup.py", "restore-wrapping", str(folder), "--destination", str(destination)]):
            with self.assertRaisesRegex(ops.BackupEncryptionError, "does not match this set, or its manifest was changed"):
                ops.main()
        self.assertFalse(destination.exists())

    def test_a_set_whose_writers_did_not_resume_is_not_ready_but_restores(self):
        original = self.host.fake_run

        def failing_start(args, **kwargs):
            if list(args[:3]) == ["docker", "start", "kin-api"]:
                raise RuntimeError("simulated start failure")
            return original(args, **kwargs)
        with patch.object(self.host, "fake_run", side_effect=failing_start):
            folder, manifest, error = self.host.backup(self.answer)
        self.assertIn("need recovery", str(error))
        self.assertEqual((manifest["complete"], manifest["ready"], manifest["resume_failures"]), (True, False, ["kin-api"]))
        result, error, _, _ = self.host.rehearse(folder, self.answer)
        self.assertIsNone(error, error)
        self.assertTrue(result["success"])

    def test_a_caller_that_keeps_a_set_open_rehearses_it_without_opening_it_again(self):
        """A rollback opens its B once and restores from it: its rehearsal uses that opening (one set's workspace)."""
        folder, manifest = self.backup()
        workspace = self.keys / "open"
        with ops.opened_set(folder) as opened:
            held = set(workspace.iterdir())
            self.assertEqual(len(held), 1)
            with patch.object(ops, "opened_set", side_effect=AssertionError("opened a second time")), \
                    patch.object(ops, "rehearse", side_effect=lambda directory, **options: ops.rehearse_opened(opened, manifest)):
                result, error, _, _ = self.host.rehearse(folder, self.answer)
            self.assertIsNone(error, error)
            self.assertTrue(result["success"])
            self.assertEqual((result["backup"], result["encryption"]), (folder.name, "key-a"))
            self.assertEqual(set(workspace.iterdir()), held)
        self.assertEqual(list(workspace.iterdir()), [])

    @unittest.skipUnless(os.name == "posix", "POSIX execute permission")
    def test_an_age_program_that_cannot_run_is_unusable(self):
        program = self.keys / "age-not-executable"
        shutil.copyfile(age_program(), program)
        program.chmod(0o600)
        body = json.loads(self.config.read_text())
        self.config.write_text(json.dumps({**body, "age": str(program)}))
        with self.assertRaisesRegex(ops.BackupEncryptionError, "age program is unavailable"):
            ops.backup_key()

    def test_the_audit_verifier_compares_an_external_checkpoint_with_the_plaintext_dump(self):
        folder, manifest = self.backup()
        with ops.opened_set(folder) as opened:
            expected = opened.manifest["sha256"]["kin.dump"]
        seen = []
        def verify(checkpoint, source):
            seen.append((source.sha256, Path(source.path).read_bytes()[:12], folder in Path(source.path).parents))
            return 0, {"exit": 0}
        checkpoint = Path(self.temp) / "external-checkpoint.json"
        checkpoint.write_text("{}")
        with patch.object(audit, "verify", side_effect=verify):
            self.assertEqual(audit.verify_backup(folder, checkpoint)[0], 0)
            self.assertEqual(audit.verify_backup(folder)[0], 2)
            # A set that lost a component is not judged (exit 2): never a pass, never an integrity claim.
            (folder / "keycloak.dump").unlink()
            self.assertEqual(audit.verify_backup(folder, checkpoint),
                             (2, {"exit": 2, "error": "Backup component checksum mismatch: keycloak.dump"}))
        self.assertEqual(seen, [(expected, b"fixture dump", False)])


class WrappingCustodyTests(unittest.TestCase):
    def setUp(self):
        self.temp = self.enterContext(tempfile.TemporaryDirectory())
        self.root = Path(self.temp)
        self.host = Host(self.temp)
        self.host.table_counts.update({"emr_signing.private_key": 1, "emr_clinical.online_version": 2, "emr_audit.fixed_copy": 3, "emr_image.preparation": 4})
        self.secret = self.root / "live.key"
        self.secret.write_bytes(bytes(range(32)))
        self.config = self.root / "custody.json"
        self.config.write_text(json.dumps({"backup_root": str(self.root / "custody"), "files": {"wrap-1": str(self.secret)}}))
        self.enterContext(patch.dict(os.environ, {"KIN_EMR_WRAPPING_CUSTODY": str(self.config)}))
        self.enterContext(patch.object(ops, "signing_keys", return_value=[{"kid": "doctor-key", "wrapped": {"wrappingKeyId": "wrap-1"}}]))
        self.host.init_ledger()

    def backup(self):
        folder, manifest, error = self.host.backup(rows_stream({1: "original"}))
        self.assertIsNone(error)
        self.assertTrue(manifest["complete"])
        return folder, manifest

    def test_nightly_path_records_separate_locator_and_rehearses_after_live_secret_loss(self):
        folder, manifest = self.backup()
        locator = Path(manifest["wrapping_custody"]["directory"])
        self.assertEqual(locator, self.root / "custody" / folder.name)
        self.assertNotIn(folder, locator.parents)
        self.secret.unlink()
        restored = ops.restore_wrapping_custody(manifest, self.root / "restored")
        self.assertEqual(Path(restored["wrap-1"]).read_bytes(), bytes(range(32)))
        result, error, _, _ = self.host.rehearse(folder, rows_stream({1: "original"}))
        self.assertIsNone(error)
        self.assertTrue(result["success"])
        self.assertEqual(result["wrapping_custody"]["directory"], str(locator))
        self.assertEqual(result["wrapping_custody"]["keys"], 1)
        with self.assertRaises(FileExistsError):
            ops.restore_wrapping_custody(manifest, self.root / "restored")

    def test_relocated_custody_restores_without_the_original_host_path(self):
        import shutil
        folder, manifest = self.backup()
        old = Path(manifest["wrapping_custody"]["directory"])
        moved = self.root / "fresh-host-custody"
        shutil.move(str(old), moved)
        self.secret.unlink()
        restored = ops.restore_wrapping_custody(manifest, self.root / "fresh-secrets", source=moved)
        self.assertEqual(Path(restored["wrap-1"]).read_bytes(), bytes(range(32)))
        self.assertFalse(old.exists())
        import io
        with patch.object(sys, "argv", ["ops_backup.py", "restore-wrapping", str(folder),
                "--source", str(moved), "--destination", str(self.root / "cli-secrets")]), \
                patch.object(sys, "stdout", io.StringIO()) as output:
            ops.main()
        self.assertEqual(Path(json.loads(output.getvalue())["files"]["wrap-1"]).read_bytes(), bytes(range(32)))

    def test_missing_second_custody_file_leaves_destination_retryable(self):
        _, manifest = self.backup()
        manifest["wrapping_custody"]["files"]["wrap-2"] = {
            "file": "wrap-1.key", "sha256": "a" * 64, "bytes": 32}
        destination = self.root / "retry-secrets"
        with self.assertRaisesRegex(RuntimeError, "unavailable"):
            ops.restore_wrapping_custody(manifest, destination)
        self.assertFalse(destination.exists())

    def test_nightly_backup_refuses_missing_custody_and_resumes_writers(self):
        for failure in ("configuration", "file", "id", "length"):
            with self.subTest(failure=failure):
                self.secret.write_bytes(bytes(range(32)))
                config = {"backup_root": str(self.root / "custody"), "files": {"wrap-1": str(self.secret)}}
                if failure == "file": self.secret.unlink()
                if failure == "id": config["files"] = {"other": str(self.secret)}
                if failure == "length": self.secret.write_bytes(b"short")
                self.config.write_text(json.dumps(config))
                with patch.dict(os.environ, {"KIN_EMR_WRAPPING_CUSTODY": "" if failure == "configuration" else str(self.config)}):
                    # Host records the real flow's RuntimeError; file failures are surfaced as RuntimeError too.
                    _, manifest, error = self.host.backup(rows_stream({1: "original"}))
                self.assertIsNotNone(error)
                self.assertFalse(manifest["complete"])
                self.assertEqual(manifest["resume_failures"], [])

    def test_the_key_copy_is_written_only_for_an_admitted_set(self):
        """restore-wrapping passes the admission a restore passes: for a set that is incomplete, thinned, lost or
        changed a component, or lost its encryption record, no key copy is written."""
        folder, manifest = self.backup()
        self.secret.unlink()
        destination = self.root / "restored-keys"
        stored = (folder / "orthanc.tgz").read_bytes()

        def refused(pattern):
            self.assertRegex(str(restore_wrapping_cli(folder, destination)), pattern)
            self.assertFalse(destination.exists(), "no key copy was written")
        # An encrypted set that lost a component file while its manifest stayed as written.
        (folder / "orthanc.tgz").unlink()
        refused("checksum mismatch: orthanc.tgz")
        (folder / "orthanc.tgz").write_bytes(stored)
        # Its encryption record removed, and the manifest's list emptied with it: the folder still holds age files.
        ops.write_json(folder / "manifest.json", {**{name: value for name, value in manifest.items() if name != "encryption"},
                                                  "sha256": {}, "bytes": {}})
        refused("Encrypted components without an encryption record")
        ops.write_json(folder / "manifest.json", {**manifest, "complete": False})
        refused("Backup is incomplete")
        ops.write_json(folder / "manifest.json", manifest)
        (folder / ops.THINNED_FILE).write_text("{}")
        refused("thinned by rotation")
        (folder / ops.THINNED_FILE).unlink()
        # A set written before encryption: a component of the same length with other content.
        as_plaintext_set(folder)
        original = (folder / "kin.dump").read_bytes()
        (folder / "kin.dump").write_bytes(bytes(byte ^ 1 for byte in original))
        refused("checksum mismatch: kin.dump")
        (folder / "kin.dump").write_bytes(original)
        self.assertIsNone(restore_wrapping_cli(folder, destination))
        self.assertEqual((destination / "wrap-0.key").read_bytes(), bytes(range(32)))

    def test_missing_changed_custody_and_restored_schema_count_drift_fail_rehearsal(self):
        folder, manifest = self.backup()
        entry = manifest["wrapping_custody"]["files"]["wrap-1"]
        custody = Path(manifest["wrapping_custody"]["directory"]) / entry["file"]
        workspace = Path(json.loads(self.host.encryption.read_text())["workspace"])
        # The separate key copy is checked before the first restore write: a lost or changed copy - also at the
        # relocated custody the operator names - starts nothing (no container, no volume, no restored database).
        moved = self.root / "relocated-custody"
        shutil.copytree(custody.parent, moved)
        for path, options in ((custody, {}), (moved / entry["file"], {"wrapping_source": str(moved)})):
            for value in (None, b"x" * 32):
                if value is None: path.unlink()
                else: path.write_bytes(value)
                with self.subTest(relocated=bool(options), custody=value is not None):
                    refused_before_restore(self, folder, "unavailable" if value is None else "differs from the snapshot",
                                           workspace, **options)
                path.write_bytes(bytes(range(32)))
        result, error, _, _ = self.host.rehearse(folder, rows_stream({1: "original"}), wrapping_source=str(moved))
        self.assertIsNone(error, error)
        self.assertEqual((result["success"], result["wrapping_custody"]["directory"]), (True, str(moved)))
        for schema in ("emr_signing.private_key", "emr_clinical.online_version", "emr_audit.fixed_copy", "emr_image.preparation"):
            self.host.table_counts[schema] += 1
            result, error, _, _ = self.host.rehearse(folder, rows_stream({1: "original"}))
            self.assertIn("row counts differ", str(error))
            self.assertFalse(result["success"])
            self.host.table_counts[schema] -= 1


class PrivateWorkTests(unittest.TestCase):
    """Plaintext taken out of a set (an opened encrypted set, a rehearsal's wrapping key copies) exists only in a
    private work folder. A run that is killed leaves its folder; the next run removes it, and never the folder of a
    run that is still going."""

    def setUp(self):
        self.temp = self.enterContext(tempfile.TemporaryDirectory())
        self.root = Path(self.temp)
        self.keys = self.root / "keys"
        self.enterContext(patch.dict(os.environ, {"KIN_BACKUP_ENCRYPTION": str(write_encryption_config(self.keys, ("key-a",)))}))
        self.workspace = self.keys / "open"
        # This test's own temporary directory, for this process and for the runs it starts.
        self.scratch = self.root / "scratch"
        self.scratch.mkdir()
        self.enterContext(patch.object(tempfile, "tempdir", str(self.scratch)))
        self.scratch_env = {name: str(self.scratch) for name in ("TMPDIR", "TEMP", "TMP")}
        self.host = Host(self.temp)
        self.host.table_counts["emr_signing.private_key"] = 1
        secret = self.root / "live.key"
        secret.write_bytes(bytes(range(32)))
        custody = self.root / "custody.json"
        custody.write_text(json.dumps({"backup_root": str(self.root / "custody"), "files": {"wrap-1": str(secret)}}))
        self.enterContext(patch.dict(os.environ, {"KIN_EMR_WRAPPING_CUSTODY": str(custody)}))
        self.enterContext(patch.object(ops, "signing_keys", return_value=[{"kid": "doctor-key", "wrapped": {"wrappingKeyId": "wrap-1"}}]))
        self.answer = rows_stream({1: "a"})
        self.folder, _, error = self.host.backup(self.answer)
        self.assertIsNone(error, error)

    def killed_runs(self):
        """What two killed runs left: an opened set's plaintext in the workspace, wrapping keys in the temporary folder."""
        with another_run(OPENING_RUN, [self.folder], kill=True) as opened:
            self.assertEqual(opened.parent, self.workspace)
            self.assertIn(b"synthetic-fixture", (opened / ".env").read_bytes())
        with another_run(CUSTODY_RUN, [self.folder / "manifest.json"], self.scratch_env, kill=True) as keys:
            self.assertEqual((keys.parent, (keys / "secrets" / "wrap-0.key").read_bytes()), (self.scratch, bytes(range(32))))
        self.assertTrue(opened.is_dir() and keys.is_dir(), "a killed run cannot remove its own plaintext")
        return opened, keys

    def test_what_a_killed_run_left_is_removed_when_the_next_run_starts(self):
        opened, keys = self.killed_runs()
        with patch.object(sys, "argv", ["ops_backup.py", "rotate", "--root", str(self.host.parent), "--dry-run"]), \
                patch.object(ops, "ROOT", self.host.repo), contextlib.redirect_stdout(io.StringIO()):
            ops.main()
        self.assertEqual((list(self.workspace.iterdir()), list(self.scratch.iterdir())), ([], []))

    def test_the_next_opening_and_rehearsal_remove_it_and_leave_a_running_runs_folder(self):
        opened, keys = self.killed_runs()
        with another_run(OPENING_RUN, [self.folder], kill=False) as running:
            self.assertFalse(opened.exists(), "the next opening removed the killed run's plaintext")
            result, error, _, _ = self.host.rehearse(self.folder, self.answer)
            self.assertIsNone(error, error)
            self.assertTrue(result["success"])
            self.assertFalse(keys.exists(), "the next rehearsal removed the killed run's key copies")
            self.assertEqual(ops.reclaim_work(self.workspace), [])
            self.assertIn(b"synthetic-fixture", (running / ".env").read_bytes(), "a running run keeps its folder")
            self.assertEqual(list(self.workspace.iterdir()), [running])
        self.assertEqual((list(self.workspace.iterdir()), list(self.scratch.iterdir())), ([], []), "and removes it itself")

    def test_only_this_tools_dead_leftovers_are_removed(self):
        ended = subprocess.Popen([sys.executable, "-c", "pass"])
        ended.wait()
        here = {"host": ops.platform.node(), "pid": os.getpid(), "started": ops._process_started(os.getpid())}
        gone = {**here, "pid": ended.pid, "started": None}

        def folder(name, record):
            path = self.workspace / name
            path.mkdir()
            (path / "kin.dump").write_bytes(b"plaintext")
            if record is not None:
                (path / ops.WORK_OWNER).write_text(json.dumps(record))
            return path
        kept = [folder("kin-open-no-record", None), folder("kin-open-other-host", {**gone, "host": "another-host"}),
                folder("kin-open-still-running", here), folder("another-tools-folder", gone),
                folder("kin-open-unreadable-record", {"pid": "x"})]
        removed = [folder("kin-open-ended", gone), folder("kin-wrapping-restore-ended", gone)]
        if sys.platform.startswith("linux"):
            # The PID of a run that ended, given to a later process: the recorded start time tells them apart.
            removed.append(folder("kin-open-pid-reused", {**here, "started": "another-boot:1"}))
        self.assertEqual(sorted(ops.reclaim_work(self.workspace)), sorted(path.name for path in removed))
        self.assertEqual(sorted(self.workspace.iterdir()), sorted(kept))
        with self.assertRaisesRegex(RuntimeError, "Unknown private work folder kind"):
            with ops.private_work(self.workspace, "kin-other-"):
                self.fail("made a folder the next run would not know")


if __name__ == "__main__":
    unittest.main(verbosity=2)
