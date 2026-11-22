/* D1890: only ciphertext survives the worker. A viewer still needs its live check and durable user-view root. */
'use strict';
// The viewer write path (viewer-language.js): product words in the reader's screen language, or as written.
function kinText(t, ...p) { const l = typeof window === 'object' && window && window.KinLanguage; return l && l.text ? l.text(t, ...p) : t.replace(/\{[ten]?(\d+)\}/g, (m, i) => String(p[i])); }
function kinHtml(t, ...p) { const l = typeof window === 'object' && window && window.KinLanguage; return l && l.html ? l.html(t, ...p) : t.replace(/\{[ten]?(\d+)\}/g, (m, i) => String(p[i])); }
importScripts('preload-store.js', 'preload-disk.js', 'session-transport.js');
const Model = self.KinPreloadStore, Disk = self.KinPreloadDisk, disk = Disk.create(), Transport = self.KinSessionTransport;
const FRAME_ACCEPT = ['application/octet-stream', 'image/jpeg', 'image/jls', 'image/jp2', 'image/dicom-rle']
  .map(type => 'multipart/related; type="' + type + '"; transfer-syntax=*').join(', ');
// A viewer that keeps showing a copy says so (viewer-preload.js); within this much of its expiry the use moves it on.
const RENEW_BEFORE = 60 * 60 * 1000;
const MESSAGES = Object.freeze({
  unavailable: kinText("이 브라우저의 보관 저장소를 사용할 수 없습니다. 다시 시도하세요."),
  unset: kinText("이 기관에서 미리 받기에 쓸 저장 용량을 아직 정하지 않아 미리 받기를 할 수 없습니다. 관리자에게 문의하세요."),
  key: kinText("이 계정으로는 미리 받기를 쓸 수 없습니다"),
  cleared: kinText("미리 받은 영상을 비웠습니다."),
  dequeued: kinText("받기 전에 대기열에서 뺐습니다. 다시 받으려면 Retry를 누르세요."),
  denied: kinText("검사 접근이 거절되었습니다. 접근 권한을 확인하세요."),
  missing: kinText("영상을 찾을 수 없습니다."),
  busy: kinText("서버가 바쁘거나 응답하지 않았습니다. 다시 시도하세요."),
  network: kinText("서버에 연결하지 못했습니다. 다시 시도하세요."),
  changed: kinText("미리 받는 동안 검사 내용이 바뀌었습니다. 다시 시도하세요."),
  empty: kinText("이 검사에는 미리 받을 영상이 없습니다."),
  size: kinText("검사가 미리 받기 저장 용량보다 커서 받을 수 없습니다. 판독 때 바로 엽니다."),
  malformed: kinText("서버 응답을 해석하지 못했습니다. 다시 시도하세요."),
  corrupt: kinText("보관한 영상이 손상되어 지웠습니다. 다시 받으려면 Retry를 누르세요."),
  space: kinText("저장 공간이 비기를 기다립니다."),
});
const ports = new Map(), manifests = new Map();
let session = null, epoch = 0, key = null, keyId = null, settings = null, unavailable = null;
// The server time of the latest issue of this key (/api/preload/cache-key renews it): no copy's received or used time
// counts past it, so the key outlives every copy it reads (the server retires a key 72 hours after its last issue).
let issuedAt = null;
/**
 * Server time: what the server last said (a key answer's serverTime; before any, an answer's Date) plus the time since,
 * read from the clock nobody can set (performance.now()). The PC's own clock decides nothing: set back or forward while
 * the worker runs, it neither brings an expired copy back nor ends a copy before its date.
 * It is only a hint. Where it has run ahead of the ticks since the server's last word (`adrift`), the PC slept with its
 * ticks stopped or its clock was set forward - the worker cannot tell which. So it asks the server before it serves
 * anything (`resync`), and until the server has said the time it serves nothing and removes nothing by that doubt.
 * The server's word moves the time on or confirms it; either way the PC clock is read against it afresh.
 */
