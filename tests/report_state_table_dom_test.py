# coding: utf-8
"""The report state table on the delivered split page (server rule: api/src/report-visibility.ts).

Another radiologist's saved report (RS T, text withheld by the server: `prelimHidden` + `bodyLock: 'in-progress'` +
`savedBy`) is listed as "In Progress by <writer>", opens read-only with the reason, keeps every write command off except
Reset to Unread (the in-progress takeover), and names its writer beside the editor. A study someone started typing (RS W
with a live hold) is listed as In Progress by that reader. A study whose report was destroyed at the end of its retention
(RS D, `bodyLock: 'destroyed'`) is listed as Destroyed and opens read-only with that reason. Only HTTP is synthetic.
"""
import re
import unittest

import auth_logout_dom_test as h
import report_flow_dom_test as flow
from playwright.sync_api import expect

WRITER = "syn-doctor2@kin"


class StateTableSite(flow.FlowSite):
    """Three studies: another radiologist's Save, another radiologist typing, a destroyed report."""

    def state_of(self, uid, account):
        st = super().state_of(uid, account)
        if uid == h.UID:
            own = {"findings": "SYN MY OWN DRAFT", "conclusion": "", "recommendation": "", "baseVersion": 0,
                   "at": "2026-10-03T00:00:00.000Z"} if getattr(self, "own_draft", False) else None
            st.update(rs="T", prelimHidden=True, bodyLock="in-progress", savedBy=WRITER, version=1, draft=own,
                      findings="", conclusion="", recommendation="")
        elif uid == h.UID_B:
            st.update(rs="W", holder=WRITER, bodyLock=None)
        elif uid == flow.UID_C:
            st.update(rs="D", prelimHidden=True, bodyLock="destroyed", draft=None, version=0)
        return st


# An administrator changed X's email and gave X's old one to Z. The page's colleague list (current emails) maps the old email to Z;
# the server names the writer by the account that saved / holds (savedByName, holderName).
OLD_EMAIL, X_NOW, X_NAME, Z_NAME = WRITER, "syn-doctor2-new@kin", "SYN Kim Writer", "SYN Lee Other"


class MovedEmailSite(StateTableSite):
    def state_of(self, uid, account):
        st = super().state_of(uid, account)
        if uid == h.UID:
            st.update(savedByName=X_NAME)
        elif uid == h.UID_B:
            st.update(holderName=X_NAME)
        return st

    def api(self, route, request, method, path, query):
        if method == "GET" and path == "/api/colleagues":
            return route.fulfill(json=[{"sub": "syn-sub-x", "id": X_NOW, "username": "syn-doctor2-new", "name": X_NAME},
                                       {"sub": "syn-sub-z", "id": OLD_EMAIL, "username": "syn-doctor2", "name": Z_NAME}])
        return super().api(route, request, method, path, query)


