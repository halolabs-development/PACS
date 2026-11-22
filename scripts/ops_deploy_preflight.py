"""Read-only API deployment preflight. This never authorizes or executes deployment.

python scripts/ops_deploy_preflight.py request.json --request-sha256 <sha256>
python scripts/ops_deploy_preflight.py --storage-only [--backup-root <directory>]
python -B scripts/ops_deploy_preflight.py --network-only
The separately supplied hash binds bytes, not the identity/authority of an approver. Both report storage and backup
encryption (one line on stderr, the report in the JSON); that report is a warning, never a refusal. The backup key is
called `configured` only where the backup itself would accept its destination and key: by the storage-only form,
given the backup root and run as the account that owns it (the daily backup's account); otherwise it is `unknown`,
`absent` or `invalid`. The network-only form reports the host's listening addresses and ports and lists the firewall,
network separation and remote administration checks an operator makes; it too is a report, never a refusal.
"""
from __future__ import annotations

import argparse
import hashlib
import ipaddress
import json
import os
from pathlib import Path
import re
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
BACKUP_KEY_STATES = ("configured", "absent", "invalid", "unknown")


def _read(args):
    """One read of the report, through the caller's command channel. Whatever refuses or fails it (a missing tool, a
    protected entry that admits only its fixed commands) makes that answer unknown; the report never raises."""
    try:
        result = ops.run(args, check=False, timeout=30)
        return result.stdout.decode("utf-8", "replace") if result.returncode == 0 else None
    except Exception:
        return None


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


def backup_key_state(backup_root=None, checkout=None):
    """What the daily backup into backup_root would say of its destination and key, by the backup's own admission
    (ops.backup_admission: the destination outside the checkout and, where it exists, this account's private
    directory; the same configuration and paths; age encrypting and decrypting with the key). configured: the backup,
    run by this account, gets past that admission; absent: no configuration file; invalid: the admission refuses, or
    the configuration cannot be looked at; unknown: this call cannot speak for the backup - no backup root was given
    (the configuration and key file are then only read, nothing is run), or the backup root belongs to another
    account (the backup runs as its owner, which may not read what this account reads). checkout: the installation's
    checkout when this code runs from another copy."""
    try:
        if not Path(os.environ.get("KIN_BACKUP_ENCRYPTION") or ops.BACKUP_ENCRYPTION_CONFIG).exists():
            return "absent"
        if backup_root is None:
            ops.backup_key()
            return "unknown"
    except Exception:
        return "invalid"
    try:
        root = Path(backup_root)
        if os.name == "posix" and root.exists() and root.stat().st_uid != os.geteuid():
            return "unknown"
    except Exception:
        return "unknown"
    try:
        ops.backup_admission(backup_root, checkout=checkout)
    except Exception:
        return "invalid"
    return "configured"


def storage_encryption(backup_root=None, checkout=None):
    """The report: {"status", "locations": [{"location", "status", "detail"}], "backup_encryption"}. backup_root: the
    actual backup root (its storage is reported, and the backup key is judged for a backup into it); checkout: the
    installation's checkout when this code runs from another copy (see backup_key_state)."""
    if not sys.platform.startswith("linux"):
        locations = [{"location": "host", "status": "unknown", "detail": "not Linux"}]
    else:
        seen, locations = {}, []
        for label, path in [*data_locations(), ("backup root", str(backup_root) if backup_root else None)]:
            status, detail = location_encryption(path, seen)
            locations.append({"location": label, "status": status, "detail": detail})
    states = {row["status"] for row in locations}
    status = "encrypted" if states == {"encrypted"} else "not-detected" if "not-detected" in states else "unknown"
    return {"status": status, "locations": locations,
            "backup_encryption": backup_key_state(backup_root or None, checkout)}


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


