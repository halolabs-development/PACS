// The patient and examination a study is shown as in the viewer (config/ohif/study-display.js): the worklist's answer
// for that study — its list row with the Match / Modify display overlay (state.ov) over it. The cell heading
// (viewer-info-bar.js), the patient tab (viewer-patient-tabs.js) and the prior list read that one answer; the cell label
// and window title are covered by tests/viewer_study_display_dom_test.py. A Match shows the order's values in the viewer,
// an Unmatch the image's own values again, and the age is counted from the shown birth date and study date. Whenever the
// answer is not certain for the drawn image, the image's own values show.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');

const settle = () => new Promise(resolve => setImmediate(resolve));
const read = path => fs.readFileSync(path, 'utf8');
const plain = value => JSON.parse(JSON.stringify(value));

class Element {
  constructor(tag = 'div') { this.tag = tag; this.children = []; this.attrs = {}; this.dataset = {}; this.style = {}; this.textContent = ''; this.title = ''; this.parentElement = null; this.className = ''; }
  get classList() { return { contains: c => this.className.split(' ').includes(c), add: c => { this.className += ' ' + c; },
    remove: c => { this.className = this.className.split(' ').filter(x => x !== c).join(' '); }, toggle: () => {} }; }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  append(...nodes) { for (const n of nodes) { n.remove?.(); n.parentElement = this; this.children.push(n); } }
  prepend(...nodes) { this.append(...nodes); this.children = [...nodes, ...this.children.filter(n => !nodes.includes(n))]; }
  replaceChildren(...nodes) { this.children = []; this.append(...nodes); }
  remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(n => n !== this); this.parentElement = null; }
  contains(node) { for (; node; node = node.parentElement) if (node === this) return true; return false; }
  // Only the attribute selectors the patient tab asks of its own host ('[role=tablist]', '[aria-selected=true]').
  querySelector(selector) {
    const match = /^\[([\w-]+)=([\w-]+)\]$/.exec(selector);
    if (!match) return null;
    for (const child of this.children) {
      if (child.attrs?.[match[1]] === match[2]) return child;
      const found = child.querySelector?.(selector);
      if (found) return found;
    }
    return null;
  }
  get isConnected() { let node = this; while (node.parentElement) node = node.parentElement; return node.tag === 'body'; }
  closest(selector) { return selector === '[data-cy="viewport-pane"]' && this.attrs['data-cy'] === 'viewport-pane' ? this : this.parentElement?.closest(selector) ?? null; }
}

// A synthetic study before and after a Match: the image says TEMPNAME, the matched order says ORDERNAME.
const IMAGE = { StudyInstanceUID: '2.25.11', SeriesInstanceUID: '2.25.11.1', PatientName: { Alphabetic: 'M172^TEMPNAME' }, PatientSex: 'M',
  PatientID: 'SYN-1', PatientBirthDate: '19700101', StudyDate: '20261116', StudyTime: '081000', StudyDescription: 'CT CHEST WO CONTRAST',
  InstitutionName: 'Synthetic Hospital' };
const ROW = { uid: '2.25.11', id: 'SYN-1', name: 'M172 TEMPNAME', birth: '19700101', date: '20261116', sex: 'M', desc: 'CT CHEST WO CONTRAST',
  acc: 'ACC-1', modality: 'CT', sourcePatientKey: 'inst|SYN-1', state: { ov: null } };
const MATCHED = { ...ROW, state: { ov: { id: 'ORD-1', name: 'M172 ORDERNAME', sex: 'F', birth: '1975-02-02', age: 51, desc: 'CT CHEST LOW DOSE', ward: '8W' } } };
const UNREAD = 'M172^TEMPNAME | M | 56Y | SYN-1 | 20261116 081000 | CT CHEST WO CONTRAST | Synthetic Hospital';
const ORDER = 'M172 ORDERNAME | F | 51Y | ORD-1 | 20261116 081000 | CT CHEST LOW DOSE | Synthetic Hospital';

