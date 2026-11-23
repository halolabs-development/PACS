# coding: utf-8
"""The Technician tab's QC Flag, the Info panel's protocol and dose lines, and the Tech Note chip's help.

- Tech Note chip: saving and clearing a note on the same page changes the chip's word, its hover help and its accessible
  name together (None -> Yes -> Cleared); a later lower version or a redraw keeps the three in step.
- QC Flag: the mark, its reason and who marked are shown, compared and written only for a row of the list the server last
  sent that this account can read now; the open window, the column, the Info line and Export List follow that list.
- Protocol & Dose: each value with where it was read (original study, series, SOP Instance UID, frame); "Not in DICOM" only
  of what was read whole; an original or exam out of reach leaves nothing read from it on the screen or in memory.

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
EPOCH = '00000000-0000-4000-8000-0000000000e1'
OTHER = 'SYN-INST-B'
# Another technician of the same institution marked. The server names who marked for the reader (qc.byName -
# api/src/account-identity.ts markerShown); the page shows that as is, never the login (WHO), which no list of this page names.
WHO = 'syn-tech2@synthetic.test'
WHO_NAME = 'SYN Tech Park'
QC_NAMES = {WHO: WHO_NAME, 'syn-tech3@synthetic.test': 'SYN Tech Choi', TECH['actor']: TECH['displayName']}


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
        self.gone = set()         # UIDs the list does not have (any more)
        self.unavailable = set()  # rows of a merged exam whose originals cannot all be read now
        self.tele = set()         # rows this institution only receives for tele-reading now (another institution's study)
        self.scopes = {}          # uid -> examScope of the row
        self.one_patient = False  # both rows are one patient's studies (Related)
        self.listed = {}          # study -> {Series Instance UID: the number of objects its archive holds} (archive())
        self.series_said = {}     # uid -> the number of series the list row says, when not the archive's (None: unknown)
        self.images_said = {}     # uid -> the number of images the list row says, when not the archive's (None: unknown)

    def mark(self, uid, account):
        mark = self.qc.get(uid) or {'reason': None, 'by': None, 'at': None, 'revision': 0}
        owner = account['institution'] == auth.INSTITUTION and uid not in self.tele
        by = mark['by'] if owner else None
        return dict(mark, by=by, byName=QC_NAMES.get(by, by) if by else None)

    def study_row(self, account, uid=auth.UID, name=auth.PATIENT, patient='SYN-P-001'):
        row = super().study_row(account, uid, name, patient)
        row['state'] = dict(row['state'], qc=self.mark(uid, account), draftEpoch=EPOCH)
        row['modality'] = self.modality.get(uid, row['modality'])
        if uid in self.tele:
            row['tele'] = True
            row['state'].update(institutionId=OTHER, teleInstitutionId=auth.INSTITUTION)
        if uid in self.unavailable:
            row.update(examUnavailable=True, examUnavailableKind='merge')
        elif uid in self.scopes:
            row['examScope'] = self.scopes[uid]
        if self.one_patient:
            row['sourcePatientKey'] = auth.INSTITUTION + '|SYN-P-001'
        held = self.held(uid)
        if held is not None:
            row['series'], row['count'] = len(held), sum(held)
        if uid in self.series_said:
            row['series'] = self.series_said[uid]
        if uid in self.images_said:
            row['count'] = self.images_said[uid]
        return row

    def held(self, uid):
        """The object counts of the series of the row's exam, as the server counts them: every series the archive holds of
        each original of its scope, a split part's own series only. None: no archive was described for it."""
        sources = self.scopes[uid]['sources'] if uid in self.scopes else [{'studyUid': uid, 'series': {'mode': 'all', 'uids': []}}]
        if not any(source['studyUid'] in self.listed for source in sources):
            return None
        allowed = lambda source, series: source['series']['mode'] == 'all' or \
            (series in source['series']['uids']) == (source['series']['mode'] == 'include')
        return [count for source in sources for series, count in self.listed.get(source['studyUid'], {}).items() if allowed(source, series)]

    def list_body(self, account, rename=None):
        body = super().list_body(account, rename)
        body['studies'] = [row for row in body['studies'] if row['uid'] not in self.gone]
        body['pagination']['total'] = len(body['studies'])
        return body

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
        if body['epoch'] != EPOCH:
            return route.fulfill(status=409, json={'code': 'QC_STUDY_CHANGED', 'message': 'SYN 검사가 바뀌었습니다'})
        if not (body['qc'] is None and mark['reason'] is None):
            if body['qcRevision'] != mark['revision']:
                return route.fulfill(status=409, json={'code': 'QC_REVISION_CHANGED', 'message': 'SYN 다른 사람이 바꿨습니다'})
            self.qc[uid] = {'reason': None, 'by': None, 'at': None, 'revision': mark['revision'] + 1} if body['qc'] is None else \
                {'reason': body['qc']['reason'].strip(), 'by': account['actor'], 'at': '2026-10-03T01:02:00.000Z', 'revision': mark['revision'] + 1}
        row = next(r for r in self.list_body(account)['studies'] if r['uid'] == uid)
        return route.fulfill(json=row['state'])


class QcBase(Base):
    def open_qc(self, account, flagged=None, site=None, clock=False):
        site = site or QcSite()
        if flagged:
            site.qc[auth.UID] = {'reason': flagged, 'by': WHO, 'at': '2026-10-03T01:00:00.000Z', 'revision': 1}
        self.open(account, site)
        if clock:
            self.page.clock.install()
        self.go()
        return self.page

    def qc_cell(self, uid=auth.UID):
        heads = self.page.locator('#heads th').all_inner_texts()
        at = [h.strip() for h in heads].index('QC Flag')
        return self.page.locator('#rows tr[data-uid="%s"]' % uid).locator('td').nth(at)

    def window(self):
        return self.page.get_by_role('dialog', name='QC Flag', exact=True)

    def list_reads(self):
        return sum(1 for m, p in self.site.calls if m == 'GET' and p == '/api/studies')

    def reread(self):
        """A list read as Refresh starts it (also while a modal window is open), until the server has been asked."""
        before = self.list_reads()
        self.page.evaluate('() => document.querySelector("#m-refresh").click()')
        for _ in range(100):
            if self.list_reads() > before:
                return
            self.page.wait_for_timeout(50)
        self.fail('the list was not read again')

    def poll(self):
        """One turn of the list's own poll (30 seconds on the page's clock: open_qc(clock=True))."""
        before = self.list_reads()
        self.page.clock.run_for(31000)
        for _ in range(100):
            if self.list_reads() > before:
                return
            self.page.wait_for_timeout(50)
        self.fail('the list was not polled')

    def shown_everywhere(self):
        """Every text and tooltip of the page, the QC window's typed value included."""
        return self.page.evaluate("""() => [document.body.innerText,
            ...[...document.querySelectorAll('[title]')].map(e => e.title),
            ...[...document.querySelectorAll('input, textarea')].map(e => e.value)].join('\\n')""")


