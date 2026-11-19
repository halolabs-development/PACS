"""Read-only API deployment preflight. This never authorizes or executes deployment.

python scripts/ops_deploy_preflight.py request.json --request-sha256 <sha256>
python scripts/ops_deploy_preflight.py --storage-only [--backup-root <directory>]
The separately supplied hash binds bytes, not the identity/authority of an approver. Both report storage and backup
encryption (one line on stderr, the report in the JSON); that report is a warning, never a refusal.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
from urllib.parse import urlsplit

import ops_backup as ops

COMPOSE = ["docker-compose.yml", "docker-compose.prod.yml", "docker-compose.monitor.yml"]
# EMR-B1: the image's entry modes and the migration/runtime credential split are part of the deployment boundary.
PROTECTED = ["api/prisma", "api/Dockerfile", "api/start-production.sh", "keycloak", "config", "proxy", "worklist-v0", "gateway", *COMPOSE]
# A release that brings the EMR-B storage needs, before any switch: the provisioning (roles, secrets, tablespace volume),
# the installer-credential migration in its own process and a restore rehearsal of database plus API state volume.
# None of that is an API-only replacement, so this path refuses it outright.
EMR_MIGRATION = "api/prisma/migrations/20261008120000_emr_b/migration.sql"
EMR_STATE = "/var/lib/kin-emr"
# CD-09-P/D retention ledgers (docker-compose.prod.yml): outside the database and every backup, so a replaced API must
# get the same volume back - the server refuses to start beside a database whose bound ledger is gone.
RETENTION_LEDGER = "/var/lib/kin-purpose"
# Their mirror (KIN_LEDGER_MIRROR_DIR, docker-compose.prod.yml): a second copy written with every append, on its own volume
# beside the ledger's, never without it. The API that mounts it names it, and only then.
LEDGER_MIRROR = "/var/lib/kin-ledger-mirror"
# MG-LOADING (docker-compose.prod.yml): the API's frame range reads see Orthanc's database volume. Read-only is the
# whole permission; the same volume writable would let the API change the stored images.
ORTHANC_DB = "/var/lib/orthanc/db"
FIELDS = {"version", "previous_sha", "target_sha", "previous_api_image", "target_api_image", "compose_files"}
SHA = re.compile(r"[0-9a-f]{40}")
IMAGE = re.compile(r"sha256:[0-9a-f]{64}")
HASH = re.compile(r"[0-9a-f]{64}")


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        require(key not in result, "Duplicate JSON key")
        result[key] = value
    return result


def parse_request(raw, expected_hash):
    require(isinstance(expected_hash, str) and HASH.fullmatch(expected_hash), "Invalid request hash")
    require(len(raw) <= 8192, "Request too large")
    require(hashlib.sha256(raw).hexdigest() == expected_hash, "Request hash mismatch")
    body = json.loads(raw.decode("utf-8"), object_pairs_hook=unique_object)
    require(type(body) is dict and set(body) == FIELDS, "Unexpected request fields")
    require(type(body["version"]) is int and body["version"] == 1, "Unsupported request version")
    for field in ("previous_sha", "target_sha"):
        require(type(body[field]) is str and SHA.fullmatch(body[field]), "Invalid commit SHA")
    for field in ("previous_api_image", "target_api_image"):
        require(type(body[field]) is str and IMAGE.fullmatch(body[field]), "Expected immutable local image ID")
    require(body["compose_files"] == COMPOSE, "Base, production and monitor overlays required in order")
    require(body["previous_sha"] != body["target_sha"], "Target is already selected")
    return body


def git(*args):
    return ops.text(["git", *args], timeout=30)


def api_tree(sha):
    require(type(sha) is str and SHA.fullmatch(sha), "Invalid image revision")
    require(git("cat-file", "-t", sha) == "commit", "Expected a Git commit")
    require(git("cat-file", "-t", sha + ":api") == "tree", "Missing API tree")
    return git("rev-parse", sha + ":api")


def has_emr_storage(sha):
    """Whether this commit's product carries the EMR-B storage (its migration file is in the tree)."""
    return ops.run(["git", "cat-file", "-e", sha + ":" + EMR_MIGRATION], check=False, timeout=30).returncode == 0


def check_repository(body):
    previous, target = body["previous_sha"], body["target_sha"]
    require(git("rev-parse", "--show-toplevel") == str(ops.ROOT).replace("\\", "/"), "Wrong repository root")
    require(git("rev-parse", "HEAD") == previous, "Checkout SHA changed")
    require(not git("status", "--porcelain", "--untracked-files=no"), "Tracked working tree is dirty")
    trees = {sha: api_tree(sha) for sha in (previous, target)}
    require(has_emr_storage(previous) or not has_emr_storage(target),
            "EMR-B storage requires provisioning, installer migration and restore evidence; not an API-only deployment")
    for path in PROTECTED:
        # Missing paths must not make an empty diff look like proven compatibility.
        before = git("rev-parse", previous + ":" + path)
        after = git("rev-parse", target + ":" + path)
        require(before == after, "API-only compatibility boundary changed")
    return trees


