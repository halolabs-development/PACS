// The patient and examination a study is shown as in the viewer (config/ohif/study-display.js): the worklist's answer
// for that study — its list row with the Match / Modify display overlay (state.ov) over it. The cell heading
// (viewer-info-bar.js) and the patient tab (viewer-patient-tabs.js) read that one answer; the cell label is covered by
// tests/viewer_study_display_dom_test.py. A Match shows the order's values in the viewer, an Unmatch the image's own
// values again, and the age is counted from the shown birth date and study date.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');

const settle = () => new Promise(resolve => setImmediate(resolve));
const read = path => fs.readFileSync(path, 'utf8');

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

// The viewer document: the shipped display store (as config/ohif.js carries it) and the shipped cell heading.
function world({ answer = () => [ROW], instance = IMAGE, session = null } = {}) {
  const calls = [];
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
  const fetch = async (path, options) => {
    const url = new URL(path, 'https://viewer.test'), uids = url.searchParams.get('uids').split(',');
    calls.push({ path: url.pathname, uids, options });
    const rows = await answer(uids, calls.length);
    if (rows === null) return { ok: false, json: async () => ({}) };
    return { ok: true, json: async () => ({ studies: rows }) };
  };
  const context = vm.createContext({ window, document, WeakMap, Map, Set, URL, URLSearchParams, queueMicrotask, setTimeout, clearTimeout, Date, fetch,
    ...(session ? { kinViewerSession: session } : {}) });
  vm.runInContext(read('config/ohif/study-display.js'), context, { filename: 'study-display.js' });
  vm.runInContext(read('worklist-v0/hpacs-lite/viewer-info-bar.js'), context, { filename: 'viewer-info-bar.js' });
  const bar = window.KinViewerInfoBar.mount({ services, studyActions: { available: () => false, hidden: () => false } });
  document.dispatchEvent(Object.assign(new Event('rendered'), { detail: { viewportId: 'A' } }));
  const heading = () => pane.children.find(n => n.dataset.kinUxOwned !== undefined)?.children[0].textContent;
  return { window, display: window.kinViewerStudyDisplay, bar, heading, calls, context };
}

test('after a Match the cell heading shows the order values the worklist shows; after an Unmatch the image values again', async () => {
  let server = MATCHED;
  const w = world({ answer: () => [server] });
  w.bar.refresh();
  // Until the worklist's answer is known the heading is the image's own (as before), with the age counted from its birth date.
  assert.equal(w.heading(), 'M172^TEMPNAME | M | 56Y | SYN-1 | 20261116 081000 | CT CHEST WO CONTRAST | Synthetic Hospital');
  await settle();
  assert.deepEqual(w.calls.map(c => [c.path, c.uids]), [['/api/studies', ['2.25.11']]], 'one read of the list endpoint for the shown study');
  assert.equal(w.heading(), 'M172 ORDERNAME | F | 51Y | ORD-1 | 20261116 081000 | CT CHEST LOW DOSE | Synthetic Hospital',
    'the answer redraws the heading without a new render: name, sex, age (order birth date), ID and description of the order');
  w.bar.refresh(); await settle();
  assert.equal(w.calls.length, 1, 'a known study is not read again on every repaint');
  server = ROW;                       // Unmatch: the overlay is gone from the row.
  await w.display.refresh(['2.25.11']);
  assert.equal(w.heading(), 'M172 TEMPNAME | M | 56Y | SYN-1 | 20261116 081000 | CT CHEST WO CONTRAST | Synthetic Hospital');
});

test('the heading age is counted from the birth date and study date; without both it is the image age, else Unknown', async () => {
  const unread = { answer: () => null };   // the list read fails: the heading keeps the image's own values
  let w = world(unread); w.bar.refresh(); await settle();
  assert.equal(w.heading().split(' | ')[2], '56Y', 'birth 1970-01-01, study 2026-11-16, no Patient\'s Age tag');
  w = world({ ...unread, instance: { ...IMAGE, PatientBirthDate: '', PatientAge: '046Y' } }); w.bar.refresh(); await settle();
  assert.equal(w.heading().split(' | ')[2], '046Y');
  w = world({ ...unread, instance: { ...IMAGE, PatientBirthDate: '' } }); w.bar.refresh(); await settle();
  assert.equal(w.heading().split(' | ')[2], 'Unknown');
  w = world({ ...unread, instance: { ...IMAGE, PatientBirthDate: '20270101' } }); w.bar.refresh(); await settle();
  assert.equal(w.heading().split(' | ')[2], 'Unknown', 'a study date before the birth date is no age');
  // A row without a birth date: the image age, never an age counted from another birth date.
  w = world({ answer: () => [{ ...ROW, birth: '' }], instance: { ...IMAGE, PatientAge: '056Y' } }); w.bar.refresh(); await settle();
  assert.equal(w.heading().split(' | ')[2], '056Y');
});

test('a failed read keeps the image values and is asked again only after a pause', async () => {
  const w = world({ answer: () => null });
  w.bar.refresh(); await settle(); w.bar.refresh(); await settle();
  assert.equal(w.calls.length, 1);
  assert.equal(w.heading().split(' | ')[0], 'M172^TEMPNAME');
});

