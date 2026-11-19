# coding: utf-8
"""Modality Worklist on the served stack (docker-compose.mwl.yml), with a synthetic modality on loopback and run-unique
synthetic orders and devices.

  - the seed orders: a device registered to the first hospital finds that hospital's seed order of a patient through the
    findscu tool (pynetdicom's command line, Modality Worklist model) and not the reading centre's, and the reverse;
  - two registered devices, one per institution, asking the same date, patient ID and accession each get only their own
    institution's order; an unregistered device is refused (Refused: Not Authorized, 0x0124) with no identifier;
  - the answer carries the order's own values: its procedure ID (16 characters at most) and worklist Study Instance UID as
    stored, never the matched study's UID; the scheduled date, time and device; a Korean patient name in UTF-8;
  - Delete Order takes the order out of the next query and Undo brings it back with the same identifiers;
  - repeated queries change no Order, StudyState or Gateway receipt row - also for a matched order;
  - a query asking for the scheduled device of an order that has none fails Unable to process with no identifier;
  - each query leaves one audit row with the device, its institution, the outcome and the match count only;
  - C-ECHO answers; another called AE Title is rejected.

Run in CI: `python tests/measurement_ci.py --profile technician-orders`; on a development stack started with
docker-compose.mwl.yml: `python tests/e2e/test_modality_worklist.py`. Synthetic only; cleanup removes this run's orders and
device registrations (the study fixture's own cleanup removes its study).
"""
import glob
import json
import os
import subprocess
import sys
import tempfile
import time
import unittest
import uuid
from urllib.request import Request

from pydicom import dcmread
from pydicom.dataset import Dataset
from pynetdicom import AE
from pynetdicom.sop_class import ModalityWorklistInformationFind, Verification

from test_worklist import WorklistE2E, psql

MWL_PORT = int(os.environ.get("KIN_MWL_HOST_PORT", "4243"))
MWL_AET = "KINMWL"
DAY, DA = "2026-03-15", "20260315"


def lit(value):
    return "'" + str(value).replace("'", "''") + "'"


def identifier(date=DA, **top):
    ds = Dataset()
    ds.SpecificCharacterSet = "ISO_IR 192"
    for keyword in ("PatientName", "PatientID", "AccessionNumber", "PlacerOrderNumberImagingServiceRequest",
                    "RequestedProcedureID", "StudyInstanceUID"):
        setattr(ds, keyword, "")
    sps = Dataset()
    sps.Modality = ""
    sps.ScheduledStationAETitle = ""
    sps.ScheduledProcedureStepStartDate = date
    sps.ScheduledProcedureStepStartTime = ""
    sps.ScheduledProcedureStepID = ""
    ds.ScheduledProcedureStepSequence = [sps]
    for keyword, value in top.items():
        setattr(ds, keyword, value)
    return ds


