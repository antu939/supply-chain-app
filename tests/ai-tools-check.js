/**
 * AI 接入工程 · 第二阶段：统一工具接口与本地计算能力自动化测试（兼容 macOS `jsc` 与 Node.js）
 * 使用原项目内置数据（SAMPLE_BOM_STATE + DemoWorld）及虚构“双主板供应商共享上游芯片”场景数据。
 * 不发起任何真实大模型 API 或外部网络请求。
 *
 * 覆盖验收项：
 * 1. 准确查询公司、工厂、物料及上下游供货关系
 * 2. 准确识别两个主板供应商共享同一个上游芯片供应商的关系（直接与跨级共享）
 * 3. 准确跨模块追溯总装工厂、批次、发运单及目标市场（严格按显式 bomFactoryId，不猜测同名）
 * 4. query_world_state 返回的库存、需求缺口及运输状态与官方 SimEngine 100% 一致
 * 5. 相同原始数据下按不同业务基准日期重新计算运输状态、逾期未确认保护、缓存命中与失效、历史回放声明
 * 6. 分页、筛选、全局聚合与曲线摘要正确，不遗漏跨月活跃记录，且跳过无关月份分区
 * 7. 匿名 ID 正确解析，工具输出与元数据日志绝不泄露未授权数据
 * 8. 非法参数、未知工具、代码/路径注入、未授权工具/范围与写入工具均被拒绝
 * 9. 所有查询、模拟与通用计算严格只读（零原始数据变更）；原有预演接口保留但不向模型开放
 * 10. 本地模拟模型工具调用入口（支持 Standard/OpenAI/Anthropic/Gemini JSON 形态）+ 返回体积统计 + 本地恢复
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
    load(base + "/modules/bom/js/sample-data.js");
    load(base + "/modules/sales/js/timeseries.js");
    load(base + "/modules/sales/js/world-model.js");
    load(base + "/modules/sales/js/sim-engine.js");
    load(base + "/modules/sales/js/actions.js");
    load(base + "/modules/sales/js/demo-world.js");
    load(base + "/storage/data-store.js");
    load(base + "/shared/ai-query.js");
    load(base + "/shared/ai-privacy-schema.js");
    load(base + "/shared/ai-anonymizer.js");
    load(base + "/shared/ai-privacy.js");
    load(base + "/shared/ai-tool-registry.js");
    load(base + "/shared/ai-tool-handlers.js");
    load(base + "/shared/ai-tools.js");
  }

  const Store = globalThis.SCDataStore;
  const AIQuery = globalThis.SCAIQuery;
  const Anon = globalThis.SCAIAnonymizer;
  const Registry = globalThis.SCAIToolRegistry;
  const Tools = globalThis.SCAITools;
  const WM = globalThis.SC.WorldModel;
  const Sim = globalThis.SC.SimEngine;
  const Act = globalThis.SC.Actions;
  const Demo = globalThis.SC.DemoWorld;

  let passed = 0;
  let failed = 0;
  const payloadStats = [];
  const log = typeof console !== "undefined" && console.log ? (...a) => console.log(...a) : (...a) => print(...a);

  function assert(cond, msg) {
    if (!cond) throw new Error("Assertion failed: " + msg);
  }

  function recordStat(label, res) {
    if (res && res.meta) {
      payloadStats.push({ label, tool: res.tool, bytes: res.meta.payloadBytes, estTokens: res.meta.estimatedTokens });
    }
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
   * 场景 A：使用原项目内置 SAMPLE_BOM_STATE（智能网关 G200 v7）+ DemoWorld
   */
  function buildOfficialSampleFixture() {
    const bom = JSON.parse(JSON.stringify(SAMPLE_BOM_STATE));
    const today = "2026-11-22";
    const catalog = WM.extractBomCatalog(bom, "builtin_sample");
    const ws = Demo.createDemoWorkspace(catalog, today);
    return { bom, ws, today };
  }

  /**
   * 场景 B（模拟 Aster 风格多供应商共享芯片场景）：
   * 成品主机厂 -> 主板供应商 A & 主板供应商 B（双来源） -> 共同依赖同一个上游主控芯片供应商 C（严重合规问题）
   * 同时跨 2026-09 / 2026-10 / 2026-11 / 2026-12 四个月份，含显式关联总装厂与未关联同名工厂
   */
  function buildSharedChipFixture() {
    const bom = emptyState();
    const rootNode = addDocument(bom, "Aster-X1 工业主机");
    const mbNode = addNode(bom, rootNode, { name: "主控主板", qty: 1, unit: "块" });
    const chipNode = addNode(bom, mbNode, { name: "核心控制芯片", qty: 1, unit: "颗" });
    const waferNode = addNode(bom, chipNode, { name: "晶圆代工", qty: 1, unit: "片" });

    const oem = addCompany(bom, "星耀整机制造有限公司", {
      location: "杭州市滨江区星耀路 1 号",
      contact: "王总 · 138-1111-2222",
      compliance: { status: "qualified", reason: "年度审核通过" }
    }).id;
    const mbSupA = addCompany(bom, "华南主板电子有限公司", {
      location: "深圳市宝安区主板大道 10 号",
      contact: "李工 · 139-2222-3333",
      compliance: { status: "qualified", reason: "ISO 9001 有效" }
    }).id;
    const mbSupB = addCompany(bom, "长三角电路模组有限公司", {
      location: "苏州市吴中区模组路 20 号",
      contact: "周工 · 137-3333-4444",
      compliance: { status: "risk", reason: "UL 复审进行中" }
    }).id;
    const sharedChipSup = addCompany(bom, "极光微电子芯片有限公司", {
      location: "上海市浦东新区芯片路 88 号",
      contact: "陈经理 · 136-4444-5555",
      compliance: { status: "severe", reason: "RoHS 报告逾期未续，存在出口合规风险" }
    }).id;
    const sharedWaferSup = addCompany(bom, "东海晶圆代工有限公司", {
      location: "无锡市新吴区晶圆路 99 号",
      compliance: { status: "qualified", reason: "审核合格" }
    }).id;

    assignCompany(bom, rootNode, oem);
    assignCompany(bom, mbNode, mbSupA);
    assignCompany(bom, mbNode, mbSupB);
    assignCompany(bom, chipNode, sharedChipSup);
    assignCompany(bom, waferNode, sharedWaferSup);

    // 显式双主板供应关系 -> 共同指向同一家芯片供应商 -> 晶圆代工
    linkCompany(bom, mbNode, oem, mbSupA);
    linkCompany(bom, mbNode, oem, mbSupB);
    linkCompany(bom, chipNode, mbSupA, sharedChipSup);
    linkCompany(bom, chipNode, mbSupB, sharedChipSup);
    linkCompany(bom, waferNode, sharedChipSup, sharedWaferSup);

    const facMain = addFactory(bom, oem, "星耀杭州总装厂", { location: "杭州滨江", region: "CN" });
    const facSpare = addFactory(bom, oem, "星耀宁波备用厂", { location: "宁波北仑", region: "CN" });
    const facMbA = addFactory(bom, mbSupA, "华南主板深圳厂", { location: "深圳宝安", region: "CN" });
    linkFactory(bom, mbNode, oem, mbSupA, facMain, facMbA);

    let ws = WM.createLiveWorkspaceFromShared(null, null, "2026-09-01");
    ws = Act.dispatchAction(ws, Act.createAction(ws, "node.create", "", {
      nodeId: "src_aster_hz", kind: "source", name: "星耀杭州总装厂", region: "CN",
      bomFactoryId: facMain, bomCompanyId: oem, initialInventory: 3000
    })).workspace;
    // 未关联同名工厂（绝不能错误关联）
    ws = Act.dispatchAction(ws, Act.createAction(ws, "node.create", "", {
      nodeId: "src_unlinked_nb", kind: "source", name: "星耀宁波备用厂", region: "CN", initialInventory: 1000
    })).workspace;
    ws = Act.dispatchAction(ws, Act.createAction(ws, "node.create", "", {
      nodeId: "mkt_na", kind: "market", name: "北美市场", region: "US", initialInventory: 400
    })).workspace;
    ws = Act.dispatchAction(ws, Act.createAction(ws, "node.create", "", {
      nodeId: "mkt_eu", kind: "market", name: "欧盟市场", region: "EU", initialInventory: 350
    })).workspace;

    // 2026-09 发运
    ws = Act.dispatchAction(ws, Act.createAction(ws, "shipment.create", "", {
      shipmentId: "shp_09", code: "SHP-A-09", fromNodeId: "src_aster_hz", toNodeId: "mkt_na",
      departDate: "2026-09-10", qty: 500, transitDays: 14, customsWaitDays: 3, putawayDays: 2,
      fixedCost: 2600, unitCost: 9.2
    })).workspace;

    // 2026-10 批次（跨月至 11 月）
    ws = Act.dispatchAction(ws, Act.createAction(ws, "batch.createFromInterval", "src_aster_hz", {
      batchId: "bat_10", code: "BAT-A-10", startDate: "2026-10-20", endDate: "2026-11-02", extraWaitDays: 2, qtyOverride: 1500
    })).workspace;

    // 2026-10 发运，后改期至 2026-11-04（仍永久归属 2026-10 分区）
    ws = Act.dispatchAction(ws, Act.createAction(ws, "shipment.create", "", {
      shipmentId: "shp_10_resched", code: "SHP-A-10", fromNodeId: "src_aster_hz", toNodeId: "mkt_eu",
      departDate: "2026-10-26", qty: 600, transitDays: 15, customsWaitDays: 4, putawayDays: 1,
      fixedCost: 3100, unitCost: 8.5, blNumber: "BL-SECRET-10"
    })).workspace;
    ws = Act.dispatchAction(ws, Act.createAction(ws, "shipment.update", "shp_10_resched", {
      departDate: "2026-11-04"
    })).workspace;

    // 2026-11 发运绑定 2026-10 批次，发往北美
    ws = Act.dispatchAction(ws, Act.createAction(ws, "shipment.create", "", {
      shipmentId: "shp_11_from_bat", code: "SHP-A-11", fromNodeId: "src_aster_hz", toNodeId: "mkt_na",
      batchId: "bat_10", departDate: "2026-11-06", qty: 700, transitDays: 10, customsWaitDays: 3, putawayDays: 1,
      fixedCost: 2800, unitCost: 9.8, trackingNumber: "TRK-SECRET-11"
    })).workspace;

    // 2026-12 发运（来自未关联工厂）
    ws = Act.dispatchAction(ws, Act.createAction(ws, "shipment.create", "", {
      shipmentId: "shp_12_nb", code: "SHP-A-12", fromNodeId: "src_unlinked_nb", toNodeId: "mkt_eu",
      departDate: "2026-12-10", qty: 250, transitDays: 12
    })).workspace;

    return { bom, ws, oem, mbSupA, mbSupB, sharedChipSup, sharedWaferSup, facMain, facSpare, diagId: bom.diagrams[0].id };
  }

  /* =========================================================================
     测试 1：准确查询公司、工厂、物料及上下游供货关系（原项目内置 SAMPLE_BOM_STATE）
     ========================================================================= */
  test("1. 基于原项目内置 BOM 数据准确查询公司、工厂、物料及详情与全局统计", () => {
    const f = buildOfficialSampleFixture();
    const store = createMemoryStorage({
      "bom-flow-sim-v5": JSON.stringify(f.bom),
      "sc-sales-world-v2": JSON.stringify(f.ws)
    });
    const rt = Tools.createRuntime({ storage: store, workspace: f.ws });

    // 验证已注册 6 个只读核心工具且可导出多种供应商无关格式
    const toolList = rt.listTools();
    assert(toolList.length === 6, `应注册 6 个核心只读工具，实际为 ${toolList.length}`);
    assert(toolList.every(t => t.readOnly === true), "第二阶段所有注册工具均须为只读");
    const openAiDefs = rt.exportToolDefinitions("openai");
    const geminiDefs = rt.exportToolDefinitions("gemini");
    const anthropicDefs = rt.exportToolDefinitions("anthropic");
    assert(openAiDefs[0].type === "function" && openAiDefs[0].function.name, "支持导出 OpenAI Tool Calling 格式");
    assert(geminiDefs[0].name && geminiDefs[0].parameters, "支持导出 Gemini Function Calling 格式");
    assert(anthropicDefs[0].name && anthropicDefs[0].input_schema, "支持导出 Anthropic Tool Use 格式");

    // 查询严重违规公司（原内置样例有 c45 深圳芯联 & c60 苏州绿环 2 家）
    const severeRes = rt.executeTool({ id: "t1", name: "query_bom", arguments: { kind: "company", complianceStatus: "severe", limit: 1, offset: 0 } });
    recordStat("query_bom(severe,page=1)", severeRes);
    assert(severeRes.ok, "query_bom 执行成功");
    assert(severeRes.data.items.length === 1 && severeRes.meta.pagination.total === 2 && severeRes.meta.pagination.hasMore === true, "分页返回 1 条且准确标记全局总数 2");
    assert(severeRes.data.summary.totalMatched === 2 && severeRes.data.summary.scopeNote === "global_filtered_before_pagination", "分页前全局统计明确区分于当前页");

    // 查询物料列表
    const matRes = rt.executeTool({ name: "query_bom", arguments: { kind: "material", limit: 10 } });
    recordStat("query_bom(material)", matRes);
    assert(matRes.ok && matRes.data.items.length === 10 && matRes.meta.pagination.total === 21, "内置 21 种 BOM 物料查询与分页正确");

    // 使用匿名代号钻取详情
    const severeAlias = severeRes.data.items[0].id;
    assert(Anon.isAlias(severeAlias), "返回公司 ID 已匿名化");
    const detailRes = rt.executeTool({ name: "get_bom_detail", arguments: { companyId: severeAlias } });
    recordStat("get_bom_detail(company)", detailRes);
    assert(detailRes.ok && detailRes.data.company.id === severeAlias, "通过匿名代号可钻取公司详情");
    assert(detailRes.data.downstreamReceivers.length >= 1, "可追溯其下游接收方");
  });

  /* =========================================================================
     测试 2：识别两个主板供应商共享同一个上游芯片供应商（直接与跨级共享）
     ========================================================================= */
  test("2. 准确识别两个主板供应商共享同一个上游芯片供应商及更上游晶圆代工的关系", () => {
    const f = buildSharedChipFixture();
    const store = createMemoryStorage({
      "bom-flow-sim-v5": JSON.stringify(f.bom),
      "sc-sales-world-v2": JSON.stringify(f.ws)
    });
    const rt = Tools.createRuntime({ storage: store, workspace: f.ws });

    // 先查公司列表，用本地解析确认匿名代号对应关系（模拟测试断言用）
    const allComps = rt.executeTool({ name: "query_bom", arguments: { kind: "company", limit: 20 } });
    assert(allComps.ok && allComps.data.items.length === 5, "查到 5 家公司");

    const aliasOf = rawId => allComps.data.items.find(c => rt.resolveLocalAlias(c.id).rawId === rawId).id;
    const oemAlias = aliasOf(f.oem);
    const mbAAlias = aliasOf(f.mbSupA);
    const mbBAlias = aliasOf(f.mbSupB);
    const chipAlias = aliasOf(f.sharedChipSup);
    const waferAlias = aliasOf(f.sharedWaferSup);

    // 方式 1：显式传入两家主板供应商匿名代号，执行 shared_upstream
    const sharedRes = rt.executeTool({
      name: "trace_supply_chain",
      arguments: { mode: "shared_upstream", companyIds: [mbAAlias, mbBAlias] }
    });
    recordStat("trace_supply_chain(shared_upstream)", sharedRes);
    assert(sharedRes.ok, "shared_upstream 执行成功");
    assert(sharedRes.data.sharedSuppliers.length === 2, "识别出直接共享的芯片厂与间接共享的晶圆厂共 2 家");

    const directShared = sharedRes.data.sharedSuppliers.find(s => s.supplier.id === chipAlias);
    assert(Boolean(directShared), "精准识别共同依赖的上游芯片供应商");
    assert(directShared.isCommonToAllTargets === true && directShared.minDepth === 1 && directShared.supplier.complianceStatus === "severe",
      "正确标记为全部目标公司直接共享（depth=1）且携带严重合规状态");
    assert(directShared.sharedByCompanyIds.includes(mbAAlias) && directShared.sharedByCompanyIds.includes(mbBAlias),
      "准确列出共享该芯片供应商的两家主板供应商");

    const tier2Shared = sharedRes.data.sharedSuppliers.find(s => s.supplier.id === waferAlias);
    assert(Boolean(tier2Shared) && tier2Shared.minDepth === 2, "同时识别跨级共享的二级晶圆代工（depth=2）");

    // 方式 2：从整机厂向上游递归追溯，自动发现双路径汇聚的共享芯片节点
    const upRes = rt.executeTool({ name: "trace_supply_chain", arguments: { mode: "upstream", companyId: oemAlias } });
    assert(upRes.ok && upRes.data.sharedUpstreamSuppliers.some(s => s.supplier.id === chipAlias),
      "从整机厂向上游追溯也能自动识别被两家主板厂共同依赖的芯片节点");

    // 方式 3：从严重合规芯片供应商向下游影响追溯 -> 覆盖两家主板厂、整机厂与关联销售总装厂
    const downRes = rt.executeTool({ name: "trace_supply_chain", arguments: { mode: "downstream", companyId: chipAlias } });
    assert(downRes.ok && downRes.data.summary.totalImpactedReceivers === 3, "向下游追溯影响两家主板厂 + 整机厂共 3 家公司");
    assert(downRes.data.linkedSalesFactoryIds.length === 1, "下游影响追溯直达显式关联的销售总装厂");
  });

  /* =========================================================================
     测试 3：跨模块追溯总装工厂、批次、发运单及目标市场（严格按显式 bomFactoryId）
     ========================================================================= */
  test("3. 跨模块追溯总装工厂、批次、发运单及目标市场，未关联同名工厂绝不猜测", () => {
    const f = buildSharedChipFixture();
    const store = createMemoryStorage({
      "bom-flow-sim-v5": JSON.stringify(f.bom),
      "sc-sales-world-v2": JSON.stringify(f.ws)
    });
    const rt = Tools.createRuntime({ storage: store, workspace: f.ws });

    const facs = rt.executeTool({ name: "query_bom", arguments: { kind: "factory" } });
    const linkedFacAlias = facs.data.items.find(x => rt.resolveLocalAlias(x.id).rawId === f.facMain).id;
    const unlinkedFacAlias = facs.data.items.find(x => rt.resolveLocalAlias(x.id).rawId === f.facSpare).id;

    // 显式关联总装厂：完整打通 BOM 上游 + 销售批次/发运/目标市场
    const crossLinked = rt.executeTool({
      name: "trace_supply_chain",
      arguments: { mode: "cross_module", bomFactoryId: linkedFacAlias, monthFrom: "2026-10", monthTo: "2026-11" }
    });
    recordStat("trace_supply_chain(cross_module)", crossLinked);
    assert(crossLinked.ok && crossLinked.data.linked === true, "显式关联工厂 linked=true");
    assert(crossLinked.data.bom.upstreamSuppliers.length === 2, "上游关联两家主板供应商");
    assert(crossLinked.data.sales.batches.length === 1 && crossLinked.data.sales.shipments.length === 2, "下游查到 10月批次与 10/11月发运单");
    assert(crossLinked.data.downstreamMarketIds.length === 2, "追溯到北美与欧盟 2 个目标市场（均匿名）");

    // 未关联同名备用厂：严格保持 linked=false，不挂载 src_unlinked_nb
    const crossUnlinked = rt.executeTool({
      name: "trace_supply_chain",
      arguments: { mode: "cross_module", bomFactoryId: unlinkedFacAlias }
    });
    assert(crossUnlinked.ok && crossUnlinked.data.linked === false && crossUnlinked.data.sales === null,
      "未建立显式 bomFactoryId 关联的同名工厂绝不猜测连接");
  });

  /* =========================================================================
     测试 4：query_world_state 与官方模拟引擎 SimEngine 数值完全一致
     ========================================================================= */
  test("4. query_world_state 返回的库存、需求缺口与运输状态与官方 SimEngine 100% 一致", () => {
    const f = buildOfficialSampleFixture();
    const store = createMemoryStorage({
      "bom-flow-sim-v5": JSON.stringify(f.bom),
      "sc-sales-world-v2": JSON.stringify(f.ws)
    });
    const rt = Tools.createRuntime({ storage: store, workspace: f.ws });

    // 官方引擎直接计算基准值
    const official = Sim.simulateWorkspace(f.ws, { today: f.today, viewHorizonDays: 30 });

    const res = rt.executeTool({
      name: "query_world_state",
      arguments: {
        asOfDate: f.today,
        horizonDays: 30,
        sections: ["kpis", "markets", "factories", "shipments", "batches", "exceptions"]
      }
    });
    recordStat("query_world_state(full_sections)", res);
    assert(res.ok && res.meta.asOfDate === f.today, "query_world_state 执行成功且基准日期精确一致");

    // 1) KPI 逐字段严格一致（成本字段默认被 inventory_risk 隐私策略屏蔽）
    assert(res.data.kpis.currentAvailableInventory === official.kpis.currentAvailableInventory, "当前可用库存与官方引擎一致");
    assert(res.data.kpis.currentInTransit === official.kpis.currentInTransit, "在途库存与官方引擎一致");
    assert(res.data.kpis.awaitingCustoms === official.kpis.awaitingCustoms, "待清关库存与官方引擎一致");
    assert(res.data.kpis.next7DaysExpectedArrivals === official.kpis.next7DaysExpectedArrivals, "未来7天预计到货与官方引擎一致");
    assert(res.data.kpis.marketsAtRiskCount === official.kpis.marketsAtRiskCount, "风险市场数与官方引擎一致");
    assert(res.data.kpis.totalAllInCost === undefined && res.data.kpis.totalLogisticsCost === undefined, "默认 inventory_risk 范围不泄露总成本");

    // 2) 市场汇总逐项严格一致
    assert(res.data.markets.length === Object.keys(official.marketSummaries).length, "市场数量一致");
    for (const m of res.data.markets) {
      const rawId = rt.resolveLocalAlias(m.nodeId).rawId;
      const ref = official.marketSummaries[rawId];
      assert(m.currentAvailable === ref.currentAvailable, `${rawId} 当前可售库存一致`);
      assert(m.totalDemand === ref.totalDemand, `${rawId} 视窗总需求一致`);
      assert(m.totalDemandGap === ref.totalDemandGap, `${rawId} 需求缺口一致`);
      assert(m.firstGapDate === ref.firstGapDate, `${rawId} 首次断货日期一致`);
      assert(m.daysOfCoverNow === ref.daysOfCoverNow, `${rawId} 可覆盖天数一致`);
      assert(m.nextSellableDate === ref.nextSellableDate, `${rawId} 最早可售到达日一致`);
    }

    // 3) 发运实时状态与逾期未确认完全一致
    for (const s of res.data.shipments) {
      const rawId = rt.resolveLocalAlias(s.shipmentId).rawId;
      const ref = official.shipmentStates[rawId];
      assert(s.progressStatus === ref.progressStatus, `${rawId} progressStatus 一致`);
      assert(s.overdueStage === ref.overdueStage && s.overdueDays === ref.overdueDays, `${rawId} 逾期未确认状态与天数一致`);
      assert(s.earliestSellablePlannedDate === ref.earliestSellablePlannedDate, `${rawId} 计划最早可售日一致`);
      assert(s.effectiveSellableDate === ref.effectiveSellableDate, `${rawId} 推演有效可售日一致`);
      assert(s.totalCost === undefined, "inventory_risk 下发运成本被隐藏");
    }

    // 默认紧凑调用（不传 sections 时仅返回 kpis/markets/exceptions）验证体积显著更小
    const compactRes = rt.executeTool({ name: "query_world_state", arguments: { asOfDate: f.today, horizonDays: 30 } });
    recordStat("query_world_state(default_compact)", compactRes);
    assert(compactRes.ok && compactRes.meta.cacheHit === true, "相同数据/日期/视窗二次查询命中模拟缓存");
    assert(compactRes.meta.payloadBytes < res.meta.payloadBytes, "默认紧凑返回体积显著小于全量分节");
  });

  /* =========================================================================
     测试 5：相同原始数据下按不同日期重算运输状态、不自动将计划当事实、缓存失效与历史声明
     ========================================================================= */
  test("5. 相同数据按不同业务基准日期重算运输状态，逾期不自动确认，数据变更缓存失效，历史回放诚实声明", () => {
    const f = buildSharedChipFixture();
    const store = createMemoryStorage({
      "bom-flow-sim-v5": JSON.stringify(f.bom),
      "sc-sales-world-v2": JSON.stringify(f.ws)
    });
    const rt = Tools.createRuntime({ storage: store, workspace: f.ws });

    // shp_11_from_bat: departDate=2026-11-06, transitDays=10 -> borderPlanned=2026-11-16, putawayPlanned=2026-11-20
    const findShpState = (res, rawId) => res.data.shipments.find(s => rt.resolveLocalAlias(s.shipmentId).rawId === rawId);

    // 日期 1：2026-11-01（发运前）-> 必须为 planned
    const rBefore = rt.executeTool({
      name: "query_world_state",
      arguments: { asOfDate: "2026-11-01", horizonDays: 30, sections: ["shipments"] }
    });
    assert(rBefore.ok && findShpState(rBefore, "shp_11_from_bat").progressStatus === "planned", "发运日前为 planned");

    // 日期 2：2026-11-10（发运后、抵港前）-> 必须为 in_transit，无逾期
    const rTransit = rt.executeTool({
      name: "query_world_state",
      arguments: { asOfDate: "2026-11-10", horizonDays: 30, sections: ["shipments"] }
    });
    const stTransit = findShpState(rTransit, "shp_11_from_bat");
    assert(stTransit.progressStatus === "in_transit" && stTransit.isOverdueUnconfirmed === false, "航行期为 in_transit 且未逾期");

    // 日期 3：2026-11-25（已过计划抵港日 11-16 与计划上架日 11-20，但无任何实际确认事实！）
    // 必须识别为 overdue_border（逾期 9 天），绝不能自动当成 available！
    const rOverdue = rt.executeTool({
      name: "query_world_state",
      arguments: { asOfDate: "2026-11-25", horizonDays: 30, sections: ["shipments"] }
    });
    const stOverdue = findShpState(rOverdue, "shp_11_from_bat");
    assert(stOverdue.progressStatus === "overdue_border" && stOverdue.isOverdueUnconfirmed === true && stOverdue.overdueDays === 9,
      "超过计划抵港日但无实际确认时，必须标记 overdue_border(9天) 且绝不视为已到货");
    assert(stOverdue.borderArrivalActualDate === null && stOverdue.putawayCompleteActualDate === null, "实际到达日期保持 null");

    // 日期 4：早于 inventoryAnchorDate (2026-09-01) -> 必须给出明确 historicalReplayCaveat！
    const rAncient = rt.executeTool({
      name: "query_world_state",
      arguments: { asOfDate: "2026-08-15", horizonDays: 30, sections: ["kpis"] }
    });
    assert(rAncient.ok && typeof rAncient.meta.historicalReplayCaveat === "string" && rAncient.meta.historicalReplayCaveat.includes("缺少该历史时点快照"),
      "早于锚定日查询必须诚实声明无法还原历史快照");

    // 缓存失效校验：当原始工作区新增确认事实时，即使日期与视窗相同也不得返回过期缓存！
    const rCachedHit = rt.executeTool({
      name: "query_world_state",
      arguments: { asOfDate: "2026-11-25", horizonDays: 30, sections: ["shipments"] }
    });
    assert(rCachedHit.meta.cacheHit === true, "数据未变时命中缓存");

    // 在同一个 runtime 实例上验证：当底层 storage 中的工作区数据变更时，相同日期/视窗查询必须自动失效缓存并重算！
    const rtStorage = Tools.createRuntime({ storage: store });
    const sFirst = rtStorage.executeTool({ name: "query_world_state", arguments: { asOfDate: "2026-11-25", horizonDays: 30, sections: ["shipments"] } });
    const sSecond = rtStorage.executeTool({ name: "query_world_state", arguments: { asOfDate: "2026-11-25", horizonDays: 30, sections: ["shipments"] } });
    assert(sFirst.meta.cacheHit === false && sSecond.meta.cacheHit === true, "同一 runtime 相同数据第二次查询命中缓存");

    const mutatedWs = Act.dispatchAction(f.ws, Act.createAction(f.ws, "event.record", "shp_11_from_bat", {
      kind: "border_arrival", date: "2026-11-16", note: "已确认抵港"
    })).workspace;
    store.setItem("sc-sales-world-v2", JSON.stringify(mutatedWs));
    const rUpdated = rtStorage.executeTool({
      name: "query_world_state",
      arguments: { asOfDate: "2026-11-25", horizonDays: 30, sections: ["shipments"] }
    });
    assert(rUpdated.meta.cacheHit === false, "底层业务数据更新后同一 runtime 的模拟缓存必须自动失效");
    const stAfterBorder = rUpdated.data.shipments.find(s => rtStorage.resolveLocalAlias(s.shipmentId).rawId === "shp_11_from_bat");
    assert(stAfterBorder.borderArrivalActualDate === "2026-11-16" && stAfterBorder.progressStatus === "overdue_customs",
      "记录实际抵港后状态精确演进为 overdue_customs（仍不自动确认清关）");

    // 且在早于 11-16 的日期回看有晚于该日期的事实 -> 同样触发 historicalReplayCaveat！
    const rBackBeforeFact = rtStorage.executeTool({
      name: "query_world_state",
      arguments: { asOfDate: "2026-11-10", horizonDays: 30, sections: ["kpis"] }
    });
    assert(typeof rBackBeforeFact.meta.historicalReplayCaveat === "string" && rBackBeforeFact.meta.historicalReplayCaveat.includes("无历史版本快照"),
      "存在晚于基准日期的事实记录时明确提示非历史快照");
  });

  /* =========================================================================
     测试 6：分页、筛选、全局聚合与曲线摘要正确，不遗漏跨月记录且跳过无关月份分区
     ========================================================================= */
  test("6. 分页、筛选、全局聚合与曲线摘要正确，不遗漏跨月记录并精准跳过无关月份分区", () => {
    const f = buildSharedChipFixture();
    const bundle = Store.exportLogicalBundle({ bomRaw: f.bom, salesRaw: f.ws });
    const reads = [];
    const provider = {
      readManifest: () => bundle["manifest.json"],
      readPartition: id => { reads.push(id); return bundle[id + ".json"] || null; }
    };
    const rt = Tools.createRuntime({ partitionProvider: provider });

    // 1) 跨月时间窗（2026-11-01..2026-11-30）分页 limit=1 + 全局聚合 aggregate=true
    // 必须同时命中 11月新建的 shp_11_from_bat AND 10月建单改期至11月的 shp_10_resched（总量 600+700=1300），且跳过 2026-09 与 2026-12！
    const novRes = rt.executeTool({
      name: "query_sales",
      arguments: {
        entity: "shipments",
        fromDate: "2026-11-01",
        toDate: "2026-11-30",
        aggregate: true,
        limit: 1,
        offset: 0
      }
    });
    recordStat("query_sales(nov_paged+agg)", novRes);
    assert(novRes.ok, "query_sales 执行成功");
    assert(novRes.data.items.length === 1 && novRes.meta.pagination.total === 2 && novRes.meta.pagination.hasMore === true,
      "分页仅返回 1 条，明确标记总匹配 2 条与 hasMore=true");
    assert(novRes.data.aggregation.totalMatched === 2 && novRes.data.aggregation.totalQty === 1300,
      "全局聚合准确覆盖跨月改期发运（600+700=1300），不被分页截断误导");
    assert(!reads.includes("sales/2026-09") && !reads.includes("sales/2026-12"),
      `无关月份必须跳过，实际读取：${reads.join(",")}`);

    // 2) 仅取聚合不取明细（includeItems=false）实现极低体积统计
    const aggOnly = rt.executeTool({
      name: "query_sales",
      arguments: { entity: "shipments", fromDate: "2026-11-01", toDate: "2026-11-30", aggregate: true, includeItems: false }
    });
    recordStat("query_sales(agg_only)", aggOnly);
    assert(aggOnly.ok && aggOnly.data.items.length === 0 && aggOnly.data.itemsOmittedByRequest === true && aggOnly.data.aggregation.totalQty === 1300,
      "includeItems=false 返回精简全局聚合");

    // 3) 曲线聚合摘要（使用 DemoWorld 的真实生产/需求曲线）
    const demoFix = buildOfficialSampleFixture();
    const demoStore = createMemoryStorage({
      "bom-flow-sim-v5": JSON.stringify(demoFix.bom),
      "sc-sales-world-v2": JSON.stringify(demoFix.ws)
    });
    const rtDemo = Tools.createRuntime({ storage: demoStore, workspace: demoFix.ws });
    const curveRes = rtDemo.executeTool({
      name: "query_sales",
      arguments: { entity: "curves", curveKind: "demand", fromDate: demoFix.today, toDate: "2026-12-22", aggregate: true }
    });
    recordStat("query_sales(curves_summary)", curveRes);
    assert(curveRes.ok && curveRes.data.items.length === 3 && curveRes.data.items[0].integratedTotal > 0,
      "曲线查询返回紧凑积分摘要而非冗长日度数组");
    assert(!("points" in curveRes.data.items[0]), "默认不透出完整原始曲线控制点数组");
  });

  /* =========================================================================
     测试 7：匿名 ID 正确解析，工具输出与元数据日志绝不泄露未授权数据
     ========================================================================= */
  test("7. 匿名 ID 正确解析，工具输出与执行日志绝不泄露未授权敏感信息或映射表", () => {
    const f = buildSharedChipFixture();
    const store = createMemoryStorage({
      "bom-flow-sim-v5": JSON.stringify(f.bom),
      "sc-sales-world-v2": JSON.stringify(f.ws)
    });
    const rt = Tools.createRuntime({ storage: store, workspace: f.ws });

    // 按默认最小权限执行多类工具
    const r1 = rt.executeTool({ name: "query_bom", arguments: { kind: "all" } });
    const r2 = rt.executeTool({ name: "query_sales", arguments: { entity: "shipments", monthFrom: "2026-09", monthTo: "2026-12" } });
    const r3 = rt.executeTool({ name: "query_world_state", arguments: { asOfDate: "2026-11-20", sections: ["kpis", "markets", "shipments", "exceptions", "costs"] } });

    const combined = JSON.stringify({ r1, r2, r3, logs: rt.getExecutionLogs() });
    for (const secret of [
      "星耀整机制造有限公司", "华南主板电子有限公司", "极光微电子芯片有限公司", "星耀杭州总装厂",
      "138-1111-2222", "139-2222-3333", "BL-SECRET-10", "TRK-SECRET-11",
      "src_aster_hz", "bat_10", "shp_10_resched", "previewWorkspace", "rawToAlias"
    ]) {
      assert(!combined.includes(secret), `工具输出或审计日志绝不可泄露「${secret}」`);
    }

    assert(r3.data.costs.omittedByPrivacyScope === true, "未授权成本范围时 costs 节明确标记被隐私策略省略");
    // 审计日志仅保留元数据
    const logs = rt.getExecutionLogs();
    assert(logs.length === 3 && logs.every(l => typeof l.durationMs === "number" && typeof l.payloadBytes === "number" && !("data" in l) && !("arguments" in l)),
      "执行日志仅保留元数据，绝不记录完整业务载荷或原始参数值");

    // 锁定最严格范围 relationship_only 时，连数量/库存也不可输出
    const rtStrict = Tools.createRuntime({ storage: store, workspace: f.ws, scope: "relationship_only" });
    const strictShps = rtStrict.executeTool({ name: "query_sales", arguments: { entity: "shipments", month: "2026-11" } });
    assert(strictShps.ok && strictShps.data.items[0].qty === undefined, "锁定 relationship_only 时不输出商业数量");
  });

  /* =========================================================================
     测试 8：非法参数、未知工具、代码/路径注入、未授权访问与写入类工具均被拒绝
     ========================================================================= */
  test("8. 非法参数、未知工具、代码注入、越权范围与写入工具均被明确拒绝", () => {
    const f = buildSharedChipFixture();
    const store = createMemoryStorage({
      "bom-flow-sim-v5": JSON.stringify(f.bom),
      "sc-sales-world-v2": JSON.stringify(f.ws)
    });
    const rt = Tools.createRuntime({
      storage: store,
      workspace: f.ws,
      allowedTools: ["query_bom", "calculate", "query_world_state"] // 刻意不授权 query_sales
    });

    // 1) 未知工具、文件路径、代码执行尝试
    for (const badName of ["eval", "exec_js", "fs.readFile", "../storage/data-store.js", "shipment.create", "delete_all"]) {
      const r = rt.executeTool({ name: badName, arguments: {} });
      assert(!r.ok && r.error.code === "UNKNOWN_TOOL", `未注册工具/代码名「${badName}」必须被拒绝`);
    }

    // 2) 未在 allowedTools 白名单内的合法工具
    const unauthTool = rt.executeTool({ name: "query_sales", arguments: { entity: "shipments" } });
    assert(!unauthTool.ok && unauthTool.error.code === "UNAUTHORIZED", "不在授权工具列表内的工具必须拒绝");

    // 3) 外部调用企图越权申请 cost_analysis 或附加 grants
    const unauthScope = rt.executeTool({ name: "query_world_state", arguments: { sections: ["costs"] } }, { scope: "cost_analysis" });
    assert(!unauthScope.ok && unauthScope.error.code === "UNAUTHORIZED", "未授权 cost_analysis 范围必须拒绝");
    const unauthGrants = rt.executeTool({ name: "query_bom", arguments: { kind: "company" } }, { grants: { authorizedRealNameIds: [f.oem] } });
    assert(!unauthGrants.ok && unauthGrants.error.code === "UNAUTHORIZED", "非宿主受信任调用不得自行附加 grants");

    // 4) 非法参数（未知属性、枚举越界、数值越界、非法日历日期、缺少必填项、eval 字符串）
    const badExtraArg = rt.executeTool({ name: "query_bom", arguments: { kind: "company", hackSql: "DROP TABLE" } });
    assert(!badExtraArg.ok && badExtraArg.error.code === "INVALID_ARGS", "未声明的额外参数必须拒绝");

    const badLimit = rt.executeTool({ name: "query_bom", arguments: { kind: "company", limit: 999 } });
    assert(!badLimit.ok && badLimit.error.code === "INVALID_ARGS", "超限 limit 必须拒绝");

    const badDate = rt.executeTool({ name: "calculate", arguments: { operation: "date_diff", startDate: "2026-02-31", endDate: "2026-03-01" } });
    assert(!badDate.ok, "不存在的日历日期 2026-02-31 必须拒绝");

    const badOp = rt.executeTool({ name: "calculate", arguments: { operation: "eval('process.exit()')", values: [1, 2] } });
    assert(!badOp.ok && badOp.error.code === "INVALID_ARGS", "非法计算操作字符串必须拒绝");

    const badDailySeries = rt.executeTool({ name: "query_world_state", arguments: { includeDailySeries: true } });
    assert(!badDailySeries.ok && badDailySeries.error.code === "INVALID_ARGS", "未指定单节点时禁止拉取日度序列");

    // 5) 注册中心在默认第二阶段禁止注册写入类工具
    let writeRegFailed = false;
    try {
      const reg = Registry.createRegistry();
      reg.register({
        name: "mutate_shipment",
        description: "非法写入工具",
        readOnly: false,
        parameters: { type: "object", properties: {} },
        execute: () => ({ data: {} })
      });
    } catch (_) {
      writeRegFailed = true;
    }
    assert(writeRegFailed, "默认工具注册中心必须禁止注册写入类工具");
  });

  /* =========================================================================
     测试 9：calculate 通用精确计算、只读零变更保证、预演接口保留但不对模型开放
     ========================================================================= */
  test("9. calculate 精确统计与日期计算无误，全程零原始数据修改，预演接口保留但不向模型开放", () => {
    const f = buildOfficialSampleFixture();
    const bomBefore = JSON.stringify(f.bom);
    const wsBefore = JSON.stringify(f.ws);
    const store = createMemoryStorage({
      "bom-flow-sim-v5": bomBefore,
      "sc-sales-world-v2": wsBefore
    });
    const rt = Tools.createRuntime({ storage: store, workspace: f.ws });

    // calculate 各项精确计算验证
    const sumRes = rt.executeTool({ name: "calculate", arguments: { operation: "sum", values: [900, 1100, 1300, 650] } });
    assert(sumRes.ok && sumRes.data.sum === 3950 && sumRes.data.count === 4, "sum 精确计算");

    const pctRes = rt.executeTool({ name: "calculate", arguments: { operation: "median_percentile", values: [10, 20, 30, 40, 100], percentile: 90 } });
    assert(pctRes.ok && pctRes.data.median === 30 && pctRes.data.percentileValue === 76, "median 与 p90 精确计算");

    const grpRes = rt.executeTool({
      name: "calculate",
      arguments: {
        operation: "group_aggregate",
        rows: [
          { group: "MKT_001", value: 900 },
          { group: "MKT_001", value: 1100 },
          { group: "MKT_002", value: 1000 }
        ]
      }
    });
    assert(grpRes.ok && grpRes.data.grandTotal === 3000 && grpRes.data.groups.find(g => g.group === "MKT_001").sharePct === 66.67,
      "group_aggregate 分组汇总与占比精确");

    const diffRes = rt.executeTool({ name: "calculate", arguments: { operation: "date_diff", startDate: "2026-10-28", endDate: "2026-11-12" } });
    assert(diffRes.ok && diffRes.data.diffDays === 15, "跨月日期差精确等于 15 天");

    const addRes = rt.executeTool({ name: "calculate", arguments: { operation: "date_add", date: "2026-11-25", days: 10 } });
    assert(addRes.ok && addRes.data.resultDate === "2026-12-05", "跨月日期推算精确等于 2026-12-05");

    const docRes = rt.executeTool({ name: "calculate", arguments: { operation: "days_of_cover", inventory: 1950, dailyRate: 65 } });
    assert(docRes.ok && docRes.data.daysOfCover === 30, "库存可覆盖天数精确等于 30 天");

    // 校验业务修改预演接口（SCAIQuery.simulateSalesActions）保留可用，但不在 AI 工具注册中心中暴露
    assert(!rt.listTools().some(t => t.name.includes("simulate_action") || t.name.includes("mutate")),
      "修改预演接口不作为模型工具开放（留待第五阶段）");
    const dryRun = AIQuery.simulateSalesActions([
      Act.createAction(f.ws, "shipment.create", "", {
        fromNodeId: "src_cn_hz", toNodeId: "mkt_us", departDate: "2026-12-10", qty: 200, transitDays: 14
      })
    ], { workspace: f.ws, actionsEngine: Act, worldModel: WM });
    assert(dryRun.ok && Object.keys(dryRun.previewWorkspace.shipments).length === Object.keys(f.ws.shipments).length + 1,
      "已有只读修改预演接口保持正常工作");

    // 原始业务数据与存储逐字节未变
    assert(store.getWrites() === 0, "全部工具调用对业务存储零写入");
    assert(JSON.stringify(f.bom) === bomBefore, "原始 BOM 对象未修改");
    assert(JSON.stringify(f.ws) === wsBefore, "原始销售工作区未修改");
  });

  /* =========================================================================
     测试 10：模拟模型工具调用本地入口（多供应商 JSON 形态 + 端到端恢复）
     ========================================================================= */
  test("10. 本地模拟模型工具调用入口支持多供应商结构化 JSON 请求并完成端到端匿名恢复", () => {
    const f = buildSharedChipFixture();
    const store = createMemoryStorage({
      "bom-flow-sim-v5": JSON.stringify(f.bom),
      "sc-sales-world-v2": JSON.stringify(f.ws)
    });
    const rt = Tools.createRuntime({ storage: store, workspace: f.ws });

    // 先获取一次匿名列表以构造后续多步模拟调用
    const init = rt.executeTool({ name: "query_bom", arguments: { kind: "company" } });
    const aliasOf = rawId => init.data.items.find(c => rt.resolveLocalAlias(c.id).rawId === rawId).id;
    const mbAAlias = aliasOf(f.mbSupA);
    const mbBAlias = aliasOf(f.mbSupB);
    const chipAlias = aliasOf(f.sharedChipSup);

    // 混合 OpenAI / Anthropic / Gemini / Standard 四种供应商 JSON 工具调用请求
    const simSession = rt.simulateModelToolCalls({
      toolCalls: [
        {
          id: "call_openai_1",
          type: "function",
          function: {
            name: "trace_supply_chain",
            arguments: JSON.stringify({ mode: "shared_upstream", companyIds: [mbAAlias, mbBAlias] })
          }
        },
        {
          id: "toolu_anthropic_2",
          type: "tool_use",
          name: "query_world_state",
          input: { asOfDate: "2026-11-25", horizonDays: 30, sections: ["kpis", "markets", "shipments"] }
        },
        {
          functionCall: {
            name: "calculate",
            args: { operation: "date_diff", startDate: "2026-11-06", endDate: "2026-11-25" }
          }
        }
      ],
      simulatedModelAnswer: `分析结论：${mbAAlias} 与 ${mbBAlias} 共同依赖存在严重合规问题的上游 ${chipAlias}；截至 2026-11-25 已发运 19 天且存在逾期未确认发运。`
    });

    assert(simSession.ok && simSession.simulated === true, "模拟多步工具调用全部成功");
    assert(simSession.summary.totalCalls === 3 && simSession.summary.succeeded === 3 && simSession.summary.failed === 0, "3 次工具调用全部通过");
    assert(simSession.results[0].data.sharedSuppliers.some(s => s.supplier.id === chipAlias), "OpenAI 形态调用返回共享芯片供应商");
    assert(simSession.results[1].data.shipmentsSummary.overdueUnconfirmedCount >= 1, "Anthropic 形态调用准确检出逾期未确认发运");
    assert(simSession.results[2].data.diffDays === 19, "Gemini 形态调用精确返回 19 天");
    assert(simSession.rehydratedAnswer.text.includes("华南主板电子有限公司")
      && simSession.rehydratedAnswer.text.includes("长三角电路模组有限公司")
      && simSession.rehydratedAnswer.text.includes("极光微电子芯片有限公司"),
      "模拟模型匿名回答在本地准确恢复为用户可识别的真实企业名称");
  });

  log(`\nAI Tools Stage 2 verification summary: ${passed} passed, ${failed} failed.`);
  if (payloadStats.length) {
    log("Payload size metrics:");
    for (const s of payloadStats) {
      log(`  - ${s.label}: ${s.bytes} bytes (~${s.estTokens} est. tokens)`);
    }
  }
  if (failed > 0 && typeof quit === "function") quit(1);
  if (failed > 0 && typeof process !== "undefined") process.exit(1);
})();