def check_image(image, expected_id, expected_tree):
    require(image.get("Id") == expected_id, "Image ID mismatch")
    config = image.get("Config") or {}
    require(config.get("User") == "node", "Expected production node user")
    revision = (config.get("Labels") or {}).get("org.opencontainers.image.revision")
    require(api_tree(revision) == expected_tree, "Image revision API tree mismatch")


def check_running_api(container, expected_id, emr=False):
    require(container.get("Name") == "/kin-api", "Wrong API container")
    require(container.get("Image") == expected_id, "Running API image changed")
    require((container.get("State") or {}).get("Running") is True, "API is not running")
    config = container.get("Config") or {}
    labels = config.get("Labels") or {}
    require(labels.get("com.docker.compose.project.working_dir") == str(ops.ROOT), "Wrong Compose working directory")
    require(labels.get("com.docker.compose.service") == "api", "Wrong Compose service")
    require(config.get("User") == "node", "Running API is not the production user")
    mounts = container.get("Mounts")
    if emr:
        # EMR-B: the protected state volume (ledger seal and failure journal) and, from CD-09-P, the retention ledger
        # volume, and with it its mirror; read-write named volumes only, never a host path. A release before CD-09-P runs
        # without the ledger. Beside them only Orthanc's database, read-only (a release before MG-LOADING runs without it).
        allowed = ([EMR_STATE], sorted([EMR_STATE, RETENTION_LEDGER]), sorted([EMR_STATE, RETENTION_LEDGER, LEDGER_MIRROR]))
        message = "API must run with only its EMR state, retention ledger and ledger mirror volumes and Orthanc's database read-only"
        require(type(mounts) is list and all(type(m) is dict and m.get("Type") == "volume" and type(m.get("RW")) is bool
                                             for m in mounts), message)
        require(sorted(m.get("Destination") for m in mounts if m["RW"] is True) in allowed
                and [m.get("Destination") for m in mounts if m["RW"] is False] in ([], [ORTHANC_DB]), message)
    else:
        require(mounts == [], "API must run without host or volume overrides")
    network = container.get("NetworkSettings") or {}
    require("Ports" in network and not any((network["Ports"] or {}).values()), "API host ports are exposed or unknown")
    host = container.get("HostConfig") or {}
    require(host.get("NetworkMode") not in (None, "host") and not host.get("PortBindings"), "Unsafe API network mode or host bindings")
    env = dict(item.split("=", 1) for item in config.get("Env", []) if "=" in item)
    require(env.get("DEPLOYMENT_MODE") == "production" and env.get("AUTH_REQUIRED") == "true", "Production authentication settings required")
    if emr:
        # The server holds the runtime role only: no installer password and no other database user in its environment.
        try:
            user = urlsplit(env.get("DATABASE_URL", "")).username
        except ValueError:
            user = None
        require(user == "kin_runtime" and "POSTGRES_PASSWORD" not in env and env.get("KIN_EMR_STATE_DIR") == EMR_STATE,
                "API must hold only the EMR runtime credential and its state directory")
        # A mounted mirror the server does not write is no copy, and a mirror path with no volume under it would be the
        # container's own disk, gone with the container.
        mirrored = any(m.get("Destination") == LEDGER_MIRROR for m in mounts)
        require((env.get("KIN_LEDGER_MIRROR_DIR") or None) == (LEDGER_MIRROR if mirrored else None),
                "API ledger mirror setting and volume disagree")


def inspect_one(args):
    items = json.loads(ops.text(["docker", *args], timeout=30))
    require(type(items) is list and len(items) == 1 and type(items[0]) is dict, "Unexpected Docker inspection")
    return items[0]


def observe(body):
    """Recheck on the host; the caller must already own the operations lock."""
    ops.require_local_docker()
    trees = check_repository(body)
    for prefix in ("previous", "target"):
        identity = body[prefix + "_api_image"]
        check_image(inspect_one(["image", "inspect", identity]), identity, trees[body[prefix + "_sha"]])
    # check_repository refused an EMR introduction, so previous and target agree on the storage shape.
    check_running_api(inspect_one(["inspect", "kin-api"]), body["previous_api_image"], has_emr_storage(body["previous_sha"]))
    # Reported, never a refusal: the runbook (Storage encryption) says what the operator does about it.
    storage = storage_encryption()
    print(storage_line(storage), file=sys.stderr, flush=True)
    return {"preflight_passed": True, "deployment_authorized": False,
            "automatic_rollback_authorized": False, "schema_unchanged": True,
            "previous_sha": body["previous_sha"], "target_sha": body["target_sha"],
            "previous_api_image": body["previous_api_image"],
            "target_api_image": body["target_api_image"], "compose_files": list(COMPOSE),
            "storage_encryption": storage}


