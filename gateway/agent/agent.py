"""KIN Gateway upload agent.

Only UIDs and counts are logged. Patient demographics travel in DICOM bytes but are never
written to the queue or logs.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import signal
import sqlite3
import time
import math
import tempfile
import threading
from contextlib import contextmanager
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable

import requests


MANAGED_PHASES = ("pending", "announcing", "sending", "retry", "failed", "complete")
# A receipt carries an errorCode exactly in these phases and null in every other one.
ERROR_PHASES = ("retry", "failed")


class GatewayError(RuntimeError):
    """An error safe to persist and print (it must not contain response bodies)."""


class PermanentGatewayError(GatewayError):
    """A study cannot succeed by retrying the same bytes and needs operator action."""


# S4-U3: the receipt's errorCode. The free reason stays in the local queue and log; it never goes to
# KIN, because no string blacklist can prove a message is free of patient data. Keys are the message
# templates of every GatewayError constructed in this file ({} marks an f-string field, which never
# holds a space). test_agent.py enumerates the constructors by AST and fails on a template missing here.
GATEWAY_ERROR_CODES = {
    "missing environment: {}": "configuration",
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
    # Routing to another destination (a DICOM Peer of the institution). These never reach a KIN receipt: a forward row
    # has no receipt. They are mapped so every GatewayError has a code.
    "forward destination unknown": "forward_destination_unknown",
    "forward C-STORE HTTP {}": "forward_store",
    "forward C-STORE answer invalid": "forward_store",
    "forward C-STORE failed count={}": "forward_store",
}
GATEWAY_ERROR_FALLBACK = "other"
_ERROR_PATTERNS = tuple(
    (re.compile(r"\S+".join(re.escape(part) for part in template.split("{}"))), code)
    for template, code in GATEWAY_ERROR_CODES.items()
)


def error_code(error: BaseException) -> str:
    """Only the message template decides the code; nothing of the message itself is sent."""
    if isinstance(error, GatewayError):
        message = str(error)
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
# Routing and clean-up state of a study. destinations NULL = never decided by a rule = KIN only (the behaviour before
# routing). purged_sops are SOPs whose local copy the clean-up deleted after every destination had them; purged_at is
# when, and a new StableStudy clears it so instances that came later are looked at again.
ROUTE_COLUMNS = (
    ("destinations", "destinations TEXT"),
    # SOPs KIN named in its STOW answer's ReferencedSOPSequence (00081199): the only KIN basis the clean-up deletes on.
    # successful_sops (sent minus the named failures) stays what receipts count.
    ("confirmed_sops", "confirmed_sops TEXT NOT NULL DEFAULT '[]'"),
    ("purged_sops", "purged_sops TEXT NOT NULL DEFAULT '[]'"),
    ("purged_at", "purged_at REAL"),
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
AGENT_VERSION = "2026.11.1"
HEARTBEAT_SECONDS = 30.0
# Gateway settings (routing rules, how long sent copies are kept, lossless compression) are set by the institution's
# administrator in KIN and read by the heartbeat thread every SETTINGS_EVERY beats (the first right after start). No
# settings = KIN only, nothing deleted, nothing transcoded: exactly the behaviour before settings existed.
SETTINGS_EVERY = 2
# The clean-up of sent copies runs at most this often in the main loop, and looks at this many studies per pass.
PURGE_SECONDS = 60.0
PURGE_LIMIT = 20
KIN_DESTINATION = "kin"
# The stored transfer syntaxes lossless compression may replace (native, uncompressed pixel data), and the one it sends:
# JPEG Lossless, Non-Hierarchical, First-Order Prediction. Anything else (already compressed, lossy or unknown) is sent
# with its own bytes; there is no path to a lossy syntax.
NATIVE_SYNTAXES = frozenset(("1.2.840.10008.1.2", "1.2.840.10008.1.2.1", "1.2.840.10008.1.2.2"))
LOSSLESS_SYNTAX = "1.2.840.10008.1.2.4.70"
SETTINGS_ROUTES_MAX = 32
SETTINGS_DESTINATIONS_MAX = 9
RETENTION_DAYS_MAX = 3650
_SETTINGS_ID = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")
_SETTINGS_AE = re.compile(r"[ -~]{1,16}")
_SETTINGS_MODALITY = re.compile(r"[A-Z0-9]{1,16}")
_SETTINGS_HOST = re.compile(r"[A-Za-z0-9.:\-]{1,253}")
NO_SETTINGS: dict[str, Any] = {"revision": 0, "routes": [], "retentionDays": None, "compression": "none", "peers": {}}


def _closed(value: Any, keys: set[str]) -> bool:
    return isinstance(value, dict) and set(value) == keys


def parse_settings(payload: Any) -> dict[str, Any] | None:
    """KIN's GET /api/gateway/settings answer as the agent uses it, or None when its shape is not exactly the contract.

    Closed shape on purpose: an answer this agent does not understand is never half applied; the last good settings stay.
    """
    if not _closed(payload, {"revision", "routes", "retentionDays", "compression", "destinations"}):
        return None
    revision, routes, days = payload["revision"], payload["routes"], payload["retentionDays"]
    if not isinstance(revision, int) or isinstance(revision, bool) or revision < 0:
        return None
    if payload["compression"] not in ("none", "lossless"):
        return None
    if days is not None and (not isinstance(days, int) or isinstance(days, bool) or not 0 <= days <= RETENTION_DAYS_MAX):
        return None
    peers: dict[str, dict[str, Any]] = {}
    destinations = payload["destinations"]
    if not isinstance(destinations, list) or len(destinations) > SETTINGS_ROUTES_MAX * SETTINGS_DESTINATIONS_MAX:
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
                or not all(target == KIN_DESTINATION or target in peers for target in targets)):
            return None
        normalized.append({"modality": modality, "sourceAe": source, "destinations": list(targets)})
    return {"revision": revision, "routes": normalized, "retentionDays": days, "compression": payload["compression"],
            "peers": peers}


def route_for(routes: list[dict[str, Any]], modalities: set[str], source_aes: set[str]) -> list[str]:
    """The one routing rule: the first route whose conditions all hold names the destinations; no route holds -> KIN.

    A condition is one value the agent already has: a Modality of any series of the study, or the sending device's AE of
    any instance (the RemoteAET of its C-STORE). A route with neither condition holds for every study. The study is the
    unit: a study is never split between destinations.
    """
    for route in routes:
        if route["modality"] is not None and route["modality"] not in modalities:
            continue
        if route["sourceAe"] is not None and route["sourceAe"] not in source_aes:
            continue
        return list(route["destinations"])
    return [KIN_DESTINATION]


class SettingsStore:
    """The last good Gateway settings: in memory for the main loop, in a file beside the queue for the next start.

    Only the heartbeat thread writes (one assignment of a new dict, and a whole-file replace); the main loop only reads
    `.current` and `.known`. Unknown is not "no rules": until a good answer was taken once (now or by an earlier run of
    this same Gateway credential, kept in the file), `.known` is False and the main loop sends nothing, because a study
    a rule keeps away from KIN must not go to KIN by default. KIN answers empty settings when none are set.
    """

    def __init__(self, queue_db: str, client_id: str):
        self.path = Path(queue_db).with_name("settings.json")
        self.client_id = client_id
        try:
            saved = json.loads(self.path.read_text(encoding="utf-8"))
            stored = saved.get("answer") if saved.get("client") == client_id else None
        except (OSError, ValueError, AttributeError):
            stored = None
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
            temporary.write_text(json.dumps({"client": self.client_id, "answer": payload}, separators=(",", ":")),
                                 encoding="utf-8")
            os.replace(temporary, self.path)
            self.raw = payload
            self.current = parsed
        self.known = True
        return True


def log(event: str, *, uid: str | None = None, **fields: Any) -> None:
    safe = {"at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "event": event}
    if uid:
        safe["uid"] = uid
    safe.update(fields)
    print(json.dumps(safe, ensure_ascii=False, separators=(",", ":")), flush=True)


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
            updated_at REAL NOT NULL,
            PRIMARY KEY (uid, dest)
          );
        """)
        self.db.commit()
        # S4-U3 receipt state. New and pre-receipt queues take the same path, so an installed queue keeps
        # every row and phase. The epoch is born with this queue: a recreated queue is a new epoch, and
        # KIN refuses it for studies an earlier epoch already reported (no automatic rollover, H-1).
        columns = {row["name"] for row in self.db.execute("PRAGMA table_info(studies)")}
        with self.db:
            for name, ddl in RECEIPT_COLUMNS + ROUTE_COLUMNS:
                if name not in columns:
                    try:
                        self.db.execute(f"ALTER TABLE studies ADD COLUMN {ddl}")
                    except sqlite3.OperationalError as error:
                        # The HEALTHCHECK `status` process may open the same queue at the same moment.
                        if "duplicate column name" not in str(error):
                            raise
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
                    last_error=NULL, error_code=NULL, seq=seq+1, updated_at=excluded.updated_at, purged_at=NULL
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

    def set_destinations(self, uid: str, destinations: list[str]) -> None:
        """Record the decision and give every destination other than KIN its own row (an existing row stays as it is)."""
        now = time.time()
        with self.db:
            self.db.execute("UPDATE studies SET destinations=? WHERE uid=?", (json.dumps(destinations), uid))
            for dest in destinations:
                if dest != KIN_DESTINATION:
                    self.db.execute("""
                      INSERT INTO forwards(uid, dest, phase, updated_at) VALUES (?, ?, 'pending', ?)
                      ON CONFLICT(uid, dest) DO NOTHING
                    """, (uid, dest, now))

    def not_routed(self, uid: str) -> None:
        with self.db:
            self.db.execute("""
              UPDATE studies SET phase='not_routed', attempt=0, next_at=0, last_error=NULL, error_code=NULL, updated_at=?
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

    # ── clean-up of sent copies ──

    def purge_candidates(self, cutoff: float, limit: int = PURGE_LIMIT) -> list[sqlite3.Row]:
        """Studies whose every destination finished at or before cutoff and whose copy was not cleaned up since.

        KIN finished = complete; KIN not a destination = not_routed. A forward row that is not complete, or finished
        after cutoff, keeps the study out. failed and every unsent phase are never candidates.
        """
        return list(self.db.execute("""
          SELECT s.* FROM studies s
          WHERE s.phase IN ('complete', 'not_routed') AND s.purged_at IS NULL AND s.updated_at <= ?
            AND NOT EXISTS (SELECT 1 FROM forwards f WHERE f.uid = s.uid AND (f.phase != 'complete' OR f.updated_at > ?))
          ORDER BY s.updated_at, s.uid LIMIT ?
        """, (cutoff, cutoff, limit)))

    def sent_everywhere(self, uid: str) -> set[str]:
        """The SOPs every destination of the study is known to have: for KIN only what its STOW answer named as stored,
        for another destination what its C-STORE association counted. KIN counts only when it is a destination."""
        destinations = self.destinations(uid) or [KIN_DESTINATION]
        sets = [self.confirmed(uid) if dest == KIN_DESTINATION else self.forward_successes(uid, dest)
                for dest in destinations]
        return set.intersection(*sets) if sets else set()

    def purged_sops(self, uid: str) -> set[str]:
        row = self.db.execute("SELECT purged_sops FROM studies WHERE uid=?", (uid,)).fetchone()
        try:
            value = json.loads(row["purged_sops"]) if row else []
            return {str(item) for item in value if isinstance(item, str)}
        except (TypeError, json.JSONDecodeError):
            return set()

    def purged(self, uid: str, sops: set[str]) -> None:
        """Written BEFORE the local copies are deleted: the SOPs leave every destination's sent set (so the same SOP
        UID arriving again is sent again, never taken as already sent) and are kept as purged. A stop between this
        and the deletion leaves a local copy that is sent again on its next StableStudy - never a lost one."""
        def without(column: str, table: str, where: str, args: tuple) -> None:
            for row in self.db.execute(f"SELECT rowid, {column} FROM {table} WHERE {where}", args).fetchall():
                kept = sorted(set(json.loads(row[column] or "[]")) - sops)
                self.db.execute(f"UPDATE {table} SET {column}=? WHERE rowid=?", (json.dumps(kept), row["rowid"]))

        merged = self.purged_sops(uid) | sops
        with self.db:
            without("successful_sops", "studies", "uid=?", (uid,))
            without("confirmed_sops", "studies", "uid=?", (uid,))
            without("successful_sops", "forwards", "uid=?", (uid,))
            self.db.execute("UPDATE studies SET purged_sops=?, purged_at=? WHERE uid=?",
                            (json.dumps(sorted(merged)), time.time(), uid))

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

    def confirmed(self, uid: str) -> set[str]:
        row = self.db.execute("SELECT confirmed_sops FROM studies WHERE uid=?", (uid,)).fetchone()
        try:
            value = json.loads(row["confirmed_sops"]) if row else []
            return {str(item) for item in value if isinstance(item, str)}
        except (TypeError, json.JSONDecodeError):
            return set()

    def confirm(self, uid: str, sops: set[str]) -> None:
        if not sops:
            return
        merged = self.confirmed(uid) | sops
        with self.db:
            self.db.execute("UPDATE studies SET confirmed_sops=? WHERE uid=?", (json.dumps(sorted(merged)), uid))

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
            "purgedSops": len(json.loads(row["purged_sops"] or "[]")),
        } for row in self.db.execute("SELECT * FROM studies ORDER BY updated_at, uid")]
        return {
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
            "AllowGet": False, "AllowMove": False, "AllowStore": False, "AllowStorageCommitment": False})

    def store(self, name: str, instance_ids: list[str], timeout: float) -> dict[str, Any]:
        """One synchronous C-STORE association from this Orthanc to a registered modality. Orthanc answers with counts."""
        try:
            response = self.request("POST", f"/modalities/{name}/store", timeout=timeout,
                                    json={"Resources": instance_ids, "Synchronous": True})
        except GatewayError as error:
            match = re.fullmatch(r"local Orthanc HTTP (\d+)", str(error))
            if match:
                raise GatewayError(f"forward C-STORE HTTP {match.group(1)}") from None
            raise
        try:
            answer = response.json()
        except ValueError:
            raise GatewayError("forward C-STORE answer invalid") from None
        if not isinstance(answer, dict):
            raise GatewayError("forward C-STORE answer invalid")
        return answer

    def delete_instance(self, instance_id: str) -> None:
        self.request("DELETE", f"/instances/{instance_id}")


class Cloud:
    def __init__(self, config: Config):
        self.base = config.kin_base_url
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

    def request(self, method: str, path: str, *, timeout: float | None = None, **kwargs: Any) -> requests.Response:
        base_headers = dict(kwargs.pop("headers", {}))
        body = kwargs.get("data")
        start = body.tell() if hasattr(body, "seek") else None
        for index in range(2):
            if start is not None:
                body.seek(start)
            headers = dict(base_headers)
            headers["Authorization"] = "Bearer " + self.token(force=index == 1)
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

    def announce(self, uid: str, institution_name: str) -> None:
        response = self.request("POST", "/api/gateway/announce", json={
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

    def stow(self, uid: str, body: bytes, content_type: str, source_ae: str) -> set[str]:
        self.last_stored = set()
        response = self.request(
            "POST", f"/dicom-web/studies/{uid}", data=body,
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
    sequence names nothing, so nothing is taken as stored by KIN (only deleting depends on it)."""
    if isinstance(payload, list):
        payload = payload[0] if payload else {}
    if not isinstance(payload, dict) or not isinstance(payload.get("00081199"), dict):
        return set()
    sequence = payload["00081199"].get("Value", [])
    stored = set()
    for item in sequence if isinstance(sequence, list) else []:
        values = item.get("00081155", {}).get("Value", []) if isinstance(item, dict) else []
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
            "version": AGENT_VERSION,
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
        self.settings = SettingsStore(config.queue_db, config.client_id)
        self.purge_at = time.monotonic() + PURGE_SECONDS

    def stop(self, *_args: Any) -> None:
        self.stopping = True

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
                    # The study was deleted after it became stable (the clean-up took its last instance): nothing is
                    # left to send, and the change feed must not stop here.
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

    def route(self, row: sqlite3.Row, orthanc_id: str, instances: list[dict[str, Any]]) -> bool:
        """The study's destinations, decided once and then fixed; True when KIN is one of them.

        Fixed means fixed: a late instance, a retry and a later change of the rules all keep the first decision, so a
        destination never gets only part of a study and a study is never sent somewhere it was not decided for. A row
        KIN already knows (announced, or with SOPs KIN took) stays KIN only. No routes and no decision: nothing is read
        or written - the path before routing, unchanged.
        """
        uid = str(row["uid"])
        decided = self.queue.destinations(uid)
        if decided is None:
            routes = self.settings.current["routes"]
            if not routes:
                return True
            if row["announced"] or self.queue.successes(uid):
                decided = [KIN_DESTINATION]
            else:
                decided = route_for(routes, self.orthanc.series_modalities(orthanc_id),
                                    {item.get("source_ae", "") for item in instances} - {""})
            self.queue.set_destinations(uid, decided)
            log("study.routed", uid=uid, destinations=len(decided))
        if KIN_DESTINATION in decided:
            return True
        self.queue.not_routed(uid)
        return False

    def process(self, row: sqlite3.Row) -> None:
        uid = str(row["uid"])
        self.queue.phase(uid, "announcing")
        orthanc_id, detail, instances = self.orthanc.instances(uid, str(row["orthanc_id"]))
        if not self.route(row, orthanc_id, instances):
            return
        institution_name = str((detail.get("MainDicomTags") or {}).get("InstitutionName", ""))
        self.cloud.announce(uid, institution_name)

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
                failures = self.cloud.stow(uid, body, content_type, batch[0].get("source_ae", ""))
            batch_sops = {item["sop"] for item in batch}
            unknown = failures - batch_sops
            if unknown:
                raise GatewayError("STOW response named an unknown failed SOP")
            self.queue.add_successes(uid, batch_sops - failures, batch_index)
            self.queue.confirm(uid, getattr(self.cloud, "last_stored", set()) & (batch_sops - failures))
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
        peer = self.settings.current["peers"].get(dest)
        if peer is None:
            raise GatewayError("forward destination unknown")
        self.queue.forward_phase(uid, dest, "sending")
        modality = "kin-route-" + dest
        self.orthanc.put_modality(modality, peer)
        orthanc_id, _detail, instances = self.orthanc.instances(uid, self.queue.orthanc_id(uid))
        done = self.queue.forward_successes(uid, dest)
        pending = [item for item in instances if item["sop"] not in done]
        for index, batch in enumerate(plan_batches(pending, self.config.byte_budget), 1):
            answer = self.orthanc.store(modality, [item["id"] for item in batch], self.config.stow_timeout)
            failed, count = answer.get("FailedInstancesCount"), answer.get("InstancesCount")
            if not isinstance(failed, int) or not isinstance(count, int):
                raise GatewayError("forward C-STORE answer invalid")
            if failed or count != len(batch):
                raise GatewayError(f"forward C-STORE failed count={max(failed, len(batch) - count)}")
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

    def purge(self) -> None:
        """Delete local copies every destination has, once the configured days have passed. Never raises.

        A study is looked at only when every destination finished (queue.purge_candidates). Of its instances, only those
        whose SOP every destination has are deleted, one by one: an instance that arrived later, or any SOP one
        destination lacks, stays. No retention setting = nothing is ever deleted.
        """
        days = self.settings.current["retentionDays"]
        now = time.monotonic()
        if days is None or now < self.purge_at:
            return
        self.purge_at = now + PURGE_SECONDS
        try:
            candidates = self.queue.purge_candidates(time.time() - days * 86400)
        except Exception as error:
            log("purge.deferred", error=error_code(error))
            return
        for row in candidates:
            uid = str(row["uid"])
            try:
                try:
                    _orthanc_id, _detail, instances = self.orthanc.instances(uid, str(row["orthanc_id"]))
                except GatewayError as error:
                    if str(error) != "local study lookup count=0":
                        raise
                    instances = []   # the study is no longer here: nothing to delete, and it is not looked at again
                sent = self.queue.sent_everywhere(uid)
                deletable = [item for item in instances if item["sop"] in sent]
                self.queue.purged(uid, {item["sop"] for item in deletable})   # the record first, then the deletion
                for item in deletable:
                    self.orthanc.delete_instance(item["id"])
                log("study.purged", uid=uid, sops=len(deletable), pending=len(instances) - len(deletable))
            except Exception as error:
                log("purge.deferred", uid=uid, error=error_code(error))
                return

    def run(self) -> None:
        signal.signal(signal.SIGTERM, self.stop)
        signal.signal(signal.SIGINT, self.stop)
        log("agent.started", byteBudget=self.config.byte_budget, version=AGENT_VERSION)
        heartbeat = Heartbeat(self.config, self.queue.epoch, self.orthanc, self.cloud, time.monotonic(),
                              self.settings)
        heartbeat.start()
        try:
            self.loop()
        finally:
            heartbeat.stop()
        self.queue.close()
        log("agent.stopped")

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
                if row:
                    uid = str(row["uid"])
                    try:
                        self.process(row)
                    except PermanentGatewayError as error:
                        reason = str(error)
                        self.queue.fail(uid, reason, error_code(error))
                        log("study.failed", uid=uid, error=reason)
                        continue
                    except Exception as error:
                        reason = str(error) if isinstance(error, GatewayError) else type(error).__name__
                        attempt, delay = self.queue.retry(
                            uid, reason, self.config.backoff_base, self.config.backoff_max, error_code(error),
                        )
                        log("study.retry", uid=uid, attempt=attempt, afterSeconds=round(delay, 2), error=reason)
                        continue
                # A destination other than KIN goes after the KIN row of this pass, with its own backoff: one that
                # is down never holds KIN or another destination back.
                forward = self.queue.forward_due() if self.settings.known else None
                if forward:
                    uid = str(forward["uid"])
                    try:
                        self.process_forward(forward)
                    except Exception as error:
                        reason = str(error) if isinstance(error, GatewayError) else type(error).__name__
                        attempt, delay = self.queue.forward_retry(
                            uid, str(forward["dest"]), reason, self.config.backoff_base, self.config.backoff_max,
                        )
                        log("forward.retry", uid=uid, attempt=attempt, afterSeconds=round(delay, 2), error=reason)
                self.purge()
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
    Agent(Config.from_env()).run()
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except GatewayError as error:
        log("agent.fatal", error=str(error))
        raise SystemExit(2)
