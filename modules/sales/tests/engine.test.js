/**
 * Sales 供应链业务系统 V0.2 核心引擎与回归测试
 * 兼容 Node.js (`node tests/engine.test.js`) 与 macOS JavaScriptCore (`jsc`)
 */
(function () {
  "use strict";

  let TS, WM, Sim, Act, Demo;
  if (typeof require === "function") {
    TS = require("../js/timeseries.js");
    WM = require("../js/world-model.js");
    Sim = require("../js/sim-engine.js");
    Act = require("../js/actions.js");
    Demo = require("../js/demo-world.js");
  } else if (typeof load === "function") {
    const base = (typeof scriptDir === "string" ? scriptDir : "js");
    load(base + "/timeseries.js");
    load(base + "/world-model.js");
    load(base + "/sim-engine.js");
    load(base + "/actions.js");
    load(base + "/demo-world.js");
    ({ TimeSeries: TS, WorldModel: WM, SimEngine: Sim, Actions: Act, DemoWorld: Demo } = globalThis.SC);
  }

  let passed = 0, failed = 0;
  const log = typeof console !== "undefined" && console.log ? (...a) => console.log(...a) : (...a) => print(...a);
  const assert = (cond, msg) => { if (!cond) throw new Error("Assertion failed: " + msg); };
  const assertClose = (a, e, tol, msg) => { if (Math.abs(a - e) > tol) throw new Error(`${msg}: expected ${e}±${tol}, got ${a}`); };

  function test(name, fn) {
    try { fn(); passed++; log("✓ " + name); }
    catch (err) { failed++; log("✗ " + name + "\n  " + (err && err.stack ? err.stack : err)); }
  }

  const TODAY = "2026-11-22";

  /* 1. 业务结构：仅保留工厂与目标市场，无中转仓，无多情景 */
  test("结构 1: 单一正式计划仅保留工厂与市场，禁止创建中转仓节点", () => {
    const ws = Demo.createDemoWorkspace(null, TODAY);
    assert(ws.version === 2, "版本为 v2");
    assert(!("scenarios" in ws), "不存在多情景结构");
    for (const n of Object.values(ws.nodes)) {
      assert(n.kind === "source" || n.kind === "market", `节点 ${n.id} 只能是工厂或市场`);
    }
    const bad = Act.dispatchAction(ws, Act.createAction(ws, "node.create", "", { kind: "buffer", name: "非法中转仓" }));
    assert(!bad.ok, "必须拒绝创建 buffer 中转仓节点");
  });

  /* 2. 单条关系线下多笔独立发运：各自拥有独立时效与费用，修改常用方案不改写已有发运 */
  test("结构 2: 同一工厂→市场关系线下支持多笔不同时效/方式发运，且修改常用方案不影响已有发运", () => {
    let ws = Demo.createDemoWorkspace(null, TODAY);
    const sim = Sim.simulateWorkspace(ws, { today: TODAY, viewHorizonDays: 60 });
    const cor = sim.corridors["src_cn_hz__mkt_us"];
    assert(cor && cor.activeCount >= 3, "杭州一厂→美国市场应汇总多笔发运在同一关系线上");
    assert(ws.shipments.shp_001.transitDays === 16, "SHP-001 独立时效 16 天");
    assert(ws.shipments.shp_002.transitDays === 13, "SHP-002 独立时效 13 天");
    assert(ws.shipments.shp_003.transitDays === 21, "SHP-003 独立时效 21 天");

    // Modify lane template default transitDays -> MUST NOT alter existing shipments!
    const laneRes = Act.dispatchAction(ws, Act.createAction(ws, "lane.save", "lane_hz_us_sea", {
      fromNodeId: "src_cn_hz", toNodeId: "mkt_us", name: "美森快船新模板",
      defaultMode: "sea_express", defaultTransitDays: 9, defaultFixedCost: 9999, defaultUnitCost: 50
    }));
    assert(laneRes.ok, "修改常用方案模板成功");
    ws = laneRes.workspace;
    assert(ws.shipments.shp_001.transitDays === 16 && ws.shipments.shp_002.transitDays === 13, "修改模板不得改写已存在发运事实或计划");

    // Duplicate shipment works cleanly with independent editable copy
    const dupRes = Act.dispatchAction(ws, Act.createAction(ws, "shipment.duplicate", "shp_003", { departDate: "2026-12-05", qty: 500, newShipmentId: "shp_copy" }));
    assert(dupRes.ok && dupRes.workspace.shipments.shp_copy.transitDays === 21 && dupRes.workspace.shipments.shp_copy.qty === 500, "复制发运继承参数且独立存在");
  });

  /* 3. 停靠港仅作信息记录，不生成库存节点 */
  test("结构 3: 发运停靠港仅作为事件信息，不产生库存或中转节点", () => {
    const ws = Demo.createDemoWorkspace(null, TODAY);
    assert(ws.shipments.shp_001.stopoverPorts.length === 1 && ws.shipments.shp_001.stopoverPorts[0].port === "釜山港", "保留停靠港信息");
    const sim = Sim.simulateWorkspace(ws, { today: TODAY, viewHorizonDays: 30 });
    assert(!sim.nodeDaily["釜山港"] && Object.keys(sim.nodeDaily).length === Object.keys(ws.nodes).length, "停靠港不会生成库存节点");
  });

  /* 4. 真实自然日期滚动测试：明天打开系统时，历史发运与生产曲线绝不自动整体平移！ */
  test("日期滚动: 今天从 2026-11-22 推进至 2026-11-25 时，历史记录绝对日期不变，仅当前视图与库存指针前移", () => {
    const ws = Demo.createDemoWorkspace(null, TODAY);
    const simDay0 = Sim.simulateWorkspace(ws, { today: "2026-11-22", viewHorizonDays: 30 });
    const simDay3 = Sim.simulateWorkspace(ws, { today: "2026-11-25", viewHorizonDays: 30 });

    assert(ws.shipments.shp_002.departDate === "2026-11-08", "历史发运日期保持绝对不变");
    assert(simDay0.shipmentStates.shp_002.borderArrivalActualDate === "2026-11-21", "实际抵港事实保持不变");
    assert(simDay3.shipmentStates.shp_002.borderArrivalActualDate === "2026-11-21", "3 天后打开实际抵港事实仍不变");
    // On 2026-11-22, SHP-002 (border actual 11-21, planned release 11-25) is awaiting customs (not overdue)
    assert(simDay0.shipmentStates.shp_002.overdueStage === null, "11-22 尚未超清关预计日");
    // On 2026-11-26 (1 day after planned release 11-25 with no actual release confirmed), it MUST flag overdue_customs instead of auto-clearing!
    const simDay4 = Sim.simulateWorkspace(ws, { today: "2026-11-26", viewHorizonDays: 30 });
    assert(simDay4.shipmentStates.shp_002.overdueStage === "customs_release", "逾期未确认清关必须提示待确认，绝不自动当成已放行");
    assert(simDay4.shipmentStates.shp_002.customsReleaseActualDate === null, "未确认的实际放行日必须保持 null");
  });

  /* 5. Rate Mode 精确积分 & Total Mode 均匀/自定义严格守恒 */
  test("计算 1: Rate Mode 10天 100→200 积分严格等于 1500；Total Mode 均匀与自定义波形严格守恒", () => {
    let ws = Demo.createDemoWorkspace(null, TODAY);
    const area = TS.integrateCurveByDates(ws.curves.crv_hz_prod, TODAY, TS.addDaysToIso(TODAY, 10));
    assertClose(area, 1500, 1e-6, "Rate Mode 10天精确积分");

    const daily = TS.computeDailySeriesRange(ws.curves.crv_hz_prod, TODAY, 10);
    assertClose(daily.reduce((s, x) => s + x.qty, 0), 1500, 1e-6, "逐日积分总和守恒");

    // Set Total Mode [today, today+10] = 100 with custom shape
    let res = Act.dispatchAction(ws, Act.createAction(ws, "timeseries.segment.setMode", "crv_hz_prod", {
      segmentId: "seg_u", mode: "total", startDate: TODAY, endDate: TS.addDaysToIso(TODAY, 10), totalQty: 100, distribution: "custom",
      shapeAnchors: [{ t: 0, weight: 0.3 }, { t: 0.4, weight: 2.8 }, { t: 1, weight: 0.9 }]
    }));
    assert(res.ok, "setMode total custom ok");
    ws = res.workspace;
    assertClose(TS.integrateCurveByDates(ws.curves.crv_hz_prod, TODAY, TS.addDaysToIso(TODAY, 10)), 100, 1e-6, "Total Mode 自定义波形严格守恒 100");
    const d10 = TS.computeDailySeriesRange(ws.curves.crv_hz_prod, TODAY, 10);
    assert(d10[0].sourcePrecision === "estimated_from_interval_total", "不把估算日度标成真实日度");
  });

  /* 6. 生产批次锁定与防重叠、负库存禁止与严格库存守恒 */
  test("计算 2: 生产批次未到可用日禁止发运，全节点全周期库存守恒 Δ=0 且零负库存", () => {
    let ws = Demo.createDemoWorkspace(null, TODAY);
    // Overlapping batch rejected
    const ov = Act.dispatchAction(ws, Act.createAction(ws, "batch.createFromInterval", "src_cn_hz", {
      startDate: TS.addDaysToIso(TODAY, 5), endDate: TS.addDaysToIso(TODAY, 15), extraWaitDays: 1
    }));
    assert(!ov.ok, "重叠生产区间建批必须被拒绝");

    // Early shipment bound to bat_hz_01 (availableDate = today+12) departing at today+10 must be blocked!
    const early = Act.dispatchAction(ws, Act.createAction(ws, "shipment.update", "shp_007", {
      departDate: TS.addDaysToIso(TODAY, 10)
    }));
    assert(early.ok, "记录冲突供业务排查");
    assert(early.simulation.shipmentStates.shp_007.executed === false, "批次未释放不得发运");
    assert(early.simulation.conflicts.some(c => c.code === "BATCH_NOT_RELEASED" && c.targetId === "shp_007"), "给出 BATCH_NOT_RELEASED 明确提示");

    for (const [nid, days] of Object.entries(early.simulation.nodeDaily)) {
      for (const snap of days) {
        assert(snap.endingAvailable >= -1e-6, `${nid} ${snap.date} 不可出现负库存`);
        assertClose(snap.conservationDelta, 0, 1e-4, `${nid} ${snap.date} 库存守恒公式必须为 0`);
      }
    }
  });

  /* 7. 三里程碑严格隔离：抵港/清关未完成绝不计入市场可售库存，且实际日期不被计划覆盖 */
  test("计算 3: 抵港/清关未完成不计入可售，确认事实后不受未来重算覆盖", () => {
    let ws = Demo.createDemoWorkspace(null, TODAY);
    const sim = Sim.simulateWorkspace(ws, { today: TODAY, viewHorizonDays: 30 });
    // SHP-001 is overdue unconfirmed border arrival (planned 11-20, actual null): MUST NOT silently count as available stock today!
    assert(sim.shipmentStates.shp_001.overdueStage === "border_arrival", "SHP-001 应提示抵港逾期未确认");
    assert(sim.shipmentStates.shp_001.progressStatus === "overdue_border", "状态为 overdue_border");
    // SHP-002 arrived 11-21 (actual), awaiting customs -> counts in awaitingCustoms today (1100), NOT yet arrived in market available today!
    assertClose(sim.kpis.awaitingCustoms, 1100, 1e-6, "今日待清关货物精确等于 SHP-002 的 1100 台");

    // Confirm SHP-002 customs release today, then update its transitDays -> actual dates MUST stay intact!
    let r = Act.dispatchAction(ws, Act.createAction(ws, "event.record", "shp_002", {
      kind: "customs_release", date: TODAY, note: "海关放行回执"
    }));
    assert(r.ok, "记录实际清关成功");
    ws = r.workspace;
    r = Act.dispatchAction(ws, Act.createAction(ws, "shipment.update", "shp_002", { transitDays: 20 }));
    assert(r.ok, "更新计划参数成功");
    assert(r.workspace.shipments.shp_002.milestones.borderArrivalActualDate === TS.addDaysToIso(TODAY, -1), "已确认实际抵港日不得被覆盖");
    assert(r.workspace.shipments.shp_002.milestones.customsReleaseActualDate === TODAY, "已确认实际清关日不得被覆盖");
  });

  /* 8. V1 旧数据安全迁移：保留归档中转仓与不兼容发运，绝不静默丢失 */
  test("迁移测试: V1（含多情景与中转仓）升级 V2 时完整归档中转仓与受影响发运并给出迁移提示", () => {
    const fakeV1 = {
      format: "sc-sales-world",
      version: 1,
      worldId: "v1_old",
      name: "旧版世界",
      isDemoData: false,
      startDate: "2026-11-01",
      horizonDays: 60,
      activeProductId: "GW-G200",
      activeScenarioId: "BASE",
      products: { "GW-G200": { productId: "GW-G200", skuCode: "GW-G200", name: "智能网关 G200", unit: "台", unitManufacturingCost: 185, costSource: "bom_linked" } },
      facts: [],
      scenarios: {
        BASE: {
          scenarioId: "BASE", name: "BASE", isBase: true, revision: 3,
          nodes: {
            src1: { id: "src1", kind: "source", name: "杭州厂", region: "CN", initialInventory: 500 },
            buf1: { id: "buf1", kind: "buffer", bufferMode: "pool", name: "印尼保税仓", region: "ID", initialInventory: 800 },
            mkt1: { id: "mkt1", kind: "market", name: "美国市场", region: "US", initialInventory: 400 }
          },
          routes: {
            r_dir: { id: "r_dir", fromNodeId: "src1", toNodeId: "mkt1", mode: "sea", transitDays: 15, fixedCost: 2000, unitCost: 8, customsWaitDays: 4, putawayDays: 2 },
            r_buf: { id: "r_buf", fromNodeId: "src1", toNodeId: "buf1", mode: "sea", transitDays: 8, fixedCost: 1200, unitCost: 4 }
          },
          curves: { c1: { id: "c1", targetNodeId: "src1", kind: "production", points: [{ id: "p1", day: 0, rate: 100 }], totalSegments: [], importedDailyActuals: [] } },
          batches: {},
          shipments: {
            s_dir: { id: "s_dir", code: "S1", routeId: "r_dir", fromNodeId: "src1", toNodeId: "mkt1", departDay: 5, qty: 200, status: "planned", milestones: {} },
            s_buf: { id: "s_buf", code: "S2", routeId: "r_buf", fromNodeId: "src1", toNodeId: "buf1", departDay: 6, qty: 300, status: "planned", milestones: {} }
          }
        },
        ALT: { scenarioId: "ALT", name: "沙盒", isBase: false, revision: 1, nodes: {}, routes: {}, curves: {}, batches: {}, shipments: {} }
      }
    };

    const migrated = WM.validateWorkspace(fakeV1, { backupKey: WM.LEGACY_V1_BACKUP_KEY });
    assert(migrated.version === 2, "迁移到 v2");
    assert(!migrated.nodes.buf1, "中转仓已从正式节点移除");
    assert(migrated.nodes.src1 && migrated.nodes.mkt1, "工厂与市场完整保留");
    assert(migrated.shipments.s_dir && migrated.shipments.s_dir.departDate === "2026-11-06", "直发发运转为绝对日期保留");
    assert(!migrated.shipments.s_buf, "经中转仓旧发运不混入新模型");
    assert(migrated.legacyArchive?.removedBuffers?.buf1, "旧中转仓归档保留未静默丢失");
    assert(migrated.legacyArchive?.incompatibleShipments?.s_buf, "旧中转仓发运归档保留未静默丢失");
    assert(migrated.migrationNotice && migrated.migrationNotice.archivedBufferCount === 1 && migrated.migrationNotice.archivedShipmentCount === 1, "给出清晰迁移提示");
  });

  /* 9. CSV 校验（日度曲线 CSV + 批量发运 CSV）与未来 AI 内存模拟接口保留 */
  test("导入与 AI 接口: 日度 CSV 严格校验、批量发运 CSV 导入、AI simulateActions 无副作用预演", () => {
    let ws = Demo.createDemoWorkspace(null, TODAY);
    assert(!TS.parseDailyCsv("date,sku,qty\n2026-W47,GW-G200,500", { expectedSku: "GW-G200" }).ok, "拒绝周度 CSV");
    assert(TS.parseDailyCsv(`date,sku,qty\n${TODAY},GW-G200,150`, { expectedSku: "GW-G200" }).ok, "合法日度 CSV 通过");

    const shpCsv = `from,to,depart_date,qty,mode,transit_days,carrier\n杭州总装一厂,日本市场,${TS.addDaysToIso(TODAY, 6)},400,海运,7,锦江航运`;
    const imp = Act.dispatchAction(ws, Act.createAction(ws, "shipment.batchImport", "", { csvText: shpCsv }));
    assert(imp.ok && Object.keys(imp.workspace.shipments).length === Object.keys(ws.shipments).length + 1, "批量导入发运 CSV 成功");

    // AI simulateActions dry-run MUST NOT mutate workspace
    const revBefore = ws.revision;
    const dry = Act.simulateActions(ws, [Act.createAction(ws, "shipment.create", "", {
      fromNodeId: "src_cn_hz2", toNodeId: "mkt_us", departDate: TS.addDaysToIso(TODAY, 2), qty: 300, mode: "air", transitDays: 4
    }, { actor: "ai_agent" })], { today: TODAY });
    assert(dry.ok && ws.revision === revBefore && Object.keys(ws.shipments).length === 7, "AI 内存预演不修改正式业务数据");
    assert(Act.queryWorldState(ws, { today: TODAY }).kpis.currentAvailableInventory > 0, "queryWorldState 正常可用");
  });

  /* 10. 每条曲线独立跨度控制 & 移除最大产能约束 */
  test("精简校验: 无最大产能约束曲线，每条供需曲线可独立设置跨度（30/90/180天等）", () => {
    let ws = Demo.createDemoWorkspace(null, TODAY);
    assert(Object.values(ws.curves).every(c => c.kind !== "capacity"), "不应存在最大产能约束曲线");
    assert(ws.curves.crv_hz_prod.horizonDays === 90 && ws.curves.crv_hz2_prod.horizonDays === 30, "不同工厂曲线可拥有不同跨度");
    const r = Act.dispatchAction(ws, Act.createAction(ws, "timeseries.setHorizon", "crv_hz2_prod", { horizonDays: 180 }));
    assert(r.ok && r.workspace.curves.crv_hz2_prod.horizonDays === 180 && r.workspace.curves.crv_hz_prod.horizonDays === 90, "修改单条曲线长度不影响其他曲线");
    const bad = Act.dispatchAction(ws, Act.createAction(ws, "timeseries.setHorizon", "crv_hz2_prod", { horizonDays: 3 }));
    assert(!bad.ok, "非法过短跨度被拦截");
  });

  /* 11. V0.3 验收：上架完成日 D → 最早可销售日 D+1，已有库存不受延迟，无次日等待队列 */
  test("V0.3 规则 1: 上架日(D)不可满足当日需求、次日(D+1)开始可售；已有库存正常消耗且缺口不滚入次日等待队列", () => {
    const ws = WM.createBlankWorkspace(null, "2026-11-25");
    ws.nodes.src_main.initialInventory = 1000;
    ws.nodes.mkt_main.initialInventory = 100; // Existing sellable stock on Nov 25
    ws.curves.crv_mkt_dem.points = [
      { id: "p0", date: "2026-11-25", rate: 250 },
      { id: "p1", date: "2026-11-30", rate: 250 }
    ];
    // Shipment of 300 units with putaway completing on 2026-11-25 (0-day cycle)
    ws.shipments.shp_same = {
      id: "shp_same", code: "SHP-SAME", productId: ws.activeProductId,
      fromNodeId: "src_main", toNodeId: "mkt_main", qty: 300,
      departDate: "2026-11-25", mode: "truck", carrier: "直达",
      transitDays: 0, fixedCost: 100, unitCost: 1, customsWaitDays: 0, putawayDays: 0,
      importFeeFixed: 0, importFeePerUnit: 0, status: "confirmed",
      milestones: {
        departActualDate: "2026-11-25",
        borderArrivalPlannedDate: "2026-11-25", borderArrivalActualDate: "2026-11-25",
        customsReleasePlannedDate: "2026-11-25", customsReleaseActualDate: "2026-11-25",
        marketStockAvailablePlannedDate: "2026-11-25", marketStockAvailableActualDate: "2026-11-25"
      }
    };

    const sim = Sim.simulateWorkspace(ws, { today: "2026-11-25", viewHorizonDays: 10 });
    const st = sim.shipmentStates.shp_same;
    assert(st.putawayCompleteActualDate === "2026-11-25", "上架完成日为 11-25");
    assert(st.earliestSellableActualDate === "2026-11-26", "最早可销售日为 11-26 (D+1)");
    assert(st.fullCycleZeroSpan === true && st.fullCycleElapsedPct === 100, "0天周期时间消耗明确处理");

    const day25 = sim.nodeDaily.mkt_main.find(x => x.date === "2026-11-25");
    const day26 = sim.nodeDaily.mkt_main.find(x => x.date === "2026-11-26");

    // Nov 25: ONLY existing 100 sellable! Newly shelved 300 CANNOT be consumed on Nov 25!
    assertClose(day25.satisfiedDemand, 100, 1e-6, "11-25 仅消耗已有 100 台可售库存");
    assertClose(day25.demandGap, 150, 1e-6, "11-25 预计需求缺口 150 台");
    assertClose(day25.putawayArrivals, 300, 1e-6, "11-25 记录上架 300 台");
    assertClose(day25.shelvedPendingNextDay, 300, 1e-6, "11-25 末 300 台锁定待次日可售");
    assertClose(day25.endingAvailable, 0, 1e-6, "11-25 末可售余额 0");
    assertClose(day25.conservationDelta, 0, 1e-6, "11-25 库存守恒");

    // Nov 26: 300 becomes sellable; Nov 25 unmet gap 150 does NOT carry over!
    assertClose(day26.arrivals, 300, 1e-6, "11-26 300 台释放为可售库存");
    assertClose(day26.satisfiedDemand, 250, 1e-6, "11-26 满足当日 250 预测需求");
    assertClose(day26.demandGap, 0, 1e-6, "11-26 缺口为 0（昨日缺口未滚入次日）");
    assertClose(day26.endingAvailable, 50, 1e-6, "11-26 末可售结余精确 50 台（无重复扣减）");
    assertClose(day26.conservationDelta, 0, 1e-6, "11-26 库存守恒");
  });

  /* 12. V0.3 兼容旧市场时效字段 & 保留费用计算 & 逾期未确认绝不虚增今日可售 */
  test("V0.3 规则 2: 兼容旧数据废弃市场时效字段但不参与计算，保留履约费用，逾期未确认不虚增今日库存", () => {
    const ws = WM.createBlankWorkspace(null, "2026-11-20");
    ws.nodes.src_main.initialInventory = 1000;
    ws.nodes.mkt_main.initialInventory = 200;
    // Inject deprecated fields from legacy data
    ws.nodes.mkt_main.marketPolicy = {
      priority: 1,
      orderToShipToleranceDays: 5,
      orderToDeliveryToleranceDays: 10,
      orderProcessingDays: 3,
      lastMileDays: 4,
      initialUnfulfilledDemand: 500,
      lastMileUnitCost: 10,
      fulfillmentUnitCost: 5,
      channelCommissionUnitCost: 15
    };
    ws.curves.crv_mkt_dem.points = [
      { id: "p0", date: "2026-11-20", rate: 100 },
      { id: "p1", date: "2026-11-30", rate: 100 }
    ];
    // Overdue unconfirmed shipment planned to putaway on 2026-11-22 while today is 2026-11-24
    ws.shipments.shp_late = {
      id: "shp_late", code: "SHP-LATE", productId: ws.activeProductId,
      fromNodeId: "src_main", toNodeId: "mkt_main", qty: 500,
      departDate: "2026-11-18", mode: "sea", carrier: "测试",
      transitDays: 2, fixedCost: 0, unitCost: 2, customsWaitDays: 1, putawayDays: 1,
      importFeeFixed: 0, importFeePerUnit: 0, status: "confirmed",
      milestones: {
        departActualDate: "2026-11-18",
        borderArrivalPlannedDate: "2026-11-20", borderArrivalActualDate: "2026-11-20",
        customsReleasePlannedDate: "2026-11-21", customsReleaseActualDate: "2026-11-21",
        marketStockAvailablePlannedDate: "2026-11-22", marketStockAvailableActualDate: null // Unconfirmed!
      }
    };

    const sim = Sim.simulateWorkspace(ws, { today: "2026-11-24", viewHorizonDays: 7 });
    // Day 2026-11-20 should consume 100 immediately (ignoring deprecated orderProcessingDays=3 & initialUnfulfilledDemand=500)
    const d20 = sim.nodeDaily.mkt_main.find(x => x.date === "2026-11-20");
    assertClose(d20.satisfiedDemand, 100, 1e-6, "忽略旧 orderProcessingDays/initialUnfulfilledDemand，当日直接匹配 100");
    // On today (2026-11-24), unconfirmed overdue shp_late MUST NOT inflate today's real sellable inventory!
    const d24 = sim.nodeDaily.mkt_main.find(x => x.date === "2026-11-24");
    assertClose(d24.endingAvailable, 0, 1e-6, "逾期未确认上架绝不可虚增今日真实可售库存");
    assert(sim.shipmentStates.shp_late.overdueStage === "market_stock_available", "标记上架逾期未确认");
    assert(sim.costs.localFulfillmentAndChannel > 0, "删除末端时效字段不得误删履约与渠道费用计算");
  });

  /* 13. V0.3 结构化发运检索：全程时间消耗比例 + 关键日期阈值（区分预计/实际）+ 市场工厂组合 */
  test("V0.3 规则 3: 全程时间消耗比例区间与关键里程碑日期阈值结构化检索正确", () => {
    const ws = Demo.createDemoWorkspace(null, TODAY);
    const sim = Sim.simulateWorkspace(ws, { today: TODAY, viewHorizonDays: 60 });

    // Full-cycle elapsed ratio range filter [50%, 90%]
    const midRange = Sim.queryShipments(ws, sim, { elapsedMin: 50, elapsedMax: 90 });
    assert(midRange.length > 0 && midRange.every(s => {
      const pct = sim.shipmentStates[s.id].fullCycleElapsedPct;
      return pct >= 50 && pct <= 90;
    }), "全程耗时比例 50%–90% 筛选结果精确落在区间内");

    // Milestone date threshold: actual border_arrival only (only SHP-002 has confirmed border arrival!)
    const actualBorder = Sim.queryShipments(ws, sim, {
      milestoneField: "border", dateOp: "on_or_before", dateThreshold: TODAY, dateSource: "actual"
    });
    assert(actualBorder.length === 1 && actualBorder[0].id === "shp_002", "仅实际确认抵港筛选精确命中 SHP-002");

    // Combined filter: market + factory + earliest sellable date
    const usHzEarly = Sim.queryShipments(ws, sim, {
      marketId: "mkt_us", factoryId: "src_cn_hz",
      milestoneField: "sellable", dateOp: "on_or_before", dateThreshold: TS.addDaysToIso(TODAY, 7), dateSource: "planned"
    });
    assert(usHzEarly.every(s => s.toNodeId === "mkt_us" && s.fromNodeId === "src_cn_hz" && sim.shipmentStates[s.id].earliestSellablePlannedDate <= TS.addDaysToIso(TODAY, 7)), "组合筛选（市场+工厂+最早可售日）正确");
  });

  log(`\nV0.3 测试汇总：通过 ${passed} 项，失败 ${failed} 项`);
  if (failed > 0) {
    if (typeof process !== "undefined" && process.exit) process.exit(1);
    throw new Error(`${failed} tests failed`);
  }
})();
