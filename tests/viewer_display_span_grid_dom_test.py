# coding: utf-8
"""A viewer window over two monitors: where the image grid is divided (viewer-display-span.js).

Runs the shipped viewer-display-layout.js and viewer-display-span.js in Chromium over a synthetic viewport grid service
and a synthetic screen-details answer (window-management already granted) for two displays meeting inside the grid's
column. The synthetic grid follows the pinned viewer where the rule depends on it: a layout is announced before its state
shows it; the Layout menu's command keeps the cell of every position there already is (its id, its display set, its
viewport and frame) and fills a new position with a series not shown yet, or leaves it empty; a cell whose series was
taken away keeps the image id of that series in its viewport. Real monitors are not emulated: the same screens on a real
two-monitor desktop are checked there."""
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
let state = { layout: { layoutType: 'grid', numRows: 1, numCols: 1 }, activeViewportId: null, viewports: new Map() };
const listeners = new Set(), EVENTS = { LAYOUT_CHANGED: 'layout', GRID_STATE_CHANGED: 'grid' };
// Display sets: image series (ds-*), and one PDF, which has no images of its own.
const sets = new Map(); let made = 0;
const series = uid => { if (!sets.has(uid)) sets.set(uid, { displaySetInstanceUID: uid, images: [0, 1, 2].map(n => ({ SOPInstanceUID: 'sop:' + uid + ':' + n })) }); return uid; };
sets.set('pdf-1', { displaySetInstanceUID: 'pdf-1', Modality: 'DOC' });
// Series of the study that no cell shows yet: a new position of the Layout command takes the next one.
window.synCandidates = [];
// The cornerstone viewport of each viewport id lives as long as its cell: the stack it has loaded (held), its frame, and
// whether that stack's image has arrived and is drawn.
const viewportsById = new Map();
window.synLoading = new Set(); window.synNoViewport = new Set();
function viewportFor(id, type) {
  if (!viewportsById.has(id)) viewportsById.set(id, { id, type: type === 'stack' ? 'stack' : 'orthographic', held: null, index: 0, element: document.body.appendChild(document.createElement('div')),
    getImageIds() { return this.held && !synLoading.has(id) ? [0, 1, 2].map(n => 'img:' + this.held + ':' + n) : []; },
    getCurrentImageId() { return this.held && !synLoading.has(id) ? 'img:' + this.held + ':' + this.index : undefined; },
    getCornerstoneImage() { const imageId = this.getCurrentImageId(); return imageId ? { imageId } : undefined; } });
  return viewportsById.get(id);
}
window.cornerstone = { metaData: { get: (type, imageId) => type === 'instance' && /^img:/.test(imageId || '') ? { SOPInstanceUID: 'sop:' + imageId.slice(4) } : undefined } };
function cell(col, row, cols, rows, type, uids, id) {
  const viewportId = id || 'v' + (++made), view = viewportFor(viewportId, type);
  // The viewport loads the series its cell is given; a cell given none keeps what it had loaded.
  if (uids.length && sets.get(uids[0])?.images) view.held = uids[0];
  return { viewportId, positionId: col + '-' + row, x: col / cols, y: row / rows, width: 1 / cols, height: 1 / rows, displaySetInstanceUIDs: [...uids],
    viewportOptions: { viewportId, viewportType: type } };
}
function render() {
  const grid = document.querySelector('[data-cy="viewport-grid"]');
  grid.replaceChildren(...[...state.viewports.values()].map(value => {
    const pane = document.createElement('div'); pane.dataset.cy = 'viewport-pane';
    pane.style.left = value.x * 100 + '%'; pane.style.width = value.width * 100 + '%'; return pane; }));
}
const emit = event => { for (const entry of [...listeners]) if (entry.event === event) entry.fn({}); };
window.synGrid = { EVENTS, getState: () => state,
  subscribe(event, fn) { const entry = { event, fn }; listeners.add(entry); return { unsubscribe() { listeners.delete(entry); } }; } };
