

    // ── 공통 이벤트 ──
    // 판독 창 위치는 계정 데이터가 아니라 이 브라우저·이 장비의 작업환경 설정이다.
    const OHIF_RECT_KEY = "kin.ohif.current.rect";
    const OHIF_SPAN_SCREENS_KEY = "kin.ohif.span.screens";
    let ohifPopupHandle = null;
    const ohifRectPolls = new Map(), ohifPopupSlots = new WeakMap(), ohifPopupSequences = new WeakMap();
    const ohifPlacementWrites = new WeakMap();
    let ohifOpenSeq = 0;
    let monitorPermission = null;
    let monitorQueryUnsupported = false;
    let monitorSessionGranted = false;
    let screensCache = [];
    let monitorDetails = null;
    let monitorHintShown = false;
    // Settles once the display permission (and, when granted, the screens) is known.
    let monitorReady = Promise.resolve();

    function monitorPermissionGranted() {
      return monitorPermission?.state === "granted" ||
        (monitorQueryUnsupported && monitorSessionGranted);
    }

    function updateMonitorButton() {
      // PBP 기계 대수가 아니라 OS가 인식한 확장 디스플레이 구성으로 판단.
      // OS가 2개를 확장 화면으로 인식하면 true; 복제 출력·단일 논리 화면이면 보장 없음.
      // Permissions Policy 차단 시 false이므로 false만으로 물리 1대라 단정하지 않음.
      const visible = typeof window.getScreenDetails === "function" && screen.isExtended === true &&
        (monitorPermission?.state === "prompt" || (monitorQueryUnsupported && !monitorSessionGranted));
      $("#b-monitor").style.display = visible ? "" : "none";
    }

    function cacheMonitorScreens(details) {
      if (!monitorPermissionGranted()) return;
      if (monitorDetails && monitorDetails !== details) monitorDetails.onscreenschange = null;
      monitorDetails = details;
      const refresh = () => {
        if (monitorPermissionGranted()) screensCache = details.screens.map(usableScreenRect).filter(Boolean);
        updateMonitorButton();
      };
      details.onscreenschange = refresh;
      refresh();
    }

    async function initMonitorPermission() {
      if (typeof window.getScreenDetails !== "function") return;
      try {
        monitorPermission = await navigator.permissions.query({ name: "window-management" });
        monitorPermission.onchange = () => {
          // 철회 뒤에는 이전 화면 목록으로 저장 위치를 보정하지 않는다.
          if (!monitorPermissionGranted()) {
            screensCache = [];
            if (monitorDetails) monitorDetails.onscreenschange = null;
            monitorDetails = null;
          }
          updateMonitorButton();
        };
        updateMonitorButton();
      } catch (e) {
        monitorQueryUnsupported = e instanceof TypeError;
        updateMonitorButton();
        return;
      }
      if (monitorPermissionGranted()) {
        try { cacheMonitorScreens(await window.getScreenDetails()); } catch (_) {}
      }
    }

    $("#b-monitor").addEventListener("click", async () => {
      // 권한 창에 답하는 사이 준비·종료가 있었으면 그 답으로 업무 화면의 안내·저장 위치를 바꾸지 않는다.
      const at = work.capture("document");
      let details = null;
      try { details = await window.getScreenDetails(); } catch (_) {}
      work.commit(at, () => {
        if (details) {
          if (monitorQueryUnsupported) monitorSessionGranted = true;
          cacheMonitorScreens(details);
          updateMonitorButton();
          toast("모니터 배치 허용됨 — Viewer Windows에서 두 화면을 선택하세요. 기존 창 위치는 유지합니다.", "info");
        } else {
          monitorSessionGranted = false;
          updateMonitorButton();
          toast("허용되지 않아 창 자리 기억만 동작합니다 — 다시 켜려면 크롬 사이트 설정에서 '창 관리' 허용", "info");
        }
      });
    });
    screen.addEventListener?.("change", updateMonitorButton);
    monitorReady = initMonitorPermission();

    function usableScreenRect(value) {
      const left = Number(value?.availLeft ?? value?.left ?? 0);
      const top = Number(value?.availTop ?? value?.top ?? 0);
      const width = Number(value?.availWidth ?? value?.width ?? 0);
      const height = Number(value?.availHeight ?? value?.height ?? 0);
      if (![left, top, width, height].every(Number.isFinite) || width <= 0 || height <= 0) return null;
      return { left, top, width, height };
    }

    function currentScreenRect() {
      return usableScreenRect(screen) || { left: 0, top: 0, width: 1280, height: 720 };
    }

    function defaultOhifRect(target = currentScreenRect()) {
      const width = Math.min(target.width, Math.max(640, Math.min(1600, target.width - 80)));
      const height = Math.min(target.height, Math.max(600, Math.min(1000, target.height - 80)));
      return {
        left: Math.min(target.left + 40, target.left + target.width - width),
        top: Math.min(target.top + 40, target.top + target.height - height),
        width,
        height,
      };
    }

    function readStoredOhifRect(slot = 0) {
      try {
        const value = JSON.parse(localStorage.getItem(slot ? OHIF_RECT_KEY + ':' + slot : OHIF_RECT_KEY) || "null");
        const rect = {
          left: Number(value?.left), top: Number(value?.top),
          width: Number(value?.width), height: Number(value?.height),
        };
        return [rect.left, rect.top, rect.width, rect.height].every(Number.isFinite) &&
          rect.left > -30000 && rect.top > -30000 &&
          rect.width >= 320 && rect.height >= 240 ? rect : null;
      } catch (_) { return null; }
    }

    function rectInsideScreen(rect, target) {
      return rect.left >= target.left && rect.top >= target.top &&
        rect.left + rect.width <= target.left + target.width &&
        rect.top + rect.height <= target.top + target.height;
    }

    function overlapArea(rect, target) {
      const width = Math.max(0, Math.min(rect.left + rect.width, target.left + target.width) -
        Math.max(rect.left, target.left));
      const height = Math.max(0, Math.min(rect.top + rect.height, target.top + target.height) -
        Math.max(rect.top, target.top));
      return width * height;
    }

    function clampOhifRect(rect, screens) {
      const targets = screens.length ? screens : [currentScreenRect()];
      if (targets.some(target => rectInsideScreen(rect, target))) return rect;
      const target = targets.reduce((best, candidate) =>
        overlapArea(rect, candidate) > overlapArea(rect, best) ? candidate : best);
      const width = Math.min(rect.width, target.width);
      const height = Math.min(rect.height, target.height);
      return {
        left: Math.min(Math.max(rect.left, target.left), target.left + target.width - width),
        top: Math.min(Math.max(rect.top, target.top), target.top + target.height - height),
        width,
        height,
      };
    }

    function readOhifSpanScreens() {
      try {
        const selected = JSON.parse(localStorage.getItem(OHIF_SPAN_SCREENS_KEY) || 'null');
        return KinViewerDisplayLayout.span(selected) ? selected : null;
      } catch (_) { return null; }
    }

    function ohifSpanTarget() {
      const selected = readOhifSpanScreens();
      if (!selected || !monitorPermissionGranted()) return null;
      const matched = selected.map(saved => screensCache.find(s => KinViewerDisplayLayout.identity(s) === KinViewerDisplayLayout.identity(saved)));
      return KinViewerDisplayLayout.span(matched);
    }

    function ohifPlacement(stored, details = null) {
      const screens = (details?.screens || []).map(usableScreenRect).filter(Boolean);
      const selected = readOhifSpanScreens(), span = ohifSpanTarget();
      if (selected) {
        // A missing display is not a successful new layout. The launch path
        // suspends saving until the user moves/resizes the remaining window.
        if (!span) return defaultOhifRect(currentScreenRect());
        return stored && rectInsideScreen(stored, span) ? stored : span;
      }
      // Also restore a manually spanned window without fitting it to one screen. Spanned is the one judgement of a window
      // over two displays (KinViewerDisplayLayout.covered, as spanReached judges a dragged window): a window that filled
      // one display by its edges, its resize border a few px over the next one, is that one display's.
      if (stored && monitorPermissionGranted() && KinViewerDisplayLayout.covered(stored, screensCache).length >= 2) return stored;
      // 권한 없이 현재 화면 하나로 clamp하면 다른 모니터의 저장 자리를 끌어온다.
      if (stored) return monitorPermissionGranted() && screensCache.length
        ? clampOhifRect(stored, screensCache) : stored;

      if (screens.length > 1) {
        const current = usableScreenRect(details.currentScreen);
        const other = screens.find(candidate => !current ||
          candidate.left !== current.left || candidate.top !== current.top ||
          candidate.width !== current.width || candidate.height !== current.height);
        // 화면을 꽉 채우면 드래그 뒤 크롬이 원점으로 밀어 넣어 자리 기억 실패처럼 보인다.
        if (other) return defaultOhifRect(other);
      }
      return defaultOhifRect(currentScreenRect());
    }

    // The displays a viewer window was to stand over when the browser kept it on one (it moves a window over one display
    // only): the known displays the intended rectangle is laid over (KinViewerDisplayLayout.covered), when they are two or
    // more. Without the display access nothing is known: [].
    function spanTargets(intended) {
      if (!intended || !monitorPermissionGranted()) return [];
      const over = KinViewerDisplayLayout.covered(intended, screensCache);
      return over.length >= 2 ? over : [];
    }
    // The two displays chosen for the viewer window (Viewer Displays), as they are among the displays known now; null when
    // none are chosen, one of them is not there, or the display access is not given.
    function ohifSpanPair() {
      const selected = readOhifSpanScreens();
      if (!selected || !monitorPermissionGranted()) return null;
      return selected.every(saved => screensCache.some(s => KinViewerDisplayLayout.identity(s) === KinViewerDisplayLayout.identity(saved))) ? selected : null;
    }
    // The pair of displays under a window nobody chose displays for: the two it is laid over, when they are exactly two.
    // Over three no pair is guessed.
    function spanPairUnder(rect) {
      const over = monitorPermissionGranted() ? KinViewerDisplayLayout.covered(rect, screensCache) : [];
      return over.length === 2 ? over : null;
    }
    // A window that is minimized or hidden: its coordinates then say nothing about where it stands.
    function popupHidden(popup) {
      try { return popup.document.visibilityState === 'hidden'; } catch (_) { return false; }
    }
    // The one judgement of a viewer window standing over two displays, for a window the browser put there at once and for
    // one the reader dragged there: made on where the window stands now, with the display access given, and never of a
    // window that is closed, minimized or hidden. wanted: the two displays chosen - both must be under the window; null:
    // only a saved place said so - then any two displays or more, and a pair only when they are exactly two. Returns
    // { rect, pair } - the window rectangle judged and the two displays confirmed under it (null: more than two) - or
    // null: not there, or not to be judged now.
    function spanReached(popup, wanted) {
      const rect = popupHidden(popup) || !monitorPermissionGranted() ? null : popupRect(popup);
      if (!rect) return null;
      if (wanted) return KinViewerDisplayLayout.covers(rect, wanted) ? { rect, pair: wanted } : null;
      return KinViewerDisplayLayout.covered(rect, screensCache).length >= 2 ? { rect, pair: spanPairUnder(rect) } : null;
    }
    // The viewer window was to stand over two displays and the browser kept it on one: this watches for the window to
    // stand there after all (spanReached), the reader having dragged it (or the window being there already, away from the
    // exact place asked for: then at once, and true is returned - nobody is asked to drag). done(rect, pair) runs once.
    // The wait is for the window itself: the same window with the next patient opened in it is still waited for. It ends
    // without a word when the window is closed or is no longer the one this list holds for its slot (another window took
    // the slot), still() no longer holds (the list's account or context changed, another move was asked), the display
    // access was taken back, a chosen display is gone, or after two minutes; a window minimized meanwhile is not judged.
    // A later move is still saved as any move is (watchOhifRect).
    function awaitSpan(popup, wanted, still, done) {
      const until = Date.now() + 120000, slot = ohifPopupSlots.get(popup) || 0;
      const known = target => screensCache.some(s => KinViewerDisplayLayout.identity(s) === KinViewerDisplayLayout.identity(target));
      const held = () => viewerWindows.rows().some(row => row.index === slot && row.popup === popup);
      const look = () => {
        let going = false;
        try { going = !popup.closed && monitorPermissionGranted() && held() && still() && (!wanted || wanted.every(known)); } catch (_) { going = false; }
        if (!going || Date.now() > until) return 'ended';
        const stands = spanReached(popup, wanted);
        if (!stands) return 'waiting';
        done(stands.rect, stands.pair);
        return 'reached';
      };
      const first = look();
      if (first === 'waiting') { const timer = setInterval(() => { if (look() !== 'waiting') clearInterval(timer); }, 500); }
      return first === 'reached';
    }
    // The display choice stored now (Viewer Displays), as it is written: what a placement began with (its gate's choice).
    function storedSpanChoice() {
      try { return localStorage.getItem(OHIF_SPAN_SCREENS_KEY); } catch (_) { return null; }
    }
    // A viewer window standing over two displays is remembered here, whichever way it got there (Span Displays, or the
    // placement of a window as it opens; moved there by the browser at once, or dragged there by the reader): the window
    // rectangle the judgement was made on goes to that window's slot, and the two displays confirmed under it become this
    // browser's Viewer Displays. pair null: no pair to write (more than two displays under the window). since: for an
    // opening, the stored choice as it was when the window began to open - written back when the choice is still that, or
    // was only dropped meanwhile (a window dragged after a refused placement drops it); a choice made since for another
    // window is kept. The window counts as placed from here on: its later moves are saved as any window's.
    // Returns what was written, { rect, pair }: either can fail by itself.
    function rememberSpan(popup, rect, pair, since) {
      const written = { rect: false, pair: false };
      try {
        const slot = ohifPopupSlots.get(popup) || 0;
        localStorage.setItem(slot ? OHIF_RECT_KEY + ':' + slot : OHIF_RECT_KEY, JSON.stringify(rect));
        written.rect = true;
      } catch (_) {}
      try {
        const now = pair ? localStorage.getItem(OHIF_SPAN_SCREENS_KEY) : null;
        if (pair && (since === undefined || now === null || now === since)) localStorage.setItem(OHIF_SPAN_SCREENS_KEY, JSON.stringify(pair));
        written.pair = true;
      } catch (_) {}
      ohifPlacementWrites.delete(popup);
      return written;
    }

    function popupRect(popup) {
      try {
        if (!popup || popup.closed) return null;
        const rect = {left:Number(popup.screenX),top:Number(popup.screenY),width:Number(popup.outerWidth),height:Number(popup.outerHeight)};
        return Object.values(rect).every(Number.isFinite) && rect.left > -30000 && rect.top > -30000 && rect.width >= 320 && rect.height >= 240 ? rect : null;
      } catch (_) { return null; }
    }
    function rememberOhifRect(popup = ohifPopupHandle) {
      try {
        if (!popup || popup.closed) return false;
        // 최소화·닫힘 전이의 좌표로 마지막 정상 자리를 덮지 않는다.
        try { if (popup.document.visibilityState === "hidden") return false; } catch (_) {}
        const rect = popupRect(popup);if (!rect) return false;
        const suspended = ohifPlacementWrites.get(popup);
        if (suspended) {
          if (suspended.pending) return false;
          // A minimized/unreadable window has no baseline. Establish one after
          // restoration, preserving the saved position until a subsequent move.
          if (!suspended.baseline) { suspended.baseline = rect; return false; }
          if (Object.keys(rect).every(k => rect[k] === suspended.baseline[k])) return false;
          // After a failed placement, an actual user move resumes position saving.
          // Restore that manual rectangle next time, including when display
          // permission was denied or a previously selected screen disappeared.
          // The display choice dropped is the one that placement began with (the gate's choice): displays chosen since
          // then, for another window, are not this window's to drop.
          if (suspended.choice === undefined || storedSpanChoice() === suspended.choice) localStorage.removeItem(OHIF_SPAN_SCREENS_KEY);
          ohifPlacementWrites.delete(popup);
        }
        const slot = ohifPopupSlots.get(popup) || 0;
        localStorage.setItem(slot ? OHIF_RECT_KEY + ':' + slot : OHIF_RECT_KEY, JSON.stringify(rect));
        return true;
      } catch (_) { return false; }
    }

    // A window this list no longer holds (the list was reloaded) reports its own
    // moves; the registry passes them only for a slot without a held window.
    function rememberReportedOhifRect(slot, rect) {
      try { localStorage.setItem(slot ? OHIF_RECT_KEY + ':' + slot : OHIF_RECT_KEY, JSON.stringify(rect)); } catch (_) { return; }
      // As for a held window moved after a failed placement: a selected span that cannot be placed now
      // would make the next open ignore this place. The reloaded list reports the move as soon as it
      // asks, so judge the span only once its display permission and screens are known.
      const at = work.capture("document");
      monitorReady.then(() => work.commit(at, () => {
        if (readOhifSpanScreens() && !ohifSpanTarget()) localStorage.removeItem(OHIF_SPAN_SCREENS_KEY);
      })).catch(() => {});
    }

    function watchOhifRect(popup, slot = ohifPopupSlots.get(popup) || 0) {
      ohifPopupHandle = popup;
      ohifPopupSlots.set(popup, slot);
      rememberOhifRect(popup);
      if (ohifRectPolls.has(popup)) return;
      const timer = setInterval(() => {
        if (popup.closed) {
          clearInterval(timer); ohifRectPolls.delete(popup);
          return;
        }
        // 창 자리를 적는 일도 주기마다 그때의 문맥을 지난다: 로그아웃 준비 중이나 세션이 끝난 뒤에는 저장소에 쓰지 않는다.
        work.commit(work.capture("document"), () => { rememberOhifRect(popup); });
      }, 2000);
      ohifRectPolls.set(popup, timer);
    }

    window.addEventListener("pagehide", () => { for (const [popup, timer] of ohifRectPolls) { rememberOhifRect(popup); clearInterval(timer); } ohifRectPolls.clear(); });