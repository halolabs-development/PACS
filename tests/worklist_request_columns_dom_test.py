# coding: utf-8
"""Worklist request and approval columns on the shipped page: ReqDate, ReqDept, ReqDoc, Pt Class (after Name) and Confirm
(after RS), their filters, a stored layout from before these columns, and the column chooser. Referred (after StudyDate):
when the referring hospital's Gateway sent the study, its filter, a sort by the server time itself, a poll that refreshes
rows in place, and both screen languages. Read Req (after Confirm): the open reading request a clinician made on the
study (the server's readingRequest), who asked as the cell's title, its Requested / None filter on the header, in a saved
compound search and after a poll, and both screen languages.

The page boots through its own boot() against the in-test server of multi_institution_worklist_dom_test.py; nothing of the
page is cut out or replaced. Cells are read by the position of their visible header. Expected values are written here from
the stub rows (synthetic SYN-* data), never computed by product code. Times are shown in the browser's zone (Asia/Seoul).
"""
import json
import re
import unittest
from datetime import datetime, timezone

from playwright.sync_api import expect
import multi_institution_worklist_dom_test as harness
from multi_institution_worklist_dom_test import Server, SESSION_A, layout_key, row, until


def request_row(uid, pid, *, req_date=None, dept=None, doc=None, pt=None, rs="W", approved_at=None, confirm=None):
    body = row(uid, pid, rs=rs)
    body.update({"reqDate": req_date, "reqDept": dept, "reqDoc": doc, "ptClass": pt})
    body["state"].update({"approvedAt": approved_at, "confirm": confirm})
    return body


ROWS = [
    # Matched order values (the server already chose the order first, then the DICOM physician for ReqDoc).
    request_row("2.25.901", "SYN-RC-01", req_date="2026-11-12T00:40:00.000Z", dept="Neurology", doc="SYN PARK JIHOON", pt="Outpatient"),
    request_row("2.25.902", "SYN-RC-02", req_date="2026-11-11T05:00:00.000Z", dept="Orthopedics", doc="SYN SEO JUNHO", pt="Inpatient",
                rs="A", approved_at="2026-11-12T22:31:00.000Z", confirm="2026-11-12"),
    request_row("2.25.903", "SYN-RC-03", req_date="2026-11-12T01:50:00.000Z", dept="Emergency Medicine", doc="SYN YOON JAEHO", pt="ER"),
    # An approval stored before its time was kept: the stored date is shown, and the row is still Confirmed.
    request_row("2.25.904", "SYN-RC-04", dept="Neurology", doc="SYN LEE JUNHO", pt="ICU", rs="A", confirm="2026-10-01"),
    # Approved with neither value stored: blank cell, still Confirmed.
    request_row("2.25.905", "SYN-RC-05", rs="A"),
    # No order and no physician tag: every request cell blank; an In Progress report is Not Confirmed.
    request_row("2.25.906", "SYN-RC-06", rs="T"),
]
IDS = ["SYN-RC-01", "SYN-RC-02", "SYN-RC-03", "SYN-RC-04", "SYN-RC-05", "SYN-RC-06"]
DEFAULT_HEADS = ["No", "Assigned Reader", "RS", "Confirm", "Read Req", "StudyDate", "Referred", "ID", "Name", "ReqDate", "ReqDept", "ReqDoc", "Pt Class",
                 "Age", "StudyDesc", "Modality", "Hospital"]


