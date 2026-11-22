"""A1 FA-153: the default colour scheme on the worklist and the report editor.

Requirement: the dark palette - background #212121, panels and inputs #2D2D2D, main text #E3E3E3, secondary text #B4B4B4,
selection/accent #8AB4C8 - is used consistently on the worklist, the viewer and the report editor; sky blue is for
selected states and accents, not running text. A reader's saved text colour stays theirs.

RISK: a part of the work page (a panel gutter, the report fields, a native control, a dialog opened from the page) is
painted in a colour of its own, so the worklist and the editor do not look like the viewer; or the palette overwrites a
meaning colour (status, warning, error) or the reader's saved text colour.

The real main.html and its assets are served; only HTTP answers are synthetic (study_panel_page_dom_test.WorkspaceSite).
Each case drives public controls and reads computed colours: background, text (own text or a control), each drawn
border side, a drawn outline, box-shadow colours and the accent of checkboxes. A colour is the palette's when its RGB is
one of the five at any alpha; near-black shadows and scrims are neutral. Elements whose colour carries a meaning (MEANING) are
left out of the sweep and their colours are asserted to stay.
"""
import json
import sys
import unittest
from pathlib import Path

from playwright.sync_api import expect, sync_playwright

sys.path.insert(0, str(Path(__file__).resolve().parent))
from study_panel_page_dom_test import RASTER, WorkspaceSite, auth, settle, wait_startup  # noqa: E402

OWNER = json.dumps([auth.INSTITUTION, auth.RAD['sub']], separators=(',', ':'))
rgb = lambda value: 'rgb(%d, %d, %d)' % tuple(int(value[i:i + 2], 16) for i in (1, 3, 5))

# Kept meaning colours (the work page palette's rule): status dots and RS, the draft / citation / notice bars, Held
# Studies, DB status, the row's status edge, image wells, the Related compare mode's frame and source card, engineering-only
# and filter notices, request notes, errors. MEANING covers the element and its contents; MEANING_FRAME the element only.
MEANING = ', '.join([
    '.dot', '.rs', '#rows td.num', '.draftbar', '#m-held', '#dbstat', '.thumbwrap', '#reading-viewer', '#related-mode-source', '#order-source-status',
    '#related-filter-hidden', '.image-request-closed', '.image-request-line', '.question-text', '.sfm-error',
    '.image-request-status[data-state="Requested"]', '.image-request-status[data-state="Accepted"]'])
MEANING_FRAME = '#related-mode'

SWEEP = r'''([roots, visibleOnly, meaning, frame]) => {
  const palette = ['33,33,33', '45,45,45', '227,227,227', '180,180,180', '138,180,200'];
  const parse = s => [...s.matchAll(/rgba?\(([^)]+)\)/g)].map(m => { const p = m[1].split(/[ ,/]+/).filter(Boolean).map(Number);
    return {c: p.slice(0, 3).join(','), a: p.length > 3 ? p[3] : 1}; });
  const dark = c => c.split(',').every(n => Number(n) <= 24);
  const off = (s, neutralBlack) => parse(s).filter(v => v.a !== 0 && !palette.includes(v.c) && !(neutralBlack && dark(v.c)));
  const shown = e => { const r = e.getBoundingClientRect(), cs = getComputedStyle(e);
    return r.width >= 1 && r.height >= 1 && cs.visibility !== 'hidden' && r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth; };
  const name = e => e.tagName.toLowerCase() + (e.id ? '#' + e.id : '') + [...e.classList].map(c => '.' + c).join('');
  const where = e => { const a = []; for (let n = e; n && n !== document.body && a.length < 3; n = n.parentElement) a.unshift(name(n)); return a.join(' > '); };
  const out = [];
  for (const root of roots.flatMap(q => [...document.querySelectorAll(q)])) for (const e of [root, ...root.querySelectorAll('*')]) {
    if (e.closest('svg, canvas, img, video, iframe, option') || e.closest(meaning) || e.matches(frame) || (visibleOnly && !shown(e))) continue;
    const cs = getComputedStyle(e), check = (prop, value, neutralBlack) => { if (off(value, neutralBlack).length) out.push(where(e) + ' ' + prop + ' ' + value); };
    const box = e.matches('input[type=checkbox], input[type=radio], input[type=range]');
    check('background', cs.backgroundColor, e.matches('.modal'));
    if (!box && (e.matches('input, select, textarea, button') || [...e.childNodes].some(n => n.nodeType === 3 && n.nodeValue.trim())))
      check('color', cs.color);
    for (const side of ['Top', 'Right', 'Bottom', 'Left'])
      if (parseFloat(cs['border' + side + 'Width']) > 0 && cs['border' + side + 'Style'] !== 'none') check('border' + side, cs['border' + side + 'Color']);
    if (cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) > 0) check('outline', cs.outlineColor);
    if (cs.boxShadow !== 'none') check('boxShadow', cs.boxShadow, true);
    if (box && cs.accentColor !== 'auto') check('accent', cs.accentColor);
    if (box && cs.accentColor === 'auto') out.push(where(e) + ' accent auto (browser blue)');
  }
  return out; }'''

