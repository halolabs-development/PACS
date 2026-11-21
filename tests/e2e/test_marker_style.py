"""Minhoon item 12 (MH-4): a reader's measurement marker colour and thickness on the served viewer.

REQ-MARKER-STYLE -> RISK-MARKER-RECORD (a display choice changes a mark's points, values or saved item),
RISK-MARKER-PARTIAL (some marks or open windows keep the old look), RISK-MARKER-ACCOUNT (the choice is lost
or crosses accounts) -> TEST-MARKER-STYLE-SERVED. The choice is made in the work page's Appearance & Tools
dialog; an open viewer window redraws its marks without a reload, a new viewer starts with it, the saved
item and measured value do not change, and the account appearance keeps it.
"""
import json
import os
import unittest
from pathlib import Path

from playwright.sync_api import expect
from document_session import document_request
from test_viewer_history import ViewerHistoryE2E
from viewer_tools import select_image_tool
from workspace_roaming_support import cleanup_workspace

# The Length mark as drawn: its own SVG nodes, their stroke colour/width, the colour of its value text, and the
# pointer-feedback colours the viewer uses now. Only the mark's main line carries a data-id in the DOM; the
# tools' public SVG node cache (cornerstoneTools.state.svgNodeCache, per viewport, keyed by annotation UID and
# drawn part) names all of them, the value text and its link line included.
DRAWN = '''() => {
  const ct = cornerstoneTools, a = ct.annotation.state.getAllAnnotations().find(a => a.metadata.toolName === 'Length');
  const style = ct.annotation.config.style.getDefaultToolStyles().global || {};
  const out = {uid: a?.annotationUID || null, highlighted: !!a?.highlighted, selected: !!(a && ct.annotation.selection.isAnnotationSelected?.(a.annotationUID)),
    locked: !!(a && ct.annotation.locking.isAnnotationLocked?.(a.annotationUID)), feedback: [style.colorHighlighted, style.colorSelected].filter(Boolean),
    own: a && ct.annotation.locking.isAnnotationLocked?.(a.annotationUID) ? style.colorLocked : style.color,
    keyed: [], shapes: [], texts: []};
  if (!a) return out;
  const nodes = new Set();
  for (const canvas of Object.values(ct.state?.svgNodeCache || {})) for (const [key, entry] of Object.entries(canvas || {})) {
    const root = entry?.domRef;
    if (!key.includes(a.annotationUID) || !root?.isConnected) continue;
    out.keyed.push(key); nodes.add(root); root.querySelectorAll('*').forEach(n => nodes.add(n));
  }
  for (const e of nodes) {
    if (e.tagName === 'text') { if (e.textContent.trim()) out.texts.push({fill: e.getAttribute('fill'), text: e.textContent}); continue; }
    if (e.closest('text') || !e.hasAttribute('stroke') || e.getAttribute('stroke') === 'none') continue;
    out.shapes.push({tag: e.tagName, stroke: e.getAttribute('stroke'), width: Number(e.getAttribute('stroke-width')), dash: e.getAttribute('stroke-dasharray') || ''});
  }
  return out;
}'''
# Everything needed to read a failed wait: every drawn SVG node, the annotations' states and the live styles.
DIAGNOSIS = '''() => ({
  svg: [...document.querySelectorAll('svg.svg-layer *')].slice(0, 300).map(e => ({tag: e.tagName, id: e.getAttribute('data-id'),
    stroke: e.getAttribute('stroke'), width: e.getAttribute('stroke-width'), fill: e.getAttribute('fill'), text: e.tagName === 'text' ? e.textContent : undefined})),
  annotations: cornerstoneTools.annotation.state.getAllAnnotations().map(a => ({uid: a.annotationUID, tool: a.metadata.toolName,
    highlighted: a.highlighted, locked: cornerstoneTools.annotation.locking.isAnnotationLocked?.(a.annotationUID),
    selected: cornerstoneTools.annotation.selection.isAnnotationSelected?.(a.annotationUID), visible: a.isVisible})),
  styles: cornerstoneTools.annotation.config.style.getDefaultToolStyles(),
  active: document.activeElement?.outerHTML?.slice(0, 200)})'''
STYLES = '() => cornerstoneTools.annotation.config.style.getDefaultToolStyles()'
# The Length just drawn, measured where it ended: the tool's calculation has caught up with the last drag (not invalidated)
# and holds a finite, positive length for the image it refers to. Before that, the history row refuses Save ('측정을 마치고
# 계산 완료 후 저장하세요') - the calculation trails the drag, by more on a slow runner.
MEASURED = '''() => cornerstoneTools.annotation.state.getAllAnnotations().some(a => {
  const s = a.metadata.toolName === 'Length' && !a.invalidated && a.data.cachedStats?.['imageId:' + a.metadata.referencedImageId];
  return !!s && Number.isFinite(s.length) && s.length > 0; })'''
