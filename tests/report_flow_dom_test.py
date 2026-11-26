# coding: utf-8
"""W4-PAGE-01..12 -> RISK-LOST-TEXT / WRONG-STUDY / HIDDEN-RECOMMENDATION / FIRST-ROW-JUMP -> W4 report flow.

The delivered split page (main.html, its bundle and every shipped asset) against a synthetic origin; no stack, no
product file is modified. FlowSite extends the logout suite's wire boundary (auth_logout_dom_test.Site) from one study
to several, each with its own stored draft row, revision and report, so the queue, a filter and A -> B -> A can be
driven through the page's own controls.

The Ctrl+S cases run on the shipped W4-SC shortcut model (D1358, D1371: readV2 with `finalize`); its setup-only stand-in
was removed once the model was merged onto this branch (D1420), so a model without readV2 fails them. The two Reading
Workspace Ctrl+S cases serve only the viewer document as a stand-in (VIEWER_STAND_IN), so the workspace binds its real
keyboard listener there.
Setup-only, documented where used: the hook case marks an insertion as out (`insertInFlight`), which the citation and
structure suites drive for real. The W5 reason at the common command block is no longer stood in here (W5 Phase B): the
real Related Report mode supplies it on the complete page (tests/related_report_mode_dom_test.py
test_w5b_the_common_command_block_carries_the_mode_reason_and_next_prev_leave_through_the_gate,
test_w5_mode_blocks_every_report_command_shortcut_and_late_writer, test_w5r3_report_inventory_*).
"""
import io
import json
import re
import sys
import time
import unittest
from pathlib import Path

import auth_logout_dom_test as h
from playwright.sync_api import expect, sync_playwright

ROOT = Path(__file__).resolve().parents[1]
LITE = ROOT / "worklist-v0/hpacs-lite"
UID_C = "1.2.826.0.1.3680043.10.7707.3"
UID_D = "1.2.826.0.1.3680043.10.7707.4"
PATIENT_C = "SYN PATIENT CHARLIE"
PATIENT_D = "SYN PATIENT DELTA"
STUDIES = ((h.UID, h.PATIENT, "SYN-P-001"), (h.UID_B, h.PATIENT_B, "SYN-P-002"),
           (UID_C, PATIENT_C, "SYN-P-003"), (UID_D, PATIENT_D, "SYN-P-004"))
FIELDS = tuple(h.FIELDS)
RS_OF = {"save": "T", "approve": "A", "addendum": "A", "reset": "W", "defer": "H", "preliminary": "P"}
TEMPLATE = {"id": "SYN-TPL-1", "title": "SYN REC TEMPLATE", "shortcut": "", "modality": "", "bodypart": "", "ord": 0,
            "findings": "SYN template findings", "conclusion": "SYN template conclusion",
            "recommendation": "SYN template recommendation: follow-up CT in 3 months"}


class FlowSite(h.Site):
    """Several studies, each with the author's own draft row (revision, snapshot) and its report."""

    def __init__(self, count=3):
        super().__init__()
        self.version_author = None
        self.flow = STUDIES[:count]
        self.store = {uid: {"revs": 0, "row": None, "report": {"version": 0, "rs": "W"}} for uid, _, _ in self.flow}
        self.flow_puts = []             # (uid, body) of every draft write that reached the server
        self.flow_commits = []          # (uid, body) of every commit
        self.held_flow_puts = []        # (route, uid, body, account)
        self.held_flow_commits = []     # (route, uid, body, account)
        self.flow_draft_reads = []      # uid of every full draft read (GET draft) that reached the server
        self.held_draft_reads = []      # (route, uid, account)
        self.templates = []
        self.orders = []                # the Order List (bootstrap), for the Technician tab
        self.hidden = set()
        self.unverified = set()         # studies still being acquired (ss Unverified, em N): read only until Verify
        self.requested = set()          # studies a clinician asked to be read: open until the report is approved

    # ── one study's stored state ──
    def revision_of(self, uid):
        return f"{self.epoch}:{self.store[uid]['revs']}"

    def envelope_of(self, uid, account):
        row = self.store[uid]["row"]
        return {"uid": uid, "owner": h.owner_of(account), "revision": self.revision_of(uid), "present": row is not None,
                "snapshot": dict(row) if row else None, "updatedAt": "2026-10-03T00:00:00.000Z" if row else None}

    def state_of(self, uid, account):
        st = self.store[uid]
        row, report = st["row"], st["report"]
        approved = report["rs"] == "A"
        return {"rs": report["rs"], "ss": "Unverified" if uid in self.unverified else "Verified", "em": "N", "ts": "none", "matched": "U", "ward": "",
                "reqHosp": "SYN Hospital A", "institutionId": h.INSTITUTION, "teleInstitutionId": None, "preDoc": None,
                "preReviewer": None, "prelimHidden": False, "repDoc": account["actor"] if approved else None,
                "confirm": "20261003" if approved else None, "ov": None, "orig": None, "oid": None, "holder": None,
                "holdReason": None, "version": report["version"],
                **{k: report.get(k, "") for k in FIELDS},
                # FC-034: the 24-hour amendment facts, when a case gives them (an approved report without them takes only
                # an Addendum).
                **{k: report[k] for k in ("amendUntil", "amendMine", "addendumAt") if k in report},
                "draft": {**{k: row[k] for k in FIELDS}, "baseVersion": row["baseVersion"],
                          "at": "2026-10-03T00:00:00.000Z"} if row else None,
                "draftRevision": self.revision_of(uid), "draftEpoch": self.epoch}

    def preconditions_of(self, uid, body, account):
        if not isinstance(body, dict) or "expectedOwner" not in body or "expectedRevision" not in body:
            return 400, {"code": "REPORT_DRAFT_PRECONDITION_REQUIRED", "message": "SYN-SERVER-WORDING precondition"}
        if body["expectedOwner"] != h.owner_of(account):
            return 409, {"code": "REPORT_DRAFT_OWNER_CHANGED", "message": "SYN-SERVER-WORDING owner"}
        if body["expectedRevision"] != self.revision_of(uid):
            return 409, {"code": "REPORT_DRAFT_CONFLICT", "message": "SYN-SERVER-WORDING conflict"}
        return None

    def write_of(self, uid, body, account):
        refused = self.preconditions_of(uid, body, account)
        if refused:
            return refused
        if any(key not in body for key in (*FIELDS, "baseVersion", "citationIds", "structureIds")):
            return 400, {"code": "REPORT_DRAFT_PRECONDITION_REQUIRED", "message": "SYN-SERVER-WORDING snapshot"}
        st = self.store[uid]
        st["revs"] += 1
        st["row"] = None if all(not body[k] for k in FIELDS) else {
            **{k: body[k] for k in FIELDS}, "baseVersion": body["baseVersion"],
            "citations": list(body["citationIds"]), "structured": list(body["structureIds"])}
        return 200, self.envelope_of(uid, account)

    def commit_of(self, uid, body, account):
        refused = self.preconditions_of(uid, body, account)
        if refused:
            return refused
        st = self.store[uid]
        action = body.get("action")
        if st["report"]["rs"] == "A" and action in ("save", "approve"):
            return 400, {"code": "REPORT_APPROVED", "message": "SYN-SERVER-WORDING approved"}
        if body.get("baseVersion") != st["report"]["version"]:
            return 409, {"code": "REPORT_VERSION_CONFLICT", "message": "SYN 그 사이 다른 사용자가 저장했습니다"}
        st["revs"] += 1
        st["row"] = None
        texts = {k: "" for k in FIELDS} if action == "reset" else {k: body.get(k, "") for k in FIELDS}
        st["report"] = {"version": st["report"]["version"] + 1, "rs": RS_OF.get(action, "T"), **texts}
        # The version this commit made, as GET report/versions lists it: a lost answer is proved against it.
        st.setdefault("versions", []).append({"version": st["report"]["version"], "action": action,
                                              "mine": True, "author": self.version_author or h.owner_of(account)["author"],
                                              "reason": body.get("reason"), **texts})
        return 200, {**self.envelope_of(uid, account), "state": self.state_of(uid, account)}

    def stored_of(self, uid):
        row = self.store[uid]["row"]
        return {k: row[k] for k in FIELDS} if row else None

    # ── the list ──
    def list_body(self, account, rename=None):
        rows = []
        for uid, name, patient in self.flow:
            if uid in self.hidden:
                continue
            row = self.study_row(account, h.UID, name, patient)
            row["uid"] = uid
            row["state"] = self.state_of(uid, account)
            # Read Req (api/src/pacs/reading-request.ts): the open request, closed by the approval of the study.
            row["readingRequest"] = ({"at": "2026-10-02T23:00:00.000Z", "by": "SYN Dr. REQUESTER"}
                                     if uid in self.requested and self.store[uid]["report"]["rs"] != "A" else None)
            rows.append(row)
        return {"studies": rows, "serverTime": "2026-10-03T00:00:00.000Z", "observedAt": "2026-10-03T00:00:00.000Z",
                "notObserved": [], "pagination": {"owner": [h.INSTITUTION, account["sub"]], "limit": 100, "offset": 0,
                                                  "total": len(rows), "next": None}}

    def api(self, route, request, method, path, query):
        if method == "GET" and path == "/api/bootstrap":
            account, refused = self.authenticate(request)
            if refused:
                return self.refuse(route, *refused)
            states = {} if "states=omit" in query else {uid: self.state_of(uid, account) for uid, _, _ in self.flow}
            return route.fulfill(json={"statesOmitted": "states=omit" in query, "me": {
                "actor": account["actor"], "roles": account["roles"], "institution": h.INSTITUTION,
                "institutionName": "SYN Hospital A"}, "filters": [], "templates": self.templates,
                "institutions": [{"id": h.INSTITUTION, "name": "SYN Hospital A", "type": "hospital"}],
                "states": states, "orders": self.orders, "serverTime": "2026-10-03T00:00:00.000Z"})
        found = re.fullmatch(r"/api/studies/([^/]+)/(hold|release|report|draft|report/commit|report/versions)", path)
        if not found or found.group(1) not in self.store:
            return super().api(route, request, method, path, query)
        account, refused = self.authenticate(request)
        if refused:
            return self.refuse(route, *refused)
        uid, what = found.groups()
        if method == "POST" and what == "hold":
            self.holds.append(path)
            return route.fulfill(json={"holder": account["user"], "mine": True, "conflict": False})
        if method == "POST" and what == "release":
            self.releases.append((path, request.headers.get("x-kin-session")))
            return route.fulfill(json={"ok": True})
        if method == "GET" and what == "report/versions":
            return route.fulfill(json=list(reversed(self.store[uid].get("versions", []))))
        if method == "GET" and what == "draft":
            self.draft_reads.append(request.headers.get("x-kin-session"))
            self.flow_draft_reads.append(uid)
            if self.draft_read_answers:
                reply = self.draft_read_answers.pop(0)
                if reply == "hold":
                    return self.held_draft_reads.append((route, uid, account))
                return route.abort("connectionreset") if reply == "abort" else self.answer(route, *reply)
            return route.fulfill(json=self.envelope_of(uid, account))
        if method == "PUT" and what == "report":
            body = request.post_data_json
            self.puts.append(body)
            self.flow_puts.append((uid, body))
            reply = self.put_answers.pop(0) if self.put_answers else "ok"
            if reply == "hold":
                return self.held_flow_puts.append((route, uid, body, account))
            if reply == "abort":
                return route.abort("connectionreset")
            if reply == "lost":
                self.write_of(uid, body, account)
                return route.abort("connectionreset")
            if reply != "ok":
                return self.answer(route, *reply)
            return self.answer(route, *self.write_of(uid, body, account))
        if method == "DELETE" and what == "draft":
            body = request.post_data_json
            self.discards.append(body)
            refused_write = self.preconditions_of(uid, body, account)
            if refused_write:
                return self.answer(route, *refused_write)
            self.store[uid]["revs"] += 1
            self.store[uid]["row"] = None
            return route.fulfill(json={**self.envelope_of(uid, account), "state": self.state_of(uid, account)})
        if method == "POST" and what == "report/commit":
            body = request.post_data_json
            self.commits.append(body)
            self.flow_commits.append((uid, body))
            reply = self.commit_answers.pop(0) if self.commit_answers else "ok"
            if reply == "hold":
                return self.held_flow_commits.append((route, uid, body, account))
            if reply == "lost":
                self.commit_of(uid, body, account)
                return route.abort("connectionreset")
            if reply != "ok":
                return self.answer(route, *reply)
            return self.answer(route, *self.commit_of(uid, body, account))
        self.violations.append(f"undeclared write: {method} {path}")
        return route.fulfill(status=405, json={"code": "SYN_NO_WRITE"})

    def finish_flow_put(self, index=0, status=200):
        route, uid, body, account = self.held_flow_puts.pop(index)
        answer = self.write_of(uid, body, account) if status == 200 else (status, {"code": "SYN_FAILED", "message": "SYN"})
        self.answer(route, *answer)
        return answer[0]

    def finish_draft_read(self, index=0):
        """Answer a held full draft read with the server's state now."""
        route, uid, account = self.held_draft_reads.pop(index)
        route.fulfill(json=self.envelope_of(uid, account))

    def finish_flow_commit(self, index=0, lost=False):
        route, uid, body, account = self.held_flow_commits.pop(index)
        answer = self.commit_of(uid, body, account)
        if lost:
            route.abort("connectionreset")
        else:
            self.answer(route, *answer)
        return answer[0]


# One Ctrl+S keydown in Findings, as the keyboard sends it; returns whether a listener prevented the browser default
# (the page's dispatcher stops the event at the window, so nothing after it could observe the flag).
CTRL_S = """() => { const e = new KeyboardEvent('keydown', { key: 's', code: 'KeyS', ctrlKey: true, bubbles: true, cancelable: true });
  document.querySelector('#findings').dispatchEvent(e); return e.defaultPrevented; }"""
# The same keydown sent in the bound viewer frame's document (keyboard events do not leave an iframe).
FRAME_CTRL_S = """() => { const doc = document.querySelector('#reading-frame').contentDocument;
  const e = new KeyboardEvent('keydown', { key: 's', code: 'KeyS', ctrlKey: true, bubbles: true, cancelable: true });
  doc.querySelector('.cornerstone-canvas').dispatchEvent(e); return e.defaultPrevented; }"""
