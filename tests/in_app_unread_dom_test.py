# coding: utf-8
"""In-app unread marks on both screens (unread-badges.js with clinician.js and the reading screen's question row).

The server's rule (GET unread, clinician-question.service.ts and image-request.service.ts unread()) is kept here by an
in-test server over the question harness of tests/clinician_question_dom_test.py: an item is unread for a person while it
holds an entry by someone else of the kinds the view waits for (inbox: an Open thread's question or follow-up; mine: an
answer or a reasoned close of the person's own thread; image-request-mine: a staff state change of the person's own
request) above the revision the person's seen mark records. The screens are the shipped files.

  Clinician Home (clinician.html + clinician.js + unread-badges.js)
  01  an answered own thread: the row's Report cell says New Answers 1 and the list head New Answers 1; the thread row in
      Questions says New; nothing is sent before the thread is drawn; drawing it sends POST questions/:id/seen with the
      drawn revision and the account; the counts are read again and every mark goes away (the server says 0).
  02  a seen write that fails (503, a dropped connection) leaves every mark; opening the thread again sends again and then
      the marks go. A closed Questions section sends nothing.
  03  a request processed by staff: Processed 1 on the row and the head; opening Image Requests sends
      POST image-requests/:id/seen with the drawn revision; then 0.
  04  an unread thread outside the study's latest 50: a row that opens it (GET questions/:id), and its seen mark.
  05  an unread answer naming another account: the page stops and shows no mark.
  08  a count read that fails keeps the last marks (never a made-up 0); a refused one (403) clears them.
  09  a merged exam (A holds B): an answer on B's thread is marked on A's row (the server's openUid), not on B's; A's
      Questions lists B's thread (the server's scope names B), it opens and its seen mark is sent.
  13  merged, then undone: A's row keeps its old merged scope, the server answers B on B; B's new answer and processed
      request are marked on B's row only.
  Reading screen (the S5-U4b block of main.html as shipped, with unread-badges.js before it)
  06  no study chosen: the band's New Questions 1 after the list poll; it opens the Inbox on Open questions, the row says
      New, Open Study draws the thread and sends its seen mark; the band's mark goes. An admin-only session (no inbox
      view) shows nothing; offline sends nothing.
  10  a thread drawn while its pane is laid out is seen; a follow-up read while the reading pane is not laid out (another
      work tab) sends no seen mark for the new revision.
  11  the Inbox question of a merged exam's original opens on the row the server names (openUid = the exam's row).
  14  a split exam: a question on part one (A) opens on A's row even when part two's row, listed first, holds the same
      original.
  12  the band's count stands after the two notices and steps aside while the move/insert notice stands.

Synthetic data only (SYN-* names): no server, no network, no credentials.
"""
import copy
import json
import re
import sys
import unittest
import uuid
from pathlib import Path
from urllib.parse import parse_qs, urlparse, unquote

sys.path.insert(0, str(Path(__file__).resolve().parent))
import clinician_question_dom_test as q  # noqa: E402  (the module, never its classes at this module's top level)
from playwright.sync_api import expect  # noqa: E402

UNREAD_JS = q.lf_text(q.HPACS / "unread-badges.js")
TECH = {"sub": "SYN-TECH-SUB", "actor": "syn-tech@kin", "name": "SYN Technician"}