LENGTH = '''() => { const a = cornerstoneTools.annotation.state.getAllAnnotations().find(a => a.metadata.toolName === 'Length');
  return a && {points: a.data.handles.points, stats: a.data.cachedStats}; }'''
# The mark's own lines: all but the one linking the value text (its own '2,3' dashes). A cell whose measurements are not
# tracked yet draws them '4,4'.
SOLID = 'd.shapes.filter(s => s.dash !== "2,3")'
# A Length's line as drawn ('<uid>::line::1' in the tools' SVG node cache): its dashes ('' solid), null before it is drawn.
LINE = '''uid => { for (const canvas of Object.values(cornerstoneTools.state?.svgNodeCache || {})) {
  const n = canvas?.[uid + '::line::1']?.domRef; if (n?.isConnected) return n.getAttribute('stroke-dasharray') || ''; } return null; }'''
# The cells' own styles as the viewer's style registry holds them.
CELLS = '() => JSON.parse(JSON.stringify(cornerstoneTools.annotation.config.style.config.viewports || {}))'
# A cell's styles set the way the measurement-tracking cell sets them, then that cell drawn again.
SET_CELL = '''([cell, styles]) => { cornerstoneTools.annotation.config.style.setViewportToolStyles(cell, styles);
  services.cornerstoneViewportService.getRenderingEngine().renderViewport(cell); }'''


