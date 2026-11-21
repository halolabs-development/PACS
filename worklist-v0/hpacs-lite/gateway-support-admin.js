(function () {
  'use strict';
  // The page's write path (worklist-language.js): its own words read in English on an English screen and stay as written
  // otherwise; data is written as it is.
  const kinSayEn = globalThis.KinLanguage?.sayEnglish || ((phrase, ...parts) =>
    phrase.replace(/\{[ten]?(\d+)\}/g, (slot, i) => parts[i] ?? slot));
  const kinWrite = globalThis.KinLanguage?.write || ((node, value, name) => {
    if (name) node.setAttribute(name, value); else node.textContent = value;
    return node;
  });
  // Gateway Support: the administrator asks one of this institution's Gateways for diagnostics, a restart, or an update to
  // a version this server holds (GET/POST /api/admin/gateway-support; the rule is api/src/gateway-support.ts). The Gateway
  // fetches the request over its own outbound call. Opening the page reads nothing: Load Gateway Support (or arriving at
  // #gateway-support) reads the lines. An action names the full queueInstance of a line from the last successful read and
  // is offered only while that read stands; a failed read keeps the lines dimmed without actions. A busy line (409) reads
  // the lines again. The page owns termination (KinConsoleSession): its end clears the lines and nothing paints after it.
  const API = `${location.origin}/api`;
  const $ = selector => document.querySelector(selector);
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  const VERSION = /^[0-9]{1,9}(?:\.[0-9]{1,9}){0,7}$/;
  const TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
  const ACTIONS = { diagnostics: 'Diagnostics', restart: 'Restart', update: 'Update' };
  const STATES = {
    requested: ['Requested', kinSayEn("요청을 남겼습니다. Gateway가 다음 연락(약 30초)에 가져갑니다.")],
    delivered: ['Delivered to Gateway', kinSayEn("Gateway가 요청을 가져갔습니다. 결과를 기다립니다.")],
    accepted: ['Accepted by Gateway', kinSayEn("Gateway가 요청을 받아 실행 중입니다. 결과가 오면 바뀝니다.")],
    done: ['Done', kinSayEn("Gateway가 요청을 마쳤다고 알렸습니다.")],
    installed: ['Installed', kinSayEn("새 판이 3분 안에 정상으로 돌아 그대로 쓰입니다.")],
    rolled_back: ['Rolled Back', kinSayEn("새 판이 정상으로 돌지 않아 이전 판으로 돌아갔습니다. 이전 판이 계속 보냅니다.")],
    refused: ['Refused', kinSayEn("Gateway가 요청을 실행하지 않았습니다. 아무것도 바뀌지 않았습니다.")],
  };
  const CODES = {
    remote_support_off: kinSayEn("병원 IT가 이 Gateway의 원격 지원을 꺼 두었습니다."),
    bad_signature: kinSayEn("이 판의 서명을 Gateway 호스트의 키로 확인할 수 없습니다."),
    no_update_key: kinSayEn("Gateway 호스트에 갱신 서명 키가 설정되지 않았습니다."),
    bad_update_key: kinSayEn("Gateway 호스트의 갱신 서명 키 설정을 읽을 수 없습니다."),
    not_newer: kinSayEn("지금 도는 판보다 새 판이 아닙니다."),
    wrong_version: kinSayEn("받은 파일의 판이 요청한 판과 다릅니다."),
    invalid_bundle: kinSayEn("받은 파일이 갱신 파일 형식이 아닙니다."),
    too_large: kinSayEn("받은 파일이 너무 큽니다."),
    download_failed: kinSayEn("Gateway가 이 서버에서 파일을 받지 못했습니다."),
    store_failed: kinSayEn("Gateway가 받은 파일을 저장하지 못했습니다."),
    no_launcher: kinSayEn("이 Gateway는 갱신을 받을 수 없는 옛 설치입니다(이미지 교체가 필요합니다)."),
    exited: kinSayEn("새 판이 시작한 뒤 멈췄습니다."),
    not_ready: kinSayEn("새 판이 3분 안에 정상으로 돌지 않았습니다."),
    interrupted: kinSayEn("새 판을 시험하는 중에 Gateway가 다시 시작되었습니다."),
  };
  const pad = value => String(value).padStart(2, '0');
  const local = iso => { const d = new Date(iso);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`; };
  const plain = value => !!value && typeof value === 'object' && !Array.isArray(value);
  let enabled = false, pending = false, seq = 0, read = null, failed = false;

  function message(text) {
    const box = $('#gateway-support-message');
    kinWrite(box, text || '');
    box.classList.toggle('show', !!text);
  }

  async function request(method, path, body) {
    if (KinConsoleSession.ended()) throw new Error('세션이 종료되었습니다');
    const context = KinWorkContext.capture('document');
    const response = await KinSessionTransport.page().request(API + path, { method, json: body, context });
    if (!KinWorkContext.admits(context)) throw new Error('세션이 종료되었습니다');
    if (!response.ok || response.incomplete) throw Object.assign(new Error(`HTTP ${response.status}`),
      { status: response.status, code: response.body?.code });
    return response.body;
  }

  function readRequest(raw) {
    if (raw === null) return null;
    if (!plain(raw) || typeof raw.id !== 'string' || !UUID.test(raw.id) || !(raw.action in ACTIONS) || !(raw.state in STATES)
      || (raw.version !== null && !VERSION.test(String(raw.version))) || (raw.code !== null && !/^[a-z_]{1,40}$/.test(String(raw.code)))
      || typeof raw.requestedBy !== 'string' || !TIME.test(raw.requestedAt) || !TIME.test(raw.updatedAt)
      || typeof raw.diagnostics !== 'boolean') return undefined;
    return { id: raw.id, action: raw.action, version: raw.version, state: raw.state, code: raw.code,
      requestedBy: raw.requestedBy.slice(0, 128), requestedAt: raw.requestedAt, updatedAt: raw.updatedAt, diagnostics: raw.diagnostics };
  }

  /** The whole answer, or null when any part of it cannot be read. */
  function readAnswer(answer) {
    if (!plain(answer) || !Array.isArray(answer.gateways) || !Array.isArray(answer.updates) || !TIME.test(answer.generatedAt)
      || !TIME.test(answer.serverStartedAt) || !answer.updates.every(v => typeof v === 'string' && VERSION.test(v))) return null;
    const gateways = [];
    for (const raw of answer.gateways) {
      if (!plain(raw) || typeof raw.gateway !== 'string' || !raw.gateway.trim() || typeof raw.queueInstance !== 'string'
        || !UUID.test(raw.queueInstance) || typeof raw.version !== 'string' || (raw.contact !== 'recent' && raw.contact !== 'no_contact')
        || !TIME.test(raw.lastContactAt)) return null;
      const req = readRequest(raw.request);
      if (req === undefined) return null;
      gateways.push({ gateway: raw.gateway.slice(0, 128), queueInstance: raw.queueInstance, version: raw.version.slice(0, 32),
        contact: raw.contact, lastContactAt: raw.lastContactAt, request: req });
    }
    return { generatedAt: answer.generatedAt, serverStartedAt: answer.serverStartedAt, updates: answer.updates, gateways };
  }

  function failure(error, what) {
    if (error?.status === 403) return error.code === 'GATEWAY_SUPPORT_RESTRICTED'
      ? kinSayEn("검사 접근 범위가 제한된 계정은 Gateway 원격 지원을 쓸 수 없습니다.") : kinSayEn("이 계정으로는 Gateway 원격 지원을 쓸 수 없습니다.");
    if (error?.status === 409) return error.code === 'GATEWAY_SUPPORT_BUSY'
      ? kinSayEn("이 Gateway에 아직 끝나지 않은 요청이 있습니다. 지금 상태를 다시 읽었습니다.") : kinSayEn("조건이 바뀌었습니다. 지금 상태를 다시 읽었습니다.");
    if (error?.status === 404) return kinSayEn("그 Gateway 줄을 찾을 수 없습니다(서버가 다시 시작했거나 연락이 바뀌었습니다). 지금 상태를 다시 읽었습니다.");
    if (error?.status === 400 && error.code === 'GATEWAY_SUPPORT_UNKNOWN_VERSION') return kinSayEn("이 서버에 그 판이 없습니다. 지금 상태를 다시 읽었습니다.");
    if (error?.status === 503) return kinSayEn("서버가 바쁩니다. 잠시 후 다시 하세요.");
    return kinSayEn("{0} 결과를 확인하지 못했습니다. 다시 불러와 지금 상태를 확인하세요.", what);
  }

  function span(className, text, title, data) {
    const item = document.createElement('span');
    item.className = className;
    kinWrite(item, text);
    if (title) kinWrite(item, title, 'title');
    if (data) item.setAttribute('translate', 'no');
    return item;
  }

  function button(text, onClick, disabled) {
    const item = document.createElement('button');
    item.type = 'button';
    kinWrite(item, text);
    item.disabled = disabled;
    item.addEventListener('click', onClick);
    return item;
  }

  function requestLine(req) {
    if (!req) return span('gw-support-request', 'No Request Since Server Start', kinSayEn("서버가 시작한 뒤 이 줄에 남긴 요청이 없습니다."));
    const [word, meaning] = STATES[req.state];
    const line = document.createElement('span');
    line.className = 'gw-support-request';
    line.dataset.state = req.state;
    kinWrite(line, req.code && CODES[req.code] ? kinSayEn('{0} {1}', meaning, CODES[req.code]) : meaning, 'title');
    line.append(`Last Request: ${ACTIONS[req.action]}`);
    if (req.version) line.append(' ', span('', req.version, '', true));
    line.append(` · ${word}`);
    if (req.code) line.append(' (', span('', req.code, '', true), ')');
    line.append(` · ${local(req.updatedAt)} · `, span('', req.requestedBy, kinSayEn("요청한 계정"), true));
    return line;
  }

  function draw() {
    const rows = $('#gateway-support-rows');
    const live = !!read && !failed && enabled && !pending;
    const items = (read ? read.gateways : []).map(row => {
      const li = document.createElement('li');
      li.dataset.queueInstance = row.queueInstance;
      // The queue instance tells two lines of one Gateway name apart (as on Gateway Status); its full value is the title.
      li.append(span('gw-host-name', row.gateway, '', true),
        span('gw-host-fact', 'Queue Instance ', kinSayEn("이 줄의 Gateway 큐({0})입니다. 요청은 이 큐에만 갑니다.", row.queueInstance)),
        span('gw-host-fact', 'Version ', kinSayEn("Gateway가 마지막으로 알린 프로그램 버전입니다.")),
        requestLine(row.request));
      li.children[1].append(span('', row.queueInstance.slice(0, 8), '', true));
      li.children[2].append(span('', row.version, '', true));
      if (row.contact === 'no_contact') li.append(span('gw-host-contact', `No Contact since ${local(row.lastContactAt)}`,
        kinSayEn("이 Gateway의 연락이 끊겨 요청을 가져가지 못할 수 있습니다.")));
      const open = row.request && ['requested', 'delivered', 'accepted'].includes(row.request.state);
      const actions = document.createElement('span');
      actions.className = 'gw-support-actions';
      actions.append(
        button('Request Diagnostics', () => act(row.queueInstance, 'diagnostics', null), !live || open),
        button('Restart Gateway', () => act(row.queueInstance, 'restart', null), !live || open));
      const select = document.createElement('select');
      select.setAttribute('aria-label', 'Update Version');
      select.setAttribute('translate', 'no');
      for (const version of read.updates) select.append(new Option(version, version));
      select.disabled = !live || open || !read.updates.length;
      actions.append(select, button('Update Gateway', () => act(row.queueInstance, 'update', select.value || null),
        !live || open || !read.updates.length));
      if (row.request?.diagnostics) actions.append(button('Download Diagnostics', () => download(row.request.id, row.gateway), !live));
      li.append(actions);
      return li;
    });
    rows.replaceChildren(...items);
    rows.classList.toggle('stale', failed && !!read);
    const none = $('#gateway-support-empty');
    none.hidden = !read || failed || read.gateways.length > 0;
    none.textContent = read ? `No Gateway of this institution has contacted this server since it started (${local(read.serverStartedAt)}).` : '';
    const chip = $('#gateway-support-state');
    chip.className = `gstate ${!read ? 'not_loaded' : failed ? 'query_failed' : 'observed'}`;
    kinWrite(chip, !read ? 'Not Loaded' : failed ? kinSayEn("Query Failed · 마지막 관측 {0}", local(read.generatedAt)) : `Observed ${local(read.generatedAt)}`);
    $('#gateway-support-refresh').disabled = !enabled || pending;
  }

  function clear() {
    seq++;
    read = null;
    failed = false;
    draw();
  }

  async function load() {
    const mine = ++seq;
    let answer = null, error = null;
    try { answer = await request('GET', '/admin/gateway-support'); }
    catch (e) { error = e; }
    if (mine !== seq || KinConsoleSession.ended()) return;
    if (error?.status === 403) { clear(); throw error; }
    const next = error ? null : readAnswer(answer);
    if (!next) { failed = true; draw(); throw error || new Error('answer'); }
    read = next;
    failed = false;
    draw();
  }

  async function run(work, what) {
    if (KinConsoleSession.ended() || pending || !enabled) return;
    pending = true;
    message('');
    draw();
    try { await work(); }
    catch (error) {
      if (KinConsoleSession.ended()) return;
      if (error?.status === 403) clear();   // nothing of an earlier read stays for an account that may not see it
      message(error?.message === 'answer' ? kinSayEn("조회 응답 형식을 확인할 수 없습니다.") : failure(error, what));
      if ([404, 409].includes(error?.status) || error?.code === 'GATEWAY_SUPPORT_UNKNOWN_VERSION') await load().catch(() => {});
    } finally {
      pending = false;
      if (!KinConsoleSession.ended()) draw();
    }
  }

  function act(queueInstance, action, version) {
    if (!read || failed) return;
    void run(async () => {
      await request('POST', '/admin/gateway-support', { queueInstance, action, version });
      await load();
      message(kinSayEn("요청을 남겼습니다. Gateway가 다음 연락(약 30초)에 가져갑니다 — Load Gateway Support로 결과를 확인하세요."));
    }, kinSayEn("요청"));
  }

  function download(id, gateway) {
    void run(async () => {
      const mine = seq;
      const body = await request('GET', `/admin/gateway-support/${id}/diagnostics`);
      if (mine !== seq || KinConsoleSession.ended()) return;
      const blob = new Blob([JSON.stringify(body, null, 2)], { type: 'application/json' });
      const link = document.createElement('a');
      link.href = URL.createObjectURL(blob);
      link.download = `gateway-diagnostics-${gateway.replace(/[^A-Za-z0-9._-]/g, '_')}-${id.slice(0, 8)}.json`;
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(link.href), 0);
    }, kinSayEn("진단 받기"));
  }

  KinConsoleSession.onEnd(() => {
    enabled = false;
    clear();
    message('');
  });
  $('#gateway-support-refresh').addEventListener('click', () => void run(() => load(), kinSayEn("조회")));
  // Enabled only for the administrator session the Members console accepts.
  KinAuth.init().then(session => {
    if (KinConsoleSession.ended() || session?.state !== 'approved' || session.demo || !KinAuth.has('admin')) return;
    enabled = true;
    draw();
    if (location.hash === '#gateway-support') void run(() => load(), kinSayEn("조회"));
  }).catch(() => {});
  window.KinGatewaySupport = Object.freeze({ readAnswer });
})();
