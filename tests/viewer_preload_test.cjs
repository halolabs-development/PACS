'use strict';
// REQ-MG-PRELOAD-MEM -> RISK-PRELOAD-STALE-IDENTITY / RISK-PRELOAD-UNRECORDED-VIEW / RISK-PRELOAD-CROSS-SESSION
// -> TEST-MG-PRELOAD-VIEWER: the viewer's fetch under its session transport (worklist-v0/hpacs-lite/viewer-preload.js).
// No held frame reaches the viewer before the study's live check read for its current opening (gate + 열람 record on
// the server, revision compared here), and only from the copy that check was made against; a changed or refused study
// is dropped and read live. Every image read the viewer sends - by a public image route or the API's own - names its
// opening (opening contract 2026-10-29): one per document, a new one for studies shown again (patient tab, back/forward
// return) - each read live for it before what the document still holds can show, whatever form showed it (a frame, also
// queried, a rendering, a document, a preview; an object related to its study by the server's answer) - and none for
// business calls; an answer to a read asked before its study was opened again is never handed on under the new opening
// before that opening's own read; the worker hears the viewer is busy until the answer's body has ended.
const test = require('node:test');
const assert = require('node:assert/strict');
const { attach } = require('../worklist-v0/hpacs-lite/viewer-preload.js');

const ORIGIN = 'https://kin.test';
const STUDY = '1.2.840.9.1';
const PART = 'multipart/related; type="application/octet-stream"; boundary=b1';
const frameUrl = (n, study = STUDY) => `${ORIGIN}/dicom-web/studies/${study}/series/${study}.1/instances/${study}.1.1/frames/${n}`;
const bound = (extra = {}) => ({ method: 'GET', headers: new Headers({ 'X-KIN-Session': 'sess-1', Accept: PART, ...extra }) });

/** A window with a scripted preload worker: `held` maps study -> { revision, session, copy }; frames answer their path
 * from the held copy only, as preload-worker.js does (another copy: `stale`). */
function setup({ held = {}, network, shared = true, studies = null, page = false, transport = false } = {}) {
  const posted = [], sent = [], gates = { frame: null, query: null }, ends = [], through = [];
  class FakeSharedWorker {
    constructor(url, options) {
      assert.equal(url, '/worklist/hpacs-lite/preload-worker.js');
      assert.equal(options.name, 'kin-preload');
      const port = this.port = { start() {}, postMessage(message) {
        posted.push(message);
        if (gates.silent) return;                                        // a worker that stopped: it answers nothing
        const reply = value => queueMicrotask(() => port.onmessage({ data: { type: 'reply', id: message.id, ...value } }));
        if (message.type === 'query') {
          const answer = () => {
            const entry = held[message.uid];
            // `has`: the check's frame is one of the copy's (preload-worker.js) - every frame here unless the entry says not.
            reply({ held: entry && entry.session === message.session ? { revision: entry.revision, copy: entry.copy ?? 1, has: entry.has ?? true } : null });
          };
          // `gates.query`: the worker's answers to what it holds wait for it (its queue is busy).
          if (gates.query) gates.query.then(answer); else answer();
        } else if (message.type === 'frame') {
          const uid = /studies\/([0-9.]+)\//.exec(message.path)[1], entry = held[uid];
          const answer = () => {
            if (entry && entry.session === message.session && (entry.copy ?? 1) !== message.copy) reply({ bytes: null, stale: true });
            else reply(entry && entry.session === message.session ? { bytes: new TextEncoder().encode(`held ${entry.copy ?? 1} ${message.path}`).buffer, partType: entry.partType ?? PART } : { bytes: null });
          };
          // `gates.frame`: the worker's frame answers wait for it (a slow disk read).
          if (gates.frame) gates.frame.then(answer); else answer();
        }
      } };
    }
  }
  // Every listener of a type runs (the module and its worker part both listen to pagehide/pageshow).
  const handlers = {}, listeners = {}, timers = [];
  const win = { location: { origin: ORIGIN, href: ORIGIN + '/ohif/viewer' + (studies ? '?StudyInstanceUIDs=' + studies.join(',') : '') },
    SharedWorker: shared ? FakeSharedWorker : undefined, Headers, Response, ReadableStream, crypto: globalThis.crypto,
    document: page ? fakeDocument() : undefined, setInterval: (run, every) => { timers.push({ run, every }); return timers.length; },
    addEventListener: (type, run) => { (handlers[type] ??= []).push(run); listeners[type] = event => handlers[type].forEach(h => h(event)); } };
  const send = async (url, init) => {
    sent.push({ url, init, headers: new Headers(init.headers) });
    return network ? network(url, init) : new Response('live ' + url, { headers: { 'Content-Type': PART, 'X-KIN-Study-Revision': 'rev-now' } });
  };
  const preloadFetch = attach(win, send);
  // The page's own fetch: the session transport binds the request, then this module reads it (viewer-session.js).
  // `transport`: the real one (session-transport.js) over this module, as the viewer wires it - `ends` hears what it
  // tells the session's end (authFailure).
  if (transport) {
    const gate = { admits: () => true, onInvalidate() {}, capture: () => ({ session: 'sess-1' }) };
    const bound = require('../worklist-v0/hpacs-lite/session-transport.js').create({ gate, fetch: preloadFetch, authFailure: failure => ends.push(failure) });
    win.fetch = (url, init = {}) => { through.push(String(url)); return bound.fetch(url, init); };
  } else win.fetch = (url, init = {}) => {
    const headers = new Headers(init.headers); headers.set('X-KIN-Session', 'sess-1');
    return preloadFetch(url, { ...init, headers });
  };
  return { fetch: preloadFetch, posted, sent, listeners, win, timers, gates, ends, through, silence() { gates.silent = true; } };
}

/** Enough of a document for the back/forward return: the root's style, an alert with a button. */
function fakeDocument() {
  const element = tag => ({ tag, children: [], style: {}, attributes: {}, textContent: '', onclick: null,
    setAttribute(name, value) { this.attributes[name] = value; }, append(...nodes) { this.children.push(...nodes); },
    remove() { body.children.splice(body.children.indexOf(this), 1); } });
  const body = element('body');
  return { documentElement: element('html'), body, createElement: element };
}
const openingOf = s => s.headers.get('X-KIN-View-Opening');
const tick = () => new Promise(resolve => setTimeout(resolve, 5));

for (const [media, syntax] of [
  ['application/octet-stream', '1.2.840.10008.1.2.1'],
  ['image/jpeg', '1.2.840.10008.1.2.4.50'],
  ['image/jls', '1.2.840.10008.1.2.4.80'],
  ['image/jp2', '1.2.840.10008.1.2.4.90'],
  ['image/dicom-rle', '1.2.840.10008.1.2.5'],
]) {
  test(`cached ${media} reaches the viewer with its exact Content-Type after the live check`, async () => {
    const partType = `multipart/related; type="${media}; transfer-syntax=${syntax}"; boundary=codec`;
    const { fetch, sent } = setup({ held: { [STUDY]: { revision: 'rev-now', session: 'sess-1', partType } } });
    await (await fetch(frameUrl(1), bound())).arrayBuffer();
    const answer = await fetch(frameUrl(2), bound());
    assert.equal(answer.headers.get('Content-Type'), partType);
    assert.equal(await answer.text(), 'held 1 ' + new URL(frameUrl(2)).pathname);
    assert.equal(sent.length, 1, 'only the live check used the network');
    assert.equal(sent[0].headers.get('X-KIN-Preload'), 'check');
  });
}

