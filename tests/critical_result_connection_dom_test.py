"""Mark CVR and the study question writes follow one connection rule on the served page.

The reading page decides in one place whether it can send to the server now (page-core.js serverReachable). The Mark CVR
entry, its Send Critical Result window and the question Reply / Close / Retry all follow that rule, and are painted again
when the connection is lost or comes back (page-boot.js goOffline / goOnline call window.kinOnConnection) and when the
report state the page knows changes (worklist-data.js updateReportButtons calls window.kinOnReportButtons):

- More is open when the reader approves: Mark CVR turns on without closing and opening More again.
- The connection is lost: Mark CVR and the window's Send are off and say why; the recipient and message stay. The answer of
  a recipient read that arrives meanwhile is kept, and the window can be used once the connection is back. A read that
  left before the outage and fails only once the connection is back is read again (the entry and the window).
- The connection is lost: Reply, Close and the Retry of an unknown write are off (nothing is sent) and the text stays;
  Discard stays. Once back, they send as before.

Serves the real page and its assets; only HTTP answers are synthetic (tests/auth_logout_dom_test.Site).
"""
import re
import time
import unittest
from urllib.parse import parse_qs

from playwright.sync_api import expect, sync_playwright

import auth_logout_dom_test as auth
import clinician_question_dom_test as q

CLIN = {"sub": "5a5a5a5a-1111-4222-8333-444444444444", "actor": "syn-cvr-clin@synthetic.test", "name": "SYN Clin", "role": "clinician"}
NOT_SENDABLE = "보낼 수 있는 판독 판이 없습니다(판독 전이거나 판독 취소됨)"
ENTRY_OFFLINE = "서버에 연결된 판독 세션에서만 중요 결과(CVR)를 보낼 수 있는지 확인합니다."
WRITE_OFFLINE = "서버 연결이 끊겨 지금은 보낼 수 없습니다. 쓴 내용은 그대로 있습니다."
DISCONNECT = "() => { goOffline(new Error('SYN disconnected')); stopReconnect(); }"
RECONNECT = "async () => goOnline(await fetchBootstrap())"
# Every box of the page has stayed the same for three frames (late answers and their repaints have run).
SETTLE = """async () => {
  const frame = () => new Promise(resolve => requestAnimationFrame(() => resolve()));
  const boxes = () => JSON.stringify([...document.querySelectorAll('body *')].map(node => {
    const box = node.getBoundingClientRect(); return [box.x, box.y, box.width, box.height]; }));
  let last = null, same = 0;
  for (let i = 0; i < 180 && same < 3; i++) { await frame(); const now = boxes(); same = now === last ? same + 1 : 0; last = now; }
  return same >= 3;
}"""


def settle(page):
    assert page.evaluate(SETTLE), "layout did not settle"


def wait_until(page, check, what, timeout=8.0):
    deadline = time.monotonic() + timeout
    while not check():
        if time.monotonic() >= deadline:
            raise AssertionError(f"{what}: not within {timeout:.0f} s")
        page.wait_for_timeout(50)


class ConnectionSite(auth.Site):
    """The served page's synthetic server plus the received and sent critical result lists (empty), the Mark CVR read
    (#1, sendable once the stored report is approved) and the question routes (clinician_question_dom_test.QuestionServer)."""

    def __init__(self):
        super().__init__()
        self.recipient_reads, self.held_recipients = [], None
        self.questions = q.QuestionServer([auth.UID])
        self.question_log, self.question_faults = [], []

    def recipients_body(self, account):
        owner = [auth.INSTITUTION, account["sub"]]
        if self.report.get("rs") == "A":
            return {"owner": owner, "uid": auth.UID, "sendable": True, "reason": None,
                    "source": {"version": self.report["version"], "action": "approve", "author": account["actor"],
                               "at": "2026-10-03T01:00:00.000Z", "final": True},
                    "recipients": [{k: CLIN[k] for k in ("sub", "actor", "name", "role")}]}
        return {"owner": owner, "uid": auth.UID, "sendable": False, "reason": "NO_PINNABLE_SOURCE", "source": None,
                "recipients": []}

    def api(self, route, request, method, path, query):
        if method == "GET" and path == f"/api/studies/{auth.UID}/critical-result-recipients":
            account, refused = self.authenticate(request)
            if refused:
                return self.refuse(route, *refused)
            self.recipient_reads.append(self.report.get("rs"))
            if self.held_recipients is not None:
                return self.held_recipients.append((route, self.recipients_body(account)))
            return route.fulfill(json=self.recipients_body(account))
        view = parse_qs(query).get("view")
        if method == "GET" and path == "/api/critical-results" and view in (["sent"], ["received"]):
            account, refused = self.authenticate(request)
            if refused:
                return self.refuse(route, *refused)
            return route.fulfill(json={"owner": [auth.INSTITUTION, account["sub"]], "view": view[0], "items": [],
                                       "nextCursor": None, "pending": 0})
        if re.fullmatch(r"/api/(studies/[^/]+/questions|questions(/.*)?)", path):
            account, refused = self.authenticate(request)
            if refused:
                return self.refuse(route, *refused)
            body = request.post_data_json if method == "POST" else None
            self.question_log.append((method, path, body))
            if method == "POST" and self.question_faults:
                fault = self.question_faults.pop(0)
                if fault == "before-apply":
                    return route.abort("connectionreset")
            caller = {**q.me(q.RADIOLOGIST, ["radiologist"]), "institution": auth.INSTITUTION, "sub": account["sub"],
                      "actor": account["actor"], "displayName": account.get("displayName") or account["actor"]}
            status, data = self.questions.handle(caller, method, path, parse_qs(query), body)
            return route.fulfill(status=status, json=data)
        return super().api(route, request, method, path, query)


