# coding: utf-8
"""A viewer window over two monitors, each showing 2 x 2 (one 2 x 4 grid whose middle edge is the display edge): a
double click on a cell fills that cell's monitor only, the other monitor keeps its four cells, and a second double click
puts the eight cells back. One display, or a window inside one display, keeps the whole-grid maximize.

Runs the shipped viewer-cell-merge.js, viewer-display-layout.js and viewer-features-monitors.js (its display-edge reading,
kinViewerMonitorEdges) in Chromium on the synthetic grid of viewer_cell_merge_dom_test.py widened to eight cells, with a
synthetic screen-details answer (window-management already granted) for two displays meeting in the middle of the grid.
Real monitors are not emulated: the same double click on a real two-monitor desktop is checked there."""
import unittest
from pathlib import Path

from playwright.sync_api import expect, sync_playwright

from viewer_cell_merge_dom_test import FACTORY, HARNESS

HPACS = Path(__file__).resolve().parents[1] / "worklist-v0" / "hpacs-lite"
# The stock viewer's own double click (initDoubleClick -> toggleOneUp), as the pinned viewer does it: it runs on the
# viewport element before the event reaches document, reads the grid as it is then, and its layout lands a moment later
# (React state). One up shows the active cell alone over the whole grid - the same viewport id, the very options object of
# that cell; from one cell it puts the grid it saved back, whatever series the one cell shows by then. A press on a cell
# makes it the active one.
STOCK_ONE_UP = r"""(()=>{
const contexts={DEFAULT:{}};window.stockOneUps=0;let saved=null;
document.addEventListener('mousedown',event=>{const id=event.target.closest?.('[data-cell]')?.dataset.cell;if(id&&gridState.viewports.has(id))gridState.activeViewportId=id;},true);
contexts.DEFAULT.toggleOneUp={commandFn:()=>{
  stockOneUps++;
  const layout=gridState.layout,id=gridState.activeViewportId,cell=gridState.viewports.get(id);
  if(!(layout.numRows===1&&layout.numCols===1)){
    saved={rows:layout.numRows,cols:layout.numCols,active:id,cells:[...gridState.viewports.values()].sort((a,b)=>a.y-b.y||a.x-b.x)};
    const one={viewportOptions:cell.viewportOptions,displaySetInstanceUIDs:[...cell.displaySetInstanceUIDs]};
    setTimeout(()=>grid.setLayout({numRows:1,numCols:1,activeViewportId:id,findOrCreateViewport:()=>one}));
  }else if(saved){
    const back=saved;saved=null;
    setTimeout(()=>grid.setLayout({numRows:back.rows,numCols:back.cols,activeViewportId:back.active,
      findOrCreateViewport:i=>({viewportOptions:back.cells[i].viewportOptions,displaySetInstanceUIDs:[...back.cells[i].displaySetInstanceUIDs]})}));
  }
}};
window.nativeCommands={
  getCommand(name,context){let found;for(const key of context?[context]:Object.keys(contexts))if(contexts[key]?.[name])found=contexts[key][name];return found},
  registerCommand(context,name,definition){if(typeof definition==='object'&&contexts[context])contexts[context][name]=definition},
  run(toRun){const definition=this.getCommand(toRun.commandName);
    return typeof definition?.commandFn==='function'?definition.commandFn({...definition.options,...toRun.commandOptions}):undefined}};
})();"""
# The image side of the synthetic grid for the display span (viewer-display-span.js): each series has its images, each
# viewport the image ids of its series, and the Layout menu's command as the pinned viewer runs it - a moment later, a
# position that already has a cell keeps it (the same viewport id) with a new layout, a new position stays empty.
SPAN = r"""(()=>{
window.cornerstone={metaData:{get:(type,id)=>type==='instance'&&/^wadors:/.test(id||'')?{SOPInstanceUID:'sop:'+id.split(':')[1]}:undefined}};
for(const set of displaySets.values())set.images=[{SOPInstanceUID:'sop:'+set.displaySetInstanceUID.slice(3)}];
const frames=v=>Object.assign(v,{getImageIds(){return [this.current]}});
nativeViewports.forEach(frames);const make=makeViewport;makeViewport=(id,seed)=>frames(make(id,seed));
let fresh=0;
window.layoutCommand={calls:[],runCommand(name,options){
  this.calls.push([name,options.numRows,options.numCols]);
  if(name==='setViewportGridLayout')setTimeout(()=>{
    const {numRows:rows,numCols:cols}=gridState.layout,kept=new Map([...gridState.viewports.values()].map(c=>[Math.round(c.x*cols)+'-'+Math.round(c.y*rows),c]));
    grid.setLayout({numRows:options.numRows,numCols:options.numCols,activeViewportId:gridState.activeViewportId,findOrCreateViewport:i=>{
      const old=kept.get((i%options.numCols)+'-'+Math.floor(i/options.numCols));
      return old?{viewportOptions:{...old.viewportOptions},displaySetInstanceUIDs:[...old.displaySetInstanceUIDs]}
        :{viewportOptions:{viewportId:'new-'+(++fresh),id:'slot-new-'+fresh,toolGroupId:'default'},displaySetInstanceUIDs:[]};}});
  });}};
// Another series dropped on a cell: the grid keeps its layout, the cell is a new object with new options.
window.dropSeries=(id,uid)=>{const old=gridState.viewports.get(id),viewports=new Map(gridState.viewports);
  displaySets.set(uid,{displaySetInstanceUID:uid,Modality:'CT',images:[{SOPInstanceUID:'sop:'+id}]});
  viewports.set(id,{...old,displaySetInstanceUIDs:[uid],viewportOptions:{...old.viewportOptions}});gridState.viewports=viewports;};
window.mountSpan=()=>{window.span=KinViewerDisplaySpan.mount({services,commands:layoutCommand,enabled:()=>false});};
window.divisions=()=>layoutCommand.calls.filter(call=>call[0]==='setViewportGridLayout').map(call=>call.slice(1));
})();"""
URL = "https://monitors.test/ohif/viewer?StudyInstanceUIDs=1.2.1"
EIGHT = (HARNESS
         .replace('<div id="grid" style="position:relative;width:600px;height:400px;background:#111"></div>',
                  '<div id="grid" data-cy="viewport-grid" style="position:relative;width:800px;height:400px;background:#111"></div>')
         .replace("['A','B','C','D'].forEach((name,index)=>{", "['A','B','C','D','E','F','G','H'].forEach((name,index)=>{")
         .replace("cells.set(name,{viewportId:name,x:(index%2)/2,y:Math.floor(index/2)/2,width:.5,height:.5,",
                  "cells.set(name,{viewportId:name,x:(index%4)/4,y:Math.floor(index/4)/2,width:.25,height:.5,")
         .replace("place(name,(index%2)/2,Math.floor(index/2)/2,.5,.5);", "place(name,(index%4)/4,Math.floor(index/4)/2,.25,.5);")
         .replace("layout:{layoutType:'grid',numRows:2,numCols:2}", "layout:{layoutType:'grid',numRows:2,numCols:4}"))
