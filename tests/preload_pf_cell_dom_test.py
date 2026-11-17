# coding: utf-8
"""FC-071 (A1 unit 15, walk C-R01-033 #12-#13): the worklist PF cell shows the Preload queue on the shipped page.

The shipped worklist (main.html and its scripts, preload-queue.js included) boots against the in-test server of
multi_institution_worklist_dom_test.py. Playwright cannot answer a SharedWorker's own requests, so the preload worker is
the one thing replaced: an init script puts a SharedWorker double in its place that records what the page posts and lets
the case send the worker's 'state' messages (the shape preload-worker.js broadcast() sends; the worker's real progress
counts are checked in preload_worker_test.cjs). The reader selects a row, presses the existing Preload button and turns
the PF column on; the PF cell then follows the queue: Queued, 'Downloading NN%' from done/total, Ready, and back to '·'
when the queue no longer holds the study, while another row keeps '·'. Cells are found by their visible header.
FC-073: More > Auto Preload sends one saved search's studies (emergency first, priors when asked, auto: true) after
the first list read, after a reload (kept per account in this browser), after the 30-second auto refresh brings an
arrival, and never when Off or when the chosen search is gone; the existing Preload panel stays reachable with nothing
selected. Synthetic data only.
"""
import json
import re
import unittest
from datetime import datetime, timezone

from playwright.sync_api import expect
import multi_institution_worklist_dom_test as mi
from multi_institution_worklist_dom_test import Server, row, until

STUDY, OTHER = '2.25.601', '2.25.602'
WORKER_DOUBLE = """(() => {
  const posted = [], ports = [];
  Object.defineProperty(window, '__synPreload', { value: {
    posted, state(studies, session, unavailable = null) { for (const port of ports) port.onmessage?.({ data: { type: 'state', session, unavailable,
      budget: 1024 ** 3, used: 0, studies } }); } } });
  window.SharedWorker = function () {
    const port = { onmessage: null, start() {}, postMessage(message) { posted.push(JSON.parse(JSON.stringify(message))); } };
    ports.push(port); this.port = port;
  };
})();"""


def entry(status, done=0, total=0, reason=None):
    return {'uid': STUDY, 'label': 'SYN-PF-01', 'status': status, 'reason': reason, 'waiting': False, 'done': done,
            'total': total, 'bytes': 0, 'open': False, 'expiresAt': None}


