# coding: utf-8
"""Each image cell has its own compact tools, and they act in that cell only.

The shipped viewer-ux-shell.js, viewer-info-bar.js, viewer-ux-toolbar.js, viewer-features.js and
viewer-ux-shortcuts.js (with viewer-ux-theme.css) run in Chromium inside a synthetic copy of the stock viewer's column
with synthetic OHIF services: a 2 x 2 grid of stack cells whose rendered images the information rows name, a toolbar
service that records which cell was active when each tool ran, a grid whose active cell changes on a later task (as
the viewer's does) and an in-page account endpoint. One rule is checked from every entrance: the toolbar's buttons and
the shortcuts act in the active cell, a cell's own tools make that cell the active one and act there, the toolbar's
guards come first (nothing changes, not even the active cell), and a cell that is given other images while it is being
made active is left alone.
"""
from pathlib import Path
import unittest

from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[1]
HPACS = ROOT / "worklist-v0" / "hpacs-lite"
ORIGIN = "https://viewer-cell-tools.test"
OWNER = ['syn-site', 'syn-reader']
FREQUENT = ['WindowLevel', 'Pan', 'Zoom', 'StackScroll', 'Length', 'Angle', 'EllipticalROI', 'Pointer']
TOOLS = [['WindowLevel', 'Window / Level'], ['Pan', 'Pan'], ['Zoom', 'Zoom'], ['StackScroll', 'Stack Scroll'], ['Length', 'Length'],
         ['Angle', 'Angle'], ['EllipticalROI', 'Ellipse'], ['Capture', 'Capture'], ['flipHorizontal', 'Flip Horizontal']]

HARNESS = """<!doctype html><html><head><style>
html, body { margin: 0; height: 100%; background: #000; }
.flex { display: flex; } .flex-col { flex-direction: column; } .flex-row { flex-direction: row; } .flex-1 { flex: 1 1 0%; }
.h-full { height: 100%; } .w-full { width: 100%; } .relative { position: relative; } .overflow-hidden { overflow: hidden; }
[data-cy=viewport-grid] { display: grid; grid-template-columns: repeat(var(--cols, 2), minmax(0, 1fr)); grid-auto-rows: minmax(0, 1fr); }
[data-cy=viewport-pane] { position: relative; overflow: hidden; outline: 1px solid #333; }
.viewport-element { position: absolute; inset: 42px 0 0 0; }
</style></head><body><div id="root"><div class="flex flex-col" style="height: 100vh">
  <div class="relative flex flex-row overflow-hidden flex-1">
    <div id="column" class="flex h-full flex-1 flex-col">
      <div id="main" class="relative flex h-full flex-1 overflow-hidden">
        <div class="h-full w-full"><div data-cy="viewport-grid" class="h-full w-full"></div></div>
      </div>
    </div>
  </div>
</div></div></body></html>"""

