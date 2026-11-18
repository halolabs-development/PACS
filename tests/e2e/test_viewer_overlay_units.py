"""Overlay planes, Freehand ROI units and the saved-item count on the served viewer with owned synthetic images.

A CT whose images carry a DICOM overlay plane (60xx): Image Overlay draws it, turning the button off takes it away and on
again draws it without an error, and a Length on that image is drawn with its value. A palette colour image (its colour
tables sent as bulk data) is drawn in colour. A Freehand ROI says its perimeter (closed outline) and its length (open line)
in mm, never "undefined". The history panel's "n개 저장 항목" follows a Save and a Delete at once."""
import json
import os
import sys
import time
import unittest
import uuid
from pathlib import Path

import numpy as np
from pydicom.uid import generate_uid, ExplicitVRLittleEndian
from pynetdicom import AE
from playwright.sync_api import expect

from invariants_live import Fixture
from test_viewer_tools import ViewerToolsE2E
from viewer_precision_fixture import synthetic_ct
from viewer_tools import select_image_tool

EVIDENCE = Path(os.environ.get('KIN_EVIDENCE_DIR', 'tests/e2e/artifacts/viewer-overlay-units-ci/shots'))
# The active cell's viewport and its SVG layer, where the tools draw their words and the overlay plane.
CELL = '''() => services.cornerstoneViewportService.getCornerstoneViewport(services.viewportGridService.getActiveViewportId())'''
SVG_TEXT = '''() => [...(%s)().element.querySelectorAll('svg.svg-layer text')].map(t => t.textContent).join(' | ')''' % CELL
OVERLAY_IMAGES = '''() => (%s)().element.querySelectorAll('svg.svg-layer image').length''' % CELL