class PreloadPfCellDOM(unittest.TestCase):
    # The harness's browser and boot, without inheriting its own cases.
    setUpClass = mi.MultiInstitutionWorklist.__dict__['setUpClass']
    tearDownClass = mi.MultiInstitutionWorklist.__dict__['tearDownClass']
    boot = mi.MultiInstitutionWorklist.boot

    def pf(self, screen, pid):
        return screen.data_row(pid).get_by_role('cell').nth(screen.heads().index('PF'))

    def test_pf_cell_follows_the_preload_queue(self):
        server = Server(rows=[row(STUDY, 'SYN-PF-01'), row(OTHER, 'SYN-PF-02')])
        original = mi.STORAGE_RECORDER
        mi.STORAGE_RECORDER = original + '\n' + WORKER_DOUBLE
        try:
            screen = self.boot(server)
        finally:
            mi.STORAGE_RECORDER = original
        page = screen.page
        screen.show_column('PF')
        expect(self.pf(screen, 'SYN-PF-01')).to_have_text('·')

        screen.data_row('SYN-PF-01').get_by_role('cell', name='SYN-PF-01', exact=True).click(modifiers=['Control'])
        page.get_by_role('button', name='Preload', exact=True).click()
        added = until(lambda: [m for m in page.evaluate('() => window.__synPreload.posted') if m['type'] == 'add'], 5, 'add')
        self.assertEqual([STUDY], [s['uid'] for s in added[0]['studies']])

        session = added[0]['session']
        self.assertTrue(session)
        send = lambda *studies, to=session: page.evaluate('([studies, to]) => window.__synPreload.state(studies, to)', [list(studies), to])
        send(entry('Queued'))
        expect(self.pf(screen, 'SYN-PF-01')).to_have_text('Queued')
        send(entry('Downloading'))
        expect(self.pf(screen, 'SYN-PF-01')).to_have_text('Downloading 0%')
        send(entry('Downloading', 1, 3))
        expect(self.pf(screen, 'SYN-PF-01')).to_have_text('Downloading 33%')
        expect(self.pf(screen, 'SYN-PF-02')).to_have_text('·')
        send(entry('Downloading', 3, 3))
        expect(self.pf(screen, 'SYN-PF-01')).to_have_text('Downloading 100%')
        send(entry('Ready', 3, 3))
        expect(self.pf(screen, 'SYN-PF-01')).to_have_text('Ready')
        expect(self.pf(screen, 'SYN-PF-02')).to_have_text('·')
        # The panel the Preload button already had says the same.
        expect(page.get_by_text('Preload: 1 Ready', exact=True)).to_be_attached()

        # A redraw of the list (a filter) keeps the queue state; a failure shows its reason on the cell.
        screen.page.get_by_role('textbox', name='ID Filter', exact=True).fill('SYN-PF-01')
        screen.wait_rows(['SYN-PF-01'])
        expect(self.pf(screen, 'SYN-PF-01')).to_have_text('Ready')
        send(entry('Failed', reason='서버에 연결하지 못했습니다. 다시 시도하세요.'))
        expect(self.pf(screen, 'SYN-PF-01')).to_have_text('Failed')
        expect(self.pf(screen, 'SYN-PF-01').get_by_title('서버에 연결하지 못했습니다. 다시 시도하세요.')).to_have_count(1)
        # The worker's queue of another session (another login in this browser) is not this reader's: '·'.
        send(entry('Ready', 3, 3), to='SYN-OTHER-SESSION')
        expect(self.pf(screen, 'SYN-PF-01')).to_have_text('·')
        send(entry('Ready', 3, 3))
        expect(self.pf(screen, 'SYN-PF-01')).to_have_text('Ready')
        # A study the queue no longer holds (Clear All of another session, logout) shows '·' again.
        send()
        expect(self.pf(screen, 'SYN-PF-01')).to_have_text('·')
        screen.finish()


# FC-073 (A1 unit 15): More > Auto Preload sends one saved search's studies to the worker after every list read.
AU_CT, AU_EM, AU_PRIOR, AU_MR = '2.25.701', '2.25.702', '2.25.703', '2.25.704'
ON_CALL = {'id': 7, 'name': 'SYN On Call', 'mode': 'Radiology', 'quick': '', 'days': -1,
           'cols': {'date': '2026-10-05..2026-10-05', 'modality': 'CT'}}
OTHER_SEARCH = {'id': 8, 'name': 'SYN MR', 'mode': 'Radiology', 'quick': '', 'days': -1, 'cols': {'modality': 'MR'}}


