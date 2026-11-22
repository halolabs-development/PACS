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
  // Gateway Rules: the administrator sets, for the institution's Gateways, which destinations a study goes to (rules by
  // Modality and/or sending AE Title; HALO PACS and the DICOM Peers registered as PACS / Modality), lossless compression toward HALO PACS,
  // and after how many days a Gateway deletes a copy every destination has (empty = never) (GET/PUT /api/admin/gateway-settings; the rule
  // itself is api/src/gateway-settings.ts). Opening the page reads nothing: Load Gateway Rules (or arriving at
  // #gateway-rules) reads them. A save names the revision it was loaded at; another save in between is refused and the
  // rules are read again. The page owns termination (KinConsoleSession).
  const API = `${location.origin}/api`;
  const KIN = 'kin';
  const $ = selector => document.querySelector(selector);
  const CONTROLS = ['#gateway-rules-refresh', '#gateway-rule-add', '#gateway-compression', '#gateway-retention-days', '#gateway-rules-save'];
  const FIELD = { modality: 'Modality', sourceAe: 'Sending AE Title', destinations: 'Destinations' };
  let enabled = false, pending = false, loaded = false, seq = 0, revision = 0, peers = [];

  function message(text) {
    const box = $('#gateway-rules-message');
    kinWrite(box, text || '');
    box.classList.toggle('show', !!text);
  }

  function controls(on) {
    for (const id of CONTROLS) $(id).disabled = !on || (id !== '#gateway-rules-refresh' && !loaded);
    for (const item of document.querySelectorAll('#gateway-rules-rows input, #gateway-rules-rows button')) item.disabled = !on;
  }

  async function request(method, path, body) {
    if (KinConsoleSession.ended()) throw new Error('세션이 종료되었습니다');
    const context = KinWorkContext.capture('document');
    const response = await KinSessionTransport.page().request(API + path, { method, json: body, context });
    if (!KinWorkContext.admits(context)) throw new Error('세션이 종료되었습니다');
    if (!response.ok || response.incomplete) throw Object.assign(new Error(`HTTP ${response.status}`),
      { status: response.status, code: response.body?.code, field: response.body?.field,
        said: typeof response.body?.message === 'string' ? response.body.message : '' });
    return response.body;
  }

  // Fixed sentences for this screen; the server's wording is used only for the restricted-account refusal it words.
  function failure(error, what) {
    if (error?.status === 400 && typeof error.field === 'string') {
      const row = error.field.match(/^routes\[(\d+)\]\.?(\w*)$/);
      if (error.field === 'retentionDays') return kinSayEn('보관 날 수는 1부터 3650까지의 정수로 적거나, 지우지 않으려면 비워 두세요.');
      if (row) return kinSayEn('규칙 {n0}의 {1}을(를) 확인하세요{t2}', Number(row[1]) + 1, FIELD[row[2]] || kinSayEn('값'),
        row[2] === 'destinations' ? kinSayEn(' — 목적지를 하나 이상, 겹치지 않게 고릅니다.') : '.');
      return kinSayEn('저장할 수 없는 값이 있습니다. 다시 불러와 확인하세요.');
    }
    if (error?.status === 409) return kinSayEn('다른 곳에서 Gateway 규칙이 바뀌었습니다. 지금 규칙을 다시 불러왔습니다 — 확인하고 다시 저장하세요.');
    if (error?.status === 403) return error.code === 'GATEWAY_SETTINGS_RESTRICTED' && error.said
      ? error.said : kinSayEn('이 계정으로는 Gateway 규칙을 관리할 수 없습니다.');
    return kinSayEn('{0} 결과를 확인하지 못했습니다. 다시 불러와 지금 규칙을 확인하세요.', what);
  }

  function destinations(route) {
    const box = document.createElement('span');
    box.className = 'gw-rule-destinations';
    box.setAttribute('role', 'group');
    box.setAttribute('aria-label', 'Destinations');
    const named = [{ id: KIN, name: 'HALO PACS', data: false }, ...peers.map(peer => ({ id: peer.id, name: peer.name, data: true }))];
    for (const target of named) {
      const label = document.createElement('label');
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.value = target.id;
      input.checked = route.destinations.includes(target.id);
      const name = document.createElement('span');
      name.textContent = target.name;
      if (target.data) name.setAttribute('translate', 'no');   // a peer's name is the hospital's own text
      label.append(input, ' ', name);
      box.append(label, ' ');
    }
    return box;
  }

  function text(value, placeholder, max, name) {
    const input = document.createElement('input');
    input.value = value ?? '';
    input.placeholder = placeholder;
    input.maxLength = max;
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.dataset.field = name;
    input.setAttribute('translate', 'no');
    return input;
  }

  function addRow(route) {
    const rows = $('#gateway-rules-rows');
    const tr = document.createElement('tr');
    const number = document.createElement('td');
    const cells = [number, document.createElement('td'), document.createElement('td'), document.createElement('td'), document.createElement('td')];
    cells[1].append(text(route.modality, 'Any', 16, 'modality'));
    cells[2].append(text(route.sourceAe, 'Any', 16, 'sourceAe'));
    cells[3].append(destinations(route));
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.textContent = 'Remove Rule';
    remove.addEventListener('click', () => { tr.remove(); numbers(); });
    cells[4].append(remove);
    tr.append(...cells);
    rows.append(tr);
    numbers();
  }

  function numbers() {
    const rows = [...document.querySelectorAll('#gateway-rules-rows > tr')];
    rows.forEach((tr, index) => { tr.firstElementChild.textContent = String(index + 1); });
    $('#gateway-rules-wrap').hidden = !rows.length;
    $('#gateway-rules-empty').hidden = !loaded || !!rows.length;
  }

  function render(settings, list) {
    loaded = true;
    revision = settings.revision;
    peers = Array.isArray(list) ? list : [];
    $('#gateway-rules-rows').replaceChildren();
    for (const route of settings.routes) addRow(route);
    numbers();
    $('#gateway-compression').value = settings.compression === 'lossless' ? 'lossless' : 'none';
    $('#gateway-retention-days').value = Number.isSafeInteger(settings.retentionDays) ? String(settings.retentionDays) : '';
    const chip = $('#gateway-rules-state');
    chip.className = 'gstate observed';
    chip.textContent = settings.routes.length ? `${settings.routes.length} Rules` : 'No Rules';
  }

  function form() {
    const routes = [...document.querySelectorAll('#gateway-rules-rows > tr')].map(tr => {
      const value = name => tr.querySelector(`input[data-field="${name}"]`).value.trim();
      return { modality: value('modality') || null, sourceAe: value('sourceAe') || null,
        destinations: [...tr.querySelectorAll('.gw-rule-destinations input:checked')].map(box => box.value) };
    });
    // Empty = never delete (null); whole digits = days; anything else goes as written so the server names the field.
    const days = $('#gateway-retention-days').value.trim();
    return { revision, routes, compression: $('#gateway-compression').value,
      retentionDays: days === '' ? null : /^\d+$/.test(days) ? Number(days) : days };
  }

  async function load() {
    const mine = ++seq;
    const body = await request('GET', '/admin/gateway-settings');
    if (mine === seq && !KinConsoleSession.ended() && body?.settings) render(body.settings, body.peers);
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
      if (error?.status === 409) await load().catch(() => {});
    } finally {
      pending = false;
      if (!KinConsoleSession.ended() && enabled) controls(true);
    }
  }

  KinConsoleSession.onEnd(() => {
    enabled = false;
    loaded = false;
    seq++;
    $('#gateway-rules-rows').replaceChildren();
    $('#gateway-retention-days').value = '';
    $('#gateway-rules-wrap').hidden = true;
    $('#gateway-rules-empty').hidden = true;
    $('#gateway-rules-state').className = 'gstate not_loaded';
    $('#gateway-rules-state').textContent = 'Not Loaded';
    controls(false);
    message('');
  });
  $('#gateway-rules-refresh').addEventListener('click', () => void run(() => load(), kinSayEn('규칙 조회')));
  $('#gateway-rule-add').addEventListener('click', () => {
    if (!loaded || pending || KinConsoleSession.ended()) return;
    addRow({ modality: null, sourceAe: null, destinations: [KIN] });
  });
  $('#gateway-rules-form').addEventListener('submit', event => {
    event.preventDefault();
    if (!loaded) return;
    const body = form();
    void run(async () => {
      const answer = await request('PUT', '/admin/gateway-settings', body);
      seq++;   // a read still in flight is older than this answer
      if (answer?.settings) render(answer.settings, peers);
      message(answer?.changed ? kinSayEn('Gateway 규칙을 저장했습니다(판 {n0}).', answer.settings.revision) : kinSayEn('바뀐 것이 없어 저장하지 않았습니다.'));
    }, kinSayEn('저장'));
  });
  // Enabled only for the administrator session the Members console accepts.
  KinAuth.init().then(async session => {
    if (KinConsoleSession.ended() || session?.state !== 'approved' || session.demo || !KinAuth.has('admin')) return;
    enabled = true;
    controls(true);
    if (location.hash === '#gateway-rules') void run(() => load(), kinSayEn('규칙 조회'));
  }).catch(() => {});
})();
