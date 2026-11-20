'use strict';
// REQ-MG-PRELOAD-CACHE -> RISK-PRELOAD-STARVES-READING / RISK-PRELOAD-CROSS-SESSION / RISK-PRELOAD-UNRECORDED-VIEW
// -> TEST-MG-PRELOAD-WORKER: the preload SharedWorker (worklist-v0/hpacs-lite/preload-worker.js) run as written, in a VM
// context with the browser APIs it uses, against a scripted server. What is checked is the worker's contract: every byte
// is an ordinary bound frame read (gate and 열람 record are the server's), reading pauses the queue, a session never sees
// another session's store, and an ended session drops its key and keeps ciphertext.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const zlib = require('node:zlib');

const DIR = path.join(__dirname, '..', 'worklist-v0', 'hpacs-lite');
const STUDY = '1.2.840.9.1', OTHER = '1.2.840.9.2';
const PART = 'multipart/related; type="application/octet-stream"; boundary=b1';
const multipart = payload => Buffer.concat([Buffer.from('--b1\r\nContent-Type: application/octet-stream\r\n\r\n'),
  Buffer.from(payload), Buffer.from('\r\n--b1--')]);
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
async function until(check, what) {
  for (let i = 0; i < 400; i++) { if (check()) return; await tick(); }
  assert.fail('timed out waiting for ' + what);
}

/** The metadata of a study: one two-frame object and one single-frame object, and a non-image object. */
function metadata(study) {
  const item = (series, sop, frames) => ({ '0020000E': { Value: [series] }, '00080018': { Value: [sop] },
    ...(frames ? { '00280008': { Value: [frames] } } : {}), '7FE00010': { BulkDataURI: 'x' } });
  return [item(study + '.1', study + '.1.1', 2), item(study + '.2', study + '.2.1', null),
    { '0020000E': { Value: [study + '.3'] }, '00080018': { Value: [study + '.3.1'] } }];
}

// The adapter double proves control flow only. preload_disk_browser_test.cjs exercises real Chromium IndexedDB.
function memoryDisk() {
  const frames = new Map(), studies = new Map(), deleted = [];
  return { frames, studies, deleted,
    async list() { return { frames: structuredClone([...frames.values()]), studies: structuredClone([...studies.values()]) }; },
    async get(id) { return structuredClone(frames.get(id) || null); },
    async write(puts = {}, deletes = {}) {
      for (const [name, map] of [['frames', frames], ['studies', studies]]) {
        for (const id of deletes[name] || []) { map.delete(id); deleted.push(id); }
        for (const value of puts[name] || []) map.set(value.entryId || value.manifestId, structuredClone(value));
      }
    },
    // As preload-disk.js: a live study record keeps the frames it lists; an expired one takes them; a frame no live record
    // lists goes at its own expiry.
    async sweep(now) {
      let removed=0; const live=new Set(), gone=new Set();
      for (const [id, value] of studies) { if (value.expiresAt > now) (value.frameIds||[]).forEach(f=>live.add(f)); else { (value.frameIds||[]).forEach(f=>gone.add(f)); studies.delete(id); deleted.push(id); removed++; } }
      for (const [id, value] of frames) if (!live.has(id) && (gone.has(id) || value.expiresAt <= now)) { frames.delete(id); deleted.push(id); removed++; }
      return removed;
    },
    async estimate() { return {usage: [...frames.values(), ...studies.values()].reduce((n,r)=>n+r.ct.byteLength,0), quota: Infinity}; },
  };
}
const { webcrypto, randomBytes } = require('node:crypto');
const KEY = randomBytes(32), SERVER_START = Date.parse('2026-10-30T00:00:00Z');
function boot({ diskGb = 0.25, respond, disk = memoryDisk(), skew = 0, keyResponse, unavailableDisk = false } = {}) {
  const requests = [], timers = [], imports = [], decryptKeys = [];
  // `clock` is the server's time and the time that really passes (performance.now()); the PC's own clock reads `skew`
  // off it, and `setSkew` is someone setting the PC clock while the worker runs.
  let clock = SERVER_START;
  const me = () => new Response(JSON.stringify({ kind: 'member', preloadDiskGb: diskGb }), { headers: { 'Content-Type': 'application/json' } });
  const images = respond || (async url => {
    const study = /\/studies\/([0-9.]+)\//.exec(url)[1];
    if (url.endsWith('/metadata')) return new Response(JSON.stringify(metadata(study)), { headers: { 'Content-Type': 'application/dicom+json' } });
    const body = zlib.gzipSync(Buffer.from('--b1\r\nContent-Type: application/octet-stream\r\n\r\nframe ' + url + '\r\n--b1--'));
    return new Response(body, { headers: { Date: new Date(clock).toUTCString(), 'Content-Length': String(body.length), 'Content-Type': 'application/gzip', 'X-KIN-Part-Type': PART, 'X-KIN-Study-Revision': 'orthanc-study:s@1' } });
  });
  const server = (url, init) => url === '/api/me' ? me() : url === '/api/preload/cache-key'
    ? keyResponse ? keyResponse(init) : new Response(JSON.stringify({keyId:'key-A', key:KEY.toString('base64'),serverTime:new Date(clock).toISOString()})) : images(url, init);
  let gate = null;
  const context = {
    navigator: {storage:{estimate:()=>disk.estimate()}}, Blob, Response, DecompressionStream, AbortController, URL, URLSearchParams, Headers, setTimeout, console,
    TextEncoder, TextDecoder, atob, Uint8Array, Date: class extends Date { static now(){return clock+skew;} },
    performance: { now: () => clock - SERVER_START },
    crypto: { randomUUID:()=>webcrypto.randomUUID(), getRandomValues:b=>webcrypto.getRandomValues(b),
      subtle: { encrypt:(...a)=>webcrypto.subtle.encrypt(...a),
        decrypt:(...a)=> { decryptKeys.push(a[1]); return webcrypto.subtle.decrypt(...a); },
        importKey: async (...args)=> { const key = await webcrypto.subtle.importKey(...args); imports.push({raw:args[1], key}); return key; } } },
    setInterval: fn => { timers.push(fn); return 1; },
    fetch: async (url, init) => {
      requests.push({ url, init });
      if (gate && !url.startsWith('/api/')) await gate;
      if (init.signal?.aborted) throw new DOMException('aborted', 'AbortError');
      return server(url, init);
    },
    importScripts: (...names) => {
      for (const name of names) vm.runInContext(fs.readFileSync(path.join(DIR, name), 'utf8'), context);
      context.KinPreloadDisk = {...context.KinPreloadDisk, create:()=>unavailableDisk ? {...disk,list:async()=>{throw new Error('blocked');}} : disk};
    },
  };
  context.self = context;
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(DIR, 'preload-worker.js'), 'utf8'), context);
  const connect = () => {
    const port = { received: [], postMessage(message) { this.received.push(structuredClone(message)); }, start() {} };
    context.onconnect({ ports: [port] });
    port.send = data => port.onmessage({ data });
    port.state = () => [...port.received].reverse().find(m => m.type === 'state');
    port.ask = async data => {
      const id = Math.random(); port.send({ ...data, id });
      await until(() => port.received.some(m => m.type === 'reply' && m.id === id), data.type + ' reply');
      return port.received.find(m => m.type === 'reply' && m.id === id);
    };
    return port;
  };
  const reads = () => requests.filter(r => !r.url.startsWith('/api/'));
  return { requests, reads, connect, disk, imports, decryptKeys, advance:ms=>{clock+=ms;}, now:()=>clock, setSkew:ms=>{skew=ms;}, sweep:()=>timers.forEach(fn=>fn()),
    hold: () => { let open; gate = new Promise(resolve => { open = resolve; }); return () => { gate = null; open(); }; } };
}

const statusOf = (port, uid) => port.state()?.studies.find(s => s.uid === uid);

test('Preload fetches metadata, then each object\'s first frame, then the rest - every read bound, no-store, stored form', async () => {
  const { requests, reads, connect } = boot();
  const list = connect();
  list.send({ type: 'hello', role: 'list' });
  list.send({ type: 'add', session: 'sess-1', studies: [{ uid: STUDY, label: 'SYN-1 · Synthetic^Patient' }] });
  await until(() => statusOf(list, STUDY)?.status === 'Ready', 'Ready');
  assert.equal(requests[0].url, '/api/preload/cache-key', 'one silent key read for the session');
  assert.equal(requests[0].init.headers['X-KIN-Session'], 'sess-1');
  assert.deepEqual(reads().map(r => r.url), [
    `/dicom-web/studies/${STUDY}/metadata`,
    `/dicom-web/studies/${STUDY}/series/${STUDY}.1/instances/${STUDY}.1.1/frames/1`,
    `/dicom-web/studies/${STUDY}/series/${STUDY}.2/instances/${STUDY}.2.1/frames/1`,
    `/dicom-web/studies/${STUDY}/series/${STUDY}.1/instances/${STUDY}.1.1/frames/2`,
  ]);
  for (const { init } of reads()) {
    assert.equal(init.headers['X-KIN-Session'], 'sess-1');
    assert.equal(init.cache, 'no-store');
    assert.equal(init.priority, 'low');
  }
  for (const { init } of reads().slice(1)) assert.equal(init.headers['X-KIN-Preload'], 'store');
  const state = statusOf(list, STUDY);
  assert.deepEqual([state.done, state.total, state.label], [3, 3, 'SYN-1 · Synthetic^Patient']);
  assert.ok(list.state().used > 0 && list.state().used <= list.state().budget);
});

test('a viewer of the same session gets the decoded frame and the revision; another session gets nothing', async () => {
  const { connect } = boot();
  const list = connect();
  list.send({ type: 'hello', role: 'list' });
  list.send({ type: 'add', session: 'sess-1', studies: [{ uid: STUDY }] });
  await until(() => statusOf(list, STUDY)?.status === 'Ready', 'Ready');
  const viewer = connect();
  viewer.send({ type: 'hello', role: 'viewer' });
  const held = (await viewer.ask({ type: 'query', uid: STUDY, session: 'sess-1' })).held;
  assert.equal(held.revision, 'orthanc-study:s@1');
  const frame = `/dicom-web/studies/${STUDY}/series/${STUDY}.1/instances/${STUDY}.1.1/frames/2`;
  const ask = session => viewer.ask({ type: 'frame', path: frame, session, copy: held.copy });
  const answer = await ask('sess-1');
  assert.equal(Buffer.from(answer.bytes).toString(), '--b1\r\nContent-Type: application/octet-stream\r\n\r\nframe ' + frame + '\r\n--b1--');
  assert.equal(answer.partType, PART);
  // The same frame twice: the store keeps its bytes (the first answer was handed over, not the held copy).
  assert.equal(Buffer.from((await ask('sess-1')).bytes).length, answer.bytes.byteLength);
  assert.equal((await viewer.ask({ type: 'query', uid: STUDY, session: 'sess-2' })).held, null);
  assert.equal((await ask('sess-2')).bytes, null);
  assert.equal((await viewer.ask({ type: 'frame', path: frame, session: 'sess-1' })).bytes, null, 'a frame read names the copy it checked');
});

