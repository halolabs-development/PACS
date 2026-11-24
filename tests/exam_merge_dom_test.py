# coding: utf-8
"""Merge Exam · Split / Unmerge on the delivered split page (exam-merge.js and the list's merged-exam row).

The delivered page (main.html, its bundle and every shipped asset) against the synthetic origin of report_flow_dom_test;
no stack, no product file is modified. MergeSite adds the exam-group routes and answers the list as the server does: a
merged exam is its base row with server examScope and sourceMetadata, and the other source rows are hidden.

  - the two buttons sit right after Unverify in the Technician button row;
  - Merge Exam: the selected study is Base, the same patient's same-day study is ticked, another patient's is not; ticking
    it refuses on the spot (orange line, Merge off) and unticking brings the result line back; the Base can be changed; Merge
    sends the ticked studies and the Base, the list is read again and the base row shows `Merged ×N · M img`;
  - a server refusal is shown in the window, which stays open;
  - Split / Unmerge: the original studies with their own Series / Images, the server's checks (✓ / ✗, Unmerge off while one
    fails), Unmerge sends the group's id and the list shows the studies again; an original exam can split whole series;
  - filters find either original, scope changes invalidate old dialogs, and original export requires an explicit choice.
"""
import json
import re
import time
import unittest
from urllib.parse import urlparse, parse_qs

import auth_logout_dom_test as h
import report_flow_dom_test as rf
from page_source import settle
from playwright.sync_api import expect, sync_playwright

TECH = {**h.RAD, "sub": "SYN-TECH-SUB", "actor": "syn-tech@synthetic.test", "user": "syn-tech@synthetic.test",
        "displayName": "SYN Technician", "roles": ["technician"]}
ACC = {h.UID: "SYNACC-A1", h.UID_B: "SYNACC-A2", rf.UID_C: "SYNACC-C1"}
COUNT = {h.UID: 8, h.UID_B: 12, rf.UID_C: 5}
GROUP_ID = "00000000-0000-4000-8000-00000000b001"
SPLIT_UID = "1.2.826.0.1.3680043.10.777.200"
SERIES = [h.UID + ".101", h.UID + ".102"]


class MergeSite(rf.FlowSite):
    def __init__(self):
        super().__init__(3)
        # Two studies of one patient on one day, and another patient's.
        self.flow = ((h.UID, h.PATIENT, "SYN-P-001"), (h.UID_B, h.PATIENT, "SYN-P-001"), (rf.UID_C, rf.PATIENT_C, "SYN-P-003"))
        self.groups = {}                # base uid -> [uids, base first]
        self.split = None
        self.generation = 0
        self.held_scope = None
        self.dissolve_refusal = None
        self.sent = []                  # (method, path, body)
        self.merge_refusal = None       # (status, body) of the next merge
        self.checks = [{"rule": "approved", "ok": True, "message": "합친 검사에 지금 승인된 판독문이 없습니다.", "uids": []},
                       {"rule": "transfer", "ok": True, "message": "이 검사들의 전송·내보내기가 진행 중이지 않습니다.", "uids": []},
                       {"rule": "held", "ok": True, "message": "합친 검사의 판독문을 쓰는 사람이 없습니다.", "uids": []}]
        self.report_groups = {}         # uid -> reportGroup of the row (a report written on a merged exam)
        self.desc = {}                  # uid -> StudyDesc of the row and of its original in a merged exam
        self.series_names = ["SYN Series 1", "SYN Series 2"]
        self.related_reports = {}       # uid -> relatedExamReports of the row
        self.acc = dict(ACC)            # uid -> Accession No of the row and of its original in a merged exam
        self.lost = {}                  # uid -> kind of the exam in force whose originals the reader cannot all read now
        self.lost_members = {}          # uid -> the originals of that exam the reader can read, as the server's group read gives them
        self.lost_hidden = {}           # uid -> how many originals of that exam the server only counts (it names none of them)
        self.gone = set()               # originals the server's group read counts but no longer names
        self.group_read_failure = None  # (status, body) the group read answers instead, when set

    def scope(self, uid):
        if self.split and uid in (self.split["uid"], SPLIT_UID):
            part = int(uid == SPLIT_UID)
            return {"reportUid": uid, "groupId": GROUP_ID, "kind": "split", "active": True, "part": part,
                    "generation": str(self.generation), "sources": [{"studyUid": self.split["uid"],
                    "series": {"mode": "include" if part else "exclude", "uids": self.split["seriesUids"]}}]}
        return {"reportUid": uid, "groupId": GROUP_ID if uid in self.groups else None,
                "kind": "merge" if uid in self.groups else "single", "part": None, "active": True,
                "generation": str(self.generation), "sources": [{"studyUid": source, "series": {"mode": "all", "uids": []}}
                                                               for source in self.groups.get(uid, [uid])]}

    def handle(self, route, request):
        path = urlparse(request.url).path
        if path == f"/dicom-web/studies/{h.UID}/series":
            return route.fulfill(json=[{"0020000D": {"Value": [h.UID]}, "0020000E": {"Value": [uid]},
                                       "00200011": {"Value": [i + 1]}, "0008103E": {"Value": [self.series_names[i]]},
                                       "00080060": {"Value": ["CT"]}, "00201209": {"Value": [4]}}
                                      for i, uid in enumerate(SERIES)])
        if path == f"/dicom-web/studies/{rf.UID_C}/series":
            return route.fulfill(json=[])
        return super().handle(route, request)

    def list_body(self, account, rename=None):
        body = super().list_body(account, rename)
        rows = {row["uid"]: row for row in body["studies"]}
        for uid, row in rows.items():
            row.update(acc=self.acc[uid], count=COUNT[uid], series=1)
            if uid in self.desc:
                row["desc"] = self.desc[uid]
            if uid in self.related_reports:
                row["relatedExamReports"] = self.related_reports[uid]
        hidden = {uid for members in self.groups.values() for uid in members[1:]}
        for base, members in self.groups.items():
            row = rows[base]
            row["group"] = {"id": GROUP_ID, "kind": "merge", "baseUid": base, "members": [
                {"uid": uid, "acc": self.acc[uid], "date": "20261003", "time": "", "desc": self.desc.get(uid, "SYN CT CHEST"), "modality": "CT",
                 "count": COUNT[uid], "series": 1} for uid in members]}
            row["count"] = sum(COUNT[uid] for uid in members)
            row["series"] = len(members)
            row["examScope"] = self.scope(base)
            row["sourceMetadata"] = row["group"]["members"]
        if self.split:
            source = rows[self.split["uid"]]
            original = {**source}
            second = {**source, "uid": SPLIT_UID, "state": {**source["state"]}}
            for row in (source, second):
                row.update(examScope=self.scope(row["uid"]), sourceMetadata=[original], count=4, series=1)
            body["studies"].append(second)
        for uid, group in self.report_groups.items():
            if uid in rows:
                rows[uid]["reportGroup"] = group
                if group.get("readable"):
                    rows[uid]["reportScope"] = {**self.scope(uid), "kind": "merge", "groupId": group["id"], "active": group["active"],
                        "sources": [{"studyUid": u, "series": {"mode": "all", "uids": []}} for u in group["studies"]]}
        for uid, kind in self.lost.items():
            rows[uid].update(examUnavailable=True, examUnavailableKind=kind)
        body["studies"] = [row for row in body["studies"] if row["uid"] not in hidden]
        body["pagination"]["total"] = len(body["studies"])
        return body

    def api(self, route, request, method, path, query):
        found = re.fullmatch(r"/api/studies/([^/]+)/exam-scope", path)
        if found and method == "GET":
            if self.held_scope is not None:
                self.held_scope.append((route,self.scope(found.group(1))))
                return None
            return route.fulfill(json=self.scope(found.group(1)))
        if path.startswith("/api/exam-groups") or re.fullmatch(r"/api/studies/[^/]+/exam-group", path):
            account, refused = self.authenticate(request)
            if refused:
                return self.refuse(route, *refused)
            body = request.post_data_json if method == "POST" else None
            self.sent.append((method, path, body))
            if method == "POST" and path == "/api/exam-groups/split":
                self.split = body
                self.generation += 1
                return route.fulfill(json={"group": {"id": GROUP_ID, "kind": "split"}})
            if method == "POST" and path == "/api/exam-groups":
                if self.merge_refusal:
                    return self.answer(route, *self.merge_refusal)
                self.groups[body["baseUid"]] = [body["baseUid"], *[u for u in body["uids"] if u != body["baseUid"]]]
                self.generation += 1
                return route.fulfill(json={"group": {"id": GROUP_ID, "kind": "merge", "baseUid": body["baseUid"], "members": []}})
            found = re.fullmatch(r"/api/studies/([^/]+)/exam-group", path)
            if method == "GET" and found:
                if self.group_read_failure:
                    return self.answer(route, *self.group_read_failure)
                base = found.group(1)
                if self.split and base in (self.split["uid"], SPLIT_UID):
                    return route.fulfill(json={"group": {"id": GROUP_ID, "kind": "split"}, "checks": self.checks})
                if base in self.lost_members:
                    return route.fulfill(json={"group": {"id": GROUP_ID, "kind": "merge", "baseUid": base, "members": [
                        {"logicalUid": u, "studyUid": u, "part": i, "seriesUids": []} for i, u in enumerate(self.lost_members[base])],
                        **({"unavailable": self.lost_hidden[base]} if base in self.lost_hidden else {})}, "checks": self.checks})
                if base not in self.groups:
                    return route.fulfill(json={"group": None})
                # An original gone since the list was read: the server names only the others and counts it.
                gone = [u for u in self.groups[base] if u in self.gone]
                return route.fulfill(json={"group": {"id": GROUP_ID, "kind": "merge", "baseUid": base, "members": [
                    {"logicalUid": u, "studyUid": u, "part": i, "seriesUids": []} for i, u in enumerate(self.groups[base]) if u not in gone],
                    **({"unavailable": len(gone)} if gone else {})}, "checks": self.checks})
            if method == "POST" and path == f"/api/exam-groups/{GROUP_ID}/dissolve":
                if self.dissolve_refusal:
                    return self.answer(route, *self.dissolve_refusal)
                self.groups.clear()
                self.lost.clear()
                self.lost_members.clear()
                self.lost_hidden.clear()
                self.split = None
                self.generation += 1
                return route.fulfill(json={"group": {"id": GROUP_ID, "dissolvedAt": "2026-10-03T01:00:00.000Z"}})
        return super().api(route, request, method, path, query)


