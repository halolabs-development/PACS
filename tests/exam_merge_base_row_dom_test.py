# coding: utf-8
"""Merge Exam: the Base is the study the person selected, by its UID, however the list is drawn again.

The delivered page against the synthetic origin of exam_merge_dom_test (MergeSite). Two studies of one patient on one day
carry the same Patient Name, so a row is told apart only by its Accession No; a third study of that patient arrives at the
top of the list and pushes the rows down.

  - select the second same-patient row, a new study arrives above it (Refresh): the same study stays selected, and the
    Merge Exam window opened after that has it as Base and sends it as baseUid;
  - the window is open and the list is read again with the new study above: the window stays, its Base is unchanged and
    Merge sends the selected study as baseUid;
  - the selected study leaves the list while the window is open: the window closes and nothing is sent.
"""
import re
import unittest

import auth_logout_dom_test as h
import exam_merge_dom_test as em
import report_flow_dom_test as rf
from playwright.sync_api import expect, sync_playwright

# The server lists studies in UID order: the new study sorts first, so it is drawn above the others.
NEW = "1.2.826.0.1.3680043.10.7707.0"
em.ACC.setdefault(NEW, "SYNACC-A3")
em.COUNT.setdefault(NEW, 6)


class ArrivalSite(em.MergeSite):
    def __init__(self):
        super().__init__()
        # The new study of the same patient is first in the server's order, hidden until it arrives.
        self.flow = ((NEW, h.PATIENT, "SYN-P-001"), *self.flow)
        self.store[NEW] = {"revs": 0, "row": None, "report": {"version": 0, "rs": "W"}}
        self.hidden = {NEW}


class MergeBaseRow(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.pw = sync_playwright().start()
        cls.browser = cls.pw.chromium.launch()

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.pw.stop()

    def setUp(self):
        self.site = ArrivalSite()
        self.site.account = em.TECH
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

    def order(self):
        return self.page.eval_on_selector_all("#rows tr[data-uid]", "rows => rows.map(r => r.dataset.uid)")

    def arrive(self, rows=4):
        """The new study arrives: the list is read again (Refresh; a poll draws the same way) with it at the top."""
        self.site.hidden.discard(NEW)
        self.page.evaluate("() => document.querySelector('#m-refresh').click()")
        expect(self.page.locator("#rows tr[data-uid]")).to_have_count(rows)

    def merge_window(self):
        self.page.locator("#t-merge-exam").click()
        win = self.page.locator("dialog[data-exam-window='merge']")
        expect(win).to_be_visible()
        return win

    def merge_button(self, win):
        return win.locator(".order-dialog-foot button", has_text=re.compile("^Merge$"))

    def test_rows_pushed_down_before_opening_keep_the_selected_study_as_base(self):
        self.page.locator(f"#rows tr[data-uid='{h.UID_B}']").click()
        self.page.wait_for_function(f"() => selectedUid === '{h.UID_B}'")
        self.assertEqual(1, self.order().index(h.UID_B))
        self.arrive()
        # The rows moved: the selected study is one row lower and the same patient's other study is where it was.
        self.assertEqual([NEW, h.UID, h.UID_B, rf.UID_C], self.order())
        self.assertEqual(h.UID_B, self.page.evaluate("selectedUid"))
        expect(self.page.locator("#rows tr.sel")).to_have_count(1)
        expect(self.page.locator(f"#rows tr[data-uid='{h.UID_B}']")).to_have_class(re.compile(r"\bsel\b"))
        win = self.merge_window()
        radios = win.locator("tbody input[type=radio]:checked")
        expect(radios).to_have_count(1)
        expect(win.locator(f"tbody tr[data-uid='{h.UID_B}'] input[type=radio]")).to_be_checked()
        expect(win.locator(".exam-merge-result")).to_contain_text("(기준 SYNACC-A2, ")
        self.merge_button(win).click()
        expect(win).to_contain_text("합쳤습니다: 검사 3건 → SYNACC-A2")
        self.assertEqual([("POST", "/api/exam-groups", {"baseUid": h.UID_B, "uids": [NEW, h.UID, h.UID_B]})], self.site.sent)

    def test_list_drawn_again_while_the_window_is_open_does_not_move_the_base(self):
        self.page.locator(f"#rows tr[data-uid='{h.UID_B}']").click()
        self.page.wait_for_function(f"() => selectedUid === '{h.UID_B}'")
        win = self.merge_window()
        expect(win.locator(f"tbody tr[data-uid='{h.UID_B}'] input[type=radio]")).to_be_checked()
        self.arrive()
        self.assertEqual([NEW, h.UID, h.UID_B, rf.UID_C], self.order())
        # The window is the one opened for the selected study: still open, its Base still that study.
        expect(win).to_be_visible()
        expect(win.locator("tbody input[type=radio]:checked")).to_have_count(1)
        expect(win.locator(f"tbody tr[data-uid='{h.UID_B}'] input[type=radio]")).to_be_checked()
        expect(win.locator(".exam-merge-result")).to_contain_text("(기준 SYNACC-A2, ")
        self.merge_button(win).click()
        expect(win).to_contain_text("합쳤습니다: 검사 2건 → SYNACC-A2")
        self.assertEqual([("POST", "/api/exam-groups", {"baseUid": h.UID_B, "uids": [h.UID, h.UID_B]})], self.site.sent)

    def test_selected_study_leaving_the_list_closes_the_window_and_sends_nothing(self):
        self.page.locator(f"#rows tr[data-uid='{h.UID_B}']").click()
        self.page.wait_for_function(f"() => selectedUid === '{h.UID_B}'")
        win = self.merge_window()
        self.site.hidden.add(h.UID_B)
        self.page.evaluate("() => document.querySelector('#m-refresh').click()")
        expect(self.page.locator("#rows tr[data-uid]")).to_have_count(2)
        expect(win).to_have_count(0)
        self.assertEqual([], self.site.sent)


if __name__ == "__main__":
    unittest.main()
