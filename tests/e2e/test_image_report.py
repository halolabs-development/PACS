"""Image Report on the real stack: draw on the breast diagram, attach to the report draft, approve, and see the drawing of
that version in the print preview, the History and the clinician's report read.

Real BFF, API, database and signing, one synthetic study. The reader opens it, types Findings, opens Image Report, drags an
ellipse and places a Text label on the breast diagram, and presses Attach to Report (one draft write); Approve makes the
signed version that holds the drawing. The print preview (Print) shows it after Conclusion, History shows it on that
version, and the clinician's report read of the same study carries it. Window, marks, Text, backgrounds, saved images and
the view-only window are page cases in tests/image_report_dom_test.py; the draft and commit boundary is
tests/emr/d/image_report_pg_test.cjs.

Run in CI: `python tests/measurement_ci.py --profile image-report` (Focused integration, dispatch only); on a development
stack: `python tests/e2e/test_image_report.py`.
"""
from __future__ import annotations

import base64
import re
import sys
import unittest
import uuid

from playwright.sync_api import expect
from test_template_preservation import TemplatePreservationE2E

FINDINGS = "SYN IMAGE REPORT FINDINGS"
LABEL = "Mass 1.5 cm"
# The picture on a canvas or an image element: the extent of the drawn image (grey above the black fill), the centre of its
# white landmark relative to that extent, and the count of the Red mark's pixels.
PICTURE = """source => { const c = document.createElement('canvas'); c.width = source.naturalWidth || source.width;
  c.height = source.naturalHeight || source.height; const g = c.getContext('2d'); g.drawImage(source, 0, 0);
  const d = g.getImageData(0, 0, c.width, c.height).data; let x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1, n = 0, x = 0, y = 0, red = 0;
  for (let j = 0; j < c.height; j++) for (let i = 0; i < c.width; i++) { const k = (j * c.width + i) * 4, r = d[k], gr = d[k + 1], b = d[k + 2];
    if (r > 200 && gr < 90 && b < 90) red++;
    else if (Math.abs(r - gr) < 8 && Math.abs(gr - b) < 8 && r > 30) { x0 = Math.min(x0, i); y0 = Math.min(y0, j); x1 = Math.max(x1, i); y1 = Math.max(y1, j);
      if (r > 240) { n++; x += i; y += j; } } }
  return { width: x1 - x0 + 1, height: y1 - y0 + 1, white: n, wx: n ? (x / n - x0) / (x1 - x0 + 1) : null, wy: n ? (y / n - y0) / (y1 - y0 + 1) : null, red }; }"""