class AutoPreloadDOM(unittest.TestCase):
    setUpClass = mi.MultiInstitutionWorklist.__dict__['setUpClass']
    tearDownClass = mi.MultiInstitutionWorklist.__dict__['tearDownClass']
    boot = mi.MultiInstitutionWorklist.boot

    def boot_auto(self, server, **kw):
        original = mi.STORAGE_RECORDER
        mi.STORAGE_RECORDER = original + '\n' + WORKER_DOUBLE
        try:
            return self.boot(server, **kw)
        finally:
            mi.STORAGE_RECORDER = original

    def server(self):
        return Server(rows=[row(AU_CT, 'SYN-AU-01'), row(AU_EM, 'SYN-AU-02', em='E'),
                            row(AU_PRIOR, 'SYN-AU-02', date='20260901'), row(AU_MR, 'SYN-AU-03', modality='MR')],
                      filters=[ON_CALL, OTHER_SEARCH])

    def adds(self, page):
        return [m for m in page.evaluate('() => window.__synPreload.posted') if m['type'] == 'add']

    def auto_menu(self, screen):
        more = screen.menu('More')
        details = more.locator('details').filter(has=screen.page.get_by_role('group', name='Auto Preload', exact=True, include_hidden=True))
        if details.get_attribute('open') is None:
            more.locator('summary[aria-label="Auto Preload"]').click()
        return details

    def test_auto_preload_search_emergency_first_priors_kept_and_off(self):
        server = self.server()
        screen = self.boot_auto(server)
        page = screen.page
        self.assertEqual([], self.adds(page), 'Off by default: nothing is queued')
        menu = self.auto_menu(screen)
        choice = menu.get_by_role('combobox', name='Auto Preload')
        self.assertEqual(['Off', 'SYN On Call', 'SYN MR'], choice.locator('option').all_inner_texts())
        choice.select_option(label='SYN On Call')
        added = until(lambda: self.adds(page), 5, 'auto add')
        self.assertTrue(added[-1]['auto'])
        self.assertEqual([[AU_EM, True], [AU_CT, False]], [[s['uid'], s['urgent']] for s in added[-1]['studies']])
        expect(menu.get_by_role('status')).to_contain_text('대상 2건 (응급 1건 먼저)')
        menu.get_by_role('checkbox', name='Include Priors').check()
        until(lambda: len(self.adds(page)) > len(added), 5, 'auto add with priors')
        self.assertEqual([[AU_EM, True], [AU_PRIOR, True], [AU_CT, False]],
                         [[s['uid'], s['urgent']] for s in self.adds(page)[-1]['studies']])
        # The screen's own filter is not touched.
        self.assertEqual(['SYN-AU-01', 'SYN-AU-02', 'SYN-AU-02', 'SYN-AU-03'], sorted(screen.column('ID')))

        # Kept for this account in this browser: a reload sends the same after its first list read.
        page.reload()
        until(lambda: any(m.get('auto') for m in self.adds(page)), 15, 'auto add after reload')
        self.assertEqual([AU_EM, AU_PRIOR, AU_CT], [s['uid'] for s in self.adds(page)[-1]['studies']])
        menu = self.auto_menu(screen)
        expect(menu.get_by_role('combobox', name='Auto Preload')).to_have_value('own:7')
        expect(menu.get_by_role('checkbox', name='Include Priors')).to_be_checked()

        # The queue it fills is reachable with nothing selected (Retry, Clear All of the existing panel).
        session = self.adds(page)[-1]['session']
        page.evaluate('([s, to]) => window.__synPreload.state(s, to)',
                      [[{**entry('Queued'), 'uid': AU_EM}], session])
        expect(page.get_by_text('Preload: 1 Queued', exact=True)).to_be_visible()
        expect(page.get_by_role('status').filter(has_text='Selected: 0')).to_be_visible()
        # Another login's queue (the worker reports to every page) is not shown: no rows, no Retry, the bar hides again.
        page.evaluate('([s, to]) => window.__synPreload.state(s, to)',
                      [[{**entry('Failed', reason='SYN other'), 'uid': AU_EM, 'label': 'SYN OTHER PATIENT'}], 'SYN-OTHER-SESSION'])
        expect(page.get_by_text('SYN OTHER PATIENT')).to_have_count(0)
        expect(page.get_by_role('button', name='Retry', exact=True)).to_have_count(0)
        expect(page.get_by_role('status').filter(has_text='Selected: 0')).to_be_hidden()
        # A setup failure the worker reports after the add (empty queue) shows on the Auto Preload line, and goes on recovery.
        unset = '이 기관에서 미리 받기에 쓸 저장 용량을 아직 정하지 않아 미리 받기를 할 수 없습니다. 관리자에게 문의하세요.'
        page.evaluate('([s, to, why]) => window.__synPreload.state(s, to, why)', [[], session, unset])
        expect(menu.get_by_role('status')).to_contain_text(unset)
        expect(menu.get_by_role('status')).to_contain_text('대상 3건')
        page.evaluate('([s, to]) => window.__synPreload.state(s, to)', [[], session])
        expect(menu.get_by_role('status')).not_to_contain_text(unset)

        # Off: a refresh sends nothing more.
        menu.get_by_role('combobox', name='Auto Preload').select_option(label='Off')
        count = len(self.adds(page))
        screen.menu('More', open_=False)
        screen.refresh()
        until(lambda: sum(1 for e in server.ledger if e['path'] == '/api/studies' and e['status']) >= 3, 10, 'refresh read')
        page.wait_for_timeout(300)
        self.assertEqual(count, len(self.adds(page)))
        screen.finish()

    def test_auto_preload_queues_an_arrival_from_auto_refresh_and_skips_a_missing_search(self):
        server = self.server()
        storage = {'kin-preload-auto:v1:' + self.owner_key(): json.dumps({'version': 1, 'search': 'own:7', 'priors': False})}
        screen = self.boot_auto(server, storage=storage, clock_at=datetime.now(timezone.utc))
        page = screen.page
        until(lambda: self.adds(page), 10, 'auto add after the first read')
        # A new emergency CT arrives; the 30-second auto refresh (no Refresh pressed) queues it first.
        server.rows.append(row('2.25.705', 'SYN-AU-05', em='E'))
        count = len(self.adds(page))
        page.clock.run_for(31000)
        until(lambda: len(self.adds(page)) > count, 10, 'auto add after the poll')
        self.assertEqual([[AU_EM, True], ['2.25.705', True], [AU_CT, False]],
                         [[s['uid'], s['urgent']] for s in self.adds(page)[-1]['studies']])

        # The chosen search is gone (deleted elsewhere): nothing is sent and the menu says so.
        server.filters = [OTHER_SEARCH]
        page.reload()
        until(lambda: sum(1 for e in server.ledger if e['path'] == '/api/studies' and e['status']) >= 3, 15, 'list after reload')
        page.wait_for_timeout(300)
        self.assertEqual([], self.adds(page))
        menu = self.auto_menu(screen)
        expect(menu.get_by_role('status')).to_contain_text('고른 저장 검색을 찾을 수 없어')
        screen.finish()

    end_session_elsewhere = mi.MultiInstitutionWorklist.end_session_elsewhere
    SESSION_PROBE = mi.MultiInstitutionWorklist.SESSION_PROBE

    def test_auto_preload_menu_keeps_no_saved_search_after_the_session_ends(self):
        # The document can outlive its session (Recover Draft keeps it). The More menu then keeps no saved search
        # name of the ended account, no choice and no status line, and a late worker report writes nothing.
        server = self.server()
        storage = {'kin-preload-auto:v1:' + self.owner_key(): json.dumps({'version': 1, 'search': 'own:7', 'priors': True})}
        screen = self.boot_auto(server, storage=storage)
        page = screen.page
        session = until(lambda: self.adds(page), 10, 'auto add after the first read')[-1]['session']
        group = page.get_by_role('group', name='Auto Preload', exact=True, include_hidden=True)
        self.assertEqual(['Off', 'SYN On Call', 'SYN MR'], page.locator('#preload-auto option').all_text_contents())
        self.assertIn('Auto Preload: SYN On Call', group.text_content())
        self.end_session_elsewhere(screen, 'channel')
        until(lambda: page.locator('#preload-auto option').all_text_contents() == ['Off'], 10, 'saved searches left the menu')
        page.evaluate('([s, to, why]) => window.__synPreload.state(s, to, why)', [[], session, 'SYN late report'])
        page.wait_for_timeout(200)
        self.assertEqual({'value': '', 'off': True, 'priors': False, 'priorsOff': True, 'status': ''}, page.evaluate("""() => {
          const select = document.querySelector('#preload-auto'), priors = document.querySelector('#preload-auto-priors');
          return { value: select.value, off: select.disabled, priors: priors.checked, priorsOff: priors.disabled,
            status: document.querySelector('#preload-auto-status').textContent }; }"""))
        text = page.locator('body').text_content()
        for name in ('SYN On Call', 'SYN MR', 'SYN late report'):
            self.assertNotIn(name, text)
        screen.finish()

    def owner_key(self):
        return json.dumps([mi.SESSION_A['institution'], mi.SESSION_A['sub']], separators=(',', ':'))