test('a study the worker does not hold is read live, unchanged', async () => {
  const { fetch, sent, posted } = setup();
  const answer = await fetch(frameUrl(1), bound());
  assert.equal(await answer.text(), 'live ' + frameUrl(1));
  assert.equal(sent.length, 1);
  assert.equal(sent[0].headers.get('X-KIN-Preload'), null);
  assert.match(openingOf(sent[0]) ?? '', /^[0-9a-f-]{36}$/, 'the viewer\'s read names its opening, not a fetch');
  await fetch(frameUrl(2), bound());
  assert.equal(sent.length, 2, 'later frames of a study not held stay live');
  assert.equal(openingOf(sent[1]), openingOf(sent[0]), 'the reads of one opening name the same one');
  assert.equal(posted.filter(m => m.type === 'query').length, 1, 'the worker is asked once per study and document');
});

test('a held study: the first frame read is the live check, then frames come from memory', async () => {
  const { fetch, sent, posted, listeners } = setup({ held: { [STUDY]: { revision: 'rev-now', session: 'sess-1' } } });
  const first = await fetch(frameUrl(1), bound());
  assert.equal(await first.text(), 'live ' + frameUrl(1), 'the check read\'s own answer is the first frame');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].headers.get('X-KIN-Preload'), 'check');
  assert.ok(openingOf(sent[0]), 'the check read names the opening it records');
  assert.equal(sent[0].headers.get('X-KIN-Session'), 'sess-1', 'the transport\'s binding is kept');
  assert.ok(posted.some(m => m.type === 'open' && m.uid === STUDY));
  const second = await fetch(frameUrl(2), bound());
  assert.equal(sent.length, 1, 'no network read for a held frame after the check');
  assert.equal(second.status, 200);
  assert.equal(second.headers.get('Content-Type'), PART);
  assert.equal(await second.text(), 'held 1 ' + new URL(frameUrl(2)).pathname);
  // Leaving the window releases the study (it may be evicted once closed everywhere).
  listeners.pagehide();
  assert.equal(posted.at(-1).type, 'bye');
});

test('reads that arrive during the check wait for it; only one check read leaves', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const { fetch, sent } = setup({ held: { [STUDY]: { revision: 'rev-now', session: 'sess-1' } },
    network: async url => { await gate; return new Response('live ' + url, { headers: { 'X-KIN-Study-Revision': 'rev-now', 'Content-Type': PART } }); } });
  const reads = [1, 2, 3].map(n => fetch(frameUrl(n), bound()));
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(sent.length, 1);
  release();
  const texts = await Promise.all(reads.map(async r => (await r).text()));
  assert.equal(sent.length, 1);
  assert.deepEqual(texts.map(t => t.split(' ')[0]), ['live', 'held', 'held']);
});

test('a different revision at opening drops the held study and stays live', async () => {
  const { fetch, sent, posted } = setup({ held: { [STUDY]: { revision: 'rev-then', session: 'sess-1' } } });
  await fetch(frameUrl(1), bound());
  const evict = posted.find(m => m.type === 'evict');
  assert.equal(evict.uid, STUDY);
  assert.match(evict.reason, /달라/);
  assert.ok(!posted.some(m => m.type === 'open'));
  assert.equal(await (await fetch(frameUrl(2), bound())).text(), 'live ' + frameUrl(2));
  assert.equal(sent.length, 2);
});

// A 403 with an AUTH_* code is the gate's temporary refusal (an archive it could not observe, a busy session check),
// read by the one shared reading (session-transport.js refusal()): the held copy stays. Only a plain 403 or a 404 drops it.
test('a refused opening drops the held study; a server failure keeps it but shows nothing from memory', async () => {
  for (const [status, dropped, code] of [[403, true], [404, true], [503, false], [502, false], [403, false, 'AUTH_SOURCE_UNAVAILABLE'],
    [403, false, 'AUTH_SESSION_BUSY']]) {
    const { fetch, sent, posted } = setup({ held: { [STUDY]: { revision: 'rev-now', session: 'sess-1' } },
      network: async () => new Response('{}', { status, headers: { 'X-KIN-Study-Revision': 'rev-now', ...(code ? { 'X-KIN-Auth-Code': code } : {}) } }) });
    assert.equal((await fetch(frameUrl(1), bound())).status, status);
    assert.equal(posted.some(m => m.type === 'evict'), dropped, String(status));
    assert.ok(!posted.some(m => m.type === 'open'), String(status));
    await fetch(frameUrl(2), bound());
    assert.equal(sent.length, 2, `${status}: nothing from memory after a failed check`);
  }
});

test('a check read the archive could not answer a revision for stays live and keeps the held copy', async () => {
  const { fetch, sent, posted } = setup({ held: { [STUDY]: { revision: 'rev-now', session: 'sess-1' } },
    network: async url => new Response('live ' + url, { headers: { 'Content-Type': PART } }) });
  assert.equal((await fetch(frameUrl(1), bound())).status, 200);
  assert.ok(!posted.some(m => m.type === 'evict' || m.type === 'open'));
  await fetch(frameUrl(2), bound());
  assert.equal(sent.length, 2, 'nothing from memory without a matching revision');
});

test('a check read that is cut is asked again by the next frame read', async () => {
  let fail = true;
  const { fetch, sent, posted } = setup({ held: { [STUDY]: { revision: 'rev-now', session: 'sess-1' } },
    network: async url => { if (fail) throw new TypeError('network'); return new Response('live ' + url, { headers: { 'X-KIN-Study-Revision': 'rev-now' } }); } });
  await assert.rejects(fetch(frameUrl(1), bound()));
  fail = false;
  await fetch(frameUrl(1), bound());
  assert.equal(sent.filter(s => s.headers.get('X-KIN-Preload') === 'check').length, 2);
  assert.ok(posted.some(m => m.type === 'open'));
});

test('another session\'s store is never used; queries, other paths and methods go to the network', async () => {
  const { fetch, sent } = setup({ held: { [STUDY]: { revision: 'rev-now', session: 'sess-OTHER' } } });
  await fetch(frameUrl(1), bound());
  await fetch(frameUrl(2), bound());
  assert.equal(sent.length, 2);
  assert.ok(sent.every(s => s.headers.get('X-KIN-Preload') === null));
  const held = setup({ held: { [STUDY]: { revision: 'rev-now', session: 'sess-1' } } });
  await held.fetch(frameUrl(1), bound());
  await held.fetch(frameUrl(2) + '?accept=x', bound());
  await held.fetch(frameUrl(2), { ...bound(), method: 'HEAD' });
  await held.fetch(`${ORIGIN}/dicom-web/studies/${STUDY}/metadata`, bound());
  assert.equal(held.sent.length, 4);
});

test('the worker hears when this viewer waits on the network for images, and when it stops', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const { fetch, posted } = setup({ network: async url => { await gate; return new Response('x'); } });
  const one = fetch(`${ORIGIN}/dicom-web/studies/${STUDY}/metadata`, bound());
  const two = fetch(frameUrl(1), bound());
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.deepEqual(posted.filter(m => m.type === 'busy').map(m => m.busy), [true]);
  release();
  const answers = await Promise.all([one, two]);
  assert.deepEqual(posted.filter(m => m.type === 'busy').map(m => m.busy), [true], 'headers alone do not end the reading');
  for (const answer of answers) await answer.text();
  assert.deepEqual(posted.filter(m => m.type === 'busy').map(m => m.busy), [true, false]);
  await fetch(`${ORIGIN}/api/me`, bound());
  assert.equal(posted.filter(m => m.type === 'busy').length, 2, 'business API calls are not image loading');
});

