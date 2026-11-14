"""Screen language (Korean / English) of the worklist and reading screens on the served work page.

The real main.html and its scripts are served; only HTTP answers are synthetic (study_panel_page_dom_test.WorkspaceSite),
with an account appearance that keeps revisions like the server. Every assertion reads what a reader sees, the
stored account value or the browser dialog text.
"""
import copy
import json
import re
import sys
import unittest
from pathlib import Path

from playwright.sync_api import expect, sync_playwright

sys.path.insert(0, str(Path(__file__).resolve().parent))
import study_panel_page_dom_test as dom  # noqa: E402
from study_panel_page_dom_test import RASTER, WorkspaceSite, auth, wait_startup  # noqa: E402

KO_BOTH = {"version": 1, "worklist": "ko", "reading": "ko"}
NONE = {"version": 1, "worklist": None, "reading": None}
# The page words a reader sees on each screen, and their Korean (the glossary).
WORKLIST = {"#m-reading": ("Reading Workspace", "판독 작업 공간"), "#m-refresh": ("↻ Refresh", "↻ 새로 고침")}
READING = {"#b-approve": ("Approve", "승인"), "#b-save": ("Save", "저장"), "#b-unread": ("Reset to Unread", "미판독으로 되돌리기"),
           "#b-approve-next": ("Approve & Next", "승인 후 다음")}
HEAD = "#heads th"


class WithFilters:
    """The bootstrap answer the harness decides, with the account's saved filters in it."""

    def __init__(self, route, filters):
        self._route, self._filters = route, filters

    def __getattr__(self, name):
        return getattr(self._route, name)

    def fulfill(self, **kwargs):
        if isinstance(kwargs.get("json"), dict):
            kwargs["json"] = {**kwargs["json"], "filters": self._filters}
        return self._route.fulfill(**kwargs)


class LanguageSite(WorkspaceSite):
    """The account appearance row (version, revision, CAS), as api/src/pacs/preferences.ts keeps it."""

    def __init__(self):
        super().__init__()
        self.appearance, self.appearance_revision, self.appearance_writes = None, 0, []
        self.fail_write = None
        self.filters = []

    def api(self, route, request, method, path, query):
        if method == "GET" and path in ("/api/bootstrap", "/api/filter-folders") and self.filters:
            route = WithFilters(route, self.filters)
        if path != "/api/reading-appearance":
            return super().api(route, request, method, path, query)
        account, refused = self.authenticate(request)
        if refused:
            return self.refuse(route, *refused)
        owner = [auth.INSTITUTION, account["sub"]]
        if method == "PUT":
            body = request.post_data_json
            self.appearance_writes.append(copy.deepcopy(body))
            if self.fail_write:
                return route.fulfill(status=self.fail_write, json={"message": "SYN write refused"})
            if body["expectedOwner"] != owner or body["revision"] != self.appearance_revision:
                return route.fulfill(status=409, json={"message": "계정 설정이 변경되었습니다. 불러온 뒤 다시 저장하세요"})
            sizes = body["sizes"]
            if sizes.get("version") != 12 or set(sizes["language"]) != {"version", "worklist", "reading"}:
                return route.fulfill(status=400, json={"message": "글자 설정 형식을 확인하세요"})
            self.appearance, self.appearance_revision = copy.deepcopy(sizes), self.appearance_revision + 1
        return route.fulfill(json={"owner": owner, "revision": self.appearance_revision, "sizes": self.appearance})