SETUP = """([owner, tools, cells, columns]) => {
  document.querySelector('[data-cy=viewport-grid]').style.setProperty('--cols', columns);
  window.synNotes = []; window.synCalls = []; window.synDelay = 0; window.synDisabled = new Set(); window.synPressed = null; window.synBusy = false;
  const EVENTS = { IMAGE_RENDERED: 'cs-rendered', IMAGE_LOAD_FAILED: 'cs-failed', IMAGE_LOADED: 'cs-loaded', PRE_STACK_NEW_IMAGE: 'cs-pre',
    STACK_NEW_IMAGE: 'cs-new', ELEMENT_ENABLED: 'cs-enabled', ELEMENT_DISABLED: 'cs-disabled' };
  const STATUS = { RENDERED: 'rendered', LOADING: 'loading', NO_DATA: 'noData', PRE_RENDER: 'preRender', RESIZE: 'resize' };
  window.synMeta = {};
  window.cornerstone = { Enums: { Events: EVENTS, ViewportStatus: STATUS }, eventTarget: new EventTarget(),
    metaData: { get: (type, id) => type === 'instance' ? synMeta[id] : undefined },
    cache: { getImage: () => null, getImageLoadObject: () => null, getVolume: () => null } };
  const listeners = new Map();
  const events = name => ({ subscribe(event, fn) { const key = name + ':' + event; listeners.set(key, [...(listeners.get(key) || []), fn]);
    return { unsubscribe() { listeners.set(key, (listeners.get(key) || []).filter(f => f !== fn)); } }; } });
  window.synEmit = (name, event, payload) => { for (const fn of listeners.get(name + ':' + event) || []) fn(payload); };
  window.synGrid = new Map(); window.synViewports = new Map(); window.synSets = new Map(); window.synActive = cells[0].id;
  const gridNode = document.querySelector('[data-cy=viewport-grid]');
  for (const cell of cells) {
    const pane = document.createElement('div'); pane.dataset.cy = 'viewport-pane'; pane.id = 'pane-' + cell.id;
    pane.innerHTML = '<div class="viewport-element"></div>'; gridNode.append(pane);
    const sets = cell.empty ? [] : ['ds-' + cell.id];
    synGrid.set(cell.id, { viewportId: cell.id, displaySetInstanceUIDs: sets, x: 0, y: 0, width: 1, height: 1 });
    if (!cell.empty) {
      synSets.set('ds-' + cell.id, { displaySetInstanceUID: 'ds-' + cell.id, StudyInstanceUID: 'S1', SeriesInstanceUID: 'SER-' + cell.id, Modality: 'CT' });
      synMeta['img:' + cell.id] = { StudyInstanceUID: 'S1', SeriesInstanceUID: 'SER-' + cell.id, PatientName: 'SYN^ONE', PatientID: 'SYN-1',
        PatientSex: 'O', PatientAge: '050Y', StudyDate: '20261101', StudyDescription: 'SYN ' + cell.id };
      const image = { imageId: 'img:' + cell.id };
      synViewports.set(cell.id, { id: cell.id, type: cell.type || 'stack', element: pane.querySelector('.viewport-element'), viewportStatus: STATUS.RENDERED,
        getCurrentImageId: () => image.imageId, getCornerstoneImage: () => image, getVolumeId: () => null, getActors: () => [] });
    }
  }
  const grid = { ...events('grid'), EVENTS: { ACTIVE_VIEWPORT_ID_CHANGED: 'active', GRID_STATE_CHANGED: 'gridState' },
    getActiveViewportId: () => synActive,
    // As the viewer does: a requested cell becomes active on a later task.
    setActiveViewportId: id => setTimeout(() => { synActive = id; synEmit('grid', 'active', { viewportId: id }); }, synDelay),
    getState: () => ({ activeViewportId: synActive, viewports: synGrid, layout: { layoutType: 'grid', numRows: 2, numCols: columns } }) };
  window.synButtons = Object.fromEntries(tools.map(([id, label]) => [id, { id, uiType: 'ohif.radioGroup', props: { label, commands: 'setToolActiveToolbar' } }]));
  window.synServices = {
    viewportGridService: grid,
    displaySetService: { ...events('sets'), EVENTS: {}, getDisplaySetByUID: id => synSets.get(id), getActiveDisplaySets: () => [...synSets.values()] },
    cornerstoneViewportService: { ...events('cells'), EVENTS: { VIEWPORT_DATA_CHANGED: 'data' }, getCornerstoneViewport: id => synViewports.get(id) },
    uiNotificationService: { show: note => synNotes.push(note) },
    toolbarService: { EVENTS: { TOOL_BAR_MODIFIED: 'modified' }, getButtonSection: () => tools.map(([id]) => ({ id })),
      getButtons: () => synButtons,
      // The viewer evaluates a tool's state for the active cell.
      getButtonProps: id => synButtons[id] && { id, ...synButtons[id].props, disabled: synDisabled.has(id), isActive: synPressed === id },
      recordInteraction: (item, options) => synCalls.push([item.itemId, synActive, options?.refreshProps?.viewportId ?? null]),
      subscribe: () => ({ unsubscribe() {} }) },
  };
  window.synCommands = { runCommand() {} };
  window.kinViewerHistoryWorkspaceState = () => ({ busy: synBusy });
  window.kinViewerJobWorkspaceState = () => ({ busy: false });
  window.KinViewerPatientTabs = { snapshot: () => ({ key: 'p1', sequence: 1, studyUIDs: ['S1'] }), subscribe: () => () => {},
    mount() {}, refresh() {}, dispose() {}, end() {}, guard: () => true, resolve: async () => ({ key: 'p1' }) };
  // The series strip is not this test's subject: a strip that reserves the toolbar's row, as the shipped one does.
  window.KinViewerSeriesStrip = { mount: () => { let slot = null; return {
    place() { if (slot) return; slot = document.createElement('section'); slot.className = 'kin-ux-toolbar-slot'; slot.dataset.kinUxOwned = '';
      document.getElementById('column').prepend(slot); },
    refresh() { this.place(); }, orient() {}, dispose() { slot?.remove(); } }; } };
  window.KinSessionTransport = { refusal: () => false, responseError: () => new Error('ended') };
  window.KinViewerHangingSettings = { modalities: [], defaults: {}, get: () => ({}),
    mount: () => ({ apply() {}, dispose() {} }), mountSizing: () => ({ dispose() {} }) };
  window.synServer = { revision: 3, viewerSettings: null };
  const reply = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  window.fetch = async (url, init = {}) => {
    if (!String(url).endsWith('/api/workspace-shortcuts')) return reply(404, {});
    if ((init.method || 'GET') === 'GET') return reply(200, { owner, revision: synServer.revision, viewerSettings: structuredClone(synServer.viewerSettings) });
    const body = JSON.parse(init.body); synServer.revision++; synServer.viewerSettings = body.viewerSettings;
    return reply(200, { owner, revision: synServer.revision, viewerSettings: structuredClone(synServer.viewerSettings) });
  };
  window.synSession = { owner: () => owner, ended: () => false, writer: () => true, readOnly: () => false, state: () => 'confirmed', decide: async () => {} };
  // As config/ohif/viewer-ux.js on mode entry: the shell, then the toolbar, and the shortcuts that call the toolbar.
  window.synMount = () => {
    window.synShell = KinViewerUXShell.mount({ services: synServices, session: synSession });
    window.synToolbar = KinViewerUXToolbar.mount({ services: synServices, commands: synCommands, session: synSession });
    window.synKeys = KinViewerUXShortcuts.mount({ getBindings: () => synToolbar.bindings(), invoke: id => synToolbar.invoke(id), allowed: () => true });
    // Every cell has drawn its image (the information rows name a cell only after a completed render).
    for (const id of synViewports.keys()) document.dispatchEvent(new CustomEvent('cs-rendered', { detail: { viewportId: id } }));
  };
}"""
FRAME = "() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))"
CELLS = [{'id': 'tl'}, {'id': 'tr'}, {'id': 'bl'}, {'id': 'br'}]


class ViewerCellToolsDOMTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.pw = sync_playwright().start()
        cls.browser = cls.pw.chromium.launch()

    @classmethod
    def tearDownClass(cls):
        cls.browser.close(); cls.pw.stop()

    def open(self, size=(1366, 768), cells=CELLS, columns=2, before=None):
        context = self.browser.new_context(viewport={'width': size[0], 'height': size[1]})
        page = context.new_page(); errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        self.addCleanup(context.close)
        self.addCleanup(lambda: self.assertEqual([], errors))
        page.route(ORIGIN + "/", lambda route: route.fulfill(body=HARNESS, content_type="text/html"))
        page.goto(ORIGIN + "/")
        page.add_style_tag(path=str(HPACS / "viewer-ux-theme.css"))
        for name in ["viewer-info-bar.js", "viewer-ux-shortcuts.js", "viewer-features.js", "viewer-ux-toolbar.js", "viewer-ux-shell.js"]:
            page.add_script_tag(path=str(HPACS / name))
        page.evaluate(SETUP, [OWNER, TOOLS, cells, columns])
        if before:
            page.evaluate(before)
        page.evaluate("() => synMount()")
        expect(page.locator('.kin-ux-toolbar-slot > .kin-ux-toolbar')).to_have_count(1)
        page.evaluate(FRAME)
        return page

    def tools(self, page, cell):
        return page.evaluate("cell => [...document.querySelectorAll('#pane-' + cell + ' .kin-viewer-cell-tools:not([hidden]) [data-cell-tool]')].map(n => n.dataset.cellTool)", cell)

    def test_01_every_cell_has_the_frequent_tools_and_a_press_acts_in_that_cell(self):
        page = self.open()
        for cell in ['tl', 'tr', 'bl', 'br']:
            self.assertEqual(FREQUENT, self.tools(page, cell), cell)
        # The row keeps its identity, mode and Study button; the tools are at its end.
        order = page.evaluate("() => [...document.querySelector('#pane-br .kin-viewer-info-bar').children].map(n => n.className || n.textContent)")
        self.assertEqual(['kin-viewer-info-identity', 'kin-viewer-info-mode', 'Study ▾', 'kin-viewer-cell-tools'], order)
        page.locator('#pane-br [data-cell-tool=Zoom]').click()
        page.wait_for_function("() => synCalls.length === 1")
        self.assertEqual([['Zoom', 'br', 'br']], page.evaluate("synCalls"))
        self.assertEqual('br', page.evaluate("synActive"))
        # A turn of the image acts in its cell too (here the second cell pressed).
        page.locator('#pane-tr [data-cell-tool=Pan]').click()
        page.wait_for_function("() => synCalls.length === 2")
        self.assertEqual(['Pan', 'tr', 'tr'], page.evaluate("synCalls[1]"))
        # The toolbar's button and the shortcut act in the active cell: the same target.
        page.locator('.kin-ux-tools-bar [data-tool=Length]').click()
        page.wait_for_function("() => synCalls.length === 3")
        self.assertEqual(['Length', 'tr', 'tr'], page.evaluate("synCalls[2]"))
        key = page.evaluate("() => synToolbar.bindings().Zoom")
        self.assertTrue(key, 'Zoom has a default shortcut')
        page.locator('#column').click(position={'x': 5, 'y': 200})
        page.keyboard.press(key.replace('Shift+', 'Shift+'))
        page.wait_for_function("() => synCalls.length === 4")
        self.assertEqual(['Zoom', 'tr', 'tr'], page.evaluate("synCalls[3]"))

    def test_02_only_the_active_cell_shows_the_tools_state(self):
        page = self.open()
        page.evaluate("() => { synDisabled.add('Length'); synPressed = 'Pan'; synShell && KinViewerUX.refreshCells(); }")
        page.locator('.kin-ux-tools-bar [data-tool=WindowLevel]').click()
        page.wait_for_function("() => synCalls.length === 1")
        page.evaluate(FRAME)
        state = page.evaluate("""() => Object.fromEntries(['tl', 'tr'].map(id => [id, ['Length', 'Pan'].map(tool => {
            const n = document.querySelector('#pane-' + id + ' [data-cell-tool=' + tool + ']'); return [n.disabled, n.getAttribute('aria-pressed')]; })]))""")
        self.assertEqual({'tl': [[True, 'false'], [False, 'true']], 'tr': [[False, None], [False, None]]}, state)
        # A tool refused in the active cell is still offered in another cell; there it is judged after that cell is active.
        page.locator('#pane-tr [data-cell-tool=Length]').click()
        page.wait_for_function("() => synActive === 'tr'")
        page.wait_for_timeout(100)
        self.assertEqual(1, page.evaluate("synCalls.length"), 'refused in the cell it was pressed in')

    def test_03_guards_first_nothing_changes_not_even_the_active_cell(self):
        page = self.open()
        page.evaluate("synBusy = true")
        page.locator('#pane-bl [data-cell-tool=Zoom]').click()
        page.wait_for_timeout(200)
        self.assertEqual([[], 'tl'], page.evaluate("[synCalls, synActive]"))

    def test_04_a_cell_given_other_images_while_it_is_made_active_is_left_alone(self):
        page = self.open()
        page.evaluate("synDelay = 120")
        page.locator('#pane-tr [data-cell-tool=Zoom]').click()
        page.evaluate("""() => { synGrid.get('tr').displaySetInstanceUIDs = ['ds-other'];
            synEmit('grid', 'gridState', { viewports: [{ viewportId: 'tr' }] }); }""")
        page.wait_for_timeout(400)
        self.assertEqual([], page.evaluate("synCalls"))
        # Another cell chosen in between: the press does not run in the cell that became active instead.
        page.locator('#pane-bl [data-cell-tool=Pan]').click()
        page.evaluate("() => { synActive = 'br'; }")
        page.wait_for_timeout(400)
        self.assertEqual([], [c for c in page.evaluate("synCalls") if c[1] != 'bl'])

    def test_05_narrow_cells_list_the_same_tools_under_one_button(self):
        page = self.open(size=(1366, 768), columns=4, cells=CELLS)
        self.assertEqual(['menu'], self.tools(page, 'tr'))
        page.locator('#pane-tr [data-cell-tool=menu]').click()
        menu = page.locator('.kin-ux-cell-menu')
        expect(menu).to_have_count(1)
        self.assertEqual(FREQUENT, menu.locator('[role=menuitem]').evaluate_all("nodes => nodes.map(n => n.dataset.cellTool)"))
        menu.locator('[data-cell-tool=Angle]').click()
        page.wait_for_function("() => synCalls.length === 1")
        self.assertEqual([['Angle', 'tr', 'tr']], page.evaluate("synCalls"))
        expect(menu).to_have_count(0)
        # Escape closes the list and gives the keyboard back to its button.
        page.locator('#pane-bl [data-cell-tool=menu]').click()
        expect(menu).to_have_count(1)
        page.keyboard.press('Escape')
        expect(menu).to_have_count(0)
        self.assertEqual('menu', page.evaluate("document.activeElement.dataset.cellTool"))

    def test_06_the_cells_width_alone_decides_icons_or_list_and_nothing_flips(self):
        page = self.open(size=(1366, 768), columns=2)
        # The width where the icons stop fitting: the row's own content never decides it.
        result = page.evaluate("""async () => {
          const frame = () => new Promise(r => requestAnimationFrame(r));
          const host = document.querySelector('#root > div'), node = document.querySelector('#pane-tl .kin-viewer-cell-tools');
          const out = [];
          for (let width = 1120; width >= 1000; width -= 1) {
            host.style.width = width + 'px'; KinViewerUX.refreshCells();
            for (let i = 0; i < 2; i++) await frame();
            let flips = 0; const watch = new MutationObserver(r => { flips += r.length; }); watch.observe(node, { childList: true });
            for (let i = 0; i < 4; i++) { KinViewerUX.refreshCells(); await frame(); }
            watch.disconnect();
            out.push({ width, flips, compact: !!node.querySelector('[data-cell-tool=menu]') });
          }
          return out; }""")
        self.assertEqual([], [r for r in result if r['flips']])
        modes = [r['compact'] for r in result]
        self.assertIn(True, modes); self.assertIn(False, modes)
        self.assertEqual(sorted(modes), modes, 'one change from icons to the list as the cell narrows')

    def test_07_mpr_3d_and_empty_cells_have_no_cell_tools(self):
        page = self.open(cells=[{'id': 'tl'}, {'id': 'tr', 'type': 'orthographic'}, {'id': 'bl', 'type': 'volume3d'}, {'id': 'br', 'empty': True}])
        self.assertEqual(FREQUENT, self.tools(page, 'tl'))
        for cell in ['tr', 'bl', 'br']:
            self.assertEqual([], self.tools(page, cell), cell)

    def test_08_whole_window_actions_stay_on_the_toolbar(self):
        before = """() => { window.KinViewerExport = { actions: [{ id: 'copyScreen', label: 'Copy Screen', run() {} }] };
            synServer.viewerSettings = { version: 2, bar: ['Zoom', 'copyScreen', 'Capture', 'Pan'], shortcuts: {} }; }"""
        page = self.open(before=before)
        expect(page.locator('.kin-ux-tools-bar [data-tool=copyScreen]')).to_have_count(1)
        self.assertEqual(['Zoom', 'Capture', 'Pan'], self.tools(page, 'tl'))

    def test_09_the_keyboard_stays_on_a_cell_tool_while_the_rows_are_drawn_again(self):
        page = self.open()
        page.locator('#pane-bl [data-cell-tool=Angle]').focus()
        for _ in range(3):
            page.evaluate("() => { KinViewerUX.refreshCells(); document.dispatchEvent(new CustomEvent('cs-rendered', { detail: { viewportId: 'bl' } })); }")
            page.evaluate(FRAME)
        self.assertEqual('Angle', page.evaluate("document.activeElement.dataset.cellTool"))
        # The account's bar changes (another order): the rows follow, the keyboard stays on the same tool.
        page.evaluate("() => { synServer.viewerSettings = { version: 2, bar: ['Angle', 'Zoom'], shortcuts: {} }; }")
        page.locator('.kin-ux-toolbar-settings button', has_text='Reload Settings').evaluate("n => n.click()")
        page.wait_for_function("() => document.querySelectorAll('#pane-bl [data-cell-tool]').length === 2")
        self.assertEqual(['Angle', 'Zoom'], self.tools(page, 'bl'))
        self.assertEqual('Angle', page.evaluate("document.activeElement.dataset.cellTool"))


if __name__ == "__main__":
    unittest.main()
