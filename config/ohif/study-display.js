
/* The patient and examination a study is shown as in this viewer: the worklist's answer for that study. That answer is the
   server's list row with the display overlay a Match or Modify stored (state.ov) over it, by the worklist's own rule
   (study-state.js OVERLAY_KEYS / overlayValue, worklist-data.js applyState); a clinician's row comes from the server with
   the overlay already applied. The cell heading, the cell identity label and the patient tab all read this one answer.
   The image header is never changed: Corner Information and the DICOM tag views still show the image's own values.
   Age is counted from the shown birth date and study date; without both, each place keeps what it showed before. */
const kinViewerStudyDisplay = (() => {
  const KEYS = ['id', 'name', 'sex', 'birth', 'age', 'desc', 'ward', 'date', 'acc', 'modality'];
  const valid = (key, value) => typeof value === 'string' || (key === 'age' && Number.isFinite(value));
  const text = value => typeof value === 'string' ? value : '';
  const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
  // Whole years between two dates written YYYYMMDD or YYYY-MM-DD, as 'NY'; '' when either is missing or the study precedes the birth.
  function years(birth, date) {
    const b = text(birth).replace(/-/g, ''), d = text(date).replace(/-/g, '');
    if (!/^\d{8}$/.test(b) || !/^\d{8}$/.test(d) || d < b) return '';
    return Math.floor((Number(d) - Number(b)) / 10000) + 'Y';
  }
  // One list row as it is shown. A key the overlay holds in the worklist's shape replaces the row's value; nothing else does.
  function shown(row) {
    const ov = row && typeof row === 'object' && row.state && typeof row.state === 'object' ? row.state.ov : null;
    const overlay = ov && typeof ov === 'object' && !Array.isArray(ov) ? ov : {};
    const out = {};
    for (const key of ['id', 'name', 'sex', 'birth', 'date', 'desc', 'acc', 'modality'])
      out[key] = own(overlay, key) && valid(key, overlay[key]) ? overlay[key] : text(row?.[key]);
    out.age = years(out.birth, out.date);
    return Object.freeze(out);
  }
  // A merged exam's other originals are the same patient as its row (the row's shown patient), each with its own
  // study date, description, accession and modality as the server sent them (sourceMetadata).
  function sourceShown(base, source) {
    const date = text(source.date);
    return Object.freeze({ ...base, date, desc: text(source.desc), acc: text(source.acc), modality: text(source.modality), age: years(base.birth, date) });
  }

  const known = new Map(), asked = new Map(), failed = new Map(), watchers = new Set();
  const RETRY_MS = 30000, BATCH = 100;
  let generation = 0, epoch = 0, queue = new Set(), queued = false;
  const tell = () => { for (const watch of [...watchers]) { try { watch(); } catch (_) {} } };
  // A read is numbered when it starts; an answer older than the latest read that names a study does not replace it.
  function begin(uids) { const gen = ++generation; for (const uid of uids) asked.set(uid, gen); return { gen, epoch }; }
  function learn(rows, ticket) {
    if (!ticket || ticket.epoch !== epoch) return false;
    let changed = false;
    const put = (uid, value) => {
      if ((asked.get(uid) || 0) > ticket.gen) return;
      failed.delete(uid);
      const before = known.get(uid);
      if (before && JSON.stringify(before) === JSON.stringify(value)) return;
      known.set(uid, value); changed = true;
    };
    for (const row of Array.isArray(rows) ? rows : []) {
      if (!row || typeof row.uid !== 'string' || !row.uid) continue;
      const base = shown(row);
      put(row.uid, base);
      for (const source of Array.isArray(row.sourceMetadata) ? row.sourceMetadata : [])
        if (source && typeof source.uid === 'string' && source.uid && source.uid !== row.uid) put(source.uid, sourceShown(base, source));
    }
    if (changed) tell();
    return changed;
  }
  function session() { return typeof kinViewerSession === 'object' && kinViewerSession ? kinViewerSession : null; }
  async function read(uids) {
    const list = [...new Set(uids)].filter(uid => typeof uid === 'string' && uid);
    if (!list.length) return;
    const ticket = begin(list);
    try {
      const s = session();
      if (s?.state?.() === 'unconfirmed') await s.decide?.();
      if (ticket.epoch !== epoch || s?.ended?.()) return;
      // The same scoped list endpoint the patient tab reads: a clinician's rows come overlaid from the server.
      const endpoint = s?.readOnly?.() ? '/api/clinician/studies' : '/api/studies';
      for (let offset = 0; offset < list.length; offset += BATCH) {
        const query = new URLSearchParams({ uids: list.slice(offset, offset + BATCH).join(',') });
        const response = await fetch(endpoint + '?' + query, { credentials: 'same-origin', cache: 'no-store' });
        if (!response.ok) throw new Error('study display read failed');
        learn((await response.json())?.studies, ticket);
      }
    } catch (_) {
      // Unread: the places keep the image's own values; the study is asked again after a pause, not on every repaint.
      if (ticket.epoch === epoch) for (const uid of list) if (asked.get(uid) === ticket.gen && !known.has(uid)) failed.set(uid, Date.now());
    }
  }
  function flush() { queued = false; const list = [...queue]; queue = new Set(); read(list); }
  // The shown values of a study, or null while unknown (the first ask starts a read; the answer tells the watchers).
  function of(uid) {
    if (typeof uid !== 'string' || !uid) return null;
    if (known.has(uid)) return known.get(uid);
    const at = failed.get(uid);
    if (!asked.has(uid) || (at !== undefined && Date.now() - at >= RETRY_MS)) {
      if (at !== undefined) failed.delete(uid);
      asked.set(uid, asked.get(uid) || 0);
      queue.add(uid);
      if (!queued) { queued = true; queueMicrotask(flush); }
    }
    return null;
  }
  // Everything learned belongs to the account and role that read it.
  function forget() { epoch++; known.clear(); asked.clear(); failed.clear(); queue = new Set(); tell(); }
  try { session()?.onChange?.(forget); } catch (_) {}
  try { if (typeof kinViewerOnEnd === 'function') kinViewerOnEnd(forget); } catch (_) {}
  return Object.freeze({
    keys: Object.freeze([...KEYS]), shown, years, of,
    peek: uid => known.get(uid) || null,
    // A study opened again is read again: a Match or Unmatch since it was last read shows now.
    refresh: uids => read(uids),
    begin, learn, forget,
    subscribe(watch) { watchers.add(watch); return () => { watchers.delete(watch); }; },
  });
})();
window.kinViewerStudyDisplay = kinViewerStudyDisplay;
