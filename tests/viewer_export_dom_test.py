# coding: utf-8
"""Viewer export (copy, JPEG, series, video, captures) on the shipped toolbar and export module.

The shipped viewer-ux-toolbar.js, viewer-ux-shortcuts.js and viewer-export.js run in Chromium beside synthetic
OHIF services and two synthetic image cells: a drawn image canvas at twice its CSS size, a measurement layer
(svg.svg-layer) and image text. The clipboard, canvas and video encoders and downloads are the browser's own.
Only synthetic pixels are used. Pixel rendering of the real Cornerstone canvas stays with the served viewer tests.
"""
from pathlib import Path
import unittest

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
HPACS = ROOT / "worklist-v0" / "hpacs-lite"
ORIGIN = "https://viewer-export.test"

HARNESS = """<!doctype html><html><head><style>
body { margin: 0; background: #111; font-family: sans-serif; }
#grid { position: absolute; left: 0; top: 60px; display: flex; }
[data-cy=viewport-pane] { position: relative; width: 200px; height: 150px; overflow: hidden; }
.viewport-element { position: absolute; inset: 0; }
.viewport-element canvas, .viewport-element svg { position: absolute; left: 0; top: 0; width: 200px; height: 150px; }
.overlay { position: absolute; left: 4px; top: 4px; color: rgb(255, 255, 0); font: bold 28px sans-serif; }
.action { position: absolute; right: 2px; bottom: 2px; color: rgb(255, 0, 255); font: bold 28px sans-serif; }
</style></head><body><div id="root"><div class="kin-ux-toolbar-slot"></div><div id="grid"></div></div></body></html>"""

# Two cells. Each image is one colour with a frame number drawn as a bright square at x = 10 + 15 * frame, y = 50 (a
# whole series, synBits: six bits at x = 10 + 22 * bit, y = 115); the measurement layer draws a green line across the
# middle. The cell action button text is not image text.
# Each cell's viewport behaves as the viewer's stack viewport (Cornerstone 2.2.4 StackViewport) in what an export depends
# on. getImageIds() is the stack's own list. setImageIdIndex() of the image already asked for does nothing; of another
# it moves the image number at once, announces the request (PRE_STACK_NEW_IMAGE) inside the call and then loads. A load
# that is no longer the image asked for when it arrives is dropped. A loaded image is held (getCornerstoneImage),
# announced (STACK_NEW_IMAGE) and drawn at the next frame (IMAGE_RENDERED). setStack() announces its first request at
# once and the new stack (VIEWPORT_NEW_IMAGE_SET) only after that load. scroll() moves the scroll target and announces
# it (STACK_VIEWPORT_SCROLL) at once, but asks for an image not loaded yet 40 ms later. The grid sends its notices a
# moment after a change, as the viewer's grid service does (setActive places the selection without a notice).
SETUP = """() => {
  const colours = { left: [200, 0, 0], right: [0, 0, 200] };
  const TEXT_COLOURS = ['rgb(0, 255, 255)', 'rgb(255, 255, 0)', 'rgb(255, 128, 0)', 'rgb(128, 255, 128)'];
  window.synNotes = []; window.synInteractions = []; window.synBusy = false;
  // Loads: how long image `index` of a cell takes (seen: it loaded before); which images fail to load (the image number
  // moves, the image never arrives) and whether the failure is announced; every request made; and whether a load that
  // was dropped never answers (as with CPU rendering).
  window.synLoadMs = (id, index, seen) => 5; window.synFailAt = new Set(); window.synFailNotice = false;
  window.synRequests = []; window.synNeverAnswers = false;
  const counts = window.synCounts || { left: 4, right: 4 };
  const fire = (target, type, detail) => target.dispatchEvent(new CustomEvent(type, { detail, cancelable: true }));
  const loader = new EventTarget(), cached = new Set(), instances = new Map(), numbers = new Map();
  const sets = new Map(), viewports = new Map();
  for (const id of ['left', 'right']) {
    const pane = document.createElement('div'); pane.dataset.cy = 'viewport-pane';
    const element = document.createElement('div'); element.className = 'viewport-element';
    const canvas = document.createElement('canvas'); canvas.width = 400; canvas.height = 300;
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); svg.setAttribute('class', 'svg-layer');
    svg.setAttribute('viewBox', '0 0 200 150');
    const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    for (const [k, v] of Object.entries({ x1: 0, y1: 100, x2: 200, y2: 100, stroke: 'rgb(0, 255, 0)', 'stroke-width': 6 })) line.setAttribute(k, v);
    svg.append(line); element.append(canvas, svg);
    const text = document.createElement('div'); text.className = 'overlay'; text.textContent = 'SYN ' + id.toUpperCase();
    const action = document.createElement('button'); action.className = 'action'; action.textContent = 'XX';
    pane.append(element, text, action); document.getElementById('grid').append(pane);
    const series = '1.2.3.' + (id === 'left' ? 1 : 2);
    const imageIds = Array.from({ length: counts[id] }, (_, k) => window.synImageId ? synImageId(id, k) : 'syn:' + id + ':' + k);
    imageIds.forEach((imageId, k) => { numbers.set(imageId, k);
      instances.set(imageId, { StudyInstanceUID: '1.2.3', SeriesInstanceUID: series, SOPInstanceUID: series + '.' + (k + 1) }); });
    sets.set('set-' + id, { displaySetInstanceUID: 'set-' + id, StudyInstanceUID: '1.2.3', SeriesInstanceUID: series,
      images: imageIds.map(imageId => ({ imageId, SOPInstanceUID: instances.get(imageId).SOPInstanceUID })) });
    const view = { id, type: 'stack', element, canvas, imageIds, currentImageIdIndex: 1, targetImageIdIndex: 1,
      csImage: { imageId: imageIds[1] }, viewportStatus: 'rendered', stackInvalidated: false, frame: 0, debounced: 0,
      getImageIds() { return this.imageIds; },
      getCurrentImageIdIndex() { return this.currentImageIdIndex; },
      getTargetImageIdIndex() { return this.targetImageIdIndex; },
      getCurrentImageId() { return this.imageIds[this.currentImageIdIndex]; },
      getCornerstoneImage() { return this.csImage; },
      // The image the viewport holds is drawn at the next frame, and the draw is announced.
      paint() {
        const drawn = numbers.get(this.csImage.imageId) ?? 0;
        const c = canvas.getContext('2d'); c.fillStyle = 'rgb(' + colours[id].join(',') + ')'; c.fillRect(0, 0, 400, 300);
        c.fillStyle = 'rgb(255, 255, 255)';
        if (window.synBits) { for (let bit = 0; bit < 6; bit++) if (drawn >> bit & 1) c.fillRect((10 + 22 * bit) * 2, 115 * 2, 14 * 2, 14 * 2); }
        else c.fillRect((10 + 15 * drawn) * 2, 50 * 2, 10 * 2, 10 * 2);
        // The image text follows one frame later, as React overlays do.
        requestAnimationFrame(() => { text.style.color = TEXT_COLOURS[drawn % 4]; });
      },
      render() {
        if (this.frame) return;
        this.frame = requestAnimationFrame(() => { this.frame = 0; this.paint(); this.viewportStatus = 'rendered';
          fire(element, 'CORNERSTONE_IMAGE_RENDERED', { element, viewportId: id }); });
      },
      load(imageId, imageIdIndex) {
        fire(element, 'CORNERSTONE_PRE_STACK_NEW_IMAGE', { imageId, imageIdIndex, viewportId: id });
        synRequests.push([id, imageIdIndex]);
        return new Promise(resolve => setTimeout(resolve, synLoadMs(id, imageIdIndex, cached.has(imageId)))).then(() => {
          if (synFailAt.has(id + ':' + imageIdIndex)) {
            if (synFailNotice) fire(loader, 'CORNERSTONE_IMAGE_LOAD_ERROR', { imageId, imageIdIndex, error: new Error('load failed') });
            return imageId;
          }
          cached.add(imageId);
          if (this.currentImageIdIndex !== this.imageIds.indexOf(imageId)) return synNeverAnswers ? new Promise(() => {}) : imageId;
          this.csImage = { imageId };
          fire(element, 'CORNERSTONE_STACK_NEW_IMAGE', { imageId, imageIdIndex, viewportId: id });
          this.render(); return imageId;
        });
      },
      setImageIdIndex(index) {
        if (this.currentImageIdIndex === index) return Promise.resolve(this.getCurrentImageId());
        this.currentImageIdIndex = index; this.viewportStatus = 'preRender';
        return this.load(this.imageIds[index], index);
      },
      async setStack(imageIds, index = 0) {
        this.imageIds = imageIds; this.currentImageIdIndex = this.targetImageIdIndex = index; this.viewportStatus = 'preRender';
        const imageId = await this.load(imageIds[index], index);
        fire(element, 'CORNERSTONE_VIEWPORT_NEW_IMAGE_SET', { imageIds, viewportId: id, element, currentImageIdIndex: index });
        return imageId;
      },
      scroll(delta, debounce = true) {
        const before = this.targetImageIdIndex, next = Math.min(this.imageIds.length - 1, Math.max(0, before + delta));
        this.targetImageIdIndex = next;
        if (cached.has(this.imageIds[next]) || !debounce) this.setImageIdIndex(next);
        else { clearTimeout(this.debounced); this.debounced = setTimeout(() => this.setImageIdIndex(next), 40); }
        if (next !== before) fire(element, 'CORNERSTONE_STACK_VIEWPORT_SCROLL', { newImageIdIndex: next, imageId: this.imageIds[next], direction: delta });
      } };
    cached.add(imageIds[1]); view.paint(); viewports.set(id, view);
  }
  window.synViewports = viewports; window.synSets = sets; window.synInstances = instances;
  window.cornerstone = { eventTarget: loader, cache: { getImage: imageId => cached.has(imageId) ? { imageId } : undefined },
    Enums: { ViewportStatus: { RENDERED: 'rendered', PRE_RENDER: 'preRender', LOADING: 'loading' },
      Events: { IMAGE_RENDERED: 'CORNERSTONE_IMAGE_RENDERED', PRE_STACK_NEW_IMAGE: 'CORNERSTONE_PRE_STACK_NEW_IMAGE',
        STACK_NEW_IMAGE: 'CORNERSTONE_STACK_NEW_IMAGE', STACK_VIEWPORT_SCROLL: 'CORNERSTONE_STACK_VIEWPORT_SCROLL',
        VIEWPORT_NEW_IMAGE_SET: 'CORNERSTONE_VIEWPORT_NEW_IMAGE_SET', IMAGE_LOAD_ERROR: 'CORNERSTONE_IMAGE_LOAD_ERROR',
        IMAGE_LOAD_FAILED: 'CORNERSTONE_IMAGE_LOAD_FAILED' } },
    metaData: { get: (type, imageId) => type === 'generalSeriesModule' ? { seriesNumber: 7 } : type === 'instance' ? instances.get(imageId) : undefined } };
  const heard = new Map(), told = (name, notice) => (heard.get(name) || []).slice().forEach(fn => fn(notice));
  const state = { activeViewportId: 'left', layout: { numRows: 1, numCols: 2, layoutType: 'grid' },
    viewports: new Map(['left', 'right'].map(id => [id, { viewportId: id, displaySetInstanceUIDs: ['set-' + id] }])) };
  const grid = {
    EVENTS: { ACTIVE_VIEWPORT_ID_CHANGED: 'event::activeviewportidchanged', LAYOUT_CHANGED: 'event::layoutChanged', GRID_STATE_CHANGED: 'event::gridStateChanged' },
    subscribe(name, fn) { const list = heard.get(name) || []; heard.set(name, list); list.push(fn);
      return { unsubscribe() { const at = list.indexOf(fn); if (at >= 0) list.splice(at, 1); } }; },
    getState: () => state, getActiveViewportId: () => state.activeViewportId,
    setActive: id => { state.activeViewportId = id; },
    setActiveViewportId(id) { state.activeViewportId = id; setTimeout(() => told(grid.EVENTS.ACTIVE_VIEWPORT_ID_CHANGED, { viewportId: id }), 0); },
    setLayout({ numRows, numCols }) { state.layout = { numRows, numCols, layoutType: 'grid' };
      setTimeout(() => { told(grid.EVENTS.LAYOUT_CHANGED, { numRows, numCols }); told(grid.EVENTS.GRID_STATE_CHANGED, { state, removedViewportIds: [] }); }, 0); },
    setDisplaySetsForViewport({ viewportId, displaySetInstanceUIDs }) { state.viewports.get(viewportId).displaySetInstanceUIDs = displaySetInstanceUIDs;
      setTimeout(() => told(grid.EVENTS.GRID_STATE_CHANGED, { state, viewports: [state.viewports.get(viewportId)], removedViewportIds: [] }), 0); } };
  window.synButtons = {
    WindowLevel: { id: 'WindowLevel', uiType: 'ohif.radioGroup', props: { label: 'Window / Level', commands: 'setToolActiveToolbar' } },
    Capture: { id: 'Capture', uiType: 'ohif.radioGroup', props: { label: 'Capture', commands: 'showDownloadViewportModal' } },
    Zoom: { id: 'Zoom', uiType: 'ohif.radioGroup', props: { label: 'Zoom', commands: 'setToolActiveToolbar' } },
  };
  window.synDisabled = new Set();
  window.synSection = ['WindowLevel', 'Capture', 'Zoom'];
  const listeners = [];
  window.synServices = {
    viewportGridService: grid,
    cornerstoneViewportService: { getCornerstoneViewport: id => viewports.get(id) },
    displaySetService: { getDisplaySetByUID: uid => sets.get(uid) },
    cineService: { getState: () => ({ cines: {} }) },
    uiNotificationService: { show: note => window.synNotes.push(note) },
    toolbarService: {
      EVENTS: { TOOL_BAR_MODIFIED: 'modified' },
      getButtonSection: () => window.synSection.filter(id => window.synButtons[id]).map(id => ({ id })),
      getButtons: () => window.synButtons,
      getButtonProps: id => window.synButtons[id] && { id, ...window.synButtons[id].props, disabled: window.synDisabled.has(id) },
      recordInteraction: item => window.synInteractions.push(item.itemId),
      subscribe: (event, fn) => { listeners.push(fn); return { unsubscribe() {} }; },
      changed: () => listeners.forEach(fn => fn()),
    },
  };
  window.kinViewerHistoryWorkspaceState = () => ({ busy: window.synBusy });
  window.kinViewerJobWorkspaceState = () => ({ busy: false });
  window.KinViewerHangingSettings = { modalities: [], defaults: {}, get: () => ({}),
    mount: () => ({ apply() {}, dispose() {} }), mountSizing: () => ({ dispose() {} }) };
  const session = { owner: () => null, ended: () => false, writer: () => false, state: () => 'confirmed', decide: async () => {} };
  window.synToolbar = KinViewerUXToolbar.mount({ services: window.synServices, session });
}"""

