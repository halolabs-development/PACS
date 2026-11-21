# coding: utf-8
"""FC-076 Attach Document on the served stack: a radiologist attaches a JPG and a PDF from the Radiology row menu of the
real worklist (the page redraws the JPG and sends it as PNG); the viewer shows the picture as a Secondary Capture series
that draws and the PDF in its document handler with the uploaded bytes; an administrator's withdrawal keeps the originals in the archive and takes both out of the
viewer's series, the SOP lookup and the worklist's counts.

Run in CI: `python tests/measurement_ci.py --profile attach-document` (validate.yml worklist-ux-measurements); on a
development stack: `python tests/e2e/test_attach_document.py`. Synthetic only: a run-unique study; cleanup removes its
attachment rows and their audit rows (the study fixture's own cleanup removes the study and its objects).
"""
from __future__ import annotations

import base64
import io
import json
import re
import unittest
import uuid
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

import pydicom
from playwright.sync_api import expect

from invariants_live import AUDIT_GUARD_OFF, AUDIT_GUARD_ON, psql
from test_dicom_pdf import DicomPdfE2E, PDF_CLASS, synthetic_pdf


class AttachDocumentE2E(DicomPdfE2E):
    # FC-076: a 16x8 synthetic JPEG (one flat colour) as a PC picture or scanner output would be.
    ATTACH_JPEG = base64.b64decode(
        "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwgIyYnKSopGR8tMC0oMCUoKSj/2wBDAQcHBwoIChMKChMoGhYaKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCj/wAARCAAIABADASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDgKKKK+eP2E//Z")

    @staticmethod
    def known_png():
        """A 4x2 RGB PNG whose eight pixels are distinct, known colours; returns the PNG and its pixels row by row."""
        import struct, zlib
        colours = [(255, 0, 0), (0, 255, 0), (0, 0, 255), (255, 255, 0), (0, 255, 255), (255, 0, 255), (40, 80, 120), (250, 200, 10)]
        pixels = b"".join(bytes(c) for c in colours)
        raw = b"".join(b"\x00" + pixels[y * 12:(y + 1) * 12] for y in range(2))
        chunk = lambda kind, data: struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xffffffff)
        png = (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", 4, 2, 8, 2, 0, 0, 0))
               + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b""))
        return png, pixels

    def attached_rows(self, uid):
        if not re.fullmatch(r"[0-9.]+", uid): raise RuntimeError("Refusing an unexpected synthetic value in SQL")
        rows = psql(f"""SELECT "fileName" || '|' || kind || '|' || id || '|' || "sopInstanceUid" || '|' || "seriesInstanceUid" || '|'
          || coalesce("orthancId",'') || '|' || state FROM "StudyAttachment" WHERE uid='{uid}' ORDER BY "fileName";""")
        return {row.split("|")[0]: dict(zip(("name", "kind", "id", "sop", "series", "orthanc", "state"), row.split("|"))) for row in rows if row}

    def shown_pixels(self, page, sop, size):
        """Wait until the active viewport shows `sop` at `size`; return the first pixels of the image it decoded."""
        page.wait_for_function("""([s,w,h])=>{const v=services.cornerstoneViewportService.getCornerstoneViewport(services.viewportGridService.getState().activeViewportId);
          const id=v?.getCurrentImageId?.(); const d=id&&v.getImageData?.()?.dimensions; return !!id&&id.includes(s)&&!!d&&d[0]===w&&d[1]===h;}""",
                               arg=[sop, size[0], size[1]], timeout=60000)
        # The decoder may hand the picture back with or without an alpha sample: read the colour samples of the first eight pixels.
        return page.evaluate("""([w,h])=>{const v=services.cornerstoneViewportService.getCornerstoneViewport(services.viewportGridService.getState().activeViewportId);
          const image=v.getCornerstoneImage?.()||v.csImage, data=image.getPixelData(), n=Math.round(data.length/(w*h)), out=[];
          for(let i=0;i<Math.min(8,w*h);i++) out.push(data[i*n],data[i*n+1],data[i*n+2]); return out;}""", [size[0], size[1]])

    # The worklist row's cells under the visible headers named `titles` (null when the header or the row is not shown).
    ROW_CELLS = """([uid, titles]) => { const body = document.querySelector('#rows'), table = body.closest('table');
      const head = [...table.tHead.rows[0].cells].map(c => [...c.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim());
      const tr = [...body.querySelectorAll('tr[data-uid]')].find(r => r.dataset.uid === uid);
      return titles.map(t => { const i = head.indexOf(t); return i < 0 || !tr ? null : tr.cells[i].innerText.replace(/\\s+/g, ' ').trim(); }); }"""
    ROW_TITLES = ["Count", "Series", "Modality"]

    def manual_with_counts(self, work):
        """Auto Refresh Manual (this window's own setting) and the Count and Series columns shown for this window, so a
        cell that changes was changed by the page's own list read after a write, not by the poll."""
        self.open_toolbar_group(work, "#worklist-refresh")
        expect(work.locator("#worklist-refresh")).to_be_enabled()
        work.locator("#worklist-refresh").select_option("0")
        self.close_toolbar_groups(work)
        self.open_toolbar_group(work, "#columnsettings")
        work.locator("#columnsettings").click()
        dialog = work.get_by_role("dialog", name=re.compile(r"^Worklist Columns"))
        for title in ("Count", "Series"):
            dialog.get_by_role("checkbox", name="Show " + title, exact=True).check()
        dialog.get_by_role("button", name="Apply for This Window", exact=True).click()
        expect(dialog).to_be_hidden()
        self.close_toolbar_groups(work)

    def row_shows(self, work, uid, expected):
        """Wait until the row's Count, Series and Modality cells are `expected` (the server's list answer)."""
        try:
            work.wait_for_function("([uid, titles, want]) => JSON.stringify((" + self.ROW_CELLS + ")([uid, titles])) === JSON.stringify(want)",
                                   arg=[uid, self.ROW_TITLES, expected], timeout=20000)
        except Exception:
            print("ROW CELLS " + json.dumps(dict(want=expected, shown=work.evaluate(self.ROW_CELLS, [uid, self.ROW_TITLES]))), flush=True)
            raise

    # A picture is a stack display set, which carries no SOPInstanceUID of its own (only a document set does): it is found
    # by the SOP of its instance.
    FIND_SET = "s=>services.displaySetService.getActiveDisplaySets().find(d=>d.SOPInstanceUID===s||(d.instances||d.images||[]).some(i=>i.SOPInstanceUID===s))"

    def display_set(self, page, source):
        page.wait_for_function("s=>!!(" + self.FIND_SET + ")(s)", arg=source["sop"], timeout=60000)
        return page.evaluate("s=>{const d=(" + self.FIND_SET + ")(s);"
                             "return {id:d.displaySetInstanceUID,handler:d.SOPClassHandlerId,study:d.StudyInstanceUID,series:d.SeriesInstanceUID,sop:s};}", source["sop"])

    def test_attach_01_jpg_png_and_pdf_open_in_the_viewer_and_a_withdrawal_takes_them_out(self):
        """FC-076 live: a radiologist attaches a JPG, a PNG of known pixels and a PDF from the Radiology row menu; Orthanc
        holds the PNG's pixels exactly and the viewer decodes them for the attached SOP; the JPG, sent by the page as a PNG,
        is a Secondary Capture stack at its size; the PDF opens with its bytes. After the withdrawal none is offered, the SOP lookup is refused
        and the worklist counts are back."""
        fixture = self.ct("ATTACH-" + uuid.uuid4().hex[:12], "current", "20260801")
        def cleanup():
            if not re.fullmatch(r"[0-9.]+", fixture.uid): raise RuntimeError("Refusing an unexpected synthetic value in SQL")
            psql(f"""BEGIN; DELETE FROM "StudyAttachment" WHERE uid='{fixture.uid}'; {AUDIT_GUARD_OFF}
              DELETE FROM "AuditLog" WHERE target='{fixture.uid}' AND action LIKE 'study.attachment.%'; {AUDIT_GUARD_ON} COMMIT;""")
        self.addCleanup(cleanup)
        pdf = synthetic_pdf(["KIN ATTACHED PAGE 1"])
        known, known_pixels = self.known_png()
        work = self.login(); self.manual_with_counts(work); row = self.select(work, fixture)
        counts = lambda answer: next((s["series"], s["count"]) for s in answer.body["studies"] if s["uid"] == fixture.uid)
        # The row's cells as the server's list gives them: Count, Series, Modality.
        listed = lambda: next([str(s["count"]), str(s["series"]), s["modality"]] for s in
                              self.stack.request("GET", "/studies?uids=" + fixture.uid, "doctor").body["studies"] if s["uid"] == fixture.uid)
        series_before = counts(self.stack.request("GET", "/studies?uids=" + fixture.uid, "doctor"))
        self.row_shows(work, fixture.uid, listed())
        box = row.evaluate("tr => { const r = tr.getBoundingClientRect(); return { x: r.x, y: r.y }; }")
        row.dispatch_event("contextmenu", {"clientX": box["x"] + 5, "clientY": box["y"] + 5, "button": 2})
        item = work.locator("#ctx [data-i]").filter(has_text=re.compile("^Attach Document$"))
        with work.expect_file_chooser() as chooser:
            item.click()
        chooser.value.set_files([{"name": "scan.jpg", "mimeType": "image/jpeg", "buffer": self.ATTACH_JPEG},
                                 {"name": "known.png", "mimeType": "image/png", "buffer": known},
                                 {"name": "referral.pdf", "mimeType": "application/pdf", "buffer": pdf}])
        dialog = work.locator("#attach-document")
        expect(dialog).to_be_visible()
        dialog.locator("#attach-send").click()
        expect(dialog.locator(".attach-files .attach-result")).to_have_text(["Attached"] * 3, timeout=60000)
        expect(dialog.locator(".attach-attached li")).to_have_count(3)
        rows = self.attached_rows(fixture.uid)
        # The JPG reached the server as the PNG the browser drew, under its PNG name.
        self.assertEqual({"scan.png": "stored", "known.png": "stored", "referral.pdf": "stored"}, {k: r["state"] for k, r in rows.items()})
        self.assertEqual((series_before[0] + 3, series_before[1] + 3),
                         counts(self.stack.request("GET", "/studies?uids=" + fixture.uid, "doctor")), "one series of one image each")
        # The same screen, with no Refresh and Auto Refresh Manual: the attached study's row now says what the server holds.
        after = listed()
        print("ATTACH row after " + json.dumps(after), flush=True)
        self.row_shows(work, fixture.uid, after)
        stored = pydicom.dcmread(io.BytesIO(self.stack.orthanc_bytes(f"/instances/{rows['referral.pdf']['orthanc']}/file")))
        self.assertEqual((str(stored.SOPClassUID), stored.SeriesDescription), (PDF_CLASS, "Attached Document"))
        self.assertEqual(stored.EncapsulatedDocument.rstrip(b"\0"), pdf.rstrip(b"\0"))
        picture = pydicom.dcmread(io.BytesIO(self.stack.orthanc_bytes(f"/instances/{rows['scan.png']['orthanc']}/file")))
        self.assertEqual((str(picture.SOPClassUID), picture.Rows, picture.Columns), ("1.2.840.10008.5.1.4.1.1.7", 8, 16))
        self.assertEqual(str(picture.StudyInstanceUID), fixture.uid)
        exact = pydicom.dcmread(io.BytesIO(self.stack.orthanc_bytes(f"/instances/{rows['known.png']['orthanc']}/file")))
        self.assertEqual((exact.Rows, exact.Columns, exact.SamplesPerPixel), (2, 4, 3))
        self.assertEqual(bytes(exact.PixelData)[:len(known_pixels)], known_pixels, "Orthanc holds the PNG's pixels exactly")
        dialog.locator("#attach-cancel").click()
        # The viewer: each picture is a stack series showing its own SOP; the PNG's decoded pixels are the known ones.
        page = self.launch_pdf_viewer(work, [fixture])
        image = self.place(page, {"sop": rows["scan.png"]["sop"]})
        self.assertEqual(image["handler"], "@ohif/extension-default.sopClassHandlerModule.stack")
        self.shown_pixels(page, rows["scan.png"]["sop"], (16, 8))
        self.place(page, {"sop": rows["known.png"]["sop"]})
        self.assertEqual(list(known_pixels), self.shown_pixels(page, rows["known.png"]["sop"], (4, 2)), "the viewer decodes the attached pixels")
        document = self.place(page, {"sop": rows["referral.pdf"]["sop"]})
        self.assertEqual(document["handler"], "@ohif/extension-dicom-pdf.sopClassHandlerModule.dicom-pdf")
        self.object_url(page)
        source = {"pdf": f"/instances/{rows['referral.pdf']['orthanc']}/pdf"}
        read = self.bound_read(page, source)
        self.assertEqual(read.status, 200); self.assertEqual(read.body().rstrip(b"\0"), pdf.rstrip(b"\0"))
        page.close()
        # The withdrawal (an administrator of the owning institution) keeps the originals and takes them out.
        for name in rows:
            answer = self.stack.request("POST", f"/studies/{fixture.uid}/attachments/{rows[name]['id']}/withdraw", "jmryu",
                                        {"reason": "SYN wrong document"})
            self.assertEqual(answer.status, 200, answer.text)
        self.assertEqual({"withdrawn"}, {r["state"] for r in self.attached_rows(fixture.uid).values()})
        self.assertEqual(series_before, counts(self.stack.request("GET", "/studies?uids=" + fixture.uid, "doctor")))
        self.assertEqual(200, self.stack._orthanc_request("GET", f"/instances/{rows['referral.pdf']['orthanc']}").status, "the original stays")
        page = self.launch_pdf_viewer(work, [fixture])
        offered = page.evaluate("()=>services.displaySetService.getActiveDisplaySets().flatMap(d=>[d.SOPInstanceUID,...(d.instances||d.images||[]).map(i=>i.SOPInstanceUID)])")
        for name in rows: self.assertNotIn(rows[name]["sop"], offered, name)
        page.close()
        for name in rows:
            lookup = self.stack.request("POST", "/dicom/lookup", "doctor", {"studyUid": fixture.uid, "sopUid": rows[name]["sop"]})
            self.assertEqual(403, lookup.status, f"a withdrawn {name} is not looked up for the viewer")


    def attach_files(self, work, fixture, files):
        """Attach `files` ([name, type, bytes]) to `fixture` from the Radiology row menu, as a reader does; returns its rows."""
        row = self.select(work, fixture)
        box = row.evaluate("tr => { const r = tr.getBoundingClientRect(); return { x: r.x, y: r.y }; }")
        row.dispatch_event("contextmenu", {"clientX": box["x"] + 5, "clientY": box["y"] + 5, "button": 2})
        with work.expect_file_chooser() as chooser:
            work.locator("#ctx [data-i]").filter(has_text=re.compile("^Attach Document$")).click()
        chooser.value.set_files([{"name": n, "mimeType": t, "buffer": b} for n, t, b in files])
        dialog = work.locator("#attach-document")
        dialog.locator("#attach-send").click()
        expect(dialog.locator(".attach-files .attach-result")).to_have_text(["Attached"] * len(files), timeout=60000)
        dialog.locator("#attach-cancel").click()
        expect(dialog).to_be_hidden()
        return self.attached_rows(fixture.uid)

    # What each viewport shows once every one of them has an image: its display set's study, modality and description.
    # (An expression written into each page function: the viewer's CSP refuses eval.)
    CELLS = """[...services.viewportGridService.getState().viewports.values()].sort((a,b)=>a.y-b.y||a.x-b.x).map(cell=>{
      const id=services.cornerstoneViewportService.getCornerstoneViewport(cell.viewportId)?.getCurrentImageId?.();
      const set=services.displaySetService.getDisplaySetByUID((cell.displaySetInstanceUIDs||[])[0]);
      return {image:!!id,study:set?.StudyInstanceUID,modality:set?.Modality,description:set?.SeriesDescription,series:set?.SeriesInstanceUID};})"""

    def shown(self, page, count):
        """At least `count` viewports, each with an image (the protocol may make more). Until the viewer has made its
        services and grid, reading them throws; that is "not yet"."""
        try:
            page.wait_for_function("n=>{try{const cells=" + self.CELLS + ";return cells.length>=n&&cells.every(c=>c.image);}catch(_){return false;}}",
                                   arg=count, timeout=60000)
        except Exception:
            seen = page.evaluate("()=>{try{return " + self.CELLS + ";}catch(e){return String(e);}}")
            print("FIRST DISPLAY not shown " + json.dumps(dict(url=page.url, want=count, cells=seen)), flush=True)
            folder = Path(__file__).parent / "artifacts" / "attach-document-ci"; folder.mkdir(parents=True, exist_ok=True)
            page.screenshot(path=str(folder / f"first-display-not-shown-{count}.png"))
            raise
        return page.evaluate("()=>" + self.CELLS)

    def test_attach_02_the_viewer_opens_on_the_images_not_on_an_attached_picture(self):
        """An attached picture is a Secondary Capture series with no Series Number of its own. Opening the study puts the
        study's images in its first viewport, with a prior (worklist double-click, hpCompare) and alone (by address, the
        default protocol); the attachment stays one more series of the study. The reader's own choices are kept: a
        layout saved with the attachment restores it, and a series named in the address is shown first."""
        patient = "ATTFIRST-" + uuid.uuid4().hex[:10]
        prior, current = self.ct(patient, "past", "20260701"), self.ct(patient, "current", "20260801")
        def cleanup():
            for uid in (prior.uid, current.uid):
                if not re.fullmatch(r"[0-9.]+", uid): raise RuntimeError("Refusing an unexpected synthetic value in SQL")
                psql(f"""BEGIN; DELETE FROM "StudyAttachment" WHERE uid='{uid}'; {AUDIT_GUARD_OFF}
                  DELETE FROM "AuditLog" WHERE target='{uid}' AND action LIKE 'study.attachment.%'; {AUDIT_GUARD_ON} COMMIT;""")
        self.addCleanup(cleanup)
        known, _ = self.known_png()
        work = self.login()
        attached, sops = {}, {}
        for fixture in (prior, current):
            rows = self.attach_files(work, fixture, [("consent.png", "image/png", known)])
            self.assertEqual({"stored"}, {r["state"] for r in rows.values()})
            attached[fixture.uid], sops[fixture.uid] = rows["consent.png"]["series"], rows["consent.png"]["sop"]
            stored = pydicom.dcmread(io.BytesIO(self.stack.orthanc_bytes(f"/instances/{rows['consent.png']['orthanc']}/file")))
            print("ATTACHED picture Series Number", repr(stored.get("SeriesNumber")), flush=True)
        # The worklist's own opening: the current study with its prior (hpCompare; the pinned protocol makes a 2x2 of two
        # series each). Each study's first viewport shows its CT; the attachments may follow.
        row = self.select(work, current)
        with work.context.expect_page(timeout=20000) as opened:
            row.dblclick()
        viewer = opened.value
        viewer.wait_for_url("**/ohif/viewer?**", timeout=30000)
        self.assertEqual(parse_qs(urlsplit(viewer.url).query).get("hangingProtocolId"), ["@ohif/hpCompare"])
        cells = self.shown(viewer, 2)
        print("FIRST DISPLAY worklist opening " + json.dumps(cells), flush=True)
        first = {}
        for cell in cells: first.setdefault(cell["study"], cell)
        self.assertEqual({current.uid, prior.uid}, set(first))
        for study, cell in first.items():
            self.assertEqual(("CT", False), (cell["modality"], cell["series"] == attached[study]), cells)
        offered = viewer.evaluate("()=>services.displaySetService.getActiveDisplaySets().map(d=>d.SeriesInstanceUID)")
        self.assertTrue(set(attached.values()) <= set(offered), "the attachments stay series of their studies")
        viewer.close()
        # By address, the current study alone (the default protocol).
        page = work.context.new_page()
        page.goto(self.stack.proxy + "/ohif/viewer?StudyInstanceUIDs=" + current.uid)
        cells = self.shown(page, 1)
        print("FIRST DISPLAY address opening " + json.dumps(cells), flush=True)
        self.assertEqual((current.uid, "CT"), (cells[0]["study"], cells[0]["modality"]), cells)
        # The reader's own choices stay: a layout saved with the attachment in the cell restores it.
        self.place(page, {"sop": sops[current.uid]})
        page.wait_for_function("()=>JSON.stringify(" + self.CELLS + ").includes('Attached Document')", timeout=60000)
        self.action(page, '저장', '저장했습니다')
        page.reload(); self.shown(page, 1)
        self.action(page, '복원', '적용했습니다')
        page.wait_for_function("series=>(" + self.CELLS + ")[0]?.series===series", arg=attached[current.uid], timeout=60000)
        page.close()
        # A series named in the address is the first display even when it is the attached picture.
        page = work.context.new_page()
        page.goto(self.stack.proxy + "/ohif/viewer?StudyInstanceUIDs=" + current.uid + "&initialSeriesInstanceUID=" + attached[current.uid])
        cells = self.shown(page, 1)
        self.assertEqual((current.uid, attached[current.uid]), (cells[0]["study"], cells[0]["series"]), cells)
        page.close()


def load_tests(loader, tests, pattern):
    return unittest.TestSuite(AttachDocumentE2E(name) for name in loader.getTestCaseNames(AttachDocumentE2E) if name.startswith("test_attach_"))


if __name__ == "__main__": unittest.main(verbosity=2)