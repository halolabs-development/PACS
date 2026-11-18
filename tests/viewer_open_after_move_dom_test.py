# coding: utf-8
"""A row double-click opens the viewer window for that study only once the list has moved to it.

The list moves to another study through its study-move gate: with report text the server has not confirmed, the move
waits for that text's draft save and does not happen when the save is refused or its result is unknown (the Notice says
"... 검사를 옮기지 않았습니다"). The viewer window must follow the same answer: a refused move leaves no window on the
other study (no new window, no window navigated there), a move that waits opens the window only when it is answered,
a later choice made while it waits wins, and once the cause is gone the same double-click opens the study.

The delivered split page against the synthetic origin of tests/report_flow_dom_test.py (read-only); the viewer document
is a stand-in page (no images are read), named VIEWER below.
"""
import json
import sys
import unittest

import auth_logout_dom_test as h
import report_flow_dom_test as rf
from playwright.sync_api import expect

# A clean viewer document of this list's account: the window checks the list reads (owner, unsaved annotation and job
# state, Frame Coverage) answer as a ready viewer with nothing unsaved, so the list may replace it as it would OHIF.
VIEWER = """<!doctype html><title>SYN viewer</title><body>SYN viewer stand-in</body>
<script>window.kinViewerWindowOwner = () => %s;
window.kinViewerHistoryWorkspaceState = () => ({busy: false, dirty: false});
window.kinViewerJobWorkspaceState = () => ({busy: false, dirty: false});
window.kinViewerFrameCoverageConfirm = () => true;</script>"""
REFUSED = (503, {"code": "SYN_DOWN", "message": "SYN server down"})


