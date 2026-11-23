

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
      // The block names its study (data-viewed): the lines under it are drawn for that same study (viewedInfoFollowsList).
      $("#clinical").innerHTML = s ? `
        <div class="clinical-scope" data-viewed="${esc(s.uid)}"></div>
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
        </table>` : "";
      if (!s) kinWrite($("#clinical"), kinSay("No clinical information provided."));
      if (s) kinWrite($("#clinical .clinical-scope"), s.uid === selectedUid ? kinSay("판독 대상 검사 정보") : kinSay("관련 검사 정보 · 판독 대상은 바뀌지 않습니다"));
      renderStudyIdentity();
      renderQcInfo();
      renderAcquisition();
      renderObservation();
    }

    /**
     * The Info panel after a list answer (the poll's rebuild, a list read's application). The block that names the study
     * and the two blocks under it are always of the same viewed() study: when another study is viewed now than the one the
     * block names - a Related study left the list or came back to it, the selected study left it - the whole panel is drawn
     * again (true), so the study named, the QC line and Protocol & Dose are of one study. A move to another study draws
     * the whole panel itself and does not come here.
     */
    function viewedInfoFollowsList() {
      const s = viewed(), named = $("#clinical .clinical-scope")?.dataset.viewed ?? "";
      if (named === (s?.uid ?? "")) return false;
      renderClinical();
      return true;
    }

    /**
     * QC Flag line (every tab; render() repaints it after each poll): the viewed study's mark as this page may show it now
     * (shownQc: the row the server last listed, while it can be read). The reason and who are data and are never translated.
     * It is its own line: SS, RS, the order match and the missing-images line are drawn apart and are not changed by it.
     */
    function renderQcInfo() {
      const box = $("#study-qc");
      if (!box) return;
      const s = viewed();
      box.hidden = !s;
      if (!s) { box.replaceChildren(); return; }
      const mark = shownQc(s.uid), parts = [kinWrite(document.createElement("span"), kinSay("QC Flag")), ": "];
      const word = kinWrite(document.createElement("strong"), kinSay(!mark ? "Unknown" : mark.reason === null ? "None" : "Flagged"));
      word.className = "qc-word";
      parts.push(word);
      if (mark?.reason) {
        const data = text => Object.assign(document.createElement("span"), { translate: false, textContent: text });
        const reason = data(mark.reason); reason.className = "qc-info-reason";
        parts.push(" — ", reason);
        const who = [mark.byName ?? "", mark.at ? localStamp(mark.at) : ""].filter(Boolean).join(" · ");
        if (who) parts.push(" (", data(who), ")");
      }
      box.dataset.qc = !mark ? "Unknown" : mark.reason === null ? "None" : "Flagged";
      box.replaceChildren(...parts);
    }

    /**
     * Protocol and dose (Technician tab only): what the viewed exam's own DICOM records, read in this tab for the originals
     * and series of its scope (KinExamScope) and judged by KinAcquisition. Its rules:
     *   - a value, an absence and a failed read each keep where they were read: the original study, the series, the object
     *     (SOP Instance UID) and, in an enhanced object, the frame's own number. An object is named by its Instance Number only
     *     when no other object of its series has that number, a series by its number only when no other series of that
     *     original has it; otherwise the UID is shown. A value that is not a plain number is "Could not read", never converted.
     *   - "Not in DICOM" is said only of what was read whole: every original of the scope, as many series as the list row
     *     counts, every series a split part names, as many objects and frames as the archive and the object say there are,
     *     and a dose report searched to its end. Anything less is said as not read. A tag whose value is kept elsewhere or
     *     cannot be read as a value is "Could not read", never absent.
     *   - an original that refuses a read (401/403) or is not found is out of reach from that moment: nothing read from it
     *     is shown or kept, whichever read learned it.
     * The block is drawn only for a study that is a readable row of the list the server last sent (the same judge as the
     * QC mark: qcScope). Answers are kept per exam scope in this tab's memory only, while the list has that row unchanged.
     */
    const KinAcquisition = (() => {
      const MAX_SERIES = 40, SERIES_LIMIT = 501, RDSR = "1.2.840.10008.5.1.4.1.1.88.67", MAX_VALUES = 4, MAX_EVENTS = 20,
        MAX_DEPTH = 32, MAX_PLACES = 4, MAX_RUNS = 8, MAX_TITLE_PLACES = 60;
      const SERIES_FIELDS = "0020000D,0020000E,00200011,0008103E,00080060,00201209";
      // Enhanced X-Ray Radiation Dose SR: a dose report in another form, which this reader does not read. It is said as a
      // dose report that could not be read, so the exam is never said to have none.
      const OTHER_RDSR = "1.2.840.10008.5.1.4.1.1.88.76";
      // Enhanced CT and Legacy Converted Enhanced CT: objects whose frames are described by functional groups.
      const FRAMED = ["1.2.840.10008.5.1.4.1.1.2.1", "1.2.840.10008.5.1.4.1.1.2.2"];
      const BAD = Symbol("unreadable");
      const isItem = v => !!v && typeof v === "object" && !Array.isArray(v);
      // An attribute whose value is not in this answer (kept elsewhere) or is not a list of values.
      const elsewhere = a => a.BulkDataURI !== undefined || a.InlineBinary !== undefined;
      /**
       * The one value of an attribute as DICOM JSON carries it. undefined: the tag is not there, or is there with no value.
       * BAD: it is there but its value cannot be read here - not an attribute object, a value kept elsewhere (BulkDataURI,
       * InlineBinary), a Value that is not a list, or more values than the one it may have.
       */
      function one(ds, tag) {
        const a = ds?.[tag];
        if (a === undefined) return undefined;
        if (!isItem(a) || elsewhere(a)) return BAD;
        if (a.Value === undefined) return undefined;
        if (!Array.isArray(a.Value) || a.Value.length > 1) return BAD;
        return a.Value.length ? a.Value[0] : undefined;
      }
      const text = (ds, tag) => { const v = one(ds, tag); return typeof v === "string" ? v.trim() : typeof v === "number" ? String(v) : ""; };
      // A sequence's items in their stored places: one that is not an item stays (as null), so the ones after it keep their numbers.
      const entries = (ds, tag) => Array.isArray(ds?.[tag]?.Value) ? ds[tag].Value.map(v => isItem(v) ? v : null) : [];
      // A sequence tag that is there but cannot be read as a list of items.
      const broken = (ds, tag) => ds?.[tag] !== undefined && (!isItem(ds[tag]) || elsewhere(ds[tag]) || ds[tag].Value !== undefined && !Array.isArray(ds[tag].Value));
      // A number as DICOM JSON carries it: a JSON number, or a decimal string (DS, IS). "0x10", "1e" or "" is not a number.
      const DECIMAL = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;
      const number = raw => { const n = typeof raw === "number" ? raw : typeof raw === "string" && DECIMAL.test(raw.trim()) ? Number(raw.trim()) : NaN; return Number.isFinite(n) ? n : null; };
      const count = raw => { const n = number(raw); return Number.isSafeInteger(n) && n >= 0 ? n : null; };
      /**
       * Where each recorded value, each absence and each failed read was found: `{ sop, frames }` - the object's SOP Instance
       * UID and, for frames of an enhanced object, their own numbers in it ([first, last]). The original study and the
       * series are the series entry's. Values are never added up.
       */
      function places() {
        const values = new Map(), absent = [], unreadable = [];
        return { absent, unreadable,
          add(value, place) { if (!values.has(value)) values.set(value, []); values.get(value).push(place); },
          miss(place) { absent.push(place); }, bad(place) { unreadable.push(place); },
          list() { return [...values].map(([value, where]) => ({ value, where })); } };
      }
      const spans = pairs => { const out = [];
        for (const [a, b] of [...pairs].sort((x, y) => x[0] - y[0] || x[1] - y[1])) {
          const last = out[out.length - 1]; if (last && a <= last[1] + 1) last[1] = Math.max(last[1], b); else out.push([a, b]); }
        return out; };
      const runs = (pairs, limit) => { const all = spans(pairs);
        return all.slice(0, limit).map(([a, b]) => a === b ? String(a) : a + "–" + b).join(", ") + (all.length > limit ? ", …" : ""); };
      const single = pairs => { const all = spans(pairs); return all.length === 1 && all[0][0] === all[0][1]; };
      /**
       * The places as words: "images 1–3, 7", "image 5: frames 1–2", "SOP 1.2.3". An object is named by its Instance Number
       * only when it alone in its series has that number (numberOf answers null otherwise) - else by its SOP Instance UID,
       * so two objects never share a name. `full` (the line's title) names every object by its SOP Instance UID.
       */
      function where(list, numberOf, full = false) {
        const numbered = [], named = new Set(), framed = new Map();
        for (const p of list) {
          const n = numberOf(p.sop);
          const name = full ? "SOP " + p.sop + (n === null ? "" : " (image " + n + ")") : n === null ? "SOP " + p.sop : null;
          if (p.frames) { const key = name ?? "image " + n; if (!framed.has(key)) framed.set(key, []); framed.get(key).push(p.frames); }
          else if (name) named.add(name); else numbered.push([n, n]);
        }
        const limit = full ? Infinity : MAX_RUNS, parts = [];
        if (numbered.length) parts.push((single(numbered) ? "image " : "images ") + runs(numbered, limit));
        parts.push(...named);
        for (const [key, frames] of framed) parts.push(key + ": " + (single(frames) ? "frame " : "frames ") + runs(frames, limit));
        const shown = parts.slice(0, full ? MAX_TITLE_PLACES : MAX_PLACES);
        return shown.join("; ") + (parts.length > shown.length ? "; … +" + (parts.length - shown.length) : "");
      }
      /**
       * The CTDIvol answers one holder of a CT Exposure Sequence (0018,9321) gives - a frame's group or the shared group:
       * undefined when it has no such sequence (the next holder is asked), else one answer per item of it: the stored value,
       * undefined (the item has none), or BAD (the sequence or the item cannot be read).
       */
      function exposures(holder) {
        if (holder?.["00189321"] === undefined) return undefined;
        if (broken(holder, "00189321")) return [BAD];
        const list = entries(holder, "00189321");
        return list.length ? list.map(item => item === null ? BAD : one(item, "00189345")) : undefined;
      }
      // CTDIvol (0018,9345) is recorded in mGy (PS3.3 CT Exposure Macro). A value that is not a plain number is unreadable.
      function ctdiInto(answers, into, place) {
        for (const raw of answers) {
          if (raw === undefined) into.miss(place);
          else { const n = raw === BAD ? null : number(raw); if (n === null) into.bad(place); else into.add(String(n), place); }
        }
      }
      /**
       * One series, every object the archive returned for it. Each must name this original, this series, a SOP Instance UID
       * no other object of the answer has, and its SOP Class - or the series is not read (never "absent"). Protocol Name per
       * object; CTDIvol per object, or per frame of an object with functional groups (an enhanced CT; any object carrying
       * the shared or per-frame groups). Such an object says how many frames it has (0028,0008) and describes each: only
       * those frames exist, each at its own number. A frame it counts and does not describe, or whose item cannot be read,
       * is unreadable at that number; an item past the count belongs to no frame and gives no value; an object that does
       * not say how many frames it has gives none. `cut` says an object was not described as it counts itself.
       */
      function judgeSeries(objects, expected) {
        const protocol = places(), ctdi = places(), numbers = new Map(), seen = new Map();
        let cut = false;
        for (const ds of objects) {
          const sop = isItem(ds) ? text(ds, "00080018") : "";
          if (!sop || seen.has(sop) || text(ds, "0020000D") !== expected.study || text(ds, "0020000E") !== expected.series || !text(ds, "00080016"))
            throw new Error("identity");
          const n = number(one(ds, "00200013")), image = Number.isSafeInteger(n) ? n : null;
          seen.set(sop, image);
          if (image !== null) numbers.set(image, (numbers.get(image) ?? 0) + 1);
          const name = one(ds, "00181030");
          if (name === BAD || name !== undefined && typeof name !== "string" && typeof name !== "number") protocol.bad({ sop });
          else if (String(name ?? "").trim()) protocol.add(String(name).trim(), { sop });
          else protocol.miss({ sop });
          const whole = [one(ds, "00189345")];
          if (ds["52009229"] === undefined && ds["52009230"] === undefined && !FRAMED.includes(text(ds, "00080016"))) {
            ctdiInto(whole, ctdi, { sop });
            continue;
          }
          const shared = broken(ds, "52009229") || entries(ds, "52009229")[0] === null ? [BAD] : exposures(entries(ds, "52009229")[0]);
          const frames = entries(ds, "52009230"), declared = count(one(ds, "00280008"));
          if (broken(ds, "52009230") || declared === null || declared < 1) { cut = true; ctdi.bad({ sop }); continue; }
          if (frames.length !== declared) cut = true;
          for (let f = 1; f <= Math.min(declared, frames.length); f++)
            ctdiInto(frames[f - 1] === null ? [BAD] : exposures(frames[f - 1]) ?? shared ?? whole, ctdi, { sop, frames: [f, f] });
          if (declared > frames.length) ctdi.bad({ sop, frames: [frames.length + 1, declared] });
        }
        // An object's Instance Number names it only when no other object of this series has the same number.
        const numberOf = sop => { const image = seen.get(sop); return image !== null && image !== undefined && numbers.get(image) === 1 ? image : null; };
        return { protocol, ctdi, numberOf, cut };
      }
      // Dose SR content items are judged on their DCM concept code, their value type and their UCUM unit together.
      // The concept code of an item: "" when it has none of DCM, null when its concept cannot be read.
      const concept = item => { if (broken(item, "0040A043")) return null; const c = entries(item, "0040A043")[0];
        if (c === null || one(c, "00080100") === BAD || one(c, "00080102") === BAD) return null;
        return text(c, "00080102") === "DCM" ? text(c, "00080100") : ""; };
      const typed = (item, type) => text(item, "0040A040") === type;
      function measured(item, unit) {
        const m = entries(item, "0040A300")[0], u = entries(m, "004008EA")[0], n = number(one(m, "0040A30A"));
        return n !== null && text(u, "00080102") === "UCUM" && text(u, "00080100") === unit ? { value: String(n), unit } : { unreadable: true };
      }
      /**
       * Every content item under `node` with this concept and value type. `cut` says the search did not reach everything:
       * an item that cannot be read (it may be the one looked for) or content below the depth this reader follows.
       */
      function find(node, code, type, out = { items: [], cut: false }, depth = 0) {
        if (broken(node, "0040A730")) out.cut = true;
        for (const item of entries(node, "0040A730")) {
          const named = item === null ? null : concept(item);
          if (named === null || one(item, "0040A040") === BAD) { out.cut = true; if (item === null) continue; }
          if (named === code && typed(item, type)) out.items.push(item);
          if (depth >= MAX_DEPTH) { if (item["0040A730"] !== undefined) out.cut = true; continue; }
          find(item, code, type, out, depth + 1);
        }
        return out;
      }
      /**
       * An X-Ray Radiation Dose SR: each DLP total it records (TID 10012 CT Accumulated Dose Data 113811 → 113813, mGy.cm),
       * as that report's own; only when it has none, each irradiation event's Mean CTDIvol (113830, mGy) and DLP
       * (113838, mGy.cm) (TID 10013, CT Acquisition 113819). Nothing is added up across reports or events. `cut` (of the
       * report or of one event's value) says the search stopped short, so nothing unseen is called absent.
       */
      function doseReport(ds) {
        const containers = find(ds, "113811", "CONTAINER"), acquisitions = find(ds, "113819", "CONTAINER");
        let cut = containers.cut || acquisitions.cut;
        const totals = containers.items.flatMap(c => { const found = find(c, "113813", "NUM"); cut ||= found.cut; return found.items; })
          .map(item => measured(item, "mGy.cm"));
        const one = (event, code, unit) => { const found = find(event, code, "NUM");
          return found.items.length ? measured(found.items[0], unit) : found.cut ? { unreadable: true } : null; };
        const events = acquisitions.items.map(event => ({ ctdi: one(event, "113830", "mGy"), dlp: one(event, "113838", "mGy.cm") }));
        return { totals, events: totals.length ? [] : events, cut };
      }
      const refusal = e => [401, 403].includes(e?.status);
      const outOfReach = entry => ["refused", "gone"].includes(entry.state);
      /**
       * The one reading of an exam. Per original: its series list (read / failed / cut at the list limit / unidentified /
       * refused / gone) and the series the scope names that the list did not have (`missing`). Per series of the scope: its
       * objects (read whole, read in part, failed, or not read past the limit). And the dose reports found. `listed` is the
       * number of series of the scope the archive listed and `expected` the number the list row counts, `objects` the
       * number of objects read and `images` the number the list row counts (null: the row does not say).
       * `complete` says every part of the scope was read whole; only then may the study be said to have no dose
       * report. `live()` false ends the read early (its answer is not used). `unreachable(studyUid)` is told at once of an
       * original that refuses a read or is not found - whatever becomes of this read.
       */
      async function read(row, request, live = () => true, unreachable = () => {}) {
        const scope = KinExamScope.read(row);
        if (!scope) return { state: "unavailable" };
        const sources = [], all = [];
        const counted = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
        const expected = counted(row?.series), images = counted(row?.count);
        for (const source of scope.sources) {
          const entry = { studyUid: source.studyUid, state: "read", missing: [] };
          sources.push(entry);
          let listed;
          try { listed = await request("/dicom-web/studies/" + encodeURIComponent(source.studyUid) + "/series?includefield=" + SERIES_FIELDS + "&limit=" + SERIES_LIMIT); }
          catch (e) {
            entry.state = refusal(e) ? "refused" : [404, 410].includes(e?.status) ? "gone" : "failed";
            if (outOfReach(entry)) unreachable(source.studyUid);
            if (!live()) return { state: "stale" };
            continue;
          }
          if (!live()) return { state: "stale" };
          const own = listed.filter(ds => isItem(ds) && text(ds, "0020000D") === source.studyUid && text(ds, "0020000E"));
          const uids = own.map(ds => text(ds, "0020000E"));
          if (listed.length >= SERIES_LIMIT) entry.state = "cut";
          else if (own.length !== listed.length || new Set(uids).size !== uids.length) entry.state = "unidentified";
          // A split part names its series: one the list does not have was not read, whatever the others say.
          if (source.series.mode === "include") entry.missing = [...new Set(source.series.uids)].filter(uid => !uids.includes(uid));
          for (const ds of own) {
            const seriesUid = text(ds, "0020000E");
            if (KinExamScope.allows(source, seriesUid)) all.push({ sourceUid: source.studyUid, seriesUid, modality: text(ds, "00080060"),
              number: text(ds, "00200011"), description: text(ds, "0008103E"), known: count(one(ds, "00201209")) });
          }
        }
        all.sort((a, b) => a.sourceUid.localeCompare(b.sourceUid) || (Number(a.number) || 0) - (Number(b.number) || 0) || a.seriesUid.localeCompare(b.seriesUid));
        const chosen = all.slice(0, MAX_SERIES), series = [], reports = [];
        for (const s of chosen) {
          const source = sources.find(x => x.studyUid === s.sourceUid);
          if (outOfReach(source)) continue;
          try {
            const objects = await request("/dicom-web/studies/" + encodeURIComponent(s.sourceUid) + "/series/" + encodeURIComponent(s.seriesUid) + "/metadata");
            if (!live()) return { state: "stale" };
            if (!objects.length) throw new Error("empty");
            const judged = judgeSeries(objects, { study: s.sourceUid, series: s.seriesUid });
            const found = objects.filter(ds => [RDSR, OTHER_RDSR].includes(text(ds, "00080016"))).map(ds => (
              { sourceUid: s.sourceUid, seriesUid: s.seriesUid, number: s.number, sop: text(ds, "00080018"),
                ...(text(ds, "00080016") === RDSR ? doseReport(ds) : { totals: [], events: [], cut: true }) }));
            // Whole: as many objects as the archive's series list says, each describing as many frames as it counts.
            series.push({ ...s, state: "read", objects: objects.length, whole: s.known === objects.length && !judged.cut, ...judged });
            reports.push(...found);
          } catch (e) {
            // A refusal is said even by a read no longer waited for; the rest of its answer is not used.
            if (refusal(e)) { source.state = "refused"; unreachable(s.sourceUid); }
            if (!live()) return { state: "stale" };
            if (!refusal(e)) series.push({ ...s, state: "failed" });
          }
        }
        // An original that refused a read - its series list or any series - or is not found is out of reach now: what was
        // read from it before goes with it.
        const refused = sources.filter(outOfReach).map(x => x.studyUid), reached = x => !refused.includes(x.sourceUid);
        const kept = series.filter(reached), skipped = all.length - chosen.length;
        const objects = kept.reduce((sum, x) => sum + (x.objects ?? 0), 0);
        return { state: "done", sources, series: kept, reports: reports.filter(reached), skipped, refused, listed: all.length, expected,
          objects, images, partial: scope.sources.some(source => source.series.mode !== "all"),
          // Whole: every original's list read, as many series and objects as the list row counts, each series read whole,
          // none past the limit.
          complete: sources.every(x => x.state === "read" && !x.missing.length) && expected === all.length && images === objects
            && kept.every(x => x.state === "read" && x.whole) && !skipped };
      }
      // The original study and the series of a line, for its title.
      const origin = s => [{ say: "Study {0}", args: [s.sourceUid] }, { say: "Series {0}", args: [s.seriesUid] }];
      /**
       * One fact of a series: each recorded value with where it was read; where it is missing or unreadable, said apart.
       * A series read whole, with one value everywhere, shows the value alone. The line's title names every place in full.
       */
      function factLine(kind, label, t, unit, s) {
        const list = t.list(), placed = list.length > 1 || t.absent.length > 0 && list.length > 0 || t.unreadable.length > 0 || !s.whole;
        const at = (places, full) => [{ t: where(places, s.numberOf, full) }], segments = [];
        if (list.length) segments.push([...list.slice(0, MAX_VALUES).flatMap((v, i) => [...(i ? [{ say: ", " }] : []), { data: v.value + (unit ? " " + unit : "") },
          ...(placed ? [{ say: " ({t0})", args: at(v.where, false) }] : [])]),
          ...(list.length > MAX_VALUES ? [{ say: " … +{n0}", args: [list.length - MAX_VALUES] }] : [])]);
        if (t.absent.length) segments.push([placed ? { say: "Not in DICOM ({t0})", args: at(t.absent, false) } : { say: "Not in DICOM" }]);
        if (t.unreadable.length) segments.push([{ say: "Could not read ({t0})", args: at(t.unreadable, false) }]);
        const full = [...list.map(v => ({ say: "{0}: {t1}", args: [v.value + (unit ? " " + unit : ""), ...at(v.where, true)] })),
          ...(t.absent.length ? [{ say: "Not in DICOM: {t0}", args: at(t.absent, true) }] : []),
          ...(t.unreadable.length ? [{ say: "Could not read: {t0}", args: at(t.unreadable, true) }] : [])];
        return { kind, title: [...origin(s), ...full],
          parts: [{ say: label }, { say: ": " }, ...segments.flatMap((segment, i) => [...(i ? [{ say: " · " }] : []), ...segment])] };
      }
      function lines(result) {
        if (result.state === "reading") return [{ kind: "status", parts: [{ say: "Protocol & Dose: reading DICOM…" }] }];
        if (result.state === "unavailable") return [{ kind: "status", parts: [{ say: "Protocol & Dose: Could not read (the exam's originals cannot all be read)" }] }];
        if (result.state !== "done") return [{ kind: "status", parts: [{ say: "Protocol & Dose: Could not read" }] }];
        const many = result.sources.length > 1, out = [{ kind: "head", parts: [{ say: "Protocol & Dose (recorded in DICOM)" }] }];
        const from = uid => many ? [{ data: uid }, { say: " · " }] : [];
        for (const source of result.sources) {
          if (source.state !== "read") out.push({ kind: "status", parts: [...from(source.studyUid),
            { say: source.state === "cut" ? "Series list cut at {n0}: some series not read"
              : source.state === "refused" ? "This original cannot be read now (access refused)"
              : source.state === "gone" ? "This original cannot be read now (not found)" : "Series list could not be read", args: [SERIES_LIMIT] }] });
          if (!["refused", "gone"].includes(source.state) && source.missing.length) out.push({ kind: "status", parts: [...from(source.studyUid),
            { say: "{n0} series of this exam not in the series list (not read):", args: [source.missing.length] }, { say: " " },
            { data: source.missing.slice(0, 3).join(", ") + (source.missing.length > 3 ? ", …" : "") }] });
        }
        // The archive listed another number of series than the list row counts for the exam (or the row does not say how
        // many): said, and the exam is not called without a dose report.
        if (result.sources.every(source => source.state === "read") && result.expected !== result.listed)
          out.push({ kind: "status", parts: [result.expected === null
            ? { say: "Series found: {n0} (the list does not say how many the exam has)", args: [result.listed] }
            : { say: "Series found: {n0} of the {n1} the list counts", args: [result.listed, result.expected] }] });
        // The same for the exam's objects, once every listed series was read: the list row counts another number of them.
        else if (result.sources.every(source => source.state === "read") && !result.skipped
            && result.series.every(s => s.state === "read") && result.images !== result.objects)
          out.push({ kind: "status", parts: [result.images === null
            ? { say: "Objects read: {n0} (the list does not say how many the exam has)", args: [result.objects] }
            : { say: "Objects read: {n0} of the {n1} the list counts", args: [result.objects, result.images] }] });
        if (!result.series.length && result.sources.every(source => source.state === "read" && !source.missing.length))
          out.push({ kind: "status", parts: [{ say: "No series found" }] });
        // A series is named by its number only when no other series of that original has the same one; else its UID follows.
        const sameName = s => result.series.filter(x => x.sourceUid === s.sourceUid && x.number === s.number).length > 1;
        for (const s of result.series) {
          const name = [s.number ? "Se " + s.number : "", s.modality, s.description].filter(Boolean).join(" · ");
          const head = { kind: "series", title: origin(s),
            parts: [...from(s.sourceUid), { data: !s.number || sameName(s) ? [name, s.seriesUid].filter(Boolean).join(" · ") : name }] };
          if (s.state !== "read") { head.parts.push({ say: " — Could not read" }); out.push(head); continue; }
          out.push(head);
          // Not as many objects as the archive lists for the series (or it does not say how many): said, and nothing below
          // is called absent without its place.
          if (s.known !== s.objects) out.push({ kind: "status", parts: [s.known === null
            ? { say: "Objects read: {n0} (the archive did not say how many there are)", args: [s.objects] }
            : { say: "Objects read: {n0} of {n1}", args: [s.objects, s.known] }] });
          out.push(factLine("protocol", "Protocol (0018,1030)", s.protocol, "", s), factLine("ctdi", "CTDIvol (0018,9345)", s.ctdi, "mGy", s));
        }
        // DLP comes only from an X-Ray Radiation Dose SR: each report on its own line (its series and SOP Instance UID), as that
        // report records it, never added up and never computed for a split part.
        if (!result.reports.length) out.push({ kind: "dlp", parts: [{ say: "DLP (Dose SR)" }, { say: ": " },
          { say: result.complete ? "Not in DICOM" : "Not found in the series read" }] });
        for (const r of result.reports) {
          const head = [{ say: "DLP (Dose SR{t0})", args: [{ t: r.number ? " Se " + r.number : "" }] }, { say: " " },
            { data: (many ? r.sourceUid + " · " : "") + r.sop }, ...(result.partial ? [{ say: " — not computed for this part" }] : []), { say: ": " }];
          const title = [...origin(r), { say: "SOP {0}", args: [r.sop] }];
          // What the search did not find is absent only when the search reached the end of the report.
          const none = { say: r.cut ? "Could not read" : "Not in DICOM" };
          const shown = v => v && !v.unreadable ? { data: v.value + " " + v.unit } : v ? { say: "Could not read" } : none;
          if (r.totals.length) for (const total of r.totals) out.push({ kind: "dlp", title, parts: [...head, shown(total),
            { say: " (total recorded in this Dose SR, 113813)" }] });
          else if (!r.events.length) out.push({ kind: "dlp", title, parts: [...head, none] });
          else {
            r.events.slice(0, MAX_EVENTS).forEach((event, i) => out.push({ kind: "dlp-event", title, parts: [...head,
              { say: "Event {n0}: ", args: [i + 1] }, { say: "CTDIvol " }, shown(event.ctdi), { say: " · DLP " }, shown(event.dlp)] }));
            if (r.events.length > MAX_EVENTS) out.push({ kind: "status", parts: [{ say: "{n0} more events not shown", args: [r.events.length - MAX_EVENTS] }] });
          }
        }
        if (result.skipped) out.push({ kind: "status", parts: [{ say: "{n0} more series not read (limit {n1})", args: [result.skipped, MAX_SERIES] }] });
        return out;
      }
      return { read, lines, judgeSeries, doseReport };
    })();
    // key -> { uid, sources, result }: a whole answer, the list row it was read for and the originals it read.
    const acquisitionCache = new Map();
    let acquisitionSeq = 0;
    /** Refresh (a list read the person asked for) or a session change: read the DICOM again next time. */
    function forgetAcquisition() {
      acquisitionCache.clear(); acquisitionSeq++;
      const box = $("#study-acquisition"); if (box) box.dataset.key = "";
    }
    /**
     * What one answer is of: a study that is a readable row of the list the server last sent (qcScope - a row the list no
     * longer has, one that cannot be read now, and one a command was answered 404 for have none), read one way, with its
     * exam scope and the counts the list row says. null: nothing of this study's DICOM may be drawn now.
     */
    function acquisitionKey(s) {
      if (!s || s.examUnavailable || qcScope(s.uid) === null) return null;
      let scope = null;
      try { scope = KinExamScope.read(s); } catch (_) { scope = null; }
      return scope ? s.uid + "|" + qcScope(s.uid) + "|" + KinExamScope.screenStamp(s) + "|" + (s.count ?? "") + "|" + (s.series ?? "") : null;
    }
    /**
     * Kept answers follow the list the server last sent: an answer stays only while its row is listed with the scope, counts
     * and series it was read for. A row that left the list, changed, or cannot be read now (a merged exam one of whose
     * originals is out of reach) loses its answer, so it is read again when it comes back.
     */
    function acquisitionFollowsList() {
      for (const [key, kept] of acquisitionCache)
        if (acquisitionKey(studies.find(s => s.uid === kept.uid)) !== key) acquisitionCache.delete(key);
    }
    function renderAcquisition() {
      const box = $("#study-acquisition");
      if (!box) return;
      acquisitionFollowsList();
      const s = viewed(), show = !!s && mode === "Technician" && serverMode && !demoMode;
      box.hidden = !show;
      // A read belongs to the key the block showed when it began: whenever the block shows another key (another exam, a
      // changed or unreadable scope, a hidden block), reads still on the way are no longer used (readAcquisition).
      const showKey = key => { if ((box.dataset.key ?? "") !== key) { box.dataset.key = key; acquisitionSeq++; } };
      if (!show) { box.replaceChildren(); acquisitionDrawn = []; showKey(""); return; }
      const key = acquisitionKey(s);
      if (!key) { showKey(""); drawAcquisition(box, { state: s.examUnavailable ? "unavailable" : "failed" }); return; }
      // Drawn (or being read) for this key already: nothing to do. Refresh and a session change clear the key (forgetAcquisition).
      if (box.dataset.key === key) return;
      showKey(key);
      const known = acquisitionCache.get(key);
      if (known) { drawAcquisition(box, known.result); return; }
      drawAcquisition(box, { state: "reading" });
      if (offline) return;
      readAcquisition(s, key);
    }
    // The originals the drawn answer read (drawAcquisition): what is drawn goes when one of them is out of reach.
    let acquisitionDrawn = [];
    function drawAcquisition(box, result) {
      acquisitionDrawn = (result.sources ?? []).map(source => source.studyUid);
      box.replaceChildren(...KinAcquisition.lines(result).map(acquisitionLine));
    }
    /** One drawn line: its fixed words through the screen language, its values (tags' contents, series names) as data. */
    function acquisitionLine(line) {
      const row = document.createElement("div");
      row.className = "acq-line"; if (line.kind) row.dataset.kind = line.kind;
      // The full places of what the line says (original study, series, SOP Instance UIDs, frames), one per title line.
      if (line.title) {
        const parts = line.title.map(part => kinSay(part.say, ...(part.args || [])));
        kinWrite(row, kinSay(parts.map((_, i) => "{" + i + "}").join("\n"), ...parts), "title");
      }
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
      // An original that refuses a read or is not found is out of reach from that moment, whether or not this read is
      // still the one the block waits for (a read left behind for another exam of the same original learns it too): every
      // kept answer that read it goes, and an answer drawn from it is read again now.
      const unreachable = uid => work.commit(at, () => {
        for (const [k, kept] of acquisitionCache) if (kept.sources.includes(uid)) acquisitionCache.delete(k);
        const box = $("#study-acquisition");
        if (seq === acquisitionSeq || !box || !acquisitionDrawn.includes(uid)) return;
        box.dataset.key = ""; acquisitionSeq++;
        renderAcquisition();
      });
      let result;
      try { result = await KinAcquisition.read(s, request, () => seq === acquisitionSeq && work.admits(at), unreachable); }
      catch (e) { result = { state: "failed" }; }
      work.commit(at, () => {
        // Judged before anything is kept or drawn: this is still the read the block waits for (no newer read, Refresh,
        // session change, other exam or changed scope since it began) and its exam is the one viewed now with the same key.
        // An answer that fails this is dropped whole - it reaches neither the screen nor the kept answers.
        const box = $("#study-acquisition");
        if (seq !== acquisitionSeq || !box || box.hidden || box.dataset.key !== key || acquisitionKey(viewed()) !== key) return;
        // A whole read is kept for its key (the exam scope, counts and series of the list row it was read for); a read with
        // a failure or a part not read is not kept, so the next viewing reads again.
        if (result.state === "done" && result.complete)
          acquisitionCache.set(key, { uid: s.uid, sources: result.sources.map(source => source.studyUid), result });
        drawAcquisition(box, result);
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
      if (status) { status.hidden = !summary.text; kinWrite(status, summary.text); kinWrite(status, summary.title, "title"); }
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
        kinWrite($("#not-observed-summary"), absent.length
          ? kinSayEn("Not Observed ({n0}){t1}", absent.length, summary.key === "observation_unavailable" ? kinSayEn(" · 마지막 관측 기준") : "") : "");
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
          kinWrite(text, gateway === null ? "" : labels.gateway.title, "title");
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
      kinWrite($("#receipt-assignment"), labels.assignment.text); kinWrite($("#receipt-assignment"), labels.assignment.title, "title");
      const observed = [labels.observation.text, labels.change?.text].filter(Boolean);
      kinWrite($("#receipt-observation"), observed.length > 1 ? kinSay("{t0} · {t1}", { t: observed[0] }, { t: observed[1] }) : observed[0] ?? "");
      kinWrite($("#receipt-observation"), labels.observation.title, "title");
      drawRetry(s, labels.retry, $("#receipt-retry"), $("#receipt-retry-note"));
      kinWrite($("#receipt-gateway"), labels.gateway.text); kinWrite($("#receipt-gateway"), labels.gateway.title, "title");
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
