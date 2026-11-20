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
        # A fixed browser time zone: the Previous Report's times are this screen's local minutes (not the server's UTC).
        self.page = self.browser.new_page(viewport={"width": 1280, "height": 900}, timezone_id="Asia/Seoul")
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
            # The signer as the server names it (the member name beside the stored login) and the approval that opened the
            # current cycle at the time the study keeps (2026-11-18 03:06 in Asia/Seoul).
            route.fulfill(json=[{"version": 1, "action": "approve", "findings": "Approved text", "author": "syn.reader@example.test",
                                 "authorName": "SYN Kim Reader", "at": "2026-11-17T18:05:59.990Z", "approvedAt": "2026-11-17T18:06:00.000Z"}])
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
        # report-preview.js comes before the prior controller and panel, as the viewer's Previous Report asset list loads it.
        for name in ("viewer-info-bar", "viewer-patient-tabs", "report-preview", "viewer-prior-controller", "viewer-prior-panel", "viewer-tech-note"):
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
            # Who signed it and when: the member name and this screen's minute, never the login or the server's UTC text.
            expect(header).to_contain_text("Version 1 | Approved | SYN Kim Reader | 2026-11-18 03:06")
            for leaked in ("syn.reader@", "2026-11-17", "T18:0", "Z"):
                self.assertNotIn(leaked, header.locator("p").nth(2).text_content())
            expect(self.page.get_by_role("button", name="Current CT")).to_have_attribute(
                "title", "CURRENT PATIENT | PID-1 | IMAGE-ACC | study-current")
        else:
            self.assertTrue(all("/api/clinician/studies" in url for url in self.reads))

    def test_author_match_then_unmatch_updates_all_six_surfaces(self):
        self.exercise_surfaces("writer")

    def test_clinician_match_then_unmatch_keeps_empty_overrides_on_all_visible_surfaces(self):
        self.exercise_surfaces("read-only")

    def mount_empty_display(self, *, status=200, unlisted=()):
        self.page.route(ORIGIN + "/api/studies**", lambda route: route.fulfill(
            status=status, json={"studies": [], "unlistedUids": list(unlisted)}))
        self.page.add_style_tag(path=str(IDENTITY.with_name("viewer-ux-theme.css")))
        self.page.add_script_tag(path=str(IDENTITY.with_name("viewer-patient-tabs.js")))
        self.page.evaluate("""async () => {
          history.replaceState({}, '', '/ohif/viewer?StudyInstanceUIDs=study-current');
          const root = document.body.appendChild(document.createElement('div'));
          root.id = 'root';
          const layout = root.appendChild(document.createElement('div'));
          layout.innerHTML = '<div class="bg-secondary-dark z-20"><span id="kin-viewer-brand"></span></div>';
          layout.append(document.querySelector('#vp1').parentElement);
          window.refusals = 0;
          window.addEventListener('kin-viewer-open-refused', () => window.refusals++);
          Object.assign(services.cornerstoneViewportService, {
            EVENTS: {VIEWPORT_DATA_CHANGED:'data'}, subscribe: () => ({unsubscribe(){}})
          });
          await KinViewerPatientTabs.mount({ services, session:kinViewerSession, refreshChrome(){} });
        }""")

    def test_selected_study_omitted_from_display_keeps_its_image(self):
        # The selected exam has an original with a different patient key. Its display projection has no row.
        self.mount_empty_display()
        expect(self.page.get_by_role("status")).to_have_text("같은 환자의 검사인지 확인할 수 없어 현재 화면을 유지합니다.")
        expect(self.page.get_by_role("button", name="Retry Patient")).to_be_visible()
        expect(self.page.locator("#vp1")).to_be_visible()
        expect(self.page.get_by_text("이 검사를 볼 수 있는 권한이 없습니다.")).to_have_count(0)
        self.assertEqual(0, self.page.evaluate("refusals"))

    def assert_refused_open(self):
        expect(self.page.get_by_role("alert")).to_have_text("이 검사를 볼 수 있는 권한이 없습니다.")
        expect(self.page.locator("#vp1")).to_be_hidden()
        expect(self.page.get_by_role("button", name="Retry Patient")).to_be_hidden()
        self.assertEqual(1, self.page.evaluate("refusals"))

    def test_server_refuses_the_open(self):
        self.mount_empty_display(status=403)
        self.assert_refused_open()

    def test_open_study_is_missing_from_the_authorized_selection(self):
        self.mount_empty_display(unlisted=["study-current"])
        self.assert_refused_open()

    def test_the_label_still_belongs_to_the_drawn_image(self):
        # An image whose own Patient ID is not the opened study's is not labelled, whatever the list's answer says.
        self.page.evaluate("window.identityMount=__mount()")
        self.page.wait_for_function("() => document.querySelector('#vp1>.kin-viewer-identity')?.textContent.includes('ORD-1')")
        self.page.evaluate("metadata['image-current'].PatientID='OTHER';__grid()")
        self.page.wait_for_function("() => !document.querySelector('#vp1>.kin-viewer-identity')")


if __name__ == "__main__":
    unittest.main()