# ── Storage encryption (read-only report; a warning, never a refusal) ──
# One rule: a location counts as encrypted only when every block device under its file system reaches a dm-crypt layer;
# a device seen without one is "not-detected"; anything this host cannot see that way (no such path, a file system not
# on a local block device, a volume driver other than local, a failed command, not Linux) is "unknown". The locations
# are the site's actual data: every writable volume or bind of the database, Orthanc and the API (PGDATA, the EMR
# tablespace, the Orthanc storage, the EMR state, the retention ledgers and their mirror), and the backup root.
STORAGE_CONTAINERS = ("kin-db", "kin-orthanc", "kin-api")
STORAGE_STATES = ("encrypted", "not-detected", "unknown")
BACKUP_KEY_STATES = ("configured", "absent", "invalid")


def _read(args):
    try:
        result = ops.run(args, check=False, timeout=30)
    except (OSError, ValueError, subprocess.SubprocessError):
        return None
    return result.stdout.decode("utf-8", "replace") if result.returncode == 0 else None


def _device_encrypted(device, seen):
    """True when every dependency path of the block device passes a crypt layer, False when one does not, None when
    unreadable. lsblk --inverse lists a device with what it is built on as its children."""
    if device not in seen:
        try:
            nodes = json.loads(_read(["lsblk", "--json", "--inverse", "--output", "NAME,TYPE", device]) or "")["blockdevices"]
        except (ValueError, TypeError, KeyError):
            nodes = None

        def through_crypt(node):
            if node.get("type") == "crypt":
                return True
            children = node.get("children") or []
            return bool(children) and all(through_crypt(child) for child in children)
        seen[device] = all(through_crypt(node) for node in nodes) if type(nodes) is list and nodes else None
    return seen[device]


def location_encryption(path, seen):
    """(status, detail) of one host path."""
    if not path:
        return "unknown", "no host path"
    try:
        filesystems = json.loads(_read(["findmnt", "--json", "--output", "SOURCE,FSTYPE,UUID", "--target", path]) or "")["filesystems"]
        source, fstype, identity = (filesystems[0].get(key) for key in ("source", "fstype", "uuid"))
    except (ValueError, TypeError, KeyError, IndexError):
        return "unknown", "file system not readable"
    if fstype == "btrfs":
        # A Btrfs file system may span several devices; findmnt names one (with its subvolume as [/path]).
        try:
            devices = sorted("/dev/" + name for name in os.listdir("/sys/fs/btrfs/" + str(identity) + "/devices"))
        except OSError:
            return "unknown", "btrfs devices not readable"
    else:
        source = re.sub(r"\[[^\]]*\]$", "", source or "")
        if not source.startswith("/dev/"):
            return "unknown", (fstype or "file system") + " not on a local block device"
        devices = [source]
    states = [_device_encrypted(device, seen) for device in devices]
    if states and all(state is True for state in states):
        return "encrypted", ",".join(devices)
    if any(state is False for state in states):
        return "not-detected", ",".join(devices)
    return "unknown", "block device not readable"


def data_locations():
    """(label, host path or None) of every writable volume and bind of the site's data containers."""
    rows = []
    for name in STORAGE_CONTAINERS:
        try:
            items = json.loads(_read(["docker", "inspect", name]) or "")
            mounts = items[0].get("Mounts") or []
        except (ValueError, TypeError, IndexError, AttributeError):
            rows.append((name, None))
            continue
        for mount in mounts:
            if type(mount) is not dict or mount.get("RW") is not True or mount.get("Type") not in ("volume", "bind"):
                continue
            local = mount["Type"] == "bind" or mount.get("Driver") in (None, "", "local")
            rows.append((name + ":" + str(mount.get("Destination")), mount.get("Source") if local else None))
    return rows


def backup_key_state():
    path = Path(os.environ.get("KIN_BACKUP_ENCRYPTION") or ops.BACKUP_ENCRYPTION_CONFIG)
    if not path.exists():
        return "absent"
    try:
        ops.backup_key()
    except ops.BackupEncryptionError:
        return "invalid"
    return "configured"


