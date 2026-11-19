// Pure MG menu calculations (worklist-v0/hpacs-lite/mg-breast-model.js): the counterpart of a point on the opposite
// breast and the prior of the same view, the four quadrants of a view, the breast region and its window, the zoom of
// Fit Breast, 1:1, True Size and Match Size, the DBT slab and the next patient tab. Synthetic values only.
// node --test tests/mg_breast_model_test.cjs
const test = require('node:test');
const assert = require('node:assert/strict');
const M = require('../worklist-v0/hpacs-lite/mg-breast-model.js');

// Standard display flips as mammography-model.js decides them; 1000 × 800 images (columns × rows).
const cell = (id, side, view, flipH = false, flipV = false, extra = {}) =>
  ({ id, side, view, verified: true, flipH, flipV, columns: 1000, rows: 800, ...extra });
const close = (actual, expected, digits = 6) => {
  assert.equal(actual.length, expected.length);
  actual.forEach((n, i) => assert.ok(Math.abs(n - expected[i]) < 10 ** -digits, `${actual} ≈ ${expected}`));
};

test('counterpart: the opposite breast is mirrored across, the prior of the same side is the same place', () => {
  const rcc = cell('rcc', 'R', 'CC'), lcc = cell('lcc', 'L', 'CC'), priorRcc = cell('prcc', 'R', 'CC');
  close(M.counterpart([200, 100], rcc, lcc), [800, 100]);
  close(M.counterpart([200, 100], rcc, priorRcc), [200, 100]);
  // Stored flipped across (shown with flipH): the same standard place is the other stored column.
  const lccStoredFlipped = cell('lcc2', 'L', 'CC', true);
  close(M.counterpart([200, 100], rcc, lccStoredFlipped), [200, 100]);
  // Stored upside down (flipV): the standard place moves down the stored rows.
  close(M.counterpart([200, 100], rcc, cell('x', 'L', 'CC', false, true)), [800, 700]);
  // A smaller prior image: the same fraction of its own size.
  close(M.counterpart([200, 100], rcc, cell('p', 'L', 'CC', false, false, { columns: 500, rows: 400 })), [400, 50]);
});

test('counterpart: never across views, never with an unverified, unknown-side or unknown-view image', () => {
  const rcc = cell('rcc', 'R', 'CC');
  assert.equal(M.counterpart([1, 1], rcc, cell('rmlo', 'R', 'MLO')), null);
  assert.equal(M.counterpart([1, 1], rcc, cell('u', 'L', 'CC', false, false, { verified: false })), null);
  assert.equal(M.counterpart([1, 1], rcc, cell('b', 'B', 'CC')), null);
  assert.equal(M.counterpart([1, 1], cell('v', 'R', 'SPOT'), cell('w', 'L', 'SPOT')), null);
  assert.equal(M.unlinkable(cell('u', 'L', 'CC', false, false, { verified: false })), 'orientation-unverified');
  assert.equal(M.unlinkable(cell('b', 'B', 'CC')), 'laterality-unknown');
  assert.equal(M.unlinkable(cell('v', 'R', 'SPOT')), 'view-unknown');
});

test('targets: every other cell of the same view, with the reason a cell of that view is left out', () => {
  const cells = [cell('rcc', 'R', 'CC'), cell('lcc', 'L', 'CC'), cell('rmlo', 'R', 'MLO'), cell('lmlo', 'L', 'MLO'),
    cell('prcc', 'R', 'CC'), cell('plcc', 'L', 'CC', false, false, { verified: false }), cell('prmlo', 'R', 'MLO'), cell('plmlo', 'L', 'MLO')];
  const r = M.targets('rcc', cells);
  assert.deepEqual(r.linked, ['lcc', 'prcc']);
  assert.deepEqual(r.skipped, [{ id: 'plcc', reason: 'orientation-unverified' }]);
  assert.equal(r.reason, null);
  assert.equal(M.targets('plcc', cells).reason, 'orientation-unverified');
  assert.deepEqual(M.targets('lmlo', cells).linked, ['rmlo', 'prmlo', 'plmlo']);
});