test('busy lasts until a streaming body ends, and also ends when the body fails, is cancelled, or the read fails', async () => {
  const busy = posted => posted.filter(m => m.type === 'busy').map(m => m.busy);
  const streaming = () => {
    let controller;
    const body = new ReadableStream({ start(c) { controller = c; } });
    return { controller, response: () => new Response(body, { headers: { 'Content-Type': PART } }) };
  };
  // The body arrives in parts: busy until the last part, as the viewer consumes it.
  {
    const s = streaming();
    const { fetch, posted } = setup({ network: async () => s.response() });
    const answer = await fetch(frameUrl(1), bound());
    const reader = answer.body.getReader();
    s.controller.enqueue(new TextEncoder().encode('part 1'));
    assert.equal(new TextDecoder().decode((await reader.read()).value), 'part 1');
    await new Promise(resolve => setTimeout(resolve, 5));
    assert.deepEqual(busy(posted), [true], 'still reading: the body is open');
    s.controller.enqueue(new TextEncoder().encode('part 2'));
    s.controller.close();
    assert.equal(new TextDecoder().decode((await reader.read()).value), 'part 2');
    assert.equal((await reader.read()).done, true);
    assert.deepEqual(busy(posted), [true, false]);
  }
  // A body that fails midway (the connection drops) releases the reading.
  {
    const s = streaming();
    const { fetch, posted } = setup({ network: async () => s.response() });
    const answer = await fetch(frameUrl(1), bound());
    s.controller.error(new TypeError('network'));
    await assert.rejects(answer.arrayBuffer());
    assert.deepEqual(busy(posted), [true, false]);
  }
  // The viewer gives up on a body (a pane re-targeted): cancelled, released.
  {
    const s = streaming();
    const { fetch, posted } = setup({ network: async () => s.response() });
    const answer = await fetch(frameUrl(1), bound());
    await answer.body.cancel();
    assert.deepEqual(busy(posted), [true, false]);
  }
  // A read that fails before any answer, and a failure answer (whose body the viewer may never read), release at once.
  {
    const { fetch, posted } = setup({ network: async () => { throw new TypeError('network'); } });
    await assert.rejects(fetch(frameUrl(1), bound()));
    assert.deepEqual(busy(posted), [true, false]);
  }
  {
    const { fetch, posted } = setup({ network: async () => new Response('{}', { status: 503 }) });
    assert.equal((await fetch(frameUrl(1), bound())).status, 503);
    assert.deepEqual(busy(posted), [true, false]);
  }
});

test('a copy fetched again after Clear All or Retry is never shown under the earlier check: it gets a check of its own', async () => {
  const held = { [STUDY]: { revision: 'rev-now', session: 'sess-1', copy: 1 } };
  let live = 'rev-now';
  const { fetch, sent, posted } = setup({ held,
    network: async url => new Response('live ' + url, { headers: { 'Content-Type': PART, 'X-KIN-Study-Revision': live } }) });
  await fetch(frameUrl(1), bound());
  assert.equal(await (await fetch(frameUrl(2), bound())).text(), 'held 1 ' + new URL(frameUrl(2)).pathname);
  // Clear All, then Retry under the archive's new revision: the worker now holds copy 2 of r2.
  held[STUDY] = { revision: 'rev-r2', session: 'sess-1', copy: 2 };
  live = 'rev-r2';
  const third = await (await fetch(frameUrl(3), bound())).text();
  assert.equal(third, 'live ' + frameUrl(3), 'the replaced copy is not used under the earlier check');
  const checks = () => sent.filter(s => s.headers.get('X-KIN-Preload') === 'check').length;
  assert.equal(checks(), 1);
  // The next read checks the new copy live; it matches the archive now, so the new copy is used from then on.
  assert.equal(await (await fetch(frameUrl(4), bound())).text(), 'live ' + frameUrl(4));
  assert.equal(checks(), 2, 'a new check read for the new copy');
  assert.equal(await (await fetch(frameUrl(5), bound())).text(), 'held 2 ' + new URL(frameUrl(5)).pathname);
  // A use names the copy its check confirmed - each copy once.
  assert.deepEqual(posted.filter(m => m.type === 'open').map(m => [m.uid, m.copy, m.session]), [[STUDY, 1, 'sess-1'], [STUDY, 2, 'sess-1']]);
  // A new copy whose revision no longer matches the archive is dropped at its check and never shown.
  held[STUDY] = { revision: 'rev-r2', session: 'sess-1', copy: 3 };
  live = 'rev-r3';
  await fetch(frameUrl(6), bound());
  await fetch(frameUrl(7), bound());
  assert.ok(posted.some(m => m.type === 'evict' && m.uid === STUDY));
  assert.equal(await (await fetch(frameUrl(8), bound())).text(), 'live ' + frameUrl(8));
});

test('without a SharedWorker every image read still names its opening; business calls name none', async () => {
  const { fetch, sent } = setup({ shared: false });
  await fetch(frameUrl(1), bound());
  await fetch(`${ORIGIN}/dicom-web/studies/${STUDY}/metadata`, bound());
  await fetch(`${ORIGIN}/api/me`, bound());
  const [frame, metadata, business] = sent.map(openingOf);
  assert.ok(frame);
  assert.deepEqual([metadata, business], [frame, null]);
  assert.ok(sent.every(s => s.headers.get('X-KIN-Session') === 'sess-1'));
});

test('review R1: every image read of one document names one opening - queried renderings too; another document of the same session is another opening, also of a study it reads from memory', async () => {
  const held = { [STUDY]: { revision: 'rev-now', session: 'sess-1' } };
  const a = setup({ held });
  await a.fetch(frameUrl(1), bound());                                     // the check read
  await a.fetch(frameUrl(2), bound());                                     // from memory
  await a.fetch(frameUrl(2) + '?accept=x', bound());                       // a query: live, never from memory
  await a.fetch(`${ORIGIN}/instances/0a1b2c3d-4e5f6071-8293a4b5-c6d7e8f9-0a1b2c3d/frames/1/rendered?width=64`, bound());
  await a.fetch(`${ORIGIN}/api/me`, bound());
  const names = a.sent.map(openingOf);
  assert.deepEqual(names.slice(0, 3), Array(3).fill(names[0]), 'one opening for every image read of the document');
  assert.equal(names[3], null, 'business calls name none');
  a.listeners.pagehide();
  // The viewer closed and the study opened again at once, in a fresh document: a new opening, with its own check.
  const b = setup({ held });
  await b.fetch(frameUrl(1), bound());
  assert.equal(b.sent[0].headers.get('X-KIN-Preload'), 'check');
  assert.ok(openingOf(b.sent[0]) && openingOf(b.sent[0]) !== names[0], 'the reopen is another opening');
});

test('reenter: a study this document showed is read live for the new opening before anything shows, never from memory; one not shown here is not read; commit makes it the study\'s opening and its held copy is checked again', async () => {
  const OTHER = '1.2.840.9.2', LEFT = '1.2.840.9.3';
  const { fetch, sent } = setup({ held: { [STUDY]: { revision: 'rev-now', session: 'sess-1' } } });
  await fetch(frameUrl(1), bound());
  await fetch(frameUrl(2), bound());
  await fetch(frameUrl(1, LEFT), bound());                                 // a study of the scope being left
  const first = openingOf(sent[0]);
  assert.equal(sent.length, 2, 'the check read and the live study only');
  const entry = await fetch.reenter([STUDY, OTHER]);
  assert.ok(entry);
  const barrier = sent.slice(2);
  assert.equal(barrier.length, 1, 'one live read, of the study shown before; the other has no pixels here to show');
  assert.equal(barrier[0].url, frameUrl(2), 'its last frame read');
  assert.equal(barrier[0].headers.get('X-KIN-Preload'), null);
  assert.equal(barrier[0].headers.get('X-KIN-Session'), 'sess-1', 'bound by the session transport');
  assert.equal(barrier[0].headers.get('Accept'), PART);
  const next = openingOf(barrier[0]);
  assert.ok(next && next !== first);
  // Until the scope is shown, the current opening holds.
  await fetch(frameUrl(3), bound());
  assert.equal(sent.length, 3, 'still from memory under the earlier check');
  entry.commit();
  await fetch(frameUrl(4), bound());
  assert.deepEqual([sent[3].headers.get('X-KIN-Preload'), openingOf(sent[3])], ['check', next], 'checked again for the new opening');
  await fetch(frameUrl(5), bound());
  assert.equal(sent.length, 4, 'then from memory');
  await fetch(frameUrl(1, OTHER), bound());
  await fetch(frameUrl(2, LEFT), bound());
  await fetch(`${ORIGIN}/instances/0a1b2c3d-4e5f6071-8293a4b5-c6d7e8f9-0a1b2c3d/preview`, bound());
  assert.deepEqual(sent.slice(4).map(openingOf), [next, first, next],
    'the entered studies and the scope\'s unnamed reads take the new opening; a late read of a study left keeps its own');
});

