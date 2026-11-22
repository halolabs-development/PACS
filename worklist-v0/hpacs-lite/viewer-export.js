/* Viewer export: actions that stand after Capture in the viewer toolbar and work on what an image cell
   shows. A cell is drawn as the reader sees it: its image canvases, its measurement and annotation layer and
   the image text shown in it. Image Text and Images Only already decide which text is shown, so there is no
   separate overlay choice here. Nothing is sent to the server and nothing is stored.
   Every action pins the cells it started on (viewport, series, shown image) and the viewer's life; a result
   that arrives after any of them changed, even if it changed back, is dropped, never written for another study.
   A series export (Save Series JPEG, Save Video) moves its cell through the series: image k of its file is image k of
   the series as it stood at the start, drawn on the cell, or no file is written; and it never moves a cell again after
   the reader did (claim()). */
// The viewer write path (viewer-language.js): product words in the reader's screen language, or as written.
function kinText(t, ...p) { const l = typeof window === 'object' && window && window.KinLanguage; return l && l.text ? l.text(t, ...p) : t.replace(/\{[ten]?(\d+)\}/g, (m, i) => String(p[i])); }
function kinHtml(t, ...p) { const l = typeof window === 'object' && window && window.KinLanguage; return l && l.html ? l.html(t, ...p) : t.replace(/\{[ten]?(\d+)\}/g, (m, i) => String(p[i])); }
function kinError(t, ...p) { return Object.assign(new Error(kinText(t, ...p)), { kinWords: true }); }
window.KinViewerExport = (() => {
  // The errors this file raises are its own messages (marked kinWords), whatever language their words are in.
  const ownError = message => Object.assign(new Error(message), { kinWords: true });
  // Text inside controls, menus and hidden parts of a cell is not image text.
  const NOT_IMAGE_TEXT = 'button,[role="button"],[role="menu"],[role="menuitem"],[role="dialog"],input,select,textarea,dialog,svg,canvas,[aria-hidden="true"],[hidden]';
  const visible = element => {
    for (let node = element; node && node.nodeType === 1; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
    }
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };
  class Stopped extends Error {}
  // The active cell, or every cell of this window in grid order. A cell is the native pane around the
  // Cornerstone element, so the image text drawn beside the element is part of it.
  function pin(services, scope, live = () => true) {
    const grid = services?.viewportGridService, viewports = services?.cornerstoneViewportService;
    if (!grid || !viewports) return null;
    const ids = scope === 'screen' ? [...(grid.getState()?.viewports?.keys?.() || [])] : [grid.getActiveViewportId?.()];
    const cells = ids.map(id => ({ id, viewport: viewports.getCornerstoneViewport(id) })).filter(cell => cell.viewport?.element?.isConnected)
      .map(cell => ({ ...cell, pane: cell.viewport.element.closest('[data-cy="viewport-pane"]') || cell.viewport.element,
        imageIds: JSON.stringify(cell.viewport.getImageIds?.() || []), index: cell.viewport.getCurrentImageIdIndex?.() }))
      .filter(cell => visible(cell.pane));
    if (!cells.length) return null;
    // A change seen at any moment stays seen: a cell that shows another series and then the first one again
    // (A -> B -> A) is not the cell this action started on. New stacks and grid changes are watched until release().
    let moved = false;
    const restacked = () => { moved = true; };
    // A new stack in the same viewport: the older event name and the one the viewer's Cornerstone sends.
    const events = window.cornerstone?.Enums?.Events || {};
    const stacks = [...new Set([events.STACK_NEW_STACK || 'CORNERSTONE_STACK_NEW_STACK', events.VIEWPORT_NEW_IMAGE_SET || 'CORNERSTONE_VIEWPORT_NEW_IMAGE_SET'])];
    const sets = id => JSON.stringify(grid.getState?.()?.viewports?.get?.(id)?.displaySetInstanceUIDs ?? null);
    cells.forEach(cell => { cell.sets = sets(cell.id); stacks.forEach(stack => cell.viewport.element.addEventListener(stack, restacked)); });
    const watched = Object.values(grid.EVENTS || {}).map(event => grid.subscribe?.(event, () => {
      if (cells.some(cell => sets(cell.id) !== cell.sets)) moved = true;
    }));
    // Still the same viewer, cells, series and (unless this action moves it) shown image.
    const same = (moving = false) => !moved && live() && !document.body.classList.contains('kin-patient-switching') && cells.every(cell =>
      viewports.getCornerstoneViewport(cell.id) === cell.viewport && cell.viewport.element?.isConnected &&
      JSON.stringify(cell.viewport.getImageIds?.() || []) === cell.imageIds && (moving || cell.viewport.getCurrentImageIdIndex?.() === cell.index));
    const release = () => {
      cells.forEach(cell => stacks.forEach(stack => cell.viewport.element.removeEventListener(stack, restacked)));
      watched.forEach(subscription => subscription?.unsubscribe?.());
    };
    return { cells, same, release };
  }
  function svgImage(svg, rect) {
    const copy = svg.cloneNode(true);
    // The Measure menu's editing aids are not part of a mark: the handles of a mark that may be moved and the points or
    // lines of a mark still being made.
    copy.querySelectorAll('[data-kin-handle],[data-kin-pending]').forEach(node => node.remove());
    copy.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    copy.setAttribute('width', rect.width); copy.setAttribute('height', rect.height);
    const image = new Image();
    image.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(new XMLSerializer().serializeToString(copy));
    return image.decode().then(() => image);
  }
  // Image text where the page puts each line, so wrapped lines, spacing and alignment stay as shown. A box
  // between the pane and the text that clips on screen clips here, and its background colour is drawn behind
  // the text (a box that holds the image canvas is the image's, not the text's).
  function drawText(context, pane, at) {
    const walker = document.createTreeWalker(pane, NodeFilter.SHOW_TEXT), painted = new Set(), range = document.createRange();
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const parent = node.parentElement;
      if (!node.data.trim() || !parent || parent.closest(NOT_IMAGE_TEXT) || !visible(parent)) continue;
      const boxes = [];
      for (let box = parent; box && box !== pane; box = box.parentElement) boxes.push(box);
      context.save();
      for (const box of boxes.slice().reverse()) {
        const style = getComputedStyle(box), r = box.getBoundingClientRect();
        if (style.overflowX !== 'visible' || style.overflowY !== 'visible') {
          context.beginPath(); context.rect(r.left - at.left, r.top - at.top, r.width, r.height); context.clip();
        }
        const colour = style.backgroundColor;
        if (!painted.has(box) && !box.querySelector('canvas,svg') && colour && !/^(transparent|rgba\(.*,\s*0\))$/.test(colour)) {
          painted.add(box); context.fillStyle = colour; context.fillRect(r.left - at.left, r.top - at.top, r.width, r.height);
        }
      }
      const style = getComputedStyle(parent);
      context.font = [style.fontStyle, style.fontWeight, style.fontSize, style.fontFamily].join(' ');
      context.fillStyle = style.color;
      const rtl = style.direction === 'rtl'; context.direction = rtl ? 'rtl' : 'ltr'; context.textAlign = rtl ? 'right' : 'left';
      if ('letterSpacing' in context) context.letterSpacing = style.letterSpacing === 'normal' ? '0px' : style.letterSpacing;
      if ('wordSpacing' in context) context.wordSpacing = style.wordSpacing === 'normal' ? '0px' : style.wordSpacing;
      // Lines as the page breaks them, found from whole grapheme clusters; each line is then drawn in one call,
      // so combining marks (a decomposed Korean name) and joined scripts are shaped together as on screen.
      const parts = typeof Intl.Segmenter === 'function'
        ? [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(node.data)]
        : [...node.data].reduce((list, segment) => { list.push({ segment, index: list.length ? list.at(-1).index + list.at(-1).segment.length : 0 }); return list; }, []);
      const lines = [];
      for (const { segment, index } of parts) {
        range.setStart(node, index); range.setEnd(node, index + segment.length);
        const r = range.getBoundingClientRect();
        if (!r.width || !r.height) continue;
        const middle = r.top + r.height / 2;
        let line = lines.find(item => Math.abs(item.middle - middle) < r.height / 2);
        if (!line) lines.push(line = { start: index, end: index, left: r.left, right: r.right, top: r.top, bottom: r.bottom, middle });
        line.start = Math.min(line.start, index); line.end = Math.max(line.end, index + segment.length);
        line.left = Math.min(line.left, r.left); line.right = Math.max(line.right, r.right);
        line.top = Math.min(line.top, r.top); line.bottom = Math.max(line.bottom, r.bottom);
      }
      const keep = style.whiteSpace.startsWith('pre') || style.whiteSpace === 'break-spaces';
      for (const line of lines) {
        let text = node.data.slice(line.start, line.end);
        if (!keep) text = text.replace(/\s+/g, ' ');
        text = style.textTransform === 'uppercase' ? text.toUpperCase() : style.textTransform === 'lowercase' ? text.toLowerCase() : text;
        if (!text.trim()) continue;
        // The page's baseline: a text box is the font's ascent and descent, centred in the line's box.
        const metrics = context.measureText(text), ascent = metrics.fontBoundingBoxAscent, descent = metrics.fontBoundingBoxDescent;
        const exact = Number.isFinite(ascent) && Number.isFinite(descent);
        context.textBaseline = exact ? 'alphabetic' : 'middle';
        const y = exact ? line.top + (line.bottom - line.top - ascent - descent) / 2 + ascent : line.middle;
        context.fillText(text, (rtl ? line.right : line.left) - at.left, y - at.top);
      }
      context.restore();
    }
  }
  // The image of a cell is its viewport's own canvas, at the moment its pixels are copied: in the cell, shown, with a
  // size on the page and in pixels, and drawn by a renderer that has not lost its drawing context. Another canvas of the
  // cell being visible is not the image. An image that is drawn black is an image.
  function imageCanvas(cell, rect) {
    const viewport = cell.viewport, canvas = viewport.canvas;
    if (!(canvas instanceof HTMLCanvasElement) || !viewport.element?.contains(canvas) || !cell.pane.contains(canvas) ||
        !canvas.width || !canvas.height || !visible(canvas)) return null;
    const r = canvas.getBoundingClientRect();
    if (Math.min(r.right, rect.right) <= Math.max(r.left, rect.left) || Math.min(r.bottom, rect.bottom) <= Math.max(r.top, rect.top)) return null;
    let engine; try { engine = viewport.getRenderingEngine?.(); } catch (_) { return null; }
    if (engine?.offscreenMultiRenderWindow?.getOpenGLRenderWindow?.()?.getContext?.()?.isContextLost?.() ||
        (engine && window.kinViewerContextLoss?.usable?.(engine) === false)) return null;
    return canvas;
  }
  const HIDDEN = kinText("영상 칸이 보이지 않아 내보내지 못했습니다. 다시 시도하세요.");
  // One canvas for the given cells, at the image canvases' own pixel density. A cell that has no image to show
  // (folded away, hidden, its image canvas gone or hidden) is not drawn as a black picture: nothing is made.
  // `verify` runs in the same moment the pixels are copied (nothing is awaited between them) and stops the copy by throwing.
  // `only` names the canvases of a cell that are drawn (a series export: the image and the marks drawn over it, not
  // another picture that stands in the cell); without it, every canvas shown.
  async function render(cells, verify, only) {
    const rects = cells.map(cell => cell.pane.getBoundingClientRect());
    if (cells.some((cell, index) => !rects[index].width || !rects[index].height || !visible(cell.pane) || !imageCanvas(cell, rects[index])))
      throw ownError(HIDDEN);
    verify?.();
    const region = { left: Math.min(...rects.map(r => r.left)), top: Math.min(...rects.map(r => r.top)) };
    region.width = Math.max(...rects.map(r => r.right)) - region.left; region.height = Math.max(...rects.map(r => r.bottom)) - region.top;
    const canvases = cell => [...cell.pane.querySelectorAll('canvas')].filter(canvas => visible(canvas) && (!only || only(cell, canvas)));
    const densities = cells.flatMap(cell => canvases(cell)
      .map(canvas => canvas.width / canvas.getBoundingClientRect().width)).filter(value => Number.isFinite(value) && value > 0);
    const scale = densities.length ? Math.max(...densities) : (window.devicePixelRatio || 1);
    const output = document.createElement('canvas');
    output.width = Math.max(1, Math.round(region.width * scale)); output.height = Math.max(1, Math.round(region.height * scale));
    const context = output.getContext('2d');
    context.fillStyle = '#000'; context.fillRect(0, 0, output.width, output.height);
    context.scale(scale, scale);
    // Everything is read from the page before the first await, so one call draws one moment of the cells.
    const layers = cells.map((cell, index) => ({ pane: rects[index], cell,
      canvases: canvases(cell).map(canvas => [canvas, canvas.getBoundingClientRect()]),
      // The annotation layer and the Measure menu's own layer (Spine Label, Text, Memo, circles; viewer-features-measure.js).
      svgs: [...cell.pane.querySelectorAll('svg.svg-layer, svg[data-kin-measure-layer]')].filter(visible).map(svg => [svgImage(svg, svg.getBoundingClientRect()), svg.getBoundingClientRect()]) }));
    const frozen = layers.map(layer => layer.canvases.map(([canvas, r]) => {
      const copy = document.createElement('canvas'); copy.width = canvas.width; copy.height = canvas.height;
      copy.getContext('2d').drawImage(canvas, 0, 0); return [copy, r];
    }));
    const text = document.createElement('canvas'); text.width = output.width; text.height = output.height;
    const textContext = text.getContext('2d'); textContext.scale(scale, scale);
    for (const layer of layers) {
      textContext.save(); textContext.beginPath();
      textContext.rect(layer.pane.left - region.left, layer.pane.top - region.top, layer.pane.width, layer.pane.height); textContext.clip();
      drawText(textContext, layer.cell.pane, region); textContext.restore();
    }
    for (const [index, layer] of layers.entries()) {
      const pane = layer.pane;
      context.save(); context.beginPath(); context.rect(pane.left - region.left, pane.top - region.top, pane.width, pane.height); context.clip();
      for (const [canvas, r] of frozen[index]) context.drawImage(canvas, r.left - region.left, r.top - region.top, r.width, r.height);
      for (const [image, r] of layer.svgs) context.drawImage(await image, r.left - region.left, r.top - region.top, r.width, r.height);
      context.restore();
    }
    context.setTransform(1, 0, 0, 1, 0, 0); context.drawImage(text, 0, 0);
    return output;
  }
  const blob = (canvas, type, quality) => new Promise((resolve, reject) =>
    canvas.toBlob(value => value ? resolve(value) : reject(kinError("영상을 그림 파일로 만들지 못했습니다.")), type, quality));
  function tell(services, message, type = 'info') {
    services?.uiNotificationService?.show?.({ title: 'Image Export', message, type });
  }
  const failure = error => error instanceof Stopped ? error.message
    : error?.constructor === Error && (error.kinWords || /[가-힣]/.test(error.message)) ? error.message : kinText("영상을 내보내지 못했습니다. 다시 시도하세요.");
  const changed = () => new Stopped(kinText("영상이나 화면이 바뀌어 내보내기를 멈췄습니다. 다시 시도하세요."));

  // Copy: the clipboard takes images as PNG only, so there is no format choice. The write starts in the
  // reader's click or key press and receives the image once it is drawn and encoded; a cell or viewer that
  // changed by then fails the write, so the clipboard keeps what it had.
  function copy(services, scope, live) {
    if (!navigator.clipboard?.write || typeof ClipboardItem !== 'function') {
      tell(services, kinText("이 브라우저에서는 영상을 클립보드에 복사할 수 없습니다."), 'error'); return Promise.resolve(false);
    }
    const target = pin(services, scope, live);
    if (!target) { tell(services, kinText("복사할 영상 칸이 없습니다."), 'warning'); return Promise.resolve(false); }
    const image = render(target.cells).then(canvas => { if (!target.same()) throw changed(); return blob(canvas, 'image/png'); })
      .then(file => { if (!target.same()) throw changed(); return file; });
    return navigator.clipboard.write([new ClipboardItem({ 'image/png': image })])
      .then(() => { tell(services, scope === 'screen' ? kinText("화면의 영상 칸을 클립보드에 복사했습니다.") : kinText("영상 칸을 클립보드에 복사했습니다."), 'success'); return true; })
      .catch(error => image.catch(reason => reason).then(reason => { tell(services, failure(reason instanceof Error ? reason : error), 'error'); return false; }))
      .finally(target.release);
  }

  // File names carry no patient data: what, the series number when the image states it, and the local time.
  // A download is handed to the browser, which may still refuse or cancel it; so a notice says the file was made and its
  // download started, never that it is on the disk.
  const stamp = () => { const d = new Date(), two = n => String(n).padStart(2, '0');
    return d.getFullYear() + two(d.getMonth() + 1) + two(d.getDate()) + '-' + two(d.getHours()) + two(d.getMinutes()) + two(d.getSeconds()); };
  const seriesName = viewport => {
    const number = window.cornerstone?.metaData?.get?.('generalSeriesModule', viewport.getImageIds?.()?.[0])?.seriesNumber;
    return 'series-' + (Number.isSafeInteger(Number(number)) && String(number).trim() ? Number(number) : 'images');
  };
  function download(file, name) {
    const link = document.createElement('a'); link.href = URL.createObjectURL(file); link.download = name;
    link.hidden = true; document.body.append(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(link.href), 60000);
  }

  // A stored (uncompressed) ZIP: JPEG frames are already compressed and one file is one download.
  const CRC = (() => { const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; table[n] = c >>> 0; }
    return table; })();
  const crc32 = bytes => { let c = 0xFFFFFFFF; for (let i = 0; i < bytes.length; i++) c = CRC[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
  function zip(files) {
    if (files.length > 0xFFFF) throw kinError("한 번에 저장할 수 있는 영상 수를 넘었습니다.");
    const now = new Date(), parts = [], central = []; let offset = 0;
    const time = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
    const date = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
    for (const { name, data } of files) {
      const title = new TextEncoder().encode(name), crc = crc32(data);
      if (offset + 30 + title.length + data.length > 0xFFFFFFFF) throw kinError("저장할 파일이 너무 큽니다.");
      const local = new DataView(new ArrayBuffer(30)), entry = new DataView(new ArrayBuffer(46));
      for (const [view, at, fields] of [[local, 4, [20, 0x0800, 0, time, date]], [entry, 6, [20, 0x0800, 0, time, date]]])
        fields.forEach((value, i) => view.setUint16(at + i * 2, value, true));
      local.setUint32(0, 0x04034b50, true); local.setUint32(14, crc, true); local.setUint32(18, data.length, true);
      local.setUint32(22, data.length, true); local.setUint16(26, title.length, true);
      entry.setUint32(0, 0x02014b50, true); entry.setUint16(4, 20, true); entry.setUint32(16, crc, true); entry.setUint32(20, data.length, true);
      entry.setUint32(24, data.length, true); entry.setUint16(28, title.length, true); entry.setUint32(42, offset, true);
      parts.push(local, title, data); central.push(entry, title);
      offset += 30 + title.length + data.length;
    }
    const size = central.reduce((sum, part) => sum + part.byteLength, 0), end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true);
    end.setUint32(12, size, true); end.setUint32(16, offset, true);
    return new Blob([...parts, ...central, end], { type: 'application/zip' });
  }

  const options = { loadTimeout: 30000 };
  const frames = count => new Promise(resolve => { const step = left => left ? requestAnimationFrame(() => step(left - 1)) : resolve(); step(count); });
  const NOT_LOADED = kinText("영상을 불러오지 못해 내보내기를 멈췄습니다.");
  const NOT_BACK = kinText("원래 보던 영상으로 돌아가지 못해 저장하지 않았습니다.");
  const UNSURE = kinText("영상 칸의 시리즈를 확인하지 못해 내보내지 못했습니다. 영상이 모두 표시된 뒤 다시 시도하세요.");
  const STOPPED = kinText("내보내기를 멈췄습니다.");
  const TILED = kinText("Tile 보기에서는 시리즈를 내보낼 수 없습니다. Stack 보기에서 내보내세요.");
  const UNFOLDED = kinText("Unfolded 보기에서는 시리즈를 내보낼 수 없습니다. Folded (Cine) 보기에서 내보내세요.");
  const SLABBED = kinText("Slab을 보는 동안에는 시리즈를 내보낼 수 없습니다. Slab Thickness를 1 slice로 바꾼 뒤 내보내세요.");
  // The image the viewport holds for its canvas. The image number moves before its image arrives, and a failed load can
  // leave the previous image on the canvas at the new number, so the number alone never says what a cell shows.
  const heldImage = viewport => typeof viewport.getCornerstoneImage === 'function' ? viewport.getCornerstoneImage()?.imageId : undefined;
  // Whether an image has arrived in full. A loader that shows an image in steps hands the cell a coarser version of it
  // first, under the same image id; an image that states no quality is whole (the viewer's cache reads it so).
  const whole = image => !!image && (!image.imageQualityStatus || image.imageQualityStatus >= (window.cornerstone?.Enums?.ImageQualityStatus?.FULL_RESOLUTION ?? 8));
  // The DICOM frame an image id names (WADO-RS `/frames/N`, WADO-URI `frame=N`); a single-frame image is frame 1.
  const frameOf = imageId => { const match = /\/frames\/(\d+)(?:[/?#]|$)/.exec(imageId) || /[?&]frame=(\d+)(?:&|#|$)/.exec(imageId); return match ? Number(match[1]) : 1; };
  // Whether the cell's list is a series (display set) the grid names for the cell, whole and once: every image of the
  // list is one the series holds (its study and series, its SOP instance and frame), none stands twice, and every image
  // the series holds is in the list. A part split from a multi-frame file holds only the frames it was given (the
  // viewer's own rule, series-split.js); any other instance holds all its frames. A series that cannot be read is not it.
  function covers(services, id, ids) {
    const listed = new Set();
    for (const imageId of ids) {
      let meta = null; try { meta = window.cornerstone?.metaData?.get?.('instance', imageId); } catch (_) {}
      if (typeof meta?.SOPInstanceUID !== 'string' || !meta.SOPInstanceUID) return false;
      const key = JSON.stringify([meta.StudyInstanceUID, meta.SeriesInstanceUID, meta.SOPInstanceUID, frameOf(imageId)]);
      if (listed.has(key)) return false;
      listed.add(key);
    }
    const named = services.viewportGridService.getState?.()?.viewports?.get?.(id)?.displaySetInstanceUIDs || [];
    return listed.size > 0 && named.some(uid => {
      const set = services.displaySetService?.getDisplaySetByUID?.(uid);
      const images = Array.isArray(set?.images) ? set.images : Array.isArray(set?.instances) ? set.instances : null;
      if (!images) return false;
      const held = new Set();
      for (const image of images) {
        if (typeof image?.SOPInstanceUID !== 'string' || !image.SOPInstanceUID) return false;
        const part = typeof window.kinSeriesSplitFrame === 'function' ? window.kinSeriesSplitFrame(image) : null;
        const count = Number.isSafeInteger(Number(image.NumberOfFrames)) && Number(image.NumberOfFrames) > 1 ? Number(image.NumberOfFrames) : 1;
        for (let frame = part ?? 1; frame <= (part ?? count); frame++) held.add(JSON.stringify([set.StudyInstanceUID, set.SeriesInstanceUID, image.SOPInstanceUID, frame]));
      }
      return held.size === listed.size && [...listed].every(key => held.has(key));
    });
  }
  // Why a cell does not show its stack one image at a time, if so: laid out as tiles (Navigate: Tile, Unfolded) or drawn
  // as the mean of several slices (Tomo: Slab Thickness). Each of those modules answers for its own cells.
  const otherView = id => {
    let laid = null, slab = false;
    try { laid = window.kinNavigate?.laid?.(id) || null; } catch (_) {}
    try { slab = window.kinMgSlab?.on?.(id) === true; } catch (_) {}
    return laid === 'unfolded' ? UNFOLDED : laid ? TILED : slab ? SLABBED : '';
  };
  // What a series export draws of its cell: the cell's own image canvas and the marks drawn over it on a canvas of their
  // own (the breast outline). Another picture standing in the cell (tiles, a magnifier) is not the image.
  const seriesLayer = (cell, canvas) => canvas === cell.viewport.canvas || canvas.classList.contains('kin-mg-outline');
  // A series export's claim on its cell. Two questions, each answered here and nowhere else, and never by the image
  // number alone:
  //   state()   'own' while this export may still move the cell and publish a file. 'taken' for good from the moment
  //             anything but the export itself asks the cell for an image (the viewport announces every request before
  //             it loads; the one request the export makes is told apart while it makes it), the cell is scrolled or
  //             given a stack or other series, another cell is selected, the layout or grid changes, or Cine is started
  //             in the cell (however briefly): even when everything looks the same again later. 'ended' for good when
  //             the viewer ends, switches patient or the window goes away.
  //   shows(k)  whether the reader sees image k of the list copied at the start in the cell: the viewport finished a draw
  //             of that image, arrived in full, after the last request for an image and still holds the very image it
  //             drew, its own canvas is in the cell, shown and sized, and the cell shows its stack one image at a time.
  // The image the export starts on, every image as its pixels are copied and the reader's image when the export goes
  // back to it all pass shows().
  // The cell is asked for an image only once that image's load has ended (the loader alone loads it; the cell is asked
  // for nothing meanwhile), and the request is run where it is made, on the very load that was waited for: the image is
  // on the cell within the same task. So no request of the export's is on its way when the reader takes the cell, and
  // none arrives on what the reader chose. The reader's own image is held from the start and handed back, not loaded.
  function claim(services, live) {
    const target = pin(services, 'image', live);
    if (!target) return null;
    const grid = services.viewportGridService, cine = services.cineService, cell = target.cells[0], viewport = cell.viewport, element = viewport.element;
    // The stack as it is now: the viewport's own list (a different list later is one more sign of a new stack) and a
    // copy of its order, which is the order of the export to its end.
    const list = viewport.getImageIds?.() || [], ids = [...list];
    // Where the cell's scrolling stands. A scroll or a new stack moves it; so does the export, which scrolls the cell.
    const aim = () => viewport.getTargetImageIdIndex?.();
    const core = window.cornerstone, names = core?.Enums?.Events || {}, cache = core?.cache;
    const SCROLL = names.STACK_VIEWPORT_SCROLL || 'CORNERSTONE_STACK_VIEWPORT_SCROLL';
    const shape = () => { const now = grid.getState?.() || {};
      return JSON.stringify([grid.getActiveViewportId?.(), now.layout?.numRows, now.layout?.numCols, now.layout?.layoutType, now.viewports?.size]); };
    const pinned = shape(), offs = [];
    // settled: the reader's last move has ended; its image is the one to go back to (start; kept: that image itself).
    // unsettled: told of each move of the reader's until then. waited: the one image whose load was last waited for (the
    // export holds on to no other image, so the cache can let go of the ones behind it).
    let lost = '', settled = false, unsettled = null, start, aimed, kept = null, waited = null, own = null, telling = false, noticed = false, painted = null, wake = null;
    const playing = () => !!cine?.getState?.()?.cines?.[cell.id]?.isPlaying;
    const lose = how => { if (!lost) lost = how; wake?.(); };
    const state = () => {
      if (!lost) {
        if ((live && !live()) || document.body.classList.contains('kin-patient-switching')) lost = 'ended';
        else if (!target.same(true) || viewport.getImageIds?.() !== list || (settled && aim() !== aimed) || shape() !== pinned || playing()) lost = 'taken';
      }
      return lost || 'own';
    };
    const drawn = k => typeof ids[k] === 'string' && !!ids[k] && viewport.getCurrentImageIdIndex() === k && !!painted && painted.imageId === ids[k] && viewport.getCornerstoneImage() === painted;
    // Why the reader does not see the cell's image, if so.
    const hidden = () => otherView(cell.id) || (visible(cell.pane) && imageCanvas(cell, cell.pane.getBoundingClientRect()) ? '' : HIDDEN);
    const shows = k => drawn(k) && !hidden();
    const on = (name, heard) => { element.addEventListener(name, heard); offs.push(() => element.removeEventListener(name, heard)); };
    // Every request for an image, before it loads. What was drawn before it no longer says what the cell shows. Until the
    // reader's last move has ended, a request is that move.
    on(names.PRE_STACK_NEW_IMAGE || 'CORNERSTONE_PRE_STACK_NEW_IMAGE', event => {
      painted = null;
      if (own && !own.heard && event.detail?.imageIdIndex === own.index && event.detail?.imageId === ids[own.index]) { own.heard = true; return; }
      if (settled) lose('taken'); else unsettled?.();
    });
    // A scroll names its image before the request, which may come a moment later (the scroll the export itself makes is
    // not the reader's); a new stack is announced once it loaded.
    on(SCROLL, () => { if (telling) { noticed = true; return; } if (settled) lose('taken'); else unsettled?.(); });
    for (const name of new Set([names.STACK_NEW_STACK || 'CORNERSTONE_STACK_NEW_STACK', names.VIEWPORT_NEW_IMAGE_SET || 'CORNERSTONE_VIEWPORT_NEW_IMAGE_SET'])) on(name, () => lose('taken'));
    // A finished draw: the image the viewport held as it drew, if that image had arrived in full.
    on(names.IMAGE_RENDERED || 'CORNERSTONE_IMAGE_RENDERED', () => {
      const status = viewport.viewportStatus, done = core?.Enums?.ViewportStatus?.RENDERED || 'rendered', image = viewport.getCornerstoneImage?.();
      painted = (status === undefined || status === done) && !viewport.stackInvalidated && whole(image) ? image : null;
      wake?.();
    });
    // The grid tells of a change after it happened, when its state may already be back: another cell selected (the
    // notice names it), a new layout or any other change of the grid ends the claim as it is told.
    const told = grid.EVENTS || {};
    for (const [name, heard] of [[told.ACTIVE_VIEWPORT_ID_CHANGED, notice => { if (notice?.viewportId !== cell.id) lose('taken'); }],
      [told.LAYOUT_CHANGED, () => lose('taken')], [told.GRID_STATE_CHANGED, () => lose('taken')]]) {
      const subscription = name && grid.subscribe?.(name, heard);
      if (subscription) offs.push(() => subscription.unsubscribe?.());
    }
    // Cine started in this cell is the reader's, also when it is stopped again before it moved an image: a state read
    // later no longer tells. Every start reaches the Cine service as playClip for the cell (the viewer's play button,
    // also for a range or back and forth) or as setCine; the service tells of a play once it began.
    for (const name of ['setCine', 'playClip']) {
      const inner = cine?.[name];
      if (typeof inner !== 'function') continue;
      const had = Object.prototype.hasOwnProperty.call(cine, name);
      const outer = function (...args) {
        if (name === 'setCine' ? args[0]?.id === cell.id && args[0]?.isPlaying : args[0] === element || args[1]?.viewportId === cell.id) lose('taken');
        return inner.apply(this, args);
      };
      cine[name] = outer;
      offs.push(() => { if (cine[name] !== outer) return; if (had) cine[name] = inner; else delete cine[name]; });
    }
    const played = cine?.EVENTS?.CINE_STATE_CHANGED && cine.subscribe?.(cine.EVENTS.CINE_STATE_CHANGED, () => { if (playing()) lose('taken'); });
    if (played) offs.push(() => played.unsubscribe?.());
    const gone = () => lose('ended');
    window.addEventListener('pagehide', gone); offs.push(() => window.removeEventListener('pagehide', gone));
    // A wait that ends at once when the export is stopped or the claim is lost, when `look` ends it, and at the latest
    // at the load timeout: it never waits for a call to return, so a load that never answers holds nothing up.
    // `look` is given the wait itself: finish(error), later(run, ms) for a timer that dies with the wait, going(), again().
    function wait(stopped, look) {
      return new Promise((resolve, reject) => {
        let over = false; const timers = new Set();
        const finish = error => {
          if (over) return;
          over = true; timers.forEach(clearTimeout); if (wake === seeing) wake = null;
          if (error) reject(error); else resolve();
        };
        const later = (run, ms) => { const timer = setTimeout(() => { timers.delete(timer); if (!over) run(); }, ms); timers.add(timer); };
        const seeing = () => { if (over) return; if (stopped?.()) finish(new Stopped(STOPPED)); else if (state() !== 'own') finish(changed()); else look(it); };
        const it = { finish, later, going: () => !over, again: seeing };
        later(() => finish(ownError(NOT_LOADED)), options.loadTimeout);
        wake = seeing; seeing();
      });
    }
    // Before anything is asked of the cell, the reader's last move ends, and the image it ends on is the reader's image,
    // the one to go back to. A wheel step names its image at once but may ask for it up to 40 ms later, so a scroll
    // target that is not the image number may be a step still to come (or be left from a move made without scrolling):
    // then a timer longer than that delay must pass with no move announced. The image asked for last may still load,
    // or be on the cell in a coarser version only: the move has ended when the cell holds that image in full.
    function settle(stopped) {
      let moves = 0, calm = aim() === undefined || aim() === viewport.getCurrentImageIdIndex(), timing = false;
      unsettled = () => { moves++; calm = false; };
      return wait(stopped, it => {
        const at = viewport.getCurrentImageIdIndex(), image = viewport.getCornerstoneImage?.();
        if (calm && image?.imageId === ids[at] && whole(image)) {
          start = at; aimed = aim(); kept = image; settled = true; unsettled = null; it.finish();
        } else if (!calm && !timing) {
          timing = true; const seen = moves;
          it.later(() => { timing = false; if (moves === seen) calm = true; it.again(); }, 100);
        }
      }).then(() => start, error => { unsettled = null; throw error; });
    }
    // The loader's options for an image, as the cell itself asks for it.
    const asking = imageId => viewport.useCPURendering ? { useRGBA: true, requestType: core?.Enums?.RequestType?.Interaction || 'interaction' }
      : viewport.getLoaderImageOptions?.(imageId);
    // Image k is loaded to its end, and the load the cache holds for it is the very one that was waited for.
    const ready = k => !!waited?.load && waited.index === k && cache?.getImageLoadObject?.(ids[k]) === waited.load && cache.isLoaded?.(ids[k]) !== false;
    // Loads image k with the loader alone and gives the load the cache holds for it, once that load has ended.
    function fetch(k) {
      const imageId = ids[k];
      try {
        const loading = core.imageLoader.loadAndCacheImage(imageId, asking(imageId)), load = cache.getImageLoadObject(imageId);
        return Promise.resolve(loading).then(() => load);
      } catch (error) { return Promise.reject(error); }
    }
    // The one way this export puts the cell on image k. The cell is scrolled there as the reader's wheel scrolls it, so
    // where the cell's scrolling stands goes with the image shown: the reader's next step, whenever it comes, counts
    // from what is on the screen. The viewport announces the request inside the call (only that announcement is the
    // export's own) and then the scroll, which the viewer's slice number and scroll bar follow. It hands the request to
    // the loader's queue, where it could wait behind other loads and arrive after the reader took the cell. So it is not
    // queued: where it is handed over, `take` says whether it runs there (its image is then on the cell within this
    // task) or is dropped before a pixel is applied. Tells whether the cell is on image k now, and whether the request
    // ran (null when the viewport did not hand one over).
    function go(k, take) {
      const imageId = ids[k], from = viewport.getCurrentImageIdIndex(), to = aim(), queue = core?.imageLoadPoolManager, add = queue?.addRequest;
      const had = !!queue && Object.prototype.hasOwnProperty.call(queue, 'addRequest'), scrolls = typeof viewport.scroll === 'function' && Number.isInteger(to);
      let ran = null;
      if (typeof add === 'function') queue.addRequest = function (run, type, details, ...rest) {
        if (details?.imageId !== imageId || typeof run !== 'function') return add.call(this, run, type, details, ...rest);
        if (!(ran = !!take())) return;
        try { Promise.resolve(run()).catch(() => {}); } catch (_) {}
      };
      painted = null; own = { index: k, heard: false }; telling = true; noticed = false;
      try {
        if (scrolls) { aimed = k; viewport.scroll(k - to, false); }
        else Promise.resolve(viewport.setImageIdIndex(k)).catch(() => {});
        const on = viewport.getCurrentImageIdIndex() === k;
        // A viewport that sent no scroll notice of its own (its scrolling stood on this image already): sent here as it
        // sends it, once the request is made and before its image is applied.
        if (on && !noticed) element.dispatchEvent(new CustomEvent(SCROLL, { cancelable: true, detail: { newImageIdIndex: k, imageId, direction: k - from } }));
        return { on, ran };
      } finally {
        own = null; telling = false; if (scrolls) aimed = aim();
        if (typeof add === 'function') { if (had) queue.addRequest = add; else delete queue.addRequest; }
      }
    }
    // The reader's image is never loaded again: the image the cell held in full at the start is handed back to the cell,
    // as the loader hands it one. So the way back to it (and its own turn in the file) depends on no load and on no room in the
    // cache. False when the cell did not take it.
    function home() {
      const imageId = ids[start];
      if (!kept || kept.imageId !== imageId) return false;
      if (viewport.getCurrentImageIdIndex() !== start && !go(start, () => false).on) return false;
      painted = null;
      if (viewport.useCPURendering) {
        viewport.renderImageObject(kept);
        element.dispatchEvent(new CustomEvent(names.STACK_NEW_IMAGE || 'CORNERSTONE_STACK_NEW_IMAGE', { cancelable: true,
          detail: { image: kept, imageId, imageIdIndex: start, viewportId: viewport.id, renderingEngineId: viewport.renderingEngineId } }));
        viewport.render?.();
      } else viewport.successCallback(imageId, kept);
      return viewport.getCornerstoneImage() === kept;
    }
    // Waits until the cell shows image k. An image the cell already holds is drawn again and judged like any other; the
    // reader's image is handed back; any other image is loaded first and then asked for (the export's own request).
    function show(k, stopped) {
      let begun = false;
      return wait(stopped, it => {
        if (drawn(k)) { const why = hidden(); it.finish(why ? ownError(why) : undefined); return; }
        if (begun) return;
        begun = true;
        const failed = error => it.finish(error?.constructor === Error && (error.kinWords || /[가-힣]/.test(error.message)) ? error : ownError(NOT_LOADED));
        try {
          if (viewport.getCurrentImageIdIndex() === k && heldImage(viewport) === ids[k] && whole(viewport.getCornerstoneImage())) { viewport.render?.(); return; }
          if (k === start) { if (!home()) failed(); return; }
          const step = () => {
            if (!it.going()) return;
            if (stopped?.() || state() !== 'own') { it.again(); return; }
            try {
              if (ready(k)) {
                const went = go(k, () => state() === 'own' && viewport.getCurrentImageIdIndex() === k && ready(k));
                if (state() !== 'own') it.again(); else if (!went.on || went.ran === false) failed();
                return;
              }
              // A load that ended without its image in the cache (no room for it) is asked for again a moment later.
              fetch(k).then(load => { if (!it.going()) return; waited = { index: k, load }; if (ready(k)) step(); else it.later(step, 250); }, failed);
            } catch (error) { failed(error); }
          };
          step();
        } catch (error) { failed(error); }
      });
    }
    const release = () => { offs.splice(0).forEach(off => off()); kept = waited = null; target.release(); };
    return { cells: target.cells, cell, ids, state, hidden, shows, settle, show, lose, wake: () => wake?.(), release };
  }
  // One series export at a time. It walks the stack copied at the start from its first image to its last on the cell
  // itself (so each image is drawn as the reader would see it), and Esc stops it. A stop or a failure goes back to the
  // image the reader was on; a cell that is no longer this export's (see claim) is left exactly as it is. Nothing is
  // written unless every image was shown, the cell is back on the reader's image and shows it, and the claim held all
  // the way; `after` runs inside the same export, under the same checks.
  let job = null;
  async function walk(services, live, say, verb, each, after) {
    if (job) { tell(services, kinText("다른 내보내기가 진행 중입니다. 끝난 뒤 다시 시도하세요."), 'warning'); return false; }
    const hold = claim(services, live);
    if (!hold) { tell(services, kinText("저장할 영상 칸이 없습니다."), 'warning'); return false; }
    const { cell, ids } = hold, viewport = cell.viewport;
    const refuse = message => { hold.release(); tell(services, message, 'warning'); return false; };
    if (viewport.type !== 'stack' || typeof viewport.setImageIdIndex !== 'function' || !ids.length) return refuse(kinText("시리즈 저장은 일반(2D) 영상 칸에서 할 수 있습니다."));
    if (services.cineService?.getState?.()?.cines?.[cell.id]?.isPlaying) return refuse(kinText("Cine 재생을 멈춘 뒤 다시 시도하세요."));
    const view = otherView(cell.id);
    if (view) return refuse(view);
    // away: the cell shows an image this export put there on its way, until it is back on the reader's image and shows it.
    const run = job = { id: cell.id, hold, stopped: false, away: false };
    const key = event => { if (event.key === 'Escape') { run.stopped = true; event.preventDefault(); event.stopImmediatePropagation(); hold.wake(); } };
    window.addEventListener('keydown', key, true);
    const stopped = () => run.stopped;
    const check = () => {
      if (run.stopped) throw new Stopped(STOPPED);
      if (hold.state() !== 'own') throw changed();
    };
    try {
      let failed = null, start;
      try {
        // Before anything moves: the list is the series the grid names for the cell, whole and once; the reader's last
        // move has ended; and the cell shows the image it ended on.
        say?.(kinText("{0} 1/{n1} · Esc로 멈춤", verb, ids.length));
        if (!covers(services, cell.id, ids)) throw ownError(UNSURE);
        start = await hold.settle(stopped); check();
        await hold.show(start, stopped); check();
        // The viewer's slice number follows the requests made of the cell, so the first image of the file is asked for
        // like every other: a cell that starts on it goes to the next image first.
        if (start === 0 && ids.length > 1) { run.away = true; await hold.show(1, stopped); check(); }
        for (let index = 0; index < ids.length; index++) {
          check(); say?.(kinText("{0} {n1}/{n2} · Esc로 멈춤", verb, (index + 1), ids.length));
          if (viewport.getCurrentImageIdIndex() !== index) run.away = true;
          // Two more frames pass after the draw, so the measurement layer and the image text follow the image.
          await hold.show(index, stopped); await frames(2);
          // Every exported image is the series image it stands for, seen on a cell that is still this export's, as its pixels are copied.
          const canvas = await render(hold.cells, () => { check(); if (!hold.shows(index)) throw ownError(hold.hidden() || NOT_LOADED); }, seriesLayer); check();
          await each(canvas, index, ids.length); check();
        }
      } catch (error) { failed = error; }
      // Back to the image the reader was on, shown by the same rule (also when the image number is already that image's).
      // A cell that is not this export's any more is not touched.
      if (run.away && hold.state() === 'own') {
        say?.(kinText("원래 보던 영상으로 돌아가는 중입니다."));
        try { await hold.show(start); }
        catch (_) { if (hold.state() === 'own') failed = ownError(hold.hidden() || NOT_BACK); }
      }
      if (hold.state() !== 'own') throw failed || changed();
      run.away = false;
      if (failed) throw failed;
      check();
      return after ? await after(hold, check) : hold;
    } finally {
      window.removeEventListener('keydown', key, true); job = null; say?.(''); hold.release();
    }
  }
  // For what follows a cell's image (position sync, Manual Sync, Auto Save View): whether the image a cell shows now is
  // one a series export put there on its way, to go back to the reader's image, not one the reader chose. No longer so
  // from the moment the reader takes the cell: what the cell shows then is the reader's.
  const moving = id => !!job && job.away && job.hold.state() !== 'taken' && (id === undefined || id === job.id);

  // Save JPEG: one image. Save Series JPEG: every image of the selected series as JPEG in one ZIP.
  async function saveImage(services, live) {
    const target = pin(services, 'image', live);
    if (!target) { tell(services, kinText("저장할 영상 칸이 없습니다."), 'warning'); return false; }
    try {
      const file = await blob(await render(target.cells), 'image/jpeg', 0.92);
      if (!target.same()) throw changed();
      download(file, 'image-' + stamp() + '.jpg'); tell(services, kinText("JPEG 파일을 만들어 내려받기를 시작했습니다."), 'success'); return true;
    } catch (error) { tell(services, failure(error), 'error'); return false; }
    finally { target.release(); }
  }
  async function saveSeries(services, live, say) {
    const files = [];
    try {
      const target = await walk(services, live, say, kinText("JPEG 만드는 중"), async (canvas, index, total) => {
        const data = new Uint8Array(await (await blob(canvas, 'image/jpeg', 0.92)).arrayBuffer());
        files.push({ name: 'image-' + String(index + 1).padStart(Math.max(4, String(total).length), '0') + '.jpg', data });
      }, (target, unchanged) => {
        const file = zip(files); unchanged();
        download(file, seriesName(target.cells[0].viewport) + '-' + stamp() + '.zip'); return true;
      });
      if (!target) return false;
      tell(services, kinText("시리즈 영상 {n0}장을 JPEG 파일로 만들어 내려받기를 시작했습니다.", files.length), 'success'); return true;
    } catch (error) { tell(services, failure(error), error instanceof Stopped ? 'warning' : 'error'); return false; }
  }

  // Save Video: every image of the selected series is drawn first, in the series' own order (the cell's stack,
  // one frame per image or frame of a multi-frame image), then encoded one video frame per image with its own time:
  // image k starts at k/fps seconds. Nothing is played in real time, so slow loading, a busy computer or a hidden
  // window cannot drop, repeat or shift an image. The file is written only when the encoder gave back exactly one
  // frame per image, in order and at its time; a short, empty or failed encoding writes nothing and says so.
  // H.264 in MP4 where this browser encodes it, else VP9 or VP8 in WebM.
  const CODECS = [['avc1.640034', 'mp4'], ['avc1.4d0034', 'mp4'], ['avc1.42e034', 'mp4'], ['vp09.00.51.08', 'webm'], ['vp8', 'webm']];
  const NO_VIDEO = kinText("이 브라우저에서는 동영상을 저장할 수 없습니다.");
  const SHORT = kinText("동영상에 시리즈의 모든 영상이 담기지 않아 저장하지 않았습니다. 다시 시도하세요.");
  const UNMADE = kinText("동영상을 만들지 못해 저장하지 않았습니다. 다시 시도하세요.");
  const videoReady = () => typeof window.VideoEncoder === 'function' && typeof window.VideoFrame === 'function';
  // A frame's time in microseconds, the unit of the encoder and of the MP4 written here.
  const frameTime = (index, fps) => Math.round(index * 1000000 / fps);
  async function encodeVideo(images, fps, check, say) {
    const first = await createImageBitmap(images[0]);
    // Video encoders take even sizes; every image is drawn at the first one's size.
    const width = Math.max(2, first.width - first.width % 2), height = Math.max(2, first.height - first.height % 2);
    first.close();
    let tried = false, last = null;
    for (const [codec, container] of CODECS) {
      const config = { codec, width, height, bitrate: 8000000, framerate: fps, ...(container === 'mp4' ? { avc: { format: 'avc' } } : {}) };
      const support = await window.VideoEncoder.isConfigSupported(config).catch(() => null);
      if (!support?.supported) continue;
      tried = true;
      try { return await encodeWith(config, container, images, fps, check, say); }
      // Another codec is tried after a failed or short encoding; the file is still whole or not written.
      catch (error) { if (error instanceof Stopped) throw error; last = error; }
    }
    throw last?.message === SHORT ? last : ownError(tried ? UNMADE : NO_VIDEO);
  }
  async function encodeWith(config, container, images, fps, check, say) {
    // The decoder setup the encoder gives with its first frame; one that is empty (H.264) or changes later cannot be
    // written as the single setup of the file.
    const chunks = []; let failed = null, setup = null, unsteady = false;
    const copy = data => new Uint8Array(ArrayBuffer.isView(data) ? data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) : data.slice(0));
    const same = (one, two) => one.length === two.length && one.every((value, index) => value === two[index]);
    const encoder = new window.VideoEncoder({
      output: (chunk, metadata) => {
        const data = new Uint8Array(chunk.byteLength); chunk.copyTo(data);
        chunks.push({ data, key: chunk.type === 'key', time: chunk.timestamp });
        const given = metadata?.decoderConfig;
        if (!given) return;
        const next = { ...given, description: given.description ? copy(given.description) : undefined };
        if (!setup) setup = next;
        else if (next.codec !== setup.codec || !same(next.description || [], setup.description || [])) unsteady = true;
      },
      error: error => { failed = error || ownError(UNMADE); } });
    const canvas = document.createElement('canvas'); canvas.width = config.width; canvas.height = config.height;
    const context = canvas.getContext('2d'), every = Math.max(1, Math.round(fps));
    const healthy = () => { check(); if (failed) throw failed; };
    try {
      encoder.configure(config);
      for (let index = 0; index < images.length; index++) {
        healthy(); say?.(kinText("동영상 파일 만드는 중 {n0}/{n1} · Esc로 멈춤", (index + 1), images.length));
        const bitmap = await createImageBitmap(images[index]); healthy();
        try { context.drawImage(bitmap, 0, 0, canvas.width, canvas.height); } finally { bitmap.close(); }
        const frame = new window.VideoFrame(canvas, { timestamp: frameTime(index, fps), duration: frameTime(index + 1, fps) - frameTime(index, fps) });
        // A key frame every second, so a player can seek.
        try { encoder.encode(frame, { keyFrame: index % every === 0 }); } finally { frame.close(); }
        while (encoder.encodeQueueSize > 4) { healthy(); await new Promise(resolve => setTimeout(resolve, 5)); }
      }
      healthy(); await encoder.flush(); healthy();
    } finally { if (encoder.state !== 'closed') encoder.close(); }
    // One frame per image, the first a key frame, each at its own time and not empty, under one setup.
    const whole = chunks.length === images.length && chunks[0].key && setup && !unsteady && (container !== 'mp4' || setup.description?.length) &&
      chunks.every((chunk, index) => chunk.time === frameTime(index, fps) && chunk.data.length > 0);
    if (!whole) throw ownError(SHORT);
    // The frames are decoded back with that setup: the file is written only if every frame decodes, in order.
    say?.(kinText("동영상 파일 확인 중 · Esc로 멈춤"));
    if (!await decodes(chunks, { codec: setup.codec, codedWidth: setup.codedWidth || config.width, codedHeight: setup.codedHeight || config.height,
      ...(setup.description?.length ? { description: setup.description } : {}) }, check)) throw ownError(SHORT);
    check();
    const duration = frameTime(images.length, fps);
    return container === 'mp4' ? mp4(chunks, setup.description, config.width, config.height, fps, duration) : webm(chunks, config.codec, config.width, config.height, fps, duration);
  }
  // True only when the browser's decoder takes the setup and returns one picture per frame at the frame's time, with no error.
  async function decodes(chunks, config, check) {
    if (typeof window.VideoDecoder !== 'function' || typeof window.EncodedVideoChunk !== 'function') return false;
    const support = await window.VideoDecoder.isConfigSupported(config).catch(() => null);
    if (!support?.supported) return false;
    const times = []; let broken = false;
    const decoder = new window.VideoDecoder({ output: picture => { times.push(picture.timestamp); picture.close(); }, error: () => { broken = true; } });
    try {
      decoder.configure(config);
      for (const chunk of chunks) {
        check(); if (broken) return false;
        decoder.decode(new window.EncodedVideoChunk({ type: chunk.key ? 'key' : 'delta', timestamp: chunk.time, data: chunk.data }));
        while (decoder.decodeQueueSize > 4 && !broken) { check(); await new Promise(resolve => setTimeout(resolve, 5)); }
      }
      await decoder.flush();
    } catch (error) { if (error instanceof Stopped) throw error; return false; }
    finally { if (decoder.state !== 'closed') decoder.close(); }
    return !broken && times.length === chunks.length && times.every((time, index) => time === chunks[index].time);
  }
  // The file around the encoded frames. Byte helpers: big-endian numbers and joined parts.
  const bytes = (...values) => Uint8Array.from(values);
  const be = (value, size) => { const out = new Uint8Array(size); for (let i = size - 1; i >= 0; i--) { out[i] = value % 256; value = Math.floor(value / 256); } return out; };
  const ascii = text => Uint8Array.from(text, c => c.charCodeAt(0));
  const join = parts => {
    const flat = parts.flat(Infinity), out = new Uint8Array(flat.reduce((sum, part) => sum + part.length, 0)); let at = 0;
    for (const part of flat) { out.set(part, at); at += part.length; }
    return out;
  };
  // MP4: ftyp, moov (one H.264 track, every sample's size, time and whether it is a key frame), then mdat.
  function mp4(chunks, description, width, height, fps, duration) {
    const box = (type, ...parts) => { const body = join(parts); return join([be(body.length + 8, 4), ascii(type), body]); };
    const full = (type, flags, ...parts) => box(type, be(flags, 4), ...parts);
    const size = chunks.reduce((sum, chunk) => sum + chunk.data.length, 0);
    if (size > 0xFFFFFFF0 || duration > 0xFFFFFFFF) throw kinError("저장할 파일이 너무 큽니다.");
    const scale = 1000000, matrix = [0x10000, 0, 0, 0, 0x10000, 0, 0, 0, 0x40000000].map(value => be(value, 4));
    const deltas = [];
    chunks.forEach((chunk, index) => {
      const delta = frameTime(index + 1, fps) - chunk.time, last = deltas.at(-1);
      if (last && last[1] === delta) last[0]++; else deltas.push([1, delta]);
    });
    const keys = chunks.map((chunk, index) => chunk.key ? index + 1 : 0).filter(Boolean);
    const ftyp = box('ftyp', ascii('isom'), be(0x200, 4), ascii('isomiso2avc1mp41'));
    const moov = offset => box('moov',
      full('mvhd', 0, be(0, 4), be(0, 4), be(scale, 4), be(duration, 4), be(0x10000, 4), be(0x100, 2), be(0, 10), matrix, be(0, 24), be(2, 4)),
      box('trak',
        full('tkhd', 3, be(0, 4), be(0, 4), be(1, 4), be(0, 4), be(duration, 4), be(0, 8), be(0, 8), matrix, be(width * 0x10000, 4), be(height * 0x10000, 4)),
        box('mdia',
          full('mdhd', 0, be(0, 4), be(0, 4), be(scale, 4), be(duration, 4), be(0x55C4, 2), be(0, 2)),
          full('hdlr', 0, be(0, 4), ascii('vide'), be(0, 12), ascii('VideoHandler\0')),
          box('minf',
            full('vmhd', 1, be(0, 8)),
            box('dinf', full('dref', 0, be(1, 4), full('url ', 1))),
            box('stbl',
              full('stsd', 0, be(1, 4), box('avc1', be(0, 6), be(1, 2), be(0, 16), be(width, 2), be(height, 2),
                be(0x480000, 4), be(0x480000, 4), be(0, 4), be(1, 2), be(0, 32), be(0x18, 2), bytes(0xFF, 0xFF), box('avcC', description))),
              full('stts', 0, be(deltas.length, 4), deltas.map(([count, delta]) => [be(count, 4), be(delta, 4)])),
              full('stss', 0, be(keys.length, 4), keys.map(number => be(number, 4))),
              full('stsc', 0, be(1, 4), be(1, 4), be(chunks.length, 4), be(1, 4)),
              full('stsz', 0, be(0, 4), be(chunks.length, 4), chunks.map(chunk => be(chunk.data.length, 4))),
              full('stco', 0, be(1, 4), be(offset, 4)))))));
    const head = ftyp.length + moov(0).length + 8;
    return new Blob([ftyp, moov(head), be(size + 8, 4), ascii('mdat'), ...chunks.map(chunk => chunk.data)], { type: 'video/mp4' });
  }
  // WebM: EBML header, then one Segment with Info (length), Tracks (one video track), a Cluster from each key frame
  // (times in milliseconds) and Cues pointing at the Clusters, so a player can seek.
  function webm(chunks, codec, width, height, fps, duration) {
    const size = value => { let length = 1; while (value >= 2 ** (7 * length) - 1) length++; const out = be(value, length); out[0] |= 1 << (8 - length); return out; };
    const id = hex => Uint8Array.from(hex.match(/../g), pair => parseInt(pair, 16));
    const element = (hex, ...parts) => { const body = join(parts); return join([id(hex), size(body.length), body]); };
    const uint = (hex, value) => { let length = 1; while (value >= 2 ** (8 * length)) length++; return element(hex, be(value, length)); };
    const float = (hex, value) => { const view = new DataView(new ArrayBuffer(8)); view.setFloat64(0, value); return element(hex, new Uint8Array(view.buffer)); };
    const ms = time => Math.round(time / 1000);
    const header = element('1A45DFA3', uint('4286', 1), uint('42F7', 1), uint('42F2', 4), uint('42F3', 8), element('4282', ascii('webm')), uint('4287', 4), uint('4285', 2));
    const info = element('1549A966', uint('2AD7B1', 1000000), element('4D80', ascii('PACS viewer')), element('5741', ascii('PACS viewer')), float('4489', duration / 1000));
    const tracks = element('1654AE6B', element('AE', uint('D7', 1), uint('73C5', 1), uint('83', 1), element('86', ascii(codec.startsWith('vp09') ? 'V_VP9' : 'V_VP8')),
      uint('23E383', Math.round(1000000000 / fps)), uint('9C', 0), element('E0', uint('B0', width), uint('BA', height))));
    const clusters = [], cues = []; let at = info.length + tracks.length, open = null;
    const close = () => { if (!open) return; const cluster = element('1F43B675', uint('E7', open.time), open.blocks); cues.push([open.time, at]); clusters.push(cluster); at += cluster.length; open = null; };
    for (const chunk of chunks) {
      if (chunk.key || !open || ms(chunk.time) - open.time > 30000) { close(); open = { time: ms(chunk.time), blocks: [] }; }
      const relative = new DataView(new ArrayBuffer(2)); relative.setInt16(0, ms(chunk.time) - open.time);
      open.blocks.push(element('A3', bytes(0x81), new Uint8Array(relative.buffer), bytes(chunk.key ? 0x80 : 0), chunk.data));
    }
    close();
    const index = element('1C53BB6B', cues.map(([time, position]) => element('BB', uint('B3', time), element('B7', uint('F7', 1), uint('F1', position)))));
    return new Blob([header, element('18538067', info, tracks, clusters, index)], { type: 'video/webm' });
  }
  async function saveVideo(services, live, say) {
    if (!videoReady()) { tell(services, NO_VIDEO, 'error'); return false; }
    const images = [];
    try {
      // Every image is drawn at one size; a cell resized part way through is a changed screen, not a stretched frame.
      let size = null;
      const done = await walk(services, live, say, kinText("동영상 영상 만드는 중"), async canvas => {
        if (size && size !== canvas.width + 'x' + canvas.height) throw changed();
        size = canvas.width + 'x' + canvas.height; images.push(await blob(canvas, 'image/jpeg', 0.95)); },
        async (target, check) => {
          const rate = Number(services.cineService?.getState?.()?.cines?.[target.cells[0].id]?.frameRate);
          const fps = Number.isFinite(rate) && rate >= 1 && rate <= 90 ? rate : 10;
          const file = await encodeVideo(images, fps, check, say); check();
          download(file, seriesName(target.cells[0].viewport) + '-' + stamp() + (file.type === 'video/mp4' ? '.mp4' : '.webm'));
          return fps;
        });
      if (!done) return false;
      tell(services, kinText("시리즈 영상 {n0}장을 {n1} fps 동영상 파일로 만들어 내려받기를 시작했습니다.", images.length, done), 'success'); return true;
    } catch (error) { tell(services, failure(error), error instanceof Stopped ? 'warning' : 'error'); return false; }
  }

  // Captures: captures collect in a Captures panel of this viewer window: in memory only, kept as PNG, emptied when
  // the viewer leaves this study or mode (end()). A capture still being drawn then is dropped.
  let shelf = null, generation = 0;
  function element(tag, text, parent) { const node = document.createElement(tag); if (text) node.textContent = text; parent?.append(node); return node; }
  function control(text, parent, click) { const node = element('button', text, parent); node.type = 'button'; node.onclick = click; return node; }
  function openShelf(services, live) {
    if (shelf) { shelf.services = services; shelf.live = live; shelf.aside.hidden = false; return shelf; }
    const aside = element('aside', '', document.body); aside.className = 'kin-captures';
    aside.setAttribute('aria-label', 'Captures');
    aside.style.cssText = 'position:fixed;right:8px;top:72px;z-index:1000;width:250px;max-height:75vh;overflow:auto;padding:8px;' +
      'background:#0b1730;color:#fff;border:1px solid #657c9f;border-radius:6px;font:13px sans-serif';
    const title = element('h2', '', aside); title.style.cssText = 'margin:0 0 6px;font-size:14px';
    const tools = element('div', '', aside), list = element('ol', '', aside); list.style.cssText = 'list-style:none;margin:6px 0 0;padding:0';
    const items = [];
    const view = { aside, items, services, live, list };
    const refresh = () => {
      title.textContent = 'Captures (' + items.length + ')';
      list.replaceChildren();
      if (!items.length) element('li', kinText("캡처가 없습니다. Add Image 또는 Add Screen으로 모읍니다."), list);
      items.forEach((item, index) => {
        const row = element('li', '', list); row.style.cssText = 'margin:0 0 8px';
        const image = element('img', '', row); image.src = item.url; image.alt = item.label; image.style.cssText = 'display:block;max-width:100%;border:1px solid #657c9f';
        element('div', item.label, row);
        control('Copy', row, () => {
          if (!navigator.clipboard?.write || typeof ClipboardItem !== 'function') { tell(view.services, kinText("이 브라우저에서는 영상을 클립보드에 복사할 수 없습니다."), 'error'); return; }
          navigator.clipboard.write([new ClipboardItem({ 'image/png': item.blob })])
            .then(() => tell(view.services, kinText("{0}을(를) 클립보드에 복사했습니다.", item.label), 'success'), error => tell(view.services, failure(error), 'error'));
        }).setAttribute('aria-label', 'Copy ' + item.label);
        control('Save', row, () => download(item.blob, item.name)).setAttribute('aria-label', 'Save ' + item.label);
        control('Remove', row, () => { URL.revokeObjectURL(item.url); items.splice(items.indexOf(item), 1); refresh(); }).setAttribute('aria-label', 'Remove ' + item.label);
      });
    };
    control('Add Image', tools, () => collect(view.services, 'image', view.live));
    control('Add Screen', tools, () => collect(view.services, 'screen', view.live));
    // Save All reads the captures asynchronously; a panel emptied or closed by leaving the study meanwhile writes nothing.
    control('Save All', tools, () => {
      if (!items.length) return;
      const ticket = generation;
      Promise.all(items.map(async item => ({ name: item.name, data: new Uint8Array(await item.blob.arrayBuffer()) })))
        .then(files => { if (ticket === generation && shelf === view && view.live?.() !== false) download(zip(files), 'captures-' + stamp() + '.zip'); },
          error => { if (ticket === generation) tell(view.services, failure(error), 'error'); });
    });
    control('Clear', tools, () => { items.splice(0).forEach(item => URL.revokeObjectURL(item.url)); refresh(); });
    control('Close', tools, () => { aside.hidden = true; });
    view.refresh = refresh; refresh();
    return shelf = view;
  }
  async function collect(services, scope, live) {
    const view = openShelf(services, live), ticket = generation;
    // The panel's own Add buttons meet the toolbar's guards: no empty or switching viewer, no image work loading.
    const body = document.body.classList;
    if (body.contains('kin-viewer-empty') || body.contains('kin-patient-switching') ||
        [window.kinViewerHistoryWorkspaceState?.(), window.kinViewerJobWorkspaceState?.()].some(state => state?.busy)) {
      tell(services, kinText("영상 작업을 불러오는 중입니다. 완료 후 다시 시도하세요."), 'info'); return false;
    }
    const target = pin(services, scope, live);
    if (!target) { tell(services, kinText("모을 영상 칸이 없습니다."), 'warning'); return false; }
    try {
      const file = await blob(await render(target.cells), 'image/png');
      if (ticket !== generation || shelf !== view) return false;
      if (!target.same()) throw changed();
      const number = (view.count = (view.count || 0) + 1), time = new Date().toTimeString().slice(0, 8);
      view.items.push({ blob: file, url: URL.createObjectURL(file), name: 'capture-' + String(number).padStart(2, '0') + '-' + stamp() + '.png',
        label: 'Capture ' + number + (scope === 'screen' ? ' · Screen' : '') + ' · ' + time });
      view.refresh(); return true;
    } catch (error) { if (ticket === generation) tell(services, failure(error), 'error'); return false; }
    finally { target.release(); }
  }
  // The viewer leaves this study or mode: a series export still going is over (it moves nothing more and writes nothing).
  function end() {
    generation++;
    job?.hold.lose('ended');
    if (!shelf) return;
    shelf.items.splice(0).forEach(item => URL.revokeObjectURL(item.url)); shelf.aside.remove(); shelf = null;
  }

  const WARNING = kinText("식별정보가 포함될 수 있습니다. Image Text/Images Only는 익명화가 아닙니다.");
  const actions = [
    { id: 'CopyImage', label: 'Copy Image', description: kinText("선택한 영상 칸을 보이는 그대로(영상·표식·영상 글자) 클립보드에 PNG로 복사 · {0}", WARNING),
      run: (services, { live } = {}) => copy(services, 'image', live) },
    { id: 'CopyScreen', label: 'Copy Screen', description: kinText("이 창의 모든 영상 칸을 보이는 그대로 한 장으로 클립보드에 PNG로 복사 · {0}", WARNING),
      run: (services, { live } = {}) => copy(services, 'screen', live) },
    { id: 'SaveJPEG', label: 'Save JPEG', description: kinText("선택한 영상 칸을 보이는 그대로 JPEG 파일로 저장 · {0}", WARNING),
      run: (services, { live } = {}) => saveImage(services, live) },
    { id: 'SaveSeriesJPEG', label: 'Save Series JPEG', description: kinText("선택한 영상 칸 시리즈의 모든 영상을 처음부터 끝까지 보이는 그대로 JPEG로 만들어 ZIP 하나로 저장 · Esc로 멈춤 · {0}", WARNING),
      run: (services, { live, say } = {}) => saveSeries(services, live, say) },
    { id: 'SaveVideo', label: 'Save Video', description: kinText("선택한 영상 칸 시리즈의 모든 영상을 처음부터 끝까지 보이는 그대로 동영상(MP4, 안 되는 브라우저는 WebM)으로 저장 · 속도는 이 칸의 Cine 속도(없으면 10 fps) · Esc로 멈춤 · {0}", WARNING),
      run: (services, { live, say } = {}) => saveVideo(services, live, say) },
    { id: 'AddToCaptures', label: 'Add to Captures', description: kinText("선택한 영상 칸을 보이는 그대로 이 창의 Captures 패널에 모으고 패널을 엽니다(이 창에만 있고 검사를 떠나면 비워짐) · {0}", WARNING),
      run: (services, { live } = {}) => collect(services, 'image', live) },
    { id: 'Captures', label: 'Captures', description: kinText("Captures 패널 열기/닫기: 모은 캡처를 복사·저장(PNG)·지우기, 모두 ZIP으로 저장"),
      run: (services, { live } = {}) => { if (shelf && !shelf.aside.hidden) shelf.aside.hidden = true; else openShelf(services, live); } },
  ];
  return { actions, options, pin, render, copy, saveImage, saveSeries, saveVideo, zip, end, moving };
})();
