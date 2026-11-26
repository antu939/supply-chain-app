(function (global) {
  "use strict";

  const API_VERSION = "1.0";
  const DEFAULT_LIMIT = 20;
  const MAX_LIMIT = 100;

  function getStore() {
    if (global.SCDataStore) return global.SCDataStore;
    if (typeof require === "function") return require("../storage/data-store.js");
    return null;
  }

  function clampLimit(val) {
    const n = Number(val);
    if (!Number.isFinite(n) || n <= 0) return DEFAULT_LIMIT;
    return Math.min(MAX_LIMIT, Math.max(1, Math.floor(n)));
  }

  function clampOffset(val) {
    const n = Number(val);
    if (!Number.isFinite(n) || n < 0) return 0;
    return Math.floor(n);
  }

  function paginate(items, limitVal, offsetVal) {
    const limit = clampLimit(limitVal);
    const offset = clampOffset(offsetVal);
    const total = items.length;
    const slice = items.slice(offset, offset + limit);
    return {
      items: slice,
      pagination: { total, limit, offset, hasMore: offset + slice.length < total }
    };
  }

  function makeMeta(manifest, partitionsRead, pagination) {
    const base = {
      apiVersion: API_VERSION,
      manifestVersion: manifest?.version || 1,
      storageMode: manifest?.storageMode || "browser_local_storage",
      queriedAt: Date.now(),
      partitionsRead: Array.isArray(partitionsRead) ? partitionsRead : []
    };
    if (pagination) Object.assign(base, pagination);
    return base;
  }

  function monthFromDate(dateStr) {
    if (typeof dateStr !== "string" || dateStr.length < 7) return null;
    const ym = dateStr.slice(0, 7);
    return /^\d{4}-\d{2}$/.test(ym) ? ym : null;
  }

  function validateSalesDateRange({ fromDate, toDate }) {
    const TS = global.SC?.TimeSeries || (typeof require === "function" ? require("../modules/sales/js/timeseries.js") : null);
    if (fromDate !== undefined && (!TS || TS.parseIsoDateUtc(fromDate) === null)) return "fromDate 必须是有效自然日";
    if (toDate !== undefined && (!TS || TS.parseIsoDateUtc(toDate) === null)) return "toDate 必须是有效自然日";
    if (fromDate && toDate && fromDate > toDate) return "toDate 不能早于 fromDate";
    return null;
  }

  function dateInRange(dateStr, fromDate, toDate) {
    if (!dateStr) return !fromDate && !toDate;
    if (fromDate && dateStr < fromDate) return false;
    if (toDate && dateStr > toDate) return false;
    return true;
  }

  /**
   * 1. List available data partitions & lightweight manifest index without reading payloads.
   */
  function listPartitions(params, ctx) {
    const Store = getStore();
    const p = params || {};
    const manifest = Store.loadManifest(ctx);
    let list = manifest.partitions.slice();

    if (p.domain && p.domain !== "all") {
      list = list.filter(item => item.domain === p.domain);
    }
    if (p.kind) {
      list = list.filter(item => item.kind === p.kind);
    }
    if (p.monthFrom) {
      list = list.filter(item => !item.month || item.month >= p.monthFrom);
    }
    if (p.monthTo) {
      list = list.filter(item => !item.month || item.month <= p.monthTo);
    }

    const paged = paginate(list, p.limit || 50, p.offset || 0);
    return {
      ok: true,
      data: {
        partitions: paged.items,
        links: manifest.links
      },
      meta: makeMeta(manifest, ["manifest.json"], paged.pagination)
    };
  }

  /**
   * 2. Query BOM entities by kind, stable ID(s), company, compliance status, or keyword.
   */
  function queryBomEntities(params, ctx) {
    const Store = getStore();
    const p = params || {};
    const manifest = Store.loadManifest(ctx);
    const bomMeta = manifest.partitions.find(x => x.id === "bom/entities");
    if (!bomMeta) {
      return {
        ok: true,
        data: [],
        meta: makeMeta(manifest, [], { total: 0, limit: clampLimit(p.limit), offset: clampOffset(p.offset), hasMore: false })
      };
    }

    const bom = Store.readPartition("bom/entities", ctx);
    const kind = p.kind || "company"; // company | factory | product | diagram | all
    const idFilter = p.id ? new Set([String(p.id)]) : (Array.isArray(p.ids) ? new Set(p.ids.map(String)) : null);
    const q = String(p.query || "").trim().toLowerCase();
    const results = [];

    if (kind === "company" || kind === "all") {
      for (const c of Object.values(bom.companies)) {
        if (idFilter && !idFilter.has(c.id)) continue;
        const compStatus = c.compliance?.status || "unverified";
        if (p.complianceStatus && compStatus !== p.complianceStatus) continue;
        if (q && !`${c.name} ${c.location || ""} ${c.note || ""}`.toLowerCase().includes(q)) continue;
        const facCount = Object.values(bom.factories).filter(f => f.companyId === c.id).length;
        results.push({
          kind: "company",
          id: c.id,
          name: c.name,
          location: c.location || "",
          factoryCount: facCount,
          compliance: {
            status: compStatus,
            reason: c.compliance?.reason || "",
            updatedAt: c.compliance?.updatedAt || null
          }
        });
      }
    }

    if (kind === "factory" || kind === "all") {
      for (const f of Object.values(bom.factories)) {
        if (idFilter && !idFilter.has(f.id)) continue;
        if (p.companyId && f.companyId !== p.companyId) continue;
        const comp = bom.companies[f.companyId] || null;
        if (q && !`${f.name} ${f.location || ""} ${comp?.name || ""}`.toLowerCase().includes(q)) continue;
        results.push({
          kind: "factory",
          id: f.id,
          name: f.name,
          companyId: f.companyId || null,
          companyName: comp?.name || "",
          location: f.location || "",
          status: f.status === "archived" ? "archived" : "active",
          linkedSalesNodeId: manifest.links?.bomFactoryToSalesNode?.[f.id] || null
        });
      }
    }

    if (kind === "product" || kind === "diagram" || kind === "all") {
      for (const d of bom.diagrams) {
        const root = bom.nodes[d.rootNodeId];
        const mat = root ? bom.materials[root.materialId] : null;
        if (idFilter && !idFilter.has(d.id) && !(mat && idFilter.has(mat.id))) continue;
        if (p.companyId && !(root?.companyIds || []).includes(p.companyId)) continue;
        if (q && !`${mat?.name || ""} ${mat?.code || ""}`.toLowerCase().includes(q)) continue;
        const diagNodes = Object.values(bom.nodes).filter(n => n.diagramId === d.id);
        results.push({
          kind: "diagram",
          id: d.id,
          productId: mat?.id || null,
          skuCode: mat?.code || "",
          name: mat?.name || "未命名成品",
          rootNodeId: d.rootNodeId,
          rootCompanyIds: root?.companyIds || [],
          componentCount: diagNodes.length
        });
      }
    }

    const paged = paginate(results, p.limit, p.offset);
    return {
      ok: true,
      data: paged.items,
      meta: makeMeta(manifest, ["bom/entities"], paged.pagination)
    };
  }

  /**
   * 3. Targeted BOM drill-down by stable companyId, factoryId, or diagramId/productId.
   */
  function getBomDetail(params, ctx) {
    const Store = getStore();
    const p = params || {};
    const manifest = Store.loadManifest(ctx);
    const bom = Store.readPartition("bom/entities", ctx);
    if (!bom) {
      return { ok: false, error: "BOM 数据不存在", data: null, meta: makeMeta(manifest, []) };
    }

    if (p.companyId) {
      const comp = bom.companies[p.companyId];
      if (!comp) return { ok: false, error: `未找到公司 ${p.companyId}`, data: null, meta: makeMeta(manifest, ["bom/entities"]) };
      const factories = Object.values(bom.factories).filter(f => f.companyId === comp.id);

      const upstreamIds = new Set();
      const downstreamIds = new Set();
      for (const rows of Object.values(bom.relationships)) {
        if (!rows || typeof rows !== "object") continue;
        for (const [down, ups] of Object.entries(rows)) {
          if (!Array.isArray(ups)) continue;
          if (down === comp.id) ups.forEach(u => upstreamIds.add(u));
          if (ups.includes(comp.id)) downstreamIds.add(down);
        }
      }

      const assessments = [];
      for (const d of bom.diagrams) {
        const byMarket = d.assessments?.[comp.id];
        if (!byMarket) continue;
        const rootMat = bom.materials[bom.nodes[d.rootNodeId]?.materialId];
        for (const [marketKey, rec] of Object.entries(byMarket)) {
          assessments.push({
            diagramId: d.id,
            productName: rootMat?.name || "",
            market: marketKey,
            status: rec.status || "pending",
            evidence: Array.isArray(rec.evidence) ? rec.evidence : [],
            pendingItems: Array.isArray(rec.pendingItems) ? rec.pendingItems : [],
            updatedAt: rec.updatedAt || null
          });
        }
      }

      return {
        ok: true,
        data: {
          company: comp,
          factories,
          upstreamSuppliers: Array.from(upstreamIds).map(id => ({
            id,
            name: bom.companies[id]?.name || id,
            complianceStatus: bom.companies[id]?.compliance?.status || "unverified"
          })),
          downstreamReceivers: Array.from(downstreamIds).map(id => ({
            id,
            name: bom.companies[id]?.name || id
          })),
          marketAssessments: assessments
        },
        meta: makeMeta(manifest, ["bom/entities"])
      };
    }

    if (p.factoryId) {
      const fac = bom.factories[p.factoryId];
      if (!fac) return { ok: false, error: `未找到工厂 ${p.factoryId}`, data: null, meta: makeMeta(manifest, ["bom/entities"]) };
      const comp = bom.companies[fac.companyId] || null;
      const paths = [];
      for (const [nid, byDown] of Object.entries(bom.factoryLinks)) {
        if (!byDown || typeof byDown !== "object") continue;
        for (const [down, byUp] of Object.entries(byDown)) {
          if (!byUp || typeof byUp !== "object") continue;
          for (const [up, pairs] of Object.entries(byUp)) {
            if (!Array.isArray(pairs)) continue;
            for (const pair of pairs) {
              if (pair.receiverFactoryId === fac.id || pair.supplierFactoryId === fac.id) {
                paths.push({
                  nodeId: nid,
                  componentName: bom.materials[bom.nodes[nid]?.materialId]?.name || "",
                  receiverCompanyId: down,
                  supplierCompanyId: up,
                  receiverFactoryId: pair.receiverFactoryId,
                  supplierFactoryId: pair.supplierFactoryId
                });
              }
            }
          }
        }
      }
      return {
        ok: true,
        data: {
          factory: fac,
          company: comp ? { id: comp.id, name: comp.name, compliance: comp.compliance } : null,
          factoryPaths: paths,
          linkedSalesNodeId: manifest.links?.bomFactoryToSalesNode?.[fac.id] || null
        },
        meta: makeMeta(manifest, ["bom/entities"])
      };
    }

    if (p.diagramId || p.productId) {
      const diag = bom.diagrams.find(d =>
        (p.diagramId && d.id === p.diagramId) ||
        (p.productId && bom.nodes[d.rootNodeId]?.materialId === p.productId)
      );
      if (!diag) return { ok: false, error: "未找到对应 BOM 产品结构", data: null, meta: makeMeta(manifest, ["bom/entities"]) };
      const nodes = Object.values(bom.nodes)
        .filter(n => n.diagramId === diag.id)
        .map(n => {
          const mat = bom.materials[n.materialId] || {};
          return {
            id: n.id,
            parentId: n.parentId,
            materialId: n.materialId,
            name: mat.name || "",
            code: mat.code || "",
            qty: n.qty,
            unit: n.unit || "",
            companies: (n.companyIds || []).map(cid => ({
              id: cid,
              name: bom.companies[cid]?.name || cid,
              complianceStatus: bom.companies[cid]?.compliance?.status || "unverified"
            }))
          };
        });
      return {
        ok: true,
        data: {
          diagramId: diag.id,
          rootNodeId: diag.rootNodeId,
          nodes,
          assessments: diag.assessments || {}
        },
        meta: makeMeta(manifest, ["bom/entities"])
      };
    }

    return { ok: false, error: "请提供 companyId、factoryId、diagramId 或 productId", data: null, meta: makeMeta(manifest, []) };
  }

  /**
   * Resolve which monthly Sales partitions must be read using ONLY the manifest index.
   * Prevents reading unrelated months!
   */
  function selectSalesMonthPartitions(manifest, params, resolvedFactoryId) {
    const p = params || {};
    const monthlyMetas = manifest.partitions.filter(x => x.domain === "sales" && x.kind === "monthly");
    const explicitMonthFrom = p.month || p.monthFrom || null;
    const explicitMonthTo = p.month || p.monthTo || null;

    return monthlyMetas.filter(meta => {
      if (p.shipmentId) {
        const hasShipment = meta.entityIds?.shipments?.includes(p.shipmentId);
        const hasFact = p.entity === "facts" && meta.entityIds?.factTargets?.includes(p.shipmentId);
        if (!hasShipment && !hasFact) return false;
        // Continue evaluating month/date filters: shipmentId must not bypass them.
      }
      if (p.batchId) {
        const hasBatch = meta.entityIds?.batches?.includes(p.batchId);
        const hasRef = meta.entityIds?.referencedBatches?.includes(p.batchId);
        const hasFact = p.entity === "facts" && meta.entityIds?.factTargets?.includes(p.batchId);
        if (!hasBatch && !hasRef && !hasFact) return false;
      }
      if (resolvedFactoryId) {
        const ids = p.entity === "facts" ? meta.entityIds?.factFactories : meta.entityIds?.factories;
        if (!ids?.includes(resolvedFactoryId)) return false;
      }
      if (p.marketId && (p.entity === "shipments" || p.entity === "facts")) {
        const ids = p.entity === "facts" ? meta.entityIds?.factMarkets : meta.entityIds?.markets;
        if (!ids?.includes(p.marketId)) return false;
      }
      if (explicitMonthFrom && meta.month && meta.month < explicitMonthFrom) return false;
      if (explicitMonthTo && meta.month && meta.month > explicitMonthTo) return false;
      if (p.fromDate || p.toDate) {
        const span = meta.activeDateRange || meta.dateRange;
        if (span) {
          if (p.fromDate && span.to && span.to < p.fromDate) return false;
          if (p.toDate && span.from && span.from > p.toDate) return false;
        }
      }
      return true;
    });
  }

  /**
   * 4. Query Sales data selectively via manifest index (by month, time range, factory, batch, shipment, or entity).
   */
  function querySales(params, ctx) {
    const Store = getStore();
    const p = params || {};
    const error = validateSalesDateRange(p);
    if (error) return { ok: false, error, data: null, meta: makeMeta(null, []) };
    const manifest = Store.loadManifest(ctx);
    const entity = p.entity || "shipments"; // shipments | batches | facts | factories | markets | lanes | summary
    const partitionsRead = [];

    // Resolve factoryId: accept either Sales node.id or BOM bomFactoryId
    const resolvedFactoryId = p.factoryId
      ? (manifest.links?.bomFactoryToSalesNode?.[p.factoryId] || p.factoryId)
      : null;

    if (entity === "factories" || entity === "markets" || entity === "lanes") {
      const master = Store.readPartition("sales/master", ctx);
      if (!master) {
        return { ok: true, data: [], meta: makeMeta(manifest, [], { total: 0, limit: clampLimit(p.limit), offset: clampOffset(p.offset), hasMore: false }) };
      }
      partitionsRead.push("sales/master");
      let rows = [];
      if (entity === "factories") {
        rows = Object.values(master.nodes).filter(n => n.kind === "source");
        if (resolvedFactoryId) rows = rows.filter(n => n.id === resolvedFactoryId);
      } else if (entity === "markets") {
        rows = Object.values(master.nodes).filter(n => n.kind === "market");
        if (p.marketId) rows = rows.filter(n => n.id === p.marketId);
      } else if (entity === "lanes") {
        rows = Object.values(master.lanes);
        if (resolvedFactoryId) rows = rows.filter(l => l.fromNodeId === resolvedFactoryId);
        if (p.marketId) rows = rows.filter(l => l.toNodeId === p.marketId);
      }
      const paged = paginate(rows, p.limit, p.offset);
      return { ok: true, data: paged.items, meta: makeMeta(manifest, partitionsRead, paged.pagination) };
    }

    const targetMonthMetas = selectSalesMonthPartitions(manifest, { ...p, entity }, resolvedFactoryId);
    const rows = [];

    for (const meta of targetMonthMetas) {
      const part = Store.readPartition(meta.id, ctx);
      if (!part) continue;
      partitionsRead.push(meta.id);

      if (entity === "shipments" || entity === "summary") {
        for (const s of Object.values(part.shipments || {})) {
          if (p.shipmentId && s.id !== p.shipmentId) continue;
          if (p.productId && s.productId !== p.productId) continue;
          if (resolvedFactoryId && s.fromNodeId !== resolvedFactoryId) continue;
          if (p.marketId && s.toNodeId !== p.marketId) continue;
          if (p.batchId && s.batchId !== p.batchId) continue;
          if (p.status && s.status !== p.status) continue;
          const refDate = s.milestones?.departActualDate || s.departDate || "";
          if (!dateInRange(refDate, p.fromDate, p.toDate)) continue;
          rows.push(entity === "summary" ? { recordType: "shipment", partitionId: meta.id, ...s } : s);
        }
      }

      if (entity === "batches" || entity === "summary") {
        for (const b of Object.values(part.batches || {})) {
          if (p.batchId && b.id !== p.batchId) continue;
          if (p.productId && b.productId !== p.productId) continue;
          if (resolvedFactoryId && b.sourceNodeId !== resolvedFactoryId) continue;
          if (p.status && b.status !== p.status) continue;
          if (p.fromDate && b.endDate && b.endDate <= p.fromDate) continue;
          if (p.toDate && b.startDate && b.startDate > p.toDate) continue;
          rows.push(entity === "summary" ? { recordType: "batch", partitionId: meta.id, ...b } : b);
        }
      }

      if (entity === "facts") {
        for (const f of (part.facts || [])) {
          if (p.shipmentId && f.targetId !== p.shipmentId) continue;
          if (p.batchId && f.targetId !== p.batchId) continue;
          if (resolvedFactoryId && meta.entityIds?.factFactoryByTarget?.[f.targetId] !== resolvedFactoryId) continue;
          if (p.marketId && meta.entityIds?.factMarketByTarget?.[f.targetId] !== p.marketId) continue;
          if (p.kind && f.kind !== p.kind) continue;
          if (!dateInRange(f.date, p.fromDate, p.toDate)) continue;
          rows.push(f);
        }
      }
    }

    const paged = paginate(rows, p.limit, p.offset);
    return {
      ok: true,
      data: paged.items,
      meta: makeMeta(manifest, partitionsRead, paged.pagination)
    };
  }

  /**
   * 5. Cross-module upstream (BOM) + downstream (Sales) view for a factory
   *    ONLY when an explicit, reliable bomFactoryId link exists.
   */
  function getCrossModuleFactoryView(params, ctx) {
    const Store = getStore();
    const p = params || {};
    const manifest = Store.loadManifest(ctx);
    const partitionsRead = [];

    let bomFactoryId = p.bomFactoryId ? String(p.bomFactoryId) : null;
    let salesNodeId = p.salesNodeId ? String(p.salesNodeId) : null;

    if (bomFactoryId && !salesNodeId) {
      salesNodeId = manifest.links?.bomFactoryToSalesNode?.[bomFactoryId] || null;
    } else if (salesNodeId && !bomFactoryId) {
      bomFactoryId = manifest.links?.salesNodeToBomFactory?.[salesNodeId] || null;
    }

    const linked = Boolean(bomFactoryId && salesNodeId && manifest.links?.bomFactoryToSalesNode?.[bomFactoryId] === salesNodeId);

    let bomSection = null;
    if (bomFactoryId) {
      const detail = getBomDetail({ factoryId: bomFactoryId }, ctx);
      if (detail.ok && detail.data) {
        partitionsRead.push(...detail.meta.partitionsRead);
        const compDetail = detail.data.company ? getBomDetail({ companyId: detail.data.company.id }, ctx) : null;
        bomSection = {
          factory: detail.data.factory,
          company: detail.data.company,
          upstreamSuppliers: compDetail?.ok ? compDetail.data.upstreamSuppliers : [],
          marketAssessments: compDetail?.ok ? compDetail.data.marketAssessments : []
        };
      }
    }

    let salesSection = null;
    if (salesNodeId) {
      const master = Store.readPartition("sales/master", ctx);
      const factoryNode = master?.nodes?.[salesNodeId] || null;
      if (factoryNode) {
        partitionsRead.push("sales/master");
        const limit = clampLimit(p.limit || 10);
        const batchesRes = querySales({ entity: "batches", factoryId: salesNodeId, monthFrom: p.monthFrom, monthTo: p.monthTo, limit }, ctx);
        const shipmentsRes = querySales({ entity: "shipments", factoryId: salesNodeId, monthFrom: p.monthFrom, monthTo: p.monthTo, limit }, ctx);
        partitionsRead.push(...batchesRes.meta.partitionsRead, ...shipmentsRes.meta.partitionsRead);
        salesSection = {
          factoryNode,
          batches: batchesRes.data,
          batchesTotal: batchesRes.meta.total,
          shipments: shipmentsRes.data,
          shipmentsTotal: shipmentsRes.meta.total
        };
      }
    }

    return {
      ok: Boolean(bomSection || salesSection),
      data: {
        linked,
        bomFactoryId,
        salesNodeId,
        bom: bomSection,
        sales: salesSection
      },
      meta: makeMeta(manifest, Array.from(new Set(partitionsRead)))
    };
  }

  /**
   * 6. Optional read-only dry-run simulation wrapper reusing existing Sales engine (zero state mutation).
   */
  function simulateSalesActions(actions, options) {
    const Act = options?.actionsEngine || global.SC?.Actions;
    const WM = options?.worldModel || global.SC?.WorldModel;
    if (!Act || typeof Act.simulateActions !== "function") {
      return { ok: false, error: "当前上下文未加载销售模拟引擎" };
    }
    let ws = options?.workspace || null;
    if (!ws) {
      if (!WM || typeof WM.validateWorkspace !== "function") {
        return { ok: false, error: "当前上下文未加载销售工作区校验器" };
      }
      // Logical monthly partitions do not contain the complete mutable workspace.
      // Use the caller's storage rather than reading the global browser's localStorage.
      const store = options?.storage || (typeof localStorage !== "undefined" ? localStorage : null);
      if (store) {
        try {
          const raw = store.getItem("sc-sales-world-v2") || store.getItem("sc-sales-world-v1");
          if (raw) ws = WM.validateWorkspace(JSON.parse(raw));
        } catch (err) {
          return { ok: false, error: `无法读取销售工作区：${err.message}` };
        }
      }
    }
    if (!ws) return { ok: false, error: "未提供销售工作区数据" };
    return Act.simulateActions(ws, actions, options?.simOptions);
  }

  const SCAIQuery = Object.freeze({
    API_VERSION,
    listPartitions,
    queryBomEntities,
    getBomDetail,
    querySales,
    validateSalesDateRange,
    getCrossModuleFactoryView,
    simulateSalesActions
  });

  global.SCAIQuery = SCAIQuery;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = SCAIQuery;
  }
})(typeof window !== "undefined" ? window : globalThis);
