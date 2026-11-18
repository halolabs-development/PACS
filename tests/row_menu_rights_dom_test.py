# coding: utf-8
"""The worklist row menu and the order row menu: who may do what, the keyboard, and the tele-reading items.

- Rights: "may this account do technician work on a study" is answered in one place (technicianWork, page-boot.js) and
  the Technician bar's buttons and the row and order menus use that one answer. A radiologist-only account sees the
  Technician tab's write items (Match, Unmatch, Verify, Unverify, Modify Exam, Switch ReqHosp, Delete) grey with the
  same reason as the bar, and pressing them sends nothing. Changing the tab grants nothing. A refusal the server still
  gives is said on the screen.
- Keyboard: the ContextMenu key or Shift+F10 on a focused row (or order row) opens its menu with the first item focused;
  Up, Down, Home, End, Escape and Enter work in it, and closing it puts the focus back on that row. A menu opened with
  the mouse is unchanged (the focus stays where it was).
- Tele-reading is a later feature: Tele Request, Cancel Request and Start Reading (Receiving Institution) stay in the
  Radiology row menu by name and place, and pressing one only says so; nothing is sent.

The worklist page and bundle are the committed files; only HTTP answers are synthetic (auth_logout_dom_test.Site).
"""
import copy
import json
import re
import unittest

from playwright.sync_api import expect, sync_playwright
import auth_logout_dom_test as auth
from unavailable_controls_dom_test import OrderSite, ORDER

NEED_TECH = '방사선사(technician) 권한이 필요합니다'
LATER = '원격판독은 나중에 생길 기능입니다 — 지금은 의뢰·취소·판독 시작을 보내지 않습니다'
TECH_WRITES = ('Match', 'Unmatch', 'Verify', 'Unverify', 'Modify Exam', 'Switch ReqHosp', 'Delete')
TELE_ITEMS = ('원격판독 의뢰 (Tele Request)', '의뢰 취소', '판독 시작 (수신 기관)')
TECH = {**auth.RAD, 'sub': 'SYN-TECH-SUB', 'actor': 'syn-tech@synthetic.test', 'user': 'syn-tech@synthetic.test',
        'displayName': 'SYN Tech Han', 'roles': ['technician']}
BOTH = {**auth.RAD, 'roles': ['radiologist', 'technician']}


class RightsSite(OrderSite):
    """Unverified rows in W, one more institution to send tele-reading to, and the server's role rule on the writes."""

    def __init__(self):
        super().__init__()
        self.writes = []
        self.refuse_writes = None   # (status, message): every study write is refused with it

    def list_body(self, account, rename=None):
        body = super().list_body(account, rename)
        for row in body['studies']:
            row['state'] = dict(row['state'], ss='Unverified', rs='W')
        return body

    def api(self, route, request, method, path, query):
        if path in ('/api/bootstrap', '/api/prefs') and method == 'GET':
            account, refused = self.authenticate(request)
            if refused:
                return self.refuse(route, *refused)
            return route.fulfill(json=dict(statesOmitted=True, me=dict(actor=account['actor'], roles=account['roles'],
                institution=auth.INSTITUTION, institutionName='SYN Hospital A'), filters=self.filters, templates=[],
                institutions=[dict(id=auth.INSTITUTION, name='SYN Hospital A', type='hospital'),
                              dict(id='SYN-CENTER', name='SYN Reading Center', type='center')],
                states={}, orders=[dict(ORDER)], serverTime='2026-10-03T00:00:00.000Z'))
        if method == 'GET' and path == '/api/studies' and not query:
            # The page reads the list again after a refused write (study-state.js saveApp) to show the server's state.
            account, refused = self.authenticate(request)
            if refused:
                return self.refuse(route, *refused)
            return route.fulfill(json=self.list_body(account))
        study = re.fullmatch(r'/api/studies/([^/]+)', path)
        if (study and method in ('PATCH', 'DELETE')) or (method == 'POST' and path in ('/api/match', '/api/unmatch')):
            account, refused = self.authenticate(request)
            if refused:
                return self.refuse(route, *refused)
            body = request.post_data_json if request.post_data else None
            self.writes.append((method, path, body))
            if self.refuse_writes:
                status, message = self.refuse_writes
                return route.fulfill(status=status, json={'statusCode': status, 'message': message})
            # The server's rule (api/src/pacs/access.ts need): technician fields need technician (or admin).
            roles = account['roles']
            if 'technician' not in roles and 'admin' not in roles and not (method == 'PATCH' and set(body or {}) <= {'ts', 'teleTo'}):
                return route.fulfill(status=403, json={'statusCode': 403, 'message': 'SYN 검사 정보 변경은 technician 권한이 필요합니다'})
            if method == 'DELETE':
                return route.fulfill(json={'ok': True})
            uid = study.group(1) if study else (body or {}).get('uid')
            row = next(r for r in self.list_body(account)['studies'] if r['uid'] == uid)
            return route.fulfill(json=dict(row['state'], **{k: v for k, v in (body or {}).items() if k in ('ss', 'reqHosp', 'ts')}))
        return super().api(route, request, method, path, query)