class UnreadServer:
    """The unread rule and the seen marks over the question harness's store and a small image request store."""

    def __init__(self, questions):
        self.questions = questions
        self.seen = {}
        self.requests = {}
        self.clock = 0

    def at(self):
        self.clock += 1
        return f"2026-09-27T00:{self.clock // 60:02d}:{self.clock % 60:02d}.000Z"

    def add_request(self, u, requester, state="Closed", handler=TECH):
        rid = str(uuid.uuid4())
        events = [("create", requester["sub"])]
        if state in ("Accepted", "Closed", "Declined"):
            events.append(("accept", handler["sub"]))
        if state in ("Closed", "Declined"):
            events.append(("close" if state == "Closed" else "decline", handler["sub"]))
        at = self.at()
        self.requests[rid] = {"id": rid, "studyUid": u, "kind": "image-transfer", "state": state, "revision": len(events),
                              "requester": {"actor": requester["actor"], "name": requester["name"]}, "requesterSub": requester["sub"],
                              "counterparty": {"text": "SYN receiving hospital", "institutionId": None}, "reason": "SYN reason",
                              "handler": None if state == "Requested" else {"actor": handler["actor"], "name": handler["name"]},
                              "note": None if state in ("Requested", "Accepted") else "SYN processing note",
                              "createdAt": at, "updatedAt": at, "events": events}
        return self.requests[rid]

    @staticmethod
    def dto(row):
        return {k: copy.deepcopy(v) for k, v in row.items() if k not in ("events", "requesterSub")}

    def unread_items(self, caller, view):
        sub, actor = caller["sub"], caller["actor"]
        out = []
        if view in ("question-mine", "question-inbox"):
            for t in self.questions.threads.values():
                if t["institution"] != caller["institution"] or t["studyUid"] not in self.questions.owned:
                    continue
                mine = view == "question-mine"
                if mine and t["authorSub"] != sub or not mine and t["state"] != "Open":
                    continue
                kinds = ("answer", "close") if mine else ("question", "followup")
                seen = self.seen.get(("question", sub, t["id"]), 0)
                if any(e["kind"] in kinds and e["author"]["actor"] != actor and e["seq"] > seen for e in t["entries"]):
                    out.append(t)
        else:
            for r in self.requests.values():
                seen = self.seen.get(("image-request", sub, r["id"]), 0)
                if r["requesterSub"] == sub and any(action != "create" and who != sub and n + 1 > seen
                                                   for n, (action, who) in enumerate(r["events"])):
                    out.append(r)
        return sorted(out, key=lambda row: (row["createdAt"], row["id"]), reverse=True)

    def unread(self, caller, query):
        owner = [caller["institution"], caller["sub"]]
        view = (query.get("view") or [None])[0]
        if set(query) - {"view", "cursor"} or view not in ("question-mine", "question-inbox", "image-request-mine"):
            return 400, {"code": "QUESTION_INPUT_INVALID", "message": "안 읽음 구분(view)을 확인하세요"}
        role = "radiologist" if view == "question-inbox" else "clinician"
        if role not in caller["roles"]:
            return 200, {"owner": owner, "view": view, "available": False, "count": 0, "items": [], "nextCursor": None}
        rows = self.unread_items(caller, view)
        return 200, {"owner": owner, "view": view, "available": True, "count": len(rows),
                     "items": [{"id": r["id"], "studyUid": r["studyUid"], "revision": r["revision"],
                                "openUid": self.questions.open_uid(r["studyUid"])} for r in rows[:100]],
                     "nextCursor": None}

    def mark(self, caller, kind, rid, body):
        owner = [caller["institution"], caller["sub"]]
        if not isinstance(body, dict) or set(body) != {"expectedOwner", "revision"} or not isinstance(body["revision"], int) or body["revision"] < 1:
            return 400, {"code": "QUESTION_INPUT_INVALID", "message": "기준 revision을 확인하세요"}
        if body["expectedOwner"] != owner:
            return 409, {"code": "OWNER_CHANGED", "message": "로그인한 계정이 바뀌었습니다"}
        if kind == "question":
            row = self.questions.visible(caller, rid, self.questions.scope(caller))
            if row is None:
                return 404, {"code": "QUESTION_NOT_FOUND", "message": "질문을 찾을 수 없습니다"}
            if ("clinician" if row["authorSub"] == caller["sub"] else "radiologist") not in caller["roles"]:
                return 403, {"code": "QUESTION_ACTION_FORBIDDEN", "message": "이 질문에 이 동작을 할 수 없습니다"}
        else:
            row = self.requests.get(rid)
            if row is None or row["requesterSub"] != caller["sub"]:
                return 404, {"code": "IMAGE_REQUEST_NOT_FOUND", "message": "영상 요청을 찾을 수 없습니다"}
        key = (kind, caller["sub"], row["id"])
        self.seen[key] = max(self.seen.get(key, 0), min(body["revision"], row["revision"]))
        return 201, {"owner": owner, "seen": {"id": row["id"], "revision": self.seen[key]}}


