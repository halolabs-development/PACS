/*
 * The work mode menu of the top bar: Physician (Clinician Home), Radiologist and Technician (the worklist's two tabs).
 * One module for both pages. Choosing a mode only opens a screen: it grants nothing, and every screen still asks the
 * server. A mode that cannot open for this account is not chosen; it stays in the menu with its reason, which is read
 * from the landing rule (KinAuth.home: a clinician-only account lands on Clinician Home and its worklist is not opened)
 * and from the clinician read routes' role (clinician, or admin).
 *
 * mount({ host, current, choose, leaving, trigger, openers }):
 *   openers          more controls that open the same menu under themselves (the worklist's More entry, where the
 *                    narrow bar has folded the mark away);
 *   trigger          an element already on the bar that opens the menu (the worklist's HALO PACS mark: the bar has no width
 *                    for one more button); without it the menu has its own button that names the mode;
 *   current()        'physician' | 'radiologist' | 'technician' - the mode the page shows now;
 *   choose(mode)     opens that mode (a tab click on the worklist, a navigation to the other page);
 *   leaving(mode)    null, or 'unsent' / 'unconfirmed' when choosing that mode would leave text this page cannot keep:
 *                    the menu then asks Leave / Stay in place (no browser dialog).
 */
(function (root) {
  'use strict';
  const kinSay = (root.KinLanguage && root.KinLanguage.say) || ((text, ...parts) =>
    text.replace(/\{(?:[ten]?(\d+)|([A-Za-z]\w*))\}/g, (slot, index, name) => {
      const value = name !== undefined ? (parts[0] || {})[name] : parts[index];
      return value === undefined ? slot : String(value && typeof value === 'object' ? (value.t ?? value.e ?? '') : value);
    }));
  const kinWrite = (node, value, name) => {
    if (root.KinLanguage) return root.KinLanguage.write(node, value, name);
    if (name) node.setAttribute(name, String(value)); else node.textContent = String(value);
    return node;
  };
  const MODES = [['physician', 'Physician'], ['radiologist', 'Radiologist'], ['technician', 'Technician']];
  const REASON = {
    physician: '진료과 의사 화면은 clinician 또는 admin 역할이 있는 계정만 엽니다',
    main: '이 계정은 진료과 의사 화면만 엽니다 — 판독·기사 화면은 radiologist·technician 역할이 있는 계정이 씁니다',
    demo: '데모에서는 진료과 의사 화면을 열지 않습니다',
  };
  const LEAVE = {
    unsent: '보내지 않은 글이 있습니다 — 이 화면을 떠나면 사라집니다.',
    unconfirmed: '전송 여부를 확인하지 못한 요청이 있습니다 — 이 화면을 떠나면 그 결과를 이 화면에서 더 확인할 수 없습니다.',
  };

  /** Why each mode cannot open for this session ('' when it can). */
  function reasons(session, auth) {
    const roles = session && Array.isArray(session.roles) ? session.roles : [];
    const demo = !!(session && session.demo);
    const main = auth && typeof auth.home === 'function' && auth.home(session) === 'clinician.html' ? REASON.main : '';
    const physician = demo ? REASON.demo
      : session && session.state === 'approved' && (roles.includes('clinician') || roles.includes('admin')) ? '' : REASON.physician;
    return { physician, radiologist: main, technician: main };
  }

  function mount({ host, current, choose, leaving, trigger, openers = [] }) {
    const doc = host.ownerDocument;
    const make = (tag, className) => { const node = doc.createElement(tag); if (className) node.className = className; return node; };
    const own = !trigger;
    const open = trigger || make('button', 'work-mode-open');
    if (own) open.type = 'button';
    else {
      open.setAttribute('role', 'button');
      open.tabIndex = 0;
      open.classList.add('work-mode-trigger');
      open.addEventListener('keydown', event => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        open.click();
      });
    }
    open.id = 'work-mode-open';
    open.setAttribute('aria-haspopup', 'menu');
    open.setAttribute('aria-controls', 'work-mode-menu');
    open.setAttribute('aria-expanded', 'false');
    kinWrite(open, kinSay('작업 화면을 고릅니다: 진료과 의사(Physician)·판독의(Radiologist)·방사선사(Technician)'), 'title');
    const menu = make('div', 'work-mode-menu');
    menu.id = 'work-mode-menu';
    menu.setAttribute('popover', 'auto');
    menu.setAttribute('role', 'menu');
    menu.setAttribute('aria-label', 'Mode');
    const items = new Map();
    for (const [mode, label] of MODES) {
      const item = make('button', 'work-mode-item');
      item.type = 'button';
      item.dataset.mode = mode;
      item.setAttribute('role', 'menuitemradio');
      item.textContent = label;
      const why = make('p', 'work-mode-reason');
      why.id = 'work-mode-reason-' + mode;
      menu.append(item, why);
      items.set(mode, { item, why });
    }
    const ask = make('div', 'work-mode-leave');
    ask.hidden = true;
    const askText = make('p');
    askText.setAttribute('role', 'status');
    const stay = make('button'), go = make('button');
    stay.type = go.type = 'button';
    stay.textContent = 'Stay';
    go.textContent = 'Leave';
    ask.append(askText, go, stay);
    menu.append(ask);
    if (own) host.append(open);
    host.append(menu);

    let pending = null;
    function refresh() {
      const now = current();
      // auth.js declares KinAuth as a script-level constant (not a property of the global object).
      const auth = typeof KinAuth === 'object' && KinAuth ? KinAuth : null;
      const why = reasons(auth && auth.session ? auth.session() : null, auth);
      const shown = MODES.find(([mode]) => mode === now);
      // The mode's name is its own element so a narrow top bar can fold it (still read out) and keep the arrow.
      if (own) {
        const name = make('span', 'work-mode-name');
        name.textContent = shown ? shown[1] : 'Mode';
        open.replaceChildren(name, ' ▾');
      } else kinWrite(open, kinSay('HALO PACS — Mode: {0}', shown ? shown[1] : 'Mode'), 'aria-label');
      for (const [mode, { item, why: line }] of items) {
        item.setAttribute('aria-checked', String(mode === now));
        if (why[mode]) {
          item.setAttribute('aria-disabled', 'true');
          item.setAttribute('aria-describedby', line.id);
          kinWrite(line, kinSay(why[mode]));
          line.hidden = false;
        } else {
          item.removeAttribute('aria-disabled');
          item.removeAttribute('aria-describedby');
          line.textContent = '';
          line.hidden = true;
        }
      }
    }
    function hideAsk() { pending = null; ask.hidden = true; askText.textContent = ''; }
    let anchor = open;
    function place() {
      let box = anchor.getBoundingClientRect();
      // An opener inside a menu that has just closed has no box: the menu opens under that menu's own title.
      const title = !box.width && anchor.closest('details') ? anchor.closest('details').querySelector('summary') : null;
      if (title) box = title.getBoundingClientRect();
      menu.style.top = Math.round(box.bottom + 4) + 'px';
      menu.style.left = Math.round(Math.max(8, Math.min(box.left, (root.innerWidth || 0) - 300))) + 'px';
    }
    function pick(mode) {
      const entry = items.get(mode);
      if (!entry || entry.item.getAttribute('aria-disabled') === 'true') return;
      if (mode === current()) { menu.hidePopover(); return; }
      const loss = typeof leaving === 'function' ? leaving(mode) : null;
      if (loss) {
        pending = mode;
        kinWrite(askText, kinSay(LEAVE[loss] || LEAVE.unsent));
        ask.hidden = false;
        stay.focus();
        return;
      }
      menu.hidePopover();
      choose(mode);
    }
    function expanded() {
      const shown = menu.matches(':popover-open');
      for (const control of [open, ...openers]) if (control) control.setAttribute('aria-expanded', String(shown && control === anchor));
      return shown;
    }
    function toggleFrom(from) {
      anchor = from;
      refresh();
      hideAsk();
      place();
      menu.togglePopover();
      // Said at once (the toggle event comes a task later and also follows an outside click or Escape).
      expanded();
    }
    open.addEventListener('click', () => toggleFrom(open));
    for (const other of openers) {
      if (!other) continue;
      other.setAttribute('aria-haspopup', 'menu');
      other.setAttribute('aria-controls', 'work-mode-menu');
      other.addEventListener('click', () => toggleFrom(other));
    }
    menu.addEventListener('toggle', event => {
      const shown = event.newState === 'open';
      expanded();
      if (shown) (items.get(current()) || items.get('physician')).item.focus();
      else hideAsk();
    });
    for (const [mode, { item }] of items) item.addEventListener('click', () => pick(mode));
    stay.addEventListener('click', () => { hideAsk(); const entry = items.get(current()); if (entry) entry.item.focus(); });
    go.addEventListener('click', () => { const mode = pending; hideAsk(); menu.hidePopover(); if (mode) choose(mode); });
    menu.addEventListener('keydown', event => {
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
      const list = [...items.values()].map(entry => entry.item);
      const at = list.indexOf(doc.activeElement);
      if (at < 0) return;
      event.preventDefault();
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? list.length - 1
        : (at + (event.key === 'ArrowDown' ? 1 : list.length - 1)) % list.length;
      list[next].focus();
    });
    refresh();
    return { refresh, element: open, menu };
  }

  root.KinWorkMode = { mount, reasons };
})(globalThis);