class CriticalResultConnectionDOM(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.pw = sync_playwright().start()
        cls.browser = cls.pw.chromium.launch()

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.pw.stop()

    def setUp(self):
        self.site = ConnectionSite()
        self.context = self.browser.new_context(viewport={"width": 1920, "height": 1080}, locale="ko-KR",
                                                timezone_id="Asia/Seoul")
        self.context.route("**/*", lambda route, request: self.site.handle(route, request))
        self.page = self.context.new_page()
        self.page.set_default_timeout(8000)
        self.errors = []
        self.page.on("pageerror", lambda e: self.errors.append(str(e)))

    def tearDown(self):
        self.context.close()
        self.assertEqual([], self.errors)
        self.assertEqual([], self.site.violations)

    # ── helpers: what a reader does and sees ──

    def open_study(self, approved=False):
        if approved:
            self.site.report = {"version": 1, "rs": "A", "findings": "SYN F", "conclusion": "SYN C", "recommendation": ""}
        self.page.goto(auth.MAIN_URL)
        expect(self.page.locator("#rows")).to_contain_text(auth.PATIENT)
        expect(self.page.get_by_text("Pending ACK 0", exact=True).first).to_be_visible()
        auth.show_all_panels(self.page)
        self.page.locator("#rows tr[data-uid]").first.click()
        expect(self.page.locator("#rows tr[data-uid]").first).to_have_class(re.compile(r"\bsel\b"))
        settle(self.page)

    def open_more(self):
        more = self.page.locator("#report-more")
        if more.get_attribute("open") is None:
            self.page.locator("#report-more > summary").click()
        expect(more).to_have_attribute("open", "")

    def mark(self):
        return self.page.locator("#b-mark-cvr")

    def disconnect(self):
        self.page.evaluate(DISCONNECT)
        expect(self.page.locator("#dbstat")).to_contain_text("서버 연결 끊김")

    def reconnect(self):
        self.page.evaluate(RECONNECT)
        expect(self.page.locator("#dbstat")).to_contain_text("DB Connected")
        settle(self.page)

    def wait(self, check, what, timeout=8000):
        wait_until(self.page, check, what, timeout / 1000)

    def question_posts(self):
        return [entry for entry in self.site.question_log if entry[0] == "POST"]

    def open_thread(self):
        question = self.site.questions.seed(auth.UID, q.CLINICIAN, "SYN question for the connection rule")
        self.open_study()
        notice = self.page.locator("#question-notice")
        expect(notice).to_be_visible()
        notice.click()
        self.page.locator("#question-list button[data-open-thread]").click()
        expect(self.page.locator("#question-thread")).to_have_attribute("data-state", "Open")
        return question

    def compose(self, action):
        return self.page.locator(f'#question-thread .question-compose[data-action="{action}"]')

    # ── Mark CVR ──

    def test_more_left_open_through_approve_turns_mark_cvr_on(self):
        """The reader looked at More before approving and left it open: once the approval is accepted Mark CVR turns on
        where it stands (it said "before reading" until More was closed and opened again)."""
        self.open_study()
        self.page.locator("#findings").fill("SYN findings for approve")
        self.page.locator("#conclusion").fill("SYN conclusion")
        self.open_more()
        expect(self.mark()).to_be_disabled()
        expect(self.mark()).to_have_attribute("title", NOT_SENDABLE)
        self.page.locator("#b-approve").click()
        self.wait(lambda: self.site.report.get("rs") == "A", "the approval")
        expect(self.page.locator("#report-more")).to_have_attribute("open", "")
        expect(self.mark()).to_be_enabled()
        self.assertIn("판독 판 v1", self.mark().get_attribute("title"))
        self.assertEqual(["W", "A"], self.site.recipient_reads)
        self.mark().click()
        expect(self.page.locator("#cvr-send")).to_be_visible()

    def test_mark_cvr_says_the_connection_and_comes_back_with_it(self):
        """Lost connection: Mark CVR is off and says why (it stayed on and did nothing). Back: on again, no new read."""
        self.open_study(approved=True)
        self.open_more()
        expect(self.mark()).to_be_enabled()
        reads = len(self.site.recipient_reads)
        self.disconnect()
        expect(self.mark()).to_be_disabled()
        expect(self.mark()).to_have_attribute("title", ENTRY_OFFLINE)
        # A repaint of the same study while the connection is lost is not a move: nothing is read and nothing is lost.
        self.page.evaluate("() => renderClinical()")
        self.reconnect()
        expect(self.mark()).to_be_enabled()
        self.assertEqual(reads, len(self.site.recipient_reads))

    def test_window_read_answered_during_the_outage_is_usable_once_back(self):
        """The window's recipient read is answered while the connection is lost: once back, the recipient list, the
        message and Send are usable (they stayed locked until the window was closed and opened again)."""
        self.open_study(approved=True)
        self.open_more()
        expect(self.mark()).to_be_enabled()
        self.site.held_recipients = []
        self.mark().click()
        expect(self.page.locator("#cvr-send")).to_be_visible()
        self.wait(lambda: len(self.site.held_recipients) == 1, "the window's recipient read")
        self.disconnect()
        held, self.site.held_recipients = self.site.held_recipients, None
        for route, body in held:
            route.fulfill(json=body)
        expect(self.page.locator(f'#cvr-send-recipient input[value="{CLIN["sub"]}"]')).to_have_count(1)
        expect(self.page.locator("#cvr-send-recipient")).to_be_disabled()
        expect(self.page.locator("#cvr-send-submit")).to_be_disabled()
        self.assertTrue(self.page.locator("#cvr-send-message").evaluate("e => e.readOnly"))
        # Any repaint of the same study meanwhile keeps the window and its answer.
        self.page.evaluate("() => renderClinical()")
        expect(self.page.locator("#cvr-send")).to_be_visible()
        self.reconnect()
        expect(self.page.locator("#cvr-send")).to_be_visible()
        expect(self.page.locator("#cvr-send-recipient")).to_be_enabled()
        self.assertFalse(self.page.locator("#cvr-send-message").evaluate("e => e.readOnly"))
        self.page.locator(f'#cvr-send-recipient input[value="{CLIN["sub"]}"]').check()
        self.page.locator("#cvr-send-message").fill("SYN critical finding written once back")
        expect(self.page.locator("#cvr-send-submit")).to_be_enabled()
        # Lost again with the window filled in: Send is off, the recipient and message stay; back, they are as left.
        self.disconnect()
        expect(self.page.locator("#cvr-send-submit")).to_be_disabled()
        self.reconnect()
        expect(self.page.locator("#cvr-send-submit")).to_be_enabled()
        self.assertEqual((CLIN["sub"], "SYN critical finding written once back"),
                         (self.page.evaluate("() => [...document.querySelectorAll('#cvr-send-recipient input:checked')].map(i => i.value).join(',')"),
                          self.page.locator("#cvr-send-message").input_value()))

    def test_a_read_that_left_before_the_outage_and_fails_once_back_is_read_again(self):
        """The approval's Mark CVR read is still out when the connection is lost and comes back, and fails only then: Mark
        CVR is read again and turns on (it stayed off, closing and opening More did not help)."""
        self.open_study()
        self.page.locator("#findings").fill("SYN findings for approve")
        self.page.locator("#conclusion").fill("SYN conclusion")
        self.open_more()
        expect(self.mark()).to_have_attribute("title", NOT_SENDABLE)
        self.site.held_recipients = []
        self.page.locator("#b-approve").click()
        self.wait(lambda: len(self.site.held_recipients) == 1, "the approval's Mark CVR read")
        held, self.site.held_recipients = self.site.held_recipients, None
        self.disconnect()
        self.reconnect()
        for route, _ in held:
            route.abort("connectionreset")
        expect(self.mark()).to_be_enabled()
        self.assertIn("판독 판 v1", self.mark().get_attribute("title"))
        self.assertEqual(["W", "A", "A"], self.site.recipient_reads)

    def test_a_window_read_that_left_before_the_outage_and_fails_once_back_is_read_again(self):
        """The window's recipient read is still out when the connection is lost and comes back, and fails only then: the
        window reads again and its recipient list and Send are usable (they stayed locked)."""
        self.open_study(approved=True)
        self.open_more()
        expect(self.mark()).to_be_enabled()
        self.site.held_recipients = []
        self.mark().click()
        expect(self.page.locator("#cvr-send")).to_be_visible()
        self.wait(lambda: len(self.site.held_recipients) == 1, "the window's recipient read")
        held, self.site.held_recipients = self.site.held_recipients, None
        self.disconnect()
        self.reconnect()
        for route, _ in held:
            route.abort("connectionreset")
        expect(self.page.locator("#cvr-send")).to_be_visible()
        expect(self.page.locator("#cvr-send-recipient")).to_be_enabled()
        self.page.locator(f'#cvr-send-recipient input[value="{CLIN["sub"]}"]').check()
        self.page.locator("#cvr-send-message").fill("SYN critical finding after the late failure")
        expect(self.page.locator("#cvr-send-submit")).to_be_enabled()

    # ── study questions ──

    def test_reply_and_close_wait_for_the_connection_and_keep_the_text(self):
        """Lost connection: Reply and Close are off and say why; pressing them sends nothing; the text stays. Back: Reply
        sends it (they sent while the row said the connection was lost)."""
        self.open_thread()
        self.page.locator("#question-reply-text").fill("SYN reply kept through the outage")
        self.page.locator("#question-close-text").fill("SYN close reason kept")
        self.disconnect()
        for action in ("reply", "close"):
            send = self.compose(action).locator("button[data-send]")
            expect(send).to_be_disabled()
            expect(send).to_have_attribute("title", WRITE_OFFLINE)
        # A script that presses anyway (or a stale paint) still sends nothing.
        self.page.evaluate("""() => document.querySelectorAll('#question-thread button[data-send]')
          .forEach(b => { b.disabled = false; b.click(); })""")
        settle(self.page)
        self.assertEqual([], self.question_posts())
        # A repaint of the same study meanwhile is not a move: the thread, its fields and the row stay, nothing is read.
        reads = len(self.site.question_log)
        self.page.evaluate("() => renderClinical()")
        settle(self.page)
        expect(self.page.locator("#question-thread")).to_have_attribute("data-state", "Open")
        self.assertEqual(reads, len(self.site.question_log))
        self.assertEqual("SYN reply kept through the outage", self.page.locator("#question-reply-text").input_value())
        self.assertEqual("SYN close reason kept", self.page.locator("#question-close-text").input_value())
        self.reconnect()
        send = self.compose("reply").locator("button[data-send]")
        expect(send).to_be_enabled()
        expect(send).to_have_attribute("title", "")
        send.click()
        expect(self.page.locator('#question-thread [data-note-key]:not([hidden])').first).to_have_attribute("data-state", "saved")
        self.assertEqual(1, len(self.question_posts()))
        self.assertEqual("SYN reply kept through the outage", self.question_posts()[0][2]["body"])

    def test_retry_of_an_unknown_reply_waits_for_the_connection(self):
        """A reply whose answer was lost leaves Retry and Discard. Lost connection: Retry is off and sends nothing;
        Discard still works on the page alone. Back: Retry sends the same request again."""
        self.open_thread()
        self.site.question_faults.append("before-apply")
        self.page.locator("#question-reply-text").fill("SYN reply whose answer was lost")
        self.compose("reply").locator("button[data-send]").click()
        retry = self.compose("reply").locator("button[data-retry]")
        expect(retry).to_be_visible()
        first = self.question_posts()[0][2]
        self.disconnect()
        expect(retry).to_be_visible()
        expect(retry).to_be_disabled()
        expect(retry).to_have_attribute("title", WRITE_OFFLINE)
        self.page.evaluate("() => { const b = document.querySelector('#question-thread [data-action=\"reply\"] button[data-retry]'); b.disabled = false; b.click(); }")
        settle(self.page)
        self.assertEqual(1, len(self.question_posts()))
        expect(self.compose("reply").locator("button[data-discard]")).to_be_enabled()
        self.reconnect()
        expect(retry).to_be_enabled()
        retry.click()
        expect(self.page.locator('#question-thread [data-note-key]:not([hidden])').first).to_have_attribute("data-state", "saved")
        self.assertEqual(2, len(self.question_posts()))
        self.assertEqual(first["requestId"], self.question_posts()[1][2]["requestId"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
