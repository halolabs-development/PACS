# coding: utf-8
"""Studies, Measurements and Segmentation navigation as compact controls at the top; Studies as a band above the images.

The shipped viewer-ux-shell.js and viewer-info-bar.js (with viewer-ux-theme.css) run in Chromium inside a synthetic copy
of the stock viewer's layout row: OHIF 3.9.1's two side panels as its SidePanel draws them (the panel slides out by a
negative margin and stays as a narrow strip; data-cy side-panel-header-<side> toggles it; each tab's control is
<name>-btn, in the strip while closed and in the header while open), the Studies list (studyBrowser-panel, one entry
per study with its thumbnails), the tracked-measurements list, the image column and a patient row. The tool area's
Measurements tab stands in for viewer-workspace-dock.js.
"""
from pathlib import Path
import json
import unittest

from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[1]
HPACS = ROOT / "worklist-v0" / "hpacs-lite"
ORIGIN = "https://viewer-panels.test"
OWNER = ['syn-site', 'syn-reader']

HARNESS = """<!doctype html><html><head><style>
html, body { margin: 0; height: 100%; background: #000; color: #ddd; font: 12px sans-serif; }
.flex { display: flex; } .flex-col { flex-direction: column; } .flex-row { flex-direction: row; } .flex-1 { flex: 1 1 0%; }
.h-full { height: 100%; } .w-full { width: 100%; } .relative { position: relative; } .overflow-hidden { overflow: hidden; }
[data-cy=viewport-grid] { display: grid; grid-template-columns: 1fr 1fr; }
[data-cy=viewport-pane] { position: relative; overflow: hidden; outline: 1px solid #333; }
.syn-side { flex: none; background: #111; overflow: hidden; display: flex; flex-direction: column; }
.syn-thumbs { display: grid; grid-template-columns: repeat(2, 128px); gap: 4px; }
[data-cy=study-browser-thumbnail] { width: 128px; height: 100px; background: #333; }
</style></head><body><div id="root"><div id="app" class="flex flex-col" style="height: 100vh">
  <div id="layout" class="relative flex w-full flex-row overflow-hidden flex-1">
    <div id="column" class="flex h-full flex-1 flex-col">
      <div class="relative flex h-full flex-1 overflow-hidden"><div class="h-full w-full">
        <div data-cy="viewport-grid" class="h-full w-full"><div data-cy="viewport-pane" id="pane-a"></div><div data-cy="viewport-pane" id="pane-b"></div></div>
      </div></div>
    </div>
  </div>
</div></div></body></html>"""

