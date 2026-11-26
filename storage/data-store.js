(function (global) {
  "use strict";

  const STORAGE_KEYS = Object.freeze({
    BOM: "bom-flow-sim-v5",
    SALES: "sc-sales-world-v2",
    SALES_LEGACY: "sc-sales-world-v1",
    MANIFEST: "sc-data-manifest-v1"
  });

  const MANIFEST_FORMAT = "sc-data-manifest";
  // Version 2 adds fact-to-factory/market maps.
  const MANIFEST_VERSION = 2;
  const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

  function isMonth(val) {
    return typeof val === "string" && MONTH_RE.test(val);
  }

  function extractMonthFromIso(dateStr) {
    if (typeof dateStr !== "string" || dateStr.length < 7) return null;
    const m = dateStr.slice(0, 7);
    return isMonth(m) ? m : null;
  }

  function monthDateRange(ym) {
    if (!isMonth(ym)) return null;
    const [y, m] = ym.split("-").map(Number);
    const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
    return {
      from: `${ym}-01`,
      to: `${ym}-${String(lastDay).padStart(2, "0")}`
    };
  }

  function defaultFallbackMonth(salesRaw) {
    return extractMonthFromIso(salesRaw?.inventoryAnchorDate) || "undated";
  }

  /**
   * Determine immutable business origin month (YYYY-MM) for a Sales record.
   * Records belong permanently to their original business month and never migrate as time passes.
   */
  function getRecordOriginMonth(kind, record, fallbackMonth) {
    if (!record || typeof record !== "object") return fallbackMonth || "undated";
    if (isMonth(record.originMonth)) return record.originMonth;
    if (kind === "batch") {
      return extractMonthFromIso(record.startDate) || extractMonthFromIso(record.availableDate) || fallbackMonth || "undated";
    }
    if (kind === "shipment") {
      return extractMonthFromIso(record.milestones?.departPlannedDate)
        || extractMonthFromIso(record.departDate)
        || extractMonthFromIso(record.milestones?.departActualDate)
        || fallbackMonth
        || "undated";
    }
    if (kind === "fact") {
      return extractMonthFromIso(record.date) || fallbackMonth || "undated";
    }
    return fallbackMonth || "undated";
  }

  function readRawJson(store, key) {
    if (!store) return null;
    try {
      const text = store.getItem(key);
      return text ? JSON.parse(text) : null;
    } catch (_) {
      return null;
    }
  }

  function readRawBom(store) {
    return readRawJson(store || defaultStorage(), STORAGE_KEYS.BOM);
  }

  function readRawSales(store) {
    const s = store || defaultStorage();
    try {
      // A damaged current workspace is not the same as an absent workspace.
      // Never silently substitute outdated legacy records for it.
      const current = s?.getItem(STORAGE_KEYS.SALES);
      return current == null ? readRawJson(s, STORAGE_KEYS.SALES_LEGACY) : JSON.parse(current);
    } catch (_) {
      return null;
    }
  }

  function defaultStorage() {
    try { return typeof localStorage !== "undefined" ? localStorage : null; }
    catch (_) { return null; }
  }

  /**
   * Organize BOM logically by stable entity IDs (without mutating source data).
   */
  function partitionBom(bomRaw) {
    if (!bomRaw || typeof bomRaw !== "object") return null;
    const companies = bomRaw.companies && typeof bomRaw.companies === "object" ? bomRaw.companies : {};
    const factories = bomRaw.factories && typeof bomRaw.factories === "object" ? bomRaw.factories : {};
    const materials = bomRaw.materials && typeof bomRaw.materials === "object" ? bomRaw.materials : {};
    const nodes = bomRaw.nodes && typeof bomRaw.nodes === "object" ? bomRaw.nodes : {};
    const diagrams = Array.isArray(bomRaw.diagrams) ? bomRaw.diagrams.filter(d => d && typeof d === "object") : [];
    const relationships = bomRaw.relationships && typeof bomRaw.relationships === "object" ? bomRaw.relationships : {};
    const factoryLinks = bomRaw.factoryLinks && typeof bomRaw.factoryLinks === "object" ? bomRaw.factoryLinks : {};

    return {
      partitionId: "bom/entities",
      domain: "bom",
      kind: "entities",
      path: "bom/entities.json",
      format: bomRaw.format || "bom-flow",
      version: bomRaw.version || 7,
      activeDiagramId: bomRaw.activeDiagramId || null,
      companies,
      factories,
      materials,
      diagrams,
      nodes,
      relationships,
      factoryLinks
    };
  }

  /**
   * Organize Sales logically into:
   * - sales/master.json (factories, markets, products, lanes, curves, settings)
   * - sales/YYYY-MM.json (monthly partitions by immutable business origin month; NO current/history split)
   */
  function partitionSales(salesRaw) {
    if (!salesRaw || typeof salesRaw !== "object") return null;
    const fallback = defaultFallbackMonth(salesRaw);
    const nodes = salesRaw.nodes && typeof salesRaw.nodes === "object" ? salesRaw.nodes : {};
    const products = salesRaw.products && typeof salesRaw.products === "object" ? salesRaw.products : {};
    const lanes = salesRaw.lanes && typeof salesRaw.lanes === "object" ? salesRaw.lanes : {};
    const curves = salesRaw.curves && typeof salesRaw.curves === "object" ? salesRaw.curves : {};
    const batches = salesRaw.batches && typeof salesRaw.batches === "object" ? salesRaw.batches : {};
    const shipments = salesRaw.shipments && typeof salesRaw.shipments === "object" ? salesRaw.shipments : {};
    const facts = Array.isArray(salesRaw.facts) ? salesRaw.facts : [];

    const master = {
      partitionId: "sales/master",
      domain: "sales",
      kind: "master",
      path: "sales/master.json",
      format: salesRaw.format || "sc-sales-world",
      version: salesRaw.version || 2,
      workspaceId: salesRaw.workspaceId || null,
      revision: salesRaw.revision || 1,
      inventoryAnchorDate: salesRaw.inventoryAnchorDate || null,
      viewHorizonDays: salesRaw.viewHorizonDays || 30,
      activeProductId: salesRaw.activeProductId || null,
      products,
      nodes,
      lanes,
      curves
    };

    const monthlyMap = {};
    const ensureMonth = (ym) => {
      if (!monthlyMap[ym]) {
        monthlyMap[ym] = {
          partitionId: `sales/${ym}`,
          domain: "sales",
          kind: "monthly",
          month: ym,
          dateRange: monthDateRange(ym),
          path: `sales/${ym}.json`,
          format: "sc-sales-month",
          version: salesRaw.version || 2,
          batches: {},
          shipments: {},
          facts: []
        };
      }
      return monthlyMap[ym];
    };

    for (const [bid, batch] of Object.entries(batches)) {
      if (!batch || typeof batch !== "object") continue;
      const ym = getRecordOriginMonth("batch", batch, fallback);
      ensureMonth(ym).batches[bid] = Object.assign({}, batch, { originMonth: ym });
    }

    for (const [sid, shp] of Object.entries(shipments)) {
      if (!shp || typeof shp !== "object") continue;
      const ym = getRecordOriginMonth("shipment", shp, fallback);
      ensureMonth(ym).shipments[sid] = Object.assign({}, shp, { originMonth: ym });
    }

    for (const fact of facts) {
      if (!fact || typeof fact !== "object") continue;
      const ym = getRecordOriginMonth("fact", fact, fallback);
      ensureMonth(ym).facts.push(Object.assign({}, fact, { originMonth: ym }));
    }

    const months = Object.keys(monthlyMap).sort();
    const monthly = {};
    for (const ym of months) monthly[ym] = monthlyMap[ym];

    return { master, monthly, months };
  }

  /**
   * Build lightweight manifest.json index (purely locational; never duplicates business payloads).
   * Always rebuildable from raw BOM and Sales JSON.
   */
  function buildManifest(bomRaw, salesRaw) {
    const partitions = [];
    const bomFactoryToSalesNode = {};
    const salesNodeToBomFactory = {};

    const bomPart = partitionBom(bomRaw);
    if (bomPart) {
      const companyIds = Object.keys(bomPart.companies);
      const factoryIds = Object.keys(bomPart.factories);
      const diagramIds = bomPart.diagrams.map(d => d.id).filter(Boolean);
      const materialIds = Object.keys(bomPart.materials);
      if (companyIds.length || factoryIds.length || diagramIds.length || materialIds.length) {
        partitions.push({
          id: bomPart.partitionId,
          domain: "bom",
          kind: "entities",
          path: bomPart.path,
          storageKey: STORAGE_KEYS.BOM,
          version: bomPart.version,
          counts: {
            companies: companyIds.length,
            factories: factoryIds.length,
            diagrams: diagramIds.length,
            materials: materialIds.length
          },
          entityIds: {
            companies: companyIds,
            factories: factoryIds,
            diagrams: diagramIds,
            materials: materialIds
          }
        });
      }
    }

    const salesPart = partitionSales(salesRaw);
    if (salesPart) {
      const nodes = Object.values(salesPart.master.nodes);
      const factoryNodes = nodes.filter(n => n && n.kind === "source");
      const marketNodes = nodes.filter(n => n && n.kind === "market");
      const productIds = Object.keys(salesPart.master.products);
      const laneIds = Object.keys(salesPart.master.lanes);

      for (const fn of factoryNodes) {
        if (fn.bomFactoryId) {
          bomFactoryToSalesNode[String(fn.bomFactoryId)] = fn.id;
          salesNodeToBomFactory[fn.id] = String(fn.bomFactoryId);
        }
      }

      if (factoryNodes.length || marketNodes.length || productIds.length || laneIds.length || salesPart.months.length) {
        partitions.push({
          id: salesPart.master.partitionId,
          domain: "sales",
          kind: "master",
          path: salesPart.master.path,
          storageKey: STORAGE_KEYS.SALES,
          version: salesPart.master.version,
          revision: salesPart.master.revision,
          counts: {
            factories: factoryNodes.length,
            markets: marketNodes.length,
            products: productIds.length,
            lanes: laneIds.length
          },
          entityIds: {
            factories: factoryNodes.map(n => n.id),
            bomFactoryIds: factoryNodes.map(n => n.bomFactoryId).filter(Boolean),
            markets: marketNodes.map(n => n.id),
            products: productIds
          }
        });
      }

      for (const ym of salesPart.months) {
        const mp = salesPart.monthly[ym];
        const batchList = Object.values(mp.batches);
        const shpList = Object.values(mp.shipments);
        const factorySet = new Set();
        const marketSet = new Set();
        const refBatchSet = new Set();
        const factFactoryByTarget = Object.create(null);
        const factMarketByTarget = Object.create(null);
        const factFactories = new Set();
        const factMarkets = new Set();
        let minDate = mp.dateRange ? mp.dateRange.from : null;
        let maxDate = mp.dateRange ? mp.dateRange.to : null;
        const trackDate = (d) => {
          if (typeof d !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(d)) return;
          if (!minDate || d < minDate) minDate = d;
          if (!maxDate || d > maxDate) maxDate = d;
        };

        for (const b of batchList) {
          if (b.sourceNodeId) factorySet.add(b.sourceNodeId);
          trackDate(b.startDate);
          trackDate(b.endDate);
          trackDate(b.availableDate);
        }
        for (const s of shpList) {
          if (s.fromNodeId) factorySet.add(s.fromNodeId);
          if (s.toNodeId) marketSet.add(s.toNodeId);
          if (s.batchId) refBatchSet.add(s.batchId);
          trackDate(s.departDate);
          trackDate(s.milestones?.departActualDate);
          trackDate(s.milestones?.marketStockAvailableActualDate || s.milestones?.marketStockAvailablePlannedDate);
        }
        for (const f of mp.facts) {
          // A fact can reference a shipment or batch created in a DIFFERENT month.
          // Resolve that relationship from the authoritative source to index it correctly.
          const targetNode = salesPart.master.nodes[f.targetId];
          const shipment = salesRaw.shipments?.[f.targetId];
          const batch = salesRaw.batches?.[f.targetId];
          const factoryId = targetNode?.kind === "source" ? targetNode.id
            : shipment?.fromNodeId || batch?.sourceNodeId || null;
          const marketId = targetNode?.kind === "market" ? targetNode.id
            : shipment?.toNodeId || null;
          if (factoryId) {
            factorySet.add(factoryId);
            factFactories.add(factoryId);
            factFactoryByTarget[f.targetId] = factoryId;
          }
          if (marketId) {
            marketSet.add(marketId);
            factMarkets.add(marketId);
            factMarketByTarget[f.targetId] = marketId;
          }
          trackDate(f.date);
        }

        partitions.push({
          id: mp.partitionId,
          domain: "sales",
          kind: "monthly",
          month: ym,
          dateRange: mp.dateRange,
          activeDateRange: (minDate && maxDate) ? { from: minDate, to: maxDate } : mp.dateRange,
          path: mp.path,
          storageKey: STORAGE_KEYS.SALES,
          version: mp.version,
          counts: {
            batches: batchList.length,
            shipments: shpList.length,
            facts: mp.facts.length
          },
          entityIds: {
            factories: Array.from(factorySet),
            markets: Array.from(marketSet),
            batches: Object.keys(mp.batches),
            referencedBatches: Array.from(refBatchSet),
            shipments: Object.keys(mp.shipments),
            factTargets: Array.from(new Set(mp.facts.map(f => f.targetId).filter(Boolean))),
            factFactories: Array.from(factFactories),
            factMarkets: Array.from(factMarkets),
            factFactoryByTarget,
            factMarketByTarget
          }
        });
      }
    }

    return {
      format: MANIFEST_FORMAT,
      version: MANIFEST_VERSION,
      generatedAt: Date.now(),
      storageMode: "browser_local_storage",
      sources: {
        bom: bomRaw ? { storageKey: STORAGE_KEYS.BOM, version: bomRaw.version || 7, counter: bomRaw.counter || 0 } : null,
        sales: salesRaw ? { storageKey: STORAGE_KEYS.SALES, version: salesRaw.version || 2, revision: salesRaw.revision || 1 } : null
      },
      partitions,
      links: {
        bomFactoryToSalesNode,
        salesNodeToBomFactory
      }
    };
  }

  /**
   * Rebuild manifest from current authoritative browser storage.
   * Only caches sc-data-manifest-v1 when real business data exists (never writes on blank boot).
   */
  function rebuildManifest(customStorage) {
    const store = customStorage || defaultStorage();
    const bomRaw = readRawBom(store);
    const salesRaw = readRawSales(store);
    const manifest = buildManifest(bomRaw, salesRaw);
    if (store && manifest.partitions.length > 0) {
      try {
        store.setItem(STORAGE_KEYS.MANIFEST, JSON.stringify(manifest));
      } catch (_) {
        // Non-fatal: manifest can always be rebuilt in memory
      }
    }
    return manifest;
  }

  function loadManifest(options) {
    const opts = options || {};
    if (opts.partitionProvider && typeof opts.partitionProvider.readManifest === "function") {
      return opts.partitionProvider.readManifest();
    }
    const store = opts.storage || defaultStorage();
    const bomRaw = opts.bomRaw !== undefined ? opts.bomRaw : readRawBom(store);
    const salesRaw = opts.salesRaw !== undefined ? opts.salesRaw : readRawSales(store);

    // A counter/revision is not a content identity (imports, undo and
    // edits to existing records can keep the same value). Derive the
    // manifest from the authoritative records on every local read.
    return buildManifest(bomRaw, salesRaw);
  }

  /**
   * Read a single logical partition by ID (e.g. "bom/entities", "sales/master", "sales/2026-10").
   * Supports an optional desktop/file partitionProvider for physical JSON files.
   */
  function readPartition(partitionId, options) {
    const opts = options || {};
    if (opts.partitionProvider && typeof opts.partitionProvider.readPartition === "function") {
      return opts.partitionProvider.readPartition(partitionId);
    }
    const store = opts.storage || defaultStorage();
    if (partitionId === "bom/entities") {
      const bomRaw = opts.bomRaw !== undefined ? opts.bomRaw : readRawBom(store);
      return partitionBom(bomRaw);
    }
    if (partitionId === "sales/master" || String(partitionId).startsWith("sales/")) {
      const salesRaw = opts.salesRaw !== undefined ? opts.salesRaw : readRawSales(store);
      const part = partitionSales(salesRaw);
      if (!part) return null;
      if (partitionId === "sales/master") return part.master;
      const ym = String(partitionId).slice("sales/".length);
      return part.monthly[ym] || null;
    }
    return null;
  }

  /**
   * Export logical partition files map (identical structure to future desktop JSON files).
   * Strictly read-only.
   */
  function exportLogicalBundle(options) {
    const opts = options || {};
    const store = opts.storage || defaultStorage();
    const bomRaw = opts.bomRaw !== undefined ? opts.bomRaw : readRawBom(store);
    const salesRaw = opts.salesRaw !== undefined ? opts.salesRaw : readRawSales(store);
    const manifest = buildManifest(bomRaw, salesRaw);
    const files = { "manifest.json": manifest };

    const bomPart = partitionBom(bomRaw);
    if (bomPart && manifest.partitions.some(p => p.id === "bom/entities")) {
      files[bomPart.path] = bomPart;
    }
    const salesPart = partitionSales(salesRaw);
    if (salesPart && manifest.partitions.some(p => p.id === "sales/master")) {
      files[salesPart.master.path] = salesPart.master;
      for (const ym of salesPart.months) {
        files[salesPart.monthly[ym].path] = salesPart.monthly[ym];
      }
    }
    return files;
  }

  const SCDataStore = Object.freeze({
    STORAGE_KEYS,
    MANIFEST_FORMAT,
    MANIFEST_VERSION,
    getRecordOriginMonth,
    partitionBom,
    partitionSales,
    buildManifest,
    rebuildManifest,
    loadManifest,
    readPartition,
    exportLogicalBundle
  });

  global.SCDataStore = SCDataStore;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = SCDataStore;
  }
})(typeof window !== "undefined" ? window : globalThis);