// The viewer document: the shipped display store (as config/ohif.js carries it) and the shipped cell heading.
// The read double serves the requested representation. Both describe the same synthetic studies.
function projection(row) {
  if (row.displaySources) return row;
  const { uid, sourcePatientKey, examScope, sourceMetadata, state } = row;
  const fields = ['id', 'name', 'sex', 'birth', 'date', 'desc', 'modality', 'acc'];
  const displaySources = (examScope?.sources || [{ studyUid: uid, series: { mode: 'all' } }]).map(({ studyUid, series }) => {
    const member = examScope?.kind === 'merge' && studyUid !== uid ? sourceMetadata.find(s => s.uid === studyUid) : null;
    const values = {}, over = [];
    for (const field of fields) {
      const original = member && ['date','desc','acc','modality'].includes(field) ? member : row;
      const replacement = original.state?.ov?.[field] ?? (field === 'acc' ? original.orderAccession : undefined);
      if (typeof replacement === 'string') over.push(field);
      values[field] = replacement ?? original[field] ?? '';
    }
    const b = values.birth.replace(/-/g, ''), d = values.date.replace(/-/g, '');
    values.age = b && d && d >= b ? Math.floor((+d - +b) / 10000) + 'Y' : '';
    return { studyUid, series: { uids: [], ...series }, sourcePatientKey, values: { ...values, over } };
  });
  return { uid, sourcePatientKey, examScope, state: { rs: state?.rs }, displaySources };
}

function world({ answer = () => [ROW], instance = IMAGE, session = null } = {}) {
  const calls = [], clock = { now: Date.UTC(2026, 10, 19) };
  class Clock extends Date {}
  Clock.now = () => clock.now;
  const body = new Element('body'), pane = new Element(); pane.setAttribute('data-cy', 'viewport-pane'); body.append(pane);
  const document = new EventTarget();
  Object.assign(document, { body, createElement: tag => new Element(tag), getElementById: () => null, querySelector: () => null,
    querySelectorAll: selector => selector === '[data-cy="viewport-grid"] [data-cy="viewport-pane"]' ? [pane] : [] });
  const Status = { LOADING: 'loading', PRE_RENDER: 'preRender', RESIZE: 'resize', RENDERED: 'rendered', NO_DATA: 'noData' };
  const image = { imageId: 'frame-1' };
  const viewport = { type: 'stack', viewportStatus: Status.RENDERED, element: (() => { const e = new Element('canvas'); pane.append(e); return e; })(),
    getCurrentImageId: () => 'frame-1', getCornerstoneImage: () => image };
  const set = { displaySetInstanceUID: 'ds-1', StudyInstanceUID: instance.StudyInstanceUID, SeriesInstanceUID: instance.SeriesInstanceUID };
  const state = { layout: { layoutType: 'grid', numRows: 1, numCols: 1 }, viewports: new Map([['A', { displaySetInstanceUIDs: ['ds-1'] }]]) };
  const services = { viewportGridService: { getState: () => state },
    cornerstoneViewportService: { getCornerstoneViewport: id => id === 'A' ? viewport : null },
    displaySetService: { getDisplaySetByUID: id => id === 'ds-1' ? set : undefined } };
  const native = new EventTarget();
  const window = { cornerstone: { eventTarget: native, Enums: { Events: { IMAGE_RENDERED: 'rendered', IMAGE_LOAD_FAILED: 'failed', IMAGE_LOADED: 'loaded' }, ViewportStatus: Status },
    metaData: { get: (type, id) => type === 'instance' && id === 'frame-1' ? instance : undefined }, cache: { getVolume: () => null } } };
  const timers = [];
  window.setInterval = (run, ms) => timers.push({ run, ms });
  const fetch = async (path, options) => {
    if (path.endsWith('/report/versions')) return { ok: true, json: async () => [{ version: 1, action: 'approve', findings: 'Approved text' }] };
    const url = new URL(path, 'https://viewer.test'), uids = url.searchParams.get('uids')?.split(',') || [];
    calls.push({ path: url.pathname, uids, options });
    const rows = await answer(uids, calls.length);
    if (rows === null || typeof rows === 'number') return { ok: false, status: rows || 503, json: async () => ({}) };
    return { ok: true, json: async () => ({ studies: options.headers?.['X-Kin-Viewer-Display'] ? rows.map(projection) : rows }) };
  };
  const context = vm.createContext({ window, document, WeakMap, Map, Set, URL, URLSearchParams, queueMicrotask, setTimeout, clearTimeout, Date: Clock, fetch,
    ...(session ? { kinViewerSession: session } : {}) });
  vm.runInContext(read('config/ohif/study-display.js'), context, { filename: 'study-display.js' });
  vm.runInContext(read('worklist-v0/hpacs-lite/viewer-info-bar.js'), context, { filename: 'viewer-info-bar.js' });
  const bar = window.KinViewerInfoBar.mount({ services, studyActions: { available: () => false, hidden: () => false } });
  document.dispatchEvent(Object.assign(new Event('rendered'), { detail: { viewportId: 'A' } }));
  const heading = () => pane.children.find(n => n.dataset.kinUxOwned !== undefined)?.children[0].textContent;
  return { window, display: window.kinViewerStudyDisplay, bar, heading, calls, context, clock, timers, viewport };
}

