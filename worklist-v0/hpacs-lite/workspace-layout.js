/* Only display preferences belong here; patient, report and authentication data
 * must never be copied into a browser-wide workspace record. */
(function (root) {
  'use strict';
  const PREFIX = 'kin-workspace:v1:';
  const modes = ['auto', 'portrait', 'landscape'];
  const panels = ['main', 'top', 'related', 'prior'];
  const readingPanels = typeof module === 'object' && module.exports
    ? require('./reading-panel-layout.js') : root.KinReadingPanelLayout;
  const boxLayout = typeof module === 'object' && module.exports
    ? require('./box-layout.js') : root.KinBoxLayout;
  const defaults = () => ({ version: 1, mode: 'auto', portrait: {}, landscape: {} });
  const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  const workspaceDefaults = () => ({ version: 1, rail: null, worklist: null, related: null,
    prior: null, railCollapsed: false, studyPanelTab: 'info' });
  const axes = ['landscape', 'portrait'];
  // The reader's Study Panel width, height and Text Size step, per orientation like every panel size (pilot
  // D1160, W3R-07). Only what the reader changed is kept: a missing value is the default geometry, so the
  // record of a reader who never touched the options stays as it was, and older v3 records need no migration.
  function normalizeStudyPanel(value) {
    if (!object(value) || Object.keys(value).some(k => !axes.includes(k))) return null;
    const clean = {};
    for (const axis of axes.filter(a => Object.hasOwn(value, a))) {
      const chosen = value[axis], kept = {};
      if (!object(chosen) || Object.keys(chosen).some(k => !['width', 'height', 'text'].includes(k))) return null;
      for (const name of ['width', 'height'].filter(n => Object.hasOwn(chosen, n))) {
        if (!Number.isInteger(chosen[name]) || chosen[name] < 1 || chosen[name] > 16384) return null;
        kept[name] = chosen[name];
      }
      if (Object.hasOwn(chosen, 'text') && ![0, 1, 2].includes(chosen.text)) return null;
      if (chosen.text) kept.text = chosen.text;
      if (Object.keys(kept).length) clean[axis] = kept;
    }
    return clean;
  }
  // Report window panels the reader hid in Panel Settings (Minhoon 2026-10-27 item 9). Sparse like studyPanel: a
  // record without the field shows every panel, so records written before it need no migration.
  const PANELS = Object.freeze(['thumbnail', 'aiReport', 'imageReport', 'clinical', 'template']);
  function normalizeHidden(value) {
    if (!Array.isArray(value) || new Set(value).size !== value.length || value.some(k => !PANELS.includes(k))) return null;
    return PANELS.filter(k => value.includes(k));
  }
  // `field` is hiddenPanels (Panel Settings) or collapsedPanels (folded in place on the band): the same five panels,
  // two separate choices that never overwrite each other.
  function withPanelChoice(field, value, chosen) {
    const clean = toVersion3(value), panels = normalizeHidden(chosen);
    if (!clean || !panels) return null;
    const workspace = { ...clean.workspace };
    if (panels.length) workspace[field] = panels; else delete workspace[field];
    return normalize({ ...clean, workspace });
  }
  const withHiddenPanels = (value, hidden) => withPanelChoice('hiddenPanels', value, hidden);
  const withCollapsedPanels = (value, collapsed) => withPanelChoice('collapsedPanels', value, collapsed);
  function withBoxSwaps(value, swaps) {
    const clean = toVersion3(value), chosen = boxLayout.normalize(swaps);
    if (!clean || !chosen) return null;
    const workspace = { ...clean.workspace };
    if (chosen.length) workspace.boxSwaps = chosen; else delete workspace.boxSwaps;
    return normalize({ ...clean, workspace });
  }
  function normalizeV3(value) {
    if (Object.keys(value).some(k => !['version', 'mode', 'portrait', 'landscape', 'reading', 'workspace'].includes(k))) return null;
    const legacy = normalize({ version: 2, mode: value.mode, portrait: value.portrait,
      landscape: value.landscape, reading: value.reading });
    const workspace = value.workspace, clean = workspaceDefaults();
    if (!legacy || !object(workspace) || Object.keys(clean).some(k => !Object.hasOwn(workspace, k))
        || Object.keys(workspace).some(k => !Object.hasOwn(clean, k) && !['studyPanel', 'hiddenPanels', 'collapsedPanels', 'boxSwaps'].includes(k)) || workspace.version !== 1
        || typeof workspace.railCollapsed !== 'boolean'
        || !['images', 'info', 'templates'].includes(workspace.studyPanelTab)) return null;
    for (const name of ['rail', 'worklist', 'related', 'prior']) {
      const size = workspace[name];
      if (size !== null && (!Number.isInteger(size) || size < 1 || size > 16384)) return null;
    }
    // Panel sizes are kept per orientation in portrait/landscape. The shared
    // worklist/related/prior fields carry no axis, and a landscape width must
    // never become a portrait height: records from earlier builds read them as
    // null, and no build writes them.
    clean.rail = workspace.rail;
    clean.railCollapsed = workspace.railCollapsed; clean.studyPanelTab = workspace.studyPanelTab;
    if (Object.hasOwn(workspace, 'studyPanel')) {
      const studyPanel = normalizeStudyPanel(workspace.studyPanel);
      if (!studyPanel) return null;
      if (Object.keys(studyPanel).length) clean.studyPanel = studyPanel;
    }
    for (const field of ['hiddenPanels', 'collapsedPanels']) {
      if (!Object.hasOwn(workspace, field)) continue;
      const chosen = normalizeHidden(workspace[field]);
      if (!chosen) return null;
      if (chosen.length) clean[field] = chosen;
    }
    // The five boxes' places (box-layout.js); sparse, so a record without it is the default arrangement.
    if (Object.hasOwn(workspace, 'boxSwaps')) {
      const swaps = boxLayout.normalize(workspace.boxSwaps);
      if (!swaps) return null;
      if (swaps.length) clean.boxSwaps = swaps;
    }
    return { ...legacy, version: 3, workspace: clean };
  }
  // One orientation's Study Panel choice changed (width/height/text), or reset to the default (change null).
  function withStudyPanel(value, axis, change) {
    const clean = toVersion3(value);
    if (!clean || !axes.includes(axis) || (change !== null && !object(change))) return null;
    const studyPanel = { ...(clean.workspace.studyPanel || {}) };
    studyPanel[axis] = change === null ? {} : { ...(studyPanel[axis] || {}), ...change };
    return normalize({ ...clean, workspace: { ...clean.workspace, studyPanel } });
  }
  function normalize(value) {
    if (object(value) && value.version === 3) return normalizeV3(value);
    if (!object(value) || ![1, 2].includes(value.version) || !modes.includes(value.mode)
        || Object.keys(value).some(k => !['version', 'mode', 'portrait', 'landscape', ...(value.version === 2 ? ['reading'] : [])].includes(k))) return null;
    const clean = defaults();
    clean.mode = value.mode;
    if (value.version === 2) {
      const reading = readingPanels.normalize(value.reading);
      if (!reading) return null;
      clean.version = 2; clean.reading = reading;
    }
    for (const axis of ['portrait', 'landscape']) {
      const sizes = value[axis];
      if (!object(sizes) || Object.keys(sizes).some(k => !panels.includes(k))) return null;
      for (const name of Object.keys(sizes)) {
        const size = sizes[name];
        if (typeof size !== 'number' || !Number.isFinite(size) || size < 1 || size > 16384) return null;
        clean[axis][name] = Math.round(size);
      }
    }
    return clean;
  }
  function withReading(value, reading) {
    if (value?.version === 3) return normalize({ ...value, reading });
    return normalize({ ...value, version: 2, reading });
  }
  function toVersion3(value, current) {
    const clean = normalize(value);
    if (!clean || clean.version === 3) return clean;
    const previous = normalize(current);
    // Legacy records have no new geometry. Keep current choices on explicit
    // account Load; otherwise let the page resolve null sizes for its viewport.
    return normalize({ ...clean, version: 3,
      reading: clean.reading || previous?.reading || readingPanels.defaults(),
      workspace: previous?.workspace || workspaceDefaults() });
  }
  function mergeLoaded(current, incoming) {
    const clean = normalize(incoming);
    if (!clean) return null;
    if (clean.version === 3 || current?.version === 3) return toVersion3(clean, current);
    // Older account layouts contain no integrated-panel choice. Loading one
    // must not silently erase the arrangement the user is currently working in.
    return clean.version === 1 && current?.version === 2 ? withReading(clean, current.reading) : clean;
  }
  function key(session) {
    // Display names and email aliases can change or collide on a shared PC.
    if (!session || session.state !== 'approved' || session.demo) return null;
    if (![session.sub, session.institution].every(v => typeof v === 'string' && v.length > 0 && v.length <= 256)) return null;
    return PREFIX + JSON.stringify([session.institution, session.sub]);
  }
  function read(storage, owner) {
    if (!owner) return { state: defaults(), status: 'disabled' };
    try {
      const raw = storage.getItem(owner);
      if (raw === null) return { state: defaults(), status: 'empty' };
      if (typeof raw !== 'string' || raw.length > 2048) return { state: defaults(), status: 'invalid' };
      const state = normalize(JSON.parse(raw));
      return { state: state || defaults(), status: state ? 'restored' : 'invalid' };
    } catch (_) { return { state: defaults(), status: 'unavailable' }; }
  }
  function write(storage, owner, value) {
    const clean = normalize(value);
    if (!owner || !clean) return false;
    try {
      const raw = JSON.stringify(clean);
      if (raw.length > 2048) return false;
      storage.setItem(owner, raw); return true;
    }
    catch (_) { return false; }
  }
  function remove(storage, owner) {
    if (!owner) return false;
    try { storage.removeItem(owner); return true; }
    catch (_) { return false; }
  }
  const hiddenPanels = value => normalize(value)?.workspace?.hiddenPanels?.slice() || [];
  const boxSwaps = value => normalize(value)?.workspace?.boxSwaps?.slice() || [];
  const collapsedPanels = value => normalize(value)?.workspace?.collapsedPanels?.slice() || [];
  // Each of the five panels as the reader chose it: shown (not hidden in Panel Settings) and expanded (not folded on
  // the band). The two are separate: a folded panel hidden and shown again comes back folded. This is the one reading
  // of the record; the page's workspacePanels() adds where each panel is on screen now.
  function panelStates(value) {
    const hidden = hiddenPanels(value), collapsed = collapsedPanels(value);
    return Object.fromEntries(PANELS.map(key => [key, { shown: !hidden.includes(key), expanded: !collapsed.includes(key) }]));
  }
  // The report window band's one allocation (W-SPACE layout contract 2026-10-29). Each workflow mode has its content
  // panels with the shares it has always painted (main.html: Thumbnail 34%, Clinical 30%, Template the rest; Technician
  // drops Template and gives Clinical 66%). A shown panel's width is its share of the shares still shown, so hiding one
  // gives its width only to the others, in proportion. AI Report remains a placeholder tab: it owns no
  // column, and with Thumbnail hidden they are a full-width strip above the content row. Two separate width authorities
  // (a fixed flex share against the mode's inline 66%) let a placeholder toggle shrink Technician's Clinical (WS-05).
  // Image Report (the drawings attached to the report, and the way into the drawing window) is a Radiology column right
  // of Thumbnail, in the order of the item-9 list. Drawing is the radiologist's work, so Technician has no such column.
  const MODE_PANELS = Object.freeze({
    Radiology: Object.freeze([['thumbnail', 34], ['imageReport', 30], ['clinical', 30], ['template', 36]]),
    Technician: Object.freeze([['thumbnail', 34], ['clinical', 66]]),
  });
  const PLACEHOLDERS = Object.freeze(['aiReport']);
  // `hidden` and `collapsed` are the reader's choices and are never edited here: a panel the mode lacks stays chosen
  // for the other mode. A folded panel (shown, not hidden) owns no column either: its width goes to the expanded
  // panels by the same shares as hiding, and its name stays on the band as a button in the folded-panels row above
  // the columns (`folds`). With nothing expanded the band is that row (state 'folds') and its height goes to the
  // Related/report row, as with the placeholder strip; the stored band height stays for when a panel opens again.
  function reportWindow(mode, hidden = [], collapsed = []) {
    const off = new Set(hidden), folded = new Set(collapsed.filter(key => !off.has(key)));
    const modePanels = MODE_PANELS[mode] || MODE_PANELS.Radiology;
    const content = modePanels.filter(([key]) => !off.has(key) && !folded.has(key)).map(([key, share]) => ({ key, share }));
    const tabs = PLACEHOLDERS.filter(key => !off.has(key) && !folded.has(key));
    const folds = PANELS.filter(key => folded.has(key) && (PLACEHOLDERS.includes(key) || modePanels.some(([k]) => k === key)));
    const strip = !content.some(p => p.key === 'thumbnail') && tabs.length > 0;
    const state = content.length ? 'content' : strip ? 'tabs' : folds.length ? 'folds' : 'empty';
    const classes = {};
    for (const key of PANELS) {
      classes['kin-hide-' + key] = PLACEHOLDERS.includes(key) ? off.has(key) || folded.has(key) : !content.some(p => p.key === key);
      classes['kin-fold-' + key] = folds.includes(key);
    }
    classes['kin-report-window-strip'] = strip;
    classes['kin-report-window-tabs'] = state === 'tabs';
    classes['kin-report-window-folds'] = folds.length > 0;
    classes['kin-report-window-folded'] = state === 'folds';
    classes['kin-report-window-empty'] = state === 'empty';
    // Each shown content panel's grid column, so a panel left in the band keeps its own column while the Study Panel
    // drawer holds the others.
    const columns = Object.fromEntries(content.map((p, i) => [p.key, i + 1]));
    return { content, tabs, folds, strip, state, classes, columns };
  }
  const api = { PREFIX, PANELS, defaults, normalize, withReading, workspaceDefaults, toVersion3, withStudyPanel,
    withHiddenPanels, hiddenPanels, withCollapsedPanels, collapsedPanels, panelStates, withBoxSwaps, boxSwaps, reportWindow, mergeLoaded, key, read, write, remove };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.KinWorkspaceLayout = api;
})(globalThis);
