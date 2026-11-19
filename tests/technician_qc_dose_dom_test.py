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


if __name__ == '__main__':
    unittest.main()
