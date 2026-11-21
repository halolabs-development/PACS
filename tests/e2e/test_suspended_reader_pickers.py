# coding: utf-8
"""A reader an administrator suspended is no longer offered or saved as an assignee or a consultation recipient.

Suspension is the product's own command (PATCH admin/users/:id {enabled:false}); it changes the member table, the
authority for who may work, and leaves the login provider's account as it was. Each case suspends its own synthetic
reader of hallym through that command (the live fixture's set_member_rights) and then asks the two pickers and the two
saves the product has:

  1. Assign Reader: GET /reader-candidates (as a technician) and POST /studies/:uid/reader-assignment with a body that
     was prepared before the suspension.
  2. Consultation: GET /consultation-candidates (as a radiologist) and POST /studies/:uid/consultations prepared before.

Each of the four answers is recorded on its own, printed, then compared, so one run tells which of them let the
suspended reader through. A refused save leaves no row and its answer names the reason, and the Assign Reader dialog
shows that reason. An assignment and a consultation saved before the suspension stay as they were.

Run in CI: `python tests/measurement_ci.py --profile suspended-reader-pickers` (Focused integration, dispatch only);
on a development stack: `python tests/e2e/test_suspended_reader_pickers.py`.
"""
import json
import sys
import unittest
import uuid

from playwright.sync_api import expect

from test_worklist import WorklistE2E, psql

# The refusals the two saves answer, written out here (not read from the service) so a wrong sentence fails.
ASSIGN_REFUSED = '현재 같은 기관의 활성 판독의를 선택하세요'
CONSULT_REFUSED = '본인을 제외한 같은 기관의 활성 판독의를 선택하세요'


def lit(value):
    return "'" + str(value).replace("'", "''") + "'"


