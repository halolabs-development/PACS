"""Screen language (Korean / English) of the worklist and reading screens on the served work page.

The real main.html and its scripts are served; only HTTP answers are synthetic (study_panel_page_dom_test.WorkspaceSite),
with an account appearance that keeps revisions like the server. Every assertion reads what a reader sees, the
stored account value or the browser dialog text.
"""
import copy
import json
import re
import subprocess
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


def declarations(file, names):
    """Run the shipped display function with synthetic state, using the installed JS parser to load it."""
    script = r"""const fs=require('fs'), ts=require('./api/node_modules/typescript');
      const source=ts.createSourceFile(process.argv[1],fs.readFileSync(process.argv[1],'utf8'),ts.ScriptTarget.Latest,true);
      const names=new Set(JSON.parse(process.argv[2])), found=[];
      for(const node of source.statements) {
        if(ts.isFunctionDeclaration(node) && names.has(node.name.text)) found.push(node.getText(source));
        if(ts.isVariableStatement(node) && node.declarationList.declarations.some(d=>names.has(d.name.getText(source)))) found.push(node.getText(source));
      }
      if(found.length!==names.size) throw Error('Missing display declarations');
      process.stdout.write(found.join('\n'));"""
    return subprocess.check_output(['node', '-e', script, str(dom.ROOT / 'worklist-v0/hpacs-lite' / file), json.dumps(names)],
                                   cwd=dom.ROOT).decode('utf-8')


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
        self.clinical_fixture = None

    def api(self, route, request, method, path, query):
        if method == "GET" and path in ("/api/bootstrap", "/api/filter-folders") and self.filters:
            route = WithFilters(route, self.filters)
        if method == 'GET' and path.endswith('/clinical-context') and self.clinical_fixture:
            answer = copy.deepcopy(self.clinical_fixture)
            answer['uid'] = path.split('/')[-2]
            return route.fulfill(json=answer)
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
        self.assertEqual("ko", page.evaluate("document.documentElement.getAttribute('data-kin-lang-worklist')"))
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

    def visible_words(self, lang):
        """Visible words of the other language on the page (data and names people give are excluded where they are
        drawn); product names, codes and the synthetic data of this site are not words to translate."""
        return self.page.evaluate("""lang => { const out = new Set();
          const keep = /\\b(HALO PACS|PACS|DICOM|Gateway|HTTP|[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+|HL7|EMR|PDF|CSV|JPG|PNG|SR|CT|MR|CR|DX|US|MG|XA|PT|NM|SC|OT|AE|UID|ID|W\\/L|Ctrl|Alt|Shift|Enter|Esc|Tab|Space|Home|End|SYN[\\w-]*|KIM MINJUN|Brain CT|Language|English|Korean)\\b/g;
          const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
          for (let n = walk.nextNode(); n; n = walk.nextNode()) {
            const el = n.parentElement, text = n.nodeValue.trim();
            if (!text || !el || el.closest('script,style,textarea,[translate="no"],[contenteditable="true"],#language-dialog,#language-applied')) continue;
            const box = el.getBoundingClientRect();
            if (!box.width || !box.height || box.bottom < 0 || box.top > innerHeight || getComputedStyle(el).visibility === 'hidden') continue;
            // An error with no text in this language yet: the general sentence, then the original words on purpose.
            if (/(The request could not be processed\\. Original message:|요청을 처리하지 못했습니다\\. 원문:)/.test(text)) continue;
            const bare = text.replace(keep, '');
            // Korean: no English word of three letters or more is left, even beside Korean words (a mixed line counts).
            if (lang === 'ko' ? /[A-Za-z]{3,}/.test(bare) : /[\\uac00-\\ud7a3]/.test(bare)) out.add(text.slice(0, 80));
          }
          return [...out].sort(); }""", lang)

    def test_no_visible_word_is_left_in_the_other_language(self):
        """The screen as a reader sees it after Apply: no label left in English on the Korean screen, no Korean
        explanation left on the English one (the static check names the file and line; this one the screen)."""
        self.boot()
        self.apply("ko")
        self.assertEqual([], self.visible_words("ko"))
        self.apply("en")
        self.assertEqual([], self.visible_words("en"))

    def test_template_parts_go_in_once_as_written_and_two_readings_are_not_translated(self):
        self.boot()
        tr = lambda text, lang: self.page.evaluate("([t, l]) => KinLanguage.tr(t, l)", [text, lang])
        # The data part keeps its own spaces and line breaks; a part that reads like a slot is never filled again.
        self.assertEqual("Cancellation reason: A  B\nC", tr("취소 사유: A  B\nC", "en"))
        shown = tr("단축어: {1} · Modality: CT · Bodypart: Chest", "en")
        self.assertIn("{1}", shown)
        self.assertNotIn("단축어", shown)
        # A part that holds the fixed words of its own template has two readings: left as the page wrote it.
        twice = "단축어: a · Modality: b · Modality: c · Bodypart: d"
        self.assertEqual(twice, tr(twice, "en"))

    def test_sentences_built_with_their_parts_translate_the_words_and_keep_the_data(self):
        self.boot()
        run = lambda script, *args: self.page.evaluate(script, list(args))
        say = "([t, p, l]) => KinLanguage.tr(KinLanguage.say(t, ...p), l)"
        # Spaces and line breaks at the start of a data part stay.
        tr = "([t, l]) => KinLanguage.tr(t, l)"
        self.assertEqual("Cancellation reason:   A  B\nC", run(tr, "취소 사유:   A  B\nC", "en"))
        self.assertEqual("Cancellation reason: \nA", run(tr, "취소 사유: \nA", "en"))
        # A named part is data: an institution named like a label stays as named.
        title = "원격판독 수신 권한으로 읽은 값입니다 · 소유 기관 {institutionName}. 원격판독이 닫히면 더 읽을 수 없습니다."
        shown = run(say, title, [{"institutionName": "Unread"}], "en")
        self.assertIn("Unread", shown)
        self.assertNotRegex(shown, "[가-힣]")
        # Parts next to each other are given, not guessed: words translated, data as it is.
        self.assertEqual("2 new studies arrived: SYN", run(say, "새 검사 {n0}건이 도착했습니다: {1}{t2}", [2, "SYN", {"t": ""}], "en").strip())
        both = run(say, "{t0} · {t1}", [{"t": "Unread"}, {"t": "Approved"}], "ko")
        self.assertEqual("미판독 · 승인됨", both)
        # A number keeps its sign; an English plural ending has no place in Korean.
        self.assertIn("-1920", run(say, "Display {n0} · {1}, {2} · {3} × {4}", [2, -1920, 0, 1920, 1080], "ko"))
        attach = run(say, "Attach {n0} File{t1}", [2, {"t": "s"}], "ko")
        self.assertIn("2", attach)
        self.assertNotIn("s", attach.replace(" ", ""))

    def test_a_stored_row_in_an_older_form_keeps_its_values_when_only_the_language_is_saved(self):
        def profile(size, color):
            return {"size": size, "font": "default", "color": color, "name": True, "date": True, "description": False}
        v4 = {"version": 4, "list": 14, "current": 16, "prior": 12,
              "fonts": {"version": 1, "list": "default", "current": "sans", "prior": "default"},
              "colors": {"version": 1, "list": "default", "current": "default", "prior": "warm"},
              "dock": {"version": 1, "placement": "top", "panel": 1},
              "viewer": {"version": 1, "current": profile(20, "white"), "prior": profile(12, "warm")}}
        self.site.appearance, self.site.appearance_revision = v4, 4
        self.boot()
        self.apply("ko", worklist=False)
        stored = self.site.appearance
        self.assertEqual((12, {"version": 1, "worklist": None, "reading": "ko"}), (stored["version"], stored["language"]))
        self.assertEqual((14, 16, 12, "sans"), (stored["list"], stored["current"], stored["prior"], stored["fonts"]["current"]))
        self.assertEqual(("top", 1), (stored["dock"]["placement"], stored["dock"]["panel"]))
        self.assertEqual((20, "white"), (stored["viewer"]["current"]["size"], stored["viewer"]["current"]["color"]))

    def test_sentence_keeps_data_spaces_in_text_attributes_and_browser_messages(self):
        self.boot()
        data = "  A  B\nC  "
        self.page.evaluate("""data => {
          const label = document.createElement('p'); label.id = 'sentence-data'; document.body.append(label);
          const message = KinLanguage.say('취소 사유: {0}', data);
          KinLanguage.write(label, message); KinLanguage.write(label, message, 'title');
          document.querySelector('#page-size').setCustomValidity(message);
          window.sentenceMessage = message;
        }""", data)
        for lang, prefix in (("en", "Cancellation reason: "), ("ko", "취소 사유: "), ("en", "Cancellation reason: ")):
            self.apply(lang)
            self.assertEqual(prefix + data, self.page.locator('#sentence-data').text_content())
            self.assertEqual(prefix + data, self.page.locator('#sentence-data').get_attribute('title'))
            self.assertEqual(prefix + data, self.page.evaluate("document.querySelector('#page-size').validationMessage"))
            for name in ('alert', 'confirm', 'prompt'):
                self.page.evaluate("name => window[name](window.sentenceMessage)", name)
                self.assertEqual(prefix + data, self.dialogs[-1])
        self.assertEqual('취소 사유: ' + data, self.page.evaluate("KinLanguage.source(document.querySelector('#sentence-data'))"))

    def test_sentence_survives_more_than_two_thousand_other_messages_and_equal_text(self):
        self.boot()
        self.page.evaluate("""() => {
          const first = document.createElement('p'); first.id = 'sentence-first'; document.body.append(first);
          KinLanguage.write(first, KinLanguage.say('영상 열람 · {0}{t1}', 'Unread', {t: ''}));
          for (let i = 0; i < 2001; i++) String(KinLanguage.say('{0} · {n1} image{t2}', 'SYN ' + i, i, {t: 's'}));
          const data = document.createElement('p'); data.id = 'sentence-equal-data'; document.body.append(data);
          const ui = document.createElement('p'); ui.id = 'sentence-equal-ui'; document.body.append(ui);
          KinLanguage.write(data, KinLanguage.say('{0}', 'Unread'));
          KinLanguage.write(ui, KinLanguage.say('{t0}', {t: 'Unread'}));
        }""")
        for lang in ('en', 'ko', 'en', 'ko'):
            self.apply(lang)
            self.assertEqual('Image viewing · Unread' if lang == 'en' else '영상 열람 · Unread', self.page.locator('#sentence-first').text_content())
            self.assertEqual('Unread', self.page.locator('#sentence-equal-data').text_content())
            self.assertEqual('미판독' if lang == 'ko' else 'Unread', self.page.locator('#sentence-equal-ui').text_content())
        # A later ordinary write replaces the old sentence, including after a language is cleared.
        self.page.evaluate("() => { document.querySelector('#sentence-first').textContent = 'Approve'; KinLanguage.restore({version:1,worklist:null,reading:null}); }")
        self.assertEqual('Approve', self.page.locator('#sentence-first').text_content())

    def test_nested_sentences_keep_line_breaks_and_translate_every_level(self):
        self.boot()
        result = self.page.evaluate(r"""() => {
          const {say, tr, write} = KinLanguage;
          let message = say('취소 사유: {0}', '  A  B\nC  ');
          for (let i = 0; i < 12; i++) message = say('{t0}', {t: message});
          const list = say('{t0}\n{t1}', {t: message}, {t: say('취소 사유: {0}', 'SYN second')});
          const box = document.createElement('p'); box.id = 'sentence-lines'; document.body.append(box);
          write(box, list);
          const cycle = {t: ''}, sentence = say('{t0}', cycle); cycle.t = sentence;
          return {en: tr(list, 'en'), ko: tr(list, 'ko'), cycle: tr(sentence, 'en')};
        }""")
        self.assertEqual('Cancellation reason:   A  B\nC  \nCancellation reason: SYN second', result['en'])
        self.assertEqual('취소 사유:   A  B\nC  \n취소 사유: SYN second', result['ko'])
        self.assertEqual('', result['cycle'])
        self.apply('en')
        self.assertEqual(result['en'], self.page.locator('#sentence-lines').text_content())
        self.apply('ko')
        self.assertEqual(result['ko'], self.page.locator('#sentence-lines').text_content())

    def test_clinical_context_actions_and_identity_warning_keep_all_ui_parts(self):
        self.boot()
        result = self.page.evaluate("""() => {
          const {say, tr} = KinLanguage;
          return [tr(say('{t0} v{n1}', {t:'Approve'}, 3), 'ko'),
            tr(say('{t0} v{n1}', {t:'Addendum'}, 2), 'ko'),
            tr(say('DICOM Identity{t0}{t1}{t2}', {t:' · Patient Mismatch'}, {t:''}, {t:''}), 'ko')];
        }""")
        self.assertEqual(['승인 v3', '추가 기재 v2', 'DICOM 식별 정보 · 환자 불일치'], result)

    def test_logout_preservation_list_keeps_two_lines_and_translates_the_failure_reasons(self):
        self.boot()
        display = declarations('work-exit.js', ['showLogoutPanel', 'LOGOUT_TITLES', 'LOGOUT_NOTES', 'LOGOUT_FAILED'])
        self.page.evaluate("() => { const kinWrite=KinLanguage.write; " + display + """
          const prep={state:'failed',reason:'refused',reports:[
            {uid:'1.2.3',label:'SYN first',safe:false,reason:'refused'},
            {uid:'1.2.4',label:'SYN second',safe:false,reason:'unknown'}]};
          showLogoutPanel(prep);
        }""")
        pending = self.page.locator('dialog.kin-logout p').nth(1)
        original = pending.text_content()
        self.assertEqual(1, original.count('\n'))
        self.assertEqual(1, pending.inner_text().count('\n'))
        self.page.evaluate("KinLanguage.restore({version:1,worklist:'en',reading:'en'})")
        expect(pending).not_to_contain_text(re.compile('[가-힣]'))
        translated = pending.text_content()
        self.assertEqual(1, translated.count('\n'))
        self.assertEqual(1, pending.inner_text().count('\n'))
        for text in ('SYN first (1.2.3)', 'SYN second (1.2.4)'):
            self.assertIn(text, translated)
        self.assertTrue(all(' — ' in line and len(line.split(' — ')[1]) > 10 for line in translated.split('\n')))
        self.page.evaluate("KinLanguage.restore({version:1,worklist:null,reading:null})")
        self.assertEqual(original, pending.text_content())

    def test_clinical_context_renders_actions_conflicts_and_original_data_after_switching(self):
        vectors = json.loads((dom.ROOT / 'tests/clinical_context_vectors.json').read_text(encoding='utf-8'))
        self.site.clinical_fixture = copy.deepcopy(vectors['answers']['valid']['A-CONFLICT-BIRTH'])
        self.site.clinical_fixture['sections']['requestTags'] = copy.deepcopy(vectors['answers']['valid']['A-PRESENT-OWNER']['sections']['requestTags'])
        self.site.clinical_fixture['sections']['requestTags']['items'][0]['value'] = '  A  B\nC  '
        self.boot()
        region = self.page.locator('#clinical-context')
        expect(region).to_contain_text('Approve v3')
        self.apply('ko')
        expect(region).to_contain_text('승인 v3')
        self.assertIn('  A  B\nC  ', region.text_content())
        self.apply('en')
        expect(region).to_contain_text('Approve v3')
        expect(self.page.locator('#clinical-context-conflict')).not_to_contain_text(re.compile('[가-힣]'))
        self.assertIn('  A  B\nC  ', region.text_content())

    def test_a_marker_choice_of_version_10_stays_when_only_the_language_is_saved(self):
        self.boot()
        self.apply("ko")
        v12 = self.site.appearance
        v10 = {k: v for k, v in v12.items() if k != "language"} | {"version": 10, "markers": {"version": 1, "color": "red", "width": "extra-thick"}}
        # Another client stored the row in version 10 since: a later language choice keeps that marker choice.
        self.site.appearance, self.site.appearance_revision = v10, self.site.appearance_revision + 1
        self.apply("en", reading=False)
        stored = self.site.appearance
        self.assertEqual(("red", "extra-thick", 12), (stored["markers"]["color"], stored["markers"]["width"], stored["version"]))
        self.assertEqual({"version": 1, "worklist": "en", "reading": None}, stored["language"], "the language of a row with none starts from none")

    def test_dialog_values_placeholders_validity_and_the_pop_out_follow_their_screen(self):
        self.boot()
        page = self.page
        field = page.locator("#findings")
        placeholder = field.get_attribute("placeholder")
        # A validity message the page set before any language was chosen follows the later choice.
        page.evaluate("() => document.querySelector('#page-size').setCustomValidity('계정 설정이 변경되었습니다. 불러온 뒤 다시 저장하세요')")
        self.apply("ko", worklist=False)
        if placeholder:
            expect(field).not_to_have_attribute("placeholder", placeholder)
        self.apply("en", reading=False)
        self.assertNotRegex(page.evaluate("() => document.querySelector('#page-size').validationMessage"), "[가-힣]")
        # The question of a prompt is translated; the value it offers is the reader's.
        values = []
        page.remove_listener("dialog", self.answer)
        page.on("dialog", lambda d: (values.append((d.message, d.default_value)), d.dismiss()))
        page.locator("#rows tr").first.click()
        page.evaluate("() => window.prompt('검사를 선택하세요.', 'Unread')")
        self.assertEqual([("Select a study.", "Unread")], values)

    def test_an_alert_started_in_the_pop_out_window_follows_the_reading_screen(self):
        self.boot()
        self.apply("en", worklist=False)
        self.page.locator("#report-popout").click()
        for _ in range(250):
            if len(self.context.pages) == 2:
                break
            self.page.wait_for_timeout(20)
        pip = self.context.pages[1]
        expect(pip.locator("#findings")).to_be_visible()
        pip.locator("#findings").click()
        self.page.evaluate("() => window.alert('검사를 선택하세요.')")
        self.assertTrue(self.dialogs and not re.search("[가-힣]", self.dialogs[-1]), self.dialogs)

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