test('quadrant: CC goes outer-chest, inner-chest, inner-nipple, outer-nipple; R and L are mirrored', () => {
  const box = { x0: 0, y0: 0, x1: 1000, y1: 800 };
  const rcc = cell('rcc', 'R', 'CC'), lcc = cell('lcc', 'L', 'CC');
  const steps = [0, 1, 2, 3].map(step => M.quadrant(step, rcc, box));
  assert.deepEqual(steps.map(q => q.name), ['Upper-Outer', 'Upper-Inner', 'Lower-Inner', 'Lower-Outer']);
  // Right breast: chest wall at the right half.
  assert.deepEqual(steps.map(q => q.box), [{ x0: 500, x1: 1000, y0: 0, y1: 400 }, { x0: 500, x1: 1000, y0: 400, y1: 800 },
    { x0: 0, x1: 500, y0: 400, y1: 800 }, { x0: 0, x1: 500, y0: 0, y1: 400 }]);
  // Left breast: the same step is the mirrored half.
  assert.deepEqual(M.quadrant(0, lcc, box).box, { x0: 0, x1: 500, y0: 0, y1: 400 });
  // Four distinct parts in every view.
  for (const c of [rcc, lcc, cell('rmlo', 'R', 'MLO'), cell('lmlo', 'L', 'MLO')])
    assert.equal(new Set([0, 1, 2, 3].map(step => JSON.stringify(M.quadrant(step, c, box).box))).size, 4);
  // Step 5 is step 1 again; step −1 is step 4.
  assert.equal(M.quadrant(5, rcc, box).name, 'Upper-Inner');
  assert.equal(M.quadrant(-1, rcc, box).name, 'Lower-Outer');
});

test('quadrant: MLO goes upper-chest, upper-nipple, lower-nipple, lower-chest; stored flips and the breast box count', () => {
  const rmlo = cell('rmlo', 'R', 'MLO');
  const box = { x0: 200, y0: 100, x1: 1000, y1: 700 };
  assert.deepEqual([0, 1, 2, 3].map(step => M.quadrant(step, rmlo, box).box), [
    { x0: 600, x1: 1000, y0: 100, y1: 400 }, { x0: 200, x1: 600, y0: 100, y1: 400 },
    { x0: 200, x1: 600, y0: 400, y1: 700 }, { x0: 600, x1: 1000, y0: 400, y1: 700 }]);
  // Stored flipped across: the standard right half is the stored left half.
  assert.deepEqual(M.quadrant(0, cell('f', 'R', 'MLO', true), { x0: 0, y0: 0, x1: 1000, y1: 800 }).box, { x0: 0, x1: 500, y0: 0, y1: 400 });
  // No box: the whole image.
  assert.deepEqual(M.quadrant(0, rmlo, null).box, { x0: 500, x1: 1000, y0: 0, y1: 400 });
  assert.equal(M.quadrant(0, cell('u', 'R', 'MLO', false, false, { verified: false }), null), null);
});

test('chest wall: the stored side from the breast side and the stored left-right flip; none without a verified orientation', () => {
  assert.equal(M.chestWall(cell('a', 'R', 'CC')), 'right');
  assert.equal(M.chestWall(cell('a', 'L', 'CC')), 'left');
  // Stored the other way round (the standard display flips it across): the chest wall is at the other stored side.
  assert.equal(M.chestWall(cell('a', 'R', 'MLO', true)), 'left');
  assert.equal(M.chestWall(cell('a', 'L', 'MLO', true)), 'right');
  // A stored up-down flip changes nothing.
  assert.equal(M.chestWall(cell('a', 'L', 'CC', false, true)), 'left');
  for (const unknown of [cell('u', 'L', 'CC', false, false, { verified: false }), cell('b', 'B', 'CC'), cell('v', 'R', 'SPOT'),
    cell('n', 'R', 'CC', false, false, { flipH: undefined }), null]) assert.equal(M.chestWall(unknown), null);
});

