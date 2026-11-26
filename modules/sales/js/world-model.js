(function (global) {
  "use strict";

  const getTS = () => global.SC?.TimeSeries || (typeof require === "function" ? require("./timeseries.js") : null);

  const WORLD_FORMAT = "sc-sales-world";
  const WORLD_VERSION = 2;
  const WORLD_STORAGE_KEY = "sc-sales-world-v2";
  const LEGACY_V1_STORAGE_KEY = "sc-sales-world-v1";
  const LEGACY_V1_BACKUP_KEY = "sc-sales-world-v1-backup";
  const BOM_STORAGE_KEY = "bom-flow-sim-v5";

  const TRANSPORT_MODES = [
    { key: "sea", label: "Ocean", defaultDays: 18 },
    { key: "sea_express", label: "Ocean Express", defaultDays: 14 },
    { key: "air", label: "Air", defaultDays: 5 },
    { key: "rail", label: "Rail", defaultDays: 16 },
    { key: "truck", label: "Truck", defaultDays: 5 }
  ];

  const SCHEDULE_STAGES = [
    ["borderArrivalPlannedDate", "borderArrivalActualDate", "borderArrivalEstimatedDate", "transitDays"],
    ["customsReleasePlannedDate", "customsReleaseActualDate", "customsReleaseEstimatedDate", "customsWaitDays"],
    ["marketStockAvailablePlannedDate", "marketStockAvailableActualDate", "marketStockAvailableEstimatedDate", "putawayDays"]
  ];

  const NODE_KIND_META = {
    source: { label: "Factory", short: "F" },
    market: { label: "Market", short: "M" }
  };

  /**
   * 内置 BOM 只读参考快照（对应 ../bom/js/sample-data.js 的智能网关 G200 v7），
   * 仅作基础产品、工厂与合规资料来源，绝不修改原有 BOM 存储或语义。
   */
  const BUILTIN_BOM_SNAPSHOT = {
    format: "bom-flow",
    version: 7,
    source: "builtin_reference",
    products: [
      {
        diagramId: "d1",
        rootNodeId: "n3",
        materialId: "m2",
        skuCode: "GW-G200",
        name: "智能网关 G200",
        unit: "台",
        note: "工业级边缘网关：双千兆网口、5G Sub-6、宽温 -40~75°C，支持 Modbus/OPC UA。",
        bomVersion: 7,
        componentCount: 21,
        companyCount: 21,
        rootCompanyId: "c44",
        rootCompanyName: "杭州智联科技有限公司",
        rootCompanyLocation: "杭州市滨江区江陵路 88 号",
        factories: [
          {
            id: "f65",
            companyId: "c44",
            name: "杭州总装一厂",
            location: "杭州市滨江区江陵路 88 号",
            note: "整机总装、老化与出货检验。",
            annualCapacityText: "8 万台"
          },
          {
            id: "f66",
            companyId: "c44",
            name: "杭州总装二厂",
            location: "杭州市萧山区鸿达路 9 号",
            note: "车规版专线与返修中心。",
            annualCapacityText: "4 万台"
          }
        ],
        topComponents: [
          { code: "MOD-MCU-01", name: "主控模组", qty: 1, unit: "件", supplier: "深圳芯联电子有限公司", compliance: "severe" },
          { code: "MOD-PWR-11", name: "电源模组", qty: 1, unit: "件", supplier: "东莞恒力 / 佛山创能", compliance: "qualified" },
          { code: "MOD-5G-21", name: "通信模组", qty: 1, unit: "件", supplier: "上海联讯无线科技有限公司", compliance: "qualified" },
          { code: "ME-AL-31", name: "结构件", qty: 1, unit: "套", supplier: "苏州精工结构件有限公司", compliance: "qualified" },
          { code: "WH-CON-41", name: "线束与连接器", qty: 1, unit: "套", supplier: "昆山联捷电子有限公司", compliance: "risk" },
          { code: "PKG-51", name: "包装材料", qty: 1, unit: "套", supplier: "未指定供应商", compliance: "unverified" },
          { code: "TH-61", name: "散热组件", qty: 1, unit: "套", supplier: "深圳散热科技有限公司", compliance: "qualified" }
        ]
      }
    ]
  };

  function clone(v) {
    return JSON.parse(JSON.stringify(v));
  }

  function genId(prefix) {
    const rand = Math.random().toString(36).slice(2, 7);
    const ts = Date.now().toString(36).slice(-4);
    return `${prefix}_${ts}${rand}`;
  }

  function safeNumber(v, fallback) {
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
  }

  function modeLabel(mode) {
    return TRANSPORT_MODES.find(m => m.key === mode)?.label || mode || "Ocean";
  }

  function extractBomCatalog(bomRaw, sourceLabel) {
    if (!bomRaw || bomRaw.format !== "bom-flow" || !Array.isArray(bomRaw.diagrams)) {
      return null;
    }
    const nodes = bomRaw.nodes || {};
    const materials = bomRaw.materials || {};
    const companies = bomRaw.companies || {};
    const factories = bomRaw.factories || {};
    const products = [];

    for (const d of bomRaw.diagrams) {
      const root = nodes[d.rootNodeId];
      if (!root) continue;
      const mat = materials[root.materialId];
      if (!mat) continue;

      const diagramNodes = Object.values(nodes).filter(n => n.diagramId === d.id);
      const companySet = new Set();
      diagramNodes.forEach(n => (n.companyIds || []).forEach(cid => companySet.add(cid)));

      const rootCompanyId = (root.companyIds && root.companyIds[0]) || null;
      const rootCompany = rootCompanyId ? companies[rootCompanyId] : null;
      const rootFactories = rootCompanyId
        ? Object.values(factories)
            .filter(f => f.companyId === rootCompanyId)
            .map(f => ({
              id: f.id,
              companyId: f.companyId,
              name: f.name,
              location: f.location || "",
              note: f.note || "",
              annualCapacityText: (f.extraFields && f.extraFields["年产能"]) || ""
            }))
        : [];

      const children = diagramNodes.filter(n => n.parentId === root.id);
      const topComponents = children.map(child => {
        const cm = materials[child.materialId] || {};
        const cNames = (child.companyIds || []).map(cid => companies[cid]?.name).filter(Boolean);
        const statuses = (child.companyIds || []).map(cid => companies[cid]?.compliance?.status || "unverified");
        const worst = statuses.includes("severe") ? "severe"
          : statuses.includes("risk") ? "risk"
          : statuses.includes("qualified") ? "qualified"
          : "unverified";
        return {
          code: cm.code || child.id,
          name: cm.name || "Untitled Component",
          qty: child.qty || 1,
          unit: child.unit || "pcs",
          supplier: cNames.length ? cNames.join(" / ") : "Unassigned",
          compliance: worst
        };
      });

      products.push({
        diagramId: d.id,
        rootNodeId: root.id,
        materialId: mat.id,
        skuCode: mat.code || mat.id.toUpperCase(),
        name: mat.name,
        unit: root.unit || "units",
        note: mat.note || "",
        bomVersion: bomRaw.version || 7,
        componentCount: diagramNodes.length,
        companyCount: companySet.size,
        rootCompanyId,
        rootCompanyName: rootCompany ? rootCompany.name : "No linked company",
        rootCompanyLocation: rootCompany ? (rootCompany.location || "") : "",
        factories: rootFactories,
        topComponents
      });
    }

    const companyList = Object.values(companies).map(c => ({
      id: c.id,
      sharedId: c.sharedId || null,
      name: c.name,
      location: c.location || "",
      status: c.status === "archived" ? "archived" : "active",
      isFinalAssembler: Boolean(c.isFinalAssembler)
    }));

    const factoryList = Object.values(factories).map(f => ({
      id: f.id,
      sharedId: f.sharedId || null,
      companyId: f.companyId,
      companyName: companies[f.companyId]?.name || "",
      name: f.name,
      region: f.region || "CN",
      city: f.city || "",
      location: f.location || "",
      note: f.note || "",
      status: f.status === "archived" ? "archived" : "active",
      isFinalAssembly: Boolean(f.isFinalAssembly || companies[f.companyId]?.isFinalAssembler),
      annualCapacityText: (f.extraFields && f.extraFields["年产能"]) || ""
    }));

    if (!products.length && !companyList.length && !factoryList.length) return null;
    return {
      format: "bom-flow",
      version: bomRaw.version || 7,
      source: sourceLabel || "imported_bom",
      products,
      companies: companyList,
      factories: factoryList
    };
  }

  function readRawBomFromStorage() {
    try {
      if (typeof localStorage !== "undefined") {
        const text = localStorage.getItem(BOM_STORAGE_KEY);
        if (text) return JSON.parse(text);
      }
    } catch (_) {}
    return null;
  }

  function readLinkedBomCatalog(options) {
    try {
      const raw = readRawBomFromStorage();
      if (raw) {
        const catalog = extractBomCatalog(raw, "localStorage:bom-flow-sim-v5");
        if (catalog) return catalog;
      }
    } catch (_) {
      // 安全降级
    }
    if (options?.allowBuiltinFallback) {
      return clone(BUILTIN_BOM_SNAPSHOT);
    }
    return null;
  }

  /**
   * 只读获取 BOM 模块中的最终总装厂列表（不写入、不修改 BOM 数据，不导入上游零部件供应商）。
   */
  function readBomFinalAssemblyFactories(bomRaw) {
    const raw = bomRaw !== undefined ? bomRaw : readRawBomFromStorage();
    if (!raw || typeof raw !== "object") return [];
    if (global.SCBomFactories?.extractFinalAssemblyFactories) {
      return global.SCBomFactories.extractFinalAssemblyFactories(raw);
    }
    // 独立加载 world-model.js 时的精简回退实现
    const companies = raw.companies && typeof raw.companies === "object" ? raw.companies : {};
    const factories = raw.factories && typeof raw.factories === "object" ? raw.factories : {};
    const diagrams = Array.isArray(raw.diagrams) ? raw.diagrams : [];
    const nodes = raw.nodes && typeof raw.nodes === "object" ? raw.nodes : {};
    const rootCompanyIds = new Set();
    for (const d of diagrams) {
      const root = d && nodes[d.rootNodeId];
      for (const cid of (root?.companyIds || [])) {
        if (companies[cid]) rootCompanyIds.add(cid);
      }
    }
    return Object.values(factories)
      .filter(f => f && f.name && f.status !== "archived" && (!rootCompanyIds.size || rootCompanyIds.has(f.companyId) || f.isFinalAssembly))
      .map(f => ({
        id: String(f.id),
        companyId: f.companyId ? String(f.companyId) : null,
        companyName: companies[f.companyId]?.name || "",
        name: String(f.name).trim(),
        location: String(f.location || "").trim(),
        note: String(f.note || "").trim()
      }));
  }

  /**
   * 仅同步已被销售模块按需关联的 BOM 总装厂基础信息与启停状态（严格按 bomFactoryId 匹配）：
   * - 不自动新建工厂、产品、批次、订单或库存；
   * - 不触碰、不合并、不覆盖已有的未关联或同名销售工厂记录；
   * - 绝不改写 demo 演示工作区。
   */
  function syncLinkedBomFactoryNames(workspace, bomFactories, bomRaw) {
    if (!workspace || !workspace.nodes || workspace.dataSourceMode === "demo") {
      return { workspace, changed: false };
    }
    const rawBom = bomRaw !== undefined
      ? bomRaw
      : (bomFactories === undefined ? readRawBomFromStorage() : null);
    let fullMap = null;
    if (rawBom && typeof rawBom === "object" && rawBom.factories && typeof rawBom.factories === "object") {
      if (global.SCBomFactories?.extractAllFactoriesMap) {
        fullMap = global.SCBomFactories.extractAllFactoriesMap(rawBom);
      } else {
        fullMap = {};
        const comps = rawBom.companies && typeof rawBom.companies === "object" ? rawBom.companies : {};
        for (const fac of Object.values(rawBom.factories)) {
          if (!fac || typeof fac !== "object" || !fac.id) continue;
          const comp = comps[fac.companyId] || null;
          fullMap[String(fac.id)] = {
            id: String(fac.id),
            companyId: fac.companyId ? String(fac.companyId) : null,
            name: String(fac.name || "").trim(),
            location: String(fac.location || "").trim(),
            note: String(fac.note || "").trim(),
            status: (fac.status === "archived" || (comp && comp.status === "archived")) ? "archived" : "active"
          };
        }
      }
    }

    const list = Array.isArray(bomFactories) ? bomFactories : (fullMap ? [] : readBomFinalAssemblyFactories(rawBom));
    const byId = new Map(list.map(f => [String(f.id), f]));
    if (!fullMap && !byId.size) return { workspace, changed: false };

    let changed = false;
    for (const node of Object.values(workspace.nodes)) {
      if (!node || node.kind !== "source" || !node.bomFactoryId) continue;
      const fid = String(node.bomFactoryId);
      const bf = fullMap ? (fullMap[fid] || null) : (byId.get(fid) || null);
      if (!bf) {
        if (fullMap && (node.entityStatus || "active") !== "archived") {
          node.entityStatus = "archived";
          changed = true;
        }
        continue;
      }
      if (bf.name && node.name !== bf.name) {
        node.name = bf.name;
        changed = true;
      }
      if (bf.companyId && node.bomCompanyId !== bf.companyId) {
        node.bomCompanyId = bf.companyId;
        changed = true;
      }
      const nextStatus = bf.status === "archived" ? "archived" : "active";
      if ((node.entityStatus || "active") !== nextStatus) {
        node.entityStatus = nextStatus;
        changed = true;
      }
      if (bf.location !== undefined && String(node.city || "") !== String(bf.location || "")) {
        if (bf.location || fullMap) {
          node.city = String(bf.location || "");
          changed = true;
        }
      }
      if (bf.note && String(node.note || "") !== String(bf.note)) {
        node.note = String(bf.note);
        changed = true;
      }
    }
    return { workspace, changed };
  }

  function createEmptyCurve(id, targetNodeId, kind, initialPoints, horizonDays) {
    return {
      id: id || genId("crv"),
      targetNodeId,
      kind,
      unit: "units/day",
      horizonDays: getTS().requireHorizon(horizonDays === undefined ? 30 : horizonDays, "horizonDays", 365),
      points: Array.isArray(initialPoints) ? clone(initialPoints) : [],
      totalSegments: [],
      importedDailyActuals: []
    };
  }

  function defaultMarketPolicy() {
    return {
      priority: 1,
      lastMileUnitCost: 12,
      fulfillmentUnitCost: 4,
      channelCommissionUnitCost: 15
    };
  }

  function computeDefaultMilestones(departDate, transitDays, customsWaitDays, putawayDays, { overrides = {}, actuals = {} } = {}) {
    const TS = getTS();
    const duration = { transitDays, customsWaitDays, putawayDays };
    const milestones = { departActualDate: actuals.departActualDate ?? null };
    let previous = milestones.departActualDate ?? TS.requireDate(departDate, "发运日期");
    for (const [planField, actualField, , daysField] of SCHEDULE_STAGES) {
      const days = TS.requireDays(duration[daysField] === undefined ? 0 : duration[daysField], daysField);
      const planned = overrides[planField] === undefined ? TS.addDaysToIso(previous, days) : TS.requireDate(overrides[planField], planField);
      milestones[planField] = planned;
      milestones[actualField] = actuals[actualField] ?? null;
      previous = milestones[actualField] ?? planned;
    }
    return milestones;
  }

  function findNodeCurve(workspace, nodeId, kind) {
    return Object.values(workspace.curves || {}).find(c => c.targetNodeId === nodeId && c.kind === kind) || null;
  }

  /**
   * 安全迁移 V1（多情景 + 中转仓 + 相对天数）→ V2（单一正式计划 + 工厂直连市场 + 绝对日期）。
   * 绝不静默删除不兼容的中转仓及相关发运记录，而是先归档保留并给出明确迁移提示。
   */
  function migrateV1ToV2(v1Raw, backupKey) {
    const TS = getTS();
    const base = v1Raw.scenarios?.BASE || Object.values(v1Raw.scenarios || {})[0];
    if (!base) throw new Error("旧版文件缺少 BASE 计划数据，无法迁移");

    const anchorDate = v1Raw.startDate === undefined ? TS.todayLocalIso()
      : TS.requireDate(v1Raw.startDate, "V1.startDate");
    const legacyNumber = (value, field, fallback, read = TS.requireNumber) =>
      read(value === undefined ? fallback : value, `V1.${field}`);

    const nodes = {};
    const removedBuffers = {};
    let srcIdx = 0, mktIdx = 0;
    for (const [id, n] of Object.entries(base.nodes || {})) {
      if (n.kind === "buffer") {
        removedBuffers[id] = clone(n);
        continue;
      }
      if (n.kind === "source" || n.kind === "market") {
        nodes[id] = {
          id,
          kind: n.kind,
          name: n.name,
          region: n.region || "",
          city: n.city || "",
          mapX: n.kind === "source" ? 160 : 820,
          mapY: n.kind === "source" ? (90 + srcIdx++ * 115) : (90 + mktIdx++ * 115),
          bomFactoryId: n.bomFactoryId || null,
          bomCompanyId: n.bomCompanyId || null,
          initialInventory: legacyNumber(n.initialInventory, "n.initialInventory", 0),
          marketPolicy: n.kind === "market" ? { ...defaultMarketPolicy(), ...(n.marketPolicy || {}) } : undefined,
          note: n.note || ""
        };
      }
    }

    // Convert direct source->market routes into reusable lane templates
    const lanes = {};
    for (const [rid, r] of Object.entries(base.routes || {})) {
      if (nodes[r.fromNodeId]?.kind === "source" && nodes[r.toNodeId]?.kind === "market") {
        lanes[rid] = {
          id: rid,
          name: `${nodes[r.fromNodeId].name} → ${nodes[r.toNodeId].name} (${modeLabel(r.mode)})`,
          fromNodeId: r.fromNodeId,
          toNodeId: r.toNodeId,
          defaultMode: r.mode || "sea",
          defaultCarrier: r.carrier || "",
          defaultTransitDays: legacyNumber(r.transitDays, "r.transitDays", 14, TS.requireDays),
          defaultFixedCost: legacyNumber(r.fixedCost, "r.fixedCost", 0),
          defaultUnitCost: legacyNumber(r.unitCost, "r.unitCost", 0),
          defaultOriginPort: "",
          defaultDestinationPort: "",
          defaultCustomsWaitDays: legacyNumber(r.customsWaitDays, "r.customsWaitDays", 3, TS.requireDays),
          defaultPutawayDays: legacyNumber(r.putawayDays, "r.putawayDays", 1, TS.requireDays),
          defaultImportFeeFixed: legacyNumber(r.importFeeFixed, "r.importFeeFixed", 0),
          defaultImportFeePerUnit: legacyNumber(r.importFeePerUnit, "r.importFeePerUnit", 0),
          note: r.note || ""
        };
      }
    }

    // Convert curves for retained nodes from relative days to absolute dates (drop obsolete capacity curves)
    const curves = {};
    for (const [cid, c] of Object.entries(base.curves || {})) {
      if (!nodes[c.targetNodeId] || c.kind === "capacity") continue;
      curves[cid] = {
        id: cid,
        targetNodeId: c.targetNodeId,
        kind: c.kind,
        unit: "units/day",
        horizonDays: TS.requireHorizon(c.horizonDays === undefined ? 60 : c.horizonDays, "V1.horizonDays", 365),
        points: (c.points || []).map(pt => ({
          id: pt.id || genId("pt"),
          date: TS.addDaysToIso(anchorDate, pt.day),
          rate: legacyNumber(pt.rate, "pt.rate")
        })),
        totalSegments: (c.totalSegments || []).map(seg => ({
          id: seg.id || genId("seg"),
          startDate: TS.addDaysToIso(anchorDate, seg.startDay),
          endDate: TS.addDaysToIso(anchorDate, seg.endDay),
          totalQty: legacyNumber(seg.totalQty, "seg.totalQty"),
          distribution: seg.distribution === "custom" ? "custom" : "uniform",
          shapeAnchors: seg.shapeAnchors,
          label: seg.label || "",
          sourcePrecision: "interval_total"
        })),
        importedDailyActuals: (c.importedDailyActuals || []).map(a => ({
          date: a.date === undefined ? TS.addDaysToIso(anchorDate, a.day) : a.date,
          qty: legacyNumber(a.qty, "a.qty"),
          source: "csv_daily_actual"
        }))
      };
    }

    // Convert batches
    const batches = {};
    for (const [bid, b] of Object.entries(base.batches || {})) {
      if (!nodes[b.sourceNodeId]) continue;
      const startDate = TS.addDaysToIso(anchorDate, b.startDay);
      const endDate = TS.addDaysToIso(anchorDate, b.endDay);
      const extra = legacyNumber(b.extraWaitDays, "b.extraWaitDays", 0, TS.requireDays);
      batches[bid] = {
        id: bid,
        code: b.code || bid,
        sourceNodeId: b.sourceNodeId,
        productId: b.productId || v1Raw.activeProductId,
        startDate,
        endDate,
        extraWaitDays: extra,
        availableDate: TS.addDaysToIso(endDate, extra),
        qtyOverride: b.qtyOverride == null ? null : legacyNumber(b.qtyOverride, "batch.qtyOverride"),
        status: b.status === "confirmed" ? "confirmed" : "planned",
        note: b.note || ""
      };
    }

    // Convert shipments (archive buffer-linked ones cleanly without silent deletion!)
    const shipments = {};
    const incompatibleShipments = {};
    for (const [sid, s] of Object.entries(base.shipments || {})) {
      if (nodes[s.fromNodeId]?.kind === "source" && nodes[s.toNodeId]?.kind === "market") {
        const oldRoute = base.routes?.[s.routeId] || {};
        const departDate = TS.addDaysToIso(anchorDate, s.departDay);
        const tDays = legacyNumber(oldRoute.transitDays, "oldRoute.transitDays", 14, TS.requireDays);
        const cDays = legacyNumber(oldRoute.customsWaitDays, "oldRoute.customsWaitDays", 3, TS.requireDays);
        const pDays = legacyNumber(oldRoute.putawayDays, "oldRoute.putawayDays", 1, TS.requireDays);
        const defMs = computeDefaultMilestones(departDate, tDays, cDays, pDays);
        const ms = s.milestones || {};
        shipments[sid] = {
          id: sid,
          code: s.code || sid,
          productId: s.productId || v1Raw.activeProductId,
          laneId: lanes[s.routeId] ? s.routeId : null,
          fromNodeId: s.fromNodeId,
          toNodeId: s.toNodeId,
          batchId: batches[s.batchId] ? s.batchId : null,
          qty: legacyNumber(s.qty, "shipment.qty", undefined, (v, f) => {
            const qty = TS.requireNumber(v, f);
            if (qty <= 0) throw new Error("V1.shipment.qty：发运数量必须大于 0");
            return qty;
          }),
          departDate,
          mode: s.modeOverride || oldRoute.mode || "sea",
          carrier: oldRoute.carrier || "",
          transitDays: tDays,
          fixedCost: legacyNumber(s.fixedCostOverride ?? oldRoute.fixedCost, "shipment.fixedCost", 0),
          unitCost: legacyNumber(s.unitCostOverride ?? oldRoute.unitCost, "shipment.unitCost", 0),
          customsWaitDays: cDays,
          putawayDays: pDays,
          importFeeFixed: legacyNumber(oldRoute.importFeeFixed, "shipment.importFeeFixed", 0),
          importFeePerUnit: legacyNumber(oldRoute.importFeePerUnit, "shipment.importFeePerUnit", 0),
          originPort: "",
          destinationPort: "",
          stopoverPorts: [],
          trackingNumber: "",
          blNumber: "",
          containerNo: "",
          voyageNo: "",
          status: s.status || "planned",
          milestones: {
            departActualDate: s.status === "confirmed" ? departDate : null,
            borderArrivalPlannedDate: ms.borderArrivalPlannedDay != null ? TS.addDaysToIso(anchorDate, ms.borderArrivalPlannedDay) : defMs.borderArrivalPlannedDate,
            borderArrivalActualDate: ms.borderArrivalActualDay != null ? TS.addDaysToIso(anchorDate, ms.borderArrivalActualDay) : null,
            customsReleasePlannedDate: ms.customsReleasePlannedDay != null ? TS.addDaysToIso(anchorDate, ms.customsReleasePlannedDay) : defMs.customsReleasePlannedDate,
            customsReleaseActualDate: ms.customsReleaseActualDay != null ? TS.addDaysToIso(anchorDate, ms.customsReleaseActualDay) : null,
            marketStockAvailablePlannedDate: ms.marketStockAvailablePlannedDay != null ? TS.addDaysToIso(anchorDate, ms.marketStockAvailablePlannedDay) : defMs.marketStockAvailablePlannedDate,
            marketStockAvailableActualDate: ms.marketStockAvailableActualDay != null ? TS.addDaysToIso(anchorDate, ms.marketStockAvailableActualDay) : null
          },
          note: s.note || ""
        };
      } else {
        incompatibleShipments[sid] = clone(s);
      }
    }

    // Convert facts to absolute dates
    const facts = (v1Raw.facts || []).map(f => ({
      eventId: f.eventId || genId("ev"),
      kind: f.kind,
      date: f.date === undefined ? TS.addDaysToIso(anchorDate, f.day) : f.date,
      targetId: f.targetId,
      qty: f.qty === undefined ? undefined : legacyNumber(f.qty, "fact.qty"),
      note: f.note || "",
      recordedAt: f.recordedAt === undefined ? Date.now() : f.recordedAt,
      actor: f.actor || "user",
      supersedesEventId: f.supersedesEventId || null
    }));

    const bufCount = Object.keys(removedBuffers).length;
    const shpCount = Object.keys(incompatibleShipments).length;
    const messages = [];
    if (Object.keys(v1Raw.scenarios || {}).length > 1) {
      messages.push(`已收敛多情景模型，仅保留原正式计划 BASE 作为当前唯一业务计划。`);
    }
    if (bufCount > 0 || shpCount > 0) {
      messages.push(`V0.2 不再建立中转仓库存模型：已将 ${bufCount} 个旧中转仓与 ${shpCount} 笔经中转仓的旧发运记录完整归档至 legacyArchive（未静默丢弃），请核对并按工厂→市场直发重新录入需要保留的发运。`);
    }

    return {
      format: WORLD_FORMAT,
      version: WORLD_VERSION,
      workspaceId: v1Raw.worldId || genId("ws"),
      name: v1Raw.name || "Sales 供应链业务计划",
      dataSourceMode: v1Raw.isDemoData ? "demo" : "live",
      inventoryAnchorDate: anchorDate,
      viewHorizonDays: v1Raw.viewHorizonDays === undefined ? 30
        : TS.requireHorizon(v1Raw.viewHorizonDays, "V1.viewHorizonDays", 180),
      revision: legacyNumber(base.revision, "revision", 1, (v, f) => TS.requireNumber(v, f, { min: 1, integer: true })),
      activeProductId: v1Raw.activeProductId || Object.keys(v1Raw.products || {})[0],
      products: { ...(v1Raw.products || {}) },
      nodes,
      lanes,
      curves,
      batches,
      shipments,
      facts,
      processedActionIds: [],
      actionLog: [],
      migrationNotice: messages.length ? {
        migratedAt: Date.now(),
        fromVersion: 1,
        backupKey: backupKey || null,
        archivedBufferCount: bufCount,
        archivedShipmentCount: shpCount,
        messages,
        dismissed: false
      } : null,
      legacyArchive: (bufCount > 0 || shpCount > 0) ? { removedBuffers, incompatibleShipments } : null
    };
  }

  const SHIPMENT_FACT_FIELDS = Object.freeze({
    shipment_dispatched: "departActualDate",
    border_arrival: "borderArrivalActualDate",
    customs_release: "customsReleaseActualDate",
    market_stock_available: "marketStockAvailableActualDate"
  });

  function factTargetCollection(kind) {
    if (kind === "production_confirmed") return "batches";
    if (kind === "inventory_stocktake") return "nodes";
    return Object.hasOwn(SHIPMENT_FACT_FIELDS, kind) ? "shipments" : null;
  }

  function factKey(fact) {
    return JSON.stringify([fact.targetId, fact.kind, fact.kind === "inventory_stocktake" ? fact.date : null]);
  }

  function getEffectiveFacts(workspace) {
    const byId = new Map();
    const effective = new Map();
    for (const fact of Array.isArray(workspace.facts) ? workspace.facts : []) {
      if (!fact) continue;
      const original = byId.get(fact.supersedesEventId);
      if (original && original.targetId === fact.targetId && original.kind === fact.kind) {
        const key = factKey(original);
        if (effective.get(key) === original) effective.delete(key);
      }
      // Legacy workspaces may contain repeated confirmations without correction links.
      effective.set(factKey(fact), fact);
      byId.set(fact.eventId, fact);
    }
    return [...effective.values()];
  }

  function findEffectiveFact(workspace, targetId, kind, date) {
    return getEffectiveFacts(workspace).find(f => f.targetId === targetId && f.kind === kind
      && (kind !== "inventory_stocktake" || f.date === date));
  }

  function projectShipmentFact(shipment, fact) {
    const field = SHIPMENT_FACT_FIELDS[fact.kind];
    if (fact.kind === "shipment_dispatched" && shipment.status !== "confirmed") {
      shipment.departPlannedDate ??= shipment.departDate;
    }
    shipment.milestones = shipment.milestones || {};
    shipment.milestones[field] = fact.date;
    if (shipment.status === "cancelled") shipment.status = "planned";
    if (fact.kind === "shipment_dispatched") {
      if (!shipment.originMonth && shipment.departDate) shipment.originMonth = shipment.departDate.slice(0, 7);
      shipment.status = "confirmed";
      shipment.departDate = fact.date;
      if (Number.isFinite(fact.qty) && fact.qty > 0) shipment.qty = fact.qty;
    }
  }

  function getBatchQuantity(workspace, batch) {
    if (batch.qtyOverride != null) return getTS().requireNumber(batch.qtyOverride, "批次数量 (qtyOverride)");
    const curve = findNodeCurve(workspace, batch.sourceNodeId, "production");
    return curve ? getTS().integrateCurveByDates(curve, batch.startDate, batch.endDate) : 0;
  }

  // The ledger overrides entity actuals. Legacy actuals without ledger entries remain readable.
  function projectFacts(workspace) {
    const TS = getTS();
    for (const fact of getEffectiveFacts(workspace)) {
      const collection = factTargetCollection(fact.kind);
      const entity = collection && Object.hasOwn(workspace[collection], fact.targetId) && workspace[collection][fact.targetId];
      if (!entity) continue;
      if (collection === "shipments") {
        projectShipmentFact(entity, fact);
      } else if (collection === "batches") {
        entity.status = "confirmed";
        entity.qtyOverride = Number.isFinite(fact.qty) && fact.qty >= 0
          ? fact.qty : getBatchQuantity(workspace, entity);
        entity.availableDate = TS.addDaysToIso(fact.date, entity.extraWaitDays ?? 0);
      }
    }
    for (const batch of Object.values(workspace.batches)) {
      if (batch.status === "confirmed" && batch.qtyOverride == null) {
        batch.qtyOverride = getBatchQuantity(workspace, batch);
      }
    }
    return workspace;
  }

  function hasShipmentActuals(shipment) {
    return Boolean(shipment.status === "confirmed"
      || Object.values(SHIPMENT_FACT_FIELDS).some(field => shipment.milestones?.[field])
      || shipment.stopoverPorts?.some(port => port?.actualDate));
  }

  function sameValue(a, b) {
    if (a === b) return true;
    if (!a || !b || typeof a !== "object" || typeof b !== "object" || Array.isArray(a) !== Array.isArray(b)) return false;
    if (Array.isArray(a) && a.length !== b.length) return false;
    const keys = Object.keys(a).filter(key => a[key] !== undefined);
    return keys.length === Object.keys(b).filter(key => b[key] !== undefined).length
      && keys.every(key => Object.hasOwn(b, key) && sameValue(a[key], b[key]));
  }

  function assertProtectedEntities(before, after, expected = before) {
    const protectedIds = { nodes: new Set(), batches: new Set(), shipments: new Set(), lanes: new Set(), products: new Set() };
    for (const fact of before.facts || []) {
      const collection = fact && factTargetCollection(fact.kind);
      if (collection) protectedIds[collection].add(fact.targetId);
    }
    for (const shipment of Object.values(before.shipments)) {
      if (hasShipmentActuals(shipment)) protectedIds.shipments.add(shipment.id);
    }
    for (const id of protectedIds.shipments) {
      const shipment = before.shipments[id];
      if (!shipment) continue;
      protectedIds.nodes.add(shipment.fromNodeId).add(shipment.toNodeId);
      if (shipment.batchId) protectedIds.batches.add(shipment.batchId);
      if (shipment.laneId) protectedIds.lanes.add(shipment.laneId);
      if (shipment.productId) protectedIds.products.add(shipment.productId);
    }
    for (const batch of Object.values(before.batches)) {
      if (batch.status === "confirmed") protectedIds.batches.add(batch.id);
    }
    for (const id of protectedIds.batches) {
      const batch = before.batches[id];
      if (!batch) continue;
      protectedIds.nodes.add(batch.sourceNodeId);
      if (batch.productId) protectedIds.products.add(batch.productId);
    }

    const identityFields = {
      nodes: ["id", "kind", "bomFactoryId", "sharedFactoryId"],
      batches: ["id", "sourceNodeId", "productId"],
      shipments: ["id", "status", "fromNodeId", "toNodeId", "batchId", "laneId", "productId", "qty", "departDate"],
      lanes: ["id"],
      products: ["productId"]
    };
    for (const [collection, ids] of Object.entries(protectedIds)) {
      for (const id of ids) {
        if (!Object.hasOwn(before[collection], id)) continue; // A legacy backup can already contain a missing reference.
        const prior = expected[collection][id];
        const next = after[collection][id];
        const protectedBatchChanged = collection === "batches" && before.batches[id].status === "confirmed" && !sameValue(prior, next);
        const shipmentActualsChanged = collection === "shipments" && (
          (prior.originMonth && prior.originMonth !== next?.originMonth)
          || Object.values(SHIPMENT_FACT_FIELDS).some(field => !sameValue(prior.milestones?.[field], next?.milestones?.[field]))
          || !sameValue(
            (prior.stopoverPorts || []).filter(port => port?.actualDate),
            (next?.stopoverPorts || []).filter(port => port?.actualDate)
          )
        );
        if (!next || protectedBatchChanged || shipmentActualsChanged
          || identityFields[collection].some(field => !sameValue(prior[field], next[field]))) {
          throw new Error(`「${prior.code || prior.name || id}」关联已确认业务事实，无法删除或改写历史；请使用事实账本更正或在 BOM 中归档关联工厂`);
        }
      }
    }
  }

  function missingReferences(workspace) {
    const missing = new Set();
    function check(owner, collection, id, kind) {
      const entity = Object.hasOwn(workspace[collection], id) && workspace[collection][id];
      if (!entity || (kind && entity.kind !== kind)) missing.add(JSON.stringify([owner, collection, id, kind]));
    }
    if (workspace.activeProductId) check("当前产品", "products", workspace.activeProductId);
    for (const curve of Object.values(workspace.curves)) check(`曲线 ${curve.id}`, "nodes", curve.targetNodeId);
    for (const lane of Object.values(workspace.lanes)) {
      check(`物流方案 ${lane.id}`, "nodes", lane.fromNodeId, "source");
      check(`物流方案 ${lane.id}`, "nodes", lane.toNodeId, "market");
    }
    for (const batch of Object.values(workspace.batches)) {
      check(`批次 ${batch.id}`, "nodes", batch.sourceNodeId, "source");
      if (batch.productId) check(`批次 ${batch.id}`, "products", batch.productId);
    }
    for (const shipment of Object.values(workspace.shipments)) {
      check(`发运 ${shipment.id}`, "nodes", shipment.fromNodeId, "source");
      check(`发运 ${shipment.id}`, "nodes", shipment.toNodeId, "market");
      if (shipment.batchId) check(`发运 ${shipment.id}`, "batches", shipment.batchId);
      if (shipment.laneId) check(`发运 ${shipment.id}`, "lanes", shipment.laneId);
      if (shipment.productId) check(`发运 ${shipment.id}`, "products", shipment.productId);
    }
    for (const fact of workspace.facts || []) {
      const collection = fact && factTargetCollection(fact.kind);
      if (!collection) continue;
      if (collection === "nodes" && workspace.legacyArchive?.removedBuffers?.[fact.targetId]) continue;
      if (collection === "shipments" && workspace.legacyArchive?.incompatibleShipments?.[fact.targetId]) continue;
      check(`事实 ${fact.eventId}`, collection, fact.targetId);
    }
    return missing;
  }

  function assertNoNewMissingReferences(before, after) {
    const nextMissing = missingReferences(after);
    if (!nextMissing.size) return;
    const priorMissing = missingReferences(before);
    for (const key of nextMissing) {
      if (priorMissing.has(key)) continue;
      const [owner, , id] = JSON.parse(key);
      throw new Error(`${owner} 引用的实体「${id}」不存在，操作已取消`);
    }
  }

  function assertLegacyFactValues(workspace, kind, targetId, date, qty) {
    const field = SHIPMENT_FACT_FIELDS[kind];
    const shipment = field && workspace.shipments[targetId];
    const shipDate = shipment && (shipment.milestones?.[field]
      || (field === "departActualDate" && shipment.status === "confirmed" ? shipment.departDate : null));
    const batch = kind === "production_confirmed" && workspace.batches[targetId];
    const changedShip = shipDate && (shipDate !== date || (field === "departActualDate" && qty != null && shipment.qty !== qty));
    const changedBatch = batch?.status === "confirmed"
      && (getTS().addDaysToIso(date, batch.extraWaitDays ?? 0) !== batch.availableDate
        || (qty != null && qty !== getBatchQuantity(workspace, batch)));
    if (changedShip || changedBatch) {
      throw new Error("已有历史实绩，请先按原值登记事实，再通过事实账本更正");
    }
  }

  function assertWorkspaceReplacement(before, after) {
    if (before.dataSourceMode === "demo") return;
    const archiveCollections = ["removedBuffers", "incompatibleShipments"];
    const hasArchive = archiveCollections.some(key => Object.keys(before.legacyArchive?.[key] || {}).length);
    const hasHistory = hasArchive || before.facts.length || Object.values(before.shipments).some(hasShipmentActuals)
      || Object.values(before.batches).some(batch => batch.status === "confirmed");
    if (hasHistory && (after.dataSourceMode === "demo" || before.workspaceId !== after.workspaceId)) {
      throw new Error("当前工作区含已确认业务历史，请使用本工作区完整的业务备份恢复");
    }
    if (before.facts.some((fact, index) => !sameValue(fact, after.facts[index]))) {
      throw new Error("替换工作区会移除或覆盖已确认事实，请使用包含完整事实历史的备份");
    }
    if (hasArchive && archiveCollections.some(key => Object.entries(before.legacyArchive[key] || {})
      .some(([id, record]) => !sameValue(record, after.legacyArchive?.[key]?.[id])))) {
      throw new Error("替换工作区会移除或覆盖已归档的历史记录");
    }
    if (hasHistory) {
      const eventIds = new Set(before.facts.filter(Boolean).map(fact => fact.eventId));
      const effective = new Map(getEffectiveFacts(before).map(fact => [factKey(fact), fact]));
      for (const fact of after.facts.slice(before.facts.length)) {
        if (!fact?.eventId || eventIds.has(fact.eventId)) {
          throw new Error("备份中的新增事实事件 ID 无效或重复");
        }
        if (!factTargetCollection(fact.kind) || getTS().parseIsoDateUtc(fact.date) === null
          || (fact.qty == null ? fact.kind === "inventory_stocktake"
            : !Number.isFinite(fact.qty) || fact.qty < 0 || (fact.kind === "shipment_dispatched" && fact.qty === 0))) {
          throw new Error("备份中的新增事实日期或数量无效");
        }
        const key = factKey(fact);
        if (fact.supersedesEventId) {
          const original = [...effective.values()].find(prior => prior.eventId === fact.supersedesEventId);
          if (!original || original.kind !== fact.kind || original.targetId !== fact.targetId) {
            throw new Error("备份中的事实更正链无效");
          }
          effective.delete(factKey(original));
        }
        if (effective.has(key)) throw new Error("备份中的事实绕过了台账更正");
        if (!fact.supersedesEventId) assertLegacyFactValues(before, fact.kind, fact.targetId, fact.date, fact.qty);
        effective.set(key, fact);
        eventIds.add(fact.eventId);
      }
    }

    // Compare the materialized actuals with any newer corrections in the incoming ledger.
    const expected = projectFacts({ ...clone(before), facts: after.facts });
    assertProtectedEntities(before, after, expected);
    assertNoNewMissingReferences(before, after);
  }

  function assertDateOrder(previous, date, field) {
    if (previous && date < previous) throw new Error(`${field}：日期不得早于上一里程碑 (${previous})`);
  }

  // Check newly supplied estimates against the latest known preceding stage.
  // An actual at the current stage supersedes its estimate in the next step.
  function assertShipmentSchedule(shipment, supplied = {}) {
    const milestones = shipment.milestones || {};
    let previous = milestones.departActualDate || shipment.departDate;
    for (const [planField, actualField, , daysField] of SCHEDULE_STAGES) {
      const date = milestones[planField] ?? getTS().addDaysToIso(previous, shipment[daysField] ?? 0);
      if (!milestones[actualField] || supplied[planField] !== undefined) {
        assertDateOrder(previous, date, planField);
      }
      previous = milestones[actualField] || date;
    }
    getTS().addDaysToIso(milestones.marketStockAvailablePlannedDate ?? previous, 1);
  }

  function requireShapeAnchors(anchors) {
    if (!Array.isArray(anchors)) throw new Error("shapeAnchors：应为数组");
    const TS = getTS();
    return anchors.map((anchor, i) => ({
      t: TS.requireNumber(anchor?.t, `shapeAnchors[${i}].t`, { max: 1 }),
      weight: TS.requireNumber(anchor?.weight, `shapeAnchors[${i}].weight`)
    }));
  }

  function readStopoverPorts(ports) {
    if (!Array.isArray(ports)) throw new Error("停靠港应为列表");
    return ports.map((port, index) => {
      if (typeof port?.port !== "string" || !port.port.trim()) {
        throw new Error(`停靠港 ${index + 1}：请填写港口名称`);
      }
      for (const field of ["plannedDate", "actualDate"]) {
        if (port[field] != null) getTS().requireDate(port[field], `停靠港 ${index + 1}.${field}`);
      }
      return { ...port };
    });
  }

  function requireMode(mode) {
    if (!TRANSPORT_MODES.some(item => item.key === mode)) throw new Error("运输方式无效");
    return mode;
  }

  // Read stored numeric values in their canonical JSON type. Optional fields
  // only accept null where the model explicitly defines it as meaningful.
  function assertBusinessData(w, { projected = false } = {}) {
    const TS = getTS();
    function record(value, path) {
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${path}：应为对象`);
      return value;
    }
    function list(value, path) {
      if (!Array.isArray(value)) throw new Error(`${path}：应为数组`);
      return value;
    }
    function num(value, path, read = TS.requireNumber) {
      if (typeof value !== "number") throw new Error(`${path}：应为数字`);
      return read(value, path);
    }
    function fields(obj, path, keys, read, nullable = false) {
      for (const field of keys) {
        const value = obj[field];
        if (value !== undefined && !(nullable && value === null)) num(value, `${path}.${field}`, read);
      }
    }
    function dates(obj, path, keys, nullable = false) {
      for (const field of keys) {
        const value = obj[field];
        if (value !== undefined && !(nullable && value === null)) TS.requireDate(value, `${path}.${field}`);
      }
    }
    function intervalsDoNotOverlap(items, path) {
      const sorted = items.slice().sort((a, b) => a.startDate.localeCompare(b.startDate));
      for (let i = 1; i < sorted.length; i++) {
        if (sorted[i].startDate < sorted[i - 1].endDate) throw new Error(`${path}：区间不可重叠`);
      }
    }
    function sequence(obj, start, keys, path) {
      let previous = start;
      for (const field of keys) {
        if (obj[field] == null) continue;
        assertDateOrder(previous, obj[field], `${path}.${field}`);
        previous = obj[field];
      }
    }
    function interval(obj, path) {
      TS.requireDate(obj.startDate, `${path}.startDate`);
      TS.requireDate(obj.endDate, `${path}.endDate`);
      if (obj.endDate <= obj.startDate) throw new Error(`${path}.endDate：结束日期必须晚于起始日期`);
    }
    if (w.inventoryAnchorDate !== undefined) TS.requireDate(w.inventoryAnchorDate, "inventoryAnchorDate");
    fields(w, "workspace", ["viewHorizonDays"], (v, f) => TS.requireHorizon(v, f, 180));
    fields(w, "workspace", ["revision"], (v, f) => TS.requireNumber(v, f, { min: 1, integer: true }));
    for (const [id, p] of Object.entries(record(w.products ?? {}, "products"))) {
      const path = `products.${id}`;
      record(p, path);
      fields(p, path, ["unitManufacturingCost"]);
      fields(p, path, ["bomVersion"], (v, f) => TS.requireNumber(v, f, { integer: true }), true);
    }
    for (const [id, n] of Object.entries(record(w.nodes ?? {}, "nodes"))) {
      const path = `nodes.${id}`;
      record(n, path);
      if (n.kind !== "source" && n.kind !== "market") throw new Error(`${path}：仅支持工厂与目标市场`);
      fields(n, path, ["initialInventory", "mapX", "mapY"]);
      if (n.marketPolicy !== undefined) {
        const policy = record(n.marketPolicy, `${path}.marketPolicy`);
        fields(policy, `${path}.marketPolicy`, ["priority"], (v, f) => TS.requireNumber(v, f, { min: 1, integer: true }));
        fields(policy, `${path}.marketPolicy`, ["lastMileUnitCost", "fulfillmentUnitCost", "channelCommissionUnitCost", "initialUnfulfilledDemand"]);
        fields(policy, `${path}.marketPolicy`, ["orderToShipToleranceDays", "orderToDeliveryToleranceDays", "orderProcessingDays", "lastMileDays"], TS.requireDays);
      }
    }
    for (const [id, lane] of Object.entries(record(w.lanes ?? {}, "lanes"))) {
      const path = `lanes.${id}`;
      record(lane, path);
      fields(lane, path, ["defaultTransitDays", "defaultCustomsWaitDays", "defaultPutawayDays"], TS.requireDays);
      fields(lane, path, ["defaultFixedCost", "defaultUnitCost", "defaultImportFeeFixed", "defaultImportFeePerUnit"]);
      if (lane.defaultMode !== undefined) requireMode(lane.defaultMode);
    }
    for (const [id, curve] of Object.entries(record(w.curves ?? {}, "curves"))) {
      const path = `curves.${id}`;
      record(curve, path);
      if (curve.kind === "capacity") continue; // Deprecated V1/V2 curve, removed by the loader.
      if (!["production", "demand"].includes(curve.kind)) throw new Error(`${path}.kind：曲线类型无效`);
      fields(curve, path, ["horizonDays"], (v, f) => TS.requireHorizon(v, f, 365));
      const pointDates = new Set();
      for (const [i, point] of list(curve.points ?? [], `${path}.points`).entries()) {
        TS.requireDate(point?.date, `${path}.points[${i}].date`);
        if (pointDates.has(point.date)) throw new Error(`${path}.points[${i}].date：控制点日期重复`);
        pointDates.add(point.date);
        num(point.rate, `${path}.points[${i}].rate`);
      }
      const segments = list(curve.totalSegments ?? [], `${path}.totalSegments`);
      for (const [i, segment] of segments.entries()) {
        const segmentPath = `${path}.totalSegments[${i}]`;
        interval(record(segment, segmentPath), segmentPath);
        num(segment.totalQty, `${segmentPath}.totalQty`);
        if (segment.shapeAnchors !== undefined) {
          for (const [j, anchor] of list(segment.shapeAnchors, `${segmentPath}.shapeAnchors`).entries()) {
            num(anchor?.t, `${segmentPath}.shapeAnchors[${j}].t`, (v, f) => TS.requireNumber(v, f, { max: 1 }));
            num(anchor?.weight, `${segmentPath}.shapeAnchors[${j}].weight`);
          }
        }
      }
      if (segments.length > 1) intervalsDoNotOverlap(segments, `${path}.totalSegments`);
      const actualDates = new Set();
      for (const [i, actual] of list(curve.importedDailyActuals ?? [], `${path}.importedDailyActuals`).entries()) {
        TS.requireDate(actual?.date, `${path}.importedDailyActuals[${i}].date`);
        if (actualDates.has(actual.date)) throw new Error(`${path}.importedDailyActuals[${i}].date：实绩日期重复`);
        actualDates.add(actual.date);
        num(actual.qty, `${path}.importedDailyActuals[${i}].qty`);
      }
    }
    const productionFactTargets = new Set((Array.isArray(w.facts) ? w.facts : [])
      .filter(fact => fact?.kind === "production_confirmed").map(fact => fact.targetId));
    const batchesBySource = new Map();
    for (const [id, batch] of Object.entries(record(w.batches ?? {}, "batches"))) {
      const path = `batches.${id}`;
      interval(record(batch, path), path);
      if (!batchesBySource.has(batch.sourceNodeId)) batchesBySource.set(batch.sourceNodeId, []);
      batchesBySource.get(batch.sourceNodeId).push(batch);
      fields(batch, path, ["extraWaitDays"], TS.requireDays);
      fields(batch, path, ["qtyOverride"], TS.requireNumber, true);
      dates(batch, path, ["availableDate"]);
      // Actual completion can occur earlier or later than planned.
      if (batch.status !== "confirmed" && !productionFactTargets.has(id)) {
        const expected = TS.addDaysToIso(batch.endDate, batch.extraWaitDays ?? 0);
        if (batch.availableDate !== undefined && batch.availableDate !== expected) {
          throw new Error(`${path}.availableDate：应为批次结束日期加等待天数 (${expected})`);
        }
      }
    }
    for (const [source, batches] of batchesBySource) {
      if (batches.length > 1) intervalsDoNotOverlap(batches, `batches.${source}`);
    }
    for (const [id, shp] of Object.entries(record(w.shipments ?? {}, "shipments"))) {
      const path = `shipments.${id}`;
      record(shp, path);
      TS.requireDate(shp.departDate, `${path}.departDate`);
      dates(shp, path, ["departPlannedDate"]);
      num(shp.qty, `${path}.qty`, (v, f) => TS.requireQuantity(v, f, true));
      fields(shp, path, ["allocationPct"], v => TS.requireAllocationPct(v), true);
      fields(shp, path, ["transitDays", "customsWaitDays", "putawayDays"], TS.requireDays);
      fields(shp, path, ["fixedCost", "unitCost", "importFeeFixed", "importFeePerUnit"]);
      if (shp.mode !== undefined) requireMode(shp.mode);
      const ms = record(shp.milestones ?? {}, `${path}.milestones`);
      dates(ms, `${path}.milestones`, SCHEDULE_STAGES.map(stage => stage[0]));
      dates(ms, `${path}.milestones`, ["departActualDate", ...SCHEDULE_STAGES.map(stage => stage[1])], true);
      for (const [i, port] of list(shp.stopoverPorts ?? [], `${path}.stopoverPorts`).entries()) {
        const portPath = `${path}.stopoverPorts[${i}]`;
        dates(record(port, portPath), portPath, ["plannedDate", "actualDate"], true);
      }
      if (shp.originalPlan != null) {
        const original = record(shp.originalPlan, `${path}.originalPlan`);
        dates(original, `${path}.originalPlan`, ["departDate", ...SCHEDULE_STAGES.map(stage => stage[0])], true);
        fields(original, `${path}.originalPlan`, ["transitDays", "customsWaitDays", "putawayDays"], TS.requireDays);
        fields(original, `${path}.originalPlan`, ["capturedAt"], (v, f) => TS.requireNumber(v, f, { integer: true }));
      }
      if (shp.revisedEstimate != null) {
        const estimate = record(shp.revisedEstimate, `${path}.revisedEstimate`);
        dates(estimate, `${path}.revisedEstimate`, SCHEDULE_STAGES.map(stage => stage[2]));
        fields(estimate, `${path}.revisedEstimate`, ["updatedAt"], (v, f) => TS.requireNumber(v, f, { integer: true }));
      }
      // Legacy estimates can predate a later actual. Validate the all-planned
      // chain separately and never infer actuals from estimates.
      if (!hasShipmentActuals(shp)) {
        assertShipmentSchedule(shp);
        if (shp.originalPlan) {
          sequence(shp.originalPlan, shp.originalPlan.departDate, SCHEDULE_STAGES.map(stage => stage[0]), `${path}.originalPlan`);
        }
        if (shp.revisedEstimate) {
          sequence(shp.revisedEstimate, null, SCHEDULE_STAGES.map(stage => stage[2]), `${path}.revisedEstimate`);
        }
      } else {
        let previous = null;
        for (const [plan, actual] of SCHEDULE_STAGES) {
          if (ms[actual]) {
            previous = null;
          } else if (ms[plan]) {
            assertDateOrder(previous, ms[plan], `${path}.milestones.${plan}`);
            previous = ms[plan];
          }
        }
      }
      if (projected) {
        let previous = ms.departActualDate || (shp.status === "confirmed" ? shp.departDate : null);
        for (const [, field] of SCHEDULE_STAGES) {
          if (!ms[field]) continue;
          assertDateOrder(previous, ms[field], `${path}.milestones.${field}`);
          previous = ms[field];
        }
      }
      if (ms.marketStockAvailablePlannedDate) TS.addDaysToIso(ms.marketStockAvailablePlannedDate, 1);
      if (ms.marketStockAvailableActualDate) TS.addDaysToIso(ms.marketStockAvailableActualDate, 1);
    }
    for (const [i, fact] of list(w.facts ?? [], "facts").entries()) {
      const path = `facts[${i}]`;
      record(fact, path);
      if (!factTargetCollection(fact.kind)) throw new Error(`${path}.kind：事实类型无效`);
      TS.requireDate(fact.date, `${path}.date`);
      if (fact.qty !== undefined || fact.kind === "inventory_stocktake") {
        num(fact.qty, `${path}.qty`, (v, f) => TS.requireQuantity(v, f, fact.kind === "shipment_dispatched"));
      }
      fields(fact, path, ["recordedAt"], (v, f) => TS.requireNumber(v, f, { integer: true }));
    }
  }

  /**
   * 校验并规范化 SalesWorkspace（自动兼容迁移 V1 备份文件）。
   */
  function validateWorkspace(raw, options) {
    const TS = getTS();
    if (!raw || typeof raw !== "object" || raw.format !== WORLD_FORMAT) {
      throw new Error("请选择本工作台导出的供应链 JSON 备份文件（format: sc-sales-world）");
    }
    if (raw.version === 1 || (raw.scenarios && raw.scenarios.BASE)) {
      return validateWorkspace(migrateV1ToV2(raw, options?.backupKey || null));
    }
    if (raw.version !== 2) {
      throw new Error(`不支持的备份版本：v${raw.version}`);
    }
    assertBusinessData(raw);
    const w = clone(raw);
    w.products = (w.products && typeof w.products === "object" && !Array.isArray(w.products)) ? w.products : {};
    w.workspaceId = w.workspaceId || genId("ws");
    w.dataSourceMode = w.dataSourceMode === "demo" ? "demo" : "live";
    w.inventoryAnchorDate ??= TS.todayLocalIso();
    w.viewHorizonDays ??= 30;
    w.revision ??= 1;
    w.nodes = w.nodes || {};
    w.lanes = w.lanes || {};
    w.curves = w.curves || {};
    w.batches = w.batches || {};
    w.shipments = w.shipments || {};
    w.facts = Array.isArray(w.facts) ? w.facts : [];
    w.processedActionIds = Array.isArray(w.processedActionIds) ? w.processedActionIds : [];
    w.actionLog = Array.isArray(w.actionLog) ? w.actionLog : [];

    for (const [id, curve] of Object.entries(w.curves)) {
      if (curve.kind === "capacity") {
        delete w.curves[id];
      } else {
        curve.horizonDays ??= 30;
        curve.points ??= [];
        curve.totalSegments ??= [];
        curve.importedDailyActuals ??= [];
      }
    }
    const productKeys = Object.keys(w.products);
    if (!w.activeProductId || !w.products[w.activeProductId]) {
      w.activeProductId = productKeys[0] || null;
    }
    projectFacts(w);
    assertBusinessData(w, { projected: true });
    return w;
  }

  /**
   * 同步共享实体注册表（公司、工厂、真实 BOM 成品）到正式 Sales 工作区（幂等、绝不生成虚构产品/市场/排产）。
   * - 工厂改名时按稳定 sharedFactoryId / bomFactoryId 原地更新名称，不改变 node.id，历史批次与发运引用永不断裂。
   * - 工厂停用/归档时同步 entityStatus="archived"，完整保留历史批次、发运、库存与事实。
   */
  function syncSharedEntitiesIntoWorkspace(workspace, sharedRegistry, bomRaw) {
    if (!workspace || workspace.dataSourceMode === "demo") {
      return { workspace, changed: false };
    }
    const reg = sharedRegistry || (global.SCShared ? global.SCShared.loadRegistry().registry : null);
    const bom = bomRaw !== undefined ? bomRaw : readRawBomFromStorage();
    // 轻量对接模式：无外部共享注册表时，仅同步已按 bomFactoryId 关联的总装厂名称/地点/启停状态，绝不自动生成产品/工厂/库存
    if (!reg) {
      return syncLinkedBomFactoryNames(workspace, readBomFinalAssemblyFactories(bom), bom);
    }
    let changed = false;

    const rootCompanyIds = new Set();
    const hasBomDiagrams = Boolean(bom && Array.isArray(bom.diagrams) && bom.diagrams.length > 0);
    if (hasBomDiagrams) {
      for (const d of bom.diagrams) {
        const root = bom.nodes?.[d.rootNodeId];
        for (const cid of (root?.companyIds || [])) rootCompanyIds.add(cid);
      }
    }

    // 1. Sync shared factories -> Sales source nodes
    const factoriesToProcess = reg && reg.factories ? Object.values(reg.factories) : [];
    const seenSharedIds = new Set();

    for (const fac of factoriesToProcess) {
      seenSharedIds.add(fac.id);
      // Find existing Sales node by stable ID only (sharedFactoryId > bomFactoryId > salesNodeId)
      const existing = Object.values(workspace.nodes).find(
        n => n.kind === "source" && (
          n.sharedFactoryId === fac.id ||
          (fac.bomFactoryId && n.bomFactoryId === fac.bomFactoryId) ||
          (fac.salesNodeId && n.id === fac.salesNodeId)
        )
      );

      const eligibleForSales = Boolean(
        existing ||
        fac.isFinalAssembly ||
        !hasBomDiagrams ||
        (fac.bomCompanyId && rootCompanyIds.has(fac.bomCompanyId))
      );
      if (!eligibleForSales) continue;

      if (existing) {
        const nextStatus = fac.status === "archived" ? "archived" : "active";
        if (
          existing.name !== fac.name ||
          existing.sharedFactoryId !== fac.id ||
          existing.sharedCompanyId !== (fac.companyId || null) ||
          existing.bomFactoryId !== (fac.bomFactoryId || null) ||
          existing.bomCompanyId !== (fac.bomCompanyId || null) ||
          (existing.entityStatus || "active") !== nextStatus
        ) {
          existing.name = fac.name;
          existing.sharedFactoryId = fac.id;
          existing.sharedCompanyId = fac.companyId || null;
          existing.bomFactoryId = fac.bomFactoryId || null;
          existing.bomCompanyId = fac.bomCompanyId || null;
          existing.entityStatus = nextStatus;
          if (fac.region && !existing.region) existing.region = fac.region;
          if (fac.city && !existing.city) existing.city = fac.city;
          changed = true;
        }
      } else if (fac.status !== "archived") {
        const srcCount = Object.values(workspace.nodes).filter(n => n.kind === "source").length;
        const candidateId = fac.salesNodeId || (fac.bomFactoryId ? `src_${fac.bomFactoryId}` : genId("src"));
        const nodeId = workspace.nodes[candidateId] ? genId("src") : candidateId;
        workspace.nodes[nodeId] = {
          id: nodeId,
          kind: "source",
          name: fac.name,
          region: fac.region || "CN",
          city: fac.city || "",
          mapX: 165,
          mapY: 110 + srcCount * 105,
          sharedFactoryId: fac.id,
          sharedCompanyId: fac.companyId || null,
          bomFactoryId: fac.bomFactoryId || null,
          bomCompanyId: fac.bomCompanyId || null,
          entityStatus: "active",
          initialInventory: 0,
          note: fac.note || ""
        };
        if (!findNodeCurve(workspace, nodeId, "production")) {
          const crvId = `crv_${nodeId}_prod`;
          workspace.curves[crvId] = createEmptyCurve(crvId, nodeId, "production", [], 30);
        }
        changed = true;
      }
    }

    // If a Sales factory node had NO operational history and was deleted from BOM/shared registry, clean it up safely.
    if (reg && reg.factories) {
      for (const [nid, n] of Object.entries(workspace.nodes)) {
        if (n.kind !== "source") continue;
        if (!n.sharedFactoryId && !n.bomFactoryId) continue;
        const stillExists = (n.sharedFactoryId && reg.factories[n.sharedFactoryId]) ||
          (n.bomFactoryId && Object.values(reg.factories).some(f => f.bomFactoryId === n.bomFactoryId));
        if (!stillExists) {
          const hasBatch = Object.values(workspace.batches || {}).some(b => b.sourceNodeId === nid);
          const hasShp = Object.values(workspace.shipments || {}).some(s => s.fromNodeId === nid);
          const hasLane = Object.values(workspace.lanes || {}).some(l => l.fromNodeId === nid);
          const hasFact = (workspace.facts || []).some(f => f.targetId === nid);
          const hasInv = Number(n.initialInventory) > 0;
          if (!hasBatch && !hasShp && !hasLane && !hasFact && !hasInv) {
            delete workspace.nodes[nid];
            for (const [cid, c] of Object.entries(workspace.curves || {})) {
              if (c.targetNodeId === nid) delete workspace.curves[cid];
            }
            changed = true;
          } else if (n.entityStatus !== "archived") {
            n.entityStatus = "archived";
            changed = true;
          }
        }
      }
    }

    // 2. Sync real BOM finished products (only when BOM diagrams actually exist; never fabricate!)
    if (hasBomDiagrams) {
      const cat = extractBomCatalog(bom, "localStorage:bom-flow-sim-v5");
      for (const bp of (cat?.products || [])) {
        const existingProd = Object.values(workspace.products).find(p => p.bomDiagramId === bp.diagramId);
        if (existingProd) {
          if (existingProd.name !== bp.name || existingProd.bomMaterialId !== bp.materialId) {
            existingProd.name = bp.name;
            existingProd.bomMaterialId = bp.materialId;
            if (bp.unit) existingProd.unit = bp.unit;
            changed = true;
          }
        } else {
          const pid = workspace.products[bp.skuCode] ? `bom_${bp.diagramId}` : bp.skuCode;
          workspace.products[pid] = {
            productId: pid,
            skuCode: bp.skuCode,
            name: bp.name,
            unit: bp.unit || "units",
            bomDiagramId: bp.diagramId,
            bomMaterialId: bp.materialId,
            bomVersion: bp.bomVersion || 7,
            unitManufacturingCost: 0,
            costSource: "bom_linked",
            note: bp.note || ""
          };
          if (!workspace.activeProductId) workspace.activeProductId = pid;
          changed = true;
        }
      }
    }

    return { workspace, changed };
  }

  /**
   * 从共享实体层构建真实空白的销售工作区：
   * - 即使没有建立任何产品 BOM，也能直接识别已创建的总装厂；
   * - 绝不自动生成虚构的产品、生产批次、库存、排产曲线或目标市场。
   */
  function createLiveWorkspaceFromShared(sharedRegistry, bomRaw, todayIso) {
    const TS = getTS();
    const today = todayIso || TS.todayLocalIso();
    const ws = {
      format: WORLD_FORMAT,
      version: WORLD_VERSION,
      workspaceId: genId("ws_live"),
      name: "Sales & Operations Workspace",
      dataSourceMode: "live",
      inventoryAnchorDate: today,
      viewHorizonDays: 30,
      revision: 1,
      activeProductId: null,
      products: {},
      nodes: {},
      lanes: {},
      curves: {},
      batches: {},
      shipments: {},
      facts: [],
      processedActionIds: [],
      actionLog: [],
      migrationNotice: null,
      legacyArchive: null
    };
    syncSharedEntitiesIntoWorkspace(ws, sharedRegistry, bomRaw);
    return ws;
  }

  /**
   * 兼容保留（供既有引擎单元测试使用）：带默认主工厂与主市场的标准单品测试工作区。
   */
  function createBlankWorkspace(bomCatalog, todayIso) {
    const TS = getTS();
    const today = todayIso || TS.todayLocalIso();
    const catalog = bomCatalog || readLinkedBomCatalog({ allowBuiltinFallback: true });
    const bomProd = catalog?.products?.[0] || BUILTIN_BOM_SNAPSHOT.products[0];
    const sku = bomProd.skuCode || "GW-G200";
    const fac = bomProd.factories?.[0];
    const srcId = "src_main";
    const mktId = "mkt_main";

    return {
      format: WORLD_FORMAT,
      version: WORLD_VERSION,
      workspaceId: genId("ws_live"),
      name: `${bomProd.name} · Plan`,
      dataSourceMode: "live",
      inventoryAnchorDate: today,
      viewHorizonDays: 30,
      revision: 1,
      activeProductId: sku,
      products: {
        [sku]: {
          productId: sku,
          skuCode: sku,
          name: bomProd.name,
          unit: bomProd.unit || "units",
          bomDiagramId: bomProd.diagramId || null,
          bomMaterialId: bomProd.materialId || null,
          bomVersion: bomProd.bomVersion || null,
          unitManufacturingCost: 185,
          costSource: "bom_linked",
          note: bomProd.note || ""
        }
      },
      nodes: {
        [srcId]: {
          id: srcId,
          kind: "source",
          name: fac?.name || "Primary Factory",
          region: "CN",
          city: "Hangzhou",
          mapX: 165,
          mapY: 130,
          bomFactoryId: fac?.id || null,
          bomCompanyId: bomProd.rootCompanyId || null,
          initialInventory: 0,
          note: fac?.note || ""
        },
        [mktId]: {
          id: mktId,
          kind: "market",
          name: "Primary Market",
          region: "US",
          city: "Los Angeles",
          mapX: 815,
          mapY: 130,
          initialInventory: 0,
          marketPolicy: defaultMarketPolicy(),
          note: ""
        }
      },
      lanes: {},
      curves: {
        crv_src_prod: createEmptyCurve("crv_src_prod", srcId, "production", [
          { id: "pt_0", date: today, rate: 0 },
          { id: "pt_1", date: TS.addDaysToIso(today, 30), rate: 0 }
        ], 30),
        crv_mkt_dem: createEmptyCurve("crv_mkt_dem", mktId, "demand", [
          { id: "pt_d0", date: today, rate: 0 },
          { id: "pt_d1", date: TS.addDaysToIso(today, 30), rate: 0 }
        ], 30)
      },
      batches: {},
      shipments: {},
      facts: [],
      processedActionIds: [],
      actionLog: [],
      migrationNotice: null,
      legacyArchive: null
    };
  }

  const WorldModel = {
    WORLD_FORMAT,
    WORLD_VERSION,
    WORLD_STORAGE_KEY,
    LEGACY_V1_STORAGE_KEY,
    LEGACY_V1_BACKUP_KEY,
    BOM_STORAGE_KEY,
    TRANSPORT_MODES,
    NODE_KIND_META,
    BUILTIN_BOM_SNAPSHOT,
    clone,
    genId,
    safeNumber,
    modeLabel,
    extractBomCatalog,
    readRawBomFromStorage,
    readLinkedBomCatalog,
    readBomFinalAssemblyFactories,
    syncLinkedBomFactoryNames,
    createEmptyCurve,
    defaultMarketPolicy,
    computeDefaultMilestones,
    findNodeCurve,
    migrateV1ToV2,
    validateWorkspace,
    assertBusinessData,
    assertShipmentSchedule,
    requireShapeAnchors,
    requireMode,
    readStopoverPorts,
    SHIPMENT_FACT_FIELDS,
    factTargetCollection,
    getEffectiveFacts,
    findEffectiveFact,
    getBatchQuantity,
    projectFacts,
    hasShipmentActuals,
    sameValue,
    assertProtectedEntities,
    assertLegacyFactValues,
    assertNoNewMissingReferences,
    assertWorkspaceReplacement,
    syncSharedEntitiesIntoWorkspace,
    createLiveWorkspaceFromShared,
    createBlankWorkspace
  };

  global.SC = global.SC || {};
  global.SC.WorldModel = WorldModel;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = WorldModel;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
