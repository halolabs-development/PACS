/* Viewer metadata belongs to the session that read it. A list answer replaces the entire
   examination (including all its originals and split parts) under one request number. */
const kinViewerStudyDisplay = (() => {
  // Also run on its own (a page test takes this function out of config/ohif.js): the words then stay as written.
  const kinText = globalThis.kinText || ((t, ...p) => t.replace(/\{[ten]?(\d+)\}/g, (m, i) => String(p[i]))), kinHtml = globalThis.kinHtml || kinText, kinError = globalThis.kinError || ((t, ...p) => Object.assign(new Error(kinText(t, ...p)), { kinWords: true }));
  const exams = new Map(), latest = new Map(), held = new Map(), retries = new Map();
  const watchers = new Set(), visibleSources = new Set(), queue = new Set();
  const session = typeof kinViewerSession === 'object' ? kinViewerSession : null;
  const period = 30000;
  let epoch = 0, sequence = 0, queued = false, ended = false;
  function notify() {
    for (const watch of watchers) {
      try { watch(); } catch (error) { console.error('Viewer display refresh failed', error); }
    }
  }
  const distinct = values => [...new Set(values.filter(v => typeof v === 'string' && v))];
  const ids = exam => [exam.uid, ...exam.displaySources.map(s => s.studyUid)];
  const visible = () => distinct(visibleSources.size ? [...visibleSources].flatMap(get => [...get()]) : [...latest.keys()]);
  const failure = cause => new Error(kinText("환자 정보를 불러오지 못했습니다. 영상은 계속 볼 수 있습니다. 다시 시도하세요."), { cause });
  const stale = () => kinError("검사 또는 로그인 상태가 바뀌었습니다. 다시 시도하세요.");

  function validExam(exam) {
    const key = exam?.sourcePatientKey;
    return typeof exam?.uid === 'string' && typeof key === 'string' && key.indexOf('|') > 0 && key.indexOf('|') < key.length - 1 &&
      Array.isArray(exam.displaySources) && exam.displaySources.length > 0 && exam.displaySources.every(s =>
        s?.sourcePatientKey === key && typeof s.studyUid === 'string' && s.studyUid &&
        ['all', 'include', 'exclude'].includes(s.series?.mode) && Array.isArray(s.series.uids) && Array.isArray(s.values?.over));
  }
  function affected(uids, projections = exams.values()) {
    const touched = new Set(uids), groups = [...projections].map(ids);
    // An answer may replace an old grouping with a split or a merge. Include both sides.
    let before;
    do {
      before = touched.size;
      for (const group of groups) if (group.some(uid => touched.has(uid)))
        for (const uid of group) touched.add(uid);
    } while (before !== touched.size);
    return touched;
  }

  async function lookup(uids, { signal, patientKey, valid = () => true, role = session } = {}) {
    const touched = affected(distinct(uids)), number = ++sequence, start = epoch;
    const current = () => !ended && start === epoch && !role?.ended?.() && !signal?.aborted && valid();
    if (!current()) throw stale();
    for (const uid of touched) { latest.set(uid, number); queue.delete(uid); }
    const replace = (rows, failed) => {
      if (!current()) return false;
      const groups = [...exams.values(), ...rows];
      const scope = affected([...touched, ...rows.flatMap(ids)], groups);
      // A newer read of one prior protects that entire exam. An independent exam in the
      // same batch must still lose its old values if this response omitted or refused it.
      const protectedIds = affected([...scope].filter(uid => latest.get(uid) > number), groups);
      const accepted = new Set([...scope].filter(uid => !protectedIds.has(uid)));
      for (const [uid, exam] of exams) if (ids(exam).some(id => accepted.has(id))) exams.delete(uid);
      for (const uid of accepted) {
        latest.set(uid, number);
        if (failed) retries.set(uid, Date.now() + period); else retries.delete(uid);
      }
      for (const exam of rows) if (accepted.has(exam.uid)) exams.set(exam.uid, exam);
      if (accepted.size) notify();
      return accepted.size === scope.size;
    };
    const incoming = [], unlistedUids = new Set();
    try {
      if (role?.state?.() === 'unconfirmed') await role.decide();
      if (!current() || role?.state?.() === 'unconfirmed') throw stale();
      const endpoint = role?.readOnly?.() ? '/api/clinician/studies' : '/api/studies';
      // Unknown split siblings can only be discovered by asking for the original. A catalog read
      // uses the same endpoint without a UID filter, retaining only the open patient's rows.
      const queryIds = [...touched];
      for (let offset = 0; offset < (patientKey ? 1 : queryIds.length); offset += 100) {
        const query = patientKey ? '' : '?' + new URLSearchParams({ uids: queryIds.slice(offset, offset + 100).join(',') });
        const response = await fetch(endpoint + query, { credentials: 'same-origin', cache: 'no-store', signal,
          headers: { 'X-Kin-Viewer-Display': '1' } });
        if (!response.ok) throw failure(response);
        const body = await response.json();
        if (!Array.isArray(body?.studies)) throw failure();
        for (const uid of body.unlistedUids || []) unlistedUids.add(uid);
        for (const exam of body.studies) {
          if (validExam(exam) && (patientKey ? exam.sourcePatientKey === patientKey : ids(exam).some(uid => touched.has(uid)))) incoming.push(exam);
        }
        if (!current()) throw stale();
      }
    } catch (error) {
      if (!replace([], true)) throw stale();
      throw error;
    }
    if (!replace(incoming, false)) throw stale();
    return { studies: incoming, unlistedUids, current: () => current() && [...affected([...touched, ...incoming.flatMap(ids)])].every(uid => latest.get(uid) === number) };
  }
  const refresh = uids => uids.length ? lookup(uids).catch(() => null) : Promise.resolve(null);
  const refreshAll = () => refresh(visible());
  function ask(uid) {
    if (ended || session?.ended?.() || held.has(uid)) return;
    if (latest.has(uid) && (!retries.has(uid) || Date.now() < retries.get(uid))) return;
    queue.add(uid);
    if (!queued) {
      queued = true;
      queueMicrotask(() => {
        queued = false;
        const list = [...queue]; queue.clear();
        if (list.length) refresh(list);
      });
    }
  }
  const primary = exam => (exam.displaySources.find(s => s.studyUid === exam.uid) || exam.displaySources[0]).values;
  function row(uid, key) {
    const exam = exams.get(uid);
    if (exam && (!key || exam.sourcePatientKey === key)) return primary(exam);
    // A tab opened before a merge can still be addressed by its original study UID.
    const sources = [...exams.values()].filter(e => !key || e.sourcePatientKey === key)
      .flatMap(e => e.displaySources.filter(s => s.studyUid === uid));
    return sources.length === 1 ? sources[0].values : null;
  }
  function of(uid, series, patientId) {
    if (!uid || !series || !patientId) return null;
    ask(uid);
    const matches = [...exams.values()].flatMap(exam => exam.displaySources.filter(s => s.studyUid === uid &&
      (s.series.mode === 'all' || (s.series.mode === 'include') === s.series.uids.includes(series))));
    if (matches.length !== 1) return null;
    const source = matches[0], key = source.sourcePatientKey;
    const tabKey = window.KinViewerPatientTabs?.snapshot()?.key;
    return (!tabKey || tabKey === key) && key.slice(key.indexOf('|') + 1) === patientId ? source.values : null;
  }

  // Without a server replacement keep the DICOM spelling (in particular PN) and the last rendered image's age.
  function years(birth, date) {
    function day(value) {
      const digits = typeof value === 'string' && value.replace(/^(\d{4})-(\d{2})-(\d{2})$/, '$1$2$3');
      if (!digits || !/^\d{8}$/.test(digits)) return '';
      const iso = digits.slice(0, 4) + '-' + digits.slice(4, 6) + '-' + digits.slice(6);
      const time = Date.parse(iso);
      return Number.isFinite(time) && new Date(time).toISOString().startsWith(iso + 'T') ? digits : '';
    }
    const b = day(birth), d = day(date);
    return b && d && d >= b ? Math.floor((Number(d) - Number(b)) / 10000) + 'Y' : '';
  }
  function view(answer, image) {
    const changed = answer?.over || [], out = { ...image, changed };
    for (const key of changed) out[key] = answer[key];
    out.age = (answer?.age || years(out.birth, out.date)) ||
      (changed.includes('birth') || changed.includes('date') ? '' : image.age || '');
    return out;
  }
  function hold(uids) {
    for (const uid of uids) { held.set(uid, (held.get(uid) || 0) + 1); queue.delete(uid); }
    return () => { for (const uid of uids) {
      if (held.get(uid) > 1) held.set(uid, held.get(uid) - 1); else held.delete(uid);
    } };
  }
  function forget() { epoch++; exams.clear(); latest.clear(); retries.clear(); queue.clear(); notify(); }
  let previousRole = session?.state?.();
  session?.onChange?.(next => {
    const previous = previousRole; previousRole = next;
    // The first verdict releases reads waiting on decide(); none was sent as 'unconfirmed'.
    if (previous === 'unconfirmed' && !session.ended?.()) return;
    const shown = visible();
    forget();
    if (shown.length && !session.ended?.() && next !== 'unconfirmed') refresh(shown);
  });
  const timer = window.setInterval?.(() => { if (!ended && !window.KinViewerPatientTabs?.pending?.()) refreshAll(); }, period);
  if (typeof kinViewerOnEnd === 'function') kinViewerOnEnd(() => { ended = true; window.clearInterval?.(timer); forget(); });
  return { of, row, view, lookup, hold, refresh, refreshAll,
    examsFor(uids, key) { return [...exams.values()].filter(exam => exam.sourcePatientKey === key && ids(exam).some(uid => uids.includes(uid))); },
    subscribe(fn) { watchers.add(fn); return () => watchers.delete(fn); },
    showing(get) { visibleSources.add(get); return () => visibleSources.delete(get); } };
})();
window.kinViewerStudyDisplay = kinViewerStudyDisplay;
