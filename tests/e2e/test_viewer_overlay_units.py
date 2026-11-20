"""Overlay planes, Freehand ROI units and the saved-item count on the served viewer with owned synthetic images.

A CT with square pixels whose image carries a DICOM overlay plane (60xx): Image Overlay draws its two bars on the screen where
they are in the image, turning the button off takes them away and on again draws them without an error, and a Length on that
image is drawn with its value. An overlay plane on pixels that are not square, or whose bits come back short, is left out and
the cell's Length is still drawn. A palette colour image (its colour tables sent as bulk data) is drawn without an error. A
Freehand ROI on an image with pixel spacing says its perimeter (closed outline) and length (open line) as the outline's length
in mm at any zoom; on an image without pixel spacing it says them on the image's pixel grid in px (a closed outline's area in
px²), never mm or "undefined". The history panel's "n개 저장 항목" follows a Save and a Delete at once."""
import json
import os
import re
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
# Points of the image (column, row) where they are on the page, for sampling the composited screen: inside each bar of the
# synthetic overlay (columns 40-71 and 184-215, rows 64-191), between them, and below them.
BARS, PLAIN = [[56, 128], [200, 128]], [[128, 128], [56, 230]]
ON_PAGE = '''points => { const v = (%s)(), id = v.getCurrentImageId(), box = v.element.querySelector('canvas').getBoundingClientRect();
  return points.map(p => { const c = v.worldToCanvas(cornerstone.utilities.imageToWorldCoords(id, [p[0] + .5, p[1] + .5]));
    return [c[0] + box.x, c[1] + box.y]; }); }''' % CELL
# The page's own screenshot (what the reader sees, overlay and image together), decoded and sampled at page points.
SAMPLE = '''async ([png, points]) => { const img = new Image(); img.src = 'data:image/png;base64,' + png; await img.decode();
  const c = document.createElement('canvas'); c.width = img.naturalWidth; c.height = img.naturalHeight;
  const g = c.getContext('2d'); g.drawImage(img, 0, 0);
  return points.map(([x, y]) => Array.from(g.getImageData(Math.round(x), Math.round(y), 1, 1).data.slice(0, 3))); }'''# Each Freehand ROI's outline length on the image (world distances along its points, closed back to the first point).
OUTLINES = '''() => cornerstoneTools.annotation.state.getAllAnnotations().filter(a => a.metadata.toolName === 'PlanarFreehandROI').map(a => {
  const p = a.data.contour.polyline, d = (u, w) => Math.hypot(u[0] - w[0], u[1] - w[1], u[2] - w[2]); let n = 0;
  for (let i = 1; i < p.length; i++) n += d(p[i - 1], p[i]); if (a.data.contour.closed) n += d(p[p.length - 1], p[0]);
  return [a.data.contour.closed, n]; })'''
