# coding: utf-8
"""Auto Save View on the shipped image toolbar: Display > Auto Save View... and Viewer Settings > Tools & Display (the
account check and the window); with the check on, settled panes can save reader edits while others are still restoring.
Display processing and applying a saved value do not by themselves trigger a save. With the setting off nothing is sent;
the saved view put back over the viewer's first layout (layout, cell rule, image by SOP, window and camera) with a badge
naming only what went back; a Job chosen to open wins; Discard Saved View wins over a save on its way; a patient switch
saves at once.

The shipped viewer-features.js, viewer-features-autosave.js, viewer-auto-view-model.js, viewer-features-view.js (with
hanging-protocol-model.js, viewer-image-filter.js, viewer-gsps.js), viewer-ux-shortcuts.js and viewer-ux-toolbar.js (with
viewer-ux-theme.css) run in Chromium beside synthetic OHIF services, synthetic CT stacks and a synthetic API. The real
viewer, server and database are in tests/e2e/test_auto_save_view.py.

A restore the address chose (the kinJob page, a finding's saved location continued into the page) is the starting point
and never a change: the last cases run the shipped viewer-jobs.js, finding-link-model.js and viewer-findings.js on the
same page (with work-context.js and session-transport.js) and let those panels restore for themselves, over a synthetic
stack restore that a case can hold half done or make fail. Nothing is saved while such a restore holds the screen
(however long, the closing window included), what the reader changed before it is sent as it begins, the first change
after it is saved, and a restore that never begins, is refused while its Job is read or belongs to a screen that is
over holds nothing back. Restore Job and a finding moved to within the document stay the reader's own changes.

The screen such a restore leaves is never sent as a change, whatever else is going on. A save of the reader's from
before it that is still unanswered does not make the closing window, a patient switch, the mode being left or a second
restore send that screen (what the reader changes after it is sent again as ever, and so is a view with no restore at
all). A screen that cannot be captured as the restore lets go (it failed, its rollback failed, an image is still to
come) is waited for: the image coming, the camera, the grid, the save delay, the closing window, a patient switch, the
mode being left, the check switched on later, either Discard and a Hanging Protocol send nothing, the first screen that
can be captured is the starting point, and the reader's next change is saved. A viewer that starts saving after the
restore was over starts the same way, whether it heard that restore or was installed after it.

On a fresh opening each already drawn cell has a baseline before the read. A new cell starts from its first stable
image. An unanswered rule, an unreadable frame or a late display pass leaves that cell's stored value in place.
"""
from pathlib import Path
import json
import unittest

from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[1]
HPACS = ROOT / "worklist-v0" / "hpacs-lite"
ORIGIN = "https://auto-save-view.test"
OWNER = ['syn-site', 'syn-reader']
STUDY = '1.2.826.0.1.3680043.8.498.140'
SA, SB = STUDY + '.2', STUDY + '.3'
CHECK = 'Save view changes automatically and apply on reopen'
JOB = '&kinJob=00000000-0000-4000-8000-000000000001'
READ = 'GET /api/studies/%s/viewer-auto-view' % STUDY

# The viewer's split-series identity functions, as the shipped viewer configuration has them.
SPLIT_RULE = (lambda s: s[s.index('function kinSeriesSplitFrame('):s.index('function kinEnhancedTimePoints(')])((ROOT / 'config' / 'ohif.js').read_text(encoding='utf-8'))

HARNESS = """<!doctype html><html><head><style>
body { margin: 0; background: #111; color: #eee; --kin-panel: #222; --kin-ux-text: #eee; --kin-ux-secondary: #999; --kin-accent: #6cf; }
#grid { position: absolute; left: 0; top: 80px; width: 1240px; height: 440px; }
[data-cy=viewport-pane] { position: absolute; width: 300px; height: 200px; overflow: hidden; }
.viewport-element { position: absolute; inset: 0; } .viewport-element canvas { width: 300px; height: 200px; display: block; }
</style></head><body><div id="root"><div class="kin-ux-toolbar-slot"></div><div id="grid"></div></div></body></html>"""

SETUP = """config => {
  const STUDY = config.study, owner = config.owner;
  window.synNotes = []; window.synEnded = false; window.synWriter = true;
  window.synSets = [{ uid: 'set-A', series: config.sa, n: 8 }, { uid: 'set-B', series: config.sb, n: 4 }];
  window.synMeta = {};
  // Each series' images, numbered 1..n, slice positions rising with the number.
  for (const set of synSets) for (let i = 1; i <= set.n; i++) synMeta['syn:' + set.uid + ':' + i] = { Modality: 'CT', StudyInstanceUID: STUDY,
    SeriesInstanceUID: set.series, SOPInstanceUID: set.series + '.' + i, InstanceNumber: i, ImagePositionPatient: [0, 0, i * 5],
    ImageOrientationPatient: [1, 0, 0, 0, 1, 0], PixelSpacing: [0.5, 0.5], Rows: 400, Columns: 600 };
  const EVENTS = { PRE_STACK_NEW_IMAGE: 'syn-before-image', STACK_NEW_IMAGE: 'syn-new', CAMERA_MODIFIED: 'syn-camera', VOI_MODIFIED: 'syn-voi', IMAGE_RENDERED: 'syn-rendered' };
  window.cornerstone = { Enums: { Events: EVENTS, ViewportStatus: { RENDERED: 'rendered', PRE_RENDER: 'preRender' } },
    metaData: { get: (type, id) => type === 'instance' ? synMeta[id] : type === 'voiLutModule' && synMeta[id] ? { windowCenter: [40], windowWidth: [400] } : undefined },
    utilities: { windowLevel: { toWindowLevel: (low, high) => ({ windowWidth: Math.abs(high - low) + 1, windowCenter: (low + high + 1) / 2 }),
      toLowHighRange: (w, c) => ({ lower: c - 0.5 - (w - 1) / 2, upper: c - 0.5 + (w - 1) / 2 }) } } };
  // Cornerstone's events do not bubble: the features hear them on the document in the capture phase.
  const fire = (v, name, detail = {}) => v.element.dispatchEvent(new CustomEvent(EVENTS[name], { detail: { viewportId: v.id, element: v.element, ...detail } }));
  window.synFire = (id, name) => fire(synViewports.get(id), name);
  window.synViewports = new Map(); window.synShown = new Map(); window.synActive = null; window.synLayout = { rows: 1, cols: 1 }; window.synLayouts = [];
  let firstLayout = true;
  function makeViewport(id, setUid, index, rows, cols) {
    const x = (index % cols) / cols, y = Math.floor(index / cols) / rows;
    const pane = document.createElement('div'); pane.dataset.cy = 'viewport-pane'; pane.id = 'pane-' + id;
    pane.style.left = (x * 1240) + 'px'; pane.style.top = (y * 440) + 'px';
    pane.innerHTML = '<div class="viewport-element"><canvas width="300" height="200"></canvas></div>';
    document.getElementById('grid').append(pane);
    const set = synSets.find(s => s.uid === setUid), element = pane.querySelector('.viewport-element');
    const v = { id, type: 'stack', element, ids: set ? set.ids ? [...set.ids] : Array.from({ length: set.n }, (_, i) => 'syn:' + set.uid + ':' + (i + 1)) : [], index: 0,
      presentation: { rotation: 0 }, properties: { invert: false, voiRange: { lower: -160, upper: 239 }, VOILUTFunction: 'LINEAR', interpolationType: 1 },
      camera: { focalPoint: [0, 0, 5], position: [0, 0, 105], viewUp: [0, -1, 0], viewPlaneNormal: [0, 0, 1], parallelScale: 100, rotation: 0, flipHorizontal: false, flipVertical: false } };
    let fitScale = firstLayout ? 100 / 0.99875 : 100;
    v.camera.parallelScale = fitScale;
    let frame;
    function render() {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = null;
        if (!v.getCurrentImageId() || v.getCornerstoneImage()?.imageId !== v.getCurrentImageId()) return;
        v.viewportStatus = 'rendered';
        fire(v, 'IMAGE_RENDERED');
      });
    }
    function move(index) {
      v.viewportStatus = 'preRender';
      v.index = index;
      fire(v, 'PRE_STACK_NEW_IMAGE');
      fire(v, 'STACK_NEW_IMAGE');
      render();
    }
    Object.assign(v, {
      viewportStatus: set ? 'rendered' : 'noData',
      getImageIds: () => [...v.ids], getCurrentImageId: () => v.ids[v.index], getCurrentImageIdIndex: () => v.index,
      getCornerstoneImage: () => ({ imageId: v.getCurrentImageId() }),
      async setImageIdIndex(index) { if (index !== v.index) move(index); },
      async setStack(ids, index = 0) { v.ids = [...ids]; move(index); },
      getZoom: () => fitScale / v.camera.parallelScale, setZoom(zoom) { v.camera.parallelScale = fitScale / zoom; fire(v, 'CAMERA_MODIFIED'); },
      setPan([x, y]) { v.setCamera({ focalPoint: [x, y, v.camera.focalPoint[2]], position: [x, y, v.camera.position[2]] }); },
      resetProperties() {}, render,
      getCamera: () => structuredClone(v.camera), setCamera(next) { const { rotation, ...rest } = structuredClone(next); v.camera = { ...v.camera, ...rest };
        if (rotation !== undefined) { v.camera.rotation = rotation; v.presentation.rotation = rotation; } fire(v, 'CAMERA_MODIFIED'); },
      getViewPresentation: () => ({ ...v.presentation, zoom: v.getZoom(), pan: v.camera.focalPoint.slice(0, 2) }),
      setViewPresentation(next) {
        if (next.zoom !== undefined) v.setZoom(next.zoom);
        if (next.pan) v.setPan(next.pan);
        if (next.rotation !== undefined) v.setCamera({ rotation: next.rotation });
      },
      resizeTo(scale) {
        if (v.viewportStatus !== 'rendered' || !v.getCurrentImageId()) return;
        // The engine refits a drawn stack, restores its old camera, then the host reapplies the relative presentation.
        const previous = v.getCamera(), presentation = v.getViewPresentation();
        v.setCamera({ parallelScale: scale });
        fitScale = scale;
        v.setCamera(previous);
        v.setViewPresentation(presentation);
        render();
      },
      getProperties: () => structuredClone(v.properties),
      setProperties(next) { v.viewportStatus = 'preRender'; v.properties = { ...v.properties, ...structuredClone(next) };
        if (next.voiRange) fire(v, 'VOI_MODIFIED', { range: next.voiRange }); render(); },
      setVOI(range) { v.properties.voiRange = { ...range }; fire(v, 'VOI_MODIFIED', { range }); },
      getDefaultActor: () => ({ actor: {} }), getCanvas: () => element.querySelector('canvas'),
      getImageData: () => ({ spacing: [0.5, 0.5, 1], imageData: { indexToWorld: ([i, j]) => [i * 0.5, j * 0.5, 0] } }), worldToCanvas: ([x, y]) => [x, y],
    });
    synViewports.set(id, v); synShown.set(id, { set: setUid, x, y, w: 1 / cols, h: 1 / rows });
  }
  window.synBuild = (rows, cols, cells, active) => {
    document.getElementById('grid').replaceChildren(); synViewports.clear(); synShown.clear();
    cells.forEach(([id, set], index) => makeViewport(id, set, index, rows, cols));
    firstLayout = false;
    synLayout = { rows, cols }; synActive = active ?? cells[0][0];
    synEmit('grid', 'gridState', { viewports: cells.map(([id]) => ({ viewportId: id })) });
  };
  window.synCommands = { calls: [], runCommand(name, props, context) { this.calls.push([name, structuredClone(props), context]);
    if (name === 'setViewportWindowLevel') { const v = synViewports.get(props.viewportId); v.setProperties({ voiRange: cornerstone.utilities.windowLevel.toLowHighRange(props.window, props.level) }); } } };
  const listeners = new Map();
  const events = name => ({ subscribe(event, fn) { const key = name + event; listeners.set(key, [...(listeners.get(key) || []), fn]);
    return { unsubscribe() { listeners.set(key, (listeners.get(key) || []).filter(f => f !== fn)); } }; } });
  window.synEmit = (name, event, payload) => { for (const fn of listeners.get(name + event) || []) fn(payload); };
  const grid = { ...events('grid'), EVENTS: { ACTIVE_VIEWPORT_ID_CHANGED: 'active', GRID_STATE_CHANGED: 'gridState', LAYOUT_CHANGED: 'layout' },
    getActiveViewportId: () => synActive, setActiveViewportId: id => { synActive = id; synEmit('grid', 'active', { viewportId: id }); },
    getState: () => ({ activeViewportId: synActive, layout: { numRows: synLayout.rows, numCols: synLayout.cols, layoutType: 'grid' },
      viewports: new Map([...synShown].map(([id, s]) => [id, { viewportId: id, x: s.x, y: s.y, width: s.w, height: s.h, displaySetInstanceUIDs: s.set ? [s.set] : [] }])) }),
    async setLayout({ numRows, numCols, activeViewportId, findOrCreateViewport }) {
      synLayouts.push([numRows, numCols]);
      const cells = Array.from({ length: numRows * numCols }, (_, i) => { const made = findOrCreateViewport(i); return [made.viewportOptions.viewportId, made.displaySetInstanceUIDs[0] || null]; });
      setTimeout(() => synBuild(numRows, numCols, cells, activeViewportId), 50);
    } };
  const buttons = Object.fromEntries(['WindowLevel', 'Pan', 'Zoom'].map(id => [id, { id, uiType: 'ohif.radioGroup', props: { label: id, commands: 'setToolActiveToolbar' } }]));
  window.synServices = {
    viewportGridService: grid,
    cornerstoneViewportService: { ...events('cells'), EVENTS: { VIEWPORT_DATA_CHANGED: 'data' }, getCornerstoneViewport: id => synViewports.get(id) },
    displaySetService: { getActiveDisplaySets: () => synSets.map(s => ({ displaySetInstanceUID: s.uid, StudyInstanceUID: STUDY, SeriesInstanceUID: s.series,
      images: s.images || Array.from({ length: s.n }, (_, i) => ({ SOPInstanceUID: s.series + '.' + (i + 1), SOPClassUID: '1.2.840.10008.5.1.4.1.1.2' })) })) },
    customizationService: { get: () => undefined },
    uiNotificationService: { show: note => synNotes.push(note) },
    toolbarService: { EVENTS: { TOOL_BAR_MODIFIED: 'modified' }, getButtonSection: () => Object.keys(buttons).map(id => ({ id })), getButtons: () => buttons,
      getButtonProps: id => buttons[id] && { id, ...buttons[id].props }, recordInteraction() {}, subscribe: () => ({ unsubscribe() {} }) },
  };
  window.kinViewerHistoryWorkspaceState = () => ({ busy: false });
  window.kinViewerJobWorkspaceState = () => ({ busy: false });
  window.KinViewerHangingSettings = { modalities: [], defaults: {}, get: () => ({}), mount: () => ({ apply() {}, dispose() {} }), mountSizing: () => ({ dispose() {} }) };
  window.KinSessionTransport = { refusal: () => false, responseError: () => new Error('ended') };
  // The API: the account's viewer settings and this study's saved view (one per reader). `hold` keeps the next save's
  // answer back (it is written when released), `holdRead` the next read's. A request whose signal is aborted meanwhile
  // fails and writes nothing, as a cancelled request does. Like the server, an older save of a viewer (its writer id and
  // count) does not write over a newer one, and a save carrying an old Discard generation is refused.
  window.synServer = { revision: 3, viewerSettings: config.settings, saved: config.saved, writers: {}, generation: '0', posts: [], bodies: [], log: [],
    hold: null, release: null, holdRead: null, refuseKeepalive: false };
  window.synRequests = [];
  const reply = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  const VIEW = '/api/studies/' + STUDY + '/viewer-auto-view';
  const held = async (hold, signal) => {
    if (!hold) return;
    await Promise.race([hold, new Promise((_, reject) => signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))))]);
  };
  window.fetch = async (url, init = {}) => {
    const s = synServer, path = new URL(url, location.origin).pathname, method = init.method || 'GET';
    synRequests.push(method + ' ' + String(url));
    if (path === VIEW && method === 'GET') {
      const hold = s.holdRead; s.holdRead = null;
      await held(hold, init.signal);
      return reply(200, { view: s.saved ? { snapshot: structuredClone(s.saved), revision: 1, savedAt: '2026-11-14T01:02:03.000Z' } : null, generation: s.generation });
    }
    if (path === VIEW && method === 'POST') {
      // A keepalive request over the browser's budget is refused before it is sent (refuseKeepalive).
      if (init.keepalive && s.refuseKeepalive) { s.log.push('refused'); throw new TypeError('Failed to fetch'); }
      const body = JSON.parse(init.body); s.posts.push(body.snapshot); s.bodies.push({ writer: body.writer, seq: body.seq, at: body.at, generation: body.generation, keepalive: !!init.keepalive }); s.log.push('save');
      const hold = s.hold; s.hold = null;
      try { await held(hold, init.signal); } catch (error) { s.log.push('aborted'); throw error; }
      if ((s.writers[body.writer] || 0) >= body.seq || body.generation !== s.generation) { s.log.push('stale'); return reply(200, { saved: false, revision: s.posts.length, savedAt: '2026-11-14T02:03:04.000Z', generation: s.generation }); }
      s.saved = body.snapshot; s.writers[body.writer] = body.seq; s.log.push('saved');
      return reply(200, { saved: true, revision: s.posts.length, savedAt: '2026-11-14T02:03:04.000Z', generation: s.generation });
    }
    if (path === VIEW + '/discard' && method === 'POST') {
      const body = JSON.parse(init.body); s.log.push('discard'); const had = !!s.saved; s.saved = null;
      s.generation = String(BigInt(s.generation) + 1n); s.writers[body.writer] = Math.max(s.writers[body.writer] || 0, body.seq);
      return reply(200, { discarded: had, generation: s.generation });
    }
    if (!path.endsWith('/api/workspace-shortcuts')) return reply(404, {});
    if (method === 'GET') return reply(200, { owner, revision: s.revision, viewerSettings: structuredClone(s.viewerSettings) });
    const body = JSON.parse(init.body); s.revision++; s.viewerSettings = body.viewerSettings;
    return reply(200, { owner, revision: s.revision, viewerSettings: structuredClone(s.viewerSettings) });
  };
  // The first cell as it stands, whatever its viewport is called now.
  window.synFirst = () => { const v = [...synViewports.values()][0]; return { id: v.id, image: synMeta[v.getCurrentImageId()].SOPInstanceUID, zoom: v.getZoom() }; };
  // A cell whose image has not come yet (it shows none: there is nothing to capture there), and its coming, with the
  // viewer's own word of it (STACK_NEW_IMAGE) or with none.
  window.synLoading = (index = 1) => { const v = [...synViewports.values()][index]; v.kept = v.ids; v.ids = []; v.viewportStatus = 'loading'; };
  window.synLoaded = (index = 1, silent = false) => {
    const v = [...synViewports.values()][index];
    if (silent) { v.ids = v.kept; v.viewportStatus = 'rendered'; return; }
    const drawn = new Promise(resolve => v.element.addEventListener('syn-rendered', resolve, { once: true }));
    v.setStack(v.kept, 0);
    return drawn;
  };
  window.synSession = { owner: () => owner, ended: () => synEnded, writer: () => synWriter, state: () => 'confirmed', decide: async () => {} };
  window.synMount = () => {
    window.synToolbar = KinViewerUXToolbar.mount({ services: synServices, commands: synCommands, session: synSession });
    window.synKeys = KinViewerUXShortcuts.mount({ getBindings: () => synToolbar.bindings(), invoke: id => synToolbar.invoke(id), allowed: () => !synEnded });
  };
}"""