class QcFlagDOM(QcBase):
    def test_mark_change_and_clear_from_the_technician_bar(self):
        page = self.open_qc(TECH)
        self.technician_tab()
        heads = [h.strip() for h in page.locator('#heads th').all_inner_texts()]
        self.assertEqual(heads.index('Tech Note') + 1, heads.index('QC Flag'), heads)
        expect(self.qc_cell()).to_have_text('')
        page.locator('#rows tr[data-uid]').first.click()
        expect(page.locator('#study-qc')).to_contain_text('QC Flag: None')
        # Every other cell of the row and the receipt block (SS, RS, the order match, the count and its missing-images mark):
        # the mark is its own fact and changes none of them.
        at = heads.index('QC Flag')
        others = lambda: ([text for i, text in enumerate(page.locator('#rows tr[data-uid]').first.locator('td').all_inner_texts()) if i != at],
                          page.locator('#study-receipt').inner_text(), page.locator('#clinical').inner_text())
        before = others()
        page.locator('#t-qc-flag').click()
        window = self.window()
        expect(window).to_be_visible()
        expect(window.locator('#qc-flag-now')).to_have_text('No QC flag')
        expect(window.get_by_role('button', name='Clear Flag', exact=True)).to_be_disabled()
        window.get_by_label('Reason').fill('  SYN <b>motion</b> on series 2  ')
        window.get_by_role('button', name='Flag', exact=True).click()
        expect(window).to_be_hidden()
        self.assertEqual([(auth.UID, {'qc': {'reason': 'SYN <b>motion</b> on series 2'}, 'qcRevision': 0, 'epoch': EPOCH})], self.site.patches)
        # The column, its title and the Info line show the server's answer; the reason is data (not markup, not translated).
        expect(self.qc_cell()).to_contain_text('Flagged')
        reason = self.qc_cell().locator('.qc-reason')
        expect(reason).to_have_text('SYN <b>motion</b> on series 2')
        self.assertEqual('no', reason.get_attribute('translate'))
        expect(page.locator('#study-qc')).to_contain_text('QC Flag: Flagged — SYN <b>motion</b> on series 2')
        self.assertEqual('no', page.locator('#study-qc .qc-info-reason').get_attribute('translate'))
        # Who marked is the name the server sent, not the login.
        expect(page.locator('#study-qc')).to_contain_text(TECH['displayName'])
        self.assertNotIn(TECH['actor'], page.locator('#study-qc').inner_text())
        # SS, RS and the match are their own columns and keep their values.
        row = page.locator('#rows tr[data-uid]').first
        expect(row).to_contain_text('Verified')
        self.assertEqual(before, others(), 'marking changed something that is not the mark')
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
        self.assertEqual(before, others(), 'clearing changed something that is not the mark')
        self.assertEqual([], self.errors)
        self.assertEqual([], self.site.violations)

    def test_a_radiologist_sees_the_mark_and_reason_and_cannot_write(self):
        page = self.open_qc(auth.RAD, flagged='SYN blur on the lateral view')
        page.locator('#rows tr[data-uid]').first.click()
        expect(page.locator('#study-qc')).to_contain_text('QC Flag: Flagged — SYN blur on the lateral view')
        # The technician who marked is named as the server names them for this reader, never by the login.
        expect(page.locator('#study-qc')).to_contain_text(WHO_NAME)
        self.assertNotIn(WHO, self.shown_everywhere())
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
        before = self.list_reads()
        page.locator('#t-qc-flag').click()
        self.window().get_by_label('Reason').fill('SYN first try')
        self.window().get_by_role('button', name='Flag', exact=True).click()
        expect(self.window().locator('#qc-flag-status')).to_contain_text('SYN 다른 사람이 바꿨습니다')
        expect(self.qc_cell()).to_have_text('')
        for _ in range(50):
            if self.list_reads() > before:
                break
            page.wait_for_timeout(100)
        self.assertGreater(self.list_reads(), before, 'the list was not read again after the refusal')
        expect(self.window().get_by_label('Reason')).to_have_value('SYN first try')
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
                    qc={'reason': 'SYN late answer', 'by': account['actor'], 'byName': QC_NAMES.get(account['actor'], account['actor']),
                        'at': '2026-10-03T01:02:00.000Z', 'revision': 1})
        route.fulfill(json=late)
        expect(self.qc_cell()).to_contain_text('SYN late answer')
        expect(row).to_contain_text('Approved')
        self.assertEqual([], self.errors)