// The patient tab of that document (the shipped viewer-patient-tabs.js), opened on the study.
async function tabsOf(w, session = { state: () => 'active', readOnly: () => false }, grid = { viewports: new Map(), layout: {} }, opened = [ROW.uid]) {
  const search = '?StudyInstanceUIDs=' + opened.join(',');
  const location = { origin: 'https://viewer.test', href: 'https://viewer.test/ohif/viewer' + search, search };
  Object.assign(w.context, { location, AbortController, structuredClone, crypto: require('node:crypto').webcrypto, PopStateEvent: Event,
    requestAnimationFrame: fn => queueMicrotask(fn), history: { state: {}, replaceState(_s, _t, href) { location.href = href; } } });
  Object.assign(w.window, { kinViewerFrameCoverageConfirm: () => true, dispatchEvent() {} });
  vm.runInContext(read('worklist-v0/hpacs-lite/viewer-patient-tabs.js'), w.context, { filename: 'viewer-patient-tabs.js' });
  const tabs = w.window.KinViewerPatientTabs;
  const services = { viewportGridService: { getState: () => grid },
    cornerstoneViewportService: { EVENTS: { VIEWPORT_DATA_CHANGED: 'data' }, getCornerstoneViewport: () => w.viewport, subscribe: () => ({ unsubscribe() {} }) } };
  services.displaySetService = { getDisplaySetByUID: uid => ({ StudyInstanceUID: uid, SeriesInstanceUID: uid + '.1' }) };
  await tabs.mount({ services, session, refreshChrome() {} });
  return { tabs, location, patients: () => plain(tabs.list().map(t => t.patient)) };
}

test('after a Match the cell heading shows the order values the worklist shows; after an Unmatch the image values again', async () => {
  let server = MATCHED;
  const w = world({ answer: () => [server] });
  w.bar.refresh();
  // Until the worklist's answer is known the heading is the image's own (as before), with the age counted from its birth date.
  assert.equal(w.heading(), UNREAD);
  await settle();
  assert.deepEqual(w.calls.map(c => [c.path, c.uids]), [['/api/studies', ['2.25.11']]], 'one read of the list endpoint for the shown study');
  assert.equal(w.heading(), ORDER, 'the answer redraws the heading without a new render: name, sex, age (order birth date), ID and description of the order; the study date and time stay the image\'s');
  w.bar.refresh(); await settle();
  assert.equal(w.calls.length, 1, 'a known study is not read again on every repaint');
  server = ROW;                       // Unmatch: the overlay is gone from the row.
  await w.display.refreshAll();
  assert.equal(w.heading(), UNREAD, 'every field the image\'s own again, in its own form');
});

test('the heading age is counted from the birth date and study date; without both it is the image age, else Unknown', async () => {
  const unread = { answer: () => null };   // the list read fails: the heading keeps the image's own values
  const age = async options => { const w = world(options); w.bar.refresh(); await settle(); return w.heading().split(' | ')[2]; };
  assert.equal(await age(unread), '56Y', 'birth 1970-01-01, study 2026-11-16, no Patient\'s Age tag');
  assert.equal(await age({ ...unread, instance: { ...IMAGE, PatientBirthDate: '', PatientAge: '046Y' } }), '046Y');
  assert.equal(await age({ ...unread, instance: { ...IMAGE, PatientBirthDate: '' } }), 'Unknown');
  assert.equal(await age({ ...unread, instance: { ...IMAGE, PatientBirthDate: '20270101' } }), 'Unknown', 'a study date before the birth date is no age');
  assert.equal(await age({ ...unread, instance: { ...IMAGE, PatientBirthDate: '20000231' } }), 'Unknown', 'a birth date that is not a date is no age');
  // A row that replaced nothing leaves the image's birth date and age as they were.
  assert.equal(await age({ answer: () => [{ ...ROW, birth: '' }], instance: { ...IMAGE, PatientAge: '099Y' } }), '56Y');
  // A Match whose order has no birth date: no age, never the image patient's age beside the order patient's name.
  assert.equal(await age({ answer: () => [{ ...MATCHED, state: { ov: { ...MATCHED.state.ov, birth: '' } } }], instance: { ...IMAGE, PatientAge: '056Y' } }), 'Unknown');
});

