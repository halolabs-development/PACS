# coding: utf-8
"""MG menu on the served viewer with synthetic mammograms stored over C-STORE (test_mammography_hanging.py's phantoms,
their tissue against the chest wall each stored orientation names: current needs no flips, prior L is stored flipped on
both axes): Mirrored point on eight cells (the same view only, in image coordinates through each image's stored
orientation), Quadrant Zoom Next ×3 by the quarters of the breast as it was made, the I key, the lens, Breast Edge, Fit
Breast and Match Size on the image as it was made, a synthetic five-frame DBT where Step
Interval, Slab Thickness (pixel values in the cell and on its canvas, and back) and Play run on the real stack,
Mammo Keypad Patient ▶ between two patient tabs with a linked reading screen holding unconfirmed text, and Add Key Image
on breast images drawn flipped (stored orientation, Flip Horizontal) and on a DBT frame: the stored original and frame."""
import json, os, re, time, unittest, uuid
import numpy as np
from pydicom.dataset import Dataset, FileDataset, FileMetaDataset
from pydicom.uid import ExplicitVRLittleEndian, generate_uid
from pynetdicom import AE
from playwright.sync_api import expect
from test_viewer_ux_priors import ViewerUXPriorsE2E
from test_mammography_hanging import MammographyHangingE2E as MG
from test_prior_selection import canvas_ready
from invariants_live import Fixture, drop_viewer_rows
from viewer_tools import image_tool

# Per-cell state read from the viewer: identity from the image's metadata, the zoom and the focal point in image indices.
CELLS = '''() => [...services.viewportGridService.getState().viewports.values()].sort((a,b)=>a.y-b.y||a.x-b.x).map(g=>{
  const v=services.cornerstoneViewportService.getCornerstoneViewport(g.viewportId), id=v?.getCurrentImageId?.();
  if(!id) return null;
  const m=cornerstone.metaData.get('instance',id), d=v.getImageData().imageData, i=d.worldToIndex([...v.getCamera().focalPoint], new Float64Array(3));
  return {id:g.viewportId, study:m.StudyInstanceUID, side:m.ImageLaterality, view:m.ViewPosition, zoom:v.getZoom(), x:i[0], y:i[1],
    index:v.getCurrentImageIdIndex(), count:v.getImageIds().length};
})'''