let said = null, asked = -Infinity, syncing = null;
// The two clocks are taken to disagree past SLACK (their ordinary drift is far smaller; a stopped tick is not).
const SLACK = 2 * 1000, ASK_AGAIN = 5 * 1000;
const ticks = () => typeof performance === 'object' ? performance.now() : Date.now();
const word = server => ({ server, ticks: ticks(), wall: Date.now() });
const timeBy = heard => heard.server + Math.max(0, ticks() - heard.ticks);
const now = () => said ? timeBy(said) : Date.now();
function hear(heard) { if (Number.isFinite(heard.server)) said = !said || timeBy(heard) >= now() ? heard : word(now()); }
const adrift = () => !!said && (Date.now() - said.wall) - (ticks() - said.ticks) > SLACK;
let store = Model.create(null, now), running = false, controller = null, keyController = null, idleWaiters = [];
let serial = Promise.resolve(), diskUsed = 0;
// Mutations share one queue. Network reads never hold it, so reading and logout can interrupt downloads.
function locked(task) { const run = serial.then(task); serial = run.catch(() => {}); return run; }
class Stop extends Error { constructor(reason) { super(reason); this.reason = reason; } }
function broadcast() {
  const state = { type: 'state', session, unavailable, ...store.snapshot(), used: diskUsed };
  for (const [port, info] of ports) if (info.role === 'list') { try { port.postMessage(state); } catch (_) {} }
}
function busy() { return [...ports.values()].some(info => info.busy); }
function settleIdle() { if (!busy()) for (const resolve of idleWaiters.splice(0)) resolve(); }
function idle() { return busy() ? new Promise(resolve => idleWaiters.push(resolve)) : Promise.resolve(); }
function changeSession(next) {
  epoch++; controller?.abort(); keyController?.abort();
  session = next; key = null; keyId = null; settings = null; unavailable = null; issuedAt = null;
  store = Model.create(null, now); manifests.clear(); diskUsed = 0;
  for (const info of ports.values()) info.opens.clear();
  for (const resolve of idleWaiters.splice(0)) resolve();
  broadcast();
}
async function get(url, headers, signal, bound = session) {
  let response;
  try { response = await fetch(url, { headers: { ...headers, 'X-KIN-Session': bound }, cache: 'no-store',
    credentials: 'same-origin', priority: 'low', signal }); }
  catch (_) { throw new Stop(signal?.aborted ? null : MESSAGES.network); }
  if (bound === session && !said) hear(word(Date.parse(response.headers.get('Date'))));
  if (response.ok) return response;
  const code = response.headers.get('X-KIN-Auth-Code');
  try { await response.body?.cancel(); } catch (_) {}
  if (response.status === 401 || response.status === 428 || ['AUTH_SESSION_ENDED', 'AUTH_SESSION_MISMATCH'].includes(code)) throw new Stop('ended');
  if (url === '/api/preload/cache-key' && [403, 404].includes(response.status)) throw new Stop(MESSAGES.key);
  // A refused study only by the one shared reading of a refusal: a DICOM 403 with an AUTH_* code (an archive the gate could
  // not observe, a busy session check) is temporary, never a refused study.
  if (response.status === 403 && Transport.refusal(response) === 'denied') throw new Stop(MESSAGES.denied);
  if (response.status === 404) throw new Stop(MESSAGES.missing);
  throw new Stop(MESSAGES.busy);
}
/** A JSON answer's body: a cut read is the network's failure, an unreadable body the server's - never the browser's store. */
async function readJson(response, signal) {
  let text;
  try { text = await response.text(); } catch (_) { throw new Stop(signal?.aborted ? null : MESSAGES.network); }
  try { return JSON.parse(text); } catch (_) { throw new Stop(MESSAGES.malformed); }
}
const recordBytes = record => record.bytes ?? record.ct.byteLength;
async function inventory() {
  const records = await disk.list();
  diskUsed = [...records.frames, ...records.studies].reduce((n, r) => n + recordBytes(r), 0);
  return records;
}
async function erase(uid, reason, failed = false) {
  const mine = epoch;
  const ids = failed ? store.fail(uid, reason) : store.evict(uid, reason);
  const id = manifests.get(uid); manifests.delete(uid);
  await disk.write({}, { frames: ids, studies: id ? [id] : [] });
  await inventory();
  if (failed && mine === epoch && key && store.get(uid)?.expiresAt > now()) await persist(uid);
}
async function sweep() {
  // The first key response establishes server time. No cached answer is possible before this initialization.
  if (!said) return;
  const expired = store.entries().filter(s => s.expiresAt <= now());
  const ids = store.expire(now());
  const studies = expired.map(s => manifests.get(s.uid)).filter(Boolean);
  for (const s of expired) manifests.delete(s.uid);
  if (ids.length || studies.length) await disk.write({}, { frames: ids, studies });
  const removed = await disk.sweep(now());
  if (ids.length || studies.length || removed) { await inventory(); store.wake(); }
  if (expired.length) broadcast();
}
/** The study record of uid as the model holds it, or with change (a use not yet on disk) laid over it. */
async function envelope(uid, change = {}) {
  const study = store.get(uid);
  let manifestId = manifests.get(uid);
  if (!manifestId) { manifestId = crypto.randomUUID(); manifests.set(uid, manifestId); }
  const manifest = { ...store.manifest(uid), ...change };
  const value = await Disk.seal(key, new TextEncoder().encode(JSON.stringify(manifest)), Disk.studyAAD(keyId, manifestId));
  return { manifestId, keyId, expiresAt: Model.expiryOf(manifest), frameIds: Object.values(manifest.frames), ...value };
}
async function room(extra, uid) {
  const mine = epoch;
  await sweep();
  const fits = async () => {
    const estimate = await disk.estimate();
    return mine === epoch && store.budget() !== null && diskUsed + extra <= store.budget()
      && !(Number.isFinite(estimate.quota) && Number.isFinite(estimate.usage) && estimate.usage + extra > estimate.quota);
  };
  if (await fits()) return true;
  const records = await inventory();
  if (mine !== epoch) return false;
  // Foreign records remain opaque. Their real expiry (a record's, shared by the frames it lists) is the only ordering fact
  // required to reclaim them, a record and its frames together.
  for (const unit of Disk.holdings(records).filter(u => u.keyId !== keyId).sort((a, b) => a.expiresAt - b.expiresAt)) {
    if (mine !== epoch) return false;
    await disk.write({}, { frames: unit.frames, studies: unit.studies });
    await inventory();
    if (await fits()) return true;
  }
  for (const victim of store.evictable(uid)) {
    if (mine !== epoch) return false;
    await erase(victim.uid, kinText("저장 공간을 비우려고 이미 본 검사를 지웠습니다. 다시 받으려면 Retry를 누르세요."));
    if (await fits()) return true;
  }
  return false;
}
async function persist(uid) {
  if (!key || !store.get(uid)) return false;
  const mine = epoch, record = await envelope(uid);
  const prior = (await inventory()).studies.find(r => r.manifestId === record.manifestId);
  if (!await room(Math.max(0, recordBytes(record) - (prior ? recordBytes(prior) : 0)), uid)) return false;
  if (mine !== epoch || !key || store.get(uid)?.expiresAt <= now()) return false;
  await disk.write({ studies: [record] }); await inventory(); return true;
}
/** Frames the model let go (a Preload for another exam of the same original, an eviction for space) leave the disk too. */
async function flushReleased() {
  const ids = store.takeReleased();
  if (ids.length) { await disk.write({}, { frames: ids }); await inventory(); }
}
/**
 * The key issued again for this session (outside the queue: a slow answer holds no frame read or logout). The server
 * time of an answer for this very key, else null: another key (the old one was retired) or a refused account stops
 * serving from the old key in memory; a failure that may pass changes nothing.
 */
