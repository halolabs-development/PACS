

    // ── 패널 크기 조절 ──
    let workspaceDragCancel = null;
    function workspaceEditable() {
      return !workspaceEnded && work.state() === 'active' && workspaceOwner === KinWorkspaceLayout.key(KinAuth.session());
    }
    function bindPanelResize(selector, axis, resize) {
      const handle = $(selector);
      handle.tabIndex = 0;
      handle.addEventListener('keydown', e => {
        if (!workspaceEditable() || e.isComposing || e.keyCode === 229) return;
        const direction = typeof axis === 'function' ? axis() : axis;
        const keys = direction === 'x' ? ['ArrowLeft', 'ArrowRight'] : ['ArrowUp', 'ArrowDown'];
        if (![...keys, 'Home', 'End'].includes(e.key)) return;
        e.preventDefault();
        const box = handle.getBoundingClientRect(), step = e.shiftKey ? 40 : 10;
        const delta = e.key === 'Home' ? -16384 : e.key === 'End' ? 16384 : e.key === keys[0] ? -step : step;
        resize({ clientX: box.left + (direction === 'x' ? delta : 0), clientY: box.top + (direction === 'y' ? delta : 0) }, direction, delta);
        rememberPanelSize(selector);
      });
      handle.addEventListener("pointerdown", e => {
        if (e.button !== 0 || !workspaceEditable()) return;
        workspaceDragCancel?.();
        const at = work.capture('document');
        workspaceGeneration++;
        e.preventDefault();
        const dragAxis = typeof axis === "function" ? axis() : axis;
        handle.setPointerCapture(e.pointerId);
        handle.classList.add("dragging");
        document.body.classList.add("resizing", dragAxis === "x" ? "resizing-x" : "resizing-y");

        let previous = dragAxis === 'x' ? e.clientX : e.clientY;
        const move = event => {
          if (event.pointerId !== e.pointerId) return;
          const position = dragAxis === 'x' ? event.clientX : event.clientY, delta = position - previous;
          previous = position;
          work.commit(at, () => resize(event, dragAxis, delta));
        };
        const end = event => {
          if (event.pointerId !== e.pointerId) return;
          handle.removeEventListener("pointermove", move);
          handle.removeEventListener("pointerup", end);
          handle.removeEventListener("pointercancel", end);
          handle.classList.remove("dragging");
          document.body.classList.remove("resizing", "resizing-x", "resizing-y");
          if (handle.hasPointerCapture(e.pointerId)) handle.releasePointerCapture(e.pointerId);
          workspaceDragCancel = null;
          work.commit(at, () => {
            if (event.type === "pointerup") rememberPanelSize(selector);
            else applyLayout();
          });
        };
        workspaceDragCancel = () => end({ pointerId: e.pointerId, type: 'pointercancel' });
        handle.addEventListener("pointermove", move);
        handle.addEventListener("pointerup", end);
        handle.addEventListener("pointercancel", end);
      });
    }
    const clampPanel = (value, min, max) => Math.max(min, Math.min(max, value));
    let workspaceOwner = null, workspaceStorage = null, workspaceGeneration = 0;
    // 이 브라우저에 배치를 남겼는가(마지막 쓰기·읽기의 결과). 계정 배치를 확인하지 못했을 때 "이 브라우저에서 계속 쓴다"고
    // 말해도 되는지를 이것이 정한다 — 남기지 못했으면 새로고침하면 사라진다고 말한다(workspace-roaming.js).
    let workspaceLocalKept = true;
    // The v3 tab belongs to this login. A layout saved by an earlier login may
    // restore sizes, but must not replace the pilot's initial Info tab.
    const studyPanelSessionKey = () => workspaceOwner ? 'kin-study-panel-session:' + workspaceOwner : null;
    function rememberStudyPanelSession() {
      try {
        const key = studyPanelSessionKey();
        if (key && work.session()) workspaceStorage?.setItem(key, work.session());
      } catch (_) { /* Unavailable storage keeps the current document's tab. */ }
    }
    // fromStudyPanel: a choice made in the open Study Panel (its tab, size, Text Size, Default; W3R7-04). The toolbar
    // status line is not rewritten for it: in narrower windows that line wraps when its text grows, and the list,
    // Related and report below would move under the reader's hand. A success is quiet; a failed save, and the first
    // success after one, is said in the panel itself, which lies over the page. Other layout saves keep the toolbar
    // line (the Rail/Layout wrap is a separate toolbar matter).
    function saveWorkspace(fromStudyPanel = false) {
      if (!workspaceEditable()) return;
      workspaceGeneration++;
      workspaceState.mode = layoutMode;
      workspaceState = KinWorkspaceLayout.toVersion3(KinWorkspaceLayout.withReading(workspaceState, readingWorkspace.snapshotPanels()));
      const saved = KinWorkspaceLayout.write(workspaceStorage, workspaceOwner, workspaceState);
      if (saved) rememberStudyPanelSession();
      const kept = workspaceLocalKept;
      workspaceLocalKept = !!saved;
      const said = saved ? kinSayEn("배치 저장됨 · 이 브라우저") : kinSayEn("배치 저장 안 됨 · 이 창에서만 유지");
      if (!fromStudyPanel) kinWrite($("#layout-status"), said);
      // The notice of the panel takes words (study-panel.js setNotice): the sentence in the language of now.
      else if (!saved || !kept) studyPanel?.setNotice(String(said));
    }
    function rememberPanelSize(selector) {
      if (!workspaceEditable()) return;
      workspaceState = KinWorkspaceLayout.toVersion3(workspaceState);
      if (selector === '#resize-rail') {
        workspaceState.workspace.rail = Math.round($('#worklist-folders-panel').getBoundingClientRect().width);
        saveWorkspace(); return;
      }
      const targets = { "#resize-main": ["main", ".left"], "#resize-top": ["top", ".rw"],
        "#resize-related": ["related", ".related-p"], "#resize-left-split": ["prior", ".related-list-pane"] };
      const [name, panel] = targets[selector];
      // Related Report and Report Editor are stacked in every layout, so the related size is always a height.
      const dimension = !portraitLayout() && name === "main" ? "width" : "height";
      workspaceState[workspaceAxis()][name] = Math.round($(panel).getBoundingClientRect()[dimension]);
      saveWorkspace();
    }
    function restoreWorkspace() {
      workspaceOwner = KinWorkspaceLayout.key(sess);
      try { workspaceStorage = localStorage; } catch (_) { workspaceStorage = null; }
      const result = KinWorkspaceLayout.read(workspaceStorage, workspaceOwner);
      // Restore legacy display state as it was saved. Adopt v3 only on an
      // explicit edit/open/save, so new geometry cannot affect the first paint.
      workspaceState = result.state;
      // First use (nothing saved yet): start with Clinical Information only. Thumbnail, AI Report, Image Report and
      // Reading Template stay one click away in Panels; a saved choice always wins and nothing is saved by this line.
      // A layout saved before this default existed is switched once per browser (flag below); after that the reader's own
      // Panels choice, including Show All Panels, is kept.
      let applyOnce = false;
      try { applyOnce = localStorage.getItem('kin-clinical-only-default') !== '1'; localStorage.setItem('kin-clinical-only-default', '1'); } catch (_) {}
      if (['empty', 'disabled'].includes(result.status) || applyOnce) {
        const initial = KinWorkspaceLayout.withHiddenPanels(workspaceState, [...new Set([...KinWorkspaceLayout.hiddenPanels(workspaceState), 'thumbnail', 'aiReport', 'imageReport', 'template'])]);
        if (initial) workspaceState = initial;
      }
      if (workspaceState.workspace) {
        let sameSession = false;
        try { sameSession = !!work.session() && workspaceStorage?.getItem(studyPanelSessionKey()) === work.session(); } catch (_) {}
        if (!sameSession) workspaceState.workspace.studyPanelTab = 'info';
      }
      workspaceLocalKept = !["disabled", "unavailable"].includes(result.status);
      layoutMode = workspaceState.mode;
      readingWorkspace.applyPanels(workspaceState.reading || KinReadingPanelLayout.defaults());
      kinWrite($("#layout-status"), kinSay(({ restored: "배치 복원됨 · 이 브라우저", empty: "배치 · 이 브라우저",
        disabled: "배치 · 이 창에서만 유지", invalid: "저장된 배치 오류 · 기본 배치", unavailable: "배치 저장소 사용 불가 · 기본 배치" })[result.status]));
      applyLayout();
    }
    $("#layout-toggle").addEventListener("click", () => {
      if (!workspaceEditable()) return;
      layoutMode = layoutMode === "auto" ? "portrait" : layoutMode === "portrait" ? "landscape" : "auto";
      applyLayout();
      saveWorkspace();
    });
    $("#layout-reset").addEventListener("click", () => {
      if (!workspaceEditable()) return;
      workspaceGeneration++;
      const removed = KinWorkspaceLayout.remove(workspaceStorage, workspaceOwner);
      workspaceLocalKept = !!removed;
      workspaceState = KinWorkspaceLayout.toVersion3(KinWorkspaceLayout.defaults()); layoutMode = "auto";
      workspaceState = KinWorkspaceLayout.withHiddenPanels(workspaceState, ['thumbnail', 'aiReport', 'imageReport', 'template']) || workspaceState;
      readingWorkspace.applyPanels(KinReadingPanelLayout.defaults());
      applyLayout();
      kinWrite($("#layout-status"), removed ? kinSayEn("기본 배치 · 이 브라우저") : kinSayEn("초기화 저장 안 됨 · 이 창에서만 유지"));
    });
    window.addEventListener("resize", applyLayout);
    /**
     * 작업 영역은 창 크기가 그대로여도 줄고 는다: 열린 툴바 메뉴(View 묶음)는 흐름 안에서 툴바의 둘째 줄이 되고, 알림 줄이
     * 생기고, 글이 줄바꿈된다. applyLayout은 저장한 크기를 그때의 공간 안으로 깎아 적용하고 깎은 값을 저장하지 않으므로, 공간이
     * 돌아오면 저장한 크기를 다시 적용해야 한다 — 그러지 않으면 메뉴를 연 채 불러온 Related 목록이 창 크기를 바꿀 때까지 깎인
     * 높이로 남는다(roam_01). 크기가 바뀐 프레임마다 한 번, 끌기 중에는 하지 않는다(끌기의 끝이 적용하거나 저장한다).
     * `.split`의 크기는 applyLayout이 바꾸는 자식 크기와 무관하다 — 되먹임이 없다.
     * 작업 영역이 문서에서 빠지면(가입 승인 대기·계정 설정 화면이 body를 바꾼다) 관찰은 크기 0을 한 번 알린다 — 배치할 곳이 없으니
     * 아무것도 하지 않는다.
     */
    const workArea = $(".split");
    let splitFrame = 0, splitSize = "";
    const workspaceObservedSizes = new WeakMap();
    const workspaceObserver = new ResizeObserver(entries => {
      if (workspaceEnded || !workArea.isConnected) return;
      const at = work.capture('document');
      let changed = false;
      for (const entry of entries) {
        const box = entry.target.getBoundingClientRect(), size = box.width + 'x' + box.height;
        if (entry.target === workArea) {
          if (splitSize !== size) changed = true;
          splitSize = size;
        } else {
          if (workspaceObservedSizes.get(entry.target) !== size) changed = true;
          workspaceObservedSizes.set(entry.target, size);
        }
      }
      if (changed) scheduleWorkspaceLayout(at);
    });
    // One layout pass before the next paint, coalesced with any pending one.
    function scheduleWorkspaceLayout(at = work.capture('document')) {
      if (workspaceEnded || splitFrame) return;
      splitFrame = requestAnimationFrame(() => {
        splitFrame = 0;
        work.commit(at, () => {
          if (!workspaceEnded && workArea.isConnected && !document.body.classList.contains("resizing")) applyLayout();
        });
      });
    }
    workspaceObserver.observe(workArea);
    // A notice, wrapped filter or list control changes a row floor even in a
    // fixed window, and so do the first rendered rows.
    for (const node of [...$('.related-list-pane').children, $('#relrows'), $('.left > .grid thead'), $('#rows'),
      ...[...$('.left').children].filter(child => !child.matches('.grid, #worklist-folders-panel'))]) workspaceObserver.observe(node);
    // ── Panel Settings (Minhoon 2026-10-27 item 9) ──
    // Which report window panels stay on screen. Kept in the same layout record as the rail and panel sizes, so
    // Account Layout carries it to another browser and Reset Layout shows every panel again. Display only: the panels
    // and their content stay in the document. AI Report remains a placeholder; Image Report shows the drawings attached
    // to the selected study's report (image-report.js) and is a Radiology column only.
    const panelDialog = document.createElement('dialog');
    panelDialog.id = 'panel-settings-dialog'; panelDialog.setAttribute('aria-labelledby', 'panel-settings-title');
    panelDialog.innerHTML = `<h2 id="panel-settings-title">Panel Settings</h2>
      <p>판독 창 위쪽 패널을 보이거나 숨깁니다. 숨긴 패널의 자리는 옆 패널과 관련 검사·판독문 영역이 씁니다.
      Study Panel과 판독 화면의 검사 정보 열기에서는 모든 패널을 볼 수 있습니다.</p>
      <fieldset><legend>Show Panels</legend>${[['thumbnail', 'Thumbnail'], ['aiReport', 'AI Report'], ['imageReport', 'Image Report'],
        ['clinical', 'Clinical Information'], ['template', 'Reading Template']].map(([key, label]) =>
        `<label${key === 'aiReport' ? ' title="추후 구현 탭입니다. 표시 여부만 정합니다."' : ''}><input type="checkbox" data-panel="${key}"> ${label}</label>`).join('')}</fieldset>
      <p>이 브라우저에 계정별로 기억합니다. 다른 기기에서는 View &gt; Account Layout으로 계정에 저장하고 불러오세요.</p>
      <p id="panel-settings-status" role="status"></p>
      <footer><button type="button" id="box-arrange-open"></button><button type="button" id="panel-settings-show-all">Show All Panels</button><button type="button" id="panel-settings-close">Close</button></footer>`;
    document.body.append(panelDialog);
    window.KinLanguage?.markup?.(panelDialog);
    // Arrange Boxes is written as a product sentence (the dialog is built after the page's first markup was read).
    kinWrite($('#box-arrange-open'), kinSay('Arrange Boxes'));
    kinWrite($('#box-arrange-open'), kinSay('Worklist·Related Exam·Clinical Information·Related Report·Report Editor 상자를 끌어 서로 자리를 바꿉니다.'), 'title');
    const hiddenPanelsNow = () => workspaceState.workspace?.hiddenPanels?.slice() || [];
    function renderPanelSettings() {
      const hidden = hiddenPanelsNow(), editable = workspaceEditable();
      for (const input of panelDialog.querySelectorAll('input[data-panel]')) { input.checked = !hidden.includes(input.dataset.panel); input.disabled = !editable; }
      $('#panel-settings-show-all').disabled = !editable || !hidden.length;
    }
    function choosePanels(hidden) {
      if (!workspaceEditable()) { renderPanelSettings(); return; }
      const next = KinWorkspaceLayout.withHiddenPanels(workspaceState, KinWorkspaceLayout.PANELS.filter(key => hidden.includes(key)));
      if (!next) { kinWrite($('#panel-settings-status'), kinSayEn("패널 설정을 확인할 수 없습니다. Reset Layout으로 기본 배치를 사용할 수 있습니다.")); return; }
      // The dialog says the outcome itself: rewriting the toolbar status line would wrap it in narrow windows and move
      // the list and the work area under the reader (W3R7-04, as for Study Panel choices).
      workspaceState = next; applyLayout(); saveWorkspace(true); renderPanelSettings();
      kinWrite($('#panel-settings-status'), workspaceLocalKept ? kinSayEn("패널 표시를 기억했습니다 · 이 브라우저") : kinSayEn("패널 표시를 이 창에만 적용했습니다. 브라우저에 저장하지 못했습니다."));
    }
    panelDialog.querySelector('fieldset').addEventListener('change', event => {
      const input = event.target.closest('input[data-panel]'); if (!input) return;
      const hidden = hiddenPanelsNow().filter(key => key !== input.dataset.panel);
      choosePanels(input.checked ? hidden : [...hidden, input.dataset.panel]);
    });
    $('#panel-settings-show-all').addEventListener('click', () => choosePanels([]));
    $('#panel-settings-close').addEventListener('click', () => panelDialog.close());
    // Arrange Boxes (below) closes this dialog and takes the focus to its first box itself.
    panelDialog.addEventListener('close', () => { const opener = $('#panel-settings-open'); if (!opener.disabled && !arranging) opener.focus({ preventScroll: true }); });
    $('#panel-settings-open').addEventListener('click', () => {
      if (!workspaceEditable() || panelDialog.open) return;
      $('#panel-settings-status').textContent = ''; renderPanelSettings(); panelDialog.showModal();
      panelDialog.querySelector('input[data-panel]').focus();
    });
    // ── Folding a band panel in place (Minhoon 2026-10-27 item 9: "Make these panels independently collapsible",
    // "Remember each user's visibility and expanded/collapsed preferences") ──
    // Separate from Show/Hide above: a folded panel keeps its name on the band (the folded-panels row) and opens again
    // in its place with one press; hiding takes it off the band. Both are kept in the same layout record (sparse
    // collapsedPanels next to hiddenPanels), so this browser keeps them per account, Account Layout carries them, and
    // Reset Layout opens every panel. applyLayout() draws the band from both (reportWindow).
    const PANEL_LABEL = { thumbnail: 'Thumbnail', aiReport: 'AI Report', imageReport: 'Image Report',
      clinical: 'Clinical Information', template: 'Reading Template' };
    // A fold is saved quietly, as Panel Settings and Study Panel choices are: rewriting the toolbar status line would
    // wrap it in narrower windows and move the list and the work area under the reader (W3R7-04). A fold the browser
    // could not keep is said once, until a fold is kept again.
    let foldUnsavedSaid = false;
    function foldPanel(key, fold) {
      if (!workspaceEditable() || !KinWorkspaceLayout.PANELS.includes(key)) return;
      const others = KinWorkspaceLayout.collapsedPanels(workspaceState).filter(k => k !== key);
      const next = KinWorkspaceLayout.withCollapsedPanels(workspaceState, fold ? [...others, key] : others);
      if (!next) { toast(kinSay('배치를 확인할 수 없습니다. Reset Layout으로 기본 배치를 사용할 수 있습니다.'), 'err'); return; }
      workspaceState = next; applyLayout(); saveWorkspace(true);
      if (workspaceLocalKept) foldUnsavedSaid = false;
      else if (!foldUnsavedSaid) { foldUnsavedSaid = true; toast(kinSay('패널 접기를 브라우저에 저장하지 못해 이 창에서만 유지됩니다.'), 'err'); }
      // The pressed button is gone with the panel's new state: the focus goes to the same panel's other button.
      const target = $(fold ? `.rw > .rw-folds > [data-unfold="${key}"]` : `.rw [data-fold="${key}"]`);
      if (target?.getClientRects().length) target.focus({ preventScroll: true });
    }
    $('.rw').addEventListener('click', event => {
      const button = event.target.closest('.rw [data-fold], .rw [data-unfold]');
      if (!button || button.closest('#study-panel-host') || document.body.classList.contains('reading')) return;
      if (button.dataset.fold) foldPanel(button.dataset.fold, true); else foldPanel(button.dataset.unfold, false);
    });
    /**
     * The five band panels in the item-9 order, for later work on this page (read here, never from the record or the
     * classes): key, label, `shown` (not hidden in Panel Settings) and `expanded` (not folded) as the reader chose
     * them, `onScreen` (the panel's content, or its name in the folded-panels row, is drawn on the band now — not in
     * the Reading Workspace, not lent to the Study Panel drawer, not outside the workflow mode) and its rectangle.
     */
    function workspacePanels() {
      const states = KinWorkspaceLayout.panelStates(workspaceState), reading = document.body.classList.contains('reading');
      const content = { thumbnail: '.rw > .s-thumb > .thumbwrap', aiReport: '.rw > .s-thumb > .rtabs > [data-panel="aiReport"]',
        imageReport: '.rw > .s-imgreport', clinical: '.rw > .s-clinical', template: '.rw > .s-template' };
      const drawn = node => !!node?.isConnected && node.getClientRects().length > 0;
      return KinWorkspaceLayout.PANELS.map(key => {
        const body = $(content[key]), name = $(`.rw > .rw-folds > [data-unfold="${key}"]`);
        const at = drawn(body) ? body : drawn(name) ? name : null;
        return { key, label: PANEL_LABEL[key], ...states[key], onScreen: !reading && !!at, rect: at ? at.getBoundingClientRect() : null };
      });
    }
    // ── Arrange Boxes, from Panel Settings (studio 2026-11-01: "Allow me to drop and drag these boxes so I can configure it the way I want to") ──
    // The five boxes trade places inside the page's current structure (box-layout.js): the swaps are kept in the same
    // layout record as the panel sizes, so this browser keeps them per account, Account Layout carries them to another
    // browser and Reset Layout puts every box home. The boxes never change parents: only their order does.
    const BOX_LABEL = { worklist: 'Worklist', relatedExams: 'Related Exam', clinical: 'Clinical Information',
      relatedReports: 'Related Report', editor: 'Report Editor' };
    const boxSwapsNow = () => KinWorkspaceLayout.boxSwaps(workspaceState);
    function boxRect(nodes, clips) {
      let top = Infinity, left = Infinity, right = -Infinity, bottom = -Infinity;
      for (const node of nodes) {
        if (!node?.isConnected || !node.getClientRects().length) continue;
        const r = node.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) continue;
        top = Math.min(top, r.top); left = Math.min(left, r.left); right = Math.max(right, r.right); bottom = Math.max(bottom, r.bottom);
      }
      if (top === Infinity) return { rect: null, visible: null };
      const rect = { x: left, y: top, width: right - left, height: bottom - top };
      for (const clip of [...clips, $('.split')]) {
        if (!clip?.getClientRects().length) continue;
        const c = clip.getBoundingClientRect();
        top = Math.max(top, c.top); left = Math.max(left, c.left); right = Math.min(right, c.right); bottom = Math.min(bottom, c.bottom);
      }
      top = Math.max(top, 0); left = Math.max(left, 0); right = Math.min(right, innerWidth); bottom = Math.min(bottom, innerHeight);
      return { rect, visible: right - left > 0 && bottom - top > 0 ? { x: left, y: top, width: right - left, height: bottom - top } : null };
    }
    /**
     * Where each of the five boxes is now, in screen order (later work on this page reads the boxes here, never from
     * their parents): key, label, the elements that make the box, its column ('A' = the list column, 'B' = the report
     * column) and side ('first' = left/top of the page), its place inside the column, its whole rectangle and the part
     * of it on screen. `shown` is false where the box is not on this screen (the Reading Workspace keeps its own
     * arrangement; Clinical Information hidden in Panels or lent to the Study Panel; a box scrolled out of view).
     */
    function workspaceBoxes() {
      const arrangement = KinBoxLayout.arrangement(boxSwapsNow()), tech = mode === 'Technician';
      const reading = document.body.classList.contains('reading');
      const parts = {
        worklist: [...$('.left').children].filter(n => !n.matches('#worklist-folders-panel, #resize-left-split, .related-list-pane, #routing-factors')),
        relatedExams: [$('.related-list-pane')],
        clinical: [$('.right > .rw')],
        relatedReports: [$('.related-p')],
        editor: [$(tech ? '.order-p' : '.report-p')],
      };
      const clips = { worklist: ['.left'], relatedExams: ['.left'], clinical: ['.right'], relatedReports: ['.workrow', '.right'], editor: ['.workrow', '.right'] };
      return arrangement.order.map(key => {
        const { rect, visible } = boxRect(parts[key], clips[key].map(s => $(s)));
        // The Clinical Information box is the band. It is away while the Clinical panel is hidden in Panel Settings or
        // lent to the Study Panel drawer; folded, the band stays this box and `visible` (the band's part on screen) decides.
        const clinicalAway = key === 'clinical' && (() => {
          const section = $('.s-clinical'), chosen = KinWorkspaceLayout.panelStates(workspaceState).clinical;
          return !section?.closest('.right > .rw') || !chosen.shown || (chosen.expanded && !section.getClientRects().length);
        })();
        return { key, label: key === 'editor' && tech ? 'Order List' : BOX_LABEL[key], elements: parts[key],
          ...arrangement.positions[key], rect, visible, shown: !reading && !clinicalAway && !!visible };
      });
    }
    // What a drop of `from` on `to` would do, said before the drop (pointer and keyboard alike).
    function boxOutcome(from, to) {
      const pair = KinBoxLayout.swapFor(from, to), on = boxSwapsNow(), tech = mode === 'Technician';
      if (!pair) return '같은 상자입니다. 놓아도 바뀌지 않습니다.';
      if (pair === 'list') return '놓으면 Worklist와 Related Exam이 자리를 바꿉니다.';
      if (pair === 'report') return tech ? '놓으면 Related Report와 Order List가 자리를 바꿉니다.' : '놓으면 Related Report와 Report Editor가 자리를 바꿉니다.';
      if (pair === 'side') return on.includes('side') ? '놓으면 Clinical Information 띠가 판독 열의 맨 위로 갑니다.' : '놓으면 Clinical Information 띠가 판독 열의 맨 아래로 갑니다.';
      const away = !on.includes('columns');
      if (portraitLayout()) return away ? '놓으면 두 열이 바뀝니다: 목록 열(Worklist·Related Exam)이 아래로, 판독 열이 위로 갑니다.'
        : '놓으면 두 열이 바뀝니다: 목록 열(Worklist·Related Exam)이 위로, 판독 열이 아래로 갑니다.';
      return away ? '놓으면 두 열이 바뀝니다: 목록 열(Worklist·Related Exam)이 오른쪽으로, 판독 열이 왼쪽으로 갑니다.'
        : '놓으면 두 열이 바뀝니다: 목록 열(Worklist·Related Exam)이 왼쪽으로, 판독 열이 오른쪽으로 갑니다.';
    }
    const arrangeBar = document.createElement('div');
    arrangeBar.id = 'box-arrange-bar'; arrangeBar.hidden = true;
    arrangeBar.setAttribute('role', 'region');
    // The bar is built after the page's first markup was read for the screen language, so each fixed caption is
    // written as a product sentence (kinSay) and follows the language the reader chose.
    arrangeBar.innerHTML = `<p id="box-arrange-help" lang="ko"></p>
      <span id="box-arrange-status" role="status" aria-live="polite" lang="ko"></span>
      <button type="button" class="chip" data-box-swap="columns"></button>
      <button type="button" class="chip" data-box-swap="list"></button>
      <button type="button" class="chip" data-box-swap="side"></button>
      <button type="button" class="chip" data-box-swap="report" data-label-tech="Swap Related Report / Order List"></button>
      <button type="button" class="chip" id="box-arrange-default"></button>
      <button type="button" class="chip" id="box-arrange-done"></button>`;
    const BOX_SWAP_LABEL = { columns: 'Swap Columns', list: 'Swap Worklist / Related Exam', side: 'Move Clinical Information',
      report: 'Swap Related Report / Report Editor' };
    kinWrite(arrangeBar, kinSay('Arrange Boxes'), 'aria-label');
    kinWrite(arrangeBar.querySelector('#box-arrange-help'), kinSay('상자를 다른 상자 위로 끌어 놓으면 두 상자가 자리를 바꿉니다. 다른 열의 상자에 놓으면 두 열이 통째로 바뀝니다. 키보드: 상자에서 Enter로 집고, 놓을 상자에서 Enter를 누릅니다. Tab 순서는 화면 배치와 관계없이 그대로입니다.'));
    for (const button of arrangeBar.querySelectorAll('[data-box-swap]')) {
      button.dataset.label = BOX_SWAP_LABEL[button.dataset.boxSwap]; kinWrite(button, kinSay(BOX_SWAP_LABEL[button.dataset.boxSwap]));
    }
    kinWrite(arrangeBar.querySelector('#box-arrange-default'), kinSay('Default Arrangement'));
    kinWrite(arrangeBar.querySelector('#box-arrange-done'), kinSay('Done'));
    const coverLayer = document.createElement('div');
    coverLayer.id = 'box-arrange-covers'; coverLayer.hidden = true;
    document.body.append(coverLayer, arrangeBar);
    let arranging = false, boxPicked = null, boxDrag = null, boxDropped = false, arrangeReturn = null, lastWorkFocus = null, coverFrame = 0;
    let arrangeDrawer = false;
    // The field the reader was in before opening Panel Settings: Done puts focus back there (its caret and text are
    // untouched). Kept only while the page works (stopWorkspaceLayout removes it and forgets the field).
    const noteWorkFocus = event => {
      const el = event.target;
      if (el instanceof Element && el.closest('.split') && !el.closest('.kin-box-cover')) lastWorkFocus = el;
    };
    document.addEventListener('focusin', noteWorkFocus, true);
    // The covers follow the boxes: a resize handle dragged while arranging, a notice growing a box, the window.
    const coverObserver = new ResizeObserver(() => scheduleCovers()), coverObserved = new Set();
    // The scroller a box lives in (the list column, the report row, a stacked page), so the wheel over a cover still
    // scrolls what is under it.
    function boxScroller(node) {
      for (let el = node?.parentElement; el && el !== document.body; el = el.parentElement) {
        const style = getComputedStyle(el);
        if (/(auto|scroll)/.test(style.overflowY) && el.scrollHeight > el.clientHeight + 1) return el;
      }
      return null;
    }
    // Only the product's own sentences above and below come here (boxOutcome, BOX_SAID, literals), never a value.
    const arrangeStatus = text => { kinWrite($('#box-arrange-status'), kinSay(text)); };
    // The bar never hides a box's name: each shown cover lays its name out in the part of its on-screen rectangle that
    // the bar does not cover (below the bar, else beside it, else above it), by the two rectangles as drawn now. The bar
    // stays at the top unless some cover has no such part big enough for its name there; then it sits at the bottom
    // edge, or stays at the top when the bottom leaves no room either.
    const COVER_PAD = 8, COVER_BORDER = 2, BAR_GAP = 4;
    // The cover's padding that puts its name in a bar-free part of `seen` (the cover's rectangle), or null.
    function nameRoom(seen, bar, name) {
      const box = { top: seen.y, left: seen.x, bottom: seen.y + seen.height, right: seen.x + seen.width };
      const under = bar.left < box.right && bar.right > box.left && bar.top < box.bottom && bar.bottom > box.top;
      const sides = [{ ...box, right: bar.left }, { ...box, left: bar.right }].sort((a, b) => (b.right - b.left) - (a.right - a.left));
      const parts = under ? [{ ...box, top: bar.bottom }, ...sides, { ...box, bottom: bar.top }] : [box];
      for (const part of parts) {
        const own = side => part[side] === box[side];
        // Each side of the part keeps the name off its edge: the cover's border on a side it shares with the cover
        // (plus its usual padding where there is room for it), a small gap on a side the bar makes.
        const fixed = side => own(side) ? COVER_BORDER : BAR_GAP;
        const spareX = part.right - part.left - fixed('left') - fixed('right') - name.width;
        const spareY = part.bottom - part.top - fixed('top') - fixed('bottom') - name.height;
        if (spareX < 0 || spareY < 0) continue;
        const pad = (side, spare, pair) => own(side)
          ? Math.min(COVER_PAD, Math.floor(spare / pair.filter(own).length))
          : Math.abs(part[side] - box[side]) - COVER_BORDER + BAR_GAP;
        const y = ['top', 'bottom'], x = ['left', 'right'];
        return `${pad('top', spareY, y)}px ${pad('right', spareX, x)}px ${pad('bottom', spareY, y)}px ${pad('left', spareX, x)}px`;
      }
      return null;
    }
    function placeBoxNames(boxes, covers) {
      const names = covers.map(cover => cover.querySelector('.kin-box-name').getBoundingClientRect());
      const roomAt = end => {
        arrangeBar.dataset.end = end;
        const bar = arrangeBar.getBoundingClientRect();
        return boxes.map((box, i) => nameRoom(box.visible, bar, names[i]));
      };
      let rooms = roomAt('top');
      if (!rooms.every(Boolean)) {
        const low = roomAt('bottom');
        if (low.every(Boolean)) rooms = low;
        else arrangeBar.dataset.end = 'top';
      }
      // A cover with no room for its name anywhere (a box scrolled almost out of view) keeps to its box: no padding.
      covers.forEach((cover, i) => { cover.style.padding = rooms[i] || '0px'; });
    }
    function renderBoxCovers() {
      if (!arranging) return;
      const boxes = workspaceBoxes().filter(box => box.shown);
      const keep = new Map([...coverLayer.children].map(node => [node.dataset.box, node]));
      // Each box element is observed once while arranging (observing again would report it again, every frame).
      // The bar too: a status sentence or a language that wraps it to another line moves the names below it.
      for (const node of [arrangeBar, ...workspaceBoxes().flatMap(box => box.elements)]) {
        if (node && !coverObserved.has(node)) { coverObserved.add(node); coverObserver.observe(node); }
      }
      const nodes = boxes.map(box => {
        let cover = keep.get(box.key);
        if (!cover) {
          cover = document.createElement('button');
          cover.type = 'button'; cover.className = 'kin-box-cover'; cover.dataset.box = box.key;
          cover.innerHTML = '<span class="kin-box-name"></span><small lang="ko"></small>';
          kinWrite(cover.querySelector('small'), kinSay('다른 상자 위로 끌어 놓으세요'));
          cover.addEventListener('pointerdown', startBoxDrag);
          cover.addEventListener('click', boxKey);
          cover.addEventListener('keydown', event => { if (event.key === 'Escape') { event.preventDefault(); escapeArrange(); } });
          cover.addEventListener('wheel', event => {
            const scroller = boxScroller(workspaceBoxes().find(b => b.key === cover.dataset.box)?.elements[0]);
            if (!scroller) return;
            event.preventDefault();
            scroller.scrollBy({ top: event.deltaY, left: event.deltaX });
          }, { passive: false });
        }
        const name = cover.querySelector('.kin-box-name');
        if (cover.dataset.label !== box.label) { cover.dataset.label = box.label; kinWrite(name, kinSay(box.label)); kinWrite(cover, kinSay(box.label), 'aria-label'); }
        cover.setAttribute('aria-pressed', String(boxPicked === box.key || boxDrag?.from === box.key));
        Object.assign(cover.style, { left: box.visible.x + 'px', top: box.visible.y + 'px', width: box.visible.width + 'px', height: box.visible.height + 'px' });
        return cover;
      });
      // Covers follow the screen order, so Tab among them goes the way the boxes are now shown. A cover is moved in the
      // layer only when that order changed, and never under a press: moving a node ends its pointer capture and drops
      // the click that a press and release on it make.
      const current = [...coverLayer.children];
      if (boxDrag) {
        // Under a press: a box scrolled into view gets its cover, one scrolled away loses it; the pressed cover stays.
        for (const node of current) if (node !== boxDrag.cover && !nodes.includes(node)) node.remove();
        for (const node of nodes) if (!node.isConnected) coverLayer.append(node);
      } else if (current.length !== nodes.length || current.some((node, i) => node !== nodes[i])) {
        const focused = coverLayer.contains(document.activeElement) ? document.activeElement : null;
        coverLayer.replaceChildren(...nodes);
        if (focused && !focused.isConnected) coverLayer.querySelector('.kin-box-cover')?.focus({ preventScroll: true });
        else if (focused && document.activeElement !== focused) focused.focus({ preventScroll: true });
      }
      if (boxPicked && !nodes.some(node => node.dataset.box === boxPicked)) boxPicked = null;
      placeBoxNames(boxes, nodes);
    }
    const scheduleCovers = () => {
      if (!arranging || coverFrame) return;
      coverFrame = requestAnimationFrame(() => { coverFrame = 0; renderBoxCovers(); });
    };
    function markTarget(key) {
      for (const cover of coverLayer.children) {
        const target = !!key && cover.dataset.box === key;
        cover.classList.toggle('kin-box-target', target);
        const from = boxDrag?.from || boxPicked;
        kinWrite(cover.querySelector('small'), kinSay(target && from ? boxOutcome(from, key)
          : cover.dataset.box === from ? '집었습니다. 놓을 상자 위에서 놓으세요.' : '다른 상자 위로 끌어 놓으세요'));
      }
      if (key && (boxDrag?.from || boxPicked)) arrangeStatus(boxOutcome(boxDrag?.from || boxPicked, key));
    }
    // What the bar says after a change: whole sentences, never joined from parts.
    const BOX_SAID = {
      swap: ['자리를 바꿨습니다. 이 브라우저에 기억했습니다.', '자리를 바꿨습니다. 브라우저에 저장하지 못해 이 창에서만 유지됩니다.'],
      home: ['기본 배치로 되돌렸습니다. 이 브라우저에 기억했습니다.', '기본 배치로 되돌렸습니다. 브라우저에 저장하지 못해 이 창에서만 유지됩니다.'],
    };
    function chooseBoxSwaps(swaps, done) {
      if (!workspaceEditable()) { endArrange(); return; }
      const next = KinWorkspaceLayout.withBoxSwaps(workspaceState, swaps);
      if (!next) { arrangeStatus('배치를 확인할 수 없습니다. Reset Layout으로 기본 배치를 사용할 수 있습니다.'); return; }
      workspaceState = next; applyLayout(); saveWorkspace(true);
      arrangeStatus(BOX_SAID[done][workspaceLocalKept ? 0 : 1]);
    }
    function dropBox(from, to) {
      const pair = KinBoxLayout.swapFor(from, to);
      boxPicked = null; boxDrag = null;
      if (!pair) { markTarget(null); renderBoxCovers(); arrangeStatus('바뀐 것이 없습니다.'); return; }
      chooseBoxSwaps(KinBoxLayout.toggled(boxSwapsNow(), pair), 'swap');
      markTarget(null);
      coverLayer.querySelector(`[data-box="${to}"]`)?.focus({ preventScroll: true });
    }
    // The box whose cover is on top at a point (not one under the arrange bar), other than `from`; or null.
    function coverAt(x, y, from) {
      const under = Number.isFinite(x) && Number.isFinite(y) ? document.elementFromPoint(x, y)?.closest?.('.kin-box-cover') : null;
      return under && under.parentElement === coverLayer && under.dataset.box !== from ? under.dataset.box : null;
    }
    function startBoxDrag(event) {
      if (event.button !== 0 || !arranging || boxDrag) return;
      event.preventDefault(); boxDropped = false;
      const cover = event.currentTarget;
      // A box picked by a click stays picked: this press may be the click that drops it.
      boxDrag = { from: cover.dataset.box, pointer: event.pointerId, target: null, cover };
      cover.setPointerCapture(event.pointerId);
      cover.setAttribute('aria-pressed', 'true');
      markTarget(null);
      const startX = event.clientX, startY = event.clientY;
      const move = e => {
        if (e.pointerId !== boxDrag?.pointer) return;
        if (Math.abs(e.clientX - startX) + Math.abs(e.clientY - startY) > 4) boxDrag.moved = true;
        // The box under the pointer now is only shown (highlight and outcome); the release decides the drop.
        const key = coverAt(e.clientX, e.clientY, boxDrag.from);
        if (key !== boxDrag.target) { boxDrag.target = key; markTarget(key); }
      };
      const end = e => {
        if (e.pointerId !== boxDrag?.pointer) return;
        for (const type of ['pointermove', 'pointerup', 'pointercancel', 'lostpointercapture']) cover.removeEventListener(type, type === 'pointermove' ? move : end);
        if (cover.hasPointerCapture(e.pointerId)) cover.releasePointerCapture(e.pointerId);
        // The drop goes to the other box under the pointer where it is released — never to the last box it moved
        // over (the column may have scrolled since, bringing the pressed box itself back under the hand).
        const from = boxDrag.from, target = e.type === 'pointerup' ? coverAt(e.clientX, e.clientY, from) : null;
        if (target) boxPicked = null;
        // The mouse click that follows a press which moved is not a click-pick or a click-drop: the release decided
        // (a drop on a box, or nothing over the bar or outside the boxes).
        boxDropped = !!boxDrag.moved || !!target;
        if (target) dropBox(from, target);
        else { boxDrag = null; markTarget(null); renderBoxCovers(); }
      };
      boxDrag.cancel = () => end({ pointerId: boxDrag.pointer, type: 'pointercancel' });
      // A capture the page loses (the window, a dialog) ends the drag without a drop.
      for (const type of ['pointermove', 'pointerup', 'pointercancel', 'lostpointercapture']) cover.addEventListener(type, type === 'pointermove' ? move : end);
    }
    // Enter or Space (or a click without a drag) on a box picks it; on another box drops it there; on the same box
    // puts it back.
    function boxKey(event) {
      if (!arranging) return;
      // Only the mouse click of that drop is skipped; Enter or Space (detail 0) always counts.
      const dropClick = boxDropped && event.detail > 0;
      boxDropped = false;
      if (dropClick) return;
      const key = event.currentTarget.dataset.box;
      if (!boxPicked) { boxPicked = key; markTarget(null); renderBoxCovers(); arrangeStatus('상자를 집었습니다. 놓을 상자로 Tab 이동한 뒤 Enter를 누르세요. Esc는 취소입니다.'); return; }
      if (boxPicked === key) { boxPicked = null; markTarget(null); renderBoxCovers(); arrangeStatus('집은 상자를 내려놓았습니다.'); return; }
      dropBox(boxPicked, key);
    }
    coverLayer.addEventListener('focusin', event => {
      const key = event.target.dataset?.box;
      if (boxPicked) markTarget(key !== boxPicked ? key : null);
    });
    function escapeArrange() {
      if (boxPicked) { boxPicked = null; markTarget(null); renderBoxCovers(); arrangeStatus('집은 상자를 내려놓았습니다.'); return; }
      endArrange(true);
    }
    function startArrange() {
      if (arranging || !workspaceEditable() || document.body.classList.contains('reading')) return;
      arrangeReturn = lastWorkFocus;
      const view = $('#toolbar-view'); if (view.open) view.open = false;
      if (panelDialog.open) panelDialog.close();
      arranging = true; boxPicked = null; arrangeDrawer = document.body.classList.contains('study-panel-open');
      document.body.classList.add('kin-arranging');
      coverLayer.hidden = false; arrangeBar.hidden = false;
      renderArrangeBar(); arrangeStatus('');
      renderBoxCovers();
      (coverLayer.querySelector('.kin-box-cover') || $('#box-arrange-done')).focus({ preventScroll: true });
    }
    function endArrange(returnFocus = true) {
      if (!arranging) return;
      boxDrag?.cancel?.(); boxDrag = null; boxPicked = null; arranging = false;
      cancelAnimationFrame(coverFrame); coverFrame = 0; coverObserver.disconnect(); coverObserved.clear();
      document.body.classList.remove('kin-arranging');
      coverLayer.replaceChildren(); coverLayer.hidden = true; arrangeBar.hidden = true;
      if (!returnFocus) return;
      const back = arrangeReturn;
      arrangeReturn = null;
      if (back?.isConnected && !back.disabled && !back.closest('[hidden], [inert]') && back.getClientRects().length) back.focus({ preventScroll: true });
      else $('#toolbar-view > summary')?.focus({ preventScroll: true });
    }
    function renderArrangeBar() {
      const on = boxSwapsNow(), tech = mode === 'Technician';
      for (const button of arrangeBar.querySelectorAll('[data-box-swap]')) {
        button.setAttribute('aria-pressed', String(on.includes(button.dataset.boxSwap)));
        const label = button.dataset.boxSwap === 'report' && tech ? 'Swap Related Report / Order List' : BOX_SWAP_LABEL[button.dataset.boxSwap];
        if (button.dataset.label !== label) { button.dataset.label = label; kinWrite(button, kinSay(label)); }
      }
      $('#box-arrange-default').disabled = !on.length;
    }
    arrangeBar.addEventListener('click', event => {
      const swap = event.target.closest('[data-box-swap]');
      if (swap && arranging) { boxPicked = null; chooseBoxSwaps(KinBoxLayout.toggled(boxSwapsNow(), swap.dataset.boxSwap), 'swap'); markTarget(null); }
    });
    arrangeBar.addEventListener('keydown', event => { if (event.key === 'Escape') { event.preventDefault(); escapeArrange(); } });
    $('#box-arrange-default').addEventListener('click', () => { if (arranging) { boxPicked = null; chooseBoxSwaps([], 'home'); markTarget(null); } });
    $('#box-arrange-done').addEventListener('click', () => endArrange(true));
    $('#box-arrange-open').addEventListener('click', startArrange);
    // The work area scrolls under the covers (the list column, the report row, a stacked page): they follow it.
    document.addEventListener('scroll', scheduleCovers, true);
    work.onInvalidate(event => { if (event.reason === 'prepare') { boxDrag?.cancel?.(); } });
    // Every layout pass (window size, Layout, workflow tab, panel choices, Reading Workspace) re-measures the covers.
    boxArrangeLayout = () => {
      const reading = document.body.classList.contains('reading');
      $('#box-arrange-open').disabled = reading;
      if (!arranging) return;
      // The Study Panel opened or closed by the reader while arranging (it steps aside only for an arrangement it was
      // already in): arranging ends and the drawer shows as asked.
      if (reading || !workspaceEditable() || document.body.classList.contains('study-panel-open') !== arrangeDrawer) { endArrange(false); return; }
      renderArrangeBar(); renderBoxCovers();
    };
    boxArrangeLayout();
    boxArrangeEnd = () => endArrange(false);
    function stopWorkspaceLayout() {
      if (panelDialog.open) panelDialog.close();
      endArrange(false); document.removeEventListener('scroll', scheduleCovers, true);
      document.removeEventListener('focusin', noteWorkFocus, true); lastWorkFocus = null; arrangeReturn = null;
      workspaceEnded = true; workspaceGeneration++;
      workspaceDragCancel?.(); workspaceObserver.disconnect(); cancelAnimationFrame(splitFrame); splitFrame = 0;
      window.removeEventListener('resize', applyLayout);
      studyPanel?.destroy(); studyPanel = null;
      document.body.classList.remove('study-panel-open');
    }
    window.addEventListener('pagehide', stopWorkspaceLayout, { once: true });
    work.onInvalidate(event => {
      if (event.reason === 'prepare') workspaceDragCancel?.();
      // The tab strip, the narrow stacking and the row floors follow the selected
      // study: settle them before the selection's first paint, so opening the
      // drawer later moves nothing (W3R-03).
      if (event.reason === 'select') scheduleWorkspaceLayout();
    });
    bindPanelResize('#resize-rail', 'x', e => {
      const left = $('.left').getBoundingClientRect();
      document.body.style.setProperty('--workspace-rail-width', clampPanel(e.clientX - left.left, 160, innerWidth / 3) + 'px');
    });
    applyLayout();

    // Each handle grows its own box toward the hand: with the boxes swapped (Arrange Boxes) the box can lie on the
    // other side of its handle, and box-layout.js says which (edges: +1 its box is before the handle, -1 after).
    const boxEdge = name => document.body.classList.contains('reading') ? KinBoxLayout.arrangement([]).edges[name]
      : KinBoxLayout.arrangement(boxSwapsNow()).edges[name];
    // A box placed after its handle follows the hand's movement (its size less the move), so it never jumps by the gaps
    // between the handle and the box; a box before its handle keeps the measure it always had.
    bindPanelResize("#resize-main", () => portraitLayout() ? "y" : "x", (e, axis, delta) => {
      const box = $(".split").getBoundingClientRect(), left = $(".left"), before = boxEdge('main') > 0;
      const now = left.getBoundingClientRect()[axis === "y" ? "height" : "width"];
      if (axis === "y")
        left.style.height = clampPanel(before ? e.clientY - box.top : now - delta, 180, box.height - 420) + "px";
      else
        left.style.width = clampPanel(before ? e.clientX - box.left : now - delta, 500, box.width - 426) + "px";
    });
    bindPanelResize("#resize-top", "y", (e, axis, delta) => {
      const top = $(".rw"), current = top.getBoundingClientRect().height;
      // 목록의 최소 높이 때문에 상한이 현재 띠보다 작아도 손과 반대로 줄이지 않는다.
      // 포인터 이동량을 쓰므로 손잡이 안의 누른 위치나 작업공간 스크롤에 영향받지 않는다.
      const maximum = Math.max(current, 140, $(".right").getBoundingClientRect().height - 266);
      top.style.height = clampPanel(current + boxEdge('top') * delta, Math.min(current, 140), maximum) + "px";
    });
    bindPanelResize("#resize-related", "y", (e, axis, delta) => {
      const box = $(".workrow").getBoundingClientRect(), before = boxEdge('related') > 0, related = $(".related-p");
      related.style.height = clampPanel(before ? e.clientY - box.top : related.getBoundingClientRect().height - delta,
        portraitLayout() ? 286 : 150, box.height - 186) + "px";
    });
    bindPanelResize("#resize-left-split", "y", (e, axis, delta) => {
      const box = $(".left").getBoundingClientRect();
      const list = $(".related-list-pane");
      list.style.flex = "none";
      list.style.height = clampPanel(boxEdge('prior') < 0 ? box.bottom - e.clientY : list.getBoundingClientRect().height + delta, 80, box.height - 170) + "px";
    });
