# coding: utf-8
"""The Modality Worklist helper (api/mwl/mwl_scp.py) against a real DICOM client, with this test standing in for the API
on the helper's stdin/stdout. What a device is answered is the API's rule (tests/modality_worklist_service_test.cjs);
here: the association and its contexts, the query handed over as DICOM JSON, the answer carried back as pending
identifiers and a final status, a failure carried with no identifier, a late or missing answer, cancel, two devices at
once, and the end of the process when the API goes. No identifier is logged.

Then the same DICOM client against the helper as the API's own service starts it, with the real rule deciding the answer
over an in-memory order table (tests/modality_worklist_bridge.cjs; needs node): what a modality really receives - each
device its own institution's orders, an order the asked keys cannot carry left out while the others come, every match left
out ending Unable to process, no match ending Success, values going out and coming back character for character, the
scheduled date and time ranges, two devices at once, a lost audit row, and the helper started again.

Run: python tests/modality_worklist_helper_test.py (pydicom 2.4 and pynetdicom 2.0, as the API image's helper).
"""
import json
import os
import queue
import shutil
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
BRIDGE = os.path.join(ROOT, 'tests', 'modality_worklist_bridge.cjs')
AET = 'SYNMWL'
NAME = '홍길동^SYNTHETIC'
HAN = '\U00020000'   # one character outside the Basic Multilingual Plane


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


class Bridge:
    """The API's own service and rule over an in-memory order table, with the helper it starts (see the bridge file)."""

    def __init__(self):
        node = shutil.which('node')
        if not node:
            raise RuntimeError('node is needed: the answers are decided by the API\'s own rule')
        self.port = free_port()
        self.proc = subprocess.Popen([node, BRIDGE, str(self.port), sys.executable], cwd=ROOT, stdin=subprocess.PIPE,
                                     stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, encoding='utf-8')
        self.lines = queue.Queue()
        self.stderr = []
        threading.Thread(target=lambda: [self.lines.put(json.loads(line)) for line in self.proc.stdout], daemon=True).start()
        threading.Thread(target=lambda: self.stderr.extend(self.proc.stderr), daemon=True).start()
        try:
            first = self.lines.get(timeout=120)
        except queue.Empty:
            self.close()
            raise RuntimeError('the service did not open the worklist port: ' + ''.join(self.stderr)[-600:])
        if first != {'listening': self.port}:
            self.close()
            raise RuntimeError('the service did not open the worklist port: ' + json.dumps(first)[:600])

    def ask(self, **command):
        self.proc.stdin.write(json.dumps(command) + '\n')
        self.proc.stdin.flush()
        return self.lines.get(timeout=60)

    def close(self):
        if self.proc.poll() is None:
            try:
                self.proc.stdin.close()
            except OSError:
                pass
            try:
                self.proc.wait(20)
            except subprocess.TimeoutExpired:
                self.proc.kill()
                self.proc.wait(10)
        for stream in (self.proc.stdin, self.proc.stdout, self.proc.stderr):
            try:
                stream.close()
            except (OSError, ValueError):
                pass


def order(n, **over):
    row = dict(oid='SYN-ORDER-%04d' % n, institutionId='inst-a', patientId='SYN-P%d' % n, name='SYNTHETIC^P%d' % n, sex='F',
               birth='1980-02-03', sched='2026-11-20 09:10', modality='CT', descr='SYN CT HEAD', ward='SYNWARD',
               reqDoc='SYN^REQ', accession='SYNACC%d' % n, mwlProcedureId='SYNPROC%09d' % n, mwlStudyUid='2.25.%d' % (1000 + n),
               scheduledStationAet='SYNCT1')
    row.update(over)
    return row


def ask(**keys):
    """A worklist query: the keys given at the top level (`sps` = the keys of the one Scheduled Procedure Step item)."""
    ds = Dataset()
    ds.SpecificCharacterSet = 'ISO_IR 192'
    for keyword, value in keys.items():
        if keyword == 'sps':
            step = Dataset()
            for inner, inner_value in value.items():
                setattr(step, inner, inner_value)
            ds.ScheduledProcedureStepSequence = [step]
        else:
            setattr(ds, keyword, value)
    return ds


