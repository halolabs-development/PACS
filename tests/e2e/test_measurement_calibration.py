# coding: utf-8
"""D-MEASURE2 A5: observe natural pinned classic CT calibration, no event injection."""
import json, math, re, sys, time, unittest, uuid
from pathlib import Path
import numpy as np
from pydicom.dataset import FileDataset, FileMetaDataset
from pydicom.uid import (ComputedRadiographyImageStorage, DigitalXRayImageStorageForPresentation, ExplicitVRLittleEndian,
                         XRayAngiographicImageStorage, XRayRadiofluoroscopicImageStorage, generate_uid)
from pynetdicom import AE
from invariants_live import Fixture
from test_measurement_panel import MeasurementPanelE2E, expect
from viewer_precision_support import canvas_ready

NO_SPACING = '원본에 픽셀 간격이 없습니다 · Calibration으로 화면 보정 후 잴 수 있습니다'
SCREEN = '화면 보정 · 저장 안 됨'


def synthetic_cr_without_spacing(stack, patient, label, date):
    """A CR whose original gives no pixel size at all (a scanned film, an outside CR): no PixelSpacing, no ImagerPixelSpacing."""
    uid, series, sop = generate_uid(), generate_uid(), generate_uid()
    fixture = Fixture(uid, patient, "한림병원", "jmryu", "CALCR-SYNTHETIC-" + label)
    stack.active[uid] = fixture
    ae = AE(ae_title="HALLYM_CT")
    ae.add_requested_context(ComputedRadiographyImageStorage, ExplicitVRLittleEndian)
    assoc = ae.associate("127.0.0.1", 4242, ae_title="KINLAB")
    if not assoc.is_established:
        raise RuntimeError("Local synthetic CR association failed")
    try:
        meta = FileMetaDataset()
        meta.TransferSyntaxUID = ExplicitVRLittleEndian
        meta.MediaStorageSOPClassUID = ComputedRadiographyImageStorage
        meta.MediaStorageSOPInstanceUID = sop
        meta.ImplementationClassUID = generate_uid()
        ds = FileDataset(None, {}, file_meta=meta, preamble=b"\0" * 128)
        ds.is_little_endian, ds.is_implicit_VR = True, False
        ds.SOPClassUID, ds.SOPInstanceUID = ComputedRadiographyImageStorage, sop
        ds.SpecificCharacterSet = "ISO_IR 192"
        ds.PatientName, ds.PatientID = "CALCR^SYNTHETIC", patient
        ds.PatientBirthDate, ds.PatientSex, ds.InstitutionName = "", "O", "한림병원"
        ds.StudyInstanceUID, ds.SeriesInstanceUID = uid, series
        ds.StudyDate = ds.SeriesDate = date
        ds.StudyTime = ds.SeriesTime = "120000"
        ds.AccessionNumber, ds.StudyID = "CALCR" + label[:10], "CALCR"
        ds.StudyDescription = ds.SeriesDescription = "CALCR " + label
        ds.Modality, ds.BodyPartExamined, ds.SeriesNumber, ds.InstanceNumber = "CR", "HAND", 1, 1
        ds.ImageType = ["ORIGINAL", "PRIMARY"]
        ds.Rows = ds.Columns = 256
        ds.SamplesPerPixel, ds.PhotometricInterpretation = 1, "MONOCHROME2"
        ds.BitsAllocated = ds.BitsStored = 16
        ds.HighBit, ds.PixelRepresentation = 15, 0
        ds.WindowCenter, ds.WindowWidth = 500, 1000
        pixels = np.full((256, 256), 200, dtype=np.uint16)
        pixels[40:216, 60:196] = 600
        pixels[230:234, 28:228:20] = 1000  # ruler ticks
        ds.PixelData = pixels.astype("<u2").tobytes()
        status = assoc.send_c_store(ds)
        if status is None or status.Status != 0:
            raise RuntimeError("Synthetic CR C-STORE failed")
    finally:
        assoc.release()
    deadline = time.monotonic() + 30
    while time.monotonic() < deadline:
        result = stack.request("GET", "/studies", "jmryu")
        if result.status == 200 and any(s.get("uid") == uid for s in result.body.get("studies", [])):
            break
        time.sleep(.25)
    else:
        raise RuntimeError("Synthetic CR did not reach the real API")
    if stack.request("PATCH", "/studies/" + uid, "jmryu", {"ss": "Verified"}).status != 200:
        raise RuntimeError("Synthetic CR verification failed")
    return fixture

