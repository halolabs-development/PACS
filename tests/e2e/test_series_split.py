# coding: utf-8
"""FB-052: one MR series holding several b values or time points opens as one virtual series per group.

Runs only on the owned synthetic stack (dispatch profile series-split). The series are made here with pydicom from the
synthetic phantom's pixels; the pinned viewer's own 4D detection decides the groups, so this is the real path."""
import copy, io, json, unittest, uuid
from pathlib import Path
from pydicom import dcmread
from pydicom.dataset import Dataset
from pydicom.sequence import Sequence
from pydicom.uid import generate_uid, MRImageStorage, EnhancedMRImageStorage, ExplicitVRLittleEndian
from pynetdicom import AE
from playwright.sync_api import expect
from test_ct_sync import CTSyncE2E
from test_prior_selection import canvas_ready

THUMBS = '[draggable=true]:not(.kin-series-card)'


class SeriesSplitE2E(CTSyncE2E):
    def mr(self, groups, positions, tag, description, series_per_group=False):
        """Store MR images into a fresh synthetic study: `groups` values of `tag` at each of `positions` slices,
        all in one series (stored position by position), or one series per value."""
        f = self.ct('SPLIT-' + uuid.uuid4().hex[:12], 'current', '20260801')
        orth = next(x['ID'] for x in self.stack._orthanc_request('POST', '/tools/lookup', f.uid.encode()).body if x['Type'] == 'Study')
        originals = [dcmread(io.BytesIO(self.stack.orthanc_bytes('/instances/' + x['ID'] + '/file')))
                     for x in self.stack._orthanc_request('GET', '/studies/' + orth + '/instances').body]
        originals.sort(key=lambda d: float(d.ImagePositionPatient[2]))
        self.assertGreaterEqual(len(originals), positions)
        one = generate_uid()
        series = {value: (generate_uid() if series_per_group else one) for value in groups}
        frame = generate_uid()
        ae = AE(ae_title='HALLYM_MR'); ae.add_requested_context(MRImageStorage, ExplicitVRLittleEndian)
        assoc = ae.associate('127.0.0.1', 4242, ae_title='KINLAB'); self.assertTrue(assoc.is_established)
        try:
            number = 0
            for p, original in enumerate(originals[:positions]):
                for k, value in enumerate(groups):
                    number += 1
                    d = copy.deepcopy(original)
                    d.SOPClassUID = MRImageStorage; d.file_meta.MediaStorageSOPClassUID = MRImageStorage
                    d.SOPInstanceUID = generate_uid(); d.file_meta.MediaStorageSOPInstanceUID = d.SOPInstanceUID
                    d.Modality = 'MR'; d.SeriesInstanceUID = series[value]; d.FrameOfReferenceUID = frame
                    d.SeriesNumber = 7 + (k if series_per_group else 0); d.InstanceNumber = number
                    d.SeriesDescription = description + (f' {value}' if series_per_group else '')
                    for name in ('RescaleIntercept', 'RescaleSlope', 'RescaleType'):
                        if name in d: delattr(d, name)
                    d.WindowCenter, d.WindowWidth = 600, 1200
                    setattr(d, tag, value)
                    # Each group shows a different mark so a wrong image would be visible in the evidence.
                    pixels = original.pixel_array.copy(); pixels[20:30, 20:20 + 20 * (k + 1)] = 1400
                    d.PixelData = pixels.astype('<u2').tobytes()
                    self.assertEqual(assoc.send_c_store(d).Status, 0)
        finally:
            assoc.release()
        return f, sorted(set(series.values()), key=list(series.values()).index)

    def sets(self, p, series):
        return p.evaluate('''series=>services.displaySetService.getActiveDisplaySets().filter(d=>series.includes(d.SeriesInstanceUID))
          .map(d=>({description:d.SeriesDescription,count:d.images.length,series:d.SeriesInstanceUID,
            positions:d.images.map(i=>i.ImagePositionPatient&&i.ImagePositionPatient[2])}))''', series)

    def synchronized(self, p, first, second, name):
        self.grid(p, 2); self.drag(p, first, 0); self.drag(p, second, 1); canvas_ready(p, 2)
        self.toggle(p)
        self.jump(p, 0, 5)
        z = self.snapshot(p)[0]['position'][2]
        self.wait_z(p, 1, z)
        state = self.snapshot(p)
        self.assertEqual(state[1]['position'], state[0]['position'])
        self.assertNotEqual(state[0]['image'], state[1]['image'])
        print(name + ' positions ' + json.dumps(state), flush=True)
        p.screenshot(path=str(Path(__file__).parent / f'artifacts/SERIES-SPLIT-{name}.png'))

    def test_series_split_01_b_values_in_one_series(self):
        f, series = self.mr([0, 1000], 12, 'DiffusionBValue', 'AX DWI')
        originals = self.originals(); p = self.launch(self.login(), [f])
        p.wait_for_function('s=>services.displaySetService.getActiveDisplaySets().filter(d=>d.SeriesInstanceUID===s).length===2', arg=series[0], timeout=30000)
        found = self.sets(p, series)
        self.assertEqual([(s['description'], s['count']) for s in found], [('AX DWI · 1/2 b0', 12), ('AX DWI · 2/2 b1000', 12)])
        for s in found: self.assertEqual(len(set(s['positions'])), 12, 'one image per position in each set')
        expect(p.locator(THUMBS).filter(has_text='AX DWI')).to_have_count(2)
        expect(p.locator(THUMBS).filter(has_text='1/2 b0')).to_have_count(1)
        expect(p.locator(THUMBS).filter(has_text='2/2 b1000')).to_have_count(1)
        self.synchronized(p, '1/2 b0', '2/2 b1000', 'b-values')
        self.assertEqual(self.originals(), originals)

    def test_series_split_02_temporal_positions_in_one_series(self):
        f, series = self.mr([1, 2, 3], 10, 'TemporalPositionIdentifier', 'DYN T1')
        p = self.launch(self.login(), [f])
        p.wait_for_function('s=>services.displaySetService.getActiveDisplaySets().filter(d=>d.SeriesInstanceUID===s).length===3', arg=series[0], timeout=30000)
        self.assertEqual([(s['description'], s['count']) for s in self.sets(p, series)],
                         [('DYN T1 · 1/3 Phase 1', 10), ('DYN T1 · 2/3 Phase 2', 10), ('DYN T1 · 3/3 Phase 3', 10)])
        expect(p.locator(THUMBS).filter(has_text='DYN T1')).to_have_count(3)
        self.synchronized(p, '1/3 Phase 1', '3/3 Phase 3', 'phases')

    def test_series_split_03_series_that_arrived_apart_stay_as_they_are(self):
        f, series = self.mr([0, 1000], 12, 'DiffusionBValue', 'AX DWI', series_per_group=True)
        p = self.launch(self.login(), [f])
        p.wait_for_function('s=>services.displaySetService.getActiveDisplaySets().filter(d=>s.includes(d.SeriesInstanceUID)).length===2', arg=series, timeout=30000)
        self.assertEqual(sorted((s['description'], s['count']) for s in self.sets(p, series)), [('AX DWI 0', 12), ('AX DWI 1000', 12)])
        expect(p.locator(THUMBS).filter(has_text='AX DWI')).to_have_count(2)

    def enhanced(self, groups, positions, description):
        """Store one Enhanced MR Image Storage instance into a fresh synthetic study: `groups` time points (Temporal
        Position Index 1..n in each frame's Frame Content Sequence) of `positions` slices, stored time point by time
        point, each frame's position in its Plane Position Sequence. `groups` 1 is a plain multi-frame MR."""
        f = self.ct('SPLIT-' + uuid.uuid4().hex[:12], 'current', '20260801')
        orth = next(x['ID'] for x in self.stack._orthanc_request('POST', '/tools/lookup', f.uid.encode()).body if x['Type'] == 'Study')
        originals = [dcmread(io.BytesIO(self.stack.orthanc_bytes('/instances/' + x['ID'] + '/file')))
                     for x in self.stack._orthanc_request('GET', '/studies/' + orth + '/instances').body]
        originals.sort(key=lambda d: float(d.ImagePositionPatient[2]))
        self.assertGreaterEqual(len(originals), positions)
        d = copy.deepcopy(originals[0])
        for name in ('RescaleIntercept', 'RescaleSlope', 'RescaleType', 'ImagePositionPatient', 'ImageOrientationPatient',
                     'PixelSpacing', 'SliceThickness', 'SliceLocation', 'WindowCenter', 'WindowWidth'):
            if name in d: delattr(d, name)
        d.SOPClassUID = EnhancedMRImageStorage; d.file_meta.MediaStorageSOPClassUID = EnhancedMRImageStorage
        d.SOPInstanceUID = generate_uid(); d.file_meta.MediaStorageSOPInstanceUID = d.SOPInstanceUID
        d.file_meta.TransferSyntaxUID = ExplicitVRLittleEndian
        d.Modality = 'MR'; d.SeriesInstanceUID = generate_uid(); d.FrameOfReferenceUID = generate_uid()
        d.SeriesNumber = 9; d.InstanceNumber = 1; d.SeriesDescription = description
        d.ImageType = ['ORIGINAL', 'PRIMARY', 'M', 'NONE']; d.NumberOfFrames = groups * positions
        shared = Dataset()
        plane = Dataset(); plane.ImageOrientationPatient = [float(x) for x in originals[0].ImageOrientationPatient]
        shared.PlaneOrientationSequence = Sequence([plane])
        measures = Dataset(); measures.PixelSpacing = list(originals[0].PixelSpacing); measures.SliceThickness = originals[0].get('SliceThickness', 1)
        shared.PixelMeasuresSequence = Sequence([measures])
        voi = Dataset(); voi.WindowCenter = 600; voi.WindowWidth = 1200; shared.FrameVOILUTSequence = Sequence([voi])
        d.SharedFunctionalGroupsSequence = Sequence([shared])
        frames, pixels = [], []
        for k in range(groups):
            for p, original in enumerate(originals[:positions]):
                item = Dataset()
                content = Dataset(); content.TemporalPositionIndex = k + 1; content.StackID = '1'; content.InStackPositionNumber = p + 1
                content.DimensionIndexValues = [k + 1, p + 1]
                item.FrameContentSequence = Sequence([content])
                position = Dataset(); position.ImagePositionPatient = [float(x) for x in original.ImagePositionPatient]
                item.PlanePositionSequence = Sequence([position])
                frames.append(item)
                # Each time point shows a different mark so a wrong frame would be visible in the evidence.
                image = original.pixel_array.copy(); image[20:30, 20:20 + 20 * (k + 1)] = 1400
                pixels.append(image.astype('<u2'))
        d.PerFrameFunctionalGroupsSequence = Sequence(frames)
        d.PixelData = b''.join(x.tobytes() for x in pixels)
        ae = AE(ae_title='HALLYM_MR'); ae.add_requested_context(EnhancedMRImageStorage, ExplicitVRLittleEndian)
        assoc = ae.associate('127.0.0.1', 4242, ae_title='KINLAB'); self.assertTrue(assoc.is_established)
        try:
            self.assertEqual(assoc.send_c_store(d).Status, 0)
        finally:
            assoc.release()
        return f, d.SeriesInstanceUID, d.SOPInstanceUID

    def parts(self, p, series):
        return p.evaluate('''series=>services.displaySetService.getActiveDisplaySets().filter(d=>d.SeriesInstanceUID===series)
          .map(d=>({description:d.SeriesDescription,count:d.images.length,multiFrame:d.isMultiFrame,
            sops:[...new Set(d.images.map(i=>i.SOPInstanceUID))],
            frames:d.images.map(i=>{const m=/\\/frames\\/(\\d+)$/.exec(i.imageId);return m?Number(m[1]):null;}),
            positions:d.images.map(i=>i.ImagePositionPatient&&i.ImagePositionPatient[2])}))''', series)

    def test_series_split_04_time_points_in_one_enhanced_multi_frame_file(self):
        f, series, sop = self.enhanced(2, 6, 'DYN T1 ENH')
        p = self.launch(self.login(), [f])
        p.wait_for_function('s=>services.displaySetService.getActiveDisplaySets().filter(d=>d.SeriesInstanceUID===s).length===2', arg=series, timeout=30000)
        found = self.parts(p, series)
        self.assertEqual([(s['description'], s['count'], s['multiFrame']) for s in found],
                         [('DYN T1 ENH · 1/2 Phase 1', 6, False), ('DYN T1 ENH · 2/2 Phase 2', 6, False)])
        # Each part is the original file's frames of one time point, one frame per position.
        self.assertEqual([s['sops'] for s in found], [[sop], [sop]])
        self.assertEqual([s['frames'] for s in found], [list(range(1, 7)), list(range(7, 13))])
        for s in found: self.assertEqual(len(set(s['positions'])), 6, 'one frame per position in each part')
        expect(p.locator(THUMBS).filter(has_text='DYN T1 ENH')).to_have_count(2)
        expect(p.locator(THUMBS).filter(has_text='1/2 Phase 1')).to_have_count(1)
        expect(p.locator(THUMBS).filter(has_text='2/2 Phase 2')).to_have_count(1)
        self.synchronized(p, '1/2 Phase 1', '2/2 Phase 2', 'enhanced-phases')
        # The cells show the original frames by their own imageIds (the data source's frame address).
        shown = p.evaluate('''()=>[...services.viewportGridService.getState().viewports.keys()].slice(0,2).map(id=>
          services.cornerstoneViewportService.getCornerstoneViewport(id).getCurrentImageId())''')
        self.assertTrue(all('/instances/%s/frames/' % sop in x for x in shown), shown)
        self.assertGreater(int(shown[1].rsplit('/', 1)[1]), 6, 'the second cell shows a frame of the second time point')

    def test_series_split_05_enhanced_multi_frame_file_without_time_points_stays_one_set(self):
        f, series, sop = self.enhanced(1, 6, 'AX T2 ENH')
        p = self.launch(self.login(), [f])
        p.wait_for_function('s=>services.displaySetService.getActiveDisplaySets().some(d=>d.SeriesInstanceUID===s)', arg=series, timeout=30000)
        p.wait_for_timeout(1000)
        found = self.parts(p, series)
        self.assertEqual([(s['description'], s['count'], s['multiFrame'], s['sops']) for s in found], [('AX T2 ENH', 1, True, [sop])])
        expect(p.locator(THUMBS).filter(has_text='AX T2 ENH')).to_have_count(1)


def load_tests(loader, tests, pattern):
    return unittest.TestSuite(SeriesSplitE2E(name) for name in loader.getTestCaseNames(SeriesSplitE2E)
                              if name.startswith('test_series_split_'))


if __name__ == '__main__':
    unittest.main()