class SuspendedReaderPickersE2E(WorklistE2E):
    def setUp(self):
        super().setUp()
        self.requests = set()
        self.addCleanup(self.cleanup_rows)

    def cleanup_rows(self):
        self.close_contexts()
        self.contexts = []
        for uid in self.stack.active:
            for raw in psql('SELECT to_jsonb(t)::text FROM "ReaderAssignment" t WHERE "studyUid"=' + lit(uid)):
                self.assertIn(json.loads(raw)['lastRequest'], self.requests)
                self.assertEqual(psql('DELETE FROM "ReaderAssignment" t WHERE to_jsonb(t)=' + lit(raw) + '::jsonb RETURNING 1'), ['1'])
            for raw in psql('SELECT to_jsonb(t)::text FROM "StudyConsultation" t WHERE "studyUid"=' + lit(uid)):
                self.assertIn(json.loads(raw)['id'], self.requests)
                self.assertEqual(psql('DELETE FROM "StudyConsultation" t WHERE to_jsonb(t)=' + lit(raw) + '::jsonb RETURNING 1'), ['1'])

    def reader(self, logical):
        """A synthetic radiologist of hallym, approved and active through the product's own command."""
        return self.stack.create_test_identity(logical, ['radiologist'], 'hallym')

    def suspend(self, sub):
        self.assertFalse(self.stack.set_member_rights(sub, enabled=False)['enabled'])

    def assign_candidates(self, role='tech'):
        r = self.stack.request('GET', '/reader-candidates', role)
        self.assertEqual(r.status, 200, r.text)
        return {x['sub'] for x in r.body['readers']}

    def consult_candidates(self, role='doctor'):
        r = self.stack.request('GET', '/consultation-candidates', role)
        self.assertEqual(r.status, 200, r.text)
        return {x['sub'] for x in r.body['readers']}

    def assign_body(self, f, sub, role='tech'):
        r = self.stack.request('GET', f'/studies/{f.uid}/reader-assignment', role)
        self.assertEqual(r.status, 200, r.text)
        request = str(uuid.uuid4())
        self.requests.add(request)
        return dict(expectedOwner=r.body['owner'], revision=r.body['revision'], readerSub=sub, requestId=request)

    def consult_body(self, sub, role='doctor'):
        me = self.stack.request('GET', '/me', role)
        self.assertEqual(me.status, 200, me.text)
        request = str(uuid.uuid4())
        self.requests.add(request)
        return dict(expectedOwner=[me.body['institution'], me.body['sub']], requestId=request, recipientSub=sub,
                    reason='SYNTHETIC suspended reader consultation')

    def rows(self, f):
        return (psql('SELECT to_jsonb(t)::text FROM "ReaderAssignment" t WHERE "studyUid"=' + lit(f.uid)),
                psql('SELECT to_jsonb(t)::text FROM "StudyConsultation" t WHERE "studyUid"=' + lit(f.uid)))

    def test_suspended_reader_01_pickers_and_saves(self):
        f = self.fixture()
        sub = self.reader('pausedpick')
        # Before: the active reader is offered by both pickers (the measurement's own control).
        self.assertIn(sub, self.assign_candidates())
        self.assertIn(sub, self.consult_candidates())
        assign, consult = self.assign_body(f, sub), self.consult_body(sub)
        before = self.rows(f)
        self.suspend(sub)
        saved_assign = self.stack.request('POST', f'/studies/{f.uid}/reader-assignment', 'tech', assign)
        saved_consult = self.stack.request('POST', f'/studies/{f.uid}/consultations', 'doctor', consult)
        observed = {
            'assignment candidates offer the suspended reader': sub in self.assign_candidates(),
            'consultation candidates offer the suspended reader': sub in self.consult_candidates(),
            'assignment prepared before is saved': saved_assign.status,
            'consultation prepared before is saved': saved_consult.status,
        }
        print('SUSPENDED-READER-MEASURE ' + json.dumps(observed, ensure_ascii=False), flush=True)
        self.assertEqual(observed, {
            'assignment candidates offer the suspended reader': False,
            'consultation candidates offer the suspended reader': False,
            'assignment prepared before is saved': 400,
            'consultation prepared before is saved': 400,
        })
        self.assertIn(ASSIGN_REFUSED, saved_assign.text)
        self.assertIn(CONSULT_REFUSED, saved_consult.text)
        self.assertEqual(self.rows(f), before, 'a refused save wrote a row')

    def test_suspended_reader_02_assign_dialog_says_why(self):
        f = self.fixture()
        sub = self.reader('pausedscreen')
        p = self.login('tech')
        self.select(p, f)
        p.locator(f'[data-reader-assignment="{f.uid}"]').click()
        expect(p.locator('#ra-status')).to_contain_text('최신 배정')
        p.on('request', lambda r: self.requests.add(r.post_data_json['requestId'])
             if r.method == 'POST' and r.url.split('?')[0].endswith('/reader-assignment') else None)
        # Chosen while the reader was active; the administrator suspends them before Save.
        p.locator('#ra-reader').select_option(sub)
        self.suspend(sub)
        p.locator('#ra-save').click()
        expect(p.locator('#ra-status')).to_contain_text(ASSIGN_REFUSED)
        expect(p.locator('#ra-current')).to_contain_text('Unassigned')
        # Reloading draws the picker again from the server: the suspended reader is no longer there.
        p.locator('#ra-reload').click()
        expect(p.locator('#ra-status')).to_contain_text('최신 배정')
        expect(p.locator(f'#ra-reader option[value="{sub}"]')).to_have_count(0)
        self.assertEqual(self.rows(f)[0], [])

    def test_suspended_reader_03_saved_records_stay(self):
        f = self.fixture()
        sub = self.reader('pausedkept')
        saved = self.stack.request('POST', f'/studies/{f.uid}/reader-assignment', 'tech', self.assign_body(f, sub))
        self.assertEqual(saved.status, 201, saved.text)
        sent = self.stack.request('POST', f'/studies/{f.uid}/consultations', 'doctor', self.consult_body(sub))
        self.assertEqual(sent.status, 201, sent.text)
        before = self.rows(f)
        self.suspend(sub)
        # The rows saved before the suspension are read back unchanged, and the assignment still names the reader.
        self.assertEqual(self.rows(f), before)
        now = self.stack.request('GET', f'/studies/{f.uid}/reader-assignment', 'tech')
        self.assertEqual(now.status, 200, now.text)
        self.assertEqual(now.body['reader']['sub'], sub)
        item = self.stack.request('GET', '/consultations/' + sent.body['item']['id'], 'doctor')
        self.assertEqual(item.status, 200, item.text)
        self.assertEqual((item.body['item']['recipientSub'], item.body['item']['state']), (sub, 'Requested'))
        # Clearing the assignment of a suspended reader is still allowed (the manager needs that to reassign).
        cleared = self.stack.request('POST', f'/studies/{f.uid}/reader-assignment', 'tech', self.assign_body(f, None))
        self.assertEqual(cleared.status, 201, cleared.text)
        self.assertIsNone(cleared.body['reader'])
        # The requester can still cancel the consultation sent to the suspended reader.
        me = self.stack.request('GET', '/me', 'doctor')
        cancel = dict(expectedOwner=[me.body['institution'], me.body['sub']], revision=item.body['item']['revision'],
                      requestId=str(uuid.uuid4()), action='cancel', note='')
        cancelled = self.stack.request('POST', '/consultations/' + sent.body['item']['id'], 'doctor', cancel)
        self.assertEqual(cancelled.status, 201, cancelled.text)
        self.assertEqual(cancelled.body['item']['state'], 'Cancelled')


def load_tests(loader, tests, pattern):
    # Only the cases declared here: the worklist cases this class inherits are not part of this profile.
    return unittest.TestSuite(SuspendedReaderPickersE2E(name) for name in sorted(vars(SuspendedReaderPickersE2E))
                              if name.startswith('test_'))


if __name__ == '__main__':
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    unittest.main(verbosity=2)
