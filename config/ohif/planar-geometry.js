// The images that are measured in the viewer's own plane although they give no orientation: projection X-rays (CR, DX,
// RF, XA) without ImageOrientationPatient, without functional groups or detector information, with one frame, whose spacing
// and position tags read plainly as Decimal Strings (each Pixel Spacing / Imager Pixel Spacing absent or two positive
// numbers, at least one given; a magnification factor absent or positive; a position absent or three numbers). Every other image keeps the rules it had (as api/src/planar-geometry.ts).
function kinViewerPlaneImage(tags) {
  // A Decimal String component (DICOM PS3.5 6.2): at most 16 bytes of digits, one point, an exponent and spaces only, judged
  // before it becomes a number; a JSON number is taken as it is. Anything else (a tab, 19 bytes, 0x2, Infinity) is not plain.
  const decimal = (x) => typeof x === 'number' ? Number.isFinite(x) :
    typeof x === 'string' && x.length <= 16 && /^ *[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)? *$/.test(x) && Number.isFinite(Number(x));
  const parts = (v, n) => { const a = typeof v === 'string' ? v.split('\\') : v; return Array.isArray(a) && a.length === n && a.every(decimal) ? a.map(Number) : null; };
  const positive = (v, n) => { const a = parts(v, n); return !!a && a.every(x => x > 0); };
  const frames = tags?.NumberOfFrames;
  return ['CR', 'DX', 'RF', 'XA'].includes(tags?.Modality) && tags.ImageOrientationPatient === undefined &&
    tags.PerFrameFunctionalGroupsSequence === undefined && tags.SharedFunctionalGroupsSequence === undefined && tags.DetectorInformationSequence === undefined &&
    // One frame only (an Integer String is at most 12 bytes): a multi-frame run keeps the rules it had.
    (frames === undefined || frames === 1 || typeof frames === 'string' && frames.length <= 12 && /^ *\+?0*1 *$/.test(frames)) &&
    (tags.PixelSpacing === undefined || positive(tags.PixelSpacing, 2)) && (tags.ImagerPixelSpacing === undefined || positive(tags.ImagerPixelSpacing, 2)) &&
    (tags.PixelSpacing !== undefined || tags.ImagerPixelSpacing !== undefined) &&
    (tags.EstimatedRadiographicMagnificationFactor === undefined || positive([tags.EstimatedRadiographicMagnificationFactor], 1)) &&
    (tags.ImagePositionPatient === undefined || !!parts(tags.ImagePositionPatient, 3));
}

