# coding: utf-8
"""In-app unread marks on the real Nest guard and services, PostgreSQL, Keycloak and Orthanc (API level).

The rule (clinician-question.service.ts and image-request.service.ts unread() and seen()): an item is unread for a person
while it holds an entry by someone else, of the kinds the person's view waits for, above the revision their own seen mark
records, and the person may see the item by the list's own filter. Cases, each on its own synthetic study:

  unread_01  a question: every radiologist of the institution counts it (question-inbox), the asking clinician and another
             clinician do not, the other institution and an admin-only member do not (available false); one radiologist's
             seen mark clears it for that radiologist only and never rises above the thread's revision; the answer moves it
             out of the inbox and into the asking clinician's question-mine with the answer's revision until that clinician's
             seen mark; a follow-up brings it back to the inbox. Seen marks of a thread outside the caller's view are refused
             (another clinician 404, another institution 404, admin-only 403).
  unread_02  an image request: the requester counts each staff change (accept, close) until their seen mark; another
             clinician, staff and the other institution may not mark it; a radiologist has no request view.
  unread_03  a study moved to another institution: its question leaves every count of the first institution and its seen
             mark is refused as a read is.

Synthetic stack only, through scripts/run-tests.py (LiveStack refuses any other entry):

    python scripts/run-tests.py --module tests/e2e/test_in_app_unread.py --class InAppUnreadE2E --mode live --unit ci-in-app-unread --timeout 900

It runs on a hosted runner through the dispatch-only Focused integration profile in-app-unread (tests/measurement_ci.py).
Owned data only: run-created Keycloak users (kin-test-*), the realm role `clinician` only when this run had to create it,
one synthetic C-STORE study per case, the question and image request rows written on those studies (their seen marks go
with them) and their audit rows. unread_03 moves its own study's owner with psql and moves it back in a finally block.
"""
from __future__ import annotations

import sys
import unittest
import uuid
from pathlib import Path
from urllib.parse import quote

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from invariants_live import LiveStack, psql  # noqa: E402
from clinician_question_live import ask_question, drop_study_questions, lit, member_owner  # noqa: E402
from clinician_request_live import drop_study_image_requests, make_image_request  # noqa: E402

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

IDENTITIES = (
    ("uclin", ["clinician"], "hallym"),
    ("uclin2", ["clinician"], "hallym"),
    ("ukclin", ["clinician"], "kin-center"),
    ("urada", ["radiologist"], "hallym"),
    ("uradb", ["radiologist"], "hallym"),
    ("ukrad", ["radiologist"], "kin-center"),
    ("uadmin", ["admin"], "hallym"),
    ("utech", ["technician"], "hallym"),
)