test('reading comes first: while a viewer loads from the network, no new preload fetch starts', async () => {
  const { reads, connect } = boot();
  const viewer = connect();
  viewer.send({ type: 'hello', role: 'viewer' });
  viewer.send({ type: 'busy', busy: true });
  const list = connect();
  list.send({ type: 'hello', role: 'list' });
  list.send({ type: 'add', session: 'sess-1', studies: [{ uid: STUDY }] });
  await until(() => list.state()?.budget, 'prerequisites');
  for (let i = 0; i < 20; i++) await tick();
  assert.equal(reads().length, 0, 'no preload request while the viewer is busy');
  assert.equal(statusOf(list, STUDY).status, 'Queued');
  viewer.send({ type: 'busy', busy: false });
  await until(() => statusOf(list, STUDY)?.status === 'Ready', 'Ready after the viewer went idle');
  // A viewer window that leaves while busy does not park the queue.
  viewer.send({ type: 'busy', busy: true });
  list.send({ type: 'add', session: 'sess-1', studies: [{ uid: OTHER }] });
  await until(() => statusOf(list, OTHER)?.status === 'Queued', 'second study queued');
  viewer.send({ type: 'bye' });
  await until(() => statusOf(list, OTHER)?.status === 'Ready', 'second study Ready after bye');
});

test('reading comes first after metadata: frame reads pause until the viewer is idle', async () => {
  const { reads, connect, hold } = boot();
  const viewer = connect();
  viewer.send({ type: 'hello', role: 'viewer' });
  const list = connect();
  list.send({ type: 'hello', role: 'list' });
  const release = hold();
  list.send({ type: 'add', session: 'sess-1', studies: [{ uid: STUDY }] });
  await until(() => reads().length === 1, 'metadata request');
  viewer.send({ type: 'busy', busy: true });
  release();
  try {
    for (let i = 0; i < 20; i++) await tick();
    assert.equal(reads().length, 1, 'metadata may finish but no frame starts while reading');
    assert.equal(statusOf(list, STUDY).status, 'Downloading');
  } finally {
    viewer.send({ type: 'busy', busy: false });
  }
  await until(() => statusOf(list, STUDY)?.status === 'Ready', 'Ready after reading');
  assert.equal(reads().length, 4, 'all frames resume');
});

test('reading comes first in the middle of a study: after a frame, the next one waits until the viewer is idle', async () => {
  const { reads, connect, hold } = boot();
  const viewer = connect();
  viewer.send({ type: 'hello', role: 'viewer' });
  const list = connect();
  list.send({ type: 'hello', role: 'list' });
  let release = hold();
  list.send({ type: 'add', session: 'sess-1', studies: [{ uid: STUDY }] });
  await until(() => reads().length === 1, 'metadata request');
  release(); release = hold();
  await until(() => reads().length === 2, 'first frame request');
  viewer.send({ type: 'busy', busy: true });
  release();
  try {
    await until(() => statusOf(list, STUDY)?.done === 1, 'the first frame stored');
    for (let i = 0; i < 20; i++) await tick();
    assert.equal(reads().length, 2, 'the first frame finishes but no later frame starts while reading');
    assert.equal(statusOf(list, STUDY).status, 'Downloading');
  } finally {
    viewer.send({ type: 'busy', busy: false });
  }
  await until(() => statusOf(list, STUDY)?.status === 'Ready', 'Ready after reading');
  assert.equal(reads().length, 4, 'the rest resumes');
});

test('a session that ended on the server empties the store; a new session never sees the old one', async () => {
  let refuse = false;
  const { connect } = boot({ respond: async url => {
    if (refuse) return new Response('{}', { status: 401, headers: { 'X-KIN-Auth-Code': 'AUTH_SESSION_ENDED' } });
    const study = /\/studies\/([0-9.]+)\//.exec(url)[1];
    if (url.endsWith('/metadata')) return new Response(JSON.stringify(metadata(study)));
    return new Response(zlib.gzipSync(multipart('x')), { headers: { 'Content-Type': 'application/gzip', 'X-KIN-Part-Type': PART, 'X-KIN-Study-Revision': 'r' } });
  } });
  const list = connect();
  list.send({ type: 'hello', role: 'list' });
  list.send({ type: 'add', session: 'sess-1', studies: [{ uid: STUDY }] });
  await until(() => statusOf(list, STUDY)?.status === 'Ready', 'Ready');
  refuse = true;
  list.send({ type: 'add', session: 'sess-1', studies: [{ uid: OTHER }] });
  await until(() => list.state()?.session === null, 'key dropped on AUTH_SESSION_ENDED');
  assert.equal(list.state().used, 0);
  assert.equal(list.state().studies.length, 0);
  // Another login: whatever is held under the old session goes before the new session's queue starts.
  refuse = false;
  list.send({ type: 'retry', uid: STUDY });
  await tick();
  list.send({ type: 'add', session: 'sess-2', studies: [{ uid: OTHER }] });
  await until(() => statusOf(list, OTHER)?.status === 'Ready', 'Ready under the new session');
  const viewer = connect();
  viewer.send({ type: 'hello', role: 'viewer' });
  assert.equal((await viewer.ask({ type: 'query', uid: OTHER, session: 'sess-1' })).held, null);
  // The worklist reports its session ended: nothing stays.
  list.send({ type: 'session', session: null });
  await tick();
  assert.equal(list.state().used, 0);
  assert.equal(list.state().studies.length, 0);
});

test('Clear All while a study\'s metadata is read leaves it Evicted; a window that said goodbye can come back', async () => {
  const { reads, connect, hold } = boot();
  const list = connect();
  list.send({ type: 'hello', role: 'list' });
  const release = hold();
  list.send({ type: 'add', session: 'sess-1', studies: [{ uid: STUDY }] });
  await until(() => reads().length === 1, 'metadata read started');
  list.send({ type: 'clear' });
  release();
  for (let i = 0; i < 20; i++) await tick();
  assert.equal(statusOf(list, STUDY).status, 'Evicted');
  assert.equal(reads().length, 1, 'no frame read after the clear');
  list.send({ type: 'bye' });
  list.send({ type: 'hello', role: 'list' });
  list.send({ type: 'retry', uid: STUDY });
  await until(() => statusOf(list, STUDY)?.status === 'Ready', 'Ready after coming back');
});

test('a refused, missing or changing study fails with a reason and Retry; a browser without usable disk gets no preload', async () => {
  let revision = 0;
  const { connect } = boot({ respond: async (url) => {
    const study = /\/studies\/([0-9.]+)\//.exec(url)[1];
    if (study === OTHER) return new Response('{}', { status: 403 });
    if (url.endsWith('/metadata')) return new Response(JSON.stringify(metadata(study)));
    return new Response(zlib.gzipSync(multipart('x')), { headers: { 'Content-Type': 'application/gzip', 'X-KIN-Part-Type': PART, 'X-KIN-Study-Revision': 'r' + (++revision) } });
  } });
  const list = connect();
  list.send({ type: 'hello', role: 'list' });
  list.send({ type: 'add', session: 'sess-1', studies: [{ uid: STUDY }, { uid: OTHER }] });
  await until(() => statusOf(list, OTHER)?.status === 'Failed' && statusOf(list, STUDY)?.status === 'Failed', 'both failed');
  assert.match(statusOf(list, STUDY).reason, /바뀌었습니다/);
  assert.match(statusOf(list, OTHER).reason, /거절/);
  assert.equal(list.state().studies.reduce((n,s)=>n+s.bytes,0), 0, 'failed frames removed; encrypted reasons remain');

  const bare = boot({ unavailableDisk: true }).connect();
  bare.send({ type: 'hello', role: 'list' });
  bare.send({ type: 'add', session: 'sess-1', studies: [{ uid: STUDY }] });
  await until(() => statusOf(bare, STUDY)?.status === 'Failed', 'failed without usable disk');
  assert.match(statusOf(bare, STUDY).reason, /저장소/);
  assert.equal(bare.state().budget, null);
});

// An image archive that does not answer is one temporary failure on every row, whichever request met it - the gate's
// 403 with its AUTH_* code (metadata through nginx, a frame from the API), a busy session check, the exam scope's 503 before
// or after the frames, the frame route's 5xx. Only a plain 403 is a refused study. A cut or unreadable JSON body is the
// network's or the server's failure, never the browser's store. Once the archive answers, Retry reaches Ready.
test('an archive that does not answer fails every row as busy with Retry; only a plain 403 is refused', async () => {
  const BUSY = /서버가 바쁘거나 응답하지 않았습니다/;
  const code = value => ({ status: 403, headers: { 'X-KIN-Auth-Code': value } });
  const uid = n => '1.2.840.9.6' + n;
  let down = true;
  const scopeAnswer = study => ({ sources: [{ studyUid: study, series: { mode: 'all', uids: [] } }] });
  const scopeReads = new Map();
  const cases = {
    [uid(1)]: { metadata: () => new Response('', code('AUTH_SOURCE_UNAVAILABLE')), reason: BUSY },
    [uid(2)]: { frame: () => new Response('', code('AUTH_SOURCE_UNAVAILABLE')), reason: BUSY },
    [uid(3)]: { metadata: () => new Response('', code('AUTH_SESSION_BUSY')), reason: BUSY },
    [uid(4)]: { scope: n => n === 1 ? new Response('', { status: 503 }) : null, reason: BUSY },
    [uid(5)]: { scope: n => n === 2 ? new Response('', { status: 503 }) : null, reason: BUSY, partial: true },
    [uid(6)]: { frame: () => new Response('', { status: 502 }), reason: BUSY },
    [uid(7)]: { metadata: () => new Response('', { status: 403 }), reason: /거절/ },
    [uid(8)]: { metadata: () => new Response(new ReadableStream({ start(c) { c.error(new TypeError('cut')); } })), reason: /서버에 연결하지 못했습니다/ },
    [uid(9)]: { metadata: () => new Response('{not json'), reason: /해석하지 못했습니다/ },
  };
  const { connect } = boot({ respond: async url => {
    const scope = /^\/api\/studies\/([0-9.]+)\/exam-scope/.exec(url);
    if (scope) {
      const study = scope[1].replace(/\.0$/, ''), n = (scopeReads.get(study) || 0) + 1; scopeReads.set(study, n);
      return (down && cases[study]?.scope?.(n)) || new Response(JSON.stringify(scopeAnswer(study)));
    }
    const study = /\/studies\/([0-9.]+)\//.exec(url)[1], how = down ? cases[study] : null;
    if (url.endsWith('/metadata')) return how?.metadata?.() || new Response(JSON.stringify(metadata(study)));
    if (how?.frame) return how.frame();
    return new Response(zlib.gzipSync(multipart('x')), { headers: { 'Content-Type': 'application/gzip', 'X-KIN-Part-Type': PART, 'X-KIN-Study-Revision': 'r' } });
  } });
  const list = connect();
  list.send({ type: 'hello', role: 'list' });
  const studies = Object.keys(cases).map(study => ({ uid: study,
    ...(cases[study].scope ? { examRefs: [{ reportUid: study + '.0', key: 'exam-' + study }] } : {}) }));
  list.send({ type: 'add', session: 'sess-1', studies });
  await until(() => studies.every(s => statusOf(list, s.uid)?.status === 'Failed'), 'every row failed');
  for (const [study, how] of Object.entries(cases)) assert.match(statusOf(list, study).reason, how.reason, study);
  assert.equal(scopeReads.get(uid(5)), 2, 'the exam scope is asked again after the frames; its 503 is no Ready');
  assert.equal(list.state().studies.reduce((n, s) => n + s.bytes, 0), 0, 'no frame of a failed row is kept');
  down = false;
  for (const study of Object.keys(cases)) list.send({ type: 'retry', uid: study });
  await until(() => studies.every(s => statusOf(list, s.uid)?.status === 'Ready'), 'Ready after the archive answers');
});

