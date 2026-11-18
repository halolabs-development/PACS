
/* The patient and examination a study is shown as in this viewer: the worklist's answer for that study. That answer is the
   server's list row with the display overlay a Match or Modify stored (state.ov) over it, by the worklist's own rule
   (study-state.js OVERLAY_KEYS / overlayValue, worklist-data.js applyState); a clinician's row comes from the server with
   the overlay already applied. The cell heading, the cell identity label and window title, the patient tab and the prior
   list all read this one answer. The image header is never changed: Corner Information, Copy Patient ID and the DICOM tag
   views still show the image's own values. Age is counted from the shown birth date and study date.
   Whenever the answer is not certain for the drawn image - not read yet, the read failed, no row answers for it, two
   exam rows answer differently for it, or the row's own Patient ID is not the image's - a place shows the image's values. */
const kinViewerStudyDisplay = (() => {
  const KEYS = ['id', 'name', 'sex', 'birth', 'age', 'desc', 'ward', 'date', 'acc', 'modality'];
  const SHOWN = ['id', 'name', 'sex', 'birth', 'date', 'desc', 'acc', 'modality'], PATIENT = ['id', 'name', 'sex', 'birth'];
  const valid = (key, value) => typeof value === 'string' || (key === 'age' && Number.isFinite(value));
  const text = value => typeof value === 'string' ? value : '';
  const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
  // A calendar date written YYYYMMDD or YYYY-MM-DD, as YYYYMMDD; '' when it is not a real date.
  function day(value) {
    const v = text(value).replace(/-/g, '');
    if (!/^\d{8}$/.test(v)) return '';
    const y = +v.slice(0, 4), m = +v.slice(4, 6), d = +v.slice(6, 8), at = new Date(Date.UTC(y, m - 1, d));
    return at.getUTCFullYear() === y && at.getUTCMonth() === m - 1 && at.getUTCDate() === d ? v : '';
  }
  // Whole years between two dates, as 'NY'; '' when either is not a date or the study precedes the birth.
  function years(birth, date) {
    const b = day(birth), d = day(date);
    if (!b || !d || d < b) return '';
    return Math.floor((Number(d) - Number(b)) / 10000) + 'Y';
  }
  // One list row as it is shown. A key the overlay holds in the worklist's shape replaces the row's value (also with '');
  // `over` names the keys it replaced, so a place never fills a replaced value from the image.
  function shown(row) {
    const ov = row && typeof row === 'object' && row.state && typeof row.state === 'object' ? row.state.ov : null;
    const overlay = ov && typeof ov === 'object' && !Array.isArray(ov) ? ov : {};
    const out = {}, over = [];
    for (const key of SHOWN) {
      if (own(overlay, key) && valid(key, overlay[key])) { out[key] = overlay[key]; over.push(key); }
      else out[key] = text(row?.[key]);
    }
    out.age = years(out.birth, out.date);
    out.over = Object.freeze(over);
    return Object.freeze(out);
  }
  // The row's own (image) Patient ID: the server's patient key is `institution|PatientID` of the original, also for a
  // clinician's overlaid row. Without it the answer cannot be tied to an image.
  const sourceOf = row => typeof row?.sourcePatientKey === 'string' && row.sourcePatientKey.includes('|')
    ? row.sourcePatientKey.slice(row.sourcePatientKey.indexOf('|') + 1) : null;
  const inSeries = (spec, series) => !spec || spec.mode === 'all' ||
    (typeof series === 'string' && Array.isArray(spec.uids) && (spec.mode === 'include' ? spec.uids.includes(series) : spec.mode === 'exclude' && !spec.uids.includes(series)));

  // Original study UID -> the exam rows that answer for it: { exam (row uid), series (null = all), value, source, base, gen }.
  // A plain study has one; the parts of a split study each answer for their own series; a merged exam answers for each original.
  const known = new Map(), rows = new Map(), asked = new Map(), failed = new Map(), watchers = new Set();
  const RETRY_MS = 30000, BATCH = 100;
  let generation = 0, epoch = 0, queue = new Set(), queued = false;
  const tell = () => { for (const watch of [...watchers]) { try { watch(); } catch (_) {} } };
  function begin(uids) { const gen = ++generation, list = [...new Set(uids)]; for (const uid of list) asked.set(uid, gen); return { gen, epoch, uids: list }; }
  // The originals a row answers for, each with its value.
  function targets(row, value) {
    const scope = row.examScope && typeof row.examScope === 'object' ? row.examScope : null;
    const meta = new Map((Array.isArray(row.sourceMetadata) ? row.sourceMetadata : []).filter(s => s && typeof s.uid === 'string').map(s => [s.uid, s]));
    const sources = Array.isArray(scope?.sources) ? scope.sources.filter(s => s && typeof s.studyUid === 'string' && s.studyUid) : [];
    const other = uid => { const s = meta.get(uid); if (!s) return value; const date = text(s.date);
      return Object.freeze({ ...value, date, desc: text(s.desc), acc: text(s.acc), modality: text(s.modality), age: years(value.birth, date), over: Object.freeze(value.over.filter(k => PATIENT.includes(k))) }); };
    if (sources.length) return sources.map(s => ({ study: s.studyUid, series: s.series && typeof s.series === 'object' ? s.series : null,
      value: sources.length === 1 || s.studyUid === row.uid ? value : other(s.studyUid) }));
    return [{ study: row.uid, series: null, value }, ...[...meta.keys()].filter(uid => uid !== row.uid).map(uid => ({ study: uid, series: null, value: other(uid) }))];
  }
  // One successful answer: what each row says, and which studies (and row UIDs) it covered.
  function learn(list, ticket) {
    let changed = false;
    const covered = new Set();
    for (const row of Array.isArray(list) ? list : []) {
      if (!row || typeof row.uid !== 'string' || !row.uid) continue;
      const value = shown(row), source = sourceOf(row);
      covered.add(row.uid);
      // A clinician's row of a merged exam's other original names the exam's (base) patient, as the writer's list does.
      const exam = row.exam && typeof row.exam === 'object' ? row.exam : null;
      const base = exam?.active === true && typeof exam.baseUid === 'string' && exam.baseUid && exam.baseUid !== row.uid ? exam.baseUid : null;
      const before = rows.get(row.uid);
      if (!before || before.gen <= ticket.gen) {
        const entry = { value, source, base, gen: ticket.gen };
        if (!before || JSON.stringify([before.value, before.source, before.base]) !== JSON.stringify([value, source, base])) changed = true;
        rows.set(row.uid, entry);
      }
      for (const target of targets(row, value)) {
        covered.add(target.study);
        const entries = known.get(target.study) || [], at = entries.findIndex(e => e.exam === row.uid);
        if (at >= 0 && entries[at].gen > ticket.gen) continue;
        const entry = { exam: row.uid, series: target.series, value: target.value, source, base, gen: ticket.gen };
        if (at < 0 || JSON.stringify(entries[at]) !== JSON.stringify(entry)) changed = true;
        if (at >= 0) entries[at] = entry; else entries.push(entry);
        known.set(target.study, entries); failed.delete(target.study);
      }
    }
    return { changed, covered };
  }
  // A study asked by this read and answered by no row (gone from the caller's list), or a failed read: what an older read
  // said of it is not shown any more.
  function drop(ticket, uids) {
    let changed = false;
    for (const uid of uids) {
      const entries = known.get(uid);
      if (entries) { const kept = entries.filter(e => e.gen > ticket.gen); if (kept.length !== entries.length) changed = true;
        if (kept.length) known.set(uid, kept); else known.delete(uid); }
      const row = rows.get(uid);
      if (row && row.gen <= ticket.gen) { rows.delete(uid); changed = true; }
    }
    return changed;
  }
  // Every read - the store's own and the patient tab's - ends here: its rows, or null when it failed.
  function settle(ticket, list) {
    if (!ticket || ticket.epoch !== epoch) return;
    let changed;
    if (list === null) {
      changed = drop(ticket, ticket.uids);
      for (const uid of ticket.uids) if (asked.get(uid) === ticket.gen) failed.set(uid, Date.now());
    } else {
      const result = learn(list, ticket);
      const gone = drop(ticket, ticket.uids.filter(uid => !result.covered.has(uid)));
      changed = result.changed || gone;
    }
    if (changed) tell();
  }
  function session() { return typeof kinViewerSession === 'object' && kinViewerSession ? kinViewerSession : null; }
  async function read(uids) {
    const list = [...new Set(uids)].filter(uid => typeof uid === 'string' && uid);
    if (!list.length) return;
    const ticket = begin(list), answered = [];
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
        const body = await response.json();
        if (!Array.isArray(body?.studies)) throw new Error('study display read failed');
        answered.push(...body.studies);
      }
    } catch (_) { settle(ticket, null); return; }
    settle(ticket, answered);
  }
  function flush() { queued = false; const list = [...queue]; queue = new Set(); read(list); }
  function ask(uid) {
    const at = failed.get(uid);
    if (asked.has(uid) && !(at !== undefined && Date.now() - at >= RETRY_MS)) return;
    failed.delete(uid); asked.set(uid, asked.get(uid) || 0); queue.add(uid);
    if (!queued) { queued = true; queueMicrotask(flush); }
  }
  // An entry's value with its exam's patient (a clinician's merged original names its base's patient once that is known).
  function withBase(entry) {
    if (!entry.base) return entry.value;
    const base = rows.get(entry.base);
    if (!base) { ask(entry.base); return null; }
    const value = { ...entry.value };
    for (const key of PATIENT) value[key] = base.value[key];
    value.age = years(value.birth, value.date);
    value.over = Object.freeze([...new Set([...entry.value.over.filter(k => !PATIENT.includes(k)), ...base.value.over.filter(k => PATIENT.includes(k))])]);
    return Object.freeze(value);
  }
  // The shown values for a drawn image (its study, series and own Patient ID), or null: then the image's values.
  function of(study, series, patientId) {
    if (typeof study !== 'string' || !study) return null;
    const entries = known.get(study);
    if (!entries) { ask(study); return null; }
    const answers = entries.filter(e => inSeries(e.series, series));
    if (!answers.length) return null;
    const values = answers.map(withBase);
    if (values.some(v => !v) || values.some(v => JSON.stringify(v) !== JSON.stringify(values[0]))) return null;
    if (typeof patientId !== 'string' || answers.some(e => e.source !== patientId)) return null;
    return values[0];
  }
  // The shown values of an exam row (the patient tab: its exam, not an image); `read`: ask for it when unknown.
  function row(uid, read = false) {
    const entry = typeof uid === 'string' ? rows.get(uid) : null;
    if (!entry && read && typeof uid === 'string' && uid) ask(uid);
    return entry ? withBase(entry) : null;
  }
  // Everything learned belongs to the account and role that read it.
  // The patient tab's lookup of an opening is that opening's one read: from its start, a place showing those studies waits
  // for it instead of reading them itself (hold); a lookup that ends before its read began lets them be asked (release).
  function hold(uids) { for (const uid of uids) if (typeof uid === 'string' && uid && !asked.has(uid)) asked.set(uid, 0); }
  function release(uids) { for (const uid of uids) if (asked.get(uid) === 0 && !known.has(uid) && !rows.has(uid)) asked.delete(uid); }
  function forget() { epoch++; known.clear(); rows.clear(); asked.clear(); failed.clear(); queue = new Set(); tell(); }
  try { session()?.onChange?.(forget); } catch (_) {}
  try { if (typeof kinViewerOnEnd === 'function') kinViewerOnEnd(forget); } catch (_) {}
  return Object.freeze({
    keys: Object.freeze([...KEYS]), shown, years, of, row,
    // Opened again (the same studies from the list, a reused reading frame): every study this viewer has asked about is
    // read again, so a Match or Unmatch since shows - also in cells added after the opening.
    refresh: uids => read(uids),
    refreshAll: () => read([...new Set([...known.keys(), ...rows.keys(), ...asked.keys()])]),
    begin, settle, forget, hold, release,
    subscribe(watch) { watchers.add(watch); return () => { watchers.delete(watch); }; },
  });
})();
window.kinViewerStudyDisplay = kinViewerStudyDisplay;