class ModalityWorklistE2E(WorklistE2E):
    def setUp(self):
        super().setUp()
        deadline = time.monotonic() + 90
        while True:
            ae = AE(ae_title="SYNPROBE")
            ae.add_requested_context(Verification)
            assoc = ae.associate("127.0.0.1", MWL_PORT, ae_title=MWL_AET)
            if assoc.is_established:
                assoc.release()
                return
            if time.monotonic() > deadline:
                self.fail("the Modality Worklist port did not answer (is docker-compose.mwl.yml in the stack?)")
            time.sleep(2)

    def find(self, calling, ds):
        ae = AE(ae_title=calling)
        ae.add_requested_context(ModalityWorklistInformationFind)
        assoc = ae.associate("127.0.0.1", MWL_PORT, ae_title=MWL_AET)
        self.assertTrue(assoc.is_established, calling)
        try:
            got = [(status.Status, found) for status, found in assoc.send_c_find(ds, ModalityWorklistInformationFind)]
        finally:
            assoc.release()
        self.assertTrue(got, "no C-FIND response")
        self.assertTrue(all(found is None for _, found in got[-1:]), "the final response carries no identifier")
        return got

    def found(self, calling, ds):
        got = self.find(calling, ds)
        self.assertEqual(got[-1][0], 0x0000, [hex(s) for s, _ in got])
        self.assertTrue(all(s in (0xFF00, 0xFF01) for s, _ in got[:-1]))
        return [d for _, d in got[:-1]]

    def placers(self, calling, ds):
        return sorted(d.PlacerOrderNumberImagingServiceRequest for d in self.found(calling, ds))

    def register(self, institution, aet):
        body = {"value": aet, "confirmation": "SYNTHETIC modality worklist test"}
        if institution == "hallym":
            done = self.stack.request("POST", "/admin/source-devices", "jmryu", body)
            self.assertIn(done.status, (200, 201), done.text)
            self.assertEqual(done.body["institutionId"], "hallym")
        else:
            opener, session = self.stack._rights_session(institution)
            request = Request(self.stack.proxy + "/api/admin/source-devices", data=json.dumps(body).encode("utf-8"), method="POST",
                              headers={"Content-Type": "application/json", "X-KIN-CSRF": "1", "X-KIN-Session": session})
            with opener.open(request, timeout=30) as response:
                self.assertIn(response.status, (200, 201))
                self.assertEqual(json.loads(response.read())["institutionId"], institution)

        def cleanup():
            # Only this run's device leaves the registration column; whatever else it holds stays as it was.
            for row in psql('SELECT "dicomAets" FROM "Institution" WHERE id=' + lit(institution)):
                kept = ",".join(v for v in row.split(",") if v and v != aet)
                psql('UPDATE "Institution" SET "dicomAets"=' + lit(kept) + " WHERE id=" + lit(institution))
        self.addCleanup(cleanup)

    def order(self, institution, patient_id, name, accession, station, sched=DAY + " 09:10", modality="CT"):
        oid = "SYNTHETIC-mwl-" + uuid.uuid4().hex
        psql('INSERT INTO "Order" (oid,"institutionId","patientId",name,sex,birth,sched,modality,descr,ward,"reqDoc",accession,"scheduledStationAet") VALUES ('
             + ",".join(lit(v) for v in [oid, institution, patient_id, name, "F", "1980-02-03", sched, modality,
                                         "SYNTHETIC MWL CT", "SYNWARD", "SYNTHETIC REQ DOC"])
             + "," + (lit(accession) if accession else "NULL") + "," + (lit(station) if station else "NULL") + ")")

        def cleanup():
            for value in psql('SELECT to_jsonb(t)::text FROM "Order" t WHERE oid=' + lit(oid)):
                row = json.loads(value)
                if row["studyUid"]:
                    self.stack.request("POST", "/unmatch", "tech", {"uid": row["studyUid"]})
                self.assertEqual(psql('DELETE FROM "Order" WHERE oid=' + lit(oid) + " RETURNING oid"), [oid])
        self.addCleanup(cleanup)
        return oid

    def row(self, oid):
        [value] = psql('SELECT to_jsonb(t)::text FROM "Order" t WHERE oid=' + lit(oid))
        return json.loads(value)

    def test_modality_worklist_01_devices_institutions_orders_and_no_side_effects(self):
        run = uuid.uuid4().hex[:8].upper()
        dev_a, dev_b, station = "SYA" + run, "SYB" + run, "SYST" + run
        self.register("hallym", dev_a)
        self.register("kin-center", dev_b)

        # The seed orders, through the findscu tool: each institution's device finds its own seed order of a patient.
        with tempfile.TemporaryDirectory() as out:
            def findscu(calling, patient):
                done = subprocess.run([sys.executable, "-m", "pynetdicom", "findscu", "127.0.0.1", str(MWL_PORT), "-W",
                                       "-aet", calling, "-aec", MWL_AET, "-k", "PatientID=" + patient,
                                       "-k", "PlacerOrderNumberImagingServiceRequest=", "-k", "ScheduledProcedureStepSequence[0].Modality=",
                                       "-w"], cwd=out, capture_output=True, text=True, timeout=60)
                self.assertEqual(done.returncode, 0, done.stderr)
                files = sorted(glob.glob(os.path.join(out, "rsp*.dcm")))
                found = [str(dcmread(f).PlacerOrderNumberImagingServiceRequest) for f in files]
                for f in files:
                    os.remove(f)
                return found
            self.assertEqual(findscu(dev_a, "P-1001"), ["O-9001"])
            self.assertEqual(findscu(dev_b, "P-1001"), [])
            self.assertEqual(findscu(dev_b, "P-2003"), ["O-9005"])
            self.assertEqual(findscu(dev_a, "P-2003"), [])

        # Same date, patient ID and accession in two institutions: each device gets its own institution's order only.
        study = self.fixture()
        patient, accession = study.patient_id, "SYNACC" + run
        oa = self.order("hallym", patient, "SYNTHETIC^MWL^A", accession, station)
        ob = self.order("kin-center", patient, "SYNTHETIC^MWL^B", accession, "SYKC" + run)
        od = self.order("hallym", patient, "홍길동^SYNTHETIC", None, station, sched=DAY + " 10:30")
        none = self.order("hallym", patient, "SYNTHETIC^MWL^NOSTATION", None, None, sched="2026-03-16 08:00")
        ask = identifier(PatientID=patient, AccessionNumber=accession)
        self.assertEqual(self.placers(dev_a, ask), [oa])
        self.assertEqual(self.placers(dev_b, ask), [ob])

        # An unregistered device is refused, with no identifier.
        self.assertEqual(self.find("SYNNOTREG" + run[:4], ask), [(0x0124, None)])

        # The answer carries the order's own values.
        [got] = self.found(dev_a, identifier(PatientID=patient, PatientName="홍*"))
        stored = self.row(od)
        self.assertEqual(str(got.PatientName), "홍길동^SYNTHETIC")
        self.assertEqual(got.PlacerOrderNumberImagingServiceRequest, od)
        self.assertEqual(got.RequestedProcedureID, stored["mwlProcedureId"])
        self.assertLessEqual(len(got.RequestedProcedureID), 16)
        self.assertEqual(got.StudyInstanceUID, stored["mwlStudyUid"])
        self.assertTrue(got.StudyInstanceUID.startswith("2.25."))
        self.assertEqual(got.AccessionNumber, "")
        sps = got.ScheduledProcedureStepSequence[0]
        self.assertEqual([sps.ScheduledProcedureStepStartDate, sps.ScheduledProcedureStepStartTime, sps.ScheduledStationAETitle,
                          sps.Modality, sps.ScheduledProcedureStepID], [DA, "103000", station, "CT", stored["mwlProcedureId"]])
        self.assertNotEqual(self.row(oa)["mwlProcedureId"], stored["mwlProcedureId"])

        # Match the order to a study: the worklist UID is still the order's, and queries change nothing.
        matched = self.stack.request("POST", "/match", "tech", {"uid": study.uid, "oid": oa, "patient": {}})
        self.assertEqual(matched.status, 201, matched.text)
        before = [self.row(oa), self.row(ob), self.row(od),
                  psql('SELECT to_jsonb(t)::text FROM "StudyState" t WHERE uid=' + lit(study.uid)),
                  psql('SELECT md5(coalesce(string_agg(to_jsonb(t)::text, \',\' ORDER BY "studyUid"), \'\')) FROM "GatewayReceipt" t')]
        for _ in range(3):
            [again] = self.found(dev_a, ask)
            self.assertEqual(again.StudyInstanceUID, before[0]["mwlStudyUid"])
            self.assertNotEqual(again.StudyInstanceUID, study.uid)
        after = [self.row(oa), self.row(ob), self.row(od),
                 psql('SELECT to_jsonb(t)::text FROM "StudyState" t WHERE uid=' + lit(study.uid)),
                 psql('SELECT md5(coalesce(string_agg(to_jsonb(t)::text, \',\' ORDER BY "studyUid"), \'\')) FROM "GatewayReceipt" t')]
        self.assertEqual(after, before)
        self.assertEqual(before[0]["matched"], "M")

        # Delete Order: out of the next query; Undo: back, with the same identifiers.
        same_day = identifier(PatientID=patient)
        self.assertEqual(self.placers(dev_a, same_day), sorted([oa, od]))
        removed = self.stack.request("POST", f"/orders/{od}/remove", "tech", {"reason": "SYNTHETIC duplicate order"})
        self.assertEqual(removed.status, 200, removed.text)
        self.assertEqual(self.placers(dev_a, same_day), [oa])
        restored = self.stack.request("POST", f"/orders/{od}/restore", "tech")
        self.assertEqual(restored.status, 200, restored.text)
        [back] = [d for d in self.found(dev_a, same_day) if d.PlacerOrderNumberImagingServiceRequest == od]
        self.assertEqual([back.RequestedProcedureID, back.StudyInstanceUID], [stored["mwlProcedureId"], stored["mwlStudyUid"]])

        # An order without a scheduled device, asked for its device: Unable to process, no identifier.
        self.assertEqual(self.find(dev_a, identifier(date="20260316", PatientID=patient)), [(0xC003, None)])

        # Each query's audit row: device, institution, outcome and match count; no patient or search value.
        rows = [json.loads(d) for d in psql('SELECT detail FROM "AuditLog" WHERE action=\'modality-worklist.query\' AND detail::jsonb->>\'aet\' IN ('
                                            + ",".join(lit(v) for v in [dev_a, dev_b, "SYNNOTREG" + run[:4]]) + ") ORDER BY id")]
        self.assertIn({"institution": "hallym", "aet": dev_a, "outcome": "answered", "matches": 1}, rows)
        self.assertIn({"institution": "kin-center", "aet": dev_b, "outcome": "answered", "matches": 1}, rows)
        self.assertIn({"institution": None, "aet": "SYNNOTREG" + run[:4], "outcome": "refused", "matches": 0}, rows)
        self.assertIn({"institution": "hallym", "aet": dev_a, "outcome": "failed", "matches": 1}, rows)
        self.assertNotIn(patient, json.dumps(rows))

        # C-ECHO answers; an association to another AE Title is rejected.
        ae = AE(ae_title=dev_a)
        ae.add_requested_context(Verification)
        assoc = ae.associate("127.0.0.1", MWL_PORT, ae_title=MWL_AET)
        self.assertEqual(assoc.send_c_echo().Status, 0x0000)
        assoc.release()
        self.assertTrue(ae.associate("127.0.0.1", MWL_PORT, ae_title="NOTKINMWL").is_rejected)
        self.assertIsNotNone(none)


def load_tests(loader, tests, pattern):
    return unittest.TestSuite([ModalityWorklistE2E("test_modality_worklist_01_devices_institutions_orders_and_no_side_effects")])


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    unittest.main(verbosity=2)
