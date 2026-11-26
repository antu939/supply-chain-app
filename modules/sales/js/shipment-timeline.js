(function (global) {
  "use strict";

  const getTS = () => global.SC.TimeSeries;
  const esc = t => String(t ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const fmtNum = n => Number(n || 0).toLocaleString("en-US", { maximumFractionDigits: 0 });

  function mountShipmentTimeline(container, ctx) {
    if (!container) return;
    const TS = getTS();
    const {
      world,
      scenario,
      simulation,
      selected,
      onSelectShipment,
      onRescheduleShipment,
      onNewShipment,
      onNotify
    } = ctx;

    const H = world.horizonDays || 60;
    const shipments = Object.values(scenario.shipments)
      .filter(s => s.status !== "cancelled")
      .sort((a, b) => a.departDay - b.departDay || a.code.localeCompare(b.code));

    const pct = day => Math.max(0, Math.min(100, (day / H) * 100));
    const tickStep = H <= 45 ? 5 : 10;
    let ticksHtml = "";
    for (let d = 0; d <= H; d += tickStep) {
      ticksHtml += `<span class="tl-tick" style="left:${pct(d).toFixed(2)}%"><i></i><b>D${d}</b><small>${TS.addDaysToIso(world.startDate, d).slice(5)}</small></span>`;
    }

    const rowsHtml = shipments.map(shp => {
      const st = simulation.shipmentStates[shp.id];
      const from = scenario.nodes[shp.fromNodeId];
      const to = scenario.nodes[shp.toNodeId];
      const route = scenario.routes[shp.routeId];
      const isFact = shp.status === "confirmed";
      const isBlocked = st?.statusAtHorizon === "blocked";
      const isSel = selected?.kind === "shipment" && selected.id === shp.id;

      const dStart = st?.departDay ?? shp.departDay;
      const dBorder = st?.borderArrivalDay ?? st?.availableDay ?? dStart;
      const dRelease = st?.customsReleaseDay ?? st?.availableDay ?? dStart;
      const dAvail = st?.availableDay ?? dStart;

      const pStart = pct(dStart);
      const pBorder = pct(Math.min(H, dBorder));
      const pRelease = pct(Math.min(H, dRelease));
      const pAvail = pct(Math.min(H, dAvail));

      const transitW = Math.max(0.8, pBorder - pStart);
      const customsW = st?.isCrossBorderMarket ? Math.max(0, pRelease - pBorder) : 0;
      const putawayW = st?.isCrossBorderMarket ? Math.max(0, pAvail - pRelease) : 0;

      const msTip = st?.isCrossBorderMarket
        ? `Dispatch D${dStart} → Arrival D${dBorder}${st.borderArrivalActualDay !== null ? " (Act)" : " (Est)"} → Customs D${dRelease}${st.customsReleaseActualDay !== null ? " (Act)" : " (Est)"} → Sellable D${dAvail}${st.marketStockAvailableActualDay !== null ? " (Act)" : " (Est)"}`
        : `Dispatch D${dStart} → Available D${dAvail}`;

      return `
        <div class="tl-row ${isSel ? "is-selected" : ""} ${isBlocked ? "is-blocked" : ""}" data-tl-shp="${shp.id}">
          <div class="tl-row-meta" data-open-shp="${shp.id}">
            <div class="tl-row-top">
              <strong class="tl-code">${esc(shp.code)}</strong>
              ${isFact ? `<span class="badge fact">Confirmed</span>` : isBlocked ? `<span class="badge danger">Blocked</span>` : `<span class="badge plan">Planned</span>`}
            </div>
            <div class="tl-row-route">${esc(from?.name || shp.fromNodeId)} → ${esc(to?.name || shp.toNodeId)}</div>
            <div class="tl-row-sub">
              <span><b>${fmtNum(shp.qty)}</b> units</span>
              <span>·</span>
              <span>D${dStart} → D${dAvail}</span>
              ${route?.viaNodeIds?.length ? `<span class="badge subtle">Transit Hub</span>` : ""}
            </div>
          </div>

          <div class="tl-track" data-tl-track="${shp.id}">
            <!-- Discrete transit + customs + putaway milestone bar -->
            <div class="tl-bar transit ${isBlocked ? "blocked" : ""}" style="left:${pStart.toFixed(2)}%;width:${transitW.toFixed(2)}%" title="${esc(msTip)}"></div>
            ${customsW > 0 ? `<div class="tl-bar border" style="left:${pBorder.toFixed(2)}%;width:${customsW.toFixed(2)}%" title="At Customs (D${dBorder}–D${dRelease}): Non-sellable"></div>` : ""}
            ${putawayW > 0 ? `<div class="tl-bar customs" style="left:${pRelease.toFixed(2)}%;width:${putawayW.toFixed(2)}%" title="Putaway Pending (D${dRelease}–D${dAvail}): Non-sellable"></div>` : ""}

            <!-- Discrete departure draggable marker -->
            <button type="button"
              class="tl-depart-pin ${isFact ? "is-fact" : ""} ${isBlocked ? "is-blocked" : ""}"
              style="left:${pStart.toFixed(2)}%"
              data-drag-shp="${shp.id}"
              title="${isFact ? "Confirmed shipments cannot be dragged; click to view details" : "Drag horizontally to reschedule · Click to edit"}">
              <span class="tl-pin-diamond"></span>
              <span class="tl-pin-label">D${dStart} · ${fmtNum(shp.qty)}</span>
            </button>

            <!-- Terminal available milestone marker -->
            ${dAvail <= H ? `<span class="tl-avail-dot ${st?.marketStockAvailableActualDay !== null ? "is-actual" : ""}" style="left:${pAvail.toFixed(2)}%" title="Sellable Inventory D${dAvail}"></span>` : ""}
          </div>
        </div>`;
    }).join("");

    container.innerHTML = `
      <div class="tl-card">
        <div class="tl-header">
          <div class="tl-title-group">
            <h3>Shipment & Cross-Border Milestone Timeline</h3>
            
          </div>
          <div class="tl-header-right">
            <div class="tl-legend">
              <span><i class="sw transit"></i>In Transit</span>
              <span><i class="sw border"></i>At Customs</span>
              <span><i class="sw customs"></i>Putaway</span>
              <span><i class="sw fact"></i>Confirmed</span>
            </div>
            <button type="button" class="btn small primary" data-tl-action="new-shipment">+ Schedule Shipment</button>
          </div>
        </div>

        <div class="tl-axis-row">
          <div class="tl-axis-spacer">Shipment / Route</div>
          <div class="tl-axis-scale">${ticksHtml}</div>
        </div>

        <div class="tl-rows">
          ${rowsHtml || `<div class="empty-card">No shipments scheduled yet.</div>`}
        </div>
      </div>
    `;

    container.querySelector("[data-tl-action='new-shipment']")?.addEventListener("click", () => {
      onNewShipment && onNewShipment();
    });

    container.querySelectorAll("[data-open-shp]").forEach(el => {
      el.addEventListener("click", () => onSelectShipment && onSelectShipment(el.dataset.openShp));
    });

    // Horizontal drag-to-reschedule on departure markers
    container.querySelectorAll("[data-drag-shp]").forEach(pin => {
      pin.addEventListener("pointerdown", (ev) => {
        if (ev.button !== 0) return;
        const shpId = pin.dataset.dragShp;
        const shp = scenario.shipments[shpId];
        if (!shp) return;

        if (shp.status === "confirmed") {
          onSelectShipment && onSelectShipment(shpId);
          onNotify && onNotify("Confirmed shipments cannot be dragged; update milestones in the detail drawer.");
          return;
        }

        const track = container.querySelector(`[data-tl-track="${shpId}"]`);
        if (!track) return;
        const rect = track.getBoundingClientRect();
        pin.setPointerCapture(ev.pointerId);

        const startX = ev.clientX;
        let moved = false;
        let targetDay = shp.departDay;
        const labelEl = pin.querySelector(".tl-pin-label");

        const onMove = (mev) => {
          if (Math.abs(mev.clientX - startX) > 4) moved = true;
          const ratio = Math.max(0, Math.min(1, (mev.clientX - rect.left) / rect.width));
          targetDay = Math.max(0, Math.min(H - 1, Math.round(ratio * H)));
          pin.style.left = pct(targetDay).toFixed(2) + "%";
          if (labelEl) labelEl.textContent = `D${targetDay} · ${fmtNum(shp.qty)}`;
        };

        const onUp = () => {
          pin.removeEventListener("pointermove", onMove);
          pin.removeEventListener("pointerup", onUp);
          if (moved && targetDay !== shp.departDay) {
            onRescheduleShipment && onRescheduleShipment(shpId, targetDay);
          } else {
            onSelectShipment && onSelectShipment(shpId);
          }
        };

        pin.addEventListener("pointermove", onMove);
        pin.addEventListener("pointerup", onUp);
      });
    });
  }

  global.SC = global.SC || {};
  global.SC.ShipmentTimeline = { mountShipmentTimeline };
})(typeof globalThis !== "undefined" ? globalThis : this);
