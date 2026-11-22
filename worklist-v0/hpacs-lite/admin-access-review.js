(() => {
  'use strict';
  // The page's write path (worklist-language.js): its own words read in English on an English screen and stay as written
  // otherwise; data is written as it is.
  const kinSayEn = globalThis.KinLanguage?.sayEnglish || ((phrase, ...parts) =>
    phrase.replace(/\{[ten]?(\d+)\}/g, (slot, i) => parts[i] ?? slot));
  const kinWrite = globalThis.KinLanguage?.write || ((node, value, name) => {
    if (name) node.setAttribute(name, value); else node.textContent = value;
    return node;
  });
  const el = name => document.getElementById(`access-review-${name}`);
  let sequence = 0, next = null, selection = null, count = 0, ready = false, pending = false;
  const fact = value => {
    if (!value) return 'not recorded';
    if (value.status === 'known') return typeof value.value === 'string' ? value.value : JSON.stringify(value.value);
    return `${value.status}: ${value.reason}`;
  };
  const value = item => item == null ? 'not recorded' : typeof item === 'string' ? item : JSON.stringify(item);
  const message = (text, failed = false) => {
    kinWrite(el('message'), text);
    el('message').className = failed ? 'message show' : 'audit-hint';
  };
  function controls() {
    el('load').disabled = !ready || pending;
    el('more').hidden = !next;
    el('more').disabled = !ready || pending;
  }
  function clear() {
    sequence++; next = selection = null; count = 0; pending = false;
    el('rows').replaceChildren(); el('wrap').hidden = true;
    el('wrap').classList.remove('stale'); el('scope').textContent = '';
    el('state').textContent = 'Not Loaded'; message(''); controls();
  }
  function cell(lines) {
    const td = document.createElement('td');
    for (const [label, text] of lines) {
      const line = document.createElement('div'); line.textContent = `${label}: ${text}`; td.append(line);
    }
    return td;
  }
  function row(event) {
    const tr = document.createElement('tr');
    tr.append(cell([['Occurred', event.occurredAt], ['Recorded', event.recordedAt]]),
      cell([['Actor', fact(event.userId)], ['Roles', fact(event.rolesAtTime)], ['Executor', value(event.executor)],
        ['Acting institution', fact(event.actingInstitution)], ['Managing institution', fact(event.managingInstitution)],
        ['IP', fact(event.trustedProxyIp)], ['Affected identity', fact(event.affectedIdentity)]]),
      cell(event.targets.length ? event.targets.flatMap((target, index) => [
        [`${index + 1}. Kind`, target.kind], ['Patient', fact(target.patientLinkSnapshot)], ['Study', fact(target.studyId)],
        ['Record', fact(target.recordId)], ['Version', fact(target.versionId)]]) : [['Targets', 'None']]),
      cell([['Surface', event.surface], ['Action', event.action], ['Result', event.result], ['Statutory act', event.statutoryAct]]),
      cell([['Cause', value(event.cause)], ['Context', value(event.context)], ['Event', event.eventId],
        ['Request', value(event.requestId)], ['Audit link', value(event.auditLinkId)], ['Related event', value(event.relatedEventId)],
        ['Auth', value(event.auth)], ['Rights version', value(event.rightsVersion)]]));
    return tr;
  }
  async function load(more) {
    if (!ready || pending || KinConsoleSession.ended() || (more && !next)) return;
    if (!more) {
      clear();
      try {
        selection = { report: 'access', from: new Date(`${el('from').value}Z`).toISOString(),
          until: new Date(`${el('until').value}Z`).toISOString(), downloads: el('filter').value };
        if (selection.from >= selection.until) throw new Error();
      } catch { message(kinSayEn('시작보다 뒤인 종료 시각을 지정하세요.'), true); return; }
    }
    const current = ++sequence, selected = selection, context = KinWorkContext.capture('document');
    const query = new URLSearchParams(selected);
    if (more) query.set('after', next);
    pending = true; el('state').textContent = 'Loading'; message(''); controls();
    try {
      const response = await KinSessionTransport.page().request(`${location.origin}/api/admin/audit?${query}`, { context });
      if (current !== sequence || selection !== selected || KinConsoleSession.ended() || !KinWorkContext.admits(context)) return;
      if (!response.ok || response.incomplete) throw Object.assign(new Error(), { status: response.status });
      const body = response.body;
      if (!body || body.from !== selected.from || body.until !== selected.until || typeof body.institutionId !== 'string' ||
          !Array.isArray(body.rows) || !(body.next === null || typeof body.next === 'string') ||
          body.rows.some(item => !item || !Array.isArray(item.targets) ||
            ['eventId', 'occurredAt', 'recordedAt', 'surface', 'action', 'result'].some(key => typeof item[key] !== 'string'))) throw new Error();
      const fragment = document.createDocumentFragment();
      body.rows.forEach(item => fragment.append(row(item)));
      el('rows').append(fragment); count += body.rows.length; next = body.next;
      el('wrap').hidden = !count; el('wrap').classList.remove('stale');
      kinWrite(el('scope'), kinSayEn('{0} · {1} ≤ 발생 시각 < {2} · 표시 사건 {n3}건', body.institutionId, body.from, body.until, count));
      el('state').textContent = next ? 'Partial' : count ? 'Loaded' : 'No Events';
      message(next ? kinSayEn('아직 일부 기록만 조회했습니다. Load More로 이어서 확인하세요.') :
        count ? kinSayEn('선택 범위의 조회를 마쳤습니다. 업무 대조와 사유 확인은 담당자가 수행해야 합니다.') : kinSayEn('선택한 기간·조건에 표시할 접속기록이 없습니다.'));
    } catch (error) {
      if (current !== sequence || KinConsoleSession.ended()) return;
      if (error.status === 401 || error.status === 403) {
        el('rows').replaceChildren(); el('wrap').hidden = true; el('scope').textContent = ''; next = null; count = 0;
        document.dispatchEvent(new CustomEvent('kin-access-ledger-refused', { detail: 'access-review' }));
      }
      el('state').textContent = 'Query Failed'; el('wrap').classList.add('stale');
      message(count ? kinSayEn('이어보기에 실패했습니다. 표시된 기록은 이전에 조회한 일부입니다. 다시 조회하세요.') : kinSayEn('접속기록 조회에 실패했습니다. 기간과 권한을 확인하고 다시 조회하세요.'), true);
    } finally {
      if (current === sequence) { pending = false; controls(); }
    }
  }
  el('form').addEventListener('submit', event => { event.preventDefault(); load(false); });
  el('more').addEventListener('click', () => load(true));
  for (const name of ['from', 'until', 'filter']) el(name).addEventListener('input', clear);
  // Access Alerts was refused the same ledger: nothing read before stays on screen here either.
  document.addEventListener('kin-access-ledger-refused', event => { if (event.detail !== 'access-review') clear(); });
  KinConsoleSession.onEnd(() => { ready = false; clear(); });
  KinAuth.init().then(session => {
    if (KinConsoleSession.ended()) return;
    ready = session?.state === 'approved' && !session.demo && KinAuth.has('admin'); controls();
  }).catch(() => {});
})();

