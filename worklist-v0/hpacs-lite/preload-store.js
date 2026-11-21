/* D1890: pure queue and ciphertext-reference model. The worker owns encryption, disk I/O and server time. */
// The viewer write path (viewer-language.js): product words in the reader's screen language, or as written.
function kinText(t, ...p) { const l = typeof window === 'object' && window && window.KinLanguage; return l && l.text ? l.text(t, ...p) : t.replace(/\{[ten]?(\d+)\}/g, (m, i) => String(p[i])); }
function kinHtml(t, ...p) { const l = typeof window === 'object' && window && window.KinLanguage; return l && l.html ? l.html(t, ...p) : t.replace(/\{[ten]?(\d+)\}/g, (m, i) => String(p[i])); }
(function (root) {
  'use strict';
  const GB = 1024 ** 3, TTL = 72 * 60 * 60 * 1000;
  const STATUS = Object.freeze({ queued: 'Queued', downloading: 'Downloading', ready: 'Ready', failed: 'Failed', evicted: 'Evicted' });

  const LIVE = [STATUS.downloading, STATUS.ready, STATUS.queued];
  /**
   * When a copy goes - 72 hours after the later of its first stored frame and its last confirmed use (a viewer that
   * showed this copy after its live check, kept showing it, or left it), in server time; before its first frame, 72 hours
   * after it was queued. The one rule every expiry reads: the model, the worker's records and the panel's date.
   */
  const expiryOf = study => Math.max(study.fetchedAt ?? study.queuedAt, study.usedAt ?? -Infinity) + TTL;
  /**
   * Why an entry past its date went. A received copy went at the date its row showed - the words name that date, never a
   * count of hours (a copy's count starts no later than its key's last issue, so it can be shorter than 72 hours from
   * receipt when the key could not be issued again).
   */
  const lapsed = study => study.fetchedAt === null ? kinText("72시간 안에 받지 못해 대기열에서 지웠습니다.")
    : kinText("표시된 보관 기한이 지나 자동으로 지웠습니다. 다시 받으려면 Retry를 누르세요.");
  const positive = value => typeof value === 'number' && Number.isFinite(value) && value > 0;
  function budgetFor(diskGb) {
    const bytes = positive(diskGb) ? Math.floor(diskGb * GB) : null;
    return Number.isSafeInteger(bytes) && bytes > 0 ? bytes : null;
  }

  /** The study a frame path names, or null for anything but a WADO-RS frame path without a query. */
  function studyOfPath(path) {
    const m = /^\/dicom-web\/studies\/([0-9.]{1,64})\/series\/[0-9.]{1,64}\/instances\/[0-9.]{1,64}\/frames\/[0-9]+$/.exec(String(path));
    return m ? m[1] : null;
  }

  /**
   * `mint` names each copy: a random token, so a copy fetched after its key was replaced, or after the model was made
   * again, is never taken for an earlier one (a viewer's late answer names the copy it checked).
   */
  function create(budget, now = Date.now, mint = () => globalThis.crypto.randomUUID()) {
    const studies = new Map();
    let used = 0, seq = 0, clock = 0;
    const released = [];

    // An entry past its date is shown as the next sweep leaves it: no row says Ready, or waits, past the date it showed.
    // Not while a use the worker approved before that date is being stored (`approve`): that row is not gone, and a row
    // once said gone never comes back.
    const view = study => {
      const gone = LIVE.includes(study.status) && study.expiresAt <= now() && study.approved == null;
      return Object.freeze({ uid: study.uid, label: study.label, status: gone ? STATUS.evicted : study.status,
        reason: gone ? lapsed(study) : study.reason, waiting: !gone && study.waiting, done: gone ? 0 : study.frames.size,
        total: gone ? 0 : study.total, bytes: gone ? 0 : study.bytes, open: !gone && study.opens > 0, expiresAt: study.expiresAt,
        // The exams the entry was fetched for (none: the whole original): a list row's PF reads only its own exam's entry.
        ...(study.examRefs ? { examRefs: study.examRefs } : {}) });
    };

    function release(study) {
      const ids = [...study.frames.values()].map(f => f.entryId);
      used -= study.bytes;
      study.frames.clear(); study.bytes = 0; study.revision = null; study.total = 0; study.estimate = null; study.copy = null;
      // A copy's uses go with it: a later copy counts its own (an old viewer's close or check cannot reach it - open/close
      // name the copy).
      study.usedAt = null; study.approved = null; study.opens = 0; study.closedAt = null;
      return ids;
    }
    function end(study, status, reason) {
      const ids = release(study);
      study.status = status; study.reason = reason || null; study.waiting = false;
      return ids;
    }

    /** Studies that may go to make room, the longest closed first: opened at least once and open in no viewer now. */
    function evictable(except) {
      return [...studies.values()].filter(s => s.uid !== except && s.bytes > 0 && s.opens === 0 && s.closedAt !== null)
        .sort((a, b) => a.closedAt - b.closedAt);
    }

    function usable(uid, copy, at) {
      const s = studies.get(uid);
      return !!s && s.copy !== null && s.copy === copy && s.frames.size > 0 && Number.isFinite(at) && at < s.expiresAt && s.expiresAt > now()
        && LIVE.includes(s.status) && at > (s.usedAt ?? -Infinity);
    }

    return {
      budget: () => budget,
      evictable,
      takeReleased: () => released.splice(0),
      get: uid => studies.get(uid),
      entries: () => [...studies.values()],
      manifest(uid) {
        const s = studies.get(uid);
        return { uid: s.uid, label: s.label, status: s.status === STATUS.downloading ? STATUS.queued : s.status,
          ...(s.examRefs?{examRefs:s.examRefs}:{}),
          reason: s.reason, revision: s.revision, copy: s.copy, seq: s.seq, total: s.total,
          queuedAt: s.queuedAt, fetchedAt: s.fetchedAt, usedAt: s.usedAt, bytes: s.bytes,
          frames: Object.fromEntries([...s.frames].map(([path, f]) => [path, f.entryId])) };
      },
      restore(stored, records) {
        // A use only claimed (preload-worker.js touch: its approval never reached the disk) counts for nothing.
        const { claimedUse, ...value } = stored;
        const previous = studies.get(value.uid);
        if (previous) used -= previous.bytes;
        const frames = new Map(Object.entries(value.frames).map(([path, entryId]) => [path, { entryId, bytes: records.get(entryId)?.bytes || 0 }]));
        const s = { ...value, frames, bytes: [...frames.values()].reduce((n, f) => n + f.bytes, 0),
          status: value.status === STATUS.downloading ? STATUS.queued : value.status,
          usedAt: Number.isFinite(value.usedAt) ? value.usedAt : null, waiting: false, opens: 0, closedAt: null, estimate: null };
        s.expiresAt = expiryOf(s);
        studies.set(s.uid, s); used += s.bytes; seq = Math.max(seq, s.seq);
      },
      suspend() { for (const s of studies.values()) if (s.status === STATUS.downloading) s.status = STATUS.queued; },
      fetched(uid, at) { const s = studies.get(uid); if (s && s.fetchedAt === null) { s.fetchedAt = at; s.expiresAt = expiryOf(s); } },
      /** The first stored frame's time taken back (its frame was not kept): the expiry follows. */
      unfetched(uid, at) { const s = studies.get(uid); if (s) { s.fetchedAt = at; s.expiresAt = expiryOf(s); } },
      /**
       * Whether a use of `copy` at `at` (server time) may move its date on, asked at this moment: the copy is the one held,
       * holds frames, was not past its date at `at` and is not past it now, and the use is later than the last one counted.
       * An expired copy is never brought back by a late open, close, key answer or slow disk.
       */
      usable,
      /**
       * The worker's one judgement of a use, made when the write of its claim has ended (preload-worker.js touch): approved
       * when it is `usable` at this moment. An approved use awaits only its record: `use` once that is stored, `refuse` when
       * it could not be.
       */
      approve(uid, copy, at) {
        if (!usable(uid, copy, at)) return false;
        studies.get(uid).approved = at;
        return true;
      },
      /** The approved use, its record stored, is counted: the copy's date moves to 72 hours after it. The clock is not read again. */
      use(uid, copy, at) {
        const s = studies.get(uid);
        if (!s || s.copy === null || s.copy !== copy || s.approved == null || s.approved !== at) return false;
        s.approved = null; s.usedAt = at; s.expiresAt = expiryOf(s);
        return true;
      },
      /** The approval could not be stored: the copy keeps the date it had. */
      refuse(uid) { const s = studies.get(uid); if (s) s.approved = null; },
      expire(at = now()) {
        const ids = [];
        for (const s of studies.values()) if (s.expiresAt <= at && LIVE.includes(s.status)) ids.push(...end(s, STATUS.evicted, lapsed(s)));
        return ids;
      },
      /** Site disk cap (null: preload off). */
      setBudget(bytes) { budget = Number.isSafeInteger(bytes) && bytes > 0 ? bytes : null; },
      used: () => used,
      /**
       * Queue studies (in the reader's order). A study already queued, loading or held stays as it is. FC-073: `auto`
       * (the Auto Preload search) never queues a study this session already has in any status - a Failed or Evicted one
       * comes back only by Retry or a manual Preload; `urgent` studies go to the head of the queue, in their order.
       */
      add(list, { auto = false } = {}) {
        const added = [], urgent = [];
        for (const { uid, label, urgent: first, examRefs } of list) {
          const known = studies.get(uid);
          if(known && JSON.stringify(known.examRefs||null)!==JSON.stringify(examRefs||null)) {
            released.push(...release(known));
            studies.set(uid,{...known,examRefs,status:STATUS.queued,reason:null,waiting:false,seq:++seq,queuedAt:now(),fetchedAt:null,usedAt:null,opens:0,closedAt:null,expiresAt:now()+TTL});added.push(uid);continue;
          }
          if (known && (auto || ![STATUS.failed, STATUS.evicted].includes(known.status))) continue;
          if (first === true) urgent.push(uid);
          if (known) { known.status = STATUS.queued; known.reason = null; known.seq = ++seq; known.queuedAt = now(); known.fetchedAt = null; known.usedAt = null; known.expiresAt = now() + TTL; known.label = label ?? known.label; added.push(uid); continue; }
          studies.set(uid, { uid, ...(examRefs?{examRefs}:{}), label: label ?? null, status: STATUS.queued, reason: null, waiting: false, seq: ++seq,
            queuedAt: now(), fetchedAt: null, usedAt: null, expiresAt: now() + TTL, frames: new Map(), bytes: 0, total: 0, revision: null, estimate: null, copy: null, opens: 0, closedAt: null });
          added.push(uid);
        }
        if (urgent.length) {
          // One contiguous run ahead of every queued study, keeping the order the urgent studies came in.
          const front = Math.min(0, ...[...studies.values()].filter(s => !urgent.includes(s.uid)).map(s => s.seq));
          urgent.forEach((uid, i) => { studies.get(uid).seq = front - urgent.length + i; });
        }
        return added;
      },
      /** Retry puts the study at the head of the queue (design §4.1). */
      retry(uid) {
        const study = studies.get(uid);
        if (!study || ![STATUS.failed, STATUS.evicted].includes(study.status)) return false;
        const first = Math.min(0, ...[...studies.values()].map(s => s.seq));
        study.status = STATUS.queued; study.reason = null; study.waiting = false; study.seq = first - 1; study.queuedAt = now(); study.fetchedAt = null; study.usedAt = null; study.expiresAt = now() + TTL;
        return true;
      },
      /** The next study to fetch: the earliest queued one that is not waiting for space. */
      next() {
        return [...studies.values()].filter(s => s.status === STATUS.queued && !s.waiting).sort((a, b) => a.seq - b.seq)[0] || null;
      },
      /** Fetching begins or goes on; false when the study was cleared, removed or failed meanwhile. */
      start(uid, total) {
        const study = studies.get(uid);
        if (!study || ![STATUS.queued, STATUS.downloading].includes(study.status)) return false;
        if (study.copy === null) study.copy = mint();
        study.status = STATUS.downloading; study.reason = null; study.waiting = false;
        if (Number.isInteger(total) && total > 0) study.total = total;
        return true;
      },
      /**
       * Keep one frame of a study being fetched. `changed`: the archive's revision differs from the study's earlier
       * frames (the study changed while it was fetched - nothing of it is kept). `full`: no room even after eviction (the
       * study waits for space, its frames kept). `oversize`: the study could not fit even alone in the store - its frames
       * so far already exceed the budget, or, where it would otherwise wait, its frames so far projected over its frame
       * count do - so waiting for others to go would never let it in. `gone`: the study is no longer being fetched
       * (cleared, retried, evicted).
       */
      put(uid, path, frame, revision) {
        const study = studies.get(uid);
        if (!study || study.status !== STATUS.downloading) return 'gone';
        if (typeof revision !== 'string' || !revision) return 'changed';
        if (study.revision !== null && study.revision !== revision) return 'changed';
        if (study.frames.has(path)) return 'stored';
        const size = frame.bytes;
        if (budget !== null && study.bytes + size > budget) return 'oversize';
        if (budget === null || used + size > budget) {
          for (const victim of evictable(uid)) {
            if (budget !== null && used + size <= budget) break;
            released.push(...end(victim, STATUS.evicted, kinText("저장 공간을 비우려고 이미 본 검사를 지웠습니다. 다시 받으려면 Retry를 누르세요.")));
          }
          if (budget === null || used + size > budget) {
            // Before parking: from the frames read so far, would the whole study fit even if every other study went?
            const read = study.frames.size + 1;
            if (budget !== null && study.total > read && (study.bytes + size) / read * study.total > budget) return 'oversize';
            study.status = STATUS.queued; study.waiting = true; study.reason = kinText("저장 공간이 비기를 기다립니다.");
            return 'full';
          }
        }
        study.revision = revision;
        if (study.copy === null) study.copy = mint();
        study.frames.set(path, frame);
        study.bytes += size; used += size;
        return 'stored';
      },
      /** The size the whole study will take, from its first frames; false when even an empty store could not hold it. */
      estimate(uid, bytes) {
        const study = studies.get(uid);
        if (!study) return false;
        study.estimate = bytes;
        return budget !== null && bytes <= budget;
      },
      ready(uid) {
        const study = studies.get(uid);
        if (!study || study.status !== STATUS.downloading) return false;
        study.status = STATUS.ready; study.reason = null;
        return true;
      },
      fail(uid, reason) { const study = studies.get(uid); return study ? end(study, STATUS.failed, reason) : []; },
      evict(uid, reason) { const study = studies.get(uid); return study ? end(study, STATUS.evicted, reason) : []; },
      remove(uid) { const study = studies.get(uid); if (!study) return []; const ids = release(study); studies.delete(uid); return ids; },
      /** Clear All releases references; the list keeps the entries as Evicted. Session changes discard the model only. */
      clear(reason) { return [...studies.values()].flatMap(study => end(study, STATUS.evicted, reason)); },
      /** Space may have come free: studies that waited for it are queued again. */
      wake() { let woke = false; for (const s of studies.values()) if (s.waiting) { s.waiting = false; woke = true; } return woke; },
      /** The held study a viewer may check: its revision and copy, or null when nothing of it is held. */
      held(uid) {
        const study = studies.get(uid);
        return study && study.expiresAt > now() && study.frames.size && LIVE.includes(study.status)
          ? { revision: study.revision, status: study.status, copy: study.copy } : null;
      },
      frame(path) {
        const uid = studyOfPath(path), study = uid && studies.get(uid);
        return study && study.expiresAt > now() && LIVE.includes(study.status) ? study.frames.get(path) || null : null;
      },
      /**
       * A viewer shows this copy of the study: it cannot be evicted for space until every viewer that opened it has closed it.
       * Open and close name the copy - a close of an earlier copy is not one of this copy's.
       */
      open(uid, copy) { const study = studies.get(uid); if (!study || study.copy === null || study.copy !== copy) return false; study.opens++; study.closedAt = null; return true; },
      close(uid, copy) {
        const study = studies.get(uid);
        if (!study || study.copy === null || study.copy !== copy || study.opens === 0) return false;
        if (--study.opens === 0) study.closedAt = ++clock;
        return study.opens === 0;
      },
      snapshot() {
        return Object.freeze({ budget, used, studies: [...studies.values()].sort((a, b) => a.seq - b.seq).map(view) });
      },
    };
  }

  const api = Object.freeze({ create, budgetFor, studyOfPath, expiryOf, STATUS, TTL });
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.KinPreloadStore = api;
})(typeof self === 'object' ? self : typeof window === 'object' ? window : null);