// A synthetic MG: dark background (40) and a bright half-ellipse (1000 + gradient) against the chest wall, with a small
// bright marker (3000) apart from it, in the corner at the nipple side, that is not the breast.
function phantom(columns, rows, { chestRight = true, monochrome1 = false } = {}) {
  const values = new Uint16Array(columns * rows);
  for (let y = 0; y < rows; y++) for (let x = 0; x < columns; x++) {
    const cx = chestRight ? columns : 0, dx = (x - cx) / (columns * 0.6), dy = (y - rows / 2) / (rows * 0.4);
    let v = dx * dx + dy * dy <= 1 ? 1000 + (y % 50) : 40;
    if ((chestRight ? x < 30 : x >= columns - 30) && y < 30) v = 3000;
    values[y * columns + x] = monochrome1 ? 4095 - v : v;
  }
  return values;
}
const within = (actual, expected, by, what) => assert.ok(Math.abs(actual - expected) <= by, `${what}: ${actual} is not within ${by} of ${expected}`);

test('detect: the tissue against the chest wall out to its own outermost pixels, not the marker; MONOCHROME1 air is bright', () => {
  const columns = 400, rows = 300, values = phantom(columns, rows);
  const r = M.detect(values, columns, rows, { chest: 'right', maxSide: 100 });
  assert.equal(r.found, true);
  assert.equal(r.step, 4);
  // The ellipse as it was made: x 160 … 400, y 30 … 270 (the grid is 4 px; the box is the pixels').
  within(r.box.x0, 160, 1, 'nipple end'); assert.equal(r.box.x1, 400);
  within(r.box.y0, 30, 1, 'top'); within(r.box.y1, 270, 1, 'bottom');
  assert.ok(r.outline.length > 20 && r.outline.every(([x, y]) => x >= 0 && x <= columns && y >= 0 && y <= rows));
  // The same breast stored the other way round: the chest wall at the left.
  const l = M.detect(phantom(columns, rows, { chestRight: false }), columns, rows, { chest: 'left', maxSide: 100 });
  assert.equal(l.box.x0, 0); within(l.box.x1, 240, 1, 'nipple end'); within(l.box.y0, 30, 1, 'top'); within(l.box.y1, 270, 1, 'bottom');
  const m1 = M.detect(phantom(columns, rows, { monochrome1: true }), columns, rows, { chest: 'right', maxSide: 100, monochrome1: true });
  assert.deepEqual(m1.box, r.box);
  // Read as MONOCHROME2, the inverted image has no dark air at the nipple-side border: no region, not the wrong one.
  assert.equal(M.detect(phantom(columns, rows, { monochrome1: true }), columns, rows, { chest: 'right', maxSide: 100 }).found, false);
  // Told the wrong side, the tissue is not against that chest wall: no region.
  assert.equal(M.detect(values, columns, rows, { chest: 'left', maxSide: 100 }).found, false);
  assert.equal(M.detect(new Uint16Array(columns * rows).fill(7), columns, rows, { chest: 'right' }).found, false);
  assert.deepEqual(M.detect(null, columns, rows, { chest: 'right' }), { found: false, reason: 'no-pixels' });
});

// As a processed screening MG is stored: background 0, a band of fat (20 ± 6) just inside the skin round the breast, dense
// tissue (150) only in the middle, and a body edge 12 px wide along the chest-wall border below the breast.
function fattyPhantom(columns, rows, { chestRight = true, monochrome1 = false } = {}) {
  const values = new Uint16Array(columns * rows);
  for (let y = 0; y < rows; y++) for (let x = 0; x < columns; x++) {
    const cx = chestRight ? columns : 0, dx = (x - cx) / (columns * 0.6), dy = (y - rows * 0.4) / (rows * 0.35), r = dx * dx + dy * dy;
    let v = r <= 1 ? (r <= 0.35 ? 150 : 20 + ((x * 7 + y * 13) % 13) - 6) : 0;
    const strip = chestRight ? x >= columns - 12 : x < 12;
    if (strip && y > rows * 0.75) v = 25;
    values[y * columns + x] = monochrome1 ? 255 - v : v;
  }
  return values;
}
const side = chestRight => chestRight ? 'right' : 'left';

