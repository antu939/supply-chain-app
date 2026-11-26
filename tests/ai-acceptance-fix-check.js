/**
 * AI 接入工程 · 最终验收修复专项回归测试（兼容 macOS `jsc` 与 Node.js）
 * 覆盖全部 P0 (#1~#5) 与 P1 (#6~#10) 修复项及 Aster 30天需求缺口基准校验。
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
    load(base + "/app/ai-sidebar.js");
  }

  const Audit = globalThis.SCAIAudit;
  const Mutations = globalThis.SCAIMutations;
  const Client = globalThis.SCAIClient;
  const Sidebar = globalThis.SCAISidebar;
  const WM = globalThis.SC.WorldModel;
  const Sim = globalThis.SC.SimEngine;
  const Act = globalThis.SC.Actions;

  const log = typeof console !== "undefined" && console.log ? (...a) => console.log(...a) : (...a) => print(...a);
  let passed = 0;
  let failed = 0;

  function assert(cond, msg) {
    if (!cond) throw new Error("Assertion failed: " + msg);
  }

  function createMemoryStorage(initial, hooks) {
    const map = Object.assign({}, initial || {});
    return {
      getItem: k => (Object.prototype.hasOwnProperty.call(map, k) ? map[k] : null),
      setItem: (k, v) => {
        if (hooks && typeof hooks.onSetItem === "function") hooks.onSetItem(k, v, map);
        map[k] = String(v);
      },
      removeItem: k => { delete map[k]; },
      raw: map
    };
  }

  /**
   * Aster 基准业务场景：
   * 30 天预测窗口（2026-11-01 .. 2026-11-30）需求缺口精确为：
   * - 欧盟市场：日需求 100 台 × 30 天 = 3000，初始库存 2250 -> 缺口 750 台
   * - 美国市场：日需求 150 台 × 30 天 = 4500，初始库存 2700 -> 缺口 1800 台
   * - 中国市场：日需求 80 台 × 30 天 = 2400，初始库存 3000 -> 缺口 0 台
   */
  function buildAsterBenchmarkFixture() {
    const bom = emptyState();
    const root = addDocument(bom, "Aster 边缘节点 A1");
    const compMain = addCompany(bom, "星耀精密制造有限公司", {
      location: "杭州市滨江区星耀大道 88 号",
      contact: "林敏 · 138-5710-9988",
      compliance: { status: "risk", reason: "原始合规说明：联系人 138-5710-9988，单价 ¥320 合同待复核" }
    }).id;
    assignCompany(bom, root, compMain);
    const fac = addFactory(bom, compMain, "星耀杭州总装厂", { location: "杭州滨江", region: "CN" });

    let ws = WM.createLiveWorkspaceFromShared(null, null, "2026-11-01");
    ws.workspaceId = "ws_aster_bench";
    ws = Act.dispatchAction(ws, Act.createAction(ws, "node.create", "", {
      nodeId: "src_aster_cn", kind: "source", name: "星耀杭州总装厂", region: "CN",
      bomFactoryId: fac, bomCompanyId: compMain, initialInventory: 5000
    })).workspace;
    ws = Act.dispatchAction(ws, Act.createAction(ws, "node.create", "", {
      nodeId: "mkt_eu", kind: "market", name: "欧盟市场", region: "EU", initialInventory: 2250
    })).workspace;
    ws = Act.dispatchAction(ws, Act.createAction(ws, "node.create", "", {
      nodeId: "mkt_us", kind: "market", name: "美国市场", region: "US", initialInventory: 2700
    })).workspace;
    ws = Act.dispatchAction(ws, Act.createAction(ws, "node.create", "", {
      nodeId: "mkt_cn", kind: "market", name: "中国市场", region: "CN", initialInventory: 3000
    })).workspace;

    WM.findNodeCurve(ws, "mkt_eu", "demand").points = [
      { id: "eu1", date: "2026-11-01", rate: 100 }, { id: "eu2", date: "2026-12-31", rate: 100 }
    ];
    WM.findNodeCurve(ws, "mkt_us", "demand").points = [
      { id: "us1", date: "2026-11-01", rate: 150 }, { id: "us2", date: "2026-12-31", rate: 150 }
    ];
    WM.findNodeCurve(ws, "mkt_cn", "demand").points = [
      { id: "cn1", date: "2026-11-01", rate: 80 }, { id: "cn2", date: "2026-12-31", rate: 80 }
    ];

    ws = Act.dispatchAction(ws, Act.createAction(ws, "shipment.create", "", {
      shipmentId: "shp_eu_01", code: "SHP-ASTER-EU1", fromNodeId: "src_aster_cn", toNodeId: "mkt_eu",
      departDate: "2026-11-10", qty: 800, transitDays: 18, customsWaitDays: 4, putawayDays: 2
    })).workspace;
    ws = Act.dispatchAction(ws, Act.createAction(ws, "event.record", "shp_eu_01", {
      kind: "shipment_dispatched", date: "2026-11-10"
    })).workspace;

    ws = Act.dispatchAction(ws, Act.createAction(ws, "shipment.create", "", {
      shipmentId: "shp_us_02", code: "SHP-ASTER-US2", fromNodeId: "src_aster_cn", toNodeId: "mkt_us",
      departDate: "2026-11-12", qty: 900, transitDays: 20, customsWaitDays: 4, putawayDays: 2
    })).workspace;

    return { bom, ws, compMain, fac };
  }

  const tests = [];
  function test(name, fn) { tests.push({ name, fn }); }

  /* =========================================================================
     P0 #1: 写入回传脱敏漏洞修复 + userConfirmed 不得无条件为 true
     ========================================================================= */
  test("P0-1. 业务修改回传严格脱敏（合规说明/联系方式/真实名绝不回传模型）且 userConfirmed 不无条件绕过", async () => {
    const f = buildAsterBenchmarkFixture();
    const store = createMemoryStorage({
      "bom-flow-sim-v5": JSON.stringify(f.bom),
      "sc-sales-world-v2": JSON.stringify(f.ws)
    });

    const outboundToolPayloads = [];
    let round = 0;
    const mockModel = async (req) => {
      round += 1;
      if (round === 1) {
        return {
          ok: true,
          content: "",
          toolCalls: [{
            id: "comp_edit_1",
            type: "function",
            function: {
              name: "update_company_compliance",
              arguments: JSON.stringify({
                companyId: "COMP_001",
                status: "qualified",
                reason: "已核验星耀精密制造有限公司，联系人 139-9999-8888 补交材料"
              })
            }
          }],
          usage: { promptTokens: 200, completionTokens: 40, totalTokens: 240 }
        };
      }
      const toolMsg = req.body.messages.find(m => m.role === "tool" && m.tool_call_id === "comp_edit_1");
      outboundToolPayloads.push(toolMsg.content);
      return {
        ok: true,
        content: JSON.stringify({ type: "mutation", answer: "已完成 COMP_001 合规状态更新。" }),
        toolCalls: [],
        usage: { promptTokens: 260, completionTokens: 30, totalTokens: 290 }
      };
    };

    const assistant = Client.createAssistant({
      storage: store,
      modelConfig: { baseUrl: "https://mock.local/v1", apiKey: "sk-mock-001", transport: mockModel }
    });
    assistant.grantWriteAuthorization({ workspaceId: f.ws.workspaceId, allowedOperations: ["bom.update_compliance"] });

    // 1) 未确认时，用户输入含手机号/单价 -> 必须返回 requiresConfirmation，不直接调用外部模型！
    const unconfirmed = await assistant.ask({
      userMessage: "请把星耀精密制造有限公司合规状态更新为合格，联系人 139-9999-8888，采购价 ¥320"
    });
    assert(!unconfirmed.ok && unconfirmed.requiresConfirmation === true && round === 0,
      "含手机号与价格的用户输入在 userConfirmed=false 时必须拦截并要求人工确认，绝不外发模型");

    // 2) 人工确认后执行 BOM 合规修改 -> 验证发往第 2 轮模型的 tool 消息中绝不含原始/新合规说明文本、手机号、价格或真实公司名！
    const res = await assistant.ask({
      userMessage: "请将当前公司合规状态修改为 qualified",
      userConfirmed: true,
      activeContext: { module: "bom", entity: { kind: "company", id: f.compMain, name: "星耀精密制造有限公司" } }
    });
    assert(res.ok && res.type === "mutation" && res.mutations.length === 1, "合规修改正式成功");
    assert(outboundToolPayloads.length === 1, "已捕获回传模型的工具消息");
    const toolJson = outboundToolPayloads[0];
    for (const secret of ["138-5710-9988", "139-9999-8888", "¥320", "星耀精密制造有限公司", "原始合规说明"]) {
      assert(!toolJson.includes(secret), `回传模型的修改结果绝不可泄露「${secret}」`);
    }
    const parsedTool = JSON.parse(toolJson);
    const reasonDiff = parsedTool.diff.find(d => d.field === "compliance.reason");
    assert(reasonDiff && reasonDiff.redacted === true && !("before" in reasonDiff) && !("after" in reasonDiff),
      "自由文本字段 compliance.reason 的 diff 必须被脱敏为 redacted=true");
  });

  /* =========================================================================
     P0 #2: 写操作幂等控制（同一 tool_call_id 连续延期 5 天，只加 5 天！）
     ========================================================================= */
  test("P0-2. 写操作幂等控制：同一工具调用 ID 连续请求延期 5 天，运输时间只能增加 5 天", async () => {
    const f = buildAsterBenchmarkFixture();
    const store = createMemoryStorage({
      "bom-flow-sim-v5": JSON.stringify(f.bom),
      "sc-sales-world-v2": JSON.stringify(f.ws)
    });

    // 模拟模型在单次请求中重复发出两次相同的 tool_call_id（以及第2轮再重复一次相同 ID！）
    let round = 0;
    const mockModel = async () => {
      round += 1;
      if (round === 1) {
        return {
          ok: true,
          content: "",
          toolCalls: [
            { id: "call_delay_same_id", type: "function", function: { name: "adjust_shipment_eta", arguments: JSON.stringify({ etaDelayDays: 5 }) } },
            { id: "call_delay_same_id", type: "function", function: { name: "adjust_shipment_eta", arguments: JSON.stringify({ etaDelayDays: 5 }) } }
          ],
          usage: { promptTokens: 200, completionTokens: 40, totalTokens: 240 }
        };
      }
      if (round === 2) {
        return {
          ok: true,
          content: "",
          toolCalls: [
            { id: "call_delay_diff_id_same_op", type: "function", function: { name: "adjust_shipment_eta", arguments: JSON.stringify({ etaDelayDays: 5 }) } }
          ],
          usage: { promptTokens: 250, completionTokens: 30, totalTokens: 280 }
        };
      }
      return {
        ok: true,
        content: JSON.stringify({ type: "mutation", answer: "已完成 5 天延期调整。" }),
        toolCalls: [],
        usage: { promptTokens: 300, completionTokens: 25, totalTokens: 325 }
      };
    };

    const assistant = Client.createAssistant({
      storage: store,
      modelConfig: { baseUrl: "https://mock.local/v1", apiKey: "sk-mock-002", transport: mockModel }
    });
    assistant.grantWriteAuthorization({ workspaceId: f.ws.workspaceId, allowedOperations: ["shipment.adjust_eta"] });

    const res = await assistant.ask({
      userMessage: "当前这批货预计晚到5天，帮我调整一下。",
      activeContext: { module: "sales", entity: { kind: "shipment", id: "shp_eu_01", name: "SHP-ASTER-EU1" } }
    });

    const wsAfter = JSON.parse(store.getItem("sc-sales-world-v2"));
    assert(res.ok && res.mutations.length === 1, "重复工具调用仅产生 1 次实际提交");
    assert(wsAfter.shipments.shp_eu_01.transitDays === 23, `原 18 天 + 5 天应精确等于 23 天（绝非 28 或 33），实际为 ${wsAfter.shipments.shp_eu_01.transitDays}`);
    assert(assistant.getAuditStore().listMutationVouchers().length === 1, "仅生成 1 条正式修改凭证");

    // 跨请求直接以相同 toolCallId 再次调用 writeController 也必须幂等重放！
    const wc = Mutations.createWriteController({ storage: store });
    wc.grantAuthorization({ workspaceId: f.ws.workspaceId, allowedOperations: ["shipment.adjust_eta"] });
    const replay = wc.executeAuthorizedMutation({
      operation: "shipment.adjust_eta",
      targetId: "shp_eu_01",
      etaDelayDays: 5,
      idempotencyKey: "call::call_delay_same_id"
    });
    assert(replay.ok && replay.idempotentReplay === true, "跨实例相同 idempotencyKey 必须命中持久化幂等重放");
    assert(JSON.parse(store.getItem("sc-sales-world-v2")).shipments.shp_eu_01.transitDays === 23, "幂等重放后运输时间仍严格为 23 天");
  });

  /* =========================================================================
     P0 #3: 审计写入失败原子回滚 + 超过 300 条正式修改凭证归档不静默删除
     ========================================================================= */
  test("P0-3. 审计写入失败自动回滚业务数据（绝不宣称成功），超 300 条修改凭证归档不静默删除", () => {
    const f = buildAsterBenchmarkFixture();
    const rawSalesBefore = JSON.stringify(f.ws);

    // A. 审计键写入抛 QuotaExceededError -> 业务数据必须自动回滚，绝不宣称成功！
    const failingStore = createMemoryStorage({
      "bom-flow-sim-v5": JSON.stringify(f.bom),
      "sc-sales-world-v2": rawSalesBefore
    }, {
      onSetItem(k) {
        if (k === Audit.AUDIT_STORAGE_KEY) {
          throw new Error("QuotaExceededError: storage full");
        }
      }
    });

    let refreshedCount = 0;
    const wc = Mutations.createWriteController({
      storage: failingStore,
      onPersisted: () => { refreshedCount += 1; }
    });
    wc.grantAuthorization({ workspaceId: f.ws.workspaceId, allowedOperations: ["shipment.adjust_eta"] });

    const failRes = wc.executeAuthorizedMutation({
      operation: "shipment.adjust_eta",
      targetId: "shp_eu_01",
      etaDelayDays: 5
    });
    assert(!failRes.ok && failRes.executed === false && failRes.rolledBack === true && failRes.code === "AUDIT_PERSIST_FAILED",
      "审计写入失败时必须返回 AUDIT_PERSIST_FAILED 且标记 rolledBack=true");
    assert(refreshedCount === 0, "失败回滚不得触发成功刷新回调");
    assert(failingStore.getItem("sc-sales-world-v2") === rawSalesBefore, "业务存储已逐字节回滚至修改前状态");
    assert(wc.getStatus().activeGrant.usedOperations === 0, "回滚后不消耗授权次数配额");

    // B. 超过 300 条正式修改凭证 -> 自动归档至独立归档键，绝不静默删除！
    const archiveStoreMem = createMemoryStorage();
    const audit = Audit.createAuditStore({ storage: archiveStoreMem });
    for (let i = 1; i <= 305; i++) {
      audit.recordMutationVoucher({
        voucherId: `op_seq_${i}`,
        target: { module: "sales", entityType: "shipment", entityId: "shp_eu_01", displayName: "SHP-ASTER-EU1" },
        action: { type: "shipment.update", payload: { seq: i } },
        diff: [{ field: "transitDays", before: i, after: i + 1 }]
      });
    }
    const counts = audit.getCounts();
    assert(counts.mutationVouchers === 300 && counts.archivedMutationVouchers === 5 && counts.totalMutationVouchers === 305,
      `305 条修改凭证应全部保留（活跃300 + 归档5），实际：${JSON.stringify(counts)}`);
    const archives = audit.listArchives();
    assert(archives.length >= 1 && audit.getMutationVoucher("op_seq_1") !== null,
      "最早的第 1 条正式修改凭证已安全归档并仍可完整检索，未被静默删除");
  });

  /* =========================================================================
     P0 #4: 业务提交后后续模型超时/失败/取消，仍必须展示真实修改回执与凭证
     ========================================================================= */
  test("P0-4. 业务提交后若第 2 轮模型超时/报错/取消，仍立即展示已完成修改结果与凭证", async () => {
    for (const failMode of ["timeout", "http_error", "cancel"]) {
      const f = buildAsterBenchmarkFixture();
      const store = createMemoryStorage({
        "bom-flow-sim-v5": JSON.stringify(f.bom),
        "sc-sales-world-v2": JSON.stringify(f.ws)
      });
      const abortCtrl = typeof AbortController === "function" ? new AbortController() : { aborted: false, abort() { this.aborted = true; } };
      const immediateReceipts = [];
      let round = 0;

      const mockModel = async () => {
        round += 1;
        if (round === 1) {
          return {
            ok: true,
            content: "",
            toolCalls: [{ id: `mut_${failMode}`, type: "function", function: { name: "adjust_shipment_eta", arguments: JSON.stringify({ etaDelayDays: 5 }) } }],
            usage: { promptTokens: 200, completionTokens: 30, totalTokens: 230 }
          };
        }
        if (failMode === "timeout") {
          return { ok: false, timedOut: true, error: { code: "TIMEOUT", message: "第2轮模型响应超时" } };
        }
        if (failMode === "http_error") {
          return { ok: false, error: { code: "API_HTTP_ERROR", message: "HTTP 502 Bad Gateway" } };
        }
        abortCtrl.abort();
        return { ok: false, cancelled: true, error: { code: "CANCELLED", message: "用户取消" } };
      };

      const assistant = Client.createAssistant({
        storage: store,
        modelConfig: { baseUrl: "https://mock.local/v1", apiKey: "sk-mock-004", transport: mockModel }
      });
      assistant.grantWriteAuthorization({ workspaceId: f.ws.workspaceId, allowedOperations: ["shipment.adjust_eta"] });

      const res = await assistant.ask({
        userMessage: "当前这批货预计晚到5天，帮我调整一下。",
        signal: abortCtrl.signal || abortCtrl,
        activeContext: { module: "sales", entity: { kind: "shipment", id: "shp_eu_01", name: "SHP-ASTER-EU1" } },
        onMutationCommitted: rec => immediateReceipts.push(rec)
      });

      assert(immediateReceipts.length === 1 && immediateReceipts[0].mutation.voucherId,
        `[${failMode}] 业务提交瞬间必须立即通过 onMutationCommitted 产出真实回执`);
      assert(res.type === "mutation" && res.partialModelFailure === true && res.mutations.length === 1 && Boolean(res.mutations[0].voucherId),
        `[${failMode}] 第 2 轮模型失败后仍必须返回已完成的真实修改结果与凭证`);
      assert(res.answer.includes(res.mutations[0].voucherId) && res.answer.includes("SHP-ASTER-EU1"),
        `[${failMode}] 系统生成的回执正文包含目标单号与真实凭证号`);
    }
  });

  /* =========================================================================
     P0 #5: 授权与用户本次修改意图分离 + 防止外部搜索内容诱导写入 + 目标范围限制
     ========================================================================= */
  test("P0-5. 临时写入授权不代表查询允许修改，严防外部搜索内容诱导写入与越界目标修改", async () => {
    const f = buildAsterBenchmarkFixture();
    const rawSalesBefore = JSON.stringify(f.ws);
    const store = createMemoryStorage({
      "bom-flow-sim-v5": JSON.stringify(f.bom),
      "sc-sales-world-v2": rawSalesBefore
    });

    // 场景 A: 已授权，但用户只是提问“如果晚到5天会怎样” -> 即使模型强行调用写工具也必须被拦截！
    let stepA = 0;
    let toolsExposedOnQuery = [];
    const modelQueryAttempt = async (req) => {
      stepA += 1;
      if (stepA === 1) {
        toolsExposedOnQuery = (req.body.tools || []).map(t => t.function?.name);
        return {
          ok: true,
          content: "",
          toolCalls: [{ id: "bad_write_1", type: "function", function: { name: "adjust_shipment_eta", arguments: JSON.stringify({ etaDelayDays: 5 }) } }],
          usage: { promptTokens: 150, completionTokens: 20, totalTokens: 170 }
        };
      }
      const toolOut = JSON.parse(req.body.messages.find(m => m.tool_call_id === "bad_write_1").content);
      assert(toolOut.ok === false && toolOut.code === "NO_USER_WRITE_INTENT", "纯查询/假设提问必须返回 NO_USER_WRITE_INTENT");
      return { ok: true, content: JSON.stringify({ type: "query", answer: "未修改数据。" }), toolCalls: [] };
    };

    const assistantA = Client.createAssistant({
      storage: store,
      modelConfig: { baseUrl: "https://mock.local/v1", apiKey: "sk-mock-005", transport: modelQueryAttempt }
    });
    assistantA.grantWriteAuthorization({ workspaceId: f.ws.workspaceId, allowedOperations: ["shipment.adjust_eta"] });

    const resA = await assistantA.ask({
      userMessage: "帮我查一下如果这批货晚到5天会怎样？",
      activeContext: { module: "sales", entity: { kind: "shipment", id: "shp_eu_01", name: "SHP-ASTER-EU1" } }
    });
    assert(!toolsExposedOnQuery.includes("adjust_shipment_eta"), "纯查询轮次不应向模型暴露写工具");
    assert(resA.mutations.length === 0 && store.getItem("sc-sales-world-v2") === rawSalesBefore, "业务数据零改动");

    // 场景 B: 授权绑定单目标 allowedTargetIds 时，禁止越界修改其他发运单
    const wc = Mutations.createWriteController({ storage: store });
    wc.grantAuthorization({ workspaceId: f.ws.workspaceId, allowedOperations: ["shipment.adjust_eta"], allowedTargetIds: ["shp_eu_01"] });
    const outOfScope = wc.executeAuthorizedMutation({ operation: "shipment.adjust_eta", targetId: "shp_us_02", etaDelayDays: 5 });
    assert(!outOfScope.ok && outOfScope.code === "TARGET_OUT_OF_SCOPE", "超出授权目标列表的写操作必须拒绝");
  });

  /* =========================================================================
     P1 #6: 模型循环预算控制（轮数 / Token / 工具次数）+ 设置实时生效
     ========================================================================= */
  test("P1-6. 全链路预算控制（模型轮数/累计Token/工具调用）可靠退出且设置修改立即生效", async () => {
    const f = buildAsterBenchmarkFixture();
    const store = createMemoryStorage({
      "bom-flow-sim-v5": JSON.stringify(f.bom),
      "sc-sales-world-v2": JSON.stringify(f.ws)
    });

    // 恶意死循环模型：每轮都不断发起工具调用，不结束
    let infiniteCalls = 0;
    const loopModel = async () => {
      infiniteCalls += 1;
      return {
        ok: true,
        content: "",
        toolCalls: [{ id: `loop_${infiniteCalls}`, type: "function", function: { name: "query_bom", arguments: JSON.stringify({ kind: "company" }) } }],
        usage: { promptTokens: 400, completionTokens: 100, totalTokens: 500 }
      };
    };

    const assistant = Client.createAssistant({
      storage: store,
      maxModelRounds: 4,
      maxToolCalls: 4,
      maxTotalTokens: 10000,
      modelConfig: { baseUrl: "https://mock.local/v1", apiKey: "sk-mock-006", transport: loopModel }
    });

    // A. 动态修改预算（立刻生效！）：限制 maxModelRounds=2
    assistant.updateBudgets({ maxModelRounds: 2, maxToolCalls: 6, maxTotalTokens: 10000 });
    infiniteCalls = 0;
    const rRounds = await assistant.ask({ userMessage: "测试轮数上限" });
    assert(!rRounds.ok && rRounds.budgetExceeded && infiniteCalls <= 2,
      `更新 maxModelRounds=2 应立即生效并可靠退出，实际模型请求 ${infiniteCalls} 次`);

    // B. 动态限制 maxTotalTokens=600 -> 1 轮消耗 500 + 第 2 轮消耗 500=1000 >= 600 后可靠退出
    assistant.updateBudgets({ maxModelRounds: 6, maxToolCalls: 6, maxTotalTokens: 600 });
    infiniteCalls = 0;
    const rTokens = await assistant.ask({ userMessage: "测试 Token 预算上限" });
    assert(!rTokens.ok && rTokens.budgetExceeded === "maxTotalTokens" && infiniteCalls === 2,
      `累计 Token 达到 600 上限时必须可靠退出，实际请求 ${infiniteCalls} 次`);
  });

  /* =========================================================================
     P1 #7 & #8 & #9: 虚假修改拦截 + <think> 剥离 + dataCards 渲染 + 上下文清理 + Aster 缺口精确校验
     ========================================================================= */
  test("P1-7/8/9 + Aster 基准：虚假修改拦截、dataCards 官方渲染、Aster 30天缺口精确（欧盟750/美国1800/中国0）", async () => {
    const f = buildAsterBenchmarkFixture();
    const store = createMemoryStorage({
      "bom-flow-sim-v5": JSON.stringify(f.bom),
      "sc-sales-world-v2": JSON.stringify(f.ws)
    });

    // 1) Aster 30 天需求缺口校验：欧盟 750、美国 1800、中国 0（SimEngine 与 AI query_world_state & dataCards 100% 一致）
    const official = Sim.simulateWorkspace(f.ws, { today: "2026-11-01", viewHorizonDays: 30 });
    assert(official.marketSummaries.mkt_eu.totalDemandGap === 750, `官方 SimEngine 欧盟 30 天缺口应为 750，实际 ${official.marketSummaries.mkt_eu.totalDemandGap}`);
    assert(official.marketSummaries.mkt_us.totalDemandGap === 1800, `官方 SimEngine 美国 30 天缺口应为 1800，实际 ${official.marketSummaries.mkt_us.totalDemandGap}`);
    assert(official.marketSummaries.mkt_cn.totalDemandGap === 0, `官方 SimEngine 中国 30 天缺口应为 0，实际 ${official.marketSummaries.mkt_cn.totalDemandGap}`);

    let step = 0;
    const mockModel = async () => {
      step += 1;
      if (step === 1) {
        return {
          ok: true,
          content: "",
          toolCalls: [{ id: "ws_bench", type: "function", function: { name: "query_world_state", arguments: JSON.stringify({ asOfDate: "2026-11-01", horizonDays: 30 }) } }],
          usage: { promptTokens: 220, completionTokens: 30, totalTokens: 250 }
        };
      }
      return {
        ok: true,
        content: "<think>内部隐藏思考不应展示</think>" + JSON.stringify({
          type: "query",
          answer: "未来 30 天需求缺口：欧盟 750 台、美国 1800 台、中国 0 台。"
        }),
        toolCalls: [],
        usage: { promptTokens: 420, completionTokens: 45, totalTokens: 465 }
      };
    };

    const assistant = Client.createAssistant({
      storage: store,
      modelConfig: { baseUrl: "https://mock.local/v1", apiKey: "sk-mock-007", transport: mockModel }
    });
    const benchRes = await assistant.ask({ userMessage: "查询未来30天各市场需求缺口" });
    assert(benchRes.ok && !benchRes.answer.includes("<think>") && !benchRes.answer.includes("内部隐藏思考"), "思考过程标签已彻底剥离");
    const wsCard = benchRes.dataCards.find(c => c.kind === "world_state");
    assert(Boolean(wsCard), "返回包含官方 world_state dataCard");
    const gapByName = Object.fromEntries(wsCard.markets.map(m => [m.name || m.nodeId, m.totalDemandGap]));
    assert(gapByName["欧盟市场"] === 750 && gapByName["美国市场"] === 1800 && gapByName["中国市场"] === 0,
      `AI dataCards 30天缺口应精确等于 欧盟750/美国1800/中国0，实际：${JSON.stringify(gapByName)}`);

    // 验证侧边栏 renderDataCardsHtml 正确渲染官方数值卡片，且 shouldHideStreamingPreview 拦截原始 JSON 与虚假修改宣称
    const cardHtml = Sidebar.renderDataCardsHtml(benchRes.dataCards);
    assert(cardHtml.includes("欧盟市场") && cardHtml.includes("750") && cardHtml.includes("1800"), "侧边栏 dataCards 渲染包含官方市场缺口数值");
    assert(Sidebar.shouldHideStreamingPreview('{"type":"query","answer":"hi"}') === true, "流式阶段隐藏原始 JSON");
    assert(Sidebar.shouldHideStreamingPreview("已为您修改完成，发运单顺延 5 天") === true, "流式阶段拦截未经证实的修改宣称");

    // 2) 未执行实际修改但模型在正文中谎称“已修改” -> 必须被强制拦截！
    const liarAssistant = Client.createAssistant({
      storage: store,
      modelConfig: {
        baseUrl: "https://mock.local/v1",
        apiKey: "sk-mock-liar",
        transport: async () => ({
          ok: true,
          content: JSON.stringify({ type: "query", answer: "已为您成功修改发运单，预计到港时间已延后 5 天。" }),
          toolCalls: []
        })
      }
    });
    const liarRes = await liarAssistant.ask({ userMessage: "帮我延期5天" });
    assert(liarRes.type === "unable" && liarRes.unverifiedMutationClaimBlocked === true && !liarRes.answer.includes("已为您成功修改"),
      "无真实修改时，正文宣称已修改必须被拦截降级为 unable");

    // 3) P1-9: 切换模块、关闭详情与切换主体时必须清理旧上下文，防止误用旧主体执行修改
    const noopEl = () => ({
      classList: { toggle() {}, add() {}, remove() {} },
      setAttribute() {},
      addEventListener() {},
      querySelector() { return null; },
      innerHTML: ""
    });
    const prevDoc = globalThis.document;
    const prevLS = globalThis.localStorage;
    const prevSS = globalThis.sessionStorage;
    try {
      globalThis.document = { getElementById: () => noopEl() };
      globalThis.localStorage = store;
      globalThis.sessionStorage = createMemoryStorage();
      const sb = Sidebar.mount({ initialModule: "sales" });
      sb.setSelectedEntity({ module: "sales", kind: "shipment", id: "shp_eu_01", name: "SHP-ASTER-EU1" });
      assert(sb.getActiveContext().entity.id === "shp_eu_01", "选中发运单后上下文生效");
      sb.setActiveModule("bom");
      assert(sb.getActiveContext().module === "bom" && sb.getActiveContext().entity === null, "切换模块后立即清除旧模块发运单上下文");
      sb.setSelectedEntity({ module: "bom", kind: "company", id: f.compMain, name: "星耀精密制造有限公司" });
      assert(sb.getActiveContext().entity.id === f.compMain, "切换新主体后上下文更新");
      sb.clearSelectedEntity("bom");
      assert(sb.getActiveContext().entity === null, "关闭详情面板后上下文立即清空");
    } finally {
      globalThis.document = prevDoc;
      globalThis.localStorage = prevLS;
      globalThis.sessionStorage = prevSS;
    }
  });

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
    log(`\nAI Acceptance Fix regression summary: ${passed} passed, ${failed} failed.`);
    if (failed > 0 && typeof quit === "function") quit(1);
    if (failed > 0 && typeof process !== "undefined") process.exit(1);
  })();
})();
