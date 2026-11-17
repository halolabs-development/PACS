# coding: utf-8
"""MG menu on the shipped image toolbar: Mirrored (point, zoom, pan, invert, Magnifier; Close and Reset), Quadrant Zoom,
Tomo (DBT) Slices (step interval, play and its Cine ownership, the slab's pixel values and the way back), Breast Display
(Breast Edge, Breast W/L and its way back, Fit, 1:1, True Size with the monitor's pixel pitch, Fit Breast, Match Size) and
Mammo Keypad (Patient ▶ with Save Draft & Move, Discard & Move and Cancel).

The shipped viewer-features.js, viewer-ux-toolbar.js, viewer-features-mg.js, mg-breast-model.js, mammography-model.js,
viewer-patient-tabs.js and viewer-editor-link.js run in Chromium beside the synthetic OHIF services and account endpoint of
viewer_features_dom_test.py, six synthetic stack cells (current R CC, L CC, R MLO, prior R CC, prior L CC without a stored
orientation, and a 12-slice DBT stack) whose camera, pixels and VOI behave as cornerstone's StackViewport does for this
module, synthetic DICOM headers from an in-page DICOMweb stand-in, and a stand-in reading screen of the same session (the
'kin-report-unconfirmed' channel and its Web Lock, and the window-group channel that opens a study). Synthetic data only.
"""
import unittest

from playwright.sync_api import sync_playwright, expect

from viewer_features_dom_test import HARNESS, SETUP, OWNER, HPACS

ORIGIN = "https://viewer-features.test"
GROUP = "6f9619ff-8b86-4011-b42d-00c04fc964ff"
LIST = "7f9619ff-8b86-4011-b42d-00c04fc964ff"
HASH = "#kin-window-group=" + GROUP + "&kin-window-list=" + LIST
URL_A = ORIGIN + "/ohif/viewer?StudyInstanceUIDs=1.2.1,1.2.2" + HASH
URL_B = ORIGIN + "/ohif/viewer?StudyInstanceUIDs=1.2.9" + HASH

# Six cells. Images are 400 × 300 (columns × rows), 1 mm per pixel in world, world = image index; a cell is 200 × 150 CSS px,
# so Fit shows 0.5 CSS px per image pixel. The breast is a bright half-ellipse against the chest wall (stored right for the
# right breast, left for the left breast) with a bright marker apart from it; prior L CC has no stored orientation.
CELLS = """() => {
  const grid = document.getElementById('grid');
  grid.replaceChildren();
  window.synCells = { dbt: { study: '1.2.1', side: 'R', view: '399162004', po: ['P', 'L'], slices: 12 }, rcc: { study: '1.2.1', side: 'R', view: '399162004', po: ['P', 'L'] }, lcc: { study: '1.2.1', side: 'L', view: '399162004', po: ['A', 'R'] },
    rmlo: { study: '1.2.1', side: 'R', view: '399368009', po: ['P', 'F'] }, prcc: { study: '1.2.2', side: 'R', view: '399162004', po: ['P', 'L'] },
    plcc: { study: '1.2.2', side: 'L', view: '399162004', po: null } };
  const C = 400, R = 300, W = 200, H = 150, BASE = 150;
  const breast = (side, k = 0) => { const values = new Uint16Array(C * R);
    for (let y = 0; y < R; y++) for (let x = 0; x < C; x++) {
      const cx = side === 'R' ? C : 0, dx = (x - cx) / (C * 0.6), dy = (y - R / 2) / (R * 0.4);
      let v = dx * dx + dy * dy <= 1 ? 1000 + (y % 50) + 10 * k : 40;
      if (side === 'R' ? x < 20 && y < 20 : x > C - 20 && y < 20) v = 3000;
      values[y * C + x] = v; }
    return values; };
  window.synSlices = Array.from({ length: 12 }, (_, k) => breast('R', k));
  const views = new Map(); window.synCameraSets = {}; window.synRenders = {};
  const event = (element, type, viewportId) => element.dispatchEvent(new CustomEvent(type, { detail: { viewportId } }));
  for (const [id, info] of Object.entries(synCells)) {
    const pane = document.createElement('div'); pane.dataset.cy = 'viewport-pane'; pane.id = 'pane-' + id;
    const element = document.createElement('div'); element.className = 'viewport-element';
    const canvas = document.createElement('canvas'); canvas.width = W; canvas.height = H; canvas.style.cssText = 'width:100%;height:100%';
    element.append(canvas); pane.append(element); grid.append(pane);
    const series = info.study + '.' + (Object.keys(synCells).indexOf(id) + 1);
    const ids = info.slices ? Array.from({ length: info.slices }, (_, k) => 'img:' + id + ':' + k) : ['img:' + id + ':0'];
    const scalars = { data: info.slices ? synSlices[0] : breast(info.side), getData() { return this.data; }, setData(a) { this.data = a; }, getNumberOfComponents: () => 1 };
    const nodes = [[0, 0, 0, 0, 0.5, 0], [4095, 1, 1, 1, 0.5, 0]];
    const tf = { nodes, getSize() { return this.nodes.length; }, getNodeValue(i, out) { out.splice(0, 6, ...this.nodes[i]); },
      removeAllPoints() { this.nodes = []; }, addRGBPointLong(x, r, g, b, m, s) { this.nodes.push([x, r, g, b, m, s]); } };
    synCameraSets[id] = 0; synRenders[id] = 0;
    const center = [(C - 1) / 2, (R - 1) / 2, 0];
    const v = { id, type: 'stack', element, canvas, index: 0, ids, info, series, tf,
      camera: { focalPoint: [...center], position: [center[0], center[1], -1000], parallelScale: BASE, viewUp: [0, -1, 0], flipHorizontal: false, flipVertical: false },
      props: { invert: false, VOILUTFunction: 'LINEAR', voiRange: { lower: 0, upper: 4095 } },
      imageDataObject: { mtime: 0, worldToIndex(w, out) { out[0] = w[0]; out[1] = w[1]; out[2] = w[2] || 0; return out; },
        indexToWorld(i, out) { out[0] = i[0]; out[1] = i[1]; out[2] = i[2] || 0; return out; },
        getPointData: () => ({ getScalars: () => scalars }), modified() { this.mtime++; } },
      getImageIds() { return this.ids; }, getCurrentImageIdIndex() { return this.index; }, getCurrentImageId() { return this.ids[this.index]; },
      getImageData() { return { dimensions: [C, R, 1], spacing: [1, 1, 1], imageData: this.imageDataObject }; },
      getCamera() { return structuredClone(this.camera); },
      setCamera(c) { Object.assign(this.camera, structuredClone(c)); synCameraSets[id]++; event(element, 'CORNERSTONE_CAMERA_MODIFIED', id); },
      getZoom() { return BASE / this.camera.parallelScale; },
      setZoom(z) { this.setCamera({ parallelScale: BASE / z }); },
      setPan([x, y]) { const f = [center[0] - x, center[1] - y, 0]; this.setCamera({ focalPoint: f, position: [f[0], f[1], -1000] }); },
      getViewPresentation: () => ({}),
      scale() { return (H / 2) / this.camera.parallelScale; },
      worldToCanvas(w) { const s = this.scale(), f = this.camera.focalPoint;
        return [W / 2 + (this.camera.flipHorizontal ? -1 : 1) * (w[0] - f[0]) * s, H / 2 + (this.camera.flipVertical ? -1 : 1) * (w[1] - f[1]) * s]; },
      canvasToWorld(p) { const s = this.scale(), f = this.camera.focalPoint;
        return [f[0] + (this.camera.flipHorizontal ? -1 : 1) * (p[0] - W / 2) / s, f[1] + (this.camera.flipVertical ? -1 : 1) * (p[1] - H / 2) / s, 0]; },
      getProperties() { return structuredClone(this.props); },
      setProperties(p) { Object.assign(this.props, structuredClone(p)); event(element, 'CORNERSTONE_VOI_MODIFIED', id); },
      setVOI(range) { this.props.voiRange = { ...range }; this.tf.nodes = [[range.lower, 0, 0, 0, 0.5, 0], [range.upper, 1, 1, 1, 0.5, 0]]; event(element, 'CORNERSTONE_VOI_MODIFIED', id); },
      getDefaultActor() { return { actor: { getProperty: () => ({ getRGBTransferFunction: () => tf }) } }; },
      render() { synRenders[id]++; },
      show(index) { this.index = index; scalars.data = synSlices[index]; event(element, 'CORNERSTONE_STACK_NEW_IMAGE', id); } };
    views.set(id, v);
  }
  window.synViews = views;
  window.synShown = Object.fromEntries([...views.keys()].map(id => [id, ['set-' + id]]));
  synServices.cornerstoneViewportService.getCornerstoneViewport = id => views.get(id);
  const gridState = synServices.viewportGridService.getState;
  synServices.viewportGridService.getState = () => ({ ...gridState(), layout: { layoutType: 'grid', numRows: 1, numCols: views.size } });
  synServices.displaySetService = { getDisplaySetByUID: uid => ({ StudyInstanceUID: '1.2.1', SeriesInstanceUID: uid }), getActiveDisplaySets: () => [] };
  window.synCine = { stops: [], state: { cines: {} }, listeners: [] };
  synServices.cineService = { EVENTS: { CINE_STATE_CHANGED: 'cine' }, getState: () => synCine.state,
    setCine: c => synCine.stops.push(['setCine', c.id, c.isPlaying]), stopClip: (el, o) => synCine.stops.push(['stopClip', o.viewportId]),
    subscribe: (event, fn) => { synCine.listeners.push(fn); return { unsubscribe() {} }; } };
  window.synCineStart = id => { synCine.state = { cines: { [id]: { isPlaying: true, frameRate: 24 } } }; synCine.listeners.forEach(fn => fn()); };
  // cornerstone stand-ins: metadata, events, jumpToSlice and the image loader of the DBT stack.
  const uidOf = imageId => { const [, id, k] = imageId.split(':'); const v = views.get(id); return { v, sop: v.series + '.' + (Number(k) + 1) }; };
  window.synJumps = [];
  window.cornerstone = { Enums: { Events: { STACK_NEW_IMAGE: 'CORNERSTONE_STACK_NEW_IMAGE', CAMERA_MODIFIED: 'CORNERSTONE_CAMERA_MODIFIED', VOI_MODIFIED: 'CORNERSTONE_VOI_MODIFIED' } },
    metaData: { get(type, imageId) { const { v, sop } = uidOf(imageId);
      if (type === 'instance') return { SOPInstanceUID: sop, StudyInstanceUID: v.info.study, SeriesInstanceUID: v.series, Modality: 'MG', NumberOfFrames: 1 };
      if (type === 'imagePlaneModule') { const k = Number(imageId.split(':')[2]);
        return { rowCosines: [0, 1, 0], columnCosines: [0, 0, -1], rowPixelSpacing: 0.1, columnPixelSpacing: 0.1,
          imagePositionPatient: [k, window.synPlaneShift?.[k] || 0, 0] }; }
      return null; } },
    utilities: { jumpToSlice(element, { imageIndex }) { const v = [...views.values()].find(view => view.element === element); synJumps.push(imageIndex); v.show(imageIndex); return Promise.resolve(); } },
    imageLoader: { loadAndCacheImage: imageId => { const k = Number(imageId.split(':')[2]);
      // synScaled[k]: that slice's cached pixels in another value space than the cell shows (twice the values).
      return Promise.resolve({ imageId, rows: R, columns: C, slope: 1, intercept: 0, preScale: { scaled: true },
        getPixelData: () => window.synScaled?.[k] ? synSlices[k].map(n => n * 2) : synSlices[k] }); } } };
  window.kinPlanarGeometry = () => ({ spacing: [0.1, 0.1], calculator: 'kin-mg-length-v1:detector' });
  // DICOMweb metadata of each image (the header mammography-model.js reads).
  const header = (v, sop) => { const tag = (vr, value) => ({ vr, Value: [].concat(value) });
    const item = { '00080016': tag('UI', '1.2.840.10008.5.1.4.1.1.1.2'), '00080018': tag('UI', sop), '0020000D': tag('UI', v.info.study),
      '00080060': tag('CS', 'MG'), '00200062': tag('CS', v.info.side), '00280010': tag('US', R), '00280011': tag('US', C), '00280004': tag('CS', 'MONOCHROME2'),
      '00540220': { vr: 'SQ', Value: [{ '00080100': tag('SH', v.info.view), '00080102': tag('SH', 'SCT') }] } };
    if (v.info.po) item['00200020'] = { vr: 'CS', Value: v.info.po };
    // The DBT cell: a regular 12-frame breast tomosynthesis object (thin contiguous sections, the classifier's 'dbt').
    if (v.info.slices) {
      const type = ['ORIGINAL', 'PRIMARY', 'VOLUME', 'NONE'];
      Object.assign(item, { '00080016': tag('UI', '1.2.840.10008.5.1.4.1.1.13.1.3'), '0020000E': tag('UI', v.series), '00200013': tag('IS', 1),
        '00080008': tag('CS', type), '00089206': tag('CS', 'VOLUME'), '00089207': tag('CS', 'NONE'), '00200052': tag('UI', v.info.study + '.99'),
        '00280008': tag('IS', v.info.slices),
        '52009229': { vr: 'SQ', Value: [{ '00209116': { vr: 'SQ', Value: [{ '00200037': tag('DS', [0, 1, 0, 0, 0, -1]) }] },
          '00289110': { vr: 'SQ', Value: [{ '00280030': tag('DS', [0.1, 0.1]), '00180050': tag('DS', 1) }] } }] },
        '52009230': { vr: 'SQ', Value: Array.from({ length: v.info.slices }, (_, z) => ({
          '00189504': { vr: 'SQ', Value: [{ '00089007': tag('CS', type), '00089206': tag('CS', 'VOLUME'), '00089207': tag('CS', 'NONE') }] },
          '00209113': { vr: 'SQ', Value: [{ '00200032': tag('DS', [z, 0, 0]) }] } })) } });
    }
    return item; };
  window.synMetadataReads = 0;
  const accountFetch = window.fetch;
  window.fetch = async (url, init) => {
    const path = String(url);
    const match = /^\\/dicom-web\\/studies\\/[^/]+\\/series\\/([^/]+)\\/instances\\/([^/]+)\\/metadata$/.exec(path);
    if (match) { synMetadataReads++; if (window.synMetadataDelay) await new Promise(resolve => setTimeout(resolve, synMetadataDelay));
      const v = [...views.values()].find(view => view.series === match[1]);
      return new Response(JSON.stringify([header(v, match[2])]), { status: 200, headers: { 'Content-Type': 'application/dicom+json' } }); }
    return accountFetch(url, init);
  };
}"""