test('an emptied overlay value is shown empty, not filled from the image', async () => {
  const w = world({ answer: () => [{ ...MATCHED, state: { ov: { ...MATCHED.state.ov, id: '', desc: '' } } }] });
  w.bar.refresh(); await settle();
  assert.equal(w.heading(), 'M172 ORDERNAME | F | 51Y | Unknown | 20261116 081000 | Synthetic Hospital');
});

test('a row whose own Patient ID is not the drawn image\'s is not shown on it', async () => {
  const w = world({ answer: () => [{ ...MATCHED, sourcePatientKey: 'inst|NEW-SOURCE' }] });
  w.bar.refresh(); await settle();
  assert.equal(w.heading(), UNREAD, 'another patient\'s order values never label this image');
  const unkeyed = world({ answer: () => [{ ...MATCHED, sourcePatientKey: null }] });
  unkeyed.bar.refresh(); await settle();
  assert.equal(unkeyed.heading(), UNREAD, 'a row that cannot be tied to the image is not shown on it');
});

test('a read that fails, or a list that no longer has the study, takes back what an older read showed', async () => {
  let answer = () => [MATCHED];
  const w = world({ answer: (...args) => answer(...args) });
  w.bar.refresh(); await settle();
  assert.equal(w.heading(), ORDER);
  answer = () => [];                      // e.g. a tele request withdrawn: the list has no row for it now
  await w.display.refreshAll();
  assert.equal(w.heading(), UNREAD);
  answer = () => [MATCHED]; await w.display.refreshAll(); assert.equal(w.heading(), ORDER);
  answer = () => null;                    // the server refuses (503)
  await w.display.refreshAll();
  assert.equal(w.heading(), UNREAD);
  // Asked again only after a pause, not on every repaint.
  const before = w.calls.length;
  answer = () => [MATCHED];
  w.bar.refresh(); await settle();
  assert.equal(w.calls.length, before, 'no read on the next repaint');
  w.clock.now += 30000; w.bar.refresh(); await settle();
  assert.equal(w.calls.length, before + 1);
  assert.equal(w.heading(), ORDER);
});

test('an answer older than a newer read does not replace it, also when the reads asked different originals', async () => {
  const gates = [];
  const w = world({ answer: (_uids, n) => new Promise(resolve => gates.push(() => resolve([n === 1 ? MATCHED : ROW]))) });
  const first = w.display.refresh(['2.25.11']), second = w.display.refresh(['2.25.11']);
  gates[1](); await second;
  gates[0](); await first;
  assert.equal(w.display.row('2.25.11').name, 'M172 TEMPNAME', 'the later read (Unmatch) stays');
  // A merged exam read once by its base and once by its other original: the newer answer holds for both originals.
  const merged = row => ({ ...row, examScope: { reportUid: '2.25.11', kind: 'merge', sources: [{ studyUid: '2.25.11', series: { mode: 'all' } }, { studyUid: '2.25.12', series: { mode: 'all' } }] },
    sourceMetadata: [{ uid: '2.25.11', date: '20261116', desc: 'CT CHEST WO CONTRAST' }, { uid: '2.25.12', date: '20261116', desc: 'CT ABDOMEN' }] });
  const late = [];
  const m = world({ answer: (_uids, n) => new Promise(resolve => late.push(() => resolve([merged(n === 1 ? MATCHED : ROW)]))) });
  const byBase = m.display.refresh(['2.25.11']), byOther = m.display.refresh(['2.25.12']);
  late[1](); await byOther;
  late[0](); await byBase;
  assert.deepEqual([m.display.of('2.25.11', 's', 'SYN-1').id, m.display.of('2.25.12', 's', 'SYN-1').id], ['SYN-1', 'SYN-1']);
});