def synthetic_projection(stack, patient, label, date, modality, sop_class, tags, frames=1):
    """A projection X-ray as most devices send it: a pixel size, but no ImagePositionPatient / ImageOrientationPatient.
    The tag sets follow DICOM PS3.3 (Imager Pixel Spacing is required in the DX family; a Pixel Spacing that differs from
    it has been corrected or calibrated, 10.7.1.1). The CR mirrors the public pydicom test CR (MIT licence: Imager Pixel
    Spacing 0.1\\0.1, no position or orientation); DX, RF and XA are synthetic tag sets, not copies of a device file."""
    uid, series, sop = generate_uid(), generate_uid(), generate_uid()
    fixture = Fixture(uid, patient, "한림병원", "jmryu", "PROJ-SYNTHETIC-" + label)
    stack.active[uid] = fixture
    ae = AE(ae_title="HALLYM_CT")
    ae.add_requested_context(sop_class, ExplicitVRLittleEndian)
    assoc = ae.associate("127.0.0.1", 4242, ae_title="KINLAB")
    if not assoc.is_established:
        raise RuntimeError("Local synthetic projection association failed")
    try:
        meta = FileMetaDataset()
        meta.TransferSyntaxUID = ExplicitVRLittleEndian
        meta.MediaStorageSOPClassUID = sop_class
        meta.MediaStorageSOPInstanceUID = sop
        meta.ImplementationClassUID = generate_uid()
        ds = FileDataset(None, {}, file_meta=meta, preamble=b"\0" * 128)
        ds.is_little_endian, ds.is_implicit_VR = True, False
        ds.SOPClassUID, ds.SOPInstanceUID = sop_class, sop
        ds.SpecificCharacterSet = "ISO_IR 192"
        ds.PatientName, ds.PatientID = "PROJ^SYNTHETIC", patient
        ds.PatientBirthDate, ds.PatientSex, ds.InstitutionName = "", "O", "한림병원"
        ds.StudyInstanceUID, ds.SeriesInstanceUID = uid, series
        ds.StudyDate = ds.SeriesDate = date
        ds.StudyTime = ds.SeriesTime = "120000"
        ds.AccessionNumber, ds.StudyID = "PROJ" + label[:12], "PROJ"
        ds.StudyDescription = ds.SeriesDescription = "PROJ " + label
        ds.Modality, ds.BodyPartExamined, ds.SeriesNumber, ds.InstanceNumber = modality, "CHEST", 1, 1
        ds.ImageType = ["ORIGINAL", "PRIMARY"]
        ds.Rows, ds.Columns = 256, 320
        ds.SamplesPerPixel, ds.PhotometricInterpretation = 1, "MONOCHROME2"
        ds.BitsAllocated = ds.BitsStored = 16
        ds.HighBit, ds.PixelRepresentation = 15, 0
        ds.WindowCenter, ds.WindowWidth = 500, 1000
        for key, value in tags.items():
            setattr(ds, key, value)
        pixels = np.full((frames, 256, 320), 200, dtype=np.uint16)
        pixels[:, 40:216, 60:260] = 600
        if frames > 1:
            ds.NumberOfFrames, ds.FrameIncrementPointer = frames, (0x0018, 0x1063)
            ds.FrameTime = 100
        ds.PixelData = pixels.astype("<u2").tobytes()
        status = assoc.send_c_store(ds)
        if status is None or status.Status != 0:
            raise RuntimeError("Synthetic projection C-STORE failed")
    finally:
        assoc.release()
    deadline = time.monotonic() + 30
    while time.monotonic() < deadline:
        result = stack.request("GET", "/studies", "jmryu")
        if result.status == 200 and any(s.get("uid") == uid for s in result.body.get("studies", [])):
            break
        time.sleep(.25)
    else:
        raise RuntimeError("Synthetic projection did not reach the real API")
    if stack.request("PATCH", "/studies/" + uid, "jmryu", {"ss": "Verified"}).status != 200:
        raise RuntimeError("Synthetic projection verification failed")
    return fixture

