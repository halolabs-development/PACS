"""KIN Gateway launcher and signed updates.

The container runs `update.py run`. The launcher is part of the image and never replaced by an update; it runs one
Gateway agent as its child and is the only writer of the update state. Rules, each in one place:

- Trust (`verify_bundle`): a release runs only if its bundle verifies, at every start, against a public key this
  Gateway host was configured with (`GW_UPDATE_KEYS`) — never a key or a verdict that came from KIN. The files the
  child runs are written fresh from the verified bundle for every start, so the bytes that run are the bytes verified.
- Newer only: an install (manual or remote) is refused unless its version is strictly greater than the running one.
  Restarts, rollbacks and fallbacks re-verify but do not compare versions.
- Good: a newly installed release is kept only when, within PROBATION_SECONDS, its own process has finished one real
  main-loop pass and had one heartbeat stored by KIN; it says so by writing the ready file named for this start.
  Otherwise the launcher stops it and starts the release that ran before. A rolled-back release is not retried.
- Floor: the image's own `/app/agent.py` is always the last fallback.

The state lives next to the queue (`/data/agent-releases`), so a container restart keeps it. A start that finds an
install still in probation (the container stopped during it) closes it as `rolled_back/interrupted` and runs the
release it came from. The launcher never opens the queue: received images stay in the local Orthanc and in queue.db,
and whichever agent runs next continues them.
"""

from __future__ import annotations

import argparse
import base64
import binascii
import hashlib
import json
import os
import re
import shutil
import signal
import subprocess
import sys
import time
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable

import ed25519

FORMAT = 1
MESSAGE_HEAD = b"KIN-GATEWAY-UPDATE-1\n"
FILE_NAME = re.compile(r"[a-z_]{1,40}\.py")
VERSION = re.compile(r"[0-9]{1,9}(?:\.[0-9]{1,9}){0,7}")
VERSION_MAX = 32
MAX_FILES = 8
MAX_FILE_BYTES = 4 * 1024 * 1024          # all files of one bundle together, decoded
MAX_BUNDLE_BYTES = 6 * 1024 * 1024        # the bundle file itself (base64 grows the files by a third)
PROBATION_SECONDS = 180.0
STOP_WAIT_SECONDS = 330.0
RESTART_EXIT = 75
BUILTIN = "builtin"
RESULTS_KEPT = 16
TICK_SECONDS = 1.0

APP_DIR = Path(__file__).resolve().parent
BUILTIN_AGENT = APP_DIR / "agent.py"


class UpdateRefused(Exception):
    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


@dataclass(frozen=True)
class Release:
    version: str
    files: dict[str, bytes]