class WorklistRequestColumnsDOM(unittest.TestCase):
    # The harness's browser and boot only; that file's own cases are not run again here.
    setUpClass = classmethod(harness.MultiInstitutionWorklist.setUpClass.__func__)
    tearDownClass = classmethod(harness.MultiInstitutionWorklist.tearDownClass.__func__)
    boot = harness.MultiInstitutionWorklist.boot

    def select(self, screen, title, value):
        screen.filter_box(title).select_option(value)

    def type(self, screen, title, value):
        screen.filter_box(title).fill(value)

    def test_rc01_default_columns_and_cells(self):
        screen = self.boot(Server(rows=ROWS))
        screen.wait_rows(IDS)
        self.assertEqual(DEFAULT_HEADS, screen.heads())
        self.assertEqual({"SYN-RC-01": "2026-11-12 09:40", "SYN-RC-02": "2026-11-11 14:00", "SYN-RC-03": "2026-11-12 10:50",
                          "SYN-RC-04": "", "SYN-RC-05": "", "SYN-RC-06": ""}, screen.cells_by_id("ReqDate"))
        self.assertEqual({"SYN-RC-01": "Neurology", "SYN-RC-02": "Orthopedics", "SYN-RC-03": "Emergency Medicine",
                          "SYN-RC-04": "Neurology", "SYN-RC-05": "", "SYN-RC-06": ""}, screen.cells_by_id("ReqDept"))
        self.assertEqual({"SYN-RC-01": "SYN PARK JIHOON", "SYN-RC-02": "SYN SEO JUNHO", "SYN-RC-03": "SYN YOON JAEHO",
                          "SYN-RC-04": "SYN LEE JUNHO", "SYN-RC-05": "", "SYN-RC-06": ""}, screen.cells_by_id("ReqDoc"))
        self.assertEqual({"SYN-RC-01": "Outpatient", "SYN-RC-02": "Inpatient", "SYN-RC-03": "ER", "SYN-RC-04": "ICU",
                          "SYN-RC-05": "", "SYN-RC-06": ""}, screen.cells_by_id("Pt Class"))
        # Approval time in the browser's zone; the stored date of an older approval as it is; nothing for the others.
        self.assertEqual({"SYN-RC-01": "", "SYN-RC-02": "2026-11-13 07:31", "SYN-RC-03": "", "SYN-RC-04": "2026-10-01",
                          "SYN-RC-05": "", "SYN-RC-06": ""}, screen.cells_by_id("Confirm"))
        screen.finish()

    def test_rc02_filters_narrow_the_rows(self):
        screen = self.boot(Server(rows=ROWS))
        screen.wait_rows(IDS)
        options = screen.filter_box("ReqDept").locator("option").all_inner_texts()
        self.assertEqual(["", "Emergency Medicine", "Neurology", "Orthopedics"], options)
        self.select(screen, "ReqDept", "Neurology")
        screen.wait_rows(["SYN-RC-01", "SYN-RC-04"])
        self.type(screen, "ReqDoc", "park")
        screen.wait_rows(["SYN-RC-01"])
        self.type(screen, "ReqDoc", "")
        screen.wait_rows(["SYN-RC-01", "SYN-RC-04"])
        self.select(screen, "ReqDept", "")
        screen.wait_rows(IDS)
        self.assertEqual(["", "Outpatient", "Inpatient", "ER", "ICU"], screen.filter_box("Pt Class").locator("option").all_inner_texts())
        self.select(screen, "Pt Class", "ER")
        screen.wait_rows(["SYN-RC-03"])
        self.select(screen, "Pt Class", "")
        self.type(screen, "ReqDate", "2026-11-12")
        screen.wait_rows(["SYN-RC-01", "SYN-RC-03"])
        self.type(screen, "ReqDate", "2026-11-12 10")
        screen.wait_rows(["SYN-RC-03"])
        self.type(screen, "ReqDate", "")
        screen.wait_rows(IDS)
        self.assertEqual(["", "Confirmed", "Not Confirmed"], screen.filter_box("Confirm").locator("option").all_inner_texts())
        # An older approval without a stored time, and one with nothing stored, are Confirmed all the same.
        self.select(screen, "Confirm", "Confirmed")
        screen.wait_rows(["SYN-RC-02", "SYN-RC-04", "SYN-RC-05"])
        self.select(screen, "Confirm", "Not Confirmed")
        screen.wait_rows(["SYN-RC-01", "SYN-RC-03", "SYN-RC-06"])
        self.select(screen, "Confirm", "")
        screen.wait_rows(IDS)
        screen.finish()

    def test_rc03_department_choices_follow_the_list_and_stay_text(self):
        server = Server(rows=ROWS[:2])
        screen = self.boot(server)
        screen.wait_rows(["SYN-RC-01", "SYN-RC-02"])
        self.assertEqual(["", "Neurology", "Orthopedics"], screen.filter_box("ReqDept").locator("option").all_inner_texts())
        self.select(screen, "ReqDept", "Orthopedics")
        screen.wait_rows(["SYN-RC-02"])
        # A department that arrives with a later list joins the choices; the chosen one stays chosen.
        server.rows = ROWS[:2] + [request_row("2.25.907", "SYN-RC-07", dept="<img src=x onerror=window.synXss=1>")]
        screen.refresh()
        until(lambda: "<img src=x onerror=window.synXss=1>" in screen.filter_box("ReqDept").locator("option").all_inner_texts(),
              10, "new department listed")
        self.assertEqual("Orthopedics", screen.filter_box("ReqDept").input_value())
        screen.wait_rows(["SYN-RC-02"])
        self.select(screen, "ReqDept", "<img src=x onerror=window.synXss=1>")
        screen.wait_rows(["SYN-RC-07"])
        self.assertEqual("<img src=x onerror=window.synXss=1>", screen.cells_by_id("ReqDept")["SYN-RC-07"])
        screen.finish()

    @staticmethod
    def compound(name, join, rules):
        return {"id": 600 + len(name), "name": name, "mode": "Radiology", "days": -1, "quick": "",
                "cols": {"$compound": {"version": 1, "join": join, "rules": rules}}, "sortKey": None, "sortDir": 0, "isDefault": False}

    def apply_saved(self, screen, name):
        screen.menu("Filters").get_by_role("button", name=re.compile("^" + re.escape(name) + ", ")).click()

    def test_rc05_saved_compound_searches_on_confirm_and_a_department_no_longer_listed(self):
        filters = [self.compound("SYN CONFIRMED", "and", [{"field": "confirm", "op": "eq", "value": "Confirmed"}]),
                   self.compound("SYN NOT CONFIRMED", "and", [{"field": "confirm", "op": "eq", "value": "Not Confirmed"}]),
                   # A department that no loaded row has: the search stays valid and its other branch still matches.
                   self.compound("SYN GONE DEPT", "or", [{"field": "reqDept", "op": "eq", "value": "SYN Closed Clinic"},
                                                         {"field": "id", "op": "eq", "value": "SYN-RC-06"}])]
        screen = self.boot(Server(rows=ROWS, filters=filters))
        screen.wait_rows(IDS)
        self.apply_saved(screen, "SYN CONFIRMED")
        screen.wait_rows(["SYN-RC-02", "SYN-RC-04", "SYN-RC-05"])
        self.apply_saved(screen, "SYN NOT CONFIRMED")
        screen.wait_rows(["SYN-RC-01", "SYN-RC-03", "SYN-RC-06"])
        self.apply_saved(screen, "SYN GONE DEPT")
        screen.wait_rows(["SYN-RC-06"])
        self.assertNotIn("복합 조건 오류", screen.filter_line())
        screen.finish()

    def test_rc04_a_stored_layout_gains_the_columns_at_their_places(self):
        # A browser layout saved before these columns: the user's order (Name before ID) and hidden Age are kept;
        # the request columns join after Name, Confirm after RS; the other columns stay where they were.
        stored = {"version": 1, "modes": {
            "Radiology": {"order": ["name", "id", "rs", "date", "modality", "age"], "hidden": ["age"]},
            "Technician": {"order": [], "hidden": []}}}
        screen = self.boot(Server(rows=ROWS), storage={layout_key(SESSION_A): json.dumps(stored)})
        screen.wait_rows(IDS)
        self.assertEqual(["Name", "ReqDate", "ReqDept", "ReqDoc", "Pt Class", "ID", "RS", "Confirm", "Read Req", "StudyDate", "Referred", "Modality"],
                         screen.heads()[:12])
        self.assertNotIn("Age", screen.heads())
        # The column chooser lists them in the same order; one can be turned off and on again.
        screen.page.get_by_role("button", name="Choose columns", exact=True).click()
        picker = screen.page.locator("#column-picker")
        labels = [t.strip() for t in picker.locator("label").all_inner_texts()]
        self.assertEqual(["Name (Required)", "ReqDate", "ReqDept", "ReqDoc", "Pt Class", "ID (Required)", "RS", "Confirm"], labels[:8])
        picker.get_by_role("checkbox", name="Pt Class", exact=True).uncheck()
        picker.get_by_role("button", name="Close", exact=True).click()
        until(lambda: "Pt Class" not in screen.heads(), 5, "Pt Class hidden")
        saved = json.loads(screen.page.evaluate("key => localStorage.getItem(key)", layout_key(SESSION_A)))
        self.assertEqual(["name", "reqDate", "reqDept", "reqDoc", "ptClass", "id", "rs", "confirm"], saved["modes"]["Radiology"]["order"][:8])
        self.assertEqual(["age", "ptClass"], saved["modes"]["Radiology"]["hidden"])
        screen.finish()