test('reenter: a read that fails or is refused answers null and changes nothing; an entry never committed changes nothing; a study whose reads all failed showed nothing and is not read', async () => {
  let status = 503;
  const { fetch, sent } = setup({ network: async url => new Response('x ' + url, { status, headers: { 'Content-Type': PART } }) });
  assert.equal((await fetch(frameUrl(1), bound())).status, 503);
  assert.ok(await fetch.reenter([STUDY]), 'nothing of the study showed here: its own first read records it');
  assert.equal(sent.length, 1, 'no read again for a study whose only read failed');
  status = 200;
  await fetch(frameUrl(1), bound());
  const first = openingOf(sent.at(-1));
  for (const failing of [503, 401]) {
    status = failing;
    assert.equal(await fetch.reenter([STUDY]), null, String(failing));
  }
  status = 200;
  assert.ok(await fetch.reenter([STUDY]), 'recorded, but the tab never showed');
  await fetch(frameUrl(2), bound());
  assert.equal(openingOf(sent.at(-1)), first, 'the opening is unchanged');
  let cut = false;
  const thrown = setup({ network: async url => { if (cut) throw new TypeError('network'); return new Response('x ' + url, { headers: { 'Content-Type': PART } }); } });
  await thrown.fetch(frameUrl(1), bound());
  cut = true;
  assert.equal(await thrown.fetch.reenter([STUDY]), null, 'a read that does not reach the server records nothing');
});

test('back/forward: the kept page is hidden on leaving and shown only after the return\'s opening is recorded; when it cannot be, it stays hidden with a Retry', async () => {
  let status = 200;
  const s = setup({ studies: [STUDY], page: true, held: { [STUDY]: { revision: 'rev-now', session: 'sess-1' } },
    network: async url => new Response('live ' + url, { status, headers: { 'Content-Type': PART, 'X-KIN-Study-Revision': 'rev-now' } }) });
  await s.fetch(frameUrl(1), bound());
  const first = openingOf(s.sent[0]), root = s.win.document.documentElement;
  s.listeners.pagehide({ persisted: false });
  assert.equal(root.style.visibility, undefined, 'a page that is not kept is not touched');
  s.listeners.pageshow({ persisted: false });
  await tick();
  assert.equal(s.sent.length, 1, 'an ordinary show is no return');
  s.listeners.pagehide({ persisted: true });
  assert.equal(root.style.visibility, 'hidden');
  status = 503;
  s.listeners.pageshow({ persisted: true });
  await tick();
  assert.equal(root.style.visibility, 'hidden', 'no record, no pixels');
  const [alert] = s.win.document.body.children;
  assert.equal(alert.attributes.role, 'alert');
  assert.match(alert.children[0].textContent, /열람 기록/);
  const retry = alert.children[1];
  assert.equal(retry.textContent, 'Retry');
  status = 200;
  retry.onclick();
  await tick();
  assert.equal(root.style.visibility, '', 'shown after the return\'s opening was recorded');
  assert.equal(s.win.document.body.children.length, 0, 'the notice is gone');
  const reads = s.sent.slice(1);
  // Live reads, never from memory - and, of a study whose copy the page used, the copy's check for the return as well.
  assert.deepEqual(reads.map(r => [r.url, r.headers.get('X-KIN-Preload')]), [[frameUrl(1), 'check'], [frameUrl(1), 'check']]);
  const next = openingOf(reads[1]);
  assert.ok(next && next !== first && openingOf(reads[0]) !== first);
  assert.equal(await (await s.fetch(frameUrl(2), bound())).text(), 'held 1 ' + new URL(frameUrl(2)).pathname, 'the copy that read confirmed');
  assert.equal(s.sent.length, 3, 'no second check: the return\'s read was it');
});

const OBJECT_ID = '0a1b2c3d-4e5f6071-8293a4b5-c6d7e8f9-0a1b2c3d', OTHER_OBJECT = '1b2c3d4e-5f607182-93a4b5c6-d7e8f90a-1b2c3d4e';
const objectUrl = (kind, id = OBJECT_ID) => `${ORIGIN}/instances/${id}/${kind}`;
/** The server's image answers: an answer of a stored object names the study it recorded (`studyOf` the object ID). */
const answering = (studyOf = () => STUDY) => async url => {
  const object = /\/instances\/([0-9a-f-]+)\//.exec(new URL(url).pathname)?.[1];
  return new Response('live ' + url, { headers: { 'Content-Type': PART, ...(object ? { 'X-KIN-Study-UID': studyOf(object) } : {}) } });
};

test('review R1 of f455ba2: a study shown only by a queried frame, a rendering, a document or a preview is read live again for a new opening, and for a back/forward return before the kept page shows - with and without a worker', async () => {
  const forms = [frameUrl(1) + '?accept=x', frameUrl(1).replace('/frames/1', '/rendered'), objectUrl('pdf'), objectUrl('preview'),
    objectUrl('frames/1/rendered?width=64')];
  for (const shared of [false, true]) for (const url of forms) {
    const label = `${shared ? 'worker' : 'no worker'} ${new URL(url).pathname}${new URL(url).search}`;
    const s = setup({ shared, studies: [STUDY], page: true, network: answering() });
    assert.equal((await s.fetch(url, bound())).status, 200);
    const first = openingOf(s.sent[0]), root = s.win.document.documentElement;
    const entry = await s.fetch.reenter([STUDY]);
    assert.ok(entry, label);
    assert.equal(s.sent.length, 2, label + ': one live read before the scope shows');
    const again = s.sent[1];
    assert.equal(again.url, url, label + ': the read that showed the study');
    assert.equal(again.headers.get('X-KIN-Preload'), null, label);
    const next = openingOf(again);
    assert.ok(next && next !== first, label + ': named with the new opening');
    entry.commit();
    s.listeners.pagehide({ persisted: true });
    assert.equal(root.style.visibility, 'hidden', label);
    s.listeners.pageshow({ persisted: true });
    await tick();
    assert.equal(s.sent.length, 3, label + ': the return reads it live again');
    assert.equal(s.sent[2].url, url, label);
    assert.ok(![first, next, null].includes(openingOf(s.sent[2])), label + ': under the return\'s own opening');
    assert.equal(root.style.visibility, '', label + ': shown once that read was answered');
  }
});

test('review R1 of f455ba2: an object\'s answer relates it to its study - each study of a scope is read again for its own entry only, a study keeps its opening, and its frame read is the one read again', async () => {
  const OTHER = '1.2.840.9.2';
  const s = setup({ shared: false, studies: [STUDY, OTHER], network: answering(id => id === OBJECT_ID ? STUDY : OTHER) });
  await s.fetch(objectUrl('pdf'), bound());                                 // STUDY's document
  await s.fetch(objectUrl('preview', OTHER_OBJECT), bound());               // OTHER's preview
  const first = openingOf(s.sent[0]);
  const entry = await s.fetch.reenter([OTHER]);
  assert.deepEqual(s.sent.slice(2).map(r => r.url), [objectUrl('preview', OTHER_OBJECT)], 'only the entered study is read again');
  const next = openingOf(s.sent[2]);
  entry.commit();
  await s.fetch(objectUrl('pdf'), bound());
  await s.fetch(objectUrl('preview', OTHER_OBJECT), bound());
  assert.deepEqual(s.sent.slice(3).map(openingOf), [first, next], 'a late read of the study left keeps its opening');
  // A study shown by a frame and by its preview: the frame is read again, once.
  const f = setup({ shared: false, network: answering() });
  await f.fetch(frameUrl(1), bound());
  await f.fetch(objectUrl('preview'), bound());
  await f.fetch.reenter([STUDY]);
  assert.deepEqual(f.sent.slice(2).map(r => r.url), [frameUrl(1)]);
  // An object read no answer placed stands for the studies shown when it was made.
  const u = setup({ shared: false, studies: [STUDY], network: async url => new Response('x ' + url, { headers: { 'Content-Type': 'application/pdf' } }) });
  await u.fetch(objectUrl('pdf'), bound());
  await u.fetch.reenter([OTHER]);
  assert.equal(u.sent.length, 1, 'not for another study');
  await u.fetch.reenter([STUDY]);
  assert.deepEqual(u.sent.slice(1).map(r => r.url), [objectUrl('pdf')]);
  // Descriptions show no pixels: never the read a new opening reads again.
  const d = setup({ shared: false, network: answering() });
  await d.fetch(`${ORIGIN}/dicom-web/studies/${STUDY}/metadata`, bound());
  await d.fetch(objectUrl('tags'), bound());
  assert.ok(await d.fetch.reenter([STUDY]));
  assert.equal(d.sent.length, 2, 'nothing read again');
});

