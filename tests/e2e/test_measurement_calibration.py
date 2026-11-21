# coding: utf-8
"""D-MEASURE2 A5: observe natural pinned classic CT calibration, no event injection."""
import json, math, re, sys, time, unittest, uuid
from pathlib import Path
import numpy as np
from pydicom.dataset import Dataset, FileDataset, FileMetaDataset
from pydicom.sequence import Sequence
from pydicom.uid import (ComputedRadiographyImageStorage, DigitalXRayImageStorageForPresentation, ExplicitVRLittleEndian,
                         UltrasoundImageStorage, UltrasoundMultiFrameImageStorage, XRayAngiographicImageStorage,
                         XRayRadiofluoroscopicImageStorage, generate_uid)
from pynetdicom import AE
from invariants_live import Fixture
from test_measurement_panel import MeasurementPanelE2E, expect
from viewer_precision_support import canvas_ready
from viewer_tools import displayed_image_box, select_image_tool

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

US_LEFT, US_RIGHT = (.02, .03), (.05, .04)  # PhysicalDeltaX, PhysicalDeltaY in cm of the two regions below.
US_BASIS = 'US Region Calibration'
US_OUTSIDE = '초음파 보정 영역 안에서만 mm로 잴 수 있습니다'


def us_region(x0, x1, delta):
    """A 2D tissue Region Calibration (DICOM PS3.3 C.8.5.5) over columns x0..x1 of all 256 rows, in cm; no deltas if None."""
    region = Dataset()
    region.RegionSpatialFormat, region.RegionDataType, region.RegionFlags = 1, 1, 0
    region.RegionLocationMinX0, region.RegionLocationMinY0, region.RegionLocationMaxX1, region.RegionLocationMaxY1 = x0, 0, x1, 255
    region.PhysicalUnitsXDirection = region.PhysicalUnitsYDirection = 3
    if delta is not None:
        region.PhysicalDeltaX, region.PhysicalDeltaY = delta
    return region


def synthetic_us(stack, patient, label, date, regions, frames=1):
    """An ultrasound image as devices send it: no PixelSpacing, position or orientation, a Sequence of Ultrasound Regions.
    Synthetic tags and pixels, not a device file; frames > 1 is an Ultrasound Multi-frame image (a cine)."""
    sop_class = UltrasoundMultiFrameImageStorage if frames > 1 else UltrasoundImageStorage
    uid, series, sop = generate_uid(), generate_uid(), generate_uid()
    fixture = Fixture(uid, patient, "한림병원", "jmryu", "US-SYNTHETIC-" + label)
    stack.active[uid] = fixture
    ae = AE(ae_title="HALLYM_CT")
    ae.add_requested_context(sop_class, ExplicitVRLittleEndian)
    assoc = ae.associate("127.0.0.1", 4242, ae_title="KINLAB")
    if not assoc.is_established:
        raise RuntimeError("Local synthetic US association failed")
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
        ds.PatientName, ds.PatientID = "US^SYNTHETIC", patient
        ds.PatientBirthDate, ds.PatientSex, ds.InstitutionName = "", "O", "한림병원"
        ds.StudyInstanceUID, ds.SeriesInstanceUID = uid, series
        ds.StudyDate = ds.SeriesDate = date
        ds.StudyTime = ds.SeriesTime = "120000"
        ds.AccessionNumber, ds.StudyID = "US" + label[:14], "US"
        ds.StudyDescription = ds.SeriesDescription = "US " + label
        ds.Modality, ds.BodyPartExamined, ds.SeriesNumber, ds.InstanceNumber = "US", "ABDOMEN", 1, 1
        ds.ImageType = ["ORIGINAL", "PRIMARY"]
        ds.Rows, ds.Columns = 256, 320
        ds.SamplesPerPixel, ds.PhotometricInterpretation = 1, "MONOCHROME2"
        ds.BitsAllocated = ds.BitsStored = 16
        ds.HighBit, ds.PixelRepresentation = 15, 0
        ds.WindowCenter, ds.WindowWidth = 500, 1000
        ds.SequenceOfUltrasoundRegions = Sequence(regions)
        pixels = np.full((frames, 256, 320), 200, dtype=np.uint16)
        pixels[:, 40:216, 30:130] = 600
        pixels[:, 40:216, 190:290] = 800
        if frames > 1:
            ds.NumberOfFrames, ds.FrameIncrementPointer = frames, (0x0018, 0x1063)
            ds.FrameTime = 100
        ds.PixelData = pixels.astype("<u2").tobytes()
        status = assoc.send_c_store(ds)
        if status is None or status.Status != 0:
            raise RuntimeError("Synthetic US C-STORE failed")
    finally:
        assoc.release()
    deadline = time.monotonic() + 30
    while time.monotonic() < deadline:
        result = stack.request("GET", "/studies", "jmryu")
        if result.status == 200 and any(s.get("uid") == uid for s in result.body.get("studies", [])):
            break
        time.sleep(.25)
    else:
        raise RuntimeError("Synthetic US did not reach the real API")
    if stack.request("PATCH", "/studies/" + uid, "jmryu", {"ss": "Verified"}).status != 200:
        raise RuntimeError("Synthetic US verification failed")
    return fixture