# The viewer document the Reading Workspace binds to: a canvas and the two workspace-state functions it waits for. Only
# this document is a stand-in; the page, its dispatcher, the shortcut model and KinReportCommands are the shipped ones.
VIEWER_STAND_IN = """<!doctype html><title>SYN viewer stand-in</title><body><div class="cornerstone-canvas" tabindex="0">SYN</div>
<script>window.kinViewerHistoryWorkspaceState=()=>({busy:false,dirty:false});
window.kinViewerJobWorkspaceState=()=>({busy:false,dirty:false});</script></body>"""
CRITICAL_RESULT_LIST = ("GET", "/api/critical-results")


class ReportFlowPage(unittest.TestCase):
    """REQ W4-PAGE-01/04/05/06/08/10/12 on the delivered split page; only HTTP is synthetic."""
    count = 3
    bundle_source = None
    html_source = None
    asset_source = None  # (file, body): one shipped script outside the bundle served as a one-off copy (ASSET_MUTANTS)

    @classmethod
    def setUpClass(cls):
        cls.pw = sync_playwright().start()
        cls.browser = cls.pw.chromium.launch()

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.pw.stop()

    def setUp(self):
        self.site = FlowSite(self.count)
        self.context = self.browser.new_context(viewport={"width": 1400, "height": 900}, locale="ko-KR",
                                                timezone_id="Asia/Seoul")
        self.context.route("**/*", lambda route, request: self.site.handle(route, request))
        if self.bundle_source is not None:
            self.context.route("**/main-split.bundle.js", lambda route: route.fulfill(
                body=self.bundle_source, content_type="text/javascript; charset=utf-8"))
        if self.html_source is not None:
            self.context.route("**/main.html", lambda route: route.fulfill(
                body=self.html_source, content_type="text/html; charset=utf-8"))
        if self.asset_source is not None:
            self.context.route("**/" + self.asset_source[0], lambda route: route.fulfill(
                body=self.asset_source[1], content_type="text/javascript; charset=utf-8"))
        self.page = self.context.new_page()
        self.page.set_default_timeout(10000)
        self.page.set_default_navigation_timeout(30000)
        self.errors, self.dialogs = [], []
        self.page.on("pageerror", lambda error: self.errors.append(str(error)))
        self.page.on("dialog", lambda dialog: (self.dialogs.append(dialog.message), dialog.accept()))
        # Fake timers: a case can advance the page's timers (autosave, polling, the navigation wait bound) on purpose. They
        # still run with the wall clock unless a case stands page time still (hold_page_time, R3-SUITE-01).
        self.page.clock.install()

    def tearDown(self):
        self.context.close()
        self.assertEqual([], self.errors, "page errors")
        self.assertEqual([], self.site.violations, "requests the synthetic origin does not answer")

    # ── driving the page through its controls ──
    def open(self):
        self.page.goto(h.MAIN_URL)
        expect(self.page.locator("#rows")).to_contain_text(h.PATIENT)

    def row(self, patient):
        return self.page.locator("#rows tr", has_text=patient).first

    def pick(self, patient):
        self.row(patient).click()

    def open_study(self, patient):
        self.pick(patient)
        self.wait(lambda: self.selected() == patient, "the study opens")
        expect(self.page.locator("#findings")).to_be_editable()

    def type(self, text, field="findings"):
        self.page.locator("#" + field).fill(text)

    def selected(self):
        return self.page.evaluate("() => studies.find(s => s.uid === selectedUid)?.name ?? null")

    def editor_of(self):
        """The study whose report the editor holds (the frame's opening)."""
        return self.page.evaluate("() => studies.find(s => s.uid === reportOpening?.uid)?.name ?? null")

    def wait(self, predicate, what, timeout=10.0):
        deadline = time.monotonic() + timeout
        while not predicate():
            if time.monotonic() > deadline:
                self.fail(f"{what}: not observed; last requests {self.site.calls[-8:]}")
            self.page.wait_for_timeout(20)

    def settle(self, ms=150):
        """Real time for in-flight answers to reach the page (page time runs along unless hold_page_time() holds it)."""
        self.page.wait_for_timeout(ms)

    def notice(self):
        return self.page.locator("#report-notice")

    def hold_page_time(self):
        """R3-SUITE-01: the page's clock stands still from here until release_page_time(). page.clock.install() lets page
        time run with the wall clock, so a held draft write plus the case's own barrier (a Refresh, a sort, a composition, a
        menu) could pass the page's 3 s navigation wait bound (LEAVE_WAIT_MS) on a slow host and end the move as Result
        Unknown: the preserved failing 44-case record was exactly that (3.4 s of page time from the press to the release,
        reproduced deterministically). The bound itself is test_wait_bound_stops_as_unknown_..., which advances it on purpose."""
        self.page.clock.pause_at((self.page.evaluate("Date.now()") + 100) / 1000)

    def release_page_time(self):
        self.page.clock.resume()

    def held_navigation_write(self, uid, text, writes):
        """The held write is the navigation's own save: the one new draft PUT since the press, of this study, with this text
        (page time stands still, so no autosave can be the request the case holds)."""
        self.wait(lambda: self.site.held_flow_puts, "the navigation's draft write")
        self.assertEqual(writes + 1, len(self.site.flow_puts), "exactly one write since the press")
        _, held_uid, body, _ = self.site.held_flow_puts[0]
        self.assertEqual((uid, text), (held_uid, body["findings"]), "the held write is the navigation's save of the typed text")

    def compose(self):
        self.page.locator("#findings").focus()
        cdp = self.context.new_cdp_session(self.page)
        cdp.send("Input.imeSetComposition", {"text": "한", "selectionStart": 1, "selectionEnd": 1})
        return cdp

    def filter_waiting(self):
        self.page.select_option("#filterrow [data-f=rs]", "W")

    def stored(self, uid):
        return self.site.stored_of(uid)

    def reads_of(self, uid):
        return self.site.flow_draft_reads.count(uid)

    def another_window_writes(self, uid, findings, base_version=0):
        """Another document of the same account stores its own draft of the study (a real write on the server's rules)."""
        status, _ = self.site.write_of(uid, {"findings": findings, "conclusion": "", "recommendation": "",
                                             "baseVersion": base_version, "citationIds": [], "structureIds": [],
                                             "expectedOwner": h.owner_of(h.RAD),
                                             "expectedRevision": self.site.revision_of(uid)}, h.RAD)
        self.assertEqual(200, status)

    def unknown_on_the_way_to_b(self, text, put):
        """A's text, then a row click on B whose draft write ends with its result unknown (the confirming read fails too)."""
        self.open()
        self.open_study(h.PATIENT)
        self.type(text)
        self.site.put_answers = [put]
        self.site.draft_read_answers = ["abort"]
        self.pick(h.PATIENT_B)
        expect(self.notice()).to_contain_text("Result Unknown")
        self.assertEqual(h.PATIENT, self.selected())

    # ── SAVE-OUTCOME (W4-PAGE-01/03/06) ──
    def test_save_outcome_applied_moves_only_after_the_write_is_confirmed(self):
        self.open()
        self.open_study(h.PATIENT)
        self.type("SYN A typed")
        self.site.put_answers = ["hold"]
        writes = len(self.site.flow_puts)
        self.hold_page_time()
        self.pick(h.PATIENT_B)
        self.held_navigation_write(h.UID, "SYN A typed", writes)
        self.settle()
        self.assertEqual(h.PATIENT, self.selected(), "the switch waits for the write's answer")
        self.assertEqual("SYN A typed", self.page.locator("#findings").input_value())
        self.site.finish_flow_put()
        self.release_page_time()
        self.wait(lambda: self.selected() == h.PATIENT_B, "the switch after the confirmed write")
        self.assertEqual(h.PATIENT_B, self.editor_of())
        self.assertEqual({"findings": "SYN A typed", "conclusion": "", "recommendation": ""}, self.stored(h.UID))
        expect(self.notice()).to_be_hidden()
        self.assertEqual([], self.dialogs)

    def test_save_failure_notice_keeps_its_sentence_when_screen_language_changes(self):
        self.open()
        self.open_study(h.PATIENT)
        self.type("SYN unsaved report")
        self.site.put_answers = [(403, {"code": "REPORT_FORBIDDEN", "message": "검사를 선택하세요."})]
        self.pick(h.PATIENT_B)
        expect(self.notice()).to_be_visible()
        original = self.notice().text_content()
        self.page.evaluate("KinLanguage.restore({version:1,worklist:'en',reading:'en'})")
        expect(self.notice()).to_contain_text("Save Failed")
        expect(self.notice()).to_contain_text("Could not save your text")
        self.assertEqual(["검사를 선택하세요"], re.findall(r"[가-힣]+(?: [가-힣]+)*", self.notice().inner_text()))
        expect(self.notice()).to_contain_text(h.PATIENT_B)
        self.assertEqual("SYN unsaved report", self.page.locator("#findings").input_value())
        self.page.evaluate("KinLanguage.restore({version:1,worklist:null,reading:null})")
        self.assertEqual(original, self.notice().text_content())

    def test_save_outcome_refused_stays_with_notice_and_retry_moves_after_the_cause_is_gone(self):
        self.open()
        self.open_study(h.PATIENT)
        self.type("SYN A refused")
        self.site.put_answers = [(403, {"code": "REPORT_FORBIDDEN", "message": "SYN refused write"})]
        self.pick(h.PATIENT_B)
        expect(self.notice()).to_be_visible()
        expect(self.notice()).to_contain_text("Save Failed")
        expect(self.notice()).to_contain_text("SYN refused write")
        expect(self.page.locator("#report-notice-retry")).to_be_visible()
        expect(self.page.locator("#report-notice-stay")).to_be_visible()
        self.assertEqual(h.PATIENT, self.selected())
        self.assertEqual("SYN A refused", self.page.locator("#findings").input_value())
        expect(self.page.locator("#draftmsg")).to_contain_text("Save Failed")
        self.assertIsNone(self.stored(h.UID))
        # The cause is resolved on the server; Retry saves and continues the same move.
        self.page.locator("#report-notice-retry").click()
        self.wait(lambda: self.selected() == h.PATIENT_B, "Retry continues the move once saved")
        self.assertEqual({"findings": "SYN A refused", "conclusion": "", "recommendation": ""}, self.stored(h.UID))
        expect(self.notice()).to_be_hidden()

    def test_save_outcome_unknown_stays_and_check_confirms_from_the_server_then_moves(self):
        # The server stores the write but its answer is lost, and the confirming read fails too: the result is unknown.
        self.unknown_on_the_way_to_b("SYN A unknown", "lost")
        expect(self.page.locator("#report-notice-check")).to_be_visible()
        expect(self.page.locator("#report-notice-retry")).to_be_hidden()
        self.assertEqual("SYN A unknown", self.page.locator("#findings").input_value())
        expect(self.page.locator("#draftmsg")).to_contain_text("Result Unknown")
        writes, reads = len(self.site.flow_puts), self.reads_of(h.UID)
        # Check reads the server's draft once and compares the whole snapshot; it sends nothing.
        self.page.locator("#report-notice-check").click()
        self.wait(lambda: self.selected() == h.PATIENT_B, "Check confirms the save from the server and continues the move")
        self.assertEqual(writes, len(self.site.flow_puts), "Check never writes")
        self.assertEqual(reads + 1, self.reads_of(h.UID), "one explicit read of A's draft")
        self.assertEqual({"findings": "SYN A unknown", "conclusion": "", "recommendation": ""}, self.stored(h.UID))
        expect(self.notice()).to_be_hidden()

    def test_check_reads_and_stays_without_writing_when_the_server_lacks_the_text(self):
        """CHECK_MISMATCH (W4F-01): the write never reached the server. Check reads that, keeps the text and stays - it
        does not resend. Retry is the write path: it saves the text and then continues the move."""
        self.unknown_on_the_way_to_b("SYN unknown Check contract", "abort")
        writes, reads = len(self.site.flow_puts), self.reads_of(h.UID)
        self.page.locator("#report-notice-check").click()
        expect(self.notice()).to_contain_text("서버의 초안에 이 화면의 글이 없어")
        self.settle(300)
        self.assertEqual(writes, len(self.site.flow_puts), "Check only reads")
        self.assertEqual(reads + 1, self.reads_of(h.UID))
        self.assertEqual((h.PATIENT, "SYN unknown Check contract"),
                         (self.selected(), self.page.locator("#findings").input_value()))
        self.assertIsNone(self.stored(h.UID))
        expect(self.page.locator("#report-notice-retry")).to_be_visible()
        self.page.locator("#report-notice-retry").click()
        self.wait(lambda: self.selected() == h.PATIENT_B, "Retry saves the text and moves")
        self.assertEqual(writes + 1, len(self.site.flow_puts))
        self.assertEqual({"findings": "SYN unknown Check contract", "conclusion": "", "recommendation": ""}, self.stored(h.UID))

    def test_check_after_a_late_success_reads_again_and_stays_when_another_window_wrote(self):
        """CHECK_LATE (W4F-01): the wait bound said Result Unknown, the write then succeeded late, and another window of
        the same account stored a different draft. Check reads again and does not move on the earlier success."""
        self.open()
        self.open_study(h.PATIENT)
        self.type("SYN slow original")
        self.site.put_answers = ["hold"]
        self.pick(h.PATIENT_B)
        self.wait(lambda: self.site.held_flow_puts, "the draft write of A")
        self.page.clock.run_for(3001)
        expect(self.notice()).to_contain_text("Result Unknown")
        self.site.finish_flow_put()
        expect(self.notice()).to_contain_text("Draft Saved")
        self.another_window_writes(h.UID, "SYN another tab")
        writes, reads = len(self.site.flow_puts), self.reads_of(h.UID)
        self.page.locator("#report-notice-check").click()
        expect(self.notice()).to_contain_text("다른 창에서")
        self.settle(300)
        self.assertEqual(reads + 1, self.reads_of(h.UID), "Check reads even after the late success")
        self.assertEqual(writes, len(self.site.flow_puts))
        self.assertEqual((h.PATIENT, "SYN slow original"), (self.selected(), self.page.locator("#findings").input_value()))
        self.assertEqual("SYN another tab", self.stored(h.UID)["findings"])

    def test_check_compares_the_whole_snapshot_not_only_the_text(self):
        # The same three fields on another base version (another window) are not this document's draft.
        self.unknown_on_the_way_to_b("SYN A whole", "abort")
        self.another_window_writes(h.UID, "SYN A whole", base_version=7)
        writes = len(self.site.flow_puts)
        self.page.locator("#report-notice-check").click()
        expect(self.notice()).to_contain_text("서버의 초안에 이 화면의 글이 없어")
        self.settle(300)
        self.assertEqual((h.PATIENT, writes), (self.selected(), len(self.site.flow_puts)))

    def test_check_read_failure_stays_without_writing(self):
        self.unknown_on_the_way_to_b("SYN A unread", "abort")
        self.site.draft_read_answers = ["abort"]
        writes = len(self.site.flow_puts)
        self.page.locator("#report-notice-check").click()
        expect(self.notice()).to_contain_text("확인하지 못해")
        self.settle(300)
        expect(self.page.locator("#report-notice-check")).to_be_enabled()
        expect(self.page.locator("#report-notice-retry")).to_be_hidden()
        self.assertEqual((h.PATIENT, writes, "SYN A unread"),
                         (self.selected(), len(self.site.flow_puts), self.page.locator("#findings").input_value()))

    def test_check_after_more_typing_stays_without_writing(self):
        # The lost write holds the earlier text; the reader typed more since. That text is not on the server.
        self.unknown_on_the_way_to_b("SYN A first", "lost")
        self.type("SYN A first and more")
        writes = len(self.site.flow_puts)
        self.page.locator("#report-notice-check").click()
        expect(self.notice()).to_contain_text("서버의 초안에 이 화면의 글이 없어")
        self.settle(300)
        self.assertEqual((h.PATIENT, writes, "SYN A first and more"),
                         (self.selected(), len(self.site.flow_puts), self.page.locator("#findings").input_value()))
        self.assertEqual("SYN A first", self.stored(h.UID)["findings"])

    def test_a_late_check_answer_after_a_b_a_does_not_move(self):
        self.unknown_on_the_way_to_b("SYN A lost", "lost")
        self.site.draft_read_answers = ["hold"]
        self.page.locator("#report-notice-check").click()
        self.wait(lambda: self.site.held_draft_reads, "the Check read")
        # While that read is out the reader goes to B (the gate confirms A's text with its own read) and back to A.
        self.pick(h.PATIENT_B)
        self.wait(lambda: self.selected() == h.PATIENT_B, "B")
        self.pick(h.PATIENT)
        self.wait(lambda: self.selected() == h.PATIENT, "A again")
        writes = len(self.site.flow_puts)
        self.site.finish_draft_read()
        self.settle(400)
        self.assertEqual(h.PATIENT, self.selected(), "the late Check answer belongs to the earlier selection")
        self.assertEqual(writes, len(self.site.flow_puts))
        self.assertEqual("SYN A lost", self.stored(h.UID)["findings"])

    def test_wait_bound_stops_as_unknown_and_a_late_confirmation_is_shown_without_moving(self):
        self.open()
        self.open_study(h.PATIENT)
        self.type("SYN A slow")
        self.site.put_answers = ["hold"]
        self.pick(h.PATIENT_B)
        self.wait(lambda: self.site.held_flow_puts, "the draft write of A")
        self.page.clock.run_for(3001)
        expect(self.notice()).to_contain_text("Result Unknown")
        self.assertEqual(h.PATIENT, self.selected())
        self.site.finish_flow_put()
        expect(self.notice()).to_contain_text("Draft Saved")
        self.settle()
        self.assertEqual(h.PATIENT, self.selected(), "a late answer does not move by itself")
        writes, reads = len(self.site.flow_puts), self.reads_of(h.UID)
        self.page.locator("#report-notice-check").click()
        self.wait(lambda: self.selected() == h.PATIENT_B, "Check moves once the server shows the saved text")
        self.assertEqual((writes, reads + 1), (len(self.site.flow_puts), self.reads_of(h.UID)))

    def test_stay_closes_the_notice_and_keeps_the_text(self):
        self.open()
        self.open_study(h.PATIENT)
        self.type("SYN A stay")
        self.site.put_answers = [(503, {"code": "REPORT_DRAFT_UNAVAILABLE", "message": "SYN unavailable"})]
        self.pick(h.PATIENT_B)
        expect(self.notice()).to_contain_text("Save Failed")
        self.page.locator("#report-notice-stay").click()
        expect(self.notice()).to_be_hidden()
        self.assertEqual((h.PATIENT, "SYN A stay"), (self.selected(), self.page.locator("#findings").input_value()))

    def test_conflict_stays_and_points_to_the_draft_bar_choice(self):
        self.open()
        self.open_study(h.PATIENT)
        self.type("SYN A mine")
        # Another document of this account stored a different draft first.
        self.site.write_of(h.UID, {"findings": "SYN other window", "conclusion": "", "recommendation": "", "baseVersion": 0,
                                   "citationIds": [], "structureIds": [], "expectedOwner": h.owner_of(h.RAD),
                                   "expectedRevision": self.site.revision_of(h.UID)}, h.RAD)
        self.pick(h.PATIENT_B)
        expect(self.notice()).to_contain_text("서버의 초안이 이 화면과 다릅니다")
        expect(self.page.locator("#b-draft-keep")).to_be_visible()
        self.assertEqual((h.PATIENT, "SYN A mine"), (self.selected(), self.page.locator("#findings").input_value()))
        self.assertEqual("SYN other window", self.stored(h.UID)["findings"])

    def test_doctor_path_without_unconfirmed_text_switches_synchronously(self):
        self.open()
        self.open_study(h.PATIENT)
        # Nothing typed: the row click switches inside the same event, as before W4.
        moved = self.page.evaluate("""uid => { document.querySelector(`#rows tr[data-uid="${uid}"]`).click();
                                                return selectedUid; }""", h.UID_B)
        self.assertEqual(h.UID_B, moved)
        # Typed text that the autosave already confirmed: still the same synchronous switch.
        self.type("SYN B saved")
        self.page.clock.run_for(20001)
        self.wait(lambda: self.stored(h.UID_B) is not None, "the autosave")
        self.wait(lambda: not self.page.evaluate("reportConverge.has(selectedUid)"), "the confirmed autosave")
        writes = len(self.site.flow_puts)
        moved = self.page.evaluate("""() => { document.querySelector('#b-next').click(); return selectedUid; }""")
        self.assertEqual(UID_C, moved)
        self.assertEqual(writes, len(self.site.flow_puts), "no extra write on the doctor's path")
        expect(self.notice()).to_be_hidden()

    def test_composition_open_row_click_and_next_stay_and_say_so(self):
        self.open()
        self.open_study(h.PATIENT)
        cdp = self.compose()
        self.row(h.PATIENT_B).dispatch_event("click")
        expect(self.notice()).to_contain_text("Not Moved")
        expect(self.notice()).to_contain_text("조합")
        self.assertEqual(h.PATIENT, self.selected())
        self.page.locator("#b-next").dispatch_event("click")
        self.assertEqual(h.PATIENT, self.selected())
        self.assertTrue(self.page.evaluate("reportFrame.isComposing()"), "the composition stays open")
        cdp.send("Input.insertText", {"text": "한"})
        cdp.detach()
        self.pick(h.PATIENT_B)
        self.wait(lambda: self.selected() == h.PATIENT_B, "the move once the composition ended and was saved")
        self.assertEqual("한", self.stored(h.UID)["findings"])

    def test_composition_started_while_the_save_is_out_keeps_the_study(self):
        self.open()
        self.open_study(h.PATIENT)
        self.type("SYN A typed")
        self.site.put_answers = ["hold"]
        writes = len(self.site.flow_puts)
        self.hold_page_time()
        self.pick(h.PATIENT_B)
        self.held_navigation_write(h.UID, "SYN A typed", writes)
        cdp = self.compose()
        self.site.finish_flow_put()
        self.release_page_time()
        expect(self.notice()).to_contain_text("Not Moved")
        self.assertEqual(h.PATIENT, self.selected(), "no move while the reader is composing")
        cdp.send("Input.insertText", {"text": "한"})
        cdp.detach()

    # ── QUEUE-ANCHOR (W4-PAGE-04/05/08) ──
    def approve_next(self):
        self.page.locator("#b-approve-next").click()

    def refresh(self):
        self.page.locator("#m-refresh").click()

    def sort_by_name_descending(self):
        self.page.locator("#heads th[data-key=name]").click()
        self.page.locator("#heads th[data-key=name]").click()   # CHARLIE, BRAVO, ALPHA

    def drop_from_the_list(self, uid, patient):
        """The server stops listing the study (another reader, a filter on the server) and the reader presses Refresh."""
        self.site.hidden.add(uid)
        self.refresh()
        self.wait(lambda: patient not in self.page.locator("#rows").inner_text(), patient + " left the list")

    def test_approve_and_next_keeps_the_press_time_successor_when_the_list_is_sorted_during_the_answer(self):
        """ANCHOR_REORDER (W4F-02): the anchor taken at the press (B, its place, C after it) decides; a sort while the
        approval's answer is out does not pick the row that now follows B."""
        self.open()
        self.open_study(h.PATIENT_B)
        self.type("SYN B anchor")
        self.site.commit_answers = ["hold"]
        self.approve_next()
        self.wait(lambda: self.site.held_flow_commits, "the commit")
        self.sort_by_name_descending()
        self.site.finish_flow_commit()
        self.wait(lambda: self.selected() != h.PATIENT_B, "the move after the accepted approval")
        self.assertEqual((PATIENT_C, PATIENT_C), (self.selected(), self.editor_of()))

    def test_next_revalidates_its_target_after_the_save_wait(self):
        """NEXT_REMOVED (W4F-02): Next's target left the list while A's draft write was out. The move goes to the next
        candidate of the press-time queue that is still listed, never into the row that is gone."""
        self.open()
        self.open_study(h.PATIENT)
        self.type("SYN pending navigation")
        self.site.put_answers = ["hold"]
        writes = len(self.site.flow_puts)
        self.hold_page_time()
        self.page.locator("#b-next").click()
        self.held_navigation_write(h.UID, "SYN pending navigation", writes)
        self.drop_from_the_list(h.UID_B, h.PATIENT_B)
        self.assertEqual((h.PATIENT, h.PATIENT), (self.selected(), self.editor_of()), "nothing moved before the answer")
        self.site.finish_flow_put()
        self.release_page_time()
        self.wait(lambda: self.selected() != h.PATIENT, "the move after the confirmed write")
        self.assertEqual((PATIENT_C, PATIENT_C), (self.selected(), self.editor_of()))
        self.assertEqual("SYN pending navigation", self.stored(h.UID)["findings"])

    def test_next_keeps_its_press_time_target_when_the_list_is_sorted_during_the_save_wait(self):
        self.open()
        self.open_study(h.PATIENT)
        self.type("SYN A sorted")
        self.site.put_answers = ["hold"]
        writes = len(self.site.flow_puts)
        self.hold_page_time()
        self.page.locator("#b-next").click()   # BRAVO follows ALPHA in the order the reader sees
        self.held_navigation_write(h.UID, "SYN A sorted", writes)
        self.sort_by_name_descending()          # ALPHA is now the last row
        self.site.finish_flow_put()
        self.release_page_time()
        self.wait(lambda: self.selected() != h.PATIENT, "the move after the confirmed write")
        self.assertEqual(h.PATIENT_B, self.selected())

    def test_next_stays_when_its_target_and_every_later_candidate_left_during_the_save_wait(self):
        self.open()
        self.open_study(h.PATIENT_B)
        self.type("SYN B before the last row")
        self.site.put_answers = ["hold"]
        writes = len(self.site.flow_puts)
        self.hold_page_time()
        self.page.locator("#b-next").click()   # CHARLIE, the last row
        self.held_navigation_write(h.UID_B, "SYN B before the last row", writes)
        self.drop_from_the_list(UID_C, PATIENT_C)
        self.site.finish_flow_put()
        self.release_page_time()
        self.settle(400)
        self.assertEqual(h.PATIENT_B, self.selected(), "no later candidate: it stays, never the first row")
        self.assertEqual("SYN B before the last row", self.stored(h.UID_B)["findings"])

    def test_prev_follows_the_same_anchor_rule_across_the_save_wait(self):
        self.open()
        self.open_study(PATIENT_C)
        self.type("SYN C typed")
        self.site.put_answers = ["hold"]
        writes = len(self.site.flow_puts)
        self.hold_page_time()
        self.page.locator("#b-prev").click()   # BRAVO
        self.held_navigation_write(UID_C, "SYN C typed", writes)
        self.drop_from_the_list(h.UID_B, h.PATIENT_B)
        self.site.finish_flow_put()
        self.release_page_time()
        self.wait(lambda: self.selected() != PATIENT_C, "the move after the confirmed write")
        self.assertEqual(h.PATIENT, self.selected())

    def test_retry_after_the_target_left_goes_to_the_next_candidate(self):
        # The anchor travels with the Notice: Retry moves by the press-time queue, re-checked when it moves.
        self.open()
        self.open_study(h.PATIENT)
        self.type("SYN A refused first")
        self.site.put_answers = [(403, {"code": "REPORT_FORBIDDEN", "message": "SYN refused write"})]
        self.page.locator("#b-next").click()
        expect(self.notice()).to_contain_text("Save Failed")
        self.drop_from_the_list(h.UID_B, h.PATIENT_B)
        self.page.locator("#report-notice-retry").click()
        self.wait(lambda: self.selected() != h.PATIENT, "Retry saves and moves")
        self.assertEqual(PATIENT_C, self.selected())

    def test_approve_and_next_under_a_w_filter_goes_to_the_following_row_not_the_first(self):
        self.open()
        self.filter_waiting()
        self.open_study(h.PATIENT_B)
        self.type("SYN B report")
        self.approve_next()
        self.wait(lambda: self.selected() == PATIENT_C, "Approve & Next to the row after B")
        self.assertEqual("A", self.site.store[h.UID_B]["report"]["rs"])
        self.assertEqual("SYN B report", self.site.store[h.UID_B]["report"]["findings"])
        self.assertEqual(PATIENT_C, self.editor_of())
        self.assertNotIn(h.PATIENT_B, self.page.locator("#rows").inner_text(), "the approved study left the W filter")

    def test_approve_and_next_follows_the_sorted_order_the_reader_sees(self):
        self.open()
        self.page.locator("#heads th[data-key=name]").click()
        self.page.locator("#heads th[data-key=name]").click()   # descending: CHARLIE, BRAVO, ALPHA
        self.filter_waiting()
        self.open_study(h.PATIENT_B)
        self.type("SYN B report")
        self.approve_next()
        self.wait(lambda: self.selected() == h.PATIENT, "the next row in the sorted queue")

    def test_approve_under_the_read_req_filter_closes_the_request_and_next_goes_to_the_following_request(self):
        # Read Req: every study asked to be read; the reader works through them under the Requested filter.
        self.site.requested = {h.UID, h.UID_B, UID_C}
        self.open()
        self.page.select_option("#filterrow [data-f=readReq]", "Requested")
        self.open_study(h.PATIENT_B)
        self.type("SYN B report")
        self.page.locator("#b-approve").click()
        self.wait(lambda: self.site.store[h.UID_B]["report"]["rs"] == "A", "the approval")
        # The approval closed B's request: it leaves the Requested filter and its Read Req cell is blank.
        self.wait(lambda: h.PATIENT_B not in self.page.locator("#rows").inner_text(), "B left the Requested filter")
        self.assertEqual("", self.page.evaluate("u => studies.find(s => s.uid === u).readReq", h.UID_B))
        self.settle()
        self.assertEqual(h.PATIENT_B, self.selected(), "Approve stays on the study")
        # Approve & Next from the next requested study goes to the one after it under the same filter.
        self.open_study(h.PATIENT)
        self.type("SYN A report")
        self.approve_next()
        self.wait(lambda: self.selected() == PATIENT_C, "Approve & Next to the next requested study")
        self.wait(lambda: h.PATIENT not in self.page.locator("#rows").inner_text(), "A left the Requested filter")
        self.assertEqual("A", self.site.store[h.UID]["report"]["rs"])

    def test_plain_approve_stays_and_next_continues_from_the_anchor(self):
        self.open()
        self.filter_waiting()
        self.open_study(h.PATIENT_B)
        self.type("SYN B report")
        self.page.locator("#b-approve").click()
        self.wait(lambda: self.site.store[h.UID_B]["report"]["rs"] == "A", "the approval")
        self.wait(lambda: h.PATIENT_B not in self.page.locator("#rows").inner_text(), "B left the filter")
        self.settle()
        self.assertEqual(h.PATIENT_B, self.selected(), "Approve stays on the study")
        self.page.locator("#b-next").click()
        self.wait(lambda: self.selected() is not None and self.selected() != h.PATIENT_B, "Next")
        self.assertEqual(PATIENT_C, self.selected(), "Next continues after B, not the first row")

    def test_refresh_between_press_and_answer_keeps_the_anchor(self):
        self.open()
        self.filter_waiting()
        self.open_study(h.PATIENT_B)
        self.type("SYN B report")
        self.site.commit_answers = ["hold"]
        self.approve_next()
        self.wait(lambda: self.site.held_flow_commits, "the commit")
        lists = self.site.count("GET", "/api/studies")
        self.page.locator("#m-refresh").click()
        self.wait(lambda: self.site.count("GET", "/api/studies") > lists, "the refresh")
        self.settle(300)
        self.assertEqual(h.PATIENT_B, self.selected(), "no move before the approval's answer is applied")
        self.site.finish_flow_commit()
        self.wait(lambda: self.selected() == PATIENT_C, "the move after the accepted commit")

    def test_approve_and_next_unknown_or_refused_never_moves(self):
        self.open()
        self.open_study(h.PATIENT_B)
        self.type("SYN B report")
        # Refused: the server's version moved on (another reader saved).
        self.site.store[h.UID_B]["report"]["version"] = 3
        self.site.commit_answers = [(409, {"code": "REPORT_VERSION_CONFLICT", "message": "SYN refused commit"})]
        self.approve_next()
        self.wait(lambda: self.site.flow_commits, "the refused commit")
        self.settle(300)
        self.assertEqual(h.PATIENT_B, self.selected())
        self.site.store[h.UID_B]["report"]["version"] = 0
        # Unknown: the server stores the approval but its answer is lost; the page reads the state afterwards.
        self.site.commit_answers = ["lost"]
        self.approve_next()
        self.wait(lambda: self.site.store[h.UID_B]["report"]["rs"] == "A", "the server stored the approval")
        self.settle(500)
        self.assertEqual(h.PATIENT_B, self.selected(), "an approval whose answer was lost does not move")

    def test_an_approval_refused_for_the_signing_key_says_why_long_enough_to_read(self):
        """The server refuses an approval when the reader has no usable signing key (503, code DoctorSigningKeyUnavailable)
        and its answer says so. The page shows that refusal in its own words for the action (the same words as the server's
        approval refusal, so the screen language reaches them) and keeps them up for 12 s, where another refusal keeps the
        server's words for its 4 s: this one the reader cannot solve alone and has to pass on. The typed text stays and
        nothing is approved."""
        refusal = "SYN signing key refusal. 판독 입력은 보존됩니다."
        approve_words = ("이 계정에서 사용할 수 있는 서명키를 확인하지 못해 승인하지 못했습니다. 기관 관리자에게 서명키(Signing Key)와 "
                         "계정 정보 확인을 요청하세요. 판독 입력은 보존됩니다.")
        toast, shown = self.page.locator("#toast"), re.compile(r"(^|\s)show(\s|$)")
        self.open()
        self.open_study(h.PATIENT_B)
        self.type("SYN B findings")
        self.type("SYN B conclusion", "conclusion")
        self.hold_page_time()
        for code, shown_ms in (("SYN_OTHER_REFUSAL", 4000), ("DoctorSigningKeyUnavailable", 12000)):
            with self.subTest(code=code):
                commits = len(self.site.flow_commits)
                self.site.commit_answers = [(503, {"code": code, "message": refusal})]
                self.page.locator("#b-approve").click()
                self.wait(lambda: len(self.site.flow_commits) > commits, "the refused approval")
                expect(toast).to_have_text("저장 실패: " + (approve_words if code == "DoctorSigningKeyUnavailable" else refusal))
                expect(toast).to_have_class(shown)
                self.page.clock.run_for(shown_ms - 500)
                expect(toast).to_have_class(shown)
                self.page.clock.run_for(1000)
                expect(toast).not_to_have_class(shown)
                self.assertEqual(("SYN B findings", "SYN B conclusion"),
                                 (self.page.locator("#findings").input_value(), self.page.locator("#conclusion").input_value()))
                self.assertNotEqual("A", self.site.store[h.UID_B]["report"]["rs"])
        self.release_page_time()

    def test_the_clinical_context_title_is_drawn_only_for_the_roles_that_get_the_panel(self):
        """The Clinical Context panel is for radiologists and admins; another role gets neither the panel nor its read.
        The title in the Clinical band's head is drawn by the stylesheet, so it has to follow the same roles: a
        technician saw the title over an empty half."""
        technician = {**h.RAD, "sub": "SYN-TECH-SUB", "actor": "syn-tech@synthetic.test", "user": "syn-tech@synthetic.test",
                      "displayName": "SYN Technician", "roles": ["technician"]}
        title = "() => getComputedStyle(document.querySelector('.s-clinical > h3'), '::after').content"
        reads = lambda: self.site.count("GET", f"/api/studies/{h.UID}/clinical-context")
        for who, drawn in ((h.RAD, True), (h.ADMIN, True), (technician, False)):
            with self.subTest(roles=who["roles"]):
                self.site.account = who
                before = reads()
                self.open()
                expect(self.page.locator("#user")).to_have_text(who["displayName"])
                self.assertEqual('"Clinical Context"' if drawn else "none", self.page.evaluate(title))
                self.pick(h.PATIENT)
                self.wait(lambda: self.selected() == h.PATIENT, "the study opens")
                region = self.page.locator("#clinical-context")
                if drawn:
                    expect(region).to_be_visible()
                    self.wait(lambda: reads() > before, "the panel's read")
                else:
                    self.settle(300)
                    expect(region).to_be_hidden()
                    self.assertEqual(before, reads(), "no read for a role without the panel")
                self.assertEqual('"Clinical Context"' if drawn else "none", self.page.evaluate(title))

    def test_late_commit_answer_cannot_move_after_the_reader_chose_another_study(self):
        self.open()
        self.open_study(h.PATIENT_B)
        self.type("SYN B report")
        self.site.commit_answers = ["hold"]
        self.approve_next()
        self.wait(lambda: self.site.held_flow_commits, "the commit")
        self.pick(h.PATIENT)                       # the reader asks for A while the approval is out
        self.page.clock.run_for(3001)
        expect(self.notice()).to_contain_text("Result Unknown")
        self.site.finish_flow_commit()
        self.wait(lambda: self.site.store[h.UID_B]["report"]["rs"] == "A", "the accepted approval")
        self.settle(400)
        self.assertEqual(h.PATIENT_B, self.selected(), "the late answer neither goes to C nor jumps to A by itself")
        self.page.locator("#report-notice-check").click()
        self.wait(lambda: self.selected() == h.PATIENT, "the reader's own choice, confirmed")

    def test_a_b_a_late_commit_answer_cannot_move_another_selection(self):
        self.open()
        self.open_study(h.PATIENT_B)
        self.type("SYN B report")
        self.site.commit_answers = ["hold"]
        self.approve_next()
        self.wait(lambda: self.site.held_flow_commits, "the commit")
        # The reader's own A -> B while the answer is out (the wait ends with the accepted answer).
        self.pick(h.PATIENT)
        self.site.finish_flow_commit()
        self.wait(lambda: self.selected() == h.PATIENT, "the reader's move after the accepted answer")
        self.pick(h.PATIENT_B)
        self.wait(lambda: self.selected() == h.PATIENT_B, "back to B")
        self.settle(400)
        self.assertEqual(h.PATIENT_B, self.selected(), "the earlier Approve & Next does not move this selection")

    def test_approve_and_next_pressed_during_a_composition_approves_and_stays_with_the_notice(self):
        self.open()
        self.open_study(h.PATIENT_B)
        self.type("SYN B report")
        cdp = self.compose()
        # Pressed by script while the composition is open (a real press would end it first).
        self.page.locator("#b-approve-next").dispatch_event("click")
        self.wait(lambda: self.site.store[h.UID_B]["report"]["rs"] == "A", "the accepted approval")
        self.assertEqual("SYN B report한", self.site.store[h.UID_B]["report"]["findings"])
        expect(self.notice()).to_contain_text("Not Moved")
        self.assertEqual(h.PATIENT_B, self.selected(), "no move while the composition is open")
        cdp.send("Input.insertText", {"text": ""})
        cdp.detach()

    def test_approved_study_keeps_approve_and_next_disabled_with_the_reason(self):
        self.site.store[h.UID_B]["report"] = {"version": 2, "rs": "A", "findings": "SYN approved", "conclusion": "",
                                             "recommendation": ""}
        self.open()
        self.open_study(h.PATIENT_B)
        for button in ("#b-approve", "#b-approve-next", "#b-save"):
            expect(self.page.locator(button)).to_be_disabled()
            expect(self.page.locator(button)).to_have_attribute("title", re.compile("Addendum"))

    # ── RECOMMENDATION-ROUNDTRIP (W4-PAGE-12) ──
    def insert_template(self):
        h.show_all_panels(self.page)
        self.page.keyboard.press("Control+Alt+T")
        self.page.locator("#tplrows tr", has_text=TEMPLATE["title"]).first.dblclick()

    def test_history_actions_use_english_names_with_korean_meanings(self):
        self.open(); self.open_study(h.PATIENT)
        expected = [('save','Save','임시저장'),('approve','Approve','승인'),('addendum','Addendum','추가기재'),
                    ('reset','Reset','판독취소'),('preliminary','Prelim','예비판독'),('discarded','Discarded draft','폐기된 초안')]
        versions = [dict(version=i+1, action=action, author='SYN Doctor', at='2026-10-01T00:00:00Z') for i,(action,_,_) in enumerate(expected)]
        self.page.route('**/api/studies/*/report/versions', lambda route: route.fulfill(json=versions))
        self.page.locator('#report-more > summary').click()
        self.page.locator('#b-history').click()
        expect(self.page.locator('#histmodal')).to_be_visible()
        for action, label, meaning in expected:
            badge = self.page.locator('#hist-body .tag.'+action)
            expect(badge).to_have_text(label)
            expect(badge).to_have_attribute('title', meaning)

    def test_history_names_each_signer_and_shows_this_screens_minute(self):
        """History names who signed each version by the member name the server sends (the stored login when it sends none)
        and shows its time as this screen's (Asia/Seoul) YYYY-MM-DD HH:mm; the approval that opened the current cycle shows
        the approval time the study keeps (the worklist Confirm cell's), not its row's own clock."""
        self.open(); self.open_study(h.PATIENT)
        versions = [dict(version=3, action='addendum', author='syn.second@example.test', authorName='SYN Lee Second',
                         at='2026-11-18T01:30:00.000Z'),
                    dict(version=2, action='approve', author='syn.reader@example.test', authorName='SYN Kim Reader',
                         at='2026-11-17T18:05:59.990Z', keptAt='2026-11-17T18:06:00.000Z'),
                    dict(version=1, action='save', author='SYN Doctor', at='2026-11-17T17:00:00.000Z')]
        self.page.route('**/api/studies/*/report/versions', lambda route: route.fulfill(json=versions))
        self.page.locator('#report-more > summary').click()
        self.page.locator('#b-history').click()
        heads = self.page.locator('#hist-body .ver .vh')
        expect(heads).to_have_count(3)
        expect(heads.nth(0)).to_contain_text('SYN Lee Second')
        expect(heads.nth(0)).to_contain_text('2026-11-18 10:30')
        expect(heads.nth(1)).to_contain_text('SYN Kim Reader')
        expect(heads.nth(1)).to_contain_text('2026-11-18 03:06')
        expect(heads.nth(2)).to_contain_text('SYN Doctor')
        expect(heads.nth(2)).to_contain_text('2026-11-18 02:00')
        shown = self.page.locator('#hist-body').inner_text()
        for leaked in ('syn.second@', 'syn.reader@', '2026-11-17 18:0', '2026-11-18 01:30', 'T18:', ':59'):
            self.assertNotIn(leaked, shown)

    def test_history_names_a_version_without_a_kept_name_by_its_stored_login(self):
        """A version signed before signing names were kept (the server sends no authorName) shows the login it stored, as
        is - not the name the screen knows for that account now (the signed-in reader's display name here), so renaming a
        member never changes who an already signed version names."""
        self.open(); self.open_study(h.PATIENT)
        versions = [dict(version=2, action='addendum', author=h.RAD['actor'], authorName='SYN Kim Renamed', at='2026-11-18T01:30:00.000Z'),
                    dict(version=1, action='approve', author=h.RAD['actor'], at='2026-11-17T17:00:00.000Z')]
        self.page.route('**/api/studies/*/report/versions', lambda route: route.fulfill(json=versions))
        self.page.locator('#report-more > summary').click()
        self.page.locator('#b-history').click()
        heads = self.page.locator('#hist-body .ver .vh')
        expect(heads).to_have_count(2)
        expect(heads.nth(0)).to_contain_text('SYN Kim Renamed')
        expect(heads.nth(1)).to_contain_text(h.RAD['actor'])
        self.assertNotIn(h.RAD['displayName'], heads.nth(1).inner_text())

    def test_existing_report_recommendation_is_a_read_only_line(self):
        self.site.store[h.UID]['report'].update(version=1, rs='A', findings='SYN existing findings',
            conclusion='SYN existing conclusion', recommendation='SYN existing recommendation')
        self.open()
        self.open_study(h.PATIENT)
        note = self.page.locator('#recnote')
        expect(note).to_be_visible()
        expect(note).to_have_text('Recommendation: SYN existing recommendation')
        self.assertEqual('nowrap', note.evaluate('e => getComputedStyle(e).whiteSpace'))
        self.assertEqual(0, note.locator('textarea, input, [contenteditable=true]').count())
        self.pick(h.PATIENT_B)
        self.wait(lambda: self.selected() == h.PATIENT_B, 'B')
        expect(note).to_be_hidden()
        self.pick(h.PATIENT)
        self.wait(lambda: self.selected() == h.PATIENT, 'A again')
        expect(note).to_have_text('Recommendation: SYN existing recommendation')

    def test_recommendation_from_a_template_is_announced_read_only_saved_and_shown_again(self):
        self.site.templates = [TEMPLATE]
        self.open()
        self.open_study(h.PATIENT)
        expect(self.page.locator("#recnote")).to_be_hidden()
        self.insert_template()
        note = self.page.locator("#recnote")
        expect(note).to_be_visible()
        expect(note).to_contain_text("Recommendation:")
        self.assertEqual("nowrap", note.evaluate("e => getComputedStyle(e).whiteSpace"))
        expect(self.page.locator("#recnote-text")).to_have_text(TEMPLATE["recommendation"])
        # Read only: no editor in the notice, the hidden field stays hidden and out of reach.
        self.assertEqual(0, note.locator("textarea, input, [contenteditable=true]").count())
        hidden = self.page.locator("#recommendation")
        self.assertEqual(("true", "-1"), (hidden.get_attribute("aria-hidden"), hidden.get_attribute("tabindex")))
        self.page.locator("#conclusion").focus()
        self.page.keyboard.press("Tab")
        self.assertNotEqual("recommendation", self.page.evaluate("document.activeElement?.id"))
        # Saved with the other two fields (the autosave's whole snapshot), and shown again when the study reopens.
        self.page.clock.run_for(20001)
        self.wait(lambda: self.stored(h.UID) is not None, "the autosave")
        self.assertEqual(TEMPLATE["recommendation"], self.site.flow_puts[-1][1]["recommendation"])
        self.assertEqual({k: TEMPLATE[k] for k in FIELDS}, self.stored(h.UID))
        self.pick(h.PATIENT_B)
        self.wait(lambda: self.selected() == h.PATIENT_B, "B")
        expect(note).to_be_hidden()
        self.pick(h.PATIENT)
        self.wait(lambda: self.selected() == h.PATIENT, "A again")
        expect(note).to_be_visible()
        self.page.goto(h.MAIN_URL)
        self.open_study(h.PATIENT)
        expect(note).to_be_visible()
        expect(self.page.locator("#recnote-text")).to_have_text(TEMPLATE["recommendation"])
        # The approval carries the three fields.
        self.page.locator("#b-approve").click()
        self.wait(lambda: self.site.flow_commits, "the approval")
        self.assertEqual(TEMPLATE["recommendation"], self.site.flow_commits[-1][1]["recommendation"])

    # ── MENU-TARGET (W4-PAGE-10) ──
    def right_click(self, patient):
        """A context menu on the row as the mouse opens it (dispatched: a real right press would end a composition)."""
        row = self.row(patient)
        box = row.evaluate("tr => { const r = tr.getBoundingClientRect(); return { x: r.x, y: r.y }; }")
        row.dispatch_event("contextmenu", {"clientX": box["x"] + 5, "clientY": box["y"] + 5, "button": 2})

    def menu_shown(self):
        return self.page.evaluate("getComputedStyle(document.querySelector('#ctx')).display !== 'none'")

    def test_menu_during_composition_does_not_open_for_another_row(self):
        self.open()
        self.open_study(h.PATIENT)
        cdp = self.compose()
        self.right_click(h.PATIENT_B)
        self.assertFalse(self.menu_shown(), "no menu of B while A stays selected")
        self.assertEqual(h.PATIENT, self.selected())
        expect(self.notice()).to_contain_text("Not Moved")
        cdp.send("Input.insertText", {"text": "한"})
        cdp.detach()

    def test_menu_on_a_non_selected_row_opens_after_the_move_and_acts_on_that_row(self):
        self.open()
        self.open_study(h.PATIENT)
        self.type("SYN A typed")
        self.site.put_answers = ["hold"]
        writes = len(self.site.flow_puts)
        self.hold_page_time()
        self.right_click(h.PATIENT_B)
        self.held_navigation_write(h.UID, "SYN A typed", writes)
        self.assertFalse(self.menu_shown(), "the menu waits for the move")
        self.site.finish_flow_put()
        self.release_page_time()
        self.wait(self.menu_shown, "the menu of B once B is selected")
        self.assertEqual(h.PATIENT_B, self.selected())
        self.page.locator("#ctx [data-i]", has_text="판독문 작성으로").click()
        self.assertEqual("findings", self.page.evaluate("document.activeElement?.id"))
        self.assertEqual(h.PATIENT_B, self.editor_of())

    def test_menu_item_bound_to_its_row_does_nothing_after_the_selection_moved(self):
        self.open()
        self.open_study(h.PATIENT)
        self.right_click(h.PATIENT_B)
        self.wait(self.menu_shown, "the menu of B")
        # The selection moves on (keyboard Next) while the menu is still open.
        self.page.evaluate("() => select(studies.find(s => s.name === 'SYN PATIENT CHARLIE').uid)")
        self.page.locator("#ctx [data-i]", has_text="판독문 작성으로").dispatch_event("click")
        self.assertNotEqual("findings", self.page.evaluate("document.activeElement?.id"))

    # ── MENU-TARGET in the Technician tab: items that act on the current selection (W4F-03) ──
    def technician(self, matched):
        """A technician-capable account on the Technician tab, one unmatched order, and `matched` (uid -> M) as the
        studies' match state. The match/unmatch writes are recorded and refused (nothing changes on the server)."""
        self.site.account = {**h.RAD, "roles": ["admin", "radiologist", "technician"]}
        state_of = self.site.state_of
        self.site.state_of = lambda uid, account: {**state_of(uid, account), "matched": matched.get(uid, "U")}
        self.site.orders = [{"oid": "SYN-O-1", "id": "SYN-P-009", "name": "SYN ORDER NINE", "sex": "M", "birth": "1980-01-01",
                             "sched": "2026-10-03 09:00", "modality": "CT", "desc": "SYN CT CHEST", "ward": "", "reqDoc": "",
                             "matched": "U", "studyUid": None}]
        self.writes_to = {"match": [], "unmatch": []}

        def refuse(route, kind):
            self.writes_to[kind].append(route.request.post_data_json)
            route.fulfill(status=403, json={"code": "SYN_REFUSED", "message": "SYN keeps the data"})
        for kind in ("match", "unmatch"):
            self.context.route("**/api/" + kind, lambda route, request, kind=kind: refuse(route, kind))
        self.open()
        self.page.locator("[data-tab=Technician]").click()
        expect(self.page.locator("#orderrows tr[data-oid]")).to_have_count(1)

    def menu_item(self, label):
        return self.page.locator("#ctx [data-i]").filter(has_text=re.compile("^" + re.escape(label) + "$"))

    def menu_then_keyboard(self, patient, key="ArrowDown"):
        """The row menu of `patient` (selected first), then - menu still open - the keyboard selects the next row."""
        self.open_study_row(patient)
        self.right_click(patient)
        self.wait(self.menu_shown, "the menu of " + patient)
        self.row(patient).focus()
        self.page.keyboard.press(key)
        self.page.keyboard.press("Enter")

    def open_study_row(self, patient):
        self.pick(patient)
        self.wait(lambda: self.selected() == patient, patient)

    MENU_CANCELLED = "메뉴를 연 뒤 선택한 검사가 바뀌어 실행하지 않았습니다"

    def test_technician_unmatch_and_modify_send_nothing_once_the_keyboard_selected_another_study(self):
        """MENU_UNMATCH (W4F-03): with B's row menu open the keyboard selects C (both matched, both RS W). Unmatch and
        Modify Exam act on the current selection when they run; they must send nothing for C - nor for B, whose selection
        the menu no longer is - open nothing, and say why."""
        self.technician({h.UID_B: "M", UID_C: "M"})
        self.menu_then_keyboard(h.PATIENT_B)
        self.assertEqual(PATIENT_C, self.selected())
        self.menu_item("Unmatch").click()
        expect(self.page.locator("#toast")).to_contain_text(self.MENU_CANCELLED)
        self.menu_then_keyboard(h.PATIENT_B)
        self.assertEqual(PATIENT_C, self.selected())
        self.menu_item("Modify Exam").click()
        self.settle(300)
        self.assertEqual(0, self.page.locator("#modal.show").count(), "no Modify Exam form for C")
        self.assertEqual({"match": [], "unmatch": []}, self.writes_to)
        self.assertEqual([], self.dialogs)

    def test_technician_match_sends_nothing_once_the_keyboard_selected_another_study(self):
        """W4F-03: Match pairs the current selection with the selected order when it runs. From A's row menu, and from
        the Order List's own menu, after the keyboard selected B (unmatched too), nothing is asked or sent."""
        self.technician({})
        self.page.locator("#orderrows tr[data-oid]").click()
        self.menu_then_keyboard(h.PATIENT)
        self.assertEqual(h.PATIENT_B, self.selected())
        self.menu_item("Match").click()
        expect(self.page.locator("#toast")).to_contain_text(self.MENU_CANCELLED)
        # The Order List's menu, opened while C is selected; the keyboard then selects B.
        self.open_study_row(PATIENT_C)
        order = self.page.locator("#orderrows tr[data-oid]")
        box = order.evaluate("tr => { const r = tr.getBoundingClientRect(); return { x: r.x, y: r.y }; }")
        order.dispatch_event("contextmenu", {"clientX": box["x"] + 5, "clientY": box["y"] + 5, "button": 2})
        self.wait(self.menu_shown, "the Order List menu")
        self.row(PATIENT_C).focus()
        self.page.keyboard.press("ArrowUp")
        self.page.keyboard.press("Enter")
        self.assertEqual(h.PATIENT_B, self.selected())
        self.menu_item("Match").click()
        self.settle(300)
        self.assertEqual({"match": [], "unmatch": []}, self.writes_to)
        self.assertEqual([], self.dialogs, "nothing was asked either (Match asks before it sends)")

    def test_technician_menu_item_acts_on_the_row_it_was_opened_on(self):
        # The doctor's and technician's normal path: the menu of the selected row acts on that row, with one click.
        self.technician({h.UID_B: "M"})
        self.open_study_row(h.PATIENT_B)
        self.right_click(h.PATIENT_B)
        self.wait(self.menu_shown, "the menu of B")
        self.menu_item("Unmatch").click()
        self.wait(lambda: self.writes_to["unmatch"], "the Unmatch request")
        self.assertEqual([{"uid": h.UID_B}], self.writes_to["unmatch"])

    # ── Ctrl+S dispatch to Finalize (Approve) ──
    def test_ctrl_s_runs_finalize_and_prevents_save_page_only_when_it_runs(self):
        self.open()
        self.open_study(h.PATIENT)
        self.type("SYN A by keyboard")
        self.page.locator("#findings").focus()
        self.assertTrue(self.page.evaluate(CTRL_S), "the command runs: the browser's Save Page is prevented")
        self.wait(lambda: self.site.flow_commits, "the approval by Ctrl+S")
        self.assertEqual("approve", self.site.flow_commits[-1][1]["action"])
        self.assertEqual("SYN A by keyboard", self.site.flow_commits[-1][1]["findings"])
        self.wait(lambda: self.site.store[h.UID]["report"]["rs"] == "A", "the approval")
        self.settle(300)
        self.assertEqual(h.PATIENT, self.selected(), "Finalize stays on the study")
        # Approved: the command cannot run, so the browser keeps its own Ctrl+S.
        expect(self.page.locator("#b-approve")).to_be_disabled()
        self.assertFalse(self.page.evaluate(CTRL_S), "nothing ran: the browser default is left alone")
        self.settle()
        self.assertEqual(1, len(self.site.flow_commits))

    def test_report_commands_finalize_answers_true_only_when_the_command_ran(self):
        """D1371: the hook a bound viewer frame forwards its Finalize key to (the frame keeps the browser's Ctrl+S
        unless it answers true)."""
        self.open()
        self.open_study(h.PATIENT)
        self.type("SYN A by the hook")
        self.site.commit_answers = ["hold"]
        self.assertIs(True, self.page.evaluate("KinReportCommands.finalize()"))
        self.wait(lambda: self.site.held_flow_commits, "the approval by the hook")
        self.assertEqual("SYN A by the hook", self.site.flow_commits[-1][1]["findings"])
        # While that approval is out the command does not run again.
        self.assertIs(False, self.page.evaluate("KinReportCommands.finalize()"))
        self.site.finish_flow_commit()
        self.wait(lambda: self.site.store[h.UID]["report"]["rs"] == "A", "the approval")
        expect(self.page.locator("#b-approve")).to_be_disabled()
        self.assertIs(False, self.page.evaluate("KinReportCommands.finalize()"), "approved (A): Approve is refused")
        # Another study with an insertion out (setup only, see the module header): Approve's button stays as it is, but
        # the commit would return without doing anything, so the hook does not say it ran.
        self.open_study(h.PATIENT_B)
        expect(self.page.locator("#b-approve")).to_be_enabled()
        self.page.evaluate("insertInFlight = true")
        self.assertIs(False, self.page.evaluate("KinReportCommands.finalize()"))
        self.page.evaluate("insertInFlight = false")
        self.settle()
        self.assertEqual([h.UID], [uid for uid, _ in self.site.flow_commits], "one approval, by the first call")
        self.assertEqual(h.PATIENT_B, self.selected())

    def enter_reading_with_a_bound_viewer(self):
        """The Reading Workspace button, with the viewer document served as VIEWER_STAND_IN; returns once the viewer frame
        is shown and usable (the workspace binds its keyboard to the document before it lets the frame be used)."""
        viewer_loads = []
        self.context.route("**/ohif/viewer*", lambda route, request: (
            viewer_loads.append(request.url), route.fulfill(body=VIEWER_STAND_IN, content_type="text/html; charset=utf-8")))
        self.page.locator("#m-reading").click()
        self.wait(lambda: viewer_loads, "the viewer document request")
        self.wait(lambda: self.page.evaluate("() => { const f = document.querySelector('#reading-frame'); "
                                             "return !!f && !f.hidden && !f.inert; }"), "the usable viewer frame")

    def test_return_to_kept_viewer_refreshes_current_and_added_prior(self):
        self.open()
        self.open_study(h.PATIENT)
        self.enter_reading_with_a_bound_viewer()
        frame = self.page.locator("#reading-frame").element_handle().content_frame()
        order = ["ORDER"]
        reads = []

        def display_response(route):
            uids = route.request.url.split("uids=")[1].replace("%2C", ",").split(",")
            reads.append(uids)
            rows = []
            for uid in uids:
                values = {"id": order[0], "name": order[0], "over": ["id", "name"], "age": ""}
                rows.append({"uid": uid, "sourcePatientKey": "institution|SOURCE", "state": {"ov": {"id": order[0]}},
                             "displaySources": [{"sourcePatientKey": "institution|SOURCE", "studyUid": uid,
                                                 "series": {"mode": "all", "uids": []}, "values": values}]})
            route.fulfill(json={"studies": rows})

        frame.page.route("**/api/studies?uids=*", display_response)
        frame.add_script_tag(path=str(ROOT / "config/ohif/study-display.js"))
        frame.evaluate("""([current, prior]) => {
          window.kinViewerJobWorkspaceState = () => ({busy:false, dirty:true});
          const show = () => { document.querySelector('.cornerstone-canvas').textContent = [current, prior].map(
            uid => kinViewerStudyDisplay.of(uid, uid + '.1', 'SOURCE')?.id || 'SOURCE').join(' / '); };
          kinViewerStudyDisplay.subscribe(show); show();
        }""", [h.UID, UID_C])
        canvas = frame.locator(".cornerstone-canvas")
        expect(canvas).to_have_text("ORDER / ORDER")
        before = len(reads)
        order[0] = "CORRECTED"
        if not self.row(h.PATIENT_B).is_visible():
            self.page.get_by_role("button", name="Worklist", exact=True).click()
        self.pick(h.PATIENT_B)
        expect(self.page.locator("#reading-frame")).to_be_hidden()
        self.page.get_by_role("button", name="Return to Previous Viewer", exact=True).click()
        expect(self.page.locator("#reading-frame")).to_be_visible()
        expect(canvas).to_have_text("CORRECTED / CORRECTED")
        self.assertEqual([{h.UID, UID_C}], [set(uids) for uids in reads[before:]])

    def test_ctrl_s_in_the_bound_viewer_frame_runs_the_real_finalize_once(self):
        """D1371 end to end on the merged tree: Ctrl+S pressed in the viewer frame of the Reading Workspace approves the
        report with the typed text exactly once and prevents the browser's Save Page; once approved (A) it runs nothing
        and leaves the browser default alone."""
        self.open()
        self.open_study(h.PATIENT)
        self.type("SYN A from the viewer frame")
        self.enter_reading_with_a_bound_viewer()
        self.assertTrue(self.page.evaluate(FRAME_CTRL_S), "the command runs: the browser's Save Page is prevented")
        self.wait(lambda: self.site.flow_commits, "the approval by the frame's Ctrl+S")
        self.wait(lambda: self.site.store[h.UID]["report"]["rs"] == "A", "the approval")
        self.settle(300)
        self.assertFalse(self.page.evaluate(FRAME_CTRL_S), "approved (A): nothing ran, the browser default is left alone")
        self.settle()
        self.assertEqual([("approve", "SYN A from the viewer frame")],
                         [(body["action"], body["findings"]) for _, body in self.site.flow_commits], "exactly one commit")

    def test_ctrl_s_in_the_reading_workspace_top_document_runs_the_real_finalize_once(self):
        """The top document of the Reading Workspace (a bound viewer frame beside it): one Ctrl+S, one approval."""
        self.open()
        self.open_study(h.PATIENT)
        self.type("SYN A from the top document")
        self.enter_reading_with_a_bound_viewer()
        self.page.locator("#findings").focus()
        self.assertTrue(self.page.evaluate(CTRL_S), "the command runs: the browser's Save Page is prevented")
        self.wait(lambda: self.site.flow_commits, "the approval by the top document's Ctrl+S")
        self.settle(300)
        self.assertEqual([("approve", "SYN A from the top document")],
                         [(body["action"], body["findings"]) for _, body in self.site.flow_commits], "exactly one commit")

    # ── Finalize & Next (Approve & Next) by its key (FA-154 "두 동작 모두 단축키 필요"; unassigned until the reader gives one) ──
    APPROVE_NEXT_KEY = """([selector, frame]) => { const doc = frame ? document.querySelector('#reading-frame').contentDocument : document;
      const e = new KeyboardEvent('keydown', { key: 'n', code: 'KeyN', ctrlKey: true, altKey: true, bubbles: true, cancelable: true });
      doc.querySelector(selector).dispatchEvent(e); return e.defaultPrevented; }"""

    def give_approve_next_a_key(self):
        """As a reader does: Edit Shortcuts › Worklist › Finalize & Next, Ctrl+Alt+N, Apply & Save."""
        # The button stands in the reading workspace bar (hidden outside it); its dialog is the same.
        self.page.locator("#workspace-shortcuts-edit").dispatch_event("click")
        field = self.page.locator("#workspace-shortcut-finalizeNext")
        expect(field).to_have_value("Unassigned")
        field.focus(); self.page.keyboard.press("Control+Alt+KeyN")
        expect(field).to_have_value("Control+Alt+N")
        self.page.locator("#workspace-shortcuts-apply").click()
        expect(self.page.locator("#workspace-shortcuts-dialog")).to_be_hidden()

    def test_the_approve_and_next_key_is_the_button_and_never_moves_from_other_writing(self):
        self.open()
        self.open_study(h.PATIENT)
        self.type("SYN A by the Approve & Next key")
        self.assertFalse(self.page.evaluate(self.APPROVE_NEXT_KEY, ["#findings", False]), "no key by default")
        self.settle()
        self.assertEqual([], self.site.flow_commits)
        self.give_approve_next_a_key()
        # A field of other writing (the worklist search) does not move the reader on.
        self.assertFalse(self.page.evaluate(self.APPROVE_NEXT_KEY, ["#quick", False]))
        self.settle()
        self.assertEqual([], self.site.flow_commits)
        self.assertTrue(self.page.evaluate(self.APPROVE_NEXT_KEY, ["#findings", False]), "started from the report text")
        self.wait(lambda: self.site.flow_commits, "the approval by the key")
        self.assertEqual(("approve", "SYN A by the Approve & Next key"),
                         (self.site.flow_commits[-1][1]["action"], self.site.flow_commits[-1][1]["findings"]))
        self.wait(lambda: self.selected() != h.PATIENT, "the move to the next study after the accepted approval")
        self.settle()
        self.assertEqual(1, len(self.site.flow_commits))
        # Approved and moved: back on it, the button is locked, and so is the key (its reason is said, nothing is sent).
        self.open_study(h.PATIENT)
        expect(self.page.locator("#b-approve-next")).to_be_disabled()
        self.assertFalse(self.page.evaluate(self.APPROVE_NEXT_KEY, ["#findings", False]))
        self.settle()
        self.assertEqual(1, len(self.site.flow_commits))
        self.assertEqual(h.PATIENT, self.selected())
        expect(self.page.locator("#b-approve-next")).to_have_attribute("aria-keyshortcuts", "Control+Alt+N")

    def test_the_approve_and_next_key_in_the_bound_viewer_frame_approves_once_and_moves(self):
        self.open()
        self.open_study(h.PATIENT)
        self.type("SYN A from the frame's Approve & Next key")
        self.give_approve_next_a_key()
        self.enter_reading_with_a_bound_viewer()
        self.assertTrue(self.page.evaluate(self.APPROVE_NEXT_KEY, [".cornerstone-canvas", True]))
        self.wait(lambda: self.site.flow_commits, "the approval by the frame's key")
        self.wait(lambda: self.selected() != h.PATIENT, "the move after the accepted approval")
        self.settle()
        self.assertEqual([("approve", "SYN A from the frame's Approve & Next key")],
                         [(body["action"], body["findings"]) for _, body in self.site.flow_commits], "exactly one commit")

    # ── Unit 5 (C-R01-109#2, C-R01-008#1) ──
    def test_c_r01_109_an_unverified_study_says_beside_read_only_that_it_waits_for_verify(self):
        """C-R01-109#2: the editor of a study still being acquired is Read Only and says why (Verify first), with the
        words its locked buttons already carry; a verified study beside it stays Editable."""
        self.site.unverified.add(h.UID_B)
        self.open()
        self.pick(h.PATIENT_B)
        self.wait(lambda: self.selected() == h.PATIENT_B, "the unverified study opens")
        expect(self.page.locator("#report-editor-state")).to_have_text("Read Only")
        expect(self.page.locator("#report-editor-why")).to_have_text(
            "촬영 중(미확인) 검사입니다 — 기사 확인(Verify) 뒤 판독할 수 있습니다")
        self.assertEqual(self.page.locator("#report-editor-why").inner_text(), self.page.locator("#b-save").get_attribute("title"))
        expect(self.page.locator("#findings")).not_to_be_editable()
        expect(self.page.locator("#b-approve")).to_be_disabled()
        self.open_study(h.PATIENT)
        expect(self.page.locator("#report-editor-state")).to_have_text("Editable")
        expect(self.page.locator("#report-editor-why")).to_have_text("")

    def test_c_r01_008_the_reading_shortcut_summary_names_approve_and_the_account_viewer_letter_keys(self):
        """C-R01-008#1: Keyboard Shortcuts in the Reading Workspace lists Approve (Ctrl+S) with the worklist keys, and the
        Viewer window letter keys as the account saved them (here Length moved to Q); the rest are the viewer defaults."""
        account = self.site.account
        self.site.gets["/api/workspace-shortcuts"] = (200, {
            "owner": [h.INSTITUTION, account["sub"]], "revision": 1, "bindings": None, "invalid": False,
            "viewerSettings": {"version": 2, "bar": [], "shortcuts": {
                "WindowLevel": "w", "Length": "q", "RectangleROI": "r", "invert": "i", "flipHorizontal": "shift+h", "Zoom": None}}})
        self.open()
        self.open_study(h.PATIENT)
        self.enter_reading_with_a_bound_viewer()
        self.page.locator("#reading-shortcut-help > summary").click()
        hints = self.page.locator("#reading-shortcuts")
        expect(hints).to_contain_text("Approve Control+S")
        expect(hints).to_contain_text("Next Study Control+Alt+ArrowRight")
        keys = self.page.locator("#reading-viewer-keys")
        expect(keys).to_contain_text("Q Length")
        for text in ("W Window / Level", "R Rectangle ROI", "I Invert", "Shift+H Flip Horizontal"):
            expect(keys).to_contain_text(text)
        self.assertNotIn("Zoom", keys.inner_text(), "a key the account cleared is not listed")
        self.assertNotIn("L Length", keys.inner_text())

    def test_c_r01_008_without_saved_viewer_keys_the_summary_lists_the_viewer_defaults(self):
        self.site.gets["/api/workspace-shortcuts"] = (200, {
            "owner": [h.INSTITUTION, self.site.account["sub"]], "revision": 0, "bindings": None, "viewerSettings": None})
        self.open()
        self.open_study(h.PATIENT)
        self.enter_reading_with_a_bound_viewer()
        self.page.locator("#reading-shortcut-help > summary").click()
        keys = self.page.locator("#reading-viewer-keys")
        for text in ("L Length", "R Rectangle ROI", "I Invert", "Z Zoom", "Shift+R Rotate Right"):
            expect(keys).to_contain_text(text)

    # ── Unit 5b (C-R01-108#20, C-R01-109#3) ──
    def test_c_r01_108_recover_draft_after_signing_in_again_reads_my_server_draft_and_says_what_it_is(self):
        """C-R01-108#20: a page opened after signing in again shows my saved draft with Recover Draft beside it; pressing it
        reads the server draft again, puts exactly that draft in the editor and says whose draft, which study, when saved and
        the reading state on the server. Text typed here and not yet confirmed hides it (nothing is covered)."""
        st = self.site.store[h.UID]
        st["row"] = {"findings": "SYN saved findings", "conclusion": "", "recommendation": "", "baseVersion": 0,
                     "citations": [], "structured": []}
        st["revs"] = 1
        self.open()
        self.open_study(h.PATIENT)
        expect(self.page.locator("#findings")).to_have_value("SYN saved findings")
        recover = self.page.locator("#b-draft-recover")
        expect(recover).to_be_visible()
        expect(recover).to_have_text("Recover Draft")
        reads = len(self.site.flow_draft_reads)
        # The server draft moved on (written from another window before signing out): Recover Draft reads the server.
        st["row"] = {**st["row"], "findings": "SYN findings saved in the other window"}
        st["revs"] += 1
        recover.click()
        self.wait(lambda: len(self.site.flow_draft_reads) > reads, "the full draft read")
        expect(self.page.locator("#findings")).to_have_value("SYN findings saved in the other window")
        toast = self.page.locator("#toast")
        expect(toast).to_contain_text("Recover Draft — 내 초안을 편집기에 놓았습니다")
        expect(toast).to_contain_text(h.PATIENT)
        expect(toast).to_contain_text("목록이 마지막으로 받은 판독 상태: Unread (v0)")
        self.assertEqual([], self.site.flow_puts, "recovering writes nothing")
        self.type("SYN typed here, not yet saved")
        expect(recover).to_be_hidden()

    def test_c_r01_108_recover_draft_goes_when_typing_again_after_a_confirmed_autosave_while_holding(self):
        """Astra m54-unit05b-review-2: after an autosave is confirmed (the button is back) and the study is held, the next
        keystroke hides Recover Draft at once, on the fields the editor put in place for this study."""
        self.open()
        self.open_study(h.PATIENT)
        recover = self.page.locator("#b-draft-recover")
        self.type("SYN first saved text")
        self.wait(lambda: self.site.holds, "the hold taken by typing")
        self.page.clock.run_for(20001)
        self.wait(lambda: self.stored(h.UID) is not None, "the autosave")
        self.wait(lambda: not self.page.evaluate("reportConverge.has(selectedUid)"), "the confirmed autosave")
        expect(recover).to_be_visible()
        self.page.locator("#findings").press("End")
        self.page.keyboard.type(" more")
        expect(recover).to_be_hidden()

    def test_c_r01_108_a_recover_answer_after_leaving_and_reopening_the_study_is_not_applied(self):
        """Astra m54-unit05b-review-1 BLOCKER: the read answers after A -> B -> A; it belongs to the earlier opening and does
        not replace the reopened editor."""
        st = self.site.store[h.UID]
        st["row"] = {"findings": "SYN saved findings", "conclusion": "", "recommendation": "", "baseVersion": 0,
                     "citations": [], "structured": []}
        st["revs"] = 1
        self.open()
        self.open_study(h.PATIENT)
        expect(self.page.locator("#b-draft-recover")).to_be_visible()
        self.settle(300)
        held = len(self.site.held_draft_reads)
        self.site.draft_read_answers.append("hold")
        self.page.locator("#b-draft-recover").click()
        self.wait(lambda: len(self.site.held_draft_reads) > held, "the held draft read")
        st["row"] = {**st["row"], "findings": "SYN late answer"}
        st["revs"] += 1
        self.open_study(h.PATIENT_B)
        self.pick(h.PATIENT)
        self.wait(lambda: self.selected() == h.PATIENT, "A reopened")
        shown = self.page.locator("#findings").input_value()
        self.site.finish_draft_read(held)
        self.settle(400)
        self.assertEqual(shown, self.page.locator("#findings").input_value(), "the late answer is not applied")
        self.assertNotIn("Recover Draft — 내 초안", self.page.locator("#toast").inner_text())

    def test_c_r01_109_the_editor_presence_follows_the_presence_read(self):
        """Astra m54-unit05b-review-1: a reader arriving in the presence read shows beside the editor too, and goes when it clears."""
        self.open()
        self.open_study(h.PATIENT)
        presence = self.page.locator("#report-editor-presence")
        expect(presence).to_have_text("Opened by you")
        self.page.evaluate("uid => { viewingNames.set(uid, 'Viewing: SYN OTHER READER'); paintViewing(); }", h.UID)
        expect(presence).to_have_text("Opened by you · Viewing: SYN OTHER READER")
        self.page.evaluate("() => clearViewing()")
        expect(presence).to_have_text("Opened by you")

    def test_c_r01_109_opening_says_opened_by_you_and_only_the_first_typing_holds(self):
        """C-R01-109#3: opening a study does not hold it (the hold still starts with writing); the editor says it is opened
        by this reader, and after the first typed characters the hold is taken and the editor says Held by you."""
        self.open()
        self.open_study(h.PATIENT)
        presence = self.page.locator("#report-editor-presence")
        expect(presence).to_contain_text("Opened by you")
        self.settle(300)
        self.assertEqual([], self.site.holds, "opening the study does not hold it")
        self.type("SY")
        self.wait(lambda: self.site.holds, "the hold taken by typing")
        expect(presence).to_have_text("✎ Held by you")

    # ── W5 interface: the common command block and the read-only draft snapshot (W4F-05) ──
    def test_without_a_command_block_reason_each_report_command_keeps_its_one_click_path(self):
        """W5_COMMAND_BLOCK (W4F-05): with no reason at the common block the paths are the ones before - Approve is one
        click, one commit; Next with nothing unconfirmed switches in the same event. The reason itself (the Related Report
        mode) is the complete page's case (related_report_mode_dom_test.py, W5 Phase B: no stand-in here)."""
        self.open()
        self.open_study(h.PATIENT_B)
        self.type("SYN B blocked")
        self.assertIsNone(self.page.evaluate("['approve', 'finalize', 'finalize-next', 'next', 'prev'].map(reportCommandBlocked)"
                                             ".find(reason => reason !== null) ?? null"))
        self.page.locator("#b-approve").click()
        self.wait(lambda: self.site.flow_commits, "the approval")
        self.assertEqual(["approve"], [body["action"] for _, body in self.site.flow_commits])
        self.wait(lambda: self.site.store[h.UID_B]["report"]["rs"] == "A", "B approved")
        self.settle()
        moved = self.page.evaluate("() => { document.querySelector('#b-next').click(); return selectedUid; }")
        self.assertEqual(UID_C, moved)

    def test_draft_snapshot_is_a_read_only_copy_of_the_document_draft(self):
        """W4F-05 / impact section 10 item 4: {uid, author, selectionSeq, revision, baseVersion, texts} (+ lists and
        unconfirmed) read in one go; copies only; reading it sends nothing and changes nothing."""
        self.open()
        self.open_study(h.PATIENT)
        self.wait(lambda: self.page.evaluate("draftClient.lists(selectedUid) !== null"), "the editor's draft baseline")
        snap = self.page.evaluate("reportDraftSnapshot()")
        seq = self.page.evaluate("selectionSeq")
        self.assertEqual({"uid": h.UID, "author": h.owner_of(h.RAD), "selectionSeq": seq,
                          "revision": self.site.revision_of(h.UID), "baseVersion": 0, "texts": None,
                          "lists": {"citations": [], "structured": []}, "unconfirmed": False}, snap)
        self.type("SYN A snapshot")
        self.wait(lambda: self.site.holds, "the hold the typing takes")
        self.settle(300)
        calls = list(self.site.calls)
        changed = self.page.evaluate("""() => { const s = reportDraftSnapshot();
          s.texts.findings = 'SYN changed by the caller'; s.lists.citations.push('SYN-CID'); s.author.sub = 'SYN-OTHER';
          return [s, reportDraftSnapshot(), $('#findings').value, draftClient.lists(selectedUid)]; }""")
        self.settle(300)
        # The received critical-result list reads its first page in the background on its own path once the page allows
        # it (a read that changes nothing); on a loaded host it lands inside this window (pre-fix 5/12 under load). It is
        # left out of both sides; every other request - any write, draft or report read - still counts.
        self.assertEqual([c for c in calls if c != CRITICAL_RESULT_LIST],
                         [c for c in self.site.calls if c != CRITICAL_RESULT_LIST], "reading the snapshot sends nothing")
        self.assertEqual({"findings": "SYN A snapshot", "conclusion": "", "recommendation": ""}, changed[1]["texts"])
        self.assertEqual((True, [], h.owner_of(h.RAD)["sub"]),
                         (changed[1]["unconfirmed"], changed[1]["lists"]["citations"], changed[1]["author"]["sub"]))
        self.assertEqual(("SYN A snapshot", {"citations": [], "structured": []}), (changed[2], changed[3]))
        # A study left behind: its kept copy, no selection sequence, the revision its confirmed write moved to.
        self.pick(h.PATIENT_B)
        self.wait(lambda: self.selected() == h.PATIENT_B, "B after A's write")
        left = self.page.evaluate("uid => reportDraftSnapshot(uid)", h.UID)
        self.assertEqual((None, {"findings": "SYN A snapshot", "conclusion": "", "recommendation": ""}, False,
                          self.site.revision_of(h.UID)),
                         (left["selectionSeq"], left["texts"], left["unconfirmed"], left["revision"]))

    def test_study_info_and_templates_keys_on_the_v2_map(self):
        """The dispatcher reads the v2 map (D1371): Ctrl+Alt+5 still opens Study Info & Templates and Ctrl+Alt+T its
        Templates tab, as with the v1 map."""
        self.open()
        self.open_study(h.PATIENT)
        drawer = self.page.get_by_role("complementary", name="Study Panel", exact=True)
        self.page.keyboard.press("Control+Alt+5")
        expect(drawer).to_be_visible()
        self.page.keyboard.press("Escape")
        expect(drawer).to_have_count(0)
        self.page.keyboard.press("Control+Alt+t")
        expect(drawer.get_by_role("tab", name="Templates", exact=True)).to_have_attribute("aria-selected", "true")

    # ── An Addendum only adds to the approved report; a Save over another window of this same account ──

    APPROVED_LINE = "SYN approved line."
    APPEND_ONLY = "추가기재는 승인본에 덧붙이기만 합니다"

    def approved_b(self, **facts):
        self.site.store[h.UID_B]["report"] = {"version": 1, "rs": "A", "findings": self.APPROVED_LINE, "conclusion": "",
                                              "recommendation": "", **facts}

    def caret(self, at):
        self.page.evaluate("at => { const el = document.querySelector('#findings'); el.focus(); "
                           "const n = at < 0 ? el.value.length : at; el.setSelectionRange(n, n); }", at)

    def test_an_addendum_pressed_with_nothing_added_is_not_sent_and_says_so(self):
        """An approved report and Addendum pressed with its text as it is (the first time or again): no new approved
        version is asked for - the page says nothing was added and sends nothing."""
        self.approved_b()
        self.open()
        self.open_study(h.PATIENT_B)
        self.settle(500)
        for press in (1, 2):
            with self.subTest(press=press):
                commits = len(self.site.flow_commits)
                self.page.evaluate("() => commitReport('addendum')")
                expect(self.page.locator("#toast")).to_contain_text("덧붙인 내용이 없습니다")
                self.settle(300)
                self.assertEqual(commits, len(self.site.flow_commits), "nothing was sent")
        self.assertEqual((1, "A"), (self.site.store[h.UID_B]["report"]["version"], self.site.store[h.UID_B]["report"]["rs"]))

    def test_an_approved_report_that_takes_only_an_addendum_keeps_its_approved_text(self):
        """Its 24-hour amendment is not open to this reader, so the editor keeps the approved text: typing, deleting a
        selection or backspacing into it is put back (and said once), a command cannot write inside it, and writing after
        it - or taking back what was written after it - works."""
        self.approved_b()
        self.open()
        self.open_study(h.PATIENT_B)
        field = self.page.locator("#findings")
        self.caret(4)
        self.page.keyboard.type("X")
        expect(field).to_have_value(self.APPROVED_LINE)
        expect(self.page.locator("#toast")).to_contain_text(self.APPEND_ONLY)
        self.page.evaluate("() => document.querySelector('#findings').select()")
        self.page.keyboard.press("Backspace")
        expect(field).to_have_value(self.APPROVED_LINE)
        self.caret(-1)
        self.page.keyboard.press("Backspace")
        expect(field).to_have_value(self.APPROVED_LINE)
        self.page.keyboard.type(" Added.")
        expect(field).to_have_value(self.APPROVED_LINE + " Added.")
        self.assertFalse(self.page.evaluate("() => editReport([{ field: 'findings', start: 0, end: 0, text: 'Z ' }])"),
                         "a command does not write inside the approved text")
        expect(field).to_have_value(self.APPROVED_LINE + " Added.")
        self.assertTrue(self.page.evaluate("() => editReport([{ field: 'findings', start: document.querySelector('#findings').value.length, "
                                           "end: document.querySelector('#findings').value.length, text: ' More.' }])"))
        expect(field).to_have_value(self.APPROVED_LINE + " Added. More.")
        self.caret(-1)
        for _ in " More.":
            self.page.keyboard.press("Backspace")
        expect(field).to_have_value(self.APPROVED_LINE + " Added.")

    def test_the_approver_within_the_24_hours_may_change_the_middle(self):
        """The approver's own 24-hour amendment is a separate way and stays as it is: the editor does not hold the text."""
        self.approved_b(amendUntil="2099-01-01T00:00:00.000Z", amendMine=True)
        self.open()
        self.open_study(h.PATIENT_B)
        self.caret(4)
        self.page.keyboard.type("X")
        expect(self.page.locator("#findings")).to_have_value("SYN Xapproved line.")

    def test_a_signing_key_refusal_of_an_addendum_or_a_reset_names_that_action(self):
        """Without a usable signing key the refusal names the action that was refused, not an approval."""
        self.approved_b()
        self.open()
        self.open_study(h.PATIENT_B)
        self.caret(-1)
        self.page.keyboard.type(" More.")
        for action, words in (("addendum", "추가기재(Addendum)를 저장하지 못했습니다"), ("reset", "판독 취소(Reset)를 하지 못했습니다")):
            with self.subTest(action=action):
                commits = len(self.site.flow_commits)
                self.site.commit_answers = [(503, {"code": "DoctorSigningKeyUnavailable", "message": "SYN signing key refusal."})]
                self.page.evaluate("action => commitReport(action, 'SYN reason')", action)
                self.wait(lambda: len(self.site.flow_commits) > commits, "the refused " + action)
                expect(self.page.locator("#toast")).to_contain_text(words)
                expect(self.page.locator("#toast")).not_to_contain_text("승인하지 못했습니다")
        expect(self.page.locator("#findings")).to_have_value(self.APPROVED_LINE + " More.")
        self.assertEqual((1, "A"), (self.site.store[h.UID_B]["report"]["version"], self.site.store[h.UID_B]["report"]["rs"]))

    def test_a_save_after_another_window_of_this_account_saved_asks_once_and_saves_this_windows_text(self):
        """Two windows of the same reader: the other window saved v1 while this one still stands on v0. The server's
        refusal names the head as this account's own; the page asks once whether to save this window's text after v1, and
        yes sends the same Save on v1 - this window's text is v2, v1 stays in the history. Nothing is merged or lost."""
        self.open()
        self.open_study(h.PATIENT_B)
        self.type("SYN window two")
        self.settle(300)
        self.site.store[h.UID_B]["report"] = {"version": 1, "rs": "T", "findings": "SYN window one", "conclusion": "", "recommendation": ""}
        mine = "다른 창에서 이 계정으로 v1을 저장했습니다. 이 창의 글은 그대로 있습니다."
        self.site.commit_answers = [(409, {"code": "REPORT_VERSION_CONFLICT", "message": mine, "head": {"version": 1, "mine": True}})]
        self.page.locator("#b-save").click()
        self.wait(lambda: len(self.site.flow_commits) == 2, "the Save sent again on v1")
        first, second = (body for _, body in self.site.flow_commits)
        self.assertEqual((0, 1), (first["baseVersion"], second["baseVersion"]))
        self.assertEqual(("save", "save", "SYN window two", "SYN window two"),
                         (first["action"], second["action"], first["findings"], second["findings"]))
        self.assertEqual(1, len(self.dialogs))
        self.assertIn("다른 창에서 이 계정으로 v1을 저장했습니다", self.dialogs[0])
        self.wait(lambda: self.site.store[h.UID_B]["report"]["version"] == 2, "v2 is this window's text")
        self.assertEqual(("T", "SYN window two"), (self.site.store[h.UID_B]["report"]["rs"], self.site.store[h.UID_B]["report"]["findings"]))
        expect(self.page.locator("#findings")).to_have_value("SYN window two")

    def test_a_save_without_a_draft_after_another_window_saved_is_sent_again_on_the_confirmed_version(self):
        """The same two windows, but this one holds no draft and no typing (its editor still shows what it read): the Save
        sent again after yes stands on the version the question named - not on the one this window last read - and is asked
        once."""
        self.open()
        self.open_study(h.PATIENT_B)
        self.settle(300)
        self.site.store[h.UID_B]["report"] = {"version": 2, "rs": "T", "findings": "SYN window one", "conclusion": "", "recommendation": ""}
        mine = "다른 창에서 이 계정으로 v2을 저장했습니다. 이 창의 글은 그대로 있습니다."
        self.site.commit_answers = [(409, {"code": "REPORT_VERSION_CONFLICT", "message": mine, "head": {"version": 2, "mine": True}})]
        self.page.evaluate("() => commitReport('save')")
        self.wait(lambda: len(self.site.flow_commits) == 2, "the Save sent again on v2")
        self.assertEqual([0, 2], [body["baseVersion"] for _, body in self.site.flow_commits])
        self.assertEqual(1, len(self.dialogs))

    def approve_after_another_window_saved(self, english):
        """Approve under the same refusal (a head this account saved) takes the reload question; returns the question.
        The fixture answers yes, which copies the text to the clipboard: the page may write it."""
        self.page.context.grant_permissions(["clipboard-read", "clipboard-write"])
        self.open()
        self.open_study(h.PATIENT_B)
        if english:
            self.page.evaluate("KinLanguage.restore({version:1,worklist:'en',reading:'en'})")
        self.type("SYN window two")
        self.settle(300)
        self.site.store[h.UID_B]["report"] = {"version": 1, "rs": "T", "findings": "SYN window one", "conclusion": "", "recommendation": ""}
        mine = "다른 창에서 이 계정으로 v1을 저장했습니다. 이 창의 글은 그대로 있습니다."
        self.site.commit_answers = [(409, {"code": "REPORT_VERSION_CONFLICT", "message": mine, "head": {"version": 1, "mine": True}})]
        self.page.evaluate("() => commitReport('approve')")
        self.wait(lambda: len(self.dialogs) == 1, "the reload question")
        self.assertEqual(1, len(self.site.flow_commits))
        return mine, self.dialogs[0]

    def test_approve_after_another_window_saved_asks_in_the_servers_words_without_a_screen_language(self):
        mine, question = self.approve_after_another_window_saved(english=False)
        self.assertEqual(mine + "\n\n서버의 최신 판독문을 불러올까요?\n(지금 쓰던 내용은 클립보드로 복사됩니다)", question)

    def test_approve_after_another_window_saved_asks_in_english_on_an_english_screen(self):
        """The refusal's sentence carries the version, so the screen says it from the version the refusal names (the
        glossary's sentence) - the server's Korean copy would stay as received on an English screen."""
        _, question = self.approve_after_another_window_saved(english=True)
        self.assertEqual("v1 was saved from another window of this account. The text in this window is unchanged. "
                         "Load the latest report from the server? (What you were writing will be copied to the clipboard)", question)
        self.assertEqual([], re.findall(r"[가-힣]", question))


