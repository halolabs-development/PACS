"""Screen language on the pages beside the work page: the clinician home, administration, audit and sign-in pages.

Requirement: a reader who chose English sees the whole product in English - explanations, tooltips and messages too -
and data (patient and study data, reports, names people give) stays as written. These pages cannot read the account's
appearance (administration and audit accounts, a browser before sign-in), so they show the choice this browser last
showed for the account (worklist-language.js, `kin-language:v1`); the clinician home reads the account's appearance. An
account that never chose keeps each page as it is.

RISK: a page that does not load the language module, or a word it shows without a glossary entry, stays Korean on an
English screen (the static check, tests/worklist_language_source_test.py, names the file and line of a missing word;
this one reads the served page, its tooltips and the messages its failed requests leave).

The real pages and scripts are served from the repository; only API answers are synthetic: the session answers the
page's account, every other request fails (so the failure messages are on screen too).
"""
import functools
import http.server
import json
import sys
import threading
import unittest
from pathlib import Path
from urllib.parse import urlparse

from playwright.sync_api import expect, sync_playwright

sys.path.insert(0, str(Path(__file__).resolve().parent))
import admin_audit_dom_test as admin_audit  # noqa: E402
import audit_page_dom_test as audit_page  # noqa: E402
import language_data_probe as probe  # noqa: E402

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
    "audit.html?": (["radiologist"], "#audit-search"),
    # The sign-in page after a failed sign-in: it stays (no automatic sign-in) and says why.
    "index.html?auth_error=login_failed": (None, "#msg"),
}

