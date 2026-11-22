

    // ══════════ 컬럼 스펙: 모드별로 다른 워크리스트 (6.3 / 8.1.1) ══════════
    // f: 없으면 필터 없음 / 'text' = 입력칸 / 배열 = 드롭다운
    const COLS = {
      Radiology: [
        // PF (prefetch): this session's Preload queue state; the filter compares the word preloadWord gives (filterPredicate).
        { k: "pf", t: "PF", f: ["Queued", "Downloading", "Ready", "Failed", "Evicted", "None"] },
        { k: "assignedReader", t: "Assigned Reader", f: "text" },
        { k: "techNote", t: "Tech Note", f: ["Yes", "None", "Cleared", "Unknown"] },
        { k: "no", t: "No", num: 1 },
        { k: "viewing", t: "Viewing" },
        { k: "count", t: "Count", num: 1 },
        { k: "series", t: "Series", num: 1 },
        { k: "em", t: "EM", f: ["E", "N"] },
        { k: "ss", t: "SS", f: ["Verified", "Unverified"] },
        { k: "rs", t: "RS", f: ["W", "T", "P", "H", "A"] },
        // Report approval date and time. Confirmed = RS Approved, with or without a stored time (see confirmText).
        { k: "confirm", t: "Confirm", f: ["Confirmed", "Not Confirmed"] },
        // Read Req: the open reading request a clinician made on the study (server readingRequest, this screen's local time);
        // blank when none or once the report is approved. The filter compares Requested / None (testSourceCol).
        { k: "readReq", t: "Read Req", f: ["Requested", "None"] },
        { k: "acc", t: "Accession No", f: "text" },
        { k: "ts", t: "TS" },
        { k: "id", t: "ID", f: "text" },
        { k: "name", t: "Name", f: "text" },
        // Request columns: from the matched order of the study (ReqDoc also from its DICOM physician tags); blank when unknown.
        { k: "reqDate", t: "ReqDate", f: "text" },
        // ReqDept is a text field for saved and compound searches (a department that left the list stays a valid value);
        // the header filter lists the departments of the loaded studies, and a chosen one that has left the list.
        { k: "reqDept", t: "ReqDept", f: "text", choices: () => requestDepartments() },
        { k: "reqDoc", t: "ReqDoc", f: "text" },
        { k: "ptClass", t: "Pt Class", f: ["Outpatient", "Inpatient", "ER", "ICU"] },
        { k: "age", t: "Age", num: 1, f: "text" },
        { k: "birth", t: "BirthDate" },
        { k: "sex", t: "Sex", f: ["M", "F", "O"] },
        { k: "modality", t: "Modality", f: ["CT", "MR", "CR", "US", "SC"] },
        { k: "desc", t: "StudyDesc", f: "text" },
        { k: "date", t: "StudyDate", f: "text" },
        // Referred: when the referring hospital's Gateway sent the study (server row referredAt, this screen's local time).
        // Blank for a study that did not come through a Gateway. Filters like ReqDate: "2026-11", "2026-11-20", "2026-11-20 09".
        { k: "referredAt", t: "Referred", f: "text" },
        // 예비 판독을 쓴 사람과, 최종 판독을 맡은 상급 판독의.
        // HPACS도 2025.07에 이 둘을 컬럼으로 붙였다 (교훈 §13 — 컬럼은 끝없이 늘어난다)
        { k: "preDoc", t: "PreDoc", f: "text" },
        { k: "preReviewer", t: "PreReviewer", f: "text" },
        // S7-U3b: 검사를 소유한 기관의 등록 이름(목록 행의 institutionName 그대로). 서버 목록(worklist-columns.ts)과 같은
        // 끝자리라 이 열이 생기기 전 저장된 열 설정에도 순서를 바꾸지 않고 맨 뒤에 보인다(두 정규화기의 규칙).
        { k: "institutionName", t: "Hospital", f: "text" },
        // StudyTime (DICOM TM, shown hh:mm[:ss]). Last in both server and page catalogues, so a saved column document keeps
        // its order and gains it at the end; Radiology opens with it hidden (View ▾ Columns turns it on).
        { k: "time", t: "StudyTime" },
      ],
      Technician: [
        { k: "assignedReader", t: "Assigned Reader", f: "text" },
        { k: "techNote", t: "Tech Note", f: ["Yes", "None", "Cleared", "Unknown"] },
        // QC Flag: the technician's image quality mark (the server's, pacs/qc-flag.ts). Unknown is a row whose mark has not
        // been received; it is neither Flagged nor None.
        { k: "qc", t: "QC Flag", f: ["Flagged", "None", "Unknown"] },
        { k: "no", t: "No", num: 1 },
        { k: "count", t: "Count", num: 1 },
        { k: "series", t: "Series", num: 1 },
        { k: "em", t: "EM", f: ["E", "N"] },
        { k: "ss", t: "SS", f: ["Verified", "Unverified"] },
        { k: "matched", t: "Mt", f: ["M", "U"] },
        { k: "rs", t: "RS", f: ["W", "T", "P", "H", "A"] },
        { k: "acc", t: "Accession No", f: "text" },
        { k: "id", t: "ID", f: "text" },
        { k: "name", t: "Name", f: "text" },
        { k: "age", t: "Age", num: 1, f: "text" },
        { k: "sex", t: "Sex", f: ["M", "F", "O"] },
        { k: "modality", t: "Modality", f: ["CT", "MR", "CR", "US", "SC"] },
        { k: "desc", t: "StudyDesc", f: "text" },
        { k: "date", t: "StudyDate", f: "text" },
        { k: "ward", t: "Ward", f: "text" },
        { k: "reqHosp", t: "ReqHosp" },
        { k: "time", t: "StudyTime" },
      ],
    };
    // 빈 StudyDescription을 데이터에 채우면 "같은 검사명" 묶음과 Modify 원본까지
    // 모달리티로 바뀐다. 원본 의미는 보존하고, 사람이 읽는 자리에서만 대체한다.
    function shownStudyDesc(s) {
      return String(s?.desc ?? "").trim()
        || String(s?.modality ?? "").trim()
        || "(설명 없음)";
    }
    /** A server time (ISO) as this screen's local "YYYY-MM-DD HH:mm"; anything unreadable is blank. */
    function localStamp(iso) {
      const d = typeof iso === "string" && iso ? new Date(iso) : null;
      if (!d || !Number.isFinite(d.getTime())) return "";
      const p = n => String(n).padStart(2, "0");
      return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
    }
    /** The same server time as a sort key (UTC ISO, seconds kept; the local stamp drops them); anything unreadable is "". */
    function serverInstant(iso) {
      const d = typeof iso === "string" && iso ? new Date(iso) : null;
      return d && Number.isFinite(d.getTime()) ? d.toISOString() : "";
    }
    /**
     * Confirm cell: the approval time of an Approved report. An approval stored before its time was kept shows the stored
     * approval date (YYYY-MM-DD, no time added); with neither it is blank but still Confirmed (confirmedRow).
     */
    function confirmText(a) {
      if (a?.rs !== "A") return "";
      return localStamp(a.approvedAt) || (typeof a.confirm === "string" && /^\d{4}-\d{2}-\d{2}$/.test(a.confirm) ? a.confirm : "");
    }
    const confirmedRow = s => s?.rs === "A";
    function requestDepartments() {
      const names = new Set(studies.map(s => s.reqDept).filter(v => typeof v === "string" && v));
      if (typeof fval.reqDept === "string" && fval.reqDept) names.add(fval.reqDept);
      return [...names].sort((a, b) => a.localeCompare(b));
    }
    /** A filter list that follows the loaded rows (ReqDept) is redrawn when its choices change; the chosen value stays. */
    function syncFilterChoices() {
      for (const c of shownColumns()) {
        if (!c.choices) continue;
        const select = $("#filterrow")?.querySelector(`select[data-f="${c.k}"]`);
        if (!select) continue;
        const want = ["", ...c.choices()], chosen = String(fval[c.k] ?? "");
        if ([...select.options].map(o => o.value).join("\n") === want.join("\n")) continue;
        // These choices are the loaded studies own values (departments), never translated.
        select.replaceChildren(...want.map(o => Object.assign(new Option(o, o, o === chosen, o === chosen), { translate: false })));
      }
    }

    /**
     * FC-034 승인 뒤 24시간 수정 창. 서버가 준 사실(`amendUntil` = 첫 승인 시각 + 24시간, `amendMine`, `addendumAt`,
     * `amendedAt`)과 이 화면의 시계로 그린다 — 열어 둔 화면도 다음 그리기 때 기한이 지났으면 Finalized로 바뀐다. 최종 판정은
     * 언제나 서버다. 승인 시각을 모르는 옛 승인본(`amendUntil` 없음)은 "24시간 지남"으로 말하지 않는다: 낱말은 Approved 그대로다.
     */
    const RS_WORD = { W: "Unread", A: "Approved", H: "On Hold", P: "Preliminary", T: "In Progress", D: "Destroyed" };
    function reportFinalized(a, now = Date.now()) {
      const until = a?.rs === "A" && a.amendUntil ? Date.parse(a.amendUntil) : NaN;
      return Number.isFinite(until) && now >= until;
    }
    function reportStatusWord(a, now) { return reportFinalized(a, now) ? "Finalized" : RS_WORD[a?.rs] ?? a?.rs; }
    /** 수정 창의 시각 — 판독 화면의 시각 한 규칙(이 화면의 시간대로 YYYY-MM-DD HH:mm, report-preview.js paperStamp). */
    function amendTime(iso) {
      return KinReportPaper.paperStamp(typeof iso === "string" ? iso : "") || "—";
    }
    /**
     * 승인본(RS A)에서 Approve(= 24시간 안의 수정 뒤 다시 승인)를 열지와 그 단추의 설명. `edited`는 편집기의 글이 승인본과
     * 다른가다 — 고친 글이 없는 재승인은 없다.
     */
    function amendApproval(a, edited, now = Date.now()) {
      if (!a?.amendUntil) return { open: false, title: "승인 시각을 확인할 수 없는 판독문입니다 — Addendum으로 덧붙일 수 있습니다" };
      if (reportFinalized(a, now)) return { open: false, title: "Finalized — 승인 후 24시간이 지났습니다. More ▸ Addendum으로 덧붙일 수 있습니다" };
      if (a.addendumAt) return { open: false, title: "추가기재(Addendum)가 붙은 판독문입니다 — More ▸ Addendum으로 덧붙일 수 있습니다" };
      if (!a.amendMine) return { open: false, title: "승인한 판독의만 24시간 안에 본문을 고칠 수 있습니다 — 덧붙이려면 More ▸ Addendum" };
      const until = amendTime(a.amendUntil);
      return edited
        ? { open: true, title: `승인 후 24시간 안입니다 — 본문을 고쳐 다시 Approve할 수 있습니다 (${until}까지). 의뢰의 화면에 "수정됨(시각)"이 붙습니다` }
        : { open: false, title: `승인됨 — 본문을 고치면 다시 Approve할 수 있습니다 (${until}까지)` };
    }
    /** 편집기 머리줄의 판독 상태(승인본일 때만): Approved/Finalized, 수정 가능 (시각)까지, 수정됨 (시각). */
    function reportStatusParts(a, now) {
      if (a?.rs !== "A") return [];
      const parts = [reportStatusWord(a, now)];
      if (a.amendUntil && !a.addendumAt && !reportFinalized(a, now)) parts.push(`수정 가능 ${amendTime(a.amendUntil)}까지`);
      if (a.amendedAt) parts.push(`수정됨 ${amendTime(a.amendedAt)}`);
      return parts;
    }
    function reportStatusLine(a, now) { return reportStatusParts(a, now).join(" · "); }
    /**
     * Who is on this study's report before approval (the report state table, report-visibility.ts): the live hold first (typing
     * has started - shown as In Progress even while the stored state is still Unread), else whoever Saved or Deferred the
     * text. `label` is what the screen names: the hold of another institution or of an unknown writer keeps its masked word.
     */
    function reportOnIt(s) {
      if (!s || !["W", "T", "H"].includes(s.rs)) return { typing: false, by: null, label: "" };
      if (s.holder) return { typing: s.rs === "W", by: s.holder, mine: s.holderMine, label: displayActor(s.holder) };
      const saved = appState[s.uid]?.savedBy || null;
      return { typing: false, by: saved, mine: appState[s.uid]?.savedByMine, label: saved ? displayActor(saved) : "" };
    }

    // 특수 렌더링이 필요한 칸만 함수로
    let studyPriority = null;
    const viewingNames = new Map();
    function qcCellHtml(s) {
      return s.qc === "Flagged" ? `<span class="qc-flag">Flagged</span> <span class="qc-reason" translate="no" data-kin-keep="title" title="${esc(s.qcMark.reason)}">${esc(s.qcMark.reason)}</span>`
        : s.qc === "Unknown" ? `<span class="qc-unknown">Unknown</span>` : "";
    }
    const CELL = {
      assignedReader:s=>`<button type="button" class="chip" data-reader-assignment="${esc(s.uid)}" ${!serverMode||demoMode||offline?'disabled':''}>${s.assignedReader?`<span translate="no">${esc(s.assignedReader)}</span>`:'Unassigned'}</button>`,
      techNote: s => { const chip = noteChip(s.uid, s.id); return `<button type="button" class="chip" data-tech-note="${esc(s.uid)}" aria-label="${esc(chip.aria)}" title="${esc(chip.title)}" ${!serverMode || demoMode || offline ? 'disabled' : ''}>${esc(chip.label)}</button>`; },
      // QC Flag: the word, and when flagged the reason (data: never translated or read as markup); the full reason is the title.
      // The cell names its study so it can be drawn again by itself (qcFollowsList, worklist-data.js).
      qc: s => `<span data-qc-uid="${esc(s.uid)}">${qcCellHtml(s)}</span>`,
      em: s => {const phase=studyPriority?.get(s.uid)?.phase;return phase?`<span title="${phase==='saving'?'응급 상태를 저장 중입니다':'저장 결과 미확인 — 문맥 메뉴의 Refresh Status로 확인하세요'}">${phase==='saving'?'Saving':'Unverified'}</span>`:s.em === "E" ? `<span class="em-e">E</span>` : "";},
      // 판독 상태 이름은 목록과 건수 줄에서 같은 계약을 따른다. 승인(A) 뒤 24시간이 지난 판독문은 낱말만 Finalized다(값은 A).
      rs: s => { const finalized = reportFinalized({ rs: s.rs, amendUntil: appState[s.uid]?.amendUntil }), word = finalized ? "Finalized" : RS_WORD[s.rs] ?? s.rs;
        const on = reportOnIt(s), shown = on.typing ? "In Progress" : word;
        const help = s.holdReason || (finalized ? "승인 후 24시간이 지나 확정된 판독문 — Addendum으로만 덧붙일 수 있습니다"
          : on.typing ? "판독의가 판독문을 쓰기 시작했습니다(점유) — 아직 저장하지 않았습니다"
          : s.rs === "D" ? "보존 기간이 끝나 판독문을 파기한 검사입니다"
          : word !== s.rs ? ({ W: "아직 판독하지 않은 검사", T: "저장했지만 아직 승인하지 않은 판독문", P: "상급 판독의 승인 대기", H: "판독 보류", A: "승인된 판독문" }[s.rs] || "") : "");
        // "In Progress by <name>": who is on it, for the other readers (the writer's own row needs no name). The name is data.
        const by = on.by && !on.mine ? ` <span class="rs-by">by <span translate="no">${esc(on.label)}</span></span>` : "";
        return `<span class="rs ${esc(on.typing ? "T" : s.rs)}"${s.holdReason ? ' data-kin-keep="title"' : ''} title="${esc(help + (by ? (help ? " — " : "") + on.label : ""))}">${esc(shown)}${by}</span>`; },
      confirm: s => esc(confirmText({ ...appState[s.uid], rs: s.rs })),
      // Read Req: the time of the open request (data) and who asked as its title (data, kept from translation).
      readReq: s => s.readReq ? `<span class="read-req" data-kin-keep="title" title="${esc(s.readReqBy)}"><span translate="no">${esc(s.readReq)}</span></span>` : "",
      // Missing images (Technician tab only): a mark beside the count, the same answer as the Info panel's Needs Check line
      // (studyReceiptGap; renderObservation repaints it between renders). Its words are its title; the mark itself is CSS
      // and there is no text around it, so a copy or export of the cell reads the count alone.
      count: s => { const gap = studyReceiptGap(s); return `<span translate="no">${esc(s.count ?? "")}</span><span class="receipt-gap" role="img" data-gap-uid="${esc(s.uid)}"` + (gap ? ` aria-label="${esc(gap.text)}" title="${esc(gap.text)}"></span>` : ` hidden></span>`); },
      ts: s => `<span class="ts ts-${esc(s.ts)}">${esc(s.ts)}</span>`,
      ss: s => `<span class="ss ${esc(s.ss)}">${esc(s.ss)}</span>`,
      // S4-U5: server values too, but escaped like every other cell; a stored value never becomes markup.
      matched: s => `<span class="mt ${esc(s.matched)}">${esc(s.matched)}</span>`,
      desc: s => esc(shownStudyDesc(s)),
      preDoc: s => esc(displayActor(s.preDoc)),
      preReviewer: s => esc(displayActor(s.preReviewer)),
      // A writer can hold the report with no viewer open. Presence excludes self; the lock does not.
      viewing: s => {
        const hold = !s.holder ? '' : s.holderMine
          ? `<span class="hold me" title="내가 작성 중">✎ 나</span>`
          : `<span class="hold other" title="${s.holder === '다른 기관' ? '다른 기관 판독의가' : s.holder === '작성자 비공개' ? '비공개 작성자가' : esc(displayActor(s.holder)) + ' 님이'} 작성 중">✎ <span translate="no">${esc(displayActor(s.holder))}</span></span>`;
        const presence = esc(viewingNames.get(s.uid) || '');
        return hold + (hold && presence ? ' · ' : '') + (presence ? `<span translate="no">${presence}</span>` : '');
      },
      // S7-U3b Hospital: 서버가 준 소유 기관 이름만 쓴다. Tele는 행의 tele만 따른다 — 이름을 내 기관 이름과 비교하면
      // 등록 이름이 같은 두 기관에서 틀리고, reqHosp는 Technician에서 손으로 바꿀 수 있는 값이다.
      // FC-071: the exam's Preload queue state (Downloading NN% / Queued / Ready / Failed / Evicted), else the row's "·".
      // A merged or split exam reads the originals its scope holds (KinPreloadQueue.exam), not the row's UID alone.
      pf: s => {
        const queue = window.KinPreloadQueue, entry = queue?.exam?.(s), text = queue?.cell?.(entry);
        return text ? `<span class="pf" title="${esc(entry.reason || '미리 받기 상태입니다. 자세한 내용은 선택 막대의 Preload 패널에 있습니다.')}">${esc(text)}</span>` : esc(s.pf ?? "");
      },
      institutionName: s => {
        const name = typeof s.institutionName === "string" && s.institutionName !== "" ? `<span translate="no">${esc(s.institutionName)}</span>` : "—";
        return s.tele === true ? `${name} <span class="tele-tag" title="원격판독으로 의뢰받은 검사입니다.">Tele</span>` : name;
      },
    };
    /**
     * The PF word a filter compares: the status CELL.pf shows (Queued / Downloading / Ready / Failed / Evicted, without
     * the percent), or "None" when this session's Preload queue does not hold the study (the cell's "·").
     */
    function preloadWord(s) {
      const entry = s ? window.KinPreloadQueue?.exam?.(s) : null;
      return typeof entry?.status === "string" && entry.status ? entry.status : "None";
    }

    let mode = "Radiology";
    const fval = {};   // 컬럼필터 값 (컬럼 key → 문자열)
    let columnPrefs = null, multiSelection = null, worklistExport = null, queryRetrieve = null, batchReport = null, batchApprove = null, imagePreview = null, imageThumbnails = null, worklistSearch = null, rowNavigation = null, relatedRowNavigation = null, relatedRows = [];
    const shownColumns = () => columnPrefs ? columnPrefs.columns(mode) : COLS[mode];

    // StudyDate filter: a preset menu (Today / since 2 days / a week / a month ago) or a custom From–To range.
    // It writes the same "from..to" text the column filter already understands (see testCol in worklist-view.js).
    const ymd = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    function datePresets() {
      const today = new Date(), back = f => { const d = new Date(today); f(d); return ymd(d); }, t = ymd(today);
      return [
        { id: "today", label: "Today", value: `${t}..${t}` },
        // FA-037 (Minhoon M-112 "어제부터"): yesterday from local midnight through today, the same words as the saved-search rule.
        { id: "1d", label: "Since Yesterday", value: `${back(d => d.setDate(d.getDate() - 1))}..${t}` },
        { id: "2d", label: "2 days ago", value: `${back(d => d.setDate(d.getDate() - 2))}..${t}` },
        { id: "1w", label: "A week ago", value: `${back(d => d.setDate(d.getDate() - 7))}..${t}` },
        { id: "1m", label: "A month ago", value: `${back(d => {
          // 말일에서 전달로 이동할 때 존재하지 않는 날짜가 이번 달로 넘치지 않게 한다.
          const day = d.getDate(); d.setDate(1); d.setMonth(d.getMonth() - 1);
          d.setDate(Math.min(day, new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate()));
        })}..${t}` },
      ];
    }
    function dateFilterHtml(c) {
      const cur = String(fval[c.k] ?? ""), presets = datePresets(), hit = presets.find(p => p.value === cur);
      const sel = cur === "" ? "" : hit ? hit.id : "custom", [from = "", to = ""] = cur.includes("..") ? cur.split("..") : [cur, cur];
      const opt = (v, l) => `<option value="${v}"${sel === v ? " selected" : ""}>${l}</option>`;
      return `<select data-date-preset aria-label="${esc(c.t)} Filter">` +
        opt("", "All dates") + presets.map(p => opt(p.id, p.label)).join("") + opt("custom", "Custom…") + `</select>` +
        `<span class="date-custom" hidden><label>From <input type="date" data-date-from aria-label="${esc(c.t)} From" value="${esc(from)}"></label><label>To <input type="date" data-date-to aria-label="${esc(c.t)} To" value="${esc(to)}"></label></span>`;
    }
    // Custom range is a floating window under the select (position: fixed), so the filter row never grows.
    function placeDatePopup(row) {
      const box = row.querySelector(".date-custom"), r = row.querySelector("[data-date-preset]").getBoundingClientRect();
      box.style.top = Math.round(r.bottom + 2) + "px";
      box.style.left = Math.round(Math.min(r.left, window.innerWidth - 230)) + "px";
    }
    document.addEventListener("pointerdown", e => {
      document.querySelectorAll("#filterrow .date-custom:not([hidden])").forEach(box => { if (!box.closest(".date-filter").contains(e.target)) box.hidden = true; });
    }, true);
    document.addEventListener("click", e => {   // clicking the select while "Custom…" is chosen reopens the window
      const sel = e.target.closest?.("#filterrow [data-date-preset]");
      if (sel && sel.value === "custom") { const row = sel.closest(".date-filter"), box = row.querySelector(".date-custom"); box.hidden = false; placeDatePopup(row); }
    });
    function applyDateFilter(row) {
      const preset = row.querySelector("[data-date-preset]").value, box = row.querySelector(".date-custom");
      box.hidden = preset !== "custom";
      if (!box.hidden) placeDatePopup(row);
      let value = "";
      if (preset === "custom") {
        const from = row.querySelector("[data-date-from]").value, to = row.querySelector("[data-date-to]").value;
        value = from || to ? `${from}..${to}` : "";
      } else if (preset) value = datePresets().find(p => p.id === preset).value;
      if (value) fval.date = value; else delete fval.date;
      folderAppliedSearch = null;
      worklistSearch?.change();
      render();
    }
    document.addEventListener("change", e => {
      const th = e.target.closest?.("#filterrow .date-filter"); if (th) applyDateFilter(th);
    });

    // Hover help for one- and two-letter headers. Only codes the screen already uses are explained (RS letters match the count bar).
    // Referred says where its time comes from and what a blank cell means.
    const HEAD_HELP = {
      rs: "RS (Report Status, 판독 상태)\nW: Unread — 판독 전\nT: In Progress — 저장했지만 승인 전\nP: Preliminary — 상급 판독의 승인 대기\nH: On Hold — 보류\nA: Approved — 승인됨\nA: Finalized — 승인 후 24시간이 지남, Addendum으로만 덧붙임\nD: Destroyed — 보존 기간 만료로 파기됨",
      referredAt: "Referred: 의뢰 병원의 Gateway가 이 검사를 처음 보낸 시각(서버 기준)\n비어 있음: 최초 Gateway 접수 시각이 기록되지 않은 검사",
      readReq: "Read Req: 진료과 의사가 이 검사의 판독을 의뢰한 시각\n칸에 마우스를 올리면 의뢰한 사람이 보입니다\n비어 있음: 의뢰가 없거나 판독문이 승인되어 의뢰가 닫힌 검사",
      em: "EM (Emergency)\nE: 응급\nN: 일반",
      ss: "SS (촬영 확인 상태)\nVerified: 촬영 확인됨\nUnverified: 촬영 미확인",
      pf: "PF (Prefetch, 미리 받기): 이 브라우저에 영상을 미리 받아 두는 상태입니다. 자세한 내용은 선택 막대의 Preload 패널에 있습니다.\nQueued: 받을 차례나 저장 공간을 기다림\nDownloading: 받는 중 (진행률 %)\nReady: 받아 둠 — 그 패널에 표시된 기한에 자동으로 정리됨 (받은 때나 마지막으로 본 때부터 72시간 이내)\nFailed: 받지 못함 — Preload 패널의 Retry로 다시 받음\nEvicted: 미리 받은 사본이 지워짐 (저장 공간·기한·Clear All 등) — Retry로 다시 받음\n· (None): 이 로그인의 미리 받기 상태가 없거나 아직 확인되지 않음",
    };
    function renderHeads() {
      // The first header also holds the "+" button; its own label keeps the column named by its title, not "Choose columns <title>".
      $("#heads").replaceChildren(...shownColumns().map((column, index) => {
        const head = document.createElement("th");
        head.dataset.key = column.k;
        if (column.num) head.className = "num";
        if (HEAD_HELP[column.k]) kinWrite(head, kinSay(HEAD_HELP[column.k]), "title");
        if (index === 0) {
          kinWrite(head, kinSay(column.t), "aria-label");
          const add = document.createElement("button");
          add.type = "button"; add.className = "col-add"; add.textContent = "+";
          add.setAttribute("aria-haspopup", "dialog");
          kinWrite(add, kinSay("Choose columns"), "aria-label");
          kinWrite(add, kinSay("표시할 열을 고릅니다."), "title");
          head.append(add);
        }
        head.append(kinWrite(document.createTextNode(""), kinSay(column.t)));
        return head;
      }));
      $("#heads .col-add")?.addEventListener("click", e => { e.stopPropagation(); openColumnPicker(e.currentTarget); });
      bindColumnResize();
      $("#filterrow").innerHTML = shownColumns().map((c, i) => {
        // The first column has no filter of its own, so the worklist's "Clear Filters" button lives in that cell.
        if (!c.f && i === 0) return '<th class="clear-cell"><button type="button" class="col-clear" >Clear</button></th>';
        if (!c.f) return "<th></th>";
        if (c.k === "date") return `<th class="date-filter">${dateFilterHtml(c)}</th>`;
        if (c.choices) return `<th><select data-f="${c.k}" aria-label="${esc(c.t)} Filter">` +
          ["", ...c.choices()].map(o => `<option value="${esc(o)}"${(fval[c.k] ?? "") === o ? " selected" : ""}>${esc(o)}</option>`).join("") +
          `</select></th>`;
        if (c.f === "text" || c.k === 'modality')
          return `<th><input data-f="${c.k}" aria-label="${esc(c.t)} Filter" value="${esc(fval[c.k] ?? "")}"></th>`;
        return `<th><select data-f="${c.k}" aria-label="${esc(c.t)} Filter">` +
          ["", ...c.f].map(o => `<option value="${esc(o)}"${(fval[c.k] ?? "") === o ? " selected" : ""}>${esc(o)}</option>`).join("") +
          `</select></th>`;
      }).join("");
      for (const field of $("#filterrow").querySelectorAll("[data-f], [data-date-preset], [data-date-from], [data-date-to]")) {
        const c = shownColumns().find(column => column.k === (field.dataset.f ?? "date"));
        if (c) kinWrite(field, kinSay(field.hasAttribute("data-date-from") ? "{0} From" : field.hasAttribute("data-date-to") ? "{0} To" : "{0} Filter", c.t), "aria-label");
      }
      if (!$("#filterrow .col-clear")) $("#filterrow th")?.insertAdjacentHTML("afterbegin", '<button type="button" class="col-clear" >Clear</button>');
      const clear = $("#filterrow .col-clear");
      if (clear) {
        kinWrite(clear, kinSay("Clear"));
        kinWrite(clear, kinSay("모든 검색 조건을 지웁니다."), "title");
      }
      const date = $("#filterrow [data-date-preset]");
      if (date) kinWrite(date, kinSay("기간을 고릅니다. Custom은 시작일과 종료일을 직접 정합니다."), "title");
    }
    // Top bar "Config" had no action. For now it opens the existing Panel Settings dialog (same as the Panels button).
    (function bindConfig() {
      const cfg = $("#m-config"); if (!cfg) return;
      const open = () => { const b = $("#panel-settings-open"); if (b && !b.disabled) b.click(); };
      cfg.addEventListener("click", open);
      cfg.addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); } });
    })();
    document.addEventListener("click", e => {
      if (e.target.closest?.("#filterrow .col-clear")) clearWorklistFilters();
    });
    // 드래그 중에도 같은 계정 열 상태를 사용하되 머리글을 다시 만들지 않아 포인터를 잃지 않는다.
    function bindColumnResize() {
      const heads = $("#heads");
      for (const th of heads.children) {
        const grip = document.createElement("span");
        grip.className = "col-grip";
        kinWrite(grip, kinSay("열 너비: 끌어서 조절, 두 번 클릭하면 자동 너비로 돌아갑니다."), "title");
        // Pointer-only handle (the keyboard path is the picker's width field). Exposed, its tooltip joined every column header's name.
        grip.setAttribute("aria-hidden", "true");
        grip.addEventListener("click", e => e.stopPropagation());
        grip.addEventListener("dblclick", e => { e.stopPropagation(); columnPrefs?.setWidth(mode, th.dataset.key, null); });
        grip.addEventListener("pointerdown", e => {
          if (e.button !== 0 || !columnPrefs) return;
          e.preventDefault(); e.stopPropagation(); grip.setPointerCapture(e.pointerId);
          // Saved widths are content widths, not the header boxes the pointer moves (those also hold the cell padding).
          const key = th.dataset.key, startX = e.clientX, content = columnPrefs.contentWidths(mode), start = content[key];
          const original = columnPrefs.widths(mode);
          const widths = Object.fromEntries(Object.entries(content).map(([k, w]) => [k, Math.max(64, Math.min(600, Math.round(w)))]));
          const move = ev => {
            widths[key] = Math.max(64, Math.min(600, Math.round(start + ev.clientX - startX)));
            columnPrefs.setWidths(mode, widths, false);
          };
          const done = ev => {
            grip.removeEventListener("pointermove", move); grip.removeEventListener("pointerup", done); grip.removeEventListener("pointercancel", done);
            if (grip.hasPointerCapture(e.pointerId)) grip.releasePointerCapture(e.pointerId);
            columnPrefs.setWidths(mode, ev.type === "pointercancel" ? original : widths, true);
          };
          grip.addEventListener("pointermove", move); grip.addEventListener("pointerup", done); grip.addEventListener("pointercancel", done);
        });
        th.append(grip);
      }
    }
    // "+" in the first header cell: tick any column of this mode on or off; applies at once.
    let columnPicker = null;
    function openColumnPicker(opener) {
      if (!columnPrefs) return;
      if (!columnPicker) {
        columnPicker = document.createElement("dialog"); columnPicker.id = "column-picker";
        columnPicker.setAttribute("aria-label", "Columns");
        columnPicker.addEventListener("click", e => { if (e.target === columnPicker) columnPicker.close(); });
        document.body.append(columnPicker);
      }
      const m = mode, head = document.createElement("header");
      const title = document.createElement("strong"); title.textContent = "Columns · " + m;
      const close = document.createElement("button"); close.type = "button"; kinWrite(close, kinSay("Close")); close.onclick = () => columnPicker.close();
      head.append(title, close);
      const list = document.createElement("div"); list.className = "cp-list";
      let dragged = null;
      const clearDrop = () => { for (const el of list.querySelectorAll(".cp-before, .cp-after")) el.classList.remove("cp-before", "cp-after"); };
      const draw = () => {
        list.replaceChildren(...columnPrefs.all(m).map(c => {
          const row = document.createElement("div"); row.className = "cp-row"; row.dataset.column = c.k;
          const grip = document.createElement("span"); grip.className = "cp-grip"; grip.textContent = "≡"; grip.draggable = true;
          kinWrite(grip, kinSay("끌어서 열 순서를 바꿉니다."), "title");
          grip.addEventListener("dragstart", e => { dragged = c.k; row.classList.add("cp-dragging"); e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", c.k); });
          grip.addEventListener("dragend", () => { dragged = null; clearDrop(); row.classList.remove("cp-dragging"); });
          row.addEventListener("dragover", e => {
            if (!dragged || dragged === c.k) return;
            e.preventDefault(); e.dataTransfer.dropEffect = "move";
            const box = row.getBoundingClientRect(); clearDrop(); row.classList.add(e.clientY > box.top + box.height / 2 ? "cp-after" : "cp-before");
          });
          row.addEventListener("dragleave", e => { if (!row.contains(e.relatedTarget)) row.classList.remove("cp-before", "cp-after"); });
          row.addEventListener("drop", e => {
            if (!dragged || dragged === c.k) return;
            e.preventDefault(); const after = row.classList.contains("cp-after"), moving = dragged; dragged = null; clearDrop();
            columnPrefs.move(m, moving, c.k, after); draw();
          });
          const label = document.createElement("label"), box = document.createElement("input");
          box.type = "checkbox"; box.checked = c.shown; box.disabled = c.required;
          box.addEventListener("change", () => { columnPrefs.setShown(m, c.k, box.checked); });
          // The column name and the (Required) mark are each their own text (the label reads the same).
          label.append(box, " ", c.t, c.required ? " (Required)" : "");
          const width = document.createElement("input"); width.type = "number";
          width.min = "64"; width.max = "600"; width.step = "1"; kinWrite(width, kinSay("Auto"), "placeholder");
          width.setAttribute("aria-label", c.t + " width (px)"); width.value = c.width ?? "";
          width.addEventListener("change", () => {
            if (width.validity.valid) columnPrefs.setWidth(m, c.k, width.value === "" ? null : width.valueAsNumber);
          });
          row.append(grip, label, width); return row;
        }));
      };
      const bulk = document.createElement("footer");
      const all = document.createElement("button"); all.type = "button"; kinWrite(all, kinSay("Show All"));
      all.onclick = () => { for (const c of columnPrefs.all(m)) if (!c.shown) columnPrefs.setShown(m, c.k, true); draw(); };
      bulk.append(all);
      draw(); columnPicker.replaceChildren(head, list, bulk);
      const box = opener.getBoundingClientRect();
      columnPicker.style.cssText = `position:fixed;margin:0;left:${Math.max(4, Math.round(box.left))}px;top:${Math.round(box.bottom + 2)}px;max-height:${Math.max(160, innerHeight - box.bottom - 12)}px;`;
      columnPicker.onclose = () => { try { opener.isConnected && opener.focus(); } catch (_) {} };
      if (!columnPicker.open) columnPicker.showModal();
    }
    const reportedModalityInputs = new WeakSet();
    function commitModalityInput(el) {
      if (el?.dataset.f !== 'modality') return true;
      if (el.validationMessage) {
        if (!reportedModalityInputs.has(el)) toast(el.validationMessage, 'err');
        reportedModalityInputs.add(el);
        return false;
      }
      el.value = String(fval.modality ?? '');
      return true;
    }
    $('#filterrow').addEventListener('focusout', e => commitModalityInput(e.target));
    $('#filterrow').addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229 && !commitModalityInput(e.target)) {
        e.preventDefault(); e.stopImmediatePropagation();
      }
    });
    document.addEventListener('click', e => {
      if (e.target.closest('[data-search-apply]') && !commitModalityInput($('#filterrow [data-f=modality]'))) {
        e.preventDefault(); e.stopImmediatePropagation();
      }
    }, true);
    $("#filterrow").addEventListener("input", e => {
      const el = e.target.closest("[data-f]"); if (!el) return;
      let value = el.value.trim();
      if (el.dataset.f === 'modality') {
        reportedModalityInputs.delete(el);
        const tokens = value.split(/[,\\]/).map(v => v.trim().toUpperCase());
        const allowed = KinWorklistFolderTree.defaultModalities(studies);
        const error = value && tokens.some(v => !v || !allowed.includes(v))
          ? '사용할 수 없는 Modality입니다. 빈 값 없이 목록의 Modality를 쉼표로 구분해 입력하세요.' : '';
        el.setCustomValidity(error);
        // Incomplete tokens keep the last applied criteria while the doctor types.
        if (error) return;
        if (/[,\\]/.test(el.value)) value = [...new Set(tokens)];
        else value = tokens[0] || '';
        folderAppliedSearch = null;
      }
      fval[el.dataset.f] = value;
      worklistSearch?.change();
      render();
    });
