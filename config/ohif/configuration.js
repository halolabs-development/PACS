
// W9 multi-study view (worklist-v0/hpacs-lite/viewer-multi-study.js): load, mount and stop its strip and renderer observer
// with the viewer mode, the way Frame Coverage is mounted. Only a viewer the worklist opened for a multi-study opening (the
// `kin-w9` fragment, also set later on a reused window) loads it; every other viewer loads nothing more.
function kinCreateMultiStudyStrip() {
  let ready = null, current = null, services, epoch = 0, active = false;
  const wanted = () => /(?:^#|&)kin-w9=/.test(location.hash);
  const load = () => window.KinViewerMultiStudy ? Promise.resolve() : ready || (ready = new Promise((resolve, reject) => {
    const script = document.createElement('script'); script.src = '/worklist/hpacs-lite/viewer-multi-study.js';
    const timeout = setTimeout(() => { ready = null; reject(Error('Multi-Study View loading timeout')); }, 20000);
    script.onload = () => { clearTimeout(timeout); resolve(); start(); };
    script.onerror = () => { clearTimeout(timeout); ready = null; reject(Error('Multi-Study View loading failed')); };
    document.head.append(script);
  }));
  function start() {
    if (!active || current || !wanted()) return;
    const ticket = epoch;
    load().then(() => { if (active && ticket === epoch && !current) current = window.KinViewerMultiStudy.mount(services); }).catch(() => {});
  }
  return { id: 'kin.multi-study-strip', preRegistration({ servicesManager }) {
    services = servicesManager.services;
    window.addEventListener('hashchange', start); window.addEventListener('kin-window-link-changed', start);
  }, onModeEnter() { epoch++; active = true; start(); },
  onModeExit() { epoch++; active = false; current?.stop(); current = null; } };
}

// DICOM overlay planes (60xx,3000) on an image: the archive sends their bits as a bulk data address, which the pinned overlay
// tool (Image Overlay) cannot read — it cached an empty overlay and failed on every later draw, measurements in the same cell
// included, and turning Image Overlay off and on raised an error. Only such a plane takes a new way here, and only in the
// form the pinned tool draws in the right place: one frame of image and mask, the mask from the first pixel covering the
// whole image, square pixels, and at the moment of drawing the image's axes on the screen neither flipped nor turned. Its bits
// are read once (a second draw waits for the same read; no read again after a failure) from this origin's instance bulk path
// through the viewer's one bulk read (kinFetchBulk), and must be exactly one frame of the mask. A plane outside that form, or
// one whose bits cannot be read, is not drawn — for that draw only, the overlay list the tool shares is left as it is, so
// the cell's measurements are still drawn. A drawn plane appears only on its own image and only while Image Overlay is on.
// Planes the pinned tool already reads (values in the metadata) go its own way, unchanged.
function kinCreateOverlayPlanes() {
  const MARK = Symbol.for('kin.overlay-planes');
  const bulkOnly = o => { const d = o?.pixelData;
    return !!d && !o.dataUrl && !d.Value && !Array.isArray(d) && !d.retrieveBulkData && !d.InlineBinary && typeof d.BulkDataURI === 'string'; };
  const pair = v => Array.isArray(v) && v.length >= 2 ? v.slice(0, 2).map(Number) : null;
  const header = id => { try { return window.cornerstone.metaData.get('instance', id) || null; } catch (_) { return null; } };
  // A header number as the metadata keeps it (a number, a list, or the raw bytes of an element the dictionary does not name).
  const number = v => { const x = Array.isArray(v) ? v[0] : v;
    if (x === undefined || x === null || x === '') return undefined;
    return Number(x instanceof ArrayBuffer ? new TextDecoder().decode(x).replace(/\0/g, '').trim() : x); };
  // Overlay frames declared for this plane (60xx,0015); absent is one. Its group is the one holding this very element; when
  // that cannot be told, any overlay group declaring more than one frame counts.
  function frames(h, o) {
    const groups = Array.from({ length: 16 }, (_, i) => (0x6000 + 2 * i).toString(16));
    const own = groups.find(g => h[g + '3000'] === o.pixelData);
    const declared = (own ? [own] : groups.filter(g => h[g + '3000'] !== undefined)).map(g => number(h[g + '0015'])).filter(n => n !== undefined);
    return declared.length ? Math.max(...declared.map(n => Number.isFinite(n) ? n : Infinity)) : 1;
  }
  function allowed(imageId, o) {
    const h = header(imageId);
    if (!h || Number(h.NumberOfFrames) > 1 || frames(h, o) !== 1) return false;
    if (o.x !== 1 || o.y !== 1 || o.rows !== Number(h.Rows) || o.columns !== Number(h.Columns) || !(o.rows > 0 && o.columns > 0)) return false;
    const spacing = pair(h.PixelSpacing) || pair(h.ImagerPixelSpacing), aspect = pair(h.PixelAspectRatio);
    const square = s => s.every(x => Number.isFinite(x) && x > 0) && Math.abs(s[0] - s[1]) <= 1e-6 * Math.max(s[0], s[1]);
    return spacing ? square(spacing) : !aspect || square(aspect);
  }
  // The image's first pixel, its last column and its last row on the screen: axes along the screen's, pointing right and down.
  function upright(viewport, imageId) {
    try {
      const h = header(imageId), u = window.cornerstone.utilities;
      const at = p => viewport.worldToCanvas(u.imageToWorldCoords(imageId, p));
      const o = at([0, 0]), r = at([Number(h.Columns), 0]), d = at([0, Number(h.Rows)]);
      return r[0] > o[0] && Math.abs(r[1] - o[1]) < .5 && d[1] > o[1] && Math.abs(d[0] - o[0]) < .5;
    } catch (_) { return false; }
  }
  function install() {
    const proto = window.cornerstoneTools?.state?.tools?.ImageOverlayViewer?.toolClass?.prototype;
    if (!proto || proto[MARK]) return;
    if (typeof proto._getCachedStat !== 'function' || typeof proto._renderOverlay !== 'function') return;
    const read = proto._getCachedStat, draw = proto._renderOverlay;
    // The plane ready to draw, or null; one per bulk data element, kept for the page.
    const planes = new WeakMap();
    async function plane(tool, imageId, overlayMetadata, o, color) {
      if (!allowed(imageId, o)) return null;
      let bytes = null;
      try { bytes = await kinFetchBulk(o.pixelData.BulkDataURI); } catch (_) { return null; }
      const need = Math.ceil(o.rows * o.columns / 8);
      // Exactly one frame of the mask: one byte more only as the padding to an even length (a frame of an odd byte count).
      if (!bytes || !(bytes.length === need || need % 2 === 1 && bytes.length === need + 1)) return null;
      try {
        const answer = await read.call(tool, imageId, { ...overlayMetadata, overlays: [{ ...o, pixelData: { Value: bytes.slice(0, need).buffer } }] }, color);
        const drawn = answer?.overlays?.[0];
        return drawn?.dataUrl ? { ...drawn, kinImageId: imageId, kinBulk: true } : null;
      } catch (_) { return null; }
    }
    proto._getCachedStat = async function (imageId, overlayMetadata, color) {
      const list = Array.isArray(overlayMetadata?.overlays) ? overlayMetadata.overlays : [];
      if (!list.some(bulkOnly)) return read.call(this, imageId, overlayMetadata, color);
      const drawn = await Promise.all(list.map(o => {
        if (!bulkOnly(o)) return Promise.resolve(read.call(this, imageId, { ...overlayMetadata, overlays: [o] }, color))
          .then(answer => answer?.overlays?.[0] || null, () => null);
        if (!planes.has(o.pixelData)) planes.set(o.pixelData, plane(this, imageId, overlayMetadata, o, color));
        return planes.get(o.pixelData);
      }));
      return { ...overlayMetadata, overlays: drawn.filter(Boolean) };
    };
    proto._renderOverlay = function (enabledElement, svgDrawingHelper, overlay) {
      if (overlay?.kinBulk) {
        const viewport = enabledElement?.viewport, id = this.getReferencedImageId(viewport);
        if (this.mode === 'Disabled' || overlay.kinImageId !== id || !upright(viewport, id)) return false;
      }
      return draw.call(this, enabledElement, svgDrawingHelper, overlay);
    };
    proto[MARK] = true;
  }
  return { id: 'kin.overlay-planes', preRegistration() { install(); }, onModeEnter() { install(); } };
}
// The viewer's route `/` (see customizationService below): leave the viewer app for the sign-in entry, which sends a signed-in
// account to its home screen (KinAuth.home: the worklist, or the clinician screen) and anyone else to sign in.
function kinViewerRootToWorklist() {
  location.replace('/worklist/hpacs-lite/index.html');
  return null;
}

window.config = {
  extensions: [kinCreateSessionBoundary(), kinStackPrecision, kinCreateFrameMetadata(), kinCreateSRProvenance(), kinCreateViewerHistory(), kinCreateViewerFindings(), kinCreateViewerLayout(), kinCreateViewerJobs(), kinCreateViewerTechNote(), kinCreateFrameCoverage(), '@ohif/extension-dicom-pdf', kinCreateDicomPdf(), kinCreateCTSync(), kinCreateCine(), kinCreateDisplayScope(), kinCreateCellMerge(), kinCreateImagesOnly(), kinCreateImageText(), kinCreateCTPresets(), kinCreateThreeDCursor(), kinCreateSeriesMetadataRecovery(), kinCreateImageLoadStatus(), kinCreateContextLoss(), kinCreateMammographyHanging(), kinCreateSeriesSplit(), kinCreateSeriesOrder(), kinCreateMGReferenceLines(), kinCreateStudyPrefetch(), kinCreateStudySearch(), kinCreateViewerUX(), kinCreateViewerPrior(), kinCreateViewerReportPanel(), kinCreateMultiStudyStrip(), kinCreateMarkerStyle(), kinCreateOverlayPlanes()],
  // REQ-D-3D-CURSOR. 3D Cursor(대응점 표시)는 뷰어에 켜져 있다. 판독자는 도구 영역의 3D Cursor
  // 버튼으로 모드에 들어간다. === true 하나만 ON이고, 끄는 길도 이 리터럴 하나뿐이다.
  kinThreeDCursor: { enabled: true },
  modes: [],
  // The study list is the worklist's, not the viewer's. OHIF's own list (route `/`) cannot list anything here — the
  // gateway refuses a QIDO search without one study UID (api/src/pacs/dicom-gateway.ts) — so it only ever showed
  // "Data Source Connection Error", and the header logo sent the open viewer there. With showStudyList off the logo is
  // not a return button; every remaining way into `/` (a typed /ohif/, the not-found-study link, the local-file reader)
  // goes to the sign-in entry, which opens the account's home screen.
  customizationService: { customRoutes: { routes: [{ path: '/', children: kinViewerRootToWorklist }] } },
  showStudyList: false,
  autoPlayCine: false,

  // [KIN 추가] 업스트림 소스를 건드리지 않고 헤더·검사 탭 수명주기를 교체한다.
  whiteLabeling: {
    createLogoComponentFn: React => React.createElement(KinViewerBrand, { React }),
  },

  // [KIN 추가] "investigational use only" 배너를 표시하지 않음
  investigationalUseDialog: { option: 'never' },

  // some windows systems have issues with more than 3 web workers
  maxNumberOfWebWorkers: 3,
  // below flag is for performance reasons, but it might not work for all servers
  omitQuotationForMultipartRequest: true,
  // Offer native frame codecs explicitly so the archive can pass through compressed MG/DBT without transcoding.
  acceptHeader: ['multipart/related; type=application/octet-stream; transfer-syntax=*',
    'multipart/related; type=image/jpeg; transfer-syntax=*', 'multipart/related; type=image/jls; transfer-syntax=*',
    'multipart/related; type=image/jp2; transfer-syntax=*', 'multipart/related; type=image/dicom-rle; transfer-syntax=*'],
  showWarningMessageForCrossOrigin: true,
  showCPUFallbackMessage: true,
  showLoadingIndicator: true,
  strictZSpacingForVolumeViewport: true,
  maxNumRequests: {
    interaction: 100,
    thumbnail: 75,
    prefetch: 25,
  },
  httpErrorHandler: error => {
    if (error.status) {
      console.warn(error.status);
    } else {
      console.warn(error);
    }
  },
};
