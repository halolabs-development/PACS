# coding: utf-8
"""The cell identity label (viewer-identity.js) shows the worklist's answer for its study (config/ohif/study-display.js).

After a Match the label and the window title name the order's patient ID, name and description, as the worklist does;
the checks that the label belongs to the drawn image (study, series, SOP, image Patient ID) stay on the image. Before the
answer arrives, and for a study the list does not answer, the label shows the image's own values as before.
"""
import json
from pathlib import Path
import unittest

from playwright.sync_api import sync_playwright
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
        self.page.route(ORIGIN + "/api/studies?*", self.serve)
        self.page.goto(ORIGIN + "/")
        activate(self.page)
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
        uids = route.request.url.split("uids=")[1].split("&")[0].replace("%2C", ",").split(",")
        rows = [self.answer[uid] for uid in uids if uid in self.answer]
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
        self.assertEqual(after[1], {"role": "prior", "text": "비교 검사 · PID-2 · PRIOR PATIENT · 20250911"},
                         "an unmatched prior shows its own list values; the role is unchanged")
        self.assertEqual("기준 검사 · ORD-1 · ORDER PATIENT · 20260911 · CT — 판독 뷰어", self.page.title())

    def test_unmatch_then_read_again_shows_the_image_values(self):
        self.page.evaluate("window.identityMount=__mount()")
        self.page.wait_for_function("() => document.querySelector('#vp1>.kin-viewer-identity')?.textContent.includes('ORD-1')")
        self.answer["study-current"] = {**ROWS["study-current"], "state": {"ov": None}}
        self.page.evaluate("kinViewerStudyDisplay.refresh(['study-current'])")
        self.page.wait_for_function("() => document.querySelector('#vp1>.kin-viewer-identity')?.textContent.includes('PID-1')")
        self.assertEqual(self.labels()[0], {"role": "current", "text": "기준 검사 · PID-1 · CURRENT PATIENT · 20260911"})

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

    def test_the_label_still_belongs_to_the_drawn_image(self):
        # An image whose own Patient ID is not the opened study's is not labelled, whatever the list's answer says.
        self.page.evaluate("window.identityMount=__mount()")
        self.page.wait_for_function("() => document.querySelector('#vp1>.kin-viewer-identity')?.textContent.includes('ORD-1')")
        self.page.evaluate("metadata['image-current'].PatientID='OTHER';__grid()")
        self.page.wait_for_function("() => !document.querySelector('#vp1>.kin-viewer-identity')")


if __name__ == "__main__":
    unittest.main()
