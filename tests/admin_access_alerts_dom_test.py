"""Access Alerts on the Admin page.

Serve the unchanged Admin document and its scripts; only API answers are synthetic.
The page reads alerts only on Check Alerts, shows the server's threshold and alerts, and opens an alert's span in
Access Review; a changed period, a refusal or a failure leaves no earlier alert on screen.
"""
from datetime import datetime, timedelta, timezone
import functools
import http.server
from pathlib import Path
import threading
import unittest
from urllib.parse import parse_qs, urlparse

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
FIRST, LAST = '2026-11-01T09:00:00.250Z', '2026-11-01T09:09:59.750Z'


def alert(identity='SYN-DOCTOR', first=FIRST, last=LAST):
    return dict(userId=dict(status='known', value=dict(id=identity, issuer='synthetic', subject='SYN-SUB')),
                firstAt=first, lastAt=last, studies=52, events=60, evidenceEntryId='SYN-ENTRY')


def review_row(event_id, at):
    known = lambda value: dict(status='known', value=value)
    return dict(eventId=event_id, occurredAt=at, recordedAt=at, statutoryAct='x', userId=known(dict(id='SYN-DOCTOR', issuer='s', subject='s')),
                rolesAtTime=known(['radiologist']), executor='member', actingInstitution=known('SYN-A'), managingInstitution=known('SYN-A'),
                trustedProxyIp=dict(status='unresolved', reason='not-observed'), targets=[], surface='GET image', action='provide-prepared',
                result='prepared', cause='user-view', context=None)


