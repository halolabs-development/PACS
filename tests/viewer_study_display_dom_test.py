# coding: utf-8
"""The cell identity label (viewer-identity.js) shows the worklist's answer for its study (config/ohif/study-display.js).

After a Match the label and the window title name the order's patient ID, name and description, as the worklist does;
the checks that the label belongs to the drawn image (study, series, SOP, image Patient ID) stay on the image. Before the
answer arrives, and for a study the list does not answer, the label shows the image's own values as before.
"""
import json
from pathlib import Path
import unittest

from playwright.sync_api import expect, sync_playwright
from viewer_identity_position_dom_test import HARNESS
from module_session_harness import activate


ROOT = Path(__file__).resolve().parents[1]
IDENTITY = ROOT / "worklist-v0" / "hpacs-lite" / "viewer-identity.js"
DISPLAY = ROOT / "config" / "ohif" / "study-display.js"
ORIGIN = "https://study-display.test"

ROWS = {
    "study-current": {"uid": "study-current", "id": "PID-1", "name": "CURRENT PATIENT", "birth": "19700101", "date": "20260911",
                      "sex": "M", "desc": "Current CT", "sourcePatientKey": "inst|PID-1", "state": {"ov": {"id": "ORD-1", "name": "ORDER PATIENT", "desc": "Order CT",
                                                                         "birth": "1970-02-02", "age": 56}}},
    "study-prior": {"uid": "study-prior", "id": "PID-2", "name": "PRIOR PATIENT", "birth": "19700101", "date": "20250911",
                    "sex": "M", "desc": "Prior CT", "sourcePatientKey": "inst|PID-2", "state": {"ov": None}},
}


class ViewerStudyDisplayDOMTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.pw = sync_playwright().start()
        cls.browser = cls.pw.chromium.launch()

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.pw.stop()

    def setUp(self):
        self.page = self.browser.new_page(viewport={"width": 1280, "height": 900})
        self.held, self.reads, self.answer = [], [], dict(ROWS)
        self.page.route(ORIGIN + "/", lambda route: route.fulfill(body=HARNESS, content_type="text/html"))
        self.page.route(ORIGIN + "/api/studies**", self.serve)
        self.page.route(ORIGIN + "/api/clinician/studies**", self.serve)
        self.role = "writer"
        self.page.goto(ORIGIN + "/")
        activate(self.page)
        self.page.evaluate("""() => { window.kinViewerSession = { state: () => window.testRole || 'writer',
          readOnly: () => window.testRole === 'read-only' }; }""")
        self.page.add_script_tag(path=str(DISPLAY))
        self.page.add_script_tag(path=str(IDENTITY))

    def tearDown(self):
        self.page.close()

    def serve(self, route):
        url = route.request.url
        self.reads.append(url)
        if self.hold:
            self.held.append(route)
            return
        self.fulfill(route)

    def fulfill(self, route):
        if route.request.url.endswith("/report/versions"):
            route.fulfill(json=[{"version": 1, "action": "approve", "findings": "Approved text"}])
            return
        uids = (route.request.url.split("uids=")[1].split("&")[0].replace("%2C", ",").split(",")
                if "uids=" in route.request.url else self.answer)
        rows = [self.answer[uid] for uid in uids if uid in self.answer]
        if route.request.headers.get("x-kin-viewer-display") == "1":
            def projected(row):
                overlay = row["state"]["ov"] or {}
                values = {k: overlay.get(k, row.get(k, "")) for k in ("id", "name", "sex", "desc", "date", "birth", "modality")}
                values["age"] = str((int(values["date"].replace("-", "")) - int(values["birth"].replace("-", ""))) // 10000) + "Y" if values["birth"] else ""
                values.update(acc=row.get("orderAccession") or row.get("acc", ""), over=list(overlay))
                source = dict(studyUid=row["uid"], sourcePatientKey=row["sourcePatientKey"],
                              series=dict(mode="all", uids=[]), values=values)
                return dict(uid=row["uid"], sourcePatientKey=row["sourcePatientKey"], displaySources=[source], state={"rs": "A"})
            rows = [projected(row) for row in rows]
        elif self.role == "read-only":
            rows = [{**row, **(row["state"]["ov"] or {})} for row in rows]
            for row in rows:
                row.pop("state", None)
        route.fulfill(body=json.dumps({"studies": rows}), content_type="application/json")

    hold = False

    def labels(self):
        return self.page.evaluate("""() => ['#vp1','#vp2'].map(id => {
          const e=document.querySelector(id+'>.kin-viewer-identity');
          return e ? {role:e.dataset.role,text:e.querySelector('.kin-viewer-identity-content').textContent} : null;
        })""")

    def test_matched_study_label_and_title_show_the_order_values_after_the_answer(self):
        self.hold = True
        self.page.evaluate("window.identityMount=__mount()")
        before = self.labels()
        self.assertEqual(before[0], {"role": "current", "text": "기준 검사 · PID-1 · CURRENT^PATIENT · 20260911"},
                         "until the worklist answers, the image's own values (as before)")
        for _ in range(50):
            if self.held:
                break
            self.page.wait_for_timeout(50)
        self.assertEqual(1, len(self.held), "one batched read for the two shown studies")
        self.assertIn("/api/studies?uids=study-current%2Cstudy-prior", self.reads[0])
        self.hold = False
        for route in self.held:
            self.fulfill(route)
        self.page.wait_for_function("() => document.querySelector('#vp1>.kin-viewer-identity')?.textContent.includes('ORD-1')")
        after = self.labels()
        self.assertEqual(after[0], {"role": "current", "text": "기준 검사 · ORD-1 · ORDER PATIENT · 20260911"})
        self.assertEqual(after[1], {"role": "prior", "text": "비교 검사 · PID-2 · PRIOR^PATIENT · 20250911"},
                         "an unmatched prior shows its image values as before; the role is unchanged")
        self.assertEqual("기준 검사 · ORD-1 · ORDER PATIENT · 20260911 · CT — 판독 뷰어", self.page.title())

    def test_unmatch_then_read_again_shows_the_image_values(self):
        self.page.evaluate("window.identityMount=__mount()")
        self.page.wait_for_function("() => document.querySelector('#vp1>.kin-viewer-identity')?.textContent.includes('ORD-1')")
        self.answer["study-current"] = {**ROWS["study-current"], "state": {"ov": None}}
        self.page.evaluate("kinViewerStudyDisplay.refresh(['study-current'])")
        self.page.wait_for_function("() => document.querySelector('#vp1>.kin-viewer-identity')?.textContent.includes('PID-1')")
        self.assertEqual(self.labels()[0], {"role": "current", "text": "기준 검사 · PID-1 · CURRENT^PATIENT · 20260911"})

    def test_an_emptied_id_is_unknown_and_another_patients_row_is_not_shown(self):
        self.answer["study-current"] = {**ROWS["study-current"], "state": {"ov": {"id": "", "name": "ORDER PATIENT", "desc": ""}}}
        self.answer["study-prior"] = {**ROWS["study-prior"], "sourcePatientKey": "inst|SOMEONE-ELSE",
                                      "state": {"ov": {"id": "ORD-9", "name": "OTHER PATIENT"}}}
        self.page.evaluate("window.identityMount=__mount()")
        self.page.wait_for_function("() => document.querySelector('#vp1>.kin-viewer-identity')?.textContent.includes('ORDER PATIENT')")
        labels = self.labels()
        self.assertEqual(labels[0], {"role": "current", "text": "기준 검사 · Unknown · ORDER PATIENT · 20260911"},
                         "an ID the overlay emptied is not filled from the image")
        self.assertEqual(labels[1], {"role": "prior", "text": "비교 검사 · PID-2 · PRIOR^PATIENT · 20250911"},
                         "a row of another original patient never labels this image")

    def exercise_surfaces(self, role):
        self.role = role
        self.page.evaluate("role => window.testRole = role", role)
        self.answer["study-current"] = {**ROWS["study-current"], "acc": "IMAGE-ACC", "orderAccession": "ORDER-ACC",
                                        "state": {"ov": {"name": "ORDER PATIENT", "id": "ORD-1", "sex": "", "birth": "", "desc": ""}}}
        self.page.evaluate("""() => {
          history.replaceState({}, '', '/ohif/viewer?StudyInstanceUIDs=study-current');
          const brand = document.createElement('div');
          brand.innerHTML = '<div class="bg-secondary-dark z-20"><span id="kin-viewer-brand"></span></div>';
          document.body.append(brand);
          Object.assign(metadata['image-current'], {PatientSex:'M', PatientBirthDate:'19700101',PatientAge:'056Y'});
          services.viewportGridService.getState = () => ({ viewports, activeViewportId:'vp1', layout:{ layoutType:'grid',numRows:1,numCols:2 } });
          for(const [id, cell] of viewports) cell.displaySetInstanceUIDs = [id];
          services.displaySetService = { getDisplaySetByUID: id => metadata[imageState[id].image] };
          Object.assign(services.cornerstoneViewportService, { EVENTS: {VIEWPORT_DATA_CHANGED:'data'}, subscribe: () => ({unsubscribe(){}}) });
          window.KinSessionTransport = {refusal: () => false};
        }""")
        for name in ("viewer-info-bar", "viewer-patient-tabs", "viewer-prior-controller", "viewer-prior-panel", "viewer-tech-note"):
            self.page.add_script_tag(path=str(IDENTITY.with_name(name + ".js")))
        self.page.evaluate("""async () => {
          const tabs = KinViewerPatientTabs;
          await tabs.mount({ services, session:kinViewerSession, refreshChrome(){} });
          const value = { patientKey:'inst|PID-1', sequence:tabs.snapshot().sequence, viewportId:'vp1',
            studyUid:'study-current', seriesUid:'series-current', displaySetUid:'vp1', mode:'stack' };
          const menu = document.body.appendChild(document.createElement('section'));
          const report = document.body.appendChild(document.createElement('section'));
          const controller = KinViewerPriorController.create({
            viewer:{snapshot:tabs.snapshot, subscribe:tabs.subscribe, viewport:() => value},
            loadStudy:async()=>[], onList:v=>KinViewerPriorPanel.list(menu,v,{openReport:uid=>controller.openReport(uid)}),
            onReport:v=>KinViewerPriorPanel.report(report,v,{})
          });
          KinViewerInfoBar.mount({services,studyActions:{ hidden:kinViewerSession.readOnly, available:()=>!kinViewerSession.readOnly(),
            open:()=>controller.open(value) }}).refresh();
          Object.defineProperty(navigator, 'clipboard', {configurable:true, value:{
            writeText:async value => { window.copiedPatientId=value; }
          }});
          window.KinViewerSessionBoundary = { wait:async operation=>operation };
          kinCreateViewerPatientCopy({ services, host:document.body, selected:id=>imageState[id||'vp1'],
            owner:()=>ownerValue, live:()=>allowedValue, studies:['study-current','study-prior'] });
        }""")
        bar = self.page.locator('#vp1').locator('..').get_by_role("region", name="Viewport Information")
        tab = self.page.get_by_role("tab", selected=True)
        label = self.page.locator("#vp1>.kin-viewer-identity")
        expect(bar).to_contain_text("ORDER PATIENT | Unknown | Unknown | ORD-1")
        expect(tab).to_have_text("ORDER PATIENT | ORD-1 | Unknown | Unknown")
        expect(label).to_contain_text("ORD-1 · ORDER PATIENT")
        self.assertIn("ORD-1 · ORDER PATIENT", self.page.title())
        self.page.get_by_role("button", name="Copy Patient ID").click()
        self.assertEqual("PID-1", self.page.evaluate("window.copiedPatientId"))
        if role == "writer":
            bar.get_by_role("button", name="Study").click()
            item = self.page.get_by_role("region", name="Studies").get_by_role("button", name="study-current")
            expect(item).to_have_attribute("title", "ORDER PATIENT | ORD-1 | ORDER-ACC | study-current")
            self.page.get_by_role("button", name="Report", exact=True).click()
            header = self.page.get_by_role("region", name="Previous Report")
            expect(header).to_contain_text("ORDER-ACC")
        self.answer["study-current"] = {**ROWS["study-current"], "acc": "IMAGE-ACC", "state": {"ov": None}}
        self.page.evaluate("KinViewerPatientTabs.open(location.href)")
        expect(bar).to_contain_text("CURRENT^PATIENT | M | 56Y | PID-1")
        expect(tab).to_have_text("CURRENT PATIENT | PID-1 | 56Y | M")
        expect(label).to_contain_text("PID-1 · CURRENT^PATIENT")
        self.assertIn("PID-1 · CURRENT^PATIENT", self.page.title())
        if role == "writer":
            expect(header).to_contain_text("CURRENT PATIENT | PID-1")
            expect(header).to_contain_text("IMAGE-ACC")
            expect(header).not_to_contain_text("ORDER-ACC")
            expect(header).to_contain_text("Approved text")
            expect(self.page.get_by_role("button", name="Current CT")).to_have_attribute(
                "title", "CURRENT PATIENT | PID-1 | IMAGE-ACC | study-current")
        else:
            self.assertTrue(all("/api/clinician/studies" in url for url in self.reads))

    def test_author_match_then_unmatch_updates_all_six_surfaces(self):
        self.exercise_surfaces("writer")

    def test_clinician_match_then_unmatch_keeps_empty_overrides_on_all_visible_surfaces(self):
        self.exercise_surfaces("read-only")

    def test_the_label_still_belongs_to_the_drawn_image(self):
        # An image whose own Patient ID is not the opened study's is not labelled, whatever the list's answer says.
        self.page.evaluate("window.identityMount=__mount()")
        self.page.wait_for_function("() => document.querySelector('#vp1>.kin-viewer-identity')?.textContent.includes('ORD-1')")
        self.page.evaluate("metadata['image-current'].PatientID='OTHER';__grid()")
        self.page.wait_for_function("() => !document.querySelector('#vp1>.kin-viewer-identity')")


if __name__ == "__main__":
    unittest.main()