test('a study that could not fit alone in the disk cap fails with the size reason, its bytes go, and the next study loads', async () => {
  // Synthetic cap includes ciphertext and manifest growth; A is too large and B fits.
  const random = n => require('node:crypto').randomBytes(n);
  const { reads, connect } = boot({ diskGb: 1500 / 1024 ** 3, respond: async url => {
    const study = /\/studies\/([0-9.]+)\//.exec(url)[1];
    if (url.endsWith('/metadata')) return new Response(JSON.stringify(metadata(study)));
    const body = study === STUDY ? zlib.gzipSync(multipart(random(600)), { level: 0 }) : zlib.gzipSync(multipart('x'));
    return new Response(body, { headers: { 'Content-Type': 'application/gzip', 'X-KIN-Part-Type': PART, 'X-KIN-Study-Revision': 'r' } });
  } });
  const list = connect();
  list.send({ type: 'hello', role: 'list' });
  list.send({ type: 'add', session: 'sess-1', studies: [{ uid: STUDY }, { uid: OTHER }] });
  await until(() => statusOf(list, STUDY)?.status === 'Failed' && statusOf(list, OTHER)?.status === 'Ready', 'A failed, B ready');
  assert.match(statusOf(list, STUDY).reason, /저장 용량보다 커서/);
  assert.equal(statusOf(list, STUDY).bytes, 0);
  assert.ok(list.state().used > statusOf(list, OTHER).bytes, 'B frames plus encrypted manifest');
  assert.ok(reads().some(r => r.url.includes(OTHER + '/series')), 'B\'s frames were requested');
});

test('Retry when this worker cannot preload keeps the study Failed with the reason and fetches nothing', async () => {
  for (const [options, reason] of [[{ unavailableDisk: true }, /저장소/], [{ diskGb: null }, /저장 용량/]]) {
    const { reads, connect } = boot(options);
    const list = connect();
    list.send({ type: 'hello', role: 'list' });
    list.send({ type: 'add', session: 'sess-1', studies: [{ uid: STUDY }] });
    await until(() => statusOf(list, STUDY)?.status === 'Failed', 'failed');
    assert.match(statusOf(list, STUDY).reason, reason);
    const states = list.received.length;
    list.send({ type: 'retry', uid: STUDY });
    await until(() => list.received.length > states, 'an answer to the Retry');
    for (let i = 0; i < 20; i++) await tick();
    assert.equal(statusOf(list, STUDY).status, 'Failed', 'not a Queued that never moves');
    assert.match(statusOf(list, STUDY).reason, reason);
    assert.equal(reads().length, 0, 'nothing fetched');
    assert.match(list.state().unavailable, reason, 'the panel says why');
  }
});

test('a viewer is answered from the copy it checked only: after Clear All and Retry the new copy is refused as stale', async () => {
  let revision = 'r1';
  const { connect } = boot({ respond: async url => {
    const study = /\/studies\/([0-9.]+)\//.exec(url)[1];
    if (url.endsWith('/metadata')) return new Response(JSON.stringify(metadata(study)));
    return new Response(zlib.gzipSync(Buffer.from('--b1\r\nContent-Type: application/octet-stream\r\n\r\nframe-' + revision + '\r\n--b1--')), { headers: { 'Content-Type': 'application/gzip', 'X-KIN-Part-Type': PART, 'X-KIN-Study-Revision': revision } });
  } });
  const list = connect();
  list.send({ type: 'hello', role: 'list' });
  list.send({ type: 'add', session: 'sess-1', studies: [{ uid: STUDY }] });
  await until(() => statusOf(list, STUDY)?.status === 'Ready', 'Ready r1');
  const viewer = connect();
  viewer.send({ type: 'hello', role: 'viewer' });
  const checked = (await viewer.ask({ type: 'query', uid: STUDY, session: 'sess-1' })).held;
  const frame = `/dicom-web/studies/${STUDY}/series/${STUDY}.1/instances/${STUDY}.1.1/frames/2`;
  assert.equal(Buffer.from((await viewer.ask({ type: 'frame', path: frame, session: 'sess-1', copy: checked.copy })).bytes).toString(), '--b1\r\nContent-Type: application/octet-stream\r\n\r\nframe-r1\r\n--b1--');
  list.send({ type: 'clear' });
  await until(() => statusOf(list, STUDY)?.status === 'Evicted', 'clear completed');
  revision = 'r2';
  list.send({ type: 'retry', uid: STUDY });
  await until(() => statusOf(list, STUDY)?.status === 'Ready', 'Ready r2');
  const stale = await viewer.ask({ type: 'frame', path: frame, session: 'sess-1', copy: checked.copy });
  assert.deepEqual([stale.bytes, stale.stale], [null, true], 'no r2 byte under the r1 check');
  const now = (await viewer.ask({ type: 'query', uid: STUDY, session: 'sess-1' })).held;
  assert.equal(now.revision, 'r2');
  assert.notEqual(now.copy, checked.copy);
  assert.equal(Buffer.from((await viewer.ask({ type: 'frame', path: frame, session: 'sess-1', copy: now.copy })).bytes).toString(), '--b1\r\nContent-Type: application/octet-stream\r\n\r\nframe-r2\r\n--b1--');
});

const FRAME = `/dicom-web/studies/${STUDY}/series/${STUDY}.1/instances/${STUDY}.1.1/frames/1`;
async function ready(h, uid=STUDY) {
  const list=h.connect(); list.send({type:'hello',role:'list'});
  list.send({type:'add',session:'sess-A',studies:[{uid,label:'SYN-123 · Synthetic^Patient'}]});
  await until(()=>statusOf(list,uid)?.status==='Ready','Ready'); return list;
}
const query = (p, session='sess-A', uid=STUDY) => p.ask({type:'query',session,uid});

// Both direct stored gzip and relayed multipart must retain the original codec, syntax and frame bytes.
for (const [media, syntax] of [
  ['application/octet-stream', '1.2.840.10008.1.2.1'],
  ['image/jpeg', '1.2.840.10008.1.2.4.50'],
  ['image/jls', '1.2.840.10008.1.2.4.80'],
  ['image/jp2', '1.2.840.10008.1.2.4.90'],
  ['image/dicom-rle', '1.2.840.10008.1.2.5'],
]) for (const gzip of [true, false]) {
  test(`cached ${media} (${gzip ? 'gzip' : 'multipart'}) preserves Content-Type immediately and after restart`, async () => {
    const type = `${media}; transfer-syntax=${syntax}`;
    const partType = `multipart/related; type="${type}"; boundary=b1`;
    const body = Buffer.concat([Buffer.from(`--b1\r\nContent-Location: ${FRAME}\r\nContent-Type: ${type}\r\n\r\n`),
      Buffer.from([0, 255, 1, 128]), Buffer.from('\r\n--b1--\r\n')]);
    const h = boot({ respond: async url => url.endsWith('/metadata')
      ? new Response(JSON.stringify(metadata(STUDY)))
      : new Response(gzip ? zlib.gzipSync(body) : body, { headers: {
        'Content-Type': gzip ? 'application/gzip' : partType,
        ...(gzip ? { 'X-KIN-Part-Type': partType } : {}), 'X-KIN-Study-Revision': 'r1',
      } }) });
    const list = await ready(h);
    const check = async (port, session) => {
      const held = (await query(port, session)).held;
      assert.ok(held);
      const answer = await port.ask({ type: 'frame', session, path: FRAME, copy: held.copy });
      assert.deepEqual(Buffer.from(answer.bytes), body);
      assert.equal(answer.partType, partType);
    };
    await check(list, 'sess-A');
    list.send({ type: 'session', session: null });
    const restarted = boot({ disk: h.disk }), resumed = restarted.connect();
    resumed.send({ type: 'session', session: 'sess-A2' });
    await check(resumed, 'sess-A2');
    assert.equal(restarted.reads().length, 0, 'restoration serves the persisted type without another image read');
  });
}

for (const [name, malformed] of [
  ['missing type', '--b1\r\nContent-Location: /frame\r\n\r\npixels\r\n--b1--'],
  ['duplicate type', '--b1\r\nContent-Type: image/jp2\r\nContent-Type: application/octet-stream\r\n\r\npixels\r\n--b1--'],
  ['incomplete headers', '--b1\r\nContent-Type: image/jp2'],
]) for (const gzip of [true, false]) {
  test(`preload rejects ${name} before storing a frame (${gzip ? 'gzip' : 'multipart'}) and Retry recovers`, async () => {
    let repaired = false;
    const disk = memoryDisk(), writes = [], write = disk.write;
    disk.write = async (puts = {}, deletes = {}) => {
      writes.push(...(puts.frames || []));
      return write(puts, deletes);
    };
    const h = boot({ disk, respond: async url => {
      if (url.endsWith('/metadata')) return new Response(JSON.stringify(metadata(STUDY)));
      const body = repaired ? multipart('pixels') : Buffer.from(malformed);
      return new Response(gzip ? zlib.gzipSync(body) : body, { headers: {
        'Content-Type': gzip ? 'application/gzip' : PART,
        'X-KIN-Part-Type': PART, 'X-KIN-Study-Revision': 'r1',
      } });
    } });
    const list = h.connect();
    list.send({ type: 'hello', role: 'list' });
    list.send({ type: 'add', session: 'sess-A', studies: [{ uid: STUDY }] });
    await until(() => statusOf(list, STUDY)?.status === 'Failed', 'malformed response rejected during preload');
    assert.match(statusOf(list, STUDY).reason, /서버 응답을 해석하지 못했습니다/);
    assert.equal(writes.length, 0, 'invalid frames must never reach storage, even temporarily');
    assert.equal(disk.frames.size, 0);
    assert.equal((await query(list)).held, null);
    assert.equal((await list.ask({ type: 'frame', session: 'sess-A', path: FRAME })).bytes, null);
    repaired = true;
    list.send({ type: 'retry', uid: STUDY });
    await until(() => statusOf(list, STUDY)?.status === 'Ready', 'Retry after server repair');
    const held = (await query(list)).held;
    const answer = await list.ask({ type: 'frame', session: 'sess-A', path: FRAME, copy: held.copy });
    assert.deepEqual(Buffer.from(answer.bytes), multipart('pixels'));
    assert.equal(answer.partType, PART);
  });
}

test('cached multipart headers retain a long relayed part type and reject unauthenticated types', async () => {
  const type = 'image/jp2; transfer-syntax=1.2.840.10008.1.2.4.90';
  for (const mode of ['valid', 'tampered']) {
    const body = Buffer.from(`\r\n--relay:boundary\r\nContent-Location: /${'long-path/'.repeat(150)}\r\ncOnTeNt-TyPe: ${type}\r\n\r\npixels\r\n--relay:boundary--\r\n`);
    const h = boot({ respond: async url => url.endsWith('/metadata')
      ? new Response(JSON.stringify(metadata(STUDY)))
      : new Response(body, { headers: { 'Content-Type': 'multipart/related; boundary="relay:boundary"', 'X-KIN-Study-Revision': 'r1' } }) });
    const list = await ready(h), held = (await query(list)).held;
    if (mode === 'tampered') {
      // GCM ciphertext has the plaintext's length/order before its tag. Changing only the codec bytes must fail authentication.
      const record = [...h.disk.frames.values()][0];
      new Uint8Array(record.ct)[body.indexOf('image/jp2')] ^= 1;
    }
    const answer = await list.ask({ type: 'frame', session: 'sess-A', path: FRAME, copy: held.copy });
    if (mode === 'valid') {
      assert.deepEqual(Buffer.from(answer.bytes), body);
      assert.equal(answer.partType, `multipart/related; type="${type}"; boundary="relay:boundary"`);
    } else {
      assert.equal(answer.bytes, null, mode);
      assert.equal((await query(list)).held, null, mode);
      assert.equal(h.disk.frames.size + h.disk.studies.size, 0, mode);
      assert.match(statusOf(list, STUDY).reason, /손상/, mode);
    }
  }
});

