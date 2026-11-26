# coding: utf-8
"""Monitors in Hanging Protocol on the shipped viewer chrome: the window opened from Viewer Settings (one row of choices
and one drawing per monitor, Save into a Hanging Protocol rule), and what an applied rule does to this window: the rows
stand on their monitor's part of the window (the real toolbar, with Viewer Settings, on the first monitor that shows
one), the other display gets fixed copies, Second Display keeps the patient tabs only, the worklist window's place is
read and reported, and everything goes back to the account's Toolbar & Thumbnail Position afterwards.

Runs the shipped viewer-ux-shell.js, viewer-series-strip.js, viewer-ux-toolbar.js, viewer-features.js,
viewer-features-chrome.js, viewer-features-monitors.js, viewer-display-layout.js, viewer-display-span.js,
hanging-protocol-model.js and viewer-ux-theme.css in the synthetic stock column of viewer_chrome_position_dom_test.py,
with a synthetic Hanging Protocols panel handle and, where two displays are needed, a synthetic screen-details answer
(window-management already granted) for two displays meeting in the middle of this window. Real monitors are not
emulated: the actual move of a window between two physical displays is checked on a real desktop."""
import json
import unittest
from urllib.parse import parse_qs, urlparse

from playwright.sync_api import sync_playwright, expect

from viewer_chrome_position_dom_test import BOXES, FRAME, HARNESS, HPACS, MANY_TOOLS, ORIGIN, OWNER, SETUP, TOOLS

RULE_ID = '11111111-1111-4111-8111-111111111111'
OTHER_ID = '22222222-2222-4222-8222-222222222222'


def monitor(images, **extra):
    return dict({'images': images, 'worklist': 'none', 'thumbs': 'top', 'toolbar': 'top'}, **extra)


def hp_rule(rule_id, name, monitors=None):
    value = {'id': rule_id, 'name': name, 'enabled': True, 'match': {'modality': None, 'retrieveAE': None, 'bodyPart': None, 'description': None},
             'selectors': [{'alias': 'Current', 'role': 'current', 'historical': False, 'modality': None, 'retrieveAE': None, 'bodyPart': None,
                            'description': None, 'laterality': None, 'order': 'ascending', 'occurrence': 1}],
             'layout': {'rows': 2, 'cols': 2, 'cells': ['Current', 'Current', 'Current', 'Current']}}
    if monitors:
        value['monitors'] = {'count': len(monitors), 'list': monitors}
    return value


HP = """([library, applied]) => {
  window.synLibrary = library; window.synApplied = applied; window.synSavedMonitors = [];
  window.KinViewerHangingProtocol = { current: () => ({ scope: () => 'personal', read: () => structuredClone(synLibrary),
    applied: () => synApplied && structuredClone(synApplied), selected: () => synLibrary.rules[0]?.id || null,
    saveMonitors: async (id, monitors) => { synSavedMonitors.push([id, structuredClone(monitors)]);
      const rule = synLibrary.rules.find(r => r.id === id); if (monitors) rule.monitors = monitors; else delete rule.monitors;
      return { ok: true, account: 'saved' }; } }) };
}"""

# Two displays side by side, each half of this window, the window-management permission already granted.
TWO_DISPLAYS = """() => {
  const half = innerWidth / 2, at = screenX + (outerWidth - innerWidth) / 2;
  const screens = [0, 1].map(i => ({ availLeft: at + i * half, availTop: screenY, availWidth: half, availHeight: 2000,
    left: at + i * half, top: screenY, width: half, height: 2000, isPrimary: i === 0, devicePixelRatio: devicePixelRatio }));
  window.synScreens = screens.map(s => ({ left: s.left, top: s.top, width: s.width, height: s.height }));
  const query = navigator.permissions.query.bind(navigator.permissions);
  navigator.permissions.query = async value => value?.name === 'window-management' ? { state: 'granted', onchange: null } : query(value);
  window.getScreenDetails = async () => ({ screens, currentScreen: screens[0], addEventListener() {}, removeEventListener() {} });
}"""

# Two displays side by side meeting left of the window's middle (client x = SEAM), as over a viewer whose side panel is
# open on one side only: a plain grid's middle edge is not on the display edge. The access is already granted.
SEAM = 600
OFF_MIDDLE = """seam => {
  const at = screenX + (outerWidth - innerWidth) / 2 + seam;
  const screens = [{ left: at - 1600, width: 1600 }, { left: at, width: 1600 }].map((s, i) => ({ availLeft: s.left, availTop: screenY,
    availWidth: s.width, availHeight: 2000, left: s.left, top: screenY, width: s.width, height: 2000, isPrimary: i === 0, devicePixelRatio }));
  window.synSeam = seam;
  const query = navigator.permissions.query.bind(navigator.permissions);
  navigator.permissions.query = async value => value?.name === 'window-management' ? { state: 'granted', onchange: null } : query(value);
  window.getScreenDetails = async () => ({ screens, currentScreen: screens[0], addEventListener() {}, removeEventListener() {} });
}"""

# One display, and the browser says so.
ONE_DISPLAY = "() => { Object.defineProperty(screen, 'isExtended', { configurable: true, get: () => false }); }"

# Monitor 1 is this window's display and monitor 2 the one to its right, each as wide as the window is at first: a
# browser does not move the window over both. The access given (synPermission) and the displays (synScreens) are the
# browser's live answers, so a case can change them afterwards.
BESIDE = """() => {
  const at = screenX + (outerWidth - innerWidth) / 2, w = innerWidth;
  window.synScreens = [0, 1].map(i => ({ availLeft: at + i * w, availTop: screenY, availWidth: w, availHeight: 2000,
    left: at + i * w, top: screenY, width: w, height: 2000, isPrimary: i === 0, devicePixelRatio }));
  window.synPermission = { state: 'granted', onchange: null };
  const query = navigator.permissions.query.bind(navigator.permissions);
  navigator.permissions.query = async value => value?.name === 'window-management' ? synPermission : query(value);
  window.getScreenDetails = async () => ({ get screens() { return synScreens; }, get currentScreen() { return synScreens.find(s => s.isPrimary) || synScreens[0]; },
    addEventListener() {}, removeEventListener() {} });
}"""