# The canvas position of image pixel (x, y) of an ultrasound frame whose origin is [0, 0, z0], and of a world point.
US_CANVAS = '''([x,y,z0])=>{const v=cornerstone.getEnabledElements()[0].viewport, [cx,cy]=v.worldToCanvas([0,x,z0-y]), r=v.canvas.getBoundingClientRect();
  return [r.left+cx, r.top+cy];}'''
WORLD_CANVAS = '''w=>{const v=cornerstone.getEnabledElements()[0].viewport, [cx,cy]=v.worldToCanvas(w), r=v.canvas.getBoundingClientRect(); return [r.left+cx, r.top+cy];}'''
LAST_LENGTH = "()=>cornerstoneTools.annotation.state.getAllAnnotations().filter(a=>a.metadata.toolName==='Length').at(-1).data.handles.points"


def us_length(points, delta, z0=0):
    """Hand computation: the image pixel offsets of the two points (columns along y, rows along -z) times the deltas in mm."""
    (a, b) = points
    return math.hypot((b[1] - a[1]) * delta[0] * 10, (-(b[2] - z0) + (a[2] - z0)) * delta[1] * 10)

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
                frames = 1
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
                # and its origin at [0,0,0]; the mark lies in that plane.
                self.assertEqual([native['row'], native['column'], native['origin']], [[0, 1, 0], [0, 0, -1], [0, 0, 0]], native)
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
                # Around the canvas centre, where the fitted image always is: a fraction of the canvas width falls beside a
                # narrow image in a wide cell, and a point off the image is refused (planar-geometry.js).
                x, y = box['x'] + box['width'] / 2 - 45, box['y'] + box['height'] / 2 - 5
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
                # The places below are fractions of the image as drawn (a fraction of the canvas falls beside a narrow
                # image in a wide cell, and a line off the image is refused).
                box = displayed_image_box(p)
                if modality == 'CR':
                    unconfirmed = '화면에 그려진 영상을 확인할 수 없어 이 점으로 재지 않습니다'
                    # Drawn with a spacing other than its own (a stack keeps the previous image's spacing when the next one
                    # differs by less than the viewer's tolerance): a press gives no value. The display data only.
                    p.evaluate('''()=>{const v=cornerstone.getEnabledElements()[0].viewport, own=v.getImageData.bind(v);
                      window.kinTestImageData=own; v.getImageData=(...a)=>{const d=own(...a); return d && {...d, spacing:[d.spacing[0]*(1+1e-6), d.spacing[1], d.spacing[2]]};};}''')
                    self.choose(p, 'Length')
                    self.drag(p, box['x'] + box['width'] * .3, box['y'] + box['height'] * .8, 120, 0)
                    expect(p.locator('#kin-viewer-history [role=status]')).to_contain_text(unconfirmed)
                    p.evaluate("()=>{const v=cornerstone.getEnabledElements()[0].viewport; v.getImageData=window.kinTestImageData; delete window.kinTestImageData;}")
                    # The cell's last finished render is not this image (its pixels still change): a press gives no value.
                    p.evaluate('''()=>{const bar=window.KinViewerInfoBar, own=bar.identity; window.kinTestIdentity=own;
                      bar.identity=(...a)=>({...own(...a), instance:null});}''')
                    self.choose(p, 'Length')
                    self.drag(p, box['x'] + box['width'] * .3, box['y'] + box['height'] * .8, 120, 0)
                    expect(p.locator('#kin-viewer-history [role=status]')).to_contain_text(unconfirmed)
                    p.evaluate("()=>{window.KinViewerInfoBar.identity=window.kinTestIdentity; delete window.kinTestIdentity;}")
                    self.assertEqual(1, len(self.saved(f)))
                    # A point moved while that cannot be confirmed: the moved mark gives no value and is not saved.
                    self.choose(p, 'Length')
                    self.drag(p, box['x'] + box['width'] * .25, box['y'] + box['height'] * .85, 100, 0)
                    p.wait_for_timeout(350)
                    p.wait_for_function('''()=>cornerstoneTools.annotation.state.getAllAnnotations().filter(a=>a.metadata.toolName==='Length').length>=2''')
                    expect(p.locator('svg.svg-layer')).not_to_contain_text(unconfirmed)
                    end = p.evaluate('''()=>{const v=cornerstone.getEnabledElements()[0].viewport, a=cornerstoneTools.annotation.state.getAllAnnotations().filter(a=>a.metadata.toolName==='Length').at(-1);
                      const [x,y]=v.worldToCanvas(a.data.handles.points[1]), r=v.canvas.getBoundingClientRect(); return [r.left+x, r.top+y];}''')
                    p.evaluate('''()=>{const bar=window.KinViewerInfoBar, own=bar.identity; window.kinTestIdentity=own;
                      bar.identity=(...a)=>({...own(...a), instance:null});}''')
                    p.mouse.move(end[0], end[1]); p.mouse.down(); p.mouse.move(end[0] + 25, end[1] + 10, steps=8); p.mouse.up()
                    p.evaluate("()=>{window.KinViewerInfoBar.identity=window.kinTestIdentity; delete window.kinTestIdentity;}")
                    expect(p.locator('svg.svg-layer')).to_contain_text(unconfirmed)
                    rows = p.locator('#kin-viewer-history section[data-kind=length]')
                    rows.last.get_by_role('button', name='Save', exact=True).click()
                    p.wait_for_timeout(600)
                    self.assertEqual(1, len(self.saved(f)))
                if modality == 'DX':
                    # A screen calibration over an image with spacing of its own gives no value in the original's basis.
                    # A real toolbar press also dismisses the series-tracking prompt covering the top of the image.
                    select_image_tool(p, 'Calibration')
                    x = box['x'] + box['width'] * .3
                    dx = box['width'] * .3
                    self.drag(p, x, box['y'] + box['height'] * .2, dx, 0)
                    field = p.locator('input[type=text]:visible').first
                    expect(field).to_be_visible(); field.fill('30'); field.press('Enter')
                    p.wait_for_function('''()=>{const v=cornerstone.getEnabledElements()[0].viewport, id=v.getCurrentImageId();
                      return !!(cornerstone.metaData.get('calibratedPixelSpacing', id)?.type || cornerstone.cache.getImage(id)?.calibration?.type);}''')
                    self.choose(p, 'Length')
                    self.drag(p, x, box['y'] + box['height'] * .8, dx, 0)
                    expect(p.locator('#kin-viewer-history [role=status]')).to_contain_text('표시 간격과 원본 간격이 일치하지 않습니다')
                    p.wait_for_timeout(600)
                    self.assertEqual(1, len(self.saved(f)))
                p.close(); w.close()

    def test_calibration_projection_multiframe_run_keeps_its_rules(self):
        """A multi-frame XA run without position or orientation is outside the projection list: as before, the Length line
        is drawn but gives no value, and nothing is saved."""
        f = synthetic_projection(self.stack, 'PROJ-' + uuid.uuid4().hex[:12], 'xarun' + uuid.uuid4().hex[:6], '20260908', 'XA',
                                 XRayAngiographicImageStorage, dict(ImagerPixelSpacing=[.2, .4]), 2)
        w = self.login('doctor'); self.addCleanup(w.close)
        p = w.context.new_page(); self.addCleanup(p.close)
        p.goto(self.stack.proxy + '/ohif/viewer?StudyInstanceUIDs=' + f.uid); canvas_ready(p, 1)
        expect(p.locator('#kin-viewer-history [role=status]')).to_contain_text('개 저장 항목')
        self.open_measurement_tools(p)
        self.choose(p, 'Length')
        box = p.locator('.cornerstone-canvas').bounding_box()
        self.drag(p, box['x'] + box['width'] * .4, box['y'] + box['height'] * .4, 65, 32)
        expect(p.locator('svg.svg-layer')).to_contain_text('원본 프레임의 좌표·간격·보정을 확인할 수 없습니다')
        self.assertNotIn(' mm', p.evaluate(SVG_TEXT))
        self.assertEqual([], self.saved(f))

    def us_viewer(self, f):
        w = self.login('doctor'); self.addCleanup(w.close)
        p = w.context.new_page(); self.addCleanup(p.close)
        p.goto(self.stack.proxy + '/ohif/viewer?StudyInstanceUIDs=' + f.uid); canvas_ready(p, 1)
        expect(p.locator('#kin-viewer-history [role=status]')).to_contain_text('개 저장 항목')
        self.open_measurement_tools(p)
        return w, p

    def us_line(self, p, start, end, z0=0):
        """A Length pulled with the mouse from image pixel start to end (x, y) of the shown ultrasound frame."""
        self.choose(p, 'Length')
        a, b = (p.evaluate(US_CANVAS, [x, y, z0]) for x, y in (start, end))
        p.mouse.move(*a); p.mouse.down(); p.mouse.move(*b, steps=10); p.mouse.up()

    def us_text(self, p, want):
        try:
            p.wait_for_function("want=>[...document.querySelectorAll('svg.svg-layer text')].map(t=>t.textContent).join(' ').includes(want)", arg=want, timeout=15000)
        except Exception:
            self.fail('Not drawn: ' + want + ' | ' + p.evaluate(SVG_TEXT) + ' | ' + p.locator('#kin-viewer-history [role=status]').inner_text())
        return p.evaluate(SVG_TEXT)

    def move_handle(self, p, index, to, z0=0):
        """The Length's handle index dragged with the mouse to image pixel `to`."""
        here = p.evaluate(WORLD_CANVAS, p.evaluate(LAST_LENGTH)[index])
        there = p.evaluate(US_CANVAS, [to[0], to[1], z0])
        p.mouse.move(*here); p.mouse.down(); p.mouse.move(*there, steps=8); p.mouse.up()

    def test_calibration_ultrasound_region_length_uses_its_deltas_saves_edits_and_reopens(self):
        """An ultrasound image without spacing, position or orientation and with two Region Calibrations: a Length inside
        the left region is drawn in mm with that region's deltas and its basis, saved as a verified measurement and read
        back the same; moved so that it crosses into the right region it says why it has no value and makes no revision;
        moved wholly into the right region it is measured with that region's deltas and saved as r2, and a new viewer shows it."""
        f = synthetic_us(self.stack, 'USREG-' + uuid.uuid4().hex[:12], 'usreg' + uuid.uuid4().hex[:6], '20261121',
                         [us_region(0, 159, US_LEFT), us_region(160, 319, US_RIGHT)])
        w, p = self.us_viewer(f)
        self.us_line(p, (40, 60), (120, 180))
        p.wait_for_function('''()=>cornerstoneTools.annotation.state.getAllAnnotations().some(a=>a.metadata.toolName==='Length' &&
            !a.invalidated && Object.values(a.data.cachedStats||{}).some(s=>Number.isFinite(s.length)))''')
        p.wait_for_timeout(350)  # the pinned native calculator's trailing throttle
        native = p.evaluate(NATIVE, 'Length')
        # The viewer places it with rows along [0,1,0], columns along [0,0,-1], origin [0,0,0], display spacing 1.
        self.assertEqual([native['row'], native['column'], native['origin']], [[0, 1, 0], [0, 0, -1], [0, 0, 0]], native)
        expected = us_length(native['points'], US_LEFT)
        self.assertGreater(expected, 10)
        text = self.us_text(p, US_BASIS)
        self.assertNotIn('원본 프레임의 좌표·간격·보정을 확인할 수 없습니다', text)
        self.assertNotIn(SCREEN, text)
        self.assertLess(abs(float(re.search(r'(\d+(?:\.\d+)?) mm', text).group(1)) - expected), .051, (text, expected, native))
        row = p.locator('#kin-viewer-history section[data-kind=length]').last
        row.get_by_role('button', name='Save', exact=True).click()
        expect(row).to_contain_text('저장 완료')
        saved = self.saved(f)
        self.assertEqual(1, len(saved))
        self.assertEqual('verified', saved[0]['referenceStatus'])
        self.assertEqual(('kin-planar-manual-v1:us', 1), (saved[0]['item']['baseline']['calculator'], saved[0]['item']['frame']), saved[0])
        self.assertLess(abs(saved[0]['item']['baseline']['values'][0] - expected), 1e-6)
        # Edited: the end dragged into the right region — the line crosses the two, so no value and no new revision.
        row.get_by_role('button', name='Edit', exact=True).click()
        self.move_handle(p, 1, (240, 180))
        self.us_text(p, US_OUTSIDE)
        row.get_by_role('button', name='Save', exact=True).click()
        p.wait_for_timeout(800)
        self.assertEqual([1], [h['revision'] for h in self.saved(f)])
        # The start dragged into the right region too: measured with the right region's deltas, saved as r2.
        self.move_handle(p, 0, (200, 60))
        p.wait_for_timeout(350)
        text = self.us_text(p, US_BASIS)
        points = p.evaluate(LAST_LENGTH)
        moved = us_length(points, US_RIGHT)
        self.assertNotIn(US_OUTSIDE, text)
        self.assertLess(abs(float(re.search(r'(\d+(?:\.\d+)?) mm', text).group(1)) - moved), .051, (text, moved, points))
        row.get_by_role('button', name='Save', exact=True).click()
        expect(row).to_contain_text('Saved r2')
        head = self.saved(f)[0]
        self.assertEqual((2, 'verified'), (head['revision'], head['referenceStatus']))
        self.assertEqual(head['item']['points'], points)
        self.assertLess(abs(head['item']['baseline']['values'][0] - moved), 1e-6)
        # A new viewer: the saved Length is drawn with the same value and basis, nothing to re-check.
        p2 = w.context.new_page(); self.addCleanup(p2.close)
        p2.goto(self.stack.proxy + '/ohif/viewer?StudyInstanceUIDs=' + f.uid); canvas_ready(p2, 1)
        text = self.us_text(p2, US_BASIS)
        self.assertNotIn('재확인 필요', text)
        self.assertLess(abs(float(re.search(r'(\d+(?:\.\d+)?) mm', text).group(1)) - moved), .051, text)

    def test_calibration_ultrasound_cine_frame_and_regions_without_deltas(self):
        """Frame 2 of an ultrasound cine without a position (the viewer's origin [0,0,2]): the Length is measured with the
        region's deltas and saved on frame 2. An ultrasound image whose region gives no deltas: Length is refused as before,
        with no mark and nothing saved."""
        f = synthetic_us(self.stack, 'USCINE-' + uuid.uuid4().hex[:12], 'uscine' + uuid.uuid4().hex[:6], '20261121',
                         [us_region(0, 319, US_LEFT)], frames=2)
        p = self.observed(f)
        p.evaluate("async()=>{await cornerstone.getEnabledElements()[0].viewport.setImageIdIndex(1);}")
        p.wait_for_function("()=>/\\/frames\\/2$/.test(cornerstone.getEnabledElements()[0].viewport.getCurrentImageId())")
        canvas_ready(p, 1)
        self.us_line(p, (40, 60), (200, 180), z0=2)
        p.wait_for_function('''()=>cornerstoneTools.annotation.state.getAllAnnotations().some(a=>a.metadata.toolName==='Length' &&
            !a.invalidated && Object.values(a.data.cachedStats||{}).some(s=>Number.isFinite(s.length)))''')
        p.wait_for_timeout(350)
        native = p.evaluate(NATIVE, 'Length')
        self.assertEqual(native['origin'], [0, 0, 2], native)
        expected = us_length(native['points'], US_LEFT, 2)
        text = self.us_text(p, US_BASIS)
        self.assertLess(abs(float(re.search(r'(\d+(?:\.\d+)?) mm', text).group(1)) - expected), .051, (text, expected, native))
        row = p.locator('#kin-viewer-history section[data-kind=length]').last
        row.get_by_role('button', name='Save', exact=True).click()
        expect(row).to_contain_text('저장 완료')
        saved = self.saved(f)
        self.assertEqual(('verified', 2, 'kin-planar-manual-v1:us'),
                         (saved[0]['referenceStatus'], saved[0]['item']['frame'], saved[0]['item']['baseline']['calculator']), saved[0])
        self.assertLess(abs(saved[0]['item']['baseline']['values'][0] - expected), 1e-6)
        # Stored as an SR and opened again: the SR cell shows the cine at frame 2, where its Length is drawn.
        p.get_by_role('button', name='Store SR', exact=True).click()
        expect(p.locator('#kin-viewer-history [role=status]')).to_contain_text('SR 저장 완료', timeout=30000)
        p.wait_for_function("()=>__d05c1.services.displaySetService.getActiveDisplaySets().some(d=>d.Modality==='SR')", timeout=30000)
        p.evaluate('''()=>{const s=__d05c1.services;window.sourceDS=s.displaySetService.getActiveDisplaySets().find(d=>d.Modality==='SR');
            s.viewportGridService.setDisplaySetsForViewport({viewportId:s.viewportGridService.getActiveViewportId(),displaySetInstanceUIDs:[sourceDS.displaySetInstanceUID]});}''')
        p.wait_for_function('()=>sourceDS.isLoaded && cornerstoneTools.annotation.state.getAllAnnotations().some(a=>a.metadata.toolName==="DICOMSRDisplay")', timeout=30000)
        try:
            p.wait_for_function('''()=>{const s=__d05c1.services, v=s.cornerstoneViewportService.getCornerstoneViewport(s.viewportGridService.getActiveViewportId());
                return /\\/frames\\/2$/.test(v?.getCurrentImageId?.()||'');}''', timeout=15000)
        except Exception:
            self.fail('The SR cell is not on frame 2: ' + str(p.evaluate('''()=>{const s=__d05c1.services, v=s.cornerstoneViewportService.getCornerstoneViewport(s.viewportGridService.getActiveViewportId());
                return [v?.getCurrentImageId?.(), (v?.getImageIds?.()||[]).slice(0,3), sourceDS.measurements.map(m=>m.imageId)];}''')))
        try:
            expect(p.locator('svg.svg-layer')).to_contain_text(' mm')
        except AssertionError:
            p.screenshot(path=str(Path(__file__).parent / 'artifacts/measurement-accuracy-ci/us-cine-sr-reopen.png'))
            self.fail('The SR mark is not drawn: ' + json.dumps(p.evaluate('''()=>{const s=__d05c1.services, v=s.cornerstoneViewportService.getCornerstoneViewport(s.viewportGridService.getActiveViewportId());
                const marks=cornerstoneTools.annotation.state.getAllAnnotations().filter(a=>a.metadata.toolName==='DICOMSRDisplay');
                return {viewport:{id:v?.id, type:v?.type, frameOfReference:v?.getFrameOfReferenceUID?.(), current:v?.getCurrentImageId?.(), actors:v?._actors?.size ?? null, index:v?.getCurrentImageIdIndex?.()},
                  marks:marks.map(a=>({frameOfReference:a.metadata.FrameOfReferenceUID, image:a.metadata.referencedImageId, visible:a.isVisible, tracking:a.data?.TrackingUniqueIdentifier})),
                  groups:Object.keys(cornerstoneTools.annotation.state.getAnnotationManager().getFramesOfReference?.()||{})};}''')))
        p.close()
        # A region without deltas: the rule it had.
        g = synthetic_us(self.stack, 'USNODELTA-' + uuid.uuid4().hex[:12], 'usnod' + uuid.uuid4().hex[:6], '20261121', [us_region(0, 319, None)])
        w, p = self.us_viewer(g)
        self.us_line(p, (40, 60), (200, 180))
        expect(p.locator('#kin-viewer-history [role=status]')).to_have_text('원본 프레임의 좌표·간격·보정을 확인할 수 없습니다')
        self.assertEqual(0, p.evaluate("()=>cornerstoneTools.annotation.state.getAllAnnotations().filter(a=>a.metadata.toolName==='Length').length"))
        self.assertEqual([], self.saved(g))


if __name__ == '__main__':
    sys.stdout.reconfigure(encoding='utf-8',errors='replace')
    suite=unittest.TestSuite(MeasurementCalibrationE2E(n) for n in unittest.defaultTestLoader.getTestCaseNames(MeasurementCalibrationE2E) if n.startswith('test_calibration_'))
    sys.exit(not unittest.TextTestRunner(verbosity=2).run(suite).wasSuccessful())
