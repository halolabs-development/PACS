"""Screen language on the real stack: Korean on both screens, a real signed approval through the Korean buttons, Revert; then
English, with a known server error in English and an unknown one as the general English sentence and its original words.

Real BFF, API, database and signing, one synthetic study. The language is kept in the account appearance (version 12) and
comes back on the next start; the page cases (one screen only, another PC, data and names, dialogs) are in
tests/worklist_language_dom_test.py and the stored form in tests/worklist_language_service_test.cjs.

Run in CI: `python tests/measurement_ci.py --profile screen-language` (Focused integration, dispatch only); on a development
stack: `python tests/e2e/test_worklist_language.py`.
"""
from __future__ import annotations

import re
import sys
import unittest
import uuid

from playwright.sync_api import expect

from invariants_live import psql
import test_worklist as base

FINDINGS = "SYN SCREEN LANGUAGE FINDINGS"


def literal(value):
    return "'" + str(value).replace("'", "''") + "'"


class WorklistLanguageE2E(base.WorklistE2E):
    def setUp(self):
        super().setUp()
        self.addCleanup(self.forget_language)

    def forget_language(self):
        # The run leaves no screen language on its accounts (a failed case must not leave the next one in Korean).
        for sub in self.stack.user_ids.values():
            psql(f'DELETE FROM "ReadingAppearance" WHERE "subject"={literal(sub)}')

    def choose(self, page, lang):
        page.locator("#language-open").click()
        dialog = page.locator("#language-dialog")
        expect(dialog).to_be_visible()
        dialog.locator("#language-" + lang).check()
        expect(dialog.locator("#language-scope-worklist")).to_be_checked()
        expect(dialog.locator("#language-scope-reading")).to_be_checked()
        with page.expect_response(lambda r: r.request.method == "PUT" and r.url.endswith("/api/reading-appearance")) as saved:
            dialog.locator("#language-apply").click()
        self.assertEqual(saved.value.status, 200, saved.value.text()[:300])
        expect(dialog).to_be_hidden()
        return saved.value.json()["sizes"]["language"]

    def open_study(self, page, fixture):
        page.locator('#filterrow [data-f="id"]').fill(fixture.patient_id)
        row = page.locator(f'#rows tr[data-uid="{fixture.uid}"]')
        row.click()
        expect(row).to_have_class(re.compile(r"\bsel\b"))
        expect(page.locator("#findings")).to_be_editable()
        return row

    def test_language_01_korean_buttons_approve_the_same_and_revert(self):
        patient = "LANG-" + uuid.uuid4().hex[:12]
        fixture = self.fixture(patient_id=patient)
        page = self.login()
        self.assertEqual({"version": 1, "worklist": "ko", "reading": "ko"}, self.choose(page, "ko"))
        expect(page.locator("#m-reading")).to_have_text("판독 작업 공간")
        expect(page.locator("#b-approve")).to_have_text("승인")
        self.open_study(page, fixture)
        expect(page.locator(f'#rows tr[data-uid="{fixture.uid}"]')).to_contain_text(patient)
        with page.expect_response(lambda r: r.request.method == "PUT" and r.url.endswith(f"/studies/{fixture.uid}/report")
                                  and FINDINGS in (r.request.post_data or ""), timeout=45000) as typed:
            page.locator("#findings").fill(FINDINGS)
        self.assertEqual(typed.value.status, 200)
        # The Korean Approve is the same button: one signed approval.
        with page.expect_response(lambda r: r.request.method == "POST" and r.url.endswith(f"/studies/{fixture.uid}/report/commit")) as reply:
            page.get_by_role("button", name="승인", exact=True).click()
        self.assertEqual(reply.value.status, 201, reply.value.text()[:300])
        version = self.versions(fixture)[-1]
        self.assertEqual((version["action"], version["findings"]), ("approve", FINDINGS))
        # Revert: the account is back to no choice and the page to its own words.
        with page.expect_response(lambda r: r.request.method == "PUT" and r.url.endswith("/api/reading-appearance")) as reverted:
            page.locator("#language-revert").click()
        self.assertEqual(reverted.value.json()["sizes"]["language"], {"version": 1, "worklist": None, "reading": None})
        expect(page.locator("#m-reading")).to_have_text("Reading Workspace")
        expect(page.locator("#language-applied")).to_be_hidden()

    def test_language_02_english_errors_known_and_unknown(self):
        fixture = self.fixture(patient_id="LANG-" + uuid.uuid4().hex[:12])
        page = self.login()
        self.choose(page, "en")
        # The next start brings the account choice back.
        page.reload()
        expect(page.locator("#language-label")).to_have_text("EN")
        self.open_study(page, fixture)
        history = f"**/api/studies/{fixture.uid}/report/versions"
        # A known server sentence comes in English; an unknown one as the general English sentence and its original words.
        for message, shown in (("계정 설정이 변경되었습니다. 불러온 뒤 다시 저장하세요", None), ("SYN 처음 보는 서버 오류", "SYN 처음 보는 서버 오류")):
            page.route(history, lambda route, request, m=message: route.fulfill(status=409, json={"message": m}))
            self.open_toolbar_group(page, "#b-history")
            page.locator("#b-history").click()
            box = page.locator("#hist-body [data-kin-error]")
            expect(box).to_be_visible()
            if shown is None:
                expect(box).not_to_contain_text(re.compile("[가-힣]"))
            if shown:
                expect(box).to_contain_text(shown)
                expect(box).to_contain_text("Original")
            page.locator("#hist-close").click()
            page.unroute(history)


def load_tests(loader, tests, pattern):
    return unittest.TestSuite(WorklistLanguageE2E(name) for name in loader.getTestCaseNames(WorklistLanguageE2E)
                              if name.startswith('test_language_'))


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    unittest.main(verbosity=2)