# A viewport grid that follows the pinned viewer (OHIF v3.9.1) where laying cells depends on it, in place of the harness's
# static one: setLayout builds one cell per position (layoutOptions: those rectangles; else the plain grid), each from
# what findOrCreateViewport answers (the same viewport id keeps its viewport - two positions answered with one id are
# one cell). The Layout menu's command (setViewportGridLayout in the DEFAULT context, which a module may wrap) is the
# stock one: it remembers every cell there is by its place key - for good, as the pinned store does - builds the plain
# grid, puts into each position the cell remembered for its key, and fills a position with none as the default
# protocol does (getMissingViewport: the study's next series not on screen, or nothing); synStock lists the picks it
# ran. A layout lands a moment later and is announced. Each cell's viewport has drawn the first image of the series it
# shows (synLoading: not yet). synApplySplit lays a rule's split as Hanging Protocols does (each rectangle with its
# place key, and registers it, kinViewerSplitRects); synMenu picks a layout from the Layout menu.
GRID = """() => {
  const listeners = new Set(), views = new Map(); let made = 0;
  window.synSets = new Map();
  const series = uid => { if (!synSets.has(uid)) synSets.set(uid, { displaySetInstanceUID: uid, images: [0, 1, 2].map(n => ({ SOPInstanceUID: 'sop:' + uid + ':' + n })) }); return uid; };
  const viewport = id => { if (!views.has(id)) views.set(id, { id, type: 'stack', held: null, loading: false, element: document.body.appendChild(document.createElement('div')),
      getImageIds() { return this.held ? [0, 1, 2].map(n => 'img:' + this.held + ':' + n) : []; },
      getCurrentImageId() { return this.held ? 'img:' + this.held + ':0' : undefined; },
      getCornerstoneImage() { const imageId = this.getCurrentImageId(); return imageId && !this.loading ? { imageId } : undefined; } });
    return views.get(id); };
  // A cell whose series is still loading: its image is not drawn yet.
  window.synLoading = (id, loading = true) => { viewport(id).loading = loading; };
  const entry = (id, rect, positionId, sets, options) => { if (sets.length) viewport(id).held = sets[0];
    return { viewportId: id, positionId, x: rect.x, y: rect.y, width: rect.width, height: rect.height, displaySetInstanceUIDs: [...sets],
      displaySetOptions: sets.map(() => ({})), viewportOptions: { viewportType: 'stack', ...options, viewportId: id } }; };
  const plainRects = (rows, cols) => Array.from({ length: rows * cols }, (_, i) => ({ x: (i % cols) / cols, y: Math.floor(i / cols) / rows, width: 1 / cols, height: 1 / rows }));
  let state = { layout: { layoutType: 'grid', numRows: 1, numCols: 1 }, activeViewportId: 'v0', viewports: new Map() };
  state.viewports.set('v0', entry('v0', plainRects(1, 1)[0], '0-0', [series('ds-1')], {}));
  const land = next => setTimeout(() => { state = next; for (const fn of [...listeners]) fn({}); });
  window.synLayouts = [];
  const grid = { EVENTS: { LAYOUT_CHANGED: 'layout', GRID_STATE_CHANGED: 'grid' }, getState: () => state,
    subscribe(event, fn) { listeners.add(fn); return { unsubscribe() { listeners.delete(fn); } }; },
    getActiveViewportId: () => state.activeViewportId, setActiveViewportId() {},
    setLayout({ numRows, numCols, layoutOptions, findOrCreateViewport, activeViewportId }) {
      synLayouts.push({ numRows, numCols, layoutOptions: layoutOptions ? structuredClone(layoutOptions) : null, active: activeViewportId ?? null });
      const viewports = new Map();
      // As the pinned grid: a position's key is its option's positionId, or else its place rounded to the grid.
      const shared = {};
      (layoutOptions || plainRects(numRows, numCols)).forEach((rect, index) => {
        const positionId = rect.positionId || Math.round(rect.x * numCols) + '-' + Math.round(rect.y * numRows);
        const asked = findOrCreateViewport(index, positionId, shared) || {};
        const id = asked.viewportOptions?.viewportId || 'v' + (++made);
        viewports.set(id, entry(id, rect, positionId, asked.displaySetInstanceUIDs || [], asked.viewportOptions || {}));
      });
      land({ layout: { layoutType: 'grid', numRows, numCols }, activeViewportId: viewports.has(activeViewportId) ? activeViewportId : [...viewports.keys()][0], viewports });
      return Promise.resolve();
    } };
  // The study's series, in the order the default protocol offers them to a new cell.
  window.synStudy = ['ds-1', 'ds-2', 'ds-3', 'ds-4', 'ds-5', 'ds-6', 'ds-7', 'ds-8'];
  const protocols = { getState: () => ({ protocolId: 'default', stageIndex: 0 }),
    getMissingViewport(protocolId, stage, options) { const uid = synStudy.find(value => !options.inDisplay.includes(value));
      return { viewportOptions: { viewportType: 'stack', toolGroupId: 'default', allowUnmatchedView: true }, displaySetsInfo: uid ? [{ displaySetInstanceUID: series(uid), displaySetOptions: {} }] : [] }; } };
  const byPosition = {}, inDisplay = [];
  window.synStock = [];
  const stock = { commandFn({ numRows, numCols }) { setTimeout(() => {
    synStock.push([numRows, numCols]);
    const now = {};
    for (const cell of state.viewports.values()) if (cell.positionId) now[cell.positionId] = byPosition[cell.positionId] = { ...cell, viewportOptions: { ...cell.viewportOptions } };
    for (let row = 0; row < numRows; row++) for (let col = 0; col < numCols; col++) inDisplay.push(...(now[col + '-' + row]?.displaySetInstanceUIDs || []));
    grid.setLayout({ numRows, numCols, findOrCreateViewport: (index, positionId, options) => {
      const old = byPosition[positionId];
      if (old) return { ...old };
      if (!options.inDisplay) options.inDisplay = [...inDisplay];
      const missing = protocols.getMissingViewport('default', 0, options), sets = missing.displaySetsInfo.map(info => info.displaySetInstanceUID);
      options.inDisplay.push(...sets);
      return { displaySetInstanceUIDs: sets, displaySetOptions: missing.displaySetsInfo.map(info => info.displaySetOptions), viewportOptions: { ...missing.viewportOptions } }; } });
  }, 0); } };
  const contexts = { DEFAULT: { setViewportGridLayout: stock } };
  window.synLayoutCommands = { getCommand: (name, context = 'DEFAULT') => contexts[context]?.[name],
    registerCommand(context, name, definition) { (contexts[context] ||= {})[name] = definition; },
    runCommand(name, options) { return this.getCommand(name)?.commandFn(options); } };
  window.synMenu = (rows, cols) => synLayoutCommands.runCommand('setViewportGridLayout', { numRows: rows, numCols: cols });
  // Another series put into one cell (dragged from the strip): the layout stays, the cell shows the new set.
  window.putSeries = (id, uid) => { const viewports = new Map(state.viewports), old = viewports.get(id);
    viewports.set(id, { ...old, displaySetInstanceUIDs: [series(uid)], displaySetOptions: [{}] }); viewport(id).held = uid;
    state = { ...state, viewports }; for (const fn of [...listeners]) fn({}); };
  window.synApplySplit = split => { window.kinViewerSplitRects = structuredClone(split.rects);
    grid.setLayout({ numRows: split.numRows, numCols: split.numCols, activeViewportId: 'hp-0',
      layoutOptions: split.rects.map((rect, i) => split.positions ? { ...rect, positionId: split.positions[i] } : rect),
      findOrCreateViewport: index => ({ displaySetInstanceUIDs: split.cells[index] === null ? [] : [series('ds-hp-' + index)], viewportOptions: { viewportId: 'hp-' + index } }) }); };
  // Each cell as client px, top to bottom then left to right: [id, left, top, right, bottom, display set].
  window.synCells = () => { const g = document.querySelector('[data-cy=viewport-grid]').getBoundingClientRect();
    return [...state.viewports.values()].sort((a, b) => a.y - b.y || a.x - b.x).map(c => [c.viewportId, g.left + c.x * g.width, g.top + c.y * g.height,
      g.left + (c.x + c.width) * g.width, g.top + (c.y + c.height) * g.height, c.displaySetInstanceUIDs[0] || null]); };
  // One cell takes the whole of its monitor's cells' area, as the double click's maximize leaves the screen: the other
  // cells of that monitor are gone, every other cell stays (same viewports, same place keys).
  window.synEnlarge = id => { const seam = synSeam / innerWidth, cells = [...state.viewports.values()], it = state.viewports.get(id), side = c => c.x + c.width / 2 > seam;
    const mates = cells.filter(c => side(c) === side(it)), x = Math.min(...mates.map(c => c.x)), y = Math.min(...mates.map(c => c.y));
    const area = { x, y, width: Math.max(...mates.map(c => c.x + c.width)) - x, height: Math.max(...mates.map(c => c.y + c.height)) - y };
    const kept = cells.filter(c => c === it || !mates.includes(c));
    grid.setLayout({ numRows: state.layout.numRows, numCols: state.layout.numCols, activeViewportId: id,
      layoutOptions: kept.map(c => ({ ...(c === it ? area : { x: c.x, y: c.y, width: c.width, height: c.height }), positionId: c.positionId })),
      findOrCreateViewport: index => ({ displaySetInstanceUIDs: kept[index].displaySetInstanceUIDs, viewportOptions: kept[index].viewportOptions }) }); };
  // The place key of each cell, in the order the native grid lists them.
  window.synOrder = () => [...state.viewports.values()].map(c => c.positionId);
  window.synGridState = () => ({ rows: state.layout.numRows, cols: state.layout.numCols, rects: [...state.viewports.values()].map(c => ({ x: c.x, y: c.y, width: c.width, height: c.height })) });
  Object.assign(synServices, { viewportGridService: grid,
    cornerstoneViewportService: { ...synServices.cornerstoneViewportService, getCornerstoneViewport: id => state.viewports.has(id) ? viewport(id) : null },
    displaySetService: { ...synServices.displaySetService, getDisplaySetByUID: uid => synSets.get(uid), getActiveDisplaySets: () => synStudy.map(uid => synSets.get(series(uid))) },
    cineService: { getState: () => ({ cines: {} }) }, hangingProtocolService: protocols });
  cornerstone.metaData.get = (type, imageId) => type === 'instance' && /^img:/.test(imageId || '') ? { SOPInstanceUID: 'sop:' + imageId.slice(4) } : null;
  // The browser of a desktop with two displays says it has more than one.
  Object.defineProperty(screen, 'isExtended', { configurable: true, get: () => true });
}"""


class MonitorHangingDOMTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.pw = sync_playwright().start(); cls.browser = cls.pw.chromium.launch()

    @classmethod
    def tearDownClass(cls):
        cls.browser.close(); cls.pw.stop()

    def open(self, library=None, applied=None, displays=ONE_DISPLAY, settings=None, second=True, size=(1366, 900), tools=TOOLS, grid=None):
        context = self.browser.new_context(viewport={'width': size[0], 'height': size[1]})
        page = context.new_page(); errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.route(ORIGIN + "/", lambda route: route.fulfill(body=HARNESS, content_type="text/html"))
        page.goto(ORIGIN + "/")
        page.add_style_tag(path=str(HPACS / "viewer-ux-theme.css"))
        for name in ["hanging-protocol-model.js", "viewer-display-layout.js", "viewer-ux-shortcuts.js", "viewer-features.js", "viewer-features-chrome.js",
                     "viewer-features-monitors.js", "viewer-ux-toolbar.js", "viewer-series-strip.js", "viewer-display-span.js", "viewer-ux-shell.js"]:
            page.add_script_tag(path=str(HPACS / name))
        page.evaluate(SETUP, [OWNER, tools, 4])
        page.evaluate("settings => { synServer.viewerSettings = settings; }", settings)
        page.evaluate(HP, [library or {'version': 1, 'activeRuleId': None, 'rules': [hp_rule(RULE_ID, 'Brain CT'), hp_rule(OTHER_ID, 'Chest CT')]}, applied])
        if displays:
            # A script, or a script and its argument.
            page.evaluate(*displays) if isinstance(displays, tuple) else page.evaluate(displays)
        page.evaluate("() => synMount()")
        expect(page.locator('.kin-ux-toolbar-slot > .kin-ux-toolbar')).to_have_count(1)
        expect(page.locator('.kin-series-card')).to_have_count(4)
        page.wait_for_function("KinViewerFeatures.settings().some(s => s.id === 'monitorHanging')")
        # grid: a synthetic viewport grid (and the Layout menu's command) put in place of the static one.
        if grid:
            page.evaluate(grid)
        page.evaluate("""second => { window.synSecond = second;
          window.synSpan = KinViewerDisplaySpan.mount({ services: synServices, commands: window.synLayoutCommands || null, enabled: () => synSecond }); }""", second)
        page.evaluate(FRAME)
        self.addCleanup(context.close)
        self.addCleanup(lambda: self.assertEqual([], errors))
        return page

    def window(self, page):
        dialog = page.locator('dialog.kin-ux-settings')
        if not dialog.evaluate('n => n.open'):
            page.get_by_role('button', name='Viewer Settings').click()
        dialog.locator('.kin-ux-feature-setting-buttons').get_by_role('button', name='Monitors in Hanging Protocol…').click()
        panel = page.locator('dialog.kin-ux-feature-panel[aria-label="Monitors in Hanging Protocol"]')
        expect(panel).to_be_visible()
        return panel

    def prepare(self, page, monitors, list_rect='absent'):
        if list_rect != 'absent':
            page.evaluate("rect => { window.kinViewerListPlace = async () => rect; }", list_rect)
        result = page.evaluate("""async rule => { const answer = await KinViewerMonitors.prepare(rule);
          window.synAnswer = answer; return { split: answer.split, note: answer.note }; }""", hp_rule(RULE_ID, 'Brain CT', monitors))
        page.evaluate(FRAME); page.evaluate(FRAME)
        return result

    # ── The window (the stories' steps: choose 2 monitors, change the second monitor's thumbnails, Close) ──
    def test_01_one_row_and_one_drawing_per_monitor_and_close_returns_to_viewer_settings(self):
        page = self.open()
        panel = self.window(page)
        expect(panel.get_by_label('Hanging Protocol')).to_have_value(RULE_ID)
        expect(panel.get_by_label('Monitors')).to_have_value('1')
        expect(panel.locator('table tr').first.locator('th')).to_have_text(['Monitor', 'Images', 'Worklist', 'Thumbnails', 'Toolbar'])
        options = lambda label: panel.get_by_label(label).locator('option').evaluate_all('n => n.map(o => o.textContent)')
        self.assertEqual(['None', '1 × 1', '1 × 2', '2 × 1', '2 × 2', 'Automatic'], options('Monitor 1 Images'))
        self.assertEqual(['Show', 'None'], options('Monitor 1 Worklist'))
        self.assertEqual(['Top', 'Bottom', 'Left', 'Right', 'None'], options('Monitor 1 Thumbnails'))
        self.assertEqual(['Top', 'Bottom', 'Left', 'Right', 'None'], options('Monitor 1 Toolbar'))
        panel.get_by_label('Monitors').select_option('2')
        drawings = panel.locator('.kin-chrome-monitor')
        expect(drawings).to_have_count(2)
        expect(panel.get_by_label('Monitor 2 Thumbnails')).to_be_visible()
        first = drawings.nth(0).get_attribute('aria-label')
        panel.get_by_label('Monitor 2 Images').select_option('2x2')
        panel.get_by_label('Monitor 2 Thumbnails').select_option('left')
        self.assertEqual(first, drawings.nth(0).get_attribute('aria-label'), 'only the second drawing changes')
        expect(drawings.nth(1)).to_have_attribute('aria-label', 'Monitor 2: Images 2 × 2, Worklist None, Thumbnails Left, Toolbar Top')
        expect(drawings.nth(1).locator('.kin-chrome-thumbs')).to_have_count(1)
        expect(drawings.nth(1).locator('.kin-chrome-images > div')).to_have_count(4)
        # Nothing moved: no rule was saved or applied.
        self.assertEqual([], page.evaluate('synSavedMonitors'))
        self.assertIsNone(page.evaluate("document.body.getAttribute('data-kin-monitor-rows')"))
        panel.get_by_role('button', name='Close').click()
        expect(panel).to_have_count(0)
        settings = page.locator('dialog.kin-ux-settings')
        expect(settings).to_be_visible()
        expect(settings.get_by_role('button', name='Monitors in Hanging Protocol…')).to_be_visible()
        expect(settings.get_by_role('button', name='Save')).to_be_visible()

    def test_02_save_keeps_the_monitors_in_the_chosen_rule(self):
        page = self.open()
        panel = self.window(page)
        panel.get_by_label('Hanging Protocol').select_option(OTHER_ID)
        panel.get_by_label('Monitors').select_option('2')
        panel.get_by_label('Monitor 1 Images').select_option('none')
        panel.get_by_label('Monitor 1 Worklist').select_option('show')
        panel.get_by_label('Monitor 1 Thumbnails').select_option('none')
        panel.get_by_label('Monitor 1 Toolbar').select_option('none')
        panel.get_by_label('Monitor 2 Images').select_option('1x2')
        panel.get_by_label('Monitor 2 Thumbnails').select_option('left')
        panel.get_by_role('button', name='Save').click()
        expect(panel.get_by_role('status')).to_contain_text('Hanging Protocol "Chest CT"에 이 브라우저와 계정 모두 저장했습니다')
        self.assertEqual([[OTHER_ID, {'count': 2, 'list': [monitor('none', worklist='show', thumbs='none', toolbar='none'), monitor('1x2', thumbs='left')]}]],
                         page.evaluate('synSavedMonitors'))
        # The worklist window is one: Show on monitor 2 takes it from monitor 1.
        panel.get_by_label('Monitor 2 Worklist').select_option('show')
        expect(panel.get_by_label('Monitor 1 Worklist')).to_have_value('none')
        # Reopened, the window shows what the rule holds.
        panel.get_by_role('button', name='Close').click()
        panel = self.window(page)
        panel.get_by_label('Hanging Protocol').select_option(OTHER_ID)
        expect(panel.get_by_label('Monitors')).to_have_value('2')
        expect(panel.get_by_label('Monitor 2 Images')).to_have_value('1x2')

    def test_03_save_refuses_monitors_without_a_toolbar(self):
        page = self.open()
        panel = self.window(page)
        panel.get_by_label('Monitor 1 Toolbar').select_option('none')
        panel.get_by_role('button', name='Save').click()
        expect(panel.get_by_role('status')).to_have_text('Viewer Settings에 돌아갈 수 있도록, 영상을 보이는 모니터 하나에는 도구 줄(Toolbar)이 있어야 합니다.')
        self.assertEqual([], page.evaluate('synSavedMonitors'))

    # ── An applied rule on this window ──
    def test_04_one_display_rows_on_their_edges_and_the_images_split_around_them(self):
        page = self.open()
        result = self.prepare(page, [monitor('2x1', thumbs='left', toolbar='bottom')])
        self.assertIn('적용 Monitor 1.', result['note'])
        split = result['split']
        self.assertEqual(2, len(split['rects'])); self.assertEqual([0, 1], split['cells'])
        boxes = page.evaluate(BOXES)
        column, toolbar, thumbs = boxes['column'], boxes['toolbar'], boxes['thumbs']
        self.assertAlmostEqual(column['bottom'], toolbar['bottom'], delta=1); self.assertAlmostEqual(36, toolbar['height'], delta=1)
        self.assertAlmostEqual(column['width'], toolbar['width'], delta=1)
        self.assertAlmostEqual(column['left'], thumbs['left'], delta=1); self.assertAlmostEqual(156, thumbs['width'], delta=1)
        self.assertAlmostEqual(toolbar['top'], thumbs['bottom'], delta=1, msg='the strip stands inside the toolbar')
        # The images' rectangles leave both bands free.
        grid = boxes['grid']
        for rect in split['rects']:
            self.assertGreaterEqual(grid['left'] + rect['x'] * grid['width'] + 0.5, thumbs['right'])
            self.assertLessEqual(grid['top'] + (rect['y'] + rect['height']) * grid['height'] - 0.5, toolbar['top'])
        self.assertEqual('', page.evaluate("document.body.getAttribute('data-kin-monitor-rows')"))
        # Undo puts back the account's rows exactly.
        page.evaluate('synAnswer.undo()'); page.evaluate(FRAME)
        self.assertIsNone(page.evaluate("document.body.getAttribute('data-kin-monitor-rows')"))
        self.assertEqual([], page.evaluate("() => [...document.body.attributes].map(a => a.name).filter(n => n.startsWith('data-kin'))"))

    def test_05_the_account_value_waits_while_a_rule_places_the_rows_and_returns_after(self):
        page = self.open(settings={'version': 2, 'bar': ['WindowLevel', 'Pan', 'Zoom'], 'shortcuts': {},
                                   'features': {'chrome': {'toolbar': 'right', 'toolbarAutoHide': False, 'thumbs': 'left', 'thumbsAutoHide': False}}})
        expect(page.locator('body')).to_have_attribute('data-kin-toolbar-side', 'right')
        self.prepare(page, [monitor('1x1', thumbs='bottom', toolbar='top')])
        page.evaluate('synAnswer.commit()')
        expect(page.locator('body')).to_have_attribute('data-kin-toolbar-side', 'top')
        # A rule without monitors applied afterwards (Hanging Protocols calls clear()): the account's rows come back.
        page.evaluate('KinViewerMonitors.clear()'); page.evaluate(FRAME)
        expect(page.locator('body')).to_have_attribute('data-kin-toolbar-side', 'right')
        expect(page.locator('body')).not_to_have_attribute('data-kin-monitor-rows', '')

    def test_06_two_displays_the_real_toolbar_stands_on_the_monitor_that_shows_one(self):
        page = self.open(displays=TWO_DISPLAYS)
        result = self.prepare(page, [monitor('1x1', toolbar='none', thumbs='none'), monitor('2x2', toolbar='top', thumbs='right')])
        self.assertIn('적용 Monitor 1·Monitor 2.', result['note'])
        split = result['split']
        self.assertEqual(5, len(split['rects']))
        boxes = page.evaluate(BOXES)
        half = (boxes['column']['left'] + boxes['column']['right']) / 2
        self.assertAlmostEqual(half, boxes['toolbar']['left'], delta=1, msg='the toolbar is on monitor 2 only')
        self.assertAlmostEqual(boxes['column']['right'], boxes['toolbar']['right'], delta=1)
        self.assertAlmostEqual(boxes['column']['right'], boxes['thumbs']['right'], delta=1)
        settings = page.get_by_role('button', name='Viewer Settings')
        self.assertGreaterEqual(settings.bounding_box()['x'], half - 1, 'Viewer Settings is reached on monitor 2')
        # Monitor 1's cell fills its half; no copy of a row that only one monitor shows.
        self.assertIn({'x': 0, 'y': 0, 'width': 0.5, 'height': 1}, split['rects'])
        expect(page.locator('.kin-span-fixed')).to_have_count(0)
        # The grid is not shifted to the seam by the span module while the rule holds it.
        self.assertEqual([], page.evaluate("() => [...document.querySelectorAll('style')].map(s => s.textContent).filter(t => t.includes('[data-cy=\"viewport-grid\"] { margin-left'))"))

    def test_07_two_displays_the_other_monitor_gets_fixed_copies_and_second_display_keeps_only_the_tabs(self):
        page = self.open(displays=TWO_DISPLAYS, second=False)
        self.prepare(page, [monitor('1x2', toolbar='top', thumbs='left'), monitor('1x2', toolbar='bottom', thumbs='right')])
        tools = page.locator('.kin-span-fixed[aria-label="Image Tools (Second Display)"]')
        series = page.locator('.kin-span-fixed[aria-label="Series (Second Display)"]')
        expect(tools).to_have_count(1); expect(series).to_have_count(1)
        expect(tools).to_be_visible(); expect(series).to_be_visible()
        boxes = page.evaluate(BOXES)
        half = (boxes['column']['left'] + boxes['column']['right']) / 2
        tbox, sbox = tools.bounding_box(), series.bounding_box()
        self.assertAlmostEqual(half, tbox['x'], delta=1); self.assertAlmostEqual(boxes['column']['bottom'], tbox['y'] + tbox['height'], delta=1)
        self.assertAlmostEqual(boxes['column']['right'], sbox['x'] + sbox['width'], delta=1); self.assertAlmostEqual(156, sbox['width'], delta=1)
        self.assertLessEqual(boxes['toolbar']['right'], half + 1, 'the original toolbar stays on monitor 1')
        # A copy forwards to the original control.
        page.evaluate("() => { window.synPan = 0; document.querySelector('.kin-ux-toolbar-slot [data-tool=Pan]').addEventListener('click', () => synPan++); }")
        tools.get_by_role('button', name='Pan').click()
        self.assertEqual(1, page.evaluate('synPan'))
        # Second Display is off: the patient tabs have no copy, the rows the rule places do.
        expect(page.locator('.kin-span-mirror[aria-label="Patients (Second Display)"]')).to_have_count(0)
        # Back to the account's rows: the fixed copies go, and Second Display off again takes every copy.
        page.evaluate('synAnswer.undo()'); page.evaluate(FRAME); page.evaluate(FRAME)
        expect(page.locator('.kin-span-fixed')).to_have_count(0)

    def laid_on_monitors(self, page, each):
        """Every cell lies on one monitor's image area - none across the display edge, none under a row - and the cells of
        each monitor fill its area: `each` cells per monitor."""
        boxes, cells = page.evaluate(BOXES), page.evaluate('synCells()')
        seam = page.evaluate('window.synSeam ?? innerWidth / 2')
        copies = page.locator('.kin-span-fixed').evaluate_all('n => n.map(e => e.getBoundingClientRect().bottom)')
        state = json.dumps({'cells': cells, 'seam': seam, 'boxes': boxes})
        one = [c for c in cells if c[3] <= seam + 0.5]
        two = [c for c in cells if c[1] >= seam - 0.5]
        self.assertEqual(len(cells), len(one) + len(two), 'a cell lies across the display edge: ' + state)
        self.assertEqual([each, each], [len(one), len(two)], state)
        # Monitor 1: the strip on its left, the toolbar at its bottom.
        self.assertAlmostEqual(boxes['thumbs']['right'], min(c[1] for c in one), delta=1, msg=state)
        self.assertAlmostEqual(seam, max(c[3] for c in one), delta=1, msg=state)
        self.assertAlmostEqual(boxes['grid']['top'], min(c[2] for c in one), delta=1, msg=state)
        self.assertAlmostEqual(boxes['toolbar']['top'], max(c[4] for c in one), delta=1, msg=state)
        # Monitor 2: the copies of the toolbar and the strip on its top.
        self.assertAlmostEqual(seam, min(c[1] for c in two), delta=1, msg=state)
        self.assertAlmostEqual(boxes['grid']['right'], max(c[3] for c in two), delta=1, msg=state)
        self.assertAlmostEqual(max(copies), min(c[2] for c in two), delta=1, msg=state)
        self.assertAlmostEqual(boxes['grid']['bottom'], max(c[4] for c in two), delta=1, msg=state)
        return cells

    def on_monitors(self, page):
        """Each monitor's cells as [id, display set], row by row and left to right on that monitor: (monitor 1, monitor 2).
        From where the cells are drawn, independent of the product's own reading."""
        seam, cells = page.evaluate('window.synSeam ?? innerWidth / 2'), page.evaluate('synCells()')
        side = lambda keep: [[c[0], c[5]] for c in sorted((c for c in cells if keep(c)), key=lambda c: (round(c[2]), c[1]))]
        one, two = side(lambda c: c[3] <= seam + 0.5), side(lambda c: c[1] >= seam - 0.5)
        self.assertEqual(len(cells), len(one) + len(two), 'a cell lies across the display edge: ' + json.dumps(cells))
        return one, two

    def pick(self, page, rows, cols, count):
        """The reader picks rows x cols from the Layout menu; the grid of `count` cells has landed and had its moment
        (the page measures on the grid's announcement and once a second)."""
        page.evaluate('([rows, cols]) => synMenu(rows, cols)', [rows, cols])
        page.wait_for_function('count => synGridState().rects.length === count', arg=count, timeout=6000, polling=100)
        page.wait_for_timeout(2500)

    def test_07b_a_layout_picked_from_the_menu_after_the_rule_stands_is_laid_on_each_monitor(self):
        # The rule of a reading desk: monitor 1 with its strip on the left and its toolbar at the bottom, monitor 2 with
        # both on top (their fixed copies). The window covers both displays, which meet left of its middle.
        page = self.open(displays=(OFF_MIDDLE, SEAM), grid=GRID)
        rule = [monitor('2x2', thumbs='left', toolbar='bottom'), monitor('2x2', thumbs='top', toolbar='top')]
        result = self.prepare(page, rule)
        self.assertIn('적용 Monitor 1·Monitor 2.', result['note'])
        page.evaluate('synApplySplit(synAnswer.split)')
        page.evaluate('synAnswer.commit()')
        page.wait_for_function('synGridState().rects.length === 8')
        split = page.evaluate('synGridState()')
        self.laid_on_monitors(page, 4)
        # The rule's own split is left as it is.
        page.wait_for_timeout(2100)
        self.assertEqual(split, page.evaluate('synGridState()'))
        one, two = self.on_monitors(page)
        self.assertEqual([4, 4], [len(one), len(two)])
        # The picks the stock command has run so far (the first grid of one column was divided by it).
        layouts, stock = page.evaluate('synLayouts.length'), page.evaluate('synStock')

        # The reader picks 1 x 2 from the Layout menu: one cell on each monitor's image area - the first cell of that
        # monitor, the viewport it was with what it showed. Monitor 1's second cell does not go to monitor 2.
        self.pick(page, 1, 2, 2)
        self.laid_on_monitors(page, 1)
        self.assertEqual(([one[0]], [two[0]]), self.on_monitors(page))
        # Laid in one layout by the page itself: the stock command, which keeps cells by their column in the whole
        # window, did not run.
        self.assertEqual(layouts + 1, page.evaluate('synLayouts.length'))
        self.assertEqual(stock, page.evaluate('synStock'))
        # Each cell has the place key of its place (asked for by name, not left to the native grid's rounding of the
        # rectangles, which can give two cells one key).
        self.assertEqual(['0-0', '1-0'], page.evaluate('synLayouts.at(-1).layoutOptions.map(o => o.positionId)'))
        self.assertEqual(['0-0', '1-0'], page.evaluate('synOrder()'))
        # Registered as this screen's split (the double click's maximize and a later Apply's rollback know it).
        self.assertEqual(page.evaluate('synGridState().rects'), page.evaluate('kinViewerSplitRects'))
        # 2 x 2: two rows on each monitor; the lower place of each monitor gets the cell that stood there under this
        # rule (as the Layout menu brings a row back).
        self.pick(page, 2, 2, 4)
        self.assertEqual(['0-0', '1-0', '0-1', '1-1'], page.evaluate('synOrder()'))
        self.laid_on_monitors(page, 2)
        self.assertEqual(([one[0], one[2]], [two[0], two[2]]), self.on_monitors(page))
        # The reader puts another series into monitor 2's top cell.
        page.evaluate("id => putSeries(id, 'ds-reader')", two[0][0])
        # Back to 1 x 2: the top row stays, each cell with what it shows.
        self.pick(page, 1, 2, 2)
        self.laid_on_monitors(page, 1)
        self.assertEqual(([one[0]], [[two[0][0], 'ds-reader']]), self.on_monitors(page))
        # 1 x 1 picked from the four cells of 2 x 2: one cell on each monitor at once (no cell over both monitors first).
        self.pick(page, 2, 2, 4)
        self.laid_on_monitors(page, 2)
        layouts = page.evaluate('synLayouts.length')
        self.pick(page, 1, 1, 2)
        self.laid_on_monitors(page, 1)
        self.assertEqual(([one[0]], [[two[0][0], 'ds-reader']]), self.on_monitors(page))
        self.assertEqual(layouts + 1, page.evaluate('synLayouts.length'))
        self.assertEqual(2, page.evaluate('synLayouts.at(-1).layoutOptions.length'))
        # 1 x 4: two columns on each monitor, the second the cell the rule had put there.
        self.pick(page, 1, 4, 4)
        self.laid_on_monitors(page, 2)
        self.assertEqual(([one[0], one[1]], [[two[0][0], 'ds-reader'], two[1]]), self.on_monitors(page))
        self.assertEqual(stock, page.evaluate('synStock'))
        # Settled: nothing more is laid.
        count = page.evaluate('synLayouts.length')
        page.wait_for_timeout(2500)
        self.assertEqual(count, page.evaluate('synLayouts.length'))
    def test_07c_where_one_monitors_images_start_higher_the_cells_keep_the_picked_grids_order(self):
        # Monitor 1 with both rows on top, monitor 2 with its toolbar at the bottom: monitor 2's images start higher.
        page = self.open(displays=(OFF_MIDDLE, SEAM), grid=GRID)
        self.prepare(page, [monitor('1x1', thumbs='top', toolbar='top'), monitor('1x1', thumbs='none', toolbar='bottom')])
        page.evaluate('synApplySplit(synAnswer.split)')
        page.evaluate('synAnswer.commit()')
        page.wait_for_function('synGridState().rects.length === 2')
        page.wait_for_timeout(2100)
        page.evaluate('synMenu(2, 2)')
        page.wait_for_function('() => synGridState().rows === 2 && synGridState().rects.length === 4', timeout=5000, polling=250)
        page.wait_for_timeout(2500)
        cells = page.evaluate('synCells()')
        rows = page.locator('.kin-ux-toolbar-slot, .kin-viewer-series-strip, .kin-span-fixed').evaluate_all(
            'n => n.map(e => e.getBoundingClientRect()).filter(r => r.width && r.height).map(r => [r.left, r.top, r.right, r.bottom])')
        state = json.dumps({'cells': cells, 'rows': rows})
        self.assertEqual([2, 2], [len([c for c in cells if c[3] <= SEAM + 0.5]), len([c for c in cells if c[1] >= SEAM - 0.5])], state)
        over = lambda c, r: min(c[3], r[2]) - max(c[1], r[0]) > 1 and min(c[4], r[3]) - max(c[2], r[1]) > 1
        self.assertFalse(any(over(c, r) for c in cells for r in rows), 'a cell under a row: ' + state)
        self.assertLess(min(c[2] for c in cells if c[1] >= SEAM - 0.5), min(c[2] for c in cells if c[3] <= SEAM + 0.5), state)
        # Listed as the picked grid lists them (a patient tab keeps and puts back the cells in that order), not by height.
        self.assertEqual(['0-0', '1-0', '0-1', '1-1'], page.evaluate('synOrder()'))
        lists = page.evaluate('() => [...synServices.viewportGridService.getState().viewports.values()].map(c => c.x < synSeam / innerWidth ? 1 : 2)')
        self.assertEqual([1, 2, 1, 2], lists)
        # The registered copy is in the order on screen.
        rects = page.evaluate('kinViewerSplitRects')
        self.assertEqual(sorted(rects, key=lambda r: (round(r['y'], 6), r['x'])), rects)

    def apply(self, page, rule, cells):
        self.assertIn('적용 Monitor 1·Monitor 2.', self.prepare(page, rule)['note'])
        page.evaluate('synApplySplit(synAnswer.split)')
        page.evaluate('synAnswer.commit()')
        page.wait_for_function('count => synGridState().rects.length === count', arg=cells)
        page.wait_for_timeout(2100)

    def test_07d_more_or_fewer_columns_keep_each_monitors_cells_on_that_monitor(self):
        # One cell on each monitor (monitor 2's images start higher), a different series in each. With the stock command
        # alone a cell is kept by its column in the whole window: picking 1 x 4 would put monitor 2's series into monitor
        # 1's second column, and 1 x 2 picked from 1 x 4 monitor 1's second cell on monitor 2.
        page = self.open(displays=(OFF_MIDDLE, SEAM), grid=GRID)
        self.apply(page, [monitor('1x1', thumbs='top', toolbar='top'), monitor('1x1', thumbs='none', toolbar='bottom')], 2)
        (left,), (right,) = self.on_monitors(page)
        self.assertNotEqual(left[1], right[1])
        stock = page.evaluate('synStock')
        # 1 x 4: each monitor keeps its cell in its first column; the new second columns get, as the Layout menu fills a
        # new place, the study's next series that are not on screen.
        self.pick(page, 1, 4, 4)
        one, two = self.on_monitors(page)
        self.assertEqual([left, right], [one[0], two[0]])
        self.assertEqual(['ds-1', 'ds-2'], [one[1][1], two[1][1]])
        self.assertNotIn(one[1][0], [left[0], right[0]])
        self.assertEqual(['0-0', '1-0', '2-0', '3-0'], page.evaluate('synOrder()'))
        # 1 x 2 picked while monitor 2's series is still loading (its image not drawn yet): each monitor keeps its first
        # cell all the same, at once.
        page.evaluate('id => synLoading(id)', right[0])
        layouts = page.evaluate('synLayouts.length')
        page.evaluate('synMenu(1, 2)')
        page.wait_for_function('synGridState().rects.length === 2', timeout=3000, polling=50)
        self.assertEqual(([left], [right]), self.on_monitors(page))
        self.assertEqual(layouts + 1, page.evaluate('synLayouts.length'))
        page.evaluate('id => synLoading(id, false)', right[0])
        page.wait_for_timeout(2500)
        self.assertEqual(([left], [right]), self.on_monitors(page))
        # 1 x 4 again: the second columns come back as they were.
        self.pick(page, 1, 4, 4)
        self.assertEqual((one, two), self.on_monitors(page))
        # The active cell is asked for only while it stays on screen: with monitor 1's second cell active, 1 x 2 (which
        # drops it) names no active cell - the grid chooses - and 1 x 4 picked on the first cell names that one.
        page.evaluate('id => { synServices.viewportGridService.getState().activeViewportId = id; }', one[1][0])
        self.pick(page, 1, 2, 2)
        self.assertIsNone(page.evaluate('synLayouts.at(-1).active'))
        page.evaluate('id => { synServices.viewportGridService.getState().activeViewportId = id; }', left[0])
        self.pick(page, 1, 4, 4)
        self.assertEqual(left[0], page.evaluate('synLayouts.at(-1).active'))
        self.assertEqual((one, two), self.on_monitors(page))
        # 2 x 4 from there: the first row stays; and back to 2 x 2 each monitor keeps its first column.
        self.pick(page, 2, 4, 8)
        top = lambda cells: cells[:len(cells) // 2]
        now = self.on_monitors(page)
        self.assertEqual((one, two), (top(now[0]), top(now[1])))
        self.pick(page, 2, 2, 4)
        after = self.on_monitors(page)
        self.assertEqual(([now[0][0], now[0][2]], [now[1][0], now[1][2]]), after)
        self.assertEqual(stock, page.evaluate('synStock'))

    def test_07e_monitors_holding_different_grids_are_each_laid_as_their_own(self):
        # Two rows on monitor 1, one cell on monitor 2 (three cells on a 2 x 2 base).
        page = self.open(displays=(OFF_MIDDLE, SEAM), grid=GRID)
        self.apply(page, [monitor('2x1', thumbs='top', toolbar='top'), monitor('1x1', thumbs='top', toolbar='top')], 3)
        one, two = self.on_monitors(page)
        self.assertEqual([2, 1], [len(one), len(two)])
        stock = page.evaluate('synStock')
        # 2 x 2: monitor 1 keeps both of its rows, monitor 2 its cell and a new one below it.
        self.pick(page, 2, 2, 4)
        now = self.on_monitors(page)
        self.assertEqual((one, two), (now[0], now[1][:1]))
        self.assertEqual('ds-1', now[1][1][1])
        # 1 x 2: the top cell of each monitor; 2 x 2 again: each lower cell is back.
        self.pick(page, 1, 2, 2)
        self.assertEqual((one[:1], two), self.on_monitors(page))
        self.pick(page, 2, 2, 4)
        self.assertEqual(now, self.on_monitors(page))
        self.assertEqual(stock, page.evaluate('synStock'))

    def test_07g_a_layout_picked_while_a_cell_is_enlarged_asks_for_no_viewport_twice(self):
        # Two rows on each monitor; 2 x 2 picked once (the page has seen every cell on its place). Then monitor 2's lower
        # cell is enlarged over its monitor - it now stands on that monitor's first place - and 2 x 2 is picked again: the
        # enlarged cell stays the first, the place below gets a new cell, and no viewport is asked for twice (asked for
        # twice it would be one cell, and the grid one cell short).
        page = self.open(displays=(OFF_MIDDLE, SEAM), grid=GRID)
        self.apply(page, [monitor('2x1', thumbs='top', toolbar='top'), monitor('2x1', thumbs='top', toolbar='top')], 4)
        self.pick(page, 2, 2, 4)
        one, two = self.on_monitors(page)
        page.evaluate('id => synEnlarge(id)', two[1][0])
        page.wait_for_function('synGridState().rects.length === 3')
        page.wait_for_timeout(1200)
        self.assertEqual((one, [two[1]]), self.on_monitors(page))
        self.pick(page, 2, 2, 4)
        now = self.on_monitors(page)
        self.assertEqual(one, now[0])
        self.assertEqual(two[1], now[1][0])
        self.assertEqual(4, len({cell[0] for cell in now[0] + now[1]}))
        self.assertNotIn(now[1][1][0], [cell[0] for cell in one + two])
        # 1 x 2 picked while enlarged shows the enlarged cell on its monitor (not the cell it had covered).
        page.evaluate('id => synEnlarge(id)', now[1][1][0])
        page.wait_for_function('synGridState().rects.length === 3')
        page.wait_for_timeout(1200)
        self.pick(page, 1, 2, 2)
        self.assertEqual(([one[0]], [now[1][1]]), self.on_monitors(page))

    def test_07h_cells_put_back_on_the_two_halves_of_the_grid_follow_the_display_edge(self):
        # No rule's rows: two rows beside one cell, laid on the two halves of the grid - as a patient tab puts back a
        # screen whose monitors held different grids. The displays meet left of the window's middle: the window keeps the
        # grid's middle on the display edge, also after its image column changes width (a side panel, a resize), so no
        # cell lies across the edge.
        page = self.open(displays=(OFF_MIDDLE, SEAM), grid=GRID)
        page.wait_for_timeout(1500)
        page.evaluate("""() => { const rects = [{ x: 0, y: 0, width: 0.5, height: 0.5, positionId: '0-0' }, { x: 0.5, y: 0, width: 0.5, height: 1, positionId: '1-0' },
            { x: 0, y: 0.5, width: 0.5, height: 0.5, positionId: '0-1' }];
          synServices.viewportGridService.setLayout({ numRows: 2, numCols: 2, layoutOptions: rects,
            findOrCreateViewport: index => ({ displaySetInstanceUIDs: ['ds-' + (index + 1)], viewportOptions: { viewportId: 'tab-' + index } }) }); }""")
        page.wait_for_function('synGridState().rects.length === 3')
        page.wait_for_timeout(2500)
        one, two = self.on_monitors(page)
        self.assertEqual([['tab-0', 'ds-1'], ['tab-2', 'ds-3']], one)
        self.assertEqual([['tab-1', 'ds-2']], two)
        seam = lambda: [round(c[3]) for c in page.evaluate('synCells()') if c[0] == 'tab-0'] + [round(c[1]) for c in page.evaluate('synCells()') if c[0] == 'tab-1']
        self.assertEqual([SEAM, SEAM], seam())
        page.set_viewport_size({'width': 1100, 'height': 900})
        page.wait_for_timeout(2500)
        self.assertEqual(([['tab-0', 'ds-1'], ['tab-2', 'ds-3']], [['tab-1', 'ds-2']]), self.on_monitors(page))
        self.assertEqual([SEAM, SEAM], seam())
        self.assertEqual(3, page.evaluate('synGridState().rects.length'))

    def test_07f_without_a_rules_rows_the_layout_menu_is_the_stock_command(self):
        # The same window over two displays with no rule applied: every pick runs the stock command, which keeps cells by
        # their column in the whole window, and nothing lays rectangles of its own.
        page = self.open(displays=TWO_DISPLAYS, grid=GRID)
        page.evaluate('synMenu(1, 2)')
        page.wait_for_function('synGridState().rects.length === 2 && synGridState().cols === 2', timeout=6000, polling=100)
        page.wait_for_timeout(2500)
        first, second = page.evaluate('synCells()')
        page.evaluate("id => putSeries(id, 'ds-reader')", second[0])
        page.evaluate('synMenu(1, 4)')
        page.wait_for_function('synGridState().rects.length === 4', timeout=6000, polling=100)
        page.wait_for_timeout(2500)
        cells = page.evaluate('synCells()')
        self.assertEqual([[first[0], first[5]], [second[0], 'ds-reader']], [[c[0], c[5]] for c in cells[:2]])
        self.assertIn([1, 4], page.evaluate('synStock'))
        self.assertTrue(all(layout['layoutOptions'] is None for layout in page.evaluate('synLayouts')))
        # A rule applied and its rows taken back again (KinViewerMonitors.clear, as when the window is moved): the stock
        # command again.
        page = self.open(displays=(OFF_MIDDLE, SEAM), grid=GRID)
        self.apply(page, [monitor('1x1', thumbs='top', toolbar='top'), monitor('1x1', thumbs='none', toolbar='bottom')], 2)
        page.evaluate('KinViewerMonitors.clear()')
        page.wait_for_function("!document.body.hasAttribute('data-kin-monitor-rows')")
        page.evaluate('synMenu(1, 4)')
        page.wait_for_function('synStock.some(pick => pick[0] === 1 && pick[1] === 4)', timeout=6000, polling=100)
    def test_08_the_worklist_window_is_read_and_asked_to_its_monitor_once_the_rule_stands(self):
        page = self.open(displays=TWO_DISPLAYS)
        page.evaluate("""() => { window.synPlaceCalls = []; window.synPlaceAnswer = { result: 'here', rect: null };
          window.kinViewerListPlaceOn = async target => { synPlaceCalls.push(target && structuredClone(target)); return synPlaceAnswer; }; }""")
        rules = [monitor('none', worklist='show', toolbar='none', thumbs='none'), monitor('2x2')]
        here = page.evaluate("() => ({ left: synScreens[0].left + 10, top: 10, width: 400, height: 300 })")
        there = page.evaluate("() => ({ left: synScreens[1].left + 10, top: 10, width: 400, height: 300 })")
        self.assertIn('Worklist: 목록 창이 Monitor 1에 있습니다.', self.prepare(page, rules, here)['note'])
        page.evaluate('synAnswer.commit()')
        # A worklist already on its monitor is told so too (an offer an earlier rule made must not stay); it stays put and
        # nothing is said.
        page.wait_for_function('synPlaceCalls.length === 1')
        self.assertEqual({'monitor': 0, 'rect': page.evaluate('synScreens[0]')}, page.evaluate('synPlaceCalls[0]'))
        page.evaluate(FRAME)
        self.assertFalse(page.evaluate("synNotes.some(n => n.message.startsWith('Worklist:'))"))
        page.evaluate("synPlaceAnswer = { result: 'moved', rect: null }")
        self.assertIn('Worklist: 목록 창이 Monitor 1에 있지 않아(Monitor 2) Monitor 1(으)로 옮깁니다.', self.prepare(page, rules, there)['note'])
        self.assertEqual(1, page.evaluate('synPlaceCalls.length'), 'nothing is asked before the rule stands')
        page.evaluate('synAnswer.undo()')
        self.assertEqual(1, page.evaluate('synPlaceCalls.length'), 'an apply that does not stand asks nothing')
        self.prepare(page, rules, there)
        page.evaluate('synAnswer.commit()')
        page.wait_for_function('synPlaceCalls.length === 2')
        self.assertEqual({'monitor': 0, 'rect': page.evaluate('synScreens[0]')}, page.evaluate('synPlaceCalls[1]'))
        page.wait_for_function("synNotes.some(n => n.message === 'Worklist: 목록 창을 Monitor 1(으)로 옮겼습니다.')")
        self.assertIn('Worklist: 목록 창 위치를 확인할 수 없습니다.', self.prepare(page, rules, None)['note'])

    def test_08b_a_tab_is_offered_the_worklist_window_and_a_later_rule_without_show_takes_the_offer_back(self):
        page = self.open(displays=TWO_DISPLAYS)
        page.evaluate("""() => { window.synPlaceCalls = []; window.synPlaceAnswer = { result: 'offered', rect: null };
          window.kinViewerListPlaceOn = async target => { synPlaceCalls.push(target && structuredClone(target)); return synPlaceAnswer; }; }""")
        there = page.evaluate("() => ({ left: synScreens[1].left + 10, top: 10, width: 400, height: 300 })")
        self.prepare(page, [monitor('none', worklist='show', toolbar='none', thumbs='none'), monitor('2x2')], there)
        page.evaluate('synAnswer.commit()')
        page.wait_for_function("""synNotes.some(n => n.message === 'Worklist: 목록 창은 브라우저 탭이라 옮길 수 없어, 목록 화면에 "Open Worklist on Monitor 1" 단추를 띄웠습니다.')""")
        # The next rule shows no worklist: the bar offered on the worklist screen is taken back. Every rule that stands says
        # so once - also before its answer has come - so a late offer of an earlier rule cannot stay (the list document
        # follows the latest request only).
        self.prepare(page, [monitor('2x2'), monitor('2x2')])
        page.evaluate('synAnswer.commit()')
        page.wait_for_function('synPlaceCalls.length === 2')
        self.assertIsNone(page.evaluate('synPlaceCalls[1]'))
        self.prepare(page, [monitor('2x2'), monitor('2x2')])
        page.evaluate('synAnswer.commit()')
        page.wait_for_function('synPlaceCalls.length === 3')
        self.assertIsNone(page.evaluate('synPlaceCalls[2]'))
        # A rule whose monitors cannot be applied here stands without them: it takes the offer back as well.
        page.evaluate("""() => { navigator.permissions.query = async () => ({ state: 'prompt', onchange: null });
          Object.defineProperty(screen, 'isExtended', { configurable: true, get: () => true }); }""")
        result = self.prepare(page, [monitor('none', worklist='show', toolbar='none', thumbs='none'), monitor('2x2')])
        self.assertIsNone(result['split'])
        page.evaluate('synAnswer.commit()')
        page.wait_for_function('synPlaceCalls.length === 4')
        self.assertIsNone(page.evaluate('synPlaceCalls[3]'))

    def test_08c_no_answer_is_said_and_an_answer_for_a_rule_no_longer_applied_is_not(self):
        page = self.open(displays=TWO_DISPLAYS)
        page.evaluate("""() => { window.synPlaceCalls = [];
          window.kinViewerListPlaceOn = target => new Promise(resolve => { synPlaceCalls.push(target); window.synPlaceRelease = resolve; }); }""")
        there = page.evaluate("() => ({ left: synScreens[1].left + 10, top: 10, width: 400, height: 300 })")
        rules = [monitor('none', worklist='show', toolbar='none', thumbs='none'), monitor('2x2')]
        self.prepare(page, rules, there)
        page.evaluate('synAnswer.commit()')
        page.wait_for_function("typeof synPlaceRelease === 'function'")
        page.evaluate('synPlaceRelease(null)')
        page.wait_for_function("synNotes.some(n => n.message === 'Worklist: 목록 창이 답하지 않아 Monitor 1(으)로 옮기지 못했습니다.')")
        count = page.evaluate('synNotes.length')
        self.prepare(page, rules, there)
        page.evaluate('synAnswer.commit()')
        page.wait_for_function('synPlaceCalls.length === 2')
        # A newer rule is applied before the answer comes: the late answer says nothing.
        self.prepare(page, [monitor('2x2'), monitor('2x2')])
        page.evaluate("synPlaceRelease({ result: 'moved', rect: null })"); page.evaluate(FRAME)
        self.assertFalse(page.evaluate("synNotes.slice(%d).some(n => n.message.startsWith('Worklist:'))" % count))

    def test_09_without_display_information_nothing_is_claimed(self):
        page = self.open(displays="() => { Object.defineProperty(screen, 'isExtended', { configurable: true, get: () => true }); }")
        result = self.prepare(page, [monitor('1x1'), monitor('1x1')])
        self.assertIsNone(result['split'])
        self.assertIn('화면 정보를 확인할 수 없어 모니터별 배치를 적용하지 않았습니다', result['note'])
        self.assertIsNone(page.evaluate("document.body.getAttribute('data-kin-monitor-rows')"))

    def test_10_a_monitor_beyond_the_displays_is_reported(self):
        page = self.open()
        result = self.prepare(page, [monitor('1x1'), monitor('1x1'), monitor('1x1')])
        self.assertIn('Monitor 2: 이 화면 구성에 없어 적용하지 않았습니다.', result['note'])
        self.assertIn('Monitor 3: 이 화면 구성에 없어 적용하지 않았습니다.', result['note'])
        self.assertIn('규칙의 칸 2, 3, 4은(는) 모니터 칸 수가 모자라 보이지 않습니다.', result['note'])

    def test_11_an_abort_puts_the_rows_back(self):
        page = self.open()
        state = page.evaluate("""async rule => { const control = new AbortController();
          const pending = KinViewerMonitors.prepare(rule, { signal: control.signal }); control.abort();
          try { await pending; return 'answered'; } catch (error) { return error.name; } }""", hp_rule(RULE_ID, 'Brain CT', [monitor('1x1', toolbar='left')]))
        self.assertEqual('AbortError', state)
        page.evaluate(FRAME)
        self.assertIsNone(page.evaluate("document.body.getAttribute('data-kin-monitor-rows')"))

    def test_12_an_aborted_prepare_that_answers_late_leaves_the_next_rule_alone(self):
        page = self.open()
        # Rule A waits on the worklist's answer; it is aborted, rule B is applied, then A's answer comes.
        page.evaluate("() => { window.kinViewerListPlace = () => new Promise(resolve => { window.synRelease = resolve; }); }")
        page.evaluate("""rule => { window.synControl = new AbortController();
          window.synA = KinViewerMonitors.prepare(rule, { signal: synControl.signal }).then(() => 'answered', error => error.name); }""",
                      hp_rule(RULE_ID, 'Rule A', [monitor('1x1', worklist='show', toolbar='left')]))
        page.wait_for_function("() => typeof window.synRelease === 'function'")
        expect(page.locator('body')).to_have_attribute('data-kin-toolbar-side', 'left')
        page.evaluate('synControl.abort()'); page.evaluate(FRAME)
        self.assertIsNone(page.evaluate("document.body.getAttribute('data-kin-monitor-rows')"), 'the abort puts the rows back at once')
        page.evaluate("""async rule => { const b = await KinViewerMonitors.prepare(rule); b.commit(); }""",
                      hp_rule(OTHER_ID, 'Rule B', [monitor('1x1', toolbar='right')]))
        expect(page.locator('body')).to_have_attribute('data-kin-toolbar-side', 'right')
        page.evaluate('synRelease(null)')
        self.assertEqual('AbortError', page.evaluate('synA'))
        page.evaluate(FRAME)
        expect(page.locator('body')).to_have_attribute('data-kin-toolbar-side', 'right')
        self.assertEqual('', page.evaluate("document.body.getAttribute('data-kin-monitor-rows')"), "rule B's rows stay")

    def test_13_a_resized_window_gives_the_rows_back_and_says_so(self):
        page = self.open()
        self.prepare(page, [monitor('2x1', thumbs='left', toolbar='bottom')])
        page.evaluate('synAnswer.commit()')
        self.assertEqual('', page.evaluate("document.body.getAttribute('data-kin-monitor-rows')"))
        page.set_viewport_size({'width': 1000, 'height': 800})
        page.wait_for_function("() => document.body.getAttribute('data-kin-monitor-rows') === null")
        page.wait_for_function("() => synNotes.some(n => String(n.message).includes('모니터별 도구 줄·썸네일 배치를 해제했습니다'))")
        # Back in the column's flow: the rows cover no image.
        boxes = page.evaluate(BOXES)
        self.assertAlmostEqual(boxes['toolbar']['bottom'], boxes['thumbs']['top'], delta=1)
        self.assertLessEqual(boxes['thumbs']['bottom'], boxes['grid']['top'] + 1)

    # ── The browser kept the window off the rule's monitors: the wait for the reader's drag ──
    def waiting(self, page, monitors=None):
        """A rule for monitors 1 and 2 applied to a window the browser keeps on monitor 1: the wait for the drag has begun."""
        page.evaluate("""() => { window.synReached = [];
          if (!window.synListening) { window.synListening = true; addEventListener('kin-viewer-monitors-reached', e => synReached.push(e.detail.ruleId)); } }""")
        result = self.prepare(page, monitors or [monitor('1x1', toolbar='top'), monitor('1x1', toolbar='top')])
        page.evaluate('synAnswer.commit()')
        self.assertTrue(page.evaluate('KinViewerMonitors.reaching()'))
        return result

    def stretched(self, page, reached, width=1800):
        """The reader lays the window over the next display; whether the rule is asked for again."""
        page.set_viewport_size({'width': width, 'height': 800})
        if reached:
            page.wait_for_function("() => synReached.length === 1")
        # The wait looks twice a second.
        page.wait_for_timeout(1100)
        self.assertEqual([RULE_ID] if reached else [], page.evaluate('synReached'))
        self.assertFalse(page.evaluate('KinViewerMonitors.reaching()'))

    def test_16_the_browser_keeps_the_window_off_monitor_2_and_the_drag_over_it_is_noticed(self):
        # Monitor 1 is this window's display, monitor 2 the one to its right; a browser does not move the window over both.
        page = self.open(displays=BESIDE, size=(900, 800))
        result = self.waiting(page)
        # Not a dead end: the reader is told to lay the window over them. (The headless window's refused move leaves its outer
        # size apart from its inner one, so what this apply itself placed is not judged here; viewer_hanging_protocol_monitors
        # covers the rule standing.)
        self.assertIn('브라우저가 영상 창을 Monitor 1·Monitor 2(으)로 옮기지 않았습니다. 영상 창의 가장자리를 끌어 그 화면에 걸쳐 놓으세요. '
                      '걸쳐 놓으면 이 규칙을 다시 적용합니다.', result['note'])
        page.wait_for_timeout(1200)
        self.assertEqual([], page.evaluate('synReached'))
        # The reader stretches the window over monitor 2: noticed, and the rule is asked for again, once; the rows the rule
        # placed are released without the "window changed" notice (the rule is coming back).
        self.stretched(page, True)
        self.assertFalse(page.evaluate("() => synNotes.some(n => String(n.message).includes('모니터별 도구 줄·썸네일 배치를 해제했습니다'))"))

    def test_17_a_newer_rule_ends_the_wait_for_the_drag(self):
        page = self.open(displays=BESIDE, size=(900, 800))
        self.waiting(page)
        # A rule without monitors is applied meanwhile (the panel clears the monitors module).
        page.evaluate('KinViewerMonitors.clear()')
        self.stretched(page, False)

    def test_18_the_readers_own_work_on_the_images_meanwhile_ends_the_wait(self):
        # Laying the window over monitor 2 after the reader began to work on the images does not apply the rule again over
        # that work. Each way that work begins.
        inside = "() => !!document.elementFromPoint(450, 500)?.closest('[data-cy=\"viewport-grid\"]')"
        page = self.open(displays=BESIDE, size=(900, 800), tools=MANY_TOOLS)
        # The letter keys, as the viewer mounts them: taken before they reach the document.
        page.evaluate("""() => { window.synRan = []; const record = synServices.toolbarService.recordInteraction;
          synServices.toolbarService.recordInteraction = item => { synRan.push(item.itemId); return record(item); };
          KinViewerUXShortcuts.mount({ getBindings: () => synToolbar.bindings(), invoke: id => synToolbar.invoke(id), allowed: () => true }); }""")
        for work in ('press', 'wheel', 'key', 'shortcut', 'toolbar', 'taken wheel'):
            # The window back on monitor 1, the rule applied again: a new wait.
            page.set_viewport_size({'width': 900, 'height': 800})
            page.evaluate("synRan.length = 0")
            self.waiting(page)
            self.assertTrue(page.evaluate(inside))
            if work == 'press':
                page.mouse.click(450, 500)
            elif work == 'wheel':
                page.mouse.move(450, 500); page.mouse.wheel(0, 120)
            elif work == 'key':
                # A key the viewer may act on (the next image).
                page.keyboard.press('ArrowDown')
            elif work == 'shortcut':
                page.keyboard.press('i')
                self.assertEqual(['invert'], page.evaluate('synRan'), 'the key ran Invert')
            elif work == 'toolbar':
                page.evaluate("synToolbar.invoke('invert')")
                self.assertEqual(['invert'], page.evaluate('synRan'))
            else:
                # A wheel step the viewer took to enlarge the image (Ctrl+wheel with that choice on) says so itself.
                page.evaluate("kinViewerImageWork()")
            # (A wheel step reaches the page a moment after it is sent.)
            page.wait_for_function('() => !KinViewerMonitors.reaching()', timeout=2000)
            self.stretched(page, False)

    def test_19_what_is_not_work_on_the_images_keeps_the_wait(self):
        # The browser's own zoom keys, a Ctrl+wheel nobody took for the image, a press outside the images and keys typed
        # into a field: the reader has not begun to work on the images, and the rule comes back once the window is there.
        page = self.open(displays=BESIDE, size=(900, 800), tools=MANY_TOOLS)
        page.evaluate("""() => { KinViewerUXShortcuts.mount({ getBindings: () => synToolbar.bindings(), invoke: id => synToolbar.invoke(id), allowed: () => true });
          const field = document.createElement('input'); field.id = 'syn-field'; document.querySelector('#tabs').append(field); }""")
        self.waiting(page)
        for chord in ('Control+Equal', 'Control+Minus', 'Control+Digit0', 'Meta+Equal', 'Shift', 'F6'):
            page.keyboard.press(chord)
        page.evaluate("""() => document.elementFromPoint(450, 500).dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, ctrlKey: true, deltaY: -120 }))""")
        page.locator('#tabs button').click()
        page.locator('#syn-field').click(); page.keyboard.type('invert'); page.locator('#syn-field').blur()
        self.assertTrue(page.evaluate('KinViewerMonitors.reaching()'))
        self.stretched(page, True)

    def test_20_the_access_taken_back_ends_the_wait_and_nothing_read_before_is_used(self):
        page = self.open(displays=BESIDE, size=(900, 800))
        self.waiting(page)
        # The reader takes the window-management access back, then stretches the window.
        page.evaluate("synPermission.state = 'prompt'")
        self.stretched(page, False)

    def test_21_other_displays_than_the_rule_was_applied_on_end_the_wait(self):
        # Monitor 1 lies to the left of this window's display (monitor 2); the rule is for those two.
        page = self.open(displays=BESIDE.replace('[0, 1]', '[-1, 0]'), size=(900, 800))
        self.waiting(page)
        # Monitor 1 is unplugged and a display to the right is plugged in: the numbers now name another pair. The window then
        # reaches over that pair; the rule that was waiting for the old one is not applied to it.
        page.evaluate("""() => { const own = synScreens[1]; synScreens.shift();
          synScreens.push({ ...own, availLeft: own.availLeft + own.availWidth, left: own.left + own.width, isPrimary: false }); }""")
        self.stretched(page, False)

    def test_22_three_displays_the_wait_and_the_split_use_the_same_pair(self):
        # Three displays, each as wide as this window at first; the rule shows images on monitors 2 and 3 only.
        page = self.open(displays=BESIDE.replace('[0, 1]', '[-1, 0, 1]'), size=(900, 800))
        rule = [monitor('none', toolbar='none', thumbs='none'), monitor('1x1', toolbar='top'), monitor('1x1', toolbar='top')]
        self.waiting(page, rule)
        # Stretched to the right over monitor 3: the window now stands over monitors 2 and 3.
        self.stretched(page, True)
        # And when it also reaches over monitor 1 on its left, the rule is still laid on monitors 2 and 3 - not on the first
        # two displays the window happens to cover.
        page.evaluate("""() => { const shift = innerWidth / 3; for (const s of synScreens) { s.availLeft += shift; s.left += shift; } }""")
        again = self.prepare(page, rule)
        self.assertEqual([1, 2], again['split']['applied'], again['note'])
        self.assertNotIn('그 화면을 덮지 않아', again['note'])

    def test_23_a_side_panel_or_the_browser_zoom_is_measured_again_each_time(self):
        page = self.open(displays=BESIDE, size=(900, 800))
        self.waiting(page)
        # Stretched, but a side panel now takes the part of the window that lies on monitor 2: its image column does not
        # reach that monitor, so nothing yet.
        page.evaluate("""() => { const panel = document.createElement('div'); panel.id = 'syn-side'; panel.style.cssText = 'flex: none; width: 850px';
          document.querySelector('#column').after(panel); }""")
        page.set_viewport_size({'width': 1800, 'height': 800})
        page.wait_for_timeout(1300)
        self.assertEqual([], page.evaluate('synReached'))
        self.assertTrue(page.evaluate('KinViewerMonitors.reaching()'))
        # The panel is closed: the image column is over monitor 2 now.
        page.evaluate("document.querySelector('#syn-side').remove()")
        page.wait_for_function("() => synReached.length === 1")


    def test_14_both_monitors_with_a_toolbar_each_reach_viewer_settings(self):
        page = self.open(displays=TWO_DISPLAYS)
        self.prepare(page, [monitor('1x1', toolbar='top', thumbs='none'), monitor('1x1', toolbar='left', thumbs='none')])
        copy = page.locator('.kin-span-fixed[aria-label="Image Tools (Second Display)"]')
        expect(copy).to_be_visible()
        settings = copy.get_by_role('button', name='Viewer Settings')
        expect(settings).to_have_count(1)
        half = (page.evaluate(BOXES)['column']['left'] + page.evaluate(BOXES)['column']['right']) / 2
        self.assertGreaterEqual(settings.bounding_box()['x'], half - 1)
        settings.click()
        expect(page.locator('dialog.kin-ux-settings')).to_be_visible()

    def test_15_rows_put_back_after_the_window_changed_are_released_not_kept(self):
        # Rule A applied; rule B is being prepared (it waits on the worklist) when the window is resized; B then fails
        # (undo) or is aborted. A's rows are put back for a window that is no longer where they were placed.
        released = "() => synNotes.filter(n => String(n.message).includes('모니터별 도구 줄·썸네일 배치를 해제했습니다')).length"
        for ending in ('undo', 'abort'):
            page = self.open()
            self.prepare(page, [monitor('2x1', thumbs='left', toolbar='bottom')])
            page.evaluate('synAnswer.commit()')
            page.evaluate("() => { window.kinViewerListPlace = () => new Promise(resolve => { window.synRelease = resolve; }); }")
            page.evaluate("""rule => { window.synControl = new AbortController();
              window.synB = KinViewerMonitors.prepare(rule, { signal: synControl.signal }).then(answer => answer, error => error.name); }""",
                          hp_rule(OTHER_ID, 'Rule B', [monitor('1x1', worklist='show', toolbar='right')]))
            page.wait_for_function("() => typeof window.synRelease === 'function'")
            expect(page.locator('body')).to_have_attribute('data-kin-toolbar-side', 'right')
            page.set_viewport_size({'width': 1000, 'height': 800})
            page.evaluate(FRAME)
            if ending == 'undo':
                page.evaluate('synRelease(null)')
                page.evaluate('async () => (await synB).undo()')
            else:
                page.evaluate('synControl.abort()')
                page.evaluate('synRelease(null)')
                self.assertEqual('AbortError', page.evaluate('synB'))
            page.wait_for_function("() => document.body.getAttribute('data-kin-monitor-rows') === null")
            page.wait_for_function(released + ' === 1')
            page.evaluate(FRAME)
            boxes = page.evaluate(BOXES)
            self.assertLessEqual(boxes['thumbs']['bottom'], boxes['grid']['top'] + 1, ending + ': the rows cover no image')
            # And they stay released: nothing re-applies A's bands later.
            page.wait_for_timeout(1300)
            self.assertIsNone(page.evaluate("document.body.getAttribute('data-kin-monitor-rows')"))
            self.assertEqual(1, page.evaluate(released))


# A patient tab of a window whose screen stands on two monitors: the shipped hanging-protocol-model.js,
# viewer-features-monitors.js and viewer-patient-tabs.js on a synthetic viewport grid (2000 x 1000, the displays meeting
# at 1000), synthetic viewports (each cell on a frame of its own) and a synthetic patient lookup. The screen is the split
# of a rule (KinViewerMonitorPlan.split), registered as Hanging Protocols registers it: its rectangles and, with them,
# the image areas they were laid on. The grid takes every layout it is asked for (synAsked lists them, by study). The
# route remounts the tabs on the stock one-cell grid whenever another patient is shown.
TABS = """async ([monitors, state]) => {
  const rule = { layout: { rows: 2, cols: 4, cells: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'] },
    monitors: { count: monitors.length, list: monitors } };
  const box = { left: 0, top: 0, right: 2000, bottom: 1000 };
  const split = KinViewerMonitorPlan.split(KinHangingProtocolModel, rule, [{ monitor: 0, left: 0, right: 1000 }, { monitor: 1, left: 1000, right: 2000 }],
    box, { left: 0, top: 0, width: 2000, height: 1000 });
  // The rule's rows stand, or are gone (taken back when the window moved; taken away by a patient switch).
  window.synRows = on => { window.KinViewerMonitorRows = on ? { areas: split.areas, copies: {} } : null; };
  synRows(state.rows !== false);
  window.kinViewerSplitRects = state.registered === false ? null : split.rects.map(rect => ({ ...rect }));
  window.kinViewerSplitAreas = state.registered === false ? null : { rects: window.kinViewerSplitRects, areas: split.areas.map(area => ({ ...area })) };
  window.kinViewerFrameCoverageConfirm = () => true;
  const uid = () => new URLSearchParams(location.search).get('StudyInstanceUIDs');
  const cells = state.plain ? Array.from({ length: 4 }, (_, i) => ({ x: (i % 2) / 2, y: Math.floor(i / 2) / 2, width: 0.5, height: 0.5 }))
    : split.rects.map((rect, i) => ({ ...rect, positionId: split.positions[i] }));
  const sets = cells.map((_, i) => ({ StudyInstanceUID: '1.2.1', SeriesInstanceUID: 'series-' + i, displaySetInstanceUID: 'set-' + i }));
  // What each viewport has drawn: [the set's index, the frame].
  const drawn = new Map(cells.map((_, i) => ['v' + i, [i, i + 3]]));
  let grid = { layout: { layoutType: 'grid', numRows: state.plain ? 2 : split.numRows, numCols: state.plain ? 2 : split.numCols }, activeViewportId: 'v0',
    viewports: new Map(cells.map((cell, i) => ['v' + i, { ...cell, viewportId: 'v' + i, displaySetInstanceUIDs: [sets[i].displaySetInstanceUID] }])) };
  // Each cell where it stands and what it shows: [x, y, width, height, series, frame].
  window.synBefore = [...grid.viewports.values()].map((cell, i) => [cell.x, cell.y, cell.width, cell.height, sets[i].SeriesInstanceUID, i + 3]);
  window.synAsked = [];
  const viewports = { EVENTS: { VIEWPORT_DATA_CHANGED: 'data' }, subscribe(event, fn) { viewports.notify = fn; return { unsubscribe() {} }; },
    getCornerstoneViewport(id) { const at = drawn.get(id);
      return { type: 'stack', getCurrentImageId: () => at ? 'image-' + at[0] + '-' + at[1] : undefined, getCurrentImageIdIndex: () => at ? at[1] : 0 }; } };
  const services = { cornerstoneViewportService: viewports,
    viewportGridService: { getState: () => grid, setLayout(asked) {
      const count = asked.layoutOptions ? asked.layoutOptions.length : asked.numRows * asked.numCols, next = new Map(), listed = [];
      for (let i = 0; i < count; i++) {
        const cell = asked.findOrCreateViewport(i), option = asked.layoutOptions?.[i];
        const rect = option ? { x: option.x, y: option.y, width: option.width, height: option.height }
          : { x: (i % asked.numCols) / asked.numCols, y: Math.floor(i / asked.numCols) / asked.numRows, width: 1 / asked.numCols, height: 1 / asked.numRows };
        const set = sets.findIndex(value => value.displaySetInstanceUID === cell.displaySetInstanceUIDs[0]), frame = cell.viewportOptions.initialImageOptions?.index ?? null;
        const id = cell.viewportOptions.viewportId;
        next.set(id, { ...rect, positionId: option?.positionId || Math.round(rect.x * asked.numCols) + '-' + Math.round(rect.y * asked.numRows), viewportId: id, displaySetInstanceUIDs: [...cell.displaySetInstanceUIDs] });
        if (set >= 0) drawn.set(id, [set, frame]);
        listed.push([rect.x, rect.y, rect.width, rect.height, set >= 0 ? sets[set].SeriesInstanceUID : null, frame]);
      }
      synAsked.push({ study: uid(), rows: asked.numRows, cols: asked.numCols, keys: asked.layoutOptions ? asked.layoutOptions.map(option => option.positionId) : null, cells: listed });
      grid = { layout: { layoutType: 'grid', numRows: asked.numRows, numCols: asked.numCols }, activeViewportId: asked.activeViewportId, viewports: next }; } },
    displaySetService: { getDisplaySetByUID: id => sets.find(set => set.displaySetInstanceUID === id), getActiveDisplaySets: () => sets } };
  window.KinViewerInfoBar = { identity: () => ({ instance: { StudyInstanceUID: uid() } }) };
  const mount = () => KinViewerPatientTabs.mount({ services, session: { state: () => 'active', readOnly: () => false }, refreshChrome() {} });
  await mount();
  addEventListener('popstate', () => { window.synReady = (async () => {
    KinViewerPatientTabs.dispose();
    grid = { layout: { layoutType: 'grid', numRows: 1, numCols: 1 }, activeViewportId: 'stock', viewports: new Map([['stock', { viewportId: 'stock', x: 0, y: 0, width: 1, height: 1, displaySetInstanceUIDs: [] }]]) };
    await mount(); viewports.notify({ viewportId: 'stock' }); await new Promise(resolve => setTimeout(resolve, 50));
  })(); });
}"""


class PatientTabsOnMonitorsDOMTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.pw = sync_playwright().start(); cls.browser = cls.pw.chromium.launch()

    @classmethod
    def tearDownClass(cls):
        cls.browser.close(); cls.pw.stop()

    # A patient switch takes the rule's rows away in the shipped viewer (its modules are made anew).
    GONE = '() => synRows(false)'

    def round_trip(self, monitors, between=GONE, trips=1, **state):
        """The next patient is opened in the window, `between` runs while that patient is shown (by default the rule's rows
        are taken away, as the viewer does), then the first patient's tab is chosen again - `trips` times. Answers the screen
        before ([x, y, width, height, series, frame] per cell) and the layouts asked for the first patient on the way back."""
        page = self.browser.new_page(); errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        self.addCleanup(page.close)

        def serve(route):
            url = urlparse(route.request.url)
            if url.path == '/api/studies':
                study = parse_qs(url.query)['uids'][0]
                route.fulfill(json={'studies': [dict(uid=study, sourcePatientKey=study, name='SYN ' + study, id=study)]})
            else:
                route.fulfill(body='<div class="bg-secondary-dark z-20"><span id="kin-viewer-brand"></span></div>', content_type='text/html')
        page.route(ORIGIN + '/**', serve)
        page.goto(ORIGIN + '/ohif/viewer?StudyInstanceUIDs=1.2.1')
        for name in ['hanging-protocol-model.js', 'viewer-features-monitors.js', 'viewer-patient-tabs.js']:
            page.add_script_tag(path=str(HPACS / name))
        page.evaluate(TABS, [monitors, state])
        for _ in range(trips):
            self.assertTrue(page.evaluate("kinViewerOpenPatient('/ohif/viewer?StudyInstanceUIDs=1.2.2')"))
            page.evaluate('synReady')
            if between:
                page.evaluate(between)
            page.get_by_role('tab', name='SYN 1.2.1', exact=False).click()
            page.wait_for_url('**StudyInstanceUIDs=1.2.1')
            page.evaluate('synReady')
        self.assertEqual([], errors)
        asked = [layout for layout in page.evaluate('synAsked') if layout['study'] == '1.2.1']
        self.assertLessEqual(len(asked), trips, asked)
        return page.evaluate('synBefore'), asked

    @staticmethod
    def placed(cells):
        """Cells as a set of (x, y, width, height, series, frame), rounded: where each series stands, whatever the order."""
        return sorted(tuple(round(v, 4) if isinstance(v, float) else v for v in cell) for cell in cells)

    @staticmethod
    def where(cells, edge=0.5):
        """Each cell as (monitor, its row there, its column there, series, frame), read from the rectangles: which series
        stands where, whatever the rectangles' exact sizes."""
        side = lambda cell: int(cell[0] + cell[2] / 2 > edge)
        rank = lambda cell, axis: sorted({round(other[axis], 4) for other in cells if side(other) == side(cell)}).index(round(cell[axis], 4))
        return sorted((side(cell), rank(cell, 1), rank(cell, 0), cell[4], cell[5]) for cell in cells)

    HALVES = sorted([(0, 0, 0.5, 0.5), (0, 0.5, 0.5, 0.5), (0.5, 0, 0.5, 1)])

    def test_01_a_rule_whose_monitors_hold_different_rows_comes_back_cell_for_cell_every_time(self):
        # Two rows on monitor 1, one cell on monitor 2: three cells on a 2 x 2 base. Before, a screen that was no full
        # grid was not kept at all: the patient came back as first opened, every cell's series and frame lost. It comes
        # back laid on the two halves of the grid (the window keeps their edge on the display edge): every cell on its
        # monitor, in its row, on its series and frame.
        before, asked = self.round_trip([monitor('2x1'), monitor('1x1')])
        self.assertEqual(3, len(before))
        self.assertEqual(1, len(asked), 'the tab asked for no layout: its screen was not kept')
        self.assertEqual([2, 2], [asked[0]['rows'], asked[0]['cols']])
        self.assertEqual(self.where(before), self.where(asked[0]['cells']))
        self.assertEqual(self.HALVES, sorted(tuple(round(v, 4) for v in cell[:4]) for cell in asked[0]['cells']))
        self.assertEqual(3, len(set(asked[0]['keys'])))
        # And again, without the rule applied anew: the screen the tab itself put back is kept the same way.
        before, asked = self.round_trip([monitor('2x1'), monitor('1x1')], trips=3)
        self.assertEqual(3, len(asked), 'a later round trip lost the screen')
        for layout in asked:
            self.assertEqual(self.where(before), self.where(layout['cells']))
            self.assertEqual(self.HALVES, sorted(tuple(round(v, 4) for v in cell[:4]) for cell in layout['cells']))

    def test_02_different_columns_and_a_monitor_whose_images_start_higher(self):
        # One column on monitor 1, two on monitor 2 (2 x 3 base); monitor 2 with no strip and its toolbar at the bottom,
        # so its cells stand higher and are listed first.
        before, asked = self.round_trip([monitor('2x1'), monitor('2x2', thumbs='none', toolbar='bottom')], trips=2)
        self.assertEqual(6, len(before))
        self.assertLess(before[0][1], min(cell[1] for cell in before if cell[0] < 0.5))
        self.assertEqual(2, len(asked))
        for layout in asked:
            self.assertEqual([2, 3], [layout['rows'], layout['cols']])
            self.assertEqual(self.where(before), self.where(layout['cells']))
        # One cell on each monitor: the plain 1 x 2, the left monitor's series on the left.
        before, asked = self.round_trip([monitor('1x1'), monitor('1x1', thumbs='none', toolbar='bottom')], trips=2)
        for layout in asked:
            self.assertEqual({'rows': 1, 'cols': 2, 'keys': None}, {key: layout[key] for key in ('rows', 'cols', 'keys')})
            self.assertEqual(self.where(before), self.where(layout['cells']))
        # Two rows of two on each monitor: the plain 2 x 4, row by row and monitor by monitor.
        before, asked = self.round_trip([monitor('2x2'), monitor('2x2', thumbs='none', toolbar='bottom')])
        self.assertEqual({'rows': 2, 'cols': 4, 'keys': None}, {key: asked[0][key] for key in ('rows', 'cols', 'keys')})
        self.assertEqual(self.where(before), self.where(asked[0]['cells']))

    def test_03_the_rows_taken_back_before_the_tab_is_left_each_cell_still_comes_back_on_its_monitor(self):
        # The rows were taken back before the tab was left (the window moved or resized): the cells still stand where the
        # rule put them, and are read against the image areas registered with its rectangles.
        before, asked = self.round_trip([monitor('2x1'), monitor('2x1', thumbs='none', toolbar='bottom')], rows=False)
        self.assertEqual({'rows': 2, 'cols': 2, 'keys': None}, {key: asked[0][key] for key in ('rows', 'cols', 'keys')})
        self.assertEqual(self.where(before), self.where(asked[0]['cells']))
        before, asked = self.round_trip([monitor('2x1'), monitor('1x1')], rows=False)
        self.assertEqual(self.where(before), self.where(asked[0]['cells']))
        self.assertEqual(self.HALVES, sorted(tuple(round(v, 4) for v in cell[:4]) for cell in asked[0]['cells']))

    def test_04_a_plain_grid_and_a_screen_no_rule_left_are_kept_as_before(self):
        # No rule: a plain 2 x 2 comes back as its rows and columns, cell by cell, with no rectangles of the tab's own.
        before, asked = self.round_trip([monitor('1x1'), monitor('1x1')], rows=False, registered=False, plain=True, trips=2)
        self.assertEqual(2, len(asked))
        for layout in asked:
            self.assertEqual({'rows': 2, 'cols': 2, 'keys': None}, {key: layout[key] for key in ('rows', 'cols', 'keys')})
            self.assertEqual(self.placed(before), self.placed(layout['cells']))
        # Three cells on a 2 x 2 base that no rule registered (a cell enlarged in a window with no rule): not kept, as before.
        before, asked = self.round_trip([monitor('2x1'), monitor('1x1')], rows=False, registered=False)
        self.assertEqual([], asked)

if __name__ == '__main__':
    unittest.main()
