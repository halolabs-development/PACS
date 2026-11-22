/* Explicit account restore must not overwrite a newer local checkbox choice. */
window.KinReadingPreferences = function ({ owner, host, read, apply, generation, endpoint, sessionEndpoint }) {
  // Product words through the page's screen language (worklist-language.js), or as written when it is not loaded.
  const kinWrite = (el, value, name) => { if (typeof window !== 'undefined' && window.KinLanguage) return window.KinLanguage.write(el, value, name); if (name) el.setAttribute(name, value); else el.textContent = value; return el; };
  const kinSay = (typeof window !== 'undefined' && window.KinLanguage && window.KinLanguage.say) || ((t, ...p) => t.replace(/\{(?:[ten]?(\d+)|([A-Za-z]\w*))\}/g, (m, i, n) => { const v = n !== undefined ? (p[0] || {})[n] : p[i]; return v === undefined ? m : String(v && typeof v === 'object' ? (v.t ?? v.e ?? '') : v); })), kinSayEn = (typeof window !== 'undefined' && window.KinLanguage && window.KinLanguage.sayEnglish) || kinSay;
  // A refusal keeps its sentence, so the line it is shown on follows a later choice of language too.
  const kinFail = sentence => Object.assign(new Error(String(sentence)), { sentence });
  const make = (tag, text, id) => { const el = document.createElement(tag); el.textContent = text; el.id = id; host.append(el); return el; };
  const load = make('button', 'Load Note Preferences', 'reading-prefs-load');
  const save = make('button', 'Save Note Preferences', 'reading-prefs-save');
  for (const b of [load, save]) { b.type = 'button'; b.className = 'chip'; }
  const status = make('span', '', 'reading-prefs-status'); status.setAttribute('role', 'status');
  let revision = null, busy = false, ended = false, request;
  const work = window.KinWorkContext, transport = window.KinSessionTransport.page();
  let interrupted = null;
  const refresh = () => { load.disabled = ended || busy || !owner; save.disabled = ended || busy || !owner || revision === null; };
  function end() { ended = true; revision = null; request?.abort(); refresh(); }
  const sessionEnd = () => { end(); kinWrite(status, kinSayEn("세션이 변경되었습니다. 다시 로그인하세요.")); };
  const unsubscribe = work.onInvalidate(event => {
    if (event.reason === 'lifecycle' && !['active', 'preparing'].includes(event.state)) sessionEnd();
    if (event.reason === 'cancel') {
      request = null; busy = false; refresh();
      const action = interrupted; interrupted = null;
      if (action) run(action === 'load' ? 'load' : 'inspect');
    }
  });
  window.addEventListener('pagehide', () => { end(); unsubscribe(); }, { once: true });
  async function run(action) {
    if (work.state() !== 'active' || ended || busy || !owner || action === 'save' && revision === null) return;
    const at = work.capture('document'); interrupted = action;
    const before = generation(), value = read(); busy = true; refresh();
    const local = request = new AbortController(); const timer = setTimeout(() => local.abort(), 10000);
    kinWrite(status, kinSayEn("메모 설정 확인 중…"));
    try {
      const response = await transport.request(endpoint, { context: at, method: action === 'save' ? 'PUT' : 'GET', credentials: 'same-origin', cache: 'no-store',
        signal: local.signal, headers: { 'Content-Type': 'application/json' },
        ...(action === 'save' ? { body: JSON.stringify({ expectedOwner: owner, revision, autoNote: value }) } : {}) });
      if (response.auth || !work.admits(at)) return;
      if (!response.ok || response.incomplete) { throw kinFail(kinSayEn(response.status === 409 ? '다른 창에서 설정이 바뀌었습니다. 불러온 뒤 다시 저장하세요.' : '설정 저장 여부를 확인하지 못했습니다. 불러와 확인하세요.')); }
      const data = response.body;
      if (ended) return;
      if (JSON.stringify(data?.owner) !== JSON.stringify(owner)) throw kinFail(kinSayEn('계정 설정 응답을 확인할 수 없습니다.'));
      if (!Number.isInteger(data.revision) || data.revision < 0 || data.revision > 2147483647 ||
          (data.revision === 0 ? data.autoNote !== null : typeof data.autoNote !== 'boolean')) throw kinFail(kinSayEn('계정 설정 응답을 확인할 수 없습니다.'));
      work.commit(at, () => {
      if (action !== 'save' && before !== generation()) { kinWrite(status, kinSayEn("현재 설정이 바뀌어 적용하지 않았습니다. 다시 불러오세요.")); return; }
      revision = data.revision;
      if (action === 'load' && data.autoNote !== null) { kinWrite(status, apply(data.autoNote) ? kinSayEn("계정의 메모 설정을 불러왔습니다.") : kinSayEn("현재 화면에는 적용하지 않았습니다. 계정 상태를 확인하세요.")); }
      else if (action === 'save') kinWrite(status, before === generation() ? kinSayEn("메모 설정을 계정에 저장했습니다.") : kinSayEn("요청 당시 설정을 저장했습니다. 이후 변경은 저장되지 않았습니다."));
      else kinWrite(status, data.autoNote === null ? kinSayEn("계정에 저장된 메모 설정이 없습니다.") : kinSayEn("계정 설정이 있습니다. 불러오기를 누르면 적용합니다."));
      });
    } catch (e) {
      work.commit(at, () => {
      if (!ended) { revision = null; kinWrite(status, e?.name === 'AbortError' || e instanceof TypeError ? kinSayEn('응답을 확인하지 못했습니다. 불러와 확인하세요.') : e.sentence ?? e.message); }
      });
    } finally {
      clearTimeout(timer);
      if (request === local) { request = null; busy = false; }
      work.commit(at, () => { interrupted = null; refresh(); });
    }
  }
  load.onclick = () => run('load'); save.onclick = () => run('save'); refresh();
  if (owner) run('inspect');
};
