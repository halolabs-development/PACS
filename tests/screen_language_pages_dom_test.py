"""The other documents and the screen language.

The clinician, administration, audit and sign-in pages load the glossary and translator and follow the choice the work
page last applied in this browser, English only, for that same sign-in: with English their own fixed words read in English,
with Korean, no choice, a choice another sign-in left or no sign-in (the sign-in page) they stay exactly as they are. The
viewer document carries the translator in config/ohif.js and follows the reading-screen choice of the sign-in it is handed.
"""
import unittest
from pathlib import Path
from urllib.parse import urlsplit

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
ASSETS = ROOT / "worklist-v0/hpacs-lite"
BASE = "https://synthetic.test"
LANGUAGE = {"worklist-language.js", "worklist-language-terms.js"}
PAGES = [("clinician.html", "clinician"), ("admin.html", "admin"), ("audit.html", "radiologist"),
         ("index.html?auth_error=login_failed", None)]
# What a reader sees: text and title-like attributes with Hangul (data-marked places excluded).
SNAPSHOT = r"""() => { const H = /[가-힣]/, out = [];
  const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n = walk.nextNode(); n; n = walk.nextNode()) out.push(n.data);
  for (const el of document.querySelectorAll('[title],[aria-label],[placeholder],[alt]'))
    for (const a of ['title','aria-label','placeholder','alt']) if (el.hasAttribute(a)) out.push('@' + a + ' ' + el.getAttribute(a));
  return {all: out, korean: out.filter(t => H.test(t)).length}; }"""


