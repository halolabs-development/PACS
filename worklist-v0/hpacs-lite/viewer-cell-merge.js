/* Session-only cell merge / maximize for the fixed viewer grid.
   The native grid already renders per-position fractional rectangles through
   setLayout({layoutOptions}); this module only decides which rectangles to ask for,
   records what was on screen first, and refuses whatever it cannot put back. */
// The viewer write path (viewer-language.js): product words in the reader's screen language, or as written.
function kinText(t, ...p) { const l = typeof window === 'object' && window && window.KinLanguage; return l && l.text ? l.text(t, ...p) : t.replace(/\{[ten]?(\d+)\}/g, (m, i) => String(p[i])); }
function kinHtml(t, ...p) { const l = typeof window === 'object' && window && window.KinLanguage; return l && l.html ? l.html(t, ...p) : t.replace(/\{[ten]?(\d+)\}/g, (m, i) => String(p[i])); }
(function (root) {
  'use strict';
  // 1x3 and 3x1 are the grids the app's own MPR button builds; 2x2 is the Hanging Protocol
  // plane grid, with or without a vacancy. No grid is invented here: every base is one the
  // viewer already produces (viewer-volume-job.js:7, viewer-hanging-protocol.js:132).
  const BASES = [[1, 2], [2, 1], [2, 2], [1, 3], [3, 1]];
  const CAMERA_KEYS = ['focalPoint', 'position', 'viewUp', 'viewPlaneNormal', 'parallelScale', 'flipHorizontal', 'flipVertical'];
  const ORIENTATIONS = ['axial', 'sagittal', 'coronal'], PLANE_AXIS = { axial: 2, sagittal: 0, coronal: 1 };
  const near = (a, b) => Math.abs(a - b) <= 1e-6;
  const copy = value => (typeof structuredClone === 'function' ? structuredClone(value) : JSON.parse(JSON.stringify(value)));
  const rect = (x, y, width, height) => ({ x, y, width, height });

  // Rectangles per operation, in native position order (position = col + row*numCols).
  // `merged` is the slot that keeps the anchor cell's source.
  function shape(op, side) {
    if (op === 'maximize') return { options: [rect(0, 0, 1, 1)], merged: 0 };
    if (op === 'merge-column') {
      return side === 0
        ? { options: [rect(0, 0, .5, 1), rect(.5, 0, .5, .5), rect(.5, .5, .5, .5)], merged: 0 }
        : { options: [rect(0, 0, .5, .5), rect(.5, 0, .5, 1), rect(0, .5, .5, .5)], merged: 1 };
    }
    if (op === 'merge-row') {
      return side === 0
        ? { options: [rect(0, 0, 1, .5), rect(0, .5, .5, .5), rect(.5, .5, .5, .5)], merged: 0 }
        : { options: [rect(0, 0, .5, .5), rect(.5, 0, .5, .5), rect(0, .5, 1, .5)], merged: 2 };
    }
    return null;
  }

  // A cell is {viewportId,x,y,width,height,sets,kind}; kind is 'stack' for a loaded classic
  // stack, 'plane' for a loaded MPR orthographic plane and 'empty' for a cell with no
  // source. Anything else - a VR 3D volume, an SR, a PDF, a cell still loading, a plane
  // whose volume or orientation cannot be established - refuses the whole operation.
  const SHOWS_IMAGE = ['stack', 'plane'];

  // A viewer window over two monitors: a maximize fills the anchor's monitor, not the whole window ("한 모니터 2×2,
  // 모니터 2개면 2×2 두 개. 더블클릭하면 그 칸이 모니터 전체 1분할"). `edges` are the display edges inside the grid as
  // fractions of its width (KinViewerMonitorPlan.edges); a cell belongs to the monitor its centre is on, and the
  // monitor's area is the outline of its cells, which must fill it exactly, hold no other cell and cross no edge.
  // Answers null when the maximize is the whole grid as before (no edge inside the grid, a uniform base), { reason }
  // when it would have to reach over a display edge, and { area, group } otherwise. The base is a uniform grid, or the
  // split an applied Hanging Protocol (or a saved Job) registered as its geometry (`split`, window.kinViewerSplitRects);
  // such a split on one monitor maximizes over its own image area. A uniform grid's monitor part must be a grid the
  // viewer builds (BASES).
  const finiteBox = cell => !!cell && [cell.x, cell.y, cell.width, cell.height].every(Number.isFinite) && cell.width > 0 && cell.height > 0;
  const sameBox = (a, b) => near(a.x, b.x) && near(a.y, b.y) && near(a.width, b.width) && near(a.height, b.height);
  const byPlace = (a, b) => (near(a.y, b.y) ? a.x - b.x : a.y - b.y);
  const meets = (a, b) => Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x) > 1e-4 && Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y) > 1e-4;
  function uniformGrid(rows, cols, cells) {
    return Number.isInteger(rows) && Number.isInteger(cols) && rows > 0 && cols > 0 && Array.isArray(cells) && cells.length === rows * cols &&
      cells.every((cell, index) => finiteBox(cell) && sameBox(cell, rect((index % cols) / cols, Math.floor(index / cols) / rows, 1 / cols, 1 / rows)));
  }
  // The split registered for this screen, as the native grid shows it: the same rectangles, inside the grid, none over
  // another, on a base grid with room for them all.
  function registeredSplit(rows, cols, cells, split) {
    if (!Array.isArray(split) || !Array.isArray(cells) || cells.length < 1 || cells.length > 16 || split.length !== cells.length ||
        !Number.isInteger(rows) || !Number.isInteger(cols) || rows * cols < cells.length || !split.every(finiteBox) || !cells.every(finiteBox)) return false;
    if (cells.some(c => c.x < -1e-6 || c.y < -1e-6 || c.x + c.width > 1 + 1e-6 || c.y + c.height > 1 + 1e-6)) return false;
    if (cells.some((a, i) => cells.some((b, j) => j > i && meets(a, b)))) return false;
    const mine = cells.slice().sort(byPlace), theirs = split.slice().sort(byPlace);
    return mine.every((cell, index) => sameBox(cell, theirs[index]));
  }
  const CROSSES = kinText("칸이 모니터 경계에 걸쳐 있어 그 모니터만 확대할 수 없습니다. 경계에 맞춘 배치(Span Displays 또는 Monitors in Hanging Protocol)에서 사용하세요.");
  const ALONE = kinText("이 칸은 이미 그 모니터의 한 화면입니다.");
  function monitorArea(request) {
    const { rows, cols, cells, anchorId, edges, split } = request || {};
    if (!Array.isArray(cells) || !cells.every(finiteBox)) return null;
    const anchor = cells.find(cell => cell.viewportId === anchorId);
    if (!anchor) return null;
    const uniform = uniformGrid(rows, cols, cells), registered = !uniform && registeredSplit(rows, cols, cells, split);
    if (!uniform && !registered) return null;
    const lines = (Array.isArray(edges) ? edges : []).filter(edge => Number.isFinite(edge) && edge > 1e-3 && edge < 1 - 1e-3).sort((a, b) => a - b);
    if (uniform && !lines.length) return null;
    const monitor = cell => lines.filter(edge => cell.x + cell.width / 2 > edge).length;
    const group = cells.filter(cell => monitor(cell) === monitor(anchor));
    const left = Math.min(...group.map(c => c.x)), top = Math.min(...group.map(c => c.y));
    const area = rect(left, top, Math.max(...group.map(c => c.x + c.width)) - left, Math.max(...group.map(c => c.y + c.height)) - top);
    if (lines.some(edge => edge > area.x + 1e-3 && edge < area.x + area.width - 1e-3)) return { reason: CROSSES };
    if (group.length < 2) return lines.length ? { reason: ALONE } : null;
    const inside = cell => cell.x >= area.x - 1e-6 && cell.y >= area.y - 1e-6 && cell.x + cell.width <= area.x + area.width + 1e-6 && cell.y + cell.height <= area.y + area.height + 1e-6;
    const filled = group.reduce((sum, cell) => sum + cell.width * cell.height, 0);
    if (!group.every(inside) || Math.abs(filled - area.width * area.height) > 1e-6 || cells.some(cell => !group.includes(cell) && meets(cell, area))) return { reason: CROSSES };
    if (uniform) {
      const partRows = new Set(group.map(cell => Math.round(cell.y * 1e6))).size, partCols = new Set(group.map(cell => Math.round(cell.x * 1e6))).size;
      if (!BASES.some(([r, c]) => r === partRows && c === partCols)) return { reason: kinText("1·2·4화면의 일반 CT 격자 또는 3평면 MPR 배치에서만 칸을 확대·병합할 수 있습니다.") };
    }
    return { area, group: group.map(cell => cell.viewportId) };
  }
  // The maximize of one monitor's area: the anchor takes the area, every other monitor's cell keeps its rectangle.
  function planArea(request, found) {
    const { rows, cols, cells, anchorId } = request;
    if (cells.some(cell => !cell || typeof cell.viewportId !== 'string' || !cell.viewportId) || new Set(cells.map(cell => cell.viewportId)).size !== cells.length)
      return { ok: false, reason: kinText("화면 구성을 확인할 수 없습니다.") };
    if (cells.some(cell => !['stack', 'empty', 'plane'].includes(cell?.kind)))
      return { ok: false, reason: kinText("3D·SR·PDF 화면이나 아직 불러오지 못한 칸이 있어 병합하지 않았습니다. 일반 CT 격자나 MPR 평면 배치에서 사용하세요.") };
    const anchor = cells.find(cell => cell.viewportId === anchorId);
    if (!SHOWS_IMAGE.includes(anchor.kind)) return { ok: false, reason: kinText("영상이 표시된 칸을 선택한 뒤 확대·병합하세요.") };
    const entries = cells.filter(cell => !found.group.includes(cell.viewportId)).map(cell => ({ cell, box: rect(cell.x, cell.y, cell.width, cell.height) }))
      .concat([{ cell: anchor, box: copy(found.area) }]).sort((a, b) => byPlace(a.box, b.box));
    return { ok: true, op: 'maximize', rows, cols, anchorId, merged: entries.findIndex(entry => entry.cell === anchor),
      layoutOptions: entries.map(entry => entry.box), slots: entries.map(entry => entry.cell), area: copy(found.area),
      displaced: found.group.filter(id => id !== anchorId) };
  }

  function plan(request) {
    const found = request?.op === 'maximize' ? monitorArea(request) : null;
    if (found?.reason) return { ok: false, reason: found.reason };
    if (found) return planArea(request, found);
    const { rows, cols, cells, anchorId, op } = request || {};
    if (!BASES.some(([r, c]) => r === rows && c === cols) || !Array.isArray(cells) || cells.length !== rows * cols)
      return { ok: false, reason: kinText("1·2·4화면의 일반 CT 격자 또는 3평면 MPR 배치에서만 칸을 확대·병합할 수 있습니다.") };
    for (let index = 0; index < cells.length; index++) {
      const cell = cells[index];
      if (!cell || typeof cell.viewportId !== 'string' || !cell.viewportId) return { ok: false, reason: kinText("화면 구성을 확인할 수 없습니다.") };
      if (!near(cell.x, (index % cols) / cols) || !near(cell.y, Math.floor(index / cols) / rows) ||
          !near(cell.width, 1 / cols) || !near(cell.height, 1 / rows))
        return { ok: false, reason: kinText("이미 병합되었거나 특수한 배치입니다. 먼저 Restore Grid로 격자를 되돌리세요.") };
      if (!['stack', 'empty', 'plane'].includes(cell.kind))
        return { ok: false, reason: kinText("3D·SR·PDF 화면이나 아직 불러오지 못한 칸이 있어 병합하지 않았습니다. 일반 CT 격자나 MPR 평면 배치에서 사용하세요.") };
    }
    if (new Set(cells.map(cell => cell.viewportId)).size !== cells.length) return { ok: false, reason: kinText("화면 구성을 확인할 수 없습니다.") };
    const anchorIndex = cells.findIndex(cell => cell.viewportId === anchorId);
    if (anchorIndex < 0) return { ok: false, reason: kinText("확대할 칸을 먼저 선택하세요.") };
    if (!['maximize', 'merge-column', 'merge-row'].includes(op)) return { ok: false, reason: kinText("지원하지 않는 병합입니다.") };
    if (op !== 'maximize' && (rows !== 2 || cols !== 2)) return { ok: false, reason: kinText("열·행 병합은 2×2 배치에서만 사용할 수 있습니다.") };
    // Maximize rebuilds each cell from its own recorded kind, so a grid holding both stacks
    // and planes is no harder than either alone. A row or column merge leaves several cells
    // of possibly different kinds side by side in new rectangles, which is a second shape of
    // the feature rather than the same one, so it keeps the narrower boundary.
    if (op !== 'maximize' && new Set(cells.filter(cell => cell.kind !== 'empty').map(cell => cell.kind)).size > 1)
      return { ok: false, reason: kinText("MPR 평면과 일반 CT가 섞인 배치에서는 칸 확대만 사용할 수 있습니다.") };
    const column = anchorIndex % cols, row = Math.floor(anchorIndex / cols);
    const block = op === 'maximize' ? cells.slice()
      : cells.filter((_, index) => (op === 'merge-column' ? index % cols === column : Math.floor(index / cols) === row));
    // Only the cell that survives the merge has to carry an image; an empty cell in the
    // block is recorded as empty and comes back empty, which loses nothing.
    if (!SHOWS_IMAGE.includes(cells[anchorIndex].kind))
      return { ok: false, reason: kinText("영상이 표시된 칸을 선택한 뒤 확대·병합하세요.") };
    const { options, merged } = shape(op, op === 'maximize' ? 0 : op === 'merge-column' ? column : row);
    const survivors = cells.filter(cell => !block.includes(cell));
    if (survivors.length !== options.length - 1) return { ok: false, reason: kinText("화면 구성을 확인할 수 없습니다.") };
    const slots = [];
    for (let index = 0, next = 0; index < options.length; index++)
      slots.push(index === merged ? cells[anchorIndex] : survivors[next++]);
    return { ok: true, op, rows, cols, anchorId, merged, layoutOptions: options.map(copy), slots,
      displaced: block.filter(cell => cell.viewportId !== anchorId).map(cell => cell.viewportId) };
  }

  const sameCameraKeys = (a, b, keys) => !!a && !!b && keys.every(key => Array.isArray(a[key])
    ? Array.isArray(b[key]) && a[key].length === b[key].length && a[key].every((value, index) => Math.abs(value - b[key][index]) < 1e-6)
    : typeof a[key] === 'number' ? Math.abs(a[key] - b[key]) < 1e-6 : a[key] === b[key]);
  const sameCamera = (a, b) => sameCameraKeys(a, b, CAMERA_KEYS);
  // A camera is not one decision. Scrolling a stack moves focalPoint and position along
  // the normal, so comparing the camera whole would read every slice change as a zoom the
  // user made and hand back the merge's own refit with it. Zoom, where the camera sits and
  // how it is oriented are judged separately; the last group is the remainder by
  // construction, so every key stays covered exactly once.
  const CAMERA_ZOOM = ['parallelScale'], CAMERA_PLACE = ['focalPoint', 'position'];
  const CAMERA_GROUPS = [CAMERA_ZOOM, CAMERA_PLACE,
    CAMERA_KEYS.filter(key => !CAMERA_ZOOM.includes(key) && !CAMERA_PLACE.includes(key))];

  function create(services, options = {}) {
    const doc = options.doc || root.document, win = options.root || doc?.defaultView || root;
    const grid = services?.viewportGridService, cornerstone = services?.cornerstoneViewportService, sets = services?.displaySetService;
    const live = () => !ended && options.live?.() !== false;
    let ended = false, busy = false, quarantined = false, record = null, panel = null, status = null, hint = null;
    // One double click that arrived while an operation was still settling (onDoubleClick).
    let pendingToggle = false;
    const subscriptions = []; let listening = false, channel = null, workspace = null;

    const ordered = () => [...(grid?.getState?.().viewports?.values?.() || [])]
      .sort((a, b) => (a.y ?? 0) - (b.y ?? 0) || (a.x ?? 0) - (b.x ?? 0) || String(a.viewportId).localeCompare(String(b.viewportId)));
    const viewportOf = id => { try { return cornerstone?.getCornerstoneViewport?.(id) || null; } catch (_) { return null; } };
    function note(message) { if (status && message) status.textContent = message; return message; }

    function cameraOf(viewport) {
      try {
        const camera = viewport?.getCamera?.(); if (!camera) return null; const value = {};
        for (const key of CAMERA_KEYS) {
          const part = camera[key];
          if (key === 'parallelScale') { if (!Number.isFinite(part)) return null; value[key] = part; continue; }
          if (key === 'flipHorizontal' || key === 'flipVertical') { value[key] = !!part; continue; }
          if (!Array.isArray(part) || part.length !== 3 || !part.every(Number.isFinite)) return null;
          value[key] = [...part];
        }
        return value;
      } catch (_) { return null; }
    }

    // The native namespace, which carries the volume cache and the instance metadata. The
    // service is bound to `cornerstone` above, so the global is reached deliberately.
    const nativeCornerstone = () => win?.cornerstone || root.cornerstone || null;
    const volumeOf = viewport => { try { return nativeCornerstone()?.cache?.getVolume?.(viewport?.getVolumeId?.()) || null; } catch (_) { return null; } };

    // Everything a plane cell is, read through the same native volume APIs the saved MPR Job
    // and the Hanging Protocol already read (viewer-volume-job.js:13-19,53-63 and
    // viewer-hanging-protocol.js:270-291). Identity is the loaded volume and its full SOP
    // list, never the viewport, so a rebuilt plane can be proven to stand on the same
    // originals. Anything that cannot be established returns null, which becomes an unknown
    // kind and refuses the whole operation before a single rectangle is dispatched.
    function planeOf(base, view, viewport, properties) {
      const native = nativeCornerstone(), camera = cameraOf(viewport);
      let actors = null; try { actors = viewport.getActors?.(); } catch (_) { return null; }
      if (!camera || !Array.isArray(actors) || actors.length !== 1) return null;
      const volumeId = viewport.getVolumeId?.(), volume = volumeOf(viewport), imageIds = volume?.imageIds;
      if (typeof volumeId !== 'string' || !volumeId || !volume?.loadStatus?.loaded || !Array.isArray(imageIds) ||
          imageIds.length < 2 || volume.framesLoaded !== imageIds.length) return null;
      const sops = imageIds.map(id => { try { return native?.metaData?.get?.('instance', id)?.SOPInstanceUID; } catch (_) { return null; } });
      if (!sops.every(value => typeof value === 'string' && value) || new Set(sops).size !== sops.length) return null;
      // The requested orientation is authoritative; a camera the Crosshairs tool has rotated
      // no longer names its own plane, so without a stored orientation only a camera still
      // exactly on an anatomical axis may name itself. Anything else is refused.
      const stored = view.viewportOptions?.orientation ?? viewport.options?.orientation;
      const orientation = ORIENTATIONS.includes(stored) ? stored
        : ORIENTATIONS.find(name => camera.viewPlaneNormal.every((value, index) =>
            Math.abs(Math.abs(value) - (index === PLANE_AXIS[name] ? 1 : 0)) < 1e-6)) || null;
      let blend = null, thickness = null;
      try { blend = actors[0]?.actor?.getMapper?.()?.getBlendMode?.(); thickness = viewport.getSlabThickness?.(); } catch (_) { return null; }
      if (!orientation || ![0, 1, 2, 3].includes(blend) || !Number.isFinite(thickness)) return null;
      return { ...base, kind: 'plane', camera, volumeId, sops, orientation, blend, thickness,
        voiRange: properties?.voiRange ? copy(properties.voiRange) : null, invert: properties?.invert ?? null,
        lutFunction: properties?.VOILUTFunction ?? null, interpolation: properties?.interpolationType ?? null };
    }

    // One cell as this module needs it. Anything it cannot read becomes an unknown
    // kind, which refuses the whole operation before anything is dispatched.
    function cellOf(view) {
      const ids = [...(view.displaySetInstanceUIDs || [])], viewport = viewportOf(view.viewportId);
      const base = { viewportId: view.viewportId, x: view.x, y: view.y, width: view.width, height: view.height, sets: ids,
        optionsId: view.viewportOptions?.id ?? null, toolGroupId: view.viewportOptions?.toolGroupId ?? null,
        camera: null, voiRange: null, invert: null, imageId: null, imageIndex: null,
        volumeId: null, sops: null, orientation: null, blend: null, thickness: null, lutFunction: null, interpolation: null };
      let imageId = null, imageIndex = null, properties = null;
      try {
        imageId = viewport?.getCurrentImageId?.() || null;
        imageIndex = viewport?.getCurrentImageIdIndex?.() ?? null;
        properties = viewport?.getProperties?.() || null;
      } catch (_) { return { ...base, kind: 'unreadable' }; }
      const known = ids.length === 1 && !!sets?.getDisplaySetByUID?.(ids[0]);
      // A plane is judged before the empty test: an orthographic viewport standing on nothing
      // is a plane this module could not read, not a vacancy it may rebuild as a stack cell.
      if (viewport?.type === 'orthographic')
        return (known && properties && planeOf(base, view, viewport, properties)) || { ...base, kind: 'unreadable' };
      if (!ids.length && !imageId) return { ...base, kind: 'empty' };
      const camera = cameraOf(viewport);
      if (!known || viewport?.type !== 'stack' || !imageId || !camera) return { ...base, kind: 'unreadable' };
      return { ...base, kind: 'stack', camera, voiRange: properties?.voiRange ? copy(properties.voiRange) : null,
        invert: properties?.invert ?? null, imageId, imageIndex };
    }

    // A screen whose cells no longer fill their grid uniformly. Read-only: it is asked only
    // to tell the user why an operation was refused, never to decide one. With no `record`
    // this is a merged layout a saved Job restored, whose pre-merge grid was never saved.
    function mergedLayout() {
      const layout = grid?.getState?.()?.layout || {}, views = ordered();
      const rows = layout.numRows, cols = layout.numCols;
      if (!Number.isInteger(rows) || !Number.isInteger(cols) || !views.length) return false;
      return views.length !== rows * cols || views.some((view, index) =>
        !near(view.x, (index % cols) / cols) || !near(view.y, Math.floor(index / cols) / rows) ||
        !near(view.width, 1 / cols) || !near(view.height, 1 / rows));
    }
    // Restore Grid is disabled whenever there is no record, so pointing a user at it then
    // would be advice they cannot follow. The actual limit is stated instead.
    const NO_RECORD = kinText("저장된 병합 배치이거나 이 창에서 병합하지 않은 배치입니다. 병합 전 격자는 저장되지 않아 되돌릴 수 없으니 다른 배치를 적용하거나 저장된 배치 작업을 복원하세요.");
    const refusal = reason => !record && mergedLayout() ? NO_RECORD : reason;

    // Layout identity only: which sources sit in which rectangles. Scrolling, W/L and
    // the active cell are the user's own work and must not invalidate a merge record.
    function layoutSignature() {
      const state = grid?.getState?.(), layout = state?.layout || {};
      return JSON.stringify([layout.layoutType, layout.numRows, layout.numCols,
        ordered().map(view => [view.viewportId, view.x, view.y, view.width, view.height, [...(view.displaySetInstanceUIDs || [])]])]);
    }

    // Every reason the screen must not be rebuilt right now. All of them refuse before
    // any dispatch, so a refusal never changes what the user is looking at.
    function blocked() {
      if (!live()) return kinText("영상 세션이 변경되었습니다. 뷰어를 다시 여세요.");
      if (quarantined) return kinText("이전 배치 요청의 완료를 확인하지 못했습니다. 현재 영상을 확인하고 뷰어 창을 닫은 뒤 다시 열어 주세요.");
      if (busy) return kinText("이전 배치 요청이 끝난 뒤 다시 시도하세요.");
      try { if (doc.fullscreenElement) return kinText("전체 화면을 종료한 뒤 칸 배치를 바꾸세요."); } catch (_) { }
      try { if (doc.querySelector?.('dialog[open],[role="dialog"][aria-modal="true"],.modal.show')) return kinText("열린 대화상자를 닫은 뒤 다시 시도하세요."); } catch (_) { }
      try {
        const cines = services?.cineService?.getState?.()?.cines || {};
        if (Object.values(cines).some(value => value?.isPlaying)) return kinText("Cine 재생을 멈춘 뒤 칸 배치를 바꾸세요.");
      } catch (_) { return kinText("영상 재생 상태를 확인할 수 없습니다."); }
      // Only work that is in flight blocks a merge. An unsaved measurement does NOT:
      // merge changes geometry, never removes an annotation and never replaces a source,
      // and reading with a drawn measurement on screen is exactly when a clinician
      // enlarges a cell. Hanging Protocol Apply keeps its stricter guard because it
      // replaces the sources themselves.
      for (const name of ['kinViewerJobWorkspaceState', 'kinViewerHistoryWorkspaceState']) {
        try {
          const value = typeof win[name] === 'function' ? win[name]() : null;
          if (value?.busy) return kinText("저장 또는 영상 작업이 끝난 뒤 다시 시도하세요.");
        } catch (_) { return kinText("영상 작업 상태를 확인할 수 없습니다."); }
      }
      return null;
    }

    function snapshot() {
      const state = grid?.getState?.(), layout = state?.layout || {}, views = ordered();
      const rows = layout.numRows, cols = layout.numCols;
      if (layout.layoutType !== 'grid' || !Number.isInteger(rows) || !Number.isInteger(cols)) return null;
      // A split a Hanging Protocol or a saved Job registered (window.kinViewerSplitRects) has its own rectangles, which
      // the restore asks for again; any other grid is the uniform one of its rows and columns.
      const split = !uniformGrid(rows, cols, views) && registeredSplit(rows, cols, views, splitRects()) ? views.map(view => rect(view.x, view.y, view.width, view.height)) : null;
      if (!split && views.length !== rows * cols) return null;
      return { rows, cols, active: state.activeViewportId, cells: views.map(cellOf), signature: layoutSignature(), options: split };
    }
    function splitRects() { try { return Array.isArray(win.kinViewerSplitRects) ? copy(win.kinViewerSplitRects) : null; } catch (_) { return null; } }
    // Where the displays meet inside the grid (fractions of its width), from the monitors module, which reads only access
    // the reader already gave: [] is one display under the grid. No answer within 1 s, or a failure, is null (unknown).
    function displayEdges() {
      return new Promise(resolve => {
        const timer = win.setTimeout(() => resolve(null), 1000);
        const done = value => { win.clearTimeout(timer); resolve(Array.isArray(value) ? value : null); };
        try { Promise.resolve(win.kinViewerMonitorEdges()).then(done, () => done(null)); } catch (_) { done(null); }
      });
    }

    // One cell stays one viewport, rebuilt as the kind it was. The plane branch is the
    // combination the Hanging Protocol and the saved MPR Job already use
    // (viewer-hanging-protocol.js:97-101): the native position cache keys on
    // viewportOptions.id, so the recorded id is kept rather than a fresh one - here the
    // cached presentation is the screen the user is owed, not a stale oblique to avoid.
    const requestFor = cell => cell.kind === 'plane'
      ? { displaySetInstanceUIDs: [...cell.sets], displaySetOptions: [{}],
          viewportOptions: { id: cell.optionsId || cell.viewportId, viewportId: cell.viewportId, viewportType: 'volume',
            toolGroupId: cell.toolGroupId || 'mpr', orientation: cell.orientation, allowUnmatchedView: true } }
      : { displaySetInstanceUIDs: [...cell.sets], displaySetOptions: [{}],
          viewportOptions: { viewportId: cell.viewportId, ...(cell.optionsId ? { id: cell.optionsId } : {}),
            viewportType: 'stack', toolGroupId: cell.toolGroupId || 'default', allowUnmatchedView: true } };

    function boundedNative(promise, timeout) {
      const task = Promise.resolve(promise); task.catch(() => { });
      return new Promise((resolve, reject) => {
        let settled = false, timer = null;
        const finish = (fn, value) => { if (settled) return; settled = true; if (timer !== null) win.clearTimeout(timer); fn(value); };
        task.then(value => finish(resolve, value), error => finish(reject, error));
        if (timeout > 0 && !settled) timer = win.setTimeout(() => finish(reject, Error('Native layout timeout')), timeout);
      });
    }
    const pause = () => new Promise(resolve => win.setTimeout(resolve, 25));

    // The achieved geometry, not the resolved promise, decides success.
    function geometryIs(expected) {
      const state = grid?.getState?.(), layout = state?.layout || {}, views = ordered();
      const wanted = expected.cells.slice().sort((a, b) => a.y - b.y || a.x - b.x || String(a.viewportId).localeCompare(String(b.viewportId)));
      return layout.numRows === expected.rows && layout.numCols === expected.cols && views.length === wanted.length &&
        views.every((view, index) => view.viewportId === wanted[index].viewportId &&
          JSON.stringify([...(view.displaySetInstanceUIDs || [])]) === JSON.stringify(wanted[index].sets) &&
          near(view.x, wanted[index].x) && near(view.y, wanted[index].y) &&
          near(view.width, wanted[index].width) && near(view.height, wanted[index].height));
    }

    // A rebuilt grid is only a restoration when every expected source is back with the
    // image, window and camera it is owed. Cells that stayed on screen are owed their
    // newest state, cells this module removed are owed the recorded one.
    // A plane also owes its originals: the same loaded volume, the same full SOP list and the
    // same anatomical plane. A rebuilt plane that quietly fell back to another series or to
    // another orientation is not the cell that was taken away, whatever its camera says. A
    // stack cell has its source asserted by the geometry, which carries the display set.
    const sameSource = (now, cell) => cell.kind !== 'plane' || (now.volumeId === cell.volumeId && now.orientation === cell.orientation && JSON.stringify(now.sops) === JSON.stringify(cell.sops));

    function restored(target) {
      if (!geometryIs(target)) return false;
      const present = new Map(ordered().map(view => [view.viewportId, cellOf(view)]));
      return target.cells.every(cell => {
        if (cell.kind === 'empty') return true;
        const now = present.get(cell.viewportId);
        return !!now && now.kind === cell.kind && sameSource(now, cell) && sameState(now, cell);
      });
    }

    // Native restores camera and W/L from its own presentation cache; where it did not,
    // the owed values are put back explicitly instead of being reported as restored.
    function putCamera(viewport, wanted) {
      if (!wanted || sameCamera(cameraOf(viewport), wanted)) return;
      const camera = copy(wanted);
      viewport.setCamera?.({ flipHorizontal: camera.flipHorizontal, flipVertical: camera.flipVertical });
      delete camera.flipHorizontal; delete camera.flipVertical;
      viewport.setCamera?.(camera);
    }

    // Average projection is the one mode that cannot be put back by the setter alone: the
    // pinned streaming texture omits vtk's range metadata, so the shader leaves its scalar
    // range at zero and paints a black CT unless the native preparation that
    // viewer-tech-note.js:190 owns runs first. The saved MPR Job refuses outright for the
    // same reason (viewer-volume-job.js:128). This module never reimplements the
    // preparation: it calls it, and where it cannot, the mode is left alone.
    const averageReady = () => typeof win.kinPrepareVolumeAverage === 'function';
    const AVERAGE_MISSING = kinText("평균 투영 도구 로딩을 마친 뒤 다시 시도하세요.");

    // A plane takes its window, its projection mode and its slab back through the native
    // volume setters the saved MPR Job also uses (viewer-volume-job.js:127-131), in that
    // order: the mode and the thickness must be in place before the camera is assigned.
    function reapplyPlane(cell, viewport) {
      const properties = viewport.getProperties?.() || {}, wanted = {};
      if (cell.voiRange && JSON.stringify(properties.voiRange ?? null) !== JSON.stringify(cell.voiRange)) wanted.voiRange = copy(cell.voiRange);
      if (cell.lutFunction !== null && (properties.VOILUTFunction ?? null) !== cell.lutFunction) wanted.VOILUTFunction = cell.lutFunction;
      if (cell.invert !== null && (properties.invert ?? null) !== cell.invert) wanted.invert = cell.invert;
      if (cell.interpolation !== null && (properties.interpolationType ?? null) !== cell.interpolation) wanted.interpolationType = cell.interpolation;
      if (Object.keys(wanted).length) viewport.setProperties?.(wanted);
      let blend = null; try { blend = viewport.getActors?.()[0]?.actor?.getMapper?.()?.getBlendMode?.(); } catch (_) { }
      if (blend !== cell.blend) {
        const volume = volumeOf(viewport);
        // Average is set only once its preparation has actually run. A missing tool, a
        // volume that cannot be read, or a preparation that refuses the pixel range
        // (viewer-tech-note.js:195,200 throw by name) leaves the mode exactly as native
        // rebuilt it: `restored()` compares blend, so the plane is reported as not back
        // instead of a black CT being claimed as the screen the user left. The catch is
        // this one call and this one consequence, not a blanket swallow.
        let ready = cell.blend !== 3;
        if (!ready && averageReady() && volume) {
          try { win.kinPrepareVolumeAverage(viewport, volume); ready = true; } catch (_) { ready = false; }
        }
        if (ready) viewport.setBlendMode?.(cell.blend);
      }
      if (!near(viewport.getSlabThickness?.(), cell.thickness)) viewport.setSlabThickness?.(cell.thickness);
      putCamera(viewport, cell.camera);
    }

    function reapply(target) {
      for (const cell of target.cells) {
        const viewport = viewportOf(cell.viewportId);
        if (cell.kind === 'empty' || !viewport) continue;
        try {
          if (cell.kind === 'plane') {
            if (viewport.type !== 'orthographic') continue;
            reapplyPlane(cell, viewport);
          } else {
            if (viewport.type !== 'stack') continue;
            if (Number.isInteger(cell.imageIndex) && typeof viewport.setImageIdIndex === 'function') {
              // A restored frame also owns the next scroll, including a no-op load.
              clearTimeout(viewport.debouncedTimeout);
              viewport.targetImageIdIndex = cell.imageIndex;
              if (viewport.getCurrentImageId?.() !== cell.imageId)
                Promise.resolve(viewport.setImageIdIndex(cell.imageIndex)).catch(() => { });
            }
            const properties = viewport.getProperties?.() || {};
            if (cell.voiRange && JSON.stringify(properties.voiRange ?? null) !== JSON.stringify(cell.voiRange))
              viewport.setVOI?.(copy(cell.voiRange), { forceRecreateLUTFunction: true, voiUpdatedWithSetProperties: true });
            if (cell.invert !== null && (properties.invert ?? null) !== cell.invert) viewport.setProperties?.({ invert: cell.invert });
            putCamera(viewport, cell.camera);
          }
          viewport.render?.();
        } catch (_) { }
      }
    }

    // A base grid back: a uniform grid by its rows and columns, a registered split by its own rectangles.
    const dispatchBack = target => dispatch(target.rows, target.cols, target.options || null, target.cells, target.active);
    const dispatch = (rows, cols, layoutOptions, cells, active) => grid.setLayout({
      numRows: rows, numCols: cols, activeViewportId: active, isHangingProtocolLayout: false,
      ...(layoutOptions ? { layoutOptions: layoutOptions.map(copy) } : {}),
      findOrCreateViewport: index => requestFor(cells[index]) });

    async function settle(check, deadline) {
      for (let count = 0; count < 120 && Date.now() < deadline; count++) { if (check()) return true; await pause(); }
      return check();
    }

    // Every field this module records and can put back, compared the way it is stored. The
    // plane-only fields are null on a stack cell, so one comparison covers both kinds and no
    // field is silently left out of the settling test or the restore oracle.
    const samePlain = (a, b) => (a ?? null) === (b ?? null);
    const sameNumber = (a, b) => typeof a === 'number' && typeof b === 'number' ? near(a, b) : samePlain(a, b);
    const sameState = (a, b) => !!a && !!b && sameCamera(a.camera, b.camera) && a.imageId === b.imageId &&
      JSON.stringify(a.voiRange ?? null) === JSON.stringify(b.voiRange ?? null) && samePlain(a.invert, b.invert) &&
      samePlain(a.lutFunction, b.lutFunction) && samePlain(a.interpolation, b.interpolation) &&
      samePlain(a.blend, b.blend) && sameNumber(a.thickness, b.thickness);

    // The native viewport refits its camera when a pane changes shape, on its own resize
    // observer, and that refit is not reversible by resizing back. Nothing may be recorded
    // or re-applied before it has settled, so this waits for two identical readings and
    // never accepts the first ones.
    async function settledState(minimum = 4) {
      let previous = null;
      for (let count = 0; count < 32; count++) {
        const current = new Map(ordered().map(view => [view.viewportId, cellOf(view)]));
        if (count >= minimum && previous && previous.size === current.size &&
            [...current].every(([id, cell]) => !SHOWS_IMAGE.includes(cell.kind) || sameState(cell, previous.get(id)))) return current;
        previous = current;
        await pause();
      }
      return previous;
    }

    // What unmerge owes each recorded cell, decided one field at a time against `after`,
    // the reading taken once the merge had settled. A field that still holds what the
    // merge itself produced - including the native refit - is owed the pre-merge value;
    // only a field the user has actually moved since then keeps its newest value. Judging
    // the four fields as one unit would let a single scroll hand the whole cell its refit
    // camera back as if the user had zoomed. A cell this module removed, one whose source
    // changed, or one with no trustworthy post-merge reading is owed the record whole,
    // because nothing about it can be attributed to the user.
    function unmergeTarget(base, after, input) {
      const present = new Map(ordered().map(view => [view.viewportId, cellOf(view)]));
      const sameVoi = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
      const touched = input?.touched || null, interacted = !!input?.interacted;
      let ambiguous = false;
      const cells = base.cells.map(cell => {
        const current = present.get(cell.viewportId), merged = after?.get(cell.viewportId);
        if (!current || !SHOWS_IMAGE.includes(cell.kind) || current.kind !== cell.kind || JSON.stringify(current.sets) !== JSON.stringify(cell.sets)) return cell;
        // A plane whose volume or anatomical plane is no longer the recorded one is not the
        // cell these per-field decisions describe; it is owed the record whole.
        if (!sameSource(current, cell)) return cell;
        if (!merged || merged.kind !== cell.kind) return cell;
        const atInput = touched?.get(cell.viewportId);
        const placed = !interacted || (!!atInput && atInput.kind === cell.kind);
        // The only change this module makes to a cell of its own accord after the dispatch
        // is the native refit, and native refits a pane only where its rectangle changed
        // shape. Both rectangles are known here - the pre-merge one from the record, the
        // merged one from the settled reading - so a cell that kept its shape cannot have
        // been refitted at all and every change on it is somebody else's doing.
        const aspect = box => (box && box.width > 0 && box.height > 0 ? box.width / box.height : null);
        const shapeBefore = aspect(cell), shapeMerged = aspect(merged);
        const refitable = shapeBefore === null || shapeMerged === null || !near(shapeBefore, shapeMerged);
        // One field, decided on evidence. A value the user moved after the merge settled is
        // theirs. A value that is identical in the settled reading but was different at the
        // instant their input arrived was changed by that input and is theirs as well, so
        // `after` never folds their edit into this module's own baseline. Only a value with
        // no user input behind it is owed the pre-merge record. Where an input happened but
        // could not be placed on the screen, the newer value is kept and the restore says so:
        // an unattributable value is never silently reverted.
        // `held` is the one case where that second reading proves nothing: the field still
        // held the recorded value when the input arrived, and this module's own refit was
        // still to come, so the move to the settled value could be the user's gesture or
        // that refit and nothing here separates them. The newer value is still kept - their
        // work is never reverted on a guess - but the restore no longer claims the image
        // state came back.
        const decide = (untouched, steady, recorded, actual, unchanged, held) => {
          if (!untouched) return actual;
          if (steady === false) { if (held) ambiguous = true; return actual; }
          if (placed || unchanged) return recorded;
          ambiguous = true; return actual;
        };
        // One recorded field, run through the same evidence. A native refit touches none of
        // these - it changes the zoom of a reshaped pane and nothing else - so `held` is
        // false for all of them and only the camera group below can be ambiguous this way.
        const field = (key, equal = samePlain) => decide(equal(current[key], merged[key]),
          atInput ? equal(atInput[key], merged[key]) : null, cell[key], current[key], equal(current[key], cell[key]));
        // imageId and imageIndex are one decision: an index without the image it belongs
        // to would scroll the cell to a slice the user never asked for. A plane carries
        // neither - where its slice sits is its camera - so this decides nothing there.
        const scrolled = current.imageId !== merged.imageId;
        const image = decide(!scrolled, atInput ? atInput.imageId === merged.imageId : null,
          cell, current, current.imageId === cell.imageId);
        const camera = {};
        for (const keys of CAMERA_GROUPS) {
          // Only the zoom group is refittable: the native refit of a reshaped pane changes
          // parallelScale and leaves where the camera sits and how it is oriented alone, so
          // a scroll, a pan or a flip that followed the input is the user's beyond doubt.
          // The image, the window and invert are no part of a refit either and pass nothing.
          const owed = decide(sameCameraKeys(current.camera, merged.camera, keys),
            atInput?.camera ? sameCameraKeys(atInput.camera, merged.camera, keys) : null,
            cell.camera, current.camera, sameCameraKeys(current.camera, cell.camera, keys),
            keys === CAMERA_ZOOM && refitable && !!atInput?.camera && sameCameraKeys(atInput.camera, cell.camera, keys));
          for (const key of keys) camera[key] = owed[key];
        }
        return { ...cell, camera, voiRange: field('voiRange', sameVoi), invert: field('invert'),
          lutFunction: field('lutFunction'), interpolation: field('interpolation'),
          blend: field('blend'), thickness: field('thickness', sameNumber),
          imageId: image.imageId, imageIndex: image.imageIndex };
      });
      return { rows: base.rows, cols: base.cols, active: base.active, cells, ambiguous, options: base.options || null };
    }

    // A screen this module is still allowed to rebuild. Its own dispatch can only ever
    // leave the viewports and the sources it started from, inside the grid it started from;
    // which rectangles native chose, and how many of the cells it kept, is native's answer
    // and may deviate - that deviation is this module's own doing and is rolled back.
    // A viewport or a source that was never in the record belongs to another operation -
    // a Hanging Protocol Apply or a Load Job that landed while this merge was settling -
    // whose provenance cannot be established from here, so it is never rebuilt over.
    function ours(base) {
      const layout = grid?.getState?.()?.layout || {}, views = ordered();
      if (layout.numRows !== base.rows || layout.numCols !== base.cols) return false;
      if (!views.length || views.length > base.cells.length) return false;
      const known = new Map(base.cells.map(cell => [cell.viewportId, JSON.stringify(cell.sets)]));
      return views.every(view => {
        const sets = [...(view.displaySetInstanceUIDs || [])], recorded = known.get(view.viewportId);
        // A cell that is momentarily carrying nothing is native still building this module's
        // own request; an unknown viewport, or a source that was never in the record, is not.
        return recorded !== undefined && (!sets.length || recorded === JSON.stringify(sets));
      });
    }

    // Rollback runs only while this module still owns the screen: a user who already
    // moved on, or another panel that has put its own work there, must never have it
    // overwritten by our restore.
    async function rebuild(target, owned) {
      if (!owned()) return false;
      try { await boundedNative(dispatchBack(target), 2000); } catch (_) { }
      const deadline = Date.now() + 5000;
      let confirmed = 0;
      while (Date.now() < deadline) {
        if (!owned()) return false;
        if (!geometryIs(target)) { confirmed = 0; await pause(); continue; }
        // Re-applying into an ongoing native refit only loses the value again, and a late
        // refit could undo an accepted restore, so each decision is taken on a settled
        // screen and the restore must hold twice.
        await settledState();
        if (!owned()) return false;
        if (restored(target)) { if (++confirmed >= 2) return true; }
        else { confirmed = 0; reapply(target); }
      }
      return false;
    }

    function quarantine(message) {
      quarantined = true; record = null; refresh();
      return note(message || kinText("배치 요청 또는 복원 완료를 확인하지 못했습니다. 현재 영상을 확인하고 뷰어 창을 닫은 뒤 다시 열어 주세요."));
    }
    const FOREIGN = kinText("병합을 확인하는 동안 다른 기능이 화면을 바꾸어, 이전 배치로 되돌리지 않고 지금 화면을 그대로 두었습니다. 화면을 확인한 뒤 뷰어 창을 닫고 다시 열어 주세요.");

    // `capture` reads the screen at the instant the first input arrives, in the capture
    // phase, before any tool has acted on it. A value that is identical in that reading and
    // in the settled one cannot be that input's work, which is how a user edit made inside
    // the settling wait is told apart from the merge's own refit later on.
    function watchInteraction(capture) {
      let interacted = false, armed = false, touched = null;
      const handler = () => {
        if (!armed || interacted) return;
        interacted = true;
        if (capture) try { touched = new Map(ordered().map(view => [view.viewportId, cellOf(view)])); } catch (_) { touched = null; }
      };
      for (const type of ['pointerdown', 'wheel', 'keydown']) doc.addEventListener(type, handler, true);
      queueMicrotask(() => { armed = true; });
      return { owned: () => !interacted && !ended && live(), input: () => ({ interacted, touched }),
        release: () => { for (const type of ['pointerdown', 'wheel', 'keydown']) doc.removeEventListener(type, handler, true); } };
    }

    const hasPlane = cells => cells.some(cell => cell.kind === 'plane');

    // The MPR tool group's Crosshairs resets the camera of every linked plane whenever native
    // recreates one of them, which would hand back three refitted planes instead of the screen
    // the user left. The saved MPR Job holds the same callback for the same reason
    // (viewer-volume-job.js:82-88); it is not exported, so the hold is taken here. It is taken
    // for one operation, only when a plane is involved, and released in that operation's
    // `finally`, so no failure can leave the native callback replaced.
    function holdCrosshairReset(needed) {
      const idle = { center() { }, release() { } };
      if (!needed) return idle;
      let group = null, tool = null;
      try {
        group = (win?.cornerstoneTools || root.cornerstoneTools)?.ToolGroupManager?.getToolGroup?.('mpr');
        tool = group?.getToolInstance?.('Crosshairs');
      } catch (_) { return idle; }
      if (!tool || typeof tool.onResetCamera !== 'function') return idle;
      const original = tool.onResetCamera; let held = true;
      const guarded = function (...args) { if (!held) return original.apply(this, args); };
      tool.onResetCamera = guarded;
      // The end of this viewer's session cancels every timer and frame an operation may be
      // parked on, so its `finally` never runs then: the same release is also the session
      // end's own (once; withdrawn by a normal release). The operation itself is not resumed.
      let withdraw = null;
      const release = () => {
        held = false; const hook = withdraw; withdraw = null; hook?.();
        if (tool.onResetCamera === guarded) tool.onResetCamera = original;
      };
      try { withdraw = (win?.KinViewerSessionBoundary || root.KinViewerSessionBoundary)?.onEnd?.(release) ?? null; } catch (_) { withdraw = null; }
      return {
        // Once the cameras are confirmed, the crosshair widget is placed on them. Its centre
        // is derived from those cameras, so it lands on the position the user last set rather
        // than on a reset one; this is the only crosshair write this module makes.
        center() { try { if (group.getToolOptions?.('Crosshairs')?.mode !== 'Disabled') tool.computeToolCenter?.(); } catch (_) { } },
        release,
      };
    }

    // MPR 3D marks are keyed by their volume reference, not by a viewport
    // (viewer-volume-marks.js:9,12,35), so a rebuilt plane keeps them and this module never
    // writes them. It takes the panel's own read-only capture on both sides of the operation
    // - the same read that panel performs on its refresh timer - and compares the two:
    // `undefined` means the panel would not answer, and a fingerprint that moved is reported
    // as unconfirmed instead of being passed off as a fully restored screen.
    function marksFingerprint(needed) {
      if (!needed) return null;
      try { const value = win.kinMprMarks?.capture?.(true); return value ? JSON.stringify(value) : null; } catch (_) { return undefined; }
    }

    // A screen with an Average plane that cannot be rebuilt here: refused before anything is dispatched (run), and so never
    // taken from the stock one-up either (weighDoubleClick).
    const averageMissing = base => base.cells.some(cell => cell.kind === 'plane' && cell.blend === 3) && !averageReady();

    async function run(op, anchorId, known = null) {
      const reason = blocked(); if (reason) return { ok: false, message: note(reason) };
      // The display edges are asked before the screen is read; meanwhile this operation is busy, so a second double
      // click is remembered as usual (onDoubleClick) and a button press is refused. A double click this panel took from the
      // stock one-up (weighDoubleClick) brings the edges it was decided on.
      let edges = Array.isArray(known) ? known : null;
      if (op === 'maximize' && !edges && typeof win.kinViewerMonitorEdges === 'function') {
        const asked = layoutSignature();
        busy = true; refresh();
        try { edges = await displayEdges(); } finally { busy = false; refresh(); }
        // Unknown displays are not taken as one: the maximize could reach over a display edge.
        const later = ended || !live() ? '' : blocked() ?? (layoutSignature() !== asked ? kinText("모니터를 확인하는 사이 화면이 바뀌어 칸을 확대하지 않았습니다.")
          : edges === null ? kinText("모니터 정보를 확인하지 못해 칸을 확대하지 않았습니다. 다시 더블클릭하세요.") : null);
        if (later !== null) { pendingToggle = false; return { ok: false, message: later && note(later) }; }
      }
      const base = snapshot();
      if (!base) return { ok: false, message: note(record
        ? kinText("이미 병합된 화면입니다. 먼저 Restore Grid로 격자를 되돌리세요.")
        : refusal(kinText("1·2·4화면의 일반 CT 격자 또는 3평면 MPR 배치에서만 칸을 확대·병합할 수 있습니다."))) };
      const anchor = anchorId || base.active;
      const result = plan({ rows: base.rows, cols: base.cols, cells: base.cells, anchorId: anchor, op, edges, split: base.options });
      // A registered split is no saved merged layout: its refusal is said as it is.
      if (!result.ok) return { ok: false, message: note(base.options ? result.reason : refusal(result.reason)) };
      // A merge destroys and rebuilds planes, and an Average plane can only be rebuilt with
      // the preparation above. Without that tool the operation is refused here - before a
      // single rectangle is dispatched - so the user keeps the screen they have instead of
      // being handed a restore that could not put the projection back.
      if (averageMissing(base)) return { ok: false, message: note(AVERAGE_MISSING) };
      const expected = { rows: base.rows, cols: base.cols,
        cells: result.slots.map((cell, index) => ({ viewportId: cell.viewportId, sets: cell.sets, ...result.layoutOptions[index] })) };
      let crosshair = null, watch = null, dispatched = false;
      const owned = () => !!watch && watch.owned() && ours(base);
      // The rollback is owed `base` itself, not a fresh reading of the screen: it runs only
      // while nothing else has touched the screen, so every difference on it - the refit
      // this failed merge caused above all - is self-inflicted and must not be adopted as
      // the state the user is owed. When the screen is no longer this module's, nothing is
      // dispatched at all: another panel's newer work is left exactly where it is.
      const rollback = async message => {
        if (!watch || !watch.owned()) return { ok: false, message: quarantine() };
        if (!ours(base)) return { ok: false, message: quarantine(FOREIGN) };
        return await rebuild(base, owned)
          ? { ok: false, message: note(message) }
          : { ok: false, message: quarantine() };
      };
      const planes = hasPlane(base.cells), marks = marksFingerprint(planes);
      // The hold on the native callback and the interaction listeners are acquired inside
      // the try, so the finally below is guaranteed to give both of them back: a failure
      // while the operation is being set up can no longer leave the MPR tool group's
      // camera reset replaced, or a capture-phase listener attached, for the session.
      try {
        crosshair = holdCrosshairReset(planes);
        watch = watchInteraction(true);
        busy = true; refresh(); note(kinText("칸 배치를 적용하는 중…"));
        const deadline = Date.now() + 4000;
        dispatched = true;
        try { await boundedNative(dispatch(base.rows, base.cols, result.layoutOptions, result.slots, anchor), 2000); } catch (_) { }
        const achieved = await settle(() => geometryIs(expected), deadline);
        if (ended || !live()) return { ok: false, message: '' };
        if (achieved) {
          const after = await settledState();
          if (ended || !live()) return { ok: false, message: '' };
          // Waiting for the screen to settle is time in which another panel - Hanging
          // Protocol Apply, Load Job - can land a layout of its own. The signature read
          // after that wait would then describe their screen, and Restore Grid would
          // later rebuild the pre-merge grid over their work and call it a restore. The
          // requested geometry is confirmed once more, on the same synchronous reading
          // the signature is taken from, so a record only ever describes this merge.
          if (geometryIs(expected)) {
            record = { base, op, anchorId: anchor, after, input: watch.input(), marks, planes, signature: layoutSignature(), area: result.area || null };
            crosshair.center();
            return { ok: true, op, ...(result.area ? { area: copy(result.area) } : {}), message: note(op === 'maximize'
              ? kinText("{t0}다시 더블클릭하거나 Restore Grid로 이전 배치로 돌아갑니다.", (result.area ? kinText("선택한 칸을 그 모니터의 한 화면으로 확대했습니다. 다른 모니터의 칸은 그대로입니다. ") : kinText("선택한 칸을 한 화면으로 확대했습니다. ")))
              : kinText("선택한 칸을 병합했습니다. Restore Grid로 이전 배치로 돌아가며, 이 병합 배치는 Save New Job으로 저장할 수 있습니다.")) };
          }
        }
        return await rollback(kinText("요청한 칸 배치를 확인하지 못해 이전 배치로 복구했습니다."));
      } catch (_) {
        // A failure before the dispatch left the screen untouched, so it is answered as a
        // refusal rather than rolled back over a screen nobody changed - and never thrown
        // out of the operation, which would leave the caller with no answer at all.
        if (!dispatched) return { ok: false, message: note(kinText("칸 배치를 시작하지 못했습니다. 잠시 후 다시 시도하세요.")) };
        return await rollback(kinText("칸 배치에 실패해 이전 배치로 복구했습니다."));
      } finally {
        crosshair?.release(); watch?.release(); busy = false; refresh();
        // The double click remembered while this operation settled is answered now, and
        // only by the restore the panel promises; a failed, ended or quarantined operation
        // left nothing to restore, so it is forgotten.
        const toggle = pendingToggle; pendingToggle = false;
        if (toggle && record && !ended && !quarantined) unmerge();
      }
    }

    async function unmerge() {
      const reason = blocked(); if (reason) return { ok: false, message: note(reason) };
      if (!record) return { ok: false, message: note(kinText("되돌릴 병합 기록이 없습니다.")) };
      if (layoutSignature() !== record.signature) {
        record = null; refresh();
        return { ok: false, message: note(kinText("화면 또는 원본이 변경되어 병합 기록을 지웠습니다. 현재 화면은 유지됩니다.")) };
      }
      const target = unmergeTarget(record.base, record.after, record.input);
      const before = record.marks, planes = !!record.planes;
      let crosshair = null, watch = null, started = false;
      // Same boundary as `run`: nothing is acquired outside the try, so the finally gives
      // the hold and the listeners back however this ends.
      try {
        crosshair = holdCrosshairReset(planes);
        watch = watchInteraction();
        busy = true; refresh(); note(kinText("이전 배치로 되돌리는 중…"));
        started = true;
        const back = await rebuild(target, () => watch.owned() && ours(target));
        if (ended || !live()) return { ok: false, message: '' };
        if (back) {
          record = null;
          crosshair.center();
          const after = marksFingerprint(planes);
          // What is actually known, said separately. An unattributable image state and an
          // unreadable mark state are two different gaps, and a restore that has neither
          // is the only one that claims the whole screen came back.
          const notes = [];
          if (target.ambiguous) notes.push(kinText("병합 중 조작한 영상 상태는 확인되지 않아 되돌리지 않고 그대로 두었습니다."));
          if (planes && (before === undefined || after === undefined || before !== after))
            notes.push(kinText("MPR 3D 표식 상태는 확인하지 못했습니다."));
          return { ok: true, message: note(notes.length
            ? kinText("이전 칸 배치로 되돌렸습니다. {0}", notes.join(' '))
            : kinText("이전 칸 배치와 영상 상태로 되돌렸습니다.")) };
        }
        return { ok: false, message: quarantine() };
      } catch (_) {
        // Nothing was rebuilt yet: the merged screen is still exactly what it was, so the
        // record is kept and the user is told to try again instead of a restore being
        // claimed or the merge record being dropped.
        if (!started) return { ok: false, message: note(kinText("되돌리기를 시작하지 못했습니다. 잠시 후 다시 시도하세요.")) };
        return { ok: false, message: quarantine() };
      } finally {
        crosshair?.release(); watch?.release(); busy = false; refresh();
        // A double click during a restore is not turned into a new maximize afterwards.
        pendingToggle = false;
      }
    }

    // A double click a native tool consumed never reaches document: the pinned
    // cornerstoneTools listeners call stopImmediatePropagation on the element for both
    // tool-handled and drag-ignored double clicks, so this handler cannot double-handle
    // a measurement gesture. Images Only blocks the same event for 400ms after exit.
    // The one image cell a double click was made on, or null: a plain double click of the primary button (the stock
    // viewer runs no command of its own for one with a modifier key) outside this panel and any dialog.
    function clickedCell(event) {
      if (event.button !== 0 || (event.detail || 0) < 2 || event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) return null;
      const target = event.target;
      if (!target || panel?.contains?.(target) || target.closest?.('#kin-viewer-layout,#kin-workspace-dock,dialog,[role="dialog"]')) return null;
      const matches = ordered().filter(view => {
        const element = viewportOf(view.viewportId)?.element;
        return element?.isConnected && element.contains(target);
      });
      return matches.length === 1 ? matches[0].viewportId : null;
    }
    function onDoubleClick(event) {
      // What was decided for this very click on its way down (weighDoubleClick), and for no other.
      const weighed = gesture?.event === event ? gesture : null;
      gesture = null;
      if (ended || event.defaultPrevented) return;
      const clicked = clickedCell(event);
      if (!clicked) return;
      // A second double click at reading speed can land while the maximize is still
      // settling. Dropping it left the native one-up acting alone on a merged screen, so it
      // is remembered - once: a third click is the same request, not another toggle - and
      // answered when the operation finishes.
      if (busy) { pendingToggle = true; return; }
      if (record) { unmerge(); return; }
      // The edges this double click was taken from the stock one-up on, or none.
      run('maximize', clicked, weighed?.taken ? weighed.edges : null);
    }

    function refresh() {
      if (!panel) return;
      const reason = ended ? kinText("세션이 종료되었습니다.") : quarantined ? kinText("뷰어 창을 다시 열어 주세요.") : busy ? kinText("요청 처리 중입니다.") : '';
      panel.querySelectorAll('button[data-cell-merge]').forEach(button => {
        const restore = button.dataset.cellMerge === 'restore';
        button.disabled = !!reason || (restore ? !record : !!record);
        button.title = reason || (restore ? kinText("병합 전 격자와 영상 상태로 되돌립니다.") : kinText("선택한 칸을 확대하거나 인접한 칸과 병합합니다."));
      });
      if (hint) hint.textContent = record?.area
        ? kinText("현재 그 모니터만 확대한 상태입니다. 다시 더블클릭하거나 Restore Grid로 이전 배치와 영상 상태로 돌아갑니다. 한 모니터만 확대한 배치는 Job으로 저장되지 않습니다.")
        : record
        ? kinText("현재 병합 상태입니다. Save New Job으로 이 배치를 저장할 수 있고, Restore Grid로 병합 전 배치와 영상 상태로 돌아갑니다.")
        : kinText("영상 칸을 더블클릭하면 그 칸이 한 화면이 되고, 다시 더블클릭하면 이전 배치로 돌아갑니다. 두 모니터에 걸친 창에서는 그 칸이 있는 모니터만 채웁니다.");
    }

    // Any layout or source change this module did not make invalidates the record, so a
    // stale record can never rebuild cells into a different screen.
    function observe() {
      if (ended || busy || !record) return;
      let current = null; try { current = layoutSignature(); } catch (_) { current = null; }
      if (current !== record.signature) {
        record = null; note(kinText("화면 또는 원본이 변경되어 병합 기록을 지웠습니다. 현재 화면은 유지됩니다.")); refresh();
      }
    }


    function stop() {
      if (ended) return; ended = true; record = null; pendingToggle = false;
      subscriptions.splice(0).forEach(item => item?.unsubscribe?.());
      doc.removeEventListener('dblclick', onDoubleClick); doc.removeEventListener('dblclick', weighDoubleClick, true); gesture = null;
      channel?.close(); channel = null;
      if (listening) {  win.removeEventListener?.('pagehide', stop); listening = false; }
      if (workspace && win.kinCellMergeWorkspaceState === workspace) delete win.kinCellMergeWorkspaceState;
      workspace = null;
      panel?.remove(); panel = status = hint = null;
    }

    function mount(host = options.host || doc?.querySelector?.('#kin-viewer-layout')) {
      if (ended || panel || !host) return false;
      panel = doc.createElement('section'); panel.id = 'kin-cell-merge';
      panel.style.cssText = 'border-top:1px solid #657c9f;margin-top:8px;padding-top:8px';
      panel.innerHTML = kinHtml("<strong>Cell Merge</strong><p>칸을 확대하거나 인접한 칸을 하나로 묶습니다. 일반 CT 칸과 MPR 평면 칸에서 쓸 수 있으며, 이 뷰어 격자만 바뀌고 브라우저 전체 화면(Images Only)과는 다릅니다.</p><div><button type=\"button\" data-cell-merge=\"maximize\">Maximize Cell</button> <button type=\"button\" data-cell-merge=\"merge-column\">Merge Column</button> <button type=\"button\" data-cell-merge=\"merge-row\">Merge Row</button> <button type=\"button\" data-cell-merge=\"restore\">Restore Grid</button></div><p data-cell-merge-hint></p><p role=\"status\"></p>");
      status = panel.querySelector('[role=status]'); hint = panel.querySelector('[data-cell-merge-hint]');
      host.append(panel);
      panel.querySelectorAll('button[data-cell-merge]').forEach(button => {
        button.style.cssText = 'margin:3px;padding:4px 7px;border:1px solid #657c9f;border-radius:4px';
        button.onclick = () => (button.dataset.cellMerge === 'restore' ? unmerge() : run(button.dataset.cellMerge));
      });
      for (const event of new Set(Object.values(grid?.EVENTS || {})))
        try { subscriptions.push(grid.subscribe(event, observe)); } catch (_) { }
      doc.addEventListener('dblclick', weighDoubleClick, true); doc.addEventListener('dblclick', onDoubleClick);
      // The record is the only way back to the pre-merge grid and it lives nowhere but here.
      // A saved Job restore rebuilds the screen on viewports this record never saw, so the
      // Jobs panel reads this before it touches the screen; it is read-only by construction.
      workspace = () => ({ merged: !!record, busy });
      win.kinCellMergeWorkspaceState = workspace;
      if (!listening) {
        listening = true;
         win.addEventListener?.('pagehide', stop);
        try { channel = window.kinViewerOnEnd(() => stop()); } catch (_) { }
      }
      refresh(); note(kinText("칸을 선택한 뒤 확대·병합하거나 영상 칸을 더블클릭하세요."));
      return true;
    }

    // A window over two monitors: the double click is this panel's monitor maximize (onDoubleClick), not the stock one-up,
    // which would first make one cell of the whole window - over the display edge - and change the grid while the maximize
    // reads the displays. One double click has one owner, decided once, for the cell that was really clicked: on the
    // click's way down (capture), before the stock one-up on the cell's element and this panel's own handler see it, from
    // the display edges last read (kinViewerMonitorEdgesNow). Taken when a display edge is inside the grid and, on this
    // screen as it is, the monitor maximize of that cell would be made (plan) - or that cell already is its monitor's one
    // screen: the two cells of two monitors stay two. Everything else - one display, unknown edges, a grid the monitor
    // maximize refuses (a 3D, SR or PDF cell, an Average plane that cannot be rebuilt, a cell over the edge) - keeps the
    // stock one-up as it was. What was decided holds for that click alone: it is dropped when the click is over, whether
    // or not it reached this panel (a measurement tool that used it, a shield over the cell), so no later click inherits
    // it, and a stock one-up asked for outside a double click (a key, a menu) is never taken.
    let gesture = null;
    function weighDoubleClick(event) {
      gesture = null;
      if (ended || !panel) return;
      const clicked = clickedCell(event);
      if (!clicked) return;
      const mine = gesture = { event, taken: false, edges: null };
      win.setTimeout(() => { if (gesture === mine) gesture = null; }, 0);
      if (busy || record || quarantined || blocked()) return;
      try {
        const edges = typeof win.kinViewerMonitorEdgesNow === 'function' ? win.kinViewerMonitorEdgesNow() : null;
        if (!Array.isArray(edges) || !edges.length) return;
        const base = snapshot();
        if (!base || averageMissing(base)) return;
        const result = plan({ rows: base.rows, cols: base.cols, cells: base.cells, anchorId: clicked, op: 'maximize', edges, split: base.options });
        const alone = !result.ok && result.reason === ALONE && base.cells.every(cell => ['stack', 'empty', 'plane'].includes(cell.kind));
        if (!(result.ok && result.area) && !alone) return;
        mine.edges = [...edges]; mine.taken = true;
      } catch (_) { }
    }
    const claimsDoubleClick = () => !!gesture?.taken;

    return { mount, stop, merge: run, unmerge, claimsDoubleClick,
      state: () => ({ merged: !!record, op: record?.op || null, busy, quarantined, ended }), refresh: observe };
  }

  const api = { create, plan, shape, sameCamera, BASES };
  if (typeof module === 'object' && module.exports) module.exports = api; else root.KinViewerCellMerge = api;
})(typeof globalThis === 'object' ? globalThis : this);