class QcFollowsTheListDOM(QcBase):
    """What shows a QC mark follows the list the server last sent: nothing of a study this account cannot read now stays."""
    REASON = 'SYN grid lines on the AP view'

    def open_flagged(self, **more):
        site = QcSite()
        site.second_study = True
        page = self.open_qc(TECH, flagged=self.REASON, site=site, **more)
        self.technician_tab()
        page.locator('#rows tr[data-uid="%s"]' % auth.UID).click()
        expect(page.locator('#study-qc')).to_contain_text(self.REASON)
        expect(page.locator('#study-qc')).to_contain_text(WHO_NAME)
        self.assertNotIn(WHO, self.shown_everywhere())
        return page

    def open_window(self):
        self.page.locator('#t-qc-flag').click()
        expect(self.window().locator('#qc-flag-now')).to_contain_text(self.REASON)
        expect(self.window().locator('#qc-flag-now')).to_contain_text(WHO_NAME)
        self.assertNotIn(WHO, self.shown_everywhere())
        self.window().get_by_label('Reason').fill('SYN typed and not sent')

    def assert_nothing_of_the_mark(self):
        text = self.shown_everywhere()
        for word in (self.REASON, WHO, WHO_NAME, 'SYN typed and not sent'):
            self.assertNotIn(word, text)

    def test_a_row_that_left_the_list_closes_the_open_window_and_empties_it(self):
        page = self.open_flagged()
        self.open_window()
        self.site.gone.add(auth.UID)
        self.reread()
        expect(self.window()).to_be_hidden()
        expect(page.locator('#rows tr[data-uid="%s"]' % auth.UID)).to_have_count(0)
        self.assert_nothing_of_the_mark()
        self.assertEqual('', page.locator('#qc-flag-reason').input_value())
        self.assertEqual([], self.site.patches)
        self.assertEqual([], self.errors)

    def test_what_shows_the_mark_follows_a_list_answer_before_the_list_itself_is_drawn_again(self):
        page = self.open_flagged()
        self.open_window()
        release = lambda: [route.fulfill(status=404, json={}) for route in self.site.held_gets.pop('/statistics')]
        # The list's redraw waits for the storage read, which is held here: the list answer is in, the rows are not redrawn.
        self.site.held_gets['/statistics'] = []
        self.site.unavailable.add(auth.UID)
        self.reread()
        expect(self.window()).to_be_hidden()
        expect(page.locator('#study-qc')).to_contain_text('QC Flag: Unknown')
        expect(self.qc_cell()).to_have_text('Unknown')
        self.assert_nothing_of_the_mark()
        self.assertTrue(self.site.held_gets['/statistics'], 'the storage read was not held: the case shows nothing')
        release()
        # The same for a row the list no longer has: its cell is emptied before the row itself goes.
        self.site.unavailable.clear()
        page.locator('#m-refresh').click()
        expect(self.qc_cell()).to_contain_text(self.REASON)
        self.site.held_gets['/statistics'] = []
        self.site.gone.add(auth.UID)
        self.reread()
        expect(self.qc_cell()).to_have_text('')
        expect(page.locator('#rows tr[data-uid="%s"]' % auth.UID)).to_have_count(1)
        self.assert_nothing_of_the_mark()
        self.assertTrue(self.site.held_gets['/statistics'], 'the storage read was not held: the case shows nothing')
        release()
        expect(page.locator('#rows tr[data-uid="%s"]' % auth.UID)).to_have_count(0)
        self.assertEqual([], self.errors)

    def test_a_list_answer_is_heard_before_the_read_waits_for_anything_else(self):
        page = self.open_flagged()
        self.open_window()
        # After its answer is in, a list read waits for the favorites and tag lists before it rebuilds the list: that wait
        # is held here.
        held = page.evaluate("""() => { const target = favoriteList || studyTagList; if (!target) return false;
            const original = target.refresh.bind(target);
            target.refresh = async (...args) => { await new Promise(resolve => { window.synRelease = resolve; }); return original(...args); };
            return target.refresh !== original; }""")
        self.assertTrue(held, 'neither list is mounted: the case shows nothing')
        self.site.gone.add(auth.UID)
        self.reread()
        expect(self.window()).to_be_hidden()
        expect(self.qc_cell()).to_have_text('Unknown')
        expect(page.locator('#study-qc')).to_contain_text('QC Flag: Unknown')
        self.assert_nothing_of_the_mark()
        # The list itself is not rebuilt yet (the row is still drawn), and a file exported now carries no reason.
        expect(page.locator('#rows tr[data-uid="%s"]' % auth.UID)).to_have_count(1)
        self.assertTrue(page.evaluate('() => typeof window.synRelease === "function"'), 'the wait was not reached')
        self.open_export('csv')
        self.assertNotIn(self.REASON, self.export('csv'))
        page.evaluate('() => window.synRelease()')
        expect(page.locator('#rows tr[data-uid="%s"]' % auth.UID)).to_have_count(0)
        self.assertEqual([], self.errors)

    def test_a_404_empties_and_closes_the_window_before_the_list_is_read_again(self):
        page = self.open_flagged()
        self.open_window()
        self.site.patch_answers.append((404, {'statusCode': 404, 'message': 'SYN 검사를 찾을 수 없습니다'}))
        # The list read that follows the 404 is held: the page must not wait for it.
        self.site.held_lists = []
        self.window().get_by_role('button', name='Flag', exact=True).click()
        expect(self.window()).to_be_hidden()
        expect(page.locator('#study-qc')).to_contain_text('QC Flag: Unknown')
        expect(self.qc_cell()).to_have_text('Unknown')
        self.assert_nothing_of_the_mark()
        # A second press sends nothing more (the window is closed), and the list read then removes the row.
        self.assertEqual(1, len(self.site.patches))
        for _ in range(50):
            if self.site.held_lists:
                break
            page.wait_for_timeout(100)
        self.assertTrue(self.site.held_lists, 'the list was not read again after the 404')
        held, self.site.held_lists = self.site.held_lists, None
        self.site.gone.add(auth.UID)
        for route, account in held:
            route.fulfill(json=self.site.list_body(account))
        expect(page.locator('#rows tr[data-uid="%s"]' % auth.UID)).to_have_count(0)
        self.assert_nothing_of_the_mark()
        self.assertEqual([], self.errors)

    def test_an_exam_that_cannot_be_read_now_shows_no_reason_or_author_anywhere(self):
        page = self.open_flagged()
        self.open_window()
        self.site.unavailable.add(auth.UID)
        self.reread()
        expect(self.window()).to_be_hidden()
        expect(self.qc_cell()).to_have_text('Unknown')
        expect(page.locator('#study-qc')).to_contain_text('QC Flag: Unknown')
        self.assert_nothing_of_the_mark()
        # The bar opens no window on it either.
        page.locator('#rows tr[data-uid="%s"]' % auth.UID).click()
        page.locator('#t-qc-flag').click()
        page.wait_for_timeout(300)
        expect(self.window()).to_be_hidden()
        self.assert_nothing_of_the_mark()
        # Readable again: the list's mark is shown again.
        self.site.unavailable.clear()
        self.reread()
        expect(self.qc_cell()).to_contain_text(self.REASON)
        self.assertEqual([], self.site.patches)
        self.assertEqual([], self.errors)

    def test_a_row_now_received_for_tele_reading_closes_the_window_and_a_late_answer_does_not_bring_the_author_back(self):
        site = QcSite()
        site.second_study = True
        page = self.open_qc(TECH, site=site)
        self.technician_tab()
        page.locator('#rows tr[data-uid="%s"]' % auth.UID).click()
        page.locator('#t-qc-flag').click()
        self.window().get_by_label('Reason').fill(self.REASON)
        site.patch_answers.append('hold')
        self.window().get_by_role('button', name='Flag', exact=True).click()
        for _ in range(50):
            if site.held_patches:
                break
            page.wait_for_timeout(100)
        self.assertTrue(site.held_patches)
        # The server stored the mark; before its answer arrives the list says this UID is another institution's study now,
        # received here for tele-reading: the reason is shown, who marked is not sent.
        site.qc[auth.UID] = {'reason': self.REASON, 'by': WHO, 'at': '2026-10-03T01:02:00.000Z', 'revision': 1}
        site.tele.add(auth.UID)
        self.reread()
        expect(self.window()).to_be_hidden()
        expect(page.locator('#study-qc')).to_contain_text('QC Flag: Flagged — ' + self.REASON)
        self.assertNotIn(WHO, self.shown_everywhere())
        self.assertNotIn(WHO_NAME, self.shown_everywhere())
        # The command's own answer, made for the owning institution (same revision, with the author), arrives late.
        route, uid, body, account = site.held_patches[0]
        late = dict(auth.Site.study_row(site, account)['state'], draftEpoch=EPOCH,
                    qc={'reason': self.REASON, 'by': WHO, 'byName': WHO_NAME, 'at': '2026-10-03T01:02:00.000Z', 'revision': 1})
        route.fulfill(json=late)
        page.wait_for_timeout(500)
        expect(page.locator('#study-qc')).to_contain_text('QC Flag: Flagged — ' + self.REASON)
        self.assertNotIn(WHO, self.shown_everywhere())
        self.assertNotIn(WHO_NAME, self.shown_everywhere())
        # The bar refuses to write on a received row.
        page.locator('#t-qc-flag').click()
        page.wait_for_timeout(300)
        expect(self.window()).to_be_hidden()
        self.assertEqual(1, len(site.patches))
        self.assertEqual([], self.errors)

    def test_a_poll_shows_the_newer_mark_but_does_not_move_the_revision_the_person_began_on(self):
        page = self.open_flagged(clock=True)
        self.open_window()
        # Someone else changes the reason; the poll brings it.
        self.site.qc[auth.UID] = {'reason': 'SYN changed by another', 'by': 'syn-tech3@synthetic.test', 'at': '2026-10-03T02:00:00.000Z', 'revision': 2}
        self.poll()
        expect(self.window().locator('#qc-flag-now')).to_contain_text('SYN changed by another')
        expect(self.window().get_by_label('Reason')).to_have_value('SYN typed and not sent')
        # The first press sends nothing: it says the mark changed. Only the press after that writes, on the revision shown.
        self.window().get_by_role('button', name='Flag', exact=True).click()
        expect(self.window().locator('#qc-flag-status')).to_contain_text('그 사이 QC 표시가 바뀌었습니다')
        self.assertEqual([], self.site.patches)
        self.window().get_by_role('button', name='Flag', exact=True).click()
        expect(self.window()).to_be_hidden()
        self.assertEqual([(auth.UID, {'qc': {'reason': 'SYN typed and not sent'}, 'qcRevision': 2, 'epoch': EPOCH})], self.site.patches)
        self.assertEqual([], self.errors)

    def export(self, kind):
        with self.page.expect_download() as info:
            self.page.locator('#worklist-export-dialog [data-export-run]').click()
        raw = open(info.value.path(), 'rb').read()
        self.assertTrue(info.value.suggested_filename.endswith('.' + kind), info.value.suggested_filename)
        return raw[3:].decode('utf-8')

    def open_export(self, kind):
        more = self.page.locator('#toolbar-more')
        if more.get_attribute('open') is None:
            more.locator(':scope > summary').click()
        self.page.locator('#worklist-export-open').click()
        dialog = self.page.locator('#worklist-export-dialog')
        expect(dialog).to_be_visible()
        dialog.locator('input[name="worklist-export-scope"][value="all"]').check()
        dialog.locator('select[data-export-format]').select_option(kind)

    def test_export_list_writes_the_rows_and_marks_of_the_list_as_it_is_when_exported(self):
        page = self.open_flagged()
        for kind in ('csv', 'txt'):
            with self.subTest(format=kind):
                self.site.gone.clear(), self.site.unavailable.clear()
                page.locator('#m-refresh').click()
                expect(self.qc_cell()).to_contain_text(self.REASON)
                # Opened while the mark is shown: the file would carry it.
                self.open_export(kind)
                page.locator('#worklist-export-dialog').get_by_role('button', name='Cancel', exact=True).click()
                self.open_export(kind)
                # The exam cannot be read now: its row is written without the reason.
                self.site.unavailable.add(auth.UID)
                self.reread()
                expect(self.qc_cell()).to_have_text('Unknown')
                text = self.export(kind)
                self.assertIn('SYN-P-001', text)
                self.assertIn('SYN-P-002', text)
                self.assertNotIn(self.REASON, text)
                # The row left the list after the dialog opened: it is not written at all.
                self.site.unavailable.clear()
                page.locator('#m-refresh').click()
                expect(self.qc_cell()).to_contain_text(self.REASON)
                self.open_export(kind)
                self.site.gone.add(auth.UID)
                self.reread()
                expect(page.locator('#rows tr[data-uid="%s"]' % auth.UID)).to_have_count(0)
                text = self.export(kind)
                self.assertNotIn(self.REASON, text)
                self.assertNotIn('SYN-P-001', text)
                self.assertIn('SYN-P-002', text)
                expect(page.locator('#toast')).to_contain_text('1건을 내보냈습니다')
                expect(page.locator('#toast')).to_contain_text('목록에서 사라진 1건은 뺐습니다')
        # English: both sentences of the notice, around the count and the file name.
        self.site.gone.clear(), self.site.unavailable.clear()
        page.locator('#m-refresh').click()
        expect(self.qc_cell()).to_contain_text(self.REASON)
        page.evaluate("() => KinLanguage.restore({version: 1, worklist: 'en', reading: 'en'})")
        self.open_export('csv')
        self.site.gone.add(auth.UID)
        self.reread()
        expect(page.locator('#rows tr[data-uid="%s"]' % auth.UID)).to_have_count(0)
        self.export('csv')
        expect(page.locator('#toast')).to_contain_text('Exported 1 studies (')
        expect(page.locator('#toast')).to_contain_text('1 that left the list meanwhile were left out.')
        expect(page.locator('#toast')).not_to_contain_text(re.compile('[가-힣]'))
        self.assertEqual([], self.errors)


