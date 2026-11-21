import ast
import dataclasses
import http.server
import io
import json
import os
import re
import socketserver
import sqlite3
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))
import agent as agent_module
from agent import (
    GATEWAY_ERROR_CODES, GATEWAY_ERROR_FALLBACK, Agent, Config, GatewayError, PermanentGatewayError, Queue,
    error_code, failed_sops, multipart, plan_batches,
)

SOURCE = (Path(__file__).resolve().parent / "agent.py").read_text(encoding="utf-8")
REAL_SETTINGS_STORE = agent_module.SettingsStore


class KnownEmptySettings(REAL_SETTINGS_STORE):
    """The tests written before Gateway settings: KIN has answered once that none are set (the known "no rules")."""

    def __init__(self, *args):
        super().__init__(*args)
        self.known = True


_SETTINGS_PATCH = patch.object(agent_module, "SettingsStore", KnownEmptySettings)


def setUpModule():
    _SETTINGS_PATCH.start()


def tearDownModule():
    _SETTINGS_PATCH.stop()
RECEIPT_KEYS = {"studyUid", "phase", "attempt", "successCount", "localCount", "errorCode", "epoch", "seq", "successSeries"}
EPOCH = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")


def config(database: str, **changes) -> Config:
    base = Config(
        orthanc_url="http://local.invalid", orthanc_user="u", orthanc_pass="p",
        kin_base_url="https://cloud.invalid", client_id="c", client_secret="s",
        tls_verify=True, queue_db=database, byte_budget=24 * 1024 * 1024,
        poll_seconds=0.2, http_timeout=1, stow_timeout=1, backoff_base=1, backoff_max=10,
    )
    return dataclasses.replace(base, **changes)


def error_classes(tree: ast.AST) -> set[str]:
    names = {"GatewayError"}
    grew = True
    while grew:
        grew = False
        for node in ast.walk(tree):
            if isinstance(node, ast.ClassDef) and node.name not in names and any(
                    isinstance(base, ast.Name) and base.id in names for base in node.bases):
                names.add(node.name)
                grew = True
    return names


def message_template(call: ast.Call) -> str | None:
    """The literal a GatewayError is built from, each f-string field as {}; None when it is not a literal."""
    if len(call.args) != 1 or call.keywords:
        return None
    argument = call.args[0]
    if isinstance(argument, ast.Constant) and isinstance(argument.value, str):
        return argument.value
    if isinstance(argument, ast.JoinedStr):
        parts = []
        for value in argument.values:
            if isinstance(value, ast.Constant) and isinstance(value.value, str):
                parts.append(value.value)
            elif isinstance(value, ast.FormattedValue):
                parts.append("{}")
            else:
                return None
        return "".join(parts)
    return None


def constructed_errors(source: str) -> list[tuple[int, str | None]]:
    tree = ast.parse(source)
    names = error_classes(tree)
    return [(node.lineno, message_template(node)) for node in ast.walk(tree)
            if isinstance(node, ast.Call) and (
                isinstance(node.func, ast.Name) and node.func.id in names
                or isinstance(node.func, ast.Attribute) and node.func.attr in names)]


class FakeResponse:
    def __init__(self, status: int, body=None):
        self.status_code = status
        self.ok = 200 <= status < 300
        self.body = body

    def json(self):
        if self.body is None:
            raise ValueError("no JSON body")
        return self.body


class FakeOrthanc:
    def __init__(self, sops):
        self.sops = sorted(sops)

    def instances(self, uid, preferred_id):
        return "orthanc-id", {"MainDicomTags": {"InstitutionName": "SYNTHETIC"}}, [
            {"sop": sop, "id": "id-" + sop, "size": 16} for sop in self.sops]

    def copy_file(self, instance_id, sink):
        sink.write(b"0" * 16)
        return 16


class FakeCloud:
    last_stored = frozenset()   # KIN names no stored SOP: these tests never reach retention

    def __init__(self, receipt):
        self.announced, self.stowed, self.answer = [], [], receipt

    def announce(self, uid, institution_name, before_send):
        before_send()
        self.announced.append(uid)

    def stow(self, uid, body, content_type, source_ae, before_send):
        before_send()
        self.stowed.append(uid)
        return set()

    def receipt(self, body):
        return self.answer(body)


class AgentUnitTests(unittest.TestCase):
    def test_stow_preserves_original_source_and_configured_gateway(self):
        cloud = agent_module.Cloud(config("unused", client_id="gw-inst-a"))
        self.addCleanup(cloud.session.close)
        calls = []
        response = FakeResponse(200, {})
        response.content = b"{}"
        cloud.request = lambda *args, **kwargs: calls.append((args, kwargs)) or response
        self.assertEqual(cloud.stow("1.2.3", b"original", "multipart/related", "SCANNER_A"), set())
        headers = calls[0][1]["headers"]
        self.assertEqual([headers["X-Kin-Source-AE"], headers["X-Kin-Gateway"], headers["X-Kin-Institution"]],
                         ["SCANNER_A", "gw-inst-a", "inst-a"])
        self.assertEqual(calls[0][1]["data"], b"original")

    def test_different_sending_devices_get_separate_stow_batches(self):
        instances = [{"sop": str(i), "id": str(i), "size": 16, "source_ae": ae}
                     for i, ae in enumerate(["CT_A", "CT_A", "CT_B", ""])]
        batches = plan_batches(instances, 24 * 1024 * 1024)
        self.assertEqual([len(batch) for batch in batches], [2, 1, 1])
        self.assertEqual([item for batch in batches for item in batch], instances)

    def test_source_ae_comes_from_local_association_metadata(self):
        orthanc = agent_module.Orthanc(config("unused"))
        self.addCleanup(orthanc.session.close)
        orthanc.study = lambda *args: ("study", {})
        answers = {"/studies/study/instances": [{"ID": "one", "FileSize": 16,
                   "MainDicomTags": {"SOPInstanceUID": "1.2.3", "SourceApplicationEntityTitle": "NOT_THE_CALLER"}}],
                   "/instances/one/metadata?expand": {"RemoteAET": "ACTUAL_CALLER", "Origin": "DicomProtocol"}}
        orthanc.request = lambda method, path: FakeResponse(200, answers[path])
        self.assertEqual(orthanc.instances("1.2", "study")[2][0]["source_ae"], "ACTUAL_CALLER")
        # The series is Orthanc's ParentSeries of the instance; an answer without it is an unknown series, never a guess.
        self.assertEqual(orthanc.instances("1.2", "study")[2][0]["series"], "")
        answers["/studies/study/instances"][0]["ParentSeries"] = "orthanc-series-a"
        self.assertEqual(orthanc.instances("1.2", "study")[2][0]["series"], "orthanc-series-a")

    def test_batches_never_exceed_budget(self):
        budget = 24 * 1024 * 1024
        instances = [
            {"sop": str(index), "id": str(index), "size": 1024 * 1024}
            for index in range(30)
        ]
        batches = plan_batches(instances, budget)
        self.assertEqual(sum(map(len, batches)), 30)
        for batch in batches:
            def copy_file(instance_id, sink):
                sink.write(b"0" * 1024 * 1024)
                return 1024 * 1024
            with multipart(batch, copy_file) as (body, _content_type, size):
                self.assertLessEqual(size, budget)
                self.assertEqual(len(body.read()), size)

    def test_failed_sop_sequence_is_exact(self):
        self.assertEqual(failed_sops({
            "00081198": {"vr": "SQ", "Value": [{
                "00081155": {"vr": "UI", "Value": ["1.2.3"]},
            }]},
        }), {"1.2.3"})

    def test_completed_study_reopens_without_forgetting_successes(self):
        with tempfile.TemporaryDirectory() as directory:
            queue = Queue(str(Path(directory) / "queue.db"))
            queue.record_changes([("1.2.3", "orthanc-id")], 10)
            queue.add_successes("1.2.3", {"1.2.3.1"}, 1)
            queue.complete("1.2.3", 1)
            queue.close()

            reopened = Queue(str(Path(directory) / "queue.db"))
            reopened.record_changes([("1.2.3", "orthanc-id")], 11)
            self.assertEqual(reopened.due()["phase"], "pending")
            self.assertEqual(reopened.successes("1.2.3"), {"1.2.3.1"})
            reopened.close()

    def test_large_multiframe_object_is_spooled_and_sent_alone(self):
        size = 30 * 1024 * 1024
        large = {"sop": "1.2.3.1", "id": "one", "size": size}
        small = {"sop": "1.2.3.2", "id": "two", "size": 16}
        self.assertEqual(plan_batches([small, large, small], 24 * 1024 * 1024), [[small], [large], [small]])
        def copy_file(instance_id, sink):
            for _ in range(30): sink.write(b"x" * 1024 * 1024)
            return size
        with multipart([large], copy_file) as (body, content_type, total):
            self.assertGreater(total, size)
            self.assertIn('multipart/related', content_type)
            self.assertIn(b'Content-Type: application/dicom', body.read(100))
            body.seek(-60, 2)
            self.assertTrue(body.read().endswith(b'--\r\n'))

    def test_agent_stops_retrying_a_permanent_failure(self):
        with tempfile.TemporaryDirectory() as directory:
            database = str(Path(directory) / "queue.db")
            config = Config(
                orthanc_url="http://local.invalid", orthanc_user="u", orthanc_pass="p",
                kin_base_url="https://cloud.invalid", client_id="c", client_secret="s",
                tls_verify=True, queue_db=database, byte_budget=24 * 1024 * 1024,
                poll_seconds=0.2, http_timeout=1, stow_timeout=1,
                backoff_base=1, backoff_max=10,
            )
            agent = Agent(config)
            agent.queue.record_changes([("1.2.3", "orthanc-id")], 10)
            agent.poll_changes = lambda: None

            def permanent(_row):
                agent.stopping = True
                raise PermanentGatewayError("single DICOM instance exceeds byte budget")

            agent.process = permanent
            agent.run()

            queue = Queue(database)
            summary = queue.summary()
            self.assertEqual(summary["failed"], 1)
            self.assertEqual(summary["pending"], 0)
            self.assertEqual(summary["rows"][0]["attempt"], 0)
            self.assertIsNone(queue.due())
            queue.close()


class ReceiptErrorCodeTests(unittest.TestCase):
    """S4-U3 contract test 8 (agent side): every GatewayError message has an explicit errorCode."""

    def test_every_gateway_error_literal_is_mapped_and_nothing_else_is(self):
        found = constructed_errors(SOURCE)
        unmapped = [(line, template) for line, template in found if template not in GATEWAY_ERROR_CODES]
        self.assertEqual(unmapped, [], "a GatewayError whose message has no errorCode mapping")
        # Retired errors remain decodable in persistent queue receipts.

    def test_a_new_unmapped_or_non_literal_error_is_caught(self):
        for added in ('raise GatewayError("a new failure nobody mapped")',
                      'raise PermanentGatewayError(f"a new permanent failure {x}")',
                      'raise GatewayError(reason)',
                      'raise GatewayError("a %s" % x)',
                      'error = GatewayError("built, raised later")'):
            with self.subTest(added=added):
                probe = SOURCE + "\n\ndef _probe(x, reason):\n    " + added + "\n"
                self.assertTrue([t for _line, t in constructed_errors(probe) if t not in GATEWAY_ERROR_CODES])

    def test_codes_follow_templates_and_everything_else_is_other(self):
        for template, code in GATEWAY_ERROR_CODES.items():
            message = template.replace("{}", "X9")
            with self.subTest(template=template):
                self.assertEqual(error_code(GatewayError(message)), code)
                self.assertEqual(error_code(PermanentGatewayError(message)), code)
                # One template per sample: the table order can never be what decides a code.
                self.assertEqual(1, sum(1 for pattern, _code in agent_module._ERROR_PATTERNS if pattern.fullmatch(message)))
        self.assertEqual(error_code(GatewayError("local Orthanc ConnectionError")), "local_orthanc_unreachable")
        self.assertEqual(error_code(GatewayError("local Orthanc HTTP 503")), "local_orthanc_http")
        for error in (GatewayError("unheard of"), GatewayError("STOW HTTP 500 extra words"),
                      ValueError("STOW HTTP 500"), KeyError("StudyInstanceUID"), RuntimeError("")):
            with self.subTest(error=repr(error)):
                self.assertEqual(error_code(error), GATEWAY_ERROR_FALLBACK)
        for code in [*GATEWAY_ERROR_CODES.values(), GATEWAY_ERROR_FALLBACK]:
            self.assertRegex(code, r"^[a-z][a-z_]{0,39}$")


class ReceiptQueueTests(unittest.TestCase):
    """S4-U3 queue side: epoch with the database, seq with every receipt field, closed body."""

    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.directory = Path(directory.name)
        self.path = str(self.directory / "queue.db")

    def queue(self, path: str | None = None) -> Queue:
        queue = Queue(path or self.path)
        self.addCleanup(queue.close)
        return queue

    def announced(self, queue: Queue, uid: str = "1.2.3", local: int = 12, success: int = 0) -> None:
        queue.record_changes([(uid, "orthanc-id")], 1)
        queue.phase(uid, "announcing")
        queue.announced(uid, local, success)

    def seq(self, queue: Queue, uid: str = "1.2.3") -> int:
        return int(queue.db.execute("SELECT seq FROM studies WHERE uid=?", (uid,)).fetchone()["seq"])

    def test_epoch_is_born_with_the_queue_and_survives_reopen(self):
        first = self.queue()
        self.assertIsNotNone(EPOCH.fullmatch(first.epoch), first.epoch)
        epoch = first.epoch
        first.close()
        self.assertEqual(self.queue().epoch, epoch)
        self.assertNotEqual(self.queue(str(self.directory / "recreated.db")).epoch, epoch)

    def test_pre_receipt_queue_is_upgraded_in_place_and_owes_nothing(self):
        db = sqlite3.connect(self.path)
        db.executescript("""
          CREATE TABLE studies (
            uid TEXT PRIMARY KEY, orthanc_id TEXT NOT NULL, phase TEXT NOT NULL DEFAULT 'pending',
            batch_index INTEGER NOT NULL DEFAULT 0, successful_sops TEXT NOT NULL DEFAULT '[]',
            attempt INTEGER NOT NULL DEFAULT 0, next_at REAL NOT NULL DEFAULT 0, last_error TEXT,
            updated_at REAL NOT NULL);
          CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
          INSERT INTO studies(uid, orthanc_id, phase, successful_sops, updated_at)
            VALUES ('1.2.3', 'orthanc-id', 'complete', '["1.2.3.1"]', 1);
          INSERT INTO meta(key, value) VALUES ('changes_since', '42');
        """)
        db.commit()
        db.close()
        queue = self.queue()
        self.assertIsNotNone(EPOCH.fullmatch(queue.epoch))
        self.assertEqual(queue.changes_since(), 42)
        self.assertEqual(queue.successes("1.2.3"), {"1.2.3.1"})
        self.assertEqual((queue.summary()["complete"], queue.summary()["pending"]), (1, 0))
        # The pre-receipt agent finished this study; this one never announced it, so nothing is owed or sent.
        self.assertIsNone(queue.receipt("1.2.3"))
        self.assertEqual(queue.unreported(), [])
        epoch = queue.epoch
        queue.close()
        self.assertEqual(self.queue().epoch, epoch)   # a second open neither re-adds columns nor re-mints

    def test_seq_advances_in_the_same_update_as_every_receipt_field(self):
        queue = self.queue()
        queue.record_changes([("1.2.3", "orthanc-id")], 1)
        steps = [
            lambda: queue.phase("1.2.3", "announcing"),
            lambda: queue.announced("1.2.3", 4, 0),
            lambda: queue.phase("1.2.3", "sending", 1),
            lambda: queue.counts("1.2.3", 4, 2),
            lambda: queue.retry("1.2.3", "STOW HTTP 503", 1, 10, "stow_http"),
            lambda: queue.pending_now("1.2.3", 5, 2),
            lambda: queue.complete("1.2.3", 5),
            lambda: queue.record_changes([("1.2.3", "orthanc-id")], 2),
            lambda: queue.fail("1.2.3", "single DICOM instance exceeds byte budget", "instance_exceeds_budget"),
        ]
        seen = [self.seq(queue)]
        for step in steps:
            step()
            seen.append(self.seq(queue))
        self.assertEqual(seen, list(range(seen[0], seen[0] + len(steps) + 1)))
        queue.add_successes("1.2.3", {"1.2.3.9"}, 3)   # not a receipt field
        self.assertEqual(self.seq(queue), seen[-1])
        for phase in ("done", "retry", "failed"):     # refused writes allocate nothing
            with self.assertRaises(ValueError):
                queue.phase("1.2.3", phase)
        self.assertEqual(self.seq(queue), seen[-1])
        # The phase and its seq are one statement: an aborted phase write moves neither.
        queue.db.execute("CREATE TRIGGER refuse_sending BEFORE UPDATE OF phase ON studies "
                         "WHEN NEW.phase='sending' BEGIN SELECT RAISE(ABORT, 'refused'); END")
        before = tuple(queue.db.execute("SELECT phase, seq FROM studies WHERE uid='1.2.3'").fetchone())
        with self.assertRaises(sqlite3.DatabaseError):
            queue.phase("1.2.3", "sending", 4)
        self.assertEqual(tuple(queue.db.execute("SELECT phase, seq FROM studies WHERE uid='1.2.3'").fetchone()), before)

    def test_receipt_exists_only_after_announce_and_is_the_closed_body(self):
        queue = self.queue()
        queue.record_changes([("1.2.3", "orthanc-id")], 1)
        queue.phase("1.2.3", "announcing")
        self.assertIsNone(queue.receipt("1.2.3"))     # KIN would answer 404 before announce
        self.assertEqual(queue.unreported(), [])
        queue.announced("1.2.3", 12, 0)
        body = queue.receipt("1.2.3")
        self.assertEqual(set(body), RECEIPT_KEYS)
        self.assertEqual(body, {"studyUid": "1.2.3", "phase": "announcing", "attempt": 0, "successCount": 0,
                                "localCount": 12, "errorCode": None, "epoch": queue.epoch, "seq": body["seq"],
                                "successSeries": None})
        reason = "STOW HTTP 503 SYNTHETIC^PATIENT free text"
        queue.retry("1.2.3", reason, 1, 10, error_code(GatewayError("STOW HTTP 503")))
        body = queue.receipt("1.2.3")
        self.assertEqual((body["phase"], body["attempt"], body["errorCode"]), ("retry", 1, "stow_http"))
        self.assertNotIn("SYNTHETIC", json.dumps(body))
        self.assertNotIn("free text", json.dumps(body))
        queue.complete("1.2.3", 12)
        body = queue.receipt("1.2.3")
        self.assertEqual((body["phase"], body["attempt"], body["successCount"], body["localCount"], body["errorCode"]),
                         ("complete", 0, 12, 12, None))
        queue.fail("1.2.3", "anything", "Not A Code")  # a stored code is always one of the closed set
        self.assertEqual(queue.receipt("1.2.3")["errorCode"], GATEWAY_ERROR_FALLBACK)
        self.assertEqual(set(queue.receipt("1.2.3")), RECEIPT_KEYS)

    def test_host_clock_jumps_do_not_order_receipts(self):
        """Contract test 7: a host clock a year ahead or behind changes neither seq nor epoch."""
        queue = self.queue()
        self.announced(queue, local=3)
        year, real, seqs = 365 * 24 * 3600, time.time(), []
        for index, offset in enumerate((year, -year, year, -2 * year)):
            with patch.object(agent_module.time, "time", return_value=real + offset):
                queue.counts("1.2.3", 3, index % 4)
                body = queue.receipt("1.2.3")
            seqs.append(body["seq"])
            self.assertEqual(body["epoch"], queue.epoch)
            self.assertEqual(set(body), RECEIPT_KEYS)
        self.assertEqual(seqs, list(range(seqs[0], seqs[0] + 4)))

    def test_reopen_after_complete_is_a_newer_report_never_a_rewrite(self):
        """Contract test 9 (agent side): complete M==N, then a late instance reopens the study."""
        queue = self.queue()
        self.announced(queue, local=3)
        queue.complete("1.2.3", 3)
        done = queue.receipt("1.2.3")
        queue.record_changes([("1.2.3", "orthanc-id")], 2)
        reopened = queue.receipt("1.2.3")
        self.assertEqual((done["phase"], done["successCount"], done["localCount"]), ("complete", 3, 3))
        self.assertGreater(reopened["seq"], done["seq"])
        self.assertEqual(reopened["epoch"], done["epoch"])
        self.assertEqual((reopened["phase"], reopened["successCount"], reopened["localCount"]), ("pending", 3, 3))
        self.assertEqual(queue.unreported(), ["1.2.3"])


