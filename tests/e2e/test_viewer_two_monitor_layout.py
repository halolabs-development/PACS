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

GRID = '''() => { const s = services.viewportGridService.getState();
  return { rows: s.layout.numRows, cols: s.layout.numCols, cells: [...s.viewports.values()].map(c => [c.viewportId, c.x, c.y, c.width, c.height]) }; }'''
# The grid's middle edge is on the display edge and no cell lies across it (1 px: CDP bounds are whole DIPs).
ON_SEAM = '''async () => { const d = await getScreenDetails(), left = screenX + (outerWidth - innerWidth) / 2;
  const seams = [...new Set(Array.from(d.screens).flatMap(s => [s.left, s.left + s.width]))].map(x => x - left).filter(x => x >= 1 && x <= innerWidth - 1);
  const grid = document.querySelector('[data-cy="viewport-grid"]')?.getBoundingClientRect();
  if (seams.length !== 1 || !grid) return false;
  const seam = seams[0], panes = [...document.querySelectorAll('[data-cy="viewport-pane"]')].map(p => p.getBoundingClientRect());
  return Math.abs((grid.left + grid.right) / 2 - seam) <= 1 && panes.length > 1 && !panes.some(p => p.left < seam - 1 && p.right > seam + 1); }'''


# One Hanging Protocol rule that matches any study: one cell on monitor 1 and one on monitor 2 (the displays left to right).
TWO_MONITOR_RULE_ID = '99999999-9999-4999-8999-999999999999'
TWO_MONITOR_RULES = {'version': 1, 'activeRuleId': TWO_MONITOR_RULE_ID, 'rules': [{
    'id': TWO_MONITOR_RULE_ID, 'name': 'Two Monitors', 'enabled': True,
    'match': {'modality': None, 'retrieveAE': None, 'bodyPart': None, 'description': None},
    'selectors': [{'alias': 'Current', 'role': 'current', 'historical': False, 'modality': None, 'retrieveAE': None, 'bodyPart': None,
                   'description': None, 'laterality': None, 'order': 'ascending', 'occurrence': 1}],
    'layout': {'rows': 1, 'cols': 2, 'cells': ['Current', 'Current']},
    'monitors': {'count': 2, 'list': [{'images': '1x1', 'worklist': 'none', 'thumbs': 'top', 'toolbar': 'top'},
                                      {'images': '1x1', 'worklist': 'none', 'thumbs': 'top', 'toolbar': 'top'}]}}]}


