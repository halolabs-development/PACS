# coding: utf-8
"""A study write that was not saved never looks saved: Match, Unmatch, Verify, Unverify and Delete on the Technician tab.

One rule (study-state.js studyWriteRoute, the gate Modify Exam uses too): on a signed-in page a study write is painted
and announced only from the server's accepted answer.

- While the page shows the connection as lost nothing is sent, each action says once that it was not saved (before any
  confirm; the Match… / Unmatch… windows say it inside the window), no refusal alert appears, and the study rows, the Order
  List, M and Verified stay as they were. The page's own reconnect then shows the server's rows.
- Online, Verify and Unverify paint and announce nothing while the answer is pending; a refusal keeps the row as the server
  has it and says the server's reason, an accepted answer paints the server's value and says so.
- The administrator's force release asks with words that say what the server does (the lock only; the draft stays, the
  release is audited, the writer can keep saving unless someone else takes the lock), in both screen languages.

Serves the real page and its assets; only HTTP answers are synthetic (auth_logout_dom_test.Site).
"""
import copy
import re
import unittest

from playwright.sync_api import expect, sync_playwright

import auth_logout_dom_test as auth
from row_menu_rights_dom_test import RightsSite, TECH
from unavailable_controls_dom_test import ORDER

DISCONNECT = "() => { goOffline(new Error('SYN disconnected')); stopReconnect(); }"
NOT_SAVED = '서버에 연결돼 있지 않습니다 — 저장되지 않았습니다'
SUCCESS = ('매칭 완료', '매칭을 해제했습니다', '검사를 확인했습니다', '확인을 해제했습니다', '검사를 삭제했습니다')
# Every text #toast shows, in order (the page writes the text, then adds the "show" class).
TOASTS = """() => { window.synToasts = []; const el = document.querySelector('#toast');
  new MutationObserver(() => { if (el.classList.contains('show')) window.synToasts.push(el.textContent); })
    .observe(el, { attributes: true, attributeFilter: ['class'], childList: true, characterData: true, subtree: true }); }"""
SNAPSHOT = """() => ({
  rows: [...document.querySelectorAll('#rows tr[data-uid]')].map(tr => [tr.dataset.uid, tr.innerText]),
  orders: [...document.querySelectorAll('#orderrows tr[data-oid]')].map(tr => [tr.dataset.oid, tr.innerText]),
  model: studies.map(s => [s.uid, s.matched, s.ss]).sort() })"""
RELEASE_KO = ('{0} 님의 점유를 강제로 해제할까요? 저장된 초안은 그대로 남고, 해제 내역은 감사로그에 기록됩니다. '
              '다른 사람이 먼저 점유하지 않으면 그분은 이어서 저장할 수 있습니다.')
RELEASE_EN = ("Force release {0}'s lock? Their saved draft will be kept, and the release will be recorded in the "
              "audit log. They can continue saving unless someone else takes the lock first.")

U = auth.UID + '.'
PLAIN, MATCHED, VERIFIED, DELETABLE = U + '0', U + '1', U + '2', U + '3'


class WritesSite(RightsSite):
    """Row 1 matched to the second order, row 2 Verified; every other row Unverified, unmatched, in W. Study writes can be
    held (answered later by the test)."""

    def __init__(self):
        super().__init__()
        self.states = {MATCHED: dict(matched='M', oid='SYN-O-2'), VERIFIED: dict(ss='Verified')}
        self.held = None   # a list: PATCH requests wait in it as (route, request)

    def list_body(self, account, rename=None):
        body = super().list_body(account, rename)
        for row in body['studies']:
            row['state'] = dict(row['state'], **self.states.get(row['uid'], {}))
        return body

    def api(self, route, request, method, path, query):
        if path in ('/api/bootstrap', '/api/prefs') and method == 'GET':
            account, refused = self.authenticate(request)
            if refused:
                return self.refuse(route, *refused)
            second = dict(ORDER, oid='SYN-O-2', id='SYN-ORDER-P2', name='SYN ORDER MATCHED', matched='M', studyUid=MATCHED)
            return route.fulfill(json=dict(statesOmitted=True, me=dict(actor=account['actor'], roles=account['roles'],
                institution=auth.INSTITUTION, institutionName='SYN Hospital A'), filters=self.filters, templates=[],
                institutions=[dict(id=auth.INSTITUTION, name='SYN Hospital A', type='hospital')],
                states={}, orders=[dict(ORDER), second], serverTime='2026-10-03T00:00:00.000Z'))
        if self.held is not None and method == 'PATCH' and path.startswith('/api/studies/'):
            return self.held.append((route, request))
        return super().api(route, request, method, path, query)

    def answer_held(self):
        held, self.held = self.held, None
        for route, request in held:
            super().api(route, request, request.method, '/api/studies/' + request.url.split('/api/studies/')[1], '')


