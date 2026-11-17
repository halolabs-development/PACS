# coding: utf-8
"""D-MEASURE2 A5: observe natural pinned classic CT calibration, no event injection."""
import json, re, sys, time, unittest, uuid
from pathlib import Path
import numpy as np
from pydicom.dataset import FileDataset, FileMetaDataset
from pydicom.uid import ComputedRadiographyImageStorage, ExplicitVRLittleEndian, generate_uid
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
        text = p.locator('svg.svg-layer').inner_text()
        value = float(re.search(r'(\d+(?:\.\d+)?) mm', text).group(1))
        self.assertTrue(27 <= value <= 33, text)
        state = self.settled(p)
        self.assertEqual([], state['rows'])
        self.assertFalse(state['unsaved'])
        self.assertEqual([], self.saved(f))


if __name__ == '__main__':
    sys.stdout.reconfigure(encoding='utf-8',errors='replace')
    suite=unittest.TestSuite(MeasurementCalibrationE2E(n) for n in unittest.defaultTestLoader.getTestCaseNames(MeasurementCalibrationE2E) if n.startswith('test_calibration_'))
    sys.exit(not unittest.TextTestRunner(verbosity=2).run(suite).wasSuccessful())
