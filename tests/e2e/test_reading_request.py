# coding: utf-8
"""Reading request on the real Nest guard and services, PostgreSQL, Keycloak and Orthanc (API level).

The rule (api/src/pacs/reading-request.ts): a clinician of the owning institution asks for an existing study to be read; the
request is kept on the study (five StudyState fields and one `study.reading-request` audit row) and shows on the worklist
row the study opens on (examOpenUids) until the approval of that row closes it in the approval's own transaction. Cases,
each on its own synthetic studies:

  reading_01  one request per study: a press makes it (201, one audit row); a second press by another clinician answers it
              as it is (200, created false, no row); two presses at the same moment on two connections make one; the
              worklist row and the clinician row show it; the report state, hold and assignment are untouched.
  reading_02  refused: no clinician role (radiologist, admin), another institution's clinician (404), another account's
              owner (409); none writes an audit row. A study with a request is not deleted (409).
  reading_03  closed by the approval: a save, a hold and a refused approval leave it open; the approval closes it with the
              approval's own time; a new request on the approved report is refused; a Reset keeps it closed and a new
              request after it is a second request (a second audit row).
  reading_04  a merged exam: a request on a merged study (made before or after the merge) shows on the base row and the base
              row's approval closes it; an approval racing a press on two connections never leaves an open request on an
              approved report.

Synthetic stack only, through scripts/run-tests.py (LiveStack refuses any other entry):

    python scripts/run-tests.py --module tests/e2e/test_reading_request.py --class ReadingRequestE2E --mode live --unit ci-clinician-reading-request --timeout 900

It runs on a hosted runner through the dispatch-only Focused integration profile clinician-reading-request (tests/measurement_ci.py).
Owned data only: run-created Keycloak users (kin-test-*), the realm role `clinician` only when this run had to create it,
synthetic C-STORE studies (their StudyState rows, with the request fields, go with the fixture cleanup), the report
versions written on them, the merged exam of reading_04 (removed in its cleanup) and the audit rows.
"""
from __future__ import annotations

import sys
import threading
import unittest
import uuid
from pathlib import Path
from urllib.parse import quote

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from invariants_live import LiveStack, psql  # noqa: E402
from clinician_question_live import lit, member_owner  # noqa: E402

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

IDENTITIES = (
    ("rclin", ["clinician"], "hallym"),
    ("rclin2", ["clinician"], "hallym"),
    ("rkclin", ["clinician"], "kin-center"),
    ("rrad", ["radiologist"], "hallym"),
    ("radmin", ["admin"], "hallym"),
    ("rtech", ["technician"], "hallym"),
)