# ── Protocol & Dose ──

def tag(vr, *values):
    return {'vr': vr, 'Value': list(values)}


def instance(study, series, sop, sop_class='1.2.840.10008.5.1.4.1.1.2', protocol=None, ctdi=None, extra=None, number='own'):
    """One object's metadata. Its Instance Number is the last part of its SOP Instance UID unless `number` says otherwise
    (None: the object has none)."""
    ds = {'0020000D': tag('UI', study), '0020000E': tag('UI', series), '00080018': tag('UI', sop), '00080016': tag('UI', sop_class)}
    if number == 'own':
        number = int(sop.rsplit('.', 1)[1])
    if number is not None:
        ds['00200013'] = tag('IS', number)
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


def series_row(study, series, number, modality, description, count=None):
    row = {'0020000D': tag('UI', study), '0020000E': tag('UI', series), '00200011': tag('IS', number),
           '00080060': tag('CS', modality), '0008103E': tag('LO', description)}
    if count is not None:
        row['00201209'] = tag('IS', count)
    return row


def archive(site, study, *series):
    """The archive's answers for one study: its series list - each series with the number of objects it holds, as QIDO-RS
    says it (0020,1209) - and each series' metadata. A series is (uid, number, modality, description, objects[, listed]);
    `listed` is the count the list says when it is not the number of objects returned (None: the list says none)."""
    rows = []
    for uid, number, modality, description, objects, *listed in series:
        rows.append(series_row(study, uid, number, modality, description, listed[0] if listed else len(objects)))
        site.gets['/dicom-web/studies/%s/series/%s/metadata' % (study, uid)] = (200, objects)
    site.gets['/dicom-web/studies/%s/series' % study] = (200, rows)
    site.listed[study] = {row[0]: (row[5] if len(row) > 5 and row[5] is not None else len(row[4])) for row in series}


RDSR = '1.2.840.10008.5.1.4.1.1.88.67'
ENHANCED = '1.2.840.10008.5.1.4.1.1.2.1'


def dose_report(study, series, sop, *content):
    return instance(study, series, sop, sop_class=RDSR, extra={'0040A730': tag('SQ', *content)})


def frame(value):
    return {'00189321': tag('SQ', {'00189345': tag('FD', value)})} if value is not None else {}


def merged(a, b):
    return {'reportUid': a, 'groupId': '00000000-0000-4000-8000-0000000000f2', 'kind': 'merge', 'part': None, 'active': True,
            'generation': 'SYN-G2', 'sources': [{'studyUid': a, 'series': {'mode': 'all', 'uids': []}},
                                                {'studyUid': b, 'series': {'mode': 'all', 'uids': []}}]}


def split(a, mode, uids, part=0):
    return {'reportUid': a, 'groupId': '00000000-0000-4000-8000-0000000000f1', 'kind': 'split', 'part': part, 'active': True,
            'generation': 'SYN-G1', 'sources': [{'studyUid': a, 'series': {'mode': mode, 'uids': uids}}]}


class AcquisitionBase(QcBase):
    def site(self):
        site = QcSite()
        site.second_study = True
        site.modality[auth.UID_B] = 'CR'
        a, b = auth.UID, auth.UID_B
        s2, s3, s9, s8 = a + '.2', a + '.3', a + '.900', a + '.899'
        archive(site, a,
                (s2, '2', 'CT', 'SYN CHEST', [instance(a, s2, s2 + '.1', protocol='SYN CHEST ROUTINE', ctdi=8.12),
                                              instance(a, s2, s2 + '.2', protocol='SYN CHEST ROUTINE', ctdi=8.12),
                                              instance(a, s2, s2 + '.3', protocol='SYN CHEST ROUTINE', ctdi=9.4)]),
                # The first object lacks the protocol; a later one has it - the whole series is read.
                (s3, '3', 'CT', 'SYN CHEST THIN', [instance(a, s3, s3 + '.1', ctdi=7.5), instance(a, s3, s3 + '.2', protocol='SYN THIN', ctdi=7.5)]),
                # An ordinary SR first, then the dose report in another series.
                (s8, '899', 'SR', 'SYN KEY NOTES', [instance(a, s8, s8 + '.1', sop_class='1.2.840.10008.5.1.4.1.1.88.22')]),
                (s9, '900', 'SR', 'SYN DOSE REPORT', [dose_report(a, s9, s9 + '.1',
                    container('113811', num('113813', '312.4', 'mGy.cm'), num('113812', '2', '{events}')),
                    container('113819', num('113830', '8.1', 'mGy'), num('113838', '160.2', 'mGy.cm')))]))
        cr = b + '.1'
        archive(site, b, (cr, '1', 'CR', 'SYN CHEST PA', [instance(b, cr, cr + '.1', sop_class='1.2.840.10008.5.1.4.1.1.1')]))
        return site

    def start(self, site, uid=auth.UID, clock=False):
        self.open(TECH, site)
        if clock:
            self.page.clock.install()
        self.go()
        self.technician_tab()
        if uid:
            self.page.locator('#rows tr[data-uid="%s"]' % uid).click()
        return self.page

    def box(self):
        return self.page.locator('#study-acquisition')

    def lines(self):
        return [line.strip() for line in self.box().locator('.acq-line').all_inner_texts()]

    def line(self, start):
        expect(self.box().locator('.acq-line', has_text=start).first).to_be_visible()
        return next(line for line in self.lines() if line.startswith(start))

    def reads_of(self, study, since=0):
        return [p for p in self.site.dicom_calls[since:] if p.startswith('/dicom-web/studies/%s/series' % study)]