class AccessAlertsPage(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        class Quiet(http.server.SimpleHTTPRequestHandler):
            def log_message(self, *args): pass
        cls.server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), functools.partial(Quiet, directory=str(ROOT)))
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.pw = sync_playwright().start()
        cls.browser = cls.pw.chromium.launch(headless=True)

    @classmethod
    def tearDownClass(cls):
        cls.browser.close(); cls.pw.stop(); cls.server.shutdown(); cls.server.server_close(); cls.thread.join()

    def setUp(self):
        self.context = self.browser.new_context(viewport={'width': 1440, 'height': 1000})
        self.page = self.context.new_page()
        self.alert_replies, self.alert_calls, self.review_calls, self.errors = [], [], [], []
        self.review_replies, self.review_held = [], []
        self.page.on('pageerror', lambda error: self.errors.append(str(error)))
        self.page.route('**/api/**', self.api)
        self.page.goto(f'http://127.0.0.1:{self.server.server_port}/worklist-v0/hpacs-lite/admin.html')
        self.page.wait_for_function("!document.getElementById('access-alerts-load').disabled")
        self.page.wait_for_function("!document.getElementById('access-review-load').disabled")

    def tearDown(self):
        self.context.close()
        self.assertEqual(self.errors, [])

    def api(self, route):
        url = urlparse(route.request.url)
        query = parse_qs(url.query)
        if url.path == '/api/me':
            route.fulfill(json=dict(sub='SYN-ADMIN', user='SYN Admin', roles=['admin'], institution='SYN-A', sessionId='SYN-SESSION'))
        elif url.path == '/api/admin/users':
            route.fulfill(json=dict(page=1, pageSize=25, total=0, pendingCount=0, users=[]))
        elif url.path == '/api/admin/audit' and query.get('report') == ['access-alerts']:
            self.alert_calls.append(query)
            status, body = self.alert_replies.pop(0)
            if status == 200:
                body = dict(institutionId='SYN-A', **{'from': query['from'][0]}, until=query['until'][0],
                            observedAt=query['until'][0], threshold=dict(studies=50, minutes=10), **body)
            route.fulfill(status=status, json=body)
        elif url.path == '/api/admin/audit' and query.get('report') == ['access']:
            self.review_calls.append(query)
            reply = self.review_replies.pop(0) if self.review_replies else (200, [])
            if reply == 'hold':
                self.review_held.append((route, query))
                return
            status, rows = reply
            route.fulfill(status=status, json=dict(institutionId='SYN-A', **{'from': query['from'][0]}, until=query['until'][0],
                                                    rows=rows, next=None) if status == 200 else dict(message='refused'))
        elif url.path == '/api/auth/logout': route.fulfill(status=204)
        else: route.fulfill(status=404, json={})

    def state(self):
        return self.page.locator('#access-alerts-state').inner_text()

    def check(self, status=200, body=None):
        self.alert_replies.append((status, body if body is not None else dict(alerts=[])))
        self.page.get_by_role('button', name='Check Alerts', exact=True).click()
        self.page.wait_for_function("!['Checking', 'Not Loaded'].includes(document.getElementById('access-alerts-state').textContent)")

    def test_no_read_on_open_then_last_day_threshold_and_alert_row(self):
        self.assertEqual(self.alert_calls, [])
        self.assertEqual(self.state(), 'Not Loaded')
        self.assertTrue(self.page.locator('#access-alerts-wrap').is_hidden())
        before = datetime.now(timezone.utc)
        self.check(body=dict(alerts=[alert()]))
        call = self.alert_calls[0]
        self.assertEqual(sorted(call), ['from', 'report', 'until'])
        since, until = (datetime.fromisoformat(call[k][0].replace('Z', '+00:00')) for k in ('from', 'until'))
        self.assertEqual(until - since, timedelta(days=1))
        self.assertLessEqual(abs((until - before).total_seconds()), 5)
        self.assertEqual(self.state(), 'Alerts Found')
        scope = self.page.locator('#access-alerts-scope').inner_text()
        self.assertIn('10분 안에 서로 다른 검사 50건 이상', scope)
        self.assertIn('경보 1건', scope)
        rows = self.page.locator('#access-alerts-rows tr')
        self.assertEqual(rows.count(), 1)
        text = rows.first.inner_text()
        for expected in ['SYN-DOCTOR', FIRST, LAST, '52', '60']:
            self.assertIn(expected, text)
        self.assertEqual(rows.first.locator('td[translate="no"]').count(), 5)

    def test_review_opens_the_alert_span_in_access_review(self):
        self.page.get_by_label('Events', exact=False).select_option('files')
        self.check(body=dict(alerts=[alert()]))
        self.page.locator('#access-alerts-rows').get_by_role('button', name='Review', exact=True).click()
        self.page.wait_for_function("document.getElementById('access-review-state').textContent === 'No Events'")
        self.assertEqual(self.review_calls, [dict(report=['access'], **{'from': ['2026-11-01T09:00:00.000Z']},
                                                  until=['2026-11-01T09:10:00.000Z'], downloads=['all'])])

    def test_none_failure_refusal_and_period_change_leave_no_earlier_alert(self):
        self.check()
        self.assertEqual(self.state(), 'No Alerts')
        self.assertTrue(self.page.locator('#access-alerts-wrap').is_hidden())
        self.assertIn('경보 기준에 닿은 열람이 없습니다', self.page.locator('#access-alerts-message').inner_text())
        self.check(body=dict(alerts=[alert()]))
        self.check(503, dict(message='기간 안의 열람 기록이 너무 많아 경보를 판정하지 못했습니다. 기간을 줄여 다시 조회하세요.'))
        self.assertEqual(self.state(), 'Check Failed')
        self.assertEqual(self.page.locator('#access-alerts-rows tr').count(), 0)
        self.assertIn('기간을 줄여', self.page.locator('#access-alerts-message').inner_text())
        self.check(body=dict(alerts=[alert()]))
        self.check(403, dict(message='forbidden'))
        self.assertEqual(self.state(), 'Check Failed')
        self.assertEqual(self.page.locator('#access-alerts-rows tr').count(), 0)
        self.check(body=dict(alerts=[alert()]))
        self.check(200, dict(alerts=[dict(alert(), studies='many')]))
        self.assertEqual(self.state(), 'Check Failed')
        self.assertEqual(self.page.locator('#access-alerts-rows tr').count(), 0)
        self.check(body=dict(alerts=[alert()]))
        self.page.get_by_label('Alert Period From (UTC)', exact=False).fill('2026-10-01T00:00')
        self.assertEqual(self.state(), 'Not Loaded')
        self.assertEqual(self.page.locator('#access-alerts-rows tr').count(), 0)

    def test_an_edited_period_is_used_as_written(self):
        self.page.get_by_label('Alert Period From (UTC)', exact=False).fill('2026-10-01T00:00')
        self.page.get_by_label('Alert Period Until (UTC, exclusive)', exact=False).fill('2026-10-08T00:00')
        self.check()
        self.assertEqual((self.alert_calls[0]['from'], self.alert_calls[0]['until']),
                         (['2026-10-01T00:00:00.000Z'], ['2026-10-08T00:00:00.000Z']))
        self.page.get_by_label('Alert Period Until (UTC, exclusive)', exact=False).fill('2026-09-01T00:00')
        self.page.get_by_role('button', name='Check Alerts', exact=True).click()
        self.assertEqual(len(self.alert_calls), 1)
        self.assertIn('종료 시각', self.page.locator('#access-alerts-message').inner_text())

    def test_a_second_review_while_the_first_is_loading_shows_only_the_second_span(self):
        day2 = ('2026-11-02T10:00:00.000Z', '2026-11-02T10:05:00.000Z')
        self.check(body=dict(alerts=[alert(), alert('SYN-OTHER', *day2)]))
        buttons = self.page.locator('#access-alerts-rows').get_by_role('button', name='Review', exact=True)
        self.review_replies.append('hold')
        buttons.nth(0).click()
        self.page.wait_for_function("document.getElementById('access-review-state').textContent === 'Loading'")
        self.review_replies.append((200, [review_row('SYN-DAY-2', day2[0])]))
        buttons.nth(1).click()
        self.page.wait_for_function("document.getElementById('access-review-state').textContent === 'Loaded'")
        route, query = self.review_held.pop()
        route.fulfill(json=dict(institutionId='SYN-A', **{'from': query['from'][0]}, until=query['until'][0],
                                rows=[review_row('SYN-DAY-1', FIRST)], next=None))
        self.page.wait_for_timeout(300)
        self.assertEqual([c['from'] for c in self.review_calls], [['2026-11-01T09:00:00.000Z'], ['2026-11-02T10:00:00.000Z']])
        text = self.page.locator('#access-review-rows').inner_text()
        self.assertIn('SYN-DAY-2', text)
        self.assertNotIn('SYN-DAY-1', text)
        self.assertEqual(self.page.locator('#access-review-from').input_value(), '2026-11-02T10:00')

    def test_a_refused_ledger_read_on_either_panel_clears_both(self):
        self.check(body=dict(alerts=[alert()]))
        self.review_replies.append((403, []))
        self.page.locator('#access-alerts-rows').get_by_role('button', name='Review', exact=True).click()
        self.page.wait_for_function("document.getElementById('access-review-state').textContent === 'Query Failed'")
        self.assertEqual(self.page.locator('#access-alerts-rows tr').count(), 0)
        self.assertTrue(self.page.locator('#access-alerts-wrap').is_hidden())
        self.assertEqual(self.state(), 'Not Loaded')
        self.page.get_by_label('From (UTC)', exact=True).fill('2026-11-01T00:00')
        self.page.get_by_label('Until (UTC, exclusive)', exact=True).fill('2026-11-02T00:00')
        self.review_replies.append((200, [review_row('SYN-SHOWN', FIRST)]))
        self.page.get_by_role('button', name='Load Review', exact=True).click()
        self.page.wait_for_function("document.getElementById('access-review-state').textContent === 'Loaded'")
        self.check(403, dict(message='forbidden'))
        self.assertEqual(self.page.locator('#access-review-rows tr').count(), 0)
        self.assertEqual(self.page.locator('#access-review-state').inner_text(), 'Not Loaded')


if __name__ == '__main__':
    unittest.main()