# OHIF 3.9.1 SidePanel, drawn again on every change as React does: open = margin 0, closed = a negative margin that
# leaves a strip; the header toggles; a tab control opens (or shows) its tab.
SETUP = """([owner, right, dock]) => {
  window.synClicks = [];
  const make = (side, tabs, open) => {
    const box = document.createElement('div'); box.className = 'syn-side';
    const state = { open, tab: 0 };
    const draw = () => {
      box.style.cssText = 'margin-' + side + ':' + (state.open ? '0px' : '-248px') + ';width:280px;max-width:280px;position:relative;top:0.2%;height:99.8%';
      const header = '<div data-cy="side-panel-header-' + side + '" style="width:30px;height:24px;background:#222">x</div>';
      const buttons = tabs.map((tab, i) => '<div data-cy="' + tab.name + '-btn" data-i="' + i + '" style="width:30px;height:24px">' + tab.name[0] + '</div>').join('');
      box.innerHTML = state.open ? '<div class="syn-head flex">' + header + buttons + '</div>' + tabs[state.tab].content : header + buttons;
      box.querySelector('[data-cy=side-panel-header-' + side + ']').onclick = () => { synClicks.push(side + ':header'); state.open = !state.open; draw(); };
      box.querySelectorAll('[data-i]').forEach(node => node.onclick = () => { synClicks.push(side + ':' + tabs[+node.dataset.i].name); state.open = true; state.tab = +node.dataset.i; draw(); });
    };
    draw(); box.synState = state; box.synDraw = draw; return box;
  };
  const studies = '<div class="flex flex-col"><div data-cy="studyBrowser-panel" class="flex flex-1 flex-col" style="overflow:auto">'
    + ['20261101 CT', '20250101 CT'].map(s => '<div class="syn-study" style="flex-shrink:0"><div>' + s + '</div><div class="syn-thumbs">'
    + '<div data-cy="study-browser-thumbnail"></div><div data-cy="study-browser-thumbnail"></div><div data-cy="study-browser-thumbnail"></div></div></div>').join('') + '</div></div>';
  const layout = document.getElementById('layout');
  layout.prepend(make('left', [{ name: 'studyBrowser', content: studies }], true));
  if (right.length) layout.append(make('right', right.map(name => ({ name, content: name === 'trackedMeasurements'
    ? '<div data-cy="trackedMeasurements-panel">Measurements (0)<div class="syn-rows"></div></div>' : '<div data-cy="' + name + '-panel">Segmentations</div>' })), false));
  if (dock) {
    const d = document.createElement('div'); d.id = 'kin-workspace-dock';
    d.innerHTML = '<nav><button type="button" aria-controls="kin-viewer-history" aria-expanded="false">Measurements</button></nav>';
    d.querySelector('button').onclick = event => { synClicks.push('dock'); const b = event.currentTarget; b.setAttribute('aria-expanded', String(b.getAttribute('aria-expanded') !== 'true')); };
    document.body.append(d);
  }
  const noEvents = () => ({ EVENTS: {}, subscribe: () => ({ unsubscribe() {} }) });
  window.cornerstone = { Enums: { Events: {}, ViewportStatus: { RENDERED: 'rendered' } }, eventTarget: new EventTarget(),
    metaData: { get: () => null }, cache: { getImage: () => null, getImageLoadObject: () => null } };
  window.synServices = { viewportGridService: { ...noEvents(), getState: () => ({ viewports: new Map(), layout: { layoutType: 'grid', numRows: 1, numCols: 2 } }), getActiveViewportId: () => null },
    displaySetService: noEvents(), cornerstoneViewportService: { ...noEvents(), getCornerstoneViewport: () => null } };
  // The patient row (viewer-patient-tabs.js) is our own top row; the Panels group goes at its end.
  window.KinViewerPatientTabs = { snapshot: () => null, subscribe: () => () => {}, refresh() {}, end() {}, guard: () => true,
    mount() { if (document.querySelector('.kin-patient-tabs')) return; const host = document.createElement('section'); host.className = 'kin-patient-tabs'; host.dataset.kinUxOwned = '';
      host.innerHTML = '<div role="tablist" aria-label="Patients"><div class="kin-patient-tab">SYN^ONE</div></div><span role="status"></span>';
      document.getElementById('app').prepend(host); },
    dispose() { document.querySelector('.kin-patient-tabs')?.remove(); } };
  window.KinViewerSeriesStrip = { mount: () => ({ refresh() {}, place() {}, orient() {}, dispose() {} }) };
  window.synSession = { owner: () => owner, ended: () => false, writer: () => true, readOnly: () => false };
  window.synMount = () => { window.synShell = KinViewerUXShell.mount({ services: synServices, session: synSession }); };
}"""
FRAME = "() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))"
BOX = """selector => { const n = document.querySelector(selector); if (!n) return null; const r = n.getBoundingClientRect();
  return { left: Math.round(r.left), top: Math.round(r.top), right: Math.round(r.right), bottom: Math.round(r.bottom), width: Math.round(r.width), height: Math.round(r.height),
    shown: getComputedStyle(n).display !== 'none' }; }"""
LEFT, RIGHT = '#layout > .syn-side:first-child', '#layout > .syn-side:last-child'


class ViewerPanelsDOMTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.pw = sync_playwright().start()
        cls.browser = cls.pw.chromium.launch()

    @classmethod
    def tearDownClass(cls):
        cls.browser.close(); cls.pw.stop()

    def open(self, right=('trackedMeasurements', 'panelSegmentation'), dock=True, size=(1366, 768)):
        context = self.browser.new_context(viewport={'width': size[0], 'height': size[1]})
        page = context.new_page(); errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        self.addCleanup(context.close)
        self.addCleanup(lambda: self.assertEqual([], errors))
        page.route(ORIGIN + "/", lambda route: route.fulfill(body=HARNESS, content_type="text/html"))
        page.goto(ORIGIN + "/")
        page.add_style_tag(path=str(HPACS / "viewer-ux-theme.css"))
        for name in ["viewer-info-bar.js", "viewer-ux-shell.js"]:
            page.add_script_tag(path=str(HPACS / name))
        page.evaluate(SETUP, [OWNER, list(right), dock])
        page.evaluate("() => synMount()")
        page.evaluate(FRAME)
        return page

    def box(self, page, selector):
        return page.evaluate(BOX, selector)

    def button(self, page, key):
        return page.locator('.kin-patient-tabs > .kin-ux-panels [data-panel=' + key + ']')

    def test_01_three_compact_buttons_at_the_top_and_no_edge_strips(self):
        page = self.open()
        self.assertEqual(['Studies', 'Measurements', 'Segmentation'],
                         page.locator('.kin-ux-panels button:not([hidden])').evaluate_all("ns => ns.map(n => n.textContent)"))
        self.assertEqual('kin-ux-panels', page.evaluate("document.querySelector('.kin-patient-tabs').lastElementChild.className"))
        expect(self.button(page, 'studies')).to_have_attribute('aria-pressed', 'true')
        expect(self.button(page, 'measurements')).to_have_attribute('aria-pressed', 'false')
        # The closed right panel's strip is not shown: the image column reaches the window's edge.
        self.assertFalse(self.box(page, RIGHT)['shown'])
        self.assertEqual(1366, self.box(page, '#column')['right'])

    def test_02_studies_lies_across_the_top_and_gives_its_height_back_when_closed(self):
        page = self.open()
        left, column, grid = self.box(page, LEFT), self.box(page, '#column'), self.box(page, '[data-cy=viewport-grid]')
        self.assertLessEqual(left['bottom'], column['top'], (left, column))
        self.assertEqual((0, 1366), (left['left'], left['right']), 'as wide as the images and the right panel')
        self.assertEqual((0, 1366), (column['left'], column['right']))
        # Studies run left to right; each study's thumbnails in one row.
        studies = page.evaluate("""() => [...document.querySelectorAll('.syn-study')].map(s => { const r = s.getBoundingClientRect(); return [Math.round(r.left), Math.round(r.top)]; })""")
        self.assertEqual(studies[0][1], studies[1][1]); self.assertLess(studies[0][0], studies[1][0])
        thumbs = page.evaluate("""() => new Set([...document.querySelectorAll('.syn-study:first-child [data-cy=study-browser-thumbnail]')].map(t => Math.round(t.getBoundingClientRect().top))).size""")
        self.assertEqual(1, thumbs)
        self.button(page, 'studies').click()
        page.evaluate(FRAME)
        closed = self.box(page, '[data-cy=viewport-grid]')
        self.assertGreater(closed['height'], grid['height'] + 100)
        self.assertEqual(grid['width'], closed['width'])
        self.assertFalse(self.box(page, LEFT)['shown'], 'the closed Studies panel leaves no strip')
        expect(self.button(page, 'studies')).to_have_attribute('aria-pressed', 'false')
        stored = page.evaluate("Object.entries(localStorage).filter(([k]) => k.startsWith('kin-viewer-side-panels:v1:')).map(([, v]) => JSON.parse(v))")
        self.assertEqual([{'left': False}], stored, "a choice made with the compact button is kept as the reader's")
        self.button(page, 'studies').click()
        page.evaluate(FRAME)
        self.assertEqual(grid, self.box(page, '[data-cy=viewport-grid]'))
        self.assertEqual(['left:header', 'left:header'], page.evaluate("synClicks"))

    def test_03_measurements_and_segmentation_open_their_tab_switch_and_close(self):
        page = self.open()
        self.button(page, 'measurements').click()
        page.evaluate(FRAME)
        expect(page.locator('[data-cy=trackedMeasurements-panel]')).to_have_count(1)
        expect(self.button(page, 'measurements')).to_have_attribute('aria-pressed', 'true')
        right = self.box(page, RIGHT)
        self.assertTrue(right['shown']); self.assertEqual(1366, right['right'])
        self.assertLess(self.box(page, '#column')['right'], right['left'] + 1)
        self.button(page, 'segmentation').click()
        page.evaluate(FRAME)
        expect(page.locator('[data-cy=panelSegmentation-panel]')).to_have_count(1)
        expect(self.button(page, 'segmentation')).to_have_attribute('aria-pressed', 'true')
        expect(self.button(page, 'measurements')).to_have_attribute('aria-pressed', 'false')
        self.button(page, 'segmentation').click()
        page.evaluate(FRAME)
        self.assertFalse(self.box(page, RIGHT)['shown'])
        self.assertEqual(['right:trackedMeasurements', 'right:panelSegmentation', 'right:header'], page.evaluate("synClicks"))
        stored = page.evaluate("Object.entries(localStorage).filter(([k]) => k.startsWith('kin-viewer-side-panels:v1:')).map(([, v]) => JSON.parse(v))")
        self.assertEqual([{'right': False}], stored)

    def test_04_where_a_control_is_missing_its_button_is_not_shown_and_the_stock_way_in_stays(self):
        page = self.open(right=('trackedMeasurements',))
        expect(self.button(page, 'segmentation')).to_be_hidden()
        expect(self.button(page, 'measurements')).to_be_visible()
        page = self.open(right=())
        self.assertEqual(['Studies'], page.locator('.kin-ux-panels button:not([hidden])').evaluate_all("ns => ns.map(n => n.textContent)"))
        # A second window that shows images only hides the top rows: the stock strips are the way in again.
        page = self.open()
        page.evaluate("() => { document.body.classList.add('kin-second-display-rows-off'); document.getElementById('app').append(document.createElement('i')); }")
        page.evaluate(FRAME)
        self.assertTrue(self.box(page, RIGHT)['shown'])
        self.assertIsNone(page.evaluate("document.body.getAttribute('data-kin-panels')"))

    def test_05_the_empty_tracked_list_says_what_it_lists_and_opens_the_measurements_list(self):
        page = self.open()
        self.button(page, 'measurements').click()
        page.evaluate(FRAME)
        hint = page.locator('.kin-tracked-hint')
        expect(hint).to_contain_text('only measurements accepted for tracking')
        hint.get_by_role('button', name='Open Measurements List').click()
        self.assertEqual('true', page.evaluate("document.querySelector('#kin-workspace-dock button').getAttribute('aria-expanded')"))
        self.assertEqual('kin-viewer-history', page.evaluate("document.activeElement.getAttribute('aria-controls')"))
        # Pressed again while that list is open: it stays open.
        hint.get_by_role('button', name='Open Measurements List').click()
        self.assertEqual(['right:trackedMeasurements', 'dock'], page.evaluate("synClicks"))
        # Rows accepted for tracking: the note goes.
        page.evaluate("() => { document.querySelector('.syn-rows').innerHTML = '<div data-cy=\"data-row\">Length 70.6 mm</div>'; }")
        page.evaluate(FRAME)
        expect(hint).to_have_count(0)
        # No tool area in this window: the note stays, without a button that would do nothing.
        page = self.open(dock=False)
        self.button(page, 'measurements').click()
        page.evaluate(FRAME)
        expect(page.locator('.kin-tracked-hint')).to_have_count(1)
        expect(page.locator('.kin-tracked-hint button')).to_be_hidden()


if __name__ == "__main__":
    unittest.main()