class AcquisitionDOM(AcquisitionBase):
    def test_ct_shows_protocol_and_dose_with_tags_and_units_and_cr_says_not_in_dicom(self):
        site = self.site()
        self.open(TECH, site)
        self.go()
        # Radiology tab: no block, no DICOM read.
        self.page.locator('#rows tr[data-uid]').first.click()
        expect(self.box()).to_be_hidden()
        self.page.wait_for_timeout(300)
        self.assertEqual([], [p for p in site.dicom_calls if '/series' in p])
        self.technician_tab()
        self.page.locator('#rows tr[data-uid="%s"]' % auth.UID).click()
        expect(self.box()).to_contain_text('DLP (Dose SR Se 900)')
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
        values = self.box().locator('span[translate="no"]').all_inner_texts()
        self.assertIn('SYN CHEST ROUTINE', values)
        # Every value keeps where it was read: the original study, the series and each object's SOP Instance UID.
        s2 = auth.UID + '.2'
        title = self.box().locator('.acq-line[data-kind="ctdi"]').first.get_attribute('title')
        self.assertEqual(['Study ' + auth.UID, 'Series ' + s2, '8.12 mGy: SOP %s.1 (image 1); SOP %s.2 (image 2)' % (s2, s2),
                          '9.4 mGy: SOP %s.3 (image 3)' % s2], title.split('\n'))
        # The CR study: read whole, nothing recorded.
        self.page.locator('#rows tr[data-uid="%s"]' % auth.UID_B).click()
        expect(self.box()).to_contain_text('Se 1 · CR · SYN CHEST PA')
        expect(self.box()).to_contain_text('DLP (Dose SR): Not in DICOM')
        lines = self.lines()
        self.assertIn('Protocol (0018,1030): Not in DICOM', lines)
        self.assertIn('CTDIvol (0018,9345): Not in DICOM', lines)
        # Back to the CT (A -> B -> A): its answer is kept, not read again.
        calls = len(site.dicom_calls)
        self.page.locator('#rows tr[data-uid="%s"]' % auth.UID).click()
        expect(self.box()).to_contain_text('312.4 mGy.cm')
        self.page.wait_for_timeout(300)
        self.assertEqual([], [p for p in site.dicom_calls[calls:] if p.endswith('/metadata') or p.endswith('/series')], site.dicom_calls[calls:])
        self.assertEqual([], self.errors)

    def test_a_failed_series_is_could_not_read_and_dlp_is_not_called_absent(self):
        site = self.site()
        site.gets['/dicom-web/studies/%s/series/%s/metadata' % (auth.UID, auth.UID + '.900')] = (500, {'code': 'SYN'})
        # A dose event without a total: shown as that event's values.
        b = auth.UID_B
        archive(site, b, (b + '.9', '9', 'SR', 'SYN DOSE', [dose_report(b, b + '.9', b + '.9.1',
                container('113819', num('113830', '5.5', 'mGy'), num('113838', '99', None)))]))
        self.start(site)
        expect(self.box()).to_contain_text('Se 900 · SR · SYN DOSE REPORT — Could not read')
        self.assertIn('DLP (Dose SR): Not found in the series read', self.lines())
        self.page.locator('#rows tr[data-uid="%s"]' % auth.UID_B).click()
        expect(self.box()).to_contain_text('Event 1:')
        self.assertIn('DLP (Dose SR Se 9) %s: Event 1: CTDIvol 5.5 mGy · DLP Could not read' % (b + '.9.1'), self.lines())
        self.assertEqual([], self.errors)

    def test_enhanced_ct_frames_and_a_split_part_keep_their_own_sources(self):
        site = self.site()
        a = auth.UID
        se = a + '.5'
        s3, s9 = a + '.3', a + '.900'
        # One enhanced multi-frame object: per-frame CTDIvol 10, 10, 12 and one frame that has none (the shared group has none).
        archive(site, a,
                (se, '5', 'CT', 'SYN ENHANCED', [instance(a, se, se + '.1', sop_class=ENHANCED, protocol='SYN ENH',
                    extra={'52009230': tag('SQ', frame(10), frame(10), frame(12), frame(None)), '52009229': tag('SQ', {}),
                           '00280008': tag('IS', 4)})]),
                (s3, '3', 'CT', 'SYN CHEST THIN', [instance(a, s3, s3 + '.1', ctdi=7.5)]),
                (s9, '900', 'SR', 'SYN DOSE REPORT', [dose_report(a, s9, s9 + '.1', container('113811', num('113813', '312.4', 'mGy.cm')))]))
        # The first part of a split exam: every series but the thin one.
        site.scopes[a] = split(a, 'exclude', [s3])
        self.start(site)
        expect(self.box()).to_contain_text('SYN ENHANCED')
        lines = self.lines()
        self.assertIn('CTDIvol (0018,9345): 10 mGy (image 1: frames 1–2), 12 mGy (image 1: frame 3) · Not in DICOM (image 1: frame 4)', lines)
        self.assertFalse(any('SYN CHEST THIN' in line for line in lines), lines)
        self.assertNotIn('/dicom-web/studies/%s/series/%s/metadata' % (a, s3), site.dicom_calls)
        # The dose report of the original study is said to be the whole study's, not this part's.
        self.assertIn('DLP (Dose SR Se 900) %s — not computed for this part: 312.4 mGy.cm (total recorded in this Dose SR, 113813)' % (s9 + '.1'), lines)
        self.assertEqual([], self.errors)

    def test_a_unit_or_code_scheme_it_cannot_vouch_for_is_could_not_read(self):
        site = self.site()
        a, s9 = auth.UID, auth.UID + '.900'
        archive(site, a, (s9, '900', 'SR', 'SYN DOSE REPORT', [
            dose_report(a, s9, s9 + '.1', container('113811', num('113813', '312.4', 's'))),
            dose_report(a, s9, s9 + '.2', container('113811', num('113813', '99.9', 'mGy.cm', 'LOCAL')))]))
        self.start(site)
        expect(self.box()).to_contain_text(s9 + '.2')
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
        newer = [dose_report(a, s9, s9 + '.1', container('113811', num('113813', '412.4', 'mGy.cm')))]
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
        expect(self.box()).to_contain_text('412.4 mGy.cm')
        held[0].fulfill(json=old)
        self.page.wait_for_timeout(500)
        expect(self.box()).to_contain_text('412.4 mGy.cm')
        self.assertNotIn('312.4', self.box().inner_text())
        self.assertEqual([], self.errors)

    def test_a_merged_exam_keeps_each_original_apart_and_a_failed_original_is_said(self):
        site = self.site()
        a, b = auth.UID, auth.UID_B
        site.gets['/dicom-web/studies/%s/series' % b] = (500, {'code': 'SYN'})
        # One object of the CT's thin series has no SOP Instance UID: that series is not read, never "absent".
        broken = instance(a, a + '.3', a + '.3.1', ctdi=7.5)
        del broken['00080018']
        site.gets['/dicom-web/studies/%s/series/%s/metadata' % (a, a + '.3')] = (200, [broken])
        site.scopes[a] = merged(a, b)
        self.start(site)
        expect(self.box()).to_contain_text('Series list could not be read')
        lines = self.lines()
        self.assertIn('%s · Series list could not be read' % b, lines)
        self.assertIn('%s · Se 2 · CT · SYN CHEST' % a, lines)
        self.assertIn('CTDIvol (0018,9345): 8.12 mGy (images 1–2), 9.4 mGy (image 3)', lines)
        self.assertIn('%s · Se 3 · CT · SYN CHEST THIN — Could not read' % a, lines)
        self.assertIn('DLP (Dose SR Se 900) %s · %s: 312.4 mGy.cm (total recorded in this Dose SR, 113813)' % (a, a + '.900.1'), lines)
        self.assertFalse(any(line.endswith('Not in DICOM') and line.startswith('DLP') for line in lines), lines)
        self.assertEqual([], self.errors)