# Two cells side by side, one per monitor (1 x 2).
PAIR = (HARNESS
        .replace('<div id="grid" style="position:relative;width:600px;height:400px;background:#111"></div>',
                 '<div id="grid" data-cy="viewport-grid" style="position:relative;width:800px;height:400px;background:#111"></div>')
        .replace("['A','B','C','D'].forEach((name,index)=>{", "['A','B'].forEach((name,index)=>{")
        .replace("cells.set(name,{viewportId:name,x:(index%2)/2,y:Math.floor(index/2)/2,width:.5,height:.5,",
                 "cells.set(name,{viewportId:name,x:index/2,y:0,width:.5,height:1,")
        .replace("place(name,(index%2)/2,Math.floor(index/2)/2,.5,.5);", "place(name,index/2,0,.5,1);")
        .replace("layout:{layoutType:'grid',numRows:2,numCols:2}", "layout:{layoutType:'grid',numRows:1,numCols:2}"))
assert PAIR.count("['A','B'].forEach") == 1 and "numRows:1,numCols:2" in PAIR and "x:index/2,y:0,width:.5,height:1," in PAIR

# Two displays side by side meeting at the grid's middle (client x = grid left + 400), the access already granted.
TWO_DISPLAYS = """() => {
  const grid = document.querySelector('[data-cy="viewport-grid"]').getBoundingClientRect();
  const frame = (outerWidth - innerWidth) / 2, seam = screenX + frame + grid.left + grid.width / 2;
  const screens = [{ left: seam - 1600, width: 1600 }, { left: seam, width: 1600 }].map((s, i) => ({ availLeft: s.left, availTop: screenY,
    availWidth: s.width, availHeight: 2000, left: s.left, top: screenY, width: s.width, height: 2000, isPrimary: i === 0, devicePixelRatio }));
  const query = navigator.permissions.query.bind(navigator.permissions);
  navigator.permissions.query = async value => value?.name === 'window-management' ? { state: 'granted', onchange: null } : query(value);
  window.getScreenDetails = async () => ({ screens, currentScreen: screens[0], addEventListener() {}, removeEventListener() {} });
  Object.defineProperty(screen, 'isExtended', { configurable: true, get: () => true });
}"""
# No access: only the window's own display (window.screen) is known; the grid's right half is past it.
OWN_DISPLAY_ONLY = """() => {
  const grid = document.querySelector('[data-cy="viewport-grid"]').getBoundingClientRect();
  const frame = (outerWidth - innerWidth) / 2, seam = screenX + frame + grid.left + grid.width / 2;
  for (const [key, value] of Object.entries({ availLeft: seam - 1600, availTop: screenY, availWidth: 1600, availHeight: 2000, isExtended: true }))
    Object.defineProperty(screen, key, { configurable: true, get: () => value });
  const query = navigator.permissions.query.bind(navigator.permissions);
  navigator.permissions.query = async value => value?.name === 'window-management' ? { state: 'prompt', onchange: null } : query(value);
}"""
ONE_DISPLAY = "() => { Object.defineProperty(screen, 'isExtended', { configurable: true, get: () => false }); }"


class MonitorDoubleClickDOMTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.pw = sync_playwright().start(); cls.browser = cls.pw.chromium.launch()

    @classmethod
    def tearDownClass(cls):
        cls.browser.close(); cls.pw.stop()

    def open(self, displays):
        page = self.browser.new_page(viewport={'width': 1280, 'height': 800}); errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.route(URL, lambda route: route.fulfill(body=EIGHT, content_type='text/html'))
        page.goto(URL)
        for name in ('viewer-display-layout.js', 'viewer-features-monitors.js', 'viewer-cell-merge.js'):
            page.add_script_tag(path=str(HPACS / name))
        page.evaluate(displays)
        self.assertTrue(page.evaluate('mountDirect()'))
        self.addCleanup(page.close)
        self.addCleanup(lambda: self.assertEqual([], errors))
        return page

    def open_with_stock_one_up(self, displays, harness=EIGHT, span=False):
        """The cell merge entered as the viewer enters it (config kinCreateCellMerge with the stock command manager), the stock
        one-up on every cell. span: the display span (viewer-display-span.js) runs over the same grid."""
        page = self.browser.new_page(viewport={'width': 1280, 'height': 800}); errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.route(URL, lambda route: route.fulfill(body=harness, content_type='text/html'))
        page.goto(URL)
        for name in ('viewer-display-layout.js', 'viewer-features-monitors.js', 'viewer-cell-merge.js') + (('viewer-display-span.js',) if span else ()):
            page.add_script_tag(path=str(HPACS / name))
        page.add_script_tag(content=FACTORY)
        page.add_script_tag(content=STOCK_ONE_UP)
        page.evaluate(displays)
        page.evaluate("mergeExtension.onModeEnter({servicesManager:{services},commandsManager:nativeCommands})")
        expect(page.locator('#kin-cell-merge')).to_be_visible()
        if span:
            page.add_script_tag(content=SPAN)
            page.evaluate('mountSpan()')
        self.addCleanup(page.close)
        self.addCleanup(lambda: self.assertEqual([], errors))
        return page

    def edges_known(self, page, edges):
        self.assertEqual(edges, page.evaluate('kinViewerMonitorEdges()'))
        page.wait_for_function("edges => JSON.stringify(kinViewerMonitorEdgesNow()) === edges", arg=str(edges).replace(' ', ''))

    def boxes(self, page):
        return page.evaluate("geometry()")

    def dblclick(self, page, cell):
        page.locator(f'[data-cell="{cell}"]').dblclick()

    def test_01_a_double_click_fills_its_monitor_and_the_other_monitor_keeps_its_four_cells(self):
        page = self.open(TWO_DISPLAYS)
        before = self.boxes(page)
        self.assertEqual([0.5], page.evaluate('kinViewerMonitorEdges()'))
        self.dblclick(page, 'F')
        page.wait_for_function("geometry().length === 5")
        self.assertEqual([['F', 0, 0, 0.5, 1], ['C', 0.5, 0, 0.25, 0.5], ['D', 0.75, 0, 0.25, 0.5], ['G', 0.5, 0.5, 0.25, 0.5], ['H', 0.75, 0.5, 0.25, 0.5]],
                         self.boxes(page))
        # On screen: F covers the left monitor's half of the grid, C still its own quarter on the right.
        grid = page.locator('#grid').bounding_box(); f = page.locator('[data-cell="F"]').bounding_box(); c = page.locator('[data-cell="C"]').bounding_box()
        self.assertAlmostEqual(f['width'], grid['width'] / 2, delta=1); self.assertAlmostEqual(f['height'], grid['height'], delta=1)
        self.assertAlmostEqual(c['x'], grid['x'] + grid['width'] / 2, delta=1)
        expect(page.locator('#kin-cell-merge [role=status]')).to_contain_text('그 모니터의 한 화면')
        expect(page.locator('#kin-cell-merge [data-cell-merge-hint]')).to_contain_text('그 모니터만 확대한 상태')
        # A second double click puts the eight cells back (the same toggle as on one monitor).
        self.dblclick(page, 'F')
        page.wait_for_function("geometry().length === 8")
        self.assertEqual(before, self.boxes(page))
        expect(page.locator('#kin-cell-merge [role=status]')).to_contain_text('되돌렸습니다')
        # And the right monitor the same way.
        self.dblclick(page, 'C')
        page.wait_for_function("geometry().length === 5")
        self.assertEqual(['C', 0.5, 0, 0.5, 1], self.boxes(page)[2])

    def test_02_maximize_cell_button_follows_the_same_monitor_rule(self):
        page = self.open(TWO_DISPLAYS)
        page.evaluate("mergeController.merge('maximize','H')")
        page.wait_for_function("geometry().length === 5")
        self.assertIn(['H', 0.5, 0, 0.5, 1], self.boxes(page))

    def test_03_without_the_access_the_own_display_still_gives_the_edge(self):
        page = self.open(OWN_DISPLAY_ONLY)
        self.assertEqual([0.5], page.evaluate('kinViewerMonitorEdges()'))
        self.dblclick(page, 'A')
        page.wait_for_function("geometry().length === 5")
        self.assertEqual(['A', 0, 0, 0.5, 1], self.boxes(page)[0])

    def test_05_a_window_over_the_next_display_by_100px_is_refused_not_maximized_across(self):
        # The second display begins 100px before the grid's right end: narrower than a monitor region, still another
        # monitor under the grid. The maximize would reach over it, so it is refused and the eight cells stay.
        page = self.open(TWO_DISPLAYS.replace('seam = screenX + frame + grid.left + grid.width / 2', 'seam = screenX + frame + grid.left + grid.width - 100'))
        self.assertEqual([0.875], page.evaluate('kinViewerMonitorEdges()'))
        self.dblclick(page, 'A')
        expect(page.locator('#kin-cell-merge [role=status]')).to_contain_text('모니터 경계에 걸쳐')
        self.assertEqual(8, len(self.boxes(page)))

    def test_06_over_two_monitors_the_stock_one_up_yields_to_the_monitor_maximize(self):
        # A window over two monitors, each 2 x 2: the double click is the monitor maximize's alone. The stock one-up used to
        # take the whole window first, so the monitor maximize refused ('…화면이 바뀌어…') and two monitors showed one cell.
        page = self.open_with_stock_one_up(TWO_DISPLAYS)
        # The displays are read already (in the viewer the access was given long before the reader double-clicks).
        self.assertEqual([0.5], page.evaluate('kinViewerMonitorEdges()'))
        page.wait_for_function("typeof kinViewerMonitorEdgesNow !== 'function' || JSON.stringify(kinViewerMonitorEdgesNow()) === '[0.5]'")
        before = self.boxes(page)
        self.dblclick(page, 'A')
        page.wait_for_function("geometry().length === 5")
        page.wait_for_timeout(300)
        self.assertEqual([['A', 0, 0, 0.5, 1], ['C', 0.5, 0, 0.25, 0.5], ['D', 0.75, 0, 0.25, 0.5], ['G', 0.5, 0.5, 0.25, 0.5], ['H', 0.75, 0.5, 0.25, 0.5]],
                         self.boxes(page))
        expect(page.locator('#kin-cell-merge [role=status]')).to_contain_text('그 모니터의 한 화면')
        self.assertEqual(0, page.evaluate('stockOneUps'))
        # Again: the eight cells come back.
        self.dblclick(page, 'A')
        page.wait_for_function("geometry().length === 8")
        page.wait_for_timeout(300)
        self.assertEqual(before, self.boxes(page))
        expect(page.locator('#kin-cell-merge [role=status]')).to_contain_text('되돌렸습니다')
        # The right monitor the same way.
        self.dblclick(page, 'G')
        page.wait_for_function("geometry().length === 5")
        page.wait_for_timeout(300)
        self.assertIn(['G', 0.5, 0, 0.5, 1], self.boxes(page))
        self.dblclick(page, 'G')
        page.wait_for_function("geometry().length === 8")
        self.assertEqual(0, page.evaluate('stockOneUps'))

    def test_08_where_the_monitor_maximize_cannot_be_made_the_stock_one_up_still_runs(self):
        # The next display begins 100px before the grid's right end: the monitor maximize would reach over it and refuses,
        # so the double click is left to the stock one-up, as before.
        page = self.open_with_stock_one_up(TWO_DISPLAYS.replace('seam = screenX + frame + grid.left + grid.width / 2', 'seam = screenX + frame + grid.left + grid.width - 100'))
        self.assertEqual([0.875], page.evaluate('kinViewerMonitorEdges()'))
        page.wait_for_function("JSON.stringify(kinViewerMonitorEdgesNow()) === '[0.875]'")
        self.dblclick(page, 'A')
        page.wait_for_function("stockOneUps === 1")
        # Its one cell is the stock toggle's own (the display span leaves it to that toggle), until it puts the grid back.
        page.wait_for_function("geometry().length === 1")
        self.assertTrue(page.evaluate('kinViewerStockOneUp()'))
        self.dblclick(page, 'A')
        page.wait_for_function("stockOneUps === 2 && geometry().length === 8")
        self.assertFalse(page.evaluate('kinViewerStockOneUp()'))

    def test_09_mg_one_monitor_maximized_inverted_and_restored_keeps_every_frame_and_the_inversion(self):
        # Mammograms on two monitors: one monitor's cell maximized, the reader inverts it, the grid comes back. Each cell is
        # back on its own original and frame, and the inversion the reader made stays.
        page = self.open_with_stock_one_up(TWO_DISPLAYS)
        self.assertEqual([0.5], page.evaluate('kinViewerMonitorEdges()'))
        page.wait_for_function("JSON.stringify(kinViewerMonitorEdgesNow()) === '[0.5]'")
        page.evaluate("() => { for (const set of displaySets.values()) set.Modality = 'MG'; [...nativeViewports.values()].forEach((v, i) => v.setImageIdIndex(i % 3)); }")
        frames = page.evaluate("() => Object.fromEntries([...nativeViewports].map(([id, v]) => [id, v.getCurrentImageId()]))")
        self.dblclick(page, 'B')
        page.wait_for_function("geometry().length === 5")
        page.wait_for_timeout(300)
        self.assertIn(['B', 0, 0, 0.5, 1], self.boxes(page))
        page.locator('[data-cell="B"]').click()
        page.evaluate("() => { const v = nativeViewports.get('B'); v.setProperties({ invert: true }); v.render(); }")
        self.dblclick(page, 'B')
        page.wait_for_function("geometry().length === 8")
        expect(page.locator('#kin-cell-merge [role=status]')).to_contain_text('되돌렸습니다')
        self.assertEqual(frames, page.evaluate("() => Object.fromEntries([...nativeViewports].map(([id, v]) => [id, v.getCurrentImageId()]))"))
        self.assertEqual({'A': False, 'B': True, 'C': False, 'D': False, 'E': False, 'F': False, 'G': False, 'H': False},
                         page.evaluate("() => Object.fromEntries([...nativeViewports].map(([id, v]) => [id, !!v.getProperties().invert]))"))
        self.assertEqual(0, page.evaluate('stockOneUps'))

    NEAR_END = TWO_DISPLAYS.replace('seam = screenX + frame + grid.left + grid.width / 2', 'seam = screenX + frame + grid.left + grid.width - 100')

    def test_10_two_cells_on_two_monitors_stay_two_on_a_double_click(self):
        # One cell per monitor already: nothing to enlarge. The stock one-up would have made one cell of the two monitors.
        page = self.open_with_stock_one_up(TWO_DISPLAYS, harness=PAIR)
        self.edges_known(page, [0.5])
        before = self.boxes(page)
        self.dblclick(page, 'A')
        expect(page.locator('#kin-cell-merge [role=status]')).to_contain_text('이미 그 모니터의 한 화면')
        page.wait_for_timeout(400)
        self.assertEqual(before, self.boxes(page))
        self.assertEqual(0, page.evaluate('stockOneUps'))
        self.dblclick(page, 'B')
        page.wait_for_timeout(400)
        self.assertEqual(before, self.boxes(page))
        self.assertEqual(0, page.evaluate('stockOneUps'))

    def test_11_the_cell_really_clicked_decides_not_the_active_one(self):
        # The active cell (A, left monitor) is empty; the reader double-clicks G on the right monitor before the viewer has
        # made it the active cell. G's monitor is filled, and the stock one-up is not run for the empty active cell.
        page = self.open_with_stock_one_up(TWO_DISPLAYS)
        self.edges_known(page, [0.5])
        page.evaluate("""() => { gridState.viewports.get('A').displaySetInstanceUIDs = []; nativeViewports.get('A').current = null; gridState.activeViewportId = 'A'; }""")
        page.evaluate("""() => document.querySelector('[data-cell="G"]').dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, button: 0, detail: 2 }))""")
        page.wait_for_function("geometry().length === 5")
        self.assertIn(['G', 0.5, 0, 0.5, 1], self.boxes(page))
        self.assertEqual(0, page.evaluate('stockOneUps'))

    def test_12_what_was_decided_for_one_click_is_not_inherited(self):
        page = self.open_with_stock_one_up(TWO_DISPLAYS)
        self.edges_known(page, [0.5])
        # A double click a measurement tool used never reaches the stock one-up or this panel.
        page.evaluate("""() => document.querySelector('[data-cell="A"]').addEventListener('dblclick', event => { if (window.toolTakesIt) event.stopImmediatePropagation(); }, true)""")
        page.evaluate("window.toolTakesIt = true")
        self.dblclick(page, 'A')
        page.wait_for_timeout(300)
        self.assertEqual(8, len(self.boxes(page)))
        self.assertEqual(0, page.evaluate('stockOneUps'))
        # The stock one-up asked for outside a double click (a key, a menu) is the stock one-up's: nothing of that click is left.
        page.evaluate("nativeCommands.run({ commandName: 'toggleOneUp', commandOptions: {} })")
        page.wait_for_function("stockOneUps === 1 && geometry().length === 1")
        page.evaluate("nativeCommands.run({ commandName: 'toggleOneUp', commandOptions: {} })")
        page.wait_for_function("stockOneUps === 2 && geometry().length === 8")
        # A double click with a modifier key is nobody's (the stock viewer runs no command for it): the next plain one is
        # decided afresh.
        page.evaluate("window.toolTakesIt = false")
        page.locator('[data-cell="A"]').dblclick(modifiers=['Shift'])
        page.wait_for_timeout(300)
        self.assertEqual(8, len(self.boxes(page)))
        self.dblclick(page, 'A')
        page.wait_for_function("geometry().length === 5")
        self.assertIn(['A', 0, 0, 0.5, 1], self.boxes(page))

    def test_13_the_stock_one_up_cell_is_its_own_until_another_layout_replaces_it(self):
        # A grid the monitor maximize refuses (a cell lies over the display edge): the stock one-up makes one cell of the
        # window. The display span, which divides one column over two monitors, leaves that cell to the toggle.
        page = self.open_with_stock_one_up(self.NEAR_END, span=True)
        self.edges_known(page, [0.875])
        before = self.boxes(page)
        self.dblclick(page, 'A')
        page.wait_for_function("stockOneUps === 1 && geometry().length === 1")
        page.wait_for_timeout(2500)
        self.assertEqual([], page.evaluate('divisions()'))
        self.assertTrue(page.evaluate('kinViewerStockOneUp()'))
        # Another series dropped on that cell: still the toggle's cell, and the toggle still puts the grid back.
        page.evaluate("dropSeries('A', 'ds-other')")
        page.wait_for_timeout(2500)
        self.assertEqual([], page.evaluate('divisions()'))
        self.assertTrue(page.evaluate('kinViewerStockOneUp()'))
        self.dblclick(page, 'A')
        page.wait_for_function("stockOneUps === 2 && geometry().length === 8")
        self.assertEqual(before, self.boxes(page))
        self.assertFalse(page.evaluate('kinViewerStockOneUp()'))

    def test_14_one_cell_picked_again_on_the_enlarged_cell_is_a_new_layout_and_is_divided(self):
        page = self.open_with_stock_one_up(self.NEAR_END, span=True)
        self.edges_known(page, [0.875])
        self.dblclick(page, 'A')
        page.wait_for_function("stockOneUps === 1 && geometry().length === 1")
        page.wait_for_timeout(1500)
        self.assertEqual([], page.evaluate('divisions()'))
        # The reader picks 1 x 1 in the Layout menu: the same cell id, a new layout. It is no longer the toggle's cell.
        page.evaluate("layoutCommand.runCommand('setViewportGridLayout', { numRows: 1, numCols: 1 })")
        page.wait_for_function("divisions().some(call => call[0] === 1 && call[1] === 2)", timeout=6000, polling=250)
        page.wait_for_function("geometry().length === 2")
        self.assertEqual('A', self.boxes(page)[0][0])
        self.assertFalse(page.evaluate('kinViewerStockOneUp()'))

    def test_15_a_saved_one_cell_layout_applied_over_the_enlarged_cell_is_divided(self):
        page = self.open_with_stock_one_up(self.NEAR_END, span=True)
        self.edges_known(page, [0.875])
        self.dblclick(page, 'B')
        page.wait_for_function("stockOneUps === 1 && geometry().length === 1")
        # A saved Job (or a protocol) puts its own one cell on screen: a new viewport showing a series.
        page.evaluate("""() => grid.setLayout({ numRows: 1, numCols: 1, activeViewportId: 'job-1',
          findOrCreateViewport: () => ({ viewportOptions: { viewportId: 'job-1', id: 'slot-job-1', toolGroupId: 'default' }, displaySetInstanceUIDs: ['ds-C'] }) })""")
        page.evaluate("() => { nativeViewports.get('job-1').current = 'wadors:C:0'; }")
        page.wait_for_function("divisions().some(call => call[0] === 1 && call[1] === 2)", timeout=6000, polling=250)
        page.wait_for_function("geometry().length === 2")
        self.assertFalse(page.evaluate('kinViewerStockOneUp()'))

    def test_07_on_one_display_the_stock_one_up_still_runs(self):
        page = self.open_with_stock_one_up(ONE_DISPLAY)
        self.dblclick(page, 'A')
        page.wait_for_function("geometry().length === 1")
        self.assertEqual(1, page.evaluate('stockOneUps'))

    def test_04_one_display_keeps_the_whole_grid_rule(self):
        page = self.open(ONE_DISPLAY)
        self.assertEqual([], page.evaluate('kinViewerMonitorEdges()'))
        self.dblclick(page, 'A')
        # A 2 x 4 grid on one display is not one the viewer enlarges, as before.
        expect(page.locator('#kin-cell-merge [role=status]')).to_contain_text('1·2·4화면')
        self.assertEqual(8, len(self.boxes(page)))


if __name__ == '__main__':
    unittest.main()
