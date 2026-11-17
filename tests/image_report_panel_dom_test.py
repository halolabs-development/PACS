# coding: utf-8
"""The Image Report panel of the report window band (main.html .s-imgreport; image-report.js) on the delivered page.

REQ 2026-10-27 feedback item 9: "Make these panels independently collapsible: Thumbnail / AI Report / Image Report /
Clinical Information / Reading Template. Allow individual panels to be shown or hidden through Settings. Remember each
user's visibility ... Reallocate unused space to diagnostic images and reporting. Restore the preferred arrangement
automatically." -> TEST-IRPANEL-01..05:
  01 Panel Settings lists Image Report; it starts hidden (first use shows Clinical Information only) and its checkbox
     alone shows and hides the band's Image Report panel - the other panels stay as they were;
  02 hiding it gives its width back to the panels beside it, and with every other panel hidden it takes the whole band;
     with it hidden as well the band is gone and the Related/report row takes the height;
  03 the choice is kept in this account's layout record and comes back after a reload without any action;
  04 the panel shows the drawings attached to the selected study's report (the same list as the strip under
     Conclusion), follows another study, follows an attach made in the drawing window, and says when the list could not
     be read (and reads it again on the next redraw);
  05 Draw in the panel opens the drawing window for the selected study; closing it returns focus to Draw;
  06-11 the panel is a mirror of the strip's rendering (the same drawings, order and pictures drawn or not), never a read
     of its own: two pictures with the window reading one meanwhile (06), a newer rendering of the same study ending
     first (08), A then B then A (09), attach and remove while hidden and then shown without a read (10), and a picture
     not drawn refusing the save until the next read draws it (11);
  07 where the report takes no edits Draw is off, while the panel still shows the drawings.
The real main.html, its bundle and assets are served; only HTTP is synthetic (image_report_dom_test.DrawingSite).
"""
import json
import re
import unittest

import auth_logout_dom_test as h
import image_report_dom_test as ir
from playwright.sync_api import expect

BAND = '''() => { const r = s => { const n = document.querySelector(s); if (!n || !n.getClientRects().length) return null;
  const b = n.getBoundingClientRect(); return [b.x, b.y, b.width, b.height]; };
  return { rw: r('.right > .rw'), thumb: r('.rw > .s-thumb .thumbwrap'), image: r('.rw > .s-imgreport'),
    clinical: r('.rw > .s-clinical'), template: r('.rw > .s-template'), workrow: r('.workrow') }; }'''
STORED = '''() => { const k = Object.keys(localStorage).find(k => k.startsWith('kin-workspace:v1:'));
  return k ? JSON.parse(localStorage.getItem(k)) : null; }'''


