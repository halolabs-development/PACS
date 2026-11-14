/*
 * Screen language of the worklist and the reading screen (Korean / English), chosen per screen and kept in the
 * account (reading appearance version 12). An account that never chose keeps the screen exactly as it is.
 *
 * Every word on the screen passes one place: tr() reads the glossary (worklist-language-terms.js) and paint() writes the
 * result into a text node or a title-like attribute, keeping the words the page wrote so they come back unchanged.
 * Only whole glossary entries are translated: a sentence that carries data is a glossary template written where the
 * code builds it ({0} data shown as is, {t0} words the code chose, {e0} an error message). Data is never translated:
 * nothing inside translate=no, form fields, contenteditable text, an option whose text is its value, or an attribute
 * named in data-kin-keep. Words the page writes later (lists drawn again, dialogs, toasts, the Pop Out window) are
 * painted by one MutationObserver per document; alert, confirm, prompt and setCustomValidity are translated before
 * the browser shows them.
 */
(function () {
  'use strict';
  const HANGUL = /[가-힣]/;
  const SLOT = /\{[te]?\d+\}/;
  const LANGS = ['en', 'ko'];
  const REGIONS = ['worklist', 'reading'];
  const NAMES = { en: 'English', ko: '한국어' };
  // The general sentence before an error that has no text in the chosen language yet (the original follows it).
  const UNKNOWN_ERROR = '요청을 처리하지 못했습니다. 원문:';

  // ── Glossary ──────────────────────────────────────────────────────────────────────────────────────────────────
  // An entry is [words as the page writes them, the other language, kinds, the same language with translated names].
  const exact = new Map(), templates = [];
  const space = text => text.replace(/\s+/g, ' ').trim();
  const escape = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  function index(terms) {
    for (const term of terms || []) {
      if (!Array.isArray(term) || typeof term[0] !== 'string' || typeof term[1] !== 'string') continue;
      const source = space(term[0]), korean = HANGUL.test(source.replace(/\{[te]?\d+\}/g, ''));
      const entry = korean ? { en: term[1], ko: term[3] || source } : { en: term[3] || source, ko: term[1] };
      if (!SLOT.test(source)) { exact.set(source, entry); continue; }
      const slots = [], parts = source.split(/(\{[te]?\d+\})/);
      const pattern = parts.map(part => /^\{[te]?\d+\}$/.test(part) ? (slots.push(part), '(.*?)') : escape(part)).join('');
      const fixed = parts.filter(part => !/^\{[te]?\d+\}$/.test(part));
      templates.push({ re: new RegExp('^' + pattern + '$', 's'), slots, entry, anchor: fixed.slice().sort((a, b) => b.length - a.length)[0] || '',
        weight: fixed.join('').replace(/\s/g, '').length });
    }
    // The longest fixed words first; of two with the same words, the one that knows its parts are words or errors.
    const typed = t => t.slots.filter(slot => slot.length > 3).length;
    templates.sort((a, b) => b.weight - a.weight || typed(b) - typed(a));
  }
  const terms = window.KinLanguageTerms || { terms: [], css: [] };
  index(terms.terms);

  // Words of the other language: the ones a translation into lang should have replaced.
  const foreign = (text, lang) => lang === 'en' ? HANGUL.test(text) : !HANGUL.test(text) && /[A-Za-z]{2}/.test(text);
  const unknownError = (text, lang) => (exact.get(UNKNOWN_ERROR)?.[lang] || UNKNOWN_ERROR) + ' ' + text;
  const cache = { en: new Map(), ko: new Map() };
  function translate(text, lang, depth) {
    const hit = exact.get(text);
    if (hit) return hit[lang];
    for (const t of templates) {
      if (t.anchor && !text.includes(t.anchor)) continue;
      const m = t.re.exec(text);
      if (!m) continue;
      // A template with almost no words of its own ({0}건) only fits counts, never names or sentences.
      if (t.weight < 3 && t.slots.some((slot, k) => slot.length === 3 && !/^[\d\s.,:%+\-/()~–—]*$/.test(m[k + 1]))) continue;
      let out = t.entry[lang];
      t.slots.forEach((slot, k) => {
        const value = m[k + 1], kind = slot[1];
        let filled = value;
        if ((kind === 't' || kind === 'e') && depth < 3 && value.trim()) {
          filled = translate(space(value), lang, depth + 1);
          if (filled === space(value)) filled = value;
          if (kind === 'e' && filled === value && foreign(value, lang)) filled = unknownError(value.trim(), lang);
        }
        out = out.split(slot).join(filled);
      });
      return out;
    }
    return text;
  }
  /** The words of the page in lang (en or ko); null or words outside the glossary come back unchanged. */
  function tr(text, lang) {
    if (!lang || typeof text !== 'string' || !/[A-Za-z가-힣]/.test(text)) return text;
    const core = space(text);
    let out = cache[lang].get(core);
    if (out === undefined) { out = translate(core, lang, 0); cache[lang].set(core, out); }
    if (out === core) return text;
    return text.match(/^\s*/)[0] + out + text.match(/\s*$/)[0];
  }

  // ── Where a node is and what may change ───────────────────────────────────────────────────────────────────────
  const state = { worklist: null, reading: null };
  let lastRegion = 'worklist', generation = 0;
  const regionOf = el => {
    const marked = el?.closest?.('[data-kin-lang-region]');
    return marked ? marked.getAttribute('data-kin-lang-region') : lastRegion;
  };
  const langOf = el => state[regionOf(el)] || null;
  const FIELD = 'script,style,textarea,[contenteditable=""],[contenteditable="true"],[translate="no"]';
  function frozen(el) {
    if (!el || el.nodeType !== 1) return true;
    if (el.closest(FIELD)) return true;
    const option = el.closest('option');
    return !!option && !option.hasAttribute('value');
  }

  // The words the page wrote, kept per text node and per attribute so a later language (or none) starts from them.
  const texts = new WeakMap(), attrs = new WeakMap();
  const ATTRS = ['title', 'aria-label', 'placeholder', 'alt', 'aria-valuetext'];
  // Places that show an error (the page marks them): an error that has no text in the chosen language yet still says
  // what failed, in the chosen language, followed by the original words.
  const ERROR = '#toast.err, #err, [data-kin-error]';
  function paintText(node, forced) {
    const el = node.parentElement;
    const lang = forced === undefined ? (frozen(el) ? null : langOf(el)) : forced;
    const now = node.nodeValue;
    let rec = texts.get(node);
    if (rec && now !== rec.shown) rec = null; // the page wrote new words: they are the original now
    const orig = rec ? rec.orig : now;
    if (!lang && !rec) return;
    let want = lang ? tr(orig, lang) : orig;
    if (lang && want === orig && el?.closest(ERROR) && foreign(orig, lang)) want = unknownError(orig.trim(), lang);
    if (want !== now) node.nodeValue = want;
    if (want !== orig) texts.set(node, { orig, shown: want }); else texts.delete(node);
  }
  function paintAttr(el, name, forced) {
    const now = el.getAttribute(name);
    const map = attrs.get(el);
    let rec = map?.[name];
    if (now === null) { if (rec) delete map[name]; return; }
    if (rec && now !== rec.shown) rec = null;
    const orig = rec ? rec.orig : now;
    const keep = frozen(el) || (el.getAttribute('data-kin-keep') || '').split(' ').includes(name);
    const lang = forced === undefined ? (keep ? null : langOf(el)) : forced;
    if (!lang && !rec) return;
    const want = lang ? tr(orig, lang) : orig;
    if (want !== now) el.setAttribute(name, want);
    if (want !== orig) { let m = map; if (!m) attrs.set(el, m = {}); m[name] = { orig, shown: want }; } else if (map) delete map[name];
  }
  function paintTree(root, forced) {
    if (!root) return;
    if (root.nodeType === 3) return paintText(root, forced);
    if (root.nodeType !== 1) return;
    const walk = root.ownerDocument.createTreeWalker(root, 5 /* SHOW_ELEMENT | SHOW_TEXT */);
    for (let n = root; n; n = walk.nextNode()) {
      if (n.nodeType === 3) { if (n.nodeValue.trim()) paintText(n, forced); continue; }
      for (const name of ATTRS) if (n.hasAttribute(name)) paintAttr(n, name, forced);
    }
  }

  // ── Watching each document ────────────────────────────────────────────────────────────────────────────────────
  const docs = new Map(); // document -> { observer }
  function watch(doc) {
    const entry = docs.get(doc);
    if (!entry || entry.observer) return;
    entry.observer = new MutationObserver(records => {
      for (const r of records) {
        if (r.type === 'characterData') paintText(r.target);
        else if (r.type === 'attributes') paintAttr(r.target, r.attributeName);
        else for (const n of r.addedNodes) if (n.isConnected) paintTree(n);
      }
    });
    entry.observer.observe(doc.documentElement, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ATTRS });
  }
  const active = () => REGIONS.some(r => state[r]);
  /** Another document showing the reading screen (the report Pop Out window): painted and watched like the page. */
  function attach(doc, region) {
    if (!doc || docs.has(doc)) return;
    docs.set(doc, { observer: null });
    if (region) doc.documentElement.setAttribute('data-kin-lang-region', region);
    styleCss(doc);
    mark(doc);
    if (active()) { paintTree(doc.documentElement); watch(doc); }
  }
  function mark(doc) {
    for (const r of REGIONS) { if (state[r]) doc.documentElement.setAttribute('data-kin-lang-' + r, state[r]); else doc.documentElement.removeAttribute('data-kin-lang-' + r); }
  }
  const originalLang = document.documentElement.getAttribute('lang');
  function repaint() {
    for (const [doc, entry] of docs) {
      if (!doc.defaultView || doc.defaultView.closed) { entry.observer?.disconnect(); docs.delete(doc); continue; }
      mark(doc);
      paintTree(doc.documentElement);
      if (active()) watch(doc); else { entry.observer?.disconnect(); entry.observer = null; }
    }
    if (state.worklist) document.documentElement.lang = state.worklist;
    else if (originalLang !== null) document.documentElement.lang = originalLang; else document.documentElement.removeAttribute('lang');
    if (active()) wrapBrowser();
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
    native.call(el, message ? tr(message, frozen(el.parentElement) ? null : langOf(el)) : '');
  }
  function wrapBrowser() {
    if (wrapped) return;
    wrapped = true;
    for (const name of ['alert', 'confirm', 'prompt']) {
      const native = window[name];
      if (typeof native !== 'function') continue;
      window[name] = function (message, ...rest) {
        const lang = state[lastRegion];
        if (lang && typeof message === 'string') {
          message = tr(message, lang);
          if (name === 'prompt' && typeof rest[0] === 'string') rest[0] = tr(rest[0], lang);
        }
        return native.call(this, message, ...rest);
      };
    }
    for (const type of [HTMLInputElement, HTMLSelectElement, HTMLTextAreaElement, HTMLButtonElement, HTMLOutputElement, HTMLFieldSetElement, HTMLObjectElement]) {
      const proto = type.prototype, native = proto.setCustomValidity;
      if (typeof native !== 'function' || nativeValidity.has(proto)) continue;
      nativeValidity.set(proto, native);
      proto.setCustomValidity = function (message) {
        if (message) validity.set(this, String(message)); else validity.delete(this);
        return native.call(this, message ? tr(String(message), langOf(this)) : message);
      };
    }
  }
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
  function set(next) {
    const clean = normalize(next);
    if (!clean) return false;
    generation += 1;
    const changed = REGIONS.some(r => state[r] !== clean[r]);
    state.worklist = clean.worklist; state.reading = clean.reading;
    if (changed) { repaint(); paintDialog(); }
    return true;
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
    #language-applied button { font: inherit; padding: 3px 10px; background: var(--kin-bg, #263b53); color: inherit; border: 1px solid var(--kin-line2, #849bb4); border-radius: 4px; }
  `;
  let dialog = null, bar = null, busy = false, previous = null, applied = null;
  const make = (tag, props = {}, ...children) => { const el = Object.assign(document.createElement(tag), props); el.append(...children); return el; };
  const keep = el => { el.setAttribute('translate', 'no'); return el; };
  function sampleRows(choice, scopes) {
    const pick = (scope, words) => words.map(w => scopes[scope] && choice ? tr(w, choice) : w).join(' · ');
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
    dialog.querySelector('#language-dialog-status').textContent = account ? '' : '계정 설정을 불러온 뒤 언어를 저장할 수 있습니다.';
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
    busy = true; paintDialog(); status.textContent = '언어 설정을 저장하는 중…';
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
  function start() {
    docs.set(document, { observer: null });
    for (const [region, selectors] of Object.entries(REGION_OF))
      for (const selector of selectors) document.querySelector(selector)?.setAttribute('data-kin-lang-region', region);
    styleCss(document);
    document.head.append(make('style', { id: 'language-style', textContent: css }));
    document.getElementById('language-open')?.addEventListener('click', openDialog);
    showLabel();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true }); else start();

  /** The words the page wrote into this element (or one of its attributes), whatever language shows now. */
  function source(el, name) {
    if (!el) return null;
    if (name) { const now = el.getAttribute(name), rec = attrs.get(el)?.[name]; return rec && rec.shown === now ? rec.orig : now; }
    let out = '';
    const walk = el.ownerDocument.createTreeWalker(el, 4 /* SHOW_TEXT */);
    for (let n = walk.nextNode(); n; n = walk.nextNode()) { const rec = texts.get(n); out += rec && rec.shown === n.nodeValue ? rec.orig : n.nodeValue; }
    return out;
  }

  window.KinLanguage = {
    tr, normalize, value, attach, source, connect,
    /** The stored choice of the account (page start, Load Appearance). */
    restore: next => set(next),
    /** Changes with every choice applied, so a late answer read before it does not undo it. */
    generation: () => generation,
    lang: el => langOf(el),
  };
})();