// Physical lengths, angles and areas on a specified original frame; no non-CT HU inference.
function kinPlanarGeometry(tags, frame) {
  // Also run on its own (a page test takes this function out of config/ohif.js): the words then stay as written.
  const kinText = globalThis.kinText || ((t, ...p) => t.replace(/\{[ten]?(\d+)\}/g, (m, i) => String(p[i]))), kinHtml = globalThis.kinHtml || kinText, kinError = globalThis.kinError || ((t, ...p) => Object.assign(new Error(kinText(t, ...p)), { kinWords: true }));
  const fail = () => { throw kinError("원본 프레임의 좌표·간격·보정을 확인할 수 없습니다"); };
  const numbers = (v, n) => {
    const a = typeof v === 'string' ? v.split('\\') : v;
    if (!Array.isArray(a) || a.length !== n || a.some(x => !(typeof x === 'number' || typeof x === 'string' && x.trim()) || !Number.isFinite(Number(x)))) return fail();
    return a.map(Number);
  };
  const frames = Number(tags?.NumberOfFrames ?? 1);
  if (!Number.isSafeInteger(frame) || frame < 1 || !Number.isSafeInteger(frames) || frame > frames) return fail();
  const per = tags.PerFrameFunctionalGroupsSequence, shared = tags.SharedFunctionalGroupsSequence;
  if (per !== undefined && (!Array.isArray(per) || per.length !== frames)) return fail();
  const value = (sequence, key) => per || shared ? (per?.[frame - 1]?.[sequence]?.[0] ?? shared?.[0]?.[sequence]?.[0])?.[key] : tags[key];
  const mg = tags.Modality === 'MG' ? kinMgGeometry(tags, frame) : null, viewerPlane = kinViewerPlaneImage(tags);
  let origin, orientation, spacing, basis;
  if (mg) ({ origin, orientation, spacing, basis } = mg);
  else {
    const pixel = value('PixelMeasuresSequence', 'PixelSpacing');
    spacing = numbers(pixel ?? value('FramePixelDataPropertiesSequence', 'ImagerPixelSpacing'), 2);
    basis = pixel !== undefined ? 'pixel' : 'detector';
    if (basis === 'detector') {
      const factor = value('XRayGeometrySequence', 'EstimatedRadiographicMagnificationFactor');
      if (factor !== undefined) {
        const k = numbers([factor], 1)[0]; if (k <= 0) return fail();
        spacing = spacing.map(x => x / k); basis = 'ermf';
      }
    }
    if (viewerPlane) {
      // A projection X-ray as most devices send it (kinViewerPlaneImage): measured in the plane the viewer places it in,
      // where the points of its marks lie — rows along [0,1,0], columns along [0,0,-1], origin [0,0,0] (the pinned OHIF
      // imagePlaneModule).
      origin = numbers(tags.ImagePositionPatient ?? [0, 0, 0], 3);
      orientation = [0, 1, 0, 0, 0, -1];
    } else {
      origin = numbers(value('PlanePositionSequence', 'ImagePositionPatient') ?? [0, 0, 0], 3);
      orientation = numbers(value('PlaneOrientationSequence', 'ImageOrientationPatient') ?? [1, 0, 0, 0, 1, 0], 6);
    }
  }
  if (spacing.some(n => n <= 0)) return fail();
  const rows = Number(tags.Rows), columns = Number(tags.Columns);
  if (![rows, columns].every(n => Number.isSafeInteger(n) && n > 0)) return fail();
  const u = orientation.slice(0, 3), v = orientation.slice(3), dot = (a, b) => a.reduce((s, n, i) => s + n * b[i], 0);
  const uu = dot(u, u), vv = dot(v, v), uv = dot(u, v), det = uu * vv - uv * uv;
  if (uu <= 0 || vv <= 0 || det <= 0 || Math.abs(uv / Math.sqrt(uu * vv)) > 1e-4) return fail();
  const cross = [u[1]*v[2]-u[2]*v[1], u[2]*v[0]-u[0]*v[2], u[0]*v[1]-u[1]*v[0]];
  const normal = cross.map(n => n / Math.sqrt(dot(cross, cross)));
  const imagePoint = point => {
    const d = numbers(point, 3).map((n, i) => n - origin[i]);
    const x = (dot(d, u) * vv - dot(d, v) * uv) / det / spacing[1];
    const y = (dot(d, v) * uu - dot(d, u) * uv) / det / spacing[0];
    if (Math.abs(dot(d, normal)) > .001 || x < -.501 || y < -.501 || x > columns - .499 || y > rows - .499) return fail();
    return [x, y];
  };
  const measure = (kind, points) => {
    const p = points.map(point => imagePoint(point).map((n, i) => n * spacing[1 - i]));
    const sub = (a, b) => a.map((n, i) => n - b[i]), size = a => Math.hypot(...a);
    const a = sub(p[0], p[1]); if (size(a) <= 1e-6) return fail();
    if (kind === 'length') return size(a);
    const b = kind === 'angle' ? sub(p[2], p[1]) : sub(p[3], p[2]);
    if (size(b) <= 1e-6) return fail();
    const cosine = dot(a, b) / size(a) / size(b);
    if (kind === 'angle') {
      return Math.acos(Math.max(-1, Math.min(1, cosine))) * 180 / Math.PI;
    }
    if (kind !== 'ellipse' || Math.abs(cosine) > 1e-4 || size(p[0].map((n, i) => (n + p[1][i] - p[2][i] - p[3][i]) / 2)) > .001) return fail();
    return Math.PI * size(a) * size(b) / 4;
  };
  // The basis name is a value of the measurement (the exported report carries it): kept as written, never in the screen's
  // language. Where it is drawn is the panel's and the marks' business (history.js).
  const label = mg?.label || { pixel: 'PixelSpacing · 원본 기준면', detector: 'ImagerPixelSpacing · 검출기 기준', ermf: 'ImagerPixelSpacing / ERMF · 추정 보정' }[basis];
  return { origin, orientation, spacing, normal, imagePoint, measure, label, frameOfReferenceUid: tags.FrameOfReferenceUID || null,
    calculator: 'kin-planar-manual-v1:' + basis, viewerPlane };
}

