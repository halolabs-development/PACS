// Viewer feature module: MG menu — Mirrored, Quadrant Zoom, Tomo (DBT) Slices, Breast Display, Mammo Keypad and
// Magnifier. It registers through viewer-features.js; the calculations are in mg-breast-model.js. Only stack cells with
// an MG image (or a breast tomosynthesis stack) take part. Laterality, view and the stored orientation come from the
// image's own DICOM header (mammography-model.js), read from the same DICOMweb service the viewer reads. Every display
// change is made only when the reader presses for it, is marked on the cell it changed and goes back in one step.
(() => {
  // A Patient ▶ move remounts the viewer, and this module with it: the keypad opens again there with the move's result.
  const carry = { busy: false, message: null, listener: null, reportTarget: null };

  window.KinViewerFeatures?.module('mg', async ({ services, ui }) => {
    await ui.load('mg-breast-model.js');
    const M = window.KinMgBreastModel, core = window.cornerstone, events = core?.Enums?.Events || {};
    const grid = services.viewportGridService, cellService = services.cornerstoneViewportService;
    const abort = new AbortController(), { signal } = abort;
    let ended = false;
    const timers = new Set();

    const element = (tag, text, parent, className) => {
      const node = document.createElement(tag); if (text) node.textContent = text; if (className) node.className = className; parent?.append(node); return node;
    };
    const button = (text, parent, click, title) => { const node = element('button', text, parent); node.type = 'button'; node.onclick = click; if (title) node.title = title; return node; };
    const note = (text, parent) => element('p', text, parent, 'kin-mg-note');
    const statusLine = parent => { const node = element('p', '', parent, 'kin-mg-status'); node.setAttribute('role', 'status'); return node; };
    const style = element('style', `
.kin-mg-layer{position:absolute;inset:0;pointer-events:none;z-index:6}
.kin-mg-badges{position:absolute;left:50%;top:22px;transform:translateX(-50%);display:flex;flex-direction:column;align-items:center;gap:3px;font:11px sans-serif;color:#fff}
.kin-mg-badges>span{background:#0b182bcc;border:1px solid #E8C547;border-radius:3px;padding:1px 5px;white-space:nowrap}
.kin-mg-stage{position:absolute;pointer-events:none}
.kin-mg-capture{position:absolute;inset:0;pointer-events:auto;cursor:zoom-in;touch-action:none}
.kin-mg-capture[data-mode=slab]{cursor:ns-resize}
.kin-mg-outline{position:absolute;inset:0;width:100%;height:100%}
.kin-mg-lens{position:absolute;width:160px;height:160px;border:2px solid #E8C547;border-radius:50%;overflow:hidden;transform:translate(-50%,-50%);box-shadow:0 0 0 1px #000}
.kin-mg-lens>canvas{width:100%;height:100%;display:block}
[data-kin-mg-slab] svg{visibility:hidden!important}
.kin-mg-note{color:var(--kin-ux-secondary);margin:0 0 6px;max-width:34em}
.kin-mg-status{margin:6px 0 0;max-width:34em;min-height:1.2em}
.kin-mg-row{display:flex;flex-wrap:wrap;align-items:center;gap:.4em;margin:6px 0}
.kin-mg-row[hidden],.kin-mg-question[hidden]{display:none}
.kin-mg-patients{margin:4px 0;padding-left:1.4em}
.kin-mg-patients>li[aria-current=true]{font-weight:bold}
.kin-mg-question{border:1px solid #E8C547;border-radius:4px;padding:6px;margin:6px 0;max-width:34em}
`, document.head);

    // ── Cells ──
    const cellIds = () => { try { return [...grid.getState().viewports.keys()]; } catch (_) { return []; } };
    const viewportOf = id => { try { const v = cellService.getCornerstoneViewport(id); return v?.type === 'stack' && v.element?.isConnected ? v : null; } catch (_) { return null; } };
    const imageIdOf = v => { try { return v.getCurrentImageId?.() || null; } catch (_) { return null; } };
    const instanceOf = v => { const id = imageIdOf(v); try { return id ? core.metaData.get('instance', id) || null : null; } catch (_) { return null; } };
    const imageData = v => { try { return v.getImageData()?.imageData || null; } catch (_) { return null; } };
    const opened = () => new URLSearchParams(location.search).get('StudyInstanceUIDs')?.split(',')[0] || null;

    // The DICOM JSON of an image, once per SOP (a Promise of the item or null). A header that could not be read is asked
    // for again when it is next wanted, but not within a few seconds of the failure.
    const raws = new Map(), failed = new Map(), UID = /^\d+(?:\.\d+)+$/;
    function rawOf(instance) {
      const sop = instance?.SOPInstanceUID, study = instance?.StudyInstanceUID, series = instance?.SeriesInstanceUID;
      if (![study, series, sop].every(uid => typeof uid === 'string' && uid.length <= 64 && UID.test(uid))) return Promise.resolve(null);
      if (failed.has(sop) && Date.now() - failed.get(sop) > 3000) { failed.delete(sop); raws.delete(sop); }
      if (!raws.has(sop)) {
        if (raws.size > 200) { const oldest = raws.keys().next().value; raws.delete(oldest); failed.delete(oldest); }
        raws.set(sop, fetch('/dicom-web/studies/' + study + '/series/' + series + '/instances/' + sop + '/metadata',
          { credentials: 'same-origin', headers: { Accept: 'application/dicom+json' }, signal })
          .then(response => response.ok ? response.json() : null)
          .then(json => { const item = Array.isArray(json) ? json[0] : null; return item && typeof item === 'object' ? item : null; })
          .catch(() => null)
          .then(item => { if (!item) failed.set(sop, Date.now()); return item; }));
      }
      return raws.get(sop);
    }
    // The image's declared pixel padding (Pixel Padding Value, with Pixel Padding Range Limit a range, both ends counted)
    // in the values the cell holds: { low, high }, null without one, 'unknown' when the cell's values are converted ones
    // (a rescale slope or intercept) and the image cannot say whether they are.
    function paddingOf(item, v, imageId, modality) {
      const value = Number(item['00280120']?.Value?.[0] ?? NaN), limit = Number(item['00280121']?.Value?.[0] ?? NaN);
      if (!Number.isFinite(value)) return null;
      const ends = Number.isFinite(limit) ? [Math.min(value, limit), Math.max(value, limit)] : [value, value];
      const slope = Number(modality?.slope ?? 1), intercept = Number(modality?.intercept ?? 0);
      if (slope === 1 && intercept === 0) return { low: ends[0], high: ends[1] };
      let image = null; try { image = v.getCornerstoneImage?.() || core.cache?.getImage?.(imageId) || null; } catch (_) {}
      if (!image || !Number.isFinite(slope) || !Number.isFinite(intercept)) return 'unknown';
      if (image.preScale?.scaled !== true) return { low: ends[0], high: ends[1] };
      const shown = ends.map(n => n * slope + intercept);
      return { low: Math.min(...shown), high: Math.max(...shown) };
    }
    // One cell as the calculations see it: { id, v, imageId, mg, side, view, verified, flipH, flipV, columns, rows,
    // monochrome1, partial, padding, study } — of the frame the cell shows now. partial: a magnification, spot or partial
    // view (or a header that contradicts itself about it): not the whole breast.
    async function describe(v) {
      const instance = instanceOf(v), imageId = imageIdOf(v);
      if (!instance || !imageId) return null;
      const item = await rawOf(instance), model = window.KinMammographyModel;
      if (ended || !item || !model) return null;
      let c = null, spec = null;
      try { c = model.classify(item); } catch (_) { return null; }
      const mg = item['00080060']?.Value?.[0] === 'MG' || !!c.kind || c.basis === 'ct-breast-tomosynthesis';
      const frame = Number(item['00280008']?.Value?.[0]) > 1 ? (v.getCurrentImageIdIndex?.() ?? 0) + 1 : 1;
      try { spec = model.displaySpec(item, frame); } catch (_) { spec = null; }
      const orientation = spec?.orientation, modifiers = Array.isArray(c.modifiers) ? c.modifiers : [];
      const dimensions = (() => { try { return v.getImageData()?.dimensions || null; } catch (_) { return null; } })();
      return { id: v.id, v, imageId, mg, kind: c.kind, basis: c.basis, side: c.laterality, view: c.view, verified: orientation?.status === 'verified',
        flipH: orientation?.flipH, flipV: orientation?.flipV,
        columns: Number(dimensions?.[0] ?? item['00280011']?.Value?.[0]), rows: Number(dimensions?.[1] ?? item['00280010']?.Value?.[0]),
        monochrome1: String(item['00280004']?.Value?.[0] || '').toUpperCase() === 'MONOCHROME1',
        partial: c.partialState === 'yes' || c.partialState === 'conflict' || modifiers.some(m => m === 'Magnification' || m === 'Spot Compression'),
        padding: paddingOf(item, v, imageId, spec?.modality), study: instance.StudyInstanceUID, series: instance.SeriesInstanceUID };
    }
    // changes: how often each cell was given another image (a slice, a stack, a viewport); a cell held then is the same
    // viewport on the same image with no change between (A → B → A is a change). stacks: how often it was given other
    // images to show (not another slice of those it has).
    const changes = new Map(), stacks = new Map(), countOf = (map, id) => map.get(id) || 0;
    const hold = v => ({ v, id: v.id, imageId: imageIdOf(v), changes: countOf(changes, v.id) });
    const holds = held => !!held && viewportOf(held.id) === held.v && imageIdOf(held.v) === held.imageId && countOf(changes, held.id) === held.changes;
    // The MG cells, of the images the cells hold when this is asked: the headers are read meanwhile, and the first time
    // that takes as long as the server does. A cell given another image since (A → B → A too) is not described by the
    // header read for it, and one whose header could not be read is not described at all: neither is in the list, and
    // both are in list.left ([{ id, label, changed }]) for whoever says what was done — unless the header read says
    // the image is not an MG one. (A cell that shows no image is in neither.)
    async function mgCells() {
      const held = cellIds().map(viewportOf).filter(Boolean).map(v => ({ ...hold(v), instance: instanceOf(v) }));
      const cells = await Promise.all(held.map(h => describe(h.v).catch(() => null)));
      const list = []; list.left = [];
      if (ended) return list;
      held.forEach((h, i) => {
        const cell = cells[i], same = holds(h);
        if (cell ? !cell.mg : !h.imageId) return;
        if (cell && same) list.push(cell);
        else list.left.push({ id: h.id, changed: !same, label: cell ? labelOf(cell) + ' · 그 사이 영상이 바뀜'
          : (h.instance ? roleOf({ study: h.instance.StudyInstanceUID, series: h.instance.SeriesInstanceUID }) : '?') + ' · 영상 머리글을 읽지 못함' });
      });
      return list;
    }
    const leftOut = list => list.left.map(entry => entry.label);
    // What is drawn from the cells as they are (Mirrored's marks, the press layers) is drawn from the latest reading
    // only — an earlier one that ends later draws nothing (null) — and the cells are read again when one was given
    // another image meanwhile.
    const readings = new Map();
    async function cellsNow(key) {
      const reading = countOf(readings, key) + 1;
      readings.set(key, reading);
      for (;;) {
        const list = await mgCells();
        if (ended || readings.get(key) !== reading) return null;
        if (!list.left.some(entry => entry.changed)) return list;
      }
    }
    // A window opened on exam scopes names the role by them (every original of a merged exam is current; an image in
    // neither role, or not yet admitted, is '?'); elsewhere the first opened study is current.
    const roleOf = cell => /[?&]kinExamScopes=/.test(globalThis.location?.search || '')
      ? ({ current: 'Current', prior: 'Prior' })[globalThis.KinViewerExamScope?.role?.(cell.study, cell.series) || ''] || '?'
      : cell.study === opened() ? 'Current' : 'Prior';
    const labelOf = cell => roleOf(cell) + ' · ' + (cell.side || '?') + ' ' + (cell.view || '?');
    const REASONS = { 'orientation-unverified': 'orientation unverified', 'laterality-unknown': 'laterality unknown', 'view-unknown': 'view unknown',
      'size-unknown': 'image size unknown', 'no-image': 'no image' };

    // ── Geometry of a cell: image points (pixel edges 0 … columns), world points and the camera ──
    function toImage(v, world) {
      const data = imageData(v); if (!data || !world) return null;
      const index = data.worldToIndex([...world], new Float64Array(3));
      return [index[0] + 0.5, index[1] + 0.5];
    }
    function toWorld(v, point) {
      const data = imageData(v); if (!data || !point) return null;
      return Array.from(data.indexToWorld([point[0] - 0.5, point[1] - 0.5, 0], new Float64Array(3)));
    }
    function centerOn(v, world) {
      const camera = v.getCamera(), delta = world.map((n, i) => n - camera.focalPoint[i]);
      v.setCamera({ focalPoint: [...world], position: camera.position.map((n, i) => n + delta[i]) });
    }
    const zoomOf = v => { try { const zoom = v.getZoom(); return Number.isFinite(zoom) && zoom > 0 ? zoom : null; } catch (_) { return null; } };
    // CSS pixels one image pixel spans now.
    function perPixel(v) {
      try {
        const camera = v.getCamera(), spacing = v.getImageData().spacing, a = camera.focalPoint, b = a.map((n, i) => n + camera.viewUp[i]);
        const p = v.worldToCanvas(a), q = v.worldToCanvas(b);
        const value = Math.hypot(p[0] - q[0], p[1] - q[1]) * (spacing?.[1] || 1);
        return Number.isFinite(value) && value > 0 ? value : null;
      } catch (_) { return null; }
    }
    const cellSize = v => ({ cellWidth: v.element.clientWidth, cellHeight: v.element.clientHeight });
    // Camera changes this module makes: the cell's own camera events then are not the reader's (no echo between cells).
    const applying = new Set(), lastSet = new Map();
    const signature = v => { try { const c = v.getCamera(); return [c.parallelScale, ...c.focalPoint].map(n => Number(n).toFixed(4)).join(','); } catch (_) { return ''; } };
    // act: the camera act (cameraAct) this is carried out for — the cell's camera is that act's from now on.
    function steer(v, change, act) {
      applying.add(v.id);
      try { change(); v.render(); if (act) stamps.set(v.id, act.n); return true; } catch (error) { console.error(error); return false; }
      finally { lastSet.set(v.id, signature(v)); applying.delete(v.id); }
    }
    const fit = (v, act) => steer(v, () => { v.setZoom(1); v.setPan([0, 0]); }, act);
    // A cell Display Set Presets is putting a rule on (viewer-features-view.js): its changes are the rule's, not the
    // reader's, and are not followed; given the mark taken when a change was heard, also a cell a rule began on since.
    const ruled = (id, since) => { try { return !!window.KinViewerCellRules?.setting?.(id, since); } catch (_) { return false; } };
    const ruleMark = () => { try { return window.KinViewerCellRules?.mark?.(); } catch (_) { return undefined; } };

    // ── This module's layer over each cell: badges, the outline, the press layer and the lens ──
    // The cell layer covers the whole cell, its header row too; the outline, the press layer and the lens are on the
    // stage, which lies exactly over the image (the viewport element), so a point on them is a point of the image's canvas.
    const layers = new Map();
    function layerOf(v) {
      let entry = layers.get(v.id);
      if (entry && (!entry.node.isConnected || entry.viewport !== v)) { entry.node.remove(); layers.delete(v.id); entry = null; }
      if (!entry) {
        const host = ui.cellLayer(v.id); if (!host) return null;
        host.classList.add('kin-mg-layer');
        entry = { node: host, viewport: v, badges: element('div', '', host, 'kin-mg-badges'), stage: element('div', '', host, 'kin-mg-stage'),
          marks: new Map(), outline: null, capture: null, lens: null };
        layers.set(v.id, entry);
        stageSizes?.observe(v.element); stageSizes?.observe(host);
      }
      placeStage(entry);
      return entry;
    }
    function placeStage(entry) {
      const a = entry.node.getBoundingClientRect(), b = entry.viewport.element.getBoundingClientRect();
      Object.assign(entry.stage.style, { left: b.left - a.left + 'px', top: b.top - a.top + 'px', right: a.right - b.right + 'px', bottom: a.bottom - b.bottom + 'px' });
    }
    // The image moves within its cell (a header row shown or hidden, the cell resized): the stage follows it.
    const stageSizes = typeof ResizeObserver === 'function' ? new ResizeObserver(entries => {
      const moved = new Set(entries.map(entry => entry.target));
      for (const entry of layers.values()) if (entry.node.isConnected && (moved.has(entry.node) || moved.has(entry.viewport.element))) placeStage(entry);
    }) : null;
    function badge(v, key, text) {
      const entry = text ? layerOf(v) : layers.get(v.id);
      if (!entry) return;
      if (!text) { entry.marks.get(key)?.remove(); entry.marks.delete(key); return; }
      let node = entry.marks.get(key);
      if (!node) { node = element('span', '', entry.badges); node.dataset.mgBadge = key; entry.marks.set(key, node); }
      node.textContent = text;
    }
    const clearBadges = key => { for (const entry of layers.values()) { entry.marks.get(key)?.remove(); entry.marks.delete(key); } };

    // ── The breast region of a cell's image now ──
    // The one place the region is worked out (Breast Edge, Breast W/L, Fit Breast, Match Size and Quadrant Zoom all ask
    // here): from the pixel values the cell shows now (a slab's, while one is drawn) and what the image's own header says
    // of the frame shown — the stored side of the chest wall, MONOCHROME1, declared padding, a partial view. Kept for the
    // same image, the same pixel array and the same of those.
    const regions = new Map();
    function regionOf(cell) {
      const chest = M.chestWall(cell);
      if (!chest) return { found: false, reason: M.unlinkable(cell) || 'chest-wall-unknown' };
      if (cell.padding === 'unknown') return { found: false, reason: 'padding-unknown' };
      const data = imageData(cell.v); if (!data) return { found: false, reason: 'no-pixels' };
      let values; try { values = data.getPointData().getScalars().getData(); } catch (_) { return { found: false, reason: 'no-pixels' }; }
      const input = [chest, !!cell.monochrome1, !!cell.partial, cell.padding ? cell.padding.low + '…' + cell.padding.high : ''].join('|');
      const cached = regions.get(cell.id);
      if (cached?.imageId === cell.imageId && cached.values === values && cached.input === input) return cached.region;
      const region = M.detect(values, cell.columns, cell.rows, { chest, monochrome1: cell.monochrome1, partial: cell.partial, padding: cell.padding });
      regions.set(cell.id, { imageId: cell.imageId, values, input, region });
      return region;
    }
    const NO_CELLS = 'MG 영상이 있는 칸을 찾지 못했습니다(영상 머리글을 읽지 못했을 수 있습니다). 바꾼 것이 없습니다.';

    // ── Acts that wait ──
    // What the reader asks for is carried out once the image headers are read, and the first time that takes as long as
    // the server does. An act is therefore taken down as things stood when it was received (the press, the camera event,
    // the tool run, the button — not when the answer comes) and checked against that, here, just before each write:
    // nothing is written for an act that a later one, a Reset, a Close or another image has overtaken (the cells
    // themselves are held in mgCells(), as each stood when the headers were asked for).
    // Camera acts. Everything that sets a cell's camera has its number in the order received: each act of this module
    // when it is received, and every camera change that is not this module's (the reader's, the viewer's) when it is
    // heard. stamps: for each cell, the number of the latest of them that set its camera. An act sets a cell's camera
    // only if nothing received after it has (cameraHolds with the cell).
    // A command sets cameras on its own word (a Breast Display zoom mode, a Quadrant Zoom step or Close, Mirrored's
    // Reset): of the commands, the latest received is the only one carried out. A Mirrored point or camera change may
    // turn out to carry nothing (the cell may not be linked), and a cell's new size is not the reader's act: neither is
    // a command (command: false) — it is not carried out after a later command, and it stops nothing that was asked
    // before it. What a Mirrored act sets is that act's (steer with the act); a new size leaves the cell's number as it is.
    const stamps = new Map(), turn = { received: 0, command: 0 };
    const cameraAct = (command = true) => ({ n: ++turn.received, command: command ? ++turn.command : turn.command });
    const cameraHolds = (act, id) => !ended && act.command === turn.command && (id === undefined || act.n > countOf(stamps, id));

    // ── Mirrored ──
    // epoch: every opening, Close and Reset; inverts: every time Invert together is turned off.
    const mirror = { on: false, invert: true, panel: null, status: null, before: new Map(), epoch: 0, inverts: 0 };
    // An act Mirrored carries from one cell to the others of its view ('camera': a point or a camera change, 'invert',
    // 'lens'), as it stood when it was received: the Mirrored epoch, the source cell and every cell as held then, the
    // display-rule mark, and for a camera act its place among the camera commands.
    function mirrorAct(v, kind) {
      const cells = new Map();
      for (const id of cellIds()) { const cell = viewportOf(id); if (cell) cells.set(id, hold(cell)); }
      return { kind, epoch: mirror.epoch, inverts: mirror.inverts, camera: kind === 'camera' ? cameraAct(false) : null, source: cells.get(v.id) || hold(v), cells, mark: ruleMark() };
    }
    // Whether the act is still to be carried out, and onto that cell (one of mgCells()): not after a Reset, a Close or
    // a new opening, not from or onto a cell given another image since, a camera act not after a later command nor onto
    // a cell whose camera something received later has set, an Invert not after Invert together was turned off (every
    // Invert run while it stays on is carried, each in its turn).
    function carried(act, target) {
      if (ended || !mirror.on || act.epoch !== mirror.epoch || !holds(act.source)) return false;
      if (act.camera && !cameraHolds(act.camera)) return false;
      if (act.kind === 'invert' && !(mirror.invert && act.inverts === mirror.inverts)) return false;
      if (!target) return true;
      const held = act.cells.get(target.id);
      return !!held && held.v === target.v && holds(held) && (!act.camera || cameraHolds(act.camera, target.id));
    }
    async function openMirrored() {
      const panel = ui.panel({ id: 'mirrored', title: 'Mirrored' });
      if (!panel || panel === mirror.panel) return;
      mirror.panel = panel;
      note('MG 영상의 한 점을 누르세요. 그 자리를 2배로 크게 보이고, 같은 뷰의 다른 칸(반대쪽 유방·과거 검사)은 대응하는 자리를 같은 배율로 보입니다. ' +
        '한 칸의 확대·이동·반전·돋보기도 같은 뷰의 칸에 함께 걸립니다.', panel.body);
      note('대응 자리는 영상 좌표로 정합니다(반대쪽은 좌우 거울). 같은 조직이 아닐 수 있습니다. CC와 MLO 사이에는 걸지 않습니다.', panel.body);
      const label = element('label', '', panel.body, 'kin-mg-row'), invert = element('input', '', label);
      invert.type = 'checkbox'; invert.checked = mirror.invert; invert.setAttribute('aria-label', 'Invert together'); element('span', 'Invert together', label);
      // Turned off, the Inverts still waiting for the image headers are not carried either (nor when it is turned on again).
      invert.onchange = () => { mirror.invert = invert.checked; if (!mirror.invert) mirror.inverts++; };
      const row = element('div', '', panel.body, 'kin-mg-row');
      button('Reset', row, () => resetMirrored(), '켜기 전의 보기로 되돌립니다');
      mirror.status = statusLine(panel.body);
      // Close turns the link off and leaves the views as they are; the lenses of the linked cells go with it (the cell
      // pressed keeps its own while it is pressed).
      panel.onClose(() => {
        if (mirror.panel !== panel) return;
        mirror.on = false; mirror.epoch++; mirror.panel = mirror.status = null; clearBadges('mirrored');
        for (const [id, entry] of layers) if (entry.lens && !(lens.pressed && lens.last?.id === id)) { entry.lens.remove(); entry.lens = null; }
      });
      // Reset goes back to the views as they were when Mirrored was turned on (every cell's camera now; the link starts at
      // once — a point pressed before the image headers are read waits for them in pick()).
      mirror.before.clear();
      for (const id of cellIds()) {
        const v = viewportOf(id); if (!v) continue;
        let props = {}; try { props = v.getProperties(); } catch (_) {}
        try { mirror.before.set(id, { viewport: v, imageId: imageIdOf(v), camera: structuredClone(v.getCamera()), invert: !!props.invert }); } catch (_) {}
      }
      mirror.on = true; mirror.epoch++;
      await markUnlinked();
    }
    // The cells Mirrored does not link, marked and named in this opening's panel (a Reset does not stop that): those of
    // the latest reading of the cells, a cell whose header could not be read among them.
    async function markUnlinked() {
      const panel = mirror.panel;
      const list = await cellsNow('mirrored');
      if (!list || !mirror.on || !panel || mirror.panel !== panel) return;
      clearBadges('mirrored');
      const lines = leftOut(list);
      for (const cell of list) {
        const reason = M.unlinkable(cell);
        if (!reason) continue;
        badge(cell.v, 'mirrored', 'Mirrored: ' + (REASONS[reason] || reason) + ' — not linked');
        lines.push(labelOf(cell) + ': ' + (REASONS[reason] || reason));
      }
      if (mirror.status) mirror.status.textContent = lines.length ? '연동하지 않는 칸 — ' + lines.join(' / ') : '';
    }
    // Reset is carried out at once: every act received before it (a point, a camera change, an Invert, a lens) is dropped,
    // and every camera command still waiting.
    function resetMirrored() {
      mirror.epoch++;
      const act = cameraAct();
      for (const [id, before] of mirror.before) {
        const v = viewportOf(id);
        if (v !== before.viewport || imageIdOf(v) !== before.imageId) continue;
        steer(v, () => {
          const { flipHorizontal, flipVertical, ...camera } = before.camera;
          v.setCamera({ ...camera, flipHorizontal, flipVertical });
          if (!!v.getProperties().invert !== before.invert) v.setProperties({ invert: before.invert });
        }, act);
      }
    }
    // A point pressed in one cell (point: that place in the cell's image, taken when it was pressed): that place twice as
    // large in it and the counterpart in the same view's other cells.
    async function pick(act, point) {
      const list = await mgCells(), t = M.targets(act.source.id, list);
      if (!carried(act)) return;
      if (t.reason) { if (mirror.status) mirror.status.textContent = '이 칸은 연동할 수 없습니다: ' + (REASONS[t.reason] || t.reason); return; }
      const source = t.source;
      for (const cell of [source, ...t.linked.map(id => list.find(c => c.id === id))]) {
        if (!carried(act, cell)) continue;
        const at = cell === source ? point : M.counterpart(point, source, cell), world = at && toWorld(cell.v, at);
        if (world) steer(cell.v, () => { cell.v.setZoom(2); centerOn(cell.v, world); }, act.camera);
      }
    }
    // A reader's zoom or pan in one MG cell: the same zoom (relative to Fit) and the counterpart centre in the others.
    // The act is taken down when the camera event is heard; it is carried a frame later, after the headers.
    const pendingCamera = new Map();  // source cell → its latest act
    let cameraFrame = 0;
    function cameraChanged(event) {
      const id = event.detail?.viewportId;
      if (!id || applying.has(id)) return;
      const v = viewportOf(id);
      // The camera this module last set on the cell is not the reader's change, however late it is heard; once the cell
      // has had another camera, the same camera again is a change like any other (back to 1× after 3×).
      if (!v || lastSet.get(id) === signature(v)) return;
      lastSet.delete(id);
      if (!mirror.on || ruled(id)) return;
      pendingCamera.set(id, mirrorAct(v, 'camera'));
      if (!cameraFrame) cameraFrame = requestAnimationFrame(() => { cameraFrame = 0; const acts = [...pendingCamera.values()]; pendingCamera.clear(); acts.forEach(act => followCamera(act)); });
    }
    // A change heard before a rule began on a cell is not carried onto it (nor carried from it).
    async function followCamera(act) {
      const list = await mgCells(), t = M.targets(act.source.id, list);
      if (!carried(act) || t.reason || ruled(act.source.id, act.mark)) return;
      const source = t.source, zoom = zoomOf(source.v), focal = toImage(source.v, source.v.getCamera().focalPoint);
      if (!zoom || !focal) return;
      for (const id of t.linked) {
        const cell = list.find(c => c.id === id);
        if (ruled(id, act.mark) || !carried(act, cell)) continue;
        const at = M.counterpart(focal, source, cell), world = at && toWorld(cell.v, at);
        if (world) steer(cell.v, () => { cell.v.setZoom(zoom); centerOn(cell.v, world); }, act.camera);
      }
    }
    // Invert together follows the reader's own Invert: the toolbar announces every tool run (the I key, More › Invert, a
    // cell's control, the Context Toolbar), after the command. The same act then inverts each linked cell of that view
    // (each image the other way from how it is shown, so a MONOCHROME1 image beside a MONOCHROME2 one turns too). Nothing
    // else that sets an inversion (a stored presentation, a restored view, a display rule, Reset) is carried.
    const invertOf = v => { try { return !!v.getProperties().invert; } catch (_) { return null; } };
    async function invertRun(event) {
      const { id, viewportId } = event.detail || {}, v = id === 'invert' && viewportId && viewportOf(viewportId);
      if (!v || !mirror.on || !mirror.invert || ruled(viewportId)) return;
      const act = mirrorAct(v, 'invert');
      const list = await mgCells(), t = M.targets(viewportId, list);
      if (!carried(act) || t.reason || ruled(viewportId, act.mark)) return;
      for (const target of t.linked) {
        const cell = list.find(c => c.id === target), other = cell?.v, invert = other && invertOf(other);
        if (!other || invert === null || ruled(target, act.mark) || !carried(act, cell)) continue;
        steer(other, () => other.setProperties({ invert: !invert }));
      }
    }
    // A press without a drag in an MG cell while Mirrored is on is a point: the act and the place in the image are taken
    // when it is pressed, its number among the camera acts when it is let go (a drag is no point).
    let press = null;
    document.addEventListener('pointerdown', event => {
      press = null;
      if (!mirror.on || event.button !== 0) return;
      const v = cellIds().map(viewportOf).find(v => v?.element.contains(event.target));
      if (!v) return;
      const rect = v.element.getBoundingClientRect();
      let point = null; try { point = toImage(v, v.canvasToWorld([event.clientX - rect.left, event.clientY - rect.top])); } catch (_) {}
      press = { x: event.clientX, y: event.clientY, act: mirrorAct(v, 'point'), point };
    }, { capture: true, signal });
    document.addEventListener('pointerup', event => {
      const start = press; press = null;
      if (!start || !start.point || !mirror.on || Math.hypot(event.clientX - start.x, event.clientY - start.y) > 4) return;
      start.act.camera = cameraAct(false);
      pick(start.act, start.point).catch(error => console.error(error));
    }, { capture: true, signal });

    // ── Magnifier: while pressed, the place under the pointer twice as large (and its counterparts with Mirrored on) ──
    // press counts every press and every release (and the Magnifier turned on or off), moves every place a lens was asked
    // for: a lens that comes late (after the image headers) is drawn only for the press and the place that are still the last.
    const lens = { on: false, pressed: false, press: 0, moves: 0, last: null };
    const LENS = 160, LENS_ZOOM = 2, LENS_MARGIN = 3;
    // The one place a lens is drawn (the cell pressed, the linked cells, and again while it is held): the picture the
    // screen shows at `point` (CSS pixels of the cell's image), twice as large. The cell's canvas is read on the screen's
    // own pixel grid together with its neighbours (a 3 × 3 image filter needs one pixel around, the enlargement one
    // more, a canvas not sized to the screen's pixels one more), an image filter of the cell (Display › Filter, a CSS
    // filter on its canvas) is put on that once, at the screen's scale, and only the middle is enlarged — what cutting
    // the place out of the filtered screen and enlarging it shows. At the canvas's own end nothing lies beyond it, as
    // for the filter on the screen.
    function lensAt(v, point) {
      const entry = layerOf(v); if (!entry) return;
      if (!entry.lens) { entry.lens = element('div', '', entry.stage, 'kin-mg-lens'); element('canvas', '', entry.lens); }
      const canvas = entry.lens.firstChild, source = v.canvas, dpr = window.devicePixelRatio || 1;
      canvas.width = canvas.height = Math.round(LENS * dpr);
      Object.assign(entry.lens.style, { left: point[0] + 'px', top: point[1] + 'px' });
      entry.lens.dataset.at = point.map(n => Math.round(n)).join(',');
      try {
        // The canvas in screen (device) pixels: as the viewer sizes it, one of them to one pixel of the canvas.
        const wide = Math.round(source.clientWidth * dpr), high = Math.round(source.clientHeight * dpr);
        if (!(wide > 0 && high > 0 && source.width > 0 && source.height > 0)) return;
        const side = LENS / LENS_ZOOM * dpr, x = point[0] * dpr - side / 2, y = point[1] * dpr - side / 2;
        const x0 = Math.max(0, Math.floor(x) - LENS_MARGIN), y0 = Math.max(0, Math.floor(y) - LENS_MARGIN);
        const x1 = Math.min(wide, Math.ceil(x + side) + LENS_MARGIN), y1 = Math.min(high, Math.ceil(y + side) + LENS_MARGIN);
        const ax = Math.max(x, 0), ay = Math.max(y, 0), bx = Math.min(x + side, wide), by = Math.min(y + side, high);
        if (bx <= ax || by <= ay) return;
        const part = document.createElement('canvas'); part.width = x1 - x0; part.height = y1 - y0;
        const g = part.getContext('2d'), filter = source.style?.filter || '', sx = source.width / wide, sy = source.height / high;
        if (filter && filter !== 'none') g.filter = filter;
        g.drawImage(source, x0 * sx, y0 * sy, part.width * sx, part.height * sy, 0, 0, part.width, part.height);
        // The middle of it; what of the place lies beyond the canvas stays empty.
        const k = canvas.width / side;
        canvas.getContext('2d').drawImage(part, ax - x0, ay - y0, bx - ax, by - ay, (ax - x) * k, (ay - y) * k, (bx - ax) * k, (by - ay) * k);
      } catch (_) { /* a canvas not drawn yet */ }
    }
    const hideLenses = () => { for (const entry of layers.values()) { entry.lens?.remove(); entry.lens = null; } };
    const lensUp = () => { lens.pressed = false; lens.press++; lens.last = null; hideLenses(); };
    // While pressed, a cell drawn again (an Invert, a window change) shows in the lenses at once.
    let lensFrame = 0;
    function lensRedraw(event) {
      const id = event.detail?.viewportId;
      if (!lens.pressed || !lens.last || lensFrame || ![...layers].some(([cell, entry]) => cell === id && entry.lens)) return;
      const press = lens.press;
      lensFrame = requestAnimationFrame(() => {
        lensFrame = 0;
        if (!ended && lens.pressed && lens.press === press && lens.last) magnify(lens.last.id, lens.last.point).catch(error => console.error(error));
      });
    }
    async function magnify(viewportId, point) {
      const v = viewportOf(viewportId); if (!v || !lens.pressed) return;
      const press = lens.press, move = ++lens.moves;
      lens.last = { id: viewportId, point };
      hideLenses(); lensAt(v, point);
      if (!mirror.on) return;
      // The linked cells: taken down as a Mirrored act now, with the place in the image now.
      const act = mirrorAct(v, 'lens');
      let at = null; try { at = toImage(v, v.canvasToWorld(point)); } catch (_) {}
      const list = await mgCells(), t = M.targets(viewportId, list);
      if (!lens.pressed || press !== lens.press || move !== lens.moves || !carried(act) || t.reason || !at) return;
      for (const id of t.linked) {
        const cell = list.find(c => c.id === id);
        if (!carried(act, cell)) continue;
        const p = M.counterpart(at, t.source, cell), world = p && toWorld(cell.v, p);
        if (world) lensAt(cell.v, cell.v.worldToCanvas(world));
      }
    }

    // ── The press layer: the Magnifier on every MG cell, the slab cell's wheel (its mouse tools are off) ──
    function pressLayers(list) {
      const want = new Map();
      if (lens.on) for (const cell of list) want.set(cell.id, 'lens');
      if (tomo.slabbed) want.set(tomo.slabbed.id, lens.on ? 'lens' : 'slab');
      for (const [id, entry] of layers) if (!want.has(id) && entry.capture) { entry.capture.remove(); entry.capture = null; }
      for (const [id, mode] of want) {
        const v = viewportOf(id), entry = v && layerOf(v); if (!entry) continue;
        if (!entry.capture) {
          entry.capture = element('div', '', entry.stage, 'kin-mg-capture');
          const at = event => { const r = entry.capture.getBoundingClientRect(); return [event.clientX - r.left, event.clientY - r.top]; };
          entry.capture.addEventListener('pointerdown', event => {
            event.stopPropagation(); event.preventDefault();
            if (entry.capture.dataset.mode !== 'lens' || event.button !== 0) return;
            entry.capture.setPointerCapture?.(event.pointerId); lens.pressed = true; lens.press++;
            magnify(id, at(event)).catch(error => console.error(error));
          });
          entry.capture.addEventListener('pointermove', event => {
            if (lens.pressed && entry.capture.dataset.mode === 'lens') magnify(id, at(event)).catch(error => console.error(error));
          });
          for (const type of ['pointerup', 'pointercancel']) entry.capture.addEventListener(type, lensUp);
          entry.capture.addEventListener('mousedown', event => event.stopPropagation());
          entry.capture.addEventListener('wheel', event => {
            if (tomo.slabbed?.id !== id) return;
            event.preventDefault(); event.stopPropagation(); tomoStep(Math.sign(event.deltaY) || 1);
          }, { passive: false });
          entry.capture.addEventListener('contextmenu', event => event.preventDefault());
        }
        entry.capture.dataset.mode = mode;
      }
    }
    // The press layers for the cells as they are now (the latest reading of them).
    const pressNow = async () => { const list = await cellsNow('press'); if (list) pressLayers(list); };
    // A cell was given another image (a slice, a stack) or the grid changed: Mirrored's marks and the press layers are
    // those of the cells as they are now.
    const cellsChanged = () => { if (mirror.on) markUnlinked().catch(() => {}); if (lens.on) pressNow().catch(() => {}); };
    async function setMagnifier(on) {
      lens.on = on; lensUp();
      const list = on ? await cellsNow('press') : [];
      if (ended || lens.on !== on) return;
      if (list) pressLayers(list);
      ui.toast(on ? 'Magnifier: MG 영상을 누르고 있는 동안 그 자리를 2배로 보입니다. MG ▾ › Magnifier로 끕니다.' : 'Magnifier를 껐습니다.');
    }

    // ── Quadrant Zoom ──
    // Every step and every Close is a camera command (cameraAct): an earlier one still reading image headers then changes
    // nothing, and neither writes a cell whose camera was changed meanwhile.
    // marks: the cells the step holds ({ viewport, stack, zoom, width, height, clipped, text }). A cell leaves the step when
    // its zoom, stack or viewport is changed by anything else (Breast Display, Mirrored, the reader): its badge then no
    // longer says what it shows, and nothing of the step is drawn there again. A pan keeps it (the way to an edge at 4×).
    // A held cell whose size changes (window, layout) has its step worked out again for the new size.
    const quad = { panel: null, step: 0, marks: new Map(), apply: null, paint: null, resized: new Set(), timer: 0 };
    const QUAD_ZOOM_LABELS = { '4x': '4×', fill: 'Fill Quadrant' };
    const quadSizes = typeof ResizeObserver === 'function' ? new ResizeObserver(entries => {
      for (const entry of entries) for (const [id, mark] of quad.marks) {
        if (mark.viewport.element !== entry.target) continue;
        const size = cellSize(mark.viewport);
        if (size.cellWidth !== mark.width || size.cellHeight !== mark.height) quad.resized.add(id);
      }
      if (!quad.resized.size || quad.timer) return;
      quad.timer = setTimeout(() => {
        timers.delete(quad.timer); quad.timer = 0;
        const ids = [...quad.resized]; quad.resized.clear(); quad.apply?.(ids);
      }, 150);
      timers.add(quad.timer);
    }) : null;
    function dropQuadrant(id) {
      const mark = quad.marks.get(id); if (!mark) return;
      quad.marks.delete(id); quad.resized.delete(id); badge(mark.viewport, 'quadrant', null);
      if (![...quad.marks.values()].some(other => other.viewport.element === mark.viewport.element)) quadSizes?.unobserve(mark.viewport.element);
      quad.paint?.();
    }
    function quadrantCamera(id) {
      const mark = quad.marks.get(id), v = mark && viewportOf(id), zoom = v && zoomOf(v);
      if (mark && (v !== mark.viewport || !zoom || Math.abs(zoom - mark.zoom) > 1e-6 * mark.zoom)) dropQuadrant(id);
    }
    function quadrantImage(id) {
      const mark = quad.marks.get(id), v = viewportOf(id);
      if (mark && (v !== mark.viewport || stackKey(v) !== mark.stack)) dropQuadrant(id);
    }
    function endQuadrant() {
      clearTimeout(quad.timer); timers.delete(quad.timer); quad.timer = 0; quad.resized.clear();
      quad.panel = null; quad.apply = quad.paint = null; quad.marks.clear(); quadSizes?.disconnect(); clearBadges('quadrant');
    }
    function openQuadrant() {
      const panel = ui.panel({ id: 'quadrant', title: 'Quadrant Zoom' });
      if (!panel || panel === quad.panel) return;
      quad.panel = panel; quad.step = 0;
      if (!M.QUADRANT_ZOOMS.includes(carry.quadrantZoom)) carry.quadrantZoom = '4x';
      const order = element('label', '', panel.body, 'kin-mg-row'); element('span', 'Order', order);
      const select = element('select', '', order); select.setAttribute('aria-label', 'Order');
      element('option', 'R/L symmetric', select).value = 'symmetric';
      const scale = element('label', '', panel.body, 'kin-mg-row'); element('span', 'Zoom', scale);
      const zoomSelect = element('select', '', scale); zoomSelect.setAttribute('aria-label', 'Zoom');
      for (const mode of M.QUADRANT_ZOOMS) element('option', QUAD_ZOOM_LABELS[mode], zoomSelect).value = mode;
      zoomSelect.value = carry.quadrantZoom;
      zoomSelect.onchange = () => { carry.quadrantZoom = zoomSelect.value; explain(); show(quad.step); };
      const heading = element('b', '', panel.body);
      const row = element('div', '', panel.body, 'kin-mg-row');
      button('Previous Quadrant', row, () => show(quad.step - 1));
      button('Next Quadrant', row, () => show(quad.step + 1));
      const how = note('', panel.body);
      note('사분면은 유방 영역의 상자를 가로·세로 반으로 나눈 것이고(영역을 찾지 못한 칸은 영상 전체), 모든 MG 칸이 같은 사분면을 보입니다. 좌우는 거울입니다. ' +
        '한 장의 뷰는 사분면 이름의 한 축만 보입니다(CC: 가쪽/안쪽, MLO: 위/아래). 보이지 않는 축의 두 단계는 흉벽 쪽과 유두 쪽을 나누어 훑는 순서이며, 해부학적 사분면을 구분한 것이 아닙니다.', panel.body);
      const status = statusLine(panel.body);
      function explain() {
        how.textContent = carry.quadrantZoom === '4x'
          ? '4×: 각 칸을 Fit(100 %)의 4배(400 %)로 확대해 사분면의 가운데를 보입니다. 사분면이 칸보다 크면 가장자리는 칸 밖에 있습니다(끌어 옮기거나 Fill Quadrant로 보세요).'
          : 'Fill Quadrant: 사분면 하나를 칸에 꽉 채워 보입니다(배율은 영상과 칸 크기에 따라 다릅니다).';
      }
      explain();
      let notes = [];
      const paint = () => {
        const clipped = [...quad.marks.values()].filter(mark => mark.clipped).map(mark => mark.label);
        status.textContent = [...notes, clipped.length ? '4×에서 사분면의 가장자리가 칸 밖에 있는 칸 — ' + clipped.join(' / ') : ''].filter(Boolean).join('. ');
      };
      // The step on one cell: zoomed and centred, held (marked) and badged; false when it could not be drawn.
      // act: the step's command (none for a cell's new size).
      function place(cell, mode, act) {
        const region = regionOf(cell), q = M.quadrant(quad.step, cell, region.found ? region.box : null), size = cellSize(cell.v);
        const z = M.quadrantZoom({ mode, zoom: zoomOf(cell.v), perPixel: perPixel(cell.v), ...size, width: q.box.x1 - q.box.x0, height: q.box.y1 - q.box.y0 });
        const world = toWorld(cell.v, [(q.box.x0 + q.box.x1) / 2, (q.box.y0 + q.box.y1) / 2]);
        dropQuadrant(cell.id);
        if (!z || !world || !steer(cell.v, () => { cell.v.setZoom(z.zoom); centerOn(cell.v, world); }, act)) { badge(cell.v, 'quadrant', 'Quadrant: not zoomed'); return false; }
        // The cell's zoom is the quadrant's now: a Breast Display zoom mode no longer holds there.
        dropZoomMode(cell.id);
        quad.marks.set(cell.id, { viewport: cell.v, stack: stackKey(cell.v), zoom: zoomOf(cell.v) ?? z.zoom, width: size.cellWidth, height: size.cellHeight,
          clipped: z.clipped, label: labelOf(cell) });
        quadSizes?.observe(cell.v.element);
        badge(cell.v, 'quadrant', `Q${quad.step + 1} ${q.name} · ${QUAD_ZOOM_LABELS[mode]}` + (region.found ? '' : ' · whole image') + (z.clipped ? ' · edges outside' : ''));
        return true;
      }
      async function show(step) {
        const act = cameraAct(), mode = carry.quadrantZoom;
        quad.step = ((step % 4) + 4) % 4;
        heading.textContent = `Quadrant ${quad.step + 1}/4: ${M.QUADRANTS[quad.step]} (R/L matched)`;
        const skipped = [], failed = [];
        const list = await mgCells();
        if (quad.panel !== panel || !cameraHolds(act)) return;
        // A cell given another image since the step was asked for, or whose header could not be read, is left as it
        // is, out of the step (and named),
        for (const entry of list.left) dropQuadrant(entry.id);
        for (const cell of list) {
          // as is a cell whose camera was changed since.
          if (!cameraHolds(act, cell.id)) { dropQuadrant(cell.id); continue; }
          const reason = M.unlinkable(cell);
          if (reason) { dropQuadrant(cell.id); skipped.push(labelOf(cell) + ': ' + (REASONS[reason] || reason)); badge(cell.v, 'quadrant', 'Quadrant: ' + (REASONS[reason] || reason)); continue; }
          if (!place(cell, mode, act)) failed.push(labelOf(cell));
        }
        notes = [list.left.length ? '확대하지 않은 칸 — ' + leftOut(list).join(' / ') : '',
          skipped.length ? '방향을 확인할 수 없어 확대하지 않은 칸 — ' + skipped.join(' / ') : '',
          failed.length ? '배율을 계산할 수 없어 확대하지 않은 칸 — ' + failed.join(' / ') : ''];
        paint();
      }
      // Held cells whose size changed: the same step and zoom choice again, for those cells only (a command received
      // meanwhile wins, and a cell whose camera was changed meanwhile is left). The answer is taken down when it is
      // worked out, a moment after the size changed: the viewer's own camera changes for the new size come before it,
      // and cannot be told from the reader's.
      quad.apply = async ids => {
        const act = cameraAct(false), mode = carry.quadrantZoom;
        const list = await mgCells();
        if (quad.panel !== panel || !cameraHolds(act)) return;
        for (const cell of list) if (ids.includes(cell.id) && quad.marks.get(cell.id)?.viewport === cell.v && cameraHolds(act, cell.id) && !place(cell, mode)) {
          notes = [...notes.filter(Boolean), '배율을 계산할 수 없어 확대하지 않은 칸 — ' + labelOf(cell)];
        }
        paint();
      };
      quad.paint = paint;
      panel.onClose(async () => {
        if (quad.panel !== panel) return;
        const act = cameraAct();
        endQuadrant();
        const list = await mgCells();
        if (!cameraHolds(act)) return;
        for (const cell of list) if (cameraHolds(act, cell.id)) fit(cell.v, act);
      });
      show(0);
    }

    // ── Tomo (DBT) Slices ──
    const tomo = { panel: null, v: null, id: null, imageIds: null, timer: 0, step: 1, slab: 1, ticket: 0, opening: 0, original: null, applied: null, slabbed: null, sync: null };
    const idsOf = v => { try { return v.getImageIds?.() || []; } catch (_) { return []; } };
    const indexOf = v => { try { return v.getCurrentImageIdIndex(); } catch (_) { return 0; } };
    function tomoGo(index) {
      const v = tomo.v; if (!v || viewportOf(tomo.id) !== v) return;
      const total = idsOf(v).length, at = Math.max(0, Math.min(total - 1, index));
      try { Promise.resolve(core.utilities.jumpToSlice(v.element, { imageIndex: at })).catch(error => console.error(error)); } catch (error) { console.error(error); }
    }
    const tomoStep = direction => { if (tomo.v) tomoGo(indexOf(tomo.v) + direction * tomo.step); };
    function stopPlay() {
      if (!tomo.timer) return;
      clearInterval(tomo.timer); timers.delete(tomo.timer); tomo.timer = 0; tomo.sync?.();
    }
    function play() {
      const v = tomo.v; if (!v) return;
      if (tomo.timer) { stopPlay(); return; }
      // One player at a time: the viewer's own Cine stops in this cell while this plays, and this stops when it starts.
      const cine = services.cineService;
      try { cine?.setCine?.({ id: v.id, isPlaying: false }); cine?.stopClip?.(v.element, { viewportId: v.id }); } catch (_) {}
      const rate = Number(cine?.getState?.()?.cines?.[v.id]?.frameRate) || 24;
      tomo.timer = setInterval(() => {
        if (!tomo.v || viewportOf(tomo.id) !== tomo.v) { stopPlay(); return; }
        const total = idsOf(tomo.v).length, next = indexOf(tomo.v) + tomo.step;
        tomoGo(next >= total ? 0 : next);
      }, 1000 / Math.max(1, Math.min(60, rate)));
      timers.add(tomo.timer); tomo.sync?.();
    }
    function cineChanged() {
      try { if (tomo.timer && services.cineService.getState().cines?.[tomo.id]?.isPlaying) stopPlay(); } catch (_) {}
    }
    // The slab: the mean of the slices around the one shown, drawn in the cell's own display array. The array as it was
    // (a copy, for that viewport, stack and image) comes back at 1 slice, Close, and whenever the cell changes.
    const pixelsOf = image => { try { return image.voxelManager?.getScalarData?.() || image.getPixelData?.() || null; } catch (_) { return null; } };
    function planeOf(image) {
      let plane = null; try { plane = core.metaData.get('imagePlaneModule', image.imageId); } catch (_) {}
      const list = value => value ? Array.from(value).map(Number) : null;
      return { rows: image.rows, columns: image.columns, slope: image.slope ?? null, intercept: image.intercept ?? null, scaled: !!image.preScale?.scaled,
        rowCosines: list(plane?.rowCosines), columnCosines: list(plane?.columnCosines), position: list(plane?.imagePositionPatient),
        spacing: plane?.rowPixelSpacing != null ? [Number(plane.rowPixelSpacing), Number(plane.columnPixelSpacing)] : null };
    }
    function scalarsOf(v) { try { return v.getImageData().imageData.getPointData().getScalars(); } catch (_) { return null; } }
    function putScalars(v, array) {
      const scalars = scalarsOf(v); if (!scalars) return false;
      scalars.setData(array, scalars.getNumberOfComponents?.() || 1);
      v.getImageData().imageData.modified();
      v.render();
      return true;
    }
    function restoreSlab() {
      const v = tomo.v, original = tomo.original, applied = tomo.applied;
      tomo.applied = null; tomo.ticket++;
      if (tomo.slabbed) { const pane = viewportOf(tomo.slabbed.id)?.element.closest('[data-cy=viewport-pane]'); if (pane) delete pane.dataset.kinMgSlab; badge(tomo.slabbed.v, 'slab', null); }
      tomo.slabbed = null;
      if (v && original && applied && viewportOf(original.id) === original.viewport && imageIdOf(v) === original.imageId && scalarsOf(v)?.getData() === applied.array)
        try { putScalars(v, original.copy); } catch (error) { console.error(error); }
      tomo.original = null;
      // The outline drawn for the slab is the slice's again.
      if (show.edge) drawEdges();
      pressNow().catch(() => {});
    }
    async function drawSlab() {
      const v = tomo.v, ticket = ++tomo.ticket;
      if (!v || tomo.slab <= 1) { restoreSlab(); return; }
      const ids = idsOf(v), center = indexOf(v), shownId = imageIdOf(v), range = M.slabRange(center, tomo.slab, ids.length);
      if (!range || ids[center] !== shownId) return;
      const scalars = scalarsOf(v); if (!scalars) return;
      // The array on screen is this slice's own unless it is the slab drawn last for this same slice.
      const current = scalars.getData();
      if (!(tomo.applied?.array === current && tomo.original?.imageId === shownId && tomo.original.viewport === v))
        tomo.original = { id: tomo.id, viewport: v, imageId: shownId, copy: current.slice() };
      let images;
      try { images = await Promise.all(ids.slice(range.first, range.last + 1).map(id => core.imageLoader.loadAndCacheImage(id))); }
      catch (_) { if (ticket === tomo.ticket) tomo.sync?.('Slab: 단면을 불러오지 못했습니다.'); return; }
      if (ended || ticket !== tomo.ticket || viewportOf(tomo.id) !== v || imageIdOf(v) !== shownId) return;
      const arrays = images.map(pixelsOf), own = arrays[center - range.first], copy = tomo.original.copy;
      // Same grid, same conversion, and the slice's own pixels (the averaging input) are the values shown, every one of them:
      // the slices are averaged in the very value space the cell draws.
      let sameValues = !!own && own.length === copy.length;
      for (let i = 0; sameValues && i < copy.length; i++) if (own[i] !== copy[i]) sameValues = false;
      if (!M.slabCompatible(images.map(planeOf)) || !sameValues || arrays.some(a => !a || a.length !== copy.length)) {
        tomo.sync?.('Slab: 격자나 픽셀 값 변환이 다른 단면이 있어 합치지 않았습니다.'); return;
      }
      const out = new copy.constructor(copy.length);
      if (!M.slabAverage(arrays, out) || !putScalars(v, out)) return;
      tomo.applied = { array: out, range };
      tomo.slabbed = { id: tomo.id, v };
      const pane = v.element.closest('[data-cy=viewport-pane]'); if (pane) pane.dataset.kinMgSlab = 'on';
      badge(v, 'slab', M.slabLabel(range));
      if (show.edge) drawEdges();
      await pressNow();
      tomo.sync?.();
    }
    // The DBT cell: the active cell when the classifier confirms it holds a breast tomosynthesis stack, else the first such
    // cell; a CT, MR or other multi-image stack is never a Tomo cell — nor a cell given other images (A → B → A too)
    // while the header of those it held was read. Of the openings still reading headers only the latest opens the
    // panel, and none does once the panel was closed.
    async function openTomo(viewportId) {
      const opening = ++tomo.opening;
      let v = null, unread = false, changed = false;
      const candidates = [viewportOf(viewportId), ...cellIds().map(viewportOf)].filter((view, i, list) => view && list.indexOf(view) === i && idsOf(view).length > 1);
      for (const view of candidates) {
        const stack = stackKey(view), given = countOf(stacks, view.id), cell = await describe(view).catch(() => null);
        if (ended || opening !== tomo.opening) return;
        if (viewportOf(view.id) !== view || stackKey(view) !== stack || countOf(stacks, view.id) !== given) { changed = true; continue; }
        if (!cell) { unread = true; continue; }
        if (cell.kind === 'dbt' || cell.basis === 'ct-breast-tomosynthesis') { v = view; break; }
      }
      const panel = ui.panel({ id: 'tomo', title: 'Tomo (DBT) Slices' });
      if (!panel || panel === tomo.panel) return;
      tomo.panel = panel; tomo.v = v; tomo.id = v?.id ?? null; tomo.imageIds = v ? idsOf(v) : null; tomo.step = 1; tomo.slab = 1;
      const label = element('b', '', panel.body);
      const slider = element('input', '', panel.body); slider.type = 'range'; slider.min = '1'; slider.setAttribute('aria-label', 'Slice'); slider.style.width = '100%';
      const row = element('div', '', panel.body, 'kin-mg-row');
      const prev = button('◀ Prev', row, () => tomoStep(-1)), playButton = button('Play', row, () => play()), next = button('Next ▶', row, () => tomoStep(1));
      const choose = (name, options, change) => {
        const holder = element('label', '', panel.body, 'kin-mg-row'); element('span', name, holder);
        const select = element('select', '', holder); select.setAttribute('aria-label', name);
        for (const [value, text] of options) element('option', text, select).value = value;
        select.onchange = () => change(Number(select.value)); return select;
      };
      const step = choose('Step Interval', [1, 2, 3, 5, 10].map(n => [n, n + (n === 1 ? ' slice' : ' slices')]), n => { tomo.step = n; });
      const slab = choose('Slab Thickness', [1, 3, 5, 10].map(n => [n, n + (n === 1 ? ' slice' : ' slices')]), n => { tomo.slab = n; drawSlab(); });
      note('Slab Thickness: 지금 단면을 가운데로 한 n장의 평균을 이 칸에 그립니다(짝수는 뒤쪽으로 한 장 더, 끝에서는 있는 장만). ' +
        'Slab을 보는 동안 이 칸의 측정 표시와 마우스 도구는 꺼지고, 휠은 단면을 넘깁니다. 1 slice로 돌리면 원래 단면입니다.', panel.body);
      const status = statusLine(panel.body);
      let message = '';
      tomo.sync = text => {
        if (text !== undefined) message = text;
        const live = tomo.v && viewportOf(tomo.id) === tomo.v;
        const total = live ? idsOf(tomo.v).length : 0, at = live ? indexOf(tomo.v) + 1 : 0;
        label.textContent = live ? `Slice ${at} / ${total}` : 'Slice — / —';
        slider.max = String(Math.max(1, total)); slider.value = String(at || 1);
        playButton.textContent = tomo.timer ? 'Stop' : 'Play';
        for (const node of [slider, prev, next, playButton, step, slab]) node.disabled = !live;
        status.textContent = v ? (live ? message : '칸의 영상이 바뀌어 멈췄습니다. 다시 여세요.')
          : changed ? '여는 동안 칸의 영상이 바뀌었습니다. 다시 여세요.'
          : unread ? '영상 머리글을 읽지 못해 DBT(유방 단층) 칸인지 확인하지 못했습니다. 다시 여세요.' : '여러 단면이 있는 DBT(유방 단층) 칸이 없습니다. DBT 칸을 고른 뒤 다시 여세요.';
      };
      slider.oninput = () => tomoGo(Number(slider.value) - 1);
      panel.onClose(() => {
        tomo.opening++;
        if (tomo.panel !== panel) return;
        stopPlay(); restoreSlab();
        tomo.panel = tomo.v = tomo.id = tomo.sync = null;
      });
      tomo.sync('');
    }
    // The tomo cell shows a new slice (scrolled, played): the panel follows and a slab is drawn again for it.
    function tomoImage(event) {
      if (!tomo.panel || event.detail?.viewportId !== tomo.id) return;
      tomo.sync?.();
      if (tomo.slab > 1) drawSlab();
    }
    // The tomo cell was given other images, or the grid changed: stop, and the cell's own array comes back.
    function tomoCell(ids) {
      if (!tomo.panel || (ids && !ids.includes(tomo.id))) return;
      const v = viewportOf(tomo.id);
      if (v === tomo.v && JSON.stringify(idsOf(v)) === JSON.stringify(tomo.imageIds)) return;
      stopPlay(); restoreSlab(); tomo.v = null; tomo.sync?.();
    }

    // ── Breast Display ──
    const PITCH_KEY = 'kin-mg-monitor-pitch:v1';
    const pitches = () => { try { const value = JSON.parse(localStorage.getItem(PITCH_KEY) || '{}'); return value && typeof value === 'object' ? value : {}; } catch (_) { return {}; } };
    // The screen this window stands on. With the window-management permission already granted (it is never asked for here)
    // the browser's own screen details name it (label, place, size); otherwise the size and place of window.screen. That is
    // a key of the screen arrangement now, not a lasting monitor id: without one, or with two screens alike, there is no
    // key and no stored value is reused.
    let screenDetails = null;
    (async () => {
      try {
        const permission = await navigator.permissions?.query?.({ name: 'window-management' });
        if (permission?.state !== 'granted' || typeof window.getScreenDetails !== 'function' || ended) return;
        screenDetails = await window.getScreenDetails();
        for (const type of ['currentscreenchange', 'screenschange']) screenDetails.addEventListener?.(type, event => screenChanged(event), { signal });
      } catch (_) { screenDetails = null; }
    })();
    function screenNow() {
      const dpr = window.devicePixelRatio || 1, s = screenDetails?.currentScreen;
      if (!s) return { key: M.monitorKey(window.screen), dpr };
      const keyOf = o => M.monitorKey(o) && (o.label || '') + '|' + M.monitorKey(o);
      const key = keyOf(s), twins = (screenDetails.screens || [s]).filter(o => keyOf(o) === key).length;
      return { key: twins > 1 ? null : key, dpr };
    }
    // The browser's zoom or the screen's scale changed (devicePixelRatio).
    let dprQuery = null;
    const onDpr = event => { watchDpr(); screenChanged(event); };
    function watchDpr() {
      dprQuery?.removeEventListener?.('change', onDpr);
      try { dprQuery = window.matchMedia('(resolution: ' + (window.devicePixelRatio || 1) + 'dppx)'); dprQuery.addEventListener?.('change', onDpr); } catch (_) { dprQuery = null; }
    }
    watchDpr();    const pitchFor = key => { const value = key ? pitches()[key] : undefined; return M.validPitch(value) ? value : null; };
    function savePitch(key, value) {
      if (!key || !M.validPitch(value)) return false;
      try { localStorage.setItem(PITCH_KEY, JSON.stringify({ ...pitches(), [key]: value })); return true; } catch (_) { return false; }
    }
    const show = { panel: null, status: null, pitchRow: null, edge: false, edgeAsked: false, wl: new Map(), wlTicket: 0, wlWaiting: false, modes: new Map(), screen: null, sessionPitch: null };
    // A Breast Display zoom mode and a Quadrant Zoom step are each the cell's zoom until the other is set there.
    const setMode = (v, text) => { dropQuadrant(v.id); show.modes.set(v.id, { viewport: v, text }); badge(v, 'zoom', 'Zoom mode: ' + text); };
    function dropZoomMode(id) { const mode = show.modes.get(id); if (mode) { show.modes.delete(id); badge(mode.viewport, 'zoom', null); } }
    function geometryOf(v) {
      const instance = instanceOf(v);
      if (!instance || typeof window.kinPlanarGeometry !== 'function') return null;
      try {
        const frame = Number(instance.NumberOfFrames) > 1 ? indexOf(v) + 1 : 1, g = window.kinPlanarGeometry(instance, frame);
        return g?.spacing ? { spacing: Number(g.spacing[0]), basis: String(g.calculator || '').split(':').pop() } : null;
      } catch (_) { return null; }
    }
    function drawOutline(cell, region) {
      const entry = layerOf(cell.v); if (!entry) return;
      if (!entry.outline) entry.outline = element('canvas', '', entry.stage, 'kin-mg-outline');
      const canvas = entry.outline, width = cell.v.element.clientWidth, height = cell.v.element.clientHeight, ratio = window.devicePixelRatio || 1;
      canvas.width = Math.round(width * ratio); canvas.height = Math.round(height * ratio);
      const g = canvas.getContext('2d'); g.setTransform(ratio, 0, 0, ratio, 0, 0); g.clearRect(0, 0, width, height);
      g.strokeStyle = '#E8C547'; g.lineWidth = 1.5; g.beginPath();
      region.outline.forEach((point, i) => { const p = cell.v.worldToCanvas(toWorld(cell.v, point)); if (i) g.lineTo(p[0], p[1]); else g.moveTo(p[0], p[1]); });
      g.closePath(); g.stroke();
      canvas.dataset.points = String(region.outline.length);
    }
    // Each call takes a new ticket: one still reading image headers draws nothing when a later one (or Breast Edge off)
    // came meanwhile. The lines there were go at once; a cell without a region gets none, and is marked and named.
    // What the Breast Edge button says is what was drawn, said once it is (by whichever drawing comes first after the press).
    let edgeTicket = 0;
    async function drawEdges() {
      const ticket = ++edgeTicket;
      for (const entry of layers.values()) { entry.outline?.remove(); entry.outline = null; }
      clearBadges('edge');
      if (!show.edge) return;
      const list = await mgCells();
      if (ended || ticket !== edgeTicket || !show.edge) return;
      const missed = leftOut(list);
      for (const cell of list) {
        const region = regionOf(cell);
        if (region.found) drawOutline(cell, region); else { missed.push(labelOf(cell)); badge(cell.v, 'edge', '경계를 찾지 못했습니다'); }
      }
      if (!show.edgeAsked) return;
      show.edgeAsked = false;
      say(!list.length ? NO_CELLS : missed.length ? '경계를 찾지 못한 칸 — ' + missed.join(' / ') : '유방 경계를 그렸습니다. 다시 누르면 지웁니다.');
    }
    function pressEdge() { show.edge = !show.edge; show.edgeAsked = show.edge; say(''); drawEdges(); }
    // The cell's VOI as it is (window, function, inversion and a stored table on the GPU actor), and back.
    function transfer(v) { try { return v.getDefaultActor()?.actor?.getProperty().getRGBTransferFunction(0) || null; } catch (_) { return null; } }
    function voiNow(v) {
      const props = v.getProperties(), tf = transfer(v), nodes = [];
      if (tf) for (let i = 0; i < tf.getSize(); i++) { const node = []; tf.getNodeValue(i, node); nodes.push(node.slice(0, 6)); }
      return { voiRange: props.voiRange ? { ...props.voiRange } : null, VOILUTFunction: props.VOILUTFunction, invert: !!props.invert, nodes };
    }
    function voiBack(v, before) {
      v.setProperties({ VOILUTFunction: before.VOILUTFunction, invert: before.invert });
      if (before.voiRange) v.setVOI({ ...before.voiRange }, { forceRecreateLUTFunction: true });
      const tf = transfer(v);
      if (tf && before.nodes.length) { tf.removeAllPoints(); for (const [x, r, g, b, mid, sharp] of before.nodes) tf.addRGBPointLong(x, r, g, b, mid ?? 0.5, sharp ?? 0); }
      v.render();
    }
    function wlOff() {
      for (const [id, entry] of show.wl) {
        const v = viewportOf(id);
        if (v === entry.viewport && stackKey(v) === entry.stack) try { applying.add(id); voiBack(v, entry.before); } catch (error) { console.error(error); } finally { applying.delete(id); }
      }
      show.wl.clear(); clearBadges('wl');
    }
    // The button turns Breast W/L on, and off again: a press while the first is still waiting for the image headers is
    // the press that turns it off (nothing was changed yet, and nothing is then), so the window, the table and the
    // inversion a cell had are taken once, from the cell as the reader had it, and are what Off gives back.
    async function breastWl() {
      const ticket = ++show.wlTicket;
      if (show.wlWaiting || show.wl.size) { show.wlWaiting = false; wlOff(); say('Breast W/L을 껐습니다. 원래 창(VOI LUT·반전 포함)으로 돌아갔습니다.'); return; }
      show.wlWaiting = true;
      const list = await mgCells();
      if (ended || ticket !== show.wlTicket) return;
      show.wlWaiting = false; clearBadges('wl');
      if (!list.length) { say(NO_CELLS); return; }
      const failed = leftOut(list);
      for (const cell of list) {
        const region = regionOf(cell);
        let values; try { values = imageData(cell.v).getPointData().getScalars().getData(); } catch (_) { values = null; }
        const window_ = region.found && values ? M.regionWindow(values, cell.columns, cell.rows, region) : null;
        if (!window_) { failed.push(labelOf(cell)); badge(cell.v, 'wl', 'Breast W/L: 경계를 찾지 못했습니다'); continue; }
        const before = voiNow(cell.v);
        applying.add(cell.id);
        try {
          cell.v.setProperties({ VOILUTFunction: 'LINEAR', invert: before.invert });
          cell.v.setVOI({ lower: window_.lower, upper: window_.upper }, { forceRecreateLUTFunction: true }); cell.v.render();
        } finally { applying.delete(cell.id); }
        show.wl.set(cell.id, { viewport: cell.v, stack: stackKey(cell.v), before, window: window_ });
        badge(cell.v, 'wl', 'Breast W/L');
      }
      say(failed.length ? '경계를 찾지 못해 창을 바꾸지 않은 칸 — ' + failed.join(' / ') : 'Breast W/L: 유방 영역 픽셀(1–99 백분위)로 창을 정했습니다. 다시 누르면 원래 창입니다.');
    }
    const say = text => { if (show.status) show.status.textContent = text; };
    // A zoom mode is a camera command: the latest one pressed is the one carried out and the one that says so, and a
    // cell whose camera was changed since it was pressed is left as it is and named — as is one given another image
    // since, or whose header could not be read (left).
    async function zoomMode(kind) {
      const act = cameraAct();
      const all = await mgCells(), skipped = [], left = leftOut(all);
      if (!cameraHolds(act)) return;
      if (!all.length) { say(NO_CELLS); return; }
      const list = all.filter(cell => cameraHolds(act, cell.id) || !left.push(labelOf(cell)));
      if (!show.edge) clearBadges('edge');
      const missed = cell => { skipped.push(labelOf(cell)); if (!show.edge) badge(cell.v, 'edge', '경계를 찾지 못했습니다'); };
      if (kind === 'match') {
        const groups = new Map();
        for (const cell of list) { if (!cell.view) { skipped.push(labelOf(cell)); continue; } groups.set(cell.view, [...(groups.get(cell.view) || []), cell]); }
        const unset = [];
        for (const group of groups.values()) {
          const entries = group.map(cell => {
            const region = regionOf(cell), box = region.found ? region.box : null, zoom = zoomOf(cell.v), shown = box && shownBox(cell.v, box);
            if (!box) missed(cell);
            return { cell, box, id: cell.id, zoom, perPixel: 1, length: shown?.length ?? 0, fit: shown && fitShown(cell.v, zoom, shown) };
          });
          const zooms = M.matchSize(entries);
          // Each breast at the matched zoom, centred in its cell (as Fit Breast centres it), so none is cut off.
          for (const entry of entries) {
            if (!entry.box) continue;
            const world = zooms[entry.id] && toWorld(entry.cell.v, [(entry.box.x0 + entry.box.x1) / 2, (entry.box.y0 + entry.box.y1) / 2]);
            if (world && steer(entry.cell.v, () => { entry.cell.v.setZoom(zooms[entry.id]); centerOn(entry.cell.v, world); }, act)) setMode(entry.cell.v, 'Match Size');
            else unset.push(labelOf(entry.cell));
          }
        }
        say(left.length || unset.length ? '바꾸지 않은 칸 — ' + [...left, ...skipped, ...unset].join(' / ') : skipped.length ? '경계를 찾지 못해 맞추지 않은 칸 — ' + skipped.join(' / ')
          : 'Match Size: 같은 뷰의 칸끼리 흉벽–유두 길이를 화면에서 같게 맞췄습니다(모든 유방이 칸 안에 다 보이는 가장 큰 크기).');
        return;
      }
      if (kind === 'true') {
        const now = screenNow(), pitch = pitchFor(now.key) ?? (show.sessionPitch?.key === now.key && now.key === null ? show.sessionPitch.value : null);
        if (!pitch) { openPitch(); return; }
        show.screen = now;
        for (const cell of list) {
          const g = geometryOf(cell.v), zoom = g && M.trueSize({ zoom: zoomOf(cell.v), perPixel: perPixel(cell.v), spacing: g.spacing, pitch, dpr: now.dpr });
          if (!zoom) { skipped.push(labelOf(cell)); continue; }
          steer(cell.v, () => cell.v.setZoom(zoom), act); setMode(cell.v, M.trueSizeLabel(g.basis));
        }
        say((left.length ? '바꾸지 않은 칸 — ' + left.join(' / ') + '. ' : '') + (skipped.length ? '픽셀 간격을 확인할 수 없어 바꾸지 않은 칸 — ' + skipped.join(' / ') + '. ' : '')
          + `True Size: 이 화면의 픽셀 크기 ${pitch} mm 기준입니다.`);
        return;
      }
      skipped.push(...left);
      for (const cell of list) {
        const v = cell.v;
        if (kind === 'fit') { fit(v, act); setMode(v, 'Fit'); continue; }
        if (kind === 'pixel') {
          const zoom = M.onePixel({ zoom: zoomOf(v), perPixel: perPixel(v), dpr: window.devicePixelRatio || 1 });
          if (zoom) { steer(v, () => v.setZoom(zoom), act); setMode(v, '1:1'); } else skipped.push(labelOf(cell));
          continue;
        }
        if (kind === 'breast') {
          const region = regionOf(cell);
          if (!region.found) { missed(cell); continue; }
          const box = region.box, shown = shownBox(v, box), zoom = shown && fitShown(v, zoomOf(v), shown);
          const world = toWorld(v, [(box.x0 + box.x1) / 2, (box.y0 + box.y1) / 2]);
          if (zoom && world && steer(v, () => { v.setZoom(zoom); centerOn(v, world); }, act)) setMode(v, 'Fit Breast'); else skipped.push(labelOf(cell));
        }
      }
      say(skipped.length ? '바꾸지 않은 칸 — ' + skipped.join(' / ') : '');
    }
    // The breast box as the cell shows it now, in CSS pixels: its width and height on the screen and the screen length of
    // its chest-wall-to-nipple axis (along the image rows, through the box's middle) — whatever the cell's rotation, flips
    // and pixel spacing. Null when the cell cannot say.
    function shownBox(v, box) {
      const at = (x, y) => { try { const world = toWorld(v, [x, y]), p = world && v.worldToCanvas(world); return p && p.every(Number.isFinite) ? p : null; } catch (_) { return null; } };
      const corners = [[box.x0, box.y0], [box.x1, box.y0], [box.x0, box.y1], [box.x1, box.y1]].map(([x, y]) => at(x, y));
      const middle = (box.y0 + box.y1) / 2, a = at(box.x0, middle), b = at(box.x1, middle);
      if (!a || !b || corners.some(p => !p)) return null;
      const xs = corners.map(p => p[0]), ys = corners.map(p => p[1]);
      return { width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys), length: Math.hypot(b[0] - a[0], b[1] - a[1]) };
    }
    // The zoom that fits a box shown at `shown` (shownBox) in the cell, as the Fit Breast mode does.
    const fitShown = (v, zoom, shown) => M.fitRect({ zoom, perPixel: 1, ...cellSize(v), width: shown.width, height: shown.height });
    function openPitch() {
      if (!show.pitchRow) return;
      show.pitchRow.hidden = false; show.pitchRow.querySelector('input').focus();
      say('True Size에는 이 모니터의 실제 픽셀 크기가 필요합니다(브라우저는 알 수 없습니다). 모니터 사양의 픽셀 피치(mm)를 넣으세요. 이 PC의 이 브라우저에 화면별로 저장합니다.');
    }
    // The window moved to another screen or the browser's zoom changed: True Size is drawn again for that screen's value,
    // or the cells go back to Fit and the value is asked for.
    // A screen change event (the browser moved the window to another screen) is a change in itself: on screens that cannot
    // be told apart (no key) it is never taken as the same screen. A resize only counts when the key or the scale changed.
    function screenChanged(event) {
      const was = show.screen, now = screenNow();
      if (!was) return;
      const moved = event?.type === 'currentscreenchange' || event?.type === 'change';
      const unknown = was.key === null || now.key === null;
      if (was.key === now.key && was.dpr === now.dpr && !(moved && unknown)) return;
      show.sessionPitch = null;
      const trueCells = [...show.modes].filter(([, mode]) => mode.text.startsWith('True Size'));
      show.screen = null;
      if (!trueCells.length) return;
      if (!unknown && pitchFor(now.key)) { zoomMode('true'); return; }
      // Back to Fit at once, as a command received now: nothing asked for before it is carried out afterwards.
      const act = cameraAct();
      for (const [id, mode] of trueCells) { const v = viewportOf(id); if (v === mode.viewport) { fit(v, act); setMode(v, 'Fit'); } }
      if (show.panel) openPitch(); else ui.toast('화면이 바뀌어 True Size를 Fit으로 돌렸습니다. Breast Display에서 이 화면의 픽셀 크기를 넣으세요.');
    }
    function openBreastDisplay() {
      const panel = ui.panel({ id: 'breast', title: 'Breast Display' });
      if (!panel || panel === show.panel) return;
      show.panel = panel;
      const row = element('div', '', panel.body, 'kin-mg-row');
      button('Breast Edge', row, () => pressEdge(), '각 MG 칸에서 유방 영역을 찾아 경계선을 그립니다');
      button('Breast W/L', row, () => breastWl(), '유방 영역 안의 픽셀만으로 창을 정합니다');
      button('Fit', row, () => zoomMode('fit'), '영상을 칸에 맞춥니다');
      button('1:1', row, () => zoomMode('pixel'), '영상 픽셀 1개를 화면 픽셀 1개로');
      button('True Size', row, () => zoomMode('true'), '화면의 1 mm를 영상의 1 mm로(모니터 픽셀 크기 필요)');
      button('Fit Breast', row, () => zoomMode('breast'), '유방 영역을 칸에 맞춥니다');
      button('Match Size', row, () => zoomMode('match'), '같은 뷰의 칸끼리 유방 크기를 맞춥니다');
      show.pitchRow = element('label', '', panel.body, 'kin-mg-row'); show.pitchRow.hidden = true;
      element('span', 'Monitor pixel pitch (mm)', show.pitchRow);
      const pitch = element('input', '', show.pitchRow); pitch.type = 'number'; pitch.step = '0.001'; pitch.min = '0.05'; pitch.max = '1';
      pitch.setAttribute('aria-label', 'Monitor pixel pitch (mm)');
      const current = pitchFor(screenNow().key); if (current) pitch.value = String(current);
      pitch.onchange = () => {
        const value = Number(pitch.value), key = screenNow().key;
        if (!M.validPitch(value)) { say('0.05–1 mm 사이의 값을 넣으세요.'); return; }
        // Without a screen key the value serves this window only (it is not stored for a screen it may not be).
        if (!savePitch(key, value)) show.sessionPitch = { key, value };
        show.pitchRow.hidden = true; zoomMode('true');
      };
      note('표시 처리(경계·창·크기)는 누를 때만 걸리고 칸마다 표지가 붙습니다. Fit으로 돌아가고, Breast W/L은 다시 누르면 원래 창입니다.', panel.body);
      show.status = statusLine(panel.body);
      panel.onClose(() => { if (show.panel !== panel) return; show.panel = show.status = show.pitchRow = null; });
    }
    // A cell given another image drops what was drawn for the earlier one.
    const stackKey = v => { const ids = idsOf(v); return ids.length + '|' + (ids[0] || '') + '|' + (ids[ids.length - 1] || ''); };
    function cellImage(id) {
      const v = viewportOf(id);
      const entry = show.wl.get(id);
      // Another slice or frame of the same stack keeps the window (the viewer does not set the stored one again for it), so it
      // keeps its mark and its way back; another stack or viewport drops it.
      if (entry && (v !== entry.viewport || stackKey(v) !== entry.stack)) { show.wl.delete(id); badge(entry.viewport, 'wl', null); }
      const mode = show.modes.get(id);
      if (mode && v !== mode.viewport) { show.modes.delete(id); badge(mode.viewport, 'zoom', null); }
      quadrantImage(id);
      if (show.edge) drawEdges();
    }

    // ── Mammo Keypad ──
    const tabs = () => window.KinViewerPatientTabs;
    const pad = { panel: null, paint: null };
    function openKeypad() {
      const panel = ui.panel({ id: 'keypad', title: 'Mammo Keypad' });
      if (!panel) return null;
      if (panel === pad.panel) return pad;
      pad.panel = panel;
      const keys = element('div', '', panel.body, 'kin-mg-row');
      const next = button('Patient ▶', keys, () => pressNext(), '다음 열린 환자의 검사로 영상과 판독 대상을 옮깁니다');
      next.dataset.mgKey = 'next-patient';
      element('b', 'Open Patients', panel.body);
      const list = element('ol', '', panel.body, 'kin-mg-patients');
      const question = element('div', '', panel.body, 'kin-mg-question'); question.hidden = true; question.setAttribute('role', 'alertdialog');
      const status = statusLine(panel.body);
      pad.question = question;
      pad.paint = () => {
        const open = tabs()?.list?.() || [];
        list.replaceChildren(...open.map(tab => {
          // The report target is named only where the reading screen confirmed it (the last keypad move or its way back).
          const item = element('li', [tab.patient.name, tab.patient.id].join(' | ') + (tab.current ? '  ← images' + (carry.reportTarget && carry.reportTarget === tab.studies[0] ? ' · report target' : '') : ''));
          item.setAttribute('aria-current', String(tab.current)); return item;
        }));
        next.disabled = open.length < 2 || carry.busy || !!tabs()?.moving?.();
        status.textContent = carry.busy ? '환자를 옮기는 중입니다…' : carry.message || (open.length < 2 ? '열린 다른 환자가 없습니다.' : '');
      };
      panel.onClose(() => { if (pad.panel !== panel) return; pad.panel = pad.paint = pad.question = null; carry.message = null; });
      pad.paint();
      return pad;
    }
    // Patient ▶ (the button, or the Next Patient key): moves at once when the reading screens hold no unconfirmed text of
    // this patient's studies; otherwise asks Save Draft & Move / Discard & Move / Cancel.
    async function pressNext() {
      const opened = openKeypad();
      if (!opened || carry.busy || tabs()?.moving?.()) return;
      const open = tabs()?.list?.() || [];
      if (open.length < 2) { opened.paint(); return; }
      carry.message = null; opened.paint();
      const reason = await tabs().unsaved();
      if (ended || pad !== opened || !pad.panel) return;
      if (reason === null) { move('save'); return; }
      const now = open.find(tab => tab.current)?.patient.name || '';
      const question = pad.question; question.hidden = false; question.replaceChildren();
      element('p', `${now}의 판독 초안이 저장되지 않았습니다 (${reason}).`, question);
      element('p', 'Discard & Move는 자동 저장된 부분을 포함해 이 검사의 초안 전체를 버리고 저장된 판독문으로 돌아갑니다.', question);
      const row = element('div', '', question, 'kin-mg-row');
      button('Save Draft & Move', row, () => move('save'), '판독 화면에서 초안을 저장하고, 저장이 확인되면 옮깁니다');
      button('Discard & Move', row, () => move('discard'), '판독 화면에서 이 검사의 초안 전체를 버리고(저장된 판독문으로 돌아감), 버린 것이 확인되면 옮깁니다');
      button('Cancel', row, () => { question.hidden = true; question.replaceChildren(); pad.panel?.focus(); });
      row.querySelector('button').focus();
    }
    async function move(intent) {
      if (carry.busy || !tabs()?.next) return;
      if (pad.question) { pad.question.hidden = true; pad.question.replaceChildren(); }
      carry.busy = true; carry.message = null; pad.paint?.();
      let result;
      try { result = await tabs().next(intent); } catch (error) { result = { ok: false, message: error?.message || '환자를 옮기지 못했습니다.' }; }
      carry.busy = false; carry.message = result?.message || '';
      carry.reportTarget = result?.reportTarget ?? null;
      // This module may have been replaced by the viewer of the patient moved to: that one shows the result.
      carry.listener?.();
    }

    // ── Events ──
    const listen = (type, fn) => { if (type) document.addEventListener(type, fn, { capture: true, signal }); };
    listen(events.IMAGE_RENDERED, lensRedraw);
    listen(events.CAMERA_MODIFIED, event => {
      const id = event.detail?.viewportId;
      // A camera change this module did not make (the reader's, the viewer's): an act received before it leaves that cell.
      if (id && !applying.has(id)) stamps.set(id, ++turn.received);
      cameraChanged(event); if (id) quadrantCamera(id); if (show.edge) drawEdges();
    });
    window.addEventListener('kin-viewer-tool-run', event => { invertRun(event).catch(error => console.error(error)); }, { signal });
    listen(events.STACK_NEW_IMAGE, event => { tomoImage(event); const id = event.detail?.viewportId; if (id) { changes.set(id, countOf(changes, id) + 1); cellImage(id); cellsChanged(); } });
    window.addEventListener('resize', screenChanged, { signal });
    try { window.screen.addEventListener?.('change', screenChanged, { signal }); } catch (_) {}
    const subscriptions = [];
    const subscribe = (service, event, fn) => { try { if (event && service?.subscribe) subscriptions.push(service.subscribe(event, fn)); } catch (error) { console.error(error); } };
    subscribe(grid, grid?.EVENTS?.GRID_STATE_CHANGED, () => { tomoCell(null); for (const id of cellIds()) cellImage(id); cellsChanged(); });
    subscribe(cellService, cellService?.EVENTS?.VIEWPORT_DATA_CHANGED, event => {
      tomoCell(event?.viewportId ? [event.viewportId] : null);
      const id = event?.viewportId;
      if (id) { changes.set(id, countOf(changes, id) + 1); stacks.set(id, countOf(stacks, id) + 1); cellImage(id); }
      cellsChanged();
    });
    subscribe(services.cineService, services.cineService?.EVENTS?.CINE_STATE_CHANGED, cineChanged);

    // ── Menu ──
    ui.menuItem('MG', { id: 'mgMirrored', label: 'Mirrored', order: 1, run: () => openMirrored() });
    ui.menuItem('MG', { id: 'mgQuadrantZoom', label: 'Quadrant Zoom', order: 2, run: () => openQuadrant() });
    ui.menuItem('MG', { id: 'mgTomoSlices', label: 'Tomo (DBT) Slices', order: 3, run: ({ viewportId }) => openTomo(viewportId) });
    ui.menuItem('MG', { id: 'mgBreastDisplay', label: 'Breast Display', order: 4, run: () => openBreastDisplay() });
    ui.menuItem('MG', { id: 'mgKeypad', label: 'Mammo Keypad', order: 5, run: () => { openKeypad(); } });
    ui.menuItem('MG', { id: 'mgMagnifier', label: 'Magnifier', order: 6, run: () => setMagnifier(!lens.on) });
    ui.shortcut({ id: 'mgNextPatient', label: 'Next Patient', run: () => pressNext() });

    // The report target the reading screen confirmed holds only until the viewer shows other studies (a tab switch, an
    // opening) or this window is linked to another list.
    const forget = () => { if (carry.busy) return; carry.reportTarget = null; pad.paint?.(); };
    const stopTabs = tabs()?.subscribe?.(forget);
    for (const type of ['hashchange', 'kin-window-link-changed']) window.addEventListener(type, forget, { signal });
    // After a Patient ▶ move the keypad is open again, with the move's result when it comes.
    const listener = () => { if (!ended) { openKeypad(); pad.paint?.(); } };
    carry.listener = listener;
    if (carry.busy || carry.message) openKeypad();

    return () => {
      ended = true;
      if (carry.listener === listener) carry.listener = null;
      try { stopTabs?.(); } catch (_) {}
      stopPlay(); restoreSlab(); wlOff(); endQuadrant(); stageSizes?.disconnect();
      abort.abort(); dprQuery?.removeEventListener?.('change', onDpr);
      for (const timer of timers) clearInterval(timer);
      if (cameraFrame) cancelAnimationFrame(cameraFrame);
      if (lensFrame) cancelAnimationFrame(lensFrame);
      for (const subscription of subscriptions) try { subscription?.unsubscribe?.(); } catch (_) {}
      for (const entry of layers.values()) entry.node.remove();
      layers.clear(); style.remove();
    };
  });
})();
