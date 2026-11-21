"""Signed updates and the launcher (update.py, ed25519.py).

The launcher runs real child processes here: small stand-in agents that behave like a good release (write the ready file
this start was given, then keep running), a release that crashes, one that never gets ready, and one that asks for a
restart. Keys are made by the test on the spot; nothing here is a real release key.
"""

import base64
import json
import os
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import ed25519  # noqa: E402
import update  # noqa: E402
from update import BUILTIN, Launcher, UpdateRefused, make_bundle, verify_bundle  # noqa: E402

SEED = bytes.fromhex("204ce8eba3afe7277c47c2a02c5ee2753f67443ae92a64e4cec1c4da5fe56a41")
OTHER_SEED = bytes(range(32))
PUBLIC = ed25519.public_key(SEED)
KEYS_VALUE = base64.b64encode(PUBLIC).decode()

# A stand-in agent. Its behaviour is a word in its own source, so every release is a different, signed file.
STAND_IN = """
import json, os, sys, time
BEHAVIOUR = {behaviour!r}
AGENT_VERSION = "{version}"
out = os.environ.get("STAND_IN_LOG")
if out:
    with open(out, "a") as handle:
        handle.write(json.dumps({{"pid": os.getpid(), "version": os.environ.get("KIN_AGENT_RUN_VERSION", AGENT_VERSION),
                                 "behaviour": BEHAVIOUR, "builtin": os.environ.get("KIN_AGENT_BUILTIN_VERSION")}}) + "\\n")
if BEHAVIOUR == "crash":
    sys.exit(3)
if BEHAVIOUR == "restart_once" and not os.path.exists(out + ".restarted"):
    open(out + ".restarted", "w").close()
    sys.exit(75)
if BEHAVIOUR != "never_ready":
    with open(os.environ["KIN_AGENT_READY_FILE"], "w") as handle:
        handle.write("{{}}")
while True:
    time.sleep(0.05)
"""


def last_result(launcher) -> str | None:
    return (launcher.state["last"] or {}).get("result")


def stand_in(behaviour: str, version: str = "0") -> bytes:
    return STAND_IN.format(behaviour=behaviour, version=version).encode()


class Ed25519Tests(unittest.TestCase):
    def test_rfc8032_vector_1(self):
        # RFC 8032 section 7.1, TEST 1 (empty message).
        seed = bytes.fromhex("9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60")
        public = bytes.fromhex("d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a")
        signature = bytes.fromhex("e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b")
        self.assertEqual(ed25519.public_key(seed), public)
        self.assertEqual(ed25519.sign(seed, b""), signature)
        self.assertTrue(ed25519.verify(public, b"", signature))

    def test_a_signature_from_another_implementation(self):
        # Made with Node's crypto (OpenSSL) for this seed and message: an independent signer, the same verdict.
        signature = bytes.fromhex("e37f0b78fa6564c009adb82e22afe463c6fad09f5798e657ea16b13d1297f55b872ce56f1be5cdd4dc753b1bf070abff09cd07c2b4e7f2af0cd3b8d8a2c0810a")
        self.assertEqual(PUBLIC.hex(), "7e818dd5582d92f7b5b891ee49ee211641831e655b9818886dcfd4c1644e0de6")
        self.assertTrue(ed25519.verify(PUBLIC, b"hello gateway", signature))
        self.assertEqual(ed25519.sign(SEED, b"hello gateway"), signature)

    def test_anything_changed_does_not_verify(self):
        signature = ed25519.sign(SEED, b"message")
        for public, message, sig in ((PUBLIC, b"messagf", signature), (ed25519.public_key(OTHER_SEED), b"message", signature),
                                     (PUBLIC, b"message", signature[:63] + bytes([signature[63] ^ 1])),
                                     (PUBLIC, b"message", signature[:5] + bytes([signature[5] ^ 1]) + signature[6:]),
                                     (PUBLIC, b"message", signature[:63]), (PUBLIC[:31], b"message", signature),
                                     (b"\xff" * 32, b"message", signature)):
            self.assertFalse(ed25519.verify(public, message, sig))
        # s at or above the group order is refused (no second encoding of the same signature).
        order = 2 ** 252 + 27742317777372353535851937790883648493
        s = int.from_bytes(signature[32:], "little") + order
        self.assertFalse(ed25519.verify(PUBLIC, b"message", signature[:32] + s.to_bytes(32, "little")))


