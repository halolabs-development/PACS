/* D1880 memory-only preload, viewer side (design fable-design-preload-memory-20261027 §4.1 item 3, §4.5, §4.6), and the
 * viewer's openings of a study (opening contract consult-preload-opening-contract-20261029).
 *
 * The viewer's session transport sends every protected request through one fetch (viewer-session.js); this wraps that
 * fetch, under the transport, so a request reaches it only after the transport admitted it for the live session and
 * bound it (`X-KIN-Session`).
 *
 * Openings. Every image read this viewer sends - by the public image routes or the API's own (`/api/dicom-web/`,
 * `/api/image-relay/`, `/api/instances/`), which read the same images - names the opening it belongs to
 * (`X-KIN-View-Opening`), and the server records the first read of each opening of a study as that opening's 열람
 * (user-view), durable before its first byte (image-delivery-record.ts). Business calls name none. An opening is an entry
 * into a study, known only to this document's memory:
 *   · this document - a new window or tab, a reload, a typed URL - is a new opening of every study it shows;
 *   · a patient tab showing studies again (`reenter`, viewer-patient-tabs.js) and a return to this page from the
 *     browser's back/forward cache are new openings of the studies they show. Pixels this document still holds from an
 *     earlier visit - the image cache, a document or preview it keeps, the page the browser kept - could show without
 *     any read, so each such study is read live for the new opening first, and only then is the scope shown. What a
 *     study showed here is any image read of it that succeeded - a frame (also with a query), a rendering, a document, a
 *     preview, from the worker's memory or the network; whether the worker could answer it decides nothing. A read of a
 *     stored object (`/instances/{id}/...`) names no study: its answer does (`X-KIN-Study-UID`), and an answer that
 *     does not leaves the read standing for the studies shown when it was made. A read still unanswered when its study
 *     is opened again belongs to the earlier opening: its answer is not handed on but read again under the new one;
 *   · focus, scrolling, cine, a layout change, a repeated or retried read, the server closing an idle delivery and a
 *     preload are none: they keep the opening, and a preload has none at all. A read of a study shown before the scope
 *     changed keeps that study's opening.
 *
 * Preload memory. A WADO-RS frame read of a study the preload worker holds is answered from the worker's memory - but
 * never before the study passed one live read for its current opening:
 *   · the first frame read of a held study goes to the network as it is, marked `X-KIN-Preload: check`. It passes the
 *     same gate as every frame read (institution, StudyAccess, split UID), records the opening, and the server answers
 *     the archive's current revision of the study. Only when that equals the revision the held copy was read under do
 *     later frames come from memory - from that copy only: the worker refuses a frame of another copy (one fetched again
 *     after Clear All or Retry), and the viewer checks again before it takes any of the new one. Otherwise the held
 *     study is dropped (Evicted) and the viewer stays on the network. A new opening of the study checks again.
 *   · the worker answers only for the session that filled it; any other session reads from the network.
 *   · anything else - metadata, a frame of a study not held, a frame the worker has not fetched yet, a request with a
 *     query - goes to the network unchanged.
 *
 * While this viewer reads images or metadata from the network - until the answer's body has ended, not only its
 * headers - it tells the worker, which starts no new preload fetch meanwhile (reading comes first, Minhoon P0 item 1).
 */