class AcquisitionSourceDOM(AcquisitionBase):
    """A value is shown with where it was read, and "Not in DICOM" only of what was read whole."""

    def test_objects_with_one_image_number_are_told_apart_by_sop_and_a_series_number_twice_by_series_uid(self):
        site = self.site()
        a = auth.UID
        s2, s4 = a + '.2', a + '.4'
        archive(site, a,
                # Two objects, both Instance Number 7, with different values; a third object has no Instance Number.
                (s2, '2', 'CT', 'SYN CHEST', [instance(a, s2, s2 + '.1', protocol='SYN P', ctdi=4, number=7),
                                              instance(a, s2, s2 + '.2', protocol='SYN P', ctdi=8, number=7),
                                              instance(a, s2, s2 + '.3', protocol='SYN P', ctdi=9, number=None)]),
                # Another series with the same Series Number.
                (s4, '2', 'CT', 'SYN CHEST', [instance(a, s4, s4 + '.1', protocol='SYN P', ctdi=5)]))
        self.start(site)
        expect(self.box()).to_contain_text('9 mGy')
        lines = self.lines()
        self.assertIn('CTDIvol (0018,9345): 4 mGy (SOP %s.1), 8 mGy (SOP %s.2), 9 mGy (SOP %s.3)' % (s2, s2, s2), lines)
        self.assertNotIn('image 7', ' '.join(lines))
        self.assertIn('Se 2 · CT · SYN CHEST · ' + s2, lines)
        self.assertIn('Se 2 · CT · SYN CHEST · ' + s4, lines)
        self.assertEqual([], self.errors)

    def test_a_frame_that_cannot_be_read_stays_at_its_number_and_a_malformed_number_is_not_converted(self):
        site = self.site()
        a = auth.UID
        se, s3 = a + '.5', a + '.3'
        archive(site, a,
                # The first frame item is damaged: frames 2 and 3 keep their numbers.
                (se, '5', 'CT', 'SYN ENHANCED', [instance(a, se, se + '.1', sop_class=ENHANCED, protocol='SYN ENH',
                    extra={'52009230': tag('SQ', None, frame(11), frame(12)), '00280008': tag('IS', 3)})]),
                # CTDIvol stored as text that is not a decimal number.
                (s3, '3', 'CT', 'SYN CHEST THIN', [instance(a, s3, s3 + '.1', protocol='SYN THIN', extra={'00189345': tag('DS', '0x10')}),
                                                   instance(a, s3, s3 + '.2', protocol='SYN THIN', ctdi=7.5)]))
        self.start(site)
        expect(self.box()).to_contain_text('SYN ENHANCED')
        lines = self.lines()
        self.assertIn('CTDIvol (0018,9345): 11 mGy (image 1: frame 2), 12 mGy (image 1: frame 3) · Could not read (image 1: frame 1)', lines)
        self.assertIn('CTDIvol (0018,9345): 7.5 mGy (image 2) · Could not read (image 1)', lines)
        self.assertNotIn('16 mGy', ' '.join(lines))
        self.assertEqual([], self.errors)

    def test_fewer_objects_or_frames_than_the_archive_and_the_object_say_is_not_absence(self):
        site = self.site()
        a = auth.UID
        s2, se = a + '.2', a + '.5'
        archive(site, a,
                # The series list says two objects; one is returned, and it records neither value.
                (s2, '2', 'CT', 'SYN CHEST', [instance(a, s2, s2 + '.1')], 2),
                # The object counts three frames and describes two.
                (se, '5', 'CT', 'SYN ENHANCED', [instance(a, se, se + '.1', sop_class=ENHANCED, protocol='SYN ENH',
                    extra={'52009230': tag('SQ', frame(None), frame(None)), '00280008': tag('IS', 3)})]))
        self.start(site)
        expect(self.box()).to_contain_text('SYN ENHANCED')
        lines = self.lines()
        self.assertIn('Objects read: 1 of 2', lines)
        self.assertIn('Protocol (0018,1030): Not in DICOM (image 1)', lines)
        self.assertIn('CTDIvol (0018,9345): Not in DICOM (image 1)', lines)
        self.assertIn('CTDIvol (0018,9345): Not in DICOM (image 1: frames 1–2) · Could not read (image 1: frame 3)', lines)
        self.assertIn('DLP (Dose SR): Not found in the series read', lines)
        self.assertFalse(any(line.endswith(': Not in DICOM') for line in lines), lines)
        # A series whose object count the archive does not say is not called whole either.
        archive(site, a, (s2, '2', 'CT', 'SYN CHEST', [instance(a, s2, s2 + '.1')], None))
        self.page.locator('#m-refresh').click()
        expect(self.box()).to_contain_text('the archive did not say how many')
        lines = self.lines()
        self.assertIn('Objects read: 1 (the archive did not say how many there are)', lines)
        self.assertIn('DLP (Dose SR): Not found in the series read', lines)
        self.assertFalse(any(line.endswith(': Not in DICOM') for line in lines), lines)
        self.assertEqual([], self.errors)

    def test_frames_are_those_the_object_counts_and_a_value_kept_elsewhere_is_not_absent(self):
        site = self.site()
        a = auth.UID
        s5, s6, s7 = a + '.5', a + '.6', a + '.7'
        archive(site, a,
                # Three frames counted, none described: nothing is known of any of them.
                (s5, '5', 'CT', 'SYN ENH NONE', [instance(a, s5, s5 + '.1', sop_class=ENHANCED, protocol='SYN ENH',
                                                          extra={'00280008': tag('IS', 3)})]),
                # Two frames counted, three described: the third item is of no frame.
                (s6, '6', 'CT', 'SYN ENH MORE', [instance(a, s6, s6 + '.1', sop_class=ENHANCED, protocol='SYN ENH',
                    extra={'52009230': tag('SQ', frame(4), frame(5), frame(6)), '00280008': tag('IS', 2)})]),
                # A value that is not a list of values, and one kept outside this answer.
                (s7, '7', 'CT', 'SYN CT ODD', [
                    instance(a, s7, s7 + '.1', protocol='SYN P', extra={'00189345': {'vr': 'FD', 'Value': '12.4'}}),
                    instance(a, s7, s7 + '.2', protocol='SYN P', extra={'00189345': {'vr': 'FD', 'BulkDataURI': 'https://syn.test/bulk/1'}}),
                    instance(a, s7, s7 + '.3', extra={'00181030': {'vr': 'LO', 'BulkDataURI': 'https://syn.test/bulk/2'}}, ctdi=7.5)]))
        self.start(site)
        expect(self.box()).to_contain_text('SYN CT ODD')
        lines = self.lines()
        self.assertIn('CTDIvol (0018,9345): Could not read (image 1: frames 1–3)', lines)
        self.assertIn('CTDIvol (0018,9345): 4 mGy (image 1: frame 1), 5 mGy (image 1: frame 2)', lines)
        self.assertNotIn('6 mGy', ' '.join(lines))
        self.assertNotIn('frame 3)', ' '.join(line for line in lines if '4 mGy' in line))
        self.assertIn('CTDIvol (0018,9345): 7.5 mGy (image 3) · Could not read (images 1–2)', lines)
        self.assertIn('Protocol (0018,1030): SYN P (images 1–2) · Could not read (image 3)', lines)
        self.assertNotIn('1 mGy', ' '.join(lines).replace('1 mGy.cm', ''))
        self.assertFalse(any(line.endswith(': Not in DICOM') and not line.startswith('DLP') for line in lines), lines)
        # Objects not described as they count themselves are not a whole reading: the exam is not said to have no dose report.
        self.assertIn('DLP (Dose SR): Not found in the series read', lines)
        self.assertEqual([], self.errors)

    def test_fewer_series_than_the_list_row_counts_is_not_a_whole_reading(self):
        site = self.site()
        a = auth.UID
        s2 = a + '.2'
        archive(site, a, (s2, '2', 'CT', 'SYN CHEST', [instance(a, s2, s2 + '.1', protocol='SYN P', ctdi=4)]))
        # The list row counts two series of the exam; the archive lists one.
        site.series_said[a] = 2
        self.start(site)
        expect(self.box()).to_contain_text('SYN CHEST')
        lines = self.lines()
        self.assertIn('Series found: 1 of the 2 the list counts', lines)
        self.assertIn('DLP (Dose SR): Not found in the series read', lines)
        self.assertNotIn('DLP (Dose SR): Not in DICOM', lines)
        # A row that does not say how many series it has is not vouched for either.
        site.series_said[a] = None
        self.page.locator('#m-refresh').click()
        expect(self.box()).to_contain_text('the list does not say how many')
        self.assertIn('DLP (Dose SR): Not found in the series read', self.lines())
        # As many series as the row counts, but the row counts more images than the archive holds: not whole either.
        site.series_said[a] = 1
        site.images_said[a] = 3
        self.page.locator('#m-refresh').click()
        expect(self.box()).to_contain_text('Objects read: 1 of the 3 the list counts')
        self.assertIn('DLP (Dose SR): Not found in the series read', self.lines())
        # As many as the row counts: read whole.
        site.images_said[a] = 1
        self.page.locator('#m-refresh').click()
        expect(self.box()).to_contain_text('DLP (Dose SR): Not in DICOM')
        self.assertFalse(any(line.startswith(('Series found', 'Objects read')) for line in self.lines()), self.lines())
        self.assertEqual([], self.errors)

    def test_a_dose_report_not_searched_to_its_end_is_not_called_absent(self):
        site = self.site()
        a, s9 = auth.UID, auth.UID + '.900'
        deep = container('113811', num('113813', '312.4', 'mGy.cm'))
        for _ in range(40):
            deep = container('121070', deep)
        archive(site, a, (s9, '900', 'SR', 'SYN DOSE REPORT', [
            dose_report(a, s9, s9 + '.1', deep),
            # A content item that cannot be read may be the one looked for.
            dose_report(a, s9, s9 + '.2', None, container('121070')),
            # Searched to its end, and nothing of dose in it.
            dose_report(a, s9, s9 + '.3', container('121070')),
            # A dose report in the enhanced form, which this reader does not read: said as not read, never as no report.
            instance(a, s9, s9 + '.4', sop_class='1.2.840.10008.5.1.4.1.1.88.76',
                     extra={'0040A730': tag('SQ', container('113811', num('113813', '55.5', 'mGy.cm')))})]))
        self.start(site)
        expect(self.box()).to_contain_text(s9 + '.3')
        lines = self.lines()
        self.assertIn('DLP (Dose SR Se 900) %s.1: Could not read' % s9, lines)
        self.assertIn('DLP (Dose SR Se 900) %s.2: Could not read' % s9, lines)
        self.assertIn('DLP (Dose SR Se 900) %s.3: Not in DICOM' % s9, lines)
        self.assertIn('DLP (Dose SR Se 900) %s.4: Could not read' % s9, lines)
        self.assertNotIn('55.5', ' '.join(lines))
        # An exam whose only dose report is of that form is not said to have none.
        archive(site, a, (s9, '900', 'SR', 'SYN DOSE REPORT', [instance(a, s9, s9 + '.4', sop_class='1.2.840.10008.5.1.4.1.1.88.76')]))
        self.page.locator('#m-refresh').click()
        expect(self.box().locator('.acq-line[data-kind="dlp"]')).to_have_count(1)
        self.assertIn('DLP (Dose SR Se 900) %s.4: Could not read' % s9, self.lines())
        self.assertNotIn('DLP (Dose SR): Not in DICOM', self.lines())
        self.assertEqual([], self.errors)

    def test_a_split_part_whose_named_series_is_not_listed_is_not_read_whole(self):
        site = self.site()
        a = auth.UID
        s2, s7 = a + '.2', a + '.7'
        archive(site, a, (s2, '2', 'CT', 'SYN CHEST', [instance(a, s2, s2 + '.1', protocol='SYN P', ctdi=4)]))
        # The second part names two series; the archive lists one of them.
        site.scopes[a] = split(a, 'include', [s2, s7], part=1)
        self.start(site)
        expect(self.box()).to_contain_text('SYN CHEST')
        lines = self.lines()
        self.assertIn('1 series of this exam not in the series list (not read): ' + s7, lines)
        self.assertIn('DLP (Dose SR): Not found in the series read', lines)
        self.assertNotIn('DLP (Dose SR): Not in DICOM', lines)
        # Both listed: read whole, and only then is the dose report called absent.
        archive(site, a, (s2, '2', 'CT', 'SYN CHEST', [instance(a, s2, s2 + '.1', protocol='SYN P', ctdi=4)]),
                (s7, '7', 'CT', 'SYN LATE', [instance(a, s7, s7 + '.1', protocol='SYN P', ctdi=4)]))
        self.page.locator('#m-refresh').click()
        expect(self.box()).to_contain_text('SYN LATE')
        self.assertIn('DLP (Dose SR): Not in DICOM', self.lines())
        self.assertEqual([], self.errors)