for (const nextSession of [null, 'sess-B']) {
  test(`R11 delayed disk read cannot use the old key after ${nextSession ? 'user switch' : 'logout'}`, async () => {
    const h = boot(), list = await ready(h);
    const held = (await query(list)).held;
    // A positive control makes the crypto spy prove actual use of the issued key.
    assert.ok((await list.ask({ type: 'frame', session: 'sess-A', path: FRAME, copy: held.copy })).bytes);
    const oldKey = h.imports[0].key;
    assert.ok(h.decryptKeys.includes(oldKey));
    h.decryptKeys.length = 0;
    const before = await h.disk.list();
    const get = h.disk.get;
    let release, started = false;
    const pending = new Promise(resolve => { release = resolve; });
    h.disk.get = async id => { started = true; await pending; return get(id); };
    const answer = list.ask({ type: 'frame', session: 'sess-A', path: FRAME, copy: held.copy });
    await until(() => started, 'disk read awaiting completion');
    list.send({ type: 'session', session: nextSession });
    release();
    assert.equal((await answer).bytes, null);
    assert.equal(h.decryptKeys.includes(oldKey), false, 'the old key is dropped before the pending read resumes');
    assert.deepEqual(await h.disk.list(), before, 'ending a session preserves ciphertext');
  });
}

test('R1 R2 R15 encrypted exact manifests and unchanged frame bodies, zeroed input and no key in window messages', async()=>{
  const h=boot(), list=await ready(h);
  assert.equal(h.imports.length,1); assert.equal(h.imports[0].key.extractable,false);
  assert.ok(h.imports[0].raw.every(b=>b===0));
  const diskKey=await webcrypto.subtle.importKey('raw',KEY,'AES-GCM',false,['decrypt']);
  const D=require('../worklist-v0/hpacs-lite/preload-disk.js');
  for(const r of h.disk.studies.values()) {
    // In clear: the record's own random ID, the key's ID, the expiry and its frames' random IDs (a used copy's frames live
    // as long as its record) - nothing of the study.
    assert.deepEqual(Object.keys(r).sort(),['manifestId','keyId','expiresAt','frameIds','iv','ct'].sort());
    const m=JSON.parse(new TextDecoder().decode(await D.open(diskKey,r,D.studyAAD(r.keyId,r.manifestId))));
    assert.deepEqual(Object.keys(m).sort(),['uid','label','status','reason','revision','copy','seq','total','queuedAt','fetchedAt','usedAt','bytes','frames'].sort());
    assert.deepEqual([...r.frameIds].sort(),Object.values(m.frames).sort());
    assert.equal(m.usedAt,null);
    assert.equal(m.label,'SYN-123 · Synthetic^Patient');
    for(const [path,id] of Object.entries(m.frames)) {
      const f=h.disk.frames.get(id);
      assert.deepEqual(Object.keys(f).sort(),['entryId','keyId','expiresAt','bytes','iv','ct'].sort());
      const plain=await D.open(diskKey,f,D.frameAAD(r.keyId,m.uid,path,m.revision,m.copy));
      assert.equal(zlib.gunzipSync(Buffer.from(plain)).toString(),'--b1\r\nContent-Type: application/octet-stream\r\n\r\nframe '+path+'\r\n--b1--');
      assert.equal(f.expiresAt,SERVER_START+72*3600000);
    }
  }
  assert.equal(JSON.stringify(list.received).includes(KEY.toString('base64')),false);
});

test('R3 R4 R11 restart and A/B/A session changes retain ciphertext and restore only the issued key',async()=>{
  const disk=memoryDisk(), a=boot({disk}), list=await ready(a);
  const count=disk.frames.size+disk.studies.size;
  list.send({type:'session',session:null});
  assert.equal((await query(list)).held,null);
  assert.equal(disk.frames.size+disk.studies.size,count);
  const b=boot({disk,keyResponse:()=>new Response(JSON.stringify({keyId:'key-B',key:Buffer.alloc(32,7).toString('base64'),serverTime:new Date(SERVER_START).toISOString()}))});
  const other=b.connect(); other.send({type:'hello',role:'list'});other.send({type:'session',session:'sess-B'});
  assert.equal((await query(other,'sess-B')).held,null);
  assert.equal(other.state().studies.length,0); assert.equal(disk.frames.size+disk.studies.size,count);
  const again=boot({disk}), resumed=again.connect(); resumed.send({type:'hello',role:'list'});resumed.send({type:'session',session:'sess-A2'});
  const held=(await query(resumed,'sess-A2')).held; assert.ok(held);
  assert.equal(again.reads().length,0,'Ready survived without store reads');
  const answer=await resumed.ask({type:'frame',session:'sess-A2',path:FRAME,copy:held.copy});
  assert.ok(answer.bytes); assert.equal(statusOf(resumed,STUDY).status,'Ready');
});

test('R5 server-clock expiry with +6h and -6h PC clocks, startup and queued expiry',async()=>{
  for(const skew of [-6,6].map(h=>h*3600000)) {
    const h=boot({skew}),list=await ready(h);
    h.advance(72*3600000-1); assert.ok((await query(list)).held);
    h.advance(1); assert.equal((await query(list)).held,null);
    assert.equal(h.disk.frames.size,0);assert.equal(h.disk.studies.size,0);
    assert.equal(statusOf(list,STUDY).status,'Evicted');
  }
  const h=boot(),viewer=h.connect();viewer.send({type:'hello',role:'viewer'});viewer.send({type:'busy',busy:true});
  const list=h.connect();list.send({type:'hello',role:'list'});list.send({type:'add',session:'sess-A',studies:[{uid:STUDY}]});
  await until(()=>h.disk.studies.size===1,'queued persisted');
  h.advance(72*3600000);h.sweep();
  await until(()=>h.disk.studies.size===0,'queued deleted');assert.match(statusOf(list,STUDY).reason,/대기열/);
  const before=boot(),old=await ready(before);old.send({type:'session',session:null});
  const after=boot({disk:before.disk,keyResponse:()=>new Response(JSON.stringify({keyId:'key-A',key:KEY.toString('base64'),serverTime:new Date(SERVER_START+73*3600000).toISOString()}))});
  const restarted=after.connect();restarted.send({type:'hello',role:'list'});restarted.send({type:'session',session:'sess-A'});
  assert.equal((await query(restarted)).held,null);assert.equal(after.disk.frames.size+after.disk.studies.size,0);
});

test('R6 R17 refused and retired keys never serve; opaque entries are reclaimed before own unopened Ready',async()=>{
  const a=boot(),list=await ready(a);list.send({type:'session',session:null});
  const count=a.disk.frames.size+a.disk.studies.size;
  for(const status of [403,404]) {
    const refused=boot({disk:a.disk,keyResponse:()=>new Response('{}',{status,headers:{Date:new Date(SERVER_START).toUTCString()}})});
    const p=refused.connect();p.send({type:'hello',role:'list'});p.send({type:'add',session:'sess-A',studies:[{uid:STUDY}]});
    await until(()=>statusOf(p,STUDY)?.status==='Failed','refused');
    assert.match(statusOf(p,STUDY).reason,/이 계정/);assert.equal((await query(p)).held,null);
    assert.equal((await p.ask({type:'frame',session:'sess-A',path:FRAME,copy:1})).bytes,null);
    assert.equal(a.disk.frames.size+a.disk.studies.size,count);
    refused.advance(72*3600000);refused.sweep();await until(()=>a.disk.frames.size===0,'opaque expiry');
    // Refill the same synthetic owner for the next refusal.
    if(status===403) { const fresh=boot({disk:a.disk});await ready(fresh); }
  }
  const seed=boot();await ready(seed);
  const b=boot({disk:seed.disk,diskGb:1600/1024**3,keyResponse:()=>new Response(JSON.stringify({keyId:'key-B',key:Buffer.alloc(32,5).toString('base64'),serverTime:new Date(SERVER_START).toISOString()}))});
  const p=await ready(b,OTHER);
  assert.equal((await query(p,'sess-A',STUDY)).held,null);
  assert.ok([...seed.disk.frames.values()].every(r=>r.keyId==='key-B'));
  assert.equal(statusOf(p,OTHER).status,'Ready');
});

test('R7 R9 R16 evict, Clear All and corrupt frame delete real adapter records and miss thereafter',async()=>{
  for(const how of ['evict','clear','corrupt','swap','missing']) {
    const h=boot(),list=await ready(h),held=(await query(list)).held;
    // A viewer's evict names its session and the copy its check found.
    if(how==='evict'||how==='clear') list.send({type:how,uid:STUDY,reason:'closed access',...(how==='evict'?{session:'sess-A',copy:held.copy}:{})});
    else {
      const entries=[...h.disk.frames.values()],first=entries[0];
      if(how==='corrupt') new Uint8Array(first.ct)[0]^=1;
      if(how==='swap') {first.ct=entries[1].ct;first.iv=entries[1].iv;}
      if(how==='missing') h.disk.frames.delete(first.entryId);
      assert.equal((await list.ask({type:'frame',session:'sess-A',path:FRAME,copy:held.copy})).bytes,null);
    }
    await until(()=>h.disk.frames.size+h.disk.studies.size===0,'deleted '+how);
    assert.equal((await query(list)).held,null);
    assert.equal(list.state().studies[0].bytes,0);
  }
});

test('R9 MG-01 body error and Content-Length mismatch never produce a Ready or a stored frame',async()=>{
  for(const cut of [true,false]) {
    const h=boot({respond:async url=>{
      if(url.endsWith('/metadata'))return new Response(JSON.stringify(metadata(STUDY)));
      if(cut)return {ok:true,headers:new Headers({'Content-Type':'application/gzip'}),arrayBuffer:async()=>{throw new Error('short read');}};
      return new Response('short',{headers:{'Content-Type':'application/gzip','Content-Length':'50','X-KIN-Study-Revision':'r'}});
    }}),p=h.connect();p.send({type:'hello',role:'list'});p.send({type:'add',session:'sess-A',studies:[{uid:STUDY}]});
    await until(()=>statusOf(p,STUDY)?.status==='Failed','short failed');
    assert.match(statusOf(p,STUDY).reason,/연결/);assert.equal(h.disk.frames.size,0);
  }
});

test('R10 browser quota parks a study and never evicts an unopened Ready; R11 queued resumes after logout',async()=>{
  const disk=memoryDisk(); const h=boot({disk}),list=await ready(h);
  const before=disk.frames.size;
  disk.estimate=async()=>({usage:1000,quota:1001});
  list.send({type:'add',session:'sess-A',studies:[{uid:OTHER}]});
  await until(()=>statusOf(list,OTHER)?.waiting,'parked');
  assert.equal(disk.frames.size,before);assert.equal(statusOf(list,STUDY).status,'Ready');
  disk.estimate=async()=>({usage:0,quota:Infinity});
  // Persist a queued entry while reading is busy; restart resumes it and keeps Ready frames.
  const viewer=h.connect();viewer.send({type:'hello',role:'viewer'});viewer.send({type:'busy',busy:true});
  list.send({type:'add',session:'sess-A',studies:[{uid:'1.2.840.9.3'}]});
  await until(()=>disk.studies.size===2,'queued manifest');list.send({type:'session',session:null});
  const again=boot({disk}),p=again.connect();p.send({type:'hello',role:'list'});p.send({type:'session',session:'sess-A2'});
  await until(()=>statusOf(p,'1.2.840.9.3')?.status==='Ready','resumed queue');
  assert.equal(again.reads().some(r=>r.url.includes(STUDY+'/')),false);
});