// The viewer write path (viewer-language.js): product words in the reader's screen language, or as written.
function kinText(t, ...p) { const l = typeof window === 'object' && window && window.KinLanguage; return l && l.text ? l.text(t, ...p) : t.replace(/\{[ten]?(\d+)\}/g, (m, i) => String(p[i])); }
function kinHtml(t, ...p) { const l = typeof window === 'object' && window && window.KinLanguage; return l && l.html ? l.html(t, ...p) : t.replace(/\{[ten]?(\d+)\}/g, (m, i) => String(p[i])); }
(function (root) {
  'use strict';
  const WORKER_URL = '/worklist/hpacs-lite/preload-worker.js', WORKER_NAME = 'kin-preload';
  // An image route by its public path: the API serves the same reads under its own prefixes.
  const ROUTE = /^(?:\/api(?:\/image-relay)?)?(\/(?:dicom-web|instances)\/.*)$/;
  const UID = '[0-9.]{1,64}';
  const FRAME = new RegExp(`^/dicom-web/studies/(${UID})/series/${UID}/instances/${UID}/frames/[0-9]+$`);
  const STUDY = new RegExp(`^/dicom-web/studies/(${UID})(?:/|$)`), STUDY_UID = new RegExp(`^${UID}$`);
  const OBJECT = /^\/instances\/([0-9a-f-]{1,64})\//;
  // QIDO, DICOMweb metadata, Orthanc's tags and attachment info describe the images without them: no pixels, no 열람
  // (image-relay.controller.ts `imageRead`), so never the read a new opening reads again.
  const DESCRIPTION = new RegExp(`^/dicom-web/(?:studies|series|instances|studies/${UID}/(?:series|instances|series/${UID}/instances)` +
    `|studies/${UID}(?:/series/${UID}(?:/instances/${UID})?)?/metadata)$|^/instances/[0-9a-f-]+/(?:tags|simplified-tags|header|attachments/dicom/info)$`);
  const OPENING = 'X-KIN-View-Opening', NAMED_STUDY = 'X-KIN-Study-UID';
  const CHANGED = kinText("열 때 확인한 검사 정보가 미리 받을 때와 달라 미리 받은 영상을 버렸습니다.");
  const DENIED = kinText("열 때 검사 접근이 거절되어 미리 받은 영상을 버렸습니다.");
  const UNRECORDED = kinText("영상 열람 기록을 저장하지 못해 영상을 다시 표시하지 않았습니다. 연결을 확인한 뒤 다시 시도하세요.");
  // A status whose answer has no body (fetch spec "null body status"): nothing to wait for after its headers.
  const NULL_BODY = [101, 103, 204, 205, 304];
  // How often a document says it still shows the copies it uses (the worker moves one on within an hour of its expiry).
  const USING_EVERY = 10 * 60 * 1000;
  /** session-transport.js's reading of a refusal: loaded before this file in the viewer (config/ohif.js), required in Node. */
  const refusal = reply => (root?.KinSessionTransport ?? (typeof module === 'object' && module.exports ? require('./session-transport.js') : null)).refusal(reply);

  function attach(win, send) {
    /** The same-origin URL of a request, else null. */
    function target(url) {
      try {
        const parsed = new URL(typeof url === 'string' || url instanceof URL ? url : url.url, win.location.href);
        return parsed.origin === win.location.origin ? parsed : null;
      } catch (_) { return null; }
    }
    /** The image route a request reads, by its public path; null for anything else (business calls). */
    const route = url => url ? ROUTE.exec(url.pathname)?.[1] ?? null : null;
    const isGet = init => String(init.method || 'GET').toUpperCase() === 'GET';
    /** The study of a WADO-RS frame GET without a query - the reads the worker can answer - else null. */
    const frameStudy = (url, path, init) => !url.search && isGet(init) ? FRAME.exec(path)?.[1] ?? null : null;
    // The study each stored object belongs to, as the server named it in an image answer of that object.
    const objects = new Map();
    /** The study a read names: in its path, or for a stored object's read the study an earlier answer named for it. */
    const studyOf = path => STUDY.exec(path)?.[1] ?? objects.get(OBJECT.exec(path)?.[1]) ?? null;

    // The opening of the scope shown now, and each study's opening once this document read it: a study keeps its
    // opening when the scope moves on, so its late reads never open it again under the next scope's opening.
    let scopeOpening = win.crypto.randomUUID();
    const openings = new Map(), checks = new Map();
    function openingOf(uid) {
      if (!uid) return scopeOpening;
      if (!openings.has(uid)) openings.set(uid, scopeOpening);
      return openings.get(uid);
    }
    function viewed(init, uid, extra = {}) {
      const headers = new win.Headers(init.headers);
      if (!headers.has(OPENING)) headers.set(OPENING, openingOf(uid));
      for (const [name, value] of Object.entries(extra)) headers.set(name, value);
      return { ...init, headers };
    }
    // The entry sequence: how many new openings this document took (`commit`), and the one that last opened each study.
    let entries = 0;
    const entered = new Map();
    /**
     * What a read is asked under: the opening it names now, the entry sequence, the studies shown. Null for a new
     * opening's own read (`reenter`), which names its opening itself.
     */
    const asking = (path, init) => new win.Headers(init.headers).has(OPENING) ? null
      : { opening: openingOf(studyOf(path)), asked: entries, studies: scope() };

    // What this document showed of each study: its last frame read (the kind the check reads), else its last other image
    // read. A failed read showed nothing. An object read no answer placed stands for the studies shown when it was made.
    const shown = new Map(), unplaced = new Map();
    function answered(response, path, url, init, ask) {
      if (!response?.ok || !isGet(init) || DESCRIPTION.test(path)) return response;
      const object = OBJECT.exec(path)?.[1], named = response.headers.get(NAMED_STUDY);
      if (object && named && STUDY_UID.test(named)) objects.set(object, named);
      const uid = studyOf(path);
      // Asked before its study was opened again, the read belongs to the earlier opening; its pixels must not show under
      // the new one before that opening's own read is recorded. Its answer is dropped and the read sent again, naming the
      // study's opening now - that answer is the one handed on (a memory answer gets the new opening's check first).
      if (ask && (uid ? [uid] : ask.studies).some(study => (entered.get(study) ?? 0) > ask.asked)) {
        response.body?.cancel().catch(() => {});
        return preloadFetch(url, init);
      }
      const read = { url: String(typeof url === 'string' || url instanceof URL ? url : url.url),
        accept: new win.Headers(init.headers).get('Accept'), frame: FRAME.test(path) };
      if (!uid) { if (ask) unplaced.set(read.url, { ...read, studies: ask.studies }); return response; }
      unplaced.delete(read.url);
      // A study first placed by this answer keeps the opening its read was sent under, as a study named in its path does.
      if (ask && !openings.has(uid)) openings.set(uid, ask.opening);
      if (read.frame || !shown.get(uid)?.frame) shown.set(uid, read);
      return response;
    }

    /**
     * A new opening of `uids`. Each of them this document has shown before is read live for it first - its 열람 is then
     * recorded before the pixels this document still holds can show again; a study never shown here has no such pixels,
     * and its own first read records it. One whose earlier read is answered while these are read has pixels then, and is
     * read too; one answered later is read again by `answered`. The opening is taken by `commit()` when the scope is
     * shown; an entry abandoned before that leaves every opening as it was. Null when an opening could not be recorded:
     * the scope is not shown.
     */
    async function reenter(uids, signal, returning = false) {
      const next = win.crypto.randomUUID(), wanted = [...new Set(uids)], done = new Set();
      // A return from the back/forward cache: its read of a study whose copy the page used is that copy's check as well.
      if (returning) uses.returning(next);
      // The reads still owed: one per study shown (keyed by the study), and each object read standing for one (by URL).
      const owed = () => [...wanted.filter(uid => shown.has(uid)).map(uid => [uid, shown.get(uid)]),
        ...[...unplaced].filter(([, read]) => read.studies.some(uid => wanted.includes(uid)))].filter(([key]) => !done.has(key));
      for (let reads = owed(); reads.length; reads = owed()) for (const [key, read] of reads) {
        done.add(key);
        try {
          const headers = { [OPENING]: next, ...(read.accept ? { Accept: read.accept } : {}) };
          const response = await win.fetch(read.url, { headers, signal });
          await response.arrayBuffer();
          if (!response.ok) return null;
        } catch (_) { return null; }
        // An object read its answer now places was read for its study.
        const placed = studyOf(route(target(read.url)) ?? '');
        if (placed) done.add(placed);
      }
      return { commit() {
        // The next frame read of a held study checks the copy again, for this opening.
        entries++;
        for (const uid of wanted) { openings.set(uid, next); entered.set(uid, entries); checks.delete(uid); }
        scopeOpening = next;
        // The earlier view ends - its copies are left (the worker counts a last viewer's leaving as a use) and whatever
        // was asked under it changes nothing; this opening's own checks confirm the copies it uses (a return's reads
        // were those checks). What the page shows from here on was read for this opening: a kept page waits no longer.
        end({ opening: next });
        reveal();
      } };
    }

    /**
     * The view: what this document shows now, under the opening it was read for. It ends when another opening is shown
     * (`commit`), when the last patient tab closes (`leave`) and when the page is left. Whatever was asked under a view
     * that has ended - a copy's check, a frame from memory, a return's reads - is compared with the view at the moment
     * its answer would be applied, and applies nothing once the view has moved on: no use, no drop, no held bytes, no
     * change of the screen. Session end signals are not of the view: the transport tells them to the session they are of.
     */
    let view = 0;
    function end(how) { view++; uses.end(how); }

    // A return from the back/forward cache is a new opening of the studies the page shows: what the browser kept stays
    // hidden from the moment the page is left until the return's opening is recorded. A plain visibility change is not
    // a return and keeps the opening.
    let notice = null, away = false;
    const page = () => win.document?.documentElement ?? null;
    /** The kept page shows again (never while it is away in the back/forward cache). */
    function reveal() {
      if (away) return;
      notice?.remove(); notice = null;
      if (page() && page().style.visibility === 'hidden') page().style.visibility = '';
    }
    function scope() {
      try { return (new URL(win.location.href).searchParams.get('StudyInstanceUIDs') || '').split(',').filter(Boolean); }
      catch (_) { return []; }
    }
    async function returned() {
      notice?.remove(); notice = null;
      const mine = view;
      // The kept page shows the studies of its address and any other it read under the scope it shows (a comparison).
      const here = [...openings].filter(([, opening]) => opening === scopeOpening).map(([uid]) => uid);
      const entry = await reenter([...scope(), ...here], undefined, true);
      // Another opening was shown, the last tab closed or the page was left again while these reads were out: that owns
      // the screen now, and this late answer shows, uses and reports nothing.
      if (mine !== view) return;
      if (entry) { entry.commit(); return; }
      const doc = win.document;
      notice = doc.createElement('section'); notice.setAttribute('role', 'alert');
      notice.style.cssText = 'visibility:visible;position:fixed;inset:30% 20% auto;z-index:10000;background:#18212b;color:white;padding:24px';
      const text = doc.createElement('p'); text.textContent = UNRECORDED;
      const retry = doc.createElement('button'); retry.type = 'button'; retry.textContent = 'Retry';
      retry.onclick = () => { void returned(); };
      notice.append(text, retry); doc.body.append(notice);
    }
    // A window leaving releases its studies and its busy mark. A page kept by the back/forward cache stays hidden, and
    // its return is a new opening: its studies are read live again before the page shows or any copy is used.
    win.addEventListener('pagehide', event => {
      if (event?.persisted) { away = true; if (page()) page().style.visibility = 'hidden'; }
      end({ page: true });
    });
    win.addEventListener('pageshow', event => {
      if (!event?.persisted) return;
      away = false; uses.back();
      void returned();
    });

    // The copies this document shows from the worker's memory - set by the worker part below.
    const uses = { end() {}, returning() {}, back() {} };
    let read;
    if (typeof win.SharedWorker !== 'function') {
      read = (url, init) => {
        const path = route(target(url));
        if (!path) return send(url, init);
        const ask = asking(path, init);
        return send(url, viewed(init, studyOf(path))).then(response => answered(response, path, url, init, ask));
      };
    } else read = withWorker(win, send, { target, route, frameStudy, studyOf, viewed, answered, asking, checks, uses });

    function preloadFetch(url, init = {}) { return read(url, init); }
    preloadFetch.reenter = (uids, signal) => reenter(uids, signal);
    // The document shows no study any more (its last patient tab closed): the view ends and every copy it showed is left.
    preloadFetch.leave = () => { end(); reveal(); };
    return preloadFetch;
  }

  /** The preload worker's memory under the viewer's reads (see the head of this file). */
  function withWorker(win, send, { target, route, frameStudy, studyOf, viewed, answered, asking, checks, uses }) {
    let port = null, broken = false, nextId = 0, inflight = 0;
    const pending = new Map();
    /**
     * The copies this document uses - a held frame its current opening's check confirmed (the check read itself when
     * that frame is held, else its first frame from memory). The worker keeps a used copy 72 hours from its last
     * viewer's leaving; while shown, the document says so (`using`) so a copy shown for days is not removed under it.
     * Each is tied to the session and copy it was confirmed for (the copy's token: a later copy of the study is another).
     * `checks` holds a study's check only while the view it was made under lasts: one that is no longer there opens and
     * drops nothing and hands on no held bytes.
     */
    const opened = new Map();
    function use(uid, entry) {
      if (checks.get(uid) !== entry || opened.get(uid)?.copy === entry.copy) return;
      opened.set(uid, { copy: entry.copy, session: entry.session });
      post({ type: 'open', uid, copy: entry.copy, session: entry.session });
    }
    // What the page used when it was left (uid -> copy and session), and the return under way: the opening its reads
    // name and the copies those reads confirmed.
    let left = new Map(), returns = null;
    // The opening the document shows studies under (the document's own at first): none after its last patient tab
    // closed or while it is left, until an opening is shown again. A frame read made meanwhile is a straggler of the
    // view that ended: read live, never a use.
    let viewOf = 'document';
    /**
     * The one end of a view - a new opening shown, the last patient tab closed, the page left: every check still under
     * way is of the ended view, and every copy used is left. Leaving the page says `bye` instead of each close and
     * remembers what it used; the opening of its return, when shown, uses again the copies its own reads confirmed.
     */
    uses.end = ({ page = false, opening = null } = {}) => {
      const again = returns && returns.opening === opening ? returns.confirmed : null;
      checks.clear(); returns = null; viewOf = opening;
      if (page) { if (opened.size) left = new Map(opened); if (port) post({ type: 'bye' }); }
      else { left = new Map(); for (const [uid, { copy, session }] of opened) post({ type: 'close', uid, copy, session }); }
      opened.clear();
      for (const [uid, entry] of again || []) { checks.set(uid, entry); use(uid, entry); }
    };
    uses.returning = opening => { returns = { opening, confirmed: new Map() }; };
    // The page is back from the back/forward cache: the worker hears this window again.
    uses.back = () => {
      if (!port) return;
      post({ type: 'hello', role: 'viewer' });
      if (inflight > 0) post({ type: 'busy', busy: true });
    };
    /**
     * A return's read of a study whose copy the page used when it was left. The one read - sent by the page's own
     * fetch, so bound to its session and heard by the session's end like any other - records the return's opening and,
     * marked as a check, answers the archive's revision. The copy is used again only if it is still the very copy the
     * page left (same session, same token), the revision is the copy's and the body came in full - and only once the
     * return's opening is shown (`end`). Another copy of the study is neither used nor dropped here: the next frame read
     * checks it for itself. The worker is asked beside the read, never before it: the return's read, and so the kept
     * page's showing again, does not wait for the worker. Its answer and the read's end come in either order; when both
     * are in the copy is used again - with the return's opening when that is still to be shown, at once when it is
     * shown already and still is the view (and the study has no check of its own since). Under any other view the late
     * answer uses nothing.
     */
    async function rechecked(uid, path, url, init) {
      const mine = returns, was = left.get(uid), session = new win.Headers(init.headers).get('X-KIN-Session');
      if (session !== was.session) return network(url, init);
      let held, revision;
      const settle = () => {
        if (held === undefined || revision === undefined || !held?.revision || held.revision !== revision || held.copy !== was.copy) return;
        const entry = { state: 'held', done: null, copy: held.copy, session };
        if (returns === mine) mine.confirmed.set(uid, entry);
        else if (viewOf === mine.opening && !checks.has(uid)) { checks.set(uid, entry); use(uid, entry); }
      };
      void ask({ type: 'query', uid, session, path }).then(answer => { held = answer.held || null; settle(); });
      const response = await network(url, viewed(init, uid, { 'X-KIN-Preload': 'check' }));
      const answered = response.headers.get('X-KIN-Study-Revision');
      if (!response.ok || !answered) return response;
      const body = await response.arrayBuffer();
      revision = answered; settle();
      return new win.Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
    }
    if (typeof win.setInterval === 'function') win.setInterval(() => {
      for (const [uid, { copy, session }] of opened) post({ type: 'using', uid, copy, session });
    }, USING_EVERY);

    function connect() {
      if (port || broken) return port;
      try {
        const worker = new win.SharedWorker(WORKER_URL, { name: WORKER_NAME });
        port = worker.port;
        port.onmessage = event => {
          const message = event.data;
          if (message?.type !== 'reply' || !pending.has(message.id)) return;
          const resolve = pending.get(message.id); pending.delete(message.id); resolve(message);
        };
        worker.onerror = () => {
          broken = true; port = null;
          for (const resolve of pending.values()) resolve({});
          pending.clear();
        };
        port.start();
        port.postMessage({ type: 'hello', role: 'viewer' });
      } catch (_) { broken = true; port = null; }
      return port;
    }
    const post = message => { try { connect()?.postMessage(message); } catch (_) {} };
    function ask(message) {
      const target = connect();
      if (!target) return Promise.resolve({});
      return new Promise(resolve => { const id = ++nextId; pending.set(id, resolve); target.postMessage({ ...message, id }); });
    }

    function done() { if (--inflight === 0) post({ type: 'busy', busy: false }); }
    /**
     * A network read, busy from the request until its body has ended, failed or been cancelled. The body is passed on
     * as it arrives (not buffered). A failure answer is released at its headers: the viewer may never read its body.
     */
    async function network(url, init) {
      if (inflight++ === 0) post({ type: 'busy', busy: true });
      let response;
      try { response = await send(url, init); }
      catch (error) { done(); throw error; }
      if (!response.ok || !response.body || NULL_BODY.includes(response.status)) { done(); return response; }
      const reader = response.body.getReader();
      let open = true;
      const end = () => { if (open) { open = false; done(); } };
      const body = new win.ReadableStream({
        async pull(controller) {
          try {
            const chunk = await reader.read();
            if (chunk.done) { end(); controller.close(); } else controller.enqueue(chunk.value);
          } catch (error) { end(); controller.error(error); }
        },
        cancel(reason) { end(); return reader.cancel(reason); },
      });
      return new win.Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
    }

    /** The study's check for its current opening: null when nothing is held, else the live check read's own response. */
    function check(uid, path, session, url, init) {
      const entry = { state: 'checking', done: null, copy: null, session };
      checks.set(uid, entry);
      // A check whose view ended meanwhile (a new opening, the last tab closed, the page left) opens and drops nothing.
      const current = () => checks.get(uid) === entry;
      entry.done = (async () => {
        const { held } = await ask({ type: 'query', uid, session, path });
        if (!held?.revision) { entry.state = 'live'; return null; }
        let response;
        try { response = await network(url, viewed(init, uid, { 'X-KIN-Preload': 'check' })); }
        catch (error) { if (checks.get(uid) === entry) checks.delete(uid); throw error; }   // cut or failed: the next frame read checks again
        const now = response.headers.get('X-KIN-Study-Revision');
        if (response.ok && now === held.revision) {
          // Confirmed only once the check read's body has come in full: a body cut after its headers confirms nothing.
          let body;
          try { body = await response.arrayBuffer(); }
          catch (error) { if (checks.get(uid) === entry) checks.delete(uid); throw error; }
          response = new win.Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
          entry.state = 'held'; entry.copy = held.copy;
          if (held.has && current()) use(uid, entry);
        } else if (!current()) entry.state = 'live';
        else {
          // No revision answered (the archive could not say) proves nothing either way: live now, the held copy stays.
          // A drop names the copy checked: a later copy is not this one.
          entry.state = 'live';
          if (response.ok && now) post({ type: 'evict', uid, copy: held.copy, session, reason: CHANGED });
          // Refused only by the one shared reading of a refusal (session-transport.js): a 403 with an AUTH_* code - an
          // archive the gate could not observe, a busy session check - is temporary and keeps the held copy.
          else if (response.status === 404 || response.status === 403 && refusal(response) === 'denied') post({ type: 'evict', uid, copy: held.copy, session, reason: DENIED });
        }
        return response;
      })();
      return entry.done;
    }

    async function frame(uid, path, url, init) {
      if (!viewOf) return network(url, viewed(init, uid));
      const session = new win.Headers(init.headers).get('X-KIN-Session');
      const entry = checks.get(uid);
      if (!entry) {
        const response = await check(uid, path, session, url, init);
        return response || network(url, viewed(init, uid));
      }
      // The copy's bytes are handed on only while this check is still the study's - the view it was made under still
      // shown. A read that waited (for the check, for the worker's answer) across the end of that view starts over under
      // whatever is shown now: that view's own check first, or a live read when nothing is.
      const current = () => checks.get(uid) === entry;
      if (entry.state === 'checking') { try { await entry.done; } catch (_) {} if (!current()) return frame(uid, path, url, init); }
      if (entry.state === 'held' && !init.signal?.aborted) {
        const { bytes, partType, stale } = await ask({ type: 'frame', path, session, copy: entry.copy });
        if (!current()) return frame(uid, path, url, init);
        if (bytes) { use(uid, entry); return new win.Response(bytes, { status: 200, headers: { 'Content-Type': partType } }); }
        // The worker now holds another copy of the study than the one checked: none of it before a check of its own.
        if (stale) checks.delete(uid);
      }
      return network(url, viewed(init, uid));
    }

    function read(parsed, path, url, init) {
      // A new opening's own live read (`reenter`) names its opening already: never from memory. A return's read of a
      // study whose copy the page used is that copy's check too (`rechecked`).
      const opening = new win.Headers(init.headers).get(OPENING);
      if (opening) {
        if (broken) return send(url, init);
        const kept = returns?.opening === opening ? frameStudy(parsed, path, init) : null;
        return kept && left.has(kept) ? rechecked(kept, path, url, init) : network(url, init);
      }
      const uid = frameStudy(parsed, path, init);
      if (uid && !broken) return frame(uid, path, url, init);
      return broken ? send(url, viewed(init, studyOf(path))) : network(url, viewed(init, studyOf(path)));
    }
    return function (url, init) {
      const parsed = target(url), path = route(parsed);
      if (!path) return send(url, init);
      const ask = asking(path, init);
      return read(parsed, path, url, init).then(response => answered(response, path, url, init, ask));
    };
  }

  const api = Object.freeze({ attach });
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.KinViewerPreload = api;
})(typeof window === 'object' ? window : null);
