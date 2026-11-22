"""Patient-strip layout must preserve keyboard focus across header placement.

The fixture supplies the pinned OHIF header boundary; real Chromium owns focus
and DOM relocation. The served patient-tab suite covers native router teardown.
"""
from pathlib import Path
import unittest

from playwright.sync_api import expect, sync_playwright

ROOT = Path(__file__).resolve().parents[1]
HTML = """
<div>
  <div class="kin-patient-tabs"><div role="tablist" aria-label="Patients">
    <button role="tab" aria-selected="true">Patient A</button>
  </div></div>
  <div class="bg-secondary-dark z-20">
    <div style="height:32px;position:relative">
      <span id="kin-viewer-brand">HALO PACS</span>
      <div class="relative flex justify-center"><div><button aria-label="Layout">Layout</button></div></div>
      <div class="absolute right-0"><button aria-label="Settings">Settings</button></div>
    </div>
  </div>
</div>
"""


class ViewerHeaderFocusDOM(unittest.TestCase):
    def test_header_placement_keeps_focused_tab_or_external_control(self):
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch()
            for width in (900, 1366, 1680):
                for target in ("Patient A", "Settings"):
                    with self.subTest(width=width, focus=target):
                        page = browser.new_page(viewport={"width": width, "height": 900})
                        page.set_content(HTML)
                        page.add_script_tag(content="""
                          const KIN_VIEWER_DEFAULT_TITLE='Viewer', KIN_VIEWER_PRODUCT='Viewer';
                          const kinViewerOnEnd=()=>null, kinViewerToolbarLabels={apply(){}};
                        """)
                        page.add_script_tag(path=str(ROOT / "config/ohif/branding.js"))
                        focused = page.get_by_role("tab" if target == "Patient A" else "button", name=target, exact=True)
                        focused.focus()
                        page.evaluate("""() => KinViewerBrand({React:{
                          useEffect(fn){window.disposeBrand=fn()}, createElement(){return null}
                        }})""")
                        page.wait_for_function("""() => {
                          const tabs=document.querySelector('[role=tablist]').parentElement;
                          const header=document.getElementById('kin-viewer-brand').closest('.bg-secondary-dark');
                          return tabs.getBoundingClientRect().top >= header.getBoundingClientRect().bottom;
                        }""")
                        expect(focused).to_be_focused()
                        page.evaluate("disposeBrand()")
                        page.close()
            browser.close()

    def test_user_preferences_keeps_hotkeys_and_takes_out_the_language_list(self):
        """The pinned viewer's User Preferences (a React modal: General › Language, then Hotkeys) keeps its Hotkeys and
        buttons; the General › Language list is hidden and out of focus, also when the modal opens after the header is
        mounted. A modal without the Hotkeys section is left as it is."""
        modal = """(flat) => {
          const make = (tag, text, cls) => { const e = document.createElement(tag); if (text) e.textContent = text; if (cls) e.className = cls; return e; };
          const portal = make('div', '', 'ReactModal__Portal'), content = make('div', '', 'ReactModal__Content'); content.setAttribute('role', 'dialog');
          const head = make('div'); head.append(make('h6', 'User Preferences'), make('button', 'x')); content.append(head);
          const body = make('div', '', 'p-2');
          const title = name => { const t = make('div', '', 'mb-2 border-b'); t.append(make('span', name)); return t; };
          const row = make('div', '', 'flex flex-row'); const select = make('select'); select.id = 'syn-language';
          select.append(make('option', 'English (USA)'), make('option', 'Test Language')); row.append(make('span', 'Language'), select);
          const keys = make('div', '', 'mt-4'); const key = make('div', '', 'mb-2 flex'); const field = make('input'); field.readOnly = true; field.value = 'z';
          field.id = 'syn-zoom'; const column = make('div', '', 'flex w-32 flex-col'); column.append(field); key.append(make('div', 'Zoom'), column); keys.append(key);
          if (flat) body.append(title('General'), row, title('Hotkeys'), keys);
          else { const general = make('div'), hot = make('div'); const inner = make('div', '', 'mt-4 mb-8'); inner.append(row);
            general.append(title('General'), inner); hot.append(title('Hotkeys'), keys); body.append(general, hot); }
          const foot = make('div'); foot.append(make('button', 'Reset to Defaults'), make('button', 'Cancel'), make('button', 'Save'));
          content.append(body, foot); portal.append(content); document.body.append(portal);
        }"""
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch()
            for flat in (False, True):
                for late in (False, True):
                    with self.subTest(flat=flat, late=late):
                        page = browser.new_page()
                        page.set_content(HTML)
                        page.add_script_tag(content="""
                          const KIN_VIEWER_DEFAULT_TITLE='Viewer', KIN_VIEWER_PRODUCT='Viewer';
                          const kinViewerOnEnd=()=>null, kinViewerToolbarLabels={apply(){}};
                          function kinText(t){return t;}
                        """)
                        page.add_script_tag(path=str(ROOT / "config/ohif/branding.js"))
                        mount = """() => KinViewerBrand({React:{useEffect(fn){window.disposeBrand=fn()}, createElement(){return null}}})"""
                        if not late: page.evaluate(modal, flat)
                        page.evaluate(mount)
                        if late: page.evaluate(modal, flat)
                        expect(page.locator("#syn-language")).to_be_hidden()
                        expect(page.get_by_text("Language", exact=True)).to_be_hidden()
                        expect(page.get_by_text("General", exact=True)).to_be_hidden()
                        for name in ("Hotkeys", "Zoom", "User Preferences"):
                            expect(page.get_by_text(name, exact=True)).to_be_visible()
                        expect(page.locator("#syn-zoom")).to_be_visible()
                        expect(page.get_by_role("button", name="Save", exact=True)).to_be_visible()
                        self.assertTrue(page.evaluate("() => document.getElementById('syn-language').closest('[inert]') !== null"))
                        page.close()
            # A modal of another kind that names a language keeps it.
            page = browser.new_page()
            page.set_content(HTML)
            page.add_script_tag(content="""
              const KIN_VIEWER_DEFAULT_TITLE='Viewer', KIN_VIEWER_PRODUCT='Viewer';
              const kinViewerOnEnd=()=>null, kinViewerToolbarLabels={apply(){}};
              function kinText(t){return t;}
            """)
            page.add_script_tag(path=str(ROOT / "config/ohif/branding.js"))
            page.evaluate("""() => { const c = document.createElement('div'); c.className = 'ReactModal__Content';
              const s = document.createElement('span'); s.textContent = 'Language'; c.append(s); document.body.append(c);
              KinViewerBrand({React:{useEffect(fn){window.disposeBrand=fn()}, createElement(){return null}}}); }""")
            expect(page.get_by_text("Language", exact=True)).to_be_visible()
            browser.close()


if __name__ == "__main__":
    unittest.main(verbosity=2)