test('back/forward: the kept page also reads again a study it showed beside its address\'s (a comparison read under the scope)', async () => {
  const PRIOR = '1.2.840.9.4';
  const s = setup({ shared: false, studies: [STUDY], page: true });
  await s.fetch(frameUrl(1), bound());
  await s.fetch(frameUrl(1, PRIOR), bound());
  s.listeners.pagehide({ persisted: true });
  s.listeners.pageshow({ persisted: true });
  await tick();
  assert.deepEqual(s.sent.slice(2).map(r => r.url).sort(), [frameUrl(1), frameUrl(1, PRIOR)].sort());
  assert.equal(s.win.document.documentElement.style.visibility, '');
});

test('review R2 of f455ba2: the API\'s own image routes name the opening as the public ones do, with and without a worker, and a held study read by them is checked first; business calls under /api name none', async () => {
  const api = n => frameUrl(n).replace('/dicom-web/', '/api/dicom-web/');
  for (const shared of [false, true]) {
    const s = setup({ shared, network: answering() });
    const reads = [frameUrl(1), api(2), frameUrl(3).replace('/dicom-web/', '/api/image-relay/dicom-web/'),
      `${ORIGIN}/api/image-relay/instances/${OBJECT_ID}/frames/0/rendered`, `${ORIGIN}/api/instances/${OBJECT_ID}/preview`];
    for (const url of reads) assert.equal((await s.fetch(url, bound())).status, 200);
    await s.fetch(`${ORIGIN}/api/me`, bound());
    await s.fetch(`${ORIGIN}/api/dicom/lookup`, { method: 'POST', headers: new Headers({ 'X-KIN-Session': 'sess-1', 'Content-Type': 'application/json' }), body: '{}' });
    const names = s.sent.map(openingOf);
    assert.ok(names[0]);
    assert.deepEqual(names, [...Array(reads.length).fill(names[0]), null, null], shared ? 'worker' : 'no worker');
    // Read by an API route only, the study is read again for a new opening.
    const r = setup({ shared, network: answering() });
    await r.fetch(`${ORIGIN}/api/image-relay/instances/${OBJECT_ID}/pdf`, bound());
    await r.fetch.reenter([STUDY]);
    assert.equal(r.sent.length, 2);
    assert.ok(openingOf(r.sent[1]) && openingOf(r.sent[1]) !== openingOf(r.sent[0]));
  }
  const held = setup({ held: { [STUDY]: { revision: 'rev-now', session: 'sess-1' } } });
  await held.fetch(api(1), bound());
  assert.equal(held.sent[0].headers.get('X-KIN-Preload'), 'check');
  assert.equal(await (await held.fetch(api(2), bound())).text(), 'held 1 ' + new URL(frameUrl(2)).pathname, 'then from memory');
  assert.equal(held.sent.length, 1);
});

/** A network whose first read waits for `release()`; each answer says the opening it was read under. */
function holdingFirst({ names = true, revision = null } = {}) {
  let release, first = true;
  const gate = new Promise(resolve => { release = resolve; });
  const network = async (url, init) => {
    if (first) { first = false; await gate; }
    const object = /\/instances\/([0-9a-f-]+)\//.exec(new URL(url).pathname)?.[1];
    return new Response('live ' + new Headers(init.headers).get('X-KIN-View-Opening'), { headers: { 'Content-Type': PART,
      ...(object && names ? { 'X-KIN-Study-UID': STUDY } : {}), ...(revision ? { 'X-KIN-Study-Revision': revision } : {}) } });
  };
  return { network, release: () => release() };
}

test('review R1 of 137c2b7: a first read still unanswered when its study is opened again (A -> B -> A) is not handed on - it is read again under the new opening, and that answer is the one shown; with and without a worker, whatever the form', async () => {
  const OTHER = '1.2.840.9.2';
  const forms = [frameUrl(1), frameUrl(1) + '?accept=x', objectUrl('frames/1/rendered'), objectUrl('preview')];
  for (const shared of [false, true]) for (const url of forms) for (const names of [true, false]) {
    if (!names && !url.includes('/instances/')) continue;
    const label = `${shared ? 'worker' : 'no worker'} ${new URL(url).pathname}${new URL(url).search}${names ? '' : ' (answer names no study)'}`;
    const net = holdingFirst({ names });
    const s = setup({ shared, studies: [STUDY], network: net.network });
    const pending = s.fetch(url, bound());
    await tick();
    const first = openingOf(s.sent[0]);
    (await s.fetch.reenter([OTHER])).commit();
    (await s.fetch.reenter([STUDY])).commit();
    assert.equal(s.sent.length, 1, label + ': nothing of the study answered yet, nothing to read on entry');
    net.release();
    const answer = await pending;
    assert.equal(s.sent.length, 2, label + ': the earlier opening\'s answer is read again');
    assert.equal(s.sent[1].url, url, label);
    const next = openingOf(s.sent[1]);
    assert.ok(next && next !== first, label + ': under the new opening');
    assert.equal(await answer.text(), 'live ' + next, label + ': the answer handed on is the new opening\'s read');
    await (await s.fetch(frameUrl(2), bound())).text();
    assert.equal(openingOf(s.sent.at(-1)), next, label + ': the study\'s later reads name the same opening');
    if (shared) assert.equal(s.posted.filter(m => m.type === 'busy').at(-1).busy, false, label + ': the dropped answer ends its reading');
  }
  // Only left (A -> B), or an entry never committed: the study keeps its opening, and its late answer is handed on.
  for (const enter of [[OTHER], [STUDY]]) for (const shared of [false, true]) {
    const net = holdingFirst();
    const s = setup({ shared, studies: [STUDY], network: net.network });
    const pending = s.fetch(frameUrl(1), bound());
    await tick();
    const entry = await s.fetch.reenter(enter);
    if (enter[0] === OTHER) entry.commit();
    net.release();
    assert.equal(await (await pending).text(), 'live ' + openingOf(s.sent[0]));
    assert.equal(s.sent.length, 1, `${enter} ${shared}: no read again`);
  }
});

