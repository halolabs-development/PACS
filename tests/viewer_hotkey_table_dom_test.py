# coding: utf-8
"""The pinned viewer's User Preferences › Hotkeys table beside this product's key layer (viewer-ux-shortcuts.js).

In a Viewer window the layer takes letters, digits and Shift with a letter (the image tool keys), Space when F.Leader
opens with it, and the work page's chords that window acts on, before the viewer's own hotkeys. The table row of a
binding the layer takes says that it does nothing in this window and why; a press the layer takes is not recorded
in the table (it never reaches the viewer's recorder, a document listener). Every other binding stays as the viewer
shows and edits it. The modal here has the pinned HotkeysPreferences structure (OHIF 3.9.1: a read-only field in a
w-32 column of a ReactModal); the real modal is checked in tests/e2e/test_viewer_ux_shell.py.
"""
from pathlib import Path
import unittest

from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[1]
HPACS = ROOT / "worklist-v0" / "hpacs-lite"
ORIGIN = "https://viewer-hotkeys.test"
HARNESS = "<!doctype html><html><head></head><body><div id='root'></div></body></html>"

# The modal as React draws it: a portal on the body, rows of a label and a read-only key field.
MODAL = """bindings => {
  const portal = document.createElement('div'); portal.className = 'ReactModal__Portal'; document.body.append(portal);
  const content = document.createElement('div'); content.className = 'ReactModal__Content'; content.setAttribute('role', 'dialog');
  content.setAttribute('aria-modal', 'true'); portal.append(content);
  for (const [label, keys] of bindings) {
    const row = document.createElement('div'); row.className = 'mb-2 flex flex-row justify-end';
    const name = document.createElement('div'); name.textContent = label; row.append(name);
    const column = document.createElement('div'); column.className = 'flex w-32 flex-col';
    const field = document.createElement('input'); field.readOnly = true; field.value = keys; field.setAttribute('value', keys);
    field.setAttribute('aria-label', label); column.append(field); row.append(column); content.append(row);
  }
}"""


class ViewerHotkeyTableDOMTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.pw = sync_playwright().start()
        cls.browser = cls.pw.chromium.launch()

    @classmethod
    def tearDownClass(cls):
        cls.browser.close(); cls.pw.stop()

    def open(self, leader=True, viewer_window=False):
        context = self.browser.new_context()
        page = context.new_page(); errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.route(ORIGIN + "/", lambda route: route.fulfill(body=HARNESS, content_type="text/html"))
        page.goto(ORIGIN + "/")
        page.add_script_tag(path=str(HPACS / "viewer-ux-shortcuts.js"))
        if viewer_window:
            # The work page's chords as a Viewer window judges them (config/ohif/viewer-ux.js), with the window's patient ID
            # copy (viewer-tech-note.js) installed or not.
            page.add_script_tag(path=str(ROOT / "config" / "ohif" / "viewer-ux.js"))
            page.add_script_tag(path=str(HPACS / "viewer-tech-note.js"))
        page.evaluate("""([leader, viewerWindow]) => {
          window.kinCTPresets = { names: ['Soft tissue', 'Lung', 'Liver', 'Bone', 'Brain'] };
          window.synRecorded = []; window.synInvoked = [];
          // The viewer's recorder and hotkeys listen on the document (Mousetrap).
          document.addEventListener('keydown', event => synRecorded.push(event.key));
          // F.Leader as viewer-features-input.js installs it: a closed panel takes Space only when that is turned on.
          KinViewerUXShortcuts.lead((event, refused, asking) => asking ? leader && event.key === ' ' : false);
          window.synKeys = KinViewerUXShortcuts.mount({
            getBindings: () => ({ Length: 'l', RectangleROI: 'r', Zoom: 'z', flipHorizontal: 'shift+h', Probe: '3' }),
            invoke: id => { synInvoked.push(id); return true; }, allowed: () => true,
            workspace: viewerWindow ? kinViewerWorkspaceClaims
              : ({ ctrlKey, altKey, code }) => ctrlKey && altKey && ['Digit2', 'KeyC'].includes(code) });
        }""", [leader, viewer_window])
        self.addCleanup(context.close)
        self.addCleanup(lambda: self.assertEqual([], errors))
        return page

    def notes(self, page):
        page.wait_for_timeout(400)
        return page.evaluate("""() => [...document.querySelectorAll('.ReactModal__Content input')].map(field => {
          const note = field.dataset.kinHotkeyNote && document.getElementById(field.dataset.kinHotkeyNote);
          return [field.getAttribute('aria-label'), note && !note.hidden ? note.textContent : null];
        })""")

    def test_01_rows_the_layer_takes_say_so_and_the_others_stay(self):
        page = self.open()
        page.evaluate(MODAL, [['Rotate Right', 'r'], ['Rotate Left', 'l'], ['Flip Horizontally', 'shift+h'], ['Zoom', 'z'],
                              ['Reset', 'space'], ['Next Series', 'pagedown'], ['Zoom In', '+'], ['Preset 1', '1'],
                              ['Preset 3', '3'], ['Preset 6', '6'], ['Mine', 'ctrl+alt+2'], ['Free chord', 'ctrl+alt+3'],
                              ['Shift digit', 'shift+1'], ['Next Image', 'down'], ['Ctrl letter', 'ctrl+q']])
        rows = dict(self.notes(page))
        for label in ['Rotate Right', 'Rotate Left', 'Flip Horizontally', 'Zoom', 'Preset 3', 'Preset 6']:
            self.assertIn('영상 도구 키', rows[label] or '', label)
        self.assertIn('F.Leader', rows['Reset'])
        self.assertIn('작업 화면 단축키', rows['Mine'])
        # A CT preset digit no tool key uses goes on to the viewer; so do keys with Ctrl, arrows, paging and symbols.
        for label in ['Next Series', 'Zoom In', 'Preset 1', 'Free chord', 'Shift digit', 'Next Image', 'Ctrl letter']:
            self.assertIsNone(rows[label], label)
        self.assertEqual('true', page.get_attribute('[aria-label="Rotate Right"]', 'aria-invalid'))
        self.assertIsNone(page.get_attribute('[aria-label="Next Series"]', 'aria-invalid'))
        # A binding the viewer changes (a recorded key, Reset to Defaults) is judged again.
        page.evaluate("() => { const f = document.querySelector('[aria-label=\"Next Series\"]'); f.value = 'k'; f.setAttribute('value', 'k'); }")
        self.assertIn('영상 도구 키', dict(self.notes(page))['Next Series'])

    def test_02_a_press_the_layer_takes_is_not_recorded_and_others_are(self):
        page = self.open(leader=False)
        page.evaluate(MODAL, [['Next Series', 'pagedown'], ['Reset', 'space']])
        self.assertIsNone(dict(self.notes(page))['Reset'], 'Space reaches the viewer while F.Leader does not use it')
        page.focus('[aria-label="Next Series"]')
        for key in ['q', 'Shift+H', '7']:
            page.keyboard.press(key)
        # Nothing reaches the recorder, not even the Shift of a refused Shift+H (it would record a lone 'shift').
        self.assertEqual([], page.evaluate("synRecorded"))
        # A held key's repeats are refused too.
        page.evaluate("""() => { const f = document.activeElement; for (const repeat of [false, true, true])
          f.dispatchEvent(new KeyboardEvent('keydown', { key: 'l', code: 'KeyL', repeat, bubbles: true, cancelable: true })); }""")
        self.assertEqual([], page.evaluate("synRecorded"))
        self.assertIn('영상 도구 키', dict(self.notes(page))['Next Series'])
        self.assertEqual([], page.evaluate("synInvoked"))
        page.keyboard.press('PageUp'); page.keyboard.press('Control+q'); page.keyboard.press('5')
        # 5 is a CT preset digit no tool key uses: the viewer gets it.
        # A modifier with a key the viewer gets is recorded with that key (the recorder reads the key's modifiers).
        self.assertEqual(['PageUp', 'q', '5'], page.evaluate("synRecorded"))

    def test_03_without_the_layer_nothing_is_marked(self):
        page = self.open()
        page.evaluate("() => synKeys.dispose()")
        page.evaluate(MODAL, [['Rotate Right', 'r']])
        self.assertIsNone(dict(self.notes(page))['Rotate Right'])
        self.assertIsNone(page.evaluate("KinViewerUXShortcuts.claims('r')"))

    def test_04_patient_id_copy_is_reserved_only_while_the_window_has_it(self):
        """Control+Alt+C is the Viewer window's patient ID copy only while that copy is installed (a radiologist's or a
        technician's window). A clinician's read-only window has none: there the table neither marks nor refuses it, and
        it can be put on another row."""
        page = self.open(viewer_window=True)
        rows = [['Copy', 'ctrl+alt+c'], ['Next Series', 'pagedown']]
        page.evaluate(MODAL, rows)
        self.assertIsNone(dict(self.notes(page))['Copy'])
        page.focus('[aria-label="Next Series"]')
        page.keyboard.press('Control+Alt+c')
        self.assertEqual(['c'], page.evaluate("synRecorded"))
        # The same table in a window that has the copy (it is installed when the window's writer is confirmed).
        page.evaluate("""() => { document.querySelectorAll('.ReactModal__Portal').forEach(p => p.remove());
          window.synCopy = kinCreateViewerPatientCopy({ services: {}, host: document.body, selected: () => null,
            owner: () => ['syn-sub', 'SYN-INST'], live: () => true, studies: [] }); }""")
        page.evaluate(MODAL, rows)
        self.assertIn('작업 화면 단축키', dict(self.notes(page))['Copy'])
        page.focus('[aria-label="Next Series"]')
        page.keyboard.press('Control+Alt+c')
        self.assertEqual(['c'], page.evaluate("synRecorded"))
        # Its window ends the copy: the key is the viewer's again.
        page.evaluate("""() => { synCopy.dispose(); document.querySelectorAll('.ReactModal__Portal').forEach(p => p.remove()); }""")
        page.evaluate(MODAL, rows)
        self.assertIsNone(dict(self.notes(page))['Copy'])


if __name__ == "__main__":
    unittest.main(verbosity=2)
