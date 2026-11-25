# coding: utf-8
"""A viewer window that is to stand over two displays when the browser will not put it there (a browser keeps a popup on
one display): Viewer Windows > Span Displays, and the placement of a window as it opens. The reader is told to drag the
window over the two displays, and once it stands there its place and the two displays are saved - the same saving
whichever way the window got there. Runs the page's own mountViewerWindows / openOhifWindow code and the placement
functions they call (sliced from main.html as tests/viewer_window_manager_dom_test.py does: the window rectangle, the
stored place and display choice, the wait and the saving are the page's own) with the shipped viewer-display-layout.js,
over synthetic displays. Real monitors are not emulated: the same drag on a real two-monitor desktop is checked there."""
import unittest

from playwright.sync_api import expect, sync_playwright

from page_source import read_page_bytes
from viewer_window_manager_dom_test import HARNESS, MAIN, WINDOWS, extract_function, page_functions_called_by

LAYOUT = (MAIN.parent / "viewer-display-layout.js").read_text(encoding="utf-8")
LEFT, RIGHT, THIRD = (dict(left=0, top=0, width=1920, height=1040), dict(left=1920, top=0, width=1920, height=1040),
                      dict(left=3840, top=0, width=1920, height=1040))
RECT_KEY, PAIR_KEY = 'kin.ohif.current.rect', 'kin.ohif.span.screens'
# The manager's harness with the shipped display geometry and the page's own placement functions instead of its stand-ins
# (the stand-ins' names are taken out, so the page's functions are sliced in), displays side by side known to the page,
# and a display access a case can take back.
SPAN_HARNESS = (HARNESS
                .replace("const KinViewerDisplayLayout = {span:()=>null,screens:details=>details.screens||[],identity:screen=>screen.id,\n"
                         "  fit:()=>({left:10,top:10,width:800,height:600})};\n", "")
                .replace(", popupRect=()=>null;", ";")
                .replace("const readOhifSpanScreens=()=>null;", "const OHIF_RECT_KEY='kin.ohif.current.rect';let ohifPopupHandle=null;")
                .replace("const monitorPermissionGranted = ()=>true, rememberOhifRect=()=>true,", "const monitorPermissionGranted = ()=>window.__granted!==false,")
                .replace("const screensCache=[display];",
                         "const screensCache=[{left:0,top:0,width:1920,height:1040},{left:1920,top:0,width:1920,height:1040}];")
                .replace("const readStoredOhifRect=()=>null,ohifPlacement=()=>({left:10,top:10,width:800,height:600});", "")
                # The page's own writer without a screen language (main.html kinWrite, as page-core.js has it).
                .replace("<script>\n", "<script>\n" + LAYOUT + "\nlet multiStudyView=null;\n"
                         "function kinWrite(el, value, name) { if (name) el.setAttribute(name, value); else el.textContent = value; return el; }\n", 1))
for gone in ("KinViewerDisplayLayout = {span", "popupRect=()=>null", "rememberOhifRect=()=>true", "readOhifSpanScreens=()=>null", "ohifPlacement=()=>"):
    assert gone not in SPAN_HARNESS, gone
