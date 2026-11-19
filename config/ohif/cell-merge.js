
// Session-only cell merge/maximize. Loaded beside the existing layout controls and
// mounted into the same panel with its own id, so the Recent Layout and Hanging
// Protocol sections keep their markup and their own tests.
function kinCreateCellMerge() {
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
  // A window over two monitors is the merge's too (claimsDoubleClick): the native toggle
  // would make one cell of the whole window, across the display edge, before the merge's
  // maximize of that cell's monitor could read the screen.
  // The native toggle's one cell is its own (kinViewerStockOneUp): a grid of one cell made by it is put back by it, so
  // nothing else may turn that cell into another layout meanwhile (the display span divides a one-column grid over two
  // monitors). On while the native toggle went from several cells to one and the grid still has one; a new mode is off.
  let stockOneUp = false;
  function guardOneUp(commandsManager, services) {
    restoreOneUp?.(); restoreOneUp = null; stockOneUp = false;
    const native = commandsManager?.getCommand?.('toggleOneUp', 'DEFAULT');
    if (typeof native?.commandFn !== 'function') return;
    const cells = () => { try { return services?.viewportGridService?.getState?.()?.viewports?.size ?? 0; } catch (_) { return 0; } };
    // Any grid of several cells since (the toggle back, a Layout, a protocol) ends it - not the grid's own announcement of
    // the toggle, which can come while its state still shows the cells it had (toggled: the moment of the toggle).
    let toggled = 0;
    const grid = services?.viewportGridService, ended = () => { if (Date.now() - toggled > 1500 && cells() > 1) stockOneUp = false; };
    const watched = [];
    for (const event of new Set(Object.values(grid?.EVENTS || {}))) try { watched.push(grid.subscribe(event, ended)); } catch (_) { }
    window.kinViewerStockOneUp = () => { ended(); return stockOneUp && cells() === 1; };
    const guarded = { ...native, commandFn: options => {
      const merge = current?.state?.();
      if (merge && (merge.busy || merge.merged)) return;
      if (current?.claimsDoubleClick?.()) return;
      stockOneUp = cells() > 1; toggled = Date.now();
      return native.commandFn(options);
    } };
    commandsManager.registerCommand('DEFAULT', 'toggleOneUp', guarded);
    restoreOneUp = () => {
      watched.splice(0).forEach(subscription => { try { subscription?.unsubscribe?.(); } catch (_) { } });
      stockOneUp = false;
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
      const timer = setTimeout(() => finish(new Error('칸 병합 도구를 불러오지 못했습니다. 뷰어를 다시 여세요.')), 10000);
      function finish(error) { clearTimeout(timer); script.onload = script.onerror = null; if (error) { script.remove(); reject(error); } else resolve(window.KinViewerCellMerge); }
      script.onload = () => finish(window.KinViewerCellMerge ? null : new Error('칸 병합 모듈을 확인할 수 없습니다.'));
      script.onerror = () => finish(new Error('칸 병합 도구를 불러오지 못했습니다. 뷰어를 다시 여세요.'));
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
      if (!connected.mount()) { connected.stop(); throw new Error('칸 병합 패널을 연결하지 못했습니다.'); }
      current = connected;
    }).catch(error => { if (ticket === epoch) { const status = document.querySelector('#kin-viewer-layout-status'); if (status) status.textContent = error.message; } });
  }, onModeExit() { epoch++; current?.stop(); current = null; restoreOneUp?.(); restoreOneUp = null; } };
}