test('R11 logout aborts an in-flight body without deleting ciphertext; the next session resumes',async()=>{
  let started=false, aborted=false;
  const disk=memoryDisk();
  const h=boot({disk,respond:async(url,init)=>{
    if(url.endsWith('/metadata'))return new Response(JSON.stringify(metadata(STUDY)));
    started=true;
    return {ok:true,headers:new Headers({'Content-Type':'application/gzip'}),arrayBuffer:()=>new Promise((resolve,reject)=>{
      init.signal.addEventListener('abort',()=>{aborted=true;reject(new Error('aborted'));},{once:true});
    })};
  }}),p=h.connect();p.send({type:'hello',role:'list'});p.send({type:'add',session:'sess-A',studies:[{uid:STUDY}]});
  await until(()=>started,'body in flight');
  const before=structuredClone([...disk.studies.values()]);
  p.send({type:'session',session:null});
  await until(()=>aborted,'fetch aborted');
  assert.deepEqual([...disk.studies.values()],before);assert.equal(disk.frames.size,0);
  assert.equal((await p.ask({type:'frame',session:'sess-A',path:FRAME,copy:1})).bytes,null);
  const again=boot({disk}),resumed=again.connect();resumed.send({type:'hello',role:'list'});resumed.send({type:'session',session:'sess-A2'});
  await until(()=>statusOf(resumed,STUDY)?.status==='Ready','interrupted queue resumed');
});

test('R6 setup Retry recovers a transient key failure and a successful session issues only once',async()=>{
  let attempts=0;
  const h=boot({keyResponse:()=>{
    if(++attempts===1)throw new Error('offline');
    return new Response(JSON.stringify({keyId:'key-A',key:KEY.toString('base64'),serverTime:new Date(SERVER_START).toISOString()}));
  }}),p=h.connect();p.send({type:'hello',role:'list'});p.send({type:'add',session:'sess-A',studies:[{uid:STUDY}]});
  await until(()=>statusOf(p,STUDY)?.status==='Failed','initial key refusal');
  p.send({type:'retry',uid:STUDY});await until(()=>statusOf(p,STUDY)?.status==='Ready','retry recovers');
  p.send({type:'session',session:'sess-A'});await query(p);
  // One failure, one successful setup reused for the session (one key import), and the key issued again before the
  // copy's first frame (the copy counts from its receipt and the key outlives it).
  assert.equal(attempts,3,'one failure, one setup, one issue at the first frame');
  assert.equal(h.imports.length,1,'the setup is reused for the session');
});

test('R9 a reauthenticated changed manifest cannot relabel an existing frame',async()=>{
  const h=boot(),p=await ready(h);p.send({type:'session',session:null});
  const D=require('../worklist-v0/hpacs-lite/preload-disk.js');
  const testKey=await webcrypto.subtle.importKey('raw',KEY,'AES-GCM',false,['encrypt','decrypt']);
  const record=[...h.disk.studies.values()][0],aad=D.studyAAD(record.keyId,record.manifestId);
  const m=JSON.parse(new TextDecoder().decode(await D.open(testKey,record,aad)));
  m.revision='changed-revision';Object.assign(record,await D.seal(testKey,new TextEncoder().encode(JSON.stringify(m)),aad));
  const restarted=boot({disk:h.disk}),q=restarted.connect();q.send({type:'hello',role:'list'});q.send({type:'session',session:'sess-A2'});
  const held=(await query(q,'sess-A2')).held;assert.ok(held);
  assert.equal((await q.ask({type:'frame',session:'sess-A2',path:FRAME,copy:held.copy})).bytes,null);
  assert.match(statusOf(q,STUDY).reason,/손상/);
  assert.equal(h.disk.frames.size+h.disk.studies.size,0);
});

test('R10 space is reclaimed from expired entries, then the oldest foreign expiry regardless of insertion order',async()=>{
  const disk=memoryDisk();
  const issue=(id,time)=>()=>new Response(JSON.stringify({keyId:id,key:KEY.toString('base64'),serverTime:new Date(time).toISOString()}));
  const newer=boot({disk,keyResponse:issue('key-B',SERVER_START+3600000)});newer.advance(3600000);
  const b=await ready(newer,OTHER);b.send({type:'session',session:null});
  const older=boot({disk}),a=await ready(older);a.send({type:'session',session:null});
  const protectedRows=[...disk.frames.values(),...disk.studies.values()].filter(r=>r.keyId==='key-B');
  const initialBytes=[...disk.frames.values(),...disk.studies.values()].reduce((n,r)=>n+r.ct.byteLength,0);
  const oldFrame=[...disk.frames.values()].find(r=>r.keyId==='key-A');
  disk.frames.set('expired',{...structuredClone(oldFrame),entryId:'expired',keyId:'retired',expiresAt:SERVER_START-1});
  disk.deleted.length=0;
  const current=boot({disk,diskGb:(initialBytes+100)/1024**3,keyResponse:issue('key-C',SERVER_START)});
  const p=await ready(current,'1.2.840.9.3');
  assert.equal(disk.deleted[0],'expired','startup expiry precedes any space eviction');
  assert.ok(disk.deleted.some(id=>id!=='expired'),'space required a foreign eviction');
  for(const record of protectedRows)assert.deepEqual((record.entryId?disk.frames:disk.studies).get(record.entryId||record.manifestId),record,
    'the newer foreign cache survives while older entries can make room');
  assert.ok(p.state().used<=p.state().budget);
});

test('R5 R10 a queued study resumes when the periodic expiry sweep releases space',async()=>{
  const h=boot({diskGb:1800/1024**3}),p=await ready(h);
  h.advance(3600000);
  p.send({type:'add',session:'sess-A',studies:[{uid:OTHER}]});
  await until(()=>statusOf(p,OTHER)?.waiting,'second study waiting for space');
  assert.equal(statusOf(p,STUDY).status,'Ready','unopened Ready protected until expiry');
  h.advance(71*3600000);h.sweep();
  await until(()=>statusOf(p,OTHER)?.status==='Ready','space released by expiry resumes the queue');
  assert.equal(statusOf(p,STUDY).status,'Evicted');
  assert.ok(p.state().used<=p.state().budget);
});

// FC-073 (A1 unit 15): Auto Preload adds ({ auto: true }) and emergency order, against the worker as written.
test('FC-073 an auto add while preload cannot run queues nothing and fails nothing; the next auto add retries the setup', async () => {
  let keyReads = 0;
  const { connect, reads } = boot({ keyResponse: () => ++keyReads === 1 ? new Response('', { status: 503 })
    : new Response(JSON.stringify({ keyId: 'key-A', key: KEY.toString('base64'), serverTime: new Date(SERVER_START).toISOString() })) });
  const list = connect();
  list.send({ type: 'hello', role: 'list' });
  list.send({ type: 'add', session: 'sess-1', auto: true, studies: [{ uid: STUDY }] });
  await until(() => list.state()?.unavailable, 'the setup failure is reported');
  for (let i = 0; i < 20; i++) await tick();
  assert.equal(statusOf(list, STUDY), undefined, 'no Failed row from an auto add');
  assert.equal(reads().length, 0);
  list.send({ type: 'add', session: 'sess-1', auto: true, studies: [{ uid: STUDY }] });
  await until(() => statusOf(list, STUDY)?.status === 'Ready', 'Ready after the retried setup');
  assert.equal(keyReads, 3, 'the failed setup, the retried setup, the issue at the copy\'s first frame');
  assert.equal(list.state().unavailable, null);
});