async function renewKey(mine, bound) {
  let answer, heard;
  try {
    answer = await readJson(await get('/api/preload/cache-key', { Accept: 'application/json' }, undefined, bound));
    heard = word(Date.parse(answer?.serverTime));
  } catch (error) {
    if (mine !== epoch || bound !== session) return null;
    if (error?.reason === 'ended') changeSession(null);
    else if (error?.reason === MESSAGES.key) { changeSession(bound); void prerequisites(); }
    return null;
  }
  const at = heard.server;
  if (mine !== epoch || bound !== session || !Number.isFinite(at)) return null;
  if (answer.keyId !== keyId) { changeSession(bound); void prerequisites().then(() => pump()); return null; }
  hear(heard);
  issuedAt = Math.max(issuedAt ?? at, at);
  return at;
}
/**
 * The server asked for its time (the key's issue says it) when the PC clock has run ahead of the ticks. Outside the
 * queue, like every network read; not asked again at once when the server could not be reached.
 */
function resync() {
  if (!adrift() || !session || !key) return Promise.resolve();
  // Everything that waits for the time waits for the one question under way.
  if (syncing) return syncing;
  if (ticks() - asked < ASK_AGAIN) return Promise.resolve();
  asked = ticks();
  syncing = renewKey(epoch, session).catch(() => {}).then(() => { syncing = null; });
  return syncing;
}
/**
 * A confirmed use of `copy` at `at` (server time) moves the copy's expiry to 72 hours after it - once the key has been
 * issued again at or after it, and by two writes of the study record alone (its frames' ciphertext is neither read nor
 * written again: preload-disk.js sweep keeps a live record's frames):
 *   1. the claim - the record as it stands, its expiry unchanged, with the use beside it. A claim counts for nothing:
 *      restore and the disk sweep read the expiry the record had.
 *   2. the approval - the record with the use and its new expiry, and only after it the model.
 * The one judgement is made when the claim's write has ended: the same session, key and copy, and server time still
 * before the expiry the copy had. A write that ends past that expiry, a refusal, a worker stopped between the writes
 * or an approval that could not be stored all leave the earlier expiry - on disk, after a restart and in memory alike.
 */
