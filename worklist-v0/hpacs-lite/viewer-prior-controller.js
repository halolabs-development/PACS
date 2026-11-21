// The viewer write path (viewer-language.js): product words in the reader's screen language, or as written.
function kinText(t, ...p) { const l = typeof window === 'object' && window && window.KinLanguage; return l && l.text ? l.text(t, ...p) : t.replace(/\{[ten]?(\d+)\}/g, (m, i) => String(p[i])); }
function kinHtml(t, ...p) { const l = typeof window === 'object' && window && window.KinLanguage; return l && l.html ? l.html(t, ...p) : t.replace(/\{[ten]?(\d+)\}/g, (m, i) => String(p[i])); }
function kinError(t, ...p) { return Object.assign(new Error(kinText(t, ...p)), { kinWords: true }); }
window.KinViewerPriorController = (() => {
  // Match the workspace calendar rule: an absent/invalid date is never a Prior.
  function validDate(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const [year, month, day] = value.split('-').map(Number);
    const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    return year > 0 && month >= 1 && month <= 12 && day >= 1 &&
      day <= [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  }
  const date = value => typeof value === 'string' && /^\d{8}$/.test(value)
    ? value.slice(0, 4) + '-' + value.slice(4, 6) + '-' + value.slice(6) : value;
  function relation(study, current) {
    if (study.uid === current.uid) return 'Current';
    if (!validDate(study.date) || !validDate(current.date)) return 'Unknown-date Comparison';
    if (study.date === current.date) return 'Same-date Comparison';
    return study.date < current.date ? 'Prior' : 'Later Comparison';
  }
  // Same head semantics as related-report.js: reset/cancel supersedes approval;
  // discarded records alone are ignored. Never search backwards for an approve.
  function reportHead(versions) {
    const head = versions.filter(version => version?.action !== 'discarded')
      .sort((a, b) => b.version - a.version)[0];
    return head && Number.isSafeInteger(head.version) && ['approve', 'amend', 'addendum'].includes(head.action) ? head : null;
  }
  function create({ viewer, loadStudy, onList, onReport }) {
    let origin = null, rows = [], listRequest = null, reportRequest = null, imageRequest = null, disposed = false;
    const display = window.kinViewerStudyDisplay;
    let reportView = null, listedUids = [];
    const fields = ['patientKey', 'sequence', 'viewportId', 'studyUid', 'seriesUid', 'displaySetUid', 'mode'];
    // A cell still shows, for the same patient tab, what it showed when the request began.
    function same(value) {
      const now = value && viewer.viewport(value.viewportId), patient = viewer.snapshot();
      return !disposed && !!now && !!patient && patient.key === value.patientKey && patient.sequence === value.sequence &&
        fields.every(field => now[field] === value[field]);
    }
    const current = () => same(origin);
    // The patient's studies (one patient key, identity resolved) with their relation to the tab's current study.
    function listed(data, value) {
      if (!Array.isArray(data?.studies)) throw kinError("검사 목록 응답을 확인할 수 없습니다.");
      const patient = viewer.snapshot();
      const studies = data.studies.flatMap(study => {
        if (study.sourcePatientKey !== value.patientKey) return [];
        const values = display ? display.row(study.uid, value.patientKey) : study;
        return values ? [{ ...study, ...values, date: date(values.date) }] : [];
      });
      const referenceUid = patient.examScope?.reportUid || patient.studyUIDs[0];
      const originals = studies.filter(study => study.displaySources?.some(source => source.studyUid === referenceUid));
      const reference = studies.find(study => study.uid === referenceUid) || (originals.length === 1 ? originals[0] : null);
      // The cell's own exam: its study listed by UID, a part of the tab's current exam, or a listed merged or split exam
      // that holds the cell's original (and series) — e.g. the second original of a merged prior.
      const source = studies.find(study => study.uid === value.studyUid && study.sourcePatientKey === value.patientKey) ||
        (value.studyUid === referenceUid ? reference : null) ||
        (patient.examScope?.sources.some(source=>source.studyUid===value.studyUid)?reference:null) ||
        window.KinExamScope?.listedExam?.(studies.filter(study => study.sourcePatientKey === value.patientKey), value.studyUid, value.seriesUid) || null;
      if (!reference || !source) return null;
      return studies.filter(study => study.sourcePatientKey === value.patientKey && !study.state?.identityUnresolved)
        .sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')) || b.uid.localeCompare(a.uid))
        .map(study => ({ ...study, relation: relation(study, reference) }));
    }
    async function readList(value, signal) {
      if (!display) return read('/api/studies', { signal });
      const result = await display.lookup([...viewer.snapshot().studyUIDs, value.studyUid, ...listedUids],
        { patientKey: value.patientKey, signal, valid: () => same(value) });
      return { studies: result.studies };
    }
    function showReport(value) { reportView = value; onReport(value); }
    const stopShowing = display?.showing(() => listedUids);
    const stopDisplay = display?.subscribe(() => {
      if (!listedUids.length) return;
      if (!current()) { close(); return; }
      const fresh = listed({ studies: display.examsFor(listedUids, origin.patientKey) }, origin) || [];
      if (JSON.stringify(rows) === JSON.stringify(fresh)) return;
      rows = fresh;
      onList(rows.length ? { state: 'ready', origin, studies: rows } : { state: 'no-study', origin });
      if (reportView?.study) {
        const study = rows.find(row => row.uid === reportView.study.uid);
        if (study) showReport({ ...reportView, study });
        else closeReport();
      }
    });
    function closeReport() { reportRequest?.abort(); reportRequest = null; reportView = null; onReport({ state: 'closed' }); }
    function close() {
      listRequest?.abort(); listRequest = null; rows = []; listedUids = []; origin = null;
      imageRequest?.abort(); imageRequest = null;
      closeReport(); onList({ state: 'closed' });
    }
    // The adapter calls this on the existing viewport events, including removal.
    function refresh() { if (origin && !current()) close(); }
    async function read(path, request) {
      const response = await fetch(path, { credentials: 'same-origin', cache: 'no-store', signal: request.signal });
      if (window.KinSessionTransport.refusal(response)) throw window.KinSessionTransport.responseError(response);
      if (!response.ok) throw new Error(response.status === 403 || response.status === 404
        ? kinText("이 검사 또는 판독문을 조회할 수 없습니다.") : kinText("연결을 확인한 뒤 다시 시도하세요."));
      return response.json();
    }
    async function open(value) {
      close();
      if (disposed) return;
      origin = value && { ...value };
      if (!current()) { origin = null; onList({ state: 'no-study' }); return; }
      const request = listRequest = new AbortController();
      const admitted = () => listRequest === request && !request.signal.aborted && current();
      onList({ state: 'loading', origin });
      try {
        const data = await readList(origin, request.signal);
        if (!admitted()) return;
        const found = listed(data, origin);
        if (!found) { onList({ state: 'no-study', origin }); return; }
        rows = found; listedUids = rows.map(row => row.uid);
        onList({ state: 'ready', origin, studies: rows });
      } catch (error) {
        if (admitted()) onList({ state: 'error', origin, message: error.message });
      }
    }
    async function openReport(uid) {
      closeReport();
      if (!current()) { refresh(); return; }
      const study = rows.find(row => row.uid === uid);
      if (!study) { onReport({ state: 'no-study' }); return; }
      const request = reportRequest = new AbortController();
      const admitted = () => reportRequest === request && !request.signal.aborted && current();
      showReport({ state: 'loading', origin, study });
      try {
        const versions = await read('/api/studies/' + encodeURIComponent(uid) + '/report/versions', request);
        if (!admitted()) return;
        if (!Array.isArray(versions)) throw kinError("판독 이력 응답을 확인할 수 없습니다.");
        const report = reportHead(versions);
        // C-R01-122: the same read is the study's report history; the panel's History shows every version it holds.
        showReport({ state: report ? 'ready' : 'none', origin, study: reportView.study, report,
          versions: versions.filter(version => version && Number.isSafeInteger(version.version)).sort((a, b) => b.version - a.version) });
      } catch (error) {
        if (admitted()) showReport({ state: 'error', origin, study: reportView.study, message: error.message });
      }
    }
    async function openImages(uid) {
      imageRequest?.abort();
      if (!current() || !rows.some(row => row.uid === uid)) { refresh(); return; }
      const request = imageRequest = new AbortController();
      const value = { ...origin };
      const admitted = () => imageRequest === request && !request.signal.aborted && current();
      onList({ state: 'ready', origin, studies: rows, message: kinText("영상을 불러오는 중…") });
      try {
        const sets = await loadStudy(uid, value, rows.find(row=>row.uid===uid),{signal:request.signal,valid:admitted});
        if (sets?.reopened) { close(); return; }
        if (!admitted()) return;
        if (!sets.length) throw kinError("표시할 영상 시리즈가 없습니다.");
        if (!await viewer.compare(value, [sets[0].displaySetInstanceUID], { signal: request.signal, studies: rows })) {
          if (admitted()) throw kinError("저장·편집 또는 배치를 확인한 뒤 다시 시도하세요. 현재 영상은 유지합니다.");
          return;
        }
        close();
      } catch (error) {
        if (admitted()) onList({ state: 'ready', origin, studies: rows, message: error.message, retryImageUid: uid });
      }
    }
    // The Compare menu's way to the same studies and the same opening, for any cell and without the panel. Every answer
    // applies only while each cell it was asked for still shows what it showed (same()); a late answer does nothing.
    const related = {
      // The patient's related studies for the cell value, or null when that cell's study is not in the list.
      async studies(value, signal) {
        if (!same(value)) return null;
        const data = await readList(value, signal);
        if (signal?.aborted || !same(value)) return null;
        return listed(data, value);
      },
      // Opens a related study in the cell's comparison place, as the panel's open does; with seriesUid, that series
      // (into the cell itself when it is the cell's own study). Resolves true when the grid changed.
      async open(value, uid, { seriesUid = null, signal, studies } = {}) {
        if (!same(value) || !studies?.some(row => row.uid === uid)) return false;
        const sets = await loadStudy(uid, value, studies.find(row=>row.uid===uid),{signal,seriesUid,valid:()=>!signal?.aborted&&same(value)});
        if (sets?.reopened) return true;
        if (signal?.aborted || !same(value)) return false;
        const set = seriesUid ? sets.find(item => item.SeriesInstanceUID === seriesUid) : sets[0];
        if (!set) throw kinError("표시할 영상 시리즈가 없습니다.");
        // The cell's own exam goes into the cell; for a split original that is the cell's own part, told by its series
        // (KinExamScope.imagePlace) - the other part of the same original is another exam and goes beside it.
        const place = window.KinExamScope?.imagePlace?.(studies, value.studyUid, value.seriesUid) ?? value.studyUid;
        if (uid === place) return viewer.assign(value, [set.displaySetInstanceUID], { signal });
        return viewer.compare(value, [set.displaySetInstanceUID], { signal, studies });
      },
      // Several cells to other studies at once ([{ value, uid }]): each takes the series the account's Compare Series
      // rule ranks first against what it shows now. Every study loads before any cell changes; a failure, a cell that
      // changed meanwhile or a patient switch changes none.
      async replace(entries, { signal, studies } = {}) {
        if (!entries.length || entries.some(entry => !same(entry.value) || !studies?.some(row => row.uid === entry.uid))) return false;
        const plan = [];
        for (const entry of entries) {
          const sets = await loadStudy(entry.uid, entry.value, studies.find(row=>row.uid===entry.uid),{signal,valid:()=>!signal?.aborted&&entries.every(item=>same(item.value))});
          if (sets?.reopened) return true;
          if (signal?.aborted || entries.some(item => !same(item.value))) return false;
          if (!sets.length) throw kinError("표시할 영상 시리즈가 없습니다.");
          plan.push({ value: entry.value, displaySetInstanceUIDs: [sets[0].displaySetInstanceUID] });
        }
        return viewer.replace(plan, { signal, studies });
      },
      // Called on a patient tab change.
      subscribe: fn => viewer.subscribe(fn),
    };
    const unsubscribe = viewer.subscribe(close);
    return { open, openReport, openImages, closeReport, close, refresh, related,
      retryList() { if (origin && current()) return open(origin); },
      dispose() { disposed = true; stopDisplay?.(); stopShowing?.(); unsubscribe(); close(); } };
  }
  return { create };
})();