class ViewerOverlayUnitsE2E(ViewerToolsE2E):
    def setUp(self):
        super().setUp()
        EVIDENCE.mkdir(parents=True, exist_ok=True)

    def store(self, ds, source, label):
        """C-STORE one synthetic instance as its own study and wait for the real API to list it, as the modality fixture does."""
        ds.StudyInstanceUID = generate_uid(); ds.SeriesInstanceUID = generate_uid(); ds.SOPInstanceUID = generate_uid()
        ds.file_meta.MediaStorageSOPInstanceUID = ds.SOPInstanceUID
        ds.file_meta.MediaStorageSOPClassUID = ds.SOPClassUID
        ds.SeriesDescription = label
        fixture = Fixture(ds.StudyInstanceUID, source.patient_id, source.institution, source.owner_user, label)
        self.stack.active[fixture.uid] = fixture
        ae = AE(ae_title='HALLYM_CT'); ae.add_requested_context(ds.SOPClassUID, ExplicitVRLittleEndian)
        association = ae.associate('127.0.0.1', 4242, ae_title='KINLAB')
        self.assertTrue(association.is_established)
        try:
            self.assertEqual(association.send_c_store(ds).Status, 0)
        finally:
            association.release()
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline:
            result = self.stack.request('GET', '/studies', 'jmryu')
            if result.status == 200 and any(s.get('uid') == fixture.uid for s in result.body.get('studies', [])):
                break
            time.sleep(.25)
        else:
            self.fail('Synthetic ' + label + ' did not reach the real API')
        self.assertEqual(self.stack.request('PATCH', '/studies/' + fixture.uid, 'jmryu', {'ss': 'Verified'}).status, 200)
        return fixture

    def plain_ct(self):
        return synthetic_ct(self.stack, 'OVUNITS-' + uuid.uuid4().hex[:12], 'CT', '20261118', [0, 0, 0], [1, 0, 0, 0, 1, 0], [.7, 1.3], slices=1)

    def overlay_ct(self):
        """The plain CT with an overlay plane in group 6000: two filled bars, one bit per pixel, sent as OverlayData."""
        source = self.plain_ct(); ds = self.source_dicom(source)
        rows, columns = int(ds.Rows), int(ds.Columns)
        bits = np.zeros((rows, columns), dtype=np.uint8)
        bits[64:192, 40:72] = 1; bits[64:192, 184:216] = 1
        ds.add_new(0x60000010, 'US', rows); ds.add_new(0x60000011, 'US', columns)
        ds.add_new(0x60000022, 'LO', 'SYNTHETIC BARS'); ds.add_new(0x60000040, 'CS', 'G')
        ds.add_new(0x60000050, 'SS', [1, 1]); ds.add_new(0x60000100, 'US', 1); ds.add_new(0x60000102, 'US', 0)
        ds.add_new(0x60003000, 'OW', np.packbits(bits.ravel(), bitorder='little').tobytes())
        return self.store(ds, source, 'OVUNITS overlay')

    def palette_image(self):
        """A secondary capture in PALETTE COLOR: an 8-bit ramp coloured by red, green and blue tables of 256 entries."""
        source = self.plain_ct(); ds = self.source_dicom(source)
        for name in ['RescaleType', 'RescaleSlope', 'RescaleIntercept', 'WindowCenter', 'WindowWidth', 'SliceThickness',
                     'ImagePositionPatient', 'ImageOrientationPatient', 'FrameOfReferenceUID', 'SliceLocation']:
            if name in ds:
                delattr(ds, name)
        ds.SOPClassUID = '1.2.840.10008.5.1.4.1.1.7'; ds.Modality = 'OT'
        ds.Rows = ds.Columns = 64
        ds.SamplesPerPixel = 1; ds.PhotometricInterpretation = 'PALETTE COLOR'
        ds.BitsAllocated = ds.BitsStored = 8; ds.HighBit = 7; ds.PixelRepresentation = 0
        ds.PixelData = np.tile(np.arange(0, 256, 4, dtype=np.uint8), (64, 1)).tobytes()
        ramp = np.arange(256, dtype=np.uint16) * 257
        for tag in (0x00281101, 0x00281102, 0x00281103):
            ds.add_new(tag, 'US', [256, 0, 16])
        ds.add_new(0x00281201, 'OW', ramp.tobytes())
        ds.add_new(0x00281202, 'OW', np.zeros(256, dtype=np.uint16).tobytes())
        ds.add_new(0x00281203, 'OW', ramp[::-1].copy().tobytes())
        return self.store(ds, source, 'OVUNITS palette')

    def watched(self, page):
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        return errors

    def no_failure_notice(self, page):
        expect(page.get_by_text('Something went wrong', exact=False)).to_have_count(0)

    def drag_path(self, page, points):
        page.mouse.move(*points[0]); page.mouse.down()
        for point in points[1:]:
            page.mouse.move(*point, steps=6)
        page.mouse.up()

    def canvas_box(self, page):
        return page.evaluate('''() => (%s)().element.querySelector('canvas').getBoundingClientRect().toJSON()''' % CELL)

    def test_overlay_units_01_an_overlay_plane_is_drawn_turned_off_and_on_and_measured_on(self):
        fixture = self.overlay_ct()
        bulk = []
        work, page = self.open_tools_viewer(fixture)
        errors = self.watched(page)
        page.on('requestfinished', lambda r: bulk.append((r.url, r.response().status)) if '/bulk/60003000' in r.url else None)
        try:
            # On (the viewer's default): the overlay plane is drawn, its bytes read once from this origin.
            page.wait_for_function('n => (%s)() >= n' % OVERLAY_IMAGES, arg=1, timeout=30000)
            self.assertTrue(bulk and all(status == 200 for _, status in bulk), bulk)
            self.assertTrue(all(url.startswith(self.stack.proxy + '/dicom-web/studies/' + fixture.uid + '/') for url, _ in bulk), bulk)
            page.screenshot(path=str(EVIDENCE / 'overlay-on.png'))
            # Off: gone. On again: drawn again, without a failure.
            select_image_tool(page, 'Image Overlay')
            page.wait_for_function('() => (%s)() === 0' % OVERLAY_IMAGES)
            page.screenshot(path=str(EVIDENCE / 'overlay-off.png'))
            select_image_tool(page, 'Image Overlay')
            page.wait_for_function('n => (%s)() >= n' % OVERLAY_IMAGES, arg=1)
            page.wait_for_timeout(800)
            self.no_failure_notice(page)
            # A Length on that image: drawn, with its value in mm.
            select_image_tool(page, 'Length')
            box = self.canvas_box(page)
            x, y = box['x'] + box['width'] * .3, box['y'] + box['height'] * .8
            self.drag_path(page, [(x, y), (x + 90, y)])
            page.wait_for_function('() => / mm/.test((%s)())' % SVG_TEXT)
            self.assertGreaterEqual(page.evaluate(OVERLAY_IMAGES), 1)
            page.screenshot(path=str(EVIDENCE / 'overlay-length.png'))
            self.no_failure_notice(page)
            self.assertEqual([], [e for e in errors if 'overlay' in e.lower() or "reading 'x'" in e], errors)
        finally:
            (EVIDENCE / 'overlay.json').write_text(json.dumps({'study': fixture.uid, 'errors': errors, 'bulk': bulk,
                'text': page.evaluate(SVG_TEXT)}, indent=2), encoding='utf-8')
            page.close(); work.close()

    def test_overlay_units_02_a_palette_colour_image_is_drawn_in_colour(self):
        fixture = self.palette_image()
        work, page = self.open_tools_viewer(fixture)
        errors = self.watched(page)
        try:
            page.evaluate('() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
            coloured = page.evaluate('''() => { const canvas = (%s)().element.querySelector('canvas');
                const d = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data; let n = 0;
                for (let i = 0; i < d.length; i += 4) if (Math.abs(d[i] - d[i + 2]) > 60 && d[i + 1] < 40) n++;
                return n; }''' % CELL)
            page.screenshot(path=str(EVIDENCE / 'palette.png'))
            self.assertGreater(coloured, 100, 'the palette tables colour the image (red to blue, no green)')
            self.no_failure_notice(page)
            self.assertEqual([], errors)
        finally:
            page.close(); work.close()

    def test_overlay_units_03_freehand_roi_says_its_perimeter_and_length_in_mm(self):
        fixture = self.plain_ct()
        work, page = self.open_tools_viewer(fixture)
        errors = self.watched(page)
        try:
            select_image_tool(page, 'Freehand ROI')
            box = self.canvas_box(page)
            cx, cy, r = box['x'] + box['width'] * .45, box['y'] + box['height'] * .45, min(box['width'], box['height']) * .12
            # A closed outline: round and back to where it started.
            ring = [(cx + r * np.cos(a), cy + r * np.sin(a)) for a in np.linspace(0, 2 * np.pi, 25)]
            self.drag_path(page, ring)
            page.wait_for_function('() => /Perimeter: [0-9.]+ mm/.test((%s)())' % SVG_TEXT)
            # An open line, far from where it started.
            sx, sy = box['x'] + box['width'] * .2, box['y'] + box['height'] * .85
            self.drag_path(page, [(sx + i * 12, sy - (i % 2) * 6) for i in range(15)])
            page.wait_for_function('''() => cornerstoneTools.annotation.state.getAllAnnotations().filter(a => a.metadata.toolName === 'PlanarFreehandROI'
                && a.data.contour && !a.data.contour.closed && Object.values(a.data.cachedStats || {}).some(s => Number.isFinite(s.length))).length === 1''')
            page.wait_for_function('''() => (%s)().split(' | ').some(t => /^[0-9.]+ mm$/.test(t.trim()))''' % SVG_TEXT)
            text = page.evaluate(SVG_TEXT)
            page.screenshot(path=str(EVIDENCE / 'freehand.png'))
            self.assertNotIn('undefined', text)
            # The words only: the measurement the tool keeps (what an export reads) is as the pinned tool made it.
            kept = page.evaluate('''() => cornerstoneTools.annotation.state.getAllAnnotations().filter(a => a.metadata.toolName === 'PlanarFreehandROI')
                .map(a => Object.values(a.data.cachedStats)[0]).map(s => ({unit: s.unit ?? null, areaUnit: s.areaUnit ?? null}))''')
            self.assertIn({'unit': None, 'areaUnit': 'mm²'}, kept)
            self.assertEqual([], errors)
        finally:
            page.close(); work.close()

    def test_overlay_units_04_the_saved_item_count_follows_save_and_delete(self):
        fixture = self.plain_ct()
        work, page = self.open_tools_viewer(fixture)
        status = page.locator('#kin-viewer-history > [role=status]')
        try:
            expect(status).to_contain_text('0개 저장 항목')
            select_image_tool(page, 'EllipticalROI')
            box = self.canvas_box(page)
            x, y = box['x'] + box['width'] * .43, box['y'] + box['height'] * .43
            self.drag_path(page, [(x, y), (x + 65, y + 32)])
            row = page.locator('#kin-viewer-history section[data-kind=ellipse]')
            expect(row).to_have_count(1)
            self.ellipse(page)
            row.get_by_role('button', name='Save', exact=True).click()
            expect(row).to_contain_text('저장 완료')
            expect(status).to_have_text('1개 저장 항목 · 저장은 판독 확정과 별개입니다.')
            page.once('dialog', lambda dialog: dialog.accept())
            row.get_by_role('button', name='Delete', exact=True).click()
            expect(row).to_have_count(0)
            expect(status).to_have_text('Ellipse ROI 항목을 지웠습니다. 저장 이력은 서버에 남습니다. 0개 저장 항목 · 저장은 판독 확정과 별개입니다.')
            self.assertEqual(self.saved(fixture), [])
        finally:
            page.close(); work.close()


if __name__ == '__main__':
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    unittest.main(verbosity=2)