test('review R1 of 137c2b7: a study whose earlier read is answered while its entry reads other studies is read for the entry too, before it resolves', async () => {
  const OTHER = '1.2.840.9.2';
  let releaseFirst, releaseEntry;
  const firstGate = new Promise(resolve => { releaseFirst = resolve; }), entryGate = new Promise(resolve => { releaseEntry = resolve; });
  const s = setup({ shared: false, studies: [STUDY, OTHER], network: async (url, init) => {
    const opening = new Headers(init.headers).get('X-KIN-View-Opening');
    if (url === frameUrl(1)) { if (s.sent.length === 1) await firstGate; }
    else if (s.sent.length > 2) await entryGate;
    return new Response('live ' + opening, { headers: { 'Content-Type': PART } });
  } });
  const pending = s.fetch(frameUrl(1), bound());                     // STUDY's first read, unanswered
  await s.fetch(frameUrl(1, OTHER), bound());                        // OTHER shown
  const entering = s.fetch.reenter([STUDY, OTHER]);
  await tick();
  assert.deepEqual(s.sent.slice(2).map(r => r.url), [frameUrl(1, OTHER)], 'the study shown is read for the entry');
  releaseFirst();
  await pending;                                                     // answered under the scope still shown: STUDY shows now
  releaseEntry();
  assert.ok(await entering);
  const reads = s.sent.slice(2);
  assert.deepEqual(reads.map(r => r.url), [frameUrl(1, OTHER), frameUrl(1)], 'then STUDY too, before the entry resolved');
  assert.equal(openingOf(reads[1]), openingOf(reads[0]));
  assert.notEqual(openingOf(reads[0]), openingOf(s.sent[0]));
});

test('review R1 of 137c2b7: memory answers of a held study in flight across its new opening are not handed on before that opening\'s own check', async () => {
  const net = holdingFirst({ revision: 'rev-now' });
  const s = setup({ held: { [STUDY]: { revision: 'rev-now', session: 'sess-1' } }, studies: [STUDY], network: net.network });
  const reads = [1, 2, 3].map(n => s.fetch(frameUrl(n), bound()));    // 1 checks; 2 and 3 wait for that check
  await tick();
  assert.equal(s.sent.length, 1);
  const first = openingOf(s.sent[0]);
  (await s.fetch.reenter([STUDY])).commit();
  net.release();
  const texts = await Promise.all(reads.map(async r => (await r).text()));
  assert.equal(s.sent.length, 2, 'one check for the new opening');
  assert.equal(s.sent[1].headers.get('X-KIN-Preload'), 'check');
  const next = openingOf(s.sent[1]);
  assert.ok(next && next !== first);
  // Every answer handed on is the new opening's check read or the copy's memory after it - never the earlier check's
  // answer, never memory taken under the earlier check.
  for (const text of texts) assert.ok(text === 'live ' + next || text.startsWith('held 1 '), text);
  assert.deepEqual(kinds(s.posted, 'open'), [['open', STUDY, 1, 'sess-1']], 'used once, by the new opening\'s check');
});

// ── The viewer tells the worker which copy it uses, for which session, and when it leaves it ──
const OTHER_STUDY = '1.2.840.9.2';
const kinds = (posted, ...types) => posted.filter(m => types.includes(m.type)).map(m => [m.type, m.uid, m.copy, m.session]);

test('a use names the copy and session its check confirmed: the check frame when held, else the first frame from memory; a live-only study is no use', async () => {
  const held = { [STUDY]: { revision: 'rev-now', session: 'sess-1', copy: 4 }, [OTHER_STUDY]: { revision: 'rev-now', session: 'sess-1', copy: 7, has: false } };
  const { fetch, posted } = setup({ held });
  await (await fetch(frameUrl(1), bound())).text();
  assert.deepEqual(kinds(posted, 'open'), [['open', STUDY, 4, 'sess-1']], 'the held check frame is a use');
  assert.equal(posted.find(m => m.type === 'query').path, new URL(frameUrl(1)).pathname, 'the worker is told which frame the check reads');
  // Another split part's frame checked live: no use until a frame of the copy comes from memory.
  await (await fetch(frameUrl(1, OTHER_STUDY), bound())).text();
  assert.equal(kinds(posted, 'open').length, 1);
  await (await fetch(frameUrl(2, OTHER_STUDY), bound())).text();
  await (await fetch(frameUrl(3, OTHER_STUDY), bound())).text();
  assert.deepEqual(kinds(posted, 'open'), [['open', STUDY, 4, 'sess-1'], ['open', OTHER_STUDY, 7, 'sess-1']], 'once, at the first frame from memory');
  // A study the worker does not hold is no use.
  const live = setup();
  await (await live.fetch(frameUrl(1), bound())).text();
  assert.equal(kinds(live.posted, 'open').length, 0);
});

test('a new opening shown leaves the earlier opening\'s copies and confirms its own again; an abandoned switch leaves nothing; the last tab closing', async () => {
  const held = { [STUDY]: { revision: 'rev-now', session: 'sess-1', copy: 2 }, [OTHER_STUDY]: { revision: 'rev-now', session: 'sess-1', copy: 3 } };
  const { fetch, posted } = setup({ held, studies: [STUDY] });
  await (await fetch(frameUrl(1), bound())).text();
  await (await fetch(frameUrl(1, OTHER_STUDY), bound())).text();    // a comparison shown with it: each copy counts
  assert.deepEqual(kinds(posted, 'open').map(o => o[1]), [STUDY, OTHER_STUDY]);
  await fetch.reenter([OTHER_STUDY]);                                 // not committed: the switch did not happen
  assert.deepEqual(kinds(posted, 'close'), []);
  (await fetch.reenter([OTHER_STUDY])).commit();                      // another scope shown (another patient, or another
  // exam of the same original): every copy of the earlier opening is left - one the new scope shows is used again only
  // when its own check confirms it.
  assert.deepEqual(kinds(posted, 'close'), [['close', STUDY, 2, 'sess-1'], ['close', OTHER_STUDY, 3, 'sess-1']]);
  await (await fetch(frameUrl(2, OTHER_STUDY), bound())).text();
  assert.deepEqual(kinds(posted, 'open').map(o => o[1]), [STUDY, OTHER_STUDY, OTHER_STUDY]);
  fetch.leave();                                                      // the last patient tab closed
  assert.deepEqual(kinds(posted, 'close').slice(2), [['close', OTHER_STUDY, 3, 'sess-1']]);
  fetch.leave();
  assert.equal(kinds(posted, 'close').length, 3, 'left once');
});

test('a check left behind by a new opening or by leaving the page opens and drops nothing; the return checks again', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let revision = 'rev-now';
  const held = { [STUDY]: { revision: 'rev-now', session: 'sess-1', copy: 1 } };
  const s = setup({ held, studies: [STUDY], network: async url => { await gate; return new Response('live ' + url, { headers: { 'Content-Type': PART, 'X-KIN-Study-Revision': revision } }); } });
  const pending = s.fetch(frameUrl(1), bound());
  await tick();
  s.listeners.pagehide({ persisted: true });
  release();
  await (await pending).text();
  assert.deepEqual(kinds(s.posted, 'open', 'evict'), [], 'the check finished after the page was left');
  assert.equal(s.posted.filter(m => m.type === 'bye').length, 1);
  s.listeners.pageshow({ persisted: false });
  assert.deepEqual(kinds(s.posted, 'open'), [], 'a return re-sends no use before its own check');
  // A changed copy found by a check whose opening was replaced is not dropped by it.
  revision = 'rev-other';
  const t = setup({ held, studies: [STUDY], network: async url => { await tick(); return new Response('live ' + url, { headers: { 'Content-Type': PART, 'X-KIN-Study-Revision': revision } }); } });
  const late = t.fetch(frameUrl(1), bound());
  await new Promise(resolve => setTimeout(resolve, 0));
  (await t.fetch.reenter([STUDY])).commit();
  await (await late).text();
  // The read asked under the earlier opening is read again under the new one (its own check): that check, not the
  // earlier one, drops the copy it checked - one drop, naming it.
  const checksSent = t.sent.filter(r => r.headers.get('X-KIN-Preload') === 'check');
  assert.equal(checksSent.length, 2);
  assert.notEqual(openingOf(checksSent[0]), openingOf(checksSent[1]));
  assert.deepEqual(kinds(t.posted, 'evict'), [['evict', STUDY, 1, 'sess-1']], 'one drop: the earlier opening\'s check drops nothing');
});

