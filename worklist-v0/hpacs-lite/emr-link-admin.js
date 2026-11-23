(function () {
  'use strict';
  // Product words reach the screen through the screen-language write path (English only; otherwise as written).
  const kinSayEn = (t, ...p) => globalThis.KinLanguage?.sayEnglish ? globalThis.KinLanguage.sayEnglish(t, ...p)
    : t.replace(/\{(?:[ten]?(\d+)|([A-Za-z]\w*))\}/g, (m, i, n) => { const v = n !== undefined ? (p[0] || {})[n] : p[i]; return v === undefined ? m : String(v && typeof v === 'object' ? (v.t ?? v.e ?? '') : v); });
  // Product words reach the screen through the screen-language write path (English only; otherwise as written).
  const kinWrite = (el, value, name) => { if (globalThis.KinLanguage?.write) return globalThis.KinLanguage.write(el, value, name); if (!el) return el; const text = String(value ?? ''); if (name === 'title' || name === 'placeholder') el[name] = text; else if (name) el.setAttribute(name, text); else el.textContent = text; return el; };
  // FA-090 EMR Link: the administrator sets or clears the own institution's EMR address template (PATCH /api/admin/emr-link).
  // The current value comes with the session (/api/me emrLink) and then from each save's answer. The example below the
  // field fills the template with sample values through the same builder the worklist's Open EMR uses (emr-link.js).
  // The page owns termination (KinConsoleSession).
  const API = `${location.origin}/api`;
  const $ = selector => document.querySelector(selector);
  const SAMPLE = Object.freeze({ patientId: 'P0001234', accession: 'A20261111001', studyUid: '1.2.410.200001.1.1' });
  let current = null, pending = false, enabled = false;

  function message(text) {
    const box = $('#emr-link-message');
    kinWrite(box, typeof text === 'string' && text ? kinSayEn(text) : text || '');
    box.classList.toggle('show', !!text);
  }

  function controls(on) {
    for (const id of ['#emr-link-template', '#emr-link-save', '#emr-link-clear']) $(id).disabled = !on;
    if (on) $('#emr-link-clear').disabled = !current;
  }

  function show(value) {
    current = value;
    const chip = $('#emr-link-state');
    chip.className = `gstate ${current ? 'observed' : 'not_loaded'}`;
    chip.textContent = current ? 'Set' : 'Not Set';
    $('#emr-link-current').textContent = `Current: ${current || 'Not Set'}`;
    $('#emr-link-template').value = current || '';
    preview();
  }

  function preview() {
    const text = $('#emr-link-template').value.trim();
    if (!text) { $('#emr-link-preview').textContent = ''; return; }
    const built = KinEmrLink.build(text, SAMPLE);
    kinWrite($('#emr-link-preview'), built.error ? kinSayEn(String(built.error))
      : `Example (${SAMPLE.patientId} · ${SAMPLE.accession} · ${SAMPLE.studyUid}): ${built.url}`);
  }

  async function save(template) {
    if (KinConsoleSession.ended() || pending || !enabled) return;
    pending = true;
    controls(false);
    message('');
    try {
      const context = KinWorkContext.capture('document');
      const response = await KinSessionTransport.page().request(API + '/admin/emr-link',
        { method: 'PATCH', json: { template }, context });
      if (KinConsoleSession.ended() || !KinWorkContext.admits(context)) return;
      if (!response.ok || response.incomplete) {
        // The server's two checks are worded for this screen; any other refusal gets a fixed sentence.
        const said = response.status === 400 && typeof response.body?.message === 'string' ? response.body.message : '';
        message(said || (response.status === 403 ? '이 계정으로는 EMR 주소를 설정할 수 없습니다.'
          : 'EMR 주소 저장 결과를 확인하지 못했습니다. 페이지를 다시 열어 지금 값을 확인하세요.'));
        return;
      }
      const saved = typeof response.body?.emrLink?.template === 'string' ? response.body.emrLink.template : null;
      show(saved);
      message(saved ? 'EMR 주소를 저장했습니다. 워크리스트는 다시 열면 새 주소를 씁니다.'
        : 'EMR 주소를 해제했습니다. 워크리스트의 Open EMR은 다시 열면 회색이 됩니다.');
    } catch (error) {
      if (!KinConsoleSession.ended()) message('EMR 주소 저장 결과를 확인하지 못했습니다. 페이지를 다시 열어 지금 값을 확인하세요.');
    } finally {
      pending = false;
      if (!KinConsoleSession.ended() && enabled) controls(true);
    }
  }

  KinConsoleSession.onEnd(() => {
    enabled = false;
    controls(false);
    $('#emr-link-template').value = '';
    $('#emr-link-current').textContent = 'Current: Not Loaded';
    $('#emr-link-preview').textContent = '';
    message('');
  });
  $('#emr-link-template').addEventListener('input', preview);
  $('#emr-link-form').addEventListener('submit', event => {
    event.preventDefault();
    const text = $('#emr-link-template').value.trim();
    void save(text || null);
  });
  $('#emr-link-clear').addEventListener('click', () => void save(null));
  // Enabled only for the administrator session the Members console accepts.
  KinAuth.init().then(session => {
    if (KinConsoleSession.ended() || session?.state !== 'approved' || session.demo || !KinAuth.has('admin')) return;
    enabled = true;
    show(session.emrLink?.template ?? null);
    controls(true);
  }).catch(() => {});
})();
