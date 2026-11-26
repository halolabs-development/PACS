// D-MEASURE2 A1/A2/C1/C2/C5: mount the production extension with in-memory
// transport and DOM ports. No copied state machine, containers or browser.
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { readFileSync } = require('node:fs');
const { webcrypto } = require('node:crypto');
const source = readFileSync(require.resolve('../config/ohif.js'), 'utf8');
const gates = require('../worklist-v0/hpacs-lite/work-context.js');
const transports = require('../worklist-v0/hpacs-lite/session-transport.js');
class Element extends EventTarget {
  constructor(tag) { super(); this.tagName = tag; this.children = []; this.style = {}; this.dataset = {}; this.attributes = {}; this.textContent = ''; }
  append(...children) { for (const c of children) { c.parent = this; this.children.push(c); } }
  replaceChildren(...children) { for (const c of this.children) c.parent = null; this.children = []; this.append(...children); }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(c => c !== this); this.parent = null; }
  setAttribute(k, v) { this.attributes[k] = v; }
  get isConnected() { return this.tagName === 'body' || !!this.parent?.isConnected; }
  all() { return [this, ...this.children.flatMap(c => c.all())]; }
  // The history scan also reads the toolbar's Capture entries (U7A output meaning); this isolated panel has none.
  querySelectorAll(selector) {
    if (selector === '[data-tool="Capture"]') return this.all().filter(e => e.dataset.tool === 'Capture');
    assert.equal(selector, '[data-kin-sr]'); return this.all().filter(e => e.dataset.kinSr);
  }
  click() { if (!this.disabled) this.dispatchEvent(new Event('click')); }
}
const flush = async () => { for (let i = 0; i < 12; i++) await new Promise(setImmediate); };
const copy = x => JSON.parse(JSON.stringify(x));
const head = (id = 'a', revision = 1, title = 'server', hidden = false) => ({ id, revision, hidden,
  authorSub: 'doctor', authorActor: 'Doctor', referenceStatus: 'verified', item: {
    schemaVersion: 1, kind: 'key', seriesUid: '1.2', sopUid: '1.3', frame: 1, title, description: '', hidden, sourceDigest: 'digest',
  } });
async function harness() {
  const document = new EventTarget(); document.body = new Element('body'); document.createElement = tag => new Element(tag);
  document.createTextNode = value => { const node = new Element('#text'); node.textContent = value; return node; };
  document.querySelectorAll = selector => document.body.querySelectorAll(selector);
  const window = new EventTarget(), annotations = new Map(), commands = new Map();
  const gate = gates.create(); let announce;
  gate.follow({ onLifecycle(listener) { announce = listener; listener({ state: 'active', session: 'S1' }); } });
  window.KinWorkContext = gate;
  // This suite isolates the history panel; the real document controller is exercised in Chromium.
  window.KinViewerSessionBoundary = { active: () => gate.state() === 'active', ended: () => gate.state() === 'ending' };
  let study = '1', tick, me = { sub: 'doctor', kind: 'member', roles: ['radiologist'] };
  const calls = [], notices = [], dialogs = [], pages = new Map([['1', [head()]], ['2', [head('b')]]]);
  let reply = async (path, options) => {
    if (path === '/api/me') return me.sub === 'doctor' ? { status: 200, data: me }
      : { status: 409, data: { code: 'AUTH_SESSION_MISMATCH' } };
    const uid = path.match(/\/studies\/([^/]+)/)?.[1];
    if (options.method === 'POST') return { status: 409, data: {} };
    return { status: 200, data: { items: copy(pages.get(uid) || []), nextCursor: null } };
  };
  // The renderer's index (getCurrentImageId) moves to a requested frame when its load starts and stays there when the load
  // fails; the image on the screen (getCornerstoneImage) stays the one before until the new one arrives. `frames` sets the
  // two apart; `volumeCell` makes the cell a volume (MPR) cell, which has no loaded-image read.
  let requested = 1, shown = 1;
  const imageId = frame => `/studies/${study}/series/1.2/instances/1.3/frames/${frame}`;
  const viewport = { type: 'stack', viewportStatus: 'rendered', getCurrentImageId: () => imageId(requested),
    getCornerstoneImage: () => shown ? { imageId: imageId(shown) } : undefined, render() {} };
  window.cornerstone = { Enums: { Events: { STACK_NEW_IMAGE: 'image' } }, metaData: { get() {} } };
  window.cornerstoneTools = { annotation: { locking: { setAnnotationLocked() {}, isAnnotationLocked: () => true },
    state: { getAnnotation: uid => annotations.get(uid), getAllAnnotations: () => [...annotations.values()], removeAnnotation: uid => annotations.delete(uid) } },
    ToolGroupManager: { getToolGroupForViewport() {} } };
  window.confirm = message => { dialogs.push(message); return window.answer; };
  window.prompt = () => 'test reason';
  const measurements = new Map();
  const services = {
    cornerstoneViewportService: { getCornerstoneViewport: () => viewport },
    viewportGridService: { getActiveViewportId: () => 'viewport', EVENTS: {} },
    measurementService: { getMeasurements: () => [...measurements.values()], getMeasurement: uid => measurements.get(uid), remove: uid => measurements.delete(uid), update() {} },
    uiNotificationService: { show: x => notices.push(x) },
  };
  for (const name of ['downloadReport', 'storeMeasurements']) commands.set(name, { commandFn: () => { throw new Error('native SR must not run'); } });
  const transport = transports.create({ gate, authFailure: failure => announce({ state: 'ending', session: failure.session }),
    fetch: async (path, options) => {
      calls.push({ path, options }); const r = await reply(path, options);
      return new Response(JSON.stringify(r.data), { status: r.status, headers: r.data?.code ? { 'X-KIN-Auth-Code': r.data.code } : {} });
    } });
  window.KinSessionTransport = transports;
  vm.runInNewContext(source, { window, document, crypto: webcrypto, TextEncoder, console, Event, AbortController,
    setInterval: fn => { tick = fn; return 1; }, clearInterval() {}, setTimeout, clearTimeout,
    fetch: transport.fetch,
  });
  const extension = window.config.extensions.find(e => e.id === 'kin.viewer-history');
  extension.preRegistration({ servicesManager: { services }, commandsManager: {
    getCommand: name => commands.get(name), registerCommand: (_, name, command) => commands.set(name, command),
  } });
  extension.onModeEnter(); await flush();
  const all = () => document.body.all();
  const button = name => { const found = all().filter(e => e.tagName === 'button' && e.textContent === name); assert.equal(found.length, 1, `button ${name}: ${found.length}`); return found[0]; };
  return { window, document, viewport, pages, calls, commands, measurements, annotations, notices, dialogs, extension, services,
    setReply: f => { reply = f; }, defaultReply: reply, setMe: value => { me = value; },
    button, click: async name => { button(name).click(); await flush(); },
    input: (label, value) => { const e = all().find(e => e.attributes['aria-label'] === label && !e.disabled); assert.ok(e, label); e.value = value; e.dispatchEvent(new Event('input')); },
    values: () => all().filter(e => e.tagName === 'input').map(e => e.value),
    text: () => all().map(e => e.textContent).join('\n'),
    switch: async uid => { study = uid; tick(); await flush(); },
    frames: (now, onScreen) => { requested = now; shown = onScreen; },
    // The volume holds frames 1-6 as axial slices 2 mm apart (frame N at z = 2(N - 1)); `mpr.offset` puts the plane that far
    // past the named slice, `mpr.normal` is the plane's normal, `mpr.loaded` and `mpr.framesLoaded` are the volume's load
    // state. Each slice is 512 x 512 pixels of 0.5 mm.
    volumeCell: () => {
      delete viewport.getCornerstoneImage;
      const mpr = { offset: 0, normal: [0, 0, 1], loaded: true, framesLoaded: 6 }, ids = [1, 2, 3, 4, 5, 6].map(imageId);
      const z = id => 2 * (Number(/frames\/(\d+)$/.exec(id)?.[1]) - 1);
      viewport.type = 'orthographic'; delete viewport.viewportStatus;
      viewport.getVolumeId = () => 'volume';
      viewport.getCamera = () => ({ focalPoint: [128, 128, z(viewport.getCurrentImageId()) + mpr.offset], viewPlaneNormal: mpr.normal });
      window.cornerstone.cache = { getVolume: id => id === 'volume' ? { imageIds: ids, framesLoaded: mpr.framesLoaded, loadStatus: { loaded: mpr.loaded } } : undefined };
      window.cornerstone.metaData.get = (kind, id) => kind === 'imagePlaneModule' && ids.includes(id)
        ? { rowCosines: [1, 0, 0], columnCosines: [0, 1, 0], imagePositionPatient: [0, 0, z(id)], rows: 512, columns: 512, rowPixelSpacing: 0.5, columnPixelSpacing: 0.5 } : undefined;
      return mpr;
    },
    tick: async () => { tick(); await flush(); },
    logout: () => announce({ state: 'ending', session: 'S1' }),
  };
}

