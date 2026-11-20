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
import json
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
# right breast, left for the left breast: 240 px out from it, y 30 … 270) with a bright marker apart from it, in the corner
# at the nipple side; prior L CC has no stored orientation.
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
      render() { synRenders[id]++; event(element, 'CORNERSTONE_IMAGE_RENDERED', id); },
      show(index) { this.index = index; scalars.data = synSlices[index]; event(element, 'CORNERSTONE_STACK_NEW_IMAGE', id); } };
    views.set(id, v);
  }
  window.synViews = views;
  // The viewer's Invert tool (its I key, More › Invert): as invertViewport, the active cell's property and a new drawing,
  // and no VOI event.
  synButtons.invert = { id: 'invert', uiType: 'ohif.radioGroup', props: { label: 'Invert', commands: 'invertViewport' } }; synSection.push('invert');
  const record = synServices.toolbarService.recordInteraction;
  synServices.toolbarService.recordInteraction = (item, options) => { record(item, options);
    const v = item.itemId === 'invert' && views.get(synActive); if (v) { v.props.invert = !v.props.invert; v.render(); } };
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
  window.cornerstone = { Enums: { Events: { STACK_NEW_IMAGE: 'CORNERSTONE_STACK_NEW_IMAGE', CAMERA_MODIFIED: 'CORNERSTONE_CAMERA_MODIFIED', VOI_MODIFIED: 'CORNERSTONE_VOI_MODIFIED', IMAGE_RENDERED: 'CORNERSTONE_IMAGE_RENDERED' } },
    metaData: { get(type, imageId) { const { v, sop } = uidOf(imageId);
      // synNoInstance: the cells whose image the viewer holds no instance metadata of.
      if (type === 'instance') return window.synNoInstance?.includes(v.id) ? null
        : { SOPInstanceUID: sop, StudyInstanceUID: v.info.study, SeriesInstanceUID: v.series, Modality: v.info.modality || 'MG', NumberOfFrames: 1,
            ImageLaterality: v.info.side, ViewPosition: v.info.view === '399368009' ? 'MLO' : 'CC' };
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
    // synHeaders[cell]: another device's own header for that cell (its UIDs and size made the cell's).
    const own = window.synHeaders?.[v.id];
    if (own) return { ...structuredClone(own), '00080018': tag('UI', sop), '0020000D': tag('UI', v.info.study), '0020000E': tag('UI', v.series), '00280010': tag('US', R), '00280011': tag('US', C) };
    const item = { '00080016': tag('UI', '1.2.840.10008.5.1.4.1.1.1.2'), '00080018': tag('UI', sop), '0020000D': tag('UI', v.info.study),
      '00080060': tag('CS', 'MG'), '00200062': tag('CS', v.info.side), '00280010': tag('US', R), '00280011': tag('US', C), '00280004': tag('CS', 'MONOCHROME2'),
      '00540220': { vr: 'SQ', Value: [{ '00080100': tag('SH', v.info.view), '00080102': tag('SH', 'SCT') }] } };
    if (v.info.po) item['00200020'] = { vr: 'CS', Value: v.info.po };
    // info.extra: more elements of that image's header (a partial view, a view modifier, pixel padding).
    if (v.info.extra) Object.assign(item, structuredClone(v.info.extra));
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
  // synAsked: the cell of every header asked for. synHeld: the cells whose headers the server keeps back until
  // synRelease(); synFail: the cells whose headers it refuses (HTTP 503).
  window.synAsked = []; window.synHeld = []; window.synFail = []; window.synWaiting = [];
  window.synRelease = () => { synHeld = []; synWaiting.splice(0).forEach(resolve => resolve()); };
  const accountFetch = window.fetch;
  window.fetch = async (url, init) => {
    const path = String(url);
    const match = /^\\/dicom-web\\/studies\\/[^/]+\\/series\\/([^/]+)\\/instances\\/([^/]+)\\/metadata$/.exec(path);
    if (match) { const v = [...views.values()].find(view => view.series === match[1]); synAsked.push(v.id);
      if (synHeld.includes(v.id)) await new Promise(resolve => synWaiting.push(resolve));
      if (synFail.includes(v.id)) return new Response('', { status: 503 });
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

    # The image headers are read when the cells are given their images — here, when the toolbar is mounted. setup: a
    # script run before that (the headers as that first reading finds them: another header, a slow or a failing
    # server). read: wait until no cell is still being read (False: return while the headers are on their way).
    READ = "() => !document.querySelector('[data-kin-mg-image=reading]')"
    ALL = ['dbt', 'rcc', 'lcc', 'rmlo', 'prcc', 'plcc']
    # What a cell is called while its header is not read: the role, and the side and view the viewer itself holds.
    NAMES = {'dbt': 'Current · R CC', 'rcc': 'Current · R CC', 'lcc': 'Current · L CC', 'rmlo': 'Current · R MLO', 'prcc': 'Prior · R CC', 'plcc': 'Prior · L CC'}
    READING, UNREAD = ' · 영상을 읽는 중', ' · 영상 머리글을 읽지 못함'

    # setup scripts: the server keeps the headers of these cells back until synRelease() / refuses them (HTTP 503).
    def held(self, *cells):
        return '() => { synHeld = ' + json.dumps(list(cells)) + '; }'

    def failing(self, *cells):
        return '() => { synFail = ' + json.dumps(list(cells)) + '; }'

    # Every cell but these is read.
    def read_but(self, page, *cells):
        page.wait_for_function("n => document.querySelectorAll('[data-kin-mg-image=read]').length === n", arg=6 - len(cells))

    # The headers kept back come, and are taken.
    def release(self, page):
        page.evaluate('() => synRelease()')
        page.wait_for_function(self.READ)

    def open(self, size=(1366, 900), dpr=1, tabs=False, setup=None, read=True):
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
        if setup:
            page.evaluate(setup)
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
        if read:
            page.wait_for_function(self.READ)
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

    def test_02b_a_point_pressed_while_an_image_is_being_read_is_not_carried_there_then_or_when_its_header_comes(self):
        zooms = "() => ['rcc', 'lcc', 'prcc'].map(id => synViews.get(id).getZoom())"
        # No header has come yet: a point pressed in today's R CC is carried nowhere, and the panel says of which cell.
        page = self.open(setup=self.held(*self.ALL), read=False)
        self.menu(page, 'Mirrored')
        status = page.get_by_role('dialog', name='Mirrored').locator('[role=status]')
        expect(status).to_have_text('연동하지 않는 칸 — ' + ' / '.join(self.NAMES[cell] + self.READING for cell in self.ALL))
        self.click_cell(page, 'rcc', 50, 40)
        expect(status).to_have_text('이 칸은 연동할 수 없습니다: Current · R CC' + self.READING)
        self.assertEqual([1, 1, 1], page.evaluate(zooms))
        # The headers come: the marks are those of the cells as they are now; the cameras stay as they are.
        self.release(page)
        expect(status).to_have_text('연동하지 않는 칸 — Prior · L CC: orientation unverified')
        expect(page.locator('#pane-plcc [data-mg-badge=mirrored]')).to_have_text('Mirrored: orientation unverified — not linked')
        page.wait_for_timeout(200)
        self.assertEqual([1, 1, 1], page.evaluate(zooms))
        # Pressed again, the point is carried.
        self.click_cell(page, 'rcc', 50, 40)
        self.assertEqual([2, 2, 2], page.evaluate(zooms))
        self.assertNear(self.camera(page, 'lcc')['focal'], [299.5, 79.5])
        # Only a linked cell is still being read (the prior R CC): a point, the reader's zoom and the reader's Invert
        # are carried to the cells read, that cell is left as it is and named at once, and nothing is carried to it
        # when its header comes.
        page = self.open(setup=self.held('prcc'), read=False)
        self.read_but(page, 'prcc')
        self.menu(page, 'Mirrored')
        status = page.get_by_role('dialog', name='Mirrored').locator('[role=status]')
        inverts = "() => ['rcc', 'lcc', 'prcc'].map(id => synViews.get(id).props.invert)"
        self.click_cell(page, 'rcc', 50, 40)
        self.assertEqual([2, 2, 1], page.evaluate(zooms))
        expect(status).to_have_text('연동하지 않는 칸 — Prior · R CC' + self.READING + ' / Prior · L CC: orientation unverified')
        page.evaluate("() => { synViews.get('lcc').setCamera({ parallelScale: 50, focalPoint: [320, 100, 0] }); synActive = 'rcc'; synToolbar.invoke('invert'); }")
        self.assertEqual([3, 3, 1], page.evaluate(zooms))
        self.assertEqual([True, True, False], page.evaluate(inverts))
        self.release(page)
        expect(status).to_have_text('연동하지 않는 칸 — Prior · L CC: orientation unverified')
        page.wait_for_timeout(200)
        self.assertEqual([3, 3, 1], page.evaluate(zooms))
        self.assertEqual([True, True, False], page.evaluate(inverts))
        # What the reader does next is carried to it too.
        page.evaluate("() => synViews.get('lcc').setCamera({ parallelScale: 75, focalPoint: [320, 100, 0] })")
        self.assertEqual([2, 2, 2], page.evaluate(zooms))

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
        # The reader's Invert in one cell inverts the same view's others (Invert together), and not the MLO.
        page.evaluate("() => { synActive = 'rcc'; synToolbar.invoke('invert'); }")
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

    def test_03b_mirrored_follows_no_change_a_display_rule_makes_and_writes_over_no_cell_a_rule_is_being_put_on(self):
        page = self.open()
        # Display Set Presets' rule handle (viewer-features-view.js cellRules.setting): the cells a rule is being put on now.
        page.evaluate("() => { window.synRuled = new Set(); window.KinViewerCellRules = { setting: id => synRuled.has(id) }; }")
        self.menu(page, 'Mirrored')
        start = {cell: self.camera(page, cell) for cell in ['rcc', 'prcc']}
        # A rule puts its own zoom, pan and inversion on today's L CC: no other cell follows.
        page.evaluate("""() => { synRuled.add('lcc'); const v = synViews.get('lcc');
          v.setCamera({ parallelScale: 50, focalPoint: [320, 100, 0] }); v.setProperties({ invert: true }); synRuled.delete('lcc'); }""")
        page.wait_for_timeout(200)
        self.assertEqual(start, {cell: self.camera(page, cell) for cell in ['rcc', 'prcc']})
        # While a rule is being put on today's R CC the reader zooms L CC: R CC is left to the rule, the prior R CC follows.
        page.evaluate("() => { synRuled.add('rcc'); synViews.get('lcc').setCamera({ parallelScale: 25, focalPoint: [320, 100, 0] }); synRuled.delete('rcc'); }")
        self.assertAlmostEqual(6, self.camera(page, 'prcc')['zoom'])
        self.assertEqual(start['rcc'], self.camera(page, 'rcc'))
        # The reader's own change afterwards is followed again.
        page.evaluate("() => synViews.get('lcc').setCamera({ parallelScale: 50, focalPoint: [320, 100, 0] })")
        self.assertAlmostEqual(3, self.camera(page, 'rcc')['zoom'])

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
        # The breast of R CC as it was made is x 160 … 400, y 31 … 270; its chest-wall upper quarter is x 280 … 400, y 31 … 150.5.
        quarter = self.quarter('rcc', 0)
        self.assertEqual({'x0': 280, 'x1': 400, 'y0': 31, 'y1': 150.5}, quarter)
        self.assertAlmostEqual(self.fit(quarter), self.camera(page, 'rcc')['zoom'], places=6)
        self.assertClose(self.camera(page, 'rcc')['focal'], self.centre(quarter))
        # The left breast's step 1 is the mirrored half (its chest wall is at the left).
        self.assertLess(self.camera(page, 'lcc')['focal'][0], 200)
        expect(page.locator('#pane-plcc [data-mg-badge=quadrant]')).to_have_text('Quadrant: orientation unverified')
        heads = []
        for _ in range(3):
            panel.get_by_role('button', name='Next Quadrant').click()
            heads.append(panel.locator('b').text_content())
        self.assertEqual(['Quadrant 2/4: Upper-Inner (R/L matched)', 'Quadrant 3/4: Lower-Inner (R/L matched)',
                          'Quadrant 4/4: Lower-Outer (R/L matched)'], heads)
        # Step 4 on R CC: the upper nipple-side quarter of the box (x 160 … 280, y 31 … 150.5).
        last = self.centre(self.quarter('rcc', 3))
        self.assertEqual([219.5, 90.25], last)
        page.wait_for_function("([x, y]) => Math.abs(synViews.get('rcc').camera.focalPoint[0] - x) < 1e-6 && Math.abs(synViews.get('rcc').camera.focalPoint[1] - y) < 1e-6", arg=last)
        panel.get_by_role('button', name='Close').click()
        page.wait_for_function("() => Math.abs(synViews.get('rcc').getZoom() - 1) < 1e-9")
        self.assertNear(self.camera(page, 'lcc')['focal'], [199.5, 149.5])

    # The breast of each cell as its phantom was made (CELLS): the pixels of a half-ellipse 240 px out from the chest wall
    # (the stored right border x 400 for the right breast, the stored left border x 0 for the left) and 120 px up and
    # down from y 150 — for the right breast the pixels x 160 … 399, y 31 … 269, for the left x 0 … 240, y 30 … 270 —
    # as a box of pixel edges. What the tests expect of a box, a quarter or a fit is worked out from this, never from
    # what the product found.
    BOX = {'R': {'x0': 160, 'x1': 400, 'y0': 31, 'y1': 270}, 'L': {'x0': 0, 'x1': 241, 'y0': 30, 'y1': 271}}
    SIDE = {'dbt': 'R', 'rcc': 'R', 'lcc': 'L', 'rmlo': 'R', 'prcc': 'R', 'plcc': 'L'}
    # The four steps: CC goes outer-chest, inner-chest, inner-nipple, outer-nipple; MLO upper-chest, upper-nipple,
    # lower-nipple, lower-chest ((upper half, chest-wall half) of the box at each step).
    STEPS = {'cc': [(True, True), (False, True), (False, False), (True, False)], 'mlo': [(True, True), (True, False), (False, False), (False, True)]}

    def quarter(self, cell, step):
        box, (top, chest) = self.BOX[self.SIDE[cell]], self.STEPS['mlo' if cell == 'rmlo' else 'cc'][step]
        xm, ym = (box['x0'] + box['x1']) / 2, (box['y0'] + box['y1']) / 2
        # The chest wall is the stored right for the right breast, the stored left for the left.
        right = chest == (self.SIDE[cell] == 'R')
        return {'x0': xm if right else box['x0'], 'x1': box['x1'] if right else xm, 'y0': box['y0'] if top else ym, 'y1': ym if top else box['y1']}

    # The camera's focal point (image index) that shows the middle of a box (pixel edges).
    def centre(self, box):
        return [(box['x0'] + box['x1']) / 2 - 0.5, (box['y0'] + box['y1']) / 2 - 0.5]

    # The zoom that fits a box in the 200 × 150 cell as Fit Breast does (2 % margin; Fit shows 0.5 CSS px per image pixel),
    # and the screen length of its chest-wall-to-nipple side at that zoom.
    def fit(self, box):
        return min(200 / (box['x1'] - box['x0']), 150 / (box['y1'] - box['y0'])) * 0.98 / 0.5

    def fitted_length(self, box):
        return self.fit(box) * 0.5 * (box['x1'] - box['x0'])

    def assertClose(self, actual, expected, delta=1e-6):
        self.assertEqual(len(actual), len(expected))
        for a, b in zip(actual, expected):
            self.assertAlmostEqual(a, b, delta=delta, msg=f'{actual} != {expected}')

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
            want = {cell: self.centre(self.quarter(cell, step)) for cell in cells}
            page.wait_for_function("([ids, want]) => ids.every(id => { const f = synViews.get(id).camera.focalPoint; return Math.abs(f[0] - want[id][0]) < 1e-6 && Math.abs(f[1] - want[id][1]) < 1e-6; })",
                                   arg=[cells, want])
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
        rcc = self.BOX['R']
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

    def test_07e_tomo_opened_while_a_dbt_cell_is_being_read_names_it_takes_no_other_cell_and_opens_nothing_when_its_header_comes(self):
        page = self.open(setup=self.held('dbt'), read=False)
        self.read_but(page, 'dbt')
        page.evaluate("() => { synActive = 'dbt'; }")
        self.menu(page, 'Tomo (DBT) Slices')
        panel = page.get_by_role('dialog', name='Tomo (DBT) Slices')
        unknown = 'DBT(유방 단층) 칸인지 확인하지 못했습니다 — Current · R CC'
        expect(panel.locator('[role=status]')).to_have_text(unknown + self.READING + '. 다시 여세요.')
        expect(panel.locator('b')).to_have_text('Slice — / —')
        expect(panel.get_by_role('button', name='Next ▶')).to_be_disabled()
        # Its header comes: the panel stays as it was opened.
        self.release(page)
        page.wait_for_timeout(200)
        expect(panel.locator('[role=status]')).to_have_text(unknown + self.READING + '. 다시 여세요.')
        expect(panel.locator('b')).to_have_text('Slice — / —')
        # Opened again, it is the DBT cell.
        panel.get_by_role('button', name='Close').click()
        self.menu(page, 'Tomo (DBT) Slices')
        panel = page.get_by_role('dialog', name='Tomo (DBT) Slices')
        expect(panel.locator('b')).to_have_text('Slice 1 / 12')
        # The cell is given other images while Tomo is open: it stops, and says so.
        page.evaluate("() => { const v = synViews.get('dbt'); v.ids = ['img:dbt:20', 'img:dbt:21', 'img:dbt:22']; synEmit('cells', 'data', { viewportId: 'dbt' }); }")
        expect(panel.locator('[role=status]')).to_have_text('칸의 영상이 바뀌어 멈췄습니다. 다시 여세요.')
        expect(panel.get_by_role('button', name='Next ▶')).to_be_disabled()
        # The only DBT cell's header cannot be read (HTTP 503): the panel says so, not that there is no DBT cell.
        page = self.open(setup=self.failing('dbt'))
        page.evaluate("() => { synActive = 'dbt'; }")
        self.menu(page, 'Tomo (DBT) Slices')
        expect(page.get_by_role('dialog', name='Tomo (DBT) Slices').locator('[role=status]')).to_have_text(unknown + self.UNREAD + '. 다시 여세요.')
        # Two DBT cells (today's, and the prior R CC as one), today's chosen and still being read: Tomo does not take
        # the prior one in its place — nothing is opened, and today's cell is named.
        second = "const p = synViews.get('prcc'); p.info.slices = 12; p.ids = Array.from({ length: 12 }, (_, k) => 'img:prcc:' + k);"
        page = self.open(setup="() => { " + second + " synHeld = ['dbt']; }", read=False)
        self.read_but(page, 'dbt')
        page.evaluate("() => { synActive = 'dbt'; }")
        self.menu(page, 'Tomo (DBT) Slices')
        panel = page.get_by_role('dialog', name='Tomo (DBT) Slices')
        expect(panel.locator('[role=status]')).to_have_text(unknown + self.READING + '. 다시 여세요.')
        expect(panel.locator('b')).to_have_text('Slice — / —')
        self.assertEqual([0, 0], page.evaluate("() => ['dbt', 'prcc'].map(id => synViews.get(id).index)"))
        # Read, and opened again: Next steps the cell chosen, not the other.
        self.release(page)
        panel.get_by_role('button', name='Close').click()
        self.menu(page, 'Tomo (DBT) Slices')
        panel = page.get_by_role('dialog', name='Tomo (DBT) Slices')
        panel.get_by_role('button', name='Next ▶').click()
        expect(panel.locator('b')).to_have_text('Slice 2 / 12')
        self.assertEqual([1, 0], page.evaluate("() => ['dbt', 'prcc'].map(id => synViews.get(id).index)"))
        # The cell chosen is a DBT cell that is read; the other DBT cell is still being read: the chosen one is taken.
        page = self.open(setup="() => { " + second + " synHeld = ['prcc']; }", read=False)
        self.read_but(page, 'prcc')
        page.evaluate("() => { synActive = 'dbt'; }")
        self.menu(page, 'Tomo (DBT) Slices')
        panel = page.get_by_role('dialog', name='Tomo (DBT) Slices')
        expect(panel.locator('b')).to_have_text('Slice 1 / 12')
        panel.get_by_role('button', name='Next ▶').click()
        self.assertEqual([1, 0], page.evaluate("() => ['dbt', 'prcc'].map(id => synViews.get(id).index)"))

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

    def test_10d_another_screen_takes_only_the_cells_true_size_still_stands_on(self):
        page = self.open()
        self.menu(page, 'Breast Display')
        panel = page.get_by_role('dialog', name='Breast Display')
        panel.get_by_role('button', name='True Size').click()
        pitch = panel.get_by_label('Monitor pixel pitch (mm)')
        pitch.fill('0.25'); pitch.press('Tab')
        page.wait_for_function("() => Math.abs(synViews.get('rcc').getZoom() - 0.8) < 1e-9")
        # Since then the reader zoomed today's L CC, the prior R CC was given another stack and zoomed, and Quadrant
        # Zoom took today's R MLO... (here: its own zoom by the reader)
        page.evaluate("""() => { synViews.get('lcc').setZoom(3);
          const v = synViews.get('prcc'); v.ids = ['img:prcc:0', 'img:prcc:1']; synEmit('cells', 'data', { viewportId: 'prcc' }); v.setZoom(2); }""")
        expect(page.locator('#pane-lcc [data-mg-badge=zoom]')).to_have_count(0)
        expect(page.locator('#pane-prcc [data-mg-badge=zoom]')).to_have_count(0)
        zooms = "() => ['rcc', 'lcc', 'prcc', 'rmlo'].map(id => Math.round(synViews.get(id).getZoom() * 1e6) / 1e6)"
        # The window is now on a screen placed to the right with a value stored for it (0.5 mm): True Size is worked
        # out again where it still stands, and nowhere else.
        screen = """offset => { const s = window.synScreen || (window.synScreen = { width: window.screen.width, height: window.screen.height });
          const next = { width: s.width, height: s.height, availLeft: s.width * offset, availTop: 0, addEventListener() {} };
          if (offset === 1) localStorage.setItem('kin-mg-monitor-pitch:v1', JSON.stringify({ ...JSON.parse(localStorage.getItem('kin-mg-monitor-pitch:v1')), [KinMgBreastModel.monitorKey(next)]: 0.5 }));
          Object.defineProperty(window, 'screen', { configurable: true, value: next }); dispatchEvent(new Event('resize')); }"""
        page.evaluate(screen, 1)
        self.assertEqual([0.4, 3, 2, 0.4], page.evaluate(zooms))
        expect(page.locator('#pane-rcc [data-mg-badge=zoom]')).to_have_text('Zoom mode: True Size (at detector)')
        # … and on one with no value stored: those cells go back to Fit, the value is asked for, the others stay.
        page.evaluate(screen, 2)
        self.assertEqual([1, 3, 2, 1], page.evaluate(zooms))
        expect(page.locator('#pane-rcc [data-mg-badge=zoom]')).to_have_text('Zoom mode: Fit')
        expect(page.locator('#pane-lcc [data-mg-badge=zoom]')).to_have_count(0)
        expect(pitch).to_be_visible()
    def test_08_breast_edge_and_breast_wl_with_the_way_back_to_the_stored_window_table_and_inversion(self):
        page = self.open()
        page.evaluate("() => { const v = synViews.get('rcc'); v.props.invert = true; v.props.VOILUTFunction = 'SIGMOID'; v.tf.nodes = [[0, 1, 1, 1, 0.5, 0], [100, 0.7, 0.7, 0.7, 0.5, 0], [4095, 0, 0, 0, 0.5, 0]]; }")
        before = page.evaluate("() => ({ props: synViews.get('rcc').getProperties(), nodes: structuredClone(synViews.get('rcc').tf.nodes) })")
        self.menu(page, 'Breast Display')
        panel = page.get_by_role('dialog', name='Breast Display')
        expect(panel.get_by_role('button')).to_have_text(['Breast Edge', 'Breast W/L', 'Fit', '1:1', 'True Size', 'Fit Breast', 'Match Size', 'Close'])
        unverified = page.evaluate("() => ({ props: synViews.get('plcc').getProperties(), nodes: structuredClone(synViews.get('plcc').tf.nodes) })")
        panel.get_by_role('button', name='Breast Edge').click()
        # Five cells say where their chest wall is stored; the prior L CC has no stored orientation: no line is drawn
        # there, the cell is marked and named, and the button does not say the edges were drawn.
        page.wait_for_function("() => document.querySelectorAll('.kin-mg-outline').length === 5")
        self.assertGreater(int(page.locator('#pane-rcc .kin-mg-outline').get_attribute('data-points')), 20)
        expect(page.locator('#pane-plcc .kin-mg-outline')).to_have_count(0)
        expect(page.locator('#pane-plcc [data-mg-badge=edge]')).to_have_text('경계를 찾지 못했습니다')
        expect(panel.locator('[role=status]')).to_have_text('경계를 찾지 못한 칸 — Prior · L CC')
        panel.get_by_role('button', name='Breast W/L').click()
        expect(page.locator('#pane-rcc [data-mg-badge=wl]')).to_have_text('Breast W/L')
        voi = page.evaluate("() => synViews.get('rcc').getProperties()")
        self.assertEqual('LINEAR', voi['VOILUTFunction'])
        # The 1–99 percentiles of the breast's own pixels (the tissue was made 1000 … 1049; the air is 40 and the marker
        # 3000): no air and no marker in it. The inversion stays as the reader had it.
        self.assertGreaterEqual(voi['voiRange']['lower'], 1000); self.assertLessEqual(voi['voiRange']['lower'], 1001)
        self.assertGreaterEqual(voi['voiRange']['upper'], 1047); self.assertLessEqual(voi['voiRange']['upper'], 1049)
        self.assertTrue(voi['invert'])
        # The cell without a region keeps its window, and is marked and named.
        expect(page.locator('#pane-plcc [data-mg-badge=wl]')).to_have_text('Breast W/L: 경계를 찾지 못했습니다')
        expect(panel.locator('[role=status]')).to_have_text('경계를 찾지 못해 창을 바꾸지 않은 칸 — Prior · L CC')
        self.assertEqual(unverified, page.evaluate("() => ({ props: synViews.get('plcc').getProperties(), nodes: structuredClone(synViews.get('plcc').tf.nodes) })"))
        panel.get_by_role('button', name='Breast W/L').click()
        expect(page.locator('[data-mg-badge=wl]')).to_have_count(0)
        self.assertEqual(before, page.evaluate("() => ({ props: synViews.get('rcc').getProperties(), nodes: structuredClone(synViews.get('rcc').tf.nodes) })"))
        panel.get_by_role('button', name='Breast Edge').click()
        expect(page.locator('.kin-mg-outline')).to_have_count(0)
        expect(page.locator('[data-mg-badge=edge]')).to_have_count(0)
        # With every cell's edge found, the button says so — after they are drawn.
        page.evaluate("() => { document.getElementById('pane-plcc').remove(); delete synShown.plcc; }")
        panel.get_by_role('button', name='Breast Edge').click()
        expect(panel.locator('[role=status]')).to_have_text('유방 경계를 그렸습니다. 다시 누르면 지웁니다.')
        self.assertEqual(5, page.locator('.kin-mg-outline').count())

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
        # The breast as it was made (240 × 239 image px), fitted in the 200 × 150 cell with the 2 % margin and centred.
        box = self.BOX['R']
        self.assertAlmostEqual(self.fit(box), self.camera(page, 'rcc')['zoom'], places=6)
        self.assertClose(self.camera(page, 'rcc')['focal'], self.centre(box))
        expect(page.locator('#pane-rcc [data-mg-badge=zoom]')).to_have_text('Zoom mode: Fit Breast')
        # The prior L CC (no stored orientation) has no region: it is left as it is (at 1:1, as its mark still says), and named.
        expect(page.locator('#pane-plcc [data-mg-badge=zoom]')).to_have_text('Zoom mode: 1:1')
        self.assertAlmostEqual(1, self.camera(page, 'plcc')['zoom'])
        expect(panel.locator('[role=status]')).to_have_text('바꾸지 않은 칸 — Prior · L CC')
        # Match Size: the CC cells with a region (the right breasts were made 240 px from chest wall to nipple, the left
        # 241) at the longest length every one of them shows whole in its cell: the least of the lengths Fit Breast would
        # show them at. At zoom z a cell shows a breast w image px long at z × 0.5 × w CSS px.
        page.evaluate("() => { synViews.get('dbt').setZoom(1); synViews.get('plcc').setZoom(1.75); synViews.get('lcc').setZoom(1); synViews.get('prcc').setZoom(2); synViews.get('rcc').setZoom(1.5); }")
        panel.get_by_role('button', name='Match Size').click()
        page.wait_for_function("() => document.querySelector('#pane-prcc [data-mg-badge=zoom]')?.textContent === 'Zoom mode: Match Size'")
        matched = ['dbt', 'rcc', 'lcc', 'prcc']
        zooms = page.evaluate("ids => ids.map(id => synViews.get(id).getZoom())", matched)
        boxes = [self.BOX[self.SIDE[cell]] for cell in matched]
        least = min(self.fitted_length(box) for box in boxes)
        self.assertAlmostEqual(self.fitted_length(self.BOX['L']), least)
        for zoom, box in zip(zooms, boxes):
            # The shown length is the same in every cell.
            self.assertAlmostEqual(least, zoom * 0.5 * (box['x1'] - box['x0']), places=6)
        # The cell without a region takes no part: not matched, its zoom kept, no Match Size mark, and named.
        self.assertAlmostEqual(1.75, self.camera(page, 'plcc')['zoom'])
        expect(page.locator('#pane-plcc [data-mg-badge=zoom]')).to_have_count(0)
        expect(panel.locator('[role=status]')).to_have_text('경계를 찾지 못해 맞추지 않은 칸 — Prior · L CC')
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

    # ── The breast and the cell as the viewer draws them ──
    # As the shipped cell: a 42 px header row on top of the pane, the image (viewport element) under it.
    HEADER = """() => { for (const pane of document.querySelectorAll('[data-cy=viewport-pane]')) {
      pane.style.height = '192px';
      const head = document.createElement('div'); head.className = 'syn-head'; head.style.cssText = 'position:absolute;left:0;right:0;top:0;height:42px'; pane.prepend(head);
      pane.querySelector('.viewport-element').style.cssText = 'position:absolute;left:0;right:0;top:42px;height:150px'; } }"""
    # A processed screening MG: background 0, a band of fat (20 ± 6) inside the skin, dense tissue (600) only in the middle.
    FATTY = """ids => { const C = 400, R = 300;
      for (const id of ids) { const v = synViews.get(id), right = v.info.side === 'R', values = new Uint16Array(C * R);
        for (let y = 0; y < R; y++) for (let x = 0; x < C; x++) {
          const dx = (x - (right ? C : 0)) / (C * 0.6), dy = (y - R / 2) / (R * 0.4), r = dx * dx + dy * dy;
          values[y * C + x] = r <= 1 ? (r <= 0.3 ? 600 : 20 + ((x * 7 + y * 13) % 13) - 6) : 0; }
        v.imageDataObject.getPointData().getScalars().setData(values); } }"""
    # The skin line of those cells (the ellipse's ends) on each cell's canvas: { id: [left, top, right, bottom] }.
    SKIN = """ids => Object.fromEntries(ids.map(id => { const v = synViews.get(id), right = v.info.side === 'R', cx = right ? 400 : 0;
      const p = [[cx - 240, 150], [cx + 240, 150], [right ? 399 : 0, 30], [right ? 399 : 0, 270]].map(([x, y]) => v.worldToCanvas([Math.min(399, Math.max(0, x)), y, 0]));
      return [id, [Math.min(...p.map(q => q[0])), Math.min(...p.map(q => q[1])), Math.max(...p.map(q => q[0])), Math.max(...p.map(q => q[1]))]]; }))"""

    # A GE synthetic 2D view (Senographe Pristina V-Preview, a one-frame breast tomosynthesis object marked GENERATED_2D):
    # the synthetic header of the vendor rule case VENDOR-GE-GENERATED-BTO12, R CC.
    GE_SYNTHETIC_2D = r'''{"20500020":{"vr":"CS","Value":["IDENTITY"]},"52009229":{"vr":"SQ","Value":[{"00289110":{"vr":"SQ","Value":[{"00280030":{"vr":"DS","Value":[0.085,0.085]},"00180050":{"vr":"DS","Value":[1]}}]},"00209116":{"vr":"SQ","Value":[{"00200037":{"vr":"DS","Value":[0,1,0,1,0,0]}}]},"00289132":{"vr":"SQ","Value":[{"00281050":{"vr":"DS","Value":[733]},"00281051":{"vr":"DS","Value":[1300]}}]},"00209071":{"vr":"SQ","Value":[{"00209072":{"vr":"CS","Value":["R"]}}]},"00289145":{"vr":"SQ","Value":[{"00281052":{"vr":"DS","Value":[0]},"00281053":{"vr":"DS","Value":[1]},"00281054":{"vr":"LO","Value":["US"]}}]}}]},
      "52009230":{"vr":"SQ","Value":[{"00209113":{"vr":"SQ","Value":[{"00200032":{"vr":"DS","Value":[0,0,0]}}]},"00189504":{"vr":"SQ","Value":[{"00089007":{"vr":"CS","Value":["DERIVED","PRIMARY","TOMOSYNTHESIS","GENERATED_2D"]},"00089206":{"vr":"CS","Value":["SAMPLED"]},"00089207":{"vr":"CS","Value":["TOMOSYNTHESIS"]},"00089205":{"vr":"CS","Value":["MONOCHROME"]}}]},"00209111":{"vr":"SQ","Value":[{"00209057":{"vr":"UL","Value":[1]},"00209056":{"vr":"SH","Value":["1"]}}]}}]},
      "00080016":{"vr":"UI","Value":["1.2.840.10008.5.1.4.1.1.13.1.3"]},"00080060":{"vr":"CS","Value":["MG"]},"00080008":{"vr":"CS","Value":["DERIVED","PRIMARY","TOMOSYNTHESIS","GENERATED_2D"]},
      "00080070":{"vr":"LO","Value":["GE MEDICAL SYSTEMS"]},"00081090":{"vr":"LO","Value":["Senographe Pristina"]},"00181020":{"vr":"LO","Value":["10.x"]},
      "00100020":{"vr":"LO","Value":["SYNTHETIC-MG-VENDOR"]},"00100010":{"vr":"PN","Value":[{"Alphabetic":"VENDOR^PHANTOM"}]},"00100030":{"vr":"DA","Value":["19700101"]},"00080020":{"vr":"DA","Value":["20261030"]},"00080030":{"vr":"TM","Value":["120000"]},
      "00200013":{"vr":"IS","Value":[1]},"00200011":{"vr":"IS","Value":[1]},"00200052":{"vr":"UI","Value":["2.25.2026103019.9"]},"00200062":{"vr":"CS","Value":["R"]},"00200060":{"vr":"CS","Value":["R"]},"00185101":{"vr":"CS","Value":["CC"]},"00281350":{"vr":"CS","Value":["NO"]},
      "00540220":{"vr":"SQ","Value":[{"00080102":{"vr":"SH","Value":["SCT"]},"00080100":{"vr":"SH","Value":["399162004"]},"00080104":{"vr":"LO","Value":["cranio-caudal"]}}]},
      "00280002":{"vr":"US","Value":[1]},"00280100":{"vr":"US","Value":[16]},"00280101":{"vr":"US","Value":[12]},"00280102":{"vr":"US","Value":[11]},"00280103":{"vr":"US","Value":[0]},"00280004":{"vr":"CS","Value":["MONOCHROME2"]},
      "00200020":{"vr":"CS","Value":["P","L"]},"00280030":{"vr":"DS","Value":[0.085,0.085]},"00181164":{"vr":"DS","Value":[0.085,0.085]},"00280008":{"vr":"IS","Value":[1]},
      "00089206":{"vr":"CS","Value":["SAMPLED"]},"00089207":{"vr":"CS","Value":["TOMOSYNTHESIS"]},"00089205":{"vr":"CS","Value":["MONOCHROME"]}}'''

    def test_04b_magnifier_under_the_cell_header_row_magnifies_the_place_pressed_in_every_linked_cell(self):
        page = self.open()
        page.evaluate(self.HEADER)
        # A red dot on today's R CC at canvas (50, 40) and on today's L CC at its counterpart (150, 40); black elsewhere.
        page.evaluate("""() => { for (const [id, x] of [['rcc', 50], ['lcc', 150], ['prcc', 50]]) { const g = synViews.get(id).canvas.getContext('2d');
          g.fillStyle = '#000'; g.fillRect(0, 0, 200, 150); g.fillStyle = '#f00'; g.fillRect(x - 3, 37, 6, 6); } }""")
        self.menu(page, 'Mirrored')
        page.wait_for_function("() => document.querySelector('#pane-plcc [data-mg-badge=mirrored]')")
        self.menu(page, 'Magnifier')
        image = page.locator('#pane-rcc .viewport-element').bounding_box()
        page.mouse.move(image['x'] + 50, image['y'] + 40); page.mouse.down()
        expect(page.locator('#pane-lcc .kin-mg-lens')).to_have_count(1)
        expect(page.locator('#pane-prcc .kin-mg-lens')).to_have_count(1)
        for cell, at in [('rcc', [50, 40]), ('lcc', [150, 40]), ('prcc', [50, 40])]:
            self.assertEqual(','.join(map(str, at)), page.locator('#pane-' + cell + ' .kin-mg-lens').get_attribute('data-at'))
            # The lens stands on that place of the image, and what it shows in its middle is that place (the red dot).
            lens, own = page.locator('#pane-' + cell + ' .kin-mg-lens').bounding_box(), page.locator('#pane-' + cell + ' .viewport-element').bounding_box()
            self.assertAlmostEqual(own['x'] + at[0], lens['x'] + lens['width'] / 2, delta=1)
            self.assertAlmostEqual(own['y'] + at[1], lens['y'] + lens['height'] / 2, delta=1)
            middle = page.evaluate("cell => { const c = document.querySelector('#pane-' + cell + ' .kin-mg-lens canvas'); return [...c.getContext('2d').getImageData(c.width / 2, c.height / 2, 1, 1).data]; }", cell)
            self.assertEqual([255, 0, 0, 255], middle, cell)
        page.mouse.up()
        # The header row is not the Magnifier's: a press there is the cell's own.
        head = page.locator('#pane-rcc .syn-head').bounding_box()
        self.assertEqual('syn-head', page.evaluate("([x, y]) => document.elementFromPoint(x, y).className", [head['x'] + 100, head['y'] + 20]))

    def test_04c_magnifier_follows_a_header_row_shown_after_it_was_turned_on_and_shows_the_cells_image_filter(self):
        page = self.open()
        page.evaluate("() => { const g = synViews.get('rcc').canvas.getContext('2d'); g.fillStyle = '#000'; g.fillRect(0, 0, 200, 150); g.fillStyle = '#f00'; g.fillRect(47, 37, 6, 6); }")
        self.menu(page, 'Magnifier')
        expect(page.locator('#pane-rcc .kin-mg-capture')).to_have_count(1)
        # The header row comes after the Magnifier was turned on; a filter is put on the cell's canvas (Display › Filter).
        page.evaluate(self.HEADER)
        page.evaluate("() => { synViews.get('rcc').canvas.style.filter = 'invert(1)'; }")
        page.wait_for_function("() => { const a = document.querySelector('#pane-rcc .kin-mg-stage').getBoundingClientRect(), b = document.querySelector('#pane-rcc .viewport-element').getBoundingClientRect(); return a.top === b.top && a.height === b.height; }")
        image = page.locator('#pane-rcc .viewport-element').bounding_box()
        page.mouse.move(image['x'] + 50, image['y'] + 40); page.mouse.down()
        lens = page.locator('#pane-rcc .kin-mg-lens')
        expect(lens).to_have_attribute('data-at', '50,40')
        # The lens shows the filtered screen (the red dot inverted), the filter not put on it a second time.
        self.assertEqual('', page.evaluate("() => document.querySelector('#pane-rcc .kin-mg-lens canvas').style.filter"))
        self.assertEqual([0, 255, 255, 255], page.evaluate("() => { const c = document.querySelector('#pane-rcc .kin-mg-lens canvas'); return [...c.getContext('2d').getImageData(c.width / 2, c.height / 2, 1, 1).data]; }"))
        page.mouse.up()

    def test_04d_a_cell_drawn_again_while_the_magnifier_is_held_shows_in_the_lens_at_once(self):
        page = self.open()
        page.evaluate("() => { const g = synViews.get('rcc').canvas.getContext('2d'); g.fillStyle = '#000'; g.fillRect(0, 0, 200, 150); g.fillStyle = '#f00'; g.fillRect(47, 37, 6, 6); }")
        self.menu(page, 'Magnifier')
        expect(page.locator('#pane-rcc .kin-mg-capture')).to_have_count(1)
        box = page.locator('#pane-rcc .viewport-element').bounding_box()
        page.mouse.move(box['x'] + 50, box['y'] + 40); page.mouse.down()
        middle = "() => { const c = document.querySelector('#pane-rcc .kin-mg-lens canvas'); return [...c.getContext('2d').getImageData(c.width / 2, c.height / 2, 1, 1).data]; }"
        page.wait_for_function("() => document.querySelector('#pane-rcc .kin-mg-lens')")
        self.assertEqual([255, 0, 0, 255], page.evaluate(middle))
        # The pointer stays; the cell is drawn again (an Invert, a window change): the lens follows without a move.
        page.evaluate("() => { const v = synViews.get('rcc'), g = v.canvas.getContext('2d'); g.fillStyle = '#00f'; g.fillRect(47, 37, 6, 6); v.render(); }")
        page.wait_for_function(middle.replace('return [...', 'const d = [...').replace('.data]; }', '.data]; return d[2] === 255 && d[0] === 0; }'))
        page.mouse.up()
        expect(page.locator('.kin-mg-lens')).to_have_count(0)

    def test_03e_every_invert_of_the_reader_is_carried_each_in_its_turn_and_reset_gives_the_inversions_back(self):
        page = self.open()
        self.menu(page, 'Mirrored')
        inverts = "() => ['rcc', 'lcc', 'prcc'].map(id => synViews.get(id).props.invert)"
        self.assertEqual([True, True, True], page.evaluate("() => { synActive = 'rcc'; synToolbar.invoke('invert'); synToolbar.invoke('invert'); synToolbar.invoke('invert'); return (" + inverts + ")(); }"))
        page.get_by_role('dialog', name='Mirrored').get_by_role('button', name='Reset').click()
        self.assertEqual([False, False, False], page.evaluate(inverts))
        page.wait_for_timeout(200)
        self.assertEqual([False, False, False], page.evaluate(inverts))

    def test_08d_breast_edge_draws_the_cells_read_at_the_press_names_the_others_and_draws_them_when_their_headers_come_while_it_is_on(self):
        page = self.open(setup=self.held('prcc'), read=False)
        self.read_but(page, 'prcc')
        self.menu(page, 'Breast Display')
        panel = page.get_by_role('dialog', name='Breast Display')
        edge = panel.get_by_role('button', name='Breast Edge')
        edge.click()
        expect(panel.locator('[role=status]')).to_have_text('경계선을 그리지 않은 칸 — Prior · R CC' + self.READING + ' / Prior · L CC')
        self.assertEqual(4, page.locator('.kin-mg-outline').count())
        # Its header comes while Breast Edge is on: its line is drawn.
        self.release(page)
        expect(page.locator('#pane-prcc .kin-mg-outline')).to_have_count(1)
        expect(page.locator('.kin-mg-outline')).to_have_count(5)
        # Turned off before the header comes: nothing is drawn when it comes.
        page = self.open(setup=self.held('prcc'), read=False)
        self.read_but(page, 'prcc')
        self.menu(page, 'Breast Display')
        edge = page.get_by_role('dialog', name='Breast Display').get_by_role('button', name='Breast Edge')
        edge.click(); edge.click()
        self.release(page)
        page.wait_for_timeout(200)
        expect(page.locator('.kin-mg-outline')).to_have_count(0)
        expect(page.locator('[data-mg-badge=edge]')).to_have_count(0)

    def test_07d_breast_edge_is_drawn_again_for_the_slab_and_for_the_slice_it_gives_back(self):
        page = self.open()
        page.evaluate("() => { synActive = 'dbt'; }")
        self.menu(page, 'Breast Display')
        page.get_by_role('dialog', name='Breast Display').get_by_role('button', name='Breast Edge').click()
        page.wait_for_function("() => document.querySelector('#pane-dbt .kin-mg-outline')")
        page.evaluate("() => { window.synOutline = document.querySelector('#pane-dbt .kin-mg-outline'); }")
        self.menu(page, 'Tomo (DBT) Slices')
        panel = page.get_by_role('dialog', name='Tomo (DBT) Slices')
        page.evaluate("() => synViews.get('dbt').show(5)")
        page.wait_for_function("() => !synOutline.isConnected && document.querySelector('#pane-dbt .kin-mg-outline')")
        page.evaluate("() => { window.synOutline = document.querySelector('#pane-dbt .kin-mg-outline'); }")
        panel.get_by_label('Slab Thickness').select_option('3')
        expect(page.locator('#pane-dbt [data-mg-badge=slab]')).to_have_text('Slab 3')
        page.wait_for_function("() => !synOutline.isConnected && document.querySelector('#pane-dbt .kin-mg-outline')")
        page.evaluate("() => { window.synOutline = document.querySelector('#pane-dbt .kin-mg-outline'); }")
        panel.get_by_label('Slab Thickness').select_option('1')
        expect(page.locator('#pane-dbt [data-mg-badge=slab]')).to_have_count(0)
        page.wait_for_function("() => !synOutline.isConnected && document.querySelector('#pane-dbt .kin-mg-outline')")

    def test_03c_mirrored_carries_the_viewers_own_invert_that_sends_no_voi_event_to_the_same_view(self):
        # Today's prior R CC is a GE synthetic 2D view (V-Preview): it is linked as any MG image is.
        page = self.open(setup='() => { window.synHeaders = { prcc: ' + self.GE_SYNTHETIC_2D + ' }; }')
        self.menu(page, 'Mirrored')
        page.wait_for_function("() => document.querySelector('#pane-plcc [data-mg-badge=mirrored]')")
        expect(page.locator('#pane-prcc [data-mg-badge=mirrored]')).to_have_count(0)
        cc = "() => ['rcc', 'lcc', 'prcc'].map(id => synViews.get(id).props.invert)"
        # The viewer's Invert by its I key on today's R CC (the property and a new drawing, no VOI event): the CC cells of
        # both sides and both exams with it; not the MLO, not the prior L CC (not linked).
        page.evaluate("() => { synActive = 'rcc'; document.activeElement?.blur?.(); }")
        page.keyboard.press('i')
        page.wait_for_function("() => synViews.get('lcc').props.invert && synViews.get('prcc').props.invert")
        self.assertEqual([True, True, True], page.evaluate(cc))
        self.assertFalse(page.evaluate("() => synViews.get('rmlo').props.invert"))
        self.assertFalse(page.evaluate("() => synViews.get('plcc').props.invert"))
        # Again from another cell of the view (the toolbar's Invert there): all of them back, once each (no echo).
        page.evaluate("() => { synActive = 'lcc'; synToolbar.invoke('invert'); }")
        page.wait_for_function("() => !synViews.get('rcc').props.invert && !synViews.get('prcc').props.invert")
        page.wait_for_timeout(200)
        self.assertEqual([False, False, False], page.evaluate(cc))
        # The act is carried, not the value: an image shown inverted by its own presentation (a MONOCHROME1 image beside
        # MONOCHROME2 ones) turns the other way too.
        page.evaluate("() => { synViews.get('prcc').setProperties({ invert: true }); }")
        page.wait_for_timeout(200)
        self.assertEqual([False, False, True], page.evaluate(cc), 'an inversion the viewer itself set is not carried')
        page.evaluate("() => { synActive = 'rcc'; synToolbar.invoke('invert'); }")
        page.wait_for_function("() => synViews.get('lcc').props.invert && !synViews.get('prcc').props.invert")
        self.assertEqual([True, True, False], page.evaluate(cc))
        # Invert together off: the reader's Invert stays in its cell.
        page.get_by_role('dialog', name='Mirrored').get_by_label('Invert together').uncheck()
        page.evaluate("() => { synActive = 'rcc'; synToolbar.invoke('invert'); }")
        page.wait_for_timeout(200)
        self.assertEqual([False, True, False], page.evaluate(cc))

    def test_02c_after_match_and_unmatch_the_side_and_view_are_each_originals_and_a_merged_exams_second_original_is_current(self):
        page = self.open()
        # A window opened on exam scopes: the merged exam holds both originals as current (Match), then the second goes back
        # to being a prior exam (Unmatch).
        page.evaluate("""() => { history.replaceState(null, '', location.pathname + location.search + '&kinExamScopes=syn' + location.hash);
          window.synRoles = { '1.2.1': 'current', '1.2.2': 'current' }; KinViewerExamScope.role = study => synRoles[study] || null; }""")
        self.menu(page, 'Mirrored')
        panel = page.get_by_role('dialog', name='Mirrored')
        expect(panel.locator('[role=status]')).to_contain_text('Current · L CC: orientation unverified')
        panel.get_by_role('button', name='Close').click()
        page.evaluate("() => { synRoles['1.2.2'] = 'prior'; }")
        self.menu(page, 'Mirrored')
        expect(page.get_by_role('dialog', name='Mirrored').locator('[role=status]')).to_contain_text('Prior · L CC: orientation unverified')
        # The side and the view stay each original's own: a point on the merged exam's R CC goes to its L CC mirrored.
        self.click_cell(page, 'prcc', 50, 40)
        page.wait_for_function("() => Math.abs(synViews.get('lcc').getZoom() - 2) < 1e-9")
        self.assertNear(self.camera(page, 'lcc')['focal'], [299.5, 79.5])

    def test_08c_breast_edge_lies_on_the_image_under_the_cell_header_row_and_on_the_skin_line_through_the_fat(self):
        page = self.open()
        page.evaluate(self.HEADER)
        page.evaluate(self.FATTY, ['rcc', 'lcc'])
        self.menu(page, 'Breast Display')
        page.get_by_role('dialog', name='Breast Display').get_by_role('button', name='Breast Edge').click()
        page.wait_for_function("() => document.querySelectorAll('.kin-mg-outline').length === 5")
        for cell in ['rcc', 'lcc']:
            outline, own = page.locator('#pane-' + cell + ' .kin-mg-outline').bounding_box(), page.locator('#pane-' + cell + ' .viewport-element').bounding_box()
            self.assertEqual(own, outline)
            # The line reaches the skin (the ellipse's far end at canvas x 80 for R, 120 for L, mid height 75), not the
            # dense middle only.
            far = 80 if cell == 'rcc' else 120
            drawn = page.evaluate("""([cell, far]) => { const c = document.querySelector('#pane-' + cell + ' .kin-mg-outline'), r = c.width / 200;
              const d = c.getContext('2d').getImageData(Math.round((far - 6) * r), Math.round(75 * r), Math.round(12 * r), 1).data;
              let hit = false; for (let i = 3; i < d.length; i += 4) if (d[i] > 0) hit = true; return hit; }""", [cell, far])
            self.assertTrue(drawn, cell)

    def test_09b_fit_breast_and_match_size_keep_the_whole_breast_through_the_fat_and_match_the_lengths(self):
        # All four CC cells are matched: here the prior L CC too says how it is stored (chest wall at the stored left).
        page = self.open(setup="() => { window.synHeaders = { prcc: " + self.GE_SYNTHETIC_2D + " }; synViews.get('plcc').info.po = ['A', 'R']; }")
        page.evaluate(self.HEADER)
        cc = ['rcc', 'lcc', 'prcc', 'plcc']
        page.evaluate(self.FATTY, cc)
        self.menu(page, 'Breast Display')
        panel = page.get_by_role('dialog', name='Breast Display')
        panel.get_by_role('button', name='Fit Breast').click()
        page.wait_for_function("() => document.querySelector('#pane-prcc [data-mg-badge=zoom]')?.textContent === 'Zoom mode: Fit Breast'")
        skin = page.evaluate(self.SKIN, cc)
        for cell in cc:
            left, top, right, bottom = skin[cell]
            # The whole breast is in the cell (200 × 150), and it fills it one way (the 2 % margin).
            self.assertTrue(left >= -0.5 and top >= -0.5 and right <= 200.5 and bottom <= 150.5, (cell, skin[cell]))
            self.assertGreater(max((right - left) / 200, (bottom - top) / 150), 0.9, (cell, skin[cell]))
        # Match Size from another zoom: the same chest-wall-to-nipple length on screen in all four CC cells, every breast whole.
        page.evaluate("() => { synViews.get('lcc').setZoom(3); synViews.get('prcc').setZoom(0.5); }")
        panel.get_by_role('button', name='Match Size').click()
        page.wait_for_function("() => document.querySelector('#pane-prcc [data-mg-badge=zoom]')?.textContent === 'Zoom mode: Match Size'")
        skin = page.evaluate(self.SKIN, cc)
        lengths = [skin[c][2] - skin[c][0] for c in cc]
        for length in lengths:
            self.assertAlmostEqual(lengths[0], length, delta=2.5)
        for cell in cc:
            left, top, right, bottom = skin[cell]
            self.assertTrue(left >= -0.5 and top >= -0.5 and right <= 200.5 and bottom <= 150.5, (cell, skin[cell]))
        self.assertGreater(lengths[0], 100)
        # A cell whose scale cannot be read is left as it is, and the status says so (not that every cell was matched).
        page.evaluate("() => { const v = synViews.get('lcc'); v.synWorldToCanvas = v.worldToCanvas; v.worldToCanvas = () => [NaN, NaN]; }")
        panel.get_by_role('button', name='Match Size').click()
        expect(panel.locator('[role=status]')).to_contain_text('Current · L CC')
        # A cell of no height (its breast cannot be fitted in it) sets no length: the others keep theirs, and it is named.
        page.evaluate("() => { const v = synViews.get('lcc'); v.worldToCanvas = v.synWorldToCanvas; v.setZoom(0.25); v.element.style.height = '0px'; }")
        page.evaluate("() => { document.querySelector('#pane-prcc [data-mg-badge=zoom]').textContent = ''; }")
        panel.get_by_role('button', name='Match Size').click()
        page.wait_for_function("() => document.querySelector('#pane-prcc [data-mg-badge=zoom]')?.textContent === 'Zoom mode: Match Size'")
        expect(panel.locator('[role=status]')).to_contain_text('Current · L CC')
        skin = page.evaluate(self.SKIN, ['rcc', 'prcc', 'plcc'])
        for cell in ['rcc', 'prcc', 'plcc']:
            self.assertAlmostEqual(lengths[0], skin[cell][2] - skin[cell][0], delta=2.5)

    # ── A cell without a breast region is left alone ──
    # Pixels that are not a whole breast against the chest wall (400 × 300, the chest wall where the cell's side stores it):
    # 'strip': only a strip along the chest wall; 'filled': tissue fills the image (fat with its grain, dense tissue by the
    # chest wall — no air, no skin line); 'filled-under': the same under 30 rows of 0 along the top; 'band': a breast (fat
    # 24 … 36, dense 600, air 10) 240 px out from a band of 0, 20 px wide, that lies between it and the chest-wall border.
    PIXELS = """([id, kind]) => { const C = 400, R = 300, v = synViews.get(id), right = v.info.side === 'R', values = new Uint16Array(C * R);
      for (let y = 0; y < R; y++) for (let x = 0; x < C; x++) {
        const fromChest = right ? C - 1 - x : x, grain = 20 + ((x * 7 + y * 13) % 13) - 6;
        let value = 0;
        if (kind === 'strip') value = fromChest < 3 ? 30 : 0;
        else if (kind === 'filled-under' && y < 30) value = 0;
        else if (kind === 'filled' || kind === 'filled-under') value = fromChest < 200 ? 600 : grain;
        else if (kind === 'band') { const dx = (fromChest - 20) / 240, dy = (y - 150) / 120, r = dx * dx + dy * dy;
          value = fromChest < 20 ? 0 : r <= 1 ? (r <= 0.3 ? 600 : 10 + grain) : 10; }
        values[y * C + x] = value; }
      v.imageDataObject.getPointData().getScalars().setData(values); }"""
    STATE = "ids => ids.map(id => { const v = synViews.get(id); return { camera: v.getCamera(), props: v.getProperties(), nodes: structuredClone(v.tf.nodes) }; })"

    def test_09c_a_cell_without_a_region_gets_no_line_no_window_and_no_zoom_and_is_named(self):
        # Today's R CC is a whole breast. The others are not: only a strip (the DBT cell), tissue filling the image (L CC),
        # a partial view by its header (R MLO), a magnification view by its header (prior R CC), no stored orientation
        # (prior L CC).
        page = self.open(setup="""() => { const tag = (vr, value) => ({ vr, Value: [].concat(value) });
          synViews.get('rmlo').info.extra = { '00281350': tag('CS', 'YES') };
          synViews.get('prcc').info.extra = { '00540222': { vr: 'SQ', Value: [{ '00080100': tag('SH', '399163009'), '00080102': tag('SH', 'SCT') }] } }; }""")
        page.evaluate(self.PIXELS, ['dbt', 'strip']); page.evaluate(self.PIXELS, ['lcc', 'filled'])
        others = ['dbt', 'lcc', 'rmlo', 'prcc', 'plcc']
        names = 'Current · R CC / Current · L CC / Current · R MLO / Prior · R CC / Prior · L CC'
        before = page.evaluate(self.STATE, others)
        self.menu(page, 'Breast Display')
        panel = page.get_by_role('dialog', name='Breast Display')
        status = panel.locator('[role=status]')
        panel.get_by_role('button', name='Breast Edge').click()
        expect(status).to_have_text('경계를 찾지 못한 칸 — ' + names)
        expect(page.locator('#pane-rcc .kin-mg-outline')).to_have_count(1)
        expect(page.locator('.kin-mg-outline')).to_have_count(1)
        for cell in others:
            expect(page.locator(f'#pane-{cell} [data-mg-badge=edge]')).to_have_text('경계를 찾지 못했습니다')
        panel.get_by_role('button', name='Breast W/L').click()
        expect(status).to_have_text('경계를 찾지 못해 창을 바꾸지 않은 칸 — ' + names)
        expect(page.locator('#pane-rcc [data-mg-badge=wl]')).to_have_text('Breast W/L')
        for cell in others:
            expect(page.locator(f'#pane-{cell} [data-mg-badge=wl]')).to_have_text('Breast W/L: 경계를 찾지 못했습니다')
        panel.get_by_role('button', name='Fit Breast').click()
        expect(status).to_have_text('바꾸지 않은 칸 — ' + names)
        expect(page.locator('#pane-rcc [data-mg-badge=zoom]')).to_have_text('Zoom mode: Fit Breast')
        expect(page.locator('[data-mg-badge=zoom]')).to_have_count(1)
        panel.get_by_role('button', name='Match Size').click()
        # (named view by view: the CC cells, then the MLO cell)
        expect(status).to_have_text('경계를 찾지 못해 맞추지 않은 칸 — Current · R CC / Current · L CC / Prior · R CC / Prior · L CC / Current · R MLO')
        expect(page.locator('#pane-rcc [data-mg-badge=zoom]')).to_have_text('Zoom mode: Match Size')
        expect(page.locator('[data-mg-badge=zoom]')).to_have_count(1)
        # Their cameras, windows, tables and inversions are as they were, and no line was drawn on them.
        self.assertEqual(before, page.evaluate(self.STATE, others))
        page.wait_for_function("() => document.querySelectorAll('.kin-mg-outline').length === 1 && !!document.querySelector('#pane-rcc .kin-mg-outline')")
        # Quadrant Zoom: a cell whose orientation is known but whose region is not is shown by quarters of the whole image
        # (and says so); the cell without an orientation is not zoomed.
        self.menu(page, 'Quadrant Zoom')
        expect(page.locator('#pane-lcc [data-mg-badge=quadrant]')).to_have_text('Q1 Upper-Outer · 4× · whole image · edges outside')
        self.assertClose(self.camera(page, 'lcc')['focal'], [99.5, 74.5])  # the chest-wall upper quarter of the whole 400 × 300 image
        expect(page.locator('#pane-plcc [data-mg-badge=quadrant]')).to_have_text('Quadrant: orientation unverified')
        self.assertEqual(before[4]['camera'], page.evaluate(self.STATE, ['plcc'])[0]['camera'])

    def test_09d_a_band_between_the_chest_wall_and_the_tissue_is_no_region_unless_the_header_declares_it_padding(self):
        for declared in (False, True):
            with self.subTest(declared=declared):
                page = self.open(setup="() => { synViews.get('lcc').info.extra = { '00280120': { vr: 'US', Value: [0] } }; }" if declared else None)
                page.evaluate(self.PIXELS, ['lcc', 'band'])
                self.menu(page, 'Breast Display')
                panel = page.get_by_role('dialog', name='Breast Display')
                panel.get_by_role('button', name='Fit Breast').click()
                expect(page.locator('#pane-rcc [data-mg-badge=zoom]')).to_have_text('Zoom mode: Fit Breast')
                if not declared:
                    # Unexplained, the tissue does not stand against the chest wall: left as it is, and named.
                    expect(panel.locator('[role=status]')).to_have_text('바꾸지 않은 칸 — Current · L CC / Prior · L CC')
                    expect(page.locator('#pane-lcc [data-mg-badge=zoom]')).to_have_count(0)
                    self.assertAlmostEqual(1, self.camera(page, 'lcc')['zoom'])
                    continue
                # Declared pixel padding is no pixel of the image: the breast as it was made (its pixels x 20 … 260,
                # y 30 … 270, beyond the band) is fitted and centred,
                box = {'x0': 20, 'x1': 261, 'y0': 30, 'y1': 271}
                expect(page.locator('#pane-lcc [data-mg-badge=zoom]')).to_have_text('Zoom mode: Fit Breast')
                self.assertAlmostEqual(self.fit(box), self.camera(page, 'lcc')['zoom'], places=6)
                self.assertClose(self.camera(page, 'lcc')['focal'], self.centre(box))
                # and its window is the tissue's (fat 24 … 36, dense 600): neither the padding (0) nor the air (10).
                panel.get_by_role('button', name='Breast W/L').click()
                expect(page.locator('#pane-lcc [data-mg-badge=wl]')).to_have_text('Breast W/L')
                voi = page.evaluate("() => synViews.get('lcc').getProperties().voiRange")
                self.assertGreaterEqual(voi['lower'], 24); self.assertEqual(600, voi['upper'])

    def test_09f_when_no_image_header_can_be_read_nothing_is_said_to_be_done_and_the_cells_are_named(self):
        page = self.open(setup=self.failing(*self.ALL))
        before = page.evaluate(self.STATE, self.ALL)
        names = ' / '.join(self.NAMES[cell] + self.UNREAD for cell in self.ALL)
        self.menu(page, 'Breast Display')
        panel = page.get_by_role('dialog', name='Breast Display')
        status = panel.locator('[role=status]')
        for name, said in [('Breast Edge', '경계선을 그리지 않은 칸 — '), ('Breast W/L', '바꾼 것이 없습니다. 영상을 읽지 못한 칸 — '),
                           ('Fit Breast', '바꾼 것이 없습니다. 영상을 읽지 못한 칸 — '), ('Match Size', '바꾼 것이 없습니다. 영상을 읽지 못한 칸 — ')]:
            status.evaluate("node => { node.textContent = ''; }")
            panel.get_by_role('button', name=name).click()
            expect(status).to_have_text(said + names)
        expect(page.locator('.kin-mg-outline')).to_have_count(0)
        expect(page.locator('[data-mg-badge]')).to_have_count(0)
        self.assertEqual(before, page.evaluate(self.STATE, self.ALL))

    def test_09g_tissue_filling_the_image_under_a_band_of_declared_padding_has_no_region(self):
        # Today's L CC: tissue fills the image under 30 rows of declared padding (Pixel Padding Value 0). The padding is
        # not beside the tissue: there is no air and no skin line, as without the band.
        page = self.open(setup="() => { synViews.get('lcc').info.extra = { '00280120': { vr: 'US', Value: [0] } }; }")
        page.evaluate(self.PIXELS, ['lcc', 'filled-under'])
        before = page.evaluate(self.STATE, ['lcc'])
        self.menu(page, 'Breast Display')
        panel = page.get_by_role('dialog', name='Breast Display')
        status = panel.locator('[role=status]')
        panel.get_by_role('button', name='Breast Edge').click()
        expect(status).to_have_text('경계를 찾지 못한 칸 — Current · L CC / Prior · L CC')
        expect(page.locator('#pane-lcc .kin-mg-outline')).to_have_count(0)
        panel.get_by_role('button', name='Breast W/L').click()
        expect(status).to_have_text('경계를 찾지 못해 창을 바꾸지 않은 칸 — Current · L CC / Prior · L CC')
        panel.get_by_role('button', name='Fit Breast').click()
        expect(status).to_have_text('바꾸지 않은 칸 — Current · L CC / Prior · L CC')
        self.assertEqual(before, page.evaluate(self.STATE, ['lcc']))

    def test_09h_a_cell_on_an_image_still_being_read_is_left_out_of_what_is_pressed_named_and_not_changed_when_the_header_comes(self):
        # The DBT cell goes on to a slice whose header is kept back: what is pressed then is carried out on the cells
        # read, not on it, and it is named; nothing is carried out there when the header comes.
        on = "() => { synHeld = ['dbt']; synViews.get('dbt').show(3); }"
        for name, badge in [('Breast W/L', 'wl'), ('Fit Breast', 'zoom'), ('Match Size', 'zoom'), ('1:1', 'zoom')]:
            with self.subTest(name=name):
                page = self.open()
                self.menu(page, 'Breast Display')
                panel = page.get_by_role('dialog', name='Breast Display')
                page.evaluate(on)
                before = page.evaluate(self.STATE, ['dbt'])
                panel.get_by_role('button', name=name).click()
                expect(page.locator(f'#pane-rcc [data-mg-badge={badge}]')).to_have_count(1)
                expect(panel.locator('[role=status]')).to_contain_text('Current · R CC' + self.READING)
                self.release(page)
                page.wait_for_timeout(150)
                self.assertEqual(before, page.evaluate(self.STATE, ['dbt']))
                expect(page.locator(f'#pane-dbt [data-mg-badge={badge}]')).to_have_count(0)
        with self.subTest(name='Quadrant Zoom'):
            # The cell holds the first step; the next step is asked for while its slice is being read: it leaves the
            # step (no mark for a quadrant it does not show) and is named; the step after takes it again.
            page = self.open()
            self.menu(page, 'Quadrant Zoom')
            quadrant = page.get_by_role('dialog', name='Quadrant Zoom')
            expect(page.locator('#pane-dbt [data-mg-badge=quadrant]')).to_contain_text('Q1 Upper-Outer')
            page.evaluate(on)
            expect(page.locator('#pane-dbt [data-mg-badge=quadrant]')).to_contain_text('Q1 Upper-Outer')
            before = page.evaluate(self.STATE, ['dbt'])
            quadrant.get_by_role('button', name='Next Quadrant').click()
            expect(page.locator('#pane-rcc [data-mg-badge=quadrant]')).to_contain_text('Q2 Upper-Inner')
            expect(page.locator('#pane-dbt [data-mg-badge=quadrant]')).to_have_count(0)
            expect(quadrant.locator('[role=status]')).to_contain_text('확대하지 않은 칸 — Current · R CC' + self.READING)
            self.release(page)
            # A new size afterwards draws nothing on it either.
            page.evaluate("() => { for (const v of synViews.values()) v.element.style.width = '120px'; }")
            page.wait_for_timeout(500)
            self.assertEqual(before, page.evaluate(self.STATE, ['dbt']))
            expect(page.locator('#pane-dbt [data-mg-badge=quadrant]')).to_have_count(0)
            quadrant.get_by_role('button', name='Next Quadrant').click()
            expect(page.locator('#pane-dbt [data-mg-badge=quadrant]')).to_contain_text('Q3 Lower-Inner')
        with self.subTest(name='slices already read'):
            # Away to another slice and back (A → B → A) over slices whose headers are read: the cell is read at once,
            # and takes part in what is pressed.
            page = self.open()
            page.evaluate("() => { const v = synViews.get('dbt'); v.show(3); }")
            page.wait_for_function(self.READ)
            self.menu(page, 'Breast Display')
            self.assertEqual('read', page.evaluate("() => { const v = synViews.get('dbt'); v.show(0); v.show(3); return document.getElementById('pane-dbt').dataset.kinMgImage; }"))
            page.get_by_role('dialog', name='Breast Display').get_by_role('button', name='Fit Breast').click()
            expect(page.locator('#pane-dbt [data-mg-badge=zoom]')).to_have_text('Zoom mode: Fit Breast')

    def test_09i_a_cell_whose_header_cannot_be_read_is_named_and_what_was_done_is_not_said_of_it(self):
        # Only the prior R CC's header cannot be read (HTTP 503): that cell is left as it is, and every command says so.
        page = self.open(setup=self.failing('prcc'))
        before = page.evaluate(self.STATE, ['prcc'])
        unread = 'Prior · R CC' + self.UNREAD
        self.menu(page, 'Breast Display')
        panel = page.get_by_role('dialog', name='Breast Display')
        status = panel.locator('[role=status]')
        panel.get_by_role('button', name='Breast Edge').click()
        expect(status).to_have_text('경계선을 그리지 않은 칸 — ' + unread + ' / Prior · L CC')
        expect(page.locator('.kin-mg-outline')).to_have_count(4)
        panel.get_by_role('button', name='Breast W/L').click()
        expect(status).to_have_text('창을 바꾸지 않은 칸 — ' + unread + ' / Prior · L CC')
        panel.get_by_role('button', name='Fit Breast').click()
        expect(status).to_have_text('바꾸지 않은 칸 — ' + unread + ' / Prior · L CC')
        panel.get_by_role('button', name='Match Size').click()
        expect(status).to_have_text('바꾸지 않은 칸 — ' + unread + ' / Prior · L CC')
        expect(page.locator('#pane-rcc [data-mg-badge=zoom]')).to_have_text('Zoom mode: Match Size')
        panel.get_by_role('button', name='1:1').click()
        expect(status).to_have_text('바꾸지 않은 칸 — ' + unread)
        self.assertEqual(before, page.evaluate(self.STATE, ['prcc']))
        expect(page.locator('#pane-prcc [data-mg-badge]')).to_have_count(0)
        # Quadrant Zoom and Mirrored name it too.
        self.menu(page, 'Quadrant Zoom')
        expect(page.get_by_role('dialog', name='Quadrant Zoom').locator('[role=status]')).to_contain_text('확대하지 않은 칸 — ' + unread)
        self.menu(page, 'Mirrored')
        expect(page.get_by_role('dialog', name='Mirrored').locator('[role=status]')).to_have_text('연동하지 않는 칸 — ' + unread + ' / Prior · L CC: orientation unverified')
        self.assertEqual(before, page.evaluate(self.STATE, ['prcc']))
        # A cell whose image the viewer itself holds no instance metadata of is named likewise (nothing is known of it).
        page = self.open(setup="() => { window.synNoInstance = ['prcc']; }")
        self.menu(page, 'Breast Display')
        panel = page.get_by_role('dialog', name='Breast Display')
        panel.get_by_role('button', name='1:1').click()
        expect(panel.locator('[role=status]')).to_have_text('바꾸지 않은 칸 — ?' + self.UNREAD)
        self.assertAlmostEqual(2, self.camera(page, 'rcc')['zoom']); self.assertAlmostEqual(1, self.camera(page, 'prcc')['zoom'])
        # A cell that leaves a Quadrant Zoom step keeps nothing the step said of the image it held before: the prior
        # L CC's warning goes when the cell, given such an image, is left out of the next step.
        page = self.open()
        self.menu(page, 'Quadrant Zoom')
        quadrant = page.get_by_role('dialog', name='Quadrant Zoom')
        expect(page.locator('#pane-plcc [data-mg-badge=quadrant]')).to_have_text('Quadrant: orientation unverified')
        page.evaluate("() => { window.synNoInstance = ['plcc']; const v = synViews.get('plcc'); v.ids = ['img:plcc:5']; synEmit('cells', 'data', { viewportId: 'plcc' }); }")
        quadrant.get_by_role('button', name='Next Quadrant').click()
        expect(quadrant.locator('[role=status]')).to_contain_text('확대하지 않은 칸 — ?' + self.UNREAD)
        expect(page.locator('#pane-plcc [data-mg-badge=quadrant]')).to_have_count(0)

    def test_09k_what_was_only_said_of_the_image_a_cell_held_is_not_said_of_the_one_it_is_given(self):
        page = self.open()
        page.evaluate(self.PIXELS, ['lcc', 'filled'])
        self.menu(page, 'Breast Display')
        panel = page.get_by_role('dialog', name='Breast Display')
        panel.get_by_role('button', name='Breast W/L').click()
        expect(page.locator('#pane-lcc [data-mg-badge=wl]')).to_have_text('Breast W/L: 경계를 찾지 못했습니다')
        panel.get_by_role('button', name='Fit Breast').click()
        expect(page.locator('#pane-lcc [data-mg-badge=edge]')).to_have_text('경계를 찾지 못했습니다')
        self.menu(page, 'Quadrant Zoom')
        expect(page.locator('#pane-plcc [data-mg-badge=quadrant]')).to_have_text('Quadrant: orientation unverified')
        # Both cells are given another image: what was said of the earlier ones goes; the other cells keep their window
        # and their step.
        page.evaluate("() => { for (const id of ['lcc', 'plcc']) { const v = synViews.get(id); v.ids = ['img:' + id + ':5']; synEmit('cells', 'data', { viewportId: id }); } }")
        expect(page.locator('#pane-lcc [data-mg-badge=wl]')).to_have_count(0)
        expect(page.locator('#pane-lcc [data-mg-badge=edge]')).to_have_count(0)
        expect(page.locator('#pane-lcc [data-mg-badge=quadrant]')).to_have_count(0)
        expect(page.locator('#pane-plcc [data-mg-badge=quadrant]')).to_have_count(0)
        expect(page.locator('#pane-rcc [data-mg-badge=wl]')).to_have_text('Breast W/L')
        expect(page.locator('#pane-rcc [data-mg-badge=quadrant]')).to_contain_text('Q1 Upper-Outer')

    def test_09j_a_zoom_mode_stands_on_a_cell_only_while_its_zoom_and_its_images_are_those_it_was_set_on(self):
        page = self.open()
        self.menu(page, 'Breast Display')
        panel = page.get_by_role('dialog', name='Breast Display')
        panel.get_by_role('button', name='Fit Breast').click()
        for cell in ['dbt', 'rcc', 'lcc', 'prcc']:
            expect(page.locator(f'#pane-{cell} [data-mg-badge=zoom]')).to_have_text('Zoom mode: Fit Breast')
        # A pan keeps the mode; the viewer announcing the same camera once more changes nothing either.
        page.evaluate("""() => { const v = synViews.get('lcc'), f = v.camera.focalPoint; v.setCamera({ focalPoint: [f[0] + 10, f[1], 0] });
          synViews.get('rcc').element.dispatchEvent(new CustomEvent('CORNERSTONE_CAMERA_MODIFIED', { bubbles: true, detail: { viewportId: 'rcc' } })); }""")
        expect(page.locator('#pane-lcc [data-mg-badge=zoom]')).to_have_text('Zoom mode: Fit Breast')
        expect(page.locator('#pane-rcc [data-mg-badge=zoom]')).to_have_text('Zoom mode: Fit Breast')
        # The reader's zoom ends it in that cell: the mark no longer says what the cell shows.
        page.evaluate("() => synViews.get('rcc').setZoom(3)")
        expect(page.locator('#pane-rcc [data-mg-badge=zoom]')).to_have_count(0)
        # Another stack in the cell ends it too (another slice of the same stack does not).
        page.evaluate("() => synViews.get('dbt').show(2)")
        expect(page.locator('#pane-dbt [data-mg-badge=zoom]')).to_have_text('Zoom mode: Fit Breast')
        page.evaluate("() => { const v = synViews.get('dbt'); v.ids = v.ids.slice(0, 6); synEmit('cells', 'data', { viewportId: 'dbt' }); }")
        expect(page.locator('#pane-dbt [data-mg-badge=zoom]')).to_have_count(0)
        expect(page.locator('#pane-prcc [data-mg-badge=zoom]')).to_have_text('Zoom mode: Fit Breast')

    def test_02d_a_point_is_not_taken_when_reset_came_or_the_cell_was_given_another_image_between_the_press_and_the_release(self):
        zooms = "() => ['rcc', 'lcc', 'prcc', 'dbt'].map(id => synViews.get(id).getZoom())"
        page = self.open()
        self.menu(page, 'Mirrored')
        # Reset while the button is held on today's R CC.
        box = page.locator('#pane-rcc').bounding_box()
        page.mouse.move(box['x'] + 50, box['y'] + 40); page.mouse.down()
        page.get_by_role('dialog', name='Mirrored').get_by_role('button', name='Reset').evaluate('b => b.click()')
        page.mouse.up()
        self.assertEqual([1, 1, 1, 1], page.evaluate(zooms))
        # The cell pressed shows another image and the first again (A → B → A) while the button is held.
        box = page.locator('#pane-dbt').bounding_box()
        page.mouse.move(box['x'] + 50, box['y'] + 40); page.mouse.down()
        page.evaluate("() => { const v = synViews.get('dbt'); v.show(3); v.show(0); }")
        page.wait_for_function(self.READ)
        page.mouse.up()
        self.assertEqual([1, 1, 1, 1], page.evaluate(zooms))
        # Pressed and let go on the image it holds, the point is taken (the DBT cell is an R CC view).
        page.mouse.down(); page.mouse.up()
        self.assertEqual([2, 2, 2, 2], page.evaluate(zooms))
        # A drag is no point.
        page.get_by_role('dialog', name='Mirrored').get_by_role('button', name='Reset').click()
        page.mouse.move(box['x'] + 50, box['y'] + 40); page.mouse.down(); page.mouse.move(box['x'] + 80, box['y'] + 40); page.mouse.up()
        self.assertEqual([1, 1, 1, 1], page.evaluate(zooms))

    def test_03f_a_camera_change_is_carried_as_it_is_heard_and_reset_after_it_leaves_the_views_as_they_were(self):
        page = self.open()
        # The prior R CC stands at 1.5× when Mirrored is turned on: that is what Reset goes back to.
        page.evaluate("() => synViews.get('prcc').setZoom(1.5)")
        self.menu(page, 'Mirrored')
        zooms = "() => ['rcc', 'lcc', 'prcc'].map(id => synViews.get(id).getZoom())"
        # The reader zooms today's R CC: the view has followed by the time the change returns (no frame between).
        self.assertEqual([3, 3, 3], page.evaluate("() => { synViews.get('rcc').setCamera({ parallelScale: 50, focalPoint: [100, 100, 0] }); return (" + zooms + ")(); }"))
        page.get_by_role('dialog', name='Mirrored').get_by_role('button', name='Reset').click()
        self.assertEqual([1, 1, 1.5], page.evaluate(zooms))
        page.wait_for_timeout(250)
        self.assertEqual([1, 1, 1.5], page.evaluate(zooms))
        # Two cells changed one after the other: each is carried as it is heard, so the view ends with the later.
        page.evaluate("""() => { synViews.get('rcc').setCamera({ parallelScale: 50, focalPoint: [100, 100, 0] });
          synViews.get('lcc').setCamera({ parallelScale: 75, focalPoint: [300, 100, 0] }); }""")
        self.assertEqual([2, 2, 2], page.evaluate(zooms))
        self.assertNear(self.camera(page, 'rcc')['focal'], [99, 100])

    def test_02e_the_table_takes_a_header_only_for_the_image_the_cell_holds_and_asks_again_at_the_next_press_for_one_not_read(self):
        captures = '.kin-mg-capture[data-mode=lens]'
        # The header of the image the prior R CC holds is kept back.
        page = self.open(setup=self.held('prcc'), read=False)
        self.read_but(page, 'prcc')
        self.menu(page, 'Mirrored'); self.menu(page, 'Magnifier')
        status = page.get_by_role('dialog', name='Mirrored').locator('[role=status]')
        expect(status).to_have_text('연동하지 않는 칸 — Prior · R CC' + self.READING + ' / Prior · L CC: orientation unverified')
        expect(page.locator(captures)).to_have_count(5)
        # Before it comes, that cell is given another image, one without a stored orientation, whose header comes at
        # once: it is marked not linked, and gets its press layer.
        page.evaluate("""() => { synHeld = []; const v = synViews.get('prcc'); v.ids = ['img:prcc:5']; v.info.po = null;
          synEmit('cells', 'data', { viewportId: 'prcc' }); synEmit('grid', 'gridState'); }""")
        mark = page.locator('#pane-prcc [data-mg-badge=mirrored]')
        expect(mark).to_have_text('Mirrored: orientation unverified — not linked')
        expect(status).to_have_text('연동하지 않는 칸 — Prior · R CC: orientation unverified / Prior · L CC: orientation unverified')
        expect(page.locator(captures)).to_have_count(6)
        # The answer for the image it held before comes afterwards: it writes nothing.
        page.evaluate("() => synRelease()")
        page.wait_for_timeout(300)
        expect(mark).to_have_text('Mirrored: orientation unverified — not linked')
        expect(status).to_have_text('연동하지 않는 칸 — Prior · R CC: orientation unverified / Prior · L CC: orientation unverified')
        self.assertEqual('read', page.locator('#pane-prcc').get_attribute('data-kin-mg-image'))
        # With no change of the grid at all: the DBT cell goes on to a slice whose header cannot be read — it is named,
        # and its press layer goes; back on a slice already read it is linked again at once.
        page = self.open()
        self.menu(page, 'Mirrored'); self.menu(page, 'Magnifier')
        status = page.get_by_role('dialog', name='Mirrored').locator('[role=status]')
        expect(page.locator(captures)).to_have_count(6)
        page.evaluate("() => { synFail = ['dbt']; synViews.get('dbt').show(4); }")
        expect(status).to_have_text('연동하지 않는 칸 — Current · R CC' + self.UNREAD + ' / Prior · L CC: orientation unverified')
        expect(page.locator('#pane-dbt .kin-mg-capture')).to_have_count(0)
        expect(page.locator(captures)).to_have_count(5)
        self.assertEqual('unread', page.locator('#pane-dbt').get_attribute('data-kin-mg-image'))
        page.evaluate("() => synViews.get('dbt').show(0)")
        self.assertEqual(['read', 6, '연동하지 않는 칸 — Prior · L CC: orientation unverified'], page.evaluate(
            "c => [document.getElementById('pane-dbt').dataset.kinMgImage, document.querySelectorAll(c).length, document.querySelector('[aria-label=Mirrored] [role=status]').textContent]", captures))
        # A header that could not be read is asked for once more by what the reader presses next. That press goes by
        # the cells read then; when the header is read after it, the marks and the press layers are drawn with the
        # cell, nothing of that press is carried to it, and the next press is.
        page = self.open(setup=self.failing('prcc'))
        self.menu(page, 'Mirrored')
        status = page.get_by_role('dialog', name='Mirrored').locator('[role=status]')
        expect(status).to_have_text('연동하지 않는 칸 — Prior · R CC' + self.UNREAD + ' / Prior · L CC: orientation unverified')
        self.menu(page, 'Magnifier')
        expect(page.locator(captures)).to_have_count(5)
        self.menu(page, 'Magnifier')
        asked = page.evaluate("() => { synFail = []; return synAsked.filter(cell => cell === 'prcc').length; }")
        zooms = "() => ['rcc', 'lcc', 'prcc'].map(id => synViews.get(id).getZoom())"
        self.click_cell(page, 'rcc', 50, 40)
        self.assertEqual([2, 2, 1], page.evaluate(zooms))
        expect(status).to_have_text('연동하지 않는 칸 — Prior · L CC: orientation unverified')
        self.assertEqual(asked + 1, page.evaluate("() => synAsked.filter(cell => cell === 'prcc').length"))
        self.assertEqual([2, 2, 1], page.evaluate(zooms))
        self.click_cell(page, 'rcc', 60, 40)
        self.assertEqual([2, 2, 2], page.evaluate(zooms))
        self.menu(page, 'Magnifier')
        expect(page.locator(captures)).to_have_count(6)

    def test_04g_the_lenses_go_when_the_cell_pressed_loses_its_press_layer(self):
        page = self.open()
        self.menu(page, 'Mirrored')
        page.wait_for_function("() => !!document.querySelector('#pane-plcc [data-mg-badge=mirrored]')")
        self.menu(page, 'Magnifier')
        expect(page.locator('#pane-rcc .kin-mg-capture[data-mode=lens]')).to_have_count(1)
        box = page.locator('#pane-rcc .viewport-element').bounding_box()
        page.mouse.move(box['x'] + 50, box['y'] + 40); page.mouse.down()
        page.wait_for_function("() => document.querySelectorAll('.kin-mg-lens').length === 4")
        # While it is held, the cell pressed is given an image the module can read no header of: its press layer goes,
        # and the press with it — no lens stays, though no release is heard on a layer that is gone.
        page.evaluate("() => { window.synNoInstance = ['rcc']; const v = synViews.get('rcc'); v.ids = ['img:rcc:5']; synEmit('cells', 'data', { viewportId: 'rcc' }); }")
        expect(page.locator('#pane-rcc .kin-mg-capture')).to_have_count(0)
        expect(page.locator('.kin-mg-lens')).to_have_count(0)
        page.mouse.up()
        page.wait_for_timeout(200)
        expect(page.locator('.kin-mg-lens')).to_have_count(0)

    def test_04h_the_release_takes_every_lens_though_the_cell_pressed_was_given_another_viewport_meanwhile(self):
        page = self.open()
        self.menu(page, 'Mirrored'); self.menu(page, 'Magnifier')
        expect(page.locator('#pane-rcc .kin-mg-capture[data-mode=lens]')).to_have_count(1)
        box = page.locator('#pane-rcc .viewport-element').bounding_box()
        page.mouse.move(box['x'] + 50, box['y'] + 40); page.mouse.down()
        expect(page.locator('.kin-mg-lens')).to_have_count(4)
        # While it is held the cell pressed is given a new viewport of the same id, holding the same image: the layer
        # that was pressed is gone with the old one.
        page.evaluate("() => { synViews.set('rcc', { ...synViews.get('rcc') }); synEmit('cells', 'data', { viewportId: 'rcc' }); }")
        expect(page.locator('#pane-rcc .kin-mg-capture[data-mode=lens]')).to_have_count(1)
        page.mouse.up()
        expect(page.locator('.kin-mg-lens')).to_have_count(0)
        page.wait_for_timeout(200)
        expect(page.locator('.kin-mg-lens')).to_have_count(0)

    def test_03i_the_readers_way_back_to_the_very_camera_this_module_set_is_followed(self):
        page = self.open()
        # Fit sets every cell's camera. With Mirrored on the reader zooms today's R CC to 3× and then back to that very
        # camera: the view follows both.
        self.menu(page, 'Breast Display')
        display = page.get_by_role('dialog', name='Breast Display')
        display.get_by_role('button', name='Fit', exact=True).click()
        expect(page.locator('#pane-rcc [data-mg-badge=zoom]')).to_have_text('Zoom mode: Fit')
        display.get_by_role('button', name='Close').click()
        self.menu(page, 'Mirrored')
        fit = page.evaluate("() => synViews.get('rcc').getCamera()")
        page.evaluate("() => synViews.get('rcc').setCamera({ parallelScale: 50 })")
        page.wait_for_function("() => ['lcc', 'prcc'].every(id => Math.abs(synViews.get(id).getZoom() - 3) < 1e-9)")
        page.evaluate("camera => synViews.get('rcc').setCamera(camera)", fit)
        page.wait_for_function("() => ['lcc', 'prcc'].every(id => Math.abs(synViews.get(id).getZoom() - 1) < 1e-9)")

    def test_08e_breast_wl_leaves_a_cell_still_being_read_as_it_is_then_and_when_its_header_comes_and_off_gives_the_others_their_windows_back(self):
        # No header has come: nothing is changed, and it says so; nor is anything changed when they come.
        page = self.open(setup=self.held(*self.ALL), read=False)
        before = page.evaluate(self.STATE, self.ALL)
        self.menu(page, 'Breast Display')
        panel = page.get_by_role('dialog', name='Breast Display')
        wl, status = panel.get_by_role('button', name='Breast W/L'), panel.locator('[role=status]')
        wl.click()
        expect(status).to_have_text('바꾼 것이 없습니다. 영상을 읽지 못한 칸 — ' + ' / '.join(self.NAMES[cell] + self.READING for cell in self.ALL))
        self.release(page)
        page.wait_for_timeout(200)
        self.assertEqual(before, page.evaluate(self.STATE, self.ALL))
        expect(page.locator('[data-mg-badge=wl]')).to_have_count(0)
        # Pressed now it is on (the breast's window), and pressed again off: the reader's own window again.
        wl.click()
        expect(page.locator('#pane-rcc [data-mg-badge=wl]')).to_have_text('Breast W/L')
        self.assertGreaterEqual(page.evaluate("() => synViews.get('rcc').getProperties().voiRange.lower"), 1000)
        wl.click()
        expect(page.locator('[data-mg-badge=wl]')).to_have_count(0)
        self.assertEqual(before, page.evaluate(self.STATE, self.ALL))
        # One cell is still being read when it is turned on (the prior R CC): the others get the breast's window, that
        # one is named and keeps its own — also when its header comes.
        page = self.open(setup=self.held('prcc'), read=False)
        self.read_but(page, 'prcc')
        before = page.evaluate(self.STATE, self.ALL)
        self.menu(page, 'Breast Display')
        panel = page.get_by_role('dialog', name='Breast Display')
        wl, status = panel.get_by_role('button', name='Breast W/L'), panel.locator('[role=status]')
        wl.click()
        expect(status).to_have_text('창을 바꾸지 않은 칸 — Prior · R CC' + self.READING + ' / Prior · L CC')
        expect(page.locator('#pane-rcc [data-mg-badge=wl]')).to_have_text('Breast W/L')
        self.release(page)
        page.wait_for_timeout(200)
        self.assertEqual(before[4], page.evaluate(self.STATE, ['prcc'])[0])
        expect(page.locator('#pane-prcc [data-mg-badge=wl]')).to_have_count(0)
        # The next press is Off: the cells that had it get their windows back, and nothing is turned on anywhere.
        wl.click()
        expect(status).to_have_text('Breast W/L을 껐습니다. 원래 창(VOI LUT·반전 포함)으로 돌아갔습니다.')
        expect(page.locator('[data-mg-badge=wl]')).to_have_count(0)
        self.assertEqual(before, page.evaluate(self.STATE, self.ALL))

    def test_05e_close_fits_the_cells_the_step_holds_and_a_new_size_is_left_to_a_cell_the_reader_drags_in_or_that_was_given_a_zoom_mode(self):
        page = self.open()
        self.menu(page, 'Breast Display')
        self.menu(page, 'Quadrant Zoom')
        quadrant = page.get_by_role('dialog', name='Quadrant Zoom')
        quadrant.get_by_label('Zoom').evaluate("select => { select.value = 'fill'; select.dispatchEvent(new Event('change')); }")
        expect(page.locator('#pane-prcc [data-mg-badge=quadrant]')).to_have_text('Q1 Upper-Outer · Fill Quadrant')
        filled = self.camera(page, 'rcc')['zoom']
        # The cells become narrower. Once that is noticed — the step is worked out again a moment later — the reader
        # drags in today's R CC, and 1:1 is pressed … (`act` runs in that moment: after the size was noticed, before the answer)
        resized = """async act => { for (const v of synViews.values()) v.element.style.width = '120px';
          await new Promise(resolve => { const seen = new ResizeObserver(() => { seen.disconnect(); resolve(); }); seen.observe(synViews.get('rcc').element); });
          const v = synViews.get('rcc');
          if (act === 'drag') { v.element.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }));
            const f = v.camera.focalPoint; v.setCamera({ focalPoint: [f[0] - 30, f[1], 0] }); document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true })); }
          return v.getCamera().focalPoint; }"""
        dragged = page.evaluate(resized, 'drag')
        # … the other held cells are drawn again for the new width; the cell dragged in keeps the step's zoom and the
        # reader's place, and its mark (a pan keeps the step).
        box = self.BOX['R']
        again = min(120 / ((box['x1'] - box['x0']) / 2), 150 / ((box['y1'] - box['y0']) / 2)) * 0.98 / 0.5
        page.wait_for_function("z => Math.abs(synViews.get('prcc').getZoom() - z) < 1e-6", arg=again)
        page.wait_for_timeout(300)
        self.assertAlmostEqual(filled, self.camera(page, 'rcc')['zoom'], places=9)
        self.assertNear(self.camera(page, 'rcc')['focal'], dragged[:2])
        expect(page.locator('#pane-rcc [data-mg-badge=quadrant]')).to_have_text('Q1 Upper-Outer · Fill Quadrant')
        # A zoom mode pressed in that moment: the cells are the mode's, and the new size draws nothing on them.
        page.evaluate("""async () => { for (const v of synViews.values()) v.element.style.width = '100px';
          await new Promise(resolve => { const seen = new ResizeObserver(() => { seen.disconnect(); resolve(); }); seen.observe(synViews.get('prcc').element); });
          [...document.querySelectorAll('[aria-label="Breast Display"] button')].find(b => b.textContent === '1:1').click(); }""")
        expect(page.locator('#pane-prcc [data-mg-badge=zoom]')).to_have_text('Zoom mode: 1:1')
        one = self.camera(page, 'prcc')['zoom']
        page.wait_for_timeout(400)
        self.assertAlmostEqual(one, self.camera(page, 'prcc')['zoom'], places=9)
        expect(page.locator('[data-mg-badge=quadrant]')).to_have_count(0)
        # Close: the cells the step holds go back to Fit — also one whose image is being read just then (the DBT cell
        # on its next slice) — with every MG cell read.
        quadrant.get_by_role('button', name='Next Quadrant').evaluate('b => b.click()')
        expect(page.locator('#pane-dbt [data-mg-badge=quadrant]')).to_contain_text('Q2 Upper-Inner')
        page.evaluate("() => { synHeld = ['dbt']; synViews.get('dbt').show(1); }")
        self.assertEqual('reading', page.locator('#pane-dbt').get_attribute('data-kin-mg-image'))
        quadrant.get_by_role('button', name='Close').evaluate('b => b.click()')
        self.assertEqual([1] * 6, page.evaluate("() => [...synViews.values()].map(v => v.getZoom())"))
        expect(page.locator('[data-mg-badge=quadrant]')).to_have_count(0)
        self.release(page)
        page.wait_for_timeout(200)
        self.assertEqual([1] * 6, page.evaluate("() => [...synViews.values()].map(v => v.getZoom())"))

    def test_04f_a_linked_cell_still_being_read_gets_no_lens_then_or_when_its_header_comes_and_close_and_magnifier_off_take_the_lenses(self):
        page = self.open(setup=self.held('prcc'), read=False)
        self.read_but(page, 'prcc')
        self.menu(page, 'Mirrored'); self.menu(page, 'Magnifier')
        captures = page.locator('.kin-mg-capture[data-mode=lens]')
        expect(captures).to_have_count(5)
        # Turned on, the Magnifier says which cell it is not on yet.
        self.assertIn('영상을 읽은 뒤에 걸리는 칸 — Prior · R CC' + self.READING, page.evaluate("() => synNotes.at(-1).message"))
        box = page.locator('#pane-rcc .viewport-element').bounding_box()
        lenses = "() => Object.fromEntries([...document.querySelectorAll('.kin-mg-lens')].map(lens => [lens.closest('[data-cy=viewport-pane]').id.slice(5), lens.dataset.at]))"
        page.mouse.move(box['x'] + 50, box['y'] + 40); page.mouse.down()
        self.assertEqual({'rcc': '50,40', 'lcc': '150,40', 'dbt': '50,40'}, page.evaluate(lenses))
        # Its header comes while the press is held: it gets its press layer, and no lens for the place pressed before.
        self.release(page)
        expect(captures).to_have_count(6)
        page.wait_for_timeout(200)
        self.assertEqual({'rcc': '50,40', 'lcc': '150,40', 'dbt': '50,40'}, page.evaluate(lenses))
        # The next move is drawn there too.
        page.mouse.move(box['x'] + 80, box['y'] + 60)
        self.assertEqual({'rcc': '80,60', 'lcc': '120,60', 'prcc': '80,60', 'dbt': '80,60'}, page.evaluate(lenses))
        # Mirrored closed while it is held: the linked cells' lenses go, the pressed cell keeps its own, and a move draws only that.
        page.get_by_role('dialog', name='Mirrored').get_by_role('button', name='Close').evaluate('b => b.click()')
        self.assertEqual({'rcc': '80,60'}, page.evaluate(lenses))
        page.mouse.move(box['x'] + 90, box['y'] + 60)
        self.assertEqual({'rcc': '90,60'}, page.evaluate(lenses))
        # Let go: no lens, then or later.
        page.mouse.up()
        self.assertEqual({}, page.evaluate(lenses))
        page.wait_for_timeout(200)
        self.assertEqual({}, page.evaluate(lenses))
        # The Magnifier turned off while it is pressed: no lens and no press layer.
        self.menu(page, 'Mirrored')
        page.mouse.move(box['x'] + 50, box['y'] + 40); page.mouse.down()
        self.assertEqual(4, len(page.evaluate(lenses)))
        page.evaluate("() => KinViewerFeatures.run('mgMagnifier')")
        self.assertEqual({}, page.evaluate(lenses))
        page.mouse.up()
        page.wait_for_timeout(200)
        self.assertEqual({}, page.evaluate(lenses))
        expect(page.locator('.kin-mg-capture')).to_have_count(0)

    def test_18_nothing_is_written_once_the_module_has_ended(self):
        # The module ends while the headers are on their way: nothing is written when they come.
        page = self.open(setup=self.held(*self.ALL), read=False)
        before = page.evaluate(self.STATE, self.ALL)
        page.evaluate("() => { synActive = 'rcc'; }")
        self.menu(page, 'Mirrored')
        self.menu(page, 'Breast Display')
        panel = page.get_by_role('dialog', name='Breast Display')
        for name in ['Breast Edge', 'Breast W/L', 'Fit Breast']:
            panel.get_by_role('button', name=name).evaluate('b => b.click()')
        page.evaluate("() => synToolbar.dispose()")
        expect(page.locator('[data-kin-mg-image]')).to_have_count(0)
        page.evaluate("() => synRelease()")
        page.wait_for_timeout(400)
        self.assertEqual(before, page.evaluate(self.STATE, self.ALL))
        expect(page.locator('.kin-mg-outline, .kin-mg-lens, .kin-mg-capture, [data-mg-badge], [data-kin-mg-image]')).to_have_count(0)
        # It ends with everything on: the marks, the lines and the cells' states go with it, and the reader's own
        # changes afterwards are carried nowhere.
        page = self.open()
        self.menu(page, 'Mirrored'); self.menu(page, 'Magnifier')
        self.menu(page, 'Breast Display')
        page.get_by_role('dialog', name='Breast Display').get_by_role('button', name='Breast Edge').evaluate('b => b.click()')
        expect(page.locator('.kin-mg-outline')).to_have_count(5)
        page.evaluate("() => synToolbar.dispose()")
        expect(page.locator('.kin-mg-outline, .kin-mg-lens, .kin-mg-capture, [data-mg-badge], [data-kin-mg-image]')).to_have_count(0)
        page.evaluate("() => synViews.get('rcc').setCamera({ parallelScale: 50 })")
        page.wait_for_timeout(200)
        self.assertEqual([1, 1], page.evaluate("() => ['lcc', 'prcc'].map(id => synViews.get(id).getZoom())"))

    def test_19_an_image_the_viewer_itself_calls_another_modality_is_never_asked_for_takes_no_part_and_is_left_as_the_reader_has_it(self):
        page = self.open(setup="() => { synViews.get('rmlo').info.modality = 'CT'; }")
        self.assertIsNone(page.locator('#pane-rmlo').get_attribute('data-kin-mg-image'))
        expect(page.locator('[data-kin-mg-image=read]')).to_have_count(5)
        # Paging through its stack asks nothing.
        page.evaluate("() => { const v = synViews.get('rmlo'); v.ids = ['img:rmlo:0', 'img:rmlo:1', 'img:rmlo:2']; synEmit('cells', 'data', { viewportId: 'rmlo' }); v.show(1); v.show(2); }")
        self.assertNotIn('rmlo', page.evaluate("synAsked"))
        before = page.evaluate(self.STATE, ['rmlo'])
        self.menu(page, 'Breast Display')
        panel = page.get_by_role('dialog', name='Breast Display')
        panel.get_by_role('button', name='Breast Edge').click()
        expect(panel.locator('[role=status]')).to_have_text('경계를 찾지 못한 칸 — Prior · L CC')
        expect(page.locator('.kin-mg-outline')).to_have_count(4)
        panel.get_by_role('button', name='1:1').click()
        expect(page.locator('[data-mg-badge=zoom]')).to_have_count(5)
        expect(panel.locator('[role=status]')).to_have_text('')
        panel.get_by_role('button', name='Fit', exact=True).click()
        self.menu(page, 'Mirrored'); self.menu(page, 'Magnifier')
        expect(page.locator('.kin-mg-capture')).to_have_count(5)
        mirrored = page.get_by_role('dialog', name='Mirrored')
        expect(mirrored.locator('[role=status]')).to_have_text('연동하지 않는 칸 — Prior · L CC: orientation unverified')
        self.menu(page, 'Magnifier')
        self.menu(page, 'Quadrant Zoom')
        expect(page.locator('#pane-rcc [data-mg-badge=quadrant]')).to_contain_text('Q1 Upper-Outer')
        self.assertEqual(before, page.evaluate(self.STATE, ['rmlo']))
        expect(page.locator('#pane-rmlo [data-mg-badge]')).to_have_count(0)
        self.assertNotIn('rmlo', page.evaluate("synAsked"))
        page.get_by_role('dialog', name='Quadrant Zoom').get_by_role('button', name='Close').evaluate('b => b.click()')
        # With Mirrored on the reader zooms and inverts that cell, and today's R CC: Reset gives the MG cells their
        # views back — the other cell is the reader's own, and stays as the reader has it.
        page.evaluate("""() => { const ct = synViews.get('rmlo'); ct.setZoom(3); ct.setProperties({ invert: true });
          synViews.get('rcc').setCamera({ parallelScale: 50, focalPoint: [100, 100, 0] }); }""")
        self.assertEqual([3, 3], page.evaluate("() => ['rcc', 'lcc'].map(id => synViews.get(id).getZoom())"))
        mirrored.get_by_role('button', name='Reset').evaluate('b => b.click()')
        self.assertEqual([1, 1], page.evaluate("() => ['rcc', 'lcc'].map(id => synViews.get(id).getZoom())"))
        self.assertEqual([3, True], page.evaluate("() => [synViews.get('rmlo').getZoom(), synViews.get('rmlo').props.invert]"))
        # With no MG image in any cell nothing is asked for, and every panel says that there is none.
        page = self.open(setup="() => { for (const v of synViews.values()) v.info.modality = 'CT'; }")
        before = page.evaluate(self.STATE, self.ALL)
        self.menu(page, 'Breast Display')
        panel = page.get_by_role('dialog', name='Breast Display')
        for name in ['Breast W/L', 'Fit Breast']:
            panel.get_by_role('button', name=name).click()
            expect(panel.locator('[role=status]')).to_have_text('MG 영상이 있는 칸이 없습니다. 바꾼 것이 없습니다.')
        self.menu(page, 'Quadrant Zoom')
        expect(page.get_by_role('dialog', name='Quadrant Zoom').locator('[role=status]')).to_have_text('MG 영상이 있는 칸이 없습니다. 바꾼 것이 없습니다.')
        self.menu(page, 'Mirrored')
        expect(page.get_by_role('dialog', name='Mirrored').locator('[role=status]')).to_have_text('MG 영상이 있는 칸이 없습니다.')
        self.menu(page, 'Magnifier')
        self.assertEqual('Magnifier: MG 영상이 있는 칸이 없습니다.', page.evaluate("() => synNotes.at(-1).message"))
        expect(page.locator('.kin-mg-capture, [data-mg-badge]')).to_have_count(0)
        self.assertEqual(before, page.evaluate(self.STATE, self.ALL))
        self.assertEqual([], page.evaluate("synAsked"))

    # ── The lens against the screen ──
    # The screen's own picture of a cell's canvas (a screenshot of it, its image filter on it) cut at the lens's place and
    # enlarged, beside what the lens shows: the greatest difference of any channel of any pixel; the lens's own pixels
    # down its first column; and the screen's pixels down the first column of the lens's place.
    LENS_VS_SCREEN = """async ([png, at, dpr]) => { const image = new Image(); image.src = 'data:image/png;base64,' + png; await image.decode();
      const lens = document.querySelector('#pane-rcc .kin-mg-lens canvas'), size = lens.width, side = 80 * dpr;
      const x = at[0] * dpr - side / 2, y = at[1] * dpr - side / 2, k = size / side;
      const ax = Math.max(x, 0), ay = Math.max(y, 0), bx = Math.min(x + side, image.width), by = Math.min(y + side, image.height);
      const wanted = document.createElement('canvas'); wanted.width = wanted.height = size;
      wanted.getContext('2d').drawImage(image, ax, ay, bx - ax, by - ay, (ax - x) * k, (ay - y) * k, (bx - ax) * k, (by - ay) * k);
      const a = wanted.getContext('2d').getImageData(0, 0, size, size).data, b = lens.getContext('2d').getImageData(0, 0, size, size).data;
      let worst = 0, where = null;
      for (let i = 0; i < a.length; i++) { const d = Math.abs(a[i] - b[i]); if (d > worst) { worst = d; where = [(i >> 2) % size, Math.floor((i >> 2) / size), i & 3, a[i], b[i]]; } }
      const column = []; for (let row = 8; row < size; row += 8) column.push(b[(row * size) * 4]);
      const all = document.createElement('canvas'); all.width = image.width; all.height = image.height; all.getContext('2d').drawImage(image, 0, 0);
      const inside = []; for (let row = Math.ceil(ay) + 4; row < by - 4; row += 4) inside.push(all.getContext('2d').getImageData(Math.ceil(ax), row, 1, 1).data[0]);
      return { size, worst, where, column, inside, screen: [image.width, image.height] }; }"""

    def lens_and_screen(self, kind, at, dpr=1):
        page = self.open(dpr=dpr)
        page.add_script_tag(path=str(HPACS / 'viewer-image-filter.js'))
        # Today's R CC draws black, a grey grain in the middle, and a white line one pixel wide at x 9 — the column just
        # outside a lens pressed at x 50 (its place begins at x 10).
        page.evaluate("""kind => { const canvas = synViews.get('rcc').canvas, g = canvas.getContext('2d'), image = g.createImageData(200, 150);
          for (let y = 0; y < 150; y++) for (let x = 0; x < 200; x++) { const i = (y * 200 + x) * 4;
            const grey = x === 9 ? 255 : x >= 30 && x < 120 && y >= 10 && y < 120 ? (x * 37 + y * 91) % 256 : 0;
            image.data[i] = image.data[i + 1] = image.data[i + 2] = grey; image.data[i + 3] = 255; }
          g.putImageData(image, 0, 0);
          if (kind !== 'none') KinImageFilter.apply(canvas, kind); }""", kind)
        self.assertEqual('' if kind == 'none' else 'url("#kin-image-filter-' + kind + '")', page.evaluate("() => synViews.get('rcc').canvas.style.filter"))
        own = page.locator('#pane-rcc .viewport-element').bounding_box()
        self.assertEqual([own['x'], own['y']], [round(own['x']), round(own['y'])], 'the canvas stands on whole pixels')
        import base64
        shot = base64.b64encode(page.screenshot(clip={'x': own['x'], 'y': own['y'], 'width': 200, 'height': 150})).decode()
        self.menu(page, 'Magnifier')
        expect(page.locator('#pane-rcc .kin-mg-capture')).to_have_count(1)
        page.mouse.move(own['x'] + at[0], own['y'] + at[1]); page.mouse.down()
        expect(page.locator('#pane-rcc .kin-mg-lens')).to_have_count(1)
        result = page.evaluate(self.LENS_VS_SCREEN, [shot, at, dpr])
        page.mouse.up()
        return result

    def test_04e_the_lens_shows_the_screen_with_its_image_filter_cut_at_its_place_and_enlarged(self):
        for kind in ['smooth', 'sharpen', 'none']:
            # In the image, and at the canvas's own corner (part of the place lies beyond the canvas).
            for at in [[50, 40], [5, 6], [197, 146]]:
                with self.subTest(kind=kind, at=at):
                    result = self.lens_and_screen(kind, at)
                    self.assertEqual([160, [200, 150]], [result['size'], result['screen']])
                    self.assertLessEqual(result['worst'], 2, result)
        # Smooth: the white line just outside the lens's place makes the screen's first column inside it grey (a quarter
        # of white: 64), all the way down. The lens's first column is grey too, not black: that grey towards the line's
        # own (128), as enlarging the screen there gives.
        result = self.lens_and_screen('smooth', [50, 40])
        self.assertEqual([64] * len(result['inside']), result['inside'])
        for value in result['column']:
            self.assertTrue(64 <= value <= 128, result['column'])
        # Without a filter that column of the screen is black.
        self.assertEqual([0] * len(result['inside']), self.lens_and_screen('none', [50, 40])['inside'])
        # A screen of two device pixels to the canvas pixel: the same comparison holds there.
        for kind in ['smooth', 'none']:
            with self.subTest(kind=kind, dpr=2):
                result = self.lens_and_screen(kind, [50, 40], dpr=2)
                self.assertEqual([320, [400, 300]], [result['size'], result['screen']])
                self.assertLessEqual(result['worst'], 6, result)

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