# Referred (after StudyDate): when the referring hospital's Gateway sent the study (server row referredAt).
def referred_row(uid, pid, referred=None):
    body = row(uid, pid)
    body["referredAt"] = referred
    return body


REFERRED_ROWS = [
    referred_row("2.25.951", "SYN-RF-01", "2026-11-19T23:10:40.000Z"),
    # The same minute as SYN-RF-01, twenty seconds earlier: the cells read alike, the sort still knows which came first.
    referred_row("2.25.952", "SYN-RF-02", "2026-11-19T23:10:20.000Z"),
    referred_row("2.25.953", "SYN-RF-03", "2026-11-20T02:45:00.000Z"),
    # Not sent through a Gateway (a device sending directly): no time, blank cell.
    referred_row("2.25.954", "SYN-RF-04", None),
]
REFERRED_IDS = ["SYN-RF-01", "SYN-RF-02", "SYN-RF-03", "SYN-RF-04"]
REFERRED_HEADS = ["No", "Assigned Reader", "RS", "Confirm", "Read Req", "StudyDate", "Referred", "ID", "Name", "ReqDate", "ReqDept", "ReqDoc",
                 "Pt Class", "Age", "StudyDesc", "Modality", "Hospital"]


class WorklistReferredColumnDOM(unittest.TestCase):
    # The harness's browser and boot only; that file's own cases are not run again here.
    setUpClass = classmethod(harness.MultiInstitutionWorklist.setUpClass.__func__)
    tearDownClass = classmethod(harness.MultiInstitutionWorklist.tearDownClass.__func__)
    boot = harness.MultiInstitutionWorklist.boot

    def test_rf01_default_columns_cells_and_header_help(self):
        screen = self.boot(Server(rows=REFERRED_ROWS))
        screen.wait_rows(REFERRED_IDS)
        self.assertEqual(REFERRED_HEADS, screen.heads())
        self.assertEqual({"SYN-RF-01": "2026-11-20 08:10", "SYN-RF-02": "2026-11-20 08:10", "SYN-RF-03": "2026-11-20 11:45",
                          "SYN-RF-04": ""}, screen.cells_by_id("Referred"))
        head = screen.table().locator('th[data-key="referredAt"]')
        self.assertIn("Gateway", head.get_attribute("title"))
        # A blank cell is "no first reception time recorded": it does not say the study never came through a Gateway.
        self.assertIn("비어 있음: 최초 Gateway 접수 시각이 기록되지 않은 검사", head.get_attribute("title"))
        self.assertNotIn("기록이 없는 검사", head.get_attribute("title"))
        # The value is data of the study: never handed to the screen's translation.
        cell = screen.data_row("SYN-RF-03").locator("td").nth(REFERRED_HEADS.index("Referred"))
        self.assertEqual("no", cell.get_attribute("translate"))
        screen.finish()

    def test_rf02_filter_and_sort_by_the_server_time(self):
        screen = self.boot(Server(rows=REFERRED_ROWS))
        screen.wait_rows(REFERRED_IDS)
        box = screen.filter_box("Referred")
        box.fill("2026-11-20 08")
        screen.wait_rows(["SYN-RF-01", "SYN-RF-02"])
        box.fill("2026-11-20 11:45")
        screen.wait_rows(["SYN-RF-03"])
        box.fill("2026-11-19")
        screen.wait_rows([])
        box.fill("")
        screen.wait_rows(REFERRED_IDS)
        # Ascending: the blank first, then by the time with its seconds (RF-02 before RF-01 in the same minute).
        screen.header("Referred").click()
        screen.wait_rows(["SYN-RF-04", "SYN-RF-02", "SYN-RF-01", "SYN-RF-03"])
        screen.header("Referred").click()
        screen.wait_rows(["SYN-RF-03", "SYN-RF-01", "SYN-RF-02", "SYN-RF-04"])
        screen.finish()

    def test_rf03_a_stored_layout_gains_referred_after_studydate(self):
        # A browser layout saved before this column: the user's order and hidden Age are kept; Referred joins after
        # StudyDate wherever the user put it.
        stored = {"version": 1, "modes": {
            "Radiology": {"order": ["name", "id", "date", "rs", "modality", "age"], "hidden": ["age"]},
            "Technician": {"order": [], "hidden": []}}}
        screen = self.boot(Server(rows=REFERRED_ROWS), storage={layout_key(SESSION_A): json.dumps(stored)})
        screen.wait_rows(REFERRED_IDS)
        self.assertEqual(["Name", "ReqDate", "ReqDept", "ReqDoc", "Pt Class", "ID", "StudyDate", "Referred", "RS", "Confirm", "Read Req", "Modality"],
                         screen.heads()[:12])
        screen.page.get_by_role("button", name="Choose columns", exact=True).click()
        picker = screen.page.locator("#column-picker")
        labels = [t.strip() for t in picker.locator("label").all_inner_texts()]
        self.assertEqual(["ID (Required)", "StudyDate", "Referred", "RS"], labels[5:9])
        picker.get_by_role("checkbox", name="Referred", exact=True).uncheck()
        picker.get_by_role("button", name="Close", exact=True).click()
        until(lambda: "Referred" not in screen.heads(), 5, "Referred hidden")
        saved = json.loads(screen.page.evaluate("key => localStorage.getItem(key)", layout_key(SESSION_A)))
        self.assertEqual(["id", "date", "referredAt", "rs"], saved["modes"]["Radiology"]["order"][5:9])
        self.assertEqual(["age", "referredAt"], saved["modes"]["Radiology"]["hidden"])
        screen.finish()

    def test_rf04_the_automatic_poll_refreshes_rows_in_place_by_the_same_rule(self):
        # The page's own clock drives the 30-second poll; the list is never reloaded by hand here.
        server = Server(rows=REFERRED_ROWS)
        screen = self.boot(server, clock_at=datetime.now(timezone.utc))
        screen.wait_rows(REFERRED_IDS)
        screen.header("Referred").click()
        screen.wait_rows(["SYN-RF-04", "SYN-RF-02", "SYN-RF-01", "SYN-RF-03"])
        reads = sum(1 for e in server.ledger if e["path"] == "/api/studies")
        # The same studies (no arrival, nothing removed), so the poll refreshes the rows in place. SYN-RF-04 was blank and
        # waiting; its first Gateway announce is recorded now, and the poll shows and sorts it like the first list.
        server.rows = [referred_row("2.25.951", "SYN-RF-01", "2026-11-19T23:10:40.000Z"),
                       referred_row("2.25.952", "SYN-RF-02", "2026-11-19T23:10:20.000Z"),
                       referred_row("2.25.953", "SYN-RF-03", "2026-11-20T02:45:00.000Z"),
                       referred_row("2.25.954", "SYN-RF-04", "2026-11-20T03:00:05.000Z")]
        screen.page.clock.run_for(31000)
        until(lambda: sum(1 for e in server.ledger if e["path"] == "/api/studies") > reads, 10, "a poll read the list")
        until(lambda: screen.cells_by_id("Referred")["SYN-RF-04"] == "2026-11-20 12:00", 10, "polled Referred")
        # Still ascending by the server time: the refreshed row now sorts last.
        screen.wait_rows(["SYN-RF-02", "SYN-RF-01", "SYN-RF-03", "SYN-RF-04"])
        screen.finish()

    def test_rf05_korean_screen_names_the_column_and_keeps_the_value(self):
        screen = self.boot(Server(rows=REFERRED_ROWS))
        screen.wait_rows(REFERRED_IDS)
        self.assertTrue(screen.page.evaluate("l => KinLanguage.restore({version: 1, worklist: l, reading: l})", "ko"))
        until(lambda: "병원 전송" in screen.heads(), 5, "Korean header")
        self.assertNotIn("Referred", screen.heads())
        cell = screen.data_row("SYN-RF-03").locator("td").nth(screen.heads().index("병원 전송"))
        self.assertEqual("2026-11-20 11:45", cell.inner_text().strip())
        self.assertIn("Gateway", screen.table().locator('th[data-key="referredAt"]').get_attribute("title"))
        self.assertIn("비어 있음: 최초 Gateway 접수 시각이 기록되지 않은 검사", screen.table().locator('th[data-key="referredAt"]').get_attribute("title"))
        self.assertTrue(screen.page.evaluate("l => KinLanguage.restore({version: 1, worklist: l, reading: l})", "en"))
        until(lambda: "Referred" in screen.heads(), 5, "English header")
        until(lambda: "Blank: the first Gateway reception time is not recorded for this study"
              in screen.table().locator('th[data-key="referredAt"]').get_attribute("title"), 5, "English header help")
        screen.finish()

    def test_rf06_export_list_writes_the_cell_text_and_the_blank(self):
        screen = self.boot(Server(rows=REFERRED_ROWS))
        screen.wait_rows(REFERRED_IDS)
        page = screen.page
        more = page.locator("#toolbar-more")
        if more.get_attribute("open") is None:
            more.locator(":scope > summary").click()
        page.locator("#worklist-export-open").click()
        dialog = page.locator("#worklist-export-dialog")
        for box in dialog.locator("input[type=checkbox]").all():
            box.set_checked(box.get_attribute("value") in ("id", "referredAt"))
        with page.expect_download() as info:
            dialog.locator("[data-export-run]").click()
        with open(info.value.path(), "rb") as file:
            lines = file.read()[3:].decode("utf-8").split("\r\n")
        # The list's own column order and words: the local time the cell shows, and nothing for a study with no time.
        self.assertEqual("Referred,ID", lines[0])
        self.assertEqual({"SYN-RF-01": "2026-11-20 08:10", "SYN-RF-02": "2026-11-20 08:10", "SYN-RF-03": "2026-11-20 11:45",
                          "SYN-RF-04": ""}, {pid: referred for referred, pid in (line.split(",") for line in lines[1:5])})
        self.assertEqual([""], lines[5:])
        screen.finish()