test('A1 (5): A→B→A keeps edited and held work, explicit resume and cancel are inert', async () => {
  const h = await harness();
  await h.click('Edit'); h.input('Key Title', 'my A');
  await h.switch('2'); assert.doesNotMatch(h.text(), /my A/);
  assert.equal(h.window.kinViewerHistoryHasUnsaved(), true);
  assert.equal(h.window.dispatchEvent(new Event('beforeunload', { cancelable: true })), false);
  await h.click('Edit'); h.input('Key Title', 'my B');
  await h.switch('1'); assert.doesNotMatch(h.text(), /my B/); assert.equal(h.values().length, 0);
  h.window.answer = false; await h.click('Discard Held Work');
  await h.click('Resume Held Work'); assert.ok(h.values().includes('my A'));
  h.pages.set('1', [head('a', 2, 'hidden server', true)]);
  await h.click('Save'); await h.click('Use Latest & Keep Changes');
  assert.match(h.text(), /my A/);
  await h.switch('2'); await h.click('Resume Held Work'); assert.ok(h.values().includes('my B'));
  await h.switch('1'); await h.click('Resume Held Work'); assert.match(h.text(), /my A/);
  h.logout(); assert.equal(h.window.kinViewerHistoryHasUnsaved(), false); assert.doesNotMatch(h.text(), /my [AB]/);
});

test('A2 (6): busy-only hide conflict does not invent local edits or roll back latest content', async () => {
  const h = await harness(); h.pages.set('1', [head('a', 2, 'new hidden server', true)]);
  await h.click('Hide'); await h.click('Use Latest & Keep Changes');
  assert.doesNotMatch(h.text(), /Held Changes/); assert.equal(h.window.kinViewerHistoryHasUnsaved(), false);
  assert.match(h.text(), /new hidden server/);
  h.setReply(async (path, options) => options.method === 'POST' ? { status: 200, data: head('a', 3, 'new hidden server') } : h.defaultReply(path, options));
  await h.click('Restore');
  const body = JSON.parse(h.calls.filter(c => c.options.method === 'POST').at(-1).options.body);
  assert.equal(body.item.title, 'new hidden server'); assert.equal(h.values().length, 0);
});

test('C1 (7): discard states revision adoption, cancellation changes neither copy', async () => {
  const h = await harness(); await h.click('Edit'); h.input('Key Title', 'local');
  h.pages.set('1', [head('a', 2, 'hidden', true)]); await h.click('Save'); await h.click('Use Latest & Keep Changes');
  h.window.answer = false; await h.click('Discard Held Changes');
  assert.match(h.dialogs.at(-1), /서버판 r2.*채택/); assert.match(h.text(), /local/);
  const count = h.calls.filter(c => c.options.method === 'POST').length;
  h.window.answer = true; await h.click('Discard Held Changes'); assert.doesNotMatch(h.text(), /local/);
  assert.equal(h.calls.filter(c => c.options.method === 'POST').length, count);
});

test('C5 (4): study 403 quarantines its pending bytes, preserves other drafts, reauthorizes before resume', async () => {
  const h = await harness(); await h.click('Edit'); h.input('Key Title', 'private A'); await h.switch('2');
  await h.click('Edit'); h.input('Key Title', 'private B');
  h.setReply(async (path, options) => path.includes('/studies/2/') ? { status: 403, data: {} } : h.defaultReply(path, options));
  await h.click('Save'); assert.doesNotMatch(h.text(), /private [AB]|server/);
  assert.match(h.text(), /접근할 수 없습니다/); assert.equal(h.window.kinViewerHistoryHasUnsaved(), true);
  await h.click('Recheck Access'); assert.doesNotMatch(h.text(), /private B/);
  await h.switch('1'); await h.click('Resume Held Work'); assert.ok(h.values().includes('private A'));
  h.setReply(h.defaultReply); await h.switch('2'); assert.doesNotMatch(h.text(), /private B/);
  await h.click('Resume Held Work'); assert.ok(h.values().includes('private B'));
  const pending = h.calls.find(c => c.options.method === 'POST').options.body;
  await h.click('Retry Request'); assert.equal(h.calls.filter(c => c.options.method === 'POST').at(-1).options.body, pending);
});

test('A1/C5: late committed create cannot cross A→B→A; same UUID retry coalesces loaded server row', async () => {
  const h = await harness(); h.pages.set('1', []); await h.click('Refresh');
  await h.click('Add Key Image'); h.input('Key Title', 'new A');
  let release; h.setReply(async (path, options) => options.method === 'POST' ? new Promise(resolve => { release = resolve; }) : h.defaultReply(path, options));
  const detached = h.button('Save'); detached.click(); await flush();
  const pending = h.calls.find(c => c.options.method === 'POST').options.body;
  await h.switch('2'); await h.switch('1');
  h.pages.set('1', [head('created', 1, 'new A')]); release({ status: 200, data: head('created', 1, 'new A') }); await flush();
  assert.equal(h.values().length, 0); detached.click(); await flush();
  assert.equal(h.calls.filter(c => c.options.method === 'POST').length, 1);
  await h.click('Resume Held Work');
  h.setReply(async (path, options) => options.method === 'POST' ? { status: 200, data: head('created', 1, 'new A') } : h.defaultReply(path, options));
  await h.click('Retry Request');
  assert.equal(h.calls.filter(c => c.options.method === 'POST').at(-1).options.body, pending);
  assert.equal(h.document.body.all().filter(e => e.tagName === 'section').length, 1);
  assert.equal(h.window.kinViewerHistoryHasUnsaved(), false);
});

test('C2 (9): actual session end clears recovery and both captured SR commands explain re-entry', async () => {
  const h = await harness(); await h.click('Edit'); h.input('Key Title', 'private'); await h.switch('2');
  const captured = [...h.commands.values()];
  h.setReply(async () => ({ status: 401, data: { code: 'AUTH_SESSION_ENDED' } })); await h.click('Refresh');
  assert.equal(h.window.kinViewerHistoryHasUnsaved(), false);
  for (const command of captured) assert.throws(() => command.commandFn({ measurementData: [{ uid: 'x', toolName: 'Length' }] }), /다시 로그인한 뒤 뷰어/);
  assert.equal(h.notices.length, 2); assert.doesNotMatch(h.text(), /private/);
});

test('A1 delta: native deletion removes a headless draft; it does not resurrect or retain an exit guard', async () => {
  const h = await harness();
  h.annotations.set('new', { annotationUID: 'new', metadata: { toolName: 'ArrowAnnotate', FrameOfReferenceUID: '1.4',
    referencedImageId: '/studies/1/series/1.2/instances/1.3/frames/1' }, data: { text: 'delete me', handles: { points: [[0,0,0],[1,0,0]] } } });
  await h.tick(); assert.equal(h.window.kinViewerHistoryHasUnsaved(), true);
  h.annotations.delete('new'); await h.tick();
  assert.equal(h.window.kinViewerHistoryHasUnsaved(), false); assert.doesNotMatch(h.text(), /delete me/);
  assert.equal(h.annotations.size, 0);
});