test('a merged exam: its other original shows the exam row\'s patient with its own date and description', async () => {
  const row = { ...MATCHED, sourceMetadata: [{ uid: '2.25.11', date: '20261116', desc: 'CT CHEST WO CONTRAST', acc: 'ACC-1', modality: 'CT' },
    { uid: '2.25.12', date: '20261117', desc: 'CT ABDOMEN', acc: 'ACC-2', modality: 'CT' }],
    examScope: { reportUid: '2.25.11', kind: 'merge', sources: [{ studyUid: '2.25.11', series: { mode: 'all' } }, { studyUid: '2.25.12', series: { mode: 'all' } }] } };
  const w = world({ answer: () => [row] });
  await w.display.refresh(['2.25.11', '2.25.12']);
  assert.equal(w.display.of('2.25.11', 'x', 'SYN-1').desc, 'CT CHEST LOW DOSE', 'the exam row itself keeps the order description');
  const other = w.display.of('2.25.12', 'y', 'SYN-1');
  assert.deepEqual([other.name, other.id, other.sex, other.date, other.desc, other.age], ['M172 ORDERNAME', 'ORD-1', 'F', '20261117', 'CT ABDOMEN', '51Y']);
});

test('a split study: each part answers for its own series; a series of neither part shows the image values', async () => {
  const part = (uid, series, base) => ({ ...base, uid, examScope: { reportUid: uid, kind: 'split', sources: [{ studyUid: '2.25.11', series: { mode: 'include', uids: [series] } }] },
    sourceMetadata: [{ uid: '2.25.11', date: '20261116', desc: 'CT CHEST WO CONTRAST' }] });
  const w = world({ answer: () => [part('2.25.11', '2.25.11.1', MATCHED), part('2.25.99', '2.25.11.2', ROW)] });
  await w.display.refresh(['2.25.11']);
  assert.equal(w.display.of('2.25.11', '2.25.11.1', 'SYN-1').id, 'ORD-1', 'the matched part');
  assert.equal(w.display.of('2.25.11', '2.25.11.2', 'SYN-1').id, 'SYN-1', 'the other part keeps its own values');
  assert.equal(w.display.of('2.25.11', '2.25.11.3', 'SYN-1'), null);
  assert.equal(w.display.of('2.25.11', undefined, 'SYN-1'), null, 'a cell whose series is not known');
  w.bar.refresh();
  assert.equal(w.heading(), ORDER, 'the heading of a cell of the matched part');
});

test('a clinician viewer reads the clinician endpoint, names a merged original by its base, and forgets on a role change', async () => {
  let role = 'writer'; const changes = new Set();
  const session = { state: () => role, readOnly: () => role === 'read-only', ended: () => false, decide: async () => role,
    onChange(watch) { changes.add(watch); return () => changes.delete(watch); } };
  const other = '2.25.12';
  const merged = { ...MATCHED, examScope: { kind: 'merge', sources: [ROW.uid, other].map(studyUid => ({ studyUid, series: { mode: 'all' } })) },
    sourceMetadata: [{ uid: other, desc: 'CT ABDOMEN', date: '20261117' }] };
  const w = world({ session, answer: uids => uids.includes(other) ? [merged] : [MATCHED] });
  const { patients } = await tabsOf(w, session);
  assert.equal(w.display.row(ROW.uid).id, 'ORD-1');
  role = 'read-only'; for (const watch of changes) watch(role);
  assert.equal(w.display.row(ROW.uid), null);
  await settle(); await settle();
  assert.equal(w.calls.at(-1).path, '/api/clinician/studies');
  assert.deepEqual(patients(), [{ name: 'M172 ORDERNAME', id: 'ORD-1', age: '51Y', sex: 'F' }]);
  assert.equal(w.display.of(other, 's', 'SYN-1'), null);
  await settle();
  const value = w.display.of(other, 's', 'SYN-1');
  assert.deepEqual([value.name, value.id, value.desc], ['M172 ORDERNAME', 'ORD-1', 'CT ABDOMEN']);
});

test('the patient tab names the order values after a Match and keeps the image patient key', async () => {
  let server = MATCHED;
  const w = world({ answer: () => [server] });
  const { tabs, location, patients } = await tabsOf(w);
  assert.deepEqual(patients(), [{ name: 'M172 ORDERNAME', id: 'ORD-1', age: '51Y', sex: 'F' }]);
  assert.equal(tabs.snapshot().key, 'inst|SYN-1', 'the tab stays the image patient (no tab moves on a Match)');
  assert.equal(w.display.of('2.25.11', '2.25.11.1', 'SYN-1').name, 'M172 ORDERNAME', 'the cell headings start from the rows the tab read');
  // Opened again from the list after an Unmatch: the same tab, read again, names the image values.
  server = ROW;
  assert.equal(await tabs.open(location.href), true); await settle(); await settle();
  assert.deepEqual(patients(), [{ name: 'M172 TEMPNAME', id: 'SYN-1', age: '56Y', sex: 'M' }]);
});