# The patient tabs and a reading screen of the same session: two patients (A: studies 1.2.1 and 1.2.2, B: 1.2.9); the
# reading screen holds unconfirmed text of the studies in synReader.held and answers save / discard / check as told,
# synReader.answerLag ms later; its answers to an opening come synReader.openLag ms later.
READER = """([group, urlB]) => {
  window.KinWorkContext = { state: () => 'active', session: () => 'syn-session', capture: () => null, admits: () => true };
  window.KinViewerInfoBar = { identity: () => ({ instance: null }) };
  window.kinViewerFrameCoverageConfirm = () => true;
  synSession.readOnly = () => false;
  const rows = { '1.2.1': { uid: '1.2.1', sourcePatientKey: 'PK-A', name: 'SYN^ALPHA', id: 'SYN-A', sex: 'F', birth: '1970-01-01', date: '2026-08-12' },
    '1.2.2': { uid: '1.2.2', sourcePatientKey: 'PK-A', name: 'SYN^ALPHA', id: 'SYN-A', sex: 'F', birth: '1970-01-01', date: '2025-08-12' },
    '1.2.9': { uid: '1.2.9', sourcePatientKey: 'PK-B', name: 'SYN^BRAVO', id: 'SYN-B', sex: 'F', birth: '1980-01-01', date: '2026-08-12' } };
  const before = window.fetch;
  window.fetch = async (url, init) => {
    const u = new URL(String(url), location.origin);
    if (u.pathname === '/api/studies') return new Response(JSON.stringify({ studies: (u.searchParams.get('uids') || '').split(',').map(uid => rows[uid]).filter(Boolean) }), { status: 200 });
    return before(url, init);
  };
  // The reading screen of this session. As feature-mounts.js: it saves or discards only the study it has selected
  // (synReader.target); text it holds of another of the asked studies is refused; silent: it never answers.
  window.synReader = { held: [], save: 'saved', discard: 'discarded', silent: false, open: 'ok', calls: [], target: '1.2.1', opens: [], openAt: [], cancels: [] };
  navigator.locks.request('kin-report-reader:syn-session:syn-doc', () => new Promise(() => {}));
  const channel = new BroadcastChannel('kin-report-unconfirmed');
  channel.onmessage = event => {
    const m = event.data;
    if (!m || m.session !== 'syn-session' || !['check', 'save', 'discard'].includes(m.type)) return;
    synReader.calls.push([m.type, m.uids.join(',')]);
    if (synReader.silent) return;
    const mine = m.uids.includes(synReader.target) && synReader.held.includes(synReader.target);
    const others = m.uids.filter(uid => uid !== synReader.target && synReader.held.includes(uid));
    let result = null;
    if (m.type === 'save' || m.type === 'discard') {
      if (others.length) result = { status: 'refused', reason: '판독 화면에서 그 검사를 다시 고른 뒤 저장하세요' };
      else if (m.type === 'save') result = mine && synReader.save !== 'saved' ? { status: synReader.save, reason: '서버가 저장을 받지 않았습니다' } : { status: mine ? 'saved' : 'clear', reason: null };
      else result = mine && synReader.discard !== 'discarded' ? { status: 'refused', reason: '판독 화면이 초안을 버리지 못했습니다' } : { status: mine ? 'discarded' : 'clear', reason: null };
      if (mine && ['saved', 'discarded'].includes(result.status)) synReader.held = synReader.held.filter(uid => uid !== synReader.target);
    }
    setTimeout(() => channel.postMessage({ type: 'answer', id: 'syn-doc', session: 'syn-session', request: m.request, result,
      held: m.uids.filter(uid => synReader.held.includes(uid)) }), synReader.answerLag ?? 20);
  };
  // The list document's window-group channel, as viewer-windows.js and reading-workspace.js answer it: the reading screen
  // makes a study its report target (or refuses, or is busy with an earlier opening for synReader.busy ms after a silent
  // one); every answer but busy says whether the report target is that study now (`at`). A withdrawn opening
  // (kin-editor-open-cancel) is recorded, its move dropped if it has not happened, and answered with `at` - unless
  // synReader.withdrawSilent. synReader.open: 'silent' never answers B; 'late' moves to B lateMs after the request and
  // answers then, while the withdraw is handled only cancelLag ms after it arrives (a busy page); 'slow' would move to B
  // slowMs after the request; 'refuse' refuses B (modal) before moving; 'refuse-after' moves to B and then refuses (modal).
  const windows = new BroadcastChannel('kin-viewer-windows:' + group);
  let busyUntil = 0, inflight = null;
  const post = message => setTimeout(() => windows.postMessage(message), 20);
  windows.onmessage = event => {
    const m = event.data;
    if (m?.type === 'kin-editor-open-cancel') {
      synReader.cancels.push(m.uid);
      setTimeout(() => {
        if (inflight?.request === m.request) { clearTimeout(inflight.timer); inflight = null; }
        if (!synReader.withdrawSilent)
          post({ type: 'kin-editor-open-withdrawn', request: m.request, owner: m.owner, uid: m.uid, at: synReader.target === m.uid });
      }, synReader.cancelLag || 0);
      return;
    }
    if (m?.type !== 'kin-editor-open') return;
    synReader.opens.push(m.uid); synReader.openAt.push(performance.now());
    const answer = (result, reason) => ({ type: 'kin-editor-opened', request: m.request, owner: m.owner, uid: m.uid, result, reason,
      ...(reason === 'busy' ? {} : { at: synReader.target === m.uid }) });
    const reply = (result, reason) => setTimeout(() => windows.postMessage(answer(result, reason)), synReader.openLag ?? 20);
    if (performance.now() < busyUntil) { reply('refused', 'busy'); return; }
    if (synReader.open === 'silent' && m.uid === '1.2.9') { busyUntil = performance.now() + 6000 + (synReader.busy || 0); return; }
    if (synReader.open === 'refuse' && m.uid === '1.2.9') { reply('refused', 'modal'); return; }
    if (synReader.open === 'refuse-after' && m.uid === '1.2.9') { synReader.target = m.uid; reply('refused', 'modal'); return; }
    if (['late', 'slow'].includes(synReader.open) && m.uid === '1.2.9') {
      const wait = synReader.open === 'late' ? synReader.lateMs : synReader.slowMs;
      busyUntil = performance.now() + wait;
      inflight = { request: m.request, timer: setTimeout(() => { inflight = null; synReader.target = m.uid; synReader.movedAt = performance.now();
        windows.postMessage(answer('ok', null)); }, wait) };
      return;
    }
    synReader.target = m.uid; reply('ok', null);
  };
  // As the stock router: a patient switch tears the mode down and mounts it again (the toolbar, its features and the tabs);
  // the cells show the new patient's images synImageDelay ms later (never, with synNoImages).
  window.synRemounts = 0; window.synImagesAt = []; window.synImageDelay = 0; window.synNoImages = false;
  for (const v of synViews.values()) v.info.own = v.info.study;
  window.addEventListener('popstate', () => setTimeout(async () => {
    synRemounts++;
    window.synToolbar?.dispose(); window.synKeys?.dispose?.(); KinViewerPatientTabs.dispose();
    const study = new URLSearchParams(location.search).get('StudyInstanceUIDs').split(',')[0];
    for (const v of synViews.values()) v.info.study = 'loading';
    setTimeout(() => { if (synNoImages) return;
      for (const v of synViews.values()) v.info.study = study === '1.2.1' ? v.info.own : study;
      synImagesAt.push(performance.now()); }, synImageDelay);
    await KinViewerPatientTabs.mount({ services: synServices, session: synSession, refreshChrome() {} });
    synMount();
  }, 30));
  window.synOpenB = () => KinViewerPatientTabs.open(urlB);
}"""

class ViewerMgDOMTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.pw = sync_playwright().start()
        cls.browser = cls.pw.chromium.launch()

    @classmethod
    def tearDownClass(cls):
        cls.browser.close(); cls.pw.stop()

    def open(self, size=(1366, 900), dpr=1, tabs=False):
        context = self.browser.new_context(viewport={'width': size[0], 'height': size[1]}, device_scale_factor=dpr)
        page = context.new_page(); errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.route(ORIGIN + "/ohif/viewer**", lambda route: route.fulfill(body=HARNESS, content_type="text/html"))
        page.route(ORIGIN + "/worklist/hpacs-lite/mg-breast-model.js",
                   lambda route: route.fulfill(path=str(HPACS / 'mg-breast-model.js'), content_type='text/javascript'))
        page.goto(URL_A)
        page.add_style_tag(path=str(HPACS / "viewer-ux-theme.css"))
        for name in ["viewer-ux-shortcuts.js", "viewer-features.js", "viewer-ux-toolbar.js", "mammography-model.js",
                     "exam-scope.js", "viewer-exam-scope.js", "viewer-patient-tabs.js", "viewer-editor-link.js"]:
            page.add_script_tag(path=str(HPACS / name))
        page.evaluate(SETUP, OWNER)
        page.evaluate(CELLS)
        page.add_script_tag(path=str(HPACS / "viewer-features-mg.js"))
        if not tabs:
            page.evaluate("() => synMount()")
            expect(page.locator('.kin-ux-toolbar-settings [role=status]')).to_have_text('계정 설정 · 다른 PC에서도 적용됩니다.')
        else:
            page.evaluate(READER, [GROUP, URL_B])
            page.evaluate("() => KinViewerPatientTabs.mount({ services: synServices, session: synSession, refreshChrome() {} })")
            page.wait_for_function("() => KinViewerPatientTabs.list().length === 1")
            # The second patient is opened as a tab (the worklist would open it in this window).
            page.evaluate("() => synOpenB()")
            page.wait_for_function("() => synRemounts === 1 && KinViewerPatientTabs.snapshot()?.key === 'PK-B'")
            # Back to the first patient by its tab: the window shows A, B is the next tab.
            page.evaluate("() => KinViewerPatientTabs.open(" + repr(URL_A) + ")")
            page.wait_for_function("() => synRemounts === 2 && KinViewerPatientTabs.snapshot()?.key === 'PK-A'")
        page.wait_for_function("() => !!window.KinMgBreastModel && KinViewerFeatures.items('MG').length === 6")
        self.addCleanup(context.close)
        self.addCleanup(lambda: self.assertEqual([], errors))
        return page

    def menu(self, page, label):
        page.get_by_role('button', name='MG ▾').click()
        page.get_by_role('menu', name='MG').get_by_role('menuitem', name=label, exact=True).click()

    def camera(self, page, cell):
        return page.evaluate("id => { const v = synViews.get(id); return { zoom: v.getZoom(), focal: v.camera.focalPoint.slice(0, 2), invert: v.props.invert }; }", cell)

    def click_cell(self, page, cell, x, y):
        box = page.locator('#pane-' + cell).bounding_box()
        page.mouse.click(box['x'] + x, box['y'] + y)

    def assertNear(self, actual, expected, places=3):
        self.assertEqual(len(actual), len(expected))
        for a, b in zip(actual, expected):
            self.assertAlmostEqual(a, b, places=places, msg=f'{actual} != {expected}')

    def test_01_menu_items_in_the_mock_order_with_magnifier_last_and_the_next_patient_key(self):
        page = self.open()
        page.get_by_role('button', name='MG ▾').click()
        expect(page.get_by_role('menu', name='MG').get_by_role('menuitem')).to_have_text(
            ['Mirrored', 'Quadrant Zoom', 'Tomo (DBT) Slices', 'Breast Display', 'Mammo Keypad', 'Magnifier'])
        page.keyboard.press('Escape')
        self.assertIn({'id': 'mgNextPatient', 'label': 'Next Patient'}, page.evaluate("() => synToolbar ? KinViewerFeatures.actions().filter(a => a.shortcut).map(a => ({ id: a.id, label: a.label })) : []"))

    def test_02_mirrored_point_zooms_the_same_view_mirrored_and_never_across_views_or_unverified(self):
        page = self.open()
        self.menu(page, 'Mirrored')
        panel = page.get_by_role('dialog', name='Mirrored')
        expect(panel.get_by_label('Invert together')).to_be_checked()
        expect(panel.locator('[role=status]')).to_contain_text('Prior · L CC: orientation unverified')
        expect(page.locator('#pane-plcc [data-mg-badge=mirrored]')).to_have_text('Mirrored: orientation unverified — not linked')
        before = {cell: self.camera(page, cell) for cell in ['rmlo', 'plcc']}
        # A point in today's R CC at canvas (50, 40): image (99.5, 79.5) at Fit (0.5 px per pixel, centre 199.5, 149.5).
        self.click_cell(page, 'rcc', 50, 40)
        page.wait_for_function("() => Math.abs(synViews.get('lcc').getZoom() - 2) < 1e-9")
        rcc, lcc, prcc = (self.camera(page, c) for c in ['rcc', 'lcc', 'prcc'])
        self.assertAlmostEqual(rcc['zoom'], 2); self.assertNear(rcc['focal'], [99.5, 79.5])
        # Same standard place on the left breast is mirrored across (400 − 100 = 300 at pixel edges → 299.5 index).
        self.assertAlmostEqual(lcc['zoom'], 2); self.assertNear(lcc['focal'], [299.5, 79.5])
        self.assertAlmostEqual(prcc['zoom'], 2); self.assertNear(prcc['focal'], [99.5, 79.5])
        # MLO (another view) and the unverified prior are not moved.
        self.assertEqual(before, {cell: self.camera(page, cell) for cell in ['rmlo', 'plcc']})

    def test_02b_a_point_pressed_while_the_image_headers_are_still_being_read_is_taken(self):
        page = self.open()
        page.evaluate("() => { window.synMetadataDelay = 400; }")
        self.menu(page, 'Mirrored')
        self.click_cell(page, 'rcc', 50, 40)
        page.wait_for_function("() => Math.abs(synViews.get('lcc').getZoom() - 2) < 1e-9")
        self.assertNear(self.camera(page, 'lcc')['focal'], [299.5, 79.5])

    def test_03_mirrored_follows_zoom_pan_and_invert_without_echo_close_unlinks_and_reset_goes_back(self):
        page = self.open()
        self.menu(page, 'Mirrored')
        page.wait_for_function("() => document.querySelector('#pane-plcc [data-mg-badge=mirrored]')")
        start = {cell: self.camera(page, cell) for cell in ['rcc', 'lcc', 'prcc']}
        # The reader zooms and pans today's L CC (a camera change of its own).
        page.evaluate("() => { const v = synViews.get('lcc'); v.setCamera({ parallelScale: 50, focalPoint: [320, 100, 0] }); }")
        page.wait_for_function("() => Math.abs(synViews.get('rcc').getZoom() - 3) < 1e-9")
        self.assertNear(self.camera(page, 'rcc')['focal'], [79, 100])
        self.assertNear(self.camera(page, 'prcc')['focal'], [79, 100])
        sets = page.evaluate("() => ({ ...synCameraSets })")
        page.wait_for_timeout(200)
        # No echo: the followers' own camera events do not move the others again.
        self.assertEqual(sets, page.evaluate("() => ({ ...synCameraSets })"))
        self.assertLessEqual(sets['lcc'], 1)
        # Invert in one cell inverts the same view's others (Invert together), and not the MLO.
        page.evaluate("() => synViews.get('rcc').setProperties({ invert: true })")
        page.wait_for_function("() => synViews.get('lcc').props.invert && synViews.get('prcc').props.invert")
        self.assertFalse(page.evaluate("() => synViews.get('rmlo').props.invert"))
        # Reset: the views as they were when Mirrored was turned on (camera and inversion).
        page.get_by_role('dialog', name='Mirrored').get_by_role('button', name='Reset').click()
        for cell in ['rcc', 'lcc', 'prcc']:
            self.assertEqual(start[cell], self.camera(page, cell))
        # Close only unlinks: a later change stays in its own cell.
        page.get_by_role('dialog', name='Mirrored').get_by_role('button', name='Close').click()
        page.evaluate("() => synViews.get('lcc').setCamera({ parallelScale: 30 })")
        page.wait_for_timeout(150)
        self.assertAlmostEqual(1, self.camera(page, 'rcc')['zoom'])
        expect(page.locator('[data-mg-badge=mirrored]')).to_have_count(0)

    def test_04_magnifier_shows_lenses_while_pressed_and_at_the_counterparts_with_mirrored(self):
        page = self.open()
        self.menu(page, 'Mirrored')
        page.wait_for_function("() => document.querySelector('#pane-plcc [data-mg-badge=mirrored]')")
        self.menu(page, 'Magnifier')
        expect(page.locator('#pane-rcc .kin-mg-capture[data-mode=lens]')).to_have_count(1)
        box = page.locator('#pane-rcc').bounding_box()
        page.mouse.move(box['x'] + 50, box['y'] + 40); page.mouse.down()
        expect(page.locator('#pane-lcc .kin-mg-lens')).to_have_count(1)
        self.assertEqual('50,40', page.locator('#pane-rcc .kin-mg-lens').get_attribute('data-at'))
        # Mirrored across on L CC (canvas x 200 − 50 = 150), the same place on the prior R CC; none on the MLO.
        self.assertEqual('150,40', page.locator('#pane-lcc .kin-mg-lens').get_attribute('data-at'))
        self.assertEqual('50,40', page.locator('#pane-prcc .kin-mg-lens').get_attribute('data-at'))
        expect(page.locator('#pane-rmlo .kin-mg-lens')).to_have_count(0)
        # The press is the Magnifier's: no Mirrored point (no zoom) and no tool underneath.
        self.assertAlmostEqual(1, self.camera(page, 'rcc')['zoom'])
        page.mouse.up()
        expect(page.locator('.kin-mg-lens')).to_have_count(0)
        self.menu(page, 'Magnifier')
        expect(page.locator('.kin-mg-capture')).to_have_count(0)

    def test_05_quadrant_zoom_fills_each_cell_with_the_same_quadrant_mirrored_and_close_fits(self):
        page = self.open()
        self.menu(page, 'Quadrant Zoom')
        panel = page.get_by_role('dialog', name='Quadrant Zoom')
        expect(panel.get_by_label('Order')).to_have_value('symmetric')
        expect(panel.locator('b')).to_have_text('Quadrant 1/4: Upper-Outer (R/L matched)')
        # 4× is the first choice; Fill Quadrant fills each cell with the quadrant.
        expect(panel.get_by_label('Zoom')).to_have_value('4x')
        panel.get_by_label('Zoom').select_option('fill')
        expect(page.locator('#pane-rcc [data-mg-badge=quadrant]')).to_have_text('Q1 Upper-Outer · Fill Quadrant')
        page.wait_for_function("() => synViews.get('lcc').getZoom() > 2.1 && synViews.get('lcc').getZoom() < 3")
        # The breast box of R CC is x 160 … 400, y 32 … 272 (grid of 4 px); its chest-wall upper quarter is x 280 … 400, y 32 … 152.
        rcc = page.evaluate("() => KinMgBreastModel.detect(synViews.get('rcc').imageDataObject.getPointData().getScalars().getData(), 400, 300).box")
        quarter = {'x0': (rcc['x0'] + rcc['x1']) / 2, 'x1': rcc['x1'], 'y0': rcc['y0'], 'y1': (rcc['y0'] + rcc['y1']) / 2}
        zoom = min(200 / (quarter['x1'] - quarter['x0']), 150 / (quarter['y1'] - quarter['y0'])) * 0.98 / 0.5
        self.assertAlmostEqual(zoom, self.camera(page, 'rcc')['zoom'], places=6)
        self.assertNear(self.camera(page, 'rcc')['focal'], [(quarter['x0'] + quarter['x1']) / 2 - 0.5, (quarter['y0'] + quarter['y1']) / 2 - 0.5])
        # The left breast's step 1 is the mirrored half (its chest wall is at the left).
        self.assertLess(self.camera(page, 'lcc')['focal'][0], 200)
        expect(page.locator('#pane-plcc [data-mg-badge=quadrant]')).to_have_text('Quadrant: orientation unverified')
        heads = []
        for _ in range(3):
            panel.get_by_role('button', name='Next Quadrant').click()
            heads.append(panel.locator('b').text_content())
        self.assertEqual(['Quadrant 2/4: Upper-Inner (R/L matched)', 'Quadrant 3/4: Lower-Inner (R/L matched)',
                          'Quadrant 4/4: Lower-Outer (R/L matched)'], heads)
        # Step 4 on R CC: the upper nipple-side quarter of the box.
        last = [(rcc['x0'] + (rcc['x0'] + rcc['x1']) / 2) / 2 - 0.5, (rcc['y0'] + (rcc['y0'] + rcc['y1']) / 2) / 2 - 0.5]
        page.wait_for_function("([x, y]) => Math.abs(synViews.get('rcc').camera.focalPoint[0] - x) < 1e-6 && Math.abs(synViews.get('rcc').camera.focalPoint[1] - y) < 1e-6", arg=last)
        panel.get_by_role('button', name='Close').click()
        page.wait_for_function("() => Math.abs(synViews.get('rcc').getZoom() - 1) < 1e-9")
        self.assertNear(self.camera(page, 'lcc')['focal'], [199.5, 149.5])

    # The centre of step `step`'s quarter of each cell's breast box, as the model names it for the cell's side and view.
    QUARTER = """([id, step]) => { const v = synViews.get(id), side = v.info.side, view = v.info.view === '399162004' ? 'CC' : 'MLO';
      const box = KinMgBreastModel.detect(v.imageDataObject.getPointData().getScalars().getData(), 400, 300).box;
      const q = KinMgBreastModel.quadrant(step, { side, view, verified: true, flipH: false, flipV: false, columns: 400, rows: 300 }, box);
      return { center: [(q.box.x0 + q.box.x1) / 2 - 0.5, (q.box.y0 + q.box.y1) / 2 - 0.5], name: q.name }; }"""

    def test_05b_quadrant_zoom_4x_is_four_times_fit_in_every_cell_through_the_four_steps_in_mirrored_order(self):
        page = self.open()
        self.menu(page, 'Quadrant Zoom')
        panel = page.get_by_role('dialog', name='Quadrant Zoom')
        expect(panel.get_by_label('Zoom')).to_have_value('4x')
        expect(panel.get_by_label('Zoom').locator('option')).to_have_text(['4×', 'Fill Quadrant'])
        # The buttons and their order are as before.
        expect(panel.get_by_role('button')).to_have_text(['Previous Quadrant', 'Next Quadrant', 'Close'])
        expect(panel).to_contain_text('Fit(100 %)의 4배(400 %)')
        names = ['Upper-Outer', 'Upper-Inner', 'Lower-Inner', 'Lower-Outer']
        cells = ['rcc', 'lcc', 'rmlo', 'prcc']
        for step in range(4):
            if step:
                panel.get_by_role('button', name='Next Quadrant').click()
            expect(panel.locator('b')).to_have_text(f'Quadrant {step + 1}/4: {names[step]} (R/L matched)')
            want = {cell: page.evaluate(self.QUARTER, [cell, step]) for cell in cells}
            page.wait_for_function("([ids, want]) => ids.every(id => { const f = synViews.get(id).camera.focalPoint; return Math.abs(f[0] - want[id][0]) < 1e-6 && Math.abs(f[1] - want[id][1]) < 1e-6; })",
                                   arg=[cells, {c: want[c]['center'] for c in cells}])
            with self.subTest(step=step):
                for cell in cells:
                    # Four times Fit (400 %), the same in every cell whatever its quadrant's size.
                    self.assertAlmostEqual(4, self.camera(page, cell)['zoom'], places=9)
                # R/L mirrored: the left breast's quadrant is on the other side of its image (chest wall at the left).
                # (the two boxes differ by a grid sample at most)
                self.assertLessEqual(abs((399 - self.camera(page, 'rcc')['focal'][0]) - self.camera(page, 'lcc')['focal'][0]), 1.5)
                self.assertLessEqual(abs(self.camera(page, 'rcc')['focal'][1] - self.camera(page, 'lcc')['focal'][1]), 1.5)
                # The quadrant here (120 × 120 image px at 2 CSS px each) is larger than the 200 × 150 cell: said so.
                expect(page.locator('#pane-rcc [data-mg-badge=quadrant]')).to_have_text(f'Q{step + 1} {names[step]} · 4× · edges outside')
                expect(panel.locator('[role=status]')).to_contain_text('4×에서 사분면의 가장자리가 칸 밖에 있는 칸 — Current · R CC')
        # Previous from step 1 goes round to step 4; the unverified prior is not zoomed.
        panel.get_by_role('button', name='Next Quadrant').click()
        panel.get_by_role('button', name='Previous Quadrant').click()
        expect(panel.locator('b')).to_have_text('Quadrant 4/4: Lower-Outer (R/L matched)')
        self.assertAlmostEqual(1, self.camera(page, 'plcc')['zoom'])
        expect(page.locator('#pane-plcc [data-mg-badge=quadrant]')).to_have_text('Quadrant: orientation unverified')
        # Close: every MG cell back to Fit; the choice stays for the next opening in this window.
        panel.get_by_label('Zoom').select_option('fill')
        panel.get_by_role('button', name='Close').click()
        page.wait_for_function("() => Math.abs(synViews.get('rcc').getZoom() - 1) < 1e-9")
        expect(page.locator('[data-mg-badge=quadrant]')).to_have_count(0)
        self.menu(page, 'Quadrant Zoom')
        expect(page.get_by_role('dialog', name='Quadrant Zoom').get_by_label('Zoom')).to_have_value('fill')

    def test_05c_a_quadrant_badge_goes_when_the_cells_zoom_is_changed_and_a_breast_display_mode_goes_when_a_quadrant_is_shown(self):
        page = self.open()
        self.menu(page, 'Breast Display')
        display = page.get_by_role('dialog', name='Breast Display')
        display.get_by_role('button', name='Fit Breast').click()
        expect(page.locator('#pane-rcc [data-mg-badge=zoom]')).to_have_text('Zoom mode: Fit Breast')
        self.menu(page, 'Quadrant Zoom')
        panel = page.get_by_role('dialog', name='Quadrant Zoom')
        expect(page.locator('#pane-rcc [data-mg-badge=quadrant]')).to_have_text('Q1 Upper-Outer · 4× · edges outside')
        # The cell's zoom is the quadrant's now, not Fit Breast.
        expect(page.locator('#pane-rcc [data-mg-badge=zoom]')).to_have_count(0)
        # A pan keeps the step (the edges outside the cell are reached that way) …
        page.evaluate("() => { const v = synViews.get('rcc'); const f = v.camera.focalPoint; v.setCamera({ focalPoint: [f[0] + 20, f[1], 0] }); }")
        expect(page.locator('#pane-rcc [data-mg-badge=quadrant]')).to_have_text('Q1 Upper-Outer · 4× · edges outside')
        # … the reader's own zoom ends it in that cell, and a Breast Display mode ends it in every cell it sets.
        page.evaluate("() => synViews.get('rcc').setZoom(6)")
        expect(page.locator('#pane-rcc [data-mg-badge=quadrant]')).to_have_count(0)
        expect(page.locator('#pane-lcc [data-mg-badge=quadrant]')).to_have_text('Q1 Upper-Outer · 4× · edges outside')
        # (the two windows stand in the same place: the press goes to the button itself)
        display.get_by_role('button', name='1:1').evaluate('b => b.click()')
        expect(page.locator('#pane-lcc [data-mg-badge=zoom]')).to_have_text('Zoom mode: 1:1')
        expect(page.locator('#pane-lcc [data-mg-badge=quadrant]')).to_have_count(0)
        # A size change then leaves the cells given to 1:1 as they are.
        one = self.camera(page, 'lcc')['zoom']
        page.evaluate("() => { for (const v of synViews.values()) v.element.style.width = '120px'; }")
        page.wait_for_timeout(400)
        self.assertAlmostEqual(one, self.camera(page, 'lcc')['zoom'], places=9)
        expect(page.locator('#pane-lcc [data-mg-badge=zoom]')).to_have_text('Zoom mode: 1:1')
        # The next step takes every cell again.
        panel.get_by_role('button', name='Next Quadrant').click()
        expect(page.locator('#pane-rcc [data-mg-badge=quadrant]')).to_have_text('Q2 Upper-Inner · 4× · edges outside')
        expect(page.locator('#pane-lcc [data-mg-badge=zoom]')).to_have_count(0)
        self.assertAlmostEqual(4, self.camera(page, 'lcc')['zoom'], places=9)

    def test_05d_a_cell_leaves_the_step_with_another_stack_and_a_held_cell_of_another_size_is_drawn_again_for_it(self):
        page = self.open()
        self.menu(page, 'Quadrant Zoom')
        panel = page.get_by_role('dialog', name='Quadrant Zoom')
        panel.get_by_label('Zoom').select_option('fill')
        expect(page.locator('#pane-dbt [data-mg-badge=quadrant]')).to_have_text('Q1 Upper-Outer · Fill Quadrant')
        # Another slice of the same DBT keeps it; another stack in the cell does not.
        page.evaluate("() => synViews.get('dbt').show(3)")
        expect(page.locator('#pane-dbt [data-mg-badge=quadrant]')).to_have_text('Q1 Upper-Outer · Fill Quadrant')
        page.evaluate("() => { const v = synViews.get('dbt'); v.ids = v.ids.slice(0, 6); synEmit('cells', 'data', { viewportId: 'dbt' }); }")
        expect(page.locator('#pane-dbt [data-mg-badge=quadrant]')).to_have_count(0)
        # The reader zooms L CC (it leaves the step); then every cell becomes narrower by a layout change alone (no window
        # resize event).
        page.evaluate("() => synViews.get('lcc').setZoom(2)")
        expect(page.locator('#pane-lcc [data-mg-badge=quadrant]')).to_have_count(0)
        before = self.camera(page, 'rcc')['zoom']
        page.evaluate("() => { for (const v of synViews.values()) v.element.style.width = '100px'; }")
        page.wait_for_function("z => Math.abs(synViews.get('rcc').getZoom() - z) > 1e-3", arg=before)
        # Fill Quadrant worked out again for the held cell's new width …
        rcc = page.evaluate("() => KinMgBreastModel.detect(synViews.get('rcc').imageDataObject.getPointData().getScalars().getData(), 400, 300).box")
        width = page.evaluate("() => synViews.get('rcc').element.clientWidth")
        self.assertEqual(100, width)
        self.assertAlmostEqual(min(width / ((rcc['x1'] - rcc['x0']) / 2), 150 / ((rcc['y1'] - rcc['y0']) / 2)) * 0.98 / 0.5, self.camera(page, 'rcc')['zoom'], places=6)
        expect(page.locator('#pane-rcc [data-mg-badge=quadrant]')).to_have_text('Q1 Upper-Outer · Fill Quadrant')
        # … and not for the cell the reader zoomed, nor the one showing another stack.
        page.wait_for_timeout(300)
        self.assertAlmostEqual(2, self.camera(page, 'lcc')['zoom'], places=9)
        expect(page.locator('#pane-lcc [data-mg-badge=quadrant]')).to_have_count(0)
        expect(page.locator('#pane-dbt [data-mg-badge=quadrant]')).to_have_count(0)
        # Close while a size change waits: nothing is drawn after it and nothing fails (the page's errors are checked).
        page.evaluate("() => { for (const v of synViews.values()) v.element.style.width = '150px'; }")
        panel.get_by_role('button', name='Close').click()
        page.wait_for_timeout(400)
        self.assertAlmostEqual(1, self.camera(page, 'rcc')['zoom'], places=9)
        expect(page.locator('[data-mg-badge=quadrant]')).to_have_count(0)
    def test_06_tomo_steps_by_the_interval_plays_and_gives_way_to_cine(self):
        page = self.open()
        page.evaluate("() => { synActive = 'dbt'; }")
        self.menu(page, 'Tomo (DBT) Slices')
        panel = page.get_by_role('dialog', name='Tomo (DBT) Slices')
        expect(panel.locator('b')).to_have_text('Slice 1 / 12')
        panel.get_by_role('button', name='Next ▶').click()
        expect(panel.locator('b')).to_have_text('Slice 2 / 12')
        panel.get_by_label('Step Interval').select_option('5')
        panel.get_by_role('button', name='Next ▶').click()
        expect(panel.locator('b')).to_have_text('Slice 7 / 12')
        self.assertEqual(6, page.evaluate("() => synViews.get('dbt').index"))
        panel.get_by_role('button', name='Play').click()
        expect(panel.get_by_role('button', name='Stop')).to_be_visible()
        # The viewer's own Cine in this cell was stopped when this began.
        self.assertIn(['stopClip', 'dbt'], page.evaluate("synCine.stops"))
        page.wait_for_function("() => synJumps.length >= 5")
        panel.get_by_role('button', name='Stop').click()
        jumps = page.evaluate("synJumps.length"); page.wait_for_timeout(200)
        self.assertEqual(jumps, page.evaluate("synJumps.length"))
        # Playing again, then the viewer's Cine starts in this cell: this stops.
        panel.get_by_role('button', name='Play').click()
        page.evaluate("() => synCineStart('dbt')")
        expect(panel.get_by_role('button', name='Play')).to_be_visible()
        jumps = page.evaluate("synJumps.length"); page.wait_for_timeout(200)
        self.assertEqual(jumps, page.evaluate("synJumps.length"))

    def test_07_slab_draws_the_mean_of_the_slices_marks_the_cell_and_gives_the_slice_back(self):
        page = self.open()
        page.evaluate("() => { synActive = 'dbt'; }")
        self.menu(page, 'Tomo (DBT) Slices')
        panel = page.get_by_role('dialog', name='Tomo (DBT) Slices')
        page.evaluate("() => synViews.get('dbt').show(5)")
        page.evaluate("() => { window.synCache = synSlices.map(a => a.slice()); }")
        panel.get_by_label('Slab Thickness').select_option('3')
        expect(page.locator('#pane-dbt [data-mg-badge=slab]')).to_have_text('Slab 3')
        # Slices 4, 5 and 6 (each pixel +10 per slice): the mean is slice 5's value at every pixel.
        self.assertTrue(page.evaluate("""() => { const shown = synViews.get('dbt').imageDataObject.getPointData().getScalars().getData();
          return shown !== synSlices[5] && shown.every((n, i) => n === Math.round((synSlices[4][i] + synSlices[5][i] + synSlices[6][i]) / 3)); }"""))
        # The cell's annotations are hidden and its mouse tools covered; the cache's pixels are untouched.
        self.assertEqual('on', page.locator('#pane-dbt').get_attribute('data-kin-mg-slab'))
        expect(page.locator('#pane-dbt .kin-mg-capture[data-mode=slab]')).to_have_count(1)
        self.assertTrue(page.evaluate("() => synSlices.every((a, k) => a.every((n, i) => n === synCache[k][i]))"))
        # Even: one more after the centre (4 = 4 … 7); at the end only the slices there (11: 10 … 11 of 3).
        panel.get_by_label('Slab Thickness').select_option('10')
        panel.get_by_label('Slab Thickness').select_option('3')
        page.evaluate("() => synViews.get('dbt').show(11)")
        expect(page.locator('#pane-dbt [data-mg-badge=slab]')).to_have_text('Slab 2 of 3')
        self.assertTrue(page.evaluate("""() => { const shown = synViews.get('dbt').imageDataObject.getPointData().getScalars().getData();
          return shown.every((n, i) => n === Math.round((synSlices[10][i] + synSlices[11][i]) / 2)); }"""))
        # The wheel on the slab cell steps the slices (its tools are off).
        box = page.locator('#pane-dbt').bounding_box()
        page.mouse.move(box['x'] + 100, box['y'] + 75); page.mouse.wheel(0, -100)
        expect(panel.locator('b')).to_have_text('Slice 11 / 12')
        # 1 slice: the slice's own values again.
        panel.get_by_label('Slab Thickness').select_option('1')
        expect(page.locator('#pane-dbt [data-mg-badge=slab]')).to_have_count(0)
        self.assertTrue(page.evaluate("() => synViews.get('dbt').imageDataObject.getPointData().getScalars().getData().every((n, i) => n === synSlices[10][i])"))
        self.assertIsNone(page.locator('#pane-dbt').get_attribute('data-kin-mg-slab'))
        expect(page.locator('#pane-dbt .kin-mg-capture')).to_have_count(0)
        # Close with a slab on: the slice comes back too.
        panel.get_by_label('Slab Thickness').select_option('5')
        expect(page.locator('#pane-dbt [data-mg-badge=slab]')).to_have_text('Slab 4 of 5')
        panel.get_by_role('button', name='Close').click()
        self.assertTrue(page.evaluate("() => synViews.get('dbt').imageDataObject.getPointData().getScalars().getData().every((n, i) => n === synSlices[10][i])"))

    def test_07b_slab_is_refused_for_a_slice_shifted_in_the_plane_or_in_another_value_space_and_hides_every_measurement(self):
        page = self.open()
        page.evaluate("() => { synActive = 'dbt'; }")
        self.menu(page, 'Tomo (DBT) Slices')
        panel = page.get_by_role('dialog', name='Tomo (DBT) Slices')
        page.evaluate("() => synViews.get('dbt').show(6)")
        # Slice 7 sits half a millimetre aside in the plane: not the same grid.
        page.evaluate("() => { window.synPlaneShift = { 7: 0.5 }; }")
        panel.get_by_label('Slab Thickness').select_option('3')
        expect(panel.locator('[role=status]')).to_have_text('Slab: 격자나 픽셀 값 변환이 다른 단면이 있어 합치지 않았습니다.')
        expect(page.locator('#pane-dbt [data-mg-badge=slab]')).to_have_count(0)
        self.assertTrue(page.evaluate("() => synViews.get('dbt').imageDataObject.getPointData().getScalars().getData() === synSlices[6]"))
        # The shown slice's cached pixels in another value space (only its tissue differs): not averaged either.
        page.evaluate("() => { window.synPlaneShift = null; window.synScaled = { 6: true }; }")
        panel.get_by_label('Slab Thickness').select_option('1')
        panel.get_by_label('Slab Thickness').select_option('5')
        expect(panel.locator('[role=status]')).to_have_text('Slab: 격자나 픽셀 값 변환이 다른 단면이 있어 합치지 않았습니다.')
        # Every measurement drawing of the cell (the viewer's and the Measure menu's) is hidden while the slab shows.
        page.evaluate("""() => { window.synScaled = null; const pane = document.getElementById('pane-dbt');
          for (const name of ['svg-layer', 'kin-measure']) { const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); s.setAttribute('class', name); pane.append(s); } }""")
        panel.get_by_label('Slab Thickness').select_option('3')
        expect(page.locator('#pane-dbt [data-mg-badge=slab]')).to_have_text('Slab 3')
        expect(page.locator('#pane-dbt svg.kin-measure')).to_be_hidden()
        expect(page.locator('#pane-dbt svg.svg-layer')).to_be_hidden()
        panel.get_by_label('Slab Thickness').select_option('1')
        expect(page.locator('#pane-dbt svg.kin-measure')).to_be_visible()

    def test_07c_tomo_takes_the_dbt_cell_never_another_multi_image_stack(self):
        page = self.open()
        # Today's R CC holds three conventional images and is the active cell: it is not a DBT.
        page.evaluate("() => { const v = synViews.get('rcc'); v.ids = ['img:rcc:0', 'img:rcc:1', 'img:rcc:2']; synActive = 'rcc'; }")
        self.menu(page, 'Tomo (DBT) Slices')
        panel = page.get_by_role('dialog', name='Tomo (DBT) Slices')
        expect(panel.locator('b')).to_have_text('Slice 1 / 12')
        panel.get_by_role('button', name='Next ▶').click()
        expect(panel.locator('b')).to_have_text('Slice 2 / 12')
        self.assertEqual([0, 1], page.evaluate("() => [synViews.get('rcc').index, synViews.get('dbt').index]"))

    def test_08b_breast_wl_stays_with_its_way_back_through_the_frames_of_the_same_dbt(self):
        page = self.open()
        before = page.evaluate("() => ({ props: synViews.get('dbt').getProperties(), nodes: structuredClone(synViews.get('dbt').tf.nodes) })")
        self.menu(page, 'Breast Display')
        panel = page.get_by_role('dialog', name='Breast Display')
        panel.get_by_role('button', name='Breast W/L').click()
        expect(page.locator('#pane-dbt [data-mg-badge=wl]')).to_have_text('Breast W/L')
        page.evaluate("() => synViews.get('dbt').show(4)")
        expect(page.locator('#pane-dbt [data-mg-badge=wl]')).to_have_text('Breast W/L')
        panel.get_by_role('button', name='Breast W/L').click()
        expect(page.locator('#pane-dbt [data-mg-badge=wl]')).to_have_count(0)
        self.assertEqual(before, page.evaluate("() => ({ props: synViews.get('dbt').getProperties(), nodes: structuredClone(synViews.get('dbt').tf.nodes) })"))
        # Another stack in that cell: the mark and its way back go (the viewer sets that stack's own window).
        panel.get_by_role('button', name='Breast W/L').click()
        expect(page.locator('#pane-dbt [data-mg-badge=wl]')).to_have_text('Breast W/L')
        page.evaluate("() => { const v = synViews.get('dbt'); v.ids = v.ids.slice(0, 6); synEmit('cells', 'data', { viewportId: 'dbt' }); }")
        expect(page.locator('#pane-dbt [data-mg-badge=wl]')).to_have_count(0)

    def test_10b_true_size_on_another_screen_goes_back_to_fit_and_asks_again(self):
        page = self.open()
        self.menu(page, 'Breast Display')
        panel = page.get_by_role('dialog', name='Breast Display')
        panel.get_by_role('button', name='True Size').click()
        pitch = panel.get_by_label('Monitor pixel pitch (mm)')
        pitch.fill('0.25'); pitch.press('Tab')
        page.wait_for_function("() => Math.abs(synViews.get('rcc').getZoom() - 0.8) < 1e-9")
        expect(pitch).to_be_hidden()
        # The window is now on a screen placed to the right (another arrangement key) with no value stored for it.
        page.evaluate("""() => { const s = window.screen; Object.defineProperty(window, 'screen', { configurable: true, value: {
          width: s.width, height: s.height, availLeft: s.width, availTop: 0, addEventListener() {} } }); dispatchEvent(new Event('resize')); }""")
        page.wait_for_function("() => Math.abs(synViews.get('rcc').getZoom() - 1) < 1e-9")
        expect(page.locator('#pane-rcc [data-mg-badge=zoom]')).to_have_text('Zoom mode: Fit')
        expect(pitch).to_be_visible()
    def test_10c_true_size_on_screens_that_cannot_be_told_apart_is_never_carried_to_another_screen(self):
        page = self.open()
        # No place for the screen: no key, so the value entered serves this window on this screen only.
        page.evaluate("""() => { window.synRealScreen = window.screen; const s = window.screen; Object.defineProperty(window, 'screen', { configurable: true,
          value: { width: s.width, height: s.height, addEventListener() {} } }); }""")
        self.menu(page, 'Breast Display')
        panel = page.get_by_role('dialog', name='Breast Display')
        panel.get_by_role('button', name='True Size').click()
        pitch = panel.get_by_label('Monitor pixel pitch (mm)')
        pitch.fill('0.25'); pitch.press('Tab')
        page.wait_for_function("() => Math.abs(synViews.get('rcc').getZoom() - 0.8) < 1e-9")
        self.assertIsNone(page.evaluate("() => localStorage.getItem('kin-mg-monitor-pitch:v1')"))
        # The browser moved the window to another screen (alike in size and scale): Fit, and the value is asked again.
        page.evaluate("() => synRealScreen.dispatchEvent(new Event('change'))")
        page.wait_for_function("() => Math.abs(synViews.get('rcc').getZoom() - 1) < 1e-9")
        expect(page.locator('#pane-rcc [data-mg-badge=zoom]')).to_have_text('Zoom mode: Fit')
        expect(pitch).to_be_visible()
        pitch.evaluate("n => { n.value = ''; }")
        panel.get_by_role('button', name='True Size').click()
        page.wait_for_timeout(200)
        self.assertAlmostEqual(1, self.camera(page, 'rcc')['zoom'])
    def test_08_breast_edge_and_breast_wl_with_the_way_back_to_the_stored_window_table_and_inversion(self):
        page = self.open()
        page.evaluate("() => { const v = synViews.get('rcc'); v.props.invert = true; v.props.VOILUTFunction = 'SIGMOID'; v.tf.nodes = [[0, 1, 1, 1, 0.5, 0], [100, 0.7, 0.7, 0.7, 0.5, 0], [4095, 0, 0, 0, 0.5, 0]]; }")
        before = page.evaluate("() => ({ props: synViews.get('rcc').getProperties(), nodes: structuredClone(synViews.get('rcc').tf.nodes) })")
        self.menu(page, 'Breast Display')
        panel = page.get_by_role('dialog', name='Breast Display')
        expect(panel.get_by_role('button')).to_have_text(['Breast Edge', 'Breast W/L', 'Fit', '1:1', 'True Size', 'Fit Breast', 'Match Size', 'Close'])
        panel.get_by_role('button', name='Breast Edge').click()
        page.wait_for_function("() => document.querySelectorAll('.kin-mg-outline').length === 6")
        self.assertGreater(int(page.locator('#pane-rcc .kin-mg-outline').get_attribute('data-points')), 20)
        panel.get_by_role('button', name='Breast W/L').click()
        expect(page.locator('#pane-rcc [data-mg-badge=wl]')).to_have_text('Breast W/L')
        voi = page.evaluate("() => synViews.get('rcc').getProperties()")
        self.assertEqual('LINEAR', voi['VOILUTFunction'])
        # The region's 1–99 percentiles (tissue 1000 … 1049); the inversion stays as the reader had it.
        self.assertGreaterEqual(voi['voiRange']['lower'], 40); self.assertLessEqual(voi['voiRange']['lower'], 1001)
        self.assertGreaterEqual(voi['voiRange']['upper'], 1047); self.assertLessEqual(voi['voiRange']['upper'], 1049)
        self.assertTrue(voi['invert'])
        panel.get_by_role('button', name='Breast W/L').click()
        expect(page.locator('[data-mg-badge=wl]')).to_have_count(0)
        self.assertEqual(before, page.evaluate("() => ({ props: synViews.get('rcc').getProperties(), nodes: structuredClone(synViews.get('rcc').tf.nodes) })"))
        panel.get_by_role('button', name='Breast Edge').click()
        expect(page.locator('.kin-mg-outline')).to_have_count(0)

    def test_09_zoom_modes_fit_one_to_one_fit_breast_and_match_size_as_numbers(self):
        page = self.open(dpr=2)
        self.menu(page, 'Breast Display')
        panel = page.get_by_role('dialog', name='Breast Display')
        # 1:1 on a dpr 2 screen: one image pixel on one device pixel = 0.5 CSS px, which is Fit here (zoom 1).
        page.evaluate("() => synViews.get('rcc').setZoom(3)")
        panel.get_by_role('button', name='1:1').click()
        page.wait_for_function("() => Math.abs(synViews.get('rcc').getZoom() - 1) < 1e-9")
        expect(page.locator('#pane-rcc [data-mg-badge=zoom]')).to_have_text('Zoom mode: 1:1')
        panel.get_by_role('button', name='Fit Breast').click()
        page.wait_for_function("() => synViews.get('rcc').getZoom() > 1.2")
        box = page.evaluate("() => KinMgBreastModel.detect(synViews.get('rcc').imageDataObject.getPointData().getScalars().getData(), 400, 300).box")
        expected = min(200 / (box['x1'] - box['x0']), 150 / (box['y1'] - box['y0'])) * 0.98 / 0.5
        self.assertAlmostEqual(expected, self.camera(page, 'rcc')['zoom'], places=6)
        expect(page.locator('#pane-rcc [data-mg-badge=zoom]')).to_have_text('Zoom mode: Fit Breast')
        # Match Size: the CC cells (lengths equal here) at the shortest shown length; prior L CC has a region too (no orientation needed).
        page.evaluate("() => { synViews.get('dbt').setZoom(1); synViews.get('plcc').setZoom(1); synViews.get('lcc').setZoom(1); synViews.get('prcc').setZoom(2); synViews.get('rcc').setZoom(1.5); }")
        panel.get_by_role('button', name='Match Size').click()
        page.wait_for_function("() => document.querySelector('#pane-prcc [data-mg-badge=zoom]')?.textContent === 'Zoom mode: Match Size'")
        # Each CC cell's breast box width (chest wall to nipple) shown at the shortest shown length (zoom × 0.5 px × width).
        expected = page.evaluate("""() => { const ids = ['dbt', 'rcc', 'lcc', 'prcc', 'plcc'];
          const width = id => { const b = KinMgBreastModel.detect(synViews.get(id).imageDataObject.getPointData().getScalars().getData(), 400, 300).box; return b.x1 - b.x0; };
          const before = { dbt: 1, rcc: 1.5, lcc: 1, prcc: 2, plcc: 1 }, shown = ids.map(id => before[id] * 0.5 * width(id)), least = Math.min(...shown);
          return ids.map((id, i) => before[id] * least / shown[i]); }""")
        zooms = page.evaluate("() => ['dbt', 'rcc', 'lcc', 'prcc', 'plcc'].map(id => synViews.get(id).getZoom())")
        self.assertNear(zooms, expected, places=6)
        # The shown lengths are now equal.
        self.assertEqual(1, len({round(z * w, 6) for z, w in zip(zooms, page.evaluate("""() => ['dbt', 'rcc', 'lcc', 'prcc', 'plcc'].map(id => {
          const b = KinMgBreastModel.detect(synViews.get(id).imageDataObject.getPointData().getScalars().getData(), 400, 300).box; return b.x1 - b.x0; })"""))}))
        panel.get_by_role('button', name='Fit', exact=True).click()
        page.wait_for_function("() => [...synViews.values()].every(v => Math.abs(v.getZoom() - 1) < 1e-9)")
        expect(page.locator('#pane-rmlo [data-mg-badge=zoom]')).to_have_text('Zoom mode: Fit')

    def test_10_true_size_asks_for_this_screens_pixel_pitch_once_and_labels_the_detector_basis(self):
        page = self.open()
        self.menu(page, 'Breast Display')
        panel = page.get_by_role('dialog', name='Breast Display')
        panel.get_by_role('button', name='True Size').click()
        pitch = panel.get_by_label('Monitor pixel pitch (mm)')
        expect(pitch).to_be_visible()
        self.assertAlmostEqual(1, self.camera(page, 'rcc')['zoom'])
        pitch.fill('0.25'); pitch.press('Tab')
        # 0.1 mm image pixels on 0.25 mm device pixels at dpr 1: 0.4 CSS px per image pixel = zoom 0.8 (Fit is 0.5 px).
        page.wait_for_function("() => Math.abs(synViews.get('rcc').getZoom() - 0.8) < 1e-9")
        expect(page.locator('#pane-rcc [data-mg-badge=zoom]')).to_have_text('Zoom mode: True Size (at detector)')
        key = page.evaluate("() => KinMgBreastModel.monitorKey(screen)")
        self.assertEqual({key: 0.25}, page.evaluate("() => JSON.parse(localStorage.getItem('kin-mg-monitor-pitch:v1'))"))
        # Another time on this screen it is not asked again.
        panel.get_by_role('button', name='Fit', exact=True).click()
        panel.get_by_role('button', name='True Size').click()
        page.wait_for_function("() => Math.abs(synViews.get('rcc').getZoom() - 0.8) < 1e-9")
        expect(pitch).to_be_hidden()

    def keypad(self, page):
        self.menu(page, 'Mammo Keypad')
        return page.get_by_role('dialog', name='Mammo Keypad')

    def moved_to(self, page, text, remounts, timeout=30000):
        page.wait_for_function("n => synRemounts === n", arg=remounts, timeout=timeout)
        panel = page.get_by_role('dialog', name='Mammo Keypad')
        expect(panel.locator('[role=status]')).to_have_text(text, timeout=timeout)
        return panel

    def test_11_keypad_cancel_keeps_the_patient_and_save_and_move_takes_images_and_report_target_together(self):
        page = self.open(tabs=True)
        page.evaluate("() => { synReader.held = ['1.2.1']; }")
        panel = self.keypad(page)
        # Before a confirmed move the report target is not claimed for any tab.
        expect(panel.locator('ol li')).to_have_text(['SYN^ALPHA | SYN-A  ← images', 'SYN^BRAVO | SYN-B'])
        panel.get_by_role('button', name='Patient ▶').click()
        question = panel.get_by_role('alertdialog')
        expect(question).to_contain_text('SYN^ALPHA의 판독 초안이 저장되지 않았습니다')
        expect(question).to_contain_text('자동 저장된 부분을 포함해 이 검사의 초안 전체를 버리고')
        expect(question.get_by_role('button')).to_have_text(['Save Draft & Move', 'Discard & Move', 'Cancel'])
        question.get_by_role('button', name='Cancel').click()
        expect(question).to_be_hidden()
        self.assertEqual('PK-A', page.evaluate("KinViewerPatientTabs.snapshot().key"))
        self.assertEqual([['check', '1.2.1,1.2.2']], page.evaluate("synReader.calls"))
        panel.get_by_role('button', name='Patient ▶').click()
        panel.get_by_role('alertdialog').get_by_role('button', name='Save Draft & Move').click()
        # The viewer of B opens the keypad again with the result: images and report target are B.
        panel = self.moved_to(page, 'SYN^BRAVO의 영상과 판독 대상으로 옮겼습니다.', 3)
        expect(panel.locator('ol li')).to_have_text(['SYN^ALPHA | SYN-A', 'SYN^BRAVO | SYN-B  ← images · report target'])
        self.assertEqual('PK-B', page.evaluate("KinViewerPatientTabs.snapshot().key"))
        self.assertIn('1.2.9', page.url)
        self.assertEqual('1.2.9', page.evaluate("synReader.target"))
        self.assertEqual(['check', 'check', 'save', 'check'], page.evaluate("synReader.calls.map(c => c[0])"))
        self.assertEqual([], page.evaluate("synReader.held"))

    def test_12_keypad_discard_and_move_and_a_move_with_nothing_unsaved_asks_nothing(self):
        page = self.open(tabs=True)
        page.evaluate("() => { synReader.held = ['1.2.1']; }")
        panel = self.keypad(page)
        panel.get_by_role('button', name='Patient ▶').click()
        panel.get_by_role('alertdialog').get_by_role('button', name='Discard & Move').click()
        panel = self.moved_to(page, 'SYN^BRAVO의 영상과 판독 대상으로 옮겼습니다.', 3)
        self.assertEqual(['check', 'discard', 'check'], page.evaluate("synReader.calls.map(c => c[0])"))
        self.assertEqual([], page.evaluate("synReader.held"))
        self.assertEqual('1.2.9', page.evaluate("synReader.target"))
        # B holds nothing: Patient ▶ moves at once (back to A, after the last tab the first), no question.
        panel.get_by_role('button', name='Patient ▶').click()
        self.moved_to(page, 'SYN^ALPHA의 영상과 판독 대상으로 옮겼습니다.', 4)
        self.assertEqual('PK-A', page.evaluate("KinViewerPatientTabs.snapshot().key"))
        self.assertEqual('1.2.1', page.evaluate("synReader.target"))
        expect(page.get_by_role('dialog', name='Mammo Keypad').get_by_role('alertdialog')).to_be_hidden()

    def test_13_keypad_save_refused_unanswered_or_held_for_another_study_keeps_the_patient_and_a_second_press_does_nothing(self):
        page = self.open(tabs=True)
        page.evaluate("() => { synReader.held = ['1.2.1']; synReader.save = 'refused'; }")
        panel = self.keypad(page)
        panel.get_by_role('button', name='Patient ▶').click()
        panel.get_by_role('alertdialog').get_by_role('button', name='Save Draft & Move').click()
        expect(panel.locator('[role=status]')).to_contain_text('저장이 확인되지 않아 환자를 옮기지 않았습니다 (서버가 저장을 받지 않았습니다)')
        self.assertEqual('PK-A', page.evaluate("KinViewerPatientTabs.snapshot().key"))
        # Text of the prior study, which the reading screen has not selected: its discard is refused there, nothing moves.
        page.evaluate("() => { synReader.held = ['1.2.2']; }")
        panel.get_by_role('button', name='Patient ▶').click()
        panel.get_by_role('alertdialog').get_by_role('button', name='Discard & Move').click()
        expect(panel.locator('[role=status]')).to_contain_text('버리기이 확인되지 않아 환자를 옮기지 않았습니다 (판독 화면에서 그 검사를 다시 고른 뒤 저장하세요)')
        self.assertEqual(['1.2.2'], page.evaluate("synReader.held"))
        self.assertEqual(2, page.evaluate("synRemounts"))
        # No answer at all: not taken as saved.
        page.evaluate("() => { synReader.silent = true; }")
        panel.get_by_role('button', name='Patient ▶').click()
        panel.get_by_role('alertdialog').get_by_role('button', name='Save Draft & Move').click()
        expect(panel.get_by_role('button', name='Patient ▶')).to_be_disabled()
        # A second move while the first waits: the Next Patient key does nothing either.
        self.assertEqual({'ok': False, 'busy': True, 'message': '환자를 옮기는 중입니다.'}, page.evaluate("KinViewerPatientTabs.next('save')"))
        expect(panel.locator('[role=status]')).to_contain_text('판독 화면의 응답이 없습니다', timeout=10000)
        self.assertEqual('PK-A', page.evaluate("KinViewerPatientTabs.snapshot().key"))
        self.assertEqual(2, page.evaluate("synRemounts"))
        expect(panel.get_by_role('button', name='Patient ▶')).to_be_enabled()

    def test_14_keypad_report_target_refused_brings_the_images_back_and_the_reading_screen_back_to_the_patient_left(self):
        page = self.open(tabs=True)
        page.evaluate("() => { synReader.open = 'refuse'; }")
        panel = self.keypad(page)
        panel.get_by_role('button', name='Patient ▶').click()
        panel = self.moved_to(page, '판독 화면의 대상이 SYN^BRAVO의 검사로 바뀌지 않아(판독 화면에 대화상자가 열려 있습니다) 영상도 SYN^ALPHA에게 되돌렸습니다.', 4)
        self.assertEqual('PK-A', page.evaluate("KinViewerPatientTabs.snapshot().key"))
        self.assertEqual(['1.2.9', '1.2.1'], page.evaluate("synReader.opens"))
        self.assertEqual('1.2.1', page.evaluate("synReader.target"))
        expect(panel.locator('ol li')).to_have_text(['SYN^ALPHA | SYN-A  ← images · report target', 'SYN^BRAVO | SYN-B'])

    def test_14b_keypad_names_the_report_target_only_while_the_viewer_shows_the_confirmed_study(self):
        page = self.open(tabs=True)
        panel = self.keypad(page)
        panel.get_by_role('button', name='Patient ▶').click()
        panel = self.moved_to(page, 'SYN^BRAVO의 영상과 판독 대상으로 옮겼습니다.', 3)
        expect(panel.locator('ol li')).to_have_text(['SYN^ALPHA | SYN-A', 'SYN^BRAVO | SYN-B  ← images · report target'])
        # An ordinary tab switch (the reading screen was not asked): no tab is named the report target any more.
        page.evaluate("() => KinViewerPatientTabs.open(" + repr(URL_A) + ")")
        page.wait_for_function("() => synRemounts === 4 && KinViewerPatientTabs.snapshot()?.key === 'PK-A'")
        panel = self.keypad(page)
        expect(panel.locator('ol li')).to_have_text(['SYN^ALPHA | SYN-A  ← images', 'SYN^BRAVO | SYN-B'])
        # Back to A's tab by the keypad (confirmed 1.2.1), then only A's prior study opened: not the confirmed study.
        panel.get_by_role('button', name='Patient ▶').click()
        panel = self.moved_to(page, 'SYN^BRAVO의 영상과 판독 대상으로 옮겼습니다.', 5)
        panel.get_by_role('button', name='Patient ▶').click()
        panel = self.moved_to(page, 'SYN^ALPHA의 영상과 판독 대상으로 옮겼습니다.', 6)
        expect(panel.locator('ol li').first).to_have_text('SYN^ALPHA | SYN-A  ← images · report target')
        page.evaluate("() => KinViewerPatientTabs.open(location.origin + '/ohif/viewer?StudyInstanceUIDs=1.2.2' + location.hash)")
        page.wait_for_function("() => synRemounts === 7")
        panel = self.keypad(page)
        expect(panel.locator('ol li').first).to_have_text('SYN^ALPHA | SYN-A  ← images')
    def test_15_keypad_asks_for_the_report_target_only_after_the_next_patients_images_are_drawn(self):
        page = self.open(tabs=True)
        page.evaluate("() => { synImageDelay = 800; }")
        panel = self.keypad(page)
        panel.get_by_role('button', name='Patient ▶').click()
        self.moved_to(page, 'SYN^BRAVO의 영상과 판독 대상으로 옮겼습니다.', 3)
        drawn, asked = page.evaluate("() => [synImagesAt.at(-1), synReader.openAt.at(-1)]")
        self.assertGreaterEqual(asked, drawn)

    def test_16_keypad_images_not_drawn_go_back_to_the_patient_left_without_asking_the_reading_screen(self):
        page = self.open(tabs=True)
        page.evaluate("() => { synNoImages = true; }")
        panel = self.keypad(page)
        panel.get_by_role('button', name='Patient ▶').click()
        page.wait_for_function("() => synRemounts === 3")
        # The way back draws its images.
        page.evaluate("() => { synNoImages = false; }")
        self.moved_to(page, 'SYN^BRAVO의 영상이 표시되지 않아 SYN^ALPHA에게 되돌렸습니다.', 4, timeout=40000)
        self.assertEqual('PK-A', page.evaluate("KinViewerPatientTabs.snapshot().key"))
        self.assertEqual([], page.evaluate("synReader.opens"))
        self.assertEqual('1.2.1', page.evaluate("synReader.target"))

    def test_14c_keypad_report_target_moved_before_a_refusal_is_a_move_not_a_failure(self):
        # The reading screen made B its report target and then refused (a dialog opened before the caret went to Findings):
        # images and report target are both B, so the keypad says so and moves nothing back.
        page = self.open(tabs=True)
        page.evaluate("() => { synReader.open = 'refuse-after'; }")
        panel = self.keypad(page)
        panel.get_by_role('button', name='Patient ▶').click()
        panel = self.moved_to(page, 'SYN^BRAVO의 영상과 판독 대상으로 옮겼습니다.', 3)
        page.wait_for_timeout(500)
        self.assertEqual(3, page.evaluate("synRemounts"))
        self.assertEqual('PK-B', page.evaluate("KinViewerPatientTabs.snapshot().key"))
        self.assertEqual(['1.2.9'], page.evaluate("synReader.opens"))
        self.assertEqual('1.2.9', page.evaluate("synReader.target"))
        expect(panel.locator('ol li')).to_have_text(['SYN^ALPHA | SYN-A', 'SYN^BRAVO | SYN-B  ← images · report target'])

    def test_17_keypad_report_target_without_answer_is_withdrawn_and_both_go_back_once_the_reading_screen_is_free(self):
        # The reading screen answers neither the opening nor its withdrawal: the keypad does not know whether B was opened,
        # says so, and brings images and report target back to A (each confirmed).
        page = self.open(tabs=True)
        page.evaluate("() => { synReader.open = 'silent'; synReader.busy = 6000; synReader.withdrawSilent = true; }")
        panel = self.keypad(page)
        panel.get_by_role('button', name='Patient ▶').click()
        self.moved_to(page, '판독 화면이 SYN^BRAVO의 검사를 열었는지 확인하지 못해(판독 화면의 응답이 없습니다) 영상과 판독 대상을 SYN^ALPHA에게 되돌렸습니다.', 4, timeout=40000)
        # The opening that got no answer was withdrawn; the way back was asked again while the reading screen was busy.
        self.assertEqual(['1.2.9'], page.evaluate("synReader.cancels"))
        opens = page.evaluate("synReader.opens")
        self.assertEqual('1.2.9', opens[0]); self.assertEqual('1.2.1', opens[-1]); self.assertGreater(len(opens), 2)
        self.assertEqual('1.2.1', page.evaluate("synReader.target"))
        self.assertEqual('PK-A', page.evaluate("KinViewerPatientTabs.snapshot().key"))

    def test_17b_keypad_report_target_moved_after_the_wait_is_taken_as_moved_not_said_to_have_failed(self):
        # A loaded reading screen moves to B 6.3 s after the request (past the 6 s wait) and handles the withdrawal only
        # after that: the report target IS B. The keypad asks where it is before saying anything - both are B, nothing goes back.
        page = self.open(tabs=True)
        page.evaluate("() => { synReader.open = 'late'; synReader.lateMs = 6300; synReader.cancelLag = 600; }")
        panel = self.keypad(page)
        panel.get_by_role('button', name='Patient ▶').click()
        panel = self.moved_to(page, 'SYN^BRAVO의 영상과 판독 대상으로 옮겼습니다.', 3, timeout=40000)
        page.wait_for_timeout(1500)
        self.assertEqual(3, page.evaluate("synRemounts"))
        self.assertEqual('PK-B', page.evaluate("KinViewerPatientTabs.snapshot().key"))
        self.assertEqual('1.2.9', page.evaluate("synReader.target"))
        self.assertEqual(['1.2.9'], page.evaluate("synReader.opens"))
        expect(panel.locator('[role=status]')).to_have_text('SYN^BRAVO의 영상과 판독 대상으로 옮겼습니다.')
        expect(panel.locator('ol li')).to_have_text(['SYN^ALPHA | SYN-A', 'SYN^BRAVO | SYN-B  ← images · report target'])

    def test_17c_keypad_withdrawn_opening_that_had_not_moved_never_moves_later_and_both_go_back(self):
        # The reading screen would move to B 7.5 s after the request; the withdrawal at 6 s drops that move and says the
        # report target is not B: the keypad says it was not opened, brings both back to A, and B never follows later.
        page = self.open(tabs=True)
        page.evaluate("() => { synReader.open = 'slow'; synReader.slowMs = 7500; }")
        panel = self.keypad(page)
        panel.get_by_role('button', name='Patient ▶').click()
        self.moved_to(page, '판독 화면의 대상이 SYN^BRAVO의 검사로 바뀌지 않아(판독 화면의 응답이 없습니다) 영상도 SYN^ALPHA에게 되돌렸습니다.', 4, timeout=40000)
        page.wait_for_timeout(2000)
        self.assertEqual(['1.2.9'], page.evaluate("synReader.cancels"))
        self.assertIsNone(page.evaluate("synReader.movedAt ?? null"))
        self.assertEqual('1.2.1', page.evaluate("synReader.target"))
        self.assertEqual('PK-A', page.evaluate("KinViewerPatientTabs.snapshot().key"))

    def test_17d_keypad_tab_chosen_while_the_reading_screen_is_asked_back_stops_the_way_back(self):
        # The opening of B got no answer; while the reading screen (busy) is asked back to A, the reader opens B's tab:
        # that newer choice is not undone - no more requests for A, and the result says the tabs changed, not "back to A".
        page = self.open(tabs=True)
        page.evaluate("""() => { synReader.open = 'silent'; synReader.busy = 6000; synReader.withdrawSilent = true;
          window.moveDone = false; KinViewerPatientTabs.next('save').then(result => { window.moveResult = result; moveDone = true; }); }""")
        page.wait_for_function("() => synReader.opens.includes('1.2.1')", timeout=30000)
        page.evaluate("() => { window.opensAtChoice = synReader.opens.length; return synOpenB(); }")
        page.wait_for_function("() => KinViewerPatientTabs.snapshot()?.key === 'PK-B'")
        page.wait_for_function("() => moveDone", timeout=15000)
        page.wait_for_timeout(2500)
        self.assertEqual([], page.evaluate("synReader.opens.slice(opensAtChoice)"))
        result = page.evaluate("moveResult")
        self.assertFalse(result['ok'])
        self.assertEqual('영상 탭이 그 사이 바뀌어 더 되돌리지 않았습니다. 판독 화면의 대상을 확인하세요.', result['message'])
        self.assertNotIn('reportTarget', result)
        self.assertEqual('PK-B', page.evaluate("KinViewerPatientTabs.snapshot().key"))

    def test_17e_keypad_tab_chosen_while_the_opening_is_awaited_withdraws_it_and_moves_nothing_back(self):
        # The reading screen would move to B 7.5 s after the request; at 1 s the reader opens A's tab again: the opening is
        # withdrawn at once (B never follows), nothing is rolled back, and the result says the tabs changed.
        page = self.open(tabs=True)
        page.evaluate("""() => { synReader.open = 'slow'; synReader.slowMs = 7500;
          window.moveDone = false; KinViewerPatientTabs.next('save').then(result => { window.moveResult = result; moveDone = true; }); }""")
        page.wait_for_function("() => synReader.opens.includes('1.2.9')", timeout=30000)
        page.wait_for_timeout(1000)
        page.evaluate("() => KinViewerPatientTabs.open(" + repr(URL_A) + ")")
        page.wait_for_function("() => KinViewerPatientTabs.snapshot()?.key === 'PK-A'")
        # Withdrawn when the tab changed, not when the 6 s wait ran out.
        page.wait_for_function("() => moveDone", timeout=1500)
        self.assertEqual(['1.2.9'], page.evaluate("synReader.cancels"))
        self.assertEqual('영상 탭이 그 사이 바뀌어 더 옮기지 않았습니다. 판독 화면의 대상을 확인하세요.', page.evaluate("moveResult.message"))
        page.wait_for_timeout(7500)
        self.assertIsNone(page.evaluate("synReader.movedAt ?? null"))
        self.assertEqual(['1.2.9'], page.evaluate("synReader.opens"))
        self.assertEqual('1.2.1', page.evaluate("synReader.target"))
        self.assertEqual('PK-A', page.evaluate("KinViewerPatientTabs.snapshot().key"))

    # A newer choice made while a Patient ▶ move is under way is kept as made: the move's request to the reading screen is
    # withdrawn, nothing more opens or goes back, and no success is claimed. Each entry and each wait of the move.
    def tabs_shown(self, page):
        # The viewer header the tabs sit under (viewer-patient-tabs.js refresh), so its tabs and × can be pressed.
        page.evaluate("""() => { const bar = document.createElement('div'), header = document.createElement('div'), brand = document.createElement('span');
          header.className = 'bg-secondary-dark z-20'; brand.id = 'kin-viewer-brand'; header.append(brand); bar.append(header);
          document.body.prepend(bar); KinViewerPatientTabs.refresh(); }""")

    def start_move(self, page, setup=''):
        page.evaluate("() => { " + setup + " window.moveDone = false; KinViewerPatientTabs.next('save').then(result => { window.moveResult = result; moveDone = true; }); }")

    def test_17f_keypad_a_to_b_to_a_while_the_save_is_answered_keeps_a_and_asks_nothing(self):
        page = self.open(tabs=True)
        self.start_move(page, "synReader.answerLag = 800;")
        page.wait_for_function("() => synReader.calls.some(c => c[0] === 'save')")
        page.evaluate("() => synOpenB()")
        page.wait_for_function("() => KinViewerPatientTabs.snapshot()?.key === 'PK-B'")
        page.evaluate("() => KinViewerPatientTabs.open(" + repr(URL_A) + ")")
        page.wait_for_function("() => KinViewerPatientTabs.snapshot()?.key === 'PK-A'")
        page.wait_for_function("() => moveDone", timeout=10000)
        remounts = page.evaluate("synRemounts")
        page.wait_for_timeout(2000)
        self.assertEqual({'ok': False, 'message': '환자가 그 사이 바뀌었습니다.'}, page.evaluate("moveResult"))
        self.assertEqual('PK-A', page.evaluate("KinViewerPatientTabs.snapshot().key"))
        self.assertEqual(remounts, page.evaluate("synRemounts"))
        self.assertEqual([], page.evaluate("synReader.opens"))
        self.assertEqual('1.2.1', page.evaluate("synReader.target"))

    def test_17g_keypad_the_tab_shown_chosen_again_while_the_opening_is_answered_withdraws_it_and_goes_back_nowhere(self):
        page = self.open(tabs=True)
        self.start_move(page, "synReader.open = 'refuse'; synReader.openLag = 1500;")
        page.wait_for_function("() => synReader.opens.includes('1.2.9')")
        page.evaluate("() => KinViewerPatientTabs.open(" + repr(URL_B) + ")")
        page.wait_for_function("() => moveDone", timeout=1500)
        page.wait_for_timeout(2500)
        self.assertEqual('영상 탭이 그 사이 바뀌어 더 옮기지 않았습니다. 판독 화면의 대상을 확인하세요.', page.evaluate("moveResult.message"))
        self.assertFalse(page.evaluate("moveResult.ok"))
        self.assertEqual(['1.2.9'], page.evaluate("synReader.cancels"))
        self.assertEqual(['1.2.9'], page.evaluate("synReader.opens"))
        self.assertEqual('PK-B', page.evaluate("KinViewerPatientTabs.snapshot().key"))
        self.assertEqual(3, page.evaluate("synRemounts"))

    def test_17h_keypad_tab_clicked_while_the_save_is_answered_is_the_choice_kept(self):
        page = self.open(tabs=True)
        self.tabs_shown(page)
        self.start_move(page, "synReader.answerLag = 800;")
        page.wait_for_function("() => synReader.calls.some(c => c[0] === 'save')")
        page.locator('.kin-patient-tabs [role=tab]').nth(1).click()
        page.wait_for_function("() => moveDone", timeout=10000)
        page.wait_for_function("() => KinViewerPatientTabs.snapshot()?.key === 'PK-B'", timeout=10000)
        page.wait_for_timeout(2000)
        self.assertEqual({'ok': False, 'message': '환자가 그 사이 바뀌었습니다.'}, page.evaluate("moveResult"))
        self.assertEqual('PK-B', page.evaluate("KinViewerPatientTabs.snapshot().key"))
        self.assertEqual(3, page.evaluate("synRemounts"))
        self.assertEqual([], page.evaluate("synReader.opens"))

    def test_17i_keypad_tab_chosen_while_the_next_images_are_awaited_is_kept_and_nothing_is_asked(self):
        page = self.open(tabs=True)
        self.start_move(page, "synImageDelay = 2000;")
        page.wait_for_function("() => synRemounts === 3 && KinViewerPatientTabs.snapshot()?.key === 'PK-B'")
        page.evaluate("() => { synImageDelay = 0; return KinViewerPatientTabs.open(" + repr(URL_A) + "); }")
        page.wait_for_function("() => KinViewerPatientTabs.snapshot()?.key === 'PK-A'")
        page.wait_for_function("() => moveDone", timeout=5000)
        page.wait_for_timeout(2500)
        self.assertEqual({'ok': False, 'message': '환자가 그 사이 바뀌었습니다.'}, page.evaluate("moveResult"))
        self.assertEqual('PK-A', page.evaluate("KinViewerPatientTabs.snapshot().key"))
        self.assertEqual(4, page.evaluate("synRemounts"))
        self.assertEqual([], page.evaluate("synReader.opens"))

    def test_17j_keypad_a_tab_closed_while_the_opening_is_awaited_withdraws_it(self):
        page = self.open(tabs=True)
        self.start_move(page, "synReader.open = 'slow'; synReader.slowMs = 7500;")
        page.wait_for_function("() => synReader.opens.includes('1.2.9')")
        # The tab left (A, not shown now) is closed by its ×.
        self.tabs_shown(page)
        page.get_by_role('button', name='Close SYN^ALPHA SYN-A').click()
        page.wait_for_function("() => moveDone", timeout=1500)
        self.assertEqual(['1.2.9'], page.evaluate("synReader.cancels"))
        self.assertEqual('영상 탭이 그 사이 바뀌어 더 옮기지 않았습니다. 판독 화면의 대상을 확인하세요.', page.evaluate("moveResult.message"))
        page.wait_for_timeout(7500)
        self.assertIsNone(page.evaluate("synReader.movedAt ?? null"))
        self.assertEqual(['1.2.9'], page.evaluate("synReader.opens"))
        self.assertEqual(['PK-B'], page.evaluate("KinViewerPatientTabs.list().map(tab => tab.key)"))
        self.assertEqual(3, page.evaluate("synRemounts"))

    def test_17k_keypad_end_and_an_invalid_exam_scope_end_the_move_under_way(self):
        for stop in ["KinViewerPatientTabs.end()", "window.dispatchEvent(new Event('kin-exam-scope-invalidated'))"]:
            with self.subTest(stop=stop):
                page = self.open(tabs=True)
                self.start_move(page, "synReader.open = 'slow'; synReader.slowMs = 7500;")
                page.wait_for_function("() => synReader.opens.includes('1.2.9')")
                page.evaluate("() => { " + stop + "; }")
                page.wait_for_function("() => moveDone", timeout=1500)
                self.assertEqual(['1.2.9'], page.evaluate("synReader.cancels"))
                self.assertFalse(page.evaluate("moveResult.ok"))
                self.assertNotIn('reportTarget', page.evaluate("moveResult"))
                page.wait_for_timeout(7500)
                self.assertIsNone(page.evaluate("synReader.movedAt ?? null"))
                self.assertEqual(['1.2.9'], page.evaluate("synReader.opens"))
                self.assertEqual(3, page.evaluate("synRemounts"))

    def test_17m_tab_clicked_and_then_the_tab_shown_opened_again_keeps_the_newer_choice(self):
        # A tab click waits at the save gate; the tab shown is opened again meanwhile: the click's switch never happens.
        page = self.open(tabs=True)
        self.tabs_shown(page)
        page.evaluate("() => { synReader.answerLag = 800; }")
        page.locator('.kin-patient-tabs [role=tab]').nth(1).click()
        page.wait_for_function("() => synReader.calls.some(c => c[0] === 'save')")
        page.evaluate("() => KinViewerPatientTabs.open(" + repr(URL_A) + ")")
        page.wait_for_timeout(3000)
        self.assertEqual('PK-A', page.evaluate("KinViewerPatientTabs.snapshot().key"))
        self.assertEqual(2, page.evaluate("synRemounts"))

    def test_17n_tab_clicked_twice_while_the_gate_answers_is_carried_out_once(self):
        # The gate is answered once for both clicks: the latest choice (B) is carried out, and only once.
        page = self.open(tabs=True)
        self.tabs_shown(page)
        page.evaluate("() => { synReader.answerLag = 800; }")
        tab_b = page.locator('.kin-patient-tabs [role=tab]').nth(1)
        tab_b.click()
        page.wait_for_function("() => synReader.calls.some(c => c[0] === 'save')")
        tab_b.click()
        page.wait_for_function("() => KinViewerPatientTabs.snapshot()?.key === 'PK-B'", timeout=10000)
        page.wait_for_timeout(2000)
        self.assertEqual('PK-B', page.evaluate("KinViewerPatientTabs.snapshot().key"))
        self.assertEqual(3, page.evaluate("synRemounts"))
        expect(page.locator('.kin-patient-leave')).to_be_hidden()

    def test_17o_tab_clicked_while_check_answers_is_carried_out_by_that_answer(self):
        # A switch kept by unconfirmed text; the text is then saved on the reading screen and Check is pressed; while Check
        # waits for its answer the reader clicks B's tab again: the Check answer carries out that latest choice.
        page = self.open(tabs=True)
        self.tabs_shown(page)
        page.evaluate("() => { synReader.held = ['1.2.1']; synReader.save = 'refused'; }")
        page.locator('.kin-patient-tabs [role=tab]').nth(1).click()
        notice = page.locator('.kin-patient-leave')
        expect(notice).to_contain_text('Save Not Confirmed')
        page.evaluate("() => { synReader.held = []; synReader.answerLag = 800; }")
        calls = page.evaluate("synReader.calls.length")
        notice.get_by_role('button', name='Check').click()
        page.wait_for_function("n => synReader.calls.length > n", arg=calls)
        page.locator('.kin-patient-tabs [role=tab]').nth(1).click()
        page.wait_for_function("() => KinViewerPatientTabs.snapshot()?.key === 'PK-B'", timeout=10000)
        page.wait_for_timeout(2000)
        self.assertEqual('PK-B', page.evaluate("KinViewerPatientTabs.snapshot().key"))
        self.assertEqual(3, page.evaluate("synRemounts"))
        expect(notice).to_be_hidden()

if __name__ == '__main__':
    unittest.main()