test('C5 delta: denied study loses incomplete annotations; other-study marks are not erased', async () => {
  const h = await harness();
  for (const uid of ['1', '2']) h.annotations.set(uid, { annotationUID: uid, metadata: { toolName: 'ArrowAnnotate',
    referencedImageId: `/studies/${uid}/series/1.2/instances/1.3/frames/1` }, data: { handles: { points: [[0,0,0]] } } });
  h.setReply(async (path, options) => path.includes('/studies/1/') ? { status: 403, data: {} } : h.defaultReply(path, options));
  await h.click('Refresh'); assert.equal(h.annotations.has('1'), false); assert.equal(h.annotations.has('2'), true);
});

test('A1/C5 delta: pending create does not block another edit or overwrite its changes when replay resolves', async () => {
  const h = await harness(); await h.click('Add Key Image'); h.input('Key Title', 'created');
  h.setReply(async (path, options) => options.method === 'POST' ? { status: 503, data: {} } : h.defaultReply(path, options));
  await h.click('Save'); const body = h.calls.find(c => c.options.method === 'POST').options.body;
  h.pages.set('1', [head('created', 1, 'created')]); await h.switch('2'); await h.switch('1'); await h.click('Resume Held Work');
  await h.click('Edit'); h.input('Key Title', 'edit after commit');
  h.setReply(async (path, options) => options.method === 'POST' ? { status: 200, data: head('created', 1, 'created') } : h.defaultReply(path, options));
  await h.click('Retry Request'); assert.equal(h.calls.filter(c => c.options.method === 'POST').at(-1).options.body, body);
  assert.ok(h.values().includes('edit after commit')); assert.equal(h.window.kinViewerHistoryHasUnsaved(), true);
  assert.equal(h.document.body.all().filter(e => e.tagName === 'section').length, 1);
});

// Add Key Image keeps the image the reader sees: the stack cell's image on the screen must be the image the Key Image names.
const NOT_SHOWN = /고른 영상이 아직 이 칸에 표시되지 않아 Key Image를 만들지 않았습니다/;
const sections = h => h.document.body.all().filter(e => e.tagName === 'section').length;
async function saveKey(h, title, id) {
  await h.click('Add Key Image'); h.input('Key Title', title);
  h.setReply(async (path, options) => options.method === 'POST' ? { status: 200, data: head(id, 1, title) } : h.defaultReply(path, options));
  await h.click('Save');
  return JSON.parse(h.calls.find(c => c.options.method === 'POST').options.body).item;
}

test('Add Key Image makes nothing while the next frame is still loading (frame 1 on the screen, frame 2 asked for)', async () => {
  const h = await harness(); h.pages.set('1', []); await h.click('Refresh');
  const before = sections(h);
  h.frames(2, 1); await h.click('Add Key Image');
  assert.equal(sections(h), before); assert.match(h.text(), NOT_SHOWN);
  assert.equal(h.calls.filter(c => c.options.method === 'POST').length, 0);
});

test('Add Key Image makes nothing after the next frame failed to load and the frame before stays on the screen', async () => {
  const h = await harness(); h.pages.set('1', []); await h.click('Refresh');
  const before = sections(h);
  // The failed load leaves the renderer's index on frame 2; frame 1 stays shown however long the reader waits.
  h.frames(2, 1); await h.tick(); await h.click('Add Key Image'); await h.tick(); await h.click('Add Key Image');
  assert.equal(sections(h), before); assert.match(h.text(), NOT_SHOWN);
  // Nothing on the screen yet (the cell's first image never arrived): nothing is made either.
  h.frames(1, 0); await h.click('Add Key Image');
  assert.equal(sections(h), before);
  assert.equal(h.calls.filter(c => c.options.method === 'POST').length, 0);
});

test('Add Key Image keeps frame 2 once frame 2 is on the screen', async () => {
  const h = await harness(); h.pages.set('1', []); await h.click('Refresh');
  h.frames(2, 1); await h.click('Add Key Image');
  h.frames(2, 2);
  const item = await saveKey(h, 'shown frame', 'k');
  assert.deepEqual([item.kind, item.seriesUid, item.sopUid, item.frame], ['key', '1.2', '1.3', 2]);
});

test('Add Key Image makes nothing while the cell has not finished drawing the image it holds', async () => {
  const h = await harness(); h.pages.set('1', []); await h.click('Refresh');
  const before = sections(h);
  h.frames(2, 2); h.viewport.viewportStatus = 'preRender'; await h.click('Add Key Image');
  assert.equal(sections(h), before); assert.match(h.text(), NOT_SHOWN);
  h.viewport.viewportStatus = 'rendered';
  const item = await saveKey(h, 'drawn frame', 'd');
  assert.equal(item.frame, 2);
});

test('Add Key Image makes nothing in Tile, Unfolded or Slab views, which do not show one image of the stack', async () => {
  const h = await harness(); h.pages.set('1', []); await h.click('Refresh');
  const before = sections(h);
  for (const [setup, words] of [[() => { h.window.kinNavigate = { laid: () => 'tile' }; }, /Tile 보기에서는 Key Image를 만들 수 없습니다/],
    [() => { h.window.kinNavigate = { laid: () => 'unfolded' }; }, /Unfolded 보기에서는 Key Image를 만들 수 없습니다/],
    [() => { delete h.window.kinNavigate; h.window.kinMgSlab = { on: () => true }; }, /Slab을 보는 동안에는 Key Image를 만들 수 없습니다/]]) {
    setup(); await h.click('Add Key Image');
    assert.equal(sections(h), before); assert.match(h.text(), words);
  }
  h.window.kinMgSlab = { on: () => false };
  assert.equal((await saveKey(h, 'stack view', 's')).frame, 1);
});

test('Add Key Image makes nothing in a video cell, whose frame on the screen cannot be confirmed, and says so', async () => {
  const h = await harness(); h.pages.set('1', []); await h.click('Refresh');
  const before = sections(h);
  const VIDEO = /동영상 칸에서는 화면의 프레임을 확정할 수 없어 Key Image를 만들 수 없습니다/;
  // The pinned video cell turns time into a frame with its own rate (frames ÷ duration, rounded: 30 for a 29.97 fps video)
  // and names round(time × rate) + 1; the frame on the screen is the recorded one at that time.
  const video = { seeking: false, readyState: 4, currentTime: 2 / 30 };
  const moves = [];
  h.volumeCell(); Object.assign(h.viewport, { type: 'video', videoElement: video, fps: 30,
    getCurrentImageId: () => `/studies/1/series/1.2/instances/1.3/frames/${Math.round(video.currentTime * 30) + 1}`,
    setFrameNumber: async n => { moves.push(n); video.currentTime = (n - 1) / 30; } });
  // Paused at the start of a frame, in the second half of one, at 10.005 s of a 29.97 fps video, while seeking, before its
  // first frame, and without a video element or a frame in its image id: nothing is made, nothing is sent, the cell stays.
  for (const set of [() => {}, () => { video.currentTime = 2.6 / 30; }, () => { video.currentTime = 10.005; },
    () => { video.seeking = true; }, () => { video.seeking = false; video.readyState = 1; },
    () => { delete h.viewport.videoElement; h.viewport.getCurrentImageId = () => '/studies/1/series/1.2/instances/1.3'; }]) {
    set(); await h.click('Add Key Image');
    assert.equal(sections(h), before); assert.match(h.text(), VIDEO);
  }
  assert.deepEqual(moves, []);
  assert.equal(h.calls.filter(c => c.options.method === 'POST').length, 0);
});

test('Add Key Image makes nothing in a volume cell drawing a projection (MIP, MinIP, Average or a thick slab)', async () => {
  const h = await harness(); h.pages.set('1', []); await h.click('Refresh');
  const before = sections(h);
  let blend = 1, half = 5;
  h.frames(4, 4); h.volumeCell();
  Object.assign(h.viewport, { getActors: () => [{ actor: { getMapper: () => ({ getBlendMode: () => blend }) } }], getSlabThickness: () => half });
  for (const [b, t] of [[1, 5], [3, 5], [0, 5]]) {
    blend = b; half = t; await h.click('Add Key Image');
    assert.equal(sections(h), before); assert.match(h.text(), /MIP·MinIP·Average나 두꺼운 단면을 보는 동안에는 Key Image를 만들 수 없습니다/);
  }
  blend = 0; half = 0.05;
  assert.equal((await saveKey(h, 'thin mpr', 'p')).frame, 4);
});

