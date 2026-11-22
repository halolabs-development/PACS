"""The work page's five boxes trade places (studio 2026-11-01: "So there are 5 boxes here. worklist, related exams,
related reports, CLinical Information, Report editor. ... Allow me to drop and drag these boxes so I can configure it
the way I want to").

REQ -> RISK: a drop moves boxes without saying so, loses the arrangement on reload, mixes accounts, breaks a resize
handle, pushes a box out of a small window, or disturbs a report being written -> TEST-BOXES-DOM-01..12.

The real main.html and its assets are served; only HTTP answers are synthetic (study_panel_page_dom_test.WorkspaceSite).
Every assertion reads public controls, geometry, focus, field values and the stored preferences.
"""
import json
import os
import sys
import unittest
from pathlib import Path

from playwright.sync_api import expect, sync_playwright

sys.path.insert(0, str(Path(__file__).resolve().parent))
import study_panel_page_dom_test as dom  # noqa: E402
from study_panel_page_dom_test import KEY, RASTER, WorkspaceSite, auth, settle, wait_startup  # noqa: E402

OUT = Path(os.environ.get('KIN_BOXES_OUT', dom.ROOT / 'tmp/reading-boxes/dom'))
# The five boxes as the reader sees them, by their own elements.
BOXES = '''() => { const r = n => { if (!n || !n.getClientRects().length) return null; const b = n.getBoundingClientRect();
  return { x: b.x, y: b.y, w: b.width, h: b.height, right: b.right, bottom: b.bottom }; };
  const q = s => document.querySelector(s), tech = q('.tabs > div.on')?.dataset.tab === 'Technician';
  return { worklist: r(q('.left > .grid')), relatedExams: r(q('.left > .related-list-pane')), clinical: r(q('.rw > .s-clinical')),
    relatedReports: r(q('.workrow > .related-p')), editor: r(q(tech ? '.workrow > .order-p' : '.workrow > .report-p')),
    left: r(q('.split > .left')), right: r(q('.split > .right')), viewport: [innerWidth, innerHeight] }; }'''
SWAP_CLASSES = "() => ['columns','list','side','report'].filter(k => document.body.classList.contains('kin-swap-' + k))"