test('while shown, the document says every ten minutes which copies it still uses; after leaving, nothing', async () => {
  const held = { [STUDY]: { revision: 'rev-now', session: 'sess-1', copy: 5 } };
  const s = setup({ held, studies: [STUDY] });
  await (await s.fetch(frameUrl(1), bound())).text();
  await (await s.fetch(frameUrl(2), bound())).text();                // the worker is started by the first read
  const beat = s.timers.find(timer => timer.every === 10 * 60 * 1000);
  assert.ok(beat, 'one ten-minute timer');
  beat.run();
  assert.deepEqual(kinds(s.posted, 'using'), [['using', STUDY, 5, 'sess-1']]);
  s.fetch.leave();
  beat.run();
  assert.equal(kinds(s.posted, 'using').length, 1);
});

test('a check still under way when another scope is shown or the last tab closes opens and drops nothing', async () => {
  for (const [end, status] of [['switch', 200], ['switch', 403], ['leave', 200], ['leave', 403]]) {
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const held = { [STUDY]: { revision: 'rev-now', session: 'sess-1', copy: 1 } };
    const s = setup({ held, studies: [STUDY], network: async url => { await gate;
      return new Response('live ' + url, { status, headers: { 'Content-Type': PART, 'X-KIN-Study-Revision': 'rev-now' } }); } });
    const pending = s.fetch(frameUrl(1), bound());
    await tick();
    if (end === 'switch') (await s.fetch.reenter([OTHER_STUDY])).commit(); else s.fetch.leave();
    release();
    await (await pending).text();
    await tick();
    assert.deepEqual(kinds(s.posted, 'open', 'evict'), [], end + ' ' + status);
  }
});

/** A page that used copy `copy` of STUDY (frames 1 and 2 read) and was then left for the back/forward cache. */
async function leftPage({ copy = 6, network, transport = false } = {}) {
  const held = { [STUDY]: { revision: 'rev-now', session: 'sess-1', copy } };
  const s = setup({ held, studies: [STUDY], page: true, network, transport });
  await (await s.win.fetch(frameUrl(1), bound())).text();
  await (await s.win.fetch(frameUrl(2), bound())).text();
  assert.deepEqual(kinds(s.posted, 'open'), [['open', STUDY, copy, 'sess-1']]);
  s.listeners.pagehide({ persisted: true });
  assert.equal(s.posted.at(-1).type, 'bye');
  return { s, held, root: s.win.document.documentElement, before: s.sent.length };
}
/** A network that answers as the server does, each read waiting for `release()` once `hold()` was called. */
function gated(answer = url => new Response('live ' + url, { headers: { 'Content-Type': PART, 'X-KIN-Study-Revision': 'rev-now' } })) {
  let gate = null, open = null;
  return { network: async (url, init) => { if (gate) await gate; return answer(url, init); },
    hold() { gate = new Promise(resolve => { open = resolve; }); }, release() { gate = null; open?.(); } };
}

test('a back/forward return uses the copy again by one read: the page\'s own fetch records the return\'s opening and checks the copy the page left, without a frame read', async () => {
  const { s, root, before } = await leftPage();
  s.listeners.pageshow({ persisted: true });
  for (let i = 0; i < 20 && kinds(s.posted, 'open').length < 2; i++) await tick();
  assert.deepEqual(kinds(s.posted, 'open'), [['open', STUDY, 6, 'sess-1'], ['open', STUDY, 6, 'sess-1']], 'used again, the same copy');
  const after = s.sent.slice(before);
  assert.deepEqual(after.map(r => [r.url, r.headers.get('X-KIN-Preload'), r.headers.get('X-KIN-Session')]), [[frameUrl(2), 'check', 'sess-1']],
    'one read: the frame it last showed, live, bound to the session, marked as the check');
  assert.ok(openingOf(after[0]) && openingOf(after[0]) !== openingOf(s.sent[0]), 'under the return\'s opening');
  assert.equal(root.style.visibility, '', 'shown');
  assert.equal(await (await s.win.fetch(frameUrl(1), bound())).text(), 'held 6 ' + new URL(frameUrl(1)).pathname, 'no further check');
  assert.equal(s.sent.length, before + 1);
});

test('a return left behind - the last tab closed, another opening shown, the page left again - shows, uses and drops nothing when its reads come back', async () => {
  for (const [how, status] of [['leave', 200], ['leave', 403], ['switch', 200], ['switch', 403], ['left again', 200], ['left again', 404]]) {
    let away = false;                                                    // the page reads its frames while all is well
    const net = gated(url => new Response('live ' + url, { status: away ? status : 200, headers: { 'Content-Type': PART, 'X-KIN-Study-Revision': 'rev-now' } }));
    const { s, root } = await leftPage({ network: net.network });
    away = true; net.hold();
    s.listeners.pageshow({ persisted: true });
    await tick();
    const posted = s.posted.length;
    if (how === 'leave') s.fetch.leave();                              // the last patient tab closed while the return's read was out
    else if (how === 'left again') s.listeners.pagehide({ persisted: true });
    else (await s.fetch.reenter([OTHER_STUDY])).commit();               // another patient shown meanwhile (nothing of it to read again)
    const visible = root.style.visibility, notices = s.win.document.body.children.length;
    net.release();
    for (let i = 0; i < 10; i++) await tick();
    assert.deepEqual(kinds(s.posted.slice(posted), 'open', 'evict'), [], `${how} ${status}: no use, no drop`);
    assert.deepEqual([root.style.visibility, s.win.document.body.children.length], [visible, notices], `${how} ${status}: the late answer changes no screen, also when it failed`);
    // What ended the return owns the screen: an empty viewer or another patient shows; a page left again stays hidden.
    assert.equal(visible, how === 'left again' ? 'hidden' : '', how);
    if (how === 'left again') {
      // Its next return starts over, with what the page used before it was first left.
      s.listeners.pageshow({ persisted: true });
      for (let i = 0; i < 10; i++) await tick();
      if (status === 200) assert.deepEqual(kinds(s.posted.slice(posted), 'open'), [['open', STUDY, 6, 'sess-1']], 'the second return uses the copy');
      else assert.equal(root.style.visibility, 'hidden', 'a return that could not be recorded stays hidden');
    }
  }
});

test('a return uses again only the very copy the page left: a later copy of the study is neither used nor dropped by it, and is checked by the next frame read', async () => {
  for (const [changed, revision] of [['another copy', 'rev-now'], ['another copy', 'rev-other'], ['another session', 'rev-now'], ['gone', 'rev-now']]) {
    let away = false;
    const net = gated(url => new Response('live ' + url, { headers: { 'Content-Type': PART, 'X-KIN-Study-Revision': away ? revision : 'rev-now' } }));
    const { s, held, root, before } = await leftPage({ network: net.network });
    away = true;
    if (changed === 'another copy') held[STUDY] = { revision: 'rev-now', session: 'sess-1', copy: 7 };      // fetched again meanwhile
    if (changed === 'another session') held[STUDY] = { revision: 'rev-now', session: 'sess-2', copy: 6 };
    if (changed === 'gone') delete held[STUDY];
    const posted = s.posted.length;
    s.listeners.pageshow({ persisted: true });
    for (let i = 0; i < 10; i++) await tick();
    assert.equal(root.style.visibility, '', changed + ': the return is recorded and shown');
    assert.deepEqual(kinds(s.posted.slice(posted), 'open', 'evict', 'close'), [], changed + ' ' + revision + ': the return opens and drops nothing');
    assert.equal(s.sent.length, before + 1, changed + ': one live read');
  }
  // The return does not wait for the worker: one that never answers leaves the page shown and the copy simply not used.
  const silent = await leftPage();
  const posted = silent.s.posted.length;
  silent.s.silence();
  silent.s.listeners.pageshow({ persisted: true });
  for (let i = 0; i < 10; i++) await tick();
  assert.equal(silent.root.style.visibility, '', 'shown although the worker said nothing');
  assert.deepEqual(kinds(silent.s.posted.slice(posted), 'open', 'evict'), []);
  // The next frame read checks the copy held now, for itself.
  const { s, held } = await leftPage();
  held[STUDY] = { revision: 'rev-now', session: 'sess-1', copy: 7 };
  s.listeners.pageshow({ persisted: true });
  for (let i = 0; i < 10; i++) await tick();
  const opens = kinds(s.posted, 'open').length;
  await (await s.win.fetch(frameUrl(1), bound())).text();
  assert.equal(s.sent.at(-1).headers.get('X-KIN-Preload'), 'check');
  assert.deepEqual(kinds(s.posted, 'open').slice(opens), [['open', STUDY, 7, 'sess-1']]);
});

