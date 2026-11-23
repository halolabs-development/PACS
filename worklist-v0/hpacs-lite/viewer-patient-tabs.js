// The viewer write path (viewer-language.js): product words in the reader's screen language, or as written.
function kinText(t, ...p) { const l = typeof window === 'object' && window && window.KinLanguage; return l && l.text ? l.text(t, ...p) : t.replace(/\{[ten]?(\d+)\}/g, (m, i) => String(p[i])); }
function kinHtml(t, ...p) { const l = typeof window === 'object' && window && window.KinLanguage; return l && l.html ? l.html(t, ...p) : t.replace(/\{[ten]?(\d+)\}/g, (m, i) => String(p[i])); }
function kinError(t, ...p) { return Object.assign(new Error(kinText(t, ...p)), { kinWords: true }); }
window.KinViewerPatientTabs = (() => {
  // Document-local tabs survive the stock router's mode teardown. Clinical
  // controllers still enter/exit normally for each URL; no second grid exists.
  const tabs = [], listeners = new Set();
  let current = null, explicitlyClosed = false, session, services, refreshChrome, host, status, sequence = 0, pending = false, mounted = false;
  let controller, pendingHref, restoreSubscription, dataSubscription, displaySubscription, stopShowing, dataReady, mountEpoch = 0, focusAfterMount = false;
  // The saved view of the tab shown that is being put back now ({ tab, epoch }), until its cells are back (restore).
  let viewRestore = null;
  // A refused open (KinSessionTransport.openFailure 'denied'): no permission, or no such study for this account - one line
  // that names neither the study nor its patient. `refused` hides the image area (kin-viewer-empty) instead of a load that
  // never ends; it lasts until another study is shown.
  const DENIED = kinText("이 검사를 볼 수 있는 권한이 없습니다.");
  const FAILED_HERE = kinText("이 창에서 영상을 불러오지 못한 검사입니다. 목록에서 다시 여세요.");
  let refused = false, refusedHref = null, emptyNode = null, retryNode = null;
  const refusal = () => Object.assign(new Error(DENIED), { kinRefused: true });
  const text = value => typeof value === 'object' && value !== null
    ? String(value.Alphabetic || value.Ideographic || value.Phonetic || '') : String(value ?? '');
  const studies = href => (new URL(href, location.origin).searchParams.get('StudyInstanceUIDs') || '').split(',').filter(Boolean);
  const snapshot = () => current ? { key: current.patientKey || current.key, studyUIDs: [...current.studies], patient: { ...current.patient }, sequence,
    ...(current.exam ? {examScope:current.exam.current,exam:current.exam} : {}) } : null;
  const openingKey = href => {const url=new URL(href,location.origin);return JSON.stringify([studies(href),url.searchParams.get('kinExamScopes')]);};
  const publish = () => { const value = snapshot(); listeners.forEach(listener => listener(value)); };
  // The generation in which a move under way may go on (internal; `sequence` stays the opening generation its readers use).
  // Raised, before any wait, by every new choice of a tab - a tab click or arrow key (switchTo), a direct open (also of the tab
  // already shown, or from another window), Retry on the leave notice, Patient ▶ - and by what ends the moves under way: a
  // close (also of a tab not shown), end, and an exam scope found invalid. Never by mount, dispose or restore (a move's own
  // remount). Every step of a move (each wait, each opening, each request to the reading screen, the result) goes on only
  // while the generation it took still holds; one choice's later steps (switchTo -> gate -> open) carry the generation it took.
  const turn = { now: 0, take() { return ++this.now; }, holds(gen) { return gen === this.now; } };
  window.addEventListener?.('kin-exam-scope-invalidated', () => turn.take());
  function refresh() {
    const header = document.getElementById('kin-viewer-brand')?.closest('.bg-secondary-dark.z-20');
    if (host && header && host.parentElement !== header.parentElement) header.parentElement.prepend(host);
    restore();
  }
  function guard(coverage = false) {
    const states = [window.kinViewerHistoryWorkspaceState?.(), window.kinViewerJobWorkspaceState?.()];
    if (states.some(state => state?.busy || state?.dirty) || document.querySelector('dialog[open]') || window.kinMprMarks?.dirty?.()) {
      if (status) status.textContent = kinText("저장·편집을 마친 뒤 환자를 전환하세요. 현재 화면을 유지합니다.");
      return false;
    }
    return !coverage || window.kinViewerFrameCoverageConfirm?.(message => window.confirm(message)) === true;
  }
  // C-R01-139: leaving the tab of a study whose report text the reading screen has not had confirmed by the server is
  // leaving that study. Before a tab is left, this window asks every live reading screen of its own session
  // ('kin-report-unconfirmed', feature-mounts.js) to save the text of the tab's studies through its own study-move gate
  // (leaveStudyGate) and switches only when every one answered and none still holds such text or refused. Otherwise it
  // stays and says so, with Retry (save again), Check (ask again; nothing is written) and Stay (close the message).
  // There is no "leave anyway", as in the reading screen's own notice. A reading screen is live while it holds the Web
  // Lock `kin-report-reader:<session>:<document>` (the browser drops it when that page closes or crashes); one that does
  // not answer is never taken as saved. Opens the reading screen itself asks for (viewer-launch.js) passed its gate.
  const announced = new Map(), waits = new Map();
  let link = null, leaving = null;
  const LEAVE_WAIT_MS = 4000, CHECK_WAIT_MS = 1500, BUSY_SHOWN_MS = 250, READER = 'kin-report-reader:';
  function ownSession() {
    try {
      const gate = window.KinWorkContext;
      return gate && ['active', 'preparing'].includes(gate.state()) ? gate.session() || null : null;
    } catch (_) { return null; }
  }
  function reportLink() {
    if (link) return link;
    try { link = new BroadcastChannel('kin-report-unconfirmed'); link.unref?.(); } catch (_) { link = null; return null; }
    link.onmessage = event => {
      const m = event.data;
      if (!m || typeof m.id !== 'string' || typeof m.session !== 'string' || m.session !== ownSession()) return;
      if (m.type === 'gone') { announced.delete(m.id); return; }
      announced.set(m.id, m.session);
      const wait = m.type === 'answer' && typeof m.request === 'string' ? waits.get(m.request) : null;
      if (wait && wait.ids.has(m.id)) { wait.answers.set(m.id, m); if ([...wait.ids].every(id => wait.answers.has(id))) wait.finish(); }
    };
    const session = ownSession();
    if (session) link.postMessage({ type: 'hello', session });
    return link;
  }
  // The reading screens of this session that are open now: by their Web Locks, or (no lock manager) by their announcements.
  async function liveReaders(session) {
    const prefix = READER + session + ':';
    try {
      if (navigator.locks?.query) {
        const { held = [] } = await navigator.locks.query();
        return new Set(held.map(lock => lock.name).filter(name => typeof name === 'string' && name.startsWith(prefix))
          .map(name => name.slice(prefix.length)));
      }
    } catch (_) {}
    return new Set([...announced].filter(([, owner]) => owner === session).map(([id]) => id));
  }
  // Each live reading screen's answer for these studies; one that does not answer within `ms` is missing from the map.
  async function ask(type, uids, ms) {
    const session = ownSession(), channel = reportLink();
    if (!session || !channel) return { ids: new Set(), answers: new Map() };
    const ids = await liveReaders(session);
    if (!ids.size) return { ids, answers: new Map() };
    const request = Date.now().toString(36) + Math.random().toString(36).slice(2);
    return new Promise(resolve => {
      const wait = { ids, answers: new Map(), finish() { clearTimeout(timer); waits.delete(request); resolve(wait); } };
      const timer = setTimeout(() => wait.finish(), ms);
      waits.set(request, wait);
      try { channel.postMessage({ type, request, uids, session }); } catch (_) { wait.finish(); }
    });
  }
  const REASONS = { unknown: kinText("저장 결과를 확인하지 못했습니다"),
    conflict: kinText("서버의 초안이 판독 화면의 글과 다릅니다. 판독 화면에서 Keep This Text 또는 Load Server Draft를 고르세요"),
    composing: kinText("판독 화면의 글자 조합(한글 입력)이 끝나지 않았습니다"), stale: kinText("판독 화면의 검사나 작업이 바뀌었습니다"),
    held: kinText("판독 화면에 아직 저장이 확인되지 않은 글이 있습니다") };
  // Why the tab is kept: null only when every live reading screen answered, none refused and none holds the tab's text.
  function kept({ ids, answers }) {
    if ([...ids].some(id => !answers.has(id))) return kinText("판독 화면의 응답이 없습니다");
    for (const m of answers.values()) {
      const result = m.result;
      // 'discarded': the reading screen threw the study's draft away at the Mammo Keypad's Discard & Move.
      if (result && !['clear', 'saved', 'discarded'].includes(result.status))
        return result.reason || REASONS[result.status] || kinText("서버가 저장을 받지 않았습니다");
      if (!Array.isArray(m.held) || m.held.length) return REASONS.held;
    }
    return null;
  }
  // An answer tells the moment it was given. Before moving on a clear one, the reading screens are read once more
  // (nothing is written): text typed while that answer was on its way keeps this tab.
  async function settled(tab, first) {
    const reason = kept(first);
    return reason === null ? kept(await ask('check', tab.studies, CHECK_WAIT_MS)) : reason;
  }
  // Resolves true when the current tab may be left now; otherwise the message is shown and this window stays.
  async function leave() {
    const tab = current;
    if (!tab) { endLeave(); return true; }
    if (leaving?.busy) return false;
    const notice = leaving = { tab, go: leaving?.tab === tab ? leaving.go : null, busy: 'save', reason: '', shown: !!leaving?.shown };
    // An ordinary switch is answered at once; the saving line shows only when the reading screen's save takes time.
    const shown = setTimeout(() => { if (leaving === notice) { notice.shown = true; renderLeave(); } }, BUSY_SHOWN_MS);
    const reason = await settled(tab, await ask('save', tab.studies, LEAVE_WAIT_MS));
    clearTimeout(shown);
    if (leaving !== notice || current !== tab) return false;
    if (reason === null) { endLeave(); return true; }
    Object.assign(notice, { busy: null, reason, shown: true }); renderLeave();
    return false;
  }
  // The gate (leave: save, or Check on the notice) is answered once for every choice that waited on it. `waiting` is the latest
  // of them - a tab click, a close, Retry or Check - with its generation; `carry` is the only place that answer is applied: passed,
  // the latest choice is carried out (`go(gen)`, without passing the gate again - the answer just given is its gate); not passed,
  // the notice keeps it for Retry / Check. Only while that choice's generation holds: a newer choice that did not wait on the
  // gate (a direct open, Patient ▶, end ...) ends it.
  let waiting = null;
  function carry(passed) {
    const latest = waiting; waiting = null;
    if (!latest || !turn.holds(latest.gen)) return false;
    if (passed) return latest.go(latest.gen);
    if (leaving) leaving.go = latest.go;
    return false;
  }
  async function gated(go, gen) {
    waiting = { go, gen };
    const passed = await leave();
    // The gate was already being answered for an earlier choice: that answer carries this one out.
    if (!passed && leaving?.busy) return false;
    return carry(passed);
  }
  // Retry / Check on the leave notice is the reader choosing that move again: a new generation.
  async function resume(kind) {
    const notice = leaving;
    if (!notice || notice.busy || current !== notice.tab || !notice.go) return;
    const gen = turn.take();
    if (kind === 'save') { await gated(notice.go, gen); return; }
    waiting = { go: notice.go, gen };
    notice.busy = 'check'; renderLeave();
    const reason = await settled(notice.tab, await ask('check', notice.tab.studies, CHECK_WAIT_MS));
    if (leaving !== notice || current !== notice.tab) return;
    if (reason === null) { endLeave(); carry(true); return; }
    Object.assign(notice, { busy: null, reason }); renderLeave(); carry(false);
  }
  function endLeave() { leaving = null; renderLeave(); }
  function renderLeave() {
    const box = host?.querySelector('.kin-patient-leave');
    if (!box) return;
    if (leaving && leaving.tab !== current) leaving = null;
    const notice = leaving?.shown ? leaving : null;
    box.hidden = !notice; box.replaceChildren();
    if (!notice) return;
    const name = notice.tab.patient.name, strong = document.createElement('b');
    strong.textContent = '● ' + (notice.busy ? 'Saving' : 'Save Not Confirmed');
    box.append(strong, notice.busy ? kinText(" — {0}의 판독문 저장을 판독 화면에서 확인하는 중입니다. 환자를 아직 바꾸지 않았습니다.", name)
      : kinText(" — {0}의 판독문 저장이 확인되지 않아 환자를 바꾸지 않았습니다 ({1}). 쓰던 글은 판독 화면에 그대로 있습니다.", name, notice.reason));
    for (const [label, title, action] of [
      ['Retry', kinText("판독 화면에서 쓰던 글을 다시 저장하고, 저장되면 이동합니다"), () => resume('save')],
      ['Check', kinText("판독 화면의 저장 상태를 다시 확인하고(저장하지 않습니다), 확인되면 이동합니다"), () => resume('check')],
      ['Stay', kinText("이 환자에 머뭅니다 (안내만 닫습니다)"), () => { endLeave(); host?.querySelector('[aria-selected=true]')?.focus(); }]]) {
      const control = document.createElement('button'); control.type = 'button'; control.textContent = label; control.title = title;
      control.disabled = !!notice.busy && label !== 'Stay'; control.onclick = action; box.append(control);
    }
  }
  // A tab click or arrow key is a new choice from the moment it is made, before the gate waits.
  async function switchTo(tab) {
    const gen = turn.take();
    return tab === current ? open(tab.href, { gen }) : gated(chosen => open(tab.href, { gen: chosen }), gen);
  }

  // ── Mammo Keypad: Patient ▶ (viewer-features-mg.js) ──
  // The open tabs in order, the current one marked.
  function list() {
    return tabs.map(tab => ({ key: tab.key, studies: [...tab.studies], patient: { ...tab.patient }, current: tab === current }));
  }
  // Whether the reading screens hold text of the current tab's studies that the server has not confirmed (nothing is
  // written): the reason the tab would be kept, or null.
  async function unsaved() {
    const tab = current;
    if (!tab) return null;
    const reason = kept(await ask('check', tab.studies, CHECK_WAIT_MS));
    return current === tab ? reason : kinText("환자가 그 사이 바뀌었습니다");
  }
  // The tab's images are drawn: at least one cell shows an image, every cell that shows one shows one of the tab's
  // studies, and each such cell has rendered it.
  function imagesOf(tab) {
    try {
      let drawn = 0;
      for (const id of services.viewportGridService.getState().viewports.keys()) {
        const v = services.cornerstoneViewportService.getCornerstoneViewport(id), image = v?.getCurrentImageId?.();
        if (!image) continue;
        if (!tab.studies.includes(window.cornerstone?.metaData?.get('instance', image)?.StudyInstanceUID)) return false;
        if (v.viewportStatus !== undefined && v.viewportStatus !== 'rendered') return false;
        drawn++;
      }
      return drawn > 0;
    } catch (_) { return false; }
  }
  // The images of a tab are on screen: the tab is current, its mount has read the patient, no switch is under way and its
  // images are drawn. A move's wait (`holds`, its generation) ends as soon as a newer choice is made.
  function shown(tab, ms = 20000, holds = () => true) {
    return new Promise(resolve => {
      const started = Date.now();
      const look = () => {
        if (!holds() || current !== tab) { resolve(false); return; }
        if (mounted && !pending && !document.body.classList.contains('kin-patient-switching') && location.href === tab.href && imagesOf(tab)) { resolve(true); return; }
        if (Date.now() - started > ms) { resolve(false); return; }
        setTimeout(look, 50);
      };
      look();
    });
  }
  const OPEN_WAIT_MS = 6000;
  const reading = () => { try { return !!session && !session.ended() && !session.readOnly?.() && !!session.owner(); } catch (_) { return false; } };
  const editorLink = uid => window.kinViewerEditorLink?.({ studies: [uid], examScope:[current?.exam?.current,current?.exam?.prior].find(scope=>scope?.reportUid===uid), owner: () => session.owner(), live: reading, openTimeoutMs: OPEN_WAIT_MS }) || null;
  const STALE = { ok: false, reason: 'stale', tabChanged: true };
  // Makes the linked reading screen's report target this study (its own move: viewer-windows.js editorOpen → select), while
  // the move's generation `holds`: when a newer choice is made, the request is withdrawn (the reading screen drops the move if
  // it has not happened) and the result is `tabChanged`, with where the target is only if that was already told.
  async function target(uid, holds) {
    if (!holds()) return STALE;
    const link = editorLink(uid);
    if (!link) return { ok: false, reason: 'missing' };
    const watch = setInterval(() => { if (!holds()) link.dispose(); }, 100);
    try {
      const result = await link.open(uid);
      return holds() ? result : { ...STALE, ...(result?.ok === true ? { at: true } : typeof result?.at === 'boolean' ? { at: result.at } : {}) };
    } catch (_) { return holds() ? { ok: false, reason: 'unavailable' } : STALE; }
    finally { clearInterval(watch); link.dispose(); }
  }
  // Where the reading screen's report target is after a request (viewer-editor-link.js open): that study (moved, even when
  // the caret could not be put in Findings), not that study, or unknown (null).
  const reached = result => result?.ok === true || result?.at === true ? true : result?.at === false ? false : null;
  // Back to a study: a reading screen still finishing the opening it was asked for (and told to drop) answers busy for a
  // while; it is asked again, a few times, before the result is taken - never once the move's generation no longer `holds`.
  async function targetBack(uid, holds) {
    let result = null;
    for (let attempt = 0; attempt < 6; attempt++) {
      result = await target(uid, holds);
      if (result?.reason !== 'busy') return result;
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    return result;
  }
  const NOT_OPENED = { missing: kinText("연결된 판독 화면이 없습니다"), timeout: kinText("판독 화면의 응답이 없습니다"), session: kinText("판독 화면의 세션이 다릅니다"),
    unlisted: kinText("판독 화면의 목록에 그 검사가 없습니다"), modal: kinText("판독 화면에 대화상자가 열려 있습니다"), busy: kinText("판독 화면이 다른 작업 중입니다"),
    composing: kinText("판독 화면에서 글자 조합 중입니다"), saving: kinText("판독 화면의 글 저장이 확인되지 않았습니다"), stale: kinText("판독 화면의 선택이 그 사이 바뀌었습니다"),
    unresolved: kinText("그 검사의 환자 식별을 확인할 수 없습니다"), gone: kinText("그 검사가 목록에서 빠졌습니다"), unavailable: kinText("판독 화면에서 그 검사를 열 수 없습니다") };
  const notOpened = result => NOT_OPENED[result?.reason] || NOT_OPENED.unavailable;
  let moving = null;
  // Patient ▶: the reading screens save ('save') or discard ('discard', the study's whole draft) the text of the current
  // tab's studies and answer; only when every live one answered, none refused and none still holds such text, the next tab
  // (after the last, the first) opens, and once its images are shown the linked reading screen is asked to make its first
  // study the report target. The outcome is where the reading screen says its report target is (`reached`): there - the move
  // is done, also when the answer came late; not there, or not known (no answer to the request nor to its withdrawal) - the
  // images go back to the tab left and the reading screen is asked back to that study, so the images and the report are of
  // one patient again, and the message says only what was told; when even that is not confirmed, the result says so. A window
  // with no linked reading screen moves only its images. A press while a move is under way does nothing. Resolves { ok, message }.
  // Patient ▶ is a new choice (a generation of its own, taken at the press): every step below - after the save answers, each
  // opening and wait for images, the request to the reading screen, each ask back, the result - goes on only while it holds.
  // A newer choice made meanwhile (another tab, the same tab again, a close, end, an invalid exam scope) is kept as made: the
  // request is withdrawn, nothing more opens or goes back, and no success is claimed.
  async function next(intent) {
    if (moving) return { ok: false, busy: true, message: kinText("환자를 옮기는 중입니다.") };
    const from = current, at = tabs.indexOf(from), to = at < 0 || tabs.length < 2 ? null : tabs[(at + 1) % tabs.length];
    if (!from || !to) return { ok: false, message: kinText("열린 다른 환자가 없습니다.") };
    if (!['save', 'discard'].includes(intent)) return { ok: false, message: kinText("옮기는 방법을 알 수 없습니다.") };
    const ticket = moving = {}, gen = turn.take(), holds = () => turn.holds(gen);
    const say = message => { if (status) status.textContent = message; return message; };
    // A newer choice before the reading screen was asked: nothing of this move is left to say about the report target.
    const superseded = { ok: false, message: kinText("환자가 그 사이 바뀌었습니다.") };
    try {
      if (!guard()) return { ok: false, message: status?.textContent || kinText("지금은 환자를 옮길 수 없습니다.") };
      // A reading screen linked when the move starts is the report target to move; losing it later is not "no link".
      const probe = editorLink((to.exam?.reportUid || to.studies[0])), linked = !!probe?.available(); probe?.dispose();
      const reason = await settled(from, await ask(intent, from.studies, LEAVE_WAIT_MS));
      if (!holds()) return superseded;
      if (reason !== null) return { ok: false, message: say(kinText("{0}의 판독문 {1}이 확인되지 않아 환자를 옮기지 않았습니다 ({2}).", from.patient.name, intent === 'save' ? kinText("저장") : kinText("버리기"), reason)) };
      if (!await open(to.href, { gen })) {
        if (!holds()) return superseded;
        return { ok: false, message: say(kinText("{0}의 영상을 열지 못했습니다. {1}", to.patient.name, current === from ? kinText("지금 환자에 머뭅니다.") : '').trim()) };
      }
      // The report target is asked to move only once the next patient's images are drawn; when they are not, the images go
      // back to the patient left (the report target was not asked).
      if (!await shown(to, 20000, holds)) {
        if (!holds()) return superseded;
        const back = current === to ? await open(from.href, { gen }) && await shown(from, 20000, holds) : current === from && await shown(from, 20000, holds);
        if (!holds()) return superseded;
        return { ok: false, message: say(back ? kinText("{0}의 영상이 표시되지 않아 {1}에게 되돌렸습니다.", to.patient.name, from.patient.name)
          : kinText("{0}의 영상이 표시되지 않았고 되돌리기도 확인되지 않았습니다. 영상은 {1}입니다.", to.patient.name, current?.patient.name || kinText("없음"))) };
      }
      if (!linked) return { ok: true, imagesOnly: true, message: say(kinText("{0}의 영상으로 옮겼습니다. 연결된 판독 화면이 없어 영상만 옮겼습니다.", to.patient.name)) };
      const toUid = to.exam?.reportUid || to.studies[0], fromUid = from.exam?.reportUid || from.studies[0];
      const moved = await target(toUid, holds), there = reached(moved);
      if (moved?.tabChanged) return { ok: false, message: say(kinText("영상 탭이 그 사이 바뀌어 더 옮기지 않았습니다. {0}", (there === true ? kinText("판독 화면의 대상은 {0}의 검사입니다.", to.patient.name) : kinText("판독 화면의 대상을 확인하세요.")))) };
      // The reading screen's report target is the next patient's study (also when it answered late, or refused only after
      // moving): images and report target are together.
      if (there === true) return { ok: true, reportTarget: toUid, message: say(kinText("{0}의 영상과 판독 대상으로 옮겼습니다.", to.patient.name)) };
      // Not there (told), or not known: back to the patient left, images and report target both, each confirmed. Only what
      // the reading screen told is said; an unknown outcome is said to be unknown. The way back is this move's own step.
      const why = notOpened(moved);
      const imagesBack = await open(from.href, { gen }) && await shown(from, 20000, holds);
      const back = imagesBack && holds() ? await targetBack(fromUid, holds) : imagesBack ? STALE : null, reportBack = reached(back);
      // A newer choice while going back stops it, and is not undone.
      if (back?.tabChanged || !holds()) return { ok: false, mismatch: true, message: say(kinText("영상 탭이 그 사이 바뀌어 더 되돌리지 않았습니다. {0}", (reportBack === true ? kinText("판독 화면의 대상은 {0}의 검사입니다.", from.patient.name) : kinText("판독 화면의 대상을 확인하세요.")))) };
      const what = there === false ? kinText("판독 화면의 대상이 {0}의 검사로 바뀌지 않아({1})", to.patient.name, why)
        : kinText("판독 화면이 {0}의 검사를 열었는지 확인하지 못해({1})", to.patient.name, why);
      if (imagesBack && reportBack === true)
        return { ok: false, reportTarget: fromUid, message: say(kinText("{0} {1} {2}에게 되돌렸습니다.", what, there === false ? kinText("영상도") : kinText("영상과 판독 대상을"), from.patient.name)) };
      return { ok: false, mismatch: true, message: say(kinText("{0} 되돌리기도 확인되지 않았습니다. 영상은 {1}입니다. 판독 화면의 대상을 확인하세요.", (there === false ? kinText("판독 화면의 대상이 {0}의 검사로 바뀌지 않았고({1})", to.patient.name, why)
        : kinText("판독 화면이 {0}의 검사를 열었는지 확인하지 못했고({1})", to.patient.name, why)), current?.patient.name || kinText("없음"))) };
    } finally { if (moving === ticket) moving = null; }
  }
  function capture() {
    if (!current) return;
    const state = services.viewportGridService.getState(), cells = [...state.viewports.values()];
    // Restore the supported regular stack grid, including its image/camera.
    // Other native modes reopen through their normal mode/HP initialization.
    if (state.layout.layoutType !== 'grid' || cells.length !== state.layout.numRows * state.layout.numCols) { current.view = null; return; }
    const views = cells.map(cell => {
      const v = services.cornerstoneViewportService.getCornerstoneViewport(cell.viewportId);
      const sets = (cell.displaySetInstanceUIDs || []).map(id => services.displaySetService.getDisplaySetByUID(id));
      if (sets.length && (v?.type !== 'stack' || sets.length !== 1)) return null;
      return { series: sets[0]?.SeriesInstanceUID, study: sets[0]?.StudyInstanceUID,
        image: v?.getCurrentImageId?.(), index: v?.getCurrentImageIdIndex?.(),
        size: v?.canvas && [v.canvas.width, v.canvas.height],
        camera: structuredClone(v?.getCamera?.()), presentation: structuredClone(v?.getViewPresentation?.({ pan: true, zoom: true })), properties: structuredClone(v?.getProperties?.()) };
    });
    current.view = views.every(Boolean) ? { rows: state.layout.numRows, cols: state.layout.numCols,
      active: cells.findIndex(cell => cell.viewportId === state.activeViewportId), cells: views } : null;
  }
  function restore() {
    const tab = current, saved = tab?.view;
    if (!saved || !tab.restorePending) return;
    // Let the stock route finish creating its first viewport before replacing
    // its initial layout; display-set events arrive before that layout exists.
    const started = [...services.viewportGridService.getState().viewports.keys()].some(id => {
      const rendered = window.KinViewerInfoBar.identity(services, id).instance;
      return rendered && tab.studies.includes(rendered.StudyInstanceUID) &&
        dataReady?.has(id);
    });
    if (!started) return;
    const sets = services.displaySetService.getActiveDisplaySets();
    const matches = saved.cells.map(cell => {
      if (!cell.series) return [];
      const same = sets.filter(set => set.StudyInstanceUID === cell.study && set.SeriesInstanceUID === cell.series);
      // A series the viewer split into several display sets returns to the one holding the image this cell showed.
      return same.length > 1 ? same.filter(set => !!cell.image && set.images?.some(image => image?.imageId === cell.image)) : same;
    });
    if (matches.some((match, i) => saved.cells[i].series && match.length !== 1)) return;
    tab.restorePending = false;
    const ids = saved.cells.map(() => 'kin-tab-' + crypto.randomUUID());
    const epoch = mountEpoch, restored = new Set(), ready = new Set();
    // Until each saved cell has its image, frame and camera back, this tab's view is still being put back (settling).
    const run = viewRestore = { tab, epoch };
    const done = () => { if (viewRestore === run) viewRestore = null; };
    const onImage = async () => {
      if (current !== tab || epoch !== mountEpoch || !mounted) { done(); return; }
      for (let index = 0; index < ids.length; index++) {
        if (restored.has(index)) continue;
        const cell = saved.cells[index], v = services.cornerstoneViewportService.getCornerstoneViewport(ids[index]);
        if (!cell.image) { restored.add(index); continue; }
        if (!ready.has(ids[index])) continue;
        const imageIndex = v?.getImageIds?.().indexOf(cell.image);
        if (imageIndex == null || imageIndex < 0 || !v.getCurrentImageId?.()) continue;
        restored.add(index);
        // The pinned setter does not retarget the next wheel/arrow step.
        clearTimeout(v.debouncedTimeout);
        v.targetImageIdIndex = imageIndex;
        if (v.getCurrentImageId() !== cell.image) await v.setImageIdIndex(imageIndex);
        await new Promise(requestAnimationFrame);
        if (current !== tab || epoch !== mountEpoch || !mounted) { done(); return; }
        // Complete the info/series chrome before fitting the recreated canvas.
        // Loading headings have a different height from the real patient label.
        refreshChrome();
        if (cell.properties) v.setProperties(cell.properties);
        if (cell.camera) v.setCamera({ flipHorizontal: cell.camera.flipHorizontal, flipVertical: cell.camera.flipVertical });
        if (cell.size?.[0] === v.canvas.width && cell.size?.[1] === v.canvas.height) {
          const { flipHorizontal, flipVertical, ...camera } = cell.camera;
          v.setCamera(camera);
        } else if (cell.presentation) v.setViewPresentation(cell.presentation);
        v.render();
      }
      if (restored.size === ids.length) { subscription.unsubscribe(); done(); }
    };
    restoreSubscription?.();
    // As in the existing stack restore adapter, native viewport data is the
    // readiness boundary. Its first image event precedes native presentation
    // restoration; applying a camera there is subsequently overwritten.
    const subscription = services.cornerstoneViewportService.subscribe(
      services.cornerstoneViewportService.EVENTS.VIEWPORT_DATA_CHANGED, ({ viewportId }) => {
        if (!ids.includes(viewportId)) return;
        ready.add(viewportId);
        queueMicrotask(() => onImage().catch(error => { if (mounted && epoch === mountEpoch) status.textContent = error.message; }));
      });
    restoreSubscription = () => subscription.unsubscribe();
    services.viewportGridService.setLayout({ numRows: saved.rows, numCols: saved.cols, activeViewportId: ids[saved.active],
      isHangingProtocolLayout: false, findOrCreateViewport: index => ({ displaySetInstanceUIDs: matches[index].map(set => set.displaySetInstanceUID),
        displaySetOptions: [{}], viewportOptions: { viewportId: ids[index], viewportType: 'stack', toolGroupId: 'default', allowUnmatchedView: true,
          presentationIds: { positionPresentationId: ids[index], lutPresentationId: ids[index] },
          ...(saved.cells[index].image ? { initialImageOptions: { index: saved.cells[index].index, useOnce: true } } : {}) } }) });
    // Cells that showed no image have nothing to wait for.
    if (saved.cells.every(cell => !cell.image)) done();
  }
  function render() {
    if (!host) return;
    const list = host.querySelector('[role=tablist]'); list.replaceChildren();
    for (const tab of tabs) {
      const row = document.createElement('div'); row.className = 'kin-patient-tab';
      const button = document.createElement('button'); button.type = 'button'; button.setAttribute('role', 'tab');
      button.setAttribute('aria-selected', String(tab === current)); button.tabIndex = tab === current ? 0 : -1;
      const p = tab.patient; button.textContent = [p.name, p.id, p.age, p.sex].join(' | ');
      button.onclick = () => switchTo(tab);
      button.onkeydown = event => {
        const index = tabs.indexOf(tab);
        const next = event.key === 'ArrowRight' ? tabs[(index + 1) % tabs.length] : event.key === 'ArrowLeft' ? tabs[(index + tabs.length - 1) % tabs.length] : event.key === 'Home' ? tabs[0] : event.key === 'End' ? tabs.at(-1) : null;
        if (next) { event.preventDefault(); focusAfterMount = next !== current; switchTo(next).then(ok => {
          if (ok) host?.querySelector('[aria-selected=true]')?.focus(); else focusAfterMount = false;
        }); }
        if (event.key === 'Delete') { event.preventDefault(); focusAfterMount = tabs.length > 1; close(tab).then(ok => {
          if (ok) host?.querySelector('[aria-selected=true]')?.focus(); else focusAfterMount = false;
        }); }
      };
      const remove = document.createElement('button'); remove.type = 'button'; remove.textContent = '×';
      remove.setAttribute('aria-label', 'Close ' + p.name + ' ' + p.id); remove.onclick = () => close(tab);
      row.append(button, remove); list.append(row);
    }
    if (emptyNode) emptyNode.textContent = refused && !current ? DENIED : kinText("No Patient — 목록에서 검사를 여세요.");
    document.body.classList.toggle('kin-viewer-empty', (explicitlyClosed || refused) && !current && !pending);
    // The refusal screen is up: its one line is all that shows (series-recovery.js takes back its image line and notices).
    const screen = refused && !current && !pending, before = document.body.classList.contains('kin-open-refused');
    document.body.classList.toggle('kin-open-refused', screen);
    let line = document.getElementById?.('kin-viewer-refused');
    if (screen && !line) {
      line = document.createElement('p'); line.id = 'kin-viewer-refused'; line.setAttribute('role', 'alert'); line.textContent = DENIED;
      document.body.append(line);
    } else if (!screen) line?.remove();
    if (screen && !before) window.dispatchEvent(new CustomEvent('kin-viewer-open-refused'));
    renderLeave();
  }
  // The tab, the rendered cells, and restored comparison cells share the opening's single read.
  async function resolve(href, signal, extra = [], valid = () => true) {
    const display = window.kinViewerStudyDisplay, openingRole = session.state();
    const release = display?.hold([...new Set([...studies(href), ...extra])]);
    try {
      const exam = await window.kinPrepareExamViewer?.(href);
      const wanted = exam?.studyUids || studies(href);
      if (!valid() || openingRole !== 'unconfirmed' && openingRole !== session.state()) throw kinError("로그인 상태가 바뀌었습니다.");
      const requested = [...new Set([...wanted, ...extra])];
      let result;
      if (display) result = await display.lookup(requested, { signal, role: session, valid });
      else {
        if (session.state() === 'unconfirmed') await session.decide();
        const role = session.state(), studies = [], unlistedUids = new Set(wanted);
        const current = () => valid() && !signal?.aborted && role === session.state() && !session.ended?.();
        for (let offset = 0; offset < wanted.length; offset += 100) {
          const endpoint = session.readOnly() ? '/api/clinician/studies' : '/api/studies';
          const response = await fetch(endpoint + '?' + new URLSearchParams({ uids: wanted.slice(offset, offset + 100).join(',') }),
            { credentials: 'same-origin', signal });
          if (!current()) throw kinError("로그인 상태가 바뀌었습니다.");
          if (!response.ok) throw new Error(kinText("환자 정보를 불러오지 못했습니다. 영상은 계속 볼 수 있습니다. 다시 시도하세요."), { cause: response });
          for (const row of (await response.json()).studies) {
            studies.push(row);
            unlistedUids.delete(row.uid);
            for (const source of row.sourceMetadata || []) unlistedUids.delete(source.uid);
          }
        }
        result = { studies, unlistedUids, current };
      }
      // Only the current exam's absence from the authorized selection refuses the open.
      // A missing prior or an unconfirmed display identity keeps the ordinary tab failure below.
      const opened = exam?.current?.sources?.map(source => source.studyUid).filter(uid => wanted.includes(uid));
      if (result.current() && (opened?.length ? opened : wanted.slice(0, 1)).some(uid => result.unlistedUids.has(uid))) throw refusal();
      const entries = result.studies;
      const keyFor = uid => {
        const keys = new Set(entries.filter(row => row.uid === uid || row.displaySources?.some(s => s.studyUid === uid) ||
          row.sourceMetadata?.some(s => s.uid === uid)).map(row => row.sourcePatientKey));
        return keys.size === 1 ? [...keys][0] : null;
      };
      const key = keyFor(wanted[0]), reportUid = exam?.reportUid || wanted[0];
      if (!result.current() || !key || wanted.some(uid => keyFor(uid) !== key))
        throw kinError("같은 환자의 검사인지 확인할 수 없어 현재 화면을 유지합니다.");
      const row = entries.find(item => item.uid === reportUid) || entries[0];
      const value = display ? display.row(reportUid, key) : row;
      const patient = patientOf(value);
      if (!display) {
        const born = text(row.birth).replace(/-/g, ''), date = text(row.date).replace(/-/g, '');
        const age = /^\d{8}$/.test(born) && /^\d{8}$/.test(date) ? Math.floor((Number(date) - Number(born)) / 10000) : -1;
        if (age >= 0) patient.age = age + 'Y';
      }
      return { key: key + (exam ? '|' + JSON.stringify([exam.key, exam.prior && window.KinExamScope.key(exam.prior)]) : ''),
        href: new URL(href, location.origin).href, studies: wanted, patientKey: key, ...(exam ? { exam } : {}),
        patient, admitted: result.current };
    } catch (error) {
      if (error.cause && window.KinSessionTransport?.openFailure?.(error.cause) === 'denied') throw refusal();
      throw error;
    } finally { release?.(); }
  }
  const patientOf = shown => ({ name: text(shown?.name) || 'Unknown', id: text(shown?.id) || 'Unknown',
    age: text(shown?.age) || 'Unknown', sex: text(shown?.sex) || 'Unknown' });
  function renamed() {
    let changed = false;
    for (const tab of tabs) {
      const next = patientOf(window.kinViewerStudyDisplay.row(tab.exam?.reportUid || tab.studies[0], tab.patientKey));
      if (Object.keys(next).some(field => next[field] !== tab.patient[field])) { tab.patient = next; changed = true; }
    }
    // Navigation subscribers tear down open reports. Changing a label leaves that navigation intact.
    if (changed) render();
  }
  function shownStudies() {
    if (explicitlyClosed && !current) return [];
    const uids = [...(current?.studies || studies(location.href))];
    for (const cell of services.viewportGridService?.getState()?.viewports?.values() || [])
      for (const id of cell.displaySetInstanceUIDs || []) {
        const uid = services.displaySetService?.getDisplaySetByUID?.(id)?.StudyInstanceUID;
        if (uid) uids.push(uid);
      }
    return uids;
  }
  function navigate(tab, opening) {
    // The tab's new opening is taken before its scope is exposed, so every read it starts names that opening.
    opening.commit();
    window.KinViewerExamScope?.activate(tab.href,tab.exam);
    tab.restorePending = !!tab.view;
    current = tab; explicitlyClosed = false; refused = false; refusedHref = null; pending = false; render(); publish();
    if (location.href === tab.href) { restore(); return; }
    // The pinned BrowserRouter consumes the native popstate event. Its route
    // lifecycle tears down study-scoped extensions before new pixels mount.
    document.body.classList.add('kin-patient-switching');
    // Tabs own their navigation; avoid adding browser-back entries that could
    // bypass the existing unsaved-work guard.
    history.replaceState(history.state, '', tab.href);
    window.dispatchEvent(new PopStateEvent('popstate', { state: history.state }));
  }
  // A direct open (another window, the worklist, the tab already shown) is a new choice; a switch, close or move passes the
  // generation of the choice it carries out (`gen`). The screen changes only while that generation holds.
  async function open(href, { signal, gen = turn.take() } = {}) {
    const holds = () => turn.holds(gen);
    if (signal?.aborted) return false;
    const url = new URL(href, location.origin);
    if (url.origin !== location.origin || url.pathname !== '/ohif/viewer') return false;
    if (current && openingKey(href) === openingKey(current.href)) {
      // Opened again (from the list, another window): every study this viewer has asked about is read again, so a Match or
      // Unmatch since shows - also in cells added after the opening. Another opening reads its own studies in its lookup.
      window.kinViewerStudyDisplay?.refreshAll();
      if (current.exam) try { await window.KinViewerExamScope.resolve(href,{signal}); } catch (error) { status.textContent=error.message;return false; }
      if (!holds()) return false;
      if (pending) { sequence++; controller?.abort(); pending = false; render(); publish(); }
      return true;
    }
    // OHIF keeps a failed image read of a study for this document's life: moving to it here would show nothing. The
    // worklist opens it in a new document (viewer-launch.js failedInViewer).
    let failedHere = false;
    try { failedHere = studies(url.href).some(uid => window.kinViewerFailedStudies?.().includes(uid)); } catch (_) {}
    if (failedHere) { status.textContent = FAILED_HERE; return false; }
    if (!guard()) return false;
    const ticket = ++sequence; controller?.abort(); controller = new AbortController(); pending = true; pendingHref = url.href;
    // A caller can close or replace its composition while patient resolution is pending.
    // Cancel only that admission; a newer patient request owns its own controller and sequence.
    const cancel = () => {
      if (ticket !== sequence) return;
      sequence++; controller.abort(); pending = false; render(); publish();
    };
    signal?.addEventListener('abort', cancel, { once: true });
    try {
      const returning = tabs.find(tab => openingKey(tab.href) === openingKey(href));
      const extra = returning?.view?.cells.map(cell => cell.study).filter(Boolean) || [];
      const resolved = await resolve(url.href, controller.signal, extra, () => holds() && ticket === sequence);
      if (returning && returning.patientKey !== resolved.patientKey) throw kinError("검사의 원본 환자가 바뀌었습니다. 현재 화면을 유지합니다.");
      if (signal?.aborted || ticket !== sequence || !holds() || !guard(true)) return false;
      // Showing these studies is a new opening of each (opening contract 2026-10-29). One this document showed before is
      // read live for it first, so its 열람 is recorded before pixels still held here can show; when it cannot be, the
      // current screen stays. A same-scope Open returned above and keeps its opening.
      const opening = await (window.KinViewerSessionBoundary?.reenter(resolved.studies, controller.signal) ?? { commit() {} });
      if (signal?.aborted || ticket !== sequence || !holds()) return false;
      if (!resolved.admitted()) return false;
      if (!opening) { status.textContent = kinText("영상 열람 기록을 저장하지 못해 환자를 전환하지 않았습니다. 다시 시도하세요."); return false; }
      capture();
      let tab = tabs.find(tab => tab.key === resolved.key);
      if (!tab) { tab = resolved; tabs.push(tab); }
      else if (openingKey(tab.href) !== openingKey(resolved.href)) {
        // A patient can have several examinations. Preserve the tab identity,
        // but never restore the previous examination over the requested one.
        Object.assign(tab, resolved, { view: null });
      }
      navigate(tab, opening); return true;
    } catch (error) { if (ticket === sequence && error.name !== 'AbortError') status.textContent = error.message; return false; }
    finally {
      signal?.removeEventListener('abort', cancel);
      // A refused lookup/confirmation/opening still advanced the generation.
      // Consumers must adopt the retained tab once this admission has ended.
      if (ticket === sequence && pending) { pending = false; render(); publish(); }
    }
  }
  // A close (also of a tab not shown) ends the moves under way; its reentry after the gate carries its generation.
  async function close(tab, left = false, gen = turn.take()) {
    // Closing a tab also cancels a lookup started by selecting that tab, so
    // its delayed response cannot reopen it after the user's close action.
    if (pending && pendingHref === tab.href) { sequence++; controller?.abort(); pending = false; }
    if (tab === current) {
      if (!guard()) return false;
      if (!left) return gated(chosen => close(tab, true, chosen), gen);
      if (!turn.holds(gen) || tab !== current || !tabs.includes(tab)) return false;
      const next = tabs[tabs.indexOf(tab) + 1] || tabs[tabs.indexOf(tab) - 1];
      if (next && !await open(next.href, { gen })) return false;
      if (!next && !guard(true)) return false;
      if (!next) { sequence++; controller?.abort(); current = null; explicitlyClosed = true; window.KinViewerSessionBoundary?.leave?.(); publish(); }
    }
    tabs.splice(tabs.indexOf(tab), 1); render(); return true;
  }
  async function mount(options) {
    services = options.services; session = options.session; refreshChrome = options.refreshChrome; mounted = true; const epoch = ++mountEpoch;
    dataReady = new Set();
    stopShowing?.(); stopShowing = window.kinViewerStudyDisplay?.showing(shownStudies);
    displaySubscription?.(); displaySubscription = window.kinViewerStudyDisplay?.subscribe(renamed) || null;
    dataSubscription = services.cornerstoneViewportService.subscribe(
      services.cornerstoneViewportService.EVENTS.VIEWPORT_DATA_CHANGED, ({ viewportId }) => {
        dataReady.add(viewportId);
        // getViewportData is assigned before setStack completes. Replacing its
        // viewport then leaves the pending image callback with a dead renderer.
        queueMicrotask(() => { if (mounted && epoch === mountEpoch) restore(); });
      });
    host = document.createElement('section'); host.className = 'kin-patient-tabs'; host.dataset.kinUxOwned = '';
    const list = document.createElement('div'); list.setAttribute('role', 'tablist'); list.setAttribute('aria-label', 'Patients');
    status = document.createElement('span'); status.setAttribute('role', 'status');
    const empty = document.createElement('p'); empty.className = 'kin-patient-empty'; empty.textContent = kinText("No Patient — 목록에서 검사를 여세요.");
    const retry = document.createElement('button'); retry.type = 'button'; retry.textContent = 'Retry Patient'; retry.hidden = true;
    // An image list refused before this mount (series-recovery.js) still holds for this route.
    emptyNode = empty; retryNode = retry; refused = refusedHref === location.href;
    const leaveBox = document.createElement('div'); leaveBox.className = 'kin-patient-leave'; leaveBox.setAttribute('role', 'alert'); leaveBox.hidden = true;
    host.append(list, status, leaveBox, retry, empty); refresh(); reportLink();
    window.kinViewerOpenPatient = open;
    async function loadPatient() {
      const ticket = sequence;
      retry.hidden = true;
      try {
      const resolved = current?.href === location.href ? current : await resolve(location.href, undefined, shownStudies(),
        () => mounted && epoch === mountEpoch && ticket === sequence);
      if (!mounted || epoch !== mountEpoch || ticket !== sequence || resolved !== current && !resolved.admitted()) return;
      // Its images were refused while the lookup was on its way: the refusal stands, no tab names the study.
      if (refused) { render(); document.body.classList.remove('kin-patient-switching'); return; }
      let tab = tabs.find(tab => tab.key === resolved.key);
      if (!tab) { tab = resolved; tabs.push(tab); }
      current = tab; explicitlyClosed = false; refused = false; status.textContent = ''; render(); publish(); restore();
      if (focusAfterMount) { host.querySelector('[aria-selected=true]')?.focus(); focusAfterMount = false; }
      document.body.classList.remove('kin-patient-switching');
      } catch (error) {
        // A refusal (this lookup's, or the image list's that came first) stands: no Retry over it.
        if (mounted && epoch === mountEpoch && ticket === sequence && (error?.kinRefused || refused)) { imagesRefused(); return; }
        if (mounted && epoch === mountEpoch && ticket === sequence) {
          render(); status.textContent = error.message; retry.hidden = false;
          document.body.classList.remove('kin-patient-switching');
        }
      }
    }
    retry.onclick = loadPatient;
    await loadPatient();
  }
  // This document's study cannot be shown to this account (the lookup above, or its image list refused - series-recovery.js):
  // stop showing a load, say so in one line, and offer no Retry (asking again gets the same answer).
  function imagesRefused() {
    // Before this route's tabs mount: the mount shows it; until then the image line says why (false).
    refusedHref = location.href;
    if (!mounted) return false;
    const shownTab = tabs.find(tab => openingKey(tab.href) === openingKey(location.href));
    if (shownTab) tabs.splice(tabs.indexOf(shownTab), 1);
    refused = true; current = null; pending = false;
    if (status) status.textContent = '';
    if (retryNode) retryNode.hidden = true;
    render(); publish();
    document.body.classList.remove('kin-patient-switching');
    return true;
  }
  function dispose() {
    mounted = false; mountEpoch++; stopShowing?.(); stopShowing = null; displaySubscription?.(); displaySubscription = null; dataSubscription?.unsubscribe(); dataSubscription = null; dataReady = null; restoreSubscription?.(); restoreSubscription = null; host?.remove(); host = null;
    viewRestore = null;
  }
  // The shown tab's saved view (its grid, and each cell's image, frame and camera) is still to be put back or is being
  // put back: a layout change by another module meanwhile would be built over by it or would break it (viewer-display-span.js waits).
  const settling = () => !!mounted && !!current && (!!current.view && !!current.restorePending || viewRestore?.tab === current && viewRestore.epoch === mountEpoch);
  return { mount, dispose, refresh, open, guard, snapshot, resolve, list, unsaved, next, imagesRefused, moving: () => !!moving, pending: () => pending, settling,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    end() { turn.take(); sequence++; controller?.abort(); tabs.length = 0; current = null; explicitlyClosed = false; focusAfterMount = false; publish(); dispose(); delete window.kinViewerOpenPatient;
      leaving = null; announced.clear(); for (const wait of [...waits.values()]) wait.finish(); link?.close(); link = null; } };
})();