class RowMenuRightsDOM(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.pw = sync_playwright().start()
        cls.browser = cls.pw.chromium.launch()

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.pw.stop()

    def open(self, account, width=1600, height=1000):
        self.site = RightsSite()
        self.site.account = account
        context = self.browser.new_context(viewport={'width': width, 'height': height})
        self.addCleanup(context.close)
        context.route('**/*', lambda route, request: self.site.handle(route, request))
        page = context.new_page()
        self.errors, self.dialogs = [], []
        page.on('pageerror', lambda e: self.errors.append(str(e)))

        def dialog(d):
            self.dialogs.append(d.message)
            d.accept()
        page.on('dialog', dialog)
        page.goto(auth.MAIN_URL)
        expect(page.locator('#rows tr[data-uid]')).to_have_count(len(self.site.modalities))
        self.page = page
        return page

    @property
    def menu(self):
        return self.page.locator('#ctx')

    def item(self, name):
        return self.menu.get_by_role('menuitem', name=name, exact=True)

    def row(self, i=0):
        return self.page.locator('#rows tr[data-uid]').nth(i)

    def technician_tab(self):
        self.page.locator('[data-tab="Technician"]').click()
        expect(self.page.locator('#orderrows tr[data-oid]').first).to_be_visible()

    def radiology_tab(self):
        self.page.locator('[data-tab="Radiology"]').click()

    def row_menu(self, i=0):
        self.row(i).click(button='right')
        expect(self.menu).to_be_visible()

    def close_menu(self):
        self.page.keyboard.press('Escape')
        if self.menu.is_visible():
            self.page.mouse.click(5, 5)
        expect(self.menu).to_be_hidden()

    def non_get(self):
        return [w for w in self.site.writes]

    # ── rights ──
    def test_radiologist_only_technician_menus_follow_the_toolbar(self):
        """A radiologist-only account: the Technician bar's buttons are grey with the reason, and the row menu's and the
        order menu's write items are grey with the same reason; pressing them sends nothing. Tab changes grant nothing."""
        page = self.open(auth.RAD)
        for round in range(2):
            self.technician_tab()
            self.row(0).click()
            for button in ('#t-verify', '#t-unverify', '#t-modify'):
                expect(page.locator(button)).to_be_disabled()
                expect(page.locator(button)).to_have_attribute('title', NEED_TECH)
            self.row_menu(0)
            for name in TECH_WRITES:
                expect(self.item(name)).to_have_attribute('aria-disabled', 'true')
                expect(self.item(name)).to_have_attribute('title', NEED_TECH)
            for name in TECH_WRITES:
                if not self.menu.is_visible():
                    self.row_menu(0)
                self.item(name).click(force=True)
            page.wait_for_timeout(300)
            self.close_menu()
            for name in ('Match', 'Unmatch'):
                if not self.menu.is_visible():
                    page.locator('#orderrows tr[data-oid]').first.click(button='right')
                expect(self.item(name)).to_have_attribute('aria-disabled', 'true')
                expect(self.item(name)).to_have_attribute('title', NEED_TECH)
                self.item(name).click(force=True)
            page.wait_for_timeout(300)
            self.close_menu()
            # The Order List action row's technician work: the same answer and reason; no window opens.
            for name in ('Delete Order', 'Match…', 'Unmatch…'):
                button = page.locator('#order-actions').get_by_role('button', name=name, exact=True)
                expect(button).to_be_disabled()
                expect(button).to_have_attribute('title', NEED_TECH)
            expect(page.locator('dialog[data-order-window]')).to_have_count(0)
            self.assertEqual([], self.site.writes, 'a grey item sent a write')
            self.assertEqual([], self.dialogs)
            # Radiology and back: the same answer.
            self.radiology_tab()
        self.assertEqual([], self.errors)

    def test_technician_admin_and_both_keep_the_items(self):
        """Accounts with technician work (technician, radiologist+technician, admin) see the items as before: Verify on
        an Unverified W row is offered and sends the PATCH; no item carries the technician reason."""
        for account in (TECH, BOTH, auth.ADMIN):
            with self.subTest(roles=account['roles']):
                page = self.open(account)
                self.technician_tab()
                self.row(0).click()
                expect(page.locator('#t-verify')).to_be_enabled()
                for name in ('Delete Order', 'Match…', 'Unmatch…'):
                    expect(page.locator('#order-actions').get_by_role('button', name=name, exact=True)).to_be_enabled()
                self.row_menu(0)
                for name in ('Verify', 'Modify Exam', 'Switch ReqHosp', 'Delete'):
                    expect(self.item(name)).to_have_attribute('aria-disabled', 'false')
                self.assertEqual([], self.menu.locator('[role=menuitem][title]').evaluate_all(
                    'els=>els.filter(e=>e.title===' + json.dumps(NEED_TECH) + ').map(e=>e.textContent)'))
                self.item('Verify').click()
                expect(self.menu).to_be_hidden()
                page.wait_for_function('() => document.querySelector("#rows tr[data-uid]")')
                self.assertTrue(any(m == 'PATCH' and b == {'ss': 'Verified'} for m, _, b in self.site.writes), self.site.writes)
                self.assertEqual([], self.errors)

    def test_a_server_refusal_is_said(self):
        """The server may still refuse (a role taken away after sign-in): the page says the server's reason and keeps the
        row as the server has it."""
        page = self.open(TECH)
        self.technician_tab()
        self.row(0).click()
        self.site.refuse_writes = (403, 'SYN 검사 정보 변경은 technician 권한이 필요합니다')
        self.row_menu(0)
        self.item('Verify').click()
        toast = page.locator('#toast')
        expect(toast).to_contain_text('SYN 검사 정보 변경은 technician 권한이 필요합니다')
        expect(self.row(0)).not_to_contain_text('Verified')
        # Delete gets its own refusal words: the toast must be Delete's, after a DELETE that was really sent.
        self.site.refuse_writes = (403, 'SYN 검사 삭제는 technician 권한이 필요합니다')
        page.evaluate("() => { document.querySelector('#toast').textContent = ''; }")
        self.row_menu(0)
        self.item('Delete').click()
        expect(toast).to_contain_text('SYN 검사 삭제는 technician 권한이 필요합니다')
        self.assertTrue(any(m == 'DELETE' for m, _, _ in self.site.writes), self.site.writes)
        expect(page.locator('#rows tr[data-uid]')).to_have_count(len(self.site.modalities))
        self.assertEqual([], self.errors)

    # ── keyboard ──
    def keyboard_round(self, key):
        page = self.page
        self.row(1).click()
        expect(self.row(1)).to_be_focused()
        # Every contextmenu the browser fires for this key press (Chromium: after keydown; Windows' menu key: on keyup,
        # at the focused item) is dropped: none reaches the page's handlers or opens the browser's own menu.
        page.evaluate("() => { window.synMenuEvents = []; if (!window.synMenuWatch) { window.synMenuWatch = true; "
                      "window.addEventListener('contextmenu', e => window.synMenuEvents.push(e), true); } }")
        page.keyboard.press(key)
        expect(self.menu).to_be_visible()
        enabled = self.menu.locator('[role=menuitem][aria-disabled=false]')
        expect(enabled.first).to_be_focused()
        page.wait_for_timeout(100)
        fired = page.evaluate('() => window.synMenuEvents.map(e => e.defaultPrevented)')
        if not fired:
            # This browser fired none after the prevented keydown: send the one Windows sends on keyup, at the focused item.
            fired = [page.evaluate("() => { const ev = new MouseEvent('contextmenu', {bubbles: true, cancelable: true}); "
                                   "document.activeElement.dispatchEvent(ev); return ev.defaultPrevented; }")]
        self.assertNotIn(False, fired)
        expect(self.menu).to_be_visible()
        expect(enabled.first).to_be_focused()
        page.keyboard.press('ArrowDown')
        expect(enabled.nth(1)).to_be_focused()
        page.keyboard.press('End')
        expect(enabled.last).to_be_focused()
        page.keyboard.press('Home')
        expect(enabled.first).to_be_focused()
        page.keyboard.press('ArrowUp')
        expect(enabled.last).to_be_focused()
        page.keyboard.press('Escape')
        expect(self.menu).to_be_hidden()
        expect(self.row(1)).to_be_focused()

    def test_keyboard_opens_the_row_menu_with_focus_and_returns_it(self):
        page = self.open(BOTH)
        for key in ('Shift+F10', 'ContextMenu'):
            with self.subTest(key=key, tab='Radiology'):
                self.keyboard_round(key)
        self.technician_tab()
        for key in ('Shift+F10', 'ContextMenu'):
            with self.subTest(key=key, tab='Technician'):
                self.keyboard_round(key)
        # Enter runs the focused item: Verify on the Technician menu.
        self.row(1).click()
        page.keyboard.press('Shift+F10')
        verify = self.item('Verify')
        while not verify.evaluate('e => e === document.activeElement'):
            page.keyboard.press('ArrowDown')
        page.keyboard.press('Enter')
        expect(self.menu).to_be_hidden()
        # Verify draws the list again; the focus is back on that row as drawn now.
        expect(self.row(1)).to_be_focused()
        page.wait_for_timeout(300)
        self.assertTrue(any(m == 'PATCH' and b == {'ss': 'Verified'} for m, _, b in self.site.writes), self.site.writes)
        self.assertEqual([], self.errors)

    def test_keyboard_opens_the_order_menu_with_focus_and_returns_it(self):
        page = self.open(BOTH)
        self.technician_tab()
        # A study and an order, both unmatched: Match is offered (the first item that takes the focus).
        self.row(0).click()
        order = page.locator('#orderrows tr[data-oid]').first
        order.click()
        expect(page.locator('#orderrows tr[data-oid]').first).to_be_focused()
        page.keyboard.press('Shift+F10')
        expect(self.menu).to_be_visible()
        expect(self.item('Match')).to_be_focused()
        page.keyboard.press('Escape')
        expect(self.menu).to_be_hidden()
        expect(page.locator('#orderrows tr[data-oid]').first).to_be_focused()
        # Enter on Match (confirm accepted): the match is sent, the lists are read again, and the focus is still on that
        # order row after every redraw.
        reads = lambda: sum(1 for m, p in self.site.calls if m == 'GET' and p == '/api/bootstrap')
        before = reads()
        page.keyboard.press('Shift+F10')
        expect(self.item('Match')).to_be_focused()
        page.keyboard.press('Enter')
        expect(self.menu).to_be_hidden()
        for _ in range(100):
            if any(m == 'POST' and p == '/api/match' for m, p, _ in self.site.writes) and reads() > before:
                break
            page.wait_for_timeout(100)
        self.assertTrue(any(m == 'POST' and p == '/api/match' for m, p, _ in self.site.writes), self.site.writes)
        self.assertGreater(reads(), before, 'the Order List was not read again after the match')
        page.wait_for_timeout(500)
        expect(page.locator('#orderrows tr[data-oid]').first).to_be_focused()
        self.assertEqual([], self.errors)

    def test_keyboard_menu_with_every_item_grey_still_closes(self):
        """A radiologist-only account on an order row: every item is grey; Escape still closes the menu."""
        page = self.open(auth.RAD)
        self.technician_tab()
        page.locator('#orderrows tr[data-oid]').first.click()
        page.keyboard.press('Shift+F10')
        expect(self.menu).to_be_visible()
        expect(self.menu.locator('[role=menuitem][aria-disabled=false]')).to_have_count(0)
        page.keyboard.press('Escape')
        expect(self.menu).to_be_hidden()
        expect(page.locator('#orderrows tr[data-oid]').first).to_be_focused()
        self.assertEqual([], self.errors)

    def test_mouse_menu_keeps_the_focus_where_it_was(self):
        page = self.open(BOTH)
        self.row(0).click()
        expect(self.row(0)).to_be_focused()
        self.row_menu(0)
        # The right-clicked row keeps the focus (the menu does not take it), as before.
        expect(self.row(0)).to_be_focused()
        self.close_menu()
        self.assertEqual([], self.errors)

    # ── tele-reading ──
    def test_tele_items_only_say_it_is_a_later_feature(self):
        page = self.open(auth.RAD)
        self.row(0).click()
        self.row_menu(0)
        labels = self.menu.get_by_role('menuitem').all_inner_texts()
        at = labels.index(TELE_ITEMS[0])
        self.assertEqual(list(TELE_ITEMS), labels[at:at + 3])
        for name in TELE_ITEMS:
            if not self.menu.is_visible():
                self.row_menu(0)
            expect(self.item(name)).to_have_attribute('aria-disabled', 'false')
            # Each item's own notice: the toast is emptied first, so an earlier item's notice cannot answer for it.
            page.evaluate("() => { document.querySelector('#toast').textContent = ''; }")
            self.item(name).click()
            expect(self.menu).to_be_hidden()
            expect(page.locator('#toast')).to_contain_text(LATER)
        page.wait_for_timeout(1500)
        self.assertEqual([], self.site.writes, 'a tele-reading item sent something')
        self.assertEqual([], self.dialogs, 'a tele-reading item asked a question')
        self.assertEqual([], self.errors)


if __name__ == '__main__':
    unittest.main()