class WorklistLanguageDOM(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.pw = sync_playwright().start()
        cls.browser = cls.pw.chromium.launch(args=RASTER)

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.pw.stop()

    def setUp(self):
        self.site = LanguageSite()
        self.context = self.browser.new_context(viewport={"width": 1920, "height": 1080})
        self.context.route("**/*", lambda route, request: self.site.handle(route, request))
        self.page = self.context.new_page()
        self.errors, self.dialogs = [], []
        self.page.on("pageerror", lambda e: self.errors.append(str(e)))
        self.page.on("dialog", self.answer)

    def answer(self, dialog):
        self.dialogs.append(dialog.message)
        dialog.dismiss()

    def tearDown(self):
        self.context.close()
        self.assertEqual([], self.errors)
        self.assertEqual([], self.site.violations)

    def boot(self, filters=None, page=None):
        page = page or self.page
        if filters is not None:
            self.site.filters = filters
        page.goto(auth.MAIN_URL)
        expect(page.locator("#rows")).to_contain_text(auth.PATIENT)
        wait_startup(page, self.site)
        # A study opened in the reading screen, so the report buttons are on screen.
        page.locator("#rows tr").first.click()
        expect(page.locator("#b-approve")).to_be_visible()

    def apply(self, lang, worklist=True, reading=True):
        dialog = self.choose(lang, worklist, reading)
        dialog.locator("#language-apply").click()
        expect(dialog).to_be_hidden()

    def unused_base_sizes(self):
        # The page writes its own complete display value the first time; a stored row needs the same shape.
        return json.loads(self.page.evaluate("() => null") or "null") or {
            "list": 12, "current": 12, "prior": 12,
            "fonts": {"version": 1, "list": "default", "current": "default", "prior": "default"},
            "colors": {"version": 1, "list": "default", "current": "default", "prior": "default"},
            "dock": {"version": 2, "placement": "bottom", "panel": -1, "autoHide": False},
            "viewer": {"version": 3, **{role: {"size": 12, "font": "default", "color": "default", "name": True, "date": True, "description": True,
                                                "position": "top-left", "fieldPositions": {"name": "top-left", "date": "top-left", "description": "top-left"},
                                                "overrides": {}} for role in ("current", "prior")}},
            "toolbar": {"version": 1, "order": ["MeasurementTools", "Zoom", "Pan", "TrackballRotate", "WindowLevel", "Capture", "Layout", "Crosshairs", "MoreTools"], "hidden": []},
            "mpr": {"version": 1, "progressive": False, "display": {k: True for k in ("autoHideCrosshair", "cube", "demographics", "orientation", "sample", "scale", "thickness", "windowing", "zoom")},
                    "mouse": {"left": "WindowLevel", "middle": "Pan", "right": "Zoom"}, "sync": {"windowing": True, "zoom": False}},
            "markers": {"version": 2, "color": "default", "width": "standard", "line": "default", "arrowheads": "on", "font": "default"}}

    def expect_words(self, words, lang):
        for selector, pair in words.items():
            expect(self.page.locator(selector).first).to_have_text(pair[0] if lang == "en" else pair[1])

    def head(self, name):
        return self.page.locator(HEAD).filter(has_text=name)

    def choose(self, lang, worklist=True, reading=True):
        self.page.locator("#language-open").click()
        dialog = self.page.locator("#language-dialog")
        expect(dialog).to_be_visible()
        dialog.locator("#language-" + lang).check()
        for scope, on in (("worklist", worklist), ("reading", reading)):
            box = dialog.locator("#language-scope-" + scope)
            box.check() if on else box.uncheck()
        return dialog

    def test_korean_on_both_screens_changes_labels_not_data_and_revert_restores_the_mixed_screen(self):
        self.boot()
        page = self.page
        mark = page.locator("#language-label")
        title = mark.get_attribute("title")
        self.assertEqual("EN", mark.inner_text().strip())
        self.assertTrue(page.evaluate("() => document.querySelector('#language-open').compareDocumentPosition(document.querySelector('#language-label')) & Node.DOCUMENT_POSITION_FOLLOWING"))
        dialog = self.choose("ko")
        # The example changes; the page behind it does not until Apply.
        expect(dialog.locator("#language-sample")).to_contain_text("미판독")
        expect(dialog.locator("#language-sample")).to_contain_text("KIM MINJUN")
        self.expect_words(WORKLIST, "en")
        dialog.locator("#language-apply").click()
        expect(dialog).to_be_hidden()
        self.assertEqual(KO_BOTH, self.site.appearance["language"])
        self.expect_words(WORKLIST, "ko")
        self.expect_words(READING, "ko")
        heads = [h.strip() for h in page.locator(HEAD).all_inner_texts()]
        self.assertIn("판독", heads)
        self.assertNotIn("RS", heads)
        expect(page.locator("#rows")).to_contain_text(auth.PATIENT)
        expect(page.locator("#rows")).to_contain_text("SYN CT CHEST")
        expect(page.locator("#language-applied")).to_contain_text("Revert")
        self.assertEqual("ko", page.evaluate("document.documentElement.lang"))
        self.assertEqual("KO", mark.inner_text().strip())
        page.locator("#language-revert").click()
        expect(page.locator("#language-applied")).to_be_hidden()
        self.assertEqual(NONE, self.site.appearance["language"])
        self.expect_words(WORKLIST, "en")
        self.expect_words(READING, "en")
        self.assertEqual(("EN", title), (mark.inner_text().strip(), mark.get_attribute("title")))

    def test_one_screen_only(self):
        self.boot()
        self.choose("ko", worklist=False).locator("#language-apply").click()
        expect(self.page.locator("#language-dialog")).to_be_hidden()
        self.expect_words(READING, "ko")
        self.expect_words(WORKLIST, "en")
        self.assertEqual({"version": 1, "worklist": None, "reading": "ko"}, self.site.appearance["language"])
        self.assertEqual("— · KO", self.page.locator("#language-label").inner_text().strip())

    def test_the_account_choice_comes_back_on_another_start(self):
        self.boot()
        self.apply("ko", reading=False)
        self.apply("en", worklist=False)
        self.assertEqual({"version": 1, "worklist": "ko", "reading": "en"}, self.site.appearance["language"])
        writes = len(self.site.appearance_writes)
        # Another PC: a new browser with nothing kept locally.
        other = self.browser.new_context(viewport={"width": 1920, "height": 1080})
        try:
            other.route("**/*", lambda route, request: self.site.handle(route, request))
            page = other.new_page()
            page.on("pageerror", lambda e: self.errors.append(str(e)))
            self.boot(page=page)
            for selector, (en, ko) in WORKLIST.items():
                expect(page.locator(selector).first).to_have_text(ko)
            for selector, (en, ko) in READING.items():
                expect(page.locator(selector).first).to_have_text(en)
            # English on the reading screen covers its explanations too.
            expect(page.locator("#b-addendum")).not_to_have_attribute("title", re.compile("[가-힣]"))
            expect(page.locator("#language-applied")).to_have_count(0)
            self.assertEqual(writes, len(self.site.appearance_writes), "starting the page writes nothing")
        finally:
            other.close()

    def test_a_refused_or_conflicting_save_is_not_shown_as_done(self):
        self.boot()
        for status in (409, 503):
            self.site.fail_write = status
            dialog = self.choose("ko")
            dialog.locator("#language-apply").click()
            expect(dialog.locator("#language-dialog-status")).not_to_have_text("")
            expect(dialog.locator("#language-dialog-status")).not_to_have_text("언어 설정을 저장하는 중…")
            self.expect_words(WORKLIST, "en")
            self.expect_words(READING, "en")
            expect(self.page.locator("#language-applied")).to_have_count(0)
            dialog.locator("#language-close").click()
        self.assertIsNone(self.site.appearance)

    def test_a_saved_filter_named_like_a_label_stays_as_named(self):
        self.boot(filters=[{"id": "SYN-F-1", "name": "Unread", "f": {}, "sk": None, "sd": 0, "isDefault": False},
                           {"id": "SYN-F-2", "name": "Approve", "f": {}, "sk": None, "sd": 0, "isDefault": False}])
        chips = self.page.locator("#chips button[data-i]")
        expect(chips).to_have_count(2)
        self.choose("ko").locator("#language-apply").click()
        self.expect_words(WORKLIST, "ko")
        expect(chips.nth(0)).to_contain_text("Unread")
        expect(chips.nth(1)).to_contain_text("Approve")

    def test_words_the_page_writes_while_translated_are_the_ones_revert_shows(self):
        self.boot()
        self.choose("ko").locator("#language-apply").click()
        self.expect_words(READING, "ko")
        # The page changes a label while the screen is Korean (as a status update would): Korean now, and that
        # new label — not the old one — after Revert.
        self.page.evaluate("() => { document.querySelector('#b-save').textContent = 'Approve'; }")
        expect(self.page.locator("#b-save")).to_have_text("승인")
        self.page.locator("#language-revert").click()
        expect(self.page.locator("#b-save")).to_have_text("Approve")

    def test_browser_dialogs_and_errors_follow_the_language(self):
        self.boot()
        self.apply("en")
        self.page.locator("#rows tr").first.click()
        self.page.evaluate("() => window.confirm('계정 설정이 변경되었습니다. 불러온 뒤 다시 저장하세요')")
        self.assertEqual(1, len(self.dialogs))
        self.assertNotRegex(self.dialogs[0], "[가-힣]")
        toast = self.page.locator("#toast")
        self.page.evaluate("() => { const t = document.querySelector('#toast'); t.className = 'show err'; t.textContent = '서버 저장 실패: 계정 설정이 변경되었습니다. 불러온 뒤 다시 저장하세요'; }")
        expect(toast).not_to_contain_text("서버")
        # An error with no English text yet: the general sentence and the original words.
        self.page.evaluate("() => { const t = document.querySelector('#toast'); t.className = 'show err'; t.textContent = '서버 저장 실패: SYN 알 수 없는 오류'; }")
        expect(toast).to_contain_text("SYN 알 수 없는 오류")
        expect(toast).to_contain_text("Original")

    def test_the_pop_out_window_follows_the_reading_screen(self):
        self.boot()
        self.apply("ko", worklist=False)
        self.page.locator("#report-popout").click()
        for _ in range(250):
            if len(self.context.pages) == 2:
                break
            self.page.wait_for_timeout(20)
        self.assertEqual(2, len(self.context.pages), "the pop-up window")
        pip = self.context.pages[1]
        expect(pip.locator("#findings")).to_be_visible()
        # The moved editor keeps its words; the words the window draws itself are in the reading screen language too.
        expect(pip.locator("#b-save")).to_have_text("저장")
        expect(pip.get_by_role("button", name="고정: 끔")).to_be_visible()
        self.page.locator("#language-revert").click()
        expect(pip.locator("#b-save")).to_have_text("Save")
        expect(pip.get_by_role("button", name="Pin: Off")).to_be_visible()

    def test_an_account_that_never_chose_keeps_the_page_as_it_is(self):
        self.boot()
        page = self.page
        self.expect_words(WORKLIST, "en")
        self.expect_words(READING, "en")
        expect(page.locator("#b-addendum")).to_have_attribute("title", re.compile("[가-힣]"))
        self.assertIsNone(page.evaluate("document.documentElement.getAttribute('data-kin-lang-worklist')"))
        self.assertEqual([], self.site.appearance_writes)


if __name__ == "__main__":
    unittest.main()