# The same outlines on the shown image's own pixel grid (continuous column and row): [closed, length in px, area in px²].
PIXEL_OUTLINES = '''() => { const grid = (%s)().getImageData().imageData;
  return cornerstoneTools.annotation.state.getAllAnnotations().filter(a => a.metadata.toolName === 'PlanarFreehandROI').map(a => {
  const p = a.data.contour.polyline.map(q => Array.from(grid.worldToIndex(q))), d = (u, w) => Math.hypot(u[0] - w[0], u[1] - w[1]);
  let n = 0, s = 0; for (let i = 1; i < p.length; i++) n += d(p[i - 1], p[i]);
  if (a.data.contour.closed) { n += d(p[p.length - 1], p[0]); p.forEach((u, i) => { const w = p[(i + 1) %% p.length]; s += u[0] * w[1] - w[0] * u[1]; }); }
  return [a.data.contour.closed, n, Math.abs(s) / 2]; }); }''' % CELL


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

    def plain_ct(self, spacing=(.7, 1.3)):
        return synthetic_ct(self.stack, 'OVUNITS-' + uuid.uuid4().hex[:12], 'CT', '20261118', [0, 0, 0], [1, 0, 0, 0, 1, 0], list(spacing), slices=1)

    def overlay_ct(self, spacing=(.7, .7)):
        """A CT (square pixels unless asked) with an overlay plane in group 6000: two filled bars, one bit per pixel, sent as
        OverlayData."""
        source = self.plain_ct(spacing); ds = self.source_dicom(source)
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

    def screen(self, page, points):
        """The composited screen's colour at image points (the page's own screenshot)."""
        import base64
        return page.evaluate(SAMPLE, [base64.b64encode(page.screenshot()).decode(), page.evaluate(ON_PAGE, points)])

    def pink(self, rgb):
        # The overlay's fill (255, 127, 127) over the image; the synthetic CT itself is grey.
        return rgb[0] - rgb[1] > 60 and abs(rgb[1] - rgb[2]) < 30

    def length_on(self, page):
        select_image_tool(page, 'Length')
        box = self.canvas_box(page)
        x, y = box['x'] + box['width'] * .3, box['y'] + box['height'] * .8
        self.drag_path(page, [(x, y), (x + 90, y)])
        page.wait_for_function('() => / mm/.test((%s)())' % SVG_TEXT)

    def bulk_requests(self, page):
        return page.evaluate('''() => performance.getEntriesByType('resource').filter(e => e.name.includes('/bulk/60003000'))
            .map(e => [e.name, e.responseStatus])''')

    def open_answering(self, fixture, answer):
        """The viewer opened with the archive's overlay bits answered by `answer` (a Playwright route handler)."""
        work = self.login('doctor'); page = work.context.new_page()
        page.route('**/bulk/60003000', answer)
        page.goto(self.stack.proxy + '/ohif/viewer?StudyInstanceUIDs=' + fixture.uid)
        page.wait_for_function('''uid => window.cornerstone?.getRenderingEngines().some(engine => engine.id !== '_thumbnails' &&
            engine.getViewports().some(v => v.type === 'stack' && v.viewportStatus === cornerstone.Enums.ViewportStatus.RENDERED &&
            cornerstone.metaData.get('instance', v.getCurrentImageId())?.StudyInstanceUID === uid))''', arg=fixture.uid, timeout=60000)
        box = self.canvas_box(page)
        page.mouse.click(box['x'] + box['width'] / 2, box['y'] + box['height'] / 2)
        self.open_measurement_tools(page)
        expect(page.locator('#kin-viewer-history [role=status]')).to_contain_text('개 저장 항목')
        return work, page

    def test_overlay_units_01_an_overlay_plane_is_drawn_turned_off_and_on_and_measured_on(self):
        fixture = self.overlay_ct()
        bulk = []
        work, page = self.open_tools_viewer(fixture)
        errors = self.watched(page)
        try:
            # On (the viewer's default): the two bars on the screen where they are in the image, its bits read from this origin.
            page.wait_for_function('n => (%s)() >= n' % OVERLAY_IMAGES, arg=1, timeout=30000)
            page.wait_for_timeout(300)
            bulk = self.bulk_requests(page)
            self.assertTrue(bulk and all(status == 200 for _, status in bulk), bulk)
            self.assertTrue(all(url.startswith(self.stack.proxy + '/dicom-web/studies/' + fixture.uid + '/') for url, _ in bulk), bulk)
            seen = self.screen(page, BARS + PLAIN)
            page.screenshot(path=str(EVIDENCE / 'overlay-on.png'))
            self.assertEqual([self.pink(rgb) for rgb in seen], [True, True, False, False], seen)
            # Off: gone from the screen. On again: back, without a failure.
            select_image_tool(page, 'Image Overlay')
            page.wait_for_function('() => (%s)() === 0' % OVERLAY_IMAGES)
            page.wait_for_timeout(300)
            seen = self.screen(page, BARS)
            page.screenshot(path=str(EVIDENCE / 'overlay-off.png'))
            self.assertEqual([self.pink(rgb) for rgb in seen], [False, False], seen)
            select_image_tool(page, 'Image Overlay')
            page.wait_for_function('n => (%s)() >= n' % OVERLAY_IMAGES, arg=1)
            page.wait_for_timeout(800)
            self.no_failure_notice(page)
            seen = self.screen(page, BARS + PLAIN)
            self.assertEqual([self.pink(rgb) for rgb in seen], [True, True, False, False], seen)
            # A Length on that image: drawn, with its value in mm.
            self.length_on(page)
            self.assertGreaterEqual(page.evaluate(OVERLAY_IMAGES), 1)
            page.screenshot(path=str(EVIDENCE / 'overlay-length.png'))
            self.no_failure_notice(page)
            self.assertEqual([], [e for e in errors if 'overlay' in e.lower() or "reading 'x'" in e], errors)
        finally:
            (EVIDENCE / 'overlay.json').write_text(json.dumps({'study': fixture.uid, 'errors': errors, 'bulk': bulk,
                'text': page.evaluate(SVG_TEXT)}, indent=2), encoding='utf-8')
            page.close(); work.close()

    def test_overlay_units_01b_an_overlay_plane_on_non_square_pixels_is_left_out_and_the_length_still_drawn(self):
        # 0.7 x 1.3 mm pixels: the pinned tool would put the mask in the wrong place, so it is not drawn (and not read); the
        # cell is not broken by it — its Length is drawn with its value, no failure.
        fixture = self.overlay_ct((.7, 1.3))
        work, page = self.open_tools_viewer(fixture)
        errors = self.watched(page)
        try:
            page.wait_for_timeout(2000)
            self.assertEqual(0, page.evaluate(OVERLAY_IMAGES))
            self.assertEqual([], self.bulk_requests(page))
            self.length_on(page)
            select_image_tool(page, 'Image Overlay'); select_image_tool(page, 'Image Overlay')
            page.wait_for_timeout(800)
            self.assertEqual(0, page.evaluate(OVERLAY_IMAGES))
            self.assertRegex(page.evaluate(SVG_TEXT), r'[0-9.]+ mm')
            page.screenshot(path=str(EVIDENCE / 'overlay-non-square.png'))
            self.no_failure_notice(page)
            self.assertEqual([], [e for e in errors if 'overlay' in e.lower() or "reading 'x'" in e], errors)
        finally:
            page.close(); work.close()

    def test_overlay_units_01c_an_overlay_plane_whose_answer_is_short_is_left_out_and_the_length_still_drawn(self):
        # The archive answers with fewer bytes than one frame of the mask: not drawn, read once, the Length still drawn.
        fixture = self.overlay_ct()
        answers = []
        def short(route):
            answers.append(route.request.url)
            body = b'--B1\r\nContent-Type: application/octet-stream\r\n\r\n' + bytes(10) + b'\r\n--B1--\r\n'
            route.fulfill(status=200, body=body, headers={'Content-Type': 'multipart/related; type="application/octet-stream"; boundary=B1'})
        work, page = self.open_answering(fixture, short)
        errors = self.watched(page)
        try:
            deadline = time.monotonic() + 20
            while not answers and time.monotonic() < deadline:
                page.wait_for_timeout(250)
            self.assertTrue(answers, 'the overlay bits were asked for')
            page.wait_for_timeout(1000)
            self.assertEqual(0, page.evaluate(OVERLAY_IMAGES))
            self.length_on(page)
            page.wait_for_timeout(800)
            self.assertEqual(len(answers), 1, 'read once, not again on later draws')
            self.assertRegex(page.evaluate(SVG_TEXT), r'[0-9.]+ mm')
            page.screenshot(path=str(EVIDENCE / 'overlay-short.png'))
            self.no_failure_notice(page)
            self.assertEqual([], [e for e in errors if 'overlay' in e.lower() or "reading 'x'" in e or 'RangeError' in e], errors)
        finally:
            page.close(); work.close()
    def test_overlay_units_02_a_palette_colour_image_is_drawn_without_an_error(self):
        # Its colour tables are bulk data too; only overlay planes are read by the viewer's own bulk read, so this image is read
        # as before. The pinned viewer draws such an image without its colours (its palette reader cannot use tables sent as an
        # address) on the current viewer as well; what this case holds is that the image is drawn and nothing fails. The colour
        # seen is written down for the record.
        fixture = self.palette_image()
        work, page = self.open_tools_viewer(fixture)
        errors = self.watched(page)
        try:
            page.evaluate('() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
            coloured = page.evaluate('''() => { const canvas = (%s)().element.querySelector('canvas');
                const d = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data; let n = 0;
                for (let i = 0; i < d.length; i += 4) if (Math.abs(d[i] - d[i + 2]) > 60 && d[i + 1] < 40) n++;
                return n; }''' % CELL)
            drawn = page.evaluate('''() => { const canvas = (%s)().element.querySelector('canvas');
                const d = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data; let n = 0;
                for (let i = 0; i < d.length; i += 4) if (d[i] + d[i + 1] + d[i + 2] > 150) n++;
                return n; }''' % CELL)
            page.screenshot(path=str(EVIDENCE / 'palette.png'))
            (EVIDENCE / 'palette.json').write_text(json.dumps({'study': fixture.uid, 'coloured': coloured, 'drawn': drawn, 'errors': errors}), encoding='utf-8')
            self.assertGreater(drawn, 1000, 'the image is drawn')
            self.no_failure_notice(page)
            self.assertEqual([], errors)
        finally:
            page.close(); work.close()

    def test_overlay_units_03_freehand_roi_says_its_outline_length_in_mm_at_any_zoom(self):
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
            # The numbers are the outlines' lengths on the image (this CT has no calibration: mm as they are), not on the screen.
            def said():
                words = page.evaluate(SVG_TEXT).split(' | ')
                closed = [float(m) for w in words for m in re.findall(r'Perimeter: ([0-9.]+) mm', w)]
                opened = [float(w.strip()[:-3]) for w in words if re.fullmatch(r'[0-9.]+ mm', w.strip())]
                return closed, opened
            outlines = dict((closed, length) for closed, length in page.evaluate(OUTLINES))
            closed, opened = said()
            self.assertEqual(len(closed), 1, text); self.assertEqual(len(opened), 1, text)
            self.assertAlmostEqual(closed[0], outlines[True], delta=1, msg=(text, outlines))
            self.assertAlmostEqual(opened[0], outlines[False], delta=1, msg=(text, outlines))
            # Zoomed in twice as far: the same numbers.
            page.evaluate('''() => { const v = (%s)(); v.setZoom(v.getZoom() * 2); v.render(); }''' % CELL)
            page.evaluate('() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
            page.wait_for_timeout(500)
            self.assertEqual(said(), (closed, opened), page.evaluate(SVG_TEXT))
            page.screenshot(path=str(EVIDENCE / 'freehand-zoomed.png'))
            # The words only: the measurement the tool keeps (what an export reads) is as the pinned tool made it.
            kept = page.evaluate('''() => cornerstoneTools.annotation.state.getAllAnnotations().filter(a => a.metadata.toolName === 'PlanarFreehandROI')
                .map(a => Object.values(a.data.cachedStats)[0]).map(s => ({unit: s.unit ?? null, areaUnit: s.areaUnit ?? null}))''')
            self.assertIn({'unit': None, 'areaUnit': 'mm²'}, kept)
            self.assertEqual([], errors)
        finally:
            page.close(); work.close()

    def test_overlay_units_03b_freehand_roi_on_an_image_without_pixel_spacing_says_pixels(self):
        # No pixel spacing in the image's header (the viewer stands in a spacing of 1): a length or area in mm would be made up,
        # and "undefined" is no unit. The outline is said on the image's own pixel grid: its perimeter and length in px, a closed
        # outline's area in px², the same at any zoom; the Measurements panel's row says the same area.
        source = self.plain_ct(); ds = self.source_dicom(source)
        for name in ['PixelSpacing', 'ImagerPixelSpacing']:
            if name in ds:
                delattr(ds, name)
        fixture = self.store(ds, source, 'OVUNITS no spacing')
        work, page = self.open_tools_viewer(fixture)
        errors = self.watched(page)
        try:
            select_image_tool(page, 'Freehand ROI')
            box = self.canvas_box(page)
            cx, cy, r = box['x'] + box['width'] * .45, box['y'] + box['height'] * .4, min(box['width'], box['height']) * .12
            self.drag_path(page, [(cx + r * np.cos(a), cy + r * np.sin(a)) for a in np.linspace(0, 2 * np.pi, 25)])
            page.wait_for_function('() => /Perimeter: [0-9.]+ px/.test((%s)())' % SVG_TEXT)
            sx, sy = box['x'] + box['width'] * .2, box['y'] + box['height'] * .8
            self.drag_path(page, [(sx + i * 12, sy - (i % 2) * 6) for i in range(15)])
            page.wait_for_function('''() => cornerstoneTools.annotation.state.getAllAnnotations().filter(a => a.metadata.toolName === 'PlanarFreehandROI'
                && a.data.contour && !a.data.contour.closed && Object.values(a.data.cachedStats || {}).some(s => Number.isFinite(s.length))).length === 1''')
            page.wait_for_function('''() => (%s)().split(' | ').some(t => /^[0-9.]+ px$/.test(t.trim()))''' % SVG_TEXT)
            page.wait_for_timeout(500)
            text = page.evaluate(SVG_TEXT)
            page.screenshot(path=str(EVIDENCE / 'freehand-no-spacing.png'))
            self.assertNotIn('undefined', text)
            self.assertNotIn('mm', text)
            def said():
                words = [w.strip() for w in page.evaluate(SVG_TEXT).split(' | ') if w.strip()]
                closed = [float(m) for w in words for m in re.findall(r'Perimeter: ([0-9.]+) px', w)]
                opened = [float(w[:-3]) for w in words if re.fullmatch(r'[0-9.]+ px', w)]
                areas = [float(m) for w in words for m in re.findall(r'Area: ([0-9.]+) px²', w)]
                return closed, opened, areas
            outlines = {closed: (length, area) for closed, length, area in page.evaluate(PIXEL_OUTLINES)}
            closed, opened, areas = said()
            self.assertEqual((len(closed), len(opened), len(areas)), (1, 1, 1), text)
            self.assertAlmostEqual(closed[0], outlines[True][0], delta=1, msg=(text, outlines))
            self.assertAlmostEqual(opened[0], outlines[False][0], delta=1, msg=(text, outlines))
            self.assertAlmostEqual(areas[0], outlines[True][1], delta=max(1, outlines[True][1] * .01), msg=(text, outlines))
            page.evaluate('''() => { const v = (%s)(); v.setZoom(v.getZoom() * 2); v.render(); }''' % CELL)
            page.evaluate('() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
            page.wait_for_timeout(500)
            self.assertEqual(said(), (closed, opened, areas), page.evaluate(SVG_TEXT))
            page.screenshot(path=str(EVIDENCE / 'freehand-no-spacing-zoomed.png'))
            # The Measurements panel's rows (what its CSV reads too): the closed outline's area in px², never mm².
            rows = page.evaluate('''() => services.measurementService.getMeasurements().filter(m => m.toolName === 'PlanarFreehandROI')
                .map(m => [m.displayText?.primary?.[0], m.getReport().columns, m.getReport().values])''')
            self.assertEqual(2, len(rows), rows)
            self.assertFalse([r for r in rows if 'mm' in str(r[0])], rows)
            ring = next(r for r in rows if r[0] != '0 px²')
            self.assertAlmostEqual(float(ring[0].split()[0]), outlines[True][1], delta=max(1, outlines[True][1] * .01), msg=rows)
            self.assertEqual('px²', ring[2][ring[1].index('Unit')], ring)
            # The words only: the measurement the tool keeps is as the pinned tool made it.
            kept = page.evaluate('''() => cornerstoneTools.annotation.state.getAllAnnotations().filter(a => a.metadata.toolName === 'PlanarFreehandROI')
                .map(a => Object.values(a.data.cachedStats)[0]).map(s => s.unit ?? null)''')
            self.assertEqual([None, None], kept)
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

    def ct_values(self, ds, image_points):
        """The original's own pixels inside an Ellipse ROI given by its handles' (continuous) image coordinates, in HU, and the
        ROI's area in mm² — computed from the DICOM here, not by the viewer."""
        bottom, top, left, right = np.array(image_points) * [float(ds.PixelSpacing[1]), float(ds.PixelSpacing[0]), 1]
        ru, rv = np.linalg.norm(right - left) / 2, np.linalg.norm(bottom - top) / 2
        center = (bottom + top + left + right) / 4
        yy, xx = np.mgrid[:int(ds.Rows), :int(ds.Columns)]
        world = np.stack([xx * float(ds.PixelSpacing[1]), yy * float(ds.PixelSpacing[0]), np.zeros_like(xx)], axis=-1)
        d = world - center
        mask = (d @ ((right - left) / (2 * ru)) / ru) ** 2 + (d @ ((bottom - top) / (2 * rv)) / rv) ** 2 <= 1
        values = ds.pixel_array[mask].astype(float) * float(ds.RescaleSlope) + float(ds.RescaleIntercept)
        return np.pi * ru * rv, values

    def assert_hu(self, drawn, ds):
        area, values = self.ct_values(ds, drawn['imagePoints'])
        stats = drawn['stats']; named = {s['name']: s['value'] for s in stats['statsArray'] if s}
        self.assertEqual('HU', stats['modalityUnit'])
        self.assertAlmostEqual(stats['area'], area, delta=.01)
        self.assertAlmostEqual(stats['mean'], values.mean(), places=5)
        self.assertEqual(named['min'], values.min()); self.assertEqual(stats['max'], values.max())
        self.assertEqual(named['count'], values.size)
        return values

    def test_overlay_units_05_a_ct_without_rescale_type_is_measured_saved_and_reopened_in_hu(self):
        # A CT whose values are HU may leave Rescale Type out (the CT Image module's default). An Ellipse ROI on it is drawn
        # with the original's pixels in HU, moved, saved and verified by the server, reopened with the same points and HU, and
        # a manual SR made from it carries the same HU.
        source = self.plain_ct(); ds = self.source_dicom(source)
        delattr(ds, 'RescaleType')
        fixture = self.store(ds, source, 'OVUNITS no rescale type')
        original = self.source_dicom(fixture)
        self.assertNotIn('RescaleType', original)
        self.assertEqual((1.0, -1000.0), (float(original.RescaleSlope), float(original.RescaleIntercept)))
        work, page = self.open_tools_viewer(fixture)
        errors = self.watched(page)
        try:
            select_image_tool(page, 'EllipticalROI')
            box = self.canvas_box(page)
            x, y = box['x'] + box['width'] * .4, box['y'] + box['height'] * .4
            self.drag_path(page, [(x, y), (x + 65, y + 32)])
            drawn = self.ellipse(page)
            self.assert_hu(drawn, original)
            expect(page.locator('svg.svg-layer')).to_contain_text(' HU')
            expect(page.locator('#kin-viewer-history [role=status]')).not_to_contain_text('HU 보정')
            # Moved by its right handle: the statistics follow the new outline on the original.
            before = drawn['points']
            right = drawn['canvas'][3]
            page.mouse.move(*right); page.mouse.down(); page.mouse.move(right[0] + 30, right[1], steps=10); page.mouse.up()
            page.wait_for_function('''old => cornerstoneTools.annotation.state.getAllAnnotations().some(a => a.metadata.toolName === 'EllipticalROI'
                && !a.invalidated && JSON.stringify(a.data.handles.points) !== JSON.stringify(old))''', arg=before)
            page.wait_for_timeout(400)
            moved = self.ellipse(page)
            self.assertNotEqual(moved['points'], before)
            values = self.assert_hu(moved, original)
            row = page.locator('#kin-viewer-history section[data-kind=ellipse]')
            row.get_by_role('button', name='Save', exact=True).click()
            expect(row).to_contain_text('저장 완료')
            heads = self.saved(fixture)
            self.assertEqual(1, len(heads))
            head = heads[0]
            self.assertEqual('verified', head['referenceStatus'])
            saved = head['item']['baseline']['values']
            self.assertAlmostEqual(saved[1], values.mean(), places=5)
            self.assertEqual([saved[2], saved[3], saved[4]], [values.min(), values.max(), values.size])
            page.screenshot(path=str(EVIDENCE / 'ct-no-rescale-type-saved.png'))
            self.assertEqual([], errors)
        finally:
            page.close(); work.close()
        # Reopened: the same points, verified again, the same HU.
        work, page = self.open_tools_viewer(fixture)
        try:
            page.wait_for_function('''() => cornerstoneTools.annotation.state.getAllAnnotations().some(a => a.metadata.toolName === 'EllipticalROI'
                && !a.invalidated && a.data.kinUnverified === false)''', timeout=30000)
            again = self.ellipse(page)
            self.assertEqual(again['points'], moved['points'])
            self.assert_hu(again, original)
            expect(page.locator('#kin-viewer-history section[data-kind=ellipse]')).not_to_contain_text('재확인 필요')
            page.screenshot(path=str(EVIDENCE / 'ct-no-rescale-type-reopened.png'))
        finally:
            page.close(); work.close()
        # A manual SR from the saved item: the server recomputes the ROI from the original and says the same HU.
        response = self.stack.request('POST', '/studies/' + fixture.uid + '/manual-sr', 'doctor',
                                      {'requestId': str(uuid.uuid4()), 'items': [{'id': head['id'], 'revision': head['revision']}]})
        self.assertEqual(200, response.status, response.text)
        found = {}
        def walk(node):
            for item in node if isinstance(node, list) else [node]:
                if not isinstance(item, dict):
                    continue
                if item.get('ValueType') == 'NUM':
                    name = item['ConceptNameCodeSequence']; measured = item['MeasuredValueSequence']
                    name = name[0] if isinstance(name, list) else name; measured = measured[0] if isinstance(measured, list) else measured
                    unit = measured['MeasurementUnitsCodeSequence']; unit = unit[0] if isinstance(unit, list) else unit
                    found[name['CodeMeaning']] = (float(measured['NumericValue']), unit['CodeValue'])
                if 'ContentSequence' in item:
                    walk(item['ContentSequence'])
        walk(response.body['dataset'])
        self.assertEqual("[hnsf'U]", found['Mean CT attenuation'][1])
        self.assertAlmostEqual(found['Mean CT attenuation'][0], values.mean(), places=5)
        self.assertEqual(found['Minimum CT attenuation'][0], values.min())
        self.assertEqual(found['Maximum CT attenuation'][0], values.max())


if __name__ == '__main__':
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    unittest.main(verbosity=2)
