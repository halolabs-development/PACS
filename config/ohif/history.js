
function kinCreateViewerHistory() {
  let services, commands, extensions, stop;
  // The Measure menu's marks (viewer-features-measure.js) live in the annotation state under their own tool names, which no
  // cornerstone tool draws: that module draws them in a layer over the cell. They are saved, locked and restored here as the others.
  const tools = { arrow: 'ArrowAnnotate', length: 'Length', angle: 'Angle', ellipse: 'EllipticalROI', text: 'KinText', memo: 'KinMemo', spine: 'KinSpineLabel', circle: 'KinCircleDiameter',
    limbLength: 'KinLimbLength', acetabular: 'KinAcetabular', spineBalance: 'KinSpineBalance', spineCobb: 'KinSpineCobb', pelvicIncidence: 'KinPelvicIncidence',
    ctr: 'KinCTR', parallel: 'KinParallelLines', ratio: 'KinLengthRatio', centreAngle: 'KinCentreLineAngle', volume: 'KinVolume' };
  // The orthopaedic and spine measurements (viewer-features-measure-ortho.js) and their number of points: marks with values,
  // checked again before they are saved, as a circle is.
  const ORTHO = { limbLength: 6, acetabular: 6, spineBalance: 6, spineCobb: 4, pelvicIncidence: 4 };
  const kinds = Object.fromEntries(Object.entries(tools).map(([kind, tool]) => [tool, kind]));
  const names = { arrow: 'Arrow', key: 'Key Image', length: 'Length', angle: 'Angle', ellipse: 'Ellipse ROI', text: 'Text', memo: 'Memo', spine: 'Spine Label', circle: 'Circle by Diameter',
    limbLength: 'Limb Length Discrepancy', acetabular: 'Acetabular Angle', spineBalance: 'Spine Balance', spineCobb: 'Cobb Angle (Lordosis / Kyphosis)', pelvicIncidence: 'Pelvic Incidence',
    ctr: 'CTR', parallel: 'Parallel Lines', ratio: 'Length Ratio', centreAngle: 'Centre-line Angle', volume: 'Volume Measure' };
  // The Measure menu's line tools (viewer-features-measure-lines.js): their values, calculator and points are in kinBaseline as a circle's are.
  const lineMark = kind => ['ctr', 'parallel', 'ratio', 'centreAngle', 'volume'].includes(kind);
  // A mark with values (a circle, an orthopaedic measurement, a line tool's mark): its saved values are calculated again (from
  // the original's pixels or tags) before it is saved.
  const valueMark = kind => kind === 'circle' || Object.prototype.hasOwnProperty.call(ORTHO, kind) || lineMark(kind);
  const measureMark = kind => ['text', 'memo', 'spine'].includes(kind) || valueMark(kind);
  // The points of a line mark (but a Volume, which is one result point) by the tool its calculator names.
  const linePoints = baseline => ({ ctr4: 6, ctr2: 4, parallel: 4, ratio: 4, centreangle: 8 })[String(baseline?.calculator || '').split(':')[0].slice(4, -3)];
  // The fields of a Measure menu mark kept in its annotation besides its points and text: a memo's title, a circle's values.
  const markFields = (kind, data) => kind === 'memo' ? { title: typeof data.title === 'string' ? data.title : '' } :
    valueMark(kind) ? { baseline: data.kinBaseline ? JSON.parse(JSON.stringify(data.kinBaseline)) : null } : {};
  function mount() {
    stop?.();
    const cs = window.cornerstone, ct = window.cornerstoneTools;
    const annotationManager = ct?.annotation?.state?.getAnnotationManager?.();
    if (annotationManager && window.KinViewerSessionBoundary) {
      const state = annotationManager;
      window.KinViewerSessionBoundary.guardMethods(state,
        ['addAnnotation', 'removeAnnotation', 'removeAllAnnotations'].filter(name => typeof state[name] === 'function'));
    }
    if (!cs || !ct?.annotation?.locking) return;
    const entries = new Map(), annotations = new Map(), recovery = new Map(), drawing = new Map();
    let scope = '', subject = '', me, generation = 0, readSequence = 0, shown = null, shownStatus = '', unmatched = false;
    let controller = new AbortController(), ended = false, checking = false, ownAnswer = false;
    let lastAuth = 0, tried = 0, loading = false, navigation = 0, suspended = true;
    const panel = document.createElement('details');
    panel.id = 'kin-viewer-history'; panel.open = true;
    panel.style.cssText = 'position:fixed;right:8px;bottom:30px;z-index:40;width:300px;max-height:58vh;overflow:auto;background:#101e32;color:#e1ecfc;border:1px solid #657c9f;border-radius:8px;padding:10px;font:13px sans-serif';
    const summary = document.createElement('summary'); summary.textContent = 'Measurements & Key Images'; panel.append(summary);
    const status = document.createElement('p'); status.setAttribute('role', 'status'); panel.append(status);
    const actions = document.createElement('div'), list = document.createElement('div'); panel.append(actions, list);
    document.body.append(panel);
    const clone = value => JSON.parse(JSON.stringify(value));
    const itemOnly = head => { const item = clone(head.item); delete item.hidden; delete item.sourceDigest; delete item.deleted; return item; };
    const manual = kind => ['length', 'angle', 'ellipse'].includes(kind);
    // A saved measurement's value in the words of finding-link-model.js valueText (loaded by the Findings extension for every mode).
    // The value has its own node; one drawn before that module arrived is filled in place by scan() once it is there,
    // so the row is not rebuilt and an open History list and the focus stay where they are.
    const valueModule = () => typeof window.kinFindingLinkModel?.valueText === 'function';
    const savedValue = item => {
      if (!valueModule()) return '';
      // Drawn on the panel: its words in the reader's screen language (valueSay); the CSV keeps its own words as written.
      try { const m = window.kinFindingLinkModel; return String((m.valueSay || m.valueText)(item.kind, item.baseline?.calculator, item.baseline?.values, 'server-copy')); } catch (_) { return ''; }
    };
    // Until then an empty text node holds the value's place (no element is added), and scan() puts the value element there.
    const pendingValues = new Set();
    const valueElement = (tag, item, prefix) => {
      const v = savedValue(item); if (!v) return null;
      const node = document.createElement(tag); node.textContent = prefix + v; node.dataset.kinValue = ''; return node;
    };
    const valueNode = (parent, tag, item, prefix) => {
      if (!Array.isArray(item?.baseline?.values)) return;
      if (valueModule()) { const node = valueElement(tag, item, prefix); if (node) parent.append(node); return; }
      const anchor = document.createTextNode(''); parent.append(anchor); pendingValues.add({ anchor, tag, item, prefix });
    };
    // S5-U2b: /me가 업무 역할 clinician뿐이라고 답한 세션은 이 패널에서 저장된 항목을 보기만 한다. 만들기·저장·SR·이력
    // 컨트롤을 두지 않는 것은 화면일 뿐 권한이 아니다 — 쓰기는 서버(S5-U1a/U1b)가 거절한다. /me를 읽기 전에는 어느 쪽 컨트롤도 없다.
    // 판정은 문서 공통(kinViewerSession)이다: 어느 확장의 /me가 답했든, 모드를 다시 들어와도 쓰기 쪽으로 돌아가지 않는다.
    const readOnly = () => kinViewerSession.readOnly();
    // Astra S5-U2b-R-002 F01: authoring (native tools, mark edits, SR, this panel's own save paths) is open only while a successful
    // /me answered writer. No answer yet, an error or a 401/403 leaves image viewing only, the same as a clinician-only document.
    const writer = () => kinViewerSession.writer();
    // Astra S5-U2b-X-R-001 F01. 보관한 writer 작업(recovery)은 writer가 재개하거나 버릴 때까지 그 검사의 목록 표식·영상 이동을
    // 멈춘다 — 보관 초안과 서버 목록을 한 화면에서 섞지 않으려는 것이다. clinician-only 문서의 확정 목록은 그 초안과 이어지지 않는
    // 다른 목록이고 read-only는 되돌리지 않아 이 문서에서 재개할 길도 없다: 멈추면 검증한 확정 표식과 Go to Image가 풀리지 않는다.
    // 그래서 보관 작업은 그대로 격리해 두고(표시·복원·삭제하지 않으며 창 닫기 경고 jobGuard도 그대로) 읽기 쪽만 막지 않는다.
    // 쓰기 쪽 검사(writable·SR·도구·captureAnnotations)는 recovery.has(scope)를 그대로 읽는다.
    const held = () => recovery.has(scope) && !readOnly();
    const READ_ONLY = {
      note: kinText("읽기 전용 · 이 검사에 저장된 측정·키 이미지를 표시합니다. 이 화면에서는 측정·키 이미지를 만들거나 저장하지 않으며 서버도 쓰기를 거절합니다."),
      tool: kinText("읽기 전용 화면입니다. 측정을 만들지 않습니다."),
      edit: kinText("읽기 전용 화면입니다. 측정·표식을 편집하지 않습니다."),
      sr: kinText("읽기 전용 화면에서는 SR을 만들거나 저장하지 않습니다."),
      denied: kinText("이 검사의 저장 항목을 읽을 수 없습니다(HTTP 403). 서버가 거절했습니다."),
      unmatched: kinText("현재 화면에서 원본 프레임을 확인할 수 없어 이 목록을 표시 영상과 맞추지 않았습니다. 마지막으로 확인한 검사 기준이며 저장 항목은 계속 다시 확인합니다."),
    };
    const UNCONFIRMED = {
      tool: kinText("계정이 확인되기 전에는 영상 조작만 할 수 있습니다. 측정·표식을 만들지 않습니다."),
      edit: kinText("계정이 확인되기 전에는 측정·표식을 편집하지 않습니다."),
      sr: kinText("계정이 확인되기 전에는 SR을 만들거나 저장하지 않습니다."),
    };
    // After a 401/403 or a logout the panel has ended: that, not the account wording, is what the user needs to hear.
    const closedText = kind => ended ? kinText("로그인이 종료되었습니다. 다시 로그인한 뒤 뷰어를 여세요.") : (readOnly() ? READ_ONLY : UNCONFIRMED)[kind];
    function planar(imageId, kind) {
      const image = cs.metaData.get('instance', imageId);
      if (image?.Modality === 'MG' && kind === 'length' || image?.Modality === 'CT' && image.SOPClassUID === '1.2.840.10008.5.1.4.1.1.2' && Number(image.NumberOfFrames || 1) === 1) return null;
      return kinManualGeometry(image, reference(imageId)?.frame, kind);
    }
    // ── Screen calibration (the Calibration tool) ──
    // An image whose original gives no pixel spacing at all (a scanned film, an outside CR) has no mm of its own. The reader may
    // set one on this screen with the Calibration tool; a Length is then measured with it and shown as such ('화면 보정 · 저장 안
    // 됨'). It is not the original's spacing, so such a mark never becomes a saved measurement: no row, no save, no automatic
    // save, no SR or export value, no unsaved work. Its mark carries kinScreenCalibration from the press that made it, so it stays
    // out of all of those even when the calibration is no longer found. This is the one place that answers "may a Length be
    // measured here with a screen calibration"; an image with spacing of its own keeps its rules (a calibration over it is refused
    // as before), and so do Angle and Ellipse.
    const SCREEN_LABEL = '화면 보정 · 저장 안 됨';
    const NO_SPACING = kinText("원본에 픽셀 간격이 없습니다 · Calibration으로 화면 보정 후 잴 수 있습니다");
    const SCREEN_SR = kinText("화면 보정 측정은 저장되지 않아 SR에 넣지 않습니다.");
    // Any tag that gives the original a spacing of its own, valid or not (a spacing tag that cannot be read is refused by the
    // original's own rules, never measured with a screen calibration): the image is not one for a screen calibration.
    const given = v => v !== undefined && v !== null && v !== '' && !(Array.isArray(v) && !v.length);
    const groupSpacing = groups => Array.isArray(groups) && groups.some(group =>
      (Array.isArray(group?.PixelMeasuresSequence) ? group.PixelMeasuresSequence : []).some(item => given(item?.PixelSpacing)) ||
      (Array.isArray(group?.FramePixelDataPropertiesSequence) ? group.FramePixelDataPropertiesSequence : []).some(item => given(item?.ImagerPixelSpacing)));
    // The original's header gives no spacing of its own at all (the one answer to "has this image a spacing").
    const spacingless = image => !!image && !['PixelSpacing', 'ImagerPixelSpacing', 'SequenceOfUltrasoundRegions'].some(key => given(image[key])) &&
      !groupSpacing(image.SharedFunctionalGroupsSequence) && !groupSpacing(image.PerFrameFunctionalGroupsSequence);
    const noSpacing = (imageId, kind) => kind === 'length' && !!imageId && spacingless(cs.metaData.get('instance', imageId));
    // The calibration the reader set on this image: the calibrated-spacing metadata the Calibration tool writes (kept for the
    // image id while the viewer is open); the cached image's only when there is no such metadata. A region (ultrasound), an
    // "uncalibrated" answer or a scale that is not a positive number is no screen calibration.
    function screenCalibration(imageId, kind) {
      if (!noSpacing(imageId, kind)) return null;
      let found;
      try { found = cs.metaData.get('calibratedPixelSpacing', imageId); } catch (_) { found = undefined; }
      if (found === undefined || found === null) found = cs.cache.getImage(imageId)?.calibration;
      const scale = Number(found?.scale);
      const usable = !!found && typeof found === 'object' && !!found.type && !['Region', 'Uncalibrated'].includes(found.type) &&
        !found.sequenceOfUltrasoundRegions && Number.isFinite(scale) && scale > 0;
      return usable ? { label: SCREEN_LABEL } : null;
    }
    const screenData = data => data?.kinScreenCalibration === true;
    // Whether a CT's stored values give HU (the one answer the Ellipse ROI asks; the server asks the same of the saved item,
    // api/src/viewer-input.ts ctHu): a CT with no Modality LUT Sequence, a finite non-zero Rescale Slope and a finite Rescale
    // Intercept, whose Rescale Type is HU — or is not given, which in the CT Image module means HU (PS3.3 C.8.2.1: Rescale Type is
    // required only when it is not HU or the acquisition is multi-energy), unless Multi-energy CT Acquisition is YES.
    function ctHu(image) {
      const finite = n => (typeof n === 'number' || typeof n === 'string' && n.trim() !== '') && Number.isFinite(Number(n));
      const one = v => Array.isArray(v) ? (v.length === 1 ? v[0] : '?') : v;
      const text = v => v === undefined || v === null ? '' : typeof v === 'string' ? v.trim() : '?';
      const type = text(one(image?.RescaleType)), multi = text(one(image?.MultienergyCTAcquisition ?? image?.['00189361']));
      return image?.Modality === 'CT' && !image.ModalityLUTSequence && finite(image.RescaleSlope) && Number(image.RescaleSlope) !== 0 &&
        finite(image.RescaleIntercept) && (type === 'HU' || type === '' && (multi === '' || multi === 'NO'));
    }
    // A screen-calibrated Length's words: its value in the calibrated unit the tool computed for its current points, or why not.
    function screenText(data, target) {
      const id = target.startsWith('imageId:') && target.slice(8);
      if (!id) return [kinText("지원하지 않는 측정 평면입니다")];
      if (!screenCalibration(id, 'length')) return [NO_SPACING];
      if (!freshStats(data, target)) return [kinText("재확인 필요: 현재 좌표로 계산되지 않았습니다")];
      const s = data.cachedStats[target], value = s?.length;
      if (!Number.isFinite(value) || value <= 0 || typeof s.unit === 'string' && /^px/i.test(s.unit)) return [kinText("측정을 완료하세요")];
      return [(Math.round(value * 10) / 10).toFixed(1) + ' mm', kinText(SCREEN_LABEL)];
    }
    // A reason the reader must see where the press was: over the cell, for a few seconds (the panel may be folded away).
    const cellNotes = new Set();
    function cellNote(element, text) {
      if (!text || typeof element?.getBoundingClientRect !== 'function') return;
      const box = element.getBoundingClientRect();
      let note = [...cellNotes].find(n => n.kinCell === element);
      if (!note) {
        note = document.createElement('div'); note.dataset.kinCellNote = ''; note.setAttribute('role', 'status'); note.kinCell = element;
        cellNotes.add(note);
      }
      note.textContent = text;
      note.style.cssText = 'position:fixed;z-index:41;left:' + Math.round(box.left + box.width / 2) + 'px;top:' + Math.round(box.top + 8) +
        'px;transform:translateX(-50%);max-width:' + Math.max(160, Math.round(box.width - 16)) + 'px;background:#3a1d1d;color:#ffd7d7;' +
        'border:1px solid #ff6b6b;border-radius:6px;padding:4px 8px;font:13px sans-serif;pointer-events:none';
      document.body.append(note);
      clearTimeout(note.kinTimer);
      note.kinTimer = setTimeout(() => { note.remove(); cellNotes.delete(note); }, 4000);
    }
    // A point of a mark on a projection X-ray measured in the viewer's plane (geometry.viewerPlane) counts only where it was
    // placed or moved while its cell showed that very image in that very plane: the image the cell last finished rendering
    // is the mark's own SOP (viewer-info-bar.js — the requested image changes before its pixels do), and the drawn spacing,
    // orientation and origin are the original's exactly. A point set when that is not confirmed gives no value and no SR.
    const PLANE_UNCONFIRMED = kinText("화면에 그려진 영상을 확인할 수 없어 이 점으로 재지 않습니다");
    const unconfirmedPoints = new Set();
    const pointKey = (imageId, point) => imageId + '|' + JSON.stringify(point);
    function planeConfirmed(viewport, imageId, geometry) {
      try {
        const tags = cs.metaData.get('instance', imageId), shown = window.KinViewerInfoBar?.identity?.(services, viewport?.id)?.instance;
        if (viewport?.type !== 'stack' || !tags || !shown || shown.SOPInstanceUID !== tags.SOPInstanceUID || viewport.getCurrentImageId?.() !== imageId) return false;
        const drawn = viewport.getImageData?.(), same = (a, b) => !!a && b.every((n, i) => Number(a[i]) === n);
        return same(drawn?.spacing, [geometry.spacing[1], geometry.spacing[0]]) && same(drawn?.direction, geometry.orientation) && same(drawn?.origin, geometry.origin);
      } catch (_) { return false; }
    }
    // The cell where the point was set, and every other cell showing the same image: the tool reports a move from whichever
    // cell recalculates first, so a cell drawing the image in another plane cannot be told apart from it.
    function everyCellConfirmed(viewport, imageId, geometry) {
      let others; try { others = cs.getEnabledElements().map(e => e?.viewport).filter(v => v && v !== viewport && v.getCurrentImageId?.() === imageId); } catch (_) { return false; }
      return !!viewport && planeConfirmed(viewport, imageId, geometry) && others.every(v => planeConfirmed(v, imageId, geometry));
    }
    // Every placement and move of a Length, Angle or Ellipse point: the tool reports each as a modification, with its cell.
    // (The first press is checked where the tool adds the mark.)
    function pointsPlaced(event) {
      const a = event.detail?.annotation, kind = kinds[a?.metadata?.toolName];
      if (!a || !manual(kind) || !Array.isArray(a.data?.handles?.points)) return;
      const id = a.metadata.referencedImageId;
      let geometry; try { geometry = planar(id, kind); } catch (_) { return; }
      if (!geometry?.viewerPlane) return;
      let viewport; try { viewport = cs.getRenderingEngine?.(event.detail.renderingEngineId)?.getViewport?.(event.detail.viewportId); } catch (_) { viewport = null; }
      if (!everyCellConfirmed(viewport, id, geometry)) for (const point of a.data.handles.points) unconfirmedPoints.add(pointKey(id, point));
    }    function measurementReason(imageId, kind, points) {
      const image = cs.metaData.get('instance', imageId);
      const finite = n => (typeof n === 'number' || typeof n === 'string' && n.trim() !== '') && Number.isFinite(Number(n));
      if (noSpacing(imageId, kind)) return screenCalibration(imageId, kind) ? '' : NO_SPACING;
      try {
        const geometry = planar(imageId, kind);
        if (geometry) {
          const plane = cs.metaData.get('imagePlaneModule', imageId);
          // A projection X-ray measured in the viewer's plane (geometry.viewerPlane): the Calibration tool writes its
          // calibrated-spacing metadata before the image is loaded again, and the viewer then places new points with it.
          let calibrated; try { calibrated = geometry.viewerPlane && cs.metaData.get('calibratedPixelSpacing', imageId)?.type; } catch (_) { calibrated = undefined; }
          // An ultrasound region's Length (kinManualGeometry) is shown in pixels: each display spacing reads as 1 (none
          // given counts as 1, as the Measure menu reads it), and only a region or "uncalibrated" answer is no calibration.
          const shown = n => Number(n) > 0 ? Number(n) : 1;
          if (geometry.calculator === 'kin-planar-manual-v1:us' ? cs.cache.getImage(imageId)?.calibration?.type || calibrated && !['Region', 'Uncalibrated'].includes(calibrated) ||
                shown(plane?.rowPixelSpacing) !== 1 || shown(plane?.columnPixelSpacing) !== 1 :
              cs.cache.getImage(imageId)?.calibration?.type || calibrated || Number(plane?.rowPixelSpacing) !== geometry.spacing[0] || Number(plane?.columnPixelSpacing) !== geometry.spacing[1])
            return kinText("표시 간격과 원본 간격이 일치하지 않습니다");
          if (geometry.viewerPlane && points?.some(point => unconfirmedPoints.has(pointKey(imageId, point)))) return PLANE_UNCONFIRMED;
          if (points) geometry.measure(kind, points);
          return '';
        }
      } catch (error) { return error.message; }
      if (image?.Modality === 'MG' && kind === 'length') {
        try {
          const mg = kinMgGeometry(image, reference(imageId)?.frame);
          if (!mg || cs.cache.getImage(imageId)?.calibration?.type) return kinText("MG 원본 간격·보정을 확인할 수 없습니다");
          const plane = cs.metaData.get('imagePlaneModule', imageId);
          if (Number(plane?.rowPixelSpacing) !== mg.spacing[0] || Number(plane?.columnPixelSpacing) !== mg.spacing[1])
            return kinText("표시 간격과 MG 원본 간격이 일치하지 않습니다");
          points?.forEach(mg.imagePoint);
          return '';
        } catch (error) { return error.message; }
      }
      const spacing = image?.PixelSpacing, orientation = image?.ImageOrientationPatient, origin = image?.ImagePositionPatient;
      if (image?.SOPClassUID !== '1.2.840.10008.5.1.4.1.1.2' || image.Modality !== 'CT' || Number(image.NumberOfFrames || 1) !== 1)
        return kinText("일반 CT 원본 프레임에서 지원합니다");
      if (!Array.isArray(spacing) || spacing.length !== 2 || spacing.some(n => !finite(n) || Number(n) <= 0) ||
          !Array.isArray(orientation) || orientation.length !== 6 || orientation.some(n => !finite(n)) ||
          !Array.isArray(origin) || origin.length !== 3 || origin.some(n => !finite(n)) || !image.FrameOfReferenceUID ||
          image.PixelSpacingCalibrationType || cs.cache.getImage(imageId)?.calibration?.type) return kinText("원본 좌표·간격·보정을 확인할 수 없습니다");
      const dot = (a, b) => a.reduce((s, n, i) => s + n * b[i], 0);
      const u = orientation.slice(0, 3).map(Number), v = orientation.slice(3).map(Number);
      const normal = [u[1]*v[2]-u[2]*v[1], u[2]*v[0]-u[0]*v[2], u[0]*v[1]-u[1]*v[0]];
      if (Math.max(Math.abs(dot(u,u)-1), Math.abs(dot(v,v)-1), Math.abs(dot(u,v))) > 1e-4) return kinText("원본 방향이 올바르지 않습니다");
      if (kind === 'ellipse') {
        if (!ctHu(image)) return kinText("HU 보정을 확인할 수 없습니다");
        const axis = a => a.filter(n => Math.abs(n) > 1e-6).length === 1;
        if (!axis(normal) || points?.length === 4 && (!axis(points[0].map((n,i)=>n-points[1][i])) || !axis(points[3].map((n,i)=>n-points[2][i]))))
          return kinText("사선·회전 ROI는 아직 지원하지 않습니다");
      }
      if (points?.some(p => {
        if (!Array.isArray(p) || p.length !== 3 || p.some(n => !Number.isFinite(n))) return true;
        const d = p.map((n,i)=>n-Number(origin[i])), x=dot(d,u)/Number(spacing[1]), y=dot(d,v)/Number(spacing[0]);
        return Math.abs(dot(d,normal)) > .001 || x < -.501 || y < -.501 || x > Number(image.Columns)-.499 || y > Number(image.Rows)-.499;
      })) return kinText("측정이 원본 영상 범위를 벗어났습니다");
      return '';
    }
    // A value of the planar geometry in one decimal on the cell and in the Measurements panel. An ultrasound region's Length
    // is rounded as its saved value is said (finding-link-model.js valueText), so the cell, the panel, the History and the
    // Findings give the same number; the others keep the words they had.
    const planarText = (geometry, value) => geometry.calculator === 'kin-planar-manual-v1:us' ? (Math.round(value * 10) / 10).toFixed(1) : value.toFixed(1);
    const calculatedGeometry = new WeakMap(), trackedMeasurements = new WeakSet();
    const geometry = data => JSON.stringify(data.handles.points);
    const freshStats = (data, target) => {
      const stats = data.cachedStats?.[target];
      return stats && calculatedGeometry.get(stats) === geometry(data);
    };
    function trackMeasurement(a) {
      if (!manual(kinds[a.metadata.toolName]) || trackedMeasurements.has(a.data.cachedStats)) return;
      // The pinned calculator clears invalidated even when its image lookup
      // fails. Only a newly assigned native result witnesses these coordinates;
      // the existing trailing throttle and native voxel calculation stay intact.
      a.data.cachedStats = new Proxy(a.data.cachedStats || {}, {
        set(stats, target, value) {
          stats[target] = value;
          if (value && typeof value === 'object') calculatedGeometry.set(value, geometry(a.data));
          return true;
        },
      });
      // Calibration replaces cachedStats while keeping data. Reattach to that
      // new cache; existing values gain no witness until native recalculation.
      trackedMeasurements.add(a.data.cachedStats);
    }
    function sample(a) {
      if (!a || a.invalidated) return null;
      // A screen calibration is no value to save, send or export (the one rule above).
      if (screenData(a.data) || screenCalibration(a.metadata.referencedImageId, kinds[a.metadata.toolName])) return null;
      const kind = kinds[a.metadata.toolName], target = 'imageId:' + a.metadata.referencedImageId, s = a.data.cachedStats?.[target];
      if (!freshStats(a.data, target) || measurementReason(a.metadata.referencedImageId, kind, a.data.handles.points)) return null;
      const geometry = planar(a.metadata.referencedImageId, kind);
      if (geometry) return { calculator: geometry.calculator, values: [geometry.measure(kind, a.data.handles.points)] };
      const values = kind === 'length' ? [s.length] : kind === 'angle' ? [s.angle] :
        [s.area, s.mean, s.statsArray?.find(x => x?.name === 'min')?.value, s.max, s.statsArray?.find(x => x?.name === 'count')?.value];
      if (values.some(n => !Number.isFinite(n)) || kind === 'ellipse' && s.modalityUnit !== 'HU') return null;
      const mg = kind === 'length' && kinMgGeometry(cs.metaData.get('instance', a.metadata.referencedImageId), reference(a.metadata.referencedImageId)?.frame);
      return mg ? { calculator: mg.calculator, values: [mg.length(a.data.handles.points)] } : { calculator: 'kin-native-manual-v1', values };
    }
    const measurementService = services.measurementService;
    const originalMeasurements = measurementService.getMeasurements;
    // This panel's own clean-up of a drawing's OHIF row goes round the guard below that takes the Measurements panel's
    // delete for the reader's (readerDelete).
    const nativeRemove = measurementService.remove;
    const ownRemove = uid => nativeRemove.call(measurementService, uid);
    const numericMeasurement = m => manual(kinds[m?.toolName]);
    const unverifiedReport = () => ({ columns: ['Verification'], values: ['재확인 필요'] });
    function checkedMeasurement(m) {
      if (!m || ended || suspended || held()) return null;
      const a = ct.annotation.state.getAnnotation(m.uid);
      if (!a || a.data.kinUnverified || !sample(a)) return null;
      const mapping = measurementService.getSourceMappings(m.source?.name, m.source?.version)
        ?.find(x => x.annotationType === a.metadata.toolName);
      if (!mapping) return null;
      // Native CSV functions capture numbers at mapping time. Map the current
      // verified target on every read, including a previously captured export.
      const target = 'imageId:' + a.metadata.referencedImageId;
      try {
        const mg = a.metadata.toolName === 'Length' && kinMgGeometry(cs.metaData.get('instance', a.metadata.referencedImageId), reference(a.metadata.referencedImageId)?.frame);
        const checked = mapping.toMeasurementSchema({ annotation: { ...a, data: {
          ...a.data, cachedStats: { [target]: { ...a.data.cachedStats[target], ...(mg ? { length: mg.length(a.data.handles.points) } : {}) } },
        } } });
        if (mg) {
          // The basis name is drawn in the screen's language; the report keeps it as written.
          checked.displayText = { ...checked.displayText, primary: [...(checked.displayText?.primary || []), kinText(mg.label)] };
          const report = checked.getReport;
          checked.getReport = () => { const r = report(); return { ...r, columns: [...r.columns, 'Measurement basis'], values: [...r.values, mg.label] }; };
        }
        const kind = kinds[a.metadata.toolName], geometry = planar(a.metadata.referencedImageId, kind);
        if (geometry) {
          const value = geometry.measure(kind, a.data.handles.points), unit = kind === 'angle' ? '°' : kind === 'ellipse' ? 'mm²' : 'mm';
          checked.displayText = { primary: [planarText(geometry, value) + ' ' + unit, kinText(geometry.label)], secondary: [] };
          // An ultrasound region's Length names its original frame too (a cine's frames share the SOP).
          const frame = geometry.calculator === 'kin-planar-manual-v1:us' ? reference(a.metadata.referencedImageId)?.frame : undefined;
          checked.getReport = () => frame === undefined ? { columns: [kind, 'Unit', 'Measurement basis'], values: [value, unit, geometry.label] } :
            { columns: [kind, 'Unit', 'Measurement basis', 'Frame'], values: [value, unit, geometry.label, frame] };
        }
        return checked;
      } catch (_) { return null; } // Display sets may disappear before their metadata.
    }
    // A Freehand ROI tool instance (any group's: it reads a target's image the same way), for the Measurements panel's words.
    let freehandTool = null;
    // The Measurements panel and its CSV read a Freehand ROI's area from the tool's own numbers, in "mm²" even where the original
    // gives no spacing. Where the original gives none (spacingless) the row says the outline as the cell does (freehandMeasure's
    // px): a closed outline's area in px², an open line's length in px, and no number when it cannot be measured; anywhere
    // else the row is the tool's own.
    const roundTwo = x => Math.round(x * 100) / 100;
    function freehandView(m) {
      const a = freehandTool && ct.annotation.state.getAnnotation(m.uid);
      if (!a?.data?.contour || !spacingless(cs.metaData.get('instance', a.metadata.referencedImageId))) return m;
      const measure = () => { const found = freehandMeasure(freehandTool, a.data, 'imageId:' + a.metadata.referencedImageId); return found?.unit === 'px' ? found : null; };
      const found = measure();
      const said = !found ? [] : found.area !== undefined ? [roundTwo(found.area) + ' px²'] : [roundTwo(found.length) + ' px'];
      const rest = Array.isArray(m.displayText?.primary) ? m.displayText.primary.slice(1) : [];
      return { ...m, displayText: { ...m.displayText, primary: [...said, ...rest] }, getReport: () => freehandReport(m, measure()) };
    }
    // The CSV row: the pinned report names its customised columns by a key its entries do not have, so they come out unnamed
    // and the CSV keeps only the last of them. The area entry and the unit entry (found by their place, after AnnotationType,
    // in the 'cornerstone.measurements' customisation, or by the names "Area" and "Unit") are named "Area" and "Area unit"
    // and hold the outline's area in px² — or "not available" for an open line or an outline that cannot be measured.
    function freehandReport(m, found) {
      let report; try { report = m.getReport?.(); } catch (_) { report = null; }
      report = report || { columns: [], values: [] };
      const columns = [...report.columns], values = [...report.values];
      let entries; try { entries = services.customizationService?.get?.('cornerstone.measurements')?.PlanarFreehandROI?.report; } catch (_) { entries = null; }
      const place = (value, name) => {
        const k = Array.isArray(entries) ? entries.findIndex(e => e?.value === value) : -1;
        if (k >= 0 && columns[0] === 'AnnotationType' && k + 1 < columns.length) return k + 1;
        const i = columns.findIndex(c => typeof c === 'string' && c.toLowerCase() === name);
        if (i >= 0) return i;
        columns.push(null); values.push(null); return columns.length - 1;
      };
      const area = place('area', 'area'), unit = place('unit', 'unit'), known = found?.area !== undefined;
      columns[area] = 'Area'; values[area] = known ? found.area : 'not available';
      columns[unit] = 'Area unit'; values[unit] = known ? 'px²' : 'not available';
      return { ...report, columns, values };
    }
    function projectMeasurement(m) {
      if (m?.toolName === 'PlanarFreehandROI') return freehandView(m);
      if (!numericMeasurement(m)) return m;
      const mark = ct.annotation.state.getAnnotation(m.uid);
      // The measurement list and its CSV show a screen-calibrated Length as the cell does, and export no number for it.
      if (screenData(mark?.data)) return { ...m, data: null,
        displayText: { primary: screenText(mark.data, 'imageId:' + mark.metadata.referencedImageId), secondary: [] },
        getReport: () => ({ columns: ['Verification'], values: [SCREEN_LABEL] }) };
      const checked = checkedMeasurement(m);
      return { ...m, ...(checked || { data: null,
        displayText: { primary: [kinText("재확인 필요")], secondary: [] } }),
        getReport: () => {
          const current = measurementService.getMeasurement(m.uid);
          return checkedMeasurement(current)?.getReport?.() || unverifiedReport();
        },
      };
    }
    const measurementViews = new Map(), measurementViewReads = new Set();
    const viewSignature = view => JSON.stringify([view.displayText, view.points]);
    const projectedMeasurements = function (...args) {
      return originalMeasurements.apply(this, args).map(m => {
        const view = projectMeasurement(m);
        // Native panel/CSV reads can happen between observation ticks. Track
        // the view actually returned, or a short unverified interval can leave
        // the panel stale when the next tick matches its older good signature.
        if (numericMeasurement(m) && measurementViews.get(m.uid) !== viewSignature(view)) measurementViewReads.add(m.uid);
        return view;
      });
    };
    measurementService.getMeasurements = projectedMeasurements;
    function refreshMeasurementViews() {
      const present = new Set();
      for (const m of originalMeasurements.call(measurementService)) {
        if (!numericMeasurement(m)) continue;
        present.add(m.uid);
        const view = projectMeasurement(m), signature = viewSignature(view);
        if (measurementViews.get(m.uid) === signature && !measurementViewReads.has(m.uid)) continue;
        measurementViewReads.delete(m.uid);
        measurementViews.set(m.uid, signature);
        // Publish a view refresh without removing the annotation or changing
        // geometry at the source (the native handler ignores false updates).
        measurementService.update(m.uid, m, false);
      }
      for (const uid of measurementViews.keys()) if (!present.has(uid)) { measurementViews.delete(uid); measurementViewReads.delete(uid); }
    }
    const reportContext = 'CORNERSTONE_STRUCTURED_REPORT', reportRestores = [], srRequests = new Map();
    function srItemMessage(m, reason) {
      const e = annotations.get(m?.uid), a = m?.uid && ct.annotation.state.getAnnotation(m.uid);
      const label = String(e?.draft?.label || m?.label || names[kinds[a?.metadata?.toolName]] || m?.toolName || kinText("측정")).slice(0, 80);
      const frame = e?.draft?.frame || m?.frameNumber;
      return kinText("재확인 필요: {0}{1} [{2}] — {3} SR에 포함할 항목을 명시적으로 다시 선택하세요.", label, (frame ? kinText(" · 프레임 {0}", frame) : ''), String(m?.uid || kinText("항목 없음")).slice(0, 12), reason);
    }
    function srVerificationMessage(m) {
      const e = annotations.get(m?.uid), a = m?.uid && ct.annotation.state.getAnnotation(m.uid);
      const reason = e?.head && e.head.referenceStatus !== 'verified' ? kinText("원본 다시 확인을 누르세요.") :
        !a ? kinText("현재 영상의 측정 표식을 찾을 수 없습니다.") :
        !a.data?.handles?.points ? kinText("측정 위치가 완성되지 않았습니다. 측정을 마치세요.") :
        screenData(a.data) ? SCREEN_SR :
        measurementReason(a.metadata.referencedImageId, kinds[a.metadata.toolName], a.data.handles.points) ||
        (a.data.kinUnverified ? kinText("저장 당시 측정과 다릅니다. 편집 후 다시 측정하세요.") :
          !sample(a) ? kinText("현재 위치의 계산이 완료되지 않았습니다. 측정을 마치고 다시 시도하세요.") : kinText("현재 영상의 측정 변환을 확인할 수 없습니다."));
      return srItemMessage(m, reason);
    }
    let srBusy = false;
    async function manualSr(name, options) {
      if (srBusy) throw kinError("SR을 처리 중입니다. 결과를 기다려 주세요.");
      const selected = options.measurementData || [], ticket = generation; let requestKey;
      if (ended || !selected.length || selected.length > 16) throw kinError("직접 작성한 측정을1~16개 선택하세요.");
      srBusy = true; refreshSrButtons();
      try {
        await authenticate(ticket);
        const chosen = selected.map(m => annotations.get(m.uid));
        const invalid = chosen.findIndex(e => !e || !manual(e.draft.kind) || !writable(e) || e.heldDraft || e.head?.hidden);
        if (invalid !== -1)
          throw new Error(srItemMessage(selected[invalid], kinText("현재 검사에서 직접 작성한 측정만 SR로 저장할 수 있습니다. 숨김이나 보관 중인 수정도 먼저 정리하세요.")));
        for (const [i, e] of chosen.entries()) {
          if (!checkedMeasurement(measurementService.getMeasurement(e.annotationUID))) throw new Error(srVerificationMessage(selected[i]));
          if (e.editing || e.pending || !e.head) await save(e, e.head ? 'edit' : 'create');
          if (!valid(ticket) || !e.head || e.editing || e.pending || e.busy || e.head.referenceStatus !== 'verified')
            throw new Error(srItemMessage(selected[i], kinText("측정 저장을 완료하지 못했습니다. 측정 패널의 안내를 확인하세요.")));
        }
        const items = chosen.map(e => ({ id: e.head.id, revision: e.head.revision })).sort((a,b) => a.id.localeCompare(b.id));
        const key = scope + '|' + subject + '|' + JSON.stringify(items);
        requestKey = key;
        if (!srRequests.has(key)) srRequests.set(key, crypto.randomUUID());
        const stillCurrent = () => valid(ticket) && chosen.every((e, i) => !e.editing && !e.pending && !e.heldDraft &&
          items.some(item => item.id === e.head?.id && item.revision === e.head?.revision) && checkedMeasurement(measurementService.getMeasurement(e.annotationUID)));
        const endpoint = '/studies/' + scope + '/manual-sr';
        status.textContent = kinText("원본 측정으로 SR을 확인하고 있습니다…");
        const prepared = await api(endpoint, { method: 'POST', body: JSON.stringify({ requestId: srRequests.get(key), items }) }, ticket);
        if (!stillCurrent()) throw kinError("SR 준비 중 측정이 변경되었습니다. 현재 측정을 다시 확인하세요.");
        if (name === 'downloadReport') {
          const bytes = Uint8Array.from(atob(prepared.dicom), c => c.charCodeAt(0));
          const url = URL.createObjectURL(new Blob([bytes], { type: 'application/dicom' }));
          const a = document.createElement('a'); a.href = url; a.download = 'HALO-PACS-manual-' + prepared.id + '.dcm';
          document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
          status.textContent = kinText("SR 파일을 다운로드했습니다. 검사에 저장하려면24시간 안에 SR 저장을 누르세요.");
          return prepared.dataset;
        }
        const stored = await api(endpoint + '/' + prepared.id + '/store', { method: 'POST', body: '{}' }, ticket);
        if (!stillCurrent()) throw kinError("SR 저장 응답을 받았습니다. 최신 측정과 저장 문서를 다시 확인하세요.");
        const source = extensions.getActiveDataSource?.()[0];
        source?.deleteStudyMetadataPromise?.(scope);
        // Public display-set API dispatches the pinned SR SOP handler; no
        // webpack module IDs or global DICOM serializer hooks are required.
        services.displaySetService.makeDisplaySets([stored.dataset], true);
        services.displaySetService.getActiveDisplaySets().find(ds => ds.SeriesInstanceUID === stored.dataset.SeriesInstanceUID)?.kinSelectDocument?.(stored.dataset.SOPInstanceUID);
        status.textContent = kinText("SR 저장 완료 · 검사 목록에서 원문을 다시 열 수 있습니다.");
        return stored.dataset;
      } catch (error) {
        if (error.status === 410 && requestKey) srRequests.delete(requestKey);
        if (valid(ticket)) {
          const message = error.message || (error.status === 410 ? kinText("SR 준비 파일의24시간 보관 기한이 지났습니다. 다시 누르면 새 파일을 준비합니다.") : error.status === 409 ? kinText("측정이 변경되었거나 원본 재확인이 필요합니다.") : kinText("SR 처리를 완료하지 못했습니다. 같은 동작으로 다시 시도하세요."));
          status.textContent = message; services.uiNotificationService.show({ title: 'SR', message, type: 'warning' });
        }
        throw error;
      } finally { srBusy = false; refreshSrButtons(); }
    }
    for (const name of ['downloadReport', 'storeMeasurements']) {
      const original = commands?.getCommand(name, reportContext);
      if (!original) continue;
      const guarded = { ...original, commandFn: options => {
        if (!writer()) {
          const message = closedText('sr');
          status.textContent = message;
          services.uiNotificationService.show({ title: 'SR', message, type: 'warning' });
          throw new Error(message);
        }
        const blocked = options.measurementData?.find(m => {
          const a = ct.annotation.state.getAnnotation(m.uid), current = measurementService.getMeasurement(m.uid);
          if (!numericMeasurement(m) && !numericMeasurement(current) && !manual(kinds[a?.metadata.toolName])) return false;
          // The pinned SR adapters use imageId:referencedImageId. An abandoned
          // volume target must not prevent export of the verified source frame.
          return !checkedMeasurement(current);
        });
        if (blocked || ended || suspended || recovery.has(scope)) {
          const message = ended ? kinText("로그인이 종료되었습니다. 다시 로그인한 뒤 뷰어를 여세요.") :
            suspended || recovery.has(scope) ? kinText("현재 검사 접근을 확인하고 보관 작업을 재개한 후 SR을 생성하세요.") :
            srVerificationMessage(blocked);
          status.textContent = message;
          services.uiNotificationService.show({ title: kinText("측정 확인"), message, type: 'warning' });
          throw new Error(message);
        }
        return manualSr(name, options);
      } };
      commands.registerCommand(reportContext, name, guarded);
      reportRestores.push(() => { if (commands.getCommand(name, reportContext) === guarded) commands.registerCommand(reportContext, name, original); });
    }
    // S5-U2b-R-001 F01 · R-002 F01. writer로 확인되지 않은 문서(답 없음·오류·401/403·clinician-only)에서는 뷰어 자체의 작성
    // 경로를 닫는다. 주 마우스 도구로 켤 수 있는 것은 영상 조작(W/L·이동·확대·넘기기·3D 회전·MPR 교차선·돋보기)뿐이고, 나머지
    // 도구는 이미 그려진 표식을 보여 주기만 하도록(Enabled) 둔다. 도구막대·단축키·명령·다른 확장의 전환은 모두 도구 그룹의
    // setToolActive/setToolPassive로 끝나므로 그 둘을 그룹마다 지키고, 모드 없이 도구에 바로 닿는 addNewAnnotation은 도구가
    // 스스로 거절한다. 그룹은 모드가 이 확장보다 나중에 만들고 /me 답은 그보다 늦을 수 있어, 만들어질 때 감싸 두고 매 관찰마다
    // 다시 맞춘다. 막는 동안 모드가 정한 모드는 적어 두었다가 writer 답이 오면 되돌린다(도구막대도 같다). 화면 정책일 뿐 서버
    // 권한을 대신하지 않는다.
    const VIEW_TOOLS = new Set(['WindowLevel', 'Pan', 'Zoom', 'StackScroll', 'TrackballRotate', 'Crosshairs', 'Magnify']);
    // The pinned longitudinal mode's measurement and annotation tools (its toolbar and initToolGroups). In a document that is not a
    // confirmed writer, a mark of one of these that this panel did not draw from a saved head is removed; SR display ('kin-sr:'),
    // reference lines and crosshairs keep their own state.
    const NATIVE_MARKS = new Set(['ArrowAnnotate', 'Length', 'Angle', 'Bidirectional', 'RectangleROI', 'EllipticalROI', 'CircleROI', 'Probe',
      'DragProbe', 'CobbAngle', 'CalibrationLine', 'PlanarFreehandROI', 'SplineROI', 'LivewireContour', 'UltrasoundDirectionalTool',
      'WindowLevelRegion', 'PlanarFreehandContourSegmentation', 'AdvancedMagnify', tools.text, tools.memo, tools.spine, tools.circle,
      ...Object.keys(ORTHO).map(kind => tools[kind]), tools.ctr, tools.parallel, tools.ratio, tools.centreAngle, tools.volume]);
    const PRIMARY = ct.Enums?.MouseBindings?.Primary ?? 1;
    // Astra S5-U2b-X2-R-001 F01: an ended panel (401/403, logout, another account) keeps authoring closed whatever the shared state says.
    const nativeAuthoringClosed = () => ended || !writer();
    const guardedGroups = new Map(), guardedTools = new Map(), policyRestores = [];
    // The pinned press handlers select whatever a tool hands back and read its annotationUID unchecked, so a refusal that
    // hands back nothing raises there and the viewer shows its general error notice over the reason given here. A refusal
    // hands back this empty stand-in: no annotation is made, nothing is selected and nothing is raised.
    const refused = Object.freeze({});
    function guardTool(name, tool) {
      if (!tool || VIEW_TOOLS.has(name) || typeof tool.addNewAnnotation !== 'function' || guardedTools.has(tool)) return;
      const add = tool.addNewAnnotation, own = Object.hasOwn(tool, 'addNewAnnotation');
      const guarded = function (...args) {
        if (nativeAuthoringClosed()) { status.textContent = closedText('tool'); return refused; }
        return add.apply(this, args);
      };
      tool.addNewAnnotation = guarded;
      guardedTools.set(tool, () => { if (tool.addNewAnnotation === guarded) { if (own) tool.addNewAnnotation = add; else delete tool.addNewAnnotation; } });
    }
    function guardGroup(group) {
      if (!group || ['setToolActive', 'setToolPassive', 'setToolEnabled'].some(name => typeof group[name] !== 'function')) return null;
      if (guardedGroups.has(group)) return guardedGroups.get(group);
      const active = group.setToolActive, passive = group.setToolPassive, addTool = group.addTool;
      // What the mode or the viewer asked for a tool this policy kept Enabled; the writer answer gives it back.
      const intended = new Map();
      let viewing = 'WindowLevel';
      // 네이티브 전환은 새 도구를 켜기 전에 이전 주 도구를 먼저 내려 두므로, 거절한 뒤에는 마지막 영상 조작 도구를 다시 켠다.
      const keepViewing = () => {
        if (!group.getActivePrimaryMouseButtonTool?.() && group.hasTool?.(viewing)) active.call(group, viewing, { bindings: [{ mouseButton: PRIMARY }] });
      };
      const onActive = function (name, options, ...rest) {
        if (!nativeAuthoringClosed() || VIEW_TOOLS.has(name)) {
          if (VIEW_TOOLS.has(name) && options?.bindings?.some(b => b?.mouseButton === PRIMARY && !b.modifierKey)) viewing = name;
          return active.call(group, name, options, ...rest);
        }
        intended.set(name, { mode: 'Active', bindings: [...(options?.bindings || [])] });
        status.textContent = closedText('tool'); keepViewing();
      };
      const onPassive = function (name, ...rest) {
        if (!nativeAuthoringClosed() || VIEW_TOOLS.has(name)) return passive.call(group, name, ...rest);
        intended.set(name, { mode: 'Passive', bindings: [] }); return group.setToolEnabled(name);
      };
      const onAddTool = typeof addTool === 'function' && function (name, ...rest) {
        const result = addTool.call(this, name, ...rest);
        guardTool(name, group.getToolInstance?.(name)); return result;
      };
      group.setToolActive = onActive; group.setToolPassive = onPassive;
      if (onAddTool) group.addTool = onAddTool;
      for (const name of Object.keys(group.toolOptions || {})) guardTool(name, group.getToolInstance?.(name));
      const record = { keepViewing, intended,
        reopen() {
          for (const [name, want] of intended) {
            if (group.toolOptions?.[name]?.mode !== 'Enabled') continue;
            // A refused primary activation is not replayed: the viewing tool keeps the primary button and the user picks the tool again.
            const bindings = want.bindings.filter(b => b?.mouseButton !== PRIMARY || b.modifierKey);
            if (want.mode === 'Active' && bindings.length) active.call(group, name, { bindings }); else passive.call(group, name);
          }
          intended.clear();
        },
        restore() {
          if (group.setToolActive === onActive) group.setToolActive = active;
          if (group.setToolPassive === onPassive) group.setToolPassive = passive;
          if (onAddTool && group.addTool === onAddTool) group.addTool = addTool;
        } };
      guardedGroups.set(group, record); return record;
    }
    function enforceTools() {
      const manager = ct.ToolGroupManager, groups = new Set(typeof manager?.getAllToolGroups === 'function' ? manager.getAllToolGroups() : []);
      const v = viewport(), own = v && manager?.getToolGroupForViewport?.(v.id, v.renderingEngineId);
      if (own) groups.add(own);
      for (const group of groups) {
        const record = guardGroup(group); if (!record) continue;
        let demoted = false;
        for (const [name, options] of Object.entries(group.toolOptions || {})) {
          // A tool added around group.addTool (an extension's addToolInstance) gets the instance guard here.
          guardTool(name, group.getToolInstance?.(name));
          if (!VIEW_TOOLS.has(name) && (options?.mode === 'Active' || options?.mode === 'Passive')) {
            record.intended.set(name, { mode: options.mode, bindings: [...(options.bindings || [])] });
            group.setToolEnabled(name); demoted = true;
          }
        }
        if (demoted) record.keepViewing();
      }
    }
    // 도구막대: 작성 도구를 켜는 버튼·묶음 항목을 없앤다(비활성 버튼으로 남기지 않는다). 버튼 정의와 평가·명령 연결은 뷰어의 것을
    // 그대로 쓰고, 모드가 버튼을 다시 넣을 때마다(모드 재진입 포함) 같은 규칙으로 다시 줄인다. 줄이기 전의 버튼·구역은 적어 두었다가
    // writer 답이 오면 그대로 되돌린다.
    const ACTIVATING = ['setToolActiveToolbar', 'setToolActive', 'toggleActiveDisabledToolbar'];
    // S5-UI5 (F#4). Capture(showDownloadViewportModal)는 보이는 화면을 이 브라우저에서 PNG로 내려받는 동작이라 서버에 대응하는
    // 기록·권한 검사가 없다. 화면 정책일 뿐 권한이 아니며 clinician-only 문서에서만 뺀다(exporting, 아래 exportClosed).
    const SCREEN_EXPORT = ['showDownloadViewportModal'];
    const authoring = (button, exporting = true) => [button?.commands].flat().some(command => {
      const name = typeof command === 'string' ? command : command?.commandName;
      return exporting && SCREEN_EXPORT.includes(name) || ACTIVATING.includes(name) && !VIEW_TOOLS.has(command?.commandOptions?.toolName ?? button.id);
    });
    const TOOLBAR = ['getButtons', 'removeButton', 'addButtons', 'clearButtonSection', 'createButtonSection'];
    // OHIF refreshToolbarState clones definitions with object spread. Ownership
    // must survive that refresh so a writer gets the full tool group back.
    const trimmed = new Set(), originals = new Map(), sectionOriginals = new Map(), replacement = Symbol('kin-read-only-toolbar'); let trimming = false;
    // S5-UI5 fix1. Capture를 빼는 때: clinician-only, 그리고 계정이 아직 확인되지 않은 동안(안전한 기본 — writer 답이 오면 제자리로
    // 돌아온다). writer 문서의 로그인이 끝난 뒤(거절·로그아웃·다른 계정)에는 빼지 않는다. 이미 뺀 것은 writer 답 전까지 그대로라서
    // clinician-only·미확인에서 끝난 문서는 계속 없다. 끝난 문서에 다시 들어온 마운트는 역할을 알 수 없어 안전한 기본을 따른다.
    const endedAtMount = kinViewerSession.ended();
    const exportClosed = () => !writer() && (!ended || endedAtMount);
    function enforceToolbar() {
      const bar = services.toolbarService;
      if (trimming || TOOLBAR.some(name => typeof bar?.[name] !== 'function')) return;
      const replaced = [], exporting = exportClosed();
      for (const [id, button] of Object.entries(bar.getButtons() || {})) {
        if (button[replacement]) continue;
        const props = button?.props || {}, items = Array.isArray(props.items) ? props.items : null;
        if (!items) { if (authoring({ id, commands: props.commands }, exporting)) { trimmed.add(id); originals.set(id, button); } continue; }
        const kept = items.filter(item => !authoring(item, exporting));
        if (!kept.length) { trimmed.add(id); originals.set(id, button); continue; }
        if (kept.length < items.length || props.primary && authoring(props.primary, exporting)) {
          const restricted = { ...button, [replacement]: true, props: { ...props, items: kept, primary: props.primary && !authoring(props.primary, exporting) ? props.primary : kept[0] } };
          originals.set(id, button); replaced.push(restricted);
        }
      }
      const buttons = bar.getButtons() || {}, gone = [...trimmed].filter(id => buttons[id]);
      const sections = Object.entries(bar.state?.buttonSections || {}).filter(([, ids]) => Array.isArray(ids) && ids.some(id => trimmed.has(id)));
      if (!gone.length && !replaced.length && !sections.length) return;
      trimming = true;
      try {
        for (const id of [...gone, ...replaced.map(button => button.id)]) bar.removeButton(id);
        if (replaced.length) bar.addButtons(replaced);
        for (const [key, ids] of sections) {
          const applied = ids.filter(id => !trimmed.has(id));
          sectionOriginals.set(key, { original: [...ids], applied });
          bar.clearButtonSection(key); bar.createButtonSection(key, [...applied]);
        }
        bar.refreshToolbarState?.({ viewportId: services.viewportGridService.getActiveViewportId?.() });
      } finally { trimming = false; }
    }
    function reopenToolbar() {
      const bar = services.toolbarService;
      if (trimming || TOOLBAR.some(name => typeof bar?.[name] !== 'function') || !originals.size && !sectionOriginals.size) return;
      trimming = true;
      try {
        // Only what still stands as this policy left it goes back; a section or button the mode has built again since is its own.
        const current = bar.state?.buttonSections || {}, same = (a, b) => Array.isArray(a) && a.length === b.length && a.every((id, i) => id === b[i]);
        const sections = [...sectionOriginals].filter(([key, record]) => same(current[key], record.applied));
        const listed = new Set(sections.flatMap(([, record]) => record.original));
        const buttons = bar.getButtons() || {}, back = [];
        for (const [id, original] of originals) {
          if (buttons[id] ? !buttons[id][replacement] : !listed.has(id)) continue;
          if (buttons[id]) bar.removeButton(id);
          back.push(original);
        }
        if (back.length) bar.addButtons(back);
        for (const [key, record] of sections) { bar.clearButtonSection(key); bar.createButtonSection(key, [...record.original]); }
        bar.refreshToolbarState?.({ viewportId: services.viewportGridService.getActiveViewportId?.() });
      } finally { trimming = false; trimmed.clear(); originals.clear(); sectionOriginals.clear(); }
    }
    // 이 패널이 저장된 판에서 그리지 않은 작성 도구 표식(작성 경로를 모두 돌아 생긴 것 포함)은 writer가 아닌 문서에 남기지 않는다.
    function dropLocalMarks() {
      // A drawing still held by its tool is ended there first, so its listeners and the interaction lock go with it.
      leaveDrawings();
      let dropped = false;
      for (const a of ct.annotation.state.getAllAnnotations()) {
        if (!NATIVE_MARKS.has(a?.metadata?.toolName) || annotations.has(a.annotationUID) || String(a.annotationUID).startsWith('kin-sr:')) continue;
        ct.annotation.state.removeAnnotation(a.annotationUID);
        if (measurementService.getMeasurement(a.annotationUID)) ownRemove(a.annotationUID);
        dropped = true;
      }
      if (dropped) render();
    }
    function closeAuthoring() { if (nativeAuthoringClosed()) { enforceTools(); enforceToolbar(); dropLocalMarks(); } }
    function reopenAuthoring() {
      if (nativeAuthoringClosed()) return;
      for (const record of guardedGroups.values()) record.reopen();
      reopenToolbar();
    }
    // 표식 편집 메뉴와 명령: 우클릭 메뉴(Delete measurement·Add Label), 이름 입력, 측정 수정, 화살표 글 입력. 새 화살표의 글
    // 입력에는 빈 답을 주어 네이티브 도구가 그 그리기를 취소하게 하고, 이미 있는 표식의 글 고치기는 답하지 않아 그대로 둔다.
    for (const name of ['showCornerstoneContextMenu', 'deleteMeasurement', 'setMeasurementLabel', 'updateMeasurement', 'arrowTextCallback']) {
      const original = commands?.getCommand(name, 'CORNERSTONE');
      if (typeof original?.commandFn !== 'function') continue;
      const guarded = { ...original, commandFn: options => {
        // The image's "Delete measurement" on a saved mark deletes it as the row's Delete does; on a drawing not saved yet
        // the pinned command removes the drawing as before.
        if (name === 'deleteMeasurement' && readerDelete(options?.uid)) return;
        if (!nativeAuthoringClosed()) return original.commandFn(options);
        status.textContent = closedText('edit');
        if (name === 'arrowTextCallback' && !options?.data) options?.callback?.();
      } };
      commands.registerCommand('CORNERSTONE', name, guarded);
      policyRestores.push(() => { if (commands.getCommand(name, 'CORNERSTONE') === guarded) commands.registerCommand('CORNERSTONE', name, original); });
    }
    // 측정 목록 패널의 이름 바꾸기·잠금 풀기도 표식 편집이다. 사용자 편집(notYetUpdatedAtSource true)만 거절하고, 도구와의
    // 동기화(false)와 이 패널의 표시 갱신은 그대로 둔다. 목록의 Delete는 저장 항목이면 행의 Delete와 같이 지우고(readerDelete),
    // 아직 저장하지 않은 그림이면 그 그림만 지운다.
    // The Measurements panel's delete calls remove(uid) alone; the pinned tools' removal passes its source, and this panel's
    // own clean-ups call the original (ownRemove).
    {
      const guardedRemove = function (uid, ...rest) {
        if (!rest.length && readerDelete(uid)) return;
        return nativeRemove.call(this, uid, ...rest);
      };
      measurementService.remove = guardedRemove;
      policyRestores.push(() => { if (measurementService.remove === guardedRemove) measurementService.remove = nativeRemove; });
    }
    for (const [name, edits] of [['update', args => args[2] === true], ['toggleLockMeasurement', () => true]]) {
      const original = measurementService[name];
      if (typeof original !== 'function') continue;
      const guarded = function (...args) {
        if (nativeAuthoringClosed() && edits(args)) { status.textContent = closedText('edit'); return; }
        return original.apply(this, args);
      };
      measurementService[name] = guarded;
      policyRestores.push(() => { if (measurementService[name] === guarded) measurementService[name] = original; });
    }
    const groupService = services.toolGroupService, toolbarService = services.toolbarService;
    if (typeof groupService?.subscribe === 'function') {
      // TOOLGROUP_CREATED는 그룹을 만든 직후, 도구를 넣고 모드를 정하기 전에 동기로 온다: 여기서 감싸야 모드가 정하는 첫 모드부터 지킨다.
      if (groupService.EVENTS?.TOOLGROUP_CREATED) policyRestores.push(unsubscribe(groupService.subscribe(groupService.EVENTS.TOOLGROUP_CREATED,
        event => guardGroup(ct.ToolGroupManager?.getToolGroup?.(event?.toolGroupId)))));
      // 감싸지 않은 그룹이나 이 확장 밖의 전환이 작성 도구를 켜면 그 자리에서 되돌린다.
      if (groupService.EVENTS?.TOOL_ACTIVATED) policyRestores.push(unsubscribe(groupService.subscribe(groupService.EVENTS.TOOL_ACTIVATED,
        event => { if (nativeAuthoringClosed() && !VIEW_TOOLS.has(event?.toolName)) enforceTools(); })));
    }
    if (typeof toolbarService?.subscribe === 'function' && toolbarService.EVENTS?.TOOL_BAR_MODIFIED)
      policyRestores.push(unsubscribe(toolbarService.subscribe(toolbarService.EVENTS.TOOL_BAR_MODIFIED, () => { if (nativeAuthoringClosed()) enforceToolbar(); })));
    function unsubscribe(subscription) { return () => subscription?.unsubscribe?.(); }
    const text = (parent, tag, value) => { const el = document.createElement(tag); el.textContent = value; parent.append(el); return el; };
    const button = (parent, label, run, disabled = false) => {
      const b = text(parent, 'button', label); b.type = 'button'; b.disabled = disabled;
      b.style.cssText = 'margin:3px;padding:4px 7px;border:1px solid #657c9f;border-radius:4px';
      b.addEventListener('click', () => Promise.resolve().then(run).catch(() => { status.textContent = kinText("작업을 완료하지 못했습니다. 현재 내용을 확인하세요."); })); return b;
    };
    const input = (parent, label, value, change, disabled = false) => {
      const wrap = text(parent, 'label', label), el = document.createElement('input');
      el.value = value; el.disabled = disabled; el.setAttribute('aria-label', label);
      el.style.cssText = 'display:block;width:100%;background:#0c1423;color:#fff;border:1px solid #657c9f;padding:4px';
      el.addEventListener('input', () => change(el.value)); wrap.append(el); return el;
    };
    const viewport = () => services.cornerstoneViewportService.getCornerstoneViewport(services.viewportGridService.getActiveViewportId());
    const reference = kinViewerImageReference;
    const matches = (r, item) => r?.study === scope && r.seriesUid === item.seriesUid && r.sopUid === item.sopUid && r.frame === item.frame;
    const current = () => reference(viewport()?.getCurrentImageId?.());
    const valid = ticket => !ended && ticket === generation && (!current() || current().study === scope);
    // Why a Key Image naming `r` would not be the image the reader sees in cell `v`, if so ('' when it is). The one rule of
    // Add Key Image (it fixes series, SOP and frame when pressed; Save sends only those):
    //   a stack cell names the image it was asked for as soon as that load starts and keeps naming it after the load fails,
    //   while the image before stays on the screen; the loaded image is drawn a moment later still. So the image the cell
    //   holds must be the one named and the cell must have finished drawing it. Laid out as tiles (Navigate: Tile, Unfolded)
    //   the named image may be off the grid, and a slab is drawn as the mean of several slices: neither shows one image.
    //   A video cell names the frame of its playing position: not yet shown while it seeks or before it has a frame.
    //   A volume cell (MPR) has no loaded-image read and names the original slice it shows, as before.
    function keyImageNotShown(v, r) {
      if (!v) return '';
      if (v.type === 'video') {
        const video = v.videoElement;
        return video && (video.seeking || !(video.readyState >= 2)) ? kinText("고른 영상이 아직 이 칸에 표시되지 않아 Key Image를 만들지 않았습니다. 영상이 표시된 뒤 다시 누르세요.") : '';
      }
      if (v.type !== 'stack' && typeof v.getCornerstoneImage !== 'function') return '';
      let laid = null, slab = false;
      try { laid = window.kinNavigate?.laid?.(v.id) || null; } catch (_) {}
      try { slab = window.kinMgSlab?.on?.(v.id) === true; } catch (_) {}
      if (laid === 'unfolded') return kinText("Unfolded 보기에서는 Key Image를 만들 수 없습니다. Folded (Cine) 보기에서 누르세요.");
      if (laid) return kinText("Tile 보기에서는 Key Image를 만들 수 없습니다. Stack 보기에서 누르세요.");
      if (slab) return kinText("Slab을 보는 동안에는 Key Image를 만들 수 없습니다. Slab Thickness를 1 slice로 바꾼 뒤 누르세요.");
      const drawn = v.viewportStatus === undefined || v.viewportStatus === (cs.Enums?.ViewportStatus?.RENDERED || 'rendered');
      return drawn && matches(reference(kinViewerShownImageId(v)), r) ? '' :
        kinText("고른 영상이 아직 이 칸에 표시되지 않아 Key Image를 만들지 않았습니다. 영상이 표시된 뒤 다시 누르세요.");
    }
    // S5-U2b-R-003 F01. 목록 읽기는 요청할 때 어느 목록인지 정해진다: writer의 작성자 목록(숨김 포함 전체) 또는 clinician의 확정 목록.
    // 답은 그 읽기(세대·순번)의 것이고 문서가 지금도 같은 목록을 읽을 때만 그린다 — clinician-only 경계(clinicianBoundary)가 어떤
    // 이유로 돌지 못했어도(settle은 감시자의 실패를 삼킨다) 전환 뒤에 도착한 작성자 목록은 그려지지 않는다.
    const readPolicy = () => readOnly() ? 'shared' : 'author';
    const asked = (ticket, seq, policy) => valid(ticket) && seq === readSequence && readPolicy() === policy;
    const writable = entry => window.KinViewerSessionBoundary?.active() && writer() && !suspended && !recovery.has(scope) && me?.kind === 'member' && me.roles?.includes('radiologist') &&
      (!entry.head || entry.head.authorSub === subject);
    const render = () => { try { viewport()?.render(); } catch (_) {} };
    const lock = (entry, locked) => { if (entry.annotationUID) ct.annotation.locking.setAnnotationLocked(entry.annotationUID, locked); };
    function removeAnnotation(entry) {
      if (!entry.annotationUID) return;
      annotations.delete(entry.annotationUID);
      ct.annotation.state.removeAnnotation(entry.annotationUID);
      // Measurements can be created by later handle edits; remove the paired
      // transient OHIF row too, without treating its removal as a server delete.
      if (services.measurementService.getMeasurement(entry.annotationUID)) ownRemove(entry.annotationUID);
      entry.annotationUID = null;
    }
    function reset(message) {
      leaveDrawings();
      generation++; readSequence++; navigation++; controller.abort(); controller = new AbortController();
      srRequests.clear();
      for (const e of entries.values()) removeAnnotation(e);
      entries.clear(); annotations.clear(); list.replaceChildren(); actions.replaceChildren(); loading = false; suspended = true; shown = null;
      unmatched = false; delete panel.dataset.studyUid; delete panel.dataset.readOnly; delete panel.dataset.frame;
      status.textContent = message; render();
    }
    const hasWork = e => e.editing || e.pending || e.heldDraft;
    function park() {
      if (!scope || !subject) return;
      captureAnnotations();
      const saved = [];
      for (const e of entries.values()) {
        if (!hasWork(e)) continue;
        const a = e.annotationUID && ct.annotation.state.getAnnotation(e.annotationUID);
        if (e.editing && !e.pending && a) {
          e.draft.points = clone(a.data.handles.points);
          e.draft.label = a.data.text ?? a.data.label ?? '';
          Object.assign(e.draft, markFields(e.draft.kind, a.data));
        }
        // Copy only session data. Detached handlers and late responses must not
        // mutate a parked draft or attach its annotation to another study.
        // auto: what the marks saved on their own already sent or refused, and a draft brought back to be checked first.
        saved.push(clone({ id: e.id, head: e.head, draft: e.draft, editing: e.editing,
          pending: e.pending, heldDraft: e.heldDraft, latest: e.latest, message: e.message, ...(e.auto ? { auto: { ...e.auto, sent: 0 } } : {}) }));
      }
      if (saved.length) recovery.set(scope, { subject, entries: saved });
    }
    function deny() {
      // An unfinished drawing is ended by its tool while its mark is still there to be deselected.
      leaveDrawings();
      park();
      // An unfinished drawing may not yet have a history entry. Quarantine
      // removes those transient marks too, without touching another study.
      for (const a of ct.annotation.state.getAllAnnotations()) {
        const study = reference(a.metadata.referencedImageId)?.study;
        if (!kinds[a.metadata.toolName] || study && study !== scope) continue;
        ct.annotation.state.removeAnnotation(a.annotationUID);
        if (measurementService.getMeasurement(a.annotationUID)) ownRemove(a.annotationUID);
      }
      reset(readOnly() ? READ_ONLY.denied : kinText("이 검사에 접근할 수 없습니다. 보관 작업은 접근 확인 후 재개할 수 있습니다.")); me = null;
      kinViewerEntryRelease();
      if (readOnly()) { panel.dataset.readOnly = 'denied'; panel.dataset.studyUid = scope; }
      button(actions, 'Recheck Access', () => load());
    }
    function end(modeExit = false) {
      if (ended) return;
      kinViewerEntryRelease();
      recovery.clear(); reset(kinText("로그인이 종료되었습니다. 다시 로그인한 뒤 뷰어를 여세요.")); ended = true; me = null; subject = ''; actions.replaceChildren();
      // Mode exit keeps this document and its login; the Findings section holds its drafts for the
      // next mode entry instead of destroying them as it must for a real logout or 401.
      window.dispatchEvent(Object.assign(new Event('kin-viewer-access-ended'), { kinModeExit: modeExit === true }));
      // A shared workstation must not retain unsaved labels after logout either.
      for (const a of ct.annotation.state.getAllAnnotations()) if (kinds[a.metadata.toolName]) {
        ct.annotation.state.removeAnnotation(a.annotationUID);
        if (services.measurementService.getMeasurement(a.annotationUID)) ownRemove(a.annotationUID);
      }
      render();
    }
    // Session termination is owned by the page transport and gate.
    function sessionEnded(reason) { kinViewerSession.refuse(reason); end(); }
    // detached: a save sent as the window closes or the study changes (autosave closing) is not cut by that reset; its late
    // answer is still dropped as any other of a generation given up.
    async function api(path, options = {}, ticket = generation, detached = false) {
      // A request of a generation already given up (another study, the clinician-only boundary) is not sent at all: a save that
      // was waiting for its /me when that answer said clinician-only never reaches the server. Nor is any request of a document
      // whose login ended (X4-R-001 F02), whether or not this panel has heard of it yet.
      if (kinViewerSession.ended() || !valid(ticket)) throw { stale: true };
      const parentSignal = controller.signal, request = new AbortController();
      const abort = () => request.abort(); if (!detached) parentSignal.addEventListener('abort', abort, { once: true });
      const timeout = setTimeout(abort, 30000);
      try {
      const res = await fetch('/api' + path, { ...options, cache: 'no-store', credentials: 'same-origin', signal: request.signal,
        headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}) } });
      // Session termination is owned by the page transport and gate.
      const drop = async data => {
        if (path === '/me' && res.ok) kinViewerSession.sameAccount(data === undefined ? await res.json().catch(() => null) : data);
        return { stale: true };
      };
      if (!valid(ticket)) throw await drop();
      if (window.KinSessionTransport.refusal(res) === 'denied' && res.status === 403) { deny(); throw { stale: true }; }
      if (window.KinSessionTransport.refusal(res)) throw window.KinSessionTransport.responseError(res);
      const data = await res.json().catch(() => null);
      if (!valid(ticket)) throw await drop(data);
      // `said` (the server's wording) is read only by readOnlyLoad; writer paths keep their own messages (manualSr reads `message`).
      if (!res.ok || !data) throw { status: res.status, code: data?.code, said: data?.message };
      return data;
      } finally { clearTimeout(timeout); parentSignal.removeEventListener('abort', abort); }
    }
    async function authenticate(ticket) {
      const user = await api('/me', {}, ticket);
      // Compare with the account first confirmed in this document, including earlier mounts.
      // A different account refuses this panel's answer; only the page gate ends the document.
      // The session watcher below runs inside note(): ownAnswer tells it that this panel's own /me is the answer it reacts to.
      if (kinViewerSession.sameAccount(user) !== true) throw { stale: true };
      ownAnswer = true;
      try { kinViewerSession.note(user); } finally { ownAnswer = false; }
      // `ended`: the answer itself refused (not a viewer member) and the session watcher ended this panel inside note().
      if (ended || !user.sub) { sessionEnded('not-member'); throw { stale: true }; }
      me = user; subject = user.sub; lastAuth = Date.now(); return user;
    }
    const path = () => '/studies/' + scope + '/viewer-items';
    function errorMessage(error) {
      if (error.code === 'VIEWER_STORAGE_LIMIT') return kinText("저장 공간 한도입니다. 숨김으로 공간이 회수되지는 않습니다. 작성 내용은 미저장 상태로 남아 있습니다.");
      if (error.status === 409) return kinText("다른 판 또는 저장 조건과 충돌했습니다. 최신판을 확인한 뒤 다시 저장하세요.");
      if (error.status === 400 || error.status === 413) return kinText("지원 영상·원본 평면·입력 길이를 확인하세요. 작성 내용은 저장되지 않았습니다.");
      return kinText("저장 결과를 확인하지 못했습니다. 같은 요청 재시도로 결과를 확인하세요.");
    }
    // The status's saved-item count: the items this study holds on the server now — rows with a saved revision, hidden ones
    // included (the list is read with them), not one deleted in another window. Every way that number changes comes here: a
    // read of the list, a save answered (the Save button, autosave, Hide, Restore) and a delete answered. With a lead the
    // status is that text and the count; without one only a count already shown is brought up to date, so another message the
    // status shows meanwhile (a reason, an error, a recheck) is not overwritten.
    // A recheck message this panel wrote is read back by its start (below): as written, or the same words in the screen
    // language (a message may carry more after them).
    const RECHECK_SOURCE = [kinText("재확인 필요: 원본을 확인하지 못했습니다. 작성 내용은 유지됩니다."), kinText("재확인 필요: 원본을 확인하지 못했습니다. 보관한 수정은 유지됩니다."),
      kinText("재확인 필요: 원본을 다시 확인하거나 새 뷰어에서 재측정하세요. 작성 내용은 유지됩니다."), kinText("재확인 필요: 원본 영상의 동일성을 확인할 수 없습니다.")];
    const RECHECK_VALUE = [kinText("재확인 필요: 재계산 값이 저장 당시와 다릅니다. 편집 후 다시 측정하세요."), kinText("재확인 필요: {0}", "")];
    const rechecking = (message, sourceOnly) => message.startsWith(sourceOnly ? '재확인 필요: 원본' : '재확인 필요') ||
      (sourceOnly ? RECHECK_SOURCE : RECHECK_SOURCE.concat(RECHECK_VALUE)).some(words => message.startsWith(words));
    // The count line this panel wrote last and its lead: a count is brought up to date only while the status still shows it.
    let counted = null;
    // Items this panel deleted (the server keeps them and their revisions; no list of the author's shows them again).
    const deletedHere = new Set();
    function recount(lead) {
      const n = [...entries.values()].filter(e => e.head && !e.gone).length;
      if (typeof lead !== 'string') {
        if (!counted || status.textContent !== counted.text) return;
        lead = counted.lead;
      }
      const text = kinText('{t0}{n1}개 저장 항목 · 저장은 판독 확정과 별개입니다.', lead, n);
      status.textContent = text;
      counted = { lead, text: status.textContent };
    }
    // `answered`: only the clinician-only boundary passes it, from inside this panel's own /me answer — that answer is this read's /me.
    async function load(resume = false, recheck = null, answered = false) {
      if (!scope || ended || loading) return;
      const ticket = generation, seq = ++readSequence; loading = true; tried = Date.now();
      // Saved items as this read begins: only one of these can be judged deleted in another window by its absence from the
      // answer (an item saved while the read was on its way is not in it yet).
      const savedAtStart = new Set([...entries.values()].filter(e => e.head).map(e => e.head.id));
      status.textContent = kinText("저장 항목 확인 중…");
      try {
        if (!answered) await authenticate(ticket);
        if (readPolicy() === 'shared') return await readOnlyLoad(ticket, seq);
        const heads = []; let cursor = null;
        do {
          const page = await api(path() + '?includeHidden=true&limit=100' + (recheck ? '&recheck=' + encodeURIComponent(recheck) : '') + (cursor ? '&cursor=' + encodeURIComponent(cursor) : ''), {}, ticket);
          if (!asked(ticket, seq, 'author')) return;
          if (!Array.isArray(page.items) || (cursor && page.nextCursor === cursor)) throw new Error('Invalid page');
          heads.push(...page.items); cursor = page.nextCursor;
        } while (cursor);
        if (!asked(ticket, seq, 'author')) return;
        suspended = false;
        const parked = recovery.get(scope);
        // With marks saved on their own (autoMarks) the held work of this study is taken up again at once, as Resume Held Work
        // does, and is then saved as any other.
        if ((resume === true || autoMarks()) && parked && parked.subject === subject) {
          for (const e of entries.values()) removeAnnotation(e);
          entries.clear(); list.replaceChildren();
          // Held work taken up: its saved items count as saved when this read began, so one deleted meanwhile in another
          // window is judged by this answer like any other.
          for (const e of clone(parked.entries)) { e.rehydrate = !e.head; if (e.head) savedAtStart.add(e.head.id); entries.set(e.id, e); row(e); }
          recovery.delete(scope);
        }
        for (const head of heads) {
          // Deleted here while this read was on its way: an older answer does not bring it back.
          if (deletedHere.has(head.id)) continue;
          let e = entries.get(head.id);
          if (e) e.gone = false;
          if (e && (e.editing || e.pending || e.busy)) {
            if (head.revision !== e.head?.revision) { e.latest = head; e.message = kinText("서버에 다른 판이 있습니다. 작성 내용은 유지됩니다."); row(e); }
            else {
              // A read's source verdict can change without a new revision.
              // Retain the draft, never treat a parked verdict as fresh proof.
              e.head = head;
              if (manual(e.draft.kind) && head.referenceStatus !== 'verified') {
                const a = e.annotationUID && ct.annotation.state.getAnnotation(e.annotationUID);
                if (e.editing && !e.pending && a) e.draft.points = clone(a.data.handles.points);
                removeAnnotation(e); e.message = kinText("재확인 필요: 원본을 확인하지 못했습니다. 작성 내용은 유지됩니다.");
              } else if (manual(e.draft.kind) && rechecking(e.message, true)) e.message = kinText("원본 확인 완료. 작성 내용은 아직 미저장 상태입니다.");
            }
            continue;
          }
          if (e) removeAnnotation(e);
          else { e = { id: head.id }; entries.set(e.id, e); }
          Object.assign(e, { head, draft: itemOnly(head), editing: false, latest: null, message: '' }); restoreHeldDraft(e); row(e);
        }
        // The whole author list leaves out only deleted items: a saved row it no longer has was deleted (in another window).
        // Work on such a row is kept and told; it can no longer be saved (any revision of a deleted item is refused).
        if (!recheck) for (const e of [...entries.values()]) if (e.head && savedAtStart.has(e.head.id) && !heads.some(h => h.id === e.head.id)) {
          if (hasWork(e) || e.busy) { e.gone = true; e.message = kinText("다른 창에서 지운 항목입니다. 이 창의 작성 내용은 저장되지 않습니다."); continue; }
          removeAnnotation(e); entries.delete(e.id); e.element?.remove();
        }
        for (const e of entries.values()) row(e);
        if (recheck) status.textContent = heads.some(h => h.id === recheck) ? kinText("선택한 항목의 원본 확인을 마쳤습니다. 항목의 확인 상태를 보세요. 저장 이력은 바뀌지 않습니다.") : kinText("선택한 저장 항목을 찾지 못했습니다. 목록을 새로고침하세요.");
        else recount('');
        panel.dataset.studyUid = scope;
        toolbar(); hydrate();
      } catch (e) { if (!e.stale && valid(ticket)) status.textContent = kinText("목록을 확인하지 못했습니다. 새로고침으로 다시 확인하세요."); }
      finally { if (ticket === generation) loading = false; }
    }
    // S5-U2b 읽기 전용 목록. 서버는 판독의와 같은 지금 목록({items, nextCursor} — 숨긴 항목 빼고)을 누구에게나 주고, 누가
    // 무엇을 보는가는 서버 한 곳(viewer.service)이 정한다(2026-11-02 결정 뒤 판독 확정 여부로 좁히지 않는다). 이 화면은 답의
    // 모양만 보고 끝 쪽까지 읽는다. 읽는 동안 이전 목록을 내려 두고, 실패하면 받은 쪽도 버린다.
    const dropRows = () => {
      for (const e of entries.values()) removeAnnotation(e);
      entries.clear(); list.replaceChildren(); shown = null; unmatched = false; delete panel.dataset.frame;
    };
    // One page of the shared list, or a throw: an items array of known kinds, a next cursor that is null or a new string.
    function readOnlyPage(page, cursor) {
      const next = page?.nextCursor;
      if (!page || typeof page !== 'object' || !Array.isArray(page.items) || page.items.length > 100 ||
          !page.items.every(h => h && typeof h === 'object' && typeof h.id === 'string' && h.id && Number.isSafeInteger(h.revision) &&
            h.item && typeof h.item === 'object' && Object.hasOwn(names, h.item.kind)) ||
          !(next === null || typeof next === 'string' && next.length > 0 && next.length <= 512 && next !== cursor)) throw Object.assign(new Error('Invalid page'), { invalid: true });
      return next;
    }
    async function readOnlyHeads(ticket, seq) {
      const heads = []; let cursor = null;
      do {
        const page = await api(path() + '?limit=100' + (cursor === null ? '' : '&cursor=' + encodeURIComponent(cursor)), {}, ticket);
        if (!asked(ticket, seq, 'shared')) throw { stale: true };
        const next = readOnlyPage(page, cursor);
        heads.push(...page.items); cursor = next;
      } while (cursor !== null);
      return heads;
    }
    // What the periodic check compares: each item's id, revision and the server's source verdict of this read (a measurement's
    // verified/unverified can change without a new revision).
    const listKey = heads => JSON.stringify(heads.map(h => [h.id, h.revision, h.referenceStatus ?? null]).sort());
    async function readOnlyLoad(ticket, seq) {
      if (!valid(ticket) || seq !== readSequence) return;
      const study = scope;
      dropRows(); panel.dataset.readOnly = 'loading'; toolbar();
      try {
        const heads = await readOnlyHeads(ticket, seq);
        if (!asked(ticket, seq, 'shared')) return;
        readOnlyShow(study, heads);
      } catch (error) {
        if (error?.stale || !asked(ticket, seq, 'shared')) return;
        readOnlyFailed(error);
      }
    }
    // S5-U2b-R-003 F01. clinician-only가 되는 순간은 이 패널이 진행 중인 모든 읽기·쓰기의 경계다. /me를 기다리는 읽기든 이미
    // 작성자 목록을 요청한 읽기든(첫 쪽·다음 쪽·Refresh·Recheck Source), 저장·이력·SR 요청이든 reset()이 그 세대·순번을 버리고
    // 요청을 끊으며(아직 보내지 않은 요청은 api가 보내지 않는다), 작성자 행과 그 표식을 지금 내린다. 그 뒤 확정 목록 읽기를 정확히
    // 한 번 시작한다: 이 전환을 부른 답이 이 패널 자신의 /me면(ownAnswer) 방금 인증했으므로 곧바로 확정 목록을 읽고, 다른 확장의
    // /me면 이 패널의 /me부터 다시 묻는다(끊은 /me의 늦은 답은 버린다). 진행 중인 읽기(loading)를 이유로 건너뛰지 않는다 — 건너뛰면
    // writer로 이미 요청한 목록이 전환 뒤에 도착해 그려지고, 그 목록에는 확인 기준(shown)이 없어 final:false로도 내려가지 않았다.
    function clinicianBoundary(own) {
      reset(kinText("저장 항목 확인 중…")); toolbar();
      load(false, null, own);
    }
    // 끝까지 읽은 목록만 그리고, 그 목록(listKey)을 뒤따르는 주기·포커스 확인의 기준(shown)으로 남긴다.
    function readOnlyShow(study, heads) {
      suspended = false; shown = { study, key: listKey(heads) }; unmatched = false;
      for (const head of heads) {
        const e = { id: head.id, head, draft: itemOnly(head), editing: false, latest: null, message: '' };
        entries.set(e.id, e); row(e);
      }
      shownStatus = heads.length ? kinText("저장 항목 {n0}개 · 읽기 전용", heads.length) : kinText("이 검사에 저장된 측정·키 이미지가 없습니다 · 읽기 전용");
      status.textContent = shownStatus;
      panel.dataset.studyUid = study; panel.dataset.readOnly = heads.length ? 'ready' : 'empty';
      toolbar(); hydrate(); frameMatch(current());
      openEntryTarget(study);
    }
    // the original image this document was opened at (session.js KIN_VIEWER_ENTRY_TARGET: a key image or a cited line in
    // Clinician Home), opened once, after the first read-only list is drawn. The study the target names is shown in the one
    // viewport that shows it, else the active viewport takes the target's series; then the exact frame (kinViewerNavigateTo,
    // which proves arrival on the frame shown) and the saved item highlighted. A user who changes the active viewport meanwhile
    // stops it. Whatever the end, the opening hold is let go (Auto Save View may then save the view as the user leaves it).
    let entryTried = false;
    const ENTRY_REASON = { 'series-missing': kinText("이 창에서 원본 시리즈를 찾을 수 없습니다."), 'frame-missing': kinText("원본 프레임을 열지 못했습니다."),
      'viewport-unsupported': kinText("현재 화면은 원본 프레임 목록이 없는 MPR/볼륨 화면입니다."), 'viewport-missing': kinText("그 검사를 보이는 영상 칸이 없습니다."),
      'viewport-ambiguous': kinText("그 검사를 보이는 영상 칸이 여럿이라 하나로 정하지 못했습니다."), timeout: kinText("15초 안에 영상이 준비되지 않았습니다."),
      superseded: kinText("다른 영상 칸을 골라 이동을 멈췄습니다."), ended: kinText("로그인이 종료되었습니다.") };
    const ENTRY_MARK = { shown: kinText("표식을 강조했습니다."), key: kinText("키 이미지입니다."), missing: kinText("그 표식은 지금 저장 항목에 없습니다(숨김 또는 삭제)."),
      hidden: kinText("그 표식은 숨겨져 있습니다."), unverified: kinText("그 측정은 원본을 확인하지 못해 그리지 않았습니다."), none: kinText("표식을 그리지 않았습니다.") };
    // The panel keeps one status (other modules and tests read it); the outcome of the opening is its own polite line, made
    // only in a document that has a target.
    let entryNote = null;
    function entrySay(text) {
      if (!entryNote) { entryNote = document.createElement('p'); entryNote.id = 'kin-viewer-entry-note'; entryNote.setAttribute('aria-live', 'polite'); status.after(entryNote); }
      entryNote.textContent = text; entryNote.hidden = false;
      // A folded dock still shows its own status row: the reason is readable there too.
      const row = document.getElementById('kin-dock-preference-status'); if (row) row.textContent = text;
    }
    function entrySeries(target) {
      try {
        const sets = services.displaySetService.getActiveDisplaySets().filter(d => d.StudyInstanceUID === target.studyUid &&
          d.SeriesInstanceUID === target.seriesUid && kinSeriesSplitHolds(d, target.sopUid, target.frame));
        if (sets.length !== 1) return false;
        services.viewportGridService.setDisplaySetsForViewport({ viewportId: services.viewportGridService.getActiveViewportId(), displaySetInstanceUIDs: [sets[0].displaySetInstanceUID] });
        return true;
      } catch (_) { return false; }
    }
    async function entryNavigate(target) {
      const deadline = Date.now() + 15000, wait = () => new Promise(resolve => setTimeout(resolve, 100));
      const activeId = () => { try { return services.viewportGridService.getActiveViewportId(); } catch (_) { return null; } };
      if (scope !== target.studyUid) {
        const activation = activateStudy(target.studyUid);
        if (!activation.ok && !entrySeries(target)) return { ok: false, reason: activation.reason };
      }
      const viewportId = activeId();
      while (!(scope === target.studyUid && !suspended && !loading && shown?.study === scope)) {
        if (ended) return { ok: false, reason: 'ended' };
        if (activeId() !== viewportId) return { ok: false, reason: 'superseded' };
        if (Date.now() > deadline) return { ok: false, reason: 'timeout' };
        await wait();
      }
      return navigateTo(target);
    }
    function openEntryTarget() {
      if (entryTried) return;
      const target = kinViewerEntryTake();
      if (!target) return;
      entryTried = true;
      entryNavigate(target).then(outcome => {
        if (ended) return;
        if (outcome.ok) entrySay(kinText("요청한 원본 영상(프레임 {0})으로 이동했습니다. {1}", target.frame, (target.itemId ? ENTRY_MARK[outcome.annotation] || ENTRY_MARK.none : '')));
        else entrySay(kinText("요청한 원본 영상으로 이동하지 못했습니다. {0}", (ENTRY_REASON[outcome.reason] || kinText("이동하지 못했습니다."))));
      }, () => { if (!ended) entrySay(kinText("요청한 원본 영상으로 이동하지 못했습니다.")); }).finally(kinViewerEntryRelease);
    }
    function readOnlyFailed(error) {
      // A list that could not be read lets the opening go: Refresh may still open the target, without holding the view.
      dropRows(); kinViewerEntryRelease();
      const said = Array.isArray(error?.said) ? error.said.filter(x => typeof x === 'string').join(' ') : typeof error?.said === 'string' ? error.said : '';
      status.textContent = kinText("저장 항목을 불러오지 못했습니다. {0} Refresh로 다시 읽으세요.", (Number.isInteger(error?.status)
        ? (said ? said + ' ' : '') + '(HTTP ' + error.status + (typeof error.code === 'string' ? ' · ' + error.code : '') + ')'
        : error?.name === 'AbortError' || error instanceof TypeError ? kinText("서버 응답을 받지 못했습니다.") : kinText("응답 형식을 확인할 수 없습니다.")));
      panel.dataset.studyUid = scope; panel.dataset.readOnly = 'failed';
      toolbar();
    }
    // S5-U2b-R-001 F03. 주기·포커스 확인의 답(끝 쪽까지 읽은 목록)도 지금 그려 둔 목록(shown)과 대조한다. 같은 검사·같은 읽기
    // 세대의 답만 본다 — 다른 검사로 옮겼다 돌아온 A→B→A의 늦은 답이나 그 사이 새로 시작한 읽기가 있으면 이 답은 아무것도 바꾸지
    // 않는다. 항목·판·원본 확인이 하나라도 바뀌면(숨긴 항목이 빠짐 포함) 행과 표식을 내리고 새 목록으로 다시 그린다.
    // 전송 실패·5xx는 확인하지 못한 것이라 다음 확인까지 그린 목록을 두고, 4xx·형식 오류는 서버가 지금 내주지 않는 목록이라 내린다.
    function confirmShown(ticket, seq, study, heads, error) {
      if (error?.stale || !asked(ticket, seq, 'shared') || loading || scope !== study || shown?.study !== study) return;
      if (error) { if (error.invalid || Number.isInteger(error.status) && error.status >= 400 && error.status < 500) readOnlyFailed(error); return; }
      if (listKey(heads) === shown.key) return;
      dropRows(); readOnlyShow(study, heads);
    }
    // S5-U2b-R-002 F02. 이 확인은 활성 화면의 원본 프레임 식별과 떼어 둔다: 그려 둔 검사(scope)와 읽기 세대를 기준으로 주기(15초)·
    // 포커스마다 확인하고, 답은 위 confirmShown의 UID·세대 방어를 그대로 거친다. 프레임이 없는 화면(MPR·볼륨·로딩 실패)에
    // 머물러도 지워지거나 숨겨진 항목이 확인 없이 남지 않는다.
    function recheckShown() {
      if (!scope || !subject || suspended || loading || checking || Date.now() - lastAuth <= 15000) return;
      checking = true; const ticket = generation, seq = readSequence, study = scope;
      authenticate(ticket).then(() => readOnlyHeads(ticket, seq))
        .then(heads => confirmShown(ticket, seq, study, heads, null), error => confirmShown(ticket, seq, study, null, error))
        .catch(() => {}).finally(() => { checking = false; });
    }
    // 목록은 식별된 원본 프레임으로만 화면 영상과 이어진다. 활성 화면에서 그 검사의 원본 프레임을 찾지 못하면 목록을 영상과 맞추지
    // 않았다고 알리고(data-frame="unmatched") 위 확인은 계속한다. 프레임이 돌아오면 그 자리에서 다시 확인한다.
    function frameMatch(r) {
      const lost = !!shown && !(r && r.study === shown.study);
      if (lost === unmatched) return;
      unmatched = lost;
      if (lost) { panel.dataset.frame = 'unmatched'; status.textContent = shownStatus + ' · ' + READ_ONLY.unmatched; return; }
      delete panel.dataset.frame; status.textContent = shownStatus; lastAuth = 0;
    }
    function toolbar() {
      const ticket = generation;
      actions.replaceChildren(); button(actions, 'Refresh', load);
      if (!writer()) { if (readOnly()) text(actions, 'p', READ_ONLY.note); return; }
      if (recovery.has(scope)) {
        text(actions, 'p', kinText("이 검사의 미저장 작업이 보관 중입니다. 이 뷰어를 닫거나 로그아웃하면 폐기됩니다."));
        button(actions, 'Resume Held Work', () => { if (valid(ticket)) return load(true); });
        button(actions, 'Discard Held Work', () => {
          if (!valid(ticket) || suspended || !recovery.has(scope)) return;
          if (!window.confirm(kinText("이 검사의 보관한 미저장 작업과 결과 미확인 요청을 버리시겠습니까? 서버 저장 이력은 유지됩니다."))) return;
          recovery.delete(scope); toolbar(); hydrate();
        });
        return;
      }
      for (const [label, command] of [['Download SR', 'downloadReport'], ['Store SR', 'storeMeasurements']]) {
        const control = button(actions, label, () => commands.runCommand(command, { measurementData: srSelection() }, reportContext), true);
        control.dataset.kinSr = command;
      }
      refreshSrButtons();
      for (const kind of ['length', 'angle', 'ellipse']) button(actions, names[kind], () => {
        const v = viewport(), group = v && ct.ToolGroupManager.getToolGroupForViewport(v.id, v.renderingEngineId);
        if (!group || v.type !== 'stack') { status.textContent = kinText("원본 프레임을 선택하세요."); return; }
        if (!group.getToolInstance(tools[kind])) group.addTool(tools[kind]);
        configureMeasurements(group);
        const previous = group.getActivePrimaryMouseButtonTool();
        if (previous) group.setToolPassive(previous);
        group.setToolActive(tools[kind], { bindings: [{ mouseButton: ct.Enums.MouseBindings.Primary }] });
      }, !writable({}));
      button(actions, 'Add Key Image', () => {
        const r = current(); if (!r || r.study !== scope) return;
        const why = keyImageNotShown(viewport(), r);
        if (why) { status.textContent = why; return; }
        const e = { id: crypto.randomUUID(), editing: true, draft: { schemaVersion: 1, kind: 'key', seriesUid: r.seriesUid, sopUid: r.sopUid, frame: r.frame, title: '', description: '' } };
        entries.set(e.id, e); row(e);
        // Saved on its own once its fields are left (autoReady): the title is where the reader goes first.
        if (autoMarks()) e.element.querySelector('input')?.focus();
      }, !writable({}));
    }
    function srSelection() {
      return measurementService.getMeasurements().filter(m => annotations.has(m.uid) && manual(annotations.get(m.uid).draft.kind));
    }
    function refreshSrButtons() {
      const selected = srSelection();
      const ready = !ended && !srBusy && selected.length > 0 && selected.length <= 16 && selected.every(m => {
        const e = annotations.get(m.uid);
        return writable(e) && !e.heldDraft && !e.head?.hidden && !e.busy && checkedMeasurement(measurementService.getMeasurement(m.uid));
      });
      for (const b of actions.querySelectorAll('[data-kin-sr]')) {
        b.disabled = !ready; b.title = ready ? '' : srBusy ? kinText("SR 처리 결과를 기다려 주세요.") : kinText("원본 프레임에서 직접 작성한 측정의 확인이 끝나면 사용할 수 있습니다.");
      }
    }
    // The pinned tools draw by a drag, or by a press, a move and another press (Angle always takes its last point that way).
    // From its first press until the tool ends it a Length, Angle or Ellipse is a drawing, not a measurement: it has no row,
    // is not unsaved work, and is dropped when the reader turns to something else instead of finishing it (Escape, the
    // wheel, another tool, another image, another cell, the end of the mode). The pinned viewer has no way out of such a
    // drawing: it keeps every other press, drag and wheel locked out, and the next press on the image finishes it.
    const samePoint = points => { const [p, ...rest] = points || []; return Array.isArray(p) && rest.length > 0 && rest.every(q => Array.isArray(q) && p.every((n, i) => n === q[i])); };
    const unfinished = a => { const w = drawing.get(a?.annotationUID); return !!w && w.tool.editData?.annotation === a; };
    function removeMark(uid) {
      // The pinned press handler selected the new annotation, and neither its cancel nor a removal clears that. The pinned
      // deselection raises for a mark that is already gone.
      if (ct.annotation.state.getAnnotation(uid)) ct.annotation.selection.setAnnotationSelected(uid, false);
      const e = annotations.get(uid);
      if (e) { removeAnnotation(e); entries.delete(e.id); e.element?.remove(); }
      else {
        if (ct.annotation.state.getAnnotation(uid)) ct.annotation.state.removeAnnotation(uid);
        if (services.measurementService.getMeasurement(uid)) ownRemove(uid);
      }
      render();
    }
    function leave(w) {
      const uid = w.annotation.annotationUID, held = w.tool.editData?.annotation === w.annotation;
      drawing.delete(uid);
      // Ended by the tool meanwhile: that is a finished measurement and it stays.
      if (!held) return;
      // The tool's own end of a drawing takes its listeners and the interaction lock away; a dropped drawing reports no completed measurement.
      w.tool.editData.newAnnotation = false;
      try { w.tool.cancel(w.element); } catch (_) { w.tool.editData = null; w.tool.isDrawing = false; }
      removeMark(uid);
    }
    function leaveDrawings() { for (const w of [...drawing.values()]) leave(w); }
    function checkDrawings() {
      for (const w of [...drawing.values()]) {
        const v = cs.getEnabledElement(w.element)?.viewport;
        if (w.tool.editData?.annotation !== w.annotation) drawing.delete(w.annotation.annotationUID);
        // A drawing starts only in the active cell: the pinned grid gives a cell no pointer input until it is active.
        else if (w.tool.mode !== 'Active' || !v || v.getCurrentImageId?.() !== w.annotation.metadata.referencedImageId ||
          v.id !== services.viewportGridService.getActiveViewportId() || !ct.annotation.state.getAnnotation(w.annotation.annotationUID)) leave(w);
      }
    }
    // The tool reports the end of a new drawing. From here it is a measurement: unsaved work at once, and its row is made
    // right after the tool's own report so that an SR made at once holds it. A Length whose two points are one is no
    // measurement and goes away.
    const drawingCompleted = event => {
      const a = event.detail?.annotation, w = drawing.get(a?.annotationUID);
      if (!w) return;
      drawing.delete(a.annotationUID);
      Promise.resolve().then(() => {
        if (w.kind === 'length' && samePoint(a.data?.handles?.points)) removeMark(a.annotationUID);
        try { scan(); } catch (_) {}
      });
    };
    // Before the pinned listeners see the input: a press anywhere but the drawing's own cell, the wheel on an image and
    // Escape drop the drawing, so that same input already does what it would do without one.
    const leaveByPress = event => { for (const w of [...drawing.values()]) if (!w.element.contains(event.target)) leave(w); checkDrawings(); };
    const leaveByWheel = event => { if (drawing.size && cs.getEnabledElements().some(x => x.viewport?.element?.contains(event.target))) leaveDrawings(); };
    // Enter and Space work a focused control as a press would (an export reached by Tab included): outside the drawing's cell
    // they drop it first, as that press would.
    const leaveByKey = event => {
      if (event.key === 'Escape') leaveDrawings();
      else if (event.key === 'Enter' || event.key === ' ') for (const w of [...drawing.values()]) if (!w.element.contains(event.target)) leave(w);
    };
      const configured = new Map();
    // A Freehand ROI's outline length (a closed outline's perimeter, an open line's length) and its unit, as the Length tool
    // measures: the distance along the outline on the image divided by the calibration's scale, in the unit the tool's own
    // unit function gives for the outline's box (a calibration's name included, e.g. "mm User", "cm US Region"). The box is
    // taken as the tool takes it — around the outline on the screen, its corners read back on the image (an ultrasound region
    // is chosen by them) — or, with no cell showing that image, around the outline on the image. The pinned tool's own
    // number sums distances on the screen (it changes with the zoom) and its unit is never read; null when the length is not
    // known to be physical (below), and the tool's own words are kept.
    // Only where the length is known to be physical: a stack image whose own header gives a pixel spacing (two positive
    // numbers), with no ultrasound region calibration, measured by the tool in mm with a positive scale. Anything else (no
    // spacing — the viewer then stands in a spacing of 1 —, an ultrasound region, a reformatted plane) is left to the tool's
    // own words, as before.
    const physical = v => Array.isArray(v) && v.length >= 2 && v.slice(0, 2).every(x => Number.isFinite(Number(x)) && Number(x) > 0);
    // A Freehand ROI's measure and where its unit comes from — the one answer for the cell's words, the Measurements panel and
    // its CSV: { unit: 'mm…', length } where the length is known to be physical (freehandLength, the tool's own area kept);
    // { unit: 'px', length, area } where the original's header gives no spacing at all (spacingless: the viewer stands in a
    // spacing of 1, so neither the tool's "mm" nor a screen calibration is the original's) — the outline measured on the image's
    // own pixel grid, its points in continuous column/row coordinates, the area (a closed outline's) in px²; null anywhere else
    // (an ultrasound region, a reformatted plane, an image that cannot be read): no length is said, as the tool's own number is
    // a distance on the screen in no unit, and the area stays the tool's own under its own calibration.
    // The last px measure of each outline (by its annotation data): while no cell shows its image (the reader has scrolled
    // to another slice) the same outline on the same image keeps that measure rather than falling back to the tool's "mm²".
    const freehandSeen = new WeakMap();
    function freehandMeasure(tool, data, target) {
      const found = freehandLength(tool, data, target);
      if (found) return found;
      try {
        const id = target.startsWith('imageId:') && target.slice(8), points = data.contour?.polyline;
        if (!id || !spacingless(cs.metaData.get('instance', id)) || !Array.isArray(points) || points.length < 2) return null;
        const key = target + '|' + JSON.stringify(points) + '|' + !!data.contour.closed, seen = freehandSeen.get(data);
        let grid; try { grid = tool.getTargetImageData(target)?.imageData; } catch (_) { grid = null; }
        if (typeof grid?.worldToIndex !== 'function') return seen?.key === key ? seen.found : null;
        const index = points.map(p => grid.worldToIndex(p));
        if (index.some(p => !Array.isArray(p) && !ArrayBuffer.isView(p) || ![0, 1, 2].every(i => Number.isFinite(p[i] ?? 0)))) return null;
        const along = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], (a[2] ?? 0) - (b[2] ?? 0));
        let length = 0, twice = 0;
        for (let i = 1; i < index.length; i++) length += along(index[i - 1], index[i]);
        if (data.contour.closed) {
          length += along(index[index.length - 1], index[0]);
          for (let i = 0; i < index.length; i++) { const a = index[i], b = index[(i + 1) % index.length]; twice += a[0] * b[1] - b[0] * a[1]; }
        }
        const result = Number.isFinite(length) && length > 0
          ? { unit: 'px', length, ...(data.contour.closed ? { area: Math.abs(twice) / 2, areaUnit: 'px²' } : {}) } : null;
        if (result) freehandSeen.set(data, { key, found: result });
        return result;
      } catch (_) { return null; }
    }
    function freehandLength(tool, data, target) {
      try {
        const image = tool.getTargetImageData(target), points = data.contour?.polyline;
        if (!image?.imageData || !Array.isArray(points) || points.length < 2) return null;
        const u = cs.utilities, id = target.startsWith('imageId:') && target.slice(8);
        const header = id && cs.metaData.get('instance', id);
        if (!header || !(physical(header.PixelSpacing) || physical(header.ImagerPixelSpacing)) || given(header.SequenceOfUltrasoundRegions) ||
            image.hasPixelSpacing !== true || image.calibration?.sequenceOfUltrasoundRegions) return null;
        let v = null;
        try {
          v = id ? (u.getViewportsWithImageURI?.(u.imageIdToURI(id)) || []).find(x => x.getCurrentImageId?.() === id)
            : target.startsWith('volumeId:') ? (u.getViewportsWithVolumeId?.(u.getVolumeId(target)) || [])[0] : null;
        } catch (_) { v = null; }
        const box = list => [[0, 1, 2].map(i => Math.min(...list.map(p => p[i] ?? 0))), [0, 1, 2].map(i => Math.max(...list.map(p => p[i] ?? 0)))];
        let corners;
        if (v) {
          const [low, high] = box(points.map(p => v.worldToCanvas(p)));
          corners = [v.canvasToWorld([low[0], low[1]]), v.canvasToWorld([high[0], high[1]])].map(p => u.transformWorldToIndex(image.imageData, p));
        } else corners = box(points.map(p => u.transformWorldToIndex(image.imageData, p)));
        const { unit, scale } = ct.utilities.getCalibratedLengthUnitsAndScale(image, () => corners) || {};
        const along = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], (a[2] ?? 0) - (b[2] ?? 0));
        let distance = 0;
        for (let i = 1; i < points.length; i++) distance += along(points[i - 1], points[i]);
        if (data.contour.closed) distance += along(points[points.length - 1], points[0]);
        const value = distance / scale;
        return typeof unit === 'string' && /^mm( |$)/.test(unit) && Number.isFinite(scale) && scale > 0 && Number.isFinite(value) && value > 0
          ? { length: value, unit } : null;
      } catch (_) { return null; }
    }
    function configureMeasurements(group) {
      if (!group || configured.has(group)) return;
      const roi = group.getToolInstance('EllipticalROI');
      if (!roi?.configuration?.statsCalculator) return;
      const previous = roi.configuration;
      const calculator = previous.statsCalculator;
      // Preserve native voxel selection and statistics; expose the named min
      // which this pinned release omits from its returned array.
      const adapter = {
        statsInit: options => calculator.statsInit?.(options),
        statsCallback: value => calculator.statsCallback(value),
        getStatistics: (...args) => {
          const result = calculator.getStatistics(...args);
          return { ...result, array: [...result.array.filter(s => s.name !== 'min'), result.min] };
        },
      };
      roi.configuration = { ...previous, statsCalculator: adapter, getTextLines(data, target) {
        if (data.kinUnverified) return [kinText("재확인 필요: 측정값을 확인할 수 없습니다")];
        const s = data.cachedStats[target]; if (!s) return [];
        const min = s.statsArray?.find(x => x?.name === 'min')?.value;
        const number = x => Math.sign(x) * Math.round(Math.abs(x));
        const lines = [];
        if (Number.isFinite(s.area)) lines.push('Area: ' + number(s.area) + ' ' + s.areaUnit);
        if (s.modalityUnit === 'HU') {
          for (const [name, value] of [['Mean', s.mean], ['SD', s.stdDev], ['Min', min], ['Max', s.max]])
            if (Number.isFinite(value)) lines.push(name + ': ' + (['Mean', 'SD'].includes(name) ? number(value) : value) + ' HU');
        }
        return lines;
      } };
      const restores = [() => { roi.configuration = previous; }];
      // Freehand ROI's words: the pinned tool gave a closed outline's perimeter and an open line's length as a distance on the
      // screen with the unit "undefined". Its own text is made from a copy whose perimeter or length is the outline's length on
      // the image in its unit (freehandMeasure), the area in px² where the original has no spacing, the other lines (values) as
      // they are; where no unit is known the length line is left out rather than said in "undefined". The measurement itself (and
      // so what is saved or exported) is not touched.
      const freehand = group.getToolInstance('PlanarFreehandROI'), freehandConfig = freehand?.configuration;
      if (freehand) freehandTool = freehand;
      if (typeof freehandConfig?.getTextLines === 'function') {
        freehand.configuration = { ...freehandConfig, getTextLines(data, target) {
          const s = data?.cachedStats?.[target];
          if (!s || typeof s.unit === 'string') return freehandConfig.getTextLines(data, target);
          const found = freehandMeasure(freehand, data, target), key = data.contour?.closed ? 'perimeter' : 'length';
          const words = { ...s, perimeter: undefined, length: undefined,
            ...(found ? { unit: found.unit, [key]: found.length, ...(found.area !== undefined ? { area: found.area, areaUnit: found.areaUnit } : {}) } : {}) };
          return freehandConfig.getTextLines({ ...data, cachedStats: { ...data.cachedStats, [target]: words } }, target);
        } };
        restores.push(() => { freehand.configuration = freehandConfig; });
      }
      for (const kind of ['length', 'angle', 'ellipse']) {
        if (!group.getToolInstance(tools[kind])) group.addTool(tools[kind]);
        const tool = group.getToolInstance(tools[kind]), config = tool.configuration, add = tool.addNewAnnotation;
        const lines = config.getTextLines;
        tool.addNewAnnotation = function (event) {
          if (ended || !subject || suspended || recovery.has(scope) || !writer()) {
            status.textContent = ended ? kinText("로그인이 종료되었습니다. 다시 로그인한 뒤 뷰어를 여세요.") : !writer() ? closedText('tool') : kinText("현재 검사 접근과 보관 작업을 확인한 후 측정하세요."); return refused;
          }
          const v = cs.getEnabledElement(event.detail.element).viewport;
          const id = v.type === 'stack' && v.getCurrentImageId();
          let reason = id ? measurementReason(id, kind) : kinText("원본 프레임을 선택하세요");
          if (!reason) { let geometry; try { geometry = planar(id, kind); } catch (_) { geometry = null; } if (geometry?.viewerPlane && !everyCellConfirmed(v, id, geometry)) reason = PLANE_UNCONFIRMED; }
          if (!reason && kind === 'ellipse' && !planar(id, kind) && v.getCamera().viewUp.filter(n => Math.abs(n) > 1e-6).length !== 1)
            reason = kinText("사선·회전 ROI는 아직 지원하지 않습니다");
          if (reason) { status.textContent = reason; cellNote(event.detail.element, reason); return refused; }
          const screen = !!screenCalibration(id, kind);
          const annotation = add.call(this, event);
          if (!annotation || annotation === refused) return refused;
          if (screen) annotation.data.kinScreenCalibration = true;
          trackMeasurement(annotation);
          drawing.set(annotation.annotationUID, { tool: this, element: event.detail.element, annotation, kind });
          return annotation;
        };
        tool.configuration = { ...config, getTextLines(data, target) {
          // Only its first point so far: nothing to measure, and no reason to give for a shape that is not there yet.
          if (samePoint(data.handles?.points)) return [kinText("측정을 완료하세요")];
          if (screenData(data)) return screenText(data, target);
          const id = target.startsWith('imageId:') && target.slice(8);
          const current = id ? measurementReason(id, kind, data.handles.points) : kinText("지원하지 않는 측정 평면입니다");
          // A saved mark being edited says why its current points give no value (moved out of an ultrasound region, off the
          // image) rather than only that it differs from its saved value.
          const edited = current && [...entries.values()].some(e => e.editing && e.annotationUID && ct.annotation.state.getAnnotation(e.annotationUID)?.data === data);
          const reason = data.kinUnverified && !edited ? kinText("재확인 필요: 저장 당시 측정과 다릅니다") : current;
          // A shape still being drawn (an ellipse stretched one way only, an angle with one arm) is not judged until it is finished.
          if (reason) return [[...drawing.values()].some(w => w.annotation.data === data && unfinished(w.annotation)) ? kinText("측정을 완료하세요") : reason];
          if (!freshStats(data, target)) return [kinText("재확인 필요: 현재 좌표로 계산되지 않았습니다")];
          const geometry = planar(id, kind);
          if (geometry) {
            const value = geometry.measure(kind, data.handles.points);
            return [planarText(geometry, value) + (kind === 'angle' ? '°' : kind === 'ellipse' ? ' mm²' : ' mm'), ...kinText(geometry.label).split(' · ')];
          }
          if (kind === 'ellipse') return lines(data, target);
          const mg = kind === 'length' && kinMgGeometry(cs.metaData.get('instance', id), reference(id)?.frame);
          const value = mg ? mg.length(data.handles.points) : data.cachedStats[target]?.[kind === 'length' ? 'length' : 'angle'];
          if (!Number.isFinite(value) || value <= 0) return [kinText("측정을 완료하세요")];
          const number = (Math.round(value * 10) / 10).toFixed(1) + (kind === 'length' ? ' mm' : '°');
          // Keep the scale basis readable in the four-view mammography layout.
          return mg ? [number, ...kinText(mg.label).split(' · ')] : [number];
        } };
        restores.push(() => { tool.configuration = config; tool.addNewAnnotation = add; });
      }
      configured.set(group, restores);
    }
    function updateAnnotation(e) {
      const a = e.annotationUID && ct.annotation.state.getAnnotation(e.annotationUID);
      if (a) {
        a.data.text = e.draft.label; a.data.label = e.draft.label;
        if (e.draft.kind === 'memo') a.data.title = e.draft.title;
        if (!manual(e.draft.kind)) a.invalidated = true; render();
      }
    }
    function restoreHeldDraft(e) {
      if (!e.head?.hidden && e.heldDraft) {
        if (manual(e.draft.kind) && e.head.referenceStatus !== 'verified') {
          e.message = kinText("재확인 필요: 원본을 확인하지 못했습니다. 보관한 수정은 유지됩니다.");
          return;
        }
        // The hidden head may have replaced the live handles with its older
        // points. Rehydrate the held geometry instead of copying those back.
        removeAnnotation(e);
        e.draft = e.heldDraft; e.heldDraft = null; e.editing = true;
        // Its place is to be checked first: not saved on its own as it comes back, only once the reader changes it.
        autoSeen(e, true);
        e.message = kinText("복원 완료. 보관한 수정은 아직 미저장 상태입니다.{t0}", (matches(current(), e.draft) ? kinText(" 위치를 확인한 후 저장하세요.") : kinText(" 영상으로 이동해 위치를 확인한 후 저장하세요.")));
      }
    }
    const heldActionReady = e => valid(generation) && entries.get(e.id) === e && writable(e) && e.heldDraft && !e.busy && !e.pending;
    function discardHeld(e) {
      if (!heldActionReady(e)) return;
      if (!window.confirm(kinText("보관한 미저장 수정을 버리고 서버판 r{n0}을 채택하시겠습니까?{t1} 서버 저장 이력은 유지됩니다.", (e.latest || e.head).revision, (e.latest ? kinText(" 아직 반영하지 않은 최신 서버판입니다.") : '')))) return;
      if (!heldActionReady(e)) return;
      // A detached button can outlive a restore request. Never discard the
      // local recovery copy while that request's result is still uncertain.
      removeAnnotation(e);
      e.head = e.latest || e.head; e.latest = null;
      e.heldDraft = null; e.editing = false; e.draft = itemOnly(e.head);
      e.message = kinText("보관한 미저장 수정을 버렸습니다. 저장 이력은 유지됩니다.");
      if (manual(e.draft.kind) && e.head.referenceStatus !== 'verified')
        e.message += kinText(" 재확인 필요: 원본 영상의 동일성을 확인할 수 없습니다.");
      row(e); hydrate(); render();
    }
    function row(e) {
      if (!e.element) { e.element = document.createElement('section'); e.element.style.cssText = 'border-top:1px solid #405777;margin-top:8px;padding-top:8px'; list.append(e.element); }
      const el = e.element; el.replaceChildren(); el.dataset.itemId = e.head?.id || ''; el.dataset.kind = e.draft.kind;
      const sourceUnverified = manual(e.draft.kind) && e.head && e.head.referenceStatus !== 'verified';
      // Saved names the server revision; an edit, a save in flight or an unknown answer is not that revision.
      // Source verification keeps its own 재확인 필요 line below, so a saved item stays Saved r<n>.
      const stateLabel = e.busy ? 'Saving' : e.pending ? 'Unverified' : hasWork(e) || !e.head ? 'Unsaved' : 'Saved r' + e.head.revision;
      text(el, 'strong', names[e.draft.kind] + ' · ' + stateLabel + (e.head?.hidden ? ' · Hidden' : ''));
      if (e.head && stateLabel !== 'Saved r' + e.head.revision) text(el, 'div', kinText("서버 저장 이력 r{n0} · 현재 수정·저장 결과와는 별개입니다.", e.head.revision));
      // The clinician projection carries no author (clinician-policy.ts clinicianViewerItem).
      if (e.head) text(el, 'div', readOnly() ? 'Read-only' : e.head.authorActor + (writable(e) ? ' · My Item' : ' · Read-only'));
      if (e.editing) {
        if (e.draft.kind === 'memo') input(el, 'Memo Title', e.draft.title ?? '', value => { e.draft.title = value; updateAnnotation(e); }, !!(e.busy || e.pending));
        // A Spine Label's text is its level; another level is another label.
        if (e.draft.kind === 'spine') text(el, 'p', e.draft.label);
        else input(el, e.draft.kind !== 'key' ? 'Annotation Text' : 'Key Title', e.draft.label ?? e.draft.title, value => {
          e.draft[e.draft.kind !== 'key' ? 'label' : 'title'] = value; updateAnnotation(e);
        }, !!(e.busy || e.pending));
        if (e.draft.kind === 'key') input(el, 'Key Description', e.draft.description || '', value => { e.draft.description = value; }, !!(e.busy || e.pending));
      } else {
        if (e.draft.kind === 'memo' && e.draft.title) text(el, 'p', e.draft.title);
        text(el, 'p', e.draft.kind === 'key' ? e.draft.title : e.draft.label);
        if (e.draft.description) text(el, 'p', e.draft.description);
      }
      // The Measure menu's marks go to no SR and carry no SR conversion; say so instead of leaving them out silently.
      if (measureMark(e.draft.kind)) text(el, 'div', kinText("SR 미지원 표식 · SR 저장에는 들어가지 않습니다."));
      text(el, 'div', kinText("프레임 {0}", e.draft.frame));
      // The saved measurement value (C-R01-131#4): the server head's own baseline, named and rounded as the Findings section names it.
      // A row being edited shows it as the saved revision's value; an unsaved new measurement has no saved value and shows none.
      if (e.head && (manual(e.draft.kind) || valueMark(e.draft.kind))) valueNode(el, 'div', e.head.item, stateLabel === 'Saved r' + e.head.revision ? '' : kinText("저장값 r{n0}: ", e.head.revision));
      if (e.message) text(el, 'p', e.message);
      if (e.heldDraft) {
        text(el, 'p', kinText("미저장 수정은 보관 중입니다. {t0}", (e.head.hidden ?
          kinText("숨김을 복원하고 원본을 확인한 후 다시 편집할 수 있습니다.") : kinText("원본을 다시 확인하면 보관한 수정으로 돌아갑니다."))));
        const held = text(el, 'details', ''); text(held, 'summary', 'Held Changes');
        text(held, 'p', e.heldDraft.label ?? e.heldDraft.title);
        if (e.heldDraft.description) text(held, 'p', e.heldDraft.description);
        text(held, 'p', kinText("프레임 {0} · 아직 저장되지 않은 내용입니다.", e.heldDraft.frame));
      }
      button(el, 'Go to Image', () => navigate(e));
      // Recheck and remeasure belong to the writer; a read-only row keeps the "재확인 필요" message hydrate() writes.
      if (sourceUnverified && !e.head.hidden && writer()) {
        text(el, 'p', kinText("저장 이력과 현재 원본 확인은 별개입니다. 이 항목만 다시 확인할 수 있습니다. 원본이 바뀐 경우 새 뷰어에서 다시 측정하세요. 이 창의 수정과 기존 저장 이력은 유지됩니다."));
        if (!e.heldDraft) button(el, 'Recheck Source', () => {
          if (valid(generation) && entries.get(e.id) === e && !e.busy && !e.pending) return load(false, e.head.id);
        }, !!(e.busy || e.pending));
        const link = text(el, 'a', 'Remeasure in New Viewer');
        link.href = '/ohif/viewer?StudyInstanceUIDs=' + encodeURIComponent(scope);
        link.target = '_blank'; link.rel = 'noopener noreferrer';
      }
      if (writable(e)) {
        if (e.pending) button(el, 'Retry Request', () => save(e), !!e.busy);
        else if (e.editing) button(el, 'Save', () => save(e, 'edit'), !!e.busy || !!e.latest || !!sourceUnverified);
        else if (!e.head?.hidden) button(el, 'Edit', () => { e.editing = true; lock(e, false); row(e); }, manual(e.draft.kind) && e.head?.referenceStatus !== 'verified');
        if (e.head && !e.editing && !e.pending) button(el, e.head.hidden ? 'Restore' : 'Hide', () => {
          const reason = window.prompt(kinText("{t0} 사유 (선택)", (e.head.hidden ? kinText("복원") : kinText("숨김"))));
          if (reason !== null) save(e, e.head.hidden ? 'restore' : 'hide', reason);
        }, !!e.busy);
        if (e.latest && !e.pending) button(el, 'Use Latest & Keep Changes', () => {
          e.head = e.latest; e.latest = null;
          if (e.head.hidden) {
            if (e.editing) e.heldDraft ??= clone(e.draft);
            removeAnnotation(e); render();
            e.editing = false; e.draft = itemOnly(e.head); e.message = kinText("서버에서 숨겨졌습니다.");
          }
          else if (e.heldDraft) { e.draft = itemOnly(e.head); restoreHeldDraft(e); }
          // Keeping the reader's changes over the latest revision is the decision to save them: saved on their own from here (autoReady).
          else if (e.editing) { e.message = autoMarks() ? kinText("최신판을 확인했습니다. 내 수정을 곧 저장합니다.") : kinText("최신판을 확인했습니다. 저장을 눌러야 내 수정이 반영됩니다."); autoSeen(e, false); }
          else { e.draft = itemOnly(e.head); e.message = kinText("최신 서버판을 반영했습니다."); }
          row(e); hydrate(); render();
        }, !!e.busy);
        if (e.heldDraft) {
          if (!e.head.hidden) button(el, 'Recheck Source', () => {
            if (heldActionReady(e)) return load(false, e.head.id);
          }, !!(e.busy || e.pending));
          button(el, 'Discard Held Changes', () => discardHeld(e), !!(e.busy || e.pending));
        }
      }
      // Revisions carry authors and hidden states; that route is a writer read, not a clinician one (S5-U1b allowlist).
      // A second press closes the list it opened (C-R01-011#16); the next row(e) clears it as before.
      let history = null;
      if (e.head && writer()) {
        const toggle = button(el, 'History', async () => {
          if (history?.isConnected) { history.remove(); history = null; toggle.setAttribute('aria-expanded', 'false'); return; }
          const ticket = generation, list = history = document.createElement('div'); let cursor = null, count = 0;
          list.dataset.kinHistory = ''; el.append(list); toggle.setAttribute('aria-expanded', 'true');
          const more = async () => {
            const data = await api(path() + '/' + e.head.id + '/revisions?limit=50' + (cursor ? '&cursor=' + cursor : ''), {}, ticket);
            if (!valid(ticket) || !el.isConnected || !list.isConnected) return;
            // Each revision with its own saved value (C-R01-011#15), so r1 and r2 can be compared.
            for (const r of data.revisions) {
              const line = text(list, 'p', 'r' + r.revision + ' · ' + ({ create: kinText("생성"), edit: kinText("수정"), hide: kinText("숨김"), restore: kinText("복원"), delete: kinText("삭제") }[r.action] || r.action) + ' · ' + r.actor + ' · ' + r.at + ' · ' + r.reason + ' · ' + (r.item.label ?? r.item.title));
              if (manual(r.item.kind)) valueNode(line, 'span', r.item, ' · ');
            }
            count += data.revisions.length; cursor = data.nextCursor;
            if (cursor && count < 4096) button(list, 'Load More History', more);
          };
          await more();
        });
        toggle.setAttribute('aria-expanded', 'false');
      }
      // Delete, after the row's other controls: a saved item is deleted on the server (its revisions kept there), one not
      // saved yet just goes. Not while its save is on its way or its answer is not known.
      if (writable(e) && !e.pending) button(el, 'Delete', () => deleteEntry(e), !!e.busy);
    }
    // closing: sent as the window closes or the study changes (autosave): at once, with keepalive, without this panel's /me
    // first (the page gate and the session watcher end the panel on another account or a logout; the server checks the caller).
    async function save(e, action, reason, closing = false) {
      if (!valid(generation) || entries.get(e.id) !== e || !writable(e) || e.busy || ended) return;
      // A verdict can change without a revision. A retained draft must never
      // bind itself to different source bytes by repeatedly retrying an edit.
      if (!e.pending && e.editing && manual(e.draft.kind) && e.head && e.head.referenceStatus !== 'verified') {
        e.message = kinText("재확인 필요: 원본을 다시 확인하거나 새 뷰어에서 재측정하세요. 작성 내용은 유지됩니다."); row(e); return;
      }
      if (manual(e.draft.kind) && e.editing && !e.pending) {
        const baseline = sample(e.annotationUID && ct.annotation.state.getAnnotation(e.annotationUID));
        if (!baseline) { e.message = kinText("측정을 마치고 계산 완료 후 저장하세요."); row(e); return; }
        e.draft.baseline = baseline;
      }
      const ticket = generation; e.busy = true; lock(e, true);
      if (!e.pending) {
        const annotation = e.annotationUID && ct.annotation.state.getAnnotation(e.annotationUID);
        if (e.editing && annotation) {
          e.draft.points = clone(annotation.data.handles.points);
          e.draft.label = annotation.data.text ?? annotation.data.label ?? '';
          Object.assign(e.draft, markFields(e.draft.kind, annotation.data));
        }
        // A mark with values (a circle, an orthopaedic measurement, a line tool's mark) is saved only with the values of the place
        // it is at, computed again from the original now; a mark of values whose check is missing is not saved.
        if (valueMark(e.draft.kind) && e.editing) {
          const frame = window.KinMeasureFrame, what = e.draft.kind === 'circle' ? kinText("원") : kinText("측정");
          const reason = !e.draft.baseline ? kinText("{0}의 값이 계산된 뒤 저장하세요.", what) : !annotation ? kinText("현재 영상에서 {0} 표식을 찾을 수 없습니다.", what) :
            typeof frame?.verify === 'function' ? frame.verify(annotation, true) : kinText("{0}의 값을 다시 확인할 수 없습니다.", what);
          if (reason) { e.busy = false; lock(e, !e.editing); e.message = reason; row(e); return; }
        }
        const command = { requestId: crypto.randomUUID(), item: clone(e.draft) };
        if (e.head) Object.assign(command, { expectedRevision: e.head.revision, action, ...(reason ? { reason } : {}) });
        e.pending = { url: path() + (e.head ? '/' + e.head.id + '/revisions' : ''), body: JSON.stringify(command) };
      }
      row(e);
      try {
        if (!closing) await authenticate(ticket);
        const head = await api(e.pending.url, { method: 'POST', body: e.pending.body, ...(closing ? { keepalive: true } : {}) }, ticket, closing);
        if (!valid(ticket) || !entries.has(e.id)) return;
        // Deleted: off the image and the list. The server keeps the item and its revisions; no list shows it again.
        if (head.item?.deleted === true) {
          deletedHere.add(head.id); removeAnnotation(e); entries.delete(e.id); e.element?.remove();
          recount(kinText("{0} 항목을 지웠습니다. 저장 이력은 서버에 남습니다. ", names[e.draft.kind])); render(); return;
        }
        const duplicate = entries.get(head.id);
        if (duplicate && duplicate !== e && hasWork(duplicate)) {
          // A lost create receipt can be listed before its retry resolves.
          // Keep edits started on that listed row instead of overwriting them.
          removeAnnotation(e); e.element?.remove(); entries.delete(e.id);
          duplicate.message = kinText("같은 요청의 저장 결과를 확인했습니다. 이 항목의 작성 내용은 유지됩니다.");
          row(duplicate); return;
        }
        if (duplicate && duplicate !== e) { removeAnnotation(duplicate); duplicate.element?.remove(); }
        entries.delete(e.id); e.id = head.id; entries.set(e.id, e);
        Object.assign(e, { head, draft: itemOnly(head), pending: null, latest: null, editing: false, message: kinText("저장 완료") });
        restoreHeldDraft(e);
        if (manual(e.draft.kind) && head.referenceStatus !== 'verified') {
          e.message = kinText("저장 완료 · 재확인 필요: 원본 영상의 동일성을 확인할 수 없습니다. 새로고침으로 다시 확인하세요.");
          removeAnnotation(e);
        } else if (head.hidden) removeAnnotation(e);
        else lock(e, !e.editing);
      } catch (error) {
        if (error.stale || !valid(ticket)) return;
        e.message = errorMessage(error);
        if (error.status >= 400 && error.status < 500) { e.pending = null; lock(e, !e.editing); }
        if (error.status === 409) await load();
      } finally {
        if (valid(ticket) && entries.has(e.id)) { e.busy = false; row(e); }
        if (valid(ticket)) recount();
      }
    }
    // ── Marks saved without the Save button ──
    // With Auto Save View's account setting on (viewer-features-autosave.js, window.KinViewerAutoSave) a mark is saved on its
    // own: a new one once it is drawn, a saved one once it is changed under Edit (moved, resized, its text). Every way a mark is
    // drawn, changed or left passes this one gate (autoReady); the sending is save() as the Save button's, with its checks,
    // its request id and its answers. What is not ready (a value not checked yet, the source to be checked again, another
    // revision on the server, held work brought back) keeps its row's message and buttons as without the setting.
    const AUTO_QUIET = 500, AUTO_RETRY = 5000;
    const autoMarks = () => { try { return window.KinViewerAutoSave?.marks?.() === true; } catch (_) { return false; } };
    // What a save would change: its place, its words, a value mark's values.
    const content = item => JSON.stringify([item?.points ?? null, item?.label ?? null, item?.title ?? null, item?.description ?? null,
      valueMark(item?.kind) ? item?.baseline ?? null : null]);
    // A press held down (a drag of a handle or of a Measure menu mark) and words being typed into this row or a dialog.
    let pressing = false;
    const typing = e => {
      const f = document.activeElement;
      return !!f?.matches?.('input, textarea, [contenteditable=""], [contenteditable="true"]') && !!(e.element?.contains(f) || f.closest?.('[role=dialog], .kin-ux-feature-panel'));
    };
    // seen: this content counts as already sent (or refused) once, so it is sent again only after it changes.
    function autoSeen(e, seen) {
      const text = content(e.draft);
      e.auto = { text, at: Date.now(), tried: seen ? text : null, sent: 0 };
    }
    function autoReady(e, now, closing) {
      if (!autoMarks() || ended || suspended || held() || !valid(generation) || entries.get(e.id) !== e || !writable(e) || e.busy) return false;
      const auto = e.auto ??= { text: null, at: now, tried: null, sent: 0 };
      // A request whose answer is not known goes again with the same body (the server answers a repeated request id once),
      // before anything else about the row: another revision listed meanwhile may be that request's own.
      if (e.pending) return closing || now - auto.sent >= AUTO_RETRY;
      if (e.heldDraft || e.latest || !e.editing) return false;
      const text = content(e.draft);
      if (text !== auto.text) { auto.text = text; auto.at = now; }
      if (auto.tried === text || e.head && text === content(e.head.item)) return false;
      // Closing skips only the quiet wait: a press or a tool still moving a mark is never saved midway, closing or not (a closing
      // that goes on leaves it to the leave warning). Words typed into the row are as the reader left them when the window closes.
      if (pressing || ct.state?.isInteractingWithTool === true) return false;
      if (!closing && (now - auto.at < AUTO_QUIET || typing(e))) return false;
      if (manual(e.draft.kind) && e.head && e.head.referenceStatus !== 'verified') return false;
      // A key image has its fields only.
      if (!tools[e.draft.kind]) return true;
      const a = e.annotationUID && ct.annotation.state.getAnnotation(e.annotationUID);
      if (!a || unfinished(a)) return false;
      // scan() has just judged it against the original (kinUnverified): a value that differs from its saved one waits.
      if (manual(e.draft.kind)) return !a.data.kinUnverified && !!sample(a);
      if (valueMark(e.draft.kind)) return !!e.draft.baseline && !window.KinMeasureFrame?.verify?.(a, true);
      return true;
    }
    // closing: the window closes or the study changes — what is ready goes now, a request already on its way is sent again
    // with keepalive (the same body). Answers the entries that were sent.
    function autosave(closing = false) {
      if (!autoMarks()) return [];
      const now = Date.now(), sent = [];
      for (const e of [...entries.values()]) {
        // A request on its way may be cut by the closing: every closing event sends it again with keepalive, the same body and
        // request id (the server answers a repeated request id once, under the study's lock), whatever earlier closings did.
        if (closing && e.busy && e.pending && writable(e)) { beacon(e.pending); sent.push(e); continue; }
        if (!autoReady(e, now, closing)) continue;
        e.auto.sent = now;
        if (!e.pending) e.auto.tried = content(e.draft);
        sent.push(e);
        save(e, e.pending ? undefined : e.head ? 'edit' : 'create', undefined, closing).catch(() => {});
      }
      return sent;
    }
    function beacon(pending) {
      try {
        fetch('/api' + pending.url, { method: 'POST', body: pending.body, keepalive: true, cache: 'no-store', credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' } }).catch(() => {});
        return true;
      } catch (_) { return false; }
    }
    // The window closing with the setting on: this study's marks as above, and held work of another study (a comparison
    // study's cell was pressed) whose request was prepared goes to that study. A request sent is not yet a saved mark: the
    // leave warning still counts it until its answer, and a window kept open takes that answer as usual.
    function closeSend() {
      if (!autoMarks() || ended || kinViewerSession.ended()) return;
      // A mark finished since the last observation tick has its row first.
      try { captureAnnotations(); } catch (_) {}
      autosave(true);
      for (const r of recovery.values()) if (r.subject === subject)
        for (const x of r.entries) if (x.pending) beacon(x.pending);
    }
    // Delete: the row's Delete, the image's "Delete measurement" and the Measurements panel's delete all come here.
    async function deleteEntry(e) {
      if (!valid(generation) || entries.get(e.id) !== e || !writable(e) || e.busy || e.pending) return;
      if (!e.head) {
        // Nothing saved: the drawing (or the key image row) goes.
        if (e.annotationUID) removeMark(e.annotationUID); else { entries.delete(e.id); e.element?.remove(); }
        return;
      }
      if (!window.confirm(kinText("{0} 저장 항목(r{n1})을 지우시겠습니까? 영상과 목록에서 사라지고 되돌릴 수 없습니다. 저장 이력은 서버에 남습니다.", names[e.draft.kind], e.head.revision))) return;
      if (!valid(generation) || entries.get(e.id) !== e || !writable(e) || e.busy || e.pending) return;
      // The saved revision is what is deleted; edits not saved yet go with it.
      if (e.editing) { e.editing = false; e.draft = itemOnly(e.head); e.message = ''; }
      return save(e, 'delete');
    }
    // A delete asked of the pinned viewer (its context menu or its Measurements panel) for a uid this panel drew from a saved
    // item: true when taken here (deleted, or refused with the reason), false for a drawing not saved yet.
    function readerDelete(uid) {
      const e = uid && annotations.get(uid);
      if (!e?.head) return false;
      if (nativeAuthoringClosed()) status.textContent = closedText('edit');
      else if (!writable(e)) status.textContent = kinText("내가 저장한 항목만 지울 수 있습니다. 지우지 않았습니다.");
      else if (e.busy || e.pending) status.textContent = kinText("저장 결과를 확인한 뒤 지우세요. 지우지 않았습니다.");
      else void deleteEntry(e).catch(() => {});
      return true;
    }
    // Selection and highlight of the hydrated annotation behind a finding source; a hidden,
    // unverified or key-image source navigates just the same and reports why nothing is drawn.
    // S2-C: every answer for a linked item also reports this viewer's own entry at arrival (present, its saved revision, hidden,
    // and whether it is being edited or saved), so the finding discloses what is drawn instead of its list state.
    function highlight(itemId) {
      if (!itemId) return { highlighted: false, annotation: 'none' };
      const e = [...entries.values()].find(x => x.head?.id === itemId);
      if (!e) return { highlighted: false, annotation: 'missing', present: false };
      const live = { present: true, revision: e.head.revision, hidden: !!e.head.hidden, working: !!(e.editing || e.pending || e.busy) };
      if (e.head.hidden) return { highlighted: false, annotation: 'hidden', ...live };
      if (!tools[e.draft.kind]) return { highlighted: false, annotation: 'key', ...live };
      const a = e.annotationUID && ct.annotation.state.getAnnotation(e.annotationUID);
      if (!a) return { highlighted: false, annotation: manual(e.draft.kind) && e.head.referenceStatus !== 'verified' ? 'unverified' : 'none', ...live };
      for (const other of ct.annotation.state.getAllAnnotations())
        if (other.annotationUID !== a.annotationUID && kinds[other.metadata.toolName] && other.highlighted) other.highlighted = false;
      a.highlighted = true;
      try { ct.annotation.selection?.setAnnotationSelected?.(a.annotationUID, true, false); } catch (_) {}
      render();
      return { highlighted: true, annotation: 'shown', ...live };
    }
    const navigationEnv = { services, viewport, reference, matches, hydrate, highlight,
      ended: () => ended, scope: () => scope, busy: () => suspended || held(),
      generation: () => generation, valid, navigation: () => navigation, beginNavigation: () => ++navigation,
      delay: () => new Promise(resolve => setTimeout(resolve, 100)) };
    const navigateTo = target => kinViewerNavigateTo(navigationEnv, target);
    const activateStudy = study => kinViewerActivateStudy(navigationEnv, study);
    // The active viewport and the frame it shows: the Findings section's arrival proof after an activation.
    const shownImage = () => {
      try {
        const id = services.viewportGridService.getActiveViewportId();
        return { viewportId: typeof id === 'string' ? id : null, image: reference(services.cornerstoneViewportService.getCornerstoneViewport(id)?.getCurrentImageId?.()) };
      } catch (_) { return { viewportId: null, image: null }; }
    };
    async function navigate(e) {
      if (!valid(generation) || suspended || held() || entries.get(e.id) !== e) return;
      const outcome = await navigateTo({ studyUid: scope, seriesUid: e.draft.seriesUid, sopUid: e.draft.sopUid, frame: e.draft.frame });
      if (outcome.ok || !valid(generation) || entries.get(e.id) !== e) return;
      const message = { 'series-missing': kinText("현재 검사에서 원본 시리즈를 찾을 수 없습니다."), 'frame-missing': kinText("원본 프레임을 열지 못했습니다."),
        'viewport-unsupported': kinText("현재 화면은 원본 프레임 목록이 없는 MPR/볼륨 화면입니다. 일반 프레임 화면을 선택한 뒤 이동하세요.") }[outcome.reason];
      if (message) { e.message = message; row(e); }
    }
    // Read-only view of the saved heads for the Findings section: only saved rows are linkable and
    // the Orthanc verdict travels with them, separate from any database link state.
    const historyState = () => ({ scope, subject, ended, suspended: suspended || held(), writable: writable({}),
      generation, loading, ...shownImage(),
      heads: [...entries.values()].filter(e => e.head).map(e => ({ id: e.head.id, revision: e.head.revision, hidden: !!e.head.hidden,
        kind: e.draft.kind, label: e.draft.label ?? e.draft.title ?? '', seriesUid: e.head.item.seriesUid, sopUid: e.head.item.sopUid,
        frame: e.head.item.frame, authorSub: e.head.authorSub, referenceStatus: manual(e.draft.kind) ? e.head.referenceStatus ?? 'unverified' : null,
        calculator: e.head.item.baseline?.calculator, values: Array.isArray(e.head.item.baseline?.values) ? [...e.head.item.baseline.values] : null, working: !!(e.editing || e.pending || e.busy),
        // A saved Volume's lengths are on frames of their own: the Measure menu draws them there before its result is drawn.
        annotation: e.annotationUID || null, ...(e.draft.kind === 'volume' ? { item: { label: e.head.item.label, baseline: clone(e.head.item.baseline) } } : {}) })) });
    function hydrate() {
      const v = viewport(), imageId = v?.getCurrentImageId?.(), r = reference(imageId);
      if (!r || r.study !== scope || !subject || ended || suspended || held()) return;
      configureMeasurements(ct.ToolGroupManager.getToolGroupForViewport(v.id, v.renderingEngineId));
      const plane = cs.metaData.get('imagePlaneModule', imageId);
      for (const e of entries.values()) {
        if (!e.head && !e.rehydrate || e.head?.hidden || !tools[e.draft.kind] || e.annotationUID || !matches(r, e.draft) || (plane?.frameOfReferenceUID ?? null) !== e.draft.frameOfReferenceUid) continue;
        if (manual(e.draft.kind) && e.head && e.head.referenceStatus !== 'verified') {
          if (!e.message) { e.message = kinText("재확인 필요: 원본 영상의 동일성을 확인할 수 없습니다."); row(e); }
          continue;
        }
        const uid = crypto.randomUUID(), camera = v.getCamera();
        const a = { annotationUID: uid, highlighted: false, invalidated: true, isLocked: true, isVisible: true,
          metadata: { toolName: tools[e.draft.kind], FrameOfReferenceUID: e.draft.frameOfReferenceUid ?? v.getFrameOfReferenceUID(), referencedImageId: imageId, viewPlaneNormal: e.draft.viewPlaneNormal || camera.viewPlaneNormal, viewUp: e.draft.viewUp || camera.viewUp },
          data: { text: e.draft.label, label: e.draft.label, kinUnverified: manual(e.draft.kind) && !e.editing, handles: { points: clone(e.draft.points), activeHandleIndex: null, textBox: { hasMoved: false, worldPosition: [0, 0, 0], worldBoundingBox: { topLeft: [0, 0, 0], topRight: [0, 0, 0], bottomLeft: [0, 0, 0], bottomRight: [0, 0, 0] } } }, cachedStats: {},
            ...(e.draft.kind === 'memo' ? { title: e.draft.title ?? '' } : {}), ...(valueMark(e.draft.kind) ? { kinBaseline: clone(e.draft.baseline) } : {}) } };
        trackMeasurement(a);
        e.rehydrate = false;
        ct.annotation.state.addAnnotation(a, v.element); e.annotationUID = uid; annotations.set(uid, e); lock(e, !!(e.pending || e.busy || !e.editing)); render();
      }
    }
    function scan() {
      checkDrawings();
      if (window.KinWorkContext?.state() === 'preparing') return;
      // The observation tick sees the document's end first (X4-R-001 F02): whichever way it was noted, this panel ends with it.
      if (!ended && kinViewerSession.ended()) end();
      closeAuthoring();
      if (ended) return;
      if (pendingValues.size) {
        // Only the value nodes are filled: no row is rebuilt, so open History lists, fields and the focus are untouched.
        const ready = valueModule();
        for (const p of pendingValues) {
          const node = ready && p.anchor.isConnected ? valueElement(p.tag, p.item, p.prefix) : null;
          if (node) p.anchor.replaceWith(node);
          if (ready || !p.anchor.isConnected) pendingValues.delete(p);
        }
      }
      kinViewerToolbarLabels.outputScope(document);
      const r = current();
      if (r && r.study !== scope) {
        // Rows not saved yet are held with the study (park) and, with marks saved on their own, taken up and saved when its
        // image is active again (load); a request of theirs already prepared goes as the window closes (closeSend).
        park(); reset(kinText("검사 확인 중…")); scope = r.study; me = null;
        load(); return;
      }
      // No /me has answered this panel yet (errors, time-outs): ask again on focus and every 15 s, so that a passing failure
      // does not leave a writer with image viewing only until the next study (authoring waits for a writer answer).
      if (!subject && scope && !loading && Date.now() - tried > 15000) { load(); return; }
      // S5-U2b-R-002 F02: the final list a clinician-only document shows is checked whether or not a source frame is identified.
      if (readOnly()) { frameMatch(r); recheckShown(); }
      // Switching display sets briefly removes the viewport. Mode exit, not
      // that loading gap, owns teardown of drafts and in-flight commands.
      if (!r) return;
      if (!subject || !scope || suspended || held()) return;
      const v = viewport();
      configureMeasurements(v && ct.ToolGroupManager.getToolGroupForViewport(v.id, v.renderingEngineId));
      for (const a of ct.annotation.state.getAllAnnotations()) {
        if (!manual(kinds[a.metadata.toolName])) continue;
        trackMeasurement(a);
        if (a.metadata.referencedImageId === v.getCurrentImageId() &&
            !freshStats(a.data, 'imageId:' + a.metadata.referencedImageId)) {
          a.invalidated = true; render();
        }
      }
      for (const e of entries.values()) {
        const a = e.annotationUID && ct.annotation.state.getAnnotation(e.annotationUID);
        if (e.annotationUID && !a) {
          annotations.delete(e.annotationUID); e.annotationUID = null;
          if (!e.head && !e.pending) { entries.delete(e.id); e.element?.remove(); continue; }
        }
        if (a && e.head && !e.editing) {
          a.data.text = e.draft.label;
          a.data.handles.points = clone(e.draft.points);
          if (e.draft.kind === 'memo') a.data.title = e.draft.title ?? '';
          if (valueMark(e.draft.kind)) a.data.kinBaseline = clone(e.draft.baseline);
          lock(e, true);
        }
        if (a && e.head && manual(e.draft.kind)) {
          const actual = sample(a), baseline = e.head.item.baseline;
          const remeasured = e.editing && geometry(a.data) !== JSON.stringify(e.head.item.points);
          const mismatch = e.head.referenceStatus !== 'verified' || !actual || !remeasured &&
            (actual.calculator !== baseline?.calculator || actual.values.length !== baseline?.values?.length ||
            actual.values.some((value, index) => value !== baseline.values[index]));
          if (a.data.kinUnverified !== mismatch) { a.data.kinUnverified = mismatch; render(); }
          if (mismatch && actual && !rechecking(e.message)) {
            e.message = e.head.referenceStatus !== 'verified' ? kinText("재확인 필요: 원본을 확인하지 못했습니다. 작성 내용은 유지됩니다.") :
              kinText("재확인 필요: 재계산 값이 저장 당시와 다릅니다. 편집 후 다시 측정하세요."); row(e);
          }
          else if (!mismatch && rechecking(e.message)) { e.message = e.editing ? kinText("재측정 확인 완료. 작성 내용은 아직 미저장 상태입니다.") : ''; row(e); }
        }
      }
      hydrate();
      captureAnnotations();
      autosave();
      // The writer's access probe (a 403 parks the drafts in deny()); a clinician-only document is checked above.
      if (!readOnly() && Date.now() - lastAuth > 15000 && !checking) {
        checking = true; const ticket = generation;
        authenticate(ticket).then(() => api(path() + '?limit=1', {}, ticket)).catch(() => {}).finally(() => { checking = false; });
      }
      refreshMeasurementViews(); refreshSrButtons();
    }
    function captureAnnotations() {
      if (!window.KinViewerSessionBoundary?.active()) return;
      // Not a confirmed writer: a mark drawn with the viewer's own tools never becomes an unsaved item of this panel.
      if (suspended || recovery.has(scope) || !writer()) return;
      for (const a of ct.annotation.state.getAllAnnotations()) {
        const kind = kinds[a.metadata.toolName];
        // A screen-calibrated Length is no saved measurement: no row, so no Save, automatic save or closing send.
        if (screenData(a.data)) continue;
        const count = kind === 'angle' ? 3 : kind === 'ellipse' ? 4 : ['text', 'memo', 'spine', 'volume'].includes(kind) ? 1 : lineMark(kind) ? linePoints(a.data?.kinBaseline) : ORTHO[kind] || 2;
        if (!kind || !matches(reference(a.metadata.referencedImageId), { ...reference(a.metadata.referencedImageId) }) || !Array.isArray(a.data.handles?.points) || a.data.handles.points.length !== count || (kind === 'arrow' || measureMark(kind)) && typeof a.data.text !== 'string') continue;
        let e = annotations.get(a.annotationUID);
        if (!e) {
          // A drawing the tool has not ended is not a measurement yet, and a Length of no length never is: no row.
          if (unfinished(a) || kind === 'length' && samePoint(a.data.handles.points)) continue;
          const ref = reference(a.metadata.referencedImageId);
          e = { id: crypto.randomUUID(), annotationUID: a.annotationUID, editing: true,
            draft: { schemaVersion: 1, kind, seriesUid: ref.seriesUid, sopUid: ref.sopUid, frame: ref.frame, frameOfReferenceUid: measureMark(kind) || manual(kind) && (planar(a.metadata.referencedImageId, kind) || cs.metaData.get('instance', a.metadata.referencedImageId)?.Modality === 'MG')
                ? cs.metaData.get('instance', a.metadata.referencedImageId)?.FrameOfReferenceUID || null : a.metadata.FrameOfReferenceUID, label: a.data.text ?? a.data.label ?? '', points: clone(a.data.handles.points),
              ...(manual(kind) ? { viewPlaneNormal: clone(a.metadata.viewPlaneNormal), viewUp: clone(a.metadata.viewUp) } : {}), ...markFields(kind, a.data) } };
          entries.set(e.id, e); annotations.set(a.annotationUID, e); row(e);
        } else if (e.editing && !e.busy && !e.pending) {
          e.draft.points = clone(a.data.handles.points);
          Object.assign(e.draft, markFields(kind, a.data));
          const label = a.data.text ?? a.data.label ?? '';
          if (e.draft.label !== label) { e.draft.label = label; row(e); }
        }
      }
    }

    const onFocus = () => { lastAuth = 0; tried = 0; };
    // A document that is not a confirmed writer has no mark to save, so an unlocked native mark is not unsaved work there.
    const jobGuard = () => recovery.size > 0 || [...entries.values()].some(x => hasWork(x) || x.busy) || writer() &&
      ct.annotation.state.getAllAnnotations().some(a => kinds[a.metadata.toolName] && !unfinished(a) && !screenData(a.data) && !ct.annotation.locking.isAnnotationLocked(a.annotationUID));
    // Finding drafts (including ones held for another study) count for the whole-viewer guards:
    // worklist Next Study, window reuse/close, cell merge/hanging protocol and page unload. They are
    // deliberately not part of the mark-only kinViewerHistoryHasUnsaved used by Job save/restore,
    // which never touches a finding. An unreadable state is uncertainty, not permission.
    const findingsWork = () => {
      try { const f = typeof window.kinViewerFindingsState === 'function' ? window.kinViewerFindingsState() : null; return { dirty: f?.dirty === true, busy: f?.busy === true }; }
      catch (_) { return { dirty: true, busy: true }; }
    };
    // Native marks exist before the next history scan; warn during that gap too.
    // With marks saved on their own the marks that are ready go first (closeSend); what is not answered yet still warns.
    const beforeUnload = e => { closeSend(); if (jobGuard() || findingsWork().dirty) { e.preventDefault(); e.returnValue = ''; } };
    // A closing that asks nothing first (a tab closed by the browser or the test runner) still sends them.
    const pageHide = () => { closeSend(); };
    window.kinViewerHistoryHasUnsaved = jobGuard;
    const workspaceState = () => {
      const findings = findingsWork();
      return { dirty: jobGuard() || findings.dirty, busy: [...entries.values()].some(x => x.busy || x.pending) || findings.busy };
    };
    window.kinViewerHistoryWorkspaceState = workspaceState;
    // The Measure menu's panel asks this before every press and drag it takes on a cell: '' when a mark of this study may be
    // made or moved there now, otherwise the reason. The same conditions as the measuring tools' own press (configureMeasurements).
    const markGate = imageId => {
      if (ended || !writer() || !window.KinViewerSessionBoundary?.active()) return closedText('tool');
      if (!subject || suspended || recovery.has(scope)) return kinText("현재 검사 접근과 보관 작업을 확인한 후 측정하세요.");
      if (window.KinWorkContext?.state() === 'preparing') return kinText("작업 공간을 준비하는 중입니다. 잠시 뒤 다시 누르세요.");
      const r = imageId ? reference(imageId) : null;
      if (!r || r.study !== scope) return kinText("현재 검사의 원본 프레임에서만 표식을 만듭니다.");
      return '';
    };
    window.kinViewerHistoryMarkGate = markGate;
    window.kinViewerHistoryNavigate = navigateTo;
    window.kinViewerHistoryActivate = activateStudy;
    window.kinViewerHistoryState = historyState;
    let channel;
    try { channel = kinViewerOnEnd(() => sessionEnded('logout')); } catch (_) {}
     window.addEventListener('focus', onFocus); window.addEventListener('beforeunload', beforeUnload); window.addEventListener('pagehide', pageHide);
    // The pinned viewer changes active viewports through several services. A
    // bounded observation timer also covers stack frame changes without patching them.
    const timer = setInterval(() => { try { scan(); } catch (_) { status.textContent = kinText("현재 영상 연결을 확인할 수 없습니다."); } }, 250);
    // Identity changes must invalidate immediately, even for A→B→A within one
    // observation tick. Stack events and active-viewport events own that boundary.
    const onImage = () => { try { scan(); } catch (_) {} };
    const stackEvent = cs.Enums.Events.STACK_NEW_IMAGE;
    document.addEventListener(stackEvent, onImage, true);
    const subscriptions = Object.values(services.viewportGridService.EVENTS).map(event => services.viewportGridService.subscribe(event, onImage));
    // An unfinished drawing ends with the tool's own report, and is checked the moment any tool changes mode; another
    // image or cell reaches the scan above through the stack and grid events.
    const toolEvents = ct.Enums?.Events || {};
    const drawingEvents = cs.eventTarget ? [[toolEvents.ANNOTATION_COMPLETED, drawingCompleted], [toolEvents.TOOL_MODE_CHANGED, checkDrawings],
      [toolEvents.ANNOTATION_MODIFIED, pointsPlaced]].filter(([name]) => name) : [];
    for (const [name, listener] of drawingEvents) cs.eventTarget.addEventListener(name, listener);
    // A held press is not saved under (autoReady); it ends with its release wherever that is, or with the window losing it.
    const pressed = () => { pressing = true; }, released = () => { pressing = false; };
    const lost = event => { if (event.target === window) pressing = false; };
    const drawingInputs = [['pointerdown', leaveByPress], ['wheel', leaveByWheel], ['keydown', leaveByKey],
      ['pointerdown', pressed], ['pointerup', released], ['pointercancel', released], ['blur', lost]];
    for (const [name, listener] of drawingInputs) window.addEventListener(name, listener, { capture: true, passive: true });
    stop = () => { end(true); clearInterval(timer); channel?.close(); document.removeEventListener(stackEvent, onImage, true); subscriptions.forEach(s => s.unsubscribe());  window.removeEventListener('focus', onFocus); window.removeEventListener('beforeunload', beforeUnload); window.removeEventListener('pagehide', pageHide); for (const [name, listener] of drawingEvents) cs.eventTarget.removeEventListener(name, listener); for (const [name, listener] of drawingInputs) window.removeEventListener(name, listener, true); for (const restores of configured.values()) restores.reverse().forEach(restore => restore()); configured.clear(); for (const note of cellNotes) { clearTimeout(note.kinTimer); note.remove(); } cellNotes.clear(); panel.remove(); };
    // 판정이 바뀌는 순간(이 패널의 /me가 아니어도): writer면 막는 동안 적어 둔 도구 모드·도구막대를 되돌리고, 그 밖이면 작성
    // 경로를 닫고 이 패널이 그리지 않은 표식을 지운다. read-only는 clinicianBoundary를 지난다. 다른 판정은 그려 둔 행의 컨트롤만
    // 다시 그린다. (Astra S5-U2b-X2-R-001 F01) 어느 확장의 /me든 refused가 되면 이 패널도 끝나고, 끝난 패널은 그 뒤 공유 판정이
    // 무엇이든 작성 경로를 다시 열지 않는다. (X4-R-001 F02) read-only 문서의 종료도 여기로 온다: 확정 목록과 그 표식을 내리고
    // 주기·포커스 확인을 멈춘다.
    const unwatch = kinViewerSession.onChange(next => {
      const own = ownAnswer;
      if (next === 'refused' && !ended) end();
      if (next === 'writer' && !ended) reopenAuthoring(); else closeAuthoring();
      if (ended || !scope) return;
      if (next === 'read-only') clinicianBoundary(own);
      else if (!suspended) { toolbar(); for (const e of entries.values()) row(e); }
    });
    const previousStop = stop;
    stop = () => {
      unwatch(); policyRestores.reverse().forEach(restore => restore());
      for (const record of guardedGroups.values()) record.restore();
      guardedGroups.clear();
      if (window.kinViewerHistoryHasUnsaved === jobGuard) delete window.kinViewerHistoryHasUnsaved;
      if (window.kinViewerHistoryWorkspaceState === workspaceState) delete window.kinViewerHistoryWorkspaceState;
      if (window.kinViewerHistoryMarkGate === markGate) delete window.kinViewerHistoryMarkGate;
      if (window.kinViewerHistoryNavigate === navigateTo) delete window.kinViewerHistoryNavigate;
      if (window.kinViewerHistoryActivate === activateStudy) delete window.kinViewerHistoryActivate;
      if (window.kinViewerHistoryState === historyState) delete window.kinViewerHistoryState;
      if (measurementService.getMeasurements === projectedMeasurements) measurementService.getMeasurements = originalMeasurements;
      reportRestores.reverse().forEach(restore => restore());
      previousStop();
      // After previousStop: the measurement wrappers configureMeasurements put over these restore to them first.
      for (const restore of guardedTools.values()) restore();
      guardedTools.clear();
    };
    // A mode entry in a document whose login already ended (F01; X4-R-001 F02: a read-only document's end too) starts ended: no /me,
    // no list, authoring closed.
    if (kinViewerSession.ended()) end();
    scan();
  }
  return { id: 'kin.viewer-history', preRegistration({ servicesManager, commandsManager, extensionManager }) { services = servicesManager.services; commands = commandsManager; extensions = extensionManager; }, onModeEnter: mount, onModeExit() { stop?.(); stop = null; } };
}
