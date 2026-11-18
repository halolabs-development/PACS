# coding: utf-8
"""Auto Save View on the served viewer with owned synthetic CT: with the account check on, W/L, zoom and the image are
saved a moment after they change and put back, with a badge, when the viewer is opened again (a study no Hanging Protocol
is applied to); a viewer closed right after a change still saves it; the saved view is not a Job; with the check off the
viewer opens on its own first view; a Job chosen to open wins over the saved view; series put in another order (a coronal
one first, its image still coming as the saved view goes back) come back with their own zoom, window and image."""
import json
import time
import uuid
from pathlib import Path

from playwright.sync_api import expect

from invariants_live import psql
from test_viewer_display_menu import ViewerDisplayMenuE2E
from workspace_roaming_support import cleanup_workspace


def literal(value):
    return "'" + str(value).replace("'", "''") + "'"

CHECK = 'Save view changes automatically and apply on reopen'
FIRST = "[...services.viewportGridService.getState().viewports.values()].sort((a, b) => a.y - b.y || a.x - b.x)[0]"
# The first cell: its image (SOP and place), zoom and window, and the badge if one is shown.
STATE = """() => { const g = """ + FIRST + """, v = services.cornerstoneViewportService.getCornerstoneViewport(g.viewportId);
  const id = v.getCurrentImageId(), m = cornerstone.metaData.get('instance', id), r = v.getProperties().voiRange;
  const wl = cornerstone.utilities.windowLevel.toWindowLevel(r.lower, r.upper);
  return { index: v.getCurrentImageIdIndex(), sop: m.SOPInstanceUID, zoom: v.getZoom(), w: Math.round(wl.windowWidth), l: Math.round(wl.windowCenter),
    lower: r.lower, upper: r.upper, badge: document.querySelector('[data-auto-view-badge]')?.textContent || null }; }"""
# The reader's change: another image, then a window and a zoom (as the viewer's tools set them).
CHANGE = """([index, w, l, zoom]) => new Promise((resolve, reject) => { const g = """ + FIRST + """;
  const v = services.cornerstoneViewportService.getCornerstoneViewport(g.viewportId);
  cornerstone.utilities.jumpToSlice(v.element, { imageIndex: index }).then(() => setTimeout(() => {
    v.setProperties({ voiRange: cornerstone.utilities.windowLevel.toLowHighRange(w, l) }); v.setZoom(zoom); v.render(); setTimeout(resolve, 300);
  }, 300), reject); })"""
# Every cell in grid order: its series and image (SOP and place), zoom, window and focal point, and the badge if one is shown.
CELLS = """() => [...services.viewportGridService.getState().viewports.values()].sort((a, b) => a.y - b.y || a.x - b.x).map(g => {
  const v = services.cornerstoneViewportService.getCornerstoneViewport(g.viewportId), id = v?.getCurrentImageId?.(), m = id && cornerstone.metaData.get('instance', id);
  if (!m) return { series: null };
  const r = v.getProperties().voiRange, wl = r ? cornerstone.utilities.windowLevel.toWindowLevel(r.lower, r.upper) : { windowWidth: NaN, windowCenter: NaN };
  return { series: m.SeriesInstanceUID, sop: m.SOPInstanceUID, index: v.getCurrentImageIdIndex(), drawn: v.getCornerstoneImage?.()?.imageId === id,
    zoom: v.getZoom(), focal: [...v.getCamera().focalPoint],
    w: Math.round(wl.windowWidth), l: Math.round(wl.windowCenter), badge: document.querySelector('[data-auto-view-badge]')?.textContent || null }; })"""
# The reader's change of several cells, the first made the active one: per cell [place in grid order, image (null: the one
# shown), window, level, zoom].
CHANGE_CELLS = """changes => new Promise((resolve, reject) => {
  const cells = [...services.viewportGridService.getState().viewports.values()].sort((a, b) => a.y - b.y || a.x - b.x);
  services.viewportGridService.setActiveViewportId(cells[changes[0][0]].viewportId);
  (async () => { for (const [at, index, w, l, zoom] of changes) {
    const v = services.cornerstoneViewportService.getCornerstoneViewport(cells[at].viewportId);
    if (index !== null) { await cornerstone.utilities.jumpToSlice(v.element, { imageIndex: index }); await new Promise(r => setTimeout(r, 300)); }
    v.setProperties({ voiRange: cornerstone.utilities.windowLevel.toLowHighRange(w, l) }); v.setZoom(zoom); v.render();
  } })().then(() => setTimeout(resolve, 300), reject); })"""
ARTIFACTS = Path(__file__).resolve().parent / 'artifacts' / 'auto-save-view-ci'


