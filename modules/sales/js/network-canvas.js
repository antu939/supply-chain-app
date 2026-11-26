(function (global) {
  "use strict";

  const esc = t => String(t ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const fmtNum = n => Number(n || 0).toLocaleString("en-US", { maximumFractionDigits: 0 });

  /**
   * 物流页面顶部导航器（V0.3）
   * - 取消全量交叉曲线与线中数量胶囊，彻底解决多工厂/多市场时的遮挡与点击困难
   * - 以「目标市场 → 关联生产工厂」为核心定位与筛选交互，支持任意规模列表滚动，一键清除恢复全部
   */
  function mountLogisticsNavigator(container, ctx) {
    if (!container) return;
    const {
      workspace,
      simulation,
      selectedMarketId,
      selectedFactoryId,
      onSelectMarket,
      onSelectFactory,
      onClearFilter
    } = ctx;

    const factories = Object.values(workspace.nodes).filter(n => n.kind === "source");
    const markets = Object.values(workspace.nodes)
      .filter(n => n.kind === "market")
      .sort((a, b) => (a.marketPolicy?.priority || 9) - (b.marketPolicy?.priority || 9));

    const activeShipments = Object.values(workspace.shipments).filter(s => s.status !== "cancelled");
    const corridors = Object.values(simulation.corridors || {});

    function accumulateCorridors(rows) {
      return rows.reduce((totals, row) => ({
        count: totals.count + row.activeCount,
        overdue: totals.overdue + row.overdueCount,
        inTransitQty: totals.inTransitQty + row.inTransitQty,
        customsCount: totals.customsCount + row.customsCount,
        customsQty: totals.customsQty + row.customsQty
      }), { count: 0, overdue: 0, inTransitQty: 0, customsCount: 0, customsQty: 0 });
    }

    // Build right-pane factory list:
    // If a market is selected, show factories linked to that market (via active shipments or lane templates).
    // Otherwise, show all factories so user can filter from either side.
    const linkedFactoryIds = selectedMarketId
      ? new Set(corridors.filter(c => c.toNodeId === selectedMarketId).map(c => c.fromNodeId))
      : new Set(factories.map(f => f.id));

    const visibleFactories = factories.filter(f => linkedFactoryIds.has(f.id));
    const hasFilter = Boolean(selectedMarketId || selectedFactoryId);

    const marketItemsHtml = markets.map(m => {
      const st = accumulateCorridors(corridors.filter(c => c.toNodeId === m.id
        && (!selectedFactoryId || c.fromNodeId === selectedFactoryId)));
      const sum = simulation.marketSummaries[m.id];
      const isSel = selectedMarketId === m.id;
      const hasRisk = Boolean(sum?.firstGapDate);
      return `
        <button type="button" class="nav-entity-row ${isSel ? "is-selected" : ""}" data-nav-market="${esc(m.id)}">
          <div class="nav-entity-main">
            <span class="nav-dot ${st.overdue > 0 ? "warn" : hasRisk ? "danger" : "ok"}"></span>
            <strong>${esc(m.name)}</strong>
            <span class="nav-code">${esc(m.region)}</span>
          </div>
          <div class="nav-entity-meta">
            <span>${st.count} ${st.count === 1 ? "shipment" : "shipments"}</span>
            ${st.overdue > 0 ? `<span class="badge ochre">${st.overdue} Pending</span>` : st.customsCount > 0 ? `<span class="badge blue">${st.customsCount} Customs / Putaway</span>` : ""}
          </div>
        </button>`;
    }).join("");

    const factoryItemsHtml = visibleFactories.length
      ? visibleFactories.map(f => {
          const isSel = selectedFactoryId === f.id;
          const cor = selectedMarketId ? simulation.corridors[`${f.id}__${selectedMarketId}`] : null;
          const { count, overdue, inTransitQty, customsQty } = accumulateCorridors(corridors
            .filter(c => c.fromNodeId === f.id && (!selectedMarketId || c.toNodeId === selectedMarketId)));
          const targetLabel = selectedMarketId ? ` → ${workspace.nodes[selectedMarketId]?.name || ""}` : "";

          return `
            <button type="button" class="nav-entity-row ${isSel ? "is-selected" : ""}" data-nav-factory="${esc(f.id)}">
              <div class="nav-entity-main">
                <span class="nav-dot ${overdue > 0 ? "warn" : "ok"}"></span>
                <strong>${esc(f.name)}<span class="nav-arrow-target">${esc(targetLabel)}</span></strong>
              </div>
              <div class="nav-entity-meta">
                <span>${count} ${count === 1 ? "shipment" : "shipments"}</span>
                ${inTransitQty > 0 ? `<span class="muted small">In Transit ${fmtNum(inTransitQty)}</span>` : ""}
                ${customsQty > 0 ? `<span class="muted small">Customs / Putaway ${fmtNum(customsQty)}</span>` : ""}
                ${overdue > 0 ? `<span class="badge ochre">${overdue} Pending</span>` : ""}
                ${cor && cor.laneIds.length && count === 0 ? `<span class="badge subtle">Frequent Lane</span>` : ""}
              </div>
            </button>`;
        }).join("")
      : `<div class="nav-empty">No linked factories</div>`;

    const scopeParts = [];
    if (selectedMarketId) scopeParts.push(workspace.nodes[selectedMarketId]?.name || selectedMarketId);
    if (selectedFactoryId) scopeParts.push(workspace.nodes[selectedFactoryId]?.name || selectedFactoryId);

    container.innerHTML = `
      <div class="logi-nav-shell">
        <div class="logi-nav-top">
          <div class="logi-nav-scope">
            <span class="eyebrow" style="display:inline">Scope Filter</span>
            <span class="scope-text">${scopeParts.length ? esc(scopeParts.join(" · ")) : `All Markets & Factories (${activeShipments.length} ${activeShipments.length === 1 ? "shipment" : "shipments"})`}</span>
          </div>
          ${hasFilter ? `<button type="button" class="btn small ghost" data-nav-clear="1">Clear Filter</button>` : ""}
        </div>

        <div class="logi-nav-columns">
          <div class="logi-nav-col">
            <div class="logi-nav-col-head">
              <span>Target Markets (${markets.length})</span>
              ${selectedMarketId ? `<button type="button" class="text-btn" data-nav-market="">All</button>` : ""}
            </div>
            <div class="logi-nav-list">${marketItemsHtml}</div>
          </div>

          <div class="logi-nav-col">
            <div class="logi-nav-col-head">
              <span>${selectedMarketId ? `Linked Factories (${visibleFactories.length})` : `Factories (${visibleFactories.length})`}</span>
              ${selectedFactoryId ? `<button type="button" class="text-btn" data-nav-factory="">All</button>` : ""}
            </div>
            <div class="logi-nav-list">${factoryItemsHtml}</div>
          </div>
        </div>
      </div>
    `;

    container.querySelectorAll("[data-nav-market]").forEach(btn => {
      btn.addEventListener("click", () => {
        const mid = btn.dataset.navMarket || null;
        onSelectMarket && onSelectMarket(selectedMarketId === mid ? null : mid);
      });
    });
    container.querySelectorAll("[data-nav-factory]").forEach(btn => {
      btn.addEventListener("click", () => {
        const fid = btn.dataset.navFactory || null;
        onSelectFactory && onSelectFactory(selectedFactoryId === fid ? null : fid);
      });
    });
    container.querySelector("[data-nav-clear]")?.addEventListener("click", () => {
      onClearFilter && onClearFilter();
    });
  }

  global.SC = global.SC || {};
  global.SC.CorridorMap = { mountLogisticsNavigator };
})(typeof globalThis !== "undefined" ? globalThis : this);