class ExamMerge(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.pw = sync_playwright().start()
        cls.browser = cls.pw.chromium.launch()

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.pw.stop()

    def setUp(self):
        self.site = MergeSite()
        self.site.account = TECH
        self.context = self.browser.new_context(viewport={"width": 1400, "height": 900}, locale="ko-KR", timezone_id="Asia/Seoul")
        self.context.route("**/*", lambda route, request: self.site.handle(route, request))
        self.page = self.context.new_page()
        self.page.set_default_timeout(10000)
        self.errors, self.dialogs = [], []
        self.page.on("pageerror", lambda error: self.errors.append(str(error)))
        self.page.on("dialog", lambda dialog: (self.dialogs.append(dialog.message), dialog.accept()))
        self.page.goto(h.MAIN_URL)
        expect(self.page.locator("#rows tr[data-uid]")).to_have_count(3)
        tab = self.page.locator("[data-tab=Technician]")
        if tab.is_visible():
            tab.click()

    def tearDown(self):
        self.context.close()
        self.assertEqual([], self.errors, "page errors")
        self.assertEqual([], self.site.violations, "requests the synthetic origin does not answer")
        self.assertEqual([], self.dialogs, "no browser confirm or alert")

    # ── helpers ──
    def reload_technician(self):
        self.page.reload()
        expect(self.page.locator("#rows tr[data-uid]").first).to_be_visible()
        tab = self.page.locator("[data-tab=Technician]")
        if tab.is_visible():
            tab.click()

    def pick(self, uid):
        self.page.locator(f"#rows tr[data-uid='{uid}']").click()
        self.page.wait_for_function(f"() => selectedUid === {json.dumps(uid)}")

    def window(self, name):
        return self.page.locator(f"dialog[data-exam-window='{name}']")

    def row_of(self, window, uid):
        return window.locator(f"tbody tr[data-uid='{uid}']")

    def result(self, window):
        return window.locator(".exam-merge-result")

    # ── cases ──
    def test_buttons_sit_right_after_unverify(self):
        labels = self.page.eval_on_selector_all("#ctxbtns > button:not([hidden])", "b => b.map(x => x.textContent.trim())")
        at = labels.index("Unverify")
        self.assertEqual(["Unverify", "Merge Exam", "Split / Unmerge"], labels[at:at + 3])
        expect(self.page.locator("#t-merge-exam")).to_be_enabled()
        # The old hidden Split Exam button is left as it was.
        self.assertEqual(1, self.page.locator("#ctxbtns > button[hidden][disabled]", has_text="Split Exam").count())

    def test_merge_window_refuses_another_patient_on_the_spot_then_merges_on_the_chosen_base(self):
        self.pick(h.UID)
        self.page.locator("#t-merge-exam").click()
        win = self.window("merge")
        expect(win).to_be_visible()
        base_a, base_b, other = (self.row_of(win, u) for u in (h.UID, h.UID_B, rf.UID_C))
        expect(base_a.locator("input[type=radio]")).to_be_checked()
        expect(base_a.locator("input[type=checkbox]")).to_be_checked()
        expect(base_b.locator("input[type=checkbox]")).to_be_checked()
        expect(other.locator("input[type=checkbox]")).not_to_be_checked()
        expect(base_b).to_contain_text("1 / 12")
        expect(self.result(win)).to_contain_text("결과: 검사 1건 (기준 SYNACC-A1, 2026-10-03) · 시리즈 2 · 영상 20.")
        expect(self.result(win)).to_contain_text("원래 검사 2건의 묶음은 기록으로 남아 되돌릴 수 있습니다.")
        expect(self.result(win)).to_contain_text("Query/Retrieve와 원본 내보내기는 원래 검사 단위입니다.")
        merge = win.locator(".order-dialog-foot button", has_text=re.compile("^Merge$"))
        expect(merge).to_be_enabled()
        # Another patient's study: refused at once.
        other.locator("input[type=checkbox]").check()
        expect(self.result(win)).to_have_text("다른 환자의 검사는 합칠 수 없습니다 (SYN-P-001, SYN-P-003).")
        expect(merge).to_be_disabled()
        other.locator("input[type=checkbox]").uncheck()
        expect(self.result(win)).to_contain_text("· 시리즈 2 · 영상 20.")
        expect(merge).to_be_enabled()
        # The Base moves to the second study.
        base_b.locator("input[type=radio]").check()
        expect(self.result(win)).to_contain_text("(기준 SYNACC-A2, 2026-10-03)")
        merge.click()
        expect(win).to_contain_text("합쳤습니다: 검사 2건 → SYNACC-A2 · 20장.")
        self.assertEqual([("POST", "/api/exam-groups", {"baseUid": h.UID_B, "uids": [h.UID, h.UID_B]})], self.site.sent)
        win.locator("button", has_text="Close").click()
        expect(win).to_have_count(0)
        # The list: the merged exam's base row only, with its badge next to its Accession No.
        expect(self.page.locator("#rows tr[data-uid]")).to_have_count(2)
        badge = self.page.locator(f"#rows tr[data-uid='{h.UID_B}'] td.acc .exam-merged")
        expect(badge).to_have_text("Merged ×2 · 20 img")
        self.assertIn("SYNACC-A1", badge.get_attribute("title"))
        expect(self.page.locator("#countlist")).to_contain_text("Total 2")

    def test_a_merged_exam_whose_original_cannot_be_read_is_not_an_ordinary_row(self):
        # The server's answer when one original of a merged exam in force is gone or outside the reader's access: no scope,
        # the kind of exam, nothing of the original. The row says so instead of passing for an ordinary row.
        self.site.lost = {h.UID_B: "merge"}
        self.reload_technician()
        badge = self.page.locator(f"#rows tr[data-uid='{h.UID_B}'] td.acc .exam-merged")
        expect(badge).to_have_text("Merged · original unavailable")
        expect(badge).to_have_attribute("title", re.compile("^합친 검사의 원본 일부를 볼 수 없어"))
        expect(self.page.locator(f"#rows tr[data-uid='{h.UID}'] td.acc .exam-merged")).to_have_count(0)
        self.site.lost = {h.UID_B: "split"}
        self.reload_technician()
        expect(badge).to_have_text("Split · original unavailable")
        # The technician can still undo it: the window takes the server's group (the server checked access to every original).
        # The server names only the originals the reader can read now and counts the others.
        self.site.lost, self.site.lost_members, self.site.lost_hidden = {h.UID_B: "merge"}, {h.UID_B: [h.UID_B]}, {h.UID_B: 1}
        self.reload_technician()
        expect(badge).to_have_text("Merged · original unavailable")
        # Another institution (a tele receiver) may read the group but does not own it: the window says only that, and lists
        # none of the group's originals (one of which it cannot read).
        owner = {"rule": "owner", "ok": False, "message": "검사 묶음은 원본 소유 기관에서만 되돌릴 수 있습니다.", "uids": []}
        self.site.checks = [owner, *self.site.checks]
        self.pick(h.UID_B)
        self.page.locator("#t-split-unmerge").click()
        win = self.window("unmerge")
        expect(win).to_contain_text("원본 소유 기관에서만 되돌릴 수 있습니다.")
        expect(win).not_to_contain_text("2.25.999")
        expect(win.locator("table")).to_have_count(0)
        expect(win.get_by_role("button", name="Unmerge", exact=True)).to_have_count(0)
        win.get_by_role("button", name="Close").click()
        self.site.checks = self.site.checks[1:]
        self.pick(h.UID_B)
        self.page.locator("#t-split-unmerge").click()
        win = self.window("unmerge")
        expect(win.locator(".exam-merge-checks li")).to_have_count(3)
        # The owner's window lists the original it can read and says how many it cannot, naming none of them.
        expect(win.locator("table tbody tr")).to_have_count(1)
        expect(win.locator(".exam-merge-hidden")).to_have_text("원본 검사 1건은 지금 볼 수 없어 이 표에 없습니다.")
        win.get_by_role("button", name="Unmerge", exact=True).click()
        expect(win).to_contain_text("되돌렸습니다.")
        self.assertIn(("POST", f"/api/exam-groups/{GROUP_ID}/dissolve", None), self.site.sent)
        win.get_by_role("button", name="Close").click()
        expect(self.page.locator("#rows .exam-merged")).to_have_count(0)
    def test_server_refusal_is_shown_and_the_window_stays_open(self):
        self.site.merge_refusal = (409, {"code": "EXAM_GROUP_REFUSED", "message": "SYN refused",
                                         "refusals": [{"uid": h.UID_B, "rule": "reported", "message": "판독문이 있습니다(RS T). 먼저 판독 취소(Reset)를 하세요."}]})
        self.pick(h.UID)
        self.page.locator("#t-merge-exam").click()
        win = self.window("merge")
        win.locator(".order-dialog-foot button", has_text=re.compile("^Merge$")).click()
        expect(win.locator(".exam-merge-refused")).to_have_text("SYNACC-A2: 판독문이 있습니다(RS T). 먼저 판독 취소(Reset)를 하세요.")
        expect(win.locator(".order-dialog-foot button", has_text=re.compile("^Merge$"))).to_be_enabled()
        expect(self.page.locator("#rows tr[data-uid]")).to_have_count(3)

    def test_split_unmerge_restores_a_merged_exam_and_says_so_for_others(self):
        self.site.groups[h.UID] = [h.UID, h.UID_B]
        settle(self.page, "load()")
        expect(self.page.locator("#rows tr[data-uid]")).to_have_count(2)
        self.pick(rf.UID_C)
        self.page.locator("#t-split-unmerge").click()
        win = self.window("unmerge")
        expect(win).to_contain_text("나눌 수 있는 영상 시리즈가 두 개 이상 필요합니다.")
        expect(win.get_by_role("button", name="Split", exact=True)).to_be_disabled()
        win.locator("button", has_text="Close").click()
        self.pick(h.UID)
        self.page.locator("#t-split-unmerge").click()
        win = self.window("unmerge")
        expect(win.locator("table tbody tr")).to_have_count(2)
        cells = win.locator("table tbody tr").evaluate_all("rows => rows.map(r => [...r.children].map(td => td.textContent))")
        self.assertEqual([["SYNACC-A1", "2026-10-03", "SYN CT CHEST", "1 / 8"], ["SYNACC-A2", "2026-10-03", "SYN CT CHEST", "1 / 12"]], cells)
        expect(win.locator(".exam-merge-checks li")).to_have_text([
            "✓ 합친 검사에 지금 승인된 판독문이 없습니다.", "✓ 이 검사들의 전송·내보내기가 진행 중이지 않습니다.",
            "✓ 합친 검사의 판독문을 쓰는 사람이 없습니다."])
        unmerge = win.locator(".order-dialog-foot button", has_text="Unmerge")
        expect(unmerge).to_be_enabled()
        unmerge.click()
        expect(win).to_contain_text("원본 영상과 기존 판독 이력은 보존했습니다.")
        self.assertIn(("POST", f"/api/exam-groups/{GROUP_ID}/dissolve", None), self.site.sent)
        expect(self.page.locator("#rows tr[data-uid]")).to_have_count(3)
        expect(self.page.locator("#rows .exam-merged")).to_have_count(0)

    def test_unmerge_window_draws_no_original_the_server_no_longer_names(self):
        # The list was read while both originals were there; the second is gone when the window asks the server.
        self.site.groups[h.UID] = [h.UID, h.UID_B]
        settle(self.page, "load()")
        self.site.gone = {h.UID_B}
        self.pick(h.UID)
        self.page.locator("#t-split-unmerge").click()
        win = self.window("unmerge")
        expect(win.locator(".exam-merge-checks li")).to_have_count(3)
        cells = win.locator("table tbody tr").evaluate_all("rows => rows.map(r => r.children[0].textContent)")
        self.assertEqual(["SYNACC-A1"], cells)
        expect(win.locator(".exam-merge-hidden")).to_have_text("원본 검사 1건은 지금 볼 수 없어 이 표에 없습니다.")
        expect(win).not_to_contain_text("SYNACC-A2")
        # A refused Unmerge reads the group again: the table and the count follow that answer.
        self.site.dissolve_refusal = (409, {"code": "EXAM_GROUP_REFUSED", "message": "되돌릴 수 없습니다: 이 검사의 전송 또는 내보내기가 진행 중입니다.",
                                            "refusals": [{"uid": None, "rule": "transfer", "message": "이 검사의 전송 또는 내보내기가 진행 중입니다."}]})
        self.site.gone = set()
        win.locator(".order-dialog-foot button", has_text="Unmerge").click()
        expect(win.locator("table tbody tr")).to_have_count(2)
        expect(win.locator(".exam-merge-hidden")).to_have_count(0)
        # A group read that fails for a reason that says nothing of the group keeps the last answer: Unmerge can be retried.
        self.site.group_read_failure = (503, {"message": "SYN busy"})
        win.locator(".order-dialog-foot button", has_text="Unmerge").click()
        expect(win.locator(".exam-merge-refused")).to_have_count(1)
        expect(win.locator("table tbody tr")).to_have_count(2)
        expect(win).not_to_contain_text("검사 범위가 바뀌었습니다.")
        expect(win.get_by_role("button", name="Unmerge", exact=True)).to_be_enabled()
        self.site.group_read_failure = None
        # The next refused Unmerge finds the group ended meanwhile: the refusal stays, no originals, no Unmerge.
        self.site.gone = {h.UID_B}
        win.locator(".order-dialog-foot button", has_text="Unmerge").click()
        expect(win.locator(".exam-merge-hidden")).to_have_count(1)
        self.site.groups.clear()
        win.locator(".order-dialog-foot button", has_text="Unmerge").click()
        expect(win.locator(".exam-merge-refused")).to_contain_text("이 검사의 전송 또는 내보내기가 진행 중입니다.")
        expect(win.locator("table")).to_have_count(0)
        expect(win).to_contain_text("검사 범위가 바뀌었습니다. 목록을 새로고침한 뒤 다시 여세요.")
        expect(win.get_by_role("button", name="Unmerge", exact=True)).to_be_disabled()

    def test_receiving_institution_window_says_only_why_once_an_original_is_gone(self):
        # Read whole by the list, then one original is gone when the window asks: the server counts it and says this
        # technician's institution does not own the group — the window says only that.
        self.site.groups[h.UID] = [h.UID, h.UID_B]
        owner = {"rule": "owner", "ok": False, "message": "검사 묶음은 원본 소유 기관에서만 되돌릴 수 있습니다.", "uids": []}
        self.site.checks = [owner, *self.site.checks]
        settle(self.page, "load()")
        self.site.gone = {h.UID_B}
        self.pick(h.UID)
        self.page.locator("#t-split-unmerge").click()
        win = self.window("unmerge")
        expect(win).to_contain_text("원본 소유 기관에서만 되돌릴 수 있습니다.")
        expect(win.locator("table")).to_have_count(0)
        expect(win).not_to_contain_text("SYNACC")
        expect(win.get_by_role("button", name="Unmerge", exact=True)).to_have_count(0)

    def test_unmerge_is_off_while_a_check_fails(self):
        self.site.groups[h.UID] = [h.UID, h.UID_B]
        self.site.checks[0] = {"rule": "approved", "ok": False, "uids": [h.UID],
                               "message": "승인된 판독문이 있습니다. 먼저 판독 취소(Reset)를 하세요."}
        settle(self.page, "load()")
        expect(self.page.locator("#rows tr[data-uid]")).to_have_count(2)
        self.pick(h.UID)
        self.page.locator("#t-split-unmerge").click()
        win = self.window("unmerge")
        expect(win.locator(".exam-merge-checks li").first).to_have_text("✗ 승인된 판독문이 있습니다. 먼저 판독 취소(Reset)를 하세요.")
        expect(win.locator(".order-dialog-foot button", has_text="Unmerge")).to_be_disabled()
        self.assertFalse(any(m == "POST" for m, _, _ in self.site.sent))

    def test_accession_filter_finds_the_merged_exam_by_either_original(self):
        self.site.groups[h.UID] = [h.UID, h.UID_B]
        settle(self.page, "load()")
        expect(self.page.locator("#rows tr[data-uid]")).to_have_count(2)
        self.page.evaluate("() => { fval.acc = 'SYNACC-A2'; render(); }")
        expect(self.page.locator("#rows tr[data-uid]")).to_have_count(1)
        expect(self.page.locator(f"#rows tr[data-uid='{h.UID}']")).to_have_count(1)
        self.page.evaluate("() => { fval.acc = ''; render(); }")

    def test_report_scope_line_says_which_exam_the_report_is_written_on(self):
        self.site.groups[h.UID] = [h.UID, h.UID_B]
        self.site.report_groups[rf.UID_C] = {"id": GROUP_ID, "active": False, "readable": True, "studies": [rf.UID_C, h.UID]}
        settle(self.page, "load()")
        expect(self.page.locator("#rows tr[data-uid]")).to_have_count(2)
        scope = self.page.locator(".exam-report-scope")
        self.pick(h.UID)
        self.page.evaluate("() => setMode('Radiology')")
        expect(scope).to_be_visible()
        expect(scope).to_contain_text("Merged exam — SYNACC-A1 + SYNACC-A2")
        expect(scope.get_by_role("button", name="Report History · SYNACC-A2")).to_be_visible()
        self.pick(rf.UID_C)
        expect(scope).to_contain_text("지금은 되돌린 범위의 판독입니다.")
        self.site.report_groups[rf.UID_C] = {"id": GROUP_ID, "active": False, "readable": False, "studies": []}
        settle(self.page, "load()")
        expect(scope).to_contain_text("저장된 판독 범위 일부를 볼 수 없어 본문을 보이지 않습니다.")

    def test_split_selects_whole_series_and_unsplit_restores_one_original(self):
        self.pick(h.UID)
        self.page.locator("#t-split-unmerge").click()
        win = self.window("unmerge")
        go = win.get_by_role("button", name="Split", exact=True)
        expect(go).to_be_disabled()
        win.get_by_role("checkbox", name="Split SYN Series 2").check()
        expect(go).to_be_enabled()
        expect(win).to_contain_text("Exam 1: 시리즈 1 · 영상 4 / Exam 2: 시리즈 1 · 영상 4")
        go.click()
        expect(win).to_contain_text("나눴습니다.")
        self.assertIn(("POST", "/api/exam-groups/split", {"uid": h.UID, "seriesUids": [SERIES[1]]}), self.site.sent)
        win.get_by_role("button", name="Close", exact=True).click()
        expect(self.page.locator("#rows .exam-merged")).to_have_text(["Split 1/2", "Split 2/2"])
        self.pick(SPLIT_UID)
        self.page.locator("#t-split-unmerge").click()
        win = self.window("unmerge")
        win.get_by_role("button", name="Unsplit", exact=True).click()
        expect(win).to_contain_text("기존 판독 이력은 보존했습니다.")
        expect(self.page.locator(f"#rows tr[data-uid='{SPLIT_UID}']")).to_have_count(0)

    def test_split_rechecks_generation_before_sending_without_losing_selection(self):
        self.pick(h.UID)
        self.page.locator("#t-split-unmerge").click()
        win = self.window("unmerge")
        win.get_by_role("checkbox", name="Split SYN Series 2").check()
        self.site.generation += 1
        win.get_by_role("button", name="Split", exact=True).click()
        expect(win.locator(".exam-merge-refused")).to_contain_text("검사 범위가 바뀌었습니다")
        expect(win.get_by_role("checkbox", name="Split SYN Series 2")).to_be_checked()
        self.assertFalse(any(m == "POST" for m, _, _ in self.site.sent))

    def test_old_split_scope_reply_is_dropped_after_selection_returns_to_the_same_uid(self):
        self.pick(h.UID)
        self.site.held_scope=[]
        with self.page.expect_request(re.compile(r"/exam-scope\?")):
            self.page.locator("#t-split-unmerge").click()
        deadline = time.monotonic() + 5
        while not self.site.held_scope and time.monotonic() < deadline:
            self.page.wait_for_timeout(10)
        self.assertEqual(1,len(self.site.held_scope))
        self.page.evaluate("async uids => { await select(uids[0]); await select(uids[1]); }",[rf.UID_C,h.UID])
        route,scope=self.site.held_scope[0]
        route.fulfill(json=scope)
        expect(self.window("unmerge")).to_have_count(0)
        self.assertFalse(any(m=="POST" for m,_,_ in self.site.sent))

    def test_download_originals_requires_explicit_sources_for_a_merged_exam(self):
        self.site.groups[h.UID] = [h.UID, h.UID_B]
        settle(self.page, "load()")
        self.pick(h.UID)
        self.page.locator(f"#rows tr[data-uid='{h.UID}']").click(button="right")
        self.page.get_by_text("Download Originals", exact=True).click()
        dialog=self.page.get_by_role("dialog").filter(has_text="Download Originals")
        expect(dialog.get_by_role("checkbox")).to_have_count(2)
        expect(dialog.get_by_role("button",name="Continue",exact=True)).to_be_disabled()
        dialog.get_by_role("checkbox").nth(1).check()
        expect(dialog.get_by_role("button",name="Continue",exact=True)).to_be_enabled()
        expect(dialog).to_contain_text("SYNACC-A2")
        dialog.get_by_role("button",name="Cancel",exact=True).click()
        self.assertFalse(any(m=="POST" for m,_,_ in self.site.sent))

    def test_unmerge_refusal_can_be_retried_and_selection_change_closes_old_dialog(self):
        self.site.groups[h.UID] = [h.UID, h.UID_B]
        settle(self.page, "load()")
        self.pick(h.UID)
        self.site.dissolve_refusal = (409, {"message": "SYN draft is occupied"})
        self.page.locator("#t-split-unmerge").click()
        win = self.window("unmerge")
        go = win.get_by_role("button", name="Unmerge", exact=True)
        go.click()
        expect(win.locator(".exam-merge-refused")).to_contain_text("SYN draft is occupied")
        expect(go).to_be_enabled()
        self.page.evaluate(f"() => select({json.dumps(rf.UID_C)})")
        expect(win).to_have_count(0)
        self.assertEqual(1, sum(m == "POST" for m, _, _ in self.site.sent))

    # ── screen language: the real translator of the page; words change, data never does ──
    def language(self, lang):
        self.assertTrue(self.page.evaluate("l => KinLanguage.restore({version: 1, worklist: l, reading: l})", lang))

    def texts(self, locator):
        return locator.evaluate_all("nodes => nodes.map(n => n.textContent.trim())")

    def test_unavailable_badge_follows_the_screen_language(self):
        # The badge is a product phrase: the chosen screen language names it, both ways, on a row already drawn.
        self.site.lost = {h.UID_B: "merge"}
        self.reload_technician()
        badge = self.page.locator(f"#rows tr[data-uid='{h.UID_B}'] td.acc .exam-merged")
        self.language("ko")
        expect(badge).to_have_text("합친 검사 · 원본 일부 볼 수 없음")
        self.language("en")
        expect(badge).to_have_text("Merged · original unavailable")
        self.site.lost = {h.UID_B: "split"}
        self.reload_technician()
        self.language("ko")
        expect(badge).to_have_text("나눈 검사 · 원본 볼 수 없음")

    def test_merge_button_title_follows_the_screen_language(self):
        self.pick(h.UID)
        self.page.locator("#t-merge-exam").click()
        go = self.window("merge").locator(".order-dialog-foot button[title]")
        korean = "체크한 검사를 기준 검사 하나로 합칩니다."
        expect(go).to_have_attribute("title", korean)
        self.language("en")
        expect(go).to_have_attribute("title", "Merges the checked studies into one base study.")
        self.language("ko")
        expect(go).to_have_attribute("title", korean)

    def test_korean_merge_window_translates_its_words_and_keeps_its_data(self):
        # A study description and patient names that read like the glossary are still data: templates ("Split {0}",
        # "Base {0}") and a glossary word itself ("Continue").
        self.site.desc[h.UID_B] = "Split Chest CT"
        flow = self.site.flow
        for patient_name in ("Base Nora", "Continue"):
            with self.subTest(name=patient_name):
                self.site.flow = tuple((uid, patient_name if patient == "SYN-P-001" else name, patient) for uid, name, patient in flow)
                self.language("en")
                settle(self.page, "load()")
                expect(self.page.locator("#rows tr[data-uid]", has_text=patient_name).first).to_be_visible()
                self.language("ko")
                self.pick(h.UID)
                self.page.locator("#t-merge-exam").click()
                win = self.window("merge")
                expect(win.locator("h3")).to_have_text("검사 합치기")
                expect(win.locator("thead th")).to_have_text(["합치기", "기준", "ID", "이름", "검사일", "검사명", "접수 번호", "시리즈 / 영상", "판독문"])
                expect(self.row_of(win, h.UID_B).locator("td")).to_have_count(9)
                cells = self.texts(self.row_of(win, h.UID_B).locator("td"))
                self.assertEqual(patient_name, cells[3])
                self.assertEqual("Split Chest CT", cells[5])
                self.assertEqual("SYNACC-A2", cells[6])
                self.assertEqual("1 / 12", cells[7])
                self.assertEqual("미판독", cells[8], "the report status is a word of the screen")
                expect(self.result(win)).to_contain_text("결과: 검사 1건 (기준 SYNACC-A1, 2026-10-03)")
                # The screen language changes while the window is open: the words follow, the data stays.
                self.language("en")
                expect(win.locator("thead th").nth(1)).to_have_text("Base")
                expect(self.row_of(win, h.UID_B).locator("td").nth(8)).to_have_text("Unread")
                cells = self.texts(self.row_of(win, h.UID_B).locator("td"))
                self.assertEqual((patient_name, "Split Chest CT"), (cells[3], cells[5]))
                self.language("ko")
                cells = self.texts(self.row_of(win, h.UID_B).locator("td"))
                self.assertEqual((patient_name, "Split Chest CT"), (cells[3], cells[5]))
                win.locator("button", has_text="닫기").click()
                expect(win).to_have_count(0)

    def test_english_screen_reads_the_server_checks_in_english_and_keeps_refusal_details(self):
        self.site.groups[h.UID] = [h.UID, h.UID_B]
        settle(self.page, "load()")
        self.language("en")
        self.pick(h.UID)
        self.page.locator("#t-split-unmerge").click()
        win = self.window("unmerge")
        # The window reads the group before it draws the table; the table is read once it is there.
        expect(win.locator("tbody tr")).to_have_count(2)
        expect(win.locator("thead th")).to_have_text(["Original exam", "StudyDate", "StudyDesc", "Series / Images back"])
        # The server's check sentences are known whole to the glossary, so they read in English; Korean keeps them as sent.
        expect(win.locator(".exam-merge-checks li")).to_have_text([
            "✓ The merged exam has no approved report now.", "✓ No transfer or export of these studies is in progress.",
            "✓ No one is writing the report of the merged exam."])
        self.language("ko")
        expect(win.locator(".exam-merge-checks li")).to_have_text([
            "✓ 합친 검사에 지금 승인된 판독문이 없습니다.", "✓ 이 검사들의 전송·내보내기가 진행 중이지 않습니다.",
            "✓ 합친 검사의 판독문을 쓰는 사람이 없습니다."])
        self.language("en")
        win.locator("button", has_text="Close").click()
        self.site.groups.clear()
        settle(self.page, "load()")
        expect(self.page.locator("#rows tr[data-uid]")).to_have_count(3)
        self.site.merge_refusal = (409, {"code": "EXAM_GROUP_REFUSED", "message": "SYN refused",
                                         "refusals": [{"uid": h.UID_B, "rule": "reported", "message": "판독문이 있습니다(RS T). 먼저 판독 취소(Reset)를 하세요."}]})
        self.pick(h.UID)
        self.page.locator("#t-merge-exam").click()
        win = self.window("merge")
        win.locator(".order-dialog-foot button", has_text=re.compile("^Merge$")).click()
        expect(win.locator(".exam-merge-refused")).to_have_text('SYNACC-A2: 판독문이 있습니다(RS T). 먼저 판독 취소(Reset)를 하세요.')

    def test_english_screen_finishes_split_unmerge_and_merge_in_english(self):
        done = lambda win: win.locator("p.order-note.ok")
        hangul = re.compile("[가-힣]")
        self.language("en")
        self.pick(h.UID)
        self.page.locator("#t-split-unmerge").click()
        win = self.window("unmerge")
        win.get_by_role("checkbox", name="Split SYN Series 2").check()
        win.get_by_role("button", name="Split", exact=True).click()
        expect(done(win)).to_have_text("Split. Each part can be read at Split 1/2 and Split 2/2 in the list.")
        win.get_by_role("button", name="Close", exact=True).click()
        self.pick(SPLIT_UID)
        self.page.locator("#t-split-unmerge").click()
        win = self.window("unmerge")
        win.get_by_role("button", name="Unsplit", exact=True).click()
        expect(done(win)).to_have_text("Restored. The original images and the existing report history were kept.")
        win.get_by_role("button", name="Close", exact=True).click()
        self.site.groups[h.UID] = [h.UID, h.UID_B]
        settle(self.page, "load()")
        self.pick(h.UID)
        self.page.locator("#t-split-unmerge").click()
        win = self.window("unmerge")
        expect(win.locator("tbody tr")).to_have_count(2)
        expect(win.locator(".order-note").first).not_to_contain_text(hangul)
        win.locator(".order-dialog-foot button", has_text="Unmerge").click()
        expect(done(win)).to_have_text("Restored. The original images and the existing report history were kept.")
        win.get_by_role("button", name="Close", exact=True).click()
        expect(self.page.locator("#rows tr[data-uid]")).to_have_count(3)
        self.pick(h.UID)
        self.page.locator("#t-merge-exam").click()
        win = self.window("merge")
        win.locator(".order-dialog-foot button", has_text=re.compile("^Merge$")).click()
        expect(done(win)).to_be_visible()
        expect(done(win)).not_to_contain_text(hangul)

    def test_korean_screen_keeps_the_split_completion_line_as_written(self):
        self.language("ko")
        self.pick(h.UID)
        self.page.locator("#t-split-unmerge").click()
        win = self.window("unmerge")
        win.get_by_role("checkbox", name=re.compile("SYN Series 2")).check()
        win.locator(".order-dialog-foot button").first.click()
        expect(win.locator("p.order-note.ok")).to_have_text("나눴습니다. 목록의 Split 1/2와 Split 2/2에서 각각 판독할 수 있습니다.")

    def test_korean_unmerge_and_split_windows_keep_their_data(self):
        self.site.groups[h.UID] = [h.UID, h.UID_B]
        self.site.desc[h.UID_B] = "Split Chest CT"
        settle(self.page, "load()")
        self.language("ko")
        self.pick(h.UID)
        self.page.locator("#t-split-unmerge").click()
        win = self.window("unmerge")
        expect(win.locator("tbody tr")).to_have_count(2)
        expect(win.locator("thead th")).to_have_text(["원본 검사", "검사일", "검사명", "되돌아갈 시리즈 / 영상"])
        self.assertEqual(["SYNACC-A2", "2026-10-03", "Split Chest CT", "1 / 12"], self.texts(win.locator("tbody tr").nth(1).locator("td")))
        win.locator("button", has_text="닫기").click()
        self.site.groups.clear()
        # Series descriptions that are a glossary word itself ("Continue") and a template ("Split {0}") stay data.
        self.site.series_names = ["Continue", "Split Chest CT"]
        settle(self.page, "load()")
        expect(self.page.locator("#rows tr[data-uid]")).to_have_count(3)
        self.pick(h.UID)
        self.page.locator("#t-split-unmerge").click()
        win = self.window("unmerge")
        expect(win.locator("tbody tr")).to_have_count(2)
        expect(win.locator("thead th")).to_have_text(["검사 2", "시리즈", "시리즈 설명", "장비", "영상"])
        self.assertEqual(["", "1", "Continue", "CT", "4"], self.texts(win.locator("tbody tr").nth(0).locator("td")))
        self.assertEqual(["", "2", "Split Chest CT", "CT", "4"], self.texts(win.locator("tbody tr").nth(1).locator("td")))
        win.get_by_role("checkbox", name="Split Chest CT 나누기").check()
        expect(win).to_contain_text("검사 1: 시리즈 1 · 영상 4 / 검사 2: 시리즈 1 · 영상 4")
        for lang in ("en", "ko"):
            self.language(lang)
            expect(win.locator("thead th").nth(2)).to_have_text("Series Description" if lang == "en" else "시리즈 설명")
            self.assertEqual(["Continue", "Split Chest CT"], self.texts(win.locator("tbody tr td:nth-child(3)")))

    def test_report_scope_lines_follow_the_language_and_keep_the_accession_numbers(self):
        self.site.groups[h.UID] = [h.UID, h.UID_B]
        self.site.report_groups[rf.UID_C] = {"id": GROUP_ID, "active": False, "readable": True, "studies": [rf.UID_C, h.UID]}
        settle(self.page, "load()")
        expect(self.page.locator("#rows tr[data-uid]")).to_have_count(2)
        scope = self.page.locator(".exam-report-scope")
        self.page.evaluate("() => setMode('Radiology')")
        self.pick(rf.UID_C)
        self.language("en")
        expect(scope).to_contain_text("Merged exam — SYNACC-C1 + SYNACC-A1 · This report is of a scope that has since been restored.")
        self.language("ko")
        expect(scope).to_contain_text("합친 검사 — SYNACC-C1 + SYNACC-A1 · 지금은 되돌린 범위의 판독입니다.")
        expect(scope.get_by_role("button", name="판독문 이력 · SYNACC-A1")).to_be_visible()
        # Report History: one version written on the merged exam, one whose scope can no longer be read.
        versions = [{"version": 2, "action": "approve", "author": "SYN Doctor", "at": "2026-10-02T00:00:00Z",
                     "group": {"id": GROUP_ID, "readable": True, "active": False, "studies": [rf.UID_C, h.UID]}},
                    {"version": 1, "action": "save", "author": "SYN Doctor", "at": "2026-10-01T00:00:00Z",
                     "group": {"id": GROUP_ID, "readable": False, "active": False}}]
        self.page.route("**/api/studies/*/report/versions", lambda route: route.fulfill(json=versions))
        self.language("en")
        # The technician's screen has no History button; the window is the same one the Report History button opens.
        self.page.evaluate("() => { showHistory(); }")
        lines = self.page.locator("#hist-body [data-exam-group]")
        expect(lines).to_have_text([
            "Exam scope — This version was written on the images of the original exams (SYNACC-C1 + SYNACC-A1) · scope since restored",
            "Exam scope — Some images of the stored scope cannot be viewed, so the text of this version is not shown"])
        self.language("ko")
        expect(lines).to_have_text([
            "검사 범위 — 원본 검사(SYNACC-C1 + SYNACC-A1)의 영상으로 쓴 판입니다 · 지금은 되돌린 범위",
            "검사 범위 — 저장된 범위의 일부 영상을 볼 수 없어 이 판의 본문을 보이지 않습니다"])

    def test_related_report_line_names_the_exam_scope_not_the_exam_column(self):
        self.site.related_reports[rf.UID_C] = [{"uid": h.UID, "version": 3, "scope": {"part": None}},
                                               {"uid": SPLIT_UID, "version": 2, "scope": {"part": 1}}]
        settle(self.page, "load()")
        self.pick(rf.UID_C)
        links = self.page.locator("#relrows button.chip")
        expect(links).to_have_text(["Related Report · Exam · v3", "Related Report · Exam 2 · v2"])
        self.language("ko")
        expect(links).to_have_text(["관련 판독문 · 검사 범위 · v3", "관련 판독문 · 검사 2 · v2"])
        self.language("en")
        expect(links).to_have_text(["Related Report · Exam · v3", "Related Report · Exam 2 · v2"])

    def test_original_receipt_lines_translate_their_words_not_the_accession_numbers(self):
        self.site.groups[h.UID] = [h.UID, h.UID_B]
        settle(self.page, "load()")
        self.pick(h.UID)
        line = self.page.locator("#study-receipt .exam-original-receipts > div").first
        expect(line).to_contain_text("SYNACC-A1 · ")
        self.language("en")
        expect(line).to_contain_text("Gateway receipt information was not provided in this list.")
        self.assertEqual("SYNACC-A1", line.locator("[translate=no]").first.text_content())
        self.language("ko")
        expect(line).to_contain_text("Gateway 영수증 정보가 이 목록에 제공되지 않았습니다.")

    def test_accession_numbers_that_are_glossary_words_stay_data_in_either_language(self):
        # An Accession No is data wherever it stands alone, also when it is a glossary word itself ("Continue") or reads
        # like a template ("Split {0}"): the study information, each original receipt line of a merged exam, and the
        # report scope line of a split part with its Report History button. The study information's Study is data too.
        self.site.acc[h.UID], self.site.acc[h.UID_B] = "Continue", "Split Chest CT"
        self.site.desc[h.UID] = "Split Chest CT"
        self.site.groups[h.UID] = [h.UID, h.UID_B]
        self.language("en")
        settle(self.page, "load()")
        expect(self.page.locator("#rows tr[data-uid]")).to_have_count(2)
        self.pick(h.UID)
        lines = self.page.locator("#study-receipt .exam-original-receipts > div")
        expect(lines).to_have_count(2)
        study, accession = (self.page.locator("#clinical table tr").nth(n).locator("td").nth(1) for n in (3, 5))
        for lang in ("ko", "en", "ko"):
            with self.subTest(view="merged", lang=lang):
                self.language(lang)
                expect(lines.first).to_contain_text("Gateway 영수증 정보가 이 목록에 제공되지 않았습니다." if lang == "ko"
                                                    else "Gateway receipt information was not provided in this list.")
                self.assertEqual(["Continue", "Split Chest CT"],
                                 lines.evaluate_all("ls => ls.map(l => l.firstElementChild.firstElementChild.textContent)"))
                expect(accession).to_have_text("Continue")
                expect(study).to_have_text("Split Chest CT")
        self.site.groups.clear()
        self.site.split = {"uid": h.UID, "seriesUids": [SERIES[1]]}
        self.language("en")
        settle(self.page, "load()")
        expect(self.page.locator("#rows .exam-merged")).to_have_text(["Split 1/2", "Split 2/2"])
        self.page.evaluate("() => setMode('Radiology')")
        self.pick(SPLIT_UID)
        scope = self.page.locator(".exam-report-scope")
        expect(scope).to_contain_text("Split 2/2 — Continue")
        for lang in ("ko", "en", "ko"):
            with self.subTest(view="split", lang=lang):
                self.language(lang)
                history = "판독문 이력 · Continue" if lang == "ko" else "Report History · Continue"
                expect(scope.get_by_role("button", name=history, exact=True)).to_be_visible()
                expect(scope.locator("[translate=no]")).to_have_text("Continue")
                expect(accession).to_have_text("Continue")
                expect(study).to_have_text("Split Chest CT")

    def test_original_choices_keep_their_data_untranslated(self):
        self.site.groups[h.UID] = [h.UID, h.UID_B]
        self.site.desc[h.UID_B] = "Split Chest CT"
        settle(self.page, "load()")
        self.language("ko")
        self.pick(h.UID)
        self.page.locator(f"#rows tr[data-uid='{h.UID}']").click(button="right")
        self.page.get_by_text("원본 내려받기", exact=True).click()
        dialog = self.page.locator("dialog[open]").filter(has_text="원본 내려받기")
        expect(dialog.locator("label [translate=no]")).to_have_count(2)
        expect(dialog.locator("label").nth(1)).to_contain_text("SYNACC-A2 · Split Chest CT")
        dialog.get_by_role("button", name="취소", exact=True).click()


if __name__ == "__main__":
    unittest.main()