test('detect: the region reaches the skin line through the fat, not only the dense tissue, and leaves a strip along the chest wall out', () => {
  const columns = 600, rows = 800;
  for (const chestRight of [true, false]) for (const monochrome1 of [false, true]) {
    const r = M.detect(fattyPhantom(columns, rows, { chestRight, monochrome1 }), columns, rows, { chest: side(chestRight), monochrome1 });
    assert.equal(r.found, true);
    // The skin line as it was made: the ellipse spans 360 px from the chest wall (0.6 × 600) and y 40 … 600
    // (0.4 × 800 ± 0.35 × 800); the strip under it (y 600 … 800) is not in the box.
    const [near, far] = chestRight ? [r.box.x1, r.box.x0] : [r.box.x0, r.box.x1];
    assert.equal(near, chestRight ? columns : 0, JSON.stringify(r.box));
    within(Math.abs(near - far), 360, 1, 'chest wall to skin');
    within(r.box.y0, 40, 1, 'top'); within(r.box.y1, 600, 4, 'bottom');
    // Every outline point is on the skin line or on the chest-wall border.
    for (const [x, y] of r.outline) {
      const dx = (x - (chestRight ? columns : 0)) / 360, dy = (y - 320) / 280, edge = Math.abs(Math.hypot(dx, dy) - 1);
      assert.ok(edge < 0.03 || x === 0 || x === columns, `${x},${y} ${edge}`);
    }
  }
  // A burned-in label far brighter than any tissue (4095, 160 × 80 px, apart from the breast) changes nothing.
  const labelled = fattyPhantom(columns, rows);
  for (let y = 700; y < 780; y++) for (let x = 20; x < 180; x++) labelled[y * columns + x] = 4095;
  assert.deepEqual(M.detect(labelled, columns, rows, { chest: 'right' }).box, M.detect(fattyPhantom(columns, rows), columns, rows, { chest: 'right' }).box);
  // Nor does one that stands on the nipple-side border itself.
  for (let y = 700; y < 780; y++) for (let x = 0; x < 20; x++) labelled[y * columns + x] = 4095;
  assert.deepEqual(M.detect(labelled, columns, rows, { chest: 'right' }).box, M.detect(fattyPhantom(columns, rows), columns, rows, { chest: 'right' }).box);
  // The window counts the breast's own pixels: the air in a grid cell on the skin line does not pull it down (fat is 14 … 26).
  const plain = fattyPhantom(columns, rows), region = M.detect(plain, columns, rows, { chest: 'right' });
  assert.ok(M.regionWindow(plain, columns, rows, region).lower >= 14, JSON.stringify(M.regionWindow(plain, columns, rows, region)));
  const m1 = fattyPhantom(columns, rows, { monochrome1: true }), r1 = M.detect(m1, columns, rows, { chest: 'right', monochrome1: true });
  assert.ok(M.regionWindow(m1, columns, rows, r1).upper <= 255 - 14, JSON.stringify(M.regionWindow(m1, columns, rows, r1)));
});

