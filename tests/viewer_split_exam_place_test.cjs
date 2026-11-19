// A series chosen for a viewer cell from a patient's related exams goes to the cell that place calls for, in a window
// opened on exam scopes: the shipped viewer-prior extension (config/ohif.js) over the shipped prior controller, the shell
// seam viewer-ux-shell.js and the exam scope model exam-scope.js. The two parts of one split original are two exams told
// apart by their series: a series of the other part goes beside the cell (its comparison place), a series of the cell's
// own part goes into the cell, both ways round. The originals of one merged exam keep their places as before.
// Synthetic studies only. node --test tests/viewer_split_exam_place_test.cjs
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const shipped = fs.readFileSync('config/ohif.js', 'utf8');
const priorSource = shipped.slice(shipped.indexOf('function kinCreateViewerPrior('), shipped.indexOf('function kinCreateMultiStudyStrip('));
const read = name => fs.readFileSync('worklist-v0/hpacs-lite/' + name, 'utf8');
// The exam scope model as the viewer gets it: the shared copy at the head of config/ohif.js.
const examScopeSource = shipped.slice(0, shipped.indexOf('})(globalThis);') + '})(globalThis);'.length);
const seriesOrderSource = fs.readFileSync('config/ohif/series-order.js', 'utf8');
const settle = () => new Promise(resolve => setImmediate(resolve));

class Element extends EventTarget {
  constructor(tag = 'div') { super(); this.tag = tag; this.children = []; this.attrs = {}; this.dataset = {}; this.style = {}; this.textContent = ''; }
  get classList() { return { contains: c => (this.className || '').split(' ').includes(c), add() {}, remove() {}, toggle() {} }; }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return this.attrs[k] ?? null; }
  append(...nodes) { for (const n of nodes) { n.remove?.(); n.parentElement = this; this.children.push(n); } }
  prepend(...nodes) { this.append(...nodes); }
  before() {}
  remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(n => n !== this); this.parentElement = null; }
  replaceChildren(...nodes) { for (const n of [...this.children]) n.remove(); this.append(...nodes); }
  matches(selector) {
    if (selector.startsWith('.')) return this.classList.contains(selector.slice(1));
    const attr = selector.match(/^\[([^=]+)=["']?([^"'\]]+)["']?\]$/);
    return attr ? this.attrs[attr[1]] === attr[2] : this.tag === selector;
  }
  querySelectorAll(selector) { return this.children.flatMap(n => [...(n.matches(selector) ? [n] : []), ...n.querySelectorAll(selector)]); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  closest(selector) { return this.matches(selector) ? this : this.parentElement?.closest(selector) ?? null; }
}

// One MR original X split into part A (series s1, s4) and part B (s2, s3, its report UID L); a merged exam of the
// originals M1 (base) and M2.
const X = '2.25.9100', L = '2.25.9199', M1 = '2.25.9201', M2 = '2.25.9202';
const scope = (reportUid, sources, extra) => ({ reportUid, groupId: 'g-' + reportUid, active: true, generation: 'gen-' + reportUid, ...extra, sources });
const PART_A = scope(X, [{ studyUid: X, series: { mode: 'exclude', uids: ['s2', 's3'] } }], { kind: 'split', part: 0 });
const PART_B = scope(L, [{ studyUid: X, series: { mode: 'include', uids: ['s2', 's3'] } }], { kind: 'split', part: 1 });
const MERGED = scope(M1, [{ studyUid: M1, series: { mode: 'all', uids: [] } }, { studyUid: M2, series: { mode: 'all', uids: [] } }], { kind: 'merge', part: null });
const set = (study, series, number) => ({ displaySetInstanceUID: study + ':' + series, StudyInstanceUID: study, SeriesInstanceUID: series,
  Modality: 'MR', SeriesNumber: number, SeriesDescription: 'MR ' + series, images: [{}] });
const SETS = [set(X, 's1', 1), set(X, 's2', 2), set(X, 's3', 3), set(X, 's4', 4), set(M1, 'm1', 1), set(M2, 'm2', 1)];
const SPLIT_ROWS = [{ uid: X, sourcePatientKey: 'P', date: '20261110', modality: 'MR', examScope: PART_A },
  { uid: L, sourcePatientKey: 'P', date: '20261110', modality: 'MR', examScope: PART_B }];
const MERGED_ROWS = [{ uid: M1, sourcePatientKey: 'P', date: '20261110', modality: 'MR', examScope: MERGED }];

