/* A viewer window across a display edge, and a second viewer window.
 * - The grid's middle column edge is put on the display edge, so no cell is cut
 *   by the monitor seam. Columns stay equal; one display has no change at all.
 * - The display past the edge gets working copies of the patient tabs, image
 *   tools and series rows. The rows themselves do not move: a copy forwards
 *   its clicks and drags to the original control, which keeps every guard.
 * - The account setting (Viewer Settings > Second Display) turns the copies,
 *   and the rows of a second viewer window, off. Without the setting they show.
 * Geometry is read from the browser only; a screen-details request never
 * prompts here (it is used only when the permission was already granted). */
window.KinViewerDisplaySpan = (() => {
  const ROWS = [
    { row: '.kin-patient-tabs', source: '[role="tablist"]', name: 'Patients', remounts: true },
    // side: the body attribute of Toolbar & Thumbnail Position (viewer-features-chrome.js); place: the row's box in the column.
    // whole: a fixed copy (Monitors in Hanging Protocol) copies the whole row, not only its tools.
    { row: '.kin-ux-toolbar', source: '.kin-ux-tools-bar', name: 'Image Tools', side: 'data-kin-toolbar-side', place: '.kin-ux-toolbar-slot', whole: true },
    { row: '.kin-viewer-series-strip', source: '.kin-series-list', name: 'Series', side: 'data-kin-thumbs-side', place: '.kin-viewer-series-strip' },
  ];
  const ROOM = 120;
  // A patient switch or close from the copied tabs remounts the viewer: the request to keep focus on the copy
  // outlives that mount (same document) however long the switch takes, and is used once by the next copy of
  // that row. It is dropped by the reader's own next click or key outside that copy (they moved on); a refused
  // switch moves no focus, so nothing is taken from the reader.
  let carry = null;
  const carried = name => !!carry && carry.name === name;
  function slotOf() {
    const hash = new URLSearchParams(location.hash.slice(1));
    const groups = hash.getAll('kin-window-group'), slots = hash.getAll('kin-window-slot');
    return groups.length === 1 && slots.length === 1 && /^[0-3]$/.test(slots[0]) ? { group: groups[0], slot: Number(slots[0]) } : null;
  }
  function pathTo(root, node) {
    const path = [];
    for (let at = node; at && at !== root; at = at.parentElement) {
      if (!at.parentElement) return null;
      path.unshift([...at.parentElement.children].indexOf(at));
    }
    return path;
  }
  function follow(root, path) {
    let at = root;
    for (const index of path || []) { at = at?.children[index]; if (!at) return null; }
    return at;
  }
  function mount({ services, commands = null, enabled }) {
    const layout = window.KinViewerDisplayLayout;
    let ended = false, frame = null, details = null, geometry = '', firstSeen = 0, link = null, channel = null;
    let owed = false, dividing = false, divided = 0, laid = 0;
    const abort = new AbortController(), mirrors = new Map();
    const style = document.createElement('style'); style.dataset.kinUxOwned = ''; document.head.append(style);
    const on = () => { try { return enabled() !== false; } catch (_) { return true; } };
    // Reuse window-management access the reader already granted; never ask here.
    navigator.permissions?.query({ name: 'window-management' }).then(permission => {
      if (permission.state === 'granted') return window.getScreenDetails?.();
    }).then(value => {
      if (ended || !value) return;
      details = value;
      details.addEventListener?.('screenschange', schedule, { signal: abort.signal });
      details.addEventListener?.('currentscreenchange', schedule, { signal: abort.signal });
      schedule();
    }).catch(() => {});
    function screens() {
      if (details?.screens?.length) return Array.from(details.screens, s => ({ left: s.left, top: s.top, width: s.width, height: s.height }));
      const s = window.screen;
      return [{ left: s.availLeft, top: s.availTop, width: s.availWidth, height: s.availHeight }];
    }
    function zoom() {
      const os = details?.currentScreen?.devicePixelRatio;
      return Number.isFinite(os) && os > 0 ? window.devicePixelRatio / os : null;
    }
    function seams() {
      return layout.seams(screens(), { screenX: window.screenX, screenY: window.screenY, outerWidth: window.outerWidth,
        outerHeight: window.outerHeight, innerWidth: window.innerWidth, innerHeight: window.innerHeight }, zoom());
    }
    // M-1: the grid fills its column; its middle edge goes to the seam. A grid of one column has no middle edge: over two
    // monitors it becomes one cell per monitor (divide), and then its middle edge goes to the seam as any other.
    function placeGrid(list) {
      const grid = document.querySelector('[data-cy="viewport-grid"]'), column = grid?.parentElement;
      let rule = '', seam = null;
      const state = services.viewportGridService.getState();
      const cells = [...state.viewports.values()];
      const middle = cells.some(cell => Math.abs((cell.x ?? -1) - 0.5) < 0.001);
      owed = false;
      if (grid && column) {
        const box = column.getBoundingClientRect(), css = getComputedStyle(column);
        const base = { left: box.left + parseFloat(css.paddingLeft || 0) + parseFloat(css.borderLeftWidth || 0),
          right: box.right - parseFloat(css.paddingRight || 0) - parseFloat(css.borderRightWidth || 0) };
        const plan = layout.split(base, list);
        if (plan && middle) {
          seam = plan.seam;
          if (plan.left || plan.right) rule = 'body.kin-viewer-ux [data-cy="viewport-grid"] { margin-left: ' + plan.left + 'px !important; margin-right: ' + plan.right +
            'px !important; width: calc(100% - ' + (plan.left + plan.right) + 'px) !important; max-width: calc(100% - ' + (plan.left + plan.right) + 'px) !important; }';
        // One column is divided only for one display edge in the image column: with two (three displays) no pair is guessed.
        } else if (plan && list.filter(x => x > base.left + 1 && x < base.right - 1).length === 1) divide(state, cells);
      }
      if (style.textContent !== rule) style.textContent = rule;
      return seam;
    }
    // One column of image stacks over two monitors - each image would have the monitor seam down its middle - is made two
    // columns, one per monitor, by the Layout menu's own command: that command keeps every cell there is in its place (the
    // stack it shows, its frame, an empty cell empty, the active cell) and only adds the second column. A protocol that
    // gives one column again (another patient in this window) is divided again. The whole rule is here:
    //  - the grid: a plain grid of one column, judged on every cell's whole place (plain) - a cell that a protocol or a
    //    saved view put elsewhere (not from the top, not the full height) is theirs;
    //  - the monitors: two side by side under the images, as far as the viewer can tell (kinViewerTwoMonitorsNow);
    //  - what it shows: at least one cell shows a display set, and every such cell shows it now as a drawn image stack
    //    (shows). Not an MPR, 3D, PDF or report cell, nor a series still loading - an empty cell asks for nothing;
    //  - never the cell the reader enlarged (the stock one-up's own cell; a maximized or merged cell), and never under an
    //    operation that owns the screen now (holder). Asked again once that ends (owed), one request at a time, at most
    //    one per 2 s.
    function divide(state, cells) {
      const rows = state.layout?.numRows;
      const single = (state.layout?.layoutType ?? 'grid') === 'grid' && state.layout?.numCols === 1 && Number.isInteger(rows) && rows >= 1 && plain(cells, rows);
      if (!single || typeof commands?.runCommand !== 'function') return;
      const showing = cells.filter(cell => (cell.displaySetInstanceUIDs || []).length);
      if (!showing.length || showing.some(cell => (cell.viewportOptions?.viewportType ?? 'stack') !== 'stack')) return;
      if (mammography()) return;
      // Two monitors side by side under the images, as Monitors in Hanging Protocol counts them (viewer-features-monitors.js:
      // of two displays one above the other only one is the monitor there, whatever side edge of the other lies inside
      // the window). Not so: left alone, and looked at again each second - that answer follows a later reading of the
      // displays, with nothing else changing here. Not known (no display access): the display edge found above decides.
      try { if (window.kinViewerTwoMonitorsNow?.() === false) { owed = true; return; } } catch (_) { return; }
      // The stock one-up's one cell (a double click the monitor maximize could not take): that toggle puts its grid back.
      // Looked at again each second: another layout of the same shape can take its place with nothing else changing.
      try { if (window.kinViewerStockOneUp?.()) { owed = true; return; } } catch (_) { return; }
      if (!showing.every(shows) || holder() || dividing || Date.now() - divided < 2000) { owed = true; return; }
      dividing = true; divided = Date.now();
      Promise.resolve().then(() => commands.runCommand('setViewportGridLayout', { numRows: rows, numCols: 2 }))
        .catch(() => {}).then(() => { dividing = false; schedule(); });
    }
    // The mammography hanging places its own cells.
    function mammography() {
      let protocol = '';
      try { protocol = String(services.hangingProtocolService?.getState?.()?.protocolId || ''); } catch (_) { protocol = ''; }
      return protocol.startsWith('kin.mammography');
    }
    // The cells are those of a plain grid of rows x cols (one column unless said): each in its own place, top to bottom
    // and left to right, as equal rows and columns.
    function plain(cells, rows, cols = 1) {
      const near = (value, wanted) => Number.isFinite(value) && Math.abs(value - wanted) < 0.001;
      return cells.length === rows * cols && [...cells].sort((a, b) => (a.y ?? 0) - (b.y ?? 0) || (a.x ?? 0) - (b.x ?? 0)).every((cell, index) =>
        near(cell.x, (index % cols) / cols) && near(cell.width, 1 / cols) && near(cell.y, Math.floor(index / cols) / rows) && near(cell.height, 1 / rows));
    }
    // An applied Hanging Protocol with monitors stands: its rows are on each monitor's part of the window (placed) and they
    // cover the grid's edges there. A plain grid picked afterwards - the Layout menu, a protocol of another patient - is
    // laid on the monitors' image areas the rule measured (placed.areas; KinViewerMonitorPlan.fit, the rule's own way of
    // laying cells): each monitor takes half of its columns, none under a row or across the display edge. One column is
    // first made one cell per monitor (divide, with all its conditions), and that grid is then laid the same way. Laid only
    // over two monitors, a grid of an even number of columns, every cell a stack or empty; never the rule's own split, a
    // saved split or any other shape (not plain), and never under an operation that owns the screen (holder: asked again
    // once it ends, at most once per 2 s). The rectangles are registered as this screen's split (kinViewerSplitRects), as
    // the rule registers its own: the double click's maximize, a later Apply's rollback and a saved Job know them.
    function fitMonitors(placed) {
      owed = false;
      const areas = placed.areas, plan = window.KinViewerMonitorPlan, grid = services.viewportGridService;
      if (!Array.isArray(areas) || areas.length !== 2 || typeof plan?.fit !== 'function') return;
      const state = grid.getState(), cells = [...state.viewports.values()];
      const rows = state.layout?.numRows, cols = state.layout?.numCols;
      if ((state.layout?.layoutType ?? 'grid') !== 'grid' || !Number.isInteger(rows) || !Number.isInteger(cols) || rows < 1 || cols < 1 || !plain(cells, rows, cols)) return;
      if (cols === 1) { divide(state, cells); return; }
      const rects = plan.fit(areas, rows, cols);
      if (!rects || typeof grid.setLayout !== 'function' || mammography()) return;
      const showing = cells.filter(cell => (cell.displaySetInstanceUIDs || []).length);
      if (showing.some(cell => (cell.viewportOptions?.viewportType ?? 'stack') !== 'stack')) return;
      // A cell that shows a set shows it as a drawn image stack (not a PDF, a report or a series still loading): looked at
      // again each second.
      if (!showing.every(shows) || holder() || dividing || Date.now() - laid < 2000) { owed = true; return; }
      // Cell i of the plain grid (top to bottom, left to right) takes rectangle i and keeps its place in that grid
      // (positionId): the next Layout pick keeps the cells of the places it still has, as from the plain grid. The native
      // grid lists them as the rule's split does (top to bottom, then left to right).
      const ordered = [...cells].sort((a, b) => (a.y ?? 0) - (b.y ?? 0) || (a.x ?? 0) - (b.x ?? 0));
      const pairs = ordered.map((cell, index) => ({ cell, rect: rects[index], positionId: (index % cols) + '-' + Math.floor(index / cols) }))
        .sort((a, b) => Math.abs(a.rect.y - b.rect.y) > 1e-6 ? a.rect.y - b.rect.y : a.rect.x - b.rect.x);
      dividing = true; laid = Date.now();
      window.kinViewerSplitRects = pairs.map(pair => ({ ...pair.rect }));
      // Each cell stays the viewport it is: its id, what it shows and how.
      Promise.resolve().then(() => grid.setLayout({ numRows: rows, numCols: cols, activeViewportId: state.activeViewportId, isHangingProtocolLayout: false,
        layoutOptions: pairs.map(pair => ({ ...pair.rect, positionId: pair.positionId })),
        findOrCreateViewport: index => {
          const cell = pairs[index].cell, sets = [...(cell.displaySetInstanceUIDs || [])];
          return { displaySetInstanceUIDs: sets, displaySetOptions: cell.displaySetOptions || sets.map(() => ({})),
            viewportOptions: { ...(cell.viewportOptions || {}), viewportId: cell.viewportId, allowUnmatchedView: true } };
        } })).catch(() => {}).then(() => { dividing = false; schedule(); });
    }
    // The cell shows its display set now as a drawn image stack: its stack viewport's current image is the image it has
    // drawn, and is one of that set's own images - for a part of one multi-frame file (a display set per time point,
    // config series-split.js) that very frame, by the viewer's own rule. An image id left in the cell by the series
    // shown before (a PDF or a report took its place, or the new series is still loading), an image not drawn yet and
    // another part's frame of the same file are not that.
    function shows(cell) {
      try {
        const uids = cell.displaySetInstanceUIDs || [], view = services.cornerstoneViewportService?.getCornerstoneViewport?.(cell.viewportId);
        const set = uids.length === 1 ? services.displaySetService?.getDisplaySetByUID?.(uids[0]) : null;
        if (!set || !Array.isArray(set.images) || view?.type !== 'stack' || view.element?.isConnected === false) return false;
        const image = view.getCurrentImageId?.();
        if (!image || !(view.getImageIds?.() || []).includes(image) || view.getCornerstoneImage?.()?.imageId !== image) return false;
        const sop = window.cornerstone?.metaData?.get?.('instance', image)?.SOPInstanceUID;
        if (!sop) return false;
        if (typeof window.kinSeriesSplitHolds !== 'function') return set.images.some(instance => instance?.SOPInstanceUID === sop);
        return window.kinSeriesSplitHolds(set, sop, window.kinViewerImageReference?.(image)?.frame ?? 1);
      } catch (_) { return false; }
    }
    // What owns the screen now, so that its cells are not built anew under it: a cell maximized or merged, a saved Job or
    // History being put back, a Hanging Protocol being applied or waiting for the window to reach its monitors, cell
    // rules, Auto Save View or a patient tab putting a saved view back, a patient switch, Images Only (a cell in the
    // browser's full screen) and a playing Cine. Unknown counts as owned.
    function holder() {
      try {
        const merge = window.kinCellMergeWorkspaceState?.();
        if (merge?.busy || merge?.merged || window.kinViewerJobWorkspaceState?.()?.busy || window.kinViewerHistoryWorkspaceState?.()?.busy ||
          window.KinViewerHangingProtocol?.current?.()?.busy?.() || window.KinViewerMonitors?.reaching?.() || window.KinViewerCellRules?.busy?.() ||
          window.KinViewerAutoSave?.settling?.() || window.KinViewerPatientTabs?.settling?.()) return true;
        if (['kin-patient-switching', 'kin-viewer-empty'].some(name => document.body.classList.contains(name)) || document.fullscreenElement) return true;
        return Object.values(services.cineService?.getState?.()?.cines || {}).some(cine => cine?.isPlaying);
      } catch (_) { return true; }
    }
    // M-2: the copy of one row on the display past the seam.
    function drop(spec) { const state = mirrors.get(spec); if (!state) return; clearTimeout(state.timer); state.observer.disconnect(); state.host.remove(); state.row?.classList.remove('kin-span-row'); mirrors.delete(spec); }
    // Each copied element is paired with the element it was copied from, at copy time.
    function pair(map, copy, source) {
      map.set(copy, source);
      for (let i = 0; i < copy.children.length; i++) pair(map, copy.children[i], source.children[i]);
    }
    function rebuild(state) {
      state.queued = false;
      // Replacing the node a drag started from ends that drag: wait for its end.
      if (ended || !state.source.isConnected || state.dragging) return;
      // The strip and toolbar rewrite equal attributes on every rendered frame; copy only a real change.
      const html = state.source.outerHTML;
      if (html === state.html && state.clone) return;
      let active = state.focusPath || (state.clone?.contains(document.activeElement) ? pathTo(state.clone, document.activeElement) : null);
      if (!active && carried(state.spec.name) && state.source.contains(document.activeElement)) { active = pathTo(state.source, document.activeElement); carry = null; }
      const scrolled = state.clone?.scrollLeft || 0, scrolledTop = state.clone?.scrollTop || 0;
      const clone = state.source.cloneNode(true), map = new WeakMap();
      pair(map, clone, state.source);
      for (const node of [clone, ...clone.querySelectorAll('[id]')]) node.removeAttribute('id');
      for (const node of [clone, ...clone.querySelectorAll('[role="toolbar"],[role="tablist"]')]) {
        const label = node.getAttribute('aria-label');
        if (label && node.matches('[role="toolbar"],[role="tablist"]')) node.setAttribute('aria-label', label + ' (Second Display)');
      }
      state.html = html; state.map = map; state.clone = clone; state.focusPath = null;
      state.host.replaceChildren(state.pagers[0], clone, state.pagers[1]);
      clone.scrollLeft = scrolled; clone.scrollTop = scrolledTop;
      if (active) follow(clone, active)?.focus({ preventScroll: true });
      requestAnimationFrame(() => paging(state));
    }
    // The copy's own list pages by itself (the row's arrows page the original list).
    function paging(state) {
      const clone = state.clone; if (!clone) return;
      const hidden = state.upright ? clone.scrollHeight <= clone.clientHeight + 1 : clone.scrollWidth <= clone.clientWidth + 1;
      state.pagers.forEach(node => { node.hidden = hidden; });
    }
    // Forward only to the very element this copy was made from. The rows build new elements whenever their
    // content changes (another study's series, another tab list, a new tool set), so a copy made before that
    // points at a detached element and is refused, then copied again; it never reaches the element now in its place.
    function original(state, node) {
      const target = state.map?.get(node);
      if (!target || !target.isConnected || !(target === state.source || state.source.contains(target)) ||
          target.tagName !== node.tagName || target.textContent !== node.textContent) { state.html = null; queue(state); return null; }
      return target;
    }
    function nearest(state, node) {
      for (let at = node; at && at !== state.host; at = at.parentElement) if (state.map?.has(at)) return at;
      return null;
    }
    function queue(state) { if (!state.queued) { state.queued = true; requestAnimationFrame(() => rebuild(state)); } }
    function forwardDrag(state, event) {
      const type = event.type;
      if (type === 'dragend') state.dragging = false;
      const node = type === 'dragstart' || type === 'dragend' ? event.target.closest?.('[draggable="true"]') : event.target;
      const copy = node && state.host.contains(node) ? nearest(state, node) : null, target = copy && original(state, copy);
      if (type === 'dragend') queue(state);
      if (!target) { if (type === 'dragstart') event.preventDefault(); return; }
      // The same DataTransfer, inside the reader's own drag: the original's handlers run as if over it
      // (a tool dropped on the copied bar is moved by the original bar's own drop handler).
      const forwarded = new DragEvent(type, { bubbles: true, cancelable: true, composed: true, dataTransfer: event.dataTransfer,
        clientX: event.clientX, clientY: event.clientY, screenX: event.screenX, screenY: event.screenY });
      target.dispatchEvent(forwarded);
      if (forwarded.defaultPrevented) event.preventDefault();
      else if (type === 'dragstart') state.dragging = true;
      event.stopPropagation();
    }
    // fixed: a band an applied Hanging Protocol gives this row on the other monitor (viewer-features-monitors.js:
    // { css, side, upright }). The copy stands there, always shown, instead of following the row's edge and the seam.
    function mirror(spec, seam, fixed = null) {
      // A fixed toolbar copy is the whole row, so its monitor has the row's own trailing controls too (More, Viewer
      // Settings): the monitor shows a toolbar of its own, not only the tools of one shown elsewhere.
      const row = document.querySelector(spec.row), source = fixed && spec.whole ? row : row?.querySelector(':scope > ' + spec.source) || row?.querySelector(spec.source);
      if (!row || !source || source.closest('.kin-span-mirror') || !row.getClientRects().length) { drop(spec); return; }
      const box = row.getBoundingClientRect();
      const side = fixed ? fixed.side : spec.side ? document.body.getAttribute(spec.side) : null, upright = side === 'left' || side === 'right';
      let parent = row, left, width, top = null, height = null;
      if (fixed) {
        parent = row.closest(spec.place)?.parentElement;
        if (!parent) { drop(spec); return; }
      } else if (upright) {
        // A row on the left or right edge lies whole on one display. The other display gets its copy on the same edge of
        // that display (at the seam), lying over the images and coming out only when the pointer reaches that edge.
        const container = row.closest(spec.place)?.parentElement, outer = container?.getBoundingClientRect();
        const middle = (box.left + box.right) / 2;
        if (!outer || (side === 'left' ? middle > seam : middle < seam)) { drop(spec); return; }
        // Both rows on that edge: the toolbar's copy outside (at the seam), the strip's inside it, as the rows themselves.
        const toolbar = spec.place === '.kin-viewer-series-strip' && document.body.getAttribute('data-kin-toolbar-side') === side
          ? document.querySelector('.kin-ux-toolbar')?.getBoundingClientRect().width || 0 : 0;
        if ((side === 'left' ? outer.right - seam : seam - outer.left) < box.width + toolbar + ROOM) { drop(spec); return; }
        parent = container; width = box.width; height = box.height; top = box.top - outer.top;
        left = side === 'left' ? seam - outer.left + toolbar : seam - outer.left - box.width - toolbar;
      } else {
        if (!(seam > box.left + 1 && seam < box.right - 1)) { drop(spec); return; }
        // The copy ends before the row's own trailing controls (More, Viewer Settings, the series arrow).
        let end = box.right;
        for (let node = source.nextElementSibling; node; node = node.nextElementSibling) {
          if (node.matches('[role="status"], .kin-span-mirror') || node.hidden) continue;
          const rect = node.getBoundingClientRect();
          if (rect.width && rect.right > seam) { end = Math.max(seam, rect.left); break; }
        }
        if (end - seam < ROOM) { drop(spec); return; }
        left = seam - box.left; width = end - seam;
      }
      let state = mirrors.get(spec);
      if (state && (state.source !== source || state.row !== row || state.upright !== upright || state.side !== side || state.fixed !== !!fixed)) { drop(spec); state = null; }
      if (state) state.seam = seam;
      if (!state) {
        const host = document.createElement('div'); host.dataset.kinUxOwned = '';
        host.className = 'kin-span-mirror' + (fixed ? ' kin-span-side kin-span-fixed ' + (upright ? 'kin-span-upright' : 'kin-span-across') : upright ? ' kin-span-side' : '');
        host.setAttribute('role', 'group'); host.setAttribute('aria-label', spec.name + ' (Second Display)');
        state = { spec, row, source, host, clone: null, map: null, html: null, queued: false, observer: null, dragging: false,
          focusPath: null, followUntil: 0, pagers: [], upright, side, seam, timer: 0, fixed: !!fixed };
        const current = state;
        state.pagers = [['Previous', -1, upright ? '⌃' : '‹'], ['Next', 1, upright ? '⌄' : '›']].map(([word, direction, text]) => {
          const button = document.createElement('button'); button.type = 'button'; button.className = 'kin-span-pager'; button.hidden = true;
          button.textContent = text; button.setAttribute('aria-label', word + ' ' + spec.name + ' (Second Display)');
          button.onclick = event => { event.stopPropagation(); current.clone?.scrollBy(upright ? { top: direction * current.clone.clientHeight, behavior: 'smooth' } : { left: direction * current.clone.clientWidth, behavior: 'smooth' }); };
          return button;
        });
        host.addEventListener('click', event => {
          if (event.target.closest?.('.kin-span-pager')) return;
          const node = event.target.closest?.('button, summary, a[href], [role="tab"]');
          if (!node || !host.contains(node)) return;
          event.preventDefault(); event.stopPropagation();
          const target = original(current, node);
          if (!target || target.disabled) return;
          current.followUntil = Date.now() + 3000; if (spec.remounts) carry = { name: spec.name }; target.click();
        });
        // Tab keys (ArrowLeft/Right, Home, End, Delete) run the original control's own handler. The event does not
        // bubble again, so document shortcuts see the reader's key once. Enter/Space arrive as a click.
        host.addEventListener('keydown', event => {
          if (['Tab', 'Enter', ' '].includes(event.key) || event.target.closest?.('.kin-span-pager')) return;
          const copy = nearest(current, event.target), target = copy && original(current, copy);
          if (!target) return;
          const forwarded = new KeyboardEvent('keydown', { key: event.key, code: event.code, shiftKey: event.shiftKey, ctrlKey: event.ctrlKey,
            altKey: event.altKey, metaKey: event.metaKey, repeat: event.repeat, cancelable: true, bubbles: false });
          current.followUntil = Date.now() + 3000; if (spec.remounts) carry = { name: spec.name };
          target.dispatchEvent(forwarded);
          if (forwarded.defaultPrevented) event.preventDefault();
        });
        for (const type of ['dragstart', 'dragend', 'dragenter', 'dragover', 'drop']) host.addEventListener(type, event => forwardDrag(current, event));
        host.addEventListener('scroll', () => paging(current), { capture: true });
        state.observer = new MutationObserver(() => queue(current));
        state.observer.observe(source, { subtree: true, childList: true, attributes: true, characterData: true });
        if (!upright && !fixed) row.classList.add('kin-span-row');
        if (fixed) state.host.setAttribute('data-kin-shown', '');
        parent.append(host);
        mirrors.set(spec, state); rebuild(state);
      } else if (state.host.parentElement !== parent) parent.append(state.host);
      if (fixed) {
        for (const key of ['left', 'right', 'top', 'bottom', 'width', 'height']) state.host.style[key] = fixed.css[key] ?? '';
        paging(state); return;
      }
      state.host.style.left = Math.round(left * 100) / 100 + 'px';
      state.host.style.width = Math.round(width * 100) / 100 + 'px';
      if (upright) { state.host.style.top = Math.round(top * 100) / 100 + 'px'; state.host.style.height = Math.round(height * 100) / 100 + 'px'; }
      paging(state);
    }
    // A copy on a side comes out while the pointer is within 8px inside its display's edge (the seam) or over it, while
    // keyboard focus is in it and while a drag from it lasts; it folds 0.6s after the last of these. Copies on the same
    // edge (toolbar and strip) come out, stay and fold together.
    let pointer = null, sideFrame = null;
    function wanted(state) {
      const host = state.host, box = host.getBoundingClientRect(), focused = document.activeElement;
      const within = !!pointer && pointer.y >= box.top && pointer.y <= box.bottom;
      const edge = within && (state.side === 'left' ? pointer.x >= state.seam && pointer.x <= state.seam + 8 : pointer.x >= state.seam - 8 && pointer.x <= state.seam);
      const over = within && host.hasAttribute('data-kin-shown') && pointer.x >= box.left && pointer.x <= box.right;
      return edge || over || state.dragging || !!focused && host.contains(focused) && focused.matches(':focus-visible');
    }
    function sides() {
      sideFrame = null;
      const copies = [...mirrors.values()].filter(state => state.upright && !state.fixed);
      const want = new Map(copies.map(state => [state, wanted(state)]));
      for (const state of copies) {
        const host = state.host, mates = copies.filter(other => other.side === state.side);
        if (mates.some(other => want.get(other))) { clearTimeout(state.timer); state.timer = 0; host.setAttribute('data-kin-shown', ''); }
        else if (host.hasAttribute('data-kin-shown') && !state.timer) state.timer = setTimeout(() => {
          state.timer = 0;
          if (ended) return;
          if ([...mirrors.values()].some(other => other.upright && !other.fixed && other.side === state.side && wanted(other))) sides();
          else host.removeAttribute('data-kin-shown');
        }, 600);
      }
    }
    const soon = () => { if (!ended && !sideFrame) sideFrame = requestAnimationFrame(sides); };
    document.addEventListener('pointermove', event => { pointer = { x: event.clientX, y: event.clientY }; soon(); }, { capture: true, passive: true, signal: abort.signal });
    // The pointer left the window: nothing holds a copy out any more.
    document.documentElement?.addEventListener('pointerleave', () => { pointer = null; soon(); }, { passive: true, signal: abort.signal });
    for (const type of ['focusin', 'focusout', 'dragend', 'drop']) document.addEventListener(type, () => setTimeout(soon), { capture: true, passive: true, signal: abort.signal });
    for (const type of ['pointerdown', 'keydown']) document.addEventListener(type, event => {
      if (!carry || !event.isTrusted) return;
      if (event.target?.closest?.('.kin-span-mirror')?.getAttribute('aria-label') === carry.name + ' (Second Display)') return;
      carry = null;
    }, { capture: true, signal: abort.signal });
    // A control used from the copy that moves focus to an original control (a tab switch focuses the new tab)
    // keeps the reader on the copy's display.
    document.addEventListener('focusin', event => {
      for (const state of mirrors.values()) {
        // Only focus that leaves the copy (or the copy's node replaced under it) is brought back, once.
        const from = event.relatedTarget;
        if (state.followUntil < Date.now() && !carried(state.spec.name) || !state.source.contains(event.target) ||
            from && from.isConnected && !from.closest?.('.kin-span-mirror')) continue;
        state.followUntil = 0; carry = null; state.focusPath = pathTo(state.source, event.target); state.html = null; queue(state);
      }
    }, { capture: true, signal: abort.signal });
    // A second window of the same viewer group hides its rows only while the
    // first window of that group is open (a lone window is never stripped).
    function bindGroup() {
      const now = slotOf(), key = now ? now.group + ':' + now.slot : null;
      if (key === link?.key) return;
      channel?.close(); channel = null; link = now ? { ...now, key } : null; firstSeen = 0;
      if (!link || typeof BroadcastChannel !== 'function') return;
      try {
        channel = new BroadcastChannel('kin-viewer-display:' + link.group);
        channel.onmessage = event => {
          const m = event.data;
          if (m?.type === 'first' && link.slot > 0) { firstSeen = Date.now(); schedule(); }
          if (m?.type === 'gone' && link.slot > 0) { firstSeen = 0; schedule(); }
          if (m?.type === 'who' && link.slot === 0) channel.postMessage({ type: 'first' });
        };
        channel.postMessage({ type: link.slot === 0 ? 'first' : 'who' });
      } catch (_) { channel = null; }
    }
    function update() {
      frame = null;
      if (ended) return;
      // An applied Hanging Protocol with monitors has split the grid at the display edge and placed the toolbar and the
      // strip on each monitor itself (viewer-features-monitors.js): its split is left as it made it, a plain grid picked
      // afterwards is laid on its monitors' image areas (fitMonitors), and those two rows are copied where it says. The
      // patient tabs, which it does not place, keep following Second Display.
      const placed = window.KinViewerMonitorRows || null;
      const list = seams();
      if (placed && style.textContent) style.textContent = '';
      if (placed) fitMonitors(placed);
      const seam = placed ? null : placeGrid(list);
      const rowSeam = seam ?? list.find(x => x > window.innerWidth / 4 && x < window.innerWidth * 3 / 4) ?? null;
      for (const spec of ROWS) {
        const fixed = placed && spec.side ? placed.copies?.[spec.name] || null : undefined;
        if (fixed !== undefined) { if (fixed) mirror(spec, rowSeam, fixed); else drop(spec); }
        else if (on() && rowSeam !== null) mirror(spec, rowSeam); else drop(spec);
      }
      const second = !!link && link.slot > 0 && firstSeen && Date.now() - firstSeen < 7000;
      document.body.classList.toggle('kin-second-display-rows-off', !placed && !on() && !!second);
      document.body.classList.toggle('kin-second-display-tabs-off', !!placed && !on() && !!second);
    }
    function schedule() { if (!ended && !frame) frame = requestAnimationFrame(update); }
    // The grid's shape and what its cells show, to measure again when either changed without an event read after it: the
    // stock grid announces a change before its state shows it, so the first layout picked after stretching the window
    // stayed across the seam (and a series put into an empty cell would not be seen).
    function shape() {
      try {
        const state = services.viewportGridService.getState();
        return JSON.stringify([state.layout?.numRows, state.layout?.numCols, [...state.viewports.values()].map(cell => [cell.x, cell.y, cell.width, cell.height, cell.displaySetInstanceUIDs || []])]);
      } catch (_) { return ''; }
    }
    function poll() {
      // Browsers announce no window move. Compare the geometry each second, and the grid's shape with it.
      const now = [window.screenX, window.screenY, window.outerWidth, window.outerHeight, window.innerWidth, window.innerHeight, shape()].join(',');
      if (now !== geometry || owed) { geometry = now; schedule(); }
      if (link?.slot > 0) channel?.postMessage({ type: 'who' });
      if (link && link.slot > 0 && firstSeen && Date.now() - firstSeen >= 7000) schedule();
    }
    const timer = setInterval(poll, 1000);
    window.addEventListener('resize', schedule, { signal: abort.signal });
    window.screen?.addEventListener?.('change', schedule, { signal: abort.signal });
    window.addEventListener('hashchange', () => { bindGroup(); schedule(); }, { signal: abort.signal });
    window.addEventListener('kin-viewer-second-display', schedule, { signal: abort.signal });
    // A drag that ends outside the copy (dropped on a cell, cancelled) releases the copies too.
    for (const type of ['drop', 'dragend']) window.addEventListener(type, () => setTimeout(() => {
      for (const state of mirrors.values()) if (state.dragging) { state.dragging = false; queue(state); }
    }), { capture: true, signal: abort.signal });
    window.addEventListener('pagehide', () => { if (link?.slot === 0) channel?.postMessage({ type: 'gone' }); }, { signal: abort.signal });
    const subscriptions = Object.values(services.viewportGridService.EVENTS || {}).map(event => services.viewportGridService.subscribe(event, schedule));
    // Opening or closing a side panel changes the grid's column without a window resize.
    const resized = new ResizeObserver(schedule);
    let observed = null;
    const observeColumn = () => {
      const column = document.querySelector('[data-cy="viewport-grid"]')?.parentElement;
      if (!column || column === observed) return false;
      if (observed) resized.unobserve(observed);
      observed = column; resized.observe(column); return true;
    };
    const rooted = new MutationObserver(() => { if (observeColumn()) schedule(); });
    // Toolbar & Thumbnail Position moves the rows (not always resizing the column): place the copies again.
    const placed = new MutationObserver(schedule);
    placed.observe(document.body, { attributes: true, attributeFilter: ['data-kin-chrome', 'data-kin-toolbar-side', 'data-kin-thumbs-side', 'data-kin-toolbar-hide', 'data-kin-thumbs-hide'] });
    const root = document.getElementById('root');
    if (root) rooted.observe(root, { childList: true, subtree: true });
    bindGroup(); observeColumn(); schedule();
    return {
      seams, refresh: schedule,
      dispose() {
        if (ended) return; ended = true;
        if (link?.slot === 0) { try { channel?.postMessage({ type: 'gone' }); } catch (_) {} }
        cancelAnimationFrame(frame); cancelAnimationFrame(sideFrame); clearInterval(timer); abort.abort(); resized.disconnect(); rooted.disconnect(); placed.disconnect();
        for (const state of mirrors.values()) clearTimeout(state.timer);
        subscriptions.forEach(subscription => subscription.unsubscribe());
        [...mirrors.keys()].forEach(drop); channel?.close(); style.remove();
        document.body.classList.remove('kin-second-display-rows-off', 'kin-second-display-tabs-off');
      },
    };
  }
  return { mount };
})();