class ScreenLanguagePages(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.pw = sync_playwright().start()
        cls.browser = cls.pw.chromium.launch()

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.pw.stop()

    def open(self, name, role, stored, session="S1"):
        context = self.browser.new_context()
        self.addCleanup(context.close)
        reads = []

        def serve(route):
            path = urlsplit(route.request.url).path
            file = Path(path).name
            reads.append(file)
            if path == "/viewer":
                return route.fulfill(content_type="text/html", body='<meta charset="utf-8"><script src="/config.js"></script>'
                    '<script>config.extensions.find(e=>e.id==="kin.session-boundary")'
                    '.preRegistration().then(()=>window.started=true)</script>')
            if path == "/frame":
                # The reading screen around the integrated viewer: its work context answers the sign-in.
                return route.fulfill(content_type="text/html", body='<script>window.KinWorkContext={session:()=>"S1",'
                                     'state:()=>"active"}</script><iframe id="viewer" src="/viewer"></iframe>')
            if path == "/config.js":
                return route.fulfill(path=ROOT / "config/ohif.js", content_type="application/javascript; charset=utf-8")
            if path.startswith("/worklist/hpacs-lite/") and (ASSETS / file).is_file():
                return route.fulfill(path=ASSETS / file)
            if path == "/api/emr-audit/intake-context" and getattr(self, "scope_denied", False):
                return route.fulfill(status=403, json={"code": "AuditScopeNotGranted", "message": "SYN scope"})
            if path == "/api/me" and role:
                return route.fulfill(json={"sub": "syn", "user": "SYN", "institution": "SYN",
                                           "kind": "member", "sessionId": "S1", "roles": [role]})
            return route.fulfill(status=401 if path == "/api/me" else 404, json={})
        context.route("**/*", lambda route, request: serve(route))
        page = context.new_page()
        errors = []
        page.on("pageerror", lambda e: errors.append(str(e)))
        self.addCleanup(lambda: self.assertEqual([], errors))
        if stored:
            page.add_init_script("localStorage.setItem('kin-language:v1', JSON.stringify("
                                 "{version:1, worklist:'%s', reading:'%s', session:'%s'}))" % (stored, stored, session))
        if name == "viewer":
            # The opening page hands the viewer its sign-in in the window name (viewer-launch.js / clinician.js).
            # Only on the first entry: a reload has no hand-off and takes the entry the viewer recorded.
            page.add_init_script("if (location.pathname === '/viewer' && !sessionStorage.getItem('syn-handed')) {"
                                 " sessionStorage.setItem('syn-handed', '1');"
                                 " window.name = 'kin-viewer-entry:' + JSON.stringify({session: 'S1', name: ''}); }")
        page.goto(BASE + ("/" + name if name in ("viewer", "frame") else "/worklist/hpacs-lite/" + name))
        if name == "viewer":
            page.wait_for_function("window.started")
        elif name != "frame":
            self.assertIn("auth.js", reads)
            page.wait_for_timeout(800)
        return page, reads

    def test_the_viewer_carries_the_translator_and_leaves_its_page_alone(self):
        # The glossary and translator are shared sources of config/ohif.js (no separate load); the viewer mark makes the
        # translator leave OHIF's page alone (nothing registered, nothing stored) and follow the reading-screen choice.
        page, reads = self.open("viewer", "radiologist", "en")
        self.assertFalse(LANGUAGE.intersection(reads))
        self.assertEqual("viewer", page.evaluate("window.KinLanguageDocument"))
        self.assertEqual("en", page.evaluate("window.KinLanguage.lang(document.body)"))
        self.assertFalse(page.evaluate("document.documentElement.hasAttribute('data-kin-lang-worklist') || document.documentElement.hasAttribute('data-kin-lang-reading')"))
        self.assertEqual('{"version":1,"worklist":"en","reading":"en","session":"S1"}', page.evaluate("localStorage.getItem('kin-language:v1')"))
        # Reloaded, the viewer takes the sign-in it recorded, as its session rule does: still English.
        for _ in range(2):
            page.reload()
            page.wait_for_function("window.started")
            self.assertEqual("en", page.evaluate("window.KinLanguage.lang(document.body)"))
        # English another sign-in left in this browser: the viewer keeps its words as written.
        page, _ = self.open("viewer", "radiologist", "en", session="S0")
        self.assertIsNone(page.evaluate("window.KinLanguage.lang(document.body)"))

    def test_the_integrated_viewer_follows_the_sign_in_of_the_reading_screen_around_it(self):
        # No hand-off and no recorded entry: the viewer frame inside the reading screen takes that page's sign-in.
        for session, lang in (("S1", "en"), ("S0", None)):
            with self.subTest(stored_for=session):
                page, _ = self.open("frame", "radiologist", "en", session=session)
                page.wait_for_function("document.getElementById('viewer').contentWindow.started")
                self.assertEqual(lang, page.evaluate("document.getElementById('viewer').contentWindow.KinLanguage.lang(document.getElementById('viewer').contentDocument.body)"))

    def test_pages_follow_english_and_stay_as_they_are_otherwise(self):
        for name, role in PAGES:
            with self.subTest(page=name):
                page, reads = self.open(name, role, None)
                self.assertTrue(LANGUAGE.issubset(reads))
                plain = page.evaluate(SNAPSHOT)
                self.assertGreater(plain["korean"], 0)
                # Korean, no choice, or English another sign-in left: the page exactly as it is.
                for stored, session in (("ko", "S1"), ("en", "S0")):
                    page, _ = self.open(name, role, stored, session)
                    self.assertEqual(plain["all"], page.evaluate(SNAPSHOT)["all"])
                    self.assertIsNone(page.evaluate("KinLanguage.lang(document.body)"))
                # English of this sign-in: fewer Korean words; the page never writes the choice. The sign-in page has no
                # sign-in, so it follows nothing.
                page, _ = self.open(name, role, "en")
                if role is None:
                    self.assertEqual(plain["all"], page.evaluate(SNAPSHOT)["all"])
                    continue
                self.assertLess(page.evaluate(SNAPSHOT)["korean"], plain["korean"])
                self.assertEqual("en", page.evaluate("KinLanguage.lang(document.body)"))
                page.evaluate("KinLanguage.restore({version:1, worklist:null, reading:null})")
                self.assertEqual('{"version":1,"worklist":"en","reading":"en","session":"S1"}', page.evaluate("localStorage.getItem('kin-language:v1')"))

    def test_an_auditor_without_the_disclosure_scope_is_told_so_in_english(self):
        # The copy and rights workspaces close with their reasons; both are the page's sentences.
        self.scope_denied = True
        self.addCleanup(lambda: setattr(self, "scope_denied", False))
        rights, copies = "#audit-rights-message", "#audit-disclosure-message"
        page, _ = self.open("audit.html", "auditor", "en")
        page.wait_for_function("document.querySelector('#audit-rights-message')?.textContent")
        self.assertEqual("This account does not have permission to handle correction, deletion, or processing suspension requests.",
                         page.locator(rights).text_content())
        self.assertEqual("This account does not have permission to issue medical record copies.", page.locator(copies).text_content())
        page, _ = self.open("audit.html", "auditor", "ko")
        page.wait_for_function("document.querySelector('#audit-rights-message')?.textContent")
        self.assertEqual("이 계정에는 정정·삭제·처리정지 요구 처리 권한이 없습니다.", page.locator(rights).text_content())

    def test_an_administration_sentence_reads_in_english(self):
        page, _ = self.open("admin.html", "admin", "en")
        self.assertEqual("No rules. All studies are sent to HALO PACS only.",
                         page.locator("#gateway-rules-empty").text_content().strip())
        page, _ = self.open("admin.html", "admin", "ko")
        self.assertEqual("규칙이 없습니다. 모든 검사를 HALO PACS로만 보냅니다.",
                         page.locator("#gateway-rules-empty").text_content().strip())


if __name__ == "__main__":
    unittest.main()