async function world({ current, prior = null, rows, cells }) {
  const byId = id => SETS.find(item => item.displaySetInstanceUID === id), subscribers = new Set();
  const state = { activeViewportId: 'v1', layout: { layoutType: 'grid', numRows: 1, numCols: 2 }, viewports: new Map([
    ['v1', { viewportId: 'v1', displaySetInstanceUIDs: cells[0] ? [cells[0]] : [], x: 0, y: 0, width: 0.5, height: 1 }],
    ['v2', { viewportId: 'v2', displaySetInstanceUIDs: cells[1] ? [cells[1]] : [], x: 0.5, y: 0, width: 0.5, height: 1 }]]) };
  const grid = { EVENTS: { GRID_STATE_CHANGED: 'grid' }, getState: () => state, layouts: [],
    subscribe(_event, listener) { subscribers.add(listener); return { unsubscribe: () => subscribers.delete(listener) }; },
    setDisplaySetsForViewport({ viewportId, displaySetInstanceUIDs }) {
      state.viewports.set(viewportId, { ...state.viewports.get(viewportId), displaySetInstanceUIDs });
      for (const listener of [...subscribers]) listener();
    },
    setDisplaySetsForViewports(list) { for (const entry of list) this.setDisplaySetsForViewport(entry); },
    setLayout(options) { grid.layouts.push(options); } };
  const source = { retrieve: { series: { metadata: () => Promise.resolve() } }, deleteStudyMetadataPromise() {} };
  const services = { viewportGridService: grid,
    displaySetService: { EVENTS: {}, subscribe: () => ({ unsubscribe() {} }), getActiveDisplaySets: () => SETS, getDisplaySetByUID: byId },
    cornerstoneViewportService: { EVENTS: {}, subscribe: () => ({ unsubscribe() {} }), getCornerstoneViewport: () => ({ type: 'stack' }) } };
  const frames = new Map(); let nextFrame = 0, reopened = [];
  const chrome = () => ({ refresh() {}, place() {}, adopt() {}, invalidate() {}, dispose() {} });
  const document = new EventTarget(), head = new Element('head');
  const input = { current, prior, version: null };
  const sandbox = { document, console, URL, URLSearchParams, AbortController, Promise, structuredClone, setTimeout, clearTimeout,
    crypto: require('node:crypto').webcrypto,
    location: { origin: 'https://viewer.test', search: '?StudyInstanceUIDs=' + X + '&kinExamScopes=x', hash: '' },
    requestAnimationFrame(fn) { frames.set(++nextFrame, fn); return nextFrame; }, cancelAnimationFrame(id) { frames.delete(id); },
    MutationObserver: class { observe() {} disconnect() {} },
    kinViewerOnEnd: () => null, kinViewerSession: { ended: () => false, readOnly: () => false },
    kinViewerOpenPatient: async href => { reopened.push(href); return true; },
    fetch: async path => {
      assert.equal(path, '/api/studies');
      return { ok: true, status: 200, json: async () => ({ studies: structuredClone(rows) }) };
    } };
  sandbox.window = sandbox; sandbox.top = sandbox;
  Object.assign(document, { body: new Element('body'), head, createElement: tag => new Element(tag),
    getElementById: () => new Element(), querySelector: () => null, querySelectorAll: () => [] });
  head.append = function (...nodes) {
    Element.prototype.append.apply(this, nodes);
    for (const node of nodes) if (node.tag === 'script') queueMicrotask(() => {
      const name = node.src.split('/').pop();
      if (name === 'viewer-prior-controller.js') vm.runInContext(read(name), context);
      else sandbox.KinViewerPriorPanel = { list() {}, report() {} };
      node.onload();
    });
  };
  const patient = { key: 'P', sequence: 1, studyUIDs: current.sources.map(s => s.studyUid), examScope: current, patient: {} };
  Object.assign(sandbox, {
    KinSessionTransport: { refusal: () => false, responseError: () => new Error('ended') },
    KinViewerPatientTabs: { snapshot: () => ({ ...patient }), resolve: async () => ({ key: 'P' }),
      subscribe: () => () => {}, mount() {}, refresh() {}, dispose() {}, guard: () => true },
    // The window's admitted exam scopes, read through the shipped model's one role rule.
    KinViewerExamScope: { snapshot: () => input, ensure: async () => {}, role: (study, series) => sandbox.KinExamScope.examRole(input, study, series) },
    KinViewerInfoBar: { mount() { return chrome(); },
      identity(_services, viewportId) {
        const cell = state.viewports.get(viewportId), ids = cell?.displaySetInstanceUIDs || [];
        const shown = ids.length === 1 && byId(ids[0]);
        return { viewportId, cell, set: shown, viewport: { type: 'stack' },
          instance: shown ? { StudyInstanceUID: shown.StudyInstanceUID, SeriesInstanceUID: shown.SeriesInstanceUID } : null };
      } },
    KinViewerSeriesStrip: { mount: chrome }, cornerstone: { Enums: { Events: {} } },
  });
  const context = vm.createContext(sandbox);
  vm.runInContext(examScopeSource, context);
  vm.runInContext(seriesOrderSource, context); vm.runInContext(read('viewer-hanging-settings.js'), context);
  vm.runInContext(read('viewer-ux-shell.js'), context);
  const shell = sandbox.KinViewerUXShell.mount({ services, session: { owner: () => null, readOnly: () => false } });
  const extension = vm.runInContext(priorSource + ';kinCreateViewerPrior()', context);
  extension.preRegistration({ servicesManager: { services }, extensionManager: { getActiveDataSource: () => [source] } });
  extension.onModeEnter();
  for (let i = 0; i < 5; i++) await settle();
  assert.ok(sandbox.KinViewerUX?.related(), 'the extension mounted on the shell seam');
  return {
    shows: viewportId => Array.from(state.viewports.get(viewportId).displaySetInstanceUIDs), reopened, sandbox,
    // The Compare menu's way: the cell's related exams, then a chosen exam and series for that cell.
    async choose(viewportId, uid, seriesUid) {
      const related = sandbox.KinViewerUX.related(), value = sandbox.KinViewerUX.viewport(viewportId);
      const studies = await related.studies(value);
      assert.ok(studies, 'the cell finds its related exams');
      return related.open(value, uid, { seriesUid, studies });
    },
    end() { extension.onModeExit(); shell.dispose(); } };
}