class UnsavedStudyWritesDOM(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.pw = sync_playwright().start()
        cls.browser = cls.pw.chromium.launch()

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.pw.stop()

    def open(self, account=TECH, states=None, accept=True):
        self.site = WritesSite()
        self.site.account = account
        if states is not None:
            self.site.states = states
        context = self.browser.new_context(viewport={'width': 1600, 'height': 1000})
        self.addCleanup(context.close)
        context.route('**/*', lambda route, request: self.site.handle(route, request))
        page = context.new_page()
        page.set_default_timeout(8000)
        self.errors, self.dialogs = [], []
        page.on('pageerror', lambda e: self.errors.append(str(e)))

        def dialog(d):
            self.dialogs.append(d.message)
            d.accept() if accept else d.dismiss()
        page.on('dialog', dialog)
        page.goto(auth.MAIN_URL)
        expect(page.locator('#rows tr[data-uid]')).to_have_count(len(self.site.modalities))
        page.evaluate(TOASTS)
        self.page = page
        return page

    def technician(self):
        self.page.locator('[data-tab="Technician"]').click()
        expect(self.page.locator('#orderrows tr[data-oid]')).to_have_count(2)

    def tearDown(self):
        self.assertEqual([], self.errors)

    # ── helpers ──
    @property
    def menu(self):
        return self.page.locator('#ctx')

    def row(self, uid):
        return self.page.locator(f'#rows tr[data-uid="{uid}"]')

    def item(self, name):
        return self.menu.get_by_role('menuitem', name=name, exact=True)

    def press(self, uid, name):
        self.row(uid).click()
        self.row(uid).click(button='right')
        expect(self.menu).to_be_visible()
        expect(self.item(name)).to_have_attribute('aria-disabled', 'false')
        self.item(name).click()
        expect(self.menu).to_be_hidden()
        self.page.wait_for_timeout(300)

    def order_menu(self, oid, name):
        self.page.locator(f'#orderrows tr[data-oid="{oid}"]').click(button='right')
        expect(self.menu).to_be_visible()
        self.item(name).click()
        expect(self.menu).to_be_hidden()
        self.page.wait_for_timeout(300)

    def actions(self):
        """Each write once, from where a technician presses it (the bar, the row menus, the order menus)."""
        def bar(button):
            def run():
                self.row(PLAIN).click()
                self.page.locator(button).click()
                self.page.wait_for_timeout(300)
            return run

        def match_from_order():
            self.row(PLAIN).click()
            self.order_menu('SYN-O-1', 'Match')
        return [('Match (order menu)', match_from_order),
                ('Match (row menu)', lambda: (self.page.locator('#orderrows tr[data-oid="SYN-O-1"]').click(),
                                              self.press(PLAIN, 'Match'))),
                ('Unmatch (row menu)', lambda: self.press(MATCHED, 'Unmatch')),
                ('Unmatch (order menu)', lambda: self.order_menu('SYN-O-2', 'Unmatch')),
                ('Verify (row menu)', lambda: self.press(PLAIN, 'Verify')),
                ('Verify (bar)', bar('#t-verify')),
                ('Unverify (row menu)', lambda: self.press(VERIFIED, 'Unverify')),
                ('Delete (row menu)', lambda: self.press(DELETABLE, 'Delete'))]

    def toasts(self):
        return self.page.evaluate('() => window.synToasts')

    def success(self):
        return [t for t in self.toasts() if any(s in t for s in SUCCESS)]

    def selected(self):
        return self.page.evaluate('() => selectedUid')

    # ── disconnected ──
    def test_disconnected_writes_send_nothing_change_nothing_and_say_so_once_each(self):
        page = self.open()
        self.technician()
        self.row(PLAIN).click()
        before = page.evaluate(SNAPSHOT)
        page.evaluate(DISCONNECT)
        for name, run in self.actions():
            with self.subTest(action=name):
                toasts, dialogs, selected = len(self.toasts()), len(self.dialogs), self.selected()
                run()
                said = self.toasts()[toasts:]
                self.assertEqual(1, sum(NOT_SAVED in t for t in said), said)
                self.assertEqual([], [t for t in said if any(s in t for s in SUCCESS)], said)
                self.assertEqual([], self.dialogs[dialogs:], 'a confirm or a refusal alert for a write that is never sent')
                self.assertEqual(before['model'], page.evaluate(SNAPSHOT)['model'])
                if name == 'Unmatch (order menu)':
                    self.assertEqual(selected, self.selected(), 'the order menu moved the selection to the matched study')
        after = page.evaluate(SNAPSHOT)
        self.assertEqual(before['orders'], after['orders'])
        self.assertEqual(dict(before['rows']), dict(after['rows']))
        self.assertEqual([], self.site.writes, 'a write left a page that shows the connection as lost')
        # The page's own reconnect: here the server has meanwhile verified the plain row; the matched row is still M.
        self.site.states[PLAIN] = dict(ss='Verified')
        page.locator('#dbstat').click()
        page.wait_for_function("() => studies.find(s => s.uid === %r)?.ss === 'Verified'" % PLAIN)
        self.assertEqual(['M', 'Verified'], page.evaluate(
            "() => [studies.find(s => s.uid === %r).matched, studies.find(s => s.uid === %r).ss]" % (MATCHED, PLAIN)))
        self.assertEqual('M', page.locator(f'#rows tr[data-uid="{MATCHED}"] .mt').inner_text())
        self.assertEqual([], self.site.writes)

    def test_disconnected_match_and_unmatch_windows_say_it_in_the_window(self):
        page = self.open()
        self.technician()
        self.row(PLAIN).click()
        page.locator('#orderrows tr[data-oid="SYN-O-1"]').click()
        page.evaluate(DISCONNECT)
        page.locator('#order-actions > button', has_text=re.compile('^Match…$')).click()
        w = page.locator("dialog[data-order-window='order-match']")
        toasts = len(self.toasts())
        w.get_by_role('button', name='Match').click()
        expect(w.locator('.order-note.err')).to_contain_text(NOT_SAVED)
        expect(w.get_by_role('button', name='Match')).to_be_enabled()
        w.get_by_role('button', name='Close').click()
        self.row(MATCHED).click()
        page.locator('#order-actions > button', has_text=re.compile('^Unmatch…$')).click()
        w = page.locator("dialog[data-order-window='order-unmatch']")
        w.get_by_label('Reason').fill('SYN reason')
        w.get_by_role('button', name='Unmatch').click()
        expect(w.locator('.order-note.err')).to_contain_text(NOT_SAVED)
        self.assertEqual([], [t for t in self.toasts()[toasts:] if NOT_SAVED in t or any(s in t for s in SUCCESS)])
        self.assertEqual([], self.dialogs)
        self.assertEqual([], self.site.writes)

    # ── online ──
    def test_refused_writes_never_announce_success(self):
        page = self.open()
        self.technician()
        self.row(PLAIN).click()
        before = page.evaluate(SNAPSHOT)
        self.site.refuse_writes = (409, 'SYN 서버가 이 변경을 거절했습니다')
        names = []
        for name, run in self.actions():
            with self.subTest(action=name):
                writes, toasts, dialogs = len(self.site.writes), len(self.toasts()), len(self.dialogs)
                run()
                page.wait_for_timeout(300)
                self.assertEqual(writes + 1, len(self.site.writes), 'the write was not sent')
                said = self.toasts()[toasts:] + self.dialogs[dialogs:]
                self.assertTrue(any('SYN 서버가 이 변경을 거절했습니다' in t for t in said), said)
                self.assertEqual([], [t for t in said if any(s in t for s in SUCCESS)], said)
                self.assertEqual(before['model'], page.evaluate(SNAPSHOT)['model'])
                names.append(name)
        self.assertEqual(dict(before['rows']), dict(page.evaluate(SNAPSHOT)['rows']))

    def test_verify_and_unverify_paint_nothing_while_the_answer_is_pending(self):
        page = self.open()
        self.technician()
        for uid, name, value in ((PLAIN, 'Verify', 'Verified'), (VERIFIED, 'Unverify', 'Unverified')):
            for refused in (True, False):
                with self.subTest(action=name, refused=refused):
                    self.row(uid).click()
                    was = page.evaluate("() => studies.find(s => s.uid === %r).ss" % uid)
                    text = self.row(uid).inner_text()
                    self.site.refuse_writes = (409, 'SYN 서버가 이 변경을 거절했습니다') if refused else None
                    self.site.held = []
                    toasts = len(self.toasts())
                    self.press(uid, name)
                    page.wait_for_timeout(300)
                    self.assertEqual(1, len(self.site.held), 'the PATCH was not sent')
                    self.assertEqual(was, page.evaluate("() => studies.find(s => s.uid === %r).ss" % uid))
                    self.assertEqual(text, self.row(uid).inner_text())
                    self.assertEqual([], self.success(), 'announced before the answer')
                    self.site.answer_held()
                    if refused:
                        expect(page.locator('#toast')).to_contain_text('SYN 서버가 이 변경을 거절했습니다')
                        page.wait_for_timeout(300)
                        self.assertEqual(was, page.evaluate("() => studies.find(s => s.uid === %r).ss" % uid))
                        self.assertEqual([], self.success())
                    else:
                        page.wait_for_function("() => studies.find(s => s.uid === %r).ss === %r" % (uid, value))
                        self.assertEqual(1, len([t for t in self.toasts()[toasts:] if any(s in t for s in SUCCESS)]))
                        # The server's value stays the row's for the next round (the list read keeps it too).
                        self.site.states[uid] = dict(self.site.states.get(uid, {}), ss=value)
                        page.evaluate('() => { window.synToasts.length = 0; }')
                        # Back to where it was for the refused round of the other action.
                        self.site.states[uid]['ss'] = was
                        page.locator('#m-refresh').click()
                        page.wait_for_function("() => studies.find(s => s.uid === %r).ss === %r" % (uid, was))

    def test_accepted_writes_still_announce(self):
        page = self.open()
        self.technician()
        self.press(PLAIN, 'Verify')
        page.wait_for_function("() => studies.find(s => s.uid === %r)?.ss === 'Verified'" % PLAIN)
        self.assertTrue(any('검사를 확인했습니다' in t for t in self.toasts()), self.toasts())

    # ── force release words ──
    def test_force_release_confirm_says_what_the_server_does_in_both_languages(self):
        holder = {PLAIN: dict(holder='syn-other@synthetic.test', heldAt='2026-10-03T00:00:00.000Z')}
        page = self.open(auth.ADMIN, states=holder, accept=False)
        name = page.evaluate("() => displayActor('syn-other@synthetic.test')")
        self.assertTrue(name)
        for lang, words in (('ko', RELEASE_KO), ('en', RELEASE_EN)):
            with self.subTest(lang=lang):
                page.evaluate("lang => KinLanguage.restore({ version: 1, worklist: lang, reading: lang })", lang)
                self.dialogs.clear()
                self.row(PLAIN).click(button='right')
                expect(self.menu).to_be_visible()
                self.menu.get_by_role('menuitem').filter(has_text=re.compile('점유 강제 해제|Force')).click()
                page.wait_for_timeout(300)
                self.assertEqual(1, len(self.dialogs), self.dialogs)
                self.assertEqual([words.format(name)], self.dialogs)
        self.assertFalse(any(p.endswith('/release/force') for _, p in self.site.calls), 'dismissed: nothing sent')


if __name__ == '__main__':
    unittest.main()
