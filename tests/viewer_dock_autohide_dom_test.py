# coding: utf-8
"""Viewer tool dock Auto-hide after the pointer goes back to the images.

With Auto-hide Panels on, an open dock panel folds once work moves to the images. A tab pressed with the mouse keeps
keyboard focus, and the image viewport keeps it there (it cancels the default of a press so that a drag does not select
text), so focus alone must not hold the panel open after the mouse goes back to the images. Keyboard work in the dock
(Tab into it, Enter on a tab, typing in a panel field) keeps it open.

Real: the dock (viewer-workspace-dock.js) and the document gate (work-context.js), in Chromium with native pointer,
wheel and keyboard input. Stand-ins, named: the viewer page (a #root column with an image area), the image viewport
(a canvas that cancels the default of mousedown and pointerdown, as the stock viewer's tools do), a drawing tool that
consumes presses on the window's capture phase (as Curved MPR and 3D Path do while adding points), the two dock panels
(a text field and a saved-job row in Comparison stand in for its job controls) and the account owner. Layout and the stock viewer's hotkeys
are the hosted e2e's job.
"""
import json
import unittest
from pathlib import Path

from playwright.sync_api import expect, sync_playwright

ROOT = Path(__file__).resolve().parents[1]
FILES = ROOT / "worklist-v0" / "hpacs-lite"
ORIGIN = "https://kin-dock-autohide.test"
OWNER = '["SYN-INST","SYN-READER"]'
KEY = "kin-viewer-dock:v1:" + OWNER

PAGE = """<!doctype html><html><head><title>SYN viewer</title>
<style>*,::before,::after{box-sizing:border-box}html,body{margin:0}#root{height:100vh}.flex{background:#000}
#syn-image{display:block;width:100%;height:100%}</style></head>
<body><div id="root"><div><div class="bar" style="height:30px"><button type="button" id="syn-toolbar">Zoom</button></div>
<div class="flex" id="syn-images" style="height:100%"><canvas id="syn-image"></canvas></div></div></div></body></html>"""

SETUP = """args => {
  KinWorkContext.follow({ onLifecycle(listener) { listener({ state: 'active', session: 'S' }); } });
  // The viewport cancels the default of a press (no text selection while dragging), so a press does not move focus.
  const image = document.getElementById('syn-image');
  window.__presses = 0;
  for (const type of ['pointerdown', 'mousedown']) image.addEventListener(type, e => { if (type === 'pointerdown') window.__presses++; e.preventDefault(); });
  for (const id of ['kin-viewer-history', 'kin-viewer-layout']) {
    const p = document.createElement('details'); p.id = id; p.open = true;
    p.innerHTML = '<summary>' + id + '</summary><p>' + id + '</p>';
    if (id === 'kin-viewer-layout') {
      p.innerHTML += '<label>Job Title <input id="syn-job-title"></label><div id="syn-job-row" tabindex="0">SYN saved job</div>';
      // A saved job row selects itself on Enter/Space and cancels the default, so no click follows (viewer-jobs.js).
      const row = p.querySelector('#syn-job-row');
      row.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); row.dataset.selected = 'yes'; } };
    }
    document.body.append(p);
  }
  KinViewerWorkspaceDock(window, { owner: () => args.owner, allowed: () => true });
}"""

COMPARISON = '#kin-workspace-dock nav button[aria-controls="kin-viewer-layout"]'
OPEN = "() => document.body.classList.contains('kin-dock-open')"


