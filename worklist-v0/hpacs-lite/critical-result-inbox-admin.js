(function () {
  'use strict';
  // Product words reach the screen through the screen-language write path (English only; otherwise as written).
  const kinSayEn = (t, ...p) => globalThis.KinLanguage?.sayEnglish ? globalThis.KinLanguage.sayEnglish(t, ...p)
    : t.replace(/\{(?:[ten]?(\d+)|([A-Za-z]\w*))\}/g, (m, i, n) => { const v = n !== undefined ? (p[0] || {})[n] : p[i]; return v === undefined ? m : String(v && typeof v === 'object' ? (v.t ?? v.e ?? '') : v); });
  const kinWrite = (el, value, name) => { if (globalThis.KinLanguage?.write) return globalThis.KinLanguage.write(el, value, name); if (!el) return el; const text = String(value ?? ''); if (name === 'title' || name === 'placeholder') el[name] = text; else if (name) el.setAttribute(name, text); else el.textContent = text; return el; };
  // Critical result hospital inbox: the administrator names the one member the hospital uses as its shared receiving point
  // for critical results (GET/PATCH /api/admin/critical-result-inbox). The Send Critical Result dialog checks that member
  // by default; a delivery to it is an ordinary record of that member. Like DICOM Peers, opening the page reads nothing:
  // Load Members (or arriving at #cr-inbox) reads the setting and the members who can hold it; Save sets or clears it and
  // shows the server's answer. The page owns termination (KinConsoleSession).
  const API = `${location.origin}/api`;
  const $ = selector => document.querySelector(selector);
  const ROLES = { clinician: 'Clinician', radiologist: 'Radiologist' };
  let enabled = false, pending = false, loaded = false, seq = 0;

  function message(text) {
    const box = $('#cr-inbox-message');
    kinWrite(box, typeof text === 'string' && text ? kinSayEn(text) : text || '');
    box.classList.toggle('show', !!text);
  }

  function controls(on) {
    $('#cr-inbox-refresh').disabled = !on;
    $('#cr-inbox-member').disabled = !on || !loaded;
    $('#cr-inbox-save').disabled = !on || !loaded;
  }

  async function request(method, body) {
    if (KinConsoleSession.ended()) throw new Error('세션이 종료되었습니다');
    const context = KinWorkContext.capture('document');
    const response = await KinSessionTransport.page().request(API + '/admin/critical-result-inbox', { method, json: body, context });
    if (!KinWorkContext.admits(context)) throw new Error('세션이 종료되었습니다');
    if (!response.ok || response.incomplete) throw Object.assign(new Error(`HTTP ${response.status}`),
      { status: response.status, said: typeof response.body?.message === 'string' ? response.body.message : '' });
    return response.body;
  }

  // The server's input checks are worded for this screen (400); other refusals get fixed sentences.
  function failure(error, what) {
    if (error?.status === 400 && error.said) return error.said;
    if (error?.status === 403) return kinSayEn("이 계정으로는 병원 공용 수신을 정할 수 없습니다.");
    return kinSayEn("{0} 결과를 확인하지 못했습니다. 지금 값을 다시 불러왔습니다.", what);
  }

  function render(body) {
    const members = Array.isArray(body?.members) ? body.members.filter(m => m && typeof m.sub === 'string') : [];
    const inbox = body?.inbox && typeof body.inbox.sub === 'string' ? body.inbox : null;
    const options = [new Option('None', '')];
    for (const m of members) {
      const option = new Option(`${m.name} (${m.actor}) · ${ROLES[m.role] || m.role}`, m.sub);
      option.setAttribute('translate', 'no');
      options.push(option);
    }
    const select = $('#cr-inbox-member');
    select.replaceChildren(...options);
    select.value = inbox && inbox.member ? inbox.sub : '';
    const chip = $('#cr-inbox-state');
    chip.className = `gstate ${inbox ? 'observed' : 'not_loaded'}`;
    chip.textContent = !inbox ? 'Not Set' : inbox.member ? 'Set' : 'Not Reachable';
    const current = $('#cr-inbox-current');
    if (!inbox) current.textContent = 'Current: Not Set';
    else if (!inbox.member) kinWrite(current, kinSayEn("Current: 지정한 회원이 지금 중요 결과를 받을 수 없습니다(정지·다른 기관·역할 변경). 다른 회원을 고르거나 None으로 해제하세요."));
    else {
      const name = document.createElement('span');
      name.setAttribute('translate', 'no');
      name.textContent = `${inbox.member.name} (${inbox.member.actor})`;
      current.replaceChildren('Current: ', name);
    }
    loaded = true;
  }

  async function load() {
    const mine = ++seq;
    const body = await request('GET');
    if (mine === seq && !KinConsoleSession.ended()) render(body);
  }

  async function run(work, what) {
    if (KinConsoleSession.ended() || pending || !enabled) return;
    pending = true;
    controls(false);
    message('');
    try { await work(); }
    catch (error) {
      if (KinConsoleSession.ended()) return;
      message(failure(error, what));
      // A lost or refused answer says nothing of what is stored now: read it again (never assume "not saved").
      if (error?.status !== 403) await load().catch(() => {});
    } finally {
      pending = false;
      if (!KinConsoleSession.ended() && enabled) controls(true);
    }
  }

  KinConsoleSession.onEnd(() => {
    enabled = false;
    loaded = false;
    controls(false);
    $('#cr-inbox-member').replaceChildren(new Option('None', ''));
    $('#cr-inbox-state').className = 'gstate not_loaded';
    $('#cr-inbox-state').textContent = 'Not Loaded';
    $('#cr-inbox-current').textContent = 'Current: Not Loaded';
    message('');
  });
  $('#cr-inbox-refresh').addEventListener('click', () => void run(() => load(), '조회'));
  $('#cr-inbox-form').addEventListener('submit', event => {
    event.preventDefault();
    if (!loaded) return;
    const sub = $('#cr-inbox-member').value || null;
    void run(async () => {
      const mine = ++seq;
      const body = await request('PATCH', { sub });
      if (mine !== seq || KinConsoleSession.ended()) return;
      render(body);
      message(sub ? '병원 공용 수신을 정했습니다. 판독의가 Send Critical Result 창을 새로 열면 이 회원이 미리 체크됩니다.'
        : '병원 공용 수신을 해제했습니다.');
    }, '저장');
  });
  // Enabled only for the administrator session the Members console accepts.
  KinAuth.init().then(session => {
    if (KinConsoleSession.ended() || session?.state !== 'approved' || session.demo || !KinAuth.has('admin')) return;
    enabled = true;
    controls(true);
    if (location.hash === '#cr-inbox') void run(() => load(), '조회');
  }).catch(() => {});
})();
