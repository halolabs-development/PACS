# coding: utf-8
"""Attach Document and the worklist row: after a document is attached (or withdrawn) from the Attach Document dialog, the
study's Count, Series and Modality cells show what the server now holds, without the reader pressing Refresh, and the
selected row, the sort and the filters stay as they were. A refused attachment changes no cell and is not shown as attached.
An attachment made elsewhere reaches Modality with the automatic poll, as it already reached Count and Series.

The page boots through its own boot() against the in-test server of multi_institution_worklist_dom_test.py, extended here
with the attachment routes; nothing of the page is cut out or replaced. The in-test server changes its own list rows when it
stores or withdraws a document, the way the archive's counts change; the expected cells are written here from those rows
(synthetic SYN-* data), never computed by product code. Auto Refresh is set to Manual in the dialog cases, so a cell that
changes was changed by the attachment's own list read, not by the poll.
"""
import json
import re
import unittest
from datetime import datetime, timezone
from urllib.parse import urlparse

from playwright.sync_api import expect
import multi_institution_worklist_dom_test as harness
from multi_institution_worklist_dom_test import Server, row, until

UID, OTHER, THIRD = "2.25.880001", "2.25.880002", "2.25.880003"
IDS_BY_UID = {UID: "SYN-AT-01", OTHER: "SYN-AT-02", THIRD: "SYN-AT-03"}
# A tiny valid PNG (1x1): sent as it is, the page does not redraw an unturned PNG.
PNG = bytes.fromhex("89504e470d0a1a0a0000000d4948445200000001000000010806000000"
                    "1f15c4890000000d49444154789c6360000002000154a24f5f0000000049454e44ae426082")


class AttachServer(Server):
    """The harness server with the attachment list, POST and withdrawal of one study. A stored document adds one series
    of one image and the OT modality to that study's list row; a withdrawal takes them out again."""

    def __init__(self, *, refuse=False, **kwargs):
        super().__init__(**kwargs)
        self.refuse, self.documents, self.posts = refuse, [], []
        self.hold_post, self.held_posts = False, []

    def instances(self, uid):
        """The study's instances as the archive lists them: the CT series, then one series per stored document."""
        def instance(series, sop, number, description):
            return {"0020000E": {"vr": "UI", "Value": [series]}, "00080018": {"vr": "UI", "Value": [sop]},
                    "00200011": {"vr": "IS", "Value": [number]}, "0008103E": {"vr": "LO", "Value": [description]},
                    "00200013": {"vr": "IS", "Value": [1]}}
        out = [instance(uid + ".1", uid + ".1.1", 1, "SYN AXIAL")]
        for index, d in enumerate(d for d in self.documents if d["uid"] == uid and d["state"] == "stored"):
            out.append(instance(uid + ".9%d" % index, uid + ".9%d.1" % index, "", "Attached Document"))
        return out

    def store(self, uid):
        document = {"id": "syn-doc-%d" % (len(self.documents) + 1), "uid": uid, "state": "stored", "name": "scan.png"}
        self.documents.append(document)
        self.counts(uid)
        return {"id": document["id"], "state": "stored", "fileName": document["name"]}

    def release_post(self):
        route, entry, uid = self.held_posts.pop(0)
        entry["status"] = 200
        route.fulfill(status=200, content_type="application/json", body=json.dumps(self.store(uid)))

    def scope(self, uid):
        return {"reportUid": uid, "groupId": None, "kind": "single", "part": None, "active": True,
                "sources": [{"studyUid": uid, "series": {"mode": "all", "uids": []}}], "generation": json.dumps(["single", None])}

    def counts(self, uid):
        target = next(r for r in self.rows if r["uid"] == uid)
        stored = [d for d in self.documents if d["uid"] == uid and d["state"] == "stored"]
        target["count"], target["series"] = 10 + len(stored), 1 + len(stored)
        target["modality"] = "CT,OT" if stored else "CT"

    def handle(self, route, request):
        # A document is sent as its bytes: the harness reads a body as text, so the upload is answered here.
        path = urlparse(request.url).path
        shown = re.fullmatch(r"/dicom-web/studies/([^/]+)/instances", path)
        if request.method == "GET" and shown and shown.group(1) in IDS_BY_UID:
            self.ledger.append({"method": "GET", "path": path, "query": "", "body": None, "status": 200})
            return route.fulfill(status=200, content_type="application/json", body=json.dumps(self.instances(shown.group(1))))
        if request.method == "POST" and path == "/api/dicom/lookup":
            # A thumbnail's picture: none in this harness (the card and its details are what the cases read).
            self.ledger.append({"method": "POST", "path": path, "query": "", "body": None, "status": 404})
            return route.fulfill(status=404, content_type="application/json", body=json.dumps({"code": "SYN_NOT_STUBBED"}))
        if request.method == "POST" and re.fullmatch(r"/api/studies/[^/]+/attachments", path):
            entry = {"method": "POST", "path": path, "query": "", "body": len(request.post_data_buffer or b""), "status": None}
            self.ledger.append(entry)
            if self.hold_post:
                self.posts.append(path.split("/")[3])
                self.held_posts.append((route, entry, path.split("/")[3]))
                return None

            def answer(status, payload):
                entry["status"] = status
                return route.fulfill(status=status, content_type="application/json", body=json.dumps(payload))
            return self.api(route, "POST", entry["path"], "", None, entry, answer)
        return super().handle(route, request)

    def api(self, route, method, path, query, body, entry, answer):
        listed = re.fullmatch(r"/api/studies/([^/]+)/attachments", path)
        withdrawn = re.fullmatch(r"/api/studies/([^/]+)/attachments/([^/]+)/withdraw", path)
        if listed and method == "GET":
            uid = listed.group(1)
            rows = [{"id": d["id"], "uid": uid, "fileName": d["name"], "kind": "image", "state": d["state"],
                     "createdBy": "syn-reader-a@synthetic.test", "createdAt": "2026-11-20T01:00:00.000Z",
                     "withdrawReason": d.get("reason")} for d in self.documents if d["uid"] == uid]
            return answer(200, {"uid": uid, "scope": self.scope(uid), "attachments": rows, "canWithdraw": True, "canAttach": True})
        if listed and method == "POST":
            uid = listed.group(1)
            self.posts.append(uid)
            if self.refuse:
                return answer(400, {"message": "SYN refused: the file is not a picture"})
            return answer(200, self.store(uid))
        if withdrawn and method == "POST":
            uid, ident = withdrawn.groups()
            document = next(d for d in self.documents if d["id"] == ident)
            document.update(state="withdrawn", reason=json.loads(body)["reason"])
            self.counts(uid)
            return answer(200, {"id": ident, "state": "withdrawn"})
        return super().api(route, method, path, query, body, entry, answer)


