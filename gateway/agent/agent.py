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
import socket
import sqlite3
import struct
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
    "LOCAL_DICOM_PORT must be a port number": "configuration",
    "LOCAL_DICOM_AET must be 1-16 printable characters": "configuration",
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
    "STOW refused patient identity conflict": "stow_patient_conflict",
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
    # Distinct series of the sent SOPs (successCount's set). NULL = unknown: a row counted before this column, or a sent SOP
    # whose series this Gateway could not read. Unknown goes to KIN as null and is never 0.
    ("success_series", "success_series INTEGER"),
    ("error_code", "error_code TEXT"),
    ("announced", "announced INTEGER NOT NULL DEFAULT 0"),
    ("reported_seq", "reported_seq INTEGER NOT NULL DEFAULT 0"),
)
# Retention (Queue.retention_due is the one rule). confirmed_seq: the seq of the last receipt KIN answered stored or
# duplicate for this study (a stale answer or a refusal ends the report but confirms nothing). kin_stored_sops: the SOPs
# KIN named as stored (00081199) in a STOW answer and did not name as failed — NULL for a row from before this column,
# which is never deleted. purged: {"sops": {SOP: series}, "modalities": [...], "sourceAes": [...]} of the copies deleted
# (NULL = none), so a late image of the study is counted and routed with them. purge_intent: the instances one deletion
# is about to remove, written before Orthanc is asked and settled against what Orthanc still holds.
RETENTION_COLUMNS = (
    ("confirmed_seq", "confirmed_seq INTEGER NOT NULL DEFAULT 0"),
    ("kin_stored_sops", "kin_stored_sops TEXT"),
    ("purged", "purged TEXT"),
    ("purge_intent", "purge_intent TEXT"),
    ("purged_at", "purged_at REAL"),
)
# not_routed: the study's destinations do not include KIN, so KIN is never announced to and gets no receipt.
FINAL_STUDY_PHASES = ("complete", "failed", "not_routed")
# KIN's answers to a STOW that the same bytes can never change: the study KIN holds under this UID is another patient's
# (the PatientID differs), or already two patients'. KIN wrote nothing. Read from the 409 answer's JSON code alone; any
# other 409 (the archive's own, for a body of another study) is retried as before.
STOW_IDENTITY_REFUSALS = ("PATIENT_ID_CONFLICT", "EXISTING_STUDY_IDENTITY_UNRESOLVED")
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
AGENT_VERSION = "2026.11.4"
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
# DICOM receive self-check: before each beat the heartbeat thread opens one DICOM association to the local Orthanc's
# listener (the port the hospital's devices send to) and sends C-ECHO. Only a C-ECHO-RSP with Status 0x0000 to this
# request on the accepted Verification context is "accepted"; an explicit association or context rejection, or a
# valid failure Status, is "rejected"; anything else (no connection, the deadline, a close or abort without a valid
# answer, an answer this code cannot read) is "no_answer". One deadline covers connecting through reading the answer.
# The REST answers and the beat itself never fill this result.
DICOM_ECHO_SECONDS = 5.0
DICOM_AE = re.compile(r"[ -\[\]-~]{0,15}[!-\[\]-~]")   # 1-16 printable ASCII, no backslash, not only spaces
DICOM_CALLING_AE = "KINGW-CHECK"
VERIFICATION_SOP = "1.2.840.10008.1.1"
IMPLICIT_LITTLE_ENDIAN = "1.2.840.10008.1.2"
APPLICATION_CONTEXT = "1.2.840.10008.3.1.1.1"
# This agent's DICOM implementation class (a UUID-derived UID, PS3.5 B.2) and version name.
IMPLEMENTATION_CLASS_UID = "2.25.226347301929370163734862106327352741513"
IMPLEMENTATION_VERSION = "KINGW-" + AGENT_VERSION
# Gateway settings (routing rules, lossless compression and how long delivered copies are kept) are set by the
# institution's administrator in KIN and read by the heartbeat thread every SETTINGS_EVERY beats (the first right after
# start). No settings = KIN only, nothing deleted, nothing transcoded: exactly the behaviour before settings existed.
SETTINGS_EVERY = 2
# Retention of delivered local copies (Agent.purge_delivered, the rule in Queue.retention_due). retentionDays null = never
# delete. The first version that keeps the purge record (purged SOPs and routing facts) a later image must read: a
# launcher whose image agent or fallback release is older never lets this agent delete (an older agent would refuse a
# late image of a purged study). The cadence is fixed like the retry poll; a changed period is looked at on the next pass.
RETENTION_SINCE = "2026.11.3"
RETENTION_CHECK_SECONDS = 300.0
RETENTION_STUDIES_PER_PASS = 10
RETENTION_DELETE_CHUNK = 500
RETENTION_DAYS_MAX = 3650
DAY_SECONDS = 86400
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
NO_SETTINGS: dict[str, Any] = {"revision": 0, "routes": [], "compression": "none", "peers": {}, "retentionDays": None}
SETTINGS_KEYS = {"revision", "routes", "compression", "destinations"}


def version_key(value: str) -> tuple[int, ...]:
    """Numeric parts; missing trailing parts are 0 (update.py's order)."""
    parts = [int(part) for part in value.split(".")]
    while len(parts) > 1 and parts[-1] == 0:
        parts.pop()
    return tuple(parts)