def log(event: str, **fields: Any) -> None:
    line = {"at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "event": event, **fields}
    sys.stdout.write(json.dumps(line, separators=(",", ":")) + "\n")
    sys.stdout.flush()


# ── versions ──

def valid_version(value: Any) -> bool:
    return isinstance(value, str) and len(value) <= VERSION_MAX and VERSION.fullmatch(value) is not None


def version_key(value: str) -> tuple[int, ...]:
    """Numeric parts; missing trailing parts are 0, so 1.10 > 1.9 and 1.2.0 == 1.2."""
    parts = [int(part) for part in value.split(".")]
    while len(parts) > 1 and parts[-1] == 0:
        parts.pop()
    return tuple(parts)


def builtin_version(path: Path = BUILTIN_AGENT) -> str:
    match = re.search(r'^AGENT_VERSION = "([^"]+)"', path.read_text(encoding="utf-8"), re.MULTILINE)
    if not match or not valid_version(match.group(1)):
        raise RuntimeError("built-in agent has no readable version")
    return match.group(1)


# ── the bundle (one rule) ──

def signed_message(version: str, files: dict[str, bytes]) -> bytes:
    lines = "".join(f"{name} {hashlib.sha256(files[name]).hexdigest()}\n" for name in sorted(files))
    return MESSAGE_HEAD + version.encode("ascii") + b"\n" + lines.encode("ascii")


def _strict_b64(value: Any) -> bytes:
    if not isinstance(value, str):
        raise UpdateRefused("invalid_bundle")
    try:
        raw = base64.b64decode(value.encode("ascii"), validate=True)
    except (binascii.Error, UnicodeEncodeError, ValueError):
        raise UpdateRefused("invalid_bundle") from None
    if base64.b64encode(raw).decode("ascii") != value:
        raise UpdateRefused("invalid_bundle")
    return raw


def _no_duplicates(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    seen: dict[str, Any] = {}
    for key, value in pairs:
        if key in seen:
            raise UpdateRefused("invalid_bundle")
        seen[key] = value
    return seen


def load_keys(value: str | None) -> list[bytes]:
    """The host's trusted public keys (`GW_UPDATE_KEYS`, base64, comma separated). A malformed entry is refused."""
    keys = []
    for item in (value or "").split(","):
        item = item.strip()
        if not item:
            continue
        try:
            key = _strict_b64(item)
        except UpdateRefused:
            raise UpdateRefused("bad_update_key") from None
        if len(key) != 32:
            raise UpdateRefused("bad_update_key")
        keys.append(key)
    return keys


def verify_bundle(raw: bytes, keys: list[bytes], *, newer_than: str | None = None,
                  expected_version: str | None = None) -> Release:
    """The one trust rule. Returns the release or raises UpdateRefused(code)."""
    if len(raw) > MAX_BUNDLE_BYTES:
        raise UpdateRefused("too_large")
    try:
        payload = json.loads(raw.decode("utf-8"), object_pairs_hook=_no_duplicates)
    except UpdateRefused:
        raise
    except (UnicodeDecodeError, ValueError, RecursionError):
        raise UpdateRefused("invalid_bundle") from None
    if not isinstance(payload, dict) or set(payload) != {"format", "version", "files", "signature"}:
        raise UpdateRefused("invalid_bundle")
    if payload["format"] != FORMAT or isinstance(payload["format"], bool):
        raise UpdateRefused("invalid_bundle")
    version = payload["version"]
    if not valid_version(version):
        raise UpdateRefused("invalid_bundle")
    listed = payload["files"]
    if not isinstance(listed, dict) or not 1 <= len(listed) <= MAX_FILES or "agent.py" not in listed:
        raise UpdateRefused("invalid_bundle")
    files: dict[str, bytes] = {}
    total = 0
    for name, encoded in listed.items():
        if not isinstance(name, str) or FILE_NAME.fullmatch(name) is None:
            raise UpdateRefused("invalid_bundle")
        files[name] = _strict_b64(encoded)
        total += len(files[name])
        if total > MAX_FILE_BYTES:
            raise UpdateRefused("too_large")
    signature = _strict_b64(payload["signature"])
    if len(signature) != 64:
        raise UpdateRefused("invalid_bundle")
    if not keys:
        raise UpdateRefused("no_update_key")
    message = signed_message(version, files)
    if not any(ed25519.verify(key, message, signature) for key in keys):
        raise UpdateRefused("bad_signature")
    if expected_version is not None and version_key(version) != version_key(expected_version):
        raise UpdateRefused("wrong_version")
    if newer_than is not None and version_key(version) <= version_key(newer_than):
        raise UpdateRefused("not_newer")
    return Release(version, files)


def make_bundle(seed: bytes, version: str, files: dict[str, bytes]) -> bytes:
    """The release tool's half: sign `files` as `version` with the release person's private key."""
    if not valid_version(version):
        raise ValueError("version must be numeric dot parts, at most 32 characters")
    if "agent.py" not in files or any(FILE_NAME.fullmatch(name) is None for name in files):
        raise ValueError("files must include agent.py and be named like name.py")
    signature = ed25519.sign(seed, signed_message(version, files))
    return json.dumps({
        "format": FORMAT, "version": version,
        "files": {name: base64.b64encode(files[name]).decode("ascii") for name in sorted(files)},
        "signature": base64.b64encode(signature).decode("ascii"),
    }, separators=(",", ":")).encode("utf-8")


# ── state (the launcher is its only writer) ──

def write_atomic(path: Path, data: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
    with open(temporary, "wb") as handle:
        handle.write(data)
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(temporary, path)


def empty_state() -> dict[str, Any]:
    return {"current": BUILTIN, "previous": None, "pending": None, "running": None, "failed": None, "last": None,
            "results": []}


class Paths:
    def __init__(self, root: Path):
        self.root = root
        self.state = root / "state.json"
        self.releases = root / "releases"
        self.incoming = root / "incoming"
        self.run = root / "run"
        self.control = root / "control"

    def bundle(self, version: str) -> Path:
        return self.releases / version / "bundle.json"


def read_state(paths: Paths) -> dict[str, Any]:
    try:
        state = json.loads(paths.state.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return empty_state()
    base = empty_state()
    if isinstance(state, dict):
        base.update({key: state[key] for key in base if key in state})
    if not isinstance(base["results"], list):
        base["results"] = []
    return base


def publish_incoming(paths: Paths, raw: bytes, request: dict[str, Any] | None = None) -> Path:
    """Hand a complete bundle (and, for a remote request, its id and version) to the launcher as one unit."""
    paths.incoming.mkdir(parents=True, exist_ok=True)
    staging = paths.incoming / f".tmp-{uuid.uuid4().hex}"
    staging.mkdir()
    write_atomic(staging / "bundle.json", raw)
    write_atomic(staging / "request.json", json.dumps(request or {}).encode("utf-8"))
    final = paths.incoming / f"{time.time_ns():020d}-{uuid.uuid4().hex[:8]}"
    os.replace(staging, final)
    return final


# ── the launcher ──

class Launcher:
    def __init__(self, root: Path, keys_value: str | None, *, python: str = sys.executable,
                 builtin: Path = BUILTIN_AGENT, probation: float = PROBATION_SECONDS,
                 stop_wait: float = STOP_WAIT_SECONDS, tick: float = TICK_SECONDS,
                 env: dict[str, str] | None = None, clock: Callable[[], float] = time.monotonic):
        self.paths = Paths(root)
        self.keys_value = keys_value
        self.python = python
        self.builtin = builtin
        self.probation = probation
        self.stop_wait = stop_wait
        self.tick = tick
        self.env = dict(os.environ if env is None else env)
        self.clock = clock
        self.state = read_state(self.paths)
        self.child: subprocess.Popen | None = None
        self.start_id: str | None = None
        self.running_version: str | None = None
        self.started_at = 0.0
        self.deadline: float | None = None    # probation end of the pending install
        self.ready_seen = False
        self.backoff = 0.0
        self.restart_at = 0.0
        self.stopping = False

    # state
    def save(self) -> None:
        write_atomic(self.paths.state, json.dumps(self.state, separators=(",", ":")).encode("utf-8"))

    def record(self, version: str | None, result: str, code: str | None = None, request_id: str | None = None) -> None:
        outcome = {"version": version, "result": result, "code": code, "requestId": request_id}
        self.state["last"] = outcome
        if request_id:
            self.state["results"] = [r for r in self.state["results"] if r.get("requestId") != request_id][-(RESULTS_KEPT - 1):]
            self.state["results"].append(outcome)
        log("update." + result, version=version, code=code)

    def keys(self) -> list[bytes]:
        return load_keys(self.keys_value)

    def builtin_version(self) -> str:
        return builtin_version(self.builtin)

    def version_of(self, name: str) -> str:
        return self.builtin_version() if name == BUILTIN else name

    # releases
    def verified(self, name: str) -> Release | None:
        """The release `name` if it verifies now (R1), else None. The built-in agent is the image's own."""
        if name == BUILTIN:
            return None
        try:
            raw = self.paths.bundle(name).read_bytes()
            release = verify_bundle(raw, self.keys())
        except FileNotFoundError:
            raise UpdateRefused("missing_release") from None
        if release.version != name:
            raise UpdateRefused("wrong_version")
        return release

    def spawn(self, name: str, release: Release | None) -> None:
        start_id = uuid.uuid4().hex
        if self.paths.run.exists():
            shutil.rmtree(self.paths.run, ignore_errors=True)
        env = dict(self.env)
        env["KIN_AGENT_READY_FILE"] = str(self.paths.run / f"{start_id}.ready")
        env["KIN_AGENT_UPDATE_STATE"] = str(self.paths.state)
        env["KIN_UPDATE_ROOT"] = str(self.paths.root)
        env.pop("KIN_AGENT_RUN_VERSION", None)
        # The image's own agent, the floor every fallback ends at: the agent deletes delivered copies only when it can
        # read what was deleted (agent.py keeps_purge_record). An older image's launcher says nothing, so nothing is deleted.
        env.pop("KIN_AGENT_BUILTIN_VERSION", None)
        try:
            env["KIN_AGENT_BUILTIN_VERSION"] = self.builtin_version()
        except (OSError, RuntimeError):
            pass
        if release is None:
            script = self.builtin
        else:
            directory = self.paths.run / start_id
            directory.mkdir(parents=True)
            for file_name, data in release.files.items():
                (directory / file_name).write_bytes(data)
            script = directory / "agent.py"
            env["KIN_AGENT_RUN_VERSION"] = release.version
        self.paths.run.mkdir(parents=True, exist_ok=True)
        self.child = subprocess.Popen([self.python, "-B", "-s", "-u", str(script), "run"], env=env)
        self.start_id = start_id
        self.running_version = name
        self.started_at = self.clock()
        self.ready_seen = False
        self.state["running"] = name
        self.save()
        log("launcher.started", version=self.version_of(name), pid=self.child.pid)

    def start_chain(self) -> None:
        """Start current; if it does not verify, previous; then the built-in agent (R4)."""
        chain = []
        for name in (self.state["current"], self.state["previous"], BUILTIN):
            if name and name not in chain:
                chain.append(name)
        for name in chain:
            try:
                release = self.verified(name)
            except UpdateRefused as refused:
                self.record(name, "skipped", refused.code)
                continue
            self.spawn(name, release)
            return
        raise RuntimeError("unreachable: the built-in agent always starts")

    def ready(self) -> bool:
        return self.start_id is not None and (self.paths.run / f"{self.start_id}.ready").exists()

    def stop_child(self) -> int | None:
        """TERM, wait up to stop_wait, kill; the exit is reaped before anything new starts."""
        child = self.child
        if child is None:
            return None
        if child.poll() is None:
            try:
                child.send_signal(signal.SIGTERM)
            except ProcessLookupError:
                pass
            try:
                child.wait(self.stop_wait)
            except subprocess.TimeoutExpired:
                child.kill()
                child.wait()
        self.child = None
        return child.returncode

    # install / rollback
    def take_incoming(self) -> bool:
        """Try the oldest waiting bundle. True when an install started (the child was replaced)."""
        if not self.paths.incoming.exists():
            return False
        entries = sorted(p for p in self.paths.incoming.iterdir() if p.is_dir() and not p.name.startswith("."))
        if not entries:
            return False
        entry = entries[0]
        request: dict[str, Any] = {}
        try:
            request = json.loads((entry / "request.json").read_text(encoding="utf-8"))
            if not isinstance(request, dict):
                request = {}
        except (OSError, ValueError):
            request = {}
        request_id = request.get("requestId") if isinstance(request.get("requestId"), str) else None
        expected = request.get("version") if valid_version(request.get("version")) else None
        running = self.version_of(self.running_version or self.state["current"])
        try:
            # A remote request is the host's to allow at the moment it would run, not only when the agent took it in.
            if request_id and str(self.env.get("GW_REMOTE_SUPPORT", "on")).strip().lower() in ("0", "false", "no", "off"):
                raise UpdateRefused("remote_support_off")
            try:
                raw = (entry / "bundle.json").read_bytes()
            except OSError:
                raise UpdateRefused("missing_bundle") from None
            release = verify_bundle(raw, self.keys(), newer_than=running, expected_version=expected)
            try:
                write_atomic(self.paths.bundle(release.version), raw)
            except OSError:
                raise UpdateRefused("store_failed") from None
        except UpdateRefused as refused:
            self.record(expected, "refused", refused.code, request_id)
            self.save()
            shutil.rmtree(entry, ignore_errors=True)
            return False
        start_from = self.running_version or self.state["current"]
        self.state["pending"] = {"from": start_from, "to": release.version, "requestId": request_id}
        self.save()
        shutil.rmtree(entry, ignore_errors=True)
        log("update.installing", version=release.version, previous=self.version_of(start_from))
        self.stop_child()
        if self.stopping:
            return True
        self.spawn(release.version, release)
        self.deadline = self.clock() + self.probation
        return True

    def end_probation(self, good: bool, code: str | None = None) -> None:
        pending = self.state["pending"]
        self.deadline = None
        self.state["pending"] = None
        if good:
            self.state["previous"] = pending["from"]
            self.state["current"] = pending["to"]
            self.record(pending["to"], "installed", None, pending.get("requestId"))
            self.save()
            self.prune()
            return
        # The trial child is stopped and reaped first, and the release that ran before is started, before the outcome is
        # written: until then a restart still finds `pending` (interrupted) and the console cannot read "rolled back"
        # while nothing older runs yet. The release to go back to is the one that actually ran (`from`), even when
        # `current` names a release that no longer verifies.
        self.stop_child()
        self.state["pending"] = pending
        if self.stopping:
            return
        self.state["current"] = pending["from"]
        self.state["failed"] = pending["to"]
        self.start_chain()
        self.state["pending"] = None
        self.record(pending["to"], "rolled_back", code, pending.get("requestId"))
        self.save()

    def manual_rollback(self) -> None:
        marker = self.paths.control / "rollback"
        if not marker.exists():
            return
        marker.unlink(missing_ok=True)
        previous = self.state["previous"]
        if not previous or self.state["pending"]:
            self.record(None, "rollback_refused", "no_previous" if not previous else "installing")
            self.save()
            return
        try:
            self.verified(previous)
        except UpdateRefused as refused:
            self.record(previous, "rollback_refused", refused.code)
            self.save()
            return
        self.state["previous"], self.state["current"] = self.state["current"], previous
        self.record(self.version_of(previous), "rolled_back", "manual")
        self.save()
        self.stop_child()
        if not self.stopping:
            self.start_chain()

    def prune(self) -> None:
        keep = {self.state["current"], self.state["previous"], self.state.get("failed")}
        if self.paths.releases.exists():
            for directory in self.paths.releases.iterdir():
                if directory.name not in keep:
                    shutil.rmtree(directory, ignore_errors=True)

    # the loop
    def resume(self) -> None:
        """A start that finds an install still in probation closes it (interrupted) and keeps the release before it."""
        pending = self.state["pending"]
        if pending:
            self.state["pending"] = None
            self.state["current"] = pending.get("from") or self.state["current"]
            self.state["failed"] = pending.get("to")
            self.record(pending.get("to"), "rolled_back", "interrupted", pending.get("requestId"))
            self.save()

    def step(self) -> None:
        if self.child is None:
            if self.clock() >= self.restart_at:
                self.start_chain()
            return
        if not self.ready_seen and self.ready():
            self.ready_seen = True
            self.backoff = 0.0
        code = self.child.poll()
        if self.state["pending"]:
            if code is not None:
                self.child = None
                self.end_probation(False, "exited")
            elif self.ready_seen:
                self.end_probation(True)
            elif self.deadline is not None and self.clock() >= self.deadline:
                self.end_probation(False, "not_ready")
            return
        if code is not None:
            self.child = None
            if code == RESTART_EXIT:
                log("launcher.restart", version=self.version_of(self.running_version or BUILTIN))
                self.restart_at = self.clock()
            else:
                self.backoff = min(60.0, max(2.0, self.backoff * 2))
                log("launcher.child_exited", code=code, afterSeconds=self.backoff)
                self.restart_at = self.clock() + self.backoff
            return
        self.manual_rollback()
        if self.child is not None:
            self.take_incoming()

    def stop(self, *_args: Any) -> None:
        self.stopping = True

    def run(self) -> int:
        signal.signal(signal.SIGTERM, self.stop)
        signal.signal(signal.SIGINT, self.stop)
        self.resume()
        self.start_chain()
        while not self.stopping:
            self.step()
            time.sleep(self.tick)
        self.stop_child()
        log("launcher.stopped")
        return 0


# ── command line ──

def root_from_env() -> Path:
    return Path(os.environ.get("KIN_UPDATE_ROOT", "/data/agent-releases"))


def cmd_install(args: argparse.Namespace) -> int:
    paths = Paths(root_from_env())
    state = read_state(paths)
    running = state.get("running") or state.get("current") or BUILTIN
    running_version = builtin_version() if running == BUILTIN else running
    raw = Path(args.file).read_bytes()
    try:
        release = verify_bundle(raw, load_keys(os.environ.get("GW_UPDATE_KEYS")), newer_than=running_version)
    except UpdateRefused as refused:
        print(json.dumps({"result": "refused", "code": refused.code}))
        return 1
    publish_incoming(paths, raw)
    print(json.dumps({"result": "handed_to_launcher", "version": release.version, "from": running_version}))
    return 0


def cmd_status(_args: argparse.Namespace) -> int:
    state = read_state(Paths(root_from_env()))
    state["builtin"] = builtin_version()
    print(json.dumps(state, separators=(",", ":")))
    return 0


def cmd_rollback(_args: argparse.Namespace) -> int:
    paths = Paths(root_from_env())
    write_atomic(paths.control / "rollback", b"1")
    print(json.dumps({"result": "handed_to_launcher"}))
    return 0


def cmd_keygen(args: argparse.Namespace) -> int:
    seed = os.urandom(32)
    out = Path(args.out)
    fd = os.open(out, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w") as handle:
        handle.write(seed.hex() + "\n")
    print(base64.b64encode(ed25519.public_key(seed)).decode("ascii"))
    return 0


def cmd_sign(args: argparse.Namespace) -> int:
    seed = bytes.fromhex(Path(args.key).read_text(encoding="ascii").strip())
    files = {Path(name).name: Path(name).read_bytes() for name in args.files}
    Path(args.out).write_bytes(make_bundle(seed, args.version, files))
    print(json.dumps({"version": args.version, "files": sorted(files), "out": args.out}))
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="KIN Gateway launcher and signed updates")
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("run", help="run the Gateway agent (container command)")
    install = sub.add_parser("install", help="verify a signed bundle and hand it to the running launcher")
    install.add_argument("file")
    sub.add_parser("status", help="print the update state")
    sub.add_parser("rollback", help="ask the running launcher to switch back to the previous release")
    keygen = sub.add_parser("keygen", help="release tool: make a private key file and print its public key")
    keygen.add_argument("--out", required=True)
    sign = sub.add_parser("sign", help="release tool: sign agent files as one bundle")
    sign.add_argument("--key", required=True)
    sign.add_argument("--version", required=True)
    sign.add_argument("--out", required=True)
    sign.add_argument("files", nargs="+")
    args = parser.parse_args(argv)
    if args.command == "run":
        return Launcher(root_from_env(), os.environ.get("GW_UPDATE_KEYS")).run()
    return {"install": cmd_install, "status": cmd_status, "rollback": cmd_rollback,
            "keygen": cmd_keygen, "sign": cmd_sign}[args.command](args)


if __name__ == "__main__":
    raise SystemExit(main())
