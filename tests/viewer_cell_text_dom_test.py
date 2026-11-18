# coding: utf-8
"""Text over a cell's image never covers other text over it.

The place of every piece of text over the image is settled in one place, viewer-info-bar.js settle(): the viewer's own
corner text, the reference/comparison label (viewer-identity.js), the Display text (viewer-features-display.js), the
mammography slot label (config/ohif/mammography-hanging.js) and the Navigation Bar (viewer-features-navigate.js).

MammographyZoomTest runs the shipped Display module in the harness of tests/viewer_display_dom_test.py and puts the
mammography slot label in each cell with the exact inline style config/ohif/mammography-hanging.js gives it (read from
that file), then asks for the settled places as that module does. IdentityNavigationTest runs the shipped
viewer-identity.js in the harness of tests/viewer_identity_position_dom_test.py and puts a Navigation Bar in the cell's
layer with the rule viewer-features-navigate.js ships (read from that file) and the shipped theme. Both measure the
boxes on the page: no two pieces overlap, at each identity text size and cell size. The stock viewer's corner menu
(the round Display button's list) stands above the label.
"""
from pathlib import Path
import re
import unittest

from playwright.sync_api import expect

import viewer_display_dom_test as display
import viewer_identity_position_dom_test as identity

ROOT = Path(__file__).resolve().parents[1]
HPACS = ROOT / "worklist-v0" / "hpacs-lite"
SOURCE = (ROOT / "config" / "ohif" / "mammography-hanging.js").read_text(encoding="utf-8")
SLOT_CSS = re.search(r"label\.style\.cssText = '([^']+)'", SOURCE).group(1)
NAV_RULE = re.search(r"\.kin-nav-bar\{[^}]+\}", (HPACS / "viewer-features-navigate.js").read_text(encoding="utf-8")).group(0)

OVERLAPS = """selectors => { const out = [];
  for (const pane of document.querySelectorAll('[data-cy=viewport-pane]')) {
    const boxes = selectors.flatMap(selector => [...pane.querySelectorAll(selector)].map(node => {
      const r = node.getBoundingClientRect(); return { selector, text: node.textContent.slice(0, 30), left: r.left, right: r.right, top: r.top, bottom: r.bottom };
    })).filter(b => b.right > b.left && b.bottom > b.top);
    boxes.forEach((a, i) => boxes.slice(i + 1).forEach(b => {
      const w = Math.min(a.right, b.right) - Math.max(a.left, b.left), h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
      if (w > 0 && h > 0) out.push([pane.id || pane.querySelector('[id]')?.id, a.text, b.text, Math.round(w), Math.round(h)]);
    }));
  }
  return out; }"""

# As config/ohif/mammography-hanging.js: a slot label in the cell's viewport element, then the settled places.
SLOT = """([css, texts]) => { for (const [id, text] of Object.entries(texts)) {
    const host = document.querySelector('#pane-' + id + ' .viewport-element');
    let label = host.querySelector('.kin-mg-slot');
    if (!label) { label = document.createElement('div'); label.className = 'kin-mg-slot'; host.append(label); }
    label.style.cssText = css; label.textContent = text;
  }
  document.querySelectorAll('[data-cy="viewport-pane"]').forEach(pane => window.KinViewerInfoBar?.settle?.(pane)); }"""


class MammographyZoomTest(display.ViewerDisplayDOMTest):
    def test_slot_label_and_zoom_line_do_not_overlap_in_any_cell(self):
        page = self.open()
        page.add_script_tag(path=str(HPACS / "viewer-info-bar.js"))
        expect(page.locator("#pane-left .kin-display-zoom")).to_have_text("Zoom 100%")
        expect(page.locator("#pane-right .kin-display-zoom")).to_have_text("Zoom 100%")
        page.evaluate(SLOT, [SLOT_CSS, {"left": "Current · R CC · Synthetic 2D", "right": "R CC · 2장 중 1장 · 재촬영"}])
        pieces = ['[data-cy="viewport-overlay-bottom-left"] > div:not([style*="display: none"])', ".kin-display-zoom", ".kin-mg-slot"]
        self.assertEqual([], page.evaluate(OVERLAPS, pieces))
        # The slot label still stands in its corner, just above the Zoom line.
        boxes = page.evaluate("""() => ['.kin-display-zoom', '.kin-mg-slot'].map(s => document.querySelector('#pane-left ' + s).getBoundingClientRect().toJSON())""")
        self.assertLessEqual(boxes[1]["bottom"], boxes[0]["top"])
        self.assertLess(boxes[0]["top"] - boxes[1]["bottom"], 6)
        # The Display module draws again (a zoom change): the label is settled again and still clear of it.
        page.evaluate("synViewports.get('left').setZoom(2.5)")
        expect(page.locator("#pane-left .kin-display-zoom")).to_have_text("Zoom 250%")
        page.wait_for_timeout(100)
        self.assertEqual([], page.evaluate(OVERLAPS, pieces))