test('Add Key Image in a volume cell (MPR, no loaded-image read) names its current original slice', async () => {
  const h = await harness(); h.pages.set('1', []); await h.click('Refresh');
  h.frames(4, 4); h.volumeCell();
  const item = await saveKey(h, 'mpr slice', 'm');
  assert.deepEqual([item.kind, item.frame], ['key', 4]);
});

test('Add Key Image makes nothing in a thin MPR cell between two original slices or before the volume holds every slice', async () => {
  const h = await harness(); h.pages.set('1', []); await h.click('Refresh');
  const before = sections(h);
  h.frames(4, 4); const mpr = h.volumeCell();
  // The crosshairs left the plane 0.9 mm past slice 4 (slices 2 mm apart): the cell draws a blend and names slice 4.
  mpr.offset = 0.9; await h.click('Add Key Image');
  assert.equal(sections(h), before); assert.match(h.text(), /MPR 단면이 원본 영상 사이에 있어 Key Image를 만들 수 없습니다/);
  // Only 0.08 mm past slice 4 (4% of the spacing): still a blend (96% of slice 4, 4% of slice 5), so still nothing.
  mpr.offset = 0.08; await h.click('Add Key Image');
  assert.equal(sections(h), before); assert.match(h.text(), /MPR 단면이 원본 영상 사이에 있어 Key Image를 만들 수 없습니다/);
  // On the slice, but the volume is still arriving (slow network): slice 4 may not be on the screen yet.
  mpr.offset = 0; mpr.framesLoaded = 5; mpr.loaded = false; await h.click('Add Key Image');
  assert.equal(sections(h), before); assert.match(h.text(), NOT_SHOWN);
  assert.equal(h.calls.filter(c => c.options.method === 'POST').length, 0);
  // Every slice held and the plane on slice 4 (as scrolling leaves it, to within float error): slice 4 is kept.
  mpr.framesLoaded = 6; mpr.loaded = true; mpr.offset = 1e-4;
  assert.equal((await saveKey(h, 'on slice', 'o')).frame, 4);
});

test('Add Key Image makes nothing in a thin MPR cell whose plane is tilted off the slice, though its centre lies on it', async () => {
  const h = await harness(); h.pages.set('1', []); await h.click('Refresh');
  const before = sections(h);
  h.frames(4, 4); const mpr = h.volumeCell();
  // Rotated by half a degree through the centre of slice 4: the centre is slice 4, the edges are blends of other slices.
  const a = 0.5 * Math.PI / 180; mpr.normal = [0, Math.sin(a), Math.cos(a)];
  await h.click('Add Key Image');
  assert.equal(sections(h), before); assert.match(h.text(), /MPR 단면이 원본 영상 사이에 있어 Key Image를 만들 수 없습니다/);
  assert.equal(h.calls.filter(c => c.options.method === 'POST').length, 0);
  mpr.normal = [0, 0, -1];
  assert.equal((await saveKey(h, 'axial again', 'x')).frame, 4);
});

test('Add Key Image makes nothing in a cell it cannot confirm: another cell kind, or a stack cell whose drawing state is unknown', async () => {
  const h = await harness(); h.pages.set('1', []); await h.click('Refresh');
  const before = sections(h);
  // Each of these shows the named frame by its loaded-image read; none is a cell the rule knows how to confirm.
  for (const type of ['volume3d', 'wholeSlide', 'perspective', undefined]) {
    h.viewport.type = type; await h.click('Add Key Image');
    assert.equal(sections(h), before, String(type)); assert.match(h.text(), NOT_SHOWN);
  }
  h.viewport.type = 'stack'; delete h.viewport.viewportStatus; await h.click('Add Key Image');
  assert.equal(sections(h), before); assert.match(h.text(), NOT_SHOWN);
  // This viewer's Tile/Unfolded read is loaded but fails: how the cell is laid out is unknown, so nothing is made.
  h.viewport.viewportStatus = 'rendered'; h.window.kinNavigate = { laid: () => { throw new Error('layout unknown'); } };
  await h.click('Add Key Image');
  assert.equal(sections(h), before); assert.match(h.text(), NOT_SHOWN);
  assert.equal(h.calls.filter(c => c.options.method === 'POST').length, 0);
  delete h.window.kinNavigate;
  assert.equal((await saveKey(h, 'stack', 'q')).frame, 1);
});

test('A1 delta: a changed login subject purges parked work before any resume', async () => {
  const h = await harness(); await h.click('Edit'); h.input('Key Title', 'private'); await h.switch('2');
  h.setMe({ sub: 'another', kind: 'member', roles: ['radiologist'] }); await h.switch('1');
  assert.match(h.text(), /로그인이 종료/); assert.equal(h.window.kinViewerHistoryHasUnsaved(), false);
});

async function measured() {
  const h = await harness(), id = '/studies/1/series/1.2/instances/1.3/frames/1';
  h.window.cornerstone.cache = { getImage: () => ({}) };
  h.window.cornerstone.metaData.get = kind => kind === 'instance' ? {
    SOPClassUID: '1.2.840.10008.5.1.4.1.1.2', Modality: 'CT', PixelSpacing: [1,1],
    ImageOrientationPatient: [1,0,0,0,1,0], ImagePositionPatient: [0,0,0], FrameOfReferenceUID: '1.4', Columns: 256, Rows: 256,
  } : undefined;
  const a = { annotationUID: 'length', invalidated: false, metadata: { toolName: 'Length', FrameOfReferenceUID: '1.4',
    referencedImageId: id, viewPlaneNormal: [0,0,1], viewUp: [0,-1,0] },
    data: { label: '', handles: { points: [[0,0,0],[10,0,0]] }, cachedStats: {} } };
  h.annotations.set(a.annotationUID,a); h.measurements.set(a.annotationUID,{ uid: a.annotationUID, toolName: 'Length', source: {} });
  h.services.measurementService.getSourceMappings = () => [{ annotationType: 'Length', toMeasurementSchema: () => ({ displayText: { primary: ['10 mm'], secondary: [] }, points: a.data.handles.points }) }];
  await h.tick(); a.data.cachedStats['imageId:'+id] = { length: 10 }; a.invalidated = false; await h.tick();
  return { h, a };
}

test('B1: both production SR commands reject changed geometry before the next scan/native calculation', async () => {
  const { h, a } = await measured(); a.data.handles.points[1][0] = 20;
  const before = h.calls.length;
  for (const command of h.commands.values()) assert.throws(() => command.commandFn({ measurementData: [...h.measurements.values()] }), /재확인 필요/);
  assert.equal(h.calls.length,before);
});

test('B1 panel regression: a public unverified read between ticks still emits the recovered view', async () => {
  const { h, a } = await measured(); let updates = 0; h.services.measurementService.update = () => updates++;
  a.data.kinUnverified = true;
  assert.match(h.services.measurementService.getMeasurements()[0].displayText.primary[0], /재확인 필요/);
  a.data.kinUnverified = false; await h.tick();
  assert.equal(updates,1); assert.equal(h.services.measurementService.getMeasurements()[0].displayText.primary[0], '10 mm');
});

async function savedMeasurement(mismatch = false) {
  const result = await measured(), { h } = result;
  const originalButton = h.button;
  h.button = name => h.document.body.all().find(e => e.tagName === 'section' && e.dataset.kind === 'length')
    ?.all().find(e => e.tagName === 'button' && e.textContent === name) || originalButton(name);
  h.click = async name => { h.button(name).click(); await flush(); };
  let saved;
  h.setReply(async (path, options) => {
    if (options.method !== 'POST') return h.defaultReply(path, options);
    saved = { ...head('saved'), item: JSON.parse(options.body).item };
    if (mismatch) saved.item.baseline.values[0] += 1;
    h.pages.set('1', [saved]); return { status: 200, data: saved };
  });
  await h.click('Save'); await h.tick(); return { ...result, saved };
}

