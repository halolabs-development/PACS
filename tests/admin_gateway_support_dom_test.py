# coding: utf-8
"""Gateway Support on the Members console (worklist-v0/hpacs-lite/admin.html, gateway-support-admin.js).

The administrator asks one of the institution's Gateways for diagnostics, a restart or an update to a held version. The
rules are the server's (api/src/gateway-support.ts, proved by tests/gateway_support_server_test.cjs) and the Gateway's
(gateway/agent: test_agent.py, test_update.py); this page reads the lines, sends a request and downloads a report. The
shipped page and scripts are served from a synthetic origin; /api/admin/gateway-support is answered from in-test queues
(an answer can be held) and every request is recorded.

  01  opening the page reads nothing: Not Loaded, only Load Gateway Support enabled, no lines.
  02  Load Gateway Support shows every line (one without a request too) with its version and newest request in words;
      names, versions and the requesting account are not translated; a line with an open request offers no action.
  03  an action sends exactly { queueInstance (the full value of that line), action, version } and reads the lines again.
  04  a busy line (409) reads again with a fixed sentence; a refusal (403) clears the lines; a failed read keeps the last
      lines dimmed and offers no action from them.
  05  Download Diagnostics saves the report the server holds as a JSON file.
  06  a read answered after the page session ended paints nothing.
  07  wording: English headings, controls and state words; Korean guidance; on a narrow window the actions wrap inside it.

Synthetic data only: no server, no network, no credentials.
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
ORIGIN = "https://gateway-support.test"
BASE = "/worklist/hpacs-lite/"
PAGE_PATH = BASE + "admin.html"
SCRIPTS = {BASE + name: lf_text(HPACS / name) for name in (
    "auth.js", "work-context.js", "session-transport.js", "study-access-admin.js", "signing-key-admin.js",
    "admin-access-review.js", "held-sources-admin.js", "emr-link.js", "emr-link-admin.js", "critical-result-inbox-admin.js", "dicom-peers-admin.js",
    "gateway-rules-admin.js", "gateway-support-admin.js", "patient-consent-admin.js", "product-info-data.js", "product-info.js")}
INSTITUTION = "SYN-INST-A"
ME = {"sub": "SYN-ADMIN-SUB", "user": "syn-admin", "displayName": "SYN Admin", "roles": ["admin"], "institution": INSTITUTION,
      "sessionId": "SYN-SESSION-ADMIN"}
MEMBERS = {"page": 1, "pageSize": 25, "total": 1, "pendingCount": 0, "users": [
    {"id": "SYN-U-1", "username": "syn-member", "email": "syn-member@gateway-support.test", "emailVerified": True,
     "name": "SYN Member", "institution": INSTITUTION, "roles": ["technician"], "enabled": True, "approvalState": "APPROVED"}]}
LIST = "/api/admin/gateway-support"
Q1, Q2, Q3 = ("0f4b2c1a-1111-4222-8333-944455556666", "1f4b2c1a-1111-4222-8333-944455556666",
              "2f4b2c1a-1111-4222-8333-944455556666")
R1, R2 = "5a5a5a5a-1111-4222-8333-944455556666", "6b6b6b6b-1111-4222-8333-944455556666"
T = "2026-11-20T03:00:00.000Z"


def req(id_, action, state, version=None, code=None, diagnostics=False):
    return {"id": id_, "action": action, "version": version, "state": state, "code": code, "requestedBy": "SYN-admin",
            "requestedAt": T, "updatedAt": T, "diagnostics": diagnostics}


def answer(gateways=None, updates=("2026.12.2", "2026.12.1")):
    return {"institutionId": INSTITUTION, "generatedAt": T, "serverStartedAt": "2026-11-20T01:00:00.000Z",
            "updates": list(updates), "gateways": [
                {"gateway": "gw-syn-ward", "queueInstance": Q1, "version": "2026.11.2", "contact": "recent", "lastContactAt": T,
                 "request": req(R1, "diagnostics", "done", diagnostics=True)},
                {"gateway": "gw-syn-er", "queueInstance": Q2, "version": "2026.11.2", "contact": "recent", "lastContactAt": T,
                 "request": None},
                {"gateway": "gw-syn-old", "queueInstance": Q3, "version": "2026.11.1", "contact": "no_contact", "lastContactAt": T,
                 "request": req(R2, "update", "delivered", version="2026.12.1")}] if gateways is None else gateways}


LINES = """() => [...document.querySelectorAll('#gateway-support-rows > li')].map(li => ({
  q: li.dataset.queueInstance,
  name: li.querySelector('.gw-host-name').textContent,
  request: li.querySelector('.gw-support-request').textContent,
  buttons: [...li.querySelectorAll('button')].map(b => [b.textContent, b.disabled]),
  versions: [...li.querySelectorAll('select option')].map(o => o.value),
  untranslated: [...li.querySelectorAll('[translate=no]')].map(e => e.textContent)}))"""


class AdminGatewaySupportDOMTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.pw = sync_playwright().start()
        cls.browser = cls.pw.chromium.launch()

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.pw.stop()

    def setUp(self, width=1280):
        self.calls, self.unexpected, self.errors, self.dialogs = [], [], [], []
        self.replies, self.held = [], []
        self.context = self.browser.new_context(timezone_id="UTC", viewport={"width": width, "height": 900},
                                                accept_downloads=True)
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
        elif path == "/favicon.ico":
            route.fulfill(status=404, body="")
        elif method == "GET" and path == "/api/me":
            route.fulfill(json=ME)
        elif method == "GET" and path == "/api/admin/users" and url.query == "page=1":
            route.fulfill(json=MEMBERS)
        elif method == "GET" and path == "/api/admin/dicom-peers":
            route.fulfill(status=401, headers={"X-KIN-Auth-Code": "AUTH_SESSION_ENDED"},
                          json={"code": "AUTH_SESSION_ENDED", "message": "SYN-SERVER-WORDING"})
        elif path.startswith(LIST):
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

    def support_calls(self, method=None):
        return [c for c in self.calls if c["path"].startswith(LIST) and (method is None or c["method"] == method)]

    def open(self):
        self.page.goto(ORIGIN + PAGE_PATH)
        expect(self.page.locator("#users td.username")).to_have_count(1)
        expect(self.page.locator("#gateway-support-refresh")).to_be_enabled()

    def load(self, body=None, status=200):
        before = len(self.support_calls())
        self.replies.append((status, answer() if body is None else body))
        self.page.locator("#gateway-support-refresh").click()
        self.wait_until(lambda: len(self.support_calls()) > before, "the read")
        expect(self.page.locator("#gateway-support-refresh")).to_be_enabled()

    def lines(self):
        return self.page.evaluate(LINES)

    def message(self):
        return self.page.locator("#gateway-support-message").text_content()

    def line(self, q):
        return self.page.locator(f'#gateway-support-rows > li[data-queue-instance="{q}"]')

    def test_01_opening_reads_nothing(self):
        self.open()
        self.assertEqual(self.support_calls(), [])
        expect(self.page.locator("#gateway-support-state")).to_have_text("Not Loaded")
        self.assertEqual(self.lines(), [])

    def test_02_load_shows_every_line_and_its_newest_request(self):
        self.open()
        self.load()
        lines = self.lines()
        self.assertEqual([(l["q"], l["name"]) for l in lines], [(Q1, "gw-syn-ward"), (Q2, "gw-syn-er"), (Q3, "gw-syn-old")])
        self.assertEqual(lines[0]["request"], "Last Request: Diagnostics · Done · 2026-11-20 03:00:00 · SYN-admin")
        self.assertEqual(lines[1]["request"], "No Request Since Server Start")
        self.assertEqual(lines[2]["request"], "Last Request: Update 2026.12.1 · Delivered to Gateway · 2026-11-20 03:00:00 · SYN-admin")
        self.assertEqual(lines[0]["buttons"], [["Request Diagnostics", False], ["Restart Gateway", False],
                                               ["Update Gateway", False], ["Download Diagnostics", False]])
        self.assertEqual(lines[0]["versions"], ["2026.12.2", "2026.12.1"])
        self.assertEqual([b[1] for b in lines[2]["buttons"]], [True, True, True], "an open request: no new action")
        self.assertIn("gw-syn-ward", lines[0]["untranslated"])
        self.assertIn("2026.11.2", lines[0]["untranslated"])
        self.assertIn("SYN-admin", lines[0]["untranslated"])
        # Two lines of one name are told apart by the queue instance, shown as on Gateway Status, the full value as its title.
        expect(self.line(Q1).locator('.gw-host-fact').first).to_have_text('Queue Instance 0f4b2c1a')
        self.assertIn(Q1, self.line(Q1).locator('.gw-host-fact').first.get_attribute('title'))
        self.assertIn('1f4b2c1a', self.lines()[1]['untranslated'])
        expect(self.line(Q3)).to_contain_text("No Contact since 2026-11-20 03:00:00")
        expect(self.page.locator("#gateway-support-state")).to_have_text("Observed 2026-11-20 03:00:00")
        # No update held: no update control to press.
        self.load(answer(updates=()))
        self.assertEqual(self.lines()[1]["buttons"][2], ["Update Gateway", True])
        self.load(answer(gateways=[]))
        expect(self.page.locator("#gateway-support-empty")).to_be_visible()

    def test_03_an_action_names_the_full_line_and_reads_again(self):
        self.open()
        self.load()
        self.replies += [(200, {"request": req(R2, "restart", "requested")}), (200, answer())]
        self.line(Q2).get_by_role("button", name="Restart Gateway").click()
        self.wait_until(lambda: len(self.support_calls("GET")) == 2, "the read after the request")
        self.assertEqual(json.loads(self.support_calls("POST")[-1]["body"]), {"queueInstance": Q2, "action": "restart", "version": None})
        self.assertIn("요청을 남겼습니다", self.message())
        self.line(Q1).locator("select").select_option("2026.12.1")
        self.replies += [(200, {"request": req(R2, "update", "requested", "2026.12.1")}), (200, answer())]
        self.line(Q1).get_by_role("button", name="Update Gateway").click()
        self.wait_until(lambda: len(self.support_calls("GET")) == 3, "the read after the update request")
        self.assertEqual(json.loads(self.support_calls("POST")[-1]["body"]), {"queueInstance": Q1, "action": "update", "version": "2026.12.1"})
        self.replies += [(200, {"request": req(R2, "diagnostics", "requested")}), (200, answer())]
        self.line(Q1).get_by_role("button", name="Request Diagnostics").click()
        self.wait_until(lambda: len(self.support_calls("GET")) == 4, "the read after the diagnostics request")
        self.assertEqual(json.loads(self.support_calls("POST")[-1]["body"]), {"queueInstance": Q1, "action": "diagnostics", "version": None})

    def test_04_busy_refused_and_failed_reads(self):
        self.open()
        self.load()
        self.replies += [(409, {"code": "GATEWAY_SUPPORT_BUSY", "message": "SYN-SERVER-WORDING"}),
                         (200, answer(gateways=[dict(answer()["gateways"][1], request=req(R2, "restart", "requested"))]))]
        self.line(Q2).get_by_role("button", name="Restart Gateway").click()
        self.wait_until(lambda: len(self.support_calls("GET")) == 2, "the read after 409")
        self.assertIn("아직 끝나지 않은 요청", self.message())
        self.assertNotIn("SYN-SERVER-WORDING", self.message())
        self.assertEqual(self.lines()[0]["request"].split(" · ")[1], "Requested")
        # A failed read: the last lines stay dimmed and no action is offered from them.
        self.load(body={"code": "X"}, status=503)
        expect(self.page.locator("#gateway-support-rows")).to_have_class(re.compile("stale"))
        self.assertTrue(all(disabled for _t, disabled in self.lines()[0]["buttons"]))
        expect(self.page.locator("#gateway-support-state")).to_contain_text("Query Failed")
        self.load(body={"gateways": "not a list"})
        self.assertIn("형식", self.message())
        # A refusal clears what an earlier read showed.
        self.load(body={"code": "GATEWAY_SUPPORT_RESTRICTED"}, status=403)
        self.assertEqual(self.lines(), [])
        expect(self.page.locator("#gateway-support-state")).to_have_text("Not Loaded")
        self.assertIn("검사 접근 범위가 제한된 계정", self.message())

    def test_05_download_diagnostics_saves_the_report(self):
        self.open()
        self.load()
        report = {"format": 1, "version": "2026.11.2", "queue": {"total": 3}}
        self.replies.append((200, {"request": req(R1, "diagnostics", "done", diagnostics=True), "gateway": "gw-syn-ward",
                                   "queueInstance": Q1, "receivedAt": T, "report": report}))
        with self.page.expect_download() as info:
            self.line(Q1).get_by_role("button", name="Download Diagnostics").click()
        download = info.value
        self.assertEqual(download.suggested_filename, "gateway-diagnostics-gw-syn-ward-5a5a5a5a.json")
        saved = json.loads(Path(download.path()).read_text(encoding="utf-8"))
        self.assertEqual(saved["report"], report)
        self.assertEqual(self.support_calls("GET")[-1]["path"], f"{LIST}/{R1}/diagnostics")

    def test_06_a_read_answered_after_the_session_ended_paints_nothing(self):
        self.open()
        self.load()
        self.replies.append("hold")
        self.page.locator("#gateway-support-refresh").click()
        self.wait_until(lambda: len(self.held) == 1, "the held read")
        self.page.locator("#dicom-peers-refresh").click()
        expect(self.page.locator("#gateway-support-state")).to_have_text("Not Loaded")
        self.assertEqual(self.lines(), [])
        self.held[0].fulfill(status=200, json=answer())
        self.page.wait_for_timeout(300)
        expect(self.page.locator("#gateway-support-state")).to_have_text("Not Loaded")
        self.assertEqual(self.lines(), [])
        expect(self.page.locator("#gateway-support-refresh")).to_be_disabled()

    def test_07_wording_and_a_narrow_window(self):
        self.context.close()
        self.setUp(width=420)
        self.open()
        self.load()
        texts = self.page.evaluate("""() => { const s = document.querySelector('#gateway-support');
          return { heads: [...s.querySelectorAll('h2, button, #gateway-support-state, .gw-support-request')].map(e => e.textContent),
                   hint: s.querySelector('.gateway-hint').textContent }; }""")
        hangul = re.compile(r"[가-힣]")
        self.assertEqual([t for t in texts["heads"] if hangul.search(t)], [])
        self.assertRegex(texts["hint"], hangul)
        overflow = self.page.evaluate("""() => [...document.querySelectorAll('#gateway-support-rows button, #gateway-support-rows select')]
          .filter(e => e.getBoundingClientRect().right > document.documentElement.clientWidth + 1).length""")
        self.assertEqual(overflow, 0, "every action stays inside a narrow window")


if __name__ == "__main__":
    unittest.main(verbosity=2)
