# coding: utf-8
"""Merge Exam · Split / Unmerge on the served stack, with run-unique synthetic studies of one synthetic patient.

  - three studies of one patient: Merge Exam in the Technician window (the same patient's same-day studies ticked, the
    selected study as Base) → the list shows the base row only, with `Merged ×3` and the Count of all three; the
    radiologist's viewer opens the three studies as one (one window, all three studies' images, no compare layout);
    a report saved on the merged exam carries the group; a merged study refuses a hold of its own (409 STUDY_MERGED);
    Split / Unmerge (before approval) restores the three rows; the saved report keeps its group and can only be Reset;
  - two studies merged, an image arriving later for the second: the merged exam counts it while merged and the second
    study keeps it after Unmerge; with the merged exam approved, Unmerge is refused in the window and by the server, and
    after Reset to Unread it goes through.

Run in CI: `python tests/measurement_ci.py --profile exam-merge`; on a development stack: `python tests/e2e/test_exam_merge.py`.
Synthetic only; the cleanup removes the groups this run wrote (the study fixtures' own cleanup removes the studies).
"""
import io
import json
import re
import subprocess
import sys
import unittest
import uuid
from types import SimpleNamespace
from pydicom import dcmread
from urllib.parse import parse_qs, urlsplit

from playwright.sync_api import expect

from invariants_live import drop_viewer_rows
from test_worklist import ROOT, WorklistE2E, psql


def lit(value):
    return "'" + str(value).replace("'", "''") + "'"