# The PF column's meaning on its header, and PF as a filter (filter row, My Shortcuts > Filter Exams, saved searches).
PF_READY = {'id': 9, 'name': 'SYN PF Ready', 'mode': 'Radiology', 'quick': '', 'days': -1, 'cols': {'pf': 'Ready'}}
PF_WORDS = ['Queued', 'Downloading', 'Ready', 'Failed', 'Evicted', 'None']


class PfFilterDOM(unittest.TestCase):
    setUpClass = mi.MultiInstitutionWorklist.__dict__['setUpClass']
    tearDownClass = mi.MultiInstitutionWorklist.__dict__['tearDownClass']
    boot = mi.MultiInstitutionWorklist.boot
    boot_pf = AutoPreloadDOM.boot_auto

    def server(self, filters=()):
        return Server(rows=[row(STUDY, 'SYN-PF-01'), row(OTHER, 'SYN-PF-02'), row('2.25.603', 'SYN-PF-03')],
                      filters=list(filters))

    def send(self, page, *studies, to=None):
        # The worker's 'state' report for this page's session (or another login's, `to`).
        session = to or page.evaluate('() => window.KinWorkContext.session()')
        self.assertTrue(session)
        page.evaluate('([studies, to]) => window.__synPreload.state(studies, to)', [list(studies), session])

    def at(self, status, uid, done=0, total=0):
        return {**entry(status, done, total), 'uid': uid}

    def test_pf_header_explains_the_column_and_each_word(self):
        screen = self.boot_pf(self.server())
        screen.show_column('PF')
        help_ = screen.header('PF').get_attribute('title')
        self.assertTrue(help_.startswith('PF (Prefetch, 미리 받기)'), help_)
        self.assertIn('Preload 패널', help_)
        for word in ['Queued', 'Downloading', 'Ready', 'Failed', 'Evicted', '· (None)']:
            self.assertIn('\n' + word + ':', help_)
        self.assertIn('72시간', help_)
        # The other code headers keep their help; a plain column has none.
        self.assertTrue(screen.header('RS').get_attribute('title').startswith('RS (Report Status'))
        self.assertIsNone(screen.header('Name').get_attribute('title'))
        screen.finish()

    def test_pf_filter_row_follows_the_queue(self):
        screen = self.boot_pf(self.server())
        page = screen.page
        screen.show_column('PF')
        box = screen.filter_box('PF')
        self.assertEqual(['', *PF_WORDS], box.locator('option').evaluate_all('os => os.map(o => o.value)'))
        self.send(page, self.at('Ready', STUDY, 3, 3), self.at('Downloading', OTHER, 1, 3))
        expect(self.pf(screen, 'SYN-PF-02')).to_have_text('Downloading 33%')
        box.select_option('Ready')
        screen.wait_rows(['SYN-PF-01'])
        box.select_option('Downloading')
        screen.wait_rows(['SYN-PF-02'])
        # A percent step keeps the row; the study turning Ready leaves Downloading without any click.
        self.send(page, self.at('Ready', STUDY, 3, 3), self.at('Downloading', OTHER, 2, 3))
        expect(self.pf(screen, 'SYN-PF-02')).to_have_text('Downloading 66%')
        screen.wait_rows(['SYN-PF-02'])
        self.send(page, self.at('Ready', STUDY, 3, 3), self.at('Ready', OTHER, 3, 3))
        expect(page.get_by_role('cell', name='No records found', exact=True)).to_be_visible()
        box.select_option('Ready')
        screen.wait_rows(['SYN-PF-01', 'SYN-PF-02'])
        # None = no queue state for this login: the study never queued, and every study under another login's report.
        box.select_option('None')
        screen.wait_rows(['SYN-PF-03'])
        self.send(page, self.at('Ready', STUDY, 3, 3), to='SYN-OTHER-SESSION')
        screen.wait_rows(['SYN-PF-01', 'SYN-PF-02', 'SYN-PF-03'])
        self.assertIn('PF(None)', screen.filter_line())
        screen.finish()

    def test_filter_exams_popup_filters_by_pf_with_the_column_hidden(self):
        screen = self.boot_pf(self.server())
        page = screen.page
        self.assertNotIn('PF', screen.heads())   # PF opens hidden
        self.send(page, self.at('Failed', STUDY), self.at('Queued', OTHER))
        page.get_by_role('button', name='My Shortcuts', exact=True).click()
        popup = page.get_by_role('dialog', name='Filter Exams', exact=True)
        expect(popup).to_be_visible()
        label = popup.locator('label').filter(has_text=re.compile(r'^PF\s'))
        self.assertTrue(label.get_attribute('title').startswith('PF (Prefetch, 미리 받기)'))
        choice = label.get_by_role('combobox')
        self.assertEqual(['Any', *PF_WORDS], choice.locator('option').all_inner_texts())
        # Asked together with the assigned reader and the tech note: they sit beside them.
        names = popup.locator('label').evaluate_all('ls => ls.map(l => l.firstChild.textContent.trim())')
        self.assertEqual(names.index('Tech Note') + 1, names.index('PF'))
        choice.select_option('Failed')
        popup.get_by_role('button', name='Apply', exact=True).click()
        expect(popup).to_be_hidden()
        screen.wait_rows(['SYN-PF-01'])
        self.assertIn('PF(Failed) [숨긴 열]', screen.filter_line())
        # Retry made it Queued: it leaves the Failed list by itself.
        self.send(page, self.at('Queued', STUDY), self.at('Queued', OTHER))
        expect(page.get_by_role('cell', name='No records found', exact=True)).to_be_visible()
        # The popup reopens with the condition; Clear takes PF off with the rest.
        page.get_by_role('button', name='My Shortcuts', exact=True).click()
        expect(choice).to_have_value('Failed')
        popup.get_by_role('button', name='Clear', exact=True).click()
        screen.wait_rows(['SYN-PF-01', 'SYN-PF-02', 'SYN-PF-03'])
        self.assertNotIn('PF(', screen.filter_line())
        popup.get_by_role('button', name='Close', exact=True).click()
        screen.finish()

    def test_saved_search_on_pf_counts_and_applies_the_live_state(self):
        screen = self.boot_pf(self.server([PF_READY]))
        page = screen.page
        chip = page.locator('#chips button.chip').filter(has_text='SYN PF Ready')
        expect(chip).to_have_attribute('aria-label', re.compile(r'로드된 목록 기준 0건'))
        # The list itself has no PF condition: a study turning Ready changes only the saved search's count.
        self.send(page, self.at('Ready', STUDY, 3, 3))
        expect(chip).to_have_attribute('aria-label', re.compile(r'로드된 목록 기준 1건'))
        self.assertEqual(['SYN-PF-01', 'SYN-PF-02', 'SYN-PF-03'], screen.column('ID'))
        screen.menu('Filters').get_by_role('button', name=re.compile(r'^SYN PF Ready, ')).click()
        screen.wait_rows(['SYN-PF-01'])
        self.send(page, self.at('Ready', STUDY, 3, 3), self.at('Ready', OTHER, 3, 3))
        screen.wait_rows(['SYN-PF-01', 'SYN-PF-02'])
        expect(chip).to_have_attribute('aria-label', re.compile(r'로드된 목록 기준 2건'))
        screen.finish()

    def test_saved_search_editor_counts_a_pf_draft_and_saves_it(self):
        server = self.server()
        screen = self.boot_pf(server)
        page = screen.page
        screen.menu('Filters')
        page.locator('#managefilters').click()
        editor = page.locator('#saved-filter-manager')
        expect(editor).to_be_visible()
        page.locator('#sfm-name').fill('SYN PF Ready draft')
        choice = page.locator('#sfm-col-pf')
        self.assertEqual(['', *PF_WORDS], choice.locator('option').evaluate_all('os => os.map(o => o.value)'))
        choice.select_option('Ready')
        count = page.locator('#sfm-count')
        expect(count).to_contain_text('로드된 목록 기준 0건')
        # Nothing else uses PF: the unsaved draft alone follows the queue, without touching the editor.
        self.send(page, self.at('Ready', STUDY, 3, 3))
        expect(count).to_contain_text('로드된 목록 기준 1건')
        self.send(page, self.at('Ready', STUDY, 3, 3), self.at('Ready', OTHER, 3, 3))
        expect(count).to_contain_text('로드된 목록 기준 2건')
        page.locator('#sfm-save-apply').click()
        expect(editor).to_be_hidden()
        screen.wait_rows(['SYN-PF-01', 'SYN-PF-02'])
        saved = server.filter_posts[-1]
        self.assertEqual('SYN PF Ready draft', saved['name'])
        self.assertEqual('Ready', saved['cols']['pf'])
        screen.finish()
        # Opened again (a new page with the stored search): it filters by the state this page's queue reports.
        again = self.boot_pf(server)
        chip = again.page.locator('#chips button.chip').filter(has_text='SYN PF Ready draft')
        expect(chip).to_have_attribute('aria-label', re.compile(r'로드된 목록 기준 0건'))
        self.send(again.page, self.at('Ready', OTHER, 3, 3))
        expect(chip).to_have_attribute('aria-label', re.compile(r'로드된 목록 기준 1건'))
        again.menu('Filters').get_by_role('button', name=re.compile(r'^SYN PF Ready draft, ')).click()
        again.wait_rows(['SYN-PF-02'])
        again.finish()

    pf = PreloadPfCellDOM.pf


if __name__ == '__main__':
    unittest.main()