class AutoSaveViewE2E(ViewerDisplayMenuE2E):
    def setUp(self):
        super().setUp()
        self.addCleanup(cleanup_workspace, self.stack, 'WorkspaceShortcuts')

    def cleanup_fixtures(self):
        # The run's own Jobs and saved views of its own studies go before the studies do (full-row guards, run authors only).
        for uid in list(self.stack.active):
            for raw in psql(f'SELECT to_jsonb(j)::text FROM "ViewerJob" j WHERE "studyUid"={literal(uid)}'):
                job = json.loads(raw)
                self.assertIn(job['authorSub'], self.stack.user_ids.values())
                sql = f'BEGIN; DELETE FROM "ViewerJobRevision" WHERE "jobId"={literal(job["id"])}::uuid; '
                psql(sql + f'DELETE FROM "ViewerJob" j WHERE to_jsonb(j)={literal(raw)}::jsonb; COMMIT;')
            for raw in psql(f'SELECT to_jsonb(v)::text FROM "ViewerAutoView" v WHERE "studyUid"={literal(uid)}'):
                self.assertIn(json.loads(raw)['authorSub'], self.stack.user_ids.values())
                psql(f'DELETE FROM "ViewerAutoView" v WHERE to_jsonb(v)={literal(raw)}::jsonb')
            self.assertEqual(['0', '0'], [psql(f'SELECT count(*) FROM "{t}" WHERE "studyUid"={literal(uid)}')[0] for t in ('ViewerJob', 'ViewerAutoView')])
        super().cleanup_fixtures()

    @staticmethod
    def counting(page, requests, whole=False):
        """Counts this feature's API requests (its scripts are not requests to the server)."""
        def seen(r):
            path = r.url.split('/api', 1)[-1]
            if '/viewer-auto-view' in path and not path.split('?', 1)[0].endswith('.js'):
                requests.append(r.method + ' ' + (r.url if whole else path))
        page.on('request', seen)

    def window(self, p):
        p.get_by_role('button', name='Display ▾').click()
        p.get_by_role('menu', name='Display').get_by_role('menuitem', name='Auto Save View…', exact=True).click()
        panel = p.locator('section.kin-ux-feature-panel[role=dialog][aria-label="Auto Save View"]')
        expect(panel).to_be_visible()
        return panel

    def switch(self, p, on):
        panel = self.window(p)
        box = panel.get_by_label(CHECK)
        if box.is_checked() != on:
            box.check() if on else box.uncheck()
            expect(panel.get_by_role('status')).to_contain_text('On:' if on else 'Off:', timeout=15000)
        panel.get_by_role('button', name='Close').click()

    def saved(self, f):
        r = self.stack.request('GET', f'/studies/{f.uid}/viewer-auto-view', 'doctor')
        self.assertEqual(r.status, 200, r.text)
        return r.body['view']

    def change(self, p, index, w, l, zoom):
        with p.expect_response(lambda r: r.url.endswith('/viewer-auto-view') and r.request.method == 'POST', timeout=20000) as saving:
            p.evaluate(CHANGE, [index, w, l, zoom])
        self.assertEqual(200, saving.value.status)
        self.settle(p)
        return p.evaluate(STATE)

    def reopen(self, p, f):
        """Closes the viewer window and opens the study again, counting this feature's requests from the first one."""
        p.close()
        page = self.login()
        requests = []
        self.counting(page, requests)
        page.goto(self.stack.proxy + '/ohif/viewer?StudyInstanceUIDs=' + f.uid)
        expect(page.get_by_role('button', name='Display ▾')).to_be_visible(timeout=45000)
        return page, requests

    def test_auto_view_01_reopened_with_the_saved_window_zoom_and_image_and_a_badge(self):
        f = self.ct('ASV-' + uuid.uuid4().hex[:12], 'current', '20260801')
        p = self.open_viewer(f)
        self.assertIsNone(self.saved(f))
        self.switch(p, True)
        p.wait_for_timeout(3000)
        self.assertIsNone(self.saved(f), 'nothing is saved before the view changes')
        before = p.evaluate(STATE)
        after = self.change(p, 2, 1500, -600, 2.5)
        print('AUTO-SAVE-VIEW changed ' + json.dumps(dict(before=before, after=after)), flush=True)
        view = self.saved(f)
        self.assertEqual(after['sop'], view['snapshot']['cells'][0]['sop'])
        # The saved view is not a Job.
        jobs = self.stack.request('GET', f'/studies/{f.uid}/viewer-jobs?mine=false&includeHidden=true', 'doctor')
        self.assertEqual((200, []), (jobs.status, jobs.body['jobs']))
        p, requests = self.reopen(p, f)
        p.wait_for_selector('[data-auto-view-badge]', timeout=45000)
        now = p.evaluate(STATE)
        print('AUTO-SAVE-VIEW reopened ' + json.dumps(dict(now=now, requests=requests)), flush=True)
        self.assertEqual((after['sop'], after['index'], after['w'], after['l']), (now['sop'], now['index'], now['w'], now['l']))
        self.assertAlmostEqual(after['zoom'], now['zoom'], places=3)
        self.assertEqual('Restored saved view: Zoom 250%%, W %d / L %d, Image 3' % (after['w'], after['l']), now['badge'])
        # Putting it back saved nothing (the view is the saved one).
        p.wait_for_timeout(3500)
        self.assertEqual(['GET /studies/%s/viewer-auto-view' % f.uid], requests)

    def test_auto_view_02_closed_at_once_still_saved_and_off_opens_the_stock_view(self):
        f = self.ct('ASV-CLOSE-' + uuid.uuid4().hex[:12], 'current', '20260801')
        p = self.open_viewer(f)
        stock = p.evaluate(STATE)
        self.switch(p, True)
        p.wait_for_timeout(1500)
        # A change, and the window closed before the two quiet seconds: the closing window sends it.
        p.evaluate(CHANGE, [3, 400, 40, 2])
        changed = p.evaluate(STATE)
        p.close()
        for _ in range(40):
            view = self.saved(f)
            if view: break
            time.sleep(0.25)
        self.assertIsNotNone(view, 'the closing viewer saved the view')
        self.assertEqual(changed['sop'], view['snapshot']['cells'][0]['sop'])
        # Off: the saved view stays on the server but the viewer neither reads nor applies it.
        p = self.open_viewer(f)
        p.wait_for_selector('[data-auto-view-badge]', timeout=45000)
        self.switch(p, False)
        p, requests = self.reopen(p, f)
        p.wait_for_timeout(5000)
        now = p.evaluate(STATE)
        self.assertEqual((stock['sop'], stock['w'], stock['l'], None), (now['sop'], now['w'], now['l'], now['badge']))
        self.assertEqual([], requests)
        self.assertIsNotNone(self.saved(f), 'a saved view stays until it is discarded')
        # Discard Saved View removes it.
        panel = self.window(p)
        panel.get_by_role('button', name='Discard Saved View').click()
        expect(panel.get_by_role('status')).to_have_text('The saved view of this study was discarded.')
        self.assertIsNone(self.saved(f))

    def test_auto_view_03_a_job_chosen_to_open_wins(self):
        f = self.ct('ASV-JOB-' + uuid.uuid4().hex[:12], 'current', '20260801')
        p = self.open_viewer(f)
        self.switch(p, True)
        p.wait_for_timeout(1500)
        self.change(p, 3, 1500, -600, 2)
        self.assertIsNotNone(self.saved(f))
        # A Job of the first image, saved from the Jobs panel.
        p.evaluate("""() => new Promise(resolve => { const g = """ + FIRST + """, v = services.cornerstoneViewportService.getCornerstoneViewport(g.viewportId);
          cornerstone.utilities.jumpToSlice(v.element, { imageIndex: 0 }).then(() => setTimeout(resolve, 500)); })""")
        self.open_layout_tools(p)
        p.get_by_label('Job Title', exact=True).fill('Auto Save View job')
        p.locator('#kin-viewer-jobs').get_by_role('button', name='Save New Job', exact=True).first.click()
        p.wait_for_function("() => /저장했습니다/.test(document.querySelector('#kin-viewer-jobs-status')?.textContent || '')", timeout=45000)
        jobs = self.stack.request('GET', f'/studies/{f.uid}/viewer-jobs?mine=true&includeHidden=false', 'doctor').body['jobs']
        self.assertEqual(1, len(jobs))
        p.close()
        page = self.login()
        requests = []
        self.counting(page, requests, whole=True)
        page.goto(self.stack.proxy + '/ohif/viewer?StudyInstanceUIDs=' + f.uid + '&kinJob=' + jobs[0]['id'])
        expect(page.get_by_role('button', name='Display ▾')).to_be_visible(timeout=45000)
        page.wait_for_timeout(5000)
        self.assertEqual(['GET ' + self.stack.proxy + '/api/studies/' + f.uid + '/viewer-auto-view'], requests,
                         'the Discard generation is read without applying the saved view')
        now = page.evaluate(STATE)
        self.assertEqual(0, now['index'], 'the chosen Job wins over the automatically saved image')
        self.assertIsNone(now['badge'])
        # The Job on the screen was the starting point, not a change. The reader's own change after it is saved.
        mine = self.change(page, 2, 400, 40, 3)
        self.assertEqual(mine['sop'], self.saved(f)['snapshot']['cells'][0]['sop'], 'saving goes on after the Job has opened')

    def coronal(self, f, label):
        """Two coronal images (the axial CT's own pixels set upright in the x-z plane), one series of the same study."""
        series = None
        for i in range(2):
            ds = self.copy(f, label, 5)
            if series: ds.SeriesInstanceUID = series
            series = str(ds.SeriesInstanceUID); ds.InstanceNumber = i + 1
            ds.ImageOrientationPatient = [1, 0, 0, 0, 0, -1]; ds.ImagePositionPatient = [0, 100 + 10 * i, 120]
            ds.ImageType = ['DERIVED', 'SECONDARY', 'REFORMATTED']
            if 'SliceLocation' in ds: del ds.SliceLocation
            self.put(ds)
        return series

    def test_auto_view_04_series_put_in_another_order_come_back_with_their_zoom_and_window(self):
        # The reader puts the coronal series first and the axial one second, zooms and windows the coronal one on its first
        # image and moves the axial one. On reopen the viewer opens on its own layout, so the saved one is laid out anew: the
        # coronal cell is a new cell whose first image is still coming (held back here) when the saved view goes back. It
        # comes back with its zoom and window, not with the zoom blown down to about 1% (an image like a dot).
        f = self.ct('ASV-ORDER-' + uuid.uuid4().hex[:12], 'current', '20260801')
        coronal = self.coronal(f, 'ASV CORONAL')
        p = self.open_viewer(f)
        self.switch(p, True)
        self.grid(p, 2)
        self.drag(p, 'ASV CORONAL', 0)
        self.drag(p, 'D03A current', 1)
        p.wait_for_function("series => { const c = (" + CELLS + ")(); return c.length === 2 && c[0].series === series && !!c[1].series && c[1].series !== series; }",
                            arg=coronal, timeout=45000)
        p.wait_for_timeout(2500)
        with p.expect_response(lambda r: r.url.endswith('/viewer-auto-view') and r.request.method == 'POST', timeout=20000) as saving:
            p.evaluate(CHANGE_CELLS, [[0, None, 1200, 300, 2.5], [1, 2, 400, 40, 1.5]])
        self.assertEqual(200, saving.value.status)
        p.wait_for_timeout(2500)
        before = p.evaluate(CELLS)
        view = self.saved(f)['snapshot']
        self.assertEqual((1, 2), (view['rows'], view['cols']))
        self.assertEqual([coronal, before[1]['series']], [c['series'] for c in view['cells']])
        self.assertEqual([0, 2], [c['index'] for c in view['cells']])
        self.assertAlmostEqual(2.5, view['cells'][0]['zoom'], places=3)
        # Reopened with the coronal images held back until the saved layout has been laid out anew, then let go.
        p.close()
        page = self.login()
        held = dict(going=False, routes=[])
        page.route(lambda url: '/series/' + coronal + '/' in url and '/frames/' in url,
                   lambda route: route.continue_() if held['going'] else held['routes'].append(route))
        page.goto(self.stack.proxy + '/ohif/viewer?StudyInstanceUIDs=' + f.uid)
        # (The grid answers only once the viewer has started.)
        page.wait_for_function("() => { if (document.querySelector('[data-auto-view-badge]')) return true; try { "
                               "return [...services.viewportGridService.getState().viewports.keys()].some(id => id.startsWith('kin-auto-view-')); } catch (_) { return false; } }",
                               timeout=60000)
        page.wait_for_timeout(1500)
        waiting = page.evaluate(CELLS)
        self.assertTrue(held['routes'], 'the coronal frames were held back')
        self.assertEqual((coronal, False), (waiting[0]['series'], waiting[0]['drawn']), 'the coronal cell has not drawn its image as the saved view goes back')
        held['going'] = True
        for route in held['routes']:
            route.continue_()
        page.wait_for_selector('[data-auto-view-badge]', timeout=60000)
        page.wait_for_timeout(3000)
        now = page.evaluate(CELLS)
        print('AUTO-SAVE-VIEW reordered ' + json.dumps(dict(before=before, now=now, held=len(held['routes']))), flush=True)
        ARTIFACTS.mkdir(parents=True, exist_ok=True)
        page.screenshot(path=str(ARTIFACTS / 'AUTO-SAVE-VIEW-reordered-reopen.png'))
        for i in (0, 1):
            self.assertEqual((before[i]['series'], before[i]['sop'], before[i]['index'], True, before[i]['w'], before[i]['l']),
                             (now[i]['series'], now[i]['sop'], now[i]['index'], now[i]['drawn'], now[i]['w'], now[i]['l']), 'cell %d' % i)
            self.assertAlmostEqual(before[i]['zoom'], now[i]['zoom'], places=3, msg='cell %d' % i)
            for a, b in zip(before[i]['focal'], now[i]['focal']):
                self.assertAlmostEqual(a, b, places=2, msg='cell %d focal point' % i)
        self.assertEqual('Restored saved view: Zoom 250%%, W %d / L %d, Image 1 (2 of 2 cells)' % (before[0]['w'], before[0]['l']), now[0]['badge'])