class ExamMergeE2E(WorklistE2E):
    def patient(self, count):
        patient = "SYN-MERGE-" + uuid.uuid4().hex[:12]
        fixtures = [self.fixture(patient_id=patient) for _ in range(count)]
        uids = ",".join(lit(f.uid) for f in fixtures)

        def cleanup():
            groups = psql(f'SELECT DISTINCT "groupId" FROM "StudyGroupMember" WHERE "studyUid" IN ({uids})')
            if groups:
                ids = ",".join(lit(g) for g in groups)
                logical = psql(f'SELECT "logicalUid" FROM "StudyGroupMember" WHERE "groupId" IN ({ids}) AND "logicalUid" <> "studyUid"')
                # This connection only cleans the test's synthetic groups after their assertions; production membership is immutable.
                psql(f'BEGIN; SET LOCAL session_replication_role=replica; '
                     f'DELETE FROM "StudyGroupMember" WHERE "groupId" IN ({ids}); DELETE FROM "StudyGroup" WHERE id IN ({ids}); COMMIT;')
                for uid in logical:
                    self.stack.cleanup_fixture(uid)
            psql(f'UPDATE "Report" SET "groupId"=NULL WHERE uid IN ({uids}); UPDATE "ReportVersion" SET "groupId"=NULL WHERE uid IN ({uids});')
        # Registered after the fixtures: runs before their own cleanup.
        self.addCleanup(cleanup)
        return patient, fixtures

    def technician(self, fixture):
        page = self.login("tech")
        page.locator("[data-tab=Technician]").click()
        self.select(page, fixture)
        page.wait_for_function(f"() => selectedUid === {json.dumps(fixture.uid)}")
        return page

    def rows(self, page):
        return page.eval_on_selector_all("#rows tr[data-uid]", "rows => rows.map(r => r.dataset.uid)")

    def listed(self, actor="doctor"):
        result = self.stack.request("GET", "/studies", actor)
        self.assertEqual(result.status, 200, result.text)
        return {row["uid"]: row for row in result.body["studies"]}

    def merge_in_window(self, page, base, others):
        page.locator("#t-merge-exam").click()
        w = page.locator("dialog[data-exam-window='merge']")
        for f in [base, *others]:
            expect(w.locator(f"tbody tr[data-uid='{f.uid}'] input[type=checkbox]")).to_be_checked()
        expect(w.locator(f"tbody tr[data-uid='{base.uid}'] input[type=radio]")).to_be_checked()
        expect(w.locator(".exam-merge-result")).to_contain_text("결과: 검사 1건 (기준 ")
        expect(w.locator(".exam-merge-result")).to_contain_text(f"원래 검사 {1 + len(others)}건의 묶음은 기록으로 남아")
        w.get_by_role("button", name="Merge", exact=True).click()
        expect(w).to_contain_text(f"합쳤습니다: 검사 {1 + len(others)}건", timeout=30000)
        w.get_by_role("button", name="Close").click()
        expect(page.locator(f"#rows tr[data-uid='{base.uid}'] .exam-merged")).to_have_text(re.compile(rf"^Merged ×{1 + len(others)} · "), timeout=30000)

    def unmerge_window(self, page, base):
        page.locator(f"#rows tr[data-uid='{base.uid}']").click()
        page.wait_for_function(f"() => selectedUid === {json.dumps(base.uid)}")
        page.locator("#t-split-unmerge").click()
        w = page.locator("dialog[data-exam-window='unmerge']")
        expect(w.locator(".exam-merge-checks li")).to_have_count(3, timeout=30000)
        return w


    def add_series(self, patient, uid):
        sent = subprocess.run([sys.executable, str(ROOT / "scripts/send_cstore.py"), "--institution", "한림병원",
            "--name", "SYNTHETIC^EXAM", "--id", patient, "--slices", "1", "--study-uid", uid],
            cwd=ROOT, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=120)
        self.assertEqual(sent.returncode, 0, sent.stdout + sent.stderr)

    def rendered(self, viewer, study, series=None):
        viewer.wait_for_function("s => typeof services === 'object' && services.displaySetService.getActiveDisplaySets().some(d => d.StudyInstanceUID===s[0] && (!s[1] || d.SeriesInstanceUID===s[1]))", arg=[study, series], timeout=60000)
        viewer.evaluate("""async ([study,series]) => {
          const ds=services.displaySetService.getActiveDisplaySets().find(d=>d.StudyInstanceUID===study&&(!series||d.SeriesInstanceUID===series));
          const grid=services.viewportGridService,state=grid.getState(),id=state.activeViewportId||[...state.viewports.keys()][0];
          await grid.setDisplaySetsForViewport({viewportId:id,displaySetInstanceUIDs:[ds.displaySetInstanceUID]});
        }""", [study, series])
        viewer.wait_for_function("""([study,series]) => [...services.viewportGridService.getState().viewports.keys()].some(id=>{
          const v=services.cornerstoneViewportService.getCornerstoneViewport(id),image=v?.getCurrentImageId?.();
          const meta=image&&cornerstone.metaData.get('instance',image),canvas=v?.getCanvas?.();
          return v?.viewportStatus==='rendered'&&v.csImage?.imageId===image&&!v.stackInvalidated&&canvas?.width>0&&canvas?.height>0&&meta?.StudyInstanceUID===study&&(!series||meta.SeriesInstanceUID===series);
        })""", arg=[study, series], timeout=60000)

    def test_exam_merge_01_three_studies_one_exam_viewer_report_unmerge(self):
        patient, (a, b, c) = self.patient(3)
        page = self.technician(a)
        self.merge_in_window(page, a, [b, c])
        rows = self.rows(page)
        self.assertIn(a.uid, rows)
        self.assertNotIn(b.uid, rows)
        self.assertNotIn(c.uid, rows)
        listed = self.listed()
        base = listed[a.uid]
        self.assertNotIn(b.uid, listed)
        members = [m["uid"] for m in base["group"]["members"]]
        self.assertEqual(members[0], a.uid)
        self.assertCountEqual(members, [a.uid, b.uid, c.uid])
        self.assertEqual(base["count"], sum(m["count"] for m in base["group"]["members"]))
        [group] = psql(f'SELECT id FROM "StudyGroup" WHERE "baseUid"={lit(a.uid)} AND "dissolvedAt" IS NULL')
        [audit] = psql(f'SELECT detail FROM "AuditLog" WHERE action=\'study.merge\' AND target={lit(a.uid)} ORDER BY id DESC LIMIT 1')
        self.assertEqual(json.loads(audit)["studies"], members)

        # The radiologist's viewer opens the three studies as one current study.
        reader = self.login()
        row = self.select(reader, a)
        with reader.context.expect_page(timeout=20000) as opened:
            row.dblclick()
        viewer = opened.value
        viewer.wait_for_url("**/ohif/viewer?**", timeout=30000)
        query = parse_qs(urlsplit(viewer.url).query)
        self.assertEqual(query["StudyInstanceUIDs"], [",".join(members)])
        self.assertIsNone(query.get("hangingProtocolId"))
        self.assertEqual(query.get("kinExam"), ["merged"])
        viewer.wait_for_function("u => typeof services === 'object' && u.every(x => services.displaySetService.getActiveDisplaySets()"
                                 ".some(d => d.StudyInstanceUID === x))", arg=[a.uid, b.uid, c.uid], timeout=60000)
        for fixture in (a, b, c):
            self.rendered(viewer, fixture.uid)
            # Every original is the current exam: its cell is labelled as the current exam, never as a comparison.
            viewer.wait_for_function("u => [...document.querySelectorAll('.kin-viewer-identity')].some(e => e.dataset.study === u && e.dataset.role === 'current')",
                                     arg=fixture.uid, timeout=30000)
            self.assertEqual(viewer.evaluate("u => KinViewerExamScope.role(u)", fixture.uid), "current")
        # The exam's scope was admitted: no scope error and no Retry Patient on the patient row.
        self.assertIsNotNone(viewer.evaluate("() => KinViewerExamScope.snapshot()"))
        expect(viewer.get_by_role("button", name="Retry Patient", exact=True)).to_be_hidden()
        expect(viewer.get_by_text("영상 범위 공급을 연결하지 못했습니다.")).to_have_count(0)
        # One series list for the exam: the series of all three originals.
        expect(viewer.locator(".kin-viewer-series-strip .kin-series-card")).to_have_count(base["series"], timeout=30000)
        # Each card opens its own original: the second original's card puts that original in the active cell.
        self.rendered(viewer, a.uid)
        viewer.locator(f".kin-viewer-series-strip .kin-series-card[data-study='{b.uid}']").first.click()
        viewer.wait_for_function("""u => { const id = services.viewportGridService.getState().activeViewportId, v = services.cornerstoneViewportService.getCornerstoneViewport(id),
          image = v?.getCurrentImageId?.(), meta = image && cornerstone.metaData.get('instance', image); return v?.viewportStatus === 'rendered' && meta?.StudyInstanceUID === u; }""",
                                 arg=b.uid, timeout=60000)
        viewer.close()

        # A report saved on the merged exam carries the group; a merged study has no report of its own while merged.
        self.seed_report(a, action="save", findings="SYNTHETIC MERGED FINDINGS")
        self.assertEqual(psql(f'SELECT "groupId" FROM "Report" WHERE uid={lit(a.uid)}'), [group])
        held = self.stack.request("POST", f"/studies/{b.uid}/hold", "doctor", {})
        self.assertEqual(held.status, 409, held.text)
        self.assertEqual(held.body["code"], "STUDY_MERGED")
        self.assertEqual(held.body["baseUid"], a.uid)

        # Unmerge before approval: allowed; the three studies are listed again.
        page.reload()
        page.locator("[data-tab=Technician]").click()
        self.select(page, a)
        w = self.unmerge_window(page, a)
        expect(w.locator(".exam-merge-checks li").first).to_have_text("✓ 합친 검사에 지금 승인된 판독문이 없습니다.")
        w.get_by_role("button", name="Unmerge", exact=True).click()
        expect(w).to_contain_text("되돌렸습니다.", timeout=30000)
        w.get_by_role("button", name="Close").click()
        listed = self.listed()
        for f in (a, b, c):
            self.assertIn(f.uid, listed)
            self.assertNotIn("group", listed[f.uid])
        self.assertEqual(psql(f'SELECT count(*) FROM "StudyGroup" WHERE id={lit(group)} AND "dissolvedAt" IS NOT NULL'), ["1"])
        # After Unmerge the base study opens on its own again (no exam scope, its own UID only).
        reader.reload()
        with reader.context.expect_page(timeout=20000) as opened:
            self.select(reader, a).dblclick()
        viewer = opened.value
        viewer.wait_for_url("**/ohif/viewer?**", timeout=30000)
        query = parse_qs(urlsplit(viewer.url).query)
        self.assertEqual(query["StudyInstanceUIDs"], [a.uid])
        # A study with a grouping history opens on a reference the server attests holds it alone (no group).
        self.assertIsNone(query.get("kinExam"))
        scopes = json.loads(query["kinExamScopes"][0]) if query.get("kinExamScopes") else None
        self.assertTrue(scopes is None or (scopes["current"]["groupId"] is None and scopes["prior"] is None), scopes)
        self.rendered(viewer, a.uid)
        viewer.close()
        # The saved report keeps the exam it was written on; it is not approved as the base study's alone — Reset goes on.
        self.assertEqual(psql(f'SELECT "groupId" FROM "Report" WHERE uid={lit(a.uid)}'), [group])
        # The list row and the history say which studies the report was written on, now that they are unmerged.
        self.assertEqual(listed[a.uid]["reportGroup"], {"id": group, "active": False, "readable": True, "studies": members})
        head = self.versions(a)[-1]
        stored = self.stack.request("GET", f"/studies/{a.uid}/exam-scope?purpose=stored&version={head['version']}", "doctor")
        self.assertEqual(stored.status, 200, stored.text)
        self.assertEqual(head["group"], {"id": group, "active": False, "readable": True,
            "studies": members, "part": None,
            "sources": [{"studyUid": uid, "series": {"mode": "all", "uids": []}} for uid in members],
            "generation": stored.body["generation"]})
        version = head["version"]
        refused = self.stack.request("POST", f"/studies/{a.uid}/report/commit", "doctor", {
            "action": "approve", "baseVersion": version, "findings": "SYNTHETIC MERGED FINDINGS", "conclusion": "", "recommendation": ""})
        self.assertEqual(refused.status, 409, refused.text)
        self.assertEqual(refused.body["code"], "EXAM_SCOPE_CHANGED")

    def test_exam_merge_02_late_image_and_approved_refusal(self):
        patient, (a, b) = self.patient(2)
        merged = self.stack.request("POST", "/exam-groups", "tech", {"baseUid": a.uid, "uids": [a.uid, b.uid]})
        self.assertEqual(merged.status, 200, merged.text)
        before = self.listed()[a.uid]["count"]
        # An image of the second study arrives after the merge: it is the merged exam's while merged.
        sent = subprocess.run([sys.executable, str(ROOT / "scripts" / "send_cstore.py"), "--institution", "한림병원",
                               "--name", "SYNTHETIC^LATE", "--id", patient, "--slices", "1", "--study-uid", b.uid,
                               "--instance-offset", "1"], cwd=ROOT, capture_output=True, text=True, encoding="utf-8",
                              errors="replace", timeout=120)
        self.assertEqual(sent.returncode, 0, sent.stdout + sent.stderr)
        page = self.technician(a)
        row = None
        for _ in range(80):
            row = self.listed()[a.uid]
            if row["count"] == before + 1:
                break
            page.wait_for_timeout(250)
        self.assertEqual(row["count"], before + 1)
        # Approved now: Unmerge is refused in the window and by the server.
        self.seed_report(a, action="approve", findings="SYNTHETIC APPROVED MERGED")
        page.reload()
        page.locator("[data-tab=Technician]").click()
        self.select(page, a)
        w = self.unmerge_window(page, a)
        expect(w.locator(".exam-merge-checks li").first).to_contain_text("✗ 승인된 판독문이 있습니다. 먼저 판독 취소(Reset)를 하세요.")
        expect(w.get_by_role("button", name="Unmerge", exact=True)).to_be_disabled()
        w.get_by_role("button", name="Close").click()
        group = merged.body["group"]["id"]
        refused = self.stack.request("POST", f"/exam-groups/{group}/dissolve", "tech", {})
        self.assertEqual(refused.status, 409, refused.text)
        self.assertEqual(refused.body["code"], "EXAM_GROUP_REFUSED")
        # Reset to Unread (the approved text kept in the history with its group), then Unmerge goes through.
        version = self.versions(a)[-1]["version"]
        reset = self.stack.request("POST", f"/studies/{a.uid}/report/commit", "doctor", {
            "action": "reset", "baseVersion": version, "reason": "SYNTHETIC unmerge", "findings": "", "conclusion": "",
            "recommendation": ""})
        self.assertEqual(reset.status, 201, reset.text)
        self.assertEqual(psql(f'SELECT "groupId" FROM "ReportVersion" WHERE uid={lit(a.uid)} AND action=\'discarded\''), [group])
        done = self.stack.request("POST", f"/exam-groups/{group}/dissolve", "tech", {})
        self.assertEqual(done.status, 200, done.text)
        listed = self.listed()
        # The late image stayed with its own study.
        self.assertEqual(listed[a.uid]["count"] + listed[b.uid]["count"], before + 1)
        self.assertNotIn("group", listed[a.uid])


    def test_exam_merge_03_split_second_viewer_report_late_series_unsplit(self):
        patient, (a,) = self.patient(1)
        self.add_series(patient, a.uid)
        page = self.technician(a)
        page.locator('#t-split-unmerge').click()
        dialog = page.locator("dialog[data-exam-window='unmerge']")
        expect(dialog.locator('tbody input[type=checkbox]')).to_have_count(2, timeout=30000)
        dialog.locator('tbody input[type=checkbox]').last.check()
        dialog.get_by_role('button', name='Split', exact=True).click()
        expect(dialog).to_contain_text('나눴습니다', timeout=30000)
        dialog.get_by_role('button', name='Close', exact=True).click()
        rows = self.listed()
        second = next(row for row in rows.values() if row.get('examScope', {}).get('part') == 1 and
                      row['examScope']['sources'][0]['studyUid'] == a.uid)
        second_uid, scope = second['uid'], second['examScope']
        selected = scope['sources'][0]['series']['uids']
        self.assertEqual(len(selected), 1)
        reader = self.login()
        target = SimpleNamespace(uid=second_uid, patient_id=patient, secret='SYNTHETIC SECOND REPORT')
        row = self.select(reader, target)
        with reader.context.expect_page(timeout=20000) as opened:
            row.dblclick()
        viewer = opened.value
        viewer.wait_for_url('**/ohif/viewer?**', timeout=30000)
        self.rendered(viewer, a.uid, selected[0])
        visible = viewer.evaluate("() => services.displaySetService.getActiveDisplaySets().map(d=>d.SeriesInstanceUID)")
        self.assertTrue(visible)
        self.assertEqual(set(visible), set(selected))
        viewer.reload()
        self.rendered(viewer, a.uid, selected[0])
        self.seed_report(target)
        before = self.listed()
        self.add_series(patient, a.uid)
        # The late series is counted through the signed-in list request (a bare page fetch carries no session header).
        late = None
        for _ in range(120):
            late = self.listed().get(a.uid)
            if late and late['series'] == 2:
                break
            reader.wait_for_timeout(250)
        self.assertEqual(late['series'], 2)
        after = self.listed()
        self.assertEqual(after[second_uid]['count'], before[second_uid]['count'])
        self.assertEqual(after[a.uid]['count'], before[a.uid]['count'] + 1)
        group = scope['groupId']
        dissolved = self.stack.request('POST', f'/exam-groups/{group}/dissolve', 'tech', {})
        self.assertEqual(dissolved.status, 200, dissolved.text)
        viewer.wait_for_function("() => document.documentElement.classList.contains('kin-exam-unverified')", timeout=15000)
        self.assertIsNone(viewer.evaluate('() => KinViewerExamScope.snapshot()'))
        viewer.close()
        after = self.listed()
        self.assertNotIn(second_uid, after)
        links = after[a.uid]['relatedExamReports']
        link = next(link for link in links if link['uid'] == second_uid)
        self.assertEqual(link['scope']['sources'][0]['series']['uids'], selected)
        reader.reload()
        self.select(reader, a)
        reader.get_by_role('button', name=re.compile(r'Related Report · Exam 2')).click()
        expect(reader.locator('#hist-body')).to_contain_text('SYNTHETIC SECOND REPORT', timeout=30000)

    def test_exam_merge_04_original_loss_and_patient_change_refuse_scope(self):
        patient, (a, b) = self.patient(2)
        merged = self.stack.request('POST', '/exam-groups', 'tech', {'baseUid': a.uid, 'uids': [a.uid, b.uid]})
        self.assertEqual(merged.status, 200, merged.text)
        group = merged.body['group']['id']
        original = self.stack.first_instance_id(b.uid)
        path = '/instances/' + original
        raw = self.stack.orthanc_bytes(path + '/file')
        ds = dcmread(io.BytesIO(raw))
        self.assertEqual(str(ds.StudyInstanceUID), b.uid)
        self.assertEqual(str(ds.PatientID), patient)
        self.assertIn(b.uid, self.stack.active)
        # Both mutations operate only on the run-owned original and restore its exact bytes.
        self.assertEqual(self.stack._orthanc_request('DELETE', path).status, 200)
        try:
            absent = self.stack.request('GET', f'/studies/{a.uid}/exam-scope', 'doctor')
            self.assertIn(absent.status, (404, 409), absent.text)
            # The list does not pass the merged exam off as an ordinary row, and names nothing of the lost original.
            row = self.listed()[a.uid]
            self.assertEqual((row.get('examUnavailable'), row.get('examUnavailableKind')), (True, 'merge'))
            self.assertNotIn('examScope', row)
            self.assertNotIn(b.uid, json.dumps(row))
            ds.PatientID = patient + '-CHANGED'
            changed = io.BytesIO(); ds.save_as(changed, write_like_original=False)
            self.assertEqual(self.stack._orthanc_request('POST', '/instances', changed.getvalue()).status, 200)
            identity = self.stack.request('GET', f'/studies/{a.uid}/exam-scope', 'doctor')
            self.assertEqual(identity.status, 409, identity.text)
            self.assertEqual(identity.body['code'], 'EXAM_SCOPE_CHANGED')
            refused = self.stack.request('POST', f'/studies/{a.uid}/report/commit', 'doctor', {
                'action': 'save', 'baseVersion': 0, 'findings': 'MUST NOT SAVE', 'conclusion': '', 'recommendation': ''})
            self.assertIn(refused.status, (404, 409), refused.text)
            self.assertEqual(psql(f'SELECT count(*) FROM "ReportVersion" WHERE uid={lit(a.uid)}'), ['0'])
            done = self.stack.request('POST', f'/exam-groups/{group}/dissolve', 'tech', {})
            self.assertEqual(done.status, 200, done.text)
        finally:
            lookup = self.stack._orthanc_request('POST', '/tools/lookup', str(ds.SOPInstanceUID).encode('ascii'))
            self.assertEqual(lookup.status, 200)
            for current in lookup.body:
                if current.get('Type') != 'Instance':
                    continue
                detail = dcmread(io.BytesIO(self.stack.orthanc_bytes('/instances/' + current['ID'] + '/file')))
                self.assertEqual(str(detail.StudyInstanceUID), b.uid)
                self.assertEqual(self.stack._orthanc_request('DELETE', '/instances/' + current['ID']).status, 200)
            self.assertEqual(self.stack._orthanc_request('POST', '/instances', raw).status, 200)

    def series_instances(self, uid):
        """Every instance of a synthetic original, by series: {seriesUid: [dataset, ...]} in instance order."""
        found = self.stack._orthanc_request('POST', '/tools/lookup', uid.encode())
        study = next(x['ID'] for x in found.body if x['Type'] == 'Study')
        out = {}
        for i in self.stack._orthanc_request('GET', '/studies/' + study + '/instances').body:
            ds = dcmread(io.BytesIO(self.stack.orthanc_bytes('/instances/' + i['ID'] + '/file')))
            out.setdefault(str(ds.SeriesInstanceUID), []).append(ds)
        return {k: sorted(v, key=lambda d: int(d.InstanceNumber)) for k, v in out.items()}

    def length_on(self, uid, ds, extent=20):
        """A saved Length on one image of an original, as the viewer saves it (marks stay on the original UID)."""
        ipp = [float(x) for x in ds.ImagePositionPatient]
        r = self.stack.request('POST', f'/studies/{uid}/viewer-items', 'doctor', dict(requestId=str(uuid.uuid4()), item=dict(
            schemaVersion=1, kind='length', seriesUid=str(ds.SeriesInstanceUID), sopUid=str(ds.SOPInstanceUID), frame=1,
            frameOfReferenceUid=str(ds.FrameOfReferenceUID), label='길이', points=[[ipp[0]+10, ipp[1]+10, ipp[2]], [ipp[0]+10+extent, ipp[1]+10, ipp[2]]],
            viewPlaneNormal=[0, 0, 1], viewUp=[0, 1, 0], baseline=dict(calculator='kin-native-manual-v1', values=[float(extent)]))))
        self.assertEqual(r.status, 200, r.text)
        return r.body

    def finding_on(self, reading, item, title, status=200):
        r = self.stack.request('POST', f'/studies/{reading}/findings', 'doctor', dict(requestId=str(uuid.uuid4()), item=dict(
            schemaVersion=1, title=title, text='', primary=0,
            sources=[dict(itemId=item['id'], revision=item['revision'])])))
        self.assertEqual(r.status, status, r.text)
        return r.body

    def listed_findings(self, reading):
        r = self.stack.request('GET', f'/studies/{reading}/findings?includeHidden=true&limit=100', 'doctor')
        self.assertEqual(r.status, 200, r.text)
        return r.body

    def cite(self, reading, finding, text, line=None):
        listed = next(i for i in self.listed_findings(reading)['items'] if i['id'] == finding['id'])
        insert = dict(field='findings', findingId=finding['id'], findingRevision=finding['revision'], sourceIndex=0,
                      insertedText=text + ('\n' + line if line else ''), expectedLinkState=listed['links'][0]['linkState'],
                      expectedHeadRevision=listed['links'][0]['headRevision'])
        if line:
            insert.update(measurementLine=line, measurementSources=[0])
        return self.stack.request('PUT', f'/studies/{reading}/report', 'doctor', dict(findings=insert['insertedText'],
            conclusion='', recommendation='', baseVersion=0, insert=insert))

    def test_exam_merge_05_split_part_finding_is_that_parts_own(self):
        """A finding made on the second part of a split exam is that part's: it is written on the part's UID with its mark
        on the original, listed and cited (with its measurement) there and not on the first part. A mark of the other part
        is refused on each part. A finding the original held before the split, on a series that went to the second part, is
        listed by neither part, while the report citation naming it and its history stay readable. Ordinary studies are
        covered by the findings suites unchanged."""
        patient, (a,) = self.patient(1)
        # The viewer rows this case writes reference the studies: removed before them (cleanups run last-registered first).
        self.addCleanup(drop_viewer_rows, a.uid)
        self.add_series(patient, a.uid)
        series = self.series_instances(a.uid)
        self.assertEqual(len(series), 2)
        first, moved = sorted(series, key=lambda s: int(series[s][0].SeriesNumber) if 'SeriesNumber' in series[s][0] else 0)
        # Before the split: a finding on the original, from the series that will become the second part (a split needs no
        # open report, so it is cited only after the split, below, as a screen that still listed it would have).
        old = self.finding_on(a.uid, self.length_on(a.uid, series[moved][0]), 'SYNTHETIC BEFORE SPLIT')

        split =self.stack.request('POST', '/exam-groups/split', 'tech', {'uid': a.uid, 'seriesUids': [moved]})
        self.assertEqual(split.status, 200, split.text)
        second = next(row for row in self.listed().values() if row.get('examScope', {}).get('part') == 1 and
                      row['examScope']['sources'][0]['studyUid'] == a.uid)['uid']
        self.addCleanup(drop_viewer_rows, second)

        # The second part: a Length on its own series, saved by the viewer on the original UID, becomes a finding of the part.
        mark = self.length_on(a.uid, series[moved][0])
        mine = self.finding_on(second, mark, 'SYNTHETIC SECOND PART')
        self.assertEqual(mine['studyUid'], second)
        self.assertEqual([(s['studyUid'], s['seriesUid']) for s in mine['item']['sources']], [(a.uid, moved)])
        listed = self.listed_findings(second)
        self.assertEqual([i['id'] for i in listed['items']], [mine['id']])
        self.assertEqual(listed['ownStudies'], [a.uid])
        # Not a candidate on the first part; the finding the original held for the moved series is listed by neither part.
        self.assertEqual([i['id'] for i in self.listed_findings(a.uid)['items']], [])
        # A mark of the other part is refused on each part, like a mark the study does not hold.
        self.finding_on(a.uid, mark, 'SYNTHETIC WRONG PART', status=404)
        self.finding_on(second, self.length_on(a.uid, series[first][0]), 'SYNTHETIC WRONG PART', status=404)
        # Cited on the second part with Include Measurements: the server takes the part's own mark into the line.
        line = '측정: Length 20.0 mm (Series 2 / Image 1)'
        quoted = self.cite(second, mine, 'SYNTHETIC SECOND PART', line)
        self.assertEqual(quoted.status, 200, quoted.text)
        drafts = self.stack.request('GET', f'/studies/{second}/report/citations', 'doctor')
        self.assertEqual(drafts.status, 200, drafts.text)
        entry = drafts.body['draft'][0]
        self.assertEqual((entry['findingId'], entry['measurementLine'], entry['measurementSources']), (mine['id'], line, [0]))
        # The part's report is approved and signed on the part's UID; its patient is read from the original (no archive
        # resource carries the part's own UID).
        approved = self.stack.request('POST', f'/studies/{second}/report/commit', 'doctor', {'action': 'approve', 'baseVersion': 0,
            'findings': 'SYNTHETIC SECOND PART\n' + line, 'conclusion': '', 'recommendation': ''})
        self.assertEqual(approved.status, 201, approved.text)
        self.assertEqual(psql(f'SELECT action FROM "ReportVersion" WHERE uid={lit(second)} ORDER BY version DESC LIMIT 1'), ['approve'])
        # Opening the cited source again reads the part's history: the original study, series, image and frame.
        history = self.stack.request('GET', f'/studies/{second}/findings/{mine["id"]}/revisions?limit=100', 'doctor')
        self.assertEqual(history.status, 200, history.text)
        source = history.body['revisions'][0]['item']['sources'][0]
        self.assertEqual((source['studyUid'], source['seriesUid'], source['sopUid'], source['frame']),
                         (a.uid, moved, str(series[moved][0].SOPInstanceUID), 1))
        # The finding the original held stays readable: its history, and a report citation naming it (made here through the
        # API, as a screen that still listed it would have made it) is not turned into a missing source.
        kept = self.stack.request('GET', f'/studies/{a.uid}/findings/{old["id"]}/revisions?limit=100', 'doctor')
        self.assertEqual(kept.status, 200, kept.text)
        r = self.stack.request('PUT', f'/studies/{a.uid}/report', 'doctor', dict(findings='SYNTHETIC BEFORE SPLIT', conclusion='',
            recommendation='', baseVersion=0, insert=dict(field='findings', findingId=old['id'], findingRevision=old['revision'],
            sourceIndex=0, insertedText='SYNTHETIC BEFORE SPLIT', expectedLinkState='current', expectedHeadRevision=1)))
        self.assertEqual(r.status, 200, r.text)
        before = self.stack.request('GET', f'/studies/{a.uid}/report/citations', 'doctor')
        self.assertEqual(before.status, 200, before.text)
        # A readable entry is whole; an unreadable one is reduced to {cid, field, insertedAt, insertedBy, state}.
        self.assertEqual([(e.get('findingId'), e.get('insertedText'), e.get('state')) for e in before.body['draft']],
                         [(old['id'], 'SYNTHETIC BEFORE SPLIT', None)])


def load_tests(loader, tests, pattern):
    return unittest.TestSuite([ExamMergeE2E("test_exam_merge_01_three_studies_one_exam_viewer_report_unmerge"),
                               ExamMergeE2E("test_exam_merge_02_late_image_and_approved_refusal"),
                               ExamMergeE2E("test_exam_merge_03_split_second_viewer_report_late_series_unsplit"),
                               ExamMergeE2E("test_exam_merge_04_original_loss_and_patient_change_refuse_scope"),
                               ExamMergeE2E("test_exam_merge_05_split_part_finding_is_that_parts_own")])


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    unittest.main(verbosity=2)
