"""C1-2a safety contracts; synthetic Git/files only, no service mutations."""
import contextlib
import copy
import hashlib
import io
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import yaml

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
import ops_deploy_preflight as deploy
import ops_backup as ops


class _ComposeLoader(yaml.SafeLoader):
    pass


# The production overlay uses Compose's merge tags (!override, !reset); their value is what replaces the base entry.
_ComposeLoader.add_multi_constructor("!", lambda loader, suffix, node: (
    loader.construct_sequence(node) if isinstance(node, yaml.SequenceNode)
    else loader.construct_mapping(node) if isinstance(node, yaml.MappingNode) else loader.construct_scalar(node)))


def compose_api(name):
    return yaml.load((ROOT / name).read_text(encoding="utf-8"), Loader=_ComposeLoader)["services"]["api"]


STORAGE_REPORT = {"status": "not-detected", "backup_encryption": "configured", "locations": [
    {"location": "kin-db:/var/lib/postgresql/data", "status": "not-detected", "detail": "/dev/sdb1"},
    {"location": "backup root", "status": "unknown", "detail": "no host path"}]}


def age_program():
    """The pinned age the backup encrypts with (CI: KIN_TEST_AGE); its age-keygen sits beside it."""
    program = os.environ.get("KIN_TEST_AGE") or shutil.which("age")
    if not program:
        raise RuntimeError("Set KIN_TEST_AGE to the pinned age program: the backup key is judged by encrypting with it")
    return Path(program).absolute()


def backup_configuration(config, **changes):
    """A test-only backup encryption configuration at `config`, with a new age identity beside it."""
    age = age_program()
    key = config.with_name("backup-key.txt")
    key.unlink(missing_ok=True)
    subprocess.run([str(age.with_name("age-keygen" + age.suffix)), "-o", str(key)], check=True, capture_output=True)
    body = {"format": 1, "age": str(age), "current": "k1", "files": {"k1": str(key)}, **changes}
    config.write_text(json.dumps(body), encoding="utf-8")
    return body


def lsblk(*chain):
    """lsblk --json --inverse of a device built on `chain` (each a (name, type) or a list of such chains)."""
    def node(items):
        (name, kind), rest = items[0], items[1:]
        entry = {"name": name, "type": kind}
        if rest:
            entry["children"] = [node(branch) for branch in rest[0]] if isinstance(rest[0], list) else [node(rest)]
        return entry
    return json.dumps({"blockdevices": [node(chain)]})


class FakeHost:
    """findmnt, lsblk and docker inspect answers of one synthetic Linux host; anything else fails like a missing tool."""

    def __init__(self, mounts, filesystems, devices, btrfs=None):
        self.mounts, self.filesystems, self.devices, self.btrfs = mounts, filesystems, devices, btrfs or {}
        self.commands = []

    def run(self, args, **kwargs):
        self.commands.append(list(args))
        answer = None
        if args[:2] == ["docker", "inspect"] and args[2] in self.mounts:
            answer = json.dumps([{"Mounts": self.mounts[args[2]]}])
        elif args[0] == "findmnt" and args[-1] in self.filesystems:
            source, fstype, uuid_ = self.filesystems[args[-1]]
            answer = json.dumps({"filesystems": [{"source": source, "fstype": fstype, "uuid": uuid_}]})
        elif args[0] == "lsblk" and args[-1] in self.devices:
            answer = self.devices[args[-1]]
        return SimpleNamespace(returncode=0 if answer is not None else 1, stdout=(answer or "").encode(), stderr=b"")

    def listdir(self, path):
        uuid_ = path.split("/")[4]
        if uuid_ not in self.btrfs:
            raise FileNotFoundError(path)
        return self.btrfs[uuid_]

    def report(self, backup_root=None):
        with patch.object(ops, "run", side_effect=self.run), patch.object(deploy.sys, "platform", "linux"), \
                patch.object(deploy.os, "listdir", side_effect=self.listdir), \
                patch.object(deploy, "backup_key_state", return_value="configured"):
            return deploy.storage_encryption(backup_root)


def volume(destination, source, *, rw=True, driver="local", kind="volume"):
    return {"Type": kind, "Destination": destination, "Source": source, "Driver": driver, "RW": rw}


def request():
    return {"version": 1, "previous_sha": "a" * 40, "target_sha": "b" * 40,
            "previous_api_image": "sha256:" + "c" * 64, "target_api_image": "sha256:" + "d" * 64,
            "compose_files": list(deploy.COMPOSE)}


def parsed(body):
    raw = json.dumps(body).encode()
    return deploy.parse_request(raw, hashlib.sha256(raw).hexdigest())


def container():
    return {"Name": "/kin-api", "Image": request()["previous_api_image"], "State": {"Running": True},
            "Config": {"User": "node", "Env": ["DEPLOYMENT_MODE=production", "AUTH_REQUIRED=true"],
                       "Labels": {"com.docker.compose.project.working_dir": str(ops.ROOT), "com.docker.compose.service": "api"}},
            "Mounts": [], "NetworkSettings": {"Ports": {"3000/tcp": None}},
            "HostConfig": {"NetworkMode": "fixture_default", "PortBindings": {}}}


def production_container():
    """kin-api as `docker inspect` reports the service docker-compose.yml + docker-compose.prod.yml declare: the overlay's
    volume list (its !override) as named volumes of project "kin", and the merged environment with every unset ${...}
    taking its default or a fixture value."""
    base, prod = compose_api("docker-compose.yml"), compose_api("docker-compose.prod.yml")
    good = container()
    good["Mounts"] = []
    for entry in prod["volumes"]:
        source, target, *mode = entry.split(":")
        good["Mounts"].append({"Type": "volume", "Name": "kin_" + source, "Source": "/var/lib/docker/volumes/kin_" + source + "/_data",
                               "Destination": target, "Driver": "local", "Mode": mode[0] if mode else "z",
                               "RW": "ro" not in (mode[0].split(",") if mode else [])})
    def value(text):
        return re.sub(r"\$\{[A-Z0-9_]+(?::-([^}]*)|:\?[^}]*)?\}", lambda m: m.group(1) if m.group(1) is not None else "fixture", str(text))
    good["Config"]["Env"] = [key + "=" + value(text) for key, text in {**base["environment"], **prod["environment"]}.items()]
    return good


