// Viewer feature module: Monitors in Hanging Protocol. A Hanging Protocol rule may say, for each monitor (the n-th
// display from the left, as Viewer Windows > Detect Displays numbers them), how many of its cells that monitor shows
// (Images), whether the worklist belongs there, and where the thumbnail (series) strip and the toolbar stand on it.
// There is one viewer window; it covers one display or two side by side. When the rule is applied, the window is moved
// over its image monitors (only with the display permission the reader already gave), and its image area is split at
// the display edge: each monitor's part gets its own cells and its own rows. The worklist window is asked to come to its
// monitor (viewer-windows.js placeWorklist: a popup or app window moves; a tab offers to open the worklist window there).
// The pure part below (KinViewerMonitorPlan) turns a rule, the displays and the window into that split.
// The viewer write path (viewer-language.js): product words in the reader's screen language, or as written.
function kinText(t, ...p) { const l = typeof window === 'object' && window && window.KinLanguage; return l && l.text ? l.text(t, ...p) : t.replace(/\{[ten]?(\d+)\}/g, (m, i) => String(p[i])); }
function kinHtml(t, ...p) { const l = typeof window === 'object' && window && window.KinLanguage; return l && l.html ? l.html(t, ...p) : t.replace(/\{[ten]?(\d+)\}/g, (m, i) => String(p[i])); }
(function (root) {
  const THICKNESS = { toolbar: { across: 36, upright: 108 }, thumbs: { across: 66, upright: 156 } };
  const MIN_REGION = 200;
  const upright = side => side === 'left' || side === 'right';
  const finite = (...values) => values.every(Number.isFinite);

  // The window's client area in screen px ({ z, left, top, bottom }; z: CSS px -> screen px), or null when its frame
  // cannot be read. win: screenX/screenY/outerWidth/outerHeight/innerWidth/innerHeight; zoom: CSS px -> screen px, or
  // null when unknown (then only a plain window frame is accepted, as KinViewerDisplayLayout.seams does).
  function client(win, zoom) {
    if (!win || !finite(win.screenX, win.screenY, win.outerWidth, win.outerHeight, win.innerWidth, win.innerHeight) || win.innerWidth <= 0) return null;
    let z = zoom;
    if (!(Number.isFinite(z) && z > 0)) { const plain = win.outerWidth - win.innerWidth; if (plain < 0 || plain > 40) return null; z = 1; }
    const frame = win.outerWidth - win.innerWidth * z;
    if (frame < -1 || frame > 80) return null;
    const side = Math.max(0, frame) / 2, top = win.screenY + (win.outerHeight - win.innerHeight * z) - side;
    return { z, left: win.screenX + side, top, bottom: top + win.innerHeight * z };
  }
  // Displays (left to right, as KinViewerDisplayLayout.screens lists them) that this window covers, in its client px
  // (win and zoom as for client). Column: the image column's left and right in client px. A part narrower than `least`
  // (MIN_REGION: a window barely over the edge) is not a monitor's region; the display edges of a maximize count a
  // narrower part too (EDGE_SLACK).
  function regions(screens, win, zoom, column, least = MIN_REGION) {
    const area = client(win, zoom);
    if (!area) return [];
    const { z, left, top, bottom } = area, from = Math.max(0, column?.left ?? 0), to = Math.min(win.innerWidth, column?.right ?? win.innerWidth);
    const list = [];
    (screens || []).forEach((s, monitor) => {
      if (!s || !finite(s.left, s.top, s.width, s.height) || s.top >= bottom || s.top + s.height <= top) return;
      const a = Math.max(from, (s.left - left) / z), b = Math.min(to, (s.left + s.width - left) / z);
      const tall = Math.min(bottom, s.top + s.height) - Math.max(top, s.top);
      if (b - a >= least) list.push({ monitor, left: Math.round(a * 100) / 100, right: Math.round(b * 100) / 100, tall });
    });
    // Only displays side by side split the window: of two displays one above the other (the same columns of the
    // window), the one holding more of its height is the monitor there. The parts kept must meet edge to edge.
    const kept = [];
    for (const region of list.sort((x, y) => y.tall - x.tall || x.left - y.left))
      if (!kept.some(other => Math.min(other.right, region.right) - Math.max(other.left, region.left) > 1)) kept.push(region);
    const sorted = kept.sort((x, y) => x.left - y.left), joined = [];
    for (const region of sorted) {
      if (joined.length && Math.abs(region.left - joined[joined.length - 1].right) > 2) break;
      joined.push({ monitor: region.monitor, left: region.left, right: region.right });
    }
    return joined;
  }

  // Where the window should stand for a rule: over its first image monitor, or that one and the next when both show
  // images and the two displays touch side by side (one window covers at most two displays, as Span Displays does). An
  // image monitor beyond the displays there are, or past those two, is listed as not applied.
  function target(monitors, screens) {
    const list = monitors?.list || [], images = list.map((m, i) => m.images !== 'none' ? i : -1).filter(i => i >= 0);
    const skipped = images.filter(i => i >= screens.length).map(monitor => ({ monitor, reason: 'no-display' }));
    const present = images.filter(i => i < screens.length);
    if (!present.length) return { monitors: [], rect: null, skipped };
    const first = present[0], next = present[1];
    const a = screens[first], b = next === first + 1 ? screens[next] : null;
    const touching = !!b && Math.abs(a.left + a.width - b.left) <= 2 && Math.min(a.top + a.height, b.top + b.height) - Math.max(a.top, b.top) > 0;
    const covered = touching ? [first, next] : [first];
    for (const monitor of present) if (!covered.includes(monitor)) skipped.push({ monitor, reason: 'one-window' });
    const left = Math.min(...covered.map(i => screens[i].left)), top = Math.min(...covered.map(i => screens[i].top));
    const rect = { left, top, width: Math.max(...covered.map(i => screens[i].left + screens[i].width)) - left,
      height: Math.max(...covered.map(i => screens[i].top + screens[i].height)) - top };
    return { monitors: covered, rect, skipped: skipped.sort((x, y) => x.monitor - y.monitor) };
  }

  // The bands of one region's rows (the toolbar outside, the strip inside it, as Toolbar & Thumbnail Position places
  // them) and the image area left over, all in client px.
  function bands(box, rows) {
    const inset = { top: 0, right: 0, bottom: 0, left: 0 }, out = {};
    for (const row of ['toolbar', 'thumbs']) {
      const side = rows[row];
      if (!side) continue;
      const thick = THICKNESS[row][upright(side) ? 'upright' : 'across'];
      const left = box.left + inset.left, right = box.right - inset.right, top = box.top + inset.top, bottom = box.bottom - inset.bottom;
      // inset: the bands already taken on each edge of the region when this one is placed (for a stylesheet that keeps the
      // band on its edge when the window is resized), thick: its own thickness.
      out[row] = { side, left: side === 'right' ? right - thick : left, top: side === 'bottom' ? bottom - thick : top,
        width: upright(side) ? thick : right - left, height: upright(side) ? bottom - top : thick, inset: { ...inset }, thick };
      inset[side] += thick;
    }
    out.images = { left: box.left + inset.left, top: box.top + inset.top, right: box.right - inset.right, bottom: box.bottom - inset.bottom };
    return out;
  }

  // The split for a rule over the regions this window covers. model: KinHangingProtocolModel (monitorCells). column: the
  // image column (client px: left, top, right, bottom); grid: the native viewport grid's box (client px). Returns null
  // when no covered region shows images. Otherwise:
  //  rects / cells: one native position per entry, ordered top to bottom then left to right (the order the grid lists its
  //    viewports in); cells[i] is the rule cell shown there (an index into rule.layout.cells) or null for an empty one.
  //  numRows / numCols: a base grid with at least as many positions as rects.
  //  rows: { toolbar, thumbs } -> { original: band | null, copy: band | null } (band: client px + side + monitor).
  //  applied: the monitors shown; hidden: rule cells no applied monitor shows; toolbarKept: no applied monitor shows a
  //  toolbar, so it stays on top of the first one (Viewer Settings must stay reachable).
  //  areas: each applied monitor's image area (its part less its rows), left to right, as fractions of the grid - where a
  //  grid picked later is laid while these rows stand (fit).
  //  positions: each rect's place key (positionId 'col-row') in the plain grid it stands for (places), or null.
  function split(model, rule, covered, column, grid) {
    const list = rule?.monitors?.list;
    if (!list || !covered.length || !grid || !(grid.width > 0) || !(grid.height > 0)) return null;
    const dealt = model.monitorCells(rule).plan, byMonitor = new Map(dealt.map(entry => [entry.monitor, entry]));
    const parts = covered.map(region => ({ region, monitor: list[region.monitor], entry: byMonitor.get(region.monitor) || null }))
      .filter(part => part.monitor && part.entry);
    if (!parts.length) return null;
    const showing = row => parts.filter(part => part.monitor[row] !== 'none').map(part => ({ part, side: part.monitor[row] }));
    const toolbarKept = !showing('toolbar').length;
    const rows = { toolbar: toolbarKept ? [{ part: parts[0], side: 'top' }] : showing('toolbar'), thumbs: showing('thumbs') };
    const positions = [], placed = { toolbar: [], thumbs: [] }, areas = [];
    for (const part of parts) {
      const box = { left: part.region.left, right: part.region.right, top: column.top, bottom: column.bottom };
      const own = {};
      for (const row of ['toolbar', 'thumbs']) { const hit = rows[row].find(item => item.part === part); if (hit) own[row] = hit.side; }
      const b = bands(box, own), span = column.right - column.left;
      // The region's edges as fractions of the column's width.
      const from = (part.region.left - column.left) / span, to = (part.region.right - column.left) / span;
      for (const row of ['toolbar', 'thumbs']) if (b[row]) placed[row].push({ ...b[row], monitor: part.region.monitor, from, to });
      const { rows: r, cols: c, cells } = part.entry, area = b.images, w = (area.right - area.left) / c, h = (area.bottom - area.top) / r;
      areas.push({ monitor: part.region.monitor, left: area.left, top: area.top, width: area.right - area.left, height: area.bottom - area.top });
      cells.forEach((cell, index) => {
        const col = index % c, line = Math.floor(index / c);
        positions.push({ cell, left: area.left + col * w, top: area.top + line * h, width: w, height: h });
      });
    }
    const round = v => Math.round(v * 1e6) / 1e6;
    const rects = positions.map(p => ({ cell: p.cell, x: round((p.left - grid.left) / grid.width), y: round((p.top - grid.top) / grid.height),
      width: round(p.width / grid.width), height: round(p.height / grid.height) }))
      .sort((a, b) => Math.abs(a.y - b.y) > 1e-6 ? a.y - b.y : a.x - b.x);
    const shown = new Set(rects.map(r => r.cell).filter(cell => cell !== null));
    const hidden = rule.layout.cells.map((_, index) => index).filter(index => !shown.has(index));
    const fractions = areas.map(a => ({ monitor: a.monitor, x: round((a.left - grid.left) / grid.width), y: round((a.top - grid.top) / grid.height),
      width: round(a.width / grid.width), height: round(a.height / grid.height) }));
    // Each rectangle's place key (positionId 'col-row'), its place in the plain grid it stands for (places): the native
    // grid would otherwise key it by its rectangle rounded to the grid, which can give two cells one key.
    const at = places(rects, fractions), keys = at && at.map(p => p.col + '-' + p.row);
    return {
      rects: rects.map(({ x, y, width, height }) => ({ x, y, width, height })), cells: rects.map(r => r.cell),
      positions: keys && new Set(keys).size === keys.length ? keys : null,
      numRows: Math.max(...parts.map(part => part.entry.rows)), numCols: parts.reduce((sum, part) => sum + part.entry.cols, 0),
      rows: { toolbar: { original: placed.toolbar[0] || null, copy: placed.toolbar[1] || null }, thumbs: { original: placed.thumbs[0] || null, copy: placed.thumbs[1] || null } },
      applied: parts.map(part => part.region.monitor), hidden, toolbarKept, areas: fractions,
    };
  }

  // A plain grid of rows x cols (one the Layout menu builds) laid on the monitors' image areas of an applied rule (split's
  // areas), as the rule lays its own cells: each area takes an equal share of the columns and every row, so no cell lies
  // under a row or across a display edge. The rectangles are in the grid's position order (row by row, left to right
  // across the monitors). null when the columns do not share out evenly between the areas, or for fewer than two areas.
  function fit(areas, rows, cols) {
    if (!Array.isArray(areas) || areas.length < 2 || !Number.isInteger(rows) || !Number.isInteger(cols) || rows < 1 || cols < 1 ||
        cols % areas.length || !areas.every(a => a && finite(a.x, a.y, a.width, a.height) && a.width > 0 && a.height > 0)) return null;
    const per = cols / areas.length, round = v => Math.round(v * 1e6) / 1e6, rects = [];
    for (let line = 0; line < rows; line++) for (let col = 0; col < cols; col++) {
      const area = areas[Math.floor(col / per)], w = area.width / per, h = area.height / rows;
      rects.push({ x: round(area.x + (col % per) * w), y: round(area.y + line * h), width: round(w), height: round(h) });
    }
    return rects;
  }

  // The place in the plain grid each cell stands for, laid on a rule's monitor areas (split's areas, two or more): a cell
  // belongs to the area its centre is over; its row is its row inside that monitor (one monitor's images may start higher
  // than the other's) and its column the monitor's own columns after those of the monitors to its left - the places fit
  // lays a plain grid on. [{ col, row }] in the cells' order; null without such areas.
  function places(cells, areas) {
    if (!Array.isArray(cells) || !Array.isArray(areas) || areas.length < 2 || !areas.every(a => a && finite(a.x, a.width)) ||
        !cells.every(c => c && finite(c.x, c.y, c.width))) return null;
    const lefts = areas.map(a => a.x).sort((a, b) => a - b), key = v => Math.round(v * 1e4);
    const monitor = c => { const centre = c.x + c.width / 2; let m = 0; lefts.forEach((left, i) => { if (centre >= left) m = i; }); return m; };
    const tops = lefts.map(() => new Set()), lines = lefts.map(() => new Set());
    for (const c of cells) { tops[monitor(c)].add(key(c.y)); lines[monitor(c)].add(key(c.x)); }
    const rank = (set, value) => [...set].sort((a, b) => a - b).indexOf(value);
    const before = m => lines.slice(0, m).reduce((sum, set) => sum + set.size, 0);
    return cells.map(c => { const m = monitor(c); return { col: before(m) + rank(lines[m], key(c.x)), row: rank(tops[m], key(c.y)) }; });
  }
  // The cells of the native grid in the order of the plain grid they stand for, where that order becomes places again: a
  // patient tab keeps its cells in this order and puts them back as a plain grid, position by position (row by row, left
  // to right), which a standing rule then lays on its monitors (fit). The order is the cells' places in that grid, row
  // then column: on a rule's monitor areas (places) - the order on screen (top to bottom) can list the right monitor's
  // cells before the left's - or else the place key each cell carries (positionId 'col-row': the rule's split and fit
  // give every cell its own; the rows can be taken back when the window moves while the cells stay). Without either the
  // cells are kept in the order they are listed (the plain grid's own).
  function order(cells, areas) {
    const list = Array.isArray(cells) ? [...cells] : [];
    let at = places(list, areas);
    if (!at) {
      const keys = list.map(c => /^(\d+)-(\d+)$/.exec(String(c?.positionId ?? '')));
      if (list.length && keys.every(Boolean) && new Set(list.map(c => c.positionId)).size === list.length) at = keys.map(k => ({ col: +k[1], row: +k[2] }));
    }
    if (!at) return list;
    return list.map((c, i) => ({ c, i, ...at[i] })).sort((a, b) => a.row - b.row || a.col - b.col || a.i - b.i).map(e => e.c);
  }

  // Which monitor (index into screens) a window rectangle stands on: the display holding its centre.
  function monitorOf(screens, rect) {
    if (!rect || !finite(rect.left, rect.top, rect.width, rect.height)) return -1;
    const x = rect.left + rect.width / 2, y = rect.top + rect.height / 2;
    return (screens || []).findIndex(s => x >= s.left && x < s.left + s.width && y >= s.top && y < s.top + s.height);
  }

  // A layout of rectangles this module could have made: 1..8 positions inside the screen, none overlapping another.
  function validRects(rects) {
    if (!Array.isArray(rects) || rects.length < 1 || rects.length > 8) return false;
    const ok = rects.every(r => r && finite(r.x, r.y, r.width, r.height) && r.x >= -1e-6 && r.y >= -1e-6 && r.width > 0.02 && r.height > 0.02 &&
      r.x + r.width <= 1 + 1e-6 && r.y + r.height <= 1 + 1e-6);
    if (!ok) return false;
    for (let i = 0; i < rects.length; i++) for (let j = i + 1; j < rects.length; j++) {
      const a = rects[i], b = rects[j];
      const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x), h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
      if (w > 1e-4 && h > 1e-4) return false;
    }
    return true;
  }

  // The CSS box of one band: its region's edges as percentages of the column, the bands already on its edges and its own
  // thickness in px, so it stays on its edge of its monitor when the window is resized.
  function place(band) {
    const pct = v => Math.round(v * 1e6) / 1e4 + '%', px = v => Math.round(v * 100) / 100 + 'px';
    const left = 'calc(' + pct(band.from) + ' + ' + px(band.inset.left) + ')', right = 'calc(' + pct(1 - band.to) + ' + ' + px(band.inset.right) + ')';
    return upright(band.side)
      ? { top: px(band.inset.top), bottom: px(band.inset.bottom), width: px(band.thick), height: 'auto',
          left: band.side === 'left' ? left : 'auto', right: band.side === 'right' ? right : 'auto' }
      : { left, right, width: 'auto', height: px(band.thick),
          top: band.side === 'top' ? px(band.inset.top) : 'auto', bottom: band.side === 'bottom' ? px(band.inset.bottom) : 'auto' };
  }

  // Where the displays meet inside the viewport grid, as fractions of the grid's width (left to right): the edges between
  // the monitors' parts of the window (regions over the grid's columns). A part of the grid on no listed display (only
  // the window's own display is known without the window-management access) is another monitor. Any part of the grid on
  // another display counts, however narrow: the maximize must not reach over it. Only a part within EDGE_SLACK (the
  // error of reading a window frame) is not an edge. One display has none: []. Nothing known about the window (an
  // unreadable frame or no listed display under it) is null. The double click's maximize fills one monitor's part
  // (viewer-cell-merge.js).
  const EDGE_SLACK = 16;
  function edges(screens, win, zoom, grid) {
    if (!grid || !finite(grid.left, grid.width) || !(grid.width > 0)) return null;
    const from = grid.left, to = grid.left + grid.width, list = regions(screens, win, zoom, { left: from, right: to }, EDGE_SLACK);
    if (!list.length) return null;
    const cuts = list.slice(1).map(region => region.left), last = list[list.length - 1].right;
    if (list[0].left - from >= EDGE_SLACK) cuts.unshift(list[0].left);
    if (to - last >= EDGE_SLACK) cuts.push(last);
    return cuts.map(x => Math.round((x - from) / grid.width * 1e6) / 1e6).filter(edge => edge > 0 && edge < 1);
  }
  // Whether the viewport grid stands on two monitors side by side: the parts of it on exactly two of the listed displays
  // (regions - of two displays one above the other only one is the monitor there), nothing of the grid left on anything
  // else (within EDGE_SLACK), and each of the two holding at least half of the window's height. A window laid over two
  // displays one above the other and set apart sideways has the side edge of one of them inside it, yet stands on one
  // monitor there: false. Nothing known about the window: null. One column of images is divided on this
  // (viewer-display-span.js).
  function pair(screens, win, zoom, grid) {
    if (!grid || !finite(grid.left, grid.width) || !(grid.width > 0)) return null;
    const from = grid.left, to = grid.left + grid.width, list = regions(screens, win, zoom, { left: from, right: to }, EDGE_SLACK);
    if (!list.length) return null;
    if (list.length !== 2 || list[0].left - from >= EDGE_SLACK || to - list[1].right >= EDGE_SLACK) return false;
    const area = client(win, zoom);
    return list.every(region => { const s = screens[region.monitor];
      return (Math.min(area.bottom, s.top + s.height) - Math.max(area.top, s.top)) * 2 >= area.bottom - area.top; });
  }

  const plan = { THICKNESS, MIN_REGION, regions, target, bands, split, fit, places, order, monitorOf, validRects, place, edges, pair };
  if (typeof module === 'object' && module.exports) module.exports = plan;
  if (root) root.KinViewerMonitorPlan = plan;
})(typeof window === 'object' ? window : null);