test('FC-073 an auto add leaves a Failed study Failed, also after a restart restores the queue; urgent studies are fetched first', async () => {
  const disk = memoryDisk();
  const denied = async url => new Response('', { status: url.includes(STUDY + '/') ? 403 : 200 });
  const first = boot({ disk, respond: denied });
  const list = first.connect();
  list.send({ type: 'hello', role: 'list' });
  list.send({ type: 'add', session: 'sess-1', studies: [{ uid: STUDY }] });
  await until(() => statusOf(list, STUDY)?.status === 'Failed', 'Failed');
  const before = first.reads().length;
  list.send({ type: 'add', session: 'sess-1', auto: true, studies: [{ uid: STUDY, urgent: true }] });
  for (let i = 0; i < 20; i++) await tick();
  assert.equal(statusOf(list, STUDY).status, 'Failed', 'Retry, not the next list read, fetches it again');
  assert.equal(first.reads().length, before);

  // A new worker (browser restart) restores the stored queue before it looks at the auto add.
  const second = boot({ disk });
  const again = second.connect();
  again.send({ type: 'hello', role: 'list' });
  again.send({ type: 'add', session: 'sess-1', auto: true, studies: [{ uid: OTHER }, { uid: STUDY, urgent: true }] });
  await until(() => statusOf(again, OTHER)?.status === 'Ready', 'the new study Ready');
  assert.equal(statusOf(again, STUDY).status, 'Failed', 'the restored Failed study is not queued again by an auto add');
  assert.ok(second.reads().every(r => !r.url.includes(STUDY + '/')));

  const third = boot();
  const urgent = third.connect();
  urgent.send({ type: 'hello', role: 'list' });
  urgent.send({ type: 'add', session: 'sess-1', auto: true, studies: [{ uid: OTHER }, { uid: STUDY, urgent: true }] });
  await until(() => statusOf(urgent, OTHER)?.status === 'Ready' && statusOf(urgent, STUDY)?.status === 'Ready', 'both Ready');
  assert.equal(third.reads()[0].url, `/dicom-web/studies/${STUDY}/metadata`, 'the emergency study is read first');
});
// FC-072: after Clear All each row says what happened to it. A row that held frames was emptied; a row that had none
// was taken off the queue before it was fetched; a Failed or Evicted row held nothing and keeps its status and reason.
test('FC-072 Clear All: emptied, taken off the queue, or left as it was; every record of this key goes, a foreign one stays, Retry works', async () => {
  const EXPIRED = '1.2.840.9.5', FIRST = '1.2.840.9.3', SECOND = '1.2.840.9.4';
  let deny = true;
  const h = boot({ respond: async url => {
    const study = /\/studies\/([0-9.]+)\//.exec(url)[1];
    if (study === OTHER && deny) return new Response('{}', { status: 403 });
    if (url.endsWith('/metadata')) return new Response(JSON.stringify(metadata(study)));
    const body = zlib.gzipSync(multipart('frame ' + url));
    return new Response(body, { headers: { 'Content-Type': 'application/gzip', 'X-KIN-Part-Type': PART, 'X-KIN-Study-Revision': 'r' } });
  } });
  const foreign = { frame: { entryId: 'foreign-frame', keyId: 'key-Z', expiresAt: SERVER_START + 200 * 3600000, bytes: 8, iv: new Uint8Array(12), ct: new ArrayBuffer(8) },
    study: { manifestId: 'foreign-manifest', keyId: 'key-Z', expiresAt: SERVER_START + 200 * 3600000, iv: new Uint8Array(12), ct: new ArrayBuffer(8) } };
  h.disk.frames.set(foreign.frame.entryId, structuredClone(foreign.frame));
  h.disk.studies.set(foreign.study.manifestId, structuredClone(foreign.study));
  const list = h.connect();
  list.send({ type: 'hello', role: 'list' });
  list.send({ type: 'add', session: 'sess-A', studies: [{ uid: EXPIRED }] });
  await until(() => statusOf(list, EXPIRED)?.status === 'Ready', 'the study to expire Ready');
  h.advance(72 * 3600000); h.sweep();
  await until(() => statusOf(list, EXPIRED)?.status === 'Evicted', 'expired');
  list.send({ type: 'add', session: 'sess-A', studies: [{ uid: STUDY }, { uid: OTHER }] });
  await until(() => statusOf(list, STUDY)?.status === 'Ready' && statusOf(list, OTHER)?.status === 'Failed', 'one Ready, one Failed');
  const release = h.hold();
  list.send({ type: 'add', session: 'sess-A', studies: [{ uid: FIRST }, { uid: SECOND }] });
  await until(() => h.reads().some(r => r.url.includes(FIRST + '/metadata')) && [...h.disk.studies.values()].filter(r => r.keyId === 'key-A').length === 4,
    'one fetching, one queued, both stored beside the Ready and the Failed record');
  const inFlight = h.reads().find(r => r.url.includes(FIRST + '/metadata'));
  assert.equal(statusOf(list, FIRST).status, 'Downloading');
  assert.equal(statusOf(list, SECOND).status, 'Queued');
  const failed = statusOf(list, OTHER), expired = statusOf(list, EXPIRED);
  assert.match(failed.reason, /거절/);
  assert.match(expired.reason, /표시된 보관 기한이 지나 자동으로 지웠습니다/);

  list.send({ type: 'clear' });
  await until(() => statusOf(list, STUDY)?.status === 'Evicted' && statusOf(list, SECOND)?.status === 'Evicted', 'cleared');
  release();
  for (let i = 0; i < 40; i++) await tick();
  assert.equal(inFlight.init.signal.aborted, true, 'the read in flight is cut');
  assert.deepEqual([statusOf(list, STUDY).status, statusOf(list, STUDY).reason], ['Evicted', '미리 받은 영상을 비웠습니다.']);
  for (const uid of [FIRST, SECOND]) {
    assert.deepEqual([statusOf(list, uid).status, statusOf(list, uid).reason],
      ['Evicted', '받기 전에 대기열에서 뺐습니다. 다시 받으려면 Retry를 누르세요.'], uid);
  }
  assert.deepEqual([statusOf(list, OTHER).status, statusOf(list, OTHER).reason], ['Failed', failed.reason], 'Failed stays Failed');
  assert.deepEqual([statusOf(list, EXPIRED).status, statusOf(list, EXPIRED).reason], ['Evicted', expired.reason], 'expired keeps its reason');
  assert.equal(h.reads().filter(r => r.url.includes(FIRST + '/') || r.url.includes(SECOND + '/')).length, 1, 'nothing more is fetched');
  const mine = [...h.disk.frames.values(), ...h.disk.studies.values()].filter(r => r.keyId === 'key-A');
  assert.deepEqual(mine, [], 'every frame and record of this key is gone, the Failed record is not written back');
  assert.deepEqual(h.disk.frames.get(foreign.frame.entryId), foreign.frame, 'another key\'s frame stays');
  assert.deepEqual(h.disk.studies.get(foreign.study.manifestId), foreign.study, 'another key\'s record stays');
  assert.equal(list.state().used, 16, 'the gauge counts only what is left');

  deny = false;
  list.send({ type: 'retry', uid: OTHER });
  await until(() => statusOf(list, OTHER)?.status === 'Ready', 'Retry of the Failed study after Clear All');
  list.send({ type: 'retry', uid: SECOND });
  await until(() => statusOf(list, SECOND)?.status === 'Ready', 'Retry of a study taken off the queue');
});
test('a Preload for another exam of the same original replaces its entry; the old download failing late leaves the new one alone', async () => {
  // The first part of a split exam is being fetched when the second part is preloaded: the entry is queued again for the
  // second part. The first download then fails (its metadata refused); the second part's entry must still load.
  let metadataReads = 0;
  const part = n => ({ reportUid: STUDY, groupId: 'g-split', part: n });
  const { reads, connect, hold } = boot({ respond: async url => {
    if (url.startsWith('/api/studies/')) return new Response(JSON.stringify({ reportUid: STUDY, sources: [{ studyUid: STUDY, series: { mode: 'all', uids: [] } }] }));
    if (url.endsWith('/metadata')) return ++metadataReads === 1 ? new Response('{}', { status: 403 }) : new Response(JSON.stringify(metadata(STUDY)));
    return new Response(zlib.gzipSync(multipart('x')), { headers: { 'Content-Type': 'application/gzip', 'X-KIN-Part-Type': PART, 'X-KIN-Study-Revision': 'r1' } });
  } });
  const list = connect();
  list.send({ type: 'hello', role: 'list' });
  const release = hold();
  list.send({ type: 'add', session: 'sess-1', studies: [{ uid: STUDY, examRefs: [part(0)] }] });
  await until(() => reads().length === 1, 'first part metadata read started');
  list.send({ type: 'add', session: 'sess-1', studies: [{ uid: STUDY, examRefs: [part(1)] }] });
  await until(() => statusOf(list, STUDY)?.examRefs?.[0]?.part === 1, 'entry queued again for the second part');
  release();
  await until(() => statusOf(list, STUDY)?.status === 'Ready', 'second part Ready');
  assert.deepEqual(statusOf(list, STUDY).examRefs, [part(1)]);
  assert.equal(metadataReads, 2);
});
// ── Only unused copies go 72 hours after they were received; a used copy counts again from its last use ──
const HOUR = 3600000;
/** A viewer window of the session: its live check confirmed `copy` (viewer-preload.js posts open with it). */
async function viewerOf(h, uid = STUDY) {
  const viewer = h.connect(); viewer.send({ type: 'hello', role: 'viewer' });
  const { held } = await viewer.ask({ type: 'query', uid, session: 'sess-A' });
  assert.ok(held, 'the viewer finds the copy held');
  return { viewer, copy: held.copy };
}
const studyRecord = (h, uid, key = KEY) => (async () => {
  const D = require('../worklist-v0/hpacs-lite/preload-disk.js');
  const diskKey = await webcrypto.subtle.importKey('raw', key, 'AES-GCM', false, ['decrypt']);
  for (const r of h.disk.studies.values()) {
    const m = JSON.parse(new TextDecoder().decode(await D.open(diskKey, r, D.studyAAD(r.keyId, r.manifestId))));
    if (m.uid === uid) return { record: r, manifest: m };
  }
  return null;
})();
const keyReads = h => h.requests.filter(r => r.url === '/api/preload/cache-key').length;

test('two copies received together: the one opened and left counts from its leaving, the unopened one goes at 72 hours', async () => {
  for (const skew of [0, 6 * HOUR]) {
    const h = boot({ skew }), list = await ready(h);
    list.send({ type: 'add', session: 'sess-A', studies: [{ uid: OTHER }] });
    await until(() => statusOf(list, OTHER)?.status === 'Ready', 'both Ready');
    const received = statusOf(list, STUDY).expiresAt;
    assert.equal(received, SERVER_START + 72 * HOUR, 'received at server hour 0');
    h.advance(24 * HOUR);
    const { viewer, copy } = await viewerOf(h);
    const writes = [], gets = [];
    const { write, get } = h.disk;
    h.disk.write = async (puts = {}, deletes = {}) => { writes.push({ frames: (puts.frames || []).length, studies: (puts.studies || []).length }); return write(puts, deletes); };
    h.disk.get = async id => { gets.push(id); return get(id); };
    viewer.send({ type: 'open', uid: STUDY, copy, session: 'sess-A' });
    await until(() => statusOf(list, STUDY).expiresAt === SERVER_START + 96 * HOUR, 'the open counts from hour 24');
    assert.equal(statusOf(list, STUDY).open, true);
    h.advance(HOUR);
    viewer.send({ type: 'bye' });
    await until(() => statusOf(list, STUDY).expiresAt === SERVER_START + 97 * HOUR, 'leaving counts from hour 25');
    assert.equal(statusOf(list, OTHER).expiresAt, SERVER_START + 72 * HOUR, 'the unopened copy keeps its expiry');
    // A use writes the study record only: no frame ciphertext was read or written again.
    assert.deepEqual([writes.every(w => w.frames === 0), writes.some(w => w.studies === 1), gets.length], [true, true, 0]);
    const { record, manifest } = await studyRecord(h, STUDY);
    assert.deepEqual([record.expiresAt, manifest.usedAt], [SERVER_START + 97 * HOUR, SERVER_START + 25 * HOUR]);
    assert.ok(record.frameIds.every(id => h.disk.frames.get(id).expiresAt === SERVER_START + 72 * HOUR), 'frames keep their own date');
    h.disk.write = write; h.disk.get = get;
    list.send({ type: 'session', session: null });
    // Hour 73, same key, the worker started again: only the unopened copy went; the used one reads and shows hour 97.
    const again = boot({ disk: h.disk, skew, keyResponse: () => new Response(JSON.stringify({ keyId: 'key-A', key: KEY.toString('base64'),
      serverTime: new Date(SERVER_START + 73 * HOUR).toISOString() })) });
    const restarted = again.connect(); restarted.send({ type: 'hello', role: 'list' }); restarted.send({ type: 'session', session: 'sess-A' });
    await until(() => statusOf(restarted, OTHER)?.status === 'Evicted' && statusOf(restarted, STUDY)?.status === 'Ready', 'restored');
    assert.match(statusOf(restarted, OTHER).reason, /표시된 보관 기한이 지나 자동으로 지웠습니다/);
    assert.equal(statusOf(restarted, STUDY).expiresAt, SERVER_START + 97 * HOUR);
    const { viewer: later, copy: same } = await viewerOf(again);
    const path = `/dicom-web/studies/${STUDY}/series/${STUDY}.1/instances/${STUDY}.1.1/frames/1`;
    assert.ok((await later.ask({ type: 'frame', path, session: 'sess-A', copy: same })).bytes, 'past its frames\' own date, still readable');
    assert.ok([...again.disk.frames.values()].length > 0 && (await studyRecord(again, OTHER)) === null);
    // Hour 97 exactly: the used copy is no longer served, and every record of it goes.
    again.advance(24 * HOUR);
    assert.equal((await later.ask({ type: 'query', uid: STUDY, session: 'sess-A' })).held, null);
    assert.equal((await later.ask({ type: 'frame', path, session: 'sess-A', copy: same })).bytes, null);
    assert.deepEqual([again.disk.frames.size, again.disk.studies.size], [0, 0]);
    assert.equal(statusOf(restarted, STUDY).status, 'Evicted');
  }
});

test('two viewers of one copy: one leaving keeps it in use; each window counts once; the last to leave sets the date', async () => {
  const h = boot(), list = await ready(h);
  const first = await viewerOf(h), second = await viewerOf(h);
  h.advance(2 * HOUR);
  for (const { viewer, copy } of [first, first, second]) viewer.send({ type: 'open', uid: STUDY, copy, session: 'sess-A' });
  await until(() => statusOf(list, STUDY).expiresAt === SERVER_START + 74 * HOUR, 'opened at hour 2');
  h.advance(HOUR);
  first.viewer.send({ type: 'close', uid: STUDY, copy: first.copy, session: 'sess-A' });
  first.viewer.send({ type: 'close', uid: STUDY, copy: first.copy, session: 'sess-A' });
  first.viewer.send({ type: 'bye' });
  await tick(); await tick();
  assert.deepEqual([statusOf(list, STUDY).open, statusOf(list, STUDY).expiresAt], [true, SERVER_START + 74 * HOUR], 'still in use, date unchanged');
  h.advance(HOUR);
  second.viewer.send({ type: 'bye' });
  await until(() => statusOf(list, STUDY).expiresAt === SERVER_START + 76 * HOUR, 'the last viewer left at hour 4');
  assert.equal(statusOf(list, STUDY).open, false);
  // An open without this session, or of no copy the check confirmed, is not a use.
  const stray = h.connect(); stray.send({ type: 'hello', role: 'viewer' });
  h.advance(HOUR);
  stray.send({ type: 'open', uid: STUDY, copy: first.copy });
  stray.send({ type: 'open', uid: STUDY, copy: first.copy + 1, session: 'sess-A' });
  await tick(); await tick();
  assert.deepEqual([statusOf(list, STUDY).open, statusOf(list, STUDY).expiresAt], [false, SERVER_START + 76 * HOUR]);
});