class IdentityNavigationTest(identity.ViewerIdentityPositionDOMTest):
    def setUp(self):
        super().setUp()
        self.page.add_style_tag(path=str(HPACS / "viewer-ux-theme.css"))
        self.page.add_style_tag(content=NAV_RULE)
        self.page.add_script_tag(path=str(HPACS / "viewer-info-bar.js"))
        self.page.evaluate("document.body.classList.add('kin-viewer-ux')")

    def bar(self):
        # As viewer-features-navigate.js: the bar in the cell's layer (viewer-features.js cellLayer), then the settled places.
        self.page.evaluate("""() => { for (const pane of document.querySelectorAll('[data-cy=viewport-pane]')) {
            let layer = pane.querySelector(':scope > .kin-ux-cell-layer');
            if (!layer) { layer = document.createElement('div'); layer.className = 'kin-ux-cell-layer'; pane.append(layer);
              const bar = document.createElement('div'); bar.className = 'kin-nav-bar'; bar.setAttribute('role', 'group');
              bar.innerHTML = '<div class="kin-nav-track" style="flex:1;width:10px;background:#444"></div><input value="1"><small>/ 40</small>'; layer.append(bar); }
            KinViewerInfoBar.settle(pane); } }""")

    def test_navigation_bar_starts_below_the_reference_label_at_every_size(self):
        self.page.evaluate("window.identityMount=__mount()")
        for size in [12, 14, 16, 18, 20]:
            self.page.evaluate("""size => { const v = KinViewerIdentity.defaults(); v.current.size = size; v.prior.size = size;
                v.current.description = true; KinViewerIdentity.publish(JSON.stringify(ownerValue), v); }""", size)
            self.bar()
            self.assertEqual([], self.page.evaluate(OVERLAPS, [".kin-viewer-identity-content", ".kin-viewer-identity-group", ".kin-nav-bar"]), size)
            # The bar keeps its bottom; it only starts lower.
            bottom = self.page.evaluate("() => { const p = document.querySelector('[data-cy=viewport-pane]').getBoundingClientRect(), b = document.querySelector('.kin-nav-bar').getBoundingClientRect(); return Math.round(p.bottom - b.bottom); }")
            self.assertEqual(40, bottom, size)

    def test_corner_menu_of_the_viewer_stands_above_the_label(self):
        self.page.evaluate("window.identityMount=__mount()")
        # OHIF 3.9.1 ViewportActionCorners: the top-right corner (no z-index of its own) and the menu its button opens.
        hit = self.page.evaluate("""() => { const pane = document.querySelector('[data-cy=viewport-pane]');
            const corner = document.createElement('div'); corner.className = 'pointer-events-auto flex items-center gap-1 absolute top-[4px] right-[4px] right-viewport-scrollbar';
            corner.style.cssText = 'position:absolute;top:4px;right:4px';
            corner.innerHTML = '<button style="width:24px;height:24px">o</button><div class="syn-menu" style="position:absolute;top:28px;right:0;width:220px;background:#222;color:#fff">'
              + '<div class="syn-first">Display Color bar</div><div>Color LUT</div><div>Window Presets</div></div>';
            pane.append(corner);
            // The list opens under its button, down over the label's place (as on the viewer, where the label stands 38px down).
            const menu = corner.querySelector('.syn-menu'), at = pane.querySelector('.kin-viewer-identity-content').getBoundingClientRect();
            menu.style.top = (at.top - corner.getBoundingClientRect().top) + 'px';
            const first = corner.querySelector('.syn-first').getBoundingClientRect(), label = pane.querySelector('.kin-viewer-identity-content').getBoundingClientRect();
            const x = Math.max(first.left, label.left) + 4, y = Math.max(first.top, label.top) + 4;
            const covered = x < Math.min(first.right, label.right) && y < Math.min(first.bottom, label.bottom);
            // The label lets presses through (pointer-events none); for this paint-order probe it takes them.
            pane.querySelectorAll('.kin-viewer-identity, .kin-viewer-identity *').forEach(n => { n.style.pointerEvents = 'auto'; });
            return { covered, top: document.elementFromPoint(x, y)?.className || '', first: first.toJSON(), label: label.toJSON() }; }""")
        self.assertTrue(hit["covered"], hit)
        self.assertEqual("syn-first", hit["top"])


def load_tests(loader, tests, pattern):
    # Only this file's tests: the harness classes' own tests run from their files.
    suite = unittest.TestSuite()
    for case in (MammographyZoomTest, IdentityNavigationTest):
        suite.addTests(case(name) for name in vars(case) if name.startswith("test_"))
    return suite


if __name__ == "__main__":
    unittest.main()