test('detect: much dense tissue, even fat of one value, and a nipple at the image border all keep the skin line', () => {
  const columns = 600, rows = 800;
  // Air 20 %, fat 40 %, dense 40 % of the image (air x < 120, the chest wall at the right), the fat with a grain and
  // then of one value (0 / 20 / 150): the edge is the skin line at x 120, not the dense part at 360, and the window is
  // the fat's and the dense tissue's together.
  for (const grain of [true, false]) {
    const dense = new Uint16Array(columns * rows);
    for (let y = 0; y < rows; y++) for (let x = 0; x < columns; x++)
      dense[y * columns + x] = x < 120 ? 0 : x < 360 ? 20 + (grain ? ((x * 7 + y * 13) % 13) - 6 : 0) : 150;
    const r = M.detect(dense, columns, rows, { chest: 'right' });
    assert.deepEqual(r.box, { x0: 120, y0: 0, x1: 600, y1: 800 }, 'grain ' + grain);
    const w = M.regionWindow(dense, columns, rows, r);
    assert.ok(w.lower >= 14 && w.lower <= 20 && w.upper === 150, JSON.stringify(w));
  }
  // The nipple in profile (24 px wide, 70 px out from the skin line) is part of the breast: out in the air, with its
  // tip 8 px from the image border, and touching the border (air above and below it).
  const big = 2000;
  for (const [reach, tip] of [[1100, 840], [1922, 8], [1930, 0]]) {
    const nipple = new Uint16Array(big * big);
    for (let y = 0; y < big; y++) for (let x = 0; x < big; x++) {
      const dx = (x - big) / reach, dy = (y - 1000) / 800;
      nipple[y * big + x] = dx * dx + dy * dy <= 1 || (x >= tip && x < big - reach + 5 && Math.abs(y - 1000) < 12) ? 60 : 0;
    }
    const r = M.detect(nipple, big, big, { chest: 'right' });
    assert.equal(r.found, true, 'tip at ' + tip);
    assert.equal(r.box.x0, tip, JSON.stringify(r.box));
    within(r.box.y0, 200, 1, 'top'); within(r.box.y1, 1800, 1, 'bottom');
  }
});

test('detect: no region rather than a doubtful one; declared padding is no pixel of the image', () => {
  const columns = 600, rows = 800;
  // Only a strip along the chest-wall border (no breast), thin or up to a twelfth of the image wide; a small breast
  // that reaches an eighth of the image's width is one.
  for (const wide of [3, 12, 30, 50]) {
    const strip = new Uint16Array(columns * rows);
    for (let y = 0; y < rows; y++) for (let x = columns - wide; x < columns; x++) strip[y * columns + x] = 30 + (x + y) % 5;
    assert.deepEqual(M.detect(strip, columns, rows, { chest: 'right' }), { found: false, reason: 'no-region' }, 'strip ' + wide);
  }
  const small = new Uint16Array(columns * rows);
  for (let y = 0; y < rows; y++) for (let x = 0; x < columns; x++) small[y * columns + x] = ((x - columns) / 75) ** 2 + ((y - 400) / 200) ** 2 <= 1 ? 30 + (x + y) % 5 : 0;
  // (its pixels: x 525 … 599, and at the chest-wall column y 201 … 599)
  assert.deepEqual(M.detect(small, columns, rows, { chest: 'right' }).box, { x0: 525, y0: 201, x1: 600, y1: 600 });
  // No air and no skin line: tissue fills the image (fat with its grain to the border, dense beyond the middle) —
  // however much brighter the dense tissue is, the grain of the fat is not the flat of air.
  let filled;
  for (const dense of [150, 600, 4000]) {
    filled = new Uint16Array(columns * rows);
    for (let y = 0; y < rows; y++) for (let x = 0; x < columns; x++) filled[y * columns + x] = x < 300 ? 20 + ((x * 7 + y * 11) % 13) - 6 : dense;
    assert.deepEqual(M.detect(filled, columns, rows, { chest: 'right' }), { found: false, reason: 'no-air' }, 'dense ' + dense);
  }
  // Without the chest-wall side (no verified orientation), and for a magnification, spot or partial view.
  const plain = fattyPhantom(columns, rows);
  assert.deepEqual(M.detect(plain, columns, rows), { found: false, reason: 'chest-wall-unknown' });
  assert.deepEqual(M.detect(plain, columns, rows, { chest: null }), { found: false, reason: 'chest-wall-unknown' });
  assert.deepEqual(M.detect(plain, columns, rows, { chest: 'right', partial: true }), { found: false, reason: 'partial-view' });
  // A band between the chest-wall border and the tissue (20 px of 0; the air is 10, fat 30 ± 6, dense 160):
  const banded = new Uint16Array(columns * rows);
  for (let y = 0; y < rows; y++) for (let x = 0; x < columns; x++) {
    const dx = (x - (columns - 20)) / 360, dy = (y - 320) / 280, r = dx * dx + dy * dy;
    banded[y * columns + x] = x >= columns - 20 ? 0 : r <= 1 ? (r <= 0.35 ? 160 : 30 + ((x * 7 + y * 13) % 13) - 6) : 10;
  }
  // unexplained, the tissue does not reach the chest wall: no region;
  assert.deepEqual(M.detect(banded, columns, rows, { chest: 'right' }), { found: false, reason: 'not-at-chest-wall' });
  // declared as pixel padding (the value, or a range with both ends counted), the border is where the image's pixels
  // begin, and the breast is found out to its skin line; the window takes no padding.
  for (const padding of [{ low: 0, high: 0 }, { low: 0, high: 5 }]) {
    const r = M.detect(banded, columns, rows, { chest: 'right', padding });
    assert.equal(r.found, true);
    assert.deepEqual([r.box.x0, r.box.x1], [220, 580], JSON.stringify(r.box));
    within(r.box.y0, 40, 1, 'top'); within(r.box.y1, 600, 1, 'bottom');
    assert.ok(M.regionWindow(banded, columns, rows, r).lower >= 24);
  }
  // The background itself declared as padding (as a device that blanks the air stores it): the skin line is where the
  // padding ends.
  const blanked = fattyPhantom(columns, rows);
  const r = M.detect(blanked, columns, rows, { chest: 'right', padding: { low: 0, high: 0 } });
  assert.equal(r.found, true);
  assert.deepEqual([r.box.x0, r.box.x1], [240, 600], JSON.stringify(r.box));
  assert.equal(r.air, null);
  assert.ok(M.regionWindow(blanked, columns, rows, r).lower >= 14);
  // Padding declared but tissue filling what is left: still no air, no region.
  assert.equal(M.detect(filled, columns, rows, { chest: 'right', padding: { low: 4000, high: 4095 } }).found, false);
});

