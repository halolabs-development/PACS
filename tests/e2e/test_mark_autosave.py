# coding: utf-8
"""Marks saved without the Save button, and saved marks deleted, on the served viewer with owned synthetic CT.

With the account check "Save view changes automatically and apply on reopen" (Display > Auto Save View...) on, a mark is
saved on its own once it is drawn (an Ellipse ROI, a Length), also when the window is closed right after it, and is drawn
again when the study is opened again; a saved Ellipse resized and moved under Edit is saved as a new revision on its own;
a mark drawn while the check was off is saved once it is turned on. A saved mark is deleted from its row's Delete, from the
image's right-click "Delete measurement" and from the Measurements panel's delete: it leaves the image, the list and every
server list, is not drawn again when the study is opened again, and its revisions stay on the server; Hide and Restore
(the panel's own removals) write no delete. A window closed while a handle is held sends nothing of that drag; a closing
the reader cancels sends the request on its way, and a later closing sends a later request; a key image is not saved
while its title is typed; a create whose answer was lost is sent again with the same body and makes one item."""
import math
import re
import sys
import time
import unittest

from playwright.sync_api import expect

from test_measurement_readback import MeasurementReadbackE2E
from workspace_roaming_support import cleanup_workspace
import test_viewer_history as history

CHECK = 'Save view changes automatically and apply on reopen'
PANEL = '#kin-viewer-history'
ME = re.compile(r'/api/me(\?|$)')
# The marks drawn now: [tool, points] per mark of the measuring tools.
MARKS = '''()=>cornerstoneTools.annotation.state.getAllAnnotations().filter(a=>['Length','EllipticalROI'].includes(a.metadata.toolName))
  .map(a=>[a.metadata.toolName,a.data.handles.points])'''
# Canvas points (page coordinates) of a mark's handles, of its middle and of a point on its outline, for the pointer.
WHERE = '''tool=>{const a=cornerstoneTools.annotation.state.getAllAnnotations().find(a=>a.metadata.toolName===tool);
  const v=cornerstone.getRenderingEngines().filter(e=>e.id!=='_thumbnails')[0].getViewports()[0],box=v.element.getBoundingClientRect();
  const page=p=>{const c=v.worldToCanvas(p);return [c[0]+box.x,c[1]+box.y];};
  const handles=a.data.handles.points.map(page),mid=handles.reduce((s,p)=>[s[0]+p[0]/handles.length,s[1]+p[1]/handles.length],[0,0]);
  let outline=null;
  if(tool==='EllipticalROI'){const [b,t,l,r]=handles,rx=Math.abs(r[0]-l[0])/2,ry=Math.abs(b[1]-t[1])/2;outline=[mid[0]+rx*Math.SQRT1_2,mid[1]+ry*Math.SQRT1_2];}
  else outline=[(handles[0][0]+handles[1][0])/2,(handles[0][1]+handles[1][1])/2];
  return {handles,mid,outline};}'''


