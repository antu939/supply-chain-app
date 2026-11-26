(function (global) {
  "use strict";

  const STORAGE_KEYS = Object.freeze({
    BOM: "bom-flow-sim-v5",
    BOM_LEGACY: "bom-flow-user-work-v1",
    SALES: "sc-sales-world-v2",
    SALES_LEGACY: "sc-sales-world-v1",
    RECENT_UI: "sc-app-recent-v1"
  });

  const isRecord = value => value !== null && typeof value === "object" && !Array.isArray(value);
  function getStorage(customStorage) {
    try { return customStorage || (typeof localStorage !== "undefined" ? localStorage : null); }
    catch (_) { return null; }
  }

  function readJsonSafely(store, key) {
    try {
      const raw = store.getItem(key);
      if (raw === null) return { exists: false, data: null, error: false };
      const data = JSON.parse(raw);
      return { exists: true, data: isRecord(data) ? data : null, error: !isRecord(data) };
    } catch (_) {
      return { exists: true, data: null, error: true };
    }
  }

  function inspectBom(store) {
    const res = readJsonSafely(store, STORAGE_KEYS.BOM);
    const empty = {
      exists: res.exists,
      parseError: res.error,
      diagramCount: 0,
      companyCount: 0,
      factoryCount: 0,
      linkCount: 0,
      severeCount: 0,
      riskCount: 0,
      blockedMarketCount: 0,
      diagrams: [],
      companies: []
    };
    if (!res.data || typeof res.data !== "object") return empty;

    const d = res.data;
    const diagrams = Array.isArray(d.diagrams) ? d.diagrams : [];
    const nodes = d.nodes && typeof d.nodes === "object" ? d.nodes : {};
    const materials = d.materials && typeof d.materials === "object" ? d.materials : {};
    const companiesObj = d.companies && typeof d.companies === "object" ? d.companies : {};
    const factoriesObj = d.factories && typeof d.factories === "object" ? d.factories : {};
    const rels = d.relationships && typeof d.relationships === "object" ? d.relationships : {};

    const companies = Object.values(companiesObj);
    const factories = Object.values(factoriesObj);
    if (diagrams.some(d => !isRecord(d)) || companies.some(c => !isRecord(c)) || factories.some(f => !isRecord(f))) {
      return { ...empty, parseError: true };
    }

    let linkCount = 0;
    for (const rows of Object.values(rels)) {
      if (!rows || typeof rows !== "object") continue;
      for (const ups of Object.values(rows)) {
        if (Array.isArray(ups)) linkCount += ups.length;
      }
    }

    let severeCount = 0;
    let riskCount = 0;
    for (const c of companies) {
      const st = c?.compliance?.status;
      if (st === "severe") severeCount++;
      else if (st === "risk") riskCount++;
    }

    let blockedMarketCount = 0;
    const diagramSummaries = diagrams.map(diag => {
      const rootNode = nodes[diag.rootNodeId];
      const mat = rootNode ? materials[rootNode.materialId] : null;
      const nodeCount = Object.values(nodes).filter(n => n && n.diagramId === diag.id).length;
      const assessments = diag.assessments && typeof diag.assessments === "object" ? diag.assessments : {};
      for (const byMarket of Object.values(assessments)) {
        if (!byMarket || typeof byMarket !== "object") continue;
        for (const rec of Object.values(byMarket)) {
          if (rec && rec.status === "blocked") blockedMarketCount++;
        }
      }
      return {
        id: diag.id,
        name: mat?.name || "Untitled Product",
        code: mat?.code || "",
        nodeCount
      };
    });

    const companySummaries = companies.map(c => ({
      id: c.id,
      name: c.name || "Untitled Company",
      location: c.location || "",
      compliance: c?.compliance?.status || "unverified"
    }));

    return {
      exists: res.exists,
      parseError: false,
      diagramCount: diagrams.length,
      companyCount: companies.length,
      factoryCount: factories.length,
      linkCount,
      severeCount,
      riskCount,
      blockedMarketCount,
      diagrams: diagramSummaries,
      companies: companySummaries
    };
  }

  function inspectSales(store) {
    let res = readJsonSafely(store, STORAGE_KEYS.SALES);
    let fromLegacy = false;
    if (!res.exists) {
      const legacy = readJsonSafely(store, STORAGE_KEYS.SALES_LEGACY);
      if (legacy.exists) {
        res = legacy;
        fromLegacy = true;
      }
    }

    const empty = {
      exists: res.exists,
      fromLegacy,
      parseError: res.error,
      factoryCount: 0,
      marketCount: 0,
      productCount: 0,
      batchCount: 0,
      activeShipmentCount: 0,
      overduePlannedCount: 0,
      customsHoldCount: 0,
      asOfDate: null,
      kpis: null,
      activeProductName: "",
      activeProductSku: "",
      markets: [],
      shipments: []
    };
    if (!res.data || typeof res.data !== "object") return empty;

    let ws = res.data;
    let simulation = null;
    try {
      const WM = global.SC?.WorldModel || (typeof require === "function" ? require("../modules/sales/js/world-model.js") : null);
      const Sim = global.SC?.SimEngine || (typeof require === "function" ? require("../modules/sales/js/sim-engine.js") : null);
      if (WM && Sim) {
        ws = WM.validateWorkspace(ws);
        simulation = Sim.simulateWorkspace(ws);
      }
    } catch (_) {
      // Preserve the original data and surface the validation failure.
      empty.parseError = true;
    }
    const nodes = Object.values(ws.nodes && typeof ws.nodes === "object" ? ws.nodes : {});
    const products = Object.values(ws.products && typeof ws.products === "object" ? ws.products : {});
    const batches = Object.values(ws.batches && typeof ws.batches === "object" ? ws.batches : {});
    const shipments = Object.values(ws.shipments && typeof ws.shipments === "object" ? ws.shipments : {});

    const factories = nodes.filter(n => n && n.kind === "source");
    const markets = nodes.filter(n => n && n.kind === "market");
    const activeShipments = shipments.filter(s => s && s.status !== "cancelled");

    const activeProd = (ws.activeProductId && ws.products?.[ws.activeProductId]) || products[0] || null;

    return {
      exists: res.exists,
      fromLegacy,
      parseError: empty.parseError,
      factoryCount: factories.length,
      marketCount: markets.length,
      productCount: products.length,
      batchCount: batches.length,
      activeShipmentCount: activeShipments.length,
      overduePlannedCount: simulation?.shipmentCounts.overduePlannedCount ?? 0,
      customsHoldCount: simulation?.shipmentCounts.customsHoldCount ?? 0,
      asOfDate: simulation?.today ?? null,
      kpis: simulation?.kpis ?? null,
      activeProductName: activeProd?.name || "",
      activeProductSku: activeProd?.skuCode || "",
      markets: markets.map(m => ({ id: m.id, name: m.name || "Untitled Market", region: m.region || "" })),
      shipments: activeShipments.slice(0, 6).map(s => ({
        id: s.id,
        code: s.code || s.id,
        departDate: simulation?.shipmentStates[s.id]?.departDate || s.milestones?.departActualDate || s.departDate || "",
        qty: Number(s.qty) || 0
      }))
    };
  }

  function buildReminders(bom, sales) {
    const items = [];

    if (bom.parseError) {
      items.push({
        severity: "danger",
        title: "BOM local storage read error",
        detail: "Existing data preserved; check or export backup.",
        route: "bom"
      });
    }
    if (sales.parseError) {
      items.push({
        severity: "danger",
        title: "Sales local storage read error",
        detail: "Existing data preserved; check data integrity.",
        route: "sales"
      });
    }
    if (bom.severeCount > 0) {
      items.push({
        severity: "danger",
        title: `${bom.severeCount} ${bom.severeCount === 1 ? "company" : "companies"} with severe compliance issues`,
        detail: "Review entities and upstream links in Companies.",
        route: "bom",
        message: { type: "sc:navigate", payload: { view: "subjects" } }
      });
    }
    if (bom.blockedMarketCount > 0) {
      items.push({
        severity: "danger",
        title: `${bom.blockedMarketCount} blocked market access ${bom.blockedMarketCount === 1 ? "assessment" : "assessments"}`,
        detail: "Review evidence and clearance requirements in Market Access.",
        route: "bom",
        message: { type: "sc:navigate", payload: { view: "risk" } }
      });
    }
    if (sales.overduePlannedCount > 0) {
      items.push({
        severity: "warn",
        title: `${sales.overduePlannedCount} planned ${sales.overduePlannedCount === 1 ? "shipment" : "shipments"} past departure date`,
        detail: "Confirm actual dispatch or update schedule in Logistics.",
        route: "sales",
        message: { type: "sc:navigate", payload: { view: "logistics" } }
      });
    }
    if (sales.customsHoldCount > 0) {
      items.push({
        severity: "warn",
        title: `${sales.customsHoldCount} ${sales.customsHoldCount === 1 ? "shipment" : "shipments"} awaiting customs release`,
        detail: "Track release milestones in Logistics & Customs.",
        route: "sales",
        message: { type: "sc:navigate", payload: { view: "logistics" } }
      });
    }
    if (bom.riskCount > 0) {
      items.push({
        severity: "warn",
        title: `${bom.riskCount} ${bom.riskCount === 1 ? "company" : "companies"} flagged at compliance risk`,
        detail: "Review or update compliance evidence.",
        route: "bom",
        message: { type: "sc:navigate", payload: { view: "subjects" } }
      });
    }
    if (bom.companyCount > 0 && bom.factoryCount === 0) {
      items.push({
        severity: "info",
        title: "No production plants registered",
        detail: "Add assembly or supplier plants in Companies.",
        route: "bom",
        message: { type: "sc:navigate", payload: { view: "subjects" } }
      });
    }
    if (sales.factoryCount > 0 && sales.marketCount === 0) {
      items.push({
        severity: "info",
        title: "No target markets configured",
        detail: "Add target markets to forecast inventory coverage.",
        route: "sales",
        message: { type: "sc:navigate", payload: { view: "market" } }
      });
    }

    return items.slice(0, 5);
  }

  function buildFallbackRecent(bom, sales) {
    const list = [];
    for (const d of bom.diagrams.slice(0, 2)) {
      list.push({
        kind: "diagram",
        id: d.id,
        name: d.name,
        meta: `Product BOM · ${d.nodeCount} nodes`,
        route: "bom"
      });
    }
    for (const c of bom.companies.slice(0, 2)) {
      list.push({
        kind: "company",
        id: c.id,
        name: c.name,
        meta: c.location ? `Company · ${c.location}` : "Company",
        route: "bom"
      });
    }
    for (const s of sales.shipments.slice(0, 2)) {
      list.push({
        kind: "shipment",
        id: s.id,
        name: s.code,
        meta: s.departDate ? `Shipment · ${s.departDate}` : "Shipment",
        route: "sales"
      });
    }
    for (const m of sales.markets.slice(0, 2)) {
      list.push({
        kind: "market",
        id: m.id,
        name: m.name,
        meta: m.region ? `Target Market · ${m.region}` : "Target Market",
        route: "sales"
      });
    }
    return list.slice(0, 5);
  }

  function readBusinessSnapshot(customStorage) {
    const store = getStorage(customStorage);
    if (!store) {
      return {
        hasRealData: false,
        storageAvailable: false,
        bom: inspectBom({ getItem: () => null }),
        sales: inspectSales({ getItem: () => null }),
        reminders: [],
        fallbackRecent: []
      };
    }

    const bom = inspectBom(store);
    const sales = inspectSales(store);
    const hasBomRecords = bom.diagramCount > 0 || bom.companyCount > 0 || bom.factoryCount > 0;
    const hasSalesRecords = sales.factoryCount > 0 || sales.marketCount > 0 || sales.productCount > 0 || sales.batchCount > 0 || sales.activeShipmentCount > 0;
    const hasRealData = hasBomRecords || hasSalesRecords || bom.parseError || sales.parseError;

    return {
      hasRealData,
      storageAvailable: true,
      bom,
      sales,
      reminders: buildReminders(bom, sales),
      fallbackRecent: buildFallbackRecent(bom, sales)
    };
  }

  function loadRecentWork(customStorage) {
    const store = getStorage(customStorage);
    if (!store) return [];
    try {
      const raw = store.getItem(STORAGE_KEYS.RECENT_UI);
      if (!raw) return [];
      const list = JSON.parse(raw);
      return Array.isArray(list) ? list.filter(x => x && x.kind && x.id && x.name).slice(0, 6) : [];
    } catch (_) {
      return [];
    }
  }

  function recordRecentWork(item, customStorage) {
    const store = getStorage(customStorage);
    if (!store || !item || !item.kind || !item.id || !item.name) return [];
    const current = loadRecentWork(store);
    const entry = {
      kind: String(item.kind),
      id: String(item.id),
      name: String(item.name),
      route: item.route || (item.kind === "company" || item.kind === "diagram" ? "bom" : "sales"),
      visitedAt: Date.now()
    };
    const next = [entry, ...current.filter(x => !(x.kind === entry.kind && x.id === entry.id))].slice(0, 6);
    try {
      store.setItem(STORAGE_KEYS.RECENT_UI, JSON.stringify(next));
    } catch (_) {}
    return next;
  }

  const SCStorage = Object.freeze({
    STORAGE_KEYS,
    readBusinessSnapshot,
    loadRecentWork,
    recordRecentWork
  });

  global.SCStorage = SCStorage;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = SCStorage;
  }
})(typeof window !== "undefined" ? window : globalThis);
