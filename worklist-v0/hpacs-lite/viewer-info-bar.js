// The viewer write path (viewer-language.js): product words in the reader's screen language, or as written.
function kinText(t, ...p) { const l = typeof window === 'object' && window && window.KinLanguage; return l && l.text ? l.text(t, ...p) : t.replace(/\{[ten]?(\d+)\}/g, (m, i) => String(p[i])); }
function kinHtml(t, ...p) { const l = typeof window === 'object' && window && window.KinLanguage; return l && l.html ? l.html(t, ...p) : t.replace(/\{[ten]?(\d+)\}/g, (m, i) => String(p[i])); }
window.KinViewerInfoBar = (() => {
  const renderedImages = new WeakMap();
  const text = value => typeof value === 'object' && value !== null
    ? String(value.Alphabetic || value.Ideographic || value.Phonetic || '') : String(value ?? '');
  function identity(services, viewportId) {
    const cell = services.viewportGridService.getState().viewports.get(viewportId);
    const viewport = services.cornerstoneViewportService.getCornerstoneViewport(viewportId);
    const ids = cell?.displaySetInstanceUIDs || [];
    const set = ids.length === 1 && services.displaySetService.getDisplaySetByUID(ids[0]);
    let image = viewport?.getCurrentImageId?.();
    if (viewport?.type === 'stack') {
      // The requested index advances before its frame arrives. Only the image
      // observed at a completed render may supply a stack's clinical identity.
      const renderedImage = renderedImages.get(viewport);
      if (!renderedImage || renderedImage !== viewport.getCornerstoneImage?.() || renderedImage.imageId !== image) image = null;
    }
    if (!image && ['orthographic', 'volume3d'].includes(viewport?.type)) {
      const volumeId = viewport.getVolumeId?.(), actors = viewport.getActors?.() || [];
      const volume = volumeId && window.cornerstone.cache.getVolume(volumeId);
      if (actors.length === 1 && (actors[0].referencedId || actors[0].uid) === volumeId && volume?.loadStatus?.loaded) {
        image = volume.imageIds?.[0];
      }
    }
    const instance = image && window.cornerstone.metaData.get('instance', image);
    // A replacement display set can precede the new canvas. Never label the
    // old pixels with that display set's patient or examination.
    const rendered = viewport?.viewportStatus === window.cornerstone.Enums.ViewportStatus.RENDERED;
    const matched = rendered && instance && set && instance.StudyInstanceUID === set.StudyInstanceUID &&
      instance.SeriesInstanceUID === set.SeriesInstanceUID;
    return { viewportId, viewport, cell, set, instance: matched ? instance : null };
  }
  // The text drawn over a cell's image, in one place. Each piece is named here with the corner it stands in and whether
  // it may be moved; a piece placed by its own module keeps that place unless an earlier piece of the same corner is
  // already there, when it moves away from the corner (up from a bottom corner, down from a top one) by its margin, just
  // past the earlier piece. The table's order is the order of precedence: the viewer's own corner text, then the
  // reference/comparison label, then the Display text, the mammography slot label and the Navigation Bar (which keeps its
  // bottom and only starts lower). A module never writes another module's numbers; it calls settle() after it has
  // placed its own piece, and the shell settles every cell when it refreshes. A margin is written only when it changes,
  // so a cell whose text stays where it is (every frame of a cine) is only read.
  const CELL_TEXT = [
    { selector: '[data-cy^="viewport-overlay-"]', corner: node => node.dataset.cy.slice('viewport-overlay-'.length), fixed: true },
    { selector: '.kin-viewer-identity', corner: 'inline', fixed: true },
    { selector: '.kin-viewer-identity-group', corner: node => node.dataset.position, fixed: true },
    { selector: '.kin-display-text > .kin-display-zoom, .kin-display-text > .kin-display-corner', corner: 'inline' },
    { selector: '.kin-mg-slot', corner: 'inline' },
    { selector: '.kin-nav-bar', corner: () => 'top-right', stretch: true },
  ];
  const CORNERS = ['top-left', 'top-right', 'bottom-left', 'bottom-right'];
  const GAP = 2;
  function cornerOf(node, rule) {
    if (rule.corner !== 'inline') return rule.corner(node);
    const set = side => node.style[side] !== '' && node.style[side] !== 'auto';
    const vertical = set('bottom') && !set('top') ? 'bottom' : 'top', horizontal = set('right') && !set('left') ? 'right' : 'left';
    return vertical + '-' + horizontal;
  }
  function settle(pane) {
    if (!pane?.isConnected) return;
    const pieces = [];
    for (const [order, rule] of CELL_TEXT.entries()) for (const node of pane.querySelectorAll?.(rule.selector) || []) {
      const corner = cornerOf(node, rule);
      if (CORNERS.includes(corner)) pieces.push({ node, corner, order, fixed: !!rule.fixed, stretch: !!rule.stretch });
    }
    const placed = [];
    for (const piece of pieces) {
      const { node } = piece, box = node.getBoundingClientRect();
      if (!box.width || !box.height || node.closest('[hidden]') || getComputedStyle(node).visibility === 'hidden') continue;
      const rect = { left: box.left, right: box.right, top: box.top, bottom: box.bottom, corner: piece.corner };
      if (!piece.fixed) {
        const down = piece.corner.startsWith('top'), property = down ? 'marginTop' : 'marginBottom', other = down ? 'marginBottom' : 'marginTop';
        if (node.style[other]) node.style[other] = '';
        // The place its module gave it: where it stands without the shift settled last time.
        const had = parseFloat(node.style[property]) || 0;
        if (down) { rect.top -= had; if (!piece.stretch) rect.bottom -= had; } else { rect.top += had; rect.bottom += had; }
        let shift = 0;
        // Earlier pieces of this corner that this piece would cover, nearest the corner first.
        const before = placed.filter(other => other.corner === piece.corner && other.left < rect.right && other.right > rect.left)
          .sort((a, b) => down ? a.top - b.top : b.bottom - a.bottom);
        for (const earlier of before) {
          const top = rect.top + (down ? shift : -shift), bottom = piece.stretch ? rect.bottom : rect.bottom + (down ? shift : -shift);
          if (earlier.top >= bottom || earlier.bottom <= top) continue;
          shift += down ? earlier.bottom + GAP - top : bottom - (earlier.top - GAP);
        }
        const value = shift > 0 ? Math.ceil(shift) + 'px' : '';
        if (node.style[property] !== value) node.style[property] = value;
        rect.top += down ? shift : -shift;
        if (!piece.stretch) rect.bottom += down ? shift : -shift;
      }
      placed.push(rect);
    }
  }
  function mount({ services, studyActions, cellTools }) {
    const bars = new Map(), labels = new Map();
    function rememberRendered(viewport) {
      if (viewport?.type === 'stack' && viewport.viewportStatus === window.cornerstone.Enums.ViewportStatus.RENDERED) {
        renderedImages.set(viewport, viewport.getCornerstoneImage?.());
      }
    }
    const imageRendered = event => rememberRendered(services.cornerstoneViewportService.getCornerstoneViewport(event.detail?.viewportId));
    const renderedEvent = window.cornerstone.Enums.Events.IMAGE_RENDERED;
    document.addEventListener(renderedEvent, imageRendered, true);
    // An image whose load failed keeps its cell without a rendered identity: name it until that image loads.
    const core = window.cornerstone, failed = new Set();
    const imageFailed = event => { const id = event.detail?.imageId; if (id) { failed.add(id); refresh(); } };
    const imageLoaded = event => { const id = event.detail?.imageId ?? event.detail?.image?.imageId; if (id && failed.delete(id)) refresh(); };
    core.eventTarget?.addEventListener(core.Enums.Events.IMAGE_LOAD_FAILED, imageFailed);
    core.eventTarget?.addEventListener(core.Enums.Events.IMAGE_LOADED, imageLoaded);
    // A study's shown patient arrives (or changes on a new read) after its pixels: redraw the headings then.
    const stopDisplay = window.kinViewerStudyDisplay?.subscribe(() => refresh()) || (() => {});
    // The shell assets can finish loading after the first native render.
    for (const id of services.viewportGridService.getState().viewports.keys()) {
      rememberRendered(services.cornerstoneViewportService.getCornerstoneViewport(id));
    }
    // Attach a bar to every pane that lacks one. The pane reserves the bar's
    // row by its own padding (theme) and the bar overlays it, so attaching a
    // bar changes no size.
    function adopt() {
      const state = services.viewportGridService.getState();
      const ids = [...state.viewports.keys()];
      const panes = [...document.querySelectorAll('[data-cy="viewport-grid"] [data-cy="viewport-pane"]')];
      // Native EmptyViewport has no Cornerstone element. The stock grid emits
      // panes in its service order; verify enabled cells before using that order.
      const ordered = panes.length === ids.length && ids.every((id, index) => {
        const element = services.cornerstoneViewportService.getCornerstoneViewport(id)?.element;
        return !element || panes[index].contains(element);
      });
      for (const [id, bar] of bars) if (!state.viewports.has(id) || !bar.isConnected) {
        bar.remove(); bars.delete(id); labels.delete(id);
      }
      const cells = [];
      for (const [index, id] of ids.entries()) {
        const current = identity(services, id);
        const pane = current.viewport?.element?.closest('[data-cy="viewport-pane"]') || (ordered && panes[index]);
        if (!pane) continue;
        if (!bars.has(id)) {
          const bar = document.createElement('section'); bar.className = 'kin-viewer-info-bar';
          bar.dataset.kinUxOwned = ''; bar.setAttribute('aria-label', 'Viewport Information');
          const label = document.createElement('span'); label.className = 'kin-viewer-info-identity';
          const mode = document.createElement('span'); mode.className = 'kin-viewer-info-mode';
          const study = document.createElement('button'); study.type = 'button'; study.textContent = 'Study ▾';
          study.disabled = true; study.title = kinText("이전 검사 연결은 다음 단계에서 제공됩니다.");
          study.onclick = () => studyActions?.open(id, study);
          // The cell's own compact tools, at the row's end: the image toolbar fills them (cellTools) and they act in this cell.
          const tools = document.createElement('span'); tools.className = 'kin-viewer-cell-tools'; tools.hidden = true;
          tools.setAttribute('role', 'toolbar'); tools.setAttribute('aria-label', 'Cell Tools');
          bar.append(label, mode, study, tools); pane.prepend(bar); bars.set(id, bar);
        }
        cells.push({ id, current, bar: bars.get(id) });
      }
      return { layout: state.layout, cells };
    }
    function refresh() {
      const { layout, cells } = adopt();
      for (const { id, current, bar } of cells) {
        bar.children[2].hidden = !!studyActions?.hidden?.();
        bar.children[2].disabled = !current.instance || !studyActions?.available();
        bar.children[2].title = studyActions?.available() ? kinText("이 셀의 이전 검사 목록을 엽니다.") : kinText("이전 검사 연결은 다음 단계에서 제공됩니다.");
        const previous = labels.get(id);
        const viewportStatus = window.cornerstone.Enums.ViewportStatus;
        // Without a rendered identity: a cell given no images, or whose viewer has no data, has no image; a cell whose
        // current image failed to load says so; otherwise its images are loading.
        const given = current.cell?.displaySetInstanceUIDs?.length && current.viewport;
        // A field a Match or Modify replaced shows the worklist's value (kinViewerStudyDisplay), every other field the image's
        // own, as before; the age is counted from the shown birth date and study date (else the image's Patient's Age).
        // While the next frame loads the last rendered pixels keep their original identity.
        // Recompute their text from this read, including a revocation or an explicit blank.
        const pending = [viewportStatus.LOADING, viewportStatus.PRE_RENDER, viewportStatus.RESIZE].includes(current.viewport?.viewportStatus);
        const retained = pending && current.viewport?.type === 'stack' && previous?.viewport === current.viewport &&
          previous.set === current.set && !failed.has(current.viewport.getCurrentImageId?.());
        const m = current.instance || (retained ? previous.instance : null);
        const display = window.kinViewerStudyDisplay;
        const v = m && display ? display.view(display.of(m.StudyInstanceUID, m.SeriesInstanceUID, text(m.PatientID)), { id: text(m.PatientID),
          name: text(m.PatientName), sex: text(m.PatientSex), birth: text(m.PatientBirthDate), date: text(m.StudyDate),
          desc: text(m.StudyDescription), age: text(m.PatientAge) }) : null;
        const label = m ? [(v ? v.name : text(m.PatientName)) || 'Unknown', (v ? v.sex : text(m.PatientSex)) || 'Unknown',
          (v ? v.age : text(m.PatientAge)) || 'Unknown', (v ? v.id : text(m.PatientID)) || 'Unknown',
          [v ? v.date : text(m.StudyDate), text(m.StudyTime)].filter(Boolean).join(' ') || 'Unknown',
          v ? v.desc : text(m.StudyDescription), text(m.InstitutionName)].filter(Boolean).join(' | ')
          : !given || current.viewport.viewportStatus === viewportStatus.NO_DATA ? 'No image'
          : failed.has(current.viewport.getCurrentImageId?.()) ? 'Load failed' : 'Loading';
        if (m) labels.set(id, { viewport: current.viewport, set: current.set, instance: m });
        else labels.delete(id);
        const type = current.viewport?.type;
        const mode = ({ stack: '2D', orthographic: 'MPR', volume3d: '3D' })[type] || type || 'No image';
        const status = mode + ' | ' + (layout.layoutType === 'grid' ? layout.numRows + '×' + layout.numCols : layout.layoutType);
        // The bar clamps the label to two lines; the full identity stays readable on hover.
        if (bar.children[0].textContent !== label) bar.children[0].textContent = label;
        bar.children[0].title = labels.has(id) ? label : '';
        if (bar.children[1].textContent !== status) bar.children[1].textContent = status;
        bar.children[1].title = kinText("영상 모드는 이 셀, 배치는 전체 뷰어에 적용됩니다.");
        const fill = cellTools?.();
        // A cell given images keeps its tools while its next image loads (every scroll and cine frame): only an empty
        // cell, or one whose viewer has no data, has none.
        const holding = !!given && current.viewport.viewportStatus !== viewportStatus.NO_DATA;
        if (fill) fill(id, bar.children[3], { type, rendered: holding, width: bar.clientWidth }); else bar.children[3].hidden = true;
      }
      for (const pane of document.querySelectorAll('[data-cy="viewport-grid"] [data-cy="viewport-pane"]') || []) settle(pane);
    }
    return {
      refresh,
      adopt: () => { adopt(); },
      invalidate() {
        // Only a bar that names a patient drops it; an empty cell's 'No image' stays until the next refresh.
        for (const [id, bar] of bars) if (labels.has(id)) {
          bar.children[0].textContent = 'Loading';
          bar.children[0].title = '';
        }
        labels.clear();
      },
      dispose() {
        document.removeEventListener(renderedEvent, imageRendered, true);
        core.eventTarget?.removeEventListener(core.Enums.Events.IMAGE_LOAD_FAILED, imageFailed);
        core.eventTarget?.removeEventListener(core.Enums.Events.IMAGE_LOADED, imageLoaded);
        stopDisplay();
        for (const bar of bars.values()) bar.remove(); bars.clear(); labels.clear(); failed.clear();
      },
    };
  }
  return { mount, identity, settle };
})();
