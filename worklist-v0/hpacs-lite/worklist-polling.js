    // Presence follows the viewer heartbeat, independently of the optional list refresh.
    let viewingTimer = null, viewingRequest = null, viewingSequence = 0, viewingScope = '';
    function paintViewing() {
      // C-R01-109#3: the Report Editor head shows the same presence; fixtures without the editor module have no such line.
      if (typeof renderEditorPresence === 'function') renderEditorPresence();
      const index = shownColumns().findIndex(c => c.k === 'viewing');
      if (index < 0) return;
      const byUid = new Map(studies.map(study => [study.uid, study]));
      for (const row of $('#rows').querySelectorAll('tr[data-uid]')) {
        const cell = row.cells[index], study = byUid.get(row.dataset.uid);
        // Keep the saved width container and render the writing lock alongside presence.
        if (cell && study) { const target = cell.querySelector(':scope > .wc-cell') || cell; target.innerHTML = CELL.viewing(study); window.KinLanguage?.markup?.(target); if (typeof paintRowWords === "function") paintRowWords(target, study); }
      }
    }
    // FC-071: the Preload worker reports its queue; only the visible PF cells are rewritten, in place like Viewing.
    // A PF search matches the queue's status words: when a word changes (not the download percent) and a search uses PF,
    // the list, the folder and saved-search counts are drawn again, once per frame, like a Body Part answer. A list sorted
    // by PF is drawn again the same way, so its order follows the words.
    let preloadWords = '', preloadFrame = null;
    function paintPreload() {
      const words = studies.map(preloadWord).join('\n'), changed = words !== preloadWords;
      preloadWords = words;
      if (changed && (preloadFilterUsed() || (sortKey === 'pf' && sortDir !== 0))) {
        if (preloadFrame !== null) return;
        const at = work.capture('document');
        preloadFrame = requestAnimationFrame(() => {
          preloadFrame = null;
          work.commit(at, () => { render(); savedFilterManager.refreshCounts(); });
        });
        return;
      }
      const index = shownColumns().findIndex(c => c.k === 'pf');
      if (index < 0) return;
      const byUid = new Map(studies.map(study => [study.uid, study]));
      for (const row of $('#rows').querySelectorAll('tr[data-uid]')) {
        const cell = row.cells[index], study = byUid.get(row.dataset.uid);
        if (cell && study) { const target = cell.querySelector(':scope > .wc-cell') || cell; target.innerHTML = CELL.pf(study); window.KinLanguage?.markup?.(target); }
      }
    }
    function clearViewing() {
      ++viewingSequence;
      viewingRequest?.abort(); viewingRequest = null;
      viewingNames.clear(); paintViewing();
    }
    function stopViewing() {
      clearInterval(viewingTimer); viewingTimer = null;
      viewingScope = ''; clearViewing();
    }
    function syncViewingRows() {
      const scope = serverMode && !demoMode && !offline && shownColumns().some(c => c.k === 'viewing')
        ? JSON.stringify([...$('#rows').querySelectorAll('tr[data-uid]')].map(row => {
          const study=studies.find(s=>s.uid===row.dataset.uid);return {uid:row.dataset.uid,scope:KinExamScope.read(study)}; })) : '';
      if (scope === viewingScope) return;
      clearViewing(); viewingScope = scope;
      if (scope) void refreshViewing();
    }
    async function refreshViewing() {
      if (!serverMode || demoMode || offline || document.hidden || !viewingScope || viewingRequest) return;
      const at = work.capture('document');
      if (!work.admits(at)) { clearViewing(); return; }
      const sequence = ++viewingSequence, scope = viewingScope, rows = JSON.parse(scope), uids = [...new Set(rows.flatMap(row=>row.scope.sources.map(s=>s.studyUid)))];
      if (!uids.length) return;
      const controller = new AbortController(); viewingRequest = controller;
      // Allow a read to outlast one poll, but bound stale names to a stalled read's timeout.
      const timeout = setTimeout(() => {
        if (sequence === viewingSequence) clearViewing();
      }, 10000);
      const live = () => sequence === viewingSequence && scope === viewingScope && work.admits(at);
      try {
        const requests = [];
        // Keep each GET below the proxy's request-line bound even with long DICOM UIDs.
        for (let i = 0; i < uids.length; i += 50)
          requests.push(api('GET', '/presence?uids=' + encodeURIComponent(uids.slice(i, i + 50).join(',')),
            undefined, controller.signal, at));
        const replies = await Promise.all(requests);
        if (!live()) return;
        viewingNames.clear();
        for (const reply of replies) for (const [uid, people] of Object.entries(reply.studies || {})) {
          if (!uids.includes(uid) || !Array.isArray(people)) continue;
          const names = people.filter(person => typeof person?.name === 'string' && person.name).map(person => person.name);
          if (names.length) viewingNames.set(uid, 'Viewing: ' + names.join(', '));
        }
        const sourceNames=new Map(viewingNames);viewingNames.clear();
        for(const row of rows){const names=[...new Set(row.scope.sources.map(s=>sourceNames.get(s.studyUid)).filter(Boolean))];
          if(names.length)viewingNames.set(row.uid,names.join(' · '));}
        paintViewing();
      } catch (_) {
        if (live()) { viewingNames.clear(); paintViewing(); }
      } finally {
        clearTimeout(timeout);
        if (sequence === viewingSequence) viewingRequest = null;
      }
    }
    onCommonEnd(stopViewing);
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) clearViewing(); else void refreshViewing();
    });
    window.addEventListener('pagehide', stopViewing);
    // 다른 사람이 잡거나 놓은 걸 보려면 주기적으로 확인해야 한다.
    // 기본 30초. 간격 변경은 진행 중인 이전 조회도 무효화한다.
    let poll = null, pollGeneration = 0;
    function startPolling() {
      // Also run on its own (a page test takes this function out of the page): the plain fill stands in then.
      const kinSay = globalThis.kinSayShared || ((t, ...p) => t.replace(/\{(?:[ten]?(\d+)|([A-Za-z]\w*))\}/g, (m, i, n) => { const v = n !== undefined ? (p[0] || {})[n] : p[i]; return v === undefined ? m : String(v && typeof v === "object" ? (v.t ?? v.e ?? "") : v); }));
      // Up to three arrivals by name (patient · study · EM E when the row says emergency), then the rest as a count.
      function arrivalNames(rows) {
        const named = rows.slice(0, 3).map(s => [s.name, s.desc || s.modality, s.state?.em === "E" ? kinSayEn("EM E(응급)") : ""]
          .map(value => String(value ?? "").trim()).filter(Boolean).join(" · ") || s.uid);
        return kinSayEn("{0}{1}", named.join(", "), rows.length > 3 ? kinSayEn(" 외 {n0}건", rows.length - 3) : "");
      }
      // A reader typing a report misses a toast of a few seconds. The last notice also stays under the list (no focus is
      // taken) until the next notice replaces it or Dismiss hides it.
      function announceArrivals(text) {
        toast(text, "info", 8000);
        let line = document.getElementById("arrival-notice");
        if (!line) {
          const anchor = document.getElementById("not-observed");
          if (!anchor) return;
          line = document.createElement("div");
          line.id = "arrival-notice";
          line.setAttribute("role", "status");
          line.style.cssText = "padding:2px 10px;font-size:12px";
          const title = document.createElement("strong"), at = document.createElement("span"), body = document.createElement("span");
          const dismiss = document.createElement("button");
          title.textContent = "New Arrivals"; at.id = "arrival-notice-time"; body.id = "arrival-notice-text";
          dismiss.type = "button"; dismiss.id = "arrival-notice-dismiss"; dismiss.textContent = "Dismiss";
          dismiss.addEventListener("click", () => { line.hidden = true; });
          line.append(title, " ", at, " · ", body, " ", dismiss);
          anchor.after(line);
        }
        const now = new Date();
        line.querySelector("#arrival-notice-time").textContent =
          `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
        kinWrite(line.querySelector("#arrival-notice-text"), text);
        line.hidden = false;
      }
      stopViewing();
      if (serverMode && !demoMode && !offline) {
        syncViewingRows();
        viewingTimer = setInterval(() => { syncViewingRows(); void refreshViewing(); }, 5000);
      }
      clearInterval(poll); poll = null;
      const generation = ++pollGeneration;
      const seconds = worklistRefresh?.seconds() ?? 30;
      if (!serverMode || !seconds) return;
      poll = setInterval(async () => {
        if (generation !== pollGeneration || !serverMode || document.hidden || studyPageClient.busy || studyPageClient.paused) return;
        /**
         * 확정이 나가 있으면 이번 회차는 건너뛴다.
         * 폴링 요청이 확정보다 **먼저 나가고 나중에 도착**하면, 방금 승인한 rs=A를
         * 낡은 rs=T로 되돌린다. 화면이 되돌아가면 판독의는 Approve를 또 누르고,
         * baseVersion이 맞아 통과하므로 판이 하나 더 쌓인다.
         */
        if (commitInFlight) return;
        // 이 회차를 시작한 문맥. 로그아웃 준비 중에는 시작하지 않고, 답과 실패가 목록·판독문·연결 상태에 닿는 자리는 모두
        // 이것을 지난다 — 준비·그 취소·세션 종료 뒤에 온 회차는 아무것도 바꾸지 않고 실패로 세지도 않는다.
        const at = work.capture("document");
        if (!work.admits(at)) return;
        const live = () => work.admits(at) && generation === pollGeneration;
        const epoch = commitEpoch;
        try {
          /**
           * **`/bootstrap`이 아니라 `/studies`를 본다.**
           *
           * bootstrap은 StudyState 행만 준다. 그런데 장비에서 막 C-STORE로 도착한
           * 검사는 아직 행이 없다 — 서버가 목록을 만들 때 비로소 생긴다. bootstrap만
           * 보면 그 검사는 다음 새로고침 전까지 아무에게도 안 보인다. 방사선사가
           * 확인해야 판독이 시작되는 구조에서, 도착을 못 보는 건 워크플로가 멈춘 것이다.
           *
           * /studies는 목록과 상태를 함께 주므로 도착·원격판독 수신·상태 변화를
           * 한 번에 잡는다. (오더는 자주 안 바뀌므로 여기서 갱신하지 않는다)
           */
          const r = await studyPageClient.read({ epoch, valid:() => live() && !commitInFlight && epoch === commitEpoch });
          // 요청을 보낸 뒤 확정이 일어났다면 이 응답은 그 이전 사진이다. 버린다.
          if (!live() || commitInFlight || epoch !== commitEpoch) return;
          assertStudyOwner(r);
          // What this answer no longer lists (or reads another way) loses its QC mark and DICOM values now, before the wait below.
          qcHearsList(r.studies);
          await Promise.all([favoriteList?.refresh(),studyTagList?.refresh()]);
          if (!live() || commitInFlight || epoch !== commitEpoch) return;
          pollFails = 0; listRefreshWarning(false);
          // The questions and image requests of the reading target are read again with the list: one that came after the
          // study opened is learned too.
          studyQuestions?.refresh();
          imageRequests?.refresh();
          worklistAlerts?.observe(r.studies.map(s=>({uid:s.uid,em:s.state.em})));
          applyIdentityIssues(r.identityIssues, r.studies);
          applyObservation(r);
          // 이 답은 완성된 목록이다. 읽는 동안 'Partial'로 내려 둔 폴더 건수를 load()와 같이 완성으로 되돌린다 — 그러지 않으면
          // 첫 목록 확인 뒤로 폴더가 계속 'N · Partial'로 남는다. 아래 두 갈래의 render()가 폴더를 다시 그린다.
          folderLoadState = 'complete';
          const arrivals = window.KinStudyArrivals?.diff(studies, r.studies);
          // The notice names what came (patient · study · EM E), not only how many: the rows of the answer already carry them.
          const arrivalChanged = arrivals?.ok ? [...new Set(arrivals.changes.flatMap(change => r.studies.filter(s=>KinExamScope.read(s)?.sources.some(source=>source.studyUid===change.uid))))] : [];
          const arrivalNotice = arrivalChanged.length
            ? kinSayEn("기존 검사 {n0}건에 영상 또는 시리즈가 추가됐습니다({1}). 현재 영상 화면은 자동 교체하지 않습니다.", arrivalChanged.length, arrivalNames(arrivalChanged)) : '';
          const known = new Map(studies.map(x => [x.uid, x]));
          const knownOriginals=new Set(KinExamScope.originals(studies).map(s=>s.uid));
          const fresh = KinExamScope.originals(r.studies).filter(s=>!knownOriginals.has(s.uid));
          // A row whose exam became (or stopped being) unreadable as a whole is a changed exam too, though neither answer
          // carries a scope.
          const lostKey = s => s?.examUnavailable === true ? String(s.examUnavailableKind ?? '') : null;
          // A row that became (or stopped being) one received for tele-reading is another row for this account: every
          // field of it is rebuilt from this answer, like a changed exam.
          const scopeChanged = r.studies.some(s=>KinExamScope.screenStamp(s)!==KinExamScope.screenStamp(known.get(s.uid))
            || lostKey(s)!==lostKey(known.get(s.uid)) || known.has(s.uid) && (s.tele===true)!==(known.get(s.uid).tele===true));

          // 목록이 달라졌으면(도착·삭제) 통째로 다시 그린다.
          if (scopeChanged || fresh.length || r.studies.length !== studies.length) {
            // 지키는 칸은 `fromApi`가 지나는 `mergeObservedReportState` 한 곳이 정한다 — 목록을 통째로
            // 다시 그리는 이 길도 결국 그 함수를 지나므로 여기서 따로 되돌릴 것이 없다.
            observeExamList(r.studies);
            studies = r.studies.map(fromApi);
            // 썸네일 등 오른쪽 전체를 다시 그릴 필요는 없지만, 판독문 잠금은 반영해야 한다.
            // loadReport가 값만 보호하므로 새 검사 도착과 Prelim 전환이 겹쳐도 입력은 유지된다.
            render();
            // applyObservation drew the receipt block from the rows before this rebuild; a study that became a merged or
            // split exam in this answer is drawn again from the rebuilt row (its missing-images line goes at once).
            renderObservation();
            // Another study is viewed now than the Info panel names (a Related study left the list or came back): one study.
            viewedInfoFollowsList();
            if (selectedUid) { loadReport(); updateReportButtons(); }
            autoPreload?.afterList();   // FC-073: a study that just arrived is queued without a manual Refresh
            if (fresh.length || arrivalNotice) {
              const arrived = [fresh.length ? kinSay("새 검사 {n0}건이 도착했습니다: {1}{t2}", fresh.length, arrivalNames(fresh),
                { t: fresh.some(s => (s.state?.ss??s.ss) === "Unverified") ? kinSayEn(" — Technician 탭에서 확인(Verify)하세요") : "" }) : '', arrivalNotice].filter(Boolean);
              announceArrivals(arrived.length > 1 ? kinSay("{t0} · {t1}", { t: arrived[0] }, { t: arrived[1] }) : arrived[0] || '');
            }
            return;
          }

          // QC marks follow this answer too (report-draft-sync.js observeQcList): the rows it lists and how each is read now.
          observeQcList(r.studies);
          for (const s of r.studies) {
            const uid = s.uid, st = s.state, existing = known.get(uid);
            observeQcScope(s);
            if (existing) Object.assign(existing, {examScope:s.examScope??null, reportScope:s.reportScope??null,
              draftEpoch:s.state?.draftEpoch??null, sourceMetadata:sourceMetadataView(s.sourceMetadata),
              // Referred is fixed once the study exists; written here by the same rule as fromApi all the same.
              ...referredFields(s),
              // Read Req: the open reading request moves with every poll (approved elsewhere: blank).
              ...readingRequestFields(s)});
            if (existing) for (const field of ['count', 'series'])
              if (s[field] === null || Number.isSafeInteger(s[field]) && s[field] >= 0) existing[field] = s[field];
            updateNoteSummary(uid, s.techNote);
            updateReaderAssignment(uid, s.readerAssignment);
            if (uid === selectedUid) {
              // 지금 편집 중인 검사는 두 가지만 보호한다:
              //   version — baseVersion은 "내가 화면에서 본 판"이어야 한다. 폴링이 몰래
              //     올리면 남이 저장한 걸 본 적도 없으면서 최신을 아는 셈이 되어, 다음
              //     저장이 충돌 경고 없이 남의 판독문을 덮는다. 낙관적 락의 조용한 무력화.
              //   draft — 타이핑 중인 내 초안. 서버 응답이 한 박자 늦으면 방금 친 문장이
              //     되돌아간다. 확정본(findings 등)은 갱신해도 된다 — 초안이 있는 동안
              //     화면은 초안을 그리고, 확정본은 "그 사이 남이 v5를 확정했다" 안내에만 쓰인다.
              // 나머지(rs·ss·holder 등)도 갱신한다. 남이 승인한 게 화면에 보여야 하니까.
              appState[uid] = mergeObservedReportState(uid, st, true);
              /**
               * 판독문 값은 loadReport가 스스로 지키므로, 호출자는 항상 상태를 반영한다.
               * 예전엔 폴링이 `prelimHidden`만 반영하고 판독문 패널은 그대로 뒀다 —
               * 내가 읽는 중에 남이 그 검사를 Prelim으로 넘기면 내용이 그대로 남고
               * 버튼도 활성인 채라, Save를 눌러야 403을 만났다. (남은버그 3-1)
               */
            } else {
              /**
               * 고르지 않은 검사도 **수렴을 기다리는 초안**은 덮지 않는다. 삽입이 나가 있는
               * 동안 검사를 옮기면 그때 담아 둔 타건이 이 칸에만 있고, 그 삽입이 거절되면
               * 서버 어디에도 없다. 폴링 한 번이 그것을 서버 투영으로 갈아끼우면 돌아온
               * 화면은 옛 글을 그리고, 수렴 저장이 그 옛 글을 서버에 밀어 넣는다.
               */
              appState[uid] = mergeObservedReportState(uid, st, true);
            }
            // Modality changes when a series of another modality arrives (an attached document, too): written like Count and
            // Series, as the list read draws it (fromApi, then applyState's display overlay over the server's value).
            if (existing) {
              const overlay = appState[uid]?.ov?.modality, modality = typeof overlay === 'string' ? overlay : s.modality;
              if (typeof modality === 'string') existing.modality = modality;
            }
            syncStudy(uid);
            if (selectedUid === uid) { loadReport(); updateReportButtons(); }
          }
          render();
          viewedInfoFollowsList();
          autoPreload?.afterList();
          if (arrivalNotice) announceArrivals(arrivalNotice);
          pollFails = 0;
        } catch (e) {
          if (!live()) return;
          // 목록 읽기가 "계정이 바뀌었다"고 했다. 이 세션에 묶어 한 번 확인해 정말 다른 계정의 답일 때만 세션 교체로 닫는다.
          // 401·403으로 읽지 못한 것은 이 회차의 실패일 뿐이다.
          if (e.ownerChanged) {
            studyPageClient.clear();
            if (await accountReplaced(at)) return;
            if (!live()) return;
          }
          if (e.stale || e.code === 'STUDY_LIST_CHANGED') return;
          // The first failure already says 관측 불가 beside the kept list; going offline waits for two.
          markObservationUnavailable();
          // The folder counts say what a failed Refresh makes them say (load()): unknown, not Partial.
          folderLoadState = 'unknown'; render();
          // The kept identity notice is from the last observation too (spec §3.1), as after a failed manual load.
          renderIdentityIssues(true);
          /**
           * **일하는 도중에 서버가 죽는 경우.**
           *
           * 예전엔 폴링의 catch가 통째로 비어 있어서, API가 죽어도 화면은 아무 말도
           * 안 했다. 판독의는 계속 쓰고 Save를 누를 때가 되어서야 알게 됐다.
           * 두 번 연속 실패하면 고장으로 본다. 한 번은 blip일 수 있다.
           *
           * 목록 읽기는 영상 저장소의 목록이기도 하다 — 저장소만 멈춰도 실패한다. 그래서 두 번째 실패는 곧바로 끊김이 아니라
           * 목록을 갱신하지 못했다는 안내이고, 끊김은 수동 읽기와 같은 연결 확인(page-boot.js confirmConnection)이 정한다:
           * 서버가 답하면 연결·쓰기·판독문은 그대로다.
           */
          if (++pollFails >= 2) {
            listRefreshWarning(true);
            await confirmConnection(e, at, live);
          }
        }
      }, seconds * 1000);
    }
    let pollFails = 0;
    // The notice a failed list read leaves on the banner (two failed polls, or a failed Refresh with its own `text`); a list
    // read that succeeds takes it away again. Only the text written here is removed — another notice written since stays.
    let listWarningText = null;
    function listRefreshWarning(on, text) {
      const banner = $("#err");
      if (!banner) return;
      // The words written, whatever language shows now (a sentence repaints when the language changes).
      const written = () => window.KinLanguage ? window.KinLanguage.source(banner) : banner.textContent;
      if (on) {
        if (text === undefined) kinWrite(banner, kinSay("검사 목록을 갱신하지 못했습니다. 마지막 목록을 표시합니다"));
        else kinWrite(banner, text);
        listWarningText = written(); return;
      }
      if (listWarningText !== null && written() === listWarningText) banner.textContent = "";
      listWarningText = null;
    }