def keeps_purge_record(version: Any) -> bool:
    """Whether an agent of `version` reads the purge record (RETENTION_SINCE or newer)."""
    return (isinstance(version, str) and len(version) <= 32 and RUN_VERSION.fullmatch(version) is not None
            and version_key(version) >= version_key(RETENTION_SINCE))


def _closed(value: Any, keys: set[str]) -> bool:
    return isinstance(value, dict) and set(value) == keys


def parse_settings(payload: Any) -> dict[str, Any] | None:
    """KIN's GET /api/gateway/settings answer as the agent uses it, or None when its shape is not exactly the contract.

    Closed shape on purpose: an answer this agent does not understand is never half applied; the last good settings stay.
    retentionDays is there only because this agent asked for it (Cloud.settings); a KIN that does not know it answers the
    other keys, which means "never delete".
    """
    if not (_closed(payload, SETTINGS_KEYS) or _closed(payload, SETTINGS_KEYS | {"retentionDays"})):
        return None
    days = payload.get("retentionDays")
    if days is not None and not (isinstance(days, int) and not isinstance(days, bool) and 1 <= days <= RETENTION_DAYS_MAX):
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
            "peers": peers, "retentionDays": days}


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

    The file's `answer` is always the shape an older agent reads (an image rolled back finds its settings); retentionDays
    is kept beside it, so an older agent never deletes and never refuses the copy.
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
                if isinstance(stored, dict) and "retentionDays" in saved:
                    stored = {**stored, "retentionDays": saved["retentionDays"]}
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
            saved: dict[str, Any] = {**self.owner, "answer": {k: v for k, v in payload.items() if k != "retentionDays"}}
            if "retentionDays" in payload:
                saved["retentionDays"] = payload["retentionDays"]
            temporary.write_text(json.dumps(saved, separators=(",", ":")), encoding="utf-8")
            os.replace(temporary, self.path)
            self.raw = payload
            self.current = parsed
        self.known = True
        return True


_LOG_LOCK = threading.Lock()
# The last LOG_RING_MAX log lines of this run, as the remote-support diagnostics carry them. Only the whole-Gateway
# events named in LOG_RING_EVENTS are kept — each by its full name, never by prefix. Every event about one study
# (study.*, batch.*, forward.*, receipt.*, retry_request.*, agent.retry, ...) stays out whether or not it names a UID: its
# time alone would tell which study was handled when. A kept line carries the time, the event and only numbers,
# true/false and error codes — never a UID, a destination or free text.
LOG_RING_MAX = 200
LOG_RING: deque[dict[str, Any]] = deque(maxlen=LOG_RING_MAX)
LOG_RING_EVENTS = frozenset({
    "agent.started", "agent.stopped", "agent.ready", "agent.identity_blocked",
    "heartbeat.deferred", "heartbeat.queue_unreadable",
    "settings.deferred", "settings.invalid",
    "support.deferred", "support.invalid", "support.queue_unreadable", "support.restart",
    "support.update_handed_over",
})