def storage_encryption(backup_root=None):
    """The report: {"status", "locations": [{"location", "status", "detail"}], "backup_encryption"}."""
    if not sys.platform.startswith("linux"):
        locations = [{"location": "host", "status": "unknown", "detail": "not Linux"}]
    else:
        seen, locations = {}, []
        for label, path in [*data_locations(), ("backup root", str(backup_root) if backup_root else None)]:
            status, detail = location_encryption(path, seen)
            locations.append({"location": label, "status": status, "detail": detail})
    states = {row["status"] for row in locations}
    status = "encrypted" if states == {"encrypted"} else "not-detected" if "not-detected" in states else "unknown"
    return {"status": status, "locations": locations, "backup_encryption": backup_key_state()}


def storage_valid(report):
    """The report's shape, as the deployment runner accepts it in an observation."""
    return (type(report) is dict and set(report) == {"status", "locations", "backup_encryption"}
            and report["status"] in STORAGE_STATES and report["backup_encryption"] in BACKUP_KEY_STATES
            and type(report["locations"]) is list and report["locations"]
            and all(type(row) is dict and set(row) == {"location", "status", "detail"} and row["status"] in STORAGE_STATES
                    and type(row["location"]) is str and type(row["detail"]) is str for row in report["locations"]))


def storage_line(report):
    return ("storage encryption: " + report["status"] + " ("
            + ", ".join(row["location"] + "=" + row["status"] for row in report["locations"])
            + "); backup encryption: " + report["backup_encryption"])


def preflight(body):
    # Share the backup lock, but do not issue a token that could be reused after
    # releasing it. A future deployer must recheck and keep this lock throughout.
    with ops.lock():
        return observe(body)


# ── EMR introduction (INTERIM-RELEASE-TOOLS, D1039/D1043): checks over facts the introduction mode observed ──
# scripts/ops_emr_introduction.py is the only caller. Everything above stays the API-only path, which keeps refusing a
# release that brings the EMR-B storage. Each check raises RuntimeError with a fixed message (the STOP code); none of
# them reads a secret value into its message, and none of them mutates anything.
MIGRATION_NAME = re.compile(r"0_init|\d{14}_[a-z0-9_]{1,80}")
EMR_ROLES = ("kin_emr_owner", "kin_runtime", "kin_emr_reader", "kin_emr_retention")
ELEVATED = ("rolsuper", "rolcreatedb", "rolcreaterole", "rolreplication", "rolbypassrls")
WRITERS = ("api", "keycloak", "orthanc", "proxy")
SECRET_FORM = re.compile(r"[A-Za-z0-9._~-]{24,}")
APP_ROLES = ("radiologist", "technician", "admin", "clinician")


def check_migration_rows(rows, expected):
    """The applied history equals the expected list exactly: names and SQL checksums, every one finished, none rolled back."""
    require(type(rows) is list and all(type(row) is list and len(row) == 4 for row in rows), "Unreadable migration history")
    require([[row[0], row[1]] for row in rows] == [list(item) for item in expected], "Migration names or checksums differ")
    require(all(row[2] is True and row[3] is False for row in rows), "A migration is unfinished or rolled back")


def emr_storage_present(catalog):
    """Any trace of the EMR storage in a cluster catalog: an EMR role, an emr_* schema (emr_access, and the later units'
    emr_clinical and the like) or the dedicated tablespace."""
    roles = {role["rolname"] for role in catalog["roles"]}
    return bool(roles & set(EMR_ROLES) or any(str(name).startswith("emr_") for name in catalog["schemas"])
                or any(space["name"] == "kin_emr_access" for space in catalog["tablespaces"]))


def check_baseline(observed, plan):
    """Before anything changes: the host is exactly the plan's previous release (fresh observation, not the old record)."""
    previous = plan["previous"]
    require(observed["head"] == previous["sha"] and observed["dirty"] is False, "Checkout is not the clean previous release")
    require(observed["images"] == previous["images"], "Running service images differ from the previous release")
    require(all(observed["running"].get(role) is True for role in ("db", *WRITERS)), "A service of the previous release is not running")
    require(not any(observed["restarting"].values()), "A service is restarting")
    check_migration_rows(observed["migrations"], plan["migrations"]["before"])
    require(not emr_storage_present(observed["catalog"]), "EMR storage already exists on the source")
    # A B0 the rollback could not rebuild exactly (a further LOGIN role, role settings, another database or tablespace)
    # is refused here, before the fence or any capture.
    ops.supported_pre_catalog(observed["catalog"])
    require(observed["emr_volumes"] == [], "EMR volumes already exist on the source")
    require(observed["api_state_mounts"] == 0, "The previous API already has an EMR state mount")
    require(observed["cron"] in ("matched", "not-managed"), "Scheduled jobs differ from the target manifest")
    check_member_counts(observed["members"], plan["members"])


