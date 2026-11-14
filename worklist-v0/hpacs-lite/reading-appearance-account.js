/* Explicit account text restore preserves newer local appearance choices. */
window.KinReadingAppearanceAccount = function ({ owner, host, read, apply, generation, normalize, allowed, endpoint, sessionEndpoint }) {
  host.textContent='';
  const make = (tag, text, id) => { const el = document.createElement(tag); el.textContent = text; el.id = id; host.append(el); return el; };
  const load = make('button', 'Load Appearance', 'appearance-account-load');
  const save = make('button', 'Save Appearance to Account', 'appearance-account-save');
  for (const b of [load, save]) { b.type = 'button'; b.className = 'chip'; }
  const status = make('span', '', 'appearance-account-status'); status.setAttribute('role', 'status');
  let revision = null, busy = false, ended = false, request;
  const work = window.KinWorkContext, transport = window.KinSessionTransport.page();
  let interrupted = null;
  const refresh = () => { load.disabled = ended || busy || !owner || !allowed(); save.disabled = load.disabled || revision === null; };
  function end() { ended = true; revision = null; request?.abort(); refresh(); }
  const sessionEnd = () => { end(); status.textContent = '세션이 변경되었습니다. 다시 로그인하세요.'; };
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
    if (work.state() !== 'active' || ended || busy || !owner || !allowed() || action === 'save' && revision === null) return;
    const at = work.capture('document'); interrupted = action;
    const before = generation(), value = read(), language = window.KinLanguage?.generation(); busy = true; refresh();
    const local = request = new AbortController(); const timer = setTimeout(() => local.abort(), 10000);
    status.textContent = '표시 설정 확인 중…';
    try {
      const response = await transport.request(endpoint, { context: at, method: action === 'save' ? 'PUT' : 'GET', credentials: 'same-origin', cache: 'no-store',
        signal: local.signal, headers: { 'Content-Type': 'application/json' },
        ...(action === 'save' ? { body: JSON.stringify({ expectedOwner: owner, revision, sizes: value }) } : {}) });
      if (response.auth || !work.admits(at)) return;
      if (!response.ok || response.incomplete) { throw new Error(response.status === 409 ? '다른 창에서 설정이 바뀌었습니다. 불러온 뒤 다시 저장하세요.' : '설정 저장 여부를 확인하지 못했습니다. 불러와 확인하세요.'); }
      const data = response.body;
      if (!work.admits(at)) return;
      if (JSON.stringify(data?.owner) !== JSON.stringify(owner)) throw new Error('계정 설정 응답을 확인할 수 없습니다.');
      if (!Number.isInteger(data.revision) || data.revision < 0 || data.revision > 2147483647 ||
          (data.revision === 0 ? data.sizes !== null : !normalize(data.sizes))) throw new Error('계정 설정 응답을 확인할 수 없습니다.');
      work.commit(at, () => {
      // The screen language is the one account setting restored on its own when the page starts, unless a language was
      // chosen on this page since the request left (a size or colour change does not stop it).
      if (action === 'inspect' && data.sizes !== null && data.sizes.version >= 12 && window.KinLanguage?.generation() === language)
        window.KinLanguage.restore(normalize(data.sizes)?.language);
      if (action !== 'save' && before !== generation()) { status.textContent = '현재 설정이 바뀌어 적용하지 않았습니다. 다시 불러오세요.'; return; }
      revision = data.revision;
      if (action === 'load' && data.sizes !== null) {
        if(apply(data.sizes))status.textContent='계정의 표시 설정을 불러왔습니다.';
        else{revision=null;status.textContent='화면 설정을 적용하지 못했습니다. 영상 창 상태를 확인한 뒤 다시 불러오세요.';}
      }
      else if (action === 'save') status.textContent = before === generation() ? '표시 설정을 계정에 저장했습니다.' : '요청 당시 설정을 저장했습니다. 이후 변경은 저장되지 않았습니다.';
      else status.textContent = data.sizes === null ? '계정에 저장된 표시 설정이 없습니다.' : '계정 설정이 있습니다. 불러오기를 누르면 적용합니다.';
      });
    } catch (e) {
      work.commit(at, () => {
      if (!ended) { revision = null; status.textContent = e?.name === 'AbortError' || e instanceof TypeError ? '응답을 확인하지 못했습니다. 불러와 확인하세요.' : (e instanceof SyntaxError ? '계정 설정 응답 형식을 확인하지 못했습니다.' : e.message); }
      });
    } finally {
      clearTimeout(timer);
      if (request === local) { request = null; busy = false; }
      work.commit(at, () => { interrupted = null; refresh(); });
    }
  }
  load.onclick = () => run('load'); save.onclick = () => run('save'); refresh();
  /**
   * Save the screen language alone. Read the account row; change only the screens in patch (the others keep the
   * latest choice of the account) and, for a Revert, only if the account still holds expect; keep every other stored display
   * choice; write it back with the revision just read. A row in an older format keeps what that format holds and takes
   * the rest from this page; an account with no row starts from this page. Resolves
   * { ok, language, before } or { ok: false, message }; nothing on the screen changes here.
   */
  async function saveLanguage({ patch, expect } = {}) {
    const fail = message => ({ ok: false, message });
    const empty = { version: 1, worklist: null, reading: null };
    if (work.state() !== 'active' || ended || !owner || !allowed()) return fail('계정 설정을 저장할 수 없는 상태입니다. 다시 로그인한 뒤 시도하세요.');
    if (busy) return fail('다른 계정 설정 요청을 처리하는 중입니다. 잠시 뒤 다시 누르세요.');
    const at = work.capture('document'); busy = true; refresh();
    const local = request = new AbortController(); const timer = setTimeout(() => local.abort(), 10000);
    const call = async (method, body) => {
      const response = await transport.request(endpoint, { context: at, method, credentials: 'same-origin', cache: 'no-store', signal: local.signal,
        headers: { 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
      if (response.auth || !work.admits(at)) throw new Error('세션이 변경되었습니다. 다시 로그인하세요.');
      if (!response.ok || response.incomplete) throw new Error(response.status === 409 ? '다른 창에서 설정이 바뀌었습니다. 다시 누르세요.' : '설정 저장 여부를 확인하지 못했습니다. 다시 누르세요.');
      const data = response.body;
      if (JSON.stringify(data?.owner) !== JSON.stringify(owner) || !Number.isInteger(data.revision) || data.revision < 0 || data.revision > 2147483647 ||
          (data.revision === 0 ? data.sizes !== null : !normalize(data.sizes))) throw new Error('계정 설정 응답을 확인할 수 없습니다.');
      return data;
    };
    try {
      const current = await call('GET');
      const stored = current.sizes === null ? null : normalize(current.sizes);
      const before = stored?.language ?? empty;
      if (expect && JSON.stringify(before) !== JSON.stringify(expect)) return fail('다른 창에서 언어 설정이 바뀌어 되돌리지 않았습니다. Language에서 다시 고르세요.');
      const page = read();
      if (!(page.version >= 11)) return fail('이 화면의 표시 설정을 계정 형식으로 만들 수 없어 언어를 저장하지 못했습니다.');
      // What an older row already holds in the current format stays; the parts it lacks come from this page.
      const kept = !stored ? {} : { list: stored.list, current: stored.current, prior: stored.prior,
        ...(stored.version >= 2 ? { fonts: stored.fonts, colors: stored.colors } : {}), ...(stored.version >= 5 ? { dock: stored.dock } : {}),
        ...(stored.version >= 6 ? { toolbar: stored.toolbar } : {}), ...(stored.version >= 7 ? { mpr: stored.mpr } : {}),
        ...(stored.version >= 9 ? { viewer: stored.viewer } : {}), ...(stored.version >= 11 ? { markers: stored.markers } : {}) };
      const next = { ...before, ...(patch || {}), version: 1 };
      const saved = await call('PUT', { expectedOwner: owner, revision: current.revision, sizes: { ...page, ...kept, version: 12, language: next } });
      const language = normalize(saved.sizes)?.language ?? null;
      if (!language) return fail('계정 설정 응답을 확인할 수 없습니다.');
      if (!work.commit(at, () => { revision = saved.revision; })) return fail('세션이 변경되었습니다. 다시 로그인하세요.');
      return { ok: true, language, before };
    } catch (e) {
      return fail(e?.name === 'AbortError' || e instanceof TypeError ? '응답을 확인하지 못했습니다. 다시 누르세요.' : e?.message || '설정을 저장하지 못했습니다.');
    } finally {
      clearTimeout(timer);
      if (request === local) { request = null; busy = false; }
      refresh();
    }
  }
  window.KinLanguage?.connect({ save: saveLanguage });
  if (owner) run('inspect');
};
