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
# viewport element before the event reaches document, and its layout lands a moment later (React state). One up shows the
# double-clicked cell alone over the whole grid; the next one puts the grid it saved back.
STOCK_ONE_UP = r"""(()=>{
const contexts={DEFAULT:{}};window.stockOneUps=0;let target=null,saved=null;
document.addEventListener('dblclick',event=>{target=event.target.closest?.('[data-cell]')?.dataset.cell||null;},true);
contexts.DEFAULT.toggleOneUp={commandFn:()=>{
  stockOneUps++;const id=target;
  setTimeout(()=>{
    if(gridState.viewports.size>1){
      saved={rows:gridState.layout.numRows,cols:gridState.layout.numCols,cells:[...gridState.viewports.values()].sort((a,b)=>a.y-b.y||a.x-b.x).map(c=>structuredClone(c))};
      const cell=gridState.viewports.get(id);if(!cell)return;
      grid.setLayout({numRows:1,numCols:1,activeViewportId:id,findOrCreateViewport:()=>({viewportOptions:cell.viewportOptions,displaySetInstanceUIDs:[...cell.displaySetInstanceUIDs]})});
    }else if(saved){
      const back=saved;saved=null;
      grid.setLayout({numRows:back.rows,numCols:back.cols,activeViewportId:id,findOrCreateViewport:i=>({viewportOptions:back.cells[i].viewportOptions,displaySetInstanceUIDs:[...back.cells[i].displaySetInstanceUIDs]})});
    }
  });
}};
window.nativeCommands={
  getCommand(name,context){let found;for(const key of context?[context]:Object.keys(contexts))if(contexts[key]?.[name])found=contexts[key][name];return found},
  registerCommand(context,name,definition){if(typeof definition==='object'&&contexts[context])contexts[context][name]=definition},
  run(toRun){const definition=this.getCommand(toRun.commandName);
    return typeof definition?.commandFn==='function'?definition.commandFn({...definition.options,...toRun.commandOptions}):undefined}};
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

    def open_with_stock_one_up(self, displays):
        """The cell merge entered as the viewer enters it (config kinCreateCellMerge with the stock command manager), the stock
        one-up on every cell."""
        page = self.browser.new_page(viewport={'width': 1280, 'height': 800}); errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.route(URL, lambda route: route.fulfill(body=EIGHT, content_type='text/html'))
        page.goto(URL)
        for name in ('viewer-display-layout.js', 'viewer-features-monitors.js', 'viewer-cell-merge.js'):
            page.add_script_tag(path=str(HPACS / name))
        page.add_script_tag(content=FACTORY)
        page.add_script_tag(content=STOCK_ONE_UP)
        page.evaluate(displays)
        page.evaluate("mergeExtension.onModeEnter({servicesManager:{services},commandsManager:nativeCommands})")
        expect(page.locator('#kin-cell-merge')).to_be_visible()
        self.addCleanup(page.close)
        self.addCleanup(lambda: self.assertEqual([], errors))
        return page

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
