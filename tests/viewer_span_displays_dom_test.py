# coding: utf-8
"""Viewer Windows > Span Displays when the browser will not move the viewer window over two displays (a browser keeps a
popup on one display): the reader is told to drag the window over the two displays, and once it stands there the place
and the two displays are saved. Runs the page's own mountViewerWindows / openOhifWindow code (sliced from main.html as
tests/viewer_window_manager_dom_test.py does) with the shipped viewer-display-layout.js, over two synthetic displays.
Real monitors are not emulated: the same drag on a real two-monitor desktop is checked there."""
import unittest

from playwright.sync_api import expect, sync_playwright

from page_source import read_page_bytes
from viewer_window_manager_dom_test import HARNESS, MAIN, WINDOWS, extract_function, page_functions_called_by

LAYOUT = (MAIN.parent / "viewer-display-layout.js").read_text(encoding="utf-8")
# The manager's harness with the shipped display geometry (not its stand-in), two displays side by side known to the page,
# the page's own window-rectangle reader, and a record of the places saved.
SPAN_HARNESS = (HARNESS
                .replace("const KinViewerDisplayLayout = {span:()=>null,screens:details=>details.screens||[],identity:screen=>screen.id,\n"
                         "  fit:()=>({left:10,top:10,width:800,height:600})};\n", "")
                .replace(", popupRect=()=>null;", ";")
                .replace("rememberOhifRect=()=>true,", "rememberOhifRect=popup=>{const rect=popupRect(popup);__remembered.push(rect);return !!rect},")
                .replace("const screensCache=[display];",
                         "const screensCache=[{left:0,top:0,width:1920,height:1040},{left:1920,top:0,width:1920,height:1040}];window.__remembered=[];")
                # The manager's 2 s refresh also asks the page's multi-study view (none here); these cases run past it.
                # The page's own writer without a screen language (main.html kinWrite, as page-core.js has it).
                .replace("<script>\n", "<script>\n" + LAYOUT + "\nlet multiStudyView=null;\n"
                         "function kinWrite(el, value, name) { if (name) el.setAttribute(name, value); else el.textContent = value; return el; }\n", 1))
assert SPAN_HARNESS.count("KinViewerDisplayLayout = {span") == 0 and "popupRect=()=>null" not in SPAN_HARNESS
# Two displays side by side; the browser moves nothing (a popup stays on its display).
TWO = """() => {
  const screens = [{ availLeft: 0, availTop: 0, availWidth: 1920, availHeight: 1040, isPrimary: true },
                   { availLeft: 1920, availTop: 0, availWidth: 1920, availHeight: 1040, isPrimary: false }];
  window.getScreenDetails = async () => ({ screens });
  const made = __makePopup();
  Object.assign(made.popup, { screenX: 100, screenY: 50, outerWidth: 1600, outerHeight: 900, moveTo() {}, resizeTo() {} });
  return made.index;
}"""


class SpanDisplaysDOMTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.pw = sync_playwright().start(); cls.browser = cls.pw.chromium.launch()
        main = read_page_bytes(MAIN).decode("utf-8-sig")
        windows = WINDOWS.read_text(encoding="utf-8")
        # The harness's record of saved places reads the window through the page's own popupRect.
        cls.source = "\n".join(extract_function(main, name) for name in page_functions_called_by(
            main, "openOhifWindow", SPAN_HARNESS + windows)) + "\n" + extract_function(main, "popupRect") + "\n" + \
            extract_function(main, "mountViewerWindows") + "\nmountViewerWindows();"
        cls.windows = windows

    @classmethod
    def tearDownClass(cls):
        cls.browser.close(); cls.pw.stop()

    def setUp(self):
        self.page = self.browser.new_page(); self.errors = []
        self.page.on("pageerror", lambda error: self.errors.append(str(error)))
        self.page.route("**/*", lambda route: route.fulfill(status=200, content_type="text/html", body=SPAN_HARNESS)
                        if route.request.url == "https://example.test/harness" else route.abort())
        self.page.goto("https://example.test/harness")
        self.page.add_script_tag(path=str(WINDOWS.with_name('exam-scope.js')))
        self.page.add_script_tag(content=self.windows)
        self.page.add_script_tag(content=self.source)
        self.addCleanup(self.page.close)
        self.addCleanup(lambda: self.assertEqual([], self.errors))

    def span_refused(self):
        index = self.page.evaluate(TWO)
        self.page.locator('#viewer-windows-open').click()
        self.page.locator('#viewer-windows-displays').click()
        self.page.wait_for_function("document.querySelector('[data-window-action=\"span\"]') !== null")
        self.page.get_by_label('Viewer Display 1').select_option(index=1)
        self.page.get_by_label('Viewer Display 2').select_option(index=2)
        self.page.locator(f'[data-window-index="{index}"][data-window-action="span"]').click()
        status = self.page.locator('#viewer-windows-status')
        # Not a failure: the reader is told how to put the window there.
        expect(status).to_have_text('브라우저가 영상 창을 두 화면에 걸쳐 옮기지 않았습니다. 영상 창의 가장자리를 끌어 Display 1과 Display 2에 '
                                    '걸쳐 놓으세요. 걸쳐 놓으면 그 자리를 저장합니다.', timeout=8000)
        return status

    def test_01_refused_span_asks_for_a_drag_and_takes_the_window_once_it_is_over_both(self):
        status = self.span_refused()
        self.assertEqual([], self.page.evaluate('__remembered'))
        self.assertIsNone(self.page.evaluate("localStorage.getItem('kin.ohif.span.screens')"))
        # Dragged to the second display only: not yet.
        self.page.evaluate("Object.assign(__popups[0], { screenX: 2000, outerWidth: 1600 })")
        self.page.wait_for_timeout(1200)
        self.assertEqual([], self.page.evaluate('__remembered'))
        # Stretched over both: taken as placed.
        self.page.evaluate("Object.assign(__popups[0], { screenX: 0, screenY: 0, outerWidth: 3840, outerHeight: 1040 })")
        expect(status).to_have_text('영상 창이 Display 1·2에 걸쳐 있습니다. 창 위치를 저장했습니다.', timeout=4000)
        self.assertEqual([dict(left=0, top=0, width=3840, height=1040)], self.page.evaluate('__remembered'))
        self.assertEqual([[0, 0, 1920, 1040], [1920, 0, 1920, 1040]],
                         self.page.evaluate("JSON.parse(localStorage.getItem('kin.ohif.span.screens')).map(s => [s.left, s.top, s.width, s.height])"))

    def test_02_the_wait_ends_with_the_window_or_a_newer_request(self):
        self.span_refused()
        # The window closes: nothing more is said or saved, even when its last place was over both.
        self.page.evaluate("Object.assign(__popups[0], { closed: true, screenX: 0, outerWidth: 3840 })")
        self.page.wait_for_timeout(1200)
        self.assertEqual([], self.page.evaluate('__remembered'))
        self.assertNotIn('걸쳐 있습니다', self.page.locator('#viewer-windows-status').inner_text())

    def test_03_one_display_above_the_other_is_not_both_by_width_alone(self):
        self.assertEqual([False, True, False], self.page.evaluate("""() => {
          const top = { left: 0, top: 0, width: 1920, height: 1040 }, bottom = { left: 0, top: 1040, width: 1920, height: 1040 };
          return [KinViewerDisplayLayout.covers({ left: 0, top: 0, width: 1920, height: 1040 }, [top, bottom]),
                  KinViewerDisplayLayout.covers({ left: 0, top: 500, width: 1920, height: 1200 }, [top, bottom]),
                  KinViewerDisplayLayout.covers({ left: 1800, top: 0, width: 1920, height: 1040 }, [top, { left: 1920, top: 0, width: 1920, height: 1040 }])];
        }"""))


if __name__ == "__main__":
    unittest.main()
