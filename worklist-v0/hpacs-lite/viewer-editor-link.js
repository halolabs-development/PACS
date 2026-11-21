/* Read-only link to the reading workspace's unsaved report editor.
 * The viewer never stores, relays or persists the editor body: it is asked for
 * on every check, verified against one owner/session/target, and kept in memory. */
// The viewer write path (viewer-language.js): product words in the reader's screen language, or as written.
function kinText(t, ...p) { const l = typeof window === 'object' && window && window.KinLanguage; return l && l.text ? l.text(t, ...p) : t.replace(/\{[ten]?(\d+)\}/g, (m, i) => String(p[i])); }
function kinHtml(t, ...p) { const l = typeof window === 'object' && window && window.KinLanguage; return l && l.html ? l.html(t, ...p) : t.replace(/\{[ten]?(\d+)\}/g, (m, i) => String(p[i])); }
function kinError(t, ...p) { return Object.assign(new Error(kinText(t, ...p)), { kinWords: true }); }
(function (root) {
  'use strict';
  const FIELDS = ['findings', 'conclusion', 'recommendation'];
  const MAX = 200000;
  const REFUSALS = ['session', 'context', 'modal', 'unavailable', 'denied'];
  const REASONS = {
    session: kinText("판독 화면의 세션이 바뀌었습니다. 다시 연결하세요."),
    context: kinText("판독 화면의 편집 대상이 이 검사가 아닙니다."),
    modal: kinText("판독 화면의 대화상자를 닫은 뒤 다시 확인하세요."),
    unavailable: kinText("판독문 입력란을 확인할 수 없습니다."),
    denied: kinText("편집문 출력 권한이 없습니다."),
    invalid: kinText("편집문 응답을 확인할 수 없습니다."),
    timeout: kinText("판독 화면의 응답이 없습니다. 목록 창에서 영상 창을 다시 연결하세요."),
    missing: kinText("연결된 판독 화면이 없습니다. 판독 화면에서 연 영상 창에서만 편집문을 출력할 수 있습니다."),
  };
  function reasonText(reason) { return REASONS[reason] || REASONS.invalid; }
  const refusal = reason => ({ ok: false, reason });
  // Never throws: a malformed or foreign reply must close the choice, not the
  // dialog, and must never be mistaken for an answer about this study.
  function validReply(message, expected) {
    try {
      if (!message || typeof message !== 'object' || message.type !== 'kin-editor-reply') return refusal('invalid');
      if (!expected || typeof expected !== 'object') return refusal('invalid');
      if (typeof expected.request !== 'string' || typeof message.request !== 'string' ||
          message.request !== expected.request) return refusal('invalid');
      if (typeof expected.owner !== 'string' || typeof message.owner !== 'string' ||
          message.owner !== expected.owner) return refusal('invalid');
      if (!Array.isArray(expected.studies) || !Array.isArray(message.studies) ||
          message.studies.length !== expected.studies.length ||
          message.studies.some((uid, index) => uid !== expected.studies[index])) return refusal('invalid');
      if (typeof expected.activeUid !== 'string' || typeof message.activeUid !== 'string' ||
          message.activeUid !== expected.activeUid) return refusal('invalid');
      if (REFUSALS.includes(message.result)) return refusal(message.result);
      if (message.result !== 'ok') return refusal('invalid');
      if (typeof message.session !== 'string' || !message.session || message.session.length > MAX) return refusal('invalid');
      const body = message.editor;
      if (!body || typeof body !== 'object' || Array.isArray(body)) return refusal('invalid');
      const editor = {};
      for (const key of FIELDS) {
        const text = body[key];
        if (typeof text !== 'string' || text.length > MAX) return refusal('invalid');
        editor[key] = text;
      }
      if(expected.examStamp!==undefined && message.examStamp!==expected.examStamp)return refusal('context');
      return { ok: true, editor, session: message.session, ...(message.examStamp!==undefined?{examStamp:message.examStamp}:{}) };
    } catch (_) { return refusal('invalid'); }
  }
  const shape = value => value && typeof value === 'object' && !Array.isArray(value)
    ? [value.owner, value.uid, value.session, value.examStamp??null, FIELDS.map(key => value.editor ? value.editor[key] : undefined)] : null;
  function sameEditor(a, b) {
    const left = shape(a), right = shape(b);
    if (!left || !right) return false;
    return JSON.stringify(left) === JSON.stringify(right);
  }
  // The answer to a kin-editor-open (viewer-windows.js editorOpen): ok only when the reading screen selected
  // exactly this study for this login; a refusal carries the reason it gave and, when the reading screen told it, whether the
  // report target is this study all the same (`at`: a refusal can come after the move). Never throws.
  const OPEN_REFUSALS = ['session', 'unlisted', 'modal', 'busy', 'composing', 'saving', 'stale', 'unresolved', 'gone', 'unavailable'];
  const sameOpening = (message, expected) => !!expected && typeof expected === 'object' &&
    ['request', 'owner', 'uid'].every(key => typeof expected[key] === 'string' && typeof message[key] === 'string' && message[key] === expected[key]);
  const where = message => typeof message.at === 'boolean' ? { at: message.at } : {};
  function validOpened(message, expected) {
    try {
      if (!message || typeof message !== 'object' || message.type !== 'kin-editor-opened') return refusal('invalid');
      if (!sameOpening(message, expected)) return refusal('invalid');
      if (message.result === 'ok') return { ok: true };
      if (message.result === 'refused') return OPEN_REFUSALS.includes(message.reason) ? { ...refusal(message.reason), ...where(message) } : refusal('invalid');
      return refusal('invalid');
    } catch (_) { return refusal('invalid'); }
  }
  // The answer to a withdrawn opening (viewer-windows.js editorWithdrawn): { at } when the reading screen told where its report
  // target is, {} when it could not tell; null for anything that is not that answer to this request. Never throws.
  function validWithdrawn(message, expected) {
    try {
      if (!message || typeof message !== 'object' || message.type !== 'kin-editor-open-withdrawn' || !sameOpening(message, expected)) return null;
      return where(message);
    } catch (_) { return null; }
  }
  const api = { validReply, validOpened, validWithdrawn, sameEditor, reasonText, FIELDS, MAX, OPEN_REFUSALS };
  if (typeof module === 'object' && module.exports) module.exports = api; else root.kinViewerEditorLinkApi = api;
})(globalThis);
// The adapter is read-only: it asks one bound window for the current editor and
// answers with the exact body it received, or with the refusal reason.
globalThis.kinViewerEditorLink = function (options) {
  'use strict';
  const pure = globalThis.kinViewerEditorLinkApi;
  const settings = options || {};
  const view = settings.window || globalThis;
  const studies = Array.isArray(settings.studies) ? settings.studies.slice() : [];
  const owner = typeof settings.owner === 'function' ? settings.owner : () => null;
  const live = typeof settings.live === 'function' ? settings.live : () => false;
  const examStamp = settings.examScope ? globalThis.KinExamScope.readingStamp(settings.examScope,studies[0]) : undefined;
  const examMessage = examStamp === undefined ? {} : {examStamp};
  const target = 'target' in settings ? settings.target
    : (view.opener || (view.parent !== view ? view.parent : null));
  const origin = settings.origin || view.location?.origin;
  const timeoutMs = Number.isFinite(settings.timeoutMs) ? settings.timeoutMs : 2500;
  // A viewer window the list opened has no opener (viewer-launch.js detaches it), so it asks that list - whose document
  // holds the reading screen - over the list's own window-group channel, naming the list document that linked this window
  // (both in this window's address, viewer-windows.js linked()). It is read on every check, because a list can relink a
  // reused window; a request is bound to the link it was sent on.
  const Channel = settings.Channel || view.BroadcastChannel;
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  function windowLink() {
    if ('target' in settings || target) return null;
    try {
      const hash = new URLSearchParams(String(view.location?.hash || '').slice(1));
      const groups = hash.getAll('kin-window-group'), lists = hash.getAll('kin-window-list');
      if (groups.length !== 1 || lists.length !== 1 || !UUID.test(groups[0]) || !UUID.test(lists[0])) return null;
      return { group: groups[0], list: lists[0], key: groups[0] + ' ' + lists[0] };
    } catch (_) { return null; }
  }
  const pending = new Set();
  let disposed = false;
  function available() {
    if (disposed || !studies.length) return false;
    if (!target) {
      if (!windowLink() || typeof Channel !== 'function') return false;
      try { return !!live() && !!owner(); } catch (_) { return false; }
    }
    if (!origin) return false;
    try { return !target.closed && !!live() && !!owner(); } catch (_) { return false; }
  }
  function read(signal) {
    return new Promise((resolve, reject) => {
      let bound = null;
      try { const value = owner(); bound = value ? JSON.stringify(value) : null; } catch (_) { bound = null; }
      if (!available() || !bound) { resolve({ ok: false, reason: 'missing' }); return; }
      const work = view.KinWorkContext, context = work?.capture('document');
      const request = view.crypto.randomUUID();
      const expected = { request, owner: bound, studies: studies.slice(), activeUid: studies[0], ...examMessage };
      const entry = { cancel: null };
      // The window-group channel (a same-origin BroadcastChannel) when there is no bound window; closed with the request.
      // A relink of this window while the request waits cancels it, and the answer is read only under the same link.
      const name = target ? null : windowLink();
      let timer = null, link = null;
      function finish(value, error) {
        if (!pending.has(entry)) return;
        pending.delete(entry);
        if (timer !== null) clearTimeout(timer);
        if (link) { try { link.close(); } catch (_) {} link = null; }
        if (name) for (const type of ['hashchange', 'kin-window-link-changed']) view.removeEventListener(type, onRelink);
        view.removeEventListener('message', onMessage);
        signal?.removeEventListener('abort', onAbort);
        if (error) reject(error); else resolve(value);
      }
      function onAbort() { finish(null, kinError("출력 확인이 취소되었습니다.")); }
      function onRelink() { finish({ ok: false, reason: 'missing' }); }
      // Only the bound window of this same origin can answer; every other
      // message on this window is ignored rather than refused. On the channel,
      // only a reply naming this request is read.
      function onMessage(event) {
        if (!name && (event.origin !== origin || event.source !== target)) return;
        const data = event.data;
        if (!data || typeof data !== 'object' || data.type !== 'kin-editor-reply' || data.request !== request) return;
        // The request can outlive a tab switch or a closed/rebound workspace.
        // Recheck the existing document generation before accepting its body.
        if (!available() || context && !work.admits(context) || name && windowLink()?.key !== name.key) { finish({ ok: false, reason: 'missing' }); return; }
        let currentOwner = null;
        try { currentOwner = JSON.stringify(owner()); } catch (_) {}
        if (currentOwner !== bound) { finish({ ok: false, reason: 'session' }); return; }
        const checked = pure.validReply(data, expected);
        if (!checked.ok) { finish({ ok: false, reason: checked.reason }); return; }
        finish({ owner: expected.owner, uid: expected.activeUid, session: checked.session, editor: checked.editor, ...(checked.examStamp!==undefined?{examStamp:checked.examStamp}:{}) });
      }
      entry.cancel = () => finish({ ok: false, reason: 'missing' });
      pending.add(entry);
      if (name) {
        try { link = new Channel('kin-viewer-windows:' + name.group); link.onmessage = onMessage; }
        catch (_) { finish({ ok: false, reason: 'missing' }); return; }
        for (const type of ['hashchange', 'kin-window-link-changed']) view.addEventListener(type, onRelink);
      } else view.addEventListener('message', onMessage);
      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) { onAbort(); return; }
      timer = setTimeout(() => finish({ ok: false, reason: 'timeout' }), timeoutMs);
      try {
        const message = { type: 'kin-editor-request', request, owner: bound, studies: studies.slice(), activeUid: studies[0], ...examMessage };
        if (name) link.postMessage({ ...message, list: name.list }); else target.postMessage(message, origin);
      } catch (_) { finish({ ok: false, reason: 'missing' }); }
    });
  }
  // Asks the list document that linked this window to make this study the reading screen's report target and put the
  // caret in Findings (kin-editor-open). Only the window-group channel is used; a window without that link has no reading
  // screen to ask. The reading screen may first save the text it holds (its own study-move gate, up to 3 s), so this waits
  // longer than a read. No answer is never taken as a move.
  //
  // Where the report target ends up is told by the reading screen alone (`at`, viewer-windows.js): the answer says it, and a
  // request not answered in time is withdrawn and then asked once more - the reading screen drops the move if it has not
  // happened and answers where the target is (kin-editor-open-withdrawn), or a late answer to the opening arrives first. The
  // result is { ok: true } (moved and the caret in Findings), or { ok: false, reason, at? }: `at` true - the target is this
  // study all the same; false - it is not, and that request moves nothing any more; absent - not known (no answer, relinked,
  // disposed, another opening still under way there).
  const openTimeoutMs = Number.isFinite(settings.openTimeoutMs) ? settings.openTimeoutMs : 6000;
  const withdrawTimeoutMs = Number.isFinite(settings.withdrawTimeoutMs) ? settings.withdrawTimeoutMs : 4000;
  function open(uid) {
    return new Promise(resolve => {
      let bound = null;
      try { const value = owner(); bound = value ? JSON.stringify(value) : null; } catch (_) { bound = null; }
      const name = windowLink();
      let current = false; try { current = !!live(); } catch (_) { current = false; }
      if (disposed || target || !name || typeof Channel !== 'function' || !bound || !current || typeof uid !== 'string' || !uid) {
        resolve({ ok: false, reason: 'missing' }); return;
      }
      const work = view.KinWorkContext, context = work?.capture('document');
      const request = view.crypto.randomUUID();
      const expected = { request, owner: bound, uid };
      const entry = { cancel: null };
      let timer = null, link = null, withdrawn = false;
      function finish(value) {
        if (!pending.has(entry)) return;
        pending.delete(entry);
        if (timer !== null) clearTimeout(timer);
        if (link) { try { link.close(); } catch (_) {} link = null; }
        for (const type of ['hashchange', 'kin-window-link-changed']) view.removeEventListener(type, onRelink);
        resolve(value);
      }
      // An answer is read only while this window is still the one that asked: the same link, login and document generation.
      function asking() {
        if (windowLink()?.key !== name.key || context && !work.admits(context)) return false;
        try { return !!live() && JSON.stringify(owner()) === bound; } catch (_) { return false; }
      }
      // A relinked window stops waiting too: the request is withdrawn on the link it was sent on, then ended.
      function onRelink() { withdraw(); finish({ ok: false, reason: 'missing' }); }
      function onMessage(event) {
        const data = event.data;
        if (!data || typeof data !== 'object' || data.request !== request) return;
        const opened = data.type === 'kin-editor-opened';
        if (!opened && !(withdrawn && data.type === 'kin-editor-open-withdrawn')) return;
        if (!asking()) { withdraw(); finish({ ok: false, reason: 'missing' }); return; }
        if (opened) {
          const answer = pure.validOpened(data, expected);
          // A late refusal of a withdrawn request: it was not answered in time; where the target is, is what counts.
          finish(withdrawn && !answer.ok ? { ok: false, reason: 'timeout', ...('at' in answer ? { at: answer.at } : {}) } : answer);
          return;
        }
        const told = pure.validWithdrawn(data, expected);
        if (told) finish({ ok: false, reason: 'timeout', ...told });
      }
      // A request this window stops waiting for (no answer in time, relinked, disposed) is withdrawn, once: the reading screen
      // drops the move it asked for if that move has not happened yet (kin-editor-open-cancel), so a late move never follows.
      const withdraw = () => {
        if (withdrawn) return;
        withdrawn = true;
        try { link?.postMessage({ type: 'kin-editor-open-cancel', request, owner: bound, uid, list: name.list, ...examMessage }); } catch (_) {}
      };
      entry.cancel = () => { withdraw(); finish({ ok: false, reason: 'missing' }); };
      pending.add(entry);
      try { link = new Channel('kin-viewer-windows:' + name.group); link.onmessage = onMessage; }
      catch (_) { finish({ ok: false, reason: 'missing' }); return; }
      for (const type of ['hashchange', 'kin-window-link-changed']) view.addEventListener(type, onRelink);
      // No answer in time: withdrawn, and the reading screen's answer to that (or a late answer) is waited for a while more.
      timer = setTimeout(() => {
        withdraw();
        timer = setTimeout(() => finish({ ok: false, reason: 'timeout' }), withdrawTimeoutMs);
      }, openTimeoutMs);
      try { link.postMessage({ type: 'kin-editor-open', request, owner: bound, uid, list: name.list,
        ...examMessage }); }
      catch (_) { finish({ ok: false, reason: 'missing' }); }
    });
  }
  function dispose() { disposed = true; for (const entry of [...pending]) entry.cancel(); }
  return { available, read, open, dispose };
};
