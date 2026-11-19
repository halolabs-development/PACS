# coding: utf-8
"""A viewer window over two monitors: where the image grid is divided (viewer-display-span.js).

Runs the shipped viewer-display-layout.js and viewer-display-span.js in Chromium over a synthetic viewport grid service
and a synthetic screen-details answer (window-management already granted) for two displays meeting inside the grid's
column. The grid service can announce a layout before its state shows it, as the pinned viewer's grid does while its
state is still being rendered. Real monitors are not emulated: the same screens on a real two-monitor desktop are checked
there."""
import unittest
from pathlib import Path

from playwright.sync_api import sync_playwright

HPACS = Path(__file__).resolve().parents[1] / "worklist-v0" / "hpacs-lite"
URL = "https://span-grid.test/ohif/viewer?StudyInstanceUIDs=1.2.1"
SEAM = 700  # client x of the display edge; the image column is 100..1100, so its middle (600) is not on the edge
HARNESS = r"""<!doctype html><html><head><style>
body { margin: 0 } #column { position: absolute; left: 100px; top: 0; width: 1000px; height: 600px }
[data-cy="viewport-grid"] { position: relative; width: 100%; height: 100%; box-sizing: border-box }
[data-cy="viewport-pane"] { position: absolute; top: 0; height: 100% }
</style></head><body class="kin-viewer-ux"><div id="root"><div id="column"><div data-cy="viewport-grid"></div></div></div>
<script>
let state = { layout: { layoutType: 'grid', numRows: 1, numCols: 1 }, viewports: new Map() };
const listeners = new Set(), EVENTS = { LAYOUT_CHANGED: 'layout', GRID_STATE_CHANGED: 'grid' };
function cellsFor(rows, cols, type) {
  const cells = new Map();
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    const id = 'v' + r + c;
    cells.set(id, { viewportId: id, x: c / cols, y: r / rows, width: 1 / cols, height: 1 / rows, displaySetInstanceUIDs: ['ds-' + id],
      viewportOptions: { viewportId: id, viewportType: type } });
  }
  return cells;
}
function render() {
  const grid = document.querySelector('[data-cy="viewport-grid"]');
  grid.replaceChildren(...[...state.viewports.values()].map(cell => {
    const pane = document.createElement('div'); pane.dataset.cy = 'viewport-pane';
    pane.style.left = cell.x * 100 + '%'; pane.style.width = cell.width * 100 + '%'; return pane; }));
}
const emit = event => { for (const entry of [...listeners]) if (entry.event === event) entry.fn({}); };
window.synGrid = { EVENTS, getState: () => state,
  subscribe(event, fn) { const entry = { event, fn }; listeners.add(entry); return { unsubscribe() { listeners.delete(entry); } }; } };
// stale: the layout is announced first and its state shows a moment later, with no event after it.
window.setGrid = (rows, cols, { stale = false, type = 'stack' } = {}) => {
  const next = { layout: { layoutType: 'grid', numRows: rows, numCols: cols }, viewports: cellsFor(rows, cols, type) };
  if (stale) { emit('layout'); setTimeout(() => { state = next; render(); }, 50); return; }
  state = next; render(); emit('layout'); emit('grid');
};
// The Layout menu's command, as the pinned viewer runs it.
window.synCommands = { calls: [], runCommand(name, options) {
  this.calls.push([name, options]);
  if (name === 'setViewportGridLayout') setTimeout(() => setGrid(options.numRows, options.numCols));
  return undefined; } };
window.synHp = { protocolId: 'default' };
// The cornerstone viewport of each cell: a drawn image stack, unless the test says the cell shows no stack (a PDF or a
// report is drawn outside cornerstone) or its image is not there yet.
window.synNoStack = new Set(); window.synLoading = new Set();
const cornerstoneViewports = { getCornerstoneViewport: id => {
  const cell = state.viewports.get(id);
  if (!cell || synNoStack.has(id)) return null;
  const type = cell.viewportOptions.viewportType === 'stack' ? 'stack' : 'orthographic';
  return { type, getImageIds: () => synLoading.has(id) ? [] : ['img:' + id], getCurrentImageId: () => synLoading.has(id) ? undefined : 'img:' + id };
} };
window.synServices = { viewportGridService: synGrid, cornerstoneViewportService: cornerstoneViewports,
  hangingProtocolService: { getState: () => ({ protocolId: synHp.protocolId }) } };
window.gridBox = () => { const r = document.querySelector('[data-cy="viewport-grid"]').getBoundingClientRect(); return { left: r.left, right: r.right, middle: (r.left + r.right) / 2 }; };
window.layouts = () => synCommands.calls.filter(call => call[0] === 'setViewportGridLayout').map(call => [call[1].numRows, call[1].numCols]);
</script></body></html>"""
# Two displays side by side meeting at client x = SEAM, the access already granted.
TWO_DISPLAYS = """seamX => {
  const seam = screenX + (outerWidth - innerWidth) / 2 + seamX;
  const screens = [{ left: seam - 1600, width: 1600 }, { left: seam, width: 1600 }].map((s, i) => ({ availLeft: s.left, availTop: screenY,
    availWidth: s.width, availHeight: 2000, left: s.left, top: screenY, width: s.width, height: 2000, isPrimary: i === 0, devicePixelRatio }));
  const query = navigator.permissions.query.bind(navigator.permissions);
  navigator.permissions.query = async value => value?.name === 'window-management' ? { state: 'granted', onchange: null } : query(value);
  window.getScreenDetails = async () => ({ screens, currentScreen: screens[0], addEventListener() {}, removeEventListener() {} });
}"""
# One display under the whole window.
ONE_DISPLAY = """() => {
  const screens = [{ availLeft: screenX - 100, availTop: screenY, availWidth: 4000, availHeight: 2000, left: screenX - 100, top: screenY, width: 4000, height: 2000, isPrimary: true, devicePixelRatio }];
  const query = navigator.permissions.query.bind(navigator.permissions);
  navigator.permissions.query = async value => value?.name === 'window-management' ? { state: 'granted', onchange: null } : query(value);
  window.getScreenDetails = async () => ({ screens, currentScreen: screens[0], addEventListener() {}, removeEventListener() {} });
}"""


class DisplaySpanGridDOMTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.pw = sync_playwright().start(); cls.browser = cls.pw.chromium.launch()

    @classmethod
    def tearDownClass(cls):
        cls.browser.close(); cls.pw.stop()

    def open(self, displays=TWO_DISPLAYS, rows=1, cols=1, before=None):
        page = self.browser.new_page(viewport={'width': 1280, 'height': 700}); errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.route(URL, lambda route: route.fulfill(body=HARNESS, content_type='text/html'))
        page.goto(URL)
        for name in ('viewer-display-layout.js', 'viewer-display-span.js'):
            page.add_script_tag(path=str(HPACS / name))
        page.evaluate(displays, SEAM)
        page.evaluate('([rows, cols]) => setGrid(rows, cols)', [rows, cols])
        if before:
            page.evaluate(before)
        page.evaluate("window.synSpan = KinViewerDisplaySpan.mount({ services: synServices, commands: synCommands, enabled: () => true })")
        self.addCleanup(page.close)
        self.addCleanup(lambda: self.assertEqual([], errors))
        return page

    def on_seam(self, page):
        # Polled on a timer, not on animation frames: frames this test requests would be frames the page did not.
        page.wait_for_function('seam => Math.abs(gridBox().middle - seam) <= 0.5', arg=SEAM, timeout=4000, polling=250)

    def test_01_the_first_layout_after_stretching_is_divided_at_the_edge_even_when_announced_early(self):
        # A layout announced with its state is divided at the edge (as before).
        page = self.open(rows=2, cols=2)
        self.on_seam(page)
        # A grid with no middle edge (1 x 3) while the window is stretched over both displays; then the reader picks 4 x 2.
        page.evaluate('setGrid(1, 3)')
        page.wait_for_function('() => Math.round(gridBox().left) === 100', timeout=4000, polling=250)
        # The window has stood there a while (its first reading after mounting is long past) when the layout is picked.
        page.wait_for_timeout(1500)
        page.evaluate("setGrid(2, 4, { stale: true })")
        # The middle column edge goes onto the display edge without the reader choosing the layout again.
        self.on_seam(page)
        self.assertEqual(1100, round(page.evaluate('gridBox().right')))

    def test_02_one_column_is_one_cell_per_monitor_and_stays_so_for_another_patient(self):
        page = self.open(rows=1, cols=1)
        page.wait_for_function('() => layouts().length === 1', timeout=4000, polling=250)
        self.assertEqual([[1, 2]], page.evaluate('layouts()'))
        self.on_seam(page)
        # Another patient opens in the same window: its protocol gives one cell again; the window is still over both.
        page.wait_for_timeout(2100)
        page.evaluate('setGrid(1, 1)')
        page.wait_for_function('() => layouts().length === 2', timeout=4000, polling=250)
        self.on_seam(page)
        self.assertEqual([[1, 2], [1, 2]], page.evaluate('layouts()'))
        # Two rows in one column: two rows in two columns.
        page.wait_for_timeout(2100)
        page.evaluate('setGrid(2, 1)')
        page.wait_for_function('() => layouts().length === 3', timeout=4000, polling=250)
        self.assertEqual([2, 2], page.evaluate('layouts()')[2])

    def test_03_one_display_leaves_one_cell_alone(self):
        page = self.open(displays=ONE_DISPLAY, rows=1, cols=1)
        page.wait_for_timeout(2500)
        self.assertEqual([], page.evaluate('layouts()'))

    def test_04_what_owns_the_grid_is_left_alone(self):
        # The mammography hanging places its own cells.
        page = self.open(rows=1, cols=1, before="synHp.protocolId = 'kin.mammography.L.R'")
        page.wait_for_timeout(2500)
        self.assertEqual([], page.evaluate('layouts()'))
        # An MPR or 3D cell is not a stack.
        page = self.open(rows=1, cols=1, before="setGrid(1, 1, { type: 'volume' })")
        page.wait_for_timeout(2500)
        self.assertEqual([], page.evaluate('layouts()'))
        # Monitors in Hanging Protocol has split the grid itself.
        page = self.open(rows=1, cols=1, before="window.KinViewerMonitorRows = { copies: {} }")
        page.wait_for_timeout(2500)
        self.assertEqual([], page.evaluate('layouts()'))
        # The stock one-up's one cell (a double click it took): its own toggle puts the grid back.
        page = self.open(rows=1, cols=1, before="window.kinViewerStockOneUp = () => true")
        page.wait_for_timeout(2500)
        self.assertEqual([], page.evaluate('layouts()'))
        # A PDF (or a report) shown in a stack cell is no image stack.
        page = self.open(rows=1, cols=1, before="synNoStack.add('v00')")
        page.wait_for_timeout(2500)
        self.assertEqual([], page.evaluate('layouts()'))

    def test_06_a_cell_whose_image_comes_later_is_divided_once_it_is_drawn(self):
        page = self.open(rows=1, cols=1, before="synLoading.add('v00')")
        page.wait_for_timeout(2500)
        self.assertEqual([], page.evaluate('layouts()'))
        # The image arrives; nothing else changes in the grid.
        page.evaluate("synLoading.clear()")
        page.wait_for_function('() => layouts().length === 1', timeout=4000, polling=250)
        self.on_seam(page)

    def test_05_while_another_layout_operation_runs_the_split_waits_for_it(self):
        page = self.open(rows=1, cols=1, before="window.mergeBusy = true; window.kinCellMergeWorkspaceState = () => ({ merged: false, busy: mergeBusy })")
        page.wait_for_timeout(2500)
        self.assertEqual([], page.evaluate('layouts()'))
        page.evaluate('mergeBusy = false')
        page.wait_for_function('() => layouts().length === 1', timeout=4000, polling=250)
        self.on_seam(page)
        # A merged screen (one cell maximized) is the merge's, as are a saved Job, History, a protocol Apply or presets at work.
        for busy in ("window.kinCellMergeWorkspaceState = () => ({ merged: true, busy: false })",
                     "window.kinViewerJobWorkspaceState = () => ({ busy: true })",
                     "window.kinViewerHistoryWorkspaceState = () => ({ busy: true })",
                     "window.KinViewerHangingProtocol = { current: () => ({ busy: () => true }) }",
                     "window.KinViewerCellRules = { busy: () => true }",
                     # Auto Save View still reading or putting back the saved view of this study.
                     "window.KinViewerAutoSave = { settling: () => true }"):
            page = self.open(rows=1, cols=1, before=busy)
            page.wait_for_timeout(2500)
            self.assertEqual([], page.evaluate('layouts()'), busy)


if __name__ == '__main__':
    unittest.main()