def check_member_counts(observed, expected):
    """The realm's people as the plan recorded them in its read-only observation: members (service accounts are not
    members), how many of them are disabled, and the service accounts counted apart."""
    require(observed == expected, "Realm members differ from the plan")


def check_provision_first(catalog, rows, plan):
    """Provision-first only (Astra DR2-09): the provisioning runs on exactly the previous release's database, before any
    EMR migration. A database that already carries EMR roles, an emr_* schema, the tablespace or any migration beyond the
    previous history (a database migrated before it was provisioned) is refused, never repaired: emr-compose's
    PROVISION_SQL does not move existing relations' TOAST storage or later units' schemas into the tablespace."""
    check_migration_rows(rows, plan["migrations"]["before"])
    require(not emr_storage_present(catalog), "EMR storage exists before provisioning (migrated before provisioned); refused, not repaired")


def check_placement(rows):
    """Every relation of every emr_* schema - tables, indexes, sequences and each table's TOAST table and TOAST index -
    sits in kin_emr_access (what emr_access.require_placement demands, for all EMR schemas)."""
    require(type(rows) is list and rows, "EMR placement is unreadable or empty")
    outside = sorted(row["relation"] for row in rows if row["tablespace"] != "kin_emr_access")
    require(not outside, "EMR relations outside kin_emr_access: " + ",".join(outside)[:400])


def check_write_freeze(observed):
    """Every write entry point is closed: HTTPS ingress (proxy), DICOM receive and REST (Orthanc), gateway and member
    administration (API), account changes (Keycloak), scheduled jobs; and no database client remains."""
    require(all(observed["running"].get(role) is False for role in WRITERS), "A writer is still running")
    require(observed["running"].get("db") is True, "The database must keep running for the capture")
    require(observed["db_clients"] == 0, "Database clients remain after the fence")
    require(observed["cron"] in ("fenced", "not-managed"), "Scheduled jobs are not fenced")
    require(observed["one_shots"] == [], "A one-shot worker of this release is still present")


def check_tablespace_directory(observed, storage, fresh):
    """The tablespace directory belongs to the DB image's real postgres account, 0700; empty before CREATE TABLESPACE.
    An existing tablespace keeps its path and owner and is never emptied or chmodded to pass."""
    require(observed["path"] == storage["tablespace_path"] and observed["type"] == "directory", "Tablespace path differs")
    require((observed["uid"], observed["gid"]) == (storage["postgres_uid"], storage["postgres_gid"]), "Tablespace directory owner differs")
    require(observed["mode"] == "700", "Tablespace directory mode is not 0700")
    require(observed["entries"] == 0 if fresh else observed["entries"] >= 0, "Tablespace directory is not empty before CREATE TABLESPACE")


def check_env_secrets(env, secrets):
    """Secret names only by shape: the runtime secret exists in its URL-safe form and is not the installer's; reader and
    retention stay unset (NOLOGIN) unless the plan names them. Values never leave this function."""
    for name in secrets["required"]:
        require(type(env.get(name)) is str and env[name] != "", "A required secret name is missing")
    for name in secrets["absent"]:
        require(name not in env, "A secret that must stay unset is present")
    runtime, installer = env.get(secrets["runtime"], ""), env.get(secrets["installer"], "")
    require(SECRET_FORM.fullmatch(runtime) is not None, "Runtime secret form is unusable")
    require(runtime != installer, "Runtime secret reuses the installer secret")


def check_provisioned(catalog, storage, logins):
    """emr-provision's outcome: owner NOLOGIN, runtime LOGIN, reader/retention as planned; nothing elevated; no
    membership; the dedicated tablespace at the planned path, owned by kin_emr_owner."""
    roles = {role["rolname"]: role for role in catalog["roles"]}
    require(set(EMR_ROLES) <= set(roles), "An EMR role is missing")
    for name in EMR_ROLES:
        require(not any(roles[name][key] for key in ELEVATED), "An EMR role holds an elevated attribute")
        require(roles[name]["rolcanlogin"] is logins[name], "An EMR role login state differs from the plan")
    require(not any(m["granted"] in EMR_ROLES or m["member"] in EMR_ROLES for m in catalog["memberships"]),
            "An EMR role has a membership")
    spaces = [space for space in catalog["tablespaces"] if space["name"] == "kin_emr_access"]
    require(len(spaces) == 1 and spaces[0]["owner"] == "kin_emr_owner"
            and spaces[0]["location"] == storage["tablespace_path"], "EMR tablespace differs from the plan")