# ── Network access (read-only report; a warning, never a refusal; runbook "Network access") ──
# One rule: an endpoint is judged only by the bind address this host reports for it. Loopback (127.0.0.0/8, ::1 and
# IPv4-mapped loopback) is "loopback"; any other address (a wildcard, a private, link-local or interface-scoped one) is
# "exposed", except the site proxy's own TCP 80->80 and 443->443 mappings on that address, which are "public-web". The
# endpoints are the host's listening TCP and bound UDP sockets (ss, IPv4 and IPv6 read apart) and the ports the local
# Docker publishes for running containers (a published port can have no socket of its own). The overall status is
# "unknown" when either source could not be read completely (not Linux, a missing or failing command, a remote Docker,
# output it does not parse); then "exposed" when an endpoint is; else "web-only". What the host cannot show - the cloud
# or upstream firewall, host firewall rules, the network boundary, how remote administration is authenticated - is an
# operator row, never a pass or a fail.
NETWORK_STATES = ("web-only", "exposed", "unknown")
NETWORK_BINDINGS = ("loopback", "public-web", "exposed")
PROXY_CONTAINER, PROXY_SERVICE = "/kin-proxy", "proxy"
PUBLIC_WEB = {("tcp", "80", "80"), ("tcp", "443", "443")}
NETWORK_OPERATOR_CHECKS = (
    ("firewall", "Compare the cloud and host firewall rules (IPv4 and IPv6, and Docker's forwarding rules) with the "
                 "listeners: inbound open only to TCP 80 and 443 and to the remote-administration path."),
    ("network-separation", "From a machine outside the server, the database, Orthanc and Keycloak ports do not answer; "
                           "the hospital Gateway's DICOM port answers only inside the hospital network."),
    ("remote-administration", "SSH by key only, from the named administration addresses; Keycloak and Orthanc "
                              "administration only through an SSH tunnel to their loopback ports."),
)


def _endpoint(protocol, host, port, family=None):
    """(protocol, address, port) of one endpoint as a source names it, or None when it cannot be placed. The address is
    one string: brackets dropped, a %interface kept, ss's wildcard `*` named by the family it was read under (Docker
    names its own); it must be an IP address."""
    if protocol not in ("tcp", "udp", "sctp") or not (type(port) is str and port.isdigit()) or type(host) is not str:
        return None
    if host.startswith("["):
        address, _, interface = host[1:].partition("]")
        if interface and not interface.startswith("%"):
            return None
    else:
        address, _, name = host.partition("%")
        interface = "%" + name if name else ""
    if address == "*" and family in (4, 6):
        address = "0.0.0.0" if family == 4 else "::"
    address = address.lower()
    try:
        ipaddress.ip_address(address)
    except ValueError:
        return None
    return protocol, address + interface, port


def _is_loopback(address):
    ip = ipaddress.ip_address(address.split("%", 1)[0])
    mapped = getattr(ip, "ipv4_mapped", None)
    return ip.is_loopback or bool(mapped and mapped.is_loopback)


# The one rule for both sources: every entry that can be placed is kept; an entry that cannot (an unreadable line, a
# binding without its address or port), a failed or refused command, or a command that warns (ss exits 0 after an
# interrupted dump, saying so on stderr) makes that source incomplete - never a reason to drop what was read, including
# what a command printed before it exited non-zero (docker inspect of a container that has gone prints the others).
def _socket_rows(family):
    """([(protocol, address, port)] of the listening TCP and bound UDP sockets of one address family, complete)."""
    try:
        result = ops.run(["ss", "-H", "-l", "-n", "-t", "-u", "-" + str(family)], check=False, timeout=30)
        out, complete = result.stdout.decode("utf-8", "replace"), result.returncode == 0 and not result.stderr.strip()
    except Exception:
        return [], False
    rows = []
    for line in out.splitlines():
        if not line.strip():
            continue
        fields = line.split()
        host, _, port = fields[4].rpartition(":") if len(fields) >= 6 else ("", "", "")
        row = _endpoint(fields[0], host, port, family)
        if row is None:
            complete = False
        else:
            rows.append(row)
    return rows, complete


def _published_rows():
    """([(protocol, address, host port, container port, container, site proxy)] of the ports the local Docker
    publishes for its running containers, complete). A remote Docker is not asked."""
    try:
        ops.require_local_docker()
    except Exception:
        return [], False
    ids = _read(["docker", "ps", "-q", "--no-trunc"])
    if ids is None:
        return [], False
    if not ids.split():
        return [], True
    try:
        result = ops.run(["docker", "inspect", *ids.split()], check=False, timeout=30)
        items = json.loads(result.stdout.decode("utf-8", "replace") or "")
    except Exception:
        return [], False
    if type(items) is not list:
        return [], False
    rows, complete = [], result.returncode == 0 and len(items) == len(ids.split())
    for item in items:
        ports = (item.get("NetworkSettings") or {}).get("Ports", False) if type(item) is dict else False
        if not (ports is None or type(ports) is dict):
            complete = False
            continue
        labels = (item.get("Config") or {}).get("Labels") or {}
        name = str(item.get("Name") or "").lstrip("/") or None
        proxy = (item.get("Name") == PROXY_CONTAINER and labels.get("com.docker.compose.service") == PROXY_SERVICE
                 and labels.get("com.docker.compose.project.working_dir") == str(ops.ROOT))
        for target, bindings in (ports or {}).items():
            number, _, protocol = str(target).partition("/")
            if not (number.isdigit() and (bindings is None or type(bindings) is list)):
                complete = False
                continue
            for binding in bindings or []:
                binding = binding if type(binding) is dict else {}
                row = _endpoint(protocol, binding.get("HostIp"), binding.get("HostPort"))
                if row is None:
                    complete = False
                else:
                    rows.append((*row, number, name, proxy))
    return rows, complete