// The displays this browser reports, with only the window-management access the reader already gave (never asked here):
// { screens (left to right), granted, zoom } or null. One display the browser says it has is monitor 1.
// The last answer is kept (the screen details object stays current by itself), so the double click can read the display
// edges at once (kinViewerMonitorEdgesNow) - the stock one-up runs before any await could finish.
var kinViewerScreenAccess = kinViewerScreenAccess || { permission: null, details: null, watched: null };
async function kinViewerScreensInfo() {
  let details = null;
  try {
    const permission = await navigator.permissions?.query({ name: 'window-management' });
    kinViewerScreenAccess.permission = permission || null;
    if (permission && kinViewerScreenAccess.watched !== permission && typeof permission.addEventListener === 'function') {
      kinViewerScreenAccess.watched = permission;
      permission.addEventListener('change', () => { kinViewerScreensInfo().catch(() => {}); });
    }
    if (permission?.state === 'granted') details = await window.getScreenDetails?.();
  } catch (_) { details = null; }
  kinViewerScreenAccess.details = details || null;
  return kinViewerScreensInfoFrom(details);
}
// The same answer from what is known now: the kept screen details while the access stands, or the window's own display.
function kinViewerScreensInfoNow() {
  const access = kinViewerScreenAccess;
  return kinViewerScreensInfoFrom(access.permission?.state === 'granted' ? access.details : null);
}
function kinViewerScreensInfoFrom(details) {
  const layout = window.KinViewerDisplayLayout;
  if (details?.screens?.length && layout) {
    const os = details.currentScreen?.devicePixelRatio;
    return { screens: layout.screens(details), granted: true, zoom: Number.isFinite(os) && os > 0 ? window.devicePixelRatio / os : null };
  }
  const s = window.screen;
  if (s?.isExtended === false && [s.availLeft ?? 0, s.availTop ?? 0, s.availWidth, s.availHeight].every(Number.isFinite))
    return { screens: [{ left: s.availLeft ?? 0, top: s.availTop ?? 0, width: s.availWidth, height: s.availHeight, primary: true }], granted: false, zoom: null };
  return null;
}
if (typeof window === 'object') {
  // The display edges inside the viewport grid now (KinViewerMonitorPlan.edges), for the double click's maximize.
  // Without the access, the display this window is on (window.screen) is the one known; a part of the grid past it is
  // another monitor. null: unknown. kinViewerMonitorEdges reads the displays again; kinViewerMonitorEdgesNow answers at
  // once from the last reading (the double click's owner is decided before anything can be awaited).
  const edgesOf = info => {
    const s = window.screen;
    const box = document.querySelector('[data-cy="viewport-grid"]')?.getBoundingClientRect();
    if (!box) return null;
    const own = [s?.availLeft, s?.availTop, s?.availWidth, s?.availHeight].every(Number.isFinite)
      ? { left: s.availLeft, top: s.availTop, width: s.availWidth, height: s.availHeight } : null;
    const win = { screenX: window.screenX, screenY: window.screenY, outerWidth: window.outerWidth, outerHeight: window.outerHeight,
      innerWidth: window.innerWidth, innerHeight: window.innerHeight };
    const screens = info?.granted ? info.screens : own ? [own] : null;
    const found = screens && window.KinViewerMonitorPlan.edges(screens, win, info?.granted ? info.zoom : null, { left: box.left, width: box.width });
    if (found) return found;
    // The frame cannot be read (a browser zoom without the access): a window inside its own display has no edge.
    return own && win.screenX >= own.left - 16 && win.screenX + win.outerWidth <= own.left + own.width + 16 ? [] : null;
  };
  // One display, as the browser says: no edge.
  window.kinViewerMonitorEdges = async () => window.screen?.isExtended === false ? [] : edgesOf(await kinViewerScreensInfo());
  window.kinViewerMonitorEdgesNow = () => window.screen?.isExtended === false ? [] : edgesOf(kinViewerScreensInfoNow());
  // Whether the viewport grid stands on two monitors side by side now (KinViewerMonitorPlan.pair), from the last reading
  // of the displays. One display, as the browser says: false. null: not known - which displays lie where is known only
  // with the window-management access, and the window's frame must be readable.
  window.kinViewerTwoMonitorsNow = () => {
    if (window.screen?.isExtended === false) return false;
    const info = kinViewerScreensInfoNow(), box = document.querySelector('[data-cy="viewport-grid"]')?.getBoundingClientRect();
    if (!info?.granted || !box) return null;
    return window.KinViewerMonitorPlan.pair(info.screens, { screenX: window.screenX, screenY: window.screenY, outerWidth: window.outerWidth,
      outerHeight: window.outerHeight, innerWidth: window.innerWidth, innerHeight: window.innerHeight }, info.zoom, { left: box.left, width: box.width });
  };
  // Read the access the reader already gave once now, so the first double click knows the displays.
  kinViewerScreensInfo().catch(() => {});

  // The reader began to work on the images (kinViewerImageWork): whatever waits for a screen nobody touched ends
  // ('kin-viewer-image-work'; below, the wait for the window to reach a rule's monitors). One function, called where
  // image work begins:
  //  - here: a press or a wheel step on an image cell, and a key the viewer may act on;
  //  - where an image command is run from the toolbar, its copy on the other display or a shortcut key
  //    (viewer-ux-toolbar.js invoke) - a shortcut key is taken before it reaches the document;
  //  - where a wheel step is taken to scroll or to enlarge the image (config kinStackMouse).
  // Not image work: Ctrl / Cmd / Alt chords (the browser's own zoom, the system's window keys), a Ctrl+wheel nobody took
  // for the image (the browser's zoom), keys typed into a field or a dialog, and moving the window (no input to this page).
  window.kinViewerImageWork = () => { try { window.dispatchEvent(new Event('kin-viewer-image-work')); } catch (_) {} };
  if (!window.kinViewerImageWorkWatched) {
    window.kinViewerImageWorkWatched = true;
    const images = node => !!node?.closest?.('[data-cy="viewport-grid"]');
    const field = node => !!node?.closest?.('input,textarea,select,[contenteditable]:not([contenteditable="false"]),[role="textbox"],dialog,[role="dialog"]');
    document.addEventListener('pointerdown', event => { if (images(event.target)) window.kinViewerImageWork?.(); }, true);
    document.addEventListener('wheel', event => { if (!event.ctrlKey && images(event.target)) window.kinViewerImageWork?.(); }, { capture: true, passive: true });
    document.addEventListener('keydown', event => {
      if (event.ctrlKey || event.metaKey || event.altKey || event.isComposing || /^(Shift|Control|Alt|Meta|CapsLock|Tab|Escape|ContextMenu|F\d+)$/.test(event.key || '') ||
          field(event.target) || field(document.activeElement)) return;
      window.kinViewerImageWork?.();
    }, true);
  }
}