async function touch(uid, copy, at) {
  const mine = epoch, bound = session, held = keyId;
  if (!bound || !key || store.get(uid)?.copy !== copy) return;
  // The key is issued again at or after the use, so the use counts from its own time and the key outlives the copy.
  const issued = await renewKey(mine, bound);
  if (issued === null) return;
  await locked(async () => {
    const study = store.get(uid), usedAt = Math.min(at, issued);
    const same = () => mine === epoch && bound === session && !!key && keyId === held && store.get(uid) === study;
    if (!study || !same() || !store.usable(uid, copy, usedAt)) return;
    try {
      const claim = await envelope(uid, { claimedUse: usedAt });
      if (!same()) return;
      await disk.write({ studies: [claim] }); await inventory();
    } catch (_) { return; }
    // The judgement, here and nowhere else.
    if (!same() || !store.approve(uid, copy, usedAt)) return;
    try {
      const record = await envelope(uid, { usedAt });
      if (!same()) throw new Stop(null);
      await disk.write({ studies: [record] });
    } catch (_) {
      if (mine === epoch && store.get(uid) === study) { store.refuse(uid); broadcast(); }
      return;
    }
    // Approved and stored. Only a session that changed meanwhile has another model: its own restore reads the record.
    if (mine !== epoch || store.get(uid) !== study || !store.use(uid, copy, usedAt)) return;
    await inventory(); broadcast();
  });
}
function prerequisites() {
  if (settings) return settings;
  const mine = epoch, bound = session;
  keyController = new AbortController(); const signal = keyController.signal;
  const asked = (async () => {
    try {
      const response = await get('/api/preload/cache-key', { Accept: 'application/json' }, signal, bound);
      const answer = await readJson(response, signal);
      const raw = Uint8Array.from(atob(answer.key), c => c.charCodeAt(0));
      if (raw.length !== 32 || !Number.isFinite(Date.parse(answer.serverTime)) || typeof answer.keyId !== 'string') { raw.fill(0); throw new Stop(MESSAGES.key); }
      const heard = word(Date.parse(answer.serverTime));
      const imported = await Disk.importKey(raw);
      if (mine !== epoch) return MESSAGES.key;
      const me = await readJson(await get('/api/me', { Accept: 'application/json' }, signal, bound), signal);
      if (mine !== epoch) return MESSAGES.key;
      await locked(async () => {
        if (mine !== epoch) return;
        key = imported; keyId = answer.keyId; hear(heard); issuedAt = heard.server;
        store.setBudget(Model.budgetFor(me.preloadDiskGb));
        // Restore before sweeping so this session can show the expired row's reason and Retry.
        const records = await inventory(), frames = new Map(records.frames.map(r => [r.entryId, r]));
        for (const record of records.studies.filter(r => r.keyId === keyId)) {
          try {
            const value = JSON.parse(new TextDecoder().decode(await Disk.open(key, record, Disk.studyAAD(keyId, record.manifestId))));
            if (mine !== epoch) return;
            if (!/^[0-9.]{1,64}$/.test(value.uid) || !value.frames || !Number.isFinite(value.queuedAt)) throw new Error('manifest');
            store.restore(value, frames); manifests.set(value.uid, record.manifestId);
            if (Object.values(value.frames).some(id => !frames.has(id))) await erase(value.uid, MESSAGES.missing);
          } catch (_) { await disk.write({}, { studies: [record.manifestId] }); }
        }
        if (mine !== epoch) return;
        const referenced = new Set(store.entries().flatMap(s => [...s.frames.values()].map(f => f.entryId)));
        await disk.write({}, { frames: records.frames.filter(r => r.keyId === keyId && !referenced.has(r.entryId)).map(r => r.entryId) });
        await sweep();
      });
      return store.budget() === null ? MESSAGES.unset : null;
    } catch (error) {
      if (mine !== epoch) return MESSAGES.key;
      if (error.reason === 'ended') { changeSession(null); return MESSAGES.key; }
      key = null; keyId = null; store.setBudget(null);
      await locked(sweep).catch(() => {});
      return error instanceof Stop ? error.reason || MESSAGES.network : MESSAGES.unavailable;
    }
  })().then(reason => {
    if (mine === epoch) { unavailable = reason; broadcast(); }
    // Successful sessions issue once. A failed setup can recover through the existing Retry control.
    if (reason && settings === asked) settings = null;
    return reason;
  });
  settings = asked; return asked;
}
const tag = (item, name) => item?.[name]?.Value?.[0];
function objects(metadata) {
  if (!Array.isArray(metadata)) throw new Stop(MESSAGES.malformed);
  return metadata.flatMap(item => {
    const series = tag(item, '0020000E'), sop = tag(item, '00080018'), frames = Number(tag(item, '00280008') ?? 1);
    return item?.['7FE00010'] && /^[0-9.]{1,64}$/.test(series) && /^[0-9.]{1,64}$/.test(sop) && Number.isInteger(frames) && frames > 0
      ? [{ series, sop, frames }] : [];
  });
}
function framePaths(uid, list) {
  const base = o => `/dicom-web/studies/${uid}/series/${o.series}/instances/${o.sop}/frames/`;
  return { first: list.map(o => base(o) + 1), rest: list.flatMap(o => Array.from({ length: o.frames - 1 }, (_, i) => base(o) + (i + 2))) };
}
/** The series each exam the copy was asked for reads of the original now (none: the whole original), read in full. */
async function examSeries(study, signal, bound) {
  const scopes = [];
  for (const ref of study.examRefs || []) {
    const query = new URLSearchParams({ purpose: 'current', reference: JSON.stringify(ref) });
    const scope = await readJson(await get('/api/studies/' + encodeURIComponent(ref.reportUid) + '/exam-scope?' + query, {}, signal, bound), signal);
    const source = scope?.sources?.find(source => source.studyUid === study.uid);
    if (!source) throw new Stop(MESSAGES.changed);
    scopes.push(source.series);
  }
  return scopes;
}
async function download(study, mine) {
  const uid = study.uid, bound = session, live = () => mine === epoch && store.get(uid) === study;
  controller = new AbortController(); const signal = controller.signal;
  await idle(); if (!live() || !store.start(uid)) return;
  broadcast();
  const scopes = await examSeries(study, signal, bound);
  const list = objects(await readJson(await get(`/dicom-web/studies/${uid}/metadata`, { Accept: 'application/dicom+json' }, signal, bound), signal))
    .filter(object=>!scopes.length||scopes.some(series=>series.mode==='all'||(series.mode==='include'?series.uids.includes(object.series):!series.uids.includes(object.series))));
  if (!live()) return;
  if (!list.length) throw new Stop(MESSAGES.empty);
  const { first, rest } = framePaths(uid, list);
  if (!store.start(uid, first.length + rest.length)) return;
  let firstBytes = 0;
  for (const [index, path] of [...first, ...rest].entries()) {
    await idle(); if (!live() || study.status !== 'Downloading') return;
    const kept = store.frame(path);
    if (kept) { if (index < first.length) firstBytes += kept.bytes * list[index].frames; continue; }
    const response = await get(path, { Accept: FRAME_ACCEPT, 'X-KIN-Preload': 'store' }, signal, bound);
    const revision = response.headers.get('X-KIN-Study-Revision');
    const type = response.headers.get('Content-Type') || '';
    if (!/^application\/gzip\b|^multipart\/related\b/i.test(type)) throw new Stop(MESSAGES.malformed);
    let data;
    try { data = await response.arrayBuffer(); } catch (_) { throw new Stop(signal.aborted ? null : MESSAGES.network); }
    const length = response.headers.get('Content-Length');
    if (!data.byteLength || (length !== null && Number(length) !== data.byteLength)) throw new Stop(MESSAGES.network);
    // Reject unusable multipart headers before persisting a copy the viewer cannot read.
    try { partType(await decoded(data)); } catch (_) { throw new Stop(MESSAGES.malformed); }
    if (!live()) return;
    // Before a copy's first frame is kept the key is issued again, so the copy counts from its own receipt and the
    // key outlives it.
    if (study.fetchedAt === null) { await renewKey(mine, bound); if (!live()) return; }
    const result = await locked(async () => {
      if (!live() || !key || study.status !== 'Downloading') return 'gone';
      await sweep(); if (!live() || study.status !== 'Downloading') return 'gone';
      if (!revision || (study.revision !== null && study.revision !== revision)) throw new Stop(MESSAGES.changed);
      const previousFetched = study.fetchedAt;
      const fetched = Date.parse(response.headers.get('Date'));
      store.fetched(uid, Math.min(Number.isFinite(fetched) ? fetched : now(), issuedAt ?? Infinity));
      if (study.expiresAt <= now()) { await sweep(); return 'gone'; }
      const entryId = crypto.randomUUID();
      const sealed = await Disk.seal(key, data, Disk.frameAAD(keyId, uid, path, revision, study.copy));
      if (!live() || !key) return 'gone';
      const frame = { entryId, keyId, expiresAt: study.expiresAt, bytes: sealed.ct.byteLength, ...sealed };
      // Include manifest growth in both caps; labels and frame maps also consume disk.
      const oldRevision = study.revision;
      study.frames.set(path, { entryId, bytes: frame.bytes }); study.bytes += frame.bytes; study.revision = revision;
      const manifest = await envelope(uid);
      study.frames.delete(path); study.bytes -= frame.bytes; study.revision = oldRevision;
      const old = (await inventory()).studies.find(r => r.manifestId === manifest.manifestId);
      const extra = frame.bytes + Math.max(0, recordBytes(manifest) - (old ? recordBytes(old) : 0));
      if (study.bytes + frame.bytes + recordBytes(manifest) > store.budget()) throw new Stop(MESSAGES.size);
      if (!await room(extra, uid)) {
        if (!live()) return 'gone';
        const read = study.frames.size + 1;
        if ((study.bytes + frame.bytes) / read * study.total + recordBytes(manifest) > store.budget()) throw new Stop(MESSAGES.size);
        store.unfetched(uid, previousFetched);
        study.status = 'Queued'; study.waiting = true; study.reason = MESSAGES.space;
        await persist(uid); return 'full';
      }
      if (!live() || !key || study.status !== 'Downloading') return 'gone';
      try { await disk.write({ frames: [frame], studies: [manifest] }); }
      catch (error) {
        if (error.name !== 'QuotaExceededError') throw error;
        store.unfetched(uid, previousFetched);
        study.status = 'Queued'; study.waiting = true; study.reason = MESSAGES.space; return 'full';
      }
      if (!live()) return 'gone';
      const outcome = store.put(uid, path, { entryId, bytes: frame.bytes }, revision);
      if (outcome !== 'stored') await disk.write({}, { frames: [entryId] });
      await flushReleased();
      await inventory(); return outcome;
    });
    if (result === 'full' || result === 'gone') return result;
    if (index < first.length) {
      firstBytes += (data.byteLength + 16) * list[index].frames;
      if (index === first.length - 1 && !store.estimate(uid, firstBytes)) throw new Stop(MESSAGES.size);
    }
    broadcast();
  }
  // The exams are asked again once every frame is in: read in full and the same as at the start, or the copy is no Ready.
  if (JSON.stringify(await examSeries(study, signal, bound)) !== JSON.stringify(scopes)) throw new Stop(MESSAGES.changed);
  await locked(async () => { if (live()) { store.ready(uid); await persist(uid); } });
}
async function pump() {
  if (running) return;
  running = true;
  try {
    while (session && key && store.budget() !== null) {
      const study = store.next(); if (!study) return;
      const mine = epoch;
      try { if (await download(study, mine) === 'full') return; }
      catch (error) {
        if (mine !== epoch) continue;
        if (error.reason === 'ended') { changeSession(null); return; }
        // Only the entry this download was for: a Preload for another exam of the same original replaces the entry, and
        // the old download's late failure must not mark the new one Failed.
        await locked(async () => { if (mine === epoch && store.get(study.uid) === study && study.status === 'Downloading') await erase(study.uid, error.reason || MESSAGES.unavailable, true); });
      } finally { if (mine === epoch) controller = null; broadcast(); }
    }
  } finally { running = false; }
}
async function decoded(data) {
  const bytes = new Uint8Array(data);
  if (bytes[0] !== 0x1f || bytes[1] !== 0x8b) return data;
  return new Response(new Blob([data]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
}
// The unchanged WADO body authenticates both the delimiter and the part's codec/syntax, including after restart.
function partType(bytes) {
  const data = new Uint8Array(bytes);
  let end = 0;
  while (end + 3 < data.length && !(data[end] === 13 && data[end + 1] === 10 && data[end + 2] === 13 && data[end + 3] === 10)) end++;
  if (end + 3 >= data.length) throw new Error('multipart headers');
  const first = new TextDecoder().decode(data.subarray(0, end));
  const boundary = /^(?:\r\n)?--([^\r\n]+)\r\n/.exec(first)?.[1];
  if (!boundary || !/^[0-9A-Za-z'()+_,./:=? -]+$/.test(boundary) || boundary.endsWith(' ')) throw new Error('multipart boundary');
  const types = [...first.replace(/\r\n[ \t]+/g, ' ').matchAll(/^content-type:[ \t]*([^\r\n]+)$/gim)];
  const type = types[0]?.[1].trim();
  if (types.length !== 1 || !/^[\w!#$&^.+-]+\/[\w!#$&^.+-]+(?:[ \t]*;[^\r\n]*)?$/.test(type || '') || /[\x00-\x08\x0a-\x1f\x7f]/.test(type)) throw new Error('multipart content type');
  const quotedType = type.replace(/["\\]/g, '\\$&');
  const delimiter = /^[\w'+.-]+$/.test(boundary) ? boundary : `"${boundary}"`;
  return `multipart/related; type="${quotedType}"; boundary=${delimiter}`;
}
/**
 * A viewer leaves the copies it showed (its window goes, or it shows another patient). The last viewer of a copy to
 * leave it is a use: the copy is kept 72 hours from then. A copy another viewer still shows stays in use.
 */
function leave(info, entries) {
  const at = now();
  for (const name of entries) {
    const opened = info.opens.get(name); if (!opened) continue;
    info.opens.delete(name);
    if (store.close(opened.uid, opened.copy)) { void touch(opened.uid, opened.copy, at); store.wake(); }
  }
}
/**
 * A message a viewer sends about a copy: of this session, naming the copy its check confirmed (the copy's random token;
 * a number in a record kept from before copies had tokens).
 */
const fromViewer = message => !!session && message.session === session
  && (typeof message.copy === 'string' && !!message.copy || Number.isInteger(message.copy));
function release(port) {
  const info = ports.get(port); if (!info) return;
  leave(info, [...info.opens.keys()]);
  info.busy = false; settleIdle(); store.wake(); void pump();
}
const opening = (uid, copy) => uid + '|' + copy;
async function handle(port, message, mine) {
  let info = ports.get(port);
  if (!info) { info = { role: null, busy: false, opens: new Map() }; ports.set(port, info); }
  const reply = value => port.postMessage({ type: 'reply', id: message.id, ...value }, value.bytes ? [value.bytes] : []);
  if (message.type === 'hello') {
    info.role = message.role === 'viewer' ? 'viewer' : 'list'; broadcast();
    // A panel opened after the PC slept: the rows follow once the server has said the time.
    if (adrift()) void resync().then(() => locked(async () => { await sweep(); broadcast(); })).catch(() => {});
    return;
  }
  if (message.type === 'busy') { info.busy = message.busy === true; settleIdle(); return; }
  if (message.type === 'bye') { release(port); ports.delete(port); broadcast(); return; }
  if (message.type === 'session' || message.type === 'add') {
    if (!session || mine !== epoch) return;
    const reason = await prerequisites(); if (mine !== epoch) return;
    await resync(); if (mine !== epoch) return;
    await locked(async () => {
      if (mine !== epoch) return;
      // The model first catches up with the clock: a row the panel shows gone (past its date) is gone for this add too.
      await sweep(); if (mine !== epoch) return;
      // FC-073: an Auto Preload add while preload cannot run queues nothing (no Failed rows each refresh); its next
      // list read asks again, which retries the setup above. It runs after the restore, so its dedup sees the stored queue.
      const auto = message.auto === true;
      if (message.type === 'add' && !(auto && reason)) {
        const list = (Array.isArray(message.studies) ? message.studies : []).filter(s => /^[0-9.]{1,64}$/.test(s?.uid));
        const added = store.add(list.map(s => ({ uid: s.uid, label: typeof s.label === 'string' ? s.label.slice(0, 200) : null,
          urgent: s.urgent === true, ...(Array.isArray(s.examRefs)&&s.examRefs.length?{examRefs:s.examRefs}:{}) })), { auto });
        await flushReleased();
        for (const uid of added) {
          if (reason) store.fail(uid, reason);
          else if (!await persist(uid)) { store.get(uid).waiting = true; store.get(uid).reason = MESSAGES.space; }
        }
      }
      broadcast();
    });
    void pump(); return;
  }
  if (message.type === 'query' || message.type === 'frame') {
    if (settings) await settings;
    await resync();
    await locked(async () => {
      // Nothing is served while the server's time is in doubt (`adrift`: it could not be asked just now).
      if (mine !== epoch || !session || message.session !== session || !key || unavailable || adrift()) { reply(message.type === 'query' ? { held: null } : { bytes: null }); return; }
      try {
        await sweep();
        const uid = message.type === 'query' ? message.uid : Model.studyOfPath(message.path), held = store.held(uid);
        // `has`: the frame the viewer's check reads is one of this copy's (then the check itself is a use of the copy).
        if (message.type === 'query') { reply({ held: held ? { revision: held.revision, copy: held.copy,
          has: typeof message.path === 'string' && Model.studyOfPath(message.path) === uid && !!store.frame(message.path) } : null }); return; }
        if (held && held.copy !== message.copy) { reply({ bytes: null, stale: true }); return; }
        const frame = held && store.frame(message.path); if (!frame) { reply({ bytes: null }); return; }
        const record = await disk.get(frame.entryId);
        if (!record) { await disk.list(true); await erase(uid, MESSAGES.missing); reply({ bytes: null }); broadcast(); return; }
        try {
          const bytes = await decoded(await Disk.open(key, record, Disk.frameAAD(keyId, uid, message.path, held.revision, held.copy)));
          if (mine !== epoch || !key || !store.held(uid)) { reply({ bytes: null }); return; }
          reply({ bytes, partType: partType(bytes) });
        } catch (_) { if (mine === epoch) await erase(uid, MESSAGES.corrupt); reply({ bytes: null }); broadcast(); }
      } catch (_) { reply(message.type === 'query' ? { held: null } : { bytes: null }); }
    }); return;
  }
  if (message.type === 'retry' && session && (!key || unavailable)) await prerequisites();
  await resync();
  const used = [];
  await locked(async () => {
    if (mine !== epoch) return;
    // The model first catches up with the clock, so no message acts on a copy past its date as if it were held: Retry
    // of a row the panel shows gone queues it again, an open or a using of it counts nothing. (A store that cannot be
    // swept now fails what needs it below, as before; it does not turn a viewer's message into a failure of its own.)
    try { await sweep(); } catch (_) {}
    if (mine !== epoch) return;
    switch (message.type) {
      case 'retry':
        if (!key || unavailable) { store.fail(message.uid, unavailable || MESSAGES.key); break; }
        if (store.retry(message.uid)) await persist(message.uid);
        break;
      case 'clear':
        controller?.abort();
        for (const s of store.entries()) {
          // A Failed or Evicted row holds no frames: it keeps its status and reason, and only its stored record goes.
          // (erase(..., true) would write a Failed record back.)
          if (s.status === Model.STATUS.failed || s.status === Model.STATUS.evicted) {
            const id = manifests.get(s.uid); manifests.delete(s.uid);
            if (id) { await disk.write({}, { studies: [id] }); await inventory(); }
          } else await erase(s.uid, s.frames.size ? MESSAGES.cleared : MESSAGES.dequeued);
        }
        break;
      case 'remove': await erase(message.uid, MESSAGES.cleared); store.remove(message.uid); break;
      case 'evict':
        // A viewer drops only the copy it checked: an evict naming an earlier copy leaves a later one alone.
        if (!fromViewer(message) || store.get(message.uid)?.copy !== message.copy) break;
        await erase(message.uid, typeof message.reason === 'string' ? message.reason.slice(0, 200) : MESSAGES.changed); break;
      // Open, close and using come from a viewer of this session, about the copy its live check confirmed. One viewer
      // window counts once per copy; its close or its leaving ends its use.
      case 'open': {
        const name = opening(message.uid, message.copy);
        if (fromViewer(message) && !info.opens.has(name)
          && store.open(message.uid, message.copy)) {
          // Its window may have left while this message waited its turn (a `bye` waits for nothing): then the window
          // used the copy and left it - it is not left open with no window to close it.
          if (ports.get(port) === info) info.opens.set(name, { uid: message.uid, copy: message.copy });
          else if (store.close(message.uid, message.copy)) store.wake();
          used.push([message.uid, message.copy, now()]);
        }
        break;
      }
      case 'close':
        if (fromViewer(message)) leave(info, [opening(message.uid, message.copy)]);
        break;
      case 'using': {
        // A viewer still shows the copy: within an hour of its expiry, the use moves it on (never a copy already gone).
        const study = store.get(message.uid);
        if (fromViewer(message) && info.opens.has(opening(message.uid, message.copy)) && study
          && study.copy === message.copy && study.expiresAt > now() && study.expiresAt - now() <= RENEW_BEFORE) used.push([message.uid, message.copy, now()]);
        break;
      }
    }
    if (['remove', 'clear', 'evict'].includes(message.type)) store.wake();
    broadcast();
  });
  for (const [uid, copy, at] of used) void touch(uid, copy, at);
  void pump();
}
setInterval(() => { void resync().then(() => locked(async () => { await sweep(); broadcast(); })).then(() => pump()).catch(() => {}); }, 10 * 60 * 1000);
self.onconnect = event => {
  const port = event.ports[0]; ports.set(port, { role: null, busy: false, opens: new Map() });
  port.onmessage = e => {
    const message = e.data;
    if (message?.type === 'session' || message?.type === 'add') {
      const next = typeof message.session === 'string' && message.session ? message.session : null;
      if (next !== session) changeSession(next);
    }
    void handle(port, message, epoch).catch(() => { unavailable = MESSAGES.unavailable; broadcast(); });
  };
  port.start();
};
