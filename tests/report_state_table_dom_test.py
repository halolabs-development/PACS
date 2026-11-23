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


class EmptyDescriptionSite(StateTableSite):
    """The second study has neither a description nor a modality: the product writes its placeholder there."""

    def study_row(self, account, uid=h.UID, name=h.PATIENT, patient="SYN-P-001"):
        row = super().study_row(account, uid, name, patient)
        if name == h.PATIENT_B:  # the flow site draws every row from the first study's uid and sets its own after
            row.update(desc="", modality="")
        return row


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

    def test_rs_titles_name_the_writer_in_the_language_chosen_after_they_are_drawn(self):
        # A colleague's Save and a colleague's hold: the RS title joins the state's help with the writer's name (data), and the
        # viewing cell's mark names its holder. English repaints them with the name as written; Korean or no choice reads
        # exactly as drawn.
        self.open()
        saved, held = self.rs_cell(h.PATIENT), self.rs_cell(h.PATIENT_B)
        mark = self.row(h.PATIENT_B).locator("span.hold.other")
        marked = mark.count() > 0
        read = lambda: (saved.get_attribute("title"), held.get_attribute("title"), mark.get_attribute("title") if marked else None)
        korean = read()
        self.assertEqual(f"저장했지만 아직 승인하지 않은 판독문 — {WRITER}", korean[0])
        self.assertEqual(f"판독의가 판독문을 쓰기 시작했습니다(점유) — 아직 저장하지 않았습니다 — {WRITER}", korean[1])
        if marked:
            self.assertEqual(f"{WRITER} 님이 작성 중", korean[2])
        self.page.evaluate("() => KinLanguage.restore({version: 1, worklist: 'en', reading: 'en'})")
        expect(saved).to_have_attribute("title", f"Report saved but not yet approved — {WRITER}")
        expect(held).to_have_attribute("title", f"A radiologist started writing this report (held) — not saved yet — {WRITER}")
        if marked:
            expect(mark).to_have_attribute("title", f"{WRITER} writing")
        for choice in ({"version": 1, "worklist": "ko", "reading": "ko"}, {"version": 1, "worklist": None, "reading": None}):
            self.page.evaluate("c => KinLanguage.restore(c)", choice)
            self.assertEqual(korean, read(), choice)

    def test_template_rows_say_how_to_use_them_in_the_language_chosen_after_they_are_drawn(self):
        # Each template row's help and its View button name the template (title and shortcut are data): English repaints
        # them; Korean or no choice reads exactly as drawn.
        self.site.templates = [{**flow.TEMPLATE, "shortcut": "nbct"}, {**flow.TEMPLATE, "id": "SYN-TPL-2", "title": "SYN PLAIN TEMPLATE"}]
        self.open()
        self.pick(h.PATIENT)
        self.wait(lambda: self.selected() == h.PATIENT, "the study opens")
        rows = self.page.locator("#tplrows tr[data-i]")
        expect(rows).to_have_count(2)
        read = lambda: rows.evaluate_all("l => l.map(r => [r.title, r.querySelector('[data-tpl-preview]').getAttribute('aria-label')])")
        korean = read()
        self.assertEqual([['더블클릭: 판독문에 삽입 / 판독문에서 "nbct" 입력 후 Tab / 우클릭: 편집', "상용구 미리보기: SYN REC TEMPLATE"],
                          ["더블클릭: 판독문에 삽입 / 우클릭: 편집", "상용구 미리보기: SYN PLAIN TEMPLATE"]], korean)
        self.page.evaluate("() => KinLanguage.restore({version: 1, worklist: 'en', reading: 'en'})")
        self.assertEqual([['Double-click: insert into report / Type "nbct" in the report, then press Tab / Right-click: edit',
                           "Template preview: SYN REC TEMPLATE"],
                          ["Double-click: insert into report / Right-click: edit", "Template preview: SYN PLAIN TEMPLATE"]], read())
        self.page.evaluate("() => KinLanguage.restore({version: 1, worklist: null, reading: null})")
        self.assertEqual(korean, read())

    def test_an_empty_description_is_the_pages_word_and_a_real_one_stays_as_written(self):
        self.site.__class__ = EmptyDescriptionSite
        self.open()
        self.pick(h.PATIENT_B)
        self.wait(lambda: self.selected() == h.PATIENT_B, "the study opens")
        empty, real = self.row(h.PATIENT_B), self.row(h.PATIENT)
        info = self.page.locator('#clinical tr:has(> td:text-is("Study")) > td:nth-child(2)')
        expect(info).to_have_text("(설명 없음)")
        expect(empty).to_contain_text("(설명 없음)")
        self.page.evaluate("() => KinLanguage.restore({version: 1, worklist: 'en', reading: 'en'})")
        expect(info).to_have_text("(no description)")
        expect(empty).to_contain_text("(no description)")
        # drawn again on an English screen
        self.page.evaluate("() => { render(); renderClinical(); }")
        expect(info).to_have_text("(no description)")
        expect(self.row(h.PATIENT_B)).to_contain_text("(no description)")
        expect(real).to_contain_text("SYN CT CHEST")
        for choice in ({"version": 1, "worklist": "ko", "reading": "ko"}, {"version": 1, "worklist": None, "reading": None}):
            self.page.evaluate("c => KinLanguage.restore(c)", choice)
            expect(info).to_have_text("(설명 없음)")
            expect(self.row(h.PATIENT_B)).to_contain_text("(설명 없음)")

    def test_a_refusal_the_page_made_is_its_word_and_a_servers_message_stays_as_written(self):
        self.open()
        self.page.evaluate("() => KinLanguage.restore({version: 1, worklist: 'en', reading: 'en'})")
        toast = self.page.locator("#toast")
        # The draft client refuses by itself: this page never read the draft of this study, so it has no base to write on.
        self.page.evaluate("""async () => {
          const uid = 'syn-study-never-read';
          draftNotSaved(uid, work.capture('document'), await draftClient.write(uid, {findings: 'SYN'}, {}));
        }""")
        expect(toast).to_have_text("Server save failed: Not saved because the draft base for this study is unknown.")
        # The same code in a server's answer: its message is the server's and is put in as written.
        self.page.evaluate("""() => draftNotSaved('syn-study-never-read', work.capture('document'),
          {outcome: 'refused', code: 'KIN_DRAFT_BASE_UNKNOWN', message: '검사를 찾을 수 없습니다'})""")
        expect(toast).to_have_text("Server save failed: 검사를 찾을 수 없습니다")

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