# Each mutant is a one-off copy of one bundle source (or main.html) served to the page; the product tree is never written.
MUTANTS = [
    # W4F-01: Check is a read; resending through the move (Retry's write path) is the defect the review found.
    ("check-re-sends", "report-editor.js", '$("#report-notice-check").addEventListener("click", checkReportNotice);',
     '$("#report-notice-check").addEventListener("click", retryReportNotice);',
     "test_check_reads_and_stays_without_writing_when_the_server_lacks_the_text"),
    ("check-compares-text-only", "report-editor.js",
     "KinReportDraftClient.sameSnapshot(read.present ? read.snapshot : null, expected);",
     "RFIELDS.every(k => (read.snapshot?.[k] ?? \"\") === (expected?.[k] ?? \"\"));",
     "test_check_compares_the_whole_snapshot_not_only_the_text"),
    ("gate-bypass-on-unknown", "current-study.js", 'if (result.status !== "saved") {',
     'if (result.status !== "saved" && result.status !== "unknown") {',
     "test_save_outcome_unknown_stays_and_check_confirms_from_the_server_then_moves"),
    ("gate-bypass-on-refused", "current-study.js",
     'const why = leaveSaveBlock(uid);\n        if (why) return { status: why.status, reason: why.reason };\n'
     '        const written = await leaveWithin(stashReport(), left);',
     'const why = leaveSaveBlock(uid);\n        if (why) return { status: why.status, reason: why.reason };\n'
     '        const written = await leaveWithin(stashReport(), left); if (written === "refused") return { status: "saved" };',
     "test_save_outcome_refused_stays_with_notice_and_retry_moves_after_the_cause_is_gone"),
    ("doctor-path-waits", "current-study.js", 'if (!uid || !reportConverge.has(uid)) return { status: "clear", uid, selectionSeq: seq };',
     'if (!uid || !reportConverge.has(uid)) return Promise.resolve({ status: "saved", uid, selectionSeq: seq });',
     "test_doctor_path_without_unconfirmed_text_switches_synchronously"),
    ("composition-silent", "current-study.js", 'showReportNotice({ status: "composing", uid, seq, reason });', '',
     "test_composition_open_row_click_and_next_stay_and_say_so"),
    ("composition-during-wait-moves", "current-study.js",
     'if (reportFrame?.isComposing()) {\n          showReportNotice({ status: "composing", uid: leave.from.uid',
     'if (false) {\n          showReportNotice({ status: "composing", uid: leave.from.uid',
     "test_composition_started_while_the_save_is_out_keeps_the_study"),
    # Next after a plain Approve that took the study out of the filter: without the last-seen order it starts at the top.
    ("anchor-from-current-list", "report-toolbar.js", "if (index === -1 && uid && queueSeen?.uid === uid) {",
     "if (false) {", "test_plain_approve_stays_and_next_continues_from_the_anchor"),
    ("approve-next-first-row", "report-commit.js", "const next = queueTarget(anchor);",
     "const next = orderedStudies()[0]?.uid;",
     "test_approve_and_next_under_a_w_filter_goes_to_the_following_row_not_the_first"),
    # W4F-02: the destination comes from the press-time anchor, re-checked after the wait - not from the list at the answer.
    ("anchor-from-the-answer-time-list", "report-commit.js", "const next = queueTarget(anchor);",
     "const next = queueTarget(queueAnchor(1));",
     "test_approve_and_next_keeps_the_press_time_successor_when_the_list_is_sorted_during_the_answer"),
    ("no-revalidation-after-the-wait", "current-study.js", "const to = moveDestination(target);", "const to = target.uid;",
     "test_next_revalidates_its_target_after_the_save_wait"),
    # The acceptance rule as a whole: accepted, nothing typed after the press, the same selection, the approval on screen.
    ("move-on-any-answer", "report-commit.js",
     "if (!done?.accepted || done.lateText || done.uid !== selectedUid || done.seq !== selectionSeq || !reportShowsAccepted(done.uid)) return;",
     "if (false) return;", "test_approve_and_next_unknown_or_refused_never_moves"),
    ("late-answer-moves", "report-commit.js", "if (studyRequests !== asked) return;", "",
     "test_late_commit_answer_cannot_move_after_the_reader_chose_another_study"),
    ("notice-hidden-for-recommendation", "report-editor.js", "box.hidden = !value;", "box.hidden = true;",
     "test_recommendation_from_a_template_is_announced_read_only_saved_and_shown_again"),
    ("menu-acts-on-old-selection", "context-menu.js", "whenSelected(select(uid), uid, () => showRowMenu(e, uid, keyboard()));",
     "select(uid); showRowMenu(e, uid, keyboard());", "test_menu_during_composition_does_not_open_for_another_row"),
    ("menu-waits-not", "context-menu.js", "whenSelected(select(uid), uid, () => showRowMenu(e, uid, keyboard()));",
     "select(uid); showRowMenu(e, uid, keyboard());", "test_menu_on_a_non_selected_row_opens_after_the_move_and_acts_on_that_row"),
    # A row/order menu item runs only on the selection the menu was opened on (W4F-03).
    ("menu-item-unbound", "context-menu.js",
     "if (target && (target.uid !== selectedUid || target.seq !== selectionSeq || target.oid !== selectedOid)) {",
     "if (false) {", "test_menu_item_bound_to_its_row_does_nothing_after_the_selection_moved"),
    ("item-uses-cur", "context-menu.js",
     "if (target && (target.uid !== selectedUid || target.seq !== selectionSeq || target.oid !== selectedOid)) {",
     "if (target && target.oid !== selectedOid) {",
     "test_technician_unmatch_and_modify_send_nothing_once_the_keyboard_selected_another_study"),
    ("match-uses-cur", "context-menu.js",
     "if (target && (target.uid !== selectedUid || target.seq !== selectionSeq || target.oid !== selectedOid)) {",
     "if (target && target.oid !== selectedOid) {",
     "test_technician_match_sends_nothing_once_the_keyboard_selected_another_study"),
    ("ctrl-s-prevents-when-not-run", "page-boot.js",
     "if (KinReportCommands.finalize() === true) { event.preventDefault(); event.stopImmediatePropagation(); }",
     "KinReportCommands.finalize(); event.preventDefault(); event.stopImmediatePropagation();",
     "test_ctrl_s_runs_finalize_and_prevents_save_page_only_when_it_runs"),
    # D1371: the dispatcher reads the v2 map; the v1 view has no Finalize key.
    ("dispatcher-reads-v1-map", "page-boot.js", "(KinWorkspaceShortcuts.readV2 ?? KinWorkspaceShortcuts.read)(workspaceStorage, owner)",
     "KinWorkspaceShortcuts.read(workspaceStorage, owner)", "test_ctrl_s_runs_finalize_and_prevents_save_page_only_when_it_runs"),
    ("templates-chord-merged-into-v2-map", "page-boot.js", "KinWorkspaceShortcuts.action({ context: 'KeyT' }, event)",
     "KinWorkspaceShortcuts.action({ ...bindings, context: 'KeyT' }, event)", "test_study_info_and_templates_keys_on_the_v2_map"),
    ("finalize-hook-always-true", "page-boot.js", "finalize: () => finalizeCommand()", "finalize: () => (finalizeCommand(), true)",
     "test_report_commands_finalize_answers_true_only_when_the_command_ran"),
    # W4F-05's two stand-in mutants (Approve / Next-Prev bypassing the common block) moved with the W5 reason to the
    # complete page in W5 Phase B: related_report_mode_mutants.py M9-shared-command-admission-removed / commit-in-the-mode.
    ("finalize-hook-ran-during-insertion", "report-commit.js",
     'if (mode !== "Radiology" || commitInFlight || insertInFlight || reportCommandBlocked("finalize")) return false;',
     'if (mode !== "Radiology" || reportCommandBlocked("finalize")) return false;',
     "test_report_commands_finalize_answers_true_only_when_the_command_ran"),
]
# A shipped script outside the bundle (main.html loads it with its own script tag) cannot be changed through the bundle or
# main.html, so its one-off copy is served at its own URL (ReportFlowPage.asset_source); counted with MUTANTS.
ASSET_MUTANTS = [
    # D1371: keyboard events do not leave an iframe, so the bound viewer frame forwards its Finalize key to the page's report
    # commands; without that, Ctrl+S in the frame does nothing.
    ("frame-does-not-forward-finalize", "reading-workspace.js",
     "if(doc!==document&&window.KinReportCommands?.finalize?.()===true)e.preventDefault();", "",
     "test_ctrl_s_in_the_bound_viewer_frame_runs_the_real_finalize_once"),
]


