/**
 * AI 接入工程 · 第一阶段：数据脱敏与隐私保护自动化测试（兼容 macOS `jsc` 与 Node.js）
 * 全部采用虚构测试数据，不发起任何外部网络或模型 API 请求。
 *
 * 覆盖验收项：
 * 1. 同一主体在不同查询中具有一致的匿名身份（含敏感原始 ID 映射与别名反查）
 * 2. 脱敏后仍能完整追溯上下游、BOM 层级、跨月批次发运及跨模块关系（且保持按需读分区）
 * 3. 敏感字段、嵌套未知字段、自由文本、用户输入、历史对话、错误与日志不会绕过出口策略
 * 4. 未授权字段与未知字段默认不可发送；匿名映射表绝不泄露
 * 5. 不同数据披露范围与单主体实名授权按需生效
 * 6. 模型上下文（model_context）与联网搜索（web_search）具有严格独立的出口策略
 * 7. 脱敏全程只读，绝不修改原始业务数据、存储或模拟计算结果
 * 8. 匿名主体引用（文本与结构化 JSON）能够在本地准确恢复，且容错未知别名
 */
(function () {
  "use strict";

  const base = typeof scriptBase === "string" ? scriptBase
    : (typeof __dirname !== "undefined" && typeof require === "function"
      ? require("path").resolve(__dirname, "..") : ".");

  if (typeof load !== "function" && typeof require === "function") {
    const fs = require("fs"), vm = require("vm");
    globalThis.readFile = path => fs.readFileSync(path, "utf8");
    globalThis.load = path => vm.runInThisContext(fs.readFileSync(path, "utf8"), { filename: path });
  }
  if (typeof load === "function") {
    load(base + "/modules/bom/js/model.js");
    load(base + "/modules/sales/js/timeseries.js");
    load(base + "/modules/sales/js/world-model.js");
    load(base + "/modules/sales/js/sim-engine.js");
    load(base + "/modules/sales/js/actions.js");
    load(base + "/storage/data-store.js");
    load(base + "/shared/ai-query.js");
    load(base + "/shared/ai-privacy-schema.js");
    load(base + "/shared/ai-anonymizer.js");
    load(base + "/shared/ai-privacy.js");
  }

  const Store = globalThis.SCDataStore;
  const AIQuery = globalThis.SCAIQuery;
  const Schema = globalThis.SCAIPrivacySchema;
  const Anon = globalThis.SCAIAnonymizer;
  const Privacy = globalThis.SCAIPrivacy;
  const WM = globalThis.SC.WorldModel;
  const Act = globalThis.SC.Actions;

  let passed = 0;
  let failed = 0;
  const log = typeof console !== "undefined" && console.log ? (...a) => console.log(...a) : (...a) => print(...a);

  function assert(cond, msg) {
    if (!cond) throw new Error("Assertion failed: " + msg);
  }

  function test(name, fn) {
    try {
      fn();
      passed++;
      log("✓ " + name);
    } catch (err) {
      failed++;
      log("✗ " + name + "\n  " + (err && err.stack ? err.stack : err));
    }
  }

  function createMemoryStorage(initial) {
    const map = Object.assign({}, initial || {});
    let writes = 0;
    return {
      getItem: k => (Object.prototype.hasOwnProperty.call(map, k) ? map[k] : null),
      setItem: (k, v) => { map[k] = String(v); writes++; },
      removeItem: k => { delete map[k]; writes++; },
      getWrites: () => writes,
      raw: map
    };
  }

  /**
   * 构造含丰富敏感字段、嵌套未知字段、敏感原始 ID 及跨月/跨模块关联的虚构测试数据
   */
  function buildFictionalFixture() {
    const bom = emptyState();
    const rootNode = addDocument(bom, "星澜边缘控制器 X900");
    bom.materials[bom.nodes[rootNode].materialId].code = "XL-X900-VIP";
    bom.materials[bom.nodes[rootNode].materialId].note = "内部代号天枢，单机BOM成本 $215，禁止外泄";

    const mcuNode = addNode(bom, rootNode, { name: "核心算力板", qty: 1, unit: "块" });
    bom.materials[bom.nodes[mcuNode].materialId].code = "MCU-X900-A1";
    const chipNode = addNode(bom, mcuNode, { name: "主控芯片", qty: 2, unit: "颗" });
    bom.materials[chipNode ? bom.nodes[chipNode].materialId : ""];
    bom.materials[bom.nodes[chipNode].materialId].code = "IC-CORE-7N";

    // 使用包含敏感业务字符串的原始 ID（验证原始 ID 必须被匿名映射，绝不透传）
    const compMain = "comp_xinglan_hq";
    const compSup1 = "comp_xindun_vip";
    const compSup2 = "comp_haiguang_wafer";
    bom.companies[compMain] = {
      id: compMain,
      name: "星澜智造科技有限公司",
      location: "杭州市滨江区江南大道 888 号 3 栋",
      contact: "林夏 · 138-5710-9988 · linxia@xinglan-mfg.example",
      note: "主力总装主体，与芯盾微电子有限公司签有保底单价 ¥320 协议",
      extraFields: {
        "统一社会信用代码": "91330108MA2C9K8X2P",
        "内部底价": "$188/台",
        "年产能": "20 万台"
      },
      compliance: {
        status: "qualified",
        reason: "2026 年审核通过，联系人 138-5710-9988",
        updatedAt: 1794920499273,
        legacyScore: 92,
        internalAuditSecret: "AUDIT-SECRET-2026-Q3" // 嵌套未知字段
      },
      secretContract: { unitPrice: 188, bankAccount: "6222021234567890123" } // 顶层嵌套未知字段
    };
    bom.companies[compSup1] = {
      id: compSup1,
      name: "芯盾微电子有限公司",
      location: "深圳市南山区科技南路 66 号",
      contact: "周远 · 139-2288-7766 · zhouyuan@xindun-micro.example",
      note: "一级模组供应商，存在 RoHS 复测延期风险",
      extraFields: { "统一社会信用代码": "91440300MA5F9Q7L8K" },
      compliance: {
        status: "severe",
        reason: "RoHS 证书 2026-09 过期，涉及深圳厂区产线",
        updatedAt: 1794920499273,
        legacyScore: 54
      }
    };
    bom.companies[compSup2] = {
      id: compSup2,
      name: "海光晶圆半导体有限公司",
      location: "上海市浦东新区张江路 188 号",
      contact: "唐敏 · 136-0192-4455 · tangmin@haiguang-semi.example",
      note: "二级芯片上游，单价 $42",
      extraFields: {},
      compliance: { status: "risk", reason: "出口管制最终用户声明待补", updatedAt: 1794920499273, legacyScore: 71 }
    };

    assignCompany(bom, rootNode, compMain);
    assignCompany(bom, mcuNode, compSup1);
    assignCompany(bom, chipNode, compSup2);
    linkCompany(bom, mcuNode, compMain, compSup1);
    linkCompany(bom, chipNode, compSup1, compSup2);

    const facMain = "fac_xinglan_hz01";
    const facSecond = "fac_xinglan_sz02";
    const facSup1 = "fac_xindun_sz01";
    bom.factories[facMain] = {
      id: facMain,
      companyId: compMain,
      name: "星澜杭州总装一厂",
      location: "杭州市滨江区江南大道 888 号",
      contact: "赵厂长 · 137-0001-2233",
      note: "主力出口欧美产线，严禁外部披露具体地址",
      extraFields: { "年产能": "15 万台" },
      region: "CN",
      city: "杭州",
      nestedSecret: { lineCode: "SECRET-LINE-9" }
    };
    bom.factories[facSecond] = {
      id: facSecond,
      companyId: compMain,
      name: "星澜苏州总装二厂",
      location: "苏州市工业园区星湖街 99 号",
      contact: "",
      note: "备用总装基地",
      extraFields: {},
      region: "CN",
      city: "苏州"
    };
    bom.factories[facSup1] = {
      id: facSup1,
      companyId: compSup1,
      name: "芯盾深圳模组厂",
      location: "深圳市宝安区创新路 19 号",
      contact: "135-9988-1122",
      note: "模组SMT产线",
      extraFields: {},
      region: "CN",
      city: "深圳"
    };
    linkFactory(bom, mcuNode, compMain, compSup1, facMain, facSup1);

    setMarketAssessment(bom, bom.diagrams[0].id, compMain, "eu", {
      status: "blocked",
      evidence: [{ id: "a1", title: "芯盾微电子有限公司 RoHS 报告缺失", detail: "联系人周远 139-2288-7766 尚未补交报告", source: "内部法务邮件" }],
      pendingItems: [{ id: "a2", title: "补充欧盟 RoHS 复测证书", detail: "计划 2026-12 完成" }]
    });

    // Sales 工作区（跨越 2026-09 / 2026-10 / 2026-11 / 2026-12）
    let ws = WM.createLiveWorkspaceFromShared(null, null, "2026-09-01");
    ws.products["XL-X900-VIP"] = {
      productId: "XL-X900-VIP",
      skuCode: "XL-X900-VIP",
      name: "星澜边缘控制器 X900",
      unit: "台",
      bomDiagramId: bom.diagrams[0].id,
      bomMaterialId: bom.nodes[rootNode].materialId,
      bomVersion: 7,
      unitManufacturingCost: 215,
      costSource: "bom_linked",
      note: "内部高毛利型号"
    };
    ws.activeProductId = "XL-X900-VIP";

    ws = Act.dispatchAction(ws, Act.createAction(ws, "node.create", "", {
      nodeId: "src_xinglan_hz01", kind: "source", name: "星澜杭州总装一厂",
      region: "CN", city: "杭州", bomFactoryId: facMain, bomCompanyId: compMain, initialInventory: 4500,
      note: "关联总装一厂，内部安全库存 1200 台"
    })).workspace;
    ws.nodes.src_xinglan_hz01.nestedLeak = { bankAccount: "SECRET-ACC-01" };

    // 刻意未关联的同名工厂（验证绝不错误关联）
    ws = Act.dispatchAction(ws, Act.createAction(ws, "node.create", "", {
      nodeId: "src_unlinked_sz", kind: "source", name: "星澜苏州总装二厂",
      region: "CN", city: "苏州", initialInventory: 1800
    })).workspace;

    ws = Act.dispatchAction(ws, Act.createAction(ws, "node.create", "", {
      nodeId: "mkt_us_west", kind: "market", name: "北美西岸核心市场", region: "US", city: "洛杉矶",
      initialInventory: 620,
      marketPolicy: { priority: 1, lastMileUnitCost: 14.5, fulfillmentUnitCost: 4.8, channelCommissionUnitCost: 19.2 },
      note: "大客户专属渠道，佣金敏感"
    })).workspace;

    ws = Act.dispatchAction(ws, Act.createAction(ws, "node.create", "", {
      nodeId: "mkt_eu_north", kind: "market", name: "欧洲工业市场", region: "EU", city: "汉堡",
      initialInventory: 410,
      marketPolicy: { priority: 2, lastMileUnitCost: 11.0, fulfillmentUnitCost: 4.1, channelCommissionUnitCost: 16.0 }
    })).workspace;

    // 常用物流方案
    ws.lanes.lane_hz_us = {
      id: "lane_hz_us",
      name: "星澜杭州一厂 → 美西快船",
      fromNodeId: "src_xinglan_hz01",
      toNodeId: "mkt_us_west",
      defaultMode: "sea_express",
      defaultCarrier: "远洋快航 OceanFast",
      defaultTransitDays: 14,
      defaultFixedCost: 3400,
      defaultUnitCost: 9.6,
      defaultOriginPort: "宁波舟山港",
      defaultDestinationPort: "洛杉矶长滩港",
      defaultCustomsWaitDays: 4,
      defaultPutawayDays: 2,
      defaultImportFeeFixed: 880,
      defaultImportFeePerUnit: 11.2,
      note: "协议价有效期至 2026-12"
    };

    // 2026-09 发运
    ws = Act.dispatchAction(ws, Act.createAction(ws, "shipment.create", "", {
      shipmentId: "shp_vip_sep01", code: "SHP-XL-2609", productId: "XL-X900-VIP",
      fromNodeId: "src_xinglan_hz01", toNodeId: "mkt_us_west",
      departDate: "2026-09-10", qty: 500, transitDays: 14, fixedCost: 3200, unitCost: 9.5,
      importFeeFixed: 800, importFeePerUnit: 11.0, carrier: "远洋快航 OceanFast",
      originPort: "宁波舟山港", destinationPort: "洛杉矶长滩港",
      trackingNumber: "OFST-9920118", blNumber: "BL-2609-881", containerNo: "CMAU7654321", voyageNo: "V.2609E",
      note: "VIP 客户首批货物，单价 $299"
    })).workspace;

    // 2026-10 批次
    ws = Act.dispatchAction(ws, Act.createAction(ws, "batch.createFromInterval", "src_xinglan_hz01", {
      batchId: "bat_vip_oct01", code: "BAT-XL-2610", productId: "XL-X900-VIP",
      startDate: "2026-10-20", endDate: "2026-10-30", extraWaitDays: 2, qtyOverride: 1600,
      note: "10月核心排产批次，仅供星澜欧美大客户"
    })).workspace;

    // 2026-11 跨月发运引用 2026-10 批次 + 停靠港 + 嵌套未知字段
    ws = Act.dispatchAction(ws, Act.createAction(ws, "shipment.create", "", {
      shipmentId: "shp_vip_nov01", code: "SHP-XL-2611", productId: "XL-X900-VIP",
      laneId: "lane_hz_us", fromNodeId: "src_xinglan_hz01", toNodeId: "mkt_eu_north",
      batchId: "bat_vip_oct01", departDate: "2026-11-05", qty: 800, transitDays: 22,
      fixedCost: 3800, unitCost: 8.8, importFeeFixed: 750, importFeePerUnit: 9.2,
      carrier: "欧亚班轮 EuroLine", originPort: "上海洋山港", destinationPort: "汉堡港",
      stopoverPorts: [{ port: "新加坡港", plannedDate: "2026-11-12", actualDate: "2026-11-12", note: "代理联系人 138-0000-1111" }],
      trackingNumber: "EURL-7731209", blNumber: "BL-2611-772", containerNo: "EULU1234567", voyageNo: "V.2611W",
      note: "11月发往欧洲工业市场，货代邮箱 broker@freight.example"
    })).workspace;
    ws.shipments.shp_vip_nov01.milestones.customsBrokerPhone = "139-1111-2222";
    ws.shipments.shp_vip_nov01.stopoverPorts[0].agentSecret = "AGENT-KEY-01";
    ws.shipments.shp_vip_nov01.customSecret = { buyerMargin: 0.42 };

    // 2026-11 事实事件引用 shp_vip_nov01
    ws = Act.dispatchAction(ws, Act.createAction(ws, "event.record", "shp_vip_nov01", {
      kind: "border_arrival", date: "2026-11-27", qty: 800, actor: "ops_zhangsan@xinglan.example",
      note: "SHP-XL-2611 已靠泊汉堡港，提单 BL-2611-772"
    })).workspace;

    // 2026-12 未关联工厂发运
    ws = Act.dispatchAction(ws, Act.createAction(ws, "shipment.create", "", {
      shipmentId: "shp_dec_legacy", code: "SHP-DEC-01", productId: "XL-X900-VIP",
      fromNodeId: "src_unlinked_sz", toNodeId: "mkt_eu_north",
      departDate: "2026-12-08", qty: 300, transitDays: 18
    })).workspace;

    return {
      bom,
      ws,
      compMain,
      compSup1,
      compSup2,
      facMain,
      facSecond,
      facSup1,
      diagId: bom.diagrams[0].id
    };
  }

  /* =========================================================================
     测试 1：同一主体在不同查询中具有一致的匿名身份，且敏感原始 ID 被完全替换
     ========================================================================= */
  test("1. 同一主体在不同查询中匿名身份完全一致，敏感原始 ID 绝不透传且支持别名反查", () => {
    const f = buildFictionalFixture();
    const store = createMemoryStorage({
      "bom-flow-sim-v5": JSON.stringify(f.bom),
      "sc-sales-world-v2": JSON.stringify(f.ws)
    });
    const ctx = Privacy.createContext({ storage: store });

    const parts = ctx.listPartitions({ domain: "all" });
    const companies = ctx.queryBomEntities({ kind: "company" });
    const severe = ctx.queryBomEntities({ kind: "company", complianceStatus: "severe" });
    const mainDetail = ctx.getBomDetail({ companyId: f.compMain });
    const cross = ctx.getCrossModuleFactoryView({ bomFactoryId: f.facMain });
    const salesShps = ctx.querySales({ entity: "shipments", month: "2026-11" });
    const salesBats = ctx.querySales({ entity: "batches", month: "2026-10" });

    assert(parts.allowed && companies.allowed && severe.allowed && mainDetail.allowed && cross.allowed, "基础只读脱敏查询应全部允许");

    // 一致性校验：同一个公司/工厂/批次/发运单在所有接口中别名一致
    const severeAlias = severe.data[0].id;
    assert(Anon.isAlias(severeAlias), "严重合规供应商应使用匿名代号");
    assert(companies.data.some(c => c.id === severeAlias), "公司列表中的别名与筛选查询一致");
    assert(mainDetail.data.upstreamSuppliers[0].id === severeAlias, "上游关系中的别名与公司查询一致");
    assert(cross.data.bom.upstreamSuppliers[0].id === severeAlias, "跨模块视图中的上游别名一致");

    const facAlias = cross.data.bomFactoryId;
    const salesFacAlias = cross.data.salesNodeId;
    assert(cross.data.bom.factory.id === facAlias, "BOM 工厂 ID 别名一致");
    assert(cross.data.sales.factoryNode.id === salesFacAlias, "销售工厂节点别名一致");
    assert(parts.data.links.bomFactoryToSalesNode[facAlias] === salesFacAlias, "分区索引跨模块映射与详情视图别名一致");
    assert(salesShps.data[0].fromNodeId === salesFacAlias, "发运单起点工厂别名一致");
    assert(salesBats.data[0].sourceNodeId === salesFacAlias, "生产批次工厂别名一致");
    assert(salesShps.data[0].batchId === salesBats.data[0].id, "跨月发运单与生产批次的匿名关联一致");

    // 敏感原始 ID 绝不出现在序列化出口中
    const dumped = JSON.stringify({ parts, companies, severe, mainDetail, cross, salesShps, salesBats });
    for (const rawSecret of ["comp_xinglan_hq", "comp_xindun_vip", "fac_xinglan_hz01", "src_xinglan_hz01", "bat_vip_oct01", "shp_vip_nov01", "XL-X900-VIP"]) {
      assert(!dumped.includes(rawSecret), `原始敏感 ID「${rawSecret}」绝不可泄露到脱敏出口`);
    }

    // 支持使用匿名代号作为后续查询参数（多轮 AI 工具调用）
    const detailByAlias = ctx.getBomDetail({ companyId: severeAlias });
    assert(detailByAlias.allowed && detailByAlias.data.company.id === severeAlias, "支持通过匿名公司 ID 钻取 BOM 详情");
    const crossByAlias = ctx.getCrossModuleFactoryView({ bomFactoryId: facAlias });
    assert(crossByAlias.allowed && crossByAlias.data.linked === true && crossByAlias.data.salesNodeId === salesFacAlias, "支持通过匿名工厂 ID 查询跨模块视图");
    const shpByBatchAlias = ctx.querySales({ entity: "shipments", batchId: salesBats.data[0].id });
    assert(shpByBatchAlias.allowed && shpByBatchAlias.data.length === 1 && shpByBatchAlias.data[0].id === salesShps.data[0].id, "支持通过匿名批次 ID 追溯跨月发运");
  });

  /* =========================================================================
     测试 2：脱敏后仍能完整追溯上下游、跨月与跨模块关系，且保持精准按需读分区
     ========================================================================= */
  test("2. 脱敏后上下游/BOM层级/跨月批次事实/跨模块追溯完整，且跳过无关月份分区", () => {
    const f = buildFictionalFixture();
    const bundle = Store.exportLogicalBundle({ bomRaw: f.bom, salesRaw: f.ws });
    const reads = [];
    const provider = {
      readManifest: () => bundle["manifest.json"],
      readPartition: id => { reads.push(id); return bundle[id + ".json"] || null; }
    };
    const ctx = Privacy.createContext({ partitionProvider: provider });

    // 1) 多级 BOM 树 + 评估字典键均保持结构关联
    const diag = ctx.getBomDetail({ diagramId: f.diagId });
    assert(diag.allowed && diag.data.nodes.length === 3, "BOM 3层节点完整保留");
    const root = diag.data.nodes.find(n => n.parentId === null);
    const tier1 = diag.data.nodes.find(n => n.parentId === root.id);
    const tier2 = diag.data.nodes.find(n => n.parentId === tier1.id);
    assert(root && tier1 && tier2, "父子层级 parentId -> id 匿名化后完全连通");
    const rootCompAlias = root.companies[0].id;
    assert(diag.data.assessments[rootCompAlias]?.eu?.status === "blocked", "assessments 字典键已匿名化且可按主体关联");
    assert(diag.data.assessments[rootCompAlias]?.eu?.evidenceCount === 1, "证据条数作为安全结构指标保留");

    // 2) 工厂级路径追溯
    const facDetail = ctx.getBomDetail({ factoryId: f.facMain });
    assert(facDetail.allowed && facDetail.data.factoryPaths.length === 1, "工厂级供货路径完整保留");
    assert(facDetail.data.factoryPaths[0].receiverFactoryId === facDetail.data.factory.id, "工厂路径接收厂匿名 ID 一致");

    // 3) 跨模块显式关联 vs 未关联同名工厂
    const linked = ctx.getCrossModuleFactoryView({ bomFactoryId: f.facMain });
    const unlinked = ctx.getCrossModuleFactoryView({ bomFactoryId: f.facSecond });
    assert(linked.data.linked === true && linked.data.sales.batches.length === 1, "显式关联工厂可跨模块打通");
    assert(unlinked.data.linked === false && unlinked.data.sales === null, "未关联同名工厂保持隔离不猜测");

    // 4) 跨月事实 -> 发运单 -> 批次追溯 + 仅读取必要月份
    reads.length = 0;
    const novFacts = ctx.querySales({ entity: "facts", month: "2026-11" });
    const novShps = ctx.querySales({ entity: "shipments", month: "2026-11" });
    assert(novFacts.allowed && novFacts.data.length === 1, "查询到 11 月事实事件");
    assert(novFacts.data[0].targetId === novShps.data[0].id, "事实 targetId 与发运单匿名 ID 精确一致");
    assert(!reads.includes("sales/2026-09") && !reads.includes("sales/2026-12"), `不应读取无关月份分区，实际读取：${reads.join(",")}`);
  });

  /* =========================================================================
     测试 3：敏感字段、嵌套未知字段、自由文本、对话、错误与日志不绕过出口策略
     ========================================================================= */
  test("3. 敏感字段/嵌套未知字段/自由文本/用户输入/历史对话/错误日志均受出口策略约束", () => {
    const f = buildFictionalFixture();
    const store = createMemoryStorage({
      "bom-flow-sim-v5": JSON.stringify(f.bom),
      "sc-sales-world-v2": JSON.stringify(f.ws)
    });
    const ctx = Privacy.createContext({ storage: store });

    // A. 嵌套未知字段与 L4 字段在业务查询中被彻底剥离
    const compRes = ctx.getBomDetail({ companyId: f.compMain }, { scope: "compliance_overview" });
    const shpRes = ctx.querySales({ entity: "shipments", month: "2026-11" }, { scope: "cost_analysis" });
    const facNodeRes = ctx.querySales({ entity: "factories" }, { scope: "cost_analysis" });
    const factRes = ctx.querySales({ entity: "facts", month: "2026-11" }, { scope: "cost_analysis" });

    const serialized = JSON.stringify({ compRes: compRes.data, shpRes: shpRes.data, facNodeRes: facNodeRes.data, factRes: factRes.data });
    for (const forbidden of [
      "星澜智造科技有限公司", "芯盾微电子有限公司", "江南大道", "138-5710-9988", "linxia@",
      "91330108MA2C9K8X2P", "AUDIT-SECRET-2026-Q3", "6222021234567890123", "SECRET-ACC-01",
      "SHP-XL-2611", "EURL-7731209", "BL-2611-772", "EULU1234567", "V.2611W",
      "139-1111-2222", "AGENT-KEY-01", "buyerMargin", "broker@freight.example", "ops_zhangsan"
    ]) {
      assert(!serialized.includes(forbidden), `敏感或嵌套未知内容「${forbidden}」绝不能绕过出口策略`);
    }
    assert(compRes.audit.droppedFields.some(x => x.includes("secretContract")), "审计记录已丢弃顶层未知字段 secretContract");
    assert(compRes.audit.droppedFields.some(x => x.includes("internalAuditSecret")), "审计记录已丢弃嵌套未知字段 internalAuditSecret");
    assert(shpRes.audit.droppedFields.some(x => x.includes("customsBrokerPhone")), "审计记录已丢弃嵌套里程碑未知字段");
    assert(shpRes.audit.droppedFields.some(x => x.includes("agentSecret")), "审计记录已丢弃停靠港未知字段");
    assert(compRes.audit.blockedFreeTextFields.some(x => x.includes("note") || x.includes("reason")), "自由文本默认被阻断");

    // B. 显式开启自由文本但未人工确认 -> 必须要求确认（不直接放行，且不宣称完全匿名）
    const freeUnconfirmed = ctx.getBomDetail({ companyId: f.compMain }, {
      scope: "compliance_overview",
      grants: { allowFreeText: true }
    });
    assert(freeUnconfirmed.allowed === false && freeUnconfirmed.decision === "require_confirmation", "自由文本未确认时必须返回 require_confirmation");
    assert(freeUnconfirmed.data === null && Boolean(freeUnconfirmed.confirmationPreview), "未确认时 data 必须为 null，仅提供脱敏预览");
    assert(JSON.stringify(freeUnconfirmed.confirmationPreview).indexOf("138-5710-9988") === -1, "脱敏预览已抹去手机号");
    assert(Array.isArray(freeUnconfirmed.disclaimers) && freeUnconfirmed.disclaimers[0].includes("无法保证"), "必须包含不宣称完全匿名的明确提示");

    // C. 人工确认后可发送脱敏预览；但包含 API Key/凭据的文本即使确认也必须硬阻断
    const freeConfirmed = ctx.getBomDetail({ companyId: f.compMain }, {
      scope: "compliance_overview",
      grants: { allowFreeText: true },
      userConfirmed: true
    });
    assert(freeConfirmed.allowed === true && freeConfirmed.decision === "allow", "人工确认后允许发送脱敏后的备注");
    assert(!freeConfirmed.data.company.note.includes("芯盾微电子有限公司"), "确认后的备注中真实公司名已替换为匿名代号");

    const credBlocked = ctx.sanitizeText("请帮我分析，密钥是 sk-live1234567890abcdef", { userConfirmed: true });
    assert(credBlocked.allowed === false && credBlocked.decision === "block", "凭据/API Key 即使 userConfirmed=true 也必须硬阻断");

    // D. 用户输入、多轮历史对话、错误消息、日志脱敏
    const histRes = ctx.prepareConversationHistory([
      { role: "user", content: "请问星澜智造科技有限公司发往欧洲的 BL-2611-772 成本 ¥320 是否偏高？" },
      { role: "assistant", content: "已收到关于芯盾微电子有限公司的询问。" }
    ]);
    assert(histRes.decision === "require_confirmation" && histRes.allowed === false, "包含敏感信息的历史对话未确认前不可直接放行");
    assert(!histRes.redactedPreview[0].content.includes("星澜智造科技有限公司"), "历史对话中真实公司名已替换");
    assert(!histRes.redactedPreview[0].content.includes("BL-2611-772"), "历史对话中提单号已脱敏");
    assert(!histRes.redactedPreview[0].content.includes("¥320"), "历史对话中价格已脱敏");

    const errRes = ctx.sanitizeError(new Error("读取 /Users/alice/secret/bom.json 失败：公司 星澜智造科技有限公司 (comp_xinglan_hq) 联系 138-5710-9988"));
    assert(!errRes.message.includes("/Users/alice") && !errRes.message.includes("星澜智造科技有限公司") && !errRes.message.includes("138-5710-9988") && !errRes.message.includes("comp_xinglan_hq"),
      "错误消息中的本地路径、公司名、原始 ID 和手机号必须全部脱敏");

    const logRes = ctx.sanitizeLog({ level: "error", message: "同步 SHP-XL-2611 失败，操作员 ops_zhangsan@xinglan.example", extraRawDump: "不应保留" });
    assert(!logRes.entry.message.includes("SHP-XL-2611") && !logRes.entry.message.includes("ops_zhangsan@xinglan.example"), "日志敏感内容已脱敏");
    assert(!("extraRawDump" in logRes.entry), "日志未知字段被白名单过滤");
  });

  /* =========================================================================
     测试 4：未授权字段默认不可发送；匿名映射表绝不泄露
     ========================================================================= */
  test("4. 未授权字段默认不发送，匿名映射表实例或备份均被硬阻断且不可序列化泄露", () => {
    const f = buildFictionalFixture();
    const store = createMemoryStorage({
      "bom-flow-sim-v5": JSON.stringify(f.bom),
      "sc-sales-world-v2": JSON.stringify(f.ws)
    });
    const vault = Anon.createVault();
    const ctx = Privacy.createContext({ storage: store, vault });

    // 默认 relationship_only 不得包含任何 L2/L3/L4 字段
    const relShp = ctx.querySales({ entity: "shipments", month: "2026-11" });
    const row = relShp.data[0];
    assert(row.id && row.fromNodeId && row.toNodeId && row.batchId && row.departDate, "L1 拓扑与排程字段保留");
    assert(row.qty === undefined && row.fixedCost === undefined && row.unitCost === undefined && row.importFeeFixed === undefined, "默认策略下商业数量与成本绝不发送");
    assert(row.carrier === undefined && row.originPort === undefined && row.destinationPort === undefined, "默认策略下承运商与口岸绝不发送");
    assert(row.code === undefined && row.trackingNumber === undefined && row.blNumber === undefined && row.containerNo === undefined && row.note === undefined, "默认策略下单据号与备注绝不发送");

    // 映射表不可通过 JSON.stringify 意外泄露
    const vaultJson = JSON.stringify(vault);
    assert(vaultJson.includes("BLOCKED:LOCAL_PRIVACY_VAULT") && !vaultJson.includes("星澜") && !vaultJson.includes("comp_xinglan_hq"),
      "JSON.stringify(vault) 绝不泄露真实名称或映射表");

    // 映射表或备份传入模型出口/搜索出口/日志 -> 必须硬阻断
    const leak1 = ctx.prepareModelContext({ userMessage: "hello", accidentalVault: vault });
    assert(leak1.allowed === false && leak1.decision === "block", "传入 Vault 实例到模型出口必须硬阻断");
    const leak2 = ctx.prepareModelContext({ userMessage: "hello", accidentalBackup: vault.exportLocalBackup() });
    assert(leak2.allowed === false && leak2.decision === "block", "传入 Vault 备份到模型出口必须硬阻断");
    const leak3 = ctx.prepareModelContext({ dataViews: [{ ok: true, data: f.bom }] });
    assert(leak3.allowed === false && leak3.decision === "block", "未经过隐私保护层的原始业务对象禁止通过 prepareModelContext 出口");
  });

  /* =========================================================================
     测试 5：不同数据披露范围与单主体实名授权按需生效
     ========================================================================= */
  test("5. 不同披露范围按需生效（关系 / 库存风险 / 物流 / 成本 / 指定主体实名授权）", () => {
    const f = buildFictionalFixture();
    const store = createMemoryStorage({
      "bom-flow-sim-v5": JSON.stringify(f.bom),
      "sc-sales-world-v2": JSON.stringify(f.ws)
    });
    const ctx = Privacy.createContext({ storage: store });

    // A. inventory_risk：可见库存/数量/大区，但绝不可见成本与真实公司/工厂名
    const invMarkets = ctx.querySales({ entity: "markets" }, { scope: "inventory_risk" });
    const invShps = ctx.querySales({ entity: "shipments", month: "2026-11" }, { scope: "inventory_risk" });
    const invFacs = ctx.querySales({ entity: "factories" }, { scope: "inventory_risk" });
    assert(invMarkets.data[0].initialInventory > 0 && invMarkets.data[0].region, "库存风险范围包含市场库存与大区");
    assert(invMarkets.data[0].marketPolicy?.lastMileUnitCost === undefined, "库存风险范围不包含尾程/佣金成本");
    assert(invShps.data[0].qty === 800 && invShps.data[0].unitCost === undefined && invShps.data[0].fixedCost === undefined, "库存风险范围包含发运量但不含运费成本");
    assert(invFacs.data[0].name === undefined, "库存风险范围不需要真实工厂名称");

    // B. logistics_tracking：可见承运商、口岸、停靠港名与数量，不含成本与提单/箱号
    const logShps = ctx.querySales({ entity: "shipments", month: "2026-11" }, { scope: "logistics_tracking" });
    assert(logShps.data[0].carrier === "欧亚班轮 EuroLine" && logShps.data[0].originPort === "上海洋山港", "物流范围包含承运商与口岸");
    assert(logShps.data[0].stopoverPorts[0].port === "新加坡港" && logShps.data[0].stopoverPorts[0].note === undefined, "停靠港保留港口名但屏蔽备注");
    assert(logShps.data[0].unitCost === undefined && logShps.data[0].blNumber === undefined, "物流范围不含成本与提单号");

    // C. cost_analysis：可见成本与数量，但企业与工厂依然匿名
    const costShps = ctx.querySales({ entity: "shipments", month: "2026-11" }, { scope: "cost_analysis" });
    const costMkts = ctx.querySales({ entity: "markets" }, { scope: "cost_analysis" });
    assert(costShps.data[0].fixedCost === 3800 && costShps.data[0].unitCost === 8.8, "成本分析范围包含发运成本");
    assert(costMkts.data[0].marketPolicy.channelCommissionUnitCost > 0, "成本分析范围包含渠道履约成本");
    assert(costShps.data[0].blNumber === undefined && costMkts.data[0].name === undefined, "成本分析仍隐藏单据号与市场名称");

    // D. public_entity_lookup + 单主体实名授权（支持传入匿名代号授权！）
    const severeList = ctx.queryBomEntities({ kind: "company", complianceStatus: "severe" });
    const sup1Alias = severeList.data[0].id;
    const lookupDetail = ctx.getBomDetail({ companyId: f.compMain }, {
      scope: "public_entity_lookup",
      grants: { authorizedRealNameIds: [sup1Alias] }
    });
    assert(lookupDetail.allowed, "单主体公开核查范围允许返回");
    assert(lookupDetail.data.company.name === undefined, "未授权的主公司依然保持匿名");
    assert(lookupDetail.data.upstreamSuppliers[0].name === "芯盾微电子有限公司", "已授权的指定供应商允许披露真实名称");
    assert(lookupDetail.data.factories[0].name === undefined, "未授权工厂依然保持匿名");

    // E. 模拟引擎输出脱敏（按 inventory_risk 隐藏成本，且绝不透出 previewWorkspace）
    const simInv = ctx.simulateSalesActions([], {
      workspace: f.ws, actionsEngine: Act, worldModel: WM, scope: "inventory_risk"
    });
    assert(simInv.allowed && simInv.data.ok, "模拟结果脱敏成功");
    assert(simInv.data.previewWorkspace === undefined, "绝不暴露原始 previewWorkspace");
    assert(simInv.data.simulation.costs === undefined && simInv.data.simulation.kpis.totalCost === undefined, "inventory_risk 下模拟结果不含成本字段");
    assert(Object.keys(simInv.data.simulation.marketSummaries).every(k => Anon.isAlias(k)), "模拟市场汇总字典键已匿名化");
  });

  /* =========================================================================
     测试 6：模型上下文（model_context）与联网搜索（web_search）权限严格隔离
     ========================================================================= */
  test("6. 模型上下文与外部联网搜索具有独立出口策略，模型可见权限绝不传导至搜索服务", () => {
    const f = buildFictionalFixture();
    const store = createMemoryStorage({
      "bom-flow-sim-v5": JSON.stringify(f.bom),
      "sc-sales-world-v2": JSON.stringify(f.ws)
    });

    // 刻意给予 modelPolicy 较高权限（实名 + 成本），但 searchPolicy 默认不授权任何公司！
    const ctx = Privacy.createContext({
      storage: store,
      modelPolicy: {
        scope: "cost_analysis",
        grants: { authorizedRealNameIds: [f.compMain, f.compSup1] }
      },
      searchPolicy: {
        enabled: true,
        authorizedRealNameIds: []
      }
    });

    // 模型侧确实可见 compMain 实名与成本
    const modelView = ctx.getBomDetail({ companyId: f.compMain });
    assert(modelView.allowed && modelView.data.company.name === "星澜智造科技有限公司", "模型上下文获得 compMain 实名权限");

    // 1) 搜索侧未获授权 -> 即使模型已看到该公司名，搜索必须硬阻断！
    const s1 = ctx.prepareSearchQuery({ query: "星澜智造科技有限公司 环保处罚" });
    assert(s1.allowed === false && s1.decision === "block", "模型已获实名权限绝不能自动授予搜索服务");

    // 2) 搜索词包含内部匿名代号或原始 ID -> 硬阻断
    const compMainAlias = modelView.data.company.id;
    const s2 = ctx.prepareSearchQuery({ query: `${compMainAlias} RoHS 合规` });
    assert(s2.allowed === false && s2.decision === "block", "搜索词包含内部匿名代号必须阻断");
    const s3 = ctx.prepareSearchQuery({ query: `${f.compSup1} 公开资料` });
    assert(s3.allowed === false && s3.decision === "block", "搜索词包含内部原始 ID 必须阻断");

    // 3) 仅对 compSup1 显式授予 searchGrants -> 允许查询 compSup1 公开资料
    const s4 = ctx.prepareSearchQuery({
      query: "芯盾微电子有限公司 RoHS 环保合规 公开信息",
      searchGrants: { authorizedRealNameIds: [f.compSup1] }
    });
    assert(s4.allowed === true && s4.decision === "allow" && s4.sanitizedQuery.includes("芯盾微电子有限公司"),
      "用户显式为搜索服务授权该主体后，允许发送公开资料查询");

    // 4) 即使授权了 compSup1，混入内部价格/产量或另一家未授权公司 -> 仍必须硬阻断！
    const s5 = ctx.prepareSearchQuery({
      query: "芯盾微电子有限公司 采购价 185 美元 合作",
      searchGrants: { authorizedRealNameIds: [f.compSup1] }
    });
    assert(s5.allowed === false && s5.decision === "block", "授权公司搜索词混入内部价格指标必须阻断");

    const s6 = ctx.prepareSearchQuery({
      query: "芯盾微电子有限公司 给 星澜智造科技有限公司 供货",
      searchGrants: { authorizedRealNameIds: [f.compSup1] }
    });
    assert(s6.allowed === false && s6.decision === "block", "混入另一家未获搜索授权的内部公司必须阻断");

    // 5) 纯通用行业/法规搜索 -> 允许
    const s7 = ctx.prepareSearchQuery({ query: "EU RoHS directive 2026 electronics compliance requirements" });
    assert(s7.allowed === true && s7.decision === "allow", "通用行业法规公开搜索应放行");

    // 6) 未登记企业名称 -> 触发人工确认，确认后放行
    const s8 = ctx.prepareSearchQuery({ query: "外部公开芯片股份有限公司 2026 财报" });
    assert(s8.allowed === false && s8.decision === "require_confirmation", "未登记企业名称搜索应触发人工确认");
    const s8Confirmed = ctx.prepareSearchQuery({ query: "外部公开芯片股份有限公司 2026 财报" }, { userConfirmed: true });
    assert(s8Confirmed.allowed === true && s8Confirmed.decision === "allow", "人工确认后允许外部未登记企业公开检索");
  });

  /* =========================================================================
     测试 7：脱敏过程严格只读，绝不修改原始业务数据、存储或模拟计算结果
     ========================================================================= */
  test("7. 脱敏不修改原始业务对象、不写入业务存储、不改变索引与模拟计算结果", () => {
    const f = buildFictionalFixture();
    const rawBomBefore = JSON.stringify(f.bom);
    const rawWsBefore = JSON.stringify(f.ws);
    const stripManifestTs = b => {
      const copy = JSON.parse(JSON.stringify(b));
      if (copy["manifest.json"]) delete copy["manifest.json"].generatedAt;
      return JSON.stringify(copy);
    };
    const bundleBefore = stripManifestTs(Store.exportLogicalBundle({ bomRaw: f.bom, salesRaw: f.ws }));
    const simBefore = JSON.stringify(AIQuery.simulateSalesActions([], { workspace: f.ws, actionsEngine: Act, worldModel: WM }).simulation.kpis);

    const store = createMemoryStorage({
      "bom-flow-sim-v5": rawBomBefore,
      "sc-sales-world-v2": rawWsBefore
    });
    const ctx = Privacy.createContext({ storage: store, bomRaw: f.bom, salesRaw: f.ws });

    // 执行全套查询、脱敏、模拟、搜索校验与本地恢复
    const c = ctx.queryBomEntities({ kind: "all" });
    ctx.getBomDetail({ companyId: f.compMain }, { scope: "cost_analysis", grants: { allowFreeText: true }, userConfirmed: true });
    ctx.querySales({ entity: "summary" }, { scope: "logistics_tracking" });
    ctx.getCrossModuleFactoryView({ bomFactoryId: f.facMain }, { scope: "inventory_risk" });
    ctx.simulateSalesActions([], { workspace: f.ws, actionsEngine: Act, worldModel: WM, scope: "cost_analysis" });
    ctx.prepareSearchQuery({ query: "EU RoHS" });
    ctx.rehydrateResponse(c.data);

    assert(store.getWrites() === 0, "隐私保护层默认运行不得对业务存储产生任何写入");
    assert(JSON.stringify(f.bom) === rawBomBefore, "原始 BOM 对象必须逐字节保持不变");
    assert(JSON.stringify(f.ws) === rawWsBefore, "原始销售工作区对象必须逐字节保持不变");
    assert(store.getItem("bom-flow-sim-v5") === rawBomBefore, "存储中的 BOM JSON 保持不变");
    assert(store.getItem("sc-sales-world-v2") === rawWsBefore, "存储中的销售 JSON 保持不变");
    assert(stripManifestTs(Store.exportLogicalBundle({ bomRaw: f.bom, salesRaw: f.ws })) === bundleBefore, "逻辑分区与跨月索引结果完全不变");
    assert(JSON.stringify(AIQuery.simulateSalesActions([], { workspace: f.ws, actionsEngine: Act, worldModel: WM }).simulation.kpis) === simBefore, "官方销售模拟引擎计算结果完全不变");
  });

  /* =========================================================================
     测试 8：匿名主体引用能够在本地准确恢复（文本 + 结构化 JSON + 未知别名容错）
     ========================================================================= */
  test("8. 匿名主体引用可在本地正确恢复为真实名称与结构化档案，且容错未知别名", () => {
    const f = buildFictionalFixture();
    const store = createMemoryStorage({
      "bom-flow-sim-v5": JSON.stringify(f.bom),
      "sc-sales-world-v2": JSON.stringify(f.ws)
    });
    const ctx = Privacy.createContext({ storage: store });

    const cross = ctx.getCrossModuleFactoryView({ bomFactoryId: f.facMain, monthFrom: "2026-10", monthTo: "2026-11" });
    const compMainAlias = cross.data.bom.company.id;
    const sup1Alias = cross.data.bom.upstreamSuppliers[0].id;
    const facAlias = cross.data.bom.factory.id;
    const batAlias = cross.data.sales.batches[0].id;
    const shpAlias = cross.data.sales.shipments[0].id;

    // A. 文本回复恢复
    const aiText = `高风险提示：${sup1Alias} 存在严重合规问题，将影响 ${compMainAlias} 旗下 ${facAlias} 的批次 ${batAlias} 及发运单 ${shpAlias}（同时提及未知代号 COMP_999）。`;
    const restoredText = ctx.rehydrateResponse(aiText, { mode: "name" });
    assert(restoredText.text.includes("芯盾微电子有限公司"), "恢复上游供应商真实名称");
    assert(restoredText.text.includes("星澜智造科技有限公司"), "恢复总装公司真实名称");
    assert(restoredText.text.includes("星澜杭州总装一厂"), "恢复总装厂真实名称");
    assert(restoredText.text.includes("BAT-XL-2610"), "恢复生产批次真实编号");
    assert(restoredText.text.includes("SHP-XL-2611"), "恢复发运单真实编号");
    assert(restoredText.text.includes("COMP_999") && restoredText.unresolvedRefs.includes("COMP_999"), "未知/幻觉别名保持原样并记入 unresolvedRefs");
    assert(restoredText.resolvedRefs.length === 5, "准确返回 5 个已恢复主体引用");

    // B. 结构化 JSON 回复恢复（不修改原输入对象）
    const aiStructured = {
      riskSupplier: { entityRef: sup1Alias },
      impactedFactoryId: facAlias,
      impactedShipments: [shpAlias, "SHP_999"],
      byCompany: { [compMainAlias]: { summary: `请重点核查 ${sup1Alias}` } }
    };
    const inputSnapshot = JSON.stringify(aiStructured);

    const restoredObj = ctx.rehydrateResponse(aiStructured, { mode: "annotated" });
    assert(JSON.stringify(aiStructured) === inputSnapshot, "本地恢复绝不修改输入对象");
    assert(restoredObj.data.riskSupplier.resolvedName === "芯盾微电子有限公司", "结构化 entityRef 恢复真实名称");
    assert(restoredObj.data.riskSupplier.resolvedRawId === f.compSup1, "结构化 entityRef 恢复本地真实 ID");
    assert(restoredObj.data.impactedFactoryId === `星澜杭州总装一厂 (${facAlias})`, "annotated 模式同时保留真实名称与匿名代号");
    assert(restoredObj.data.byCompany[`星澜智造科技有限公司 (${compMainAlias})`].summary.includes("芯盾微电子有限公司"), "字典键与嵌套文本均正确恢复");
    assert(restoredObj.unresolvedRefs.includes("SHP_999"), "结构化恢复正确报告未解析别名");

    // C. 本地单条别名解析包含跨模块关联
    const resolvedFac = ctx.resolveLocalAlias(facAlias);
    assert(resolvedFac.rawId === f.facMain && resolvedFac.linkedSalesNodeId === "src_xinglan_hz01", "本地别名解析完整保留跨模块关联");
  });

  /* =========================================================================
     测试 9：边界与对抗场景（统一模型出口打包、错误原始 ID 脱敏、严格阻断、本地 Vault 持久化复用）
     ========================================================================= */
  test("9. 模型出口打包/未登记原始 ID 错误脱敏/严格阻断模式与本地映射表持久化复用", () => {
    const f = buildFictionalFixture();
    const bizStore = createMemoryStorage({
      "bom-flow-sim-v5": JSON.stringify(f.bom),
      "sc-sales-world-v2": JSON.stringify(f.ws)
    });
    const vaultStore = createMemoryStorage();

    // 1) 本地 Vault 显式开启独立持久化，跨会话保持完全一致的匿名代号（且不写入业务存储）
    const ctx1 = Privacy.createContext({ storage: bizStore, persistVault: true, vaultStorage: vaultStore });
    const q1 = ctx1.queryBomEntities({ kind: "company" });
    const firstAliases = q1.data.map(x => x.id).sort();
    assert(bizStore.getWrites() === 0, "业务存储零写入");
    assert(vaultStore.getWrites() > 0 && Boolean(vaultStore.getItem(Anon.VAULT_STORAGE_KEY)), "映射表仅写入独立的本地 Vault 存储键");

    const ctx2 = Privacy.createContext({ storage: bizStore, persistVault: true, vaultStorage: vaultStore });
    const q2 = ctx2.queryBomEntities({ kind: "company" });
    assert(JSON.stringify(q2.data.map(x => x.id).sort()) === JSON.stringify(firstAliases), "重启新会话加载本地 Vault 后匿名代号保持完全一致");

    // 2) 未登记原始 ID 报错被自动脱敏
    const missing = ctx2.getBomDetail({ companyId: "comp_unregistered_secret_99" });
    assert(missing.ok === false && !missing.error.includes("comp_unregistered_secret_99"), "查询错误中的未登记原始 ID 已被脱敏");

    // 3) prepareModelContext 正常打包 + 严格阻断不可靠文本
    const cleanBundle = ctx2.prepareModelContext({
      userMessage: "请根据提供的匿名拓扑分析单点供应风险",
      dataViews: [q2]
    });
    assert(cleanBundle.allowed === true && cleanBundle.decision === "allow", "合规数据视图与干净提示词可通过模型出口打包");
    assert(cleanBundle.payload.dataViews.length === 1, "打包结果包含已脱敏数据视图");

    const strictBlocked = ctx2.prepareModelContext({
      userMessage: "请检查 星澜智造科技有限公司 联系方式 138-5710-9988",
      dataViews: [q2]
    }, { strictBlockUnreliable: true });
    assert(strictBlocked.allowed === false && strictBlocked.decision === "block" && strictBlocked.payload === null,
      "strictBlockUnreliable 模式下不可靠自由文本应直接硬阻断");
  });

  log(`\nAI Privacy Stage 1 verification summary: ${passed} passed, ${failed} failed.`);
  if (failed > 0 && typeof quit === "function") quit(1);
  if (failed > 0 && typeof process !== "undefined") process.exit(1);
})();