class InAppUnreadDOMTest(q.ClinicianQuestionDOMTest):
    """The cases of this file only (load_tests): the inherited question cases run in their own module."""

    def setUp(self):
        super().setUp()
        self.files["unread-badges.js"] = UNREAD_JS
        self.unread = UnreadServer(self.server)
        self.unread_reads, self.seen_posts, self.request_reads = [], [], []
        self.unread_fault = None
        self.seen_faults = []
        self.unread_owner = None

    def route(self, route):
        request = route.request
        url = urlparse(request.url)
        method, path = request.method, url.path
        query = parse_qs(url.query, keep_blank_values=True)
        if method == "GET" and path == "/api/unread":
            self.unread_reads.append(query.get("view", [None])[0])
            status, body = self.unread.unread(self.me, query)
            if self.unread_owner is not None:
                body = {**body, "owner": self.unread_owner}
            if self.unread_fault:
                status, body = self.unread_fault
            route.fulfill(status=status, json=body)
            return
        found = re.fullmatch(r"/api/(questions|image-requests)/([^/]+)/seen", path)
        if method == "POST" and found:
            body = request.post_data_json
            self.seen_posts.append({"path": path, "body": copy.deepcopy(body)})
            fault = self.seen_faults.pop(0) if self.seen_faults else None
            if fault == "abort":
                route.abort("connectionreset")
                return
            if fault is not None:
                route.fulfill(status=fault, json={"code": "SYN", "message": "SYN failure"})
                return
            status, payload = self.unread.mark(self.me, "question" if found.group(1) == "questions" else "image-request",
                                               unquote(found.group(2)), body)
            route.fulfill(status=status, json=payload)
            return
        owner = [self.me.get("institution"), self.me.get("sub")] if isinstance(self.me, dict) else None
        if self.MERGED and method == "GET" and path == f"/api/studies/{q.A}/questions":
            rows = [t for t in self.server.threads.values() if t["studyUid"] in (q.A, q.B)
                    and (q.QuestionServer.scope(self.me) == "all" or t["authorSub"] == self.me["sub"])]
            self.q_requests.append({"kind": "list", "method": method, "path": path, "query": {}, "body": None})
            route.fulfill(json={"owner": owner, "scope": self.merged_scope(),
                                "items": [q.QuestionServer.summary(t) for t in self.server.newest(rows)[:50]]})
            return
        found = re.fullmatch(r"/api/studies/([^/]+)/image-requests", path)
        if method == "GET" and found:
            u = unquote(found.group(1))
            self.request_reads.append(path)
            rows = [UnreadServer.dto(r) for r in self.unread.requests.values() if r["studyUid"] == u and r["requesterSub"] == self.me["sub"]]
            route.fulfill(json={"owner": owner, "items": sorted(rows, key=lambda r: r["createdAt"], reverse=True)[:50]})
            return
        found = re.fullmatch(r"/api/image-requests/([^/]+)", path)
        if method == "GET" and found:
            row = self.unread.requests.get(unquote(found.group(1)))
            self.request_reads.append(path)
            route.fulfill(status=200 if row else 404, json={"owner": owner, "item": UnreadServer.dto(row)} if row else {"code": "IMAGE_REQUEST_NOT_FOUND"})
            return
        if method == "GET" and path == "/api/image-requests":
            rows = [UnreadServer.dto(r) for r in self.unread.requests.values() if r["requesterSub"] == self.me["sub"]]
            route.fulfill(json={"owner": owner, "items": rows, "nextCursor": None})
            return
        super().route(route)

    # ── helpers ──
    # Merge Exam: A's exam holds A and B (the server answers for it on A). Per-study reads of A list both originals' items
    # with the exam scope, as clinician-question.service.ts and image-request.service.ts forStudy() do.
    MERGED = None

    def merged_scope(self):
        return {"reportUid": q.A, "groupId": "SYN-GROUP-1", "kind": "merge", "part": None, "active": True,
                "sources": [{"studyUid": q.A, "series": {"mode": "all", "uids": []}}, {"studyUid": q.B, "series": {"mode": "all", "uids": []}}],
                "generation": "SYN-GEN-1"}

    def answered(self, u, body="SYN question"):
        thread = self.server.seed(u, q.CLINICIAN, body)
        self.server.step(thread, "answer", q.RADIOLOGIST, "radiologist", "SYN answer")
        return thread

    def row_tags(self, u):
        return self.page.evaluate("u => [...document.querySelectorAll(`#studies tr[data-uid='${u}'] td[data-report] [data-unread]`)].map(t => t.textContent)", u)

    def summary(self):
        return self.page.evaluate("() => { const s = document.querySelector('#unread-summary'); return s && !s.hidden ? s.textContent : null; }")

    def settled_counts(self, reads):
        self.wait_until(lambda: len(self.unread_reads) >= reads, f"{reads} unread reads")
        self.settle()

    # ── Clinician Home ──
    def test_u01_answered_thread_is_marked_until_drawn(self):
        thread = self.answered(q.A)
        self.open_home()
        self.settled_counts(2)
        self.assertEqual(["New Answers 1"], self.row_tags(q.A))
        self.assertEqual([], self.row_tags(q.B))
        self.assertEqual("New Answers 1", self.summary())
        self.pick(q.A)
        self.open_questions("ready")
        expect(self.page.locator(f'#question-list > li[data-id="{thread["id"]}"] [data-unread="item"]')).to_have_text("New")
        self.settle()
        self.assertEqual([], self.seen_posts, "nothing is seen before the thread is drawn")
        reads = len(self.unread_reads)
        self.open_thread(thread["id"], "Answered")
        self.wait_until(lambda: len(self.seen_posts) == 1, "the seen write")
        self.assertEqual({"path": f"/api/questions/{thread['id']}/seen",
                          "body": {"expectedOwner": [q.INSTITUTION, q.CLINICIAN["sub"]], "revision": 2}}, self.seen_posts[0])
        self.settled_counts(reads + 2)
        self.assertEqual([], self.row_tags(q.A))
        self.assertIsNone(self.summary())
        expect(self.page.locator("#question-list [data-unread]")).to_have_count(0)
        self.assertEqual(2, self.unread.seen[("question", q.CLINICIAN["sub"], thread["id"])])
        # A later answer is new again; the server's count, not the page's, brings it back.
        self.server.step(thread, "answer", q.RADIOLOGIST_TWO, "radiologist", "SYN second answer")
        self.page.locator("#refresh").click()
        self.wait_until(lambda: self.summary() == "New Answers 1", "the second answer marked")

    def test_u02_a_failed_seen_write_keeps_the_marks(self):
        thread = self.answered(q.A)
        self.open_home()
        self.settled_counts(2)
        self.pick(q.A)
        self.open_questions("ready")
        for fault in (503, "abort"):
            with self.subTest(fault=fault):
                self.seen_faults.append(fault)
                posts = len(self.seen_posts)
                self.page.locator(f'#question-list > li[data-id="{thread["id"]}"] button[data-open-thread]').click()
                self.wait_until(lambda: len(self.seen_posts) == posts + 1, "the seen write")
                self.settle()
                self.assertEqual("New Answers 1", self.summary(), "not seen as far as the server answered")
                self.assertEqual(["New Answers 1"], self.row_tags(q.A))
                self.assertNotIn(("question", q.CLINICIAN["sub"], thread["id"]), self.unread.seen)
                self.page.locator("#questions-summary").click()   # close the section: the thread is not shown
                self.settle()
                self.page.locator("#questions-summary").click()
                self.listed("ready")
        self.page.locator(f'#question-list > li[data-id="{thread["id"]}"] button[data-open-thread]').click()
        self.wait_until(lambda: self.summary() is None, "the marks gone after a stored seen write")
        self.assertEqual([], self.row_tags(q.A))

    def test_u03_processed_request_is_marked_until_the_section_shows_it(self):
        request = self.unread.add_request(q.A, q.CLINICIAN, "Closed")
        self.open_home()
        self.settled_counts(2)
        self.assertEqual(["Processed 1"], self.row_tags(q.A))
        self.assertEqual("Processed 1", self.summary())
        self.pick(q.A)
        self.assertEqual([], self.seen_posts)
        self.page.locator("#image-requests-summary").click()
        expect(self.page.locator(f'#image-request-list > li[data-id="{request["id"]}"]')).to_be_visible()
        self.wait_until(lambda: len(self.seen_posts) == 1, "the seen write")
        self.assertEqual({"path": f"/api/image-requests/{request['id']}/seen",
                          "body": {"expectedOwner": [q.INSTITUTION, q.CLINICIAN["sub"]], "revision": 3}}, self.seen_posts[0])
        self.wait_until(lambda: self.summary() is None, "the marks gone")
        self.assertEqual([], self.row_tags(q.A))

    def test_u04_unread_thread_outside_the_latest_50_opens(self):
        old = self.answered(q.A, "SYN oldest question")
        for n in range(50):
            self.server.seed(q.A, q.CLINICIAN, f"SYN question {n}")
        self.open_home()
        self.settled_counts(2)
        self.pick(q.A)
        self.open_questions("ready")
        outside = self.page.locator(f'#question-list > li[data-unread-outside][data-id="{old["id"]}"]')
        expect(outside).to_have_count(1)
        expect(outside.locator('[data-unread="item"]')).to_have_text("New")
        outside.locator("button[data-open-thread]").click()
        self.threaded(old["id"], "Answered")
        self.wait_until(lambda: len(self.seen_posts) == 1, "the seen write")
        self.wait_until(lambda: self.summary() is None, "the marks gone")
        expect(self.page.locator("#question-list > li[data-unread-outside]")).to_have_count(0)

    def test_u05_an_answer_for_another_account_shows_no_mark(self):
        self.answered(q.A)
        self.unread_owner = [q.INSTITUTION, q.OTHER_CLINICIAN["sub"]]
        self.page.goto(q.ORIGIN + q.BASE + "clinician.html")
        self.wait_until(lambda: len(self.unread_reads) >= 1, "an unread read")
        # Another account's answer is the existing account-change path: the page closes (or leaves) and draws no mark.
        self.wait_until(lambda: not self.page.url.endswith("clinician.html") or self.page.locator("p.closing").count() > 0,
                        "the page stopped for the account change")
        self.page.wait_for_load_state()
        self.assertEqual(0, self.page.locator("[data-unread]").count())

    def test_u08_a_failed_read_keeps_the_count_a_refusal_clears_it(self):
        self.answered(q.A)
        self.open_home()
        self.settled_counts(2)
        self.assertEqual("New Answers 1", self.summary())
        self.unread_fault = (503, {"code": "SYN", "message": "SYN unavailable"})
        self.page.locator("#refresh").click()
        self.settled_counts(4)
        self.assertEqual("New Answers 1", self.summary(), "a failed read is not a 0")
        self.assertEqual(["New Answers 1"], self.row_tags(q.A))
        self.unread_fault = (403, {"code": "QUESTION_ROLE_REQUIRED", "message": "SYN refused"})
        self.page.locator("#refresh").click()
        self.wait_until(lambda: self.summary() is None, "the refused view cleared")
        self.assertEqual([], self.row_tags(q.A))

    def test_u09_a_merged_exam_is_marked_on_its_report_row(self):
        self.MERGED = True
        self.server.open_uid = lambda u: q.A if u == q.B else u   # the server answers B's exam on A
        scope = self.merged_scope()
        for row in self.rows:
            if row["uid"] in (q.A, q.B):
                row["exam"] = {"studies": [q.A, q.B], "scope": copy.deepcopy(scope)}
        thread = self.answered(q.B, "SYN question on the merged original")
        self.open_home()
        self.settled_counts(2)
        self.assertEqual(["New Answers 1"], self.row_tags(q.A), "the exam's report row, where the server answers for it")
        self.assertEqual([], self.row_tags(q.B))
        self.pick(q.A)
        self.open_questions("ready")
        expect(self.page.locator(f'#question-list > li[data-id="{thread["id"]}"] [data-unread="item"]')).to_have_text("New")
        self.open_thread(thread["id"], "Answered")
        self.wait_until(lambda: len(self.seen_posts) == 1, "the seen write")
        self.assertEqual(f"/api/questions/{thread['id']}/seen", self.seen_posts[0]["path"])
        self.wait_until(lambda: self.summary() is None, "the marks gone")

    def test_u13_after_unmerge_a_new_mark_is_on_the_original_row(self):
        # Merged, then the merge undone: A's row still carries the scope its kept report was written on (A held B), and
        # the server answers B on B again (openUid = B). B's new answer and processed request are B's row's alone.
        for row in self.rows:
            if row["uid"] == q.A:
                row["exam"] = {"studies": [q.A, q.B], "scope": copy.deepcopy(self.merged_scope())}
        self.answered(q.B, "SYN question after the merge was undone")
        self.unread.add_request(q.B, q.CLINICIAN, "Closed")
        self.open_home()
        self.settled_counts(2)
        self.assertEqual(["New Answers 1", "Processed 1"], self.row_tags(q.B))
        self.assertEqual([], self.row_tags(q.A), "not the row of the old merged scope")
        self.assertEqual("New Answers 1 · Processed 1", self.summary())

    # ── Reading screen ──
    def test_u06_reading_screen_band_count_opens_the_inbox(self):
        thread = self.server.seed(q.A, q.CLINICIAN, "SYN question for the pool")
        self.open_reader(q.me(q.RADIOLOGIST, ["radiologist"]), block=UNREAD_JS + "\n" + q.READER_BLOCK)
        button = self.page.locator("#question-unread")
        expect(button).to_be_hidden()
        self.page.evaluate("() => studyQuestions.refresh()")   # the list poll; no study is chosen
        expect(button).to_have_text("New Questions 1")
        self.assertEqual(["question-inbox"], self.unread_reads)
        button.click()
        expect(self.page.locator("#question-inbox-list > li")).to_have_count(1)
        self.assertEqual(["open"], self.requests("inbox")[-1]["query"]["state"])
        row = self.page.locator(f'#question-inbox-list > li[data-id="{thread["id"]}"]')
        expect(row.locator("[data-unread]")).to_have_text("New")
        self.assertEqual([], self.seen_posts, "the Inbox list alone is not a drawn thread")
        row.locator("button[data-open-study]").click()
        self.wait_until(lambda: len(self.seen_posts) == 1, "the seen write")
        self.assertEqual({"path": f"/api/questions/{thread['id']}/seen",
                          "body": {"expectedOwner": [q.INSTITUTION, q.RADIOLOGIST["sub"]], "revision": 1}}, self.seen_posts[0])
        expect(button).to_be_hidden()
        # Another radiologist's count is their own: the seen mark is this reader's.
        self.assertEqual(1, len(self.unread.unread_items(q.me(q.RADIOLOGIST_TWO, ["radiologist"]), "question-inbox")))

    def test_u07_reading_screen_admin_only_and_offline(self):
        self.server.seed(q.A, q.CLINICIAN, "SYN question for the pool")
        self.open_reader(q.me(q.ADMIN, ["admin"]), block=UNREAD_JS + "\n" + q.READER_BLOCK)
        self.page.evaluate("() => studyQuestions.refresh()")
        self.wait_until(lambda: self.unread_reads == ["question-inbox"], "the unread read")
        self.settle()
        expect(self.page.locator("#question-unread")).to_be_hidden()
        self.fresh_context()
        self.unread_reads.clear()
        self.open_reader(q.me(q.RADIOLOGIST, ["radiologist"]), block=UNREAD_JS + "\n" + q.READER_BLOCK)
        self.page.evaluate("() => { offline = true; studyQuestions.refresh(); }")
        self.settle()
        self.assertEqual([], self.unread_reads, "nothing is read or sent while offline")
        self.assertEqual([], self.seen_posts)