if (typeof window === 'object') window.KinViewerFeatures?.module('monitors', ({ store, ui }) => {
  const plan = window.KinViewerMonitorPlan;
  const IMAGES = [['none', 'None'], ['1x1', '1 × 1'], ['1x2', '1 × 2'], ['2x1', '2 × 1'], ['2x2', '2 × 2'], ['auto', 'Automatic']];
  const WORKLIST = [['show', 'Show'], ['none', 'None']];
  const SIDES = [['top', 'Top'], ['bottom', 'Bottom'], ['left', 'Left'], ['right', 'Right'], ['none', 'None']];
  const label = (list, value) => (list.find(([v]) => v === value) || [, value])[1];
  const COLUMN = 'body[data-kin-monitor-rows] #root :has(> .kin-viewer-series-strip)';
  const fixedStyle = document.createElement('style'), placeStyle = document.createElement('style');
  fixedStyle.dataset.kinUxOwned = ''; placeStyle.dataset.kinUxOwned = '';
  // The rows of a window whose Hanging Protocol places them per monitor stand where the rule says, always shown; the
  // copy on the other display is shown in its own band. Copies keep the orientation of their own band.
  fixedStyle.textContent = [
    COLUMN + ' > .kin-ux-toolbar-slot, ' + COLUMN + ' > .kin-viewer-series-strip { opacity: 1 !important; pointer-events: auto !important; box-shadow: none !important; }',
    COLUMN + '::before, ' + COLUMN + '::after { display: none !important; }',
    'body[data-kin-monitor-rows][data-kin-monitor-no-thumbs] .kin-viewer-series-strip { display: none !important; }',
    'body.kin-second-display-tabs-off .kin-patient-tabs { display: none !important; }',
    '.kin-span-mirror.kin-span-fixed { opacity: 1 !important; pointer-events: auto !important; box-shadow: none; }',
    '.kin-span-mirror.kin-span-fixed.kin-span-across { flex-direction: row; align-items: stretch; }',
    '.kin-span-fixed.kin-span-across .kin-ux-tools-bar, .kin-span-fixed.kin-span-across .kin-series-list { flex-direction: row !important; overflow-x: auto !important; overflow-y: hidden !important; }',
    '.kin-span-fixed.kin-span-upright .kin-ux-tools-bar, .kin-span-fixed.kin-span-upright .kin-series-list { flex-direction: column !important; overflow-x: hidden !important; overflow-y: auto !important; }',
    '.kin-span-fixed.kin-span-upright .kin-series-card { flex: none; width: auto; }',
    // A fixed toolbar copy is the whole row, laid out for its own band whatever edge the original stands on.
    '.kin-span-fixed > .kin-ux-toolbar { width: 100%; height: 100%; min-width: 0; min-height: 0; }',
    '.kin-span-fixed.kin-span-across .kin-ux-toolbar, .kin-span-fixed.kin-span-across .kin-ux-features, .kin-span-fixed.kin-span-across .kin-ux-features-row, .kin-span-fixed.kin-span-across .kin-ux-toolbar-settings { flex-direction: row !important; align-items: center !important; }',
    '.kin-span-fixed.kin-span-across .kin-ux-tools-bar .kin-ux-tool-label { display: none !important; }',
    '.kin-span-fixed.kin-span-upright .kin-ux-toolbar, .kin-span-fixed.kin-span-upright .kin-ux-features, .kin-span-fixed.kin-span-upright .kin-ux-features-row, .kin-span-fixed.kin-span-upright .kin-ux-toolbar-settings { flex-direction: column !important; align-items: stretch !important; height: auto; }',
    '.kin-span-fixed.kin-span-upright .kin-ux-tools-bar .kin-ux-tool-label { display: block !important; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }',
    '.kin-span-fixed.kin-span-upright .kin-ux-tools-bar .kin-ux-tool kbd { display: none !important; }',
    '.kin-monitors-table { border-collapse: collapse; margin: .4em 0; }',
    '.kin-monitors-table th, .kin-monitors-table td { padding: .2em .5em; text-align: left; }',
    '.kin-monitors-list { color: #000; background: #9fb3c8; }',
  ].join('\n');
  document.head.append(fixedStyle, placeStyle);
  const body = document.body;
  // active: the rows as an applied rule leaves them ({ chrome, css, noThumbs, copies, watching }), or null: the account's
  // own. epoch: the prepare() that owns the rows now; a newer one, or clear(), takes them from an older one.
  let active = null, epoch = 0, watch = null;
  const event = () => window.dispatchEvent(new Event('kin-viewer-second-display'));
  const account = () => window.KinViewerChromePosition?.normalize(store.get('chrome'));
  const frames = n => new Promise(resolve => { const step = left => left ? requestAnimationFrame(() => step(left - 1)) : resolve(); step(n); });
  const aborted = () => new DOMException('Aborted', 'AbortError');
  const column = () => document.querySelector('.kin-viewer-series-strip')?.parentElement || document.querySelector('[data-cy="viewport-grid"]')?.parentElement;
  const box = () => { const c = column()?.getBoundingClientRect(); return c ? { left: c.left, right: c.right, top: c.top, bottom: c.bottom } : null; };
  const geometry = () => ({ screenX: window.screenX, screenY: window.screenY, outerWidth: window.outerWidth, outerHeight: window.outerHeight,
    innerWidth: window.innerWidth, innerHeight: window.innerHeight });

  // The bands are placed for the window, column and display edge measured when the rule was applied (state.at, kept
  // with the rows). When any of them differs, now or when those rows are put back by an undo, the rows go back to the
  // account's (in the column's flow, so they cover no image) and the reader is told; the cells stay as they are until
  // the rule is applied again. While a newer prepare() runs (it may move the window itself), the check waits for it.
  const placedAt = () => { const c = box(), g = geometry(); return JSON.stringify([g.screenX, g.screenY, g.outerWidth, g.outerHeight, g.innerWidth, g.innerHeight,
    c && Math.round(c.right - c.left), c && Math.round(c.bottom - c.top)]); };
  let preparing = 0;
  function stopWatch() { if (watch) { watch.observer.disconnect(); clearInterval(watch.timer); watch = null; } }
  function startWatch(state) {
    stopWatch();
    const check = () => {
      if (active !== state) { stopWatch(); return; }
      if (preparing || placedAt() === state.at) return;
      show(null);
      // The reader was asked to lay the window over the rule's monitors (awaitMonitors): the rule comes back once it does.
      if (!reaching) ui.toast(kinText("창 크기나 위치가 바뀌어 모니터별 도구 줄·썸네일 배치를 해제했습니다. 영상 칸은 그대로입니다. 다시 맞추려면 Hanging Protocols에서 Apply 하세요."));
    };
    const observer = new ResizeObserver(() => requestAnimationFrame(check));
    const node = column(); if (node) observer.observe(node);
    watch = { observer, timer: setInterval(check, 1000), check };
  }
  function show(state) {
    stopWatch();
    active = state;
    if (!state) {
      window.KinViewerMonitorRows = null; body.removeAttribute('data-kin-monitor-rows'); body.removeAttribute('data-kin-monitor-no-thumbs');
      placeStyle.textContent = '';
      window.KinViewerUXShell?.chrome?.(account());
    } else {
      // areas: the monitors' image areas the rule measured, where a grid picked later is laid (viewer-display-span.js).
      window.KinViewerMonitorRows = { copies: state.copies, areas: state.areas || null };
      body.setAttribute('data-kin-monitor-rows', ''); body.toggleAttribute('data-kin-monitor-no-thumbs', state.noThumbs);
      placeStyle.textContent = state.css;
      window.KinViewerUXShell?.chrome?.(state.chrome);
      // Rows of an applied rule put back (an undo): measured against where they were placed, not taken as the new place.
      if (state.watching) { startWatch(state); event(); watch?.check(); return; }
    }
    event();
  }
  const declare = (selector, box) => selector + ' { ' + Object.entries(box).map(([k, v]) => k + ': ' + v + ' !important').join('; ') + '; }';

  // Reuse access the reader already gave; never ask here (kinViewerScreensInfo, the same reading as the double click's).
  const screensInfo = () => kinViewerScreensInfo();
  // Moves this window over the target and reads where it actually stands (a browser may refuse or clamp the move).
  async function move(rect, signal) {
    const now = () => ({ left: window.screenX, top: window.screenY, width: window.outerWidth, height: window.outerHeight });
    const close = value => ['left', 'top', 'width', 'height'].every(key => Math.abs(value[key] - rect[key]) <= 16);
    const start = now();
    try { window.moveTo(rect.left, rect.top); window.resizeTo(rect.width, rect.height); window.moveTo(rect.left, rect.top); } catch (_) { return { moved: false, reached: false }; }
    for (const until = Date.now() + 2500; Date.now() < until;) {
      if (signal?.aborted) break;
      await new Promise(resolve => setTimeout(resolve, 100));
      if (close(now())) return { moved: true, reached: true };
    }
    return { moved: JSON.stringify(now()) !== JSON.stringify(start), reached: false };
  }
  const name = index => 'Monitor ' + (index + 1);

  // Hanging Protocols calls this when it applies a rule with monitors (viewer-hanging-protocol.js). It moves the window,
  // puts the rows in place and answers the split; undo() puts back the rows as they were before, commit() keeps them.
  // Both act only while these rows are still the ones shown: an aborted, older or cleared prepare changes nothing more.
  async function prepare(rule, { signal } = {}) {
    const mine = ++epoch, before = active, notes = [];
    // What this rule wants of the worklist once it stands: { monitor, rect } (Worklist Show on a display there is) or null
    // (nothing: an offer made for an earlier rule is taken back).
    let placed = null, worklist = null, reach = null;
    const owns = () => epoch === mine;
    const undo = () => { if (placed && active === placed) show(before); };
    // An abort puts the rows back at once; every later step checks that this prepare still owns them.
    signal?.addEventListener?.('abort', undo, { once: true });
    const check = () => { if (signal?.aborted || !owns()) { undo(); throw aborted(); } };
    const place = state => { check(); placed = state; show(state); };
    const answer = (split, moved = false) => ({ split, moved, note: notes.length ? ' · Monitors: ' + notes.join(' ') : '', undo,
      commit: () => {
        if (!owns()) return;
        // Every rule that stands says once what it wants of the worklist (settleWorklist), applied or not.
        settleWorklist(split ? worklist : null, owns);
        if (reach) awaitMonitors(rule, reach, mine);
        if (!split) { if (active) show(null); return; }
        if (active === placed) { placed.at = placedAt(); placed.watching = true; startWatch(placed); }
      } });
    preparing++;
    // A newer prepare() pauses the check of rows already applied; once none runs, they are measured again.
    try { return await placeRows(); } finally { preparing--; if (!preparing) watch?.check(); }
    async function placeRows() {
      const info = await screensInfo();
      check();
      if (!info) {
        notes.push(kinText("화면 정보를 확인할 수 없어 모니터별 배치를 적용하지 않았습니다. 창 관리 권한을 허용하면 적용됩니다(Viewer Windows › Detect Displays)."));
        return answer(null);
      }
      const monitors = rule.monitors, aim = plan.target(monitors, info.screens);
      const covers = () => {
        const now = plan.regions(info.screens, geometry(), info.zoom, box()).map(region => region.monitor);
        return aim.monitors.every(monitor => now.includes(monitor));
      };
      let moved = false;
      if (aim.rect && !covers()) {
        const result = await move(aim.rect, signal);
        moved = result.moved;
        check();
        // The browser keeps a window on one display (it does not move it over two): the reader is asked to lay it there,
        // and once it stands over those monitors the rule is applied again (reach, after this apply stands). The monitors
        // are those of the displays as they are now (displays): numbers mean nothing once a display comes or goes.
        if (!result.reached && info.granted) reach = { monitors: [...aim.monitors], displays: displaysOf(info) };
        if (!result.reached) notes.push(info.granted ? kinText("브라우저가 영상 창을 {0}(으)로 옮기지 않았습니다. 영상 창의 가장자리를 끌어 그 화면에 걸쳐 놓으세요. 걸쳐 놓으면 이 규칙을 다시 적용합니다.", aim.monitors.map(name).join('·'))
          : kinText("창 관리 권한이 없어 영상 창을 {0}(으)로 옮기지 못했습니다.", aim.monitors.map(name).join('·')));
        await frames(2);
        check();
      }
      // The rows leave the column's flow, so the images fill it; the split is measured on that.
      place({ chrome: { toolbar: 'top', toolbarAutoHide: true, thumbs: 'top', thumbsAutoHide: true }, css: '', noThumbs: false, copies: {} });
      await frames(2);
      check();
      const columnBox = box(), gridBox = document.querySelector('[data-cy="viewport-grid"]')?.getBoundingClientRect();
      const covered = columnBox ? laidOn(aim.monitors, plan.regions(info.screens, geometry(), info.zoom, columnBox)) : [];
      const split = columnBox && gridBox ? plan.split(window.KinHangingProtocolModel, rule, covered, columnBox, gridBox) : null;
      for (const skipped of aim.skipped) notes.push(name(skipped.monitor) + ': ' + (skipped.reason === 'no-display' ? kinText("이 화면 구성에 없어 적용하지 않았습니다.") : kinText("한 영상 창은 이웃한 두 화면까지만 덮어 적용하지 않았습니다.")));
      // Rectangles inside the screen, none over another and none squeezed by the bands, or nothing at all.
      if (!split || !plan.validRects(split.rects)) {
        undo();
        notes.push(split ? kinText("모니터 영역에 영상 칸을 나눌 수 없어 모니터별 배치를 적용하지 않았습니다.") : kinText("영상 창이 영상 모니터 위에 있지 않아 모니터별 배치를 적용하지 않았습니다."));
        return answer(null, moved);
      }
      for (const monitor of aim.monitors) if (!split.applied.includes(monitor)) notes.push(kinText("{0}: 영상 창이 그 화면을 덮지 않아 적용하지 않았습니다.", name(monitor)));
      if (split.hidden.length) notes.push(kinText("규칙의 칸 {0}은(는) 모니터 칸 수가 모자라 보이지 않습니다.", split.hidden.map(index => index + 1).join(', ')));
      if (split.toolbarKept) notes.push(kinText("도구 줄을 둘 모니터가 적용되지 않아 도구 줄을 {0} 위에 둡니다.", name(split.applied[0])));
      const { toolbar, thumbs } = split.rows;
      const copy = band => band ? { css: plan.place(band), side: band.side, upright: band.side === 'left' || band.side === 'right' } : null;
      const css = [toolbar.original && declare(COLUMN + ' > .kin-ux-toolbar-slot', plan.place(toolbar.original)),
        thumbs.original && declare(COLUMN + ' > .kin-viewer-series-strip', plan.place(thumbs.original))].filter(Boolean).join('\n');
      place({ chrome: { toolbar: toolbar.original?.side || 'top', toolbarAutoHide: true, thumbs: thumbs.original?.side || 'top', thumbsAutoHide: true },
        css, noThumbs: !thumbs.original, copies: { 'Image Tools': copy(toolbar.copy), Series: copy(thumbs.copy) }, areas: split.areas });
      notes.unshift(kinText("적용 {0}.", split.applied.map(name).join('·')));
      // The worklist window: where it stands is read from it now for the note; once the rule stands (commit) the list
      // document is told the worklist's monitor (settleWorklist) - also when it is there already, so that an offer made
      // for an earlier rule does not stay. A rule with no Worklist Show (or its monitor not here) takes that offer back.
      const listed = monitors.list.findIndex(m => m.worklist === 'show');
      if (listed >= 0) {
        let rect = null;
        try { rect = await window.kinViewerListPlace?.(); } catch (_) { rect = null; }
        check();
        const at = rect ? plan.monitorOf(info.screens, rect) : -1;
        if (info.screens[listed]) { const s = info.screens[listed]; worklist = { monitor: listed, rect: { left: s.left, top: s.top, width: s.width, height: s.height } }; }
        notes.push(!rect || at < 0 ? kinText("Worklist: 목록 창 위치를 확인할 수 없습니다.") : at === listed ? kinText("Worklist: 목록 창이 {0}에 있습니다.", name(listed))
          : !info.screens[listed] ? kinText("Worklist: {0}이(가) 이 화면 구성에 없어 목록 창을 옮기지 않았습니다({1}).", name(listed), name(at))
          : kinText("Worklist: 목록 창이 {0}에 있지 않아({1}) {2}(으)로 옮깁니다.", name(listed), name(at), name(listed)));
      }
      return answer(split, moved);
    }
  }
  // The worklist on the monitor of an applied rule (Worklist: Show), after the rule stands: the list document that linked
  // this window moves its worklist window there or, a tab it cannot move, offers on its own screen to open the worklist
  // window there (viewer-windows.js placeWorklist). Its measured answer is told while this rule is still the one applied
  // (owns). want null: a bar offered for an earlier rule is taken back. The list document follows the latest request
  // only (viewer-windows.js placeWorklist), so the order of the answers does not matter.
  function settleWorklist(want, owns) {
    const ask = window.kinViewerListPlaceOn;
    if (typeof ask !== 'function') return;
    if (want === null) { Promise.resolve(ask(null)).catch(() => {}); return; }
    const n = name(want.monitor);
    Promise.resolve(ask(want)).then(answer => {
      if (!owns()) return;
      const result = answer?.result;
      const text = !answer ? kinText("Worklist: 목록 창이 답하지 않아 {n0}(으)로 옮기지 못했습니다.", n)
        : result === 'moved' ? kinText("Worklist: 목록 창을 {n0}(으)로 옮겼습니다.", n)
        : result === 'offered' ? kinText("Worklist: 목록 창은 브라우저 탭이라 옮길 수 없어, 목록 화면에 \"Open Worklist on {n0}\" 단추를 띄웠습니다.", n)
        : result === 'here' || result === 'superseded' ? null : kinText("Worklist: 목록 창을 {n0}(으)로 옮기지 못했습니다.", n);
      if (text) ui.toast(text);
    }, () => {});
  }
  // The parts of the window a rule is laid on: its image monitors' own parts once the window stands over every one of
  // them - the same pair the wait below looks for, whichever other display the window also covers - else the first two
  // parts it does cover (as far as the browser let it go).
  const laidOn = (monitors, regions) => monitors.length && monitors.every(monitor => regions.some(region => region.monitor === monitor))
    ? regions.filter(region => monitors.includes(region.monitor)) : regions.slice(0, 2);
  // The displays by what they are (their place and size, left to right), not by their numbers.
  const displaysOf = info => JSON.stringify((info?.screens || []).map(s => [s.left, s.top, s.width, s.height]));
  // The rule stands with the browser having kept the window off its monitors. The whole wait is here: once the window's
  // image column, as measured now, stands over each of those monitors (KinViewerMonitorPlan.regions; the browser zoom and
  // the side panels are read again each time), the Hanging Protocols panel is told once, and applies the rule it applied
  // again if it is still the one applied to that screen (viewer-hanging-protocol.js). It ends without doing anything when,
  // first, the reader begins to work on the images (kinViewerImageWork: applying the rule again would build the cells
  // anew over that work), another study is shown, a newer prepare() or a clear() came, the window-management access is
  // no longer given or the displays are no longer the ones the rule was applied on (nothing is judged on what was read
  // before), or two minutes have passed. While it lasts the grid is the rule's (reaching: nothing else rebuilds the
  // cells; the rows this rule placed go back quietly when the window moves, startWatch).
  let reaching = null;
  function stopReaching() { if (reaching) { clearInterval(reaching.timer); window.removeEventListener('kin-viewer-image-work', stopReaching); reaching = null; } }
  function awaitMonitors(rule, reach, mine) {
    stopReaching();
    const until = Date.now() + 120000, study = location.search;
    const timer = setInterval(() => {
      if (epoch !== mine || Date.now() > until || location.search !== study) { stopReaching(); return; }
      const info = kinViewerScreensInfoNow();
      if (!info?.granted || displaysOf(info) !== reach.displays) { stopReaching(); return; }
      const columnBox = box();
      if (!columnBox) return;
      const now = plan.regions(info.screens, geometry(), info.zoom, columnBox).map(region => region.monitor);
      if (!reach.monitors.every(monitor => now.includes(monitor))) return;
      stopReaching();
      window.dispatchEvent(new CustomEvent('kin-viewer-monitors-reached', { detail: { ruleId: rule.id } }));
    }, 500);
    reaching = { timer, mine };
    window.addEventListener('kin-viewer-image-work', stopReaching);
  }
  window.KinViewerMonitors = { prepare, reaching: () => !!reaching,
    clear: () => { epoch++; stopReaching(); if (active) show(null); settleWorklist(null, () => false); } };

  // ── The window: Viewer Settings › Monitors in Hanging Protocol… ──
  const element = (tag, attributes = {}, parent) => {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attributes)) {
      if (key === 'text') node.textContent = value; else if (key === 'className') node.className = value; else node.setAttribute(key, value);
    }
    parent?.append(node); return node;
  };
  async function detected() {
    const info = await screensInfo();
    if (info) return Math.min(4, Math.max(1, info.screens.length));
    return window.screen?.isExtended === true ? 2 : 1;
  }
  function defaults(index) {
    const rows = account() || { toolbar: 'top', thumbs: 'top' };
    return { images: index === 0 ? 'auto' : 'none', worklist: 'none', thumbs: rows.thumbs, toolbar: rows.toolbar };
  }
  // A drawing of one monitor: its rows on their edges, its image grid (Automatic: the rule's grid), the worklist.
  function drawing(index, monitor, layout) {
    const figure = element('figure', { className: 'kin-chrome-figure' });
    const box = element('div', { className: 'kin-chrome-monitor', role: 'img' }, figure);
    box.style.width = '168px'; box.style.height = '104px';
    const area = { top: 0, right: 0, bottom: 0, left: 0 };
    for (const [row, text, thick] of [['toolbar', 'Tools', 14], ['thumbs', 'Thumbs', 24]]) {
      const side = monitor[row];
      if (side === 'none' || monitor.images === 'none') continue;
      const part = element('div', { className: 'kin-chrome-' + row, text }, box), across = side === 'top' || side === 'bottom';
      Object.assign(part.style, { top: side === 'bottom' ? '' : area.top + 'px', bottom: side === 'top' ? '' : area.bottom + 'px',
        left: side === 'right' ? '' : area.left + 'px', right: side === 'left' ? '' : area.right + 'px', [across ? 'height' : 'width']: thick + 'px' });
      area[side] += thick;
    }
    const grid = window.KinHangingProtocolModel?.monitorGrid(monitor.images, layout || { rows: 1, cols: 1 });
    if (grid) {
      const images = element('div', { className: 'kin-chrome-images' }, box);
      Object.assign(images.style, { top: area.top + 'px', right: area.right + 'px', bottom: area.bottom + 'px', left: area.left + 'px',
        display: 'grid', gridTemplate: 'repeat(' + grid.rows + ', 1fr) / repeat(' + grid.cols + ', 1fr)' });
      for (let i = 0; i < grid.rows * grid.cols; i++) element('div', { text: 'Images', style: 'position: static; border: 1px solid #333; display: flex; align-items: center; justify-content: center' }, images);
    }
    if (monitor.worklist === 'show') {
      const list = element('div', { className: 'kin-monitors-list', text: 'Worklist' }, box);
      Object.assign(list.style, grid ? { left: '0', right: '0', bottom: '0', height: '16px' } : { inset: '0' });
    }
    box.setAttribute('aria-label', name(index) + ': Images ' + label(IMAGES, monitor.images) + ', Worklist ' + label(WORKLIST, monitor.worklist) +
      ', Thumbnails ' + label(SIDES, monitor.thumbs) + ', Toolbar ' + label(SIDES, monitor.toolbar));
    element('figcaption', { text: name(index) }, figure);
    return figure;
  }
  const NO_RULE = kinText("아직 Hanging Protocol 규칙이 없습니다. Hanging Protocols에서 먼저 만드세요.");
  const REFUSED = {
    busy: kinText("Hanging Protocols가 다른 작업 중입니다. 잠시 뒤 다시 저장하세요."), scope: kinText("Hanging Protocols가 Site 규칙을 보이고 있습니다. Personal로 바꾼 뒤 다시 저장하세요."),
    missing: kinText("그 Hanging Protocol이 내 규칙에 더 이상 없습니다."), invalid: kinText("이 모니터 설정은 이 Hanging Protocol에 저장할 수 없습니다."),
    storage: kinText("이 브라우저에 Hanging Protocols 초안을 저장하지 못했습니다."), error: kinText("저장하지 못했습니다."),
  };
  function open() {
    const handle = ui.panel({ id: 'monitors', title: 'Monitors in Hanging Protocol' });
    if (!handle || handle.body.childElementCount) return handle;
    const hp = window.KinViewerHangingProtocol?.current?.(), model = window.KinHangingProtocolModel;
    element('p', { text: kinText("Hanging Protocol의 모니터마다 영상 배치, 목록 창 자리, 썸네일·도구 줄 위치를 정합니다. Monitor 1은 가장 왼쪽 화면입니다. Save는 그 Hanging Protocol에 저장만 하고, Hanging Protocols에서 Apply 할 때마다 적용됩니다. Apply 때 목록 창(Worklist Show)이 다른 모니터에 있으면 그 모니터로 옮기고, 브라우저가 옮기지 않는 탭이면 목록 화면에 그 모니터에 목록 창을 여는 단추를 띄웁니다.") }, handle.body);
    const status = element('p', { role: 'status' });
    if (!hp || !model) { handle.body.append(status); status.textContent = kinText("이 뷰어에서 Hanging Protocols를 사용할 수 없습니다."); return handle; }
    const top = element('div', { className: 'kin-chrome-row' }, handle.body);
    const ruleField = element('label', { className: 'kin-chrome-field' }, top); element('span', { text: 'Hanging Protocol' }, ruleField);
    const ruleSelect = element('select', { 'aria-label': 'Hanging Protocol' }, ruleField);
    const countField = element('label', { className: 'kin-chrome-field' }, top); element('span', { text: 'Monitors' }, countField);
    const countSelect = element('select', { 'aria-label': 'Monitors' }, countField);
    for (let n = 1; n <= model.MAX_MONITORS; n++) element('option', { value: String(n), text: String(n) }, countSelect);
    const table = element('table', { className: 'kin-monitors-table' }, handle.body);
    const diagram = element('div', { className: 'kin-chrome-diagram', role: 'group', 'aria-label': 'Monitor Layout' }, handle.body);
    const actions = element('div', { className: 'kin-chrome-actions' }, handle.body);
    const save = element('button', { type: 'button', text: 'Save' }, actions);
    handle.body.append(status);
    let live = true, saving = false;
    const draft = { ruleId: null, count: 1, list: [0, 1, 2, 3].map(defaults) };
    const rules = () => hp.scope() === 'personal' ? hp.read().rules : [];
    const rule = () => rules().find(value => value.id === draft.ruleId) || null;
    function load(id) {
      draft.ruleId = id;
      const saved = rule()?.monitors;
      draft.list = [0, 1, 2, 3].map(index => saved?.list[index] ? { ...saved.list[index] } : defaults(index));
      if (saved) draft.count = saved.count;
    }
    function paint() {
      const focused = document.activeElement?.closest?.('.kin-monitors-table') ? document.activeElement.getAttribute('aria-label') : null;
      table.replaceChildren();
      const head = element('tr', {}, table);
      for (const text of ['Monitor', 'Images', 'Worklist', 'Thumbnails', 'Toolbar']) element('th', { text }, head);
      draft.list.slice(0, draft.count).forEach((monitor, index) => {
        const line = element('tr', {}, table);
        element('td', { text: name(index) }, line);
        for (const [key, text, options] of [['images', 'Images', IMAGES], ['worklist', 'Worklist', WORKLIST], ['thumbs', 'Thumbnails', SIDES], ['toolbar', 'Toolbar', SIDES]]) {
          const select = element('select', { 'aria-label': name(index) + ' ' + text }, element('td', {}, line));
          for (const [value, words] of options) element('option', { value, text: words }, select);
          select.value = monitor[key];
          select.addEventListener('change', () => {
            monitor[key] = select.value;
            // The worklist window is one: Show on one monitor takes it from any other.
            if (key === 'worklist' && select.value === 'show') draft.list.forEach((other, i) => { if (i !== index) other.worklist = 'none'; });
            paint();
          });
        }
      });
      if (focused) table.querySelector('select[aria-label="' + CSS.escape(focused) + '"]')?.focus();
      diagram.replaceChildren(...draft.list.slice(0, draft.count).map((monitor, index) => drawing(index, monitor, rule()?.layout)));
      const list = rules();
      save.disabled = saving || !list.length || !rule();
      save.title = !list.length ? (hp.scope() === 'personal' ? NO_RULE : REFUSED.scope) : '';
    }
    function fill() {
      const list = rules();
      ruleSelect.replaceChildren(...list.map(value => { const option = document.createElement('option'); option.value = value.id; option.textContent = value.name; return option; }));
      ruleSelect.disabled = !list.length;
      if (!list.some(value => value.id === draft.ruleId)) {
        const applied = hp.applied?.(), chosen = applied?.scope === 'personal' && list.some(value => value.id === applied.ruleId) ? applied.ruleId
          : list.some(value => value.id === hp.selected?.()) ? hp.selected() : list[0]?.id || null;
        load(chosen);
      }
      ruleSelect.value = draft.ruleId || '';
      countSelect.value = String(draft.count);
      if (!list.length) status.textContent = hp.scope() === 'personal' ? NO_RULE : REFUSED.scope;
      paint();
    }
    ruleSelect.addEventListener('change', () => { load(ruleSelect.value); countSelect.value = String(draft.count); paint(); });
    countSelect.addEventListener('change', () => { draft.count = Number(countSelect.value); paint(); });
    save.addEventListener('click', async () => {
      if (saving || !rule()) return;
      const value = { count: draft.count, list: draft.list.slice(0, draft.count).map(monitor => ({ ...monitor })) };
      if (!model.monitorsRule(value)) {
        status.textContent = value.list.filter(m => m.worklist === 'show').length > 1 ? kinText("목록 창(Worklist Show)은 한 모니터에만 둘 수 있습니다.")
          : kinText("Viewer Settings에 돌아갈 수 있도록, 영상을 보이는 모니터 하나에는 도구 줄(Toolbar)이 있어야 합니다.");
        return;
      }
      saving = true; save.disabled = true; status.textContent = kinText("저장 중입니다…");
      let result;
      try { result = await hp.saveMonitors(draft.ruleId, value); } catch (error) { console.error(error); result = { ok: false, reason: 'error' }; }
      if (!live) return;
      saving = false;
      const named = '"' + (rule()?.name || '') + '"';
      status.textContent = !result?.ok ? (REFUSED[result?.reason] || REFUSED.error)
        : result.account === 'saved' ? kinText("Hanging Protocol {0}에 이 브라우저와 계정 모두 저장했습니다. Hanging Protocols에서 Apply 하면 적용됩니다.", named)
        : result.account === 'failed' ? kinText("Hanging Protocol {0}에 이 브라우저에는 저장했지만 계정 저장은 실패했습니다. 까닭은 Hanging Protocols에 표시됩니다.", named)
        : kinText("Hanging Protocol {0}에 이 브라우저의 초안으로 저장했습니다. 이 창의 Hanging Protocols가 계정을 불러오지 않아 계정에는 저장하지 않았습니다(Load from Account 뒤 Save to Account).", named);
      paint();
    });
    handle.onClose(() => { live = false; });
    fill();
    // A rule without saved monitors starts from the displays this browser reports.
    if (draft.ruleId && !rule()?.monitors) detected().then(count => { if (live && !rule()?.monitors && !saving) { draft.count = count; countSelect.value = String(count); paint(); } });
    handle.focus();
    return handle;
  }

  ui.setting({ id: 'monitorHanging', kind: 'button', label: 'Monitors in Hanging Protocol…', order: 61, run: () => open() });
  return () => {
    epoch++; stopWatch(); stopReaching();
    if (active) show(null);
    if (window.KinViewerMonitors?.prepare === prepare) window.KinViewerMonitors = null;
    fixedStyle.remove(); placeStyle.remove();
  };
});
