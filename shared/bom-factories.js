(function (global) {
  "use strict";

  const BOM_STORAGE_KEY = "bom-flow-sim-v5";

  /**
   * Read-only extraction of final assembly factories from BOM state.
   * Rules:
   * 1. If BOM diagrams have companies assigned to finished-product root nodes,
   *    only return active factories belonging to those final-assembly companies
   *    (plus any explicitly flagged final-assembly factories/companies).
   *    Upstream component suppliers and their factories are excluded.
   * 2. If no BOM diagram exists yet (or no root company is assigned yet),
   *    return active factories whose company is not strictly an upstream-only supplier.
   */
  function extractFinalAssemblyFactories(bomRaw) {
    if (!bomRaw || typeof bomRaw !== "object") return [];
    const companies = bomRaw.companies && typeof bomRaw.companies === "object" ? bomRaw.companies : {};
    const factories = bomRaw.factories && typeof bomRaw.factories === "object" ? bomRaw.factories : {};
    const diagrams = Array.isArray(bomRaw.diagrams) ? bomRaw.diagrams : [];
    const nodes = bomRaw.nodes && typeof bomRaw.nodes === "object" ? bomRaw.nodes : {};
    const relationships = bomRaw.relationships && typeof bomRaw.relationships === "object" ? bomRaw.relationships : {};

    const rootCompanyIds = new Set();
    for (const d of diagrams) {
      const root = d && nodes[d.rootNodeId];
      if (!root || !Array.isArray(root.companyIds)) continue;
      for (const cid of root.companyIds) {
        if (companies[cid]) rootCompanyIds.add(cid);
      }
    }

    const upstreamOnlyCompanyIds = new Set();
    if (rootCompanyIds.size === 0 && diagrams.length > 0) {
      const supplierIds = new Set();
      const receiverIds = new Set();
      for (const rows of Object.values(relationships)) {
        if (!rows || typeof rows !== "object") continue;
        for (const [down, ups] of Object.entries(rows)) {
          receiverIds.add(down);
          if (Array.isArray(ups)) {
            for (const up of ups) supplierIds.add(up);
          }
        }
      }
      for (const cid of supplierIds) {
        if (!receiverIds.has(cid)) upstreamOnlyCompanyIds.add(cid);
      }
    }

    const result = [];
    for (const fac of Object.values(factories)) {
      if (!fac || typeof fac !== "object") continue;
      const name = String(fac.name || "").trim();
      if (!name || fac.status === "archived") continue;
      const comp = companies[fac.companyId] || null;
      if (comp && comp.status === "archived") continue;

      const explicitFinal = Boolean(fac.isFinalAssembly || comp?.isFinalAssembler);
      if (rootCompanyIds.size > 0) {
        if (!rootCompanyIds.has(fac.companyId) && !explicitFinal) continue;
      } else if (upstreamOnlyCompanyIds.has(fac.companyId) && !explicitFinal) {
        continue;
      }

      result.push({
        id: String(fac.id),
        companyId: fac.companyId ? String(fac.companyId) : null,
        companyName: comp?.name ? String(comp.name) : "",
        name,
        location: String(fac.location || "").trim(),
        note: String(fac.note || "").trim()
      });
    }

    result.sort((a, b) =>
      a.companyName.localeCompare(b.companyName, "zh-CN") ||
      a.name.localeCompare(b.name, "zh-CN")
    );
    return result;
  }

  function extractAllFactoriesMap(bomRaw) {
    const out = {};
    if (!bomRaw || typeof bomRaw !== "object") return out;
    const companies = bomRaw.companies && typeof bomRaw.companies === "object" ? bomRaw.companies : {};
    const factories = bomRaw.factories && typeof bomRaw.factories === "object" ? bomRaw.factories : {};
    for (const fac of Object.values(factories)) {
      if (!fac || typeof fac !== "object" || !fac.id) continue;
      const comp = companies[fac.companyId] || null;
      const isArchived = fac.status === "archived" || (comp && comp.status === "archived");
      out[String(fac.id)] = {
        id: String(fac.id),
        companyId: fac.companyId ? String(fac.companyId) : null,
        companyName: comp?.name ? String(comp.name) : "",
        name: String(fac.name || "").trim(),
        location: String(fac.location || "").trim(),
        note: String(fac.note || "").trim(),
        status: isArchived ? "archived" : "active"
      };
    }
    return out;
  }

  function inspectFactoryUsageInSales(bomFactoryId, salesRaw) {
    const empty = {
      hasSalesHistory: false,
      canHardDelete: true,
      linkedNodeIds: [],
      batchCount: 0,
      shipmentCount: 0,
      laneCount: 0,
      factCount: 0,
      summary: ""
    };
    if (!bomFactoryId || !salesRaw || typeof salesRaw !== "object") return empty;
    if (salesRaw.dataSourceMode === "demo") return empty;
    const nodes = salesRaw.nodes && typeof salesRaw.nodes === "object" ? salesRaw.nodes : {};
    const targetFid = String(bomFactoryId);
    const linkedNodeIds = Object.values(nodes)
      .filter(n => n && n.kind === "source" && String(n.bomFactoryId || "") === targetFid)
      .map(n => String(n.id));
    if (!linkedNodeIds.length) return empty;

    const nodeSet = new Set(linkedNodeIds);
    const batchIds = new Set();
    for (const b of Object.values(salesRaw.batches || {})) {
      if (b && nodeSet.has(String(b.sourceNodeId || ""))) batchIds.add(String(b.id));
    }
    const shipmentIds = new Set();
    for (const s of Object.values(salesRaw.shipments || {})) {
      if (s && nodeSet.has(String(s.fromNodeId || ""))) shipmentIds.add(String(s.id));
    }
    let laneCount = 0;
    for (const l of Object.values(salesRaw.lanes || {})) {
      if (l && nodeSet.has(String(l.fromNodeId || ""))) laneCount += 1;
    }
    let factCount = 0;
    for (const f of (Array.isArray(salesRaw.facts) ? salesRaw.facts : [])) {
      if (!f) continue;
      const tid = String(f.targetId || "");
      if (nodeSet.has(tid) || batchIds.has(tid) || shipmentIds.has(tid)) factCount += 1;
    }

    const parts = [];
    parts.push(`${linkedNodeIds.length} 座已关联销售工厂`);
    if (batchIds.size > 0) parts.push(`${batchIds.size} 个生产批次`);
    if (shipmentIds.size > 0) parts.push(`${shipmentIds.size} 笔发运单`);
    if (laneCount > 0) parts.push(`${laneCount} 条常用方案`);
    if (factCount > 0) parts.push(`${factCount} 条已确认事实`);

    return {
      hasSalesHistory: true,
      canHardDelete: false,
      linkedNodeIds,
      batchCount: batchIds.size,
      shipmentCount: shipmentIds.size,
      laneCount,
      factCount,
      summary: parts.join("、")
    };
  }

  function readFromStorage(customStorage) {
    const store = customStorage || (typeof localStorage !== "undefined" ? localStorage : null);
    if (!store) return [];
    try {
      const raw = store.getItem(BOM_STORAGE_KEY);
      if (!raw) return [];
      return extractFinalAssemblyFactories(JSON.parse(raw));
    } catch (_) {
      return [];
    }
  }

  const SCBomFactories = Object.freeze({
    BOM_STORAGE_KEY,
    extractFinalAssemblyFactories,
    extractAllFactoriesMap,
    inspectFactoryUsageInSales,
    readFromStorage
  });

  global.SCBomFactories = SCBomFactories;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = SCBomFactories;
  }
})(typeof window !== "undefined" ? window : globalThis);
