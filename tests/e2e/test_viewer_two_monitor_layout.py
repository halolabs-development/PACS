# coding: utf-8
"""One viewer window over two displays, on the shipped viewer with synthetic DICOM.

The two displays are synthetic CDP screens side by side (test_viewer_ux_span's seam case) and the window is laid over
them through CDP window bounds, as a reader drags it; the browser's own moveTo/resizeTo keeps a window on one display, as
a real browser does. Cases: the first Layout picked after the window is stretched has its middle cell edge on the display
edge; one column is one cell per monitor, also for the next patient opened in that window; a double click fills the cell's
monitor only and the next puts the eight cells back; Span Displays the browser refuses asks for a drag and takes the
window once it is over both. Synthetic screens are not physical-monitor evidence (that is checked on two real monitors).
"""
import json
import sys
import unittest
import uuid

from playwright.sync_api import expect

from test_viewer_ux_span import SEAM_STATE, ViewerSpanSeamEmulatedE2E
from test_thumbnail_series import ThumbnailSeriesE2E
from test_prior_selection import canvas_ready

GRID = '''() => { const s = services.viewportGridService.getState();
  return { rows: s.layout.numRows, cols: s.layout.numCols, cells: [...s.viewports.values()].map(c => [c.viewportId, c.x, c.y, c.width, c.height]) }; }'''
# The grid's middle edge is on the display edge and no cell lies across it (1 px: CDP bounds are whole DIPs).
ON_SEAM = '''async () => { const d = await getScreenDetails(), left = screenX + (outerWidth - innerWidth) / 2;
  const seams = [...new Set(Array.from(d.screens).flatMap(s => [s.left, s.left + s.width]))].map(x => x - left).filter(x => x >= 1 && x <= innerWidth - 1);
  const grid = document.querySelector('[data-cy="viewport-grid"]')?.getBoundingClientRect();
  if (seams.length !== 1 || !grid) return false;
  const seam = seams[0], panes = [...document.querySelectorAll('[data-cy="viewport-pane"]')].map(p => p.getBoundingClientRect());
  return Math.abs((grid.left + grid.right) / 2 - seam) <= 1 && panes.length > 1 && !panes.some(p => p.left < seam - 1 && p.right > seam + 1); }'''


