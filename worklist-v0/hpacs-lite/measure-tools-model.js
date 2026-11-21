// Pure values of the Measure menu's base tools: Spine Label level order, Circle by Diameter shape and statistics,
// and the texts of Marking, Text and Memo. Nothing here reads the screen; coordinates are image pixel coordinates
// (column x, row y; a whole number is the centre of a pixel) and lengths are millimetres.
// The viewer write path (viewer-language.js): product words in the reader's screen language, or as written.
function kinText(t, ...p) { const l = typeof window === 'object' && window && window.KinLanguage; return l && l.text ? l.text(t, ...p) : t.replace(/\{[ten]?(\d+)\}/g, (m, i) => String(p[i])); }
function kinHtml(t, ...p) { const l = typeof window === 'object' && window && window.KinLanguage; return l && l.html ? l.html(t, ...p) : t.replace(/\{[ten]?(\d+)\}/g, (m, i) => String(p[i])); }
function kinError(t, ...p) { return Object.assign(new Error(kinText(t, ...p)), { kinWords: true }); }
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api; else root.KinMeasureToolsModel = api;
})(globalThis, () => {
  const finite = n => typeof n === 'number' && Number.isFinite(n);

  // ── Spine Label ──
  const DIRECTIONS = Object.freeze(['Top to bottom', 'Bottom to top']);
  const ALL_LEVELS = Object.freeze(spineLevels(true, true));
  function spineLevels(includeC8, includeL6) {
    return [...Array.from({ length: includeC8 ? 8 : 7 }, (_, i) => 'C' + (i + 1)), ...Array.from({ length: 12 }, (_, i) => 'T' + (i + 1)),
      ...Array.from({ length: includeL6 ? 6 : 5 }, (_, i) => 'L' + (i + 1)), 'S1'];
  }
  // What the labels name: the vertebrae (C1 … S1), the discs between them, or both in their order down the spine.
  const LABELS = Object.freeze(['Vertebrae', 'Discs', 'Vertebrae and Discs']);
  // The disc between two neighbouring vertebrae: L4-5 within a region, C7-T1 / T12-L1 / L5-S1 across one. There is no
  // disc between C1 and C2, so the first disc is C2-3.
  const discName = (upper, lower) => upper[0] === lower[0] ? upper + '-' + lower.slice(1) : upper + '-' + lower;
  function spineNames(includeC8, includeL6, labels = LABELS[0]) {
    const levels = spineLevels(!!includeC8, !!includeL6);
    if (!LABELS.includes(labels)) return [];
    if (labels === LABELS[0]) return levels;
    return levels.flatMap((level, i) => [...(labels === LABELS[2] ? [level] : []),
      ...(i + 1 < levels.length && level !== 'C1' ? [discName(level, levels[i + 1])] : [])]);
  }
  // Every name a label may carry (any choice of C8 and L6) and its place down the spine: a vertebra at twice its index
  // among C1 … C8 … L6 S1, a disc halfway between its two vertebrae.
  const PLACES = (() => {
    const full = spineLevels(true, true), places = new Map();
    for (const c8 of [false, true]) for (const l6 of [false, true]) {
      const levels = spineLevels(c8, l6);
      levels.forEach((level, i) => {
        places.set(level, 2 * full.indexOf(level));
        if (i + 1 < levels.length && level !== 'C1') places.set(discName(level, levels[i + 1]), full.indexOf(level) + full.indexOf(levels[i + 1]));
      });
    }
    return places;
  })();
  const ALL_NAMES = Object.freeze([...PLACES.keys()].sort((a, b) => PLACES.get(a) - PLACES.get(b)));
  // The start in a list drawn again (another choice of labels, C8 or L6): the same name, or the nearest one down the spine,
  // the lower one of two as near (a vertebra → the disc under it, a disc → the vertebra under it, a dropped C8 → T1,
  // C8-T1 → C7-T1).
  function spineStart(names, start) {
    if (names.includes(start)) return start;
    const place = PLACES.get(start);
    if (place === undefined) return names[0] ?? null;
    let best = null;
    for (const name of names) {
      const d = PLACES.get(name) - place;
      if (!best || Math.abs(d) < Math.abs(best.d) || Math.abs(d) === Math.abs(best.d) && d > best.d) best = { name, d };
    }
    return best ? best.name : null;
  }
  // The levels to stamp from the start level on, one per press. null when the start is not one of the levels.
  function spineOrder({ start, includeC8, includeL6, direction, labels = LABELS[0] }) {
    const levels = spineNames(!!includeC8, !!includeL6, labels), at = levels.indexOf(start);
    if (at < 0 || !DIRECTIONS.includes(direction)) return null;
    return { levels, order: direction === DIRECTIONS[0] ? levels.slice(at) : levels.slice(0, at + 1).reverse() };
  }
  // The preview line: every level, the start level in brackets.
  const spinePreview = (levels, start) => levels.map(level => level === start ? '[' + level + ']' : level).join(' ');
  const spineLevel = value => typeof value === 'string' && PLACES.has(value);

  // ── Circle by Diameter ──
  // A circle of the given diameter on the patient: on pixels that are not square it is an ellipse of pixels.
  // spacing = [row spacing, column spacing] in mm (DICOM PixelSpacing order).
  function circleShape(center, diameter, spacing) {
    if (!Array.isArray(center) || center.length !== 2 || !center.every(finite)) throw kinError("원의 가운데를 확인할 수 없습니다");
    if (!finite(diameter) || diameter <= 0) throw kinError("지름은 0보다 커야 합니다");
    if (!Array.isArray(spacing) || spacing.length !== 2 || !spacing.every(n => finite(n) && n > 0)) throw kinError("이 영상에서는 mm 지름을 쓸 수 없습니다");
    const radius = diameter / 2, rx = radius / spacing[1], ry = radius / spacing[0];
    return { center: [...center], radius, rx, ry, edge: [center[0] + rx, center[1]], area: Math.PI * radius * radius };
  }
  // The pixels whose centres lie inside the circle on the patient, within the image.
  function circlePixels(shape, rows, columns, spacing) {
    const out = [];
    const [cx, cy] = shape.center, r2 = shape.radius * shape.radius;
    const x0 = Math.max(0, Math.ceil(cx - shape.rx)), x1 = Math.min(columns - 1, Math.floor(cx + shape.rx));
    const y0 = Math.max(0, Math.ceil(cy - shape.ry)), y1 = Math.min(rows - 1, Math.floor(cy + shape.ry));
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const dx = (x - cx) * spacing[1], dy = (y - cy) * spacing[0];
      if (dx * dx + dy * dy <= r2 + 1e-9) out.push([x, y]);
    }
    return out;
  }
  const MAX_PIXELS = 4194304;
  // Mean, SD (of the pixels, not of a sample), minimum, maximum and count of the modality values inside the circle.
  // value(x, y) gives the modality value (rescaled) of one pixel. null when no pixel centre falls inside.
  function circleStats(shape, rows, columns, spacing, value) {
    if (!Number.isSafeInteger(rows) || !Number.isSafeInteger(columns) || rows < 1 || columns < 1) throw kinError("영상 크기를 확인할 수 없습니다");
    if ((2 * shape.rx + 1) * (2 * shape.ry + 1) > MAX_PIXELS) throw kinError("원이 너무 커서 통계를 계산하지 않습니다");
    let count = 0, sum = 0, squares = 0, min = Infinity, max = -Infinity;
    for (const [x, y] of circlePixels(shape, rows, columns, spacing)) {
      const n = value(x, y);
      if (!finite(n)) throw kinError("화소값을 읽을 수 없습니다");
      count++; sum += n; squares += n * n; if (n < min) min = n; if (n > max) max = n;
    }
    if (!count) return null;
    const mean = sum / count;
    return { count, mean, sd: Math.sqrt(Math.max(0, squares / count - mean * mean)), min, max };
  }
  // The saved values: [diameter mm, area mm²] and, when calculated, [mean, SD, min, max, pixel count].
  function circleValues(diameter, stats) {
    const area = Math.PI * diameter * diameter / 4;
    return stats ? [diameter, area, stats.mean, stats.sd, stats.min, stats.max, stats.count] : [diameter, area];
  }
  // The lines shown beside a circle and in the panel. unit '' is a pixel value without a unit.
  function circleLines(values, unit, basisLabel) {
    if (!Array.isArray(values) || ![2, 7].includes(values.length) || !values.every(finite)) return [kinText("재확인 필요: 값을 확인할 수 없습니다")];
    const one = n => (Math.round(n * 10) / 10).toFixed(1), u = unit ? ' ' + unit : '';
    const lines = ['Ø ' + one(values[0]) + ' mm · Area ' + one(values[1]) + ' mm²'];
    if (values.length === 7) lines.push('Mean ' + one(values[2]) + u + ' · SD ' + one(values[3]) + u, 'Min ' + one(values[4]) + u + ' · Max ' + one(values[5]) + u + ' · n ' + values[6]);
    else lines.push(kinText("통계 없음(원 안에 화소가 없거나 색 영상)"));
    if (basisLabel) lines.push(basisLabel);
    return lines;
  }

  // ── Marking, Text and Memo ──
  const TEXT_LIMIT = 1000, TITLE_LIMIT = 200, MARKING_LIMIT = 60, MARKINGS = 30;
  // A text as stamped: no NUL, no unpaired surrogate; trimmed; within the limit; null otherwise (or when empty).
  function cleanText(value, limit = TEXT_LIMIT) {
    if (typeof value !== 'string' || /[\u0000]/.test(value)) return null;
    try { encodeURIComponent(value); } catch (_) { return null; }
    const text = value.trim();
    return text && [...text].length <= limit ? text : null;
  }
  // The account's Marking list, read as stored: only distinct one-line texts within the limits; anything else is dropped.
  function markingList(value) {
    if (!Array.isArray(value)) return [];
    const out = [];
    for (const entry of value) {
      const text = cleanText(entry, MARKING_LIMIT);
      if (text && !/[\r\n]/.test(text) && !out.includes(text) && out.length < MARKINGS) out.push(text);
    }
    return out;
  }
  function addMarking(list, value) {
    const text = cleanText(value, MARKING_LIMIT);
    if (!text || /[\r\n]/.test(text)) return { list, error: kinText("문구는 한 줄, {0}자까지입니다.", MARKING_LIMIT) };
    if (list.includes(text)) return { list, error: kinText("이미 목록에 있는 문구입니다.") };
    if (list.length >= MARKINGS) return { list, error: kinText("목록은 {0}개까지입니다.", MARKINGS) };
    return { list: [...list, text], error: '' };
  }

  return Object.freeze({ DIRECTIONS, ALL_LEVELS, LABELS, ALL_NAMES, spineLevels, spineNames, spineStart, discName, spineOrder, spinePreview, spineLevel,
    circleShape, circlePixels, circleStats, circleValues, circleLines, MAX_PIXELS,
    TEXT_LIMIT, TITLE_LIMIT, MARKING_LIMIT, MARKINGS, cleanText, markingList, addMarking });
});