test('A4 (12): editing alone keeps mismatch; only fresh remeasured geometry recovers', async () => {
  const { h, a } = await savedMeasurement(true);
  assert.equal(a.data.kinUnverified, true); await h.click('Edit'); await h.tick();
  assert.equal(a.data.kinUnverified, true);
  a.data.handles.points[1][0] = 20; a.invalidated = false; await h.tick();
  assert.equal(a.data.kinUnverified, true);
  for (const command of h.commands.values()) assert.throws(() => command.commandFn({ measurementData: [...h.measurements.values()] }), /재확인 필요/);
  a.data.cachedStats['imageId:' + a.metadata.referencedImageId] = { length: 20 };
  a.invalidated = false; await h.tick(); assert.equal(a.data.kinUnverified, false);
  assert.doesNotMatch(h.services.measurementService.getMeasurements()[0].displayText.primary[0], /재확인 필요/);
  await h.click('Save');
  const command = JSON.parse(h.calls.filter(c => c.options.method === 'POST').at(-1).options.body);
  assert.deepEqual(command.item.points, [[0,0,0],[20,0,0]]);
  assert.deepEqual(command.item.baseline.values, [20]);
});

test('A3 (11): same-revision unverified head keeps edits and blocks even a detached save handler', async () => {
  const { h, saved } = await savedMeasurement(); await h.click('Edit'); h.input('Annotation Text', 'retained edit');
  const staleSave = h.button('Save'); saved.referenceStatus = 'unverified';
  await h.click('Refresh'); assert.equal(h.button('Save').disabled, true);
  assert.deepEqual(h.values(), ['retained edit']); assert.equal(h.annotations.size, 0);
  const posts = h.calls.filter(c => c.options.method === 'POST').length;
  staleSave.click(); await flush(); assert.equal(h.calls.filter(c => c.options.method === 'POST').length, posts);
  await h.click('Recheck Source'); assert.deepEqual(h.values(), ['retained edit']);
  assert.ok(h.calls.some(c => c.path.includes('recheck=saved')), 'C4a uses an item-scoped read, not the same starving page');
  h.pages.set('1', []); await h.click('Recheck Source');
  assert.match(h.text(), /선택한 저장 항목을 찾지 못했습니다/); assert.deepEqual(h.values(), ['retained edit']);
  h.pages.set('1', [saved]);
  const link = h.document.body.all().find(e => e.tagName === 'a' && e.textContent === 'Remeasure in New Viewer');
  assert.equal(link.href, '/ohif/viewer?StudyInstanceUIDs=1'); assert.equal(link.rel, 'noopener noreferrer');
  assert.equal(h.window.kinViewerHistoryHasUnsaved(), true);
  saved.referenceStatus = 'verified'; await h.click('Recheck Source');
  assert.match(h.text(), /원본 확인 완료/);
  assert.equal(h.button('Save').disabled, false); assert.deepEqual(h.values(), ['retained edit']);
});

test('C3: both SR commands identify the blocked selected item without silently dropping it', async () => {
  const { h, a } = await measured();
  h.input('Annotation Text', '<img src=x> blocked length');
  a.data.handles.points[1][0] = 20;
  const selection = [{ uid: 'foreign-key', toolName: 'KeyImage' }, ...h.measurements.values()];
  const before = h.calls.length;
  for (const command of h.commands.values()) assert.throws(() => command.commandFn({measurementData: selection}),
    /<img src=x> blocked length.*\[length\].*계산이 완료되지/);
  assert.equal(h.calls.length, before);
  assert.equal(selection.length, 2);
  a.invalidated = true; a.data.handles = {};
  for (const command of h.commands.values()) assert.throws(() => command.commandFn({measurementData: selection}), /측정 위치가 완성되지/);
  assert.equal(h.calls.length, before);
});

test('A5: replaced cache is rewrapped; old values stay untrusted until a new native assignment', async () => {
  const { h, a } = await measured(), data = a.data, target = 'imageId:'+a.metadata.referencedImageId;
  a.data.cachedStats = { [target]: { length: 10 } }; a.invalidated = false;
  await h.tick();
  assert.equal(a.data, data);
  for (const command of h.commands.values()) assert.throws(()=>command.commandFn({measurementData:[...h.measurements.values()]}), /재확인 필요/);
  a.data.cachedStats[target] = { length: 10 }; a.invalidated = false; await h.tick();
  assert.equal(h.services.measurementService.getMeasurements()[0].displayText.primary[0], '10 mm');
});

test('A3 delta: verified read after storage-limit 409 retains the actionable failure', async () => {
  const { h } = await savedMeasurement(); await h.click('Edit'); h.input('Annotation Text', 'quota draft');
  h.setReply(async (path, options) => options.method === 'POST' ? { status: 409, data: { code: 'VIEWER_STORAGE_LIMIT' } } : h.defaultReply(path, options));
  await h.click('Save'); assert.match(h.text(), /저장 공간 한도/);
  await h.click('Refresh'); assert.match(h.text(), /저장 공간 한도/);
  assert.deepEqual(h.values(), ['quota draft']); assert.equal(h.window.kinViewerHistoryHasUnsaved(), true);
});

test('A4 delta: retained annotation with identical values reports failed source, not recalculation mismatch', async () => {
  const { h, a, saved } = await savedMeasurement(); await h.click('Edit');
  h.pages.set('1', [{ ...saved, revision: 2, referenceStatus: 'unverified' }]);
  await h.click('Refresh'); await h.click('Use Latest & Keep Changes'); await h.tick();
  assert.equal(h.annotations.get(a.annotationUID), a); assert.equal(a.data.kinUnverified, true);
  assert.match(h.text(), /원본을 확인하지 못했습니다/); assert.doesNotMatch(h.text(), /재계산 값이 저장 당시와 다릅니다/);
  assert.equal(h.button('Save').disabled, true);
});

