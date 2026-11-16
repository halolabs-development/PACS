# coding: utf-8
"""Monitors in Hanging Protocol, Worklist: Show — the worklist on its monitor. A viewer window asks the list document
that linked it (viewer-windows.js, the same BroadcastChannel as the where/here question) to put the worklist window on
a display; the list document answers with what it measured: already there, moved there, or — a browser tab, which no
page can move — a bar on the worklist screen whose button opens the worklist window on that display. A later request
moves that worklist window itself, and a rule without Worklist Show takes the bar back.

Two real Chromium pages of one browser context: a worklist page and a viewer page, both running the shipped
work-context.js and viewer-windows.js. The display rectangles are synthetic; a real two-monitor desktop is checked there."""
import json
import time
import unittest
from pathlib import Path

from playwright.sync_api import expect, sync_playwright

HPACS = Path(__file__).resolve().parents[1] / "worklist-v0" / "hpacs-lite"
ORIGIN = "https://pacs.test"
PAGE = "<!doctype html><html><head><meta charset='utf-8'></head><body style='margin:0'><main id='list'>Worklist</main></body></html>"
OWNER = ['INST-1', 'subject-1']
LIST = """owner => {
  window.synList = KinViewerWindows.create({ storage: localStorage, owner: () => JSON.stringify(owner), newId: () => crypto.randomUUID(),
    origin: location.origin, describe: () => null });
  return synList.linked('/ohif/viewer?StudyInstanceUIDs=1.2.3', 0);
}"""


class WorklistMonitorDOMTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.pw = sync_playwright().start(); cls.browser = cls.pw.chromium.launch()

    @classmethod
    def tearDownClass(cls):
        cls.browser.close(); cls.pw.stop()

    def setUp(self):
        self.context = self.browser.new_context(viewport={'width': 1200, 'height': 800})
        self.errors = []
        self.context.route(ORIGIN + "/**", lambda route: route.fulfill(body=PAGE, content_type="text/html"))
        self.list = self.page(ORIGIN + "/")
        href = self.list.evaluate(LIST, OWNER)
        self.viewer = self.page(ORIGIN + href)
        self.viewer.evaluate("owner => { window.synLink = KinViewerWindows.connect({ owner: () => owner, live: () => true }); }", OWNER)

    def tearDown(self):
        self.context.close()
        self.assertEqual([], self.errors)

    def page(self, url):
        page = self.context.new_page()
        page.on('pageerror', lambda error: self.errors.append(str(error)))
        page.goto(url)
        for name in ('work-context.js', 'viewer-windows.js'):
            page.add_script_tag(path=str(HPACS / name))
        # A signed-in session, as auth.js tells the document's work gate.
        page.evaluate("KinWorkContext.follow({ onLifecycle: listener => listener({ state: 'active', session: 'session-1' }) })")
        return page

    def place(self, target):
        return self.viewer.evaluate("target => kinViewerListPlaceOn(target)", target)

    def display(self, **extra):
        """A display beside the worklist tab: its centre is not on it."""
        geometry = self.list.evaluate("({ x: screenX, w: outerWidth })")
        return dict({'left': geometry['x'] + geometry['w'] + 40, 'top': 0, 'width': 900, 'height': 700}, **extra)

    def test_01_a_worklist_already_there_is_left_where_it_is(self):
        here = self.list.evaluate("({ left: screenX, top: screenY, width: outerWidth, height: outerHeight })")
        answer = self.place({'monitor': 0, 'rect': here})
        self.assertEqual('here', answer['result'])
        expect(self.list.locator('#kin-worklist-monitor-bar')).to_have_count(0)

    def test_02_a_tab_is_offered_the_worklist_window_on_that_monitor_and_a_clear_takes_it_back(self):
        answer = self.place({'monitor': 1, 'rect': self.display()})
        self.assertEqual('offered', answer['result'])
        bar = self.list.locator('#kin-worklist-monitor-bar')
        expect(bar).to_be_visible()
        expect(bar).to_have_attribute('role', 'status')
        expect(bar).to_contain_text('Monitor 2에 둡니다')
        expect(bar.get_by_role('button', name='Open Worklist on Monitor 2')).to_be_visible()
        self.assertEqual('cleared', self.viewer.evaluate("kinViewerListPlaceOn(null)")['result'])
        expect(bar).to_have_count(0)

    def test_03_the_button_opens_the_worklist_window_which_a_later_request_moves_itself(self):
        self.place({'monitor': 1, 'rect': self.display()})
        bar = self.list.locator('#kin-worklist-monitor-bar')
        with self.context.expect_page() as opened:
            bar.get_by_role('button', name='Open Worklist on Monitor 2').click()
        popup = opened.value
        # The window opens blank and is given this worklist's address.
        popup.wait_for_url(ORIGIN + '/')
        # Headless Chromium has one screen, the size of the page: the window cannot reach a display past it, and the bar
        # says so rather than claiming it (on a desktop with two displays and the access, it lands there).
        expect(bar).to_contain_text('목록 창을 열었지만 Monitor 2에 두지 못했습니다')
        # The where/here answer is now the worklist window's place.
        here = popup.evaluate("({ left: screenX, top: screenY, width: outerWidth, height: outerHeight })")
        self.assertEqual(here, self.viewer.evaluate("kinViewerListPlace()"))
        # A later request moves that worklist window itself (a window the page opened) and measures it there; it is
        # reused, never reopened or reloaded.
        popup.evaluate("window.synTyped = 'kept'")
        answer = self.place({'monitor': 0, 'rect': {'left': 0, 'top': 0, 'width': 400, 'height': 300}})
        self.assertEqual('moved', answer['result'])
        self.assertEqual({'left': 0, 'top': 0, 'width': 400, 'height': 300}, popup.evaluate("({ left: screenX, top: screenY, width: outerWidth, height: outerHeight })"))
        self.assertEqual('kept', popup.evaluate("window.synTyped"))
        self.assertEqual(3, len(self.context.pages))
        expect(bar).to_have_count(0)
        self.assertEqual('here', self.place({'monitor': 0, 'rect': {'left': 0, 'top': 0, 'width': 400, 'height': 300}})['result'])

    def test_03b_a_worklist_window_the_browser_can_move_is_moved_and_measured_there(self):
        # A worklist in a window a page may move (an app window or a popup; headless pages are such windows).
        answer = self.place({'monitor': 1, 'rect': {'left': 0, 'top': 0, 'width': 400, 'height': 300}})
        self.assertEqual('moved', answer['result'])
        self.assertEqual({'left': 0, 'top': 0, 'width': 400, 'height': 300}, answer['rect'])
        expect(self.list.locator('#kin-worklist-monitor-bar')).to_have_count(0)

    def test_04_only_the_linked_list_document_and_its_login_answer(self):
        # A viewer of another login on the same group gets no answer and nothing is shown.
        self.viewer.evaluate("""owner => { synLink.dispose();
          window.synOther = KinViewerWindows.connect({ owner: () => owner, live: () => true }); }""", ['INST-1', 'subject-2'])
        started = time.monotonic()
        self.assertIsNone(self.place({'monitor': 1, 'rect': self.display()}))
        self.assertGreaterEqual(time.monotonic() - started, 3.5)
        expect(self.list.locator('#kin-worklist-monitor-bar')).to_have_count(0)

    def test_05_a_request_that_is_not_a_display_is_refused(self):
        self.assertEqual('invalid', self.place({'monitor': 1, 'rect': {'left': 0, 'top': 0, 'width': 10, 'height': 10}})['result'])
        self.assertEqual('invalid', self.place({'monitor': 9, 'rect': self.display()})['result'])
        expect(self.list.locator('#kin-worklist-monitor-bar')).to_have_count(0)

    def test_06_only_the_latest_request_decides_a_clear_while_an_earlier_one_measures(self):
        # An earlier request is still measuring a move it cannot make (1.5 s) when a later rule takes the worklist back:
        # the earlier one ends without offering anything.
        self.viewer.evaluate("target => { window.synEarlier = kinViewerListPlaceOn(target); }", {'monitor': 1, 'rect': self.display()})
        self.assertEqual('cleared', self.viewer.evaluate("kinViewerListPlaceOn(null)")['result'])
        self.assertEqual('superseded', self.viewer.evaluate("synEarlier")['result'])
        expect(self.list.locator('#kin-worklist-monitor-bar')).to_have_count(0)

    def test_07_a_worklist_already_on_the_later_monitor_takes_down_an_earlier_offer(self):
        bar = self.list.locator('#kin-worklist-monitor-bar')
        self.assertEqual('offered', self.place({'monitor': 1, 'rect': self.display()})['result'])
        expect(bar).to_be_visible()
        # Another earlier request still measuring, then a later rule whose worklist monitor is where the worklist is.
        self.viewer.evaluate("target => { window.synEarlier = kinViewerListPlaceOn(target); }", {'monitor': 2, 'rect': self.display(left=5000)})
        here = self.list.evaluate("({ left: screenX, top: screenY, width: outerWidth, height: outerHeight })")
        self.assertEqual('here', self.place({'monitor': 0, 'rect': here})['result'])
        expect(bar).to_have_count(0)
        self.assertEqual('superseded', self.viewer.evaluate("synEarlier")['result'])
        expect(bar).to_have_count(0)


if __name__ == '__main__':
    unittest.main()
