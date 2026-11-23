/*
 * Technician Order List additions (a worklist add-on, window.KinWorklistAddOns):
 *   - the tab row: Order List (RIS) · Scheduled · Report (the panes come from technician-scheduled.js and
 *     technician-report.js through KinTechnicianPanes; this file draws the tabs and switches between them);
 *   - the action row under the tabs: Search Orders · Delete Order · Match… · Unmatch…;
 *   - RIS Status: a last column of the order table with each order's state as the hospital RIS gives it (RIS_STATUS
 *     below; blank when the order has none). The existing columns keep their places;
 *   - Search Orders: a bar of conditions on the order rows (Scheduled from / to, State, RIS Status, Ward, ReqDoc) applied
 *     at once, together with the panel's own ID / Name / Modality / StudyDesc boxes. Reset clears them; Close only closes
 *     the bar and, while a condition is set, says so on the action row;
 *   - Delete Order: takes an unmatched order off this list with a reason (the server keeps who, when and why); Undo
 *     brings it back. No hospital RIS order is cancelled, and no image, study or report is deleted;
 *   - Match… / Unmatch…: the page's own Match / Unmatch (the right-click body) in a window that compares the study with
 *     the order field by field (≠ shows a difference and never refuses: Match corrects the study from the order), asks
 *     for a reason on Unmatch, and after success shows the values the list read back from the server.
 * Every request and change goes through the page (context.api, context.orders); nothing here holds its own order list.
 */
