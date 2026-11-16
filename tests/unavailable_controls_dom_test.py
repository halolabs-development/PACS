# coding: utf-8
"""Controls on the screen that cannot do anything say so and cannot be pressed; nothing on the screen leads to a dead end.

- The header's Prefetch checkbox was pressable and changed nothing (no script reads it; prefetching is set in Auto
  Preload and shown in the PF column). It stays where it is, unchecked and disabled, and its holder says why.
- More's tooltip names only buttons that the open More panel shows (Transcribe was removed, Except is hidden).
- A context-menu item may carry a reason (New Exam in the Technician order menu); items without one get no title.
- The viewer's header logo no longer leads to OHIF's own study list (which can list nothing here and showed
  "Data Source Connection Error"): showStudyList is off and the viewer's route `/` goes to the sign-in entry.

The worklist page and bundle are the committed files; only HTTP answers are synthetic (auth_logout_dom_test.Site).
The OHIF part reads config/ohif/configuration.js; the real viewer bundle's header was measured on a stack.
"""
from pathlib import Path
import re
import unittest

from playwright.sync_api import expect, sync_playwright
import auth_logout_dom_test as auth
from worklist_folders_dom_test import FolderSite

ROOT = Path(__file__).resolve().parents[1]
# Each name the More tooltip lists, and the button in the More panel it names.
MORE_NAMES = {'추가기재': 'b-addendum', '보류': 'b-defer', 'CVR 표시': 'b-mark-cvr', '미판독으로 되돌리기': 'b-unread',
              '복사': 'b-copy', '붙여넣기': 'b-paste', '지우기': 'b-clear', '상용구 저장': 'b-report-template',
              '인쇄': 'b-print', '개정 이력': 'b-history'}


ORDER = {'oid': 'SYN-O-1', 'id': 'SYN-ORDER-P1', 'name': 'SYN ORDER PATIENT', 'sex': 'O', 'birth': '1970-01-01',
         'sched': '2026-10-03 09:10', 'modality': 'CT', 'desc': 'SYN CT', 'ward': 'OPD', 'reqDoc': 'SYN MD',
         'reqAt': '2026-10-03T08:10', 'reqDept': 'SYN', 'ptClass': 'O', 'matched': 'U', 'studyUid': None}


class OrderSite(FolderSite):
    """The folders site whose bootstrap also lists one synthetic order (the Technician Order List reads it)."""
    def api(self, route, request, method, path, query):
        if path in ('/api/bootstrap', '/api/prefs'):
            account, refused = self.authenticate(request)
            if refused:
                return self.refuse(route, *refused)
            return route.fulfill(json=dict(statesOmitted=True, me=dict(actor=account['actor'], roles=account['roles'],
                institution=auth.INSTITUTION, institutionName='SYN Hospital A'), filters=self.filters, templates=[],
                institutions=[], states={}, orders=[dict(ORDER)], serverTime='2026-10-03T00:00:00.000Z'))
        return super().api(route, request, method, path, query)


def more_title_names(title):
    """The button names a More tooltip lists: inside each '(…)' group, and the '인쇄·개정 이력' run before '단추를'."""
    names = [n for group in re.findall(r'\(([^)]*)\)', title.split(' 단추를')[0]) for n in group.split('·')]
    tail = re.search(r'\),\s*([^()]*?)\s*단추를', title)
    if tail:
        names += tail.group(1).split('·')
    return [n.strip() for n in names if n.strip()]