function land(next, stale) {
  // stale: the layout is announced first and its state shows a moment later, with no event after it.
  if (stale) { emit('layout'); setTimeout(() => { state = next; render(); }, 50); return; }
  state = next; render(); emit('layout'); emit('grid');
}
// A protocol's layout (another patient, a rule, a saved view): new cells, each showing its own series. empty: rows left
// without a series; type: the cells' viewport type.
window.setGrid = (rows, cols, { stale = false, type = 'stack', empty = [] } = {}) => {
  const viewports = new Map();
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    const value = cell(c, r, cols, rows, type, empty.includes(r) ? [] : [series('ds-' + (++made))]);
    viewports.set(value.viewportId, value);
  }
  land({ layout: { layoutType: 'grid', numRows: rows, numCols: cols }, activeViewportId: [...viewports.keys()][0], viewports }, stale);
};
// The Layout menu's command, as the pinned viewer runs it: a moment later, every position that already has a cell keeps
// that cell (the same id, so the same viewport and frame) and a new position gets a series not shown yet, or stays empty.
window.synCommands = { calls: [], runCommand(name, options) {
  this.calls.push([name, options]);
  if (name === 'setViewportGridLayout') setTimeout(() => {
    const kept = new Map([...state.viewports.values()].map(value => [value.positionId, value])), viewports = new Map();
    for (let r = 0; r < options.numRows; r++) for (let c = 0; c < options.numCols; c++) {
      const old = kept.get(c + '-' + r), next = old ? cell(c, r, options.numCols, options.numRows, old.viewportOptions.viewportType, old.displaySetInstanceUIDs, old.viewportId)
        : cell(c, r, options.numCols, options.numRows, 'stack', synCandidates.length ? [series(synCandidates.shift())] : []);
      viewports.set(next.viewportId, next);
    }
    land({ layout: { layoutType: 'grid', numRows: options.numRows, numCols: options.numCols },
      activeViewportId: viewports.has(state.activeViewportId) ? state.activeViewportId : [...viewports.keys()][0], viewports }, false);
  });
  return undefined; } };
// Another series (or a PDF) put into one cell: the grid keeps its layout, the cell gets the new display set. A PDF is
// drawn outside cornerstone, so the cell's viewport keeps the stack it had.
window.putSet = (viewportId, uid) => {
  const old = state.viewports.get(viewportId), viewports = new Map(state.viewports);
  viewports.set(viewportId, { ...old, displaySetInstanceUIDs: uid ? [uid] : [], viewportOptions: { ...old.viewportOptions } });
  if (uid && sets.get(uid)?.images) viewportFor(viewportId).held = uid;
  state = { ...state, viewports }; emit('grid');
};
window.synHp = { protocolId: 'default' }; window.synCines = {};
window.synServices = { viewportGridService: synGrid,
  cornerstoneViewportService: { getCornerstoneViewport: id => state.viewports.has(id) && !synNoViewport.has(id) ? viewportFor(id) : null },
  displaySetService: { getDisplaySetByUID: uid => sets.get(uid) },
  cineService: { getState: () => ({ cines: synCines }) },
  hangingProtocolService: { getState: () => ({ protocolId: synHp.protocolId }) } };
window.gridBox = () => { const r = document.querySelector('[data-cy="viewport-grid"]').getBoundingClientRect(); return { left: r.left, right: r.right, middle: (r.left + r.right) / 2 }; };
window.layouts = () => synCommands.calls.filter(call => call[0] === 'setViewportGridLayout').map(call => [call[1].numRows, call[1].numCols]);
// What each cell shows now, top to bottom then left to right: [viewport id, display set, frame, active].
window.shown = () => [...state.viewports.values()].sort((a, b) => a.y - b.y || a.x - b.x).map(value => [value.viewportId, value.displaySetInstanceUIDs[0] || null,
  viewportFor(value.viewportId).index, value.viewportId === state.activeViewportId]);
