/* Keep one live viewer until its unsaved work can be left explicitly. The report
 * editor remains owned by the worklist; viewing a related image cannot retarget it. */
window.KinReadingWorkspace = function (app) {
  'use strict';
  const kinWrite = (el, value, name) => { if (window.KinLanguage) return window.KinLanguage.write(el, value, name); if (name) el.setAttribute(name, value); else el.textContent = value; return el; };
  const work=window.KinWorkContext;
  // A sentence of the page built from its template and its parts (data as is, {t: words}, {e: message}).
  const kinSay = (typeof window !== 'undefined' && window.KinLanguage && window.KinLanguage.say) || ((t, ...p) => t.replace(/\{(?:[ten]?(\d+)|([A-Za-z]\w*))\}/g, (m, i, n) => { const v = n !== undefined ? (p[0] || {})[n] : p[i]; return v === undefined ? m : String(v && typeof v === 'object' ? (v.t ?? v.e ?? '') : v); })), kinSayEn = (typeof window !== 'undefined' && window.KinLanguage && window.KinLanguage.sayEnglish) || kinSay;
  const guarded=fn=>{const at=work.capture('document');return(...args)=>work.commit(at,()=>fn(...args));};
  let renewFrame=()=>{},renewReturn=()=>{};
  const $ = s => document.querySelector(s);
  const node = (tag, text, parent) => {
    const el = document.createElement(tag); if (text) kinWrite(el, text);
    if (parent) parent.append(el); return el;
  };
  const bar = node('section'); bar.id = 'reading-bar'; bar.hidden = true;
  kinWrite(bar, kinSay('판독 작업공간 이동'), 'aria-label'); bar.setAttribute('data-kin-lang-region', 'reading');
  $('.split').before(bar);
  const nav = node('div', '', bar); nav.className = 'reading-actions';
  const button = (label, action, parent = nav) => {
    const b = node('button', label, parent); b.type = 'button'; b.className = 'chip'; b.onclick = action; return b;
  };
  function focusListSearch() {
    // 검색이 상단 Filters 안에 있으므로 이동 단축키도 그 메뉴를 먼저 펼친다.
    const search = $('#quick'), menu = search?.closest('details');
    if (menu) menu.open = true;
    search?.focus();
  }
  const list = button(kinSay('Worklist'), () => {
    document.body.classList.toggle('reading-list-open');
    list.setAttribute('aria-expanded', String(document.body.classList.contains('reading-list-open')));
    if (document.body.classList.contains('reading-list-open')) ($('#rows tr[data-uid]') || list).focus();
    else { closeList(); list.focus(); }
  });
  list.setAttribute('aria-expanded', 'false');
  const previous = button(kinSay('Previous Study'), () => app.move(-1));
  const next = button(kinSay('Next Study'), () => app.move(1));
  const position = node('span', '', nav); position.id = 'reading-position'; position.setAttribute('role', 'status');
  const imageFocus = button(kinSay('Image'), () => focusPane('image'));
  const priorFocus = button(kinSay('Related Report'), () => focusPane('prior'));
  const reportFocus = button(kinSay('Report Editor'), () => focusPane('report'));
  const toolsFocus = button(kinSay('Image Tools'), () => focusPane('tools'));
  toolsFocus.id = 'reading-tools-focus';
  const nativeToolsFocus = button(kinSay('Viewer Toolbar'), () => focusPane('nativeTools'));
  nativeToolsFocus.id = 'reading-native-tools-focus';
  [[list, '1'], [imageFocus, '2'], [priorFocus, '3'], [reportFocus, '4'], [toolsFocus, '7'], [nativeToolsFocus, '9'], [previous, 'ArrowLeft'], [next, 'ArrowRight']].forEach(([b, key]) => {
    b.setAttribute('aria-keyshortcuts', 'Control+Alt+' + key);
  });
  const context = button(kinSay('Study Info & Templates'), () => {
    if (document.body.classList.contains('reading-context-open')) { closeContext(); context.focus(); }
    else focusPane('context');
  });
  context.setAttribute('aria-expanded', 'false');
  context.setAttribute('aria-controls', 'reading-context');
  context.setAttribute('aria-keyshortcuts', 'Control+Alt+5');
  $('.right > .rw').id = 'reading-context';
  const contextReturn = button(kinSay('Back to Report'), () => focusPane('report'), $('.s-clinical'));
  contextReturn.id = 'reading-context-return';
  const note = button(kinSay('Image Tech Note'), showNote);
  note.id = 'reading-tech-note';
  note.setAttribute('aria-keyshortcuts', 'Control+Alt+6');
  note.setAttribute('aria-describedby', 'reading-images');
  const noteRetry = button(kinSay('Reconnect Note'), reconnectNote);
  noteRetry.id = 'reading-note-retry'; noteRetry.hidden = true;
  let noteRetryFocus = null;
  const autoLabel = node('label', '', nav);
  const autoNote = node('input', '', autoLabel); autoNote.type = 'checkbox'; autoNote.id = 'reading-note-auto';
  autoLabel.append(document.createTextNode(' Auto-open Note'));
  kinWrite(autoLabel, kinSay('이 브라우저의 현재 계정 설정 · 연결할 때 한 번 확인하며 입력·미저장 작업 중에는 건너뜁니다'), "title");
  let autoOwner = null, autoLast = null, preferenceGeneration = 0;
  autoNote.onchange = () => {
    preferenceGeneration++;
    const wanted = autoNote.checked, previousOwner = autoOwner;
    syncAutoNote();
    if (autoOwner !== previousOwner) { app.notice('계정이 바뀌었습니다. 자동 열기 설정을 다시 확인하세요.'); return; }
    autoNote.checked = wanted; autoLast = null;
    if (!autoOwner) return;
    try { localStorage.setItem(autoOwner, autoNote.checked ? 'true' : 'false'); }
    catch (_) { app.notice('자동 열기 설정을 저장하지 못했습니다. 현재 화면에서만 적용됩니다.'); }
    maybeAutoNote();
  };
  const separate = button(kinSay('Open Viewer Window'), () => { if (shown && sameTarget()) app.popup(shown.uid, shown.prior, shown.series, returnLink(), shown.viewingSet ? {exam:window.KinExamScope.originalInput([shown.uid,shown.prior].filter(Boolean)),viewingSet:shown.viewingSet} : shown.exam ? {exam:shown.exam} : null); });
  button(kinSay('Exit Workspace'), leave);
  const target = node('div', '', bar); target.id = 'reading-target';
  const shortcutHelp = node('details', '', bar); shortcutHelp.id = 'reading-shortcut-help';
  node('summary', 'Keyboard Shortcuts', shortcutHelp);
  const hints = node('div', 'Ctrl+Alt+1 목록 · 2 영상 · 3 과거 판독 · 4 작성 · 5 정보 · 6 영상 Tech 메모 · 7 작업 패널 · 9 기본 영상 도구 (Tab 이동·Enter 선택) · ←/→ 이전/다음 검사 (입력 중 이동 제외)', shortcutHelp);
  hints.id = 'reading-shortcuts';
  const shortcutButtons = {list,image:imageFocus,prior:priorFocus,report:reportFocus,context,note,tools:toolsFocus,nativeTools:nativeToolsFocus,previous,next};
  const shortcuts = KinWorkspaceShortcuts.create({host:nav,owner:app.noteOwner,allowed:app.allowed,changed:map=>{
    for(const [id,b] of Object.entries(shortcutButtons)){if(map[id])b.setAttribute('aria-keyshortcuts',KinWorkspaceShortcuts.display(map[id]));else b.removeAttribute('aria-keyshortcuts');}
    // Each button name is its own text (the words the button was given), so the screen language reaches it like the button.
    const label=text=>Object.assign(document.createElement('span'),{textContent:text}),parts=[];
    Object.entries(shortcutButtons).forEach(([id,b],i)=>{if(i)parts.push(' · ');parts.push(label(window.KinLanguage?window.KinLanguage.source(b):b.textContent),' '+KinWorkspaceShortcuts.display(map[id]));});
    // C-R01-008: Approve is in the same map (Ctrl+S by default); the summary names it too.
    hints.replaceChildren(...parts,kinWrite(document.createTextNode(''),kinSayEn(' (입력 중 검사 이동 제외)')),' · ',label('Approve'),' '+KinWorkspaceShortcuts.display(map.finalize),
      ...(map.finalizeNext?[' · ',label('Approve & Next'),' '+KinWorkspaceShortcuts.display(map.finalizeNext)]:[]));
    const approveNext=document.getElementById('b-approve-next');
    if(approveNext){if(map.finalizeNext)approveNext.setAttribute('aria-keyshortcuts',KinWorkspaceShortcuts.display(map.finalizeNext));else approveNext.removeAttribute('aria-keyshortcuts');}
  }});
  /* C-R01-008: the summary also names the letter keys of the Viewer window. They are the saved viewer keys of the account
   * (/api/workspace-shortcuts viewerSettings), or the viewer defaults when none are saved, read from the viewer
   * definitions (viewer-ux-shortcuts.js) when the summary opens; this page keeps no copy of them. */
  const viewerKeys = node('div', '', shortcutHelp); viewerKeys.id = 'reading-viewer-keys';
  let viewerKeysTicket = 0, viewerKeyFile = null;
  function viewerKeyDefinitions() {
    if (window.KinViewerUXShortcuts?.current) return Promise.resolve(window.KinViewerUXShortcuts);
    return viewerKeyFile ||= new Promise((resolve, reject) => {
      const script = document.createElement('script'); script.src = 'viewer-ux-shortcuts.js';
      script.onload = () => { script.remove(); window.KinViewerUXShortcuts?.current ? resolve(window.KinViewerUXShortcuts) : reject(Error('definitions')); };
      script.onerror = () => { script.remove(); reject(Error('load')); };
      document.head.append(script);
    }).catch(error => { viewerKeyFile = null; throw error; });
  }
  async function paintViewerKeys() {
    const ticket = ++viewerKeysTicket, owner = app.allowed() ? app.noteOwner() : null;
    const live = () => ticket === viewerKeysTicket && shortcutHelp.open;
    kinWrite(viewerKeys, kinSay('Viewer 창 글자 키를 확인하는 중…'));
    try {
      const keys = await viewerKeyDefinitions();
      let settings = null;
      if (owner) {
        const at = work.capture('document');
        const response = await KinSessionTransport.page().request('/api/workspace-shortcuts', { context: at, method: 'GET',
          credentials: 'same-origin', cache: 'no-store' });
        if (!response.ok || JSON.stringify(response.body?.owner) !== owner || app.noteOwner() !== owner) throw Error('account');
        settings = response.body.viewerSettings ?? null;
      }
      if (!live()) return;
      const map = keys.current(settings);
      const shown = Object.keys(map).filter(id => map[id]).map(id => keys.display(map[id]) + ' ' + (keys.names[id] || id));
      kinWrite(viewerKeys, kinSayEn("Viewer 창 글자 키: {0} (입력 칸 밖에서)", (shown.join(' · ') || kinSayEn('없음'))));
    } catch (_) {
      if (live()) kinWrite(viewerKeys, kinSay('Viewer 창 글자 키를 확인하지 못했습니다. Keyboard Shortcuts를 다시 열어 확인하세요.'));
    }
  }
  shortcutHelp.addEventListener('toggle', () => { if (shortcutHelp.open) void paintViewerKeys(); else viewerKeysTicket++; });
  const host = node('section'); host.id = 'reading-viewer'; host.hidden = true;
  kinWrite(host, kinSay('영상 작업공간'), 'aria-label'); host.setAttribute('data-kin-lang-region', 'reading'); $('.split').prepend(host);
  const info = node('div', '', host); info.id = 'reading-images';
  const status = node('div', '', host); status.id = 'reading-status'; status.setAttribute('role', 'status');
  const recovery = node('div', '', host); recovery.id = 'reading-recovery'; recovery.hidden = true;
  const back = button(kinSay('Return to Previous Viewer'), () => { if (shown) app.select(shown.reportUid); }, recovery);
  const retry = button(kinSay('Reopen Viewer'), () => { if (pending) attempt(pending, false); }, recovery);
  const discard = button(kinSay('Discard Viewer Changes & Open'), () => {
    if (pending && confirm(kinSay('이전 영상의 저장하지 않은 표식·소견 작성 내용(보관 중인 다른 검사 소견 포함)과 작업 제목·설명을 버리고 선택한 영상을 엽니다. 판독문 초안은 별도로 유지됩니다. 계속할까요?'))) attempt(pending, true);
  }, recovery);
  const reportTarget = node('div'); reportTarget.id = 'reading-report-target'; reportTarget.hidden = true;
  $('.report-p').prepend(reportTarget);
  let active = false, ended = false, frame = null, shown = null, pending = null, epoch = 0, timer = null, deadline = 0, loaded = false, failed = false, lastSelection;
  let viewingSet = null; // W9: the fresh resolve metadata of the members this workspace was asked to show (openViewingSet)
  const panelModel = KinReadingPanelLayout;
  let panelValues = panelModel.defaults(), panelDrag = null, panelStyleSignature = '', shownFieldFloor = null;
  const split = $('.split'), reportColumn = $('.right'), relatedRegion = $('.related-p');
  const relatedList = $('.related-list-pane'), priorReport = $('.prior-report-pane');
  const relatedListHome = { parent: relatedList.parentNode, next: relatedList.nextSibling };
  reportColumn.id = 'reading-report-column'; relatedRegion.id = 'reading-related-region';
  relatedList.id = 'reading-related-list'; priorReport.id = 'reading-prior-report';
  const relatedToggle = button(kinSay('Hide Related Panel'), () => setRelatedHidden(!panelValues.relatedHidden));
  relatedToggle.id = 'reading-related-toggle'; relatedToggle.setAttribute('aria-controls', relatedRegion.id);
  kinWrite(relatedToggle, kinSay('관련 검사·이전 판독문 패널을 숨기거나 복원합니다. 작성 중인 내용은 유지됩니다.'), "title");
  const panelsReset = button(kinSay('Reset Panels'), () => commitPanels(panelModel.defaults()));
  panelsReset.id = 'reading-panels-reset';
  kinWrite(panelsReset, kinSay('통합 작업공간의 패널 크기와 표시를 기본값으로 되돌립니다.'), "title");
  const panelHelp = node('p', kinSay('패널 경계는 드래그하거나 Tab으로 선택한 뒤 방향키로 조절합니다. Shift는 크게 이동, Home/End는 최소/최대, Enter는 해당 경계의 기본값입니다. 좁은 창의 영상·판독은 위아래로 배치하며, 숨긴 관련 패널은 Related Report로 다시 엽니다.'), shortcutHelp);
  panelHelp.id = 'reading-panel-help';
  const panelSeparators = [];
  /**
   * The Related table's floor is its sticky header plus one whole row, read from layout (fonts, zoom and the row's own
   * content decide both). A fixed 40px left a table whose header covered the row under it: a click aimed at that row
   * reached the header instead (S7-U5 fix-up D). The header height is also the table's scroll padding, so a row brought
   * into view by the wheel, the keyboard or a click is placed below the header, never under it.
   */
  function relatedTableFloor() {
    const grid = relatedList.querySelector('.grid2');
    const head = grid?.querySelector('thead')?.getBoundingClientRect().height || 0;
    const row = grid?.querySelector('tbody tr')?.getBoundingClientRect().height || 0;
    return { head: Math.ceil(head), floor: Math.max(40, Math.ceil(head + row)) };
  }
  /**
   * The report column's height, divided in this one place (B21: a laptop's Chrome window, inside 1366x640 or 1280x650,
   * left Findings one 32px line under the button row). Beside the image the column keeps, from the window down:
   *   its fixed rows - the target line at its one-line floor, the notice band, the editor's head and the button row (the
   *   sizes the window's width and the reader's text give them; no server answer changes them: main.html "An answer never
   *   resizes") - and the field region at `want`: the Findings label and five lines of the reader's text.
   * Two places apply it: the related panel above gives way down to its own floor (resolve: reportMin), and the field region
   * keeps what is left up to `want` (--reading-field-floor) so the rows under the button row (image requests, Critical
   * Results) leave the window before it does - they stay in the column and its scroll reaches them. While the reader has
   * opened a row before the button row (questions, citations, dictation) the region's floor is its one line as before, so
   * those rows and the button row keep the order the Reading rules give them (reading-workspace.css, the column's height).
   */
  // The line pitch of an element's text as laid out. A `normal` line height is not 1.2 times the size: a Korean line in a
  // 20px Latin font is 29px. So it is read from two lines of that font (Korean and Latin) laid out once per font.
  const pitches = new Map();
  function linePitch(e) {
    const s = getComputedStyle(e), stated = parseFloat(s.lineHeight);
    if (stated) return stated;
    const key = [s.fontStyle, s.fontWeight, s.fontSize, s.fontFamily].join('|');
    if (!pitches.has(key)) {
      const probe = document.createElement('div');
      probe.style.cssText = 'position:absolute;left:-10000px;top:0;visibility:hidden;white-space:pre;margin:0;padding:0;border:0;line-height:normal';
      Object.assign(probe.style, { fontStyle: s.fontStyle, fontWeight: s.fontWeight, fontSize: s.fontSize, fontFamily: s.fontFamily });
      // A Hangul syllable and Latin letters on each line, built from code points: a sample of glyphs, not a screen word.
      const sample = String.fromCharCode(0xAC00) + 'Ag'; probe.textContent = sample + '\n' + sample; document.body.append(probe);
      pitches.set(key, probe.getBoundingClientRect().height / 2); probe.remove();
    }
    return pitches.get(key);
  }
  function reportColumnGeometry() {
    const column = $('.report-p'), compose = column?.querySelector('.report-compose'), region = column?.querySelector('.redit');
    const row = column?.querySelector('.rfoot2'), findings = $('#findings'), label = region?.querySelector('label');
    if (!column || !compose || !region || !row || !findings || !column.getClientRects().length) return null;
    const px = value => parseFloat(value) || 0, style = e => getComputedStyle(e), lineOf = linePitch;
    const target = reportTarget.getClientRects().length ? (s => lineOf(reportTarget) + px(s.paddingTop) + px(s.paddingBottom)
      + px(s.borderTopWidth) + px(s.borderBottomWidth))(style(reportTarget)) : 0;
    const band = $('#report-notices')?.getBoundingClientRect().height || 0;
    const head = compose.getBoundingClientRect().height - region.getBoundingClientRect().height;
    const fixed = target + band + Math.max(0, head) + row.getBoundingClientRect().height;
    const r = style(region), f = style(findings), l = label ? style(label) : null;
    const want = px(r.paddingTop) + px(r.paddingBottom) + (label ? label.getBoundingClientRect().height + px(l.marginTop) + px(l.marginBottom) : 0)
      + px(r.rowGap) + 5 * lineOf(findings) + px(f.paddingTop) + px(f.paddingBottom) + px(f.borderTopWidth) + px(f.borderBottomWidth);
    // The column's own frame, and what stands between it and a shown related panel: the separator and that card's margins.
    const c = style(column), s = style(relatedRegion), separator = panelSeparators.find(item => item.kind === 'relatedHeight')?.el;
    const frame = px(c.marginTop) + px(c.marginBottom) + px(c.borderTopWidth) + px(c.borderBottomWidth) + px(c.paddingTop) + px(c.paddingBottom);
    const between = px(s.marginTop) + px(s.marginBottom) + (separator?.getClientRects().length ? separator.getBoundingClientRect().height : 0);
    // A row the reader opened before the button row (not the target line, the band or the editor).
    const opened = [...column.children].some(e => e !== reportTarget && e !== compose && e.id !== 'report-notices'
      && (e.compareDocumentPosition(row) & Node.DOCUMENT_POSITION_FOLLOWING) && e.getClientRects().length && e.getBoundingClientRect().height > 0);
    return { fixed: Math.ceil(fixed), want: Math.ceil(want), frame: Math.ceil(frame), between: Math.ceil(between), opened };
  }
  function panelGeometry() {
    const grid = relatedList.querySelector('.grid2'), table = relatedTableFloor();
    const listMin = [...relatedList.children].filter(child => child !== grid && child.getClientRects().length)
      .reduce((total, child) => total + child.getBoundingClientRect().height, table.floor);
    const narrow = matchMedia('(max-width: 850px)').matches, workHeight = $('.workrow').clientHeight;
    const report = !narrow && active && !document.body.classList.contains('reading-context-open') ? reportColumnGeometry() : null;
    const geometry = panelModel.resolve(panelValues, { width: split.clientWidth || innerWidth, narrow,
      height: innerHeight, workHeight, listMin, reportMin: report ? report.between + report.frame + report.fixed + report.want : undefined });
    if (!geometry) return geometry;
    // The field region keeps what the column has left after its fixed rows, up to `want`, and never less than one line.
    let fieldFloor = 32;
    if (report && !report.opened) {
      const related = relatedRegion.getClientRects().length ? geometry.effective.relatedHeight + report.between : 0;
      const columnHeight = workHeight - related - report.frame;
      // Whole pixels taken down (the rows' sub-pixel heights are rounded up above), so the button row is never pushed.
      fieldFloor = Math.max(32, Math.floor(Math.min(report.want, columnHeight - report.fixed - 1)));
    }
    return { ...geometry, table, fieldFloor };
  }
  function snapshotPanels() { return panelModel.normalize(panelValues); }
  function applyPanels(value) {
    const next = panelModel.normalize(value); if (!next || ended) return false;
    cancelPanelDrag(); panelValues = next; renderPanels(); return true;
  }
  function commitPanels(value) {
    if (!active || ended || !app.allowed()) return false;
    const next = panelModel.normalize(value); if (!next) return false;
    panelValues = next; renderPanels();
    const snapshot = snapshotPanels();
    app.onPanelsChange?.(snapshot);
    return true;
  }
  function setRelatedHidden(hidden) {
    if (!active || ended || !app.allowed()) return;
    if (hidden && relatedRegion.contains(document.activeElement)) relatedToggle.focus();
    commitPanels({ ...panelValues, relatedHidden: hidden });
  }
  function renderPanels() {
    const geometry = panelGeometry(), values = geometry.effective;
    // The field region's floor changes with the rows the reader opens, never the image: it is written apart from the sizes below.
    if (geometry.fieldFloor !== shownFieldFloor) { shownFieldFloor = geometry.fieldFloor; split.style.setProperty('--reading-field-floor', shownFieldFloor + 'px'); }
    const signature = JSON.stringify([active, ended, panelValues.relatedHidden, values, geometry.table]);
    document.body.classList.toggle('reading-related-hidden', active && panelValues.relatedHidden);
    relatedRegion.inert = active && panelValues.relatedHidden;
    if (active && panelValues.relatedHidden) relatedRegion.setAttribute('aria-hidden', 'true');
    else relatedRegion.removeAttribute('aria-hidden');
    kinWrite(relatedToggle, panelValues.relatedHidden ? kinSay('Show Related Panel') : kinSay('Hide Related Panel'));
    relatedToggle.setAttribute('aria-expanded', String(!panelValues.relatedHidden));
    relatedToggle.disabled = panelsReset.disabled = ended || !app.allowed();
    priorFocus.setAttribute('aria-controls', priorReport.id);
    for (const item of panelSeparators) {
      const key = item.kind === 'report' ? (geometry.narrow ? 'imageHeight' : 'reportWidth') : item.kind;
      const range = geometry.ranges[key], horizontal = key !== 'reportWidth';
      item.el.hidden = !active || item.kind !== 'report' && panelValues.relatedHidden;
      item.el.setAttribute('aria-orientation', horizontal ? 'horizontal' : 'vertical');
      item.el.setAttribute('aria-valuemin', String(range.min)); item.el.setAttribute('aria-valuemax', String(range.max));
      item.el.setAttribute('aria-valuenow', String(values[key]));
      kinWrite(item.el, kinSay('{0} 픽셀', values[key]), 'aria-valuetext');
      item.el.setAttribute('aria-disabled', String(ended || !app.allowed()));
      item.el.tabIndex = ended || !app.allowed() ? -1 : 0;
    }
    if (signature === panelStyleSignature) return;
    panelStyleSignature = signature;
    split.style.setProperty('--reading-report-width', values.reportWidth + 'px');
    split.style.setProperty('--reading-image-height', values.imageHeight + 'px');
    split.style.setProperty('--reading-related-height', values.relatedHeight + 'px');
    split.style.setProperty('--reading-related-list-height', values.relatedListHeight + 'px');
    split.style.setProperty('--reading-related-table-floor', geometry.table.floor + 'px');
    split.style.setProperty('--reading-related-table-head', geometry.table.head + 'px');
    if (active) redrawRetainedViewer();
  }
  function cancelPanelDrag() {
    const drag = panelDrag; if (!drag) return;
    panelDrag = null; panelValues = drag.before;
    if (drag.item.el.hasPointerCapture(drag.pointer)) drag.item.el.releasePointerCapture(drag.pointer);
    document.body.classList.remove('reading-panel-resizing'); renderPanels();
  }
  function separator(kind, id, label, controls, after) {
    const el = node('div'); el.id = id; el.className = 'reading-panel-separator'; el.hidden = true;
    el.setAttribute('role', 'separator'); el.setAttribute('aria-label', label); el.setAttribute('aria-controls', controls);
    el.setAttribute('aria-describedby', panelHelp.id); kinWrite(el, kinSay('드래그 또는 방향키로 크기 조절 · Enter: 기본값'), "title");
    after.after(el);
    const item = { kind, el }; panelSeparators.push(item);
    const keyFor = geometry => kind === 'report' ? (geometry.narrow ? 'imageHeight' : 'reportWidth') : kind;
    const allowed = () => active && !ended && app.allowed() && !modalOpen(document);
    el.addEventListener('keydown', e => {
      if (!allowed() || e.ctrlKey || e.altKey || e.metaKey || e.isComposing) return;
      const geometry = panelGeometry(), key = keyFor(geometry), range = geometry.ranges[key];
      const axis = key === 'reportWidth' ? ['ArrowRight', 'ArrowLeft'] : ['ArrowUp', 'ArrowDown'];
      if (![...axis, 'Home', 'End', 'Enter', 'Escape'].includes(e.key)) return;
      if (e.key === 'Escape' && !panelDrag) return;
      e.preventDefault(); e.stopPropagation();
      if (e.key === 'Escape') { cancelPanelDrag(); return; }
      cancelPanelDrag();
      const value = e.key === 'Enter' ? null : e.key === 'Home' ? range.min : e.key === 'End' ? range.max :
        Math.max(range.min, Math.min(range.max, geometry.effective[key] + (e.key === axis[1] ? 1 : -1) * (e.shiftKey ? 40 : 10)));
      commitPanels({ ...panelValues, [key]: value });
    });
    el.addEventListener('pointerdown', e => {
      if (!allowed() || e.button !== 0) return;
      cancelPanelDrag(); e.preventDefault(); el.focus();
      const geometry = panelGeometry(), key = keyFor(geometry);
      panelDrag = { item, key, before: snapshotPanels(), pointer: e.pointerId,
        origin: key === 'reportWidth' ? e.clientX : e.clientY, size: geometry.effective[key], narrow: geometry.narrow };
      app.onPanelsEdit?.();
      el.setPointerCapture(e.pointerId); document.body.classList.add('reading-panel-resizing');
    });
    el.addEventListener('pointermove', e => {
      const drag = panelDrag; if (!drag || drag.item !== item || drag.pointer !== e.pointerId) return;
      const geometry = panelGeometry();
      if (!allowed() || geometry.narrow !== drag.narrow) { cancelPanelDrag(); return; }
      const range = geometry.ranges[drag.key], delta = (drag.key === 'reportWidth' ? drag.origin - e.clientX : e.clientY - drag.origin);
      panelValues = { ...panelValues, [drag.key]: Math.round(Math.max(range.min, Math.min(range.max, drag.size + delta))) };
      renderPanels();
    });
    el.addEventListener('pointerup', e => {
      const drag = panelDrag; if (!drag || drag.item !== item || drag.pointer !== e.pointerId) return;
      const next = snapshotPanels(); panelDrag = null;
      if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
      document.body.classList.remove('reading-panel-resizing');
      if (allowed()) commitPanels(next); else { panelValues = drag.before; renderPanels(); }
    });
    for (const event of ['pointercancel', 'lostpointercapture']) el.addEventListener(event, () => {
      if (panelDrag?.item === item) cancelPanelDrag();
    });
  }
  separator('report', 'reading-resize-report', 'Image and Report Size', 'reading-viewer reading-report-column', host);
  separator('relatedHeight', 'reading-resize-related', 'Related Panel Height', relatedRegion.id, relatedRegion);
  separator('relatedListHeight', 'reading-resize-prior', 'Related List and Report Size', relatedList.id + ' ' + priorReport.id, relatedList);
  // Everything the panels' sizes and the report column's division depend on (panelGeometry), in one list: set up here and
  // again when a session becomes active, so no path keeps an observer that misses some of it. The split, the work row and
  // the Related list's rows; the table's header and rows (relatedTableFloor: a new row height or header font re-sizes the
  // list); the report column's rows (reportColumnGeometry: a row the reader opens or folds, the editor's head taking
  // another line when its state words change, the button row's lines); and the root element's style, where Reading
  // Appearance writes the reader's text sizes and fonts (the field region's five lines follow them).
  let panelObserver = null, panelStyleObserver = null;
  const relatedTable = relatedList.querySelector('.grid2 table');
  function watchPanels() {
    panelObserver?.disconnect(); panelStyleObserver?.disconnect();
    const changed = guarded(() => { if (active && !ended) renderPanels(); });
    panelObserver = new ResizeObserver(changed);
    [split, $('.workrow'), relatedList, ...[...relatedList.children].filter(child => !child.classList.contains('grid2')), relatedTable,
      ...($('.report-p')?.children || []), $('.report-editor-head')].filter(Boolean).forEach(e => panelObserver.observe(e));
    panelStyleObserver = new MutationObserver(changed);
    panelStyleObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['style'] });
  }
  function unwatchPanels() { panelObserver?.disconnect(); panelStyleObserver?.disconnect(); }
  watchPanels();
  let panelWindowResize = guarded(() => { if (panelDrag) cancelPanelDrag(); if (active && !ended) renderPanels(); });
  window.addEventListener('resize', panelWindowResize);
  const boundDocuments = new WeakSet();
  let returnChannel=null;
  // The studies the pane's viewer opened: every original of the exam it opened on scopes (a merged exam), else the
  // study and its comparison.
  const shownStudies=()=>shown?.exam?.studyUids?[...shown.exam.studyUids]:[shown.uid,...(shown.prior?[shown.prior]:[])];
  function returnLink(){
    returnChannel?.close();returnChannel=null;
    if(ended||!active||!app.allowed()||!sameTarget())return null;
    const owner=app.noteOwner?.(),report=app.current(),studies=shownStudies();
    if(!owner)return null;
    try{
      const token=crypto.randomUUID(),link=new BroadcastChannel('kin-reading-return:'+token);returnChannel=link;
      const receive=e=>{
        const m=e.data;if(!m||m.type!=='request'||typeof m.request!=='string'||!/^[0-9a-f-]{36}$/.test(m.request))return;
        const reply=result=>{if(returnChannel===link)link.postMessage({type:'result',request:m.request,result});};
        const matchingScope=()=>sameTarget()&&shown&&JSON.stringify(shownStudies())===JSON.stringify(studies)&&Array.isArray(m.studies)&&m.studies.length===studies.length&&m.studies.every((uid,i)=>uid===studies[i])&&studies.includes(m.activeUid);
        if(ended||!app.allowed()||app.noteOwner?.()!==owner||m.owner!==owner){reply('session');return;}
        if(!active||app.current()!==report||!matchingScope()){reply('context');return;}
        if(modalOpen(document)){reply('modal');return;}
        const field=$('#findings');if(!field||!field.getClientRects().length||field.disabled||field.closest('[inert]')){reply('unavailable');return;}
        focusPane('report');window.focus();
        // A background/occluded window may not receive animation frames. Still
        // answer with the manual-selection fallback if focus was not granted.
        setTimeout(guarded(()=>{
          if(ended||!app.allowed()||app.noteOwner?.()!==owner){reply('session');return;}
          if(!active||app.current()!==report||!matchingScope()||modalOpen(document)){reply('context');return;}
          if(!field.isConnected||!field.getClientRects().length||field.disabled||field.closest('[inert]')){reply('unavailable');return;}
          reply(document.hasFocus()&&document.activeElement===field?'focused':'ready');
        }),0);
      };
      renewReturn=()=>{link.onmessage=guarded(receive);};renewReturn();
      return token;
    }catch(_){return null;}
  }
  // A viewer's print dialog asks for this page's unsaved report body (viewer-editor-link.js): a viewer window this list opened
  // over the list's window-group channel (viewer-windows.js relays it here), the integrated viewer frame by postMessage. Both
  // get the same read-only answer (KinViewerWindows.editorReply); the session names this document, login and report target.
  const editorDocument=crypto.randomUUID();
  const editorReader={
    owner:()=>!ended&&app.allowed()?app.noteOwner?.():null,
    target:()=>app.current(),
    examStamp:(uid=app.current())=>window.KinExamScope.readingStamp(app.study(uid),uid),
    modal:()=>modalOpen(document),
    field:id=>$('#'+id),
    usable:field=>field.isConnected&&!!field.getClientRects().length&&!field.disabled&&!field.closest('[inert]'),
    session:(owner,uid)=>JSON.stringify([editorDocument,owner,uid]),
  };
  const editorReply=message=>window.KinViewerWindows?.editorReply?.(message,editorReader)??null;
  window.kinReadingEditorReply=editorReply;
  // A viewer window's Open in Reading Screen (viewer-windows.js editorOpen): this page's own select(uid) - the study-move gate
  // that saves or refuses the text it holds - and, once it has moved there, the caret in Findings. One request at a time.
  let editorOpening=false,opening=null;
  const openReader={...editorReader,
    busy:()=>editorOpening,
    listed:uid=>!!app.study(uid),
    verifyExam:(uid,stamp)=>app.verifyExam(uid,stamp),
    admitted:request=>opening?.request===request&&!opening.cancelled,
    // No opening can still move the target: none under way, or the one under way is this request's, already dropped.
    settled:request=>!opening||opening.request===request&&!!opening.cancelled,
    select:uid=>app.select(uid),
    focus:()=>{if(active&&!ended)focusPane('report');else app.focusReport?.();},
  };
  window.kinReadingEditorOpen=message=>{
    const answer=window.KinViewerWindows?.editorOpen?.(message,openReader);
    if(!answer)return null;
    if(editorOpening)return answer;
    editorOpening=true;opening={request:message.request,uid:message.uid};
    return Promise.resolve(answer).finally(()=>{editorOpening=false;opening=null;});
  };
  // The viewer withdrew the opening it is waiting for no more (viewer-editor-link.js): a move still waiting for this page's
  // study-move gate does not happen; the page stays on the study it is on. Then it is told where the report target is
  // (KinViewerWindows.editorWithdrawn): with the move dropped first, that is the request's outcome.
  window.kinReadingEditorCancel=message=>{
    if(opening&&message&&message.request===opening.request&&message.uid===opening.uid){opening.cancelled=true;app.cancelMove?.(opening.uid);}
    return window.KinViewerWindows?.editorWithdrawn?.(message,openReader)??null;
  };
  // Read on every message rather than captured once: the frame and the document state are current values.
  window.addEventListener('message',e=>{
    if(work.state()!=='active'||e.origin!==location.origin||!frame||e.source!==frame.contentWindow||e.data?.type!=='kin-editor-request')return;
    const answer=editorReply(e.data);if(answer)e.source.postMessage(answer,location.origin);
  });
  let queueObserver = new MutationObserver(guarded(navigation));
  queueObserver.observe($('#rows'), { childList: true });
  function navigation() {
    const queue = app.queue(), i = queue.findIndex(s => s.uid === app.current());
    const unavailable = ended || !app.allowed() || !queue.length;
    previous.disabled = unavailable || i === 0;
    next.disabled = unavailable || i === queue.length - 1;
    kinWrite(position, !queue.length ? kinSay('현재 목록 0건') : i < 0 ? kinSay('현재 검사: 목록 밖 · {n0}건', queue.length) : kinSay('현재 목록 {n0} / {n1}', i + 1, queue.length));
  }
  function closeList() {
    $('#quick')?.closest('details')?.removeAttribute('open');
    document.body.classList.remove('reading-list-open'); list.setAttribute('aria-expanded', 'false');
  }
  function closeContext() {
    document.body.classList.remove('reading-context-open'); context.setAttribute('aria-expanded', 'false');
    redrawRetainedViewer();
  }
  function focusPane(which) {
    if (!active || ended || !app.allowed()) return;
    // W5 (D1423 R4): Related Report opens the page's Related Report mode for the viewed Related study and Report Editor is its
    // Back, when the page has the mode (the same hook the viewer frame's Finalize uses); otherwise they only move focus.
    // A hidden Related panel comes back first: the mode opens inside it (Minhoon item 8), and its title takes the focus.
    if (which === 'prior' && panelValues.relatedHidden) setRelatedHidden(false);
    if ((which === 'prior' || which === 'report') && window.KinReportCommands?.related?.(which) === true) {
      // The mode took the key (its entry or its Back): the list overlay follows as for the panes.
      closeList();
      return;
    }
    if (which === 'context') {
      closeList(); document.body.classList.add('reading-context-open'); context.setAttribute('aria-expanded', 'true');
      $('#clinical').focus(); $('#clinical').scrollIntoView({ block: 'nearest' }); redrawRetainedViewer(); return;
    }
    if (which === 'image' || which === 'tools' || which === 'nativeTools') {
      if (!frame || !sameTarget() || !loaded || frame.inert) { kinWrite(status, kinSay('영상 연결을 확인한 뒤 이동하세요.')); return; }
      if (which === 'nativeTools') {
        try {
          if (!frame.contentWindow.kinViewerFocusNativeToolbar?.()) { kinWrite(status, kinSay('기본 영상 도구 연결을 확인한 뒤 이동하세요.')); return; }
          closeList();
        } catch (_) { kinWrite(status, kinSay('기본 영상 도구 연결을 확인한 뒤 이동하세요.')); }
        return;
      }
      let tool = null;
      if (which === 'tools') {
        try { tool = frame.contentDocument?.querySelector('#kin-workspace-dock nav button:not(:disabled)'); }
        catch (_) { kinWrite(status, kinSay('영상 도구 연결을 확인한 뒤 이동하세요.')); return; }
      }
      if (which === 'tools' && (!tool || !tool.getClientRects().length)) { kinWrite(status, kinSay('영상 도구 연결을 확인한 뒤 이동하세요.')); return; }
      closeList(); frame.focus(); frame.contentWindow.focus();
      if (tool) {
        // The dock's own entry: Tools reveals an auto-hidden panel also when the tab already had focus.
        const dock = tool.closest('#kin-workspace-dock');
        if (typeof dock?.focusTab === 'function') dock.focusTab(tool, { preventScroll: true }); else tool.focus({ preventScroll: true });
        tool.scrollIntoView({ block: 'nearest' });
      }
    } else {
      if (which === 'report') closeContext();
      const pane = $(which === 'prior' ? '.prior-report-pane' : '#findings');
      if (!pane || !pane.getClientRects().length) return;
      closeList();
      if (which === 'prior') pane.tabIndex = -1;
      pane.focus(); pane.scrollIntoView({ block: 'nearest' });
    }
  }
  function modalOpen(doc) {
    return [...doc.querySelectorAll('dialog[open],.modal.show,[role="dialog"][aria-modal="true"]')].some(el => el.getClientRects().length);
  }
  function keyboard(e, doc = document) {
    if (ended || !app.allowed() || e.defaultPrevented || e.repeat || e.isComposing || e.getModifierState('AltGraph') || modalOpen(document) || modalOpen(doc)) return;
    if (doc !== document && (!sameTarget() || !loaded || frame?.hidden || frame?.inert)) return;
    if (e.key === 'Escape' && doc === document && document.body.classList.contains('reading-list-open')) {
      e.preventDefault(); closeList(); list.focus(); return;
    }
    if (e.key === 'Escape' && doc === document && document.body.classList.contains('reading-context-open') && e.target.closest?.('#reading-context')) {
      e.preventDefault(); closeContext(); context.focus(); return;
    }
    const command = shortcuts.action(e);
    // Frame keydown cannot reach the page dispatcher; both use the same command gate.
    if(command==='finalize'){
      if(doc!==document&&window.KinReportCommands?.finalize?.()===true)e.preventDefault();
      return;
    }
    // Finalize & Next (Approve & Next) the same way: the page's own key goes to the page's dispatcher, the frame's is passed on.
    if(command==='finalizeNext'){
      if(doc!==document&&!window.KinReportCommands?.otherWriting?.(e.target)&&window.KinReportCommands?.finalizeNext?.()===true)e.preventDefault();
      return;
    }
    if (!active) {
      // List/report navigation is also useful before opening the integrated
      // viewer. Only focus a visible local pane; do not open or retarget images.
      if (doc === document && command === 'list') focusListSearch();
      const selector = {list:'#quick',report:'#findings',prior:'.prior-report-pane',context:'#clinical'}[command];
      const target = doc === document && selector && $(selector);
      if (!target || target.disabled || target.closest('[inert]') || !target.getClientRects().length) return;
      e.preventDefault();e.stopImmediatePropagation();
      if (command !== 'list') closeList();
      if (command === 'prior' || command === 'context') target.tabIndex = -1;
      target.focus({preventScroll:true});target.scrollIntoView({block:'nearest',inline:'nearest'});return;
    }
    // Capture precedes the embedded viewer's fixed legacy shortcuts. After a
    // remap, the old chord must not trigger a second, differently named action.
    if (!command) {
      if(doc!==document&&KinWorkspaceShortcuts.action(KinWorkspaceShortcuts.defaults,e)){e.preventDefault();e.stopImmediatePropagation();}
      return;
    }
    e.stopImmediatePropagation();
    const panes = { image:'image', prior:'prior', report:'report', context:'context', tools:'tools', nativeTools:'nativeTools' };
    if (command === 'list') {
      e.preventDefault(); document.body.classList.add('reading-list-open'); list.setAttribute('aria-expanded', 'true'); focusListSearch();
    } else if (panes[command]) {
      e.preventDefault(); focusPane(panes[command]);
    } else if (command === 'note') {
      e.preventDefault(); showNote();
    } else if (command === 'previous' || command === 'next') {
      // Do not turn editor cursor/IME gestures into a change of patient context.
      if (e.target.closest?.('input,textarea,select,[contenteditable]:not([contenteditable="false"]),[role="textbox"]')) return;
      e.preventDefault(); navigation();
      const b = command === 'previous' ? previous : next;
      if (!b.disabled) { b.focus(); b.click(); }
    }
  }
  const parentKeyboard = e => keyboard(e);
  document.addEventListener('keydown', parentKeyboard, true);
  function label(uid, image = false) {
    const s = image && shown?.viewingSet === viewingSet?.opening && viewingSetRow(uid) || app.study(uid);
    return s ? [s.name || s.patientName || '', s.patientId || s.id || '', s.date || '날짜 미확인', s.modality || '', s.desc || s.description || '', uid].filter(Boolean).join(' · ') : uid;
  }
  const sameTarget = () => shown?.reportUid === app.current();
  function noteWindow() {
    try {
      const w = frame?.contentWindow, url = new URL(w.location.href);
      if (url.origin !== window.location.origin || url.pathname !== '/ohif/viewer' ||
          url.searchParams.get('StudyInstanceUIDs') !== (shown.exam?.studyUids || [shown.uid, shown.prior].filter(Boolean)).join(',')) return null;
      return w;
    } catch (_) { return null; }
  }
  // Read-only view of the embedded viewer for Image Findings: no focus, layout or load side effect.
  function viewerTarget() {
    try {
      if (ended || !frame || !shown) return null;
      const w = frame.contentWindow, doc = w.document, url = new URL(w.location.href);
      if (url.origin !== window.location.origin || url.pathname !== '/ohif/viewer') return null;
      const studies = (url.searchParams.get('StudyInstanceUIDs') || '').split(',');
      const scoped = studies.join(',') === (shown.exam?.studyUids || [shown.uid, shown.prior].filter(Boolean)).join(',') &&
        (!shown.exam || !!w.KinViewerExamScope?.snapshot());
      return { frame, window: w, document: doc, href: url.href, studies, active, sameTarget: sameTarget(), loaded: loaded && scoped && !failed,
        inert: !!frame.inert, hidden: !!frame.hidden };
    } catch (_) { return null; }
  }
  function noteTarget() {
    try {
      const selected = noteWindow()?.kinViewerSelectedNoteTarget?.();
      return selected && (shown.exam?.studyUids || [shown.uid, shown.prior]).includes(selected.uid) && (shown.exam || app.study(selected.uid)) ? selected : null;
    } catch (_) { return null; }
  }
  function updateNote() {
    syncAutoNote();
    const selected = noteTarget();
    const unavailable = ended || !active || !app.allowed() || !frame || !sameTarget() || !loaded || frame.inert;
    note.disabled = unavailable || !selected;
    const w = noteWindow(), connection = w?.kinViewerNoteConnectionState?.();
    noteRetry.hidden = !['failed', 'loading'].includes(connection);
    noteRetry.disabled = unavailable || connection !== 'failed';
    kinWrite(noteRetry, connection === 'loading' ? kinSay('Connecting Note…') : kinSay('Reconnect Note'));
    if (noteRetryFocus && (!w || w !== noteRetryFocus || unavailable || connection !== 'loading')) {
      if (w === noteRetryFocus && !unavailable && connection === 'ready' &&
          (document.activeElement === noteRetry || document.activeElement === document.body)) (note.disabled ? imageFocus : note).focus({preventScroll:true});
      noteRetryFocus = null;
    }
    const label = (selected?.kind==='volume'?'Volume Tech Note':'Image Tech Note') + (!note.disabled ? ' · ' + app.noteLabel(selected.uid) : '');
    if (note.textContent !== label) note.textContent = label;
  }
  function reconnectNote() {
    updateNote(); if (noteRetry.disabled) return;
    const w = noteWindow();
    if (!w || typeof w.kinViewerNoteReconnect !== 'function') return;
    noteRetryFocus = document.activeElement === noteRetry ? w : null;
    w.kinViewerNoteReconnect(); updateNote();
  }
  function syncAutoNote() {
    const owner = !ended && app.allowed() && app.noteOwner();
    const key = owner ? 'kin-reading-note-auto:v1:' + owner : null;
    autoNote.disabled = !key;
    if (key === autoOwner) return;
    autoOwner = key; autoLast = null; autoNote.checked = false;
    try { if (key) autoNote.checked = localStorage.getItem(key) === 'true'; } catch (_) {}
  }
  function maybeAutoNote() {
    updateNote();
    const key = shown && JSON.stringify([epoch, shown.reportUid, shown.uid]);
    if (!autoNote.checked || note.disabled || autoLast === key) return;
    // Consume this connection even when editing: never surprise the user later.
    const selected = noteTarget();
    if (!selected) return;
    autoLast = key;
    const summary = app.hasNote(selected.uid);
    if (summary === undefined) { app.notice('메모 상태가 미확인입니다. 현재 영상 Tech 메모에서 확인하세요.'); return; }
    if (!summary) return;
    if (document.visibilityState !== 'visible' || modalOpen(document)) return;
    try {
      const doc = frame.contentDocument;
      const editing = el => el?.matches('textarea,select,input:not([type="checkbox"]):not([type="button"]):not([type="submit"]),[contenteditable]:not([contenteditable="false"]),[role="textbox"]');
      const state = viewerState();
      if (modalOpen(doc) || editing(document.activeElement) || editing(doc.activeElement) || state.busy || state.dirty) return;
    } catch (_) { return; }
    if (showNote()) autoLast = key;
  }
  function showNote() {
    updateNote(); if (note.disabled) return false;
    const selected = noteTarget();
    if (!selected) { app.notice('원본 검사가 확인되는 영상 칸을 선택하세요. 메모 대상을 확인할 수 없습니다.'); return false; }
    app.openNote(selected.uid); autoLast = JSON.stringify([epoch, shown.reportUid, shown.uid]); return true;
  }
  function redrawRetainedViewer() {
    const retained = frame;
    // A hidden iframe can keep its study/camera but lose its drawable canvas.
    // Ask the existing viewer to redraw after layout; never reload its document.
    requestAnimationFrame(() => {
      if (!active || ended || !loaded || retained !== frame || !sameTarget() || frame.hidden) return;
      try {
        const w = frame.contentWindow, viewports = w.services?.cornerstoneViewportService;
        w.dispatchEvent(new w.Event('resize'));
        // The viewer's own resize keeps each plane's zoom and pan relative to its new size. A bare engine
        // resize keeps the absolute camera instead: run while the image area changes size (a dock closing in
        // the same frame) and ahead of the viewer's queued resize, it left the planes 1.5x enlarged for good.
        if (typeof viewports?.performResize === 'function') viewports.performResize();
        else w.cornerstone?.getRenderingEngines?.().filter(engine => engine.id !== '_thumbnails')
          .forEach(engine => engine.resize(true, true));
      } catch (_) { /* Its loading/error state is handled by the document check. */ }
    });
  }
  function leave() { active = false; layout(); $('#m-reading').focus(); }
  function layout() {
    // 영상 작업공간에서는 목록 열이 접히므로 같은 Related Exam 목록을 판독문 위로 옮긴다.
    // 돌아오면 원래 워크리스트 아래 자리에 복원해 선택·행 이벤트를 그대로 유지한다.
    if (active && relatedList.parentNode !== relatedRegion) relatedRegion.insertBefore(relatedList, priorReport);
    else if (!active && relatedList.parentNode !== relatedListHome.parent)
      relatedListHome.parent.insertBefore(relatedList, relatedListHome.next);
    if (!active) cancelPanelDrag();
    const toggle=$('#m-reading');kinWrite(toggle, active?kinSay('Back to Worklist'):kinSay('Reading Workspace'));toggle.setAttribute('aria-pressed',String(active));kinWrite(toggle, active?kinSay('기존 목록 화면으로 돌아갑니다. 작성 중인 판독문과 영상 작업은 유지됩니다.'):kinSay('영상과 판독문을 함께 보는 작업공간을 엽니다.'), "title");
    // The native viewer observes its container size even while hidden. Preserve
    // that size off screen so returning from the list cannot produce a NaN camera.
    if(!active&&frame&&!host.hidden){const r=host.getBoundingClientRect();if(r.width>0&&r.height>0){host.style.setProperty('--kin-retained-width',r.width+'px');host.style.setProperty('--kin-retained-height',r.height+'px');}}
    host.classList.toggle('kin-retained-viewer',!active&&!!frame&&!!host.style.getPropertyValue('--kin-retained-width'));
    host.inert=!active;host.setAttribute('aria-hidden',String(!active));
    document.body.classList.toggle('reading', active); bar.hidden = host.hidden = reportTarget.hidden = !active;
    if (!active) {
      document.body.classList.remove('reading-list-open', 'reading-context-open');
      list.setAttribute('aria-expanded', 'false'); context.setAttribute('aria-expanded', 'false');
    }
    app.layout();
    renderPanels();
    if (frame) frame.hidden = !sameTarget();
    if (frame && !frame.hidden) redrawRetainedViewer();
    separate.disabled = !frame || !sameTarget() || !loaded;
    imageFocus.disabled = separate.disabled;
    updateNote();
  }
  function identify() {
    const uid = app.current();
    const identity = uid ? kinSay('판독 대상 · {0}', label(uid)) : kinSay('판독 대상을 선택하세요');
    kinWrite(target, identity);
    kinWrite(reportTarget, identity);
    kinWrite(info, shown && sameTarget() ? kinSay('영상 열람 · {0}{t1}', label(shown.uid, true), { t: shown.prior ? kinSay('\n비교 영상 · {0}', label(shown.prior, true)) : '' }) : '');
    separate.disabled = !frame || !sameTarget() || !loaded;
    imageFocus.disabled = separate.disabled;
    updateNote();
    navigation();
  }
  function viewerState() {
    if (!frame) return { busy: false, dirty: false };
    if (!loaded && frame.inert) return { busy: false, dirty: false };
    try {
      const w = frame.contentWindow;
      // A document still loading has no interactive viewer. Once a canvas exists,
      // missing guards are uncertainty, not permission to discard its state.
      const history = w.kinViewerHistoryWorkspaceState, jobs = w.kinViewerJobWorkspaceState;
      if (typeof history !== 'function' || typeof jobs !== 'function') {
        return { busy: !!w.document.querySelector('.cornerstone-canvas'), dirty: false };
      }
      const a = history(), b = jobs(); return { busy: a.busy || b.busy, dirty: a.dirty || b.dirty };
    } catch (_) {
      // A failed initial navigation can be Chromium's inaccessible error document.
      // It was inert throughout loading, so no user work could have been entered.
      return { busy: loaded, dirty: loaded };
    }
  }
  function request(uid, prior = null, series = null) {
    const valid = x => typeof x === 'string' && x.length <= 64 && /^\d+(?:\.\d+)+$/.test(x);
    if (!valid(uid) || prior !== null && !valid(prior) || series !== null && !valid(series) || !app.current()) {
      app.notice('검사·시리즈 정보를 확인할 수 없어 열지 않았습니다.'); return null;
    }
    if (!app.allowed()) { app.notice('현재 로그인과 검사 접근 상태를 확인한 뒤 영상을 여세요.'); return null; }
    // WORKLIST-SPLIT-UID: a new launch or replacement takes only studies the current list carries. A UID the list excluded
    // because two patient resources answer it is not one of them; the image gate refuses its sources on the server too.
    if (!app.study(uid) || prior && prior !== uid && !app.study(prior)) {
      app.notice('현재 목록에 없는 검사(환자 식별 불일치로 제외된 검사 포함)는 영상 작업공간에서 열지 않았습니다.'); return null;
    }
    let exam;
    try { const input=app.viewerInput?.(uid,prior); if(input?.scoped)exam=input; }
    catch(error) { app.notice(error.message); return null; }
    return { uid, prior: prior && prior !== uid ? prior : null, series, reportUid: app.current(), ...(exam?{exam}:{}) };
  }
  function url(r) {
    if (app.viewerInput) return window.KinExamScope.viewerUrl(r.viewingSet ? window.KinExamScope.originalInput([r.uid,r.prior].filter(Boolean)) : app.viewerInput(r.uid, r.prior, r.exam), r.series) +
      (r.job ? '&kinJob=' + encodeURIComponent(r.job) : '') + (r.viewingSet ? '#kin-w9=' + r.viewingSet : '');
    return '/ohif/viewer?StudyInstanceUIDs=' + encodeURIComponent(r.uid) + (r.prior ? ',' + encodeURIComponent(r.prior) + '&hangingProtocolId=@ohif/hpCompare' : '') +
      (r.series ? '&initialSeriesInstanceUID=' + encodeURIComponent(r.series) : '') + (r.job ? '&kinJob=' + encodeURIComponent(r.job) : '') +
      (r.viewingSet ? '#kin-w9=' + r.viewingSet : '');
  }
  /**
   * W9 (multi-study view): the 1/2 members its resolve just made ready, as this workspace's own input. A frozen member may
   * have left the list (a filter, a poll), so the fresh resolve metadata of exactly these UIDs labels them, for this opening
   * only. request()'s list check stays as it is for every other caller; the Reading Target, its report UID and every
   * dirty/busy/Frame Coverage guard of attempt() are unchanged. The opening id travels in the fragment for the viewer's
   * renderer observer.
   */
  function viewingSetRow(uid) {
    const m = viewingSet?.metadata.get(uid);
    return m ? { name: m.patientName, patientId: m.patientId, date: app.formatDate(m.studyDate), modality: m.modalities.join(','), desc: m.description } : null;
  }
  function openViewingSet(uid, prior, set) {
    const valid = x => typeof x === 'string' && x.length <= 64 && /^\d+(?:\.\d+)+$/.test(x);
    const refused = message => ({ status: 'refused', message });
    if (ended) return refused('영상 작업공간이 종료되었습니다. 판독문 초안을 저장한 뒤 화면을 새로고침하세요.');
    if (!valid(uid) || prior !== null && (!valid(prior) || prior === uid) || !(set?.metadata instanceof Map) ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(set.opening || '') ||
        !set.metadata.has(uid) || prior && !set.metadata.has(prior)) return refused('검사 정보를 확인할 수 없어 열지 않았습니다.');
    if (!app.current()) return refused('판독 대상을 선택하세요');
    if (!app.allowed()) return refused('현재 로그인과 검사 접근 상태를 확인한 뒤 영상을 여세요.');
    const before = viewingSet;
    viewingSet = { opening: set.opening, metadata: new Map([...set.metadata].filter(([key]) => key === uid || key === prior)) };
    const accepted = attempt({ uid, prior: prior || null, series: null, reportUid: app.current(), viewingSet: set.opening }, false);
    if (!accepted) { viewingSet = before; identify(); return refused(status.textContent || '영상 작업공간에서 열지 않았습니다.'); }
    const openedFrame = frame;
    return { status: 'accepted', isOpen: () => !ended && active && frame === openedFrame && sameTarget() && shown?.viewingSet === set.opening };
  }
  function refreshViewerDisplay() {
    try { frame?.contentWindow?.kinViewerStudyDisplay?.refreshAll(); } catch (_) {}
  }
  // The frame's viewer document holds a failed image read of a study it shows (series-recovery.js kinViewerFailedStudies):
  // the fixed OHIF reuses that failure for the document's life, so the same request opens a new frame.
  function frameFailed() {
    try {
      const w = frame?.contentWindow, failedUids = w?.kinViewerFailedStudies?.();
      const uids = (new URL(w.location.href).searchParams.get('StudyInstanceUIDs') || '').split(',');
      return Array.isArray(failedUids) && failedUids.some(uid => uids.includes(uid));
    } catch (_) { return false; }
  }
  function attempt(r, abandon) {
    if (ended) { app.notice('영상 작업공간이 종료되었습니다. 판독문 초안을 저장한 뒤 화면을 새로고침하세요.'); return false; }
    if (!r || r.reportUid !== app.current() || !app.allowed()) return false;
    pending = r; active = true; layout(); identify();
    if (frame && !failed && !frameFailed() && JSON.stringify(shown) === JSON.stringify(r)) {
      frame.hidden = false; recovery.hidden = true; pending = null; identify();
      // Shown again: the viewer reads again what it shows, so a Match or Unmatch since the frame opened shows.
      refreshViewerDisplay();
      return true;
    }
    const state = viewerState();
    if (state.busy || state.dirty && !abandon) {
      if (frame) frame.hidden = !sameTarget();
      kinWrite(status, state.busy ? kinSay('영상의 저장·복원 또는 상태 확인 중입니다. 작업을 확인한 뒤 다시 여세요.') : sameTarget() ? kinSay('현재 영상에 저장하지 않은 작업이 있습니다. 저장하거나 명시적으로 버린 뒤 다른 영상을 여세요.') : kinSay('이전 영상에 저장하지 않은 작업이 있습니다. 이전 검사로 돌아가 저장하거나, 명시적으로 버린 뒤 여세요.'));
      recovery.hidden = false; discard.hidden = !!state.busy; back.hidden = !shown || sameTarget(); retry.hidden = false; return false;
    }
    if (frame && loaded) {
      let accepted=false;
      try { accepted=frame.contentWindow.kinViewerFrameCoverageConfirm?.(message=>confirm(message))===true; } catch (_) {}
      if (!accepted) {
        frame.hidden=!sameTarget(); kinWrite(status, kinSay('이전 영상을 유지했습니다. Frame Coverage와 원본 영상을 확인하세요.'));
        recovery.hidden=false; discard.hidden=true; back.hidden=!shown||sameTarget(); retry.hidden=false; return false;
      }
      const checked=viewerState();
      if(r.reportUid!==app.current()||!app.allowed()||checked.busy||checked.dirty&&!abandon)return false;
    }
    const ticket = ++epoch; clearInterval(timer); timer = null;
    frame?.remove(); frame = node('iframe', '', host); frame.id = 'reading-frame'; kinWrite(frame, kinSay('영상 뷰어'), "title");
    frame.setAttribute('allow', 'fullscreen'); frame.referrerPolicy = 'no-referrer'; frame.inert = true;
    shown = r; loaded = false; failed = false; deadline = Date.now() + 45000; recovery.hidden = true; identify();
    kinWrite(status, kinSay('영상 작업공간을 불러오는 중…'));
    const currentFrame = frame;
    let observedDocument, observedHref;
    function check() {
      if (ended || ticket !== epoch || currentFrame !== frame) return;
      try {
        const w = frame.contentWindow;
        const location = new URL(w.location.href), doc = w.document;
        if (location.origin === window.location.origin && location.pathname === '/ohif/viewer' &&
            (doc !== observedDocument || location.href !== observedHref)) {
          loaded = false; frame.inert = true;
          const values = (location.searchParams.get('StudyInstanceUIDs') || '').split(',');
          const exam=location.searchParams.has('kinExamScopes')?w.KinViewerExamScope?.snapshot():null;
          if(location.searchParams.has('kinExamScopes')&&!exam)throw new Error('Unverified viewer scope');
          if (values.length < 1 || values.length > (exam?20:2) || values.some(x => !/^\d+(?:\.\d+)+$/.test(x) || x.length > 64) || new Set(values).size !== values.length) throw new Error('Invalid viewer scope');
          observedDocument = doc; observedHref = location.href; failed = false; deadline = Date.now() + 45000;
          shown = { uid: exam?.reportUid || values[0], prior: exam?.prior?.reportUid || (!exam&&values[1]) || null, series: location.searchParams.get('initialSeriesInstanceUID'), reportUid: r.reportUid, ...(exam?{exam}:{}) };
          const opening = new URLSearchParams(location.hash.slice(1)).get('kin-w9');
          if (opening) shown.viewingSet = opening;
          const job = location.searchParams.get('kinJob'); if (job) shown.job = job;
          if (sameTarget()) { kinWrite(status, kinSay('영상 작업공간을 불러오는 중…')); identify(); }
        }
        if (location.href === observedHref && doc.querySelector('.cornerstone-canvas') &&
            typeof w.kinViewerHistoryWorkspaceState === 'function' && typeof w.kinViewerJobWorkspaceState === 'function') {
          window.KinViewerWorkspaceDock?.(w,{owner:app.noteOwner,allowed:()=>!ended&&app.allowed()});
          // Keyboard events do not bubble out of an iframe. Bind each real
          // viewer document once, including documents replaced by job restore.
          if (!boundDocuments.has(doc)) {
            doc.addEventListener('keydown', e => keyboard(e, doc), true); boundDocuments.add(doc);
          }
          const keyMap=shortcuts.read();
          for(const [id,selector] of Object.entries({image:'#kin-viewer-focus-2',report:'#kin-viewer-focus-4',tools:'#kin-viewer-focus-7',nativeTools:'#kin-viewer-focus-9',note:'#kin-viewer-note-open'})){const button=doc.querySelector(selector);if(keyMap[id])button?.setAttribute('aria-keyshortcuts',KinWorkspaceShortcuts.display(keyMap[id]));else button?.removeAttribute('aria-keyshortcuts');}
          const toolHint=doc.querySelector('#kin-viewer-tool-focus > p');
          if(toolHint){const key=id=>KinWorkspaceShortcuts.display(keyMap[id]);const viewerWords=doc.defaultView&&doc.defaultView.KinLanguage;toolHint.textContent=viewerWords&&viewerWords.text?viewerWords.text("{0} 측정 도구 · Control+Alt+8 비교 작업 도구 · {1} 기본 영상 도구 (Tab 이동·Enter 선택) · {2} 선택 영상 · {3} 판독문으로", key('tools'), key('nativeTools'), key('image'), key('report')):key('tools')+' 측정 도구 · Control+Alt+8 비교 작업 도구 · '+key('nativeTools')+' 기본 영상 도구 (Tab 이동·Enter 선택) · '+key('image')+' 선택 영상 · '+key('report')+' 판독문으로';}
          if (!loaded) {
            loaded = true; failed = false; frame.inert = false;
            if (sameTarget()) { pending = null; recovery.hidden = true; kinWrite(status, kinSay('영상 작업공간 연결됨')); identify(); }
          }
          // Display preferences also apply to a retained hidden viewer. Clinical
          // actions keep the active/current/visible checks in allowed().
          w.kinViewerEnablePatientCopy?.({owner:app.noteOwner,allowed:()=>!ended&&app.allowed()&&active&&sameTarget()&&currentFrame===frame&&!frame.hidden&&!frame.inert&&!modalOpen(document),toolbarAllowed:()=>!ended&&app.allowed()&&currentFrame===frame});
          maybeAutoNote();
          return;
        }
      } catch (_) {}
      if (!loaded && !failed && Date.now() > deadline) {
        failed = true;
        if (!sameTarget()) return;
        kinWrite(status, kinSay('영상 작업공간을 확인하지 못했습니다. 로그인·연결 상태를 확인하고 다시 여세요.'));
        pending = shown; recovery.hidden = false; back.hidden = discard.hidden = true; retry.hidden = false;
      }
    }
    const onLoad = () => {
      if (ended || ticket !== epoch || currentFrame !== frame) return;
      loaded = false; failed = false; frame.inert = true; deadline = Date.now() + 45000; observedDocument = undefined; observedHref = undefined;
      if (sameTarget()) { info.textContent = ''; kinWrite(status, kinSay('영상 작업공간을 불러오는 중…')); separate.disabled = true; }
      check();
    };
    renewFrame=()=>{frame.onload=guarded(onLoad);clearInterval(timer);timer=setInterval(guarded(check),250);};
    frame.src = url(r); renewFrame();
    return true;
  }
  function open(uid, prior = null, series = null) { return attempt(request(uid, prior, series), false); }
  function resume(uid, prior = null) { return shown?.reportUid === app.current() && !failed ? attempt(shown, false) : open(uid, prior); }
  function openJob(uid,job) {
    const ids=job?.snapshot?.studies;
    if(job?.studyUid!==uid||!Array.isArray(ids)||ids[0]!==uid||ids.length<1||ids.length>2||typeof job.id!=='string'||!/^([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i.test(job.id)){app.notice('저장 보기의 검사 정보를 확인할 수 없습니다.');return false;}
    const r=request(uid,ids[1]??null);if(!r)return false;r.job=job.id;return attempt(r,false);
  }
  function selectionChanged(deferOpen = false) {
    identify(); const uid = app.current(), changed = uid !== lastSelection; lastSelection = uid;
    if (!active || ended || !changed) return;
    if (frame) frame.hidden = !sameTarget();
    document.body.classList.remove('reading-list-open'); list.setAttribute('aria-expanded', 'false');
    if (shown?.reportUid === uid && frame) {
      frame.hidden = false;
      if (!failed && app.allowed()) refreshViewerDisplay();
      redrawRetainedViewer();
      if (!failed) { pending = null; recovery.hidden = true; kinWrite(status, loaded ? kinSay('기존 영상 작업으로 돌아왔습니다.') : kinSay('영상 작업공간을 불러오는 중…')); }
      identify(); return;
    }
    if (uid && !deferOpen) open(uid, app.prior(uid));
    else { pending = null; recovery.hidden = true; kinWrite(status, kinSay('판독 대상을 선택하세요')); }
  }
  // Session invalidation must hide the embedded document even if its own request
  // has not yet noticed the expired account. Never reconnect it from a late load.
  function end() { ended = true; cancelPanelDrag(); unwatchPanels(); window.removeEventListener('resize', panelWindowResize); shortcuts.end(); epoch++; returnChannel?.close();returnChannel=null;clearInterval(timer); timer = null; queueObserver.disconnect(); document.removeEventListener('keydown', parentKeyboard, true); frame?.remove(); frame = null; shown = pending = null; loaded = false; active = false; layout(); identify(); }
  work.onInvalidate(event=>{
    if(event.reason==='lifecycle'&&!['active','preparing'].includes(event.state)){end();return;}
    if(event.reason==='prepare'){cancelPanelDrag();clearInterval(timer);unwatchPanels();queueObserver.disconnect();}
    if(event.reason==='cancel'||event.reason==='lifecycle'&&event.state==='active'){
      queueObserver.disconnect();
      watchPanels();
      queueObserver=new MutationObserver(guarded(navigation));queueObserver.observe($('#rows'),{childList:true});
      window.removeEventListener('resize',panelWindowResize);panelWindowResize=guarded(()=>{if(panelDrag)cancelPanelDrag();if(active&&!ended)renderPanels();});window.addEventListener('resize',panelWindowResize);
      renewFrame();renewReturn();
    }
  });
  window.addEventListener('pagehide',end);
  window.addEventListener('beforeunload', e => { const s = viewerState(); let warn=false;try{warn=frame?.contentWindow.kinViewerFrameCoverageState?.().warn;}catch(_){}if (s.busy || s.dirty || warn) { e.preventDefault(); e.returnValue = ''; } });
  return { open, openJob, openViewingSet, resume, exit: leave, selectionChanged, refreshNote: updateNote, active: () => active, end, snapshotPanels, applyPanels, viewerTarget,
    preferences: { host: nav, read: () => autoNote.checked, generation: () => preferenceGeneration,
      apply: value => { syncAutoNote(); if (autoNote.disabled) return false; autoNote.checked = value; autoNote.onchange(); return true; } } };
};
