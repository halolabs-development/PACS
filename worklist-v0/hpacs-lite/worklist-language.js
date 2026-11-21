/* Screen language is opt-in. Capture the page's markup before its renderers start.
 * Dynamic UI carries a product phrase and its arguments to the point of display.
 * Ordinary strings, including server details, pass through unchanged.
 */
(function () {
  'use strict';
  // A script test that runs config/ohif.js with a stand-in window has no screen to translate: the words stay as written.
  if (typeof document === 'undefined' || typeof document.createTreeWalker !== 'function' || typeof MutationObserver !== 'function') return;
  const HANGUL = /[\uAC00-\uD7A3]/; // 가-힣, written as escapes so the shared config/ohif.js reads the same in any page encoding
  const slots = /\{(?:[ten]?(\d+)|([A-Za-z]\w*))\}/g;
  const LANGS = ['en', 'ko'];
  const REGIONS = ['worklist', 'reading'];
  const NAMES = { en: 'English', ko: '한국어' };
  const terms = window.KinLanguageTerms || {};
  const glossary = new Map();
  const keyOf = text => text.replace(/\s+/g, ' ').trim();
  for (const [source, other, , same] of terms.terms || []) {
    const key = keyOf(source);
    glossary.set(key, HANGUL.test(key.replace(slots, ''))
      ? { en: other, ko: same || key } : { en: same || key, ko: other });
  }
  const sentences = new WeakSet(), englishOnly = new WeakSet();
  const isSentence = value => sentences.has(value);
  function say(template, ...params) {
    if (typeof template !== 'string') return template;
    const sentence = Object.freeze({ template, params: Object.freeze(params),
      toString() { return tr(this, state[lastRegion]); },
      toJSON() { return tr(this, null); },
    });
    sentences.add(sentence);
    return sentence;
  }
  // English only: a sentence that reads exactly as written unless its screen is English (words put on this path after the
  // Korean screen was settled, so a reader who chose Korean sees them as before).
  function sayEnglish(template, ...params) {
    const sentence = say(template, ...params);
    if (isSentence(sentence)) englishOnly.add(sentence);
    return sentence;
  }
  function tr(value, lang, visiting = new Set()) {
    if (!isSentence(value)) return value;
    if (visiting.has(value)) return '';
    visiting.add(value);
    // Its own words stay as written unless the screen is English; the sentences nested in it follow their own rule.
    const own = lang !== 'en' && englishOnly.has(value) ? null : lang;
    const { template, params } = value;
    const key = keyOf(template), translated = own && glossary.get(key)?.[own];
    const pattern = translated && translated !== key
      ? template.match(/^\s*/)[0] + translated + template.match(/\s*$/)[0] : template;
    const result = pattern.replace(slots, (slot, index, name) => {
      const arg = name === undefined ? params[index] : params[0]?.[name];
      if (arg === undefined) return slot;
      // Older callers wrap parts in {t} or {e}. Only a nested sentence carries a translation.
      const part = arg && typeof arg === 'object' && !isSentence(arg) ? arg.t ?? arg.e ?? '' : arg;
      return String(tr(part, lang, visiting));
    });
    visiting.delete(value);
    return result;
  }

  // ── Where a node is and what may change ───────────────────────────────────────────────────────────────────────
  const state = { worklist: null, reading: null };
  let lastRegion = 'worklist', generation = 0;
  const regionOf = el => {
    const marked = el?.closest?.('[data-kin-lang-region]');
    return marked ? marked.getAttribute('data-kin-lang-region') : lastRegion;
  };
  const langOf = el => state[regionOf(el)] || null;
  const ATTRS = ['title', 'aria-label', 'placeholder', 'alt', 'aria-valuetext', 'aria-description'];
  const records = new WeakMap(); // text node or attribute owner -> original UI sentences
  const targets = new Set();     // weak so discarded rows and closed windows can be collected
  const collected = new FinalizationRegistry(ref => targets.delete(ref));

  // Observe registered targets themselves. An ordinary write revokes ownership even if it writes
  // identical text, happens while detached, or is followed by Apply in the same task.
  function invalidate(changes) {
    for (const change of changes) records.get(change.target)?.delete(change.attributeName || '');
  }
  const writes = new MutationObserver(invalidate);
  const flush = () => invalidate(writes.takeRecords());
  function register(node, name, sentence) {
    let fields = records.get(node);
    if (!fields) {
      fields = new Map();
      records.set(node, fields);
      const ref = new WeakRef(node);
      targets.add(ref);
      collected.register(node, ref);
      writes.observe(node, name ? { attributes: true, attributeFilter: ATTRS } : { characterData: true });
    }
    fields.set(name, sentence);
  }
  function display(node, name, sentence) {
    const text = tr(sentence, langOf(name ? node : node.parentElement));
    if (name) {
      if (node.getAttribute(name) === text) return;
      node.setAttribute(name, text);
    } else {
      if (node.data === text) return;
      node.data = text;
    }
    // A custom element can synchronously write another registered field from attributeChangedCallback.
    // Only our first mutation belongs to the translator. Ordinary writes after it revoke their registrations.
    const [, ...ordinary] = writes.takeRecords();
    invalidate(ordinary);
  }
  function write(el, value, name = '') {
    if (!el) return el;
    flush();
    let node = el;
    if (!name && el.nodeType !== 3) {
      node = el.firstChild;
      if (node?.nodeType !== 3 || node.nextSibling) {
        node = el.ownerDocument.createTextNode('');
        el.replaceChildren(node);
      }
    }
    if (isSentence(value)) {
      register(node, name, value);
      display(node, name, value);
    } else {
      records.get(node)?.delete(name);
      const text = String(value ?? '');
      if (name) node.setAttribute(name, text);
      else if (node.data !== text) node.data = text;
    }
    return el;
  }
  // The page's own markup (the document at start, or a part markup() is given): a text node or a title-like attribute whose
  // whole text is a glossary entry. Korean only for a part built later, so a screen with Korean chosen keeps it as written.
  function registerMarkup(root, koreanOnly = false) {
    const skip = 'script,style,[translate="no"],[contenteditable="true"],[contenteditable=""]';
    const known = text => glossary.has(keyOf(text)) && (!koreanOnly || HANGUL.test(text));
    const phrase = koreanOnly ? sayEnglish : say;
    const top = root.nodeType === 9 ? root.documentElement : root;
    const walk = top.ownerDocument.createTreeWalker(top, 5 /* SHOW_ELEMENT | SHOW_TEXT */);
    for (let node = walk.currentNode; node; node = walk.nextNode()) {
      const el = node.nodeType === 3 ? node.parentElement : node;
      if (!el || el.closest(skip)) continue;
      if (node.nodeType === 3) {
        if (!el.closest('textarea,option:not([value])') && known(node.data))
          register(node, '', phrase(node.data));
      } else {
        const keep = (el.getAttribute('data-kin-keep') || '').split(' ');
        for (const name of ATTRS) {
          const text = el.getAttribute(name);
          if (text && !keep.includes(name) && known(text)) register(el, name, phrase(text));
        }
      }
    }
  }
  /** A part of the page its script built after start from its own markup alone (a dialog template with no data in it),
   *  registered as the page's markup is: its Korean words follow the language of their screen from now on. */
  function markup(root) {
    if (!root?.ownerDocument) return root;
    flush();
    registerMarkup(root, true);
    if (active()) {
      const walk = root.ownerDocument.createTreeWalker(root, 5);
      for (let node = root; node; node = walk.nextNode()) if (records.has(node)) refresh(node);
    }
    return root;
  }
  const docs = new Map();
  const active = () => REGIONS.some(r => state[r]);
  function refresh(node) {
    if (!node.isConnected || !docs.has(node.ownerDocument)) return;
    for (const [name, sentence] of records.get(node) || []) display(node, name, sentence);
  }
  function watchMoves(doc) {
    const observer = new MutationObserver(changes => {
      flush();
      if (!active()) return;
      // Moving a subtree (including adoption into the report window) can change its region.
      // Consult existing registrations only. Never infer a phrase from the current DOM.
      for (const change of changes) for (const root of change.addedNodes) {
        if (!root.isConnected) continue;
        const walk = doc.createTreeWalker(root, 5);
        for (let node = root; node; node = walk.nextNode()) if (records.has(node)) refresh(node);
      }
    });
    observer.observe(doc, { subtree: true, childList: true });
    docs.set(doc, observer);
  }
  function attach(doc, region) {
    if (!doc || docs.has(doc)) return () => {};
    if (region) doc.documentElement.setAttribute('data-kin-lang-region', region);
    watchMoves(doc);
    doc.addEventListener('pointerdown', remember, true);
    doc.addEventListener('keydown', remember, true);
    styleCss(doc);
    mark(doc);
    return () => {
      docs.get(doc)?.disconnect();
      docs.delete(doc);
      doc.removeEventListener('pointerdown', remember, true);
      doc.removeEventListener('keydown', remember, true);
    };
  }
  function mark(doc) {
    for (const r of REGIONS) { if (state[r]) doc.documentElement.setAttribute('data-kin-lang-' + r, state[r]); else doc.documentElement.removeAttribute('data-kin-lang-' + r); }
  }
  function repaint() {
    flush();
    for (const doc of docs.keys()) mark(doc);
    for (const ref of targets) {
      const node = ref.deref();
      if (node) refresh(node); else targets.delete(ref);
    }
    for (const el of validity.keys()) { if (el.isConnected) setValidity(el); else validity.delete(el); }
    showLabel();
  }

  // CSS content words (glossary css: [region, selector, English, Korean]).
  function styleCss(doc) {
    const rules = (terms.css || []).map(([region, selector, en, ko]) => LANGS.map(lang =>
      `html[data-kin-lang-${region}="${lang}"] ${selector}{content:${JSON.stringify(lang === 'en' ? en : ko)}}`).join('\n')).join('\n');
    if (!rules || !doc.head || doc.getElementById('kin-language-css')) return;
    const style = doc.createElement('style'); style.id = 'kin-language-css'; style.textContent = rules;
    doc.head.append(style);
  }

  // Words outside the page — alert, confirm, prompt and the validity message of a form field — are translated before the
  // browser shows them (alert and friends in the language of the screen last used; a field in the language of its own screen).
  let wrapped = false;
  const validity = new Map(); // element -> the message the page set
  const nativeValidity = new Map();
  function setValidity(el) {
    const native = nativeValidity.get(Object.getPrototypeOf(el)) || HTMLInputElement.prototype.setCustomValidity;
    const message = validity.get(el);
    native.call(el, message ? tr(message, langOf(el)) : '');
  }
  function wrapBrowser() {
    if (wrapped) return;
    wrapped = true;
    for (const name of ['alert', 'confirm', 'prompt']) {
      const native = window[name];
      if (typeof native !== 'function') continue;
      window[name] = function (message, ...rest) {
        const lang = state[lastRegion];
        // The question only: the value offered in a prompt and the answer belong to the reader.
        message = tr(message, lang);
        return native.call(this, message, ...rest);
      };
    }
  }
  // A form field validity message is recorded from the page start, so a later choice of language reaches one already set.
  for (const type of [HTMLInputElement, HTMLSelectElement, HTMLTextAreaElement, HTMLButtonElement, HTMLOutputElement, HTMLFieldSetElement, HTMLObjectElement]) {
    const proto = type.prototype, native = proto.setCustomValidity;
    if (typeof native !== 'function' || nativeValidity.has(proto)) continue;
    nativeValidity.set(proto, native);
    proto.setCustomValidity = function (message) {
      if (isSentence(message)) validity.set(this, message); else validity.delete(this);
      return native.call(this, message ? tr(message, langOf(this)) : message);
    };
  }
  wrapBrowser();
  const remember = e => { const el = e.target?.closest?.('[data-kin-lang-region]'); if (el) lastRegion = el.getAttribute('data-kin-lang-region'); };
  document.addEventListener('pointerdown', remember, true);
  document.addEventListener('keydown', remember, true);

  // ── The choice ────────────────────────────────────────────────────────────────────────────────────────────────
  const valid = v => v === null || LANGS.includes(v);
  /** The stored form {version: 1, worklist, reading}, or null when it is not one. */
  function normalize(v) {
    return v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).sort().join(',') === 'reading,version,worklist' &&
      v.version === 1 && valid(v.worklist) && valid(v.reading) ? { version: 1, worklist: v.worklist, reading: v.reading } : null;
  }
  const value = () => ({ version: 1, worklist: state.worklist, reading: state.reading });
  // The other documents (clinician, administration, audit and sign-in pages) keep no choice of their own: they follow the
  // choice the work page last applied in this browser, English only (a reader who chose Korean keeps them as they are).
  const BROWSER = 'kin-language:v1';
  const follows = document.documentElement.hasAttribute('data-kin-lang-browser');
  function set(next) {
    const clean = normalize(next);
    if (!clean) return false;
    generation += 1;
    const changed = REGIONS.some(r => state[r] !== clean[r]);
    state.worklist = clean.worklist; state.reading = clean.reading;
    if (!follows) try { localStorage.setItem(BROWSER, JSON.stringify(clean)); } catch (_) { /* the other documents keep their words */ }
    if (changed) { repaint(); paintDialog(); }
    return true;
  }
  function followBrowser() {
    let stored = null;
    try { stored = normalize(JSON.parse(localStorage.getItem(BROWSER))); } catch (_) { stored = null; }
    if (stored?.worklist === 'en') set({ version: 1, worklist: 'en', reading: null });
  }

  // The header mark: what the account chose (EN / KO, both when the screens differ); an account that never chose keeps
  // the mark and words of the page.
  let label = null, labelOrig = null;
  function showLabel() {
    label = label || document.getElementById('language-label');
    if (!label) return;
    if (labelOrig === null) labelOrig = { text: label.textContent, title: label.getAttribute('title'), translate: label.getAttribute('translate') };
    if (!active()) {
      label.textContent = labelOrig.text;
      if (labelOrig.translate === null) label.removeAttribute('translate');
      if (labelOrig.title !== null) label.setAttribute('title', labelOrig.title);
      return;
    }
    const mark = r => state[r] ? state[r].toUpperCase() : '—';
    label.setAttribute('translate', 'no');
    label.textContent = state.worklist === state.reading ? mark('worklist') : mark('worklist') + ' · ' + mark('reading');
    label.setAttribute('title', 'Language — Worklist: ' + (state.worklist ? NAMES[state.worklist] : '—') + ' · Reading screen: ' + (state.reading ? NAMES[state.reading] : '—'));
  }

  // ── Saving (reading-appearance-account.js connects the account) ──────────────────────────────────────────────
  let account = null;
  function connect(api) { account = api && typeof api.save === 'function' ? api : null; paintDialog(); }
  async function save(request) {
    if (!account) return { ok: false, message: '계정 설정을 불러오지 못해 언어를 저장할 수 없습니다. 다시 로그인한 뒤 시도하세요.' };
    const result = await account.save(request);
    return result && typeof result === 'object' ? result : { ok: false, message: '설정을 저장하지 못했습니다.' };
  }

  // ── The Language window and the bar under the screen ─────────────────────────────────────────────────────────
  // Their own words stay as they are (Language, the language names, Revert) so anyone can find the way back.
  const css = `
    #language-dialog { width: 460px; max-width: calc(100vw - 32px); box-sizing: border-box; background: var(--kin-panel, #172333); color: var(--kin-text, #dce7f5);
      border: 1px solid var(--kin-line2, #819bb7); border-radius: 8px; padding: 18px; font: 13px 'Malgun Gothic','Segoe UI',sans-serif; }
    #language-dialog::backdrop { background: #0008; }
    #language-dialog h2 { margin: 0 0 10px; font-size: 17px; }
    #language-dialog fieldset { border: 1px solid var(--kin-line2, #819bb7); border-radius: 4px; margin: 0 0 10px; display: flex; gap: 16px; flex-wrap: wrap; }
    #language-dialog table { width: 100%; border-collapse: collapse; margin: 6px 0 10px; font-size: 12px; }
    #language-dialog th, #language-dialog td { text-align: left; border-bottom: 1px solid var(--kin-line, #333c4d); padding: 4px 6px; vertical-align: top; }
    #language-dialog footer { display: flex; gap: 10px; justify-content: flex-end; }
    #language-dialog button { font: inherit; padding: 5px 12px; background: var(--kin-bg, #263b53); color: inherit; border: 1px solid var(--kin-line2, #849bb4); border-radius: 4px; }
    #language-dialog-status { min-height: 1.3em; margin: 0 0 8px; }
    #language-applied { position: fixed; left: 50%; bottom: 8px; transform: translateX(-50%); z-index: 2147483000; display: flex; gap: 10px; align-items: center;
      background: var(--kin-panel, #172333); color: var(--kin-text, #dce7f5); border: 1px solid var(--kin-line2, #819bb7); border-radius: 6px; padding: 6px 10px; font-size: 12px; box-shadow: 0 2px 10px #0008; }
    #language-applied[hidden] { display: none; }
    /* Korean letters draw taller lines than the Latin face of the reading screen (measured 3px per line at 11px): there the
       lines keep the English line height, so Korean words never push the report buttons down. */
    html[data-kin-lang-reading="ko"] .split > .right, html[data-kin-lang-reading="ko"] .split > .right :is(button, select, input, summary) { line-height: 1.15; }
    #language-applied button { font: inherit; padding: 3px 10px; background: var(--kin-bg, #263b53); color: inherit; border: 1px solid var(--kin-line2, #849bb4); border-radius: 4px; }
  `;
  let dialog = null, bar = null, busy = false, previous = null, applied = null;
  const make = (tag, props = {}, ...children) => { const el = Object.assign(document.createElement(tag), props); el.append(...children); return el; };
  const keep = el => { el.setAttribute('translate', 'no'); return el; };
  function sampleRows(choice, scopes) {
    const pick = (scope, words) => words.map(w => scopes[scope] && choice ? tr(say(w), choice) : w).join(' · ');
    return [
      ['Worklist', pick('worklist', ['StudyDate', 'Name', 'RS', 'Unread', '↻ Refresh'])],
      ['Reading screen', pick('reading', ['Findings', 'Conclusion', 'Approve', 'Save', 'Approve & Next'])],
      ['Patient / report data', 'KIM MINJUN · Brain CT (synthetic)'],
    ];
  }
  function buildDialog() {
    if (dialog) return dialog;
    dialog = make('dialog', { id: 'language-dialog' });
    dialog.setAttribute('aria-labelledby', 'language-title');
    dialog.setAttribute('data-kin-lang-region', 'worklist');
    const radio = lang => {
      const input = make('input', { type: 'radio', name: 'kin-language', value: lang, id: 'language-' + lang });
      return keep(make('label', { htmlFor: input.id }, input, ' ', lang === 'en' ? 'English' : '한국어 (Korean)'));
    };
    const check = (scope, words) => make('label', {}, make('input', { type: 'checkbox', id: 'language-scope-' + scope, checked: true }), ' ' + words);
    const status = make('p', { id: 'language-dialog-status' });
    status.setAttribute('role', 'status');
    dialog.append(keep(make('h2', { id: 'language-title' }, 'Language')),
      make('fieldset', {}, make('legend', {}, 'Display Language'), radio('en'), radio('ko')),
      make('fieldset', {}, make('legend', {}, 'Apply To'), check('worklist', 'Worklist'), check('reading', 'Reading screen')),
      make('h3', { style: 'font-size:13px;margin:4px 0' }, 'Example'), keep(make('table', { id: 'language-sample' })),
      make('p', { id: 'language-note' }, 'Patient and study data, reports and names people give stay as they are.'),
      status, make('footer', {}, make('button', { type: 'button', id: 'language-apply' }, 'Apply'), make('button', { type: 'button', id: 'language-close' }, 'Close')));
    document.body.append(dialog);
    dialog.addEventListener('change', paintDialog);
    dialog.querySelector('#language-close').addEventListener('click', () => dialog.close());
    dialog.querySelector('#language-apply').addEventListener('click', applyChoice);
    return dialog;
  }
  function chosen() {
    const lang = dialog.querySelector('input[name="kin-language"]:checked')?.value || null;
    const scopes = { worklist: dialog.querySelector('#language-scope-worklist').checked, reading: dialog.querySelector('#language-scope-reading').checked };
    return { lang, scopes };
  }
  function paintDialog() {
    if (!dialog) return;
    const { lang, scopes } = chosen();
    dialog.querySelector('#language-sample').replaceChildren(...sampleRows(lang, scopes).map(([screen, words]) => make('tr', {}, make('th', {}, screen), make('td', {}, words))));
    dialog.querySelector('#language-apply').disabled = busy || !account || !lang || !(scopes.worklist || scopes.reading);
  }
  function openDialog() {
    buildDialog();
    // The window starts from the choice of the worklist; an account that never chose has nothing ticked.
    for (const input of dialog.querySelectorAll('input[name="kin-language"]')) input.checked = input.value === state.worklist;
    dialog.querySelector('#language-scope-worklist').checked = true;
    dialog.querySelector('#language-scope-reading').checked = true;
    write(dialog.querySelector('#language-dialog-status'), account ? '' : sayEnglish('계정 설정을 불러온 뒤 언어를 저장할 수 있습니다.'));
    paintDialog();
    if (!dialog.open) dialog.showModal();
  }
  function showBar() {
    if (!bar) {
      bar = keep(make('div', { id: 'language-applied', hidden: true }));
      bar.setAttribute('role', 'status');
      document.body.append(bar);
    }
    const words = REGIONS.filter(r => state[r]).map(r => (r === 'worklist' ? 'Worklist' : 'Reading screen') + ': ' + NAMES[state[r]]).join(' · ');
    const revert = make('button', { type: 'button', id: 'language-revert' }, 'Revert');
    revert.addEventListener('click', revertChoice);
    bar.replaceChildren(make('span', { id: 'language-applied-text' }, 'Language — ' + (words || 'as before')), revert);
    bar.hidden = false;
  }
  async function applyChoice() {
    const { lang, scopes } = chosen();
    if (busy || !lang || !(scopes.worklist || scopes.reading)) return;
    const patch = {};
    for (const r of REGIONS) if (scopes[r]) patch[r] = lang;
    const status = dialog.querySelector('#language-dialog-status');
    busy = true; paintDialog(); write(status, sayEnglish('언어 설정을 저장하는 중…'));
    try {
      // The latest choice of the account changes only on the ticked screens; nothing on the screen changes until it is saved.
      const result = await save({ patch });
      if (!result.ok) { status.textContent = result.message; return; }
      previous = result.before; applied = result.language;
      set(result.language);
      status.textContent = '';
      dialog.close();
      showBar();
    } finally { busy = false; paintDialog(); }
  }
  async function revertChoice() {
    if (busy || !previous) return;
    const revert = bar.querySelector('#language-revert');
    busy = true; revert.disabled = true;
    try {
      // Back to the two values before Apply — unless another window changed the language since.
      const result = await save({ patch: { worklist: previous.worklist, reading: previous.reading }, expect: applied });
      if (!result.ok) { bar.querySelector('#language-applied-text').textContent = 'Language — ' + tr(result.message, state[lastRegion]); return; }
      set(result.language);
      previous = applied = null;
      bar.hidden = true; bar.replaceChildren();
    } finally { busy = false; if (revert.isConnected) revert.disabled = false; }
  }

  // Fixed parts of the page and the screen they belong to; anything else that floats over the page (toasts, menus)
  // follows the screen last used.
  const REGION_OF = {
    worklist: ['.menubar', '.split > .left', '#modal', '#batch-report-dialog', '#batch-approve-dialog', '#query-retrieve', '#study-transfer', '#ctx'],
    reading: ['.split > .right', '#reading-bar', '#reading-viewer', '#histmodal', '#stalemodal', '#tplmodal', '#tpl-preview', '#structmodal', '#cite-preview', '#reasonmodal', '#cvr-send'],
  };
  // ── Words as a string (the viewer, and words a page writes once) ──────────────────────────────────────────────
  // English only: a screen with Korean chosen or no choice gets the template filled with the values as written, exactly.
  const fill = (template, params) => template.replace(/\{[ten]?(\d+)\}/g, (slot, i) => String(params[i]));
  const english = () => state[lastRegion] === 'en';
  /** A product sentence ({0} data, {n0} number, {t0} words, {e0} message) as a string in the language of the screen. */
  function text(template, ...params) {
    return english() ? String(tr(say(template, ...params.map(String)), 'en')) : fill(template, params);
  }
  // Markup: each piece of text between tags and each title-like attribute value is its own phrase (the way the glossary
  // check reads a template); tags, other attributes and the values go in as written.
  const TAG = /<\s*\/?\s*[a-zA-Z][^<>]*>/g;
  const ATTR = /\b(title|aria-label|placeholder|alt|aria-description|aria-valuetext)(\s*=\s*)(?:"([^"]*)"|'([^']*)')/g;
  const ENTITY = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", nbsp: ' ' };
  const decode = s => s.replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (m, n) => ENTITY[n]);
  const encode = s => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  function phrase(part, params) {
    if (!HANGUL.test(part)) return fill(part, params);
    const order = [];
    const local = decode(part).replace(/\{([ten]?)(\d+)\}/g, (slot, kind, i) => {
      if (!order.includes(+i)) order.push(+i);
      return '{' + kind + order.indexOf(+i) + '}';
    });
    const key = keyOf(local), found = glossary.get(key)?.en;
    if (!found || found === key) return fill(part, params);
    const words = encode(String(tr(say(local, ...order.map((_, k) => '\u0001' + k + '\u0001')), 'en')));
    return words.replace(/\u0001(\d+)\u0001/g, (m, k) => String(params[order[k]]));
  }
  function html(template, ...params) {
    if (!english()) return fill(template, params);
    let out = '', at = 0;
    for (const tag of template.matchAll(TAG)) {
      out += phrase(template.slice(at, tag.index), params);
      let inner = '', from = 0;
      for (const a of tag[0].matchAll(ATTR)) {
        const value = a[3] ?? a[4], quote = a[3] !== undefined ? '"' : "'";
        inner += fill(tag[0].slice(from, a.index), params) + a[1] + a[2] + quote + phrase(value, params) + quote;
        from = a.index + a[0].length;
      }
      out += inner + fill(tag[0].slice(from), params);
      at = tag.index + tag[0].length;
    }
    return out + phrase(template.slice(at), params);
  }

  function start() {
    registerMarkup(document);
    watchMoves(document);
    for (const [region, selectors] of Object.entries(REGION_OF))
      for (const selector of selectors) document.querySelector(selector)?.setAttribute('data-kin-lang-region', region);
    styleCss(document);
    document.head.append(make('style', { id: 'language-style', textContent: css }));
    document.getElementById('language-open')?.addEventListener('click', openDialog);
    if (follows) followBrowser();
    // The choice kept for the viewer and the other documents is the account's: this page writes it again once the account's
    // choice is applied, so one another account left in this browser is not followed meanwhile.
    else try { localStorage.removeItem(BROWSER); } catch (_) { /* nothing kept */ }
    if (active()) repaint(); else showLabel();
  }
  // The viewer document (config/ohif.js sets KinLanguageDocument before this file runs): OHIF's page, so its markup is
  // never registered and nothing is stored. It is the image half of the reading screen: the words our viewer code writes
  // follow the reading-screen choice the work page last applied in this browser, English only, as the viewer opens.
  function startViewer() {
    lastRegion = 'reading';
    let stored = null;
    try { stored = normalize(JSON.parse(localStorage.getItem(BROWSER))); } catch (_) { stored = null; }
    if (stored?.reading === 'en') state.reading = 'en';
  }
  if (window.KinLanguageDocument === 'viewer') startViewer(); else start();

  /** The words the page wrote into this element (or one of its attributes), whatever language shows now. */
  function source(el, name) {
    if (!el) return null;
    flush();
    if (name) return tr(records.get(el)?.get(name), null) ?? el.getAttribute(name);
    let out = '';
    const walk = el.ownerDocument.createTreeWalker(el, 4);
    for (let node = walk.nextNode(); node; node = walk.nextNode())
      out += tr(records.get(node)?.get(''), null) ?? node.data;
    return out;
  }

  window.KinLanguage = {
    tr, say, sayEnglish, write, normalize, value, attach, source, connect, markup, text, html,
    /** The stored choice of the account (page start, Load Appearance). */
    restore: next => set(next),
    /** Changes with every choice applied, so a late answer read before it does not undo it. */
    generation: () => generation,
    lang: el => langOf(el),
  };
})();