window.first = () => [...state.viewports.keys()][0];
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
# Three displays side by side, two of their edges inside the image column (client x = SEAM - 250 and SEAM + 150).
THREE_DISPLAYS = """seamX => {
  const at = screenX + (outerWidth - innerWidth) / 2 + seamX;
  const screens = [{ left: at - 1850, width: 1600 }, { left: at - 250, width: 400 }, { left: at + 150, width: 1600 }].map((s, i) => ({ availLeft: s.left, availTop: screenY,
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

    def open(self, displays=TWO_DISPLAYS, rows=1, cols=1, before=None, grid=None):
        page = self.browser.new_page(viewport={'width': 1280, 'height': 700}); errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.route(URL, lambda route: route.fulfill(body=HARNESS, content_type='text/html'))
        page.goto(URL)
        for name in ('viewer-display-layout.js', 'viewer-display-span.js'):
            page.add_script_tag(path=str(HPACS / name))
        page.evaluate(displays, SEAM)
        page.evaluate(grid or '([rows, cols]) => setGrid(rows, cols)', [rows, cols])
        if before:
            page.evaluate(before)
        page.evaluate("window.synSpan = KinViewerDisplaySpan.mount({ services: synServices, commands: synCommands, enabled: () => true })")
        self.addCleanup(page.close)
        self.addCleanup(lambda: self.assertEqual([], errors))
        return page

    def on_seam(self, page):
        # Polled on a timer, not on animation frames: frames this test requests would be frames the page did not.
        page.wait_for_function('seam => Math.abs(gridBox().middle - seam) <= 0.5', arg=SEAM, timeout=4000, polling=250)

    def divided(self, page, count=1):
        page.wait_for_function('count => layouts().length === count', arg=count, timeout=4000, polling=250)

    def left_alone(self, page, message=None):
        # The page measures when it mounts, when the grid changes and once a second: this covers each of them.
        page.wait_for_timeout(1700)
        self.assertEqual([], page.evaluate('layouts()'), message)

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
        self.divided(page)
        self.assertEqual([[1, 2]], page.evaluate('layouts()'))
        self.on_seam(page)
        # Another patient opens in the same window: its protocol gives one cell again; the window is still over both.
        page.wait_for_timeout(2100)
        page.evaluate('setGrid(1, 1)')
        self.divided(page, 2)
        self.on_seam(page)
        self.assertEqual([[1, 2], [1, 2]], page.evaluate('layouts()'))
        # Two rows in one column: two rows in two columns.
        page.wait_for_timeout(2100)
        page.evaluate('setGrid(2, 1)')
        self.divided(page, 3)
        self.assertEqual([2, 2], page.evaluate('layouts()')[2])

    def test_03_one_display_leaves_one_cell_alone(self):
        page = self.open(displays=ONE_DISPLAY, rows=1, cols=1)
        self.left_alone(page)

    def test_04_what_owns_the_grid_is_left_alone(self):
        for owner, before in (
                ('the mammography hanging places its own cells', "synHp.protocolId = 'kin.mammography.L.R'"),
                ('an MPR or 3D cell is not a stack', "setGrid(1, 1, { type: 'volume' })"),
                ('Monitors in Hanging Protocol has split the grid itself', "window.KinViewerMonitorRows = { copies: {} }"),
                ("the stock one-up's one cell: its own toggle puts the grid back", "window.kinViewerStockOneUp = () => true"),
                ('no cell shows a series', "setGrid(1, 1, { empty: [0] })")):
            page = self.open(rows=1, cols=1, before=before)
            self.left_alone(page, owner)

    def test_05_while_an_operation_owns_the_screen_the_split_waits_for_it(self):
        page = self.open(rows=1, cols=1, before="window.mergeBusy = true; window.kinCellMergeWorkspaceState = () => ({ merged: false, busy: mergeBusy })")
        self.left_alone(page)
        page.evaluate('mergeBusy = false')
        self.divided(page)
        self.on_seam(page)
        # A merged screen (one cell maximized by the reader) is the merge's, as are a saved Job, History, a protocol being
        # applied or waiting for the window to reach its monitors, cell rules, Auto Save View or a patient tab putting a
        # saved view back, a patient switch and Images Only (a cell in the browser's full screen). One of them at a time
        # holds the same one column; when none does any more, it is divided.
        holders = ('merged', 'job', 'history', 'protocol', 'reaching', 'rules', 'autosave', 'tab', 'switching', 'fullscreen')
        page = self.open(rows=1, cols=1, before="""() => { window.synHolder = 'merged'; const is = name => synHolder === name;
          window.kinCellMergeWorkspaceState = () => ({ merged: is('merged'), busy: false });
          window.kinViewerJobWorkspaceState = () => ({ busy: is('job') });
          window.kinViewerHistoryWorkspaceState = () => ({ busy: is('history') });
          window.KinViewerHangingProtocol = { current: () => ({ busy: () => is('protocol') }) };
          window.KinViewerMonitors = { reaching: () => is('reaching') };
          window.KinViewerCellRules = { busy: () => is('rules') };
          window.KinViewerAutoSave = { settling: () => is('autosave') };
          window.KinViewerPatientTabs = { settling: () => is('tab') };
          Object.defineProperty(document, 'fullscreenElement', { configurable: true, get: () => is('fullscreen') ? document.body : null }); }""")
        for holder in holders:
            page.evaluate("name => { window.synHolder = name; document.body.classList.toggle('kin-patient-switching', name === 'switching'); }", holder)
            self.left_alone(page, holder)
        page.evaluate("() => { window.synHolder = null; document.body.classList.remove('kin-patient-switching'); }")
        self.divided(page)

    def test_06_a_cell_whose_image_comes_later_is_divided_once_it_is_drawn(self):
        page = self.open(rows=1, cols=1, before="synLoading.add(first())")
        self.left_alone(page)
        # The image arrives; nothing else changes in the grid.
        page.evaluate("synLoading.clear()")
        self.divided(page)
        self.on_seam(page)

    def test_07_an_empty_cell_does_not_keep_the_series_above_it_across_the_edge_and_stays_empty(self):
        # Two rows in one column, a series on top and nothing below; the reader is on the third image of that series.
        page = self.open(grid="() => { setGrid(2, 1, { empty: [1] }); synCandidates.push('ds-next'); }",
                         before="synServices.cornerstoneViewportService.getCornerstoneViewport(first()).index = 2")
        before = page.evaluate('shown()')
        self.assertEqual([None, 0, False], before[1][1:])
        self.divided(page)
        self.assertEqual([[2, 2]], page.evaluate('layouts()'))
        self.on_seam(page)
        after = page.evaluate('shown()')
        # Top left: the same cell, the same series, the same image, still the active cell. Below it: still empty. (The
        # Layout command may put a series not shown yet into the new column.)
        self.assertEqual(before[0], after[0])
        self.assertEqual([None, False], [after[2][1], after[2][3]])
        self.assertEqual(4, len(after))

    def test_08_a_pdf_or_a_series_still_loading_in_a_cell_that_showed_a_series_is_not_divided(self):
        # The cell showed a series; a PDF took its place. The viewport still holds the image id of that series.
        page = self.open(rows=1, cols=1, before="putSet(first(), 'pdf-1')")
        self.left_alone(page, 'a PDF over the image id of the series shown before')
        # A new series was dropped on the cell and its first image is not there yet; the old one's id is.
        page = self.open(rows=1, cols=1, before="""() => { const id = first(), old = state.viewports.get(id).displaySetInstanceUIDs[0];
          putSet(id, series('ds-late')); synServices.cornerstoneViewportService.getCornerstoneViewport(id).held = old; }""")
        self.left_alone(page, 'a new series over the image id of the series shown before')
        # Its image arrives: now it is that series, drawn.
        page.evaluate("synServices.cornerstoneViewportService.getCornerstoneViewport(first()).held = 'ds-late'")
        self.divided(page)

    def test_09_a_playing_cine_is_left_alone_and_divided_once_it_stops(self):
        page = self.open(rows=1, cols=1, before="synCines.a = { isPlaying: true }")
        self.left_alone(page)
        page.evaluate("synCines.a.isPlaying = false")
        self.divided(page)
        self.on_seam(page)
        # Once: the grid now has its middle edge on the display edge.
        page.wait_for_timeout(2500)
        self.assertEqual([[1, 2]], page.evaluate('layouts()'))

    def test_10_the_cell_the_reader_enlarged_is_divided_only_once_it_is_no_longer_that(self):
        # The stock one-up's cell stays one; when another layout takes its place (the answer changes), the one column is divided.
        page = self.open(rows=1, cols=1, before="window.synOneUp = true; window.kinViewerStockOneUp = () => synOneUp")
        self.left_alone(page)
        page.evaluate("synOneUp = false; setGrid(1, 1)")
        self.divided(page)

    def test_11_three_displays_under_the_images_no_pair_is_guessed(self):
        page = self.open(displays=THREE_DISPLAYS, rows=1, cols=1)
        self.left_alone(page)


if __name__ == '__main__':
    unittest.main()
