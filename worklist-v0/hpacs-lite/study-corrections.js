

    // ── Match / Unmatch (8.1.2.1.1 ~ 2) ──
    async function doMatch() {
      const s = cur(), o = curOrder();
      if (!s || !o) { alert("Study List에서 검사 1건, Order List에서 오더 1건을 각각 선택하세요."); return; }
      if (s.matched === "M" || o.matched === "M") { alert("이미 매칭된 항목입니다."); return; }
      if (!studyWriteRoute()) return;   // disconnected: said once, before the confirm
      if (!confirm(`아래 오더 정보를 검사에 덮어씁니다.\n\n검사: ${s.name} (${s.id}) ${s.date}\n오더: ${o.name} (${o.id}) ${o.sched}\n\n진행할까요?`)) return;
      await runMatch(s, o, message => alert("매칭 실패: " + message));
    }

    /**
     * The Match itself, after the caller's own checks: the right-click Match (after its confirm, a refusal as an alert) and
     * the Match… window (feature-mounts.js `orders.match`, the refusal in the window) run this same body. Answers
     * `{ ok, state, reloaded }` — `reloaded` resolves true only when the list and the Order List were both read again —
     * or `{ ok: false, message }`; `refused` is called at the moment the page shows a refusal (not after a session end).
     */
    async function runMatch(s, o, refused = null) {
      // 끊긴 동안은 보내지도 그리지도 않는다(study-state.js studyWriteRoute). 행 메뉴(refused가 있음)는 토스트로 한 번,
      // Match… 창은 답의 message를 창 안에 한 번 보인다 — 매칭 실패 alert는 없다.
      const route = studyWriteRoute(!!refused);
      if (!route) return { ok: false, message: NOT_CONNECTED, reloaded: Promise.resolve(false) };
      const a = appState[s.uid] ??= {};
      const orig = a.orig ?? { id: s.id, name: s.name, sex: s.sex, birth: s.birth, age: s.age, desc: s.desc, ward: s.ward };
      const ov = { id: o.id, name: o.name, sex: o.sex, birth: o.birth, age: ageOf(o.birth, s.date), desc: o.desc, ward: o.ward };

      if (route === "server") {
        // 검사와 오더를 함께 바꾸는 일이라 서버 트랜잭션에 맡긴다.
        // 한쪽만 바뀌면 M/U가 어긋난 유령 상태가 남는다.
        // S4-U5: the server stores a claimed original only in the overlay shape, so only those fields are sent
        // (an age the row could not compute is dropped rather than sent as null).
        const claimed = {};
        for (const key of OVERLAY_KEYS) if (overlayValue(key, orig?.[key])) claimed[key] = orig[key];
        const at = work.capture("document");
        let st;
        try {
          st = await api("POST", "/match", { uid: s.uid, oid: o.oid, patient: { age: ov.age, orig: claimed } }, undefined, at);
        } catch (e) {
          work.commit(at, () => {
            refused?.(e.message);
            // S4-U5: the refusal keeps the server wording; the panel adds the next step and the Order List is read
            // again, since the server may have refused because the list on this screen was stale.
            noteIdentityCorrection(s.uid, false); refreshOrders();
          });
          return { ok: false, message: e.message };
        }
        let reloaded = Promise.resolve(false);
        work.commit(at, () => {
          appState[s.uid] = mergeObservedReportState(s.uid, st);
          // The study keeps its own ward; the values of the order are the overlay drawn over it (as applyState draws a row).
          Object.assign(s, { ward: st.ward ?? "" }, st.ov ?? {}, { matched: "M" });
          o.matched = "M"; o.studyUid = s.uid;
          // S4-U5: a list answer requested before this match would re-install the unmatched row; drop it and read again.
          commitEpoch++; listLoadSequence++;
          noteIdentityCorrection(s.uid, true);
          reloaded = Promise.all([load(), refreshOrders()]).then(([list, orderList]) => list === true && orderList === true, () => false);
          render(); renderOrders(); renderClinical(); renderRelated();
          toast(String(kinSayEn("매칭 완료 — {0} ({1})", o.name, o.id)));
        });
        return { ok: true, state: st, reloaded };
      } else {
        a.orig ??= orig; a.ov = ov; a.matched = "M"; a.oid = o.oid;
        Object.assign(s, ov, { matched: "M" });
        o.matched = "M"; o.studyUid = s.uid;
        saveApp(); saveOrders(); applyState(s);
      }
      render(); renderOrders(); renderClinical(); renderRelated();
      toast(String(kinSayEn("매칭 완료 — {0} ({1})", o.name, o.id)));
      return { ok: true, state: null, reloaded: Promise.resolve(true) };
    }

    async function doUnmatch() {
      const s = cur();
      if (!s || s.matched !== "M") { alert("매칭(M)된 검사를 선택하세요."); return; }
      if (!studyWriteRoute()) return;
      await runUnmatch(s, undefined, message => alert("매칭 해제 실패: " + message));
    }

    /** The Unmatch itself (right-click Unmatch without a reason, the Unmatch… window with one); answers as runMatch. */
    async function runUnmatch(s, reason, refused = null) {
      const route = studyWriteRoute(!!refused);
      if (!route) return { ok: false, message: NOT_CONNECTED, reloaded: Promise.resolve(false) };
      const a = appState[s.uid] ?? {};

      if (route === "server") {
        const at = work.capture("document");
        let st;
        try {
          st = await api("POST", "/unmatch", reason === undefined ? { uid: s.uid } : { uid: s.uid, reason }, undefined, at);
        } catch (e) {
          work.commit(at, () => {
            refused?.(e.message);
            noteIdentityCorrection(s.uid, false);
          });
          return { ok: false, message: e.message };
        }
        let reloaded = Promise.resolve(false);
        work.commit(at, () => {
          appState[s.uid] = { ...mergeObservedReportState(s.uid, st), ov: undefined };
          // S4-U5: back to what the server last read from the DICOM, never to the client-claimed orig. Without
          // those tags the fields stay until the list read below repaints them.
          const read = studyIdentityModel ? KinStudyIdentity.tags(studyIdentityModel, s.uid) : null;
          if (read) Object.assign(s, { id: read.id, name: read.name, sex: read.sex, birth: fmtD(read.birth),
            age: ageOf(fmtD(read.birth), s.date), desc: read.desc });
          // The ward the study had before the Match: its own value, which the Match never wrote over.
          s.ward = st.ward ?? "";
          s.matched = "U";
          const o = orders.find(x => x.studyUid === s.uid);
          if (o) { o.matched = "U"; o.studyUid = null; }
          commitEpoch++; listLoadSequence++;
          noteIdentityCorrection(s.uid, true);
          reloaded = Promise.all([load(), refreshOrders()]).then(([list, orderList]) => list === true && orderList === true, () => false);
          render(); renderOrders(); renderClinical(); renderRelated();
          toast("매칭을 해제했습니다 — 원래 정보로 되돌렸습니다", "info");
        });
        return { ok: true, state: st, reloaded };
      } else {
        if (a.orig) Object.assign(s, a.orig);
        delete a.ov; a.matched = "U";
        const o = orders.find(x => x.oid === a.oid);
        if (o) { o.matched = "U"; o.studyUid = null; }
        delete a.oid;
        s.matched = "U";
        saveApp(); saveOrders(); applyState(s);
      }
      render(); renderOrders(); renderClinical(); renderRelated();
      toast("매칭을 해제했습니다 — 원래 정보로 되돌렸습니다", "info");
      return { ok: true, state: null, reloaded: Promise.resolve(true) };
    }

    // ── Verify / Unverify (8.1.3) ──
    /**
     * Verify / Unverify (the Technician bar and the row menu). With a server the row is painted from the accepted answer
     * (saveApp) and only then announced; a refusal keeps the row as the server has it and says the server's reason
     * (saveApp). Disconnected, nothing is sent or painted (studyWriteRoute). The demo path is the previous behavior.
     */
    async function setSs(uid, ss) {
      const s = studies.find(x => x.uid === uid); if (!s) return;
      const route = studyWriteRoute();
      if (!route) return;
      const said = () => toast(String(ss === "Verified"
        ? kinSayEn("검사를 확인했습니다 — 판독할 수 있습니다")
        : kinSayEn("확인을 해제했습니다 — Unverified로 표시되고 판독이 잠깁니다 (응급 제외)")), "info");
      if (route === "server") {
        // The row is the accepted answer's (saveApp); the report pane only if that study is still the selected one.
        const at = work.capture("document"), view = uid === selectedUid ? work.capture("study") : null;
        if (await saveApp(uid, { ss }) !== true) return;
        work.commit(at, () => { renderClinical(); said(); });
        if (view) work.commit(view, () => { loadReport(); updateReportButtons(); });
        return;
      }
      s.ss = ss;
      appState[uid] = { ...appState[uid], ss };
      saveApp(uid, { ss }); render(); renderClinical();
      if (uid === selectedUid) { loadReport(); updateReportButtons(); }
      said();
    }
    $("#t-verify").addEventListener("click", () => selectedUid ? setSs(selectedUid, "Verified") : alert("검사를 선택하세요."));
    $("#t-unverify").addEventListener("click", () => selectedUid ? setSs(selectedUid, "Unverified") : alert("검사를 선택하세요."));

    /**
     * ── QC Flag (Technician bar) ──
     * One window on the selected study (the row the change is stored on, even while a Related study is viewed). It shows the
     * mark this page may show for that row now (shownQc) and sends one command based on the mark's revision and the row's
     * epoch as the person saw them when the window opened (api/src/pacs/qc-flag.ts); nothing is painted before the answer.
     * The window follows the list (syncQcWindow): a study that is no longer a row this account reads as its owning
     * institution closes it at once, emptied. A refusal, a lost answer or a timeout is said in the window and the list is
     * read again; a mark that changed meanwhile is said before anything is sent. The bar button follows technicianWork()
     * (applyRoleUi).
     */
    let qcWindow = null, qcSeq = 0;
    function qcWindowNode() {
      if (qcWindow) return qcWindow;
      const d = document.createElement("dialog"); d.id = "qc-flag-window"; d.setAttribute("aria-labelledby", "qc-flag-title");
      d.style.cssText = "width:min(520px,94vw);background:var(--kin-panel);color:var(--kin-text);border:1px solid var(--kin-muted);border-radius:8px;padding:14px";
      const make = (tag, id, text) => { const el = document.createElement(tag); if (id) el.id = id; if (text) kinWrite(el, kinSay(text)); return el; };
      const title = make("h3", "qc-flag-title", "QC Flag"); title.style.margin = "0 0 8px";
      const study = make("div", "qc-flag-study"); study.translate = false;
      const now = make("div", "qc-flag-now"); now.style.margin = "6px 0";
      const label = make("label", null, "Reason"); label.htmlFor = "qc-flag-reason"; label.style.display = "block";
      // One line (the server refuses line breaks and tabs): an input, not a text area.
      const reason = make("input", "qc-flag-reason"); reason.type = "text"; reason.maxLength = 500; reason.translate = false;
      reason.style.cssText = "width:100%;box-sizing:border-box";
      const status = make("p", "qc-flag-status"); status.setAttribute("role", "status"); status.setAttribute("aria-live", "polite");
      const flag = make("button", "qc-flag-save", "Flag"), clear = make("button", "qc-flag-clear", "Clear Flag"), cancel = make("button", "qc-flag-cancel", "Cancel");
      for (const b of [flag, clear, cancel]) b.type = "button";
      const actions = document.createElement("div"); actions.style.cssText = "display:flex;gap:8px;flex-wrap:wrap"; actions.append(flag, clear, cancel);
      d.append(title, study, now, label, reason, status, actions);
      flag.addEventListener("click", () => sendQc(false));
      clear.addEventListener("click", () => sendQc(true));
      cancel.addEventListener("click", () => closeQcWindow(d));
      // However it closes (Cancel, Esc, the session's end), nothing of the study stays in it; a late answer still updates
      // the row by its own rule (takeQcAnswer), never this window. (The event comes after the closing: a window opened
      // again by then keeps what it shows.)
      d.addEventListener("close", () => { if (!d.open) emptyQcWindow(d); });
      document.body.append(d);
      return qcWindow = d;
    }
    /** Drops the window's request token and everything it showed or held: the study, the mark, the author, the typed reason. */
    function emptyQcWindow(d) {
      qcSeq++;
      Object.assign(d.dataset, { uid: "", revision: "", epoch: "", scope: "" }); delete d.dataset.request;
      $("#qc-flag-study").textContent = ""; $("#qc-flag-now").replaceChildren(); $("#qc-flag-status").textContent = "";
      $("#qc-flag-reason").value = "";
    }
    function closeQcWindow(d) { emptyQcWindow(d); if (d.open) d.close(); }
    /**
     * May the window show and send for its study now? Only while that study is a row of the list the server last sent, one
     * this account can read (qcScope) and reads as its owning institution (not a row received for tele-reading).
     */
    function qcWindowStands(d) {
      const uid = d.dataset.uid, row = uid ? studies.find(x => x.uid === uid) : null;
      return !!row && !row.tele && qcScope(uid) !== null;
    }
    /**
     * The window's picture of its study, drawn from the mark this page may show now. `rebase` (opening the window, and the
     * moment the person is told the mark changed) also sets what the command will be sent against - the mark's revision,
     * the row's epoch and the row's reading. Nothing else moves that base: a poll that shows a newer mark here leaves it, so
     * the next press is answered "changed meanwhile" instead of silently writing over the other change.
     */
    function drawQcWindow(d, uid, rebase = false) {
      const s = studies.find(x => x.uid === uid), mark = shownQc(uid);
      if (rebase) Object.assign(d.dataset, { uid, revision: mark ? String(mark.revision) : "", epoch: appState[uid]?.draftEpoch ?? "", scope: qcScope(uid) ?? "" });
      kinWrite($("#qc-flag-study"), s ? kinSayEn("{0} ({1}) · {2} · {3}", s.name, s.id, s.date, shownStudyDesc(s) === "(설명 없음)" ? kinSayEn("(설명 없음)") : shownStudyDesc(s)) : "");
      const now = $("#qc-flag-now");
      if (!mark) kinWrite(now, kinSay("QC 상태를 아직 받지 못했습니다. 목록을 새로고침한 뒤 다시 여세요."));
      else if (mark.reason === null) kinWrite(now, kinSay("No QC flag"));
      else {
        const why = document.createElement("span"); why.translate = false; why.textContent = mark.reason;
        const who = [mark.byName ?? "", mark.at ? localStamp(mark.at) : ""].filter(Boolean).join(" · ");
        now.replaceChildren(kinWrite(document.createElement("span"), kinSay("Flagged")), ": ", why,
          ...(who ? [" · ", Object.assign(document.createElement("span"), { translate: false, textContent: who })] : []));
      }
      const busy = !!d.dataset.request;
      $("#qc-flag-save").disabled = busy || !mark; $("#qc-flag-clear").disabled = busy || !mark || mark.reason === null;
    }
    /**
     * The open window follows the list (render() calls this after every list read and every redraw): when its study is no
     * longer a row this account reads as its owning institution - it left the list, cannot be read now, became a row
     * received for tele-reading, or the server answered 404 for it - the window is emptied and closed at once. Otherwise
     * the line that shows the mark is drawn again from the list; the base of the command stays (drawQcWindow).
     */
    function syncQcWindow() {
      const d = qcWindow;
      if (!d?.open || !d.dataset.uid) return;
      if (qcWindowStands(d)) { drawQcWindow(d, d.dataset.uid); return; }
      closeQcWindow(d);
      toast(kinSay("이 검사의 QC 표시를 지금은 볼 수 없어 창을 닫았습니다. 목록을 확인하세요."), "err");
    }
    function openQcFlag() {
      if (!technicianWork()) return;
      const s = selectedUid ? studies.find(x => x.uid === selectedUid) : null;
      if (!s) { alert("검사를 선택하세요."); return; }
      if (!serverMode || offline || demoMode) { toast(kinSay("QC 표시는 서버에 연결된 동안에만 바꿀 수 있습니다"), "err"); return; }
      if (s.tele) { toast(kinSay("원격판독으로 받은 검사의 QC 표시는 보유 기관에서만 바꿀 수 있습니다"), "err"); return; }
      if (qcScope(s.uid) === null) { toast(kinSay("지금은 QC 표시를 바꿀 수 없습니다. 연결·권한·검사를 확인하세요."), "err"); return; }
      const d = qcWindowNode();
      emptyQcWindow(d);
      drawQcWindow(d, s.uid, true);
      $("#qc-flag-reason").value = shownQc(s.uid)?.reason ?? "";
      if (!d.open) d.showModal();
      $("#qc-flag-reason").focus();
    }
    async function sendQc(clearing) {
      const d = qcWindow, uid = d?.dataset.uid;
      if (!d?.open || !uid || d.dataset.request) return;
      const status = $("#qc-flag-status");
      // Judged again at the moment of sending, not only when the window opened: the row, the connection and the role.
      if (!qcWindowStands(d)) { syncQcWindow(); return; }
      if (!technicianWork() || !serverMode || offline || demoMode) {
        kinWrite(status, kinSay("지금은 QC 표시를 바꿀 수 없습니다. 연결·권한·검사를 확인하세요."));
        return;
      }
      // The mark changed since the person last saw it here as the base (a poll, another window): the new one is shown and
      // said, and becomes the base, before anything is sent.
      const mark = shownQc(uid), scope = qcScope(uid);
      if (!mark || String(mark.revision) !== d.dataset.revision || (appState[uid]?.draftEpoch ?? "") !== d.dataset.epoch || scope !== d.dataset.scope) {
        drawQcWindow(d, uid, true);
        kinWrite(status, kinSay("그 사이 QC 표시가 바뀌었습니다. 지금 상태를 확인한 뒤 다시 누르세요."));
        return;
      }
      const raw = $("#qc-flag-reason").value, reason = raw.trim();
      if (!clearing && (!reason || reason.length > 500 || /[\u0000-\u001f\u007f-\u009f]/.test(raw))) {
        kinWrite(status, kinSay("QC 사유를 줄바꿈 없이 1~500자로 적으세요."));
        return;
      }
      const token = String(++qcSeq), at = work.capture("document"), controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 15000);
      d.dataset.request = token; $("#qc-flag-save").disabled = $("#qc-flag-clear").disabled = true;
      kinWrite(status, kinSay("저장 중…"));
      let st = null, error = null;
      try {
        st = await api("PATCH", "/studies/" + encodeURIComponent(uid),
          { qc: clearing ? null : { reason }, qcRevision: mark.revision, epoch: d.dataset.epoch }, controller.signal, at);
      } catch (e) { error = e; } finally { clearTimeout(timer); }
      work.commit(at, () => {
        // Is the window still the one that sent this (closing it, however, drops its token)?
        const own = d.dataset.request === token && d.open && d.dataset.uid === uid;
        if (own) delete d.dataset.request;
        if (st) {
          // The answer's mark is taken only for the reading it was sent under; the redraw closes this window by its own
          // rule when the row no longer stands (syncQcWindow in render()).
          takeQcAnswer(uid, st, scope);
          // The row is read another way now than when this was sent: the list is asked what the mark is.
          if (qcScope(uid) !== scope) Promise.resolve(load()).catch(() => {});
          syncStudy(uid); render(); renderClinical();
          if (!own || !d.open || d.dataset.uid !== uid) return;
          closeQcWindow(d);
          const saved = qcMark(st);
          toast(kinSay(saved?.reason === null ? "QC 표시를 지웠습니다" : "QC 표시를 저장했습니다"), "info");
          return;
        }
        // 404: the server says this study is not there for this account. Nothing of its mark stays on this page - the row's
        // mark, the Info line and this window go at once, before the list is read again.
        if (error?.status === 404) {
          loseQc(uid); syncStudy(uid); render(); renderClinical();
          Promise.resolve(load()).catch(() => {});
          return;
        }
        // Refused, lost or timed out: the result is read back from the server (the list) and the window says what happened;
        // the list read redraws the open window's mark through render() (the status line and the command's base stay).
        if (!error?.auth) Promise.resolve(load()).catch(() => {});
        if (!own) return;
        drawQcWindow(d, uid);
        kinWrite(status, error?.name === "AbortError"
          ? kinSay("응답 시간이 지났습니다. 저장됐는지 목록을 다시 읽어 확인합니다.")
          : kinSay("QC 표시를 저장하지 못했습니다: {e0}", error?.message ?? ""));
      });
    }
    $("#t-qc-flag").addEventListener("click", openQcFlag);

    // ── 장비 수신 ──
    // 예전엔 여기 "장비 수신 시뮬" 버튼이 있었다. localStorage에 가짜 행을 만들 뿐이라
    // 영상도 없고 서버도 몰랐다 — 화면에만 있는 검사였다.
    //
    // 지금은 진짜 장비가 진짜 프로토콜로 보낸다: scripts/send_cstore.py 가
    // DICOM Association을 맺고 C-STORE로 Orthanc(4242)에 인스턴스를 밀어넣는다.
    // 그러면 서버의 검사 목록에 새 검사가 생기고, 아래 폴링이 그걸 집어온다.
    //     python3 send_cstore.py --institution "한림병원"
    // 도착 검사는 Radiology에 촬영중으로 보이고, 비응급은 Verify 뒤에 판독할 수 있다.

    // ── Modify Exam (8.1.2.1.5) ──
    function openModify() {
      const s = cur();
      if (!s) { alert("검사를 선택하세요."); return; }
      if (s.rs !== "W") { alert("판독 전(RS: W)인 검사만 수정할 수 있습니다.\n현재 RS: " + s.rs); return; }
      $("#m-id").value = s.id; $("#m-name").value = s.name; $("#m-sex").value = s.sex || "O";
      $("#m-birth").value = s.birth; $("#m-desc").value = s.desc; $("#m-ward").value = s.ward;
      $("#m-guidance").hidden = true; $("#m-guidance").textContent = "";
      $("#modal").classList.add("show");
    }
    $("#m-cancel").addEventListener("click", () => $("#modal").classList.remove("show"));
    /**
     * S4-U5 Modify Exam save. With a server, nothing is painted, stored locally or announced before the PATCH answer:
     * a refusal leaves the row as it was and the modal open with what was typed, plus the server's own words (toast)
     * and the next step; an accepted answer repaints the row from the server's overlay through applyState. The local
     * (no server) path is the previous behavior.
     */
    async function saveModify(event) {
      const s = cur(); if (!s) return;
      const uid = s.uid, button = event.currentTarget;
      const a = appState[uid] ??= {};
      const birth = $("#m-birth").value.trim();
      const ov = {};
      for (const key of OVERLAY_KEYS) if (overlayValue(key, a.ov?.[key])) ov[key] = a.ov[key];
      Object.assign(ov, {
        id: $("#m-id").value.trim(), name: $("#m-name").value.trim(), sex: $("#m-sex").value,
        birth, age: ageOf(birth, s.date), desc: $("#m-desc").value.trim(), ward: $("#m-ward").value.trim() });
      const route = studyWriteRoute();
      if (!route) return;   // disconnected: nothing sent or painted; the modal keeps what was typed
      if (route === "server") {
        const guidance = $("#m-guidance");
        guidance.hidden = true; guidance.textContent = "";
        button.disabled = true;
        const at = work.capture("document");
        let ok = false;
        // 이 저장이 잠근 단추는 이 저장이 푼다(자기 것만).
        try { ok = await saveApp(uid, { ov }) === true; } finally { button.disabled = false; }
        work.commit(at, () => {
          if (!ok) {
            if (!serverMode) return;
            noteIdentityCorrection(uid, false);
            guidance.textContent = window.KinStudyIdentity?.guidance(appState[uid]?.rs ?? "W", true, s.tele === true) ?? "";
            guidance.hidden = !guidance.textContent;
            return;
          }
          const row = studies.find(x => x.uid === uid);
          if (row) applyState(row);
          noteIdentityCorrection(uid, true);
          modified();
        });
        return;
      }
      a.orig ??= { id: s.id, name: s.name, sex: s.sex, birth: s.birth, age: s.age, desc: s.desc, ward: s.ward };
      a.ov = ov;
      Object.assign(s, a.ov);
      saveApp(uid, { ov: a.ov });
      modified();
      function modified() {
        $("#modal").classList.remove("show");
        render(); renderClinical(); renderRelated(); renderOrders();
        toast("검사 정보를 수정했습니다");
        // An older list answer would still carry the previous overlay; drop it and read the list again.
        if (serverMode) { commitEpoch++; listLoadSequence++; load(); }
      }
    }
    $("#m-save").addEventListener("click", saveModify);
    $("#t-modify").addEventListener("click", openModify);

    // ── Delete (8.1.2.1.8) ──
    async function doDelete(uid) {
      const s = studies.find(x => x.uid === uid); if (!s) return;
      if (s.rs !== "W") { alert("RS가 W(Wait)인 검사만 삭제할 수 있습니다."); return; }
      if (!studyWriteRoute()) return;   // disconnected: said once, before the confirm
      // 영상 자체(Orthanc)를 지우는 것은 아직 안 한다. 되돌릴 수 없는 동작이라
      // 권한·감사로그·연쇄 해제를 갖춰야 한다 (교훈 §5). 지금 지울 수 있는 건
      // "영상에 대한 사람의 결정"뿐이고, 그러면 다음 목록 조회 때 그 검사는
      // **막 도착한 검사처럼 다시 나타난다.** 그게 이 동작의 진짜 의미다.
      if (!confirm(`이 검사의 판독 상태·매칭 기록을 지웁니다.\n${s.name} (${s.id}) ${s.date}\n` +
                   `영상은 남고, 검사는 방금 도착한 것처럼 다시 나타납니다. 계속할까요?`)) return;
      // 서버가 거절했는데 화면부터 지우면 검사가 사라진 것처럼 거짓말한다.
      // 응답을 기다려야 판독 이력·다른 사람의 초안 때문에 거절된 이유도 메뉴의 catch가 보여준다.
      const route = studyWriteRoute();
      if (!route) return;
      const at = work.capture("document");
      if (route === "server") await api("DELETE", `/studies/${encodeURIComponent(uid)}`, undefined, undefined, at);
      else saveApp();
      work.commit(at, () => {
        studies = studies.filter(x => x.uid !== uid);
        delete appState[uid];
        if (selectedUid === uid) {
          markSelectionChanged(null);
          relatedUid = null;
          relatedReportSeq += 1;
          clearRelatedReport();
          refreshRight();
        }
        render();
        toast("검사를 삭제했습니다", "info");
      });
    }