# Each: modality, SOP class, tags (no position or orientation), [row, column] spacing the measurement must use, basis words.
PROJECTIONS = [
    ('CR', ComputedRadiographyImageStorage, dict(ImagerPixelSpacing=[.1, .1]), [.1, .1], 'ImagerPixelSpacing · 검출기 기준'),
    ('DX', DigitalXRayImageStorageForPresentation, dict(PixelSpacing=[.15, .15], ImagerPixelSpacing=[.168, .168]), [.15, .15], 'PixelSpacing · 원본 기준면'),
    ('RF', XRayRadiofluoroscopicImageStorage, dict(ImagerPixelSpacing=[.3, .3], EstimatedRadiographicMagnificationFactor=1.2), [.25, .25], 'ImagerPixelSpacing / ERMF · 추정 보정'),
    ('XA', XRayAngiographicImageStorage, dict(ImagerPixelSpacing=[.2, .4]), [.2, .4], 'ImagerPixelSpacing · 검출기 기준'),
]
# What the viewer itself holds for the last mark of a tool: the plane it placed the image in, the mark's points, and the
# viewer's own native value (world distance / angle) for those points.
NATIVE = '''tool=>{const a=cornerstoneTools.annotation.state.getAllAnnotations().filter(a=>a.metadata.toolName===tool).at(-1);
  const plane=cornerstone.metaData.get('imagePlaneModule',a.metadata.referencedImageId), s=Object.values(a.data.cachedStats||{})[0]||{};
  return {row:plane.rowCosines,column:plane.columnCosines,origin:plane.imagePositionPatient,points:a.data.handles.points,
    value:tool==='Length'?s.length:s.angle,image:a.metadata.referencedImageId};}'''
SVG_TEXT = "()=>[...document.querySelectorAll('svg.svg-layer text')].map(t=>t.textContent).join(' ')"

OBSERVER = '''(()=>{
  const objects=new WeakMap(); let serial=0;
  const key=o=>{if (!o || typeof o!=='object') return null; if(!objects.has(o))objects.set(o,++serial);return objects.get(o);};
  window.calibrationObservation={events:[],replacements:[],samples:0};
  document.addEventListener('CORNERSTONE_IMAGE_SPACING_CALIBRATED',e=>{
    calibrationObservation.events.push({image:e.detail?.imageId,scale:e.detail?.scale});
  },true);
  const seen=new Map();
  setInterval(()=>{
    const annotations=window.cornerstoneTools?.annotation.state.getAllAnnotations()||[];
    for(const a of annotations.filter(a=>['Length','Angle','EllipticalROI'].includes(a.metadata.toolName))){
      const pair=[key(a.data),key(a.data.cachedStats)], old=seen.get(a.annotationUID);
      if(old && old[0]===pair[0] && old[1]!==pair[1]) calibrationObservation.replacements.push({uid:a.annotationUID,old,pair});
      seen.set(a.annotationUID,pair);calibrationObservation.samples++;
    }
  },25);
})();'''