class MarkerStyleE2E(ViewerHistoryE2E):
    def setUp(self):
        super().setUp()
        self.addCleanup(cleanup_workspace, self.stack, 'ReadingAppearance')

    def settings(self, work):
        self.open_toolbar_group(work, '#reading-appearance-open')
        work.locator('#reading-appearance-open').click()
        expect(work.locator('#appearance-account-save')).to_be_enabled()

    def until(self, page, condition, label, arg=None, timeout=30000):
        try:
            page.wait_for_function('arg => { const d = (' + DRAWN + ')(); return ' + condition + '; }', arg=arg, timeout=timeout)
        except Exception:
            folder = Path(os.environ.get('KIN_EVIDENCE_DIR', 'tmp/marker-style')); folder.mkdir(parents=True, exist_ok=True)
            diagnosis = json.dumps({'drawn': page.evaluate(DRAWN), 'page': page.evaluate(DIAGNOSIS)}, ensure_ascii=False, indent=1, default=str)
            (folder / (label + '-diagnosis.json')).write_text(diagnosis, encoding='utf-8')
            # Also in the suite's log, which the CI keeps.
            print('MARKER STYLE DIAGNOSIS', label, json.dumps(json.loads(diagnosis), ensure_ascii=False, default=str)[:20000], flush=True)
            page.screenshot(path=str(folder / (label + '-failed.png')))
            raise
        return page.evaluate(DRAWN)

    def rest(self, page, label):
        # Leave the row's buttons, point at an empty corner of the image and clear the selection, as a reader does,
        # so the mark is drawn in neither its hover nor its selection colour.
        page.evaluate('() => document.activeElement?.blur?.()')
        corner = page.evaluate('''() => services.cornerstoneViewportService.getCornerstoneViewport(
            services.viewportGridService.getActiveViewportId()).element.querySelector('canvas').getBoundingClientRect().toJSON()''')
        # Inside the image, away from the mark and the image text in the corners (the text takes the pointer there, and the
        # mark would stay in its hover colour); a pointer that left a mark leaves it unhighlighted.
        page.mouse.move(corner['x'] + corner['width'] * .15, corner['y'] + corner['height'] * .8, steps=4)
        page.mouse.move(corner['x'] + corner['width'] * .12, corner['y'] + corner['height'] * .85, steps=4)
        page.evaluate('''() => { cornerstoneTools.annotation.selection.deselectAnnotation?.();
            for (const a of cornerstoneTools.annotation.state.getAllAnnotations()) a.highlighted = false;
            for (const engine of cornerstone.getRenderingEngines()) for (const v of engine.getViewports())
              try { cornerstoneTools.utilities.triggerAnnotationRender(v.element); } catch (_) { v.render(); } }''')
        return self.until(page, SOLID + '.length > 0 && d.texts.length > 0 && d.shapes.every(s => !d.feedback.includes(s.stroke)) && '
                          'd.texts.every(t => !d.feedback.includes(t.fill))', label)

    def wait_drawn(self, page, color, width, label):
        # color None: the viewer's own colour for the mark's state (a saved mark reloaded in another window is locked).
        return self.until(page, SOLID + '.length > 0 && ' + SOLID + '.every(s => s.stroke === (arg[0] ?? d.own)) && Math.max(...' + SOLID +
                          '.map(s => s.width)) === arg[1] && d.texts.length > 0 && (arg[0] === null || d.texts.every(t => t.fill === arg[0]))',
                          label, arg=[color, width], timeout=15000)

    def test_marker_style_01_open_windows_redraw_and_records_stay(self):
        folder = Path(os.environ.get('KIN_EVIDENCE_DIR', 'tmp/marker-style'))
        folder.mkdir(parents=True, exist_ok=True)
        f = self.fixture(); self.seed_report(f)
        work, page = self.open_viewer(f)
        select_image_tool(page, 'Length')
        box = page.evaluate('''() => services.cornerstoneViewportService.getCornerstoneViewport(
            services.viewportGridService.getActiveViewportId()).element.querySelector('canvas').getBoundingClientRect().toJSON()''')
        x, y = box['x'] + box['width'] * .4, box['y'] + box['height'] * .4
        page.mouse.move(x, y); page.mouse.down(); page.mouse.move(x + 80, y + 50, steps=10); page.mouse.up()
        row = page.locator('#kin-viewer-history section[data-kind=length]')
        expect(row).to_have_count(1)
        page.wait_for_function(MEASURED)
        row.get_by_role('button', name='Save', exact=True).click()
        expect(row).to_contain_text('저장 완료')
        saved = self.saved(f)
        measured = page.evaluate(LENGTH)
        base = self.rest(page, 'rest-open')
        own_styles = page.evaluate(STYLES)
        base_width = max(s['width'] for s in base['shapes'] if s['dash'] != '2,3')
        page.screenshot(path=str(folder / 'marker-default.png'))
        page.evaluate('window.kinMarkerProbe = 1')

        # The work page's dialog changes the account's choice; the open viewer window follows at once.
        self.settings(work)
        expect(work.locator('#reading-marker-color option')).to_have_count(5)
        expect(work.locator('#reading-marker-width option')).to_have_count(3)
        work.locator('#reading-marker-color').select_option('red')
        work.locator('#reading-marker-width').select_option('thick')
        expect(work.locator('#reading-marker-status')).to_contain_text('적용')
        red = self.wait_drawn(page, 'rgb(255, 64, 64)', base_width * 2, 'red-open')
        self.assertTrue(red['texts'] and all(t['fill'] == 'rgb(255, 64, 64)' for t in red['texts']), red['texts'])
        self.assertEqual(page.evaluate('window.kinMarkerProbe'), 1, 'the viewer window was not reloaded')
        self.assertEqual(page.evaluate(LENGTH), measured, 'points and measured values never follow the display choice')
        self.assertEqual([t['text'] for t in red['texts']], [t['text'] for t in base['texts']])
        self.assertEqual(self.saved(f), saved, 'the saved item holds no display choice')
        page.screenshot(path=str(folder / 'marker-red-thick.png'))

        # A viewer opened afterwards starts with the choice, on the saved mark it loads.
        other = work.context.new_page()
        other.goto(self.stack.proxy + '/ohif/viewer?StudyInstanceUIDs=' + f.uid)
        self.open_measurement_tools(other)
        other.wait_for_function("() => cornerstoneTools.annotation.state.getAllAnnotations().some(a => a.metadata.toolName === 'Length')", timeout=60000)
        self.rest(other, 'rest-new')
        self.wait_drawn(other, 'rgb(255, 64, 64)', base_width * 2, 'red-new')

        # The account keeps the choice; an older-format save cannot replace it.
        work.locator('#appearance-account-save').click()
        expect(work.locator('#appearance-account-status')).to_have_text('표시 설정을 계정에 저장했습니다.')
        stored = document_request(work, 'GET', self.stack.api + '/reading-appearance').json()
        # Version 12 adds the screen language; the marker choice is unchanged.
        self.assertEqual(stored['sizes']['version'], 12)
        self.assertEqual(stored['sizes']['markers'], {'version': 2, 'color': 'red', 'width': 'thick', 'line': 'default', 'arrowheads': 'on', 'font': 'default'})

        # Reset returns both windows to the viewer's own style.
        work.locator('#reading-marker-reset').click()
        for target, label in [(page, 'reset-open'), (other, 'reset-new')]:
            self.wait_drawn(target, None, base_width, label)
            self.assertEqual(target.evaluate(STYLES), own_styles, 'Default/Standard is the viewer style exactly')
        self.assertEqual(page.evaluate(LENGTH), measured)
        (folder / 'marker-style.json').write_text(json.dumps({'study': f.uid, 'base': base, 'red': red, 'stored': stored['sizes']['markers']},
                                                             ensure_ascii=False, indent=2), encoding='utf-8')
        other.close(); page.close(); work.close()

    def test_marker_style_02_line_style_arrowheads_and_font_on_the_drawn_arrow(self):
        # FB-111: the open viewer's Arrow mark as drawn in SVG: the shaft '<uid>::line::1' takes the dashes, the heads
        # '::line::2|3' hide, the label text takes the font; the points and label never change, and Reset returns all.
        f = self.fixture(); self.seed_report(f)
        work, page = self.open_viewer(f)
        self.draw(page, 'FB111 arrow')
        select_image_tool(page, 'WindowLevel')
        uid = page.evaluate("() => cornerstoneTools.annotation.state.getAllAnnotations().find(a => a.metadata.toolName === 'ArrowAnnotate').annotationUID")
        arrow = '''uid => { const out = {}; for (const canvas of Object.values(cornerstoneTools.state?.svgNodeCache || {}))
            for (const [key, entry] of Object.entries(canvas || {})) { const n = entry?.domRef; if (!key.startsWith(uid + '::') || !n?.isConnected) continue;
              const text = n.tagName === 'text' ? n : n.querySelector?.('text');
              out[key] = {dash: n.getAttribute('stroke-dasharray') || '', visibility: n.getAttribute('visibility'), font: text?.getAttribute('font-family') || null}; }
            const a = cornerstoneTools.annotation.state.getAnnotation(uid); out.record = {points: a.data.handles.points, text: a.data.text}; return out; }'''
        page.wait_for_function('uid => !!(' + arrow + ')(uid)[uid + "::line::2"]', arg=uid, timeout=30000)
        base = page.evaluate(arrow, uid)
        # The viewer's own dash for the cell: none once its measurements are tracked, '4,4' before.
        self.assertIn(base[uid + '::line::1']['dash'], ['', '4,4'])
        self.assertEqual([None, None], [base[uid + '::line::' + p]['visibility'] for p in '23'])
        self.settings(work)
        expect(work.locator('#reading-marker-line option')).to_have_count(3)
        expect(work.locator('#reading-marker-arrowheads option')).to_have_count(2)
        expect(work.locator('#reading-marker-font option')).to_have_count(4)
        work.locator('#reading-marker-line').select_option('dashed')
        work.locator('#reading-marker-arrowheads').select_option('off')
        work.locator('#reading-marker-font').select_option('serif')
        page.wait_for_function('uid => { const d = (' + arrow + ')(uid); return d[uid + "::line::1"]?.dash === "6,4" && d[uid + "::line::2"]?.visibility === "hidden" && '
                               'd[uid + "::line::3"]?.visibility === "hidden" && Object.values(d).some(x => (x?.font || "").startsWith(\'"Batang"\')); }', arg=uid, timeout=15000)
        drawn = page.evaluate(arrow, uid)
        self.assertEqual(base['record'], drawn['record'], 'points and label never follow the display choice')
        work.locator('#appearance-account-save').click()
        expect(work.locator('#appearance-account-status')).to_have_text('표시 설정을 계정에 저장했습니다.')
        stored = document_request(work, 'GET', self.stack.api + '/reading-appearance').json()['sizes']
        # Version 12 adds the screen language; the marker choice is unchanged.
        self.assertEqual((stored['version'], stored['markers']), (12, {'version': 2, 'color': 'default', 'width': 'standard', 'line': 'dashed', 'arrowheads': 'off', 'font': 'serif'}))
        work.locator('#reading-marker-reset').click()
        page.wait_for_function('([uid, own]) => { const d = (' + arrow + ')(uid); return d[uid + "::line::1"]?.dash === own && d[uid + "::line::2"]?.visibility === null && '
                               'd[uid + "::line::3"]?.visibility === null; }', arg=[uid, base[uid + '::line::1']['dash']], timeout=15000)
        self.assertEqual({k: v['font'] for k, v in base.items() if k != 'record'}, {k: v['font'] for k, v in page.evaluate(arrow, uid).items() if k != 'record'})
        page.close(); work.close()

    def test_marker_style_03_line_style_on_a_length_in_tracked_and_untracked_cells(self):
        # FB-111 "solid or dashed", "the screen follows at once": the measurement-tracking cell sets its marks' own dash
        # ('4,4' before its measurements are tracked, none after), and the viewer reads a cell's styles before the default
        # ones. Solid and Dashed draw the Length's line so in either cell, set before or after the choice, in the open window
        # and in one opened afterwards; Default returns the cell's own dash; the points, values and saved item stay.
        f = self.fixture(); self.seed_report(f)
        work, page = self.open_viewer(f)
        select_image_tool(page, 'Length')
        box = page.evaluate('''() => services.cornerstoneViewportService.getCornerstoneViewport(
            services.viewportGridService.getActiveViewportId()).element.querySelector('canvas').getBoundingClientRect().toJSON()''')
        x, y = box['x'] + box['width'] * .4, box['y'] + box['height'] * .4
        page.mouse.move(x, y); page.mouse.down(); page.mouse.move(x + 80, y + 50, steps=10); page.mouse.up()
        row = page.locator('#kin-viewer-history section[data-kind=length]')
        expect(row).to_have_count(1)
        page.wait_for_function(MEASURED)
        row.get_by_role('button', name='Save', exact=True).click()
        expect(row).to_contain_text('저장 완료')
        saved, measured = self.saved(f), page.evaluate(LENGTH)
        uid = page.evaluate("() => cornerstoneTools.annotation.state.getAllAnnotations().find(a => a.metadata.toolName === 'Length').annotationUID")
        cell = page.evaluate('() => services.viewportGridService.getActiveViewportId()')
        page.wait_for_function('uid => (' + LINE + ')(uid) !== null', arg=uid, timeout=30000)
        self.assertIn(page.evaluate(LINE, uid), ['', '4,4'])

        def line_is(target, dash, label, mark=uid):
            try:
                target.wait_for_function('([uid, dash]) => (' + LINE + ')(uid) === dash', arg=[mark, dash], timeout=15000)
            except Exception:
                folder = Path(os.environ.get('KIN_EVIDENCE_DIR', 'tmp/marker-style')); folder.mkdir(parents=True, exist_ok=True)
                (folder / (label + '-line.json')).write_text(json.dumps({'dash': target.evaluate(LINE, mark), 'cells': target.evaluate(CELLS)},
                                                                       ensure_ascii=False, indent=1, default=str), encoding='utf-8')
                target.screenshot(path=str(folder / (label + '-line.png')))
                raise
        untracked, tracked = {'global': {'lineDash': '4,4'}}, {'ReferenceLines': {'lineDash': '4,4'}, 'global': {'lineDash': ''}}
        # The viewer sets the cell as it does before its measurements are tracked: its own dash for them.
        page.evaluate(SET_CELL, [cell, untracked])
        line_is(page, '4,4', 'untracked-own')
        self.settings(work)
        choose = work.locator('#reading-marker-line')
        choose.select_option('solid')
        line_is(page, '', 'untracked-solid')
        choose.select_option('dashed')
        line_is(page, '6,4', 'untracked-dashed')
        # The cell's tracking changes after the choice: the choice stays on its marks; the reference lines keep their dash.
        page.evaluate(SET_CELL, [cell, tracked])
        line_is(page, '6,4', 'tracked-dashed')
        self.assertEqual('4,4', page.evaluate(CELLS)[cell]['ReferenceLines']['lineDash'])
        choose.select_option('solid')
        line_is(page, '', 'tracked-solid')
        page.evaluate(SET_CELL, [cell, untracked])
        line_is(page, '', 'untracked-again-solid')
        # A viewer opened afterwards starts with the choice on the saved mark it loads.
        choose.select_option('dashed')
        line_is(page, '6,4', 'open-dashed')
        other = work.context.new_page()
        other.goto(self.stack.proxy + '/ohif/viewer?StudyInstanceUIDs=' + f.uid)
        self.open_measurement_tools(other)
        other.wait_for_function("() => cornerstoneTools.annotation.state.getAllAnnotations().some(a => a.metadata.toolName === 'Length')", timeout=60000)
        loaded = other.evaluate("() => cornerstoneTools.annotation.state.getAllAnnotations().find(a => a.metadata.toolName === 'Length').annotationUID")
        line_is(other, '6,4', 'new-dashed', loaded)
        # Default: each cell's own dash again.
        work.locator('#reading-marker-reset').click()
        line_is(page, '4,4', 'reset-own')
        other.wait_for_function('uid => ["", "4,4"].includes((' + LINE + ')(uid))', arg=loaded, timeout=15000)
        self.assertEqual(page.evaluate(LENGTH), measured, 'points and measured values never follow the display choice')
        self.assertEqual(self.saved(f), saved, 'the saved item holds no display choice')
        other.close(); page.close(); work.close()


if __name__ == '__main__':
    unittest.main()