class AcquisitionAccessDOM(AcquisitionBase):
    """What was read follows what can be read now: a refused original, an exam out of reach, another exam's late answer."""

    def test_an_original_that_refuses_a_later_series_takes_its_earlier_values_with_it(self):
        site = self.site()
        a, b = auth.UID, auth.UID_B
        b1, b2 = b + '.1', b + '.2'
        archive(site, b,
                (b1, '1', 'CT', 'SYN B FIRST', [instance(b, b1, b1 + '.1', protocol='SYN B PROTOCOL', ctdi=3.3)]),
                (b2, '2', 'CT', 'SYN B SECOND', [instance(b, b2, b2 + '.1', protocol='SYN B PROTOCOL', ctdi=3.4)]))
        site.gets['/dicom-web/studies/%s/series/%s/metadata' % (b, b2)] = (403, {'code': 'SYN'})
        site.scopes[a] = merged(a, b)
        self.start(site)
        expect(self.box()).to_contain_text('access refused')
        lines = self.lines()
        self.assertIn('%s · This original cannot be read now (access refused)' % b, lines)
        self.assertNotIn('SYN B', ' '.join(lines))
        self.assertNotIn('3.3 mGy', ' '.join(lines))
        # The other original's values stay, each with its original; nothing is called absent from the exam.
        self.assertIn('%s · Se 2 · CT · SYN CHEST' % a, lines)
        self.assertIn('DLP (Dose SR Se 900) %s · %s: 312.4 mGy.cm (total recorded in this Dose SR, 113813)' % (a, a + '.900.1'), lines)
        self.assertEqual([], self.errors)

    def test_an_exam_out_of_reach_and_back_is_read_again_and_reads_the_same_in_both_languages(self):
        site = self.site()
        a, b, s9 = auth.UID, auth.UID_B, auth.UID + '.900'
        site.scopes[a] = merged(a, b)
        self.start(site, clock=True)
        expect(self.box()).to_contain_text('312.4 mGy.cm')
        # A poll says one of its originals cannot be read now: nothing read before stays on the screen.
        site.unavailable.add(a)
        self.poll()
        expect(self.box()).to_contain_text("the exam's originals cannot all be read")
        self.assertNotIn('312.4', self.box().inner_text())
        # Meanwhile the dose report was replaced. The next poll says the same exam can be read again: it is read again.
        site.gets['/dicom-web/studies/%s/series/%s/metadata' % (a, s9)] = (200, [
            dose_report(a, s9, s9 + '.1', container('113811', num('113813', '412.4', 'mGy.cm')))])
        calls = len(site.dicom_calls)
        site.unavailable.clear()
        self.poll()
        expect(self.box()).to_contain_text('412.4 mGy.cm')
        self.assertNotIn('312.4', self.box().inner_text())
        self.assertTrue(self.reads_of(a, calls), 'the exam was not read again')
        # The values are data: the same in English and Korean (a protocol named like a state word stays as recorded).
        values = lambda: self.box().locator('span[translate="no"]').all_inner_texts()
        shown = values()
        self.assertIn('412.4 mGy.cm', shown)
        for lang in ('ko', 'en'):
            self.assertTrue(self.page.evaluate("l => KinLanguage.restore({version: 1, worklist: l, reading: l})", lang))
            self.assertEqual(shown, values(), lang)
        self.page.evaluate("() => KinLanguage.restore({version: 1, worklist: null, reading: null})")
        self.assertEqual([], self.errors)

    def test_a_study_answered_404_loses_its_protocol_and_dose_before_the_list_is_read_again(self):
        site = self.site()
        self.start(site)
        expect(self.box()).to_contain_text('312.4 mGy.cm')
        self.page.locator('#t-qc-flag').click()
        self.window().get_by_label('Reason').fill('SYN not sent')
        site.patch_answers.append((404, {'statusCode': 404, 'message': 'SYN 검사를 찾을 수 없습니다'}))
        site.held_lists = []
        self.window().get_by_role('button', name='Flag', exact=True).click()
        expect(self.window()).to_be_hidden()
        expect(self.box()).to_contain_text('Protocol & Dose: Could not read')
        self.assertNotIn('312.4', self.box().inner_text())
        self.assertNotIn('SYN CHEST ROUTINE', self.box().inner_text())
        for _ in range(50):
            if site.held_lists:
                break
            self.page.wait_for_timeout(100)
        self.assertTrue(site.held_lists, 'the list was not read again after the 404')
        # The list says the study is still this account's: it is read again, not taken from memory.
        calls = len(site.dicom_calls)
        held, site.held_lists = site.held_lists, None
        for route, account in held:
            route.fulfill(json=site.list_body(account))
        expect(self.box()).to_contain_text('312.4 mGy.cm')
        self.assertTrue(self.reads_of(auth.UID, calls), 'the exam was not read again')
        self.assertEqual([], self.errors)

    def test_a_refusal_that_arrives_for_a_read_left_behind_still_takes_the_original_out_of_reach(self):
        site = self.site()
        a, b = auth.UID, auth.UID_B
        s3 = a + '.3'
        # One original split in two exams: the first part is every series but the thin one, the second part the thin one.
        site.scopes[a] = split(a, 'exclude', [s3])
        site.scopes[b] = dict(split(a, 'include', [s3], part=1), reportUid=b)
        path = '/dicom-web/studies/%s/series/%s/metadata' % (a, s3)
        held = []
        self.open(TECH, site)
        self.context.route('**' + path, lambda route: held.append(route))
        self.go()
        self.technician_tab()
        # The first part is read whole and kept.
        self.page.locator('#rows tr[data-uid="%s"]' % a).click()
        expect(self.box()).to_contain_text('312.4 mGy.cm')
        # The second part is being read (its series held) when the person goes back to the first part.
        self.page.locator('#rows tr[data-uid="%s"]' % b).click()
        for _ in range(50):
            if held:
                break
            self.page.wait_for_timeout(100)
        self.assertTrue(held, 'the read of the second part was not sent')
        self.page.locator('#rows tr[data-uid="%s"]' % a).click()
        expect(self.box()).to_contain_text('312.4 mGy.cm')
        # The original now refuses: the read left behind learns it. What the first part shows came from that original.
        site.gets['/dicom-web/studies/%s/series' % a] = (403, {'code': 'SYN'})
        calls = len(site.dicom_calls)
        held[0].fulfill(status=403, json={'code': 'SYN'})
        expect(self.box()).to_contain_text('access refused')
        self.assertNotIn('312.4', self.box().inner_text())
        self.assertTrue(self.reads_of(a, calls), 'the first part was not read again')
        # Leaving the tab and coming back shows nothing kept from before the refusal.
        self.page.locator('[data-tab="Radiology"]').click()
        self.technician_tab()
        expect(self.box()).to_contain_text('access refused')
        self.assertNotIn('312.4', self.box().inner_text())
        self.assertEqual([], self.errors)

    def test_a_late_answer_of_an_exam_no_longer_viewed_is_not_kept(self):
        site = self.site()
        a, b, s9 = auth.UID, auth.UID_B, auth.UID + '.900'
        path = '/dicom-web/studies/%s/series/%s/metadata' % (a, s9)
        held = []
        old = site.gets[path][1]
        newer = [dose_report(a, s9, s9 + '.1', container('113811', num('113813', '412.4', 'mGy.cm')))]
        self.open(TECH, site)
        self.context.route('**' + path, lambda route: held.append(route) if not held else route.fulfill(json=newer))
        self.go()
        self.technician_tab()
        # B is read whole and kept.
        self.page.locator('#rows tr[data-uid="%s"]' % b).click()
        expect(self.box()).to_contain_text('Se 1 · CR · SYN CHEST PA')
        expect(self.box()).to_contain_text('DLP (Dose SR): Not in DICOM')
        # A is being read (its dose report held) when the person goes back to B.
        self.page.locator('#rows tr[data-uid="%s"]' % a).click()
        for _ in range(50):
            if held:
                break
            self.page.wait_for_timeout(100)
        self.assertTrue(held, 'the read of the dose report was not sent')
        self.page.locator('#rows tr[data-uid="%s"]' % b).click()
        expect(self.box()).to_contain_text('Se 1 · CR · SYN CHEST PA')
        # A's answer arrives now: it is not drawn on B ...
        held[0].fulfill(json=old)
        self.page.wait_for_timeout(500)
        self.assertNotIn('312.4', self.box().inner_text())
        # ... and not kept: viewing A again reads it again and shows what the archive says now.
        calls = len(site.dicom_calls)
        self.page.locator('#rows tr[data-uid="%s"]' % a).click()
        expect(self.box()).to_contain_text('412.4 mGy.cm')
        self.assertNotIn('312.4', self.box().inner_text())
        self.assertTrue(self.reads_of(a, calls), 'the exam was not read again')
        self.assertEqual([], self.errors)

    def test_a_related_study_that_left_the_list_gives_the_whole_panel_back_to_the_reading_target(self):
        site = self.site()
        a, b = auth.UID, auth.UID_B
        site.one_patient = True
        site.qc[a] = {'reason': 'SYN mark of the target', 'by': WHO, 'at': '2026-10-03T01:00:00.000Z', 'revision': 1}
        self.start(site, clock=True)
        expect(self.box()).to_contain_text('312.4 mGy.cm')
        # View the Related study B: the panel names B and shows B's mark and B's DICOM.
        self.page.evaluate('uid => previewRelated(uid)', b)
        expect(self.page.locator('#clinical')).to_contain_text(b)
        expect(self.box()).to_contain_text('Se 1 · CR · SYN CHEST PA')
        expect(self.page.locator('#study-qc')).to_contain_text('QC Flag: None')
        # B leaves the list in a poll: the study named, the QC line and Protocol & Dose are all the reading target's.
        site.gone.add(b)
        self.poll()
        expect(self.page.locator('#rows tr[data-uid="%s"]' % b)).to_have_count(0)
        expect(self.page.locator('#study-qc')).to_contain_text('SYN mark of the target')
        expect(self.box()).to_contain_text('312.4 mGy.cm')
        expect(self.page.locator('#clinical tr', has_text='Study UID').locator('td').nth(1)).to_have_text(a)
        self.assertNotIn(b, self.page.locator('#clinical').inner_text())
        # B comes back to the list in a later poll and is the viewed study again: the panel is B's as a whole.
        site.gone.clear()
        self.poll()
        expect(self.page.locator('#rows tr[data-uid="%s"]' % b)).to_have_count(1)
        expect(self.page.locator('#clinical tr', has_text='Study UID').locator('td').nth(1)).to_have_text(b)
        expect(self.page.locator('#study-qc')).to_contain_text('QC Flag: None')
        expect(self.box()).to_contain_text('Se 1 · CR · SYN CHEST PA')
        self.assertNotIn('SYN mark of the target', self.page.locator('#study-qc').inner_text())
        self.assertNotIn('312.4', self.box().inner_text())
        self.assertEqual([], self.errors)


if __name__ == '__main__':
    unittest.main()
