# coding: utf-8
"""The dates and times printed on the report paper follow one rule: the reader's local time, one human form.

The shipped KinReportPreview factory, report-citation.js and the shipped api() extracted from main.html run
on a blank page over a stubbed fetch - the same harness as tests/report_preview_citation_dom_test.py,
imported as a module (a module attribute is not a TestCase, so its cases do not run twice here). The page
runs in a fixed browser time zone, so the cases do not depend on the machine's clock or zone.

What is checked:
- an approval made between 00:00 and 09:00 in Asia/Seoul (the previous day in UTC) prints the local date
  and time, never the UTC date and never the word UTC;
- the paper's approval time is the same text as the worklist Confirm cell for the same answer, because
  the cell's own shipped functions (worklist-columns-view.js localStamp/confirmText) are run beside it, in
  two time zones;
- DICOM dates (YYYYMMDD) print as YYYY-MM-DD in the header, the per-page identity and the printed popup;
- an approval kept before the server kept its time prints the stored date; an unapproved report and the
  current editing text print '-'; an addendum keeps the first approval time, as the worklist does;
- a study with no date and no birth date prints the existing 'unknown' words, never 'Invalid Date' or NaN;
- a citation's insertion time prints by the same rule.

Not checked here: the key-image caption (it prints the same studyDate value as the header but needs the
DICOM lookup/digest stubs), and real pagination.
"""
import json
import os
import unittest
from pathlib import Path

import report_preview_citation_dom_test as base
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
COLUMNS_JS = (ROOT / "worklist-v0" / "hpacs-lite" / "worklist-columns-view.js").read_text(encoding="utf-8")
WORKLIST_FNS = base.extract_function(COLUMNS_JS, "localStamp") + "\n" + base.extract_function(COLUMNS_JS, "confirmText")

# 2026-11-18 03:06 in Asia/Seoul is 2026-11-17 18:06 UTC; the server stores the UTC date as `confirm`.
APPROVED_AT = "2026-11-17T18:06:00.000Z"


def answer(**report):
    value = base.preview_answer()
    value["study"].update({"birth": "19600101", "date": "20261116"})
    value["report"].update({"confirm": "2026-11-17", "approvedAt": APPROVED_AT})
    value["report"].update(report)
    return value


class ReportPreviewDatesDOMTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.pw = sync_playwright().start()
        cls.browser = cls.pw.chromium.launch()

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.pw.stop()

    def tearDown(self):
        self.assertEqual([], getattr(self, "errors", []), "the page reported an uncaught error")
        self.page.close()

    def open(self, preview, zone="Asia/Seoul", cite=None):
        self.page = self.browser.new_page(timezone_id=zone)
        self.page.set_default_timeout(10000)
        errors = []
        self.page.on("pageerror", lambda error: errors.append(str(error)))
        harness = (base.HARNESS
                   .replace("CITATIONJS", base.CITATION_JS)
                   .replace("PREVIEWJS", base.PREVIEW_JS)
                   .replace("APIFN", base.API_FN + "\n" + WORKLIST_FNS)
                   .replace("PREVIEWANSWER", json.dumps(preview, ensure_ascii=False))
                   .replace("UIDVALUE", base.UID))
        self.page.set_content(harness)
        self.errors = errors
        self.assertEqual([], errors, "the generated harness did not start")
        self.page.evaluate("ui.queueCite(%s)" % json.dumps(cite or base.ok([]), ensure_ascii=False))
        self.page.evaluate("ui.open()")
        self.page.wait_for_function("() => ui.srcdoc().length > 0")
        return self.page.evaluate("ui.srcdoc()")

    def header(self):
        return self.page.evaluate("new DOMParser().parseFromString(ui.srcdoc(), 'text/html').querySelector('header').textContent")

    def identity(self):
        return self.page.evaluate(
            "new DOMParser().parseFromString(ui.srcdoc(), 'text/html').querySelector('.identity-example').textContent")

    def worklist_cell(self, preview):
        return self.page.evaluate("report => confirmText(report)", preview["report"])

    def test_an_early_morning_approval_prints_the_local_date_and_time(self):
        preview = answer()
        paper = self.open(preview)
        header = self.header()
        self.assertIn("승인일시: 2026-11-18 03:06", header)
        self.assertNotIn("2026-11-17", header, "the UTC approval date leaked onto the paper")
        self.assertNotIn("UTC", paper)
        self.assertEqual("2026-11-18 03:06", self.worklist_cell(preview),
                         "the worklist Confirm cell is the reference the paper must equal")

    def test_the_paper_and_the_worklist_cell_agree_in_another_time_zone(self):
        preview = answer()
        self.open(preview, zone="America/New_York")
        cell = self.worklist_cell(preview)
        self.assertEqual("2026-11-17 13:06", cell)
        self.assertIn("승인일시: " + cell, self.header())

    def test_dicom_dates_print_as_year_month_day_everywhere_on_the_paper(self):
        self.open(answer())
        header, identity = self.header(), self.identity()
        self.assertIn("생년월일 1960-01-01", header)
        self.assertIn("· 2026-11-16 ·", header)
        self.assertIn("검사 2026-11-16", identity)
        for text in (header, identity):
            self.assertNotIn("19600101", text)
            self.assertNotIn("20261116", text)
        # The per-page footer is the identity string encoded into the @page rule.
        css = "".join("\\%x " % ord(c) for c in "검사 2026-11-16")
        self.assertIn(css, self.page.evaluate("ui.srcdoc()"))

    def test_the_writer_is_the_name_the_version_was_signed_under_else_its_stored_login(self):
        # After a rename the server still sends the name the version was signed under; a version that kept none prints
        # the login it stored, as is (no name looked up now).
        self.open(answer(author="syn-reader@example.test", authorName="SYN Kim Reader", repDoc="SYN Kim Reader"))
        self.assertIn("작성자: SYN Kim Reader · 승인 판독의: SYN Kim Reader", self.header())
        self.page.close()
        self.open(answer(author="syn-reader@example.test", repDoc="syn-reader"))
        self.assertIn("작성자: syn-reader@example.test ·", self.header())

    def test_the_printed_popup_is_the_previewed_paper(self):
        paper = self.open(answer())
        self.assertFalse(self.page.evaluate("ui.printDisabled()"), "this Chromium cannot print page identity")
        with self.page.expect_popup() as popup:
            self.page.evaluate("ui.print()")
        self.page.wait_for_function("() => ui.printCalls() === 1")
        written = self.page.evaluate("ui.written()")
        if not popup.value.is_closed():
            popup.value.close()
        self.assertEqual([paper], written)

    def test_an_approval_without_a_kept_time_prints_the_stored_date(self):
        preview = answer(approvedAt=None)
        self.open(preview)
        self.assertTrue(self.header().endswith("승인일시: 2026-11-17"), self.header())
        self.assertEqual("2026-11-17", self.worklist_cell(preview))

    def test_an_unreadable_approval_time_falls_back_and_never_prints_invalid_date(self):
        preview = answer(approvedAt="not-a-time")
        paper = self.open(preview)
        self.assertIn("승인일시: 2026-11-17", self.header())
        self.assertNotIn("Invalid", paper)
        self.assertNotIn("NaN", paper)

    def test_an_unapproved_report_prints_no_approval_time(self):
        preview = answer(rs="T", approvedAt=None)
        self.open(preview)
        self.assertIn("승인일시: -", self.header())
        self.assertEqual("", self.worklist_cell(preview))

    def test_an_addendum_keeps_the_first_approval_time(self):
        # The server moves `confirm` to the addendum's UTC date and keeps approvedAt (report-commit.ts).
        preview = answer(action="addendum", confirm="2026-11-18")
        self.open(preview)
        header = self.header()
        self.assertIn("승인된 추가기재", header)
        self.assertIn("승인일시: 2026-11-18 03:06", header)
        self.assertEqual("2026-11-18 03:06", self.worklist_cell(preview))

    def test_the_current_editing_text_prints_no_approval_time(self):
        before = self.open(answer())
        self.page.evaluate("ui.setSource('editor')")
        self.page.wait_for_function("prev => ui.srcdoc().length > 0 && ui.srcdoc() !== prev", arg=before)
        self.assertIn("승인일시: -", self.header())

    def test_a_study_without_dates_keeps_the_unknown_words(self):
        preview = answer()
        preview["study"].update({"birth": "", "date": ""})
        paper = self.open(preview)
        header = self.header()
        self.assertIn("생년월일 미확인", header)
        self.assertIn("날짜 미확인", header)
        self.assertIn("검사 -", self.identity())
        self.assertNotIn("Invalid", paper)
        self.assertNotIn("NaN", paper)

    def test_a_date_already_in_human_form_is_left_as_it_came(self):
        preview = answer()
        preview["study"].update({"birth": "1960-01-01", "date": "2026-11-16"})
        self.open(preview)
        header = self.header()
        self.assertIn("생년월일 1960-01-01", header)
        self.assertIn("· 2026-11-16 ·", header)

    def test_a_citation_time_prints_by_the_same_rule(self):
        self.open(answer(), cite=base.ok([base.entry()]))
        section = self.page.evaluate("ui.section()")
        self.assertIn("2026-09-19 14:00", section)
        self.assertNotIn("UTC", section)


if __name__ == "__main__":
    unittest.main()