# Korean left where a reader reads: visible text, and the tooltip, label, placeholder, alt and description of every
# element (a text field's own placeholder and title too). Data is left out where the page marks it (translate="no",
# editable text); a field's value is data.
LEFT = r"""() => { const H = /[가-힣]/, out = new Set();
  const DATA = 'script,style,[translate="no"],[contenteditable="true"],[contenteditable=""]';
  const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n = walk.nextNode(); n; n = walk.nextNode()) { const el = n.parentElement, t = n.nodeValue.trim();
    if (!t || !el || el.closest(DATA + ',textarea') || !H.test(t)) continue; const b = el.getBoundingClientRect();
    if (!b.width || !b.height || getComputedStyle(el).visibility === 'hidden') continue; out.add('text: ' + t.slice(0, 120)); }
  for (const el of document.querySelectorAll('[title],[aria-label],[placeholder],[alt],[aria-description]')) { if (el.closest(DATA)) continue;
    for (const a of ['title', 'aria-label', 'placeholder', 'alt', 'aria-description']) { const v = el.getAttribute(a); if (v && H.test(v)) out.add(a + ': ' + v.slice(0, 120)); } }
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

    def open(self, name, kept, answers=None, planter=None):
        """The page with the account's choice kept in this browser and, for the clinician home, in the account."""
        roles, drawn = PAGES[name]
        context = self.browser.new_context(viewport={"width": 1366, "height": 768})
        self.addCleanup(context.close)
        if kept is not None:
            context.add_init_script("localStorage.setItem('kin-language:v1', %s)" % json.dumps(json.dumps(kept)))
        # Nothing leaves for another site and no session is real: every API request is answered here.
        context.route("**/*", lambda route: route.continue_() if urlparse(route.request.url).hostname == "127.0.0.1"
                      else route.abort())
        page = context.new_page()
        self.dialogs = []
        page.on("dialog", lambda d: (self.dialogs.append(d.message), d.dismiss()))
        page.route("**/api/**", lambda route: self.api(planter.wrap(route) if planter else route, roles, kept, answers or {}))
        page.goto(f"http://127.0.0.1:{self.server.server_port}{BASE}{name}")
        expect(page.locator(drawn).first).to_be_attached()
        page.wait_for_load_state("networkidle")
        page.wait_for_timeout(300)
        return page

    @staticmethod
    def api(route, roles, kept, answers):
        path = urlparse(route.request.url).path
        if path == "/api/me" and roles is not None:
            return route.fulfill(json={**ACCOUNT, "roles": roles})
        if path == "/api/reading-appearance" and roles is not None:
            sizes = None if kept is None else {"version": 12, "language": kept}
            return route.fulfill(json={"owner": [ACCOUNT["institution"], ACCOUNT["sub"]], "revision": 0 if kept is None else 1,
                                       "sizes": sizes})
        if path in answers:
            return route.fulfill(json=answers[path])
        if path == "/api/me":
            return route.fulfill(status=401, json={"statusCode": 401, "message": "SYN no session"})
        return route.fulfill(status=503, json={"statusCode": 503, "message": "SYN unavailable"})

    def test_english_leaves_no_korean_word_on_each_page(self):
        for name in PAGES:
            with self.subTest(page=name):
                page = self.open(name, ENGLISH)
                self.assertEqual("en", page.evaluate("document.documentElement.getAttribute('data-kin-lang-worklist')"))
                self.assertEqual([], page.evaluate(LEFT))

    def test_english_keeps_member_data_as_written(self):
        """A member's name and institution stay as written even when they equal a glossary word (성 Last Name, 승인
        Approval); the words around them are English."""
        member = {"id": "SYN-U", "username": "syn", "name": "성", "email": "syn@example.test", "institution": "승인",
                  "roles": ["clinician"], "approvalState": "APPROVED", "enabled": True, "version": 1}
        page = self.open("admin.html", ENGLISH, {"/api/admin/users": {"page": 1, "pageSize": 25, "total": 1, "pendingCount": 0,
                                                                      "users": [member]}})
        row = page.locator("#users tr")
        expect(row).to_have_count(1)
        self.assertEqual(["syn", "성\nsyn@example.test", "승인"], [c.strip() for c in row.locator("td").all_inner_texts()[:3]])
        self.assertEqual(["All Institutions", "승인"], page.locator("#institution-filter option").all_text_contents())
        self.assertEqual([], page.evaluate(LEFT))

    def probed(self, name, answers, steps):
        """The page drawn from valid answers and from the same answers with planted data (English), through steps."""
        runs = []
        for planter in (None, probe.Planter(probe.pools()[0], codes=True)):
            page = self.open(name, ENGLISH, answers, planter)
            seen = []
            for step in steps:
                step(page)
                page.wait_for_timeout(200)
                seen += probe.snapshot(page)
            values = planter.planted() if planter else []
            runs.append((seen + self.dialogs, values, probe.translations(page, values, "en"), planter))
        (plain, _, _, _), (planted, values, shown, planter) = runs
        return probe.check(plain, planted, values, shown, planter)

    def test_english_shows_member_role_and_audit_data_as_written(self):
        """Members (names, institution, roles - a site may name its own), the audit rows and the membership dialog: the
        displayed values replaced with glossary words, sentences and filled templates stay as written."""
        def audit(page):
            page.locator("#audit-refresh").click()
            expect(page.locator("#audit-rows tr").first).to_be_attached()

        def membership(page):
            page.locator("#users tr button").first.click()
            expect(page.locator("#membership-dialog")).to_be_visible()

        found, reached = self.probed("admin.html", {"/api/admin/users": admin_audit.MEMBERS, "/api/admin/audit": admin_audit.PAGE1},
                                     [lambda page: expect(page.locator("#users tr")).to_have_count(1), audit, membership])
        self.assertEqual([], found)
        self.assertGreater(len(reached), 2, "planted data reaches the page")

    def test_english_shows_audit_page_data_as_written(self):
        body = audit_page.answer([audit_page.event("CHANGE-1")], [audit_page.event("VIEW-1", "열람")])

        def search(page):
            page.locator("input[name=patientId]").first.fill("SYN-PATIENT")
            page.locator("input[name=assigningAuthority]").first.fill("SYN-AUTHORITY")
            page.get_by_role("button", name="Search", exact=True).click()
            page.wait_for_timeout(500)

        found, reached = self.probed("audit.html?", {"/api/emr-audit/investigations": body}, [search])
        self.assertEqual([], found)

    def test_a_browser_with_no_choice_or_korean_keeps_each_page_as_it_is(self):
        for name in PAGES:
            for kept in (None, KOREAN):
                with self.subTest(page=name, kept=kept):
                    page = self.open(name, kept)
                    self.assertNotEqual([], page.evaluate(LEFT), "the page's own Korean explanations are still there")
                    self.assertIsNone(page.evaluate("window.KinLanguage.lang(document.body) === 'en' || null"))


if __name__ == "__main__":
    unittest.main()