def _ring_line(safe: dict[str, Any]) -> dict[str, Any]:
    line: dict[str, Any] = {"at": safe["at"], "event": safe["event"]}
    for key, value in safe.items():
        if key in ("at", "event") or not re.fullmatch(r"[A-Za-z]{1,32}", key):
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
        if event in LOG_RING_EVENTS:
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
    # The local Orthanc's DICOM listener, the one the hospital's devices send to, checked with C-ECHO by the heartbeat.
    # An empty host means the host of orthanc_url (the same container).
    dicom_host: str = ""
    dicom_port: int = 4242
    dicom_aet: str = "KINGW"

    @classmethod
    def from_env(cls) -> "Config":
        budget_mib = float(os.environ.get("BYTE_BUDGET_MIB", "24"))
        if not math.isfinite(budget_mib) or budget_mib <= 0:
            raise GatewayError("BYTE_BUDGET_MIB must be finite and > 0")
        port = os.environ.get("LOCAL_DICOM_PORT", "4242").strip()
        if not port.isdigit() or not 1 <= int(port) <= 65535:
            raise GatewayError("LOCAL_DICOM_PORT must be a port number")
        aet = os.environ.get("LOCAL_DICOM_AET", "KINGW").strip()
        if not DICOM_AE.fullmatch(aet):
            raise GatewayError("LOCAL_DICOM_AET must be 1-16 printable characters")
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
            dicom_host=os.environ.get("LOCAL_DICOM_HOST", "").strip(),
            dicom_port=int(port),
            dicom_aet=aet,
        )

    def listener(self) -> tuple[str, int, str]:
        """Where the C-ECHO goes: (host, port, called AE title)."""
        return (self.dicom_host or urlsplit(self.orthanc_url).hostname or "", self.dicom_port, self.dicom_aet)


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
            for table, additions in (("studies", (*RECEIPT_COLUMNS, ("destinations", "destinations TEXT"),
                                                  *RETENTION_COLUMNS)),
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
                # A new row records KIN's stored SOPs from its first STOW; a row from before that column keeps NULL.
                # A purge is done for the state it was decided in: new images make the study a candidate again later.
                self.db.execute("""
                  INSERT INTO studies(uid, orthanc_id, phase, next_at, updated_at, kin_stored_sops)
                  VALUES (?, ?, 'pending', 0, ?, '[]')
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

    def announced(self, uid: str, local_count: int, success_count: int, success_series: int | None = None) -> None:
        """KIN accepted the announce, so this study's state may now be reported."""
        with self.db:
            self.db.execute("""
              UPDATE studies SET announced=1, local_count=?, success_count=?, success_series=?, seq=seq+1, updated_at=?
              WHERE uid=?
            """, (local_count, success_count, success_series, time.time(), uid))

    def counts(self, uid: str, local_count: int, success_count: int, success_series: int | None = None) -> None:
        with self.db:
            self.db.execute("""
              UPDATE studies SET local_count=?, success_count=?, success_series=?, seq=seq+1, updated_at=? WHERE uid=?
            """, (local_count, success_count, success_series, time.time(), uid))

    def add_successes(self, uid: str, sops: set[str], batch_index: int, stored: set[str] = frozenset()) -> None:
        """`stored` are the SOPs of `sops` KIN named as stored; they join kin_stored_sops unless the row predates it."""
        merged = self.successes(uid) | sops
        with self.db:
            self.db.execute("""
              UPDATE studies SET successful_sops=?, batch_index=?, updated_at=? WHERE uid=?
            """, (json.dumps(sorted(merged)), batch_index, time.time(), uid))
            if stored:
                self.db.execute("UPDATE studies SET kin_stored_sops=? WHERE uid=? AND kin_stored_sops IS NOT NULL",
                                (json.dumps(sorted(self.kin_stored(uid) | (stored & sops))), uid))

    def kin_stored(self, uid: str) -> set[str]:
        row = self.db.execute("SELECT kin_stored_sops FROM studies WHERE uid=?", (uid,)).fetchone()
        try:
            value = json.loads(row["kin_stored_sops"]) if row and row["kin_stored_sops"] is not None else []
            return {str(item) for item in value if isinstance(item, str)}
        except (TypeError, json.JSONDecodeError):
            return set()

    def complete(self, uid: str, sops: int, success_series: int | None = None) -> None:
        # complete is exactly "the local SOP set equals the sent set at this check", so M == N here.
        with self.db:
            self.db.execute("""
              UPDATE studies SET phase='complete', attempt=0, next_at=0,
                last_error=NULL, error_code=NULL, local_count=?, success_count=?, success_series=?, seq=seq+1, updated_at=?
              WHERE uid=?
            """, (sops, sops, success_series, time.time(), uid))

    def pending_now(self, uid: str, local_count: int, success_count: int, success_series: int | None = None) -> None:
        with self.db:
            self.db.execute("""
              UPDATE studies SET phase='pending', attempt=0, next_at=0,
                last_error=NULL, error_code=NULL, local_count=?, success_count=?, success_series=?, seq=seq+1, updated_at=?
              WHERE uid=?
            """, (local_count, success_count, success_series, time.time(), uid))

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
          SELECT phase, attempt, seq, local_count, success_count, success_series, error_code, announced FROM studies WHERE uid=?
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
            "successSeries": None if row["success_series"] is None else int(row["success_series"]),
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

    def confirmed(self, uid: str, seq: int) -> None:
        """KIN answered stored or duplicate to the receipt of this seq (Agent.report): the only basis retention reads."""
        with self.db:
            self.db.execute("UPDATE studies SET confirmed_seq=? WHERE uid=? AND confirmed_seq < ?", (seq, uid, seq))

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

    # ── retention: deleting a delivered local copy (the rule is retention_due; Agent.purge_delivered runs it) ──

    def retention_due(self, row: sqlite3.Row) -> bool:
        """The one rule: every destination decided for the study has finished it by this Gateway's own record, and its
        final state is confirmed. KIN: complete, KIN answered stored/duplicate to that exact receipt (confirmed_seq = seq)
        and the row records which SOPs KIN named as stored. Each other destination: its forward row exists and is complete.
        A study KIN is not a destination of is not_routed. Anything else (undecided, pending, retry, failed, a peer that
        was removed or changed and so stays in retry, a refused receipt, a row from before the record) is kept."""
        try:
            destinations = json.loads(row["destinations"]) if row["destinations"] else None
        except (TypeError, ValueError):
            return False
        if not isinstance(destinations, list) or not destinations or not all(isinstance(d, str) for d in destinations):
            return False
        forwards = {str(f["dest"]): str(f["phase"]) for f in self.db.execute(
            "SELECT dest, phase FROM forwards WHERE uid=?", (row["uid"],))}
        if set(forwards) != set(destinations) - {KIN_DESTINATION} or any(p != "complete" for p in forwards.values()):
            return False
        if KIN_DESTINATION in destinations:
            return (row["phase"] == "complete" and int(row["confirmed_seq"]) == int(row["seq"])
                    and row["kin_stored_sops"] is not None)
        return row["phase"] == "not_routed"

    def purgeable(self, cutoff: float, limit: int, after: tuple[float, str] | None = None,
                  uid: str | None = None, intended: bool = False) -> list[sqlite3.Row]:
        """Studies retention_due holds for whose last destination finished at or before `cutoff` (wall clock), oldest
        first, after `after` (delivered time, UID). The delivered moment is the latest updated_at of the study row and its
        forward rows: each is written by the final transition (complete, not_routed, forward complete); reports, retry
        polls and the purge record do not move it. `intended`: also the study whose deletion is under way (the check
        before each of its delete requests)."""
        rows = self.db.execute("""
          SELECT * FROM (
            SELECT s.*, max(s.updated_at, coalesce((SELECT max(f.updated_at) FROM forwards f WHERE f.uid = s.uid), 0))
              AS delivered_at
            FROM studies s
            WHERE s.phase IN ('complete', 'not_routed') AND s.purged_at IS NULL AND (s.purge_intent IS NULL OR ?)
              AND s.destinations IS NOT NULL AND (? IS NULL OR s.uid = ?)
          ) WHERE delivered_at <= ? AND (? IS NULL OR (delivered_at, uid) > (?, ?))
          ORDER BY delivered_at, uid
        """, (int(intended), uid, uid, cutoff, after and after[0], after and after[0], after and after[1])).fetchall()
        due = []
        for row in rows:
            if self.retention_due(row):
                due.append(row)
                if len(due) >= limit:
                    break
        return due

    def delivered_sops(self, uid: str) -> set[str]:
        """SOPs every destination of the study holds by this Gateway's record (KIN: sent and named stored)."""
        destinations = self.destinations(uid) or []
        sets = [self.successes(uid) & self.kin_stored(uid)] if KIN_DESTINATION in destinations else []
        sets += [self.forward_successes(uid, dest) for dest in destinations if dest != KIN_DESTINATION]
        return set.intersection(*sets) if sets else set()

    def purge_record(self, uid: str) -> dict[str, Any]:
        """The copies of this study deleted so far: {"sops": {SOP: series id}, "modalities": [...], "sourceAes": [...]}."""
        row = self.db.execute("SELECT purged FROM studies WHERE uid=?", (uid,)).fetchone()
        record: dict[str, Any] = {"sops": {}, "modalities": [], "sourceAes": []}
        try:
            value = json.loads(row["purged"]) if row and row["purged"] else {}
        except (TypeError, ValueError):
            value = {}
        if isinstance(value, dict):
            sops = value.get("sops")
            record["sops"] = {str(k): str(v) for k, v in sops.items()} if isinstance(sops, dict) else {}
            for key in ("modalities", "sourceAes"):
                items = value.get(key)
                record[key] = sorted({str(i) for i in items}) if isinstance(items, list) else []
        return record

    def begin_purge(self, uid: str, orthanc_id: str, targets: list[dict[str, str]], modalities: set[str],
                    source_aes: set[str]) -> None:
        """Written before Orthanc is asked: the instances about to go, the study's routing facts and the state (seq) the
        deletion was decided in."""
        row = self.db.execute("SELECT seq FROM studies WHERE uid=?", (uid,)).fetchone()
        with self.db:
            self.db.execute("UPDATE studies SET purge_intent=? WHERE uid=?", (json.dumps({
                "orthancId": orthanc_id, "targets": targets, "modalities": sorted(modalities),
                "sourceAes": sorted(source_aes), "seq": int(row["seq"]) if row else None}), uid))

    def intents(self) -> list[str]:
        return [str(row["uid"]) for row in self.db.execute("SELECT uid FROM studies WHERE purge_intent IS NOT NULL")]

    def purge_orthanc_id(self, uid: str) -> str | None:
        """The Orthanc study id of a recorded intent, or None when there is none."""
        row = self.db.execute("SELECT purge_intent FROM studies WHERE uid=?", (uid,)).fetchone()
        try:
            intent = json.loads(row["purge_intent"]) if row and row["purge_intent"] else None
        except (TypeError, ValueError):
            intent = None
        if not isinstance(intent, dict):
            return None
        return str(intent.get("orthancId") or "")

    def settle_purge(self, uid: str, present: set[str]) -> tuple[int, int]:
        """Settle the recorded intent against the instance ids Orthanc holds now: each target no longer there joins the
        purge record and the count once; the intent is cleared. Returns (deleted, still there)."""
        row = self.db.execute("SELECT purge_intent FROM studies WHERE uid=?", (uid,)).fetchone()
        try:
            intent = json.loads(row["purge_intent"]) if row and row["purge_intent"] else None
        except (TypeError, ValueError):
            intent = None
        targets = intent.get("targets") if isinstance(intent, dict) and isinstance(intent.get("targets"), list) else []
        targets = [t for t in targets if isinstance(t, dict) and isinstance(t.get("id"), str) and isinstance(t.get("sop"), str)]
        gone = [t for t in targets if t["id"] not in present]
        left = len(targets) - len(gone)
        record = self.purge_record(uid)
        if gone:
            record["sops"].update({t["sop"]: str(t.get("series") or "") for t in gone})
            for key in ("modalities", "sourceAes"):
                record[key] = sorted(set(record[key]) | {str(i) for i in (intent.get(key) or [])})
        with self.db:
            if gone:
                self.db.execute("UPDATE studies SET purged=? WHERE uid=?", (json.dumps(record, sort_keys=True), uid))
                self.db.execute("""
                  INSERT INTO meta(key, value) VALUES ('retention_instances', ?)
                  ON CONFLICT(key) DO UPDATE SET value = CAST(CAST(value AS INTEGER) + CAST(excluded.value AS INTEGER) AS TEXT)
                """, (str(len(gone)),))
            # Done for the state it was decided in; images that arrived since (a new seq) make the study a candidate again.
            self.db.execute("""
              UPDATE studies SET purge_intent=NULL, purged_at=CASE WHEN ? AND seq = ? THEN ? ELSE NULL END WHERE uid=?
            """, (int(left == 0), intent.get("seq") if isinstance(intent, dict) else None, time.time(), uid))
        return len(gone), left

    def nothing_to_purge(self, uid: str) -> None:
        """The study is due but Orthanc holds none of it (deleted by someone else): nothing is counted."""
        with self.db:
            self.db.execute("UPDATE studies SET purged_at=? WHERE uid=? AND purge_intent IS NULL", (time.time(), uid))

    def retention_totals(self) -> dict[str, int]:
        return retention_totals(self.db)

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
            "purgedSops": len(self.purge_record(str(row["uid"]))["sops"]),
        } for row in self.db.execute("SELECT * FROM studies ORDER BY updated_at, uid")]
        error = self.db.execute("SELECT value FROM meta WHERE key='identity_error'").fetchone()
        return {
            "identityError": error["value"] if error else None,
            "retention": self.retention_totals(),
            "pending": sum(
                count for phase, count in counts.items() if phase not in FINAL_STUDY_PHASES
            ),
            "failed": counts.get("failed", 0),
            "complete": counts.get("complete", 0),
            "notRouted": counts.get("not_routed", 0),
            "rows": rows,
        }