class DockAutohideDOM(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.pw = sync_playwright().start()
        cls.browser = cls.pw.chromium.launch()

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.pw.stop()

    def setUp(self):
        self.errors = []
        self.context = self.browser.new_context(viewport={"width": 1280, "height": 900}, locale="ko-KR", timezone_id="Asia/Seoul")
        self.context.route(ORIGIN + "/**", self.serve)
        self.page = self.context.new_page()
        self.page.set_default_timeout(10000)
        self.page.on("pageerror", lambda error: self.errors.append(str(error)))

    def tearDown(self):
        self.context.close()
        self.assertEqual([], self.errors, "page errors")

    def serve(self, route):
        path = route.request.url.split(ORIGIN, 1)[1].split("?", 1)[0]
        if path == "/ohif/viewer":
            return route.fulfill(body=PAGE, content_type="text/html; charset=utf-8")
        return route.fulfill(status=404, body="")

    def mount(self, stored=None):
        p = self.page
        p.goto(ORIGIN + "/ohif/viewer")
        p.evaluate("([k, v]) => { localStorage.clear(); if (v !== null) localStorage.setItem(k, v); }",
                   [KEY, None if stored is None else json.dumps(stored)])
        for name in ("work-context.js", "viewer-workspace-dock.js"):
            p.add_script_tag(path=str(FILES / name))
        p.evaluate(SETUP, dict(owner=OWNER))
        expect(p.locator(COMPARISON)).to_be_visible()
        return p

    def autohide_on(self):
        return self.mount(dict(version=2, placement="bottom", panel=-1, autoHide=True))

    def tab(self):
        return self.page.locator(COMPARISON)

    def image_point(self):
        box = self.page.locator("#syn-image").bounding_box()
        return box["x"] + box["width"] / 2, box["y"] + 60

    def press_image(self):
        x, y = self.image_point()
        before = self.page.evaluate("() => window.__presses")
        self.page.mouse.move(x, y)
        self.page.mouse.down()
        self.page.mouse.move(x + 20, y + 10)
        self.page.mouse.up()
        self.assertEqual(before + 1, self.page.evaluate("() => window.__presses"), "the press reached the image")

    def expect_folded(self):
        expect(self.tab()).to_have_attribute("aria-expanded", "false", timeout=6000)
        self.assertFalse(self.page.evaluate(OPEN))
        self.assertTrue(self.page.locator("#kin-viewer-layout").evaluate("e => e.hidden"))
        # Folding is not a choice: the opened panel stays the remembered one.
        self.assertEqual(1, self.page.evaluate("() => document.getElementById('kin-workspace-dock').preference().panel"))
        self.assertEqual(1, json.loads(self.page.evaluate("k => localStorage.getItem(k)", KEY))["panel"])

    def stays_open(self, ms=2400):
        samples = self.page.evaluate("""ms => new Promise(resolve => { const s = [], start = performance.now();
          (function frame() { s.push(document.body.classList.contains('kin-dock-open'));
            if (performance.now() - start >= ms) resolve(s); else requestAnimationFrame(frame); })(); })""", ms)
        self.assertGreater(len(samples), 3)
        self.assertTrue(all(samples), "the panel folded while the dock was in use")
        expect(self.tab()).to_have_attribute("aria-expanded", "true")

    def open_with_mouse(self):
        self.tab().click()
        expect(self.tab()).to_have_attribute("aria-expanded", "true")
        self.assertTrue(self.page.evaluate(f"() => document.activeElement === document.querySelector('{COMPARISON}')"),
                        "a tab pressed with the mouse keeps focus (the case being fixed)")

    def test_01_a_tab_pressed_with_the_mouse_folds_after_a_press_on_the_images(self):
        self.autohide_on()
        self.open_with_mouse()
        self.press_image()
        self.expect_folded()
        # The mouse brings it back without toggling it shut.
        self.tab().click()
        expect(self.tab()).to_have_attribute("aria-expanded", "true")
        self.assertEqual(1, self.page.evaluate("() => document.getElementById('kin-workspace-dock').preference().panel"))

    def test_02_a_wheel_on_the_images_after_a_mouse_tab_folds(self):
        self.autohide_on()
        self.open_with_mouse()
        x, y = self.image_point()
        self.page.mouse.move(x, y)
        self.page.mouse.wheel(0, 120)
        self.expect_folded()

    def test_03_typing_in_a_panel_field_then_pressing_the_images_folds_and_keeps_the_text(self):
        self.autohide_on()
        self.open_with_mouse()
        field = self.page.locator("#syn-job-title")
        field.click()
        field.press_sequentially("SYN KEEP JOB")
        self.stays_open(1600)
        self.press_image()
        self.expect_folded()
        self.assertEqual("SYN KEEP JOB", self.page.evaluate("() => document.getElementById('syn-job-title').value"))

    def test_04_viewer_keys_after_the_press_do_not_hold_the_panel_open(self):
        self.autohide_on()
        self.open_with_mouse()
        self.press_image()
        # Image keys (slice up/down) go to the document while focus is still on the tab.
        for _ in range(3):
            self.page.keyboard.press("ArrowDown")
            self.page.wait_for_timeout(200)
        self.expect_folded()

    def test_05_keyboard_work_in_the_dock_keeps_it_open(self):
        self.autohide_on()
        x, y = self.image_point()
        self.page.mouse.move(x, y)
        self.page.locator("#syn-toolbar").focus()
        self.page.keyboard.press("Tab")
        expect(self.page.locator('#kin-workspace-dock nav button[aria-controls="kin-viewer-history"]')).to_be_focused()
        self.page.keyboard.press("Tab")
        expect(self.tab()).to_be_focused()
        self.page.keyboard.press("Enter")
        expect(self.tab()).to_have_attribute("aria-expanded", "true")
        self.stays_open()

    def test_06_after_the_press_keyboard_work_back_in_the_dock_holds_it_again(self):
        self.autohide_on()
        self.open_with_mouse()
        self.press_image()
        self.expect_folded()
        # Enter on the still-focused tab brings the panel back by keyboard and the dock is in use again.
        self.page.keyboard.press("Enter")
        expect(self.tab()).to_have_attribute("aria-expanded", "true")
        self.stays_open()
        # Tab onward into the panel field and type: still the dock's work.
        self.page.locator("#syn-job-title").focus()
        self.page.keyboard.type("SYN")
        self.stays_open(1600)

    def test_08_a_focus_command_on_the_tab_that_still_has_focus_brings_the_panel_back_and_holds_it(self):
        self.autohide_on()
        self.open_with_mouse()
        self.press_image()
        self.expect_folded()
        # Focus Comparison / the Tools shortcut go through the dock's focusTab on the tab, which still has focus: no
        # focusin fires.
        self.page.evaluate(f"() => document.getElementById('kin-workspace-dock').focusTab(document.querySelector('{COMPARISON}'), {{preventScroll: true}})")
        expect(self.tab()).to_have_attribute("aria-expanded", "true")
        self.stays_open()

    def test_11_focus_given_back_to_the_tab_by_a_closing_key_panel_keeps_it_folded(self):
        self.autohide_on()
        self.open_with_mouse()
        x, y = self.image_point()
        self.page.mouse.move(x, y)
        self.page.mouse.wheel(0, 120)
        self.expect_folded()
        # F.Leader opened from the image keys remembers the focused element (the tab) and gives focus back on Esc.
        self.page.evaluate(f"() => document.querySelector('{COMPARISON}').focus()")
        self.page.wait_for_timeout(1600)
        expect(self.tab()).to_have_attribute("aria-expanded", "false")
        self.assertFalse(self.page.evaluate(OPEN))

    def test_09_keyboard_work_that_changes_no_value_keeps_the_dock_held(self):
        self.autohide_on()
        self.open_with_mouse()
        field = self.page.locator("#syn-job-title")
        field.click()
        field.press_sequentially("SYN KEEP")
        x, y = self.image_point()
        self.page.mouse.move(x, y)
        self.page.mouse.wheel(0, 120)
        # Selecting text in the field by keyboard: no input, change, click or focusin.
        self.page.keyboard.press("Shift+ArrowLeft")
        self.stays_open()
        self.page.locator("#syn-job-row").focus()
        self.press_image()
        self.page.keyboard.press("Enter")
        self.assertEqual("yes", self.page.evaluate("() => document.getElementById('syn-job-row').dataset.selected"))
        self.stays_open()
        self.assertEqual("SYN KEEP", self.page.evaluate("() => document.getElementById('syn-job-title').value"))

    def test_10_a_drawing_tool_that_consumes_the_press_on_the_window_still_folds_the_panel(self):
        self.autohide_on()
        # Registered after the dock, as a volume drawing tool binds when its view opens.
        self.page.evaluate("""() => { window.__drawn = 0; addEventListener('pointerdown', e => {
          if (e.target.id === 'syn-image') { window.__drawn++; e.preventDefault(); e.stopImmediatePropagation(); } }, true); }""")
        self.open_with_mouse()
        x, y = self.image_point()
        self.page.mouse.move(x, y)
        self.page.mouse.down()
        self.page.mouse.up()
        self.assertEqual(1, self.page.evaluate("() => window.__drawn"), "the tool still got its press")
        self.expect_folded()

    def test_07_without_auto_hide_nothing_folds(self):
        self.mount(dict(version=2, placement="bottom", panel=-1, autoHide=False))
        self.open_with_mouse()
        self.press_image()
        self.stays_open()


if __name__ == "__main__":
    unittest.main(verbosity=2)
