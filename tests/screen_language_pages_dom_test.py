"""Only the work page loads the screen-language glossary and translator."""
import unittest
from pathlib import Path
from urllib.parse import urlsplit

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
ASSETS = ROOT / "worklist-v0/hpacs-lite"
BASE = "https://synthetic.test"
LANGUAGE = {"worklist-language.js", "worklist-language-terms.js"}


class ScreenLanguagePages(unittest.TestCase):
    def test_other_documents_do_not_load_the_translator(self):
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch()
            for name, role in [("clinician.html", "clinician"), ("admin.html", "admin"),
                               ("audit.html", "radiologist"), ("index.html?auth_error=login_failed", None),
                               ("viewer", "radiologist")]:
                with self.subTest(page=name):
                    context = browser.new_context()
                    try:
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
                        context.route("**/*", serve)
                        page = context.new_page()
                        page.add_init_script("localStorage.setItem('kin-language:v1', JSON.stringify("
                                             "{version:1, worklist:'en', reading:'en'}))")
                        page.goto(BASE + ("/viewer" if name == "viewer" else "/worklist/hpacs-lite/" + name))
                        if name == "viewer":
                            page.wait_for_function("window.started")
                        else:
                            self.assertIn("auth.js", reads)
                        self.assertFalse(LANGUAGE.intersection(reads))
                        self.assertFalse(page.evaluate("Boolean(window.KinLanguage || window.KinLanguageTerms)"))
                    finally:
                        context.close()
            browser.close()


if __name__ == "__main__":
    unittest.main()