# Dialogs opened from this page that had colours of their own, with their opener (a public control).
DIALOGS = [('#reading-appearance-dialog', '#reading-appearance-open', '#reading-appearance-close'),
           ('#favorite-dialog', '#favorite-open', '#favorite-close'), ('#study-tag-dialog', '#study-tag-open', '#study-tag-close'),
           ('#worklist-alerts-dialog', '#worklist-alerts-open', '#alerts-done'),
           ('#tech-note-dialog', '#tech-note-open', '#tech-note-close'), ('#consultations-dialog', '#consultations-open', '#co-close'),
           ('#sr-dialog', '#sr-open', '#sr-close'), ('#viewer-windows-dialog', '#viewer-windows-open', '#viewer-windows-done'),
           ('#image-opening-dialog', '#image-opening-open', '#image-opening-done'),
           # Edit Shortcuts is in the Reading Workspace bar: the loop enters the Reading Workspace for it (last).
           ('#workspace-shortcuts-dialog', '#workspace-shortcuts-edit', '#workspace-shortcuts-cancel')]
# Not opened by this module; their computed colours are swept with the dialog closed.
CLOSED_ONLY = ['#reader-assignment-dialog', '#report-preview']
# Report column panes whose toggles had a focus colour of their own.
# The band's notices first: the questions' row stands when its notice is clicked (main.html "An answer never resizes").
TOGGLES = ['#question-notice', '#image-request-notice', '#question-toggle', '#image-request-toggle', '#cvr-sent-toggle', '#cvr-inbox-toggle']
SFM_ERROR = 'rgb(255, 183, 169)'   # saved-filter-manager.css .sfm-error: a meaning colour that stays


SAVED_SEARCH = {'name': 'SYN Saved Search', 'mode': 'rad', 'days': 0, 'cols': {}}


class PaletteSite(WorkspaceSite):
    """The Reading Workspace frames the viewer; its document is out of this sweep (iframes are skipped), so it is empty."""

    def handle(self, route, request):
        if request.method == 'GET' and request.url.startswith(auth.ORIGIN + '/ohif/viewer'):
            return route.fulfill(body='<!DOCTYPE html><title>SYN viewer</title>', content_type='text/html; charset=utf-8')
        return super().handle(route, request)

    def api(self, route, request, method, path, query):
        # One saved search, so the Saved Search Manager has a list item to select.
        if method == 'GET' and path == '/api/filter-folders':
            account, refused = self.authenticate(request)
            if refused:
                return self.refuse(route, *refused)
            return route.fulfill(json={'owner': [auth.INSTITUTION, account['sub']], 'revision': 1, 'filters': [SAVED_SEARCH],
                                       'folders': [], 'shortcuts': []})
        return super().api(route, request, method, path, query)


