// The viewer write path (viewer-language.js): product words in the reader's screen language, or as written.
function kinText(t, ...p) { const l = typeof window === 'object' && window && window.KinLanguage; return l && l.text ? l.text(t, ...p) : t.replace(/\{[ten]?(\d+)\}/g, (m, i) => String(p[i])); }
function kinHtml(t, ...p) { const l = typeof window === 'object' && window && window.KinLanguage; return l && l.html ? l.html(t, ...p) : t.replace(/\{[ten]?(\d+)\}/g, (m, i) => String(p[i])); }
window.KinViewerUXShell = (() => {
  // Minhoon 2026-10-27 item 4: the stock Studies and Measurement panels take image width. They open as the
  // stock mode declares until the reader opens or closes one with its own controls; that choice is then kept
  // for this account in this browser, like the window's place. Only the reader's clicks are recorded: a panel
  // the stock opens by itself is left open for that viewer only.
  function mountSidePanels(session, signal) {
    const sides = ['left', 'right'], applied = new Set();
    const key = () => { const owner = session.owner(); return owner ? 'kin-viewer-side-panels:v1:' + JSON.stringify(owner) : null; };
    const header = side => document.querySelector('[data-cy="side-panel-header-' + side + '"]');
    // The stock panel slides out by a negative margin and stays mounted as a narrow strip.
    const container = side => header(side)?.closest('[style*="margin-' + side + '"]');
    const open = side => { const box = container(side); return box ? box.style[side === 'left' ? 'marginLeft' : 'marginRight'] === '0px' : null; };
    function read() {
      try {
        const value = JSON.parse(localStorage.getItem(key()) || 'null');
        return value && typeof value === 'object' ? value : {};
      } catch (_) { return {}; }
    }
    function apply() {
      if (!key() || applied.size === sides.length) return;
      const saved = read();
      for (const side of sides) {
        const now = open(side);
        if (applied.has(side) || now === null) continue;
        applied.add(side);
        if (typeof saved[side] === 'boolean' && saved[side] !== now) header(side).click();
      }
    }
    // The panel's state after the reader's action is the reader's choice (read on the next frame, once the stock applied it).
    function remember(side, before) {
      requestAnimationFrame(() => {
        const now = open(side), name = key();
        if (signal.aborted || !name || now === null || now === before) return;
        try { localStorage.setItem(name, JSON.stringify({ ...read(), [side]: now })); } catch (_) {}
      });
    }
    document.addEventListener('click', event => {
      const side = sides.find(value => container(value)?.contains(event.target));
      if (!side || !event.isTrusted) return;
      remember(side, open(side));
    }, { capture: true, signal });
    // A compact panel button (mountPanels) acts with the panel's own control; what it opens or closes is the reader's choice.
    function press(side, act) { const before = open(side); act(); remember(side, before); }
    return { apply, press, container, header, open };
  }
  // Minhoon 2026-10-27 item 4 ("Move Studies, Measurement, and Segmentation navigation into compact upper controls") and
  // 2026-11-01 ("move this whole bar as a horizontal bar on the top", of the Studies panel). Three compact buttons at the
  // end of the patient row open and close the stock panels, each with the panel's own control, so the stock panel keeps
  // its state and a choice made here is kept as the reader's (mountSidePanels.press). While the buttons are shown the
  // panels' closed edge strips, the navigation they replace, are not shown; the images take that room. The open Studies
  // panel lies across the top of the images (theme: [data-kin-studies-band]). Where the patient row is not shown (a
  // second window that shows images only) or a panel's control is not found, the stock entrances stay as they are.
  // The stock Measurements tab lists only measurements accepted for tracking; while it lists none it says so and offers
  // the tool area's Measurements list, where every drawn measurement is (two lists of one name, one always empty, read
  // as "no measurements").
  function mountPanels(sides) {
    const group = document.createElement('section'); group.className = 'kin-ux-panels'; group.dataset.kinUxOwned = '';
    group.setAttribute('role', 'group'); group.setAttribute('aria-label', 'Panels');
    const TRACKED = '[data-cy="trackedMeasurements-panel"]';
    const entries = [
      { key: 'studies', label: 'Studies', side: 'left', title: kinText("검사·시리즈 목록을 열거나 닫습니다.") },
      { key: 'measurements', label: 'Measurements', side: 'right', tab: '[data-cy="trackedMeasurements-btn"]',
        title: kinText("추적을 수락한 측정 목록(CSV·SR 내보내기)을 열거나 닫습니다.") },
      { key: 'segmentation', label: 'Segmentation', side: 'right', tab: '[data-cy$="-btn"][data-cy*="segmentation" i]',
        title: kinText("분할 목록을 열거나 닫습니다.") },
    ];
    for (const entry of entries) {
      const node = entry.node = document.createElement('button'); node.type = 'button'; node.textContent = entry.label;
      node.dataset.panel = entry.key; node.title = entry.title; node.hidden = true;
      node.onclick = () => press(entry); group.append(node);
    }
    const tabOf = entry => entry.tab && sides.container(entry.side)?.querySelector(entry.tab) || null;
    const available = entry => !!sides.container(entry.side) && (!entry.tab || !!tabOf(entry));
    // A tab is shown when its panel is open and its content is there: Measurements by its list, Segmentation otherwise.
    function on(entry) {
      if (sides.open(entry.side) !== true) return false;
      if (!entry.tab) return true;
      const tracked = !!sides.container(entry.side).querySelector(TRACKED);
      return entry.key === 'measurements' ? tracked : !tracked;
    }
    function press(entry) {
      if (!available(entry)) return;
      // Open on this tab: close the panel. Closed, or open on the other tab: this tab's own control opens it there.
      if (on(entry)) sides.press(entry.side, () => sides.header(entry.side)?.click());
      else sides.press(entry.side, () => (entry.tab ? tabOf(entry) : sides.header(entry.side))?.click());
    }
    const hint = document.createElement('p'); hint.className = 'kin-tracked-hint'; hint.dataset.kinUxOwned = ''; hint.setAttribute('role', 'note');
    const hintText = document.createElement('span');
    hintText.textContent = 'This list shows only measurements accepted for tracking. Every drawn measurement is in the Measurements list of the tool area.';
    const openList = document.createElement('button'); openList.type = 'button'; openList.textContent = 'Open Measurements List';
    const dockTab = () => document.querySelector('#kin-workspace-dock nav button[aria-controls="kin-viewer-history"]');
    openList.onclick = () => { const tab = dockTab(); if (!tab) return; if (tab.getAttribute('aria-expanded') !== 'true') tab.click(); tab.focus(); };
    hint.append(hintText, openList);
    let bandRow = null, bandPanel = null, frameTop = null;
    function apply() {
      const host = document.querySelector('.kin-patient-tabs'), any = entries.some(available);
      if (!host || !any) group.remove();
      else if (group.parentElement !== host || host.lastElementChild !== group) host.append(group);
      const active = group.isConnected && !document.body.classList.contains('kin-second-display-rows-off');
      for (const entry of entries) {
        const shown = active && available(entry);
        if (entry.node.hidden !== !shown) entry.node.hidden = !shown;
        entry.node.setAttribute('aria-pressed', String(shown && on(entry)));
      }
      document.body.toggleAttribute?.('data-kin-panels', active);
      for (const side of ['left', 'right']) {
        const box = sides.container(side);
        // Only a panel whose button is shown loses its strip: the stock strip stays the way in otherwise.
        const own = active && entries.some(entry => entry.side === side && !entry.node.hidden);
        box?.toggleAttribute?.('data-kin-side-closed', own && sides.open(side) === false);
      }
      const left = sides.container('left');
      const band = active && !!left && !entries[0].node.hidden && sides.open('left') === true;
      const row = band ? left.parentElement : null;
      if (bandRow && bandRow !== row) bandRow.removeAttribute?.('data-kin-studies-band');
      if (bandPanel && bandPanel !== (band ? left : null)) bandPanel.removeAttribute?.('data-kin-studies-panel');
      bandRow = row; bandPanel = band ? left : null;
      row?.setAttribute?.('data-kin-studies-band', ''); bandPanel?.setAttribute?.('data-kin-studies-panel', '');
      // A viewer window floating over the images (Recent Layout where there is no tool area) never rises over the
      // viewer's top rows, wherever the Studies band puts them: the theme keeps it below the image grid's top.
      const gridTop = Math.round(document.querySelector('[data-cy="viewport-grid"]')?.getBoundingClientRect?.().top ?? NaN);
      if (Number.isFinite(gridTop) && gridTop !== frameTop) { frameTop = gridTop; document.documentElement?.style?.setProperty?.('--kin-frame-top', gridTop + 'px'); }
      const tracked = document.querySelector(TRACKED);
      if (tracked && !tracked.querySelector('[data-cy="data-row"]')) {
        openList.hidden = !dockTab();
        if (hint.nextElementSibling !== tracked) tracked.before(hint);
      } else if (hint.isConnected) hint.remove();
    }
    return { apply, dispose() {
      group.remove(); hint.remove(); document.body.removeAttribute?.('data-kin-panels'); document.documentElement?.style?.removeProperty?.('--kin-frame-top');
      bandRow?.removeAttribute?.('data-kin-studies-band'); bandPanel?.removeAttribute?.('data-kin-studies-panel');
      for (const side of ['left', 'right']) sides.container(side)?.removeAttribute?.('data-kin-side-closed');
    } };
  }
  // A3 C-R01-027 #18/#19: the pinned OHIF 3.9.1 Studies panel already builds Primary/Recent/All tabs, but shows them
  // only as a dropdown behind its unlabeled settings icon. This row shows the same tabs over the list. Selecting one calls
  // the panel's own onClickTab, so the stock panel still filters its own list, and its dropdown, sort and list/thumbnail
  // controls stay as they are. The props are read from React 18's committed fibers. React keeps two copies of each
  // fiber and a commit makes one of them current. The element keeps the fiber it was created with, a fiber's return may
  // be a copy that is no longer current, and __reactProps$ does not follow a children-only update. So the element's
  // fiber path is followed again from the root's current fiber, whose child lists hold only committed copies. Without
  // those props the row is removed rather than left without an effect.
  function mountStudyTabs() {
    const row = document.createElement('div');
    row.className = 'kin-study-tabs'; row.dataset.kinUxOwned = '';
    row.setAttribute('role', 'tablist'); row.setAttribute('aria-label', 'Study List');
    let chosen = null, timer = 0, signature = '';
    function nativeProps(panel) {
      const key = Object.keys(panel).find(name => name.startsWith('__reactFiber$')), path = [], committed = [];
      for (let fiber = key && panel[key]; fiber; fiber = fiber.return) path.unshift(fiber);
      let node = path[0]?.stateNode?.current;
      for (let index = 1; node && index < path.length; index++) {
        let child = node.child;
        while (child && child !== path[index] && child !== path[index].alternate) child = child.sibling;
        committed.unshift(node = child);
      }
      if (!node) return null;
      for (const fiber of committed.slice(0, 4)) {
        const props = fiber.memoizedProps;
        if (props && typeof props.onClickTab === 'function' && typeof props.activeTabName === 'string' && Array.isArray(props.tabs)
          && props.tabs.every(tab => typeof tab?.name === 'string' && typeof tab.label === 'string' && Array.isArray(tab.studies))) return props;
      }
      return null;
    }
    const current = () => { const panel = document.querySelector('[data-cy="studyBrowser-panel"]'); return panel && { panel, props: nativeProps(panel) }; };
    function apply() {
      const { panel, props } = current() || {};
      if (!props) { row.remove(); return; }
      if (row.nextElementSibling !== panel) panel.before(row);
      const next = JSON.stringify(props.tabs.map(tab => [tab.name, tab.label]));
      if (next !== signature) {
        signature = next;
        row.replaceChildren(...props.tabs.map(tab => {
          const button = document.createElement('button'); button.type = 'button'; button.setAttribute('role', 'tab');
          button.dataset.tab = tab.name; button.textContent = tab.label;
          button.onclick = () => {
            const now = current()?.props;
            if (!now?.tabs.some(value => value.name === tab.name && value.studies.length)) return;
            now.onClickTab(tab.name);
            // The stock panel commits the choice in a later task; until then the row shows what was chosen.
            chosen = tab.name; clearTimeout(timer); timer = setTimeout(() => { chosen = null; apply(); }, 300); apply();
          };
          return button;
        }));
      }
      const active = chosen ?? props.activeTabName;
      for (const button of row.children) {
        const tab = props.tabs.find(value => value.name === button.dataset.tab);
        button.setAttribute('aria-selected', String(tab.name === active));
        button.disabled = !tab.studies.length;
      }
    }
    return { apply, dispose() { clearTimeout(timer); row.remove(); } };
  }
  // Toolbar & Thumbnail Position (viewer-features-chrome.js): the body attributes the theme keys on and the image
  // column's grid. The value is kept for the document, so a viewer mounted again (patient tab, saved Job) lays out its
  // rows on the same edges before its grid is drawn; the toolbar applies the account's value again when it mounts.
  // The default value sets nothing: the rows stay exactly as without this feature.
  const CHROME_ATTRIBUTES = ['data-kin-chrome', 'data-kin-toolbar-side', 'data-kin-thumbs-side', 'data-kin-toolbar-hide', 'data-kin-thumbs-hide'];
  let chromePlan = null, chromeStyle = null;
  const chromeListeners = new Set();
  function chrome(value) {
    const model = window.KinViewerChromePosition;
    if (!model) return false;
    const plan = model.plan(value), body = document.body, v = plan.value;
    const text = model.css(v);
    if (!chromeStyle?.isConnected) {
      chromeStyle = document.createElement('style'); chromeStyle.dataset.kinUxOwned = ''; chromeStyle.dataset.kinChrome = '';
      document.head.append(chromeStyle);
    }
    if (chromeStyle.textContent !== text) chromeStyle.textContent = text;
    if (plan.standard) CHROME_ATTRIBUTES.forEach(name => body.removeAttribute(name));
    else {
      body.setAttribute('data-kin-chrome', '');
      body.setAttribute('data-kin-toolbar-side', v.toolbar); body.setAttribute('data-kin-thumbs-side', v.thumbs);
      body.toggleAttribute('data-kin-toolbar-hide', v.toolbarAutoHide); body.toggleAttribute('data-kin-thumbs-hide', v.thumbsAutoHide);
    }
    chromePlan = plan;
    for (const listener of [...chromeListeners]) try { listener(); } catch (error) { console.error(error); }
    return true;
  }
  // An auto-hidden row comes out while the pointer is on its edge (8px either side of it) or over the row, while keyboard
  // focus is in it, while one of its menus is open (More, a feature menu, the Viewer Settings it opened) and while a
  // series is dragged from it. Otherwise it folds 0.6s after the last of these ended.
  function mountAutoHide(signal, rows) {
    const LINGER = 600;
    const state = new Map([['toolbar', { timer: 0 }], ['thumbs', { timer: 0 }]]);
    let pointer = null, dragging = null, frame = 0;
    const node = row => rows[row]();
    const column = () => document.querySelector('.kin-viewer-series-strip')?.parentElement || null;
    const inside = (box, x, y) => x >= box.left && x <= box.right && y >= box.top && y <= box.bottom;
    function wanted(row, element, overlay) {
      if (dragging === element) return true;
      const focused = document.activeElement;
      if (focused && element.contains(focused) && focused.matches(':focus-visible')) return true;
      if (element.querySelector('details[open], [aria-expanded="true"]')) return true;
      if (row === 'toolbar' && document.querySelector('dialog.kin-ux-settings[open]')) return true;
      if (!pointer) return false;
      const host = column();
      if (element.hasAttribute('data-kin-shown') && inside(element.getBoundingClientRect(), pointer.x, pointer.y)) return true;
      return !!host && window.KinViewerChromePosition.edgeHit(overlay, host.getBoundingClientRect(), pointer.x, pointer.y);
    }
    function check() {
      frame = 0;
      if (signal.aborted) return;
      const overlays = chromePlan?.overlays || [];
      const want = row => { const element = node(row), overlay = overlays.find(item => item.row === row); return !!element && !!overlay && wanted(row, element, overlay); };
      // Two hidden rows on one edge come out and fold together.
      const both = overlays.some(item => item.together) && (want('toolbar') || want('thumbs'));
      for (const [row, entry] of state) {
        const element = node(row), overlay = overlays.find(item => item.row === row);
        if (!element) continue;
        if (!overlay) { clearTimeout(entry.timer); entry.timer = 0; element.removeAttribute('data-kin-shown'); continue; }
        if (both || wanted(row, element, overlay)) {
          clearTimeout(entry.timer); entry.timer = 0;
          element.setAttribute('data-kin-shown', '');
        } else if (element.hasAttribute('data-kin-shown') && !entry.timer) {
          entry.timer = setTimeout(() => { entry.timer = 0; if (signal.aborted) return; const keep = overlay.together ? want('toolbar') || want('thumbs') : wanted(row, element, overlay); if (keep) check(); else element.removeAttribute('data-kin-shown'); }, LINGER);
        }
      }
    }
    const soon = () => { if (!frame) frame = requestAnimationFrame(check); };
    const options = { capture: true, passive: true, signal };
    document.addEventListener('pointermove', event => { pointer = { x: event.clientX, y: event.clientY }; if (chromePlan?.overlays.length) soon(); }, options);
    document.addEventListener('pointerdown', event => { pointer = { x: event.clientX, y: event.clientY }; soon(); }, options);
    document.documentElement?.addEventListener('pointerleave', () => { pointer = null; soon(); }, { passive: true, signal });
    for (const type of ['focusin', 'focusout', 'keyup', 'toggle', 'click']) document.addEventListener(type, () => setTimeout(soon), options);
    // A drag the row's own guard refuses (preventDefault) never ends with dragend: it holds the row only once it started.
    document.addEventListener('dragstart', event => {
      const from = Object.keys(rows).map(node).find(element => element?.contains(event.target)) || null;
      setTimeout(() => { if (!event.defaultPrevented) dragging = from; soon(); });
    }, options);
    for (const type of ['dragend', 'drop']) document.addEventListener(type, () => { dragging = null; soon(); }, options);
    return { changed: soon, dispose() { cancelAnimationFrame(frame); for (const entry of state.values()) clearTimeout(entry.timer); } };
  }
  function mount({ services, session }) {
    // The theme stylesheet is loaded once per document by the extension before
    // this mount; the body class scopes its viewer-wide rules to the mounted shell.
    document.body.classList.add('kin-viewer-ux');
    const tabs = window.KinViewerPatientTabs;
    let actions = null, reportContext = null, reportLifecycle = null;
    const report = document.createElement('section'); report.hidden = true; report.className = 'kin-viewer-prior-report';
    report.dataset.kinUxOwned = ''; report.setAttribute('role', 'region'); report.setAttribute('aria-label', 'Previous Report');
    const closeReport = options => {
      const { restoreFocus = false, notify = true } = options || {};
      const previous = reportLifecycle; reportLifecycle = null;
      report.hidden = true; reportContext = null; report.replaceChildren();
      if (notify) previous?.onClose?.();
      if (restoreFocus && previous?.opener?.isConnected) previous.opener.focus();
    };
    const context = viewportId => {
      const patient = tabs.snapshot(), cell = window.KinViewerInfoBar.identity(services, viewportId);
      const sourceId = cell.instance?.PatientID;
      const key = patient?.key;
      if (!sourceId || !key?.includes('|') || key.slice(key.indexOf('|') + 1) !== sourceId) return null;
      return { patientKey: key, sequence: patient.sequence, viewportId,
        studyUid: cell.instance.StudyInstanceUID, seriesUid: cell.instance.SeriesInstanceUID,
        // One series can be split into several display sets; a cell moved to another of them is another origin.
        displaySetUid: cell.set.displaySetInstanceUID, mode: cell.viewport.type };
    };
    const admits = value => {
      const now = value && context(value.viewportId);
      return !!now && ['patientKey', 'sequence', 'viewportId', 'studyUid', 'seriesUid', 'displaySetUid', 'mode'].every(key => now[key] === value[key]);
    };
    // The patient of an original study in the rows read for this patient: its own row, or the listed exam whose scope holds
    // it (a merged exam's other originals have no row of their own).
    const patientOf = (rows, uid) => (rows.find(row => row.uid === uid) || rows.find(row => row.examScope?.sources?.some(source => source.studyUid === uid)
      || row.sourceMetadata?.some(source => (source.uid ?? source.studyUid) === uid)))?.sourcePatientKey;
    const seam = {
      snapshot: tabs.snapshot, subscribe: tabs.subscribe, viewport: context,
      registerStudyActions(value) {
        actions = value; info.refresh();
        return () => { if (actions === value) { actions = null; closeReport(); info.refresh(); } };
      },
      // The related-study list and opening the Prior Studies extension registered (null until it has, and for a
      // session that does not mount it).
      related: () => actions?.related || null,
      // Several cells change together ([{ value, displaySetInstanceUIDs }], Prev/Next prior): each cell must still show
      // what it showed when asked, every image must belong to that one patient, and either every cell changes or none.
      async replace(plan, { signal, studies } = {}) {
        if (!Array.isArray(plan) || !plan.length || signal?.aborted || !tabs.guard()) return false;
        const key = plan[0].value?.patientKey;
        const sets = plan.flatMap(entry => (entry.displaySetInstanceUIDs || []).map(id => services.displaySetService.getDisplaySetByUID(id)));
        if (!sets.length || sets.some(set => !set) || plan.some(entry => !admits(entry.value) || entry.value.patientKey !== key || !entry.displaySetInstanceUIDs?.length)) return false;
        if (!Array.isArray(studies) || sets.some(set => patientOf(studies, set.StudyInstanceUID) !== key)) return false;
        if (!tabs.guard(true) || tabs.snapshot()?.key !== key || plan.some(entry => !admits(entry.value))) return false;
        services.viewportGridService.setDisplaySetsForViewports(plan.map(entry => ({ viewportId: entry.value.viewportId,
          displaySetInstanceUIDs: entry.displaySetInstanceUIDs, viewportOptions: { viewportType: 'stack', toolGroupId: 'default', allowUnmatchedView: true } })));
        return true;
      },
      // `signal`: a request the caller dropped while the patient was read again changes nothing (as in compare()).
      async assign(value, displaySetInstanceUIDs, { signal } = {}) {
        if (!admits(value) || !tabs.guard() || signal?.aborted) return false;
        const sets = displaySetInstanceUIDs.map(id => services.displaySetService.getDisplaySetByUID(id));
        if (sets.some(set => !set)) return false;
        const url = new URL('/ohif/viewer', location.origin);
        url.searchParams.set('StudyInstanceUIDs', [...new Set(sets.map(set => set.StudyInstanceUID))].join(','));
        let patient;
        try { patient = await tabs.resolve(url.href); } catch (_) { return false; }
        if (signal?.aborted || !admits(value) || !tabs.guard(true) || patient.key !== value.patientKey) return false;
        services.viewportGridService.setDisplaySetsForViewport({ viewportId: value.viewportId, displaySetInstanceUIDs });
        return true;
      },
      comparisonTarget(value) {
        if (!admits(value)) return null;
        const state = services.viewportGridService.getState();
        return { layout: { ...state.layout }, viewportId: [...state.viewports.values()]
          .find(cell => cell.viewportId !== value.viewportId && !cell.displaySetInstanceUIDs?.length)?.viewportId || null };
      },
      async compare(value, displaySetInstanceUIDs, { signal, studies } = {}) {
        if (!admits(value) || !tabs.guard() || signal?.aborted) return false;
        const grid = services.viewportGridService;
        const signature = () => JSON.stringify([...grid.getState().viewports.values()].map(cell =>
          [cell.viewportId, cell.displaySetInstanceUIDs, cell.x, cell.y, cell.width, cell.height]));
        const before = signature(), sets = displaySetInstanceUIDs.map(id => services.displaySetService.getDisplaySetByUID(id));
        if (!sets.length || sets.some(set => !set)) return false;
        // The prior controller already read these rows for this patient/sequence.
        // Direct seam callers still resolve just the affected studies.
        if (!studies) {
          const uids = [...new Set([value.studyUid, ...sets.map(set => set.StudyInstanceUID)])].join(',');
          const endpoint = session.readOnly() ? '/api/clinician/studies' : '/api/studies';
          const response = await fetch(endpoint + '?uids=' + encodeURIComponent(uids), { credentials: 'same-origin', signal });
          if (window.KinSessionTransport.refusal(response)) throw window.KinSessionTransport.responseError(response);
          if (!response.ok) return false;
          studies = (await response.json()).studies;
        }
        if (signal?.aborted || !admits(value) || before !== signature() || !tabs.guard(true) || sets.some(set =>
          patientOf(studies || [], set.StudyInstanceUID) !== value.patientKey)) return false;
        const preference = window.kinViewerHangingPreference?.(sets[0].Modality) || window.KinViewerHangingSettings.defaults;
        const currentUid = tabs.snapshot().studyUIDs[0], cells = [...grid.getState().viewports.values()];
        // In a window opened on exam scopes every original of the current exam (a merged exam) is current; elsewhere the
        // first opened study is.
        const scoped = /[?&]kinExamScopes=/.test(window.location?.search || '');
        const isCurrent = (study, series) => scoped ? window.KinViewerExamScope?.role?.(study, series) === 'current' : study === currentUid;
        // Images already in the cell's own place (its study; for a split original, its own part by the series) change
        // nothing here. A series of the other part of the same original is another exam and is placed below.
        const place = (study, series) => window.KinExamScope?.imagePlace?.(studies || [], study, series) ?? study;
        const own = place(value.studyUid, value.seriesUid);
        if (sets.every(set => place(set.StudyInstanceUID, set.SeriesInstanceUID) === own)) return true;
        // A prior cell is replaceable. From the current cell, preserve every
        // current image and reuse an assigned comparison or an empty cell.
        const originCell = cells.find(cell => cell.viewportId === value.viewportId);
        const onPriorSide = cell => preference.priorPosition === 'left' ? cell.x < originCell.x : preference.priorPosition === 'top' ? cell.y < originCell.y : preference.priorPosition === 'bottom' ? cell.y > originCell.y : cell.x > originCell.x;
        let target = !isCurrent(value.studyUid, value.seriesUid) ? value.viewportId : cells.find(cell => {
          const rendered = context(cell.viewportId);
          return rendered && !isCurrent(rendered.studyUid, rendered.seriesUid);
        })?.viewportId || cells.find(cell => cell.viewportId !== value.viewportId && !cell.displaySetInstanceUIDs?.length && onPriorSide(cell))?.viewportId;
        if (target) {
          grid.setDisplaySetsForViewport({ viewportId: target, displaySetInstanceUIDs,
            viewportOptions: { viewportType: 'stack', toolGroupId: 'default', allowUnmatchedView: true } });
        } else {
          // With no comparison or vacant cell, the guarded comparison layout
          // keeps the originating current image beside the requested prior.
          if (value.mode !== 'stack') return false;
          target = 'kin-prior-' + crypto.randomUUID();
          const current = cells.find(cell => cell.viewportId === value.viewportId);
          const layout = window.KinViewerHangingSettings.dimensions(preference, true);
          const priorIndex = layout.priorFirst ? 0 : layout.vertical ? layout.columns : 1;
          const currentIndex = layout.priorFirst ? layout.vertical ? layout.columns : 1 : 0;
          grid.setLayout({ numRows: layout.rows, numCols: layout.columns, activeViewportId: value.viewportId, isHangingProtocolLayout: false,
            findOrCreateViewport: index => index === currentIndex ? current : ({ displaySetInstanceUIDs: index === priorIndex ? displaySetInstanceUIDs : [], displaySetOptions: [{}],
              viewportOptions: { viewportId: index === priorIndex ? target : 'kin-prior-' + crypto.randomUUID(), viewportType: 'stack', toolGroupId: 'default', allowUnmatchedView: true } }) });
        }
        return true;
      },
      reportHost: {
        close: closeReport,
        render(value, renderer, lifecycle = {}) {
          if (!admits(value)) return false;
          const pane = services.cornerstoneViewportService.getCornerstoneViewport(value.viewportId)?.element?.closest('[data-cy="viewport-pane"]');
          if (!pane) return false;
          reportContext = value; reportLifecycle = lifecycle; pane.append(report);
          renderer(report, { close: () => closeReport({ restoreFocus: true }), retry: lifecycle.onRetry });
          report.hidden = false; return true;
        },
        show(value, body) {
          if (!admits(value)) return false;
          closeReport();
          const close = document.createElement('button'); close.type = 'button'; close.textContent = 'Close'; close.onclick = closeReport;
          report.append(close);
          for (const [title, content] of [['Previous Report', body.title], ['Findings', body.findings], ['Impression', body.impression]]) {
            const heading = document.createElement('h3'); heading.textContent = title;
            const paragraph = document.createElement('p'); paragraph.textContent = String(content ?? ''); report.append(heading, paragraph);
          }
          const pane = services.cornerstoneViewportService.getCornerstoneViewport(value.viewportId)?.element?.closest('[data-cy="viewport-pane"]');
          if (!pane) return false;
          pane.append(report); reportContext = value; report.hidden = false; return true;
        },
      },
    };
    // The compact tools on each cell's information row: the image toolbar gives the function that fills a cell's
    // row (viewer-ux-toolbar.js) and takes it back when it ends.
    let cellProvider = null;
    seam.cellTools = provider => {
      cellProvider = provider; info.refresh();
      return () => { if (cellProvider === provider) { cellProvider = null; if (!ended) info.refresh(); } };
    };
    seam.refreshCells = () => { if (!ended) info.refresh(); };
    window.KinViewerUX = seam;
    const stopPatient = tabs.subscribe(closeReport);
    const info = window.KinViewerInfoBar.mount({ services, cellTools: () => cellProvider, studyActions: {
      hidden: () => session.readOnly(),
      available: () => !session.readOnly() && typeof actions?.listPriors === 'function',
      open(viewportId, anchor) { const value = context(viewportId); if (value) actions?.listPriors({ ...value, anchor, openImages: actions.openImages, openReport: actions.openReport }); },
    } });
    const series = window.KinViewerSeriesStrip.mount({ services });
    tabs.mount({ services, session, refreshChrome() { info.refresh(); series.refresh(); } });
    const subscriptions = [], abort = new AbortController(), panels = mountSidePanels(session, abort.signal), studies = mountStudyTabs();
    const compact = mountPanels(panels);
    const autoHide = mountAutoHide(abort.signal, { toolbar: () => document.querySelector('.kin-ux-toolbar-slot'), thumbs: () => document.querySelector('.kin-viewer-series-strip') });
    // Rows turned to a side page up and down; the strip's arrows follow.
    const chromeChanged = () => { series.orient?.(); autoHide.changed(); };
    chromeListeners.add(chromeChanged);
    let frame, ended = false;
    // The shell never resizes the rendering engine. The stock viewport observer
    // queues its own resize for every pane whose element changes size and that
    // queued pass re-fits the canvas and restores each camera from its
    // presentation; a shell-driven resize(true) ran that pass synchronously at
    // moments of its own, so whether a rebuilt MPR plane's focal point carried
    // the presentation rounding depended on timing and a cell-merge restore
    // returned planes the user never touched with a camera that differed in
    // the last bit. The shell's rows and the bar take their space before the
    // stock sizes a canvas (theme padding, reserved rows), so nothing of the
    // shell's needs a re-fit of its own.
    function refresh() { frame = null; if (!ended) {
      if (reportContext && !admits(reportContext)) closeReport();
      actions?.refresh?.();
      info.refresh(); series.refresh(); tabs.refresh(); panels.apply(); studies.apply(); compact.apply();
    } }
    function schedule() { if (!ended && !frame) frame = requestAnimationFrame(refresh); }
    for (const service of [services.viewportGridService, services.displaySetService, services.cornerstoneViewportService]) {
      for (const event of Object.values(service.EVENTS || {})) subscriptions.push(service.subscribe(event, () => {
        // Grid replacement is announced before the new canvas paints. Drop
        // clinical headings synchronously, then adopt only rendered identity.
        if (service === services.viewportGridService && event !== service.EVENTS.ACTIVE_VIEWPORT_ID_CHANGED) info.invalidate();
        schedule();
      }));
    }
    const events = window.cornerstone.Enums.Events;
    const imageEvents = [events.PRE_STACK_NEW_IMAGE, events.STACK_NEW_IMAGE, events.IMAGE_RENDERED, events.ELEMENT_ENABLED, events.ELEMENT_DISABLED].filter(Boolean);
    imageEvents.forEach(event => document.addEventListener(event, schedule, true));
    const observer = new MutationObserver(records => {
      if (ended || !records.some(record => {
        if (record.target.closest?.('[data-kin-ux-owned]')) return false;
        // Attaching/removing shell chrome targets the stock pane or column,
        // so inspect the changed nodes as well as the mutation's parent.
        return [...record.addedNodes, ...record.removedNodes].some(node => !node.matches?.('[data-kin-ux-owned]'));
      })) return;
      // The strip and the toolbar's reserved row go above the grid in this same
      // microtask, as soon as the grid exists, and a pane gets its bar in the
      // row its padding reserves: neither changes the size of a canvas the
      // stock has already created.
      series.place(); info.adopt(); panels.apply(); studies.apply(); compact.apply();
      schedule();
    });
    observer.observe(document.getElementById('root'), { childList: true, subtree: true });
    schedule();
    return { dispose() {
      ended = true; cancelAnimationFrame(frame); observer.disconnect(); abort.abort(); autoHide.dispose(); chromeListeners.delete(chromeChanged);
      subscriptions.forEach(subscription => subscription.unsubscribe());
      imageEvents.forEach(event => document.removeEventListener(event, schedule, true));
      stopPatient(); closeReport(); report.remove(); if (window.KinViewerUX === seam) delete window.KinViewerUX;
      tabs.dispose(); info.dispose(); series.dispose(); studies.dispose(); compact.dispose(); document.body.classList.remove('kin-viewer-ux');
    } };
  }
  return { mount, chrome };
})();