test('regionWindow: 1–99 percentiles of the region pixels only (the background and the marker do not count)', () => {
  const columns = 400, rows = 300, values = phantom(columns, rows);
  const region = M.detect(values, columns, rows, { chest: 'right', maxSide: 100 });
  const w = M.regionWindow(values, columns, rows, region);
  // Region values are 1000 … 1049 (the gradient); no background pixel (40) is counted.
  assert.ok(w.lower >= 1000 && w.lower <= 1001, JSON.stringify(w));
  assert.ok(w.upper >= 1047 && w.upper <= 1049, JSON.stringify(w));
  const narrow = M.regionWindow(values, columns, rows, region, { low: 0.2, high: 0.8 });
  assert.ok(narrow.lower >= 1005 && narrow.upper <= 1045, JSON.stringify(narrow));
  assert.equal(M.regionWindow(values, columns, rows, { found: false }), null);
});

test('Quadrant Zoom: 4x is four times Fit in any cell and says when the quadrant is larger than the cell; fill fills it', () => {
  assert.deepEqual(M.QUADRANT_ZOOMS, ['4x', 'fill']);
  // At Fit one image pixel is 0.125 CSS px: a 1000 × 800 quadrant fills a 500 × 400 cell at zoom 4.
  const cell = { zoom: 1, perPixel: 0.125, cellWidth: 500, cellHeight: 400 };
  assert.deepEqual(M.quadrantZoom({ mode: '4x', ...cell, width: 1000, height: 800 }), { zoom: 4, clipped: false });
  // A larger quadrant does not fit at 4×: its edges are outside the cell; the zoom stays 4.
  assert.deepEqual(M.quadrantZoom({ mode: '4x', ...cell, width: 1200, height: 800 }), { zoom: 4, clipped: true });
  // A smaller one: 4× all the same (not the zoom that fills the cell).
  assert.deepEqual(M.quadrantZoom({ mode: '4x', ...cell, width: 500, height: 400 }), { zoom: 4, clipped: false });
  // 4× needs no measure of the cell; without one nothing can be said about the edges.
  assert.deepEqual(M.quadrantZoom({ mode: '4x', zoom: 1 }), { zoom: 4, clipped: false });
  // fill: the zoom that fills the cell with a little margin (as before).
  const fill = M.quadrantZoom({ mode: 'fill', ...cell, width: 500, height: 400 });
  assert.ok(Math.abs(fill.zoom - 8 * 0.98) < 1e-12 && fill.clipped === false, JSON.stringify(fill));
  assert.equal(M.quadrantZoom({ mode: 'fill', zoom: 1 }), null);
  assert.equal(M.quadrantZoom({ mode: '2x', ...cell, width: 500, height: 400 }), null);
});

