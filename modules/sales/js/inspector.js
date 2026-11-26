(function (global) {
  "use strict";

  const getTS = () => global.SC.TimeSeries;
  const getWM = () => global.SC.WorldModel;

  const esc = t => String(t ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const fmtNum = (n, d = 0) => Number(n || 0).toLocaleString("en-US", { maximumFractionDigits: d });
  const fmtMoney = n => "$" + Number(n || 0).toLocaleString("en-US", { maximumFractionDigits: 0 });

  const PROGRESS_LABELS = {
    planned: { label: "Planned", cls: "subtle" },
    dispatch_unconfirmed: { label: "Dispatch Due", cls: "ochre" },
    in_transit: { label: "In Transit", cls: "blue" },
    overdue_border: { label: "Arrival Due", cls: "ochre" },
    at_border: { label: "At Customs", cls: "ochre" },
    overdue_customs: { label: "Customs Due", cls: "ochre" },
    in_customs: { label: "Putaway", cls: "blue" },
    overdue_putaway: { label: "Putaway Due", cls: "ochre" },
    available: { label: "Shelved", cls: "accent" },
    blocked: { label: "Blocked", cls: "danger" },
    cancelled: { label: "Cancelled", cls: "subtle" }
  };

  function correctFact(fact, onDispatch) {
    const date = prompt("Corrected date (YYYY-MM-DD):", fact.date);
    if (date === null) return;
    const payload = { date: date.trim() };
    if (["production_confirmed", "inventory_stocktake", "shipment_dispatched"].includes(fact.kind)) {
      const qty = prompt("Corrected actual quantity:", String(fact.qty ?? ""));
      if (qty === null) return;
      payload.qty = qty;
    }
    const reason = prompt("Correction reason:", "Receipt update");
    if (reason === null) return;
    payload.note = reason;
    onDispatch("event.correct", fact.eventId, payload, { toast: "Correction recorded" });
  }

  function renderPanel(panelEl, ctx) {
    const TS = getTS();
    const WM = getWM();
    const {
      workspace,
      simulation,
      bomCatalog,
      panel,
      onClose,
      onDispatch,
      onOpenNewShipment,
      onOpenNewLane,
      onSyncBom,
      onImportBom,
      onEditProductSku,
      onOpenBomModule,
      onEditMfgCost
    } = ctx;
    if (!panel) return;

    const headHtml = (avatar, eyebrow, title, badges) => `
      <header class="panel-head">
        <div class="panel-heading">
          <div class="panel-avatar">${avatar}</div>
          <div class="panel-heading-copy">
            <span class="eyebrow">${esc(eyebrow)}</span>
            <h2>${esc(title)}</h2>
            <div class="panel-badges">${badges}</div>
          </div>
        </div>
        <button type="button" class="icon-btn panel-close" data-panel-close="1" aria-label="Close">✕</button>
      </header>`;

    /* ================= 1. SHIPMENT DETAIL ================= */
    if (panel.kind === "shipment") {
      const shp = workspace.shipments[panel.id];
      if (!shp) { onClose(); return; }
      const st = simulation.shipmentStates[shp.id];
      const from = workspace.nodes[shp.fromNodeId];
      const to = workspace.nodes[shp.toNodeId];
      const isFact = WM.hasShipmentActuals(shp);
      const prog = PROGRESS_LABELS[st?.operationalStatus] || PROGRESS_LABELS.planned;
      const srcBatches = Object.values(workspace.batches).filter(b => b.sourceNodeId === shp.fromNodeId);
      const shpConflicts = simulation.conflicts.filter(c => c.targetId === shp.id);
      const stopovers = Array.isArray(shp.stopoverPorts) ? shp.stopoverPorts : [];

      const timelineStep = (title, kind, plannedDate, estimatedDate, actualDate, isOverdue) => `
        <div class="ship-step ${actualDate ? "is-done" : isOverdue ? "is-overdue" : ""}">
          <span class="ship-step-dot"></span>
          <div class="ship-step-body">
            <div class="ship-step-head">
              <strong>${esc(title)}</strong>
              ${actualDate
                ? `<span class="badge fact">Act ${esc(actualDate)}</span>`
                : isOverdue
                  ? `<span class="badge ochre">Overdue ${esc(st.overdueDueDate)}</span>`
                  : `<span class="badge subtle">Est ${esc(estimatedDate || "—")}</span>`}
            </div>
            <div class="ship-step-foot">
              <span class="muted small">Planned ${esc(plannedDate || "—")}${estimatedDate && estimatedDate !== plannedDate ? ` · Est ${esc(estimatedDate)}` : ""}</span>
              <button type="button" class="text-btn" data-confirm-ms="${kind}" data-default-date="${esc(actualDate || estimatedDate || simulation.today)}">
                ${actualDate ? "Correct / Amend" : "Confirm Actual"}
              </button>
            </div>
          </div>
        </div>`;

      const cycleText = st?.fullCycleZeroSpan
        ? `${st.fullCycleElapsedPct}% · 0d cycle`
        : `${st.fullCycleElapsedPct}%${st.fullCycleOverrun ? "+" : ""} · ${st.fullCyclePlannedDays}d`;

      panelEl.innerHTML = `
        ${headHtml("S", shp.code, `${from?.name || ""} → ${to?.name || ""}`, `
          <span class="badge ${prog.cls}">${esc(prog.label)}</span>
          <span class="badge subtle">${fmtNum(shp.qty)} units</span>
          <span class="badge subtle">${esc(WM.modeLabel(shp.mode))} · ${shp.transitDays ?? 0}d</span>
          <span class="badge subtle">${fmtMoney(st?.totalCost || 0)}</span>
        `)}
        <div class="panel-body">
          ${shpConflicts.length ? `
            <div class="alert-box danger">
              <ul>${shpConflicts.map(c => `<li>${esc(c.message)}</li>`).join("")}</ul>
            </div>` : ""}

          ${st?.operationalOverdue ? `
            <div class="alert-box warn">
              <strong>Overdue by ${st.overdueDays}d — confirmation required</strong>
            </div>` : ""}

          <div class="panel-actions">
            <button type="button" class="btn small" data-insp="dup-shp">Clone Shipment</button>
            ${!isFact ? `<button type="button" class="btn small ghost danger" data-insp="cancel-shp">Cancel Shipment</button>` : ""}
          </div>

          <section class="panel-section">
            <div class="panel-section-head"><h3>Progress & Milestones</h3></div>

            <div class="transit-est-box">
              <div class="transit-est-top">
                <span>Planned Cycle Progress</span>
                <strong>${esc(cycleText)}</strong>
              </div>
              <div class="cost-track"><span class="cost-fill freight" style="width:${st?.fullCycleElapsedPct || 0}%"></span></div>
            </div>

            <div class="ship-timeline">
              ${timelineStep("Dispatched", "shipment_dispatched", st?.departPlannedDate || shp.departDate, st?.departPlannedDate || shp.departDate, st?.departActualDate, false)}
              ${stopovers.map((sp, i) => `
                <div class="ship-step is-stopover ${sp.actualDate ? "is-done" : ""}">
                  <span class="ship-step-dot"></span>
                  <div class="ship-step-body">
                    <div class="ship-step-head">
                      <strong>Stopover: ${esc(sp.port)}</strong>
                      <button type="button" class="text-btn danger" data-del-stopover="${i}">Remove</button>
                    </div>
                    <div class="muted small">${sp.actualDate || sp.plannedDate || "—"}</div>
                  </div>
                </div>`).join("")}
              ${timelineStep("Port Arrival", "border_arrival", st?.borderArrivalPlannedDate, st?.effectiveBorderDate, st?.borderArrivalActualDate, st?.operationalOverdue && st.overdueStage === "border_arrival")}
              ${timelineStep("Customs Release", "customs_release", st?.customsReleasePlannedDate, st?.effectiveReleaseDate, st?.customsReleaseActualDate, st?.operationalOverdue && st.overdueStage === "customs_release")}
              ${timelineStep("Putaway Complete (D)", "market_stock_available", st?.putawayCompletePlannedDate, st?.effectivePutawayDate, st?.putawayCompleteActualDate, st?.operationalOverdue && st.overdueStage === "market_stock_available")}
              <div class="ship-step is-derived ${st?.earliestSellableActualDate && st.earliestSellableActualDate <= simulation.today ? "is-done" : ""}">
                <span class="ship-step-dot"></span>
                <div class="ship-step-body">
                  <div class="ship-step-head">
                    <strong>Earliest Sellable (D+1)</strong>
                    ${st?.earliestSellableActualDate
                      ? `<span class="badge fact">Act ${esc(st.earliestSellableActualDate)}</span>`
                      : `<span class="badge subtle">Est ${esc(st?.effectiveSellableDate || "—")}</span>`}
                  </div>
                </div>
              </div>
            </div>
            <button type="button" class="btn small ghost" style="margin-top:8px" data-insp="add-stopover">+ Stopover Port</button>
          </section>

          <section class="panel-section">
            <div class="panel-section-head"><h3>Shipment Details & Docs</h3></div>
            <form class="form-grid" data-insp-form="shp-update">
              <label><span>Dispatch Date</span><input name="departDate" type="date" value="${esc(shp.departDate)}" ${isFact ? "disabled" : ""}></label>
              <label><span>Quantity</span><input name="qty" type="number" min="0.000001" step="any" value="${shp.qty}" ${isFact ? "disabled" : ""}></label>
              <label><span>Transport Mode</span>
                <select name="mode">
                  ${WM.TRANSPORT_MODES.map(m => `<option value="${m.key}" ${shp.mode === m.key ? "selected" : ""}>${esc(m.label)}</option>`).join("")}
                </select>
              </label>
              <label><span>Transit Days</span><input name="transitDays" type="number" min="0" value="${shp.transitDays ?? 0}"></label>
              <label><span>Carrier</span><input name="carrier" value="${esc(shp.carrier || "")}"></label>
              <label><span>Source Batch</span>
                <select name="batchId" ${isFact ? "disabled" : ""}>
                  <option value="">None</option>
                  ${srcBatches.map(b => `<option value="${b.id}" ${shp.batchId === b.id ? "selected" : ""}>${esc(b.code)} (${b.availableDate})</option>`).join("")}
                </select>
              </label>
              <label><span>Fixed Freight ($)</span><input name="fixedCost" type="number" min="0" step="any" value="${shp.fixedCost ?? 0}"></label>
              <label><span>Unit Freight ($)</span><input name="unitCost" type="number" min="0" step="any" value="${shp.unitCost ?? 0}"></label>
              <label><span>Customs Days</span><input name="customsWaitDays" type="number" min="0" value="${shp.customsWaitDays ?? 0}"></label>
              <label><span>Putaway Days</span><input name="putawayDays" type="number" min="0" value="${shp.putawayDays ?? 0}"></label>
              <label><span>Origin Port</span><input name="originPort" value="${esc(shp.originPort || "")}"></label>
              <label><span>Destination Port</span><input name="destinationPort" value="${esc(shp.destinationPort || "")}"></label>
              <label><span>B/L No.</span><input name="blNumber" value="${esc(shp.blNumber || "")}"></label>
              <label><span>Tracking No.</span><input name="trackingNumber" value="${esc(shp.trackingNumber || "")}"></label>
              <label><span>Container No.</span><input name="containerNo" value="${esc(shp.containerNo || "")}"></label>
              <label><span>Voyage No.</span><input name="voyageNo" value="${esc(shp.voyageNo || "")}"></label>
              <label class="span-2"><span>Notes</span><textarea name="note" rows="2">${esc(shp.note || "")}</textarea></label>
              <div class="form-foot span-2"><button type="submit" class="btn small primary">Save</button></div>
            </form>
          </section>
        </div>
      `;

      panelEl.querySelector("[data-insp-form='shp-update']")?.addEventListener("submit", e => {
        e.preventDefault();
        const fd = new FormData(e.target);
        const payload = {
          mode: fd.get("mode"),
          transitDays: fd.get("transitDays"),
          carrier: fd.get("carrier"),
          fixedCost: fd.get("fixedCost"),
          unitCost: fd.get("unitCost"),
          customsWaitDays: fd.get("customsWaitDays"),
          putawayDays: fd.get("putawayDays"),
          originPort: fd.get("originPort"),
          destinationPort: fd.get("destinationPort"),
          blNumber: fd.get("blNumber"),
          trackingNumber: fd.get("trackingNumber"),
          containerNo: fd.get("containerNo"),
          voyageNo: fd.get("voyageNo"),
          note: fd.get("note")
        };
        if (!isFact) {
          payload.departDate = fd.get("departDate");
          payload.qty = fd.get("qty");
          payload.batchId = fd.get("batchId") || null;
        }
        onDispatch("shipment.update", shp.id, payload, { toast: `Saved ${shp.code}` });
      });

      panelEl.querySelectorAll("[data-confirm-ms]").forEach(btn => {
        btn.addEventListener("click", () => {
          const kind = btn.dataset.confirmMs;
          const fact = WM.findEffectiveFact(workspace, shp.id, kind);
          if (fact) {
            correctFact(fact, onDispatch);
            return;
          }
          const val = prompt("Enter actual date (YYYY-MM-DD):", btn.dataset.defaultDate);
          if (val === null) return;
          onDispatch("event.record", shp.id, { kind, date: val.trim(), qty: shp.qty, note: "Actual confirmed" }, { toast: "Actual date confirmed" });
        });
      });

      panelEl.querySelector("[data-insp='add-stopover']")?.addEventListener("click", () => {
        const port = prompt("Stopover port name:", "");
        if (!port || !port.trim()) return;
        const dt = prompt("Date (YYYY-MM-DD, optional):", "");
        if (dt === null) return;
        onDispatch("shipment.update", shp.id, {
          stopoverPorts: [...stopovers, { port: port.trim(), plannedDate: dt.trim() || null, actualDate: null, note: "" }]
        }, { toast: `Added ${port.trim()}` });
      });

      panelEl.querySelectorAll("[data-del-stopover]").forEach(btn => {
        btn.addEventListener("click", () => {
          const idx = Number(btn.dataset.delStopover);
          onDispatch("shipment.update", shp.id, { stopoverPorts: stopovers.filter((_, i) => i !== idx) }, { toast: "Stopover port removed" });
        });
      });

      panelEl.querySelector("[data-insp='dup-shp']")?.addEventListener("click", () => {
        onDispatch("shipment.duplicate", shp.id, { departDate: TS.addDaysToIso(simulation.today, 3) }, { toast: `Cloned ${shp.code}` });
      });

      panelEl.querySelector("[data-insp='cancel-shp']")?.addEventListener("click", () => {
        const res = onDispatch("shipment.cancel", shp.id, {}, { toast: `Cancelled ${shp.code}` });
        if (res.ok) onClose();
      });
    }

    /* ================= 2. MARKET NODE INSPECTOR (无多余等待/订单延迟字段) ================= */
    else if (panel.kind === "node") {
      const node = workspace.nodes[panel.id];
      if (!node || node.kind !== "market") { onClose(); return; }
      const todaySnap = simulation.nodeDaily[node.id]?.[simulation.todayIdx] || {};
      const mktSum = simulation.marketSummaries[node.id];

      panelEl.innerHTML = `
        ${headHtml("M", "Target Market", node.name, `
          <span class="badge blue">P${node.marketPolicy?.priority || 1}</span>
          <span class="badge subtle">${esc(node.region)}</span>
          <span class="badge subtle">Sellable ${fmtNum(todaySnap.endingAvailable)}</span>
        `)}
        <div class="panel-body">
          <div class="panel-actions">
            <button type="button" class="btn small" data-insp="record-stocktake">Stocktake Sellable Inventory</button>
          </div>

          <section class="panel-section">
            <div class="panel-section-head"><h3>Market & Inventory</h3></div>
            <form class="form-grid" data-insp-form="node-basic">
              <label><span>Name</span><input name="name" value="${esc(node.name)}" required></label>
              <label><span>Region</span><input name="region" value="${esc(node.region)}"></label>
              <label><span>City / Port</span><input name="city" value="${esc(node.city || "")}"></label>
              <label><span>Opening Inventory (${esc(workspace.inventoryAnchorDate)})</span><input name="initialInventory" type="number" min="0" step="any" value="${node.initialInventory ?? 0}"></label>
              <div class="form-foot span-2"><button type="submit" class="btn small primary">Save</button></div>
            </form>
          </section>

          <section class="panel-section">
            <div class="panel-section-head"><h3>Priority & Unit Costs</h3><span class="section-count">Fill Rate ${Math.round((mktSum?.demandSatisfactionRate || 0) * 100)}%</span></div>
            <form class="form-grid" data-insp-form="market-policy">
              <label><span>Priority</span><input name="priority" type="number" min="1" value="${node.marketPolicy?.priority ?? 1}"></label>
              <label><span>Last-Mile Cost / Unit ($)</span><input name="lastMileUnitCost" type="number" min="0" step="any" value="${node.marketPolicy?.lastMileUnitCost ?? 12}"></label>
              <label><span>Fulfillment Cost / Unit ($)</span><input name="fulfillmentUnitCost" type="number" min="0" step="any" value="${node.marketPolicy?.fulfillmentUnitCost ?? 4}"></label>
              <label><span>Channel Commission / Unit ($)</span><input name="channelCommissionUnitCost" type="number" min="0" step="any" value="${node.marketPolicy?.channelCommissionUnitCost ?? 15}"></label>
              <div class="form-foot span-2"><button type="submit" class="btn small primary">Update</button></div>
            </form>
          </section>

          <div class="panel-danger">
            <button type="button" class="btn small ghost danger" data-insp="delete-node">Delete Market</button>
          </div>
        </div>
      `;

      panelEl.querySelector("[data-insp-form='node-basic']")?.addEventListener("submit", e => {
        e.preventDefault();
        const fd = new FormData(e.target);
        onDispatch("node.update", node.id, {
          name: fd.get("name"),
          region: fd.get("region"),
          city: fd.get("city"),
          initialInventory: fd.get("initialInventory")
        }, { toast: "Saved" });
      });

      panelEl.querySelector("[data-insp-form='market-policy']")?.addEventListener("submit", e => {
        e.preventDefault();
        const fd = new FormData(e.target);
        onDispatch("market.policy.update", node.id, {
          priority: fd.get("priority"),
          lastMileUnitCost: fd.get("lastMileUnitCost"),
          fulfillmentUnitCost: fd.get("fulfillmentUnitCost"),
          channelCommissionUnitCost: fd.get("channelCommissionUnitCost")
        }, { toast: "Market settings updated" });
      });

      panelEl.querySelector("[data-insp='record-stocktake']")?.addEventListener("click", () => {
        const qtyStr = prompt(`${node.name} — Actual sellable inventory today (${simulation.today}):`, String(Math.round(todaySnap.endingAvailable || 0)));
        if (qtyStr === null) return;
        onDispatch("event.record", node.id, {
          kind: "inventory_stocktake", date: simulation.today, qty: qtyStr, note: "Stocktake adjustment"
        }, { toast: "Stocktake inventory updated" });
      });

      panelEl.querySelector("[data-insp='delete-node']")?.addEventListener("click", () => {
        const r = onDispatch("node.delete", node.id, {}, { toast: "Market deleted" });
        if (r?.ok) onClose();
      });
    }

    /* ================= 3. BATCH INSPECTOR ================= */
    else if (panel.kind === "batch") {
      const bat = workspace.batches[panel.id];
      if (!bat) { onClose(); return; }
      const bs = simulation.batchStates[bat.id];
      const src = workspace.nodes[bat.sourceNodeId];
      const isFact = bat.status === "confirmed";
      const totalQty = bs?.computedQty || 0;
      const allocQty = bs?.allocatedShipmentQty || 0;
      const remQty = bs?.remainingBatchQty || 0;
      const actualQty = bs?.actualDispatchedQty || 0;
      const plannedQty = bs?.plannedAllocatedQty || 0;
      const allocPct = totalQty > 0 ? Math.round((allocQty / totalQty) * 1000) / 10 : 0;
      const remPct = totalQty > 0 ? Math.max(0, Math.round((remQty / totalQty) * 1000) / 10) : 0;
      const allocations = bs?.allocations || [];

      panelEl.innerHTML = `
        ${headHtml("B", src?.name || "Production Batch", bat.code, `
          <span class="badge ${isFact ? "fact" : "accent"}">${isFact ? "Completed" : "Planned"}</span>
          <span class="badge subtle">${fmtNum(totalQty)} units</span>
          <span class="badge subtle">Rem ${fmtNum(remQty)}</span>
        `)}
        <div class="panel-body">
          <div class="panel-actions">
            <button type="button" class="btn small primary" data-insp="ship-batch">+ Schedule Shipment</button>
            ${!isFact ? `<button type="button" class="btn small" data-insp="confirm-batch">Confirm Completion</button>` : ""}
          </div>
          <section class="panel-section">
            <div class="panel-section-head">
              <h3>Market Allocation</h3>
              <span class="section-count">Allocated ${allocPct}% · At Factory ${remPct}%</span>
            </div>
            <div class="batch-alloc-stats">
              <span>Allocated <b>${fmtNum(allocQty)}</b></span>
              <span>Dispatched <b>${fmtNum(actualQty)}</b></span>
              <span>Planned <b>${fmtNum(plannedQty)}</b></span>
              <span>Remaining <b>${fmtNum(remQty)}</b></span>
            </div>
            ${allocations.length ? `
              <div class="fact-list" style="margin-top:8px">
                ${allocations.map(a => `
                  <button type="button" class="fact-item alloc-link-item" data-open-target="shipment:${esc(a.shipmentId)}">
                    <div class="fact-item-head">
                      <strong>${esc(a.marketName)}</strong>
                      <span class="badge ${a.isActual ? "fact" : "subtle"}">${a.isActual ? "Dispatched" : "Planned"}</span>
                      <span class="alloc-item-qty">${fmtNum(a.qty)} units (${a.pct}%)</span>
                    </div>
                    <div class="muted small">${esc(a.code)} · ${esc(a.departDate)} · ${esc(WM.modeLabel(a.mode))}</div>
                  </button>`).join("")}
              </div>` : `<div class="empty-card" style="padding:14px">Unallocated</div>`}
          </section>
          <section class="panel-section">
            <div class="panel-section-head"><h3>Batch Details</h3></div>
            <form class="form-grid" data-insp-form="batch-edit">
              <label><span>Batch Code</span><input name="code" value="${esc(bat.code)}" ${isFact ? "disabled" : ""}></label>
              <label><span>Wait Days</span><input name="extraWaitDays" type="number" min="0" value="${bat.extraWaitDays ?? 0}" ${isFact ? "disabled" : ""}></label>
              <label><span>Start Date</span><input name="startDate" type="date" value="${esc(bat.startDate)}" ${isFact ? "disabled" : ""}></label>
              <label><span>End Date</span><input name="endDate" type="date" value="${esc(bat.endDate)}" ${isFact ? "disabled" : ""}></label>
              <label class="span-2"><span>Notes</span><textarea name="note" rows="2" ${isFact ? "disabled" : ""}>${esc(bat.note || "")}</textarea></label>
              ${!isFact ? `<div class="form-foot span-2"><button type="submit" class="btn small primary">Save</button></div>` : ""}
            </form>
          </section>
          ${!isFact ? `<div class="panel-danger"><button type="button" class="btn small ghost danger" data-insp="delete-batch">Delete Batch</button></div>` : ""}
        </div>
      `;

      panelEl.querySelector("[data-insp-form='batch-edit']")?.addEventListener("submit", e => {
        e.preventDefault();
        const fd = new FormData(e.target);
        onDispatch("batch.update", bat.id, {
          code: fd.get("code"), startDate: fd.get("startDate"), endDate: fd.get("endDate"),
          extraWaitDays: fd.get("extraWaitDays"), note: fd.get("note")
        }, { toast: "Batch saved" });
      });
      panelEl.querySelector("[data-insp='ship-batch']")?.addEventListener("click", () => {
        onOpenNewShipment && onOpenNewShipment({
          fromNodeId: bat.sourceNodeId, batchId: bat.id,
          departDate: bs?.availableDate || bat.availableDate,
          qty: Math.max(1, Math.round(bs?.remainingBatchQty || 0))
        });
      });
      panelEl.querySelector("[data-insp='confirm-batch']")?.addEventListener("click", () => {
        const q = prompt("Actual completed quantity:", String(Math.round(bs?.computedQty || 0)));
        if (q === null) return;
        onDispatch("event.record", bat.id, { kind: "production_confirmed", date: bat.endDate, qty: q, note: "Completion confirmed" }, { toast: "Batch completion confirmed" });
      });
      panelEl.querySelector("[data-insp='delete-batch']")?.addEventListener("click", () => {
        const r = onDispatch("batch.delete", bat.id, {}, { toast: "Batch deleted" });
        if (r?.ok) onClose();
      });
    }

    /* ================= 4. LANE TEMPLATES ================= */
    else if (panel.kind === "lanes") {
      const lanes = Object.values(workspace.lanes || {});
      panelEl.innerHTML = `
        ${headHtml("L", "Lane Templates", "Saved Logistics Lanes", `<span class="badge subtle">${lanes.length}</span>`)}
        <div class="panel-body">
          <div class="panel-actions">
            <button type="button" class="btn small primary" data-insp="new-lane">+ New Lane</button>
          </div>
          <div class="fact-list">
            ${lanes.length ? lanes.map(l => `
              <div class="fact-item">
                <div class="fact-item-head">
                  <strong>${esc(l.name)}</strong>
                  <span class="badge blue">${esc(WM.modeLabel(l.defaultMode))} · ${l.defaultTransitDays}d</span>
                  <button type="button" class="text-btn" style="margin-left:auto" data-edit-lane="${l.id}">Edit</button>
                  <button type="button" class="text-btn danger" data-del-lane="${l.id}">Delete</button>
                </div>
                <div class="muted small">${esc(l.defaultCarrier || "—")} · $${l.defaultFixedCost} + $${l.defaultUnitCost}/unit · Customs ${l.defaultCustomsWaitDays}d</div>
              </div>`).join("") : `<div class="empty-card">No saved lanes</div>`}
          </div>
        </div>
      `;
      panelEl.querySelector("[data-insp='new-lane']")?.addEventListener("click", () => onOpenNewLane && onOpenNewLane(null));
      panelEl.querySelectorAll("[data-edit-lane]").forEach(btn => btn.addEventListener("click", () => onOpenNewLane && onOpenNewLane(btn.dataset.editLane)));
      panelEl.querySelectorAll("[data-del-lane]").forEach(btn => btn.addEventListener("click", () => onDispatch("lane.delete", btn.dataset.delLane, {}, { toast: "Lane deleted" })));
    }

    /* ================= 5. BOM READ-ONLY REFERENCE ================= */
    else if (panel.kind === "bom") {
      const prod = workspace.products[workspace.activeProductId] || Object.values(workspace.products)[0] || null;
      const bomProd = bomCatalog?.products?.find(p => prod?.bomDiagramId && p.diagramId === prod.bomDiagramId) || bomCatalog?.products?.[0] || null;
      const sharedFactories = (bomProd?.factories?.length ? bomProd.factories : (bomCatalog?.factories || []))
        .filter(f => f.status !== "archived");
      const rootCompName = bomProd?.rootCompanyName
        || (bomCatalog?.companies?.find(c => c.isFinalAssembler)?.name)
        || bomCatalog?.companies?.[0]?.name
        || "—";
      const compBadge = st => st === "qualified" ? `<span class="badge accent">Compliant</span>`
        : st === "risk" ? `<span class="badge ochre">At Risk</span>`
        : st === "severe" ? `<span class="badge danger">Severe</span>`
        : `<span class="badge subtle">Unverified</span>`;

      panelEl.innerHTML = `
        ${headHtml("B", "BOM & Product Reference", prod ? `${prod.name} (${prod.skuCode})` : "No Product / SKU", `<span class="badge ${bomProd ? "accent" : "subtle"}">${bomProd ? `BOM v${bomProd.bomVersion || 7}` : "No Linked BOM"}</span>`)}
        <div class="panel-body">
          <div class="panel-actions">
            <button type="button" class="btn small" data-insp="sync-bom">Sync Local Entities</button>
            <button type="button" class="btn small" data-insp="edit-sku">${prod ? "Edit SKU" : "+ Register SKU"}</button>
            <button type="button" class="btn small" data-insp="import-bom">Import BOM</button>
            <button type="button" class="btn small primary" data-insp="open-bom-mod">Open BOM ↗</button>
          </div>
          <section class="panel-section">
            <dl class="info-rows">
              <div class="info-row"><dt>Final Assembler</dt><dd>${esc(rootCompName)}</dd></div>
              <div class="info-row"><dt>Product / SKU</dt><dd>${prod ? `${esc(prod.name)} · <code>${esc(prod.skuCode)}</code>` : '<span class="muted">Not configured</span>'}</dd></div>
              ${prod ? `<div class="info-row"><dt>Unit Mfg Cost</dt><dd><b>${fmtMoney(prod.unitManufacturingCost)} / ${esc(prod.unit)}</b> <button type="button" class="text-btn" data-insp="edit-mfg" style="margin-left:8px">Edit</button></dd></div>` : ""}
            </dl>
          </section>
          <section class="panel-section">
            <div class="panel-section-head"><h3>Shared Factories</h3></div>
            <div class="fact-list">
              ${sharedFactories.length ? sharedFactories.map(f => `
                <div class="fact-item">
                  <strong>${esc(f.name)}</strong> <code class="small">${esc(f.id)}</code>
                  <div class="muted small">${esc(f.location || f.city || f.companyName || "—")}</div>
                </div>`).join("") : `<div class="empty-card">No factories</div>`}
            </div>
          </section>
          <section class="panel-section">
            <div class="panel-section-head"><h3>Top-Level BOM Components</h3></div>
            ${bomProd?.topComponents?.length ? `
              <table class="mini-table">
                <thead><tr><th>Component</th><th>Qty</th><th>Supplier</th><th>Compliance</th></tr></thead>
                <tbody>
                  ${bomProd.topComponents.map(c => `<tr>
                    <td><b>${esc(c.name)}</b></td><td>×${c.qty}</td><td>${esc(c.supplier)}</td><td>${compBadge(c.compliance)}</td>
                  </tr>`).join("")}
                </tbody>
              </table>` : `<div class="empty-card">No BOM structure</div>`}
          </section>
        </div>
      `;
      panelEl.querySelector("[data-insp='sync-bom']")?.addEventListener("click", () => onSyncBom && onSyncBom());
      panelEl.querySelector("[data-insp='import-bom']")?.addEventListener("click", () => onImportBom && onImportBom());
      panelEl.querySelector("[data-insp='edit-sku']")?.addEventListener("click", () => onEditProductSku && onEditProductSku());
      panelEl.querySelector("[data-insp='open-bom-mod']")?.addEventListener("click", () => onOpenBomModule && onOpenBomModule());
      panelEl.querySelector("[data-insp='edit-mfg']")?.addEventListener("click", () => onEditMfgCost && onEditMfgCost());
    }

    /* ================= 6. CONFIRMED FACTS LEDGER ================= */
    else if (panel.kind === "facts") {
      const kindNames = {
        production_confirmed: "Completed",
        shipment_dispatched: "Dispatched",
        border_arrival: "Arrived",
        customs_release: "Cleared",
        market_stock_available: "Shelved",
        inventory_stocktake: "Stocktake"
      };
      const effectiveIds = new Set(WM.getEffectiveFacts(workspace).map(fact => fact.eventId));
      panelEl.innerHTML = `
        ${headHtml("F", "Fact Ledger", "Confirmed Records", `<span class="badge fact">${workspace.facts.length}</span>`)}
        <div class="panel-body">
          <div class="fact-list">
            ${workspace.facts.filter(Boolean).reverse().map(f => {
              const isSup = !effectiveIds.has(f.eventId);
              return `
                <div class="fact-item ${isSup ? "is-superseded" : ""}">
                  <div class="fact-item-head">
                    <span class="badge ${isSup ? "subtle" : "fact"}">${esc(kindNames[f.kind] || f.kind)}</span>
                    <strong>${esc(f.date)}</strong>
                    <span class="muted small">${esc(f.targetId)}</span>
                    ${isSup ? `<span class="badge subtle">Amended</span>` : `<button type="button" class="text-btn" style="margin-left:auto" data-correct-fact="${esc(f.eventId)}">Amend</button>`}
                  </div>
                  <div class="fact-item-note">${f.qty !== undefined ? `${fmtNum(f.qty, 4)} · ` : ""}${esc(f.note)}</div>
                </div>`;
            }).join("")}
          </div>
        </div>
      `;
      panelEl.querySelectorAll("[data-correct-fact]").forEach(btn => {
        btn.addEventListener("click", () => {
          const eid = btn.dataset.correctFact;
          const orig = workspace.facts.find(x => x.eventId === eid);
          if (orig) correctFact(orig, onDispatch);
        });
      });
    }

    panelEl.querySelector("[data-panel-close]")?.addEventListener("click", onClose);
  }

  global.SC = global.SC || {};
  global.SC.Inspector = { renderPanel, PROGRESS_LABELS };
})(typeof globalThis !== "undefined" ? globalThis : this);