test('a return whose worker answers only after the read has come in still uses the copy again - while the return\'s opening is the view shown, never under another', async () => {
  for (const moved of [false, true]) {
    const { s, root } = await leftPage();
    let answer;
    s.gates.query = new Promise(resolve => { answer = resolve; });      // the worker is slow to say what it holds
    const posted = s.posted.length;
    s.listeners.pageshow({ persisted: true });
    for (let i = 0; i < 10; i++) await tick();
    assert.equal(root.style.visibility, '', 'shown without waiting for the worker');
    assert.deepEqual(kinds(s.posted.slice(posted), 'open'), [], 'not used yet: the worker has not named the copy');
    if (moved) s.fetch.leave();                                         // the last patient tab closed before it answered
    s.gates.query = null; answer();
    for (let i = 0; i < 10; i++) await tick();
    // Shown and still the view: the copy on screen is in use again (it cannot be removed for space under the reader).
    assert.deepEqual(kinds(s.posted.slice(posted), 'open'), moved ? [] : [['open', STUDY, 6, 'sess-1']], 'moved=' + moved);
    if (!moved) {
      assert.equal(await (await s.win.fetch(frameUrl(1), bound())).text(), 'held 6 ' + new URL(frameUrl(1)).pathname, 'no further check');
      assert.equal(kinds(s.posted.slice(posted), 'open').length, 1, 'used once');
    }
  }
});
test('a return\'s check whose body is cut, or whose revision is not the copy\'s, is no use of the copy', async () => {
  let cut = false;
  const { s, root } = await leftPage({ network: async url => new Response(cut
    ? new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('par')); c.error(new TypeError('cut')); } }) : 'live ' + url,
    { headers: { 'Content-Type': PART, 'X-KIN-Study-Revision': 'rev-now' } }) });
  const posted = s.posted.length;
  cut = true;
  s.listeners.pageshow({ persisted: true });
  for (let i = 0; i < 10; i++) await tick();
  assert.deepEqual(kinds(s.posted.slice(posted), 'open'), [], 'a cut body confirms nothing');
  assert.equal(root.style.visibility, 'hidden', 'and records no return: the page stays hidden with its Retry');
  cut = false;
  s.win.document.body.children[0].children[1].onclick();
  for (let i = 0; i < 10; i++) await tick();
  assert.deepEqual(kinds(s.posted.slice(posted), 'open'), [['open', STUDY, 6, 'sess-1']]);
  assert.equal(root.style.visibility, '');
});

test('a return\'s read is the page\'s own fetch: an ended session answered to it reaches that session\'s end, also when the view has moved on meanwhile', async () => {
  // Every read a return sends passes the session transport (none goes under it, where an ended session is not heard).
  const well = await leftPage({ transport: true });
  const passed = well.s.through.length;
  well.s.listeners.pageshow({ persisted: true });
  for (let i = 0; i < 20 && kinds(well.s.posted, 'open').length < 2; i++) await tick();
  await tick();
  assert.deepEqual(well.s.sent.slice(well.before).map(r => r.url), well.s.through.slice(passed), 'what reached the network is what the transport sent');
  assert.equal(well.s.sent.length, well.before + 1);
  for (const moved of [false, true]) for (const [status, code] of [[401, 'AUTH_SESSION_ENDED'], [403, 'AUTH_SESSION_MISMATCH']]) {
    let ended = false;
    const net = gated(url => ended ? new Response('{}', { status, headers: { 'X-KIN-Auth-Code': code } })
      : new Response('live ' + url, { headers: { 'Content-Type': PART, 'X-KIN-Study-Revision': 'rev-now' } }));
    const { s, root } = await leftPage({ network: net.network, transport: true });
    ended = true; net.hold();
    const posted = s.posted.length;
    s.listeners.pageshow({ persisted: true });
    await tick();
    if (moved) s.fetch.leave();
    net.release();
    for (let i = 0; i < 10; i++) await tick();
    assert.deepEqual(s.ends, [{ session: 'sess-1', status, code }], `${status} ${code} moved=${moved}: told to the session's end once`);
    assert.deepEqual(kinds(s.posted.slice(posted), 'open', 'evict'), [], 'no use, no drop');
    if (!moved) assert.equal(root.style.visibility, 'hidden', 'an unrecorded return shows nothing');
  }
});

test('a frame the worker answers after its view ended is not handed on from memory: it is read live, or checked again for the opening shown now', async () => {
  for (const how of ['leave', 'left', 'switch']) {
    const held = { [STUDY]: { revision: 'rev-now', session: 'sess-1', copy: 3 } };
    const s = setup({ held, studies: [STUDY], page: true });
    await (await s.fetch(frameUrl(1), bound())).text();
    let answer;
    s.gates.frame = new Promise(resolve => { answer = resolve; });      // the worker is slow to read frame 2 from its disk
    const pending = s.fetch(frameUrl(2), bound());
    await tick();
    if (how === 'leave') s.fetch.leave();
    else if (how === 'left') s.listeners.pagehide({ persisted: true });
    else (await s.fetch.reenter([STUDY])).commit();
    const opens = kinds(s.posted, 'open').length;
    s.gates.frame = null; answer();
    const text = await (await pending).text();
    if (how === 'switch') {
      // The new opening's own check came first; the frame is the copy's only after it.
      assert.equal(s.sent.filter(r => r.headers.get('X-KIN-Preload') === 'check').length, 2, how);
      assert.ok(text === 'live ' + frameUrl(2) || text.startsWith('held 3 '), how + ': ' + text);
    } else {
      assert.equal(text, 'live ' + frameUrl(2), how + ': read live, never the held bytes');
      assert.equal(s.sent.at(-1).headers.get('X-KIN-Preload'), null, how + ': no check of a view that shows nothing');
      assert.equal(kinds(s.posted, 'open').length, opens, how + ': no use');
      // A straggler read started after the view ended is the same: live, no check, no use.
      assert.equal(await (await s.fetch(frameUrl(3), bound())).text(), 'live ' + frameUrl(3), how);
      assert.equal(s.sent.at(-1).headers.get('X-KIN-Preload'), null, how);
      assert.equal(kinds(s.posted, 'open').length, opens, how);
    }
  }
});

test('a check read whose body is cut after its headers confirms nothing: no use, the next frame is checked live again', async () => {
  let cut = true;
  const held = { [STUDY]: { revision: 'rev-now', session: 'sess-1', copy: 1 } };
  const { fetch, posted, sent } = setup({ held, network: async url => new Response(cut
    ? new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('par')); c.error(new TypeError('cut')); } }) : 'live ' + url,
    { headers: { 'Content-Type': PART, 'X-KIN-Study-Revision': 'rev-now' } }) });
  await assert.rejects(async () => (await fetch(frameUrl(1), bound())).text());
  assert.deepEqual(kinds(posted, 'open'), []);
  cut = false;
  assert.equal(await (await fetch(frameUrl(2), bound())).text(), 'live ' + frameUrl(2), 'checked live again, not from memory');
  assert.equal(sent.filter(r => r.headers.get('X-KIN-Preload') === 'check').length, 2);
  assert.deepEqual(kinds(posted, 'open'), [['open', STUDY, 1, 'sess-1']]);
});
