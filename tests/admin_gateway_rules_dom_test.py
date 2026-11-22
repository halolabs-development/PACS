# coding: utf-8
"""Gateway Rules on the Members console (worklist-v0/hpacs-lite/admin.html, gateway-rules-admin.js).

The administrator sets the institution's Gateway settings: routing rules (Modality and/or sending AE Title -> one or more
destinations: HALO PACS and the DICOM Peers registered as PACS / Modality), and
lossless compression toward HALO PACS. The rule and its checks are the server's (api/src/gateway-settings.ts, proved by
tests/gateway_settings_server_test.cjs); this page loads, edits and saves. The shipped page and scripts are served from a
synthetic origin; /api/admin/gateway-settings is answered from in-test queues (an answer can be held) and every request
is recorded.

  01  opening the page reads nothing of the rules: Not Loaded, only Load Gateway Rules enabled, no rule rows.
  02  Load Gateway Rules reads once and shows the rules, the destination choices (HALO PACS and each peer; a peer's name is
      not translated), and Compression as saved.
  03  editing and saving sends exactly { revision, routes, compression } with empty conditions as null;
      the answer is shown with its revision; the same settings again say nothing changed.
  04  refusals in fixed sentences that name the rule and its field (never the server's wording); another save in between (409) reads the rules again.
  05  a read answered after the page session ended paints nothing and every control stays off.
  06  wording: English headings, controls and state words with no Hangul; Korean guidance.

Synthetic data only: no server, no network, no credentials. A request the harness does not answer is aborted and fails
the case, as does a page error or a browser dialog.
"""
from pathlib import Path
import json
import re
import time
import unittest
from urllib.parse import urlparse

from playwright.sync_api import expect, sync_playwright


ROOT = Path(__file__).resolve().parents[1]
HPACS = ROOT / "worklist-v0" / "hpacs-lite"


def lf_text(path):
    return path.read_bytes().decode("utf-8").replace("\r\n", "\n")


ADMIN_HTML = lf_text(HPACS / "admin.html")
ORIGIN = "https://gateway-rules.test"
BASE = "/worklist/hpacs-lite/"
PAGE_PATH = BASE + "admin.html"
SCRIPTS = {BASE + name: lf_text(HPACS / name) for name in (
    "worklist-language-terms.js", "worklist-language.js", "auth.js", "work-context.js", "session-transport.js", "study-access-admin.js", "signing-key-admin.js",
    "admin-access-review.js", "held-sources-admin.js", "emr-link.js", "emr-link-admin.js", "critical-result-inbox-admin.js", "dicom-peers-admin.js",
    "gateway-rules-admin.js", "gateway-support-admin.js", "patient-consent-admin.js", "product-info-data.js", "product-info.js")}
INSTITUTION = "SYN-INST-A"
ME = {"sub": "SYN-ADMIN-SUB", "user": "syn-admin", "displayName": "SYN Admin", "roles": ["admin"], "institution": INSTITUTION,
      "sessionId": "SYN-SESSION-ADMIN"}
MEMBERS = {"page": 1, "pageSize": 25, "total": 1, "pendingCount": 0, "users": [
    {"id": "SYN-U-1", "username": "syn-member", "email": "syn-member@gateway-rules.test", "emailVerified": True,
     "name": "SYN Member", "institution": INSTITUTION, "roles": ["technician"], "enabled": True, "approvalState": "APPROVED"}]}
SETTINGS_PATH = "/api/admin/gateway-settings"
P1, P2 = "11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"
PEERS = [{"id": P1, "name": "SYN PACS A", "aet": "SYNPACSA", "host": "pacs-a.synthetic.test", "port": 104},
         {"id": P2, "name": "SYN PACS B", "aet": "SYNPACSB", "host": "10.0.0.9", "port": 11112}]


def settings(revision=3, routes=None, compression="lossless", retention=None):
    return {"revision": revision, "compression": compression, "retentionDays": retention,
            "routes": [{"modality": "CT", "sourceAe": None, "destinations": ["kin", P1]},
                       {"modality": "US", "sourceAe": "SYN_US", "destinations": [P2]}] if routes is None else routes}


