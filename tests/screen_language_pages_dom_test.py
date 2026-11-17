"""Screen language on the pages beside the work page: the clinician home, administration, audit and sign-in pages.

Requirement: a reader who chose English sees the whole product in English - explanations, tooltips and messages too -
and data (patient and study data, reports, names people give) stays as written. These pages cannot read the account's
appearance (administration and audit accounts, a browser before sign-in), so they show the choice this browser last
showed for the account (worklist-language.js, `kin-language:v1`); an account that never chose keeps each page as it is.

RISK: a page that does not load the language module, or a word it shows without a glossary entry, stays Korean on an
English screen (the static check, tests/worklist_language_source_test.py, names the file and line of a missing word;
this one reads the served page, its tooltips and the messages its failed requests leave).

The real pages and scripts are served from the repository; only API answers are synthetic: the session answers the
page's account, every other request fails (so the failure messages are on screen too).
"""
import functools
import http.server
import json
import threading
import unittest
from pathlib import Path
from urllib.parse import urlparse

from playwright.sync_api import expect, sync_playwright

ROOT = Path(__file__).resolve().parents[1]
BASE = "/worklist-v0/hpacs-lite/"
ENGLISH = {"version": 1, "worklist": "en", "reading": "en"}
KOREAN = {"version": 1, "worklist": "ko", "reading": "ko"}
ACCOUNT = {"sub": "SYN-SUB", "user": "syn-user@synthetic.test", "actor": "syn-user@synthetic.test", "displayName": "SYN User",
           "institution": "SYN-INST-A", "kind": "member", "sessionId": "SYN-SESSION"}
# page -> (roles of the signed-in account or None for no session, what shows the page has drawn)
PAGES = {
    "clinician.html": (["clinician"], "#list-state[data-state]"),
    "admin.html": (["admin"], "#users"),
    "audit.html": (["radiologist"], "#audit-search"),
    # The sign-in page after a failed sign-in: it stays (no automatic sign-in) and says why.
    "index.html?auth_error=login_failed": (None, "#msg"),
}

# Korean left where a reader reads: visible text, and the tooltip, label, placeholder and alt of every element.
# Data is left out where the page marks it (translate="no", form values, editable text).
LEFT = r"""() => { const H = /[가-힣]/, out = new Set();
  const DATA = 'script,style,textarea,[translate="no"],[contenteditable="true"],[contenteditable=""]';
  const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n = walk.nextNode(); n; n = walk.nextNode()) { const el = n.parentElement, t = n.nodeValue.trim();
    if (!t || !el || el.closest(DATA) || !H.test(t)) continue; const b = el.getBoundingClientRect();
    if (!b.width || !b.height || getComputedStyle(el).visibility === 'hidden') continue; out.add('text: ' + t.slice(0, 120)); }
  for (const el of document.querySelectorAll('[title],[aria-label],[placeholder],[alt]')) { if (el.closest(DATA)) continue;
    for (const a of ['title', 'aria-label', 'placeholder', 'alt']) { const v = el.getAttribute(a); if (v && H.test(v)) out.add(a + ': ' + v.slice(0, 120)); } }
  if (H.test(document.title)) out.add('document title: ' + document.title);
  return [...out].sort(); }"""


class ScreenLanguagePages(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        class Quiet(http.server.SimpleHTTPRequestHandler):
            def log_message(self, *args): pass
        cls.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), functools.partial(Quiet, directory=str(ROOT)))
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.pw = sync_playwright().start()
        cls.browser = cls.pw.chromium.launch(headless=True)

    @classmethod
    def tearDownClass(cls):
        cls.browser.close(); cls.pw.stop(); cls.server.shutdown(); cls.server.server_close(); cls.thread.join()

    def open(self, name, kept):
        roles, drawn = PAGES[name]
        context = self.browser.new_context(viewport={"width": 1366, "height": 768})
        self.addCleanup(context.close)
        if kept is not None:
            context.add_init_script("localStorage.setItem('kin-language:v1', %s)" % json.dumps(json.dumps(kept)))
        # Nothing leaves for another site and no session is real: every API request is answered here.
        context.route("**/*", lambda route: route.continue_() if urlparse(route.request.url).hostname == "127.0.0.1"
                      else route.abort())
        page = context.new_page()
        page.route("**/api/**", lambda route: self.api(route, roles))
        page.goto(f"http://127.0.0.1:{self.server.server_port}{BASE}{name}")
        expect(page.locator(drawn).first).to_be_attached()
        page.wait_for_load_state("networkidle")
        page.wait_for_timeout(300)
        return page

    @staticmethod
    def api(route, roles):
        path = urlparse(route.request.url).path
        if path == "/api/me" and roles is not None:
            return route.fulfill(json={**ACCOUNT, "roles": roles})
        if path == "/api/me":
            return route.fulfill(status=401, json={"statusCode": 401, "message": "SYN no session"})
        return route.fulfill(status=503, json={"statusCode": 503, "message": "SYN unavailable"})

    def test_english_leaves_no_korean_word_on_each_page(self):
        for name in PAGES:
            with self.subTest(page=name):
                page = self.open(name, ENGLISH)
                self.assertEqual("en", page.evaluate("document.documentElement.getAttribute('data-kin-lang-worklist')"))
                self.assertEqual([], page.evaluate(LEFT))

    def test_a_browser_with_no_choice_or_korean_keeps_each_page_as_it_is(self):
        for name in PAGES:
            for kept in (None, KOREAN):
                with self.subTest(page=name, kept=kept):
                    page = self.open(name, kept)
                    self.assertNotEqual([], page.evaluate(LEFT), "the page's own Korean explanations are still there")
                    self.assertIsNone(page.evaluate("window.KinLanguage.lang(document.body) === 'en' || null"))


if __name__ == "__main__":
    unittest.main()