class ViewerMgE2E(ViewerUXPriorsE2E):
    def mg(self, page, label):
        page.get_by_role('button', name='MG ▾', exact=True).click()
        page.get_by_role('menu', name='MG').get_by_role('menuitem', name=label, exact=True).click()

    def cells(self, page):
        return [c for c in page.evaluate(CELLS) if c]

    # The MG menu goes by the image headers, read when the cells are given their images: what is pressed before a
    # cell's header is read leaves that cell out. Here every cell's header is read before anything is pressed.
    def headers_read(self, page, count):
        page.wait_for_function('n => document.querySelectorAll("[data-cy=viewport-pane][data-kin-mg-image=read]").length === n', arg=count, timeout=30000)

    def cell(self, page, study, side, view):
        return next(c for c in self.cells(page) if c['study'] == study and c['side'] == side and c['view'] == view)

    def artifacts(self):
        from pathlib import Path
        folder = Path(os.environ.get('KIN_EVIDENCE_DIR', Path(__file__).parent / 'artifacts')); folder.mkdir(parents=True, exist_ok=True)
        return folder

    # Four DBT objects (R/L × CC/MLO) of five frames; tissue in frame z is 200 + 150·z² so a slab mean differs from every frame.
    def dbt(self, patient):
        uid = generate_uid()
        fixture = Fixture(uid, patient, "한림병원", "jmryu", "MG-DBT-SYNTHETIC")
        self.stack.active[uid] = fixture
        sop_class = '1.2.840.10008.5.1.4.1.1.13.1.3'
        ae = AE(ae_title='HALLYM_CT'); ae.add_requested_context(sop_class, ExplicitVRLittleEndian)
        assoc = ae.associate('127.0.0.1', int(os.environ.get('KIN_TEST_DICOM_PORT', '4242')), ae_title='KINLAB')
        self.assertTrue(assoc.is_established)
        frame_of_reference = generate_uid()
        try:
            for index, (view, side) in enumerate([(v, s) for v in ['CC', 'MLO'] for s in ['R', 'L']]):
                sop = generate_uid(); meta = FileMetaDataset()
                meta.TransferSyntaxUID = ExplicitVRLittleEndian
                meta.MediaStorageSOPClassUID, meta.MediaStorageSOPInstanceUID = sop_class, sop
                meta.ImplementationClassUID = generate_uid()
                ds = FileDataset(None, {}, file_meta=meta, preamble=b'\0' * 128)
                ds.is_little_endian, ds.is_implicit_VR = True, False
                ds.SOPClassUID, ds.SOPInstanceUID = sop_class, sop
                ds.SpecificCharacterSet = 'ISO_IR 192'
                ds.PatientID, ds.PatientName = patient, 'MGDBT^SYNTHETIC'
                ds.PatientBirthDate, ds.PatientSex, ds.InstitutionName = '', 'O', '한림병원'
                ds.StudyInstanceUID, ds.SeriesInstanceUID = uid, generate_uid()
                ds.StudyDate = ds.SeriesDate = '20260101'; ds.StudyTime = ds.SeriesTime = '120000'
                ds.StudyDescription = ds.SeriesDescription = 'MG DBT Phantom'
                ds.AccessionNumber, ds.StudyID = patient[-12:], 'MGDBT'
                ds.Modality, ds.SeriesNumber, ds.InstanceNumber = 'MG', index + 1, 1
                ds.Rows = ds.Columns = 128
                ds.SamplesPerPixel, ds.PhotometricInterpretation = 1, 'MONOCHROME2'
                ds.BitsAllocated = ds.BitsStored = 16; ds.HighBit, ds.PixelRepresentation = 15, 0
                ds.WindowCenter, ds.WindowWidth = 1000, 2000
                ds.PresentationIntentType = 'FOR PRESENTATION'
                ds.ImageLaterality, ds.ViewPosition, ds.PartialView = side, view, 'NO'
                code = Dataset(); code.CodingSchemeDesignator = 'SCT'
                code.CodeValue = '399162004' if view == 'CC' else '399368009'; code.CodeMeaning = view
                ds.ViewCodeSequence = [code]
                ds.PatientOrientation = ['P' if side == 'R' else 'A', ('L' if side == 'R' else 'R') if view == 'CC' else 'F']
                ds.NumberOfFrames = 5
                ds.ImageType = ['ORIGINAL', 'PRIMARY', 'VOLUME', 'NONE']
                ds.VolumetricProperties, ds.VolumeBasedCalculationTechnique = 'VOLUME', 'NONE'
                ds.FrameOfReferenceUID = frame_of_reference
                directions = {'A': [0, -1, 0], 'P': [0, 1, 0], 'L': [1, 0, 0], 'R': [-1, 0, 0], 'H': [0, 0, 1], 'F': [0, 0, -1]}
                row, column = [directions[v] for v in ds.PatientOrientation]
                shared, plane, measures = Dataset(), Dataset(), Dataset()
                plane.ImageOrientationPatient = row + column
                measures.PixelSpacing, measures.SliceThickness = [1, 1], 1
                shared.PlaneOrientationSequence, shared.PixelMeasuresSequence = [plane], [measures]
                ds.SharedFunctionalGroupsSequence = [shared]; ds.PerFrameFunctionalGroupsSequence = []
                for z in range(5):
                    frame, frame_type, position = Dataset(), Dataset(), Dataset()
                    frame_type.FrameType = ds.ImageType
                    frame_type.VolumetricProperties, frame_type.VolumeBasedCalculationTechnique = 'VOLUME', 'NONE'
                    position.ImagePositionPatient = (np.cross(row, column) * z).astype(float).tolist()
                    frame.XRay3DFrameTypeSequence, frame.PlanePositionSequence = [frame_type], [position]
                    ds.PerFrameFunctionalGroupsSequence.append(frame)
                frames = []
                for z in range(5):
                    pixels = np.zeros((128, 128), dtype='<u2'); pixels[15:105, 15:80] = 200 + 150 * z * z
                    pixels[22:42, 22:35] = 2600  # a bright marker in every frame (the canvas readiness contrast)
                    frames.append(pixels)
                ds.PixelData = np.stack(frames).tobytes()
                self.assertEqual(assoc.send_c_store(ds).Status, 0)
        finally:
            assoc.release()
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline:
            result = self.stack.request('GET', '/studies', 'jmryu')
            if result.status == 200 and any(s.get('uid') == uid for s in result.body.get('studies', [])): break
            time.sleep(.25)
        else:
            self.fail('Synthetic DBT did not reach the API')
        self.assertEqual(self.stack.request('PATCH', '/studies/' + uid, 'jmryu', {'ss': 'Verified'}).status, 200)
        return fixture

    # The camera's focal point (image index) at the middle of step `step`'s quarter of a CC breast as the phantom was made
    # (MG.breast_box): the chest-wall upper quarter, the chest-wall lower, the nipple-side lower, the nipple-side upper;
    # the chest wall is the stored right for R, the stored left for L. Not what the product found.
    @staticmethod
    def quarter_centre(side, step):
        box, (top, chest) = MG.breast_box(side), [(True, True), (False, True), (False, False), (True, False)][step]
        xm, ym = (box['x0'] + box['x1']) / 2, (box['y0'] + box['y1']) / 2
        x = (xm + box['x1']) / 2 if chest == (side == 'R') else (box['x0'] + xm) / 2
        y = (box['y0'] + ym) / 2 if top else (ym + box['y1']) / 2
        return [x - 0.5, y - 0.5]

    def test_mg_01_mirrored_point_and_quadrant_zoom_on_eight_cells(self):
        patient = 'MGM-' + uuid.uuid4().hex[:12]
        current = MG.phantom(self, patient, breast=True); prior = MG.phantom(self, patient, prior=True, breast=True)
        page = self.login()
        MG.open_mg(self, page, [current, prior], 8)
        MG.image_state(self, page)
        self.headers_read(page, 8)
        before = {(c['study'], c['side'], c['view']): c for c in self.cells(page)}
        self.mg(page, 'Mirrored')
        expect(page.get_by_role('dialog', name='Mirrored')).to_be_visible()
        source = before[(current.uid, 'R', 'CC')]
        box = page.locator('[data-viewport-uid="' + source['id'] + '"]').bounding_box()
        page.mouse.click(box['x'] + box['width'] * 0.35, box['y'] + box['height'] * 0.4)
        page.wait_for_function('''id=>Math.abs(services.cornerstoneViewportService.getCornerstoneViewport(id).getZoom()-2)<1e-6''', arg=before[(prior.uid, 'L', 'CC')]['id'], timeout=15000)
        after = {(c['study'], c['side'], c['view']): c for c in self.cells(page)}
        (folder := self.artifacts()).joinpath('MG-mirrored.json').write_text(json.dumps({'before': list(before.values()), 'after': list(after.values())}), encoding='utf-8')
        page.screenshot(path=str(folder / 'MG-mirrored.png'))
        rcc = after[(current.uid, 'R', 'CC')]; x, y = rcc['x'], rcc['y']
        # Every CC cell at twice its Fit; the same place in image coordinates: mirrored across for the left breast, and
        # through the prior L's stored flips (both axes). 128 × 128 phantoms.
        for key, expected in (((current.uid, 'L', 'CC'), (127 - x, y)), ((prior.uid, 'R', 'CC'), (x, y)), ((prior.uid, 'L', 'CC'), (x, 127 - y))):
            with self.subTest(cell=key):
                self.assertAlmostEqual(after[key]['zoom'], 2, places=4)
                self.assertAlmostEqual(after[key]['x'], expected[0], delta=0.01)
                self.assertAlmostEqual(after[key]['y'], expected[1], delta=0.01)
        for key in [k for k in after if k[2] == 'MLO']:
            self.assertAlmostEqual(after[key]['zoom'], before[key]['zoom'], places=4)
        page.get_by_role('dialog', name='Mirrored').get_by_role('button', name='Close').click()
        # Quadrant Zoom: the chest-wall upper quarter first (R chest wall right, L left), then Next ×3.
        self.mg(page, 'Quadrant Zoom')
        panel = page.get_by_role('dialog', name='Quadrant Zoom')
        expect(panel.locator('b')).to_have_text('Quadrant 1/4: Upper-Outer (R/L matched)')
        # 4× is the first choice: every step shows each cell at four times its Fit (Display › Zoom… 400 %).
        expect(panel.get_by_label('Zoom')).to_have_value('4x')
        page.wait_for_function('''id=>services.cornerstoneViewportService.getCornerstoneViewport(id).getZoom()>2.5''', arg=source['id'], timeout=15000)
        # Each step: the focus of today's R CC and L CC is the centre of that step's quarter of the breast as the phantom
        # was made, the same zoom on both, larger than Fit.
        ids = [source['id'], before[(current.uid, 'L', 'CC')]['id']]
        heads = []
        for step in range(4):
            if step:
                panel.get_by_role('button', name='Next Quadrant').click(); heads.append(panel.locator('b').text_content())
            want = [self.quarter_centre('R', step), self.quarter_centre('L', step)]
            page.wait_for_function('''([ids, want]) => ids.every((id, i) => { const v = services.cornerstoneViewportService.getCornerstoneViewport(id);
              const f = v.getImageData().imageData.worldToIndex([...v.getCamera().focalPoint], new Float64Array(3));
              return Math.abs(f[0] - want[i][0]) < 0.01 && Math.abs(f[1] - want[i][1]) < 0.01; })''', arg=[ids, want], timeout=15000)
            q = {(c['study'], c['side'], c['view']): c for c in self.cells(page)}
            with self.subTest(step=step):
                self.assertAlmostEqual(q[(current.uid, 'R', 'CC')]['zoom'], q[(current.uid, 'L', 'CC')]['zoom'], places=6)
                self.assertGreater(q[(current.uid, 'R', 'CC')]['zoom'], 2)
                for key in [k for k in q if k[2] in ('CC', 'MLO')]:
                    self.assertAlmostEqual(q[key]['zoom'], 4, places=4, msg=key)
                if step == 0:
                    # The chest-wall upper quarter first: right of the breast's middle (x 95.5) for R (chest wall at the
                    # stored right), left of it (x 32.5) for L.
                    self.assertGreater(q[(current.uid, 'R', 'CC')]['x'], 95.5); self.assertLess(q[(current.uid, 'L', 'CC')]['x'], 32.5)
        self.assertEqual(['Quadrant 2/4: Upper-Inner (R/L matched)', 'Quadrant 3/4: Lower-Inner (R/L matched)', 'Quadrant 4/4: Lower-Outer (R/L matched)'], heads)
        page.screenshot(path=str(folder / 'MG-quadrant-4.png'))
        expect(page.locator('[data-cy=viewport-pane]:has([data-viewport-uid="' + source['id'] + '"]) [data-mg-badge=quadrant]')).to_have_text(re.compile(r'^Q4 Lower-Outer · 4×'))
        # The viewer's own zoom window reads the same number for today's R CC.
        page.evaluate('id=>services.viewportGridService.setActiveViewportId(id)', source['id'])
        page.wait_for_function('id=>services.viewportGridService.getActiveViewportId()===id', arg=source['id'])
        page.get_by_role('button', name='Display ▾').click()
        page.get_by_role('menu', name='Display').get_by_role('menuitem', name='Zoom…', exact=True).click()
        zoom = page.locator('section.kin-ux-feature-panel[role=dialog][aria-label="Zoom"]')
        expect(zoom).to_contain_text('Current 400%')
        zoom.get_by_role('button', name='Close').click()
        # Fill Quadrant: the same step filling each cell (the zoom then depends on the image and the cell).
        panel.get_by_label('Zoom').select_option('fill')
        page.wait_for_function('''id=>Math.abs(services.cornerstoneViewportService.getCornerstoneViewport(id).getZoom()-4)>1e-3''', arg=source['id'], timeout=15000)
        q = {(c['study'], c['side'], c['view']): c for c in self.cells(page)}
        self.assertAlmostEqual(q[(current.uid, 'R', 'CC')]['zoom'], q[(current.uid, 'L', 'CC')]['zoom'], places=6)
        self.assertGreater(q[(current.uid, 'R', 'CC')]['zoom'], 2)
        expect(page.locator('[data-cy=viewport-pane]:has([data-viewport-uid="' + source['id'] + '"]) [data-mg-badge=quadrant]')).to_have_text(re.compile(r'^Q4 Lower-Outer · Fill Quadrant'))
        panel.get_by_role('button', name='Close').click()
        page.wait_for_function('''id=>Math.abs(services.cornerstoneViewportService.getCornerstoneViewport(id).getZoom()-1)<1e-6''', arg=source['id'], timeout=15000)

    def test_mg_04_the_i_key_inverts_the_same_view_with_mirrored_and_the_lens_outline_and_fit_lie_on_the_image(self):
        patient = 'MGI-' + uuid.uuid4().hex[:12]
        current = MG.phantom(self, patient, breast=True); prior = MG.phantom(self, patient, prior=True, breast=True)
        page = self.login()
        MG.open_mg(self, page, [current, prior], 8)
        MG.image_state(self, page)
        self.headers_read(page, 8)
        cells = {(c['study'], c['side'], c['view']): c for c in self.cells(page)}
        rcc = cells[(current.uid, 'R', 'CC')]['id']
        cc = [cells[k]['id'] for k in cells if k[2] == 'CC']; mlo = [cells[k]['id'] for k in cells if k[2] == 'MLO']
        self.assertEqual(4, len(cc))
        invert = 'ids => ids.map(id => !!services.cornerstoneViewportService.getCornerstoneViewport(id).getProperties().invert)'
        self.mg(page, 'Mirrored')
        expect(page.get_by_role('dialog', name='Mirrored')).to_be_visible()
        # The viewer's own Invert key on today's R CC: the four CC cells (both sides, current and prior) together, no MLO.
        page.evaluate('id=>services.viewportGridService.setActiveViewportId(id)', rcc)
        page.wait_for_function('id=>services.viewportGridService.getActiveViewportId()===id', arg=rcc)
        page.evaluate('() => document.activeElement?.blur?.()')
        page.keyboard.press('i')
        page.wait_for_function('ids => ids.every(id => services.cornerstoneViewportService.getCornerstoneViewport(id).getProperties().invert)', arg=cc, timeout=15000)
        self.assertEqual([False] * len(mlo), page.evaluate(invert, mlo))
        page.screenshot(path=str(self.artifacts() / 'MG-mirrored-invert.png'))
        page.evaluate('() => document.activeElement?.blur?.()')
        page.keyboard.press('i')
        page.wait_for_function('ids => !ids.some(id => services.cornerstoneViewportService.getCornerstoneViewport(id).getProperties().invert)', arg=cc, timeout=15000)
        # Magnifier: pressed on a flat part of today's R CC's breast (image 100, 60), the lens stands on that place and its
        # middle shows the cell's own canvas there; every lens shows the canvas under its own middle.
        self.mg(page, 'Magnifier')
        at = page.evaluate('''id => { const v = services.cornerstoneViewportService.getCornerstoneViewport(id), d = v.getImageData().imageData;
          const p = v.worldToCanvas(Array.from(d.indexToWorld([100, 60, 0], new Float64Array(3)))), r = v.element.getBoundingClientRect();
          return { x: r.left + p[0], y: r.top + p[1], canvas: p.map(n => Math.round(n)) }; }''', rcc)
        page.mouse.move(at['x'], at['y']); page.mouse.down()
        lenses = page.locator('.kin-mg-lens')
        expect(lenses).to_have_count(4, timeout=15000)
        state = page.evaluate('''() => [...document.querySelectorAll('.kin-mg-lens')].map(lens => {
          const pane = lens.closest('[data-cy=viewport-pane]'), v = [...services.viewportGridService.getState().viewports.keys()]
            .map(id => services.cornerstoneViewportService.getCornerstoneViewport(id)).find(view => view && pane.contains(view.element));
          const [x, y] = lens.dataset.at.split(',').map(Number), ratio = v.canvas.width / v.canvas.clientWidth, box = lens.getBoundingClientRect(), r = v.element.getBoundingClientRect();
          const own = [...v.canvas.getContext('2d').getImageData(Math.round(x * ratio), Math.round(y * ratio), 1, 1).data];
          const c = lens.querySelector('canvas'), shown = [...c.getContext('2d').getImageData(c.width / 2, c.height / 2, 1, 1).data];
          return { id: v.id, at: [x, y], centre: [box.left + box.width / 2 - r.left, box.top + box.height / 2 - r.top], own, shown }; })''')
        page.mouse.up()
        self.assertEqual(sorted(cc), sorted(s['id'] for s in state))
        for s in state:
            with self.subTest(cell=s['id']):
                self.assertAlmostEqual(s['at'][0], s['centre'][0], delta=1); self.assertAlmostEqual(s['at'][1], s['centre'][1], delta=1)
                for a, b in zip(s['own'][:3], s['shown'][:3]): self.assertAlmostEqual(a, b, delta=24, msg=s)
        self.assertEqual(at['canvas'], next(s['at'] for s in state if s['id'] == rcc))
        self.mg(page, 'Magnifier')
        # Breast Edge: the line lies on each image (its canvas covers the image, not the cell's header row); Fit Breast: the
        # whole breast box inside each cell.
        self.mg(page, 'Breast Display')
        display = page.get_by_role('dialog', name='Breast Display')
        display.get_by_role('button', name='Breast Edge').click()
        page.wait_for_function('n => document.querySelectorAll(".kin-mg-outline").length === n', arg=len(cc) + len(mlo), timeout=15000)
        placed = page.evaluate('''() => [...document.querySelectorAll('.kin-mg-outline')].map(canvas => {
          const pane = canvas.closest('[data-cy=viewport-pane]'), v = [...services.viewportGridService.getState().viewports.keys()]
            .map(id => services.cornerstoneViewportService.getCornerstoneViewport(id)).find(view => view && pane.contains(view.element));
          const a = canvas.getBoundingClientRect(), b = v.element.getBoundingClientRect();
          return [a.left - b.left, a.top - b.top, a.width - b.width, a.height - b.height]; })''')
        for offsets in placed:
            for n in offsets: self.assertAlmostEqual(0, n, delta=1, msg=placed)
        # Each cell's breast as its phantom was made (MG.breast_box), on the cell's own screen: the four corners of the
        # box, the screen length of its chest-wall-to-nipple side, and whether the line drawn crosses the box's nipple-side
        # end at mid height (the skin line of the tissue as it was made).
        boxes = {c['id']: MG.breast_box(side, prior=study == prior.uid) for (study, side, view), c in cells.items()}
        shown = '''boxes => Object.fromEntries(Object.entries(boxes).map(([id, b]) => { const v = services.cornerstoneViewportService.getCornerstoneViewport(id), d = v.getImageData().imageData;
          const at = (x, y) => v.worldToCanvas(Array.from(d.indexToWorld([x - 0.5, y - 0.5, 0], new Float64Array(3))));
          const corners = [[b.x0, b.y0], [b.x1, b.y1], [b.x0, b.y1], [b.x1, b.y0]].map(([x, y]) => at(x, y)), middle = (b.y0 + b.y1) / 2;
          const xs = corners.map(p => p[0]), ys = corners.map(p => p[1]), w = v.element.clientWidth, h = v.element.clientHeight;
          const a = at(b.x0, middle), z = at(b.x1, middle), skin = at(b.x1 === 128 ? b.x0 : b.x1, middle);
          const outline = v.element.closest('[data-cy=viewport-pane]').querySelector('.kin-mg-outline');
          let line = false;
          if (outline) { const r = outline.width / w, strip = outline.getContext('2d').getImageData(Math.round((skin[0] - 4) * r), Math.round(skin[1] * r), Math.max(1, Math.round(8 * r)), 1).data;
            for (let i = 3; i < strip.length; i += 4) if (strip[i] > 0) line = true; }
          return [id, { inside: corners.every(([x, y]) => x >= -1 && y >= -1 && x <= w + 1 && y <= h + 1), line,
            fill: Math.max((Math.max(...xs) - Math.min(...xs)) / w, (Math.max(...ys) - Math.min(...ys)) / h), length: Math.hypot(z[0] - a[0], z[1] - a[1]) }]; }))'''
        drawn = page.evaluate(shown, boxes)
        self.assertEqual({id: True for id in boxes}, {id: drawn[id]['line'] for id in boxes}, drawn)
        # Fit Breast: the whole breast as it was made inside each cell, filling it one way to the 2 % margin.
        display.get_by_role('button', name='Fit Breast').click()
        expect(page.locator('[data-mg-badge=zoom]')).to_have_count(len(cc) + len(mlo), timeout=15000)
        expect(page.locator('[data-mg-badge=zoom]').first).to_have_text('Zoom mode: Fit Breast', timeout=15000)
        fitted = page.evaluate(shown, boxes)
        for id in boxes:
            with self.subTest(fit=id):
                self.assertTrue(fitted[id]['inside'], fitted[id])
                self.assertAlmostEqual(0.98, fitted[id]['fill'], delta=0.01, msg=fitted[id])
        page.screenshot(path=str(self.artifacts() / 'MG-fit-breast.png'))
        # Match Size: the same chest-wall-to-nipple length on the screen in the cells of one view, every breast whole.
        display.get_by_role('button', name='Match Size').click()
        expect(page.locator('[data-mg-badge=zoom]').first).to_have_text('Zoom mode: Match Size', timeout=15000)
        expect(page.locator('[data-mg-badge=zoom]').filter(has_text='Zoom mode: Match Size')).to_have_count(len(cc) + len(mlo), timeout=15000)
        matched = page.evaluate(shown, boxes)
        for view in (cc, mlo):
            lengths = [matched[id]['length'] for id in view]
            self.assertLessEqual(max(lengths) - min(lengths), 1.5, lengths)
            self.assertGreater(min(lengths), 20, lengths)
            self.assertEqual([True] * len(view), [matched[id]['inside'] for id in view], matched)

    def test_mg_02_dbt_step_interval_slab_pixels_and_play(self):
        f = self.dbt('MGD-' + uuid.uuid4().hex[:12])
        page = self.login()
        MG.open_mg(self, page, [f], 4)
        page.wait_for_function('''()=>[...services.viewportGridService.getState().viewports.values()].some(g=>services.cornerstoneViewportService.getCornerstoneViewport(g.viewportId)?.getImageIds?.().length===5)''', timeout=60000)
        self.headers_read(page, 4)
        rcc = next(c for c in self.cells(page) if c['side'] == 'R' and c['view'] == 'CC')
        page.evaluate('id=>services.viewportGridService.setActiveViewportId(id)', rcc['id'])
        page.wait_for_function('id=>services.viewportGridService.getActiveViewportId()===id', arg=rcc['id'])
        self.mg(page, 'Tomo (DBT) Slices')
        panel = page.get_by_role('dialog', name='Tomo (DBT) Slices')
        expect(panel.locator('b')).to_have_text('Slice 1 / 5')
        panel.get_by_label('Step Interval').select_option('2')
        panel.get_by_role('button', name='Next ▶').click()
        expect(panel.locator('b')).to_have_text('Slice 3 / 5', timeout=15000)
        self.assertEqual(2, self.cell(page, f.uid, 'R', 'CC')['index'])
        # The value of a tissue pixel (column 40, row 60) in the cell's data and the grey drawn on its canvas there.
        probe = '''id=>{const v=services.cornerstoneViewportService.getCornerstoneViewport(id), d=v.getImageData().imageData;
          const value=d.getPointData().getScalars().getData()[60*128+40];
          const p=v.worldToCanvas(Array.from(d.indexToWorld([40,60,0], new Float64Array(3)))), c=v.canvas, r=c.width/c.clientWidth;
          const gray=c.getContext('2d').getImageData(Math.round(p[0]*r),Math.round(p[1]*r),1,1).data[0];
          return {value, gray};}'''
        page.wait_for_timeout(500)
        alone = page.evaluate(probe, rcc['id'])
        self.assertEqual(800, alone['value'])
        panel.get_by_label('Slab Thickness').select_option('3')
        badge = page.locator('[data-mg-badge=slab]')
        expect(badge).to_have_text('Slab 3', timeout=15000)
        page.wait_for_timeout(500)
        slab = page.evaluate(probe, rcc['id'])
        page.screenshot(path=str(self.artifacts() / 'MG-dbt-slab-3.png'))
        # Frames 1, 2, 3: (350 + 800 + 1550) / 3 = 900 in the data, and drawn brighter than frame 2's 800 (window 0 … 2000).
        self.assertAlmostEqual(900, slab['value'], delta=0.5)
        self.assertGreaterEqual(slab['gray'] - alone['gray'], 6, (alone, slab))
        panel.get_by_label('Slab Thickness').select_option('1')
        expect(badge).to_have_count(0)
        page.wait_for_timeout(500)
        back = page.evaluate(probe, rcc['id'])
        self.assertEqual(800, back['value'])
        self.assertLessEqual(abs(back['gray'] - alone['gray']), 1, (alone, back))
        panel.get_by_role('button', name='Play').click()
        page.wait_for_function('id=>services.cornerstoneViewportService.getCornerstoneViewport(id).getCurrentImageIdIndex()!==2', arg=rcc['id'], timeout=15000)
        panel.get_by_role('button', name='Stop').click()
        page.wait_for_timeout(300)
        at = self.cell(page, f.uid, 'R', 'CC')['index']; page.wait_for_timeout(600)
        self.assertEqual(at, self.cell(page, f.uid, 'R', 'CC')['index'])
        panel.get_by_role('button', name='Close').click()

    def history_panel(self, page):
        expect(page.locator('#kin-workspace-dock')).to_have_count(1, timeout=45000)
        tab = page.locator('#kin-workspace-dock nav button[aria-controls=kin-viewer-history]')
        if tab.get_attribute('aria-expanded') != 'true': tab.click()
        expect(page.locator('#kin-viewer-history [role=status]')).to_contain_text('개 저장 항목', timeout=45000)

    def shown(self, page, cell):
        return page.evaluate('''id => { const v = services.cornerstoneViewportService.getCornerstoneViewport(id), c = v.getCamera();
          const m = cornerstone.metaData.get('instance', v.getCurrentImageId());
          return { series: m.SeriesInstanceUID, sop: m.SOPInstanceUID, index: v.getCurrentImageIdIndex(), flipH: !!c.flipHorizontal, flipV: !!c.flipVertical }; }''', cell)

    def key_on(self, page, cell, title):
        box = page.locator('[data-viewport-uid="' + cell + '"]').bounding_box()
        page.mouse.click(box['x'] + box['width'] * 0.5, box['y'] + box['height'] * 0.5)
        page.wait_for_function('id => services.viewportGridService.getActiveViewportId() === id', arg=cell)
        page.get_by_role('button', name='Add Key Image', exact=True).click()
        row = page.locator('#kin-viewer-history section[data-kind=key]').last
        row.get_by_label('Key Title').fill(title)
        row.get_by_role('button', name='Save', exact=True).click()
        expect(row).to_contain_text('저장 완료', timeout=30000)

    def keys(self, study):
        result = self.stack.request('GET', '/studies/' + study + '/viewer-items', 'doctor')
        self.assertEqual(200, result.status, result.text)
        return {i['item']['title']: i['item'] for i in result.body['items'] if i['item']['kind'] == 'key'}

    def test_mg_05_key_image_on_flipped_and_tomosynthesis_breast_images_names_the_stored_original(self):
        # The earlier study's L images are stored flipped on both axes: the viewer draws them flipped back. A display mirror
        # flips the R MLO on the screen only. Either way the Key Image names the stored original and its frame.
        patient = 'MGKEY-' + uuid.uuid4().hex[:12]
        prior = MG.phantom(self, patient, prior=True)
        self.addCleanup(drop_viewer_rows, prior.uid)
        page = self.login()
        MG.open_mg(self, page, [prior], 4)
        MG.image_state(self, page)
        self.history_panel(page)
        flipped = self.cell(page, prior.uid, 'L', 'CC')['id']
        mirrored = self.cell(page, prior.uid, 'R', 'MLO')['id']
        # The toolbar's own Flip Horizontal on the active R MLO cell (a screen-only flip).
        page.evaluate('id => services.viewportGridService.setActiveViewportId(id)', mirrored)
        page.wait_for_function('id => services.viewportGridService.getActiveViewportId() === id', arg=mirrored)
        image_tool(page, 'flipHorizontal').click()
        page.wait_for_function('id => services.cornerstoneViewportService.getCornerstoneViewport(id).getCamera().flipHorizontal', arg=mirrored, timeout=15000)
        before = {'L CC key': self.shown(page, flipped), 'R MLO key': self.shown(page, mirrored)}
        self.assertEqual((before['L CC key']['flipH'], before['L CC key']['flipV']), (True, True), before)
        self.assertEqual((before['R MLO key']['flipH'], before['R MLO key']['flipV']), (True, False), before)
        self.key_on(page, flipped, 'L CC key')
        self.key_on(page, mirrored, 'R MLO key')
        page.screenshot(path=str(self.artifacts() / 'MG-key-image-saved.png'))
        stored = self.keys(prior.uid)
        for title, shown in before.items():
            # Only the image is kept: its series, SOP and frame, never the screen's flips.
            self.assertLessEqual(set(stored[title]), {'schemaVersion', 'kind', 'seriesUid', 'sopUid', 'frame', 'title', 'description', 'hidden'}, stored[title])
            self.assertEqual((stored[title]['seriesUid'], stored[title]['sopUid'], stored[title]['frame']), (shown['series'], shown['sop'], 1))

        # Opened again: the same rows, and Go to Image, pressed with a cell showing another image active, brings that stored
        # image (and its frame) into the active cell.
        MG.open_mg(self, page, [prior], 4)
        self.history_panel(page)
        for title, shown in before.items():
            start = next(c['id'] for c in self.cells(page) if self.shown(page, c['id'])['sop'] != shown['sop'])
            self.go_to_image(page, start, title, shown['sop'], 1)

        # A tomosynthesis object: the Key Image names the frame shown (frame 3 of 5).
        dbt = self.dbt('MGKEYD-' + uuid.uuid4().hex[:12])
        self.addCleanup(drop_viewer_rows, dbt.uid)
        MG.open_mg(self, page, [dbt], 4)
        self.history_panel(page)
        cell = self.cell(page, dbt.uid, 'L', 'CC')['id']
        page.wait_for_function('id => services.cornerstoneViewportService.getCornerstoneViewport(id)?.getImageIds?.().length === 5', arg=cell, timeout=60000)
        self.frame_index(page, cell, 2)
        shown = self.shown(page, cell)
        self.key_on(page, cell, 'DBT L CC frame 3')
        item = self.keys(dbt.uid)['DBT L CC frame 3']
        self.assertEqual((item['seriesUid'], item['sopUid'], item['frame']), (shown['series'], shown['sop'], 3))
        # Back on frame 1 of the same object: Go to Image returns to frame 3.
        self.frame_index(page, cell, 0)
        self.go_to_image(page, cell, 'DBT L CC frame 3', shown['sop'], 3)

    def frame_index(self, page, cell, index):
        page.evaluate('([id, n]) => services.cornerstoneViewportService.getCornerstoneViewport(id).setImageIdIndex(n)', [cell, index])
        # The frame is on the screen: the cell holds it and finished drawing it (the image a Key Image then names).
        page.wait_for_function('''([id, n]) => { const v = services.cornerstoneViewportService.getCornerstoneViewport(id), f = "/frames/" + (n + 1);
            return v.getCurrentImageId().endsWith(f) && !!v.getCornerstoneImage?.()?.imageId?.endsWith(f) &&
                v.viewportStatus === cornerstone.Enums.ViewportStatus.RENDERED; }''', arg=[cell, index], timeout=30000)

    def go_to_image(self, page, start, title, sop, frame):
        page.evaluate('id => services.viewportGridService.setActiveViewportId(id)', start)
        page.wait_for_function('id => services.viewportGridService.getActiveViewportId() === id', arg=start)
        row = page.locator('#kin-viewer-history section').filter(has_text=title)
        expect(row).to_be_visible()
        row.get_by_role('button', name='Go to Image').click()
        page.wait_for_function('''([id, sop, frame]) => { const v = services.cornerstoneViewportService.getCornerstoneViewport(id), image = v?.getCurrentImageId?.();
          return services.viewportGridService.getActiveViewportId() === id && cornerstone.metaData.get('instance', image)?.SOPInstanceUID === sop
            && (frame === 1 ? !/\\/frames\\/(?!1$)\\d+$/.test(image) : image.endsWith('/frames/' + frame)); }''', arg=[start, sop, frame], timeout=30000)

    def test_mg_03_keypad_patient_move_takes_images_and_report_target_together(self):
        a = MG.phantom(self, 'MGKA-' + uuid.uuid4().hex[:12]); b = MG.phantom(self, 'MGKB-' + uuid.uuid4().hex[:12])
        work = self.login()
        self.select(work, a)
        with work.context.expect_page() as opened:
            work.locator('#m-filmbox').click()
        page = opened.value
        page.on('dialog', lambda dialog: dialog.accept())
        canvas_ready(page, 4)
        self.select(work, b)
        work.locator('#m-filmbox').click()
        tabs = page.get_by_role('tablist', name='Patients')
        expect(tabs.get_by_role('tab')).to_have_count(2, timeout=45000)
        # B is shown before A's tab is pressed (a press while the switch to B redraws the tab list is lost).
        expect(tabs.get_by_role('tab').filter(has_text=b.patient_id)).to_have_attribute('aria-selected', 'true', timeout=45000)
        page.wait_for_function("() => !document.body.classList.contains('kin-patient-switching')", timeout=45000)
        canvas_ready(page, 4)
        tabs.get_by_role('tab').filter(has_text=a.patient_id).click()
        expect(tabs.get_by_role('tab').filter(has_text=a.patient_id)).to_have_attribute('aria-selected', 'true', timeout=45000)
        canvas_ready(page, 4)
        # The reading screen on A with text its server has not confirmed (its draft writes are refused for now).
        self.select(work, a)
        work.route('**/studies/' + a.uid + '/draft*', lambda route: route.fulfill(status=503, json={'message': 'Synthetic draft outage'}))
        work.locator('#findings').fill('MG KEYPAD A DRAFT')
        work.wait_for_timeout(2500)
        self.mg(page, 'Mammo Keypad')
        panel = page.get_by_role('dialog', name='Mammo Keypad')
        # Before a confirmed move the keypad marks only the images (the report target is not claimed).
        expect(panel.locator('ol li').first).to_have_text(re.compile(r'.*← images$'))
        panel.get_by_role('button', name='Patient ▶').click()
        question = panel.get_by_role('alertdialog')
        expect(question.get_by_role('button')).to_have_text(['Save Draft & Move', 'Discard & Move', 'Cancel'], timeout=15000)
        question.get_by_role('button', name='Cancel').click()
        expect(tabs.get_by_role('tab').filter(has_text=a.patient_id)).to_have_attribute('aria-selected', 'true')
        work.unroute('**/studies/' + a.uid + '/draft*')
        panel.get_by_role('button', name='Patient ▶').click()
        panel.get_by_role('alertdialog').get_by_role('button', name='Save Draft & Move').click()
        tabs = page.get_by_role('tablist', name='Patients')
        expect(tabs.get_by_role('tab').filter(has_text=b.patient_id)).to_have_attribute('aria-selected', 'true', timeout=45000)
        panel = page.get_by_role('dialog', name='Mammo Keypad')
        expect(panel.locator('[role=status]')).to_contain_text('영상과 판독 대상으로 옮겼습니다', timeout=30000)
        expect(panel.locator('ol li').nth(1)).to_have_text(re.compile(r'.*← images · report target$'))
        page.screenshot(path=str(self.artifacts() / 'MG-keypad-moved.png'))
        # Images, tab and the reading screen's target are all B; A's text was saved as its draft before the move.
        # Four cells draw B's images and none another patient's.
        page.wait_for_function('uid=>{const ids=[...services.viewportGridService.getState().viewports.keys()].map(id=>services.cornerstoneViewportService.getCornerstoneViewport(id)?.getCurrentImageId?.()).filter(Boolean);return ids.length>=4&&ids.every(i=>cornerstone.metaData.get("instance",i)?.StudyInstanceUID===uid)}', arg=b.uid, timeout=45000)
        canvas_ready(page, 4)
        # The reading screen's selected study (the worklist may filter B's row out of view).
        work.wait_for_function('uid=>selectedUid===uid', arg=b.uid, timeout=15000, polling=100)
        draft = self.stack.request('GET', '/studies/' + a.uid + '/draft', 'doctor')
        self.assertEqual(200, draft.status, draft.text)
        self.assertIn('MG KEYPAD A DRAFT', json.dumps(draft.body, ensure_ascii=False))


def load_tests(loader, tests, pattern):
    return unittest.TestSuite(ViewerMgE2E(n) for n in loader.getTestCaseNames(ViewerMgE2E) if n.startswith('test_mg_'))


if __name__ == '__main__':
    unittest.main(verbosity=2)