MENU = "() => [...document.querySelectorAll('.kin-ux-more [data-tool]')].map(n => [n.dataset.tool, n.getAttribute('aria-label'), n.disabled])"

# The clipboard image as RGBA samples at CSS points scaled by the image's own density.
CLIPBOARD = """async points => {
  const items = await navigator.clipboard.read();
  const blob = await items[0].getType('image/png');
  const bitmap = await createImageBitmap(blob);
  const c = document.createElement('canvas'); c.width = bitmap.width; c.height = bitmap.height;
  const x = c.getContext('2d'); x.drawImage(bitmap, 0, 0);
  const scale = bitmap.width / points.width;
  const at = ([px, py]) => [...x.getImageData(Math.round(px * scale), Math.round(py * scale), 1, 1).data].slice(0, 3);
  const region = ([l, t, w, h]) => { const d = x.getImageData(l * scale, t * scale, w * scale, h * scale).data; const seen = new Set();
    for (let i = 0; i < d.length; i += 4) seen.add(d[i] + ',' + d[i + 1] + ',' + d[i + 2]); return [...seen]; };
  return { width: bitmap.width, height: bitmap.height, type: blob.type,
    samples: points.samples.map(at), regions: (points.regions || []).map(region) };
}"""


def near(rgb, expected, tolerance=40):
    return all(abs(a - b) <= tolerance for a, b in zip(rgb, expected))


class ViewerExportDOMTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.pw = sync_playwright().start()
        cls.browser = cls.pw.chromium.launch()

    @classmethod
    def tearDownClass(cls):
        cls.browser.close(); cls.pw.stop()

    def open(self, setup=SETUP, before=None, scale=1):
        context = self.browser.new_context(viewport={'width': 900, 'height': 700}, accept_downloads=True, device_scale_factor=scale)
        context.grant_permissions(['clipboard-read', 'clipboard-write'], origin=ORIGIN)
        page = context.new_page(); errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.route(ORIGIN + "/", lambda route: route.fulfill(body=HARNESS, content_type="text/html"))
        page.goto(ORIGIN + "/")
        for name in ["viewer-ux-shortcuts.js", "viewer-export.js", "viewer-ux-toolbar.js"]:
            page.add_script_tag(path=str(HPACS / name))
        if before: page.evaluate(before)
        page.evaluate(setup)
        self.addCleanup(context.close)
        self.addCleanup(lambda: self.assertEqual([], errors))
        return page

    def click(self, page, tool):
        page.evaluate("tool => document.querySelector('.kin-ux-toolbar [data-tool=\"' + tool + '\"]').click()", tool)

    # ── The toolbar: after Capture, only beside Capture, with Capture's availability and the busy guard ──
    def test_01_export_actions_stand_after_capture_in_more(self):
        page = self.open()
        menu = page.evaluate(MENU)
        ids = [tool for tool, _, _ in menu]
        self.assertEqual(['Capture', 'CopyImage', 'CopyScreen'], ids[:3], menu)
        self.assertEqual([['CopyImage', 'Copy Image', False], ['CopyScreen', 'Copy Screen', False]], [m for m in menu if m[0].startswith('Copy')])
        bar = page.evaluate("() => [...document.querySelectorAll('.kin-ux-tools-bar [data-tool]')].map(n => n.dataset.tool)")
        self.assertEqual(['WindowLevel', 'Zoom', 'Pointer'], bar, 'the frequent bar holds no export action')
        title = page.locator('.kin-ux-more [data-tool="CopyImage"]').get_attribute('title')
        self.assertIn('클립보드', title); self.assertIn('식별정보가 포함될 수 있습니다', title)

    def test_02_no_capture_no_export_and_disabled_capture_disables_them(self):
        page = self.open(before="() => {}")
        page.evaluate("() => { window.synSection = ['WindowLevel', 'Zoom']; delete window.synButtons.Capture; synServices.toolbarService.changed(); }")
        page.wait_for_function("() => !document.querySelector('.kin-ux-toolbar [data-tool=\"Capture\"]')")
        self.assertEqual([], [m for m in page.evaluate(MENU) if m[0].startswith('Copy')], 'a document without Capture gets no export')
        page = self.open()
        page.evaluate("() => { synDisabled.add('Capture'); synServices.toolbarService.changed(); }")
        page.wait_for_function("() => document.querySelector('.kin-ux-toolbar [data-tool=\"Capture\"]').disabled")
        self.assertEqual([True, True], page.evaluate("() => ['CopyImage', 'CopyScreen'].map(id => document.querySelector('.kin-ux-toolbar [data-tool=\"' + id + '\"]').disabled)"))

    def test_03_busy_workspace_does_not_run_an_export_and_no_viewer_command_is_recorded(self):
        page = self.open()
        page.evaluate("async () => { synBusy = true; await navigator.clipboard.writeText('SYN before'); }")
        self.click(page, 'CopyImage')
        page.wait_for_timeout(300)
        self.assertEqual('SYN before', page.evaluate("() => navigator.clipboard.readText()"))
        page.evaluate("() => { synBusy = false; }")
        self.click(page, 'CopyImage')
        page.wait_for_function("() => synNotes.some(n => n.type === 'success')")
        self.assertEqual([], page.evaluate("() => synInteractions"), 'export runs in the page, not as a viewer command')

    def test_04_on_off_items_of_the_stock_menu_show_whether_they_are_on(self):
        # The stock viewer marks an on/off item only with its "on" text class (a selected tool reports isActive).
        # Reference Lines starts on there, so the menu must say so before the first press turns it off.
        page = self.open()
        page.evaluate("""() => {
          const ON = '!text-primary-active', OFF = '!text-common-bright hover:!bg-primary-dark hover:text-primary-light';
          window.synClass = { ReferenceLines: ON, ImageOverlayViewer: OFF };
          synButtons.MoreTools = { id: 'MoreTools', uiType: 'ohif.splitButton', props: { groupId: 'MoreTools', items: [
            { id: 'ReferenceLines', label: 'Reference Lines', commands: 'toggleEnabledDisabledToolbar' },
            { id: 'ImageOverlayViewer', label: 'Image Overlay', commands: 'toggleEnabledDisabledToolbar' },
            { id: 'Reset', label: 'Reset View', commands: 'resetViewport' }] } };
          synSection.push('MoreTools');
          const stock = synServices.toolbarService.getButtonProps;
          synServices.toolbarService.getButtonProps = id => {
            const item = synButtons.MoreTools.props.items.find(x => x.id === id);
            return item ? { ...item, disabled: false, className: synClass[id] || '', isActive: undefined } : stock(id);
          };
          // Like the stock service: the state after a command is evaluated for the cell the caller names, and
          // with no cell the stock evaluators return nothing (no class, no isActive).
          window.synCells = [];
          synServices.toolbarService.recordInteraction = (item, options) => {
            synInteractions.push(item.itemId); synCells.push(options?.refreshProps?.viewportId ?? null);
            if (synClass[item.itemId]) synClass[item.itemId] = options?.refreshProps?.viewportId ? (synClass[item.itemId] === ON ? OFF : ON) : '';
            synServices.toolbarService.changed();
          };
          synServices.toolbarService.changed();
        }""")
        pressed = "id => document.querySelector('.kin-ux-toolbar [data-tool=\"' + id + '\"]')?.getAttribute('aria-pressed') ?? null"
        page.wait_for_function("() => !!document.querySelector('.kin-ux-more [data-tool=\"ReferenceLines\"]')")
        self.assertEqual(['true', 'false', None], [page.evaluate(pressed, tool) for tool in ['ReferenceLines', 'ImageOverlayViewer', 'Reset']])
        self.click(page, 'ReferenceLines')
        page.wait_for_function("() => document.querySelector('.kin-ux-toolbar [data-tool=\"ReferenceLines\"]').getAttribute('aria-pressed') === 'false'")
        self.click(page, 'ImageOverlayViewer')
        page.wait_for_function("() => document.querySelector('.kin-ux-toolbar [data-tool=\"ImageOverlayViewer\"]').getAttribute('aria-pressed') === 'true'")
        self.assertEqual(['ReferenceLines', 'ImageOverlayViewer'], page.evaluate("() => synInteractions"))
        self.assertEqual(['left', 'left'], page.evaluate("() => synCells"), 'each command names the active cell for the state that follows it')
        # A selected tool keeps the state the viewer reports for it.
        self.assertEqual(None, page.evaluate(pressed, 'WindowLevel'))

    # ── Copy: the selected cell or the whole screen as seen ──
    def test_10_copy_image_puts_the_selected_cell_as_seen_on_the_clipboard(self):
        page = self.open()
        self.click(page, 'CopyImage')
        page.wait_for_function("() => synNotes.length")
        self.assertEqual('success', page.evaluate("() => synNotes.at(-1).type"), page.evaluate("() => synNotes"))
        got = page.evaluate(CLIPBOARD, {'width': 200, 'samples': [[150, 130], [100, 100], [10 + 15 * 1 + 5, 55]],
                                        'regions': [[4, 4, 120, 30], [160, 115, 38, 33]]})
        self.assertEqual('image/png', got['type'])
        self.assertEqual((400, 300), (got['width'], got['height']), 'the image keeps the canvas pixel density')
        image, line, frame = got['samples']
        self.assertTrue(near(image, (200, 0, 0)), image)
        self.assertTrue(near(line, (0, 255, 0)), 'the measurement layer is in the copy: %s' % line)
        self.assertTrue(near(frame, (255, 255, 255)), 'the shown frame: %s' % frame)
        text, action = got['regions']
        self.assertTrue(any(near(tuple(map(int, rgb.split(','))), (255, 255, 0), 60) for rgb in text), 'the image text is in the copy')
        self.assertFalse(any(near(tuple(map(int, rgb.split(','))), (255, 0, 255), 60) for rgb in action), 'control text is not image text')

    def test_10b_the_measure_menu_layer_is_in_the_copy(self):
        # The Measure menu draws its marks (a Spine Label's dot and name) in its own layer over the cell, not in svg.svg-layer.
        page = self.open()
        page.evaluate("""() => { const pane = document.querySelector('[data-cy=viewport-pane]');
          const layer = document.createElement('div'); layer.className = 'kin-ux-cell-layer';
          layer.style.cssText = 'position:absolute;inset:0;pointer-events:none'; pane.append(layer);
          const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); svg.dataset.kinMeasureLayer = 'left';
          svg.setAttribute('width', '100%'); svg.setAttribute('height', '100%'); svg.setAttribute('style', 'position:absolute;inset:0;overflow:visible;pointer-events:none');
          const dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
          for (const [k, v] of Object.entries({ cx: 60, cy: 30, r: 8, fill: 'rgb(255, 128, 0)' })) dot.setAttribute(k, v);
          const name = document.createElementNS('http://www.w3.org/2000/svg', 'text'); name.textContent = 'L4-5';
          for (const [k, v] of Object.entries({ x: 72, y: 36, fill: 'rgb(255, 128, 0)', style: 'font:700 14px sans-serif' })) name.setAttribute(k, v);
          // Editing aids: the handle of a mark that may be moved, and a point of a mark still being made.
          const handle = document.createElementNS('http://www.w3.org/2000/svg', 'circle'); handle.dataset.kinHandle = 'syn';
          for (const [k, v] of Object.entries({ cx: 130, cy: 30, r: 8, fill: 'transparent', stroke: 'rgb(255, 0, 255)', 'stroke-width': 6 })) handle.setAttribute(k, v);
          const pending = document.createElementNS('http://www.w3.org/2000/svg', 'g'); pending.dataset.kinPending = '';
          const cross = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
          for (const [k, v] of Object.entries({ x: 160, y: 20, width: 20, height: 20, fill: 'rgb(255, 0, 255)' })) cross.setAttribute(k, v);
          pending.append(cross);
          svg.append(dot, name, handle, pending); layer.append(svg); }""")
        on_screen = page.evaluate("() => document.querySelectorAll('[data-kin-measure-layer] [data-kin-handle], [data-kin-measure-layer] [data-kin-pending]').length")
        self.assertEqual(2, on_screen)
        self.click(page, 'CopyImage')
        page.wait_for_function("() => synNotes.length")
        self.assertEqual('success', page.evaluate("() => synNotes.at(-1).type"), page.evaluate("() => synNotes"))
        got = page.evaluate(CLIPBOARD, {'width': 200, 'samples': [[60, 30], [150, 130], [138, 30], [170, 30]], 'regions': [[72, 22, 40, 16]]})
        dot, image, handle, pending = got['samples']
        self.assertTrue(near(dot, (255, 128, 0)), 'the Measure menu mark is in the copy: %s' % dot)
        self.assertTrue(near(image, (200, 0, 0)), image)
        self.assertTrue(any(near(tuple(map(int, rgb.split(','))), (255, 128, 0), 60) for rgb in got['regions'][0]), 'the label name is in the copy')
        self.assertTrue(near(handle, (200, 0, 0)), 'a mark handle is not in the copy: %s' % handle)
        self.assertTrue(near(pending, (200, 0, 0)), 'a point of an unfinished mark is not in the copy: %s' % pending)
        # The page itself keeps them.
        self.assertEqual(2, page.evaluate("() => document.querySelectorAll('[data-kin-measure-layer] [data-kin-handle], [data-kin-measure-layer] [data-kin-pending]').length"))

    def test_11_hidden_image_text_is_not_copied(self):
        page = self.open()
        page.evaluate("() => document.querySelectorAll('.overlay').forEach(n => { n.style.display = 'none'; })")
        self.click(page, 'CopyImage')
        page.wait_for_function("() => synNotes.length")
        got = page.evaluate(CLIPBOARD, {'width': 200, 'samples': [], 'regions': [[4, 4, 120, 30]]})
        self.assertFalse(any(near(tuple(map(int, rgb.split(','))), (255, 255, 0), 60) for rgb in got['regions'][0]))

    def test_12_copy_screen_puts_every_cell_in_one_image(self):
        page = self.open()
        self.click(page, 'CopyScreen')
        page.wait_for_function("() => synNotes.length")
        got = page.evaluate(CLIPBOARD, {'width': 400, 'samples': [[150, 130], [350, 130]]})
        self.assertEqual((800, 300), (got['width'], got['height']))
        self.assertTrue(near(got['samples'][0], (200, 0, 0)), got)
        self.assertTrue(near(got['samples'][1], (0, 0, 200)), got)

    def test_14_a_cell_replaced_while_the_copy_is_drawn_writes_nothing(self):
        page = self.open(before="""() => { const decode = Image.prototype.decode;
          Image.prototype.decode = function () { return new Promise(r => setTimeout(r, 200)).then(() => decode.call(this)); }; }""")
        page.evaluate("async () => { await navigator.clipboard.writeText('SYN before'); }")
        # Another study arrives in the same cell (A -> B) while the measurement layer is being drawn.
        self.click(page, 'CopyImage')
        page.evaluate("() => { const v = synViewports.get('left'); synViewports.set('left', { ...v, getImageIds: () => ['syn:other:0'] }); }")
        page.wait_for_function("() => synNotes.length")
        self.assertEqual(['error'], page.evaluate("() => synNotes.map(n => n.type)"))
        self.assertIn('바뀌어', page.evaluate("() => synNotes[0].message"))
        self.assertEqual('SYN before', page.evaluate("() => navigator.clipboard.readText()"))

    def test_15_a_viewer_ending_while_the_png_is_encoded_writes_nothing(self):
        page = self.open(before="""() => { const toBlob = HTMLCanvasElement.prototype.toBlob;
          HTMLCanvasElement.prototype.toBlob = function (...args) { setTimeout(() => toBlob.apply(this, args), 300); }; }""")
        page.evaluate("async () => { await navigator.clipboard.writeText('SYN before'); }")
        self.click(page, 'CopyImage')
        page.wait_for_timeout(100)
        page.evaluate("() => synToolbar.dispose()")
        page.wait_for_function("() => synNotes.length")
        self.assertEqual(['error'], page.evaluate("() => synNotes.map(n => n.type)"))
        self.assertEqual('SYN before', page.evaluate("() => navigator.clipboard.readText()"))

    def test_16_a_cell_that_shows_another_series_and_comes_back_is_not_the_same_cell(self):
        page = self.open(before="""() => { const decode = Image.prototype.decode;
          Image.prototype.decode = function () { return new Promise(r => setTimeout(r, 300)).then(() => decode.call(this)); }; }""")
        page.evaluate("async () => { await navigator.clipboard.writeText('SYN before'); }")
        self.click(page, 'CopyImage')
        # A -> B -> A in the same viewport while the copy is drawn: the native viewport announces each new stack.
        page.evaluate("""() => { const v = synViewports.get('left'), ids = v.getImageIds;
          v.getImageIds = () => ['syn:other:0']; v.element.dispatchEvent(new CustomEvent('CORNERSTONE_STACK_NEW_STACK'));
          v.getImageIds = ids; v.element.dispatchEvent(new CustomEvent('CORNERSTONE_STACK_NEW_STACK')); }""")
        page.wait_for_function("() => synNotes.length")
        self.assertEqual(['error'], page.evaluate("() => synNotes.map(n => n.type)"))
        self.assertEqual('SYN before', page.evaluate("() => navigator.clipboard.readText()"))

    def test_17_wrapped_clipped_and_boxed_image_text_keeps_its_place(self):
        page = self.open()
        # Three lines of image text on a dark blue box, and a narrow clipping box whose overflow is hidden on screen.
        page.evaluate("""() => { const pane = document.querySelector('[data-cy=viewport-pane]');
          pane.querySelector('.overlay').remove();
          const lines = document.createElement('div'); lines.textContent = 'AAAA\\nBBBB\\nCCCC';
          lines.style.cssText = 'position:absolute;left:4px;top:4px;white-space:pre-line;line-height:30px;font:bold 26px sans-serif;color:rgb(255,255,0);background:rgb(0,0,128)';
          const clip = document.createElement('div'); clip.textContent = 'WWWWWWWWWWWW';
          clip.style.cssText = 'position:absolute;left:120px;top:4px;width:40px;overflow:hidden;white-space:nowrap;font:bold 26px sans-serif;color:rgb(255,255,0)';
          pane.append(lines, clip); }""")
        self.click(page, 'CopyImage')
        page.wait_for_function("() => synNotes.length")
        got = page.evaluate(CLIPBOARD, {'width': 200, 'samples': [[2 + 1, 50]],
                                        'regions': [[4, 4, 70, 30], [4, 34, 70, 30], [4, 64, 70, 30], [120, 4, 40, 30], [162, 4, 36, 30]]})
        yellow = lambda region: any(near(tuple(map(int, rgb.split(','))), (255, 255, 0), 60) for rgb in region)
        navy = lambda region: any(near(tuple(map(int, rgb.split(','))), (0, 0, 128), 30) for rgb in region)
        first, second, third, clipped, beyond = got['regions']
        self.assertTrue(yellow(first) and yellow(second) and yellow(third), 'each of the three lines is on its own line')
        self.assertTrue(navy(second), 'the box behind the text keeps its background')
        self.assertTrue(yellow(clipped)); self.assertFalse(yellow(beyond), 'text clipped on screen is clipped in the copy')

    # The clipboard image as PNG bytes.
    CLIPBOARD_BYTES = """async () => { const items = await navigator.clipboard.read(); const blob = await items[0].getType('image/png');
      return await new Promise(r => { const f = new FileReader(); f.onload = () => r(f.result.split(',')[1]); f.readAsDataURL(blob); }); }"""

    def text_overlap(self, page, names):
        """Image text of each name on screen against the copy: overlap (IoU) of their yellow text pixels."""
        import base64
        from io import BytesIO
        from PIL import Image
        page.evaluate("""names => { const pane = document.querySelector('[data-cy=viewport-pane]'); pane.querySelector('.overlay').remove();
          names.forEach((name, i) => { const n = document.createElement('div'); n.textContent = name; n.dir = i ? 'rtl' : 'ltr';
            n.style.cssText = 'position:absolute;left:4px;width:190px;top:' + (6 + 40 * i) + 'px;font:26px sans-serif;color:rgb(255,255,0);text-align:' + (i ? 'right' : 'left');
            pane.append(n); }); }""", names)
        # Screen and copy at the same density (device scale 2, canvas density 2): no resampling between them.
        shot = Image.open(BytesIO(page.screenshot(clip={'x': 0, 'y': 60, 'width': 200, 'height': 150}, scale='device'))).convert('RGB')
        self.click(page, 'CopyImage')
        page.wait_for_function("() => synNotes.some(n => n.type === 'success')")
        copied = Image.open(BytesIO(base64.b64decode(page.evaluate(self.CLIPBOARD_BYTES)))).convert('RGB')
        self.assertEqual(shot.size, copied.size)
        text = lambda rgb: rgb[0] > 170 and rgb[1] > 170 and rgb[2] < 120
        overlaps = []
        for i in range(len(names)):
            box = [(x, y) for x in range(400) for y in range(12 + 80 * i, 80 + 80 * i)]
            a = {p for p in box if text(shot.getpixel(p))}; b = {p for p in box if text(copied.getpixel(p))}
            overlaps.append(len(a & b) / max(1, len(a | b)))
        return overlaps

    def test_18_decomposed_korean_and_joined_arabic_names_are_drawn_as_on_screen(self):
        import unicodedata
        page = self.open(scale=2)
        overlaps = self.text_overlap(page, [unicodedata.normalize('NFD', '홍길동 환자'), 'محمد أحمد'])
        # Same density, same place: the copy's text pixels are the screen's (per-character drawing scored 0.47 and 0.34).
        for overlap in overlaps: self.assertGreater(overlap, 0.9, overlaps)

    def test_13_no_clipboard_or_no_cell_says_so(self):
        page = self.open(before="() => { Object.defineProperty(window, 'ClipboardItem', { value: undefined }); }")
        self.click(page, 'CopyImage')
        self.assertEqual(['error'], page.evaluate("() => synNotes.map(n => n.type)"))
        page = self.open()
        page.evaluate("() => synServices.viewportGridService.setActive('missing')")
        self.click(page, 'CopyImage')
        self.assertEqual(['warning'], page.evaluate("() => synNotes.map(n => n.type)"))

    # ── Save JPEG: one image; Save Series JPEG: every image of the series as JPEG in one ZIP ──
    STATUS = "() => document.querySelector('.kin-ux-toolbar-settings [role=status]').textContent"
    TEXT_COLOURS = [(0, 255, 255), (255, 255, 0), (255, 128, 0), (128, 255, 128)]

    def downloads(self, page):
        seen = []; page.on('download', lambda download: seen.append(download)); return seen

    def image(self, data):
        from io import BytesIO
        from PIL import Image
        bitmap = Image.open(BytesIO(data)); bitmap.load(); return bitmap

    def assert_frame(self, bitmap, index, colour=(200, 0, 0)):
        rgb = bitmap.convert('RGB')
        self.assertTrue(near(rgb.getpixel((300, 260)), colour), 'the image: %s' % (rgb.getpixel((300, 260)),))
        self.assertTrue(near(rgb.getpixel(((10 + 15 * index + 5) * 2, 55 * 2)), (255, 255, 255)), 'image %d is drawn' % index)
        for other in range(4):
            if other != index:
                self.assertFalse(near(rgb.getpixel(((10 + 15 * other + 5) * 2, 55 * 2)), (255, 255, 255)), 'only image %d' % index)
        text = {rgb.getpixel((x, y)) for x in range(8, 240, 2) for y in range(8, 68, 2)}
        self.assertTrue(any(near(c, self.TEXT_COLOURS[index], 60) for c in text), 'the image text of image %d is drawn' % index)

    def test_20_save_jpeg_downloads_the_cell_as_a_real_jpeg(self):
        page = self.open()
        with page.expect_download() as saved:
            self.click(page, 'SaveJPEG')
        path = saved.value.path(); data = Path(path).read_bytes()
        self.assertRegex(saved.value.suggested_filename, r'^image-\d{8}-\d{6}\.jpg$')
        self.assertEqual(b'\xff\xd8\xff', data[:3])
        bitmap = self.image(data)
        self.assertEqual(('JPEG', (400, 300)), (bitmap.format, bitmap.size))
        self.assert_frame(bitmap, 1)
        self.assertTrue(near(bitmap.convert('RGB').getpixel((200, 200)), (0, 255, 0)), 'the measurement layer')

    def test_21_save_series_jpeg_writes_every_image_in_order_and_returns_to_the_shown_one(self):
        import zipfile
        from io import BytesIO
        page = self.open()
        page.evaluate("() => { window.synSaid = []; new MutationObserver(() => synSaid.push(document.querySelector('.kin-ux-toolbar-settings [role=status]').textContent)).observe(document.querySelector('.kin-ux-toolbar-settings'), { subtree: true, childList: true, characterData: true }); }")
        before = page.evaluate(self.STATUS)
        with page.expect_download() as saved:
            self.click(page, 'SaveSeriesJPEG')
        self.assertRegex(saved.value.suggested_filename, r'^series-7-\d{8}-\d{6}\.zip$')
        archive = zipfile.ZipFile(BytesIO(Path(saved.value.path()).read_bytes()))
        self.assertIsNone(archive.testzip())
        self.assertEqual(['image-0001.jpg', 'image-0002.jpg', 'image-0003.jpg', 'image-0004.jpg'], archive.namelist())
        for index, name in enumerate(archive.namelist()):
            bitmap = self.image(archive.read(name))
            self.assertEqual(('JPEG', (400, 300)), (bitmap.format, bitmap.size))
            self.assert_frame(bitmap, index)
        page.wait_for_function("() => synViewports.get('left').getCurrentImageIdIndex() === 1")
        page.wait_for_function("before => document.querySelector('.kin-ux-toolbar-settings [role=status]').textContent === before", arg=before)
        self.assertIn('JPEG 만드는 중 4/4 · Esc로 멈춤', page.evaluate("() => synSaid"))
        self.assertEqual('success', page.evaluate("() => synNotes.at(-1).type"))

    def slow(self, page, ms=150, seen=False):
        # Images of the left cell take `ms` to load: the ones not loaded before, or (seen) every one.
        page.evaluate("([ms, all]) => { window.synLoadMs = (id, index, seen) => id === 'left' && (all || !seen) ? ms : 5; }", [ms, seen])

    def said(self, page, text):
        page.wait_for_function("text => document.querySelector('.kin-ux-toolbar-settings [role=status]').textContent.includes(text)", arg=text, timeout=60000)

    # What the left cell is on: its image number and the image it holds and has drawn (the bright square or bits).
    SHOWN = """() => { const v = synViewports.get('left'), c = v.canvas.getContext('2d');
      const bright = (x, y) => { const d = c.getImageData(x * 2, y * 2, 1, 1).data; return d[0] > 190 && d[1] > 190 && d[2] > 190; };
      let painted = -1;
      if (window.synBits) { painted = 0; for (let bit = 0; bit < 6; bit++) if (bright(10 + 22 * bit + 7, 122)) painted |= 1 << bit; }
      else for (let k = 0; k < 4; k++) if (bright(10 + 15 * k + 5, 55)) painted = k;
      return [v.getCurrentImageIdIndex(), v.getCornerstoneImage().imageId, painted]; }"""

    def test_22_escape_stops_without_a_file_and_returns_to_the_shown_image(self):
        page = self.open(); seen = self.downloads(page); self.slow(page)
        self.click(page, 'SaveSeriesJPEG')
        self.said(page, '3/4')
        page.keyboard.press('Escape')
        page.wait_for_function("() => synNotes.length")
        self.assertEqual(['warning'], page.evaluate("() => synNotes.map(n => n.type)"))
        self.assertIn('멈췄습니다', page.evaluate("() => synNotes[0].message"))
        # When it says so the cell is back on the reader's image: its number, the image held and the pixels drawn.
        self.assertEqual([1, 'syn:left:1', 1], page.evaluate(self.SHOWN))
        page.wait_for_timeout(400); self.assertEqual([], seen)
        self.assertEqual([1, 'syn:left:1', 1], page.evaluate(self.SHOWN), 'the image that was loading when it stopped does not arrive afterwards')
        # The next export starts and is whole.
        page.evaluate("() => { synNotes.length = 0; }")
        with page.expect_download() as saved:
            self.click(page, 'SaveSeriesJPEG')
        self.assertEqual(4, len(self.archive(saved.value).namelist()))

    def archive(self, download):
        import zipfile
        from io import BytesIO
        return zipfile.ZipFile(BytesIO(Path(download.path()).read_bytes()))

    def test_23_the_reader_moving_the_image_stops_it_and_is_not_undone(self):
        page = self.open(); seen = self.downloads(page); self.slow(page)
        self.click(page, 'SaveSeriesJPEG')
        # The reader goes back to the first image while the export is showing the third.
        self.said(page, '3/4')
        page.evaluate("() => { synViewports.get('left').setImageIdIndex(0); window.synAfter = synRequests.length; }")
        page.wait_for_function("() => synNotes.length")
        self.assertIn('바뀌어', page.evaluate("() => synNotes[0].message"))
        page.wait_for_timeout(500)
        self.assertEqual([0, 'syn:left:0', 0], page.evaluate(self.SHOWN))
        self.assertEqual([], page.evaluate("() => synRequests.slice(synAfter)"), 'the export asks the cell for nothing after the reader did')
        self.assertEqual([], seen)

    def test_24_another_series_in_the_cell_stops_it_and_nothing_is_restored_onto_it(self):
        page = self.open(); seen = self.downloads(page); self.slow(page)
        self.click(page, 'SaveSeriesJPEG')
        self.said(page, '3/4')
        page.evaluate("""() => { const v = synViewports.get('left'); window.synMoved = [];
          synViewports.set('left', { ...v, getImageIds: () => ['syn:other:0', 'syn:other:1'], getCurrentImageIdIndex: () => 0,
            setImageIdIndex: async value => { synMoved.push(value); } }); }""")
        page.wait_for_function("() => synNotes.length")
        page.wait_for_timeout(500)
        self.assertEqual([], page.evaluate("() => synMoved"), 'the other series is not moved')
        self.assertEqual([], seen)

    def test_25_playing_cine_or_a_running_export_refuses_to_start(self):
        page = self.open(); seen = self.downloads(page)
        page.evaluate("() => { synServices.cineService.getState = () => ({ cines: { left: { isPlaying: true } } }); }")
        self.click(page, 'SaveSeriesJPEG')
        self.assertIn('Cine', page.evaluate("() => synNotes.at(-1).message"))
        page.evaluate("() => { synServices.cineService.getState = () => ({ cines: {} }); synNotes.length = 0; }")
        self.slow(page)
        self.click(page, 'SaveSeriesJPEG'); self.click(page, 'SaveSeriesJPEG')
        self.assertIn('진행 중', page.evaluate("() => synNotes.at(-1).message"))
        page.wait_for_function("() => synNotes.some(n => n.type === 'success')")
        page.wait_for_timeout(200); self.assertEqual(1, len(seen))

    def test_27_an_unrelated_draw_does_not_end_the_wait_and_a_stopped_load_does_not_arrive_later(self):
        page = self.open(); seen = self.downloads(page); self.slow(page, 300)
        self.click(page, 'SaveSeriesJPEG')
        self.said(page, '1/4')
        # Another draw of the cell (still showing image 2 of 4) arrives while image 1 loads, then the reader presses Esc.
        page.evaluate("() => synViewports.get('left').render()")
        page.wait_for_timeout(60)
        self.assertEqual([], page.evaluate("() => synNotes"), 'the draw of the image before did not end the wait')
        page.keyboard.press('Escape')
        page.wait_for_function("() => synNotes.length")
        self.assertIn('멈췄습니다', page.evaluate("() => synNotes[0].message"))
        self.assertEqual([1, 'syn:left:1', 1], page.evaluate(self.SHOWN))
        page.wait_for_timeout(900)
        self.assertEqual([1, 'syn:left:1', 1], page.evaluate(self.SHOWN), 'the load that was stopped does not move the image when it arrives')
        self.assertEqual([], seen)

    def test_27b_an_unrelated_draw_while_an_image_loads_neither_stops_nor_shifts_the_series(self):
        page = self.open(); self.slow(page, 300)
        with page.expect_download() as saved:
            self.click(page, 'SaveSeriesJPEG')
            self.said(page, '1/4')
            page.evaluate("() => synViewports.get('left').render()")
        archive = self.archive(saved.value)
        self.assertEqual(4, len(archive.namelist()))
        for index, name in enumerate(archive.namelist()):
            self.assert_frame(self.image(archive.read(name)), index)

    def test_27c_a_load_that_arrives_after_the_timeout_moves_nothing_and_holds_nothing_up(self):
        # The first image's load times out (0.2 s here) and arrives at 1.5 s: the export goes back at the timeout and says
        # so, the late image does not replace the reader's, and the next export can start.
        page = self.open(); seen = self.downloads(page); self.slow(page, 1500)
        page.evaluate("() => { KinViewerExport.options.loadTimeout = 200; }")
        self.click(page, 'SaveSeriesJPEG')
        page.wait_for_function("() => synNotes.length", timeout=15000)
        self.assertIn('불러오지 못해', page.evaluate("() => synNotes[0].message"))
        self.assertEqual([1, 'syn:left:1', 1], page.evaluate(self.SHOWN), 'back on the shown image when it says so')
        page.wait_for_timeout(2500)
        self.assertEqual([1, 'syn:left:1', 1], page.evaluate(self.SHOWN), 'nothing moves it afterwards')
        self.assertEqual([], seen)
        self.click(page, 'SaveSeriesJPEG')
        self.assertNotIn('진행 중', page.evaluate("() => synNotes.at(-1).message"), 'the export was released')

    def returning(self, page):
        # The export has asked for the last image and then for the image the reader was on.
        page.wait_for_function("() => synRequests.length >= 2 && synRequests.at(-1)[1] === 1 && synRequests.at(-2)[1] === 3", timeout=60000)

    def test_28_escape_or_a_viewer_ending_while_it_returns_writes_nothing(self):
        for stop in ["() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))", "() => synToolbar.dispose()"]:
            page = self.open(); seen = self.downloads(page); self.slow(page, 300, seen=True)
            self.click(page, 'SaveSeriesJPEG')
            self.returning(page)
            page.evaluate(stop)
            page.wait_for_function("() => synNotes.length")
            page.wait_for_timeout(700)
            self.assertEqual([], seen, stop)
            self.assertNotEqual('success', page.evaluate("() => synNotes.at(-1).type"), stop)

    def test_29_a_failed_return_writes_nothing_and_says_so(self):
        # Four images are shown (requests 0, 1, 2, 3); the fifth request, back to image 2 of 4, is refused by the viewport.
        page = self.open(); seen = self.downloads(page)
        page.evaluate("""() => { const v = synViewports.get('left'), set = v.setImageIdIndex.bind(v); let calls = 0;
          v.setImageIdIndex = value => ++calls > 4 ? Promise.reject(new Error('load failed')) : set(value); }""")
        self.click(page, 'SaveSeriesJPEG')
        page.wait_for_function("() => synNotes.length")
        self.assertEqual('error', page.evaluate("() => synNotes.at(-1).type"))
        self.assertIn('돌아가지 못해', page.evaluate("() => synNotes.at(-1).message"))
        page.wait_for_timeout(300); self.assertEqual([], seen)

    def test_26_volume_cells_are_refused_for_series(self):
        page = self.open()
        page.evaluate("() => { synViewports.get('left').type = 'orthographic'; }")
        self.click(page, 'SaveSeriesJPEG')
        self.assertIn('2D', page.evaluate("() => synNotes.at(-1).message"))

    # ── Save Video: the series as a video, played back frame by frame ──
    # Plays the downloaded file in the page and reads which image (bright square) each presented frame shows.
    PLAYED = """async b64 => {
      const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
      const video = document.createElement('video'); video.muted = true; video.src = URL.createObjectURL(new Blob([bytes]));
      document.body.append(video);
      await new Promise((resolve, reject) => { video.onloadeddata = resolve; video.onerror = () => reject(new Error('not playable')); });
      const c = document.createElement('canvas'); c.width = video.videoWidth; c.height = video.videoHeight;
      const x = c.getContext('2d', { willReadFrequently: true });
      const shown = () => { x.drawImage(video, 0, 0);
        for (let k = 0; k < 4; k++) { const d = x.getImageData(Math.round((10 + 15 * k + 5) * 2 * c.width / 400), Math.round(110 * c.height / 300), 1, 1).data;
          if (d[0] > 190 && d[1] > 190 && d[2] > 190) return k; } return -1; };
      // Seek, paused, to each sample time; the recorder's WebM has no index, so the end is found by seeking far.
      // After the seek, wait until the frame at that time is presented (a fallback timer for a frame already shown).
      const seek = time => new Promise(resolve => { video.onseeked = () => { video.requestVideoFrameCallback(() => resolve()); setTimeout(resolve, 250); }; video.currentTime = time; });
      await seek(1e6); const end = video.currentTime; const seen = [];
      for (let time = 0.05; time < end; time += 0.1) { await seek(time); seen.push([Math.round(time * 100) / 100, shown()]); }
      return { width: c.width, height: c.height, seen, end };
    }"""

    def test_30_save_video_plays_every_image_in_order_at_the_cine_speed(self):
        import base64
        page = self.open()
        page.evaluate("() => { synServices.cineService.getState = () => ({ cines: { left: { isPlaying: false, frameRate: 5 } } }); }")
        with page.expect_download(timeout=30000) as saved:
            self.click(page, 'SaveVideo')
        name, data = saved.value.suggested_filename, Path(saved.value.path()).read_bytes()
        self.assertRegex(name, r'^series-7-\d{8}-\d{6}\.(mp4|webm)$')
        if name.endswith('.webm'): self.assertEqual(b'\x1a\x45\xdf\xa3', data[:4])
        else: self.assertEqual(b'ftyp', data[4:8])
        played = page.evaluate(self.PLAYED, base64.b64encode(data).decode())
        self.assertEqual((400, 300), (played['width'], played['height']))
        order, first = [], {}
        for time, image in played['seen']:
            if image < 0: continue
            if not order or order[-1] != image: order.append(image)
            first.setdefault(image, time)
        self.assertEqual([0, 1, 2, 3], order, played['seen'])
        for image in range(4):
            self.assertAlmostEqual(image / 5, first[image], delta=0.12, msg='5 fps: %s' % played['seen'])
        self.assertAlmostEqual(4 / 5, played['end'], delta=0.12, msg='the last image keeps its 1/5 s: %s' % played)
        page.wait_for_function("() => synViewports.get('left').getCurrentImageIdIndex() === 1")
        self.assertEqual('success', page.evaluate("() => synNotes.at(-1).type"))
        self.assertIn('5 fps', page.evaluate("() => synNotes.at(-1).message"))

    def test_31_escape_while_the_file_is_made_writes_no_file(self):
        page = self.open(before="""() => { const decode = window.createImageBitmap;
          window.createImageBitmap = (...args) => new Promise(r => setTimeout(r, 300)).then(() => decode(...args)); }""")
        seen = self.downloads(page)
        self.click(page, 'SaveVideo')
        page.wait_for_function("() => document.querySelector('.kin-ux-toolbar-settings [role=status]').textContent.includes('동영상 파일 만드는 중 2/4')")
        page.keyboard.press('Escape')
        page.wait_for_function("() => synNotes.length")
        self.assertIn('멈췄습니다', page.evaluate("() => synNotes[0].message"))
        page.wait_for_timeout(1500); self.assertEqual([], seen)
        self.assertEqual(1, page.evaluate("() => synViewports.get('left').getCurrentImageIdIndex()"))

    def test_33_an_image_slow_to_decode_neither_fails_nor_shifts_the_timing(self):
        import base64
        # At 5 fps the second image starts 0.2 s after the first; its decode takes 0.7 s. Frames carry their own time.
        page = self.open(before="""() => { const decode = window.createImageBitmap; let calls = 0;
          window.createImageBitmap = (...args) => ++calls === 3 ? new Promise(r => setTimeout(r, 700)).then(() => decode(...args)) : decode(...args); }""")
        page.evaluate("() => { synServices.cineService.getState = () => ({ cines: { left: { isPlaying: false, frameRate: 5 } } }); }")
        with page.expect_download(timeout=30000) as saved:
            self.click(page, 'SaveVideo')
        played = page.evaluate(self.PLAYED, base64.b64encode(Path(saved.value.path()).read_bytes()).decode())
        first = {}
        for time, image in played['seen']: first.setdefault(image, time)
        for image in range(4):
            self.assertAlmostEqual(image / 5, first[image], delta=0.12, msg='5 fps: %s' % played['seen'])
        self.assertEqual('success', page.evaluate("() => synNotes.at(-1).type"))

    def test_34_a_short_decode_delay_is_absorbed_and_the_timing_holds(self):
        import base64
        # The fourth image's decode takes 0.3 s; it starts with the first, so it is ready long before 0.6 s.
        page = self.open(before="""() => { const decode = window.createImageBitmap; let calls = 0;
          window.createImageBitmap = (...args) => ++calls === 4 ? new Promise(r => setTimeout(r, 300)).then(() => decode(...args)) : decode(...args); }""")
        page.evaluate("() => { synServices.cineService.getState = () => ({ cines: { left: { isPlaying: false, frameRate: 5 } } }); }")
        with page.expect_download(timeout=30000) as saved:
            self.click(page, 'SaveVideo')
        played = page.evaluate(self.PLAYED, base64.b64encode(Path(saved.value.path()).read_bytes()).decode())
        first = {}
        for time, image in played['seen']: first.setdefault(image, time)
        for image in range(4):
            self.assertAlmostEqual(image / 5, first[image], delta=0.12, msg='5 fps: %s' % played['seen'])

    def test_32_a_browser_without_a_video_encoder_says_so(self):
        page = self.open(before="() => { Object.defineProperty(window, 'VideoEncoder', { value: undefined }); }")
        self.click(page, 'SaveVideo')
        self.assertEqual(['error'], page.evaluate("() => synNotes.map(n => n.type)"))

    # ── Save Video on whole series: CT 40 images on the left cell, MR 12 images on the right ──
    # Each image carries its number in six bits (bright squares at x = 10 + 22 * bit, y = 115, 14 px) so a decoded
    # frame tells which image of the series it is.
    def series(self, before=None):
        return self.open(before="() => { window.synCounts = { left: 40, right: 12 }; window.synBits = true; (%s)(); }" % (before or "() => {}"))

    # Decodes the downloaded file in the page: the length, and the image seen in the middle of each frame's time.
    DECODED = """async ({ b64, fps, count }) => {
      const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
      const video = document.createElement('video'); video.muted = true; video.src = URL.createObjectURL(new Blob([bytes]));
      document.body.append(video);
      await new Promise((resolve, reject) => { video.onloadeddata = resolve; video.onerror = () => reject(new Error('not playable')); });
      const c = document.createElement('canvas'); c.width = video.videoWidth; c.height = video.videoHeight;
      const x = c.getContext('2d', { willReadFrequently: true }), scale = c.width / 200;
      const bright = (px, py) => { const d = x.getImageData(Math.round(px * scale), Math.round(py * scale), 1, 1).data; return d[0] > 190 && d[1] > 190 && d[2] > 190; };
      const shown = () => { x.drawImage(video, 0, 0); let value = 0;
        for (let bit = 0; bit < 6; bit++) if (bright(10 + 22 * bit + 7, 122)) value |= 1 << bit;
        return [value, [...x.getImageData(Math.round(180 * scale), Math.round(60 * scale), 1, 1).data].slice(0, 3)]; };
      const seek = time => new Promise(resolve => { video.onseeked = () => { video.requestVideoFrameCallback(() => resolve()); setTimeout(resolve, 250); }; video.currentTime = time; });
      const seen = [];
      for (let k = 0; k < count; k++) { await seek((k + 0.5) / fps); seen.push(shown()); }
      await seek(1e6);
      return { width: c.width, height: c.height, duration: video.duration, end: video.currentTime, seen };
    }"""

    def saved_video(self, page, tool='SaveVideo', timeout=60000):
        with page.expect_download(timeout=timeout) as saved:
            self.click(page, tool)
        return saved.value.suggested_filename, Path(saved.value.path()).read_bytes()

    def assert_whole_series(self, page, name, data, count, fps, colour):
        import base64
        self.assertRegex(name, r'^series-7-\d{8}-\d{6}\.(mp4|webm)$')
        if name.endswith('.webm'): self.assertEqual(b'\x1a\x45\xdf\xa3', data[:4])
        else:
            self.assertEqual(b'ftyp', data[4:8])
            at = data.index(b'stsz')
            self.assertEqual(count, int.from_bytes(data[at + 12:at + 16], 'big'), 'MP4 sample count')
        decoded = page.evaluate(self.DECODED, {'b64': base64.b64encode(data).decode(), 'fps': fps, 'count': count})
        self.assertEqual((400, 300), (decoded['width'], decoded['height']))
        self.assertEqual(list(range(count)), [value for value, _ in decoded['seen']], 'every image once, in series order')
        for _, rgb in decoded['seen']: self.assertTrue(near(rgb, colour), rgb)
        self.assertAlmostEqual(count / fps, decoded['duration'], delta=0.5 / fps, msg='each image keeps 1/%s s' % fps)
        self.assertAlmostEqual(count / fps, decoded['end'], delta=1.0 / fps)
        note = page.evaluate("() => synNotes.at(-1)")
        self.assertEqual('success', note['type'])
        self.assertEqual('시리즈 영상 %d장을 %d fps 동영상 파일로 만들어 내려받기를 시작했습니다.' % (count, fps), note['message'])

    def test_35_ct_40_images_every_image_once_in_series_order(self):
        page = self.series()
        name, data = self.saved_video(page)
        self.assert_whole_series(page, name, data, 40, 10, (200, 0, 0))
        page.wait_for_function("() => synViewports.get('left').getCurrentImageIdIndex() === 1")

    def test_36_mr_12_images_on_the_other_cell_at_its_cine_speed(self):
        page = self.series()
        page.evaluate("() => { synServices.viewportGridService.setActive('right'); synServices.cineService.getState = () => ({ cines: { right: { isPlaying: false, frameRate: 5 } } }); }")
        name, data = self.saved_video(page)
        self.assert_whole_series(page, name, data, 12, 5, (0, 0, 200))
        self.assertEqual(1, page.evaluate("() => synViewports.get('left').getCurrentImageIdIndex()"), 'the other cell is not moved')

    def test_37_a_busy_computer_still_gets_every_image(self):
        page = self.series()
        cdp = page.context.new_cdp_session(page); cdp.send('Emulation.setCPUThrottlingRate', {'rate': 8})
        name, data = self.saved_video(page, timeout=180000)
        cdp.send('Emulation.setCPUThrottlingRate', {'rate': 1})
        self.assert_whole_series(page, name, data, 40, 10, (200, 0, 0))

    def test_38_a_short_empty_or_failed_encoding_writes_nothing_and_is_not_success(self):
        # The browser's encoder is wrapped: it loses one frame, returns nothing, or fails part way.
        for fault in ['drop', 'empty', 'fail', 'truncate']:
            page = self.series(before="""() => { const fault = '%s', Real = window.VideoEncoder;
              window.VideoEncoder = class extends Real {
                constructor(init) { const seen = { frames: 0 }; super({ output: (chunk, meta) => { let frames = seen.frames++;
                  if (fault === 'drop' && frames === 7) return;
                  if (fault === 'truncate' && frames === 4) { const data = new Uint8Array(chunk.byteLength); chunk.copyTo(data);
                    chunk = new EncodedVideoChunk({ type: chunk.type, timestamp: chunk.timestamp, duration: chunk.duration ?? undefined, data: data.slice(0, 1) }); }
                  if (fault !== 'empty') init.output(chunk, meta); }, error: error => init.error(error) }); this.init = init; this.seen = seen; }
                encode(frame, options) { if (fault === 'fail' && this.seen.frames > 10) { this.init.error(new DOMException('encoder failed', 'EncodingError')); return; } super.encode(frame, options); }
              }; }""" % fault)
            seen = self.downloads(page)
            self.click(page, 'SaveVideo')
            page.wait_for_function("() => synNotes.length", timeout=60000)
            page.wait_for_timeout(500)
            self.assertEqual([], seen, fault)
            note = page.evaluate("() => synNotes.at(-1)")
            self.assertEqual('error', note['type'], fault)
            short = '동영상에 시리즈의 모든 영상이 담기지 않아 저장하지 않았습니다. 다시 시도하세요.'
            self.assertEqual({'drop': short, 'empty': short, 'truncate': short,
                              'fail': '동영상을 만들지 못해 저장하지 않았습니다. 다시 시도하세요.'}[fault], note['message'], fault)

    def test_39_a_browser_without_h264_gets_a_whole_webm(self):
        page = self.series(before="""() => { const ask = VideoEncoder.isConfigSupported.bind(VideoEncoder);
          VideoEncoder.isConfigSupported = config => config.codec.startsWith('avc1') ? Promise.resolve({ supported: false, config }) : ask(config); }""")
        name, data = self.saved_video(page)
        self.assertTrue(name.endswith('.webm'), name)
        self.assert_whole_series(page, name, data, 40, 10, (200, 0, 0))

    def test_39b_another_series_or_escape_while_the_file_is_made_writes_nothing_and_moves_nothing(self):
        # Decoding each drawn image takes 0.1 s here, so the file is still being made when the reader acts.
        slow = """() => { const decode = window.createImageBitmap;
          window.createImageBitmap = (...args) => new Promise(r => setTimeout(r, 100)).then(() => decode(...args)); }"""
        for act in ['series', 'escape']:
            page = self.series(before=slow); seen = self.downloads(page)
            self.click(page, 'SaveVideo')
            page.wait_for_function("() => document.querySelector('.kin-ux-toolbar-settings [role=status]').textContent.includes('동영상 파일 만드는 중 3/40')", timeout=60000)
            self.assertEqual(1, page.evaluate("() => synViewports.get('left').getCurrentImageIdIndex()"), 'back on the shown image first')
            if act == 'series':
                page.evaluate("""() => { const v = synViewports.get('left'); window.synMoved = [];
                  synViewports.set('left', { ...v, getImageIds: () => ['syn:other:0', 'syn:other:1'], getCurrentImageIdIndex: () => 0,
                    setImageIdIndex: async value => { synMoved.push(value); } }); }""")
            else:
                page.keyboard.press('Escape')
            page.wait_for_function("() => synNotes.length", timeout=60000)
            page.wait_for_timeout(1500)
            self.assertEqual([], seen, act)
            self.assertNotEqual('success', page.evaluate("() => synNotes.at(-1).type"), act)
            if act == 'series': self.assertEqual([], page.evaluate("() => synMoved"), 'the newly chosen series is not wound back')
            else: self.assertIn('멈췄습니다', page.evaluate("() => synNotes.at(-1).message"))

    def test_39c_an_empty_h264_setup_is_never_written_and_webm_is_whole(self):
        # The H.264 encoder gives an empty decoder setup: no MP4 is written; the WebM made instead holds every image.
        page = self.series(before="""() => { const Real = window.VideoEncoder;
          window.VideoEncoder = class extends Real {
            constructor(init) { super({ output: (chunk, meta) => init.output(chunk, meta?.decoderConfig?.codec?.startsWith('avc1')
              ? { ...meta, decoderConfig: { ...meta.decoderConfig, description: new Uint8Array(0) } } : meta), error: error => init.error(error) }); }
          }; }""")
        name, data = self.saved_video(page)
        self.assertTrue(name.endswith('.webm'), name)
        self.assert_whole_series(page, name, data, 40, 10, (200, 0, 0))

    def test_39d_an_image_that_did_not_load_is_not_replaced_by_the_one_before(self):
        # Image 5 of 40 does not load: the cell's index moves to it but the canvas keeps image 4. With the loader's failure
        # notice the export ends at once; without it, at the load timeout. Either way no file and no success.
        for notice in [True, False]:
            page = self.series(); seen = self.downloads(page)
            page.evaluate("notice => { synFailAt.add('left:4'); synFailNotice = notice; KinViewerExport.options.loadTimeout = 1500; }", notice)
            self.click(page, 'SaveVideo')
            page.wait_for_function("() => synNotes.length", timeout=60000)
            self.assertEqual([1, 'syn:left:1', 1], page.evaluate(self.SHOWN), 'back on the reader\'s image when it says so')
            page.wait_for_timeout(500)
            self.assertEqual([], seen, notice)
            self.assertEqual('error', page.evaluate("() => synNotes.at(-1).type"), notice)
            self.assertIn('불러오지 못해', page.evaluate("() => synNotes.at(-1).message"), notice)

    # The reader puts the same series back into the cell (A -> B -> A): the viewer hands the stack the very same list of
    # images again, and tells of each new stack only after its first image loaded, which here takes a second.
    AGAIN = """index => { const v = synViewports.get('left'), list = v.getImageIds(), at = index ?? v.getCurrentImageIdIndex();
      synLoadMs = () => 1000;
      v.setStack(['syn:other:0', 'syn:other:1'], 0); v.setStack(list, at);
      window.synAfter = synRequests.length; }"""

    def test_39e_the_same_series_chosen_again_at_the_last_image_is_not_wound_back(self):
        # While the export shows image 40 of 40 the reader picks the same series again, which lands on image 40 too.
        page = self.series(); seen = self.downloads(page); self.slow(page, 300)
        self.click(page, 'SaveVideo')
        self.said(page, '40/40')
        page.evaluate(self.AGAIN, None)
        page.wait_for_function("() => synNotes.length", timeout=60000)
        page.wait_for_timeout(2500)
        self.assertEqual([], seen)
        self.assertNotEqual('success', page.evaluate("() => synNotes.at(-1).type"))
        self.assertEqual([39, 'syn:left:39', 39], page.evaluate(self.SHOWN), 'not wound back')
        self.assertEqual([], page.evaluate("() => synRequests.slice(synAfter)"), 'the export asks the cell for nothing after the reader did')

    def test_39f_a_cell_folded_or_resized_part_way_writes_nothing(self):
        for act, said in [("pane.style.display = 'none'", '보이지 않아'), ("pane.style.width = '260px'", '바뀌어')]:
            page = self.series(); seen = self.downloads(page); self.slow(page, 100)
            self.click(page, 'SaveVideo')
            self.said(page, '5/40')
            page.evaluate("() => { const pane = synViewports.get('left').element.closest('[data-cy=viewport-pane]'); " + act + "; }")
            page.wait_for_function("() => synNotes.length", timeout=60000)
            page.wait_for_timeout(500)
            self.assertEqual([], seen, act)
            self.assertEqual('error' if said == '보이지 않아' else 'warning', page.evaluate("() => synNotes.at(-1).type"), act)
            self.assertIn(said, page.evaluate("() => synNotes.at(-1).message"), act)

    def test_35b_ct_40_images_as_jpeg_in_one_zip_in_series_order(self):
        page = self.series(); seen = self.downloads(page)
        with page.expect_download(timeout=60000) as saved:
            self.click(page, 'SaveSeriesJPEG')
        archive = self.archive(saved.value)
        self.assertIsNone(archive.testzip())
        self.assertEqual(['image-%04d.jpg' % (k + 1) for k in range(40)], archive.namelist())
        for index, name in enumerate(archive.namelist()):
            rgb = self.image(archive.read(name)).convert('RGB')
            self.assertEqual(index, sum(1 << bit for bit in range(6) if near(rgb.getpixel(((10 + 22 * bit + 7) * 2, 122 * 2)), (255, 255, 255))), name)
        page.wait_for_function("() => synNotes.some(n => n.type === 'success')")
        self.assertEqual('시리즈 영상 40장을 JPEG 파일로 만들어 내려받기를 시작했습니다.', page.evaluate("() => synNotes.at(-1).message"))
        self.assertEqual([1, 'syn:left:1', 1], page.evaluate(self.SHOWN))
        page.wait_for_timeout(300); self.assertEqual(1, len(seen), 'one file')

    # ── A series export's claim on its cell: once the reader acts, the export moves nothing more and writes nothing ──
    def started(self, page, tool='SaveSeriesJPEG', at='3/4', ms=150):
        seen = self.downloads(page); self.slow(page, ms)
        self.click(page, tool); self.said(page, at)
        return seen

    def left_alone(self, page, seen, shown=None, wait=1500):
        page.wait_for_function("() => synNotes.length", timeout=60000)
        page.wait_for_timeout(wait)
        self.assertEqual([], seen)
        self.assertEqual([], page.evaluate("() => synNotes.filter(n => n.type === 'success')"))
        self.assertEqual([], page.evaluate("() => synRequests.slice(synAfter)"), 'the export asks the cell for no image after the reader acted')
        if shown: self.assertEqual(shown, page.evaluate(self.SHOWN))

    def test_50_the_same_series_put_back_while_its_images_still_load_stays_the_readers(self):
        # The same list of images, on the image number the export is on, and the viewer's notice of the new stack comes
        # only after the export would have finished: nothing but the request itself tells the cell was the reader's.
        # While an image is shown for the file:
        page = self.open(); seen = self.started(page)
        page.evaluate(self.AGAIN, None)
        self.left_alone(page, seen, [2, 'syn:left:2', 2])
        self.assertIn('바뀌어', page.evaluate("() => synNotes[0].message"))
        # While the export goes back to the image the reader was on:
        page = self.open(); seen = self.downloads(page); self.slow(page, 300, seen=True)
        self.click(page, 'SaveSeriesJPEG'); self.returning(page)
        page.evaluate(self.AGAIN, None)
        self.left_alone(page, seen, [1, 'syn:left:1', 1])
        # While the video file is made (each image takes 0.3 s to decode here), back on the reader's image:
        page = self.open(before="""() => { const decode = window.createImageBitmap;
          window.createImageBitmap = (...args) => new Promise(r => setTimeout(r, 300)).then(() => decode(...args)); }""")
        seen = self.downloads(page)
        self.click(page, 'SaveVideo'); self.said(page, '동영상 파일 만드는 중 2/4')
        page.evaluate(self.AGAIN.replace('1000', '4000'), None)
        self.left_alone(page, seen, [1, 'syn:left:1', 1], wait=5000)

    def test_51_a_wheel_step_whose_image_is_asked_for_a_moment_later_ends_the_claim_at_once(self):
        # The reader's wheel step names the image the export happens to be loading: the stack announces the scroll now and
        # would ask for the image 40 ms later, which then is no request at all. The cell is the reader's from the scroll.
        page = self.open(); seen = self.started(page)
        page.evaluate("() => { synViewports.get('left').scroll(1); window.synAfter = synRequests.length; }")
        self.left_alone(page, seen, [2, 'syn:left:2', 2])
        self.assertEqual(2, page.evaluate("() => synViewports.get('left').getTargetImageIdIndex()"))

    def test_52_selecting_another_cell_changing_the_grid_or_starting_cine_ends_the_claim(self):
        grid = "const g = synServices.viewportGridService; "
        for act in ["g.setActiveViewportId('right')",
                    # There and back before the grid has told of either: its state is the same again when the notices come.
                    "g.setActiveViewportId('right'); g.setActiveViewportId('left')",
                    "g.setLayout({ numRows: 2, numCols: 1 })",
                    "g.setLayout({ numRows: 2, numCols: 1 }); g.setLayout({ numRows: 1, numCols: 2 })",
                    "g.setDisplaySetsForViewport({ viewportId: 'right', displaySetInstanceUIDs: ['set-left'] })",
                    "synServices.cineService.getState = () => ({ cines: { left: { isPlaying: true } } })"]:
            page = self.open(); seen = self.started(page)
            page.evaluate("() => { " + grid + act + "; window.synAfter = synRequests.length; }")
            self.left_alone(page, seen, [2, 'syn:left:2', 2])
            self.assertEqual(['warning'], page.evaluate("() => synNotes.map(n => n.type)"), act)
            self.assertIn('바뀌어', page.evaluate("() => synNotes[0].message"), act)

    def test_53_the_viewer_ending_or_the_window_going_away_ends_a_running_export(self):
        # The viewer leaves the study while its toolbar still stands, the window goes away, the patient tab switches.
        for act in ["KinViewerExport.end()", "window.dispatchEvent(new Event('pagehide'))", "document.body.classList.add('kin-patient-switching')"]:
            page = self.open(); seen = self.started(page)
            page.evaluate("() => { " + act + "; window.synAfter = synRequests.length; }")
            self.left_alone(page, seen, [2, 'syn:left:2', 2])

    def test_54_a_load_that_never_answers_does_not_hold_the_next_export_up(self):
        # With CPU rendering a load the reader's move made stale never answers. The export does not wait for it.
        page = self.open(); page.evaluate("() => { synNeverAnswers = true; }")
        seen = self.started(page)
        page.evaluate("() => { synViewports.get('left').setImageIdIndex(0); window.synAfter = synRequests.length; }")
        self.left_alone(page, seen, [0, 'syn:left:0', 0], wait=500)
        page.evaluate("() => { synNotes.length = 0; }")
        with page.expect_download() as saved:
            self.click(page, 'SaveSeriesJPEG')
        self.assertNotIn('진행 중', ' '.join(page.evaluate("() => synNotes.map(n => n.message)")))
        archive = self.archive(saved.value)
        for index, name in enumerate(archive.namelist()): self.assert_frame(self.image(archive.read(name)), index)
        self.assertEqual(4, len(archive.namelist()))

    def test_55_only_the_cells_own_image_canvas_is_its_image(self):
        # Another canvas of the cell stays visible; the image canvas is hidden, taken out, or its renderer lost its context.
        for act in ["v.canvas.style.display = 'none'", "v.canvas.remove()",
                    "v.getRenderingEngine = () => ({}); window.kinViewerContextLoss = { usable: () => false }"]:
            page = self.open()
            page.evaluate("() => { const v = synViewports.get('left'), other = document.createElement('canvas'); other.width = 400; other.height = 300; v.element.append(other); }")
            seen = self.started(page)
            page.evaluate("() => { const v = synViewports.get('left'); " + act + "; }")
            page.wait_for_function("() => synNotes.length", timeout=60000)
            page.wait_for_timeout(500)
            self.assertEqual([], seen, act)
            self.assertEqual(['error'], page.evaluate("() => synNotes.map(n => n.type)"), act)
            self.assertIn('보이지 않아', page.evaluate("() => synNotes[0].message"), act)

    def test_56_a_return_that_does_not_show_the_readers_image_writes_nothing_and_says_so(self):
        # The image number goes back to the reader's image but that image does not arrive: the last image stays on the cell.
        page = self.open(); seen = self.started(page)
        page.evaluate("() => { synFailAt.add('left:1'); KinViewerExport.options.loadTimeout = 400; }")
        page.wait_for_function("() => synNotes.length", timeout=60000)
        page.wait_for_timeout(300)
        self.assertEqual([1, 'syn:left:3', 3], page.evaluate(self.SHOWN))
        self.assertEqual([], seen)
        self.assertEqual(['error'], page.evaluate("() => synNotes.map(n => n.type)"))
        self.assertIn('돌아가지 못해', page.evaluate("() => synNotes[0].message"))
        # The reader's image is the last one, and it does not arrive when the export comes to it: the number is the
        # reader's from the start to the end, the image is not.
        page = self.open()
        page.evaluate("() => synViewports.get('left').setImageIdIndex(3)")
        page.wait_for_function("shown => JSON.stringify((%s)()) === shown" % self.SHOWN, arg='[3,"syn:left:3",3]')
        seen = self.started(page)
        page.evaluate("() => { synFailAt.add('left:3'); KinViewerExport.options.loadTimeout = 400; }")
        page.wait_for_function("() => synNotes.length", timeout=60000)
        page.wait_for_timeout(300)
        self.assertEqual([3, 'syn:left:2', 2], page.evaluate(self.SHOWN))
        self.assertEqual([], seen)
        self.assertEqual(['error'], page.evaluate("() => synNotes.map(n => n.type)"))
        self.assertIn('돌아가지 못해', page.evaluate("() => synNotes[0].message"))

    def test_57_the_series_and_the_image_are_settled_before_anything_moves(self):
        # The grid names another series for the cell than the one its images are of (it was just given, the images are not there yet).
        page = self.open(); seen = self.downloads(page)
        page.evaluate("() => { synServices.viewportGridService.getState().viewports.get('left').displaySetInstanceUIDs = ['set-right']; }")
        self.click(page, 'SaveSeriesJPEG')
        page.wait_for_function("() => synNotes.length")
        self.assertEqual(['error'], page.evaluate("() => synNotes.map(n => n.type)"))
        self.assertIn('시리즈를 확인하지 못해', page.evaluate("() => synNotes[0].message"))
        self.assertEqual([], page.evaluate("() => synRequests"), 'nothing was moved')
        # The cell's image number is ahead of the image it shows (that image never arrives).
        page = self.open(); seen2 = self.downloads(page)
        page.evaluate("() => { synViewports.get('left').currentImageIdIndex = 2; KinViewerExport.options.loadTimeout = 300; }")
        self.click(page, 'SaveSeriesJPEG')
        page.wait_for_function("() => synNotes.length")
        self.assertEqual(['error'], page.evaluate("() => synNotes.map(n => n.type)"))
        self.assertIn('불러오지 못해', page.evaluate("() => synNotes[0].message"))
        self.assertEqual([], page.evaluate("() => synRequests"), 'nothing was moved')
        page.wait_for_timeout(300); self.assertEqual([], seen + seen2)

    def test_57b_a_part_of_a_split_multi_frame_series_is_told_from_the_other_parts(self):
        # One multi-frame file opened as two parts (time points) that share the series and the file: the cell shows the
        # frames 2, 4, 6, 8. The viewer's own rule (series-split.js) says which part holds a frame.
        before = """() => { window.synImageId = (id, k) => id === 'left'
          ? 'wadors:/dicom-web/studies/1.2.3/series/1.2.3.1/instances/1.2.3.1.9/frames/' + (2 * k + 2) : 'syn:' + id + ':' + k; }"""
        parts = """named => { const file = '1.2.3.1.9', part = frames => ({ StudyInstanceUID: '1.2.3', SeriesInstanceUID: '1.2.3.1',
            images: frames.map(frame => ({ SOPInstanceUID: file, kinSplitFrame: frame })) });
          for (const imageId of synViewports.get('left').getImageIds()) synInstances.get(imageId).SOPInstanceUID = file;
          synSets.set('part-1', part([1, 3, 5, 7])); synSets.set('part-2', part([2, 4, 6, 8]));
          synServices.viewportGridService.getState().viewports.get('left').displaySetInstanceUIDs = [named]; }"""
        page = self.open(before=before); seen = self.downloads(page)
        page.add_script_tag(path=str(ROOT / "config" / "ohif" / "series-split.js"))
        page.evaluate(parts, 'part-1')
        self.click(page, 'SaveSeriesJPEG')
        page.wait_for_function("() => synNotes.length")
        self.assertIn('시리즈를 확인하지 못해', page.evaluate("() => synNotes[0].message"))
        self.assertEqual([], page.evaluate("() => synRequests"))
        page.wait_for_timeout(300); self.assertEqual([], seen)
        page = self.open(before=before)
        page.add_script_tag(path=str(ROOT / "config" / "ohif" / "series-split.js"))
        page.evaluate(parts, 'part-2')
        with page.expect_download() as saved:
            self.click(page, 'SaveSeriesJPEG')
        archive = self.archive(saved.value)
        self.assertEqual(4, len(archive.namelist()))
        for index, name in enumerate(archive.namelist()): self.assert_frame(self.image(archive.read(name)), index)

    def test_58_what_follows_a_cells_image_is_told_the_exports_own_images_from_the_readers(self):
        # Position sync, Manual Sync and Auto Save View ask moving(): true for the images an export shows on its way (the
        # way back included), false once the cell is back on the reader's image and for an image the reader chose.
        follow = """() => { window.synFollowed = [];
          document.addEventListener('CORNERSTONE_STACK_NEW_IMAGE', event => synFollowed.push(
            [event.detail.imageIdIndex, KinViewerExport.moving('left'), KinViewerExport.moving('right'), KinViewerExport.moving()]), true); }"""
        page = self.open(); page.evaluate(follow)
        self.assertFalse(page.evaluate("() => KinViewerExport.moving()"))
        with page.expect_download():
            self.click(page, 'SaveSeriesJPEG')
        self.assertEqual([[index, True, False, True] for index in [0, 1, 2, 3, 1]], page.evaluate("() => synFollowed"))
        self.assertFalse(page.evaluate("() => KinViewerExport.moving()"))
        # The reader's own move in the middle of an export is the reader's.
        page = self.open(); page.evaluate(follow); self.started(page)
        page.evaluate("() => { synFollowed.length = 0; synViewports.get('left').setImageIdIndex(0); }")
        page.wait_for_function("() => synNotes.length")
        page.wait_for_timeout(400)
        self.assertEqual([[0, False, False, False]], page.evaluate("() => synFollowed"))
        # While the video file is made the cell is back on the reader's image.
        page = self.open(before="""() => { const decode = window.createImageBitmap;
          window.createImageBitmap = (...args) => new Promise(r => setTimeout(r, 300)).then(() => decode(...args)); }""")
        self.click(page, 'SaveVideo'); self.said(page, '동영상 파일 만드는 중 2/4')
        self.assertFalse(page.evaluate("() => KinViewerExport.moving()"))
        page.keyboard.press('Escape')
        # The window going away or the patient switching in the middle: what is read at that moment, by a listener added
        # before the export or after it, is still told the image is the export's.
        page = self.open()
        page.evaluate("() => { window.synLeaving = []; window.addEventListener('pagehide', () => synLeaving.push(KinViewerExport.moving())); }")
        self.started(page)
        page.evaluate("""() => { window.addEventListener('pagehide', () => synLeaving.push(KinViewerExport.moving()));
          window.dispatchEvent(new Event('pagehide')); }""")
        self.assertEqual([True, True], page.evaluate("() => synLeaving"))
        page = self.open(); self.started(page)
        self.assertTrue(page.evaluate("() => { document.body.classList.add('kin-patient-switching'); return KinViewerExport.moving(); }"))
        page.wait_for_function("() => synNotes.length")
        self.assertFalse(page.evaluate("() => KinViewerExport.moving()"))

    # ── Captures: captures collect in this window's Captures panel ──
    def panel(self, page):
        return page.get_by_role('complementary', name='Captures')

    def test_40_captures_collect_copy_save_remove_and_save_all(self):
        import zipfile
        from io import BytesIO
        page = self.open()
        self.click(page, 'AddToCaptures')
        panel = self.panel(page)
        panel.get_by_role('heading', name='Captures (1)').wait_for()
        page.evaluate("() => synServices.viewportGridService.setActive('right')")
        panel.get_by_role('button', name='Add Image', exact=True).click()
        panel.get_by_role('button', name='Add Screen', exact=True).click()
        panel.get_by_role('heading', name='Captures (3)').wait_for()
        labels = panel.locator('li img').evaluate_all("nodes => nodes.map(n => n.alt)")
        self.assertEqual(3, len(labels)); self.assertIn(' · Screen · ', labels[2])
        # Each capture is the cell as it was: left red, right blue, the screen both.
        colours = []
        for label in labels:
            with page.expect_download() as saved:
                panel.get_by_role('button', name='Save ' + label, exact=True).click()
            self.assertRegex(saved.value.suggested_filename, r'^capture-0\d-\d{8}-\d{6}\.png$')
            bitmap = self.image(Path(saved.value.path()).read_bytes()).convert('RGB')
            colours.append((bitmap.size, bitmap.getpixel((300, 260)), bitmap.getpixel((bitmap.width - 100, 260))))
        self.assertEqual([(400, 300), (400, 300), (800, 300)], [c[0] for c in colours])
        self.assertTrue(near(colours[0][1], (200, 0, 0)) and near(colours[1][1], (0, 0, 200)), colours)
        self.assertTrue(near(colours[2][1], (200, 0, 0)) and near(colours[2][2], (0, 0, 200)), colours)
        panel.get_by_role('button', name='Copy ' + labels[1], exact=True).click()
        page.wait_for_function("() => synNotes.some(n => n.type === 'success' && n.message.startsWith('Capture 2'))")
        got = page.evaluate(CLIPBOARD, {'width': 200, 'samples': [[150, 130]]})
        self.assertTrue(near(got['samples'][0], (0, 0, 200)), got)
        panel.get_by_role('button', name='Remove ' + labels[0], exact=True).click()
        panel.get_by_role('heading', name='Captures (2)').wait_for()
        with page.expect_download() as saved:
            panel.get_by_role('button', name='Save All', exact=True).click()
        archive = zipfile.ZipFile(BytesIO(Path(saved.value.path()).read_bytes()))
        self.assertIsNone(archive.testzip()); self.assertEqual(2, len(archive.namelist()))
        self.assertTrue(all(archive.read(n)[:8] == b'\x89PNG\r\n\x1a\n' for n in archive.namelist()))
        panel.get_by_role('button', name='Clear', exact=True).click()
        panel.get_by_role('heading', name='Captures (0)').wait_for()
        panel.get_by_role('button', name='Close', exact=True).click()
        self.assertFalse(panel.is_visible())
        self.click(page, 'Captures')
        self.assertTrue(panel.is_visible())
        self.click(page, 'Captures')
        self.assertFalse(panel.is_visible())

    def test_41_leaving_the_study_empties_the_panel_and_drops_a_capture_in_flight(self):
        page = self.open()
        self.click(page, 'AddToCaptures')
        self.panel(page).get_by_role('heading', name='Captures (1)').wait_for()
        page.evaluate("""() => { const decode = Image.prototype.decode;
          Image.prototype.decode = function () { return new Promise(r => setTimeout(r, 300)).then(() => decode.call(this)); }; }""")
        self.click(page, 'AddToCaptures')
        page.evaluate("() => synToolbar.dispose()")
        self.assertEqual(0, page.locator('aside.kin-captures').count())
        page.wait_for_timeout(700)
        self.assertEqual(0, page.locator('aside.kin-captures').count(), 'the late capture does not bring the panel back')
        self.assertEqual([], page.evaluate("() => synNotes.filter(n => n.type === 'error')"))

    def test_43_save_all_after_leaving_the_study_writes_nothing(self):
        page = self.open(); seen = self.downloads(page)
        self.click(page, 'AddToCaptures')
        self.panel(page).get_by_role('heading', name='Captures (1)').wait_for()
        page.evaluate("""() => { const read = Blob.prototype.arrayBuffer;
          Blob.prototype.arrayBuffer = function () { return new Promise(r => setTimeout(r, 300)).then(() => read.call(this)); }; }""")
        self.panel(page).get_by_role('button', name='Save All', exact=True).click()
        page.evaluate("() => synToolbar.dispose()")
        page.wait_for_timeout(800)
        self.assertEqual([], seen)

    def test_42_panel_buttons_meet_the_toolbar_guards(self):
        page = self.open()
        self.click(page, 'Captures')
        page.evaluate("() => { synBusy = true; }")
        self.panel(page).get_by_role('button', name='Add Image', exact=True).click()
        page.wait_for_timeout(200)
        self.panel(page).get_by_role('heading', name='Captures (0)').wait_for()


if __name__ == '__main__':
    unittest.main(verbosity=2)