test('a viewer that keeps showing a copy moves it on near its expiry; an open count alone does not, and an expired copy stays gone', async () => {
  const h = boot(), list = await ready(h), { viewer, copy } = await viewerOf(h);
  viewer.send({ type: 'open', uid: STUDY, copy, session: 'sess-A' });
  await until(() => keyReads(h) >= 1 && statusOf(list, STUDY).open, 'open');
  h.advance(50 * HOUR);
  viewer.send({ type: 'using', uid: STUDY, copy, session: 'sess-A' });
  await tick(); await tick();
  assert.equal(statusOf(list, STUDY).expiresAt, SERVER_START + 72 * HOUR, 'not yet within the hour before its expiry');
  h.advance(21.5 * HOUR);
  viewer.send({ type: 'using', uid: STUDY, copy, session: 'sess-A' });
  await until(() => statusOf(list, STUDY).expiresAt === SERVER_START + 143.5 * HOUR, 'moved on from hour 71.5');
  h.advance(HOUR); h.sweep(); await tick();
  assert.equal(statusOf(list, STUDY).status, 'Ready', 'read past 72 hours while shown');
  // Shown but never confirmed again: the open count alone keeps nothing past the date.
  h.advance(72 * HOUR); h.sweep();
  await until(() => statusOf(list, STUDY).status === 'Evicted', 'expired while still open');
  viewer.send({ type: 'using', uid: STUDY, copy, session: 'sess-A' });
  viewer.send({ type: 'bye' });
  await tick(); await tick();
  assert.equal(statusOf(list, STUDY).status, 'Evicted', 'a late use brings nothing back');
  assert.deepEqual([h.disk.frames.size, h.disk.studies.size], [0, 0]);
});

test('a new copy counts its own uses: an earlier copy\'s close or check reaches nothing of it', async () => {
  const h = boot(), list = await ready(h), { viewer, copy } = await viewerOf(h);
  viewer.send({ type: 'open', uid: STUDY, copy, session: 'sess-A' });
  await until(() => statusOf(list, STUDY).open, 'open');
  // The viewer's check found another revision: it drops the copy it checked.
  viewer.send({ type: 'evict', uid: STUDY, copy, session: 'sess-A', reason: 'changed' });
  await until(() => statusOf(list, STUDY).status === 'Evicted', 'dropped');
  h.advance(3 * HOUR);
  list.send({ type: 'retry', uid: STUDY });
  await until(() => statusOf(list, STUDY).status === 'Ready', 'a new copy');
  const fresh = (await viewer.ask({ type: 'query', uid: STUDY, session: 'sess-A' })).held.copy;
  assert.notEqual(fresh, copy);
  assert.deepEqual([statusOf(list, STUDY).open, statusOf(list, STUDY).expiresAt], [false, SERVER_START + 75 * HOUR]);
  h.advance(HOUR);
  viewer.send({ type: 'bye' });
  viewer.send({ type: 'evict', uid: STUDY, copy, session: 'sess-A', reason: 'late' });
  await tick(); await tick();
  assert.deepEqual([statusOf(list, STUDY).status, statusOf(list, STUDY).expiresAt], ['Ready', SERVER_START + 75 * HOUR],
    'the old window\'s leaving and its late evict reach nothing of the new copy');
  assert.equal((await studyRecord(h, STUDY)).manifest.usedAt, null);
});

test('a use counts only once the key is issued again; another key stops the old key, a failure keeps the date', async () => {
  let answer = 'same';
  const h = boot({ keyResponse: () => answer === 'down' ? new Response('', { status: 503 })
    : new Response(JSON.stringify({ keyId: answer === 'same' ? 'key-A' : 'key-N', key: KEY.toString('base64'), serverTime: new Date(h.now()).toISOString() })) });
  const list = await ready(h);
  const opened = async () => { const v = await viewerOf(h); v.viewer.send({ type: 'open', uid: STUDY, copy: v.copy, session: 'sess-A' }); return v; };
  h.advance(5 * HOUR); answer = 'down';
  const down = await opened();
  await until(() => statusOf(list, STUDY).open && keyReads(h) >= 2, 'asked the key');
  await tick();
  assert.equal(statusOf(list, STUDY).expiresAt, SERVER_START + 72 * HOUR, 'no issue, no move');
  down.viewer.send({ type: 'bye' });
  h.advance(HOUR); answer = 'same';
  const fine = await opened();
  await until(() => statusOf(list, STUDY).expiresAt === SERVER_START + 78 * HOUR, 'issued again at hour 6');
  fine.viewer.send({ type: 'bye' });
  await until(() => statusOf(list, STUDY).open === false, 'left');
  h.advance(HOUR); answer = 'other';
  const swapped = await opened();
  await until(() => keyReads(h) >= 4 && !list.state().studies.some(s => s.uid === STUDY && s.status === 'Ready') , 'old key no longer serves');
  assert.equal((await swapped.viewer.ask({ type: 'query', uid: STUDY, session: 'sess-A' })).held, null);
});
/** The worker started again on the same disk at server hour `hour` (same key): its list port once the store is restored. */
async function restartedAt(h, hour, skew = 0) {
  const again = boot({ disk: h.disk, skew, keyResponse: () => new Response(JSON.stringify({ keyId: 'key-A', key: KEY.toString('base64'),
    serverTime: new Date(SERVER_START + hour * HOUR).toISOString() })) });
  again.advance(hour * HOUR);
  const list = again.connect(); list.send({ type: 'hello', role: 'list' }); list.send({ type: 'session', session: 'sess-A' });
  await until(() => statusOf(list, STUDY), 'restored');
  return { again, list };
}
/** A copy received at hour 0, open in a viewer, whose viewer says at hour 71.9 that it still shows it. */
async function usedNearItsDate() {
  const h = boot(), list = await ready(h), { viewer, copy } = await viewerOf(h);
  viewer.send({ type: 'open', uid: STUDY, copy, session: 'sess-A' });
  // Key reads so far: the setup, the issue at the copy's first frame, the issue for this open.
  await until(() => statusOf(list, STUDY).open && keyReads(h) >= 3, 'open');
  for (let i = 0; i < 20; i++) await tick();
  assert.equal(statusOf(list, STUDY).expiresAt, SERVER_START + 72 * HOUR, 'opened at hour 0: the date is hour 72');
  h.advance(71.9 * HOUR);
  const records = [], write = h.disk.write;
  return { h, list, viewer, copy, records, write,
    /** `during(n, puts)` runs inside the n-th write of the study record from here on (1: the claim, 2: the approval). */
    using(during) {
      h.disk.write = async (puts = {}, deletes = {}) => {
        if ((puts.studies || []).length) { records.push(puts.studies[0].expiresAt); await during(records.length); }
        return write(puts, deletes);
      };
      viewer.send({ type: 'using', uid: STUDY, copy, session: 'sess-A' });
    } };
}

test('a use is two writes of the record, judged once when the first has ended: a write that ends past the copy\'s date leaves that date - on disk, after a restart and in memory - with no query or sweep sent first', async () => {
  const t = await usedNearItsDate();
  // The claim's write starts at hour 71.9 and ends at hour 72.1.
  t.using(async n => { if (n === 1) t.h.advance(0.2 * HOUR); });
  await until(() => t.records.length >= 1, 'the claim written');
  for (let i = 0; i < 40; i++) await tick();
  assert.deepEqual(t.records, [SERVER_START + 72 * HOUR], 'one write, with the date the copy had: no approval follows');
  const { record, manifest } = await studyRecord(t.h, STUDY);
  assert.deepEqual([record.expiresAt, manifest.usedAt], [SERVER_START + 72 * HOUR, SERVER_START], 'the record still says hour 72');
  assert.ok(t.h.disk.frames.size > 0, 'nothing was swept: the old worker was asked nothing');
  // Hour 73, the worker started again on that disk - the old worker was sent no query and ran no sweep.
  const { again, list } = await restartedAt(t.h, 73);
  assert.equal(statusOf(list, STUDY).status, 'Evicted', 'not Ready after the restart');
  assert.match(statusOf(list, STUDY).reason, /표시된 보관 기한이 지나/);
  const viewer = again.connect(); viewer.send({ type: 'hello', role: 'viewer' });
  assert.equal((await viewer.ask({ type: 'query', uid: STUDY, session: 'sess-A' })).held, null);
  assert.equal((await viewer.ask({ type: 'frame', path: FRAME, session: 'sess-A', copy: t.copy })).bytes, null, 'no frame');
  assert.deepEqual([again.disk.frames.size, again.disk.studies.size], [0, 0]);
  // The old worker itself: its model kept hour 72 too.
  assert.equal(t.list.state().studies.find(s => s.uid === STUDY).expiresAt, SERVER_START + 72 * HOUR);
});

test('a use whose approval is not stored - the write fails, or the worker stops between the two writes - leaves the earlier date; one approved in time holds across a restart even when its write ends later', async () => {
  for (const how of ['approval fails', 'stopped between']) {
    const t = await usedNearItsDate();
    t.using(n => n !== 2 ? null : how === 'approval fails' ? Promise.reject(Object.assign(new Error('quota'), { name: 'QuotaExceededError' }))
      : new Promise(() => {}));                                          // the worker never gets past this write
    await until(() => t.records.length >= 2, how + ': both writes begun');
    for (let i = 0; i < 20; i++) await tick();
    // The second write would have carried hour 143.9; it never reached the disk.
    assert.deepEqual(t.records, [SERVER_START + 72 * HOUR, SERVER_START + 143.9 * HOUR], how);
    const { record, manifest } = await studyRecord(t.h, STUDY);
    assert.deepEqual([record.expiresAt, manifest.usedAt, manifest.claimedUse], [SERVER_START + 72 * HOUR, SERVER_START, SERVER_START + 71.9 * HOUR],
      how + ': the disk holds the claim only, under the date the copy had');
    assert.equal(statusOf(t.list, STUDY).expiresAt, SERVER_START + 72 * HOUR, how + ': the model kept the date');
    const { again, list } = await restartedAt(t.h, 73);
    assert.equal(statusOf(list, STUDY).status, 'Evicted', how + ': a claim counts for nothing after a restart');
    assert.deepEqual([again.disk.frames.size, again.disk.studies.size], [0, 0], how);
  }
  // Approved at hour 71.9 (the claim's write ended before the date); the approval's own write ends at hour 72.1.
  const t = await usedNearItsDate();
  t.using(async n => { if (n === 2) t.h.advance(0.2 * HOUR); });
  await until(() => statusOf(t.list, STUDY).expiresAt === SERVER_START + 143.9 * HOUR, 'the model moves once the approval is stored');
  assert.equal(statusOf(t.list, STUDY).status, 'Ready', 'panel, model and disk say the same date');
  const { record, manifest } = await studyRecord(t.h, STUDY);
  assert.deepEqual([record.expiresAt, manifest.usedAt, manifest.claimedUse], [SERVER_START + 143.9 * HOUR, SERVER_START + 71.9 * HOUR, undefined]);
  assert.ok((await t.viewer.ask({ type: 'frame', path: FRAME, session: 'sess-A', copy: t.copy })).bytes);
  t.list.send({ type: 'session', session: null });
  const { again, list } = await restartedAt(t.h, 73);
  assert.deepEqual([statusOf(list, STUDY).status, statusOf(list, STUDY).expiresAt], ['Ready', SERVER_START + 143.9 * HOUR], 'the use holds after a restart');
  const viewer = again.connect(); viewer.send({ type: 'hello', role: 'viewer' });
  const held = (await viewer.ask({ type: 'query', uid: STUDY, session: 'sess-A' })).held;
  assert.ok((await viewer.ask({ type: 'frame', path: FRAME, session: 'sess-A', copy: held.copy })).bytes);
});