(function () {
  'use strict';
  // Product words reach the screen through the screen-language write path (English only; otherwise as written).
  const kinError = m => globalThis.KinLanguage?.error ? globalThis.KinLanguage.error(m) : m;
  // Product words through the page's screen language (worklist-language.js), or as written when it is not loaded.
  const kinWrite = (el, value, name) => { if (typeof window !== 'undefined' && window.KinLanguage) return window.KinLanguage.write(el, value, name); if (name) el.setAttribute(name, value); else el.textContent = value; return el; };
  const kinSay = (typeof window !== 'undefined' && window.KinLanguage && window.KinLanguage.say) || ((t, ...p) => t.replace(/\{(?:[ten]?(\d+)|([A-Za-z]\w*))\}/g, (m, i, n) => { const v = n !== undefined ? (p[0] || {})[n] : p[i]; return v === undefined ? m : String(v && typeof v === 'object' ? (v.t ?? v.e ?? '') : v); })), kinSayEn = (typeof window !== 'undefined' && window.KinLanguage && window.KinLanguage.sayEnglish) || kinSay;
  const panes = new Map();
  /** technician-scheduled.js / technician-report.js register a pane: { label, show(host), hide?(), select?(uid), render?() }. */
  window.KinTechnicianPanes = Object.freeze({ register(key, pane) { if (!panes.has(key)) panes.set(key, pane); } });

  const el = (tag, props = {}, ...children) => {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(props)) {
      if (value === undefined || value === null) continue;
      if (key === 'className') node.className = value;
      else if (key === 'text') {
        if (window.KinLanguage) window.KinLanguage.write(node, value);
        else node.textContent = value;
      } else if (key === 'aria-label' && window.KinLanguage) window.KinLanguage.write(node, value, key);
      else if (key in node && typeof value !== 'string') node[key] = value;
      else node.setAttribute(key, value);
    }
    for (const child of children.flat()) if (child !== null && child !== undefined && child !== false) node.append(child);
    return node;
  };
  const text = value => value === null || value === undefined || String(value).trim() === '' ? '—' : String(value);
  // Identifiers (patient ID, accession number, dates) compare exactly, case kept; words (name, sex, modality, exam) without case.
  const same = (a, b) => String(a ?? '').trim() === String(b ?? '').trim();
  const sameWords = (a, b) => same(String(a ?? '').toUpperCase(), String(b ?? '').toUpperCase());
  const button = (label, onClick, className, title) => {
    const b = el('button', { type: 'button', className, title });
    b.textContent = label;
    b.addEventListener('click', onClick);
    return b;
  };
  const table = (heads, rows) => el('table', { className: 'order-table' },
    el('thead', {}, el('tr', {}, heads.map(h => el('th', { text: h })))),
    el('tbody', {}, rows.map(r => r instanceof HTMLElement ? r : el('tr', {}, r.map(v => el('td', { text: text(v) }))))));
  const note = (message, kind = '') => el('p', { className: 'order-note ' + kind, text: message });
  /**
   * The order states the hospital RIS gives (server Order.risStatus) and their words: the column, the search and the
   * condition line all read this one table. The PACS never derives a state (a matched order is not thereby acquired). A
   * value not in the table is shown blank, never as a state. "Order Confirmed": the order's own word ("Confirmed" alone
   * is the report's approval on these screens).
   */
  const RIS_STATUS = Object.freeze({ confirmed: 'Order Confirmed', scheduled: 'Scheduled', acquired: 'Acquired' });
  const phrase = (template, ...args) => window.KinLanguage?.say(template, ...args) ?? template.replace(/\{(\d+)\}/g, (_, i) => args[i]);
  const risStatusLabel = code => Object.hasOwn(RIS_STATUS, code ?? '') ? phrase(RIS_STATUS[code]) : '—';

  /** A modal window (Esc and Close close it; it is removed when closed). */
  function openWindow(title, name) {
    const body = el('div', { className: 'order-dialog-body' }), foot = el('div', { className: 'order-dialog-foot' });
    const dialog = el('dialog', { className: 'order-dialog', 'aria-label': title, 'data-order-window': name },
      el('h3', { text: title }), body, foot);
    dialog.addEventListener('close', () => dialog.remove());
    document.body.append(dialog);
    dialog.showModal();
    const close = () => { if (dialog.open) dialog.close(); };
    const buttons = (...list) => { foot.replaceChildren(...list); list.find(b => !b.disabled)?.focus(); };
    return { dialog, body, foot, close, buttons, closeButton: (label = 'Close') => button(label, close) };
  }

  (window.KinWorklistAddOns ||= []).push(function technicianOrders(ctx) {
    const panel = document.querySelector('.order-p'), tabs = panel?.querySelector('.reltabs');
    const actions = document.getElementById('order-actions'), search = document.getElementById('order-search');
    const paneHost = document.getElementById('order-pane'), grid = panel?.querySelector('.grid2');
    if (!panel || !tabs || !actions || !search || !paneHost || !grid) throw new Error('The Order List anchors are missing');
    const listTab = tabs.querySelector(':scope > div.on') || tabs.querySelector(':scope > div');
    const added = [];
    let current = null;

    // ── tabs ──
    const tabOf = new Map();
    let after = listTab;
    for (const [key, pane] of panes) {
      const tab = el('div', { role: 'tab', tabindex: '0', 'data-order-tab': key, text: pane.label });
      tab.addEventListener('click', () => showTab(key));
      tab.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); showTab(key); } });
      after.after(tab); after = tab; added.push(tab); tabOf.set(key, tab);
    }
    const backToList = () => showTab(null);
    listTab.addEventListener('click', backToList);
    const host = {
      ctx, element: paneHost,
      showList: () => showTab(null),
      openMatch: () => openMatch(),
      status: (message, undo) => setStatus(message, undo),
    };
    function showTab(key) {
      if (current === key) return;
      const leaving = current && panes.get(current);
      current = key;
      try { leaving?.hide?.(); } catch (error) { console.error(error); }
      listTab.classList.toggle('on', !key);
      for (const [k, tab] of tabOf) { tab.classList.toggle('on', k === key); tab.setAttribute('aria-selected', String(k === key)); }
      paneHost.hidden = !key; grid.hidden = !!key; actions.hidden = !!key;
      search.hidden = !!key || !searchOpen;
      if (!key) { paneHost.replaceChildren(); paneHost.removeAttribute('data-pane'); return; }
      paneHost.dataset.pane = key;
      try { panes.get(key).show(host); } catch (error) { console.error(error); paneHost.replaceChildren(note('This view could not be drawn.', 'err')); }
    }
    const offSelect = ctx.onSelect(uid => { if (current) { try { panes.get(current).select?.(uid); } catch (error) { console.error(error); } } });
    const offRender = ctx.onRender(() => { if (current) { try { panes.get(current).render?.(); } catch (error) { console.error(error); } } });

    // ── action row ──
    const status = el('span', { className: 'order-status', role: 'status', 'aria-live': 'polite' });
    const condition = el('span', { className: 'order-condition', hidden: true });
    // Delete Order, Match… and Unmatch… are technician work: the same answer as the Technician bar and the row and order
    // menus (the server's need technician, admin passes). Without it they are grey with the bar's reason.
    const technician = () => ctx.has('technician');
    const TECHNICIAN_REASON = '방사선사(technician) 권한이 필요합니다';
    const writes = [
      ['Delete Order', () => deleteOrder(), 'Take the selected order off this list. Images, studies and reports are not deleted.'],
      ['Match…', () => openMatch(), 'Compare the selected study with the selected order, then link them.'],
      ['Unmatch…', () => openUnmatch(), 'Unlink the selected study from its order and go back to the values read from its images.'],
    ].map(([label, open, title]) => ({ b: button(label, open, '', title), title }));
    function rights() {
      const may = technician();
      for (const { b, title } of writes) { b.disabled = !may; kinWrite(b, may ? title : kinSayEn(TECHNICIAN_REASON), 'title'); }
    }
    actions.replaceChildren(
      button('Search Orders', () => toggleSearch(), '', 'Find orders by scheduled date, state, ward or requesting doctor.'),
      ...writes.map(w => w.b),
      condition, status);
    rights();
    actions.hidden = false;
    function setStatus(message, undo) {
      status.replaceChildren(kinWrite(document.createTextNode(''), message || ''));
      if (undo) status.append(' ', button('Undo', undo));
    }

    // ── RIS Status column ──
    // The page draws the order rows (order-list.js) and tells add-ons after each drawing; the cell is added then, once per
    // row (a row drawn again is a new row), from the same order list the page drew.
    const headRow = grid.querySelector('thead tr:not(.filters)'), filterRow = grid.querySelector('thead tr.filters');
    const orderRows = grid.querySelector('#orderrows');
    if (!headRow || !filterRow || !orderRows) throw new Error('The Order List table is missing');
    const statusHead = el('th', { 'data-ris-status': '', text: phrase('RIS Status') }), statusFilter = el('th', { 'data-ris-status': '' });
    headRow.append(statusHead); filterRow.append(statusFilter);
    added.push(statusHead, statusFilter);
    let emptyColspan = null;
    function drawStatus() {
      const byOid = new Map(ctx.orders.list().map(o => [o.oid, o]));
      for (const row of orderRows.rows) {
        const empty = row.querySelector(':scope > td.empty');
        if (empty) { emptyColspan ??= empty.colSpan; empty.colSpan = headRow.cells.length; continue; }
        if (!row.dataset.oid) continue;
        row.querySelector(':scope > td[data-ris-status]')?.remove();
        row.append(el('td', { 'data-ris-status': byOid.get(row.dataset.oid)?.risStatus ?? '', text: risStatusLabel(byOid.get(row.dataset.oid)?.risStatus) }));
      }
    }

    // ── Search Orders ──
    const crit = { from: '', to: '', state: '', ris: '', ward: '', doc: '' };
    let searchOpen = false;
    const active = () => Object.values(crit).some(Boolean);
    const removeFilter = ctx.orders.filter(o => {
      const day = String(o.sched ?? '').slice(0, 10);
      if (crit.from && day < crit.from) return false;
      if (crit.to && day > crit.to) return false;
      if (crit.state && o.matched !== crit.state) return false;
      if (crit.ris && o.risStatus !== crit.ris) return false;
      if (crit.ward && !String(o.ward ?? '').toUpperCase().includes(crit.ward.toUpperCase())) return false;
      if (crit.doc && !String(o.reqDoc ?? '').toUpperCase().includes(crit.doc.toUpperCase())) return false;
      return true;
    });
    const count = el('span', { className: 'order-count', role: 'status' });
    const offOrders = ctx.orders.onRender(n => { rights(); drawStatus(); count.textContent = n + ' orders'; showCondition(); });
    // The filter above drew the rows before this listener was there.
    drawStatus();
    const inputs = {};
    const field = (key, label, type) => {
      const input = el('input', { type, 'aria-label': label, size: type === 'text' ? 8 : undefined });
      input.addEventListener('input', () => { crit[key] = input.value.trim(); ctx.orders.render(); });
      inputs[key] = input;
      return el('label', {}, label + ' ', input);
    };
    const state = el('select', { 'aria-label': 'State' },
      el('option', { value: '', text: 'All' }), el('option', { value: 'U', text: 'Unmatched' }), el('option', { value: 'M', text: 'Matched' }));
    state.addEventListener('change', () => { crit.state = state.value; ctx.orders.render(); });
    inputs.state = state;
    const ris = el('select', { 'aria-label': phrase('RIS Status') }, el('option', { value: '', text: phrase('All') }),
      Object.keys(RIS_STATUS).map(value => el('option', { value, text: risStatusLabel(value) })));
    ris.addEventListener('change', () => { crit.ris = ris.value; ctx.orders.render(); });
    inputs.ris = ris;
    search.replaceChildren(field('from', 'Scheduled from', 'date'), field('to', 'to', 'date'), el('label', {}, 'State ', state),
      el('label', {}, el('span', {text: phrase('RIS Status')}), ' ', ris), field('ward', 'Ward', 'text'), field('doc', 'ReqDoc', 'text'),
      button('Reset', () => resetSearch()), button('Close', () => toggleSearch(false)), count);
    function resetSearch() {
      for (const key of Object.keys(crit)) { crit[key] = ''; inputs[key].value = ''; }
      ctx.orders.render();
    }
    function toggleSearch(open = !searchOpen) {
      searchOpen = open; search.hidden = !open || !!current;
      if (open) inputs.from.focus();
      ctx.orders.render();
    }
    function showCondition() {
      const words = [crit.from && 'from ' + crit.from, crit.to && 'to ' + crit.to, crit.state && (crit.state === 'M' ? 'Matched' : 'Unmatched'),
        crit.ward && 'Ward ' + crit.ward, crit.doc && 'ReqDoc ' + crit.doc].filter(Boolean);
      // The RIS Status word is its own node so the screen language translates it; the other parts are data or as before.
      const risWord = crit.ris ? el('span', { text: risStatusLabel(crit.ris) }) : null;
      condition.hidden = searchOpen || !(words.length || risWord);
      condition.replaceChildren(...(words.length || risWord
        ? [el('span', {text: phrase('Order search: {0}', words.join(' · '))}), ' ', words.length && risWord ? '· ' : null, risWord, ' ', button('Reset', () => resetSearch())].filter(Boolean)
        : []));
    }

    // ── Delete Order ──
    const selectedOrder = () => { const oid = ctx.orders.selected(); return oid ? ctx.orders.list().find(o => o.oid === oid) ?? null : null; };
    function deleteOrder() {
      if (!technician()) { ctx.toast(kinSayEn(TECHNICIAN_REASON), 'info'); return; }
      const o = selectedOrder();
      if (!o) { ctx.toast('Select an order to delete in Order List first.', 'info'); return; }
      const w = openWindow('Delete Order', 'order-delete');
      w.body.append(table(['Order', 'Patient', 'Scheduled', 'Exam', 'Accession', 'Ward · ReqDoc', 'Mt'],
        [[o.oid, `${o.name} (${o.id})`, o.sched, `${o.modality} ${o.desc}`, o.accession, `${text(o.ward)} · ${text(o.reqDoc)}`, o.matched]]));
      if (o.matched === 'M') {
        w.body.append(note('A matched order cannot be deleted. Unmatch it first.', 'warn'));
        w.buttons(w.closeButton()); return;
      }
      if (!ctx.allowed()) { w.body.append(note('Deleting an order needs the server connection.', 'warn')); w.buttons(w.closeButton()); return; }
      const reason = el('input', { size: 40, 'aria-label': 'Reason', required: true, placeholder: 'Example: duplicate order, cancelled order' });
      const result = el('p', { className: 'order-note', role: 'status' });
      w.body.append(note('This takes the order off this Order List only. Images, studies and reports are not deleted, and the hospital RIS order is not cancelled.'),
        el('label', { className: 'order-reason' }, 'Reason ', reason), result);
      const go = button('Delete Order', async () => {
        const why = reason.value.trim();
        if (!why) { reason.focus(); return; }
        go.disabled = true; result.textContent = 'Deleting…';
        try { await ctx.api('POST', '/orders/' + encodeURIComponent(o.oid) + '/remove', { reason: why }, undefined, ctx.work('document')); }
        catch (error) { if (error?.name === 'AbortError') return; kinWrite(result, kinSayEn('Not deleted: {e0}', kinError(String(error?.message || error)))); result.className = 'order-note err'; go.disabled = false; return; }
        w.close();
        await ctx.orders.refresh();
        setStatus(`Order ${o.oid} removed from the list.`, () => restore(o.oid));
      }, 'danger');
      go.disabled = true;
      reason.addEventListener('input', () => { go.disabled = !reason.value.trim(); });
      w.buttons(go, w.closeButton('Cancel'));
      reason.focus();
    }
    async function restore(oid) {
      setStatus('Restoring…');
      try { await ctx.api('POST', '/orders/' + encodeURIComponent(oid) + '/restore', undefined, undefined, ctx.work('document')); }
      catch (error) { if (error?.name !== 'AbortError') setStatus(kinSayEn('Undo failed: {e0}', kinError(String(error?.message || error)))); return; }
      await ctx.orders.refresh();
      setStatus(`Order ${oid} is back on the list.`);
    }

    // ── Match… ──
    // Every field Match writes over (patient ID, name, sex, birth date, age, study description, ward), the accession shown
    // and Mt: before the change, and as the list read it back after it.
    function shown(s) { return { acc: s.acc, id: s.id, name: s.name, sex: s.sex, birth: s.birth, age: s.age, desc: s.desc, ward: s.ward, mt: s.matched }; }
    function resultRows(before, after) {
      return [['Accession', before.acc, after?.acc], ['Patient ID', before.id, after?.id], ['Name', before.name, after?.name],
        ['Sex', before.sex, after?.sex], ['BirthDate', before.birth, after?.birth], ['Age', before.age, after?.age],
        ['StudyDesc', before.desc, after?.desc], ['Ward', before.ward, after?.ward], ['Mt', before.mt, after?.mt]];
    }
    const birthText = value => /^\d{8}$/.test(String(value ?? '')) ? `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6)}` : value;
    // The age the list computes for a row (worklist-data.js fromApi): whole years between the birth and study dates.
    const digits = value => String(value ?? '').replace(/\D/g, '');
    const ageText = (birth, date) => digits(birth).length === 8 && digits(date).length === 8 ? Math.floor((+digits(date) - +digits(birth)) / 10000) : null;
    function openMatch() {
      if (!technician()) { ctx.toast(kinSayEn(TECHNICIAN_REASON), 'info'); return; }
      const uid = ctx.selectedUid(), s = uid ? ctx.study(uid) : null, o = selectedOrder();
      if (!s || !o) { ctx.toast('Select one study in Study List and one order in Order List first.', 'info'); return; }
      const w = openWindow('Match Study to Order', 'order-match');
      const cmp = [['Patient ID', s.id, o.id], ['Name', s.name, o.name], ['Sex', s.sex, o.sex], ['BirthDate', s.birth, o.birth],
        ['Modality', s.modality, o.modality], ['Exam', s.desc, o.desc], ['Date', s.date, String(o.sched ?? '').slice(0, 10)]];
      const words = new Set(['Name', 'Sex', 'Modality', 'Exam']);
      const matches = (k, a, b) => words.has(k) ? sameWords(a, b) : same(a, b);
      const rows = cmp.map(([k, a, b]) => {
        const ok = matches(k, a, b);
        return el('tr', { className: ok ? '' : 'order-diff' }, el('td', { text: k }), el('td', { text: text(a) }), el('td', { text: text(b) }),
          el('td', { className: 'order-mark', text: ok ? '✓' : '≠' }));
      });
      const orderAcc = o.accession;
      rows.push(el('tr', { className: orderAcc && !same(s.acc, orderAcc) ? 'order-diff' : '' }, el('td', { text: 'Accession' }),
        el('td', { text: text(s.acc) }), el('td', { text: text(orderAcc) }),
        el('td', { className: 'order-mark', text: !orderAcc ? '—' : same(s.acc, orderAcc) ? '✓' : '≠',
          title: !orderAcc ? 'The order has no accession number; the study keeps its own.' : 'While matched, the study shows the order\'s accession number.' })));
      w.body.append(note('Link the study images to this order. The study takes the order\'s patient details and study description' +
        (orderAcc ? ' and shows the order\'s accession number' : '') + '. The images\' own DICOM values are not changed.'),
        table(['', `Study (${text(s.acc)})`, `Order (${o.oid})`, ''], rows));
      if (s.matched === 'M' || o.matched === 'M') {
        w.body.append(note('This study or this order is already matched. Unmatch it first.', 'warn'));
        w.buttons(w.closeButton()); return;
      }
      if (cmp.some(([k, a, b]) => !matches(k, a, b)))
        w.body.append(note('Values marked ≠ differ. Match replaces the study\'s patient details with the order\'s; check them before linking.', 'muted'));
      const result = el('p', { className: 'order-note', role: 'status' });
      w.body.append(result);
      const before = shown(s);
      const go = button('Match', async () => {
        go.disabled = true; result.textContent = 'Matching…';
        const r = await ctx.orders.match(s.uid, o.oid);
        if (!w.dialog.isConnected) return;
        if (!r.ok) { kinWrite(result, kinSayEn('Not matched: {0}', r.message ? kinError(r.message) : 'refused')); result.className = 'order-note err'; go.disabled = false; return; }
        w.body.replaceChildren(note(`Matched: ${s.name} (${s.id}) ↔ ${o.oid}. Reading the result back…`, 'ok'));
        w.buttons(w.closeButton());
        const confirmed = await r.reloaded;
        if (!w.dialog.isConnected) return;
        const after = confirmed ? ctx.study(s.uid) : null;
        w.body.replaceChildren(note(`Matched: ${s.name} (${s.id}) ↔ ${o.oid}.`, 'ok'),
          table(['Field', 'Before', 'After (read back)'], resultRows(before, after && shown(after))));
        if (!after) w.body.append(note('The match was saved, but the list could not be read back. Check the row in Study List.', 'warn'));
        setStatus(`Matched ${s.id} ↔ ${o.oid}.`);
        w.buttons(w.closeButton());
      }, 'primary');
      w.buttons(go, w.closeButton());
    }

    // ── Unmatch… ──
    function openUnmatch() {
      if (!technician()) { ctx.toast(kinSayEn(TECHNICIAN_REASON), 'info'); return; }
      const uid = ctx.selectedUid(), s = uid ? ctx.study(uid) : null;
      if (!s) { ctx.toast('Select a study to unlink in Study List.', 'info'); return; }
      const w = openWindow('Unmatch Study', 'order-unmatch');
      if (s.matched !== 'M') { w.body.append(note(`${s.name} (${s.id}) is not matched to an order.`, 'muted')); w.buttons(w.closeButton()); return; }
      const order = ctx.orders.list().find(o => o.studyUid === s.uid) ?? null;
      const read = ctx.orders.identity(s.uid);
      const before = shown(s);
      // Ward is not in the images: the own ward of the study, which the Match showed the order ward over, comes back.
      const ward = typeof ctx.orders.ownWard === 'function' ? ctx.orders.ownWard(s.uid) : null;
      w.body.append(note('Unlink the study from its order. The study goes back to the values the server read from its images (DICOM) and to its own ward, and the order returns to Unmatched.'),
        table(['Field', 'Now', 'Restored (from the images)'], [['Order', order?.oid, null], ...resultRows(before,
          read ? { acc: read.acc, id: read.id, name: read.name, sex: read.sex, birth: birthText(read.birth), age: ageText(read.birth, s.date), desc: read.desc, ward, mt: 'U' }
            : { ward, mt: 'U' })]));
      const reason = el('input', { size: 40, 'aria-label': 'Reason', required: true, placeholder: 'Example: linked to the wrong order' });
      const result = el('p', { className: 'order-note', role: 'status' });
      w.body.append(el('label', { className: 'order-reason' }, 'Reason ', reason), result);
      const go = button('Unmatch', async () => {
        const why = reason.value.trim();
        if (!why) { reason.focus(); return; }
        go.disabled = true; reason.disabled = true; result.textContent = 'Unmatching…';
        const r = await ctx.orders.unmatch(s.uid, why);
        if (!w.dialog.isConnected) return;
        if (!r.ok) { kinWrite(result, kinSayEn('Not unmatched: {0}', r.message ? kinError(r.message) : 'refused')); result.className = 'order-note err'; go.disabled = false; reason.disabled = false; return; }
        w.body.replaceChildren(note(`Unmatched: ${s.name} (${s.id}). Reading the result back…`, 'ok'));
        w.buttons(w.closeButton());
        const confirmed = await r.reloaded;
        if (!w.dialog.isConnected) return;
        const after = confirmed ? ctx.study(s.uid) : null;
        const freed = confirmed && order ? ctx.orders.list().find(x => x.oid === order.oid) : null;
        w.body.replaceChildren(note(after
          ? `Unmatched: the study shows accession ${text(after.acc)} and ${text(after.desc)} again.` + (freed && freed.matched === 'U' ? ` Order ${freed.oid} is Unmatched again.` : '')
          : `Unmatched: ${s.name} (${s.id}).`, 'ok'),
          table(['Field', 'Before', 'Restored (read back)'], resultRows(before, after && shown(after))));
        if (!after) w.body.append(note('The unmatch was saved, but the list could not be read back. Check the row in Study List.', 'warn'));
        setStatus(`Unmatched ${s.id}.`);
        w.buttons(w.closeButton());
      }, 'primary');
      go.disabled = true;
      reason.addEventListener('input', () => { go.disabled = !reason.value.trim(); });
      w.buttons(go, w.closeButton());
      reason.focus();
    }

    return () => {
      showTab(null);
      for (const node of added) node.remove();
      listTab.removeEventListener('click', backToList);
      offSelect(); offRender(); offOrders(); removeFilter();
      // Rows the page did not draw again (not in Technician mode) lose the cell here.
      for (const cell of orderRows.querySelectorAll(':scope > tr > td[data-ris-status]')) cell.remove();
      if (emptyColspan !== null) for (const cell of orderRows.querySelectorAll(':scope > tr > td.empty')) cell.colSpan = emptyColspan;
      actions.replaceChildren(); actions.hidden = true; search.replaceChildren(); search.hidden = true;
      for (const dialog of document.querySelectorAll('dialog[data-order-window]')) dialog.close();
    };
  });
})();
