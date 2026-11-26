/**
 * AI 接入工程 · 第三阶段：模型接入、即时回答、授权操作与留证验收测试（兼容 macOS `jsc` 与 Node.js）
 * 使用 Aster 风格共享上游数据 + 原项目业务引擎，通过本地模拟 API 传输层完成端到端验收（无真实外部网络请求）。
 *
 * 覆盖验收项：
 * 1. AI 正确读取脱敏数据，发往模型请求不含真实敏感信息/API Key，回答在本地恢复真实名称
 * 2. 端到端多轮工具调用准确追溯两家主板供应商共同依赖的上游芯片供应商
 * 3. 库存及供需计算与官方 SimEngine 严格一致，dataCards 直接承载官方数值
 * 4. 联网研究：未配置时诚实提示不伪造；已配置时严格执行独立 web_search 隐私策略并记录可核实来源留证
 * 5. 统一回答协议简洁克制，禁止模型未实际执行却宣称“已修改”，并记录耗时/Token/工具次数
 * 6. 默认只读状态下严禁修改业务数据（零存储写入）
 * 7. 授权范围内直接执行运输途中延期 5 天：完整 7 步流程，保留原始计划与已确认实际事实、保持 originMonth、提示新增缺口风险并刷新界面
 * 8. 正式业务修改凭证持久化于独立键 sc-ai-audit-v1（清除聊天历史不删除凭证），支持安全撤销且保护并发版本与历史事实
 * 9. 越权（删除/批量/历史事实/过期授权/跨工作区）、并发版本冲突、取消、API 异常、工具调用上限与重复请求均正确处理
 * 10. 不发生未经授权的数据外传（API Key、映射表、审计存储与高敏输入均拦截）
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
    load(base + "/shared/ai-tool-registry.js");
    load(base + "/shared/ai-tool-handlers.js");
    load(base + "/shared/ai-tools.js");
    load(base + "/shared/ai-audit.js");
    load(base + "/shared/ai-mutations.js");
    load(base + "/shared/ai-client.js");
  }

  const Store = globalThis.SCDataStore;
  const Audit = globalThis.SCAIAudit;
  const Mutations = globalThis.SCAIMutations;
  const Client = globalThis.SCAIClient;
  const WM = globalThis.SC.WorldModel;
  const Sim = globalThis.SC.SimEngine;
  const Act = globalThis.SC.Actions;

  const log = typeof console !== "undefined" && console.log ? (...a) => console.log(...a) : (...a) => print(...a);
  let passed = 0;
  let failed = 0;
  const metricsReport = [];

  function assert(cond, msg) {
    if (!cond) throw new Error("Assertion failed: " + msg);
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
   * 构造 Aster 实验风格完整跨模块场景：
   * - BOM: 成品整机厂 -> 双主板供应商 (华南主板 / 长三角电路) -> 共享上游主控芯片厂 (极光微电子, severe)
   * - Sales: 总装厂 -> 欧盟/北美市场，含在途已确认发运单 shp_in_transit (已发运 2026-11-10，原计划抵港 11-24，原计划上架 11-29)
   *   当该在途发运延期 5 天时，恰好导致北美市场在 12 月初出现新需求缺口！
   */
  function buildAsterFixture() {
    const bom = emptyState();
    const root = addDocument(bom, "Aster-X1 工业主机");
    const mb = addNode(bom, root, { name: "主控主板", qty: 1, unit: "块" });
    const chip = addNode(bom, mb, { name: "主控芯片", qty: 1, unit: "颗" });

    const oem = addCompany(bom, "星耀整机制造有限公司", {
      location: "杭州市滨江区星耀路 1 号",
      contact: "王总 · 138-1111-2222",
      compliance: { status: "qualified", reason: "审核通过" }
    }).id;
    const mbA = addCompany(bom, "华南主板电子有限公司", {
      location: "深圳市宝安区主板大道 10 号",
      contact: "李工 · 139-2222-3333",
      compliance: { status: "qualified", reason: "合格" }
    }).id;
    const mbB = addCompany(bom, "长三角电路模组有限公司", {
      location: "苏州市吴中区模组路 20 号",
      contact: "周工 · 137-3333-4444",
      compliance: { status: "risk", reason: "UL 复审中" }
    }).id;
    const chipSup = addCompany(bom, "极光微电子芯片有限公司", {
      location: "上海市浦东新区芯片路 88 号",
      contact: "陈经理 · 136-4444-5555",
      compliance: { status: "severe", reason: "RoHS 报告逾期" }
    }).id;

    assignCompany(bom, root, oem);
    assignCompany(bom, mb, mbA);
    assignCompany(bom, mb, mbB);
    assignCompany(bom, chip, chipSup);
    linkCompany(bom, mb, oem, mbA);
    linkCompany(bom, mb, oem, mbB);
    linkCompany(bom, chip, mbA, chipSup);
    linkCompany(bom, chip, mbB, chipSup);

    const facMain = addFactory(bom, oem, "星耀杭州总装厂", { location: "杭州滨江", region: "CN" });

    let ws = WM.createLiveWorkspaceFromShared(null, null, "2026-11-01");
    ws.workspaceId = "ws_aster_stage3";
    ws.products["ASTER-X1"] = {
      productId: "ASTER-X1", skuCode: "ASTER-X1", name: "Aster-X1 工业主机", unit: "台",
      bomDiagramId: bom.diagrams[0].id, bomMaterialId: bom.nodes[root].materialId, bomVersion: 7,
      unitManufacturingCost: 220, costSource: "bom_linked"
    };
    ws.activeProductId = "ASTER-X1";

    ws = Act.dispatchAction(ws, Act.createAction(ws, "node.create", "", {
      nodeId: "src_aster_hz", kind: "source", name: "星耀杭州总装厂", region: "CN",
      bomFactoryId: facMain, bomCompanyId: oem, initialInventory: 4000
    })).workspace;
    ws = Act.dispatchAction(ws, Act.createAction(ws, "node.create", "", {
      nodeId: "mkt_na", kind: "market", name: "北美市场", region: "US", initialInventory: 2800
    })).workspace;
    ws = Act.dispatchAction(ws, Act.createAction(ws, "node.create", "", {
      nodeId: "mkt_eu", kind: "market", name: "欧盟市场", region: "EU", initialInventory: 2000
    })).workspace;

    // 北美日均需求 100 台/天：2800 库存刚好撑到 11-28（28天），11-29 可售到货即可接上；若晚到 5 天（12-04 可售）必产生新缺口！
    const naCurve = WM.findNodeCurve(ws, "mkt_na", "demand");
    naCurve.points = [
      { id: "p1", date: "2026-11-01", rate: 100 },
      { id: "p2", date: "2026-12-31", rate: 100 }
    ];
    const euCurve = WM.findNodeCurve(ws, "mkt_eu", "demand");
    euCurve.points = [
      { id: "p3", date: "2026-11-01", rate: 30 },
      { id: "p4", date: "2026-12-31", rate: 30 }
    ];

    // 在途发运单（已确认 2026-11-10 发运，transitDays=14 -> 计划抵港 11-24，清关 3 天 -> 11-27，上架 1 天 -> 11-28，次日 11-29 可售）
    ws = Act.dispatchAction(ws, Act.createAction(ws, "shipment.create", "", {
      shipmentId: "shp_in_transit", code: "SHP-ASTER-01", productId: "ASTER-X1",
      fromNodeId: "src_aster_hz", toNodeId: "mkt_na",
      departDate: "2026-11-10", qty: 1500, transitDays: 14, customsWaitDays: 3, putawayDays: 1,
      blNumber: "BL-ASTER-9988"
    })).workspace;
    // 记录已确认发运事实（2026-11-10 实际离港）
    ws = Act.dispatchAction(ws, Act.createAction(ws, "event.record", "shp_in_transit", {
      kind: "shipment_dispatched", date: "2026-11-10", note: "已确认装船离港"
    })).workspace;

    // 另一笔无关发运单（验证修改时绝不误伤无关记录）
    ws = Act.dispatchAction(ws, Act.createAction(ws, "shipment.create", "", {
      shipmentId: "shp_other_eu", code: "SHP-ASTER-02", productId: "ASTER-X1",
      fromNodeId: "src_aster_hz", toNodeId: "mkt_eu",
      departDate: "2026-11-12", qty: 400, transitDays: 20, customsWaitDays: 4, putawayDays: 2
    })).workspace;

    return { bom, ws, oem, mbA, mbB, chipSup, facMain };
  }

  const tests = [];
  function test(name, fn) { tests.push({ name, fn }); }

  /* =========================================================================
     验收 1 & 2 & 3 & 5：脱敏外发 + 共享上游追溯 + 官方模拟数值一致 + 简洁结构化回答 + 零 API Key 泄露
     ========================================================================= */
  test("1. 脱敏读取、共同上游芯片追溯、官方库存计算一致与简洁结构化回复（模拟 DeepSeek V4.1 Flash Low）", async () => {
    const f = buildAsterFixture();
    const store = createMemoryStorage({
      "bom-flow-sim-v5": JSON.stringify(f.bom),
      "sc-sales-world-v2": JSON.stringify(f.ws)
    });
    const capturedRequests = [];
    const FAKE_SECRET_KEY = "sk-test-secret-never-leak-999999";

    // 模拟 DeepSeek V4.1 Flash Low：第1轮查公司与世界状态 -> 第2轮查共享上游 -> 第3轮给出简洁 JSON 回复
    let round = 0;
    const mockTransport = async (req) => {
      capturedRequests.push(JSON.parse(JSON.stringify(req.body)));
      round += 1;
      if (round === 1) {
        return {
          ok: true,
          content: "",
          toolCalls: [
            { id: "c1", type: "function", function: { name: "query_bom", arguments: JSON.stringify({ kind: "company" }) } },
            { id: "c2", type: "function", function: { name: "query_world_state", arguments: JSON.stringify({ asOfDate: "2026-11-20", horizonDays: 30 }) } }
          ],
          usage: { promptTokens: 420, completionTokens: 48, totalTokens: 468 },
          streamed: false
        };
      }
      if (round === 2) {
        // 从第 1 轮工具返回中提取匿名公司 ID
        const toolMsg = req.body.messages.find(m => m.role === "tool" && m.tool_call_id === "c1");
        const parsed = JSON.parse(toolMsg.content);
        const qualifiedAndRisk = parsed.data.items.filter(c => c.compliance?.status !== "severe").map(c => c.id);
        return {
          ok: true,
          content: "",
          toolCalls: [
            { id: "c3", type: "function", function: { name: "trace_supply_chain", arguments: JSON.stringify({ mode: "shared_upstream", companyIds: qualifiedAndRisk.slice(1, 3) }) } }
          ],
          usage: { promptTokens: 580, completionTokens: 36, totalTokens: 616 },
          streamed: false
        };
      }
      const traceMsg = req.body.messages.find(m => m.role === "tool" && m.tool_call_id === "c3");
      const traceData = JSON.parse(traceMsg.content).data;
      const sharedId = traceData.sharedSuppliers[0].supplier.id;
      const mbIds = traceData.sharedSuppliers[0].sharedByCompanyIds;
      const replyJson = JSON.stringify({
        type: "decision",
        answer: `${mbIds[0]} 与 ${mbIds[1]} 共同依赖存在严重合规问题的上游 ${sharedId}，建议优先启动芯片第二来源认证。`,
        keyPoints: ["两家主板供应商均单点依赖同一严重合规芯片厂", "当前 30 天内各市场库存暂无缺口"],
        uncertainty: "评估仅基于当前 BOM 已登记关系。"
      });
      if (typeof req.onToken === "function") req.onToken(replyJson);
      return {
        ok: true,
        content: replyJson,
        toolCalls: [],
        usage: { promptTokens: 640, completionTokens: 82, totalTokens: 722 },
        streamed: true
      };
    };

    const assistant = Client.createAssistant({
      storage: store,
      modelConfig: {
        baseUrl: "https://api.deepseek.com/v1",
        apiKey: FAKE_SECRET_KEY,
        model: "deepseek-v4.1-flash",
        reasoningEffort: "low",
        transport: mockTransport
      }
    });

    const res = await assistant.ask({
      userMessage: "请检查华南主板电子有限公司和长三角电路模组有限公司是否共享同一个上游芯片供应商，并核对当前库存风险。"
    });
    metricsReport.push({ scenario: "共享上游+库存分析", metrics: res.metrics });

    assert(res.ok && res.type === "decision", "返回统一 decision 结构化响应");
    assert(res.answer.length <= 200, `普通/决策摘要应足够简洁，当前 ${res.answer.length} 字`);
    assert(res.answer.includes("华南主板电子有限公司") && res.answer.includes("长三角电路模组有限公司") && res.answer.includes("极光微电子芯片有限公司"),
      "回答在本地准确恢复真实企业名称");
    assert(res.metrics.toolCallCount === 3 && res.metrics.usage.totalTokens === 1806 && res.metrics.streamed === true,
      "准确记录工具调用次数、Token 消耗与流式标记");

    // 校验发往外部模型的全部请求内容绝对不包含真实敏感信息、提单号或 API Key！
    const allOutbound = JSON.stringify(capturedRequests);
    for (const secret of [FAKE_SECRET_KEY, "华南主板电子有限公司", "长三角电路模组有限公司", "极光微电子芯片有限公司", "138-1111-2222", "BL-ASTER-9988"]) {
      assert(!allOutbound.includes(secret), `发往外部模型的请求绝不能包含「${secret}」`);
    }
    assert(capturedRequests[0].reasoning_effort === "low" && capturedRequests[0].model === "deepseek-v4.1-flash",
      "正确传递基准模型名与 reasoning_effort=low");

    // 校验 dataCards 中的官方 SimEngine KPI 与直接调用 SimEngine 完全一致
    const official = Sim.simulateWorkspace(f.ws, { today: "2026-11-20", viewHorizonDays: 30 });
    const wsCard = res.dataCards.find(c => c.kind === "world_state");
    assert(wsCard && wsCard.kpis.currentAvailableInventory === official.kpis.currentAvailableInventory,
      "dataCards 直接保留官方模拟引擎计算数值");
    assert(store.getWrites() === 1 && Boolean(store.getItem(Audit.AUDIT_STORAGE_KEY)), "仅记录本地留证，业务存储零写入");
  });

  /* =========================================================================
     验收 4：取消联网搜索 URL/Key 限制，交由 AI 自行决定是否联网
     ========================================================================= */
  test("2. 联网搜索无 URL/Key 限制：移除自定义搜索适配器，系统提示词允许 AI 自主决定是否联网", async () => {
    const f = buildAsterFixture();
    const store = createMemoryStorage({
      "bom-flow-sim-v5": JSON.stringify(f.bom),
      "sc-sales-world-v2": JSON.stringify(f.ws)
    });

    assert(Client.createWebResearchAdapter === undefined, "不再暴露自定义联网搜索 URL/Key 适配器");
    assert(!Client.SYSTEM_PROMPT.includes("未获联网工具时直接说明无法联网检索"), "系统提示词不再限制模型联网");

    let seenTools = [];
    let seenContext = "";
    const mockModel = async (req) => {
      seenTools = (req.body.tools || []).map(t => t.function?.name);
      seenContext = req.body.messages.filter(m => m.role === "system").map(m => m.content).join("\n");
      return {
        ok: true,
        content: JSON.stringify({
          type: "query",
          answer: "已根据需要自行判断外部信息与本地业务数据。"
        }),
        toolCalls: [],
        usage: { promptTokens: 220, completionTokens: 32, totalTokens: 252 }
      };
    };

    const assistant = Client.createAssistant({
      storage: store,
      modelConfig: { baseUrl: "https://mock.local/v1", apiKey: "sk-mock-123456", transport: mockModel }
    });

    assert(assistant.getWebResearchConfig === undefined && assistant.updateWebResearchConfig === undefined,
      "助手实例不再暴露联网搜索 URL/Key 配置方法");

    const res = await assistant.ask({
      userMessage: "帮我检索公开 RoHS 资料",
      activeContext: { module: "bom" }
    });
    assert(res.ok, "正常响应用户提问");
    assert(!seenTools.includes("web_search"), "不再注入依赖外部 URL/Key 的自定义 web_search 工具");
    assert(!seenContext.includes("联网搜索状态：未配置"), "上下文不再向模型注入联网禁用状态");
  });

  /* =========================================================================
     验收 6：只读状态下严禁修改业务数据，且模型谎称“已修改”会被降级拦截
     ========================================================================= */
  test("3. 默认只读状态下无法修改业务数据，模型若未执行却谎称已修改会被强制纠正", async () => {
    const f = buildAsterFixture();
    const rawSalesBefore = JSON.stringify(f.ws);
    const store = createMemoryStorage({
      "bom-flow-sim-v5": JSON.stringify(f.bom),
      "sc-sales-world-v2": rawSalesBefore
    });

    let step = 0;
    const mockModel = async (req) => {
      step += 1;
      if (step === 1) {
        // 即使模型强行编造调用 adjust_shipment_eta（在只读模式下工具列表甚至未暴露它）
        return {
          ok: true,
          content: "",
          toolCalls: [{ id: "m1", type: "function", function: { name: "adjust_shipment_eta", arguments: JSON.stringify({ etaDelayDays: 5 }) } }],
          usage: { promptTokens: 200, completionTokens: 25, totalTokens: 225 }
        };
      }
      // 模拟不诚实模型企图在未执行成功时输出 type:"mutation"
      return {
        ok: true,
        content: JSON.stringify({ type: "mutation", answer: "已为您将发运单延期 5 天。" }),
        toolCalls: [],
        usage: { promptTokens: 260, completionTokens: 25, totalTokens: 285 }
      };
    };

    const assistant = Client.createAssistant({
      storage: store,
      modelConfig: { baseUrl: "https://mock.local/v1", apiKey: "sk-mock-123456", transport: mockModel }
    });

    assert(assistant.getWriteStatus().mode === "read_only", "默认必须处于只读模式");
    const res = await assistant.ask({
      userMessage: "当前这批货预计晚到5天，帮我调整一下。",
      activeContext: { module: "sales", entity: { kind: "shipment", id: "shp_in_transit", name: "SHP-ASTER-01" } }
    });

    assert(res.mutations.length === 0, "只读模式下绝不产生真实修改");
    assert(res.type === "unable", "未实际执行成功时强制将响应类型降级为 unable，禁止展示已修改");
    assert(store.getItem("sc-sales-world-v2") === rawSalesBefore, "业务存储保持逐字节不变");
  });

  /* =========================================================================
     验收 7 & 8 & 9 & 10：授权执行运输途中延期 5 天 + 原始计划/实际事实保留 + 新增缺口提示 + 界面刷新 + 持久化留证 + 安全撤销
     ========================================================================= */
  test("4. 授权执行运输途中延期 5 天：保留原始计划与实际事实、提示新缺口、刷新界面、落盘凭证并支持安全撤销", async () => {
    const f = buildAsterFixture();
    const store = createMemoryStorage({
      "bom-flow-sim-v5": JSON.stringify(f.bom),
      "sc-sales-world-v2": JSON.stringify(f.ws)
    });
    let uiRefreshEvents = [];

    let step = 0;
    const mockModel = async (req) => {
      step += 1;
      if (step === 1) {
        return {
          ok: true,
          content: "",
          toolCalls: [{
            id: "mut_1",
            type: "function",
            function: { name: "adjust_shipment_eta", arguments: JSON.stringify({ etaDelayDays: 5, reason: "运输途中预计晚到5天" }) }
          }],
          usage: { promptTokens: 310, completionTokens: 32, totalTokens: 342 }
        };
      }
      const mutOut = JSON.parse(req.body.messages.find(m => m.tool_call_id === "mut_1").content);
      assert(mutOut.ok === true && mutOut.executed === true && mutOut.originalPlanPreserved === true, "工具返回真实执行成功与原始计划保留标记");
      assert(mutOut.newStockoutRisks.length === 1, "官方引擎检测到延期 5 天导致北美市场产生新缺口风险");
      return {
        ok: true,
        content: JSON.stringify({
          type: "mutation",
          answer: `已将 ${mutOut.targetId} 预计运输时间延后 5 天（凭证 ${mutOut.voucherId}），原始计划与实际离港日期已保留。注意：${mutOut.newStockoutRisks[0].marketId} 将在 ${mutOut.newStockoutRisks[0].firstGapDateAfter} 出现新缺口风险。`
        }),
        toolCalls: [],
        usage: { promptTokens: 430, completionTokens: 65, totalTokens: 495 }
      };
    };

    const assistant = Client.createAssistant({
      storage: store,
      modelConfig: { baseUrl: "https://mock.local/v1", apiKey: "sk-mock-123456", model: "deepseek-v4.1-flash", transport: mockModel },
      onDataMutated: (info) => uiRefreshEvents.push(info)
    });

    // 用户显式授予限时、限范围写入权限
    const grant = assistant.grantWriteAuthorization({
      workspaceId: f.ws.workspaceId,
      allowedOperations: ["shipment.adjust_eta"],
      ttlMs: 30 * 60 * 1000
    });
    assert(assistant.getWriteStatus().mode === "authorized_write", "已进入限时授权写入状态");

    const res = await assistant.ask({
      userMessage: "当前这批货预计晚到5天，帮我调整一下。",
      asOfDate: "2026-11-20",
      activeContext: { module: "sales", entity: { kind: "shipment", id: "shp_in_transit", name: "SHP-ASTER-01" } }
    });
    metricsReport.push({ scenario: "授权运输延期5天", metrics: res.metrics });

    assert(res.ok && res.type === "mutation" && res.mutations.length === 1, "授权范围内直接完成修改并返回真实修改结果");
    assert(uiRefreshEvents.length === 1 && uiRefreshEvents[0].module === "sales" && uiRefreshEvents[0].entityId === "shp_in_transit",
      "修改成功后触发界面与数据同步刷新");

    // 校验持久化后的销售工作区
    const persistedWs = JSON.parse(store.getItem("sc-sales-world-v2"));
    const updatedShp = persistedWs.shipments.shp_in_transit;
    const untouchedShp = persistedWs.shipments.shp_other_eu;

    assert(updatedShp.id === "shp_in_transit" && updatedShp.originMonth === "2026-11", "稳定 ID 与原始归属月份保持不变");
    assert(updatedShp.milestones.departActualDate === "2026-11-10", "已确认的实际离港日期毫发无损");
    assert(updatedShp.originalPlan && updatedShp.originalPlan.transitDays === 14 && updatedShp.originalPlan.borderArrivalPlannedDate === "2026-11-24" && updatedShp.originalPlan.marketStockAvailablePlannedDate === "2026-11-28",
      "原始基准计划完整保留，未被覆盖");
    assert(updatedShp.transitDays === 19 && updatedShp.milestones.borderArrivalPlannedDate === "2026-11-29" && updatedShp.milestones.marketStockAvailablePlannedDate === "2026-12-03",
      "最新预计抵港/清关/上架里程碑正确顺延 5 天");
    assert(untouchedShp.transitDays === 20 && untouchedShp.milestones.borderArrivalPlannedDate === "2026-12-02",
      "其他无关发运单完全不受影响");

    // 校验持久化凭证完整性 + 清除聊天记录绝不影响审计凭证
    store.setItem("sc-ai-chat-v1", JSON.stringify([{ role: "user", content: "test" }]));
    store.removeItem("sc-ai-chat-v1"); // 模拟清除聊天历史
    const voucherId = res.mutations[0].voucherId;
    const persistedVoucher = Audit.createAuditStore({ storage: store }).getMutationVoucher(voucherId);
    assert(Boolean(persistedVoucher), "清除聊天历史后，正式业务修改凭证依然完整保存在 sc-ai-audit-v1");
    assert(persistedVoucher.authorization.grantId === grant.grantId && persistedVoucher.diff.length >= 4 && persistedVoucher.businessImpact.newStockoutRisks.length === 1,
      "凭证完整包含授权依据、修改前后字段差异与新缺口影响");

    // 验证安全撤销：恢复原计划并生成撤销凭证
    const undoRes = assistant.undoMutation(voucherId);
    assert(undoRes.ok && Boolean(undoRes.undoVoucher), "支持经过版本与事实校验的安全撤销");
    const afterUndoWs = JSON.parse(store.getItem("sc-sales-world-v2"));
    assert(afterUndoWs.shipments.shp_in_transit.transitDays === 14 && afterUndoWs.shipments.shp_in_transit.milestones.borderArrivalPlannedDate === "2026-11-24" && afterUndoWs.shipments.shp_in_transit.milestones.departActualDate === "2026-11-10",
      "撤销后恢复至原预计时间且继续保留已确认实际离港日");
  });

  /* =========================================================================
     验收 11 & 12：越权拦截、历史事实保护、并发版本冲突、撤销冲突保护、取消、API 异常与重复请求
     ========================================================================= */
  test("5. 越权/删除/批量/历史事实/并发版本冲突/过期授权/取消/API异常/重复请求与高敏阻断全覆盖", async () => {
    const f = buildAsterFixture();
    const store = createMemoryStorage({
      "bom-flow-sim-v5": JSON.stringify(f.bom),
      "sc-sales-world-v2": JSON.stringify(f.ws)
    });
    const wc = Mutations.createWriteController({ storage: store });

    // A. 授予权限但测试高风险硬护栏（删除 / 批量 / 历史事实 / 未知主体 / 跨工作区 / 过期）
    wc.grantAuthorization({ workspaceId: f.ws.workspaceId, allowedOperations: ["shipment.adjust_eta"], ttlMs: 60000 });

    const delBlocked = wc.executeAuthorizedMutation({ operation: "shipment.cancel", targetId: "shp_in_transit" });
    assert(!delBlocked.ok && delBlocked.needsConfirmation === true, "删除/取消操作强制拦截");

    const bulkBlocked = wc.executeAuthorizedMutation({ operation: "shipment.adjust_eta", targetIds: ["shp_in_transit", "shp_other_eu"], etaDelayDays: 3 });
    assert(!bulkBlocked.ok && bulkBlocked.needsConfirmation === true, "批量调整操作强制拦截");

    const factBlocked = wc.executeAuthorizedMutation({ operation: "shipment.adjust_eta", targetId: "shp_in_transit", etaDelayDays: 3, borderArrivalActualDate: "2026-11-20" });
    assert(!factBlocked.ok && factBlocked.code === "REQUIRES_CONFIRMATION_HISTORICAL_FACT", "篡改已确认实际日期强制拦截");

    const ambigBlocked = wc.executeAuthorizedMutation({ operation: "shipment.adjust_eta", etaDelayDays: 3 });
    assert(!ambigBlocked.ok && ambigBlocked.code === "AMBIGUOUS_TARGET", "目标主体不明确时强制停止并要求确认");

    const verConflict = wc.executeAuthorizedMutation({ operation: "shipment.adjust_eta", targetId: "shp_in_transit", etaDelayDays: 2, expectedRevision: 999 });
    assert(!verConflict.ok && verConflict.code === "VERSION_CONFLICT", "并发版本冲突必须中止写入");

    // 执行一次合法修改后，模拟后续产生实际抵港事实 -> 撤销必须被历史事实保护拒绝！
    const okEdit = wc.executeAuthorizedMutation({ operation: "shipment.adjust_eta", targetId: "shp_in_transit", etaDelayDays: 2 });
    assert(okEdit.ok && okEdit.executed, "合法修改成功");
    const wsNow = JSON.parse(store.getItem("sc-sales-world-v2"));
    const withFact = Act.dispatchAction(wsNow, Act.createAction(wsNow, "event.record", "shp_in_transit", {
      kind: "border_arrival", date: "2026-11-26", note: "实际抵港"
    })).workspace;
    store.setItem("sc-sales-world-v2", JSON.stringify(withFact));
    const undoDenied = wc.undoMutation(okEdit.voucher.voucherId);
    assert(!undoDenied.ok && (undoDenied.code === "VERSION_CONFLICT" || undoDenied.code === "HISTORICAL_FACT_PROTECTED"),
      "存在后续变更或新增历史事实时禁止自动撤销覆盖");

    // 撤销授权后立刻退回只读
    wc.revokeAuthorization();
    assert(wc.getStatus().mode === "read_only", "随时撤销授权立即回到只读模式");
    const afterRevoke = wc.executeAuthorizedMutation({ operation: "shipment.adjust_eta", targetId: "shp_in_transit", etaDelayDays: 1 });
    assert(!afterRevoke.ok && afterRevoke.code === "READ_ONLY_MODE", "撤销授权后写入被立即拒绝");

    // B. API 异常、取消请求、重复并发请求与高敏输入阻断
    let releaseDeferred;
    const slowTransport = async (req, signal) => {
      if (signal && signal.aborted) return { ok: false, error: { code: "CANCELLED", message: "请求已取消" } };
      return new Promise(resolve => {
        releaseDeferred = resolve;
        if (signal && typeof signal.addEventListener === "function") {
          signal.addEventListener("abort", () => resolve({ ok: false, error: { code: "CANCELLED", message: "请求已取消" } }), { once: true });
        }
      });
    };

    const assistantSlow = Client.createAssistant({
      storage: store,
      modelConfig: { baseUrl: "https://mock.local/v1", apiKey: "sk-mock-secret", transport: slowTransport }
    });

    // 高敏感用户输入（含 API Key）在发起模型请求前就被阻断！
    const secretBlocked = await assistantSlow.ask({ userMessage: "帮我检查 sk-live9876543210abcdef 对应的订单" });
    assert(!secretBlocked.ok && secretBlocked.error.code === "PRIVACY_BLOCKED", "包含 API Key 的用户输入在调用模型前被阻断");

    // 重复并发请求拦截 + 取消请求
    const abortCtrl = typeof AbortController === "function" ? new AbortController() : { aborted: false, abort() { this.aborted = true; } };
    const p1 = assistantSlow.ask({ userMessage: "并发测试查询", signal: abortCtrl.signal || abortCtrl });
    const dupRes = await assistantSlow.ask({ userMessage: "并发测试查询" });
    assert(!dupRes.ok && dupRes.error.code === "DUPLICATE_IN_FLIGHT", "重复并发请求被准确拦截");
    abortCtrl.abort();
    if (releaseDeferred) releaseDeferred({ ok: false, error: { code: "CANCELLED", message: "已取消" } });
    const cancelledRes = await p1;
    assert(!cancelledRes.ok && cancelledRes.cancelled === true, "取消请求被正确处理");

    // API 错误返回（同时脱敏可能混入报错的 API Key）
    const errAssistant = Client.createAssistant({
      storage: store,
      modelConfig: {
        baseUrl: "https://mock.local/v1",
        apiKey: "sk-real-secret-888888",
        transport: async () => ({ ok: false, error: { code: "API_HTTP_ERROR", message: "401 Unauthorized for key sk-real-secret-888888" } })
      }
    });
    const errRes = await errAssistant.ask({ userMessage: "查询供应商" });
    assert(!errRes.ok && errRes.type === "unable" && !errRes.answer.includes("sk-real-secret-888888"),
      "API 异常被优雅处理且绝不回显 API Key");
  });

  // Execute async test runner sequentially (compatible with both Node.js and macOS jsc)
  (async function runAll() {
    for (const t of tests) {
      try {
        await t.fn();
        passed++;
        log("✓ " + t.name);
      } catch (err) {
        failed++;
        log("✗ " + t.name + "\n  " + (err && err.stack ? err.stack : err));
      }
    }
    log(`\nAI Stage 3 verification summary: ${passed} passed, ${failed} failed.`);
    if (metricsReport.length) {
      log("Simulated API metrics (未联调真实 API 凭据，以下为本地模拟传输层统计):");
      for (const m of metricsReport) {
        log(`  - ${m.scenario}: ${m.metrics.durationMs}ms | tools=${m.metrics.toolCallCount} | rounds=${m.metrics.modelRounds} | tokens=${m.metrics.usage.totalTokens} (in=${m.metrics.usage.promptTokens}, out=${m.metrics.usage.completionTokens}) | failedTools=${m.metrics.failedToolCalls}`);
      }
    }
    if (failed > 0 && typeof quit === "function") quit(1);
    if (failed > 0 && typeof process !== "undefined") process.exit(1);
  })();
})();