class ImageReportPanel(unittest.TestCase):
    """The flow suite's browser, page and helpers, and the drawing window's own helpers (image_report_dom_test)."""
    count = 2
    bundle_source = html_source = asset_source = None
    setUpClass = ir.rf.ReportFlowPage.__dict__['setUpClass']
    tearDownClass = ir.rf.ReportFlowPage.__dict__['tearDownClass']
    setUp, tearDown = ir.ImageReportPage.setUp, ir.ImageReportPage.tearDown
    open, pick, open_study, selected = ir.ImageReportPage.open, ir.ImageReportPage.pick, ir.ImageReportPage.open_study, ir.ImageReportPage.selected
    wait, settle, row = ir.ImageReportPage.wait, ir.ImageReportPage.settle, ir.ImageReportPage.row
    choose, drag, attach = ir.ImageReportPage.choose, ir.ImageReportPage.drag, ir.ImageReportPage.attach
    drawing, stored = ir.ImageReportPage.drawing, ir.ImageReportPage.stored

    # ── driving ──
    def panels(self):
        view = self.page.locator('#toolbar-view')
        if view.get_attribute('open') is None:
            view.locator('> summary').click()
        self.page.get_by_role('button', name='Panels', exact=True).click()
        dialog = self.page.get_by_role('dialog', name='Panel Settings', exact=True)
        expect(dialog).to_be_visible()
        return dialog

    def set_panels(self, changes):
        dialog = self.panels()
        for label, on in changes.items():
            dialog.get_by_label(label, exact=True).set_checked(on)
            expect(dialog.locator('#panel-settings-status')).to_have_text('패널 표시를 기억했습니다 · 이 브라우저')
        dialog.get_by_role('button', name='Close', exact=True).click()
        expect(dialog).to_be_hidden()
        self.settle()
        return self.page.evaluate(BAND)

    def panel(self):
        return self.page.locator('.rw > .s-imgreport')

    def hidden_record(self):
        return (self.page.evaluate(STORED) or {}).get('workspace', {}).get('hiddenPanels', [])

    # ── cases ──
    def test_irpanel_01_settings_lists_image_report_and_toggles_it_alone(self):
        self.open()
        dialog = self.panels()
        labels = dialog.locator('fieldset label').all_text_contents()
        self.assertEqual(['Thumbnail', 'AI Report', 'Image Report', 'Clinical Information', 'Reading Template'],
                         [t.strip() for t in labels])
        # First use: Clinical Information only; Image Report is one click away.
        expect(dialog.get_by_label('Image Report', exact=True)).not_to_be_checked()
        expect(dialog.get_by_label('Clinical Information', exact=True)).to_be_checked()
        dialog.get_by_role('button', name='Close', exact=True).click()
        self.settle()
        expect(self.panel()).to_be_hidden()
        start = self.page.evaluate(BAND)
        band = self.set_panels({'Image Report': True})
        expect(self.panel()).to_be_visible()
        expect(self.panel().locator('h3')).to_contain_text('Image Report')
        # Only Image Report changed: Clinical stays, the hidden ones stay hidden.
        self.assertIsNotNone(band['clinical'])
        self.assertIsNone(band['thumb'])
        self.assertIsNone(band['template'])
        self.assertEqual(start['rw'][3], band['rw'][3])
        self.assertNotIn('imageReport', self.hidden_record())
        band = self.set_panels({'Image Report': False})
        expect(self.panel()).to_be_hidden()
        self.assertIn('imageReport', self.hidden_record())
        self.assertEqual(start['clinical'], band['clinical'])

    def test_irpanel_02_hidden_width_goes_to_the_others_and_alone_it_takes_the_band(self):
        self.open()
        all_on = self.set_panels({'Thumbnail': True, 'Image Report': True, 'Reading Template': True})
        for key in ('thumb', 'image', 'clinical', 'template'):
            self.assertIsNotNone(all_on[key], key)
        # Thumbnail | Image Report | Clinical | Template, left to right.
        xs = [all_on[k][0] for k in ('thumb', 'image', 'clinical', 'template')]
        self.assertEqual(sorted(xs), xs)
        off = self.set_panels({'Image Report': False})
        self.assertIsNone(off['image'])
        for key in ('thumb', 'clinical', 'template'):
            self.assertGreater(off[key][2], all_on[key][2] + 10, key)
        self.assertEqual(all_on['rw'][3], off['rw'][3])
        alone = self.set_panels({'Image Report': True, 'Thumbnail': False, 'Clinical Information': False,
                                 'Reading Template': False, 'AI Report': False})
        self.assertAlmostEqual(alone['rw'][2], alone['image'][2], delta=2)
        self.assertEqual(all_on['rw'][3], alone['rw'][3])
        gone = self.set_panels({'Image Report': False})
        self.assertIsNone(gone['rw'])
        self.assertGreater(gone['workrow'][3], alone['workrow'][3] + alone['rw'][3] - 1)

    def test_irpanel_03_the_choice_is_remembered_and_restored_after_a_reload(self):
        self.open()
        self.set_panels({'Image Report': True})
        self.page.reload()
        expect(self.page.locator('#rows')).to_contain_text(h.PATIENT)
        self.settle(300)
        expect(self.panel()).to_be_visible()
        dialog = self.panels()
        expect(dialog.get_by_label('Image Report', exact=True)).to_be_checked()
        dialog.get_by_role('button', name='Close', exact=True).click()
        self.set_panels({'Image Report': False})
        self.page.reload()
        expect(self.page.locator('#rows')).to_contain_text(h.PATIENT)
        self.settle(300)
        expect(self.panel()).to_be_hidden()

    def test_irpanel_04_the_panel_shows_the_reports_attached_drawings(self):
        drawn = self.drawing()
        self.stored(head=[drawn], rs='A')
        self.open()
        self.set_panels({'Image Report': True})
        status = self.page.locator('#image-report-panel-status')
        expect(status).to_have_text('검사를 선택하세요')
        expect(self.page.locator('#image-report-panel-open')).to_be_disabled()
        self.pick(h.PATIENT)
        self.wait(lambda: self.selected() == h.PATIENT, 'the study opens')
        expect(status).to_have_text('Attached to this report: 1')
        figures = self.page.locator('#image-report-panel-list figure')
        expect(figures).to_have_count(1)
        expect(figures.first.locator('figcaption')).to_have_text('Breast diagram')
        self.wait(lambda: self.page.evaluate("() => { const i = document.querySelector('#image-report-panel-list img');"
                                             " return !!i && i.complete && i.naturalWidth > 0; }"), 'the picture is drawn')
        # View only: no Remove in the panel.
        expect(self.page.locator('#image-report-panel-list').get_by_role('button')).to_have_count(0)
        # The same list as the strip under Conclusion.
        expect(self.page.locator('#report-image-attached figure')).to_have_count(1)
        # Another study: the first one's drawing goes at once, the other's list (none) comes.
        other = h.PATIENT_B
        self.pick(other)
        self.wait(lambda: self.selected() == other, 'the other study opens')
        expect(status).to_have_text('Attached to this report: 0')
        expect(figures).to_have_count(0)
        # A list that cannot be read is said, and read again on the next redraw.
        self.site.drawings_down = True
        self.pick(h.PATIENT)
        self.wait(lambda: self.selected() == h.PATIENT, 'back to the first study')
        expect(status).to_have_text('붙인 그림 목록을 읽지 못했습니다')
        expect(figures).to_have_count(0)
        self.site.drawings_down = False
        self.page.locator('#m-refresh').click()   # the list is drawn again
        expect(status).to_have_text('Attached to this report: 1')
        expect(figures).to_have_count(1)

    def test_irpanel_05_draw_opens_the_window_and_an_attach_shows_in_the_panel(self):
        self.open()
        self.set_panels({'Image Report': True})
        self.open_study(h.PATIENT)
        status = self.page.locator('#image-report-panel-status')
        expect(status).to_have_text('Attached to this report: 0')
        draw = self.page.locator('#image-report-panel-open')
        expect(draw).to_have_text('Draw')
        expect(draw).to_be_enabled()
        draw.click()
        dialog = self.page.locator('#image-report')
        expect(dialog).to_be_visible()
        expect(dialog.locator('.ir-study')).to_contain_text(h.PATIENT)
        self.settle()
        self.choose('Breast diagram')
        self.choose('Ellipse')
        self.drag(0.2, 0.3, 0.4, 0.5)
        self.attach()
        # The panel follows the attach while the window is still open.
        expect(status).to_have_text('Attached to this report: 1')
        expect(self.page.locator('#image-report-panel-list figure')).to_have_count(1)
        self.page.locator('#image-report-close').click()
        expect(dialog).to_be_hidden()
        expect(draw).to_be_focused()

    # Each figure of a list as [caption, picture on the screen]: the strip under Conclusion, the panel, or the window.
    FIGURES = '''s => [...document.querySelectorAll(s + ' figure')].map(f => { const i = f.querySelector('img');
      return [f.querySelector('figcaption')?.textContent || '', !!i && i.complete && i.naturalWidth > 0]; })'''
    STRIP, PANEL, WINDOW = '#report-image-attached', '#image-report-panel-list', '#image-report-attached'

    def figures(self, where):
        return self.page.evaluate(self.FIGURES, where)

    def same_in_strip_and_panel(self, expected, why):
        """The strip and the panel show the same drawings, in the same order, with the same pictures drawn or not."""
        self.wait(lambda: self.figures(self.STRIP) == expected and self.figures(self.PANEL) == expected,
                  why + ' - strip %r, panel %r' % (self.figures(self.STRIP), self.figures(self.PANEL)))

    def thyroid(self):
        new = self.drawing()
        self.site.pictures[new]['background'] = 'thyroid'
        return new

    def test_irpanel_06_the_panel_is_the_strips_rendering_even_when_the_window_reads_a_picture_meanwhile(self):
        first, second = self.drawing(), self.thyroid()
        self.stored(text='SYN text with two drawings', ids=[first, second])
        self.site.picture_failures = 1   # the strip's read of the first picture fails; a later read works
        self.site.hold = {second}        # the second picture's reads wait
        self.open()
        self.set_panels({'Image Report': True})
        self.open_study(h.PATIENT)
        self.wait(lambda: len(self.site.held) == 1, "the strip's read of the second picture waits")
        expect(self.page.locator('#image-report-panel-status')).to_have_text('붙인 그림을 읽는 중입니다…')
        # Meanwhile the window reads the first picture (and the second, which waits too).
        self.page.locator('#report-image-report').click()
        expect(self.page.locator('#image-report')).to_be_visible()
        self.wait(lambda: len(self.site.held) == 2, "the window's read of the second picture waits")
        self.wait(lambda: self.figures(self.WINDOW)[0] == ['Breast diagram', True], 'the window draws the first picture')
        self.site.release()
        # The strip's rendering could not draw the first picture: the panel says the same, though the window has it now.
        self.same_in_strip_and_panel([['Breast diagram', False], ['Thyroid diagram', True]], 'the strip rendering, mirrored')
        expect(self.page.locator(self.PANEL + ' img').first).to_have_attribute('alt', re.compile(r'\(could not be read\)$'))
        expect(self.page.locator('#image-report-panel-status')).to_have_text('Attached to this report: 2')
        # The next strip read (on closing the window) draws both, in both.
        self.page.locator('#image-report-close').click()
        self.same_in_strip_and_panel([['Breast diagram', True], ['Thyroid diagram', True]], 'the next read draws both')

    def test_irpanel_07_draw_follows_the_reports_edit_gate(self):
        held = self.drawing()
        self.stored(head=[held], rs='A')
        self.site.unverified.add(h.UID)
        self.open()
        self.set_panels({'Image Report': True})
        self.pick(h.PATIENT)
        self.wait(lambda: self.selected() == h.PATIENT, 'the study opens')
        status = self.page.locator('#image-report-panel-status')
        expect(status).to_have_text('Attached to this report: 1')
        # The report takes no edits: Draw is off, the drawings stay on view, and the editor's Image Report still opens
        # the window to view.
        header = self.page.locator('#report-image-report')
        expect(header).to_be_enabled()
        self.settle(300)
        expect(self.page.locator('#image-report-panel-open')).to_be_disabled()
        expect(self.page.locator('#image-report-panel-list figure')).to_have_count(1)
        header.click()
        expect(self.page.locator('#image-report-readonly')).to_contain_text('View only')

    def draw_and_attach(self, background):
        self.choose(background)
        self.choose('Ellipse')
        self.drag(0.2, 0.3, 0.4, 0.5)
        self.attach()

    def list_reads(self):
        return sum(1 for _, p in self.site.calls if p.endswith('/report/drawings'))

    def test_irpanel_08_a_newer_rendering_of_the_same_study_that_ends_first_is_not_covered_by_an_older_one(self):
        kept = self.drawing()
        self.stored(text='SYN text with a drawing', ids=[kept])
        self.open()
        self.set_panels({'Image Report': True})
        self.open_study(h.PATIENT)
        self.same_in_strip_and_panel([['Breast diagram', True]], 'the first rendering')
        # An attach whose picture's reads wait: the strip renders [kept, new] (and again when the window closes) ...
        self.site.hold_new = True
        self.page.locator('#report-image-report').click()
        expect(self.page.locator('#image-report')).to_be_visible()
        self.settle()
        self.draw_and_attach('Thyroid diagram')
        self.page.locator('#image-report-close').click()
        expect(self.page.locator('#image-report')).to_be_hidden()
        new = next(i for i in self.site.draw[h.UID]['ids'] if i != kept)
        self.wait(lambda: self.figures(self.STRIP) == [['Breast diagram', True], ['Thyroid diagram', False]], 'the older renderings wait')
        expect(self.page.locator('#image-report-panel-status')).to_have_text('붙인 그림을 읽는 중입니다…')
        # ... and a newer one (Remove on the strip) lists only [kept] and ends first.
        self.page.locator(self.STRIP + ' button[data-drawing="%s"]' % new).click()
        self.same_in_strip_and_panel([['Breast diagram', True]], 'the newer rendering')
        # The older renderings end later and cover nothing.
        self.site.release()
        self.settle(500)
        self.same_in_strip_and_panel([['Breast diagram', True]], 'after the older renderings ended')
        expect(self.page.locator('#image-report-panel-status')).to_have_text('Attached to this report: 1')

    def test_irpanel_09_a_then_b_then_a(self):
        first = self.drawing()
        self.stored(head=[first], rs='A')
        self.site.hold = {first}
        self.open()
        self.set_panels({'Image Report': True})
        self.pick(h.PATIENT)
        self.wait(lambda: len(self.site.held) == 1, "the first study's picture read waits")
        self.pick(h.PATIENT_B)
        self.wait(lambda: self.selected() == h.PATIENT_B, 'the other study opens')
        expect(self.page.locator('#image-report-panel-status')).to_have_text('Attached to this report: 0')
        # The first study's picture comes in while the other study is selected: it reaches neither list.
        self.site.release()
        self.settle(500)
        self.same_in_strip_and_panel([], "the other study's (none)")
        expect(self.page.locator('#image-report-panel-status')).to_have_text('Attached to this report: 0')
        self.pick(h.PATIENT)
        self.wait(lambda: self.selected() == h.PATIENT, 'back to the first study')
        self.same_in_strip_and_panel([['Breast diagram', True]], "the first study's again")

    def test_irpanel_10_hidden_it_follows_attach_and_remove_and_showing_it_reads_nothing(self):
        self.open()
        self.open_study(h.PATIENT)
        expect(self.panel()).to_be_hidden()   # first use: hidden
        self.page.locator('#report-image-report').click()
        expect(self.page.locator('#image-report')).to_be_visible()
        self.settle()
        self.draw_and_attach('Breast diagram')
        self.draw_and_attach('Thyroid diagram')
        self.page.locator('#image-report-close').click()
        self.wait(lambda: len(self.figures(self.STRIP)) == 2, 'the strip shows both')
        self.page.locator(self.STRIP + ' figure').first.get_by_role('button', name='Remove').click()
        self.same_in_strip_and_panel([['Thyroid diagram', True]], 'the hidden panel follows the remove')
        lists, pictures = self.list_reads(), self.site.picture_reads
        self.set_panels({'Image Report': True})
        expect(self.panel()).to_be_visible()
        self.assertEqual(self.figures(self.PANEL), [['Thyroid diagram', True]])
        expect(self.page.locator('#image-report-panel-status')).to_have_text('Attached to this report: 1')
        self.assertEqual((self.list_reads(), self.site.picture_reads), (lists, pictures), 'showing the panel read something')

    def test_irpanel_11_a_picture_not_drawn_refuses_the_save_and_the_next_read_lets_it(self):
        held = self.drawing()
        st = self.stored(text='SYN text with a drawing', ids=[held])
        self.site.picture_failures = 1
        self.open()
        self.set_panels({'Image Report': True})
        self.open_study(h.PATIENT)
        self.same_in_strip_and_panel([['Breast diagram', False]], 'drawn in neither')
        self.page.locator('#b-save').click()
        self.wait(lambda: len(self.site.flow_commits) == 1, 'the save is sent')
        self.assertNotIn('expectedEffectiveDrawingIds', self.site.flow_commits[0][1], 'a drawing not drawn was named as shown')
        expect(self.page.locator('#draftmsg')).to_contain_text('판독문에 붙은 그림이 이 화면이 본 것과 다릅니다')
        self.assertEqual(st['report']['version'], 0)
        # The next strip read (the window opened and closed) draws it in both, and the save goes through.
        self.page.locator('#report-image-report').click()
        expect(self.page.locator('#image-report')).to_be_visible()
        self.wait(lambda: self.figures(self.WINDOW) == [['Breast diagram', True]], 'the window draws it')
        self.page.locator('#image-report-close').click()
        self.same_in_strip_and_panel([['Breast diagram', True]], 'drawn in both')
        self.page.locator('#b-draft-keep').click()
        self.settle(300)
        self.page.locator('#b-save').click()
        self.wait(lambda: st['report']['version'] == 1, 'the save goes through once the picture was drawn')
        self.assertEqual(self.site.flow_commits[-1][1].get('expectedEffectiveDrawingIds'), [held])


if __name__ == '__main__':
    unittest.main()