def check_emr_catalog(catalog):
    """After the migration: every ledger relation in the dedicated tablespace, owned by kin_emr_owner; the runtime role
    owns nothing; SECURITY DEFINER functions belong to the owner."""
    require(catalog["schema"]["owner"] == "kin_emr_owner", "EMR schema owner differs")
    require(catalog["tablespace"]["owner"] == "kin_emr_owner", "EMR tablespace owner differs")
    require(catalog["tables"] and all(item["owner"] == "kin_emr_owner" and item["tablespace"] == "kin_emr_access"
                                      for item in catalog["tables"]), "A ledger relation is outside its owner or tablespace")
    require(all(item["owner"] == "kin_emr_owner" for item in catalog["functions"] or []), "A ledger function has another owner")


def check_projection_preserved(before, after):
    """Every pre-existing table kept every row value of its pre-existing columns (counts and digests equal)."""
    require(set(before) <= set(after), "A pre-existing table disappeared")
    changed = sorted(name for name in before if (after[name]["count"], after[name]["sha256"]) != (before[name]["count"], before[name]["sha256"]))
    require(not changed, "Existing rows changed: " + ",".join(changed)[:400])



def check_introduced_api(container, *, name, image, release, working_dir, state_volume):
    """The running API of the introduced release: OS user node, DB role kin_runtime only, production authentication,
    exactly one RW named state volume and no host port; no installer secret in its environment."""
    require(container.get("Name") == "/" + name, "Wrong API container")
    require(container.get("Image") == image and (container.get("State") or {}).get("Running") is True, "API is not the running target image")
    config = container.get("Config") or {}
    labels = config.get("Labels") or {}
    require(labels.get("kin.deploy.release") == release, "API release label differs")
    require(labels.get("com.docker.compose.project.working_dir") == working_dir and labels.get("com.docker.compose.service") == "api",
            "Wrong Compose working directory or service")
    require(config.get("User") == "node", "Running API is not the production user")
    mounts = container.get("Mounts")
    require(type(mounts) is list and len(mounts) == 1 and mounts[0].get("Type") == "volume"
            and mounts[0].get("Name") == state_volume and mounts[0].get("Destination") == EMR_STATE
            and mounts[0].get("RW") is True, "API must run with only its EMR state volume")
    network = container.get("NetworkSettings") or {}
    require("Ports" in network and not any((network["Ports"] or {}).values()), "API host ports are exposed or unknown")
    host = container.get("HostConfig") or {}
    require(host.get("NetworkMode") not in (None, "host") and not host.get("PortBindings") and host.get("Privileged") is not True,
            "Unsafe API network mode, host bindings or privilege")
    env = dict(item.split("=", 1) for item in config.get("Env", []) if "=" in item)
    require(env.get("DEPLOYMENT_MODE") == "production" and env.get("AUTH_REQUIRED") == "true", "Production authentication settings required")
    try:
        user = urlsplit(env.get("DATABASE_URL", "")).username
    except ValueError:
        user = None
    require(user == "kin_runtime" and env.get("KIN_EMR_STATE_DIR") == EMR_STATE, "API must hold the EMR runtime credential and state directory")
    require(not {"POSTGRES_PASSWORD", "PGPASSWORD", "KIN_EMR_READER_PASSWORD", "KIN_EMR_RETENTION_PASSWORD"} & set(env),
            "API holds an installer, reader or retention secret")


def check_state_volume(observed, storage):
    """The API state volume as the node account sees it: owner node, 0700, and a file can be created, synced, renamed."""
    require((observed["uid"], observed["gid"]) == (storage["node_uid"], storage["node_gid"]), "State volume owner differs")
    require(observed["mode"] == "700" and observed["writable"] is True, "State volume mode or write test failed")


def check_keycloak_serverinfo(selected):
    """Process options of the running Keycloak (keycloak/README.md): user-session caches off, persistent sessions on."""
    require(selected.get("useCaches") == "false", "Keycloak user-session caches are not off")
    require(selected.get("persistentUserSessions") is True, "Keycloak persistent user sessions are not on")


REALM_FILE = Path(__file__).resolve().parent.parent / "keycloak" / "kin-realm.json"