class ImageReportE2E(TemplatePreservationE2E):
    def drag(self, page, x0, y0, x1, y1):
        box = page.locator("#image-report-canvas").bounding_box()
        at = lambda fx, fy: (box["x"] + box["width"] * fx, box["y"] + box["height"] * fy)
        page.mouse.move(*at(x0, y0))
        page.mouse.down()
        for step in range(1, 6):
            page.mouse.move(*at(x0 + (x1 - x0) * step / 5, y0 + (y1 - y0) * step / 5))
        page.mouse.up()

    def test_image_report_01_draw_attach_approve_preview_history_and_clinician(self):
        patient = "IMG-" + uuid.uuid4().hex[:12]
        fixture = self.fixture(patient_id=patient)
        page = self.login()
        page.locator('#filterrow [data-f="id"]').fill(patient)
        row = page.locator(f'#rows tr[data-uid="{fixture.uid}"]')
        row.click()
        expect(row).to_have_class(re.compile(r"\bsel\b"))
        expect(page.locator("#findings")).to_be_editable()
        with page.expect_response(lambda r: r.request.method == "PUT" and r.url.endswith(f"/studies/{fixture.uid}/report")
                                  and FINDINGS in (r.request.post_data or ""), timeout=45000) as typed:
            page.locator("#findings").fill(FINDINGS)
        self.assertEqual(typed.value.status, 200)

        # Draw on the breast diagram and attach: one draft write carrying the drawing.
        page.locator("#report-image-report").click()
        dialog = page.locator("#image-report")
        expect(dialog).to_be_visible()
        expect(dialog.locator(".ir-study")).to_contain_text(patient)
        dialog.locator("label", has_text="Breast diagram").locator("input").check()
        dialog.locator("label", has_text="Ellipse").locator("input").check()
        self.drag(page, 0.62, 0.3, 0.74, 0.42)
        dialog.locator("label", has_text=re.compile(r"^\s*Text$")).locator("input").check()
        dialog.get_by_role("textbox", name="Text").fill(LABEL)
        box = page.locator("#image-report-canvas").bounding_box()
        page.mouse.click(box["x"] + box["width"] * 0.76, box["y"] + box["height"] * 0.36)
        with page.expect_response(lambda r: r.request.method == "PUT" and r.url.endswith(f"/studies/{fixture.uid}/report")
                                  and '"drawing"' in (r.request.post_data or "")) as attached:
            dialog.get_by_role("button", name="Attach to Report").click()
        self.assertEqual(attached.value.status, 200, attached.value.text()[:300])
        drawing_id = attached.value.json()["drawn"]["added"]
        expect(dialog.locator("#image-report-attached figure")).to_have_count(1)
        dialog.get_by_role("button", name="Close").click()
        expect(page.locator("#report-image-attached figure")).to_have_count(1)

        # Approve: the signed version holds the drawing.
        with page.expect_response(lambda r: r.request.method == "POST"
                                  and r.url.endswith(f"/studies/{fixture.uid}/report/commit")) as reply:
            page.locator("#b-approve").click()
        self.assertEqual(reply.value.status, 201, reply.value.text()[:300])
        version = self.versions(fixture)[-1]
        self.assertEqual(version["findings"], FINDINGS)
        self.assertEqual([d["id"] for d in version["drawings"]], [drawing_id])

        # History: the version shows its drawing.
        self.open_toolbar_group(page, "#b-history")
        page.locator("#b-history").click()
        picture = page.locator(f'#hist-body img[data-drawing="{drawing_id}"]')
        expect(picture).to_have_attribute("src", re.compile(r"^blob:"))
        page.locator("#hist-close").click()

        # Print preview: the drawing right after Conclusion.
        self.open_toolbar_group(page, "#b-print")
        page.locator("#b-print").click()
        paper = page.frame_locator("#report-preview iframe")
        expect(paper.locator("section.drawings h2")).to_contain_text("Image Report")
        expect(paper.locator("section.drawings img")).to_have_count(1)
        expect(paper.locator("section.drawings img")).to_have_attribute("src", re.compile(r"^blob:"))
        # The real approval reaches the paper as the reader's local date and time, never as a UTC date.
        expect(paper.locator("header")).to_contain_text(re.compile(r"승인일시: \d{4}-\d{2}-\d{2} \d{2}:\d{2}"))
        expect(paper.locator("header")).not_to_contain_text("UTC")

        page.keyboard.press("Escape")
        expect(page.locator("#report-preview")).to_be_hidden()
        # The clinician's report read of the same study carries the drawing of that version.
        self.stack.create_test_identity("img-clinician", ["clinician"], "hallym")
        read = self.stack.request("GET", f"/clinician/studies/{fixture.uid}/report", "img-clinician")
        self.assertEqual(read.status, 200, str(read.body)[:300])
        self.assertEqual([d["id"] for d in read.body["drawings"]], [drawing_id])
        self.assertTrue(base64.b64decode(read.body["drawings"][0]["png"]).startswith(b"\x89PNG"))

        # An amendment that only removes the drawing: the text is unchanged, Approve is the amendment, the version before
        # it keeps the drawing.
        page.locator("#report-image-report").click()
        expect(dialog.locator("#image-report-attached figure")).to_have_count(1)
        # The approved report is mine and inside its amendment window: the window takes edits (it says why when it does not).
        expect(dialog.locator("#image-report-readonly")).to_have_text("")
        try:
            with page.expect_response(lambda r: r.request.method == "PUT" and r.url.endswith(f"/studies/{fixture.uid}/report")
                                      and '"removeDrawing"' in (r.request.post_data or "")) as removed:
                dialog.locator(f'#image-report-attached button[data-drawing="{drawing_id}"]').click()
        except Exception as error:
            raise AssertionError("Remove sent no draft write; the window says %r" % dialog.locator("#image-report-status").text_content()) from error
        self.assertEqual(removed.value.status, 200, removed.value.text()[:300])
        expect(dialog.locator("#image-report-attached figure")).to_have_count(0)
        dialog.get_by_role("button", name="Close").click()
        expect(page.locator("#b-approve")).to_be_enabled()
        with page.expect_response(lambda r: r.request.method == "POST"
                                  and r.url.endswith(f"/studies/{fixture.uid}/report/commit")) as amended:
            page.locator("#b-approve").click()
        self.assertEqual(amended.value.status, 201, amended.value.text()[:300])
        rows = self.versions(fixture)
        self.assertEqual((rows[-1]["action"], rows[-1]["findings"], rows[-1].get("drawings")), ("amend", FINDINGS, None))
        self.assertEqual([d["id"] for d in rows[-2]["drawings"]], [drawing_id])

    def mammogram(self, fixture):
        """A For Presentation mammogram in the fixture's study, shaped as modalities store one: no patient plane (no
        IOP/IPP/Frame of Reference), ImagerPixelSpacing, PatientOrientation, laterality and view. Stored over Orthanc REST."""
        import io
        from pydicom import dcmread
        from pydicom.dataset import Dataset
        from pydicom.uid import generate_uid
        rows = self.stack._orthanc_request("POST", "/tools/lookup", fixture.uid.encode("ascii")).body
        study_id = next(row["ID"] for row in rows if row["Type"] == "Study")
        first = self.stack._orthanc_request("GET", f"/studies/{study_id}/instances").body[0]["ID"]
        ds = dcmread(io.BytesIO(self.stack.orthanc_bytes(f"/instances/{first}/file")))
        ds.SOPClassUID = ds.file_meta.MediaStorageSOPClassUID = "1.2.840.10008.5.1.4.1.1.1.2"
        ds.SOPInstanceUID = ds.file_meta.MediaStorageSOPInstanceUID = generate_uid()
        ds.SeriesInstanceUID, ds.Modality, ds.SeriesNumber, ds.InstanceNumber = generate_uid(), "MG", 7, 1
        for tag in ("ImagePositionPatient", "ImageOrientationPatient", "FrameOfReferenceUID", "PixelSpacing", "SliceThickness",
                    "SliceLocation", "PositionReferenceIndicator", "NumberOfFrames"):
            if tag in ds:
                delattr(ds, tag)
        ds.ImageType = ["ORIGINAL", "PRIMARY"]
        ds.ImagerPixelSpacing, ds.PresentationIntentType = [0.1, 0.1], "FOR PRESENTATION"
        # 128 × 128 stored pixels: grey tissue with a white landmark in the upper left of the stored image.
        import numpy as np
        from pydicom.uid import ExplicitVRLittleEndian
        for tag in ("RescaleSlope", "RescaleIntercept", "RescaleType", "VOILUTFunction", "SmallestImagePixelValue", "LargestImagePixelValue",
                    "PixelPaddingValue", "WindowCenterWidthExplanation"):
            if tag in ds:
                delattr(ds, tag)
        pixels = np.full((128, 128), 300, dtype="<u2")
        pixels[10:40, 10:40] = 1000
        ds.Rows = ds.Columns = 128
        ds.SamplesPerPixel, ds.PhotometricInterpretation = 1, "MONOCHROME2"
        ds.BitsAllocated = ds.BitsStored = 16
        ds.HighBit, ds.PixelRepresentation = 15, 0
        ds.WindowCenter, ds.WindowWidth = 500, 1000
        ds.PixelData = pixels.tobytes()
        ds.file_meta.TransferSyntaxUID = ExplicitVRLittleEndian
        ds.is_little_endian, ds.is_implicit_VR = True, False
        ds.ImageLaterality, ds.ViewPosition, ds.PartialView, ds.PatientOrientation = "L", "CC", "NO", ["A", "R"]
        code = Dataset()
        code.CodingSchemeDesignator, code.CodeValue, code.CodeMeaning = "SCT", "399162004", "CC"
        ds.ViewCodeSequence = [code]
        stream = io.BytesIO()
        ds.save_as(stream, write_like_original=False)
        self.assertEqual(self.stack._orthanc_request("POST", "/instances", stream.getvalue()).status, 200)
        return ds

    def test_image_report_02_mammogram_key_image_is_the_saved_image_drawn_and_attached(self):
        patient = "IMGMG-" + uuid.uuid4().hex[:12]
        fixture = self.fixture(patient_id=patient)
        mg = self.mammogram(fixture)
        # The reader's Key Image on the mammogram, through the viewer's own API (the viewer's Add Key Image on breast images
        # is tests/e2e/test_viewer_mg.py): the server reads the stored original and keeps it.
        body = {"requestId": str(uuid.uuid4()), "item": dict(schemaVersion=1, kind="key", seriesUid=str(mg.SeriesInstanceUID),
                                                           sopUid=str(mg.SOPInstanceUID), frame=1, title="MG L CC key", description="")}
        saved = self.stack.request("POST", f"/studies/{fixture.uid}/viewer-items", "doctor", body)
        self.assertEqual(saved.status, 200, str(saved.body)[:300])
        key = saved.body["id"]

        page = self.login()
        page.locator('#filterrow [data-f="id"]').fill(patient)
        row = page.locator(f'#rows tr[data-uid="{fixture.uid}"]')
        row.click()
        expect(row).to_have_class(re.compile(r"\bsel\b"))
        expect(page.locator("#findings")).to_be_editable()
        with page.expect_response(lambda r: r.request.method == "PUT" and r.url.endswith(f"/studies/{fixture.uid}/report")
                                  and FINDINGS in (r.request.post_data or ""), timeout=45000) as typed:
            page.locator("#findings").fill(FINDINGS)
        self.assertEqual(typed.value.status, 200)

        page.locator("#report-image-report").click()
        dialog = page.locator("#image-report")
        expect(dialog).to_be_visible()
        saved_image = dialog.locator("label", has_text="Saved image (this study)").locator("input")
        expect(saved_image).to_be_enabled(timeout=30000)
        with page.expect_response(lambda r: "/frames/0/preview" in r.url) as frame:
            saved_image.check()
        self.assertEqual(frame.value.status, 200)
        expect(dialog.locator("#image-report-status")).not_to_contain_text("저장한 영상", timeout=30000)
        # The canvas shows the stored mammogram as stored: square, the landmark in its upper left.
        shown = page.locator("#image-report-canvas").evaluate(PICTURE)
        self.assertGreater(shown["white"], 0, shown)
        self.assertAlmostEqual(shown["width"] / shown["height"], 1, delta=0.03, msg=shown)
        self.assertLess(shown["wx"], 0.4, shown); self.assertLess(shown["wy"], 0.4, shown)
        dialog.locator("label", has_text="Red").locator("input").check()
        dialog.locator("label", has_text="Ellipse").locator("input").check()
        self.drag(page, 0.55, 0.55, 0.75, 0.75)
        with page.expect_response(lambda r: r.request.method == "PUT" and r.url.endswith(f"/studies/{fixture.uid}/report")
                                  and '"drawing"' in (r.request.post_data or "")) as attached:
            dialog.get_by_role("button", name="Attach to Report").click()
        self.assertEqual(attached.value.status, 200, attached.value.text()[:300])
        drawing_id = attached.value.json()["drawn"]["added"]
        expect(dialog.locator("#image-report-attached figure")).to_have_count(1)
        expect(dialog.locator("#image-report-attached")).to_contain_text("Saved image · frame 1")

        # The attached drawing names the stored mammogram it was drawn on: the key, its series, SOP and frame.
        read = self.stack.request("GET", f"/studies/{fixture.uid}/report/drawings", "doctor")
        self.assertEqual(read.status, 200, str(read.body)[:300])
        drawing = next(d for d in read.body["draft"]["drawings"] if d["id"] == drawing_id)
        self.assertEqual(drawing["background"], "image")
        self.assertEqual({k: drawing["source"][k] for k in ("keyImageId", "keyImageRevision", "seriesUid", "sopUid", "frame")},
                         {"keyImageId": key, "keyImageRevision": saved.body["revision"], "seriesUid": str(mg.SeriesInstanceUID),
                          "sopUid": str(mg.SOPInstanceUID), "frame": 1})
        dialog.get_by_role("button", name="Close").click()
        expect(page.locator("#report-image-attached figure")).to_have_count(1)

        # Opened again: the attached picture read back from the server holds the same mammogram and the Red mark.
        page.locator("#report-image-attached figure img").evaluate("img => img.decode()")
        attached_picture = page.locator("#report-image-attached figure img").evaluate(PICTURE)
        page.locator("#report-image-report").click()
        expect(dialog.locator("#image-report-attached figure")).to_have_count(1)
        dialog.locator("#image-report-attached figure img").evaluate("img => img.decode()")
        reopened = dialog.locator("#image-report-attached figure img").evaluate(PICTURE)
        for picture in (attached_picture, reopened):
            self.assertGreater(picture["red"], 0, picture)
            self.assertGreater(picture["white"], 0, picture)
            self.assertLess(picture["wx"], 0.4, picture); self.assertLess(picture["wy"], 0.4, picture)
        dialog.get_by_role("button", name="Close").click()

def load_tests(loader, tests, pattern):
    return unittest.TestSuite(ImageReportE2E(name) for name in loader.getTestCaseNames(ImageReportE2E)
                              if name.startswith('test_image_report_'))


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    unittest.main(verbosity=2)