def network_access():
    """The report: {"status", "listeners": [{"protocol", "address", "port", "binding", "container"}],
    "unreadable": [source...], "operator_checks": [{"check", "status", "detail"}]}."""
    unreadable, endpoints = [], {}
    if not sys.platform.startswith("linux"):
        unreadable += ["sockets", "docker"]
    else:
        for family in (4, 6):
            rows, complete = _socket_rows(family)
            if not complete:
                unreadable.append("sockets")
            for protocol, address, port in rows:
                endpoints.setdefault((protocol, address, port), {"container": None, "public": False})
        published, complete = _published_rows()
        if not complete:
            unreadable.append("docker")
        for protocol, address, port, target, container, proxy in published:
            entry = endpoints.setdefault((protocol, address, port), {"container": None, "public": False})
            entry["container"] = entry["container"] or container
            entry["public"] = entry["public"] or (proxy and (protocol, port, target) in PUBLIC_WEB)
    listeners = []
    for (protocol, address, port), entry in sorted(endpoints.items(), key=lambda item: (int(item[0][2]), item[0])):
        binding = "loopback" if _is_loopback(address) else "public-web" if entry["public"] else "exposed"
        listeners.append({"protocol": protocol, "address": address, "port": int(port), "binding": binding,
                          "container": entry["container"]})
    unreadable = sorted(set(unreadable))
    status = ("unknown" if unreadable else "exposed" if any(row["binding"] == "exposed" for row in listeners)
              else "web-only")
    return {"status": status, "listeners": listeners, "unreadable": unreadable,
            "operator_checks": [{"check": check, "status": "operator", "detail": detail}
                                for check, detail in NETWORK_OPERATOR_CHECKS]}


def network_line(report):
    def endpoint(row):
        address = "[" + row["address"] + "]" if ":" in row["address"] else row["address"]
        owner = " " + row["container"] if row["container"] else ""
        return row["protocol"] + " " + address + ":" + str(row["port"]) + "=" + row["binding"] + owner
    unread = "; not read: " + ", ".join(report["unreadable"]) if report["unreadable"] else ""
    return ("network access: " + report["status"] + " (" + ", ".join(endpoint(row) for row in report["listeners"])
            + ")" + unread + "; " + ", ".join(row["check"] for row in report["operator_checks"]) + ": operator check")


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


# The realm file binds no flow of its own, so Keycloak binds its built-in ones (keycloak/README.md, OTP는 스스로 등록한 계정만).
DEFAULT_LOGIN_FLOWS = {"browserFlow": "browser", "resetFlow": "reset credentials"}


def check_login_flows(policy):
    """No account is required to have OTP: the live realm signs in and resets passwords with Keycloak's built-in flows,
    which ask OTP only of an account that has one - as the realm file makes a new realm. An existing realm still bound to
    another flow (the earlier `kin browser` / `kin reset credentials`, which required OTP of administrators) is refused
    until it is bound back (keycloak/README.md, existing installations). What it cannot see: a built-in flow edited by hand."""
    require(type(policy) is dict, "The realm's login flows could not be read")
    for key, flow in DEFAULT_LOGIN_FLOWS.items():
        require(policy.get(key) == flow, "The realm's login flows are not Keycloak's built-in ones "
                "(keycloak/README.md: bind browser and reset credentials)")


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
    if "--network-only" in sys.argv[1:]:
        # The network access report alone: read-only, no request, no lock; exit 0 in every state.
        parser = argparse.ArgumentParser(description="Report listening addresses and ports and the operator checks; read-only")
        parser.add_argument("--network-only", action="store_true", required=True)
        parser.parse_args()
        report = network_access()
        print(network_line(report), file=sys.stderr, flush=True)
        print(json.dumps(report))
        return 0
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