class InAppUnreadReaderDOMTest(InAppUnreadDOMTest):
    """The reading screen's further cases (merged exam, laid-out pane, band) over the same harness."""

    def reader_with_scope(self, session, studies=None):
        # exam-scope.js is a page script the cut block reads through window.KinExamScope (the Inbox's listed exam row).
        self.open_reader(session, studies=studies, block=q.lf_text(q.HPACS / "exam-scope.js") + "\n" + UNREAD_JS + "\n" + q.READER_BLOCK)

    def test_u10_a_pane_not_laid_out_sends_no_seen(self):
        thread = self.server.seed(q.A, q.CLINICIAN, "SYN question for the pool")
        self.reader_with_scope(q.me(q.RADIOLOGIST, ["radiologist"]))
        self.page.evaluate("() => studyQuestions.refresh()")
        expect(self.page.locator("#question-unread")).to_have_text("New Questions 1")
        self.page.locator("#question-unread").click()
        self.page.locator(f'#question-inbox-list > li[data-id="{thread["id"]}"] button[data-open-study]').click()
        self.wait_until(lambda: len(self.seen_posts) == 1, "the seen write of the drawn thread")
        self.assertEqual(1, self.seen_posts[0]["body"]["revision"])
        # Another work tab lays the reading pane out of view; the author's follow-up reaches the pane by the list poll.
        self.server.step(thread, "followup", q.CLINICIAN, "clinician", "SYN follow-up")
        self.page.evaluate("() => { document.querySelector('#question-p').style.display = 'none'; }")
        reads = len(self.requests("thread"))
        self.page.evaluate("() => studyQuestions.refresh()")
        self.wait_until(lambda: len(self.requests("thread")) > reads, "the thread read again")
        self.settle()
        self.assertEqual(1, len(self.seen_posts), "no seen mark for a revision the reader did not see")
        self.assertEqual(1, self.unread.seen[("question", q.RADIOLOGIST["sub"], thread["id"])])

    def test_u11_an_inbox_question_of_a_merged_original_opens_on_the_exam_row(self):
        self.MERGED = True
        self.server.open_uid = lambda u: q.A if u == q.B else u   # the server answers B's exam on A
        thread = self.server.seed(q.B, q.CLINICIAN, "SYN question on the merged original")
        studies = [{**q.READER_STUDIES[0], "examScope": self.merged_scope()}] + [s for s in q.READER_STUDIES if s["uid"] not in (q.A, q.B)]
        self.reader_with_scope(q.me(q.RADIOLOGIST, ["radiologist"]), studies=studies)
        self.page.evaluate("() => studyQuestions.refresh()")
        expect(self.page.locator("#question-unread")).to_have_text("New Questions 1")
        self.page.locator("#question-unread").click()
        row = self.page.locator(f'#question-inbox-list > li[data-id="{thread["id"]}"]')
        expect(row.locator("button[data-open-study]")).to_be_enabled()
        row.locator("button[data-open-study]").click()
        expect(self.page.locator("#question-thread")).to_have_attribute("data-id", thread["id"])
        self.wait_until(lambda: len(self.seen_posts) == 1, "the seen write")
        self.assertEqual([q.A], self.page.evaluate("() => window.synSelects"), "opened on the exam's row")
        expect(self.page.locator("#question-unread")).to_be_hidden()

    def test_u12_the_band_count_steps_aside_for_the_move_notice(self):
        self.server.seed(q.A, q.CLINICIAN, "SYN question for the pool")
        self.reader_with_scope(q.me(q.RADIOLOGIST, ["radiologist"]))
        self.page.evaluate("() => studyQuestions.refresh()")
        button = self.page.locator("#question-unread")
        expect(button).to_have_text("New Questions 1")
        order = self.page.evaluate("() => [...document.querySelectorAll('#report-alerts > button')].map(b => b.id)")
        self.assertEqual(["question-notice", "image-request-notice", "question-unread"], order)
        self.page.evaluate("() => { document.querySelector('#report-notice').style.display = 'flex'; }")
        expect(button).to_be_hidden()
        self.page.evaluate("() => { document.querySelector('#report-notice').style.display = 'none'; }")
        expect(button).to_be_visible()

    def test_u14_an_inbox_question_of_a_split_part_opens_on_its_own_row(self):
        # A split in two: A's row is part one (its UID), X's row the second part of the same original. A question left on
        # A's row is answered on A (openUid = A) — X's row, listed first, holds the same original too but is not it.
        x = q.PREFIX + ".59"
        split = lambda report, part, mode: {"reportUid": report, "groupId": "SYN-GROUP-2", "kind": "split", "part": part,
                                            "active": True, "generation": "SYN-GEN-2",
                                            "sources": [{"studyUid": q.A, "series": {"mode": mode, "uids": [q.PREFIX + ".59.1"]}}]}
        first = {**q.READER_STUDIES[0], "examScope": split(q.A, 0, "exclude")}
        second = {**q.READER_STUDIES[0], "uid": x, "id": "SYN-P-59", "desc": "SYN CT A part 2", "examScope": split(x, 1, "include")}
        studies = [second, first] + [s for s in q.READER_STUDIES if s["uid"] != q.A]
        thread = self.server.seed(q.A, q.CLINICIAN, "SYN question on part one")
        self.reader_with_scope(q.me(q.RADIOLOGIST, ["radiologist"]), studies=studies)
        self.page.evaluate("() => studyQuestions.refresh()")
        expect(self.page.locator("#question-unread")).to_have_text("New Questions 1")
        self.page.locator("#question-unread").click()
        row = self.page.locator(f'#question-inbox-list > li[data-id="{thread["id"]}"]')
        expect(row.locator("button[data-open-study]")).to_be_enabled()
        row.locator("button[data-open-study]").click()
        expect(self.page.locator("#question-thread")).to_have_attribute("data-id", thread["id"])
        self.assertEqual([q.A], self.page.evaluate("() => window.synSelects"), "opened on part one's row, not part two's")
        self.wait_until(lambda: len(self.seen_posts) == 1, "the seen write")
        expect(self.page.locator("#question-unread")).to_be_hidden()

    # Only this class's own cases; the inherited ones run in InAppUnreadDOMTest.
    own = ("test_u10_", "test_u11_", "test_u12_", "test_u14_")


def load_tests(loader, tests, pattern):
    suite = unittest.TestSuite()
    for name in sorted(vars(InAppUnreadDOMTest)):
        if name.startswith("test_u"):
            suite.addTest(InAppUnreadDOMTest(name))
    for name in sorted(vars(InAppUnreadReaderDOMTest)):
        if name.startswith(InAppUnreadReaderDOMTest.own):
            suite.addTest(InAppUnreadReaderDOMTest(name))
    return suite


if __name__ == "__main__":
    unittest.main()