test('split: from the first part, a series of the second part goes beside the cell, which keeps its image', async () => {
  const w = await world({ current: PART_A, prior: PART_B, rows: SPLIT_ROWS, cells: [X + ':s1', X + ':s2'] });
  try {
    assert.equal(await w.choose('v1', L, 's3'), true);
    assert.deepEqual([w.shows('v1'), w.shows('v2')], [[X + ':s1'], [X + ':s3']]);
  } finally { w.end(); }
});

test('split: from the second part as the current exam, a series of the first part goes beside the cell, not over it', async () => {
  const w = await world({ current: PART_B, prior: PART_A, rows: SPLIT_ROWS, cells: [X + ':s2', X + ':s1'] });
  try {
    assert.equal(await w.choose('v1', X, 's4'), true);
    assert.deepEqual([w.shows('v1'), w.shows('v2')], [[X + ':s2'], [X + ':s4']]);
  } finally { w.end(); }
});

test('split: a series of the cell\'s own part goes into that cell, from either part', async () => {
  let w = await world({ current: PART_B, prior: PART_A, rows: SPLIT_ROWS, cells: [X + ':s2', X + ':s1'] });
  try {
    assert.equal(await w.choose('v1', L, 's3'), true);
    assert.deepEqual([w.shows('v1'), w.shows('v2')], [[X + ':s3'], [X + ':s1']]);
  } finally { w.end(); }
  w = await world({ current: PART_A, prior: PART_B, rows: SPLIT_ROWS, cells: [X + ':s1', X + ':s2'] });
  try {
    assert.equal(await w.choose('v1', X, 's4'), true);
    assert.deepEqual([w.shows('v1'), w.shows('v2')], [[X + ':s4'], [X + ':s2']]);
  } finally { w.end(); }
});

test('merged: from the second original\'s cell, a series of the base original goes to the comparison place as before', async () => {
  const w = await world({ current: MERGED, rows: MERGED_ROWS, cells: [M2 + ':m2', null] });
  try {
    assert.equal(await w.choose('v1', M1, 'm1'), true);
    assert.deepEqual([w.shows('v1'), w.shows('v2')], [[M2 + ':m2'], [M1 + ':m1']]);
  } finally { w.end(); }
});

test('the cell\'s own part: an answer that comes after the request was dropped changes nothing', async () => {
  const w = await world({ current: PART_B, prior: PART_A, rows: SPLIT_ROWS, cells: [X + ':s2', X + ':s1'] });
  try {
    const related = w.sandbox.KinViewerUX.related(), value = w.sandbox.KinViewerUX.viewport('v1');
    const studies = await related.studies(value), request = new AbortController();
    let release;
    w.sandbox.KinViewerPatientTabs.resolve = () => new Promise(resolve => { release = () => resolve({ key: 'P' }); });
    const opening = related.open(value, L, { seriesUid: 's3', studies, signal: request.signal });
    for (let i = 0; i < 5 && !release; i++) await settle();
    request.abort(); release();
    assert.equal(await opening, false);
    assert.deepEqual(w.shows('v1'), [X + ':s2']);
  } finally { w.end(); }
});
