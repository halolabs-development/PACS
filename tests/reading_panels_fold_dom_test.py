"""The report window band's five panels fold and open in place, one by one, and the choice is kept per account
(2026-10-27 feedback item 9: "Make these panels independently collapsible: Thumbnail / AI Report / Image Report /
Clinical Information / Reading Template. Additionally: Allow individual panels to be shown or hidden through Settings.
Remember each user's visibility and expanded/collapsed preferences. Reallocate unused space to diagnostic images and
reporting. Restore the preferred arrangement automatically.").

REQ -> RISK: a fold that hides the panel's name (no way back), a fold that is Show/Hide under another name, folds
forgotten on reload or mixed between accounts, freed space not given back, a fold that moves the report being
written, a control off screen in a small window, words outside the screen language -> TEST-PANELS-FOLD-DOM-01..18.

The real main.html and its assets are served; only HTTP answers are synthetic (study_panel_page_dom_test.WorkspaceSite).
Every assertion reads public controls, geometry, focus, field values and the stored preferences.
"""
import json
import os
import re
import sys
import unittest
from pathlib import Path

from playwright.sync_api import expect, sync_playwright

sys.path.insert(0, str(Path(__file__).resolve().parent))
import study_panel_page_dom_test as dom  # noqa: E402,F401
from study_panel_page_dom_test import KEY, RASTER, WorkspaceSite, auth, settle, wait_startup  # noqa: E402

OUT = Path(os.environ.get('KIN_FOLD_OUT', dom.ROOT / 'tmp/reading-panels-fold/dom'))
PANELS = ('thumbnail', 'aiReport', 'imageReport', 'clinical', 'template')
LABEL = {'thumbnail': 'Thumbnail', 'aiReport': 'AI Report', 'imageReport': 'Image Report',
         'clinical': 'Clinical Information', 'template': 'Reading Template'}
# What shows a panel's content on the band (AI Report is a placeholder tab).
CONTENT = {'thumbnail': '.rw > .s-thumb > .thumbwrap', 'aiReport': '.rw > .s-thumb > .rtabs > [data-panel="aiReport"]',
           'imageReport': '.rw > .s-imgreport', 'clinical': '.rw > .s-clinical', 'template': '.rw > .s-template'}
GEOMETRY = '''() => { const r = s => { const n = document.querySelector(s); if (!n || !n.getClientRects().length) return null;
  const b = n.getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height, right: b.right, bottom: b.bottom }; };
  return { band: r('.right > .rw'), folds: r('.rw > .rw-folds'), related: r('.workrow > .related-p'), report: r('.workrow > .report-p'),
    thumb: r('.rw > .s-thumb'), image: r('.rw > .s-imgreport'), clinical: r('.rw > .s-clinical'), template: r('.rw > .s-template'),
    handle: r('#resize-top'), viewport: [innerWidth, innerHeight] }; }'''


def record(hidden=(), collapsed=(), swaps=()):
    workspace = {'version': 1, 'rail': None, 'worklist': None, 'related': None, 'prior': None,
                 'railCollapsed': False, 'studyPanelTab': 'info'}
    if hidden:
        workspace['hiddenPanels'] = [k for k in PANELS if k in hidden]
    if collapsed:
        workspace['collapsedPanels'] = [k for k in PANELS if k in collapsed]
    if swaps:
        workspace['boxSwaps'] = list(swaps)
    return {'version': 3, 'mode': 'auto', 'portrait': {}, 'landscape': {},
            'reading': {'version': 1, 'reportWidth': None, 'imageHeight': None, 'relatedHeight': None,
                        'relatedListHeight': None, 'relatedHidden': False},
            'workspace': workspace}


def plant(value, key=KEY):
    """An init script: this record for `key` (once: a reload keeps what the page stored), and the one-time
    "Clinical only" first-use switch already made."""
    return ("localStorage.setItem('kin-clinical-only-default', '1');"
            + 'if (localStorage.getItem(%s) === null) localStorage.setItem(%s, %s);'
            % (json.dumps(key), json.dumps(key), json.dumps(json.dumps(value))))