class ReportStateTablePage(unittest.TestCase):
    # The report flow suite's page driving, borrowed without its own cases.
    count = 3
    bundle_source = html_source = asset_source = None
    setUpClass = flow.ReportFlowPage.__dict__["setUpClass"]
    tearDownClass = flow.ReportFlowPage.__dict__["tearDownClass"]
    tearDown = flow.ReportFlowPage.tearDown
    open, row, pick, open_study, selected, wait = (flow.ReportFlowPage.open, flow.ReportFlowPage.row, flow.ReportFlowPage.pick,
                                                   flow.ReportFlowPage.open_study, flow.ReportFlowPage.selected, flow.ReportFlowPage.wait)

    def setUp(self):
        flow.ReportFlowPage.setUp(self)
        self.site.__class__ = StateTableSite

    def rs_cell(self, patient):
        return self.row(patient).locator("span.rs")

    def test_rs_column_names_who_is_on_a_report_and_a_destroyed_one(self):
        self.open()
        expect(self.rs_cell(h.PATIENT)).to_have_text(f"In Progress by {WRITER}")
        expect(self.rs_cell(h.PATIENT_B)).to_have_text(f"In Progress by {WRITER}")
        self.assertIn("쓰기 시작했습니다", self.rs_cell(h.PATIENT_B).get_attribute("title"))
        expect(self.rs_cell(flow.PATIENT_C)).to_have_text("Destroyed")
        self.assertIn("보존 기간이 끝나", self.rs_cell(flow.PATIENT_C).get_attribute("title"))
        # the writer's name is data: never translated
        self.assertEqual(self.rs_cell(h.PATIENT).locator("[translate=no]").inner_text(), WRITER)

    def test_another_radiologists_save_opens_read_only_with_only_reset_open(self):
        self.open()
        self.pick(h.PATIENT)
        self.wait(lambda: self.selected() == h.PATIENT, "the study opens")
        expect(self.page.locator("#findings")).not_to_be_editable()
        expect(self.page.locator("#findings")).to_have_value("")
        self.assertIn("Save해 둔 진행 중 판독", self.page.locator("#findings").get_attribute("placeholder"))
        expect(self.page.locator("#report-editor-state")).to_have_text("Read Only")
        expect(self.page.locator("#report-editor-why")).to_contain_text(WRITER)
        expect(self.page.locator("#report-editor-presence")).to_contain_text(f"In Progress by {WRITER}")
        expect(self.page.locator("#holdmsg")).to_contain_text("Reset to Unread")
        for button in ("#b-save", "#b-approve", "#b-defer", "#b-clear", "#b-paste", "#b-prelim", "#b-addendum"):
            expect(self.page.locator(button)).to_be_disabled()
        self.assertTrue(self.page.evaluate("() => !document.querySelector('#b-unread').disabled"), "Reset to Unread stays open")
        self.assertEqual([], self.site.holds, "no hold is taken on another radiologist's Save")
        self.assertEqual([], self.site.flow_puts)

    def test_read_only_reason_on_the_buttons_follows_the_screen_language(self):
        # The lock reason is a product phrase carrying the writer's name as data: the chosen language names it.
        self.open()
        self.pick(h.PATIENT)
        self.wait(lambda: self.selected() == h.PATIENT, "the study opens")
        defer = self.page.locator("#b-defer")
        why, hold = self.page.locator("#report-editor-why"), self.page.locator("#holdmsg")
        korean = (why.text_content(), why.get_attribute("title"), hold.text_content())
        self.page.evaluate("l => KinLanguage.restore({version: 1, worklist: l, reading: l})", "en")
        english = f"In progress, saved by {WRITER} — only that radiologist can read and continue it"
        expect(defer).to_have_attribute("title", english)
        # The editor head and the hold bar say the same reason, drawn before the choice: repainted, the name as written.
        expect(why).to_have_text(english)
        expect(why).to_have_attribute("title", english)
        expect(hold).to_contain_text(f"✎ {english}. To continue, use More ▸ Reset to Unread")
        self.assertIsNone(re.search("[가-힣]", hold.text_content() + why.text_content()))
        self.page.evaluate("l => KinLanguage.restore({version: 1, worklist: l, reading: l})", "ko")
        expect(defer).to_have_attribute("title", f"{WRITER} 님이 Save해 둔 진행 중 판독입니다 — 그 판독의만 보고 이어 쓸 수 있습니다")
        self.assertEqual(korean, (why.text_content(), why.get_attribute("title"), hold.text_content()))

    def test_a_held_report_names_its_holder_in_the_language_chosen_after_it_is_drawn(self):
        # Another radiologist holds the study (typing): Save, Approve and Prelim say who, and the hold bar says so too.
        self.open()
        self.pick(h.PATIENT_B)
        self.wait(lambda: self.selected() == h.PATIENT_B, "the study opens")
        buttons = [self.page.locator(b) for b in ("#b-save", "#b-approve", "#b-prelim")]
        hold, why = self.page.locator("#holdmsg"), self.page.locator("#report-editor-why")
        read = lambda: [b.get_attribute("title") for b in buttons] + [hold.text_content(), why.text_content()]
        korean = read()
        self.assertEqual([f"{WRITER} 님이 판독 중입니다"] * 3, korean[:3])
        self.assertEqual("현재 판독문은 편집할 수 없습니다", korean[4])
        self.page.evaluate("() => KinLanguage.restore({version: 1, worklist: 'en', reading: 'en'})")
        for b in buttons:
            expect(b).to_have_attribute("title", f"{WRITER} is reading")
        expect(hold).to_contain_text(f"✎ {WRITER} is reading — you can continue reading once the lock is released")
        expect(why).to_have_text("The current report can't be edited")
        self.assertIsNone(re.search("[가-힣]", hold.text_content() + why.text_content()))
        self.page.evaluate("() => KinLanguage.restore({version: 1, worklist: null, reading: null})")
        self.assertEqual(korean, read())

    def test_a_korean_report_screen_keeps_its_lock_reason_when_the_list_is_english(self):
        # The list in English, the report screen in Korean, the study picked from the list: every lock reason on the
        # report screen is Korean (plain writes are not translated by the region last clicked).
        self.open()
        self.page.evaluate("() => KinLanguage.restore({version: 1, worklist: 'en', reading: 'ko'})")
        self.pick(h.PATIENT)
        self.wait(lambda: self.selected() == h.PATIENT, "the study opens")
        korean = f"{WRITER} 님이 Save해 둔 진행 중 판독입니다"
        expect(self.page.locator("#b-defer")).to_have_attribute("title", korean + " — 그 판독의만 보고 이어 쓸 수 있습니다")
        expect(self.page.locator("#holdmsg")).to_contain_text(korean)
        expect(self.page.locator("#report-editor-why")).to_contain_text(korean)
        self.assertIn(korean, self.page.locator("#findings").get_attribute("placeholder"))

    def test_a_destroyed_report_opens_read_only_with_its_reason(self):
        self.open()
        self.pick(flow.PATIENT_C)
        self.wait(lambda: self.selected() == flow.PATIENT_C, "the study opens")
        expect(self.page.locator("#findings")).not_to_be_editable()
        expect(self.page.locator("#report-editor-state")).to_have_text("Read Only")
        expect(self.page.locator("#report-editor-why")).to_contain_text("보존 기간이 끝나 판독문을 파기한 검사입니다")
        for button in ("#b-save", "#b-approve", "#b-defer", "#b-unread", "#b-clear"):
            expect(self.page.locator(button)).to_be_disabled()

    def test_my_own_draft_stays_on_screen_read_only_under_another_save(self):
        self.site.own_draft = True
        self.open()
        self.pick(h.PATIENT)
        self.wait(lambda: self.selected() == h.PATIENT, "the study opens")
        expect(self.page.locator("#findings")).to_have_value("SYN MY OWN DRAFT")
        expect(self.page.locator("#findings")).not_to_be_editable()
        expect(self.page.locator("#report-editor-state")).to_have_text("Read Only")
        self.assertEqual([], self.site.flow_puts)

    def test_the_writer_is_named_by_the_server_never_by_an_email_that_moved_to_another_member(self):
        self.site.__class__ = MovedEmailSite
        self.open()
        expect(self.rs_cell(h.PATIENT)).to_have_text(f"In Progress by {X_NAME}")
        expect(self.rs_cell(h.PATIENT_B)).to_have_text(f"In Progress by {X_NAME}")
        self.pick(h.PATIENT)
        self.wait(lambda: self.selected() == h.PATIENT, "the study opens")
        expect(self.page.locator("#report-editor-presence")).to_contain_text(f"In Progress by {X_NAME}")
        expect(self.page.locator("#report-editor-why")).to_contain_text(X_NAME)
        expect(self.page.locator("#holdmsg")).to_contain_text(X_NAME)
        self.assertIn(X_NAME, self.page.locator("#b-defer").get_attribute("title"))
        self.pick(h.PATIENT_B)
        self.wait(lambda: self.selected() == h.PATIENT_B, "the held study opens")
        expect(self.page.locator("#report-editor-presence")).to_contain_text(f"Held by {X_NAME}")
        self.assertEqual(0, self.page.evaluate("n => document.body.innerHTML.split(n).length - 1", Z_NAME),
                         "the member who has the old email now is named nowhere")

    def test_my_own_unlocked_study_is_unchanged(self):
        self.site.__class__ = flow.FlowSite
        self.open()
        expect(self.rs_cell(h.PATIENT)).to_have_text("Unread")
        self.open_study(h.PATIENT)
        expect(self.page.locator("#report-editor-state")).to_have_text("Editable")


if __name__ == "__main__":
    unittest.main()
