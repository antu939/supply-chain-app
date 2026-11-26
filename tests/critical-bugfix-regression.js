/**
 * 第一类（Critical）BUG 专项回归测试（兼容 macOS `jsc` 与 Node.js）
 * 覆盖：
 *   C1. 跨模块工厂删除保护（SCShared 缺失）与 BOM→Sales 工厂归档/恢复/地点同步
 *   C2. AI 隐私字典（Privacy Vault）首次查询后永久锁死及 indexWorkspace() 空操作导致新增实体明文泄漏
 *   C3. 盘点事实（inventory_stocktake）在当日发运与需求扣减之前执行，导致重复扣减及误阻断发运
 *   C4. AI 写操作 idempotencyKey 跨请求/跨会话碰撞（call::call_0），永久阻断后续无关写操作
 *   C5. AI 写工具参数缺少 Schema 与数值边界校验（arguments:"null" 崩溃、NaN/1e12 写坏日期、空变更、超长 BOM reason）
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
    load(base + "/shared/bom-factories.js");
    load(base + "/modules/bom/js/model.js");
    load(base + "/modules/sales/js/timeseries.js");
    load(base + "/modules/sales/js/world-model.js");
    load(base + "/modules/sales/js/sim-engine.js");
    load(base + "/modules/sales/js/actions.js");
    load(base + "/modules/sales/js/demo-world.js");
    load(base + "/storage/data-store.js");
    load(base + "/shared/bridge.js");
    load(base + "/shared/ai-query.js");
    load(base + "/shared/ai-privacy-schema.js");
    load(base + "/shared/ai-anonymizer.js");
    load(base + "/shared/ai-privacy.js");
    load(base + "/shared/ai-tool-registry.js");
    load(base + "/shared/ai-tool-handlers.js");
    load(base + "/shared/ai-tools.js");
    load(base + "/shared/ai-audit.js");
    load(base + "/shared/ai-mutations.js");
    load(base + "/shared/ai-client.js");
  }

  const BomFac = globalThis.SCBomFactories;
  const WM = globalThis.SC.WorldModel;
  const Sim = globalThis.SC.SimEngine;
  const Act = globalThis.SC.Actions;
  const Demo = globalThis.SC.DemoWorld;
  const Privacy = globalThis.SCAIPrivacy;
  const Tools = globalThis.SCAITools;
  const Mutations = globalThis.SCAIMutations;
  const Client = globalThis.SCAIClient;

  const log = typeof console !== "undefined" && console.log ? (...a) => console.log(...a) : (...a) => print(...a);
  let passed = 0;
  let failed = 0;
  const queue = [];

  function assert(cond, msg) {
    if (!cond) throw new Error("Assertion failed: " + msg);
  }

  function createMemoryStorage(initial) {
    const map = Object.assign({}, initial || {});
    return {
      getItem: k => (Object.prototype.hasOwnProperty.call(map, k) ? map[k] : null),
      setItem: (k, v) => { map[k] = String(v); },
      removeItem: k => { delete map[k]; },
      raw: map
    };
  }

  function test(name, fn) {
    queue.push({ name, fn });
  }

  function buildAiFixture() {
    const bom = emptyState();
    const root = addDocument(bom, "极光主机 X1");
    const c1 = addCompany(bom, "初始精密科技有限公司", {
      location: "杭州市滨江区",
      contact: "张工 · 138-0000-1111",
      compliance: { status: "unverified", reason: "待核实" }
    }).id;
    assignCompany(bom, root, c1);
    const f1 = addFactory(bom, c1, "杭州总装厂", { location: "杭州萧山" });

    const ws = WM.createBlankWorkspace(null, "2026-11-01");
    ws.nodes = {
      src_hz: {
        id: "src_hz", kind: "source", name: "杭州总装厂", region: "CN", city: "杭州萧山",
        bomFactoryId: f1, bomCompanyId: c1, initialInventory: 2000, entityStatus: "active"
      },
      mkt_eu: {
        id: "mkt_eu", kind: "market", name: "欧盟市场", region: "EU",
        initialInventory: 1000, marketPolicy: WM.defaultMarketPolicy()
      }
    };
    ws.curves = {
      crv_eu: WM.createEmptyCurve("crv_eu", "mkt_eu", "demand", [{ id: "p1", date: "2026-11-01", rate: 100 }], 30)
    };
    ws.shipments = {
      shp_eu_01: {
        id: "shp_eu_01", code: "SHP-EU-01", productId: ws.activeProductId,
        fromNodeId: "src_hz", toNodeId: "mkt_eu", batchId: null,
        originMonth: "2026-11", departDate: "2026-11-02", qty: 500,
        mode: "sea", carrier: "COSCO", transitDays: 18, customsWaitDays: 3, putawayDays: 1,
        fixedCost: 1000, unitCost: 5, importFeeFixed: 0, importFeePerUnit: 0,
        status: "planned",
        milestones: WM.computeDefaultMilestones("2026-11-02", 18, 3, 1)
      }
    };
    return { bom, ws, c1, f1 };
  }

  /* =========================================================================
     C1: 跨模块工厂删除保护 + BOM→Sales 工厂归档/恢复/地点同步
     ========================================================================= */
  test("C1. 跨模块工厂删除保护与 BOM→Sales 归档/恢复/地点同步（无 SCShared 时仍可靠生效）", () => {
    const bom = emptyState();
    const root = addDocument(bom, "智能终端 P1");
    const comp = addCompany(bom, "总装科技").id;
    assignCompany(bom, root, comp);
    const f1 = addFactory(bom, comp, "苏州一厂", { location: "苏州工业园区", note: "主产线" });
    const f2 = addFactory(bom, comp, "宁波二厂", { location: "宁波北仑" });

    let ws = WM.createLiveWorkspaceFromShared(null, bom, "2026-11-24");
    ws = Act.dispatchAction(ws, Act.createAction(ws, "node.create", "", {
      nodeId: "src_f1", kind: "source", name: "苏州一厂", region: "CN", city: "苏州工业园区",
      bomFactoryId: f1, bomCompanyId: comp, initialInventory: 500, emptyCurve: true
    })).workspace;
    ws = Act.dispatchAction(ws, Act.createAction(ws, "node.create", "", {
      nodeId: "mkt_us", kind: "market", name: "美国市场", region: "US", initialInventory: 100
    })).workspace;
    ws = Act.dispatchAction(ws, Act.createAction(ws, "shipment.create", "", {
      shipmentId: "shp_c1", fromNodeId: "src_f1", toNodeId: "mkt_us", departDate: "2026-11-25", qty: 200
    })).workspace;

    // 1. 删除保护：SCBomFactories.inspectFactoryUsageInSales 必须识别出 f1 存在销售关联与发运历史
    assert(typeof BomFac.inspectFactoryUsageInSales === "function", "SCBomFactories.inspectFactoryUsageInSales 必须存在");
    const usageF1 = BomFac.inspectFactoryUsageInSales(f1, ws);
    assert(usageF1.hasSalesHistory === true && usageF1.canHardDelete === false, `f1 已被 Sales 引用，必须禁止硬删除，实际: ${JSON.stringify(usageF1)}`);
    assert(usageF1.shipmentCount === 1 && usageF1.summary.length > 0, "usage 摘要必须包含发运统计");

    // 未被引用的 f2 允许删除
    const usageF2 = BomFac.inspectFactoryUsageInSales(f2, ws);
    assert(usageF2.hasSalesHistory === false && usageF2.canHardDelete === true, "未被 Sales 引用的工厂允许删除");

    // 演示数据（demo）不应阻断真实 BOM 工厂删除
    const demoWs = Demo.createDemoWorkspace(null, "2026-11-24");
    demoWs.nodes.src_cn_hz.bomFactoryId = f2;
    const usageDemo = BomFac.inspectFactoryUsageInSales(f2, demoWs);
    assert(usageDemo.hasSalesHistory === false && usageDemo.canHardDelete === true, "demo 工作区不得阻断正式 BOM 工厂删除");

    // 检查 BOM HTML 与 host-bridge.js 已接入 bom-factories.js，而非仅依赖不存在的 SCShared
    const bomHtml = readFile(base + "/modules/bom/index.html");
    const bomBridgeSrc = readFile(base + "/modules/bom/js/host-bridge.js");
    assert(bomHtml.includes("shared/bom-factories.js"), "modules/bom/index.html 必须加载 shared/bom-factories.js");
    assert(bomBridgeSrc.includes("inspectFactoryUsageInSales"), "host-bridge.js 必须调用跨模块工厂引用检查");
    assert(!/if\s*\(\s*!global\.SCShared\s*\)\s*return\s*\{\s*hasSalesHistory:\s*false/.test(bomBridgeSrc), "host-bridge.js 不得在无 SCShared 时直接放行删除");

    // 2. BOM 归档工厂后，Sales 同步必须传播 entityStatus="archived" 并阻止新发运
    bom.factories[f1].status = "archived";
    const syncArchived = WM.syncSharedEntitiesIntoWorkspace(ws, null, bom);
    assert(syncArchived.changed === true, "BOM 归档工厂必须触发 Sales 同步变更");
    assert(ws.nodes.src_f1.entityStatus === "archived", `Sales 关联节点必须同步为 archived，实际为 ${ws.nodes.src_f1.entityStatus}`);
    const blockedShp = Act.dispatchAction(ws, Act.createAction(ws, "shipment.create", "", {
      fromNodeId: "src_f1", toNodeId: "mkt_us", departDate: "2026-11-26", qty: 50
    }));
    assert(blockedShp.ok === false, "已归档工厂不得允许新建发运");

    // 3. BOM 恢复工厂并修改地点后，Sales 同步必须恢复 active 并更新 city
    bom.factories[f1].status = "active";
    bom.factories[f1].location = "苏州吴江新厂区";
    const syncRestored = WM.syncSharedEntitiesIntoWorkspace(ws, null, bom);
    assert(syncRestored.changed === true, "恢复启用与改地点必须触发同步变更");
    assert(ws.nodes.src_f1.entityStatus === "active", "Sales 节点必须恢复为 active");
    assert(ws.nodes.src_f1.city === "苏州吴江新厂区", `地点修改必须同步到 city，实际为 ${ws.nodes.src_f1.city}`);

    // 4. Demo 工作区不得被 BOM 同步覆盖工厂名
    const origDemoName = demoWs.nodes.src_cn_hz.name;
    const syncDemo = WM.syncLinkedBomFactoryNames(demoWs, WM.readBomFinalAssemblyFactories(bom), bom);
    assert(syncDemo.changed === false && demoWs.nodes.src_cn_hz.name === origDemoName, "Demo 工作区不得被 BOM 同步改写");
  });

  /* =========================================================================
     C2: AI 隐私字典永久锁死 + indexWorkspace() 空操作导致新增实体明文外泄
     ========================================================================= */
  test("C2. 隐私字典在新增实体后自动刷新且 indexWorkspace() 强制重建，绝不明文外泄新实体", () => {
    const f = buildAiFixture();
    const store = createMemoryStorage({
      "bom-flow-sim-v5": JSON.stringify(f.bom),
      "sc-sales-world-v2": JSON.stringify(f.ws)
    });

    const privacy = Privacy.createContext({ storage: store });

    // 第 1 次查询，触发初始索引并锁住旧版标志位
    const first = privacy.sanitizeText("请查看初始精密科技有限公司的情况");
    assert(!(first.text || first.redactedText || "").includes("初始精密科技有限公司"), "已有公司应被脱敏");

    // 用户在同一会话中于 BOM 新增一家敏感公司与联系电话
    const bom2 = JSON.parse(store.getItem("bom-flow-sim-v5"));
    const newCompId = addCompany(bom2, "星穹绝密芯片", {
      location: "保密园区 9 号",
      contact: "陈总 · 139-7777-6666"
    }).id;
    store.setItem("bom-flow-sim-v5", JSON.stringify(bom2));

    // 不重建 privacy 上下文，直接二次提问：新公司名与新联系人绝不能明文放行！
    const second = privacy.sanitizeText("请帮我分析星穹绝密芯片的风险");
    assert(!(second.text || "").includes("星穹绝密芯片"), `新增实体名不应明文泄漏，实际输出: ${JSON.stringify(second)}`);
    assert(!(second.redactedText || "").includes("星穹绝密芯片"), `redactedText 也不得含新增实体明文，实际: ${second.redactedText}`);

    // 外部联网搜索同样不得明文放行新增的内部公司名
    const searchGate = privacy.prepareSearchQuery({ query: "星穹绝密芯片 环保处罚" });
    assert(searchGate.allowed === false && searchGate.decision !== "allow", `新增内部公司不得放行至联网搜索，实际: ${JSON.stringify(searchGate)}`);

    // 再次新增另一家实体并显式调用 indexWorkspace()，必须生效而非空操作
    const bom3 = JSON.parse(store.getItem("bom-flow-sim-v5"));
    addCompany(bom3, "天枢隐秘封装", { contact: "136-1234-5678" });
    store.setItem("bom-flow-sim-v5", JSON.stringify(bom3));
    const statsBefore = privacy.getVaultStats().totalMappedEntities;
    privacy.indexWorkspace();
    const statsAfter = privacy.getVaultStats().totalMappedEntities;
    assert(statsAfter > statsBefore, `indexWorkspace() 不得是空操作（before=${statsBefore}, after=${statsAfter}）`);
    const third = privacy.sanitizeText("查询天枢隐秘封装的状态");
    assert(!(third.text || "").includes("天枢隐秘封装"), `indexWorkspace() 后仍泄漏实体: ${JSON.stringify(third)}`);
    assert(Boolean(newCompId), "sanity");
  });

  /* =========================================================================
     C3: 盘点事实（inventory_stocktake）应在当日发运与需求扣减之后生效
     ========================================================================= */
  test("C3. 盘点事实（inventory_stocktake）在当日发运与需求扣减后结算，不重复扣减且不误阻断当日发运", () => {
    const TODAY = "2026-11-24";
    const ws = WM.createBlankWorkspace(null, TODAY);
    ws.nodes = {
      src_1: { id: "src_1", kind: "source", name: "一厂", region: "CN", initialInventory: 1300 },
      mkt_1: { id: "mkt_1", kind: "market", name: "美国市场", region: "US", initialInventory: 1000, marketPolicy: WM.defaultMarketPolicy() }
    };
    ws.curves = {
      crv_mkt: WM.createEmptyCurve("crv_mkt", "mkt_1", "demand", [{ id: "p1", date: TODAY, rate: 145 }], 30)
    };
    ws.shipments = {
      shp_today: {
        id: "shp_today", code: "SHP-TODAY", productId: ws.activeProductId,
        fromNodeId: "src_1", toNodeId: "mkt_1", batchId: null,
        originMonth: "2026-11", departDate: TODAY, qty: 800,
        mode: "sea", carrier: "COSCO", transitDays: 10, customsWaitDays: 2, putawayDays: 1,
        fixedCost: 500, unitCost: 2, importFeeFixed: 0, importFeePerUnit: 0,
        status: "planned",
        milestones: WM.computeDefaultMilestones(TODAY, 10, 2, 1)
      }
    };
    // 市场盘点今日实测日终可售 1000；工厂当日发运 800 后盘点日终剩余 500
    ws.facts = [
      { eventId: "ev_stk_mkt", kind: "inventory_stocktake", date: TODAY, targetId: "mkt_1", qty: 1000, note: "盘点校正", recordedAt: Date.now(), actor: "user" },
      { eventId: "ev_stk_src", kind: "inventory_stocktake", date: TODAY, targetId: "src_1", qty: 500, note: "盘点校正", recordedAt: Date.now(), actor: "user" }
    ];

    const sim = Sim.simulateWorkspace(ws, { today: TODAY, viewHorizonDays: 10 });
    const mktDay0 = sim.nodeDaily.mkt_1.find(x => x.date === TODAY);
    const srcDay0 = sim.nodeDaily.src_1.find(x => x.date === TODAY);
    const shpState = sim.shipmentStates.shp_today;

    assert(mktDay0.endingAvailable === 1000, `市场盘点 1000 后当日结余应精确为 1000（不应被再扣 145 成 855），实际: ${mktDay0.endingAvailable}`);
    assert(Math.abs(mktDay0.conservationDelta) < 1e-6, `市场库存守恒 Δ 应为 0，实际: ${mktDay0.conservationDelta}`);
    assert(shpState.executed === true && shpState.progressStatus !== "blocked", `工厂当日发运 800 不应被日终盘点 500 阻断，实际状态: ${shpState.progressStatus}`);
    assert(srcDay0.endingAvailable === 500, `工厂盘点 500 后当日结余应精确为 500，实际: ${srcDay0.endingAvailable}`);
    assert(Math.abs(srcDay0.conservationDelta) < 1e-6, `工厂库存守恒 Δ 应为 0，实际: ${srcDay0.conservationDelta}`);

    // 再验证下调盘点（如市场实盘 500 < 原本日终 855，且次日起日需求 10）：当日结余精确 500 且 7 天最低库存为 440（而非被扣成 355 引发更低结余）
    ws.facts[0].qty = 500;
    ws.curves.crv_mkt.points = [
      { id: "p1", date: TODAY, rate: 145 },
      { id: "p2", date: "2026-11-25", rate: 10 }
    ];
    const simDown = Sim.simulateWorkspace(ws, { today: TODAY, viewHorizonDays: 7 });
    const mktDown0 = simDown.nodeDaily.mkt_1.find(x => x.date === TODAY);
    assert(mktDown0.endingAvailable === 500, `市场下调盘点 500 应精确为 500（不应成 355），实际: ${mktDown0.endingAvailable}`);
    assert(simDown.marketSummaries.mkt_1.minAvailable === 440, `minAvailable 应基于盘点后结余 500 推演（7天末 440），实际: ${simDown.marketSummaries.mkt_1.minAvailable}`);
  });

  /* =========================================================================
     C4: AI 写操作 idempotencyKey 跨请求/跨会话碰撞（call::call_0）
     ========================================================================= */
  test("C4. 跨请求复用顺序 call_0 或缺失 tc.id 不得碰撞重放旧操作，跨操作同 key 不得错放", async () => {
    const f = buildAiFixture();
    const store = createMemoryStorage({
      "bom-flow-sim-v5": JSON.stringify(f.bom),
      "sc-sales-world-v2": JSON.stringify(f.ws)
    });

    // 模拟 OpenAI 兼容服务端：第 1 次提问与第 2 次提问均返回顺序 ID "call_0"
    let turn = 0;
    let roundInTurn = 0;
    const mockModel = async () => {
      roundInTurn += 1;
      if (turn === 1 && roundInTurn === 1) {
        return {
          ok: true, content: "",
          toolCalls: [{ id: "call_0", type: "function", function: { name: "adjust_shipment_eta", arguments: JSON.stringify({ etaDelayDays: 3 }) } }],
          usage: { promptTokens: 100, completionTokens: 20, totalTokens: 120 }
        };
      }
      if (turn === 2 && roundInTurn === 1) {
        return {
          ok: true, content: "",
          toolCalls: [{ id: "call_0", type: "function", function: { name: "update_company_compliance", arguments: JSON.stringify({ companyId: "COMP_001", status: "qualified", reason: "复核通过" }) } }],
          usage: { promptTokens: 100, completionTokens: 20, totalTokens: 120 }
        };
      }
      return {
        ok: true,
        content: JSON.stringify({ type: "mutation", answer: "已完成更新。" }),
        toolCalls: [],
        usage: { promptTokens: 100, completionTokens: 20, totalTokens: 120 }
      };
    };

    const assistant = Client.createAssistant({
      storage: store,
      modelConfig: { baseUrl: "https://mock.local/v1", apiKey: "sk-test-c4", transport: mockModel }
    });
    assistant.grantWriteAuthorization({
      workspaceId: f.ws.workspaceId,
      allowedOperations: ["shipment.adjust_eta", "bom.update_compliance"]
    });

    // Turn 1: 修改发运 ETA（call_0）
    turn = 1; roundInTurn = 0;
    const r1 = await assistant.ask({
      userMessage: "请把这批发运单延期 3 天。",
      activeContext: { module: "sales", entity: { kind: "shipment", id: "shp_eu_01", name: "SHP-EU-01" } }
    });
    assert(r1.ok && r1.mutations.length === 1, "Turn 1 发运延期应成功提交");
    assert(JSON.parse(store.getItem("sc-sales-world-v2")).shipments.shp_eu_01.transitDays === 21, "Turn 1 后运输天数应为 21");

    // Turn 2: 修改 BOM 公司合规状态（同样是 call_0）—— 绝不能命中 Turn 1 的发运凭证重放！
    turn = 2; roundInTurn = 0;
    const r2 = await assistant.ask({
      userMessage: "请把这家公司的合规状态改为合格。",
      activeContext: { module: "bom", entity: { kind: "company", id: f.c1, name: "初始精密科技有限公司" } }
    });
    const bomAfter = JSON.parse(store.getItem("bom-flow-sim-v5"));
    assert(r2.ok && r2.mutations.length === 1, `Turn 2 公司合规修改必须实际提交，实际 mutations=${r2.mutations.length}, answer=${r2.answer}`);
    assert(bomAfter.companies[f.c1].compliance.status === "qualified", `公司合规状态必须已更新为 qualified，实际为 ${bomAfter.companies[f.c1].compliance.status}`);

    // 直接调用 writeController 时，相同 idempotencyKey 若用于不同 operation 绝不得错放旧凭证
    const wc = Mutations.createWriteController({ storage: store });
    wc.grantAuthorization({ workspaceId: f.ws.workspaceId, allowedOperations: ["shipment.adjust_eta", "bom.update_compliance"] });
    const firstDirect = wc.executeAuthorizedMutation({
      operation: "shipment.adjust_eta",
      targetId: "shp_eu_01",
      etaDelayDays: 2,
      idempotencyKey: "shared_key_cross_op"
    });
    assert(firstDirect.ok && !firstDirect.idempotentReplay, "首次直调成功");
    const secondCrossOp = wc.executeAuthorizedMutation({
      operation: "bom.update_compliance",
      targetId: f.c1,
      status: "risk",
      reason: "新风险线索",
      idempotencyKey: "shared_key_cross_op"
    });
    assert(secondCrossOp.ok && secondCrossOp.idempotentReplay !== true && secondCrossOp.module === "bom", "不同 operation 即使 key 相同也绝不得重放发运凭证");
    assert(JSON.parse(store.getItem("bom-flow-sim-v5")).companies[f.c1].compliance.status === "risk", "跨操作更新必须真正生效");

    // 验证 SSE 解析器不再硬编码生成全局碰撞的 "call_0"
    const clientSrc = readFile(base + "/shared/ai-client.js");
    assert(!/id:\s*tc\.id\s*\|\|\s*`call_\$\{idx\}`/.test(clientSrc), "readOpenAiSseStream 不得在缺失 tc.id 时伪造碰撞的 call_0");
  });

  /* =========================================================================
     C5: AI 写工具参数校验 + 数值边界校验 + BOM reason 长度校验
     ========================================================================= */
  test("C5. AI 写工具严格校验参数结构、禁止越权字段、拦截 NaN/超大天数/空修改/超长 BOM reason", async () => {
    const f = buildAiFixture();
    const store = createMemoryStorage({
      "bom-flow-sim-v5": JSON.stringify(f.bom),
      "sc-sales-world-v2": JSON.stringify(f.ws)
    });

    // C5a: normalizeToolCall 必须拒绝 JSON "null" / "[]" / "123"
    const normNull = Tools.normalizeToolCall({ id: "t_null", function: { name: "adjust_shipment_eta", arguments: "null" } });
    assert(normNull.ok === false, `arguments: "null" 必须被 normalizeToolCall 拒绝，实际: ${JSON.stringify(normNull)}`);
    const normArr = Tools.normalizeToolCall({ id: "t_arr", function: { name: "adjust_shipment_eta", arguments: "[1,2]" } });
    assert(normArr.ok === false, "arguments: array 必须被拒绝");

    // C5a + C5b: assistant.ask() 遇到 arguments: "null" 或越权字段 { transitDays: 1 } 不得崩溃且必须拒绝写入
    let scenario = "null_args";
    let round = 0;
    const mockModel = async () => {
      round += 1;
      if (round === 1 && scenario === "null_args") {
        return {
          ok: true, content: "",
          toolCalls: [{ id: "tc_null_1", type: "function", function: { name: "adjust_shipment_eta", arguments: "null" } }],
          usage: { promptTokens: 50, completionTokens: 10, totalTokens: 60 }
        };
      }
      if (round === 1 && scenario === "extra_field") {
        return {
          ok: true, content: "",
          toolCalls: [{ id: "tc_extra_1", type: "function", function: { name: "adjust_shipment_eta", arguments: JSON.stringify({ transitDays: 1 }) } }],
          usage: { promptTokens: 50, completionTokens: 10, totalTokens: 60 }
        };
      }
      return {
        ok: true, content: JSON.stringify({ type: "unable", answer: "参数无效，未执行修改。" }),
        toolCalls: [], usage: { promptTokens: 50, completionTokens: 10, totalTokens: 60 }
      };
    };

    const assistant = Client.createAssistant({
      storage: store,
      modelConfig: { baseUrl: "https://mock.local/v1", apiKey: "sk-test-c5", transport: mockModel }
    });
    assistant.grantWriteAuthorization({ workspaceId: f.ws.workspaceId, allowedOperations: ["shipment.adjust_eta"] });

    scenario = "null_args"; round = 0;
    const resNull = await assistant.ask({
      userMessage: "请帮我调整这批货延期 3 天。",
      activeContext: { module: "sales", entity: { kind: "shipment", id: "shp_eu_01", name: "SHP-EU-01" } }
    });
    assert(resNull && resNull.mutations.length === 0, "arguments: 'null' 不得崩溃且不得产生提交");

    scenario = "extra_field"; round = 0;
    const resExtra = await assistant.ask({
      userMessage: "请帮我调整这批货延期 3 天。",
      activeContext: { module: "sales", entity: { kind: "shipment", id: "shp_eu_01", name: "SHP-EU-01" } }
    });
    assert(resExtra.mutations.length === 0, "adjust_shipment_eta 传入非法字段 transitDays（缺 etaDelayDays）必须被拒绝");
    assert(JSON.parse(store.getItem("sc-sales-world-v2")).shipments.shp_eu_01.transitDays === 18, "原发运 transitDays 必须保持 18 不变");

    // C5c: writeController 拒绝非数字 / 超界 transitDays（禁止写入 0 或 NaN-NaN-NaN）
    const wc = Mutations.createWriteController({ storage: store });
    wc.grantAuthorization({ workspaceId: f.ws.workspaceId, allowedOperations: ["shipment.update_schedule", "bom.update_compliance"] });

    const resNan = wc.executeAuthorizedMutation({
      operation: "shipment.update_schedule",
      shipmentId: "shp_eu_01",
      transitDays: "invalid"
    });
    assert(resNan.ok === false && resNan.code === "INVALID_ARGS", `transitDays: "invalid" 必须被拒绝，实际: ${JSON.stringify(resNan)}`);
    assert(JSON.parse(store.getItem("sc-sales-world-v2")).shipments.shp_eu_01.transitDays === 18, "transitDays 不得被清零");

    const resOverflow = wc.executeAuthorizedMutation({
      operation: "shipment.update_schedule",
      shipmentId: "shp_eu_01",
      transitDays: 1e12
    });
    assert(resOverflow.ok === false && resOverflow.code === "INVALID_ARGS", `transitDays: 1e12 必须被拒绝，实际: ${JSON.stringify(resOverflow)}`);
    const shpAfterOverflow = JSON.parse(store.getItem("sc-sales-world-v2")).shipments.shp_eu_01;
    assert(!String(shpAfterOverflow.milestones.borderArrivalPlannedDate).includes("NaN"), "里程碑日期不得写入 NaN-NaN-NaN");

    // C5d: 仅含 reason 无任何排期字段的空修改必须被拒绝
    const revBefore = JSON.parse(store.getItem("sc-sales-world-v2")).revision;
    const resReasonOnly = wc.executeAuthorizedMutation({
      operation: "shipment.update_schedule",
      shipmentId: "shp_eu_01",
      reason: "只写了原因但未改任何日期"
    });
    assert(resReasonOnly.ok === false && resReasonOnly.code === "INVALID_ARGS", `仅含 reason 的空修改必须被拒绝，实际: ${JSON.stringify(resReasonOnly)}`);
    assert(JSON.parse(store.getItem("sc-sales-world-v2")).revision === revBefore, "空修改不得递增 revision");

    // C5e: 超长 BOM compliance reason (>5000) 必须被拒绝，确保 BOM validateState 永不崩溃
    const resLongReason = wc.executeAuthorizedMutation({
      operation: "bom.update_compliance",
      companyId: f.c1,
      status: "risk",
      reason: "超".repeat(5001)
    });
    assert(resLongReason.ok === false && resLongReason.code === "INVALID_ARGS", `超 5000 字 BOM reason 必须被拒绝，实际: ${JSON.stringify(resLongReason)}`);
    // 确认存储中的 BOM 仍可通过 validateState
    validateState(JSON.parse(store.getItem("bom-flow-sim-v5")));
  });

  (async function runAll() {
    for (const item of queue) {
      try {
        await item.fn();
        passed++;
        log("✓ " + item.name);
      } catch (err) {
        failed++;
        log("✗ " + item.name + "\n  " + (err && err.message ? err.message : String(err)) + (err && err.stack ? "\n  " + err.stack : ""));
      }
    }
    log(`\nCritical bugfix regression summary: ${passed} passed, ${failed} failed.`);
    if (failed > 0 && typeof quit === "function") quit(1);
    if (failed > 0 && typeof process !== "undefined") process.exit(1);
  })();
})();
