
// the original image a Physician-mode hand-off asks this document to open first (a key image or a cited line of the
// report): its study, series, SOP, frame and the saved item, as the server gave them to Clinician Home. Only the document
// that read the hand-off has it - a reload has none and opens as the viewer always does. From the hand-off until
// history.js has moved there or given up, the opening is held as a restore the address chose holds it (viewer-jobs.js
// holdOpening), so Auto Save View does not put a saved view over it.
let KIN_VIEWER_ENTRY_TARGET = null, KIN_VIEWER_ENTRY_HOLD = null;
function kinViewerEntryTarget(value) {
  const uid = s => typeof s === 'string' && s.length <= 64 && /^[0-9]+(?:\.[0-9]+)+$/.test(s);
  if (!value || typeof value !== 'object' || !uid(value.studyUid) || !uid(value.seriesUid) || !uid(value.sopUid) ||
      !Number.isSafeInteger(value.frame) || value.frame < 1 || !(value.itemId === undefined || typeof value.itemId === 'string' && /^[0-9a-f-]{36}$/.test(value.itemId))) return null;
  return Object.freeze({ studyUid: value.studyUid, seriesUid: value.seriesUid, sopUid: value.sopUid, frame: value.frame,
    ...(value.itemId ? { itemId: value.itemId } : {}) });
}
// The target is opened once in this document: the first panel that takes it has it, a later mode entry gets none.
function kinViewerEntryTake() {
  const target = KIN_VIEWER_ENTRY_TARGET; KIN_VIEWER_ENTRY_TARGET = null; return target;
}
function kinViewerEntryRelease() {
  const hold = KIN_VIEWER_ENTRY_HOLD, openings = window.kinViewerOpeningRestore; KIN_VIEWER_ENTRY_HOLD = null;
  if (hold && openings?.holds?.delete(hold)) {
    try { window.dispatchEvent(new CustomEvent('kin-viewer-opening-restore', { detail: { phase: 'end', hold } })); } catch (_) {}
  }
}
// Consume the opener-less handoff before loading any other script. Neither the address nor
// a later document's window.name retains the expected session; the boundary records it locally.
const KIN_VIEWER_EXPECTED_SESSION = (() => {
  const prefix = 'kin-viewer-entry:';
  if (!window.name?.startsWith(prefix)) return null;
  const raw = window.name.slice(prefix.length); window.name = '';
  try {
    const entry = JSON.parse(raw);
    window.name = typeof entry.name === 'string' ? entry.name : '';
    const expected = typeof entry.session === 'string' && entry.session ? entry.session : null;
    // B14: the screen that opened this window. Opened from Clinician Home (the Physician mode) it is read-only for every
    // account (kinViewerClinicianOnly); every hand-off says it again and a reload of this tab keeps the last one.
    try { sessionStorage.setItem('kin-viewer-mode', entry.mode === 'physician' ? 'physician' : ''); } catch (_) {}
    KIN_VIEWER_ENTRY_TARGET = entry.mode === 'physician' ? kinViewerEntryTarget(entry.target) : null;
    if (KIN_VIEWER_ENTRY_TARGET) {
      const openings = window.kinViewerOpeningRestore ||= { screen: 0, holds: new Set() };
      const hold = Object.freeze({ screen: openings.screen });
      try { window.dispatchEvent(new CustomEvent('kin-viewer-opening-restore', { detail: { phase: 'begin', hold } })); } catch (_) {}
      openings.holds.add(hold); openings.held = hold.screen; KIN_VIEWER_ENTRY_HOLD = hold;
      // A document that never draws its list (no answer at all) does not hold the view for ever.
      setTimeout(kinViewerEntryRelease, 60000);
    }
    // A fresh list action may reuse the named window and its URL. It starts a new
    // verification; a reload has no handoff and retains the previous entry instead.
    history.replaceState({ ...history.state, kinViewerSession: {
      session: null, ended: false, unresolved: true, expected, entryStopped: !expected,
    } }, '');
    return expected;
  } catch (_) { return null; }
})();

