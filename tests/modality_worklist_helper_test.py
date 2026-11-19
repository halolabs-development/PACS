# coding: utf-8
"""The Modality Worklist helper (api/mwl/mwl_scp.py) against a real DICOM client, with this test standing in for the API
on the helper's stdin/stdout. What a device is answered is the API's rule (tests/modality_worklist_service_test.cjs);
here: the association and its contexts, the query handed over as DICOM JSON, the answer carried back as pending
identifiers and a final status, a failure carried with no identifier, a late or missing answer, cancel, two devices at
once, and the end of the process when the API goes. No identifier is logged.

Run: python tests/modality_worklist_helper_test.py (pydicom 2.4 and pynetdicom 2.0, as the API image's helper).
"""
import json
import os
import socket
import subprocess
import sys
import threading
import time
import unittest

from pydicom.dataset import Dataset
from pynetdicom import AE
from pynetdicom.sop_class import (CTImageStorage, ModalityPerformedProcedureStep, ModalityWorklistInformationFind,
                                  StudyRootQueryRetrieveInformationModelFind, Verification)

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
HELPER = os.path.join(ROOT, 'api', 'mwl', 'mwl_scp.py')
AET = 'SYNMWL'
NAME = '홍길동^SYNTHETIC'


def free_port():
    with socket.socket() as s:
        s.bind(('127.0.0.1', 0))
        return s.getsockname()[1]


class Helper:
    """The helper process with this test as its API: `answer(message)` decides each reply (None = never answer)."""

    def __init__(self, answer, answer_seconds=2):
        self.port = free_port()
        self.answer = answer
        self.finds = []
        self.proc = subprocess.Popen([sys.executable, '-I', HELPER, '--port', str(self.port), '--aet', AET, '--host', '127.0.0.1',
                                      '--answer-seconds', str(answer_seconds)],
                                     stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
                                     encoding='utf-8')
        self.listening = threading.Event()
        self.stderr = []
        threading.Thread(target=self._read, daemon=True).start()
        threading.Thread(target=lambda: self.stderr.extend(self.proc.stderr), daemon=True).start()
        if not self.listening.wait(20):
            raise RuntimeError('the helper did not open its port')

    def _read(self):
        try:
            self._lines()
        except (OSError, ValueError):   # the stream closed with the test
            pass

    def _lines(self):
        for line in self.proc.stdout:
            message = json.loads(line)
            if message['type'] == 'listening':
                self.listening.set()
            elif message['type'] == 'find':
                self.finds.append(message)
                reply = self.answer(message)
                if reply is not None:
                    self.reply(dict(reply, id=message['id']))

    def reply(self, message):
        try:
            self.proc.stdin.write(json.dumps(message) + '\n')
            self.proc.stdin.flush()
        except (BrokenPipeError, OSError, ValueError):
            pass

    def close(self):
        if self.proc.poll() is None:
            try:
                self.proc.stdin.close()
            except OSError:
                pass
            try:
                self.proc.wait(10)
            except subprocess.TimeoutExpired:
                self.proc.kill()
                self.proc.wait(10)
        for stream in (self.proc.stdin, self.proc.stdout, self.proc.stderr):
            try:
                stream.close()
            except (OSError, ValueError):
                pass


def item(name, pid):
    return {'00080005': {'vr': 'CS', 'Value': ['ISO_IR 192']},
            '00100010': {'vr': 'PN', 'Value': [{'Alphabetic': name}]},
            '00100020': {'vr': 'LO', 'Value': [pid]},
            '00400100': {'vr': 'SQ', 'Value': [{'00080060': {'vr': 'CS', 'Value': ['CT']},
                                                 '00400001': {'vr': 'AE', 'Value': ['SYNCT1']}}]}}


def query(name=''):
    ds = Dataset()
    ds.SpecificCharacterSet = 'ISO_IR 192'
    ds.PatientName = name
    ds.PatientID = ''
    sps = Dataset()
    sps.Modality = ''
    sps.ScheduledStationAETitle = ''
    ds.ScheduledProcedureStepSequence = [sps]
    return ds


def scu(calling='SYNCT1', called=AET, contexts=(ModalityWorklistInformationFind, Verification)):
    ae = AE(ae_title=calling)
    for context in contexts:
        ae.add_requested_context(context)
    return ae


def find(port, ds, calling='SYNCT1'):
    assoc = scu(calling).associate('127.0.0.1', port, ae_title=AET)
    assert assoc.is_established
    try:
        return [(status.Status, identifier) for status, identifier in assoc.send_c_find(ds, ModalityWorklistInformationFind)]
    finally:
        assoc.release()


