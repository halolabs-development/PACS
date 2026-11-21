/* The viewer document (one of the shared sources of config/ohif.js, before the glossary and worklist-language.js): marks the
 * document for the translator, which then leaves OHIF's page alone, and gives our viewer code its write path.
 * kinText / kinHtml: a product sentence ({0} data, {n0} number, {t0} words, {e0} message) as a string in the language the
 * reader chose for the reading screen (English only); otherwise the template filled with the values as written. kinError
 * is an Error with such a sentence, marked kinWords: code that keeps "one of our own messages" tells them apart by the mark,
 * since in English their words no longer have Hangul in them. The viewer
 * scripts in worklist-v0/hpacs-lite declare the same two functions, so each also runs where the translator is not loaded. */
window.KinLanguageDocument = 'viewer';
function kinText(t, ...p) { const l = typeof window === 'object' && window && window.KinLanguage; return l && l.text ? l.text(t, ...p) : t.replace(/\{[ten]?(\d+)\}/g, (m, i) => String(p[i])); }
function kinHtml(t, ...p) { const l = typeof window === 'object' && window && window.KinLanguage; return l && l.html ? l.html(t, ...p) : t.replace(/\{[ten]?(\d+)\}/g, (m, i) => String(p[i])); }
function kinError(t, ...p) { return Object.assign(new Error(kinText(t, ...p)), { kinWords: true }); }
