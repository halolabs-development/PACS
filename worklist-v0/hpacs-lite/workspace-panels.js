

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
      const said = saved ? "배치 저장됨 · 이 브라우저" : "배치 저장 안 됨 · 이 창에서만 유지";
      if (!fromStudyPanel) $("#layout-status").textContent = said;
      else if (!saved || !kept) studyPanel?.setNotice(said);
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
      $("#layout-status").textContent = ({ restored: "배치 복원됨 · 이 브라우저", empty: "배치 · 이 브라우저",
        disabled: "배치 · 이 창에서만 유지", invalid: "저장된 배치 오류 · 기본 배치", unavailable: "배치 저장소 사용 불가 · 기본 배치" })[result.status];
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
      $("#layout-status").textContent = removed ? "기본 배치 · 이 브라우저" : "초기화 저장 안 됨 · 이 창에서만 유지";
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
      <footer><button type="button" id="box-arrange-open" title="Worklist·Related Exam·Clinical Information·Related Report·Report Editor 상자를 끌어 서로 자리를 바꿉니다.">Arrange Boxes</button><button type="button" id="panel-settings-show-all">Show All Panels</button><button type="button" id="panel-settings-close">Close</button></footer>`;
    document.body.append(panelDialog);
    const hiddenPanelsNow = () => workspaceState.workspace?.hiddenPanels?.slice() || [];
    function renderPanelSettings() {
      const hidden = hiddenPanelsNow(), editable = workspaceEditable();
      for (const input of panelDialog.querySelectorAll('input[data-panel]')) { input.checked = !hidden.includes(input.dataset.panel); input.disabled = !editable; }
      $('#panel-settings-show-all').disabled = !editable || !hidden.length;
    }
    function choosePanels(hidden) {
      if (!workspaceEditable()) { renderPanelSettings(); return; }
      const next = KinWorkspaceLayout.withHiddenPanels(workspaceState, KinWorkspaceLayout.PANELS.filter(key => hidden.includes(key)));
      if (!next) { $('#panel-settings-status').textContent = '패널 설정을 확인할 수 없습니다. Reset Layout으로 기본 배치를 사용할 수 있습니다.'; return; }
      // The dialog says the outcome itself: rewriting the toolbar status line would wrap it in narrow windows and move
      // the list and the work area under the reader (W3R7-04, as for Study Panel choices).
      workspaceState = next; applyLayout(); saveWorkspace(true); renderPanelSettings();
      $('#panel-settings-status').textContent = workspaceLocalKept ? '패널 표시를 기억했습니다 · 이 브라우저'
        : '패널 표시를 이 창에만 적용했습니다. 브라우저에 저장하지 못했습니다.';
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
        const clinicalAway = key === 'clinical' && !$('.rw > .s-clinical')?.getClientRects().length;
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
    arrangeBar.setAttribute('role', 'region'); arrangeBar.setAttribute('aria-label', 'Arrange Boxes');
    arrangeBar.innerHTML = `<p id="box-arrange-help" lang="ko">상자를 다른 상자 위로 끌어 놓으면 두 상자가 자리를 바꿉니다. 다른 열의 상자에 놓으면 두 열이 통째로 바뀝니다.
        키보드: 상자에서 Enter로 집고, 놓을 상자에서 Enter를 누릅니다. Tab 순서는 화면 배치와 관계없이 그대로입니다.</p>
      <span id="box-arrange-status" role="status" aria-live="polite" lang="ko"></span>
      <button type="button" class="chip" data-box-swap="columns">Swap Columns</button>
      <button type="button" class="chip" data-box-swap="list">Swap Worklist / Related Exam</button>
      <button type="button" class="chip" data-box-swap="side">Move Clinical Information</button>
      <button type="button" class="chip" data-box-swap="report" data-label-tech="Swap Related Report / Order List">Swap Related Report / Report Editor</button>
      <button type="button" class="chip" id="box-arrange-default">Default Arrangement</button>
      <button type="button" class="chip" id="box-arrange-done">Done</button>`;
    const coverLayer = document.createElement('div');
    coverLayer.id = 'box-arrange-covers'; coverLayer.hidden = true;
    document.body.append(coverLayer, arrangeBar);
    let arranging = false, boxPicked = null, boxDrag = null, boxDropped = false, arrangeReturn = null, lastWorkFocus = null, coverFrame = 0;
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
    const arrangeStatus = text => { $('#box-arrange-status').textContent = text; };
    function renderBoxCovers() {
      if (!arranging) return;
      const boxes = workspaceBoxes().filter(box => box.shown);
      const keep = new Map([...coverLayer.children].map(node => [node.dataset.box, node]));
      // Each box element is observed once while arranging (observing again would report it again, every frame).
      for (const box of workspaceBoxes()) for (const node of box.elements) {
        if (node && !coverObserved.has(node)) { coverObserved.add(node); coverObserver.observe(node); }
      }
      const nodes = boxes.map(box => {
        let cover = keep.get(box.key);
        if (!cover) {
          cover = document.createElement('button');
          cover.type = 'button'; cover.className = 'kin-box-cover'; cover.dataset.box = box.key;
          cover.innerHTML = '<span class="kin-box-name"></span><small lang="ko">다른 상자 위로 끌어 놓으세요</small>';
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
        if (name.textContent !== box.label) { name.textContent = box.label; cover.setAttribute('aria-label', box.label); }
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
        cover.querySelector('small').textContent = target && from ? boxOutcome(from, key)
          : cover.dataset.box === from ? '집었습니다. 놓을 상자 위에서 놓으세요.' : '다른 상자 위로 끌어 놓으세요';
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
        // Only a cover that is on top under the pointer is a target (not one under the arrange bar).
        const under = document.elementFromPoint(e.clientX, e.clientY)?.closest?.('.kin-box-cover');
        const key = under && under.dataset.box !== boxDrag.from ? under.dataset.box : null;
        if (key !== boxDrag.target) { boxDrag.target = key; markTarget(key); }
      };
      const end = e => {
        if (e.pointerId !== boxDrag?.pointer) return;
        for (const type of ['pointermove', 'pointerup', 'pointercancel', 'lostpointercapture']) cover.removeEventListener(type, type === 'pointermove' ? move : end);
        if (cover.hasPointerCapture(e.pointerId)) cover.releasePointerCapture(e.pointerId);
        const { from, target } = boxDrag;
        if (target) boxPicked = null;
        // The mouse click that follows a press which moved is not a click-pick or a click-drop: the release decided
        // (a drop on a box, or nothing over the bar or outside the boxes).
        boxDropped = !!boxDrag.moved || (e.type === 'pointerup' && !!target);
        if (e.type === 'pointerup' && target) dropBox(from, target);
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
      arranging = true; boxPicked = null;
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
        if (button.dataset.boxSwap === 'report') button.textContent = tech ? 'Swap Related Report / Order List' : 'Swap Related Report / Report Editor';
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
      if (reading || !workspaceEditable()) { endArrange(false); return; }
      renderArrangeBar(); renderBoxCovers();
    };
    boxArrangeLayout();
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