STATE = """id => { const v = synViewports.get(id); return v && { ids: v.getImageIds(), index: v.index, image: v.getCurrentImageId(), scale: v.camera.parallelScale,
  focal: v.camera.focalPoint, flipV: v.camera.flipVertical, voi: v.properties.voiRange, invert: v.properties.invert }; }"""


def cell(series, n, scale=40, lower=-1060, upper=439, flip=False, display=None, index=None):
    """A saved stack cell showing image n of the series (index n-1 in stock order)."""
    return {'study': STUDY, 'series': series, 'sop': series + '.' + str(n), 'frame': 1, 'index': n - 1 if index is None else index, 'zoom': 100 / scale,
            'camera': {'focalPoint': [12.5, -3.25, n * 5], 'position': [12.5, -3.25, n * 5 + 100], 'viewUp': [0, -1, 0], 'viewPlaneNormal': [0, 0, 1],
                       'parallelScale': scale, 'rotation': 0, 'flipHorizontal': False, 'flipVertical': flip},
            'properties': {'voiRange': {'lower': lower, 'upper': upper}, 'VOILUTFunction': 'LINEAR', 'invert': False, 'interpolationType': 1},
            'display': display}


def view(cells, rows=1, cols=None, active=0):
    return {'version': 1, 'studies': [STUDY], 'rows': rows, 'cols': cols or len(cells) // rows, 'active': active, 'cells': cells}


# Cells a restore lays out anew draw their image a moment after they take it, as the viewer's stacks do: the first image
# drawn in a cell puts the image's own window on it and a camera fitted to it, keeping the zoom and pan measured from the
# empty cell's camera (scale 1), so a camera put on before that comes back a hundred times smaller. Moving to an image
# draws it before the move is over. The viewer's first cells have drawn theirs. (`drawn`: the image drawn, or null;
# synDrawAfter: the moment in ms, synNeverDraws: a set whose cell never draws its first image.)
LATE_DRAWING = """() => {
  const build = window.synBuild;
  window.synBuild = (rows, cols, cells, active) => {
    build(rows, cols, cells, active);
    for (const v of synViewports.values()) {
      v.getCornerstoneImage = () => v.drawn ? { imageId: v.drawn } : undefined;
      if (!v.id.startsWith('kin-auto-view-')) { v.drawn = v.getCurrentImageId(); continue; }
      v.drawn = null; v.viewportStatus = 'preRender';
      const arrive = () => {
        if (v.drawn === v.getCurrentImageId()) return;
        if (!v.drawn) { const shift = v.camera.focalPoint.map(n => n * 99); v.camera.parallelScale = 100 * v.camera.parallelScale;
          v.camera.focalPoint = v.camera.focalPoint.map((n, i) => n + shift[i]); v.camera.position = v.camera.position.map((n, i) => n + shift[i]);
          v.properties.voiRange = { lower: -160, upper: 239 }; }
        v.drawn = v.getCurrentImageId();
        v.element.dispatchEvent(new CustomEvent('syn-new', { detail: { viewportId: v.id, element: v.element } }));
        v.render();
      };
      const move = v.setImageIdIndex;
      v.setImageIdIndex = async index => { await move(index); arrive(); };
      if (window.synNeverDraws !== synShown.get(v.id)?.set) setTimeout(arrive, window.synDrawAfter || 700);
    }
  };
}"""

# The reader turns the wheel on a cell (place in grid order) and it goes to an image (its place in the stack).
READER_MOVES = """([at, index]) => { const v = [...synViewports.values()][at];
  v.element.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true })); v.setImageIdIndex(index); }"""

SORT_DOWN = {'magnification': 'fit', 'windowing': None, 'filter': 'none', 'sort': 'position-desc', 'rotate': 0, 'flip': 'none',
             'firstImage': 'first', 'gspsAuto': False, 'overlay': 'none'}

# ── A restore the address chose: the shipped Jobs panel and Findings section beside Auto Save View ──
JOB_ID = JOB.split('=')[1]
FINDING, NONCE = 'f0000000-0000-4000-8000-00000000d001', '11111111-2222-4333-8444-555555555555'
# A finding's saved location continued into this page (finding-link-model.js continueLocation).
FOUND = '&kinFinding=%s&kinFindingRevision=4&kinFindingSource=0&kinFindingNonce=%s' % (FINDING, NONCE)
OTHER = '1.2.826.0.1.3680043.8.498.141'
# viewer-jobs.js restoredText and its refusal of a restore the reader's input came ahead of; finding-link-model.js.
RESTORED = '비교 작업을 복원했습니다. 표식은 별도 저장한 최신 이력입니다.'
INPUT_AHEAD = '영상 조작이 변경되어 복원하지 않았습니다. 다시 시도하세요. 입력은 유지됩니다.'
OPENING_PAIR = '저장한 비교 검사를 함께 여는 중…'
LIST_FAILED = '소견 목록을 확인하지 못했습니다. Refresh로 다시 확인하세요.'
SAVED = [SA + '.4', SB + '.2']  # the images of the saved view each of these pages starts with
JOB_IMAGE = SA + '.6'           # the image the Job puts in the first cell
# viewer-jobs.js: the restore failed and the screen before it could not be put back either.
UNKNOWN = '복원과 이전 화면 복구에 실패했습니다.'
# The next save's answer, or the next read's, kept back until the case lets it go (synServer.release, releaseRead).
HOLD = "() => { synServer.hold = new Promise(resolve => { synServer.release = resolve; }); }"
HOLD_READ = "() => { synServer.holdRead = new Promise(resolve => { synServer.releaseRead = resolve; }); }"
# This viewer's saved view is being read: its first layout stands, and it starts saving as that read answers.
READING = "synRequests.some(r => r.startsWith('GET ') && r.endsWith('/viewer-auto-view'))"
# The reader's view (zoom 3, the third image) as it is sent before a restore while its first save stays unanswered:
# after the usual delay, and once more as the restore begins.
BEFORE = [(3, SA + '.3')] * 2


def job_cell(series, n, scale, lower, upper):
    """One cell of a version 2 Job as viewer-jobs.js saves it."""
    return {'study': STUDY, 'series': series, 'sop': series + '.' + str(n), 'frame': 1, 'viewport': {'width': 300, 'height': 200},
            'camera': {'focalPoint': [1.5, -2.5, n * 5], 'position': [1.5, -2.5, n * 5 + 100], 'viewUp': [0, -1, 0], 'viewPlaneNormal': [0, 0, 1],
                       'parallelScale': scale, 'rotation': 0, 'flipHorizontal': False, 'flipVertical': False},
            'properties': {'voiRange': {'lower': lower, 'upper': upper}, 'VOILUTFunction': 'LINEAR', 'invert': False, 'interpolationType': 1}}


def job(studies=(STUDY,)):
    return {'id': JOB_ID, 'revision': 1, 'snapshotVersion': 2, 'snapshot': {'version': 2, 'studies': list(studies), 'rows': 1, 'cols': 2, 'active': 0,
            'cells': [job_cell(SA, 6, 25, -1350, 150), job_cell(SB, 3, 50, -160, 239)]}}


JOB_ROW = {'id': JOB_ID, 'studyUid': STUDY, 'authorSub': OWNER[1], 'authorActor': 'Reader', 'title': 'Synthetic Job', 'description': '', 'hidden': False,
           'revision': 1, 'createdAt': 0, 'updatedAt': 0, 'snapshotVersion': 2}
# A finding of this study whose one source is that Job's saved view.
FOUND_ITEM = {'id': FINDING, 'studyUid': STUDY, 'authorSub': OWNER[1], 'authorActor': 'Reader', 'revision': 4, 'hidden': False, 'createdAt': 't', 'updatedAt': 't', 'links': [],
              'item': {'schemaVersion': 2, 'title': 'Synthetic finding', 'text': '', 'characteristics': '', 'hidden': False, 'primary': 0,
                       'sources': [{'kind': 'job', 'jobId': JOB_ID, 'revision': 1, 'jobStudyUid': STUDY, 'studyUid': STUDY, 'studies': [STUDY], 'snapshotVersion': 2,
                                    'title': 'Synthetic Job', 'authorActor': 'Reader', 'mark': None}]}}

# Run before the viewer mounts. Synthetic here: the hosts of the two panels, the API (/me, this study's Jobs and findings), the
# session's end, and the stack restore the Jobs panel applies a version 2 Job with. A gate is a named point a case holds
# until it opens it: 'read' is the Job's read; each apply of the stack restore takes its step (its gate, whether it fails)
# from synRestore.steps. The stack restore lays the saved cells onto the synthetic viewports, the first cell before its
# gate and the rest after it, so a restore can be seen half done; failing there, the layout has landed already and the
# panel rolls back with another apply. synTold is what the panel says to the window, with the holds standing as it is said.
COMBINED = """config => {
  const STUDY = config.study, owner = config.owner, JOBS = '/api/studies/' + STUDY + '/viewer-jobs';
  window.synGates = {};
  window.synGate = name => { let open; const gate = new Promise(resolve => { open = resolve; }); synGates[name] = { gate, open }; };
  window.synOpen = name => synGates[name].open();
  const passed = async name => { if (synGates[name]) await synGates[name].gate; };
  const hosts = document.createElement('div');
  hosts.style.cssText = 'position:absolute;left:0;top:540px;width:1240px;height:340px;overflow:auto;font-size:11px';
  hosts.innerHTML = (config.layout ? '<details id="kin-viewer-layout" open><summary>Layout</summary></details>' : '') + '<div id="kin-viewer-history"></div>';
  document.body.append(hosts);
  window.synJobs = { rows: [config.row], job: config.job, readStatus: 200, reads: 0 };
  window.synFindingServer = { status: config.findingsStatus, items: config.findings, lists: 0 };
  const reply = (status, body, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
  const base = window.fetch;
  window.fetch = async (url, init = {}) => {
    const path = new URL(url, location.origin).pathname, method = init.method || 'GET';
    if (path === '/api/me') return reply(200, { kind: 'member', sub: owner[1], institution: owner[0], roles: ['radiologist'] });
    if (path === JOBS && method === 'GET') return reply(200, { jobs: structuredClone(synJobs.rows) });
    if (path === JOBS + '/' + synJobs.job.id && method === 'GET') {
      synJobs.reads++; await passed('read');
      return synJobs.readStatus === 200 ? reply(200, structuredClone(synJobs.job)) : reply(synJobs.readStatus, { message: 'SYN job unavailable' });
    }
    if (path === '/api/studies/' + STUDY + '/findings' && method === 'GET') {
      synFindingServer.lists++;
      return synFindingServer.status === 200 ? reply(200, { items: structuredClone(synFindingServer.items), nextCursor: null }, { 'X-KIN-Finding-Schema': '3' })
        : reply(synFindingServer.status, { message: 'SYN findings unavailable' });
    }
    return base(url, init);
  };
  window.synEnders = new Set();
  window.kinViewerOnEnd = fn => { synEnders.add(fn); return { close() { synEnders.delete(fn); } }; };
  window.synEndSession = () => { synEnded = true; for (const fn of [...synEnders]) fn(); };
  window.kinViewerHistoryState = () => ({ scope: STUDY, subject: owner[1], ended: synEnded, suspended: false, writable: true, heads: [] });
  if (config.continuation) sessionStorage.setItem('kin-finding-continue:' + config.continuation.nonce, JSON.stringify(config.continuation.record));
  window.synRestore = { steps: [], waiting: null };
  const place = (id, cell) => {
    const v = synViewports.get(id); if (!v || !cell) return;
    v.setImageIdIndex(v.getImageIds().findIndex(image => synMeta[image].SOPInstanceUID === cell.sop));
    v.setProperties(structuredClone(cell.properties)); v.setCamera(structuredClone(cell.camera));
    return new Promise(resolve => v.element.addEventListener('syn-rendered', resolve, { once: true }));
  };
  window.kinCreateStackRestore = () => ({
    prepare: async (cells, sets) => cells.map((cell, index) => ({ cell, set: sets[index] })),
    begin: (plans, ids) => ({
      options: index => ({ viewportId: ids[index], viewportType: 'stack', toolGroupId: 'default', allowUnmatchedView: true }),
      async complete() {
        const step = synRestore.steps.shift() || {};
        for (let n = 0; n < 200 && !ids.every((id, index) => !plans[index].cell || synViewports.has(id)); n++) await new Promise(resolve => setTimeout(resolve, 10));
        const draws = [place(ids[0], plans[0].cell)];
        if (step.gate) {
          if (!synGates[step.gate]) synGate(step.gate);
          synRestore.waiting = step.gate; await passed(step.gate);
          if (synRestore.waiting === step.gate) synRestore.waiting = null;
        }
        if (step.fail) throw new Error('저장한 영상 표시를 확인하지 못했습니다.');
        plans.forEach((plan, index) => { if (index) draws.push(place(ids[index], plan.cell)); });
        await Promise.all(draws);
      },
      verify() {}, dispose() {},
    }),
  });
  window.synTold = [];
  addEventListener('kin-viewer-opening-restore', event => synTold.push([event.detail.phase, event.detail.hold.screen, window.kinViewerOpeningRestore.holds.size]));
  // After the scripts: the page's own work context and transport, as the Findings store reads them.
  window.synConnect = () => {
    const gate = KinWorkContext.create(); gate.follow({ onLifecycle(fn) { fn({ state: 'active', session: 'SYN' }); } });
    const transport = KinSessionTransport.create({ gate, fetch: (url, options) => window.fetch(url, options), deadlineMs: 0 });
    window.KinWorkContext = gate; window.KinSessionTransport = { ...KinSessionTransport, page: () => transport };
  };
  window.synMountJobs = () => { window.synJobsPanel ||= kinViewerJobs(synServices, { scope: () => [STUDY] }, null, () => ({})); synJobsPanel.mount(); };
  window.synJobsStatus = () => document.querySelector('#kin-viewer-jobs-status')?.textContent || '';
  window.synMountFindings = model => { window.synFindings ||= kinViewerFindings({}, model || kinFindingLinkModel); return synFindings.mount(); };
  // The mode left (every part of the screen taken down) and entered again at the same address.
  window.synLeaveMode = () => { window.synJobsPanel?.stop(); window.synFindings?.stop(); synKeys?.dispose?.(); synToolbar.dispose(); };
  window.synEnterMode = () => { synBuild(1, 2, [['left', 'set-A'], ['right', 'set-B']]); synMount(); };
}"""


class ViewerAutoSaveViewDOMTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.pw = sync_playwright().start()
        cls.browser = cls.pw.chromium.launch()

    @classmethod
    def tearDownClass(cls):
        cls.browser.close(); cls.pw.stop()

    def open(self, on=True, saved=None, cells=(('left', 'set-A'), ('right', 'set-B')), rows=1, query='', setup=None, late=(), opener=None, owner=OWNER, prepare=None,
             autosave=True):
        """`setup`: script run before the viewer mounts; `late`: scripts held back until `self.pending` is fulfilled;
        `prepare`: called with the page before the viewer mounts; `autosave`: False leaves the Auto Save View module
        out until the case installs it (`install`)."""
        if opener:
            context = opener.context
            with opener.expect_popup() as popup:
                opener.evaluate("window.open('about:blank')")
            page = popup.value
        else:
            context = self.browser.new_context(viewport={'width': 1366, 'height': 900})
            self.addCleanup(context.close)
            page = context.new_page()
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        url = ORIGIN + '/ohif/viewer?StudyInstanceUIDs=' + STUDY + query
        page.route(url, lambda route: route.fulfill(body=HARNESS, content_type="text/html"))
        self.pending = []
        for name in ['viewer-auto-view-model.js', 'hanging-protocol-model.js', 'viewer-image-filter.js', 'viewer-gsps.js']:
            serve = self.serve(HPACS / name)
            page.route(ORIGIN + "/worklist/hpacs-lite/" + name, (lambda serve: lambda route: self.pending.append(lambda: serve(route)))(serve) if name in late else serve)
        page.goto(url)
        page.add_style_tag(path=str(HPACS / "viewer-ux-theme.css"))
        for name in ["exam-scope.js", "viewer-ux-shortcuts.js", "viewer-features.js", "viewer-features-view.js", "viewer-features-autosave.js", "viewer-ux-toolbar.js"]:
            if autosave or name != "viewer-features-autosave.js":
                page.add_script_tag(path=str(HPACS / name))
        settings = {'version': 2, 'bar': ['WindowLevel', 'Pan', 'Zoom'], 'shortcuts': {}, 'features': {'autoSaveView': True}} if on else None
        page.evaluate(SETUP, {'study': STUDY, 'owner': owner, 'sa': SA, 'sb': SB, 'settings': settings, 'saved': saved})
        if setup:
            page.evaluate(setup)
        if prepare:
            prepare(page)
        cells = [list(c) for c in cells]
        page.evaluate("([rows, cols, cells]) => { synBuild(rows, cols, cells); synMount(); }", [rows, len(cells) // rows, cells])
        page.wait_for_function(("KinViewerFeatures.settings().some(s => s.id === 'autoSaveView')" if autosave else "true") + ("" if late else " && !!window.KinViewerCellRules"))
        page.evaluate("() => { for (const v of synViewports.values()) v.resizeTo(100); }")
        self.addCleanup(lambda: self.assertEqual([], errors))
        return page

    def install(self, page):
        """The Auto Save View module arrives now (a script that came late): the viewer installs it at once."""
        page.add_script_tag(path=str(HPACS / "viewer-features-autosave.js"))
        page.wait_for_function("KinViewerFeatures.settings().some(s => s.id === 'autoSaveView')")

    @staticmethod
    def serve(path):
        return lambda route: route.fulfill(path=str(path), content_type="text/javascript; charset=utf-8")

    def requests(self, page):
        return [r for r in page.evaluate('synRequests') if 'viewer-auto-view' in r]

    def posts(self, page):
        return page.evaluate('synServer.posts')

    def state(self, page, cell):
        return page.evaluate(STATE, cell)

    def change(self, page, cell='left', zoom=2.5, window=(1500, -600), image=5):
        """The reader changes one cell and sees the chosen image before switching or closing."""
        page.evaluate("""([id, zoom, w, l, image]) => { const v = synViewports.get(id);
          v.setZoom(zoom); v.setProperties({ voiRange: cornerstone.utilities.windowLevel.toLowHighRange(w, l) }); v.setImageIdIndex(image);
          return new Promise(resolve => v.element.addEventListener('syn-rendered', resolve, { once: true })); }""",
                      [cell, zoom, window[0], window[1], image])

    def started(self, page):
        # The viewer's first layout stands for the quiet time and the module is saving (or not) from there on.
        page.wait_for_timeout(1200)

    def window(self, page, via='menu'):
        if via == 'menu':
            page.get_by_role('button', name='Display ▾').click()
            page.get_by_role('menuitem', name='Auto Save View…').click()
            panel = page.locator('section.kin-ux-feature-panel[aria-label="Auto Save View"]')
        else:
            page.get_by_role('button', name='Viewer Settings').click()
            page.locator('dialog.kin-ux-settings .kin-ux-feature-setting-buttons').get_by_role('button', name='Auto Save View…').click()
            panel = page.locator('dialog.kin-ux-feature-panel[aria-label="Auto Save View"]')
        expect(panel).to_be_visible()
        return panel

    def test_01_the_check_the_menu_and_the_window(self):
        page = self.open(on=False)
        # Viewer Settings > Tools & Display: the account check (off by default) and the window's button.
        page.get_by_role('button', name='Viewer Settings').click()
        dialog = page.locator('dialog.kin-ux-settings')
        expect(dialog.get_by_label(CHECK)).not_to_be_checked()
        expect(dialog.locator('.kin-ux-feature-setting-buttons').get_by_role('button', name='Auto Save View…')).to_be_visible()
        page.keyboard.press('Escape')
        # Display > Auto Save View...: the same switch, the last saved view of this study and Discard Saved View.
        panel = self.window(page)
        expect(panel.get_by_label(CHECK)).not_to_be_checked()
        expect(panel.locator('[data-auto-view-saved]')).to_have_text('No view of this study is saved.')
        expect(panel.get_by_role('button', name='Discard Saved View')).to_be_disabled()
        self.assertEqual([], self.posts(page))
        # Switching it on in the window saves the account setting (viewerSettings.features.autoSaveView).
        panel.get_by_label(CHECK).check()
        expect(panel.get_by_role('status')).to_have_text('On: view changes are saved and applied when this study is opened again.')
        self.assertEqual(True, page.evaluate('synServer.viewerSettings.features.autoSaveView'))

    def test_scope_is_named_on_read_save_and_discard_without_replacing_the_discard_generation(self):
        group = '00000000-0000-4000-8000-000000000021'
        scope = {'reportUid': STUDY, 'groupId': group, 'part': 0, 'kind': 'split', 'active': True,
                 'sources': [{'studyUid': STUDY, 'series': {'mode': 'exclude', 'uids': []}}], 'generation': 'exam-generation'}
        setup = """() => {
          const current = %s;
          window.KinViewerExamScope = {snapshot: () => ({reportUid: current.reportUid, current, prior:null}),
            allows: (_input, study, series) => current.sources.some(s => s.studyUid === study && KinExamScope.allows(s, series))};
          const fetch = window.fetch;
          window.synScopeRequests = [];
          window.fetch = (url, init = {}) => {
            if (String(url).includes('viewer-auto-view')) synScopeRequests.push({url:String(url),method:init.method || 'GET'});
            return fetch(url, init);
          };
        }""" % json.dumps(scope)
        page = self.open(setup=setup)
        self.started(page)
        self.change(page)
        page.wait_for_function('synServer.posts.length === 1')
        panel = self.window(page)
        panel.get_by_role('button', name='Discard Saved View').click()
        page.wait_for_function("synServer.generation === '1'")
        rows = page.evaluate("synScopeRequests.map(r => ({method:r.method,path:new URL(r.url,location.origin).pathname,exam:JSON.parse(new URL(r.url,location.origin).searchParams.get('exam'))}))")
        self.assertTrue(any(r['method'] == 'GET' for r in rows))
        self.assertTrue(any(r['method'] == 'POST' and not r['path'].endswith('/discard') for r in rows))
        self.assertTrue(any(r['path'].endswith('/discard') for r in rows))
        for row in rows:
            self.assertEqual({'reportUid': STUDY, 'groupId': group, 'part': 0}, row['exam']['current'])
        self.assertEqual('0', page.evaluate('synServer.bodies[0].generation'))

    def test_02_on_one_save_a_moment_after_the_last_change_with_the_whole_view(self):
        page = self.open()
        self.started(page)
        self.assertEqual([], self.posts(page), 'opening the viewer saves nothing')
        self.change(page, zoom=2, window=(400, 40), image=2)
        page.wait_for_timeout(800)
        self.change(page, zoom=2.5, window=(1500, -600), image=5)
        page.wait_for_timeout(1000)
        self.assertEqual([], self.posts(page), 'nothing before the view has been still for two seconds')
        page.wait_for_function('synServer.posts.length === 1', timeout=5000)
        page.wait_for_timeout(2500)
        posts = self.posts(page)
        self.assertEqual(1, len(posts), 'one save for the changes together')
        saved = posts[0]
        self.assertEqual((1, 1, 2, 0, [STUDY]), (saved['version'], saved['rows'], saved['cols'], saved['active'], saved['studies']))
        left, right = saved['cells']
        self.assertEqual((SA, SA + '.6', 1, 5), (left['series'], left['sop'], left['frame'], left['index']))
        self.assertEqual(40, left['camera']['parallelScale']); self.assertEqual(2.5, left['zoom'])
        self.assertEqual({'lower': -1350, 'upper': 149}, left['properties']['voiRange'])
        self.assertEqual((SB, SB + '.1', None), (right['series'], right['sop'], right['display']))
        # A cell's Display Set Presets rule is part of it.
        page.evaluate("KinViewerCellRules.apply('right', %s)" % json.dumps(SORT_DOWN))
        page.wait_for_function('synServer.posts.length === 2', timeout=6000)
        right = self.posts(page)[1]['cells'][1]
        self.assertEqual(SORT_DOWN, right['display'])
        self.assertEqual((SB + '.4', 0), (right['sop'], right['index']), 'the image is named by its SOP; slice position down shows image 4 first')

    def test_03_off_no_request_at_all(self):
        page = self.open(on=False, saved=view([cell(SA, 3), cell(SB, 2)]))
        self.started(page)
        self.change(page)
        page.wait_for_timeout(3000)
        self.assertEqual([], self.requests(page), 'neither read nor saved while the check is off')
        self.assertEqual('syn:set-A:6', self.state(page, 'left')['image'], 'the reader\'s own change stays; no saved view was put back')

    def test_04_reopen_puts_the_saved_view_back_and_saves_nothing_meanwhile(self):
        saved = view([cell(SA, 7, scale=26.5, lower=31, upper=192, flip=True), cell(SB, 2, display=SORT_DOWN, index=2)], active=1)
        # The viewer opens on one cell of series A; the saved view is two cells, A and B.
        page = self.open(saved=saved, cells=(('first', 'set-A'),))
        page.wait_for_function("document.querySelector('[data-auto-view-badge]')", timeout=8000)
        expect(page.locator('[data-auto-view-badge]')).to_contain_text('2 of 2 cells')
        self.assertEqual([[1, 2]], page.evaluate('synLayouts'), 'the saved layout')
        ids = page.evaluate('[...synViewports.keys()]')
        left, right = self.state(page, ids[0]), self.state(page, ids[1])
        self.assertEqual(('syn:set-A:7', 26.5, True, {'lower': 31, 'upper': 192}), (left['image'], left['scale'], left['flipV'], left['voi']))
        self.assertEqual([12.5, -3.25, 35], left['focal'])
        # The right cell's rule went first (slice position down: 4, 3, 2, 1); its image is found by SOP in that order.
        self.assertEqual(['syn:set-B:4', 'syn:set-B:3', 'syn:set-B:2', 'syn:set-B:1'], right['ids'])
        self.assertEqual(('syn:set-B:2', 2), (right['image'], right['index']))
        self.assertEqual(ids[1], page.evaluate('synActive'))
        badge = page.locator('[data-auto-view-badge]')
        expect(badge).to_have_text('Restored saved view: Zoom 250%, W 1500 / L -310, Image 3 (2 of 2 cells)')
        # Pressing the badge opens the window, which names the saved view.
        badge.click()
        panel = page.locator('section.kin-ux-feature-panel[aria-label="Auto Save View"]')
        expect(panel.locator('[data-auto-view-saved]')).to_contain_text('2 cells · Zoom 250%, W 1500 / L -310, Image 3')
        # Putting the view back changed every cell many times: nothing was saved for it.
        page.wait_for_timeout(3000)
        self.assertEqual([], self.posts(page))
        self.assertEqual(['GET /api/studies/%s/viewer-auto-view' % STUDY], self.requests(page))
        # The badge goes after a few seconds.
        page.wait_for_function("!document.querySelector('[data-auto-view-badge]')", timeout=8000)

    def test_05_a_cell_whose_series_is_gone_is_left_and_the_badge_says_so(self):
        gone = cell(SB, 2); gone['series'] = STUDY + '.9'; gone['sop'] = STUDY + '.9.2'
        page = self.open(saved=view([cell(SA, 4), gone]))
        page.wait_for_function("document.querySelector('[data-auto-view-badge]')", timeout=8000)
        self.assertEqual([], page.evaluate('synLayouts'), 'the layout stays: not every saved series is here')
        self.assertEqual('syn:set-A:4', self.state(page, 'left')['image'])
        self.assertEqual(('syn:set-B:1', 100), (self.state(page, 'right')['image'], self.state(page, 'right')['scale']))
        expect(page.locator('[data-auto-view-badge]')).to_have_text('Restored saved view: Zoom 250%, W 1500 / L -310, Image 4 (1 of 2 cells; 1 not restored)')

    def test_05b_one_multi_frame_file_split_by_time_point_restores_the_part_holding_the_saved_frame(self):
        # One enhanced MR file (one SOP Instance, six frames) that the viewer's split-series rule shows as two sets, one
        # per time point; both sets hold the same SOP, so only the saved frame tells them apart.
        se, sop = STUDY + '.7', STUDY + '.7.1'
        setup = """([se, sop]) => {
          const record = n => Object.assign(Object.create({ SOPInstanceUID: sop, SOPClassUID: '1.2.840.10008.5.1.4.1.1.4.1' }), { kinSplitFrame: n });
          const id = n => 'syn:mr/frames/' + n;
          for (let n = 1; n <= 6; n++) synMeta[id(n)] = { Modality: 'MR', StudyInstanceUID: synMeta['syn:set-A:1'].StudyInstanceUID, SeriesInstanceUID: se,
            SOPInstanceUID: sop, InstanceNumber: 1, ImagePositionPatient: [0, 0, ((n - 1) % 3) * 5], ImageOrientationPatient: [1, 0, 0, 0, 1, 0],
            PixelSpacing: [0.5, 0.5], Rows: 400, Columns: 600 };
          synSets.push({ uid: 'phase-1', series: se, n: 3, ids: [1, 2, 3].map(id), images: [1, 2, 3].map(record) },
                       { uid: 'phase-2', series: se, n: 3, ids: [4, 5, 6].map(id), images: [4, 5, 6].map(record) });
        }"""
        saved = cell(se, 2)
        saved.update({'sop': sop, 'frame': 5, 'index': 1})
        def prepare(page):
            page.add_script_tag(content=SPLIT_RULE)
            page.evaluate(setup, [se, sop])
        page = self.open(saved=view([saved]), cells=(('left', 'phase-1'),), prepare=prepare)
        page.wait_for_function("document.querySelector('[data-auto-view-badge]')", timeout=8000)
        left = self.state(page, page.evaluate('[...synViewports.keys()]')[0])
        self.assertEqual(['syn:mr/frames/4', 'syn:mr/frames/5', 'syn:mr/frames/6'], left['ids'], 'the second time point is shown')
        self.assertEqual(('syn:mr/frames/5', 1), (left['image'], left['index']))
        expect(page.locator('[data-auto-view-badge]')).to_have_text('Restored saved view: Zoom 250%, W 1500 / L -310, Image 2')

    def test_05c_series_put_in_another_order_come_back_with_their_zoom_once_each_image_is_drawn(self):
        # The saved view has the second series in the first cell, on its first image: the viewer opens with the series the
        # other way round, so the saved layout is laid out anew and that cell is a new one still drawing its first image.
        setup = """() => { (%s)();
          const grid = document.getElementById('grid');
          function resize(event) {
            const v = synViewports.get(event.detail.viewportId);
            if (v?.drawn !== 'syn:set-A:4') return;
            grid.removeEventListener('syn-rendered', resize, true);
            v.resizeTo(99.875);
          }
          grid.addEventListener('syn-rendered', resize, true); }""" % LATE_DRAWING
        page = self.open(saved=view([cell(SB, 1, scale=26.5, lower=31, upper=192), cell(SA, 4)]), setup=setup)
        page.wait_for_function("document.querySelector('[data-auto-view-badge]')", timeout=12000)
        page.wait_for_timeout(1200)
        ids = page.evaluate('[...synViewports.keys()]')
        self.assertEqual([[1, 2]], page.evaluate('synLayouts'))
        left, right = self.state(page, ids[0]), self.state(page, ids[1])
        self.assertEqual(('syn:set-B:1', 26.5, {'lower': 31, 'upper': 192}), (left['image'], left['scale'], left['voi']),
                         'the first cell keeps the saved zoom and window once its image has come')
        self.assertEqual([12.5, -3.25, 5], left['focal'])
        self.assertEqual(('syn:set-A:4', 40, {'lower': -1060, 'upper': 439}), (right['image'], right['scale'], right['voi']))
        self.assertEqual(['syn:set-B:1', 'syn:set-A:4'], page.evaluate('[...synViewports.values()].map(v => v.drawn)'))
        expect(page.locator('[data-auto-view-badge]')).to_have_text('Restored saved view: Zoom 377%, W 162 / L 112, Image 1 (2 of 2 cells)')
        page.wait_for_timeout(2500)
        self.assertEqual([], self.posts(page), 'putting the view back saved nothing')

    def test_05d_a_cell_the_reader_moves_on_while_its_image_comes_is_left_to_the_reader(self):
        page = self.open(saved=view([cell(SB, 1, scale=26.5, lower=31, upper=192), cell(SA, 4)], active=1),
                         setup="() => { (" + LATE_DRAWING + ")(); window.synDrawAfter = 4000; }")
        page.wait_for_function("[...synViewports.keys()].some(id => id.startsWith('kin-auto-view-'))", timeout=8000)
        page.wait_for_timeout(600)
        # The reader turns the wheel on the first cell before its first image has come: it goes to the third image.
        page.evaluate(READER_MOVES, [0, 2])
        page.wait_for_timeout(5000)
        ids = page.evaluate('[...synViewports.keys()]')
        left, right = self.state(page, ids[0]), self.state(page, ids[1])
        self.assertEqual('syn:set-B:3', left['image'], 'the image the reader went to stays')
        self.assertNotEqual(26.5, left['scale'], 'the saved camera of image 1 is not put on image 3')
        self.assertNotEqual({'lower': 31, 'upper': 192}, left['voi'])
        self.assertEqual('syn:set-A:4', right['image'])
        expect(page.locator('[data-auto-view-badge]')).to_contain_text('1 of 2 cells; 1 not restored')
        page.wait_for_function('synServer.posts.length === 1', timeout=8000)
        self.assertEqual([SB + '.3', SA + '.4'], [c['sop'] for c in self.posts(page)[0]['cells']])

    def test_05f_a_cell_the_reader_moves_while_another_waits_for_its_image_is_not_put_back_over(self):
        page = self.open(saved=view([cell(SB, 1, scale=26.5, lower=31, upper=192), cell(SA, 4)], active=1),
                         setup="() => { (" + LATE_DRAWING + ")(); window.synDrawAfter = 4000; }")
        page.wait_for_function("[...synViewports.keys()].some(id => id.startsWith('kin-auto-view-'))", timeout=8000)
        page.wait_for_timeout(600)
        # While the first cell waits for its image, the reader goes to the seventh image of the second.
        page.evaluate(READER_MOVES, [1, 6])
        page.wait_for_timeout(5000)
        ids = page.evaluate('[...synViewports.keys()]')
        self.assertEqual('syn:set-A:7', self.state(page, ids[1])['image'], 'the saved image 4 is not put back over the reader\'s choice')
        self.assertEqual(26.5, self.state(page, ids[0])['scale'], 'the independent first cell restored')
        page.wait_for_function('synServer.posts.length === 1', timeout=8000)
        self.assertEqual([SB + '.1', SA + '.7'], [c['sop'] for c in self.posts(page)[0]['cells']])

    def test_05e_late_draw_keeps_its_saved_cell_while_other_zoom_changes_are_sent(self):
        saved = view([cell(SB, 1, scale=26.5, lower=31, upper=192), cell(SA, 4)], active=1)
        page = self.open(saved=saved, setup="() => { (" + LATE_DRAWING + ")(); window.synDrawAfter = 24000; }")
        expect(page.locator('[data-auto-view-badge]')).to_contain_text('1 of 2 cells; 1 not restored')
        ids = page.evaluate('[...synViewports.keys()]')
        self.assertIsNone(page.evaluate('[...synViewports.values()][0].drawn'))
        for n, zoom in enumerate((3, 4), 1):
            page.evaluate("([id,z]) => synViewports.get(id).setZoom(z)", [ids[1], zoom])
            page.wait_for_function('synServer.posts.length === ' + str(n), timeout=4500)
            left, right = self.posts(page)[-1]['cells']
            self.assertEqual(saved['cells'][0], left)
            self.assertEqual((SA + '.4', zoom), (right['sop'], right['zoom']))
        page.wait_for_function("[...synViewports.values()][0].drawn === 'syn:set-B:1'", timeout=26000)
        page.wait_for_timeout(2500)
        self.close(page)
        self.assertEqual(2, len(self.posts(page)), 'a late default window and camera never replace the saved cell')
        page.evaluate("id => synViewports.get(id).setZoom(2.5)", ids[1])
        self.close(page)
        left, right = self.posts(page)[2]['cells']
        self.assertEqual(saved['cells'][0], left)
        self.assertEqual(2.5, right['zoom'])

    def with_display(self, page):
        page.route(ORIGIN + '/worklist/hpacs-lite/viewer-display-model.js', self.serve(HPACS / 'viewer-display-model.js'))
        page.add_script_tag(path=str(HPACS / 'viewer-features-display.js'))

    def test_reader_edits_during_read_survive_layout_replacement_and_reopen(self):
        setup = """() => { (%s)();
          const fetch = window.fetch;
          window.fetch = async (url, options) => {
            if (url.endsWith('/workspace-shortcuts')) await new Promise(resolve => { window.settingsReady = resolve; });
            return fetch(url, options);
          }; }""" % HOLD_READ
        page = self.open(saved=view([cell(SB, 2), cell(SA, 4)]), setup=setup, prepare=self.with_display)
        page.wait_for_function('!!window.settingsReady')
        page.evaluate("synViewports.get('left').setImageIdIndex(6); settingsReady()")
        page.wait_for_function(READING)
        page.evaluate("synServices.viewportGridService.setActiveViewportId('right')")
        page.get_by_role('button', name='Display ▾').click()
        page.get_by_role('menuitem', name='Zoom…').click()
        page.get_by_role('button', name='200%').click()
        page.evaluate('synServer.releaseRead()')
        page.wait_for_function('synServer.posts.length > 0', timeout=6000)
        saved = page.evaluate('synServer.saved')
        self.assertEqual([(SB + '.1', 2), (SA + '.7', 1)], [(c['sop'], c['zoom']) for c in saved['cells']])
        again = self.open(saved=saved)
        expect(again.locator('[data-auto-view-badge]')).to_contain_text('2 of 2 cells')
        self.assertEqual([['syn:set-B:1', 2], ['syn:set-A:7', 1]],
                         again.evaluate('[...synViewports.values()].map(v => [v.getCurrentImageId(), v.getZoom()])'))

    def test_shift_during_read_leaves_the_restored_view_unsaved(self):
        saved = view([cell(SA, 4), cell(SB, 3)])
        page = self.open(saved=saved, setup=HOLD_READ)
        page.wait_for_function(READING)
        page.keyboard.press('Shift')
        page.evaluate('synServer.releaseRead()')
        expect(page.locator('[data-auto-view-badge]')).to_contain_text('2 of 2 cells')
        self.close(page)
        self.assertEqual(['syn:set-A:4', 'syn:set-B:3'], [self.state(page, key)['image'] for key in ('left', 'right')])
        self.assertEqual([], self.posts(page))

    def test_resize_during_read_and_after_placement_preserves_the_saved_view(self):
        saved = view([cell(SA, 4, scale=26.5, lower=31, upper=192), cell(SB, 2)])
        page = self.open(saved=saved, setup=HOLD_READ)
        page.wait_for_function(READING)
        page.evaluate("synViewports.get('left').resizeTo(99.875); synServer.releaseRead()")
        expect(page.locator('[data-auto-view-badge]')).to_contain_text('2 of 2 cells')
        left = self.state(page, 'left')
        self.assertEqual(('syn:set-A:4', 26.5, {'lower': 31, 'upper': 192}), (left['image'], left['scale'], left['voi']))
        page.evaluate("synViewports.get('left').resizeTo(95)")
        self.quiet(page, 0, 2500)
        self.close(page)
        self.assertEqual([READ], self.requests(page))

    def test_reader_changes_to_relative_zoom_pan_and_window_are_each_saved_after_resize(self):
        page = self.open(saved=view([cell(SA, 4, scale=50), cell(SB, 2)]))
        expect(page.locator('[data-auto-view-badge]')).to_contain_text('2 of 2 cells')
        page.evaluate("synViewports.get('left').resizeTo(95)")
        self.close(page)
        self.assertEqual([], self.posts(page))
        page.evaluate("synViewports.get('left').setZoom(2.004)")
        self.close(page)
        page.evaluate("synViewports.get('left').setPan([13.5, -3.25])")
        self.close(page)
        page.evaluate("synViewports.get('left').setProperties({voiRange: {lower: -1059, upper: 439}})")
        self.close(page)
        zoom, pan, window = [snapshot['cells'][0] for snapshot in self.posts(page)]
        self.assertAlmostEqual(2.004, zoom['zoom'])
        self.assertEqual([13.5, -3.25, 20], pan['camera']['focalPoint'])
        self.assertEqual({'lower': -1059, 'upper': 439}, window['properties']['voiRange'])

    def test_window_change_during_read_survives_reopen(self):
        page = self.open(saved=view([cell(SA, 4), cell(SB, 2)]), setup=HOLD_READ)
        page.wait_for_function(READING)
        page.evaluate("""() => { synViewports.get('left').setProperties({voiRange: {lower: -500, upper: 500}});
          synServer.releaseRead(); }""")
        page.wait_for_function('synServer.saved.cells[0].sop === synMeta["syn:set-A:1"].SOPInstanceUID', timeout=6500)
        saved = self.posts(page)[-1]
        self.assertEqual({'lower': -500, 'upper': 500}, saved['cells'][0]['properties']['voiRange'])
        self.assertEqual(SB + '.2', saved['cells'][1]['sop'])
        again = self.open(saved=saved)
        expect(again.locator('[data-auto-view-badge]')).to_contain_text('2 of 2 cells')
        self.assertEqual(saved['cells'][0]['properties']['voiRange'], self.state(again, 'left')['voi'])

    def test_reloaded_source_with_pixels_ready_waits_for_its_own_first_render(self):
        page = self.open(saved=view([cell(SA, 1), cell(SB, 2)]), setup=HOLD_READ)
        page.wait_for_function(READING)
        # Reloading the same image can leave its id and pixels available before the new stack has drawn it.
        page.evaluate("""() => { const v = synViewports.get('left');
          v.viewportStatus = 'preRender';
          synFire('left', 'PRE_STACK_NEW_IMAGE'); synFire('left', 'STACK_NEW_IMAGE'); synServer.releaseRead(); }""")
        expect(page.locator('#pane-right [data-auto-view-badge]')).to_contain_text('1 of 2 cells; 1 not restored')
        self.assertEqual(100, self.state(page, 'left')['scale'])
        self.assertEqual({'lower': -160, 'upper': 239}, self.state(page, 'left')['voi'])
        page.evaluate("synViewports.get('left').render()")
        expect(page.locator('[data-auto-view-badge]')).to_contain_text('2 of 2 cells')
        self.assertEqual(40, self.state(page, 'left')['scale'])
        self.close(page)
        self.assertEqual([], self.posts(page))

    def test_first_save_contains_the_settled_window_of_the_untouched_pane(self):
        page = self.unstarted()
        page.evaluate("""() => { const v = synViewports.get('right'), image = v.getCornerstoneImage;
          v.getCornerstoneImage = () => undefined;
          v.setVOI({lower: 0, upper: 255});
          v.getCornerstoneImage = image; v.render(); }""")
        page.evaluate('synServer.releaseRead()')
        self.quiet(page, 0, 2500)
        page.evaluate("synViewports.get('right').resizeTo(95)")
        self.close(page)
        self.assertEqual([], self.posts(page))
        page.evaluate("synViewports.get('left').setZoom(2)")
        page.wait_for_function('synServer.posts.length === 1', timeout=5500)
        right = self.posts(page)[0]['cells'][1]
        self.assertEqual((SB + '.1', {'lower': 0, 'upper': 255}), (right['sop'], right['properties']['voiRange']))
        self.assertEqual((1, 95), (right['zoom'], right['camera']['parallelScale']))

    def test_first_save_waits_for_the_other_pane_to_draw_and_reopens_both_series(self):
        page = self.unstarted()
        page.evaluate('synLoading(); synServer.releaseRead()')
        page.wait_for_timeout(300)
        page.evaluate("synViewports.get('left').setZoom(2)")
        self.quiet(page, 0, 2500)
        page.evaluate('synLoaded()')
        page.wait_for_function('synServer.posts.length === 1', timeout=5500)
        saved = self.posts(page)[0]
        self.assertEqual([(SA + '.1', 2), (SB + '.1', 1)], [(c['sop'], c['zoom']) for c in saved['cells']])
        again = self.open(saved=saved)
        expect(again.locator('[data-auto-view-badge]')).to_contain_text('2 of 2 cells')
        self.assertEqual(['set-A', 'set-B'], again.evaluate('[...synShown.values()].map(pane => pane.set)'))

    def test_reader_replacement_still_loading_when_read_finishes_saves_its_own_image(self):
        page = self.open(saved=view([cell(SA, 4), cell(SB, 2)]), setup=HOLD_READ)
        page.wait_for_function(READING)
        page.evaluate("""() => { synBuild(1, 2, [['left', 'set-A'], ['picked', 'set-A']]);
          synLoading(); synServer.releaseRead(); }""")
        self.quiet(page, 0, 2500)
        page.evaluate('synLoaded()')
        page.wait_for_function('synServer.posts.length === 1', timeout=5500)
        self.assertEqual([SA + '.4', SA + '.1'], [c['sop'] for c in self.posts(page)[0]['cells']])

    def test_reader_zoom_while_sorting_survives_the_late_stack_and_reopen(self):
        saved = view([cell(SA, 3, display=SORT_DOWN), cell(SB, 2)])
        page = self.open(saved=saved, setup=HOLD_READ)
        page.wait_for_function(READING)
        page.evaluate("""() => { const v = synViewports.get('left'), set = v.setStack;
          v.setStack = (ids, index) => new Promise(resolve => { window.sorted = () => resolve(set(ids, index)); });
          synServer.releaseRead(); }""")
        page.wait_for_function('!!window.sorted')
        page.evaluate("synViewports.get('left').setZoom(2); sorted()")
        page.wait_for_function('synServer.posts.length > 0', timeout=5500)
        snapshot = page.evaluate('synServer.saved')
        left = snapshot['cells'][0]
        self.assertEqual((SA + '.1', 2), (left['sop'], left['zoom']))
        again = self.open(saved=snapshot)
        expect(again.locator('[data-auto-view-badge]')).to_contain_text('2 of 2 cells')
        self.assertEqual(('syn:set-A:1', 50), (self.state(again, 'left')['image'], self.state(again, 'left')['scale']))

    def test_failed_read_retries_without_overwriting_an_untouched_pane(self):
        saved = view([cell(SA, 4), cell(SB, 2)])
        setup = """() => { const fetch = window.fetch;
          let first = true;
          window.fetch = (url, options) => {
            if (first && url.endsWith('/viewer-auto-view')) { first = false;
              synRequests.push('failed read'); return Promise.resolve(new Response('{}', {status: 503})); }
            return fetch(url, options);
          }; }"""
        page = self.open(saved=saved, setup=setup)
        page.wait_for_function("synRequests.includes('failed read')")
        self.assertEqual([], self.posts(page))
        page.evaluate("synViewports.get('left').setZoom(2)")
        page.wait_for_function('synServer.posts.length > 0', timeout=5500)
        self.assertEqual(saved['cells'][1], self.posts(page)[0]['cells'][1])
        self.assertEqual('syn:set-B:2', self.state(page, 'right')['image'])
        self.assertEqual(2, self.posts(page)[0]['cells'][0]['zoom'])

    def test_unreadable_placement_has_no_badge_and_preserves_the_saved_cell(self):
        saved = view([cell(SA, 4), cell(SB, 2)])
        page = self.open(saved=saved, setup=HOLD_READ)
        page.wait_for_function(READING)
        page.evaluate("""() => { const v = synViewports.get('left'), get = v.getProperties;
          v.getProperties = () => { if (v.index === 3) throw Error('image properties unavailable'); return get(); };
          synServer.releaseRead(); }""")
        expect(page.locator('#pane-right [data-auto-view-badge]')).to_contain_text('1 of 2 cells; 1 not restored')
        page.evaluate("synViewports.get('right').setZoom(4)")
        self.close(page)
        self.assertEqual(saved['cells'][0], self.posts(page)[0]['cells'][0])
        self.assertEqual(4, self.posts(page)[0]['cells'][1]['zoom'])

    def test_badge_uses_readback_from_the_drawn_frame_and_omits_an_unapplied_window(self):
        saved = view([cell(SA, 4), cell(SB, 2, scale=40, lower=-300, upper=899)], active=1)
        setup = """() => { (%s)(); const build = synBuild; window.synBuild = (...args) => {
          build(...args);
          synViewports.get('left').setProperties = () => {};
        }; }""" % HOLD_READ
        page = self.open(saved=saved, setup=setup)
        page.wait_for_function(READING)
        page.evaluate("synViewports.get('right').resizeTo(80); synServer.releaseRead()")
        expect(page.locator('#pane-right [data-auto-view-badge]')).to_have_text(
            'Restored saved view: Zoom 200%, W 1200 / L 300, Image 2 (1 of 2 cells; 1 not restored)')
        self.assertEqual('syn:set-B:2', self.state(page, 'right')['image'])
        self.close(page)
        self.assertEqual([], self.posts(page))

    def test_available_series_restores_across_a_missing_layout_slot(self):
        absent = cell(STUDY + '.9', 2)
        saved = view([absent, cell(SB, 3)], active=1)
        page = self.open(saved=saved, cells=(('only', 'set-B'),))
        expect(page.locator('[data-auto-view-badge]')).to_contain_text('Image 3 (1 of 2 cells; 1 not restored)')
        page.evaluate("synViewports.get('only').setZoom(4)")
        self.close(page)
        self.assertEqual([absent, {**saved['cells'][1], 'zoom': 4,
                                  'camera': {**saved['cells'][1]['camera'], 'parallelScale': 25}}],
                         self.posts(page)[0]['cells'])

    def test_a_replaced_pane_during_read_keeps_its_view_while_the_other_restores(self):
        page = self.open(saved=view([cell(SA, 4), cell(SB, 2)]), setup=HOLD_READ)
        page.wait_for_function(READING)
        page.evaluate("""() => { synBuild(1, 2, [['replacement', 'set-A'], ['right', 'set-B']]);
          synViewports.get('replacement').setImageIdIndex(6); synServer.releaseRead(); }""")
        expect(page.locator('#pane-right [data-auto-view-badge]')).to_contain_text('1 of 2 cells; 1 not restored')
        self.close(page)
        self.assertEqual([SA + '.7', SB + '.2'], [c['sop'] for c in self.posts(page)[0]['cells']])

    def test_unanswered_stack_preserves_one_saved_rule_while_the_other_restores_and_saves(self):
        saved = view([cell(SA, 3, display=SORT_DOWN), cell(SB, 2, display=SORT_DOWN, index=2)])
        page = self.open(saved=saved, setup=HOLD_READ)
        page.wait_for_function(READING)
        page.evaluate("""() => { synViewports.get('left').setStack = () => {
          window.sortingLeft = true; return new Promise(() => {}); }; synServer.releaseRead(); }""")
        page.wait_for_function('window.sortingLeft')
        expect(page.locator('#pane-right [data-auto-view-badge]')).to_contain_text('1 of 2 cells; 1 not restored')
        self.assertEqual(0, page.locator('#pane-left [data-auto-view-badge]').count())
        self.assertEqual('syn:set-B:2', self.state(page, 'right')['image'])
        self.assertEqual([], self.posts(page))
        for count, zoom in enumerate((4, 2.5), 1):
            page.evaluate("zoom => synViewports.get('right').setZoom(zoom)", zoom)
            self.close(page)
            self.assertEqual(count, len(self.posts(page)))
            left, right = self.posts(page)[-1]['cells']
            self.assertEqual(saved['cells'][0], left)
            self.assertEqual((SB + '.2', zoom, SORT_DOWN), (right['sop'], right['zoom'], right['display']))

    def test_late_monochrome_display_preserves_the_saved_cell_until_its_frame_is_settled(self):
        saved = view([cell(SA, 1), cell(SB, 3)], active=1)
        page = self.open(saved=saved, setup=HOLD_READ, prepare=self.with_display)
        page.wait_for_function(READING)
        page.evaluate("""() => { const v = synViewports.get('left');
          synMeta[v.getCurrentImageId()].PhotometricInterpretation = 'MONOCHROME1';
          synFire('left', 'PRE_STACK_NEW_IMAGE'); v.setVOI({lower: 0, upper: 255}); synServer.releaseRead(); }""")
        expect(page.locator('#pane-right [data-auto-view-badge]')).to_contain_text('1 of 2 cells; 1 not restored')
        self.assertEqual({'lower': 0, 'upper': 255}, self.state(page, 'left')['voi'])
        page.evaluate("synViewports.get('right').setZoom(4)")
        self.close(page)
        self.assertEqual(saved['cells'][0], self.posts(page)[0]['cells'][0])
        self.assertEqual(4, self.posts(page)[0]['cells'][1]['zoom'])
        page.evaluate("""() => { const v = synViewports.get('left'); v.setProperties({ invert: true });
          synFire('left', 'STACK_NEW_IMAGE'); }""")
        expect(page.locator('[data-auto-view-badge]')).to_contain_text('2 of 2 cells')
        self.assertEqual((False, saved['cells'][0]['properties']['voiRange']),
                         (self.state(page, 'left')['invert'], self.state(page, 'left')['voi']))
        page.wait_for_timeout(2300)
        self.close(page)
        self.assertEqual(1, len(self.posts(page)), 'display processing is not a second reader edit')

    def test_v1_missing_frame_never_applies_its_window_to_the_visible_image(self):
        missing = cell(SA, 1, scale=12, lower=10, upper=90)
        missing['frame'] = 2
        saved = view([missing, cell(SB, 3, index=0)], active=1)
        page = self.open(saved=saved)
        expect(page.locator('[data-auto-view-badge]')).to_contain_text('1 of 2 cells; 1 not restored')
        self.assertEqual(('syn:set-B:3', 40), (self.state(page, 'right')['image'], self.state(page, 'right')['scale']))
        self.assertEqual({'lower': -160, 'upper': 239}, self.state(page, 'left')['voi'])
        page.evaluate("synViewports.get('right').setZoom(3)")
        self.close(page)
        self.assertEqual(missing, self.posts(page)[0]['cells'][0])

    def test_open_saved_finding_during_auto_view_read_keeps_the_cited_position(self):
        page = self.combined(query='', setup=HOLD_READ)
        page.evaluate('synMountJobs(); synMountFindings()')
        page.wait_for_function(READING)
        page.locator('#kin-viewer-findings').get_by_role('button', name='Open Saved View').click()
        page.wait_for_function("document.querySelector('[data-kin-location-result]')?.dataset.kinLocationResult === 'ok'")
        self.assertEqual(JOB_IMAGE, page.evaluate('synFirst().image'))
        page.evaluate('synServer.releaseRead()')
        page.wait_for_timeout(2500)
        self.assertEqual(JOB_IMAGE, page.evaluate('synFirst().image'))
        self.assertEqual(0, page.locator('[data-auto-view-badge]').count())

    def test_account_change_during_read_does_not_apply_or_send_the_previous_readers_view(self):
        other = [OWNER[0], 'second-reader']
        page = self.open(saved=view([cell(SA, 4), cell(SB, 2)]), setup=HOLD_READ)
        page.wait_for_function(READING)
        page.evaluate("owner => { synSession.owner = () => owner; synServer.releaseRead(); }", other)
        page.wait_for_timeout(1000)
        self.assertEqual('syn:set-A:1', self.state(page, 'left')['image'])
        self.assertEqual(0, page.locator('[data-auto-view-badge]').count())
        self.change(page)
        self.close(page)
        self.assertEqual([], self.posts(page))
        again = self.open(owner=other, saved=view([cell(SA, 8), cell(SB, 1)]))
        expect(again.locator('[data-auto-view-badge]')).to_contain_text('Image 8')
        again.evaluate("synViewports.get('left').setZoom(4)")
        self.close(again)
        self.assertEqual((SA + '.8', 4), (self.posts(again)[0]['cells'][0]['sop'], self.posts(again)[0]['cells'][0]['zoom']))

    def test_06_a_job_chosen_to_open_wins(self):
        page = self.open(saved=view([cell(SA, 4), cell(SB, 2)]), query='&kinJob=00000000-0000-4000-8000-000000000001')
        self.started(page); page.wait_for_timeout(1000)
        self.assertEqual(['GET /api/studies/%s/viewer-auto-view' % STUDY], self.requests(page), 'the Discard generation is read without restoring the saved view')
        self.assertEqual('syn:set-A:1', self.state(page, 'left')['image'])
        self.assertEqual(0, page.locator('[data-auto-view-badge]').count())

    def test_07_no_save_until_a_hanging_protocols_cell_rules_stand(self):
        page = self.open()
        self.started(page)
        # The protocol's rule sorts the left cell; its new order takes six seconds to come.
        page.evaluate("""() => { const v = synViewports.get('left'), set = v.setStack;
          v.setStack = (ids, index) => new Promise(resolve => setTimeout(() => resolve(set(ids, index)), 6000)); }""")
        page.evaluate("dispatchEvent(new CustomEvent('kin-hanging-protocol-applied', { detail: { viewportIds: ['left', 'right'], display: [%s, null] } }))" % json.dumps(SORT_DOWN))
        self.change(page, cell='right', image=2)
        page.wait_for_timeout(2500)
        # Neither a quiet moment, nor a patient switch, nor the window closing saves the half-laid view.
        page.evaluate("dispatchEvent(new Event('pagehide'))")
        page.evaluate("document.body.classList.add('kin-patient-switching')")
        page.wait_for_timeout(300)
        page.evaluate("document.body.classList.remove('kin-patient-switching')")
        page.wait_for_timeout(2700)
        self.assertEqual([], self.posts(page), "the cells' rules are still being put on")
        page.wait_for_function('synServer.posts.length === 1', timeout=6000)
        left = self.posts(page)[0]['cells'][0]
        self.assertEqual((SORT_DOWN, SA + '.8'), (left['display'], left['sop']), 'saved with the rule standing')

    def test_07b_an_image_a_series_export_shows_on_its_way_is_not_saved_as_the_readers(self):
        page = self.open()
        self.started(page)
        move = """image => { const v = synViewports.get('left'); v.setImageIdIndex(image);
          return new Promise(resolve => v.element.addEventListener('syn-rendered', resolve, { once: true })); }"""
        first = page.evaluate("synViewports.get('left').getCurrentImageIdIndex()")
        # Save Series JPEG or Save Video is walking the left cell through its series (viewer-export.js moving()).
        page.evaluate("() => { window.synExporting = true; window.KinViewerExport = { moving: () => synExporting }; }")
        page.evaluate(move, 5)
        page.wait_for_timeout(2500)
        # Neither a quiet moment, nor a patient switch, nor the window closing saves the image on the export's way.
        page.evaluate("dispatchEvent(new Event('pagehide'))")
        page.evaluate("document.body.classList.add('kin-patient-switching')")
        page.wait_for_timeout(300)
        page.evaluate("document.body.classList.remove('kin-patient-switching')")
        self.assertEqual([], self.posts(page))
        # The export goes back to the reader's image and is over: the view is the one the reader had, so nothing is saved.
        page.evaluate(move, first)
        page.evaluate("() => { synExporting = false; }")
        page.wait_for_timeout(2700)
        self.assertEqual([], self.posts(page))
        # The reader takes the cell in the middle of another export: from then on its image is the reader's, and is saved.
        page.evaluate("() => { synExporting = true; }")
        page.evaluate(move, 3)
        page.wait_for_timeout(2500)
        self.assertEqual([], self.posts(page))
        page.evaluate("() => { synExporting = false; }")
        page.wait_for_function('synServer.posts.length === 1', timeout=5000)
        self.assertEqual(SA + '.4', self.posts(page)[0]['cells'][0]['sop'])

    def test_08_discard_wins_over_a_save_on_its_way(self):
        page = self.open(saved=view([cell(SA, 3), cell(SB, 2)]))
        page.wait_for_function("document.querySelector('[data-auto-view-badge]')", timeout=8000)
        page.wait_for_timeout(300)
        page.evaluate("() => { synServer.hold = new Promise(resolve => { synServer.release = resolve; }); }")
        self.change(page)
        page.wait_for_function("synServer.log.length === 1", timeout=5000)
        # A save is on its way (its answer held back) when Discard Saved View is pressed.
        panel = self.window(page)
        panel.get_by_role('button', name='Discard Saved View').click()
        page.wait_for_timeout(300)
        self.assertEqual(['save'], page.evaluate('synServer.log'), 'Discard waits for the save on its way')
        page.evaluate("synServer.release()")
        page.wait_for_function("synServer.log.length === 3", timeout=3000)
        self.assertEqual(['save', 'saved', 'discard'], page.evaluate('synServer.log'))
        self.assertIsNone(page.evaluate('synServer.saved'))
        expect(panel.get_by_role('status')).to_have_text('The saved view of this study was discarded.')
        expect(panel.locator('[data-auto-view-saved]')).to_have_text('No view of this study is saved.')
        # The view that was on its way is not written again; the next change is.
        page.wait_for_timeout(2500)
        self.assertEqual(1, len(self.posts(page)))
        self.change(page, zoom=4, image=1)
        page.wait_for_function('synServer.posts.length === 2', timeout=5000)

    def test_09_a_patient_switch_saves_at_once(self):
        page = self.open()
        self.started(page)
        self.change(page)
        page.evaluate("document.body.classList.add('kin-patient-switching')")
        page.wait_for_function('synServer.posts.length === 1', timeout=1000)
        self.assertEqual(SA + '.6', self.posts(page)[0]['cells'][0]['sop'])

    def test_10_the_switch_save_outlives_the_viewer_it_leaves(self):
        page = self.open()
        self.started(page)
        page.evaluate("() => { synServer.hold = new Promise(resolve => { synServer.release = resolve; }); }")
        self.change(page)
        page.evaluate("document.body.classList.add('kin-patient-switching')")
        page.wait_for_function("synServer.log.length === 1", timeout=1000)
        # The switch takes the viewer down while the save is on its way.
        page.evaluate("synToolbar.dispose()")
        page.evaluate("synServer.release()")
        page.wait_for_function("synServer.log.length === 2", timeout=3000)
        self.assertEqual(['save', 'saved'], page.evaluate('synServer.log'))
        self.assertEqual(SA + '.6', page.evaluate('synServer.saved.cells[0].sop'))

    def test_11_the_closing_save_is_kept_over_an_older_one_still_on_its_way(self):
        page = self.open()
        self.started(page)
        page.evaluate("() => { synServer.hold = new Promise(resolve => { synServer.release = resolve; }); }")
        self.change(page, zoom=2)
        page.wait_for_function("synServer.log.length === 1", timeout=5000)
        # Zoom 3 and the window closes while the zoom 2 save is still on its way: the closing save arrives first.
        page.evaluate("synViewports.get('left').setZoom(3)")
        page.evaluate("dispatchEvent(new Event('pagehide'))")
        page.wait_for_function("synServer.log.length === 3", timeout=3000)
        page.evaluate("synServer.release()")
        page.wait_for_function("synServer.log.length === 4", timeout=3000)
        self.assertEqual(['save', 'save', 'saved', 'stale'], page.evaluate('synServer.log'), 'the older save arriving last writes nothing')
        bodies = page.evaluate('synServer.bodies')
        self.assertEqual([1, 2], [b['seq'] for b in bodies]); self.assertEqual(1, len({b['writer'] for b in bodies}))
        self.assertEqual([False, True], [b['keepalive'] for b in bodies])
        self.assertAlmostEqual(3, page.evaluate('synServer.saved.cells[0].zoom'))

    def test_12_discard_is_not_undone_by_the_window_closing(self):
        page = self.open(saved=view([cell(SA, 3), cell(SB, 2)]))
        page.wait_for_function("document.querySelector('[data-auto-view-badge]')", timeout=8000)
        page.wait_for_timeout(300)
        page.evaluate("() => { synServer.hold = new Promise(resolve => { synServer.release = resolve; }); }")
        self.change(page)
        page.wait_for_function("synServer.log.length === 1", timeout=5000)
        panel = self.window(page)
        panel.get_by_role('button', name='Discard Saved View').click()
        # The window closes while Discard waits for the save on its way, and again once it is done.
        page.evaluate("dispatchEvent(new Event('pagehide'))")
        page.evaluate("synServer.release()")
        expect(panel.get_by_role('status')).to_have_text('The saved view of this study was discarded.')
        page.evaluate("dispatchEvent(new Event('pagehide'))")
        page.wait_for_timeout(500)
        self.assertEqual(['save', 'saved', 'discard'], page.evaluate('synServer.log'))
        self.assertIsNone(page.evaluate('synServer.saved'))

    def test_13_a_display_set_rule_that_starts_late_still_goes_back_first(self):
        # The Display Set Presets module waits for one of its scripts: it starts after the saved view has been read.
        page = self.open(saved=view([cell(SA, 4), cell(SB, 2, display=SORT_DOWN, index=2)]), late=('viewer-gsps.js',))
        page.wait_for_function("synRequests.some(r => r.startsWith('GET ') && r.endsWith('/viewer-auto-view'))", timeout=8000)
        page.wait_for_timeout(2000)
        expect(page.locator('[data-auto-view-badge]')).to_contain_text('1 of 2 cells; 1 not restored')
        for go in self.pending:
            go()
        expect(page.locator('[data-auto-view-badge]')).to_contain_text('2 of 2 cells')
        right = self.state(page, 'right')
        self.assertEqual(['syn:set-B:4', 'syn:set-B:3', 'syn:set-B:2', 'syn:set-B:1'], right['ids'])
        self.assertEqual(('syn:set-B:2', 2), (right['image'], right['index']))
        expect(page.locator('[data-auto-view-badge]')).to_have_text('Restored saved view: Zoom 250%, W 1500 / L -310, Image 4 (2 of 2 cells)')

    def test_14_turned_off_while_the_saved_view_is_read_puts_nothing_back_and_sends_nothing(self):
        page = self.open(saved=view([cell(SA, 4), cell(SB, 2)]),
                         setup="() => { synServer.holdRead = new Promise(resolve => { synServer.releaseRead = resolve; }); }")
        page.wait_for_function("synRequests.some(r => r.startsWith('GET ') && r.endsWith('/viewer-auto-view'))", timeout=8000)
        panel = self.window(page)
        panel.get_by_label(CHECK).uncheck()
        expect(panel.get_by_role('status')).to_contain_text('Off:')
        page.evaluate("synServer.releaseRead()")
        page.wait_for_timeout(2500)
        self.assertEqual(0, page.locator('[data-auto-view-badge]').count())
        self.assertEqual(('syn:set-A:1', 100), (self.state(page, 'left')['image'], self.state(page, 'left')['scale']))
        self.assertEqual([], page.evaluate('synLayouts'))
        # A save waiting in the queue does not go once the check is off.
        panel.get_by_label(CHECK).check()
        expect(panel.get_by_role('status')).to_contain_text('On:')
        page.evaluate("() => { synServer.hold = new Promise(resolve => { synServer.release = resolve; }); }")
        self.change(page, zoom=2)
        page.wait_for_function("synServer.log.length === 1", timeout=5000)
        self.change(page, zoom=3, image=2)
        page.wait_for_timeout(2500)  # the second save waits behind the first
        panel.get_by_label(CHECK).uncheck()
        expect(panel.get_by_role('status')).to_contain_text('Off:')
        page.evaluate("synServer.release()")
        page.wait_for_timeout(1000)
        self.assertEqual(['save', 'saved'], page.evaluate('synServer.log'))

    def test_15_a_cell_saved_empty_is_emptied_and_the_badge_names_the_image_where_it_is_now(self):
        # Saved: series A's image 3 (at place 2 then; an image has come before it since) and an empty cell.
        page = self.open(saved=view([cell(SA, 3, index=1), None]))
        page.wait_for_function("document.querySelector('[data-auto-view-badge]')", timeout=8000)
        self.assertEqual([[1, 2]], page.evaluate('synLayouts'), 'the layout is laid again to empty the cell')
        ids = page.evaluate('[...synViewports.keys()]')
        self.assertIsNone(page.evaluate("id => synShown.get(id).set", ids[1]))
        self.assertEqual('syn:set-A:3', self.state(page, ids[0])['image'])
        expect(page.locator('[data-auto-view-badge]')).to_have_text('Restored saved view: Zoom 250%, W 1500 / L -310, Image 3')

    def test_16_discard_waits_for_a_closing_save_still_on_its_way(self):
        page = self.open(saved=view([cell(SA, 3), cell(SB, 2)]))
        page.wait_for_function("document.querySelector('[data-auto-view-badge]')", timeout=8000)
        page.wait_for_timeout(300)
        # The page is hidden (a closing save goes, its answer held back) and shown again; then Discard.
        page.evaluate("() => { synServer.hold = new Promise(resolve => { synServer.release = resolve; }); }")
        self.change(page)
        page.evaluate("dispatchEvent(new Event('pagehide'))")
        page.wait_for_function("synServer.log.length === 1", timeout=3000)
        self.assertTrue(page.evaluate('synServer.bodies[0].keepalive'))
        panel = self.window(page)
        panel.get_by_role('button', name='Discard Saved View').click()
        page.wait_for_timeout(500)
        self.assertEqual(['save'], page.evaluate('synServer.log'), 'Discard waits for the closing save too')
        page.evaluate("synServer.release()")
        expect(panel.get_by_role('status')).to_have_text('The saved view of this study was discarded.')
        self.assertEqual(['save', 'saved', 'discard'], page.evaluate('synServer.log'))
        self.assertIsNone(page.evaluate('synServer.saved'))

    def test_17_back_to_the_saved_view_while_a_save_is_on_its_way_then_closed(self):
        page = self.open(saved=view([cell(SA, 3), cell(SB, 2)]))
        page.wait_for_function("document.querySelector('[data-auto-view-badge]')", timeout=8000)
        page.wait_for_timeout(300)
        page.evaluate("() => { synServer.hold = new Promise(resolve => { synServer.release = resolve; }); }")
        page.evaluate("synViewports.get('left').setZoom(2)")
        page.wait_for_function("synServer.log.length === 1", timeout=5000)
        # Back to zoom 2.5 (the saved view) while the zoom 2 save is on its way, and the window closes.
        page.evaluate("synViewports.get('left').setZoom(2.5)")
        page.evaluate("dispatchEvent(new Event('pagehide'))")
        page.wait_for_function("synServer.log.length === 3", timeout=3000)
        page.evaluate("synServer.release()")
        page.wait_for_function("synServer.log.length === 4", timeout=3000)
        self.assertEqual(['save', 'save', 'saved', 'stale'], page.evaluate('synServer.log'))
        self.assertAlmostEqual(2.5, page.evaluate('synServer.saved.cells[0].zoom'))

    def test_18_a_rule_pass_that_never_ends_holds_saving_until_another_pass_takes_its_place(self):
        page = self.open()
        self.started(page)
        page.evaluate("() => { synViewports.get('left').setStack = () => new Promise(() => {}); }")
        page.evaluate("dispatchEvent(new CustomEvent('kin-hanging-protocol-applied', { detail: { viewportIds: ['left', 'right'], display: [%s, null] } }))" % json.dumps(SORT_DOWN))
        self.change(page, cell='right', image=2)
        # No time limit: half a minute on, the half-laid view is still not saved.
        page.wait_for_timeout(33000)
        self.assertEqual([], self.posts(page))
        # Another pass of rules (Apply on a cell) takes its place: saving goes on from the view that then stands still.
        page.evaluate("KinViewerCellRules.apply('right', %s)" % json.dumps(SORT_DOWN))
        page.wait_for_function('synServer.posts.length === 1', timeout=6000)
        self.assertEqual(SORT_DOWN, self.posts(page)[0]['cells'][1]['display'])

    def test_21_replacement_rules_finish_before_normal_close_or_switch_saving_resumes(self):
        for mode in ('normal', 'close', 'switch'):
            with self.subTest(mode=mode):
                page = self.open()
                self.started(page)
                page.evaluate("""() => {
                  synViewports.get('left').setStack = () => new Promise(() => {});
                  const v = synViewports.get('right'), set = v.setStack;
                  v.setStack = (ids, index) => new Promise(resolve => {
                    window.finishReplacement = () => resolve(set(ids, index));
                  });
                }""")
                page.evaluate("dispatchEvent(new CustomEvent('kin-hanging-protocol-applied', { detail: { viewportIds: ['left'], display: [%s] } }))" % json.dumps(SORT_DOWN))
                self.change(page, cell='right', image=2)
                page.evaluate("void KinViewerCellRules.apply('right', %s)" % json.dumps(SORT_DOWN))
                page.wait_for_function('!!window.finishReplacement')
                page.wait_for_timeout(3400)
                if mode == 'close':
                    page.evaluate("dispatchEvent(new Event('pagehide'))")
                elif mode == 'switch':
                    page.evaluate("document.body.classList.add('kin-patient-switching')")
                page.wait_for_timeout(100)
                self.assertEqual([], self.posts(page), 'replacement sorting has not finished')
                page.evaluate("document.body.classList.remove('kin-patient-switching'); finishReplacement()")
                page.wait_for_function("synViewports.get('right').getCurrentImageId() === 'syn:set-B:4'")
                # Closing during the quiet period must also leave the view unsent.
                page.evaluate("dispatchEvent(new Event('pagehide'))")
                page.wait_for_timeout(200)
                self.assertEqual([], self.posts(page), 'the completed rules still need a quiet interval')
                page.wait_for_function('synServer.posts.length === 1', timeout=6000)
                self.assertEqual(SORT_DOWN, self.posts(page)[0]['cells'][1]['display'])

    def test_19_turned_off_while_a_saved_rule_is_going_back_and_on_again_before_the_old_read_answers(self):
        # The right cell's saved rule sorts it; the sort takes two seconds, and the check is turned off meanwhile.
        page = self.open(saved=view([cell(SA, 4), cell(SB, 2, display=SORT_DOWN, index=2)]))
        page.evaluate("""() => { const v = synViewports.get('right'), set = v.setStack;
          v.setStack = (ids, index) => new Promise(resolve => setTimeout(() => resolve(set(ids, index)), 2000)); }""")
        page.wait_for_function("synRequests.some(r => r.startsWith('GET ') && r.endsWith('/viewer-auto-view'))", timeout=8000)
        page.wait_for_function("synViewports.get('left').index === 3", timeout=8000)
        panel = self.window(page)
        panel.get_by_label(CHECK).uncheck()
        expect(panel.get_by_role('status')).to_contain_text('Off:')
        page.wait_for_timeout(3000)
        self.assertIsNone(page.evaluate("KinViewerCellRules.rule('right')"), 'the rule is not put on once the check is off')
        self.assertEqual(0, page.locator('[data-auto-view-badge]').count())
        # Off while the saved view is read, the reader moves on, on again: the old answer puts nothing back.
        page2 = self.open(saved=view([cell(SA, 4), cell(SB, 2)]),
                          setup="() => { synServer.holdRead = new Promise(resolve => { synServer.releaseRead = resolve; }); }")
        page2.wait_for_function("synRequests.some(r => r.startsWith('GET ') && r.endsWith('/viewer-auto-view'))", timeout=8000)
        panel2 = self.window(page2)
        panel2.get_by_label(CHECK).uncheck()
        expect(panel2.get_by_role('status')).to_contain_text('Off:')
        page2.evaluate("synViewports.get('left').setImageIdIndex(6)")
        panel2.get_by_label(CHECK).check()
        expect(panel2.get_by_role('status')).to_contain_text('On:')
        page2.evaluate("synServer.releaseRead()")
        page2.wait_for_timeout(2500)
        self.assertEqual('syn:set-A:7', self.state(page2, 'left')['image'])
        self.assertEqual(0, page2.locator('[data-auto-view-badge]').count())

    def test_22_old_queued_captures_keep_their_generation_and_a_new_change_saves(self):
        page = self.open()
        self.started(page)
        page.evaluate("() => { synServer.hold = new Promise(resolve => { synServer.release = resolve; }); }")
        self.change(page, zoom=2)
        page.wait_for_function("synServer.log.length === 1", timeout=5000)
        self.change(page, zoom=3)
        page.wait_for_timeout(2300)  # another capture waits behind the first
        page.evaluate("""async () => {
          await fetch('/api/studies/%s/viewer-auto-view/discard', { method: 'POST',
            body: JSON.stringify({writer: crypto.randomUUID(), seq: 1, at: Date.now() + 60000}) });
          synServer.release();
        }""" % STUDY)
        page.wait_for_function("synServer.log.filter(x => x === 'stale').length === 2", timeout=3000)
        self.assertIsNone(page.evaluate('synServer.saved'))
        self.assertEqual(['0', '0'], page.evaluate('synServer.bodies.map(b => b.generation)'))
        self.change(page, zoom=4)
        page.wait_for_function('synServer.saved !== null', timeout=5000)
        self.assertEqual('1', page.evaluate('synServer.bodies.at(-1).generation'))
        self.assertAlmostEqual(4, page.evaluate('synServer.saved.cells[0].zoom'))

    def test_23_a_second_replacement_during_quiet_keeps_saving_held(self):
        page = self.open()
        self.started(page)
        page.evaluate("""() => {
          synViewports.get('left').setStack = () => new Promise(() => {});
          const v = synViewports.get('right'), set = v.setStack;
          v.setStack = (ids, index) => new Promise(resolve => {
            window.finishReplacement = () => resolve(set(ids, index));
          });
        }""")
        page.evaluate("dispatchEvent(new CustomEvent('kin-hanging-protocol-applied', { detail: { viewportIds: ['left'], display: [%s] } }))" % json.dumps(SORT_DOWN))
        page.evaluate("void KinViewerCellRules.apply('right', %s)" % json.dumps(SORT_DOWN))
        page.wait_for_function('!!window.finishReplacement')
        page.evaluate('finishReplacement()')
        page.wait_for_function("synViewports.get('right').getCurrentImageId() === 'syn:set-B:4'")
        page.wait_for_timeout(250)
        second = {**SORT_DOWN, 'sort': 'position-asc'}
        page.evaluate("window.finishReplacement = null; void KinViewerCellRules.apply('right', %s)" % json.dumps(second))
        page.wait_for_function('!!window.finishReplacement')
        page.wait_for_timeout(2800)
        page.evaluate("dispatchEvent(new Event('pagehide'))")
        page.wait_for_timeout(100)
        self.assertEqual([], self.posts(page))
        page.evaluate('finishReplacement()')
        page.wait_for_function('synServer.posts.length === 1', timeout=6000)
        self.assertEqual(second, self.posts(page)[0]['cells'][1]['display'])

    def test_24_a_job_opening_can_save_its_first_change_on_close(self):
        page = self.open(query='&kinJob=00000000-0000-4000-8000-000000000001')
        self.started(page)
        self.change(page, zoom=4)
        page.evaluate("dispatchEvent(new Event('pagehide'))")
        page.wait_for_function('synServer.posts.length === 1', timeout=1000)
        self.assertEqual('0', page.evaluate('synServer.bodies[0].generation'))
        self.assertTrue(page.evaluate('synServer.bodies[0].keepalive'))
        self.assertAlmostEqual(4, page.evaluate('synServer.saved.cells[0].zoom'))

    # ── A restore the address chose, with the shipped Jobs panel and Findings section on the page ──
    def combined(self, query=JOB, saved=True, on=True, job_studies=(STUDY,), findings_status=200, layout=True, setup=None, autosave=True):
        """A page with viewer-jobs.js, finding-link-model.js and viewer-findings.js loaded beside Auto Save View. Neither
        panel is mounted yet: a case mounts them when its story has them start (synMountJobs, synMountFindings)."""
        config = {'study': STUDY, 'owner': OWNER, 'row': JOB_ROW, 'job': job(job_studies), 'findings': [FOUND_ITEM], 'findingsStatus': findings_status, 'layout': layout,
                  'continuation': {'nonce': NONCE, 'record': {'finding': FINDING, 'revision': 4, 'source': 0, 'jobId': JOB_ID}} if 'kinFinding' in query else None}

        def prepare(page):
            page.evaluate(COMBINED, config)
            for name in ['viewer-jobs.js', 'work-context.js', 'session-transport.js', 'finding-link-model.js', 'viewer-findings.js']:
                page.add_script_tag(path=str(HPACS / name))
            page.evaluate('synConnect()')
        return self.open(on=on, saved=view([cell(SA, 4), cell(SB, 2)]) if saved else None, query=query, setup=setup, prepare=prepare, autosave=autosave)

    def held(self, steps=("{ gate: 'apply' }",), on=True):
        """The kinJob page with Auto Save View saving and the panel still reading its Job ('read'); `steps` are the applies."""
        page = self.combined(on=on)
        page.evaluate("synGate('read'); synRestore.steps.push(%s); synMountJobs()" % ', '.join(steps))
        self.started(page)
        page.wait_for_function('synJobs.reads === 1')
        return page

    def waiting(self, page, gate):
        page.evaluate("synOpen('read')")
        page.wait_for_function("synRestore.waiting === '%s'" % gate)

    def restored(self, page):
        page.wait_for_function("synJobsStatus() === %s" % json.dumps(RESTORED))

    def close(self, page):
        page.evaluate("dispatchEvent(new Event('pagehide'))")
        page.wait_for_timeout(300)

    def quiet(self, page, count, ms=3500):
        """Past the save delay nothing more was sent."""
        page.wait_for_timeout(ms)
        self.assertEqual(count, len(self.posts(page)))

    def sent(self, page):
        return [(round(post['cells'][0]['zoom'], 6), post['cells'][0]['sop']) for post in self.posts(page)]

    def mine(self, page, count, zoom=5):
        """The reader's own change of the first cell after a restore is saved."""
        self.change(page, cell=page.evaluate('synFirst().id'), zoom=zoom)
        page.wait_for_function('synServer.posts.length === %d' % count, timeout=6000)
        self.assertEqual((zoom, JOB_IMAGE), self.sent(page)[-1])

    def switch_on(self, page):
        """The check in the open Auto Save View window, set without a pointer: input is swallowed while a Job is applied."""
        page.evaluate("""() => { const input = document.querySelector('section.kin-ux-feature-panel[aria-label="Auto Save View"] input[type=checkbox]');
          input.checked = true; input.dispatchEvent(new Event('change')); }""")
        page.wait_for_function('synServer.viewerSettings?.features?.autoSaveView === true')

    def unsettled(self, on=True, before=None):
        """The kinJob page whose restore failed and whose rollback failed too, with the second cell's image still to
        come: the screen that restore left cannot be captured. `before`: what the reader does before the Job is read."""
        page = self.held(steps=("{ gate: 'apply', fail: true }", "{ gate: 'back', fail: true }"), on=on)
        if before:
            before(page)
        self.waiting(page, 'apply')
        page.evaluate("synOpen('apply')")
        page.wait_for_function("synRestore.waiting === 'back'")
        page.evaluate("synLoading(); synOpen('back')")
        page.wait_for_function("synJobsStatus().startsWith(%s)" % json.dumps(UNKNOWN))
        self.assertEqual([['begin', 0, 0], ['end', 0, 0]], page.evaluate('synTold'))
        return page

    def stir(self, page):
        """What the viewer says with nothing changed: the camera, the grid, the layout, the active cell."""
        page.evaluate("""() => { synFire(synFirst().id, 'CAMERA_MODIFIED');
          synEmit('grid', 'gridState', { viewports: [...synViewports.keys()].map(viewportId => ({ viewportId })) });
          synEmit('grid', 'layout', {}); synEmit('grid', 'active', { viewportId: synActive }); }""")

    def own(self, page, count, zoom=5):
        """The reader's change of the first cell (zoom and its third image) is saved as the `count`th save."""
        self.change(page, cell=page.evaluate('synFirst().id'), zoom=zoom, image=2)
        page.wait_for_function('synServer.posts.length === %d' % count, timeout=6000)
        self.assertEqual((zoom, SA + '.3'), self.sent(page)[-1])

    def test_late_jobs_and_refresh_continuation_preserve_user_view(self):
        # The Jobs panel starts well after Auto Save View is saving (a script that came late, an account confirmed late).
        page = self.combined()
        self.started(page)
        page.wait_for_timeout(1000)
        self.change(page, zoom=3, image=2)
        page.wait_for_timeout(300)
        self.assertEqual([], self.posts(page), 'the reader\'s change is still waiting to be saved')
        page.evaluate('synMountJobs()')
        self.restored(page)
        # It was sent as the restore began, before the Job covered it. The Job's own view is the starting point.
        self.assertEqual([(3, SA + '.3')], self.sent(page))
        self.assertEqual([['begin', 0, 0], ['end', 0, 0]], page.evaluate('synTold'))
        self.assertEqual(JOB_IMAGE, page.evaluate('synFirst().image'))
        self.quiet(page, 1)
        self.mine(page, 2)
        # A finding's saved location whose list could not be read at first: Reload Findings runs it much later.
        page = self.combined(query=FOUND, findings_status=503)
        page.evaluate('synMountJobs(); synMountFindings()')
        page.wait_for_function("document.querySelector('#kin-viewer-findings-status')?.textContent.includes(%s)" % json.dumps(LIST_FAILED))
        self.started(page)
        self.change(page, zoom=3, image=2)
        page.wait_for_function('synServer.posts.length === 1', timeout=6000)
        self.change(page, zoom=3.5, image=2)
        page.evaluate('synFindingServer.status = 200')
        page.get_by_role('button', name='Reload Findings').click()
        page.wait_for_function("document.querySelector('[data-kin-location-result]')?.dataset.kinLocationResult === 'ok'")
        self.assertEqual([(3, SA + '.3'), (3.5, SA + '.3')], self.sent(page))
        self.assertEqual([['begin', 0, 0], ['end', 0, 0]], page.evaluate('synTold'))
        self.assertEqual(JOB_IMAGE, page.evaluate('synFirst().image'))
        self.quiet(page, 2)
        self.mine(page, 3)

    def test_slow_restore_and_rollback_never_save_partial_view(self):
        page = self.held()
        self.waiting(page, 'apply')
        self.assertEqual(JOB_IMAGE, page.evaluate('synFirst().image'), 'the Job is half on the screen')
        # More than every time limit of the viewer passes, and the save delay with it; then the window closes.
        page.evaluate("(() => { const real = Date.now.bind(Date); Date.now = () => real() + 3600000; })()")
        page.wait_for_timeout(3000)
        self.close(page)
        self.assertEqual([READ], self.requests(page), 'no length of time makes a restore still going on over')
        page.evaluate("synOpen('apply')")
        self.restored(page)
        self.quiet(page, 0)
        self.assertEqual(SAVED, [c['sop'] for c in page.evaluate('synServer.saved.cells')], 'the saved view stands')
        self.mine(page, 1)
        # The apply fails after its layout landed: the panel puts the previous screen back, and that takes time too.
        page = self.held(steps=("{ gate: 'apply', fail: true }", "{ gate: 'back' }"))
        self.change(page, zoom=3, image=2)
        page.wait_for_function('synServer.posts.length === 1', timeout=6000)
        self.waiting(page, 'apply')
        page.wait_for_timeout(2500)
        self.close(page)
        self.assertEqual(1, len(self.posts(page)), 'half applied')
        page.evaluate("synOpen('apply')")
        page.wait_for_function("synRestore.waiting === 'back'")
        page.wait_for_timeout(2500)
        self.close(page)
        self.assertEqual(1, len(self.posts(page)), 'half rolled back')
        page.evaluate("synOpen('back')")
        page.wait_for_function("synJobsStatus().startsWith('저장한 영상 표시를 확인하지 못했습니다.')")
        self.assertEqual([['begin', 0, 0], ['end', 0, 0]], page.evaluate('synTold'), 'one hold, let go after the rollback')
        self.assertEqual(SA + '.3', page.evaluate('synFirst().image'))
        self.quiet(page, 1)
        self.change(page, cell=page.evaluate('synFirst().id'), zoom=5, image=2)
        page.wait_for_function('synServer.posts.length === 2', timeout=6000)
        self.assertEqual((5, SA + '.3'), self.sent(page)[-1])

    def test_failed_or_unmounted_restore_allows_change_and_close(self):
        def saves(page, what):
            # A change is saved after the usual delay and the next one by the closing window; nothing was ever held.
            self.started(page)
            self.change(page, zoom=3, image=2)
            page.wait_for_function('synServer.posts.length === 1', timeout=6000)
            self.change(page, zoom=4, image=2)
            self.close(page)
            self.assertEqual([(3, SA + '.3'), (4, SA + '.3')], self.sent(page), what)
            self.assertEqual([], page.evaluate('window.synTold || []'), what)
        # The finding's list cannot be read: its saved location never starts.
        page = self.combined(query=FOUND, findings_status=503)
        page.evaluate('synMountJobs(); synMountFindings()')
        page.wait_for_function("document.querySelector('#kin-viewer-findings-status')?.textContent.includes(%s)" % json.dumps(LIST_FAILED))
        saves(page, 'a findings list that failed')
        # The Findings section refuses to mount beside another version of its model.
        page = self.combined(query=FOUND)
        self.assertFalse(page.evaluate('(synMountJobs(), synMountFindings(Object.assign({}, kinFindingLinkModel, { SCHEMA: 1 })))'))
        saves(page, 'a Findings section that was not mounted')
        # No place for the Jobs panel: it mounts nothing and restores nothing.
        page = self.combined(layout=False)
        page.evaluate('synMountJobs()')
        saves(page, 'a Jobs panel that was not mounted')
        # Neither module ever arrives (a script that failed to load, an account that is not a writer).
        page = self.open(saved=view([cell(SA, 4), cell(SB, 2)]), query=JOB)
        saves(page, 'no Jobs module')

    def test_job_read_refusal_preserves_changes_made_during_read(self):
        def refused(status):
            page = self.held()
            page.evaluate('synJobs.readStatus = %d' % status)
            self.change(page, zoom=3, image=2)
            page.evaluate("synOpen('read')")
            page.wait_for_function("synJobsStatus().startsWith('SYN job unavailable')")
            return page
        # The Job is gone: what the reader changed while it was read is saved after the usual delay.
        page = refused(404)
        page.wait_for_function('synServer.posts.length === 1', timeout=6000)
        self.assertEqual(([(3, SA + '.3')], []), (self.sent(page), page.evaluate('synTold')))
        # The Job cannot be read and the window closes right after: the change goes with it.
        page = refused(500)
        self.close(page)
        self.assertEqual(([(3, SA + '.3')], True, []), (self.sent(page), page.evaluate('synServer.bodies[0].keepalive'), page.evaluate('synTold')))
        # The reader's own input comes ahead of the Job: the restore is refused and the change is the reader's.
        page = self.held()
        page.mouse.click(150, 180)
        self.change(page, zoom=3, image=2)
        page.evaluate("synOpen('read')")
        page.wait_for_function("synJobsStatus() === %s" % json.dumps(INPUT_AHEAD))
        page.wait_for_function('synServer.posts.length === 1', timeout=6000)
        self.assertEqual(([(3, SA + '.3')], []), (self.sent(page), page.evaluate('synTold')))
        self.assertEqual(SA + '.3', page.evaluate('synFirst().image'))

    def test_first_change_immediately_after_restore_is_saved(self):
        after = "addEventListener('kin-viewer-opening-restore', event => { if (event.detail.phase === 'end') Promise.resolve().then(() => { %s; }); })"
        # The reader zooms in the very task the restore lets go in: that is the reader's change, not the starting point.
        page = self.held()
        self.waiting(page, 'apply')
        page.evaluate(after % 'synViewports.get(synFirst().id).setZoom(5)')
        page.evaluate("synOpen('apply')")
        self.restored(page)
        page.wait_for_function('synServer.posts.length === 1', timeout=6000)
        self.assertEqual([(5, JOB_IMAGE)], self.sent(page))
        self.quiet(page, 1, 2500)
        # The window closes in that task instead: the Job's view is not sent.
        page = self.held()
        self.waiting(page, 'apply')
        page.evaluate(after % "dispatchEvent(new Event('pagehide'))")
        page.evaluate("synOpen('apply')")
        self.restored(page)
        self.quiet(page, 0, 600)
        self.assertEqual([READ], self.requests(page))
        # A save sent as the restore began fails after it: the starting point the restore left is not unsent with it.
        page = self.held()
        self.change(page, zoom=3, image=2)
        page.evaluate("() => { synServer.hold = new Promise((_, reject) => { window.synFail = reject; }); }")
        self.waiting(page, 'apply')
        self.assertEqual([(3, SA + '.3')], self.sent(page))
        page.evaluate("synOpen('apply')")
        self.restored(page)
        page.evaluate("synFail(new TypeError('Failed to fetch')); synFire(synFirst().id, 'CAMERA_MODIFIED')")
        self.quiet(page, 1, 3000)
        self.mine(page, 2)

    def test_old_restore_completion_cannot_rebase_reentered_mode(self):
        def reentered():
            # The first screen's restore is half done when the mode is left; the same address is entered again.
            page = self.held(steps=("{ gate: 'old' }",))
            self.waiting(page, 'old')
            page.evaluate("synLeaveMode(); synGate('read'); synEnterMode(); synMountJobs()")
            self.assertEqual([], self.posts(page), 'leaving with the Job half on the screen saves nothing')
            page.wait_for_function("KinViewerFeatures.settings().some(s => s.id === 'autoSaveView')")
            self.started(page)
            page.wait_for_function('synJobs.reads === 2')
            self.assertGreater(page.evaluate('kinViewerOpeningRestore.screen'), 0)
            return page
        # The old restore settles while the new screen holds a change of the reader's and no restore of its own yet.
        page = reentered()
        self.change(page, zoom=3, image=2)
        page.evaluate("synOpen('old')")
        page.wait_for_function("synTold.some(told => told[0] === 'end')")
        self.assertEqual([['begin', 0, 0], ['end', 0, 0]], page.evaluate('synTold'))
        page.wait_for_function('synServer.posts.length === 1', timeout=6000)
        self.assertEqual([(3, SA + '.3')], self.sent(page), 'the old restore\'s end is not the new screen\'s starting point')
        page.evaluate("synOpen('read')")
        self.restored(page)
        self.quiet(page, 1)
        self.mine(page, 2)
        # The old restore settles while the new screen's own restore is half done: that one still holds.
        page = reentered()
        page.evaluate("synRestore.steps.push({ gate: 'new' })")
        self.waiting(page, 'new')
        page.evaluate("synOpen('old')")
        page.wait_for_function("synTold.some(told => told[0] === 'end')")
        self.assertEqual(1, page.evaluate('kinViewerOpeningRestore.holds.size'), 'the old restore let go of its own hold only')
        page.wait_for_timeout(2500)
        self.close(page)
        self.assertEqual([], self.posts(page), 'the new screen is still held')
        page.evaluate("synOpen('new')")
        self.restored(page)
        self.quiet(page, 0)
        self.mine(page, 1)

    def test_popout_comparison_url_change_and_session_end_are_isolated(self):
        # Pop Out: the same study in another window has its own state and saves on, while this one is held.
        page = self.held()
        self.waiting(page, 'apply')
        other = self.open(opener=page)
        self.started(other)
        self.change(other, zoom=3, image=2)
        other.wait_for_function('synServer.posts.length === 1', timeout=6000)
        self.assertEqual((0, 1), (other.evaluate('kinViewerOpeningRestore.holds.size'), page.evaluate('kinViewerOpeningRestore.holds.size')))
        self.close(page)
        self.assertEqual([], self.posts(page))
        # A Job of another set of studies opens in a new document: this one changes nothing and holds nothing.
        page = self.combined(job_studies=(STUDY, OTHER))
        page.evaluate("""() => { window.synNavigations = [];
          navigation.addEventListener('navigate', event => { synNavigations.push(event.destination.url); event.preventDefault(); });
          synGate('read'); synMountJobs(); }""")
        self.started(page)
        page.wait_for_function('synJobs.reads === 1')
        self.change(page, zoom=3, image=2)
        page.evaluate("synOpen('read')")
        page.wait_for_function('synNavigations.length === 1')
        self.assertIn('StudyInstanceUIDs=' + STUDY + '%2C' + OTHER + '&kinJob=' + JOB_ID, page.evaluate('synNavigations[0]'))
        self.assertEqual((OPENING_PAIR, []), (page.evaluate('synJobsStatus()'), page.evaluate('synTold')))
        page.wait_for_function('synServer.posts.length === 1', timeout=6000)
        self.assertEqual([(3, SA + '.3')], self.sent(page), 'what the reader changed before the move is saved')
        # The address changes under a restore half done (a patient tab): nothing of it is saved, then or after it lets go.
        page = self.held()
        self.waiting(page, 'apply')
        page.evaluate("history.replaceState(null, '', location.pathname + '?StudyInstanceUIDs=%s'); synOpen('apply')" % OTHER)
        page.wait_for_function('kinViewerOpeningRestore.holds.size === 0')
        self.quiet(page, 0, 3000)
        self.close(page)
        self.assertEqual([READ], self.requests(page))
        # The session ends under a restore half done: the same.
        page = self.held()
        self.waiting(page, 'apply')
        page.evaluate("synEndSession(); synOpen('apply')")
        page.wait_for_function('kinViewerOpeningRestore.holds.size === 0')
        self.change(page, cell=page.evaluate('synFirst().id'), zoom=5)
        self.quiet(page, 0, 3000)
        self.close(page)
        self.assertEqual([READ], self.requests(page))

    def test_auto_save_view_starting_during_or_after_a_restore(self):
        switch_on = self.switch_on
        # Switched on while the Job is half on the screen: nothing is saved until the restore lets go.
        page = self.combined(on=False)
        self.started(page)
        self.window(page)
        page.evaluate("synRestore.steps.push({ gate: 'apply' }); synMountJobs()")
        page.wait_for_function("synRestore.waiting === 'apply'")
        switch_on(page)
        page.wait_for_timeout(3000)
        self.close(page)
        self.assertEqual([READ], self.requests(page))
        page.evaluate("synOpen('apply')")
        self.restored(page)
        self.quiet(page, 0)
        self.mine(page, 1)
        # Switched on after the restore is over: the Job on the screen is where saving starts from.
        page = self.combined(on=False)
        self.started(page)
        self.window(page)
        page.evaluate('synMountJobs()')
        self.restored(page)
        switch_on(page)
        self.quiet(page, 0)
        self.assertEqual([READ], self.requests(page))
        self.mine(page, 1)

    def test_restore_job_button_and_same_document_finding_move_say_nothing(self):
        page = self.combined(query='', saved=False)
        page.evaluate('synMountJobs(); synMountFindings()')
        self.started(page)
        # Restore Job is the reader's own: the Job's view is saved as any change is.
        page.locator('#kin-viewer-jobs').get_by_role('button', name='Restore Job').click()
        self.restored(page)
        page.wait_for_function('synServer.posts.length === 1', timeout=6000)
        self.assertEqual(JOB_IMAGE, self.sent(page)[0][1])
        self.change(page, cell=page.evaluate('synFirst().id'), zoom=3, image=2)
        page.wait_for_function('synServer.posts.length === 2', timeout=6000)
        # A finding's saved view opened within this document is the reader's own too.
        page.locator('#kin-viewer-findings').get_by_role('button', name='Open Saved View').click()
        page.wait_for_function("document.querySelector('[data-kin-location-result]')?.dataset.kinLocationResult === 'ok'")
        page.wait_for_function('synServer.posts.length === 3', timeout=6000)
        self.assertEqual(JOB_IMAGE, self.sent(page)[2][1])
        self.assertEqual(([], 0), (page.evaluate('synTold'), page.evaluate('kinViewerOpeningRestore.holds.size')))

    # ── The screen a restore left is the starting point, whatever else is still on its way or still to come ──
    def before_restore(self, entry):
        """The reader's view (zoom 3, the third image) is sent and not answered yet; then the address's restore puts
        the Job on the screen. `entry`: the kinJob page, or a finding's saved location continued into the page."""
        if entry == 'job':
            page = self.held(steps=())
        else:
            page = self.combined(query=FOUND, findings_status=503)
            page.evaluate('synMountJobs(); synMountFindings()')
            page.wait_for_function("document.querySelector('#kin-viewer-findings-status')?.textContent.includes(%s)" % json.dumps(LIST_FAILED))
            self.started(page)
        page.evaluate(HOLD)
        self.change(page, zoom=3, image=2)
        page.wait_for_function('synServer.log.length === 1', timeout=6000)
        if entry == 'job':
            page.evaluate("synOpen('read')")
            self.restored(page)
        else:
            page.evaluate('synFindingServer.status = 200')
            page.get_by_role('button', name='Reload Findings').click()
            page.wait_for_function("document.querySelector('[data-kin-location-result]')?.dataset.kinLocationResult === 'ok'")
        self.assertEqual((BEFORE, JOB_IMAGE), (self.sent(page), page.evaluate('synFirst().image')))
        return page

    def leave(self, page, how):
        if how == 'close':
            page.evaluate("dispatchEvent(new Event('pagehide'))")
        elif how == 'switch':
            page.evaluate("document.body.classList.add('kin-patient-switching')")
        else:
            page.evaluate("synToolbar.dispose()")
        page.wait_for_timeout(300)

    def test_pending_pre_restore_save_never_resends_restored_view(self):
        def answered(page):
            # The reader's first save is answered at last. What stands saved is the reader's view from before the restore.
            page.evaluate('synServer.release()')
            page.wait_for_function("synServer.log.length === 4")
            self.assertEqual((['save', 'save', 'saved', 'stale'], SA + '.3', 3), (page.evaluate('synServer.log'), page.evaluate('synServer.saved.cells[0].sop'),
                                                                                round(page.evaluate('synServer.saved.cells[0].zoom'), 6)))
        for entry in ('job', 'finding'):
            for how in ('close', 'switch', 'end'):
                with self.subTest(entry=entry, leave=how):
                    page = self.before_restore(entry)
                    self.leave(page, how)
                    self.assertEqual(BEFORE, self.sent(page), 'the Job on the screen is not sent for the sake of the save before it')
                    answered(page)
        # The panel is taken down and comes back while that save is still unanswered: its second restore begins with
        # the first one's screen standing, and that is not the reader's view to send ahead of it either.
        page = self.before_restore('job')
        page.evaluate('synJobsPanel.stop(); synMountJobs()')
        page.wait_for_function('synTold.length === 4')
        self.restored(page)
        self.assertEqual(BEFORE, self.sent(page))
        self.close(page)
        self.assertEqual(BEFORE, self.sent(page))
        answered(page)
        # What the reader changes after the restore is the reader's as ever: saved, and sent again by the closing
        # window while that save is unanswered.
        page.evaluate(HOLD)
        self.mine(page, 3)
        self.close(page)
        self.assertEqual(BEFORE + [(5, JOB_IMAGE)] * 2, self.sent(page))
        self.assertEqual([False, False, False, True], page.evaluate('synServer.bodies.map(b => b.keepalive)'))

    def test_uncapturable_restore_end_waits_for_a_capturable_screen(self):
        def earlier(page):
            # The reader's own view (the right cell on its third image) is saved and answered before the Job is read.
            # The failed rollback puts only the first cell back: the screen it leaves is neither that view nor the Job.
            self.change(page, cell='right', zoom=3, image=2)
            page.wait_for_function("synServer.log.length === 2", timeout=6000)

        def stands(page):
            self.assertEqual((1, SB + '.3'), (len(self.posts(page)), page.evaluate('synServer.saved.cells[1].sop')), 'the reader\'s saved view stands')
        page = self.unsettled(before=earlier)
        # Nothing to start from yet. Neither what the viewer says of itself, nor the save delay, nor the window closing
        # sends a thing.
        self.stir(page)
        self.quiet(page, 1, 2600)
        self.close(page)
        # The image comes, and the camera and the grid say so: that screen is where saving starts from, not a change.
        page.evaluate('synLoaded()')
        self.stir(page)
        self.quiet(page, 1, 2600)
        self.close(page)
        stands(page)
        self.own(page, 2)
        # The image came with no word of it: the closing window finds the screen it can start from, and sends nothing.
        page = self.unsettled(before=earlier)
        page.evaluate('synLoaded(1, true)')
        self.close(page)
        self.stir(page)
        self.quiet(page, 1, 2600)
        stands(page)
        self.own(page, 2)
        # The starting point is taken as the image comes, not a moment later: what the reader changes right after it
        # is the reader's change.
        page = self.unsettled(before=earlier)
        page.evaluate('synLoaded()')
        self.own(page, 2)
        self.quiet(page, 2, 2600)

    def test_nothing_but_a_capturable_screen_ends_that_wait(self):
        def kept(page):
            # The reader's view from before the restore: its first save (after the usual delay) stays unanswered.
            page.evaluate(HOLD)
            self.change(page, zoom=3, image=2)
            page.wait_for_function('synServer.log.length === 1', timeout=6000)

        def failing(page):
            # The reader's change is still waiting as the restore begins: it is sent then, and that save will fail.
            page.evaluate("() => { synServer.hold = new Promise((_, reject) => { window.synFail = reject; }); }")
            self.change(page, zoom=3, image=2)
        # A patient switch, with the image there by then: nothing is sent.
        switched = self.unsettled()
        switched.evaluate("synLoaded(1, true); document.body.classList.add('kin-patient-switching')")
        # The mode is left with the reader's earlier save still unanswered: the screen is not sent for its sake.
        left = self.unsettled(before=kept)
        self.assertEqual(BEFORE, self.sent(left))
        left.evaluate('synLoaded(1, true); synToolbar.dispose()')
        # The reader's latest save fails meanwhile: that does not make the screen the restore left one to send.
        failed = self.unsettled(before=failing)
        self.assertEqual(BEFORE[:1], self.sent(failed))
        failed.evaluate("synFail(new TypeError('Failed to fetch'))")
        failed.wait_for_function("synServer.log.length === 2")
        failed.evaluate('synLoaded()')
        # The check is off all the while and switched on once the image has come.
        off = self.unsettled(on=False)
        off.evaluate('synLoaded()')
        self.window(off)
        self.switch_on(off)
        # Discard Saved View is pressed meanwhile, and another window's Discard is heard meanwhile.
        discarded = self.unsettled()
        panel = self.window(discarded)
        panel.get_by_role('button', name='Discard Saved View').click()
        expect(panel.get_by_role('status')).to_have_text('The saved view of this study was discarded.')
        discarded.evaluate('synLoaded()')
        heard = self.unsettled()
        heard.evaluate("""study => { synServer.saved = null; synServer.generation = '1'; const c = new BroadcastChannel('kin-auto-view');
          c.postMessage({ owner: JSON.stringify(synSession.owner()), study, generation: '1' }); c.close(); }""", STUDY)
        heard.wait_for_timeout(200)
        heard.evaluate('synLoaded()')
        # A Hanging Protocol is applied meanwhile: the screen it leaves is the one to start from.
        hung = self.unsettled()
        hung.evaluate("""() => { synLoaded(1, true);
          dispatchEvent(new CustomEvent('kin-hanging-protocol-applied', { detail: { viewportIds: [...synViewports.keys()], display: [null, null] } })); }""")
        pages = {'switched': switched, 'left': left, 'failed': failed, 'off': off, 'discarded': discarded, 'heard': heard, 'hung': hung}
        for page in pages.values():
            if page is not left:
                self.stir(page)
        switched.wait_for_timeout(3000)
        switched.evaluate("document.body.classList.remove('kin-patient-switching')")
        for name, page in pages.items():
            with self.subTest(page=name):
                self.close(page)
                before = {'left': 2, 'failed': 1}.get(name, 0)
                self.assertEqual(BEFORE[:before], self.sent(page), 'nothing was sent of the screen the failed restore left')
                if name == 'left':
                    page.evaluate('synServer.release()')
                    page.wait_for_function("synServer.log.length === 4")
                    self.assertEqual((['save', 'save', 'saved', 'stale'], SA + '.3'), (page.evaluate('synServer.log'), page.evaluate('synServer.saved.cells[0].sop')))
                    continue
                self.assertEqual(['discard'] if name == 'discarded' else ['save', 'aborted'] if name == 'failed' else [], page.evaluate('synServer.log'))
                self.own(page, before + 1, zoom=6)
                self.assertEqual('1' if name in ('discarded', 'heard') else '0', page.evaluate('synServer.bodies.at(-1).generation'))

    def test_restore_over_before_ready_takes_the_same_starting_point(self):
        # The Job is on the screen before this viewer's saved view is read (its answer is kept back): the restore's end
        # is heard by a viewer not saving yet. The screen it left is where saving starts from once the read answers.
        page = self.combined(setup=HOLD_READ)
        page.evaluate('synMountJobs()')
        self.restored(page)
        page.wait_for_function(READING, timeout=8000)
        page.evaluate('synServer.releaseRead()')
        self.quiet(page, 0)
        self.close(page)
        self.assertEqual([READ], self.requests(page))
        self.mine(page, 1)
        # The restore and its rollback both fail before that, and one image is still to come as saving starts: the
        # image coming is not a change to save.
        page = self.combined(setup=HOLD_READ)
        page.evaluate("synGate('read'); synRestore.steps.push({ gate: 'apply', fail: true }, { gate: 'back', fail: true }); synMountJobs()")
        page.wait_for_function(READING, timeout=8000)
        page.wait_for_function('synJobs.reads === 1')
        self.waiting(page, 'apply')
        page.evaluate("synOpen('apply')")
        page.wait_for_function("synRestore.waiting === 'back'")
        page.evaluate("synLoading(); synOpen('back')")
        page.wait_for_function("synJobsStatus().startsWith(%s)" % json.dumps(UNKNOWN))
        page.evaluate('synServer.releaseRead()')
        page.wait_for_timeout(300)
        page.evaluate('synLoaded()')
        self.stir(page)
        self.quiet(page, 0, 2600)
        self.close(page)
        self.assertEqual([READ], self.requests(page), 'loading alone saves nothing')
        self.own(page, 1)

    # ── A screen no such restore ever held: saving starts as it always has ──
    def unstarted(self, **options):
        """A viewer whose saved view is still being read: saving starts as that read answers (synServer.releaseRead),
        on whatever the case has made of the screen by then."""
        page = (self.combined if options else self.open)(setup=HOLD_READ, **options)
        page.wait_for_function(READING, timeout=8000)
        return page

    def test_first_start_without_a_saved_view_uses_the_first_stable_cell_as_its_baseline(self):
        page = self.unstarted()
        page.evaluate('synLoading(); synServer.releaseRead()')
        page.wait_for_timeout(300)
        page.evaluate('synLoaded()')
        self.quiet(page, 0, 2500)
        self.close(page)
        self.assertEqual([], self.posts(page))
        self.own(page, 1)
        # The reader makes the screen one cell while that image is still to come, and goes away: that cell is saved.
        for how in ('close', 'switch', 'end'):
            with self.subTest(leave=how):
                page = self.unstarted()
                page.evaluate('synLoading(); synServer.releaseRead()')
                page.wait_for_timeout(300)
                page.evaluate("synBuild(1, 1, [['only', 'set-A']])")
                self.leave(page, how)
                page.wait_for_function("synServer.log.join() === 'save,saved'", timeout=3000)
                post, body = self.posts(page)[0], page.evaluate('synServer.bodies[0]')
                self.assertEqual((1, 1, [SA + '.1'], how == 'close'), (post['rows'], post['cols'], [c['sop'] for c in post['cells']], body['keepalive']))
        # Another window's Discard is heard while the saved view is still being read: the view on the screen then is
        # the one discarded. One of its images coming late, once saving has started, does not send it again.
        page = self.unstarted()
        page.evaluate("""study => { synServer.saved = null; synServer.generation = '1'; const c = new BroadcastChannel('kin-auto-view');
          c.postMessage({ owner: JSON.stringify(synSession.owner()), study, generation: '1' }); c.close(); }""", STUDY)
        page.wait_for_timeout(200)
        page.evaluate('synLoading(); synServer.releaseRead()')
        page.wait_for_timeout(300)
        page.evaluate('synLoaded()')
        self.stir(page)
        self.quiet(page, 0, 2600)
        self.close(page)
        self.assertEqual([], page.evaluate('synServer.log'), 'the discarded view is not saved again')
        self.own(page, 1)
        self.assertEqual('1', page.evaluate('synServer.bodies[0].generation'))
        # The Job is still being read as saving starts, so no restore has held the screen yet. The image comes and the
        # Job lands before the save delay is over: the viewer's own screen is sent as the restore begins, as any view
        # still waiting is, and the Job's screen is the starting point.
        page = self.unstarted(query=JOB)
        page.evaluate("synGate('read'); synMountJobs()")
        page.wait_for_function('synJobs.reads === 1')
        page.evaluate('synLoading(); synServer.releaseRead()')
        page.wait_for_timeout(300)
        page.evaluate("synLoaded().then(() => synOpen('read'))")
        self.restored(page)
        self.assertEqual(([(1, SA + '.1')], [['begin', 0, 0], ['end', 0, 0]]), (self.sent(page), page.evaluate('synTold')))
        self.quiet(page, 1)
        self.close(page)
        self.assertEqual(1, len(self.posts(page)), 'the Job on the screen is not sent')
        self.mine(page, 2)

    def test_module_installed_after_restore_is_over_still_waits(self):
        # The restore and its rollback, both failed, are over before the Auto Save View module is there at all (a
        # script that came late): it heard nothing of them, and one image is still to come as it starts saving. The
        # screen is one a restore held all the same: the image coming is not a change to save.
        page = self.combined(autosave=False)
        page.evaluate("synGate('read'); synRestore.steps.push({ gate: 'apply', fail: true }, { gate: 'back', fail: true }); synMountJobs()")
        page.wait_for_function('synJobs.reads === 1')
        self.waiting(page, 'apply')
        page.evaluate("synOpen('apply')")
        page.wait_for_function("synRestore.waiting === 'back'")
        page.evaluate("synLoading(); synOpen('back')")
        page.wait_for_function("synJobsStatus().startsWith(%s)" % json.dumps(UNKNOWN))
        self.assertEqual(([['begin', 0, 0], ['end', 0, 0]], 0), (page.evaluate('synTold'), page.evaluate('kinViewerOpeningRestore.holds.size')))
        self.install(page)
        page.wait_for_function(READING, timeout=8000)
        page.wait_for_timeout(300)
        page.evaluate('synLoaded()')
        self.stir(page)
        self.quiet(page, 0, 2600)
        self.close(page)
        self.assertEqual([READ], self.requests(page), 'loading alone saves nothing')
        self.own(page, 1)

    def test_restore_of_an_earlier_screen_does_not_make_this_one_wait(self):
        def again(enter):
            # The Job was put on the first screen. The mode is left and entered again at the same address, and the new
            # viewer's saved view is still being read.
            page = self.combined()
            page.evaluate('synMountJobs()')
            self.started(page)
            self.restored(page)
            self.assertEqual(([['begin', 0, 0], ['end', 0, 0]], []), (page.evaluate('synTold'), self.posts(page)))
            page.evaluate("synLeaveMode(); (%s)(); %s" % (HOLD_READ, enter))
            page.wait_for_function("KinViewerFeatures.settings().some(s => s.id === 'autoSaveView')")
            page.wait_for_function("synRequests.filter(r => r.startsWith('GET ') && r.endsWith('/viewer-auto-view')).length === 2", timeout=8000)
            self.assertGreater(page.evaluate('kinViewerOpeningRestore.screen'), 0)
            return page
        # No restore comes this time (no panel), and one image is still to come as the new viewer starts saving. The
        # earlier screen's restore is not this screen's: the first screen that can be captured is saved.
        page = again('synEnterMode()')
        page.evaluate('synLoading(); synServer.releaseRead()')
        page.wait_for_timeout(300)
        page.evaluate('synLoaded()')
        page.wait_for_function('synServer.posts.length === 1', timeout=6000)
        self.assertEqual([(1, SA + '.1')], self.sent(page))
        self.own(page, 2)
        # The new screen's own restore fails, and its rollback too, before the new viewer starts saving with one
        # image still to come: that restore is this screen's, and the image coming is not a change to save.
        page = again("synGate('read'); synRestore.steps.push({ gate: 'apply', fail: true }, { gate: 'back', fail: true }); synEnterMode(); synMountJobs()")
        page.wait_for_function('synJobs.reads === 2')
        self.waiting(page, 'apply')
        page.evaluate("synOpen('apply')")
        page.wait_for_function("synRestore.waiting === 'back'")
        page.evaluate("synLoading(); synOpen('back')")
        page.wait_for_function("synJobsStatus().startsWith(%s)" % json.dumps(UNKNOWN))
        told = page.evaluate('synTold')
        self.assertEqual((['begin', 'end', 'begin', 'end'], [0, 0]), ([phase for phase, _, _ in told], [screen for _, screen, _ in told[:2]]))
        self.assertGreater(told[2][1], 0, 'the second restore is the new screen\'s')
        page.evaluate('synServer.releaseRead()')
        page.wait_for_timeout(300)
        page.evaluate('synLoaded()')
        self.stir(page)
        self.quiet(page, 0, 2600)
        self.close(page)
        self.assertEqual([READ] * 2, self.requests(page), 'loading alone saves nothing')
        self.own(page, 1)

    def test_leaving_with_a_save_unanswered_sends_the_view_again(self):
        # No restore: going away while the save of the view on the screen is still on its way sends that view again
        # (the first may not outlive the window or the viewer), as it always has.
        for how in ('close', 'switch', 'end'):
            with self.subTest(leave=how):
                page = self.open()
                self.started(page)
                page.evaluate(HOLD)
                self.change(page, zoom=2)
                page.wait_for_function('synServer.log.length === 1', timeout=6000)
                self.leave(page, how)
                page.wait_for_function('synServer.log.length === 3', timeout=3000)
                page.evaluate('synServer.release()')
                page.wait_for_function('synServer.log.length === 4', timeout=3000)
                self.assertEqual(['save', 'save', 'saved', 'stale'], page.evaluate('synServer.log'))
                bodies, posts = page.evaluate('synServer.bodies'), self.posts(page)
                self.assertEqual(([1, 2], [False, how == 'close']), ([b['seq'] for b in bodies], [b['keepalive'] for b in bodies]))
                self.assertEqual(posts[0], posts[1], 'the same view')

    def test_25_a_quick_replacement_also_restarts_quiet_without_changing_the_shown_image(self):
        page = self.open()
        self.started(page)
        page.evaluate("() => { synViewports.get('left').setStack = () => new Promise(() => {}); }")
        page.evaluate("dispatchEvent(new CustomEvent('kin-hanging-protocol-applied', { detail: { viewportIds: ['left'], display: [%s] } }))" % json.dumps(SORT_DOWN))
        page.evaluate("KinViewerCellRules.apply('right', %s)" % json.dumps(SORT_DOWN))
        page.wait_for_timeout(400)
        second = {**SORT_DOWN, 'overlay': 'full'}
        page.evaluate("KinViewerCellRules.apply('right', %s)" % json.dumps(second))
        page.wait_for_timeout(350)
        page.evaluate("dispatchEvent(new Event('pagehide'))")
        page.wait_for_timeout(50)
        self.assertEqual([], self.posts(page), 'the replacement needs its own quiet interval')
        page.wait_for_function('synServer.posts.length === 1', timeout=6000)
        self.assertEqual(second, self.posts(page)[0]['cells'][1]['display'])

    def test_26_old_inflight_requests_do_not_resend_the_unchanged_view_with_a_new_generation(self):
        page = self.open()
        self.started(page)
        page.evaluate("() => { synServer.hold = new Promise(resolve => { synServer.releaseFirst = resolve; }); }")
        self.change(page, zoom=2)
        page.wait_for_function('synServer.posts.length === 1', timeout=5000)
        page.evaluate("() => { synServer.hold = new Promise(resolve => { synServer.releaseSecond = resolve; }); }")
        self.change(page, zoom=3)
        page.evaluate("dispatchEvent(new Event('pagehide'))")
        page.wait_for_function('synServer.posts.length === 2', timeout=1000)
        page.evaluate("""async () => {
          await fetch('/api/studies/%s/viewer-auto-view/discard', { method: 'POST',
            body: JSON.stringify({writer: crypto.randomUUID(), seq: 1, at: Date.now()}) });
          synServer.releaseFirst();
        }""" % STUDY)
        page.wait_for_function("synServer.log.includes('stale')", timeout=1000)
        page.wait_for_timeout(100)
        page.evaluate("dispatchEvent(new Event('pagehide'))")
        page.wait_for_timeout(100)
        self.assertEqual(2, len(self.posts(page)), 'old-generation requests must not force a fresh closing save')
        self.assertIsNone(page.evaluate('synServer.saved'))
        page.evaluate('synServer.releaseSecond()')
        page.wait_for_function("synServer.log.filter(x => x === 'stale').length === 2", timeout=1000)
        self.change(page, zoom=4)
        page.wait_for_function('synServer.saved !== null', timeout=5000)
        self.assertEqual('1', page.evaluate('synServer.bodies.at(-1).generation'))
        self.assertAlmostEqual(4, page.evaluate('synServer.saved.cells[0].zoom'))

    def test_27_a_slow_rule_finishes_without_another_change_and_the_view_is_saved(self):
        slow = """() => { const inner = window.fetch; window.fetch = async (url, init = {}) => {
          if (String(url).includes('/dicom-web/')) { await new Promise(r => setTimeout(r, 3500)); return new Response('{}', { status: 500 }); }
          return inner(url, init); }; }"""
        page = self.open(setup=slow)
        self.started(page)
        rule = {**SORT_DOWN, 'gspsAuto': True}
        page.evaluate("void KinViewerCellRules.apply('right', %s).then(() => { window.applied = true; })" % json.dumps(rule))
        page.wait_for_timeout(2600)
        self.assertEqual([], self.posts(page), 'the rule is still running')
        page.wait_for_function('window.applied === true', timeout=5000)
        page.wait_for_timeout(4500)
        self.assertEqual(1, len(self.posts(page)), 'save without another change or closing the window')
        self.assertEqual(rule, self.posts(page)[0]['cells'][1]['display'])

    def test_28_first_read_fails_then_the_first_change_is_saved_on_close(self):
        fail = """() => { const inner = window.fetch; let fail = true; window.fetch = async (url, init = {}) => {
          if (String(url).endsWith('/viewer-auto-view') && (init.method || 'GET') === 'GET' && fail) {
            fail = false; synRequests.push('GET ' + url + ' (500)'); return new Response('{}', { status: 500 }); }
          return inner(url, init); }; }"""
        page = self.open(setup=fail)
        self.started(page)
        self.change(page, zoom=2)
        page.evaluate("dispatchEvent(new Event('pagehide'))")
        page.wait_for_timeout(800)
        self.assertEqual(1, len(self.posts(page)))
        self.assertTrue(page.evaluate('synServer.bodies[0].keepalive'))
        self.assertAlmostEqual(2, page.evaluate('synServer.saved.cells[0].zoom'))

    def test_29_another_windows_discard_preserves_the_first_new_change(self):
        page = self.open()
        self.started(page)
        self.change(page, zoom=2)
        page.wait_for_function('synServer.saved !== null', timeout=5000)
        other = self.open(opener=page, setup="() => { window.synServer = opener.synServer; }")
        other.wait_for_function("document.querySelector('[data-auto-view-badge]')", timeout=8000)
        self.started(other)
        panel = self.window(other)
        panel.get_by_role('button', name='Discard Saved View').click()
        expect(panel.get_by_role('status')).to_have_text('The saved view of this study was discarded.')
        page.wait_for_timeout(300)
        # Receiving Discard takes the current view as the new baseline: closing alone must not restore it.
        page.evaluate("dispatchEvent(new Event('pagehide'))")
        page.wait_for_timeout(100)
        self.assertIsNone(page.evaluate('synServer.saved'))
        self.assertEqual(1, len(self.posts(page)))
        self.change(page, zoom=3)
        page.wait_for_timeout(2500)
        page.evaluate("dispatchEvent(new Event('pagehide'))")
        page.wait_for_timeout(200)
        self.assertIsNotNone(page.evaluate('synServer.saved'), 'the first change after Discard must be saved')
        self.assertEqual(['0', '1'], page.evaluate('synServer.bodies.map(b => b.generation)'))
        self.assertAlmostEqual(3, page.evaluate('synServer.saved.cells[0].zoom'))

    def test_30_discard_notices_are_scoped_to_the_reader_and_study(self):
        page = self.open()
        self.started(page)
        peer = self.open(opener=page, on=False)
        peer.evaluate("window.notice = new BroadcastChannel('kin-auto-view')")
        for owner, study in ((['syn-site', 'another-reader'], STUDY),
                             (['another-site', 'syn-reader'], STUDY),
                             (None, STUDY), (OWNER, STUDY + '.99')):
            peer.evaluate("data => notice.postMessage(data)",
                          {'owner': json.dumps(owner, separators=(',', ':')) if owner else None,
                           'study': study, 'generation': '9'})
        page.wait_for_timeout(200)
        self.change(page, zoom=3)
        page.evaluate("dispatchEvent(new Event('pagehide'))")
        page.wait_for_function('synServer.posts.length === 1', timeout=1500)
        self.assertEqual('0', page.evaluate('synServer.bodies[0].generation'))
        self.assertAlmostEqual(3, page.evaluate('synServer.saved.cells[0].zoom'))

    def test_31_discard_notice_does_not_revive_inflight_or_queued_views(self):
        page = self.open(saved=view([cell(SA, 1), cell(SB, 1)]))
        page.wait_for_function("document.querySelector('[data-auto-view-badge]')", timeout=8000)
        self.started(page)
        other = self.open(opener=page, setup="() => { window.synServer = opener.synServer; }")
        other.wait_for_function("document.querySelector('[data-auto-view-badge]')", timeout=8000)
        self.started(other)
        page.evaluate("() => { synServer.hold = new Promise(resolve => { synServer.release = resolve; }); }")
        self.change(page, zoom=2)
        page.wait_for_function('synServer.posts.length === 1', timeout=5000)
        self.change(page, zoom=3)
        page.wait_for_timeout(2300)
        panel = self.window(other)
        panel.get_by_role('button', name='Discard Saved View').click()
        expect(panel.get_by_role('status')).to_have_text('The saved view of this study was discarded.')
        page.wait_for_timeout(200)
        page.evaluate("dispatchEvent(new Event('pagehide')); synServer.release()")
        page.wait_for_function("synServer.log.filter(x => x === 'stale').length === 2", timeout=2000)
        page.evaluate("dispatchEvent(new Event('pagehide'))")
        page.wait_for_timeout(2200)
        self.assertEqual(['0', '0'], page.evaluate('synServer.bodies.map(b => b.generation)'))
        self.assertIsNone(page.evaluate('synServer.saved'))
        # An already observed or older notice must not swallow the next new change while its timer is running.
        self.change(page, zoom=4)
        other.evaluate("""study => { const c = new BroadcastChannel('kin-auto-view');
          for (const generation of ['1', '0']) c.postMessage({ owner: JSON.stringify(synSession.owner()), study, generation }); c.close(); }""", STUDY)
        page.wait_for_function('synServer.saved !== null', timeout=5000)
        self.assertEqual(['0', '0', '1'], page.evaluate('synServer.bodies.map(b => b.generation)'))
        self.assertAlmostEqual(4, page.evaluate('synServer.saved.cells[0].zoom'))

    def test_32_without_broadcast_channel_discard_and_subsequent_changes_still_work(self):
        page = self.open(setup="() => { window.BroadcastChannel = undefined; }")
        self.started(page)
        self.change(page, zoom=2)
        page.wait_for_function('synServer.saved !== null', timeout=5000)
        panel = self.window(page)
        panel.get_by_role('button', name='Discard Saved View').click()
        expect(panel.get_by_role('status')).to_have_text('The saved view of this study was discarded.')
        page.evaluate("dispatchEvent(new Event('pagehide'))")
        page.wait_for_timeout(100)
        self.assertIsNone(page.evaluate('synServer.saved'))
        self.change(page, zoom=3)
        page.wait_for_function('synServer.saved !== null', timeout=5000)
        self.assertEqual(['0', '1'], page.evaluate('synServer.bodies.map(b => b.generation)'))
        self.assertAlmostEqual(3, page.evaluate('synServer.saved.cells[0].zoom'))

    def test_33_a_queued_save_blocked_by_a_rule_is_rescheduled(self):
        slow = """() => { const inner = window.fetch; window.fetch = async (url, init = {}) => {
          if (String(url).includes('/dicom-web/')) {
            await new Promise(resolve => { window.finishGSPS = resolve; }); return new Response('{}', { status: 500 }); }
          return inner(url, init); }; }"""
        page = self.open(setup=slow)
        self.started(page)
        page.evaluate("() => { synServer.hold = new Promise(resolve => { synServer.release = resolve; }); }")
        self.change(page, zoom=2)
        page.wait_for_function('synServer.posts.length === 1', timeout=5000)
        self.change(page, zoom=3)
        page.wait_for_timeout(2300)
        rule = {**SORT_DOWN, 'gspsAuto': True}
        page.evaluate("void KinViewerCellRules.apply('right', %s).then(() => { window.applied = true; })" % json.dumps(rule))
        page.wait_for_function('!!window.finishGSPS')
        # Let the view's timer expire while rules are busy, then let the queued save reach the same busy boundary.
        page.wait_for_timeout(2300)
        page.evaluate('synServer.release()')
        page.wait_for_timeout(300)
        self.assertEqual(1, len(self.posts(page)), 'no partial rule goes into a save')
        page.evaluate('finishGSPS()')
        page.wait_for_function('window.applied === true')
        page.wait_for_function('synServer.posts.length === 2', timeout=5000)
        self.assertEqual(rule, self.posts(page)[1]['cells'][1]['display'])
        self.assertAlmostEqual(3, self.posts(page)[1]['cells'][0]['zoom'])

    def test_34_failed_generation_reads_stop_retrying_without_another_change(self):
        fail = """() => { const inner = window.fetch; window.fetch = async (url, init = {}) => {
          if (String(url).endsWith('/viewer-auto-view') && (init.method || 'GET') === 'GET') {
            synRequests.push('GET ' + url + ' (500)'); return new Response('{}', { status: 500 }); }
          return inner(url, init); }; }"""
        page = self.open(setup=fail)
        self.started(page)
        self.change(page, zoom=2)
        page.wait_for_timeout(2600)
        before = self.requests(page)
        page.wait_for_timeout(2600)
        self.assertEqual(before, self.requests(page), 'a failed read must not start a retry loop')
        self.assertEqual([], self.posts(page))

    def test_20_the_switch_save_is_a_plain_request_and_a_refused_closing_save_is_sent_again(self):
        page = self.open()
        self.started(page)
        self.change(page)
        page.evaluate("document.body.classList.add('kin-patient-switching')")
        page.wait_for_function('synServer.posts.length === 1', timeout=1000)
        self.assertFalse(page.evaluate('synServer.bodies[0].keepalive'), 'not counted against the keepalive budget')
        page.evaluate("document.body.classList.remove('kin-patient-switching')")
        # A closing save the browser refuses (its keepalive budget used up) is not taken as sent.
        page.evaluate("synServer.refuseKeepalive = true")
        self.change(page, zoom=4, image=1)
        page.evaluate("dispatchEvent(new Event('pagehide'))")
        page.wait_for_function("synServer.log.includes('refused')", timeout=3000)
        page.evaluate("synServer.refuseKeepalive = false")
        page.evaluate("dispatchEvent(new Event('pagehide'))")
        page.wait_for_function('synServer.posts.length === 2', timeout=3000)
        self.assertEqual(SA + '.2', page.evaluate('synServer.saved.cells[0].sop'))


    def test_35_a_gsps_taken_off_by_the_defaults_is_saved_off_and_comes_back_off(self):
        # One GSPS of this study names the right cell's first image: a 90° turn and W 350 / L 50.
        gsps = """() => { const inner = window.fetch, cs = v => ({ vr: 'CS', Value: [v] });
          const pr = { '00080016': { vr: 'UI', Value: ['1.2.840.10008.5.1.4.1.1.11.1'] }, '00080018': { vr: 'UI', Value: ['%(study)s.900.1'] },
            '00080060': cs('PR'), '00700080': cs('SYN'), '00700082': { vr: 'DA', Value: ['20260801'] }, '00700083': { vr: 'TM', Value: ['101500'] },
            '00081115': { vr: 'SQ', Value: [{ '00081140': { vr: 'SQ', Value: [{ '00081155': { vr: 'UI', Value: ['%(sb)s.1'] } }] } }] },
            '00283110': { vr: 'SQ', Value: [{ '00281050': { vr: 'DS', Value: [50] }, '00281051': { vr: 'DS', Value: [350] } }] },
            '00700042': { vr: 'US', Value: [90] }, '00700041': cs('N') };
          window.synGspsReads = 0;
          window.fetch = async (url, init = {}) => {
            const path = String(url);
            if (path.startsWith('/dicom-web/studies/%(study)s/series?Modality=PR')) { synGspsReads++; return new Response(JSON.stringify([{ '0020000E': { vr: 'UI', Value: ['%(study)s.900'] } }]), { status: 200 }); }
            if (path === '/dicom-web/studies/%(study)s/series/%(study)s.900/metadata') return new Response(JSON.stringify([pr]), { status: 200 });
            return inner(url, init); }; }""" % {'study': STUDY, 'sb': SB}
        default = {**SORT_DOWN, 'sort': 'stock', 'overlay': 'full'}
        page = self.open(setup=gsps)
        self.started(page)
        page.evaluate("void KinViewerCellRules.apply('right', %s)" % json.dumps({**default, 'gspsAuto': True}))
        page.wait_for_function('synServer.posts.length === 1', timeout=8000)
        on = self.posts(page)[0]['cells'][1]
        self.assertEqual((True, 90, {'lower': -125, 'upper': 224}), (on['display']['gspsAuto'], on['camera']['rotation'], on['properties']['voiRange']))
        # The row back to the defaults: the rule is off, the cell has the defaults (no turn, the stored W 400 / L 40), and
        # that is what is saved, with no rule.
        page.evaluate("void KinViewerCellRules.apply('right', %s)" % json.dumps(default))
        page.wait_for_function('synServer.posts.length === 2', timeout=8000)
        off = self.posts(page)[1]['cells'][1]
        self.assertEqual((None, 0, {'lower': -160, 'upper': 239}, SB + '.1'), (off['display'], off['camera']['rotation'], off['properties']['voiRange'], off['sop']))
        # Opened again: the saved view comes back as it was saved — no GSPS is read or put on, the turn stays off.
        saved = page.evaluate('synServer.saved')
        again = self.open(saved=saved, setup=gsps)
        again.wait_for_function("document.querySelector('[data-auto-view-badge]')", timeout=8000)
        ids = again.evaluate('[...synViewports.keys()]')
        right = again.evaluate("id => { const v = synViewports.get(id); return { rotation: v.presentation.rotation, voi: v.properties.voiRange, image: v.getCurrentImageId() }; }", ids[1])
        self.assertEqual({'rotation': 0, 'voi': {'lower': -160, 'upper': 239}, 'image': 'syn:set-B:1'}, right)
        self.assertIsNone(again.evaluate("id => KinViewerCellRules.rule(id)", ids[1]))
        self.assertEqual(0, again.evaluate('synGspsReads'))

if __name__ == "__main__":
    unittest.main()