class ViewerOpenAfterMove(rf.ReportFlowPage):
    count = 3

    def setUp(self):
        super().setUp()
        self.viewer_loads = []
        self.owner = None
        self.context.route("**/ohif/viewer*", lambda route, request: (
            self.viewer_loads.append(request.url),
            route.fulfill(body=VIEWER % json.dumps(self.owner), content_type="text/html; charset=utf-8")))

    def open(self):
        super().open()
        self.owner = self.page.evaluate("() => KinViewerOpening.key(KinAuth.session()).slice(KinViewerOpening.PREFIX.length)")

    # ── what the reader sees ──
    def popups(self):
        """The other windows of this browser context (the viewer windows the list opened), open now."""
        return [page for page in self.context.pages if page is not self.page and not page.is_closed()]

    def windows_on(self, uid):
        return [page for page in self.popups() if "StudyInstanceUIDs=" + uid in page.url]

    def loads_of(self, uid):
        return [url for url in self.viewer_loads if "StudyInstanceUIDs=" + uid in url]

    def double_click(self, patient):
        self.row(patient).dblclick()

    def typed_on_a(self, text="SYN A typed"):
        self.open()
        self.open_study(h.PATIENT)
        self.type(text)

    def assert_no_window_on(self, uid, what):
        self.settle(400)
        self.assertEqual([], self.windows_on(uid), what + ": no window shows the study the list did not move to")
        self.assertEqual([], self.loads_of(uid), what + ": no viewer document of that study was requested")
        self.assertEqual([], [page.url for page in self.popups() if page.url == "about:blank"],
                         what + ": no empty window is left behind")

    # ── a refused move opens nothing ──
    def test_refused_save_double_click_keeps_the_study_and_opens_no_viewer_window(self):
        self.typed_on_a()
        self.site.put_answers = [REFUSED] * 8
        self.double_click(h.PATIENT_B)
        expect(self.notice()).to_contain_text("Save Failed")
        expect(self.notice()).to_contain_text("옮기지 않았습니다")
        self.assertEqual(h.PATIENT, self.selected())
        self.assert_no_window_on(h.UID_B, "refused save")
        self.assertEqual("SYN A typed", self.page.locator("#findings").input_value())

    def test_lost_connection_double_click_keeps_the_study_and_opens_no_viewer_window(self):
        # The connection drops on the draft write and on the confirming read: the result is unknown.
        self.typed_on_a()
        self.site.put_answers = ["abort"] * 8
        self.site.draft_read_answers = ["abort"] * 8
        self.double_click(h.PATIENT_B)
        expect(self.notice()).to_contain_text("옮기지 않았습니다")
        self.assertEqual(h.PATIENT, self.selected())
        self.assert_no_window_on(h.UID_B, "lost connection")

    def test_a_waiting_move_that_is_refused_closes_the_window_it_held_and_shows_nothing(self):
        self.typed_on_a()
        self.site.put_answers = ["hold"]
        self.hold_page_time()
        writes = len(self.site.flow_puts)
        self.double_click(h.PATIENT_B)
        self.held_navigation_write(h.UID, "SYN A typed", writes)
        self.settle()
        self.assertEqual(h.PATIENT, self.selected(), "the move waits for the write's answer")
        self.assertEqual([], self.windows_on(h.UID_B), "while the move waits no window is on the other study")
        self.assertEqual([], self.loads_of(h.UID_B))
        # Page time runs again before the answer: the refusal closes the held window, a closed page takes no clock call.
        self.release_page_time()
        self.site.finish_flow_put(status=503)
        expect(self.notice()).to_contain_text("옮기지 않았습니다")
        self.assertEqual(h.PATIENT, self.selected())
        self.assert_no_window_on(h.UID_B, "refused after the wait")
        self.assertEqual([], self.popups(), "the window held for the waiting move is closed")

    # ── a move that is answered opens the study ──
    def test_a_waiting_move_that_is_saved_opens_that_study_in_the_held_window(self):
        self.typed_on_a()
        self.site.put_answers = ["hold"]
        self.hold_page_time()
        writes = len(self.site.flow_puts)
        self.double_click(h.PATIENT_B)
        self.held_navigation_write(h.UID, "SYN A typed", writes)
        self.site.finish_flow_put()
        self.release_page_time()
        self.wait(lambda: self.selected() == h.PATIENT_B, "the move after the confirmed write")
        self.wait(lambda: self.windows_on(h.UID_B), "the viewer window of the study moved to")
        self.settle(300)
        self.assertEqual(1, len(self.popups()), "one viewer window")
        self.assertEqual(1, len(self.loads_of(h.UID_B)), "one viewer document of that study")

    def test_without_unconfirmed_text_double_click_opens_at_once_as_before(self):
        self.open()
        self.open_study(h.PATIENT)
        with self.context.expect_page() as opened:
            self.double_click(h.PATIENT_B)
        opened.value.wait_for_url("**StudyInstanceUIDs=" + h.UID_B + "**")
        self.assertEqual(h.PATIENT_B, self.selected())
        self.settle(300)
        self.assertEqual(1, len(self.popups()))

    def test_after_a_refusal_the_same_double_click_opens_once_the_connection_is_back(self):
        self.typed_on_a()
        self.site.put_answers = [REFUSED] * 8
        self.double_click(h.PATIENT_B)
        expect(self.notice()).to_contain_text("옮기지 않았습니다")
        self.assert_no_window_on(h.UID_B, "refused")
        self.site.put_answers = []
        with self.context.expect_page() as opened:
            self.double_click(h.PATIENT_B)
        self.wait(lambda: self.selected() == h.PATIENT_B, "the move once the save is confirmed")
        opened.value.wait_for_url("**StudyInstanceUIDs=" + h.UID_B + "**")
        self.settle(300)
        self.assertEqual(1, len(self.popups()))
        self.assertEqual({"findings": "SYN A typed", "conclusion": "", "recommendation": ""}, self.stored(h.UID))

    # ── a later choice made while the move waits wins ──
    def test_a_later_double_click_while_the_move_waits_opens_only_the_later_study(self):
        self.typed_on_a()
        self.site.put_answers = ["hold"]
        self.hold_page_time()
        writes = len(self.site.flow_puts)
        self.double_click(h.PATIENT_B)
        self.held_navigation_write(h.UID, "SYN A typed", writes)
        self.double_click(rf.PATIENT_C)
        self.site.finish_flow_put()
        self.release_page_time()
        self.wait(lambda: self.selected() == rf.PATIENT_C, "the move goes to the study chosen last")
        self.wait(lambda: self.windows_on(rf.UID_C), "the viewer window of the study chosen last")
        self.settle(300)
        self.assertEqual([], self.loads_of(h.UID_B), "the study chosen first is never shown")
        self.assertEqual(1, len(self.popups()), "one viewer window")

    def test_double_clicking_the_current_study_while_the_move_waits_stays_and_shows_the_current_study(self):
        self.typed_on_a()
        self.site.put_answers = ["hold"]
        self.hold_page_time()
        writes = len(self.site.flow_puts)
        self.double_click(h.PATIENT_B)
        self.held_navigation_write(h.UID, "SYN A typed", writes)
        self.double_click(h.PATIENT)
        self.wait(lambda: self.loads_of(h.UID), "the current study's viewer window")
        self.site.finish_flow_put()
        self.release_page_time()
        self.settle(400)
        self.assertEqual(h.PATIENT, self.selected(), "the reader chose the current study again: no move")
        self.assertEqual([], self.loads_of(h.UID_B), "the study left behind is never shown")
        self.assertEqual(1, len(self.popups()), "one viewer window")
        self.assertEqual(1, len(self.windows_on(h.UID)))

    # ── the window held for a waiting move ──
    def wait_for_b(self):
        self.typed_on_a()
        self.site.put_answers = ["hold"]
        self.hold_page_time()
        writes = len(self.site.flow_puts)
        self.double_click(h.PATIENT_B)
        self.held_navigation_write(h.UID, "SYN A typed", writes)

    def test_the_held_blank_window_closes_when_the_list_goes_away_while_the_move_waits(self):
        self.wait_for_b()
        self.assertEqual(["about:blank"], [page.url for page in self.popups()], "one blank window held for the move")
        self.release_page_time()
        self.page.reload()
        expect(self.page.locator("#rows")).to_contain_text(h.PATIENT)
        self.settle(300)
        self.assertEqual([], self.popups(), "the held blank window is not left behind")
        self.assertEqual([], self.loads_of(h.UID_B))

    def test_open_on_selection_opens_the_moved_to_study_once(self):
        self.open()
        # Image Opening > Open on Selection, through its own control (the dialog only shows it).
        self.page.evaluate("() => { const box = document.querySelector('#image-opening-autoload'); box.checked = true;"
                           " box.dispatchEvent(new Event('change')); }")
        self.open_study(h.PATIENT)
        self.page.wait_for_timeout(300)
        loads_of_a = len(self.loads_of(h.UID))
        self.type("SYN A typed")
        self.site.put_answers = ["hold"]
        self.hold_page_time()
        writes = len(self.site.flow_puts)
        self.double_click(h.PATIENT_B)
        self.held_navigation_write(h.UID, "SYN A typed", writes)
        self.assertEqual([], self.loads_of(h.UID_B), "nothing of B while the move waits")
        self.site.finish_flow_put()
        self.release_page_time()
        self.wait(lambda: self.selected() == h.PATIENT_B, "the move after the confirmed write")
        self.wait(lambda: self.loads_of(h.UID_B), "the viewer document of the study moved to")
        self.settle(500)
        self.assertEqual(1, len(self.loads_of(h.UID_B)), "the automatic open and the double-click open it once")
        self.assertEqual(loads_of_a, len(self.loads_of(h.UID)))
        self.assertEqual(1, len(self.popups()), "one viewer window")

    def test_a_study_found_mismatched_while_the_move_waits_is_not_shown(self):
        self.wait_for_b()
        # Setup: the list read that marks B's patient identity as unresolved (WORKLIST-SPLIT-UID) arrives during the wait.
        self.page.evaluate("uid => { appState[uid] = { ...appState[uid], identityUnresolved: true }; }", h.UID_B)
        self.release_page_time()
        self.site.finish_flow_put()
        expect(self.page.locator("#toast")).to_contain_text("환자 식별 불일치")
        self.settle(400)
        self.assertEqual([], self.loads_of(h.UID_B), "no viewer document of the mismatched study")
        self.assertEqual([], self.popups(), "the held blank window is closed")

    def test_a_row_without_a_dicom_uid_chosen_while_the_move_waits_says_so_and_leaves_no_window(self):
        # A list row keyed by an old study key that is not a DICOM UID (the list shows it; the viewer cannot address it).
        legacy, name = "LEGACY_7", "SYN PATIENT LEGACY"
        self.site.flow = (*self.site.flow, (legacy, name, "SYN-P-007"))
        self.site.store[legacy] = {"revs": 0, "row": None, "report": {"version": 0, "rs": "W"}}
        self.wait_for_b()
        self.row(name).dblclick()
        self.release_page_time()
        self.site.finish_flow_put()
        self.wait(lambda: self.selected() == name, "the move goes to the row chosen last")
        expect(self.page.locator("#toast")).to_be_visible()
        self.settle(400)
        self.assertEqual([], self.loads_of(h.UID_B), "the study chosen first is never shown")
        self.assertEqual([], self.popups(), "the window held for the waiting move is closed")
        self.assertEqual([], self.errors, "no page error")


def load_tests(loader, tests, pattern):
    return unittest.TestSuite(ViewerOpenAfterMove(name) for name in ViewerOpenAfterMove.__dict__ if name.startswith("test_"))


if __name__ == "__main__":
    unittest.main(verbosity=2)