// S3-U5 CI1: the production kin.series-metadata-recovery extension on a fake WADO client whose calls settle when the
// test says, with fake timers and a DOM stub. Nothing here is a copied state machine.
const CURRENT = '1.2.840.99.1', PRIOR = '1.2.840.99.2', SERIES = '1.2.840.99.1.1', OTHER = '1.2.840.99.2.1';
const http = status => Object.assign(new Error('request failed'), { request: {}, response: '', status });
const ownMethod = client => Object.prototype.hasOwnProperty.call(client, 'retrieveSeriesMetadata');
function recovery({ search = `?StudyInstanceUIDs=${CURRENT},${PRIOR}`, lazy = true, own = false, accessor = true } = {}) {
  const document = new EventTarget(); document.body = new Element('body'); document.createElement = tag => new Element(tag);
  document.querySelector = selector => document.body.all().find(e => e.id && '#' + e.id === selector) || null;
  const panel = new Element('details'); panel.id = 'kin-viewer-layout'; document.body.append(panel);
  const window = new EventTarget(), location = { search }, timers = new Map(), calls = [], notices = [], lists = [], runs = [], refused = [], hidden = [];
  let serial = 0;
  function Client() {}
  Client.prototype.retrieveSeriesMetadata = function (options) {
    if (!('seriesInstanceUID' in options)) throw new Error('Series Instance UID is required for retrieval of series metadata');
    const call = { self: this, options };
    call.promise = new Promise((resolve, reject) => { call.resolve = resolve; call.reject = reject; });
    calls.push(call); return call.promise;
  };
  // The study's series list (QIDO) the lazy loader asks first; held like the series calls, in its own list.
  Client.prototype.searchForSeries = function (options) {
    const call = { self: this, options };
    call.promise = new Promise((resolve, reject) => { call.resolve = resolve; call.reject = reject; });
    lists.push(call); return call.promise;
  };
  const native = Client.prototype.retrieveSeriesMetadata, client = new Client();
  if (own) client.retrieveSeriesMetadata = function foreign(options) { return native.call(this, options); };
  const dataSource = { retrieve: accessor ? { getWadoDicomWebClient: () => client } : {}, getConfig: () => ({ enableStudyLazyLoad: lazy }) };
  window.KinSessionTransport = transports;
  window.KinViewerPatientTabs = { imagesRefused: () => { refused.push(true); return true; } };
  const hp = { run(data, ...rest) { runs.push({ data, rest }); return 'ran'; } };
  vm.runInNewContext(source, { window, document, location, URLSearchParams, crypto: webcrypto, TextEncoder, console, Event, CustomEvent, AbortController,
    setInterval: () => 0, clearInterval() {}, setTimeout: (fn, ms) => { timers.set(++serial, { fn, ms }); return serial; }, clearTimeout: id => { timers.delete(id); },
    fetch: async () => { throw new Error('no network in this contract'); } });
  timers.clear();
  const extension = window.config.extensions.find(e => e.id === 'kin.series-metadata-recovery');
  extension.preRegistration({ servicesManager: { services: { uiNotificationService: { show: x => notices.push(x), hide: id => hidden.push(id) }, hangingProtocolService: hp } },
    extensionManager: { getActiveDataSource: () => [dataSource] } });
  let screen = false; document.body.classList = { contains: name => name === 'kin-open-refused' && screen };
  return { location, timers, calls, notices, client, native, Client, lists, runs, refused, hidden, hp, window,
    // The patient tabs' refusal screen standing up (viewer-patient-tabs.js marks the body and announces it).
    refuseScreen: () => { screen = true; window.dispatchEvent(new Event('kin-viewer-open-refused')); },
    shown: () => document.querySelector('#kin-viewer-open-status')?.textContent ?? null,
    list: (studyInstanceUID = CURRENT) => {
      const promise = client.searchForSeries({ studyInstanceUID, queryParams: {} }), seen = {};
      promise.then(value => { seen.value = value; }, error => { seen.error = error; });
      return { promise, seen };
    },
    enter: () => extension.onModeEnter({}), exit: () => extension.onModeExit({}),
    state: () => copy(window.kinSeriesMetadataRecoveryState()),
    text: () => document.querySelector('#kin-series-metadata-status')?.textContent ?? null,
    delays: () => [...timers.values()].map(t => t.ms),
    fire: () => { const due = [...timers.values()]; timers.clear(); for (const t of due) t.fn(); },
    load: (studyInstanceUID = CURRENT, seriesInstanceUID = SERIES) => {
      const promise = client.retrieveSeriesMetadata({ studyInstanceUID, seriesInstanceUID }), seen = {};
      promise.then(value => { seen.value = value; }, error => { seen.error = error; });
      return { promise, seen };
    },
  };
}

test('U5-CI1 R1: one own wrapper on this lifecycle client, restored only while still ours; a mismatched shape is refused visibly and stays native', async () => {
  const h = recovery(); h.enter();
  assert.equal(ownMethod(h.client), true); assert.equal(h.Client.prototype.retrieveSeriesMetadata, h.native);
  assert.deepEqual(h.state(), { phase: 'installed', pending: 0, retries: 0, errors: 0 }); assert.equal(h.text(), null);
  h.exit();
  assert.equal(ownMethod(h.client), false); assert.equal(h.client.retrieveSeriesMetadata, h.native); assert.equal(h.state().phase, 'stopped');
  h.enter(); const foreign = function () {}; h.client.retrieveSeriesMetadata = foreign; h.exit();
  assert.equal(h.client.retrieveSeriesMetadata, foreign);
  for (const options of [{ lazy: false }, { own: true }, { accessor: false }, { search: '?hangingProtocolId=@ohif/hpCompare' }]) {
    const r = recovery(options), before = r.client.retrieveSeriesMetadata; r.enter();
    assert.equal(r.client.retrieveSeriesMetadata, before); assert.equal(r.state().phase, 'refused');
    assert.match(r.text(), /재요청 기능을 연결하지 못했습니다/);
    const { seen } = r.load(), error = http(500); r.calls[0].reject(error); await flush();
    assert.equal(seen.error, error); assert.deepEqual(r.delays(), []); assert.equal(r.calls.length, 1); assert.equal(r.notices.length, 0);
    r.exit(); assert.equal(r.text(), null); assert.equal(r.client.retrieveSeriesMetadata, before);
  }
});

test('U5-CI1 R2: a rejected HTTP 500-599 GET waits one fixed retry; uncoded 4xx, 0, 429, 600, no request and sync throws do not', async () => {
  for (const status of [500, 502, 503, 599]) {
    const h = recovery(); h.enter(); const { seen } = h.load();
    h.calls[0].reject(http(status)); await flush();
    assert.deepEqual(h.delays(), [1000]); assert.equal(h.calls.length, 1); assert.equal(seen.error, undefined);
    h.fire(); assert.equal(h.calls.length, 2);
    assert.equal(h.calls[1].self, h.client); assert.equal(h.calls[1].options, h.calls[0].options);
  }
  const bare = Object.assign(new Error('request failed'), { status: 503 }), text = Object.assign(new Error('request failed'), { request: {}, status: '503' });
  for (const error of [http(0), http(400), http(401), http(403), http(404), http(409), http(429), http(499), http(600), bare, text, new TypeError('x')]) {
    const h = recovery(); h.enter(); const { seen } = h.load();
    h.calls[0].reject(error); await flush();
    assert.equal(seen.error, error); assert.deepEqual(h.delays(), []); assert.equal(h.calls.length, 1); assert.equal(h.state().retries, 0);
  }
  const h = recovery(); h.enter();
  assert.throws(() => h.client.retrieveSeriesMetadata({ studyInstanceUID: CURRENT }), /Series Instance UID is required/);
  assert.deepEqual(h.delays(), []); assert.equal(h.calls.length, 0);
});

test('U5INT-F01: metadata retries coded auth refusals and keeps uncoded denial permanent', async () => {
  for (const code of ['AUTH_IDP_UNAVAILABLE', 'AUTH_SESSION_BUSY', 'AUTH_STORAGE_FAILURE']) {
    const h = recovery(); h.enter(); const { seen } = h.load();
    const error = { status: 403, request: { getResponseHeader: name => name === 'X-KIN-Auth-Code' ? code : null } };
    h.calls[0].reject(error); await flush();
    assert.deepEqual(h.delays(), [1000]); assert.equal(seen.error, undefined);
    h.fire(); h.calls[1].reject(error); await flush();
    assert.equal(seen.error, error); assert.match(h.text(), /연결을 확인하지 못했습니다/);
    assert.doesNotMatch(h.text(), /접근할 수 없습니다/);
    assert.deepEqual(h.delays(), []);
  }
  const h = recovery(); h.enter(); const { seen } = h.load();
  h.calls[0].reject(http(403)); await flush();
  assert.equal(seen.error.status, 403); assert.deepEqual(h.delays(), []);
  assert.match(h.text(), /접근할 수 없습니다/);
});

test('U5-CI1 R3: a transient 500 fills the one held promise with the retry reply; a persistent one rejects with the final error and names only the study position', async () => {
  const h = recovery(); h.enter(); const { promise, seen } = h.load();
  h.calls[0].reject(http(500)); await flush(); h.fire();
  const reply = [{ '0020000E': { vr: 'UI', Value: [SERIES] } }]; h.calls[1].resolve(reply); await flush();
  assert.equal(seen.value, reply); assert.equal(await promise, reply);
  assert.equal(h.calls.length, 2); assert.equal(h.text(), null); assert.equal(h.notices.length, 0);
  assert.deepEqual(h.state(), { phase: 'installed', pending: 0, retries: 1, errors: 0 });
  h.fire(); await flush(); assert.equal(h.calls.length, 2);
  const p = recovery(); p.enter(); const held = p.load(PRIOR, OTHER);
  p.calls[0].reject(http(500)); await flush(); p.fire();
  const final = http(503); p.calls[1].reject(final); await flush();
  assert.equal(held.seen.error, final);
  assert.match(p.text(), /^2번째 검사의 영상 정보를 한 번 다시 요청했지만 불러오지 못했습니다\(HTTP 503\)/);
  assert.equal(p.notices.length, 1); assert.equal(p.notices[0].type, 'error'); assert.equal(p.notices[0].title, 'Image Loading');
  assert.equal(p.notices[0].message, p.text());
  for (const shown of [p.text(), p.notices[0].message]) assert.doesNotMatch(shown, /1\.2\.840/);
  assert.deepEqual(p.delays(), []); assert.equal(p.calls.length, 2);
  assert.deepEqual(p.state(), { phase: 'installed', pending: 0, retries: 1, errors: 1 });
});

