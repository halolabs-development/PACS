(function () {
  'use strict';
  // The page's write path (worklist-language.js): its own words read in English on an English screen and stay as written
  // otherwise; data and the server's words are written as they are.
  const kinSayEn = globalThis.KinLanguage?.sayEnglish || ((phrase, ...parts) =>
    phrase.replace(/\{[ten]?(\d+)\}/g, (slot, i) => parts[i] ?? slot));
  const kinWrite = globalThis.KinLanguage?.write || ((node, value, name) => {
    if (name) node.setAttribute(name, value); else node.textContent = value;
    return node;
  });
  // Patient Consent: the administrator loads one patient of this institution by the original Patient ID, reads that
  // patient's consent records, records a new one and withdraws one (POST /api/admin/patient-consent/lookup, POST
  // /api/admin/patient-consent, POST /api/admin/patient-consent/:id/withdraw). The patient ID goes in the body only.
  // What is drawn always belongs to the patient ID now in the box: editing the box clears it at once, and an answer for
  // another ID, another account or an older request is dropped. A record is never shown as saved without the server's
  // answer: a lost answer reads the patient again and offers the same request again. The page owns termination.
  const API = `${location.origin}/api/admin/patient-consent`;
  const $ = selector => document.querySelector(selector);
  const STATES = { active: 'Active', expired: 'Expired', withdrawn: 'Withdrawn' };
  let enabled = false, busy = false, seq = 0, current = null, retry = null, withdrawing = null;

  const box = () => $('#patient-consent-id');
  const owner = () => { const s = KinAuth.session(); return [s?.institution, s?.sub]; };
  const utc = value => typeof value === 'string' ? value.slice(0, 19).replace('T', ' ') : '';

  function message(text) {
    const el = $('#patient-consent-message');
    kinWrite(el, text || '');
    el.classList.toggle('show', !!text);
  }

  function controls() {
    const on = enabled && !KinConsoleSession.ended();
    box().disabled = !on || busy;
    $('#patient-consent-load').disabled = !on || busy;
    // While a save's result is unknown only Retry Same Request sends it: a new submit would be a second record.
    for (const el of $('#patient-consent-form').elements) el.disabled = !on || busy || !current || !!retry;
    $('#patient-consent-retry').hidden = !retry;
    $('#patient-consent-retry').disabled = !on || busy || !retry;
    for (const el of $('#patient-consent-withdraw').elements) el.disabled = !on || busy || !withdrawing;
    for (const button of document.querySelectorAll('#patient-consent-rows button')) button.disabled = !on || busy;
  }

  // Everything drawn for a patient goes; a pending answer for it is dropped by the sequence.
  function clear() {
    seq++;
    current = null; retry = null; withdrawing = null;
    $('#patient-consent-patient').hidden = true;
    $('#patient-consent-name').textContent = '';
    $('#patient-consent-pid').textContent = '';
    $('#patient-consent-rows').replaceChildren();
    $('#patient-consent-wrap').hidden = true;
    $('#patient-consent-empty').hidden = true;
    $('#patient-consent-form').hidden = true;
    $('#patient-consent-form').reset();
    $('#patient-consent-withdraw').hidden = true;
    $('#patient-consent-reason').value = '';
    const chip = $('#patient-consent-state');
    chip.className = 'astate not_loaded';
    chip.textContent = 'Not Loaded';
    controls();
  }

  async function request(path, body) {
    if (KinConsoleSession.ended()) throw new Error('세션이 종료되었습니다');
    const context = KinWorkContext.capture('document');
    const response = await KinSessionTransport.page().request(API + path, { method: 'POST', json: body, context, deadlineMs: 15000 });
    if (!KinWorkContext.admits(context) || KinConsoleSession.ended()) throw Object.assign(new Error('세션이 종료되었습니다'), { ended: true });
    if (!response.ok || response.incomplete) throw Object.assign(new Error(`HTTP ${response.status}`),
      { status: response.status, said: typeof response.body?.message === 'string' ? response.body.message : '' });
    return response.body;
  }

  function cell(text, data) {
    const td = document.createElement('td');
    td.textContent = text;
    if (data) td.setAttribute('translate', 'no');
    return td;
  }

  function render(patientId, body) {
    const patient = body?.patient, records = Array.isArray(body?.records) ? body.records : null;
    if (JSON.stringify(body?.owner) !== JSON.stringify(owner()) || patient?.patientId !== patientId || !records)
      throw new Error('answer');
    current = { patientId };
    $('#patient-consent-name').textContent = Array.isArray(patient.names) && patient.names.length ? patient.names.join(' / ') : '—';
    $('#patient-consent-pid').textContent = patientId;
    $('#patient-consent-patient').hidden = false;
    const rows = records.map(r => {
      const tr = document.createElement('tr');
      const action = document.createElement('td');
      if (r.state !== 'withdrawn') {
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = 'Withdraw';
        button.addEventListener('click', () => openWithdraw(r));
        action.append(button);
      }
      tr.append(cell(r.purpose ?? '', true), cell(r.reference ?? '', true), cell(utc(r.obtainedAt)), cell(r.expiresAt ? utc(r.expiresAt) : '—'),
        cell(STATES[r.state] || r.state), cell(`${r.recordedBy ?? ''} · ${utc(r.recordedAt)}`, true),
        cell(r.withdrawnAt ? `${r.withdrawnBy ?? ''} · ${utc(r.withdrawnAt)} · ${r.withdrawReason ?? ''}` : '—', true), action);
      return tr;
    });
    $('#patient-consent-rows').replaceChildren(...rows);
    $('#patient-consent-wrap').hidden = !rows.length;
    $('#patient-consent-empty').hidden = !!rows.length;
    $('#patient-consent-form').hidden = false;
    const chip = $('#patient-consent-state');
    chip.className = 'astate observed';
    chip.textContent = `${records.length} Records`;
  }

  // The server's input wording answers 400/404/409; other refusals and lost answers get fixed sentences.
  function failure(error, what) {
    if ([400, 404, 409].includes(error?.status) && error.said) return error.said;
    if (error?.status === 403) return kinSayEn('이 계정으로는 환자 동의 기록을 다룰 수 없습니다.');
    return kinSayEn('{0} 결과를 확인하지 못했습니다.', what);
  }

  // After a write: read the patient again. A refusal (the account lost this patient) leaves nothing of the patient drawn.
  async function reread(patientId) {
    try { await lookup(patientId); return ''; }
    catch (error) {
      if (error?.ended) throw error;
      if ([403, 404].includes(error?.status)) { clear(); return failure(error, kinSayEn('조회')); }
      return '';
    }
  }

  async function lookup(patientId) {
    const mine = ++seq;
    const body = await request('/lookup', { patientId });
    if (mine !== seq || box().value !== patientId) return;
    render(patientId, body);
  }

  async function run(work) {
    if (!enabled || busy || KinConsoleSession.ended()) return;
    busy = true; controls(); message('');
    try { await work(); }
    catch (error) { if (!error?.ended && !KinConsoleSession.ended()) message(error.message === 'answer' ? kinSayEn('불러온 기록을 확인하지 못했습니다.') : error.message); }
    finally { busy = false; controls(); }
  }

  function load(patientId) {
    return run(async () => {
      try { await lookup(patientId); }
      catch (error) {
        if (error?.ended) throw error;
        // A refusal or a failed read says nothing about this patient's records: nothing stays drawn.
        clear();
        throw new Error(error.message === 'answer' ? 'answer' : failure(error, kinSayEn('조회')));
      }
    });
  }

  function instant(value) {
    if (!value) return null;
    const d = new Date(value + 'Z');
    if (!Number.isFinite(d.getTime())) throw new Error(kinSayEn('UTC 시각을 확인하세요'));
    return d.toISOString();
  }

  async function send(body) {
    const patientId = body.patientId;
    let saved = false;
    try {
      await request('', body);
      saved = true;
    } catch (error) {
      if (error?.ended) throw error;
      if ([400, 409].includes(error?.status)) { retry = null; throw new Error(failure(error, kinSayEn('저장'))); }
      if ([403, 404].includes(error?.status)) { clear(); throw new Error(failure(error, kinSayEn('저장'))); }
      // Lost or delayed: whether it was written is unknown. Read the patient again; the same request can be sent again.
      retry = body;
      const refused = await reread(patientId);
      if (refused) throw new Error(refused);
      throw new Error(kinSayEn('저장되었는지 확인하지 못했습니다. 목록을 다시 확인하고, 없으면 Retry Same Request로 같은 요청을 다시 보내세요.'));
    }
    if (!saved) return;
    retry = null;
    $('#patient-consent-form').reset();
    const refused = await reread(patientId);
    if (refused) throw new Error(refused);
    if (current?.patientId === patientId) message(kinSayEn('동의 기록을 저장했습니다.'));
  }

  function openWithdraw(record) {
    if (!current || busy) return;
    withdrawing = { id: record.id, patientId: current.patientId };
    $('#patient-consent-withdraw-target').textContent = record.purpose ?? '';
    $('#patient-consent-reason').value = '';
    $('#patient-consent-withdraw').hidden = false;
    controls();
    $('#patient-consent-reason').focus();
  }

  KinConsoleSession.onEnd(() => { enabled = false; clear(); box().value = ''; message(''); });
  box().addEventListener('input', () => { if (current || retry || withdrawing || $('#patient-consent-state').textContent !== 'Not Loaded') { clear(); message(''); } });
  $('#patient-consent-lookup').addEventListener('submit', event => {
    event.preventDefault();
    const patientId = box().value;
    if (!patientId || patientId !== patientId.trim()) { message(kinSayEn('Original Patient ID를 앞뒤 공백 없이 입력하세요.')); return; }
    clear();
    void load(patientId);
  });
  $('#patient-consent-form').addEventListener('submit', event => {
    event.preventDefault();
    if (!current) return;
    const form = event.target;
    void run(async () => {
      const body = { patientId: current.patientId, purpose: form.elements.purpose.value, reference: form.elements.reference.value,
        obtainedAt: instant(form.elements.obtained.value), requestId: crypto.randomUUID() };
      const expires = instant(form.elements.expires.value);
      if (expires) body.expiresAt = expires;
      await send(body);
    });
  });
  $('#patient-consent-retry').addEventListener('click', () => {
    if (!retry || !current || retry.patientId !== current.patientId) return;
    const body = retry;
    void run(() => send(body));
  });
  $('#patient-consent-withdraw-cancel').addEventListener('click', () => {
    withdrawing = null; $('#patient-consent-withdraw').hidden = true; controls();
  });
  $('#patient-consent-withdraw').addEventListener('submit', event => {
    event.preventDefault();
    const target = withdrawing;
    if (!target || !current || target.patientId !== current.patientId) return;
    void run(async () => {
      const reason = $('#patient-consent-reason').value;
      try {
        await request('/' + encodeURIComponent(target.id) + '/withdraw', { patientId: target.patientId, reason });
      } catch (error) {
        if (error?.ended) throw error;
        if (error?.status === 400) throw new Error(failure(error, kinSayEn('철회')));
        // 403/404: this account can no longer reach the patient (or the record): nothing of the patient stays drawn.
        if ([403, 404].includes(error?.status)) { clear(); throw new Error(failure(error, kinSayEn('철회'))); }
        withdrawing = null;
        $('#patient-consent-withdraw').hidden = true;
        const refused = await reread(target.patientId);
        if (refused) throw new Error(refused);
        throw new Error(error?.status === 409 ? failure(error, kinSayEn('철회'))
          : kinSayEn('철회되었는지 확인하지 못했습니다. 다시 불러온 목록에서 상태를 확인하세요.'));
      }
      withdrawing = null;
      $('#patient-consent-withdraw').hidden = true;
      const refused = await reread(target.patientId);
      if (refused) throw new Error(refused);
      if (current?.patientId === target.patientId) message(kinSayEn('동의 기록을 철회했습니다.'));
    });
  });
  // Enabled only for the administrator session the Members console accepts.
  KinAuth.init().then(session => {
    if (KinConsoleSession.ended() || session?.state !== 'approved' || session.demo || !KinAuth.has('admin')) return;
    enabled = true;
    controls();
  }).catch(() => {});
})();
