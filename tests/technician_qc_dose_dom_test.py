# coding: utf-8
"""The Technician tab's QC Flag, the Info panel's protocol and dose lines, and the Tech Note chip's help.

- Tech Note chip: saving and clearing a note on the same page changes the chip's word, its hover help and its accessible
  name together (None -> Yes -> Cleared); a later lower version or a redraw keeps the three in step.

The worklist page and bundle are the committed files; only HTTP answers are synthetic (auth_logout_dom_test.Site).
"""
import json
import re
import unittest
from urllib.parse import urlparse

from playwright.sync_api import expect, sync_playwright
import auth_logout_dom_test as auth

TECH = {**auth.RAD, 'sub': 'SYN-TECH-SUB', 'actor': 'syn-tech@synthetic.test', 'user': 'syn-tech@synthetic.test',
        'displayName': 'SYN Tech Han', 'roles': ['technician']}
NOTE_HELP = {'None': 'Tech 메모가 없습니다', 'Yes': 'Tech 메모가 있습니다', 'Cleared': '메모를 비웠고 이전 이력이 남아 있습니다'}


class Base(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.pw = sync_playwright().start()
        cls.browser = cls.pw.chromium.launch()

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.pw.stop()

    def open(self, account, site=None, width=1600, height=1000):
        self.site = site or auth.Site()
        self.site.account = account
        context = self.browser.new_context(viewport={'width': width, 'height': height}, locale='ko-KR', timezone_id='Asia/Seoul')
        self.addCleanup(context.close)
        self.context = context
        context.route('**/*', lambda route, request: self.site.handle(route, request))
        page = context.new_page()
        page.set_default_timeout(10000)
        self.errors, self.dialogs = [], []
        page.on('pageerror', lambda e: self.errors.append(str(e)))

        def dialog(d):
            self.dialogs.append(d.message)
            d.accept()
        page.on('dialog', dialog)
        self.page = page
        return page

    def go(self):
        self.page.goto(auth.MAIN_URL)
        expect(self.page.locator('#rows')).to_contain_text(auth.PATIENT)

    def technician_tab(self):
        self.page.locator('[data-tab="Technician"]').click()
        expect(self.page.locator('#heads')).to_contain_text('Mt')


class TechNoteChipDOM(Base):
    def chip_state(self):
        chip = self.page.locator('#rows [data-tech-note]').first
        return chip.inner_text(), chip.get_attribute('title'), chip.get_attribute('aria-label')

    def test_save_and_clear_change_word_help_and_name_together(self):
        self.open(TECH)
        notes = []

        def reply(route):
            request = route.request
            if urlparse(request.url).path.endswith('/history'):
                return route.fulfill(json=dict(uid=auth.UID, items=list(reversed(notes)), nextBefore=None))
            if request.method == 'POST':
                body = request.post_data_json
                notes.append(dict(studyUid=auth.UID, version=len(notes) + 1, text=body['text'], reason=body['reason'].strip(),
                                  author='syn-tech@synthetic.test', createdAt='2026-10-05T00:00:00Z',
                                  attemptId=body['attemptId'], isOwnAttempt=True))
            route.fulfill(json=dict(uid=auth.UID, writable=True, note=notes[-1] if notes else None))
        self.context.route('**/api/studies/*/tech-note**', reply)
        self.go()
        self.technician_tab()
        self.page.locator('#rows tr[data-uid]').first.click()
        self.assertEqual(('None', NOTE_HELP['None'], 'SYN-P-001 Tech Note None'), self.chip_state())
        self.page.locator('#rows [data-tech-note]').first.click()
        dialog = self.page.get_by_role('dialog', name='Tech Note', exact=True)
        note = dialog.get_by_label('Note', exact=True)
        expect(note).to_be_editable()
        note.fill('SYN motion artifact on series 2')
        dialog.get_by_role('button', name='Save Note', exact=True).click()
        expect(dialog.get_by_role('status')).to_contain_text('저장되었습니다')
        expect(self.page.locator('#rows [data-tech-note]').first).to_have_text('Yes')
        self.assertEqual(('Yes', NOTE_HELP['Yes'], 'SYN-P-001 Tech Note Yes'), self.chip_state())
        note.fill('')
        dialog.get_by_role('button', name='Save Note', exact=True).click()
        expect(self.page.locator('#rows [data-tech-note]').first).to_have_text('Cleared')
        self.assertEqual(('Cleared', NOTE_HELP['Cleared'], 'SYN-P-001 Tech Note Cleared'), self.chip_state())
        # The next list read still says version 0 (it began before the saves): the chip keeps all three of Cleared.
        self.page.evaluate('() => document.querySelector("#refresh")?.click()')
        self.page.wait_for_timeout(500)
        self.assertEqual(('Cleared', NOTE_HELP['Cleared'], 'SYN-P-001 Tech Note Cleared'), self.chip_state())
        self.assertEqual([], self.errors)


# ── QC Flag ──

NEED_TECH = '방사선사(technician) 권한이 필요합니다'
EPOCH = 'SYNEPOCH1'


class QcSite(auth.Site):
    """The synthetic server with the QC Flag rule (api/src/pacs/qc-flag.ts) on PATCH studies/:uid and stubbed DICOMweb."""

    def __init__(self):
        super().__init__()
        self.qc = {}              # uid -> {reason, by, at, revision}
        self.patches = []         # (uid, body)
        self.patch_answers = []   # queued replies: (status, body) or 'hold'
        self.held_patches = []
        self.modality = {}        # uid -> modality of the list row
        self.dicom_calls = []

    def mark(self, uid, account):
        mark = self.qc.get(uid) or {'reason': None, 'by': None, 'at': None, 'revision': 0}
        return dict(mark, by=mark['by'] if account['institution'] == auth.INSTITUTION else None)

    def study_row(self, account, uid=auth.UID, name=auth.PATIENT, patient='SYN-P-001'):
        row = super().study_row(account, uid, name, patient)
        row['state'] = dict(row['state'], qc=self.mark(uid, account), draftEpoch='00000000-0000-4000-8000-0000000000e1')
        row['modality'] = self.modality.get(uid, row['modality'])
        return row

    def handle(self, route, request):
        path = urlparse(request.url).path
        if path.startswith('/dicom-web/'):
            self.dicom_calls.append(path)
        return super().handle(route, request)

    def api(self, route, request, method, path, query):
        found = re.fullmatch(r'/api/studies/([^/]+)', path)
        if found and method == 'PATCH':
            account, refused = self.authenticate(request)
            if refused:
                return self.refuse(route, *refused)
            uid, body = found.group(1), request.post_data_json
            self.patches.append((uid, body))
            if self.patch_answers:
                reply = self.patch_answers.pop(0)
                if reply == 'hold':
                    return self.held_patches.append((route, uid, body, account))
                return route.fulfill(status=reply[0], json=reply[1])
            return self.patch(route, uid, body, account)
        return super().api(route, request, method, path, query)

    def patch(self, route, uid, body, account):
        if 'technician' not in account['roles'] and 'admin' not in account['roles']:
            return route.fulfill(status=403, json={'statusCode': 403, 'message': 'SYN QC 표시은(는) technician 권한이 필요합니다'})
        if set(body) != {'qc', 'qcRevision', 'epoch'}:
            return route.fulfill(status=400, json={'statusCode': 400, 'message': 'SYN mixed'})
        mark = self.mark(uid, account)
        if body['epoch'] != '00000000-0000-4000-8000-0000000000e1':
            return route.fulfill(status=409, json={'code': 'QC_STUDY_CHANGED', 'message': 'SYN 검사가 바뀌었습니다'})
        if not (body['qc'] is None and mark['reason'] is None):
            if body['qcRevision'] != mark['revision']:
                return route.fulfill(status=409, json={'code': 'QC_REVISION_CHANGED', 'message': 'SYN 다른 사람이 바꿨습니다'})
            self.qc[uid] = {'reason': None, 'by': None, 'at': None, 'revision': mark['revision'] + 1} if body['qc'] is None else \
                {'reason': body['qc']['reason'].strip(), 'by': account['actor'], 'at': '2026-10-03T01:02:00.000Z', 'revision': mark['revision'] + 1}
        row = next(r for r in self.list_body(account)['studies'] if r['uid'] == uid)
        return route.fulfill(json=row['state'])


class QcFlagDOM(Base):
    def open_qc(self, account, flagged=None):
        site = QcSite()
        if flagged:
            site.qc[auth.UID] = {'reason': flagged, 'by': 'syn-tech@synthetic.test', 'at': '2026-10-03T01:00:00.000Z', 'revision': 1}
        self.open(account, site)
        self.go()
        return self.page

    def qc_cell(self):
        heads = self.page.locator('#heads th').all_inner_texts()
        at = [h.strip() for h in heads].index('QC Flag')
        return self.page.locator('#rows tr[data-uid]').first.locator('td').nth(at)

    def window(self):
        return self.page.get_by_role('dialog', name='QC Flag', exact=True)

    def test_mark_change_and_clear_from_the_technician_bar(self):
        page = self.open_qc(TECH)
        self.technician_tab()
        heads = [h.strip() for h in page.locator('#heads th').all_inner_texts()]
        self.assertEqual(heads.index('Tech Note') + 1, heads.index('QC Flag'), heads)
        expect(self.qc_cell()).to_have_text('')
        page.locator('#rows tr[data-uid]').first.click()
        expect(page.locator('#study-qc')).to_contain_text('QC Flag: None')
        page.locator('#t-qc-flag').click()
        window = self.window()
        expect(window).to_be_visible()
        expect(window.locator('#qc-flag-now')).to_have_text('No QC flag')
        expect(window.get_by_role('button', name='Clear Flag', exact=True)).to_be_disabled()
        window.get_by_label('Reason').fill('  SYN <b>motion</b> on series 2  ')
        window.get_by_role('button', name='Flag', exact=True).click()
        expect(window).to_be_hidden()
        self.assertEqual([(auth.UID, {'qc': {'reason': 'SYN <b>motion</b> on series 2'}, 'qcRevision': 0,
                                     'epoch': '00000000-0000-4000-8000-0000000000e1'})], self.site.patches)
        # The column, its title and the Info line show the server's answer; the reason is data (not markup, not translated).
        expect(self.qc_cell()).to_contain_text('Flagged')
        reason = self.qc_cell().locator('.qc-reason')
        expect(reason).to_have_text('SYN <b>motion</b> on series 2')
        self.assertEqual('no', reason.get_attribute('translate'))
        expect(page.locator('#study-qc')).to_contain_text('QC Flag: Flagged — SYN <b>motion</b> on series 2')
        self.assertEqual('no', page.locator('#study-qc .qc-info-reason').get_attribute('translate'))
        # SS, RS and the match are their own columns and keep their values.
        row = page.locator('#rows tr[data-uid]').first
        expect(row).to_contain_text('Verified')
        # The filter: Flagged keeps the row, None hides it.
        flt = page.locator('#filterrow select[data-f="qc"]')
        flt.select_option('None')
        expect(page.locator('#rows tr[data-uid]')).to_have_count(0)
        flt.select_option('Flagged')
        expect(page.locator('#rows tr[data-uid]')).to_have_count(1)
        flt.select_option('')
        # Change the reason, then clear: each sends the revision it showed.
        page.locator('#rows tr[data-uid]').first.click()
        page.locator('#t-qc-flag').click()
        expect(self.window().get_by_label('Reason')).to_have_value('SYN <b>motion</b> on series 2')
        self.window().get_by_label('Reason').fill('SYN repeat requested')
        self.window().get_by_role('button', name='Flag', exact=True).click()
        expect(self.window()).to_be_hidden()
        page.locator('#t-qc-flag').click()
        self.window().get_by_role('button', name='Clear Flag', exact=True).click()
        expect(self.window()).to_be_hidden()
        self.assertEqual([1, 2], [b['qcRevision'] for _, b in self.site.patches[1:]])
        self.assertIsNone(self.site.patches[-1][1]['qc'])
        expect(self.qc_cell()).to_have_text('')
        expect(page.locator('#study-qc')).to_contain_text('QC Flag: None')
        self.assertEqual([], self.errors)
        self.assertEqual([], self.site.violations)

    def test_a_radiologist_sees_the_mark_and_reason_and_cannot_write(self):
        page = self.open_qc(auth.RAD, flagged='SYN blur on the lateral view')
        page.locator('#rows tr[data-uid]').first.click()
        expect(page.locator('#study-qc')).to_contain_text('QC Flag: Flagged — SYN blur on the lateral view')
        self.technician_tab()
        expect(page.locator('#t-qc-flag')).to_be_disabled()
        expect(page.locator('#t-qc-flag')).to_have_attribute('title', NEED_TECH)
        page.locator('#t-qc-flag').click(force=True)
        page.wait_for_timeout(300)
        expect(self.window()).to_have_count(0)
        self.assertEqual([], self.site.patches)
        self.assertEqual([], self.errors)

    def test_a_refusal_is_said_and_an_older_list_answer_does_not_undo_the_mark(self):
        page = self.open_qc(TECH)
        self.technician_tab()
        page.locator('#rows tr[data-uid]').first.click()
        # Refused (another window changed it): the window says so and the list is read again; nothing is painted.
        self.site.patch_answers.append((409, {'code': 'QC_REVISION_CHANGED', 'message': 'SYN 다른 사람이 바꿨습니다'}))
        reads = lambda: sum(1 for m, p in self.site.calls if m == 'GET' and p == '/api/studies')
        before = reads()
        page.locator('#t-qc-flag').click()
        self.window().get_by_label('Reason').fill('SYN first try')
        self.window().get_by_role('button', name='Flag', exact=True).click()
        expect(self.window().locator('#qc-flag-status')).to_contain_text('SYN 다른 사람이 바꿨습니다')
        expect(self.qc_cell()).to_have_text('')
        for _ in range(50):
            if reads() > before:
                break
            page.wait_for_timeout(100)
        self.assertGreater(reads(), before, 'the list was not read again after the refusal')
        self.window().get_by_role('button', name='Flag', exact=True).click()
        expect(self.window()).to_be_hidden()
        expect(self.qc_cell()).to_contain_text('SYN first try')
        # A list answer read before the mark (revision 0) arrives late: the mark stays.
        stale = self.site.list_body(TECH)
        stale['studies'][0]['state']['qc'] = {'reason': None, 'by': None, 'at': None, 'revision': 0}
        self.site.list_answers.append((200, stale))
        page.locator('#m-refresh').click()
        page.wait_for_timeout(600)
        expect(self.qc_cell()).to_contain_text('SYN first try')
        expect(page.locator('#study-qc')).to_contain_text('Flagged')
        # An answer without a readable mark (Unknown) does not undo it either; a list that says nothing new keeps it.
        self.assertEqual([], self.errors)

    def test_unknown_is_not_none(self):
        site = QcSite()
        self.open(TECH, site)
        original = site.study_row

        def unknown(account, uid=auth.UID, name=auth.PATIENT, patient='SYN-P-001'):
            row = original(account, uid, name, patient)
            row['state'].pop('qc')
            return row
        site.study_row = unknown
        self.go()
        self.technician_tab()
        expect(self.qc_cell()).to_have_text('Unknown')
        self.page.locator('#filterrow select[data-f="qc"]').select_option('None')
        expect(self.page.locator('#rows tr[data-uid]')).to_have_count(0)
        self.page.locator('#filterrow select[data-f="qc"]').select_option('Unknown')
        expect(self.page.locator('#rows tr[data-uid]')).to_have_count(1)
        self.assertEqual([], self.errors)

    def test_a_late_qc_answer_takes_only_the_mark_never_an_older_report_state(self):
        page = self.open_qc(TECH)
        self.technician_tab()
        page.locator('#rows tr[data-uid]').first.click()
        self.site.patch_answers.append('hold')
        page.locator('#t-qc-flag').click()
        self.window().get_by_label('Reason').fill('SYN late answer')
        self.window().get_by_role('button', name='Flag', exact=True).click()
        for _ in range(50):
            if self.site.held_patches:
                break
            page.wait_for_timeout(100)
        self.assertTrue(self.site.held_patches)
        self.window().get_by_role('button', name='Cancel', exact=True).click()
        # Meanwhile the report was approved; a Refresh shows it.
        self.site.report = {'version': 1, 'rs': 'A'}
        page.locator('#m-refresh').click()
        row = page.locator('#rows tr[data-uid]').first
        expect(row).to_contain_text('Approved')
        # The QC answer was made before the approval: its RS is W. Only its mark is taken.
        route, uid, body, account = self.site.held_patches[0]
        late = dict(self.site.study_row(account)['state'], rs='W', version=0,
                    qc={'reason': 'SYN late answer', 'by': account['actor'], 'at': '2026-10-03T01:02:00.000Z', 'revision': 1})
        route.fulfill(json=late)
        expect(self.qc_cell()).to_contain_text('SYN late answer')
        expect(row).to_contain_text('Approved')
        self.assertEqual([], self.errors)


# ── Protocol & Dose ──

def tag(vr, *values):
    return {'vr': vr, 'Value': list(values)}


def instance(study, series, sop, sop_class='1.2.840.10008.5.1.4.1.1.2', protocol=None, ctdi=None, extra=None):
    ds = {'0020000D': tag('UI', study), '0020000E': tag('UI', series), '00080018': tag('UI', sop), '00080016': tag('UI', sop_class)}
    if protocol is not None:
        ds['00181030'] = tag('LO', protocol)
    if ctdi is not None:
        ds['00189345'] = tag('FD', ctdi)
    ds.update(extra or {})
    return ds


def concept(code):
    return tag('SQ', {'00080100': tag('SH', code), '00080102': tag('SH', 'DCM')})


def num(code, value, unit, scheme='UCUM'):
    return {'0040A040': tag('CS', 'NUM'), '0040A043': concept(code), '0040A300': tag('SQ', {'0040A30A': tag('DS', value),
            '004008EA': tag('SQ', {'00080100': tag('SH', unit), '00080102': tag('SH', scheme)}) if unit else tag('SQ')})}


def container(code, *children):
    return {'0040A040': tag('CS', 'CONTAINER'), '0040A043': concept(code), '0040A730': tag('SQ', *children)}


def series_row(study, series, number, modality, description):
    return {'0020000D': tag('UI', study), '0020000E': tag('UI', series), '00200011': tag('IS', number),
            '00080060': tag('CS', modality), '0008103E': tag('LO', description)}


RDSR = '1.2.840.10008.5.1.4.1.1.88.67'


class AcquisitionDOM(Base):
    def site(self):
        site = QcSite()
        site.second_study = True
        site.modality[auth.UID_B] = 'CR'
        a, b = auth.UID, auth.UID_B
        s2, s3, s9, s8 = a + '.2', a + '.3', a + '.900', a + '.899'
        site.gets['/dicom-web/studies/%s/series' % a] = (200, [series_row(a, s2, '2', 'CT', 'SYN CHEST'),
            series_row(a, s3, '3', 'CT', 'SYN CHEST THIN'), series_row(a, s8, '899', 'SR', 'SYN KEY NOTES'),
            series_row(a, s9, '900', 'SR', 'SYN DOSE REPORT')])
        site.gets['/dicom-web/studies/%s/series/%s/metadata' % (a, s2)] = (200, [
            instance(a, s2, s2 + '.1', protocol='SYN CHEST ROUTINE', ctdi=8.12),
            instance(a, s2, s2 + '.2', protocol='SYN CHEST ROUTINE', ctdi=8.12),
            instance(a, s2, s2 + '.3', protocol='SYN CHEST ROUTINE', ctdi=9.4)])
        # The first object lacks the protocol; a later one has it - the whole series is read.
        site.gets['/dicom-web/studies/%s/series/%s/metadata' % (a, s3)] = (200, [
            instance(a, s3, s3 + '.1', ctdi=7.5), instance(a, s3, s3 + '.2', protocol='SYN THIN', ctdi=7.5)])
        # An ordinary SR first, then the dose report in another series.
        site.gets['/dicom-web/studies/%s/series/%s/metadata' % (a, s8)] = (200, [
            instance(a, s8, s8 + '.1', sop_class='1.2.840.10008.5.1.4.1.1.88.22')])
        site.gets['/dicom-web/studies/%s/series/%s/metadata' % (a, s9)] = (200, [
            instance(a, s9, s9 + '.1', sop_class=RDSR, extra={'0040A730': tag('SQ',
                container('113811', num('113813', '312.4', 'mGy.cm'), num('113812', '2', '{events}')),
                container('113819', num('113830', '8.1', 'mGy'), num('113838', '160.2', 'mGy.cm')))})])
        cr = b + '.1'
        site.gets['/dicom-web/studies/%s/series' % b] = (200, [series_row(b, cr, '1', 'CR', 'SYN CHEST PA')])
        site.gets['/dicom-web/studies/%s/series/%s/metadata' % (b, cr)] = (200, [instance(b, cr, cr + '.1',
                                                                                         sop_class='1.2.840.10008.5.1.4.1.1.1')])
        return site

    def lines(self):
        return [line.strip() for line in self.page.locator('#study-acquisition .acq-line').all_inner_texts()]

    def test_ct_shows_protocol_and_dose_with_tags_and_units_and_cr_says_not_in_dicom(self):
        site = self.site()
        self.open(TECH, site)
        self.go()
        # Radiology tab: no block, no DICOM read.
        self.page.locator('#rows tr[data-uid]').first.click()
        expect(self.page.locator('#study-acquisition')).to_be_hidden()
        self.page.wait_for_timeout(300)
        self.assertEqual([], [p for p in site.dicom_calls if '/series' in p])
        self.technician_tab()
        self.page.locator('#rows tr[data-uid="%s"]' % auth.UID).click()
        expect(self.page.locator('#study-acquisition')).to_contain_text('DLP (Dose SR Se 900)')
        lines = self.lines()
        self.assertEqual('Protocol & Dose (recorded in DICOM)', lines[0])
        self.assertIn('Se 2 · CT · SYN CHEST', lines)
        self.assertIn('Protocol (0018,1030): SYN CHEST ROUTINE', lines)
        self.assertIn('CTDIvol (0018,9345): 8.12 mGy (images 1–2), 9.4 mGy (image 3)', lines)
        self.assertIn('Protocol (0018,1030): SYN THIN (image 2) · Not in DICOM (image 1)', lines)
        self.assertIn('CTDIvol (0018,9345): 7.5 mGy', lines)
        # The SR's own total, with the unit it records; the events are not added to it or shown beside it.
        self.assertIn('DLP (Dose SR Se 900) %s: 312.4 mGy.cm (total recorded in this Dose SR, 113813)' % (auth.UID + '.900.1'), lines)
        self.assertFalse(any('Event' in line for line in lines), lines)
        values = self.page.locator('#study-acquisition span[translate="no"]').all_inner_texts()
        self.assertIn('SYN CHEST ROUTINE', values)
        # The CR study: read whole, nothing recorded.
        self.page.locator('#rows tr[data-uid="%s"]' % auth.UID_B).click()
        expect(self.page.locator('#study-acquisition')).to_contain_text('Se 1 · CR · SYN CHEST PA')
        expect(self.page.locator('#study-acquisition')).to_contain_text('DLP (Dose SR): Not in DICOM')
        lines = self.lines()
        self.assertIn('Protocol (0018,1030): Not in DICOM', lines)
        self.assertIn('CTDIvol (0018,9345): Not in DICOM', lines)
        # Back to the CT (A -> B -> A): its answer is kept, not read again.
        calls = len(site.dicom_calls)
        self.page.locator('#rows tr[data-uid="%s"]' % auth.UID).click()
        expect(self.page.locator('#study-acquisition')).to_contain_text('312.4 mGy.cm')
        self.page.wait_for_timeout(300)
        self.assertEqual([], [p for p in site.dicom_calls[calls:] if p.endswith('/metadata') or p.endswith('/series')], site.dicom_calls[calls:])
        self.assertEqual([], self.errors)

    def test_a_failed_series_is_could_not_read_and_dlp_is_not_called_absent(self):
        site = self.site()
        site.gets['/dicom-web/studies/%s/series/%s/metadata' % (auth.UID, auth.UID + '.900')] = (403, {'code': 'SYN'})
        # A dose event without a total: shown as that event's values.
        b = auth.UID_B
        site.gets['/dicom-web/studies/%s/series' % b] = (200, [series_row(b, b + '.9', '9', 'SR', 'SYN DOSE')])
        site.gets['/dicom-web/studies/%s/series/%s/metadata' % (b, b + '.9')] = (200, [instance(b, b + '.9', b + '.9.1', sop_class=RDSR,
            extra={'0040A730': tag('SQ', container('113819', num('113830', '5.5', 'mGy'), num('113838', '99', None)))})])
        self.open(TECH, site)
        self.go()
        self.technician_tab()
        self.page.locator('#rows tr[data-uid="%s"]' % auth.UID).click()
        expect(self.page.locator('#study-acquisition')).to_contain_text('Se 900 · SR · SYN DOSE REPORT — Could not read')
        self.assertIn('DLP (Dose SR): Not found in the series read', self.lines())
        self.page.locator('#rows tr[data-uid="%s"]' % auth.UID_B).click()
        expect(self.page.locator('#study-acquisition')).to_contain_text('Event 1:')
        self.assertIn('DLP (Dose SR Se 9) %s: Event 1: CTDIvol 5.5 mGy · DLP Could not read' % (b + '.9.1'), self.lines())
        self.assertEqual([], self.errors)
    def test_enhanced_ct_frames_and_a_split_part_keep_their_own_sources(self):
        site = self.site()
        a = auth.UID
        se = a + '.5'
        frame = lambda value: {'00189321': tag('SQ', {'00189345': tag('FD', value)})} if value is not None else {}
        site.gets['/dicom-web/studies/%s/series' % a] = (200, [series_row(a, se, '5', 'CT', 'SYN ENHANCED'),
            series_row(a, a + '.3', '3', 'CT', 'SYN CHEST THIN'), series_row(a, a + '.900', '900', 'SR', 'SYN DOSE REPORT')])
        # One enhanced multi-frame object: per-frame CTDIvol 10, 10, 12 and one frame that has none (the shared group has none).
        site.gets['/dicom-web/studies/%s/series/%s/metadata' % (a, se)] = (200, [instance(a, se, se + '.1',
            sop_class='1.2.840.10008.5.1.4.1.1.2.1', protocol='SYN ENH', extra={'52009230': tag('SQ', frame(10), frame(10), frame(12), frame(None)),
                                                                                  '52009229': tag('SQ', {})})])
        original = site.study_row

        def split(account, uid=auth.UID, name=auth.PATIENT, patient='SYN-P-001'):
            row = original(account, uid, name, patient)
            if uid == a:
                # The first part of a split exam: every series but the thin one.
                row['examScope'] = {'reportUid': a, 'groupId': '00000000-0000-4000-8000-0000000000f1', 'kind': 'split', 'part': 0,
                                    'active': True, 'generation': 'SYN-G1',
                                    'sources': [{'studyUid': a, 'series': {'mode': 'exclude', 'uids': [a + '.3']}}]}
            return row
        site.study_row = split
        self.open(TECH, site)
        self.go()
        self.technician_tab()
        self.page.locator('#rows tr[data-uid="%s"]' % a).click()
        expect(self.page.locator('#study-acquisition')).to_contain_text('SYN ENHANCED')
        lines = self.lines()
        self.assertIn('CTDIvol (0018,9345): 10 mGy (image 1: frames 1–2), 12 mGy (image 1: frame 3) · Not in DICOM (image 1: frame 4)', lines)
        self.assertFalse(any('SYN CHEST THIN' in line for line in lines), lines)
        self.assertNotIn('/dicom-web/studies/%s/series/%s/metadata' % (a, a + '.3'), site.dicom_calls)
        # The dose report of the original study is said to be the whole study's, not this part's.
        self.assertIn('DLP (Dose SR Se 900) %s — not computed for this part: 312.4 mGy.cm (total recorded in this Dose SR, 113813)' % (a + '.900.1'), lines)
        self.assertEqual([], self.errors)
    def test_a_unit_or_code_scheme_it_cannot_vouch_for_is_could_not_read(self):
        site = self.site()
        a, s9 = auth.UID, auth.UID + '.900'
        site.gets['/dicom-web/studies/%s/series/%s/metadata' % (a, s9)] = (200, [
            instance(a, s9, s9 + '.1', sop_class=RDSR, extra={'0040A730': tag('SQ', container('113811', num('113813', '312.4', 's')))}),
            instance(a, s9, s9 + '.2', sop_class=RDSR, extra={'0040A730': tag('SQ', container('113811', num('113813', '99.9', 'mGy.cm', 'LOCAL')))})])
        self.open(TECH, site)
        self.go()
        self.technician_tab()
        self.page.locator('#rows tr[data-uid="%s"]' % a).click()
        expect(self.page.locator('#study-acquisition')).to_contain_text(s9 + '.2')
        lines = self.lines()
        for sop in (s9 + '.1', s9 + '.2'):
            self.assertIn('DLP (Dose SR Se 900) %s: Could not read (total recorded in this Dose SR, 113813)' % sop, lines)
        self.assertFalse(any('312.4' in line or '99.9' in line for line in lines), lines)
        self.assertEqual([], self.errors)

    def test_an_answer_read_before_refresh_does_not_paint_over_the_newer_one(self):
        site = self.site()
        a, s9 = auth.UID, auth.UID + '.900'
        path = '/dicom-web/studies/%s/series/%s/metadata' % (a, s9)
        held = []
        newer = [instance(a, s9, s9 + '.1', sop_class=RDSR, extra={'0040A730': tag('SQ', container('113811', num('113813', '412.4', 'mGy.cm')))})]
        old = site.gets[path][1]

        def answer(route):
            if not held:
                held.append(route)
            else:
                route.fulfill(json=newer)
        self.open(TECH, site)
        self.context.route('**' + path, answer)
        self.go()
        self.technician_tab()
        self.page.locator('#rows tr[data-uid="%s"]' % a).click()
        for _ in range(50):
            if held:
                break
            self.page.wait_for_timeout(100)
        self.assertTrue(held, 'the first read of the dose report was not sent')
        self.page.locator('#m-refresh').click()
        expect(self.page.locator('#study-acquisition')).to_contain_text('412.4 mGy.cm')
        held[0].fulfill(json=old)
        self.page.wait_for_timeout(500)
        expect(self.page.locator('#study-acquisition')).to_contain_text('412.4 mGy.cm')
        self.assertNotIn('312.4', self.page.locator('#study-acquisition').inner_text())
        self.assertEqual([], self.errors)

    def test_a_merged_exam_keeps_each_original_apart_and_a_failed_original_is_said(self):
        site = self.site()
        a, b = auth.UID, auth.UID_B
        site.gets['/dicom-web/studies/%s/series' % b] = (500, {'code': 'SYN'})
        # One object of the CT's thin series has no SOP Instance UID: that series is not read, never "absent".
        broken = instance(a, a + '.3', a + '.3.1', ctdi=7.5)
        del broken['00080018']
        site.gets['/dicom-web/studies/%s/series/%s/metadata' % (a, a + '.3')] = (200, [broken])
        original = site.study_row

        def merged(account, uid=auth.UID, name=auth.PATIENT, patient='SYN-P-001'):
            row = original(account, uid, name, patient)
            if uid == a:
                row['examScope'] = {'reportUid': a, 'groupId': '00000000-0000-4000-8000-0000000000f2', 'kind': 'merge', 'part': None,
                                    'active': True, 'generation': 'SYN-G2', 'sources': [
                                        {'studyUid': a, 'series': {'mode': 'all', 'uids': []}},
                                        {'studyUid': b, 'series': {'mode': 'all', 'uids': []}}]}
            return row
        site.study_row = merged
        self.open(TECH, site)
        self.go()
        self.technician_tab()
        self.page.locator('#rows tr[data-uid="%s"]' % a).click()
        expect(self.page.locator('#study-acquisition')).to_contain_text('Series list could not be read')
        lines = self.lines()
        self.assertIn('%s · Series list could not be read' % b, lines)
        self.assertIn('%s · Se 2 · CT · SYN CHEST' % a, lines)
        self.assertIn('CTDIvol (0018,9345): 8.12 mGy (images 1–2), 9.4 mGy (image 3)', lines)
        self.assertIn('%s · Se 3 · CT · SYN CHEST THIN — Could not read' % a, lines)
        self.assertIn('DLP (Dose SR Se 900) %s · %s: 312.4 mGy.cm (total recorded in this Dose SR, 113813)' % (a, a + '.900.1'), lines)
        self.assertFalse(any(line.endswith('Not in DICOM') and line.startswith('DLP') for line in lines), lines)
        self.assertEqual([], self.errors)


if __name__ == '__main__':
    unittest.main()