def realm_flow_rows(realm, alias):
    """A flow of the realm file in the shape Admin REST lists it (GET .../authentication/flows/{alias}/executions): depth
    first, siblings by priority, each row its level, requirement, authenticator or subflow, and the authenticator's config."""
    flows = {flow["alias"]: flow for flow in realm["authenticationFlows"]}
    configs = {item["alias"]: item["config"] for item in realm.get("authenticatorConfig", [])}
    rows = []

    def walk(name, level):
        for step in sorted(flows[name]["authenticationExecutions"], key=lambda step: step["priority"]):
            row = {"level": level, "requirement": step["requirement"]}
            if step.get("authenticatorFlow"):
                rows.append({**row, "authenticationFlow": True})
                walk(step["flowAlias"], level + 1)
            else:
                rows.append({**row, "providerId": step["authenticator"],
                             **({"config": configs[step["authenticatorConfig"]]} if step.get("authenticatorConfig") else {})})
    walk(alias, 0)
    return rows


# Admin REST answers these step-config values masked (GET .../authentication/config/{id}, Keycloak 26.7.3): the deploy can see
# that the authentication reference is set, not its value. A value it can read is compared as it is.
MASKED_CONFIG = "**********"
MASKED_CONFIG_KEYS = frozenset({"default.reference.value", "default.reference.maxAge"})


def flow_shape(rows):
    """What a flow does, without the names and ids an installation chose: level, requirement, step, step config. An
    authentication reference value counts as set (Admin REST masks it); flows_match compares the ones it can read."""
    require(type(rows) is list and all(type(row) is dict for row in rows), "The realm's authentication flow could not be read")
    seen = lambda key, value: "set" if key in MASKED_CONFIG_KEYS and value not in ("", None) else value
    return [(row.get("level"), row.get("requirement"), "subflow" if row.get("authenticationFlow") is True else row.get("providerId"),
             sorted((key, seen(key, value)) for key, value in (row.get("config") or {}).items())) for row in rows]


def flows_match(live, file_rows):
    """The live flow has the file's shape; a reference value the live read shows (not masked) must also be the file's."""
    if flow_shape(live) != flow_shape(file_rows):
        return False
    for row, expected in zip(live, file_rows):
        for key in MASKED_CONFIG_KEYS & set(row.get("config") or {}):
            if row["config"][key] != MASKED_CONFIG and row["config"][key] != (expected.get("config") or {}).get(key):
                return False
    return True


def check_admin_mfa(policy, realm=None):
    """Administrators sign in with OTP (keycloak/README.md "관리자 OTP 필수"). The one rule is the shipped realm file: the live
    browser and reset-credentials flows have the shape of kin-realm.json's (the administrator OTP steps carry the `otp`
    authentication reference), kin-bff's access token carries the authentication methods (the AMR mapper: the API admits
    administrators only with `otp` in it), and CONFIGURE_TOTP is enabled so an administrator without OTP enrols at the next
    sign-in. Existing installations apply it by hand before the deploy; this refuses until then. What it cannot see: the
    reference values Admin REST masks (only that they are set) and whether a real sign-in yields the claim."""
    realm = realm or json.loads(REALM_FILE.read_text(encoding="utf-8"))
    require(type(policy) is dict and type(policy.get("requiredActions")) is list, "The realm's login policy could not be read")
    require(flows_match(policy.get("executions"), realm_flow_rows(realm, realm["browserFlow"])),
            "The realm's browser flow does not require OTP for administrators (keycloak/README.md 관리자 OTP 필수)")
    require(flows_match(policy.get("resetExecutions"), realm_flow_rows(realm, realm["resetCredentialsFlow"])),
            "The realm's reset-credentials flow does not require OTP for administrators (keycloak/README.md 관리자 OTP 필수)")
    require(any(type(row) is dict and row.get("alias") == "CONFIGURE_TOTP" and row.get("enabled") is True
                for row in policy["requiredActions"]), "The realm's Configure OTP required action is not enabled")
    require(policy.get("browserOverrides") == [], "A client has its own browser flow, outside the administrator OTP")
    mappers = policy.get("bffMappers")
    require(type(mappers) is list and any(type(m) is dict and m.get("protocolMapper") == "oidc-amr-mapper"
                                          and (m.get("config") or {}).get("access.token.claim") == "true" for m in mappers),
            "kin-bff's access token does not carry the authentication methods (keycloak/README.md 관리자 OTP 필수)")


def expected_member_rights(user, isolated, unconfirmed):
    """The row the product's import (api/src/member-rights-import.ts importMemberRights) writes for one realm member:
    the realm roles within APP_ROLES; approved only with exactly one group (the institution), at least one such role and
    no gateway role; an unapproved member holds no institution and no roles; suspended when the realm account is
    disabled, the member is isolated or a disable/enable of it is unconfirmed."""
    roles = sorted(role for role in user["roles"] if role in APP_ROLES)
    approved = len(user["groups"]) == 1 and bool(roles) and "gateway" not in user["roles"]
    return {"username": user["username"], "approved": approved, "institution": user["groups"][0] if approved else None,
            "roles": roles if approved else [],
            "suspended": user["enabled"] is not True or user["id"] in isolated or user["id"] in unconfirmed}