class ReadingBoxesDOM(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        OUT.mkdir(parents=True, exist_ok=True)
        cls.pw = sync_playwright().start()
        cls.browser = cls.pw.chromium.launch(args=RASTER)

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.pw.stop()

    def open(self, site=None, width=1920, height=1080, init=None, account=None):
        site = site or WorkspaceSite()
        if account:
            site.account = account
        context = self.browser.new_context(viewport={'width': width, 'height': height})
        context.route('**/*', lambda route, request: site.handle(route, request))
        if init:
            context.add_init_script(init)
        page = context.new_page()
        errors = []
        page.on('pageerror', lambda e: errors.append(str(e)))
        page.on('dialog', lambda d: d.accept())
        self.addCleanup(context.close)
        self.addCleanup(lambda: self.assertEqual([], errors))
        self.addCleanup(lambda: self.assertEqual([], site.violations))
        page.goto(auth.MAIN_URL)
        expect(page.locator('#rows')).to_contain_text(auth.PATIENT)
        wait_startup(page, site)
        settle(page)
        return page, site, context

    @staticmethod
    def stored(page, key=KEY):
        return page.evaluate('(key) => JSON.parse(localStorage.getItem(key))', key)

    @staticmethod
    def boxes(page):
        settle(page)
        return page.evaluate(BOXES)

    def arrange(self, page):
        """Top bar Config (Panel Settings) > Arrange Boxes; the dialog closes and the first box takes the focus."""
        page.locator('#m-config').click()
        dialog = page.get_by_role('dialog', name='Panel Settings', exact=True)
        expect(dialog).to_be_visible()
        dialog.get_by_role('button', name='Arrange Boxes', exact=True).click()
        bar = page.get_by_role('region', name='Arrange Boxes', exact=True)
        expect(bar).to_be_visible()
        expect(dialog).to_be_hidden()
        expect(page.locator('#toolbar-view')).to_have_js_property('open', False)
        return bar

    @staticmethod
    def cover(page, name):
        return page.locator('#box-arrange-covers').get_by_role('button', name=name, exact=True)

    def point(self, page, name):
        """A point where the named cover is the top-most element (the arrange bar, whose height depends on the fonts,
        may lie over part of a box at the top of the page)."""
        found = page.evaluate('''(name) => {
          const cover = [...document.querySelectorAll('#box-arrange-covers .kin-box-cover')].find(n => n.getAttribute('aria-label') === name);
          if (!cover) return { missing: true };
          const b = cover.getBoundingClientRect();
          for (const fy of [0.5, 0.75, 0.25, 0.9, 0.1]) for (const fx of [0.5, 0.25, 0.75]) {
            const x = b.x + b.width * fx, y = b.y + b.height * fy;
            if (document.elementFromPoint(x, y)?.closest('.kin-box-cover') === cover) return { x, y };
          }
          const top = document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2);
          return { covered: top ? top.outerHTML.slice(0, 120) : null, box: [b.x, b.y, b.width, b.height] };
        }''', name)
        self.assertIn('x', found, f'{name}: {found}')
        return found['x'], found['y']

    def drag(self, page, source, target, outcome=None):
        """A real pointer drag from one cover to another; the target says the outcome before the drop."""
        page.mouse.move(*self.point(page, source))
        page.mouse.down()
        page.mouse.move(*self.point(page, target), steps=8)
        if outcome:
            expect(self.cover(page, target)).to_contain_text(outcome)
            expect(page.locator('#box-arrange-status')).to_have_text(outcome)
        page.mouse.up()
        settle(page)

    def assert_order(self, page, column_a, column_b, columns_swapped=False, portrait=False):
        """Reading order inside each column (top to bottom) and which column comes first on the page."""
        g = self.boxes(page)
        for column in (column_a, column_b):
            tops = [g[key]['y'] for key in column]
            self.assertEqual(sorted(tops), tops, f'{column}: {tops}')
        axis = 'y' if portrait else 'x'
        first, second = (g['right'], g['left']) if columns_swapped else (g['left'], g['right'])
        self.assertLess(first[axis], second[axis])
        return g

    def test_01_default_arrangement_is_unchanged_and_no_record_is_written(self):
        """Thin slice: a reader who never arranges sees today's page, and nothing new is stored."""
        page, _, _ = self.open()
        self.assertEqual([], page.evaluate(SWAP_CLASSES))
        g = self.assert_order(page, ['worklist', 'relatedExams'], ['clinical', 'relatedReports', 'editor'])
        self.assertLess(g['worklist']['x'], g['clinical']['x'])
        stored = self.stored(page)
        self.assertNotIn('boxSwaps', (stored or {}).get('workspace', {}))
        expect(page.locator('#box-arrange-open')).to_be_enabled()
        expect(page.locator('#box-arrange-open')).to_have_text('Arrange Boxes')

    def test_02_mouse_drop_trades_places_says_it_first_and_is_remembered_after_reload(self):
        page, site, _ = self.open()
        bar = self.arrange(page)
        expect(page.locator('#box-arrange-covers .kin-box-cover')).to_have_count(5)
        for name in ('Worklist', 'Related Exam', 'Clinical Information', 'Related Report', 'Report Editor'):
            expect(self.cover(page, name)).to_be_visible()
        # Same column: the two boxes trade places.
        self.drag(page, 'Worklist', 'Related Exam', '놓으면 Worklist와 Related Exam이 자리를 바꿉니다.')
        expect(page.locator('#box-arrange-status')).to_have_text('자리를 바꿨습니다. 이 브라우저에 기억했습니다.')
        self.assert_order(page, ['relatedExams', 'worklist'], ['clinical', 'relatedReports', 'editor'])
        self.assertEqual(['list'], self.stored(page)['workspace']['boxSwaps'])
        # Across the columns: said in words before the drop, then the two columns trade sides.
        self.drag(page, 'Worklist', 'Report Editor',
                  '놓으면 두 열이 바뀝니다: 목록 열(Worklist·Related Exam)이 오른쪽으로, 판독 열이 왼쪽으로 갑니다.')
        self.assert_order(page, ['relatedExams', 'worklist'], ['clinical', 'relatedReports', 'editor'], columns_swapped=True)
        # The band and the report row; then the two row boxes.
        self.drag(page, 'Clinical Information', 'Related Report', '놓으면 Clinical Information 띠가 판독 열의 맨 아래로 갑니다.')
        self.drag(page, 'Report Editor', 'Related Report', '놓으면 Related Report와 Report Editor가 자리를 바꿉니다.')
        swapped = self.assert_order(page, ['relatedExams', 'worklist'], ['editor', 'relatedReports', 'clinical'], columns_swapped=True)
        # A drop on the same box, or outside every box, changes nothing.
        before = self.stored(page)
        box = self.cover(page, 'Worklist').bounding_box()
        page.mouse.move(box['x'] + 20, box['y'] + 20); page.mouse.down(); page.mouse.move(box['x'] + 40, box['y'] + 40, steps=4); page.mouse.up()
        self.assertEqual(before, self.stored(page))
        self.assertEqual(['columns', 'list', 'side', 'report'], before['workspace']['boxSwaps'])
        bar.get_by_role('button', name='Done', exact=True).click()
        expect(bar).to_be_hidden()
        expect(page.locator('#box-arrange-covers .kin-box-cover')).to_have_count(0)
        page.screenshot(path=str(OUT / 'all-swapped-1920.png'))
        # Reload (and a new login of the same account in this browser) draws it from the first paint.
        page.reload()
        expect(page.locator('#rows')).to_contain_text(auth.PATIENT)
        wait_startup(page, site)
        self.assertEqual(['columns', 'list', 'side', 'report'], page.evaluate(SWAP_CLASSES))
        again = self.assert_order(page, ['relatedExams', 'worklist'], ['editor', 'relatedReports', 'clinical'], columns_swapped=True)
        for key in ('worklist', 'relatedExams', 'clinical', 'relatedReports', 'editor'):
            self.assertAlmostEqual(swapped[key]['x'], again[key]['x'], delta=1, msg=key)

    def test_03_keyboard_pick_and_drop_escape_and_focus_return(self):
        page, _, _ = self.open()
        page.locator('#rows tr[data-uid]').first.click()
        field = page.locator('#findings')
        field.fill('SYN findings kept while the boxes move')
        field.evaluate('f => f.setSelectionRange(4, 12)')
        notices = page.locator('#report-notices').inner_text()
        save = page.locator('#b-save').is_disabled()
        self.arrange(page)
        expect(self.cover(page, 'Worklist')).to_be_focused()
        # Tab goes through the covers in screen order.
        for name in ('Related Exam', 'Clinical Information', 'Related Report'):
            page.keyboard.press('Tab')
            expect(self.cover(page, name)).to_be_focused()
        page.keyboard.press('Enter')
        expect(self.cover(page, 'Related Report')).to_have_attribute('aria-pressed', 'true')
        page.keyboard.press('Tab')
        expect(self.cover(page, 'Report Editor')).to_contain_text('놓으면 Related Report와 Report Editor가 자리를 바꿉니다.')
        page.keyboard.press('Space')
        self.assert_order(page, ['worklist', 'relatedExams'], ['clinical', 'editor', 'relatedReports'])
        self.assertEqual(['report'], self.stored(page)['workspace']['boxSwaps'])
        # Escape with a box picked puts it back; a second Escape ends Arrange Boxes.
        page.keyboard.press('Enter')
        page.keyboard.press('Escape')
        expect(page.locator('#box-arrange-status')).to_have_text('집은 상자를 내려놓았습니다.')
        self.assertEqual(['report'], self.stored(page)['workspace']['boxSwaps'])
        page.keyboard.press('Escape')
        expect(page.get_by_role('region', name='Arrange Boxes', exact=True)).to_be_hidden()
        # The report being written is untouched: its text, its caret, its save state; focus is back in it.
        expect(field).to_be_focused()
        expect(field).to_have_value('SYN findings kept while the boxes move')
        self.assertEqual([4, 12], field.evaluate('f => [f.selectionStart, f.selectionEnd]'))
        self.assertEqual(notices, page.locator('#report-notices').inner_text())
        self.assertEqual(save, page.locator('#b-save').is_disabled())

    def test_04_bar_buttons_default_arrangement_and_reset_layout(self):
        page, _, _ = self.open()
        bar = self.arrange(page)
        bar.get_by_role('button', name='Swap Columns', exact=True).click()
        bar.get_by_role('button', name='Move Clinical Information', exact=True).click()
        self.assertEqual(['columns', 'side'], self.stored(page)['workspace']['boxSwaps'])
        expect(bar.get_by_role('button', name='Swap Columns', exact=True)).to_have_attribute('aria-pressed', 'true')
        bar.get_by_role('button', name='Default Arrangement', exact=True).click()
        expect(page.locator('#box-arrange-status')).to_have_text('기본 배치로 되돌렸습니다. 이 브라우저에 기억했습니다.')
        self.assertNotIn('boxSwaps', self.stored(page)['workspace'])
        self.assertEqual([], page.evaluate(SWAP_CLASSES))
        expect(bar.get_by_role('button', name='Default Arrangement', exact=True)).to_be_disabled()
        bar.get_by_role('button', name='Swap Worklist / Related Exam', exact=True).click()
        bar.get_by_role('button', name='Done', exact=True).click()
        # Reset Layout puts every box home with the rest of the layout.
        page.locator('#toolbar-view > summary').click()
        page.get_by_role('button', name='Reset Layout', exact=True).click()
        self.assertEqual([], page.evaluate(SWAP_CLASSES))
        self.assert_order(page, ['worklist', 'relatedExams'], ['clinical', 'relatedReports', 'editor'])

    def test_05_another_account_in_this_browser_keeps_its_own_arrangement(self):
        record = {'version': 3, 'mode': 'auto', 'portrait': {}, 'landscape': {},
                  'reading': {'version': 1, 'reportWidth': None, 'imageHeight': None, 'relatedHeight': None, 'relatedListHeight': None, 'relatedHidden': False},
                  'workspace': {'version': 1, 'rail': None, 'worklist': None, 'related': None, 'prior': None,
                                'railCollapsed': False, 'studyPanelTab': 'info', 'boxSwaps': ['columns']}}
        other = 'kin-workspace:v1:' + json.dumps([auth.INSTITUTION, 'synthetic-other-reader'], separators=(',', ':'))
        init = 'localStorage.setItem(%s, %s)' % (json.dumps(other), json.dumps(json.dumps(record)))
        page, _, _ = self.open(init=init)
        self.assertEqual([], page.evaluate(SWAP_CLASSES))
        self.assertEqual(['columns'], self.stored(page, other)['workspace']['boxSwaps'])
        mine = 'localStorage.setItem(%s, %s)' % (json.dumps(KEY), json.dumps(json.dumps(record)))
        page, _, _ = self.open(init=mine)
        self.assertEqual(['columns'], page.evaluate(SWAP_CLASSES))

    def test_06_account_layout_carries_the_arrangement_to_another_browser(self):
        site = WorkspaceSite()
        page, _, _ = self.open(site)
        bar = self.arrange(page)
        bar.get_by_role('button', name='Swap Columns', exact=True).click()
        bar.get_by_role('button', name='Swap Related Report / Report Editor', exact=True).click()
        bar.get_by_role('button', name='Done', exact=True).click()
        page.locator('#toolbar-view > summary').click()
        page.locator('#workspace-server-menu > summary').click()
        page.get_by_role('button', name='Save to Account', exact=True).click()
        expect(page.locator('#workspace-server-status')).to_contain_text('현재 배치를 계정에 저장')
        self.assertEqual(['columns', 'report'], site.layout['workspace']['boxSwaps'])
        # Another browser (no local record) loads it from the account.
        other, _, _ = self.open(site)
        self.assertEqual([], other.evaluate(SWAP_CLASSES))
        other.locator('#toolbar-view > summary').click()
        other.locator('#workspace-server-menu > summary').click()
        other.get_by_role('button', name='Load from Account', exact=True).click()
        expect(other.locator('#workspace-server-status')).to_contain_text('서버 배치를 불러왔습니다')
        self.assertEqual(['columns', 'report'], other.evaluate(SWAP_CLASSES))
        self.assertEqual(['columns', 'report'], self.stored(other)['workspace']['boxSwaps'])

    def test_07_resize_handles_grow_their_own_box_after_a_swap(self):
        page, _, _ = self.open()
        bar = self.arrange(page)
        for name in ('Swap Columns', 'Swap Worklist / Related Exam', 'Swap Related Report / Report Editor'):
            bar.get_by_role('button', name=name, exact=True).click()
        bar.get_by_role('button', name='Done', exact=True).click()

        def pull(handle, dx, dy):
            b = page.locator(handle).bounding_box()
            x, y = b['x'] + b['width'] / 2, b['y'] + b['height'] / 2
            page.mouse.move(x, y); page.mouse.down(); page.mouse.move(x + dx, y + dy, steps=6); page.mouse.up()
            settle(page)
        # The list column now sits right of its handle: pulling the handle left widens it.
        before = self.boxes(page)['left']['w']
        pull('#resize-main', -60, 0)
        self.assertAlmostEqual(before + 60, self.boxes(page)['left']['w'], delta=2)
        # Related Exam now sits above its handle: pulling down makes it taller.
        before = self.boxes(page)['relatedExams']['h']
        pull('#resize-left-split', 0, 40)
        self.assertAlmostEqual(before + 40, self.boxes(page)['relatedExams']['h'], delta=2)
        # Related Report now sits below its handle: pulling up makes it taller.
        before = self.boxes(page)['relatedReports']['h']
        pull('#resize-related', 0, -40)
        self.assertAlmostEqual(before + 40, self.boxes(page)['relatedReports']['h'], delta=2)
        # The keyboard moves the handle the same way.
        page.locator('#resize-related').focus()
        before = self.boxes(page)['relatedReports']['h']
        page.keyboard.press('ArrowDown')
        self.assertAlmostEqual(before - 10, self.boxes(page)['relatedReports']['h'], delta=1)
        page.keyboard.press('ArrowUp')
        self.assertAlmostEqual(before, self.boxes(page)['relatedReports']['h'], delta=1)
        stored = self.stored(page)
        self.assertEqual(['columns', 'list', 'report'], stored['workspace']['boxSwaps'])
        self.assertIn('related', stored['landscape'])

    def test_08_small_windows_keep_every_box_on_screen_or_a_scroll_away(self):
        arrangements = (['columns'], ['list', 'side'], ['columns', 'list', 'side', 'report'], ['side', 'report'])
        for width, height in ((1366, 768), (1366, 640)):
            for swaps in arrangements:
                with self.subTest(width=width, height=height, swaps=swaps):
                    record = {'version': 3, 'mode': 'auto', 'portrait': {}, 'landscape': {},
                              'reading': {'version': 1, 'reportWidth': None, 'imageHeight': None, 'relatedHeight': None, 'relatedListHeight': None, 'relatedHidden': False},
                              'workspace': {'version': 1, 'rail': None, 'worklist': None, 'related': None, 'prior': None,
                                            'railCollapsed': False, 'studyPanelTab': 'info', 'boxSwaps': swaps}}
                    init = 'localStorage.setItem(%s, %s)' % (json.dumps(KEY), json.dumps(json.dumps(record)))
                    page, _, _ = self.open(width=width, height=height, init=init)
                    page.locator('#rows tr[data-uid] td').first.click()
                    settle(page)
                    self.assertEqual(sorted(swaps), sorted(page.evaluate(SWAP_CLASSES)))
                    self.assertLessEqual(page.evaluate('document.documentElement.scrollWidth'), width)
                    # Nothing starts scrolled sideways: the list and the page open at their left edge.
                    self.assertEqual([0, 0, 0], page.evaluate("() => ['.left', '.left > .grid', '.split'].map(s => document.querySelector(s).scrollLeft)"))
                    for selector in ('.left > .grid', '.left > .related-list-pane', '.rw > .s-clinical', '.workrow > .related-p',
                                     '.workrow > .report-p', '#b-approve', '#b-save', '#findings', '#rows tr[data-uid]'):
                        node = page.locator(selector).first
                        node.evaluate('n => n.scrollIntoView({ block: "nearest", inline: "nearest" })')
                        b = node.bounding_box()
                        self.assertIsNotNone(b, selector)
                        self.assertGreater(b['height'], 8, selector)
                        # At least 40 px (or all of it) on screen in each direction once scrolled to.
                        seen_h = min(b['y'] + b['height'], height) - max(b['y'], 0)
                        seen_w = min(b['x'] + b['width'], width) - max(b['x'], 0)
                        self.assertGreaterEqual(seen_h, min(b['height'], 40) - 1, f'{selector} {b}')
                        self.assertGreaterEqual(seen_w, min(b['width'], 40) - 1, f'{selector} {b}')
                    page.screenshot(path=str(OUT / f'small-{width}x{height}-{"-".join(swaps)}.png'))
                    # Arrange Boxes works at this size too: five covers, each on screen.
                    self.arrange(page)
                    expect(page.locator('#box-arrange-covers .kin-box-cover')).to_have_count(5)
                    page.keyboard.press('Escape')

    def test_09_reading_workspace_keeps_its_own_arrangement(self):
        page, _, _ = self.open()
        page.route('**/ohif/**', lambda route: route.fulfill(content_type='text/html', body='<!doctype html><title>SYN viewer</title>'))
        page.locator('#rows tr[data-uid]').first.click()
        bar = self.arrange(page)
        bar.get_by_role('button', name='Swap Related Report / Report Editor', exact=True).click()
        bar.get_by_role('button', name='Swap Columns', exact=True).click()
        # Opening the Reading Workspace ends Arrange Boxes; its column keeps Related Report above the editor.
        page.get_by_role('button', name='Reading Workspace', exact=True).click()
        expect(page.locator('body')).to_have_class(__import__('re').compile(r'\breading\b'))
        settle(page)
        expect(bar).to_be_hidden()
        expect(page.locator('#box-arrange-open')).to_be_disabled()
        related, report = page.locator('.related-p').bounding_box(), page.locator('.report-p').bounding_box()
        self.assertLess(related['y'], report['y'])
        self.assertEqual(['columns', 'report'], self.stored(page)['workspace']['boxSwaps'])

    def test_10_technician_order_list_takes_the_editor_place(self):
        page, _, _ = self.open()
        page.locator('.tabs > div[data-tab="Technician"]').click()
        expect(page.locator('.tabs > div[data-tab="Technician"]')).to_have_class('on')
        bar = self.arrange(page)
        expect(self.cover(page, 'Order List')).to_be_visible()
        expect(bar.get_by_role('button', name='Swap Related Report / Order List', exact=True)).to_be_visible()
        self.drag(page, 'Order List', 'Related Report', '놓으면 Related Report와 Order List가 자리를 바꿉니다.')
        self.assert_order(page, ['worklist', 'relatedExams'], ['clinical', 'editor', 'relatedReports'])

    def test_11_study_panel_never_covers_the_report_after_a_column_swap(self):
        page, _, _ = self.open()
        bar = self.arrange(page)
        bar.get_by_role('button', name='Swap Columns', exact=True).click()
        bar.get_by_role('button', name='Done', exact=True).click()
        page.locator('#rows tr[data-uid]').first.click()
        page.keyboard.press('Control+Alt+5')
        drawer = page.get_by_role('complementary', name='Study Panel', exact=True)
        expect(drawer).to_be_visible()
        settle(page)
        box, report = drawer.bounding_box(), page.locator('.report-p').bounding_box()
        self.assertGreaterEqual(box['x'], report['x'] + report['width'] - 1)
        self.assertLessEqual(box['x'] + box['width'], 1920)
        # Its free edge faces the report: dragging it left widens the panel.
        grip = page.locator('.study-panel-resize')
        g = grip.bounding_box()
        self.assertLess(g['x'], box['x'] + 1)
        page.mouse.move(g['x'] + g['width'] / 2, g['y'] + 200); page.mouse.down()
        page.mouse.move(g['x'] + g['width'] / 2 - 50, g['y'] + 200, steps=5); page.mouse.up()
        settle(page)
        self.assertAlmostEqual(box['width'] + 50, drawer.bounding_box()['width'], delta=2)
        self.assertGreaterEqual(drawer.bounding_box()['x'], report['x'] + report['width'] - 1)
        # The keyboard on that edge: ArrowLeft moves it toward the report, so the panel grows.
        width = drawer.bounding_box()['width']
        grip.focus()
        page.keyboard.press('ArrowLeft')
        settle(page)
        self.assertAlmostEqual(width + 10, drawer.bounding_box()['width'], delta=1)

    def test_12_portrait_column_swap_puts_the_report_column_on_top(self):
        page, _, _ = self.open(width=1000, height=1400)
        bar = self.arrange(page)
        bar.get_by_role('button', name='Swap Columns', exact=True).click()
        expect(self.cover(page, 'Worklist')).to_be_visible()
        self.drag(page, 'Worklist', 'Clinical Information',
                  '놓으면 두 열이 바뀝니다: 목록 열(Worklist·Related Exam)이 위로, 판독 열이 아래로 갑니다.')
        self.assert_order(page, ['worklist', 'relatedExams'], ['clinical', 'relatedReports', 'editor'], portrait=True)
        bar.get_by_role('button', name='Swap Columns', exact=True).click()
        self.assert_order(page, ['worklist', 'relatedExams'], ['clinical', 'relatedReports', 'editor'], columns_swapped=True, portrait=True)

    def test_13_mouse_click_pick_bar_is_not_a_target_and_covers_follow_a_resize(self):
        page, _, _ = self.open()
        bar = self.arrange(page)
        # A click (no drag) picks a box; a click on another box drops it there.
        self.cover(page, 'Worklist').click()
        expect(self.cover(page, 'Worklist')).to_have_attribute('aria-pressed', 'true')
        self.cover(page, 'Related Exam').click()
        self.assertEqual(['list'], self.stored(page)['workspace']['boxSwaps'])
        # Right after a mouse drop, Enter on the next box still picks it.
        self.drag(page, 'Report Editor', 'Related Report')
        self.cover(page, 'Clinical Information').focus()
        page.keyboard.press('Enter')
        expect(self.cover(page, 'Clinical Information')).to_have_attribute('aria-pressed', 'true')
        page.keyboard.press('Escape')
        # Releasing over the arrange bar (even where a box lies under it) drops nothing.
        before = self.stored(page)['workspace']['boxSwaps']
        a, done = self.cover(page, 'Related Report').bounding_box(), bar.get_by_role('button', name='Done', exact=True).bounding_box()
        page.mouse.move(a['x'] + a['width'] / 2, a['y'] + a['height'] / 2); page.mouse.down()
        page.mouse.move(done['x'] + done['width'] / 2, done['y'] + done['height'] / 2, steps=6); page.mouse.up()
        settle(page)
        self.assertEqual(before, self.stored(page)['workspace']['boxSwaps'])
        expect(bar).to_be_visible()
        # A handle dragged while arranging: the cover follows its box.
        h = page.locator('#resize-related').bounding_box()
        page.mouse.move(h['x'] + h['width'] / 2, h['y'] + 3); page.mouse.down()
        page.mouse.move(h['x'] + h['width'] / 2, h['y'] + 63, steps=6); page.mouse.up()
        settle(page)
        page.wait_for_timeout(100)
        box, cover = page.locator('.workrow > .related-p').bounding_box(), self.cover(page, 'Related Report').bounding_box()
        self.assertAlmostEqual(box['y'] + box['height'], cover['y'] + cover['height'], delta=2)

    def test_14_window_resize_under_a_drag_still_drops_and_the_next_drag_works(self):
        page, _, _ = self.open()
        self.arrange(page)
        a = self.cover(page, 'Worklist').bounding_box()
        page.mouse.move(a['x'] + a['width'] / 2, a['y'] + a['height'] / 2); page.mouse.down()
        page.set_viewport_size({'width': 1700, 'height': 1000})
        settle(page)
        b = self.cover(page, 'Related Exam').bounding_box()
        page.mouse.move(b['x'] + b['width'] / 2, b['y'] + b['height'] / 2, steps=6); page.mouse.up()
        settle(page)
        self.assertEqual(['list'], self.stored(page)['workspace']['boxSwaps'])
        self.drag(page, 'Related Report', 'Report Editor', '놓으면 Related Report와 Report Editor가 자리를 바꿉니다.')
        self.assertEqual(['list', 'report'], self.stored(page)['workspace']['boxSwaps'])

    def test_15_wheel_over_a_cover_scrolls_the_column_under_it(self):
        page, _, _ = self.open(width=800, height=600)
        page.locator('#rows tr[data-uid] td').first.click()
        settle(page)
        self.arrange(page)
        cover = self.cover(page, 'Related Report')
        b = cover.bounding_box()
        scrolled = "() => [...document.querySelectorAll('.workrow, .right, .split, .left')].map(n => n.scrollTop).reduce((a, b) => a + b, 0)"
        before = page.evaluate(scrolled)
        page.mouse.move(b['x'] + b['width'] / 2, b['y'] + min(b['height'] / 2, 20))
        page.mouse.wheel(0, 300)
        page.wait_for_timeout(200)
        self.assertGreater(page.evaluate(scrolled), before)
        expect(self.cover(page, 'Report Editor')).to_be_visible()

    def test_16_study_panel_clears_the_editor_box_in_technician_and_small_windows(self):
        # Technician with the columns swapped: the panel stays off the Order List.
        page, _, _ = self.open(width=1024, height=768)
        page.locator('.tabs > div[data-tab="Technician"]').click()
        bar = self.arrange(page)
        bar.get_by_role('button', name='Swap Columns', exact=True).click()
        bar.get_by_role('button', name='Done', exact=True).click()
        # (The first Technician cell opens the reader assignment dialog; a later cell only selects the row.)
        page.locator('#rows tr[data-uid]').first.locator('td').nth(4).click()
        page.locator('#toolbar-view > summary').click()
        page.get_by_role('button', name='Study Panel', exact=True).click()
        drawer = page.get_by_role('complementary', name='Study Panel', exact=True)
        expect(drawer).to_be_visible()
        settle(page)
        box, order = drawer.bounding_box(), page.locator('.order-p').bounding_box()
        apart_x = box['x'] >= order['x'] + order['width'] - 1 or box['x'] + box['width'] <= order['x'] + 1
        apart_y = box['y'] >= order['y'] + order['height'] - 1 or box['y'] + box['height'] <= order['y'] + 1
        self.assertTrue(apart_x or apart_y, f'{box} {order}')
        # 800x600 with every swap: the panel does not lie over the Findings field.
        record = {'version': 3, 'mode': 'auto', 'portrait': {}, 'landscape': {},
                  'reading': {'version': 1, 'reportWidth': None, 'imageHeight': None, 'relatedHeight': None, 'relatedListHeight': None, 'relatedHidden': False},
                  'workspace': {'version': 1, 'rail': None, 'worklist': None, 'related': None, 'prior': None,
                                'railCollapsed': False, 'studyPanelTab': 'info', 'boxSwaps': ['columns', 'side', 'report']}}
        init = 'localStorage.setItem(%s, %s)' % (json.dumps(KEY), json.dumps(json.dumps(record)))
        page, _, _ = self.open(width=800, height=600, init=init)
        page.locator('#rows tr[data-uid] td').first.click()
        page.keyboard.press('Control+Alt+5')
        drawer = page.get_by_role('complementary', name='Study Panel', exact=True)
        expect(drawer).to_be_visible()
        settle(page)
        box, field = drawer.bounding_box(), page.locator('#findings').bounding_box()
        overlap = max(0, min(box['y'] + box['height'], field['y'] + field['height']) - max(box['y'], field['y']))
        self.assertEqual(0, overlap, f'{box} {field}')

    def test_17_folders_rail_stays_at_the_top_of_a_scrolled_list_column(self):
        record = {'version': 3, 'mode': 'auto', 'portrait': {}, 'landscape': {},
                  'reading': {'version': 1, 'reportWidth': None, 'imageHeight': None, 'relatedHeight': None, 'relatedListHeight': None, 'relatedHidden': False},
                  'workspace': {'version': 1, 'rail': None, 'worklist': None, 'related': None, 'prior': None,
                                'railCollapsed': False, 'studyPanelTab': 'info', 'boxSwaps': ['list']}}
        init = 'localStorage.setItem(%s, %s)' % (json.dumps(KEY), json.dumps(json.dumps(record)))
        page, _, _ = self.open(width=800, height=600, init=init)
        page.locator('#rows tr[data-uid] td').first.click()
        settle(page)
        page.evaluate("() => { document.querySelector('.left').scrollTop = 0; }")
        settle(page)
        rail, column = page.locator('#worklist-folders-panel').bounding_box(), page.locator('.left').bounding_box()
        self.assertIsNotNone(rail)
        self.assertLess(rail['y'], column['y'] + column['height'] - 20, f'{rail} {column}')
    def test_18_a_moved_press_is_never_a_click_and_an_idle_arrange_screen_is_still(self):
        page, _, _ = self.open()
        bar = self.arrange(page)
        # Pick Worklist with a click, then press Related Exam and release over Done: nothing is swapped.
        self.cover(page, 'Worklist').click()
        a, done = self.cover(page, 'Related Exam').bounding_box(), bar.get_by_role('button', name='Done', exact=True).bounding_box()
        page.mouse.move(a['x'] + a['width'] / 2, a['y'] + a['height'] / 2); page.mouse.down()
        page.mouse.move(done['x'] + done['width'] / 2, done['y'] + done['height'] / 2, steps=6); page.mouse.up()
        settle(page)
        self.assertIsNone(self.stored(page))
        expect(bar).to_be_visible()
        # Left alone, the arrange screen does not keep redrawing its covers.
        changes = page.evaluate("""() => new Promise(done => { let n = 0;
          const o = new MutationObserver(list => { n += list.length; });
          o.observe(document.querySelector('#box-arrange-covers'), { subtree: true, childList: true, attributes: true, characterData: true });
          setTimeout(() => { o.disconnect(); done(n); }, 1000); })""")
        self.assertLessEqual(changes, 2)

    def test_19_a_box_scrolled_into_view_under_a_press_takes_the_drop(self):
        page, _, _ = self.open(width=800, height=600)
        page.locator('#rows tr[data-uid] td').first.click()
        settle(page)
        self.arrange(page)
        b = self.cover(page, 'Related Report').bounding_box()
        page.mouse.move(b['x'] + b['width'] / 2, b['y'] + min(b['height'] / 2, 20)); page.mouse.down()
        page.mouse.move(b['x'] + b['width'] / 2 + 10, b['y'] + min(b['height'] / 2, 20) + 5, steps=3)
        for _ in range(8):
            page.mouse.wheel(0, 200)
            page.wait_for_timeout(80)
            if self.cover(page, 'Report Editor').count() and self.cover(page, 'Report Editor').is_visible():
                break
        page.mouse.move(*self.point(page, 'Report Editor'), steps=6)
        expect(self.cover(page, 'Report Editor')).to_contain_text('놓으면 Related Report와 Report Editor가 자리를 바꿉니다.')
        page.mouse.up()
        settle(page)
        self.assertEqual(['report'], self.stored(page)['workspace']['boxSwaps'])
    def test_20_the_release_decides_wheeling_back_to_the_pressed_box_drops_nothing(self):
        page, _, _ = self.open(width=800, height=600)
        page.locator('#rows tr[data-uid] td').first.click()
        settle(page)
        self.arrange(page)
        x, y = self.point(page, 'Related Report')
        page.mouse.move(x, y); page.mouse.down()
        page.mouse.move(x + 10, y + 5, steps=3)
        for _ in range(8):
            page.mouse.wheel(0, 200)
            page.wait_for_timeout(80)
            if self.cover(page, 'Report Editor').count() and self.cover(page, 'Report Editor').is_visible():
                break
        held = self.point(page, 'Report Editor')
        page.mouse.move(*held, steps=6)
        expect(self.cover(page, 'Report Editor')).to_contain_text('놓으면 Related Report와 Report Editor가 자리를 바꿉니다.')
        # The hand stays still; the wheel brings the pressed box itself back under it.
        under = "([x, y]) => document.elementFromPoint(x, y)?.closest('.kin-box-cover')?.getAttribute('aria-label') || null"
        for _ in range(16):
            page.mouse.wheel(0, -60)
            page.wait_for_timeout(120)
            if page.evaluate(under, list(held)) == 'Related Report':
                break
        self.assertEqual('Related Report', page.evaluate(under, list(held)), 'the pressed box did not come back under the pointer')
        page.mouse.up()
        settle(page)
        self.assertIsNone(self.stored(page))
        # (800x600 with a study selected is the stacked layout.)
        self.assert_order(page, ['worklist', 'relatedExams'], ['clinical', 'relatedReports', 'editor'], portrait=True)

    def test_21_the_arrange_captions_follow_the_chosen_screen_language(self):
        """Panel Settings and the arrange bar are built after the page's first markup was read for the screen
        language, so their fixed captions are product sentences: with Korean chosen they read in Korean, with English
        the Korean sentences read in English; the arrangement itself is the same in both."""
        # The account appearance row that keeps the chosen language (as the language page test serves it).
        from worklist_language_dom_test import LanguageSite
        page, _, _ = self.open(LanguageSite())

        def choose(lang):
            page.locator('#language-open').click()
            dialog = page.locator('#language-dialog')
            expect(dialog).to_be_visible()
            dialog.locator('#language-' + lang).check()
            for scope in ('worklist', 'reading'):
                dialog.locator('#language-scope-' + scope).check()
            dialog.locator('#language-apply').click()
            expect(dialog).to_be_hidden()

        def open_bar():
            page.locator('#m-config').click()
            expect(page.locator('#panel-settings-dialog')).to_be_visible()
            page.locator('#box-arrange-open').click()
            expect(page.locator('#box-arrange-bar')).to_be_visible()
            return page.locator('#box-arrange-bar')

        choose('ko')
        page.locator('#m-config').click()
        expect(page.locator('#box-arrange-open')).to_have_text('상자 배치')
        page.locator('#panel-settings-close').click()
        bar = open_bar()
        self.assertEqual('상자 배치', bar.get_attribute('aria-label'))
        expect(bar.locator('[data-box-swap="columns"]')).to_have_text('두 열 바꾸기')
        expect(bar.locator('[data-box-swap="list"]')).to_have_text('워크리스트 / 관련 검사 바꾸기')
        expect(bar.locator('#box-arrange-default')).to_have_text('기본 배치')
        bar.locator('[data-box-swap="list"]').click()
        expect(page.locator('#box-arrange-status')).to_have_text('자리를 바꿨습니다. 이 브라우저에 기억했습니다.')
        expect(page.locator('#box-arrange-covers .kin-box-cover small').first).to_have_text('다른 상자 위로 끌어 놓으세요')
        bar.locator('#box-arrange-done').click()
        expect(bar).to_be_hidden()
        self.assertEqual(['list'], page.evaluate(SWAP_CLASSES))

        choose('en')
        bar = open_bar()
        expect(page.locator('#box-arrange-help')).to_have_text(
            'Drag a box onto another box to swap the two. Dropping it on a box in the other column swaps the whole columns. '
            'Keyboard: press Enter on a box to pick it up, then Enter on the box to drop it on. The Tab order stays the same whatever the arrangement.')
        expect(bar.locator('[data-box-swap="columns"]')).to_have_text('Swap Columns')
        expect(page.locator('#box-arrange-covers .kin-box-cover small').first).to_have_text('Drag onto another box')
        bar.locator('[data-box-swap="list"]').click()
        expect(page.locator('#box-arrange-status')).to_have_text('Swapped. Remembered in this browser.')
        self.assertEqual([], page.evaluate(SWAP_CLASSES))

    # Each shown cover's name (its corners and centre are the cover itself, not the bar; it lies inside the cover's
    # on-screen part) and each bar button (its centre is itself, all of it inside the window). A cover thinner than its
    # name (a box scrolled almost out of view) has no room for it and is only counted.
    NAMES_CLEAR = '''() => {
      const bad = [], hit = (x, y) => document.elementFromPoint(x, y);
      let thin = 0;
      const covers = [...document.querySelectorAll('#box-arrange-covers .kin-box-cover')];
      for (const cover of covers) {
        const n = cover.querySelector('.kin-box-name').getBoundingClientRect(), c = cover.getBoundingClientRect();
        if (c.height < n.height + 4 || c.width < n.width + 4) { thin++; continue; }
        const points = [[n.left + 1, n.top + 1], [n.right - 1, n.top + 1], [n.left + 1, n.bottom - 1], [n.right - 1, n.bottom - 1],
          [(n.left + n.right) / 2, (n.top + n.bottom) / 2]];
        const under = points.filter(([x, y]) => !cover.contains(hit(x, y))).length;
        const inside = n.width > 0 && n.left >= c.left - 0.5 && n.right <= c.right + 0.5 && n.top >= c.top - 0.5 && n.bottom <= c.bottom + 0.5;
        if (under || !inside) bad.push({ box: cover.dataset.box, under, inside, name: [n.left, n.top, n.right, n.bottom].map(Math.round),
          cover: [c.left, c.top, c.right, c.bottom].map(Math.round), pad: cover.style.padding });
      }
      for (const b of document.querySelectorAll('#box-arrange-bar button')) {
        const r = b.getBoundingClientRect();
        if (hit((r.left + r.right) / 2, (r.top + r.bottom) / 2) !== b || r.left < 0 || r.top < 0 || r.right > innerWidth || r.bottom > innerHeight)
          bad.push({ button: b.textContent, at: [r.left, r.top, r.right, r.bottom].map(Math.round) });
      }
      return { names: covers.map(c => c.getAttribute('aria-label')).sort(), thin, bad }; }'''

    FIVE = ('Worklist', 'Related Exam', 'Clinical Information', 'Related Report', 'Report Editor')

    def assert_names_clear(self, page, label, names=FIVE):
        settle(page)
        found = page.evaluate(self.NAMES_CLEAR)
        # Every box that should have a cover has one (a thin one is only spared the name check).
        self.assertEqual(sorted(names), found['names'], label)
        self.assertEqual([], found['bad'], label)

    def set_swaps(self, bar, swaps):
        """The bar's own buttons, so the status sentence (a longer bar) is showing when the names are checked."""
        for key in ('columns', 'list', 'side', 'report'):
            button = bar.locator(f'[data-box-swap="{key}"]')
            if (button.get_attribute('aria-pressed') == 'true') != (key in swaps):
                button.click()
                expect(button).to_have_attribute('aria-pressed', 'true' if key in swaps else 'false')

    def test_22_the_bar_never_hides_a_box_name(self):
        """Arrange Boxes: the bar lies over the top of the page, but every box's name on its cover is still seen (what a
        drop moves is always named) — default and swapped, at the usual and a low window, both screen languages, and
        with the Clinical Information band folded."""
        arrangements = ([], ['columns'], ['list'], ['side'], ['report'], ['side', 'report'], ['columns', 'list', 'report'],
                        ['columns', 'side'])
        for width, height in ((1920, 1080), (1366, 768), (1366, 640), (1280, 600), (1024, 768), (768, 1024)):
            page, _, _ = self.open(width=width, height=height)
            page.locator('#rows tr[data-uid] td').first.click()
            settle(page)
            before = (self.boxes(page), self.stored(page))
            bar = self.arrange(page)
            self.assert_names_clear(page, f'{width}x{height} opened')
            for swaps in arrangements:
                with self.subTest(width=width, height=height, swaps=swaps):
                    self.set_swaps(bar, swaps)
                    # The stacked (portrait) page can put Related Report below the window when it goes under the editor
                    # and Clinical Information stays above them - then it has no cover in view (measured, not assumed:
                    # a shorter row above can bring it into the window, where its name must be clear like the others).
                    below = width < height and 'report' in swaps and 'side' not in swaps and page.evaluate(
                        "() => { const box = document.querySelector('.related-p'); return !box || box.getBoundingClientRect().top >= innerHeight - 1; }")
                    self.assert_names_clear(page, f'{width}x{height} {swaps}',
                                            names=tuple(n for n in self.FIVE if not (below and n == 'Related Report')))
            # A picked box says so in the bar's status line; the names stay clear.
            self.cover(page, 'Worklist').focus()
            page.keyboard.press('Enter')
            expect(page.locator('#box-arrange-status')).not_to_have_text('')
            self.assert_names_clear(page, f'{width}x{height} picked')
            page.screenshot(path=str(OUT / f'names-clear-{width}x{height}.png'))
            page.keyboard.press('Escape')
            bar.locator('#box-arrange-default').click()
            bar.locator('#box-arrange-done').click()
            expect(bar).to_be_hidden()
            # Opening and closing leaves the boxes' sizes as they were (the swaps went home through Default).
            self.assertEqual(before[0], self.boxes(page), f'{width}x{height}')
            after = self.stored(page) or {}
            for axis in ('landscape', 'portrait'):
                self.assertEqual((before[1] or {}).get(axis) or {}, after.get(axis) or {}, axis)
            self.assertEqual([], (after.get('workspace') or {}).get('boxSwaps') or [])

        # English captions (a different bar width and wrap) at the low window.
        from worklist_language_dom_test import LanguageSite
        page, _, _ = self.open(LanguageSite(), width=1366, height=640)
        page.locator('#language-open').click()
        dialog = page.locator('#language-dialog')
        dialog.locator('#language-en').check()
        for scope in ('worklist', 'reading'):
            dialog.locator('#language-scope-' + scope).check()
        dialog.locator('#language-apply').click()
        expect(dialog).to_be_hidden()
        bar = self.arrange_any_language(page)
        for swaps in ([], ['list'], ['side'], ['columns']):
            with self.subTest(language='en', swaps=swaps):
                self.set_swaps(bar, swaps)
                self.assert_names_clear(page, f'en {swaps}')

        # The Clinical Information band folded to its names row (a short box at the top of the report column).
        from reading_panels_fold_dom_test import plant, record
        for swaps in ((), ('columns',), ('side',)):
            with self.subTest(folded='clinical', swaps=swaps):
                page, _, _ = self.open(width=1366, height=768, init=plant(record(collapsed=('clinical',), swaps=swaps)))
                page.locator('#rows tr[data-uid] td').first.click()
                self.arrange(page)
                expect(self.cover(page, 'Clinical Information')).to_be_visible()
                self.assert_names_clear(page, f'folded {swaps}')

    def test_23_names_stay_clear_in_technician_under_a_drag_and_with_the_study_panel(self):
        """Technician (Order List takes the editor's place, and can be at the top), a drag held over a box (its cover
        then says what the drop would do), and the Study Panel drawer: it steps aside while arranging and is back on
        Done; the reader opening it while arranging ends arranging."""
        page, _, _ = self.open(width=1366, height=768)
        page.locator('.tabs > div[data-tab="Technician"]').click()
        expect(page.locator('.tabs > div[data-tab="Technician"]')).to_have_class('on')
        bar = self.arrange(page)
        for swaps in ([], ['side', 'report'], ['columns', 'list']):
            with self.subTest(technician=swaps):
                self.set_swaps(bar, swaps)
                expect(self.cover(page, 'Order List')).to_be_visible()
                self.assert_names_clear(page, f'technician {swaps}', names=self.FIVE[:4] + ('Order List',))
        self.set_swaps(bar, [])
        # Held over the box at the top of the report column, before the release.
        page.mouse.move(*self.point(page, 'Worklist'))
        page.mouse.down()
        page.mouse.move(*self.point(page, 'Clinical Information'), steps=8)
        expect(self.cover(page, 'Clinical Information')).to_contain_text('놓으면')
        tech = self.FIVE[:4] + ('Order List',)
        self.assert_names_clear(page, 'held over Clinical Information', names=tech)
        page.mouse.move(*self.point(page, 'Related Exam'), steps=4)
        self.assert_names_clear(page, 'held over Related Exam', names=tech)
        page.mouse.up()
        settle(page)
        self.set_swaps(bar, [])
        bar.locator('#box-arrange-done').click()
        expect(bar).to_be_hidden()

        # 800x600 with the Study Panel open: while arranging it steps aside and every name is seen; Done brings it back
        # on the same tab.
        page, _, _ = self.open(width=800, height=600)
        page.locator('#rows tr[data-uid] td').first.click()
        page.keyboard.press('Control+Alt+5')
        drawer = page.get_by_role('complementary', name='Study Panel', exact=True)
        expect(drawer).to_be_visible()
        settle(page)
        tab = page.evaluate("() => document.querySelector('#study-panel-host [role=tab][aria-selected=true]')?.textContent")
        place = drawer.bounding_box()
        bar = self.arrange(page)
        expect(drawer).to_be_hidden()
        self.assert_names_clear(page, '800x600 study panel', names=('Worklist', 'Related Exam', 'Related Report'))
        bar.locator('#box-arrange-done').click()
        expect(bar).to_be_hidden()
        expect(drawer).to_be_visible()
        self.assertEqual(place, drawer.bounding_box())
        self.assertEqual(tab, page.evaluate("() => document.querySelector('#study-panel-host [role=tab][aria-selected=true]')?.textContent"))
        # The reader opens the drawer while arranging (View > Study Panel): arranging ends and the drawer shows.
        def toggle_drawer():
            page.locator('#toolbar-view > summary').click()
            page.get_by_role('button', name='Study Panel', exact=True).click()
        toggle_drawer()
        expect(drawer).to_be_hidden()
        bar = self.arrange(page)
        toggle_drawer()
        expect(bar).to_be_hidden()
        expect(drawer).to_be_visible()
        expect(page.locator('#box-arrange-covers .kin-box-cover')).to_have_count(0)
        # A drawer tab asked for by its shortcut while arranging (the drawer open and stepped aside): arranging ends and
        # the drawer shows that tab.
        bar = self.arrange(page)
        expect(drawer).to_be_hidden()
        page.keyboard.press('Control+Alt+T')
        expect(bar).to_be_hidden()
        expect(drawer).to_be_visible()
        expect(page.locator('#study-panel-host [role=tab][aria-selected=true]')).to_contain_text('Templates')

    def arrange_any_language(self, page):
        page.locator('#m-config').click()
        expect(page.locator('#panel-settings-dialog')).to_be_visible()
        page.locator('#box-arrange-open').click()
        bar = page.locator('#box-arrange-bar')
        expect(bar).to_be_visible()
        return bar

if __name__ == '__main__':
    unittest.main()