class InAppUnreadE2E(unittest.TestCase):
    maxDiff = None

    @classmethod
    def setUpClass(cls) -> None:
        cls.stack = LiveStack()
        cls.owners: dict[str, list[str]] = {}
        cls.created_role = False
        cls.addClassCleanup(cls.stack.cleanup_test_identities)
        cls.addClassCleanup(cls.stack.cleanup_all)
        cls.addClassCleanup(cls.drop_all)
        cls.stack.require_stack()
        role = cls.stack.kc_admin("GET", "/roles/clinician")
        if role.status == 404:
            created = cls.stack.kc_admin("POST", "/roles", {"name": "clinician", "description": "temporary in-app unread clinician role"})
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

    @classmethod
    def drop(cls, uid: str) -> None:
        owned = set(cls.stack.user_ids.values())
        drop_study_questions(uid, owned)
        drop_study_image_requests(uid, owned)

    @classmethod
    def drop_all(cls) -> None:
        for uid in list(cls.stack.active):
            cls.drop(uid)

    # ── helpers ──
    def study(self):
        fixture = self.stack.create_fixture()
        self.addCleanup(self.stack.cleanup_fixture, fixture.uid)
        self.addCleanup(self.drop, fixture.uid)
        return fixture

    def owner(self, user: str) -> list[str]:
        if user not in self.owners:
            self.owners[user] = member_owner(self.stack, user)
        return self.owners[user]

    def unread(self, user: str, view: str) -> dict:
        """Every page of one view: {available, count, items: {id: (studyUid, revision)}}."""
        items, cursor = {}, None
        for _ in range(50):
            result = self.stack.request("GET", f"/unread?view={view}" + (f"&cursor={quote(cursor)}" if cursor else ""), user)
            self.assertEqual(result.status, 200, result.text[:500])
            body = result.body
            self.assertEqual(body["owner"], self.owner(user))
            self.assertEqual(body["view"], view)
            for item in body["items"]:
                self.assertEqual(sorted(item), ["id", "openUid", "revision", "studyUid"], "no body, author or report")
                # The row the item opens on: a never-grouped study is itself (exam-merge.service.ts examOpenUids).
                self.assertEqual(item["openUid"], item["studyUid"])
                items[item["id"]] = (item["studyUid"], item["revision"])
            cursor = body["nextCursor"]
            if cursor is None:
                break
        self.assertLessEqual(len(items), body["count"])
        return {"available": body["available"], "count": body["count"], "items": items}

    def has(self, user: str, view: str, item_id: str):
        """The listed revision of item_id in the user's view, or None."""
        found = self.unread(user, view)["items"].get(item_id)
        return None if found is None else found[1]

    def seen(self, user: str, path: str, item_id: str, revision: int, expect: int = 201, code: str | None = None):
        result = self.stack.request("POST", f"/{path}/{quote(item_id)}/seen", user,
                                    {"expectedOwner": self.owner(user), "revision": revision})
        self.assertEqual(result.status, expect, result.text[:500])
        if code is not None:
            self.assertEqual(result.body.get("code"), code, result.text[:500])
        return result.body

    def stored(self, table: str, column: str, item_id: str, user: str):
        rows = psql(f'SELECT "revision" FROM "{table}" WHERE "{column}"={lit(item_id)}::uuid AND "subjectSub"={lit(self.stack.user_ids[user])}')
        return int(rows[0]) if rows else None

    def write(self, user: str, path: str, body: dict, expect: int = 201):
        result = self.stack.request("POST", path, user, {"requestId": str(uuid.uuid4()), "expectedOwner": self.owner(user), **body})
        self.assertEqual(result.status, expect, result.text[:500])
        return result.body

    # ── cases ──
    def test_unread_01_question_answer_followup(self) -> None:
        f = self.study()
        _rid, asked = ask_question(self.stack, "uclin", f.uid, self.owner("uclin"), "SYNTHETIC unread question")
        self.assertEqual(asked.status, 201, asked.text[:500])
        qid = asked.body["applied"]["id"]
        self.assertEqual(self.has("urada", "question-inbox", qid), 1)
        self.assertEqual(self.has("uradb", "question-inbox", qid), 1)
        self.assertIsNone(self.has("uclin", "question-mine", qid), "one's own question is not unread for oneself")
        self.assertIsNone(self.has("uclin2", "question-mine", qid))
        self.assertIsNone(self.has("ukrad", "question-inbox", qid), "another institution never counts it")
        self.assertFalse(self.unread("uadmin", "question-inbox")["available"], "an admin-only member has no inbox view")
        self.assertFalse(self.unread("urada", "question-mine")["available"])
        # One radiologist's mark: never above the thread's revision, never down, and the other radiologist still counts it.
        self.assertEqual(self.seen("urada", "questions", qid, 99)["seen"], {"id": qid, "revision": 1})
        self.assertEqual(self.stored("StudyQuestionSeen", "questionId", qid, "urada"), 1)
        self.assertIsNone(self.has("urada", "question-inbox", qid))
        self.assertEqual(self.has("uradb", "question-inbox", qid), 1)
        # Refused marks: outside the caller's view, as a read is.
        self.seen("uclin2", "questions", qid, 1, 404, "QUESTION_NOT_FOUND")
        self.seen("ukclin", "questions", qid, 1, 404, "QUESTION_NOT_FOUND")
        self.seen("ukrad", "questions", qid, 1, 404, "QUESTION_NOT_FOUND")
        self.seen("uadmin", "questions", qid, 1, 403, "QUESTION_ACTION_FORBIDDEN")
        self.assertIsNone(self.stored("StudyQuestionSeen", "questionId", qid, "uclin2"))
        # The answer: out of the inbox (Answered waits for nobody there), into the asker's view at the answer's revision.
        self.write("uradb", f"/questions/{quote(qid)}/entries", {"revision": 1, "body": "SYNTHETIC unread answer"})
        self.assertIsNone(self.has("urada", "question-inbox", qid))
        self.assertIsNone(self.has("uradb", "question-inbox", qid))
        self.assertEqual(self.has("uclin", "question-mine", qid), 2)
        self.assertIsNone(self.has("uclin2", "question-mine", qid), "another clinician never counts it")
        self.assertEqual(self.seen("uclin", "questions", qid, 2)["seen"]["revision"], 2)
        self.assertIsNone(self.has("uclin", "question-mine", qid))
        self.assertEqual(self.seen("uclin", "questions", qid, 1)["seen"]["revision"], 2, "a mark never goes down")
        # A follow-up opens it again for the pool, above the first radiologist's mark.
        self.write("uclin", f"/questions/{quote(qid)}/entries", {"revision": 2, "body": "SYNTHETIC unread follow-up"})
        self.assertEqual(self.has("urada", "question-inbox", qid), 3)
        self.assertEqual(self.has("uradb", "question-inbox", qid), 3)
        self.assertIsNone(self.has("uclin", "question-mine", qid))

    def test_unread_02_image_request_processed(self) -> None:
        f = self.study()
        _rid, made = make_image_request(self.stack, "uclin", f.uid, self.owner("uclin"))
        self.assertEqual(made.status, 201, made.text[:500])
        rid = made.body["applied"]["id"]
        self.assertIsNone(self.has("uclin", "image-request-mine", rid), "the requester's own create is not unread")
        self.write("utech", f"/image-requests/{quote(rid)}", {"revision": 1, "action": "accept", "note": ""})
        self.assertEqual(self.has("uclin", "image-request-mine", rid), 2)
        self.assertIsNone(self.has("uclin2", "image-request-mine", rid))
        self.assertIsNone(self.has("ukclin", "image-request-mine", rid))
        self.assertFalse(self.unread("urada", "image-request-mine")["available"], "a radiologist has no request view")
        self.assertFalse(self.unread("utech", "image-request-mine")["available"], "staff wait for no processing result")
        self.seen("uclin2", "image-requests", rid, 2, 404, "IMAGE_REQUEST_NOT_FOUND")
        self.seen("ukclin", "image-requests", rid, 2, 404, "IMAGE_REQUEST_NOT_FOUND")
        self.seen("utech", "image-requests", rid, 2, 403, "IMAGE_REQUEST_ACTION_FORBIDDEN")
        self.assertEqual(self.seen("uclin", "image-requests", rid, 2)["seen"], {"id": rid, "revision": 2})
        self.assertIsNone(self.has("uclin", "image-request-mine", rid))
        self.write("utech", f"/image-requests/{quote(rid)}", {"revision": 2, "action": "close", "note": "SYNTHETIC processed"})
        self.assertEqual(self.has("uclin", "image-request-mine", rid), 3)
        self.assertEqual(self.seen("uclin", "image-requests", rid, 3)["seen"]["revision"], 3)
        self.assertIsNone(self.has("uclin", "image-request-mine", rid))
        self.assertEqual(self.stored("StudyImageRequestSeen", "imageRequestId", rid, "uclin"), 3)

    def test_unread_03_a_moved_study_leaves_every_count(self) -> None:
        f = self.study()
        _rid, asked = ask_question(self.stack, "uclin", f.uid, self.owner("uclin"), "SYNTHETIC unread moved question")
        self.assertEqual(asked.status, 201, asked.text[:500])
        qid = asked.body["applied"]["id"]
        self.write("urada", f"/questions/{quote(qid)}/entries", {"revision": 1, "body": "SYNTHETIC unread answer"})
        self.assertEqual(self.has("uclin", "question-mine", qid), 2)
        self.assertRegex(f.uid, r"^[0-9]+(?:\.[0-9]+)+$")
        before = psql(f'SELECT "institutionId" FROM "StudyState" WHERE uid={lit(f.uid)}')
        self.assertEqual(before, ["hallym"])
        psql(f'UPDATE "StudyState" SET "institutionId"=\'kin-center\' WHERE uid={lit(f.uid)}')
        try:
            self.assertIsNone(self.has("uclin", "question-mine", qid))
            self.assertIsNone(self.has("ukclin", "question-mine", qid), "the creating institution stays the question's")
            self.seen("uclin", "questions", qid, 2, 404, "QUESTION_NOT_FOUND")
            self.assertIsNone(self.stored("StudyQuestionSeen", "questionId", qid, "uclin"))
        finally:
            psql(f'UPDATE "StudyState" SET "institutionId"=\'hallym\' WHERE uid={lit(f.uid)}')
        self.assertEqual(self.has("uclin", "question-mine", qid), 2)


def load_tests(loader, tests, pattern):
    return loader.loadTestsFromTestCase(InAppUnreadE2E)


if __name__ == "__main__":
    unittest.main()