// The first extension sets the page defaults before shared modules and data sources start work.
function kinCreateSessionBoundary() {
  return { id: 'kin.session-boundary', async preRegistration({servicesManager} = {}) {
    kinExamViewerServices=servicesManager?.services;
    for (const name of ['work-context.js', 'session-transport.js', 'viewer-resources.js', 'viewer-preload.js', 'viewer-session.js']) {
      await new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = '/worklist/hpacs-lite/' + name;
        script.onload = resolve;
        script.onerror = () => reject(new Error('뷰어 세션 연결을 불러오지 못했습니다.'));
        document.head.append(script);
      });
    }
    const boundary = window.KinViewerSession.connect(window, KIN_VIEWER_EXPECTED_SESSION);
    // S7-U5 A006 (added): what this viewer holds unsaved, read from the guards its modules already keep for window
    // reuse and close - marks (kinViewerHistoryHasUnsaved), finding text (kinViewerFindingsState), Job / MIP edits
    // (kinViewerJobWorkspaceState), the Tech Note dialog (kinViewerTechNoteWorkspaceState). Log Out reads it before the real end
    // and asks only when something is there. A save still out counts as unsaved in each of these (the logout preparation
    // pauses this document, so its answer cannot arrive before the real end): marks count a busy entry, findings count a
    // pending/busy entry (set only by a save), Jobs count the kept request body from its build until the save is confirmed,
    // the note counts input that differs from its last confirmed version or a save whose result is not confirmed (dirty or
    // unknown). Their `busy` is not read here: for Jobs it is also a restore or a list read, for the note a note or history
    // read, which is not unsaved work. A guard that is missing or throws says nothing: unreadable is not unsaved.
    boundary.unsaved(() => {
      const kinds = [], holds = (kind, read) => { try { if (read() === true) kinds.push(kind); } catch (_) {} };
      holds('marks', () => window.kinViewerHistoryHasUnsaved?.());
      holds('findings', () => window.kinViewerFindingsState?.().dirty);
      holds('jobs', () => window.kinViewerJobWorkspaceState?.().dirty);
      holds('note', () => { const s = window.kinViewerTechNoteWorkspaceState?.(); return s?.dirty === true || s?.unknown === true; });
      return kinds;
    });
    boundary.onEnd(() => {
      kinViewerSession.refuse('logout');
      for (const extension of window.config.extensions) {
        try { extension?.onModeExit?.(); } catch (_) {}
      }
      for (const engine of window.cornerstone?.getRenderingEngines?.() || []) { try { engine.destroy(); } catch (_) {} }
      document.title = KIN_VIEWER_DEFAULT_TITLE;
      document.body.replaceChildren();
      try { if (window.frameElement) { window.frameElement.remove(); return; } } catch (_) {}
      try { window.close(); } catch (_) {}
      if (!window.closed) window.location.replace('/worklist/hpacs-lite/index.html');
    });
    await boundary.ready;
    window.dispatchEvent(new Event('kin-viewer-session-ready'));
    await boundary.wait();
    await kinPrepareExamViewer(location.href);
  } };
}

// Ordinary routes load no extra asset and make no scope request.
let kinExamViewerLoading,kinExamViewerServices;
async function kinPrepareExamViewer(href) {
  if (!new URL(href,location.origin).searchParams.has('kinExamScopes')) return null;
  if (!window.KinViewerExamScope) await (kinExamViewerLoading ||= (async () => {
    for (const [name,global] of [['exam-scope.js','KinExamScope'],['viewer-exam-scope.js','KinViewerExamScope']]) {
      if (window[global]) continue;
      await new Promise((resolve,reject)=>{
        const script=document.createElement('script');script.src='/worklist/hpacs-lite/'+name;
        script.onload=resolve;script.onerror=()=>reject(Error('검사 범위 도구를 불러오지 못했습니다.'));document.head.append(script);
      });
    }
  })().catch(error=>{kinExamViewerLoading=null;throw error;}));
  window.KinViewerExamScope.watch();
  window.KinViewerExamScope.install(kinExamViewerServices);
  return href===location.href ? window.KinViewerExamScope.ensure() : window.KinViewerExamScope.resolve(href);
}
window.kinPrepareExamViewer=kinPrepareExamViewer;

// A subscription follows the document gate, never a raw cross-document notice.
function kinViewerOnEnd(run) {
  let off = null, done = false;
  const end = () => { if (!done) { done = true; run(); } };
  const attach = () => {
    const gate = window.KinWorkContext;
    if (!gate) return;
    off = gate.onInvalidate(event => {
      if (event.reason === 'lifecycle' && !['active', 'preparing'].includes(event.state)) end();
    });
    if (!['active', 'preparing'].includes(gate.state())) end();
  };
  if (window.KinWorkContext) attach(); else window.addEventListener?.('kin-viewer-session-ready', attach, { once: true });
  return { close() { off?.(); window.removeEventListener?.('kin-viewer-session-ready', attach); } };
}
window.kinViewerOnEnd = kinViewerOnEnd;