class MeasurementCalibrationE2E(MeasurementPanelE2E):
    def test_calibration_natural_ct_navigation_and_reopen(self):
        f = self.specimen(slices=3)
        w = self.login('doctor'); self.addCleanup(w.close)
        p = w.context.new_page(); self.addCleanup(p.close)
        p.add_init_script(OBSERVER)
        url = self.stack.proxy+'/ohif/viewer?StudyInstanceUIDs='+f.uid
        observations = []
        for opening in ['open', 'reopen']:
            p.goto(url); canvas_ready(p,1)
            expect(p.locator('#kin-viewer-history [role=status]')).to_contain_text('개 저장 항목')
            row = self.draw_length(p)
            points=p.evaluate("()=>cornerstoneTools.annotation.state.getAllAnnotations().filter(a=>a.metadata.toolName==='Length').at(-1).data.handles.points")
            expect(p.locator('svg.svg-layer')).to_contain_text('mm')
            p.wait_for_function('()=>calibrationObservation.samples>5')
            # Real native stack navigation preserves the current unsaved mark.
            p.evaluate('''async()=>{const v=cornerstone.getEnabledElements()[0].viewport;
              const start=v.getCurrentImageIdIndex(); await v.setImageIdIndex((start+1)%v.getImageIds().length);await v.setImageIdIndex(start);}''')
            expect(p.locator('svg.svg-layer')).to_contain_text('mm')
            # The old SVG label can survive navigation while the native cache
            # is still invalidated. Wait for the referenced frame's actual
            # calculation, just as draw_length does before the first save.
            p.wait_for_function('''()=>{
              const v=cornerstone.getEnabledElements()[0].viewport;
              const a=cornerstoneTools.annotation.state.getAllAnnotations().filter(a=>a.metadata.toolName==='Length').at(-1);
              const s=a?.data.cachedStats?.['imageId:'+a.metadata.referencedImageId];
              return a && !a.invalidated && v.getCurrentImageId()===a.metadata.referencedImageId && Number.isFinite(s?.length);
            }''')
            row.get_by_role('button',name='Save',exact=True).click()
            expect(row).to_contain_text('저장 완료')
            current = p.evaluate('()=>calibrationObservation')
            current['opening']=opening; observations.append(current)
            expect(p.locator('svg.svg-layer')).not_to_contain_text('재확인 필요')
            saved=next(h for h in self.saved(f) if h['id']==row.get_attribute('data-item-id'))
            self.assertEqual(saved['item']['points'],points, 'Natural cache replacement, if observed, must retain and save the current geometry')
        dest=Path(__file__).parent/'artifacts/measurement-ci'; dest.mkdir(parents=True,exist_ok=True)
        (dest/'calibration-observation.json').write_text(json.dumps(observations,ensure_ascii=False,indent=2),encoding='utf-8')
        print('A5 natural CT observation: '+json.dumps(observations,ensure_ascii=False))

    def test_calibration_native_cache_replacement_recovers_unsaved_measurement(self):
        f=self.specimen(); p=self.observed(f); row,panel=self.tracked(p)
        before=p.evaluate('()=>panelAnnotation.data.handles.points')
        # Separate robustness probe: explicitly invoke the pinned handler.
        # This is not evidence that navigation naturally replaced this cache.
        p.evaluate('''()=>{
          const v=cornerstone.getEnabledElements()[0].viewport;
          const tool=cornerstoneTools.ToolGroupManager.getToolGroupForViewport(v.id,v.renderingEngineId).getToolInstance('Length');
          calibrationOldData=panelAnnotation.data;calibrationOldStats=panelAnnotation.data.cachedStats;
          tool.onImageSpacingCalibrated({detail:{element:v.element,imageId:v.getCurrentImageId()}});
          if(panelAnnotation.data!==calibrationOldData || panelAnnotation.data.cachedStats===calibrationOldStats)throw Error('Pinned handler did not replace only the cache');
        }''')
        expect(panel).to_contain_text('mm'); expect(panel).not_to_contain_text('재확인 필요')
        p.wait_for_function('()=>panelAnnotation.data===calibrationOldData && !panelAnnotation.invalidated && panelCaptured[0].getReport().values[0]!=="재확인 필요"')
        row.get_by_role('button',name='Save',exact=True).click();expect(row).to_contain_text('저장 완료')
        self.assertEqual(self.saved(f)[0]['item']['points'],before)

    def test_calibration_lets_length_measure_an_image_without_pixel_spacing(self):
        """The pinned Calibration tool on an image without pixel spacing: before it Length is refused with the reason over
        the cell; after it Length is drawn in the calibrated mm, marked as a screen calibration that is not saved, and
        becomes no row, no saved item and no unsaved work."""
        f = synthetic_cr_without_spacing(self.stack, 'CALCR-' + uuid.uuid4().hex[:12], 'calcr', '20260908')
        w = self.login('doctor'); self.addCleanup(w.close)
        p = w.context.new_page(); self.addCleanup(p.close)
        p.goto(self.stack.proxy + '/ohif/viewer?StudyInstanceUIDs=' + f.uid); canvas_ready(p, 1)
        expect(p.locator('#kin-viewer-history [role=status]')).to_contain_text('개 저장 항목')
        lengths = "()=>cornerstoneTools.annotation.state.getAllAnnotations().filter(a=>a.metadata.toolName==='Length').length"
        self.open_measurement_tools(p)
        self.choose(p, 'Length')
        box = p.locator('.cornerstone-canvas').bounding_box()
        x, y = box['x'] + box['width'] * .3, box['y'] + box['height'] * .35
        self.drag(p, x, y, 120, 0)
        expect(p.locator('[data-kin-cell-note]')).to_have_text(NO_SPACING)
        expect(p.locator('#kin-viewer-history [role=status]')).to_have_text(NO_SPACING)
        self.assertEqual(0, p.evaluate(lengths))
        # Calibration: a line over a known distance, given in mm in the tool's own dialog.
        p.evaluate("()=>document.querySelector('[aria-label=Calibration]').click()")
        self.drag(p, x, y + 60, 120, 0)
        field = p.locator('input[type=text]:visible').first
        expect(field).to_be_visible(); field.fill('30'); field.press('Enter')
        p.wait_for_function('''()=>{const v=cornerstone.getEnabledElements()[0].viewport, id=v.getCurrentImageId();
          return !!(cornerstone.metaData.get('calibratedPixelSpacing', id)?.type || cornerstone.cache.getImage(id)?.calibration?.type);}''')
        seen = p.evaluate('''()=>{const v=cornerstone.getEnabledElements()[0].viewport, id=v.getCurrentImageId();
          return {meta: cornerstone.metaData.get('calibratedPixelSpacing', id) || null, cache: cornerstone.cache.getImage(id)?.calibration || null};}''')
        print('Screen calibration as the pinned viewer keeps it: ' + json.dumps(seen, ensure_ascii=False))
        # Length again, the same screen length as the calibration line: about 30 mm, marked as not saved.
        self.choose(p, 'Length')
        self.drag(p, x, y + 120, 120, 0)
        p.wait_for_function("()=>cornerstoneTools.annotation.state.getAllAnnotations().some(a=>a.metadata.toolName==='Length')")
        expect(p.locator('svg.svg-layer')).to_contain_text(SCREEN)
        # The Length's own text box (the calibration line keeps its own text beside it).
        text = p.evaluate("label=>[...document.querySelectorAll('svg.svg-layer text')].map(t=>t.textContent).find(t=>t.includes(label))", SCREEN)
        value = float(re.search(r'(\d+(?:\.\d+)?) mm', text).group(1))
        self.assertTrue(27 <= value <= 33, text)
        state = self.settled(p)
        self.assertEqual([], state['rows'])
        self.assertFalse(state['unsaved'])
        self.assertEqual([], self.saved(f))

    def test_calibration_projection_without_orientation_measures_with_original_spacing(self):
        """Projection X-rays (CR, DX, RF, XA) without ImagePositionPatient / ImageOrientationPatient but with a pixel size:
        Length and Angle give mm and degrees with the original's spacing and basis words — the viewer's own value for the
        same points — and the Length is saved as a verified measurement. No screen calibration is involved or offered."""
        for modality, sop_class, tags, spacing, basis in PROJECTIONS:
            with self.subTest(modality=modality):
                frames = 2 if modality == 'XA' else 1
                f = synthetic_projection(self.stack, 'PROJ-' + uuid.uuid4().hex[:12], modality.lower() + uuid.uuid4().hex[:6],
                                         '20260908', modality, sop_class, tags, frames)
                w = self.login('doctor'); self.addCleanup(w.close)
                p = w.context.new_page(); self.addCleanup(p.close)
                p.goto(self.stack.proxy + '/ohif/viewer?StudyInstanceUIDs=' + f.uid); canvas_ready(p, 1)
                expect(p.locator('#kin-viewer-history [role=status]')).to_contain_text('개 저장 항목')
                row = self.draw_length(p)
                p.wait_for_timeout(350)  # the pinned native calculator's trailing throttle
                native = p.evaluate(NATIVE, 'Length')
                # The viewer places an image without a position or orientation with rows along [0,1,0], columns along [0,0,-1]
                # and its origin at [0,0,0] — [0,0,frame] for a multi-frame image (here frame 1); the mark lies in that plane.
                origin = [0, 0, 1] if frames > 1 else [0, 0, 0]
                self.assertEqual([native['row'], native['column'], native['origin']], [[0, 1, 0], [0, 0, -1], origin], native)
                text = p.evaluate(SVG_TEXT)
                self.assertNotIn('원본 프레임의 좌표·간격·보정을 확인할 수 없습니다', text)
                self.assertTrue(all(part in text for part in basis.split(' · ')), (basis, text))  # drawn as two lines
                self.assertNotIn(SCREEN, text)
                shown = float(re.search(r'(\d+(?:\.\d+)?) mm', text).group(1))
                # The image pixel offsets of the two points in that plane (columns along y, rows along -z), times the
                # original's spacing — computed here, not by the product's geometry.
                (a, b) = native['points']
                dx, dy = (b[1] - a[1]) / spacing[1], -(b[2] - a[2]) / spacing[0]
                expected = math.hypot(dx * spacing[1], dy * spacing[0])
                self.assertGreater(expected, 1)
                self.assertLess(abs(shown - expected), .051, (text, expected, native))
                self.assertLess(abs(native['value'] - expected), 1e-3, (expected, native))
                row.get_by_role('button', name='Save', exact=True).click()
                expect(row).to_contain_text('저장 완료')
                saved = self.saved(f)
                self.assertEqual(1, len(saved))
                self.assertEqual('verified', saved[0]['referenceStatus'])
                self.assertTrue(saved[0]['item']['baseline']['calculator'].startswith('kin-planar-manual-v1:'), saved[0])
                self.assertLess(abs(saved[0]['item']['baseline']['values'][0] - expected), 1e-6)
                # Angle on the same image: degrees, the viewer's own value.
                self.choose(p, 'Angle')
                box = p.locator('.cornerstone-canvas').bounding_box()
                x, y = box['x'] + box['width'] * .35, box['y'] + box['height'] * .62
                p.mouse.move(x, y); p.mouse.down(); p.mouse.move(x + 70, y + 30, steps=10); p.mouse.up()
                p.mouse.move(x + 90, y - 20, steps=8); p.mouse.click(x + 90, y - 20)
                p.wait_for_timeout(350)
                p.wait_for_function('''()=>cornerstoneTools.annotation.state.getAllAnnotations().some(a=>a.metadata.toolName==='Angle' &&
                    !a.invalidated && Object.values(a.data.cachedStats||{}).some(s=>Number.isFinite(s.angle)))''')
                angle = p.evaluate(NATIVE, 'Angle')
                vertex = angle['points'][1]
                u, v = ([q[1] - vertex[1], -(q[2] - vertex[2])] for q in (angle['points'][0], angle['points'][2]))
                expected = math.degrees(math.acos(max(-1, min(1, (u[0] * v[0] + u[1] * v[1]) / math.hypot(*u) / math.hypot(*v)))))
                expect(p.locator('#kin-viewer-history section[data-kind=angle]')).to_have_count(1)
                try:
                    p.wait_for_function(SVG_TEXT.replace(".join(' ')", ".join(' ').includes('°')"), timeout=15000)
                except Exception:
                    self.fail('No degrees drawn: ' + p.evaluate(SVG_TEXT) + ' | ' + p.locator('#kin-viewer-history [role=status]').inner_text())
                text = p.evaluate(SVG_TEXT)
                self.assertNotIn('원본 프레임의 좌표·간격·보정을 확인할 수 없습니다', text)
                shown = float(re.search(r'(\d+(?:\.\d+)?) ?°', text).group(1))
                self.assertLess(abs(shown - expected), .051, (text, expected, angle))
                self.assertLess(abs(angle['value'] - expected), 1e-3, (expected, angle))
                box = p.locator('.cornerstone-canvas').bounding_box()
                if frames > 1:
                    # The second frame of the run: its own origin [0,0,2] in the viewer, measured and saved on that frame.
                    p.evaluate("async()=>{const v=cornerstone.getEnabledElements()[0].viewport;await v.setImageIdIndex(1);}")
                    self.choose(p, 'Length')
                    self.drag(p, box['x'] + box['width'] * .3, box['y'] + box['height'] * .25, 80, 20)
                    p.wait_for_timeout(350)
                    p.wait_for_function('''()=>{const v=cornerstone.getEnabledElements()[0].viewport;
                      return cornerstoneTools.annotation.state.getAllAnnotations().some(a=>a.metadata.toolName==='Length' &&
                        a.metadata.referencedImageId===v.getCurrentImageId() && !a.invalidated &&
                        Object.values(a.data.cachedStats||{}).some(s=>Number.isFinite(s.length)))}''')
                    second = p.evaluate(NATIVE, 'Length')
                    self.assertEqual(second['origin'], [0, 0, 2], second)
                    self.assertIn('/frames/2', second['image'])
                    (a, b) = second['points']
                    expected = math.hypot(b[1] - a[1], b[2] - a[2])
                    text = p.evaluate(SVG_TEXT)
                    self.assertTrue(all(part in text for part in basis.split(' · ')), (basis, text))  # drawn as two lines
                    shown = float(re.search(r'(\d+(?:\.\d+)?) mm', text).group(1))
                    self.assertLess(abs(shown - expected), .051, (text, expected, second))
                    rows = p.locator('#kin-viewer-history section[data-kind=length]')
                    rows.last.get_by_role('button', name='Save', exact=True).click()
                    expect(rows.last).to_contain_text('저장 완료')
                    saved = self.saved(f)
                    self.assertEqual(2, len(saved))
                    self.assertEqual([1, 2], sorted(s['item']['frame'] for s in saved))
                    self.assertTrue(all(s['referenceStatus'] == 'verified' for s in saved), saved)
                if modality == 'DX':
                    # A screen calibration over an image with spacing of its own gives no value in the original's basis.
                    p.evaluate("()=>document.querySelector('[aria-label=Calibration]').click()")
                    self.drag(p, box['x'] + box['width'] * .3, box['y'] + box['height'] * .2, 120, 0)
                    field = p.locator('input[type=text]:visible').first
                    expect(field).to_be_visible(); field.fill('30'); field.press('Enter')
                    p.wait_for_function('''()=>{const v=cornerstone.getEnabledElements()[0].viewport, id=v.getCurrentImageId();
                      return !!(cornerstone.metaData.get('calibratedPixelSpacing', id)?.type || cornerstone.cache.getImage(id)?.calibration?.type);}''')
                    self.choose(p, 'Length')
                    self.drag(p, box['x'] + box['width'] * .3, box['y'] + box['height'] * .8, 120, 0)
                    expect(p.locator('#kin-viewer-history [role=status]')).to_contain_text('표시 간격과 원본 간격이 일치하지 않습니다')
                    p.wait_for_timeout(600)
                    self.assertEqual(1, len(self.saved(f)))
                p.close(); w.close()


if __name__ == '__main__':
    sys.stdout.reconfigure(encoding='utf-8',errors='replace')
    suite=unittest.TestSuite(MeasurementCalibrationE2E(n) for n in unittest.defaultTestLoader.getTestCaseNames(MeasurementCalibrationE2E) if n.startswith('test_calibration_'))
    sys.exit(not unittest.TextTestRunner(verbosity=2).run(suite).wasSuccessful())
