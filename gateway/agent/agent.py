"""KIN Gateway upload agent.

Only UIDs and counts are logged. Patient demographics travel in DICOM bytes but are never
written to the queue or logs.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import signal
import sqlite3
import sys
import time
import math
import tempfile
import threading
from collections import deque
from contextlib import contextmanager
import uuid
from dataclasses import dataclass
from urllib.parse import urlsplit
from pathlib import Path
from typing import Any, Callable, Iterable

import requests


MANAGED_PHASES = ("pending", "announcing", "sending", "retry", "failed", "complete")
# A receipt carries an errorCode exactly in these phases and null in every other one.
ERROR_PHASES = ("retry", "failed")


class GatewayError(RuntimeError):
    """An error safe to persist and print (it must not contain response bodies)."""


class PermanentGatewayError(GatewayError):
    """A study cannot succeed by retrying the same bytes and needs operator action."""


class SupportRefused(RuntimeError):
    """A remote-support action could not be carried out; the message is a fixed code sent to KIN as the result."""


class ForwardError(RuntimeError):
    """A delivery to a destination other than KIN failed. Safe to persist and print; never part of a KIN receipt (a
    forward row has none), so it has no receipt error code."""


# S4-U3: the receipt's errorCode. The free reason stays in the local queue and log; it never goes to
# KIN, because no string blacklist can prove a message is free of patient data. Keys are the message
# templates of every GatewayError constructed in this file ({} marks an f-string field, which never
# holds a space). test_agent.py enumerates the constructors by AST and fails on a template missing here.
GATEWAY_ERROR_CODES = {
    "missing environment: {}": "configuration",
    "invalid KIN base address": "configuration",
    "KIN destination no longer allowed": "other",
    "BYTE_BUDGET_MIB must be finite and > 0": "configuration",
    "local Orthanc {}": "local_orthanc_unreachable",
    "local Orthanc HTTP {}": "local_orthanc_http",
    "local study lookup count={}": "local_study_lookup",
    "local instance metadata incomplete": "local_instance_metadata",
    "duplicate local SOPInstanceUID": "local_duplicate_sop",
    "StableStudy missing Orthanc ID": "local_change_invalid",
    "StableStudy missing StudyInstanceUID": "local_change_invalid",
    "token request {}": "token_unreachable",
    "token request HTTP {}": "token_http",
    "token response invalid": "token_invalid",
    "cloud request {}": "cloud_unreachable",
    "cloud authentication failed": "cloud_auth",
    "announce HTTP {}": "announce_http",
    "STOW HTTP {}": "stow_http",
    "STOW response invalid": "stow_response_invalid",
    "STOW response shape invalid": "stow_response_invalid",
    "STOW failure sequence invalid": "stow_response_invalid",
    "STOW failure item missing SOPInstanceUID": "stow_response_invalid",
    "STOW response named an unknown failed SOP": "stow_response_invalid",
    "STOW failed SOP count={}": "stow_sop_failed",
    "successful SOP absent locally count={}": "local_sop_missing",
    "single DICOM instance exceeds byte budget": "instance_exceeds_budget",
    "multipart body exceeds byte budget": "batch_exceeds_budget",
}
GATEWAY_ERROR_FALLBACK = "other"
_ERROR_PATTERNS = tuple(
    (re.compile(r"\S+".join(re.escape(part) for part in template.split("{}"))), code)
    for template, code in GATEWAY_ERROR_CODES.items()
)


def error_code(error: BaseException) -> str:
    """Only the message template decides the code; nothing of the message itself is sent."""
    return error_code_of_text(str(error)) if isinstance(error, GatewayError) else GATEWAY_ERROR_FALLBACK


def error_code_of_text(message: str) -> str:
    """The same mapping for a reason already turned into text (a log field, a queue row's last error)."""
    for pattern, code in _ERROR_PATTERNS:
        if pattern.fullmatch(message):
            return code
    return GATEWAY_ERROR_FALLBACK


ERROR_CODE_VALUES = frozenset(GATEWAY_ERROR_CODES.values()) | {GATEWAY_ERROR_FALLBACK}
# seq advances in the same UPDATE as every change to a field the receipt carries (phase, attempt,
# counts, errorCode), so KIN can order one study's reports without trusting any agent clock.
RECEIPT_COLUMNS = (
    ("seq", "seq INTEGER NOT NULL DEFAULT 0"),
    ("local_count", "local_count INTEGER"),
    ("success_count", "success_count INTEGER NOT NULL DEFAULT 0"),
    ("error_code", "error_code TEXT"),
    ("announced", "announced INTEGER NOT NULL DEFAULT 0"),
    ("reported_seq", "reported_seq INTEGER NOT NULL DEFAULT 0"),
)
# not_routed: the study's destinations do not include KIN, so KIN is never announced to and gets no receipt.
FINAL_STUDY_PHASES = ("complete", "failed", "not_routed")
# KIN's final answers for one receipt: stored/replayed/stale (2xx) or refused for this body. Anything
# else (401/403/5xx, transport) leaves the receipt pending for a later pass.
RECEIPT_FINAL_REFUSALS = (400, 404, 409)
RECEIPT_REFUSAL_CODES = ("GATEWAY_EPOCH_UNRECOGNISED", "GATEWAY_RECEIPT_CONFLICT")
# S4-U4 Now Retry. A person's request waits at KIN and this agent pulls it: nothing listens for KIN. The
# cadence is fixed and slow, separate from the POLL_SECONDS loop, and deliberately not in Config or the
# environment: the poll can only move next_at, and nobody should be able to tune it into a retry storm.
# It shares the main loop, so a transfer in progress delays the next poll until that transfer returns.
RETRY_POLL_SECONDS = 30.0
RETRY_POLL_LIMIT = 100
RETRY_POLL_UID = re.compile(r"[0-9.]+")
# Operational status (heartbeat). The admin console shows, per Gateway credential, when KIN last heard from it, its queue,
# its version, how long it has run, its last accepted STOW and whether the local DICOM listener answers. The beat runs on
# its own thread so a long STOW (up to STOW_TIMEOUT_SECONDS) never reads as a lost Gateway. Fixed cadence, not in Config.
AGENT_VERSION = "2026.11.2"
HEARTBEAT_SECONDS = 30.0
# Signed updates (update.py, the container's launcher). The launcher names the signed version of the release it runs in
# KIN_AGENT_RUN_VERSION, so the heartbeat and the console show the version that was verified, not a constant in a file.
# It also names a ready file for this start: written once this run finished one main-loop pass and KIN stored one of
# its heartbeats — the launcher keeps a new release only then. Exit RESTART_EXIT asks the launcher to start again now.
RUN_VERSION = re.compile(r"[0-9]{1,9}(?:\.[0-9]{1,9}){0,7}")
RESTART_EXIT = 75
# Remote support: an admin of this institution asks KIN for one action on this Gateway (diagnostics, restart, update to a
# version KIN holds); the agent fetches it over its own outbound call — nothing listens for KIN. The host can switch it
# off (GW_REMOTE_SUPPORT=off): every request is then answered refused, and the local manual procedure still works.
SUPPORT_SECONDS = 30.0
SUPPORT_ACTIONS = ("diagnostics", "restart", "update")
SUPPORT_CODE = re.compile(r"[a-z_]{1,40}")
DIAGNOSTICS_MAX_BYTES = 256 * 1024
DIAGNOSTICS_ROWS_MAX = 200
UPDATE_DOWNLOAD_MAX_BYTES = 6 * 1024 * 1024


def run_version() -> str:
    value = os.environ.get("KIN_AGENT_RUN_VERSION", "")
    return value if len(value) <= 32 and RUN_VERSION.fullmatch(value) else AGENT_VERSION
# Gateway settings (routing rules and lossless compression) are set by the institution's
# administrator in KIN and read by the heartbeat thread every SETTINGS_EVERY beats (the first right after start). No
# settings = KIN only, nothing deleted, nothing transcoded: exactly the behaviour before settings existed.
SETTINGS_EVERY = 2
KIN_DESTINATION = "kin"
# The stored transfer syntaxes lossless compression may replace (native, uncompressed pixel data), and the one it sends:
# JPEG Lossless, Non-Hierarchical, First-Order Prediction. Anything else (already compressed, lossy or unknown) is sent
# with its own bytes; there is no path to a lossy syntax.
NATIVE_SYNTAXES = frozenset(("1.2.840.10008.1.2", "1.2.840.10008.1.2.1", "1.2.840.10008.1.2.2"))
LOSSLESS_SYNTAX = "1.2.840.10008.1.2.4.70"
SETTINGS_ROUTES_MAX = 32
SETTINGS_DESTINATIONS_MAX = 9
_SETTINGS_ID = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")
_SETTINGS_AE = re.compile(r"[ -~]{1,16}")
_SETTINGS_MODALITY = re.compile(r"[A-Z0-9]{1,16}")
_SETTINGS_HOST = re.compile(r"[A-Za-z0-9.:\-]{1,253}")
NO_SETTINGS: dict[str, Any] = {"revision": 0, "routes": [], "compression": "none", "peers": {}}


def _closed(value: Any, keys: set[str]) -> bool:
    return isinstance(value, dict) and set(value) == keys


def parse_settings(payload: Any) -> dict[str, Any] | None:
    """KIN's GET /api/gateway/settings answer as the agent uses it, or None when its shape is not exactly the contract.

    Closed shape on purpose: an answer this agent does not understand is never half applied; the last good settings stay.
    """
    if not _closed(payload, {"revision", "routes", "compression", "destinations"}):
        return None
    revision, routes = payload["revision"], payload["routes"]
    if not isinstance(revision, int) or isinstance(revision, bool) or revision < 0:
        return None
    if payload["compression"] not in ("none", "lossless"):
        return None
    peers: dict[str, dict[str, Any]] = {}
    destinations = payload["destinations"]
    if not isinstance(destinations, list):
        return None
    for peer in destinations:
        if not _closed(peer, {"id", "name", "aet", "host", "port"}):
            return None
        if not (isinstance(peer["id"], str) and _SETTINGS_ID.fullmatch(peer["id"]) and peer["id"] not in peers
                and isinstance(peer["name"], str) and 0 < len(peer["name"]) <= 64
                and isinstance(peer["aet"], str) and _SETTINGS_AE.fullmatch(peer["aet"])
                and isinstance(peer["host"], str) and _SETTINGS_HOST.fullmatch(peer["host"])
                and isinstance(peer["port"], int) and not isinstance(peer["port"], bool) and 1 <= peer["port"] <= 65535):
            return None
        peers[peer["id"]] = {"aet": peer["aet"], "host": peer["host"], "port": peer["port"]}
    if not isinstance(routes, list) or len(routes) > SETTINGS_ROUTES_MAX:
        return None
    normalized = []
    for route in routes:
        if not _closed(route, {"modality", "sourceAe", "destinations"}):
            return None
        modality, source, targets = route["modality"], route["sourceAe"], route["destinations"]
        if modality is not None and not (isinstance(modality, str) and _SETTINGS_MODALITY.fullmatch(modality)):
            return None
        if source is not None and not (isinstance(source, str) and _SETTINGS_AE.fullmatch(source)):
            return None
        if (not isinstance(targets, list) or not 1 <= len(targets) <= SETTINGS_DESTINATIONS_MAX
                or len(set(map(str, targets))) != len(targets)
                or not all(isinstance(target, str) and (target == KIN_DESTINATION or target in peers) for target in targets)):
            return None
        normalized.append({"modality": modality, "sourceAe": source, "destinations": list(targets)})
    return {"revision": revision, "routes": normalized, "compression": payload["compression"],
            "peers": peers}


def route_for(routes: list[dict[str, Any]], modalities: set[str], source_aes: set[str]) -> list[str]:
    """The one routing rule: the study goes to every destination of every route whose conditions all hold (in the order
    they first appear); no route holds -> KIN. Order-free: one study (CT and SR series, two sending devices) may hold for
    several routes, and none of them is dropped.

    A condition is one value the agent already has: a Modality of any series of the study, or the sending device's AE of
    any instance (the RemoteAET of its C-STORE). A route with neither condition holds for every study. The study is the
    unit: a study is never split between destinations.
    """
    chosen: list[str] = []
    for route in routes:
        if route["modality"] is not None and route["modality"] not in modalities:
            continue
        if route["sourceAe"] is not None and route["sourceAe"] not in source_aes:
            continue
        chosen += [dest for dest in route["destinations"] if dest not in chosen]
    return chosen or [KIN_DESTINATION]


def kin_base_address(value: str) -> str:
    """Normalize the origin and trailing slash while keeping distinct (case-sensitive) base paths."""
    try:
        parts = urlsplit(value.strip())
        host, port = parts.hostname, parts.port
        if (parts.scheme not in ("http", "https") or not host or parts.username is not None
                or parts.query or parts.fragment or "\\" in value):
            raise ValueError
    except ValueError:
        raise GatewayError("invalid KIN base address") from None
    authority = f"[{host}]" if ":" in host else host
    if port is not None and port != {"http": 80, "https": 443}[parts.scheme]:
        authority += f":{port}"
    return f"{parts.scheme}://{authority}{parts.path.rstrip('/')}"


class SettingsStore:
    """The last good Gateway settings: in memory for the main loop, in a file beside the queue for the next start.

    Only the heartbeat thread writes (one assignment of a new dict, and a whole-file replace); the main loop only reads
    `.current` and `.known`. Unknown is not "no rules": until a good answer was taken once (now or by an earlier run of
    this same Gateway credential, kept in the file), `.known` is False and the main loop sends nothing, because a study
    a rule keeps away from KIN must not go to KIN by default. KIN answers empty settings when none are set.
    """

    def __init__(self, queue_db: str, owner: dict[str, str]):
        self.path = Path(queue_db).with_name("settings.json")
        self.owner = owner
        self.identity_error = None
        stored = None
        try:
            saved = json.loads(self.path.read_text(encoding="utf-8"))
            if isinstance(saved, dict) and all(saved.get(k) == v for k, v in owner.items()):
                stored = saved.get("answer")
            else:
                self.identity_error = "settings_identity_mismatch"
        except FileNotFoundError:
            pass
        except (OSError, ValueError):
            self.identity_error = "settings_identity_unknown"
        parsed = parse_settings(stored)
        self.raw: Any = stored if parsed is not None else None
        self.current: dict[str, Any] = parsed if parsed is not None else NO_SETTINGS
        self.known = parsed is not None

    def accept(self, payload: Any) -> bool:
        """Take a new answer when it is good. True when it is good (changed or not)."""
        parsed = parse_settings(payload)
        if parsed is None:
            return False
        if payload != self.raw or not self.known:
            temporary = self.path.with_name(self.path.name + ".tmp")
            temporary.write_text(json.dumps({**self.owner, "answer": payload}, separators=(",", ":")),
                                 encoding="utf-8")
            os.replace(temporary, self.path)
            self.raw = payload
            self.current = parsed
        self.known = True
        return True


_LOG_LOCK = threading.Lock()
# The last LOG_RING_MAX log lines of this run, as the remote-support diagnostics carry them: the time, the event and
# only numbers, true/false and error codes — never a UID, a destination or free text.
LOG_RING_MAX = 200
LOG_RING: deque[dict[str, Any]] = deque(maxlen=LOG_RING_MAX)
_SAFE_EVENT = re.compile(r"[a-z_.]{1,64}")


def _ring_line(safe: dict[str, Any]) -> dict[str, Any]:
    line: dict[str, Any] = {"at": safe["at"], "event": safe["event"] if _SAFE_EVENT.fullmatch(safe["event"]) else "other"}
    for key, value in safe.items():
        if key in ("at", "event", "uid") or not re.fullmatch(r"[A-Za-z]{1,32}", key):
            continue
        if isinstance(value, bool) or (isinstance(value, int) and abs(value) < 2 ** 53):
            line[key] = value
        elif isinstance(value, float) and math.isfinite(value):
            line[key] = round(value, 3)
        elif key in ("error", "code") and isinstance(value, str):
            line[key] = value if value in ERROR_CODE_VALUES else error_code_of_text(value)
    return line


def log(event: str, *, uid: str | None = None, **fields: Any) -> None:
    safe = {"at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "event": event}
    if uid:
        safe["uid"] = uid
    safe.update(fields)
    # One whole line per write, one writer at a time: the main loop and the heartbeat thread both log, and print() writes
    # the text and the newline separately, so two lines written at once could interleave into one unreadable line.
    line = json.dumps(safe, ensure_ascii=False, separators=(",", ":")) + "\n"
    with _LOG_LOCK:
        LOG_RING.append(_ring_line(safe))
        sys.stdout.write(line)
        sys.stdout.flush()


def truthy(value: str) -> bool:
    return value.strip().lower() not in {"0", "false", "no", "off"}


def required(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise GatewayError(f"missing environment: {name}")
    return value


@dataclass(frozen=True)
class Config:
    orthanc_url: str
    orthanc_user: str
    orthanc_pass: str
    kin_base_url: str
    client_id: str
    client_secret: str
    tls_verify: bool
    queue_db: str
    byte_budget: int
    poll_seconds: float
    http_timeout: float
    stow_timeout: float
    backoff_base: float
    backoff_max: float

    @classmethod
    def from_env(cls) -> "Config":
        budget_mib = float(os.environ.get("BYTE_BUDGET_MIB", "24"))
        if not math.isfinite(budget_mib) or budget_mib <= 0:
            raise GatewayError("BYTE_BUDGET_MIB must be finite and > 0")
        return cls(
            orthanc_url=required("LOCAL_ORTHANC_URL").rstrip("/"),
            orthanc_user=required("LOCAL_ORTHANC_USER"),
            orthanc_pass=required("LOCAL_ORTHANC_PASS"),
            kin_base_url=required("KIN_BASE_URL").rstrip("/"),
            client_id=required("KIN_CLIENT_ID"),
            client_secret=required("KIN_CLIENT_SECRET"),
            tls_verify=truthy(os.environ.get("KIN_TLS_VERIFY", "true")),
            queue_db=os.environ.get("QUEUE_DB", "/data/queue.db"),
            byte_budget=int(budget_mib * 1024 * 1024),
            poll_seconds=max(0.2, float(os.environ.get("POLL_SECONDS", "2"))),
            http_timeout=max(1, float(os.environ.get("HTTP_TIMEOUT_SECONDS", "30"))),
            stow_timeout=max(1, float(os.environ.get("STOW_TIMEOUT_SECONDS", "300"))),
            backoff_base=max(0.2, float(os.environ.get("BACKOFF_BASE_SECONDS", "5"))),
            backoff_max=max(1, float(os.environ.get("BACKOFF_MAX_SECONDS", "300"))),
        )


class Queue:
    def __init__(self, path: str):
        Path(path).parent.mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(path)
        self.db.row_factory = sqlite3.Row
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.execute("PRAGMA synchronous=FULL")
        self.db.executescript("""
          CREATE TABLE IF NOT EXISTS studies (
            uid TEXT PRIMARY KEY,
            orthanc_id TEXT NOT NULL,
            phase TEXT NOT NULL DEFAULT 'pending',
            batch_index INTEGER NOT NULL DEFAULT 0,
            successful_sops TEXT NOT NULL DEFAULT '[]',
            attempt INTEGER NOT NULL DEFAULT 0,
            next_at REAL NOT NULL DEFAULT 0,
            last_error TEXT,
            updated_at REAL NOT NULL
          );
          CREATE TABLE IF NOT EXISTS meta (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
          );
          CREATE TABLE IF NOT EXISTS forwards (
            uid TEXT NOT NULL,
            dest TEXT NOT NULL,
            phase TEXT NOT NULL DEFAULT 'pending',
            successful_sops TEXT NOT NULL DEFAULT '[]',
            attempt INTEGER NOT NULL DEFAULT 0,
            next_at REAL NOT NULL DEFAULT 0,
            last_error TEXT,
            peer TEXT,
            updated_at REAL NOT NULL,
            PRIMARY KEY (uid, dest)
          );
        """)
        self.db.commit()
        # S4-U3 receipt state. New and pre-receipt queues take the same path, so an installed queue keeps
        # every row and phase. The epoch is born with this queue: a recreated queue is a new epoch, and
        # KIN refuses it for studies an earlier epoch already reported (no automatic rollover, H-1).
        with self.db:
            self.db.execute("BEGIN IMMEDIATE")
            for table, additions in (("studies", (*RECEIPT_COLUMNS, ("destinations", "destinations TEXT"))),
                                     ("forwards", (("peer", "peer TEXT"),))):
                columns = {row["name"] for row in self.db.execute(f"PRAGMA table_info({table})")}
                for name, ddl in additions:
                    if name not in columns:
                        self.db.execute(f"ALTER TABLE {table} ADD COLUMN {ddl}")
            self.db.execute("INSERT OR IGNORE INTO meta(key, value) VALUES ('epoch', ?)", (str(uuid.uuid4()),))
        self.epoch = str(self.db.execute("SELECT value FROM meta WHERE key='epoch'").fetchone()["value"])

    def close(self) -> None:
        self.db.close()

    def changes_since(self) -> int:
        row = self.db.execute("SELECT value FROM meta WHERE key='changes_since'").fetchone()
        return int(row["value"]) if row else 0

    def record_changes(self, studies: Iterable[tuple[str, str]], last: int) -> None:
        now = time.time()
        with self.db:
            for uid, orthanc_id in studies:
                self.db.execute("""
                  INSERT INTO studies(uid, orthanc_id, phase, next_at, updated_at)
                  VALUES (?, ?, 'pending', 0, ?)
                  ON CONFLICT(uid) DO UPDATE SET
                    orthanc_id=excluded.orthanc_id,
                    phase='pending', batch_index=0, attempt=0, next_at=0,
                    last_error=NULL, error_code=NULL, seq=seq+1, updated_at=excluded.updated_at
                """, (uid, orthanc_id, now))
                # Every destination the study already has looks again at what is local now (only the delta goes out).
                self.db.execute("""
                  UPDATE forwards SET phase='pending', attempt=0, next_at=0, last_error=NULL, updated_at=? WHERE uid=?
                """, (now, uid))
            self.db.execute("""
              INSERT INTO meta(key, value) VALUES ('changes_since', ?)
              ON CONFLICT(key) DO UPDATE SET value=excluded.value
            """, (str(last),))

    def due(self) -> sqlite3.Row | None:
        return self.db.execute("""
          SELECT * FROM studies
          WHERE phase NOT IN ('complete', 'failed', 'not_routed') AND next_at <= ?
          ORDER BY updated_at, uid LIMIT 1
        """, (time.time(),)).fetchone()

    # ── routing: the study's destinations and one row per destination other than KIN ──

    def destinations(self, uid: str) -> list[str] | None:
        row = self.db.execute("SELECT destinations FROM studies WHERE uid=?", (uid,)).fetchone()
        if not row or row["destinations"] is None:
            return None
        try:
            value = json.loads(row["destinations"])
        except (TypeError, json.JSONDecodeError):
            return None
        return [str(item) for item in value] if isinstance(value, list) else None

    def set_destinations(self, uid: str, destinations: list[str], peers: dict[str, dict[str, Any]] | None = None) -> None:
        """Keep the original registration alongside each forward, including its address at decision time."""
        now = time.time()
        with self.db:
            self.db.execute("UPDATE studies SET destinations=? WHERE uid=?", (json.dumps(destinations), uid))
            for dest in destinations:
                if dest != KIN_DESTINATION:
                    address = (peers or {}).get(dest)
                    self.db.execute("""
                      INSERT INTO forwards(uid, dest, phase, peer, updated_at) VALUES (?, ?, 'pending', ?, ?)
                      ON CONFLICT(uid, dest) DO NOTHING
                    """, (uid, dest, json.dumps(address) if address else None, now))

    def not_routed(self, uid: str) -> None:
        with self.db:
            self.db.execute("""
              UPDATE studies SET phase='not_routed', attempt=0, next_at=0, last_error=NULL, error_code=NULL, seq=seq+1,
                updated_at=?
              WHERE uid=?
            """, (time.time(), uid))

    def orthanc_id(self, uid: str) -> str:
        row = self.db.execute("SELECT orthanc_id FROM studies WHERE uid=?", (uid,)).fetchone()
        return str(row["orthanc_id"]) if row else ""

    def forward_due(self) -> sqlite3.Row | None:
        return self.db.execute("""
          SELECT * FROM forwards WHERE phase != 'complete' AND next_at <= ? ORDER BY updated_at, uid, dest LIMIT 1
        """, (time.time(),)).fetchone()

    def forward_successes(self, uid: str, dest: str) -> set[str]:
        row = self.db.execute("SELECT successful_sops FROM forwards WHERE uid=? AND dest=?", (uid, dest)).fetchone()
        try:
            value = json.loads(row["successful_sops"]) if row else []
            return {str(item) for item in value if isinstance(item, str)}
        except (TypeError, json.JSONDecodeError):
            return set()

    def forward_add(self, uid: str, dest: str, sops: set[str]) -> None:
        merged = self.forward_successes(uid, dest) | sops
        with self.db:
            self.db.execute("UPDATE forwards SET successful_sops=?, updated_at=? WHERE uid=? AND dest=?",
                            (json.dumps(sorted(merged)), time.time(), uid, dest))

    def forward_phase(self, uid: str, dest: str, phase: str) -> None:
        if phase not in ("pending", "sending", "complete"):
            raise ValueError(f"unknown forward phase: {phase}")
        reset = ", attempt=0, next_at=0, last_error=NULL" if phase in ("pending", "complete") else ""
        with self.db:
            self.db.execute(f"UPDATE forwards SET phase=?{reset}, updated_at=? WHERE uid=? AND dest=?",
                            (phase, time.time(), uid, dest))

    def forward_retry(self, uid: str, dest: str, reason: str, base: float, maximum: float) -> tuple[int, float]:
        row = self.db.execute("SELECT attempt FROM forwards WHERE uid=? AND dest=?", (uid, dest)).fetchone()
        attempt = int(row["attempt"] if row else 0) + 1
        delay = min(maximum, base * (2 ** min(attempt - 1, 16)))
        with self.db:
            self.db.execute("""
              UPDATE forwards SET phase='retry', attempt=?, next_at=?, last_error=?, updated_at=? WHERE uid=? AND dest=?
            """, (attempt, time.time() + delay, reason[:160], time.time(), uid, dest))
        return attempt, delay

    def check_owner(self, owner: dict[str, str], settings_error: str | None) -> str | None:
        """Queues from before routing can bind on upgrade. Fixed routes require a known owner."""
        with self.db:
            self.db.execute("BEGIN IMMEDIATE")
            meta = dict(self.db.execute("SELECT key, value FROM meta"))
            encoded = json.dumps(owner, sort_keys=True)
            error = settings_error
            if "owner" in meta:
                if meta["owner"] != encoded:
                    error = "queue_identity_mismatch"
            elif self.db.execute("""
                SELECT 1 FROM forwards UNION ALL SELECT 1 FROM studies WHERE destinations IS NOT NULL LIMIT 1
            """).fetchone():
                error = "queue_identity_unknown"
            elif not error:
                self.db.execute("INSERT INTO meta(key, value) VALUES ('owner', ?)", (encoded,))
            if error:
                self.db.execute("INSERT OR REPLACE INTO meta(key, value) VALUES ('identity_error', ?)", (error,))
            elif "identity_error" in meta:
                self.db.execute("DELETE FROM meta WHERE key='identity_error'")
        return error

    def successes(self, uid: str) -> set[str]:
        row = self.db.execute("SELECT successful_sops FROM studies WHERE uid=?", (uid,)).fetchone()
        if not row:
            return set()
        try:
            value = json.loads(row["successful_sops"])
            return {str(item) for item in value if isinstance(item, str)}
        except (TypeError, json.JSONDecodeError):
            return set()

    def phase(self, uid: str, phase: str, batch_index: int | None = None) -> None:
        if phase not in MANAGED_PHASES:
            raise ValueError(f"unknown phase: {phase}")
        if phase in ERROR_PHASES:
            raise ValueError(f"{phase} carries an error code; use retry() or fail()")
        values: list[Any] = [phase, time.time(), uid]
        sql = "UPDATE studies SET phase=?, error_code=NULL, seq=seq+1, updated_at=?"
        if batch_index is not None:
            sql += ", batch_index=?"
            values = [phase, time.time(), batch_index, uid]
        sql += " WHERE uid=?"
        with self.db:
            self.db.execute(sql, values)

    def announced(self, uid: str, local_count: int, success_count: int) -> None:
        """KIN accepted the announce, so this study's state may now be reported."""
        with self.db:
            self.db.execute("""
              UPDATE studies SET announced=1, local_count=?, success_count=?, seq=seq+1, updated_at=?
              WHERE uid=?
            """, (local_count, success_count, time.time(), uid))

    def counts(self, uid: str, local_count: int, success_count: int) -> None:
        with self.db:
            self.db.execute("""
              UPDATE studies SET local_count=?, success_count=?, seq=seq+1, updated_at=? WHERE uid=?
            """, (local_count, success_count, time.time(), uid))

    def add_successes(self, uid: str, sops: set[str], batch_index: int) -> None:
        merged = self.successes(uid) | sops
        with self.db:
            self.db.execute("""
              UPDATE studies SET successful_sops=?, batch_index=?, updated_at=? WHERE uid=?
            """, (json.dumps(sorted(merged)), batch_index, time.time(), uid))

    def complete(self, uid: str, sops: int) -> None:
        # complete is exactly "the local SOP set equals the sent set at this check", so M == N here.
        with self.db:
            self.db.execute("""
              UPDATE studies SET phase='complete', attempt=0, next_at=0,
                last_error=NULL, error_code=NULL, local_count=?, success_count=?, seq=seq+1, updated_at=?
              WHERE uid=?
            """, (sops, sops, time.time(), uid))

    def pending_now(self, uid: str, local_count: int, success_count: int) -> None:
        with self.db:
            self.db.execute("""
              UPDATE studies SET phase='pending', attempt=0, next_at=0,
                last_error=NULL, error_code=NULL, local_count=?, success_count=?, seq=seq+1, updated_at=?
              WHERE uid=?
            """, (local_count, success_count, time.time(), uid))

    def fail(self, uid: str, reason: str, code: str = GATEWAY_ERROR_FALLBACK) -> None:
        with self.db:
            self.db.execute("""
              UPDATE studies SET phase='failed', next_at=0, last_error=?, error_code=?, seq=seq+1, updated_at=?
              WHERE uid=?
            """, (reason[:160], code if code in ERROR_CODE_VALUES else GATEWAY_ERROR_FALLBACK, time.time(), uid))

    def retry(
        self, uid: str, reason: str, base: float, maximum: float, code: str = GATEWAY_ERROR_FALLBACK,
    ) -> tuple[int, float]:
        row = self.db.execute("SELECT attempt FROM studies WHERE uid=?", (uid,)).fetchone()
        attempt = int(row["attempt"] if row else 0) + 1
        delay = min(maximum, base * (2 ** min(attempt - 1, 16)))
        with self.db:
            self.db.execute("""
              UPDATE studies SET phase='retry', attempt=?, next_at=?, last_error=?, error_code=?, seq=seq+1,
                updated_at=?
              WHERE uid=?
            """, (attempt, time.time() + delay, reason[:160],
                  code if code in ERROR_CODE_VALUES else GATEWAY_ERROR_FALLBACK, time.time(), uid))
        return attempt, delay

    def receipt(self, uid: str) -> dict[str, Any] | None:
        """The closed receipt body, or None before a successful announce (KIN would answer 404).

        No time, institution or free text: KIN orders by (epoch, seq) and stamps its own reception time,
        and the institution comes only from the client credentials.
        """
        row = self.db.execute("""
          SELECT phase, attempt, seq, local_count, success_count, error_code, announced FROM studies WHERE uid=?
        """, (uid,)).fetchone()
        if not row or not row["announced"] or row["local_count"] is None:
            return None
        phase = str(row["phase"])
        return {
            "studyUid": uid,
            "phase": phase,
            "attempt": int(row["attempt"]),
            "successCount": int(row["success_count"]),
            "localCount": int(row["local_count"]),
            "errorCode": (row["error_code"] or GATEWAY_ERROR_FALLBACK) if phase in ERROR_PHASES else None,
            "epoch": self.epoch,
            "seq": int(row["seq"]),
        }

    def unreported(self, limit: int = 16) -> list[str]:
        return [str(row["uid"]) for row in self.db.execute("""
          SELECT uid FROM studies
          WHERE announced=1 AND local_count IS NOT NULL AND seq > reported_seq
          ORDER BY updated_at, uid LIMIT ?
        """, (limit,))]

    def reported(self, uid: str, seq: int) -> None:
        with self.db:
            self.db.execute("UPDATE studies SET reported_seq=? WHERE uid=? AND reported_seq < ?", (seq, uid, seq))

    def waiting(self, uid: str, seq: int, now: float) -> bool:
        """This exact retry state is still waiting out its backoff (the retry_now condition, read only)."""
        return self.db.execute(
            "SELECT 1 FROM studies WHERE uid=? AND phase='retry' AND seq=? AND next_at>?", (uid, seq, now),
        ).fetchone() is not None

    def retry_now(self, uid: str, seq: int, now: float) -> bool:
        """S4-U4: make this exact retry state eligible now. True only when this call changed the row.

        next_at is the only column written: attempt, last_error, error_code, successful_sops, batch_index,
        the counts and updated_at stay, and seq does not move (next_at is not a receipt field). A failed
        manual attempt therefore climbs the same backoff ladder, and pending_now's reset is never used.
        """
        with self.db:
            cursor = self.db.execute(
                "UPDATE studies SET next_at=0 WHERE uid=? AND phase='retry' AND seq=? AND next_at>?", (uid, seq, now),
            )
        return cursor.rowcount == 1

    def summary(self) -> dict[str, Any]:
        counts = {row["phase"]: row["n"] for row in self.db.execute(
            "SELECT phase, count(*) AS n FROM studies GROUP BY phase"
        )}
        forwards: dict[str, list[dict[str, Any]]] = {}
        for row in self.db.execute("SELECT * FROM forwards ORDER BY uid, dest"):
            forwards.setdefault(str(row["uid"]), []).append({
                "destination": row["dest"], "phase": row["phase"],
                "successfulSops": len(json.loads(row["successful_sops"])), "attempt": row["attempt"],
                "lastError": row["last_error"],
            })
        rows = [{
            "uid": row["uid"], "phase": row["phase"], "batchIndex": row["batch_index"],
            "successfulSops": len(json.loads(row["successful_sops"])), "attempt": row["attempt"],
            "lastError": row["last_error"],
            "destinations": json.loads(row["destinations"]) if row["destinations"] else [KIN_DESTINATION],
            "forwards": forwards.get(str(row["uid"]), []),
        } for row in self.db.execute("SELECT * FROM studies ORDER BY updated_at, uid")]
        error = self.db.execute("SELECT value FROM meta WHERE key='identity_error'").fetchone()
        return {
            "identityError": error["value"] if error else None,
            "pending": sum(
                count for phase, count in counts.items() if phase not in FINAL_STUDY_PHASES
            ),
            "failed": counts.get("failed", 0),
            "complete": counts.get("complete", 0),
            "notRouted": counts.get("not_routed", 0),
            "rows": rows,
        }


def queue_counts(path: str) -> dict[str, int]:
    """The heartbeat's queue numbers, read on a connection of its own that never writes (the main loop stays the only
    writer of the queue). waiting = not yet sent and not backing off; complete is not reported."""
    db = sqlite3.connect(Path(path).resolve().as_uri() + "?mode=ro", uri=True, timeout=5)
    try:
        counts = {str(phase): int(n) for phase, n in db.execute("SELECT phase, count(*) FROM studies GROUP BY phase")}
    finally:
        db.close()
    return {
        "waiting": sum(counts.get(phase, 0) for phase in ("pending", "announcing", "sending")),
        "retry": counts.get("retry", 0),
        "failed": counts.get("failed", 0),
    }


class Orthanc:
    def __init__(self, config: Config):
        self.base = config.orthanc_url
        self.auth = (config.orthanc_user, config.orthanc_pass)
        self.timeout = config.http_timeout
        self.session = requests.Session()
        # Orthanc may close an idle keep-alive socket just as the next read reuses it, and requests does not
        # retry that, so every local read asks for its own connection. Cloud keeps its pool (S4-EG1 X-2).
        self.session.headers["Connection"] = "close"
        # What the last local REST request found, as (answered, monotonic time), or None before the first one. Only the
        # Orthanc REST API is observed: an HTTP answer of any status is "answered", a transport error is "no answer". It
        # says nothing about the DICOM port itself. The heartbeat thread only reads it (one tuple assignment).
        self.observed: tuple[bool, float] | None = None

    def request(self, method: str, path: str, *, timeout: float | None = None, **kwargs: Any) -> requests.Response:
        try:
            response = self.session.request(
                method, self.base + path, auth=self.auth, timeout=timeout or self.timeout, **kwargs,
            )
        except requests.RequestException as error:
            self.observed = (False, time.monotonic())
            raise GatewayError(f"local Orthanc {type(error).__name__}") from None
        self.observed = (True, time.monotonic())
        if not response.ok:
            raise GatewayError(f"local Orthanc HTTP {response.status_code}")
        return response

    def changes(self, since: int) -> dict[str, Any]:
        return self.request("GET", "/changes", params={"since": since, "limit": 100}).json()

    def study(self, uid: str, preferred_id: str = "") -> tuple[str, dict[str, Any]]:
        if preferred_id:
            try:
                detail = self.request("GET", f"/studies/{preferred_id}").json()
                if str((detail.get("MainDicomTags") or {}).get("StudyInstanceUID", "")) == uid:
                    return preferred_id, detail
            except GatewayError:
                pass
        found = self.request(
            "POST", "/tools/lookup", data=uid.encode("ascii"),
            headers={"Content-Type": "text/plain"},
        ).json()
        studies = [item for item in found if item.get("Type") == "Study"]
        if len(studies) != 1:
            raise GatewayError(f"local study lookup count={len(studies)}")
        orthanc_id = str(studies[0]["ID"])
        return orthanc_id, self.request("GET", f"/studies/{orthanc_id}").json()

    def instances(self, uid: str, preferred_id: str) -> tuple[str, dict[str, Any], list[dict[str, Any]]]:
        orthanc_id, detail = self.study(uid, preferred_id)
        items = self.request("GET", f"/studies/{orthanc_id}/instances").json()
        normalized = []
        for item in items:
            sop = str((item.get("MainDicomTags") or {}).get("SOPInstanceUID", ""))
            instance_id = str(item.get("ID", ""))
            size = int(item.get("FileSize", 0))
            if not sop or not instance_id or size <= 0:
                raise GatewayError("local instance metadata incomplete")
            # RemoteAET is Orthanc's C-STORE association fact, not a DICOM patient-supplied tag.
            metadata = self.request("GET", f"/instances/{instance_id}/metadata?expand").json()
            normalized.append({"sop": sop, "id": instance_id, "size": size,
                               "source_ae": str(metadata.get("RemoteAET", "")),
                               "syntax": str(metadata.get("TransferSyntax", ""))})
        if len({item["sop"] for item in normalized}) != len(normalized):
            raise GatewayError("duplicate local SOPInstanceUID")
        normalized.sort(key=lambda item: item["sop"])
        return orthanc_id, detail, normalized

    def copy_file(self, instance_id: str, sink) -> int:
        size = 0
        with self.request("GET", f"/instances/{instance_id}/file", stream=True) as response:
            for chunk in response.iter_content(chunk_size=65536):
                sink.write(chunk)
                size += len(chunk)
        return size

    def copy_lossless(self, instance_id: str, sink) -> int | None:
        """The instance transcoded by Orthanc to LOSSLESS_SYNTAX, or None (nothing written) when Orthanc refuses it.

        A refusal is an HTTP answer before any byte is written, so the caller then copies the original bytes. A failure
        after the first byte (a broken connection) raises like copy_file and the whole batch is retried.
        """
        try:
            response = self.request("GET", f"/instances/{instance_id}/file", params={"transcode": LOSSLESS_SYNTAX},
                                    stream=True)
        except GatewayError as error:
            if str(error).startswith("local Orthanc HTTP "):
                return None
            raise
        size = 0
        with response:
            for chunk in response.iter_content(chunk_size=65536):
                sink.write(chunk)
                size += len(chunk)
        return size

    def series_modalities(self, orthanc_id: str) -> set[str]:
        series = self.request("GET", f"/studies/{orthanc_id}/series").json()
        return {str((item.get("MainDicomTags") or {}).get("Modality", "")) for item in series} - {""}

    def put_modality(self, name: str, peer: dict[str, Any]) -> None:
        # A destination only: it is given no right to send to, query or retrieve from this Gateway (the receiving
        # devices stay the ones in orthanc.json).
        self.request("PUT", f"/modalities/{name}", json={
            "AET": peer["aet"], "Host": peer["host"], "Port": peer["port"], "AllowEcho": False, "AllowFind": False,
            "AllowGet": False, "AllowMove": False, "AllowStore": False, "AllowStorageCommitment": False,
            "AllowFindWorklist": False})

    def store(self, name: str, instance_ids: list[str], timeout: float) -> dict[str, Any]:
        """One synchronous C-STORE association from this Orthanc to a registered modality. Orthanc answers with counts."""
        try:
            response = self.request("POST", f"/modalities/{name}/store", timeout=timeout,
                                    json={"Resources": instance_ids, "Synchronous": True})
        except GatewayError as error:
            match = re.fullmatch(r"local Orthanc HTTP (\d+)", str(error))
            if match:
                raise ForwardError(f"forward C-STORE HTTP {match.group(1)}") from None
            raise
        try:
            answer = response.json()
        except ValueError:
            raise ForwardError("forward C-STORE answer invalid") from None
        if not isinstance(answer, dict):
            raise ForwardError("forward C-STORE answer invalid")
        return answer


class Cloud:
    def __init__(self, config: Config):
        self.base = kin_base_address(config.kin_base_url)
        self.token_url = self.base + "/auth/realms/kin/protocol/openid-connect/token"
        self.client_id = config.client_id
        self.client_secret = config.client_secret
        self.verify = config.tls_verify
        self.http_timeout = config.http_timeout
        self.stow_timeout = config.stow_timeout
        self.session = requests.Session()
        self.access_token = ""
        self.token_until = 0.0
        # The SOPs KIN named as stored (00081199) in the answer of the last successful STOW; empty before and on a refusal.
        self.last_stored: set[str] = set()
        # monotonic time of the last STOW KIN answered 2xx for; the heartbeat thread only reads it.
        self.last_stow_at: float | None = None
        if not self.verify:
            requests.packages.urllib3.disable_warnings(  # type: ignore[attr-defined]
                requests.packages.urllib3.exceptions.InsecureRequestWarning,  # type: ignore[attr-defined]
            )

    def token(self, force: bool = False) -> str:
        if not force and self.access_token and time.time() < self.token_until:
            return self.access_token
        try:
            response = self.session.post(self.token_url, data={
                "grant_type": "client_credentials",
                "client_id": self.client_id,
                "client_secret": self.client_secret,
            }, timeout=self.http_timeout, verify=self.verify)
        except requests.RequestException as error:
            raise GatewayError(f"token request {type(error).__name__}") from None
        if not response.ok:
            raise GatewayError(f"token request HTTP {response.status_code}")
        try:
            payload = response.json()
            self.access_token = str(payload["access_token"])
            expires_in = max(1, int(payload.get("expires_in", 60)))
        except (KeyError, TypeError, ValueError, requests.JSONDecodeError):
            raise GatewayError("token response invalid") from None
        self.token_until = time.time() + max(1, expires_in - 30)
        return self.access_token

    def request(self, method: str, path: str, *, timeout: float | None = None,
                before_send: Callable[[], None] | None = None, **kwargs: Any) -> requests.Response:
        base_headers = dict(kwargs.pop("headers", {}))
        body = kwargs.get("data")
        start = body.tell() if hasattr(body, "seek") else None
        for index in range(2):
            if start is not None:
                body.seek(start)
            headers = dict(base_headers)
            headers["Authorization"] = "Bearer " + self.token(force=index == 1)
            if before_send:
                before_send()  # A settings refresh can withdraw KIN while obtaining or renewing the token.
            try:
                response = self.session.request(
                    method, self.base + path, headers=headers,
                    timeout=timeout or self.http_timeout, verify=self.verify, **kwargs,
                )
            except requests.RequestException as error:
                raise GatewayError(f"cloud request {type(error).__name__}") from None
            if response.status_code != 401 or index == 1:
                return response
        raise GatewayError("cloud authentication failed")

    def announce(self, uid: str, institution_name: str, before_send: Callable[[], None] | None = None) -> None:
        response = self.request("POST", "/api/gateway/announce", before_send=before_send, json={
            "studyUid": uid,
            "institutionNameTag": institution_name,
        })
        if not response.ok:
            raise GatewayError(f"announce HTTP {response.status_code}")

    def receipt(self, body: dict[str, Any]) -> requests.Response:
        return self.request("POST", "/api/gateway/receipt", json=body)

    def retry_requests(self, epoch: str) -> requests.Response:
        # Only this queue's epoch goes out: KIN answers with this institution's UIDs for this epoch and nothing else.
        return self.request("GET", "/api/gateway/retry-requests", params={"epoch": epoch})

    def heartbeat(self, body: dict[str, Any]) -> requests.Response:
        return self.request("POST", "/api/gateway/heartbeat", json=body)

    def settings(self) -> requests.Response:
        return self.request("GET", "/api/gateway/settings")

    def stow(self, uid: str, body: bytes, content_type: str, source_ae: str,
             before_send: Callable[[], None] | None = None) -> set[str]:
        self.last_stored = set()
        response = self.request(
            "POST", f"/dicom-web/studies/{uid}", data=body, before_send=before_send,
            headers={"Content-Type": content_type, "Accept": "application/dicom+json",
                     "X-Kin-Source-AE": source_ae, "X-Kin-Gateway": self.client_id,
                     "X-Kin-Institution": self.client_id.removeprefix("gw-")},
            timeout=self.stow_timeout,
        )
        if not response.ok:
            raise GatewayError(f"STOW HTTP {response.status_code}")
        self.last_stow_at = time.monotonic()
        try:
            payload = response.json() if response.content else {}
        except requests.JSONDecodeError:
            raise GatewayError("STOW response invalid") from None
        failures = failed_sops(payload)
        self.last_stored = stored_sops(payload)
        return failures


def failed_sops(payload: Any) -> set[str]:
    if isinstance(payload, list):
        payload = payload[0] if payload else {}
    if not isinstance(payload, dict):
        raise GatewayError("STOW response shape invalid")
    sequence = payload.get("00081198", {}).get("Value", [])
    if not isinstance(sequence, list):
        raise GatewayError("STOW failure sequence invalid")
    failures = set()
    for item in sequence:
        values = item.get("00081155", {}).get("Value", []) if isinstance(item, dict) else []
        if values and isinstance(values[0], str):
            failures.add(values[0])
        else:
            raise GatewayError("STOW failure item missing SOPInstanceUID")
    return failures


def stored_sops(payload: Any) -> set[str]:
    """The SOPs a STOW answer names in its ReferencedSOPSequence (00081199). Never raises: an answer without a readable
    sequence names nothing. Receipt counts continue to use the separately reported failures."""
    if isinstance(payload, list):
        payload = payload[0] if payload else {}
    if not isinstance(payload, dict) or not isinstance(payload.get("00081199"), dict):
        return set()
    sequence = payload["00081199"].get("Value", [])
    stored = set()
    for item in sequence if isinstance(sequence, list) else []:
        element = item.get("00081155") if isinstance(item, dict) else None
        values = element.get("Value") if isinstance(element, dict) else None
        if isinstance(values, list) and values and isinstance(values[0], str):
            stored.add(values[0])
    return stored


def plan_batches(instances: list[dict[str, Any]], budget: int) -> list[list[dict[str, Any]]]:
    batches: list[list[dict[str, Any]]] = []
    current: list[dict[str, Any]] = []
    used = 128
    for item in instances:
        estimated = int(item["size"]) + 512
        if current and (used + estimated > budget or item.get("source_ae", "") != current[0].get("source_ae", "")):
            batches.append(current)
            current = []
            used = 128
        current.append(item)
        used += estimated
    if current:
        batches.append(current)
    return batches


def wants_lossless(settings: dict[str, Any], item: dict[str, Any]) -> bool:
    """The one compression rule: lossless is on and the stored pixel data is native (uncompressed)."""
    return settings.get("compression") == "lossless" and item.get("syntax", "") in NATIVE_SYNTAXES


@contextmanager
def multipart(instances, copy_file, copy_lossless=None):
    """Spool each STOW batch to disk; a large multiframe object stays one DICOM part.

    copy_lossless(item, sink) -> int | None writes the item losslessly re-compressed, or returns None having written
    nothing, and then the original bytes are copied and checked against the stored size as before.
    """
    boundary = "kin-gateway-" + uuid.uuid4().hex
    with tempfile.TemporaryFile() as body:
        for item in instances:
            body.write(f"--{boundary}\r\nContent-Type: application/dicom\r\n\r\n".encode("ascii"))
            size = copy_lossless(item, body) if copy_lossless is not None else None
            if size is None:
                size = copy_file(item["id"], body)
                if size != item["size"]:
                    raise GatewayError("local instance metadata incomplete")
            body.write(b"\r\n")
        body.write(f"--{boundary}--\r\n".encode("ascii"))
        size = body.tell()
        body.seek(0)
        yield body, f'multipart/related; type="application/dicom"; boundary={boundary}', size


def retry_request_uids(response: requests.Response) -> list[str] | None:
    """KIN's poll answer is exactly {"studyUids": [...]} with at most RETRY_POLL_LIMIT distinct UIDs; else None."""
    if not response.ok:
        return None
    try:
        payload = response.json()
    except Exception:
        return None
    if not isinstance(payload, dict) or set(payload) != {"studyUids"}:
        return None
    uids = payload["studyUids"]
    if not isinstance(uids, list) or len(uids) > RETRY_POLL_LIMIT:
        return None
    if not all(isinstance(uid, str) and RETRY_POLL_UID.fullmatch(uid) for uid in uids) or len(set(uids)) != len(uids):
        return None
    return uids


class Heartbeat:
    """Operational status for the admin console: tells KIN every HEARTBEAT_SECONDS (the first at once) that this Gateway runs.

    Own thread, own Cloud (requests.Session and token are not shared across threads), own read-only queue connection: it
    never writes the queue and never touches a study, so the main loop stays the single writer of its epoch. It never
    raises: a failed beat is logged and the next one tries again; transfers and receipts never wait for it. The body
    carries no time of this host (KIN stamps its own reception time and derives the start and last-STOW times from the
    elapsed seconds), no UID, no institution and no free text.
    """

    def __init__(self, config: Config, epoch: str, orthanc: "Orthanc", stow: "Cloud", started: float,
                 settings: "SettingsStore | None" = None):
        self.config = config
        # The Gateway settings are read on this thread too (every SETTINGS_EVERY beats, the first right after the first
        # beat), so the main loop's timing never waits for them. A failed read keeps the last good settings.
        self.settings = settings
        self.beats = 0
        self.epoch = epoch
        # In memory only: one random id per run, and a number per new status body (1, 2, ...; a failed beat does not give
        # its number back; the authentication retry of one body sends the same id and number). KIN keeps an older body of
        # the run its row holds from covering a newer one; it does not order different runs.
        self.boot_id = str(uuid.uuid4())
        self.seq = 0
        self.stored_once = False   # KIN stored one beat of this run (part of the launcher's ready condition)
        self.orthanc = orthanc   # .observed is read, nothing else
        self.stow = stow         # .last_stow_at is read, nothing else
        self.cloud = Cloud(config)
        self.started = started
        self.stopped = threading.Event()
        self.thread: threading.Thread | None = None

    def body(self) -> dict[str, Any]:
        self.seq += 1
        now = time.monotonic()
        last = self.stow.last_stow_at
        observed = self.orthanc.observed
        try:
            queue: dict[str, int] | None = queue_counts(self.config.queue_db)
        except Exception as error:
            log("heartbeat.queue_unreadable", error=type(error).__name__)
            queue = None   # KIN shows the queue as unreadable, never as zero; the beat itself still goes out
        return {
            "epoch": self.epoch,
            "bootId": self.boot_id,
            "seq": self.seq,
            "version": run_version(),
            "uptimeSeconds": max(0, int(now - self.started)),
            "queue": queue,
            "lastStowAgeSeconds": None if last is None else max(0, int(now - last)),
            "localOrthanc": None if observed is None
            else {"answered": bool(observed[0]), "ageSeconds": max(0, int(now - observed[1]))},
        }

    def beat(self) -> bool:
        try:
            response = self.cloud.heartbeat(self.body())
            if response.ok:
                if not self.stored_once:
                    try:
                        answer = response.json()
                    except Exception:
                        answer = None
                    # KIN answers 200 for a stale body too; only "stored" shows KIN took this run's status.
                    self.stored_once = isinstance(answer, dict) and answer.get("result") == "stored"
                return True
            log("heartbeat.deferred", status=response.status_code)
        except Exception as error:
            log("heartbeat.deferred", error=error_code(error))
        return False

    def refresh_settings(self) -> bool:
        """Read the Gateway settings once. Never raises; True when a good answer was taken."""
        if self.settings is None:
            return False
        try:
            response = self.cloud.settings()
            if not response.ok:
                log("settings.deferred", status=response.status_code)
                return False
            if self.settings.accept(response.json()):
                return True
            log("settings.invalid", status=response.status_code)
        except Exception as error:
            log("settings.deferred", error=error_code(error))
        return False

    def run(self) -> None:
        while not self.stopped.is_set():
            self.beat()
            if self.beats % SETTINGS_EVERY == 0:
                self.refresh_settings()
            self.beats += 1
            self.stopped.wait(HEARTBEAT_SECONDS)

    def start(self) -> None:
        self.thread = threading.Thread(target=self.run, name="heartbeat", daemon=True)
        self.thread.start()

    def stop(self, wait: float = 5.0) -> None:
        """No new beat starts; a beat in flight gets a short while to end so the queue file is not held after stop."""
        self.stopped.set()
        if self.thread is not None and self.thread is not threading.current_thread():
            self.thread.join(wait)


def queue_diagnostics(path: str, limit: int = DIAGNOSTICS_ROWS_MAX) -> dict[str, Any]:
    """The queue as the diagnostics report carries it, on a read-only connection of its own (the main loop stays the
    only writer). Counts for every phase; rows (newest first, at most `limit`) only for studies whose destinations are
    decided and include KIN, with an error code and never the free reason. Other studies are only counted."""
    db = sqlite3.connect(Path(path).resolve().as_uri() + "?mode=ro", uri=True, timeout=5)
    db.row_factory = sqlite3.Row
    try:
        counts = {str(row["phase"]): int(row["n"]) for row in db.execute(
            "SELECT phase, count(*) AS n FROM studies GROUP BY phase")}
        forwards: dict[str, list[dict[str, Any]]] = {}
        for row in db.execute("SELECT uid, dest, phase, attempt, last_error FROM forwards ORDER BY uid, dest"):
            forwards.setdefault(str(row["uid"]), []).append({
                "destination": str(row["dest"]) if _SETTINGS_ID.fullmatch(str(row["dest"])) else "other",
                "phase": str(row["phase"]), "attempt": int(row["attempt"]),
                "errorCode": None if row["last_error"] is None else error_code_of_text(str(row["last_error"])),
            })
        rows, omitted = [], 0
        for row in db.execute("SELECT uid, phase, attempt, error_code, last_error, destinations FROM studies "
                              "ORDER BY updated_at DESC, uid"):
            try:
                destinations = json.loads(row["destinations"]) if row["destinations"] else None
            except ValueError:
                destinations = None
            uid = str(row["uid"])
            if (not isinstance(destinations, list) or KIN_DESTINATION not in destinations
                    or str(row["phase"]) == "not_routed" or not RETRY_POLL_UID.fullmatch(uid) or len(uid) > 64
                    or len(rows) >= limit):
                omitted += 1
                continue
            code = row["error_code"] if row["error_code"] in ERROR_CODE_VALUES else (
                None if row["last_error"] is None else error_code_of_text(str(row["last_error"])))
            rows.append({"uid": uid, "phase": str(row["phase"]), "attempt": int(row["attempt"]), "errorCode": code,
                         "destinations": [d if d == KIN_DESTINATION or _SETTINGS_ID.fullmatch(str(d)) else "other"
                                          for d in destinations][:SETTINGS_DESTINATIONS_MAX + 1],
                         "forwards": forwards.get(uid, [])[:SETTINGS_DESTINATIONS_MAX]})
    finally:
        db.close()
    return {"counts": counts, "total": sum(counts.values()), "rows": rows, "omitted": omitted}


def _launcher_view(path: str | None) -> dict[str, Any] | None:
    """What the launcher's state says, reduced to versions and codes (the launcher is its only writer)."""
    if not path:
        return None
    try:
        state = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    if not isinstance(state, dict):
        return None

    def name(value: Any) -> str | None:
        return value if value == "builtin" or (isinstance(value, str) and len(value) <= 32
                                               and RUN_VERSION.fullmatch(value)) else None

    def code(value: Any) -> str | None:
        return value if isinstance(value, str) and SUPPORT_CODE.fullmatch(value) else None

    last = state.get("last") if isinstance(state.get("last"), dict) else None
    return {"current": name(state.get("current")), "previous": name(state.get("previous")),
            "running": name(state.get("running")), "installing": bool(state.get("pending")),
            "last": None if last is None else {"version": name(last.get("version")), "result": code(last.get("result")),
                                               "code": code(last.get("code"))}}


class Support:
    """Remote support over this agent's own outbound HTTPS — no port opens toward the hospital.

    Own thread, own Cloud and read-only queue reads, so the heartbeat and the settings never wait for a download or a
    report. Each SUPPORT_SECONDS it (1) reports every final outcome KIN has not acknowledged yet — a restart this run
    replaced, and the launcher's install results — and (2) asks KIN for at most one request for this queue. The trust
    decision for an update is the launcher's alone: the agent only downloads the bundle KIN holds and hands it over
    complete. A request already carried out is never carried out again when KIN delivers it twice (support.json beside
    the queue, bound to this credential and queue epoch); a diagnostics report may be sent again (it changes nothing).
    """

    def __init__(self, config: Config, epoch: str, owner: dict[str, str], heartbeat: "Heartbeat",
                 settings: "SettingsStore", orthanc: "Orthanc", stow: "Cloud", started: float,
                 stop_agent: Callable[[int], None]):
        self.config = config
        self.epoch = epoch
        self.owner = owner
        self.heartbeat = heartbeat
        self.settings = settings
        self.orthanc = orthanc
        self.stow = stow
        self.started = started
        self.stop_agent = stop_agent
        self.enabled = truthy(os.environ.get("GW_REMOTE_SUPPORT", "on"))
        self.update_root = os.environ.get("KIN_UPDATE_ROOT") or None
        self.update_state = os.environ.get("KIN_AGENT_UPDATE_STATE") or None
        self.memo_path = Path(config.queue_db).with_name("support.json")
        self.memo = self.load_memo()
        self.cloud = Cloud(config)
        self.stopped = threading.Event()
        self.thread: threading.Thread | None = None

    # the memo: what this Gateway already did and which outcomes KIN acknowledged
    def load_memo(self) -> dict[str, Any]:
        fresh = {**self.owner, "epoch": self.epoch, "handled": [], "reported": [], "restart": None}
        try:
            memo = json.loads(self.memo_path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return fresh
        if not isinstance(memo, dict) or any(memo.get(k) != v for k, v in {**self.owner, "epoch": self.epoch}.items()):
            return fresh
        for key in ("handled", "reported"):
            fresh[key] = [i for i in memo.get(key) or [] if isinstance(i, str)][-64:]
        restart = memo.get("restart")
        if isinstance(restart, dict) and isinstance(restart.get("requestId"), str) and isinstance(restart.get("bootId"), str):
            fresh["restart"] = {"requestId": restart["requestId"], "bootId": restart["bootId"]}
        return fresh

    def save_memo(self) -> None:
        for key in ("handled", "reported"):
            self.memo[key] = self.memo[key][-64:]
        temporary = self.memo_path.with_name(self.memo_path.name + ".tmp")
        temporary.write_text(json.dumps(self.memo, separators=(",", ":")), encoding="utf-8")
        os.replace(temporary, self.memo_path)

    # KIN
    def post(self, request_id: str, result: str, code: str | None = None, version: str | None = None,
             diagnostics: dict[str, Any] | None = None) -> bool:
        """Send one result. True when KIN gave its final answer for it (stored, the same again, unknown or conflict)."""
        try:
            response = self.cloud.request("POST", f"/api/gateway/support/{request_id}", json={
                "epoch": self.epoch, "bootId": self.heartbeat.boot_id, "result": result, "code": code,
                "version": version, "diagnostics": diagnostics})
        except Exception as error:
            log("support.deferred", error=error_code(error))
            return False
        if response.ok or response.status_code in (404, 409):
            return True
        log("support.deferred", status=response.status_code)
        return False

    def outcomes(self) -> list[tuple[str, dict[str, Any]]]:
        owed: list[tuple[str, dict[str, Any]]] = []
        restart = self.memo["restart"]
        if restart and restart["bootId"] != self.heartbeat.boot_id:
            owed.append((restart["requestId"], {"result": "done"}))
        try:
            state = json.loads(Path(self.update_state).read_text(encoding="utf-8")) if self.update_state else {}
        except (OSError, ValueError):
            state = {}
        for item in (state.get("results") if isinstance(state, dict) else None) or []:
            if not isinstance(item, dict):
                continue
            request_id = item.get("requestId")
            if (isinstance(request_id, str) and _SETTINGS_ID.fullmatch(request_id) and request_id not in self.memo["reported"]
                    and item.get("result") in ("installed", "rolled_back", "refused")):
                code = item.get("code") if isinstance(item.get("code"), str) and SUPPORT_CODE.fullmatch(item["code"]) else None
                version = item.get("version") if isinstance(item.get("version"), str) and RUN_VERSION.fullmatch(item["version"]) else None
                owed.append((request_id, {"result": item["result"], "code": code, "version": version}))
        return owed

    def report_outcomes(self) -> None:
        for request_id, body in self.outcomes():
            if not self.post(request_id, body["result"], body.get("code"), body.get("version")):
                return
            self.memo["reported"].append(request_id)
            if self.memo["restart"] and self.memo["restart"]["requestId"] == request_id:
                self.memo["restart"] = None
            self.save_memo()

    def fetch(self) -> dict[str, Any] | None:
        try:
            response = self.cloud.request("GET", "/api/gateway/support", params={"epoch": self.epoch})
        except Exception as error:
            log("support.deferred", error=error_code(error))
            return None
        if not response.ok:
            if response.status_code != 404:   # a KIN without remote support answers 404; nothing else changes
                log("support.deferred", status=response.status_code)
            return None
        try:
            request = response.json().get("request")
        except Exception:
            return None
        if request is None:
            return None
        if (not _closed(request, {"id", "action", "version"}) or not isinstance(request["id"], str)
                or not _SETTINGS_ID.fullmatch(request["id"]) or request["action"] not in SUPPORT_ACTIONS
                or (request["action"] == "update") != isinstance(request["version"], str)
                or (request["version"] is not None and not (len(request["version"]) <= 32
                                                             and RUN_VERSION.fullmatch(request["version"])))):
            log("support.invalid")
            return None
        return request

    # actions
    def diagnostics(self) -> dict[str, Any]:
        now = time.monotonic()
        observed = self.orthanc.observed
        last = self.stow.last_stow_at
        try:
            free = shutil.disk_usage(Path(self.config.queue_db).resolve().parent).free
        except OSError:
            free = None
        try:
            queue: dict[str, Any] | None = queue_diagnostics(self.config.queue_db)
        except Exception as error:
            log("support.queue_unreadable", error=type(error).__name__)
            queue = None
        settings = self.settings.current if self.settings.known else None
        report = {
            "format": 1, "version": run_version(), "uptimeSeconds": max(0, int(now - self.started)),
            "launcher": _launcher_view(self.update_state),
            "config": {"kinBaseUrl": self.cloud.base, "clientId": self.config.client_id,
                       "tlsVerify": self.config.tls_verify, "byteBudget": self.config.byte_budget,
                       "pollSeconds": self.config.poll_seconds, "httpTimeoutSeconds": self.config.http_timeout,
                       "stowTimeoutSeconds": self.config.stow_timeout, "backoffBaseSeconds": self.config.backoff_base,
                       "backoffMaxSeconds": self.config.backoff_max, "remoteSupport": self.enabled},
            "settings": {"known": self.settings.known, "revision": settings["revision"] if settings else None,
                         "routes": len(settings["routes"]) if settings else None,
                         "compression": settings["compression"] if settings else None},
            "localOrthanc": None if observed is None
            else {"answered": bool(observed[0]), "ageSeconds": max(0, int(now - observed[1]))},
            "lastStowAgeSeconds": None if last is None else max(0, int(now - last)),
            "dataFreeBytes": free,
            "queue": queue,
            "log": list(LOG_RING),
        }
        # Fit the report: fewer queue rows first, then fewer log lines; the counts always stay whole.
        while len(json.dumps(report, separators=(",", ":"))) > DIAGNOSTICS_MAX_BYTES:
            if queue and queue["rows"]:
                cut = max(1, len(queue["rows"]) // 2)
                queue["omitted"] += cut
                queue["rows"] = queue["rows"][:-cut]
            elif report["log"]:
                report["log"] = report["log"][len(report["log"]) // 2 + 1:]
            else:
                break
        return report

    def download(self, version: str) -> bytes:
        """The bundle KIN holds for `version`, at most UPDATE_DOWNLOAD_MAX_BYTES. Raises SupportRefused(code)."""
        try:
            response = self.cloud.request("GET", f"/api/gateway/update/{version}", stream=True,
                                          timeout=self.config.stow_timeout)
        except Exception:
            raise SupportRefused("download_failed") from None
        try:
            if not response.ok:
                raise SupportRefused("download_failed")
            chunks, size = [], 0
            for chunk in response.iter_content(64 * 1024):
                size += len(chunk)
                if size > UPDATE_DOWNLOAD_MAX_BYTES:
                    raise SupportRefused("too_large")
                chunks.append(chunk)
            return b"".join(chunks)
        except SupportRefused:
            raise
        except Exception:
            raise SupportRefused("download_failed") from None
        finally:
            response.close()

    def hand_over(self, request: dict[str, Any], raw: bytes) -> None:
        """Publish the complete bundle with its request id and version to the launcher as one unit (one rename)."""
        incoming = Path(self.update_root) / "incoming"
        incoming.mkdir(parents=True, exist_ok=True)
        staging = incoming / f".tmp-{uuid.uuid4().hex}"
        staging.mkdir()
        (staging / "bundle.json").write_bytes(raw)
        (staging / "request.json").write_text(json.dumps({"requestId": request["id"], "version": request["version"]}),
                                              encoding="utf-8")
        os.replace(staging, incoming / f"{time.time_ns():020d}-{request['id'][:8]}")

    def carry_out(self, request: dict[str, Any]) -> None:
        request_id, action = request["id"], request["action"]
        if not self.enabled:
            self.post(request_id, "refused", "remote_support_off", request["version"])
            return
        if action == "diagnostics":
            self.post(request_id, "done", diagnostics=self.diagnostics())
            return
        if request_id in self.memo["handled"]:
            # Delivered again (an answer was lost): the action already happened once; say so, never repeat it.
            self.post(request_id, "accepted", version=request["version"])
            return
        if action == "restart":
            self.memo["restart"] = {"requestId": request_id, "bootId": self.heartbeat.boot_id}
            self.memo["handled"].append(request_id)
            self.save_memo()
            self.post(request_id, "accepted")
            log("support.restart")
            self.stop_agent(RESTART_EXIT)
            return
        if not self.update_root:
            self.post(request_id, "refused", "no_launcher", request["version"])
            return
        try:
            raw = self.download(request["version"])
        except SupportRefused as error:
            self.post(request_id, "refused", str(error), request["version"])
            return
        try:
            self.hand_over(request, raw)
        except OSError:
            self.post(request_id, "refused", "store_failed", request["version"])
            return
        self.memo["handled"].append(request_id)
        self.save_memo()
        self.post(request_id, "accepted", version=request["version"])
        log("support.update_handed_over")

    def tick(self) -> None:
        try:
            self.report_outcomes()
            request = self.fetch()
            if request is not None:
                self.carry_out(request)
        except Exception as error:   # never stops the agent
            log("support.deferred", error=type(error).__name__)

    def run(self) -> None:
        while not self.stopped.is_set():
            self.tick()
            self.stopped.wait(SUPPORT_SECONDS)

    def start(self) -> None:
        self.thread = threading.Thread(target=self.run, name="support", daemon=True)
        self.thread.start()

    def stop(self, wait: float = 5.0) -> None:
        self.stopped.set()
        if self.thread is not None and self.thread is not threading.current_thread():
            self.thread.join(wait)


class StudyRouting:
    """Match current rules against this delivery's study facts, including settings received between batches."""

    def __init__(self, settings: SettingsStore, orthanc: Orthanc, orthanc_id: str, instances: list[dict[str, Any]]):
        self.settings = settings
        self.orthanc = orthanc
        self.orthanc_id = orthanc_id
        self.source_aes = {item.get("source_ae", "") for item in instances} - {""}
        self.modalities: set[str] | None = None

    def current(self) -> tuple[dict[str, Any], list[str]]:
        settings = self.settings.current
        if self.modalities is None and settings["routes"]:
            self.modalities = self.orthanc.series_modalities(self.orthanc_id)
            settings = self.settings.current
        return settings, route_for(settings["routes"], self.modalities or set(), self.source_aes)

    def require_kin(self) -> None:
        if KIN_DESTINATION not in self.current()[1]:
            raise GatewayError("KIN destination no longer allowed")

    def require_peer(self, dest: str, peer: Any) -> None:
        settings, allowed = self.current()
        if dest not in allowed or peer is None or settings["peers"].get(dest) != peer:
            raise ForwardError("forward destination unknown")


class Agent:
    def __init__(self, config: Config):
        self.config = config
        self.queue = Queue(config.queue_db)
        self.orthanc = Orthanc(config)
        self.cloud = Cloud(config)
        self.stopping = False
        self.receipt_failures = 0
        self.receipts_resume_at = 0.0
        # The first Now Retry poll is one full period after start, so a restart never polls sooner than a running agent.
        self.retry_poll_at = time.monotonic() + RETRY_POLL_SECONDS
        owner = {"client": config.client_id, "base": self.cloud.base}
        self.owner = owner
        self.settings = SettingsStore(config.queue_db, owner)
        self.identity_error = self.queue.check_owner(owner, self.settings.identity_error)
        self.exit_code = 0
        # The launcher's ready file for this start (update.py); written once, never by an earlier run.
        self.ready_file = os.environ.get("KIN_AGENT_READY_FILE") or None
        self.heartbeat: Heartbeat | None = None

    def stop(self, *_args: Any) -> None:
        self.stopping = True

    def stop_for(self, code: int) -> None:
        """Remote restart: end after the pass in progress and leave with `code` for the launcher."""
        self.exit_code = code
        self.stopping = True

    def mark_ready(self) -> None:
        """Called after a main-loop pass that ended without an outer error: with one stored heartbeat, this run is good."""
        if self.ready_file and self.heartbeat is not None and self.heartbeat.stored_once:
            try:
                Path(self.ready_file).write_text(json.dumps({"version": run_version()}), encoding="utf-8")
                log("agent.ready", version=run_version())
                self.ready_file = None
            except OSError as error:
                log("agent.ready_deferred", error=type(error).__name__)

    def report(self, uid: str) -> bool:
        """Send this study's current receipt. Never raises: a receipt must not change the transfer.

        True when KIN gave its final answer for this body (stored, replayed, stale or refused), False
        when the answer is still owed and a later pass should try again.
        """
        try:
            body = self.queue.receipt(uid)
            if body is None:
                return True
            response = self.cloud.receipt(body)
            if response.ok or response.status_code in RECEIPT_FINAL_REFUSALS:
                self.queue.reported(uid, body["seq"])
                if not response.ok:
                    try:
                        code = response.json().get("code")
                    except Exception:
                        code = None
                    log("receipt.refused", uid=uid, status=response.status_code,
                        code=code if code in RECEIPT_REFUSAL_CODES else None)
                return True
            log("receipt.deferred", uid=uid, status=response.status_code)
        except Exception as error:
            log("receipt.deferred", uid=uid, error=error_code(error))
        return False

    def flush_receipts(self) -> None:
        """Deliver receipts still owed (last state before a restart or an outage), backing off on failure."""
        if time.monotonic() < self.receipts_resume_at:
            return
        try:
            owed = self.queue.unreported()
        except Exception as error:
            log("receipt.deferred", error=error_code(error))
            return
        for uid in owed:
            if not self.report(uid):
                self.receipt_failures += 1
                delay = min(self.config.backoff_max,
                            self.config.backoff_base * (2 ** min(self.receipt_failures - 1, 16)))
                self.receipts_resume_at = time.monotonic() + delay
                return
        self.receipt_failures = 0

    def retry_requests(self) -> None:
        """S4-U4: apply KIN's pending Now Retry requests for this epoch. Never raises.

        At most once per RETRY_POLL_SECONDS; a failed poll just waits for the next tick. KIN answers UIDs only,
        so before touching a row the agent re-sends that row's current receipt through the unchanged U3 route.
        Only `duplicate` shows KIN holds exactly this (epoch, seq, body), i.e. the delivered request was bound to
        the retry state about to change; then one compare-and-set moves next_at and nothing else.

        Single-writer assumption: that inference holds only while this process is the only writer of its epoch
        and nothing writes the confirmed row between the poll and the compare-and-set. The loop is single-threaded
        and this method uses only receipt/waiting/reported/retry_now of the queue (reported writes reported_seq
        only). Two hosts running copies of one queue.db share an epoch and could both confirm one state; that is
        the H-1 family and outside S4-U4. No exactly-once delivery is claimed: the effect is at most one next_at
        change per request, and the next receipt (announcing, seq+1) is what ends the request at KIN.
        """
        now = time.monotonic()
        if now < self.retry_poll_at:
            return
        self.retry_poll_at = now + RETRY_POLL_SECONDS
        # The confirmations go to the receipt endpoint, so its backoff after owed receipts failed holds here too.
        if now < self.receipts_resume_at:
            return
        try:
            response = self.cloud.retry_requests(self.queue.epoch)
            uids = retry_request_uids(response)
        except Exception as error:
            log("retry_request.deferred", error=error_code(error))
            return
        if uids is None:
            log("retry_request.invalid", status=response.status_code)
            return
        for uid in uids:
            try:
                at = time.time()   # the wall clock retry() and due() already use for next_at
                body = self.queue.receipt(uid)
                if body is None or body["phase"] != "retry" or not self.queue.waiting(uid, body["seq"], at):
                    continue      # unknown, already eligible or moved on: no POST and no row
                confirm = self.cloud.receipt(body)
                if confirm.ok or confirm.status_code in RECEIPT_FINAL_REFUSALS:
                    self.queue.reported(uid, body["seq"])   # the same bookkeeping as report()
                try:
                    answer = confirm.json() if confirm.ok else None
                except Exception:
                    answer = None
                if answer != {"studyUid": uid, "result": "duplicate"}:
                    log("retry_request.unconfirmed", uid=uid, status=confirm.status_code)
                    continue
                if self.queue.retry_now(uid, body["seq"], at):
                    log("study.retry_now", uid=uid, attempt=body["attempt"])
            except Exception as error:
                log("retry_request.deferred", uid=uid, error=error_code(error))

    def poll_changes(self) -> None:
        while not self.stopping:
            since = self.queue.changes_since()
            payload = self.orthanc.changes(since)
            changes = payload.get("Changes", [])
            stable: list[tuple[str, str]] = []
            for change in changes:
                if change.get("ChangeType") != "StableStudy":
                    continue
                orthanc_id = str(change.get("ID", ""))
                if not orthanc_id:
                    raise GatewayError("StableStudy missing Orthanc ID")
                try:
                    detail = self.orthanc.request("GET", f"/studies/{orthanc_id}").json()
                except GatewayError as error:
                    # A study can disappear between the change event and the lookup.
                    if str(error) != "local Orthanc HTTP 404":
                        raise
                    log("study.gone")
                    continue
                uid = str((detail.get("MainDicomTags") or {}).get("StudyInstanceUID", ""))
                if not uid:
                    raise GatewayError("StableStudy missing StudyInstanceUID")
                stable.append((uid, orthanc_id))
            last = int(payload.get("Last", since))
            self.queue.record_changes(stable, last)
            for uid, _orthanc_id in stable:
                log("study.queued", uid=uid)
            if payload.get("Done", True):
                return

    def decide(self, row: sqlite3.Row, routing: StudyRouting) -> list[str]:
        uid = str(row["uid"])
        decided = self.queue.destinations(uid)
        if decided is None:
            settings, allowed = routing.current()
            decided = [KIN_DESTINATION] if row["announced"] or self.queue.successes(uid) else allowed
            self.queue.set_destinations(uid, decided, settings["peers"])
            if settings["routes"]:
                log("study.routed", uid=uid, destinations=len(decided))
        return decided

    def process(self, row: sqlite3.Row) -> None:
        uid = str(row["uid"])
        self.queue.phase(uid, "announcing")
        orthanc_id, detail, instances = self.orthanc.instances(uid, str(row["orthanc_id"]))
        routing = StudyRouting(self.settings, self.orthanc, orthanc_id, instances)
        if KIN_DESTINATION not in self.decide(row, routing):
            self.queue.not_routed(uid)
            return
        routing.require_kin()
        institution_name = str((detail.get("MainDicomTags") or {}).get("InstitutionName", ""))
        self.cloud.announce(uid, institution_name, routing.require_kin)

        local_sops = {item["sop"] for item in instances}
        successful = self.queue.successes(uid)
        # M counts only SOPs this Gateway still holds, so 0 <= M <= N holds in every receipt.
        self.queue.announced(uid, len(local_sops), len(successful & local_sops))
        self.report(uid)
        pending = [item for item in instances if item["sop"] not in successful]
        batches = plan_batches(pending, self.config.byte_budget)
        settings = self.settings.current
        lossless, compressed = None, [0]
        if settings["compression"] == "lossless":
            def lossless(item, sink):
                size = self.orthanc.copy_lossless(item["id"], sink) if wants_lossless(settings, item) else None
                compressed[0] += size is not None
                return size
        for batch_index, batch in enumerate(batches, int(row["batch_index"]) + 1):
            self.queue.phase(uid, "sending", batch_index)
            with multipart(batch, self.orthanc.copy_file, lossless) as (body, content_type, body_size):
                failures = self.cloud.stow(uid, body, content_type, batch[0].get("source_ae", ""), routing.require_kin)
            batch_sops = {item["sop"] for item in batch}
            unknown = failures - batch_sops
            if unknown:
                raise GatewayError("STOW response named an unknown failed SOP")
            self.queue.add_successes(uid, batch_sops - failures, batch_index)
            self.queue.counts(uid, len(local_sops), len(self.queue.successes(uid) & local_sops))
            if lossless is None:
                log(
                    "batch.stored", uid=uid, batch=batch_index, sops=len(batch),
                    failed=len(failures), bytes=body_size,
                )
            else:
                # With compression on, the line also says how many parts went re-compressed (the rest went as stored).
                log("batch.stored", uid=uid, batch=batch_index, sops=len(batch), failed=len(failures), bytes=body_size,
                    compressed=compressed[0])
                compressed[0] = 0
            if failures:
                raise GatewayError(f"STOW failed SOP count={len(failures)}")
            self.report(uid)

        # 전송 중 새 인스턴스가 도착했을 수 있다. 개수가 아니라 양쪽 SOP 집합이 같아야 끝난다.
        _orthanc_id, _detail, latest = self.orthanc.instances(uid, orthanc_id)
        latest_sops = {item["sop"] for item in latest}
        successful = self.queue.successes(uid)
        missing = latest_sops - successful
        extra = successful - latest_sops
        if extra:
            raise GatewayError(f"successful SOP absent locally count={len(extra)}")
        if missing:
            self.queue.pending_now(uid, len(latest_sops), len(successful & latest_sops))
            log("study.delta", uid=uid, pending=len(missing))
            return
        self.queue.complete(uid, len(successful))
        log("study.complete", uid=uid, sops=len(successful))

    def process_forward(self, row: sqlite3.Row) -> None:
        """Send one study to one destination other than KIN (a DICOM Peer) with this Gateway's Orthanc (C-STORE).

        Only this row's own SOP set grows, and only from Orthanc's answer for this association: what KIN or another
        destination received is never read here. Done when every SOP held locally now is in this destination's set.
        """
        uid, dest = str(row["uid"]), str(row["dest"])
        if dest not in (self.queue.destinations(uid) or []):
            raise ForwardError("forward destination unknown")
        try:
            peer = json.loads(row["peer"])
        except (TypeError, ValueError):
            raise ForwardError("forward destination unknown") from None
        orthanc_id, _detail, instances = self.orthanc.instances(uid, self.queue.orthanc_id(uid))
        routing = StudyRouting(self.settings, self.orthanc, orthanc_id, instances)
        routing.require_peer(dest, peer)
        self.queue.forward_phase(uid, dest, "sending")
        modality = "kin-route-" + dest
        self.orthanc.put_modality(modality, peer)
        done = self.queue.forward_successes(uid, dest)
        pending = [item for item in instances if item["sop"] not in done]
        for index, batch in enumerate(plan_batches(pending, self.config.byte_budget), 1):
            routing.require_peer(dest, peer)
            answer = self.orthanc.store(modality, [item["id"] for item in batch], self.config.stow_timeout)
            failed, count = answer.get("FailedInstancesCount"), answer.get("InstancesCount")
            if not isinstance(failed, int) or not isinstance(count, int):
                raise ForwardError("forward C-STORE answer invalid")
            if failed or count != len(batch):
                raise ForwardError(f"forward C-STORE failed count={max(failed, len(batch) - count)}")
            self.queue.forward_add(uid, dest, {item["sop"] for item in batch})
            log("forward.stored", uid=uid, batch=index, sops=len(batch))
        _orthanc_id, _detail, latest = self.orthanc.instances(uid, orthanc_id)
        missing = {item["sop"] for item in latest} - self.queue.forward_successes(uid, dest)
        if missing:
            self.queue.forward_phase(uid, dest, "pending")
            log("forward.delta", uid=uid, pending=len(missing))
            return
        self.queue.forward_phase(uid, dest, "complete")
        log("forward.complete", uid=uid, sops=len(self.queue.forward_successes(uid, dest)))

    def run(self) -> int:
        """Run until stopped. The exit code is 0, or RESTART_EXIT when a remote restart asked for a new start."""
        signal.signal(signal.SIGTERM, self.stop)
        signal.signal(signal.SIGINT, self.stop)
        if self.identity_error:
            log("agent.identity_blocked", error=self.identity_error)
            # Stay available to status until the operator restarts with matching files and configuration.
            while not self.stopping:
                time.sleep(1)
            self.queue.close()
            return self.exit_code
        log("agent.started", byteBudget=self.config.byte_budget, version=run_version())
        started = time.monotonic()
        heartbeat = Heartbeat(self.config, self.queue.epoch, self.orthanc, self.cloud, started, self.settings)
        self.heartbeat = heartbeat
        support = Support(self.config, self.queue.epoch, self.owner, heartbeat, self.settings, self.orthanc, self.cloud,
                          started, self.stop_for)
        heartbeat.start()
        support.start()
        try:
            self.loop()
        finally:
            support.stop()
            heartbeat.stop()
        self.queue.close()
        log("agent.stopped", code=self.exit_code)
        return self.exit_code

    def loop(self) -> None:
        while not self.stopping:
            # Final states (complete/pending/retry/failed) and anything an outage held back go out here.
            self.flush_receipts()
            # After the flush, so a confirmation compares KIN with a receipt it already had the chance to store;
            # before due(), so a row made eligible now is taken in this same pass.
            self.retry_requests()
            try:
                self.poll_changes()
                # Until the settings are known once, nothing is sent: an unknown rule is not "no rule" (SettingsStore).
                row = self.queue.due() if self.settings.known else None
                # A KIN failure must still leave the other destinations their turn.
                again = False
                if row:
                    uid = str(row["uid"])
                    try:
                        self.process(row)
                    except PermanentGatewayError as error:
                        reason = str(error)
                        self.queue.fail(uid, reason, error_code(error))
                        log("study.failed", uid=uid, error=reason)
                        again = True
                    except Exception as error:
                        reason = str(error) if isinstance(error, GatewayError) else type(error).__name__
                        attempt, delay = self.queue.retry(
                            uid, reason, self.config.backoff_base, self.config.backoff_max, error_code(error),
                        )
                        log("study.retry", uid=uid, attempt=attempt, afterSeconds=round(delay, 2), error=reason)
                        again = True
                # A destination other than KIN goes after the KIN row of this pass, with its own backoff: one that
                # is down never holds KIN or another destination back.
                forward = self.queue.forward_due() if self.settings.known else None
                if forward:
                    uid = str(forward["uid"])
                    try:
                        self.process_forward(forward)
                    except Exception as error:
                        reason = str(error) if isinstance(error, (GatewayError, ForwardError)) else type(error).__name__
                        attempt, delay = self.queue.forward_retry(
                            uid, str(forward["dest"]), reason, self.config.backoff_base, self.config.backoff_max,
                        )
                        log("forward.retry", uid=uid, attempt=attempt, afterSeconds=round(delay, 2), error=reason)
                self.mark_ready()
                if again:
                    continue
            except Exception as error:
                reason = str(error) if isinstance(error, GatewayError) else type(error).__name__
                log("agent.retry", error=reason)
            time.sleep(self.config.poll_seconds)


def status(path: str) -> int:
    queue = Queue(path)
    try:
        print(json.dumps(queue.summary(), separators=(",", ":")))
        return 0
    finally:
        queue.close()


def main() -> int:
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("run")
    show = sub.add_parser("status")
    show.add_argument("--db", default=os.environ.get("QUEUE_DB", "/data/queue.db"))
    args = parser.parse_args()
    if args.command == "status":
        return status(args.db)
    return Agent(Config.from_env()).run()


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except GatewayError as error:
        log("agent.fatal", error=str(error))
        raise SystemExit(2)