test('U5-CI1 R4: repeated or concurrent calls for one series cannot renew its one retry; another series and a new lifecycle have their own', async () => {
  const h = recovery(); h.enter();
  const a = h.load(), b = h.load();
  h.calls[0].reject(http(500)); h.calls[1].reject(http(502)); await flush();
  assert.deepEqual(h.delays(), [1000]); assert.equal(a.seen.error, undefined); assert.equal(b.seen.error.status, 502);
  assert.match(h.text(), /^1번째 검사의 영상 정보를 불러오지 못했습니다\(HTTP 502\)/);
  const c = h.load(); h.calls[2].reject(http(500)); await flush();
  assert.equal(c.seen.error.status, 500); assert.deepEqual(h.delays(), [1000]); assert.equal(h.notices.length, 1);
  h.fire(); assert.equal(h.calls.length, 4);
  const reply = []; h.calls[3].resolve(reply); await flush();
  assert.equal(a.seen.value, reply); assert.equal(h.text(), null);
  const d = h.load(); h.calls[4].reject(http(500)); await flush();
  assert.equal(d.seen.error.status, 500); assert.deepEqual(h.delays(), []);
  const e = h.load(CURRENT, '1.2.840.99.1.2'); h.calls[5].reject(http(500)); await flush();
  assert.deepEqual(h.delays(), [1000]); h.fire(); assert.equal(h.calls.length, 7);
  assert.equal(h.calls[6].options.seriesInstanceUID, '1.2.840.99.1.2'); assert.equal(e.seen.error, undefined);
  h.exit(); h.enter(); assert.equal(h.text(), null);
  h.load(); h.calls[7].reject(http(500)); await flush();
  assert.deepEqual(h.delays(), [1000]); assert.deepEqual(h.state(), { phase: 'installed', pending: 1, retries: 0, errors: 0 });
});

test('U5-CI1 R5: exit or a changed URL before the timer ends the wait with the original error, no request and no message; late replies stay silent', async () => {
  const h = recovery(); h.enter(); const held = h.load(), first = http(500);
  h.calls[0].reject(first); await flush(); assert.equal(h.state().pending, 1);
  h.exit(); await flush();
  assert.equal(held.seen.error, first); assert.deepEqual(h.delays(), []);
  h.fire(); await flush();
  assert.equal(h.calls.length, 1); assert.equal(h.text(), null); assert.equal(h.notices.length, 0);
  assert.equal(h.client.retrieveSeriesMetadata, h.native);
  h.enter(); const late = h.load(); h.exit();
  const error = http(500); h.calls[1].reject(error); await flush();
  assert.equal(late.seen.error, error); assert.deepEqual(h.delays(), []); assert.equal(h.text(), null); assert.equal(h.notices.length, 0);
  h.enter(); const flying = h.load(); h.calls[2].reject(http(500)); await flush(); h.fire(); h.exit();
  const reply = []; h.calls[3].resolve(reply); await flush();
  assert.equal(flying.seen.value, reply); assert.equal(h.calls.length, 4); assert.equal(h.text(), null);
  const u = recovery(); u.enter(); const moved = u.load(); u.location.search = `?StudyInstanceUIDs=${PRIOR}`;
  const early = http(500); u.calls[0].reject(early); await flush();
  assert.equal(moved.seen.error, early); assert.deepEqual(u.delays(), []); assert.equal(u.text(), null);
  const v = recovery(); v.enter(); const waiting = v.load(), pending = http(500); v.calls[0].reject(pending); await flush();
  v.location.search = '?StudyInstanceUIDs=1.2.840.99.3'; v.fire(); await flush();
  assert.equal(waiting.seen.error, pending); assert.equal(v.calls.length, 1); assert.equal(v.text(), null); assert.equal(v.notices.length, 0);
  const w = recovery(); w.enter(); const outside = w.load('1.2.840.99.9', '1.2.840.99.9.1'), foreign = http(500);
  w.calls[0].reject(foreign); await flush();
  assert.equal(outside.seen.error, foreign); assert.deepEqual(w.delays(), []); assert.equal(w.text(), null);
});

test('U5-CI1 R6: a failure belongs to its own study and series; only a matching success clears it and a new lifecycle starts clean', async () => {
  const h = recovery(), denied = '1번째 검사의 영상 정보에 접근할 수 없습니다(HTTP 403). 이 검사 영상은 표시하지 않았습니다.'; h.enter();
  h.load(); h.calls[0].reject(http(403)); await flush();
  assert.equal(h.text(), denied); assert.deepEqual(h.delays(), []);
  h.load(PRIOR, OTHER); h.calls[1].reject(http(500)); await flush(); h.fire(); h.calls[2].reject(http(500)); await flush();
  assert.match(h.text(), /^1번째 .*HTTP 403.* 2번째 .*한 번 다시 요청했지만.*HTTP 500/); assert.equal(h.notices.length, 2);
  h.load(PRIOR, OTHER); h.calls[3].resolve([]); await flush();
  assert.equal(h.text(), denied);
  h.load(PRIOR, '1.2.840.99.2.9'); h.calls[4].resolve([]); await flush();
  assert.equal(h.text(), denied);
  h.exit(); assert.equal(h.text(), null); h.enter(); assert.equal(h.text(), null);
  assert.deepEqual(h.state(), { phase: 'installed', pending: 0, retries: 0, errors: 0 });
});


// Viewer open failures: the study's image list (QIDO) through the same retry, the document's record of failed studies,
// the refusal screen's one line, and the layout guard under the per-route run wrappers. Only real failures count: a slow
// request is waited for (no time-made failure).
test('Open failures L1: a prior image list gets the one retry and its reason over the images; the document records it', async () => {
  const h = recovery(); h.enter(); const held = h.list(PRIOR);
  h.lists[0].reject(http(503)); await flush();
  assert.deepEqual(h.delays(), [1000]); assert.equal(held.seen.error, undefined);
  h.fire(); assert.equal(h.lists.length, 2); assert.equal(h.lists[1].options, h.lists[0].options);
  const final = http(503); h.lists[1].reject(final); await flush();
  assert.equal(held.seen.error, final);
  assert.match(h.text(), /^2번째 검사의 영상 정보를 한 번 다시 요청했지만 불러오지 못했습니다\(HTTP 503\)/);
  assert.equal(h.shown(), h.text()); assert.doesNotMatch(h.shown(), /1\.2\.840/);
  assert.deepEqual([...h.window.kinViewerFailedStudies()], [PRIOR]); assert.deepEqual(h.refused, []);
  // A list answered on the retry is not a failure.
  const r = recovery(); r.enter(); const ok = r.list(PRIOR); r.lists[0].reject(http(500)); await flush(); r.fire();
  const reply = []; r.lists[1].resolve(reply); await flush();
  assert.equal(ok.seen.value, reply); assert.equal(r.shown(), null); assert.deepEqual([...r.window.kinViewerFailedStudies()], []);
});