class ModalityWorklistAnswered(unittest.TestCase):
    """What a modality receives: the API's own rule and service behind the real helper."""

    @classmethod
    def setUpClass(cls):
        cls.bridge = Bridge()

    @classmethod
    def tearDownClass(cls):
        cls.bridge.close()

    def setUp(self):
        self.assertEqual(self.bridge.ask(set={'delayMs': 0, 'auditFails': False})['set'], {'delayMs': 0, 'auditFails': False})
        self.audits_before = len(self.bridge.ask(audits=True)['audits'])

    def orders(self, *rows):
        self.assertEqual(self.bridge.ask(orders=list(rows)), {'orders': len(rows)})

    def find(self, ds, calling='SYNCT1'):
        return find(self.bridge.port, ds, calling=calling)

    def got(self, ds, calling='SYNCT1'):
        """The pending identifiers of a query that ended Success."""
        responses = self.find(ds, calling)
        self.assertEqual(responses[-1], (0x0000, None), [hex(s) for s, _ in responses])
        self.assertTrue(all(s in (0xFF00, 0xFF01) and d is not None for s, d in responses[:-1]))
        return [d for _, d in responses[:-1]]

    def audit_rows(self):
        state = self.bridge.ask(audits=True)
        return state['audits'][self.audits_before:], state

    def test_20_an_order_that_cannot_be_carried_is_left_out_and_the_others_come(self):
        self.orders(order(1), order(2, name='^^^^'), order(3, scheduledStationAet='한글장비'), order(4, institutionId='inst-b'))
        named = dict(PatientName='', PatientID='')
        # Mixed: each order that can be carried is one pending identifier, then Success.
        responses = self.find(ask(**named))
        self.assertEqual([s for s, _ in responses], [0xFF00, 0xFF00, 0x0000])
        self.assertEqual([d.PatientID for _, d in responses[:-1]], ['SYN-P1', 'SYN-P3'])
        # The same orders with the scheduled device asked back: the one whose device name no AE Title can carry is out too.
        self.assertEqual([d.PatientID for d in self.got(ask(sps=dict(ScheduledStationAETitle=''), **named))], ['SYN-P1'])
        # A flaw in a field nobody asked for leaves the order in.
        self.assertEqual([d.PatientID for d in self.got(ask(PatientID=''))], ['SYN-P1', 'SYN-P2', 'SYN-P3'])
        # Every matching order left out: Unable to process, no identifier.
        self.assertEqual(self.find(ask(PatientName='', PatientID='SYN-P2')), [(0xC003, None)])
        # No order matches: Success, no identifier.
        self.assertEqual(self.find(ask(PatientName='', PatientID='SYN-NOBODY')), [(0x0000, None)])
        rows, state = self.audit_rows()
        self.assertEqual([(r['detail']['institution'], r['detail']['outcome'], r['detail']['matches'], r['detail']['excluded']) for r in rows],
                         [('inst-a', 'answered', 3, 1), ('inst-a', 'answered', 3, 2), ('inst-a', 'answered', 3, 0),
                          ('inst-a', 'failed', 1, 1), ('inst-a', 'answered', 0, 0)])
        # Neither the audit rows nor the service's log hold a patient value or a search value.
        text = json.dumps(state, ensure_ascii=False)
        for value in ('SYN-P', 'SYNTHETIC', 'SYN-NOBODY', '한글', '^^^^'):
            self.assertNotIn(value, text)

    def test_21_each_device_gets_its_own_institutions_orders_and_its_station_and_patient_keys_hold(self):
        same = dict(patientId='SYN-SAME', accession='SYNACC-SAME')
        self.orders(order(1, name='SYNTHETIC^A', **same), order(2, name='SYNTHETIC^A2', scheduledStationAet='SYNCT2', **same),
                    order(3, name='SYNTHETIC^B', institutionId='inst-b', scheduledStationAet='SYNCTB', **same),
                    order(4, name='SYNTHETIC^OTHER', patientId='SYN-OTHER', birth='1975-07-09', sex='M'))
        q = dict(PatientName='', PatientID='SYN-SAME', AccessionNumber='SYNACC-SAME')
        day = dict(ScheduledProcedureStepStartDate='20261120', ScheduledStationAETitle='')
        names = lambda found: [str(d.PatientName) for d in found]
        # The same patient ID, date and accession in two institutions: each device gets its own institution's only.
        self.assertEqual(names(self.got(ask(sps=day, **q), 'SYNCT1')), ['SYNTHETIC^A', 'SYNTHETIC^A2'])
        self.assertEqual(names(self.got(ask(sps=day, **q), 'SYNCTB')), ['SYNTHETIC^B'])
        # Inside one institution the scheduled device named by the query holds, whichever of its devices asks.
        self.assertEqual(names(self.got(ask(sps=dict(day, ScheduledStationAETitle='SYNCT2'), **q), 'SYNCT1')), ['SYNTHETIC^A2'])
        self.assertEqual(names(self.got(ask(sps=dict(day, ScheduledStationAETitle='SYNCTB'), **q), 'SYNCT1')), [])
        # A device no institution registered, and one two institutions registered: refused, no identifier.
        for calling in ('SYNUNKNOWN', 'SYNSHARED'):
            self.assertEqual(self.find(ask(sps=day, **q), calling), [(0x0124, None)])
        # A birth date and a sex given: the patient both are true of, never another one under a warning.
        both = self.find(ask(PatientName='', PatientID='', PatientBirthDate='19750709', PatientSex='M'))
        self.assertEqual([(s, d and str(d.PatientName)) for s, d in both], [(0xFF00, 'SYNTHETIC^OTHER'), (0x0000, None)])
        self.assertEqual(self.find(ask(PatientName='', PatientID='', PatientBirthDate='19750709', PatientSex='F')), [(0x0000, None)])
        # A value for a patient attribute the orders cannot be compared on is never taken as matched.
        self.assertEqual(self.find(ask(PatientName='', PatientID='SYN-SAME', IssuerOfPatientID='SYN-ISSUER')), [(0x0000, None)])

    def test_22_values_go_out_and_come_back_character_for_character(self):
        long_id = HAN * 33
        self.orders(order(1, patientId=long_id, name='홍길동^합성'), order(2, patientId='SYN-TWO', name='KIM^A=金'),
                    order(3, patientId='SYN-HAN', name='SYN^' + HAN), order(4, patientId='\u3000A', name='SYNTHETIC^WIDE'),
                    order(5, patientId='A', name='SYNTHETIC^PLAIN'))
        # The fewest keys: only what was asked comes back, with the character set and the hospital's offset.
        [least] = self.got(ask(PatientID=long_id))
        self.assertEqual(sorted(e.keyword for e in least), ['PatientID', 'SpecificCharacterSet', 'TimezoneOffsetFromUTC'])
        self.assertEqual([least.PatientID, len(least.PatientID), least.SpecificCharacterSet, least.TimezoneOffsetFromUTC],
                         [long_id, 33, 'ISO_IR 192', '+0900'])
        # A whole Scheduled Procedure Step (one empty item): every step key, with the order's own values.
        [whole] = self.got(ask(PatientID=long_id, PatientName='홍*', RequestedProcedureID='', StudyInstanceUID='', sps={}))
        self.assertEqual(str(whole.PatientName), '홍길동^합성')
        self.assertEqual([whole.RequestedProcedureID, whole.StudyInstanceUID], ['SYNPROC000000001', '2.25.1001'])
        step = whole.ScheduledProcedureStepSequence[0]
        self.assertEqual([step.ScheduledStationAETitle, step.ScheduledProcedureStepStartDate, step.ScheduledProcedureStepStartTime, step.Modality,
                          step.ScheduledProcedureStepDescription, step.ScheduledProcedureStepID],
                         ['SYNCT1', '20261120', '091000', 'CT', 'SYN CT HEAD', 'SYNPROC000000001'])
        # A stored name in two representations, found by its patient ID with the name asked back: both come back.
        [two] = self.got(ask(PatientID='SYN-TWO', PatientName=''))
        self.assertEqual([str(two.PatientName), two.PatientName.alphabetic, two.PatientName.ideographic], ['KIM^A=金', 'KIM^A', '金'])
        # `?` is one character, also outside the Basic Multilingual Plane.
        self.assertEqual([d.PatientID for d in self.got(ask(PatientID='', PatientName='SYN^?'))], ['SYN-HAN'])
        self.assertEqual(self.find(ask(PatientID='', PatientName='SYN^??')), [(0x0000, None)])
        # A patient ID that begins with an ideographic space is another patient's: asking for `A` never gives it as `A`.
        self.assertEqual([str(d.PatientName) for d in self.got(ask(PatientID='A', PatientName=''))], ['SYNTHETIC^PLAIN'])
        [wide] = self.got(ask(PatientID='\u3000A', PatientName=''))
        self.assertEqual([wide.PatientID, str(wide.PatientName)], ['\u3000A', 'SYNTHETIC^WIDE'])

    def test_23_scheduled_date_and_time_ranges(self):
        at = lambda n, sched: order(n, sched=sched)
        self.orders(at(1, '2026-11-20 21:00'), at(2, '2026-11-20 23:00'), at(3, '2026-11-21 01:00'), at(4, '2026-11-21 03:00'),
                    at(5, '20261120'), at(6, '2026-11-22 10:00'))
        when = lambda date, time: [(d.ScheduledProcedureStepSequence[0].ScheduledProcedureStepStartDate,
                                    d.ScheduledProcedureStepSequence[0].ScheduledProcedureStepStartTime)
                                   for d in self.got(ask(PatientID='', sps=dict(ScheduledProcedureStepStartDate=date,
                                                                                ScheduledProcedureStepStartTime=time)))]
        # Both ranges: one span from the first date's start time to the last date's end time.
        self.assertEqual(when('20261120-20261121', '2200-0200'), [('20261120', '230000'), ('20261121', '010000')])
        self.assertEqual(when('20261120', '2100'), [('20261120', '210000')])
        self.assertEqual(when('20261122-', '0900-1100'), [('20261122', '100000')])
        # A day with the time asked back: the order that has a date only is the one left out; the others come.
        self.assertEqual(when('20261120', ''), [('20261120', '210000'), ('20261120', '230000')])
        rows, _ = self.audit_rows()
        self.assertEqual([(r['detail']['matches'], r['detail']['excluded']) for r in rows][-1], (3, 1))

    def test_24_two_devices_at_once_a_lost_audit_row_and_the_helper_started_again(self):
        self.orders(order(1, name='SYNTHETIC^A'), order(2, name='SYNTHETIC^B', institutionId='inst-b', scheduledStationAet='SYNCTB'))
        q = lambda: ask(PatientName='', PatientID='')
        # Two institutions' devices asking at the same moment each get their own answer.
        self.bridge.ask(set={'delayMs': 500})
        results = {}

        def run(calling):
            results[calling] = [str(d.PatientName) for d in self.got(q(), calling)]
        threads = [threading.Thread(target=run, args=(c,)) for c in ('SYNCT1', 'SYNCTB')]
        for t in threads:
            t.start()
        for t in threads:
            t.join(60)
        self.assertEqual(results, {'SYNCT1': ['SYNTHETIC^A'], 'SYNCTB': ['SYNTHETIC^B']})
        self.bridge.ask(set={'delayMs': 0})
        # The audit row cannot be written: Unable to process, no identifier.
        self.bridge.ask(set={'auditFails': True})
        self.assertEqual(self.find(q()), [(0xC002, None)])
        self.bridge.ask(set={'auditFails': False})
        # The helper process ends: the service starts it again, and the first query of a new association is answered.
        self.assertEqual(self.bridge.ask(stopHelper=True), {'stopped': True})
        deadline = time.monotonic() + 60
        while True:
            assoc = scu().associate('127.0.0.1', self.bridge.port, ae_title=AET)
            if assoc.is_established:
                assoc.release()
                break
            self.assertLess(time.monotonic(), deadline, 'the helper was not started again')
            time.sleep(0.5)
        self.assertEqual([str(d.PatientName) for d in self.got(q())], ['SYNTHETIC^A'])


if __name__ == '__main__':
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    unittest.main(verbosity=2)