def rows():
    return [row(UID, IDS_BY_UID[UID]), row(OTHER, IDS_BY_UID[OTHER], modality="MR"), row(THIRD, IDS_BY_UID[THIRD])]


class WorklistAttachRefreshDOM(unittest.TestCase):
    setUpClass = classmethod(harness.MultiInstitutionWorklist.setUpClass.__func__)
    tearDownClass = classmethod(harness.MultiInstitutionWorklist.tearDownClass.__func__)
    boot = harness.MultiInstitutionWorklist.boot

    def counts(self, screen, pid):
        cells = [screen.cells_by_id(title)[pid] for title in ("Count", "Series", "Modality")]
        return tuple(cells)

    def ready(self, server, **boot):
        screen = self.boot(server, **boot)
        screen.wait_rows(["SYN-AT-01", "SYN-AT-02", "SYN-AT-03"])
        screen.show_column("Count")
        screen.show_column("Series")
        return screen

    def select(self, screen, pid):
        cell = screen.data_row(pid).get_by_role("cell", name=pid, exact=True)
        cell.click()
        expect(screen.data_row(pid)).to_have_class(re.compile(r"\bsel\b"))

    def attach_from_row_menu(self, screen, pid):
        target = screen.data_row(pid)
        box = target.evaluate("tr => { const r = tr.getBoundingClientRect(); return { x: r.x, y: r.y }; }")
        target.dispatch_event("contextmenu", {"clientX": box["x"] + 5, "clientY": box["y"] + 5, "button": 2})
        with screen.page.expect_file_chooser() as chooser:
            screen.page.locator("#ctx [data-i]").filter(has_text=re.compile("^Attach Document$")).click()
        chooser.value.set_files([{"name": "scan.png", "mimeType": "image/png", "buffer": PNG}])
        dialog = screen.page.locator("#attach-document")
        expect(dialog).to_be_visible()
        dialog.locator("#attach-send").click()
        return dialog

    def show_thumbnails(self, screen):
        """The Thumbnail panel through the shipped Panel Settings dialog (its toolbar groups opened as a user does)."""
        page = screen.page
        for details in page.locator("details:has(#panel-settings-open)").all():
            if details.get_attribute("open") is None:
                details.locator(":scope > summary").click()
        page.locator("#panel-settings-open").click()
        dialog = page.get_by_role("dialog", name="Panel Settings", exact=True)
        dialog.get_by_role("checkbox", name="Thumbnail", exact=True).check()
        dialog.get_by_role("button", name="Close", exact=True).click()
        expect(dialog).to_be_hidden()
        for details in page.locator("details[open]:has(#panel-settings-open)").all()[::-1]:
            details.locator(":scope > summary").click()

    def list_reads(self, server):
        return sum(1 for e in server.ledger if e["path"] == "/api/studies" and e["status"])

    def test_at01_an_attachment_shows_the_servers_counts_and_modality_in_its_row_at_once(self):
        server = AttachServer(rows=rows())
        screen = self.ready(server)
        screen.set_manual_refresh()
        # The reader's own arrangement: a sort by ID (descending) and a Modality filter that keeps two rows, one selected.
        screen.filter_box("Modality").fill("CT")
        screen.wait_rows(["SYN-AT-01", "SYN-AT-03"])
        header = screen.header("ID")
        header.click(); header.click()
        screen.wait_rows(["SYN-AT-03", "SYN-AT-01"])
        self.select(screen, "SYN-AT-01")
        self.assertEqual(("10", "1", "CT"), self.counts(screen, "SYN-AT-01"))
        dialog = self.attach_from_row_menu(screen, "SYN-AT-01")
        expect(dialog.locator(".attach-files .attach-result")).to_have_text(["Attached"])
        self.assertEqual([UID], server.posts)
        # The server now holds one more series of one image and the OT modality; the row says so without Refresh.
        until(lambda: self.counts(screen, "SYN-AT-01") == ("11", "2", "CT,OT"), 10, "the attached study's row")
        self.assertEqual(("10", "1", "CT"), self.counts(screen, "SYN-AT-03"), "another study's row is as it was")
        dialog.locator("#attach-cancel").click()
        expect(dialog).to_be_hidden()
        screen.wait_rows(["SYN-AT-03", "SYN-AT-01"])
        expect(screen.data_row("SYN-AT-01")).to_have_class(re.compile(r"\bsel\b"))
        self.assertEqual("CT", screen.filter_box("Modality").input_value())
        screen.finish()

    def test_at02_a_refused_attachment_leaves_the_row_and_is_not_shown_attached(self):
        server = AttachServer(rows=rows(), refuse=True)
        screen = self.ready(server)
        screen.set_manual_refresh()
        self.select(screen, "SYN-AT-01")
        reads = self.list_reads(server)
        dialog = self.attach_from_row_menu(screen, "SYN-AT-01")
        expect(dialog.locator(".attach-files .attach-result")).to_have_text(["Failed — SYN refused: the file is not a picture"])
        expect(dialog.locator(".attach-attached li")).to_have_text(["아직 붙은 문서가 없습니다."])
        self.assertEqual(("10", "1", "CT"), self.counts(screen, "SYN-AT-01"))
        self.assertEqual(reads, self.list_reads(server), "nothing was stored, so the list is not read again")
        dialog.locator("#attach-cancel").click()
        expect(screen.data_row("SYN-AT-01")).to_have_class(re.compile(r"\bsel\b"))
        screen.finish()

    def test_at03_a_withdrawal_from_the_dialog_shows_the_servers_counts_again(self):
        server = AttachServer(rows=rows())
        screen = self.ready(server)
        screen.set_manual_refresh()
        self.select(screen, "SYN-AT-01")
        dialog = self.attach_from_row_menu(screen, "SYN-AT-01")
        until(lambda: self.counts(screen, "SYN-AT-01") == ("11", "2", "CT,OT"), 10, "the attached study's row")
        attached = dialog.locator(".attach-attached li").filter(has_text="scan.png")
        attached.get_by_role("button", name="Withdraw", exact=True).click()
        attached.get_by_role("textbox", name="철회 사유").fill("SYN wrong study")
        attached.locator("form").get_by_role("button", name="Withdraw", exact=True).click()
        expect(dialog.locator(".attach-attached li[data-state='withdrawn']")).to_have_count(1)
        until(lambda: self.counts(screen, "SYN-AT-01") == ("10", "1", "CT"), 10, "the row after the withdrawal")
        expect(screen.data_row("SYN-AT-01")).to_have_class(re.compile(r"\bsel\b"))
        dialog.locator("#attach-cancel").click()
        screen.finish()

    def test_at05_series_details_the_reader_opened_stay_open_when_the_attachment_redraws_the_series(self):
        server = AttachServer(rows=rows())
        screen = self.ready(server)
        screen.set_manual_refresh()
        self.show_thumbnails(screen)
        self.select(screen, "SYN-AT-01")
        cards = screen.page.locator("#thumbwrap .thumb-card")
        expect(cards).to_have_count(1)
        cards.nth(0).locator("details.thumb-details > summary").click()
        expect(cards.nth(0).locator("details.thumb-details")).to_have_attribute("open", "")
        dialog = self.attach_from_row_menu(screen, "SYN-AT-01")
        until(lambda: self.counts(screen, "SYN-AT-01") == ("11", "2", "CT,OT"), 10, "the attached study's row")
        # The list read draws the study's series again: the attached one joins, the opened details stay open.
        expect(cards).to_have_count(2)
        expect(cards.filter(has_text="SYN AXIAL").locator("details.thumb-details")).to_have_attribute("open", "")
        expect(cards.filter(has_text="Attached Document").locator("details.thumb-details")).not_to_have_attribute("open", "")
        dialog.locator("#attach-cancel").click()
        # Another study starts with its details closed.
        self.select(screen, "SYN-AT-03")
        expect(cards).to_have_count(1)
        expect(cards.nth(0).locator("details.thumb-details")).not_to_have_attribute("open", "")
        screen.finish()

    def test_at06_a_document_stored_after_the_dialog_closed_still_reaches_the_row(self):
        server = AttachServer(rows=rows())
        server.hold_post = True
        screen = self.ready(server)
        screen.set_manual_refresh()
        self.select(screen, "SYN-AT-01")
        dialog = self.attach_from_row_menu(screen, "SYN-AT-01")
        until(lambda: server.held_posts, 10, "the attachment request")
        dialog.locator("#attach-cancel").click()
        expect(dialog).to_be_hidden()
        reads = self.list_reads(server)
        server.release_post()
        until(lambda: self.list_reads(server) > reads, 10, "the list read after the stored answer")
        until(lambda: self.counts(screen, "SYN-AT-01") == ("11", "2", "CT,OT"), 10, "the attached study's row")
        expect(screen.data_row("SYN-AT-01")).to_have_class(re.compile(r"\bsel\b"))
        screen.finish()

    def test_at04_the_poll_brings_an_attachment_made_elsewhere_to_the_modality_too(self):
        server = AttachServer(rows=rows())
        screen = self.ready(server, clock_at=datetime.now(timezone.utc))
        self.select(screen, "SYN-AT-02")
        # Someone else attached a document to SYN-AT-01: the same studies, so the poll refreshes the rows in place.
        server.documents.append({"id": "syn-doc-x", "uid": UID, "state": "stored", "name": "elsewhere.png"})
        server.counts(UID)
        reads = self.list_reads(server)
        screen.page.clock.run_for(31000)
        until(lambda: self.list_reads(server) > reads, 10, "a poll read the list")
        # Count and Series were already refreshed in place by the poll; Modality now follows them.
        until(lambda: self.counts(screen, "SYN-AT-01")[:2] == ("11", "2"), 10, "the polled Count and Series")
        until(lambda: self.counts(screen, "SYN-AT-01") == ("11", "2", "CT,OT"), 10, "the polled Modality")
        expect(screen.data_row("SYN-AT-02")).to_have_class(re.compile(r"\bsel\b"))
        screen.finish()

    def test_at08_the_thumbnail_bar_reads_in_english_with_its_counts_and_descriptions_as_written(self):
        # The bar above the series (range, sort label and its three choices) is drawn from the page's template after the first
        # markup was read: an English screen reads it in English, the counts and series descriptions stay as written; no
        # choice reads it exactly as drawn.
        server = AttachServer(rows=rows())
        screen = self.ready(server)
        screen.set_manual_refresh()
        self.show_thumbnails(screen)
        self.select(screen, "SYN-AT-01")
        page = screen.page
        expect(page.locator("#thumbwrap .thumb-card")).to_have_count(1)
        bar = """() => { const w = document.querySelector('#thumbwrap'), sort = w.querySelector('#thumb-sort');
          return [w.querySelector('#thumb-range').textContent, sort.closest('label').firstChild.data, sort.getAttribute('aria-label'),
            ...[...sort.options].map(o => o.textContent)]; }"""
        korean = page.evaluate(bar)
        self.assertEqual(["시리즈 1–1 / 1", "정렬 ", "시리즈 정렬", "원래 순서", "번호 오름차순", "번호 내림차순"], korean)
        page.evaluate("() => KinLanguage.restore({version: 1, worklist: 'en', reading: 'en'})")
        self.assertEqual(["Series 1–1 / 1", "Sort ", "Sort Series", "Original Order", "Number ascending", "Number descending"],
                         page.evaluate(bar))
        page.evaluate("() => KinLanguage.restore({version: 1, worklist: null, reading: null})")
        self.assertEqual(korean, page.evaluate(bar))
        screen.finish()

if __name__ == "__main__":
    unittest.main(verbosity=2)