class ReceiptDeliveryTests(unittest.TestCase):
    """S4-U3 delivery: final KIN answers are recorded, owed receipts retried, the transfer never touched."""

    def agent(self, **changes) -> Agent:
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        agent = Agent(config(str(Path(directory.name) / "queue.db"), **changes))
        self.addCleanup(agent.queue.close)
        return agent

    def announced(self, agent: Agent, uid: str = "1.2.3") -> None:
        agent.queue.record_changes([(uid, "orthanc-id")], 1)
        agent.queue.phase(uid, "announcing")
        agent.queue.announced(uid, 4, 1)

    def test_final_answers_are_recorded_and_owed_ones_stay_owed(self):
        agent, answers, sent = self.agent(), [], []

        def receipt(body):
            sent.append(json.dumps(body, sort_keys=True))
            answer = answers.pop(0)
            if isinstance(answer, Exception):
                raise answer
            return answer

        agent.cloud.receipt = receipt
        self.announced(agent)
        for answer, final in ((FakeResponse(503), False), (GatewayError("cloud request ConnectTimeout"), False),
                              (FakeResponse(401), False), (FakeResponse(200, {"result": "stored"}), True)):
            answers.append(answer)
            self.assertEqual(agent.report("1.2.3"), final)
            self.assertEqual(agent.queue.unreported(), [] if final else ["1.2.3"])
        self.assertEqual(len(set(sent)), 1, "an owed receipt is resent unchanged")
        agent.flush_receipts()
        self.assertEqual(len(sent), 4, "an answered receipt is not sent again")
        for status, code in ((404, None), (409, "GATEWAY_EPOCH_UNRECOGNISED"), (409, "GATEWAY_RECEIPT_CONFLICT"),
                             (400, None)):
            with self.subTest(status=status, code=code):
                agent.queue.counts("1.2.3", 4, 2)   # a newer state
                answers.append(FakeResponse(status, {"code": code} if code else None))
                self.assertTrue(agent.report("1.2.3"))
                self.assertEqual(agent.queue.unreported(), [], "a refused body is final; it is not retried")
        self.assertEqual(answers, [])

    def test_flush_stops_at_the_first_failure_backs_off_and_resumes(self):
        agent, calls = self.agent(), []
        self.announced(agent, "1.2.3")
        self.announced(agent, "1.2.4")
        agent.cloud.receipt = lambda body: calls.append(body["studyUid"]) or FakeResponse(503)
        agent.flush_receipts()
        self.assertEqual(len(calls), 1)
        self.assertGreater(agent.receipts_resume_at, time.monotonic())
        agent.flush_receipts()
        self.assertEqual(len(calls), 1, "still backing off")
        agent.receipts_resume_at = 0.0
        agent.cloud.receipt = lambda body: calls.append(body["studyUid"]) or FakeResponse(200, {"result": "stored"})
        agent.flush_receipts()
        self.assertEqual(sorted(calls[1:]), ["1.2.3", "1.2.4"])
        self.assertEqual((agent.receipt_failures, agent.queue.unreported()), (0, []))

    def test_a_failing_receipt_never_changes_the_transfer(self):
        for failure in (GatewayError("cloud request ConnectionError"), RuntimeError("boom"), FakeResponse(500)):
            with self.subTest(failure=repr(failure)):
                agent = self.agent()
                agent.orthanc = FakeOrthanc(["1.2.3.1", "1.2.3.2"])

                def receipt(body, failure=failure):
                    if isinstance(failure, Exception):
                        raise failure
                    return failure

                agent.cloud = FakeCloud(receipt)
                agent.queue.record_changes([("1.2.3", "orthanc-id")], 1)
                agent.process(agent.queue.due())
                row = agent.queue.summary()["rows"][0]
                self.assertEqual((row["phase"], row["successfulSops"], row["attempt"]), ("complete", 2, 0))
                self.assertEqual(agent.cloud.stowed, ["1.2.3"])
                body = agent.queue.receipt("1.2.3")
                self.assertEqual((body["phase"], body["successCount"], body["localCount"]), ("complete", 2, 2))
                self.assertEqual(agent.queue.unreported(), ["1.2.3"], "the final state is still owed")

    def test_process_reports_announce_and_each_batch_then_flush_sends_the_final_state(self):
        # A 700-byte budget holds one 16-byte instance per batch, so three instances are three batches.
        agent, sent = self.agent(byte_budget=700), []
        agent.orthanc = FakeOrthanc(["1.2.3.1", "1.2.3.2", "1.2.3.3"])
        agent.cloud = FakeCloud(lambda body: sent.append(dict(body)) or FakeResponse(200, {"result": "stored"}))
        agent.queue.record_changes([("1.2.3", "orthanc-id")], 1)
        agent.process(agent.queue.due())
        self.assertEqual(agent.cloud.stowed, ["1.2.3"] * 3)
        self.assertEqual([(b["phase"], b["successCount"], b["localCount"]) for b in sent],
                         [("announcing", 0, 3), ("sending", 1, 3), ("sending", 2, 3), ("sending", 3, 3)])
        self.assertEqual(agent.queue.unreported(), ["1.2.3"])
        agent.flush_receipts()
        self.assertEqual((sent[-1]["phase"], sent[-1]["successCount"], sent[-1]["localCount"]), ("complete", 3, 3))
        seqs = [b["seq"] for b in sent]
        self.assertEqual(seqs, sorted(set(seqs)))
        self.assertTrue(all(set(b) == RECEIPT_KEYS and b["epoch"] == agent.queue.epoch for b in sent))
        self.assertEqual(agent.queue.unreported(), [])


class SeriesOrthanc(FakeOrthanc):
    """Instances as Orthanc lists them, each with its series (ParentSeries); `series` maps SOP -> series id."""

    def __init__(self, series):
        super().__init__(series)
        self.series = dict(series)

    def instances(self, uid, preferred_id):
        return "orthanc-id", {"MainDicomTags": {"InstitutionName": "SYNTHETIC"}}, [
            {"sop": sop, "id": "id-" + sop, "size": 16, "series": self.series[sop]} for sop in sorted(self.series)]