# What a case sets up after the page's code is in: the displays the browser reports, every text the manager's status line
# showed, and a window as the browser hands it to an opening (blank; its document is another once it is sent to the
# viewer). refuses: its moveTo fails, as for a placement the browser will not make; else the browser puts it where asked.
SETUP = """displays => {
  screensCache.length = 0; screensCache.push(...displays);
  const screens = displays.map((s, i) => ({ availLeft: s.left, availTop: s.top, availWidth: s.width, availHeight: s.height, isPrimary: i === 0 }));
  window.getScreenDetails = async () => ({ screens });
  window.__said = [];
  new MutationObserver(() => __said.push(document.querySelector('#viewer-windows-status').textContent))
    .observe(document.querySelector('#viewer-windows-status'), { childList: true, characterData: true, subtree: true });
  window.__opening = (rect, refuses) => {
    const popup = __blankPopup(); let href = 'about:blank';
    Object.assign(popup, { screenX: rect.left, screenY: rect.top, outerWidth: rect.width, outerHeight: rect.height, kind: 'blank', ready: true, busy: false, dirty: false });
    popup.location = { get href() { return href; }, set href(value) { href = value; popup.kind = 'viewer'; popup.owner = sessionOwner;
      popup.document = { querySelector: () => null, visibilityState: 'visible', readyState: 'complete' }; }, reload() {} };
    popup.history = { state: null, replaceState() {} };
    popup.moveTo = (x, y) => { if (refuses) throw new Error('refused'); popup.screenX = x; popup.screenY = y; };
    popup.resizeTo = (w, h) => { if (!refuses) { popup.outerWidth = w; popup.outerHeight = h; } };
    window.__nextOpenPopup = popup; window.__opener = popup;
    return popup;
  };
  window.__stored = () => ({ rect: JSON.parse(localStorage.getItem('kin.ohif.current.rect') || 'null'),
    pair: JSON.parse(localStorage.getItem('kin.ohif.span.screens') || 'null')?.map(s => [s.left, s.top, s.width, s.height]) ?? null });
  window.__at = rect => Object.assign(__opener, { screenX: rect.left, screenY: rect.top, outerWidth: rect.width, outerHeight: rect.height });
}"""
SPAN = dict(left=0, top=0, width=3840, height=1040)
REFUSED = ('브라우저가 영상 창을 두 화면에 걸쳐 열지 않았습니다. 영상 창의 가장자리를 끌어 두 화면에 걸쳐 놓으세요. 걸쳐 놓으면 그 자리를 저장합니다.')
REACHED = '영상 창이 두 화면에 걸쳐 있습니다. 창 위치를 저장했습니다.'


def box(screen):
    return [screen['left'], screen['top'], screen['width'], screen['height']]


class SpanDisplaysDOMTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.pw = sync_playwright().start(); cls.browser = cls.pw.chromium.launch()
        main = read_page_bytes(MAIN).decode("utf-8-sig")
        windows = WINDOWS.read_text(encoding="utf-8")
        names = page_functions_called_by(main, "openOhifWindow", SPAN_HARNESS + windows)
        for needed in ("awaitSpan", "rememberSpan", "rememberOhifRect", "popupRect", "ohifPlacement", "readOhifSpanScreens", "readStoredOhifRect"):
            assert needed in names, needed
        cls.source = "\n".join(extract_function(main, name) for name in names) + "\n" + extract_function(main, "mountViewerWindows") + "\nmountViewerWindows();"
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
        self.displays([LEFT, RIGHT])
        self.addCleanup(self.page.close)
        self.addCleanup(lambda: self.assertEqual([], self.errors))

    def displays(self, screens):
        self.page.evaluate(SETUP, screens)

    def stored(self):
        return self.page.evaluate('__stored()')

    def toasts(self):
        return self.page.evaluate('__toasts.map(t => String(t.message))')

    # ── Viewer Windows > Span Displays ──
    def span_refused(self, at=None, first=1, second=2, moves="{ moveTo() {}, resizeTo() {} }"):
        """A viewer window on one display, the two displays chosen, Span Displays pressed; the browser moves nothing
        (moves: what the window does when it is asked to move instead)."""
        index = self.page.evaluate("""at => { const made = __makePopup();
          Object.assign(made.popup, { screenX: at.left, screenY: at.top, outerWidth: at.width, outerHeight: at.height }, (""" + moves + """));
          return made.index; }""", at or dict(left=100, top=50, width=1600, height=900))
        self.page.locator('#viewer-windows-open').click()
        self.page.locator('#viewer-windows-displays').click()
        self.page.wait_for_function("document.querySelector('[data-window-action=\"span\"]') !== null")
        self.page.get_by_label('Viewer Display 1').select_option(index=first)
        self.page.get_by_label('Viewer Display 2').select_option(index=second)
        self.page.locator(f'[data-window-index="{index}"][data-window-action="span"]').click()
        return self.page.locator('#viewer-windows-status')

    def asked_to_drag(self, status):
        # Not a failure: the reader is told how to put the window there.
        expect(status).to_have_text('브라우저가 영상 창을 두 화면에 걸쳐 옮기지 않았습니다. 영상 창의 가장자리를 끌어 Display 1과 Display 2에 '
                                    '걸쳐 놓으세요. 걸쳐 놓으면 그 자리를 저장합니다.', timeout=8000)

    def test_01_refused_span_asks_for_a_drag_and_takes_the_window_once_it_is_over_both(self):
        status = self.span_refused()
        self.asked_to_drag(status)
        self.assertEqual(dict(rect=None, pair=None), self.stored())
        # Dragged to the second display only: not yet.
        self.page.evaluate("Object.assign(__popups[0], { screenX: 2000, outerWidth: 1600 })")
        self.page.wait_for_timeout(1200)
        self.assertEqual(dict(rect=None, pair=None), self.stored())
        # Stretched over both: taken as placed - the window as it stands, and the two displays.
        self.page.evaluate("Object.assign(__popups[0], { screenX: 0, screenY: 0, outerWidth: 3840, outerHeight: 1040 })")
        expect(status).to_have_text('영상 창이 Display 1·2에 걸쳐 있습니다. 창 위치를 저장했습니다.', timeout=4000)
        self.assertEqual(dict(rect=SPAN, pair=[box(LEFT), box(RIGHT)]), self.stored())

    def test_02_the_wait_ends_without_a_word(self):
        # The window closes, or is minimized, or the display access is taken back: nothing more is said or saved, even
        # when the window's last place was over both.
        for ending in ("__popups[0].closed = true", "__popups[0].document.visibilityState = 'hidden'", "window.__granted = false"):
            self.page.close(); self.setUp()
            status = self.span_refused()
            self.asked_to_drag(status)
            self.page.evaluate(ending)
            self.page.evaluate("Object.assign(__popups[0], { screenX: 0, screenY: 0, outerWidth: 3840, outerHeight: 1040 })")
            self.page.wait_for_timeout(1300)
            self.assertEqual(dict(rect=None, pair=None), self.stored(), ending)
            self.assertNotIn('걸쳐 있습니다', status.inner_text(), ending)

    def test_03_one_display_above_the_other_is_not_both_by_width_alone(self):
        self.assertEqual([False, True, False], self.page.evaluate("""() => {
          const top = { left: 0, top: 0, width: 1920, height: 1040 }, bottom = { left: 0, top: 1040, width: 1920, height: 1040 };
          return [KinViewerDisplayLayout.covers({ left: 0, top: 0, width: 1920, height: 1040 }, [top, bottom]),
                  KinViewerDisplayLayout.covers({ left: 0, top: 500, width: 1920, height: 1200 }, [top, bottom]),
                  KinViewerDisplayLayout.covers({ left: 1800, top: 0, width: 1920, height: 1040 }, [top, { left: 1920, top: 0, width: 1920, height: 1040 }])];
        }"""))

    def test_04_a_window_already_over_both_is_taken_at_once_not_asked_to_be_dragged(self):
        # It stands over both displays, only not at the exact rectangle Span Displays asks for (more than 16 px off).
        at = dict(left=60, top=30, width=3700, height=980)
        status = self.span_refused(at=at)
        expect(status).to_have_text('영상 창이 Display 1·2에 걸쳐 있습니다. 창 위치를 저장했습니다.', timeout=8000)
        self.assertEqual(dict(rect=at, pair=[box(LEFT), box(RIGHT)]), self.stored())
        self.assertFalse([text for text in self.page.evaluate('__said') if '끌어' in text])

    def test_05_a_minimized_window_is_taken_when_it_is_shown_again_over_both(self):
        status = self.span_refused()
        self.asked_to_drag(status)
        self.page.evaluate("""() => { __popups[0].document.visibilityState = 'hidden';
          Object.assign(__popups[0], { screenX: 0, screenY: 0, outerWidth: 3840, outerHeight: 1040 }); }""")
        self.page.wait_for_timeout(1300)
        self.assertEqual(dict(rect=None, pair=None), self.stored())
        self.page.evaluate("__popups[0].document.visibilityState = 'visible'")
        expect(status).to_have_text('영상 창이 Display 1·2에 걸쳐 있습니다. 창 위치를 저장했습니다.', timeout=4000)

    def test_06_a_place_or_a_display_choice_that_cannot_be_written_is_said_as_part_saved(self):
        # The display choice cannot be written (the place can): not reported as saved.
        status = self.span_refused()
        self.asked_to_drag(status)
        self.page.evaluate("""() => { const set = Storage.prototype.setItem;
          Storage.prototype.setItem = function (key, value) { if (key === 'kin.ohif.span.screens') throw new Error('quota'); return set.call(this, key, value); };
          Object.assign(__popups[0], { screenX: 0, screenY: 0, outerWidth: 3840, outerHeight: 1040 }); }""")
        expect(status).to_have_text('영상 창이 Display 1·2에 걸쳐 있습니다. 창 위치와 화면 선택 가운데 일부만 저장했습니다. 브라우저 저장소를 확인하세요.', timeout=4000)
        self.assertEqual(dict(rect=SPAN, pair=None), self.stored())
        # Neither can be written.
        self.page.close(); self.setUp()
        status = self.span_refused()
        self.asked_to_drag(status)
        self.page.evaluate("""() => { Storage.prototype.setItem = function () { throw new Error('quota'); };
          Object.assign(__popups[0], { screenX: 0, screenY: 0, outerWidth: 3840, outerHeight: 1040 }); }""")
        expect(status).to_have_text('영상 창이 Display 1·2에 걸쳐 있지만 창 위치를 저장하지 못했습니다. 브라우저 저장소를 확인하세요.', timeout=4000)

    def test_07_displays_1_and_3_chosen_with_display_2_between_them_are_the_pair_that_is_saved(self):
        self.displays([LEFT, RIGHT, THIRD])
        status = self.span_refused(first=1, second=3)
        expect(status).to_contain_text('Display 1과 Display 3에 걸쳐 놓으세요', timeout=8000)
        # Over displays 1 and 2 only: display 3 is not under it yet.
        self.page.evaluate("Object.assign(__popups[0], { screenX: 0, screenY: 0, outerWidth: 3840, outerHeight: 1040 })")
        self.page.wait_for_timeout(1200)
        self.assertEqual(dict(rect=None, pair=None), self.stored())
        self.page.evaluate("Object.assign(__popups[0], { screenX: 0, screenY: 0, outerWidth: 5760, outerHeight: 1040 })")
        expect(status).to_have_text('영상 창이 Display 1·3에 걸쳐 있습니다. 창 위치를 저장했습니다.', timeout=4000)
        self.assertEqual([box(LEFT), box(THIRD)], self.stored()['pair'])

    def test_08_the_next_patient_opened_in_the_same_window_does_not_end_the_wait(self):
        status = self.span_refused()
        self.asked_to_drag(status)
        # The list opens another study in that window - a patient tab in the same document, a new opening of the window.
        before = self.page.evaluate("ohifPopupSequences.get(__popups[0])")
        self.page.evaluate("""async () => { openingPreference = { maxWindows: 1, reuseClean: true }; ohifOpenSeq = 10;
          __popups[0].kinViewerOpenPatient = async () => true; window.__next = await openOhifWindow('1.2.2'); }""")
        self.assertEqual('accepted', self.page.evaluate('__next.status'))
        self.assertNotEqual(before, self.page.evaluate("ohifPopupSequences.get(__popups[0])"))
        self.assertEqual(dict(rect=None, pair=None), self.stored())
        # The reader lays that same window over both displays: taken as placed.
        self.page.evaluate("Object.assign(__popups[0], { screenX: 0, screenY: 0, outerWidth: 3840, outerHeight: 1040 })")
        expect(status).to_have_text('영상 창이 Display 1·2에 걸쳐 있습니다. 창 위치를 저장했습니다.', timeout=4000)
        self.assertEqual(dict(rect=SPAN, pair=[box(LEFT), box(RIGHT)]), self.stored())

    def test_09_another_window_in_the_slot_ends_the_wait_of_the_window_it_replaced(self):
        status = self.span_refused()
        self.asked_to_drag(status)
        # Another window is linked to that slot: the first is no longer the window this list holds there.
        self.page.evaluate("__makePopup()")
        self.assertTrue(self.page.evaluate("viewerWindows.rows().length === 1 && viewerWindows.rows()[0].popup === __popups[1]"))
        self.page.evaluate("Object.assign(__popups[0], { screenX: 0, screenY: 0, outerWidth: 3840, outerHeight: 1040 })")
        self.page.wait_for_timeout(1300)
        self.assertEqual(dict(rect=None, pair=None), self.stored())
        self.assertNotIn('걸쳐 있습니다', status.inner_text())

    def test_16_a_window_minimized_as_the_browser_moves_it_is_taken_only_once_it_is_shown(self):
        # The browser does put the window over both displays; the window is minimized before that is confirmed.
        status = self.span_refused(moves="""{ moveTo(x, y) { this.screenX = x; this.screenY = y; this.document.visibilityState = 'hidden'; },
          resizeTo(w, h) { this.outerWidth = w; this.outerHeight = h; } }""")
        self.page.wait_for_timeout(3300)
        self.assertEqual([SPAN['left'], SPAN['width']], self.page.evaluate("[__popups[0].screenX, __popups[0].outerWidth]"))
        self.assertEqual(dict(rect=None, pair=None), self.stored())
        self.assertFalse([text for text in self.page.evaluate('__said') if '저장했습니다' in text])
        # Shown again, still over both: taken as placed.
        self.page.evaluate("__popups[0].document.visibilityState = 'visible'")
        expect(status).to_have_text('영상 창이 Display 1·2에 걸쳐 있습니다. 창 위치를 저장했습니다.', timeout=4000)
        self.assertEqual(dict(rect=SPAN, pair=[box(LEFT), box(RIGHT)]), self.stored())

    # ── A window placed as it opens ──
    def open_window(self, at, stored=None, pair=None, refuses=True):
        """A study opened into a new viewer window that the browser first shows at `at`. stored: the place saved for that
        window; pair: the two displays chosen in Viewer Displays."""
        self.page.evaluate("""([at, stored, pair, refuses]) => {
          if (stored) localStorage.setItem('kin.ohif.current.rect', JSON.stringify(stored));
          if (pair) localStorage.setItem('kin.ohif.span.screens', JSON.stringify(pair));
          __opening(at, refuses);
          const b = document.createElement('button'); b.id = 'syn-open'; b.textContent = 'Open';
          b.onclick = () => { window.__result = openOhifWindow('1.2.1'); }; document.body.append(b);
        }""", [at, stored, pair, refuses])
        self.page.locator('#syn-open').click()
        self.assertEqual('accepted', self.page.evaluate('__result.status'))

    def said(self, text):
        self.page.wait_for_function("text => __toasts.some(t => String(t.message) === text)", arg=text, timeout=6000)

    def test_10_a_refused_opening_over_the_chosen_displays_gets_its_place_and_its_displays_back_once_dragged_there(self):
        one = dict(left=100, top=50, width=1600, height=900)
        self.open_window(one, stored=SPAN, pair=[LEFT, RIGHT])
        self.said(REFUSED)
        # The reader starts to drag and stops inside one display: as for any window moved after a refused placement, that
        # place is saved and the display choice is dropped (the page's 2 s position watch, called here as it calls it).
        moved = dict(left=300, top=50, width=1500, height=900)
        self.page.evaluate("rect => { __at(rect); rememberOhifRect(__opener); }", moved)
        self.assertEqual(dict(rect=moved, pair=None), self.stored())
        # Laid over both displays: its place there and the two displays are saved again.
        self.page.evaluate("rect => __at(rect)", SPAN)
        self.said(REACHED)
        self.assertEqual(dict(rect=SPAN, pair=[box(LEFT), box(RIGHT)]), self.stored())
        # The list opened anew: the two displays are chosen again, and the window opens at that place.
        self.assertEqual([[box(LEFT), box(RIGHT)], SPAN], self.page.evaluate(
            "() => [readOhifSpanScreens().map(s => [s.left, s.top, s.width, s.height]), ohifPlacement(readStoredOhifRect(0))]"))
        # Its later moves are saved as any window's.
        later = dict(left=10, top=10, width=3800, height=1000)
        self.page.evaluate("rect => { __at(rect); rememberOhifRect(__opener); }", later)
        self.assertEqual(dict(rect=later, pair=[box(LEFT), box(RIGHT)]), self.stored())

    def test_11_a_place_alone_over_two_displays_names_them_and_over_three_guesses_no_pair(self):
        # No displays were ever chosen; the place saved for the window lies over two displays.
        wide = dict(left=200, top=0, width=3000, height=1000)
        self.open_window(dict(left=100, top=50, width=1600, height=900), stored=wide)
        self.said(REFUSED)
        self.page.evaluate("rect => __at(rect)", wide)
        self.said(REACHED)
        self.assertEqual(dict(rect=wide, pair=[box(LEFT), box(RIGHT)]), self.stored())
        # Three displays under the place and under the window: the place is saved, no two of them are picked.
        self.page.close(); self.setUp(); self.displays([LEFT, RIGHT, THIRD])
        three = dict(left=200, top=0, width=5000, height=1000)
        self.open_window(dict(left=100, top=50, width=1600, height=900), stored=three)
        self.said(REFUSED)
        self.page.evaluate("rect => __at(rect)", dict(left=100, top=0, width=5200, height=1000))
        self.said(REACHED)
        self.assertEqual(dict(rect=dict(left=100, top=0, width=5200, height=1000), pair=None), self.stored())

    def test_12_displays_chosen_meanwhile_for_another_window_are_kept(self):
        self.displays([LEFT, RIGHT, THIRD])
        self.open_window(dict(left=100, top=50, width=1600, height=900), stored=SPAN, pair=[LEFT, RIGHT])
        self.said(REFUSED)
        # While this window waits, the reader chooses displays 2 and 3 for another window.
        self.page.evaluate("pair => localStorage.setItem('kin.ohif.span.screens', JSON.stringify(pair))", [RIGHT, THIRD])
        self.page.evaluate("rect => __at(rect)", SPAN)
        self.said(REACHED)
        self.assertEqual(dict(rect=SPAN, pair=[box(RIGHT), box(THIRD)]), self.stored())

    def test_13_the_display_access_taken_back_or_a_closed_window_ends_the_wait_of_an_opening(self):
        for ending in ("window.__granted = false", "__opener.closed = true", "sessionOwner = '[\"institution\",\"other\"]'"):
            self.page.close(); self.setUp()
            self.open_window(dict(left=100, top=50, width=1600, height=900), stored=SPAN, pair=[LEFT, RIGHT])
            self.said(REFUSED)
            self.page.evaluate(ending)
            self.page.evaluate("rect => __at(rect)", dict(left=20, top=0, width=3800, height=1040))
            self.page.wait_for_timeout(1300)
            self.assertNotIn(REACHED, self.toasts(), ending)
            self.assertEqual(SPAN, self.stored()['rect'], ending)

    def test_14_a_placement_the_browser_makes_at_once_is_remembered_the_same_way(self):
        # The place alone says two displays; the browser puts the window there at once: nothing is said, and the same two
        # things are saved as for a window dragged there.
        wide = dict(left=200, top=0, width=3000, height=1000)
        self.open_window(dict(left=100, top=50, width=1600, height=900), stored=wide, refuses=False)
        self.page.wait_for_function("() => __stored().pair !== null", timeout=6000)
        self.assertEqual(dict(rect=wide, pair=[box(LEFT), box(RIGHT)]), self.stored())
        self.assertEqual([], [text for text in self.toasts() if '걸쳐' in text])
        # A window placed at once on one display is remembered as before: its place, and no displays.
        self.page.close(); self.setUp()
        single = dict(left=100, top=50, width=1600, height=900)
        self.open_window(dict(left=0, top=0, width=800, height=600), stored=single, refuses=False)
        self.page.wait_for_function("rect => JSON.stringify(__stored().rect) === JSON.stringify(rect)", arg=single, timeout=6000)
        self.assertIsNone(self.stored()['pair'])

    def test_17_displays_chosen_meanwhile_for_another_window_survive_this_windows_own_drag(self):
        self.displays([LEFT, RIGHT, THIRD])
        self.open_window(dict(left=100, top=50, width=1600, height=900), stored=SPAN, pair=[LEFT, RIGHT])
        self.said(REFUSED)
        # While this window waits, the reader chooses displays 2 and 3 for another window.
        self.page.evaluate("pair => localStorage.setItem('kin.ohif.span.screens', JSON.stringify(pair))", [RIGHT, THIRD])
        # This window is dragged a little and left inside one display (the page's 2 s position watch, called here as it
        # calls it): its place is saved; the displays chosen since for the other window are not this window's to drop.
        moved = dict(left=300, top=50, width=1500, height=900)
        self.page.evaluate("rect => { __at(rect); rememberOhifRect(__opener); }", moved)
        self.assertEqual(dict(rect=moved, pair=[box(RIGHT), box(THIRD)]), self.stored())
        # Laid over displays 1 and 2 at last: its place is saved, and the more recent choice stays.
        self.page.evaluate("rect => __at(rect)", SPAN)
        self.said(REACHED)
        self.assertEqual(dict(rect=SPAN, pair=[box(RIGHT), box(THIRD)]), self.stored())

    def test_18_an_opening_minimized_as_the_browser_places_it_is_remembered_once_it_is_shown(self):
        # The place alone says two displays and the browser puts the window there; it is minimized before that is confirmed.
        wide = dict(left=200, top=0, width=3000, height=1000)
        self.page.evaluate("""() => { window.__hideOnMove = popup => { const move = popup.moveTo;
          popup.moveTo = (x, y) => { move(x, y); popup.document.visibilityState = 'hidden'; }; }; }""")
        self.page.evaluate("""([at, stored]) => { localStorage.setItem('kin.ohif.current.rect', JSON.stringify(stored)); __hideOnMove(__opening(at, false));
          const b = document.createElement('button'); b.id = 'syn-open'; b.textContent = 'Open';
          b.onclick = () => { window.__result = openOhifWindow('1.2.1'); }; document.body.append(b); }""", [dict(left=100, top=50, width=1600, height=900), wide])
        self.page.locator('#syn-open').click()
        self.page.wait_for_function("rect => __opener.screenX === rect.left && __opener.outerWidth === rect.width && __opener.document.visibilityState === 'hidden'", arg=wide, timeout=6000)
        self.page.wait_for_timeout(1500)
        self.assertIsNone(self.stored()['pair'])
        # Shown again: judged then, and remembered as a placement that worked - nothing is said.
        self.page.evaluate("__opener.document.visibilityState = 'visible'")
        self.page.wait_for_function("() => __stored().pair !== null", timeout=6000)
        self.assertEqual(dict(rect=wide, pair=[box(LEFT), box(RIGHT)]), self.stored())
        self.assertEqual([], [text for text in self.toasts() if '걸쳐' in text])

    def test_19_a_placement_made_at_once_says_so_when_only_part_of_it_could_be_saved(self):
        # The browser puts the window over two displays at once; the display choice cannot be written (the place can).
        wide = dict(left=200, top=0, width=3000, height=1000)
        self.page.evaluate("""() => { const set = Storage.prototype.setItem;
          Storage.prototype.setItem = function (key, value) { if (key === 'kin.ohif.span.screens') throw new Error('quota'); return set.call(this, key, value); }; }""")
        self.open_window(dict(left=100, top=50, width=1600, height=900), stored=wide, refuses=False)
        self.said('영상 창이 두 화면에 걸쳐 있습니다. 창 위치와 화면 선택 가운데 일부만 저장했습니다. 브라우저 저장소를 확인하세요.')
        self.assertEqual(dict(rect=wide, pair=None), self.stored())
        self.assertNotIn(REACHED, self.toasts())

    def test_15_an_opening_that_stands_over_the_chosen_displays_already_is_not_asked_to_be_dragged(self):
        # The window comes up over both displays, 40 px off the place asked for, and the browser moves it no further.
        there = dict(left=40, top=0, width=3760, height=1040)
        self.open_window(there, stored=SPAN, pair=[LEFT, RIGHT])
        self.said(REACHED)
        self.assertNotIn(REFUSED, self.toasts())
        self.assertEqual(dict(rect=there, pair=[box(LEFT), box(RIGHT)]), self.stored())

    # ── A saved place barely over the next display's edge (a window's resize border) ──
    def keep_on_one_display(self):
        """The window the next opening gets behaves as a browser does: it moves and resizes a window, but a window that
        would cross a display edge is put on one display - the one its top-left corner is on."""
        self.page.evaluate("""() => { const popup = __opener, move = popup.moveTo, size = popup.resizeTo;
          const keep = () => { const r = { left: popup.screenX, top: popup.screenY, width: popup.outerWidth, height: popup.outerHeight };
            const on = screensCache.find(s => r.left >= s.left && r.left < s.left + s.width && r.top >= s.top && r.top < s.top + s.height) || screensCache[0];
            if (r.left >= on.left && r.top >= on.top && r.left + r.width <= on.left + on.width && r.top + r.height <= on.top + on.height) return;
            Object.assign(popup, { screenX: on.left, screenY: on.top, outerWidth: Math.min(r.width, on.width), outerHeight: Math.min(r.height, on.height) }); };
          popup.moveTo = (x, y) => { move(x, y); keep(); }; popup.resizeTo = (w, h) => { size(w, h); keep(); }; }""")

    def open_kept_on_one_display(self, stored):
        self.page.evaluate("""stored => { localStorage.setItem('kin.ohif.current.rect', JSON.stringify(stored));
          const b = document.createElement('button'); b.id = 'syn-open'; b.textContent = 'Open';
          b.onclick = () => { window.__result = openOhifWindow('1.2.1'); }; document.body.append(b); }""", stored)
        self.page.evaluate("at => __opening(at, false)", dict(left=100, top=50, width=1600, height=900))
        self.keep_on_one_display()
        self.page.locator('#syn-open').click()
        self.assertEqual('accepted', self.page.evaluate('__result.status'))

    def test_20_a_window_that_filled_one_monitor_by_its_edges_opens_on_that_monitor_without_the_span_notice(self):
        # The reader dragged the window's edges to fill the right monitor (not maximized): the outer rectangle the browser
        # reports includes the invisible resize border, 2 px over the left monitor and 7 px past the right edge.
        border = dict(left=RIGHT['left'] - 2, top=0, width=1929, height=1047)
        self.assertEqual([box(RIGHT), []], self.page.evaluate(
            "rect => { const p = ohifPlacement(rect); return [[p.left, p.top, p.width, p.height], spanTargets(rect)]; }", border))
        self.open_kept_on_one_display(border)
        self.page.wait_for_function("rect => JSON.stringify(__stored().rect) === JSON.stringify(rect)", arg=RIGHT, timeout=6000)
        self.assertEqual([RIGHT['left'], RIGHT['top'], RIGHT['width'], RIGHT['height']],
                         self.page.evaluate("[__opener.screenX, __opener.screenY, __opener.outerWidth, __opener.outerHeight]"))
        self.page.wait_for_timeout(500)
        self.assertEqual(dict(rect=RIGHT, pair=None), self.stored())
        self.assertEqual([], [text for text in self.toasts() if '걸쳐' in text or '자동 창 배치' in text])

    def test_21_a_window_the_reader_laid_over_both_monitors_still_comes_back_over_both(self):
        # Laid over both monitors by hand (1920 px on each, its border just past the outer edges).
        spanned = dict(left=-2, top=0, width=3844, height=1042)
        self.assertEqual([spanned, [box(LEFT), box(RIGHT)]], self.page.evaluate(
            "rect => [ohifPlacement(rect), spanTargets(rect).map(s => [s.left, s.top, s.width, s.height])]", spanned))
        # The browser keeps the reopened window on one monitor: the reader is asked to drag it, and once it is over both
        # its place and the two monitors are saved (the page gives the browser its 15 s placement deadline first).
        self.open_kept_on_one_display(spanned)
        self.page.wait_for_function("text => __toasts.some(t => String(t.message) === text)", arg=REFUSED, timeout=20000)
        self.page.evaluate("rect => __at(rect)", spanned)
        self.said(REACHED)
        self.assertEqual(dict(rect=spanned, pair=[box(LEFT), box(RIGHT)]), self.stored())


if __name__ == "__main__":
    unittest.main()
