

    // ══════════ 우클릭 컨텍스트 메뉴 (모드·대상에 따라 항목이 달라짐) ══════════
    const ctx = $("#ctx");
    let ctxItems = [];
    let ctxOpener = null;
    // 행·오더 메뉴를 연 그 선택({uid, seq, oid}: 검사 UID·선택 순번·고른 오더). 다른 메뉴(상용구·저장 검색)는 선택에 묶이지 않는다(null).
    let ctxTarget = null;
    // A menu opened from the keyboard on a row: where the focus goes back when it closes, if the element that had the
    // focus was replaced meanwhile (the list is drawn again when the row is selected). Mouse menus keep ctxOpener only.
    let ctxBack = null;
    function showCtx(e, items, keyboard = null, target = null) {
      ctxOpener = document.activeElement;
      ctxBack = keyboard?.back ?? null;
      ctxItems = items;
      ctxTarget = target;
      ctx.setAttribute('role', 'menu');
      ctx.replaceChildren(...items.map((item, index) => {
        const el = document.createElement(item.sep ? "hr" : "div");
        el.setAttribute("role", item.sep ? "separator" : "menuitem");
        if (item.sep) return el;
        el.dataset.i = index;
        el.tabIndex = -1;
        el.setAttribute("aria-disabled", String(!!item.dis));
        if (item.dis) el.className = "dis";
        if (item.title) kinWrite(el, item.title, "title");
        return kinWrite(el, item.label);
      }));
      ctx.style.left = Math.max(0, Math.min(keyboard?.x ?? e.clientX, innerWidth - 200)) + "px";
      ctx.style.top = Math.max(0, Math.min(keyboard?.y ?? e.clientY, innerHeight - (items.length * 28 + 20))) + "px";
      ctx.style.display = "block";
      // With every item grey the menu itself takes the focus, so Escape and Tab still close it.
      if (keyboard?.focus) {
        const first = ctx.querySelector('[data-i]:not(.dis)');
        if (!first) ctx.tabIndex = -1;
        (first ?? ctx).focus();
      }
    }
    /** The focus goes back to the row a keyboard menu was opened on (as drawn now), else to what had it when it opened. */
    function ctxReturnFocus() {
      const back = (ctxBack && ctxBack()) || ctxOpener;
      back?.focus();
    }
    /**
     * The ContextMenu key and Shift+F10 on a row open its menu from the keyboard (as on a saved-search chip): the first
     * item takes the focus. The browser may also fire its own `contextmenu` for the same key press (after keydown, or
     * on keyup however long the key was held); the first one is dropped. A pointer press or another key ends the key's
     * turn, so a later right-click or menu key is never taken for it.
     */
    let ctxKeyPending = false;
    const isMenuKey = e => e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10');
    const ctxFromKey = e => {
      if (!ctxKeyPending) return false;
      ctxKeyPending = false; e.preventDefault(); return true;
    };
    document.addEventListener('pointerdown', () => { ctxKeyPending = false; }, true);
    document.addEventListener('keydown', e => { if (!isMenuKey(e) && e.key !== 'Shift') ctxKeyPending = false; }, true);
    // Wherever that browser `contextmenu` lands (the row, or the menu item that now has the focus), it is dropped here once.
    document.addEventListener('contextmenu', e => { if (ctxFromKey(e)) e.stopPropagation(); }, true);
    /** Where a keyboard menu of a row opens and where its focus goes back: that row as it is drawn now. */
    function rowKeyboard(find) {
      const tr = find(), rect = tr?.getBoundingClientRect();
      return { x: rect?.left ?? 0, y: rect?.bottom ?? 0, focus: true, back: find };
    }
    // Tele-reading is a later feature (Part 2): its row menu items keep their names and places and only say so.
    const TELE_LATER = "원격판독은 나중에 생길 기능입니다 — 지금은 의뢰·취소·판독 시작을 보내지 않습니다";
    const teleLater = () => toast(kinSay(TELE_LATER), "info", 6000);
    ctx.addEventListener('keydown', e => {
      const items = [...ctx.querySelectorAll('[data-i]:not(.dis)')];
      const index = items.indexOf(document.activeElement);
      if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) {
        e.preventDefault(); e.stopPropagation();
        const next = e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1
          : (index + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
        items[next]?.focus();
      } else if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault(); e.stopPropagation(); items[index]?.click();
      } else if (e.key === 'Escape' || e.key === 'Tab') {
        if (e.key === 'Escape') e.preventDefault();
        e.stopPropagation(); ctx.style.display = 'none'; ctxReturnFocus();
      }
    });
    ctx.addEventListener("click", async e => {
      const d = e.target.closest("div[data-i]"); if (!d) return;
      const it = ctxItems[+d.dataset.i];
      if (it.dis) return;
      ctx.style.display = 'none';
      ctxReturnFocus();
      // A keyboard menu's item may draw the list again (Verify, Match…): the focus then goes back to that row as drawn.
      const back = ctxBack;
      const refocus = () => { if (back && (!document.activeElement || document.activeElement === document.body)) back()?.focus(); };
      /**
       * 행·오더 메뉴의 항목은 **메뉴를 연 그 선택**에 대한 것이다(W4-PAGE-10 MENU-TARGET). 여럿이 실행할 때의 지금 선택에 닿는다 —
       * Match·Unmatch·Modify Exam은 `cur()`·`curOrder()`를, 판독문 작성으로는 지금 편집기를 쓴다. 메뉴가 열린 채 키보드로 다른 행을
       * 골랐거나 오더 선택이 바뀌었으면 그 항목은 **다른 검사**에 요청을 보낸다. 그래서 실행 직전에 메뉴를 연 검사·선택 순번·오더가
       * 지금과 같은지 보고, 다르면 아무것도 보내지 않고 그렇다고 말한다 — 그 행에서 메뉴를 다시 열면 된다(A→B→A도 같은 선택이 아니다).
       */
      const target = ctxTarget;
      if (target && (target.uid !== selectedUid || target.seq !== selectionSeq || target.oid !== selectedOid)) {
        toast("메뉴를 연 뒤 선택한 검사가 바뀌어 실행하지 않았습니다 — 그 행에서 메뉴를 다시 여세요", "err");
        return;
      }
      /**
       * **`act()`를 await하고 catch한다.**
       *
       * 메뉴 항목의 절반이 async다(원격판독 의뢰, Match/Unmatch, 삭제…).
       * 예전엔 그냥 `it.act()`라 예외가 unhandled rejection으로 콘솔에만 남고
       * **사용자에게는 아무 반응도 없었다.** 눌렀는데 아무 일도 안 일어나면
       * 사람은 한 번 더 누른다 — 되돌릴 수 없는 항목에서는 그게 두 번 실행이다.
       */
      const at = work.capture("document");
      try { const done = it.act(); refocus(); await done; }
      // 항목이 기다리는 사이 작업 문맥이 바뀌었으면(로그아웃 준비·세션 종료) 그 실패는 알릴 실패가 아니다.
      catch (err) { work.commit(at, () => toast(String(kinSayEn("\"{0}\" 실패: {e1}", it.label, err?.message ?? err)), "err")); }
      finally { refocus(); }
    });
    document.addEventListener("click", () => ctx.style.display = "none");

    /**
     * 행의 메뉴는 **그 행의 검사가 지금 선택일 때만** 연다(W4-PAGE-10 MENU-TARGET). 메뉴의 항목(판독문 작성으로, Unmatch…)은
     * 지금 선택을 대상으로 하므로, 선택이 그 행으로 옮겨지지 않았는데(글자 조합 중, 쓰던 글의 저장 대기·거절) 그 행의 메뉴를
     * 띄우면 항목이 **앞 검사**에 닿는다. 저장을 기다려 옮겨지면 그때 같은 자리에 연다. 메뉴는 연 그 선택에 묶여, 그 사이
     * 선택이 바뀌었으면 어느 항목도 실행하지 않는다(위 클릭 처리).
     */
    function openRowMenu(e, tr, fromKey) {
      const uid = tr.dataset.uid;
      const keyboard = fromKey
        ? () => rowKeyboard(() => $("#rows").querySelector(`tr[data-uid="${CSS.escape(uid)}"]`)) : () => null;
      // W9: a row of the current multi-selection (two or more) opens the selection's own menu. It is offered before any
      // select(): opening it moves no Reading Target and saves or holds nothing. Its one item acts on the selection as it
      // was when the menu opened (owner, generation, ordered UIDs); a changed selection closes it (closeSelectionMenu).
      const set = mode === "Radiology" && multiSelection?.has(uid) ? multiStudyView?.menu() : null;
      if (set) { showSelectionMenu(e, set, keyboard()); return; }
      whenSelected(select(uid), uid, () => showRowMenu(e, uid, keyboard()));
    }
    $("#rows").addEventListener("contextmenu", e => {
      const tr = e.target.closest("tr");
      if (!tr?.dataset.uid) return;
      e.preventDefault();
      openRowMenu(e, tr, false);
    });
    $("#rows").addEventListener("keydown", e => {
      if (!isMenuKey(e)) return;
      const tr = e.target.closest("tr");
      if (!tr?.dataset.uid) return;
      e.preventDefault();
      ctxKeyPending = true;
      openRowMenu(e, tr, true);
    });
    let ctxSelection = null;
    function showSelectionMenu(e, set, keyboard = null) {
      showCtx(e, [{ label: kinSay("Open Selected Studies"),
        act: () => { ctxSelection = null; multiStudyView?.open(set); } },
        // FC-028: the same Batch Reading as the selection bar, for the selection as it was when this menu opened.
        ...(batchReport?.shown() ? [{ label: kinSay("Batch Reading"), dis: !!batchReport.blocked(),
          act: () => { ctxSelection = null; batchReport?.open(set); } }] : []),
        // FC-029: the same Batch Approve as the selection bar, after Batch Reading.
        ...(batchApprove?.shown() ? [{ label: kinSay("Batch Approve"), dis: !!batchApprove.blocked(),
          act: () => { ctxSelection = null; batchApprove?.open(set); } }] : [])], keyboard, null);
      ctxSelection = { items: ctxItems, generation: set.generation };
    }
    /** The selection changed from the one the open selection menu was offered for: that menu closes before anything can act. */
    function closeSelectionMenu(generation) {
      if (!ctxSelection || ctxSelection.generation === generation) return;
      if (ctxItems === ctxSelection.items && ctx.style.display === "block") {
        const focused = ctx.contains(document.activeElement);
        ctx.style.display = "none";
        if (focused) ctxReturnFocus();
      }
      ctxSelection = null;
    }
    function showRowMenu(e, uid, keyboard = null) {
      const s = studies.find(x => x.uid === uid);
      // 이 메뉴가 열린 선택. 항목은 이 선택이 그대로일 때만 실행된다(위 클릭 처리).
      const opened = { uid, seq: selectionSeq, oid: selectedOid };
      const forceReleaseItems = KinAuth.has("admin") && s?.holder ? [{
        label: kinSay("점유 강제 해제 (관리자)"), dis: s.holderMine === true, act: async () => {
          // 서버가 하는 일 그대로: 점유만 풀린다(api/src/pacs/hold.ts forceRelease). 이름은 자료라 번역되지 않는 자리({0})로.
          if (!confirm(kinSay("{0} 님의 점유를 강제로 해제할까요? 저장된 초안은 그대로 남고, 해제 내역은 감사로그에 기록됩니다. 다른 사람이 먼저 점유하지 않으면 그분은 이어서 저장할 수 있습니다.", writerName(s.holderName, s.holder)))) return;
          const at = work.capture("document");
          try { await api("POST", `/studies/${encodeURIComponent(uid)}/release/force`, undefined, undefined, at); }
          catch (e) { work.commit(at, () => apiFail(e)); return; }
          work.commit(at, () => {
            s.holder = null; s.holderName = null; s.holderMine = false;
            appState[uid] = { ...appState[uid], holder: null, holderName: null, holderMine: false };
            render();
            if (uid === selectedUid) { updateReportButtons(); loadReport(); }
            toast("점유를 해제했습니다 (감사로그 기록)");
          });
        },
      }] : [];
      // FA-090 Open EMR: the institution's EMR Link filled with this row's values, opened in a new tab inside this click.
      // Grey when no EMR Link is set or for a study received for tele-reading (our EMR does not hold the other hospital's
      // patient IDs). The values are read from the list as it is at the click: a refresh while the menu was open may have
      // replaced the row (a Match changes the patient ID it shows).
      const emrLink = () => KinAuth.session()?.emrLink?.template ?? null;
      const openEmrItem = { label: kinSay("Open EMR"), dis: !emrLink() || !!s?.tele, act: () => {
        const row = studies.find(x => x.uid === opened.uid);
        if (!row) { toast("이 검사를 목록에서 찾을 수 없습니다", "err"); return; }
        if (row.tele) { toast("원격판독으로 받은 검사는 EMR을 열 수 없습니다", "err"); return; }
        const result = KinEmrLink.open(emrLink(), row);
        if (result.error) toast(result.error, "err");
      } };
      if (mode === "Radiology") {
        showCtx(e, [
          { label: kinSay("Film Box 열기"), act: () => openFilmbox(uid) },
          { label: kinSay("판독문 작성으로"), act: () => focusReportEditor() },
          openEmrItem,
          { sep: 1 },
          // Tele-reading is a later feature: the three items stay by name and place and only say so — nothing is sent
          // (the server's tele-reading routes are kept; a request already shown in the list keeps its mark).
          { label: kinSay("원격판독 의뢰 (Tele Request)"), act: teleLater },
          { label: kinSay("의뢰 취소"), act: teleLater },
          { sep: 1 },
          { label: kinSay("판독 시작 (수신 기관)"), act: teleLater },
          // 원본 다운로드는 자기 기관 검사만이다(S9-U4p §3·§6) — 원격판독으로 받은 행은 회색, 서버도 404로 막는다.
          ...(studyTransfer.canDownload() ? [{ sep: 1 }, { label: kinSay("Download Originals"), dis: !!s?.tele, act: () => studyTransfer.download(opened.uid) },
            // The chosen series or images of the same originals, right after the whole-study item (which keeps its name and place).
            { label: kinSay("Download Selected Originals"), dis: !!s?.tele, act: () => studyTransfer.downloadChosen(opened.uid) }] : []),
          ...forceReleaseItems,
          // FC-076: attach a scanned document or picture to this row's study, at the end of the menu.
          ...(studyAttachments.canAttach() ? [{ sep: 1 }, { label: kinSay("Attach Document"), dis: !!s?.tele, act: () => studyAttachments.open(opened.uid) }] : []),
        ], keyboard, opened);
      } else {
        const o = curOrder();
        showCtx(e, [
          // Technician work: the same answer as the Technician bar (technicianWork, page-boot.js), whatever the tab.
          technicianItem({ label: kinSay("Match"), dis: !(o && s.matched === "U" && o.matched === "U"), act: doMatch }),
          technicianItem({ label: kinSay("Unmatch"), dis: s.matched !== "M", act: doUnmatch }),
          { sep: 1 },
          technicianItem({ label: kinSay("Verify"), dis: s.ss === "Verified", act: () => setSs(uid, "Verified") }),
          technicianItem({ label: kinSay("Unverify"), dis: s.ss === "Unverified", act: () => setSs(uid, "Unverified") }),
          technicianItem({ label: kinSay("Modify Exam"), dis: s.rs !== "W", act: openModify }),
          openEmrItem,
          { sep: 1 },
          emergencyMenu(uid),
          technicianItem({ label: kinSay("Switch ReqHosp"), act: () => {
              // 기관명이 있는 행의 ReqHosp 칸은 서버가 정한 기관명이다(applyState·syncStudy가 같은 규칙으로 그린다). 여기서 친
              // 값을 칸에 그리면 다음 목록 읽기에서 말없이 기관명으로 돌아가고, 저장해도 어디에도 보이지 않는다 — 값을 묻지도
              // 그리지도 보내지도 않고 까닭을 말한다. 기관명이 없는 행(서버 없이 연 목록 등)은 지금처럼 바꾼다.
              if (s.institutionName) {
                toast(String(kinSayEn("이 검사의 ReqHosp는 서버가 정한 기관명({0})입니다 — 여기서 바꿀 수 없습니다", s.institutionName)), "info", 6000);
                return;
              }
              const v = prompt(kinSayEn("의뢰 병원(ReqHosp):"), s.reqHosp);
              if (v == null) return;
              s.reqHosp = v.trim() || "KIN";
              appState[uid] = { ...appState[uid], reqHosp: s.reqHosp };
              saveApp(uid, { reqHosp: s.reqHosp }); render(); renderRelated();
            } }),
          { sep: 1 },
          technicianItem({ label: kinSay("Delete"), dis: s.rs !== "W", act: () => doDelete(uid) }),
          // 이 행의 검사로 반입(X-KIN-Expect-Study)과 원본 다운로드(S9-U4p §6). 둘 다 메뉴를 연 그 선택(opened)에 묶인다.
          ...(studyTransfer.canImport() || studyTransfer.canDownload() || studyAttachments.canAttach() ? [{ sep: 1 }] : []),
          ...(studyTransfer.canImport() ? [{ label: kinSay("Import DICOM"), act: () => studyTransfer.importInto(opened.uid) }] : []),
          // FC-076: right after Import DICOM; grey on a study received for tele-reading.
          ...(studyAttachments.canAttach() ? [{ label: kinSay("Attach Document"), dis: !!s?.tele, act: () => studyAttachments.open(opened.uid) }] : []),
          ...(studyTransfer.canDownload() ? [{ label: kinSay("Download Originals"), dis: !!s?.tele, act: () => studyTransfer.download(opened.uid) },
            { label: kinSay("Download Selected Originals"), dis: !!s?.tele, act: () => studyTransfer.downloadChosen(opened.uid) }] : []),
          ...forceReleaseItems,
        ], keyboard, opened);
      }
    }

    function showOrderMenu(e, tr, fromKey) {
      const oid = tr.dataset.oid;
      selectedOid = oid; renderOrders();
      const o = curOrder(), s = cur();
      showCtx(e, [
        technicianItem({ label: kinSay("Match"), dis: !(s && s.matched === "U" && o.matched === "U"), act: doMatch }),
        // selectedUid를 직접 대입하면 안 된다. select()가 하는 일 — 쓰던 판독문 저장,
        // 점유 해제, 오른쪽 판 갱신 — 이 전부 건너뛰어진다. 그 상태로 다음 검사를 고르면
        // **앞 환자의 소견이 뒤 환자에게 저장된다.** 실제로 그렇게 되는 코드였다.
        technicianItem({ label: kinSay("Unmatch"), dis: o.matched !== "M", act: async () => {
            const s2 = studies.find(x => x.uid === o.studyUid);
            if (!s2) { toast("이 오더에 매칭된 검사를 목록에서 찾을 수 없습니다", "err"); return; }
            // 끊긴 동안은 그 검사로 옮기지도 않는다(study-state.js studyWriteRoute) — 해제할 수 없는 동작이 선택과 판독 화면부터 바꾸지 않게.
            if (!studyWriteRoute()) return;
            // 그 검사로 옮겨졌을 때만 한다 — 옮겨지지 않았으면(글자 조합·쓰던 글의 저장) Unmatch가 지금 선택에 닿는다.
            await select(s2.uid);
            if (selectedUid !== s2.uid) return;
            doUnmatch();
          } }),
        { sep: 1 },
        { label: kinSay("New Exam (SC 생성)"), dis: 1, title: kinSay("새 검사(SC 생성)는 현재 연결되어 있지 않습니다."), act: () => {} },
      ], fromKey ? rowKeyboard(() => $("#orderrows").querySelector(`tr[data-oid="${CSS.escape(oid)}"]`)) : null,
      { uid: selectedUid, seq: selectionSeq, oid: selectedOid });
    }
    $("#orderrows").addEventListener("contextmenu", e => {
      const tr = e.target.closest("tr[data-oid]"); if (!tr) return;
      e.preventDefault();
      showOrderMenu(e, tr, false);
    });
    $("#orderrows").addEventListener("keydown", e => {
      if (!isMenuKey(e)) return;
      const tr = e.target.closest("tr[data-oid]"); if (!tr) return;
      e.preventDefault();
      ctxKeyPending = true;
      showOrderMenu(e, tr, true);
    });