// Ultrasound Region Calibration (DICOM PS3.3 C.8.5.5.1): the physical size of a pixel inside one region of an ultrasound
// image. Only 2D tissue regions (Region Spatial Format 1) measured in cm on both axes (Physical Units 3) count. Points are
// image pixel coordinates [column, row]; all points of one measurement must lie in the same region, or there is no spacing.
// Used by the Measure menu's tools only; the existing Length, Angle and Ellipse keep their own rules.
function kinUsRegionGeometry(tags) {
  // Also run on its own (a page test takes this function out of config/ohif.js): the words then stay as written.
  const kinText = globalThis.kinText || ((t, ...p) => t.replace(/\{[ten]?(\d+)\}/g, (m, i) => String(p[i]))), kinHtml = globalThis.kinHtml || kinText, kinError = globalThis.kinError || ((t, ...p) => Object.assign(new Error(kinText(t, ...p)), { kinWords: true }));
  const regions = tags?.SequenceOfUltrasoundRegions;
  if (tags?.Modality !== 'US' || !Array.isArray(regions) || !regions.length) return null;
  const number = value => {
    const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN;
    return Number.isFinite(n) ? n : NaN;
  };
  const usable = [];
  for (const region of regions) {
    const r = {
      format: number(region?.RegionSpatialFormat), unitsX: number(region?.PhysicalUnitsXDirection), unitsY: number(region?.PhysicalUnitsYDirection),
      deltaX: number(region?.PhysicalDeltaX), deltaY: number(region?.PhysicalDeltaY),
      x0: number(region?.RegionLocationMinX0), y0: number(region?.RegionLocationMinY0), x1: number(region?.RegionLocationMaxX1), y1: number(region?.RegionLocationMaxY1),
    };
    if (r.format !== 1 || r.unitsX !== 3 || r.unitsY !== 3 || !(r.deltaX > 0) || !(r.deltaY > 0) ||
        ![r.x0, r.y0, r.x1, r.y1].every(Number.isSafeInteger) || r.x1 < r.x0 || r.y1 < r.y0) continue;
    // cm per pixel → mm per pixel, in the order of PixelSpacing: [row (Y), column (X)].
    usable.push({ ...r, spacing: [Math.abs(r.deltaY) * 10, Math.abs(r.deltaX) * 10] });
  }
  if (!usable.length) return null;
  const inside = (r, [x, y]) => x >= r.x0 - .5 && x <= r.x1 + .5 && y >= r.y0 - .5 && y <= r.y1 + .5;
  // Every region that holds every point; the first of them, or null.
  const holding = points => usable.filter(r => points.every(p => Array.isArray(p) && p.length >= 2 && Number.isFinite(p[0]) && Number.isFinite(p[1]) && inside(r, p)));
  const region = points => holding(points)[0] || null;
  const spacing = points => { const r = region(points); if (!r) throw kinError("초음파 보정 영역 안에서만 mm로 잴 수 있습니다"); return r.spacing; };
  const length = (a, b) => { const s = spacing([a, b]); return Math.hypot((b[0] - a[0]) * s[1], (b[1] - a[1]) * s[0]); };
  return { regions: usable, holding, region, spacing, length, label: 'US Region Calibration', basis: 'us' };
}

// The geometry a toolbar Length, Angle or Ellipse is measured with (as api/src/planar-geometry.ts manualGeometry). A Length
// on an ultrasound image that gives no spacing, orientation or functional groups of its own, with at least one usable
// region (kinUsRegionGeometry), is measured in the viewer's plane — rows along [0,1,0], columns along [0,0,-1], display
// spacing 1, origin its ImagePositionPatient or else [0,0,0] for one frame and [0,0,f] for frame f of a multi-frame image
// (the pinned OHIF combineFrameInstance) — with the deltas of the region that holds both points. Regions of different
// deltas that both hold them, or none, give no length. Everything else is kinPlanarGeometry's.
function kinManualGeometry(tags, frame, kind) {
  const own = ['PixelSpacing', 'ImagerPixelSpacing', 'ImageOrientationPatient', 'SharedFunctionalGroupsSequence', 'PerFrameFunctionalGroupsSequence'];
  const us = kind === 'length' && tags?.Modality === 'US' && own.every(key => tags[key] === undefined) ? kinUsRegionGeometry(tags) : null;
  if (!us) return kinPlanarGeometry(tags, frame);
  const fail = () => { throw kinError("원본 프레임의 좌표·간격·보정을 확인할 수 없습니다"); };
  const outside = () => { throw kinError("초음파 보정 영역 안에서만 mm로 잴 수 있습니다"); };
  const numbers = (v, n) => {
    const a = typeof v === 'string' ? v.split('\\') : v;
    if (!Array.isArray(a) || a.length !== n || a.some(x => !(typeof x === 'number' || typeof x === 'string' && x.trim()) || !Number.isFinite(Number(x)))) return fail();
    return a.map(Number);
  };
  const frames = Number(tags.NumberOfFrames ?? 1);
  if (!Number.isSafeInteger(frame) || frame < 1 || !Number.isSafeInteger(frames) || frame > frames) return fail();
  const rows = Number(tags.Rows), columns = Number(tags.Columns);
  if (![rows, columns].every(n => Number.isSafeInteger(n) && n > 0)) return fail();
  const origin = tags.ImagePositionPatient !== undefined ? numbers(tags.ImagePositionPatient, 3) : [0, 0, frames > 1 ? frame : 0];
  const orientation = [0, 1, 0, 0, 0, -1], normal = [-1, 0, 0];
  const imagePoint = point => {
    const d = numbers(point, 3).map((n, i) => n - origin[i]), x = d[1], y = -d[2];
    if (Math.abs(d[0]) > .001 || x < -.501 || y < -.501 || x > columns - .499 || y > rows - .499) return fail();
    return [x, y];
  };
  const measure = (kind, points) => {
    if (kind !== 'length' || !Array.isArray(points) || points.length !== 2) return fail();
    const p = points.map(imagePoint);
    if (Math.hypot(p[1][0] - p[0][0], p[1][1] - p[0][1]) <= 1e-6) return fail();
    const held = us.holding(p), s = held[0]?.spacing;
    if (!s || held.some(r => r.spacing[0] !== s[0] || r.spacing[1] !== s[1])) return outside();
    return Math.hypot((p[1][0] - p[0][0]) * s[1], (p[1][1] - p[0][1]) * s[0]);
  };
  return { origin, orientation, spacing: [1, 1], normal, imagePoint, measure, label: us.label, frameOfReferenceUid: tags.FrameOfReferenceUID || null,
    calculator: 'kin-planar-manual-v1:us', viewerPlane: true };
}
