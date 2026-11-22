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
import language_data_probe as probe  # noqa: E402
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
        self.planter = None  # language_data_probe.Planter: answers carry planted data
        self.lost = {}  # uid -> exam kind: the list server's mark for an exam whose originals cannot all be read now

    def list_body(self, account, rename=None):
        body = super().list_body(account, rename)
        for row in body["studies"]:
            if row["uid"] in self.lost:
                row.update(examUnavailable=True, examUnavailableKind=self.lost[row["uid"]])
        return body

    def api(self, route, request, method, path, query):
        if self.planter is not None and path != "/api/reading-appearance":
            route = self.planter.wrap(route)
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

    def test_a_dialog_opened_from_either_screen_reads_in_the_language_of_that_screen(self):
        """Tech Note opens from the list (its row chip) and from the reading screen: its words follow the screen it was
        opened from, whichever language the other screen has."""
        self.boot()
        page = self.page
        page.route("**/api/studies/*/tech-note", lambda r: r.fulfill(json={"uid": auth.UID, "writable": True, "note": None}))
        guidance = page.locator("#tech-note-dialog > p").first
        words = {"en": "Stored separately from the report and original images.", "ko": "판독문·원본 영상과 별도로 저장됩니다."}

        def from_reading():
            button = page.locator("#tech-note-open")
            button.dispatch_event("pointerdown")
            button.dispatch_event("click")

        def from_list():
            page.locator('[data-tab="Technician"]').click()
            chip = page.locator("#rows [data-tech-note]").first
            chip.click()
            page.locator('[data-tab="Radiology"]').dispatch_event("click")

        def by_itself_for_reading():
            # The reading workspace opening the note by itself (its automatic opening): the last pointer was on the list.
            page.locator('[data-tab="Technician"]').dispatch_event("pointerdown")
            page.evaluate("() => KinLanguage.opensOn('reading', () => document.getElementById('tech-note-open').click())")

        for worklist, reading in (("en", "ko"), ("ko", "en")):
            page.evaluate("([w, r]) => KinLanguage.restore({version: 1, worklist: w, reading: r})", [worklist, reading])
            for opened, lang in ((from_reading, reading), (from_list, worklist), (by_itself_for_reading, reading)):
                with self.subTest(worklist=worklist, reading=reading, opened=opened.__name__):
                    opened()
                    expect(page.locator("#tech-note-dialog")).to_be_visible()
                    expect(guidance).to_contain_text(words[lang])
                    page.locator("#tech-note-close").click()
                    expect(page.locator("#tech-note-dialog")).to_be_hidden()

    def test_the_reason_an_exam_cannot_be_read_whole_reads_in_the_language_of_its_screen(self):
        """A merged exam whose originals cannot all be read now: the list's badge (Technician) gives its reason in the list's
        language, also when the reading screen in English was the last touched."""
        self.site.second_study, self.site.lost = True, {auth.UID_B: "merge"}
        self.boot()
        page = self.page
        ko = re.compile("^합친 검사의 원본 일부를 볼 수 없어")
        en = "Some originals of this merged exam cannot be read, so it is not opened or preloaded. An original is missing from the image archive or this account cannot see it. Refresh the list."
        self.apply("en")
        page.locator('[data-tab="Technician"]').click()
        badge = page.locator(f"#rows tr[data-uid='{auth.UID_B}'] td.acc .exam-merged-unavailable")
        expect(badge).to_have_attribute("title", en)
        # A Korean list beside an English reading screen: the badge stays Korean after the reading screen was touched and the
        # list painted again.
        page.evaluate("() => KinLanguage.restore({version: 1, worklist: 'ko', reading: 'en'})")
        expect(badge).to_have_attribute("title", ko)
        badge.evaluate("b => { b.dataset.synPainted = 'before'; }")
        page.locator("#b-approve").dispatch_event("pointerdown")
        page.locator("#m-refresh").dispatch_event("click")
        expect(badge).not_to_have_attribute("data-syn-painted", "before")
        expect(badge).to_have_attribute("title", ko)

    def test_a_known_server_sentence_in_an_error_place_follows_the_screen_and_another_stays_as_written(self):
        """History's error place: a server message that is a known sentence of the glossary reads in English on an English
        screen; any other message keeps its words and follows the general English sentence; Korean or no choice show the
        message exactly as the server gave it."""
        self.boot()
        page = self.page
        known, other, plain = "계정 설정이 변경되었습니다. 불러온 뒤 다시 저장하세요", "SYN 처음 보는 서버 오류", "Not Found"
        box = page.locator("#hist-body [data-kin-error]")
        for lang in (None, "ko", "en"):
            if lang:
                page.evaluate("l => KinLanguage.restore({version: 1, worklist: l, reading: l})", lang)
            for message in (known, other, plain):
                with self.subTest(lang=lang, message=message):
                    page.route("**/report/versions*", lambda route, request, m=message: route.fulfill(status=409, json={"message": m}))
                    page.locator("#b-history").dispatch_event("click")
                    expect(box).to_be_visible()
                    if lang == "en" and message == known:
                        expect(box).to_have_text("Account settings have changed. Load them, then save again")
                    elif lang == "en":
                        expect(box).to_have_text("The request could not be processed. Original message: " + message)
                    else:
                        expect(box).to_have_text(message)
                    page.locator("#hist-close").dispatch_event("click")
                    page.unroute("**/report/versions*")

    def test_the_applied_choice_is_kept_in_the_browser_for_the_other_pages(self):
        self.boot()
        stored = "localStorage.getItem('kin-language:v1')"
        session = self.page.evaluate("KinAuth.sessionId()")
        self.assertTrue(session)
        # Kept with the sign-in it was applied in, so another account's documents never follow it.
        self.assertIn(json.loads(self.page.evaluate(stored) or "null"), (None, {**NONE, "session": session}))
        self.apply("en")
        self.assertEqual({"version": 1, "worklist": "en", "reading": "en", "session": session}, json.loads(self.page.evaluate(stored)))
        self.page.locator("#language-revert").click()
        expect(self.page.locator("#language-applied")).to_be_hidden()
        self.assertEqual({**NONE, "session": session}, json.loads(self.page.evaluate(stored)))

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

    def test_an_ordinary_overwrite_revokes_the_previous_text_and_attribute(self):
        self.boot()
        self.apply("ko")
        self.page.evaluate("""() => {
          const save = document.querySelector('#b-save');
          KinLanguage.write(save, KinLanguage.say('Approve'), 'title');
          save.title = save.title;
          save.firstChild.data = save.firstChild.data;
          const approve = document.querySelector('#b-approve');
          KinLanguage.write(approve, KinLanguage.say('Approve'));
          KinLanguage.write(approve, approve.textContent);
          KinLanguage.restore({version:1,worklist:'en',reading:'en'});
        }""")
        expect(self.page.locator('#b-save')).to_have_text('저장')
        expect(self.page.locator('#b-save')).to_have_attribute('title', '승인')
        expect(self.page.locator('#b-approve')).to_have_text('승인')
        self.page.locator('#language-revert').click()
        expect(self.page.locator('#b-save')).to_have_text('저장')

    def test_unchanged_inbox_reads_leave_both_live_regions_quiet(self):
        self.page.clock.install()
        self.boot()
        counts = self.page.evaluate_handle("""() => {
          const counts = {};
          for (const id of ['cvr-inbox-badge', 'cvr-inbox-status']) {
            counts[id] = 0;
            new MutationObserver(changes => counts[id] += changes.length)
              .observe(document.getElementById(id), {childList: true, characterData: true, subtree: true});
          }
          return counts;
        }""")
        for _ in range(2):
            with self.page.expect_response("**/api/critical-results?view=received&state=pending") as read:
                self.page.clock.fast_forward(60_000)
            self.assertTrue(read.value.ok)
            self.assertEqual(0, read.value.json()["pending"])
        self.page.clock.fast_forward(10_000)
        self.assertEqual({"cvr-inbox-badge": 0, "cvr-inbox-status": 0}, counts.json_value())

    def test_browser_dialogs_and_errors_follow_the_language(self):
        self.boot()
        self.apply("en")
        self.page.evaluate("""() => {
          window.confirm('승인');
          window.confirm(KinLanguage.say('검사를 선택하세요.'));
          const error = KinLanguage.say('서버 저장 실패: {e0}', '검사를 선택하세요.');
          KinLanguage.write(document.querySelector('#toast'), error);
        }""")
        self.assertEqual(['승인', 'Select a study.'], self.dialogs)
        expect(self.page.locator('#toast')).to_have_text('Server save failed: 검사를 선택하세요.')

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

    def test_surviving_initial_labels_follow_both_languages(self):
        script = dom.ROOT / "worklist-v0/hpacs-lite/worklist-language.js"
        capture = """{ const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
          window.initialLabels = [];
          for (let n = walk.nextNode(); n; n = walk.nextNode()) {
            if (n.data.trim() && !n.parentElement.closest('script,style,textarea,option:not([value]),[translate=no],[contenteditable]'))
              initialLabels.push([n, n.data]);
          }
        }"""
        self.page.route("**/worklist-language.js*", lambda r: r.fulfill(
            content_type="application/javascript", body=capture + script.read_text(encoding="utf-8")))
        self.boot()
        # Subsequent ordinary writes to the same node belong to the renderer.
        self.page.evaluate("initialLabels = initialLabels.filter(([n, raw]) => n.isConnected && n.data === raw)")
        pairs = {}
        for source, other, *meta in probe.glossary():
            same = meta[1] if len(meta) > 1 and meta[1] else source
            pairs[source] = (other, same) if re.search("[가-힣]", source) else (same, other)
        for lang in ("en", "ko"):
            self.apply(lang)
            words = self.page.evaluate("initialLabels.filter(([n]) => n.isConnected).map(([n, raw]) => [raw,n.data])")
            matched = 0
            for raw, displayed in words:
                key = " ".join(raw.split())
                if key in pairs:
                    self.assertEqual(pairs[key][lang == "ko"], " ".join(displayed.split()), key)
                    matched += 1
            self.assertGreater(matched, 0)

    def test_nested_ordinary_attribute_write_revokes_ownership_during_repaint(self):
        self.boot()
        self.page.evaluate("""() => {
          const title = document.createElement('button');
          title.id = 'overwrite-title'; document.body.append(title);
          customElements.define('language-test-trigger', class extends HTMLElement {
            static get observedAttributes() { return ['title']; }
            attributeChangedCallback(_, old) { if (old !== null) title.title = '승인'; }
          });
          const trigger = document.createElement('language-test-trigger'); document.body.append(trigger);
          KinLanguage.write(trigger, KinLanguage.say('검사를 선택하세요.'), 'title');
          KinLanguage.write(title, KinLanguage.say('검사를 선택하세요.'), 'title');
        }""")
        for lang in ("en", "ko"):
            self.apply(lang)
            expect(self.page.locator("#overwrite-title")).to_have_attribute("title", "승인")

    def test_authored_controls_and_plain_data_on_the_same_screen(self):
        self.boot()
        # Replace one authored cell with a fresh ordinary text node containing exactly the label
        # of a neighbouring control. Only the control follows Apply, including on the return trip.
        cell = self.page.locator("#rows tr").first.locator("td").last
        cell.evaluate("el => el.replaceChildren(document.createTextNode('Approve'))")
        for lang in ("ko", "en", "ko"):
            self.apply(lang)
            self.expect_words(WORKLIST, lang)
            self.expect_words(READING, lang)
            expect(cell).to_have_text("Approve")

    def test_viewer_title_and_parent_study_labels_keep_their_values(self):
        row = self.site.study_row
        self.site.study_row = lambda *a, **kw: {**row(*a, **kw), "desc": "승인"}
        self.boot()
        self.page.route("**/ohif/viewer?**", lambda r: r.fulfill(
            content_type="text/html", body="<title>Viewer</title><script>window.frameElement.title='승인'</script>"))
        self.page.locator("#m-reading").click()
        frame = self.page.locator("#reading-frame")
        expect(frame).to_be_attached()
        # The same-origin viewer publishes its identity to the parent's iframe title.
        expect(frame).to_have_attribute("title", "승인")
        for lang in ("en", "ko"):
            self.page.evaluate("l => KinLanguage.restore({version:1,worklist:l,reading:l})", lang)
            expect(frame).to_have_attribute("title", "승인")
            expect(self.page.locator("#reading-target")).to_contain_text("승인")
            expect(self.page.locator("#rows tr").first).to_contain_text("승인")

    def test_finished_strings_are_never_used_as_templates(self):
        self.boot()
        for raw in ("취소 사유: A  B\nC", "단축어: {1} · Modality: CT · Bodypart: Chest",
                    "단축어: a · Modality: b · Modality: c · Bodypart: d"):
            self.assertEqual(raw, self.page.evaluate("t => KinLanguage.tr(t, 'en')", raw))

    def drawn(self, planter, lang):
        """The work page drawn from the harness answers (planted or not) in lang: the worklist, a study on the reading
        screen, a refresh, the Pop Out window, the language chosen again. Every word met, and the glossary readings of
        the planted values."""
        site, context, kept = LanguageSite(), self.browser.new_context(viewport={"width": 1920, "height": 1080}), self.page
        site.planter, dialogs, seen = planter, [], []
        try:
            context.route("**/*", lambda route, request: site.handle(route, request))
            page = self.page = context.new_page()
            page.on("pageerror", lambda e: self.errors.append(str(e)))
            page.on("dialog", lambda d: (dialogs.append(d.message), d.dismiss()))
            page.goto(auth.MAIN_URL)
            expect(page.locator("#rows tr").first).to_be_visible()
            wait_startup(page, site)
            self.apply(lang)
            seen += probe.snapshot(page)
            page.locator("#rows tr").first.click()
            expect(page.locator("#b-approve")).to_be_visible()
            page.wait_for_timeout(300)
            seen += probe.snapshot(page)
            page.locator("#m-refresh").click()
            page.wait_for_timeout(500)
            seen += probe.snapshot(page)
            page.locator("#report-popout").click()
            for _ in range(250):
                if len(context.pages) == 2:
                    break
                page.wait_for_timeout(20)
            self.assertEqual(2, len(context.pages), "the Pop Out window opens")
            if len(context.pages) == 2:
                pip = context.pages[1]
                pip.wait_for_load_state()
                pip.wait_for_timeout(300)
                seen += probe.snapshot(pip)
                pip.close()
            self.apply("ko" if lang == "en" else "en")
            self.apply(lang)
            page.wait_for_timeout(300)
            seen += probe.snapshot(page, dialogs)
            values = planter.planted() if planter else []
            return seen, values, probe.translations(values, lang)
        finally:
            self.page = kept
            context.close()

    def test_data_is_shown_as_written_on_both_screens_in_english_and_in_korean(self):
        """Displayed values of the synthetic answers replaced with glossary words, sentences and filled templates (English
        screen) or English page words (Korean screen): no planted value shows as its translation anywhere."""
        korean, english = probe.pools()
        for lang, pool in (("en", korean), ("ko", english)):
            with self.subTest(lang=lang):
                plain, _, _ = self.drawn(None, lang)
                planter = probe.Planter(pool)
                planted, values, shown = self.drawn(planter, lang)
                found, reached = probe.check(plain, planted, values, shown, planter)
                self.assertEqual([], found)
                self.assertGreater(len(reached), 2, "planted data reaches the screens")

    def test_finding_fields_and_citation_source_keep_the_authors_words(self):
        from report_text_boundaries_dom_test import FINDING
        finding = copy.deepcopy(FINDING)
        finding["item"].update(schemaVersion=3, title="승인", text="취소", lesionLocation="없음", characteristics="Unread")
        finding["item"]["sources"][0]["label"] = "승인"
        self.page.route("**/api/studies/*/findings?**", lambda r: r.fulfill(
            json={"items": [finding], "nextCursor": None}, headers={"X-KIN-Finding-Schema": "4"}))
        self.boot()
        self.page.locator("#reading-findings-open").click()
        row = self.page.locator("#reading-findings-list article").first
        expect(row).to_be_visible()
        for lang in ("en", "ko"):
            self.page.evaluate("l => KinLanguage.restore({version:1,worklist:l,reading:l})", lang)
            expect(row.locator("strong").first).to_have_text("승인")
            expect(row.locator(".reading-findings-text")).to_have_text("취소")
            self.assertTrue(row.locator("[data-kin-lesion-location]").inner_text().endswith(": 없음"))
            self.assertTrue(row.locator("[data-kin-characteristics]").inner_text().endswith(": Unread"))
        self.page.evaluate("KinLanguage.restore({version:1,worklist:'en',reading:'en'})")
        row.get_by_role("button", name="Insert into Report").first.click()
        target = self.page.locator("#cite-preview-target")
        for lang in ("en", "ko", None):
            self.page.evaluate("l => KinLanguage.restore({version:1,worklist:l,reading:l})", lang)
            expect(self.page.locator("#cite-preview-source")).to_contain_text("승인")
            lines = target.inner_text().splitlines()
            if lang == "en":
                self.assertEqual(1, len(lines))
                self.assertTrue(lines[0].startswith("Insert target: " + auth.PATIENT))
            else:
                self.assertEqual(2, len(lines))
                self.assertTrue(lines[0].startswith("삽입 대상: " + auth.PATIENT))
                self.assertIn("SYN CT CHEST", lines[1])

    def test_a_measurement_goes_into_the_report_as_written_and_reads_in_english_on_the_screen(self):
        """Include Measurements: the value text and the report's measurement line are the same bytes in every screen
        language; the screen that draws the value (valueSay) says it in its own language."""
        self.boot()
        script = r"""() => {
          const L = kinFindingLinkModel, C = kinFindingCommand, R = KinReportCitation;
          const sources = [{kind:'circle', calculator:'kin-circle-v1:detector:hu', values:[10.04, 79.2, 40, 2.5, 1, 80, 64]},
            {kind:'spineCobb', calculator:'kin-spinecobb-v1:right:ermf', values:[-12.3]},
            {kind:'length', calculator:'kin-mg-length-v1:pixel', values:[3.21]},
            {kind:'ellipse', calculator:'bogus', values:[1, 2]}];
          return sources.map(s => { const m = C.measurementOf(s);
            return {type: typeof m.value, value: m.value, line: R.measurementLine([{...m, series: 1, image: 2}]),
              screen: String(L.valueSay(s.kind, s.calculator, s.values, 'server-copy'))}; });
        }"""
        seen = {}
        for lang in ("en", "ko", None):
            self.page.evaluate("l => KinLanguage.restore({version:1,worklist:l,reading:l})", lang)
            seen[lang] = self.page.evaluate(script)
        written = [{k: row[k] for k in ("type", "value", "line")} for row in seen[None]]
        for lang in ("en", "ko"):
            self.assertEqual(written, [{k: row[k] for k in ("type", "value", "line")} for row in seen[lang]])
        self.assertEqual({"string"}, {row["type"] for row in written})
        self.assertIn("지름 10.0 mm · 면적 79.2 mm²", written[0]["value"])
        self.assertIn("검출기 기준", written[0]["value"])
        self.assertTrue(written[0]["line"].startswith("측정: Circle by Diameter 지름 10.0 mm"))
        for lang in ("ko", None):
            self.assertEqual([row["value"] for row in written], [row["screen"] for row in seen[lang]])
        english = [row["screen"] for row in seen["en"]]
        self.assertTrue(english[0].startswith("Diameter 10.0 mm · Area 79.2 mm² · Mean 40.0 HU"), english[0])
        self.assertIn("detector-based", english[0])
        for text in english:
            self.assertIsNone(re.search("[가-힣]", text), text)

    def test_the_report_paper_is_the_same_in_every_language_and_its_dialog_follows_the_screen(self):
        """The report output: the paper (the preview frame and the print window) prints as written in every screen language;
        the dialog around it reads in the reading screen's language."""
        self.boot()
        self.page.route("**/api/studies/*/report-preview", lambda r: r.fulfill(json={
            "study": {"uid": auth.UID}, "report": {"version": 0}, "canPreviewEditor": False, "keys": []}))
        papers, titles = {}, {}
        for lang in (None, "ko", "en"):
            self.page.evaluate("l => KinLanguage.restore({version:1,worklist:l,reading:l})", lang)
            self.page.locator("#b-print").dispatch_event("click")
            self.page.wait_for_function("() => (document.querySelector('#report-preview iframe')?.srcdoc || '').includes('</html>')")
            papers[lang] = self.page.evaluate("() => document.querySelector('#report-preview iframe').srcdoc")
            titles[lang] = self.page.locator("#report-preview-title").inner_text()
            self.page.locator("#report-preview").press("Escape")
            expect(self.page.locator("#report-preview")).to_be_hidden()
        self.assertIn("HALO PACS 판독문", papers[None])
        self.assertEqual(papers[None], papers["ko"])
        self.assertEqual(papers[None], papers["en"])
        self.assertEqual(titles[None], titles["ko"])
        self.assertNotEqual(titles[None], titles["en"])
        self.assertIsNone(re.search("[가-힣]", titles["en"]), titles["en"])

    def test_the_report_output_dialog_opened_from_an_english_reading_screen_reads_in_english_throughout(self):
        """English on the reading screen only: the output dialog opened from it has its title, buttons and later status in
        English alike (it takes the screen it is opened from)."""
        self.boot()
        self.page.route("**/api/studies/*/report-preview", lambda r: r.fulfill(json={
            "study": {"uid": auth.UID}, "report": {"version": 0}, "canPreviewEditor": False, "keys": []}))
        self.page.evaluate("KinLanguage.restore({version:1,worklist:null,reading:'en'})")
        # The pointer on the reading screen (the menu that holds Print) marks it as the screen in use.
        self.page.locator("#reading-bar").dispatch_event("pointerdown")
        self.page.locator("#b-print").dispatch_event("click")
        dialog = self.page.locator("#report-preview")
        expect(dialog).to_be_visible()
        self.page.wait_for_function("() => (document.querySelector('#report-preview iframe')?.srcdoc || '').includes('</html>')")
        for text in (self.page.locator("#report-preview-title").inner_text(),
                     dialog.get_by_role("button").filter(has_text=re.compile("PDF")).first.inner_text()):
            self.assertIsNone(re.search("[가-힣]", text), text)
        self.assertEqual("reading", dialog.get_attribute("data-kin-lang-region"))

    def test_key_image_title_and_tech_note_keep_the_authors_words(self):
        self.boot()
        self.page.route("**/api/studies/*/report-preview", lambda r: r.fulfill(json={
            "study": {"uid": auth.UID}, "report": {"version": 0}, "canPreviewEditor": False,
            "keys": [{"id": "SYN-KEY", "item": {"title": "승인", "frame": 1}}]}))
        self.page.locator("#b-print").dispatch_event("click")
        key = self.page.locator("#report-preview input[type=checkbox]").first
        expect(key).to_be_visible()
        for lang in ("ko", "en"):
            self.page.evaluate("l => KinLanguage.restore({version:1,worklist:l,reading:l})", lang)
            expect(key).to_have_attribute("aria-label", "승인")
            expect(key.locator("..")).to_contain_text("승인")
        self.page.locator("#report-preview").press("Escape")
        self.page.route("**/api/studies/*/tech-note", lambda r: r.fulfill(json={
            "uid": auth.UID, "writable": True, "note": {"studyUid": auth.UID, "version": 1,
            "text": "취소", "reason": "", "author": auth.RAD["actor"], "createdAt": "2026-10-05T00:00:00Z",
            "attemptId": None, "isOwnAttempt": False}}))
        self.page.locator("#tech-note-open").dispatch_event("click")
        for lang in ("ko", "en"):
            self.page.evaluate("l => KinLanguage.restore({version:1,worklist:l,reading:l})", lang)
            expect(self.page.locator("#tech-note-text")).to_have_value("취소")

    def test_dicom_identity_notes_joined_by_the_page_read_in_english(self):
        """The DICOM Identity line's note after a failed observation is the page's sentences joined: in English each is
        read (the reading screen's tooltip shows no Korean)."""
        self.boot()
        self.apply("en")
        title = self.page.evaluate("""() => { const M = KinStudyIdentity, v = M.view(M.failed(M.start()), 'SYN-UID', {});
          return KinLanguage.tr(v.summary.title, 'en'); }""")
        self.assertIn("HALO PACS", title)
        self.assertIsNone(re.search("[가-힣]", title), title)
    def test_words_the_page_joins_are_its_sentences_and_data_in_them_stays(self):
        self.boot()
        result = self.page.evaluate(r"""() => {
          const {tr, say} = KinLanguage;
          const message = '이 검사의 질문을 불러오지 못했습니다.';
          return [tr(say('{t0} — Show Questions', say(message)), 'en'),
            tr(say('{t0} — Show Questions', {t:message}), 'en'),
            tr(say('{t0}\n{e1}', say('지금 확인할 수 없습니다'), {e:'승인'}), 'en'),
            tr(say('취소 사유: {0}', message), 'en')];
        }""")
        self.assertEqual(['Could not load questions for this study. — Show Questions',
                          '이 검사의 질문을 불러오지 못했습니다. — Show Questions',
                          'Cannot check right now\n승인', 'Cancellation reason: 이 검사의 질문을 불러오지 못했습니다.'], result)

    def test_sentences_built_with_their_parts_translate_the_words_and_keep_the_data(self):
        self.boot()
        run = lambda script, *args: self.page.evaluate(script, list(args))
        say = "([t, p, l]) => KinLanguage.tr(KinLanguage.say(t, ...p), l)"
        # Spaces and line breaks at the start of a data part stay.
        tr = "([t, l]) => KinLanguage.tr(t, l)"
        self.assertEqual("Cancellation reason:   A  B\nC", run(say, "취소 사유: {0}", ["  A  B\nC"], "en"))
        self.assertEqual("Cancellation reason: \nA", run(say, "취소 사유: {0}", ["\nA"], "en"))
        # A named part is data: an institution named like a label stays as named.
        title = "원격판독 수신 권한으로 읽은 값입니다 · 소유 기관 {institutionName}. 원격판독이 닫히면 더 읽을 수 없습니다."
        shown = run(say, title, [{"institutionName": "Unread"}], "en")
        self.assertIn("Unread", shown)
        self.assertNotRegex(shown, "[가-힣]")
        # Parts next to each other are given, not guessed: words translated, data as it is.
        self.assertEqual("2 new studies arrived: SYN", run(say, "새 검사 {n0}건이 도착했습니다: {1}{t2}", [2, "SYN", {"t": ""}], "en").strip())
        both = self.page.evaluate("() => { const {say, tr} = KinLanguage; return tr(say('{t0} · {t1}', say('Unread'), say('Approved')), 'ko'); }")
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
          KinLanguage.write(ui, KinLanguage.say('{t0}', KinLanguage.say('Unread')));
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
          return [tr(say('{t0} v{n1}', say('Approve'), 3), 'ko'),
            tr(say('{t0} v{n1}', say('Addendum'), 2), 'ko'),
            tr(say('DICOM Identity{t0}{t1}{t2}', say(' · Patient Mismatch'), {t:''}, {t:''}), 'ko')];
        }""")
        self.assertEqual(['승인 v3', '추가 기재 v2', 'DICOM 식별 정보 · 환자 불일치'], result)

    def test_logout_preservation_list_keeps_two_lines_and_translates_the_failure_reasons(self):
        self.boot()
        display = declarations('work-exit.js', ['showLogoutPanel', 'LOGOUT_TITLES', 'LOGOUT_NOTES', 'LOGOUT_FAILED'])
        self.page.evaluate("() => { const {write:kinWrite, say:kinSay}=KinLanguage; " + display + """
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
        page.evaluate("() => document.querySelector('#page-size').setCustomValidity(KinLanguage.say('계정 설정이 변경되었습니다. 불러온 뒤 다시 저장하세요'))")
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
        page.evaluate("() => window.prompt(KinLanguage.say('검사를 선택하세요.'), 'Unread')")
        self.assertEqual([("Select a study.", "Unread")], values)

    def test_raw_validity_overwrites_an_equal_registered_message(self):
        self.boot()
        self.apply('en')
        self.page.evaluate("""() => {
          const field = document.querySelector('#page-size');
          field.setCustomValidity(KinLanguage.say('검사를 선택하세요.'));
          field.setCustomValidity(field.validationMessage);
        }""")
        self.apply('ko')
        self.assertEqual('Select a study.', self.page.locator('#page-size').evaluate('el => el.validationMessage'))

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
        self.page.evaluate("() => window.alert(KinLanguage.say('검사를 선택하세요.'))")
        self.assertTrue(self.dialogs and not re.search("[가-힣]", self.dialogs[-1]), self.dialogs)

    def test_an_account_that_never_chose_keeps_the_page_as_it_is(self):
        self.boot()
        page = self.page
        self.expect_words(WORKLIST, "en")
        self.expect_words(READING, "en")
        expect(page.locator("#b-addendum")).to_have_attribute("title", re.compile("[가-힣]"))
        self.assertIsNone(page.evaluate("document.documentElement.getAttribute('data-kin-lang-worklist')"))
        self.assertEqual([], self.site.appearance_writes)

    def test_words_the_worklist_writes_after_start_follow_both_languages(self):
        """The words the page writes after its start (connection line, filter summary and filter row, folders, search
        line, related exam filter, storage, empty list) follow the chosen language, also when written again later."""
        self.boot()
        page = self.page
        name = page.locator('#filterrow input[data-f="name"]')
        folders = page.locator("#worklist-folders nav")
        texts = {"#dbstat": ("DB Connected", "DB 연결됨"), "#filterlist": ("Filter : -", "필터 : -"),
                 "#storage": ("Storage Unobservable", "저장량 관측 불가"),
                 "#worklist-folders [id$='-shortcut']": ("My Shortcuts", "내 바로가기"),
                 "#worklist-folders [id$='-modality']": ("Modality", "장비"),
                 "#worklist-folders [id$='-search']": ("Saved Searches", "저장 검색"),
                 "#related-modality option[value='']": ("All Modalities", "모든 장비")}
        line = {"en": ("Search Mode", "Search", "Clear Results on Clear"), "ko": ("검색 방식", "검색", "지우기 시 결과도 비우기")}
        for lang in ("ko", "en", "ko"):
            self.apply(lang)
            # Written again after the choice: the list is drawn anew, the connection line comes back after a refresh.
            page.locator("#m-refresh").click()
            expect(page.locator("#rows")).to_contain_text(auth.PATIENT)
            for selector, pair in texts.items():
                expect(page.locator(selector).first).to_contain_text(pair[lang == "ko"])
            expect(folders).to_have_attribute("aria-label", "Folders" if lang == "en" else "폴더")
            expect(page.locator("#worklist-folders li > button").first).to_contain_text("All Studies (" if lang == "en" else "전체 검사 (")
            # The filter row's names are English words put on the write path late: a Korean screen keeps them as written.
            expect(name).to_have_attribute("aria-label", "Name Filter")
            expect(page.locator("#related-modality")).to_have_attribute("title", texts["#related-modality option[value='']"][lang == "ko"])
            bar = page.locator("#toolbar-filters")
            for word in line[lang]:
                expect(bar).to_contain_text(word)
            if lang == "ko":
                expect(bar).not_to_contain_text("Search Mode")
            name.fill("SYN-NO-SUCH-PATIENT")
            expect(page.locator("#rows td.empty")).to_have_text("No records found" if lang == "en" else "검색 결과가 없습니다")
            name.fill("")
            expect(page.locator("#rows")).to_contain_text(auth.PATIENT)


if __name__ == "__main__":
    unittest.main()