test('an answer older than a newer read of the same study does not replace it', async () => {
  const gates = [];
  const w = world({ answer: (_uids, n) => new Promise(resolve => gates.push(() => resolve([n === 1 ? MATCHED : ROW]))) });
  const first = w.display.refresh(['2.25.11']), second = w.display.refresh(['2.25.11']);
  gates[1](); await second;
  gates[0](); await first;
  assert.equal(w.display.peek('2.25.11').name, 'M172 TEMPNAME', 'the later read (Unmatch) stays');
});

test('a merged exam: its other original shows the exam row\'s patient with its own date and description', async () => {
  const row = { ...MATCHED, sourceMetadata: [{ uid: '2.25.11', date: '20261116', desc: 'CT CHEST WO CONTRAST', acc: 'ACC-1', modality: 'CT' },
    { uid: '2.25.12', date: '20261117', desc: 'CT ABDOMEN', acc: 'ACC-2', modality: 'CT' }] };
  const w = world({ answer: () => [row] });
  await w.display.refresh(['2.25.11', '2.25.12']);
  assert.equal(w.display.peek('2.25.11').desc, 'CT CHEST LOW DOSE', 'the exam row itself keeps the order description');
  const other = w.display.peek('2.25.12');
  assert.deepEqual([other.name, other.id, other.sex, other.date, other.desc, other.age], ['M172 ORDERNAME', 'ORD-1', 'F', '20261117', 'CT ABDOMEN', '51Y']);
});

test('a clinician viewer reads the clinician endpoint, and a role change forgets what was read', async () => {
  let role = 'writer'; const changes = new Set();
  const session = { state: () => role, readOnly: () => role === 'read-only', ended: () => false, decide: async () => role,
    onChange(watch) { changes.add(watch); return () => changes.delete(watch); } };
  const w = world({ session, answer: () => [MATCHED] });
  await w.display.refresh(['2.25.11']);
  assert.equal(w.display.peek('2.25.11').id, 'ORD-1');
  role = 'read-only'; for (const watch of changes) watch(role);
  assert.equal(w.display.peek('2.25.11'), null);
  await w.display.refresh(['2.25.11']);
  assert.equal(w.calls.at(-1).path, '/api/clinician/studies');
});

test('the overlay keys are the worklist\'s and the server\'s', () => {
  const w = world();
  const list = JSON.parse(/const OVERLAY_KEYS = (\[[^\]]*\]);/.exec(read('worklist-v0/hpacs-lite/study-state.js'))[1]);
  const server = /export const OVERLAY_KEYS = \[([^\]]*)\]/.exec(read('api/src/study-identity.ts'))[1].split(',').map(s => s.trim().replace(/'/g, ''));
  assert.deepEqual([...w.display.keys], list);
  assert.deepEqual([...w.display.keys], server);
  // Only an own string (age: a finite number) replaces a row value, as worklist-data.js applyState does.
  const shown = w.display.shown({ ...ROW, state: { ov: { name: 7, id: ['x'], desc: '', sex: null } } });
  assert.deepEqual([shown.name, shown.id, shown.desc, shown.sex], ['M172 TEMPNAME', 'SYN-1', '', 'M']);
});

test('the patient tab names the order values after a Match and keeps the image patient key', async () => {
  let server = MATCHED;
  const w = world({ answer: () => [server] });
  const location = { origin: 'https://viewer.test', href: 'https://viewer.test/ohif/viewer?StudyInstanceUIDs=2.25.11', search: '?StudyInstanceUIDs=2.25.11' };
  Object.assign(w.context, { location, AbortController, structuredClone, crypto: require('node:crypto').webcrypto, PopStateEvent: Event,
    requestAnimationFrame: fn => queueMicrotask(fn), history: { state: {}, replaceState(_s, _t, href) { location.href = href; } } });
  Object.assign(w.window, { kinViewerFrameCoverageConfirm: () => true, dispatchEvent() {} });
  vm.runInContext(read('worklist-v0/hpacs-lite/viewer-patient-tabs.js'), w.context, { filename: 'viewer-patient-tabs.js' });
  const tabs = w.window.KinViewerPatientTabs;
  const services = { viewportGridService: { getState: () => ({ viewports: new Map(), layout: {} }) },
    cornerstoneViewportService: { EVENTS: { VIEWPORT_DATA_CHANGED: 'data' }, getCornerstoneViewport: () => null, subscribe: () => ({ unsubscribe() {} }) } };
  await tabs.mount({ services, session: { state: () => 'active', readOnly: () => false }, refreshChrome() {} });
  assert.deepEqual(JSON.parse(JSON.stringify(tabs.list().map(t => t.patient))), [{ name: 'M172 ORDERNAME', id: 'ORD-1', age: '51Y', sex: 'F' }]);
  assert.equal(tabs.snapshot().key, 'inst|SYN-1', 'the tab stays the image patient (no tab moves on a Match)');
  assert.equal(w.display.peek('2.25.11').name, 'M172 ORDERNAME', 'the cell headings start from the rows the tab read');
  // Opened again from the list after an Unmatch: the same tab, read again, names the image values.
  server = ROW;
  assert.equal(await tabs.open(location.href), true); await settle(); await settle();
  assert.deepEqual(JSON.parse(JSON.stringify(tabs.list().map(t => t.patient))), [{ name: 'M172 TEMPNAME', id: 'SYN-1', age: '56Y', sex: 'M' }]);
});