test('a first tab lookup that fails is asked again after a pause', async () => {
  let fail = true;
  const w = world({ answer: () => fail ? null : [MATCHED] });
  await tabsOf(w);
  const before = w.calls.length;
  fail = false;
  w.bar.refresh(); await settle();
  assert.equal(w.calls.length, before, 'not on the next repaint');
  w.clock.now += 30000; w.bar.refresh(); await settle();
  assert.equal(w.calls.length, before + 1);
  assert.equal(w.heading(), ORDER);
});

function priorsOf(w, studyUid = ROW.uid) {
  Object.assign(w.context, { AbortController });
  w.window.KinSessionTransport = { refusal: () => false, responseError: () => new Error('ended') };
  vm.runInContext(read('worklist-v0/hpacs-lite/viewer-prior-controller.js'), w.context);
  const value = { patientKey: 'inst|SYN-1', sequence: 1, viewportId: 'A', studyUid, seriesUid: IMAGE.SeriesInstanceUID, displaySetUid: 'ds-1', mode: 'stack' };
  const lists = [], reports = [];
  const viewer = { viewport: () => value, snapshot: () => ({ key: value.patientKey, sequence: 1, studyUIDs: [studyUid] }), subscribe: () => () => {} };
  const controller = w.window.KinViewerPriorController.create({ viewer, loadStudy: async () => [],
    onList: v => lists.push(v), onReport: v => reports.push(v) });
  return { value, lists, reports, controller };
}
test('the prior list (Study menu, Previous Report) names each study as the worklist does', async () => {
  const prior = { ...ROW, uid: '2.25.5', date: '20250101', state: { ov: { id: 'ORD-0', name: 'M172 OLDORDER', desc: 'CT CHEST OLD ORDER' } } };
  const w = world({ answer: () => [MATCHED, prior] });
  const { value, lists, controller } = priorsOf(w);
  await controller.open(value);
  assert.deepEqual(plain(lists.at(-1).studies.map(s => [s.uid, s.relation, s.name, s.id, s.desc])),
    [[ROW.uid, 'Current', 'M172 ORDERNAME', 'ORD-1', 'CT CHEST LOW DOSE'], [prior.uid, 'Prior', 'M172 OLDORDER', 'ORD-0', 'CT CHEST OLD ORDER']]);
});
test('the patient tab lookup is the opening\'s one read; another opening reads only its own studies', async () => {
  const gates = [];
  const w = world({ answer: uids => new Promise(resolve => gates.push(() => resolve(uids.map(uid => uid === '2.25.11' ? MATCHED
    : { ...ROW, uid, sourcePatientKey: 'inst|SYN-2', id: 'SYN-2' })))) });
  const opening = tabsOf(w);
  w.bar.refresh(); await settle(); w.bar.refresh(); await settle();
  assert.equal(w.calls.length, 1, 'the heading waits for the tab lookup instead of reading the study itself');
  gates[0](); const { tabs } = await opening; await settle();
  assert.equal(w.heading(), ORDER);
  const before = w.calls.length;
  const switched = tabs.open('https://viewer.test/ohif/viewer?StudyInstanceUIDs=2.25.77'); await settle();
  gates.at(-1)(); assert.equal(await switched, true); await settle();
  assert.deepEqual(w.calls.slice(before).map(c => c.uids), [['2.25.77']], 'one lookup, of the new study only');
});
test('an unchanged DICOM name keeps its original representation in the viewer', () => {
  const { display } = world(), image = { name: '이름^원본' };
  assert.equal(display.view(projection({ ...ROW, name: '' }).displaySources[0].values, image).name, image.name);
  assert.equal(display.view(null, image).name, image.name);
});

