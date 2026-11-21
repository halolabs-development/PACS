"""The other documents and the screen language.

The clinician, administration, audit and sign-in pages load the glossary and translator and follow the choice the work
page last applied in this browser, English only: with English their own fixed words read in English, with Korean or no
choice they stay exactly as they are. The viewer document does not load the translator.
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

    def open(self, name, role, stored):
        context = self.browser.new_context()
        self.addCleanup(context.close)
        reads = []

        def serve(route):
            path = urlsplit(route.request.url).path
            file = Path(path).name
            reads.append(file)
            if path == "/viewer":
                return route.fulfill(content_type="text/html", body='<script src="/config.js"></script>'
                    '<script>config.extensions.find(e=>e.id==="kin.session-boundary")'
                    '.preRegistration().then(()=>window.started=true)</script>')
            if path == "/config.js":
                return route.fulfill(path=ROOT / "config/ohif.js", content_type="application/javascript")
            if path.startswith("/worklist/hpacs-lite/") and (ASSETS / file).is_file():
                return route.fulfill(path=ASSETS / file)
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
                                 "{version:1, worklist:'%s', reading:'%s'}))" % (stored, stored))
        page.goto(BASE + ("/viewer" if name == "viewer" else "/worklist/hpacs-lite/" + name))
        if name == "viewer":
            page.wait_for_function("window.started")
        else:
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
        self.assertEqual('{"version":1,"worklist":"en","reading":"en"}', page.evaluate("localStorage.getItem('kin-language:v1')"))

    def test_pages_follow_english_and_stay_as_they_are_otherwise(self):
        for name, role in PAGES:
            with self.subTest(page=name):
                page, reads = self.open(name, role, None)
                self.assertTrue(LANGUAGE.issubset(reads))
                plain = page.evaluate(SNAPSHOT)
                self.assertGreater(plain["korean"], 0)
                # Korean, or no choice: the page exactly as it is.
                page, _ = self.open(name, role, "ko")
                self.assertEqual(plain["all"], page.evaluate(SNAPSHOT)["all"])
                # English: fewer Korean words; the page never writes the choice.
                page, _ = self.open(name, role, "en")
                self.assertLess(page.evaluate(SNAPSHOT)["korean"], plain["korean"])
                self.assertEqual("en", page.evaluate("KinLanguage.lang(document.body)"))
                page.evaluate("KinLanguage.restore({version:1, worklist:null, reading:null})")
                self.assertEqual('{"version":1,"worklist":"en","reading":"en"}', page.evaluate("localStorage.getItem('kin-language:v1')"))

    def test_an_administration_sentence_reads_in_english(self):
        page, _ = self.open("admin.html", "admin", "en")
        self.assertEqual("No rules. All studies are sent to HALO PACS only.",
                         page.locator("#gateway-rules-empty").text_content().strip())
        page, _ = self.open("admin.html", "admin", "ko")
        self.assertEqual("규칙이 없습니다. 모든 검사를 HALO PACS로만 보냅니다.",
                         page.locator("#gateway-rules-empty").text_content().strip())


if __name__ == "__main__":
    unittest.main()
