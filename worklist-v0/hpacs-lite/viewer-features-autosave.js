// Viewer feature module: Auto Save View. With the account setting "Save view changes automatically and apply on reopen"
// on, the view of this study is saved to the reader's account a moment after it last changed (each cell's zoom and pan,
// window, rotation and flip, the image it shows by SOP and frame, its Display Set Presets rule, and the layout), when a
// patient tab is switched and when the window is closed. When the study is opened again in a new viewer, the saved view
// is put back over the viewer's own first layout and a badge says what was put back. A Job chosen to open wins. One
// saved view per reader and study, kept apart from the Jobs; Display ▾ › Auto Save View… shows it and discards it.
// Pure rules: viewer-auto-view-model.js. Marks are not part of the saved view (they are saved items of their own), but the
// same setting saves them too without their Save button: config/ohif/history.js asks window.KinViewerAutoSave.marks().
(() => {
  // Studies this document has shown before: a patient tab brought back keeps the view the tab held (viewer-patient-tabs.js),
  // so only the first opening of a study in a document puts the saved view back.
  const opened = new Set();
  const DEBOUNCE = 2000, QUIET = 600, START_MS = 30000, SETTINGS_MS = 15000, BADGE_MS = 8000, RULES_MS = 10000, DRAWN_MS = 20000;
  const UID = /^[0-9]+(?:\.[0-9]+)+$/;
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

  window.KinViewerFeatures?.module('autosave', async ({ services, session, store, ui }) => {
    // The restores the address chose that are changing this window's screen now (viewer-jobs.js holdOpening). This
    // screen counts the holds taken from its own start on: one taken before it belongs to a screen that is over.
    const openings = window.kinViewerOpeningRestore ||= { screen: 0, holds: new Set() }, screen = openings.screen;
    await ui.load(['viewer-auto-view-model.js']);
    const model = window.KinAutoViewModel;
    const grid = services.viewportGridService, cells = services.cornerstoneViewportService, sets = services.displaySetService;
    const native = window.cornerstone, events = native?.Enums?.Events || {};
    const rendered = native?.Enums?.ViewportStatus?.RENDERED || 'rendered';
    const search = location.search, query = new URLSearchParams(search);
    const exam = window.KinViewerExamScope?.snapshot();
    const examReference = exam ? window.KinExamScope.snapshotReference(exam) : null;
    const studies = (query.get('StudyInstanceUIDs') || '').split(',').filter(Boolean);
    const valid = studies.length >= 1 && studies.length <= (exam ? 20 : 8) && studies.every(uid => uid.length <= 64 && UID.test(uid)) && new Set(studies).size === studies.length;
    const study = valid ? studies[0] : null, reportUid = exam?.reportUid || study;
    const path = study ? '/api/studies/' + reportUid + '/viewer-auto-view' : null;
    const scopeKey = exam ? window.KinExamScope.key(exam.current) : null;
    const account = () => { const owner = session?.owner?.(); return owner ? JSON.stringify(owner) : null; };
    let owner = account();
    const sameOwner = () => { owner ??= account(); return owner !== null && owner === account(); };
    const openingKey = JSON.stringify([owner, scopeKey || studies.join(',')]);
    const scopedPath = suffix => path + suffix + (examReference ? '?exam=' + encodeURIComponent(JSON.stringify(examReference)) : '');
    const firstOpening = valid && !opened.has(openingKey);
    if (valid) opened.add(openingKey);
    // A Job (or a finding's saved location) chosen to open this viewer wins over the saved view: the saved view is not
    // put back. Nothing waits for that Job. While it is being put on the screen nothing is saved, and the screen it
    // leaves is the starting point (landing, below).
    const jobChosen = ['kinJob', 'kinFinding'].some(name => query.has(name));
    const abort = new AbortController(), { signal } = abort;
    const convert = (lower, upper) => native?.utilities?.windowLevel?.toWindowLevel?.(lower, upper);
    // An unanswered first read holds writes. Once the layout is known, each pane can finish independently.
    let ended = false, on = false, phase = 'starting', timer = null, chain = Promise.resolve(), epoch = 0;
    let last;  // undefined: not read yet; null: nothing saved; else { snapshot, savedAt }
    let painter = null, badge = null, badgeTimer = null;
    // held: a Hanging Protocol still being laid out with its cell rules (nothing is saved meanwhile; hpRun counts the
    // protocols applied); discarding: Discard Saved View on its way (the view it discards is not sent again).
    let held = false, hpRun = 0, discarding = false;
    // restoreRun: turning the check off ends the putting back of the saved view that was going on (restoreAt).
    let restoreRun = 0, restoreAt = -1;
    // The server's Discard generation is pinned at capture, even for queued/closing saves. A rejected old capture is
    // never relabelled with a newer generation; only a subsequent capture may use it.
    const viewerId = crypto.randomUUID();
    let order = 0, lastAt = 0;
    let generation = null, reading = null;
    function observeGeneration(value) {
      if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,18})$/.test(value)) return false;
      if (generation !== null && BigInt(value) < BigInt(generation)) return false;
      generation = value; return true;
    }
    const stamp = () => (lastAt = Math.max(Date.now(), lastAt + 1));
    // issued: the view of the latest save sent or queued (or the view taken as the starting point); waiting: queued
    // saves not answered yet; outside: saves sent outside the queue not answered yet.
    let issued = { text: null, seq: 0 }, waiting = 0;
    const outside = new Set();
    const pending = new Map();  // capture sequence -> Discard generation, including saves still waiting in the queue
    // floor: the place in order of the starting point (rebase, below); settling: no starting point could be taken yet.
    let floor = 0, settling = false, waitingForImage = false;

    const element = (tag, text, parent, className) => {
      const node = document.createElement(tag); if (text) node.textContent = text; if (className) node.className = className; parent?.append(node); return node;
    };
    const style = element('style', `
.kin-auto-view-badge{position:absolute;left:50%;bottom:28px;transform:translateX(-50%);pointer-events:auto;background:#0b182bdd;border:1px solid #6de6ff;border-radius:4px;padding:3px 8px;font:12px/1.4 sans-serif;color:#fff;cursor:pointer;white-space:nowrap}
.kin-auto-view-note{color:var(--kin-ux-secondary);margin:0 0 6px;max-width:40em}
.kin-auto-view-row{display:flex;flex-wrap:wrap;align-items:center;gap:.4em;margin:6px 0}
`, document.head);

    // ── Cells ──
    const ordered = () => { try { return [...grid.getState().viewports.values()].sort((a, b) => a.y - b.y || a.x - b.x); } catch (_) { return []; } };
    const stackOf = id => { try { const v = cells.getCornerstoneViewport(id); return v?.type === 'stack' && v.element?.isConnected !== false ? v : null; } catch (_) { return null; } };
    const instance = id => { try { return native.metaData.get('instance', id) || null; } catch (_) { return null; } };
    const setOf = id => { try { return grid.getState().viewports.get(id)?.displaySetInstanceUIDs?.[0] || ''; } catch (_) { return ''; } };
    const switching = () => ['kin-patient-switching', 'kin-viewer-empty'].some(name => document.body.classList.contains(name));
    const live = () => !ended && location.search === search && !session?.ended?.();
    const restoring = () => live() && sameOwner() && on && restoreAt === restoreRun && !landing();
    // A restore the address chose is changing this screen now. No length of time ends it: only that restore letting go.
    const landing = () => { for (const hold of openings.holds) if (hold.screen >= screen) return true; return false; };
    // Such a restore has held this screen at some time, be it over before this viewer was here to hear of it.
    const restoredHere = () => openings.held >= screen;
    const writer = () => sameOwner() && session?.writer?.() !== false && !session?.ended?.();
    const list = value => Array.from(value || [], Number);

    const panes = new Map(), drawnImages = new WeakMap();
    let partialLayout = null;
    // Edits made while reading or replacing the layout travel with the original viewport's series.
    const opening = new Map();
    let watchingOpening = firstOpening && !jobChosen, initialGrid;
    function readPane(id) {
      const v = stackOf(id);
      try {
        const image = v?.getCurrentImageId(), key = image && model.imageKey(image, instance);
        if (!key || !isDrawn(v, image) || !studies.includes(key.study) ||
            exam && !window.KinViewerExamScope.allows(exam, key.study, key.series)) return null;
        const camera = v.getCamera() || {}, properties = v.getProperties() || {}, range = properties.voiRange;
        if (!range) return null;
        const display = window.KinViewerCellRules?.rule?.(id) ?? null;
        const presentation = v.getViewPresentation({ zoom: true, pan: true, rotation: true });
        const rotation = presentation.rotation ?? camera.rotation ?? 0;
        const cell = { study: key.study, series: key.series, sop: key.sop, frame: key.frame,
          index: v.getCurrentImageIdIndex?.() ?? 0, zoom: presentation.zoom,
          camera: { focalPoint: list(camera.focalPoint), position: list(camera.position), viewUp: list(camera.viewUp), viewPlaneNormal: list(camera.viewPlaneNormal),
            parallelScale: camera.parallelScale, rotation, flipHorizontal: !!camera.flipHorizontal, flipVertical: !!camera.flipVertical },
          properties: { voiRange: { lower: range.lower, upper: range.upper }, VOILUTFunction: properties.VOILUTFunction || 'LINEAR', invert: !!properties.invert,
            interpolationType: properties.interpolationType ?? 1 }, display };
        const pan = list(presentation.pan);
        return pan.length === 2 && pan.every(Number.isFinite) && model.validCell(cell) && v.getCurrentImageId() === image && isDrawn(v, image)
          ? { cell, pan } : null;
      } catch (_) { return null; }
    }
    // Resizing changes the camera's world coordinates and fit scale. The host keeps this image-relative presentation.
    function sameReaderView(before, now) {
      const a = before.cell, b = now.cell;
      return a.study === b.study && a.series === b.series && a.sop === b.sop && a.frame === b.frame &&
        Math.abs(a.zoom - b.zoom) <= 0.0015 * a.zoom && agrees(now.pan, before.pan) &&
        agrees(b.camera.rotation, a.camera.rotation) && b.camera.flipHorizontal === a.camera.flipHorizontal &&
        b.camera.flipVertical === a.camera.flipVertical && agrees(b.properties, a.properties) && agrees(b.display, a.display);
    }
    // Without a stored pane (including a Job landing), the first drawn camera represents this presentation until it changes.
    const capturedPanes = new WeakMap();
    function visibleCell(id, now = readPane(id)) {
      if (!now) return null;
      const v = stackOf(id), before = capturedPanes.get(v);
      if (before && sameReaderView(before, now)) return before.cell;
      capturedPanes.set(v, now);
      return now.cell;
    }
    function observeCell(id, adjusting = false) {
      const v = stackOf(id), image = v?.getCurrentImageId?.(), set = setOf(id);
      if (!image || !set) return null;
      let record = opening.get(id);
      if (!record || record.viewport !== v || record.set !== set) {
        record = { viewport: v, set, image, base: null, edit: null };
        opening.set(id, record);
      }
      const now = readPane(id);
      // Camera and VOI notifications can expose intermediate writes on an already drawn image. Keep the last
      // sample in case the stack moves before its render; otherwise compare at render or at the restore boundary.
      record.beforeMove = adjusting ? now : null;
      if (adjusting && now) return record;
      if (now) {
        const moved = record.image !== image, changedView = record.base && !sameReaderView(record.base, now);
        if (moved && record.expected === image) record.expected = null;
        else if (moved || changedView) record.edit = now;
        if (!record.edit) record.first = now.cell;
        if (!record.base || moved || changedView) record.base = now;
        record.image = image;
      } else {
        // The first stable values after a draw belong to the viewer. A move to another source still belongs to the reader.
        record.base = null;
      }
      return record;
    }
    function observeOpening() {
      if (watchingOpening) for (const g of ordered()) observeCell(g.viewportId);
    }

    function gridView(state, views, cells) {
      const active = views.findIndex(g => g.viewportId === state.activeViewportId);
      return { version: 1, studies: [...studies], rows: state.layout?.numRows, cols: state.layout?.numCols,
        active: Math.max(0, active), cells };
    }

    // The first complete screen can arrive one pane at a time. Fill only its previously unreadable slots;
    // an edit already made in a different pane must still compare against that pane's own starting value.
    function observeFirst(id, cell) {
      const start = issued.start, slot = start?.missing.get(id);
      if (!cell || !slot || slot.set !== setOf(id)) return;
      start.view.cells[slot.index] = cell;
      start.missing.delete(id);
      issued.text = JSON.stringify(start.view);
      if (!start.missing.size) delete issued.start;
    }

    function capture(currentCells) {
      const state = grid.getState(), views = ordered(), layout = state.layout || {};
      const rows = layout.numRows, cols = layout.numCols;
      if ((layout.layoutType && layout.layoutType !== 'grid') || !(rows >= 1 && rows <= 4 && cols >= 1 && cols <= 4) || views.length !== rows * cols) return null;
      const uniform = views.every((g, i) => g.x === undefined || (Math.abs(g.x - (i % cols) / cols) <= 1e-6 && Math.abs(g.y - Math.floor(i / cols) / rows) <= 1e-6 &&
        Math.abs(g.width - 1 / cols) <= 1e-6 && Math.abs(g.height - 1 / rows) <= 1e-6));
      if (!uniform) return null;
      if (partialLayout && (views.length !== partialLayout.visible.size ||
          views.some(g => partialLayout.visible.get(g.viewportId) !== setOf(g.viewportId)))) partialLayout = null;
      const saved = [];
      for (const g of views) {
        const ids = g.displaySetInstanceUIDs || [];
        const pane = panes.get(g.viewportId);
        if (ids.length > 1) return null;
        if (pane && (pane.set === (ids[0] || '') || !pane.placed && !ids.length)) {
          if (pane.placed) {
            const now = readPane(g.viewportId);
            if (now && !sameReaderView(pane.base, now)) {
              pane.value = now.cell;
              pane.base = now;
            }
          }
          saved.push(pane.value);
        } else if (!ids.length || partialLayout?.visible.get(g.viewportId) === setOf(g.viewportId)) saved.push(null);
        else {
          const now = readPane(g.viewportId);
          if (!now) return null;
          const cell = visibleCell(g.viewportId, now);
          if (!partialLayout && now.cell !== cell) currentCells?.set(saved.length, now.cell);
          observeFirst(g.viewportId, cell);
          saved.push(cell);
        }
      }
      if (partialLayout) {
        const { view, targets } = partialLayout;
        const values = view.cells.map((cell, i) => panes.get(targets[i])?.value ?? cell);
        const selected = targets.indexOf(state.activeViewportId);
        return model.validate({ ...view, cells: values, active: selected < 0 ? view.active : selected }, study, exam ? 20 : 8);
      }
      return model.validate(gridView(state, views, saved), study, exam ? 20 : 8);
    }
    const captured = currentCells => { try { return capture(currentCells); } catch (error) { console.error(error); return null; } };
    // A Job or finding owns the entire screen until it lands. Its completed screen becomes the save baseline,
    // ordered after every earlier capture so that an outstanding request cannot force it to be sent again.
    function rebase(first = false) {
      const now = captured();
      if (!now && first && !restoredHere()) { settling = false; return; }
      settling = !now;
      if (!now) return;
      floor = first ? 0 : ++order;
      issued = { text: JSON.stringify(now), seq: floor };
    }

    // The session owner is [institution, subject], shared by this reader's windows but not by another account.
    let channel = null;
    try {
      channel = new BroadcastChannel('kin-auto-view');
      channel.onmessage = ({ data }) => {
        const owner = account();
        if (!live() || !sameOwner() || !owner || data?.owner !== owner || data.study !== study || (data.scopeKey ?? null) !== scopeKey ||
            data.generation === generation || !observeGeneration(data.generation)) return;
        // Treat the view present at Discard as already issued. Old captures retain their old generation, and neither
        // a pending timer nor closing the window may revive this view. Only the reader's next change is saved.
        cancelPlacement();
        const now = captured(); issued = { text: now ? JSON.stringify(now) : null, seq: ++order };
        last = null; painter?.();
      };
    } catch (_) { channel = null; }

    // ── Requests (each save waits for the one before it; Discard waits for them all and so comes last) ──
    async function request(url, options = {}) {
      const response = await fetch(url, { credentials: 'same-origin', cache: 'no-store', ...options,
        headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}) } });
      const value = await response.json().catch(() => null);
      return { ok: response.ok, status: response.status, value };
    }
    function read() {
      if (!reading) reading = readView().finally(() => { reading = null; });
      return reading;
    }
    async function readView() {
      if (!path || !sameOwner()) return;
      let answer;
      try { answer = await request(scopedPath(''), { signal }); } catch (_) { return; }
      if (!live() || !sameOwner() || !answer.ok || !observeGeneration(answer.value?.generation)) return;
      const view = answer.value?.view, snapshot = view ? model.validate(view.snapshot, study, exam ? 20 : 8) : null;
      if (view !== null && !snapshot) return;
      last = snapshot ? { snapshot, savedAt: view.savedAt } : null;
      painter?.();
      return last;
    }
    // mode: 'queue' (after the save before it), 'now' (at once, outside the queue: a patient switch, the viewer ending)
    // or 'close' (at once with keepalive: the window closing). None is cancelled when this viewer ends.
    async function send(snapshot, text, at, seq, when, capturedGeneration, mode) {
      let reached = false;
      try {
        if (!sameOwner()) return;
        const answer = await request(scopedPath(''), { method: 'POST', body: JSON.stringify({ snapshot, writer: viewerId, seq, at: when, generation: capturedGeneration }), ...(mode === 'close' ? { keepalive: true } : {}) });
        reached = answer.ok;
        const current = sameOwner() && answer.ok && observeGeneration(answer.value?.generation);
        if (current && at === epoch && answer.value?.saved !== false && capturedGeneration === generation) { last = { snapshot, savedAt: answer.value?.savedAt || new Date().toISOString() }; painter?.(); }
      } catch (_) { reached = false; }
      // A save that did not reach the server leaves its view unsent: the next chance (a change, the switch, the window
      // closing) sends it again.
      if (!reached && issued.seq === seq) issued = { text: null, seq };
    }
    // Saves the view when it differs from the last one sent. Going away ('now', 'close') while another save is still
    // waiting or on its way, the view on the screen is sent anyway, last in order. Nothing is captured while a restore
    // the address chose is landing (the window closing included): a save captured before it still goes.
    function save(mode = 'queue') {
      if (!on || phase !== 'ready' || held || discarding || landing() || !path || !writer()) return chain;
      // No starting point yet: this look takes one if the screen can be captured now. Either way nothing is sent
      // (going away included); what the reader changes after it is.
      if (settling) { rebase(); return chain; }
      if (window.KinViewerCellRules?.busy?.()) { if (mode === 'queue') changed(); return chain; }
      if (generation === null) { read().then(() => { if (live() && on && generation !== null) changed(); }); return chain; }
      const currentCells = new Map(), snapshot = captured(currentCells);
      waitingForImage = !snapshot;
      if (!snapshot) return chain;
      const text = JSON.stringify(snapshot);
      // An old-generation request cannot overwrite this generation. It must not force the unchanged, discarded view
      // to be captured again merely because the window closes before that old request answers. Nor does a save from
      // before the starting point: the screen a restore left is not sent because the reader's earlier view is still
      // on its way (that request goes on, and its own answer settles it).
      const canOverwrite = [...pending].some(([seq, taken]) => seq > floor && taken === generation);
      if (text === issued.text && !(mode !== 'queue' && canOverwrite)) return chain;
      // Once a reader edit calls for a save, include the current drawn camera for panes with no reserved value.
      for (const [index, cell] of currentCells) snapshot.cells[index] = structuredClone(cell);
      const at = epoch, seq = ++order, when = stamp(), capturedGeneration = generation;
      issued = { text, seq };
      pending.set(seq, capturedGeneration);
      if (mode !== 'queue') {
        const going = send(snapshot, text, at, seq, when, capturedGeneration, mode).finally(() => pending.delete(seq));
        outside.add(going); going.finally(() => outside.delete(going));
        return chain;
      }
      waiting++;
      chain = chain.then(async () => {
        if (at === epoch && !ended && on && !held && !window.KinViewerCellRules?.busy?.()) await send(snapshot, text, at, seq, when, capturedGeneration, 'queue');
        else {
          if (issued.seq === seq) issued = { text: null, seq };
          if (at === epoch && !ended && on && !held) changed();
        }
      }).catch(() => {}).finally(() => { waiting--; pending.delete(seq); });
      return chain;
    }
    function changed() {
      if (!ended && on && phase === 'unread') { openSaved().catch(error => console.error(error)); return; }
      if (ended || !on || phase !== 'ready') return;
      // With no starting point yet this is not a change to save after a quiet moment: save() looks at the screen now.
      if (settling) { if (!switching()) save(); return; }
      if (generation === null && !timer) read();
      clearTimeout(timer);
      timer = setTimeout(() => { timer = null; if (!ended && !switching()) save(); }, DEBOUNCE);
    }
    // Discard Saved View: it waits for every save sent before it (queued or not), and the server refuses any save of
    // this reader taken before it (from this viewer or an earlier one) that arrives after it.
    async function discard() {
      cancelPlacement();
      epoch++; clearTimeout(timer); timer = null; discarding = true;
      // The view on the screen as Discard is pressed is the one discarded: it is not sent again afterwards either.
      const seq = ++order, when = stamp(), shownNow = captured();
      issued = { text: shownNow ? JSON.stringify(shownNow) : null, seq };
      const before = [chain, ...outside];
      let ok = false;
      chain = (async () => {
        await Promise.all(before.map(going => Promise.resolve(going).catch(() => {})));
        try {
          if (!sameOwner()) return;
          const answer = await request(scopedPath('/discard'), { method: 'POST', body: JSON.stringify({ writer: viewerId, seq, at: when }), signal });
          ok = sameOwner() && answer.ok;
          if (ok && observeGeneration(answer.value?.generation)) {
            const owner = account();
            if (owner) try { channel?.postMessage({ owner, study, generation, ...(scopeKey ? { scopeKey } : {}) }); } catch (_) {}
          }
        } catch (_) { ok = false; }
        if (ok) { last = null; const now = captured(); issued = { text: now ? JSON.stringify(now) : null, seq }; }
      })();
      try { await chain; } finally { discarding = false; }
      return ok;
    }

    // ── Putting the saved view back ──
    // The display set showing the saved image and frame: one multi-frame file can be split into a set per time point,
    // so the viewer's own rule (series-split.js) decides; without it no file is split and the SOP alone names the set.
    const holdsImage = (d, sop, frame) => typeof window.kinSeriesSplitHolds === 'function' ? window.kinSeriesSplitHolds(d, sop, frame)
      : d.images.some(image => image?.SOPInstanceUID === sop);
    const wantedSet = cell => {
      if (!cell || exam && !window.KinViewerExamScope.allows(exam, cell.study, cell.series)) return null;
      let found = [];
      try { found = sets.getActiveDisplaySets().filter(d => d.StudyInstanceUID === cell.study && d.SeriesInstanceUID === cell.series &&
        (!Array.isArray(d.images) || holdsImage(d, cell.sop, cell.frame))); } catch (_) { found = []; }
      return found.length === 1 ? found[0].displaySetInstanceUID : null;
    };
    function isDrawn(v, image) {
      if (!image || v.getCornerstoneImage?.()?.imageId !== image || window.kinViewerDisplayImageSettled?.(v) === false) return false;
      // A window change puts an already displayed stack image back into PRE_RENDER. Its camera and
      // window are still readable. A new stack image must earn its own first render.
      if (v.viewportStatus === rendered) {
        drawnImages.set(v, image);
        return true;
      }
      return v.viewportStatus === undefined || v.viewportStatus === (native?.Enums?.ViewportStatus?.PRE_RENDER || 'preRender') && drawnImages.get(v) === image;
    }
    // Cameras can round during a world-to-canvas conversion. Compare the applied camera, since the reported
    // zoom is relative to the fit of the current window and can differ from the saved percentage.
    function agrees(actual, expected) {
      if (typeof expected === 'number') return Math.abs(actual - expected) <= 1e-6 * Math.max(1, Math.abs(expected));
      if (expected && typeof expected === 'object') return !!actual && Object.keys(expected).every(key => agrees(actual[key], expected[key]));
      return actual === expected;
    }
    function cancelPlacement() {
      restoreRun++;
      watchingOpening = false;
      opening.clear(); panes.clear(); partialLayout = null;
      clearTimeout(badgeTimer); badge?.remove(); badge = null;
    }
    function place(pane, now, edited) {
      pane.placed = true;
      pane.watch = null;
      pane.base = now;
      if (edited) pane.value = now.cell;
    }
    // Keep the last trustworthy source and values until this cell can be read again.
    function readerChanged(id, pane) {
      if (!pane.watch || pane.placed || pane.writing) return false;
      const record = observeCell(id);
      if (!record?.edit || record.viewport !== pane.watch.viewport || record.set !== pane.set) return false;
      if (pane.moving) return true;
      place(pane, record.edit, true);
      changed();
      return true;
    }
    async function restoreCell(id, pane, stored, previous) {
      const until = Date.now() + DRAWN_MS;
      const current = () => restoring() && panes.get(id) === pane && setOf(id) === pane.set;
      while (restoring() && panes.get(id) === pane && (!current() || !stackOf(id)?.getCurrentImageId?.())) {
        if (Date.now() >= until) return null;
        await wait(50);
      }
      if (!current()) return null;
      const v = stackOf(id), still = () => current() && stackOf(id) === v && !pane.placed;
      pane.watch = observeCell(id);
      if (readerChanged(id, pane)) return null;
      let edit = previous?.edit, cell = edit?.cell || stored;
      const find = () => model.findImage(v.getImageIds(), instance, cell.sop, cell.frame);
      if (!v || !cell || wantedSet(cell) !== pane.set || find() < 0) return null;

      // Ignore the synchronous events from our own writes. Across an await, only the move to the requested
      // source belongs to this operation. A zoom or a move to a different image remains a reader edit.
      function write(fn, expected) {
        pane.writing = true;
        try { return fn(); }
        finally {
          pane.writing = false;
          const image = v.getCurrentImageId();
          pane.watch.expected = image === expected ? null : expected;
          pane.watch.image = image;
          pane.watch.beforeMove = null;
          pane.watch.base = readPane(id);
        }
      }
      function takePendingEdit() {
        const pending = pane.watch?.edit;
        if (!pending) return false;
        edit = pending; cell = pending.cell;
        pane.watch.edit = null;
        return true;
      }
      let rule = null;
      if (cell.display) {
        const limit = Date.now() + RULES_MS;
        while (!window.KinViewerCellRules && Date.now() < limit && still()) await wait(100);
        if (!still() || readerChanged(id, pane)) return null;
        const rules = window.KinViewerCellRules;
        if (!rules) return null;
        pane.moving = true;
        try { rule = await rules.restore(id, cell.display, () => still() && !pane.watch.edit, write); }
        finally { pane.moving = false; }
        if (!still() || !takePendingEdit() && !rule) return null;
      }

      const target = () => {
        const key = model.imageKey(v.getCurrentImageId(), instance);
        return key && key.study === cell.study && key.series === cell.series && key.sop === cell.sop && key.frame === cell.frame;
      };
      while (still() && !target()) {
        if (readerChanged(id, pane)) return null;
        const index = find();
        if (index < 0 || Date.now() >= until) return null;
        const next = v.getImageIds()[index];
        clearTimeout(v.debouncedTimeout);
        if ('targetImageIdIndex' in v) v.targetImageIdIndex = index;
        pane.moving = true;
        try {
          await write(() => typeof v.setImageIdIndex === 'function' ? v.setImageIdIndex(index) :
            native?.utilities?.jumpToSlice?.(v.element, { imageIndex: index }), next);
        } finally { pane.moving = false; }
        if (!still() || !takePendingEdit() && !target()) return null;
      }
      const image = v.getCurrentImageId();
      while (still()) {
        if (readerChanged(id, pane) || !target()) return null;
        if (isDrawn(v, image)) break;
        if (Date.now() >= until) return null;
        await wait(50);
      }
      const onImage = () => still() && target() && isDrawn(v, image);
      if (!onImage() || !readPane(id) || readerChanged(id, pane)) return null;
      pane.watch = null;
      v.setProperties({ invert: false, VOILUTFunction: 'LINEAR' });
      if (!onImage()) return null;
      v.setProperties(structuredClone(cell.properties));
      if (!onImage()) return null;
      v.setCamera({ flipHorizontal: cell.camera.flipHorizontal, flipVertical: cell.camera.flipVertical });
      if (!onImage()) return null;
      const camera = structuredClone(cell.camera); delete camera.flipHorizontal; delete camera.flipVertical;
      v.setCamera(camera);
      v.render?.();
      while (still() && target() && !isDrawn(v, image) && Date.now() < until) await wait(50);
      const now = readPane(id), actual = now?.cell;
      if (!actual || !onImage() || !agrees(actual.properties, cell.properties) || !agrees(actual.camera, cell.camera)) return null;
      place(pane, now, !!edit);
      if (edit) { changed(); return null; }
      return { actual, zoom: true, window: true, image: true, index: actual.index, rule };
    }

    async function restore(view, keepLayout) {
      observeOpening();
      const views = ordered(), state = grid.getState(), wanted = view.cells.map(wantedSet);
      const sameLayout = state.layout?.numRows === view.rows && state.layout?.numCols === view.cols && views.length === view.cells.length;
      const old = views.map(g => opening.get(g.viewportId));
      let targets = views.map(g => g.viewportId);
      const matches = sameLayout && view.cells.every((cell, i) => cell ? wanted[i] && setOf(targets[i]) === wanted[i] : !setOf(targets[i]));
      const previous = wanted.map(set => {
        const i = old.findIndex(record => record?.set === set);
        return i < 0 ? null : old.splice(i, 1)[0];
      });
      keepLayout ||= old.some(record => record?.edit);
      const replace = !keepLayout && !matches && view.cells.every((cell, i) => !cell || wanted[i]);
      if (replace) {
        targets = view.cells.map(() => 'kin-auto-view-' + crypto.randomUUID());
        await grid.setLayout({ numRows: view.rows, numCols: view.cols, activeViewportId: targets[view.active], isHangingProtocolLayout: false,
          findOrCreateViewport: index => ({ displaySetInstanceUIDs: wanted[index] ? [wanted[index]] : [], displaySetOptions: [{}],
            viewportOptions: { viewportId: targets[index], viewportType: 'stack', toolGroupId: 'default', allowUnmatchedView: true } }) });
        const until = Date.now() + DRAWN_MS;
        while (restoring() && !ordered().some(g => targets.includes(g.viewportId))) {
          if (Date.now() >= until) return;
          await wait(50);
        }
      }
      if (!restoring()) return;
      if (keepLayout || !matches && !replace) {
        // A missing series can prevent restoring the layout itself. Keep its stored slot and find the available
        // series in the current grid, even when the two layouts have different dimensions.
        const remaining = [...views];
        targets = wanted.map(set => {
          const i = set ? remaining.findIndex(g => setOf(g.viewportId) === set) : -1;
          return i < 0 ? null : remaining.splice(i, 1)[0].viewportId;
        });
        if (!keepLayout) partialLayout = { view, targets, visible: new Map(views.map(g => [g.viewportId, setOf(g.viewportId)])) };
      }
      watchingOpening = false;
      // Register every reservation before any restore emits events or a closing save reads the whole grid.
      for (const [i, id] of targets.entries()) {
        if (!id) continue;
        panes.set(id, { set: wanted[i] || '', value: view.cells[i] ?? null, placed: false, watch: null });
      }
      const active = targets[view.active];
      if (!keepLayout && active && wanted[view.active] && setOf(active) === wanted[view.active]) grid.setActiveViewportId?.(active);
      phase = 'ready';
      if (keepLayout) {
        // A source chosen while the read was pending wins in its own pane. Other original panes can still restore.
        for (const g of views) {
          const id = g.viewportId, set = setOf(id);
          if (panes.has(id) && initialGrid.get(id) === set) continue;
          panes.delete(id);
        }
        issued = { text: JSON.stringify(view), seq: floor };
        changed();
      } else rebase(true);
      const results = [];
      targets.forEach((id, i) => {
        const pane = panes.get(id), cell = view.cells[i];
        if (!pane || pane.placed || !cell || !wanted[i]) return;
        restoreCell(id, pane, cell, previous[i]).then(result => {
          if (!result || !restoring() || panes.get(id) !== pane) return;
          results[i] = result;
          const actualView = { ...view, cells: view.cells.map((saved, n) => results[n]?.actual || saved) };
          const at = results[view.active] ? view.active : results.findIndex(Boolean);
          showBadge(targets[at], model.restoredText(actualView, results, convert));
        }).catch(error => console.error(error)).finally(() => {
          if (restoring() && panes.get(id) === pane && !pane.placed && !pane.watch && setOf(id) === pane.set) {
            opening.delete(id);
            pane.watch = observeCell(id);
          }
        });
      });
    }
    function showBadge(viewportId, text) {
      clearTimeout(badgeTimer); badge?.remove(); badge = null;
      const layer = ui.cellLayer(viewportId);
      if (!layer) { ui.toast(text); return; }
      const node = element('button', text, layer, 'kin-auto-view-badge');
      node.type = 'button'; node.title = 'Auto Save View'; node.dataset.autoViewBadge = '';
      node.onclick = () => open();
      badge = layer;
      badgeTimer = setTimeout(() => { layer.remove(); if (badge === layer) badge = null; }, BADGE_MS);
    }

    // ── Start: the viewer's first layout and images, then the saved view, then saving ──
    const gridText = () => {
      try {
        const state = grid.getState();
        return JSON.stringify([state.layout?.numRows, state.layout?.numCols, ordered().map(g => [g.viewportId, g.displaySetInstanceUIDs, stackOf(g.viewportId)?.getCurrentImageId?.() || null])]);
      } catch (_) { return ''; }
    };
    async function firstView() {
      let before = null, since = 0;
      for (const until = Date.now() + START_MS; Date.now() < until;) {
        if (!live()) return false;
        const shownHere = !switching() && ordered().some(g => { const v = stackOf(g.viewportId), image = v?.getCurrentImageId?.(), meta = image && instance(image); return meta && studies.includes(meta.StudyInstanceUID); });
        const now = gridText();
        if (shownHere && now === before) { if (Date.now() - since >= QUIET) return true; }
        else { before = now; since = Date.now(); }
        await wait(100);
      }
      return false;
    }
    // A restore the address chose, on this screen. 'begin' is heard just before it first changes the screen, with no
    // hold taken yet: what the reader changed and is still waiting to be saved is captured and sent now, before the
    // restore covers it. 'end' is heard when it has let go: with no other still landing, the screen it left is the new
    // starting point at once (rebase: a change right after it is the reader's, and a window closing right after it
    // sends nothing). Whatever changed meanwhile was the restore's. A viewer not saving yet takes its starting point
    // when it starts; one whose restore never began hears nothing.
    addEventListener('kin-viewer-opening-restore', ({ detail }) => {
      if (ended || !detail?.hold || !(detail.hold.screen >= screen)) return;
      if (detail.phase === 'begin') { if (!landing()) { clearTimeout(timer); timer = null; save('now'); cancelPlacement(); } return; }
      if (landing()) return;
      clearTimeout(timer); timer = null;
      if (phase === 'ready') rebase();
    }, { signal });
    let known;
    const settingsRead = new Promise(resolve => { known = resolve; });
    store.subscribe('autoSaveView', value => {
      const was = on;
      on = value === true;  // anything else (absent, malformed) is off
      known();
      // Off ends the putting back that is going on and the saves waiting in the queue.
      if (!on) { clearTimeout(timer); timer = null; if (was) { cancelPlacement(); epoch++; } }
      else if (!was && phase === 'ready') { if (generation === null) read(); changed(); }
      painter?.();
    });
    // The marks' side of the setting (the History panel saves each mark as it is drawn or changed): on, for a writer, while
    // this viewer is up. It does not wait for the view's own start or a restore landing, which concern the view only, nor
    // for the address (a patient tab changes it before this viewer ends). A later viewer's own answer is not taken away.
    const marks = { marks: () => on && !ended && writer() };
    window.KinViewerAutoSave = marks;
    (async () => {
      await Promise.race([settingsRead, wait(SETTINGS_MS)]);
      if (!live() || !study) return;
      const started = await firstView();
      if (!live()) return;
      if (started && on) {
        restoreAt = restoreRun;
        initialGrid = new Map(ordered().map(g => [g.viewportId, setOf(g.viewportId)]));
        await openSaved();
      } else {
        watchingOpening = false; opening.clear();
        phase = 'ready'; rebase(true);
      }
    })().catch(error => console.error(error));

    async function openSaved() {
      phase = 'restoring';
      observeOpening();
      const saved = await read();
      if (!live() || !sameOwner()) return;
      if (watchingOpening && restoring()) {
        if (saved === undefined) { phase = 'unread'; return; }
        // A finding opened in this document may already have replaced the first layout during the read.
        const views = ordered();
        const keepLayout = initialGrid.size !== views.length || views.some(g => initialGrid.get(g.viewportId) !== setOf(g.viewportId));
        if (saved) {
          try { await restore(saved.snapshot, keepLayout); }
          catch (error) { console.error(error); }
          if (phase === 'ready') return;
          if (restoring()) { phase = 'unread'; return; }
        } else {
          observeOpening();
          watchingOpening = false;
          const missing = new Map();
          const baseline = gridView(grid.getState(), views, views.map(({ viewportId: id }, index) => {
            const record = opening.get(id), set = setOf(id);
            const cell = record?.edit ? record.first : visibleCell(id);
            if (set && !cell && !record?.edit) missing.set(id, { set, index });
            return cell ?? null;
          }));
          phase = 'ready';
          issued = { text: keepLayout ? null : JSON.stringify(baseline), seq: floor };
          if (!keepLayout && missing.size) issued.start = { view: baseline, missing };
          if (keepLayout || [...opening.values()].some(record => record.edit)) changed();
          opening.clear();
          return;
        }
      }
      watchingOpening = false; opening.clear();
      phase = 'ready';
      rebase(true);
    }

    // ── What changes the view ──
    observeOpening();
    function observeEvent(event) {
      const id = event.detail?.viewportId, pane = panes.get(id);
      const v = stackOf(id);
      if (event.type === events.PRE_STACK_NEW_IMAGE || event.type === events.STACK_NEW_IMAGE) drawnImages.delete(v);
      if (event.type === events.PRE_STACK_NEW_IMAGE) {
        const record = opening.get(id);
        if (record?.beforeMove && record.viewport === v && record.set === setOf(id)) {
          if (record.base && !sameReaderView(record.base, record.beforeMove)) record.edit = record.beforeMove;
          record.beforeMove = null;
        }
        return;
      }
      if (event.type === events.IMAGE_RENDERED && v?.element === event.target && v.viewportStatus === rendered) {
        const image = v.getCornerstoneImage?.()?.imageId;
        if (image && image === v.getCurrentImageId()) drawnImages.set(v, image);
      }
      const adjusting = event.type === events.CAMERA_MODIFIED || event.type === events.VOI_MODIFIED;
      if (watchingOpening && id) observeCell(id, adjusting);
      if (pane && !pane.placed && pane.set === setOf(id)) {
        if (pane.watch && !pane.writing) {
          if (adjusting) observeCell(id, true);
          else readerChanged(id, pane);
        }
        return;
      }
      if (issued.start?.missing.has(id)) observeFirst(id, visibleCell(id));
      if (event.type !== events.IMAGE_RENDERED || waitingForImage || settling) {
        waitingForImage = false;
        changed();
      }
    }
    for (const name of [events.CAMERA_MODIFIED, events.VOI_MODIFIED, events.PRE_STACK_NEW_IMAGE, events.STACK_NEW_IMAGE, events.IMAGE_RENDERED, 'kin-display-image-settled']) {
      if (name) document.addEventListener(name, observeEvent, { capture: true, signal });
    }
    const subscriptions = [];
    for (const name of new Set([grid?.EVENTS?.GRID_STATE_CHANGED, grid?.EVENTS?.LAYOUT_CHANGED, grid?.EVENTS?.ACTIVE_VIEWPORT_ID_CHANGED].filter(Boolean)))
      try { const subscription = grid.subscribe(name, () => { observeOpening(); changed(); }); if (subscription) subscriptions.push(subscription); } catch (error) { console.error(error); }
    // A Hanging Protocol applied: its cell rules are put on the cells next. Nothing is saved (after a quiet moment, on a
    // patient switch or as the window closes) until Display Set Presets and any replacement pass finish, and then the
    // grid has stood still for the quiet time. There is no time
    // limit: a pass still going is not taken for one that has ended. A later protocol takes the place of an earlier one.
    async function steady(run) {
      let before = null, since = 0;
      while (live() && run === hpRun) {
        if (window.KinViewerCellRules?.busy?.()) { before = null; since = 0; await wait(100); continue; }
        // Even a replacement that finishes between checks (overlay/camera only) starts a fresh quiet interval.
        const now = JSON.stringify([gridText(), window.KinViewerCellRules?.revision?.()]);
        if (now === before) { if (Date.now() - since >= QUIET) return true; }
        else { before = now; since = Date.now(); }
        await wait(100);
      }
      return false;
    }
    addEventListener('kin-hanging-protocol-applied', () => {
      const run = ++hpRun;
      held = true; clearTimeout(timer); timer = null;
      (async () => {
        await wait(0);  // Display Set Presets hears the same event and starts its pass of the protocol's rules
        const rules = window.KinViewerCellRules;
        const outcome = typeof rules?.settled === 'function' ? await rules.settled() : 'none';
        if (run !== hpRun || outcome === 'ended' || !await steady(run) || run !== hpRun) return;
        held = false; changed();
      })().catch(error => console.error(error));
    }, { signal });
    // The window closing, and a patient tab switching (the view is read before the next patient's images come).
    addEventListener('pagehide', () => { if (timer) { clearTimeout(timer); timer = null; } save('close'); }, { signal });
    const classes = new MutationObserver(() => {
      if (!document.body.classList.contains('kin-patient-switching')) return;
      // Sent at once, outside the queue, and kept going when this viewer ends with the switch.
      clearTimeout(timer); timer = null; save('now');
    });
    classes.observe(document.body, { attributes: true, attributeFilter: ['class'] });

    // ── The window: Display ▾ › Auto Save View…, and Viewer Settings › Tools & Display ──
    function open() {
      const handle = ui.panel({ id: 'auto-save-view', title: 'Auto Save View' });
      if (!handle) return;
      const body = handle.body; body.replaceChildren();
      element('p', 'Saves the view of this study as you change it — zoom and pan, window, rotation and flip, the image each cell shows, each cell\'s '
        + 'display set rule and the layout — and applies it when the study is opened again. Opening a Job shows the Job instead. '
        + 'Marks (measurements, arrows, text, key images) are saved too as soon as they are drawn or changed, without their Save button.', body, 'kin-auto-view-note');
      const label = element('label', '', body, 'kin-auto-view-row');
      const input = element('input', '', label); input.type = 'checkbox';
      element('span', 'Save view changes automatically and apply on reopen', label);
      input.setAttribute('aria-label', 'Save view changes automatically and apply on reopen');
      const savedLine = element('p', '', body); savedLine.dataset.autoViewSaved = '';
      const row = element('div', '', body, 'kin-auto-view-row');
      const discardButton = element('button', 'Discard Saved View', row); discardButton.type = 'button';
      const line = element('p', '', body, 'kin-auto-view-note'); line.setAttribute('role', 'status');
      let busy = false;
      function paint() {
        if (!input.isConnected) return;
        if (!busy) input.checked = on;
        input.disabled = busy || !writer();
        savedLine.textContent = last === undefined ? 'Reading the saved view of this study…'
          : last ? 'Last saved ' + new Date(last.savedAt).toLocaleString() + ' · ' + model.summary(last.snapshot, convert) : model.summary(null);
        discardButton.disabled = busy || !last || !writer();
      }
      input.onchange = async () => {
        const want = input.checked;
        busy = true; paint(); line.textContent = 'Saving the setting…';
        let ok = false;
        try { ok = await store.set('autoSaveView', want); } catch (_) { ok = false; }
        busy = false;
        if (handle.element.isConnected) {
          line.textContent = !ok ? 'The setting was not saved.' : want ? 'On: view changes are saved and applied when this study is opened again.' : 'Off: views are neither saved nor applied. A saved view stays until it is discarded.';
          paint();
        }
      };
      discardButton.onclick = async () => {
        busy = true; paint(); line.textContent = 'Discarding…';
        const ok = await discard();
        busy = false;
        if (handle.element.isConnected) { line.textContent = ok ? 'The saved view of this study was discarded.' : 'The saved view was not discarded. Try again.'; paint(); }
      };
      painter = paint;
      handle.onClose(() => { if (painter === paint) painter = null; });
      paint();
      if (last === undefined) read();
      handle.focus();
    }
    ui.menuItem('Display', { id: 'autoSaveView', label: 'Auto Save View…', order: 900, run: () => open(), enabled: () => !!study });
    ui.setting({ id: 'autoSaveViewCheck', kind: 'check', label: 'Save view changes automatically and apply on reopen', order: 65, key: 'autoSaveView', default: false });
    ui.setting({ id: 'autoSaveView', kind: 'button', label: 'Auto Save View…', order: 65, run: () => open() });

    return () => {
      // A save that was waiting (for the quiet moment or in the queue) goes now, while the cells are still this study's.
      if (timer || waiting) { clearTimeout(timer); timer = null; save('now'); }
      ended = true; abort.abort(); classes.disconnect(); channel?.close(); painter = null;
      if (window.KinViewerAutoSave === marks) delete window.KinViewerAutoSave;
      for (const subscription of subscriptions) try { subscription.unsubscribe?.(); } catch (_) {}
      clearTimeout(badgeTimer); badge?.remove(); style.remove();
    };
  });
})();