class PreflightTests(unittest.TestCase):
    def test_01_strict_request_and_mutable_identity_refusal(self):
        self.assertEqual(parsed(request()), request())
        cases = [("version", True), ("target_sha", "main"), ("target_sha", "--help"),
                 ("target_sha", "b" * 40 + "\n"), ("target_sha", request()["previous_sha"]),
                 ("target_api_image", "kin-api:latest"), ("target_api_image", "sha256:" + "D" * 64),
                 ("compose_files", deploy.COMPOSE[:2]), ("compose_files", deploy.COMPOSE[::-1]), ("extra", "command")]
        for key, value in cases:
            with self.subTest(key=key, value=value):
                body = request(); body[key] = value
                with self.assertRaises(RuntimeError): parsed(body)
        body = request(); del body["previous_sha"]
        with self.assertRaises(RuntimeError): parsed(body)

    def test_02_hash_duplicate_size_and_type_refusal(self):
        raw = json.dumps(request()).encode()
        with self.assertRaises(RuntimeError): deploy.parse_request(raw, "0" * 64)
        for value in (b'{"version":1,"version":1}', b" " * 8193, b"[]", b"null"):
            with self.assertRaises(RuntimeError): deploy.parse_request(value, hashlib.sha256(value).hexdigest())

    def test_03_real_git_identity_dirty_and_compatibility(self):
        with tempfile.TemporaryDirectory() as folder, patch.object(ops, "ROOT", Path(folder)):
            def git(*args):
                return subprocess.check_output(["git", *args], cwd=folder, stderr=subprocess.PIPE).decode().strip()
            git("init"); git("config", "user.email", "fixture@example.invalid"); git("config", "user.name", "Fixture")
            for relative in deploy.PROTECTED:
                path = Path(folder) / relative
                if "." not in path.name:
                    path = path / "fixture.txt"
                path.parent.mkdir(parents=True, exist_ok=True); path.write_text("fixture\n")
            app = Path(folder) / "api/app.txt"; app.write_text("old\n")
            git("add", "--all"); git("commit", "-m", "previous")
            body = request(); body["previous_sha"] = git("rev-parse", "HEAD")
            app.write_text("new\n"); git("add", "api/app.txt"); git("commit", "-m", "target")
            body["target_sha"] = git("rev-parse", "HEAD")
            git("checkout", "--detach", body["previous_sha"])
            self.assertEqual(len(deploy.check_repository(body)), 2)
            (Path(folder) / "branding.png").write_bytes(b"preserve")
            self.assertEqual(len(deploy.check_repository(body)), 2)
            app.write_text("dirty\n")
            with self.assertRaisesRegex(RuntimeError, "dirty"): deploy.check_repository(body)
            app.write_text("old\n")
            git("checkout", "--detach", body["target_sha"])
            with self.assertRaisesRegex(RuntimeError, "Checkout"): deploy.check_repository(body)
            (Path(folder) / "api/prisma/fixture.txt").write_text("schema changed\n")
            git("add", "api/prisma/fixture.txt"); git("commit", "-m", "incompatible")
            body["target_sha"] = git("rev-parse", "HEAD")
            git("checkout", "--detach", body["previous_sha"])
            with self.assertRaisesRegex(RuntimeError, "compatibility"): deploy.check_repository(body)
            self.assertEqual((Path(folder) / "branding.png").read_bytes(), b"preserve")

    def test_04_image_identity_user_and_revision(self):
        identity = request()["target_api_image"]
        image = {"Id": identity, "Config": {"User": "node", "Labels": {"org.opencontainers.image.revision": "b" * 40}}}
        with patch.object(deploy, "api_tree", return_value="tree"):
            deploy.check_image(image, identity, "tree")
            for candidate in ({**image, "Id": "other"}, {**image, "Config": {"User": "root"}}):
                with self.assertRaises(RuntimeError): deploy.check_image(candidate, identity, "tree")
            with self.assertRaises(RuntimeError): deploy.check_image(image, identity, "different-tree")
        with self.assertRaises(RuntimeError): deploy.api_tree("--help")

    def test_05_running_target_and_exposure_refusal(self):
        good = container(); deploy.check_running_api(good, request()["previous_api_image"])
        changes = [("Image", "other"), ("State", {"Running": False}), ("Mounts", [{}]),
                   ("NetworkSettings", {}), ("NetworkSettings", {"Ports": {"3000/tcp": [{"HostPort": "3000"}]}}),
                   ("HostConfig", {"NetworkMode": "host"}), ("HostConfig", {"NetworkMode": "bridge", "PortBindings": {"3000/tcp": [{}]}})]
        for key, value in changes:
            bad = copy.deepcopy(good); bad[key] = value
            with self.subTest(key=key), self.assertRaises(RuntimeError): deploy.check_running_api(bad, request()["previous_api_image"])
        for key, value in (("User", "root"), ("Env", ["DEPLOYMENT_MODE=production", "AUTH_REQUIRED=false"]), ("Labels", {})):
            bad = copy.deepcopy(good); bad["Config"][key] = value
            with self.assertRaises(RuntimeError): deploy.check_running_api(bad, request()["previous_api_image"])

    def test_05b_emr_running_api_holds_only_its_state_volume_and_runtime_role(self):
        """EMR-B1: after the storage is installed the API runs with exactly its state volume and the runtime role."""
        good = container()
        good["Mounts"] = [{"Type": "volume", "Name": "kin_emr-state", "Destination": deploy.EMR_STATE, "RW": True}]
        good["Config"]["Env"] += ["DATABASE_URL=postgresql://kin_runtime:fixture@db:5432/kin", "KIN_EMR_STATE_DIR=" + deploy.EMR_STATE]
        deploy.check_running_api(good, request()["previous_api_image"], emr=True)
        with self.assertRaises(RuntimeError): deploy.check_running_api(good, request()["previous_api_image"])
        for mounts in ([], [{**good["Mounts"][0], "Type": "bind"}], [{**good["Mounts"][0], "Destination": "/app"}],
                       good["Mounts"] * 2, [{**good["Mounts"][0], "RW": False}]):
            bad = copy.deepcopy(good); bad["Mounts"] = mounts
            with self.subTest(mounts=mounts), self.assertRaises(RuntimeError):
                deploy.check_running_api(bad, request()["previous_api_image"], emr=True)
        # CD-09-P/D: the retention ledger volume of docker-compose.prod.yml beside it, in either order; never alone, as a
        # host path, read-only or twice.
        ledger = {"Type": "volume", "Name": "kin_purpose-ledger", "Destination": deploy.RETENTION_LEDGER, "RW": True}
        for mounts in ([*good["Mounts"], ledger], [ledger, *good["Mounts"]]):
            with_ledger = copy.deepcopy(good); with_ledger["Mounts"] = mounts
            deploy.check_running_api(with_ledger, request()["previous_api_image"], emr=True)
        for mounts in ([ledger], [*good["Mounts"], {**ledger, "Type": "bind"}], [*good["Mounts"], {**ledger, "RW": False}],
                       [*good["Mounts"], ledger, ledger], [*good["Mounts"], ledger, {**ledger, "Destination": "/srv"}]):
            bad = copy.deepcopy(good); bad["Mounts"] = mounts
            with self.subTest(mounts=mounts), self.assertRaises(RuntimeError):
                deploy.check_running_api(bad, request()["previous_api_image"], emr=True)
        # The ledger mirror (docker-compose.prod.yml): its own read-write named volume beside the ledger's, named by the
        # server's setting. Never without the ledger, as a host path, read-only, twice, unnamed by the setting, or named
        # by a setting with no volume under it.
        mirror = {"Type": "volume", "Name": "kin_ledger-mirror", "Destination": deploy.LEDGER_MIRROR, "RW": True}
        named = ["KIN_LEDGER_MIRROR_DIR=" + deploy.LEDGER_MIRROR]
        for mounts in ([*good["Mounts"], ledger, mirror], [mirror, ledger, *good["Mounts"]]):
            mirrored = copy.deepcopy(good); mirrored["Mounts"] = mounts; mirrored["Config"]["Env"] += named
            deploy.check_running_api(mirrored, request()["previous_api_image"], emr=True)
        for mounts, env in (([*good["Mounts"], mirror], named), ([*good["Mounts"], ledger, {**mirror, "Type": "bind"}], named),
                            ([*good["Mounts"], ledger, {**mirror, "RW": False}], named), ([*good["Mounts"], ledger, mirror, mirror], named),
                            ([*good["Mounts"], ledger, mirror], []), ([*good["Mounts"], ledger], named),
                            ([*good["Mounts"], ledger, mirror], ["KIN_LEDGER_MIRROR_DIR=/var/lib/kin-purpose"])):
            bad = copy.deepcopy(good); bad["Mounts"] = mounts; bad["Config"]["Env"] += env
            with self.subTest(mounts=mounts, env=env), self.assertRaises(RuntimeError):
                deploy.check_running_api(bad, request()["previous_api_image"], emr=True)
        for env in (["DATABASE_URL=postgresql://kin:fixture@db:5432/kin"], ["POSTGRES_PASSWORD=fixture"],
                    ["KIN_EMR_STATE_DIR=/tmp"], ["DATABASE_URL=not a url::"]):
            bad = copy.deepcopy(good); bad["Config"]["Env"] = good["Config"]["Env"] + env
            with self.subTest(env=env[0].split("=")[0]), self.assertRaises(RuntimeError):
                deploy.check_running_api(bad, request()["previous_api_image"], emr=True)

    def test_05c_the_production_compose_api_passes_and_orthanc_db_is_read_only_only(self):
        """deploy-checklist-20261106 B: the API docker-compose.prod.yml declares (its EMR state, retention ledger and mirror
        volumes and Orthanc's database read-only for MG-LOADING's frame reads) passes the running-API check, in any order.
        Orthanc's database is allowed read-only and only so; nothing else read-only, no host path, never twice."""
        good = production_container()
        image = request()["previous_api_image"]
        destinations = sorted(m["Destination"] for m in good["Mounts"])
        self.assertEqual(destinations, sorted([deploy.EMR_STATE, deploy.RETENTION_LEDGER, deploy.LEDGER_MIRROR, deploy.ORTHANC_DB]))
        self.assertEqual([m["Destination"] for m in good["Mounts"] if not m["RW"]], [deploy.ORTHANC_DB])
        deploy.check_running_api(good, image, emr=True)
        reordered = copy.deepcopy(good); reordered["Mounts"].reverse()
        deploy.check_running_api(reordered, image, emr=True)
        # A release before MG-LOADING runs without it.
        without = copy.deepcopy(good); without["Mounts"] = [m for m in good["Mounts"] if m["Destination"] != deploy.ORTHANC_DB]
        deploy.check_running_api(without, image, emr=True)
        orthanc = next(m for m in good["Mounts"] if m["Destination"] == deploy.ORTHANC_DB)
        ledger = next(m for m in good["Mounts"] if m["Destination"] == deploy.RETENTION_LEDGER)
        others = [m for m in good["Mounts"] if m is not orthanc]
        for label, mounts in (
                ("orthanc db writable", [*others, {**orthanc, "Mode": "z", "RW": True}]),
                ("orthanc db as a host path", [*others, {**orthanc, "Type": "bind", "Source": "/srv/orthanc"}]),
                ("orthanc db twice", [*good["Mounts"], orthanc]),
                ("orthanc db read-only at another path", [*others, {**orthanc, "Destination": "/srv/orthanc"}]),
                ("orthanc db read-only plus another read-only volume", [*good["Mounts"], {**orthanc, "Destination": "/app/dist"}]),
                ("ledger read-only", [m for m in good["Mounts"] if m is not ledger] + [{**ledger, "Mode": "ro", "RW": False}]),
                ("unknown write mode", [*others, {**orthanc, "RW": None}]),
                ("non-boolean write mode", [*others, {**orthanc, "RW": 0}]),
                ("orthanc db only", [orthanc])):
            bad = copy.deepcopy(good); bad["Mounts"] = mounts
            with self.subTest(label), self.assertRaises(RuntimeError):
                deploy.check_running_api(bad, image, emr=True)
        # The API-only path for a release without the EMR storage still refuses any mount.
        with self.assertRaises(RuntimeError):
            deploy.check_running_api(good, image)

    def test_03b_emr_introduction_is_never_api_only(self):
        """EMR-B1: a target that brings the EMR storage is refused before any other compatibility check passes it."""
        with tempfile.TemporaryDirectory() as folder, patch.object(ops, "ROOT", Path(folder)):
            def git(*args):
                return subprocess.check_output(["git", *args], cwd=folder, stderr=subprocess.PIPE).decode().strip()
            git("init"); git("config", "user.email", "fixture@example.invalid"); git("config", "user.name", "Fixture")
            for relative in deploy.PROTECTED:
                path = Path(folder) / relative
                if "." not in path.name:
                    path = path / "fixture.txt"
                path.parent.mkdir(parents=True, exist_ok=True); path.write_text("fixture\n")
            (Path(folder) / "api/app.txt").write_text("old\n")
            git("add", "--all"); git("commit", "-m", "previous")
            body = request(); body["previous_sha"] = git("rev-parse", "HEAD")
            migration = Path(folder) / deploy.EMR_MIGRATION
            migration.parent.mkdir(parents=True); migration.write_text("-- synthetic\n")
            git("add", "--all"); git("commit", "-m", "emr")
            body["target_sha"] = git("rev-parse", "HEAD")
            git("checkout", "--detach", body["previous_sha"])
            with self.assertRaisesRegex(RuntimeError, "EMR-B storage requires provisioning"): deploy.check_repository(body)
            self.assertFalse(deploy.has_emr_storage(body["previous_sha"]))
            self.assertTrue(deploy.has_emr_storage(body["target_sha"]))
            # Both sides already carry it: the ordinary API-only boundary decides (here an unchanged one).
            git("checkout", "--detach", body["target_sha"])
            (Path(folder) / "api/app.txt").write_text("new\n"); git("add", "api/app.txt"); git("commit", "-m", "next")
            later = dict(body, previous_sha=body["target_sha"], target_sha=git("rev-parse", "HEAD"))
            git("checkout", "--detach", later["previous_sha"])
            self.assertEqual(len(deploy.check_repository(later)), 2)

    def test_06_backup_lock_contention_and_failure_cleanup(self):
        with tempfile.TemporaryDirectory() as folder, patch.object(ops, "ROOT", Path(folder)):
            with ops.lock(), patch.object(ops, "require_local_docker") as probe:
                with self.assertRaises(FileExistsError): deploy.preflight(request())
                probe.assert_not_called()
                source = "import sys,pathlib;sys.path.insert(0,sys.argv[1]);import ops_backup as o;o.ROOT=pathlib.Path(sys.argv[2]);\nwith o.lock(): pass"
                child = subprocess.run([sys.executable, "-c", source, str(Path(ops.__file__).parent), folder], capture_output=True)
                self.assertNotEqual(child.returncode, 0)
                self.assertIn(b"FileExistsError", child.stderr)
            with patch.object(ops, "require_local_docker", side_effect=RuntimeError("failure")):
                with self.assertRaises(RuntimeError): deploy.preflight(request())
            self.assertFalse((Path(folder) / ".kin-ops.lock").exists())

    def test_07_foreign_lock_is_preserved(self):
        with tempfile.TemporaryDirectory() as folder, patch.object(ops, "ROOT", Path(folder)):
            path = Path(folder) / ".kin-ops.lock"
            with self.assertRaisesRegex(RuntimeError, "ownership"):
                with ops.lock(): path.write_text("another-owner")
            self.assertEqual(path.read_text(), "another-owner")

    def test_08_success_is_only_observation_and_queries(self):
        body = request()
        with tempfile.TemporaryDirectory() as folder, patch.object(ops, "ROOT", Path(folder)), \
                patch.object(ops, "require_local_docker"), \
                patch.object(deploy, "check_repository", return_value={body["previous_sha"]: "old", body["target_sha"]: "new"}), \
                patch.object(deploy, "check_image"), patch.object(deploy, "check_running_api"), \
                patch.object(deploy, "storage_encryption", return_value=STORAGE_REPORT), \
                contextlib.redirect_stderr(io.StringIO()) as line, \
                patch.object(ops, "text", return_value='[{}]') as commands:
            result = deploy.preflight(body)
        self.assertTrue(result["preflight_passed"])
        self.assertFalse(result["deployment_authorized"])
        self.assertFalse(result["automatic_rollback_authorized"])
        self.assertEqual(result["storage_encryption"], STORAGE_REPORT, "reported, and the preflight still passes")
        self.assertEqual(line.getvalue().strip(), "storage encryption: not-detected (kin-db:/var/lib/postgresql/data=not-detected, "
                                                  "backup root=unknown); backup encryption: configured")
        self.assertEqual([call.args[0] for call in commands.call_args_list], [
            ["docker", "image", "inspect", body["previous_api_image"]],
            ["docker", "image", "inspect", body["target_api_image"]], ["docker", "inspect", "kin-api"]])

    def test_09_cli_rejects_secret_input_without_echo_or_lock(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "request.json"; path.write_text('{"SECRET": "must-not-leak"}')
            result = subprocess.run([sys.executable, deploy.__file__, str(path), "--request-sha256", "0" * 64], capture_output=True)
            self.assertEqual(result.returncode, 1)
            self.assertEqual(result.stdout, b"")
            self.assertNotIn(b"must-not-leak", result.stderr)
            self.assertFalse(json.loads(result.stderr)["deployment_authorized"])


class StorageEncryptionTests(unittest.TestCase):
    """The storage report: every writable data location of the site and the backup root, each encrypted only when every
    device under it reaches a crypt layer; a warning in the observation, never a refusal."""
    PG, ORTHANC, STATE = "/var/lib/docker/volumes/kin_pg/_data", "/var/lib/docker/volumes/kin_orthanc/_data", "/var/lib/docker/volumes/kin_state/_data"
    LUKS_LVM = lsblk(("vg-data", "lvm"), ("luks-1", "crypt"), ("sda3", "part"), ("sda", "disk"))
    PLAIN = lsblk(("sdb1", "part"), ("sdb", "disk"))

    def mounts(self):
        return {"kin-db": [volume("/var/lib/postgresql/data", self.PG), volume("/var/lib/postgresql/emr-access", self.PG)],
                "kin-orthanc": [volume("/var/lib/orthanc/db", self.ORTHANC), volume("/etc/orthanc", "/srv/site/orthanc.json", rw=False, kind="bind"),
                                {"Type": "tmpfs", "Destination": "/tmp", "RW": True}],
                "kin-api": [volume("/var/lib/kin-emr", self.STATE), volume("/var/lib/orthanc/db", self.ORTHANC, rw=False)]}

    def statuses(self, report):
        return {row["location"]: row["status"] for row in report["locations"]}

    def test_luks_under_lvm_everywhere_is_encrypted(self):
        filesystems = {path: ("/dev/mapper/vg-data", "ext4", "u1") for path in (self.PG, self.ORTHANC, self.STATE, "/srv/backups")}
        host = FakeHost(self.mounts(), filesystems, {"/dev/mapper/vg-data": self.LUKS_LVM})
        report = host.report("/srv/backups")
        self.assertEqual(report["status"], "encrypted")
        self.assertEqual(self.statuses(report), {"kin-db:/var/lib/postgresql/data": "encrypted", "kin-db:/var/lib/postgresql/emr-access": "encrypted",
                                                 "kin-orthanc:/var/lib/orthanc/db": "encrypted", "kin-api:/var/lib/kin-emr": "encrypted",
                                                 "backup root": "encrypted"}, "writable data only: no read-only bind, no tmpfs")
        self.assertEqual(sum(command[0] == "lsblk" for command in host.commands), 1, "one device is examined once")
        self.assertTrue(deploy.storage_valid(report))

    def test_one_plain_location_is_not_detected_and_an_unseen_one_unknown(self):
        filesystems = {self.PG: ("/dev/mapper/vg-data", "ext4", "u1"), self.ORTHANC: ("/dev/sdb1", "xfs", "u2"),
                       self.STATE: ("/dev/mapper/vg-data", "ext4", "u1")}
        host = FakeHost(self.mounts(), filesystems, {"/dev/mapper/vg-data": self.LUKS_LVM, "/dev/sdb1": self.PLAIN})
        report = host.report()
        self.assertEqual(report["status"], "not-detected")
        self.assertEqual(self.statuses(report)["kin-orthanc:/var/lib/orthanc/db"], "not-detected")
        self.assertEqual(self.statuses(report)["backup root"], "unknown", "no backup root given")
        self.assertEqual(deploy.storage_line(report).split(";")[0].split(" (")[0], "storage encryption: not-detected")

    def test_a_volume_built_on_one_encrypted_and_one_plain_device_is_not_encrypted(self):
        spanning = lsblk(("vg-data", "lvm"), [[("luks-1", "crypt"), ("sda3", "part")], [("sdc1", "part"), ("sdc", "disk")]])
        filesystems = {path: ("/dev/mapper/vg-data", "ext4", "u1") for path in (self.PG, self.ORTHANC, self.STATE, "/srv/backups")}
        report = FakeHost(self.mounts(), filesystems, {"/dev/mapper/vg-data": spanning}).report("/srv/backups")
        self.assertEqual(set(self.statuses(report).values()), {"not-detected"})

    def test_btrfs_subvolumes_and_every_member_device(self):
        filesystems = {path: ("/dev/mapper/luks-a[/@kin]", "btrfs", "b1") for path in (self.PG, self.ORTHANC, self.STATE, "/srv/backups")}
        devices = {"/dev/dm-0": lsblk(("luks-a", "crypt"), ("sda2", "part")), "/dev/dm-1": lsblk(("luks-b", "crypt"), ("sdb2", "part")),
                   "/dev/sdc2": self.PLAIN}
        self.assertEqual(FakeHost(self.mounts(), filesystems, devices, {"b1": ["dm-0", "dm-1"]}).report("/srv/backups")["status"], "encrypted")
        report = FakeHost(self.mounts(), filesystems, devices, {"b1": ["dm-0", "sdc2"]}).report("/srv/backups")
        self.assertEqual(report["status"], "not-detected", "one plain member device")
        self.assertEqual(FakeHost(self.mounts(), filesystems, devices).report("/srv/backups")["status"], "unknown", "members not readable")

    def test_what_this_host_cannot_see_is_unknown(self):
        mounts = self.mounts()
        mounts["kin-orthanc"][0] = volume("/var/lib/orthanc/db", "/remote", driver="nfs-driver")
        filesystems = {self.PG: ("overlay", "overlay", None), self.STATE: ("server:/export", "nfs4", None)}
        host = FakeHost(mounts, filesystems, {})
        report = host.report("/srv/missing")
        self.assertEqual(report["status"], "unknown")
        self.assertEqual(set(self.statuses(report).values()), {"unknown"})
        report = FakeHost({}, {}, {}).report()
        self.assertEqual([row["location"] for row in report["locations"]], [*deploy.STORAGE_CONTAINERS, "backup root"],
                         "a container that cannot be inspected is reported, not skipped")
        with patch.object(deploy.sys, "platform", "win32"), patch.object(deploy, "backup_key_state", return_value="absent"):
            report = deploy.storage_encryption("/srv/backups")
        self.assertEqual((report["status"], report["locations"][0]["detail"]), ("unknown", "not Linux"))
        self.assertTrue(deploy.storage_valid(report))

    def test_a_refused_or_failing_read_is_unknown_never_an_error(self):
        """The protected deployment entry admits only its fixed git/docker commands through ops.run: the report's other
        reads are refused there, and the observation must still be made (the report is a warning)."""
        def protected(args, *, input_data=None, timeout=60, check=True, **kwargs):
            if args[0] not in ("git", "docker") or kwargs:
                raise RuntimeError("Invalid protected deployment state")
            return SimpleNamespace(returncode=0, stdout=json.dumps([{"Mounts": [volume("/var/lib/postgresql/data", self.PG)]}]).encode())
        for failure in (protected, RuntimeError("daemon"), subprocess.TimeoutExpired("findmnt", 30), OSError("no tool")):
            with self.subTest(failure=type(failure).__name__), patch.object(ops, "run", side_effect=failure), \
                    patch.object(deploy.sys, "platform", "linux"), patch.object(deploy, "backup_key_state", return_value="absent"):
                report = deploy.storage_encryption("/srv/backups")
            self.assertEqual(report["status"], "unknown")
            self.assertTrue(deploy.storage_valid(report))
        with patch.object(ops, "backup_key", side_effect=KeyError("files")), tempfile.TemporaryDirectory() as folder:
            config = Path(folder) / "backup-encryption.json"
            config.write_text("{}")
            with patch.dict(os.environ, {"KIN_BACKUP_ENCRYPTION": str(config)}):
                self.assertEqual(deploy.backup_key_state(), "invalid")

    def test_backup_key_state(self):
        """`configured` is the backup's own verdict (ops.usable_backup_key) for the actual backup root and checkout:
        never said of a key the backup would refuse, and never without the backup root."""
        with tempfile.TemporaryDirectory() as folder:
            folder = Path(folder)
            config, root = folder / "keys" / "backup-encryption.json", folder / "backups"
            root.mkdir(mode=0o700)   # a backup root is its account's private directory; the admission refuses any other
            config.parent.mkdir()
            with patch.dict(os.environ, {"KIN_BACKUP_ENCRYPTION": str(config)}):
                self.assertEqual((deploy.backup_key_state(root), deploy.backup_key_state()), ("absent", "absent"))
                config.write_text("{}")
                self.assertEqual((deploy.backup_key_state(root), deploy.backup_key_state()), ("invalid", "invalid"))
                body = backup_configuration(config)
                self.assertEqual(deploy.backup_key_state(root), "configured")
                # Without the backup root the configuration and key are only read: nothing is run, nothing is said.
                with patch.object(ops, "age_bytes", side_effect=AssertionError("age was run")):
                    self.assertEqual(deploy.backup_key_state(), "unknown")
                    with patch.object(deploy.sys, "platform", "win32"):
                        self.assertEqual(deploy.storage_encryption()["backup_encryption"], "unknown")
                # The report passes the actual backup root and checkout on to that one check.
                with patch.object(deploy.sys, "platform", "win32"):
                    self.assertEqual(deploy.storage_encryption(root)["backup_encryption"], "configured")
                    self.assertEqual(deploy.storage_encryption(root, config.parent)["backup_encryption"], "invalid",
                                     "the key is inside the installation's checkout")
                    self.assertEqual(deploy.storage_encryption(config.parent)["backup_encryption"], "invalid",
                                     "the key is inside the backup root")
                    # The destination belongs to the same admission: a backup root inside the checkout is refused by
                    # the backup, so it is never reported as configured.
                    site = folder / "site"
                    self.assertEqual(deploy.storage_encryption(site / "backups", site)["backup_encryption"], "invalid")
                    self.assertEqual(deploy.storage_encryption(root, site)["backup_encryption"], "configured")
                    with self.assertRaisesRegex(RuntimeError, "outside the Git repository"):
                        ops.backup_admission(site / "backups", checkout=site)
                if os.name == "posix":
                    # The daily backup runs as the backup root's owner; another account cannot speak for it.
                    with patch.object(deploy.os, "geteuid", return_value=os.geteuid() + 1):
                        self.assertEqual(deploy.backup_key_state(root), "unknown")
                # A well-formed identity that age refuses (a mistyped key): the backup refuses it, so does the report.
                Path(body["files"]["k1"]).write_text("AGE-SECRET-KEY-1" + "Q" * 58 + "\n")
                self.assertEqual(deploy.backup_key_state(root), "invalid")
                with self.assertRaisesRegex(ops.BackupEncryptionError, "Backup encryption failed"):
                    ops.usable_backup_key(root)
                self.assertEqual(deploy.backup_key_state(), "unknown")
            # A configuration path this account cannot look at is reported, never raised out of the warning.
            with patch.object(deploy.Path, "exists", side_effect=PermissionError("denied")):
                self.assertEqual(deploy.backup_key_state(root), "invalid")
                with patch.object(deploy.sys, "platform", "win32"):
                    self.assertTrue(deploy.storage_valid(deploy.storage_encryption("/srv/backups")))
        for state in deploy.BACKUP_KEY_STATES:
            self.assertTrue(deploy.storage_valid({**STORAGE_REPORT, "backup_encryption": state}))
        self.assertFalse(deploy.storage_valid({**STORAGE_REPORT, "backup_encryption": "usable"}))

    @unittest.skipUnless(os.name == "posix", "POSIX execute permission")
    def test_an_age_program_that_cannot_run_or_does_not_encrypt_is_not_configured(self):
        with tempfile.TemporaryDirectory() as folder:
            folder = Path(folder)
            root = folder / "backups"
            root.mkdir(mode=0o700)
            (folder / "keys").mkdir()
            program = folder / "keys" / "age-copy"
            shutil.copyfile(age_program(), program)
            program.chmod(0o600)
            config = folder / "keys" / "backup-encryption.json"
            backup_configuration(config, age=str(program))
            with patch.dict(os.environ, {"KIN_BACKUP_ENCRYPTION": str(config)}):
                self.assertEqual(deploy.backup_key_state(root), "invalid")
                program.chmod(0o700)
                self.assertEqual(deploy.backup_key_state(root), "configured")
                program.write_bytes(b"#!/bin/sh\nexit 0\n")
                self.assertEqual(deploy.backup_key_state(root), "invalid", "a program that runs but does not encrypt")

    def test_storage_only_cli_reports_without_request_or_lock(self):
        with tempfile.TemporaryDirectory() as folder:
            env = {**os.environ, "KIN_BACKUP_ENCRYPTION": str(Path(folder) / "absent.json")}
            result = subprocess.run([sys.executable, deploy.__file__, "--storage-only", "--backup-root", folder],
                                    capture_output=True, env=env, cwd=folder)
        self.assertEqual(result.returncode, 0, result.stderr)
        report = json.loads(result.stdout)
        self.assertTrue(deploy.storage_valid(report))
        self.assertEqual(report["backup_encryption"], "absent")
        self.assertTrue(result.stderr.decode().startswith("storage encryption: "))
        self.assertFalse((ops.ROOT / ".kin-ops.lock").exists())


# ss -H -l -n -t -u as Ubuntu 24.04 prints it (iproute2 6.x; synthetic addresses only).
SS4 = """\
udp   UNCONN 0      0          127.0.0.53%lo:53         0.0.0.0:*
udp   UNCONN 0      0       10.0.0.5%ens5:68            0.0.0.0:*
tcp   LISTEN 0      4096           0.0.0.0:443          0.0.0.0:*
tcp   LISTEN 0      4096           0.0.0.0:80           0.0.0.0:*
tcp   LISTEN 0      4096         127.0.0.1:8042         0.0.0.0:*
tcp   LISTEN 0      4096         127.0.0.1:8080         0.0.0.0:*
tcp   LISTEN 0      4096     127.0.0.53%lo:53           0.0.0.0:*
tcp   LISTEN 0      4096           0.0.0.0:22           0.0.0.0:*
"""
SS6 = """\
udp   UNCONN 0      0     [fe80::1:2ff:fe03:405]%ens5:546      [::]:*
tcp   LISTEN 0      4096                    [::]:443          [::]:*
tcp   LISTEN 0      4096                    [::]:80           [::]:*
tcp   LISTEN 0      4096                       *:22              *:*
tcp   LISTEN 0      511       [::ffff:127.0.0.1]:9090            *:*
"""


def site_container(name, ports, *, service=None, working_dir=None):
    """docker inspect of one running container: name, Compose labels, published ports."""
    labels = {"com.docker.compose.service": service or name.split("-", 1)[-1],
              "com.docker.compose.project.working_dir": working_dir or str(ops.ROOT)}
    return {"Name": "/" + name, "Config": {"Labels": labels}, "NetworkSettings": {"Ports": ports}}


def published(*mappings):
    return [{"HostIp": address, "HostPort": port} for address, port in mappings]


SITE = [
    site_container("kin-proxy", {"80/tcp": published(("0.0.0.0", "80"), ("::", "80")),
                            "443/tcp": published(("0.0.0.0", "443"), ("::", "443"))}),
    site_container("kin-orthanc", {"8042/tcp": published(("127.0.0.1", "8042")), "4242/tcp": None}),
    site_container("kin-keycloak", {"8080/tcp": published(("127.0.0.1", "8080")), "8443/tcp": None, "9000/tcp": None}),
    site_container("kin-db", {"5432/tcp": None}),
    site_container("kin-api", {"3000/tcp": None}),
]


class FakeNetwork:
    """ss, docker context/ps/inspect answers of one synthetic Linux host; None answers fail like a missing tool."""

    def __init__(self, ss4=SS4, ss6=SS6, containers=SITE, context="unix:///var/run/docker.sock", ps=None, inspect=None,
                 warnings=None, exit_codes=None):
        self.warnings, self.exit_codes = warnings or {}, exit_codes or {}
        self.answers = {"ss4": ss4, "ss6": ss6, "context": context,
                        "ps": ps if ps is not None else ("\n".join("id%d" % i for i in range(len(containers))) + "\n"
                                                         if containers is not None else None),
                        "inspect": inspect if inspect is not None else (json.dumps(containers) if containers is not None else None)}
        self.commands = []

    def run(self, args, **kwargs):
        self.commands.append(list(args))
        key = ("ss" + args[-1][1:] if args[0] == "ss" else "context" if args[1:3] == ["context", "inspect"]
               else "ps" if args[1:2] == ["ps"] else "inspect" if args[1:2] == ["inspect"] else None)
        answer = self.answers.get(key)
        if answer is None and kwargs.get("check", True):
            raise RuntimeError(f"{args[0]} failed")
        return SimpleNamespace(returncode=self.exit_codes.get(key, 0 if answer is not None else 1),
                               stdout=(answer or "").encode(), stderr=self.warnings.get(key, "").encode())

    def report(self, platform="linux"):
        with patch.object(ops, "run", side_effect=self.run), patch.object(deploy.sys, "platform", platform), \
                patch.dict(os.environ, {"DOCKER_HOST": ""}):
            return deploy.network_access()


def bindings(report):
    return {(row["protocol"], row["address"], row["port"]): (row["binding"], row["container"]) for row in report["listeners"]}


class NetworkAccessTests(unittest.TestCase):
    def test_production_host_is_web_only_except_what_the_operator_names(self):
        report = FakeNetwork().report()
        seen = bindings(report)
        self.assertEqual(seen[("tcp", "0.0.0.0", 443)], ("public-web", "kin-proxy"))
        self.assertEqual(seen[("tcp", "::", 443)], ("public-web", "kin-proxy"))
        self.assertEqual(seen[("tcp", "0.0.0.0", 80)], ("public-web", "kin-proxy"))
        self.assertEqual(seen[("tcp", "::", 80)], ("public-web", "kin-proxy"))
        self.assertEqual(seen[("tcp", "127.0.0.1", 8042)], ("loopback", "kin-orthanc"))
        self.assertEqual(seen[("tcp", "127.0.0.1", 8080)], ("loopback", "kin-keycloak"))
        self.assertEqual(seen[("tcp", "127.0.0.53%lo", 53)], ("loopback", None))
        self.assertEqual(seen[("udp", "127.0.0.53%lo", 53)], ("loopback", None))
        self.assertEqual(seen[("tcp", "::ffff:127.0.0.1", 9090)], ("loopback", None), "IPv4-mapped loopback")
        # SSH and the DHCP clients are exposed: the host shows them, the operator names them.
        self.assertEqual(seen[("tcp", "0.0.0.0", 22)], ("exposed", None))
        self.assertEqual(seen[("tcp", "::", 22)], ("exposed", None), "ss's * under -6 is the IPv6 wildcard")
        self.assertEqual(seen[("udp", "10.0.0.5%ens5", 68)], ("exposed", None))
        self.assertEqual(seen[("udp", "fe80::1:2ff:fe03:405%ens5", 546)], ("exposed", None))
        self.assertEqual(len(report["listeners"]), 13, "every endpoint once (ss and Docker merged)")
        self.assertEqual(report["status"], "exposed")
        self.assertEqual(report["unreadable"], [])

    def test_only_sockets_and_the_site_proxy_on_80_and_443_is_web_only(self):
        ss4 = "".join(line + "\n" for line in SS4.splitlines() if ":22 " not in line and ":68 " not in line)
        ss6 = "".join(line + "\n" for line in SS6.splitlines() if ":22 " not in line and ":546 " not in line)
        report = FakeNetwork(ss4, ss6).report()
        self.assertEqual(report["status"], "web-only")
        self.assertEqual({row["binding"] for row in report["listeners"]}, {"public-web", "loopback"})

    def test_a_site_port_left_open_without_the_production_overlay_is_exposed_with_its_container(self):
        base = [site_container("kin-proxy", {"443/tcp": published(("0.0.0.0", "9443")), "80/tcp": published(("0.0.0.0", "8081"))}),
                site_container("kin-db", {"5432/tcp": published(("0.0.0.0", "5432"))}),
                site_container("kin-orthanc", {"8042/tcp": published(("0.0.0.0", "8042")), "4242/tcp": published(("0.0.0.0", "4242"))}),
                site_container("kin-keycloak", {"8080/tcp": published(("0.0.0.0", "8080"))}),
                site_container("kin-api", {"3000/tcp": published(("0.0.0.0", "3000"))})]
        # userland-proxy off: no socket of their own, Docker's list alone shows them.
        report = FakeNetwork("", "", base).report()
        seen = bindings(report)
        for port, name in ((9443, "kin-proxy"), (8081, "kin-proxy"), (5432, "kin-db"), (8042, "kin-orthanc"),
                           (4242, "kin-orthanc"), (8080, "kin-keycloak"), (3000, "kin-api")):
            self.assertEqual(seen[("tcp", "0.0.0.0", port)], ("exposed", name), port)
        self.assertEqual(report["status"], "exposed")

    def test_public_web_is_only_the_site_proxy_exact_tcp_mapping(self):
        cases = {
            "another container": site_container("other-proxy", {"443/tcp": published(("0.0.0.0", "443"))}, service="proxy"),
            "another checkout": site_container("kin-proxy", {"443/tcp": published(("0.0.0.0", "443"))}, working_dir="/srv/other"),
            "another service": site_container("kin-proxy", {"443/tcp": published(("0.0.0.0", "443"))}, service="web"),
            "another target port": site_container("kin-proxy", {"8443/tcp": published(("0.0.0.0", "443"))}),
            "udp": site_container("kin-proxy", {"443/udp": published(("0.0.0.0", "443"))}),
        }
        for label, item in cases.items():
            protocol = "udp" if label == "udp" else "tcp"
            report = FakeNetwork("", "", [item]).report()
            self.assertEqual(bindings(report)[(protocol, "0.0.0.0", 443)][0], "exposed", label)
            self.assertEqual(report["status"], "exposed", label)
        # The proxy's 443 on one address does not cover another process on another address or protocol.
        ss4 = "tcp LISTEN 0 4096 10.0.0.5:443 0.0.0.0:*\nudp UNCONN 0 0 0.0.0.0:443 0.0.0.0:*\n"
        seen = bindings(FakeNetwork(ss4, "", SITE[:1]).report())
        self.assertEqual(seen[("tcp", "10.0.0.5", 443)], ("exposed", None))
        self.assertEqual(seen[("udp", "0.0.0.0", 443)], ("exposed", None))
        self.assertEqual(seen[("tcp", "0.0.0.0", 443)], ("public-web", "kin-proxy"))
        # A proxy published on loopback only is loopback, never public-web.
        local = [site_container("kin-proxy", {"443/tcp": published(("127.0.0.1", "443"))})]
        self.assertEqual(bindings(FakeNetwork("", "", local).report())[("tcp", "127.0.0.1", 443)], ("loopback", "kin-proxy"))

    def test_incomplete_observation_is_unknown_and_keeps_what_was_read(self):
        cases = {
            "ss missing": (FakeNetwork(ss4=None), ["sockets"]),
            "ss -6 fails": (FakeNetwork(ss6=None), ["sockets"]),
            "ss unparsed": (FakeNetwork(ss4="tcp LISTEN 0 4096 0.0.0.0\n"), ["sockets"]),
            "ss bad address": (FakeNetwork(ss4="tcp LISTEN 0 4096 nowhere:443 0.0.0.0:*\n"), ["sockets"]),
            "docker ps fails": (FakeNetwork(ps=None, inspect=None, containers=None), ["docker"]),
            "docker inspect fails": (FakeNetwork(ps="id0\n", inspect="not json"), ["docker"]),
            "docker inspect short": (FakeNetwork(ps="id0\nid1\n", inspect=json.dumps(SITE[:1])), ["docker"]),
            "docker ports missing": (FakeNetwork(containers=[{"Name": "/kin-proxy", "Config": {}, "NetworkSettings": {}}]), ["docker"]),
            "remote docker": (FakeNetwork(context="tcp://192.0.2.10:2376"), ["docker"]),
            "ss warns (interrupted dump, exit 0)": (FakeNetwork(warnings={"ss6": "Dump was interrupted and may be inconsistent.\n"}),
                                                   ["sockets"]),
            "proxy binding without HostIp": (FakeNetwork("", "", [site_container("kin-proxy", {"443/tcp": [{"HostPort": "443"}]})]),
                                             ["docker"]),
        }
        for label, (host, unreadable) in cases.items():
            report = host.report()
            self.assertEqual(report["status"], "unknown", label)
            self.assertEqual(report["unreadable"], unreadable, label)
            self.assertEqual(len(report["operator_checks"]), 3, label)
        # What was read stays; with Docker unread, 80/443 is not credited to the proxy.
        seen = bindings(FakeNetwork(ps=None, inspect=None, containers=None).report())
        self.assertEqual(seen[("tcp", "0.0.0.0", 443)], ("exposed", None))
        self.assertEqual(seen[("tcp", "127.0.0.1", 8042)], ("loopback", None))
        remote = FakeNetwork(context="tcp://192.0.2.10:2376")
        remote.report()
        self.assertFalse([c for c in remote.commands if c[1:2] in (["ps"], ["inspect"])], "a remote Docker is not asked")
        with patch.dict(os.environ, {"DOCKER_HOST": "tcp://192.0.2.10:2376"}), patch.object(ops, "run", side_effect=AssertionError):
            with patch.object(deploy.sys, "platform", "linux"), patch.object(deploy, "_socket_rows", return_value=([], True)):
                self.assertEqual(deploy.network_access()["unreadable"], ["docker"])
        report = FakeNetwork().report(platform="win32")
        self.assertEqual((report["status"], report["listeners"], report["unreadable"]), ("unknown", [], ["docker", "sockets"]))

    def test_an_entry_that_cannot_be_placed_keeps_every_other_row(self):
        # ss: a good line, then one it cannot read.
        ss4 = "tcp LISTEN 0 4096 192.0.2.7:5432 0.0.0.0:*\ntcp LISTEN 0 4096 garbled\n"
        report = FakeNetwork(ss4, "", []).report()
        self.assertEqual(bindings(report), {("tcp", "192.0.2.7", 5432): ("exposed", None)})
        self.assertEqual((report["status"], report["unreadable"]), ("unknown", ["sockets"]))
        # Docker: the IPv4 mapping stays when the routed-mode IPv6 entry has no host port.
        routed = [site_container("web-app", {"8080/tcp": [{"HostIp": "0.0.0.0", "HostPort": "8080"},
                                                     {"HostIp": "::", "HostPort": ""}]}, service="web")]
        report = FakeNetwork("", "", routed).report()
        self.assertEqual(bindings(report), {("tcp", "0.0.0.0", 8080): ("exposed", "web-app")})
        self.assertEqual((report["status"], report["unreadable"]), ("unknown", ["docker"]))
        # A proxy binding without its address is not placed, so it is never credited as public-web on 0.0.0.0.
        report = FakeNetwork("", "", [site_container("kin-proxy", {"443/tcp": [{"HostPort": "443"}]})]).report()
        self.assertEqual(report["listeners"], [])
        self.assertEqual(report["status"], "unknown")
        # ss's warning on an exit-0 dump keeps what it printed, and the source is incomplete.
        report = FakeNetwork(warnings={"ss4": "Dump was interrupted and may be inconsistent.\n"}).report()
        self.assertEqual(len(report["listeners"]), 13)
        self.assertEqual(report["status"], "unknown")

    def test_rows_printed_before_a_failing_exit_are_kept(self):
        # ss prints a whole row, then exits non-zero: the row stays, the source is incomplete.
        ss4 = "tcp LISTEN 0 4096 192.0.2.7:5432 0.0.0.0:*\n"
        report = FakeNetwork(ss4, "", [], exit_codes={"ss4": 1}).report()
        self.assertEqual(bindings(report), {("tcp", "192.0.2.7", 5432): ("exposed", None)})
        self.assertEqual((report["status"], report["unreadable"]), ("unknown", ["sockets"]))
        # ...and a line it cannot read is still dropped, the source still incomplete.
        report = FakeNetwork("tcp LISTEN 0 4096 garbled\n", "", [], exit_codes={"ss4": 1}).report()
        self.assertEqual((report["status"], report["listeners"], report["unreadable"]), ("unknown", [], ["sockets"]))
        # docker inspect of two containers where one has gone: it prints the other's JSON and exits 1.
        found = [site_container("kin-db", {"5432/tcp": published(("192.0.2.7", "5432"))})]
        report = FakeNetwork("", "", ps="id0\nid1\n", inspect=json.dumps(found), exit_codes={"inspect": 1}).report()
        self.assertEqual(bindings(report), {("tcp", "192.0.2.7", 5432): ("exposed", "kin-db")})
        self.assertEqual((report["status"], report["unreadable"]), ("unknown", ["docker"]))
        # A failing inspect is incomplete even when it lists every container.
        report = FakeNetwork("", "", found, exit_codes={"inspect": 1}).report()
        self.assertEqual(bindings(report), {("tcp", "192.0.2.7", 5432): ("exposed", "kin-db")})
        self.assertEqual((report["status"], report["unreadable"]), ("unknown", ["docker"]))
        # Output it cannot parse is dropped and unknown.
        report = FakeNetwork("", "", ps="id0\n", inspect="[{", exit_codes={"inspect": 1}).report()
        self.assertEqual((report["status"], report["listeners"], report["unreadable"]), ("unknown", [], ["docker"]))

    def test_interface_scoped_wildcard(self):
        ss6 = "tcp LISTEN 0 4096 *%eth0:8443 *:*\n"
        ss4 = "udp UNCONN 0 0 *%eth0:5353 0.0.0.0:*\n"
        report = FakeNetwork(ss4, ss6, []).report()
        self.assertEqual(bindings(report), {("tcp", "::%eth0", 8443): ("exposed", None),
                                            ("udp", "0.0.0.0%eth0", 5353): ("exposed", None)})
        self.assertEqual(report["status"], "exposed")

    def test_empty_docker_and_unpublished_ports_are_ordinary(self):
        report = FakeNetwork("", "", containers=[]).report()
        self.assertEqual((report["status"], report["listeners"], report["unreadable"]), ("web-only", [], []))
        report = FakeNetwork("", "", containers=[site_container("kin-db", {"5432/tcp": None}), site_container("kin-api", None)]).report()
        self.assertEqual((report["status"], report["listeners"]), ("web-only", []))

    def test_operator_rows_are_never_judged(self):
        for host in (FakeNetwork(), FakeNetwork(ss4=None), FakeNetwork("", "", [])):
            checks = host.report()["operator_checks"]
            self.assertEqual([row["check"] for row in checks], ["firewall", "network-separation", "remote-administration"])
            self.assertEqual({row["status"] for row in checks}, {"operator"})

    def test_line_names_every_endpoint_and_the_operator_checks(self):
        line = deploy.network_line(FakeNetwork().report())
        self.assertTrue(line.startswith("network access: exposed (tcp 0.0.0.0:22=exposed, tcp [::]:22=exposed, "), line)
        self.assertIn("tcp 0.0.0.0:443=public-web kin-proxy", line)
        self.assertIn("tcp 127.0.0.1:8042=loopback kin-orthanc", line)
        self.assertTrue(line.endswith("; firewall, network-separation, remote-administration: operator check"), line)
        self.assertIn("; not read: sockets;", deploy.network_line(FakeNetwork(ss4=None).report()))

    def test_reads_only_ss_and_local_docker(self):
        host = FakeNetwork()
        host.report()
        self.assertEqual(host.commands, [
            ["ss", "-H", "-l", "-n", "-t", "-u", "-4"], ["ss", "-H", "-l", "-n", "-t", "-u", "-6"],
            ["docker", "context", "inspect", "--format", "{{.Endpoints.docker.Host}}"],
            ["docker", "ps", "-q", "--no-trunc"], ["docker", "inspect", *("id%d" % i for i in range(len(SITE)))]])

    def test_network_only_cli_reports_without_request_or_lock(self):
        with tempfile.TemporaryDirectory() as folder:
            result = subprocess.run([sys.executable, "-B", deploy.__file__, "--network-only"], capture_output=True, cwd=folder)
        self.assertEqual(result.returncode, 0, result.stderr)
        report = json.loads(result.stdout)
        self.assertEqual(set(report), {"status", "listeners", "unreadable", "operator_checks"})
        self.assertIn(report["status"], deploy.NETWORK_STATES)
        self.assertTrue(all(row["binding"] in deploy.NETWORK_BINDINGS for row in report["listeners"]))
        lines = result.stderr.decode().splitlines()
        self.assertEqual(len(lines), 1)
        self.assertTrue(lines[0].startswith("network access: "))
        self.assertFalse((ops.ROOT / ".kin-ops.lock").exists())


def rows(*spec):
    """Admin REST executions rows from (level, requirement, provider or None for a subflow[, config])."""
    out = []
    for level, requirement, provider, *config in spec:
        row = {"level": level, "requirement": requirement, "id": "generated-%d" % len(out), "displayName": "any name", "priority": 999}
        row.update({"authenticationFlow": True} if provider is None else {"providerId": provider})
        if config:
            row.update(authenticationConfig="generated-config", config=config[0])
        out.append(row)
    return out


class AdminMfaTests(unittest.TestCase):
    """keycloak/README.md 관리자 OTP 필수: the deploy refuses a realm whose browser or reset flow does not make OTP
    required for the admin role, before any change (L-01)."""
    ADMIN = {"condUserRole": "admin", "negate": "false"}
    NOT_ADMIN = {"condUserRole": "admin", "negate": "true"}
    # The administrator OTP step's authentication reference as Admin REST shows it: both values masked.
    REFERENCE = {"default.reference.value": "**********", "default.reference.maxAge": "**********"}
    AMR = {"protocolMapper": "oidc-amr-mapper", "config": {"id.token.claim": "false", "access.token.claim": "true",
                                                           "introspection.token.claim": "true"}}

    def setUp(self):
        self.realm = json.loads(deploy.REALM_FILE.read_text(encoding="utf-8"))

    def shipped(self):
        """A live read of a realm built from kin-realm.json, or by the README procedure (names, ids and priorities differ)."""
        configured = lambda requirement: (2, requirement, "conditional-user-configured")
        browser = rows((0, "ALTERNATIVE", "auth-cookie"), (0, "DISABLED", "auth-spnego"),
                       (0, "ALTERNATIVE", "identity-provider-redirector"), (0, "ALTERNATIVE", None),
                       (1, "CONDITIONAL", None), configured("REQUIRED"), (2, "ALTERNATIVE", "organization"),
                       (0, "ALTERNATIVE", None), (1, "REQUIRED", "auth-username-password-form"), (1, "CONDITIONAL", None),
                       configured("REQUIRED"), (2, "REQUIRED", "conditional-credential", {"credentials": "webauthn-passwordless"}),
                       (2, "ALTERNATIVE", "auth-otp-form"), (2, "DISABLED", "webauthn-authenticator"),
                       (2, "DISABLED", "auth-recovery-authn-code-form"), (2, "REQUIRED", "conditional-user-role", self.NOT_ADMIN),
                       (1, "CONDITIONAL", None), (2, "REQUIRED", "conditional-user-role", self.ADMIN),
                       (2, "REQUIRED", "auth-otp-form", dict(self.REFERENCE)))
        reset = rows((0, "REQUIRED", "reset-credentials-choose-user"), (0, "REQUIRED", "reset-credential-email"),
                     (0, "REQUIRED", "reset-password"), (0, "CONDITIONAL", None), (1, "REQUIRED", "conditional-user-configured"),
                     (1, "REQUIRED", "reset-otp"), (1, "REQUIRED", "conditional-user-role", self.NOT_ADMIN), (0, "CONDITIONAL", None),
                     (1, "REQUIRED", "conditional-user-role", self.ADMIN), (1, "REQUIRED", "auth-otp-form", dict(self.REFERENCE)))
        return {"browserFlow": "kin browser", "resetFlow": "kin reset credentials", "browserOverrides": [],
                "requiredActions": [{"alias": "CONFIGURE_TOTP", "enabled": True}], "executions": browser, "resetExecutions": reset,
                "bffMappers": [{"protocolMapper": "oidc-group-membership-mapper", "config": {}}, copy.deepcopy(self.AMR)]}

    def test_the_shipped_flows_pass_and_are_the_realm_files(self):
        deploy.check_admin_mfa(self.shipped(), self.realm)
        self.assertEqual(deploy.flow_shape(self.shipped()["executions"]),
                         deploy.flow_shape(deploy.realm_flow_rows(self.realm, self.realm["browserFlow"])))
        # A reference value Admin REST shows unmasked passes when it is the file's.
        policy = self.shipped()
        policy["executions"][-1]["config"] = {"default.reference.value": "otp", "default.reference.maxAge": "43200"}
        deploy.check_admin_mfa(policy, self.realm)

    def test_the_file_marks_the_administrator_otp_for_the_whole_session(self):
        """The reference lives exactly on the two administrator OTP steps, for the SSO session's lifespan (Keycloak's default
        0 drops it after the second it was performed), and kin-bff's access token carries it."""
        configs = {item["alias"]: item["config"] for item in self.realm["authenticatorConfig"]}
        marked = [(flow["alias"], step["authenticator"]) for flow in self.realm["authenticationFlows"]
                  for step in flow["authenticationExecutions"]
                  if "default.reference.value" in configs.get(step.get("authenticatorConfig"), {})]
        self.assertEqual(marked, [("kin browser administrator otp", "auth-otp-form"), ("kin reset administrator otp", "auth-otp-form")])
        for flow in self.realm["authenticationFlows"]:
            for step in flow["authenticationExecutions"]:
                config = configs.get(step.get("authenticatorConfig"), {})
                if "default.reference.value" in config:
                    self.assertEqual(config, {"default.reference.value": "otp",
                                              "default.reference.maxAge": str(self.realm["ssoSessionMaxLifespan"])})
        bff = next(client for client in self.realm["clients"] if client["clientId"] == "kin-bff")
        self.assertIn(self.AMR, [{"protocolMapper": m["protocolMapper"], "config": m["config"]} for m in bff["protocolMappers"]])

    def test_an_existing_install_without_the_procedure_is_refused(self):
        policy = self.shipped()
        policy["executions"] = [row for row in policy["executions"] if row.get("providerId") != "conditional-user-role"][:-2]
        with self.assertRaisesRegex(RuntimeError, "browser flow does not require OTP for administrators"):
            deploy.check_admin_mfa(policy, self.realm)

    def test_each_weakening_is_refused(self):
        def browser(index, **change):
            return lambda p: p["executions"][index].update(change)
        changes = {
            "admin OTP optional": browser(18, requirement="ALTERNATIVE"),
            "admin gate negated": browser(17, config={**self.ADMIN, "negate": "true"}),
            "gate names another role": browser(17, config={**self.ADMIN, "condUserRole": "radiologist"}),
            "admin subflow disabled": browser(16, requirement="DISABLED"),
            "admin OTP removed": lambda p: p["executions"].pop(18),
            "reset admin OTP removed": lambda p: p["resetExecutions"].pop(),
            "reset OTP optional": lambda p: p["resetExecutions"][9].update(requirement="ALTERNATIVE"),
            "Configure OTP off": lambda p: p["requiredActions"][0].update(enabled=False),
            "Configure OTP missing": lambda p: p.update(requiredActions=[]),
            "a client binds its own browser flow": lambda p: p.update(browserOverrides=["kin-bff"]),
            "overrides not read": lambda p: p.pop("browserOverrides"),
            "reset flow not read": lambda p: p.pop("resetExecutions"),
            "admin OTP reference missing": lambda p: p["executions"][18].pop("config"),
            "reset OTP reference missing": lambda p: p["resetExecutions"][9].pop("config"),
            "reference max age left at 0": browser(18, config={**self.REFERENCE, "default.reference.maxAge": "0"}),
            "reference names another method": browser(18, config={**self.REFERENCE, "default.reference.value": "pwd"}),
            "kin-bff without the AMR mapper": lambda p: p["bffMappers"].pop(),
            "AMR only in the id token": lambda p: p["bffMappers"][-1]["config"].update({"access.token.claim": "false"}),
            "kin-bff mappers not read": lambda p: p.pop("bffMappers"),
        }
        for name, change in changes.items():
            policy = copy.deepcopy(self.shipped())
            change(policy)
            with self.subTest(name), self.assertRaises(RuntimeError):
                deploy.check_admin_mfa(policy, self.realm)


if __name__ == "__main__":
    unittest.main(verbosity=2)
