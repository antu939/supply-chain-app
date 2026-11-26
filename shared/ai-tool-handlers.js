(function (global) {
  "use strict";

  const ISO_DATE_PATTERN = "^\\d{4}-\\d{2}-\\d{2}$";
  const ISO_MONTH_PATTERN = "^\\d{4}-\\d{2}$";
  const MAX_PAGE_LIMIT = 50;
  const DEFAULT_PAGE_LIMIT = 20;

  function getStore() {
    if (global.SCDataStore) return global.SCDataStore;
    if (typeof require === "function") return require("../storage/data-store.js");
    return null;
  }

  function getQuery() {
    if (global.SCAIQuery) return global.SCAIQuery;
    if (typeof require === "function") return require("./ai-query.js");
    return null;
  }

  function getSchema() {
    if (global.SCAIPrivacySchema) return global.SCAIPrivacySchema;
    if (typeof require === "function") return require("./ai-privacy-schema.js");
    return null;
  }

  function getTS() {
    if (global.SC?.TimeSeries) return global.SC.TimeSeries;
    if (typeof require === "function") return require("../modules/sales/js/timeseries.js");
    return null;
  }

  function getWM() {
    if (global.SC?.WorldModel) return global.SC.WorldModel;
    if (typeof require === "function") return require("../modules/sales/js/world-model.js");
    return null;
  }

  function getSim() {
    if (global.SC?.SimEngine) return global.SC.SimEngine;
    if (typeof require === "function") return require("../modules/sales/js/sim-engine.js");
    return null;
  }

  function roundN(val, precision) {
    const p = Math.max(0, Math.min(6, Number.isInteger(precision) ? precision : 2));
    const factor = Math.pow(10, p);
    return Math.round((Number(val) || 0) * factor) / factor;
  }

  function clampLimit(val, fallback) {
    const n = Number(val);
    if (!Number.isFinite(n) || n <= 0) return fallback || DEFAULT_PAGE_LIMIT;
    return Math.min(MAX_PAGE_LIMIT, Math.max(1, Math.floor(n)));
  }

  function clampOffset(val) {
    const n = Number(val);
    if (!Number.isFinite(n) || n < 0) return 0;
    return Math.floor(n);
  }

  function slicePage(items, limitVal, offsetVal) {
    const limit = clampLimit(limitVal);
    const offset = clampOffset(offsetVal);
    const total = items.length;
    const page = items.slice(offset, offset + limit);
    return {
      items: page,
      pagination: {
        total,
        returned: page.length,
        limit,
        offset,
        hasMore: offset + page.length < total,
        truncated: page.length < total
      }
    };
  }

  /**
   * Fast deterministic FNV-1a 32-bit digest for cache invalidation (never used for security).
   */
  function fnv1aDigest(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(16).padStart(8, "0");
  }

  /**
   * Read-only Sales workspace loader supporting direct workspace, salesRaw, storage, or partitionProvider.
   * Always returns a freshly validated clone so original business objects are NEVER mutated.
   */
  function loadSalesWorkspaceReadOnly(execCtx) {
    const WM = getWM();
    const Store = getStore();
    if (!WM || typeof WM.validateWorkspace !== "function") {
      throw new Error("当前上下文未加载销售工作区校验器 SC.WorldModel");
    }

    let raw = null;
    if (execCtx.workspace && typeof execCtx.workspace === "object") {
      raw = execCtx.workspace;
    } else if (execCtx.queryCtx?.salesRaw && typeof execCtx.queryCtx.salesRaw === "object") {
      raw = execCtx.queryCtx.salesRaw;
    } else if (execCtx.queryCtx?.storage) {
      const text = execCtx.queryCtx.storage.getItem(Store ? Store.STORAGE_KEYS.SALES : "sc-sales-world-v2")
        || execCtx.queryCtx.storage.getItem(Store ? Store.STORAGE_KEYS.SALES_LEGACY : "sc-sales-world-v1");
      if (text) raw = JSON.parse(text);
    } else if (execCtx.queryCtx?.partitionProvider && Store) {
      const manifest = Store.loadManifest(execCtx.queryCtx);
      const master = Store.readPartition("sales/master", execCtx.queryCtx);
      if (master) {
        const batches = {};
        const shipments = {};
        const facts = [];
        for (const p of (manifest.partitions || [])) {
          if (p.domain === "sales" && p.kind === "monthly") {
            const mp = Store.readPartition(p.id, execCtx.queryCtx);
            if (!mp) continue;
            Object.assign(batches, mp.batches || {});
            Object.assign(shipments, mp.shipments || {});
            if (Array.isArray(mp.facts)) facts.push(...mp.facts);
          }
        }
        raw = {
          format: master.format || "sc-sales-world",
          version: master.version || 2,
          workspaceId: master.workspaceId || "ws_partitioned",
          name: "partitioned",
          dataSourceMode: "live",
          inventoryAnchorDate: master.inventoryAnchorDate,
          viewHorizonDays: master.viewHorizonDays,
          revision: master.revision,
          activeProductId: master.activeProductId,
          products: master.products || {},
          nodes: master.nodes || {},
          lanes: master.lanes || {},
          curves: master.curves || {},
          batches,
          shipments,
          facts,
          processedActionIds: [],
          actionLog: []
        };
      }
    }

    if (!raw) return null;
    return WM.validateWorkspace(raw);
  }

  /**
   * Build explicit directed adjacency from BOM relationships (never guesses by names).
   * Edge direction: supplier (up) -> receiver (down), tagged with nodeId and materialId.
   */
  function buildBomSupplyGraph(bom, diagramIdFilter) {
    const upstreamMap = new Map();   // receiverId -> Array<{ supplierId, nodeId, materialId, diagramId }>
    const downstreamMap = new Map(); // supplierId -> Array<{ receiverId, nodeId, materialId, diagramId }>

    const validNodeIds = diagramIdFilter
      ? new Set(Object.values(bom.nodes || {}).filter(n => n && n.diagramId === diagramIdFilter).map(n => n.id))
      : null;

    for (const [nid, rows] of Object.entries(bom.relationships || {})) {
      if (validNodeIds && !validNodeIds.has(nid)) continue;
      if (!rows || typeof rows !== "object") continue;
      const node = bom.nodes?.[nid];
      const matId = node?.materialId || null;
      const diagId = node?.diagramId || null;

      for (const [down, ups] of Object.entries(rows)) {
        if (!bom.companies?.[down] || !Array.isArray(ups)) continue;
        for (const up of ups) {
          if (!bom.companies?.[up] || up === down) continue;
          const edge = { supplierId: up, receiverId: down, nodeId: nid, materialId: matId, diagramId: diagId };
          if (!upstreamMap.has(down)) upstreamMap.set(down, []);
          upstreamMap.get(down).push(edge);
          if (!downstreamMap.has(up)) downstreamMap.set(up, []);
          downstreamMap.get(up).push(edge);
        }
      }
    }

    return { upstreamMap, downstreamMap };
  }

  function sanitizeSingle(execCtx, schemaName, rawObj, callOpts) {
    const res = execCtx.privacy.sanitizeBusinessPayload(schemaName, rawObj, callOpts);
    if (!res.allowed) {
      return { blocked: true, res };
    }
    return { blocked: false, data: res.data, audit: res.audit };
  }

  function sanitizeArray(execCtx, schemaName, rawArr, callOpts) {
    const res = execCtx.privacy.sanitizeBusinessPayload(schemaName, rawArr, callOpts);
    if (!res.allowed) {
      return { blocked: true, res };
    }
    return { blocked: false, data: res.data || [], audit: res.audit };
  }

  /* =========================================================================
     TOOL 1: query_bom
     ========================================================================= */
  const queryBomTool = {
    name: "query_bom",
    category: "bom",
    readOnly: true,
    defaultScope: "compliance_overview",
    description: "按条件只读查询 BOM 模块中的公司、工厂、物料或产品结构列表，支持合规状态筛选、分页及分页前全局统计汇总。",
    useCases: [
      "查找存在严重违规或风险合规状态的供应商公司",
      "按公司列出其下属工厂及跨模块销售节点关联状态",
      "列出产品 BOM 清单或物料目录及全局统计数量"
    ],
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        kind: {
          type: "string",
          enum: ["company", "factory", "material", "diagram", "all"],
          description: "查询主体类型，默认 company"
        },
        id: { type: "string", minLength: 1, maxLength: 80, description: "按单个主体 ID 或匿名代号精确筛选" },
        ids: {
          type: "array",
          maxItems: 50,
          items: { type: "string", minLength: 1, maxLength: 80 },
          description: "按多个主体 ID 或匿名代号批量筛选"
        },
        companyId: { type: "string", minLength: 1, maxLength: 80, description: "按所属公司 ID/匿名代号筛选工厂或成品" },
        complianceStatus: {
          type: "string",
          enum: ["severe", "risk", "qualified", "unverified"],
          description: "按公司四色合规状态筛选"
        },
        includeSummary: { type: "boolean", description: "是否返回分页前的全局统计汇总，默认 true" },
        limit: { type: "integer", minimum: 1, maximum: MAX_PAGE_LIMIT, description: "每页数量（1~50），默认 20" },
        offset: { type: "integer", minimum: 0, maximum: 10000, description: "分页偏移量，默认 0" }
      }
    },
    returns: {
      type: "object",
      description: "{ items: [...], summary?: { scopeNote: 'global_filtered_before_pagination', ... } }"
    },
    execute(args, execCtx) {
      const Store = getStore();
      const kind = args.kind || "company";
      const limit = clampLimit(args.limit);
      const offset = clampOffset(args.offset);
      const includeSummary = args.includeSummary !== false;
      const privacyOpts = execCtx.privacyCallOpts;

      execCtx.privacy.ensureManifestIndexed(execCtx.queryCtx);
      const manifest = Store.loadManifest(execCtx.queryCtx);
      const bom = Store.readPartition("bom/entities", execCtx.queryCtx);
      if (!bom) {
        return {
          data: { items: [], summary: includeSummary ? { scopeNote: "global_filtered_before_pagination", totalMatched: 0 } : undefined },
          partitionsRead: [],
          pagination: { total: 0, returned: 0, limit, offset, hasMore: false, truncated: false }
        };
      }

      if (kind === "material") {
        const idFilter = args.id
          ? new Set([execCtx.privacy.translateInputId("material", args.id)])
          : (Array.isArray(args.ids) ? new Set(args.ids.map(x => execCtx.privacy.translateInputId("material", x))) : null);
        const compFilter = args.companyId ? execCtx.privacy.translateInputId("company", args.companyId) : null;

        const materialUsage = new Map();
        for (const n of Object.values(bom.nodes || {})) {
          if (!n || !n.materialId) continue;
          if (!materialUsage.has(n.materialId)) {
            materialUsage.set(n.materialId, { diagrams: new Set(), companies: new Set(), count: 0 });
          }
          const rec = materialUsage.get(n.materialId);
          rec.count++;
          if (n.diagramId) rec.diagrams.add(n.diagramId);
          for (const cid of (n.companyIds || [])) rec.companies.add(cid);
        }

        const matched = [];
        for (const m of Object.values(bom.materials || {})) {
          if (!m) continue;
          if (idFilter && !idFilter.has(m.id)) continue;
          const u = materialUsage.get(m.id) || { diagrams: new Set(), companies: new Set(), count: 0 };
          if (compFilter && !u.companies.has(compFilter)) continue;
          matched.push({
            kind: "material",
            id: m.id,
            code: m.code || "",
            name: m.name || "",
            usedInDiagramIds: Array.from(u.diagrams),
            usageCount: u.count,
            supplierCompanyIds: Array.from(u.companies),
            note: m.note || ""
          });
        }

        const paged = slicePage(matched, limit, offset);
        const san = sanitizeArray(execCtx, "bom_material_summary", paged.items, privacyOpts);
        if (san.blocked) return { privacyBlocked: san.res };

        const data = { items: san.data };
        if (includeSummary) {
          data.summary = {
            scopeNote: "global_filtered_before_pagination",
            totalMatched: matched.length,
            sharedAcrossMultipleNodesCount: matched.filter(x => x.usageCount > 1).length
          };
        }
        return { data, partitionsRead: ["bom/entities"], pagination: paged.pagination };
      }

      // Reuse Stage 1 SCAIPrivacy.queryBomEntities (which wraps SCAIQuery.queryBomEntities)
      const qRes = execCtx.privacy.queryBomEntities({
        kind,
        id: args.id,
        ids: args.ids,
        companyId: args.companyId,
        complianceStatus: args.complianceStatus,
        limit,
        offset
      }, privacyOpts);

      if (!qRes.ok) return { error: qRes.error || "查询 BOM 数据失败", partitionsRead: qRes.meta?.partitionsRead || [] };
      if (!qRes.allowed) return { privacyBlocked: qRes };

      const pagination = {
        total: qRes.meta.total,
        returned: qRes.data.length,
        limit: qRes.meta.limit,
        offset: qRes.meta.offset,
        hasMore: Boolean(qRes.meta.hasMore),
        truncated: qRes.data.length < qRes.meta.total
      };

      const data = { items: qRes.data };
      if (includeSummary) {
        // Compute global summary directly over bom/entities (same single partition, before pagination!)
        const Query = getQuery();
        const translatedCompanyId = args.companyId ? execCtx.privacy.translateInputId("company", args.companyId) : undefined;
        const translatedId = args.id ? execCtx.privacy.translateInputId(null, args.id) : undefined;
        const translatedIds = Array.isArray(args.ids) ? args.ids.map(x => execCtx.privacy.translateInputId(null, x)) : undefined;

        const allMatched = [];
        let scanOffset = 0;
        while (true) {
          const batch = Query.queryBomEntities({
            kind,
            id: translatedId,
            ids: translatedIds,
            companyId: translatedCompanyId,
            complianceStatus: args.complianceStatus,
            limit: 100,
            offset: scanOffset
          }, execCtx.queryCtx);
          allMatched.push(...(batch.data || []));
          if (!batch.meta?.hasMore || !batch.data?.length) break;
          scanOffset += batch.data.length;
        }

        const summary = {
          scopeNote: "global_filtered_before_pagination",
          totalMatched: allMatched.length
        };
        if (kind === "company" || kind === "all") {
          const byComp = { severe: 0, risk: 0, qualified: 0, unverified: 0 };
          for (const row of allMatched) {
            if (row.kind === "company") {
              const st = row.compliance?.status || "unverified";
              if (Object.prototype.hasOwnProperty.call(byComp, st)) byComp[st]++;
            }
          }
          summary.complianceBreakdown = byComp;
        }
        if (kind === "factory" || kind === "all") {
          const facs = allMatched.filter(r => r.kind === "factory");
          summary.factoryCount = facs.length;
          summary.linkedToSalesCount = facs.filter(r => Boolean(r.linkedSalesNodeId)).length;
        }
        if (kind === "diagram" || kind === "all") {
          summary.diagramCount = allMatched.filter(r => r.kind === "diagram").length;
        }
        summary.manifestVersion = manifest.version;
        data.summary = summary;
      }

      return { data, partitionsRead: qRes.meta.partitionsRead || ["bom/entities"], pagination };
    }
  };

  /* =========================================================================
     TOOL 2: get_bom_detail
     ========================================================================= */
  const getBomDetailTool = {
    name: "get_bom_detail",
    category: "bom",
    readOnly: true,
    defaultScope: "compliance_overview",
    description: "按稳定 ID 或匿名代号获取指定公司、工厂或产品 BOM 的结构化详情，包含下属工厂、直接上下游供货方、工厂路径、准入状态与物料树。",
    useCases: [
      "查看某家供应商的合规状态、下属工厂与直接上下游公司",
      "查看某座工厂的供货路径及其关联的销售工厂节点",
      "获取指定产品 BOM 的组件层级与各节点供应商"
    ],
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        companyId: { type: "string", minLength: 1, maxLength: 80, description: "公司 ID 或匿名代号（如 COMP_001）" },
        factoryId: { type: "string", minLength: 1, maxLength: 80, description: "BOM 工厂 ID 或匿名代号（如 FAC_001）" },
        diagramId: { type: "string", minLength: 1, maxLength: 80, description: "BOM 产品图 ID 或匿名代号（如 BOM_001）" },
        productId: { type: "string", minLength: 1, maxLength: 80, description: "产品物料 ID 或匿名代号（如 MAT_001）" },
        includeAssessments: { type: "boolean", description: "是否包含市场合规准入摘要，默认 true" },
        includeFactoryPaths: { type: "boolean", description: "是否包含工厂级供货路径，默认 true" },
        maxNodes: { type: "integer", minimum: 1, maximum: 100, description: "产品 BOM 树最多返回节点数，默认 50" }
      }
    },
    validate(args) {
      if (!args.companyId && !args.factoryId && !args.diagramId && !args.productId) {
        return ["arguments: 必须提供 companyId、factoryId、diagramId 或 productId 之一"];
      }
      return [];
    },
    returns: {
      type: "object",
      description: "公司详情 / 工厂详情 / 产品 BOM 结构树（全部经隐私层脱敏）"
    },
    execute(args, execCtx) {
      const res = execCtx.privacy.getBomDetail({
        companyId: args.companyId,
        factoryId: args.factoryId,
        diagramId: args.diagramId,
        productId: args.productId
      }, execCtx.privacyCallOpts);

      if (!res.ok) return { error: res.error || "未找到对应 BOM 详情", partitionsRead: res.meta?.partitionsRead || [] };
      if (!res.allowed) return { privacyBlocked: res };

      const out = Object.assign({}, res.data);
      let pagination = null;

      if (args.includeAssessments === false) {
        delete out.marketAssessments;
        delete out.assessments;
      }
      if (args.includeFactoryPaths === false) {
        delete out.factoryPaths;
      }
      if (Array.isArray(out.nodes)) {
        const maxNodes = Math.max(1, Math.min(100, Number(args.maxNodes) || 50));
        const total = out.nodes.length;
        if (total > maxNodes) {
          out.nodes = out.nodes.slice(0, maxNodes);
          pagination = { total, returned: maxNodes, limit: maxNodes, offset: 0, hasMore: true, truncated: true };
        } else {
          pagination = { total, returned: total, limit: maxNodes, offset: 0, hasMore: false, truncated: false };
        }
      }

      return { data: out, partitionsRead: res.meta.partitionsRead || ["bom/entities"], pagination };
    }
  };

  /* =========================================================================
     TOOL 3: trace_supply_chain
     ========================================================================= */
  const traceSupplyChainTool = {
    name: "trace_supply_chain",
    category: "bom",
    readOnly: true,
    defaultScope: "compliance_overview",
    description: "严格依据显式供货关系与跨模块 bomFactoryId 关联，执行上下游递归追溯、多供应商共享上游识别及跨模块工厂→批次→发运→市场追溯。",
    useCases: [
      "递归向上追溯某公司或成品的全部多级上游供应商与合规风险",
      "向下游追溯某违规供应商影响的成品公司、BOM 与关联销售工厂",
      "识别两个或多个组件供应商（如两家主板供应商）共享同一个上游芯片供应商的关系",
      "基于显式 bomFactoryId 打通 BOM 总装厂与销售生产批次、发运单及目标市场"
    ],
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["mode"],
      properties: {
        mode: {
          type: "string",
          enum: ["upstream", "downstream", "shared_upstream", "cross_module"],
          description: "追溯模式：upstream | downstream | shared_upstream | cross_module"
        },
        companyId: { type: "string", minLength: 1, maxLength: 80, description: "目标公司 ID 或匿名代号（upstream/downstream 使用）" },
        companyIds: {
          type: "array",
          minItems: 2,
          maxItems: 20,
          items: { type: "string", minLength: 1, maxLength: 80 },
          description: "多个待比较的下游公司 ID 或匿名代号（shared_upstream 使用）"
        },
        diagramId: { type: "string", minLength: 1, maxLength: 80, description: "可选：限定在指定产品 BOM 范围内追溯" },
        bomFactoryId: { type: "string", minLength: 1, maxLength: 80, description: "BOM 工厂 ID 或匿名代号（cross_module 使用）" },
        salesNodeId: { type: "string", minLength: 1, maxLength: 80, description: "销售工厂节点 ID 或匿名代号（cross_module 使用）" },
        monthFrom: { type: "string", pattern: ISO_MONTH_PATTERN, description: "跨模块追溯起始月份 YYYY-MM" },
        monthTo: { type: "string", pattern: ISO_MONTH_PATTERN, description: "跨模块追溯结束月份 YYYY-MM" },
        maxDepth: { type: "integer", minimum: 1, maximum: 10, description: "最大递归深度（1~10），默认 6" },
        limit: { type: "integer", minimum: 1, maximum: MAX_PAGE_LIMIT, description: "返回条目上限（1~50），默认 20" }
      }
    },
    validate(args) {
      const errs = [];
      if (args.mode === "upstream" && !args.companyId && !args.diagramId) {
        errs.push("arguments: upstream 模式必须提供 companyId 或 diagramId");
      }
      if (args.mode === "downstream" && !args.companyId) {
        errs.push("arguments: downstream 模式必须提供 companyId");
      }
      if (args.mode === "shared_upstream" && !args.companyIds && !args.diagramId) {
        errs.push("arguments: shared_upstream 模式必须提供 companyIds（至少 2 家）或 diagramId");
      }
      if (args.mode === "cross_module" && !args.bomFactoryId && !args.salesNodeId) {
        errs.push("arguments: cross_module 模式必须提供 bomFactoryId 或 salesNodeId");
      }
      return errs;
    },
    returns: {
      type: "object",
      description: "脱敏后的拓扑节点、有向边、共享上游列表或跨模块上下游视图"
    },
    execute(args, execCtx) {
      const Store = getStore();
      const privacyOpts = execCtx.privacyCallOpts;
      const limit = clampLimit(args.limit);
      const maxDepth = Math.max(1, Math.min(10, Number(args.maxDepth) || 6));

      execCtx.privacy.ensureManifestIndexed(execCtx.queryCtx);

      /* ---------- Mode D: cross_module ---------- */
      if (args.mode === "cross_module") {
        const crossRes = execCtx.privacy.getCrossModuleFactoryView({
          bomFactoryId: args.bomFactoryId,
          salesNodeId: args.salesNodeId,
          monthFrom: args.monthFrom,
          monthTo: args.monthTo,
          limit
        }, privacyOpts);

        if (!crossRes.ok) return { error: crossRes.error || "未找到对应跨模块工厂记录", partitionsRead: crossRes.meta?.partitionsRead || [] };
        if (!crossRes.allowed) return { privacyBlocked: crossRes };

        const d = crossRes.data;
        const marketSet = new Set();
        for (const s of (d.sales?.shipments || [])) {
          if (s.toNodeId) marketSet.add(s.toNodeId);
        }
        const enriched = Object.assign({}, d, {
          downstreamMarketIds: Array.from(marketSet),
          linkRule: "strict_explicit_bomFactoryId_only"
        });
        return { data: enriched, partitionsRead: crossRes.meta.partitionsRead || [] };
      }

      /* ---------- Modes A/B/C: BOM explicit graph traversal ---------- */
      const manifest = Store.loadManifest(execCtx.queryCtx);
      const bom = Store.readPartition("bom/entities", execCtx.queryCtx);
      if (!bom) return { error: "BOM 数据不存在", partitionsRead: [] };

      const rawDiagramId = args.diagramId ? execCtx.privacy.translateInputId("diagram", args.diagramId) : null;
      if (rawDiagramId && !(bom.diagrams || []).some(d => d.id === rawDiagramId)) {
        return { error: "未找到指定的产品 BOM", partitionsRead: ["bom/entities"] };
      }

      const { upstreamMap, downstreamMap } = buildBomSupplyGraph(bom, rawDiagramId);

      function toSanitizedCompanyRef(rawCid) {
        const comp = bom.companies?.[rawCid];
        const rawRef = {
          id: rawCid,
          name: comp?.name || rawCid,
          complianceStatus: comp?.compliance?.status || "unverified"
        };
        const san = sanitizeSingle(execCtx, "bom_supplier_ref", rawRef, privacyOpts);
        if (san.blocked) return null;
        return san.data;
      }

      /* ---------- Mode A: upstream ---------- */
      if (args.mode === "upstream") {
        let rootIds = [];
        if (args.companyId) {
          const cid = execCtx.privacy.translateInputId("company", args.companyId);
          if (!bom.companies?.[cid]) return { error: "未找到指定公司", partitionsRead: ["bom/entities"] };
          rootIds = [cid];
        } else {
          const diag = bom.diagrams.find(d => d.id === rawDiagramId);
          rootIds = (bom.nodes?.[diag.rootNodeId]?.companyIds || []).filter(cid => Boolean(bom.companies?.[cid]));
        }

        const depthByCompany = new Map();
        const directReceiversBySupplier = new Map(); // supplier -> Set(receiver)
        const queue = [];
        for (const r of rootIds) {
          depthByCompany.set(r, 0);
          queue.push({ id: r, depth: 0 });
        }

        const edgeKeySet = new Set();
        const rawEdges = [];
        let maxDepthReached = 0;

        while (queue.length > 0) {
          const cur = queue.shift();
          if (cur.depth >= maxDepth) continue;
          const upEdges = upstreamMap.get(cur.id) || [];
          for (const e of upEdges) {
            const nextDepth = cur.depth + 1;
            if (!directReceiversBySupplier.has(e.supplierId)) directReceiversBySupplier.set(e.supplierId, new Set());
            directReceiversBySupplier.get(e.supplierId).add(e.receiverId);

            const ek = `${e.supplierId}->${e.receiverId}@${e.nodeId}`;
            if (!edgeKeySet.has(ek)) {
              edgeKeySet.add(ek);
              rawEdges.push(Object.assign({ depth: nextDepth }, e));
            }
            if (!depthByCompany.has(e.supplierId)) {
              depthByCompany.set(e.supplierId, nextDepth);
              if (nextDepth > maxDepthReached) maxDepthReached = nextDepth;
              queue.push({ id: e.supplierId, depth: nextDepth });
            }
          }
        }

        const upstreamRawIds = Array.from(depthByCompany.keys()).filter(cid => !rootIds.includes(cid));
        const allNodes = upstreamRawIds.map(cid => {
          const ref = toSanitizedCompanyRef(cid);
          return Object.assign({}, ref, {
            depth: depthByCompany.get(cid),
            directReceiverCount: (directReceiversBySupplier.get(cid) || new Set()).size
          });
        });

        const sharedSuppliers = upstreamRawIds
          .filter(cid => (directReceiversBySupplier.get(cid)?.size || 0) >= 2)
          .map(cid => ({
            supplier: toSanitizedCompanyRef(cid),
            minDepth: depthByCompany.get(cid),
            servedReceiverIds: Array.from(directReceiversBySupplier.get(cid)).map(r => execCtx.privacy.anonymizeId("company", r, { displayName: bom.companies?.[r]?.name || "" }))
          }));

        const allEdges = rawEdges.map(e => ({
          supplierCompanyId: execCtx.privacy.anonymizeId("company", e.supplierId, { displayName: bom.companies?.[e.supplierId]?.name || "" }),
          receiverCompanyId: execCtx.privacy.anonymizeId("company", e.receiverId, { displayName: bom.companies?.[e.receiverId]?.name || "" }),
          bomNodeId: execCtx.privacy.anonymizeId("bom_node", e.nodeId),
          materialId: e.materialId ? execCtx.privacy.anonymizeId("material", e.materialId, { displayName: bom.materials?.[e.materialId]?.name || "" }) : null,
          depth: e.depth
        }));

        const pagedNodes = slicePage(allNodes, limit, 0);
        const pagedEdges = slicePage(allEdges, limit * 2, 0);

        return {
          data: {
            mode: "upstream",
            rootCompanies: rootIds.map(toSanitizedCompanyRef),
            upstreamSuppliers: pagedNodes.items,
            edges: pagedEdges.items,
            sharedUpstreamSuppliers: sharedSuppliers,
            summary: {
              scopeNote: "global_traced_before_truncation",
              totalUpstreamSuppliers: allNodes.length,
              totalEdges: allEdges.length,
              sharedSupplierCount: sharedSuppliers.length,
              severeCount: allNodes.filter(n => n.complianceStatus === "severe").length,
              riskCount: allNodes.filter(n => n.complianceStatus === "risk").length,
              maxDepthReached,
              edgesTruncated: pagedEdges.pagination.truncated
            }
          },
          partitionsRead: ["bom/entities"],
          pagination: pagedNodes.pagination
        };
      }

      /* ---------- Mode B: downstream ---------- */
      if (args.mode === "downstream") {
        const rootCid = execCtx.privacy.translateInputId("company", args.companyId);
        if (!bom.companies?.[rootCid]) return { error: "未找到指定公司", partitionsRead: ["bom/entities"] };

        const depthByCompany = new Map([[rootCid, 0]]);
        const queue = [{ id: rootCid, depth: 0 }];
        const edgeKeySet = new Set();
        const rawEdges = [];

        while (queue.length > 0) {
          const cur = queue.shift();
          if (cur.depth >= maxDepth) continue;
          for (const e of (downstreamMap.get(cur.id) || [])) {
            const nextDepth = cur.depth + 1;
            const ek = `${e.supplierId}->${e.receiverId}@${e.nodeId}`;
            if (!edgeKeySet.has(ek)) {
              edgeKeySet.add(ek);
              rawEdges.push(Object.assign({ depth: nextDepth }, e));
            }
            if (!depthByCompany.has(e.receiverId)) {
              depthByCompany.set(e.receiverId, nextDepth);
              queue.push({ id: e.receiverId, depth: nextDepth });
            }
          }
        }

        const impactedRawIds = Array.from(depthByCompany.keys()).filter(cid => cid !== rootCid);
        const impactedSet = new Set(depthByCompany.keys());

        // Identify affected product diagrams & explicitly linked Sales factories
        const impactedDiagramIds = [];
        for (const d of (bom.diagrams || [])) {
          const rootNode = bom.nodes?.[d.rootNodeId];
          const rootComps = rootNode?.companyIds || [];
          if (rootComps.some(cid => impactedSet.has(cid))) {
            impactedDiagramIds.push(execCtx.privacy.anonymizeId("diagram", d.id));
          }
        }

        const linkedSalesFactoryIds = [];
        const bomToSales = manifest.links?.bomFactoryToSalesNode || {};
        for (const fac of Object.values(bom.factories || {})) {
          if (impactedSet.has(fac.companyId) && bomToSales[fac.id]) {
            execCtx.privacy.registerCrossFactoryLink(fac.id, bomToSales[fac.id]);
            linkedSalesFactoryIds.push(execCtx.privacy.anonymizeId("sales_factory", bomToSales[fac.id]));
          }
        }

        const allReceivers = impactedRawIds.map(cid => Object.assign({}, toSanitizedCompanyRef(cid), {
          depth: depthByCompany.get(cid)
        }));
        const paged = slicePage(allReceivers, limit, 0);

        return {
          data: {
            mode: "downstream",
            rootCompany: toSanitizedCompanyRef(rootCid),
            impactedReceivers: paged.items,
            edges: rawEdges.slice(0, limit * 2).map(e => ({
              supplierCompanyId: execCtx.privacy.anonymizeId("company", e.supplierId, { displayName: bom.companies?.[e.supplierId]?.name || "" }),
              receiverCompanyId: execCtx.privacy.anonymizeId("company", e.receiverId, { displayName: bom.companies?.[e.receiverId]?.name || "" }),
              bomNodeId: execCtx.privacy.anonymizeId("bom_node", e.nodeId),
              materialId: e.materialId ? execCtx.privacy.anonymizeId("material", e.materialId, { displayName: bom.materials?.[e.materialId]?.name || "" }) : null,
              depth: e.depth
            })),
            impactedDiagramIds,
            linkedSalesFactoryIds: Array.from(new Set(linkedSalesFactoryIds)),
            summary: {
              scopeNote: "global_traced_before_truncation",
              totalImpactedReceivers: allReceivers.length,
              totalEdges: rawEdges.length,
              impactedDiagramCount: impactedDiagramIds.length,
              linkedSalesFactoryCount: new Set(linkedSalesFactoryIds).size
            }
          },
          partitionsRead: ["bom/entities"],
          pagination: paged.pagination
        };
      }

      /* ---------- Mode C: shared_upstream ---------- */
      let targetRawIds = [];
      if (Array.isArray(args.companyIds) && args.companyIds.length >= 2) {
        targetRawIds = Array.from(new Set(args.companyIds.map(x => execCtx.privacy.translateInputId("company", x))));
        for (const cid of targetRawIds) {
          if (!bom.companies?.[cid]) return { error: "companyIds 中包含不存在的公司", partitionsRead: ["bom/entities"] };
        }
      } else {
        // Discover all companies that have at least one upstream supplier in the BOM
        const candidateSet = new Set(upstreamMap.keys());
        targetRawIds = Array.from(candidateSet).sort();
      }

      // For each target company, collect all reachable upstream suppliers (up to maxDepth)
      const supplierToTargets = new Map(); // supplierRawId -> Map(targetRawId -> { minDepth, materialIds: Set })
      for (const targetCid of targetRawIds) {
        const seenDepth = new Map([[targetCid, 0]]);
        const q = [{ id: targetCid, depth: 0 }];
        while (q.length > 0) {
          const cur = q.shift();
          if (cur.depth >= maxDepth) continue;
          for (const e of (upstreamMap.get(cur.id) || [])) {
            const nextDepth = cur.depth + 1;
            if (!supplierToTargets.has(e.supplierId)) supplierToTargets.set(e.supplierId, new Map());
            const byTarget = supplierToTargets.get(e.supplierId);
            if (!byTarget.has(targetCid)) {
              byTarget.set(targetCid, { minDepth: nextDepth, materialIds: new Set() });
            } else {
              const info = byTarget.get(targetCid);
              if (nextDepth < info.minDepth) info.minDepth = nextDepth;
            }
            if (e.materialId) byTarget.get(targetCid).materialIds.add(e.materialId);

            if (!seenDepth.has(e.supplierId) || nextDepth < seenDepth.get(e.supplierId)) {
              seenDepth.set(e.supplierId, nextDepth);
              q.push({ id: e.supplierId, depth: nextDepth });
            }
          }
        }
      }

      const sharedList = [];
      for (const [supId, byTarget] of supplierToTargets.entries()) {
        if (byTarget.size < 2) continue;
        const depths = Array.from(byTarget.values()).map(v => v.minDepth);
        const matSet = new Set();
        for (const v of byTarget.values()) v.materialIds.forEach(m => matSet.add(m));

        sharedList.push({
          supplier: toSanitizedCompanyRef(supId),
          sharedByCompanyIds: Array.from(byTarget.keys()).map(cid =>
            execCtx.privacy.anonymizeId("company", cid, { displayName: bom.companies?.[cid]?.name || "" })
          ),
          sharedByCount: byTarget.size,
          isCommonToAllTargets: byTarget.size === targetRawIds.length,
          minDepth: Math.min(...depths),
          maxDepth: Math.max(...depths),
          viaMaterialIds: Array.from(matSet).map(mid =>
            execCtx.privacy.anonymizeId("material", mid, { displayName: bom.materials?.[mid]?.name || "" })
          )
        });
      }

      sharedList.sort((a, b) => b.sharedByCount - a.sharedByCount || a.minDepth - b.minDepth);
      const pagedShared = slicePage(sharedList, limit, 0);

      return {
        data: {
          mode: "shared_upstream",
          targetCompanies: targetRawIds.map(toSanitizedCompanyRef),
          sharedSuppliers: pagedShared.items,
          summary: {
            scopeNote: "global_traced_before_truncation",
            targetCompanyCount: targetRawIds.length,
            sharedSupplierCount: sharedList.length,
            commonToAllCount: sharedList.filter(x => x.isCommonToAllTargets).length
          }
        },
        partitionsRead: ["bom/entities"],
        pagination: pagedShared.pagination
      };
    }
  };

  /* =========================================================================
     TOOL 4: query_sales
     ========================================================================= */
  const querySalesTool = {
    name: "query_sales",
    category: "sales",
    readOnly: true,
    defaultScope: "inventory_risk",
    description: "按月份、时间窗、工厂、市场、批次或发运单只读查询销售运营数据（发运单、批次、事实、工厂、市场、物流方案及供需曲线聚合摘要），通过索引跳过无关月份并支持分页前全局聚合。",
    useCases: [
      "按月份或跨月时间范围筛选发运单、生产批次或已确认事实事件",
      "按批次跨月追溯关联发运单，不遗漏跨月活跃记录",
      "获取生产/需求曲线的区间积分总量与日均速率摘要（不返回冗长日度数组）",
      "在本地执行分组计数与总量聚合，减少返回体积"
    ],
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["entity"],
      properties: {
        entity: {
          type: "string",
          enum: ["shipments", "batches", "facts", "factories", "markets", "lanes", "curves", "summary"],
          description: "查询对象类型"
        },
        month: { type: "string", pattern: ISO_MONTH_PATTERN, description: "精确月份 YYYY-MM" },
        monthFrom: { type: "string", pattern: ISO_MONTH_PATTERN, description: "起始月份 YYYY-MM" },
        monthTo: { type: "string", pattern: ISO_MONTH_PATTERN, description: "结束月份 YYYY-MM" },
        fromDate: { type: "string", pattern: ISO_DATE_PATTERN, description: "起始日期 YYYY-MM-DD" },
        toDate: { type: "string", pattern: ISO_DATE_PATTERN, description: "结束日期 YYYY-MM-DD" },
        factoryId: { type: "string", minLength: 1, maxLength: 80, description: "工厂 ID/匿名代号（兼容 BOM 工厂与销售工厂代号）" },
        marketId: { type: "string", minLength: 1, maxLength: 80, description: "市场 ID/匿名代号" },
        productId: { type: "string", minLength: 1, maxLength: 80, description: "销售产品 ID/匿名代号（用于发运、批次或其汇总）" },
        batchId: { type: "string", minLength: 1, maxLength: 80, description: "生产批次 ID/匿名代号" },
        shipmentId: { type: "string", minLength: 1, maxLength: 80, description: "发运单 ID/匿名代号" },
        status: { type: "string", enum: ["planned", "confirmed", "cancelled"], description: "发运或批次状态筛选" },
        factKind: {
          type: "string",
          enum: ["production_confirmed", "shipment_dispatched", "border_arrival", "customs_release", "market_stock_available", "inventory_stocktake"],
          description: "事实事件类型（entity=facts 时有效）"
        },
        curveKind: { type: "string", enum: ["production", "demand"], description: "曲线类型（entity=curves 时有效）" },
        aggregate: { type: "boolean", description: "是否返回分页前全局本地聚合统计，默认 false" },
        includeItems: { type: "boolean", description: "是否返回明细列表（可配合 aggregate=true 设为 false 仅取汇总），默认 true" },
        limit: { type: "integer", minimum: 1, maximum: MAX_PAGE_LIMIT, description: "每页条数（1~50），默认 20" },
        offset: { type: "integer", minimum: 0, maximum: 10000, description: "分页偏移量，默认 0" }
      }
    },
    validate(args) {
      const error = getQuery().validateSalesDateRange(args);
      if (error) return [error];
      if (args.productId && !["shipments", "batches", "summary"].includes(args.entity)) {
        return ["该查询对象不支持可靠的产品归属筛选"];
      }
      return [];
    },
    returns: {
      type: "object",
      description: "{ items: [...], aggregation?: { scopeNote: 'global_matched_before_pagination', ... } }"
    },
    execute(args, execCtx) {
      const Store = getStore();
      const Query = getQuery();
      const TS = getTS();
      const Schema = getSchema();
      const privacyOpts = execCtx.privacyCallOpts;
      const limit = clampLimit(args.limit);
      const offset = clampOffset(args.offset);
      const includeItems = args.includeItems !== false;

      execCtx.privacy.ensureManifestIndexed(execCtx.queryCtx);

      /* ---------- Compact Curve Summaries (reuses official SC.TimeSeries!) ---------- */
      if (args.entity === "curves") {
        const master = Store.readPartition("sales/master", execCtx.queryCtx);
        if (!master) {
          return { data: { items: [] }, partitionsRead: [], pagination: { total: 0, returned: 0, limit, offset, hasMore: false, truncated: false } };
        }
        const resolvedFac = args.factoryId ? execCtx.privacy.translateInputId(["sales_factory", "factory"], args.factoryId) : null;
        const resolvedMkt = args.marketId ? execCtx.privacy.translateInputId("market", args.marketId) : null;
        const manifest = Store.loadManifest(execCtx.queryCtx);
        const mappedFac = resolvedFac ? (manifest.links?.bomFactoryToSalesNode?.[resolvedFac] || resolvedFac) : null;

        const rangeFrom = args.fromDate || master.inventoryAnchorDate || (TS ? TS.todayLocalIso() : "2026-01-01");
        const curvesRaw = Object.values(master.curves || {}).filter(c => {
          if (!c || c.kind === "capacity") return false;
          if (args.curveKind && c.kind !== args.curveKind) return false;
          if (mappedFac && c.targetNodeId !== mappedFac) return false;
          if (resolvedMkt && c.targetNodeId !== resolvedMkt) return false;
          return true;
        });

        if (args.toDate && args.toDate < rangeFrom) return { error: "toDate 不能早于曲线起始日期" };
        if (args.toDate && TS.diffIsoDays(rangeFrom, args.toDate) >= 180) {
          return { error: "曲线查询最多覆盖 180 个自然日" };
        }

        let totalIntegrated = 0;
        const summaries = curvesRaw.map(c => {
          const node = master.nodes?.[c.targetNodeId];
          const horizon = Math.max(7, Math.min(180, Number(c.horizonDays) || 30));
          const rangeTo = args.toDate || TS.addDaysToIso(rangeFrom, horizon - 1);
          const spanDays = TS.diffIsoDays(rangeFrom, rangeTo) + 1;
          const integratedTotal = TS.integrateCurveByDates(c, rangeFrom, TS.addDaysToIso(rangeTo, 1));
          totalIntegrated += integratedTotal;
          const qtys = TS.computeDailySeriesRange(c, rangeFrom, spanDays).map(d => d.qty);

          return {
            id: c.id,
            targetNodeId: c.targetNodeId,
            targetKind: node?.kind || "unknown",
            kind: c.kind,
            unit: c.unit || "units/day",
            horizonDays: horizon,
            pointCount: Array.isArray(c.points) ? c.points.length : 0,
            segmentCount: Array.isArray(c.totalSegments) ? c.totalSegments.length : 0,
            actualCount: Array.isArray(c.importedDailyActuals) ? c.importedDailyActuals.length : 0,
            rangeFrom,
            rangeTo,
            rangeDays: spanDays,
            integratedTotal: roundN(integratedTotal, 2),
            avgDailyRate: roundN(integratedTotal / spanDays, 2),
            minDailyQty: qtys.length ? roundN(Math.min(...qtys), 2) : 0,
            maxDailyQty: qtys.length ? roundN(Math.max(...qtys), 2) : 0
          };
        });

        const paged = slicePage(summaries, limit, offset);
        const san = sanitizeArray(execCtx, "sales_curve_summary", includeItems ? paged.items : [], privacyOpts);
        if (san.blocked) return { privacyBlocked: san.res };

        const data = { items: san.data };
        if (args.aggregate === true) {
          const allowedCats = Schema.resolveAllowedCategories(Schema.CHANNELS.MODEL_CONTEXT, execCtx.effectiveScope, execCtx.effectiveGrants);
          const agg = { scopeNote: "global_matched_before_pagination", totalCurves: summaries.length };
          if (allowedCats.has("commercial.demand")) {
            agg.totalIntegratedQty = roundN(totalIntegrated, 2);
          }
          data.aggregation = agg;
        }
        return { data, partitionsRead: ["sales/master"], pagination: paged.pagination };
      }

      /* ---------- Standard Sales Entities via SCAIPrivacy.querySales ---------- */
      const queryParams = {
        entity: args.entity,
        month: args.month,
        monthFrom: args.monthFrom,
        monthTo: args.monthTo,
        fromDate: args.fromDate,
        toDate: args.toDate,
        factoryId: args.factoryId,
        marketId: args.marketId,
        productId: args.productId,
        batchId: args.batchId,
        shipmentId: args.shipmentId,
        status: args.status,
        kind: args.factKind,
        limit: includeItems ? limit : 1,
        offset: includeItems ? offset : 0
      };

      const res = execCtx.privacy.querySales(queryParams, privacyOpts);
      if (!res.ok) return { error: res.error || "查询销售数据失败", partitionsRead: res.meta?.partitionsRead || [] };
      if (!res.allowed) return { privacyBlocked: res };

      const items = includeItems ? res.data : [];
      const pagination = {
        total: res.meta.total,
        returned: items.length,
        limit,
        offset,
        hasMore: includeItems ? Boolean(res.meta.hasMore) : res.meta.total > 0,
        truncated: items.length < res.meta.total
      };

      const data = { items };
      if (!includeItems) data.itemsOmittedByRequest = true;

      // Global pre-pagination aggregation over ONLY the manifest-selected partitions!
      if (args.aggregate === true) {
        const translatedFac = args.factoryId ? execCtx.privacy.translateInputId(["factory", "sales_factory"], args.factoryId) : undefined;
        const translatedMkt = args.marketId ? execCtx.privacy.translateInputId("market", args.marketId) : undefined;
        const translatedProduct = args.productId ? execCtx.privacy.translateInputId("product", args.productId) : undefined;
        const translatedBat = args.batchId ? execCtx.privacy.translateInputId("batch", args.batchId) : undefined;
        const translatedShp = args.shipmentId ? execCtx.privacy.translateInputId("shipment", args.shipmentId) : undefined;

        const allMatched = [];
        const partitionsRead = new Set(res.meta.partitionsRead || []);
        let scanOffset = 0;
        while (true) {
          const rawBatch = Query.querySales({
            entity: args.entity,
            month: args.month,
            monthFrom: args.monthFrom,
            monthTo: args.monthTo,
            fromDate: args.fromDate,
            toDate: args.toDate,
            factoryId: translatedFac,
            marketId: translatedMkt,
            productId: translatedProduct,
            batchId: translatedBat,
            shipmentId: translatedShp,
            status: args.status,
            kind: args.factKind,
            limit: 100,
            offset: scanOffset
          }, execCtx.queryCtx);
          allMatched.push(...(rawBatch.data || []));
          for (const id of rawBatch.meta?.partitionsRead || []) partitionsRead.add(id);
          if (!rawBatch.meta?.hasMore || !rawBatch.data?.length) break;
          scanOffset += rawBatch.data.length;
        }

        const allowedCats = Schema.resolveAllowedCategories(Schema.CHANNELS.MODEL_CONTEXT, execCtx.effectiveScope, execCtx.effectiveGrants);
        const byStatus = {};
        const byOriginMonth = {};
        const byMode = {};
        let totalQty = 0;
        let totalCost = 0;

        const batchRows = allMatched.filter(r => args.entity === "batches" || r.recordType === "batch");
        if (batchRows.length && allowedCats.has("commercial.volume")) {
          const WM = getWM();
          const master = Store.readPartition("sales/master", execCtx.queryCtx);
          if (master) partitionsRead.add("sales/master");
          const batchIds = new Set(batchRows.map(b => b.id));
          const rawWorkspace = execCtx.workspace || execCtx.queryCtx?.salesRaw
            || (!execCtx.queryCtx?.partitionProvider && Store.readRawSales(execCtx.queryCtx?.storage));
          let facts = rawWorkspace?.facts;
          if (!facts && execCtx.queryCtx?.partitionProvider) {
            const manifest = Store.loadManifest(execCtx.queryCtx);
            facts = [];
            for (const part of manifest.partitions) {
              if (part.domain !== "sales" || !part.entityIds?.factTargets?.some(id => batchIds.has(id))) continue;
              facts.push(...(Store.readPartition(part.id, execCtx.queryCtx)?.facts || []));
              partitionsRead.add(part.id);
            }
            facts.sort((a, b) => (a.recordedAt || 0) - (b.recordedAt || 0));
          }
          const productionFacts = (facts || []).filter(f => f?.kind === "production_confirmed" && batchIds.has(f.targetId));
          // The active fact may be in a later month or correct a previously
          // recorded fact to an earlier business date.
          const superseded = new Set(productionFacts.map(f => f.supersedesEventId).filter(Boolean));
          const batches = Object.fromEntries(batchRows.map(b => [b.id, { ...b }]));
          const quantities = { curves: master?.curves || {}, batches, facts: productionFacts.filter(f => !superseded.has(f.eventId)) };
          WM.projectFacts(quantities);
          for (const b of Object.values(batches)) totalQty += roundN(WM.getBatchQuantity(quantities, b), 4);
        }

        for (const r of allMatched) {
          if (r.status) byStatus[r.status] = (byStatus[r.status] || 0) + 1;
          if (r.originMonth) byOriginMonth[r.originMonth] = (byOriginMonth[r.originMonth] || 0) + 1;
          if (r.mode) byMode[r.mode] = (byMode[r.mode] || 0) + 1;
          if (typeof r.qty === "number" && args.entity !== "batches" && r.recordType !== "batch") totalQty += r.qty;

          if (args.entity === "shipments" || r.recordType === "shipment") {
            const q = Number(r.qty) || 0;
            totalCost += (Number(r.fixedCost) || 0) + (Number(r.unitCost) || 0) * q
              + (Number(r.importFeeFixed) || 0) + (Number(r.importFeePerUnit) || 0) * q;
          }
        }

        const agg = {
          scopeNote: "global_matched_before_pagination",
          totalMatched: allMatched.length
        };
        if (Object.keys(byStatus).length) agg.byStatus = byStatus;
        if (Object.keys(byOriginMonth).length) agg.byOriginMonth = byOriginMonth;
        if (Object.keys(byMode).length) agg.byMode = byMode;
        if (allowedCats.has("commercial.volume") && ["shipments", "batches", "facts", "summary"].includes(args.entity)) {
          agg.totalQty = roundN(totalQty, 2);
        }
        if (allowedCats.has("commercial.cost") && (args.entity === "shipments" || args.entity === "summary")) {
          agg.totalEstimatedLogisticsCost = roundN(totalCost, 2);
        }
        data.aggregation = agg;
        return { data, partitionsRead: [...partitionsRead], pagination };
      }

      return { data, partitionsRead: res.meta.partitionsRead || [], pagination };
    }
  };

  /* =========================================================================
     TOOL 5: query_world_state (Reuses Official SC.SimEngine!)
     ========================================================================= */
  const queryWorldStateTool = {
    name: "query_world_state",
    category: "simulation",
    readOnly: true,
    defaultScope: "inventory_risk",
    description: "调用官方确定性供应链模拟引擎（SimEngine），按指定基准日期与预测视窗计算库存、需求缺口、断货日期、发运实时进度（区分计划/预测/实际事实与逾期未确认）及异常预警。",
    useCases: [
      "获取指定业务日期（asOfDate）的全局库存、在途、待清关及缺口风险 KPI",
      "按不同基准日期重新计算发运单实时状态与逾期未确认天数",
      "查询目标市场的断货时间窗、可覆盖天数与最早可销售到达日",
      "筛选逾期、在途或清关中的发运单（复用官方 SimEngine.queryShipments）"
    ],
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        asOfDate: { type: "string", pattern: ISO_DATE_PATTERN, description: "业务基准日期 YYYY-MM-DD（默认取当前本地日期）" },
        horizonDays: { type: "integer", minimum: 7, maximum: 180, description: "预测时间视窗天数（7~180），默认 30" },
        sections: {
          type: "array",
          minItems: 1,
          maxItems: 9,
          uniqueItems: true,
          items: {
            type: "string",
            enum: ["kpis", "markets", "factories", "shipments", "batches", "corridors", "exceptions", "upcoming_events", "costs"]
          },
          description: "按需返回的数据分节，默认 ['kpis', 'markets', 'exceptions']"
        },
        marketId: { type: "string", minLength: 1, maxLength: 80, description: "按单个目标市场 ID/匿名代号筛选" },
        factoryId: { type: "string", minLength: 1, maxLength: 80, description: "按单个工厂 ID/匿名代号筛选（兼容 BOM 与销售工厂）" },
        productId: { type: "string", minLength: 1, maxLength: 80, description: "销售产品 ID/匿名代号，按已关联产品筛选发运及批次" },
        shipmentStatus: {
          type: "string",
          enum: ["all", "in_transit", "customs", "overdue", "planned", "available", "blocked", "dispatch_unconfirmed"],
          description: "发运进度筛选（复用 SimEngine.queryShipments）"
        },
        overdueOnly: { type: "boolean", description: "仅返回逾期未确认的发运单，默认 false" },
        milestoneField: { type: "string", enum: ["border", "customs", "putaway", "sellable"], description: "按里程碑字段筛选发运" },
        dateSource: { type: "string", enum: ["any", "planned", "actual", "estimated"], description: "里程碑日期来源：计划/实际/推演预计/任意" },
        dateOp: { type: "string", enum: ["before", "on_or_before", "after", "on_or_after"], description: "里程碑日期比较符" },
        dateThreshold: { type: "string", pattern: ISO_DATE_PATTERN, description: "里程碑日期阈值 YYYY-MM-DD" },
        includeDailySeries: { type: "boolean", description: "是否附带单节点日度库存序列（需指定 marketId 或 factoryId，最多 31 天），默认 false" },
        limit: { type: "integer", minimum: 1, maximum: MAX_PAGE_LIMIT, description: "列表分节返回上限（1~50），默认 20" },
        offset: { type: "integer", minimum: 0, maximum: 10000, description: "列表分节分页偏移量，默认 0" }
      }
    },
    validate(args) {
      const errs = [];
      if (args.includeDailySeries === true && !args.marketId && !args.factoryId) {
        errs.push("arguments: 开启 includeDailySeries 时必须指定 marketId 或 factoryId，避免返回全量时间序列");
      }
      if ((args.milestoneField && !args.dateThreshold) || (!args.milestoneField && args.dateThreshold)) {
        errs.push("arguments: milestoneField 与 dateThreshold 必须同时提供");
      }
      if (args.dateThreshold && getTS().parseIsoDateUtc(args.dateThreshold) === null) {
        errs.push("dateThreshold 必须是有效自然日");
      }
      return errs;
    },
    returns: {
      type: "object",
      description: "与官方 SimEngine 严格一致的脱敏状态快照（含计划/预测/实际区分与历史回放诚实声明）"
    },
    execute(args, execCtx) {
      const Sim = getSim();
      const TS = getTS();
      const Store = getStore();
      const Schema = getSchema();
      if (!Sim || typeof Sim.simulateWorkspace !== "function") {
        return { error: "当前上下文未加载官方模拟引擎 SC.SimEngine" };
      }

      const ws = loadSalesWorkspaceReadOnly(execCtx);
      if (!ws) {
        return { error: "未找到可用的销售工作区数据" };
      }

      execCtx.privacy.ensureManifestIndexed(execCtx.queryCtx);
      const manifest = Store ? Store.loadManifest(execCtx.queryCtx) : null;
      const asOfDate = args.asOfDate === undefined ? TS.todayLocalIso() : TS.requireDate(args.asOfDate, "asOfDate");
      const horizonDays = TS.requireHorizon(args.horizonDays === undefined ? ws.viewHorizonDays ?? 30 : args.horizonDays, "horizonDays", 180);
      const sections = Array.isArray(args.sections) && args.sections.length
        ? args.sections
        : ["kpis", "markets", "exceptions"];
      const limit = clampLimit(args.limit);
      const offset = clampOffset(args.offset);
      const privacyOpts = execCtx.privacyCallOpts;

      // Resolve optional factory/market filter IDs (accepting aliases & BOM factory IDs)
      let rawFactoryId = args.factoryId ? execCtx.privacy.translateInputId(["sales_factory", "factory"], args.factoryId) : null;
      if (rawFactoryId && manifest?.links?.bomFactoryToSalesNode?.[rawFactoryId]) {
        rawFactoryId = manifest.links.bomFactoryToSalesNode[rawFactoryId];
      }
      const rawMarketId = args.marketId ? execCtx.privacy.translateInputId("market", args.marketId) : null;

      const rawProductId = args.productId ? execCtx.privacy.translateInputId("product", args.productId) : null;
      const filters = { factoryId: rawFactoryId, marketId: rawMarketId, productId: rawProductId };

      // Version-aware simulation cache (keyed by revision + structural digest + asOfDate + horizonDays)
      const structuralDigest = fnv1aDigest(JSON.stringify({
        anchor: ws.inventoryAnchorDate,
        rev: ws.revision,
        prod: ws.activeProductId,
        nodes: ws.nodes,
        curves: ws.curves,
        batches: ws.batches,
        shipments: ws.shipments,
        facts: ws.facts
      }));
      const cacheKey = `${ws.workspaceId}|rev:${ws.revision}|d:${structuralDigest}|asOf:${asOfDate}|h:${horizonDays}`;

      let sim = null;
      let cacheHit = false;
      if (execCtx.simCache && execCtx.simCache.has(cacheKey)) {
        sim = execCtx.simCache.get(cacheKey);
        cacheHit = true;
      } else {
        sim = Sim.simulateWorkspace(ws, { today: asOfDate, viewHorizonDays: horizonDays });
        if (execCtx.simCache) {
          if (execCtx.simCache.size >= 32) {
            const oldestKey = execCtx.simCache.keys().next().value;
            execCtx.simCache.delete(oldestKey);
          }
          execCtx.simCache.set(cacheKey, sim);
        }
      }

      const dashboard = Sim.summarizeDashboard(ws, sim, filters);

      // Register workspace node names/metadata locally so anonymizer & rehydration stay consistent
      for (const node of Object.values(ws.nodes || {})) {
        const nt = node.kind === "market" ? "market" : "sales_factory";
        if (nt === "sales_factory" && node.bomFactoryId) {
          execCtx.privacy.registerCrossFactoryLink(node.bomFactoryId, node.id);
        }
        execCtx.privacy.anonymizeId(nt, node.id, { displayName: node.name || "" });
      }
      for (const s of Object.values(ws.shipments || {})) {
        execCtx.privacy.anonymizeId("shipment", s.id, { displayName: s.code || s.id });
      }
      for (const b of Object.values(ws.batches || {})) {
        execCtx.privacy.anonymizeId("batch", b.id, { displayName: b.code || b.id });
      }

      // Historical replay honesty check
      const factsAfterAsOf = (ws.facts || []).filter(f => f && f.date && f.date > asOfDate).length;
      let historicalReplayCaveat = null;
      if (ws.inventoryAnchorDate && asOfDate < ws.inventoryAnchorDate) {
        historicalReplayCaveat = `基准日期 ${asOfDate} 早于工作区库存锚定日 ${ws.inventoryAnchorDate}，系统缺少该历史时点快照，不能准确还原历史真实库存状态。`;
      } else if (factsAfterAsOf > 0) {
        historicalReplayCaveat = `当前工作区仅保存单一正式计划与最新事实记录（无历史版本快照），且存在 ${factsAfterAsOf} 条晚于 ${asOfDate} 的事实记录；本次结果是基于现有数据按 ${asOfDate} 重新推演的状态，不等同于当时的历史快照。`;
      }

      const data = {
        asOfDate: sim.today,
        horizonDays: sim.viewHorizonDays,
        viewEndDate: sim.viewEndDate,
        inventoryAnchorDate: ws.inventoryAnchorDate,
        semantics: {
          planVsActual: "PlannedDate 为计划，ActualDate 为已确认事实，EstimatedDate 为重算预计，EffectiveDate 为带基准日边界的推演日期。",
          dispatchBasis: "operationalStatus 表示实际物流状态，dispatchBasis=projected 表示库存校验通过的预测发运。progressStatus 和 isOverdueUnconfirmed 保留模拟进度口径。",
          stockScope: "节点库存属于仓点，市场需求与缺口属于整个市场。来源工厂和混合 SKU 无法可靠归因的库存返回空值；预计补货按路线及可售日统计。批次总量属于完整批次，可能分配给多个市场。",
          sellableRule: "上架完成日 D 的次日（D+1）开始可满足市场需求。"
        }
      };

      const sectionPagination = {};
      const allowedCats = Schema.resolveAllowedCategories(Schema.CHANNELS.MODEL_CONTEXT, execCtx.effectiveScope, execCtx.effectiveGrants);

      if (sections.includes("kpis")) {
        const k = sanitizeSingle(execCtx, "simulation_kpis", dashboard.kpis, privacyOpts);
        if (k.blocked) return { privacyBlocked: k.res };
        data.kpis = k.data;
      }

      if (sections.includes("costs")) {
        if (allowedCats.has("commercial.cost") && (rawFactoryId || rawMarketId || rawProductId)) {
          data.costs = { totalLogisticsCost: dashboard.kpis.totalLogisticsCost };
        } else if (allowedCats.has("commercial.cost")) {
          const c = sanitizeSingle(execCtx, "simulation_costs", sim.costs, privacyOpts);
          if (c.blocked) return { privacyBlocked: c.res };
          data.costs = c.data;
        } else {
          data.costs = { omittedByPrivacyScope: true, requiredCategory: "commercial.cost" };
        }
      }

      if (sections.includes("markets")) {
        const san = sanitizeArray(execCtx, "simulation_market_summary", dashboard.markets, privacyOpts);
        if (san.blocked) return { privacyBlocked: san.res };
        data.markets = san.data;
      }

      if (sections.includes("factories")) {
        const scopedDispatches = rawMarketId || rawProductId;
        const dispatchesByFactory = new Map();
        if (scopedDispatches) {
          for (const st of dashboard.shipments) {
            if (st.departIdx < sim.todayIdx || st.departIdx > sim.viewEndIdx
                || st.departDate < sim.inventoryAnchorDate || !st.executed) continue;
            dispatchesByFactory.set(st.fromNodeId, (dispatchesByFactory.get(st.fromNodeId) || 0) + st.executedQty);
          }
        }
        const rawFacSnaps = Object.values(ws.nodes)
          .filter(n => n.kind === "source" && (!rawFactoryId || n.id === rawFactoryId))
          .map(fn => {
            const daily = sim.nodeDaily[fn.id];
            const window = daily.slice(sim.todayIdx, sim.viewEndIdx + 1);
            const attributions = !rawMarketId && dashboard.hasNodeProductScope;
            const sum = key => roundN(window.reduce((total, row) => total + row[key], 0), 2);
            return {
              nodeId: fn.id,
              bomFactoryId: fn.bomFactoryId || null,
              name: fn.name || "",
              region: fn.region || "",
              currentAvailable: attributions && sim.today >= sim.inventoryAnchorDate ? roundN(window[0].endingAvailable, 2) : null,
              endingAvailable: attributions && window.at(-1).date >= sim.inventoryAnchorDate ? roundN(window.at(-1).endingAvailable, 2) : null,
              releasedProductionInWindow: attributions ? sum("releasedProduction") : null,
              dispatchesInWindow: scopedDispatches ? roundN(dispatchesByFactory.get(fn.id), 2) : sum("dispatches")
            };
          });
        const san = sanitizeArray(execCtx, "simulation_factory_snapshot", rawFacSnaps, privacyOpts);
        if (san.blocked) return { privacyBlocked: san.res };
        data.factories = san.data;
      }

      if (sections.includes("shipments")) {
        // Reuse official SimEngine.queryShipments for structured filtering!
        const matchedOrders = Sim.queryShipments(ws, sim, {
          factoryId: rawFactoryId || undefined,
          marketId: rawMarketId || undefined,
          productId: rawProductId || undefined,
          status: args.overdueOnly ? "overdue" : (args.shipmentStatus || "all"),
          milestoneField: args.milestoneField,
          dateSource: args.dateSource,
          dateOp: args.dateOp,
          dateThreshold: args.dateThreshold
        });

        const rawStates = matchedOrders
          .map(o => sim.shipmentStates?.[o.id])
          .filter(Boolean)
          .map(st => Object.assign({}, st, { isOverdueUnconfirmed: Boolean(st.overdueStage) }));

        const statusBreakdown = {};
        const operationalBreakdown = {};
        for (const st of rawStates) {
          statusBreakdown[st.progressStatus] = (statusBreakdown[st.progressStatus] || 0) + 1;
          operationalBreakdown[st.operationalStatus] = (operationalBreakdown[st.operationalStatus] || 0) + 1;
        }
        const paged = slicePage(rawStates, limit, offset);
        const san = sanitizeArray(execCtx, "simulation_shipment_state", paged.items, privacyOpts);
        if (san.blocked) return { privacyBlocked: san.res };

        data.shipments = san.data;
        data.shipmentsSummary = {
          scopeNote: "global_matched_before_pagination",
          totalMatched: rawStates.length,
          overdueUnconfirmedCount: rawStates.filter(x => x.isOverdueUnconfirmed).length,
          operationalOverdueCount: rawStates.filter(x => x.operationalOverdue).length,
          byProgressStatus: statusBreakdown,
          byOperationalStatus: operationalBreakdown
        };
        sectionPagination.shipments = paged.pagination;
      }

      if (sections.includes("batches")) {
        let rawBatches = Object.values(sim.batchStates || {});
        if (rawFactoryId) rawBatches = rawBatches.filter(b => b.sourceNodeId === rawFactoryId);
        if (rawProductId) rawBatches = rawBatches.filter(b => ws.batches[b.batchId]?.productId === rawProductId);
        if (rawMarketId) {
          const matchingBatches = new Set(dashboard.shipments.map(st => st.batchId));
          rawBatches = rawBatches.filter(b => matchingBatches.has(b.batchId));
        }
        const paged = slicePage(rawBatches, limit, offset);
        const san = sanitizeArray(execCtx, "simulation_batch_state", paged.items, privacyOpts);
        if (san.blocked) return { privacyBlocked: san.res };
        data.batches = san.data;
        sectionPagination.batches = paged.pagination;
      }

      if (sections.includes("corridors")) {
        const rawCor = Object.values(rawFactoryId || rawMarketId || rawProductId
          ? Sim.summarizeCorridors(ws, sim.shipmentStates, filters) : sim.corridors);
        const paged = slicePage(rawCor, limit, offset);
        const san = sanitizeArray(execCtx, "simulation_corridor", paged.items, privacyOpts);
        if (san.blocked) return { privacyBlocked: san.res };
        data.corridors = san.data;
        sectionPagination.corridors = paged.pagination;
      }

      if (sections.includes("exceptions")) {
        const rawExc = dashboard.exceptions;
        const paged = slicePage(rawExc, limit, offset);
        const san = sanitizeArray(execCtx, "simulation_exception", paged.items, privacyOpts);
        if (san.blocked) return { privacyBlocked: san.res };
        data.exceptions = san.data;
        sectionPagination.exceptions = paged.pagination;
      }

      if (sections.includes("upcoming_events")) {
        const rawEvts = dashboard.upcomingEvents;
        const paged = slicePage(rawEvts, limit, offset);
        const san = sanitizeArray(execCtx, "simulation_upcoming_event", paged.items, privacyOpts);
        if (san.blocked) return { privacyBlocked: san.res };
        data.upcomingEvents = san.data;
        sectionPagination.upcoming_events = paged.pagination;
      }

      if (args.includeDailySeries === true) {
        const targetNodeId = rawMarketId || rawFactoryId;
        const dailyAll = sim.nodeDaily?.[targetNodeId] || [];
        const maxDays = Math.min(31, sim.viewHorizonDays);
        const scopedDaily = rawProductId || (rawMarketId && rawFactoryId);
        const scopedShipments = dashboard.shipments.filter(st => rawMarketId
          ? st.toNodeId === targetNodeId : st.fromNodeId === targetNodeId);
        const windowSlice = dailyAll.slice(sim.todayIdx, sim.todayIdx + maxDays).map(row => {
          const point = { ...row };
          if (row.date < sim.inventoryAnchorDate || !dashboard.hasNodeProductScope || (rawMarketId && rawFactoryId)) {
            point.openingAvailable = null;
            point.endingAvailable = null;
            point.unreleasedProductionAccum = null;
            point.releasedProduction = null;
          }
          if (scopedDaily && rawMarketId) {
            Object.assign(point, Sim.summarizeShipmentFlow(scopedShipments, sim, row.date));
          }
          if (scopedDaily && !rawMarketId) {
            point.dispatches = scopedShipments.reduce((sum, st) =>
              sum + (st.executed && st.departDate === row.date && row.date >= sim.inventoryAnchorDate ? st.executedQty : 0), 0);
          }
          return point;
        });
        const san = sanitizeArray(execCtx, "simulation_daily_point", windowSlice, privacyOpts);
        if (san.blocked) return { privacyBlocked: san.res };
        data.dailySeries = {
          nodeId: execCtx.privacy.anonymizeTargetId(targetNodeId),
          daysReturned: san.data.length,
          truncated: sim.viewHorizonDays > maxDays,
          points: san.data
        };
      }

      const primaryPagination = sectionPagination.shipments || sectionPagination.batches || sectionPagination.exceptions || null;
      if (Object.keys(sectionPagination).length > 1) {
        data.sectionPagination = sectionPagination;
      }

      return {
        data,
        asOfDate: sim.today,
        cacheHit,
        historicalReplayCaveat,
        partitionsRead: ["sales/workspace_simulation"],
        pagination: primaryPagination
      };
    }
  };

  /* =========================================================================
     TOOL 6: calculate (Declarative Safe Computation — NO eval / NO arbitrary code!)
     ========================================================================= */
  const calculateTool = {
    name: "calculate",
    category: "calculation",
    readOnly: true,
    defaultScope: "relationship_only",
    description: "执行声明式白名单数值统计、分组聚合、比率差值、库存覆盖天数及 ISO 日期计算，避免模型心算误差；严禁代码执行或 eval。",
    useCases: [
      "对多笔发运数量或成本进行精确求和、均值、最值、中位数/分位数计算",
      "按匿名主体/月份/状态进行分组聚合与占比计算",
      "计算两个 ISO 日期之间的精确自然天数差或推算未来日期",
      "计算比例、变化率或给定日均需求下的库存可覆盖天数"
    ],
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["operation"],
      properties: {
        operation: {
          type: "string",
          enum: ["sum", "avg", "min_max", "median_percentile", "ratio", "delta", "weighted_avg", "group_aggregate", "date_diff", "date_add", "days_of_cover"],
          description: "允许的声明式计算操作"
        },
        values: {
          type: "array",
          minItems: 1,
          maxItems: 500,
          items: { type: "number" },
          description: "数值数组（sum/avg/min_max/median_percentile 使用）"
        },
        percentile: { type: "number", minimum: 0, maximum: 100, description: "百分位数 0~100（median_percentile 可选）" },
        numerator: { type: "number", description: "分子（ratio 使用）" },
        denominator: { type: "number", description: "分母（ratio 使用）" },
        before: { type: "number", description: "变更前基数（delta 使用）" },
        after: { type: "number", description: "变更后数值（delta 使用）" },
        items: {
          type: "array",
          minItems: 1,
          maxItems: 500,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["value", "weight"],
            properties: {
              value: { type: "number" },
              weight: { type: "number", minimum: 0 }
            }
          },
          description: "加权项数组（weighted_avg 使用）"
        },
        rows: {
          type: "array",
          minItems: 1,
          maxItems: 500,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["group", "value"],
            properties: {
              group: { type: "string", minLength: 1, maxLength: 64 },
              value: { type: "number" }
            }
          },
          description: "分组聚合数据行（group_aggregate 使用）"
        },
        startDate: { type: "string", pattern: ISO_DATE_PATTERN, description: "起始日期 YYYY-MM-DD（date_diff 使用）" },
        endDate: { type: "string", pattern: ISO_DATE_PATTERN, description: "结束日期 YYYY-MM-DD（date_diff 使用）" },
        date: { type: "string", pattern: ISO_DATE_PATTERN, description: "基准日期 YYYY-MM-DD（date_add 使用）" },
        days: { type: "integer", minimum: -3650, maximum: 3650, description: "增减天数（date_add 使用）" },
        inventory: { type: "number", minimum: 0, description: "可用库存量（days_of_cover 使用）" },
        dailyRate: { type: "number", minimum: 0, description: "日均消耗速率（days_of_cover 使用）" },
        precision: { type: "integer", minimum: 0, maximum: 6, description: "结果小数位数（0~6），默认 2" }
      }
    },
    validate(args) {
      const op = args.operation;
      if (["sum", "avg", "min_max", "median_percentile"].includes(op) && !Array.isArray(args.values)) {
        return [`arguments: ${op} 操作必须提供 values 数值数组`];
      }
      if (op === "ratio" && (typeof args.numerator !== "number" || typeof args.denominator !== "number")) {
        return ["arguments: ratio 操作必须提供 numerator 与 denominator"];
      }
      if (op === "delta" && (typeof args.before !== "number" || typeof args.after !== "number")) {
        return ["arguments: delta 操作必须提供 before 与 after"];
      }
      if (op === "weighted_avg" && !Array.isArray(args.items)) {
        return ["arguments: weighted_avg 操作必须提供 items"];
      }
      if (op === "group_aggregate" && !Array.isArray(args.rows)) {
        return ["arguments: group_aggregate 操作必须提供 rows"];
      }
      if (op === "date_diff" && (!args.startDate || !args.endDate)) {
        return ["arguments: date_diff 操作必须提供 startDate 与 endDate"];
      }
      if (op === "date_add" && (!args.date || !Number.isInteger(args.days))) {
        return ["arguments: date_add 操作必须提供 date 与整数 days"];
      }
      if (op === "days_of_cover" && (typeof args.inventory !== "number" || typeof args.dailyRate !== "number")) {
        return ["arguments: days_of_cover 操作必须提供 inventory 与 dailyRate"];
      }
      return [];
    },
    returns: {
      type: "object",
      description: "精确本地计算结果（含 operation、count/result 等结构化数值）"
    },
    execute(args, execCtx) {
      const TS = getTS();
      const op = args.operation;
      const p = Number.isInteger(args.precision) ? args.precision : 2;

      if (op === "sum") {
        const total = args.values.reduce((s, v) => s + v, 0);
        return { data: { operation: op, count: args.values.length, sum: roundN(total, p) } };
      }

      if (op === "avg") {
        const total = args.values.reduce((s, v) => s + v, 0);
        return { data: { operation: op, count: args.values.length, sum: roundN(total, p), avg: roundN(total / args.values.length, p) } };
      }

      if (op === "min_max") {
        const min = Math.min(...args.values);
        const max = Math.max(...args.values);
        return { data: { operation: op, count: args.values.length, min: roundN(min, p), max: roundN(max, p), range: roundN(max - min, p) } };
      }

      if (op === "median_percentile") {
        const sorted = args.values.slice().sort((a, b) => a - b);
        const n = sorted.length;
        const mid = Math.floor(n / 2);
        const median = n % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
        const out = { operation: op, count: n, median: roundN(median, p) };
        if (typeof args.percentile === "number") {
          const idx = (args.percentile / 100) * (n - 1);
          const lo = Math.floor(idx);
          const hi = Math.ceil(idx);
          const val = lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
          out.percentile = args.percentile;
          out.percentileValue = roundN(val, p);
        }
        return { data: out };
      }

      if (op === "ratio") {
        if (args.denominator === 0) {
          return { data: { operation: op, ratio: null, percentage: null, zeroDenominator: true } };
        }
        const ratio = args.numerator / args.denominator;
        return { data: { operation: op, ratio: roundN(ratio, Math.max(p, 4)), percentage: roundN(ratio * 100, p), zeroDenominator: false } };
      }

      if (op === "delta") {
        const abs = args.after - args.before;
        const rel = args.before === 0 ? null : roundN((abs / args.before) * 100, p);
        return { data: { operation: op, absoluteDelta: roundN(abs, p), relativeDeltaPct: rel, zeroBaseline: args.before === 0 } };
      }

      if (op === "weighted_avg") {
        let sumW = 0;
        let sumVW = 0;
        for (const it of args.items) {
          sumW += it.weight;
          sumVW += it.value * it.weight;
        }
        return {
          data: {
            operation: op,
            count: args.items.length,
            totalWeight: roundN(sumW, p),
            weightedAvg: sumW > 0 ? roundN(sumVW / sumW, p) : null
          }
        };
      }

      if (op === "group_aggregate") {
        const map = new Map();
        let grandTotal = 0;
        for (const row of args.rows) {
          // Ensure group label does not echo unauthorized sensitive text back out
          const inspected = execCtx.privacy.inspectText(row.group, { sourceKind: "calculation_label" });
          const safeGroup = inspected.findings.length > 0 ? inspected.redactedText : row.group;
          if (!map.has(safeGroup)) {
            map.set(safeGroup, { group: safeGroup, count: 0, sum: 0, min: Infinity, max: -Infinity });
          }
          const g = map.get(safeGroup);
          g.count++;
          g.sum += row.value;
          if (row.value < g.min) g.min = row.value;
          if (row.value > g.max) g.max = row.value;
          grandTotal += row.value;
        }
        const groups = Array.from(map.values()).map(g => ({
          group: g.group,
          count: g.count,
          sum: roundN(g.sum, p),
          avg: roundN(g.sum / g.count, p),
          min: roundN(g.min, p),
          max: roundN(g.max, p),
          sharePct: grandTotal !== 0 ? roundN((g.sum / grandTotal) * 100, p) : null
        }));
        return {
          data: {
            operation: op,
            totalRows: args.rows.length,
            grandTotal: roundN(grandTotal, p),
            groups
          }
        };
      }

      if (op === "date_diff") {
        if (!TS || TS.parseIsoDateUtc(args.startDate) === null || TS.parseIsoDateUtc(args.endDate) === null) {
          return { error: "无效的 ISO 日期（需为真实存在的 YYYY-MM-DD 日期）" };
        }
        const days = TS.diffIsoDays(args.startDate, args.endDate);
        return { data: { operation: op, startDate: args.startDate, endDate: args.endDate, diffDays: days } };
      }

      if (op === "date_add") {
        if (!TS || TS.parseIsoDateUtc(args.date) === null) {
          return { error: "无效的 ISO 日期（需为真实存在的 YYYY-MM-DD 日期）" };
        }
        const resultDate = TS.addDaysToIso(args.date, args.days);
        return { data: { operation: op, baseDate: args.date, deltaDays: args.days, resultDate } };
      }

      if (op === "days_of_cover") {
        if (args.dailyRate <= 0) {
          return { data: { operation: op, daysOfCover: null, zeroDemand: true } };
        }
        return { data: { operation: op, daysOfCover: roundN(args.inventory / args.dailyRate, p), zeroDemand: false } };
      }

      return { error: `不支持的计算操作：${op}` };
    }
  };

  const CORE_READ_ONLY_TOOLS = Object.freeze([
    queryBomTool,
    getBomDetailTool,
    traceSupplyChainTool,
    querySalesTool,
    queryWorldStateTool,
    calculateTool
  ]);

  function registerCoreTools(registry) {
    for (const def of CORE_READ_ONLY_TOOLS) {
      registry.register(def);
    }
    return registry;
  }

  const SCAIToolHandlers = Object.freeze({
    CORE_READ_ONLY_TOOLS,
    registerCoreTools,
    loadSalesWorkspaceReadOnly
  });

  global.SCAIToolHandlers = SCAIToolHandlers;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = SCAIToolHandlers;
  }
})(typeof window !== "undefined" ? window : globalThis);
