
// Session-only cell merge/maximize. Loaded beside the existing layout controls and
// mounted into the same panel with its own id, so the Recent Layout and Hanging
// Protocol sections keep their markup and their own tests.
function kinCreateCellMerge() {
  // Also run on its own (a page test takes this function out of config/ohif.js): the words then stay as written.
  const kinText = globalThis.kinText || ((t, ...p) => t.replace(/\{[ten]?(\d+)\}/g, (m, i) => String(p[i]))), kinHtml = globalThis.kinHtml || kinText, kinError = globalThis.kinError || ((t, ...p) => Object.assign(new Error(kinText(t, ...p)), { kinWords: true }));
  let ready, current, epoch = 0, ended = false, listening = false, channel, restoreOneUp;
  function endSession() {
    if (ended) return; ended = true; epoch++; current?.stop(); current = null;
    restoreOneUp?.(); restoreOneUp = null;
     window.removeEventListener('pagehide', endSession);
    channel?.close(); channel = null;
  }
  // One double click reaches both the native one-up (on the viewport element) and the cell
  // merge (on document). The native toggle reads only numRows/numCols, so on a screen the
  // merge holds - 1x2 with one cell covering it, or still settling - it switches to its own
  // 1x1 and the merge can no longer put its grid back. While the merge holds the screen the
  // gesture is the merge's alone; everywhere else (3x3, VR/SR/PDF cells, no merge module)
  // the native toggle runs unchanged. Only this one command is replaced, so the click
  // bindings and the right-click menu that share its customization are untouched.
  // A double click on a window over two monitors is the merge's too, when it says so for that
  // very click (claimsDoubleClick): the native toggle would make one cell of the whole window,
  // across the display edge, before the merge's maximize of that cell's monitor could read the
  // screen.
  // The native toggle's one cell is its own (kinViewerStockOneUp): a grid of one cell made by it is put back by it, so
  // nothing else may turn that cell into another layout meanwhile (the display span divides a one-column grid over two
  // monitors). What is owned is the 1 x 1 layout that toggle made - the grid's own layout object, once the grid shows it -
  // together with the id of its one cell, which the toggle keeps from the cell it enlarged. The toggle back, any other
  // layout (the Layout menu's 1 x 1 picked again keeps that id but is a new layout; a saved Job; a protocol) and a new mode
  // end it. Another series dropped on that cell does not: the grid keeps its layout object, and the toggle back still works.
  let oneUp = null;
  function guardOneUp(commandsManager, services) {
    restoreOneUp?.(); restoreOneUp = null; oneUp = null;
    const native = commandsManager?.getCommand?.('toggleOneUp', 'DEFAULT');
    if (typeof native?.commandFn !== 'function') return;
    const grid = services?.viewportGridService;
    const read = () => { try { return grid?.getState?.() || null; } catch (_) { return null; } };
    // The toggle's layout shows in the grid's state a moment after it was asked for (before: the layout object it was asked
    // on). The first layout to show after that is the toggle's when it is that one cell holding the very options object the
    // toggle handed on; a first layout that is anything else is somebody else's, and so is every layout after the toggle's.
    const owned = () => {
      const now = oneUp && read();
      if (!now) return false;
      const cell = now.viewports?.size === 1 ? now.viewports.get(oneUp.id) : null;
      if (!oneUp.layout) {
        if (now.layout === oneUp.before) return true;
        if (cell && cell.viewportOptions === oneUp.options) oneUp.layout = now.layout;
      }
      if (oneUp.layout && now.layout === oneUp.layout && cell) return true;
      oneUp = null; return false;
    };
    // Looked at whenever the grid announces a change, so that the toggle's own layout is known before a later one replaces it.
    const watched = [];
    for (const event of new Set(Object.values(grid?.EVENTS || {}))) try { watched.push(grid.subscribe(event, owned)); } catch (_) { }
    window.kinViewerStockOneUp = owned;
    const guarded = { ...native, commandFn: options => {
      const merge = current?.state?.();
      if (merge && (merge.busy || merge.merged)) return;
      if (current?.claimsDoubleClick?.()) return;
      // As the toggle itself reads the grid: one that is not 1 x 1 goes to one cell, the active one's; a 1 x 1 goes back.
      const now = read(), cell = now?.viewports?.get?.(now.activeViewportId);
      oneUp = cell && !(now.layout?.numRows === 1 && now.layout?.numCols === 1)
        ? { id: cell.viewportOptions?.viewportId ?? cell.viewportId ?? now.activeViewportId, options: cell.viewportOptions, before: now.layout, layout: null } : null;
      try { return native.commandFn(options); } catch (error) { oneUp = null; throw error; }
    } };
    commandsManager.registerCommand('DEFAULT', 'toggleOneUp', guarded);
    restoreOneUp = () => {
      watched.splice(0).forEach(subscription => { try { subscription?.unsubscribe?.(); } catch (_) { } });
      oneUp = null;
      if (window.kinViewerStockOneUp === owned) delete window.kinViewerStockOneUp;
      if (commandsManager.getCommand('toggleOneUp', 'DEFAULT') === guarded) commandsManager.registerCommand('DEFAULT', 'toggleOneUp', native);
    };
  }

  function watchSession() {
    if (listening) return; listening = true;
     window.addEventListener('pagehide', endSession);
    try { channel = kinViewerOnEnd(() => endSession()); } catch (_) { }
  }
  function prepare() {
    if (window.KinViewerCellMerge) return Promise.resolve(window.KinViewerCellMerge);
    if (!ready) ready = new Promise((resolve, reject) => {
      const script = document.createElement('script'); script.src = '/worklist/hpacs-lite/viewer-cell-merge.js';
      const timer = setTimeout(() => finish(kinError("칸 병합 도구를 불러오지 못했습니다. 뷰어를 다시 여세요.")), 10000);
      function finish(error) { clearTimeout(timer); script.onload = script.onerror = null; if (error) { script.remove(); reject(error); } else resolve(window.KinViewerCellMerge); }
      script.onload = () => finish(window.KinViewerCellMerge ? null : kinError("칸 병합 모듈을 확인할 수 없습니다."));
      script.onerror = () => finish(kinError("칸 병합 도구를 불러오지 못했습니다. 뷰어를 다시 여세요."));
      document.head.append(script);
    }).catch(error => { ready = null; throw error; });
    return ready;
  }
  return { id: 'kin.cell-merge', onModeEnter({ servicesManager, commandsManager }) {
    if (ended) return; watchSession();
    const ticket = ++epoch; current?.stop(); current = null;
    guardOneUp(commandsManager, servicesManager?.services);
    prepare().then(module => {
      if (ticket !== epoch) return;
      const connected = module.create(servicesManager.services);
      if (!connected.mount()) { connected.stop(); throw kinError("칸 병합 패널을 연결하지 못했습니다."); }
      current = connected;
    }).catch(error => { if (ticket === epoch) { const status = document.querySelector('#kin-viewer-layout-status'); if (status) status.textContent = error.message; } });
  }, onModeExit() { epoch++; current?.stop(); current = null; restoreOneUp?.(); restoreOneUp = null; } };
}