class SeriesCountTests(unittest.TestCase):
    """The receipt's successSeries: distinct series of the SOPs KIN accepted, counted with successCount in one seq."""

    def agent(self, orthanc, stow) -> tuple[Agent, list]:
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        # A 700-byte budget holds one 16-byte instance per batch, so every SOP is its own batch.
        agent = Agent(config(str(Path(directory.name) / "queue.db"), byte_budget=700))
        self.addCleanup(agent.queue.close)
        sent = []
        agent.orthanc = orthanc
        agent.cloud = FakeCloud(lambda body: sent.append(dict(body)) or FakeResponse(200, {"result": "stored"}))
        agent.cloud.stow = stow
        agent.queue.record_changes([("1.2.3", "orthanc-id")], 1)
        return agent, sent

    def test_sent_series_counts_distinct_series_of_the_given_success_set_only(self):
        held = [{"sop": "a1", "series": "A"}, {"sop": "a2", "series": "A"}, {"sop": "b1", "series": "B"},
                {"sop": "c1", "series": "C"}]
        self.assertEqual(agent_module.sent_series(held, {"a1", "a2", "b1", "c1"}), 3)
        self.assertEqual(agent_module.sent_series(held, {"a1", "a2"}), 1, "one series over two SOPs is one")
        self.assertEqual(agent_module.sent_series(held, set()), 0)
        self.assertEqual(agent_module.sent_series(held, {"a1", "gone"}), 1, "a sent SOP no longer held is not counted")
        unknown = held + [{"sop": "d1", "series": ""}]
        self.assertIsNone(agent_module.sent_series(unknown, {"a1", "d1"}), "a counted SOP without a series: unknown")
        self.assertEqual(agent_module.sent_series(unknown, {"a1", "b1"}), 2, "an unsent SOP's missing series hides nothing")

    def test_a_failed_batch_retry_and_restart_count_each_series_once(self):
        orthanc = SeriesOrthanc({"1.2.3.1": "A", "1.2.3.2": "A", "1.2.3.3": "B", "1.2.3.4": "C"})
        failing = {"1.2.3.3"}

        def stow(uid, body, content_type, source_ae, before_send):
            before_send()
            text = body.read()
            return {sop for sop in failing if sop.encode() in text}

        agent, sent = self.agent(orthanc, stow)
        with patch.object(agent_module, "multipart", side_effect=self.multipart):
            with self.assertRaises(GatewayError):
                agent.process(agent.queue.due())
            agent.queue.retry("1.2.3", "STOW failed SOP count=1", 1, 10, "stow_sop_failed")
            self.assertEqual((agent.queue.receipt("1.2.3")["successCount"], agent.queue.receipt("1.2.3")["successSeries"]),
                             (2, 1), "two SOPs of series A were accepted before the failure")
            failing.clear()
            agent.queue.db.execute("UPDATE studies SET next_at=0")
            agent.process(agent.queue.due())
            agent.flush_receipts()
        final = agent.queue.receipt("1.2.3")
        self.assertEqual((final["phase"], final["successCount"], final["successSeries"]), ("complete", 4, 3))
        self.assertTrue(all(b["successSeries"] is not None and b["successSeries"] <= b["successCount"]
                            and (b["successSeries"] == 0) == (b["successCount"] == 0) for b in sent))
        self.assertEqual(max(b["successSeries"] for b in sent), 3, "a retry never counts a series twice")
        # A late SOP of a new series reopens the study: the new series counts only once KIN accepted it.
        orthanc.series["1.2.3.5"] = "D"
        agent.queue.record_changes([("1.2.3", "orthanc-id")], 2)
        sent.clear()
        with patch.object(agent_module, "multipart", side_effect=self.multipart):
            agent.process(agent.queue.due())
        agent.flush_receipts()
        self.assertEqual([(b["phase"], b["successCount"], b["successSeries"]) for b in sent],
                         [("announcing", 4, 3), ("sending", 5, 4), ("complete", 5, 4)])

    def test_a_receipt_keeps_the_series_of_its_seq_so_a_resend_is_the_same_body(self):
        orthanc = SeriesOrthanc({"1.2.3.1": "A", "1.2.3.2": "B"})
        agent, _sent = self.agent(orthanc, lambda uid, body, ct, ae, before_send: before_send() or set())
        agent.process(agent.queue.due())
        first = agent.queue.receipt("1.2.3")
        agent.queue.retry("1.2.3", "STOW HTTP 503", 1, 10, "stow_http")   # retry and fail never recount
        retry = agent.queue.receipt("1.2.3")
        self.assertEqual((first["successSeries"], retry["successSeries"]), (2, 2))
        self.assertEqual(agent.queue.receipt("1.2.3"), retry, "the same seq is the same body, series included")

    def test_an_installed_receipt_queue_upgrades_to_an_unknown_series_and_resends_the_same_state(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        path = str(Path(directory.name) / "queue.db")
        db = sqlite3.connect(path)
        db.executescript("""
          CREATE TABLE studies (
            uid TEXT PRIMARY KEY, orthanc_id TEXT NOT NULL, phase TEXT NOT NULL DEFAULT 'pending',
            batch_index INTEGER NOT NULL DEFAULT 0, successful_sops TEXT NOT NULL DEFAULT '[]',
            attempt INTEGER NOT NULL DEFAULT 0, next_at REAL NOT NULL DEFAULT 0, last_error TEXT,
            updated_at REAL NOT NULL, seq INTEGER NOT NULL DEFAULT 0, local_count INTEGER,
            success_count INTEGER NOT NULL DEFAULT 0, error_code TEXT, announced INTEGER NOT NULL DEFAULT 0,
            reported_seq INTEGER NOT NULL DEFAULT 0);
          CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
          INSERT INTO studies(uid, orthanc_id, phase, successful_sops, attempt, next_at, updated_at, seq, local_count,
                              success_count, error_code, announced, reported_seq)
            VALUES ('1.2.3', 'orthanc-id', 'retry', '["1.2.3.1"]', 1, 9e12, 1, 5, 3, 1, 'stow_http', 1, 5);
          INSERT INTO meta(key, value) VALUES ('epoch', '0a1b2c3d-0000-4000-8000-00000000000a');
        """)
        db.commit()
        db.close()
        queue = Queue(path)
        self.addCleanup(queue.close)
        body = queue.receipt("1.2.3")
        self.assertEqual(body, {"studyUid": "1.2.3", "phase": "retry", "attempt": 1, "successCount": 1, "localCount": 3,
                                "errorCode": "stow_http", "epoch": "0a1b2c3d-0000-4000-8000-00000000000a", "seq": 5,
                                "successSeries": None})
        self.assertEqual(queue.unreported(), [], "the upgrade allocates no new seq and owes nothing")

    def test_a_series_id_orthanc_does_not_give_is_unknown_and_never_changes_the_transfer(self):
        agent, sent = self.agent(FakeOrthanc(["1.2.3.1", "1.2.3.2"]), lambda uid, body, ct, ae, before_send: before_send() or set())
        agent.process(agent.queue.due())
        agent.flush_receipts()
        self.assertEqual([(b["phase"], b["successCount"], b["successSeries"]) for b in sent][-1], ("complete", 2, None))

    @staticmethod
    def multipart(batch, copy_file, copy_lossless=None):
        """The real multipart with each part's SOP UID in its bytes, so the fake STOW can name a failed SOP."""
        def named(instance_id, sink):   # 16 bytes, the size the fake Orthanc lists
            sink.write(instance_id.removeprefix("id-").encode().ljust(16, b" "))
            return 16
        return REAL_MULTIPART(batch, named, copy_lossless)


REAL_MULTIPART = multipart


UID = "1.2.3"


def duplicate_or_stored(body):
    """KIN's answer when it already holds the retry state and stores everything newer."""
    return FakeResponse(200, {"studyUid": body["studyUid"], "result": "duplicate" if body["phase"] == "retry" else "stored"})


class RetryCloud:
    """The Now Retry poll and the receipt route; queued answers first, then `default`. Records every call."""

    last_stored = frozenset()

    def __init__(self):
        self.polls, self.confirms, self.default = [], [], duplicate_or_stored
        self.poll_epochs, self.sent, self.announced, self.stowed, self.stow_error = [], [], [], [], None

    def retry_requests(self, epoch):
        self.poll_epochs.append(epoch)
        answer = self.polls.pop(0) if self.polls else FakeResponse(200, {"studyUids": []})
        if isinstance(answer, Exception):
            raise answer
        return answer

    def receipt(self, body):
        self.sent.append(dict(body))
        answer = self.confirms.pop(0) if self.confirms else self.default
        answer = answer(body) if callable(answer) else answer
        if isinstance(answer, Exception):
            raise answer
        return answer

    def announce(self, uid, institution_name, before_send):
        before_send()
        self.announced.append(uid)

    def stow(self, uid, body, content_type, source_ae, before_send):
        before_send()
        self.stowed.append(uid)
        if self.stow_error:
            raise self.stow_error()
        return set()


class NoOrthanc:
    """The Now Retry path must never read the hospital Orthanc; any attribute use is recorded."""

    def __init__(self):
        self.touched = []

    def __getattr__(self, name):
        self.touched.append(name)
        raise AssertionError("the retry path touched Orthanc." + name)


class RetryNowTests(unittest.TestCase):
    """S4-U4 Now Retry, agent side: one exact retry state made eligible now; nothing else moves."""

    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.path = str(Path(directory.name) / "queue.db")
        self.events = []
        logging = patch.object(agent_module, "log", side_effect=lambda event, **fields: self.events.append((event, fields)))
        logging.start()
        self.addCleanup(logging.stop)

    def agent(self, cloud: RetryCloud) -> Agent:
        agent = Agent(config(self.path, backoff_base=60, backoff_max=600))
        self.addCleanup(agent.queue.close)
        agent.cloud, agent.orthanc = cloud, NoOrthanc()
        agent.retry_poll_at = 0.0   # the next call polls; test T5 holds the real schedule
        return agent

    def queue(self) -> Queue:
        return self.agent(RetryCloud()).queue

    def in_retry(self, queue: Queue, uid: str = UID) -> float:
        """A study that sent one of its SOPs, failed a batch and is backing off; KIN already holds this state."""
        queue.record_changes([(uid, "orthanc-id")], 1)
        queue.phase(uid, "announcing")
        queue.announced(uid, 4, 1)
        queue.add_successes(uid, {uid + ".1"}, 1)
        queue.phase(uid, "sending", 2)
        _attempt, delay = queue.retry(uid, "STOW HTTP 503 SYNTHETIC^PATIENT free text", 60, 600, "stow_http")
        queue.reported(uid, queue.receipt(uid)["seq"])
        return delay

    def row(self, queue: Queue, uid: str = UID):
        found = queue.db.execute("SELECT * FROM studies WHERE uid=?", (uid,)).fetchone()
        return dict(found) if found else None

    def rows(self, queue: Queue):
        return [dict(row) for row in queue.db.execute("SELECT * FROM studies ORDER BY uid")]

    def deliver(self, agent: Agent, *uids: str) -> None:
        agent.cloud.polls.append(FakeResponse(200, {"studyUids": list(uids)}))
        agent.retry_poll_at = 0.0
        agent.retry_requests()

    def test_t1_retry_now_moves_only_next_at_of_the_exact_retry_state(self):
        queue = self.queue()
        self.in_retry(queue)
        before, body, owed = self.row(queue), queue.receipt(UID), queue.unreported()
        meta = [tuple(row) for row in queue.db.execute("SELECT key, value FROM meta ORDER BY key")]
        now = time.time()
        self.assertGreater(before["next_at"], now)
        self.assertIsNone(queue.due())
        self.assertTrue(queue.waiting(UID, before["seq"], now))
        self.assertTrue(queue.retry_now(UID, before["seq"], now))
        after = self.row(queue)
        self.assertEqual({key for key in before if before[key] != after[key]}, {"next_at"})
        self.assertEqual(after["next_at"], 0)
        # attempt, the free reason, the code, the sent SOPs, the counts, seq and updated_at all stay.
        self.assertEqual((after["attempt"], after["error_code"], after["successful_sops"], after["batch_index"]),
                         (1, "stow_http", '["1.2.3.1"]', 2))
        self.assertIn("SYNTHETIC", after["last_error"])
        self.assertEqual(queue.receipt(UID), body, "nothing new for KIN: the receipt and its seq did not move")
        self.assertEqual(queue.unreported(), owed)
        self.assertEqual([tuple(row) for row in queue.db.execute("SELECT key, value FROM meta ORDER BY key")], meta)
        self.assertEqual(queue.due()["uid"], UID, "eligible now")
        self.assertFalse(queue.waiting(UID, before["seq"], now))
        self.assertFalse(queue.retry_now(UID, before["seq"], now), "a second nudge changes nothing")
        self.assertEqual(self.row(queue), after)

    def test_t2_every_other_state_seq_or_uid_is_refused_byte_identically(self):
        queue = self.queue()
        self.in_retry(queue, "1.2.15")
        for uid, steps in (
            ("1.2.10", [lambda u: queue.fail(u, "single DICOM instance exceeds byte budget", "instance_exceeds_budget")]),
            ("1.2.11", [lambda u: queue.complete(u, 4)]),
            ("1.2.12", []),
            ("1.2.13", [lambda u: queue.phase(u, "announcing")]),
            ("1.2.14", [lambda u: queue.phase(u, "announcing"), lambda u: queue.announced(u, 4, 0),
                        lambda u: queue.phase(u, "sending", 1)]),
        ):
            queue.record_changes([(uid, "orthanc-id")], 1)
            for step in steps:
                step(uid)
        now, before = time.time(), self.rows(queue)
        expected = {"1.2.10": "failed", "1.2.11": "complete", "1.2.12": "pending", "1.2.13": "announcing",
                    "1.2.14": "sending", "1.2.15": "retry"}
        self.assertEqual({row["uid"]: row["phase"] for row in before}, expected)
        seq = {row["uid"]: row["seq"] for row in before}
        refused = [(uid, seq[uid], now) for uid in expected if uid != "1.2.15"]
        refused += [("1.2.15", seq["1.2.15"] - 1, now), ("1.2.15", seq["1.2.15"] + 1, now),
                    ("1.2.15", seq["1.2.15"], now + 3600),   # the backoff is already over at that time
                    ("9.9.9", 1, now), ("9.9.9", 0, now)]
        for uid, value, at in refused:
            with self.subTest(uid=uid, seq=value, at=at - now):
                self.assertFalse(queue.waiting(uid, value, at))
                self.assertFalse(queue.retry_now(uid, value, at))
                self.assertEqual(self.rows(queue), before, "a refused nudge changed or inserted a row")

    def test_t3_only_an_exact_duplicate_of_the_current_body_applies(self):
        cloud = RetryCloud()
        agent = self.agent(cloud)
        self.in_retry(agent.queue)
        seq = agent.queue.receipt(UID)["seq"]
        cases = [
            (FakeResponse(200, {"studyUid": UID, "result": "stored"}), True),     # KIN held an older state
            (FakeResponse(200, {"studyUid": UID, "result": "stale"}), True),      # this queue went back in time
            (FakeResponse(200, {"studyUid": "1.2.4", "result": "duplicate"}), True),
            (FakeResponse(200, {"studyUid": UID, "result": "duplicate", "extra": 1}), True),
            (FakeResponse(200, {"result": "duplicate"}), True),
            (FakeResponse(200, None), True),
            (FakeResponse(200, ["duplicate"]), True),
            (FakeResponse(400, {"code": "GATEWAY_RECEIPT_INVALID"}), True),
            (FakeResponse(404, {"code": "GATEWAY_RECEIPT_STUDY_NOT_FOUND"}), True),
            (FakeResponse(409, {"code": "GATEWAY_EPOCH_UNRECOGNISED"}), True),
            (FakeResponse(409, {"code": "GATEWAY_RECEIPT_CONFLICT"}), True),
            (FakeResponse(401), False),
            (FakeResponse(503, {"studyUid": UID, "result": "duplicate"}), False),
            (GatewayError("cloud request ConnectTimeout"), False),
            (RuntimeError("boom"), False),
        ]
        for answer, final in cases:
            with self.subTest(answer=repr(getattr(answer, "body", answer)), status=getattr(answer, "status_code", None)):
                with agent.queue.db:
                    agent.queue.db.execute("UPDATE studies SET reported_seq=0 WHERE uid=?", (UID,))
                before = self.row(agent.queue)
                cloud.confirms.append(answer)
                self.deliver(agent, UID)
                after = self.row(agent.queue)
                self.assertEqual(after["next_at"], before["next_at"], "applied without an exact duplicate")
                # U3's final-answer bookkeeping: a 2xx or 400/404/409 answered this body; anything else stays owed.
                self.assertEqual({key for key in before if before[key] != after[key]}, {"reported_seq"} if final else set())
                self.assertEqual(after["reported_seq"], seq if final else 0)
        self.assertEqual(len(cloud.sent), len(cases))
        self.assertTrue(all(body == agent.queue.receipt(UID) for body in cloud.sent), "the confirmation is the unchanged U3 body")
        self.deliver(agent, UID)   # the default answer: KIN holds exactly this retry state
        self.assertEqual((self.row(agent.queue)["next_at"], self.row(agent.queue)["seq"]), (0, seq))
        self.assertEqual([fields for event, fields in self.events if event == "study.retry_now"], [{"uid": UID, "attempt": 1}])

    def test_t4_repeat_delivery_and_restart_apply_at_most_once(self):
        cloud = RetryCloud()
        self.in_retry(self.queue())
        # Restart before the nudge: a new process on the same queue (same epoch) applies it once.
        agent = self.agent(cloud)
        self.deliver(agent, UID)
        applied = self.row(agent.queue)
        self.assertEqual((len(cloud.sent), applied["next_at"]), (1, 0))
        # A poll answer lost and asked again, or simply delivered twice more: no POST and no change.
        self.deliver(agent, UID)
        self.deliver(agent, UID)
        self.assertEqual(len(cloud.sent), 1)
        self.assertEqual(self.row(agent.queue), applied)
        # Restart after the nudge: it is durable, the row is eligible, and another delivery still sends nothing.
        agent.queue.close()
        agent = self.agent(cloud)
        self.assertEqual(self.row(agent.queue), applied)
        self.assertEqual(agent.queue.due()["uid"], UID)
        self.deliver(agent, UID)
        self.assertEqual(len(cloud.sent), 1)
        self.assertEqual(cloud.poll_epochs, [agent.queue.epoch] * 4)
        self.assertEqual(len([event for event, _fields in self.events if event == "study.retry_now"]), 1)

    def test_t4_a_failed_manual_attempt_climbs_the_ladder_and_a_stale_redelivery_applies_nothing(self):
        first_delay = self.in_retry(self.queue())
        cloud = RetryCloud()
        agent = self.agent(cloud)
        first = self.row(agent.queue)
        agent.orthanc = FakeOrthanc([UID + ".1", UID + ".2"])
        agent.poll_changes = lambda: None

        def refused_batch():
            agent.stopping = True
            return GatewayError("STOW HTTP 503")

        cloud.stow_error = refused_batch
        cloud.polls.append(FakeResponse(200, {"studyUids": [UID]}))
        with patch.object(Queue, "pending_now") as pending_now:
            agent.run()   # flush, Now Retry (applied), then the real process() of the nudged row fails again
        self.assertFalse(pending_now.called)
        self.assertEqual(cloud.stowed, [UID])
        queue = self.queue()
        second = self.row(queue)
        self.assertEqual((second["phase"], second["attempt"], second["error_code"], second["successful_sops"]),
                         ("retry", first["attempt"] + 1, "stow_http", '["1.2.3.1"]'))
        self.assertGreater(second["seq"], first["seq"])
        [retried] = [fields for event, fields in self.events if event == "study.retry"]
        self.assertEqual(retried["attempt"], 2)
        self.assertGreaterEqual(retried["afterSeconds"], first_delay, "the ladder kept climbing; nothing reset it")
        self.assertGreater(second["next_at"] - time.time(), first_delay - 1)
        queue.close()
        # KIN still (wrongly) delivers the old request: `stored` or `stale` for the current body applies nothing.
        agent = self.agent(cloud)
        for answer in (FakeResponse(200, {"studyUid": UID, "result": "stored"}),
                       FakeResponse(200, {"studyUid": UID, "result": "stale"})):
            cloud.confirms.append(answer)
            self.deliver(agent, UID)
            self.assertEqual(self.row(agent.queue)["next_at"], second["next_at"])
        self.assertEqual(len([event for event, _fields in self.events if event == "study.retry_now"]), 1)

    def test_t5_fixed_slow_poll_first_after_a_full_period_and_nothing_shortens_it(self):
        clock = [1000.0]
        invalid = [FakeResponse(503), FakeResponse(200, None), FakeResponse(200, {"studyUids": UID}),
                   FakeResponse(200, {"studyUids": [1]}), FakeResponse(200, {"studyUids": [UID], "count": 1}),
                   FakeResponse(200, {"studyUids": [UID, UID]}), FakeResponse(200, {"studyUids": ["1.2.x"]}),
                   FakeResponse(200, {"studyUids": ["%d.1" % n for n in range(101)] + [UID]}),
                   FakeResponse(200, [[UID]]), GatewayError("cloud request ConnectionError"), RuntimeError("boom")]
        with patch.object(agent_module.time, "monotonic", lambda: clock[0]):
            cloud = RetryCloud()
            agent = Agent(config(self.path, backoff_base=60, backoff_max=600))
            self.addCleanup(agent.queue.close)
            agent.cloud, agent.orthanc = cloud, NoOrthanc()
            self.in_retry(agent.queue)   # a lax parser would confirm UID from one of the invalid answers
            cloud.polls.extend(invalid)
            polled = []
            for t in range(0, 301, 2):
                clock[0] = 1000.0 + t
                before = len(cloud.poll_epochs)
                agent.retry_requests()   # never raises
                if len(cloud.poll_epochs) > before:
                    polled.append(t)
            self.assertEqual(polled, list(range(30, 301, 30)), "first poll one period after start, then every 30 s")
            self.assertEqual(cloud.sent, [], "no invalid answer reached a confirmation")
            self.assertGreater(self.row(agent.queue)["next_at"], time.time(), "the retry row still waits out its backoff")
            # Owed receipts backing off (F6): the tick passes without a poll and the cadence is not shortened after.
            agent.receipts_resume_at = 1000.0 + 365
            polled = []
            for t in range(302, 421, 2):
                clock[0] = 1000.0 + t
                before = len(cloud.poll_epochs)
                agent.retry_requests()
                if len(cloud.poll_epochs) > before:
                    polled.append(t)
            self.assertEqual(polled, [390, 420])
        self.assertEqual(set(cloud.poll_epochs), {agent.queue.epoch}, "the poll carries only this queue's epoch")
        codes = [event for event, _fields in self.events if event.startswith("retry_request.")]
        self.assertEqual(len(codes), len(invalid))
        self.assertFalse(any("SYNTHETIC" in json.dumps(fields) for _event, fields in self.events))

    def test_t6_retry_path_never_announces_stows_or_reads_orthanc_and_ignores_unknown_uids(self):
        cloud = RetryCloud()
        agent = self.agent(cloud)
        self.in_retry(agent.queue, "1.2.3")
        agent.queue.record_changes([("1.2.5", "orthanc-id")], 2)   # pending, never announced: no receipt
        self.in_retry(agent.queue, "1.2.6")
        agent.queue.fail("1.2.6", "single DICOM instance exceeds byte budget", "instance_exceeds_budget")
        before = self.rows(agent.queue)
        self.deliver(agent, "9.9.9", "1.2.5", "1.2.6", "1.2.3", "1.2.7")
        self.assertEqual([body["studyUid"] for body in cloud.sent], ["1.2.3"])
        self.assertEqual((cloud.announced, cloud.stowed, agent.orthanc.touched), ([], [], []))
        after = self.rows(agent.queue)
        self.assertEqual([row["uid"] for row in after], [row["uid"] for row in before], "no row for an unknown UID")
        changed = [(b["uid"], sorted(k for k in b if b[k] != a[k])) for b, a in zip(before, after) if b != a]
        self.assertEqual(changed, [("1.2.3", ["next_at"])])
        self.assertTrue(all(set(fields) <= {"uid", "attempt", "status", "error"} for _event, fields in self.events))


class OrthancConnectionTests(unittest.TestCase):
    """S4-EG1 X-2: no local Orthanc read goes out on a pooled connection the server may be closing.

    The first hosted EG1 run logged 76 `local Orthanc ConnectionError` retries while Orthanc stayed up. The
    suspected close of an idle socket as it is reused is made certain here instead of timed: the server answers
    only the first request of a connection and drops a connection that brings a second one.
    """

    def test_consecutive_local_reads_each_take_their_own_connection(self):
        changes = {"Changes": [], "Done": True, "Last": 0}
        seen = []   # (connection number, request number on it, path, Connection header), in arrival order
        connections = []

        class OneAnswerPerConnection(http.server.BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"   # keep-alive unless the client asks to close, as Orthanc does
            timeout = 5

            def setup(self):
                super().setup()
                connections.append(self.client_address)
                self.number, self.answered = len(connections), 0

            def do_GET(self):
                asked = self.headers.get("Connection")
                seen.append((self.number, self.answered + 1, self.path, asked))
                if self.answered:
                    self.close_connection = True   # a reused connection is dropped unanswered
                    return
                self.answered = 1
                body = json.dumps(changes).encode("ascii")
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                if (asked or "").lower() == "close":
                    self.send_header("Connection", "close")   # RFC 9112 9.6: close after this response and say so
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *_args):
                pass

        # One thread serves one connection at a time, so arrival order is the order of the reads. TCPServer, not
        # HTTPServer: its bind does a reverse lookup of the address.
        server = socketserver.TCPServer(("127.0.0.1", 0), OneAnswerPerConnection)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()

        def stop():
            server.shutdown()
            server.server_close()
            thread.join(5)

        self.addCleanup(stop)
        orthanc = agent_module.Orthanc(config(
            "unused", orthanc_url="http://127.0.0.1:%d" % server.server_address[1], http_timeout=5))
        # Cleanups run last-in first-out: a socket the client still pools must not hold the server's one thread.
        self.addCleanup(orthanc.session.close)

        outcomes = []
        for _ in range(3):
            try:
                outcomes.append(orthanc.changes(0))
            except GatewayError as error:
                outcomes.append(str(error))   # a reused connection: "local Orthanc ConnectionError", the live text
        self.assertEqual(outcomes, [changes] * 3)
        self.assertEqual(seen, [(number, 1, "/changes?since=0&limit=100", "close") for number in (1, 2, 3)])
        self.assertEqual(len(connections), 3)


HEARTBEAT_KEYS = {"epoch", "bootId", "seq", "version", "uptimeSeconds", "queue", "lastStowAgeSeconds", "localOrthanc",
                  "dicomListener"}


class BeatCloud:
    """Records each heartbeat body; answers from a list (default 200), raising when the answer is an exception."""

    def __init__(self, answers=None, gate: threading.Event | None = None):
        self.bodies, self.answers, self.gate = [], list(answers or []), gate

    def heartbeat(self, body):
        self.bodies.append(json.loads(json.dumps(body)))   # what would go over the wire
        if self.gate is not None:
            self.gate.wait(5)
        answer = self.answers.pop(0) if self.answers else FakeResponse(200, {"result": "stored"})
        if isinstance(answer, Exception):
            raise answer
        return answer


class HeartbeatTests(unittest.TestCase):
    """Operational status: the beat KIN shows in the admin console's Gateway Status."""

    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.path = str(Path(directory.name) / "queue.db")
        self.events = []
        logging = patch.object(agent_module, "log", side_effect=lambda event, **fields: self.events.append((event, fields)))
        logging.start()
        self.addCleanup(logging.stop)

    def agent(self) -> Agent:
        agent = Agent(config(self.path))
        self.addCleanup(agent.queue.close)
        return agent

    def heartbeat(self, agent: Agent, cloud: BeatCloud, started: float | None = None):
        beat = agent_module.Heartbeat(agent.config, agent.queue.epoch, agent.orthanc, agent.cloud,
                                      time.monotonic() if started is None else started)
        self.addCleanup(beat.cloud.session.close)
        self.addCleanup(beat.stop)
        beat.cloud = cloud
        return beat

    def phases(self, queue: Queue, phases: dict[str, str]) -> None:
        for uid, phase in phases.items():
            queue.record_changes([(uid, "orthanc-id")], 1)
            if phase == "complete":
                queue.complete(uid, 1)
            elif phase == "failed":
                queue.fail(uid, "single DICOM instance exceeds byte budget", "instance_exceeds_budget")
            elif phase == "retry":
                queue.retry(uid, "STOW HTTP 503", 60, 600, "stow_http")
            elif phase != "pending":
                queue.phase(uid, phase)

    def test_body_is_closed_counts_by_phase_and_carries_no_time_uid_or_text(self):
        agent = self.agent()
        self.phases(agent.queue, {"1.2.1": "pending", "1.2.2": "announcing", "1.2.3": "sending", "1.2.4": "retry",
                                  "1.2.5": "retry", "1.2.6": "failed", "1.2.7": "complete", "1.2.8": "complete"})
        body = self.heartbeat(agent, BeatCloud(), started=time.monotonic() - 125).body()
        self.assertEqual(set(body), HEARTBEAT_KEYS)
        self.assertEqual(body["epoch"], agent.queue.epoch)
        self.assertTrue(EPOCH.fullmatch(body["bootId"]))
        self.assertEqual(body["seq"], 1)
        self.assertEqual(body["version"], agent_module.AGENT_VERSION)
        self.assertIn(body["uptimeSeconds"], (125, 126))
        self.assertEqual(body["queue"], {"waiting": 3, "retry": 2, "failed": 1}, "complete is never reported")
        self.assertIsNone(body["lastStowAgeSeconds"], "no STOW yet")
        self.assertIsNone(body["localOrthanc"], "no local request yet")
        self.assertIsNone(body["dicomListener"], "no DICOM check yet")
        wire = json.dumps(body)
        for absent in ("1.2.", "SYNTHETIC", "byte budget", "STOW HTTP", "Z\""):
            self.assertNotIn(absent, wire)

    def test_observations_are_ages_of_the_last_stow_and_the_last_local_request(self):
        agent = self.agent()
        beat = self.heartbeat(agent, BeatCloud())
        agent.cloud.last_stow_at = time.monotonic() - 40
        agent.orthanc.observed = (False, time.monotonic() - 3)
        body = beat.body()
        self.assertIn(body["lastStowAgeSeconds"], (40, 41))
        self.assertEqual(body["localOrthanc"]["answered"], False)
        self.assertIn(body["localOrthanc"]["ageSeconds"], (3, 4))
        agent.orthanc.observed = (True, time.monotonic())
        self.assertEqual(beat.body()["localOrthanc"], {"answered": True, "ageSeconds": 0})

    def test_local_requests_record_answered_or_no_answer_and_stow_success_records_its_time(self):
        agent = self.agent()
        with patch.object(agent.orthanc.session, "request", side_effect=agent_module.requests.ConnectionError()):
            with self.assertRaises(GatewayError):
                agent.orthanc.request("GET", "/changes")
        self.assertFalse(agent.orthanc.observed[0])
        with patch.object(agent.orthanc.session, "request", return_value=FakeResponse(404)):
            with self.assertRaises(GatewayError):
                agent.orthanc.request("GET", "/studies/x")
        self.assertTrue(agent.orthanc.observed[0], "any HTTP answer is an answer, also a 404 lookup")
        self.assertIsNone(agent.cloud.last_stow_at)
        with patch.object(agent.cloud, "request", return_value=FakeResponse(503)):
            with self.assertRaises(GatewayError):
                agent.cloud.stow("1.2.3", b"", "multipart/related", "")
        self.assertIsNone(agent.cloud.last_stow_at, "a refused STOW is not a STOW")
        ok = FakeResponse(200, {})
        ok.content = b""
        with patch.object(agent.cloud, "request", return_value=ok):
            agent.cloud.stow("1.2.3", b"", "multipart/related", "")
        self.assertIsNotNone(agent.cloud.last_stow_at)

    def test_unreadable_queue_is_null_never_zero_and_the_beat_still_goes_out(self):
        agent = self.agent()
        cloud = BeatCloud()
        beat = self.heartbeat(agent, cloud)
        with patch.object(agent_module, "queue_counts", side_effect=sqlite3.OperationalError("database is locked")):
            self.assertTrue(beat.beat())
        self.assertIsNone(cloud.bodies[0]["queue"])
        self.assertIn("heartbeat.queue_unreadable", [event for event, _fields in self.events])

    def test_the_beat_never_writes_the_queue(self):
        agent = self.agent()
        self.phases(agent.queue, {"1.2.1": "retry", "1.2.2": "pending"})
        before = [tuple(row) for row in agent.queue.db.execute("SELECT * FROM studies ORDER BY uid")]
        meta = [tuple(row) for row in agent.queue.db.execute("SELECT * FROM meta ORDER BY key")]
        changes = agent.queue.db.total_changes
        beat = self.heartbeat(agent, BeatCloud())
        for _ in range(3):
            self.assertTrue(beat.beat())
        self.assertEqual([tuple(row) for row in agent.queue.db.execute("SELECT * FROM studies ORDER BY uid")], before)
        self.assertEqual([tuple(row) for row in agent.queue.db.execute("SELECT * FROM meta ORDER BY key")], meta)
        self.assertEqual(agent.queue.db.total_changes, changes)
        reader = sqlite3.connect(Path(self.path).resolve().as_uri() + "?mode=ro", uri=True)
        self.addCleanup(reader.close)
        with self.assertRaises(sqlite3.OperationalError):
            reader.execute("DELETE FROM studies")

    def test_a_failed_beat_is_logged_never_raised_and_the_next_one_tries_again(self):
        agent = self.agent()
        cloud = BeatCloud([FakeResponse(503), GatewayError("cloud request ConnectionError"), RuntimeError("boom")])
        beat = self.heartbeat(agent, cloud)
        self.assertEqual([beat.beat(), beat.beat(), beat.beat(), beat.beat()], [False, False, False, True])
        deferred = [fields for event, fields in self.events if event == "heartbeat.deferred"]
        self.assertEqual(deferred, [{"status": 503}, {"error": "cloud_unreachable"}, {"error": "other"}])

    def test_first_beat_goes_out_at_once_on_its_own_thread_and_a_blocked_main_loop_does_not_hold_it(self):
        agent = self.agent()
        cloud = BeatCloud()
        beat = self.heartbeat(agent, cloud)
        with patch.object(agent_module, "HEARTBEAT_SECONDS", 0.05):
            beat.start()
            # The main thread is busy here (a long STOW in production); beats keep going out meanwhile.
            deadline = time.monotonic() + 5
            while len(cloud.bodies) < 3 and time.monotonic() < deadline:
                time.sleep(0.01)
            beat.stop()
        self.assertGreaterEqual(len(cloud.bodies), 3)
        self.assertNotEqual(beat.thread.ident, threading.get_ident())
        self.assertFalse(beat.thread.is_alive(), "stop ends the thread")
        self.assertEqual(len({body["bootId"] for body in cloud.bodies}), 1, "one run id per process run")
        self.assertEqual([body["seq"] for body in cloud.bodies], list(range(1, len(cloud.bodies) + 1)))

    def test_stop_waits_for_a_beat_in_flight_then_no_new_beat_starts(self):
        agent = self.agent()
        gate = threading.Event()
        cloud = BeatCloud(gate=gate)
        beat = self.heartbeat(agent, cloud)
        beat.start()
        deadline = time.monotonic() + 5
        while not cloud.bodies and time.monotonic() < deadline:
            time.sleep(0.01)
        threading.Timer(0.2, gate.set).start()
        beat.stop()
        self.assertFalse(beat.thread.is_alive())
        self.assertEqual(len(cloud.bodies), 1)

    def test_run_starts_the_beat_and_stops_it_when_the_loop_ends(self):
        agent = Agent(config(self.path))
        started = []
        real = agent_module.Heartbeat

        class Recording(real):
            def start(self):
                started.append("start")

            def stop(self, wait=5.0):
                started.append("stop")

        agent.queue.record_changes([("1.2.3", "orthanc-id")], 10)
        agent.poll_changes = lambda: None

        def permanent(_row):
            agent.stopping = True
            raise PermanentGatewayError("single DICOM instance exceeds byte budget")

        agent.process = permanent
        with patch.object(agent_module, "Heartbeat", Recording):
            agent.run()
        self.assertEqual(started, ["start", "stop"])

    def run_once(self, loop=None):
        """One Agent.run over this queue with the heartbeat recorded (not started) and the loop replaced; returns what
        the heartbeat was given and what happened to it."""
        agent = Agent(config(self.path))
        self.addCleanup(agent.queue.close)
        seen = {}
        real = agent_module.Heartbeat

        class Recording(real):
            def __init__(self, cfg, epoch, *rest):
                super().__init__(cfg, epoch, *rest)
                seen.update(epoch=epoch, boot_id=self.boot_id, events=[])

            def start(self):
                seen["events"].append("start")

            def stop(self, wait=5.0):
                seen["events"].append("stop")

        def default_loop():
            agent.stopping = True

        agent.loop = loop or default_loop
        with patch.object(agent_module, "Heartbeat", Recording):
            try:
                agent.run()
            except RuntimeError as error:
                seen["raised"] = str(error)
        return seen

    def test_each_run_has_a_new_run_id_and_the_queue_file_is_not_written(self):
        self.agent()   # the queue file exists before the first run
        def meta():
            db = sqlite3.connect(self.path)
            try:
                return [tuple(row) for row in db.execute("SELECT * FROM meta ORDER BY key")]
            finally:
                db.close()
        before = meta()
        runs = [self.run_once() for _ in range(3)]
        self.assertEqual(len({run["boot_id"] for run in runs}), 3, "a new random id for every run")
        self.assertTrue(all(EPOCH.fullmatch(run["boot_id"]) for run in runs))
        self.assertEqual(len({run["epoch"] for run in runs}), 1, "the same queue file keeps its epoch")
        self.assertEqual(meta(), before, "nothing about runs is kept in the queue")

    def test_a_loop_that_raises_still_stops_the_heartbeat(self):
        def broken():
            raise RuntimeError("SYN loop failure")

        run = self.run_once(broken)
        self.assertEqual((run["events"], run["raised"]), (["start", "stop"], "SYN loop failure"))

    def test_seq_goes_up_with_every_new_body_also_after_a_failed_beat(self):
        agent = self.agent()
        cloud = BeatCloud([FakeResponse(503), GatewayError("cloud request ConnectionError")])
        beat = self.heartbeat(agent, cloud)
        self.assertEqual([beat.beat(), beat.beat(), beat.beat()], [False, False, True])
        self.assertEqual([body["seq"] for body in cloud.bodies], [1, 2, 3], "a failed beat does not give its number back")
        self.assertEqual(len({body["bootId"] for body in cloud.bodies}), 1)

    def test_the_authentication_retry_sends_the_same_body(self):
        agent = self.agent()
        beat = agent_module.Heartbeat(agent.config, agent.queue.epoch, agent.orthanc, agent.cloud, time.monotonic())
        self.addCleanup(beat.cloud.session.close)
        sent = []

        def answer(method, url, **kwargs):
            sent.append(json.loads(json.dumps(kwargs["json"])))
            return FakeResponse(401 if len(sent) == 1 else 200, {"result": "stored"})

        with patch.object(beat.cloud, "token", return_value="SYN-TOKEN"), \
                patch.object(beat.cloud.session, "request", side_effect=answer):
            self.assertTrue(beat.beat())
            self.assertTrue(beat.beat())
        self.assertEqual(len(sent), 3)
        self.assertEqual(sent[0], sent[1], "the 401 retry carries the same run id, seq and body")
        self.assertEqual([body["seq"] for body in sent], [1, 1, 2])

    def test_the_counts_connection_refuses_writes(self):
        agent = self.agent()
        self.phases(agent.queue, {"1.2.1": "retry"})
        opened = []
        connect = sqlite3.connect

        def recording(*args, **kwargs):
            db = connect(*args, **kwargs)
            opened.append(db)
            try:
                db.execute("UPDATE studies SET next_at=0")
                opened.append("wrote")
            except sqlite3.OperationalError as error:
                opened.append(str(error))
            return db

        with patch.object(agent_module.sqlite3, "connect", side_effect=recording):
            counts = agent_module.queue_counts(self.path)
        self.assertEqual(counts, {"waiting": 0, "retry": 1, "failed": 0})
        self.assertEqual(len(opened), 2)
        self.assertIn("readonly", opened[1])

    def test_a_running_agent_has_one_thread_more_the_heartbeat_and_the_beat_builds_no_queue(self):
        agent = Agent(config(self.path))
        cloud = BeatCloud()
        before = set(threading.enumerate())
        extra = []
        real_init = agent_module.Heartbeat.__init__

        def init(beat, *args):
            real_init(beat, *args)
            beat.cloud = cloud

        def loop():
            deadline = time.monotonic() + 5
            while not cloud.bodies and time.monotonic() < deadline:
                time.sleep(0.01)
            extra.extend(t.name for t in set(threading.enumerate()) - before)
            agent.stopping = True

        agent.loop = loop

        def no_queue(*_args, **_kwargs):
            raise AssertionError("the heartbeat built a Queue")

        with patch.object(agent_module.Heartbeat, "__init__", init):
            agent_module_queue = agent_module.Queue
            with patch.object(agent_module, "Queue", side_effect=no_queue):
                agent.run()
        self.assertIs(agent_module.Queue, agent_module_queue)
        # Remote support has a thread of its own too, so neither waits for the other; neither builds a Queue.
        self.assertEqual(sorted(extra), ["heartbeat", "support"])
        self.assertTrue(cloud.bodies, "the beat went out with Queue unavailable")
        self.assertEqual(cloud.bodies[0]["queue"], {"waiting": 0, "retry": 0, "failed": 0})
        self.assertEqual(set(threading.enumerate()) - before, set(), "nothing is left running after run()")


PEER = "11111111-1111-4111-8111-111111111111"
PEER_B = "22222222-2222-4222-8222-222222222222"
NATIVE = "1.2.840.10008.1.2.1"


def settings_answer(routes=(), compression="none", peers=(PEER, PEER_B), revision=1):
    return {"revision": revision, "routes": [dict(route) for route in routes],
            "compression": compression,
            "destinations": [{"id": peer, "name": "SYN PACS " + peer[0], "aet": "SYNPACS" + peer[0], "host": "10.0.0.9",
                              "port": 11112} for peer in peers]}


def rule(modality=None, source=None, *destinations):
    return {"modality": modality, "sourceAe": source, "destinations": list(destinations)}


class RouteOrthanc:
    """A local Orthanc for routing: what is held, what each call asked, and the answers a test chooses."""

    def __init__(self, sops, modalities=("CT",), source_ae="SYN_CT", syntax=NATIVE):
        self.held = {sop: {"sop": sop, "id": "id-" + sop, "size": 16, "source_ae": source_ae, "syntax": syntax}
                     for sop in sops}
        self.modalities, self.calls = set(modalities), []
        self.store_error = None
        self.store_answer = None
        self.refuse_lossless = False
        # Retention: a deletion removes the held instances it names; hooks let a test act at the moment of a call.
        self.delete_error = self.ids_error = None
        self.on_delete = self.on_series = None

    def delete_instances(self, instance_ids):
        self.calls.append(("delete", tuple(instance_ids)))
        if self.delete_error is not None:
            raise self.delete_error
        if self.on_delete:
            self.on_delete()
        for sop in [sop for sop, item in self.held.items() if item["id"] in instance_ids]:
            del self.held[sop]

    def instance_ids(self, orthanc_id):
        self.calls.append("ids")
        if self.ids_error is not None:
            error, self.ids_error = self.ids_error, None
            raise error
        return {item["id"] for item in self.held.values()}

    def instances(self, uid, preferred_id):
        self.calls.append("instances")
        if not self.held:
            raise GatewayError("local study lookup count=0")
        return "orthanc-id", {"MainDicomTags": {"InstitutionName": "SYNTHETIC"}}, [
            dict(self.held[sop]) for sop in sorted(self.held)]

    def series_modalities(self, orthanc_id):
        self.calls.append("series")
        if self.on_series:
            self.on_series()
        return set(self.modalities)

    def copy_file(self, instance_id, sink):
        self.calls.append(("copy", instance_id))
        sink.write(b"0" * 16)
        return 16

    def copy_lossless(self, instance_id, sink):
        self.calls.append(("lossless", instance_id))
        if self.refuse_lossless:
            return None
        sink.write(b"1" * 8)
        return 8

    def put_modality(self, name, peer):
        self.calls.append(("modality", name))

    def store(self, name, instance_ids, timeout):
        self.calls.append(("store", name, tuple(instance_ids)))
        if self.store_error is not None:
            raise self.store_error
        return self.store_answer or {"FailedInstancesCount": 0, "InstancesCount": len(instance_ids)}


class RouteCloud:
    """KIN records the announce, STOW body and receipts of each delivery."""

    def __init__(self):
        self.announced, self.stowed, self.receipts = [], [], []
        self.bodies = []
        # What KIN names as stored (00081199) in a STOW answer: `names` (a test may point it at the held SOPs).
        self.names, self.last_stored = (), set()
        self.answer = lambda body: FakeResponse(200, {"studyUid": body["studyUid"], "result": "stored"})

    def announce(self, uid, institution_name, before_send):
        before_send()
        self.announced.append(uid)

    def stow(self, uid, body, content_type, source_ae, before_send):
        before_send()
        self.stowed.append(uid)
        self.bodies.append(body.read())
        self.last_stored = set(self.names)
        return set()

    def receipt(self, body):
        self.receipts.append(body)
        return self.answer(body)


class LogLineTests(unittest.TestCase):
    def test_lines_written_at_once_from_two_threads_stay_whole(self):
        """The main loop and the heartbeat thread log at the same moments (an outage); every line stays one object."""
        import io

        class Slow(io.StringIO):
            def write(self, text):   # a stream that is slow and yields inside a write, as a pipe under load does
                time.sleep(0.0002)
                return super().write(text)

        sink = Slow()
        with patch.object(agent_module.sys, "stdout", sink):
            start = threading.Barrier(4)

            def burst(name):
                start.wait()
                for index in range(300):
                    agent_module.log(name, uid="1.2.3", attempt=index)
            threads = [threading.Thread(target=burst, args=("thread.%d" % n,)) for n in range(4)]
            for thread in threads:
                thread.start()
            for thread in threads:
                thread.join()
        lines = sink.getvalue().split("\n")
        self.assertEqual(lines[-1], "")
        self.assertEqual(len(lines) - 1, 1200)
        for line in lines[:-1]:
            self.assertIsInstance(json.loads(line), dict)


class RoutingTests(unittest.TestCase):
    """Gateway settings: routing to destinations, lossless compression."""

    UID = "1.2.840.99.7"

    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.path = str(Path(directory.name) / "queue.db")
        self.events = []
        logging = patch.object(agent_module, "log", side_effect=lambda event, **fields: self.events.append((event, fields)))
        logging.start()
        self.addCleanup(logging.stop)

    def agent(self, answer=None, sops=("1.2.840.99.7.1", "1.2.840.99.7.2"), **orthanc) -> Agent:
        agent = Agent(config(self.path, client_id="gw-syn"))
        self.addCleanup(agent.queue.close)
        agent.orthanc = RouteOrthanc(sops, **orthanc)
        agent.cloud = RouteCloud()
        if answer is not None:
            self.assertTrue(agent.settings.accept(answer))
        agent.queue.record_changes([(self.UID, "orthanc-id")], 1)
        return agent

    def kin(self, agent):
        row = agent.queue.due()
        self.assertIsNotNone(row)
        agent.process(row)

    def forward(self, agent):
        row = agent.queue.forward_due()
        self.assertIsNotNone(row)
        try:
            agent.process_forward(row)
        except (GatewayError, agent_module.ForwardError) as error:
            agent.queue.forward_retry(str(row["uid"]), str(row["dest"]), str(error), 1, 10)

    def forward_row(self, agent, dest=PEER):
        return agent.queue.db.execute("SELECT * FROM forwards WHERE uid=? AND dest=?", (self.UID, dest)).fetchone()

    def study_row(self, agent):
        return agent.queue.db.execute("SELECT * FROM studies WHERE uid=?", (self.UID,)).fetchone()

    # ── settings ──

    def test_settings_shape_is_closed_and_every_destination_is_kin_or_a_listed_peer(self):
        good = settings_answer([rule("CT", None, "kin", PEER)], compression="lossless")
        self.assertEqual(agent_module.parse_settings(good)["routes"][0]["destinations"], ["kin", PEER])
        bad = [
            dict(good, extra=1),
            settings_answer([rule("CT", None)]),                      # no destination
            settings_answer([rule("CT", None, "kin", "kin")]),        # the same destination twice
            settings_answer([rule("CT", None, "33333333-3333-4333-8333-333333333333")]),   # not a listed peer
            settings_answer([rule("ct", None, "kin")]),               # modality is a code
            settings_answer(compression="jpeg"), dict(good, revision=-1), None, [],
        ]
        for payload in bad:
            with self.subTest(payload=payload):
                self.assertIsNone(agent_module.parse_settings(payload))

    def test_unknown_settings_send_nothing_and_no_rules_known_is_the_old_path(self):
        with patch.object(agent_module, "SettingsStore", REAL_SETTINGS_STORE):
            agent = self.agent()
            self.assertFalse(agent.settings.known)
            agent.poll_changes = lambda: None
            agent.flush_receipts = agent.retry_requests = lambda: None
            with patch.object(agent_module.time, "sleep", side_effect=lambda _s: setattr(agent, "stopping", True)):
                agent.loop()
            self.assertEqual((agent.cloud.announced, agent.cloud.stowed, agent.orthanc.calls), ([], [], []))
            self.assertEqual(agent.queue.due()["phase"], "pending", "the study waits, it is not lost")
            self.assertTrue(agent.settings.accept(settings_answer()))
            agent.stopping = False
            with patch.object(agent_module.time, "sleep", side_effect=lambda _s: setattr(agent, "stopping", True)):
                agent.loop()
        self.assertEqual(agent.cloud.stowed, [self.UID])
        # No routes: nothing about routing is read or written; the calls are the ones before routing.
        self.assertEqual(agent.orthanc.calls, ["instances", ("copy", "id-1.2.840.99.7.1"), ("copy", "id-1.2.840.99.7.2"),
                                               "instances"])
        self.assertEqual(agent.cloud.announced, [self.UID])
        self.assertEqual(json.loads(self.study_row(agent)["destinations"]), ["kin"], "KIN, decided before the announce")
        self.assertEqual(agent.queue.db.execute("SELECT count(*) FROM forwards").fetchone()[0], 0)
        self.assertNotIn("study.routed", [event for event, _fields in self.events])
        self.assertNotIn("compressed", json.dumps([fields for event, fields in self.events if event == "batch.stored"]))

    def test_settings_and_queue_bind_to_the_same_normalized_address(self):
        first = self.agent(settings_answer([rule("CT", None, PEER)]))
        first.queue.close()
        restarted = Agent(config(self.path, client_id="gw-syn", kin_base_url="HTTPS://CLOUD.INVALID:443/"))
        self.addCleanup(restarted.queue.close)
        self.assertIsNone(restarted.identity_error)
        self.assertTrue(restarted.settings.known)
        self.assertEqual(restarted.settings.current["routes"], [rule("CT", None, PEER)])
        self.assertFalse(restarted.settings.accept({"revision": 2}))
        self.assertEqual(restarted.settings.current["revision"], 1)

    def test_the_heartbeat_thread_reads_settings_and_a_bad_or_failed_read_keeps_the_last_good(self):
        agent = Agent(config(self.path, client_id="gw-syn"))
        self.addCleanup(agent.queue.close)
        beat = agent_module.Heartbeat(agent.config, agent.queue.epoch, agent.orthanc, agent.cloud, time.monotonic(),
                                      agent.settings)
        self.addCleanup(beat.cloud.session.close)
        answers = [FakeResponse(200, settings_answer(revision=3)), FakeResponse(200, {"revision": 9}), FakeResponse(503)]

        class SettingsCloud:
            def settings(self):
                return answers.pop(0)

        beat.cloud = SettingsCloud()
        self.assertEqual([beat.refresh_settings(), beat.refresh_settings(), beat.refresh_settings()], [True, False, False])
        self.assertEqual(agent.settings.current["revision"], 3)
        self.assertEqual([event for event, _fields in self.events if event.startswith("settings.")],
                         ["settings.invalid", "settings.deferred"])

    # ── routing ──

    def test_route_for_every_matching_rule_by_modality_and_sending_device_or_kin(self):
        routes = [rule("MG", None, PEER), rule("CT", "SYN_CT", "kin", PEER_B), rule(None, "SYN_US", PEER_B)]
        self.assertEqual(agent_module.route_for(routes, {"MG"}, {"X"}), [PEER])
        self.assertEqual(agent_module.route_for(routes, {"CT", "SR"}, {"SYN_CT"}), ["kin", PEER_B])
        self.assertEqual(agent_module.route_for(routes, {"CT"}, {"OTHER"}), ["kin"], "both conditions must hold")
        self.assertEqual(agent_module.route_for(routes, {"US"}, {"SYN_US", "SYN_CT"}), [PEER_B], "any instance's device")
        self.assertEqual(agent_module.route_for(routes, {"XA"}, set()), ["kin"], "no rule holds -> KIN")
        # One study can hold for several rules (CT and MG series, two devices): every destination of each, none dropped,
        # whatever the order of the rules.
        mixed = agent_module.route_for(routes, {"CT", "MG"}, {"SYN_CT", "SYN_US"})
        self.assertEqual(sorted(mixed), sorted(["kin", PEER, PEER_B]))
        self.assertEqual(sorted(agent_module.route_for(list(reversed(routes)), {"CT", "MG"}, {"SYN_CT", "SYN_US"})),
                         sorted(mixed))
        self.assertEqual(agent_module.route_for([rule("CT", None, "kin"), rule("SR", None, PEER)], {"CT", "SR"}, set()),
                         ["kin", PEER])

    def test_two_destinations_keep_their_own_success_and_a_dead_one_holds_back_nothing_else(self):
        agent = self.agent(settings_answer([rule("CT", None, "kin", PEER)]))
        self.kin(agent)
        self.assertEqual(self.study_row(agent)["phase"], "complete")
        self.assertEqual(json.loads(self.study_row(agent)["destinations"]), ["kin", PEER])
        agent.orthanc.store_error = GatewayError("forward C-STORE HTTP 500")
        self.forward(agent)
        row = self.forward_row(agent)
        self.assertEqual((row["phase"], json.loads(row["successful_sops"]), row["attempt"]), ("retry", [], 1))
        self.assertEqual(agent.queue.successes(self.UID), set(agent.orthanc.held), "KIN's own success is untouched")
        original = {self.UID + ".1", self.UID + ".2"}
        self.assertEqual(set(agent.orthanc.held), original)
        agent.orthanc.store_error = None
        agent.queue.db.execute("UPDATE forwards SET next_at=0")
        self.forward(agent)
        self.assertEqual(self.forward_row(agent)["phase"], "complete")
        self.assertEqual(json.loads(self.forward_row(agent)["successful_sops"]), sorted(agent.orthanc.held))
        self.assertEqual(set(agent.orthanc.held), original, "every local SOP remains after both deliveries")
        self.assertIn(("modality", "kin-route-" + PEER), agent.orthanc.calls)
        self.assertEqual(agent.cloud.stowed, [self.UID], "the peer's delivery sent nothing more to KIN")

    def test_a_peer_success_is_never_counted_as_a_kin_series_and_the_copies_stay(self):
        agent = self.agent(settings_answer([rule("CT", None, "kin", PEER)]))
        for index, sop in enumerate(sorted(agent.orthanc.held)):
            agent.orthanc.held[sop]["series"] = "series-%d" % index
        original = set(agent.orthanc.held)

        def refused(*args):
            args[-1]()
            raise GatewayError("STOW HTTP 503")

        agent.cloud.stow = refused
        with self.assertRaises(GatewayError):
            self.kin(agent)
        agent.queue.retry(self.UID, "STOW HTTP 503", 1, 10, "stow_http")
        self.forward(agent)
        self.assertEqual(self.forward_row(agent)["phase"], "complete")
        receipt = agent.queue.receipt(self.UID)
        self.assertEqual((receipt["phase"], receipt["successCount"], receipt["successSeries"]), ("retry", 0, 0),
                         "the peer holding both series is not KIN holding them")
        self.assertEqual(set(agent.orthanc.held), original, "KIN is still owed, so every local copy stays")
        agent.cloud.stow = RouteCloud().stow
        agent.queue.db.execute("UPDATE studies SET next_at=0")
        self.kin(agent)
        receipt = agent.queue.receipt(self.UID)
        self.assertEqual((receipt["phase"], receipt["successCount"], receipt["successSeries"]), ("complete", 2, 2))

    def test_a_partial_store_answer_is_not_success(self):
        agent = self.agent(settings_answer([rule("CT", None, "kin", PEER)]))
        self.kin(agent)
        for answer in ({"FailedInstancesCount": 1, "InstancesCount": 2}, {"FailedInstancesCount": 0, "InstancesCount": 1},
                       {"InstancesCount": 2}):
            with self.subTest(answer=answer):
                agent.orthanc.store_answer = answer
                agent.queue.db.execute("UPDATE forwards SET next_at=0")
                self.forward(agent)
                self.assertEqual((self.forward_row(agent)["phase"], self.forward_row(agent)["successful_sops"]),
                                 ("retry", "[]"))

    def test_a_peer_only_study_never_reaches_kin(self):
        agent = self.agent(settings_answer([rule("CT", None, PEER)]))
        self.kin(agent)
        self.assertEqual(self.study_row(agent)["phase"], "not_routed")
        self.assertIsNone(agent.queue.due())
        self.forward(agent)
        self.assertEqual(self.forward_row(agent)["phase"], "complete")
        self.assertEqual((agent.cloud.announced, agent.cloud.stowed, agent.cloud.receipts), ([], [], []))
        self.assertIsNone(agent.queue.receipt(self.UID))
        self.assertEqual(agent_module.queue_counts(self.path), {"waiting": 0, "retry": 0, "failed": 0})

    def test_destinations_are_decided_once_and_kept_through_late_instances_and_rule_changes(self):
        agent = self.agent(settings_answer([rule("CT", None, "kin", PEER)]))
        self.kin(agent)
        agent.settings.accept(settings_answer([rule("CT", None, PEER_B)], revision=2))
        agent.orthanc.held["1.2.840.99.7.3"] = dict(agent.orthanc.held["1.2.840.99.7.1"], sop="1.2.840.99.7.3",
                                                    id="id-1.2.840.99.7.3")
        agent.queue.record_changes([(self.UID, "orthanc-id")], 2)
        with self.assertRaisesRegex(GatewayError, "KIN destination no longer allowed"):
            self.kin(agent)
        self.forward(agent)
        self.assertEqual(json.loads(self.study_row(agent)["destinations"]), ["kin", PEER])
        self.assertEqual(agent.cloud.stowed, [self.UID])
        self.assertEqual(agent.cloud.announced, [self.UID])
        self.assertEqual((self.forward_row(agent)["phase"], self.forward_row(agent)["successful_sops"]), ("retry", "[]"))
        self.assertFalse(any(c[0] == "store" for c in agent.orthanc.calls))
        self.assertIsNone(self.forward_row(agent, PEER_B))
        self.assertEqual(len(agent.orthanc.held), 3)

    def test_a_row_kin_already_knows_never_switches_to_a_new_destination(self):
        agent = self.agent(settings_answer())
        agent.cloud.announce = lambda *_: (_ for _ in ()).throw(GatewayError("cloud request ReadTimeout"))
        with self.assertRaises(GatewayError):
            self.kin(agent)
        self.assertEqual(json.loads(self.study_row(agent)["destinations"]), ["kin"])
        agent.settings.accept(settings_answer([rule("CT", None, PEER)], revision=2))
        with self.assertRaisesRegex(GatewayError, "KIN destination no longer allowed"):
            self.kin(agent)
        self.assertEqual(agent.cloud.stowed, [])
        self.assertIsNone(self.forward_row(agent))
        self.assertEqual(len(agent.orthanc.held), 2)

    def test_removed_changed_or_unlisted_peer_receives_nothing_on_retry(self):
        agent = self.agent(settings_answer([rule("CT", None, "kin", PEER)]))
        self.kin(agent)
        for change in ("removed", "unrouted", "no matching rule", "new registration", "aet", "host", "port", "unknown address"):
            with self.subTest(change=change):
                answer = settings_answer([rule("CT", None, PEER)], revision=2)
                if change == "removed":
                    answer.update(routes=[], destinations=[])
                elif change == "unrouted":
                    answer["routes"] = []
                elif change == "no matching rule":
                    answer["routes"] = [rule("MR", None, PEER)]
                elif change == "new registration":
                    answer["routes"] = [rule("CT", None, PEER_B)]
                    answer["destinations"] = [dict(answer["destinations"][0], id=PEER_B)]
                elif change == "unknown address":
                    agent.queue.db.execute("UPDATE forwards SET peer=NULL")
                else:
                    answer["destinations"][0][change] = {"aet": "NEWAE", "host": "other.invalid", "port": 104}[change]
                self.assertTrue(agent.settings.accept(answer))
                agent.queue.db.execute("UPDATE forwards SET next_at=0")
                self.forward(agent)
                row = self.forward_row(agent)
                self.assertEqual((row["phase"], row["successful_sops"]), ("retry", "[]"))
                self.assertFalse(any(c[0] in ("modality", "store") for c in agent.orthanc.calls))
                self.assertIsNone(self.forward_row(agent, PEER_B))
                self.assertEqual(len(agent.orthanc.held), 2)

    def test_a_stow_authentication_retry_observes_a_rule_withdrawn_during_token_renewal(self):
        agent = self.agent(settings_answer([rule("CT", None, "kin", PEER)]))
        agent.cloud = agent_module.Cloud(agent.config)
        self.addCleanup(agent.cloud.session.close)
        sent = []

        def token(force=False):
            if force:
                agent.settings.accept(settings_answer([rule("CT", None, PEER)], revision=2))
            return "synthetic"

        def request(method, url, **kwargs):
            if "/dicom-web/" in url:
                sent.append(url)
                return FakeResponse(401)
            return FakeResponse(200, {"result": "stored"})

        with patch.object(agent.cloud, "token", side_effect=token), patch.object(agent.cloud.session, "request", side_effect=request):
            with self.assertRaisesRegex(GatewayError, "KIN destination no longer allowed"):
                self.kin(agent)
        self.assertEqual(len(sent), 1, "the refused batch is never replayed under the withdrawn rule")
        self.assertEqual(agent.queue.successes(self.UID), set())
        self.assertEqual(len(agent.orthanc.held), 2)

    def test_withdrawn_peer_gets_no_further_batch_in_a_multi_batch_delivery(self):
        agent = self.agent(settings_answer([rule("CT", None, PEER)]))
        self.kin(agent)
        agent.orthanc.held[self.UID + ".2"]["source_ae"] = "SYN_MR"
        store = agent.orthanc.store

        def first_batch(*args):
            answer = store(*args)
            agent.settings.accept(settings_answer([], revision=2))
            return answer

        agent.orthanc.store = first_batch
        self.forward(agent)
        self.assertEqual(len([call for call in agent.orthanc.calls if call[0] == "store"]), 1)
        self.assertEqual(self.forward_row(agent)["phase"], "retry")
        self.assertEqual(agent.queue.forward_successes(self.UID, PEER), {self.UID + ".1"})
        self.assertEqual(len(agent.orthanc.held), 2)

    def test_the_peer_is_registered_as_a_destination_with_no_right_to_send_here(self):
        orthanc = agent_module.Orthanc(config("unused"))
        self.addCleanup(orthanc.session.close)
        sent = []
        orthanc.request = lambda method, path, **kwargs: sent.append((method, path, kwargs)) or FakeResponse(200, {})
        orthanc.put_modality("kin-route-x", {"aet": "SYNPACS", "host": "10.0.0.9", "port": 104})
        method, path, kwargs = sent[0]
        self.assertEqual((method, path), ("PUT", "/modalities/kin-route-x"))
        body = kwargs["json"]
        self.assertEqual((body["AET"], body["Host"], body["Port"]), ("SYNPACS", "10.0.0.9", 104))
        self.assertTrue(all(body[key] is False for key in ("AllowEcho", "AllowFind", "AllowFindWorklist", "AllowGet",
                                                           "AllowMove", "AllowStore", "AllowStorageCommitment")))

    def assert_blocked(self, cfg, expected):
        with patch.object(agent_module, "SettingsStore", REAL_SETTINGS_STORE):
            agent = Agent(cfg)
        with (patch.object(agent_module, "Heartbeat") as beat, patch.object(agent, "loop") as loop,
              patch.object(agent_module.time, "sleep", side_effect=lambda _: agent.stop())):
            before = len(self.events)
            agent.run()
            self.assertEqual(self.events[before:], [("agent.identity_blocked", {"error": expected})])
            beat.assert_not_called()
            loop.assert_not_called()
        with patch.object(agent_module.sys, "stdout", new_callable=io.StringIO) as out:
            agent_module.status(cfg.queue_db)
        return json.loads(out.getvalue())

    def test_pre_routing_queue_binds_on_start_and_sends_pending_study_to_kin(self):
        epoch = "11111111-1111-4111-8111-111111111111"
        completed = "1.2.840.99.6"
        db = sqlite3.connect(self.path)
        with db:
            db.executescript("""
                CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
                CREATE TABLE studies (
                    uid TEXT PRIMARY KEY, orthanc_id TEXT NOT NULL, phase TEXT NOT NULL DEFAULT 'pending',
                    batch_index INTEGER NOT NULL DEFAULT 0, successful_sops TEXT NOT NULL DEFAULT '[]',
                    attempt INTEGER NOT NULL DEFAULT 0, next_at REAL NOT NULL DEFAULT 0, last_error TEXT,
                    updated_at REAL NOT NULL, seq INTEGER NOT NULL DEFAULT 0, local_count INTEGER,
                    success_count INTEGER NOT NULL DEFAULT 0, error_code TEXT, announced INTEGER NOT NULL DEFAULT 0,
                    reported_seq INTEGER NOT NULL DEFAULT 0);
            """)
            db.executemany("INSERT INTO meta VALUES (?, ?)", [("epoch", epoch), ("changes_since", "5")])
            db.execute("""INSERT INTO studies(uid, orthanc_id, phase, updated_at, seq, announced,
                          local_count, success_count, successful_sops) VALUES (?, 'old-id', 'complete', 1, 7, 1, 1, 1, ?)""",
                       (completed, json.dumps([completed + ".1"])))
            db.execute("INSERT INTO studies(uid, orthanc_id, updated_at) VALUES (?, 'pending-id', 2)", (self.UID,))
        db.close()

        cfg = config(self.path)
        agent = Agent(cfg)
        self.addCleanup(agent.queue.close)
        self.assertIsNone(agent.identity_error)
        self.assertTrue(agent.settings.accept(settings_answer()))
        agent.cloud = RouteCloud()
        agent.orthanc = FakeOrthanc([self.UID + ".1"])
        with (patch.object(agent.orthanc, "changes", create=True, return_value={"Done": True}) as changes,
              patch.object(agent_module, "Heartbeat") as heartbeat, patch.object(agent_module.signal, "signal"),
              patch.object(agent_module.time, "sleep", side_effect=agent.stop)):
            agent.run()
        heartbeat.return_value.start.assert_called_once()
        changes.assert_called_once_with(5)
        self.assertEqual((agent.cloud.announced, agent.cloud.stowed), ([self.UID], [self.UID]))
        self.assertIn((completed, epoch, 7), [(r["studyUid"], r["epoch"], r["seq"]) for r in agent.cloud.receipts])

        queue = Queue(self.path)
        self.addCleanup(queue.close)
        owner = queue.db.execute("SELECT value FROM meta WHERE key='owner'").fetchone()
        self.assertEqual(json.loads(owner["value"]), {"client": cfg.client_id, "base": cfg.kin_base_url})
        self.assertEqual(queue.summary()["complete"], 2)
        self.assertEqual(queue.successes(completed), {completed + ".1"})

    def test_queue_owner_mismatch_blocks_all_outbound_work_before_start(self):
        agent = self.agent(settings_answer([rule("CT", None, "kin", PEER)]))
        self.kin(agent)
        agent.queue.record_changes([(self.UID, "orthanc-id")], 2)
        original = agent.queue.summary()["rows"]
        agent.queue.close()
        Path(self.path).with_name("settings.json").unlink()
        for cfg in (config(self.path, client_id="gw-other"), config(self.path, client_id="gw-syn", kin_base_url="https://other.invalid"),
                    config(self.path, client_id="gw-syn", kin_base_url="https://cloud.invalid/site")):
            with self.subTest(cfg=cfg):
                status = self.assert_blocked(cfg, "queue_identity_mismatch")
                self.assertEqual(status["identityError"], "queue_identity_mismatch")
                self.assertEqual(status["rows"], original)
        restored = Agent(config(self.path, client_id="gw-syn"))
        self.addCleanup(restored.queue.close)
        self.assertIsNone(restored.queue.summary()["identityError"])

    def test_foreign_settings_alone_block_a_new_queue_and_preserve_the_saved_copy(self):
        first = self.agent(settings_answer([rule("CT", None, PEER)]))
        first.queue.close()
        path = Path(self.path).with_name("settings.json")
        saved = path.read_bytes()
        for cfg in (config(str(path.with_name("new.db")), client_id="gw-other"),
                    config(str(path.with_name("new.db")), client_id="gw-syn", kin_base_url="http://cloud.invalid")):
            with self.subTest(cfg=cfg):
                status = self.assert_blocked(cfg, "settings_identity_mismatch")
                self.assertEqual(status["identityError"], "settings_identity_mismatch")
                self.assertEqual(path.read_bytes(), saved)
        payload = json.loads(saved)
        del payload["base"]
        path.write_text(json.dumps(payload), encoding="utf-8")
        self.assert_blocked(config(self.path, client_id="gw-syn"), "settings_identity_mismatch")

    def test_legacy_queue_without_an_owner_preserves_rows_and_migrates_an_unknown_peer_address(self):
        queue = Queue(self.path)
        queue.record_changes([(self.UID, "orthanc-id")], 1)
        queue.set_destinations(self.UID, ["kin", PEER])
        queue.add_successes(self.UID, {self.UID + ".1"}, 1)
        with queue.db:
            queue.db.execute("ALTER TABLE forwards DROP COLUMN peer")
            queue.db.execute("INSERT INTO meta(key, value) VALUES ('client', 'gw-syn')")
        queue.close()
        cfg = config(self.path, client_id="gw-syn")
        status = self.assert_blocked(cfg, "queue_identity_unknown")
        self.assertEqual(status["identityError"], "queue_identity_unknown")
        self.assertEqual(status["rows"][0]["successfulSops"], 1)
        queue = Queue(self.path)
        self.addCleanup(queue.close)
        self.assertIsNone(queue.forward_due()["peer"])
        self.assertEqual((queue.changes_since(), queue.forward_due()["dest"]), (1, PEER))
        self.assertIsNone(queue.db.execute("SELECT value FROM meta WHERE key='owner'").fetchone())

    def test_settings_accept_all_store_registrations(self):
        answer = settings_answer(peers=(f"00000000-0000-4000-8000-{i:012x}" for i in range(10001)))
        self.assertEqual(len(agent_module.parse_settings(answer)["peers"]), 10001)

    def test_a_failing_kin_row_holds_back_no_other_destination(self):
        agent = self.agent(settings_answer([rule("CT", None, "kin", PEER)]))
        self.kin(agent)
        agent.queue.record_changes([("1.2.840.99.8", "orthanc-id-2")], 2)   # a second study, whose KIN send fails
        agent.queue.db.execute("UPDATE studies SET destinations='[\"kin\"]' WHERE uid='1.2.840.99.8'")
        agent.queue.db.commit()
        agent.poll_changes = agent.flush_receipts = agent.retry_requests = lambda: None
        failing = agent.process
        agent.process = lambda row: (_ for _ in ()).throw(GatewayError("cloud request ConnectionError")) \
            if row["uid"] == "1.2.840.99.8" else failing(row)
        passes = []
        with patch.object(agent_module.time, "sleep", side_effect=lambda _s: setattr(agent, "stopping", True)):
            original = agent.queue.forward_due
            agent.queue.forward_due = lambda: (passes.append(1), original())[1]
            agent.stopping = False
            agent.loop()
        self.assertEqual(self.forward_row(agent)["phase"], "complete")
        self.assertIn(("study.retry", {"uid": "1.2.840.99.8", "attempt": 1, "afterSeconds": 1, "error": "cloud request ConnectionError"}),
                      self.events)

    def test_late_instance_reaches_only_the_original_still_allowed_peer(self):
        agent = self.agent(settings_answer([rule("CT", None, "kin", PEER)]))
        self.kin(agent)
        self.forward(agent)
        agent.settings.accept(settings_answer([rule("CT", None, PEER, PEER_B)], revision=2))
        agent.orthanc.held[self.UID + ".3"] = dict(agent.orthanc.held[self.UID + ".1"], sop=self.UID + ".3", id="late")
        agent.queue.record_changes([(self.UID, "orthanc-id")], 2)
        with self.assertRaisesRegex(GatewayError, "KIN destination no longer allowed"):
            self.kin(agent)
        self.forward(agent)
        self.assertEqual(agent.cloud.stowed, [self.UID])
        self.assertEqual([c for c in agent.orthanc.calls if c[0] == "store"][-1], ("store", "kin-route-" + PEER, ("late",)))
        self.assertIsNone(self.forward_row(agent, PEER_B))
        self.assertEqual(set(json.loads(self.forward_row(agent)["successful_sops"])), set(agent.orthanc.held))

    def test_a_stable_study_that_is_gone_is_skipped_and_the_feed_goes_on(self):
        agent = Agent(config(self.path))
        self.addCleanup(agent.queue.close)
        feed = {"Changes": [{"ChangeType": "StableStudy", "ID": "gone"}, {"ChangeType": "StableStudy", "ID": "here"}],
                "Last": 7, "Done": True}
        agent.orthanc.changes = lambda since: feed

        def request(method, path, **kwargs):
            if path == "/studies/gone":
                raise GatewayError("local Orthanc HTTP 404")
            return FakeResponse(200, {"MainDicomTags": {"StudyInstanceUID": "1.2.840.99.8"}})

        agent.orthanc.request = request
        agent.poll_changes()
        self.assertEqual(agent.queue.changes_since(), 7)
        self.assertEqual(agent.queue.due()["uid"], "1.2.840.99.8")
        self.assertIn(("study.gone", {}), self.events)

    # ── lossless compression ──

    def test_lossless_recompresses_only_native_pixel_data_and_a_refusal_sends_the_stored_bytes(self):
        agent = self.agent(settings_answer(compression="lossless"))
        agent.orthanc.held["1.2.840.99.7.2"]["syntax"] = "1.2.840.10008.1.2.4.50"   # already compressed (lossy)
        self.kin(agent)
        self.assertIn(("lossless", "id-1.2.840.99.7.1"), agent.orthanc.calls)
        self.assertNotIn(("lossless", "id-1.2.840.99.7.2"), agent.orthanc.calls)
        self.assertIn(("copy", "id-1.2.840.99.7.2"), agent.orthanc.calls)
        stored = [fields for event, fields in self.events if event == "batch.stored"]
        self.assertEqual(stored[0]["compressed"], 1)
        self.assertIn(b"1" * 8, agent.cloud.bodies[0])
        # Orthanc refuses: the original bytes go, checked against the stored size as before (a Gateway of its own).
        self.path = str(Path(self.path).with_name("second.db"))
        refused = self.agent(settings_answer(compression="lossless"))
        refused.orthanc.refuse_lossless = True
        self.kin(refused)
        self.assertEqual([call for call in refused.orthanc.calls if call[0] == "copy"],
                         [("copy", "id-1.2.840.99.7.1"), ("copy", "id-1.2.840.99.7.2")])
        self.assertEqual([fields for event, fields in self.events if event == "batch.stored"][-1]["compressed"], 0)

    def test_the_transcode_request_asks_orthanc_for_jpeg_lossless_and_a_refusal_writes_nothing(self):
        orthanc = agent_module.Orthanc(config("unused"))
        self.addCleanup(orthanc.session.close)
        asked = []

        class Streamed(FakeResponse):
            def __enter__(self):
                return self

            def __exit__(self, *_args):
                return False

            def iter_content(self, chunk_size):
                yield b"JLS"

        answers = [Streamed(200), FakeResponse(415)]

        def session_request(method, url, **kwargs):
            asked.append((method, url, kwargs.get("params")))
            return answers.pop(0)

        with patch.object(orthanc.session, "request", side_effect=session_request):
            with tempfile.TemporaryFile() as sink:
                self.assertEqual(orthanc.copy_lossless("one", sink), 3)
                self.assertIsNone(orthanc.copy_lossless("two", sink))
                self.assertEqual(sink.tell(), 3)
        self.assertEqual(asked[0][2], {"transcode": "1.2.840.10008.1.2.4.70"})

    def test_stored_sops_reads_the_referenced_sequence_and_never_raises(self):
        answer = {"00081199": {"vr": "SQ", "Value": [{"00081155": {"vr": "UI", "Value": ["1.2.3"]}}, {"bad": 1}]}}
        self.assertEqual(agent_module.stored_sops(answer), {"1.2.3"})
        self.assertEqual(agent_module.stored_sops([answer]), {"1.2.3"})
        for odd in ({}, {"00081199": []}, None, "x", {"00081199": {"Value": "x"}},
                    {"00081199": {"Value": [{"00081155": None}, {"00081155": {"Value": None}}, None]}}):
            self.assertEqual(agent_module.stored_sops(odd), set())


# ── signed updates (the agent's half) and remote support ──────────────────────────────────────────────────────────────

REQ = "5a5a5a5a-1111-4222-8333-944455556666"
REQ_B = "6b6b6b6b-1111-4222-8333-944455556666"


class StreamResponse(FakeResponse):
    def __init__(self, status, chunks):
        super().__init__(status)
        self.chunks, self.closed = chunks, False

    def iter_content(self, _size):
        yield from self.chunks

    def close(self):
        self.closed = True


class SupportCloud:
    """KIN's support routes as the agent calls them: records each call; answers from a table (default 200 stored)."""

    def __init__(self, answers=None):
        self.base, self.calls, self.answers = "https://cloud.invalid", [], dict(answers or {})

    def request(self, method, path, **kwargs):
        body = kwargs.get("json")
        self.calls.append((method, path, None if body is None else json.loads(json.dumps(body)), kwargs.get("params")))
        answer = self.answers.get((method, path))
        if isinstance(answer, list):
            answer = answer.pop(0) if answer else None
        if isinstance(answer, Exception):
            raise answer
        return answer or FakeResponse(200, {"result": "stored"})

    def posts(self):
        return [(path.rsplit("/", 1)[1], body) for method, path, body, _ in self.calls if method == "POST"]


class SupportTests(unittest.TestCase):
    """Remote support and the launcher's ready signal, on the agent's side."""

    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.dir = Path(directory.name)
        self.path = str(self.dir / "queue.db")
        self.env = patch.dict(os.environ, {"KIN_UPDATE_ROOT": str(self.dir / "agent-releases"),
                                           "KIN_AGENT_UPDATE_STATE": str(self.dir / "agent-releases" / "state.json")})
        self.env.start()
        self.addCleanup(self.env.stop)
        os.environ.pop("GW_REMOTE_SUPPORT", None)
        os.environ.pop("KIN_AGENT_RUN_VERSION", None)
        self.stops = []

    def agent(self, **changes) -> Agent:
        agent = Agent(config(self.path, **changes))
        self.addCleanup(agent.queue.close)
        return agent

    def support(self, agent: Agent, cloud: SupportCloud | None = None):
        beat = agent_module.Heartbeat(agent.config, agent.queue.epoch, agent.orthanc, agent.cloud, time.monotonic())
        self.addCleanup(beat.cloud.session.close)
        support = agent_module.Support(agent.config, agent.queue.epoch, agent.owner, beat, agent.settings, agent.orthanc,
                                       agent.cloud, time.monotonic(), self.stops.append)
        self.addCleanup(support.cloud.session.close)
        support.cloud = cloud or SupportCloud()
        return support

    def row(self, agent: Agent, uid, phase="complete", destinations=("kin",), last_error=None):
        with agent.queue.db:
            agent.queue.db.execute(
                "INSERT INTO studies(uid, orthanc_id, phase, last_error, destinations, updated_at) VALUES (?,?,?,?,?,?)",
                (uid, "o-" + uid, phase, last_error, None if destinations is None else json.dumps(list(destinations)),
                 time.time()))

    def test_the_heartbeat_names_the_signed_version_the_launcher_gave(self):
        agent = self.agent()
        beat = agent_module.Heartbeat(agent.config, agent.queue.epoch, agent.orthanc, agent.cloud, time.monotonic())
        self.addCleanup(beat.cloud.session.close)
        self.assertEqual(beat.body()["version"], agent_module.AGENT_VERSION)
        for value, shown in (("2026.12.1", "2026.12.1"), ("v2", agent_module.AGENT_VERSION),
                             ("1." * 20 + "1", agent_module.AGENT_VERSION)):
            with patch.dict(os.environ, {"KIN_AGENT_RUN_VERSION": value}):
                self.assertEqual(beat.body()["version"], shown)

    def test_the_ready_file_needs_a_stored_beat_and_a_finished_pass(self):
        ready = self.dir / "start.ready"
        with patch.dict(os.environ, {"KIN_AGENT_READY_FILE": str(ready)}):
            agent = self.agent()
        beat = agent_module.Heartbeat(agent.config, agent.queue.epoch, agent.orthanc, agent.cloud, time.monotonic())
        self.addCleanup(beat.cloud.session.close)
        beat.cloud = BeatCloud([FakeResponse(200, {"result": "stale"}), FakeResponse(503),
                                FakeResponse(200, {"result": "stored"})])
        agent.heartbeat = beat
        agent.mark_ready()
        self.assertFalse(ready.exists(), "no beat yet")
        beat.beat()   # 200 but stale: KIN did not take this run's status
        beat.beat()   # refused
        agent.mark_ready()
        self.assertFalse(ready.exists())
        beat.beat()
        self.assertTrue(beat.stored_once)
        agent.mark_ready()
        self.assertEqual(json.loads(ready.read_text()), {"version": agent_module.AGENT_VERSION})
        ready.unlink()
        agent.mark_ready()
        self.assertFalse(ready.exists(), "written once per start")

    def test_a_pass_that_ended_in_an_outer_error_does_not_make_the_run_ready(self):
        ready = self.dir / "start.ready"
        with patch.dict(os.environ, {"KIN_AGENT_READY_FILE": str(ready)}):
            agent = self.agent()
        agent.heartbeat = type("Beat", (), {"stored_once": True})()
        passes = []

        def poll_changes():
            passes.append(1)
            if len(passes) == 1:
                raise GatewayError("local Orthanc HTTP 500")
            agent.stopping = True

        agent.flush_receipts = lambda: None
        agent.retry_requests = lambda: None
        agent.poll_changes = poll_changes
        seen = []
        with patch.object(agent_module.time, "sleep", lambda _s: seen.append(ready.exists())):
            agent.loop()
        self.assertEqual(seen, [False, True], "not after the failed pass; after the next clean one")

    def test_the_log_ring_keeps_only_listed_gateway_events_without_destination_or_free_text(self):
        agent_module.LOG_RING.clear()
        with patch.object(agent_module.sys, "stdout", io.StringIO()):
            agent_module.log("forward.complete", uid="1.2.840.99", sops=2)   # one study's history: not kept at all
            agent_module.log("study.gone")                                   # about one study even without a UID
            agent_module.log("forward.stored", dest=PEER, sops=3)            # same: one study's transfer history
            agent_module.log("agent.retry", attempt=2, afterSeconds=1.5, error="local_change_invalid")
            agent_module.log("agent.started", version="2026.11.2", queueRows=4, dest=PEER, note="PATIENT^NAME")
            agent_module.log("heartbeat.deferred", error="Patient Name Something")
        self.assertEqual([line["event"] for line in agent_module.LOG_RING], ["agent.started", "heartbeat.deferred"])
        first, second = agent_module.LOG_RING
        self.assertEqual(first, {"at": first["at"], "event": "agent.started", "queueRows": 4})
        self.assertEqual(second, {"at": second["at"], "event": "heartbeat.deferred", "error": "other"})
    def test_diagnostics_are_a_closed_report_without_secrets_names_or_unrouted_studies(self):
        agent = self.agent(client_secret="SECRET-VALUE-1", orthanc_pass="ORTHANC-PASS-1")
        self.row(agent, "1.2.3.1", "retry", ("kin", PEER), "announce HTTP 503")
        self.row(agent, "1.2.3.2", "not_routed", (PEER,))
        self.row(agent, "1.2.3.3", "pending", None)
        cloud = SupportCloud()
        support = self.support(agent, cloud)
        with patch.object(agent_module.sys, "stdout", io.StringIO()):
            agent_module.log("study.retry", uid="1.2.3.2", error="announce HTTP 503")
        support.carry_out({"id": REQ, "action": "diagnostics", "version": None})
        (request_id, body), = cloud.posts()
        self.assertEqual(request_id, REQ)
        self.assertEqual(set(body), {"epoch", "bootId", "result", "code", "version", "diagnostics"})
        self.assertEqual((body["epoch"], body["result"]), (agent.queue.epoch, "done"))
        report = body["diagnostics"]
        self.assertEqual(set(report), {"format", "version", "uptimeSeconds", "launcher", "config", "settings",
                                       "localOrthanc", "lastStowAgeSeconds", "dataFreeBytes", "queue", "log"})
        self.assertEqual(report["queue"]["counts"], {"retry": 1, "not_routed": 1, "pending": 1})
        self.assertEqual(report["queue"]["omitted"], 2)
        self.assertEqual(report["queue"]["rows"], [{"uid": "1.2.3.1", "phase": "retry", "attempt": 0,
                                                    "errorCode": "announce_http", "destinations": ["kin", PEER],
                                                    "forwards": []}])
        text = json.dumps(report)
        for absent in ("SECRET-VALUE-1", "ORTHANC-PASS-1", "1.2.3.2", "1.2.3.3", "announce HTTP 503"):
            self.assertNotIn(absent, text)
        self.assertEqual(report["config"]["clientId"], "c")
        self.assertLessEqual(len(json.dumps(report, separators=(",", ":"))), agent_module.DIAGNOSTICS_MAX_BYTES)

    def test_a_large_queue_still_fits_with_whole_counts(self):
        agent = self.agent()
        for index in range(300):
            self.row(agent, f"1.2.840.10008.{index}", "complete")
        support = self.support(agent)
        with patch.object(agent_module, "DIAGNOSTICS_MAX_BYTES", 6000):
            report = support.diagnostics()
            self.assertLessEqual(len(json.dumps(report, separators=(",", ":"))), 6000)
        self.assertEqual(report["queue"]["total"], 300)
        self.assertEqual(len(report["queue"]["rows"]) + report["queue"]["omitted"], 300)
        self.assertGreater(report["queue"]["omitted"], 100)

    def test_a_restart_happens_once_and_the_next_run_reports_it_done(self):
        agent = self.agent()
        cloud = SupportCloud()
        support = self.support(agent, cloud)
        support.carry_out({"id": REQ, "action": "restart", "version": None})
        self.assertEqual(self.stops, [agent_module.RESTART_EXIT])
        self.assertEqual([(i, b["result"]) for i, b in cloud.posts()], [(REQ, "accepted")])
        support.carry_out({"id": REQ, "action": "restart", "version": None})   # delivered again: no second restart
        self.assertEqual(self.stops, [agent_module.RESTART_EXIT])
        support.report_outcomes()   # the same run: not done yet
        self.assertEqual(len(cloud.posts()), 2)
        later = self.support(agent, SupportCloud({("POST", f"/api/gateway/support/{REQ}"): [FakeResponse(503)]}))
        later.report_outcomes()      # KIN busy: owed still
        later.report_outcomes()
        self.assertEqual([(i, b["result"]) for i, b in later.cloud.posts()], [(REQ, "done"), (REQ, "done")])
        later.report_outcomes()
        self.assertEqual(len(later.cloud.posts()), 2, "acknowledged once, never again")
        self.assertIsNone(self.support(agent).memo["restart"])

    def test_an_update_is_downloaded_whole_and_handed_to_the_launcher_once(self):
        agent = self.agent()
        bundle = b'{"format":1}' * 10
        cloud = SupportCloud({("GET", "/api/gateway/update/2026.12.1"): StreamResponse(200, [bundle[:50], bundle[50:]])})
        support = self.support(agent, cloud)
        support.carry_out({"id": REQ, "action": "update", "version": "2026.12.1"})
        incoming = [p for p in (self.dir / "agent-releases" / "incoming").iterdir()]
        self.assertEqual([p.name.startswith(".") for p in incoming], [False])
        self.assertEqual((incoming[0] / "bundle.json").read_bytes(), bundle)
        self.assertEqual(json.loads((incoming[0] / "request.json").read_text()), {"requestId": REQ, "version": "2026.12.1"})
        self.assertEqual([(i, b["result"], b["version"]) for i, b in cloud.posts()], [(REQ, "accepted", "2026.12.1")])
        support.carry_out({"id": REQ, "action": "update", "version": "2026.12.1"})
        self.assertEqual(len(list((self.dir / "agent-releases" / "incoming").iterdir())), 1, "not handed over twice")
        self.assertEqual(self.stops, [])

    def test_an_update_that_cannot_be_downloaded_or_kept_is_refused_with_a_code(self):
        agent = self.agent()
        cases = [(StreamResponse(404, []), "download_failed"),
                 (StreamResponse(200, [b"x" * 4096] * 3), "too_large"),
                 (GatewayError("cloud request ConnectionError"), "download_failed")]
        for answer, code in cases:
            cloud = SupportCloud({("GET", "/api/gateway/update/2026.12.1"): answer})
            support = self.support(agent, cloud)
            with patch.object(agent_module, "UPDATE_DOWNLOAD_MAX_BYTES", 10000):
                support.carry_out({"id": REQ_B, "action": "update", "version": "2026.12.1"})
            self.assertEqual([(b["result"], b["code"]) for _i, b in cloud.posts()], [("refused", code)])
        self.assertFalse((self.dir / "agent-releases" / "incoming").exists()
                         and [p for p in (self.dir / "agent-releases" / "incoming").iterdir() if not p.name.startswith(".")])
        with patch.dict(os.environ, {"KIN_UPDATE_ROOT": ""}):
            support = self.support(agent)
            support.carry_out({"id": REQ, "action": "update", "version": "2026.12.1"})
            self.assertEqual([(b["result"], b["code"]) for _i, b in support.cloud.posts()], [("refused", "no_launcher")])

    def test_remote_support_off_refuses_every_action_and_does_nothing(self):
        agent = self.agent()
        with patch.dict(os.environ, {"GW_REMOTE_SUPPORT": "off"}):
            support = self.support(agent)
        for action, version in (("diagnostics", None), ("restart", None), ("update", "2026.12.1")):
            support.carry_out({"id": REQ, "action": action, "version": version})
        self.assertEqual([(b["result"], b["code"], b["diagnostics"]) for _i, b in support.cloud.posts()],
                         [("refused", "remote_support_off", None)] * 3)
        self.assertEqual([c for c in support.cloud.calls if c[0] == "GET"], [])
        self.assertEqual(self.stops, [])

    def test_the_launcher_outcomes_are_reported_until_kin_acknowledges_them(self):
        agent = self.agent()
        state = self.dir / "agent-releases" / "state.json"
        state.parent.mkdir(parents=True)
        state.write_text(json.dumps({"current": "2026.12.1", "results": [
            {"version": "2026.12.1", "result": "installed", "code": None, "requestId": REQ},
            {"version": "2026.12.2", "result": "refused", "code": "bad_signature", "requestId": REQ_B},
            {"version": "2026.12.3", "result": "rolled_back", "code": "exited", "requestId": "not-a-request-id"}]}))
        cloud = SupportCloud({("POST", f"/api/gateway/support/{REQ_B}"): [FakeResponse(503)]})
        support = self.support(agent, cloud)
        support.report_outcomes()
        self.assertEqual([(i, b["result"], b["code"], b["version"]) for i, b in cloud.posts()],
                         [(REQ, "installed", None, "2026.12.1"), (REQ_B, "refused", "bad_signature", "2026.12.2")])
        support.report_outcomes()
        support.report_outcomes()
        self.assertEqual([i for i, _b in cloud.posts()], [REQ, REQ_B, REQ_B])
        # Another start of the same Gateway remembers what KIN acknowledged.
        again = self.support(agent)
        again.report_outcomes()
        self.assertEqual(again.cloud.posts(), [])

    def test_only_a_well_formed_request_is_carried_out(self):
        agent = self.agent()
        bad = [{"id": REQ, "action": "shell", "version": None}, {"id": "x", "action": "restart", "version": None},
               {"id": REQ, "action": "update", "version": None}, {"id": REQ, "action": "restart", "version": "1"},
               {"id": REQ, "action": "update", "version": "1.0; rm"}, {"id": REQ, "action": "restart"},
               {"id": REQ, "action": "restart", "version": None, "command": "x"}]
        for request in bad:
            cloud = SupportCloud({("GET", "/api/gateway/support"): FakeResponse(200, {"request": request})})
            support = self.support(agent, cloud)
            support.tick()
            self.assertEqual(cloud.posts(), [], request)
        self.assertEqual(self.stops, [])
        cloud = SupportCloud({("GET", "/api/gateway/support"): FakeResponse(200, {"request": None})})
        self.support(agent, cloud).tick()
        self.assertEqual(cloud.calls[-1][3], {"epoch": agent.queue.epoch})
        # A KIN without remote support answers 404: nothing happens.
        cloud = SupportCloud({("GET", "/api/gateway/support"): FakeResponse(404)})
        self.support(agent, cloud).tick()
        self.assertEqual(cloud.posts(), [])

    def test_the_memo_belongs_to_this_credential_and_queue(self):
        agent = self.agent()
        memo = Path(self.path).with_name("support.json")
        memo.write_text(json.dumps({"client": "c", "base": "https://cloud.invalid", "epoch": "other-epoch",
                                    "handled": [REQ], "reported": [], "restart": None}))
        support = self.support(agent)
        self.assertEqual(support.memo["handled"], [])
try:   # the real DICOM SCP these cases talk to; the CI venv that runs this file installs pynetdicom (validate.yml)
    import pynetdicom
    from pynetdicom import AE, evt
    from pynetdicom.sop_class import CTImageStorage, Verification
except ImportError:   # pragma: no cover
    pynetdicom = None


def free_port() -> int:
    with socketserver.TCPServer(("127.0.0.1", 0), socketserver.BaseRequestHandler) as server:
        return server.server_address[1]


@unittest.skipIf(pynetdicom is None, "pynetdicom is not installed: the real DICOM SCP cases cannot run here")
class DicomListenerCheckTests(unittest.TestCase):
    """The DICOM receive self-check: one C-ECHO to the listener's DICOM port, judged only by the listener's answer."""

    def scp(self, *, contexts=("verification",), title="KINGW", require_called=False, status=0x0000):
        ae = AE(ae_title=title)
        ae.require_called_aet = require_called
        if "verification" in contexts:
            ae.add_supported_context(Verification)
        if "ct" in contexts:
            ae.add_supported_context(CTImageStorage)
        echoes = []

        def on_echo(event):
            echoes.append(event.assoc.requestor.ae_title)
            return status
        port = free_port()
        server = ae.start_server(("127.0.0.1", port), block=False, evt_handlers=[(evt.EVT_C_ECHO, on_echo)])
        self.addCleanup(server.shutdown)
        return port, echoes

    def test_an_accepting_listener_is_accepted_and_really_received_the_echo(self):
        port, echoes = self.scp()
        self.assertEqual(agent_module.dicom_echo("127.0.0.1", port, "KINGW"), "accepted")
        self.assertEqual([str(title).strip() for title in echoes], ["KINGW-CHECK"])

    def test_a_refused_association_context_or_status_is_rejected(self):
        port, _echoes = self.scp(title="KINGW", require_called=True)
        self.assertEqual(agent_module.dicom_echo("127.0.0.1", port, "OTHER"), "rejected", "A-ASSOCIATE-RJ")
        port, echoes = self.scp(contexts=("ct",))
        self.assertEqual(agent_module.dicom_echo("127.0.0.1", port, "KINGW"), "rejected", "Verification not supported")
        self.assertEqual(echoes, [])
        port, echoes = self.scp(status=0x0122)
        self.assertEqual(agent_module.dicom_echo("127.0.0.1", port, "KINGW"), "rejected", "a failure Status")
        self.assertEqual(len(echoes), 1)

    def test_a_closed_port_a_silent_listener_and_a_bare_close_are_no_answer(self):
        self.assertEqual(agent_module.dicom_echo("127.0.0.1", free_port(), "KINGW", timeout=1), "no_answer")
        silent = socketserver.TCPServer(("127.0.0.1", 0), socketserver.BaseRequestHandler, bind_and_activate=True)
        self.addCleanup(silent.server_close)   # listens, never accepts or answers
        started = time.monotonic()
        self.assertEqual(agent_module.dicom_echo("127.0.0.1", silent.server_address[1], "KINGW", timeout=0.5),
                         "no_answer")
        self.assertLess(time.monotonic() - started, 3, "one deadline from connecting to the answer")

        class Hangup(socketserver.BaseRequestHandler):
            def handle(self):
                self.request.recv(4096)   # reads the request and closes without any PDU

        hangup = socketserver.ThreadingTCPServer(("127.0.0.1", 0), Hangup)
        threading.Thread(target=hangup.serve_forever, daemon=True).start()
        self.addCleanup(hangup.server_close)
        self.addCleanup(hangup.shutdown)
        self.assertEqual(agent_module.dicom_echo("127.0.0.1", hangup.server_address[1], "KINGW", timeout=2), "no_answer")

    def heartbeat(self, port: int):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        agent = Agent(config(str(Path(directory.name) / "queue.db"), dicom_host="127.0.0.1", dicom_port=port))
        self.addCleanup(agent.queue.close)
        beat = agent_module.Heartbeat(agent.config, agent.queue.epoch, agent.orthanc, agent.cloud, time.monotonic())
        self.addCleanup(beat.cloud.session.close)
        self.addCleanup(beat.stop)
        beat.cloud = BeatCloud()
        return agent, beat

    def test_the_rest_answer_never_fills_the_dicom_result(self):
        agent, beat = self.heartbeat(free_port())   # nothing listens on the DICOM port
        agent.orthanc.observed = (True, time.monotonic())   # while the REST API answers
        self.assertIsNone(beat.body()["dicomListener"], "the REST answer is not a DICOM check")
        self.assertEqual(beat.check_listener(), "no_answer")
        body = beat.body()
        self.assertEqual(body["localOrthanc"]["answered"], True)
        self.assertEqual(body["dicomListener"], {"result": "no_answer", "ageSeconds": 0})

    def test_each_beat_carries_its_own_fresh_check_and_a_failed_check_still_beats(self):
        port, echoes = self.scp()
        _agent, beat = self.heartbeat(port)
        with patch.object(agent_module, "HEARTBEAT_SECONDS", 0.05):
            beat.start()
            deadline = time.monotonic() + 10
            while len(beat.cloud.bodies) < 2 and time.monotonic() < deadline:
                time.sleep(0.01)
            beat.stop()
        self.assertGreaterEqual(len(beat.cloud.bodies), 2)
        self.assertEqual(beat.cloud.bodies[0]["dicomListener"]["result"], "accepted", "the first beat is checked first")
        self.assertGreaterEqual(len(echoes), len(beat.cloud.bodies), "one C-ECHO before each beat")
        _agent, closed = self.heartbeat(free_port())
        with patch.object(agent_module, "HEARTBEAT_SECONDS", 0.05):
            closed.start()
            deadline = time.monotonic() + 10
            while not closed.cloud.bodies and time.monotonic() < deadline:
                time.sleep(0.01)
            closed.stop()
        self.assertEqual(closed.cloud.bodies[0]["dicomListener"]["result"], "no_answer")

    def test_the_listener_address_and_its_configuration(self):
        base = config("unused", orthanc_url="http://gw-orthanc:8042")
        self.assertEqual(base.listener(), ("gw-orthanc", 4242, "KINGW"), "defaults: the Orthanc host, 4242, KINGW")
        self.assertEqual(dataclasses.replace(base, dicom_host="dicom.local", dicom_port=11112, dicom_aet="HOSP").listener(),
                         ("dicom.local", 11112, "HOSP"))
        env = {"LOCAL_ORTHANC_URL": "http://gw-orthanc:8042", "LOCAL_ORTHANC_USER": "u", "LOCAL_ORTHANC_PASS": "p",
               "KIN_BASE_URL": "https://cloud.invalid", "KIN_CLIENT_ID": "c", "KIN_CLIENT_SECRET": "s"}
        with patch.dict("os.environ", {**env, "LOCAL_DICOM_HOST": "gw-orthanc", "LOCAL_DICOM_PORT": "4242",
                                       "LOCAL_DICOM_AET": "KINGW"}, clear=True):
            self.assertEqual(Config.from_env().listener(), ("gw-orthanc", 4242, "KINGW"))
        for name, value in (("LOCAL_DICOM_PORT", "0"), ("LOCAL_DICOM_PORT", "x"), ("LOCAL_DICOM_PORT", "70000"),
                            ("LOCAL_DICOM_AET", "A" * 17), ("LOCAL_DICOM_AET", "A\\B"), ("LOCAL_DICOM_AET", "   ")):
            with patch.dict("os.environ", {**env, name: value}, clear=True):
                with self.assertRaises(GatewayError, msg=name + "=" + value):
                    Config.from_env()


DAY = agent_module.DAY_SECONDS
LAUNCHER_ENV = ("KIN_AGENT_UPDATE_STATE", "KIN_AGENT_READY_FILE", "KIN_AGENT_BUILTIN_VERSION", "KIN_AGENT_RUN_VERSION",
                "KIN_UPDATE_ROOT")


class RetentionTests(unittest.TestCase):
    """Delivered local copies are deleted once the set days have passed; nothing undelivered or unconfirmed ever is.
    The clock is turned (time.time patched), never waited for."""

    UID = "1.2.840.99.8"
    SOPS = ("1.2.840.99.8.1", "1.2.840.99.8.2")

    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.dir = Path(directory.name)
        self.events = []
        logging = patch.object(agent_module, "log", side_effect=lambda event, **fields: self.events.append((event, fields)))
        logging.start()
        self.addCleanup(logging.stop)
        environment = patch.dict(os.environ)
        environment.start()
        self.addCleanup(environment.stop)
        for name in LAUNCHER_ENV:
            os.environ.pop(name, None)
        self.now = 1_800_000_000.0
        clock = patch.object(agent_module.time, "time", side_effect=lambda: self.now)
        clock.start()
        self.addCleanup(clock.stop)

    def agent(self, routes=(), days=7, name="queue.db", **orthanc) -> Agent:
        agent = Agent(config(str(self.dir / name), client_id="gw-syn"))
        self.addCleanup(agent.queue.close)
        agent.orthanc = RouteOrthanc(self.SOPS, **orthanc)
        for index, sop in enumerate(sorted(agent.orthanc.held)):
            agent.orthanc.held[sop]["series"] = "series-a"
        agent.cloud = RouteCloud()
        agent.cloud.names = agent.orthanc.held   # KIN names every SOP it stored
        self.assertTrue(agent.settings.accept(dict(settings_answer(routes), retentionDays=days)))
        agent.queue.record_changes([(self.UID, "orthanc-id")], 1)
        return agent

    def deliver(self, agent):
        """KIN's part of one pass: the study row, then the owed receipts."""
        row = agent.queue.due()
        if row is not None:
            agent.process(row)
        agent.flush_receipts()

    def forward(self, agent):
        row = agent.queue.forward_due()
        self.assertIsNotNone(row)
        try:
            agent.process_forward(row)
        except (GatewayError, agent_module.ForwardError) as error:
            agent.queue.forward_retry(str(row["uid"]), str(row["dest"]), str(error), 1, 10)

    def purge(self, agent):
        agent.purge_at = 0.0
        agent.purge_delivered()

    def deletes(self, agent):
        return [call for call in agent.orthanc.calls if isinstance(call, tuple) and call[0] == "delete"]

    def study(self, agent):
        return agent.queue.db.execute("SELECT * FROM studies WHERE uid=?", (self.UID,)).fetchone()

    def totals(self, agent):
        return agent.queue.summary()["retention"]

    def ids(self, *sops):
        return tuple("id-" + sop for sop in sops)

    # ── when a copy goes ──

    def test_a_kin_copy_goes_exactly_when_its_days_have_passed_and_is_counted(self):
        agent = self.agent(days=7)
        start = self.now
        self.deliver(agent)
        self.assertEqual((self.study(agent)["phase"], self.study(agent)["confirmed_seq"]),
                         ("complete", self.study(agent)["seq"]))
        self.now = start + 7 * DAY - 1
        self.purge(agent)
        self.assertEqual(self.deletes(agent), [], "one second before the period ends the copy stays")
        self.assertEqual(set(agent.orthanc.held), set(self.SOPS))
        self.now = start + 7 * DAY
        self.purge(agent)
        self.assertEqual(self.deletes(agent), [("delete", self.ids(*self.SOPS))], "exactly the delivered instances")
        self.assertEqual(agent.orthanc.held, {})
        self.assertEqual(self.totals(agent), {"deletedStudies": 1, "deletedInstances": 2, "keptWithoutRecord": 0})
        self.assertEqual(agent.queue.summary()["rows"][0]["purgedSops"], 2)
        self.assertEqual(agent.cloud.stowed, [self.UID], "KIN's copy is untouched and nothing went again")
        receipt = agent.queue.receipt(self.UID)
        self.assertEqual((receipt["phase"], receipt["localCount"], receipt["successCount"]), ("complete", 2, 2))
        self.now += 30 * DAY
        self.purge(agent)
        self.assertEqual(len(self.deletes(agent)), 1, "a purged study is not looked at again")
        self.assertEqual(self.totals(agent)["deletedInstances"], 2)
        self.assertIn(("study.purged", {"uid": self.UID, "sops": 2, "failed": 0}), self.events)

    def test_no_period_unknown_settings_or_an_unsent_study_delete_nothing(self):
        agent = self.agent(days=None)
        self.deliver(agent)
        self.now += 20 * 366 * DAY
        self.purge(agent)
        self.assertEqual(self.deletes(agent), [], "no period set: today's behaviour, every copy stays")
        unknown = self.agent(days=1, name="unknown.db")
        self.deliver(unknown)
        unknown.settings.known = False
        self.now += 2 * DAY
        self.purge(unknown)
        self.assertEqual(self.deletes(unknown), [])
        for phase in ("pending", "retry", "failed", "sending"):
            with self.subTest(phase=phase):
                held = self.agent(days=1, name=phase + ".db")
                self.deliver(held)
                held.queue.db.execute("UPDATE studies SET phase=?", (phase,))
                self.now += 2 * DAY
                self.purge(held)
                self.assertEqual(self.deletes(held), [], "a study not finished keeps every copy at any age")

    def test_a_receipt_kin_did_not_confirm_keeps_the_copy(self):
        answers = {"stale": lambda body: FakeResponse(200, {"studyUid": body["studyUid"], "result": "stale"}),
                   "refused": lambda body: FakeResponse(409, {"code": "GATEWAY_RECEIPT_CONFLICT"}),
                   "other study": lambda body: FakeResponse(200, {"studyUid": "1.2.3", "result": "stored"}),
                   "no body": lambda body: FakeResponse(200)}
        for name, answer in answers.items():
            with self.subTest(answer=name):
                agent = self.agent(days=1, name=name.replace(" ", "-") + ".db")
                agent.cloud.answer = answer
                self.deliver(agent)
                self.assertEqual(agent.queue.unreported(), [], "the report itself is final as before")
                self.now += 2 * DAY
                self.purge(agent)
                self.assertEqual(self.deletes(agent), [])
                self.assertEqual(set(agent.orthanc.held), set(self.SOPS))
        duplicate = self.agent(days=1, name="duplicate.db")
        duplicate.cloud.answer = lambda body: FakeResponse(200, {"studyUid": body["studyUid"], "result": "duplicate"})
        self.deliver(duplicate)
        self.now += 2 * DAY
        self.purge(duplicate)
        self.assertEqual(len(self.deletes(duplicate)), 1, "KIN already held exactly this state: confirmed")

    def test_a_sop_kin_did_not_name_as_stored_keeps_the_study(self):
        agent = self.agent(days=1)
        agent.cloud.names = {self.SOPS[0]}
        self.deliver(agent)
        self.assertEqual(self.study(agent)["phase"], "complete")
        self.now += 2 * DAY
        self.purge(agent)
        self.assertEqual(self.deletes(agent), [])
        self.assertIn(("study.purge_skipped", {"uid": self.UID, "pending": 1}), self.events)

    def test_a_row_from_before_the_record_is_kept_and_counted_as_such(self):
        agent = self.agent(days=1)
        agent.queue.db.execute("UPDATE studies SET kin_stored_sops=NULL")
        self.deliver(agent)
        self.now += 2 * DAY
        self.purge(agent)
        self.assertEqual(self.deletes(agent), [])
        self.assertEqual(self.totals(agent), {"deletedStudies": 0, "deletedInstances": 0, "keptWithoutRecord": 1})

    def test_two_destinations_count_from_the_last_one_and_a_dead_peer_keeps_everything(self):
        agent = self.agent(routes=[rule("CT", None, "kin", PEER)], days=1)
        self.deliver(agent)
        agent.orthanc.store_error = GatewayError("forward C-STORE HTTP 500")
        self.forward(agent)
        self.assertEqual(agent.queue.db.execute("SELECT phase FROM forwards").fetchone()[0], "retry")
        self.now += 30 * DAY
        self.purge(agent)
        self.assertEqual(self.deletes(agent), [], "the peer lacks the study: every copy stays")
        agent.orthanc.store_error = None
        agent.queue.db.execute("UPDATE forwards SET next_at=0")
        self.forward(agent)
        finished = self.now
        self.now = finished + DAY - 1
        self.purge(agent)
        self.assertEqual(self.deletes(agent), [], "the period counts from the last destination")
        self.now = finished + DAY
        self.purge(agent)
        self.assertEqual(self.deletes(agent), [("delete", self.ids(*self.SOPS))])
        self.assertEqual(json.loads(agent.queue.db.execute("SELECT successful_sops FROM forwards").fetchone()[0]),
                         sorted(self.SOPS), "the peer's record stays")

    def test_a_peer_only_study_goes_after_the_peer_finished(self):
        agent = self.agent(routes=[rule("CT", None, PEER)], days=1)
        self.deliver(agent)
        self.assertEqual(self.study(agent)["phase"], "not_routed")
        self.forward(agent)
        finished = self.now
        self.now = finished + DAY
        self.purge(agent)
        self.assertEqual(self.deletes(agent), [("delete", self.ids(*self.SOPS))])
        self.assertEqual(agent.cloud.stowed, [])

    def test_a_removed_peer_keeps_the_copy_in_retry(self):
        agent = self.agent(routes=[rule("CT", None, "kin", PEER)], days=1)
        self.deliver(agent)
        self.assertTrue(agent.settings.accept(dict(settings_answer([rule("CT", None, "kin")], peers=(PEER_B,), revision=2),
                                                   retentionDays=1)))
        self.forward(agent)
        self.now += 30 * DAY
        self.purge(agent)
        self.assertEqual(self.deletes(agent), [])

    # ── images that arrive late ──

    def test_an_image_not_yet_reported_keeps_the_study_and_one_arriving_during_the_delete_stays(self):
        agent = self.agent(days=1)
        self.deliver(agent)
        late = self.UID + ".3"
        agent.orthanc.held[late] = dict(agent.orthanc.held[self.SOPS[0]], sop=late, id="id-" + late)
        self.now += 2 * DAY
        self.purge(agent)
        self.assertEqual(self.deletes(agent), [], "an undelivered image is in the study: nothing goes")
        del agent.orthanc.held[late]
        agent.orthanc.on_delete = lambda: agent.orthanc.held.setdefault(
            late, dict(agent.orthanc.held[self.SOPS[0]], sop=late, id="id-" + late))
        self.purge(agent)
        self.assertEqual(self.deletes(agent), [("delete", self.ids(*self.SOPS))])
        self.assertEqual(set(agent.orthanc.held), {late}, "an image that arrived after the read is not deleted")
        self.assertEqual(self.totals(agent)["deletedInstances"], 2)

    def test_an_image_after_a_purge_is_routed_and_counted_with_the_deleted_copies(self):
        agent = self.agent(routes=[rule("CT", "SYN_CT", "kin", PEER)], days=1)
        self.deliver(agent)
        self.forward(agent)
        self.now += DAY
        self.purge(agent)
        self.assertEqual(agent.orthanc.held, {})
        # Another device adds an SR series: alone it matches no rule, but it belongs to the CT study the rule took.
        late = self.UID + ".3"
        agent.orthanc.held[late] = {"sop": late, "id": "id-" + late, "size": 16, "source_ae": "SYN_SR", "syntax": NATIVE,
                                    "series": "series-b"}
        agent.orthanc.modalities = {"SR"}
        agent.queue.record_changes([(self.UID, "orthanc-id")], 2)
        self.deliver(agent)
        self.assertEqual(agent.cloud.stowed, [self.UID, self.UID])
        receipt = agent.queue.receipt(self.UID)
        self.assertEqual((receipt["phase"], receipt["localCount"], receipt["successCount"], receipt["successSeries"]),
                         ("complete", 3, 3, 2), "the deleted copies still count: 3 images in 2 series")
        self.forward(agent)
        stores = [call for call in agent.orthanc.calls if isinstance(call, tuple) and call[0] == "store"]
        self.assertEqual(stores[-1][2], ("id-" + late,), "only the new image goes to the peer")
        self.assertEqual(agent.queue.db.execute("SELECT phase FROM forwards").fetchone()[0], "complete")
        finished = self.now
        self.now = finished + DAY - 1
        self.purge(agent)
        self.assertEqual(len(self.deletes(agent)), 1, "the new image ages from its own delivery")
        self.now = finished + DAY
        self.purge(agent)
        self.assertEqual(self.deletes(agent)[-1], ("delete", ("id-" + late,)))
        self.assertEqual(self.totals(agent), {"deletedStudies": 1, "deletedInstances": 3, "keptWithoutRecord": 0})

    # ── failures and restarts ──

    def test_a_failed_delete_counts_nothing_and_a_stop_before_the_record_counts_once(self):
        agent = self.agent(days=1)
        self.deliver(agent)
        self.now += 2 * DAY
        agent.orthanc.delete_error = GatewayError("local Orthanc HTTP 500")
        self.purge(agent)   # never raises
        self.assertEqual(set(agent.orthanc.held), set(self.SOPS))
        self.assertEqual((self.totals(agent)["deletedInstances"], agent.queue.intents()), (0, []))
        self.assertIn("retention.deferred", [event for event, _fields in self.events])
        agent.orthanc.delete_error = None
        agent.orthanc.ids_error = GatewayError("local Orthanc ConnectionError")   # the answer is lost after the delete
        self.purge(agent)
        self.assertEqual(agent.orthanc.held, {})
        self.assertEqual((self.totals(agent)["deletedInstances"], agent.queue.intents()), (0, [self.UID]))
        restarted = Agent(config(str(self.dir / "queue.db"), client_id="gw-syn"))
        self.addCleanup(restarted.queue.close)
        restarted.orthanc, restarted.cloud = agent.orthanc, agent.cloud
        self.purge(restarted)
        self.assertEqual((self.totals(restarted)["deletedInstances"], restarted.queue.intents()), (2, []))
        self.purge(restarted)
        self.assertEqual(self.totals(restarted), {"deletedStudies": 1, "deletedInstances": 2, "keptWithoutRecord": 0})
        self.assertEqual(len(self.deletes(restarted)), 2, "the settled study is not deleted again")

    def test_a_period_cleared_or_lengthened_while_orthanc_is_read_deletes_nothing(self):
        for days in (None, 30):
            with self.subTest(days=days):
                agent = self.agent(days=1, name="changed-%s.db" % days)
                self.deliver(agent)
                self.now += 2 * DAY
                agent.orthanc.on_series = lambda: agent.settings.accept(
                    dict(settings_answer(revision=2), retentionDays=days))
                self.purge(agent)
                self.assertEqual(self.deletes(agent), [])
                self.assertEqual(agent.queue.intents(), [])

    def test_every_delete_request_checks_the_rule_and_period_as_they_are_then(self):
        for change in ("lengthened", "cleared", "stop"):
            with self.subTest(change=change):
                agent = self.agent(days=1, name="chunks-%s.db" % change)
                self.deliver(agent)
                self.now += 2 * DAY

                def after_first_request(agent=agent, change=change):
                    if len(self.deletes(agent)) == 1:
                        if change == "stop":
                            agent.stop()
                        else:
                            agent.settings.accept(dict(settings_answer(revision=2),
                                                       retentionDays=30 if change == "lengthened" else None))
                agent.orthanc.on_delete = after_first_request
                with patch.object(agent_module, "RETENTION_DELETE_CHUNK", 1):
                    self.purge(agent)
                self.assertEqual(self.deletes(agent), [("delete", self.ids(self.SOPS[0]))], "the second request never went")
                self.assertEqual(set(agent.orthanc.held), {self.SOPS[1]})
                self.assertEqual((self.totals(agent)["deletedInstances"], agent.queue.intents()), (1, []))
                self.assertIsNone(self.study(agent)["purged_at"], "what is left stays a candidate")

    def test_a_deletion_left_unsettled_by_a_stop_is_settled_before_a_late_image_is_sent(self):
        agent = self.agent(routes=[rule(None, "SYN_CT", PEER)], days=1)
        self.deliver(agent)
        self.forward(agent)
        self.now += DAY
        agent.orthanc.ids_error = GatewayError("local Orthanc ConnectionError")   # stopped before the record was settled
        self.purge(agent)
        self.assertEqual((agent.orthanc.held, agent.queue.intents()), ({}, [self.UID]))
        # Restarted with an SR from another device: alone it matches no rule and would go to KIN by default.
        late = self.UID + ".3"
        agent.orthanc.held[late] = {"sop": late, "id": "id-" + late, "size": 16, "source_ae": "SYN_SR", "syntax": NATIVE,
                                    "series": "series-b"}
        agent.orthanc.modalities = {"SR"}
        agent.queue.record_changes([(self.UID, "orthanc-id")], 2)
        restarted = Agent(config(str(self.dir / "queue.db"), client_id="gw-syn"))
        self.addCleanup(restarted.queue.close)
        restarted.orthanc, restarted.cloud = agent.orthanc, agent.cloud
        self.deliver(restarted)
        self.assertEqual(self.study(restarted)["phase"], "not_routed", "the whole study's facts: the peer only")
        self.assertEqual(restarted.cloud.stowed, [], "nothing went to KIN")
        self.forward(restarted)
        self.assertEqual(restarted.queue.db.execute("SELECT phase FROM forwards").fetchone()[0], "complete")
        self.assertEqual((self.totals(restarted)["deletedInstances"], restarted.queue.intents()), (2, []))
        self.assertIsNone(self.study(restarted)["purged_at"], "the new image keeps the study a candidate")
        self.now += DAY
        self.purge(restarted)
        self.assertEqual(self.deletes(restarted)[-1], ("delete", ("id-" + late,)))
        self.assertEqual(self.totals(restarted)["deletedInstances"], 3)

    def test_a_kin_receipt_after_an_unsettled_deletion_counts_the_whole_study(self):
        agent = self.agent(days=1)
        self.deliver(agent)
        self.now += 2 * DAY
        agent.orthanc.ids_error = GatewayError("local Orthanc ConnectionError")
        self.purge(agent)
        late = self.UID + ".3"
        agent.orthanc.held[late] = {"sop": late, "id": "id-" + late, "size": 16, "source_ae": "SYN_CT", "syntax": NATIVE,
                                    "series": "series-b"}
        agent.queue.record_changes([(self.UID, "orthanc-id")], 2)
        self.deliver(agent)
        receipt = agent.queue.receipt(self.UID)
        self.assertEqual((receipt["phase"], receipt["localCount"], receipt["successCount"], receipt["successSeries"]),
                         ("complete", 3, 3, 2))

    def test_a_stop_ends_the_pass_between_studies(self):
        agent = self.agent(days=1)
        self.deliver(agent)
        self.now += 2 * DAY
        agent.stop()
        self.purge(agent)
        self.assertEqual(self.deletes(agent), [])

    def test_a_study_skipped_every_time_never_holds_the_others_back(self):
        agent = self.agent(days=1)
        uids = ["1.2.840.99.9.%02d" % n for n in range(12)]
        for index, uid in enumerate(uids):
            agent.queue.db.execute("""
              INSERT INTO studies(uid, orthanc_id, phase, destinations, kin_stored_sops, seq, confirmed_seq, updated_at)
              VALUES (?, ?, 'complete', '["kin"]', '[]', 3, 3, ?)""", (uid, "o-" + uid, self.now + index))
        self.now += 2 * DAY
        looked = []
        agent.purge_study = looked.append   # each one skipped (an image still on its way, say)
        self.purge(agent)
        self.purge(agent)
        self.purge(agent)
        self.assertEqual(looked[:12], uids[:10] + uids[10:], "the second check goes on after the tenth")
        self.assertEqual(looked[12:22], uids[:10], "then it starts over")

    # ── an update in progress ──

    def test_nothing_is_deleted_while_an_update_is_not_settled(self):
        state = self.dir / "state.json"
        ready = self.dir / "start.ready"
        good = {"current": "builtin", "previous": None, "pending": None, "running": "builtin", "failed": None}
        os.environ.update({"KIN_AGENT_UPDATE_STATE": str(state), "KIN_AGENT_READY_FILE": str(ready),
                           "KIN_AGENT_BUILTIN_VERSION": agent_module.AGENT_VERSION})
        agent = self.agent(days=1)
        self.deliver(agent)
        self.now += 2 * DAY
        state.write_text(json.dumps(good))
        self.purge(agent)
        self.assertEqual(self.deletes(agent), [], "this start has not written its ready file yet")
        agent.ready_file = None   # mark_ready wrote it
        cases = {
            "an install in probation": dict(good, pending={"from": "builtin", "to": "2026.12.1", "requestId": None}),
            "a manual rollback switching": dict(good, current="2026.11.9"),
            "another release runs": dict(good, running="2026.12.1", current="2026.12.1"),
            "a fallback that predates the record": dict(good, previous="2026.11.2"),
            "no pending key": {k: v for k, v in good.items() if k != "pending"},
        }
        for name, value in cases.items():
            with self.subTest(case=name):
                state.write_text(json.dumps(value))
                self.purge(agent)
                self.assertEqual(self.deletes(agent), [])
        for name, builtin in (("an image agent that predates the record", "2026.11.2"), ("an older launcher", None)):
            with self.subTest(case=name):
                state.write_text(json.dumps(good))
                if builtin is None:
                    os.environ.pop("KIN_AGENT_BUILTIN_VERSION")
                else:
                    os.environ["KIN_AGENT_BUILTIN_VERSION"] = builtin
                self.purge(agent)
                self.assertEqual(self.deletes(agent), [])
        os.environ["KIN_AGENT_BUILTIN_VERSION"] = agent_module.AGENT_VERSION
        state.write_text("{not json")
        self.purge(agent)
        self.assertEqual(self.deletes(agent), [], "an unreadable state")
        state.write_text(json.dumps(dict(good, previous="2026.11.3")))
        self.purge(agent)
        self.assertEqual(self.deletes(agent), [("delete", self.ids(*self.SOPS))], "settled: the copy goes")

    # ── the setting and the records ──

    def test_the_setting_is_one_optional_key_and_an_older_agent_still_reads_the_saved_copy(self):
        base = settings_answer()
        self.assertIsNone(agent_module.parse_settings(base)["retentionDays"], "a KIN that does not know it: never")
        for days in (1, 3650, None):
            self.assertEqual(agent_module.parse_settings(dict(base, retentionDays=days))["retentionDays"], days)
        for days in (0, 3651, 1.5, True, "7", -1):
            with self.subTest(days=days):
                self.assertIsNone(agent_module.parse_settings(dict(base, retentionDays=days)))
        agent = self.agent(days=7)
        saved = json.loads((self.dir / "settings.json").read_text())
        self.assertEqual((set(saved["answer"]), saved["retentionDays"]),
                         ({"revision", "routes", "compression", "destinations"}, 7))
        self.assertEqual(agent.settings.current["retentionDays"], 7)
        restarted = agent_module.SettingsStore(str(self.dir / "queue.db"), agent.owner)
        self.assertEqual((restarted.known, restarted.current["retentionDays"]), (True, 7))
        self.assertTrue(restarted.accept(base))   # a KIN without the key
        self.assertNotIn("retentionDays", json.loads((self.dir / "settings.json").read_text()))
        self.assertIsNone(agent_module.SettingsStore(str(self.dir / "queue.db"), agent.owner).current["retentionDays"])
        asked = []
        cloud = agent_module.Cloud(agent.config)
        self.addCleanup(cloud.session.close)
        cloud.request = lambda method, path, **kwargs: asked.append((method, path, kwargs))
        cloud.settings()
        self.assertEqual(asked, [("GET", "/api/gateway/settings", {"params": {"retention": "1"}})])

    def test_the_diagnostics_report_carries_the_totals_last(self):
        agent = self.agent(days=7)
        self.deliver(agent)
        self.now += 8 * DAY
        self.purge(agent)
        orthanc, cloud = agent_module.Orthanc(agent.config), agent_module.Cloud(agent.config)
        self.addCleanup(orthanc.session.close)
        self.addCleanup(cloud.session.close)
        beat = agent_module.Heartbeat(agent.config, agent.queue.epoch, orthanc, cloud, time.monotonic())
        self.addCleanup(beat.cloud.session.close)
        support = agent_module.Support(agent.config, agent.queue.epoch, agent.owner, beat, agent.settings, orthanc,
                                       cloud, time.monotonic(), lambda code: None)
        self.addCleanup(support.cloud.session.close)
        line = support.diagnostics()["log"][-1]
        self.assertEqual({k: v for k, v in line.items() if k != "at"},
                         {"event": "retention.totals", "deletedStudies": 1, "deletedInstances": 2, "keptWithoutRecord": 0,
                          "retentionDays": 7})
        self.assertNotIn(self.UID, json.dumps(line))
        # A full ring of this run's lines: the totals take the oldest line's place, so KIN's limit still holds.
        with patch.object(agent_module, "LOG_RING", agent_module.deque(
                [{"at": "2026-11-21T00:00:00Z", "event": "agent.started"}] * agent_module.LOG_RING_MAX,
                maxlen=agent_module.LOG_RING_MAX)):
            lines = support.diagnostics()["log"]
        self.assertEqual((len(lines), lines[-1]["event"]), (agent_module.LOG_RING_MAX, "retention.totals"))


if __name__ == "__main__":
    unittest.main()