class ViewerTwoMonitorLayoutE2E(ViewerSpanSeamEmulatedE2E):
    def setup_viewer(self, prefix):
        a = ThumbnailSeriesE2E.multiple(self, prefix + 'A-' + uuid.uuid4().hex[:10], 'two monitor A', '20260801')
        b = ThumbnailSeriesE2E.multiple(self, prefix + 'B-' + uuid.uuid4().hex[:10], 'two monitor B', '20260801')
        p = self.sign_in(self.device())
        self.grant(p)
        viewer = self.open_first(p, a)
        return p, viewer, a, b

    def stretch(self, viewer):
        left, right = self.displays
        # On one display first, then stretched over both, as a reader drags its edge.
        self.bounds(viewer, dict(left=right['left'], top=0, width=1920, height=1080))
        viewer.wait_for_timeout(1500)
        self.bounds(viewer, dict(left=left['left'], top=0, width=3840, height=1080))
        # The window has stood there a while before the reader picks a layout.
        viewer.wait_for_timeout(2500)

    def layout(self, viewer, cy):
        viewer.locator('[data-cy=Layout]').first.click()
        viewer.locator(f'[data-cy="{cy}"]').first.click()
        viewer.keyboard.press('Escape')

    def test_two_01_the_first_layout_after_stretching_is_divided_at_the_display_edge(self):
        p, viewer, a, _ = self.setup_viewer('TWO1')
        self.stretch(viewer)
        self.layout(viewer, 'Layout-3-1')
        viewer.wait_for_function('() => services.viewportGridService.getState().viewports.size === 8')
        # Without picking it again.
        self.until(viewer, ON_SEAM)
        viewer.wait_for_timeout(2000)
        self.assertTrue(viewer.evaluate(ON_SEAM), json.dumps(viewer.evaluate(SEAM_STATE)))

    def test_two_02_one_column_is_one_cell_per_monitor_also_for_the_next_patient(self):
        p, viewer, a, b = self.setup_viewer('TWO2')
        self.stretch(viewer)
        self.layout(viewer, 'Layout-0-0')
        self.until(viewer, '() => { const s = services.viewportGridService.getState(); return s.layout.numCols === 2 && s.viewports.size === 2; }')
        self.until(viewer, ON_SEAM)
        # The next patient in the same window: its protocol gives one cell; the window is still over both displays.
        self.choose(p, b)
        p.locator('#m-filmbox').click()
        viewer.wait_for_url('**StudyInstanceUIDs=' + b.uid + '**', timeout=45000)
        canvas_ready(viewer, 1)
        self.until(viewer, '() => { const s = services.viewportGridService.getState(); return s.layout.numCols === 2 && s.viewports.size === 2; }')
        self.until(viewer, ON_SEAM)

    def test_two_03_a_double_click_fills_the_cells_monitor_and_the_next_puts_eight_back(self):
        p, viewer, a, _ = self.setup_viewer('TWO3')
        self.stretch(viewer)
        self.layout(viewer, 'Layout-3-1')
        viewer.wait_for_function('() => services.viewportGridService.getState().viewports.size === 8')
        self.until(viewer, ON_SEAM)
        canvas_ready(viewer, 1)
        before = viewer.evaluate(GRID)
        # The first cell (it shows the first series), on the left display.
        first = sorted(before['cells'], key=lambda c: (c[2], c[1]))[0]
        box = viewer.locator('[data-cy="viewport-grid"]').bounding_box()
        x, y = box['x'] + box['width'] * (first[1] + first[3] / 2), box['y'] + box['height'] * (first[2] + first[4] / 2)
        viewer.mouse.dblclick(x, y)
        self.until(viewer, '() => services.viewportGridService.getState().viewports.size === 5')
        after = viewer.evaluate(GRID)
        big = [c for c in after['cells'] if abs(c[3] - 0.5) < 0.01 and abs(c[4] - 1) < 0.01]
        self.assertEqual(1, len(big), after)
        self.assertLess(big[0][1], 0.01, 'the left monitor only: ' + json.dumps(after))
        # The right monitor's four cells are as they were.
        self.assertEqual(sorted(c[1:] for c in before['cells'] if c[1] >= 0.5), sorted(c[1:] for c in after['cells'] if c[1] >= 0.5))
        viewer.wait_for_timeout(800)
        viewer.mouse.dblclick(x, y)
        self.until(viewer, '() => services.viewportGridService.getState().viewports.size === 8')
        self.assertEqual(sorted(c[1:] for c in before['cells']), sorted(c[1:] for c in viewer.evaluate(GRID)['cells']))

    def test_two_04_span_displays_the_browser_refuses_asks_for_a_drag_and_takes_the_window_over_both(self):
        p, viewer, a, _ = self.setup_viewer('TWO4')
        left, right = self.displays
        self.bounds(viewer, dict(left=right['left'], top=0, width=1920, height=1080))
        self.manager(p)
        p.locator('#viewer-windows-displays').click()
        targets = p.evaluate('''async () => Array.from((await getScreenDetails()).screens,
          s => ({ left: s.availLeft, top: s.availTop, width: s.availWidth, height: s.availHeight })).filter(s => s.left < 0).sort((x, y) => x.left - y.left)''')
        self.assertEqual(2, len(targets))
        for number, target in enumerate(targets, 1):
            p.get_by_label('Viewer Display ' + str(number)).select_option(json.dumps([target[k] for k in ['left', 'top', 'width', 'height']], separators=(',', ':')))
        p.get_by_role('button', name='Span Displays', exact=True).click()
        status = p.locator('#viewer-windows-status')
        # The browser keeps the window on one display: not a failure, the reader is told to drag it over both.
        expect(status).to_have_text('브라우저가 영상 창을 두 화면에 걸쳐 옮기지 않았습니다. 영상 창의 가장자리를 끌어 Display 1과 Display 2에 '
                                    '걸쳐 놓으세요. 걸쳐 놓으면 그 자리를 저장합니다.', timeout=15000)
        # The reader drags it over both: taken as placed, the place and the two displays saved.
        span = dict(left=targets[0]['left'], top=0, width=targets[1]['left'] + targets[1]['width'] - targets[0]['left'], height=1080)
        self.bounds(viewer, span)
        expect(status).to_have_text('영상 창이 Display 1·2에 걸쳐 있습니다. 창 위치를 저장했습니다.', timeout=15000)
        saved = p.evaluate("JSON.parse(localStorage.getItem('kin.ohif.current.rect'))")
        self.assertEqual((span['left'], span['width']), (saved['left'], saved['width']))
        self.assertEqual([[t['left'], t['width']] for t in targets],
                         p.evaluate("JSON.parse(localStorage.getItem('kin.ohif.span.screens')).map(s => [s.left, s.width])"))
        # The viewer divides its grid at the display edge by itself.
        self.until(viewer, ON_SEAM)
        self.loaded(viewer, a)


def load_tests(loader, tests, pattern):
    # Only the cases this module declares; the inherited cases run in their own profiles.
    return unittest.TestSuite(ViewerTwoMonitorLayoutE2E(name) for name in sorted(ViewerTwoMonitorLayoutE2E.__dict__) if name.startswith('test_two_'))


if __name__ == '__main__':
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    unittest.main(verbosity=2)
