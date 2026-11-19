

    function renderClinical() {
      imagePreview?.sync();
      const s = viewed();
      renderPatientCopy();
      imageRequests?.sync();
      if (srUid && srUid !== s?.uid) closeSR();
      $('#sr-open').disabled = !s || demoMode;
      $('#tech-note-open').disabled = !s || demoMode || !serverMode || offline;
      // S5-U4b: 판독 대상이 바뀐 때만 그 검사의 임상의 질문을 읽는다(같은 대상이면 요청도 그리기도 없다).
      studyQuestions?.sync();
      // S7-U1b: 판독 대상이나 화면이 아는 판독 상태가 바뀐 때만 Mark CVR의 서버 답(#1)을 다시 읽는다.
      criticalResults?.sync();
      // S7-U4b: 보는 검사가 바뀐 때만 Clinical Context를 다시 읽는다(같은 검사면 요청도 그리기도 없다).
      clinicalContext?.sync();
      $("#clinical").innerHTML = s ? `
        <div class="clinical-scope"></div>
        <table>
          <tr><td>Patient</td><td translate="no">${esc(s.name)} (${esc(s.id)})</td></tr>
          <tr><td>Sex/Age</td><td translate="no">${esc(s.sex)} / ${esc(s.age)}</td></tr>
          <tr><td>Birth</td><td translate="no">${esc(s.birth)}</td></tr>
          <tr><td>Study</td><td translate="no">${esc(shownStudyDesc(s))}</td></tr>
          <tr><td>Date</td><td translate="no">${esc(s.date)}</td></tr>
          <tr><td>AccNo</td><td translate="no">${esc(s.acc)}</td></tr>
          <tr><td>Img/Se</td><td>${esc(s.count)} / ${esc(s.series)}</td></tr>
          <tr><td>SS / Mt</td><td><span>${esc(s.ss)}</span> / <span>${s.matched === "M" ? "Matched" : "Unmatched"}</span></td></tr>
          <tr><td>Ward</td><td translate="no">${esc(s.ward) || "-"}</td></tr>
          <tr><td>Study UID</td><td translate="no">${esc(s.uid)}</td></tr>
        </table>` : "No clinical information provided.";
      if (s) kinWrite($("#clinical .clinical-scope"), s.uid === selectedUid ? kinSay("판독 대상 검사 정보") : kinSay("관련 검사 정보 · 판독 대상은 바뀌지 않습니다"));
      renderStudyIdentity();
      renderQcInfo();
      renderAcquisition();
      renderObservation();
    }

    /**
     * QC Flag line (every tab; render() repaints it after each poll): the viewed study's mark as this page last took it from
     * the server (qcMark). The reason and who are data and are never translated. It is its own line: SS, RS, the order match
     * and the missing-images line are drawn apart and are not changed by it.
     */
    function renderQcInfo() {
      const box = $("#study-qc");
      if (!box) return;
      const s = viewed();
      box.hidden = !s;
      if (!s) { box.replaceChildren(); return; }
      const mark = qcMark(appState[s.uid]), parts = [kinWrite(document.createElement("span"), kinSay("QC Flag")), ": "];
      const word = kinWrite(document.createElement("strong"), kinSay(!mark ? "Unknown" : mark.reason === null ? "None" : "Flagged"));
      word.className = "qc-word";
      parts.push(word);
      if (mark?.reason) {
        const data = text => Object.assign(document.createElement("span"), { translate: false, textContent: text });
        const reason = data(mark.reason); reason.className = "qc-info-reason";
        parts.push(" — ", reason);
        const who = [mark.by ? displayActor(mark.by) : "", mark.at ? localStamp(mark.at) : ""].filter(Boolean).join(" · ");
        if (who) parts.push(" (", data(who), ")");
      }
      box.dataset.qc = !mark ? "Unknown" : mark.reason === null ? "None" : "Flagged";
      box.replaceChildren(...parts);
    }

    /**
     * Protocol and dose (Technician tab only): what the viewed exam's own DICOM records, read in this tab for the originals
     * and series of its scope (KinExamScope) and judged by KinAcquisition (one rule: a value is shown with the tag it was read
     * from and its unit; "Not in DICOM" only after every object of the series was read; a failed or skipped read is said as
     * such). Answers are kept per exam scope in this tab's memory only and drawn only while that exam is still the one viewed.
     */
    const KinAcquisition = (() => {
      const MAX_SERIES = 40, RDSR = "1.2.840.10008.5.1.4.1.1.88.67", MAX_VALUES = 4, MAX_EVENTS = 20;
      const first = (ds, tag) => ds?.[tag]?.Value?.[0];
      const text = (ds, tag) => { const v = first(ds, tag); return typeof v === "string" ? v.trim() : typeof v === "number" ? String(v) : ""; };
      const items = (ds, tag) => Array.isArray(ds?.[tag]?.Value) ? ds[tag].Value.filter(v => v && typeof v === "object") : [];
      /** Distinct recorded values with how many objects (or frames) carry each, in first-seen order; never summed. */
      function tally() {
        const values = new Map();
        return { add(v) { values.set(v, (values.get(v) ?? 0) + 1); }, absent: 0, unreadable: 0,
          list() { return [...values].map(([value, count]) => ({ value, count })); } };
      }
      // CTDIvol (0018,9345) is recorded in mGy (PS3.3 CT Exposure Macro). A value that is not a finite number is unreadable.
      function ctdiOf(raw, into) {
        if (raw === undefined) { into.absent++; return; }
        const n = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() ? Number(raw) : NaN;
        if (Number.isFinite(n)) into.add(String(n)); else into.unreadable++;
      }
      /** One series' objects: Protocol Name per object; CTDIvol per object, or per frame of an enhanced multi-frame object. */
      function judgeSeries(objects, expected) {
        const protocol = tally(), ctdi = tally();
        let frames = 0;
        for (const ds of objects) {
          if (text(ds, "0020000D") !== expected.study || text(ds, "0020000E") !== expected.series) throw new Error("identity");
          const name = text(ds, "00181030");
          if (name) protocol.add(name); else protocol.absent++;
          const perFrame = items(ds, "52009230"), shared = items(ds, "52009229")[0];
          const sharedCtdi = first(items(shared, "00189321")[0], "00189345");
          if (perFrame.length) for (const frame of perFrame) {
            frames++;
            const own = first(items(frame, "00189321")[0], "00189345");
            ctdiOf(own !== undefined ? own : sharedCtdi !== undefined ? sharedCtdi : first(ds, "00189345"), ctdi);
          } else ctdiOf(sharedCtdi !== undefined ? sharedCtdi : first(ds, "00189345"), ctdi);
        }
        return { protocol, ctdi, frames };
      }
      const code = item => text(items(item, "0040A043")[0], "00080100");
      function measured(item) {
        const m = items(item, "0040A300")[0], raw = first(m, "0040A30A"), unit = text(items(m, "004008EA")[0], "00080100");
        const n = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() ? Number(raw) : NaN;
        return Number.isFinite(n) && unit ? { value: String(n), unit } : { unreadable: true };
      }
      function find(node, wanted, out = [], depth = 0) {
        if (depth > 32) return out;
        for (const item of items(node, "0040A730")) { if (code(item) === wanted) out.push(item); find(item, wanted, out, depth + 1); }
        return out;
      }
      /**
       * An X-Ray Radiation Dose SR: the total DLP it records (TID 10012 CT Accumulated Dose Data 113811 → 113813), as that
       * report's own total; only when it has none, each irradiation event's Mean CTDIvol (113830) and DLP (113838) (TID 10013,
       * CT Acquisition 113819). Its own unit is kept; nothing is added up across reports or events.
       */
      function doseReport(ds) {
        const totals = find(ds, "113811").flatMap(container => find(container, "113813")).map(measured);
        const events = find(ds, "113819").map(event => ({ ctdi: find(event, "113830").map(measured)[0] ?? null,
          dlp: find(event, "113838").map(measured)[0] ?? null }));
        return { total: totals[0] ?? null, events: totals.length ? [] : events };
      }
      async function read(row, request) {
        const scope = KinExamScope.read(row);
        if (!scope) return { state: "unavailable" };
        const listed = await KinExamScope.dicom(row, "series?limit=501", path => request(path));
        const all = listed.map(({ sourceUid, row: ds }) => ({ sourceUid, seriesUid: text(ds, "0020000E"), modality: text(ds, "00080060"),
          number: text(ds, "00200011"), description: text(ds, "0008103E") }))
          .filter(s => s.seriesUid).sort((a, b) => a.sourceUid.localeCompare(b.sourceUid) || (Number(a.number) || 0) - (Number(b.number) || 0));
        const chosen = all.slice(0, MAX_SERIES), series = [], reports = [];
        for (const s of chosen) {
          let objects;
          try {
            objects = await request("/dicom-web/studies/" + encodeURIComponent(s.sourceUid) + "/series/" + encodeURIComponent(s.seriesUid) + "/metadata");
            if (!objects.length) throw new Error("empty");
            const judged = judgeSeries(objects, { study: s.sourceUid, series: s.seriesUid });
            series.push({ ...s, state: "read", objects: objects.length, ...judged });
            for (const ds of objects) if (text(ds, "00080016") === RDSR)
              reports.push({ sourceUid: s.sourceUid, seriesUid: s.seriesUid, number: s.number, ...doseReport(ds) });
          } catch (e) { series.push({ ...s, state: "failed" }); }
        }
        const partial = scope.sources.some(source => source.series.mode !== "all");
        return { state: "done", series, reports, skipped: all.length - chosen.length, sources: scope.sources.length, partial,
          complete: series.every(s => s.state === "read") };
      }
      const valuesText = (t, unit) => {
        const list = t.list(), shown = list.slice(0, MAX_VALUES).map(v => v.value + (unit ? " " + unit : "") + (list.length > 1 ? ` (${v.count})` : ""));
        return shown.join(", ") + (list.length > MAX_VALUES ? ` … +${list.length - MAX_VALUES}` : "");
      };
      /** One fact of a series: its recorded values, then how many objects lack it or carry an unreadable one. */
      function factParts(label, t, unit, of) {
        const parts = [{ say: label }, { say: ": " }];
        if (t.list().length) parts.push({ data: valuesText(t, unit) });
        if (t.absent && t.list().length) parts.push({ say: " · Not in DICOM in {n0} of {n1}", args: [t.absent, of] });
        else if (t.absent) parts.push({ say: "Not in DICOM" });
        if (t.unreadable) parts.push({ say: " · Could not read in {n0} of {n1}", args: [t.unreadable, of] });
        return parts;
      }
      function lines(result) {
        if (result.state === "reading") return [{ kind: "status", parts: [{ say: "Protocol & Dose: reading DICOM…" }] }];
        if (result.state === "unavailable") return [{ kind: "status", parts: [{ say: "Protocol & Dose: Could not read (the exam's originals cannot all be read)" }] }];
        if (result.state === "failed") return [{ kind: "status", parts: [{ say: "Protocol & Dose: Could not read" }] }];
        const out = [{ kind: "head", parts: [{ say: "Protocol & Dose (recorded in DICOM)" }] }];
        if (!result.series.length) out.push({ kind: "status", parts: [{ say: "No series found" }] });
        for (const s of result.series) {
          const name = [s.number ? "Se " + s.number : "", s.modality, s.description].filter(Boolean).join(" · ") || s.seriesUid;
          const head = { kind: "series", parts: [...(result.sources > 1 ? [{ data: s.sourceUid }, { say: " · " }] : []), { data: name }] };
          if (s.state !== "read") { head.parts.push({ say: " — Could not read" }); out.push(head); continue; }
          const of = s.frames || s.objects;
          out.push(head,
            { kind: "protocol", parts: factParts("Protocol (0018,1030)", s.protocol, "", s.objects) },
            { kind: "ctdi", parts: factParts("CTDIvol (0018,9345)", s.ctdi, "mGy", of) });
        }
        // DLP comes only from an X-Ray Radiation Dose SR of the study: each report on its own line, never added up.
        const readAll = result.complete && !result.skipped;
        if (!result.reports.length) out.push({ kind: "dlp", parts: readAll
          ? [{ say: "DLP (Dose SR)" }, { say: ": " }, { say: "Not in DICOM" }]
          : [{ say: "DLP (Dose SR)" }, { say: ": " }, { say: "Not found in the series read" }] });
        for (const r of result.reports) {
          const where = [{ say: "DLP (Dose SR{t0})", args: [{ t: r.number ? " Se " + r.number : "" }] },
            ...(result.partial ? [{ say: " — of the whole original study, not of this part" }] : []), { say: ": " }];
          if (r.total) out.push({ kind: "dlp", parts: [...where, r.total.unreadable ? { say: "Could not read" }
            : { data: r.total.value + " " + r.total.unit }, { say: " (total, 113813)" }] });
          else if (!r.events.length) out.push({ kind: "dlp", parts: [...where, { say: "Not in DICOM" }] });
          else r.events.slice(0, MAX_EVENTS).forEach((event, i) => out.push({ kind: "dlp-event", parts: [...where,
            { say: "Event {n0}: ", args: [i + 1] },
            { say: "CTDIvol " }, event.ctdi && !event.ctdi.unreadable ? { data: event.ctdi.value + " " + event.ctdi.unit } : { say: event.ctdi ? "Could not read" : "Not in DICOM" },
            { say: " · DLP " }, event.dlp && !event.dlp.unreadable ? { data: event.dlp.value + " " + event.dlp.unit } : { say: event.dlp ? "Could not read" : "Not in DICOM" }] }));
        }
        if (result.skipped) out.push({ kind: "status", parts: [{ say: "{n0} more series not read (limit {n1})", args: [result.skipped, MAX_SERIES] }] });
        return out;
      }
      return { read, lines, judgeSeries, doseReport };
    })();
    const acquisitionCache = new Map();
    let acquisitionSeq = 0;
    /** Refresh (a list read the person asked for), a session change or a refused read: read the DICOM again next time. */
    function forgetAcquisition() {
      acquisitionCache.clear(); acquisitionSeq++;
      const box = $("#study-acquisition"); if (box) box.dataset.key = "";
    }
    function acquisitionKey(s) {
      if (!s || s.examUnavailable) return null;
      let scope = null;
      try { scope = KinExamScope.read(s); } catch (_) { scope = null; }
      return scope ? s.uid + "|" + KinExamScope.screenStamp(s) + "|" + (s.count ?? "") + "|" + (s.series ?? "") : null;
    }
    function renderAcquisition() {
      const box = $("#study-acquisition");
      if (!box) return;
      const s = viewed(), show = !!s && mode === "Technician" && serverMode && !demoMode;
      box.hidden = !show;
      if (!show) { box.replaceChildren(); box.dataset.key = ""; return; }
      const key = acquisitionKey(s);
      if (!key) { box.dataset.key = ""; box.replaceChildren(...KinAcquisition.lines({ state: "unavailable" }).map(acquisitionLine)); return; }
      // Drawn (or being read) for this key already: nothing to do. Refresh and a session change clear the key (forgetAcquisition).
      if (box.dataset.key === key) return;
      const known = acquisitionCache.get(key);
      box.dataset.key = key;
      if (known) { box.replaceChildren(...KinAcquisition.lines(known).map(acquisitionLine)); return; }
      box.replaceChildren(...KinAcquisition.lines({ state: "reading" }).map(acquisitionLine));
      if (offline) return;
      readAcquisition(s, key);
    }
    /** One drawn line: its fixed words through the screen language, its values (tags' contents, series names) as data. */
    function acquisitionLine(line) {
      const row = document.createElement("div");
      row.className = "acq-line"; if (line.kind) row.dataset.kind = line.kind;
      for (const part of line.parts) row.append(part.data
        ? Object.assign(document.createElement("span"), { translate: false, textContent: part.data })
        : kinWrite(document.createElement("span"), kinSay(part.say, ...(part.args || []))));
      return row;
    }
    async function readAcquisition(s, key) {
      // Each read has its own deadline (a study with many series is not cut off as a whole); the context drops a late answer.
      const seq = ++acquisitionSeq, at = work.capture("document");
      const request = async path => {
        const res = await transport.request(path, { context: at, cache: "no-store",
          headers: { Accept: "application/dicom+json" }, deadlineMs: 20000 });
        if (!res.ok || !Array.isArray(res.body)) throw Object.assign(new Error("HTTP " + res.status), { status: res.status });
        return res.body;
      };
      let result;
      try { result = await KinAcquisition.read(s, request); }
      catch (e) { result = { state: "failed" }; }
      work.commit(at, () => {
        // A whole read is kept for its key (the exam scope, counts and series of the list row it was read for); a read with a
        // failure is not kept, so the next viewing reads again. It is drawn only while that same exam is the one viewed.
        if (result.state === "done" && result.complete) acquisitionCache.set(key, result);
        const box = $("#study-acquisition"), now = viewed();
        if (seq !== acquisitionSeq && box?.dataset.key !== key) return;
        if (!box || box.hidden || box.dataset.key !== key || acquisitionKey(now) !== key) return;
        box.replaceChildren(...KinAcquisition.lines(result).map(acquisitionLine));
      });
    }

    /**
     * S4-U1b 수신 표시. 세 축을 한 단어로 접지 않는다 — 기관 배정(A), KIN이 관측한 보유(B),
     * Gateway가 보고한 전송(C). 관측은 이 탭의 메모리에만 있고 서버에 이력을 남기지 않는다.
     * 관측 실패는 아무것도 비우지 않고 `관측 불가`만 더한다. 상태 `studyObservationModel`은 `studies` 옆에 둔다.
     * S4-U3: 축 C는 서버가 목록 행에 실어 준 마지막 Gateway 영수증이다. 영수증이 없으면 `No Gateway Report`(정상)다.
     */
    function applyObservation(result) {
      if (!studyObservationModel) return;
      const next = KinStudyArrivals.observationSucceeded(studyObservationModel, result);
      // A response whose observation cannot be read is not an observation; the last one stays.
      studyObservationModel = next.ok ? next.model : KinStudyArrivals.observationFailed(studyObservationModel);
      // The poll renders before it updates rows in place, so the receipt rides on this same readable answer;
      // an unreadable one keeps the last receipt, like everything else here.
      if (next.ok) {
        const receipts = new Map(result.studies.map(row => [row.uid, row.gatewayReceipt ?? null]));
        for (const study of studies) if (receipts.has(study.uid)) study.gatewayReceipt = receipts.get(study.uid);
      }
      // S4-U2: the order answer rides on this same observation and fails with it.
      applyOrderReconciliation(next.ok ? result : null);
      // S4-U5: so do the server-read tags and the linked-order relations of each row.
      applyStudyIdentity(next.ok ? result : null);
      // S7-U4b: the Clinical Context panel compares this same readable answer with the answer it shows (contract 8.1).
      clinicalContext?.observe(next.ok ? result : null);
      renderObservation();
    }
    function markObservationUnavailable() {
      if (!studyObservationModel) return;
      studyObservationModel = KinStudyArrivals.observationFailed(studyObservationModel);
      applyOrderReconciliation(null);
      applyStudyIdentity(null);
      renderObservation();
    }
    /**
     * Missing images, Technician tab only: the one answer (KinStudyArrivals.receiptGap) that the list's Count cell, the
     * Info panel's Needs Check line and a Not Observed item draw. A merged or split exam is answered per original
     * (KinStudyArrivals.examGap: how many of its originals miss images, never from its summed count); each original's own
     * numbers are its line under Original exams. The count and the Gateway report it compares are both the last
     * successful observation's, so a row replaced before its observation is judged never pairs an old count with a new
     * report. renderObservation() draws every surface of it at once (the list's marks too); setMode() and the poll's list
     * rebuild call it.
     */
    function studyReceiptGap(s) {
      // A row of a merged or split exam in force whose originals cannot all be read now has no scope, yet is that exam:
      // it says so itself (KinExamScope.unavailable) and gets no answer here, so no number of an original it cannot read.
      if (!s || !studyObservationModel || KinExamScope.unavailable(s)?.kind) return null;
      const scope = KinExamScope.read(s);
      const gap = scope?.groupId ? KinStudyArrivals.examGap(studyObservationModel, scope.sources.map(source => source.studyUid))
        : KinStudyArrivals.originalGap(studyObservationModel, s.uid);
      return gap?.missing && mode === "Technician" ? gap : null;
    }
    /**
     * One list Count cell between renders: the count (the span before the mark) and the mark, painted together from the
     * study row and the answer, as CELL.count draws them on render() — the number never lags behind its mark.
     */
    function paintReceiptGap(mark, s) {
      const gap = studyReceiptGap(s), value = mark.previousElementSibling;
      if (s && value) value.textContent = String(s.count ?? "");
      mark.hidden = !gap; mark.title = gap?.text ?? "";
      if (gap) mark.setAttribute("aria-label", gap.text); else mark.removeAttribute("aria-label");
    }
    function renderObservation() {
      if (!studyObservationModel) return;
      for (const mark of $("#rows")?.querySelectorAll(".receipt-gap[data-gap-uid]") ?? [])
        paintReceiptGap(mark, studies.find(s => s.uid === mark.dataset.gapUid));
      const summary = KinStudyArrivals.observationSummary(studyObservationModel), status = $("#observation-status");
      if (status) { status.hidden = !summary.text; kinWrite(status, summary.text); status.title = summary.title; }
      // S4-U4 Now Retry, drawn only from labels.retry. Another study or a newer receipt drops the in-flight token
      // and the requested mark, so an answer for what was drawn before is never written over it (A->B->A too).
      // S4-F01V: one drawing serves the worklist panel and every Not Observed item, so both keep the same rules.
      const drawRetry = (s, retry, retryButton, retryNote) => {
        const retryKey = retry?.kind === "now_retry" ? retry.key : "";
        if (retryButton.dataset.uid !== s.uid || retryButton.dataset.key !== retryKey) {
          Object.assign(retryButton.dataset, { uid: s.uid, key: retryKey, request: "", requested: "" });
          retryNote.textContent = ""; retryNote.title = "";
        }
        retryButton.hidden = !retryKey || retryButton.dataset.requested === "1"
          || !(serverMode && !offline && !demoMode && KinAuth.has("technician"));
        retryButton.disabled = !!retryButton.dataset.request; retryButton.title = retry?.title ?? "";
        // Without a bindable retry the note is labels.retry itself: the F-01 sentence for failed, else nothing.
        if (!retryKey) { retryNote.textContent = retry?.text ?? ""; retryNote.title = retry?.title ?? ""; }
      };
      const absent = summary.notObserved ?? [], box = $("#not-observed");
      if (box) {
        box.hidden = !absent.length;
        $("#not-observed-summary").textContent = absent.length
          ? `Not Observed (${absent.length})` + (summary.key === "observation_unavailable" ? " · 마지막 관측 기준" : "") : "";
        // S4-F01V: every item is an own study (axis A assigned) and its own receipt adds the Gateway text and Now Retry.
        // Items are kept per UID so a request in flight survives a redraw. An item that leaves the list drops its
        // token, so a late answer is never written anywhere, and one that comes back is built new (A->B->A).
        const list = $("#not-observed-list"), kept = new Map([...list.children].map(item => [item.dataset.uid, item]));
        const items = absent.map(row => {
          let item = kept.get(row.uid);
          kept.delete(row.uid);
          if (!item) {
            const control = document.createElement("button");
            control.type = "button"; control.className = "chip"; control.hidden = true;
            control.textContent = KinStudyArrivals.RETRY_TEXT.button;
            control.addEventListener("click", requestGatewayRetry);
            item = document.createElement("div"); item.dataset.uid = row.uid;
            const gapText = document.createElement("span"); gapText.className = "receipt-gap-line"; gapText.hidden = true;
            item.append(document.createElement("span"), " ", control, " ", document.createElement("span"), " ", gapText);
          }
          const gateway = row.gatewayReceipt ?? null, [text, button, note, gapText] = item.children;
          // An own study the observation did not see at all while its Gateway reported images sent: the same answer.
          const gap = studyReceiptGap(row);
          gapText.hidden = !gap; kinWrite(gapText, gap?.text ?? ""); gapText.title = gap?.title ?? "";
          const labels = KinStudyArrivals.receiptLabels({ assignment: "assigned",
            observation: KinStudyArrivals.studyObservation(studyObservationModel, row.uid), gateway });
          // Without a receipt the text stays the U1b item text; no No Gateway Report is added to this list.
          text.textContent = `${row.uid} · ${row.origin} · ${KinStudyArrivals.formatTime(row.createdAt)}`
            + (gateway === null ? "" : ` · ${labels.gateway.text}`);
          text.title = gateway === null ? "" : labels.gateway.title;
          drawRetry(row, labels.retry, button, note);
          return item;
        });
        for (const item of kept.values()) item.querySelector("button").dataset.request = "";
        // Moving a kept item would drop keyboard focus, so the children are replaced only when the items change.
        if (items.length !== list.children.length || items.some((item, index) => item !== list.children[index])) list.replaceChildren(...items);
      }
      const s = viewed(), receipt = $("#study-receipt");
      if (!receipt) return;
      receipt.hidden = !s;
      if (!s) {
        const originals=receipt.querySelector('.exam-original-receipts');
        for(const control of originals?.querySelectorAll('button')||[])control.dataset.request='';
        originals?.replaceChildren();return;
      }
      // Every worklist row passed the visible() boundary on the server, so axis A is `assigned` here;
      // a study whose sending hospital is unknown is held and reaches no list (D1882).
      const labels = KinStudyArrivals.receiptLabels({ assignment: "assigned",
        observation: KinStudyArrivals.studyObservation(studyObservationModel, s.uid), gateway: s.gatewayReceipt ?? null });
      // A3 unit 8: the registered name of the sending (owning) institution, as the list row carries it, before the axis-A word.
      const institution = $("#receipt-institution");
      if (institution) {
        const name = typeof s.institutionName === "string" ? s.institutionName.trim() : "";
        institution.textContent = name ? `${name} · ` : "";
        institution.translate = false;
        kinWrite(institution, name ? kinSay("HALO PACS에 등록된 보낸 기관 이름입니다. DICOM 원문 기관명은 DICOM Identity의 (0008,0080) 줄에 있습니다.") : "", "title");
      }
      $("#receipt-assignment").textContent = labels.assignment.text; $("#receipt-assignment").title = labels.assignment.title;
      $("#receipt-observation").textContent = [labels.observation.text, labels.change?.text].filter(Boolean).join(" · ");
      $("#receipt-observation").title = labels.observation.title;
      drawRetry(s, labels.retry, $("#receipt-retry"), $("#receipt-retry-note"));
      $("#receipt-gateway").textContent = labels.gateway.text; $("#receipt-gateway").title = labels.gateway.title;
      let originals=receipt.querySelector('.exam-original-receipts');
      if(!originals){originals=document.createElement('div');originals.className='exam-original-receipts';receipt.append(originals);}
      const scope=KinExamScope.read(s);
      const gapLine = $("#receipt-gap");
      if (gapLine) {
        const gap = studyReceiptGap(s);
        gapLine.hidden = !gap; kinWrite(gapLine, gap?.text ?? ""); gapLine.title = gap?.title ?? "";
      }
      const receiptScope=scope?.groupId?KinExamScope.stamp(s):'';
      if(originals.dataset.scope!==receiptScope){
        for(const control of originals.querySelectorAll('button'))control.dataset.request='';
        originals.replaceChildren();originals.dataset.scope=receiptScope;
      }
      originals.hidden=!scope?.groupId;
      if(scope?.groupId){
        kinWrite($("#receipt-observation"), kinSay('Original exams'));
        kinWrite($("#receipt-observation"), kinSay('보유 수와 도착 변화는 원본 검사별 관측입니다.'), "title");
        $("#receipt-gateway").textContent='';$("#receipt-gateway").title='';
        $("#receipt-retry").hidden=true;$("#receipt-retry-note").textContent='';
        const kept=new Map([...originals.children].map(line=>[line.dataset.uid,line]));
        const lines=KinExamScope.metadata(s).map(source=>{
          const own=KinStudyArrivals.receiptLabels({assignment:'assigned',observation:KinStudyArrivals.studyObservation(studyObservationModel,source.uid),gateway:source.gatewayReceipt??null});
          let line=kept.get(source.uid);kept.delete(source.uid);
          if(!line){
            line=document.createElement('div');line.dataset.uid=source.uid;
            const control=document.createElement('button');control.type='button';control.className='chip';
            control.textContent=KinStudyArrivals.RETRY_TEXT.button;control.addEventListener('click',requestGatewayRetry);
            line.append(document.createElement('span'),' ',control,' ',document.createElement('span'));
          }
          const [text,control,note]=line.children;
          // The Accession No is data; each label after it is its own text so the screen language reads it.
          const accession=document.createElement('span');accession.translate=false;accession.textContent=source.acc||source.uid;
          // This original's own missing-images answer (Technician tab), the one the exam's line counts.
          const gap=KinStudyArrivals.originalGap(studyObservationModel,source.uid),short=gap?.missing&&mode==='Technician'?gap:null;
          const gapWords=short?kinWrite(document.createElement('span'),short.text):null;
          if(gapWords){gapWords.className='receipt-gap-line';gapWords.title=short.title;}
          text.replaceChildren(accession,...[own.observation.text,own.change?.text,
            source.gatewayReceipt===undefined?kinSay('Gateway 영수증 정보가 이 목록에 제공되지 않았습니다.'):own.gateway.text].filter(Boolean)
            .flatMap(words=>[' · ',kinWrite(document.createElement('span'),words)]),...(gapWords?[' · ',gapWords]:[]));
          drawRetry(source,own.retry,control,note);return line;
        });
        for(const line of kept.values())line.querySelector('button').dataset.request='';
        if(lines.length!==originals.children.length||lines.some((line,i)=>line!==originals.children[i]))originals.replaceChildren(...lines);
      }
    }

    /**
     * S4-U4 Now Retry: one POST with an empty body and nothing shown before the answer. The answer is written
     * only while the same study and receipt are still drawn with this request's token (renderObservation drops
     * it when either changes). `Retry Requested` means the request is stored at KIN, never that a retry ran.
     * S4-F01V: the clicked control is the one bound (the panel or a Not Observed item), and its note is the element
     * right after it; a call without an event is the panel.
     */
    async function requestGatewayRetry(event) {
      const button = event?.currentTarget ?? $("#receipt-retry"), uid = button.dataset.uid, key = button.dataset.key;
      if (!uid || !key || button.hidden || button.dataset.request) return;
      const token = String(++gatewayRetryRequestSeq);
      button.dataset.request = token; button.disabled = true;
      let answer = null, error = null;
      const at = work.capture("document");
      try { answer = await api("POST", `/studies/${encodeURIComponent(uid)}/gateway-retry`, {}, undefined, at); }
      catch (e) { error = e ?? new Error("request failed"); }
      work.commit(at, () => {
        if (button.dataset.request !== token || button.dataset.uid !== uid || button.dataset.key !== key) return;
        const shown = KinStudyArrivals.gatewayRetryAnswer(uid, answer, error);
        Object.assign(button.dataset, { request: "", requested: shown.requested ? "1" : "" });
        const note = button.nextElementSibling;
        note.textContent = shown.text; note.title = shown.title;
        renderObservation();
      });
    }
    $("#receipt-retry").addEventListener("click", requestGatewayRetry);

    /**
     * S4-U2 오더 측 대사 표시 — **엔지니어링 전용**. 입력은 서버가 목록을 완성한 관측과 함께 준 답뿐이다.
     * 브라우저의 `orders`(오프라인이면 localStorage 시드다)는 이 면에 들어오지 않는다. 관측 실패는
     * 마지막 답을 지우지 않고 `관측 불가`만 더한다. 환자 칸·예정 시각은 그리지 않는다.
     */
    function applyOrderReconciliation(result) {
      if (!orderReconciliationModel) return;
      orderReconciliationModel = result ? KinOrderReconciliation.succeeded(orderReconciliationModel, result)
        : KinOrderReconciliation.failed(orderReconciliationModel);
      renderOrderReconciliation();
    }
    function renderOrderReconciliation() {
      const box = $("#order-reconciliation");
      if (!box || !orderReconciliationModel) return;
      const summary = KinOrderReconciliation.summary(orderReconciliationModel);
      box.hidden = summary.hidden;
      $("#order-reconciliation-summary").textContent = summary.text;
      kinWrite($("#order-reconciliation-summary"), summary.title || "", "title");
      $("#order-reconciliation-list").replaceChildren(...summary.rows.map(row => {
        const item = document.createElement("div");
        item.textContent = row.text; kinWrite(item, row.title || "", "title");
        return item;
      }));
    }

    /**
     * S4-U5 DICOM Identity panel — read-only, engineering only. The tags are the ones the server read for the list row
     * (never the row object, which carries the display overlay); the relations are the server's, shown only while this
     * screen's own row state still names the same linked order. A failed observation keeps the last answer and says so.
     */
    function applyStudyIdentity(result) {
      if (!studyIdentityModel) return;
      studyIdentityModel = result ? KinStudyIdentity.succeeded(studyIdentityModel, result)
        : KinStudyIdentity.failed(studyIdentityModel);
      renderStudyIdentity();
    }
    // A correction answer (Match, Unmatch, Modify Exam) for the panel's next-action line. Memory only.
    function noteIdentityCorrection(uid, ok) {
      if (studyIdentityModel) studyIdentityModel = KinStudyIdentity.correction(studyIdentityModel, uid, ok);
      renderStudyIdentity();
    }