def read_row(uid, pid, request=None):
    body = row(uid, pid)
    body["readingRequest"] = request
    return body


READ_ROWS = [
    read_row("2.25.971", "SYN-RQ-01", {"at": "2026-11-21T05:03:40.000Z", "by": "SYN Dr. KIM <b>x</b>"}),
    read_row("2.25.972", "SYN-RQ-02"),
    read_row("2.25.973", "SYN-RQ-03", {"at": "2026-11-20T23:30:00.000Z", "by": "SYN Dr. LEE"}),
]
READ_IDS = ["SYN-RQ-01", "SYN-RQ-02", "SYN-RQ-03"]


class WorklistReadRequestColumnDOM(unittest.TestCase):
    # The harness's browser and boot only; that file's own cases are not run again here.
    setUpClass = classmethod(harness.MultiInstitutionWorklist.setUpClass.__func__)
    tearDownClass = classmethod(harness.MultiInstitutionWorklist.tearDownClass.__func__)
    boot = harness.MultiInstitutionWorklist.boot

    def cell(self, screen, pid, title="Read Req"):
        return screen.data_row(pid).locator("td").nth(screen.heads().index(title))

    def test_rq01_the_column_its_help_and_the_request_as_data(self):
        screen = self.boot(Server(rows=READ_ROWS))
        screen.wait_rows(READ_IDS)
        self.assertEqual(REFERRED_HEADS, screen.heads())
        self.assertEqual(["RS", "Confirm", "Read Req"], screen.heads()[2:5])
        # The request time in the browser's zone (Asia/Seoul); blank where the server sent no open request.
        self.assertEqual({"SYN-RQ-01": "2026-11-21 14:03", "SYN-RQ-02": "", "SYN-RQ-03": "2026-11-21 08:30"},
                         screen.cells_by_id("Read Req"))
        head = screen.table().locator('th[data-key="readReq"]')
        self.assertIn("진료과 의사가 이 검사의 판독을 의뢰한 시각", head.get_attribute("title"))
        self.assertIn("비어 있음: 의뢰가 없거나 판독문이 승인되어 의뢰가 닫힌 검사", head.get_attribute("title"))
        # Who asked is the title, as text (never markup); the time and the name are never handed to translation.
        mark = self.cell(screen, "SYN-RQ-01").locator(".read-req")
        self.assertEqual("SYN Dr. KIM <b>x</b>", mark.get_attribute("title"))
        self.assertEqual("title", mark.get_attribute("data-kin-keep"))
        self.assertEqual(0, self.cell(screen, "SYN-RQ-01").locator("b").count())
        self.assertEqual("no", mark.locator("span").get_attribute("translate"))
        self.assertEqual(["", "Requested", "None"], screen.filter_box("Read Req").locator("option").all_inner_texts())
        screen.finish()

    def test_rq02_requested_and_none_on_the_header_and_in_a_saved_compound_search(self):
        filters = [WorklistRequestColumnsDOM.compound("SYN REQUESTED", "and", [{"field": "readReq", "op": "eq", "value": "Requested"}]),
                   WorklistRequestColumnsDOM.compound("SYN NOT REQUESTED", "and", [{"field": "readReq", "op": "eq", "value": "None"}])]
        screen = self.boot(Server(rows=READ_ROWS, filters=filters))
        screen.wait_rows(READ_IDS)
        screen.filter_box("Read Req").select_option("Requested")
        screen.wait_rows(["SYN-RQ-01", "SYN-RQ-03"])
        screen.filter_box("Read Req").select_option("None")
        screen.wait_rows(["SYN-RQ-02"])
        screen.filter_box("Read Req").select_option("")
        screen.wait_rows(READ_IDS)
        # A saved search compares the same two words, not the time the cell shows.
        screen.menu("Filters").get_by_role("button", name=re.compile("^SYN REQUESTED, ")).click()
        screen.wait_rows(["SYN-RQ-01", "SYN-RQ-03"])
        screen.menu("Filters").get_by_role("button", name=re.compile("^SYN NOT REQUESTED, ")).click()
        screen.wait_rows(["SYN-RQ-02"])
        self.assertNotIn("복합 조건 오류", screen.filter_line())
        screen.finish()

    def test_rq03_a_request_closed_elsewhere_leaves_the_requested_filter_on_the_next_poll(self):
        # The page's own clock drives the 30-second poll; the list is never reloaded by hand here.
        server = Server(rows=READ_ROWS)
        screen = self.boot(server, clock_at=datetime.now(timezone.utc))
        screen.wait_rows(READ_IDS)
        screen.filter_box("Read Req").select_option("Requested")
        screen.wait_rows(["SYN-RQ-01", "SYN-RQ-03"])
        reads = sum(1 for e in server.ledger if e["path"] == "/api/studies")
        # The same studies: SYN-RQ-01's report was approved by another reader (no open request any more), and SYN-RQ-02
        # was asked for meanwhile. The poll refreshes both rows in place.
        server.rows = [read_row("2.25.971", "SYN-RQ-01"),
                       read_row("2.25.972", "SYN-RQ-02", {"at": "2026-11-21T06:00:00.000Z", "by": "SYN Dr. PARK"}),
                       read_row("2.25.973", "SYN-RQ-03", {"at": "2026-11-20T23:30:00.000Z", "by": "SYN Dr. LEE"})]
        screen.page.clock.run_for(31000)
        until(lambda: sum(1 for e in server.ledger if e["path"] == "/api/studies") > reads, 10, "a poll read the list")
        screen.wait_rows(["SYN-RQ-02", "SYN-RQ-03"])
        screen.filter_box("Read Req").select_option("")
        screen.wait_rows(READ_IDS)
        self.assertEqual({"SYN-RQ-01": "", "SYN-RQ-02": "2026-11-21 15:00", "SYN-RQ-03": "2026-11-21 08:30"},
                         screen.cells_by_id("Read Req"))
        screen.finish()

    def test_rq04_korean_screen_names_the_column_and_keeps_the_time_and_the_name(self):
        screen = self.boot(Server(rows=READ_ROWS))
        screen.wait_rows(READ_IDS)
        self.assertTrue(screen.page.evaluate("l => KinLanguage.restore({version: 1, worklist: l, reading: l})", "ko"))
        until(lambda: "판독 의뢰" in screen.heads(), 5, "Korean header")
        self.assertNotIn("Read Req", screen.heads())
        cell = self.cell(screen, "SYN-RQ-01", "판독 의뢰")
        self.assertEqual("2026-11-21 14:03", cell.inner_text().strip())
        self.assertEqual("SYN Dr. KIM <b>x</b>", cell.locator(".read-req").get_attribute("title"))
        self.assertIn("판독 의뢰: 진료과 의사가", screen.table().locator('th[data-key="readReq"]').get_attribute("title"))
        screen.filter_box("판독 의뢰").select_option("Requested")
        screen.wait_rows(["SYN-RQ-01", "SYN-RQ-03"])
        self.assertTrue(screen.page.evaluate("l => KinLanguage.restore({version: 1, worklist: l, reading: l})", "en"))
        until(lambda: "Read Req" in screen.heads(), 5, "English header")
        until(lambda: "Blank: no request, or the report was approved and the request closed"
              in screen.table().locator('th[data-key="readReq"]').get_attribute("title"), 5, "English header help")
        screen.wait_rows(["SYN-RQ-01", "SYN-RQ-03"])
        screen.finish()


if __name__ == "__main__":
    unittest.main()