for (const refusal of ['empty', 403, 503]) test('a later ' + refusal + ' prevents a delayed success from relabeling the image or tab', async () => {
  let release, answer = () => [MATCHED];
  const w = world({ answer: () => answer() });
  const { tabs } = await tabsOf(w);
  w.bar.refresh();
  answer = () => new Promise(resolve => { release = resolve; });
  const older = w.display.refresh([ROW.uid]);
  answer = () => refusal === 'empty' ? [] : refusal;
  await w.display.refresh([ROW.uid]);
  release([{ ...MATCHED, state: { ...MATCHED.state, revision: 99 } }]); await older;
  assert.equal(w.heading(), UNREAD);
  assert.equal(tabs.snapshot().key, ROW.sourcePatientKey);
  assert.equal(tabs.snapshot().patient.id, 'Unknown');
});

test('role changes during the first lookup discard its patient tab', async () => {
  let role = 'writer', change, release;
  const session = { state: () => role, readOnly: () => role === 'read-only', onChange(fn) { change = fn; } };
  const w = world({ session, answer: () => role === 'writer' ? new Promise(resolve => { release = resolve; }) : [] });
  const mounted = tabsOf(w, session); await settle();
  role = 'read-only'; change(role);
  release([MATCHED]); const { tabs } = await mounted;
  assert.equal(tabs.snapshot(), null);
  assert.equal(w.display.row(ROW.uid), null);
});

test('the same UID with another original patient key cannot rename the open tab or its pixels', async () => {
  let server = MATCHED;
  const w = world({ answer: () => [server] });
  const { tabs, location } = await tabsOf(w);
  w.bar.refresh();
  server = { ...MATCHED, sourcePatientKey: 'other-institution|SYN-1', state: { ov: { name: 'OTHER', id: 'OTHER-ID' } } };
  await tabs.open(location.href); await settle();
  assert.equal(tabs.snapshot().key, ROW.sourcePatientKey);
  assert.equal(tabs.snapshot().patient.name, 'Unknown');
  assert.equal(w.heading(), UNREAD);
});

test('the clinician split answer never labels the excluded series or fills an explicit blank', async () => {
  const source = { studyUid: ROW.uid, series: { mode: 'exclude', uids: ['excluded'] } };
  const blank = { ...MATCHED, state: { ov: { ...MATCHED.state.ov, birth: '', desc: '', sex: '' } } };
  const values = projection(blank).displaySources[0].values;
  const result = { ...ROW, ...values, state: undefined, exam: { scope: { sources: [source] } },
    displaySources: [{ ...source, values, sourcePatientKey: ROW.sourcePatientKey }] };
  const session = { state: () => 'read-only', readOnly: () => true };
  const w = world({ answer: () => [result], session, instance: { ...IMAGE, PatientAge: '056Y' } });
  await tabsOf(w, session); w.bar.refresh();
  assert.equal(w.display.of(ROW.uid, 'excluded', ROW.id), null);
  assert.equal(w.heading(), 'M172 ORDERNAME | Unknown | Unknown | ORD-1 | 20261116 081000 | Synthetic Hospital');
});

test('a standalone member becomes part of one merged exam on re-query', async () => {
  const member = { ...ROW, uid: '2.25.12', date: '20251115' };
  let server = member;
  const w = world({ answer: () => [server] });
  await w.display.refresh([member.uid]);
  assert.equal(w.display.of(member.uid, 'member-series', ROW.id).id, ROW.id);
  const menu = priorsOf(w, member.uid);
  await menu.controller.open(menu.value);
  assert.equal(menu.lists.at(-1).studies[0].uid, member.uid);
  server = { ...MATCHED, examScope: { kind: 'merge', sources: [ROW.uid, member.uid].map(studyUid => ({ studyUid, series: { mode: 'all' } })) },
    sourceMetadata: [ROW, member] };
  await w.display.refresh([member.uid]);
  const shown = w.display.of(member.uid, 'member-series', ROW.id);
  assert.deepEqual([shown?.id, shown?.age, shown?.date], ['ORD-1', '50Y', member.date]);
  assert.deepEqual(plain(menu.lists.at(-1).studies.map(study => [study.uid, study.id, study.relation])),
    [[ROW.uid, 'ORD-1', 'Current']]);
  const joined = world({ answer: () => [server] });
  const studyUids = [ROW.uid, member.uid];
  joined.window.kinPrepareExamViewer = async () => ({ key: 'joined', reportUid: ROW.uid, studyUids, current: server.examScope });
  const { tabs } = await tabsOf(joined, undefined, undefined, studyUids);
  assert.deepEqual(plain(tabs.list().map(tab => tab.studies)), [studyUids]);
  assert.deepEqual(joined.calls.map(call => call.uids), [studyUids]);
});