class ReadingPanelsFoldDOM(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        OUT.mkdir(parents=True, exist_ok=True)
        cls.pw = sync_playwright().start()
        cls.browser = cls.pw.chromium.launch(args=RASTER)

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.pw.stop()

    def open(self, site=None, width=1920, height=1080, init=None):
        site = site or WorkspaceSite()
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
        return page, site

    @staticmethod
    def stored(page, key=KEY):
        return page.evaluate('(key) => JSON.parse(localStorage.getItem(key))', key)

    def collapsed(self, page, key=KEY):
        return (self.stored(page, key) or {}).get('workspace', {}).get('collapsedPanels', [])

    @staticmethod
    def geometry(page):
        settle(page)
        return page.evaluate(GEOMETRY)

    @staticmethod
    def fold(page, key):
        return page.locator(f'.rw [data-fold="{key}"]')

    @staticmethod
    def unfold(page, key):
        return page.locator(f'.rw > .rw-folds > [data-unfold="{key}"]')

    def assert_open(self, page, key):
        expect(page.locator(CONTENT[key])).to_be_visible()
        expect(self.fold(page, key)).to_be_visible()
        expect(self.fold(page, key)).to_have_attribute('aria-expanded', 'true')
        expect(self.unfold(page, key)).to_be_hidden()

    def assert_folded(self, page, key):
        expect(page.locator(CONTENT[key])).to_be_hidden()
        expect(self.fold(page, key)).to_be_hidden()
        expect(self.unfold(page, key)).to_be_visible()
        expect(self.unfold(page, key)).to_have_attribute('aria-expanded', 'false')
        expect(self.unfold(page, key)).to_have_text(LABEL[key])

    def test_01_a_reader_who_never_folds_sees_todays_band_and_nothing_new_is_stored(self):
        """Thin slice: first use (Clinical Information only) is the same band; each open panel has its fold button."""
        page, _ = self.open()
        expect(page.locator('.rw > .rw-folds')).to_be_hidden()
        self.assert_open(page, 'clinical')
        for key in ('thumbnail', 'aiReport', 'imageReport', 'template'):
            expect(page.locator(CONTENT[key])).to_be_hidden()
            expect(self.fold(page, key)).to_be_hidden()
            expect(self.unfold(page, key)).to_be_hidden()
        self.assertNotIn('collapsedPanels', (self.stored(page) or {}).get('workspace', {}))
        # Existing header words and controls are where they were: the fold button adds no text.
        expect(page.locator('.rw > .s-template > h3')).to_have_text('Reading Template')
        expect(page.locator('.rw > .s-clinical #sr-open')).to_have_text('Source SR')

    def test_02_each_panel_folds_and_opens_with_the_mouse_and_its_width_goes_to_the_open_ones(self):
        page, _ = self.open(init=plant(record()))
        for key in PANELS:
            self.assert_open(page, key)
        full = self.geometry(page)
        folded = []
        for key in PANELS:
            with self.subTest(fold=key):
                self.fold(page, key).click()
                folded.append(key)
                self.assert_folded(page, key)
                expect(self.unfold(page, key)).to_be_focused()
                self.assertEqual([k for k in PANELS if k in folded], self.collapsed(page))
                g = self.geometry(page)
                # The open columns share the band's whole width (the folded one owns none); with Thumbnail folded
                # the AI Report tab is a strip across the band, not a column. Clinical keeps its 6 px margins.
                columns = ('image', 'clinical', 'template') if 'thumbnail' in folded else ('thumb', 'image', 'clinical', 'template')
                open_columns = [g[n] for n in columns if g[n]]
                if open_columns:
                    margins = 12 if g['clinical'] else 0
                    self.assertAlmostEqual(g['band']['w'], sum(c['w'] for c in open_columns) + margins, delta=3)
                # The other panels keep their own state.
                for other in PANELS:
                    if other not in folded:
                        self.assert_open(page, other)
        # Opening one panel again brings it back alone, in its place.
        self.unfold(page, 'template').click()
        self.assert_open(page, 'template')
        expect(self.fold(page, 'template')).to_be_focused()
        self.assertEqual(['thumbnail', 'aiReport', 'imageReport', 'clinical'], self.collapsed(page))
        for key in ('thumbnail', 'aiReport', 'imageReport', 'clinical'):
            self.unfold(page, key).click()
        for key in PANELS:
            self.assert_open(page, key)
        self.assertEqual([], self.collapsed(page))
        again = self.geometry(page)
        for name in ('thumb', 'image', 'clinical', 'template', 'related', 'report'):
            self.assertAlmostEqual(full[name]['x'], again[name]['x'], delta=1, msg=name)
            self.assertAlmostEqual(full[name]['w'], again[name]['w'], delta=1, msg=name)
            self.assertAlmostEqual(full[name]['h'], again[name]['h'], delta=1, msg=name)

    def test_03_keyboard_folds_and_opens_and_the_report_being_written_does_not_move(self):
        page, _ = self.open(init=plant(record(hidden=('imageReport',))))
        page.locator('#rows tr[data-uid]').first.click()
        settle(page)
        field = page.locator('#findings')
        field.fill('SYN findings kept while the panels fold')
        field.evaluate('f => f.setSelectionRange(4, 12)')
        notices = page.locator('#report-notices').inner_text()
        save = page.locator('#b-save').is_disabled()
        self.fold(page, 'clinical').focus()
        page.keyboard.press('Enter')
        self.assert_folded(page, 'clinical')
        expect(self.unfold(page, 'clinical')).to_be_focused()
        page.keyboard.press('Space')
        self.assert_open(page, 'clinical')
        expect(self.fold(page, 'clinical')).to_be_focused()
        # Tab reaches the fold buttons as ordinary buttons.
        self.fold(page, 'template').focus()
        page.keyboard.press('Enter')
        self.assert_folded(page, 'template')
        self.assertEqual('SYN findings kept while the panels fold', field.input_value())
        self.assertEqual([4, 12], field.evaluate('f => [f.selectionStart, f.selectionEnd]'))
        self.assertEqual(notices, page.locator('#report-notices').inner_text())
        self.assertEqual(save, page.locator('#b-save').is_disabled())

    def test_04_with_every_panel_folded_the_band_is_the_names_row_and_its_height_goes_to_the_report(self):
        page, _ = self.open()
        page.locator('#rows tr[data-uid]').first.click()
        before = self.geometry(page)
        self.fold(page, 'clinical').click()
        after = self.geometry(page)
        self.assertIsNone(after['clinical'])
        self.assertIsNone(after['handle'])
        self.assertLess(after['band']['h'], 40)
        self.assertAlmostEqual(after['band']['h'], after['folds']['h'], delta=1)
        gain = before['band']['h'] - after['band']['h']
        self.assertGreater(gain, 100)
        # The Related Report and the Report Editor take that height.
        self.assertAlmostEqual(before['related']['h'] + before['report']['h'] + gain,
                               after['related']['h'] + after['report']['h'], delta=12)
        self.assertGreater(after['report']['h'], before['report']['h'])
        self.unfold(page, 'clinical').click()
        back = self.geometry(page)
        for name in ('band', 'related', 'report'):
            self.assertAlmostEqual(before[name]['h'], back[name]['h'], delta=1, msg=name)

    def test_05_folds_are_drawn_from_the_first_paint_after_a_reload(self):
        page, site = self.open(init=plant(record()))
        self.fold(page, 'thumbnail').click()
        self.fold(page, 'template').click()
        self.assertEqual(['thumbnail', 'template'], self.collapsed(page))
        status = page.locator('#layout-status').inner_text()
        page.reload()
        expect(page.locator('#rows')).to_contain_text(auth.PATIENT)
        wait_startup(page, site)
        for key in ('thumbnail', 'template'):
            self.assert_folded(page, key)
        for key in ('aiReport', 'imageReport', 'clinical'):
            self.assert_open(page, key)
        # A fold is saved quietly: the toolbar status line (which wraps in narrow windows) is not rewritten.
        self.assertTrue(status)
        expect(page.locator('#toast')).not_to_have_class(re.compile(r'\berr\b'))

    def test_06_another_account_in_this_browser_keeps_its_own_folds(self):
        other = 'kin-workspace:v1:' + json.dumps([auth.INSTITUTION, 'synthetic-other-reader'], separators=(',', ':'))
        page, _ = self.open(init=plant(record(collapsed=('clinical',)), other))
        self.assert_open(page, 'clinical')
        self.assertEqual(['clinical'], self.collapsed(page, other))
        page, _ = self.open(init=plant(record(collapsed=('clinical',))))
        self.assert_folded(page, 'clinical')

    def test_07_account_layout_carries_the_folds_to_another_browser(self):
        site = WorkspaceSite()
        page, _ = self.open(site, init=plant(record()))
        self.fold(page, 'imageReport').click()
        self.fold(page, 'clinical').click()
        page.locator('#toolbar-view > summary').click()
        page.locator('#workspace-server-menu > summary').click()
        page.get_by_role('button', name='Save to Account', exact=True).click()
        expect(page.locator('#workspace-server-status')).to_contain_text('현재 배치를 계정에 저장')
        self.assertEqual(['imageReport', 'clinical'], site.layout['workspace']['collapsedPanels'])
        other, _ = self.open(site)
        self.assert_open(other, 'clinical')
        other.locator('#toolbar-view > summary').click()
        other.locator('#workspace-server-menu > summary').click()
        other.get_by_role('button', name='Load from Account', exact=True).click()
        expect(other.locator('#workspace-server-status')).to_contain_text('서버 배치를 불러왔습니다')
        for key in ('imageReport', 'clinical'):
            self.assert_folded(other, key)
        self.assertEqual(['imageReport', 'clinical'], self.collapsed(other))

    def test_08_show_hide_in_settings_is_separate_and_reset_layout_opens_every_panel(self):
        page, _ = self.open(init=plant(record()))
        self.fold(page, 'clinical').click()
        page.locator('#m-config').click()
        dialog = page.get_by_role('dialog', name='Panel Settings', exact=True)
        expect(dialog).to_be_visible()
        # Hidden: neither the panel nor its name is on the band; the fold is still remembered.
        dialog.get_by_label('Clinical Information', exact=True).uncheck()
        expect(self.unfold(page, 'clinical')).to_be_hidden()
        expect(page.locator(CONTENT['clinical'])).to_be_hidden()
        self.assertEqual(['clinical'], self.collapsed(page))
        self.assertIn('clinical', self.stored(page)['workspace']['hiddenPanels'])
        # Shown again: it comes back folded, as remembered.
        dialog.get_by_label('Clinical Information', exact=True).check()
        self.assert_folded(page, 'clinical')
        dialog.get_by_label('Thumbnail', exact=True).uncheck()
        dialog.get_by_role('button', name='Show All Panels', exact=True).click()
        self.assert_open(page, 'thumbnail')
        self.assert_folded(page, 'clinical')
        dialog.get_by_role('button', name='Close', exact=True).click()
        page.locator('#toolbar-view > summary').click()
        page.locator('#layout-reset').click()
        settle(page)
        expect(self.unfold(page, 'clinical')).to_be_hidden()
        self.assert_open(page, 'clinical')
        self.assertEqual([], self.collapsed(page))

    def test_09_a_folded_panel_stays_folded_when_another_study_comes_and_opens_on_its_content(self):
        # What the open panel shows for the study, in a window that never folds it.
        page, _ = self.open()
        page.locator('#rows tr[data-uid]').first.click()
        settle(page)
        shown = page.locator('#clinical').inner_text()
        page, _ = self.open()
        before = page.locator('#clinical').inner_text()
        self.fold(page, 'clinical').click()
        # The study comes while the panel is folded: it stays folded and says nothing on the band.
        page.locator('#rows tr[data-uid]').first.click()
        settle(page)
        self.assertNotEqual(before, shown)
        self.assert_folded(page, 'clinical')
        self.unfold(page, 'clinical').click()
        self.assert_open(page, 'clinical')
        self.assertEqual(shown, page.locator('#clinical').inner_text())

    def test_10_arrange_boxes_counts_the_band_with_clinical_folded_and_keeps_the_folds(self):
        page, _ = self.open(init=plant(record(hidden=('imageReport', 'aiReport'))))
        self.fold(page, 'clinical').click()
        page.locator('#m-config').click()
        dialog = page.get_by_role('dialog', name='Panel Settings', exact=True)
        dialog.get_by_role('button', name='Arrange Boxes', exact=True).click()
        bar = page.get_by_role('region', name='Arrange Boxes', exact=True)
        expect(bar).to_be_visible()
        expect(page.locator('#box-arrange-covers .kin-box-cover')).to_have_count(5)
        bar.get_by_role('button', name='Move Clinical Information', exact=True).click()
        bar.get_by_role('button', name='Done', exact=True).click()
        expect(bar).to_be_hidden()
        self.assert_folded(page, 'clinical')
        self.assertEqual(['clinical'], self.collapsed(page))
        self.assertEqual(['side'], self.stored(page)['workspace']['boxSwaps'])
        # The band (now under the report) still opens the panel in place.
        self.unfold(page, 'clinical').click()
        self.assert_open(page, 'clinical')
        g = self.geometry(page)
        self.assertGreater(g['clinical']['y'], g['report']['y'])

    def test_11_small_windows_keep_the_folded_names_on_screen_and_the_report_reachable(self):
        cases = (record(collapsed=('thumbnail', 'imageReport', 'template')), record(collapsed=PANELS))
        for width, height in ((1366, 768), (1366, 640), (840, 768)):
            for value in cases:
                with self.subTest(width=width, height=height, folded=value['workspace']['collapsedPanels']):
                    page, _ = self.open(width=width, height=height, init=plant(value))
                    page.locator('#rows tr[data-uid]').first.click()
                    settle(page)
                    for key in value['workspace']['collapsedPanels']:
                        chip = self.unfold(page, key)
                        expect(chip).to_be_visible()
                        box = chip.bounding_box()
                        self.assertLessEqual(box['x'] + box['width'], width + 0.5, key)
                        self.assertGreaterEqual(box['x'], 0, key)
                    for control in ('#findings', '#b-save'):
                        page.locator(control).scroll_into_view_if_needed()
                        expect(page.locator(control)).to_be_in_viewport()
                    page.screenshot(path=str(OUT / f'panels-fold-{width}x{height}-{len(value["workspace"]["collapsedPanels"])}.png'))

    def test_12_the_new_words_follow_the_screen_language(self):
        from worklist_language_dom_test import LanguageSite
        page, _ = self.open(LanguageSite(), init=plant(record(collapsed=('clinical',))))
        expect(page.locator('.rw > .rw-folds')).to_have_attribute('aria-label', '접힌 패널')
        expect(self.fold(page, 'template')).to_have_attribute('aria-label', 'Reading Template 패널 접기')
        page.locator('#language-open').click()
        dialog = page.locator('#language-dialog')
        dialog.locator('#language-en').check()
        for scope in ('worklist', 'reading'):
            dialog.locator('#language-scope-' + scope).check()
        dialog.locator('#language-apply').click()
        expect(dialog).to_be_hidden()
        expect(page.locator('.rw > .rw-folds')).to_have_attribute('aria-label', 'Folded panels')
        expect(self.fold(page, 'template')).to_have_attribute('aria-label', 'Fold the Reading Template panel')
        expect(self.unfold(page, 'clinical')).to_have_attribute('title', 'Open the Clinical Information panel')
        page.locator('#language-open').click()
        dialog.locator('#language-ko').check()
        dialog.locator('#language-apply').click()
        expect(dialog).to_be_hidden()
        expect(self.unfold(page, 'clinical')).to_have_text('임상 정보')
        expect(self.fold(page, 'template')).to_have_attribute('aria-label', 'Reading Template 패널 접기')
        # Folding still works in either language.
        self.unfold(page, 'clinical').click()
        self.assert_open(page, 'clinical')

    def test_13_technician_shows_only_its_own_panels_names_and_keeps_the_others_choice(self):
        page, _ = self.open(init=plant(record(collapsed=('imageReport', 'template'))))
        self.assert_folded(page, 'imageReport')
        page.locator('.tabs > div[data-tab="Technician"]').click()
        expect(page.locator('.tabs > div[data-tab="Technician"]')).to_have_class('on')
        settle(page)
        expect(self.unfold(page, 'imageReport')).to_be_hidden()
        expect(self.unfold(page, 'template')).to_be_hidden()
        expect(page.locator('.rw > .rw-folds')).to_be_hidden()
        self.fold(page, 'clinical').click()
        self.assert_folded(page, 'clinical')
        self.assertEqual(['imageReport', 'clinical', 'template'], self.collapsed(page))

    def test_14_study_panel_and_reading_workspace_show_every_panel_open_without_fold_buttons(self):
        page, _ = self.open(init=plant(record(collapsed=('clinical', 'template'))))
        page.route('**/ohif/**', lambda route: route.fulfill(content_type='text/html', body='<!doctype html><title>SYN viewer</title>'))
        page.locator('#rows tr[data-uid]').first.click()
        settle(page)
        page.keyboard.press('Control+Alt+5')
        host = page.locator('#study-panel-host')
        expect(page.get_by_role('complementary', name='Study Panel', exact=True)).to_be_visible()
        expect(host.locator('.s-clinical')).to_be_attached()
        expect(host.locator('.panel-fold:visible')).to_have_count(0)
        page.keyboard.press('Escape')
        settle(page)
        self.assert_folded(page, 'clinical')
        page.get_by_role('button', name='Reading Workspace', exact=True).click()
        expect(page.locator('body')).to_have_class(re.compile(r'\breading\b'))
        settle(page)
        expect(page.locator('.panel-fold:visible')).to_have_count(0)
        expect(page.locator('.panel-unfold:visible')).to_have_count(0)
        self.assertEqual(['clinical', 'template'], self.collapsed(page))

    def test_15_a_fold_that_cannot_be_stored_stays_in_this_window_and_says_so(self):
        init = plant(record()) + (
            "const set = Storage.prototype.setItem; Storage.prototype.setItem = function (k, v) {"
            " if (String(k).startsWith('kin-workspace:') && String(v).includes('collapsedPanels')) throw new Error('SYN full');"
            " return set.call(this, k, v); };")
        page, _ = self.open(init=init)
        before = page.locator('#layout-status').inner_text()
        self.fold(page, 'thumbnail').click()
        self.assert_folded(page, 'thumbnail')
        expect(page.locator('#toast')).to_have_text('패널 접기를 브라우저에 저장하지 못해 이 창에서만 유지됩니다.')
        expect(page.locator('#toast')).to_have_class(re.compile(r'\bshow\b.*\berr\b'))
        self.assertEqual([], self.collapsed(page))
        self.assertEqual(before, page.locator('#layout-status').inner_text())
        # Said once: the next fold that cannot be kept either does not say it again.
        page.evaluate("() => { document.querySelector('#toast').textContent = ''; }")
        self.fold(page, 'template').click()
        self.assert_folded(page, 'template')
        expect(page.locator('#toast')).to_have_text('')

    def test_16_ai_report_folds_alone_and_thumbnail_folds_alone_in_their_shared_section(self):
        page, _ = self.open(init=plant(record(hidden=('imageReport', 'template'))))
        self.fold(page, 'aiReport').click()
        self.assert_folded(page, 'aiReport')
        self.assert_open(page, 'thumbnail')
        expect(page.locator('.rw > .s-thumb > .rtabs > [data-panel="thumbnail"]')).to_be_visible()
        self.unfold(page, 'aiReport').click()
        self.fold(page, 'thumbnail').click()
        self.assert_folded(page, 'thumbnail')
        # AI Report alone is the full-width tab strip above the content, with its own fold button beside it.
        self.assert_open(page, 'aiReport')
        g = self.geometry(page)
        self.assertAlmostEqual(g['band']['w'], g['thumb']['w'], delta=1)
        tab = page.locator('.rw > .s-thumb > .rtabs > [data-panel="aiReport"]').bounding_box()
        button = self.fold(page, 'aiReport').bounding_box()
        self.assertLess(button['x'] - (tab['x'] + tab['width']), 8)
        self.assertGreater(g['clinical']['y'], g['thumb']['y'])
        self.fold(page, 'aiReport').click()
        self.assertEqual(['thumbnail', 'aiReport'], self.collapsed(page))
        self.assert_open(page, 'clinical')

    def test_17_multi_study_and_short_windows_keep_the_names_row_clickable_and_give_the_height_back(self):
        import multi_study_view_dom_test as multi
        for width, height in ((1366, 768), (1366, 640), (840, 768)):
            with self.subTest(size=f'{width}x{height}'):
                site = multi.W9Site()
                context = self.browser.new_context(viewport={'width': width, 'height': height})
                context.route('**/*', lambda route, request, s=site: s.handle(route, request))
                context.add_init_script(plant(record()))
                page = context.new_page()
                errors = []
                page.on('pageerror', lambda e: errors.append(str(e)))
                page.on('dialog', lambda d: d.accept())
                self.addCleanup(context.close)
                self.addCleanup(lambda e=errors: self.assertEqual([], e))
                self.addCleanup(lambda s=site: self.assertEqual([], s.violations))
                page.goto(auth.MAIN_URL)
                expect(page.locator('#rows')).to_contain_text(multi.ALPHA)
                settle(page)
                site.viewer_owner = page.evaluate(
                    '() => KinViewerOpening.key(KinAuth.session()).slice(KinViewerOpening.PREFIX.length)')
                for uid in page.locator('#rows tr[data-uid]').evaluate_all('rows => rows.slice(0, 2).map(r => r.dataset.uid)'):
                    page.locator(f'#rows tr[data-uid="{uid}"]').click(modifiers=['Control'])
                page.locator('#multi-selection-open-set').click()
                expect(page.locator('#multi-study')).to_be_visible()
                before = self.geometry(page)
                for key in PANELS:
                    self.fold(page, key).click()
                after = self.geometry(page)
                page.screenshot(path=str(OUT / f'panels-fold-multi-{width}x{height}.png'))
                self.assertIsNone(after['handle'])
                self.assertAlmostEqual(after['band']['h'], after['folds']['h'], delta=1)
                # The band is the names row and no more. Where Multi-Study had already squeezed the band below it (840 px:
                # five names wrap to two lines in the narrow column) the row keeps every name whole rather than clipping one.
                if after['folds']['h'] < 40:
                    self.assertLess(after['band']['h'], before['band']['h'])
                # Each name is what is drawn at its own centre.
                hits = page.evaluate('''() => [...document.querySelectorAll('.rw > .rw-folds > .panel-unfold')]
                  .filter(n => n.getClientRects().length).map(n => { const b = n.getBoundingClientRect();
                    return document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2)?.closest('.panel-unfold')?.dataset.unfold ?? null; })''')
                self.assertEqual(list(PANELS), hits)
                for key in PANELS:
                    self.unfold(page, key).click()
                back = self.geometry(page)
                self.assertAlmostEqual(before['band']['h'], back['band']['h'], delta=1)
                page.locator('#multi-study-close').click()
                expect(page.locator('#multi-study')).to_be_hidden()

    def test_18_with_two_screen_languages_the_new_words_follow_the_band(self):
        from worklist_language_dom_test import LanguageSite
        page, _ = self.open(LanguageSite(), init=plant(record(collapsed=('clinical',))))
        dialog = page.locator('#language-dialog')

        def apply(lang, scope):
            page.locator('#language-open').click()
            dialog.locator('#language-' + lang).check()
            for name in ('worklist', 'reading'):
                box = dialog.locator('#language-scope-' + name)
                box.check() if name == scope else box.uncheck()
            dialog.locator('#language-apply').click()
            expect(dialog).to_be_hidden()
        for worklist, reading in (('en', 'ko'), ('ko', 'en')):
            with self.subTest(worklist=worklist, reading=reading):
                apply(worklist, 'worklist')
                apply(reading, 'reading')
                settle(page)
                self.assertIn(page.locator('.rw > .s-template > h3').inner_text().strip(), ('Reading Template', '판독 상용구'))
                # The band's own title says which language the band is in; the new words say it the same way.
                english = page.locator('.rw > .s-template > h3').inner_text().strip() == 'Reading Template'
                expect(self.fold(page, 'template')).to_have_attribute(
                    'aria-label', 'Fold the Reading Template panel' if english else 'Reading Template 패널 접기')
                expect(page.locator('.rw > .rw-folds')).to_have_attribute('aria-label', 'Folded panels' if english else '접힌 패널')


if __name__ == '__main__':
    unittest.main()