test('zoom modes: Fit Breast, 1:1, True Size and Match Size as numbers', () => {
  // Fit now shows one image pixel as 0.25 CSS px; the breast box is 400 × 300 image px in a 500 × 300 cell.
  assert.equal(M.fitRect({ zoom: 1, perPixel: 0.25, cellWidth: 500, cellHeight: 300, width: 400, height: 300, margin: 1 }), 4);
  // Quadrant: half the box each way is twice the Fit zoom of the box.
  const whole = M.fitRect({ zoom: 1, perPixel: 0.25, cellWidth: 500, cellHeight: 400, width: 2000, height: 1600, margin: 1 });
  const quarter = M.fitRect({ zoom: 1, perPixel: 0.25, cellWidth: 500, cellHeight: 400, width: 1000, height: 800, margin: 1 });
  assert.equal(whole, 1); assert.equal(quarter, 2);
  // 1:1 on a dpr 2 screen: one image pixel is half a CSS pixel.
  assert.equal(M.onePixel({ zoom: 1, perPixel: 0.25, dpr: 2 }), 2);
  // True Size: 0.1 mm image pixels on a 0.25 mm-per-device-pixel monitor at dpr 1: 0.4 CSS px per image pixel.
  assert.ok(Math.abs(M.trueSize({ zoom: 1, perPixel: 0.25, spacing: 0.1, pitch: 0.25, dpr: 1 }) - 1.6) < 1e-12);
  // The same monitor with the browser at 200 %: twice as many device pixels per CSS pixel, half the zoom.
  assert.ok(Math.abs(M.trueSize({ zoom: 1, perPixel: 0.25, spacing: 0.1, pitch: 0.25, dpr: 2 }) - 0.8) < 1e-12);
  assert.equal(M.trueSize({ zoom: 1, perPixel: 0.25, spacing: 0.1, pitch: 0, dpr: 1 }), null);
  // Match Size: a cell without the zoom that fits its breast (a cell of no height, say) takes no part and sets no length;
  // without such a zoom anywhere nothing is matched.
  assert.deepEqual(M.matchSize([{ id: 'a', zoom: 1, perPixel: 0.5, length: 400 }, { id: 'b', zoom: 2, perPixel: 0.5, length: 300 },
    { id: 'c', zoom: 1, perPixel: 0.5, length: 0 }]), {});
  assert.deepEqual(M.matchSize([{ id: 'a', zoom: 1, perPixel: 0.5, length: 400, fit: 2 }, { id: 'z', zoom: 0.25, perPixel: 0.5, length: 300, fit: null }]), { a: 2 });
  // With the zoom that fits each breast whole in its cell: the length is the longest every cell can show whole. a would
  // show 400 at its fit (200 × 2), b 225 (150 × 1.5): both show 225, b at its fit and a below it.
  assert.deepEqual(M.matchSize([{ id: 'a', zoom: 1, perPixel: 0.5, length: 400, fit: 2 }, { id: 'b', zoom: 1, perPixel: 0.5, length: 300, fit: 1.5 }]),
    { a: 1.125, b: 1.5 });
  assert.equal(M.trueSizeLabel('detector'), 'True Size (at detector)');
  assert.equal(M.trueSizeLabel('ermf'), 'True Size (ERMF estimate)');
  assert.equal(M.trueSizeLabel('pixel'), 'True Size');
});

