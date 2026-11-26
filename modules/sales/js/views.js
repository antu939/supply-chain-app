(function (global) {
  "use strict";

  const getTS = () => global.SC.TimeSeries;
  const getWM = () => global.SC.WorldModel;
  const getSim = () => global.SC.SimEngine;

  const esc = t => String(t ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const fmtNum = (n, d = 0) => Number(n || 0).toLocaleString("en-US", { maximumFractionDigits: d });
  const fmtMoney = n => "$" + Number(n || 0).toLocaleString("en-US", { maximumFractionDigits: 0 });
  const fmtPct = r => (Number(r || 0) * 100).toFixed(1) + "%";

  function renderTrendChartSvg(workspace, simulation, nodeIds, opts) {
    const TS = getTS();
    const scopedShipments = opts?.shipments;
    const startIdx = simulation.todayIdx;
    const endIdx = simulation.viewEndIdx;
    const span = Math.max(1, endIdx - startIdx);
    const height = opts?.height || 200;
    const W = 740;
    const pad = { top: 18, right: 20, bottom: 30, left: 52 };
    const plotW = W - pad.left - pad.right;
    const plotH = height - pad.top - pad.bottom;

    const points = [];
    let maxY = 200;
    for (let i = startIdx; i <= endIdx; i++) {
      let avail = 0, pipe = 0, gap = 0, arrivals = 0;
      let date = "";
      for (const nid of nodeIds) {
        const snap = simulation.nodeDaily[nid]?.[i];
        if (!snap) continue;
        date = snap.date;
        if (!scopedShipments) {
          avail += snap.endingAvailable;
          pipe += snap.inTransitInbound + snap.atBorder + snap.inCustoms + snap.shelvedPendingNextDay + snap.projectedInPipeline;
          gap += snap.demandGap;
          arrivals += snap.arrivals;
        }
      }
      if (scopedShipments && date) {
        const flow = getSim().summarizeShipmentFlow(scopedShipments, simulation, date);
        pipe = flow.inTransitInbound + flow.atBorder + flow.inCustoms + flow.shelvedPendingNextDay + flow.projectedInPipeline;
        arrivals = flow.arrivals;
      }
      maxY = Math.max(maxY, avail, pipe, gap, arrivals);
      points.push({ idx: i - startIdx, date, avail, pipe, gap, arrivals });
    }
    if (!points.length) return `<div class="empty-card">No data available</div>`;
    maxY = Math.ceil((maxY * 1.15) / 100) * 100;

    const xOf = k => pad.left + (k / Math.max(1, span)) * plotW;
    const yOf = v => pad.top + plotH - (Math.max(0, v) / maxY) * plotH;

    let grid = "";
    for (let i = 0; i <= 4; i++) {
      const val = (maxY / 4) * i;
      const y = yOf(val);
      grid += `<line class="ts-grid-line" x1="${pad.left}" y1="${y.toFixed(1)}" x2="${W - pad.right}" y2="${y.toFixed(1)}"/>
        <text class="ts-axis-label" x="${pad.left - 8}" y="${(y + 3.5).toFixed(1)}" text-anchor="end">${fmtNum(val)}</text>`;
    }
    const step = span <= 15 ? 2 : span <= 40 ? 5 : 10;
    for (let k = 0; k <= span; k += step) {
      const x = xOf(k);
      grid += `<text class="ts-axis-label" x="${x.toFixed(1)}" y="${pad.top + plotH + 16}" text-anchor="middle">${TS.formatShortDate(points[k]?.date || "")}</text>`;
    }

    let riskBands = "";
    if (opts?.singleMarketId && !scopedShipments) {
      const mkt = simulation.marketSummaries[opts.singleMarketId];
      for (const win of (mkt?.gapWindows || [])) {
        const k0 = Math.max(0, TS.diffIsoDays(simulation.today, win.startDate) || 0);
        const k1 = Math.min(span, (TS.diffIsoDays(simulation.today, win.endDate) || 0) + 1);
        if (k1 > k0) {
          riskBands += `<rect class="chart-risk-band" x="${xOf(k0).toFixed(1)}" y="${pad.top}" width="${Math.max(4, xOf(k1) - xOf(k0)).toFixed(1)}" height="${plotH}"/>`;
        }
      }
    }

    let arrivalSpikes = "";
    for (const p of points) {
      if (p.arrivals > 0.5) {
        arrivalSpikes += `<line class="chart-arrival-spike" x1="${xOf(p.idx).toFixed(1)}" y1="${(pad.top + plotH).toFixed(1)}" x2="${xOf(p.idx).toFixed(1)}" y2="${yOf(p.arrivals).toFixed(1)}"><title>${p.date} Newly Sellable +${fmtNum(p.arrivals)}</title></line>`;
      }
    }

    const availPts = points.map(p => `${xOf(p.idx).toFixed(1)},${yOf(p.avail).toFixed(1)}`);
    const areaPts = [`${xOf(0).toFixed(1)},${(pad.top + plotH).toFixed(1)}`, ...availPts, `${xOf(points.length - 1).toFixed(1)},${(pad.top + plotH).toFixed(1)}`];
    const pipePts = points.map(p => `${xOf(p.idx).toFixed(1)},${yOf(p.pipe).toFixed(1)}`);
    const gapPts = opts?.showGap ? points.map(p => `${xOf(p.idx).toFixed(1)},${yOf(p.gap).toFixed(1)}`) : null;

    return `
      <svg class="inv-chart-svg" viewBox="0 0 ${W} ${height}" width="100%" height="${height}">
        <g>${grid}</g>
        ${riskBands}
        ${arrivalSpikes}
        ${!scopedShipments ? `<polygon class="inv-area" points="${areaPts.join(" ")}"/>` : ""}
        <polyline class="inv-line-pipe" points="${pipePts.join(" ")}"/>
        ${gapPts ? `<polyline class="inv-line-wait" points="${gapPts.join(" ")}"/>` : ""}
        ${!scopedShipments ? `<polyline class="inv-line-avail" points="${availPts.join(" ")}"/>` : ""}
        <line class="ts-axis-base" x1="${pad.left}" y1="${pad.top + plotH}" x2="${W - pad.right}" y2="${pad.top + plotH}"/>
      </svg>`;
  }

  /* =========================================================================
     PAGE A: 总览
     ========================================================================= */
  function mountDashboardShell(mainEl) {
    mainEl.innerHTML = `
      <div class="page-scroll" data-scroll-container="dashboard">
        <div data-zone="migration"></div>
        <header class="page-header">
          <div class="page-header-copy">
            <h1 class="page-title" data-zone="dash-title">Overview</h1>
          </div>
          <div class="page-header-controls">
            <div class="filter-bar" data-zone="dash-filters"></div>
          </div>
        </header>
        <section data-zone="dash-kpis"></section>
        <section class="two-col-grid">
          <div class="card" data-zone="dash-events"></div>
          <div class="card" data-zone="dash-markets"></div>
        </section>
        <section class="card" data-zone="dash-trend"></section>
      </div>`;
  }

  function updateDashboardZones(mainEl, ctx) {
    const { workspace, simulation, ui } = ctx;
    const prod = workspace.products[workspace.activeProductId] || Object.values(workspace.products)[0] || null;
    const unitText = prod?.unit || "units";
    const factories = Object.values(workspace.nodes).filter(n => n.kind === "source");
    const markets = Object.values(workspace.nodes).filter(n => n.kind === "market").sort((a, b) => (a.marketPolicy?.priority || 9) - (b.marketPolicy?.priority || 9));

    const migZone = mainEl.querySelector("[data-zone='migration']");
    if (workspace.migrationNotice && !workspace.migrationNotice.dismissed) {
      migZone.innerHTML = `
        <div class="migration-banner">
          <div>
            <strong>Legacy data migrated & backed up</strong>
            <p class="small">${workspace.migrationNotice.messages.map(esc).join(" ")}</p>
          </div>
          <button type="button" class="btn small ghost" data-app-action="dismiss-migration">Dismiss</button>
        </div>`;
    } else {
      migZone.innerHTML = "";
    }

    mainEl.querySelector("[data-zone='dash-title']").innerHTML =
      `Overview <span class="title-date">${esc(simulation.today)}</span>` +
      (workspace.dataSourceMode === "demo" ? ` <span class="badge ochre">Demo</span>` : "");

    mainEl.querySelector("[data-zone='dash-filters']").innerHTML = `
      <select class="compact-sel" data-dash-filter="factory" aria-label="Filter Factory">
        <option value="all" ${ui.dashFactory === "all" ? "selected" : ""}>All Factories</option>
        ${factories.map(f => `<option value="${f.id}" ${ui.dashFactory === f.id ? "selected" : ""}>${esc(f.name)}</option>`).join("")}
      </select>
      <select class="compact-sel" data-dash-filter="market" aria-label="Filter Market">
        <option value="all" ${ui.dashMarket === "all" ? "selected" : ""}>All Markets</option>
        ${markets.map(m => `<option value="${m.id}" ${ui.dashMarket === m.id ? "selected" : ""}>${esc(m.name)}</option>`).join("")}
      </select>
      <select class="compact-sel" data-dash-filter="horizon" aria-label="Time Horizon">
        ${[7, 30, 60, 90].map(h => `<option value="${h}" ${workspace.viewHorizonDays === h ? "selected" : ""}>Next ${h} Days</option>`).join("")}
      </select>`;

    const stats = getSim().summarizeDashboard(workspace, simulation, {
      factoryId: ui.dashFactory, marketId: ui.dashMarket
    });
    const kpis = stats.kpis;
    const filteredMarkets = stats.markets.sort((a, b) => a.priority - b.priority);
    const filteredExceptions = stats.exceptions;

    mainEl.querySelector("[data-zone='dash-kpis']").innerHTML = `
      <div class="kpi-grid">
        <div class="kpi-card">
          <span class="kpi-label">Available Inventory</span>
          <div class="kpi-value">${kpis.currentAvailableInventory === null ? "—" : fmtNum(kpis.currentAvailableInventory, 2)} <small>${esc(unitText)}</small></div>
        </div>
        <div class="kpi-card">
          <span class="kpi-label">In Transit</span>
          <div class="kpi-value">${fmtNum(kpis.currentInTransit, 2)} <small>${esc(unitText)}</small></div>
        </div>
        <div class="kpi-card ${kpis.awaitingCustoms > 0 ? "is-info" : ""}">
          <span class="kpi-label">Customs / Putaway</span>
          <div class="kpi-value">${fmtNum(kpis.awaitingCustoms, 2)} <small>${esc(unitText)}</small></div>
        </div>
        <div class="kpi-card">
          <span class="kpi-label">Shelved · Sellable Next Day</span>
          <div class="kpi-value">${fmtNum(kpis.shelvedPendingNextDay, 2)} <small>${esc(unitText)}</small></div>
        </div>
        ${kpis.projectedInPipeline > 0 ? `<div class="kpi-card">
          <span class="kpi-label">Projected Dispatched · Unconfirmed</span>
          <div class="kpi-value">${fmtNum(kpis.projectedInPipeline, 2)} <small>${esc(unitText)}</small></div>
        </div>` : ""}
        ${kpis.unreleasedProduction > 0 ? `<div class="kpi-card">
          <span class="kpi-label">Pending Production Release</span>
          <div class="kpi-value">${fmtNum(kpis.unreleasedProduction, 2)} <small>${esc(unitText)}</small></div>
        </div>` : ""}
        <div class="kpi-card">
          <span class="kpi-label">7-Day Expected Putaway</span>
          <div class="kpi-value">${fmtNum(kpis.next7DaysExpectedArrivals, 2)} <small>${esc(unitText)}</small></div>
        </div>
        <div class="kpi-card ${kpis.marketsAtRiskCount > 0 ? "is-warn" : ""}">
          <span class="kpi-label">Markets at Risk${ui.dashFactory !== "all" ? " (Overall)" : ""}</span>
          <div class="kpi-value">${kpis.marketsAtRiskCount} <small>/ ${filteredMarkets.length}</small></div>
        </div>
        <div class="kpi-card ${filteredExceptions.length > 0 ? "is-warn" : ""}">
          <span class="kpi-label">Open Exceptions</span>
          <div class="kpi-value">${filteredExceptions.length}</div>
        </div>
      </div>`;

    const eventsList = [...filteredExceptions, ...stats.upcomingEvents].slice(0, 7);

    mainEl.querySelector("[data-zone='dash-events']").innerHTML = `
      <div class="card-head">
        <h3>Recent Activity & Exceptions</h3>
        <button type="button" class="text-btn" data-nav-jump="logistics">All Shipments →</button>
      </div>
      <div class="event-feed">
        ${eventsList.length ? eventsList.map(ev => `
          <button type="button" class="event-row" data-open-target="${esc(ev.target.kind)}:${esc(ev.target.id)}">
            <span class="event-dot ${ev.severity === "danger" ? "danger" : ev.severity === "warn" ? "warn" : "info"}"></span>
            <div class="event-copy">
              <strong>${esc(ev.title)}</strong>
              <span class="muted small">${esc(ev.detail)}</span>
            </div>
            <span class="event-date">${esc(ev.date.slice(5))}</span>
          </button>`).join("") : `<div class="empty-card">No open exceptions</div>`}
      </div>`;

    mainEl.querySelector("[data-zone='dash-markets']").innerHTML = `
      <div class="card-head">
        <h3>Target Markets</h3>
        <button type="button" class="text-btn" data-nav-jump="market">Markets & Demand →</button>
      </div>
      <div class="mkt-mini-list">
        ${filteredMarkets.length ? filteredMarkets.map(m => `
          <button type="button" class="mkt-mini-row ${m.firstGapDate ? "is-risk" : ""}" data-open-target="node:${esc(m.nodeId)}">
            <div class="mkt-mini-top">
              <strong>${esc(m.name)}</strong>
              <span class="badge ${m.firstGapDate ? "danger" : "accent"}">${m.firstGapDate ? `Gap ${m.firstGapDate.slice(5)}` : "Healthy"}</span>
            </div>
            <div class="mkt-mini-stats">
              <span>Sellable <b>${m.currentAvailable === null ? "—" : fmtNum(m.currentAvailable)}</b></span>
              <span>Cover <b>${m.daysOfCoverNow === null ? "—" : m.daysOfCoverNow + "d"}</b></span>
              <span>Fill Rate <b>${fmtPct(m.demandSatisfactionRate)}</b></span>
              ${m.nextSellableDate ? `<span>Next Replenishment <b>${m.nextSellableDate.slice(5)}</b></span>` : ""}
            </div>
          </button>`).join("") : `<div class="empty-card"><button type="button" class="text-btn" data-app-action="add-market">+ Add Target Market</button></div>`}
      </div>`;

    const factoryScoped = ui.dashFactory !== "all";
    const trendNodeIds = ui.dashMarket !== "all" ? [ui.dashMarket] : markets.map(m => m.id);
    mainEl.querySelector("[data-zone='dash-trend']").innerHTML = `
      <div class="card-head">
        <h3>${factoryScoped ? "Selected Factory Replenishment Trend" : ui.dashMarket !== "all" ? `${esc(workspace.nodes[ui.dashMarket]?.name)} Inventory Trend` : "Aggregate Market Inventory Trend"}</h3>
        <span class="muted small">Logistics Cost ${fmtMoney(kpis.totalLogisticsCost)}</span>
      </div>
      ${trendNodeIds.length ? renderTrendChartSvg(workspace, simulation, trendNodeIds, {
        height: 196,
        singleMarketId: ui.dashMarket !== "all" ? ui.dashMarket : null,
        showGap: !factoryScoped && ui.dashMarket !== "all",
        shipments: factoryScoped ? stats.shipments : null
      }) : `<div class="empty-card">No data available</div>`}`;
  }

  /* =========================================================================
     PAGE B: 供给与批次
     ========================================================================= */
  function mountSupplyShell(mainEl) {
    mainEl.innerHTML = `
      <div class="page-scroll" data-scroll-container="supply">
        <header class="page-header">
          <div class="page-header-copy">
            <h1 class="page-title">Supply & Batches</h1>
          </div>
          <div class="page-header-controls">
            <button type="button" class="btn" data-app-action="pick-factory">+ Select Factory</button>
            <button type="button" class="btn primary" data-app-action="new-batch">+ New Batch</button>
          </div>
        </header>
        <section class="entity-strip" data-zone="supply-factories"></section>
        <section class="card">
          <div class="card-head" data-zone="supply-curve-head"></div>
          <div data-zone="supply-editor"></div>
        </section>
        <section class="card" data-zone="supply-batches"></section>
      </div>`;
  }

  function updateSupplyZones(mainEl, ctx) {
    const TS = getTS();
    const { workspace, simulation, ui } = ctx;
    const sources = Object.values(workspace.nodes).filter(n => n.kind === "source");
    const activeSrcId = sources.some(s => s.id === ui.supplyNodeId) ? ui.supplyNodeId : sources[0]?.id;
    ui.supplyNodeId = activeSrcId;
    const activeSrc = workspace.nodes[activeSrcId];
    const prodCurve = Object.values(workspace.curves).find(c => c.targetNodeId === activeSrcId && c.kind === "production");

    // A selected range offers a prefilled batch action. Keep the manual
    // creation button visible only when that contextual action is absent.
    const brush = ui.tsState?.brush;
    const rangeBatchActionVisible = Boolean(prodCurve && ui.tsState.curveId === prodCurve.id &&
      brush && brush.endDate > brush.startDate);
    mainEl.querySelector("[data-app-action='new-batch']")?.classList.toggle("hidden", rangeBatchActionVisible);

    const batches = Object.values(simulation.batchStates).filter(b => b.sourceNodeId === activeSrcId);
    const tIdx = simulation.todayIdx;

    const linkedBomIds = new Set(sources.map(s => s.bomFactoryId).filter(Boolean));
    const bomCandidates = (ctx.bomFactories || []).filter(bf => !linkedBomIds.has(bf.id));

    const sourceTiles = sources.map(src => {
      const pc = Object.values(workspace.curves).find(c => c.targetNodeId === src.id && c.kind === "production");
      const span = pc?.horizonDays || 30;
      const outNext = pc ? TS.integrateCurveByDates(pc, simulation.today, TS.addDaysToIso(simulation.today, span)) : 0;
      const snap = simulation.nodeDaily[src.id]?.[tIdx] || {};
      const isAct = src.id === activeSrcId;
      const isArchived = src.entityStatus === "archived";
      return `
        <button type="button" class="entity-tile ${isAct ? "active" : ""}" data-pick-supply="${src.id}">
          <div class="entity-tile-top">
            <strong>${esc(src.name)}</strong>
            ${isArchived ? `<span class="badge ochre">Archived</span>` : `<span class="badge subtle">${span}d</span>`}
          </div>
          <div class="entity-tile-metrics">
            <span>Available <b>${fmtNum(snap.endingAvailable)}</b></span>
            <span>Scheduled <b>${fmtNum(outNext)}</b></span>
          </div>
        </button>`;
    });

    const candidateTiles = bomCandidates.map(bf => `
      <button type="button" class="entity-tile is-bom-candidate" data-adopt-bom-factory="${esc(bf.id)}" title="Select this assembly factory for sales scheduling">
        <div class="entity-tile-top">
          <strong>${esc(bf.name)}</strong>
          <span class="badge accent">Select</span>
        </div>
        <div class="entity-tile-metrics">
          <span class="muted">${esc(bf.companyName || bf.location || "BOM Assembly Factory")}</span>
        </div>
      </button>`);

    const allFactoryTiles = [...sourceTiles, ...candidateTiles];
    mainEl.querySelector("[data-zone='supply-factories']").innerHTML = allFactoryTiles.length
      ? allFactoryTiles.join("")
      : `<div class="card" style="grid-column:1/-1"><div class="empty-card">No factories configured</div></div>`;

    mainEl.querySelector("[data-zone='supply-curve-head']").innerHTML = activeSrc ? `
      <h3>${esc(activeSrc.name)}${activeSrc.entityStatus === "archived" ? ' <span class="badge ochre">Archived</span>' : ""} · Production Curve</h3>
      <button type="button" class="text-btn" data-quick-stocktake="${esc(activeSrcId)}">Stocktake Inventory</button>`
      : `<h3>Production Curve</h3>`;

    if (prodCurve && !ctx.skipEditorRemount) {
      global.SC.TimeSeriesEditor.mountTimeSeriesEditor(mainEl.querySelector("[data-zone='supply-editor']"), {
        ...ctx.tsHooks,
        curveId: prodCurve.id,
        batches
      });
    } else if (!prodCurve) {
      mainEl.querySelector("[data-zone='supply-editor']").innerHTML = `<div class="empty-card">No curve data</div>`;
    }

    mainEl.querySelector("[data-zone='supply-batches']").innerHTML = `
      <div class="card-head">
        <h3>Production Batches</h3>
      </div>
      <div class="table-wrap">
        <table class="data-table">
          <thead><tr><th>Batch ID</th><th>Production Window</th><th>Wait</th><th>Available Date</th><th>Total Qty</th><th>Allocated</th><th>Remaining</th><th>Status</th><th>Action</th></tr></thead>
          <tbody>
            ${batches.length ? batches.map(b => {
              const allocPct = b.computedQty > 0 ? Math.round((b.allocatedShipmentQty / b.computedQty) * 1000) / 10 : 0;
              return `
              <tr class="clickable-row" data-open-target="batch:${esc(b.batchId)}">
                <td><strong>${esc(b.code)}</strong></td>
                <td>${esc(b.startDate)} ~ ${esc(b.endDate)}</td>
                <td>+${b.extraWaitDays}d</td>
                <td><b>${esc(b.availableDate)}</b></td>
                <td><b>${fmtNum(b.computedQty, 1)}</b></td>
                <td>${fmtNum(b.allocatedShipmentQty)}${b.allocatedShipmentQty > 0 ? ` <span class="muted small">(${allocPct}%)</span>` : ""}</td>
                <td>${fmtNum(b.remainingBatchQty)}</td>
                <td><span class="badge ${b.status === "confirmed" ? "fact" : "subtle"}">${b.status === "confirmed" ? "Completed" : "Planned"}</span></td>
                <td>
                  <button type="button" class="text-btn" data-quick-ship-batch="${b.batchId}" data-node-id="${b.sourceNodeId}" data-avail-date="${b.availableDate}" data-rem-qty="${b.remainingBatchQty}">Schedule Shipment</button>
                </td>
              </tr>`;
            }).join("") : `<tr><td colspan="9" class="muted" style="text-align:center;padding:22px">No batches yet</td></tr>`}
          </tbody>
        </table>
      </div>`;
  }

  /* =========================================================================
     PAGE C: 物流与清关（市场-工厂导航器 + 结构化增强发运列表）
     ========================================================================= */
  function mountLogisticsShell(mainEl) {
    mainEl.innerHTML = `
      <div class="page-scroll" data-scroll-container="logistics">
        <header class="page-header">
          <div class="page-header-copy">
            <h1 class="page-title">Logistics & Customs</h1>
          </div>
          <div class="page-header-controls">
            <button type="button" class="btn" data-app-action="open-lanes">Saved Lanes</button>
            <button type="button" class="btn" data-app-action="import-shipments-csv">Import CSV</button>
          </div>
        </header>

        <section class="card nav-card" data-zone="logi-nav"></section>

        <section class="card">
          <div class="logi-list-toolbar">
            <div class="search-input-wrap">
              <input type="search" class="logi-search" data-logi-search="1" placeholder="Search code, carrier, B/L, or port…">
            </div>
            <div class="filter-chips" data-zone="logi-status-chips"></div>
            <div class="adv-toggle-group" data-zone="logi-adv-toggle"></div>
          </div>

          <div class="adv-filter-panel hidden" data-zone="logi-adv-panel">
            <div class="adv-filter-row">
              <div class="adv-group">
                <span class="adv-label">Full-Cycle Elapsed</span>
                <div class="adv-presets">
                  <button type="button" class="span-pill" data-elapsed-preset="0,50">0–50%</button>
                  <button type="button" class="span-pill" data-elapsed-preset="50,70">50–70%</button>
                  <button type="button" class="span-pill" data-elapsed-preset="70,100">70–100%</button>
                </div>
                <input type="number" class="adv-num" min="0" max="100" placeholder="Min %" data-logi-adv="elapsedMin">
                <span class="muted">–</span>
                <input type="number" class="adv-num" min="0" max="100" placeholder="Max %" data-logi-adv="elapsedMax">
                <span class="muted small">%</span>
              </div>

              <div class="adv-group">
                <span class="adv-label">Key Milestone</span>
                <select class="adv-sel" data-logi-adv="milestoneField">
                  <option value="putaway">Putaway Complete</option>
                  <option value="sellable">Earliest Sellable</option>
                  <option value="border">Port Arrival</option>
                  <option value="customs">Customs Release</option>
                </select>
                <select class="adv-sel" data-logi-adv="dateOp">
                  <option value="on_or_before">On or Before</option>
                  <option value="before">Before</option>
                  <option value="on_or_after">On or After</option>
                  <option value="after">After</option>
                </select>
                <input type="date" class="adv-date" data-logi-adv="dateThreshold">
                <select class="adv-sel" data-logi-adv="dateSource">
                  <option value="any">Planned / Actual</option>
                  <option value="planned">Planned</option>
                  <option value="estimated">Projected ETA</option>
                  <option value="actual">Confirmed Actual Only</option>
                </select>
              </div>
            </div>
          </div>

          <div class="table-wrap" data-zone="logi-table"></div>
        </section>
      </div>`;
  }

  function updateLogisticsZones(mainEl, ctx) {
    const WM = getWM();
    const Sim = getSim();
    const PROG = global.SC.Inspector.PROGRESS_LABELS;
    const { workspace, simulation, ui } = ctx;
    const f = ui.logiFilter;

    // 1. Top Market -> Factory Navigator (zero crossing curves!)
    global.SC.CorridorMap.mountLogisticsNavigator(mainEl.querySelector("[data-zone='logi-nav']"), {
      workspace,
      simulation,
      selectedMarketId: f.marketId,
      selectedFactoryId: f.factoryId,
      onSelectMarket: mid => ctx.onUpdateLogiFilter({ marketId: mid, factoryId: null }),
      onSelectFactory: fid => ctx.onUpdateLogiFilter({ factoryId: fid }),
      onClearFilter: () => ctx.onUpdateLogiFilter({ marketId: null, factoryId: null })
    });

    // Keep persistent input values in sync without clobbering focus
    const syncVal = (sel, val) => {
      const el = mainEl.querySelector(sel);
      if (el && document.activeElement !== el && el.value !== String(val ?? "")) {
        el.value = String(val ?? "");
      }
    };
    syncVal("[data-logi-search]", f.query);
    syncVal("[data-logi-adv='elapsedMin']", f.elapsedMin);
    syncVal("[data-logi-adv='elapsedMax']", f.elapsedMax);
    syncVal("[data-logi-adv='milestoneField']", f.milestoneField);
    syncVal("[data-logi-adv='dateOp']", f.dateOp);
    syncVal("[data-logi-adv='dateThreshold']", f.dateThreshold);
    syncVal("[data-logi-adv='dateSource']", f.dateSource);

    // Toggle collapsible advanced panel
    const advPanel = mainEl.querySelector("[data-zone='logi-adv-panel']");
    advPanel?.classList.toggle("hidden", !f.advOpen);

    // Highlight active elapsed preset
    mainEl.querySelectorAll("[data-elapsed-preset]").forEach(btn => {
      const [lo, hi] = btn.dataset.elapsedPreset.split(",");
      btn.classList.toggle("active", String(f.elapsedMin) === lo && String(f.elapsedMax) === hi);
    });

    // Count active advanced filters & any filters
    const advCount = (f.elapsedMin !== "" || f.elapsedMax !== "" ? 1 : 0) + (f.dateThreshold ? 1 : 0);
    const hasAnyFilter = Boolean(f.marketId || f.factoryId || f.status !== "all" || f.query || advCount > 0);

    mainEl.querySelector("[data-zone='logi-adv-toggle']").innerHTML = `
      <button type="button" class="btn small ${f.advOpen || advCount > 0 ? "is-tinted" : ""}" data-toggle-adv="1">
        Filters${advCount > 0 ? ` (${advCount})` : ""}
      </button>
      ${hasAnyFilter ? `<button type="button" class="btn small ghost" data-reset-logi-filters="1">Clear All</button>` : ""}`;

    // Status filter chips (counts respect current market/factory selection)
    const chips = [
      { key: "all", label: "All" },
      { key: "in_transit", label: "In Transit" },
      { key: "customs", label: "Customs / Putaway" },
      { key: "overdue", label: "Pending Confirmation" },
      { key: "planned", label: "Planned" },
      { key: "dispatch_unconfirmed", label: "Dispatch Due" },
      { key: "blocked", label: "Blocked" },
      { key: "available", label: "Shelved" }
    ];

    mainEl.querySelector("[data-zone='logi-status-chips']").innerHTML = chips.map(ch => {
      const cnt = Sim.queryShipments(workspace, simulation, {
        ...f,
        status: ch.key
      }).length;
      return `<button type="button" class="filter-chip ${f.status === ch.key ? "active" : ""}" data-logi-status="${ch.key}">${ch.label} <span class="chip-count">${cnt}</span></button>`;
    }).join("");

    // Query shipments via unified structured query engine
    const rows = Sim.queryShipments(workspace, simulation, f);

    mainEl.querySelector("[data-zone='logi-table']").innerHTML = `
      <table class="data-table logi-table">
        <thead>
          <tr>
            <th style="width:102px">Code</th>
            <th>Factory → Market</th>
            <th style="width:76px">Qty</th>
            <th style="width:96px">Dispatch</th>
            <th style="width:118px">Mode / Transit</th>
            <th style="width:96px">Plan Progress</th>
            <th style="width:148px">Putaway / Sellable</th>
            <th style="width:112px">Status</th>
            <th style="width:82px">Cost</th>
            <th style="width:62px">Action</th>
          </tr>
        </thead>
        <tbody>
          ${rows.length ? rows.map(s => {
            const st = simulation.shipmentStates[s.id];
            const prog = PROG[st.operationalStatus] || PROG.planned;
            const from = workspace.nodes[s.fromNodeId];
            const to = workspace.nodes[s.toNodeId];
            const isSel = ui.panel?.kind === "shipment" && ui.panel.id === s.id;
            const putIsActual = Boolean(st.putawayCompleteActualDate);
            const putDate = st.effectivePutawayDate;
            const sellDate = st.effectiveSellableDate;
            const pctStr = st.fullCycleZeroSpan
              ? `${st.fullCycleElapsedPct}% (0d)`
              : `${st.fullCycleElapsedPct}%${st.fullCycleOverrun ? "+" : ""}`;
            return `
              <tr class="clickable-row ${isSel ? "is-selected-row" : ""}" data-open-target="shipment:${esc(s.id)}">
                <td><strong>${esc(s.code)}</strong></td>
                <td>
                  <div>${esc(from?.name || "")} → <strong>${esc(to?.name || "")}</strong></div>
                  <div class="muted small">${esc(s.carrier || "—")}${s.stopoverPorts?.length ? ` · Via ${esc(s.stopoverPorts.map(x => x.port).join("/"))}` : ""}</div>
                </td>
                <td><b>${fmtNum(s.qty)}</b></td>
                <td>${esc(st.departDate)}</td>
                <td>${esc(WM.modeLabel(s.mode))} · <b>${s.transitDays}d</b></td>
                <td>
                  <div class="pct-cell">
                    <span>${esc(pctStr)}</span>
                    <div class="pct-bar"><i style="width:${st.fullCycleElapsedPct}%"></i></div>
                  </div>
                </td>
                <td class="small">
                  <div>Put ${esc(putDate.slice(5))} <span class="dt-tag ${putIsActual ? "is-actual" : ""}">${putIsActual ? "Act" : "Est"}</span></div>
                  <div>Sell ${esc(sellDate.slice(5))} <span class="dt-tag ${putIsActual ? "is-actual" : ""}">${putIsActual ? "Act" : "Est"}</span></div>
                </td>
                <td><span class="badge ${prog.cls}">${esc(prog.label)}</span></td>
                <td>${fmtMoney(st.totalCost)}</td>
                <td><button type="button" class="text-btn" data-dup-shipment="${esc(s.id)}">Clone</button></td>
              </tr>`;
          }).join("") : `<tr><td colspan="10" class="muted" style="text-align:center;padding:26px">No matching shipments</td></tr>`}
        </tbody>
      </table>`;
  }

  /* =========================================================================
     PAGE D: 市场与需求
     ========================================================================= */
  function mountMarketShell(mainEl) {
    mainEl.innerHTML = `
      <div class="page-scroll" data-scroll-container="market">
        <header class="page-header">
          <div class="page-header-copy">
            <h1 class="page-title">Markets & Demand</h1>
          </div>
          <div class="page-header-controls">
            <button type="button" class="btn" data-app-action="add-market">+ Add Market</button>
            <button type="button" class="btn primary" data-app-action="edit-active-market">Market Settings</button>
          </div>
        </header>
        <section class="entity-strip" data-zone="market-cards"></section>
        <section class="market-kpi-strip" data-zone="market-kpis"></section>
        <section class="card">
          <div class="card-head" data-zone="market-curve-head"></div>
          <div data-zone="market-editor"></div>
        </section>
        <section class="two-col-grid">
          <div class="card" data-zone="market-trend"></div>
          <div class="card" data-zone="market-risk"></div>
        </section>
      </div>`;
  }

  function updateMarketZones(mainEl, ctx) {
    const { workspace, simulation, ui } = ctx;
    const markets = Object.values(workspace.nodes)
      .filter(n => n.kind === "market")
      .sort((a, b) => (a.marketPolicy?.priority || 9) - (b.marketPolicy?.priority || 9));
    const activeMktId = markets.some(m => m.id === ui.marketNodeId) ? ui.marketNodeId : markets[0]?.id;
    ui.marketNodeId = activeMktId;
    const activeMkt = workspace.nodes[activeMktId];
    const sum = simulation.marketSummaries[activeMktId];
    const demCurve = Object.values(workspace.curves).find(c => c.targetNodeId === activeMktId && c.kind === "demand");

    mainEl.querySelector("[data-zone='market-cards']").innerHTML = markets.length ? markets.map(m => {
      const ms = simulation.marketSummaries[m.id];
      const isAct = m.id === activeMktId;
      return `
        <button type="button" class="entity-tile ${isAct ? "active" : ""} ${ms?.firstGapDate ? "is-risk" : ""}" data-pick-market="${m.id}">
          <div class="entity-tile-top">
            <strong>${esc(m.name)}</strong>
            <span class="badge ${ms?.firstGapDate ? "danger" : "accent"}">${ms?.firstGapDate ? `Gap ${ms.firstGapDate.slice(5)}` : "Healthy"}</span>
          </div>
          <div class="entity-tile-metrics">
            <span>Sellable <b>${fmtNum(ms?.currentAvailable)}</b></span>
            <span>Cover <b>${ms?.daysOfCoverNow}d</b> · <b>${fmtPct(ms?.demandSatisfactionRate)}</b></span>
          </div>
        </button>`;
    }).join("") : `<div class="card" style="grid-column:1/-1"><div class="empty-card"><button type="button" class="btn primary small" data-app-action="add-market">+ Add Market</button></div></div>`;

    mainEl.querySelector("[data-zone='market-kpis']").innerHTML = sum ? `
      <div class="mini-stat"><span>Sellable Today</span><strong>${fmtNum(sum.currentAvailable)}</strong></div>
      <div class="mini-stat"><span>${workspace.viewHorizonDays}d Forecast Demand</span><strong>${fmtNum(sum.totalDemand)}</strong></div>
      <div class="mini-stat"><span>Forecast Fill Rate</span><strong>${fmtPct(sum.demandSatisfactionRate)}</strong></div>
      <div class="mini-stat"><span>Projected Demand Gap</span><strong class="${sum.totalDemandGap > 0 ? "text-danger" : ""}">${fmtNum(sum.totalDemandGap)}</strong></div>
      <div class="mini-stat"><span>Expected Replenishment</span><strong>${fmtNum(sum.incomingQty, 2)}</strong></div>` : "";

    mainEl.querySelector("[data-zone='market-curve-head']").innerHTML = `
      <h3>${activeMkt ? `${esc(activeMkt.name)} · Demand Forecast Curve` : "Demand Forecast Curve"}</h3>`;

    if (demCurve && !ctx.skipEditorRemount) {
      global.SC.TimeSeriesEditor.mountTimeSeriesEditor(mainEl.querySelector("[data-zone='market-editor']"), {
        ...ctx.tsHooks,
        curveId: demCurve.id,
        batches: []
      });
    } else if (!demCurve) {
      mainEl.querySelector("[data-zone='market-editor']").innerHTML = `<div class="empty-card">No curve data</div>`;
    }

    mainEl.querySelector("[data-zone='market-trend']").innerHTML = `
      <div class="card-head"><h3>Sellable Inventory & Projected Gap</h3></div>
      ${activeMktId ? renderTrendChartSvg(workspace, simulation, [activeMktId], {
        height: 210,
        singleMarketId: activeMktId,
        showGap: true
      }) : `<div class="empty-card">No data available</div>`}`;

    const incomingShps = activeMktId ? getSim().listReplenishments(simulation.shipmentStates, simulation.today, simulation.viewEndDate, { marketId: activeMktId }) : [];
    const PROG = global.SC.Inspector.PROGRESS_LABELS;

    mainEl.querySelector("[data-zone='market-risk']").innerHTML = `
      <div class="card-head">
        <h3>Projected Gaps & Replenishment</h3>
        ${activeMktId ? `<button type="button" class="text-btn" data-app-action="new-shipment-to-market" data-market-id="${esc(activeMktId)}">+ Replenish</button>` : ""}
      </div>
      ${!activeMktId ? `<div class="empty-card">No data available</div>` : `
      ${sum?.gapWindows?.length ? `
        <div class="risk-win-list">
          ${sum.gapWindows.map(w => `
            <div class="risk-win-item">
              <strong>${esc(w.startDate)} ~ ${esc(w.endDate)}</strong>
              <span>Peak Shortfall ${fmtNum(w.peakShortfall)} · Total <b class="text-danger">${fmtNum(w.gapQty)}</b></span>
            </div>`).join("")}
        </div>` : `<div class="muted small" style="margin-bottom:12px">No projected demand gaps</div>`}

      <div class="event-feed">
        ${incomingShps.length ? incomingShps.slice(0, 4).map(st => `
          <button type="button" class="event-row" data-open-target="shipment:${esc(st.shipmentId)}">
            <span class="event-dot ${st.operationalOverdue ? "warn" : "info"}"></span>
            <div class="event-copy">
              <strong>${esc(st.code)} · ${fmtNum(st.qty)}</strong>
              <span class="muted small">Putaway ${esc(st.effectivePutawayDate)} · Sellable ${esc(st.effectiveSellableDate)}${st.operationalOverdue ? " · Pending" : ""}</span>
            </div>
            <span class="event-date">${esc(st.inventoryBucket === "shelvedPendingNextDay" ? "Next-Day Sellable" : PROG[st.operationalStatus].label)}</span>
          </button>`).join("") : `<div class="muted small">No incoming replenishments</div>`}
      </div>`}`;
  }

  function renderView(mainEl, viewName, ctx, forceRebuild) {
    const needMount = forceRebuild || mainEl.dataset.mountedView !== viewName;
    if (needMount) {
      mainEl.dataset.mountedView = viewName;
      if (viewName === "dashboard") mountDashboardShell(mainEl);
      else if (viewName === "supply") mountSupplyShell(mainEl);
      else if (viewName === "logistics") mountLogisticsShell(mainEl);
      else if (viewName === "market") mountMarketShell(mainEl);
    }

    if (viewName === "dashboard") updateDashboardZones(mainEl, ctx);
    else if (viewName === "supply") updateSupplyZones(mainEl, ctx);
    else if (viewName === "logistics") updateLogisticsZones(mainEl, ctx);
    else if (viewName === "market") updateMarketZones(mainEl, ctx);
  }

  global.SC = global.SC || {};
  global.SC.Views = { renderView };
})(typeof globalThis !== "undefined" ? globalThis : this);