def run_mutants():
    case = ReportFlowPage
    names = sorted({row[-1] for row in MUTANTS + ASSET_MUTANTS})
    baseline = unittest.TextTestRunner(verbosity=2).run(unittest.TestSuite(case(n) for n in names))
    if not baseline.wasSuccessful() or baseline.skipped:
        print("W4 FLOW BASELINE FAILED; no kills claimed")
        return 1
    order = json.loads((ROOT / "scripts/main-split-order.json").read_text(encoding="utf-8"))["sources"]
    originals = {row["file"]: (LITE / row["file"]).read_text(encoding="utf-8") for row in order}
    killed = 0
    for label, file, old, new, name in MUTANTS:
        source = originals[file] if file in originals else (LITE / file).read_text(encoding="utf-8")
        if source.count(old) != 1:
            raise AssertionError("mutation location not unique: " + label)
        changed = source.replace(old, new, 1)
        case.bundle_source = "".join(changed if row["file"] == file else originals[row["file"]] for row in order)
        case.html_source = changed if file == "main.html" else None
        output = io.StringIO()
        result = unittest.TextTestRunner(stream=output, verbosity=2).run(unittest.TestSuite([case(name)]))
        caught = result.testsRun == 1 and bool(result.failures) and not result.errors and not result.skipped
        print(label, file, "KILLED" if caught else "NOT PROVEN", flush=True)
        print(output.getvalue(), end="")
        killed += int(caught)
    case.bundle_source = None
    case.html_source = None
    for label, file, old, new, name in ASSET_MUTANTS:
        source = (LITE / file).read_text(encoding="utf-8")
        if source.count(old) != 1:
            raise AssertionError("mutation location not unique: " + label)
        case.asset_source = (file, source.replace(old, new, 1))
        output = io.StringIO()
        result = unittest.TextTestRunner(stream=output, verbosity=2).run(unittest.TestSuite([case(name)]))
        caught = result.testsRun == 1 and bool(result.failures) and not result.errors and not result.skipped
        print(label, file, "KILLED" if caught else "NOT PROVEN", flush=True)
        print(output.getvalue(), end="")
        killed += int(caught)
    case.asset_source = None
    total = len(MUTANTS) + len(ASSET_MUTANTS)
    print("W4 FLOW mutants killed: %s/%s (bundle sources and main.html %s, served assets %s)" % (
        killed, total, len(MUTANTS), len(ASSET_MUTANTS)))
    return 0 if killed == total else 1


def main():
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    args = sys.argv[1:]
    if args == ["--mutants"]:
        return run_mutants()
    names = args or unittest.defaultTestLoader.getTestCaseNames(ReportFlowPage)
    result = unittest.TextTestRunner(verbosity=2).run(unittest.TestSuite(ReportFlowPage(n) for n in names))
    return 0 if result.wasSuccessful() and not result.skipped else 1


if __name__ == "__main__":
    raise SystemExit(main())