ROWS = """() => [...document.querySelectorAll('#gateway-rules-rows > tr')].map(tr => ({
  number: tr.children[0].textContent,
  modality: tr.querySelector('input[data-field=modality]').value,
  sourceAe: tr.querySelector('input[data-field=sourceAe]').value,
  checked: [...tr.querySelectorAll('.gw-rule-destinations input')].filter(b => b.checked).map(b => b.value),
  choices: [...tr.querySelectorAll('.gw-rule-destinations label')].map(l => l.textContent.trim()),
  untranslated: [...tr.querySelectorAll('.gw-rule-destinations [translate=no]')].map(e => e.textContent)}))"""


class AdminGatewayRulesDOMTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.pw = sync_playwright().start()
        cls.browser = cls.pw.chromium.launch()

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.pw.stop()

    def setUp(self):
        self.calls, self.unexpected, self.errors, self.dialogs = [], [], [], []
        self.replies, self.held = [], []
        self.context = self.browser.new_context(timezone_id="UTC", viewport={"width": 1280, "height": 900})
        self.page = self.context.new_page()
        self.page.on("pageerror", lambda error: self.errors.append(str(error)))
        self.page.on("dialog", lambda dialog: (self.dialogs.append(dialog.message), dialog.dismiss()))
        self.page.route("**/*", self.route)

    def tearDown(self):
        self.context.close()
        self.assertEqual([], self.errors, "page errors")
        self.assertEqual([], self.unexpected, "requests the harness does not answer")
        self.assertEqual([], self.dialogs, "browser dialogs")

    def route(self, route):
        request = route.request
        url = urlparse(request.url)
        method, path = request.method, url.path
        if f"{url.scheme}://{url.netloc}" != ORIGIN:
            self.unexpected.append(f"{method} {request.url}")
            route.abort()
            return
        self.calls.append({"method": method, "path": path, "body": request.post_data})
        if method == "GET" and path == PAGE_PATH:
            route.fulfill(body=ADMIN_HTML, content_type="text/html; charset=utf-8")
        elif method == "GET" and path in SCRIPTS:
            route.fulfill(body=SCRIPTS[path], content_type="application/javascript; charset=utf-8")
        elif method == "GET" and path == BASE + "index.html":
            route.fulfill(status=204, body="")
        elif method == "GET" and path == "/worklist/hpacs-lite/kin-emblem-j1.svg":  # the header's HALO icon
            route.fulfill(path=HPACS / "kin-emblem-j1.svg")
        elif path == "/favicon.ico":
            route.fulfill(status=404, body="")
        elif method == "GET" and path == "/api/me":
            route.fulfill(json=ME)
        elif method == "GET" and path == "/api/admin/users" and url.query == "page=1":
            route.fulfill(json=MEMBERS)
        elif method == "GET" and path == "/api/admin/dicom-peers":
            route.fulfill(status=401, headers={"X-KIN-Auth-Code": "AUTH_SESSION_ENDED"},
                          json={"code": "AUTH_SESSION_ENDED", "message": "SYN-SERVER-WORDING"})
        elif method in ("GET", "PUT") and path == SETTINGS_PATH:
            if not self.replies:
                self.unexpected.append(f"{method} {path} (no answer queued)")
                route.abort()
                return
            reply = self.replies.pop(0)
            if reply == "hold":
                self.held.append(route)
                return
            status, body = reply
            route.fulfill(status=status, json=body)
        else:
            self.unexpected.append(f"{method} {request.url}")
            route.abort()

    def wait_until(self, predicate, what, timeout=10.0):
        deadline = time.monotonic() + timeout
        while not predicate():
            if time.monotonic() >= deadline:
                self.fail(f"{what}: not observed within {timeout:.0f}s")
            self.page.wait_for_timeout(10)

    def settings_calls(self, method=None):
        return [c for c in self.calls if c["path"] == SETTINGS_PATH and (method is None or c["method"] == method)]

    def open(self):
        self.page.goto(ORIGIN + PAGE_PATH)
        expect(self.page.locator("#users td.username")).to_have_count(1)
        expect(self.page.locator("#gateway-rules-refresh")).to_be_enabled()

    def load(self, answer=None):
        before = len(self.settings_calls("GET"))
        self.replies.append((200, {"settings": answer or settings(), "peers": PEERS}))
        self.page.locator("#gateway-rules-refresh").click()
        self.wait_until(lambda: len(self.settings_calls("GET")) > before, "the settings read")
        expect(self.page.locator("#gateway-rules-save")).to_be_enabled()

    def save(self, reply):
        before = len(self.settings_calls("PUT"))
        if reply is not None:
            self.replies.append(reply)
        self.page.locator("#gateway-rules-save").click()
        if reply is not None:
            self.wait_until(lambda: len(self.settings_calls("PUT")) > before, "the save")
            expect(self.page.locator("#gateway-rules-save")).to_be_enabled()
        return json.loads(self.settings_calls("PUT")[-1]["body"]) if len(self.settings_calls("PUT")) > before else None

    def message(self):
        return self.page.locator("#gateway-rules-message").text_content()

    def rows(self):
        return self.page.evaluate(ROWS)

    def test_01_opening_reads_nothing_of_the_rules(self):
        self.open()
        self.assertEqual(self.settings_calls(), [])
        expect(self.page.locator("#gateway-rules-state")).to_have_text("Not Loaded")
        for control in ("#gateway-rule-add", "#gateway-compression", "#gateway-rules-save"):
            expect(self.page.locator(control)).to_be_disabled()
        self.assertEqual(self.rows(), [])
        self.assertTrue(self.page.locator("#gateway-rules-empty").is_hidden())

    def test_02_load_shows_the_saved_rules_and_choices(self):
        self.open()
        self.load()
        self.assertEqual(len(self.settings_calls("GET")), 1)
        rows = self.rows()
        self.assertEqual([(r["number"], r["modality"], r["sourceAe"], r["checked"]) for r in rows],
                         [("1", "CT", "", ["kin", P1]), ("2", "US", "SYN_US", [P2])])
        self.assertEqual(rows[0]["choices"], ["HALO PACS", "SYN PACS A", "SYN PACS B"])
        self.assertEqual(rows[0]["untranslated"], ["SYN PACS A", "SYN PACS B"], "a peer's own name is never translated")
        expect(self.page.locator("#gateway-rules-state")).to_have_text("2 Rules")
        expect(self.page.locator("#gateway-compression")).to_have_value("lossless")
        self.load(settings(revision=0, routes=[], compression="none"))
        self.assertEqual(self.rows(), [])
        expect(self.page.locator("#gateway-rules-empty")).to_be_visible()
        expect(self.page.locator("#gateway-rules-state")).to_have_text("No Rules")

    def test_03_editing_and_saving_sends_the_closed_form(self):
        self.open()
        self.load()
        self.page.locator("#gateway-rule-add").click()
        third = self.page.locator("#gateway-rules-rows > tr").nth(2)
        third.locator("input[data-field=modality]").fill("MG")
        third.locator(f'.gw-rule-destinations input[value="{P2}"]').check()
        self.page.locator("#gateway-rules-rows > tr").nth(1).get_by_role("button", name="Remove Rule").click()
        self.page.locator("#gateway-compression").select_option("none")
        saved = settings(revision=4, routes=[{"modality": "CT", "sourceAe": None, "destinations": ["kin", P1]},
                                             {"modality": "MG", "sourceAe": None, "destinations": ["kin", P2]}],
                         compression="none")
        sent = self.save((200, {"settings": saved, "changed": True}))
        self.assertEqual(sent, {"revision": 3, "compression": "none", "retentionDays": None, "routes": [
            {"modality": "CT", "sourceAe": None, "destinations": ["kin", P1]},
            {"modality": "MG", "sourceAe": None, "destinations": ["kin", P2]}]})
        self.assertIn("판 4", self.message())
        self.assertEqual([r["number"] for r in self.rows()], ["1", "2"])
        self.page.get_by_role("button", name="Remove Rule").last.click()
        self.assertEqual(len(self.rows()), 1)
        self.load(dict(sent, revision=4))
        self.assertEqual([row["checked"] for row in self.rows()], [["kin", P1], ["kin", P2]])
        unchanged = self.save((200, {"settings": saved, "changed": False}))
        self.assertEqual(unchanged, dict(sent, revision=4))
        self.assertEqual(self.message(), "바뀐 것이 없어 저장하지 않았습니다.")

    def test_04_refusals_are_fixed_sentences(self):
        self.open()
        self.load()
        self.save((400, {"code": "GATEWAY_SETTINGS_INVALID", "field": "routes[1].destinations", "message": "SYN-SERVER-WORDING"}))
        self.assertIn("규칙 2의 Destinations", self.message())
        self.assertNotIn("SYN-SERVER-WORDING", self.message())
        self.assertEqual(len(self.rows()), 2, "the form stays as edited")
        self.save((400, {"code": "GATEWAY_SETTINGS_INVALID", "field": "routes[0].modality"}))
        self.assertIn("규칙 1의 Modality", self.message())
        # Another administrator saved meanwhile: the rules are read again.
        before = len(self.settings_calls("GET"))
        self.replies.append((409, {"code": "GATEWAY_SETTINGS_STALE", "revision": 4}))
        self.replies.append((200, {"settings": settings(revision=4, routes=[]), "peers": PEERS}))
        self.page.locator("#gateway-rules-save").click()
        self.wait_until(lambda: len(self.settings_calls("GET")) > before, "the read after 409")
        expect(self.page.locator("#gateway-rules-state")).to_have_text("No Rules")
        self.assertIn("다시 불러왔습니다", self.message())

    def test_05_a_read_answered_after_the_session_ended_paints_nothing(self):
        self.open()
        self.load()
        self.replies.append("hold")
        self.page.locator("#gateway-rules-refresh").click()
        self.wait_until(lambda: len(self.held) == 1, "the held read")
        # Another panel's read is told the session ended (the server's AUTH_SESSION_ENDED): the page session ends at
        # once; the move to the entry page is answered 204 so this document stays to be read.
        self.page.locator("#dicom-peers-refresh").click()
        expect(self.page.locator("#gateway-rules-state")).to_have_text("Not Loaded")
        self.assertEqual(self.rows(), [])
        self.held[0].fulfill(status=200, json={"settings": settings(revision=9), "peers": PEERS})
        self.page.wait_for_timeout(300)
        expect(self.page.locator("#gateway-rules-state")).to_have_text("Not Loaded")
        self.assertEqual(self.rows(), [])
        for control in ("#gateway-rules-refresh", "#gateway-rule-add", "#gateway-rules-save"):
            expect(self.page.locator(control)).to_be_disabled()

    def test_07_the_retention_days_load_save_clear_and_refuse(self):
        self.open()
        expect(self.page.locator("#gateway-retention-days")).to_be_disabled()
        self.load(settings(retention=30))
        days = self.page.locator("#gateway-retention-days")
        expect(days).to_be_enabled()
        expect(days).to_have_value("30")
        self.assertEqual(days.get_attribute("placeholder"), "Never")
        days.fill("90")
        sent = self.save((200, {"settings": settings(revision=4, retention=90), "changed": True}))
        self.assertEqual(sent["retentionDays"], 90)
        expect(days).to_have_value("90")
        days.fill("")
        sent = self.save((200, {"settings": settings(revision=5), "changed": True}))
        self.assertIsNone(sent["retentionDays"], "empty = never delete")
        expect(days).to_have_value("")
        for typed, value in (("0", 0), ("10000", 10000), ("1.5", "1.5"), ("seven", "seven")):
            with self.subTest(typed=typed):
                days.fill(typed)
                sent = self.save((400, {"code": "GATEWAY_SETTINGS_INVALID", "field": "retentionDays"}))
                self.assertEqual(sent["retentionDays"], value, "sent as typed (never cut short); the server refuses it")
                self.assertIn("1부터 3650까지", self.message())
                expect(days).to_have_value(typed, timeout=1000)
        self.load(settings(revision=6, retention=None))
        expect(days).to_have_value("")

    def test_06_wording(self):
        self.open()
        self.load()
        texts = self.page.evaluate("""() => { const s = document.querySelector('#gateway-rules');
          return { heads: [...s.querySelectorAll('h2, th, button, label, option, #gateway-rules-state')].map(e => e.textContent),
                   hint: s.querySelector('.gateway-hint').textContent }; }""")
        hangul = re.compile(r"[가-힣]")
        self.assertEqual([t for t in texts["heads"] if hangul.search(t)], [])
        self.assertRegex(texts["hint"], hangul)


if __name__ == "__main__":
    unittest.main(verbosity=2)