def check_member_import(observed):
    """realm-v1: one marker, ready, every realm member imported once with exactly the rights the product's rule gives
    its realm facts (identity, institution, every role, approval, suspension), every legacy-enable publication confirmed
    and no provider change left unconfirmed; and the realm itself unchanged by the import except those confirmed
    enables (the same members, names, groups and roles, the same realm role and group definitions)."""
    require(observed["markers"] == ["realm-v1"] and observed["state"] == "ready", "Member rights import marker missing")
    roster = {user["id"]: user for user in observed["roster_before"]}
    require(len(roster) == len(observed["roster_before"]), "The realm roster lists a member twice")
    rows = {row["sub"]: row for row in observed["rights"]}
    require(len(rows) == len(observed["rights"]) and set(rows) == set(roster), "Imported members differ from the realm members")
    changes = observed["changes"]
    isolated = set(observed["isolated"])
    unconfirmed = {change["sub"] for change in changes if change["kind"] in ("disable", "enable") and change["state"] == "unknown"}
    for sub, row in rows.items():
        actual = {"username": row["username"], "approved": row["approved"], "institution": row["institution"],
                  "roles": sorted(row["roles"]), "suspended": row["suspended"]}
        require(actual == expected_member_rights(roster[sub], isolated, unconfirmed),
                "An imported member's rights differ from the realm (identity, institution, roles, approval or suspension)")
    legacy = {change["sub"]: change for change in observed["legacy_enable"]}
    disabled = {sub for sub, user in roster.items() if not user["enabled"]}
    require(set(legacy) == disabled and len(legacy) == len(observed["legacy_enable"]), "Legacy enable intents differ from disabled members")
    require(all(change["state"] == "done" for change in legacy.values()), "A roster publication is unconfirmed")
    require(all(change["kind"] != "credentials" or change["target"] == "legacy-enable:" + str(change["sub"]) for change in changes),
            "The import left a roster change other than the legacy enables")
    require(not any(change["state"] == "unknown" for change in changes), "A provider change is unconfirmed")
    after = {user["id"]: user for user in observed["roster_after"]}
    require(set(after) == set(roster) and len(after) == len(observed["roster_after"]), "Realm members were added or removed during the import")
    for sub, user in roster.items():
        other = after[sub]
        require(other["username"] == user["username"] and sorted(other["groups"]) == sorted(user["groups"])
                and sorted(other["roles"]) == sorted(user["roles"]), "A realm member's name, groups or roles changed during the import")
        if sub in legacy:
            require(user["enabled"] is False and other["enabled"] is True, "A confirmed legacy enable is not in the realm")
        else:
            require(other["enabled"] == user["enabled"], "A realm member's enabled state changed without a legacy enable")
    require(observed["realm_before"] == observed["realm_after"], "Realm roles or groups changed during the import")
    require(all(rows[sub]["suspended"] for sub in disabled), "A legacy-disabled member lost its PACS suspension")


def check_proxy(observed, image):
    require(observed["image"] == image and observed["running"] is True, "Proxy is not the running target image")
    require(observed["nginx_test"] == 0, "nginx configuration test failed")
    require(observed["certificate_valid_days"] is True, "Proxy certificate is missing or expires within seven days")


def check_served_bytes(observed, expected):
    """UI and viewer configuration served by the Orthanc container equal the target tree (whole files, not a sample)."""
    require(observed == expected, "Served UI or viewer configuration differs from the target tree")


def main():
    if "--storage-only" in sys.argv[1:]:
        # The storage report alone: read-only, no request, no lock (the release preparation runs it).
        parser = argparse.ArgumentParser(description="Report storage and backup encryption; read-only")
        parser.add_argument("--storage-only", action="store_true", required=True)
        parser.add_argument("--backup-root", type=Path)
        args = parser.parse_args()
        report = storage_encryption(args.backup_root)
        print(storage_line(report), file=sys.stderr, flush=True)
        print(json.dumps(report))
        return 0
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("request", type=Path)
    parser.add_argument("--request-sha256", required=True)
    args = parser.parse_args()
    try:
        with args.request.open("rb") as handle:
            body = parse_request(handle.read(8193), args.request_sha256)
        result = preflight(body)
    except Exception as error:
        # JSON, Docker and filesystem errors can contain supplied paths/secrets.
        print(json.dumps({"preflight_passed": False, "deployment_authorized": False,
                          "error_type": type(error).__name__}), file=sys.stderr)
        return 1
    print(json.dumps(result))
    return 0


if __name__ == "__main__":
    sys.exit(main())