test('the first tab lookup and both already rendered exams share one request', async () => {
  const prior = { ...MATCHED, uid: '2.25.12' };
  const grid = { viewports: new Map([ROW.uid, prior.uid].map(uid => [uid, { displaySetInstanceUIDs: [uid] }])), layout: {} };
  const w = world({ answer: ids => [MATCHED, prior].filter(row => ids.includes(row.uid)) });
  const opening = tabsOf(w, undefined, grid);
  w.bar.refresh();
  w.display.of(prior.uid, 'prior-series', ROW.id);
  const { tabs } = await opening;
  await settle();
  assert.equal(tabs.snapshot().patient.id, 'ORD-1');
  assert.equal(w.display.of(prior.uid, 'prior-series', ROW.id).id, 'ORD-1');
  assert.deepEqual(w.calls.map(call => call.uids), [[ROW.uid, prior.uid]]);
});

test('returning to a saved patient tab reads its added comparison with the opening once', async () => {
  const prior = { ...MATCHED, uid: '2.25.12' }, next = { ...ROW, uid: '2.25.77', id: 'SYN-2', sourcePatientKey: 'inst|SYN-2' };
  const data = new Map([MATCHED, prior, next].map(row => [row.uid, row]));
  const grid = { viewports: new Map(), layout: { layoutType: 'grid', numRows: 1, numCols: 2 } };
  const w = world({ answer: ids => ids.map(id => data.get(id)) });
  const { tabs, location } = await tabsOf(w, undefined, grid);
  const href = location.href;
  for (const row of [ROW, prior]) grid.viewports.set(row.uid, { viewportId: row.uid, displaySetInstanceUIDs: [row.uid] });
  await w.display.refresh([prior.uid]);
  assert.equal(await tabs.open(href.replace(ROW.uid, next.uid)), true);
  data.set(prior.uid, { ...prior, state: { ov: null } });
  const before = w.calls.length;
  assert.equal(await tabs.open(href), true);
  assert.deepEqual(w.calls.slice(before).map(call => call.uids), [[ROW.uid, prior.uid]]);
  assert.equal(w.display.of(prior.uid, 'prior-series', ROW.id).id, ROW.id);
});

test('a refresh while the next image loads recomputes the last rendered heading', async () => {
  let server = [MATCHED];
  const w = world({ answer: () => server });
  w.bar.refresh(); await settle(); assert.equal(w.heading(), ORDER);
  w.viewport.viewportStatus = 'loading'; w.bar.refresh();
  assert.equal(w.heading(), ORDER);
  server = []; await w.display.refreshAll();
  assert.equal(w.heading(), UNREAD);
});

test('the 30 second refresh updates an added prior and the report already open for it', async () => {
  const prior = { ...MATCHED, uid: '2.25.5', date: '20250101', orderAccession: 'ORDER-ACC' };
  let server = [MATCHED, prior];
  const w = world({ answer: ids => server.filter(row => !ids.length || ids.includes(row.uid)) });
  const { tabs } = await tabsOf(w), { value, lists, reports, controller } = priorsOf(w);
  await controller.open(value); await controller.openReport(prior.uid);
  assert.equal(reports.at(-1).study.acc, 'ORDER-ACC');
  assert.equal(lists.at(-1).studies.find(s => s.uid === prior.uid).acc, 'ORDER-ACC');
  server = [ROW, { ...prior, state: { ov: null }, orderAccession: null }];
  w.clock.now += 30000;
  for (const timer of w.timers) if (timer.ms === 30000) timer.run();
  await settle();
  assert.deepEqual(new Set(w.calls.at(-1).uids), new Set([ROW.uid, prior.uid]));
  assert.equal(tabs.snapshot().patient.id, ROW.id);
  assert.deepEqual([reports.at(-1).study.name, reports.at(-1).study.acc, reports.at(-1).report.findings],
    [ROW.name, ROW.acc, 'Approved text']);
  assert.equal(lists.at(-1).studies.find(s => s.uid === prior.uid).id, ROW.id);
  server = [ROW]; await w.display.refreshAll();
  assert.equal(reports.at(-1).state, 'closed');
});