class UnavailableControlsDOM(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.pw = sync_playwright().start()
        cls.browser = cls.pw.chromium.launch()

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.pw.stop()

    def open(self, account=None, width=1920, height=1080):
        self.site = OrderSite()
        if account:
            self.site.account = account
        context = self.browser.new_context(viewport={'width': width, 'height': height})
        self.addCleanup(context.close)
        context.route('**/*', lambda route, request: self.site.handle(route, request))
        page = context.new_page()
        self.errors = []
        page.on('pageerror', lambda e: self.errors.append(str(e)))
        page.goto(auth.MAIN_URL)
        expect(page.locator('#rows tr[data-uid]')).to_have_count(len(self.site.modalities))
        return page

    def test_prefetch_checkbox_is_not_a_setting(self):
        page = self.open()
        box = page.get_by_role('group', name='Status', exact=True).get_by_role('checkbox', name='Prefetch')
        expect(box).to_be_visible()
        expect(box).to_be_disabled()
        expect(box).not_to_be_checked()
        holder = box.locator('xpath=..')
        expect(holder).to_have_text('Prefetch')
        title = holder.get_attribute('title') or ''
        for words in ('연결되어 있지 않습니다', 'Auto Preload', 'PF 열'):
            self.assertIn(words, title)
        sent = []
        page.on('request', lambda r: sent.append(r.method + ' ' + r.url))
        before = page.evaluate('()=>JSON.stringify(Object.entries(localStorage).sort())')
        frame = box.bounding_box()
        page.mouse.click(frame['x'] + frame['width'] / 2, frame['y'] + frame['height'] / 2)
        page.wait_for_timeout(300)
        expect(box).not_to_be_checked()
        # Background reads (inbox polling) may run meanwhile; the press itself writes nothing, here or in the browser.
        self.assertEqual([], [s for s in sent if not s.startswith('GET ')])
        self.assertEqual(before, page.evaluate('()=>JSON.stringify(Object.entries(localStorage).sort())'))
        # Below 1920 px the status group shows only the storage line, as before.
        page.set_viewport_size({'width': 1919, 'height': 1080})
        expect(box).to_be_hidden()
        self.assertEqual([], self.errors)

    def test_more_tooltip_names_only_buttons_more_shows(self):
        page = self.open()
        page.locator('#rows tr[data-uid]').first.click()
        summary = page.locator('#report-more > summary')
        title = summary.get_attribute('title') or ''
        names = more_title_names(title)
        self.assertTrue(names, title)
        unknown = [n for n in names if n not in MORE_NAMES]
        self.assertEqual([], unknown, f'the More tooltip names something More has no button for: {title}')
        summary.click()
        shown = page.evaluate("()=>[...document.querySelectorAll('#report-more .toolbar-menu-panel button')]"
                              ".filter(b=>!b.hidden&&b.checkVisibility()).map(b=>b.id)")
        for name in names:
            self.assertIn(MORE_NAMES[name], shown, f'{name} is in the tooltip but More does not show {MORE_NAMES[name]}')
        self.assertEqual([], self.errors)

    def test_menu_items_carry_a_reason_only_when_given(self):
        page = self.open({**auth.RAD, 'roles': ['radiologist', 'technician']}, 1600, 1000)
        page.locator('#rows tr[data-uid]').first.click(button='right')
        menu = page.locator('#ctx')
        expect(menu).to_be_visible()
        self.assertEqual([], menu.locator('[role=menuitem]').evaluate_all('els=>els.filter(e=>e.hasAttribute("title")).map(e=>e.textContent)'))
        page.keyboard.press('Escape')
        page.locator('[data-tab="Technician"]').click()
        order = page.locator('#orderrows tr[data-oid]').first
        expect(order).to_be_visible()
        order.click(button='right')
        item = menu.get_by_role('menuitem', name='New Exam (SC 생성)')
        expect(item).to_have_attribute('aria-disabled', 'true')
        expect(item).to_have_attribute('title', '새 검사(SC 생성)는 현재 연결되어 있지 않습니다.')
        for other in ('Match', 'Unmatch'):
            self.assertIsNone(menu.get_by_role('menuitem', name=other, exact=True).get_attribute('title'))
        sent = []
        page.on('request', lambda r: sent.append(r.method + ' ' + r.url))
        item.click(force=True)
        page.wait_for_timeout(300)
        self.assertEqual([], [s for s in sent if not s.startswith('GET ')], 'pressing the unavailable item sent something')
        self.assertEqual([], self.errors)

    def test_viewer_root_is_not_the_ohif_study_list(self):
        source = (ROOT / 'config/ohif/configuration.js').read_text(encoding='utf-8')
        self.assertRegex(source, r'\n  showStudyList: false,\n')
        self.assertNotIn('showStudyList: true', source)
        self.assertRegex(source, r"customizationService: \{ customRoutes: \{ routes: \[\{ path: '/', children: kinViewerRootToWorklist \}\] \} \},")
        built = (ROOT / 'config/ohif.js').read_text(encoding='utf-8')
        self.assertIn(source, built, 'config/ohif.js is not rebuilt from config/ohif/configuration.js')
        function = re.search(r'function kinViewerRootToWorklist\(\) \{.*?\n\}', source, re.S).group(0)
        page = self.browser.new_page()
        self.addCleanup(page.close)
        page.route('**/*', lambda route, request: route.fulfill(body='<title>entry</title>', content_type='text/html'))
        page.goto('https://syn.test/ohif/')
        with page.expect_navigation():
            page.evaluate('void (() => {\n' + function + '\nkinViewerRootToWorklist();\n})()')
        self.assertEqual('https://syn.test/worklist/hpacs-lite/index.html', page.url)


if __name__ == '__main__':
    unittest.main()