class WorkPaletteDOM(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.pw = sync_playwright().start()
        cls.browser = cls.pw.chromium.launch(args=RASTER)

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.pw.stop()

    def open(self, init=None):
        site = PaletteSite()
        context = self.browser.new_context(viewport={'width': 1920, 'height': 1080})
        context.route('**/*', lambda route, request: site.handle(route, request))
        if init:
            context.add_init_script(init)
        page = context.new_page()
        errors = []
        page.on('pageerror', lambda e: errors.append(str(e)))
        self.addCleanup(context.close)
        self.addCleanup(lambda: self.assertEqual([], errors))
        self.addCleanup(lambda: self.assertEqual([], site.violations))
        page.goto(auth.MAIN_URL)
        expect(page.locator('#rows')).to_contain_text(auth.PATIENT)
        wait_startup(page, site)
        auth.show_all_panels(page)
        settle(page)
        return page

    def sweep(self, page, roots=('body',), visible_only=True):
        return page.evaluate(SWEEP, [list(roots), visible_only, MEANING, MEANING_FRAME])

    def keyboard_focus(self, page, control):
        # Focus by the keyboard (Tab away and Shift+Tab back), so :focus-visible draws as it does for a reader.
        control.focus()
        page.keyboard.press('Tab')
        page.keyboard.press('Shift+Tab')
        self.assertTrue(control.evaluate("e => e === document.activeElement && e.matches(':focus-visible')"), 'keyboard focus')
        self.assertNotEqual('none', control.evaluate('e => getComputedStyle(e).outlineStyle'), 'focus is drawn')

    @staticmethod
    def reveal(page, selector):
        # Open each closed toolbar group holding the control, outermost first, by its summary (as a reader does).
        groups = page.locator(selector).first.evaluate('''e => { const out = [];
          for (let d = e.parentElement.closest('details'); d; d = d.parentElement.closest('details')) out.unshift(d);
          return out.map(d => d.id); }''')
        for group in groups:
            menu = page.locator('#' + group)
            if menu.get_attribute('open') is None:
                menu.locator(':scope > summary').click()

    def test_worklist_report_editor_and_reading_workspace_use_the_palette(self):
        page = self.open()
        self.assertEqual([], self.sweep(page), 'first paint')
        page.locator('#rows tr[data-uid]').first.click()
        expect(page.locator('#findings')).to_be_editable()
        settle(page)
        self.assertEqual([], self.sweep(page), 'a study selected, report editor shown')
        # The writing field is a panel like every input (#2D2D2D), marked apart by its solid edge; focus is the accent.
        field = page.evaluate('''() => { const s = getComputedStyle(document.querySelector('#findings'));
          return [s.backgroundColor, s.borderTopColor, s.borderTopStyle, getComputedStyle(document.querySelector('.report-p')).backgroundColor]; }''')
        self.assertEqual([rgb('#2d2d2d'), rgb('#b4b4b4'), 'solid', rgb('#2d2d2d')], field)
        page.locator('#findings').focus()
        self.assertEqual(rgb('#8ab4c8'), page.locator('#findings').evaluate('e => getComputedStyle(e).borderTopColor'))
        row = page.locator('#rows tr[data-uid]').first
        self.keyboard_focus(page, row)
        self.assertEqual([], self.sweep(page, ['#rows']), 'keyboard focus in the list')
        for toggle in TOGGLES:
            with self.subTest(toggle=toggle):
                if toggle == '#question-toggle' and page.locator('#question-p').is_hidden():
                    page.locator('#question-notice').click()
                self.keyboard_focus(page, page.locator(toggle))
                self.assertEqual([], self.sweep(page, [toggle]), 'keyboard focus on a report column toggle')
        page.locator('#m-reading').click()
        page.wait_for_function("document.body.classList.contains('reading')")
        settle(page)
        self.assertEqual([], self.sweep(page), 'Reading Workspace')
        # Meaning colours stay (the RS word is its meaning colour lightened to read on a selected row).
        kept = page.evaluate('''() => [getComputedStyle(document.querySelector('.dot-w')).backgroundColor,
          getComputedStyle(document.querySelector('#rows .rs.W')).color, getComputedStyle(document.querySelector('#citemsg')).color]''')
        self.assertEqual([rgb('#4f8ef7'), rgb('#90b8fa'), rgb('#d8b24a')], kept)

    def test_status_words_read_on_a_selected_row_and_inputs_are_panels(self):
        """Text contrast: each status word (RS) reads at 4.5:1 or more on the panel, a hovered and a selected row.
        The colour table: panels and inputs #2D2D2D - the report fields, a dialog's fields and a modal's reason field."""
        page = self.open()
        words = page.evaluate('''() => { const row = document.querySelector('#rows tr[data-uid]'), rs = row.querySelector('.rs');
          const out = {}; for (const st of ['w', 'a', 'h', 'o', 'p', 't']) {
            row.className = 'st-' + st + ' sel'; out[st] = [getComputedStyle(rs).color, getComputedStyle(row.querySelector('td')).backgroundColor]; }
          row.className = ''; return out; }''')
        lin = lambda c: c / 12.92 if c <= 0.03928 else ((c + 0.055) / 1.055) ** 2.4
        lum = lambda s: (lambda r, g, b: 0.2126 * lin(r / 255) + 0.7152 * lin(g / 255) + 0.0722 * lin(b / 255))(
            *[int(x) for x in s[s.index('(') + 1:s.index(')')].split(',')[:3]])
        panel = (45, 45, 45)  # a row fill is an alpha over the panel: composite it the way the browser does
        for st, (word, fill) in words.items():
            parts = [float(x) for x in fill[fill.index('(') + 1:fill.index(')')].split(',')]
            alpha = parts[3] if len(parts) > 3 else 1
            shown = 'rgb(%d, %d, %d)' % tuple(round(parts[i] * alpha + panel[i] * (1 - alpha)) for i in range(3))
            for bg in (shown, 'rgb(45, 45, 45)'):
                a, b = sorted((lum(word), lum(bg)), reverse=True)
                with self.subTest(status=st, background=bg):
                    self.assertGreaterEqual((a + 0.05) / (b + 0.05), 4.5, (word, bg))
        page.locator('#rows tr[data-uid]').first.click()
        expect(page.locator('#findings')).to_be_editable()
        fields = page.evaluate("() => ['#findings', '#conclusion', '#recommendation'].map(s => getComputedStyle(document.querySelector(s)).backgroundColor)")
        self.assertEqual([rgb('#2d2d2d')] * 3, fields)
        # Their placeholders read at 4.5:1 or more on the panel.
        hints = page.evaluate("() => ['#findings', '#conclusion', '#recommendation'].map(s => getComputedStyle(document.querySelector(s), '::placeholder').color)")
        for hint in hints:
            a, b = sorted((lum(hint), lum('rgb(45, 45, 45)')), reverse=True)
            self.assertGreaterEqual((a + 0.05) / (b + 0.05), 4.5, hint)
        self.reveal(page, '#favorite-open')
        page.locator('#favorite-open').click()
        expect(page.locator('#favorite-dialog')).to_be_visible()
        inputs = page.evaluate('''() => [...document.querySelectorAll('#favorite-dialog :is(select, textarea, input:not([type=checkbox], [type=radio], [type=range]))')]
          .filter(e => e.getClientRects().length).map(e => (e.id || e.name) + ' ' + getComputedStyle(e).backgroundColor)''')
        self.assertTrue(inputs)
        self.assertEqual([], [i for i in inputs if not i.endswith(rgb('#2d2d2d'))])
        page.locator('#favorite-close').click()

    def test_dialogs_opened_from_the_page_use_the_palette(self):
        page = self.open()
        page.locator('#rows tr[data-uid]').first.click()
        expect(page.locator('#findings')).to_be_editable()
        for dialog, opener, close in DIALOGS:
            with self.subTest(dialog=dialog):
                if dialog == '#workspace-shortcuts-dialog':
                    page.locator('#m-reading').click()
                    page.wait_for_function("document.body.classList.contains('reading')")
                self.reveal(page, opener)
                page.locator(opener).click()
                expect(page.locator(dialog)).to_be_visible()
                try:
                    settle(page)
                    self.assertEqual([], self.sweep(page, [dialog]), 'opened')
                    self.keyboard_focus(page, page.locator(dialog).locator(
                        ':is(button, select):visible:not(:disabled)').first)
                    self.assertEqual([], self.sweep(page, [dialog]), 'a control focused')
                finally:
                    page.locator(close).click()
                    expect(page.locator(dialog)).not_to_be_visible()
        for dialog in CLOSED_ONLY:
            with self.subTest(dialog=dialog):
                expect(page.locator(dialog)).to_have_count(1)
                self.assertEqual([], self.sweep(page, [dialog], visible_only=False), 'closed')

    def test_saved_search_manager_selection_focus_and_error_lines(self):
        # A selected search, its keyboard focus, then an invalid rule: the count and status lines are errors and stay red.
        page = self.open()
        self.reveal(page, '#managefilters')
        page.locator('#managefilters').click()
        expect(page.locator('#saved-filter-manager')).to_be_visible()
        page.locator('#sfm-list button').first.click()
        expect(page.locator('#sfm-list button[aria-pressed=true]')).to_have_count(1)
        self.assertEqual([], self.sweep(page, ['#saved-filter-manager']), 'a saved search selected')
        self.keyboard_focus(page, page.locator('#sfm-list button[aria-pressed=true]'))
        self.assertEqual([], self.sweep(page, ['#saved-filter-manager']), 'the selected search focused')
        page.locator('#sfm-new').click()
        page.locator('#sfm-add-rule').click()
        page.locator('#sfm-preview').click()
        expect(page.locator('#saved-filter-manager .sfm-error')).to_have_count(2)
        self.assertEqual([], self.sweep(page, ['#saved-filter-manager']), 'with error lines')
        self.assertEqual([SFM_ERROR, SFM_ERROR], page.evaluate("() => ['#sfm-count', '#sfm-status'].map(s => getComputedStyle(document.querySelector(s)).color)"))

    def test_saved_report_text_colour_still_wins_and_survives_a_reload(self):
        page = self.open()
        page.locator('#rows tr[data-uid]').first.click()
        expect(page.locator('#findings')).to_be_editable()
        self.reveal(page, '#reading-appearance-open')
        page.locator('#reading-appearance-open').click()
        page.locator('#reading-color-current').select_option('warm')
        page.keyboard.press('Escape')
        colours = lambda p: p.locator('#findings').evaluate('e => [getComputedStyle(e).color, getComputedStyle(e).backgroundColor]')
        self.assertEqual([rgb('#fff1d6'), rgb('#2d2d2d')], colours(page))
        self.assertIn('"current":"warm"', page.evaluate('(key) => localStorage.getItem(key)', 'kin-reading-color:v1:' + OWNER))
        page.reload()
        expect(page.locator('#rows')).to_contain_text(auth.PATIENT)
        page.locator('#rows tr[data-uid]').first.click()
        expect(page.locator('#findings')).to_be_editable()
        self.assertEqual([rgb('#fff1d6'), rgb('#2d2d2d')], colours(page))


# Text under 4.5:1 on its own background, as drawn: an element's own text, a field's value, or an empty field's placeholder;
# the colour is blended by the element's opacity (and its ancestors') over the background, which is each ancestor's fill
# composited down to an opaque one. Disabled controls are left out (they are not read as text), and so are check boxes,
# radio buttons and sliders (their label beside them is the text).
LOW_CONTRAST = r'''(scope) => {
  const parse = s => { const m = String(s).match(/rgba?\(([^)]+)\)/); if (!m) return null; const p = m[1].split(/[ ,/]+/).filter(Boolean).map(Number);
    return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1]; };
  const lin = c => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
  const lum = c => 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2]);
  const mix = (top, under) => [0, 1, 2].map(i => top[i] * top[3] + under[i] * (1 - top[3])).concat(1);
  const bgOf = el => { const layers = []; for (let n = el; n; n = n.parentElement) { const c = parse(getComputedStyle(n).backgroundColor);
      if (c && c[3] > 0) { layers.push(c); if (c[3] >= 1) break; } }
    let base = [33, 33, 33, 1]; for (const c of layers.reverse()) base = mix(c, base); return base; };
  const opacity = el => { let o = 1; for (let n = el; n; n = n.parentElement) o *= parseFloat(getComputedStyle(n).opacity); return o; };
  const name = e => e.tagName.toLowerCase() + (e.id ? '#' + e.id : '') + [...e.classList].slice(0, 2).map(c => '.' + c).join('');
  const out = [];
  for (const el of (document.querySelector(scope) || document.body).querySelectorAll('*')) {
    if (el.closest('script, style, svg, canvas, option, iframe') || el.closest(':disabled, [aria-disabled="true"]')) continue;
    if (el.matches('input:is([type=checkbox], [type=radio], [type=range], [type=hidden])')) continue;
    const field = el.matches('input, textarea, select');
    if (!field && !el.matches('button') && ![...el.childNodes].some(n => n.nodeType === 3 && n.nodeValue.trim())) continue;
    const r = el.getBoundingClientRect(), cs = getComputedStyle(el);
    if (r.width < 1 || r.height < 1 || cs.visibility === 'hidden' || r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth) continue;
    const hint = field && !el.value && el.placeholder;
    const fg = parse(hint ? getComputedStyle(el, '::placeholder').color : cs.color), bg = bgOf(el); if (!fg) continue;
    if (field && !el.value && !hint && !el.matches('select')) continue;
    fg[3] *= opacity(el);
    const f = fg[3] < 1 ? mix(fg, bg) : fg, a = lum(f), b = lum(bg), ratio = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
    if (ratio < 4.5) out.push(name(el) + ' "' + (el.value || (hint ? el.placeholder : el.textContent)).trim().slice(0, 24) + '" ' + cs.color + ' on ' + bg.slice(0, 3).map(Math.round) + ' ' + ratio.toFixed(2));
  }
  return out; }'''

# The count row: the counts, Per page and (with more than one page) the page buttons, each whole, inside the bar and
# under the pointer; which line Per page and the counts sit on; and whether the bar overflows.
COUNT_ROW = r'''() => { const bar = document.querySelector('.left > .statusbar'), box = bar.getBoundingClientRect();
  const mid = e => { const r = e.getBoundingClientRect(); return Math.round((r.top + r.bottom) / 2); };
  const controls = [...bar.querySelectorAll('#countlist .count, #worklist-pages label, #page-prev, #page-next')].filter(e => e.getClientRects().length && !e.closest('[hidden]'));
  const whole = controls.map(e => {
    const r = e.getBoundingClientRect(), hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return {text: e.textContent.trim().slice(0, 20), inside: r.left >= box.left - .5 && r.right <= box.right + .5 && r.left >= -.5 && r.right <= innerWidth + .5 && r.width >= 1,
      clipped: e.scrollWidth > e.clientWidth + 1, reachable: !!hit && (hit === e || e.contains(hit))}; });
  const counts = [...bar.querySelectorAll('#countlist .count')].map(mid), perPage = mid(bar.querySelector('#worklist-pages label'));
  const status = bar.querySelector('#toolbar-status');
  const rail = document.querySelector('#worklist-folders-panel').getBoundingClientRect();
  return {countLines: new Set(counts).size, perPageWithCounts: counts.every(y => Math.abs(y - perPage) <= 4),
    statusWithCounts: !status.getClientRects().length || Math.abs(mid(status) - counts[0]) <= 4, width: Math.round(box.width), whole,
    bad: whole.filter(w => !(w.inside && !w.clipped && w.reachable)), overflow: bar.scrollWidth - bar.clientWidth,
    railAbove: rail.bottom <= box.top + .5 || rail.right <= box.left + .5}; }'''

# The status group's texts (observation time, Filter, layout and refresh notes): their widths shown and whole.
STATUS_TEXTS = r'''() => [...document.querySelectorAll('#toolbar-status .toolbar-status-texts > *')].filter(e => e.textContent.trim() && e.getClientRects().length)
  .map(e => ({id: e.id, cut: e.scrollWidth > e.clientWidth + 1}))'''

FIRST_ROW = "() => document.querySelector('#rows tr[data-uid]')?.dataset.uid"


class CountRowSite(PaletteSite):
    """The palette site with the account appearance row, so a test can choose the screen language."""

    def __init__(self):
        super().__init__()
        self.appearance, self.appearance_revision = None, 0

    def api(self, route, request, method, path, query):
        if path != '/api/reading-appearance':
            return super().api(route, request, method, path, query)
        account, refused = self.authenticate(request)
        if refused:
            return self.refuse(route, *refused)
        if method == 'PUT':
            self.appearance, self.appearance_revision = request.post_data_json['sizes'], self.appearance_revision + 1
        return route.fulfill(json={'owner': [auth.INSTITUTION, account['sub']], 'revision': self.appearance_revision, 'sizes': self.appearance})


class CountRowAndContrastDOM(unittest.TestCase):
    """STUDIO 11-01-2 #13 ("please combine these two into a single row") and FA-153 ("maintaining sufficient text contrast").

    The count row (the status counts and Per page) is one line at the default 1920x1080 work page - the Folders panel open,
    as every login opens - in Korean and in English, with one- and four-digit counts, on the reading screen, with Folders
    folded, and with more than one page (the page buttons may take the next line); the status group's texts, cut when the
    line is full, show whole on keyboard focus. No count, not Per page and no page button is cut or covered at 1366, 1024
    or 380 px, and Next/Previous page the list. Text on the worklist, the reading screen, the Reading Workspace and the Defer
    window reads at 4.5:1 or more on its own background (a hovered and a selected row included); a field one writes in
    (#2D2D2D) is marked apart from the panel it lies on by an edge of 3:1 or more."""

    @classmethod
    def setUpClass(cls):
        cls.pw = sync_playwright().start()
        cls.browser = cls.pw.chromium.launch(args=RASTER)

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.pw.stop()

    def open(self, width=1920, height=1080, english=False, studies=None):
        site = CountRowSite()
        if studies:
            site.second_study, site.study_count = True, studies
        context = self.browser.new_context(viewport={'width': width, 'height': height})
        context.route('**/*', lambda route, request: site.handle(route, request))
        page = context.new_page()
        errors = []
        page.on('pageerror', lambda e: errors.append(str(e)))
        self.addCleanup(context.close)
        self.addCleanup(lambda: self.assertEqual([], errors))
        page.goto(auth.MAIN_URL)
        expect(page.locator('#rows')).to_contain_text(auth.PATIENT)
        wait_startup(page, site)
        if english:
            page.locator('#language-open').click()
            dialog = page.locator('#language-dialog')
            dialog.locator('#language-en').check()
            for scope in ('worklist', 'reading'):
                dialog.locator('#language-scope-' + scope).check()
            dialog.locator('#language-apply').click()
            expect(dialog).to_be_hidden()
            expect(page.locator('#worklist-pages label')).to_contain_text('Per page')
        settle(page)
        return page

    def assert_one_line(self, page, what):
        row = page.evaluate(COUNT_ROW)
        self.assertEqual((1, True, True), (row['countLines'], row['perPageWithCounts'], row['statusWithCounts']), (what, row))
        self.assertEqual([], row['bad'], (what, row))
        self.assertLessEqual(row['overflow'], 0, (what, row))
        return row

    def page_through(self, page, what):
        # Next shows other studies, Previous brings the first page back.
        first = page.evaluate(FIRST_ROW)
        page.locator('#page-next').click()
        page.wait_for_function('uid => document.querySelector("#rows tr[data-uid]")?.dataset.uid !== uid', arg=first)
        page.locator('#page-prev').click()
        page.wait_for_function('uid => document.querySelector("#rows tr[data-uid]")?.dataset.uid === uid', arg=first)
        settle(page)
        self.assertEqual([], page.evaluate(COUNT_ROW)['bad'], what)

    def test_count_row_is_one_line_at_the_default_width(self):
        for english in (False, True):
            with self.subTest(language='en' if english else 'ko'):
                page = self.open(english=english)
                expect(page.locator('#worklist-folders-panel')).to_have_attribute('open', '')
                row = self.assert_one_line(page, 'first paint')
                self.assertTrue(row['railAbove'], row)
                # A cut status text shows whole on keyboard focus (the status group's own unfolding).
                if any(t['cut'] for t in page.evaluate(STATUS_TEXTS)):
                    page.locator('#toolbar-status').focus()
                    settle(page)
                    self.assertEqual([], [t for t in page.evaluate(STATUS_TEXTS) if t['cut']], 'focused status group')
                    page.locator('#toolbar-status').blur()
                page.evaluate(r"""() => document.querySelectorAll('#countlist .count').forEach(c => {
                  const t = [...c.childNodes].reverse().find(n => n.nodeType === 3 && /\d/.test(n.nodeValue)); if (t) t.nodeValue = t.nodeValue.replace(/\d+/, '1234'); })""")
                settle(page)
                self.assert_one_line(page, 'four-digit counts')
                page.locator('#rows tr[data-uid]').first.click()
                expect(page.locator('#findings')).to_be_editable()
                settle(page)
                self.assert_one_line(page, 'reading screen')
                page.locator('#worklist-folders-panel > summary').click()
                expect(page.locator('#worklist-folders-panel')).not_to_have_attribute('open', '')
                settle(page)
                self.assert_one_line(page, 'Folders closed')
                self.doCleanups()

    def test_more_than_one_page_keeps_the_counts_and_per_page_together(self):
        for width, height in ((1920, 1080), (1366, 768), (1024, 768), (380, 800)):
            with self.subTest(width=width):
                page = self.open(width, height, studies=52)
                page.locator('#page-size').select_option('25')
                expect(page.locator('#page-next')).to_be_visible()
                settle(page)
                if width == 1920:
                    self.assert_one_line(page, 'three pages')
                self.page_through(page, 'three pages')
                self.doCleanups()

    def test_count_row_keeps_every_count_and_per_page_at_narrow_widths(self):
        for width, height in ((1366, 768), (1024, 768), (380, 800), (800, 1024)):
            with self.subTest(width=width):
                page = self.open(width, height)
                row = page.evaluate(COUNT_ROW)
                self.assertEqual([], row['bad'], (width, row))
                self.assertLessEqual(row['overflow'], 0, (width, row))
                self.doCleanups()

    def open_defer(self, page):
        WorkPaletteDOM.reveal(page, '#b-defer')
        page.locator('#b-defer').click()
        expect(page.locator('#reasonmodal')).to_be_visible()
        settle(page)

    def test_text_reads_at_4_5_on_the_worklist_and_reading_screen(self):
        for english in (False, True):
            with self.subTest(language='en' if english else 'ko'):
                page = self.open(english=english)
                self.assertEqual([], page.evaluate(LOW_CONTRAST, 'body'), 'first paint')
                page.locator('#rows tr[data-uid]').first.hover()
                settle(page)
                self.assertEqual([], page.evaluate(LOW_CONTRAST, '#rows'), 'hovered row')
                page.locator('#rows tr[data-uid]').first.click()
                expect(page.locator('#findings')).to_be_editable()
                settle(page)
                self.assertEqual([], page.evaluate(LOW_CONTRAST, 'body'), 'selected row, report editor')
                self.open_defer(page)
                self.assertEqual([], page.evaluate(LOW_CONTRAST, '#reasonmodal'), 'Defer reason window')
                page.locator('#reason-cancel').click()
                expect(page.locator('#reasonmodal')).not_to_be_visible()
                page.locator('#m-reading').click()
                page.wait_for_function("document.body.classList.contains('reading')")
                settle(page)
                self.assertEqual([], page.evaluate(LOW_CONTRAST, 'body'), 'Reading Workspace')
                page.locator('#m-reading').click()
                page.wait_for_function("!document.body.classList.contains('reading')")
                settle(page)
                self.assertEqual([], page.evaluate(COUNT_ROW)['bad'], 'count row after the Reading Workspace')
                self.doCleanups()

    def test_writing_fields_are_panels_marked_apart_by_their_edge(self):
        page = self.open()
        page.locator('#rows tr[data-uid]').first.click()
        expect(page.locator('#findings')).to_be_editable()
        edge = r'''sel => { const e = document.querySelector(sel), cs = getComputedStyle(e);
          const parse = s => s.match(/[\d.]+/g).map(Number), lin = c => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
          const lum = c => 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2]);
          let under = [33, 33, 33]; const layers = [];
          for (let n = e.parentElement; n; n = n.parentElement) { const c = parse(getComputedStyle(n).backgroundColor); const a = c.length > 3 ? c[3] : 1;
            if (a > 0) { layers.push([c[0], c[1], c[2], a]); if (a >= 1) break; } }
          for (const c of layers.reverse()) under = [0, 1, 2].map(i => c[i] * c[3] + under[i] * (1 - c[3]));
          const b = parse(cs.borderTopColor), ba = b.length > 3 ? b[3] : 1, line = [0, 1, 2].map(i => b[i] * ba + under[i] * (1 - ba));
          const x = lum(line), y = lum(under);
          return [cs.backgroundColor, Math.round((Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05) * 100) / 100, cs.borderTopStyle]; }'''

        def check(fields, where):
            self.assertTrue(fields, where)
            for field in fields:
                with self.subTest(where=where, field=field):
                    colour, ratio, style = page.evaluate(edge, field)
                    self.assertEqual(rgb('#2d2d2d'), colour)
                    self.assertGreaterEqual(ratio, 3, field)
                    self.assertNotEqual('none', style, field)
                    # Keyboard focus on the field (Tab away and back, as a reader does) is drawn in the accent.
                    if page.locator(field).is_disabled():
                        continue
                    page.locator(field).focus()
                    if not page.locator(field).evaluate("e => e.matches(':focus-visible')"):
                        page.keyboard.press('Tab')
                        page.keyboard.press('Shift+Tab')
                    self.assertTrue(page.locator(field).evaluate("e => e === document.activeElement && e.matches(':focus-visible')"), field)
                    focus = page.locator(field).evaluate('e => { const s = getComputedStyle(e); return [s.borderTopColor, s.outlineStyle !== "none" ? s.outlineColor : ""]; }')
                    self.assertIn(rgb('#8ab4c8'), focus, field)
        check(['#findings', '#conclusion', '#recommendation'], 'report fields')
        self.open_defer(page)
        check(['#reason-extra'], 'Defer')
        page.locator('#reason-cancel').click()
        WorkPaletteDOM.reveal(page, '#favorite-open')
        page.locator('#favorite-open').click()
        expect(page.locator('#favorite-dialog')).to_be_visible()
        check(page.evaluate("() => [...document.querySelectorAll('#favorite-dialog :is(textarea, input:not([type=checkbox], [type=radio], [type=range]))')].filter(e => e.getClientRects().length && e.id).map(e => '#' + e.id)"), 'Favorites')
        page.locator('#favorite-close').click()
        # Query/Retrieve is a panel that is a dialog (opened by its toolbar button where peers are configured).
        page.evaluate("document.querySelector('#query-retrieve').hidden = false")
        check(['#qr-patient-id', '#qr-patient-name', '#qr-accession'], 'Query/Retrieve')


if __name__ == '__main__':
    unittest.main()
