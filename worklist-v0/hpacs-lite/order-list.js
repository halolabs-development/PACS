

    // ══════════ Order List (8.2.2) ══════════
    const ofval = {};
    $(".order-p .filters").addEventListener("input", e => {
      const el = e.target.closest("[data-o]"); if (!el) return;
      ofval[el.dataset.o] = el.value.trim().toUpperCase();
      renderOrders();
    });

    /**
     * Add-on conditions on the Order List (the Technician order search; feature-mounts.js orders.filter): each is asked
     * with a copy of one order and keeps it when it answers true, together with the panel's own ID / Name / Modality /
     * StudyDesc boxes and ID sync. With none the list is exactly what it was.
     */
    const orderAddOnFilters = new Set();
    function filteredOrders() {
      const s = cur();
      return orders.filter(o => {
        if ($("#o-sync").checked && s && o.id !== s.id) return false;
        if (!Object.entries(ofval).every(([k, v]) => !v || String(o[k] ?? "").toUpperCase().includes(v))) return false;
        for (const keep of orderAddOnFilters) {
          try { if (!keep({ ...o })) return false; } catch (error) { console.error('Order List add-on filter failed', error); }
        }
        return true;
      });
    }

    function renderOrders() {
      // Also run on its own (a page test takes this function out of the page): the plain fill stands in then.
      const kinSay = globalThis.kinSayShared || ((t, ...p) => t.replace(/\{(?:[ten]?(\d+)|([A-Za-z]\w*))\}/g, (m, i, n) => { const v = n !== undefined ? (p[0] || {})[n] : p[i]; return v === undefined ? m : String(v && typeof v === "object" ? (v.t ?? v.e ?? "") : v); }));
      if (mode !== "Technician") return;
      const list = filteredOrders();
      // A redraw keeps the focus on the order row that had it (as the worklist rows do): after a click, a menu item
      // (Match, Unmatch) or a list read again, the keyboard stays on that order.
      const focusedOid = document.activeElement?.closest?.("#orderrows tr[data-oid]")?.dataset.oid ?? null;
      $("#orderrows").innerHTML = list.map((o, i) => `
        <tr data-oid="${esc(o.oid)}" tabindex="-1" class="${o.oid === selectedOid ? "sel" : ""}">
          <td class="num">${i + 1}</td>
          <td><span class="mt ${esc(o.matched)}">${esc(o.matched)}</span></td>
          <td translate="no">${esc(o.id)}</td><td translate="no">${esc(o.name)}</td><td translate="no">${esc(o.sex)}</td><td translate="no">${esc(o.birth)}</td>
          <td translate="no">${esc(o.sched)}</td><td translate="no">${esc(o.modality)}</td><td translate="no">${esc(o.desc)}</td><td translate="no">${esc(o.ward)}</td><td translate="no">${esc(o.reqDoc)}</td>
        </tr>`).join("") || `<tr><td class="empty" colspan="11">오더 없음</td></tr>`;
      const emptyOrders = $("#orderrows td.empty");
      if (emptyOrders) kinWrite(emptyOrders, kinSay("오더 없음"));
      if (focusedOid !== null) $("#orderrows").querySelector(`tr[data-oid="${CSS.escape(focusedOid)}"]`)?.focus({ preventScroll: true });

      const s = cur(), o = curOrder();
      kinWrite($("#orderhint"), kinSay("선택: 검사 {0}  ·  오더 {1}{t2}", s ? s.name + " / " + s.date : kinSay("(없음)"), o ? o.name + " / " + o.sched : kinSay("(없음)"),
          { t: s && o && s.matched === "U" && o.matched === "U" ? kinSay("  → 우클릭 Match 가능") : "" }));
      notifyAddOns("orders", [list.length]);
    }
    $("#orderrows").addEventListener("click", e => {
      const tr = e.target.closest("tr[data-oid]"); if (!tr) return;
      selectedOid = tr.dataset.oid;
      renderOrders();
    });
    $("#o-sync").addEventListener("change", renderOrders);
    /**
     * S4-U5 Order List refresh. The server list is read through the existing guarded bootstrap read (own institution,
     * access-filtered); only the latest answer for this account's institution replaces it, and the selected order stays
     * selected while it is still listed. Without a server this only redraws, as before. Answers true when this read
     * replaced the list (the Technician windows tell a confirmed result from one they could not read back).
     */
    async function refreshOrders() {
      if (!serverMode) { renderOrders(); return true; }
      const token = ++orderRefreshSequence;
      let answer = null;
      const at = work.capture("document");
      try { answer = await api("GET", "/bootstrap?states=omit", undefined, undefined, at); } catch (e) { answer = null; }
      let replaced = false;
      work.commit(at, () => {
        if (token !== orderRefreshSequence || !serverMode) return;
        if (!Array.isArray(answer?.orders) || !myInstitution || answer.me?.institution !== myInstitution) {
          toast("오더 목록을 다시 받지 못했습니다 — 보이는 목록은 이전 것입니다. 잠시 후 Refresh를 다시 누르세요.", "err");
          return;
        }
        orders = answer.orders;
        if (!orders.some(o => o.oid === selectedOid)) selectedOid = null;
        renderOrders();
        replaced = true;
      });
      return replaced;
    }
    $("#o-refresh").addEventListener("click", refreshOrders);
    $("#o-clear").addEventListener("click", () => {
      Object.keys(ofval).forEach(k => ofval[k] = "");
      document.querySelectorAll(".order-p .filters input").forEach(i => i.value = "");
      $("#o-sync").checked = false;
      renderOrders();
    });