class ModalityWorklistHelper(unittest.TestCase):
    def helper(self, answer, **kwargs):
        h = Helper(answer, **kwargs)
        self.addCleanup(h.close)
        return h

    def test_01_echo_and_only_worklist_contexts_on_its_own_ae_title(self):
        h = self.helper(lambda m: {'status': 0, 'items': []})
        assoc = scu().associate('127.0.0.1', h.port, ae_title=AET)
        self.assertTrue(assoc.is_established)
        self.assertEqual(assoc.send_c_echo().Status, 0x0000)
        assoc.release()
        # Another called AE Title: the association is rejected.
        other = scu().associate('127.0.0.1', h.port, ae_title='NOTMWL')
        self.assertTrue(other.is_rejected)
        # Storage, Query/Retrieve and MPPS are not accepted on this port.
        assoc = scu(contexts=(CTImageStorage, StudyRootQueryRetrieveInformationModelFind, ModalityPerformedProcedureStep,
                              ModalityWorklistInformationFind)).associate('127.0.0.1', h.port, ae_title=AET)
        self.assertTrue(assoc.is_established)
        accepted = {c.abstract_syntax for c in assoc.accepted_contexts}
        assoc.release()
        self.assertEqual(accepted, {ModalityWorklistInformationFind})

    def test_02_the_query_goes_to_the_api_and_its_items_come_back_with_their_final_status(self):
        h = self.helper(lambda m: {'status': 0, 'warning': False, 'items': [item(NAME, 'SYN-1'), item('KIM^SYN', 'SYN-2')]})
        got = find(h.port, query('홍*'))
        self.assertEqual([s for s, _ in got], [0xFF00, 0xFF00, 0x0000])
        self.assertEqual([str(ds.PatientName) for _, ds in got[:2]], [NAME, 'KIM^SYN'])
        self.assertEqual(got[0][1].ScheduledProcedureStepSequence[0].ScheduledStationAETitle, 'SYNCT1')
        self.assertIsNone(got[2][1])
        [asked] = h.finds
        self.assertEqual(asked['calling'], 'SYNCT1')
        self.assertEqual(asked['called'], AET)
        self.assertEqual(asked['identifier']['00100010'], {'vr': 'PN', 'Value': [{'Alphabetic': '홍*'}]})
        self.assertEqual(asked['identifier']['00400100']['vr'], 'SQ')
        # A warning answer is carried as FF01 on every pending identifier.
        h.answer = lambda m: {'status': 0, 'warning': True, 'items': [item(NAME, 'SYN-1')]}
        self.assertEqual([s for s, _ in find(h.port, query())], [0xFF01, 0x0000])
        # No match: success with no identifier.
        h.answer = lambda m: {'status': 0, 'items': []}
        self.assertEqual([s for s, _ in find(h.port, query())], [0x0000])
        # No identifier and no search value in the helper's own output.
        time.sleep(0.2)
        self.assertNotIn('홍', ''.join(h.stderr))
        self.assertNotIn('SYN-1', ''.join(h.stderr))

    def test_03_a_failure_status_carries_no_identifier(self):
        for status in (0x0124, 0xA900, 0xA700, 0xC002, 0xC003):
            h = self.helper(lambda m, s=status: {'status': s, 'items': [item(NAME, 'SYN-1')]})
            got = find(h.port, query())
            self.assertEqual(got, [(status, None)], hex(status))

    def test_04_no_answer_is_unable_to_process_and_a_late_answer_is_dropped(self):
        late = []
        h = self.helper(lambda m: late.append(m) or None, answer_seconds=1)
        started = time.monotonic()
        self.assertEqual(find(h.port, query()), [(0xC001, None)])
        self.assertLess(time.monotonic() - started, 6)
        # The late answer for that query reaches nobody; the next query gets its own answer.
        h.reply({'id': late[0]['id'], 'status': 0, 'items': [item('LATE^SYN', 'SYN-L')]})
        h.answer = lambda m: {'status': 0, 'items': [item(NAME, 'SYN-1')]}
        got = find(h.port, query())
        self.assertEqual([str(ds.PatientName) for s, ds in got if ds is not None], [NAME])
        self.assertNotEqual(h.finds[0]['id'], h.finds[1]['id'])

    def test_05_cancel_ends_the_query_with_cancel(self):
        h = self.helper(lambda m: None, answer_seconds=20)
        assoc = scu().associate('127.0.0.1', h.port, ae_title=AET)
        self.assertTrue(assoc.is_established)
        context = [c for c in assoc.accepted_contexts if c.abstract_syntax == ModalityWorklistInformationFind][0]
        responses = assoc.send_c_find(query(), ModalityWorklistInformationFind, msg_id=7)
        started = time.monotonic()
        timer = threading.Timer(1.0, lambda: assoc.send_c_cancel(7, context.context_id))
        timer.start()
        got = [(s.Status, ds) for s, ds in responses]
        timer.join()
        assoc.release()
        self.assertEqual(got, [(0xFE00, None)])
        self.assertLess(time.monotonic() - started, 10)

    def test_05b_a_cancel_that_came_while_the_api_answered_ends_with_cancel(self):
        # The cancel reaches the helper first; then the API's answer arrives (no match, and one with items). Either way the
        # query ends Cancel, never Success.
        for items in ([], [item(NAME, 'SYN-1')]):
            cancelled = threading.Event()

            def answer(m, items=items):
                cancelled.wait(10)
                time.sleep(0.05)   # inside one of the helper's 0.2 s waits: the answer wakes it, not its own check
                return {'status': 0, 'items': items}
            h = self.helper(answer, answer_seconds=20)
            assoc = scu().associate('127.0.0.1', h.port, ae_title=AET)
            context = [c for c in assoc.accepted_contexts if c.abstract_syntax == ModalityWorklistInformationFind][0]
            responses = assoc.send_c_find(query(), ModalityWorklistInformationFind, msg_id=9)

            def cancel():
                assoc.send_c_cancel(9, context.context_id)
                cancelled.set()
            threading.Timer(0.5, cancel).start()
            got = [(s.Status, ds) for s, ds in responses]
            assoc.release()
            self.assertEqual(got, [(0xFE00, None)], len(items))

    def test_05c_a_value_the_query_carries_never_reaches_the_helper_output(self):
        h = self.helper(lambda m: {'status': 0, 'items': []})
        ds = query()
        ds.PatientBirthDate = 'SYNBADDATE987'          # not a date: the library's own check would quote it
        ds.PatientID = 'SYN-' + 'Q' * 70               # longer than its VR allows
        got = find(h.port, ds)
        self.assertEqual(got[-1][0], 0x0000)
        time.sleep(0.3)
        output = ''.join(h.stderr)
        self.assertNotIn('SYNBADDATE987', output)
        self.assertNotIn('QQQQ', output)
        self.assertTrue(all(line.startswith('KIN-MWL ') for line in output.splitlines() if line.strip()), output[:200])

    def test_06_two_devices_at_once_get_their_own_answers(self):
        def answer(m):
            time.sleep(0.5)
            return {'status': 0, 'items': [item('FOR^' + m['calling'], m['calling'])]}
        h = self.helper(answer, answer_seconds=5)
        results = {}

        def run(calling):
            results[calling] = find(h.port, query(), calling=calling)
        threads = [threading.Thread(target=run, args=(c,)) for c in ('SYNCTA', 'SYNCTB')]
        for t in threads:
            t.start()
        for t in threads:
            t.join(30)
        for calling in ('SYNCTA', 'SYNCTB'):
            self.assertEqual([str(ds.PatientName) for s, ds in results[calling] if ds is not None], ['FOR^' + calling])

    def test_07_the_process_ends_when_the_api_goes(self):
        h = self.helper(lambda m: {'status': 0, 'items': []})
        h.proc.stdin.close()
        self.assertEqual(h.proc.wait(15), 0)
        assoc = scu().associate('127.0.0.1', h.port, ae_title=AET)
        self.assertFalse(assoc.is_established)

    def test_08_a_taken_port_is_reported_not_listening(self):
        with socket.socket() as s:
            s.bind(('127.0.0.1', 0))
            s.listen(1)
            port = s.getsockname()[1]
            proc = subprocess.run([sys.executable, '-I', HELPER, '--port', str(port), '--aet', AET, '--host', '127.0.0.1'],
                                  input='', capture_output=True, text=True, timeout=30)
        lines = [json.loads(l) for l in proc.stdout.splitlines() if l.strip()]
        self.assertEqual([l['type'] for l in lines], ['bind_failed'])
        self.assertEqual(proc.returncode, 3)


if __name__ == '__main__':
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    unittest.main(verbosity=2)