def retention_totals(db: sqlite3.Connection) -> dict[str, int]:
    """What retention deleted, from the queue (any connection, read-only included): studies with at least one deleted
    copy, instances deleted, and studies kept because their row predates the record of KIN's stored SOPs."""
    studies = db.execute("SELECT count(*) FROM studies WHERE purged IS NOT NULL").fetchone()[0]
    kept = db.execute("""SELECT count(*) FROM studies WHERE kin_stored_sops IS NULL
                         AND (destinations IS NULL OR destinations LIKE '%"kin"%')""").fetchone()[0]
    row = db.execute("SELECT value FROM meta WHERE key='retention_instances'").fetchone()
    return {"deletedStudies": int(studies), "deletedInstances": int(row[0]) if row else 0, "keptWithoutRecord": int(kept)}


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
            # ParentSeries is Orthanc's id of the instance's series: only counted (sent_series), never sent anywhere.
            normalized.append({"sop": sop, "id": instance_id, "size": size, "series": str(item.get("ParentSeries") or ""),
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

    def delete_instances(self, instance_ids: list[str]) -> None:
        """Delete exactly these instances (by Orthanc id, never a whole study: an instance that arrived meanwhile stays).
        Orthanc skips an id it no longer has and answers no count, so the caller reads what is still there."""
        self.request("POST", "/tools/bulk-delete", json={"Resources": instance_ids})

    def instance_ids(self, orthanc_id: str) -> set[str]:
        """The instance ids Orthanc holds now for this study; none once the study is gone (404)."""
        try:
            items = self.request("GET", f"/studies/{orthanc_id}/instances").json()
        except GatewayError as error:
            if str(error) == "local Orthanc HTTP 404":
                return set()
            raise
        return {str(item.get("ID", "")) for item in items if isinstance(item, dict)} - {""}

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
        # retention=1: this agent reads retentionDays; KIN leaves it out for an agent that does not ask (an older one).
        return self.request("GET", "/api/gateway/settings", params={"retention": "1"})

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
            if response.status_code == 409 and stow_refusal_code(response) in STOW_IDENTITY_REFUSALS:
                # Not an error of the transfer: the same images get the same answer, so the study is failed, not retried.
                raise PermanentGatewayError("STOW refused patient identity conflict")
            raise GatewayError(f"STOW HTTP {response.status_code}")
        self.last_stow_at = time.monotonic()
        try:
            payload = response.json() if response.content else {}
        except requests.JSONDecodeError:
            raise GatewayError("STOW response invalid") from None
        failures = failed_sops(payload)
        self.last_stored = stored_sops(payload)
        return failures


def _uid_bytes(uid: str) -> bytes:
    raw = uid.encode("ascii")
    return raw + b"\x00" if len(raw) % 2 else raw


def _item(kind: int, value: bytes) -> bytes:
    return struct.pack(">BBH", kind, 0, len(value)) + value


def _pdu(kind: int, value: bytes) -> bytes:
    return struct.pack(">BBI", kind, 0, len(value)) + value


def _element(group: int, element: int, value: bytes) -> bytes:
    return struct.pack("<HHI", group, element, len(value)) + value


def _echo_command(message_id: int) -> bytes:
    """C-ECHO-RQ command set (PS3.7 9.3.5.1), Implicit VR Little Endian, with its group length first."""
    rest = (_element(0x0000, 0x0002, _uid_bytes(VERIFICATION_SOP))
            + _element(0x0000, 0x0100, struct.pack("<H", 0x0030))
            + _element(0x0000, 0x0110, struct.pack("<H", message_id))
            + _element(0x0000, 0x0800, struct.pack("<H", 0x0101)))
    return _element(0x0000, 0x0000, struct.pack("<I", len(rest))) + rest


def _associate_request(called: str, calling: str) -> bytes:
    """A-ASSOCIATE-RQ (PS3.8 9.3.2): one presentation context, Verification in Implicit VR Little Endian."""
    context = struct.pack(">BBBB", 1, 0, 0, 0) + _item(0x30, VERIFICATION_SOP.encode()) + _item(0x40, IMPLICIT_LITTLE_ENDIAN.encode())
    user = (_item(0x51, struct.pack(">I", 16384)) + _item(0x52, IMPLEMENTATION_CLASS_UID.encode())
            + _item(0x55, IMPLEMENTATION_VERSION.encode()))
    body = (struct.pack(">HH", 1, 0) + called.ljust(16).encode("ascii") + calling.ljust(16).encode("ascii") + bytes(32)
            + _item(0x10, APPLICATION_CONTEXT.encode()) + _item(0x20, context) + _item(0x50, user))
    return _pdu(0x01, body)


class _EchoEnded(Exception):
    """The listener's side ended the exchange before a readable answer: no_answer."""


def _read_pdu(sock: socket.socket, deadline: float) -> tuple[int, bytes]:
    def exactly(count: int) -> bytes:
        data = b""
        while len(data) < count:
            left = deadline - time.monotonic()
            if left <= 0:
                raise socket.timeout()
            sock.settimeout(left)
            part = sock.recv(count - len(data))
            if not part:
                raise _EchoEnded()
            data += part
        return data
    kind, _reserved, length = struct.unpack(">BBI", exactly(6))
    if length > 1 << 20:
        raise _EchoEnded()
    return kind, exactly(length)


def _accepted_context(body: bytes) -> bool:
    """Whether the A-ASSOCIATE-AC accepts presentation context 1 (result 0) in Implicit VR Little Endian."""
    at = 68   # protocol version, reserved, the two echoed AE titles and the reserved 32 bytes
    while at + 4 <= len(body):
        kind, _reserved, length = struct.unpack(">BBH", body[at:at + 4])
        value = body[at + 4:at + 4 + length]
        at += 4 + length
        if kind == 0x21 and len(value) >= 4 and value[0] == 1:
            if value[2] != 0:
                return False
            sub = value[4:]
            return len(sub) >= 4 and sub[0] == 0x40 and sub[4:4 + struct.unpack(">H", sub[2:4])[0]].rstrip(b"\x00 ") \
                == IMPLICIT_LITTLE_ENDIAN.encode()
    return False


def _command_elements(data: bytes) -> dict[tuple[int, int], bytes]:
    elements, at = {}, 0
    while at + 8 <= len(data):
        group, element, length = struct.unpack("<HHI", data[at:at + 8])
        elements[(group, element)] = data[at + 8:at + 8 + length]
        at += 8 + length
    return elements


def dicom_echo(host: str, port: int, called: str, calling: str = DICOM_CALLING_AE,
               timeout: float = DICOM_ECHO_SECONDS, message_id: int = 1) -> str:
    """One C-ECHO to the DICOM listener at host:port: "accepted", "rejected" or "no_answer" (see DICOM_ECHO_SECONDS).

    No DICOM library: the agent's dependencies stay as they are. Never raises.
    """
    deadline = time.monotonic() + timeout
    sock: socket.socket | None = None
    try:
        sock = socket.create_connection((host, port), timeout=timeout)
        sock.settimeout(max(0.01, deadline - time.monotonic()))
        sock.sendall(_associate_request(called, calling))
        kind, body = _read_pdu(sock, deadline)
        if kind == 0x03:
            return "rejected"          # A-ASSOCIATE-RJ
        if kind != 0x02:
            return "no_answer"         # A-ABORT or anything else
        if not _accepted_context(body):
            return "rejected"          # Verification refused by the listener
        command = _echo_command(message_id)
        sock.sendall(_pdu(0x04, struct.pack(">IBB", len(command) + 2, 1, 0x03) + command))
        received = b""
        while True:
            kind, body = _read_pdu(sock, deadline)
            if kind != 0x04:
                return "no_answer"
            at, last = 0, False
            while at + 6 <= len(body):
                length, context, header = struct.unpack(">IBB", body[at:at + 6])
                fragment = body[at + 6:at + 4 + length]
                at += 4 + length
                if context == 1 and header & 0x01:
                    received += fragment
                    last = last or bool(header & 0x02)
            if last:
                break
        elements = _command_elements(received)
        field, answering, status = (elements.get((0x0000, 0x0100)), elements.get((0x0000, 0x0120)),
                                    elements.get((0x0000, 0x0900)))
        if field != struct.pack("<H", 0x8030) or answering != struct.pack("<H", message_id) \
                or status is None or len(status) != 2:
            return "no_answer"
        result = "accepted" if status == b"\x00\x00" else "rejected"
        try:   # A-RELEASE-RQ; the result is already known, a missing A-RELEASE-RP changes nothing
            sock.sendall(_pdu(0x05, bytes(4)))
            _read_pdu(sock, min(deadline, time.monotonic() + 1))
        except (OSError, _EchoEnded, struct.error):
            pass
        return result
    except (OSError, _EchoEnded, struct.error, UnicodeError):
        return "no_answer"
    finally:
        if sock is not None:
            try:
                sock.close()
            except OSError:
                pass


def stow_refusal_code(response: requests.Response) -> str | None:
    """The `code` of a refused STOW's JSON answer, or None (no JSON, not an object, no text code). Never raises."""
    try:
        payload = response.json()
    except Exception:
        return None
    code = payload.get("code") if isinstance(payload, dict) else None
    return code if isinstance(code, str) else None


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


def sent_series(instances: list[dict[str, Any]], sent: set[str]) -> int | None:
    """Distinct series of the SOPs KIN accepted that this Gateway holds now (successCount's set, so never more than it).

    A set: a SOP sent again, or a series spread over several batches, is counted once. Only KIN's own success set is
    given here, never a forward destination's. None when a counted SOP has no series id: unknown is never a count.
    """
    held = [item for item in instances if item["sop"] in sent]
    if any(not item.get("series") for item in held):
        return None
    return len({item["series"] for item in held})


def held_view(instances: list[dict[str, Any]], record: dict[str, Any]) -> list[dict[str, Any]]:
    """The study as the receipt counts it: the instances held now and the copies retention deleted after every destination
    had them (Queue.purge_record), each SOP once. Without a purge it is exactly `instances`."""
    local = {item["sop"] for item in instances}
    return instances + [{"sop": sop, "series": series} for sop, series in sorted(record["sops"].items()) if sop not in local]


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


def receipt_confirmed(response: requests.Response, uid: str) -> bool:
    """KIN's 2xx answer to this study's receipt says it stored that state or already held exactly it."""
    try:
        answer = response.json()
    except Exception:
        return False
    return isinstance(answer, dict) and answer.get("studyUid") == uid and answer.get("result") in ("stored", "duplicate")


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
        # The last DICOM receive self-check as (result, monotonic time it ended), or None before the first one.
        self.listener: tuple[str, float] | None = None

    def check_listener(self) -> str:
        """One C-ECHO to the local DICOM listener (DICOM_ECHO_SECONDS at most). Never raises."""
        host, port, called = self.config.listener()
        result = dicom_echo(host, port, called) if host else "no_answer"
        self.listener = (result, time.monotonic())
        return result

    def body(self) -> dict[str, Any]:
        self.seq += 1
        now = time.monotonic()
        last = self.stow.last_stow_at
        observed = self.orthanc.observed
        listener = self.listener
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
            "dicomListener": None if listener is None
            else {"result": listener[0], "ageSeconds": max(0, int(now - listener[1]))},
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
            self.check_listener()   # a failed check is a result too; the beat carries it and still goes out
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
        # What retention deleted, from the queue (not the log ring, which is this run's recent lines): one line, numbers only,
        # last so that fitting the report keeps it, in place of the oldest ring line (KIN takes at most LOG_RING_MAX lines).
        lines = list(LOG_RING)
        try:
            lines = lines[-(LOG_RING_MAX - 1):]
            db = sqlite3.connect(Path(self.config.queue_db).resolve().as_uri() + "?mode=ro", uri=True, timeout=5)
            try:
                totals = retention_totals(db)
            finally:
                db.close()
            days = settings.get("retentionDays") if settings else None
            lines.append(_ring_line({"at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "event": "retention.totals",
                                     **totals, **({"retentionDays": days} if isinstance(days, int) else {})}))
        except Exception as error:
            log("support.queue_unreadable", error=type(error).__name__)
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
            "log": lines,
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

    def __init__(self, settings: SettingsStore, orthanc: Orthanc, orthanc_id: str, instances: list[dict[str, Any]],
                 record: dict[str, Any] | None = None):
        self.settings = settings
        self.orthanc = orthanc
        self.orthanc_id = orthanc_id
        # The facts of copies retention deleted stay facts of the study: a late image alone is routed as the whole study.
        self.purged_modalities = set((record or {}).get("modalities") or [])
        self.source_aes = ({item.get("source_ae", "") for item in instances}
                           | set((record or {}).get("sourceAes") or [])) - {""}
        self.modalities: set[str] | None = None

    def current(self) -> tuple[dict[str, Any], list[str]]:
        settings = self.settings.current
        if self.modalities is None and settings["routes"]:
            self.modalities = self.orthanc.series_modalities(self.orthanc_id) | self.purged_modalities
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
        self.launched_ready_file = self.ready_file
        self.heartbeat: Heartbeat | None = None
        # Retention: the next check (monotonic) and where the last full pass stopped (delivered time, UID).
        self.purge_at = 0.0
        self.purge_after: tuple[float, str] | None = None

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

    # ── retention of delivered copies ──

    def release_settled(self) -> bool:
        """No update swap, probation or rollback is under way for this run, and every release the launcher could start
        instead reads the purge record. Without the launcher (KIN_AGENT_UPDATE_STATE unset) nothing swaps this agent."""
        state_path = os.environ.get("KIN_AGENT_UPDATE_STATE")
        if not state_path:
            return True
        # This start proved itself (its ready file is written), and the image's own agent reads the record.
        if not self.launched_ready_file or self.ready_file is not None:
            return False
        if not keeps_purge_record(os.environ.get("KIN_AGENT_BUILTIN_VERSION")):
            return False
        try:
            state = json.loads(Path(state_path).read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return False
        if not isinstance(state, dict) or "pending" not in state or state["pending"] is not None:
            return False
        running, current, previous = state.get("running"), state.get("current"), state.get("previous")
        mine = os.environ.get("KIN_AGENT_RUN_VERSION") or "builtin"
        # A manual rollback names the other release current before it stops this one.
        if running != mine or current != mine:
            return False
        return previous in (None, "builtin") or keeps_purge_record(previous)

    def retention_period(self) -> float | None:
        """The seconds a delivered copy is kept, when a deletion may run now; None when none may: no period set, the
        settings never known, stopping, or the release not settled."""
        if self.stopping or not self.settings.known:
            return None
        days = self.settings.current.get("retentionDays")
        if days is None or not self.release_settled():
            return None
        return float(days) * DAY_SECONDS

    def purge_delivered(self) -> None:
        """Delete the local copies every destination has once the set period has passed (Queue.retention_due). Never
        raises: a failure keeps the copies, the transfers go on, and the next check tries again."""
        if time.monotonic() < self.purge_at:
            return
        try:
            intents = self.queue.intents()
            keep = self.retention_period()
            if keep is None and not intents:
                return
            self.purge_at = time.monotonic() + RETENTION_CHECK_SECONDS
            for uid in intents:   # a stop or a failure between the record and Orthanc's answer
                self.settle_purge(uid)
            if keep is None:
                return
            due = self.queue.purgeable(time.time() - keep, RETENTION_STUDIES_PER_PASS, self.purge_after)
            # The next check goes on after the last one looked at, so a study skipped every time never holds others back.
            self.purge_after = ((float(due[-1]["delivered_at"]), str(due[-1]["uid"]))
                                if len(due) >= RETENTION_STUDIES_PER_PASS else None)
            for row in due:
                if self.retention_period() is None:
                    return
                self.purge_study(str(row["uid"]))
        except Exception as error:
            log("retention.deferred", error=error_code(error))

    def purge_study(self, uid: str) -> None:
        """Delete one due study's local instances, all of them delivered everywhere, or nothing."""
        try:
            orthanc_id, _detail, instances = self.orthanc.instances(uid, self.queue.orthanc_id(uid))
        except GatewayError as error:
            if str(error) != "local study lookup count=0":
                raise
            self.queue.nothing_to_purge(uid)
            log("study.purged", uid=uid, sops=0, failed=0)
            return
        delivered = self.queue.delivered_sops(uid)
        waiting = [item for item in instances if item["sop"] not in delivered]
        if waiting:
            # An image the change feed has not reported yet, or one a destination lacks: the whole study stays.
            log("study.purge_skipped", uid=uid, pending=len(waiting))
            return
        modalities = self.orthanc.series_modalities(orthanc_id)
        targets = [{"id": item["id"], "sop": item["sop"], "series": str(item.get("series") or "")} for item in instances]
        if not self.may_delete(uid):
            return
        self.queue.begin_purge(uid, orthanc_id, targets, modalities,
                               {item.get("source_ae", "") for item in instances} - {""})
        try:
            for start in range(0, len(targets), RETENTION_DELETE_CHUNK):
                if start and not self.may_delete(uid):
                    break
                self.orthanc.delete_instances([item["id"] for item in targets[start:start + RETENTION_DELETE_CHUNK]])
        finally:
            self.settle_purge(uid)

    def may_delete(self, uid: str) -> bool:
        """The one check right before every delete request: the rule and the period as they are now (the settings, a stop
        or an update may have changed while Orthanc was read or an earlier request ran)."""
        keep = self.retention_period()
        return keep is not None and bool(self.queue.purgeable(time.time() - keep, 1, uid=uid, intended=True))

    def study_record(self, uid: str) -> dict[str, Any]:
        """The purge record of a study about to be sent or routed. A deletion a stop left recorded but not settled is
        settled first, so the study is counted and routed with every copy already gone (raises while Orthanc is down)."""
        if self.queue.purge_orthanc_id(uid) is not None:
            self.settle_purge(uid)
        return self.queue.purge_record(uid)

    def settle_purge(self, uid: str) -> None:
        """Record what an intended deletion removed, by what Orthanc still holds (its answer carries no count)."""
        orthanc_id = self.queue.purge_orthanc_id(uid)
        if orthanc_id is None:
            return
        gone, left = self.queue.settle_purge(uid, self.orthanc.instance_ids(orthanc_id))
        log("study.purged", uid=uid, sops=gone, failed=left)

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
                # Retention deletes only on a receipt KIN stored or already held as is, never on stale or a refusal.
                if response.ok and receipt_confirmed(response, uid):
                    self.queue.confirmed(uid, body["seq"])
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
        record = self.study_record(uid)
        orthanc_id, detail, instances = self.orthanc.instances(uid, str(row["orthanc_id"]))
        routing = StudyRouting(self.settings, self.orthanc, orthanc_id, instances, record)
        if KIN_DESTINATION not in self.decide(row, routing):
            self.queue.not_routed(uid)
            return
        routing.require_kin()
        institution_name = str((detail.get("MainDicomTags") or {}).get("InstitutionName", ""))
        self.cloud.announce(uid, institution_name, routing.require_kin)

        # The receipt counts the study held now plus the copies retention deleted (held_view; without a purge, held now).
        held = held_view(instances, record)
        local_sops = {item["sop"] for item in held}
        successful = self.queue.successes(uid)
        # M counts only SOPs this Gateway holds or deleted after delivery, so 0 <= M <= N holds in every receipt.
        self.queue.announced(uid, len(local_sops), len(successful & local_sops), sent_series(held, successful))
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
            self.queue.add_successes(uid, batch_sops - failures, batch_index, self.cloud.last_stored)
            sent = self.queue.successes(uid)
            self.queue.counts(uid, len(local_sops), len(sent & local_sops), sent_series(held, sent))
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
        latest = held_view(latest, record)
        latest_sops = {item["sop"] for item in latest}
        successful = self.queue.successes(uid)
        missing = latest_sops - successful
        extra = successful - latest_sops
        if extra:
            raise GatewayError(f"successful SOP absent locally count={len(extra)}")
        if missing:
            self.queue.pending_now(uid, len(latest_sops), len(successful & latest_sops), sent_series(latest, successful))
            log("study.delta", uid=uid, pending=len(missing))
            return
        self.queue.complete(uid, len(successful), sent_series(latest, successful))
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
        record = self.study_record(uid)
        orthanc_id, _detail, instances = self.orthanc.instances(uid, self.queue.orthanc_id(uid))
        routing = StudyRouting(self.settings, self.orthanc, orthanc_id, instances, record)
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
                # After both deliveries of this pass, so a clean-up never holds a transfer back for long.
                self.purge_delivered()
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