test('server time is not the PC clock: set back, or forward and back again, while the worker runs, a copy still ends at its server date - no query, no frame, and no Ready on a panel opened before the next sweep', async () => {
  for (const turns of [[-6], [-30 * 24], [3, -9]]) {
    const h = boot(), list = await ready(h);
    const { viewer, copy } = await viewerOf(h);
    h.advance(10 * HOUR);
    for (const hours of turns) { h.setSkew(hours * HOUR); h.advance(HOUR); }   // someone sets the PC clock
    h.advance((72 - 10 - turns.length) * HOUR - 1);
    if (turns.every(hours => hours < 0)) assert.ok((await viewer.ask({ type: 'query', uid: STUDY, session: 'sess-A' })).held, 'held until its date');
    h.advance(1);                                                         // server hour 72 exactly
    // A panel opened now, before any query or sweep: the row is not Ready and says why.
    const panel = h.connect(); panel.send({ type: 'hello', role: 'list' });
    const row = statusOf(panel, STUDY);
    assert.deepEqual([row.status, row.open, row.done, row.bytes], ['Evicted', false, 0, 0], JSON.stringify(turns));
    assert.match(row.reason, /표시된 보관 기한이 지나/);
    assert.ok(h.disk.frames.size > 0, 'shown so before the sweep removed anything');
    assert.equal((await viewer.ask({ type: 'frame', path: FRAME, session: 'sess-A', copy })).bytes, null, 'no frame at its date');
    assert.equal((await viewer.ask({ type: 'query', uid: STUDY, session: 'sess-A' })).held, null, 'not held at its date');
    assert.deepEqual([h.disk.frames.size, h.disk.studies.size], [0, 0]);
  }
});

test('a copy fetched after the key was replaced is another copy: the earlier copy\'s late open, close and drop reach nothing of it', async () => {
  let keyName = 'key-A';
  const h = boot({ keyResponse: () => new Response(JSON.stringify({ keyId: keyName, key: KEY.toString('base64'), serverTime: new Date(h.now()).toISOString() })) });
  const list = await ready(h), old = await viewerOf(h);
  // The server retired the key; the next issue (asked for a use) answers another. The old key serves nothing more.
  keyName = 'key-N';
  old.viewer.send({ type: 'open', uid: STUDY, copy: old.copy, session: 'sess-A' });
  await until(() => !statusOf(list, STUDY), 'the old key\'s store is gone');
  list.send({ type: 'add', session: 'sess-A', studies: [{ uid: STUDY }] });
  await until(() => statusOf(list, STUDY)?.status === 'Ready', 'fetched again under the new key');
  const fresh = (await old.viewer.ask({ type: 'query', uid: STUDY, session: 'sess-A' })).held.copy;
  assert.notEqual(fresh, old.copy, 'the same session, the same study, another copy');
  h.advance(HOUR);
  // Late messages of the viewer that checked the earlier copy: same session, the earlier copy's name.
  old.viewer.send({ type: 'open', uid: STUDY, copy: old.copy, session: 'sess-A' });
  old.viewer.send({ type: 'evict', uid: STUDY, copy: old.copy, session: 'sess-A', reason: 'late' });
  old.viewer.send({ type: 'close', uid: STUDY, copy: old.copy, session: 'sess-A' });
  for (let i = 0; i < 20; i++) await tick();
  const row = statusOf(list, STUDY);
  assert.deepEqual([row.status, row.open, row.expiresAt], ['Ready', false, SERVER_START + 72 * HOUR], 'neither opened, dropped nor moved on');
  assert.equal((await old.viewer.ask({ type: 'frame', path: FRAME, session: 'sess-A', copy: old.copy })).bytes, null, 'nor read under the old name');
  assert.ok((await old.viewer.ask({ type: 'frame', path: FRAME, session: 'sess-A', copy: fresh })).bytes);
});

test('a copy whose key could not be issued again at its first frame ends at the date its row shows, and is said to have gone at that date - not after 72 hours', async () => {
  let issues = 0;
  const h = boot({ keyResponse: () => ++issues === 1 ? new Response(JSON.stringify({ keyId: 'key-A', key: KEY.toString('base64'), serverTime: new Date(h.now()).toISOString() }))
    : new Response('', { status: 503 }) });
  const release = h.hold();
  const list = h.connect(); list.send({ type: 'hello', role: 'list' });
  list.send({ type: 'add', session: 'sess-A', studies: [{ uid: STUDY }] });
  await until(() => h.reads().length >= 1, 'the first image read waits');
  h.advance(3 * HOUR);                            // the frames come in three hours after the key was issued
  release();
  await until(() => statusOf(list, STUDY)?.status === 'Ready', 'Ready');
  // Received at hour 3 under a key last issued at hour 0: the row says hour 72, and that is when reading ends.
  assert.equal(statusOf(list, STUDY).expiresAt, SERVER_START + 72 * HOUR);
  const { viewer, copy } = await viewerOf(h);
  h.advance(69 * HOUR - 1);
  assert.ok((await viewer.ask({ type: 'frame', path: FRAME, session: 'sess-A', copy })).bytes, 'read until the date shown');
  h.advance(1);
  assert.equal((await viewer.ask({ type: 'frame', path: FRAME, session: 'sess-A', copy })).bytes, null, 'and not at it');
  await until(() => statusOf(list, STUDY).status === 'Evicted', 'gone');
  assert.match(statusOf(list, STUDY).reason, /표시된 보관 기한이 지나 자동으로 지웠습니다/);
  assert.doesNotMatch(statusOf(list, STUDY).reason, /72시간/, 'the copy was kept 69 hours: the words claim no 72');
});

test('the last viewer closing a copy (another patient shown, last tab closed) lets a study waiting for space go on, as leaving the window does', async () => {
  const h = boot({ diskGb: 1800 / 1024 ** 3 }), list = await ready(h), { viewer, copy } = await viewerOf(h);
  viewer.send({ type: 'open', uid: STUDY, copy, session: 'sess-A' });
  await until(() => statusOf(list, STUDY).open, 'open');
  list.send({ type: 'add', session: 'sess-A', studies: [{ uid: OTHER }] });
  await until(() => statusOf(list, OTHER)?.waiting, 'waiting while the open copy may not go');
  viewer.send({ type: 'close', uid: STUDY, copy, session: 'sess-A' });
  await until(() => statusOf(list, OTHER)?.status === 'Ready', 'the closed copy made room');
  assert.equal(statusOf(list, STUDY).status, 'Evicted');
});

test('space is given back from another account by the real expiry: a used copy\'s frames go with its record, after a copy that ends sooner', async () => {
  const disk = memoryDisk();
  const issue = (id, time) => () => new Response(JSON.stringify({ keyId: id, key: KEY.toString('base64'), serverTime: new Date(time).toISOString() }));
  // Account B receives two studies at hour 0; it uses the first at hour 24 (record until 96), the second stays until 72.
  const b = boot({ disk, keyResponse: () => issue('key-B', b.now())() }), lb = await ready(b);
  lb.send({ type: 'add', session: 'sess-A', studies: [{ uid: OTHER }] });
  await until(() => statusOf(lb, OTHER)?.status === 'Ready', 'second Ready');
  b.advance(24 * HOUR);
  const { viewer, copy } = await viewerOf(b);
  viewer.send({ type: 'open', uid: STUDY, copy, session: 'sess-A' });
  await until(() => statusOf(lb, STUDY).expiresAt === SERVER_START + 96 * HOUR, 'used');
  lb.send({ type: 'session', session: null });
  const used = (await studyRecord(b, STUDY)).record, unused = (await studyRecord(b, OTHER)).record;
  const bytes = [...disk.frames.values(), ...disk.studies.values()].reduce((n, r) => n + r.ct.byteLength, 0);
  // Account C at hour 30 needs about one study's room.
  const c = boot({ disk, diskGb: (bytes + 100) / 1024 ** 3, keyResponse: issue('key-C', SERVER_START + 30 * HOUR) });
  await ready(c, '1.2.840.9.3');
  assert.equal(disk.studies.has(unused.manifestId), false, 'the copy ending at hour 72 went first');
  assert.ok(unused.frameIds.every(id => !disk.frames.has(id)), 'with its frames');
  assert.ok(disk.studies.has(used.manifestId) && used.frameIds.every(id => disk.frames.has(id)), 'the used copy is whole');
});

test('a copy counts from its own receipt and its own use, never shortened by an earlier key issue', async () => {
  const h = boot();
  const release = h.hold();
  const list = h.connect(); list.send({ type: 'hello', role: 'list' });
  list.send({ type: 'add', session: 'sess-A', studies: [{ uid: STUDY }] });
  await until(() => h.reads().length >= 1, 'the first image read waits');
  h.advance(3 * HOUR);                            // the frames come in three hours after the key was issued
  release();
  await until(() => statusOf(list, STUDY)?.status === 'Ready', 'Ready');
  assert.equal(statusOf(list, STUDY).expiresAt, SERVER_START + 75 * HOUR);
  h.advance(5 * 60000);
  const { viewer, copy } = await viewerOf(h);
  viewer.send({ type: 'open', uid: STUDY, copy, session: 'sess-A' });
  await until(() => statusOf(list, STUDY).expiresAt === SERVER_START + 3 * HOUR + 5 * 60000 + 72 * HOUR, 'opened at 3h05');
  h.advance(4 * 60000);
  viewer.send({ type: 'bye' });
  await until(() => statusOf(list, STUDY).expiresAt === SERVER_START + 3 * HOUR + 9 * 60000 + 72 * HOUR, 'left at 3h09');
});

test('the exam scope asked again after the frames must come in full: a body cut after its headers is no Ready', async () => {
  let scopeReads = 0;
  const { connect, disk } = boot({ respond: async url => {
    if (url.startsWith('/api/studies/')) {
      const body = JSON.stringify({ sources: [{ studyUid: STUDY, series: { mode: 'all', uids: [] } }] });
      return ++scopeReads === 2 ? new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(body.slice(0, 5))); c.error(new TypeError('cut')); } }))
        : new Response(body);
    }
    if (url.endsWith('/metadata')) return new Response(JSON.stringify(metadata(STUDY)));
    return new Response(zlib.gzipSync(multipart('x')), { headers: { 'Content-Type': 'application/gzip', 'X-KIN-Part-Type': PART, 'X-KIN-Study-Revision': 'r' } });
  } });
  const list = connect(); list.send({ type: 'hello', role: 'list' });
  list.send({ type: 'add', session: 'sess-1', studies: [{ uid: STUDY, examRefs: [{ reportUid: STUDY + '.0', key: 'exam' }] }] });
  await until(() => statusOf(list, STUDY)?.status === 'Failed', 'failed');
  assert.match(statusOf(list, STUDY).reason, /서버에 연결하지 못했습니다/);
  assert.equal(disk.frames.size, 0);
});