test('monitor key and pitch: one key per screen size and place; a pitch from 0.05 to 1 mm', () => {
  assert.equal(M.monitorKey({ width: 2560, height: 1440, availLeft: -2560, availTop: 0 }), '2560x1440@-2560,0');
  assert.equal(M.monitorKey({ width: 1920, height: 1080, availLeft: 0, availTop: 0 }), '1920x1080@0,0');
  // Without the screen's place the arrangement is not known: no key, so no stored value is reused.
  assert.equal(M.monitorKey({ width: 1920, height: 1080 }), null);
  assert.equal(M.monitorKey(null), null);
  assert.ok(M.validPitch(0.27)); assert.ok(!M.validPitch(0)); assert.ok(!M.validPitch(3)); assert.ok(!M.validPitch('0.2'));
});

test('slab: odd and even counts around the centre, the ends take only the slices there', () => {
  assert.deepEqual(M.slabRange(10, 5, 40), { first: 8, last: 12, count: 5, requested: 5 });
  assert.deepEqual(M.slabRange(10, 4, 40), { first: 9, last: 12, count: 4, requested: 4 });
  assert.deepEqual(M.slabRange(0, 5, 40), { first: 0, last: 2, count: 3, requested: 5 });
  assert.deepEqual(M.slabRange(39, 10, 40), { first: 35, last: 39, count: 5, requested: 10 });
  assert.deepEqual(M.slabRange(3, 1, 40), { first: 3, last: 3, count: 1, requested: 1 });
  assert.equal(M.slabRange(40, 3, 40), null);
  assert.equal(M.slabLabel(M.slabRange(0, 5, 40)), 'Slab 3 of 5');
  assert.equal(M.slabLabel(M.slabRange(10, 5, 40)), 'Slab 5');
});

test('slab: the mean pixel values (rounded for integer pixels), only of slices on the same grid and conversion', () => {
  const out = new Uint16Array(3);
  assert.ok(M.slabAverage([Uint16Array.of(10, 20, 31), Uint16Array.of(20, 20, 30), Uint16Array.of(30, 21, 30)], out));
  assert.deepEqual([...out], [20, 20, 30]);
  const float = new Float32Array(2);
  assert.ok(M.slabAverage([Float32Array.of(1, 2), Float32Array.of(2, 2)], float));
  assert.deepEqual([...float], [1.5, 2]);
  assert.equal(M.slabAverage([Uint16Array.of(1, 2), Uint16Array.of(1)], new Uint16Array(2)), false);
  const base = { rows: 2, columns: 3, slope: 1, intercept: 0, scaled: true };
  assert.ok(M.slabCompatible([base, { ...base }]));
  assert.ok(!M.slabCompatible([base, { ...base, columns: 4 }]));
  assert.ok(!M.slabCompatible([base, { ...base, intercept: -1024 }]));
  assert.ok(!M.slabCompatible([base, { ...base, scaled: false }]));
  const planar = { ...base, rowCosines: [0, 1, 0], columnCosines: [0, 0, -1], spacing: [0.1, 0.1] };
  assert.ok(M.slabCompatible([planar, { ...planar, rowCosines: [0, 1, 0.00001] }]));
  assert.ok(!M.slabCompatible([planar, { ...planar, rowCosines: [0, 0.9, 0.1] }]));
  assert.ok(!M.slabCompatible([planar, { ...planar, spacing: [0.1, 0.085] }]));
  assert.ok(!M.slabCompatible([planar, base]));
  // Along the stack (the plane's normal) the slices differ; a shift within the plane is another grid.
  const placed = { ...planar, position: [0, 0, 0] };
  assert.ok(M.slabCompatible([placed, { ...placed, position: [1, 0, 0] }, { ...placed, position: [2, 0.0005, 0] }]));
  assert.ok(!M.slabCompatible([placed, { ...placed, position: [1, 0.5, 0] }]));
  assert.ok(!M.slabCompatible([placed, { ...placed, position: [1, 0, 0.2] }]));
  assert.ok(!M.slabCompatible([placed, { ...placed, position: null }]));
});

test('next tab: the one after the current, from the last back to the first; none with one tab', () => {
  assert.equal(M.nextTab(3, 0), 1);
  assert.equal(M.nextTab(3, 2), 0);
  assert.equal(M.nextTab(1, 0), null);
  assert.equal(M.nextTab(3, 5), null);
});