class MarkAutoSaveE2E(MeasurementReadbackE2E):
    def setUp(self):
        super().setUp()
        # The check is an account setting: put back as it was for the suites after this one.
        self.addCleanup(cleanup_workspace, self.stack, 'WorkspaceShortcuts')

    def observed(self, f):
        hook = history.hook.replace('preRegistration({servicesManager})', 'preRegistration({servicesManager, commandsManager})').replace(
            'window.__d05c1.services=servicesManager.services;', 'window.__d05c1.services=servicesManager.services; window.__d05c1.commands=commandsManager;')
        from unittest.mock import patch
        with patch.object(history, 'hook', hook):
            w, p = self.open_viewer(f, observer=True)
        self.addCleanup(w.close); self.addCleanup(p.close)
        return w, p

    def switch(self, p, on):
        p.get_by_role('button', name='Display ▾').click()
        p.get_by_role('menu', name='Display').get_by_role('menuitem', name='Auto Save View…', exact=True).click()
        panel = p.locator('section.kin-ux-feature-panel[role=dialog][aria-label="Auto Save View"]')
        expect(panel).to_be_visible()
        expect(panel).to_contain_text('Marks (measurements, arrows, text, key images) are saved too as soon as they are drawn or changed')
        box = panel.get_by_label(CHECK)
        if box.is_checked() != on:
            box.check() if on else box.uncheck()
            expect(panel.get_by_role('status')).to_contain_text('On:' if on else 'Off:', timeout=15000)
        panel.get_by_role('button', name='Close').click()
        p.wait_for_function('on=>window.KinViewerAutoSave?.marks?.()===on', arg=on)

    def row(self, p, kind):
        return p.locator(PANEL + ' section[data-kind=' + kind + ']').last

    def ellipse(self, p, fx=.4, fy=.45):
        self.choose(p, 'Ellipse ROI')
        box = p.locator('.cornerstone-canvas').bounding_box()
        x, y = box['x']+box['width']*fx, box['y']+box['height']*fy
        self.drag(p, x, y, 60, 40)
        p.wait_for_function('''()=>cornerstoneTools.annotation.state.getAllAnnotations().some(a=>a.metadata.toolName==='EllipticalROI'
            && !a.invalidated && Object.values(a.data.cachedStats||{}).some(s=>Number.isFinite(s.area)))''')
        return self.row(p, 'ellipse')

    def length(self, p, fx=.4, fy=.7):
        self.choose(p, 'Length')
        box = p.locator('.cornerstone-canvas').bounding_box()
        self.drag(p, box['x']+box['width']*fx, box['y']+box['height']*fy, 70, 20)
        return self.row(p, 'length')

    def revisions(self, f, item):
        r = self.stack.request('GET', '/studies/'+f.uid+'/viewer-items/'+item+'/revisions', 'doctor')
        self.assertEqual(r.status, 200, r.text)
        return [x['action'] for x in r.body['revisions']]

    def until(self, what, timeout=15):
        end = time.monotonic()+timeout
        while True:
            value = what()
            if value or time.monotonic() > end: return value
            time.sleep(.25)

    def hold_me(self, p):
        # This page's /me requests wait until released (each route is kept): a save that asks /me first stays on its way.
        held = []
        p.route(ME, held.append)
        return held

    def release(self, p, held):
        p.unroute(ME)
        while held: held.pop().continue_()

    def test_mark_autosave_01_drawn_marks_are_saved_without_save_and_drawn_on_reopen(self):
        f = self.specimen(); w, p = self.observed(f)
        # Off (the account's first state): a drawn Ellipse stays a row to Save, as before.
        first = self.ellipse(p)
        expect(first).to_contain_text('Ellipse ROI · Unsaved')
        p.wait_for_timeout(1500)
        expect(first).to_contain_text('Ellipse ROI · Unsaved')
        expect(first.get_by_role('button', name='Save', exact=True)).to_be_visible()
        self.assertEqual(self.saved(f), [])
        # On: that mark is saved without its Save button being pressed.
        self.switch(p, True)
        expect(first).to_contain_text('Ellipse ROI · Saved r1', timeout=10000)
        expect(first.get_by_role('button', name='Save', exact=True)).to_have_count(0)
        saved = self.saved(f)
        self.assertEqual([x['item']['kind'] for x in saved], ['ellipse'])
        self.assertEqual(len(saved[0]['item']['baseline']['values']), 5)
        # A Length drawn and the window closed: only the closing window can send it. This panel's /me is held, so an
        # ordinary save that starts before the closing waits there and never reaches the server; the closing does not ask /me.
        held = self.hold_me(p)
        second = self.length(p)
        expect(second).to_contain_text('Length · ')
        drawn = p.evaluate(MARKS)
        p.wait_for_timeout(1200)
        self.assertEqual([x['item']['kind'] for x in self.saved(f)], ['ellipse'], 'nothing of the Length sent before the closing')
        p.close(); w.close()
        saved = self.until(lambda: len(self.saved(f)) == 2 and self.saved(f))
        self.assertTrue(saved, 'the closing viewer saved the Length')
        self.assertEqual(sorted(x['item']['kind'] for x in saved), ['ellipse', 'length'])
        # Opened again: both drawn where they were, each a saved row.
        w, p = self.observed(f)
        p.wait_for_function('()=>cornerstoneTools.annotation.state.getAllAnnotations().filter(a=>["Length","EllipticalROI"].includes(a.metadata.toolName)).length===2')
        self.assertEqual(sorted(map(str, p.evaluate(MARKS))), sorted(map(str, drawn)))
        expect(self.row(p, 'ellipse')).to_contain_text('Saved r1'); expect(self.row(p, 'length')).to_contain_text('Saved r1')

    def test_mark_autosave_02_an_ellipse_resized_and_moved_under_edit_is_saved_on_its_own(self):
        f = self.specimen(); w, p = self.observed(f)
        self.switch(p, True)
        row = self.ellipse(p)
        expect(row).to_contain_text('Saved r1', timeout=10000)
        item = self.saved(f)[0]; before = item['item']['points']
        # Resize: Edit, then the right-hand handle dragged outwards; saved as r2 once the press is released.
        row.get_by_role('button', name='Edit', exact=True).click()
        right = p.evaluate(WHERE, 'EllipticalROI')['handles'][3]
        p.mouse.move(*right); p.mouse.down(); p.mouse.move(right[0]+30, right[1], steps=10)
        p.wait_for_timeout(1200)
        self.assertEqual(self.saved(f)[0]['revision'], 1, 'not saved while the handle is held')
        p.mouse.up()
        expect(row).to_contain_text('Saved r2', timeout=10000)
        resized = self.saved(f)[0]['item']
        self.assertNotEqual(resized['points'], before)
        self.assertGreater(resized['baseline']['values'][0], item['item']['baseline']['values'][0], 'a larger area')
        # Move: Edit, then the outline dragged; every point moves by the same step; saved as r3.
        row.get_by_role('button', name='Edit', exact=True).click()
        outline = p.evaluate(WHERE, 'EllipticalROI')['outline']
        p.mouse.move(*outline); p.mouse.down(); p.mouse.move(outline[0]+25, outline[1]+15, steps=10); p.mouse.up()
        expect(row).to_contain_text('Saved r3', timeout=10000)
        moved = self.saved(f)[0]['item']
        shift = [[a-b for a, b in zip(m, r)] for m, r in zip(moved['points'], resized['points'])]
        self.assertTrue(all(math.dist(s, shift[0]) < 1e-6 for s in shift) and math.hypot(*shift[0]) > 0, shift)
        self.assertAlmostEqual(moved['baseline']['values'][0], resized['baseline']['values'][0], places=3)
        self.assertEqual(self.revisions(f, item['id']), ['create', 'edit', 'edit'])
        # Edit pressed and nothing changed: no revision.
        row.get_by_role('button', name='Edit', exact=True).click()
        p.wait_for_timeout(1500)
        self.assertEqual(self.revisions(f, item['id']), ['create', 'edit', 'edit'])

    def test_mark_autosave_03_a_saved_mark_is_deleted_from_its_row_the_image_menu_and_the_panel(self):
        f = self.specimen(); w, p = self.observed(f)
        self.switch(p, True)
        for i, fy in enumerate((.3, .5, .7)):
            self.length(p, .35, fy)
            if i == 0:
                # The viewer's own question whether to track this series' measurements (its Measurements panel lists them).
                yes = p.get_by_role('button', name='Yes', exact=True)
                expect(yes).to_be_visible(); yes.click()
            expect(p.locator(PANEL + ' section[data-kind=length]').nth(i)).to_contain_text('Saved r1', timeout=10000)
        items = {x['id']: x for x in self.saved(f)}
        self.assertEqual(len(items), 3)
        rows = p.locator(PANEL + ' section[data-kind=length]')
        target = rows.first.get_attribute('data-item-id')
        first = p.locator(PANEL + ' section[data-item-id="' + target + '"]')
        # The panel's own removals are not deletes: Hide takes the mark off the image (a revision "hide", no "delete"),
        # Restore draws it again.
        p.once('dialog', lambda d: d.accept('합성 숨김'))
        first.get_by_role('button', name='Hide', exact=True).click()
        expect(first).to_contain_text('Saved r2 · Hidden')
        expect(p.locator(PANEL + ' section[data-kind=length]')).to_have_count(3)
        self.assertEqual(len(p.evaluate(MARKS)), 2)
        p.once('dialog', lambda d: d.accept('합성 복원'))
        first.get_by_role('button', name='Restore', exact=True).click()
        expect(first).to_contain_text('Saved r3')
        p.wait_for_function('()=>cornerstoneTools.annotation.state.getAllAnnotations().filter(a=>a.metadata.toolName==="Length").length===3')
        self.assertEqual(self.revisions(f, target), ['create', 'hide', 'restore'])
        self.assertEqual(len(self.saved(f)), 3)
        # 1. The row's Delete, after its question.
        questions = []
        p.once('dialog', lambda d: (questions.append(d.message), d.accept()))
        first.get_by_role('button', name='Delete', exact=True).click()
        expect(first).to_have_count(0)
        self.assertIn('저장 이력은 서버에 남습니다', questions[0])
        expect(p.locator(PANEL + ' > [role=status]')).to_contain_text('항목을 지웠습니다')
        # 2. The image's right-click "Delete measurement" on a saved Length.
        uid = p.evaluate('''()=>cornerstoneTools.annotation.state.getAllAnnotations().find(a=>a.metadata.toolName==='Length').annotationUID''')
        at = p.evaluate('''uid=>{const a=cornerstoneTools.annotation.state.getAnnotation(uid);
            const v=cornerstone.getRenderingEngines().filter(e=>e.id!=='_thumbnails')[0].getViewports()[0],box=v.element.getBoundingClientRect();
            const [p0,p1]=a.data.handles.points.map(p=>v.worldToCanvas(p));return [(p0[0]+p1[0])/2+box.x,(p0[1]+p1[1])/2+box.y];}''', uid)
        p.mouse.click(at[0], at[1], button='right')
        menu = p.get_by_text('Delete measurement', exact=True)
        expect(menu).to_be_visible()
        p.once('dialog', lambda d: d.accept())
        menu.click()
        p.wait_for_function('uid=>!cornerstoneTools.annotation.state.getAnnotation(uid)', arg=uid)
        p.wait_for_timeout(800)
        self.assertEqual(p.evaluate('uid=>!!cornerstoneTools.annotation.state.getAnnotation(uid)', uid), False, 'not drawn again')
        # 3. The viewer's Measurements panel: its row's Actions › Delete.
        p.locator('[data-cy=trackedMeasurements-btn]').click()
        listed = p.locator('[data-cy=trackedMeasurements-panel] [data-cy=data-row]')
        expect(listed).to_have_count(1)
        listed.hover()
        listed.get_by_role('button', name='Actions').click()
        p.once('dialog', lambda d: d.accept())
        p.get_by_role('menuitem', name='Delete').click()
        expect(rows).to_have_count(0)
        expect(listed).to_have_count(0)
        p.wait_for_timeout(800)
        self.assertEqual(p.evaluate(MARKS), [], 'none drawn again')
        # The server: no list has them; every revision stays.
        self.assertEqual(self.saved(f), [])
        for item in items:
            self.assertEqual(self.revisions(f, item), ['create', 'hide', 'restore', 'delete'] if item == target else ['create', 'delete'])
        # Opened again: nothing drawn, no row.
        p.close(); w.close()
        w, p = self.observed(f)
        p.wait_for_timeout(1500)
        self.assertEqual(p.evaluate(MARKS), [])
        expect(p.locator(PANEL + ' section[data-kind]')).to_have_count(0)

    def test_mark_autosave_04_closing_typing_and_a_lost_answer(self):
        f = self.specimen(); w, p = self.observed(f)
        self.switch(p, True)
        # A key image: not saved while its title is being typed, saved once the field is left.
        p.get_by_role('button', name='Add Key Image', exact=True).click()
        key = self.row(p, 'key')
        title = key.get_by_label('Key Title')
        expect(title).to_be_focused()
        title.fill('자동 저장 키')
        p.wait_for_timeout(1500)
        self.assertEqual(self.saved(f), [], 'not saved while typing')
        title.blur()
        expect(key).to_contain_text('Saved r1', timeout=10000)
        self.assertEqual([(x['item']['kind'], x['item']['title']) for x in self.saved(f)], [('key', '자동 저장 키')])
        # A lost answer: the request reached the server, its answer did not; the same request goes again on its own and
        # the server answers it once — one item.
        bodies = []
        def lost(route):
            if route.request.method != 'POST': route.continue_(); return
            bodies.append(route.request.post_data)
            if len(bodies) == 1: route.fetch(); route.abort('failed')
            else: route.continue_()
        p.route('**/viewer-items', lost)
        row = self.ellipse(p)
        expect(row).to_contain_text('Saved r1', timeout=20000)
        p.unroute('**/viewer-items')
        self.assertEqual(len(bodies), 2); self.assertEqual(bodies[0], bodies[1])
        ellipses = [x for x in self.saved(f) if x['item']['kind'] == 'ellipse']
        self.assertEqual(len(ellipses), 1)
        item = ellipses[0]['id']; points = ellipses[0]['item']['points']
        # The window closed while a handle is held under Edit: the half-done change is not sent.
        row.get_by_role('button', name='Edit', exact=True).click()
        right = p.evaluate(WHERE, 'EllipticalROI')['handles'][3]
        p.mouse.move(*right); p.mouse.down(); p.mouse.move(right[0]+30, right[1], steps=10)
        p.wait_for_timeout(800)
        p.close(); w.close()
        time.sleep(3)
        self.assertEqual(self.revisions(f, item), ['create'], 'nothing saved mid-drag')
        # Opened again; under Edit the outline is moved while /me is held, so its save waits on its way.
        w, p = self.observed(f)
        row = self.row(p, 'ellipse')
        expect(row).to_contain_text('Saved r1')
        self.assertEqual(p.evaluate(MARKS)[0][1], points)
        held = self.hold_me(p)
        row.get_by_role('button', name='Edit', exact=True).click()
        outline = p.evaluate(WHERE, 'EllipticalROI')['outline']
        p.mouse.move(*outline); p.mouse.down(); p.mouse.move(outline[0]+20, outline[1]+10, steps=10); p.mouse.up()
        p.wait_for_timeout(1500)
        self.assertTrue(held, 'the save is waiting for its /me')
        self.assertEqual(self.revisions(f, item), ['create'])
        # A closing the reader cancels: the leave question is asked, the request on its way is sent at that moment.
        asked = []
        p.once('dialog', lambda d: (asked.append(d.type), d.dismiss()))
        p.close(run_before_unload=True)
        self.assertTrue(self.until(lambda: self.revisions(f, item) == ['create', 'edit']), self.revisions(f, item))
        p.wait_for_timeout(500)
        self.assertEqual(asked, ['beforeunload'])
        # The window stays; its own request answers the same revision.
        self.release(p, held)
        expect(row).to_contain_text('Saved r2', timeout=10000)
        # Moved again with /me held, then the window really closes: this later request is sent by the closing too.
        held = self.hold_me(p)
        row.get_by_role('button', name='Edit', exact=True).click()
        outline = p.evaluate(WHERE, 'EllipticalROI')['outline']
        p.mouse.move(*outline); p.mouse.down(); p.mouse.move(outline[0]+15, outline[1]-10, steps=10); p.mouse.up()
        p.wait_for_timeout(1500)
        self.assertTrue(held)
        self.assertEqual(self.revisions(f, item), ['create', 'edit'])
        p.close(); w.close()
        self.assertTrue(self.until(lambda: self.revisions(f, item) == ['create', 'edit', 'edit']), self.revisions(f, item))


if __name__ == '__main__':
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    suite = unittest.TestSuite(MarkAutoSaveE2E(name) for name in [
        'test_mark_autosave_01_drawn_marks_are_saved_without_save_and_drawn_on_reopen',
        'test_mark_autosave_02_an_ellipse_resized_and_moved_under_edit_is_saved_on_its_own',
        'test_mark_autosave_03_a_saved_mark_is_deleted_from_its_row_the_image_menu_and_the_panel',
        'test_mark_autosave_04_closing_typing_and_a_lost_answer'])
    sys.exit(not unittest.TextTestRunner(verbosity=2).run(suite).wasSuccessful())