class ReadingRequestE2E(unittest.TestCase):
    maxDiff = None

    @classmethod
    def setUpClass(cls) -> None:
        cls.stack = LiveStack()
        cls.owners: dict[str, list[str]] = {}
        cls.created_role = False
        cls.addClassCleanup(cls.stack.cleanup_test_identities)
        cls.addClassCleanup(cls.stack.cleanup_all)
        cls.stack.require_stack()
        role = cls.stack.kc_admin("GET", "/roles/clinician")
        if role.status == 404:
            created = cls.stack.kc_admin("POST", "/roles", {"name": "clinician", "description": "temporary reading request clinician role"})
            if created.status != 201:
                raise RuntimeError(f"clinician role creation failed: {created.status} {created.text}")
            cls.created_role = True
        elif role.status != 200:
            raise RuntimeError(f"clinician role lookup failed: {role.status} {role.text}")
        cls.addClassCleanup(cls.delete_role_if_created)
        for logical, roles, group in IDENTITIES:
            cls.stack.create_test_identity(logical, roles, group)

    @classmethod
    def delete_role_if_created(cls) -> None:
        if cls.created_role:
            deleted = cls.stack.kc_admin("DELETE", "/roles/clinician")
            if deleted.status not in (204, 404):
                raise RuntimeError(f"temporary clinician role cleanup failed: {deleted.status}")
            cls.created_role = False

    # ── helpers ──
    def study(self, patient_id: str | None = None):
        fixture = self.stack.create_fixture(patient_id=patient_id)
        self.addCleanup(self.stack.cleanup_fixture, fixture.uid)
        return fixture

    def owner(self, user: str) -> list[str]:
        if user not in self.owners:
            self.owners[user] = member_owner(self.stack, user)
        return self.owners[user]

    def ask(self, user: str, uid: str, expect: int, code: str | None = None, owner: list[str] | None = None):
        result = self.stack.request("POST", f"/studies/{quote(uid)}/reading-request", user,
                                    {"expectedOwner": owner if owner is not None else self.owner(user)})
        self.assertEqual(result.status, expect, result.text[:500])
        if code is not None:
            self.assertEqual(result.body.get("code"), code, result.text[:500])
        return result.body

    def fields(self, uid: str) -> dict:
        rows = psql('SELECT json_build_object(\'at\', "readingRequestAt", \'bySub\', "readingRequestBySub", \'by\', "readingRequestBy",'
                    ' \'closedAt\', "readingRequestClosedAt", \'approvedAt\', "approvedAt", \'rs\', rs, \'holder\', holder,'
                    ' \'repDoc\', "repDoc")::text FROM "StudyState" WHERE uid=' + lit(uid))
        self.assertEqual(len(rows), 1, uid)
        import json
        return json.loads(rows[0])

    def audits(self, uid: str) -> int:
        return int(psql('SELECT count(*)::text FROM "AuditLog" WHERE action=\'study.reading-request\' AND target=' + lit(uid))[0])

    def worklist_row(self, uid: str, user: str = "rrad") -> dict | None:
        result = self.stack.request("GET", "/studies", user)
        self.assertEqual(result.status, 200, result.text[:300])
        return next((row for row in result.body["studies"] if row["uid"] == uid), None)

    def clinician_row(self, uid: str, user: str = "rclin") -> dict | None:
        rows, after = [], None
        for _ in range(50):
            result = self.stack.request("GET", "/clinician/studies?limit=100" + (f"&after={quote(after)}" if after else ""), user)
            self.assertEqual(result.status, 200, result.text[:300])
            rows += result.body["studies"]
            after = result.body["pagination"]["next"]
            if after is None:
                break
        return next((row for row in rows if row["uid"] == uid), None)

    def commit(self, uid: str, user: str, action: str, base: int, expect: int = 201, **extra):
        body = {"action": action, "baseVersion": base, "findings": extra.pop("findings", ""),
                "conclusion": extra.pop("conclusion", ""), "recommendation": extra.pop("recommendation", ""), **extra}
        result = self.stack.request("POST", f"/studies/{quote(uid)}/report/commit", user, body)
        self.assertEqual(result.status, expect, f"{action}: {result.text[:400]}")
        return result.body

    def head(self, uid: str) -> int:
        value = psql('SELECT coalesce(version, 0)::text FROM "Report" WHERE uid=' + lit(uid))
        return int(value[0]) if value else 0

    def together(self, *calls):
        """Run the calls at the same moment on their own connections; their results in call order."""
        gate, out = threading.Barrier(len(calls)), [None] * len(calls)

        def run(index, call):
            gate.wait()
            out[index] = call()
        threads = [threading.Thread(target=run, args=(i, call)) for i, call in enumerate(calls)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(120)
        return out

    # ── cases ──
    def test_reading_01_one_request_per_study_shown_on_both_screens(self) -> None:
        f = self.study()
        before = self.fields(f.uid)
        made = self.ask("rclin", f.uid, 201)
        self.assertEqual((made["created"], made["owner"]), (True, self.owner("rclin")))
        self.assertEqual(sorted(made["readingRequest"]), ["at", "by", "closedAt", "open"])
        self.assertEqual((made["readingRequest"]["open"], made["readingRequest"]["closedAt"]), (True, None))
        self.assertEqual(self.audits(f.uid), 1)
        # Another clinician's press: the same request, as it is; nothing written.
        again = self.ask("rclin2", f.uid, 200)
        self.assertEqual((again["created"], again["readingRequest"]), (False, made["readingRequest"]))
        self.assertEqual(self.audits(f.uid), 1)
        after = self.fields(f.uid)
        self.assertEqual(after["bySub"], self.stack.user_ids["rclin"])
        # The request is its own fact: the report state, hold and signer are as they were.
        self.assertEqual({k: after[k] for k in ("rs", "holder", "repDoc", "approvedAt")},
                         {k: before[k] for k in ("rs", "holder", "repDoc", "approvedAt")})
        self.assertEqual(self.head(f.uid), 0, "no report row")
        # The worklist row and the clinician row show it.
        self.assertEqual(self.worklist_row(f.uid)["readingRequest"], {"at": made["readingRequest"]["at"], "by": made["readingRequest"]["by"]})
        row = self.clinician_row(f.uid, "rclin2")
        self.assertEqual((row["readingRequest"], row["readingRequestable"]), (made["readingRequest"], False))
        # Two presses at the same moment on two connections: one request, one audit row.
        g = self.study()
        first, second = self.together(
            lambda: self.stack.request("POST", f"/studies/{quote(g.uid)}/reading-request", "rclin", {"expectedOwner": self.owner("rclin")}),
            lambda: self.stack.request("POST", f"/studies/{quote(g.uid)}/reading-request", "rclin2", {"expectedOwner": self.owner("rclin2")}))
        self.assertEqual(sorted([first.status, second.status]), [200, 201], (first.text[:300], second.text[:300]))
        self.assertEqual(first.body["readingRequest"], second.body["readingRequest"])
        self.assertEqual(self.audits(g.uid), 1)

    def test_reading_02_refusals_write_nothing_and_a_requested_study_is_not_deleted(self) -> None:
        f = self.study()
        self.ask("rrad", f.uid, 403, "READING_REQUEST_ROLE_REQUIRED")
        self.ask("radmin", f.uid, 403, "READING_REQUEST_ROLE_REQUIRED")
        self.ask("rkclin", f.uid, 404, "STUDY_NOT_FOUND")
        self.ask("rclin", f.uid, 409, "OWNER_CHANGED", owner=[self.owner("rclin")[0], "kin-test-someone-else"])
        self.assertEqual(self.audits(f.uid), 0)
        self.assertIsNone(self.fields(f.uid)["at"])
        self.assertIsNone(self.worklist_row(f.uid)["readingRequest"])
        self.ask("rclin", f.uid, 201)
        deleted = self.stack.request("DELETE", f"/studies/{quote(f.uid)}", "rtech")
        self.assertEqual((deleted.status, deleted.body.get("code")), (409, "STUDY_HAS_READING_REQUEST"), deleted.text[:300])
        self.assertIsNotNone(self.fields(f.uid)["at"])

    def test_reading_03_the_approval_closes_it_and_a_reset_keeps_it_closed(self) -> None:
        f = self.study()
        made = self.ask("rclin", f.uid, 201)["readingRequest"]
        # A save and a hold are not an approval: still open on the worklist.
        self.commit(f.uid, "rrad", "save", self.head(f.uid), findings="SYNTHETIC reading request findings")
        self.commit(f.uid, "rrad", "defer", self.head(f.uid), findings="SYNTHETIC reading request findings", reason="SYNTHETIC hold")
        self.assertIsNotNone(self.worklist_row(f.uid)["readingRequest"])
        self.assertIsNone(self.fields(f.uid)["closedAt"])
        # A refused approval (a stale base version) leaves it open.
        self.commit(f.uid, "rrad", "approve", self.head(f.uid) + 5, expect=409, findings="SYNTHETIC reading request findings")
        self.assertIsNone(self.fields(f.uid)["closedAt"])
        # The approval closes it with the approval's own time.
        self.commit(f.uid, "rrad", "approve", self.head(f.uid), findings="SYNTHETIC reading request findings")
        closed = self.fields(f.uid)
        self.assertEqual(closed["rs"], "A")
        self.assertIsNotNone(closed["closedAt"])
        self.assertEqual(closed["closedAt"], closed["approvedAt"])
        self.assertIsNone(self.worklist_row(f.uid)["readingRequest"])
        row = self.clinician_row(f.uid)
        self.assertEqual((row["readingRequest"]["open"], row["readingRequest"]["at"], row["readingRequestable"]), (False, made["at"], False))
        self.assertIsNotNone(row["readingRequest"]["closedAt"])
        self.ask("rclin", f.uid, 409, "READING_REQUEST_REPORTED")
        self.assertEqual(self.audits(f.uid), 1)
        # Reset to Unread: the request stays closed (the approval happened); a new press is a new request.
        self.commit(f.uid, "rrad", "reset", self.head(f.uid), reason="SYNTHETIC reading request reset")
        kept = self.fields(f.uid)
        self.assertEqual((kept["rs"], kept["closedAt"]), ("W", closed["closedAt"]))
        self.assertIsNone(self.worklist_row(f.uid)["readingRequest"])
        self.assertTrue(self.clinician_row(f.uid)["readingRequestable"])
        again = self.ask("rclin2", f.uid, 201)["readingRequest"]
        self.assertEqual((again["open"], again["closedAt"]), (True, None))
        self.assertEqual(self.audits(f.uid), 2)
        self.assertIsNotNone(self.worklist_row(f.uid)["readingRequest"])

    def test_reading_04_a_merged_exam_and_an_approval_racing_a_press(self) -> None:
        patient = "SYN-RREQ-" + uuid.uuid4().hex[:12]
        a, b = self.study(patient), self.study(patient)
        self.ask("rclin", b.uid, 201)
        merged = self.stack.request("POST", "/exam-groups", "rtech", {"baseUid": a.uid, "uids": [a.uid, b.uid]})
        self.assertEqual(merged.status, 200, merged.text[:400])

        def ungroup():
            groups = psql(f'SELECT DISTINCT "groupId" FROM "StudyGroupMember" WHERE "studyUid" IN ({lit(a.uid)},{lit(b.uid)})')
            if groups:
                ids = ",".join(lit(g) for g in groups)
                # This connection only removes the test's own synthetic group after its assertions.
                psql(f'BEGIN; SET LOCAL session_replication_role=replica; '
                     f'DELETE FROM "StudyGroupMember" WHERE "groupId" IN ({ids}); DELETE FROM "StudyGroup" WHERE id IN ({ids}); COMMIT;')
            psql(f'UPDATE "Report" SET "groupId"=NULL WHERE uid IN ({lit(a.uid)},{lit(b.uid)}); '
                 f'UPDATE "ReportVersion" SET "groupId"=NULL WHERE uid IN ({lit(a.uid)},{lit(b.uid)});')
        self.addCleanup(ungroup)
        # The merged study is not a row of its own; its request shows on the base row.
        self.assertIsNone(self.worklist_row(b.uid))
        self.assertIsNotNone(self.worklist_row(a.uid)["readingRequest"])
        # The base row's approval closes the request kept on the merged study.
        self.commit(a.uid, "rrad", "approve", self.head(a.uid), findings="SYNTHETIC merged exam findings")
        self.assertIsNotNone(self.fields(b.uid)["closedAt"])
        self.assertEqual(self.fields(b.uid)["closedAt"], self.fields(a.uid)["approvedAt"])
        self.assertIsNone(self.worklist_row(a.uid)["readingRequest"])
        # Asked after the merge, on the merged study: the clinician row offers the press (the base row is not approved) and
        # the request shows on the base row.
        later = "SYN-RREQ-" + uuid.uuid4().hex[:12]
        d, e = self.study(later), self.study(later)
        regrouped = self.stack.request("POST", "/exam-groups", "rtech", {"baseUid": d.uid, "uids": [d.uid, e.uid]})
        self.assertEqual(regrouped.status, 200, regrouped.text[:400])

        def ungroup_later():
            groups = psql(f'SELECT DISTINCT "groupId" FROM "StudyGroupMember" WHERE "studyUid" IN ({lit(d.uid)},{lit(e.uid)})')
            if groups:
                ids = ",".join(lit(g) for g in groups)
                psql(f'BEGIN; SET LOCAL session_replication_role=replica; '
                     f'DELETE FROM "StudyGroupMember" WHERE "groupId" IN ({ids}); DELETE FROM "StudyGroup" WHERE id IN ({ids}); COMMIT;')
        self.addCleanup(ungroup_later)
        self.assertEqual((self.clinician_row(e.uid)["readingRequestable"], self.clinician_row(e.uid)["readingRequestRefusal"]), (True, None))
        self.ask("rclin", e.uid, 201)
        self.assertIsNotNone(self.worklist_row(d.uid)["readingRequest"])
        self.assertFalse(self.clinician_row(e.uid)["readingRequestable"])
        # An approval and a press at the same moment: either the press is refused or the approval closes it.
        c = self.study()
        self.commit(c.uid, "rrad", "save", 0, findings="SYNTHETIC race findings")
        base = self.head(c.uid)
        approved, pressed = self.together(
            lambda: self.stack.request("POST", f"/studies/{quote(c.uid)}/report/commit", "rrad",
                                       {"action": "approve", "baseVersion": base, "findings": "SYNTHETIC race findings",
                                        "conclusion": "", "recommendation": ""}),
            lambda: self.stack.request("POST", f"/studies/{quote(c.uid)}/reading-request", "rclin", {"expectedOwner": self.owner("rclin")}))
        self.assertEqual(approved.status, 201, approved.text[:400])
        self.assertIn(pressed.status, (201, 409), pressed.text[:300])
        now = self.fields(c.uid)
        self.assertEqual(now["rs"], "A")
        if pressed.status == 409:
            self.assertEqual(pressed.body.get("code"), "READING_REQUEST_REPORTED")
            self.assertIsNone(now["at"])
        else:
            self.assertEqual(now["closedAt"], now["approvedAt"], "a request made before the approval committed is closed by it")
        self.assertIsNone(self.worklist_row(c.uid)["readingRequest"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