class ViewerTwoMonitorLayoutE2E(ViewerSpanSeamEmulatedE2E):
    def shows(self, viewer, uid, cell=None):
        # A divided screen has several canvases (some cells may be empty): the given cell, or any cell, shows that study.
        viewer.wait_for_function('''([uid, cell]) => [...services.viewportGridService.getState().viewports.keys()].filter(id => !cell || id === cell)
          .some(id => (services.cornerstoneViewportService.getCornerstoneViewport(id)?.getCurrentImageId?.() || '').includes('/studies/' + uid + '/'))''', arg=[uid, cell], timeout=60000)

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
        self.shows(viewer, b.uid)
        self.until(viewer, '() => { const s = services.viewportGridService.getState(); return s.layout.numCols === 2 && s.viewports.size === 2; }')
        self.until(viewer, ON_SEAM)

    def test_two_03_a_double_click_fills_the_cells_monitor_and_the_next_puts_eight_back(self):
        p, viewer, a, _ = self.setup_viewer('TWO3')
        self.stretch(viewer)
        self.layout(viewer, 'Layout-3-1')
        viewer.wait_for_function('() => services.viewportGridService.getState().viewports.size === 8')
        self.until(viewer, ON_SEAM)
        before = viewer.evaluate(GRID)
        # The first cell (it shows the first series), on the left display.
        first = sorted(before['cells'], key=lambda c: (c[2], c[1]))[0]
        self.shows(viewer, a.uid, first[0])
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
        self.shows(viewer, a.uid)

    def test_two_10_a_window_opened_for_the_chosen_displays_is_taken_once_dragged_over_them(self):
        p, viewer, a, b = self.setup_viewer('TWO10')
        targets = p.evaluate('''async () => Array.from((await getScreenDetails()).screens,
          s => ({ left: s.availLeft, top: s.availTop, width: s.availWidth, height: s.availHeight })).filter(s => s.left < 0).sort((x, y) => x.left - y.left)''')
        self.assertEqual(2, len(targets))
        span = dict(left=targets[0]['left'], top=0, width=targets[1]['left'] + targets[1]['width'] - targets[0]['left'], height=1080)
        # The viewer window is closed. Viewer Displays holds the two displays and the place saved for the window lies over
        # both, as Span Displays leaves them.
        viewer.close()
        p.wait_for_timeout(2500)
        p.evaluate('''([pair, rect]) => { localStorage.setItem('kin.ohif.span.screens', JSON.stringify(pair));
          localStorage.setItem('kin.ohif.current.rect', JSON.stringify(rect)); }''', [targets, span])
        # The next study opens a new window: the browser shows it on one display, and the reader is told to drag it.
        second = self.open_first(p, b)
        toast = p.locator('#toast')
        expect(toast).to_have_text('브라우저가 영상 창을 두 화면에 걸쳐 열지 않았습니다. 영상 창의 가장자리를 끌어 두 화면에 걸쳐 놓으세요. '
                                   '걸쳐 놓으면 그 자리를 저장합니다.', timeout=40000)
        self.bounds(second, span)
        expect(toast).to_have_text('영상 창이 두 화면에 걸쳐 있습니다. 창 위치를 저장했습니다.', timeout=15000)
        # Its place over both and the two displays are what the next opening finds.
        saved = p.evaluate("JSON.parse(localStorage.getItem('kin.ohif.current.rect'))")
        self.assertEqual((span['left'], span['width']), (saved['left'], saved['width']))
        self.assertEqual([[t['left'], t['width']] for t in targets],
                         p.evaluate("JSON.parse(localStorage.getItem('kin.ohif.span.screens')).map(s => [s.left, s.width])"))
        self.until(second, ON_SEAM)
        self.shows(second, b.uid)

    def test_two_11_back_on_the_first_patients_tab_the_view_returns_divided_and_stays_so(self):
        p, viewer, a, b = self.setup_viewer('TWO11')
        two = '() => { const s = services.viewportGridService.getState(); return s.layout.numCols === 2 && s.viewports.size === 2; }'
        self.stretch(viewer)
        self.until(viewer, two)
        self.until(viewer, ON_SEAM)
        self.shows(viewer, a.uid)
        # The next patient from the list, in the same window; then back to the first patient by its tab in the viewer.
        self.choose(p, b)
        p.locator('#m-filmbox').click()
        viewer.wait_for_url('**StudyInstanceUIDs=' + b.uid + '**', timeout=45000)
        self.shows(viewer, b.uid)
        self.until(viewer, two)
        self.until(viewer, ON_SEAM)
        viewer.wait_for_timeout(2500)
        tabs = viewer.locator('.kin-patient-tabs > [role=tablist] [role=tab]')
        expect(tabs).to_have_count(2)
        tabs.first.click()
        viewer.wait_for_url('**StudyInstanceUIDs=' + a.uid + '**', timeout=45000)
        self.shows(viewer, a.uid)
        # The tab's saved view (one cell per monitor) is put back, and nothing divides or rebuilds it again afterwards.
        self.until(viewer, two)
        self.until(viewer, ON_SEAM)
        self.until(viewer, '() => !KinViewerPatientTabs.settling()')
        settled = viewer.evaluate(GRID)
        viewer.wait_for_timeout(4000)
        self.assertEqual(settled, viewer.evaluate(GRID))
        self.assertTrue(viewer.evaluate(ON_SEAM), json.dumps(viewer.evaluate(SEAM_STATE)))

    def test_two_13_four_by_two_over_both_comes_back_with_its_patient_images_and_frame_after_a_tab_round_trip(self):
        pa, pb = 'TWO13A-' + uuid.uuid4().hex[:10], 'TWO13B-' + uuid.uuid4().hex[:10]
        a = ThumbnailSeriesE2E.multiple(self, pa, 'two monitor A', '20260801')
        b = ThumbnailSeriesE2E.multiple(self, pb, 'two monitor B', '20260801')
        p = self.sign_in(self.device())
        self.grant(p)
        viewer = self.open_first(p, a)
        self.stretch(viewer)
        self.layout(viewer, 'Layout-3-1')
        viewer.wait_for_function('() => services.viewportGridService.getState().viewports.size === 8')
        self.until(viewer, ON_SEAM)
        # The first cell (on the left display) on the last image of its series.
        first = sorted(viewer.evaluate(GRID)['cells'], key=lambda c: (c[2], c[1]))[0]
        self.shows(viewer, a.uid, first[0])
        last = viewer.evaluate('''async id => { const v = services.cornerstoneViewportService.getCornerstoneViewport(id);
          const last = v.getImageIds().length - 1; if (last > 0) await v.setImageIdIndex(last); return last; }''', first[0])
        self.assertGreater(last, 0)
        viewer.wait_for_function('([id, last]) => services.cornerstoneViewportService.getCornerstoneViewport(id)?.getCurrentImageIdIndex() === last', arg=[first[0], last])
        viewer.wait_for_timeout(2500)
        # Each cell's place and the image it shows (the cell ids are new after a tab is put back).
        cells = '''() => [...services.viewportGridService.getState().viewports.values()].map(c => [c.x, c.y, c.width, c.height,
          services.cornerstoneViewportService.getCornerstoneViewport(c.viewportId)?.getCurrentImageId?.() || null])'''
        before = sorted(viewer.evaluate(cells), key=lambda c: (c[1], c[0]))
        self.assertEqual(8, len(before))
        self.assertIn('/studies/' + a.uid + '/', before[0][4] or '')
        # The next patient from the list, in the same window; then back to the first patient by its tab in the viewer.
        self.choose(p, b)
        p.locator('#m-filmbox').click()
        viewer.wait_for_url('**StudyInstanceUIDs=' + b.uid + '**', timeout=45000)
        self.shows(viewer, b.uid)
        viewer.wait_for_timeout(2500)
        tabs = viewer.locator('.kin-patient-tabs > [role=tablist] [role=tab]')
        expect(tabs).to_have_count(2)
        tabs.first.click()
        viewer.wait_for_url('**StudyInstanceUIDs=' + a.uid + '**', timeout=45000)
        # The first patient is the one shown, with the eight cells, their images and the frame the reader left.
        selected = viewer.locator('.kin-patient-tabs > [role=tablist] [role=tab][aria-selected=true]')
        expect(selected).to_have_count(1)
        expect(selected).to_contain_text(pa)
        self.assertNotIn(pb, selected.inner_text())
        self.until(viewer, '() => !KinViewerPatientTabs.settling()')
        self.until(viewer, '() => services.viewportGridService.getState().viewports.size === 8')
        self.until(viewer, ON_SEAM)
        viewer.wait_for_timeout(2000)
        self.assertEqual(before, sorted(viewer.evaluate(cells), key=lambda c: (c[1], c[0])))
        self.assertTrue(viewer.evaluate(ON_SEAM), json.dumps(viewer.evaluate(SEAM_STATE)))

    def cell_centre(self, viewer, cell):
        box = viewer.locator('[data-cy="viewport-grid"]').bounding_box()
        return box['x'] + box['width'] * (cell[1] + cell[3] / 2), box['y'] + box['height'] * (cell[2] + cell[4] / 2)

    def test_two_05_the_stock_one_up_keeps_its_cell_until_another_layout_takes_its_place(self):
        # 3 x 3 over two displays: the middle column lies over the display edge, so a double click is the stock one-up's.
        p, viewer, a, _ = self.setup_viewer('TWO5')
        self.stretch(viewer)
        self.layout(viewer, 'Layout-2-2')
        viewer.wait_for_function('() => services.viewportGridService.getState().viewports.size === 9')
        before = viewer.evaluate(GRID)
        first = sorted(before['cells'], key=lambda c: (c[2], c[1]))[0]
        self.shows(viewer, a.uid, first[0])
        x, y = self.cell_centre(viewer, first)
        viewer.wait_for_timeout(1500)
        viewer.mouse.dblclick(x, y)
        self.until(viewer, '() => services.viewportGridService.getState().viewports.size === 1')
        # The one cell is the stock toggle's: it keeps the cell's id, and it is not divided however long it stands.
        viewer.wait_for_timeout(3500)
        one = viewer.evaluate(GRID)
        self.assertEqual([[first[0], 0, 0, 1, 1]], one['cells'], one)
        viewer.mouse.dblclick(x, y)
        self.until(viewer, '() => services.viewportGridService.getState().viewports.size === 9')
        self.assertEqual(sorted(c[1:] for c in before['cells']), sorted(c[1:] for c in viewer.evaluate(GRID)['cells']))
        # Enlarged again, then the reader picks 1 x 1 in the Layout menu: the same cell, but a layout of the reader's own
        # choosing. Over two displays that one column is one cell per monitor.
        viewer.wait_for_timeout(800)
        viewer.mouse.dblclick(x, y)
        self.until(viewer, '() => services.viewportGridService.getState().viewports.size === 1')
        viewer.wait_for_timeout(1500)
        self.layout(viewer, 'Layout-0-0')
        self.until(viewer, '() => { const s = services.viewportGridService.getState(); return s.layout.numCols === 2 && s.viewports.size === 2; }')
        self.until(viewer, ON_SEAM)

    def test_two_06_two_cells_on_two_monitors_stay_two_on_a_double_click(self):
        p, viewer, a, _ = self.setup_viewer('TWO6')
        # The one cell the study opened with is divided by itself once the window is over both displays.
        self.stretch(viewer)
        self.until(viewer, '() => { const s = services.viewportGridService.getState(); return s.layout.numCols === 2 && s.viewports.size === 2; }')
        self.until(viewer, ON_SEAM)
        self.shows(viewer, a.uid)
        viewer.wait_for_timeout(2500)
        before = viewer.evaluate(GRID)
        self.assertEqual((1, 2), (before['rows'], before['cols']), before)
        left = sorted(before['cells'], key=lambda c: c[1])[0]
        self.shows(viewer, a.uid, left[0])
        viewer.wait_for_timeout(1500)
        viewer.mouse.dblclick(*self.cell_centre(viewer, left))
        # Each monitor already shows one cell: nothing is enlarged over the display edge.
        viewer.wait_for_timeout(3000)
        self.assertEqual(before, viewer.evaluate(GRID))
        self.assertTrue(viewer.evaluate(ON_SEAM), json.dumps(viewer.evaluate(SEAM_STATE)))

    def test_two_07_dividing_one_column_keeps_the_cell_its_image_and_the_active_cell(self):
        p, viewer, a, _ = self.setup_viewer('TWO7')
        left, right = self.displays
        # On one display: one cell, the reader on the last image of its series.
        self.bounds(viewer, dict(left=right['left'], top=0, width=1920, height=1080))
        self.shows(viewer, a.uid)
        self.until(viewer, '() => { const s = services.viewportGridService.getState(); return s.layout.numCols === 1 && s.viewports.size === 1; }')
        was = viewer.evaluate('''async () => { const id = services.viewportGridService.getActiveViewportId(), v = services.cornerstoneViewportService.getCornerstoneViewport(id);
          const last = v.getImageIds().length - 1; if (last > 0) await v.setImageIdIndex(last);
          return { id, last, image: v.getCurrentImageId() }; }''')
        viewer.wait_for_function('([id, last]) => services.cornerstoneViewportService.getCornerstoneViewport(id)?.getCurrentImageIdIndex() === last', arg=[was['id'], was['last']])
        viewer.wait_for_timeout(1500)
        # The reader drags the window over both displays: the one column becomes one cell per monitor.
        self.bounds(viewer, dict(left=left['left'], top=0, width=3840, height=1080))
        self.until(viewer, '() => { const s = services.viewportGridService.getState(); return s.layout.numCols === 2 && s.viewports.size === 2; }')
        self.until(viewer, ON_SEAM)
        viewer.wait_for_timeout(2500)
        now = viewer.evaluate('''id => { const s = services.viewportGridService.getState(), c = s.viewports.get(id), v = services.cornerstoneViewportService.getCornerstoneViewport(id);
          return { x: c ? c.x : null, active: s.activeViewportId, image: v?.getCurrentImageId?.() || null }; }''', was['id'])
        self.assertEqual(dict(x=0, active=was['id'], image=was['image']), now)

    def refused_rule(self, viewer):
        """A Hanging Protocol rule for monitors 1 and 2 (the two displays side by side) applied to a viewer window standing on
        one of them: the browser does not move the window over both, and the reader is told to lay it there."""
        left, right = self.displays
        self.bounds(viewer, dict(left=right['left'], top=0, width=1920, height=1080))
        tab = viewer.locator('#kin-workspace-dock nav button[aria-controls=kin-viewer-layout]')
        expect(tab).to_be_visible(timeout=45000)
        if tab.get_attribute('aria-expanded') != 'true':
            tab.click()
        expect(viewer.locator('#kin-hp-new')).to_be_visible(timeout=45000)
        viewer.locator('#kin-hp-import').set_input_files(dict(name='two-monitors.json', mimeType='application/json', buffer=json.dumps(TWO_MONITOR_RULES).encode('utf-8')))
        expect(viewer.locator('#kin-hp-status')).to_contain_text('초안으로 가져왔습니다')
        viewer.locator('#kin-hp-apply').click()
        status = viewer.locator('#kin-hp-status')
        expect(status).to_contain_text('Applied: Two Monitors', timeout=45000)
        expect(status).to_contain_text('브라우저가 영상 창을 Monitor 1·Monitor 2(으)로 옮기지 않았습니다. 영상 창의 가장자리를 끌어 그 화면에 걸쳐 놓으세요. '
                                       '걸쳐 놓으면 이 규칙을 다시 적용합니다.')
        self.assertTrue(viewer.evaluate('KinViewerMonitors.reaching()'))
        return status

    def test_two_08_a_protocol_the_browser_kept_on_one_display_comes_back_once_the_window_is_over_both(self):
        p, viewer, a, _ = self.setup_viewer('TWO8')
        left, right = self.displays
        status = self.refused_rule(viewer)
        viewer.evaluate("window.__reached = 0; addEventListener('kin-viewer-monitors-reached', () => __reached++)")
        # The reader drags the window over both displays without touching the images: the rule is applied again, on them.
        self.bounds(viewer, dict(left=left['left'], top=0, width=3840, height=1080))
        expect(status).to_contain_text('Monitors: 적용 Monitor 1·Monitor 2.', timeout=45000)
        self.until(viewer, '() => { const s = services.viewportGridService.getState(); return s.viewports.size === 2 && !KinViewerMonitors.reaching(); }')
        self.until(viewer, ON_SEAM)
        self.shows(viewer, a.uid)
        # Once.
        viewer.wait_for_timeout(3000)
        self.assertEqual(1, viewer.evaluate('__reached'))
        self.assertNotIn('옮기지 않았습니다', status.inner_text())

    def test_two_09_work_on_the_images_meanwhile_is_not_built_over_by_the_protocol(self):
        p, viewer, a, _ = self.setup_viewer('TWO9')
        left, right = self.displays
        status = self.refused_rule(viewer)
        viewer.evaluate("window.__reached = 0; addEventListener('kin-viewer-monitors-reached', () => __reached++)")
        self.shows(viewer, a.uid)
        # The reader scrolls the image the rule left on screen.
        cell = sorted(viewer.evaluate(GRID)['cells'], key=lambda c: (c[2], c[1]))[0]
        viewer.mouse.move(*self.cell_centre(viewer, cell))
        viewer.mouse.wheel(0, 120)
        viewer.wait_for_function('() => !KinViewerMonitors.reaching()')
        viewer.wait_for_timeout(1000)
        image = viewer.evaluate('id => services.cornerstoneViewportService.getCornerstoneViewport(id)?.getCurrentImageId?.() || null', cell[0])
        self.bounds(viewer, dict(left=left['left'], top=0, width=3840, height=1080))
        viewer.wait_for_timeout(6000)
        self.assertEqual(0, viewer.evaluate('__reached'))
        self.assertNotIn('적용 Monitor 1·Monitor 2', status.inner_text())
        # The image the reader went to is still the one shown in that cell.
        self.assertEqual(image, viewer.evaluate('id => services.cornerstoneViewportService.getCornerstoneViewport(id)?.getCurrentImageId?.() || null', cell[0]))

    def test_two_12_an_image_enlarged_from_the_toolbar_menu_meanwhile_is_not_built_over_by_the_protocol(self):
        p, viewer, a, _ = self.setup_viewer('TWO12')
        left, right = self.displays
        status = self.refused_rule(viewer)
        viewer.evaluate("window.__reached = 0; addEventListener('kin-viewer-monitors-reached', () => __reached++)")
        self.shows(viewer, a.uid)
        # The reader enlarges the image from the toolbar: Display > Zoom... > 200% - no press on the image itself.
        cell = viewer.evaluate('services.viewportGridService.getActiveViewportId()')
        viewer.get_by_role('button', name='Display ▾').first.click()
        viewer.get_by_role('menu', name='Display').get_by_role('menuitem', name='Zoom…', exact=True).click()
        zoom = viewer.locator('section.kin-ux-feature-panel[role=dialog][aria-label="Zoom"]')
        zoom.get_by_role('button', name='200%', exact=True).click()
        viewer.wait_for_function('id => Math.abs(services.cornerstoneViewportService.getCornerstoneViewport(id).getZoom() - 2) < 0.01', arg=cell, timeout=15000)
        viewer.wait_for_function('() => !KinViewerMonitors.reaching()')
        # Laid over both displays afterwards: the rule is not applied again over that work.
        self.bounds(viewer, dict(left=left['left'], top=0, width=3840, height=1080))
        viewer.wait_for_timeout(6000)
        self.assertEqual(0, viewer.evaluate('__reached'))
        self.assertNotIn('적용 Monitor 1·Monitor 2', status.inner_text())

    def test_two_14_a_series_dropped_into_a_cell_then_patient_tabs_there_and_back_keep_the_viewer(self):
        # Three patients in one window over both displays, one cell per monitor; on the second patient's tab a series is
        # dragged from the strip into the right monitor's cell, as a reader fills it. Then tab to the first patient, to the
        # second and back: each time that patient's tab is chosen and its images are drawn (the viewer is not left blank),
        # and the window stays Open in Viewer Windows with Span Displays available.
        a, b, c = (ThumbnailSeriesE2E.multiple(self, 'TWO14' + name + '-' + uuid.uuid4().hex[:10], 'two monitor ' + name, '20260801')
                   for name in 'ABC')
        p = self.sign_in(self.device())
        self.grant(p)
        viewer = self.open_first(p, a)
        errors = []
        viewer.on('console', lambda message: errors.append(message.text) if message.type == 'error' else None)
        viewer.on('pageerror', lambda error: errors.append(str(error)))
        two = '() => { const s = services.viewportGridService.getState(); return s.layout.numCols === 2 && s.viewports.size === 2; }'
        self.stretch(viewer)
        self.layout(viewer, 'Layout-0-0')
        self.until(viewer, two)
        self.until(viewer, ON_SEAM)
        self.shows(viewer, a.uid)
        for fixture in (b, c):
            self.choose(p, fixture)
            p.locator('#m-filmbox').click()
            viewer.wait_for_url('**StudyInstanceUIDs=' + fixture.uid + '**', timeout=45000)
            self.shows(viewer, fixture.uid)
        tabs = viewer.locator('.kin-patient-tabs > [role=tablist] [role=tab]')
        selected = viewer.locator('.kin-patient-tabs > [role=tablist] [role=tab][aria-selected=true]')
        expect(tabs).to_have_count(3)

        def to(fixture):
            tabs.filter(has_text=fixture.patient_id).click()
            viewer.wait_for_url('**StudyInstanceUIDs=' + fixture.uid + '**', timeout=45000)
            expect(tabs).to_have_count(3, timeout=30000)
            expect(selected).to_contain_text(fixture.patient_id)
            self.shows(viewer, fixture.uid)
            self.until(viewer, '() => !KinViewerPatientTabs.settling()')
            self.until(viewer, two)

        # The series the right monitor's cell has drawn now (null when it is empty), and whether it is the one wanted.
        right_series = '''wanted => { const cell = [...services.viewportGridService.getState().viewports.values()].find(c => c.x >= 0.5);
          const v = cell && services.cornerstoneViewportService.getCornerstoneViewport(cell.viewportId), image = v?.getCurrentImageId?.();
          const now = image && cornerstone.metaData.get('instance', image)?.SeriesInstanceUID || null;
          return wanted === undefined ? now : now === wanted && (v.viewportStatus === undefined || v.viewportStatus === 'rendered'); }'''
        to(b)
        right = next(cell for cell in viewer.evaluate(GRID)['cells'] if cell[1] >= 0.5)
        strip = viewer.get_by_role('region', name='Series', exact=True)
        before = viewer.evaluate(right_series)
        # A series of this patient the right cell does not show now: once dropped, that cell shows that very series.
        series = next((uid for uid in strip.locator('button.kin-series-card').evaluate_all('cards => cards.map(c => c.dataset.series)')
                       if uid and uid != before), None)
        self.assertIsNotNone(series, 'a series other than the one the right cell shows')
        preview = strip.locator(f'button.kin-series-card[data-series="{series}"] .kin-series-preview')
        expect(preview.locator('img')).to_be_visible(timeout=30000)
        start, (x, y) = preview.bounding_box(), self.cell_centre(viewer, right)
        viewer.mouse.move(start['x'] + start['width'] / 2, start['y'] + start['height'] / 2)
        viewer.mouse.down()
        viewer.mouse.move(x, y, steps=15)
        viewer.mouse.up()
        self.until(viewer, right_series, series)
        viewer.wait_for_timeout(1500)
        for fixture in (a, b, a):
            to(fixture)
            if fixture is b:
                # Back on the second patient: its right cell shows the dropped series again.
                self.until(viewer, right_series, series)
        self.assertEqual([], [text for text in errors if 'HTML5 backends' in text])
        self.until(viewer, ON_SEAM)
        # Viewer Windows still has that window Open, and Span Displays can be pressed for it.
        self.manager(p)
        p.locator('#viewer-windows-displays').click()
        targets = p.evaluate('''async () => Array.from((await getScreenDetails()).screens,
          s => ({ left: s.availLeft, top: s.availTop, width: s.availWidth, height: s.availHeight })).filter(s => s.left < 0).sort((x, y) => x.left - y.left)''')
        self.assertEqual(2, len(targets))
        for number, target in enumerate(targets, 1):
            p.get_by_label('Viewer Display ' + str(number)).select_option(json.dumps([target[k] for k in ['left', 'top', 'width', 'height']], separators=(',', ':')))
        expect(p.locator('.viewer-window-row')).to_have_count(1)
        expect(p.locator('.viewer-window-row p').first).to_contain_text(' · Open · ', timeout=15000)
        expect(self.control(p, 0, 'span')).to_be_enabled()


def load_tests(loader, tests, pattern):
    # Only the cases this module declares; the inherited cases run in their own profiles.
    return unittest.TestSuite(ViewerTwoMonitorLayoutE2E(name) for name in sorted(ViewerTwoMonitorLayoutE2E.__dict__) if name.startswith('test_two_'))


if __name__ == '__main__':
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    unittest.main(verbosity=2)
