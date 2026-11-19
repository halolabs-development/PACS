// MG menu calculations (viewer-features-mg.js): the counterpart of a point on the opposite breast and the prior of the
// same view, the four quadrants of a view, the breast region of an image and its window, the zoom of each Breast
// Display mode and the slab of DBT slices. Pure: no DOM, no viewer. Image points are image index coordinates (x along
// the columns, y along the rows, 0 … columns / 0 … rows); the "standard" frame is the standard mammography display of
// that image (0 … 1 across and down): right breast with the chest wall at the screen right, left breast with the chest
// wall at the screen left, CC lateral up, oblique and lateral views superior up (mammography-model.js displaySpec).
(function (root) {
  'use strict';
  const CC_FAMILY = new Set(['CC', 'XCCL', 'XCCM', 'FB']);
  const VERTICAL_FAMILY = new Set(['MLO', 'ML', 'LM', 'LMO', 'SIO', 'ISO']);
  const QUADRANTS = ['Upper-Outer', 'Upper-Inner', 'Lower-Inner', 'Lower-Outer'];
  // A view shows one of the two axes a quadrant is named by, up and down on the standard display (CC: outer = lateral
  // up, inner down; oblique and lateral views: upper up, lower down). Across, every view runs from the chest wall to the
  // nipple; the four steps go round the four parts of the box, each to a neighbouring one.
  const QUADRANT_PLAN = {
    cc: [{ top: true, chest: true }, { top: false, chest: true }, { top: false, chest: false }, { top: true, chest: false }],
    vertical: [{ top: true, chest: true }, { top: true, chest: false }, { top: false, chest: false }, { top: false, chest: true }],
  };
  const finite = n => typeof n === 'number' && Number.isFinite(n);
  const positive = n => finite(n) && n > 0;
  const family = view => CC_FAMILY.has(view) ? 'cc' : VERTICAL_FAMILY.has(view) ? 'vertical' : null;

  // Why a cell cannot be linked or named (null when it can). cell: { side: 'R'|'L', view, verified, flipH, flipV, columns, rows }.
  function unlinkable(cell) {
    if (!cell || typeof cell !== 'object') return 'no-image';
    if (!(positive(cell.columns) && positive(cell.rows))) return 'size-unknown';
    if (cell.side !== 'R' && cell.side !== 'L') return 'laterality-unknown';
    if (!family(cell.view)) return 'view-unknown';
    if (cell.verified !== true || typeof cell.flipH !== 'boolean' || typeof cell.flipV !== 'boolean') return 'orientation-unverified';
    return null;
  }
  function toStandard(point, cell) {
    let u = point[0] / cell.columns, w = point[1] / cell.rows;
    if (cell.flipH) u = 1 - u;
    if (cell.flipV) w = 1 - w;
    return [u, w];
  }
  function fromStandard(point, cell) {
    let [u, w] = point;
    if (cell.flipH) u = 1 - u;
    if (cell.flipV) w = 1 - w;
    return [u * cell.columns, w * cell.rows];
  }
  // The same place on another image of the same view: the same standard position, mirrored across for the other breast.
  // Null when either image cannot be linked or the views differ (CC and MLO do not show the same tissue at one place).
  function counterpart(point, source, target) {
    if (!Array.isArray(point) || !finite(point[0]) || !finite(point[1])) return null;
    if (unlinkable(source) || unlinkable(target) || source.view !== target.view) return null;
    let [u, w] = toStandard(point, source);
    if (source.side !== target.side) u = 1 - u;
    return fromStandard([u, w], target);
  }
  // The cells a source cell's change goes to: every other cell of the same view (current and prior, both breasts).
  // skipped: the cells of that view left out, with the reason.
  function targets(sourceId, cells) {
    const list = Array.isArray(cells) ? cells : [];
    const source = list.find(cell => cell.id === sourceId);
    const linked = [], skipped = [];
    if (!source) return { source: null, linked, skipped, reason: 'no-image' };
    const reason = unlinkable(source);
    if (reason) return { source, linked, skipped, reason };
    for (const cell of list) {
      if (cell.id === sourceId || !cell || cell.view !== source.view) continue;
      const why = unlinkable(cell);
      if (why) skipped.push({ id: cell.id, reason: why }); else linked.push(cell.id);
    }
    return { source, linked, skipped, reason: null };
  }

  // A box in image coordinates as the standard frame's box ({ u0, u1, w0, w1 }), and back.
  function standardBox(box, cell) {
    const a = toStandard([box.x0, box.y0], cell), b = toStandard([box.x1, box.y1], cell);
    return { u0: Math.min(a[0], b[0]), u1: Math.max(a[0], b[0]), w0: Math.min(a[1], b[1]), w1: Math.max(a[1], b[1]) };
  }
  function imageBox(s, cell) {
    const a = fromStandard([s.u0, s.w0], cell), b = fromStandard([s.u1, s.w1], cell);
    return { x0: Math.min(a[0], b[0]), x1: Math.max(a[0], b[0]), y0: Math.min(a[1], b[1]), y1: Math.max(a[1], b[1]) };
  }
  const validBox = box => !!box && [box.x0, box.x1, box.y0, box.y1].every(finite) && box.x1 > box.x0 && box.y1 > box.y0;
  // Step n (0 … 3) of Quadrant Zoom on one image: { name, box } — half the box across and half down, as QUADRANT_PLAN
  // says; box: the breast region (or the whole image). Null for an image that cannot be named.
  function quadrant(step, cell, box) {
    if (!Number.isInteger(step) || unlinkable(cell)) return null;
    const whole = { x0: 0, y0: 0, x1: cell.columns, y1: cell.rows };
    const s = standardBox(validBox(box) ? box : whole, cell);
    const q = ((step % 4) + 4) % 4, plan = QUADRANT_PLAN[family(cell.view)][q];
    const um = (s.u0 + s.u1) / 2, wm = (s.w0 + s.w1) / 2;
    // The chest wall is at the standard right for the right breast, at the left for the left breast.
    const right = plan.chest === (cell.side === 'R');
    const part = { u0: right ? um : s.u0, u1: right ? s.u1 : um, w0: plan.top ? s.w0 : wm, w1: plan.top ? wm : s.w1 };
    return { step: q, name: QUADRANTS[q], box: imageBox(part, cell) };
  }

  // ── The breast region ──
  // The side of the stored image the chest wall is at ('left' | 'right'), from the image's own header: the standard
  // display has the right breast's chest wall at the screen right and the left breast's at the screen left, and flipH says
  // the stored columns run the other way. Null without a known side, view and verified stored orientation. A flip or a
  // rotation the reader put on the cell, and the cell's place on the screen, play no part.
  function chestWall(cell) {
    return unlinkable(cell) ? null : (cell.side === 'R') !== cell.flipH ? 'right' : 'left';
  }
  // The breast region of one image: the tissue that stands against the chest wall, out to the skin line. What is not the
  // breast is decided by where it is, not by how bright it is:
  // - Air is at the border opposite the chest wall, and it is flat: a device stores it as one value, where tissue has
  //   its grain. The stretch of that border where every pixel is within a thousandth of the image's range (the darkest
  //   border value to the 95th percentile of the grid) of the darkest is air, when it is an eighth of the border or
  //   more; the values found there, and as much again above them, are the air's values. Air is every grid cell wholly
  //   within those values that is reached from that border through such cells (4-connected). A cell with one brighter
  //   pixel is not air, so fat is never air, and a nipple at or near the border stays tissue.
  // - Pixel padding (options.padding: { low, high }, both ends counted, in the values' own space) is no pixel of the
  //   image: it is neither air nor tissue, the search passes through it, and behind a band of it the border is the first
  //   cell with a pixel.
  // - The breast is the largest piece of what is left (4-connected) that reaches the chest-wall border. Where that piece
  //   runs on along the chest wall as a thin strip (a body or paddle edge, the abdomen under an oblique view), the strip
  //   is not the breast: the rows at either end whose tissue reaches no farther from the chest wall than an eighth of the
  //   piece's greatest reach (or a twenty-fifth of the image's width) are left out when that run of rows is at least four
  //   times as long as its median reach (the breast's own rounded end is not). Nothing is cut on the nipple side.
  // - Holes in it are part of it.
  // No region ({ found: false, reason }) rather than a doubtful one: without the chest-wall side ('chest-wall-unknown'),
  // for a magnification, spot or partial view (options.partial: 'partial-view'), without clear air over a twentieth of
  // the image ('no-air': tissue fills it, or its background is not flat), with tissue that does not reach the chest wall
  // ('not-at-chest-wall': an unexplained band between them), with only strips ('no-region').
  // values: the image's pixel values, row after row (columns × rows); MONOCHROME1 shows low values bright, so
  // options.monochrome1 reads them the other way round. Searched on a grid of at most maxSide cells a side; the box and
  // the outline are then taken from the pixels themselves. Returns { found, step, width, height, mask, box, outline,
  // chest, air, monochrome1, padding }: mask on the grid; box and outline (one point at each end of every grid row of the
  // region, down the left and back up the right) in image coordinates; air: the top of the air's values in the image's
  // own values (the bottom for MONOCHROME1), null when all that is not the breast is padding.
  function detect(values, columns, rows, options = {}) {
    const none = reason => ({ found: false, reason });
    if (!values || typeof values.length !== 'number' || !Number.isSafeInteger(columns) || !Number.isSafeInteger(rows) || columns < 2 || rows < 2
      || values.length < columns * rows) return none('no-pixels');
    if (options.partial) return none('partial-view');
    if (options.chest !== 'left' && options.chest !== 'right') return none('chest-wall-unknown');
    const chestRight = options.chest === 'right', sign = options.monochrome1 ? -1 : 1;
    const padLow = Number(options.padding?.low), padHigh = Number(options.padding?.high), padded = finite(padLow) && finite(padHigh) && padHigh >= padLow;
    const maxSide = Number.isSafeInteger(options.maxSide) && options.maxSide >= 16 ? options.maxSide : 256;
    const step = Math.max(1, Math.ceil(Math.max(columns, rows) / maxSide));
    const width = Math.ceil(columns / step), height = Math.ceil(rows / step), size = width * height;
    // Each grid cell: how many pixels of the image it holds, and their mean, lowest and highest (dark = air).
    const count = new Uint32Array(size), mean = new Float64Array(size), low = new Float64Array(size).fill(Infinity), high = new Float64Array(size).fill(-Infinity);
    const column = new Int32Array(columns);
    for (let x = 0; x < columns; x++) column[x] = Math.floor(x / step);
    for (let y = 0; y < rows; y++) {
      const row = Math.floor(y / step) * width, base = y * columns;
      for (let x = 0; x < columns; x++) {
        const value = +values[base + x];
        if (value !== value || value === Infinity || value === -Infinity || (padded && value >= padLow && value <= padHigh)) continue;
        const at = row + column[x], dark = sign * value;
        mean[at] += dark; count[at]++;
        if (dark < low[at]) low[at] = dark; if (dark > high[at]) high[at] = dark;
      }
    }
    const means = [];
    for (let i = 0; i < size; i++) if (count[i]) { mean[i] /= count[i]; means.push(mean[i]); }
    if (!means.length) return none('no-pixels');
    // The border on each side: every grid row's first cell with a pixel, from the nipple side and from the chest wall.
    const nippleX = chestRight ? 0 : width - 1, chestX = width - 1 - nippleX, inward = chestRight ? 1 : -1;
    const nippleBorder = [], chestBorder = new Int32Array(height).fill(-1);
    for (let gy = 0; gy < height; gy++) {
      for (let n = 0, gx = nippleX; n < width; n++, gx += inward) if (count[gy * width + gx]) { nippleBorder.push(gy * width + gx); break; }
      for (let n = 0, gx = chestX; n < width; n++, gx -= inward) if (count[gy * width + gx]) { chestBorder[gy] = gx; break; }
    }
    // The air's values, from the flat dark stretch of the nipple-side border.
    let floor = Infinity;
    for (const at of nippleBorder) if (mean[at] < floor) floor = mean[at];
    means.sort((a, b) => a - b);
    const flat = Math.max(0, 0.001 * (means[Math.floor(0.95 * (means.length - 1))] - floor));
    const stretch = nippleBorder.filter(at => high[at] - floor <= flat && floor - low[at] <= flat);
    let air = -Infinity;
    if (stretch.length && stretch.length * 8 >= nippleBorder.length) {
      for (const at of stretch) if (high[at] > air) air = high[at];
      air += air - floor;
    }
    // Outside the breast: padding and air, reached from the nipple-side border.
    const outside = new Uint8Array(size), queue = new Int32Array(size);
    let tail = 0;
    const reach = at => { if (!outside[at] && (!count[at] || high[at] <= air)) { outside[at] = 1; queue[tail++] = at; } };
    for (let gy = 0; gy < height; gy++) reach(gy * width + nippleX);
    for (let head = 0; head < tail; head++) {
      const at = queue[head], x = at % width;
      if (x > 0) reach(at - 1); if (x < width - 1) reach(at + 1); if (at >= width) reach(at - width); if (at + width < size) reach(at + width);
    }
    if (tail * 20 < size) return none('no-air');
    // The pieces of tissue; the largest that reaches the chest-wall border.
    const label = new Int32Array(size);
    let body = 0, bodySize = 0, pieces = 0;
    for (let start = 0; start < size; start++) {
      if (!count[start] || outside[start] || label[start]) continue;
      pieces++; let head = 0, end = 0, atChest = false; queue[end++] = start; label[start] = pieces;
      while (head < end) {
        const at = queue[head++], x = at % width;
        if (chestBorder[(at - x) / width] === x) atChest = true;
        for (const near of [x > 0 ? at - 1 : -1, x < width - 1 ? at + 1 : -1, at - width, at + width]) {
          if (near < 0 || near >= size || !count[near] || outside[near] || label[near]) continue;
          label[near] = pieces; queue[end++] = near;
        }
      }
      if (atChest && end > bodySize) { bodySize = end; body = pieces; }
    }
    if (!body) return none(pieces ? 'not-at-chest-wall' : 'no-region');
    // Thin strips along the chest wall at either end are not the breast.
    const farthest = new Float64Array(height);
    let widest = 0, top = -1, bottom = -1;
    for (let gy = 0; gy < height; gy++) {
      for (let gx = 0; gx < width; gx++) if (label[gy * width + gx] === body) farthest[gy] = Math.max(farthest[gy], Math.abs(gx - chestBorder[gy]) + 1);
      if (!farthest[gy]) continue;
      if (top < 0) top = gy; bottom = gy; widest = Math.max(widest, farthest[gy]);
    }
    const thin = Math.max(widest / 8, width / 25);
    const strip = (from, by) => {
      const run = [];
      for (let gy = from; gy >= top && gy <= bottom && farthest[gy] <= thin; gy += by) run.push(gy);
      const reaches = run.map(gy => farthest[gy]).sort((a, b) => a - b);
      if (!run.length || run.length < 4 * reaches[Math.floor(reaches.length / 2)]) return;
      for (const gy of run) for (let gx = 0; gx < width; gx++) if (label[gy * width + gx] === body) { label[gy * width + gx] = 0; bodySize--; }
    };
    strip(top, 1); strip(bottom, -1);
    if (bodySize < size * 0.02) return none('no-region');
    // Holes: cells outside the region that the image border cannot be reached from (4-connected) are inside it.
    const beyond = new Uint8Array(size);
    {
      let end = 0;
      const seed = at => { if (label[at] !== body && !beyond[at]) { beyond[at] = 1; queue[end++] = at; } };
      for (let gx = 0; gx < width; gx++) { seed(gx); seed((height - 1) * width + gx); }
      for (let gy = 0; gy < height; gy++) { seed(gy * width); seed(gy * width + width - 1); }
      for (let head = 0; head < end; head++) {
        const at = queue[head], x = at % width;
        if (x > 0) seed(at - 1); if (x < width - 1) seed(at + 1); if (at >= width) seed(at - width); if (at + width < size) seed(at + width);
      }
    }
    // The box and the outline end on the region's own outermost tissue pixels, not on the grid.
    const mask = new Uint8Array(size);
    const tissue = (x, y) => {
      const value = +values[y * columns + x];
      return value === value && value !== Infinity && value !== -Infinity && !(padded && value >= padLow && value <= padHigh) && sign * value > air;
    };
    const left = [], right = [], held = [];
    let x0 = Infinity, x1 = -Infinity;
    for (let gy = 0; gy < height; gy++) {
      let first = -1, last = -1;
      for (let gx = 0; gx < width; gx++) if (!beyond[gy * width + gx]) { mask[gy * width + gx] = 1; if (first < 0) first = gx; last = gx; }
      if (first < 0) continue;
      const ya = gy * step, yb = Math.min(rows, ya + step);
      const any = x => { for (let y = ya; y < yb; y++) if (tissue(x, y)) return true; return false; };
      const xa = first * step, xb = Math.min(columns, (last + 1) * step);
      let a = xa, b = xb;
      for (let x = xa; x < Math.min(columns, xa + step); x++) if (any(x)) { a = x; break; }
      for (let x = xb - 1; x >= last * step; x--) if (any(x)) { b = x + 1; break; }
      if (a < x0) x0 = a; if (b > x1) x1 = b;
      left.push([a, Math.min(rows, (gy + 0.5) * step)]); right.push([b, Math.min(rows, (gy + 0.5) * step)]);
      held.push([gy, first, last]);
    }
    // The first and the last pixel row with tissue in the region's top and bottom grid rows.
    const edge = ([gy, first, last], down) => {
      const ya = gy * step, yb = Math.min(rows, ya + step), xa = first * step, xb = Math.min(columns, (last + 1) * step);
      for (let n = 0; n < yb - ya; n++) {
        const y = down ? ya + n : yb - 1 - n;
        for (let x = xa; x < xb; x++) if (mask[gy * width + column[x]] && tissue(x, y)) return down ? y : y + 1;
      }
      return down ? ya : yb;
    };
    return { found: true, step, width, height, mask, chest: options.chest, air: air === -Infinity ? null : sign * air, monochrome1: !!options.monochrome1,
      padding: padded ? { low: padLow, high: padHigh } : null,
      box: { x0, y0: edge(held[0], true), x1, y1: edge(held[held.length - 1], false) },
      outline: [...left, ...right.reverse()] };
  }
  // The window of the breast's pixels only: the low and high percentiles (default 1 and 99) of every pixel of the image
  // that is in the region and is itself tissue (the air and the padding in a cell on the skin line do not count).
  // { lower, upper } or null.
  function regionWindow(values, columns, rows, region, options = {}) {
    if (!region?.found || !values || values.length < columns * rows) return null;
    const lowP = finite(options.low) ? options.low : 0.01, highP = finite(options.high) ? options.high : 0.99;
    const { step, width, mask, padding } = region;
    let low = Infinity, high = -Infinity, count = 0;
    const beyondAir = !finite(region.air) ? () => true : region.monochrome1 ? v => v < region.air : v => v > region.air;
    const tissue = v => finite(v) && !(padding && v >= padding.low && v <= padding.high) && beyondAir(v);
    const inside = (x, y) => mask[Math.floor(y / step) * width + Math.floor(x / step)] === 1;
    for (let y = 0; y < rows; y++) for (let x = 0; x < columns; x++) {
      if (!inside(x, y)) continue;
      const value = Number(values[y * columns + x]);
      if (!tissue(value)) continue;
      if (value < low) low = value; if (value > high) high = value; count++;
    }
    if (!count) return null;
    if (high === low) return { lower: low - 0.5, upper: high + 0.5 };
    const integer = Number.isInteger(low) && Number.isInteger(high);
    const bins = integer && high - low < 65536 ? high - low + 1 : 65536, scale = (bins - 1) / (high - low);
    const histogram = new Float64Array(bins);
    for (let y = 0; y < rows; y++) for (let x = 0; x < columns; x++) {
      if (!inside(x, y)) continue;
      const value = Number(values[y * columns + x]);
      if (tissue(value)) histogram[Math.round((value - low) * scale)]++;
    }
    const at = fraction => {
      const wanted = fraction * (count - 1);
      let seen = 0;
      for (let i = 0; i < bins; i++) { seen += histogram[i]; if (seen > wanted) return low + i / scale; }
      return high;
    };
    const lower = at(lowP), upper = at(highP);
    return upper > lower ? { lower, upper } : { lower: lower - 0.5, upper: lower + 0.5 };
  }

  // ── Zoom of each Breast Display mode, relative to the cell's zoom now (1 = Fit) ──
  // perPixel: screen (CSS) pixels one image pixel spans now; dpr: device pixels per CSS pixel.
  // A rectangle of the image (w × h image pixels) filling a cell of cellWidth × cellHeight CSS pixels (margin < 1 leaves room).
  function fitRect({ zoom, perPixel, cellWidth, cellHeight, width, height, margin = 0.98 }) {
    if (![zoom, perPixel, cellWidth, cellHeight, width, height, margin].every(positive)) return null;
    return zoom * Math.min(cellWidth / width, cellHeight / height) * margin / perPixel;
  }
  // The zoom of a Quadrant Zoom step (quadrant: its box's width × height in image pixels): '4x' is four times Fit (the
  // same scale as Display › Zoom 400 %), whatever the cell; 'fill' fills the cell with the quadrant. clipped: at 4× the
  // quadrant is larger than the cell, so its edges are outside it. Null for another mode or a missing measure.
  const QUADRANT_ZOOMS = ['4x', 'fill'];
  function quadrantZoom({ mode, ...measures }) {
    const fill = fitRect(measures);
    if (mode === 'fill') return fill ? { zoom: fill, clipped: false } : null;
    if (mode !== '4x') return null;
    const whole = fitRect({ ...measures, margin: 1 });
    return { zoom: 4, clipped: !!whole && whole < 4 - 1e-9 };
  }
  // One image pixel on one device pixel of the screen.
  function onePixel({ zoom, perPixel, dpr }) {
    if (![zoom, perPixel, dpr].every(positive)) return null;
    return zoom * (1 / dpr) / perPixel;
  }
  // One millimetre of the image (at the spacing given) on one millimetre of the screen: pitch is the monitor's millimetres
  // per device pixel, so one CSS pixel is pitch × dpr millimetres (the browser's own zoom is in dpr).
  function trueSize({ zoom, perPixel, spacing, pitch, dpr }) {
    if (![zoom, perPixel, spacing, pitch, dpr].every(positive)) return null;
    return zoom * (spacing / (pitch * dpr)) / perPixel;
  }
  // Match Size: the cells of one view show the breast's chest-wall-to-nipple length (length: image pixels across the
  // breast box) at the same screen length — the longest at which every breast is still whole in its cell (fit: the zoom
  // that fits that cell's breast box in it, as Fit Breast). A cell without all of zoom, perPixel, length and fit takes no
  // part (it is not matched and sets no length). cells: [{ id, zoom, perPixel, length, fit }] → { [id]: zoom }.
  function matchSize(cells) {
    const usable = (Array.isArray(cells) ? cells : []).filter(cell => [cell?.zoom, cell?.perPixel, cell?.length, cell?.fit].every(positive));
    if (!usable.length) return {};
    const shown = usable.map(cell => cell.length * cell.perPixel);
    const target = Math.min(...usable.map((cell, i) => shown[i] * cell.fit / cell.zoom));
    return Object.fromEntries(usable.map((cell, i) => [cell.id, cell.zoom * target / shown[i]]));
  }
  // The basis of an image's spacing (mg-length.js): the True Size label.
  function trueSizeLabel(basis) {
    return { detector: 'True Size (at detector)', ermf: 'True Size (ERMF estimate)' }[basis] || 'True Size';
  }
  // The monitor a window stands on, as a key for its pixel pitch (the browser does not name its screens).
  // A key of the screen arrangement now, not a lasting monitor id: without the screen's place there is no key, and a
  // value is then not reused.
  function monitorKey(screen) {
    if (!screen || !positive(screen.width) || !positive(screen.height) || !finite(screen.availLeft) || !finite(screen.availTop)) return null;
    return Math.round(screen.width) + 'x' + Math.round(screen.height) + '@' + Math.round(screen.availLeft) + ',' + Math.round(screen.availTop);
  }
  const validPitch = value => positive(value) && value >= 0.05 && value <= 1;

  // ── DBT slab ──
  // The slices of a slab of `count` around `center` in a stack of `total`: an even count takes one more after the centre
  // (4 = −1 … +2); at an end only the slices there are. { first, last, count (taken), requested }.
  function slabRange(center, count, total) {
    if (![center, count, total].every(Number.isSafeInteger) || total < 1 || count < 1 || center < 0 || center >= total) return null;
    const before = Math.floor((count - 1) / 2), after = count - 1 - before;
    const first = Math.max(0, center - before), last = Math.min(total - 1, center + after);
    return { first, last, count: last - first + 1, requested: count };
  }
  // Slices that can be averaged: the same grid (rows, columns, in-plane direction, pixel spacing and the same place in the
  // plane — the position may differ only along the stack) and the same stored-to-shown value conversion.
  // images: [{ rows, columns, slope, intercept, scaled, rowCosines, columnCosines, spacing: [row, column], position }].
  function slabCompatible(images) {
    if (!Array.isArray(images) || !images.length) return false;
    const a = images[0], same = (x, y) => (x ?? null) === (y ?? null);
    const near = (x, y) => Array.isArray(x) && Array.isArray(y) && x.length === y.length && x.every((n, i) => finite(n) && Math.abs(n - y[i]) <= 1e-4);
    const dot = (x, y) => x.reduce((s, n, i) => s + n * y[i], 0);
    // The offset between two slices has no part along the rows or the columns (a hundredth of a pixel at most).
    const aligned = b => {
      if (b.position == null && a.position == null) return true;
      if (!Array.isArray(b.position) || !Array.isArray(a.position) || b.position.length !== 3 || a.position.length !== 3
        || !Array.isArray(a.rowCosines) || !Array.isArray(a.columnCosines) || !Array.isArray(a.spacing)) return false;
      const d = b.position.map((n, i) => n - a.position[i]);
      if (!d.every(finite)) return false;
      return Math.abs(dot(d, a.rowCosines)) <= 0.01 * a.spacing[1] && Math.abs(dot(d, a.columnCosines)) <= 0.01 * a.spacing[0];
    };
    const plane = b => (b.rowCosines == null && a.rowCosines == null || near(b.rowCosines, a.rowCosines))
      && (b.columnCosines == null && a.columnCosines == null || near(b.columnCosines, a.columnCosines))
      && (b.spacing == null && a.spacing == null || near(b.spacing, a.spacing)) && aligned(b);
    return images.every(b => b && b.rows === a.rows && b.columns === a.columns && Number.isSafeInteger(b.rows) && Number.isSafeInteger(b.columns)
      && same(b.slope, a.slope) && same(b.intercept, a.intercept) && same(b.scaled, a.scaled) && plane(b));
  }
  // The mean of the slices' pixel arrays into `out` (rounded for an integer array). True when written.
  function slabAverage(arrays, out) {
    if (!Array.isArray(arrays) || !arrays.length || !out || arrays.some(a => !a || a.length !== out.length)) return false;
    const n = arrays.length, integer = !(out instanceof Float32Array || out instanceof Float64Array);
    for (let i = 0; i < out.length; i++) {
      let sum = 0;
      for (let k = 0; k < n; k++) sum += arrays[k][i];
      out[i] = integer ? Math.round(sum / n) : sum / n;
    }
    return true;
  }
  const slabLabel = range => !range ? '' : range.count === range.requested ? 'Slab ' + range.count : 'Slab ' + range.count + ' of ' + range.requested;

  // The tab after the current one, from the end back to the first; null with one tab or none.
  function nextTab(count, current) {
    if (!Number.isSafeInteger(count) || count < 2 || !Number.isSafeInteger(current) || current < 0 || current >= count) return null;
    return (current + 1) % count;
  }

  const api = { QUADRANTS: QUADRANTS.slice(), family, unlinkable, toStandard, fromStandard, counterpart, targets, quadrant,
    chestWall, detect, regionWindow, fitRect, QUADRANT_ZOOMS: QUADRANT_ZOOMS.slice(), quadrantZoom, onePixel, trueSize, matchSize, trueSizeLabel, monitorKey, validPitch,
    slabRange, slabCompatible, slabAverage, slabLabel, nextTab };
  if (typeof module === 'object' && module.exports) module.exports = api; else root.KinMgBreastModel = api;
})(globalThis);