class BundleTests(unittest.TestCase):
    def bundle(self, version="2026.12.1", files=None, seed=SEED):
        return make_bundle(seed, version, files or {"agent.py": b"print('x')\n"})

    def test_a_signed_newer_bundle_verifies_and_carries_its_files(self):
        release = verify_bundle(self.bundle(files={"agent.py": b"A", "helper.py": b"B"}), [PUBLIC], newer_than="2026.11.2")
        self.assertEqual(release.version, "2026.12.1")
        self.assertEqual(release.files, {"agent.py": b"A", "helper.py": b"B"})

    def test_trust_comes_only_from_the_host_keys(self):
        good = self.bundle()
        with self.assertRaises(UpdateRefused) as caught:
            verify_bundle(good, [])
        self.assertEqual(caught.exception.code, "no_update_key")
        with self.assertRaises(UpdateRefused) as caught:
            verify_bundle(good, [ed25519.public_key(OTHER_SEED)])
        self.assertEqual(caught.exception.code, "bad_signature")
        self.assertEqual(verify_bundle(good, [ed25519.public_key(OTHER_SEED), PUBLIC]).version, "2026.12.1")
        self.assertEqual(update.load_keys(f" {KEYS_VALUE} ,"), [PUBLIC])
        for bad in ("not base64!", base64.b64encode(b"short").decode(), KEYS_VALUE + "=="):
            with self.assertRaises(UpdateRefused) as caught:
                update.load_keys(bad)
            self.assertEqual(caught.exception.code, "bad_update_key")

    def test_a_changed_byte_anywhere_is_refused(self):
        payload = json.loads(self.bundle())
        changed_file = dict(payload, files={"agent.py": base64.b64encode(b"print('y')\n").decode()})
        changed_version = dict(payload, version="2026.12.2")
        extra_file = dict(payload, files={**payload["files"], "more.py": base64.b64encode(b"").decode()})
        for tampered in (changed_file, changed_version, extra_file):
            with self.assertRaises(UpdateRefused) as caught:
                verify_bundle(json.dumps(tampered).encode(), [PUBLIC])
            self.assertEqual(caught.exception.code, "bad_signature")

    def test_the_shape_is_closed(self):
        payload = json.loads(self.bundle())
        agent_b64 = payload["files"]["agent.py"]
        cases = [b"", b"[]", b"not json", json.dumps({**payload, "extra": 1}).encode(),
                 json.dumps({k: v for k, v in payload.items() if k != "signature"}).encode(),
                 json.dumps({**payload, "format": 2}).encode(), json.dumps({**payload, "format": True}).encode(),
                 json.dumps({**payload, "version": "v1"}).encode(), json.dumps({**payload, "version": "1." * 20 + "1"}).encode(),
                 json.dumps({**payload, "files": {}}).encode(), json.dumps({**payload, "files": {"other.py": agent_b64}}).encode(),
                 json.dumps({**payload, "files": {"agent.py": agent_b64, "../x.py": agent_b64}}).encode(),
                 json.dumps({**payload, "files": {"agent.py": agent_b64, "Agent.py": agent_b64}}).encode(),
                 json.dumps({**payload, "files": {"agent.py": agent_b64 + "\n"}}).encode(),
                 json.dumps({**payload, "files": {"agent.py": agent_b64.rstrip("=")}}).encode(),
                 json.dumps({**payload, "signature": payload["signature"][:-4]}).encode(),
                 # the same key twice: the parser must not quietly keep the last one
                 b'{"format":1,"version":"9.9","version":"2026.12.1","files":' + json.dumps(payload["files"]).encode()
                 + b',"signature":"' + payload["signature"].encode() + b'"}']
        for raw in cases:
            with self.subTest(raw=raw[:80]):
                with self.assertRaises(UpdateRefused) as caught:
                    verify_bundle(raw, [PUBLIC])
                self.assertEqual(caught.exception.code, "invalid_bundle")

    def test_size_limits(self):
        with self.assertRaises(UpdateRefused) as caught:
            verify_bundle(b" " * (update.MAX_BUNDLE_BYTES + 1), [PUBLIC])
        self.assertEqual(caught.exception.code, "too_large")
        big = self.bundle(files={"agent.py": b"x" * (update.MAX_FILE_BYTES // 2 + 1),
                                 "two.py": b"y" * (update.MAX_FILE_BYTES // 2 + 1)})
        with self.assertRaises(UpdateRefused) as caught:
            verify_bundle(big, [PUBLIC])
        self.assertEqual(caught.exception.code, "too_large")

    def test_newer_only_and_the_expected_version(self):
        self.assertGreater(update.version_key("1.10"), update.version_key("1.9"))
        self.assertEqual(update.version_key("1.2.0"), update.version_key("1.2"))
        good = self.bundle("2026.12.1")
        for running in ("2026.12.1", "2026.12.1.0", "2026.12.2", "2027"):
            with self.assertRaises(UpdateRefused) as caught:
                verify_bundle(good, [PUBLIC], newer_than=running)
            self.assertEqual(caught.exception.code, "not_newer")
        with self.assertRaises(UpdateRefused) as caught:
            verify_bundle(good, [PUBLIC], expected_version="2026.12.2")
        self.assertEqual(caught.exception.code, "wrong_version")
        self.assertEqual(verify_bundle(good, [PUBLIC], expected_version="2026.12.1.0").version, "2026.12.1")

    def test_the_release_tool_round_trip(self):
        with tempfile.TemporaryDirectory() as tmp:
            key, out, agent = Path(tmp, "release.key"), Path(tmp, "bundle.json"), Path(tmp, "agent.py")
            agent.write_bytes(b"AGENT_VERSION = '1'\n")
            public = subprocess.run([sys.executable, "-B", update.__file__, "keygen", "--out", str(key)],
                                    capture_output=True, text=True, check=True).stdout.strip()
            subprocess.run([sys.executable, "-B", update.__file__, "sign", "--key", str(key), "--version", "3.1",
                            "--out", str(out), str(agent)], capture_output=True, text=True, check=True)
            release = verify_bundle(out.read_bytes(), update.load_keys(public))
            self.assertEqual((release.version, release.files), ("3.1", {"agent.py": agent.read_bytes()}))


class LauncherTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)
        self.root = self.dir / "agent-releases"
        self.builtin = self.dir / "app" / "agent.py"
        self.builtin.parent.mkdir()
        self.builtin.write_bytes(stand_in("good", "2026.11.2"))
        self.log = self.dir / "children.jsonl"
        self.launchers: list[Launcher] = []

    def tearDown(self):
        for launcher in self.launchers:
            launcher.stop_wait = 2
            launcher.stop_child()
        self.tmp.cleanup()

    def launcher(self, probation=5.0) -> Launcher:
        env = dict(os.environ, STAND_IN_LOG=str(self.log))
        launcher = Launcher(self.root, KEYS_VALUE, builtin=self.builtin, probation=probation, stop_wait=5, tick=0.02,
                            env=env)
        self.launchers.append(launcher)
        return launcher

    def children(self) -> list[dict]:
        if not self.log.exists():
            return []
        return [json.loads(line) for line in self.log.read_text().splitlines()]

    def drive(self, launcher: Launcher, until, timeout=10.0):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            launcher.step()
            if until():
                return
            time.sleep(0.02)
        self.fail("the launcher did not get there: " + json.dumps(launcher.state))

    def start(self, launcher: Launcher):
        launcher.resume()
        launcher.start_chain()
        self.drive(launcher, launcher.ready)

    def install(self, launcher: Launcher, raw: bytes, request=None):
        update.publish_incoming(launcher.paths, raw, request)

    def test_without_any_update_the_built_in_agent_runs(self):
        launcher = self.launcher()
        self.start(launcher)
        self.assertEqual(launcher.running_version, BUILTIN)
        self.assertEqual(self.children()[-1]["version"], "2026.11.2")
        self.assertEqual(json.loads(launcher.paths.state.read_text())["running"], BUILTIN)

    def test_every_child_is_told_the_image_agent_version_and_never_an_inherited_one(self):
        launcher = self.launcher()
        launcher.env["KIN_AGENT_BUILTIN_VERSION"] = "9999.1"   # an inherited value is not the image's
        self.start(launcher)
        self.assertEqual(self.children()[-1]["builtin"], "2026.11.2")
        self.install(launcher, make_bundle(SEED, "2026.12.1", {"agent.py": stand_in("good")}),
                     {"requestId": "11111111-1111-4111-8111-111111111111", "version": "2026.12.1"})
        self.drive(launcher, lambda: launcher.state["last"] and last_result(launcher) == "installed")
        self.assertEqual((self.children()[-1]["version"], self.children()[-1]["builtin"]), ("2026.12.1", "2026.11.2"))

    def test_a_good_signed_release_replaces_the_child_and_is_kept_after_its_ready(self):
        launcher = self.launcher()
        self.start(launcher)
        first = launcher.child.pid
        self.install(launcher, make_bundle(SEED, "2026.12.1", {"agent.py": stand_in("good")}),
                     {"requestId": "11111111-1111-4111-8111-111111111111", "version": "2026.12.1"})
        self.drive(launcher, lambda: launcher.state["last"] and last_result(launcher) == "installed")
        self.assertNotEqual(launcher.child.pid, first)
        self.assertEqual((launcher.state["current"], launcher.state["previous"]), ("2026.12.1", BUILTIN))
        self.assertEqual(self.children()[-1]["version"], "2026.12.1")   # KIN_AGENT_RUN_VERSION: the signed version
        self.assertEqual(launcher.state["results"][-1], {"version": "2026.12.1", "result": "installed", "code": None,
                                                         "requestId": "11111111-1111-4111-8111-111111111111"})
        self.assertEqual(list(launcher.paths.incoming.iterdir()), [])
        # The bytes that run are the verified bytes, written fresh for this start.
        run_dir = Path(launcher.paths.run, launcher.start_id)
        self.assertEqual((run_dir / "agent.py").read_bytes(), stand_in("good"))
        # A container restart runs the kept release again (re-verified).
        launcher.stop_child()
        again = self.launcher()
        self.start(again)
        self.assertEqual(again.running_version, "2026.12.1")

    def test_a_refused_bundle_changes_nothing_and_leaves_the_running_child_alone(self):
        launcher = self.launcher()
        self.start(launcher)
        pid = launcher.child.pid
        cases = [(make_bundle(OTHER_SEED, "2026.12.1", {"agent.py": stand_in("good")}), None, "bad_signature"),
                 (make_bundle(SEED, "2026.11.2", {"agent.py": stand_in("good")}), None, "not_newer"),
                 (make_bundle(SEED, "2026.11.1", {"agent.py": stand_in("good")}), None, "not_newer"),
                 (make_bundle(SEED, "2026.12.1", {"agent.py": stand_in("good")}), "2026.12.3", "wrong_version"),
                 (b"{}", None, "invalid_bundle")]
        for raw, expected, code in cases:
            request = {"requestId": "22222222-2222-4222-8222-222222222222", "version": expected} if expected else None
            self.install(launcher, raw, request)
            self.drive(launcher, lambda: not any(launcher.paths.incoming.iterdir()))
            self.assertEqual(launcher.state["last"]["result"], "refused")
            self.assertEqual(launcher.state["last"]["code"], code)
            self.assertEqual(launcher.child.pid, pid)
            self.assertIsNone(launcher.child.poll())
        self.assertEqual(launcher.state["current"], BUILTIN)
        self.assertFalse(launcher.paths.releases.exists() and any(launcher.paths.releases.iterdir()))

    def test_no_key_on_the_host_installs_nothing(self):
        launcher = self.launcher()
        launcher.keys_value = ""
        self.start(launcher)
        self.install(launcher, make_bundle(SEED, "2026.12.1", {"agent.py": stand_in("good")}))
        self.drive(launcher, lambda: not any(launcher.paths.incoming.iterdir()))
        self.assertEqual((launcher.state["last"]["result"], launcher.state["last"]["code"]), ("refused", "no_update_key"))

    def test_a_release_that_exits_in_probation_is_rolled_back_to_the_one_before(self):
        launcher = self.launcher()
        self.start(launcher)
        self.install(launcher, make_bundle(SEED, "2026.12.1", {"agent.py": stand_in("crash")}),
                     {"requestId": "33333333-3333-4333-8333-333333333333", "version": "2026.12.1"})
        self.drive(launcher, lambda: last_result(launcher) == "rolled_back" and launcher.ready())
        self.assertEqual(launcher.state["last"]["code"], "exited")
        self.assertEqual((launcher.state["current"], launcher.running_version), (BUILTIN, BUILTIN))
        self.assertEqual([c["version"] for c in self.children()], ["2026.11.2", "2026.12.1", "2026.11.2"])
        # Not retried by itself.
        for _ in range(20):
            launcher.step()
            time.sleep(0.02)
        self.assertEqual(len(self.children()), 3)

    def test_a_release_that_never_gets_ready_is_rolled_back_at_the_end_of_probation(self):
        launcher = self.launcher(probation=1.0)
        self.start(launcher)
        self.install(launcher, make_bundle(SEED, "2026.12.1", {"agent.py": stand_in("never_ready")}))
        self.drive(launcher, lambda: last_result(launcher) == "rolled_back" and launcher.ready())
        self.assertEqual(launcher.state["last"]["code"], "not_ready")
        self.assertEqual(launcher.running_version, BUILTIN)

    def test_rolled_back_is_written_only_after_the_trial_stopped_and_the_one_before_started(self):
        launcher = self.launcher(probation=1.0)
        self.start(launcher)
        self.install(launcher, make_bundle(SEED, "2026.12.1", {"agent.py": stand_in("never_ready")}),
                     {"requestId": "55555555-5555-4555-8555-555555555555", "version": "2026.12.1"})
        seen = []
        real_stop = launcher.stop_child

        def stop_child():
            on_disk = json.loads(launcher.paths.state.read_text())
            seen.append((on_disk["pending"] is not None, (on_disk["last"] or {}).get("result")))
            return real_stop()

        launcher.stop_child = stop_child
        self.drive(launcher, lambda: last_result(launcher) == "rolled_back")
        # At the stop of the trial (the install's own stop of the first child came before it): still pending, not told.
        self.assertEqual(seen[-1], (True, None))
        on_disk = json.loads(launcher.paths.state.read_text())
        self.assertEqual((on_disk["pending"], on_disk["running"], on_disk["last"]["result"]), (None, BUILTIN, "rolled_back"))
        self.assertIsNone(launcher.child.poll(), "the release before runs when the outcome is written")

    def test_after_a_key_change_a_failed_trial_goes_back_to_what_actually_ran(self):
        launcher = self.launcher()
        self.start(launcher)
        self.install(launcher, make_bundle(SEED, "2026.12.1", {"agent.py": stand_in("good")}))
        self.drive(launcher, lambda: launcher.state["current"] == "2026.12.1")
        launcher.stop_child()
        # The host now trusts another key only: the kept 2026.12.1 does not verify, the built-in agent runs.
        rotated = self.launcher()
        rotated.keys_value = base64.b64encode(ed25519.public_key(OTHER_SEED)).decode()
        self.start(rotated)
        self.assertEqual((rotated.running_version, rotated.state["current"]), (BUILTIN, "2026.12.1"))
        # 2026.12.1 again, signed with the new key, fails its trial: back to the built-in agent, not to the failed one.
        self.install(rotated, make_bundle(OTHER_SEED, "2026.12.1", {"agent.py": stand_in("crash")}))
        self.drive(rotated, lambda: last_result(rotated) == "rolled_back" and rotated.ready())
        self.assertEqual((rotated.running_version, rotated.state["current"]), (BUILTIN, BUILTIN))
        before = len(self.children())
        for _ in range(30):
            rotated.step()
            time.sleep(0.02)
        self.assertEqual(len(self.children()), before, "the failed release is not started again")

    def test_a_remote_bundle_waiting_on_a_host_that_switched_support_off_is_refused(self):
        launcher = self.launcher()
        launcher.env["GW_REMOTE_SUPPORT"] = "off"
        self.start(launcher)
        pid = launcher.child.pid
        self.install(launcher, make_bundle(SEED, "2026.12.1", {"agent.py": stand_in("good")}),
                     {"requestId": "66666666-6666-4666-8666-666666666666", "version": "2026.12.1"})
        self.drive(launcher, lambda: not any(launcher.paths.incoming.iterdir()))
        self.assertEqual(launcher.state["results"][-1], {"version": "2026.12.1", "result": "refused",
                                                         "code": "remote_support_off",
                                                         "requestId": "66666666-6666-4666-8666-666666666666"})
        self.assertEqual(launcher.child.pid, pid)
        # The host's own manual install still works with remote support off.
        self.install(launcher, make_bundle(SEED, "2026.12.1", {"agent.py": stand_in("good")}))
        self.drive(launcher, lambda: launcher.state["current"] == "2026.12.1")

    def test_a_second_update_rolls_back_to_the_first_not_to_the_floor(self):
        launcher = self.launcher()
        self.start(launcher)
        self.install(launcher, make_bundle(SEED, "2026.12.1", {"agent.py": stand_in("good")}))
        self.drive(launcher, lambda: launcher.state["current"] == "2026.12.1")
        self.install(launcher, make_bundle(SEED, "2026.12.2", {"agent.py": stand_in("crash")}))
        self.drive(launcher, lambda: last_result(launcher) == "rolled_back" and launcher.ready())
        self.assertEqual((launcher.state["current"], launcher.state["previous"], launcher.running_version),
                         ("2026.12.1", BUILTIN, "2026.12.1"))

    def test_a_restart_during_probation_closes_it_as_interrupted(self):
        launcher = self.launcher(probation=60)
        self.start(launcher)
        self.install(launcher, make_bundle(SEED, "2026.12.1", {"agent.py": stand_in("never_ready")}),
                     {"requestId": "44444444-4444-4444-8444-444444444444", "version": "2026.12.1"})
        self.drive(launcher, lambda: launcher.state["pending"] is not None and launcher.running_version == "2026.12.1")
        launcher.stop_child()   # the container stops while the new release is in probation
        again = self.launcher()
        self.start(again)
        self.assertEqual(again.state["last"], {"version": "2026.12.1", "result": "rolled_back", "code": "interrupted",
                                               "requestId": "44444444-4444-4444-8444-444444444444"})
        self.assertEqual((again.state["current"], again.running_version, again.state["pending"]), (BUILTIN, BUILTIN, None))

    def test_a_kept_release_altered_on_disk_does_not_run(self):
        launcher = self.launcher()
        self.start(launcher)
        self.install(launcher, make_bundle(SEED, "2026.12.1", {"agent.py": stand_in("good")}))
        self.drive(launcher, lambda: launcher.state["current"] == "2026.12.1")
        launcher.stop_child()
        bundle = launcher.paths.bundle("2026.12.1")
        payload = json.loads(bundle.read_text())
        payload["files"]["agent.py"] = base64.b64encode(stand_in("good") + b"# changed\n").decode()
        bundle.write_text(json.dumps(payload))
        again = self.launcher()
        self.start(again)
        self.assertEqual(again.running_version, BUILTIN)
        self.assertEqual(again.state["last"], {"version": "2026.12.1", "result": "skipped", "code": "bad_signature",
                                               "requestId": None})
        # A key removed from the host: the same.
        bundle.write_bytes(make_bundle(SEED, "2026.12.1", {"agent.py": stand_in("good")}))
        again.stop_child()
        third = self.launcher()
        third.keys_value = base64.b64encode(ed25519.public_key(OTHER_SEED)).decode()
        self.start(third)
        self.assertEqual(third.running_version, BUILTIN)

    def test_exit_75_restarts_at_once_and_another_exit_backs_off(self):
        launcher = self.launcher()
        self.start(launcher)
        self.install(launcher, make_bundle(SEED, "2026.12.1", {"agent.py": stand_in("good")}))
        self.drive(launcher, lambda: launcher.state["current"] == "2026.12.1")
        self.install(launcher, make_bundle(SEED, "2026.12.2", {"agent.py": stand_in("restart_once")}))
        # In probation an exit, 75 too, is a failed update.
        self.drive(launcher, lambda: last_result(launcher) == "rolled_back" and launcher.ready())
        self.assertEqual(launcher.state["last"]["code"], "exited")
        # Outside probation 75 is a restart of the same release, at once (a kept release that asks once).
        Path(str(self.log) + ".restarted").unlink()
        launcher.stop_child()
        update.write_atomic(launcher.paths.bundle("2026.12.3"),
                            make_bundle(SEED, "2026.12.3", {"agent.py": stand_in("restart_once")}))
        launcher.state["current"] = "2026.12.3"
        before = len(self.children())
        launcher.start_chain()
        self.drive(launcher, lambda: len(self.children()) == before + 2 and launcher.ready())
        self.assertEqual([c["version"] for c in self.children()[-2:]], ["2026.12.3", "2026.12.3"])
        self.assertEqual(launcher.backoff, 0.0)
        launcher.child.kill()
        launcher.child.wait()
        launcher.step()
        self.assertIsNone(launcher.child)
        self.assertGreaterEqual(launcher.restart_at - launcher.clock(), 1.0)

    def test_manual_rollback_switches_to_the_previous_release(self):
        launcher = self.launcher()
        self.start(launcher)
        self.install(launcher, make_bundle(SEED, "2026.12.1", {"agent.py": stand_in("good")}))
        self.drive(launcher, lambda: launcher.state["current"] == "2026.12.1")
        update.write_atomic(launcher.paths.control / "rollback", b"1")
        self.drive(launcher, lambda: launcher.running_version == BUILTIN and launcher.ready())
        self.assertEqual((launcher.state["current"], launcher.state["previous"]), (BUILTIN, "2026.12.1"))
        self.assertEqual((launcher.state["last"]["result"], launcher.state["last"]["code"]), ("rolled_back", "manual"))

    def test_the_command_line_install_verifies_first_and_hands_over(self):
        self.root.mkdir(parents=True)
        good, bad = self.dir / "good.json", self.dir / "bad.json"
        good.write_bytes(make_bundle(SEED, "2026.12.1", {"agent.py": stand_in("good")}))
        bad.write_bytes(make_bundle(OTHER_SEED, "2026.12.1", {"agent.py": stand_in("good")}))
        env = dict(os.environ, KIN_UPDATE_ROOT=str(self.root), GW_UPDATE_KEYS=KEYS_VALUE)
        refused = subprocess.run([sys.executable, "-B", update.__file__, "install", str(bad)], env=env,
                                 capture_output=True, text=True)
        self.assertEqual((refused.returncode, json.loads(refused.stdout)), (1, {"result": "refused", "code": "bad_signature"}))
        self.assertFalse((self.root / "incoming").exists() and any((self.root / "incoming").iterdir()))
        accepted = subprocess.run([sys.executable, "-B", update.__file__, "install", str(good)], env=env,
                                  capture_output=True, text=True)
        self.assertEqual(accepted.returncode, 0, accepted.stdout + accepted.stderr)
        self.assertEqual(json.loads(accepted.stdout)["version"], "2026.12.1")
        entries = list((self.root / "incoming").iterdir())
        self.assertEqual(len(entries), 1)
        self.assertEqual((entries[0] / "bundle.json").read_bytes(), good.read_bytes())


if __name__ == "__main__":
    unittest.main()
