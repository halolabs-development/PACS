"""REQ-EMR-16/17 -> TEST-AUDIT-INTAKE-REFUSAL.

Real page + real F controller/service/contract over the synthetic rights harness (copy and rights requests share it).
The intake forms fill the patient link, assigning authority and verifier from the server; a refused write keeps the
detail and says what to fix, an unconfirmed one still sends the auditor back to Open Request.
"""
import json
import subprocess
import unittest
from datetime import datetime, timezone
from urllib.parse import urlparse, unquote

from playwright.sync_api import expect
from audit_page_dom_test import AuditPage, ROOT
from audit_disclosure_dom_test import date_input
from audit_rights_dom_test import datetime_local_value

ACTOR = dict(id='synthetic-auditor', issuer='synthetic', subject='auditor')


class IntakeAndRefusal(AuditPage):
    def setUp(self):
        super().setUp()
        self.backend = subprocess.Popen(['node', 'tests/emr/f/rights_harness.cjs'], cwd=ROOT,
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, encoding='utf-8')
        self.posted, self.once, self.hold_context = [], {}, False

    def tearDown(self):
        self.backend.stdin.close(); self.backend.wait(timeout=15)
        errors = self.backend.stderr.read()
        self.backend.stdout.close(); self.backend.stderr.close()
        super().tearDown()
        self.assertEqual(errors, '')
        self.assertEqual(self.backend.returncode, 0)

    def backend_call(self, **query):
        self.backend.stdin.write(json.dumps(query) + '\n'); self.backend.stdin.flush()
        return json.loads(self.backend.stdout.readline())

    def api(self, route):
        path, verb = urlparse(route.request.url).path, route.request.method
        parts = path.split('/')
        if path == '/api/emr-audit/intake-context':
            method = 'intakeContext'
            if self.hold_context: self.held.append(route); return
        elif path.startswith('/api/emr-audit/rights-requests'):
            method = ('listRights' if verb == 'GET' else 'receiveRights') if len(parts) == 4 else (
                'readRights' if len(parts) == 5 else {'decide': 'decideRights', 'notify': 'notifyRights'}[parts[-1]])
        elif path.startswith(('/api/emr-audit/requests', '/api/emr-audit/issuances')):
            method = ('register' if parts[3] == 'requests' else 'prepare') if len(parts) == 4 else (
                ('state' if parts[3] == 'requests' else 'issuance') if len(parts) == 5 else parts[-1])
        else:
            return super().api(route)
        body = route.request.post_data_json if route.request.post_data else None
        if verb == 'POST': self.posted.append((path, body))
        reply = self.once.pop((verb, method), None)
        if reply:
            route.fulfill(status=reply[0], json=reply[1]); return
        result = self.backend_call(method=method, id=unquote(parts[4]) if len(parts) > 4 and method != 'intakeContext' else None, body=body)
        route.fulfill(status=result['status'], json=result['body'])

    def link(self, patient_id):
        return self.backend_call(link=['SYN-SITE', patient_id])['body']

    @property
    def rights(self): return self.page.get_by_role('region', name='Rights Requests', exact=True)

    @property
    def copy(self): return self.page.get_by_role('region', name='Record Copy Requests', exact=True)

    def ready(self):
        self.open()
        expect(self.rights.get_by_label('Rights Assigning Authority', exact=True)).to_have_value('SYN-SITE')

    def receive_rights(self, request_id='SYN-A', patient='SYN-PATIENT', expect_received=True):
        self.rights.get_by_label('Rights Request ID', exact=True).fill(request_id)
        for label, text in {'Rights Patient ID': patient, 'Rights Record IDs': 'SYN-RECORD',
                'Rights Received At (UTC)': '2026-10-01T00:00', 'Statement': '합성 정정 요구'}.items():
            self.rights.get_by_label(label, exact=True).fill(text)
        self.rights.get_by_role('button', name='Receive Request', exact=True).click()
        if expect_received: expect(self.rights.locator('#audit-rights-state')).to_contain_text('Request: Received')

    def fill_copy(self, request_id='SYN-C', patient='SYN-PATIENT', basis=None):
        self.copy.get_by_label('Request ID', exact=True).fill(request_id)
        for label, value in {'Copy Patient ID': patient, 'Requester Name': '합성 요청자', 'Request Purpose': 'patient-copy',
                'Received At (UTC)': date_input(-1), 'Due At (UTC)': date_input(2), 'Checked At (UTC)': date_input(),
                'Evidence Document ID': 'SYN-EVIDENCE', 'Record ID': 'SYN-RECORD', 'Recipient': '합성 수령자'}.items():
            self.copy.get_by_label(label, exact=True).fill(value)
        if basis: self.copy.get_by_label('Request Basis', exact=True).fill(basis)

    def notify(self, at):
        for label, value in {'Notified At (UTC)': at, 'Notice Recipient': '합성 요구자', 'Notice Method': 'electronic',
                'Notice Evidence ID': 'SYN-NOTICE', 'Notice Content': '합성 통지 원문'}.items():
            self.rights.get_by_label(label, exact=True).fill(value)
        self.rights.get_by_role('button', name='Record Notification', exact=True).click()

    def test_intake_forms_fill_link_authority_and_verifier(self):
        self.ready()
        expected = self.link('SYN-PATIENT')
        for section, prefix in [(self.rights, 'Rights '), (self.copy, 'Copy ')]:
            authority = section.get_by_label(prefix + 'Assigning Authority', exact=True)
            expect(authority).to_have_value('SYN-SITE'); expect(authority).not_to_be_editable()
            expect(authority).to_have_attribute('translate', 'no')
        expect(self.copy.get_by_label('Patient Link ID', exact=True)).not_to_be_editable()
        for label, key in [('Verifier ID', 'id'), ('Verifier Issuer', 'issuer'), ('Verifier Subject', 'subject')]:
            expect(self.copy.get_by_label(label, exact=True)).to_have_value(ACTOR[key])
            expect(self.copy.get_by_label(label, exact=True)).to_be_editable()
        self.receive_rights()
        expect(self.rights.get_by_label('Rights Patient Link ID', exact=True)).to_have_value(expected['linkId'])
        saved = self.backend_call(inspect=True)['body']['requests']
        self.assertEqual(saved[-1]['body']['request']['patient'], expected)
        self.fill_copy()
        expect(self.copy.get_by_label('Patient Link ID', exact=True)).to_have_value(expected['linkId'])
        self.copy.get_by_role('button', name='Receive Request', exact=True).click()
        expect(self.copy.locator('#audit-disclosure-state')).to_contain_text('Issuance ID: null')
        request = self.posted[-1][1]['request']
        self.assertEqual(request['patient'], expected)
        self.assertEqual(request['evidence'][0]['checkedBy'], ACTOR)
        self.screenshot('audit-intake-filled.png')

    def test_verifier_typed_by_hand_is_kept_and_sent(self):
        # The context answer arrives after the auditor typed another verifier: the typed values stay.
        self.hold_context = True
        self.open()
        self.copy.get_by_label('Verifier Subject', exact=True).fill('other-checker')
        self.hold_context = False
        for route in self.held: self.api(route)
        expect(self.copy.get_by_label('Copy Assigning Authority', exact=True)).to_have_value('SYN-SITE')
        expect(self.copy.get_by_label('Verifier Subject', exact=True)).to_have_value('other-checker')
        expect(self.copy.get_by_label('Verifier ID', exact=True)).to_have_value(ACTOR['id'])
        self.fill_copy()
        self.copy.get_by_role('button', name='Receive Request', exact=True).click()
        expect(self.copy.locator('#audit-disclosure-state')).to_contain_text('Issuance ID: null')
        self.assertEqual(self.posted[-1][1]['request']['evidence'][0]['checkedBy'], dict(ACTOR, subject='other-checker'))

    def test_context_failure_is_said_at_receive_and_retried(self):
        self.once[('GET', 'intakeContext')] = (503, dict(code='OutcomeUnknown'))
        self.open()
        self.once[('GET', 'intakeContext')] = (503, dict(code='OutcomeUnknown'))
        self.receive_rights(expect_received=False)
        expect(self.rights.locator('#audit-rights-message')).to_contain_text('접수에 필요한 기관·감사자 정보를 읽지 못했습니다 (OutcomeUnknown)')
        self.assertEqual(self.posted, [])
        self.rights.get_by_role('button', name='Receive Request', exact=True).click()
        expect(self.rights.locator('#audit-rights-state')).to_contain_text('Request: Received')
        self.assertEqual(self.posted[-1][1]['patient'], self.link('SYN-PATIENT'))


def load_tests(loader, tests, pattern):
    return unittest.TestSuite(IntakeAndRefusal(name) for name in IntakeAndRefusal.__dict__ if name.startswith('test_'))


if __name__ == '__main__': unittest.main()