test('Open failures L2: refused lists are not asked again; 404 and 410 read as refused; a refused current list goes to the refusal screen', async () => {
  for (const status of [403, 404, 410]) {
    const h = recovery(); h.enter(); const prior = h.list(PRIOR);
    h.lists[0].reject(http(status)); await flush();
    assert.equal(prior.seen.error.status, status); assert.deepEqual(h.delays(), []); assert.deepEqual(h.refused, []);
    assert.equal(h.shown(), `2번째 검사의 영상 정보에 접근할 수 없습니다(HTTP ${status}). 이 검사 영상은 표시하지 않았습니다.`);
  }
  for (const status of [403, 404]) {
    const c = recovery(); c.enter(); const current = c.list(CURRENT);
    c.lists[0].reject(http(status)); await flush();
    assert.equal(current.seen.error.status, status); assert.deepEqual(c.delays(), []); assert.equal(c.refused.length, 1);
    assert.deepEqual([...c.window.kinViewerFailedStudies()], [CURRENT]);
  }
  // A current list that keeps failing for a temporary reason is not a refusal: its line says to reopen.
  const t = recovery(); t.enter(); t.list(CURRENT); t.lists[0].reject(http(502)); await flush(); t.fire(); t.lists[1].reject(http(502)); await flush();
  assert.deepEqual(t.refused, []); assert.match(t.shown(), /^1번째 검사의 영상 정보를 한 번 다시 요청했지만 .*뷰어를 다시 여세요/);
});

test('Open failures L3: once the refusal screen stands only its line shows - a prior reason already up and one that comes later', async () => {
  // The prior's failure first, then the refusal screen: its line and its notice are taken back.
  const h = recovery(); h.enter();
  h.list(PRIOR); h.lists[0].reject(http(503)); await flush(); h.fire(); h.lists[1].reject(http(503)); await flush();
  assert.match(h.shown(), /^2번째 검사/); assert.equal(h.notices.length, 1);
  h.refuseScreen();
  assert.equal(h.shown(), null); assert.deepEqual(h.hidden, [1]);
  // The refusal screen first, then the prior's failure: no line, no notice.
  const r = recovery(); r.enter(); r.refuseScreen();
  r.list(PRIOR); r.lists[0].reject(http(403)); await flush();
  assert.equal(r.shown(), null); assert.equal(r.notices.length, 0);
  // A normal comparison screen keeps the prior's reason.
  const n = recovery(); n.enter(); n.list(PRIOR); n.lists[0].reject(http(403)); await flush();
  assert.match(n.shown(), /^2번째 검사의 영상 정보에 접근할 수 없습니다/);
});

test('Open failures L4: a slow prior is waited for; no deadline, no time-made failure', async () => {
  const h = recovery(); h.enter();
  const current = h.list(CURRENT), prior = h.list(PRIOR);
  h.lists[0].resolve([]); await flush();
  assert.deepEqual(h.delays(), []); assert.deepEqual(current.seen.value, []);
  const s = h.load(PRIOR, OTHER); assert.deepEqual(h.delays(), []);
  h.lists[1].resolve([]); h.calls[0].resolve([]); await flush();
  assert.deepEqual(prior.seen.value, []); assert.deepEqual(s.seen.value, []);
  assert.equal(h.shown(), null); assert.deepEqual([...h.window.kinViewerFailedStudies()], []);
});

test('Open failures L5: a layout of this URL leaves out a study with no list; without the current study nothing is laid out', async () => {
  const h = recovery(); h.enter();
  const current = { StudyInstanceUID: CURRENT }, prior = { StudyInstanceUID: PRIOR }, sets = [1, 2];
  const whole = { studies: [current, prior], activeStudy: current, displaySets: sets };
  assert.equal(h.hp.run(whole, '@ohif/hpCompare', { stageIndex: 0 }), 'ran');
  assert.equal(h.runs[0].data, whole); assert.deepEqual(h.runs[0].rest, ['@ohif/hpCompare', { stageIndex: 0 }]);
  // URL [A,B], B failed: OHIF asks with [A, undefined] - A is laid out.
  assert.equal(h.hp.run({ studies: [current, undefined], activeStudy: current, displaySets: sets }, '@ohif/hpCompare'), 'ran');
  assert.deepEqual(h.runs[1].data.studies, [current]); assert.equal(h.runs[1].data.activeStudy, current); assert.equal(h.runs[1].data.displaySets, sets);
  // A failed: the prior is never laid out as the current study.
  assert.equal(h.hp.run({ studies: [undefined, prior], activeStudy: undefined, displaySets: sets }, '@ohif/hpCompare'), undefined);
  assert.equal(h.runs.length, 2);
  // One guard for the document: a later mode does not wrap it again.
  const guard = h.hp.run; h.exit(); h.enter(); assert.equal(h.hp.run, guard);
});

test('Open failures L6: a layout whose study list is not the present URL\'s (a left route\'s late answer) is dropped', async () => {
  const a = { StudyInstanceUID: CURRENT }, b = { StudyInstanceUID: PRIOR };
  // From [A,B] to [B]: the old [A,B] layout (B included) is not laid out; [B] is.
  const h = recovery({ search: `?StudyInstanceUIDs=${PRIOR}` }); h.enter();
  assert.equal(h.hp.run({ studies: [a, b], activeStudy: a, displaySets: [1] }, '@ohif/hpCompare'), undefined);
  assert.equal(h.hp.run({ studies: [a, undefined], activeStudy: a, displaySets: [1] }, '@ohif/hpCompare'), undefined);
  assert.equal(h.runs.length, 0);
  assert.equal(h.hp.run({ studies: [b], activeStudy: b, displaySets: [1] }, 'p'), 'ran');
  // From [A,B] to [B,A]: same studies, another order - the old layout is not this route's.
  const r = recovery({ search: `?StudyInstanceUIDs=${PRIOR},${CURRENT}` }); r.enter();
  assert.equal(r.hp.run({ studies: [a, b], activeStudy: a, displaySets: [1] }, 'p'), undefined);
  assert.equal(r.hp.run({ studies: [b, a], activeStudy: b, displaySets: [1] }, 'p'), 'ran');
  // Without studies in the URL the guard stands aside.
  const n = recovery({ search: '' });
  assert.equal(n.hp.run({ studies: [a], activeStudy: a, displaySets: [1] }, 'p'), 'ran');
});

test('Open failures L7: the admitted exam scope decides which studies are current; the URL alone makes only the first current', async () => {
  const one = { StudyInstanceUID: CURRENT }, two = { StudyInstanceUID: PRIOR };
  const search = `?StudyInstanceUIDs=${CURRENT},${PRIOR}&kinExam=merged`;
  // A merged exam's URL also lists its prior's originals: without the admitted scope the second study is a prior.
  const u = recovery({ search }); u.enter();
  assert.equal(u.hp.run({ studies: [one, undefined], activeStudy: one, displaySets: [1] }, 'p'), 'ran');
  // With the scope admitted, both originals are current: the layout needs both.
  const h = recovery({ search }); h.window.KinViewerExamScope = { snapshot: () => ({}), role: () => 'current' }; h.enter();
  assert.equal(h.hp.run({ studies: [undefined, two], activeStudy: undefined, displaySets: [1] }, 'p'), undefined);
  assert.equal(h.hp.run({ studies: [one, undefined], activeStudy: one, displaySets: [1] }, 'p'), undefined);
  assert.equal(h.runs.length, 0);
  assert.equal(h.hp.run({ studies: [one, two], activeStudy: one, displaySets: [1] }, 'p'), 'ran');
});

test('Open failures L8: the record of failed studies is the document\'s: it outlives the route, counts a wait ended by leaving and reads outside the route', async () => {
  const h = recovery(); h.enter(); h.load(PRIOR, OTHER); h.calls[0].reject(http(500)); await flush();
  h.exit(); await flush();
  assert.deepEqual([...h.window.kinViewerFailedStudies()], [PRIOR]);
  h.enter(); assert.deepEqual([...h.window.kinViewerFailedStudies()], [PRIOR]); assert.equal(h.shown(), null);
  const other = h.load('1.2.840.99.9', '1.2.840.99.9.1'); h.calls[1].reject(http(500)); await flush();
  assert.equal(other.seen.error.status, 500); assert.deepEqual(h.delays(), []); assert.equal(h.shown(), null);
  assert.deepEqual([...h.window.kinViewerFailedStudies()], [PRIOR, '1.2.840.99.9']);
});