/* Access Alerts: one account opening many different studies in a short time, from the same access ledger as Access
 * Review. The server decides what counts and the threshold; this panel shows its answer and opens Access Review on an
 * alert's span. Read only when the administrator presses Check Alerts. */
(() => {
  'use strict';
  const kinSay = globalThis.KinLanguage?.say || ((phrase, ...parts) =>
    phrase.replace(/\{[ten]?(\d+)\}/g, (slot, i) => parts[i] ?? slot));
  const kinWrite = globalThis.KinLanguage?.write || ((node, value, name) => {
    if (name) node.setAttribute(name, value); else node.textContent = value;
    return node;
  });
  const el = name => document.getElementById(`access-alerts-${name}`);
  const DAY = 86400000;
  let sequence = 0, ready = false, pending = false, edited = false;
  const local = ms => new Date(ms).toISOString().slice(0, 19);
  const state = text => kinWrite(el('state'), text);
  const message = (text, failed = false) => {
    kinWrite(el('message'), text);
    el('message').className = failed ? 'message show' : 'audit-hint';
  };
  function lastDay() {
    const until = Math.ceil(Date.now() / 1000) * 1000;
    el('from').value = local(until - DAY); el('until').value = local(until);
  }
  function controls() { el('load').disabled = !ready || pending; }
  function clear() {
    sequence++; pending = false;
    el('rows').replaceChildren(); el('wrap').hidden = true;
    el('scope').textContent = ''; state(kinSay('Not Loaded')); message(''); controls();
  }
  function cell(text, title) {
    const td = document.createElement('td');
    td.setAttribute('translate', 'no');
    td.textContent = text;
    if (title) td.title = title;
    return td;
  }
  // Access Review's own inputs and Load Review: the alert's span, to the second, end exclusive. The input event is\n  // the one a person's edit sends: Access Review clears and drops an answer still on its way for an earlier span.
  function review(alert) {
    const first = Math.floor(Date.parse(alert.firstAt) / 1000) * 1000;
    const after = Math.floor(Date.parse(alert.lastAt) / 1000) * 1000 + 1000;
    document.getElementById('access-review-from').value = local(first);
    document.getElementById('access-review-until').value = local(after);
    document.getElementById('access-review-filter').value = 'all';
    document.getElementById('access-review-from').dispatchEvent(new Event('input'));
    document.getElementById('access-review-form').requestSubmit();
    document.getElementById('access-review').scrollIntoView({ block: 'start' });
  }
  function row(alert) {
    const tr = document.createElement('tr');
    const who = alert.userId.value;
    const open = document.createElement('button');
    open.type = 'button';
    kinWrite(open, kinSay('Review'));
    kinWrite(open, kinSay('이 기관의 같은 시간대 접속기록을 Access Review에서 엽니다. 그 시간대의 다른 사용자 기록도 함께 보일 수 있습니다.'), 'title');
    open.addEventListener('click', () => review(alert));
    const action = document.createElement('td');
    action.append(open);
    tr.append(cell(who.id, `issuer: ${who.issuer} · subject: ${who.subject}`), cell(alert.firstAt), cell(alert.lastAt),
      cell(String(alert.studies)), cell(String(alert.events)), action);
    return tr;
  }
  const valid = (body, selected) => body && body.from === selected.from && body.until === selected.until &&
    typeof body.institutionId === 'string' && body.threshold &&
    Number.isSafeInteger(body.threshold.studies) && Number.isSafeInteger(body.threshold.minutes) &&
    Array.isArray(body.alerts) && body.alerts.every(alert => alert && alert.userId?.status === 'known' &&
      ['id', 'issuer', 'subject'].every(key => typeof alert.userId.value?.[key] === 'string') &&
      ['firstAt', 'lastAt', 'evidenceEntryId'].every(key => typeof alert[key] === 'string') &&
      Number.isSafeInteger(alert.studies) && Number.isSafeInteger(alert.events));
  async function load() {
    if (!ready || pending || KinConsoleSession.ended()) return;
    if (!edited) lastDay();
    clear();
    let selected;
    try {
      selected = { report: 'access-alerts', from: new Date(`${el('from').value}Z`).toISOString(),
        until: new Date(`${el('until').value}Z`).toISOString() };
      if (selected.from >= selected.until) throw new Error();
    } catch { message(kinSay('시작보다 뒤인 종료 시각을 지정하세요.'), true); return; }
    const current = ++sequence, context = KinWorkContext.capture('document');
    pending = true; state(kinSay('Checking')); message(''); controls();
    try {
      const response = await KinSessionTransport.page().request(
        `${location.origin}/api/admin/audit?${new URLSearchParams(selected)}`, { context });
      if (current !== sequence || KinConsoleSession.ended() || !KinWorkContext.admits(context)) return;
      if (!response.ok || response.incomplete) throw Object.assign(new Error(), { status: response.status,
        detail: typeof response.body?.message === 'string' ? response.body.message : '' });
      const body = response.body;
      if (!valid(body, selected)) throw new Error();
      const fragment = document.createDocumentFragment();
      body.alerts.forEach(alert => fragment.append(row(alert)));
      el('rows').replaceChildren(fragment);
      el('wrap').hidden = !body.alerts.length;
      kinWrite(el('scope'), kinSay('{0} · {1} ≤ 발생 시각 < {2} · 기준: {3}분 안에 서로 다른 검사 {4}건 이상 · 경보 {5}건',
        body.institutionId, body.from, body.until, body.threshold.minutes, body.threshold.studies, body.alerts.length));
      state(kinSay(body.alerts.length ? 'Alerts Found' : 'No Alerts'));
      message(body.alerts.length
        ? kinSay('경보는 확인할 단서입니다. 업무상 열람인지는 Review로 그 시간대의 접속기록을 보고 담당자가 확인하세요.')
        : kinSay('선택한 기간에 경보 기준에 닿은 열람이 없습니다.'));
    } catch (error) {
      if (current !== sequence || KinConsoleSession.ended()) return;
      el('rows').replaceChildren(); el('wrap').hidden = true; el('scope').textContent = '';
      if (error.status === 401 || error.status === 403)
        document.dispatchEvent(new CustomEvent('kin-access-ledger-refused', { detail: 'access-alerts' }));
      state(kinSay('Check Failed'));
      message(error.detail ? kinSay('경보 확인에 실패했습니다: {e0}', error.detail)
        : kinSay('경보 확인에 실패했습니다. 기간과 권한을 확인하고 다시 확인하세요.'), true);
    } finally {
      if (current === sequence) { pending = false; controls(); }
    }
  }
  lastDay();
  el('form').addEventListener('submit', event => { event.preventDefault(); load(); });
  for (const name of ['from', 'until']) el(name).addEventListener('input', () => { edited = true; clear(); });
  // Access Review was refused the same ledger: the alerts shown before (accounts, times) do not stay.
  document.addEventListener('kin-access-ledger-refused', event => { if (event.detail !== 'access-alerts') clear(); });
  KinConsoleSession.onEnd(() => { ready = false; clear(); });
  KinAuth.init().then(session => {
    if (KinConsoleSession.ended()) return;
    ready = session?.state === 'approved' && !session.demo && KinAuth.has('admin'); controls();
  }).catch(() => {});
})();