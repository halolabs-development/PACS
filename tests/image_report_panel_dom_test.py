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
  05 Draw in the panel opens the drawing window for the selected study; closing it returns focus to Draw.
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


if __name__ == '__main__':
    unittest.main()
