"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const TS = require("../modules/sales/js/timeseries.js");
const WM = require("../modules/sales/js/world-model.js");
const Sim = require("../modules/sales/js/sim-engine.js");
const Act = require("../modules/sales/js/actions.js");
require("../modules/sales/js/views.js");
require("../modules/sales/js/inspector.js");
require("../modules/sales/js/network-canvas.js");
const Snapshot = require("../storage/snapshot.js");
const Tools = require("../shared/ai-tools.js");

const anchor = "2026-11-01";
const day = n => TS.addDaysToIso(anchor, n);
const source = "src_main";
const market = "mkt_main";

function workspace(stock = 100) {
  const ws = WM.createBlankWorkspace(null, anchor);
  ws.nodes[source].initialInventory = stock;
  return ws;
}

function apply(ws, type, id, payload) {
  const result = Act.dispatchAction(ws, Act.createAction(ws, type, id, payload));
  assert.equal(result.ok, true, result.error);
  return result.workspace;
}

function order(ws, id, opts = {}) {
  return apply(ws, "shipment.create", "", {
    shipmentId: id, code: id, fromNodeId: source, toNodeId: market,
    departDate: day(0), qty: 20, transitDays: 1, customsWaitDays: 1, putawayDays: 1, ...opts
  });
}

function fact(ws, id, kind, date, qty) {
  return apply(ws, "event.record", id, { kind, date, qty });
}

function store(ws) {
  return { getItem: key => key === "sc-sales-world-v2" ? JSON.stringify(ws) : null, setItem() {} };
}

function query(ws, name, args) {
  return Tools.createRuntime({ storage: store(ws), workspace: ws }).executeTool({ name, arguments: args });
}

function render(ws, sim, view, filters = {}) {
  const zones = new Map();
  const main = {
    dataset: { mountedView: view },
    querySelector(key) {
      if (key.startsWith("[data-logi-")) return null;
      if (!zones.has(key)) zones.set(key, {
        classList: { toggle() {} },
        querySelector: () => null,
        querySelectorAll: () => []
      });
      return zones.get(key);
    },
    querySelectorAll: () => []
  };
  global.SC.Views.renderView(main, view, {
    workspace: ws, simulation: sim, skipEditorRemount: true,
    ui: { dashFactory: "all", dashMarket: "all", marketNodeId: market, ...filters }
  });
  return name => main.querySelector(`[data-zone='${name}']`).innerHTML;
}

test("H14/H15 发运至 D+1 的每个日终状态只计一次，未知上架留在物流状态", () => {
  let ws = order(workspace(), "s", { status: "confirmed" });
  ws = fact(ws, "s", "border_arrival", day(1));
  ws = fact(ws, "s", "customs_release", day(2));
  const overdue = Sim.simulateWorkspace(ws, { today: day(4) });
  assert.equal(overdue.kpis.awaitingCustoms, 20);
  assert.equal(overdue.nodeDaily[market][overdue.todayIdx].shelvedPendingNextDay, 0);
  ws = fact(ws, "s", "market_stock_available", day(3));

  for (let i = 0; i < 6; i++) {
    const sim = Sim.simulateWorkspace(ws, { today: day(i) });
    const k = sim.kpis;
    const expected = [
      [80, 20, 0, 0], [80, 0, 20, 0], [80, 0, 20, 0],
      [80, 0, 0, 20], [100, 0, 0, 0], [100, 0, 0, 0]
    ][i];
    const buckets = [k.currentAvailableInventory, k.currentInTransit, k.awaitingCustoms, k.shelvedPendingNextDay];
    assert.deepEqual(buckets, expected, day(i));
    assert.equal(buckets.reduce((sum, q) => sum + q, 0), 100);
    assert.equal(sim.marketSummaries[market].incomingQty, i < 4 ? 20 : 0);
    assert.equal(sim.nodeDaily[market][sim.todayIdx].endingAvailable, i < 4 ? 0 : 20);
  }
});

test("H16 延迟实发保留计划，预计按实际重算，跳过抵港时保留实际放行", () => {
  const plan = order(workspace(), "s");
  let ws = fact(plan, "s", "shipment_dispatched", day(5), 20);
  const state = Sim.simulateWorkspace(ws, { today: day(5) }).shipmentStates.s;
  assert.equal(state.overdueStage, null);
  assert.equal(state.effectiveBorderDate, day(6));
  assert.equal(state.effectiveReleaseDate, day(7));
  assert.equal(state.effectivePutawayDate, day(8));
  assert.equal(state.departPlannedDate, day(0));
  assert.equal(state.borderArrivalPlannedDate, day(1));
  assert.equal(state.marketStockAvailablePlannedDate, day(3));
  assert.equal(ws.shipments.s.milestones.borderArrivalPlannedDate, day(1));
  ws = fact(ws, "s", "customs_release", day(5));
  const released = Sim.simulateWorkspace(ws, { today: day(6) }).shipmentStates.s;
  assert.equal(released.borderArrivalActualDate, null);
  assert.equal(released.effectiveReleaseDate, day(5));
  assert.equal(released.estimatedPutawayDate, day(6));
  assert.equal(released.overdueStage, null);
  assert.equal(released.progressStatus, "in_customs");
});

test("M9 主壳仅统计实际等待放行，同日上架仍待次日可售", () => {
  const today = TS.todayLocalIso();
  let ws = order(WM.createBlankWorkspace(null, today), "s", {
    departDate: today, transitDays: 0, customsWaitDays: 0, putawayDays: 0, status: "confirmed"
  });
  ws.nodes[source].initialInventory = 100;
  ws = fact(ws, "s", "border_arrival", today);
  assert.equal(Snapshot.readBusinessSnapshot(store(ws)).sales.customsHoldCount, 1);
  ws = fact(ws, "s", "market_stock_available", today);
  const { sales } = Snapshot.readBusinessSnapshot(store(ws));
  assert.equal(sales.customsHoldCount, 0);
  assert.deepEqual(sales.kpis, Sim.simulateWorkspace(ws, { today }).kpis);
  assert.equal(sales.kpis.shelvedPendingNextDay, 20);
});

test("M27 发运阻断无物流逾期，不进入预计补货，计划发运独立展示", () => {
  let ws = order(workspace(0), "blocked");
  ws = order(ws, "later", { departDate: day(10) });
  const sim = Sim.simulateWorkspace(ws, { today: day(5) });
  assert.equal(sim.shipmentStates.blocked.progressStatus, "blocked");
  assert.equal(sim.shipmentStates.blocked.overdueStage, null);
  assert.ok(sim.exceptions.some(e => e.target.id === "blocked" && e.kind === "INSUFFICIENT_INVENTORY"));
  assert.ok(!sim.exceptions.some(e => e.target.id === "blocked" && e.kind === "overdue"));
  assert.equal(sim.marketSummaries[market].incomingQty, 0);
  const marketHtml = render(ws, sim, "market")("market-risk");
  assert.doesNotMatch(marketHtml, /shipment:blocked|shipment:later/);
});

test("M28 期初库存涵盖已完成历史，历史在途延续，未确认旧计划不会造货", () => {
  let ws = order(workspace(0), "unknown", { departDate: day(-2), transitDays: 3 });
  ws = order(ws, "pipeline", { departDate: day(-2), transitDays: 3, status: "confirmed" });
  ws = order(ws, "completed", { departDate: day(-5), status: "confirmed" });
  ws = fact(ws, "completed", "market_stock_available", day(-2));
  ws = order(ws, "locked", { departDate: day(-4), status: "confirmed" });
  ws = fact(ws, "locked", "market_stock_available", day(-1));
  ws.nodes[market].initialInventory = 20;
  const sim = Sim.simulateWorkspace(ws, { today: day(0) });
  assert.equal(sim.shipmentStates.unknown.executed, false);
  assert.equal(sim.shipmentStates.unknown.overdueStage, null);
  assert.equal(sim.kpis.currentInTransit, 20);
  assert.equal(sim.nodeDaily[source][sim.todayIdx].dispatches, 0);
  assert.equal(sim.nodeDaily[market][sim.todayIdx].arrivals, 20);
  assert.equal(sim.marketSummaries[market].currentAvailable, 40);
  assert.equal(sim.marketSummaries[market].incomingQty, 20);
});

test("M28 错序计划已由输入层拦截，保留前一阶段校验", () => {
  const ws = workspace();
  const result = Act.dispatchAction(ws, Act.createAction(ws, "shipment.create", "", {
    fromNodeId: source, toNodeId: market, departDate: day(0), qty: 20,
    marketStockAvailablePlannedDate: day(-1)
  }));
  assert.equal(result.ok, false);
  assert.equal(Object.keys(result.workspace.shipments).length, 0);
});

test("H23 多工厂同一市场，Sales 与 AI 共用路线过滤后的实时统计", () => {
  let ws = workspace();
  ws.nodes.src_b = { ...ws.nodes[source], id: "src_b", bomFactoryId: null, name: "备用工厂" };
  ws.nodes[market].initialInventory = 500;
  ws = order(ws, "a", { status: "confirmed", qty: 20 });
  ws = order(ws, "b", { fromNodeId: "src_b", status: "confirmed", qty: 40 });
  const sim = Sim.simulateWorkspace(ws, { today: day(0) });
  assert.equal(sim.kpis.currentInTransit, 60);
  const html = render(ws, sim, "dashboard", { dashFactory: source })("dash-kpis");
  assert.match(html, /In Transit<\/span>\s*<div class="kpi-value">20 /);
  const ai = query(ws, "query_world_state", {
    asOfDate: day(0), factoryId: source, sections: ["kpis", "markets", "shipments"]
  });
  assert.equal(ai.ok, true, ai.error);
  assert.equal(ai.data.kpis.currentInTransit, 20);
  assert.equal(ai.data.kpis.currentAvailableInventory, 80);
  assert.equal(ai.data.markets[0].incomingQty, 20);
  assert.equal(ai.data.shipments.length, 1);
});

test("M13 AI 曲线自然日双端包含，拒绝倒序与无效日期", () => {
  const ws = workspace();
  ws.curves.crv_mkt_dem.points.forEach(p => { p.rate = 10; });
  ws.curves.crv_mkt_dem.importedDailyActuals = [{ date: day(1), qty: 25 }];
  const args = { entity: "curves", curveKind: "demand", fromDate: day(1), aggregate: true };
  const single = query(ws, "query_sales", { ...args, toDate: day(1) });
  assert.equal(single.ok, true, single.error);
  assert.equal(single.data.items[0].rangeDays, 1);
  assert.equal(single.data.aggregation.totalIntegratedQty, 25);
  const multi = query(ws, "query_sales", { ...args, toDate: day(3) });
  assert.equal(multi.data.items[0].rangeDays, 3);
  assert.equal(multi.data.aggregation.totalIntegratedQty, 45);
  for (const toDate of [day(0), "2026-02-31"]) {
    assert.equal(query(ws, "query_sales", { ...args, toDate }).ok, false);
  }
});

test("M17 AI 聚合采用批次曲线积分和正式完工数量，分页不影响总量", () => {
  let ws = workspace();
  ws.curves.crv_src_prod.points.forEach(p => { p.rate = 10; });
  ws = apply(ws, "batch.createFromInterval", source, { batchId: "bat1", startDate: day(0), endDate: day(3) });
  ws = apply(ws, "batch.createFromInterval", source, { batchId: "bat2", startDate: day(4), endDate: day(6) });
  ws = fact(ws, "bat2", "production_confirmed", day(6), 14);
  const official = Sim.simulateWorkspace(ws, { today: day(0) });
  const res = query(ws, "query_sales", { entity: "batches", aggregate: true, limit: 1 });
  assert.equal(res.ok, true, res.error);
  assert.equal(res.data.items.length, 1);
  assert.equal(res.data.aggregation.totalMatched, 2);
  assert.equal(res.data.aggregation.totalQty, Object.values(official.batchStates).reduce((n, b) => n + b.computedQty, 0));
});

test("C3 盘点继续在当日发运和需求之后结算", () => {
  let ws = order(workspace(), "s", { qty: 80 });
  ws.nodes[market].initialInventory = 100;
  ws.curves.crv_mkt_dem.points.forEach(p => { p.rate = 10; });
  ws = fact(ws, source, "inventory_stocktake", day(0), 20);
  ws = fact(ws, market, "inventory_stocktake", day(0), 95);
  const sim = Sim.simulateWorkspace(ws, { today: day(0) });
  const src = sim.nodeDaily[source][sim.todayIdx];
  const mkt = sim.nodeDaily[market][sim.todayIdx];
  assert.deepEqual([src.dispatches, src.endingAvailable, src.adjustments], [80, 20, 0]);
  assert.deepEqual([mkt.satisfiedDemand, mkt.endingAvailable, mkt.adjustments], [10, 95, 5]);
});

test("H15 昨日上架的 20 件已进入今日可售，补货量同时归零", () => {
  let ws = order(workspace(), "yesterday", { status: "confirmed", transitDays: 0, customsWaitDays: 0, putawayDays: 0 });
  ws = fact(ws, "yesterday", "market_stock_available", day(0));
  const sim = Sim.simulateWorkspace(ws, { today: day(1) });
  assert.equal(sim.marketSummaries[market].currentAvailable, 20);
  assert.equal(sim.marketSummaries[market].incomingQty, 0);
  assert.equal(sim.kpis.currentInTransit, 0);
});

test("H16 直接确认放行后不再催抵港，已确认日期始终优先", () => {
  let ws = order(workspace(), "skip", { status: "confirmed", transitDays: 4, putawayDays: 3 });
  ws = fact(ws, "skip", "customs_release", day(2));
  const sim = Sim.simulateWorkspace(ws, { today: day(5) });
  const state = sim.shipmentStates.skip;
  assert.equal(state.borderArrivalActualDate, null);
  assert.equal(state.effectiveReleaseDate, day(2));
  assert.equal(state.overdueStage, null);
  assert.equal(state.operationalStatus, "in_customs");
  assert.equal(sim.kpis.awaitingCustoms, 20);
  assert.ok(!sim.exceptions.some(e => e.target.id === "skip" && e.kind === "overdue"));
});

test("M27 库存校验通过的推演发运进入预测补货，实际物流筛选及预警保持事实口径", () => {
  let ws = order(workspace(), "projected", { qty: 25 });
  ws = order(ws, "blocked", { qty: 120 });
  const today = day(6);
  const sim = Sim.simulateWorkspace(ws, { today });
  assert.equal(sim.kpis.currentAvailableInventory, 75);
  assert.equal(sim.kpis.projectedInPipeline, 25);
  assert.equal(sim.kpis.currentInTransit, 0);
  assert.equal(sim.shipmentStates.projected.operationalStatus, "dispatch_unconfirmed");
  assert.equal(sim.shipmentStates.projected.operationalOverdue, false);
  assert.equal(sim.kpis.next7DaysExpectedArrivals, 25);
  assert.deepEqual(Sim.queryShipments(ws, sim, { status: "in_transit" }), []);
  assert.deepEqual(Sim.queryShipments(ws, sim, { status: "overdue" }), []);
  assert.deepEqual(Sim.queryShipments(ws, sim, { status: "blocked" }).map(s => s.id), ["blocked"]);
  assert.match(render(ws, sim, "market")("market-risk"), /shipment:projected"[^>]*>(?:(?!<\/button>)[\s\S])*?Dispatch Due/);
  const res = query(ws, "query_world_state", { asOfDate: today, overdueOnly: true, sections: ["shipments"] });
  assert.equal(res.ok, true, res.error);
  assert.equal(res.data.shipments.length, 0);
});

test("看板、主壳及 AI 使用同一时点汇总，等待放行笔数与总待处理货量各自保留", () => {
  const today = TS.todayLocalIso();
  let ws = WM.createBlankWorkspace(null, today);
  ws.nodes[source].initialInventory = 100;
  const options = { departDate: today, transitDays: 0, status: "confirmed" };
  ws = order(ws, "waiting", { ...options, qty: 11 });
  ws = fact(ws, "waiting", "border_arrival", today);
  ws = order(ws, "released", { ...options, qty: 13 });
  ws = fact(ws, "released", "customs_release", today);
  ws = order(ws, "shelved", { ...options, qty: 17 });
  ws = fact(ws, "shelved", "market_stock_available", today);
  const sim = Sim.simulateWorkspace(ws, { today });
  const snap = Snapshot.readBusinessSnapshot(store(ws)).sales;
  const ai = query(ws, "query_world_state", { asOfDate: today, sections: ["kpis", "corridors"] });
  assert.equal(ai.ok, true, ai.error);
  assert.equal(snap.customsHoldCount, 1);
  assert.equal(snap.asOfDate, today);
  assert.equal(ai.data.corridors[0].customsQty, 24);
  const html = render(ws, sim, "dashboard")("dash-kpis");
  assert.match(html, /Customs \/ Putaway<\/span>\s*<div class="kpi-value">24 /);
  assert.match(html, /Shelved · Sellable Next Day<\/span>\s*<div class="kpi-value">17 /);
  const logistics = render(ws, sim, "logistics", { logiFilter: { status: "customs", elapsedMin: "", elapsedMax: "" } });
  assert.match(logistics("logi-nav"), /Customs \/ Putaway 24/);
  assert.match(logistics("logi-table"), /shipment:waiting/);
  assert.match(logistics("logi-table"), /shipment:released/);
  assert.doesNotMatch(logistics("logi-table"), /shipment:shelved/);
  for (const key of Object.keys(ai.data.kpis)) {
    assert.equal(ai.data.kpis[key], sim.kpis[key], key);
    assert.equal(snap.kpis[key], sim.kpis[key], key);
  }
});

test("路线和产品筛选保留有凭据的在途量，混合 SKU 的仓点余额不分摊", () => {
  let ws = workspace();
  const sku = ws.activeProductId;
  ws.products.other = { ...ws.products[sku], productId: "other", skuCode: "other" };
  ws.nodes.src_b = { ...ws.nodes[source], id: "src_b", bomFactoryId: null };
  ws.nodes.mkt_b = { ...ws.nodes[market], id: "mkt_b", initialInventory: 90 };
  ws = order(ws, "a", { status: "confirmed", qty: 20 });
  ws = order(ws, "b", { fromNodeId: "src_b", productId: "other", status: "confirmed", qty: 30 });
  ws = order(ws, "different-market", { toNodeId: "mkt_b", status: "confirmed", qty: 40 });
  const sim = Sim.simulateWorkspace(ws, { today: day(0) });
  const filtered = Sim.summarizeDashboard(ws, sim, { factoryId: source, marketId: market, productId: sku });
  assert.equal(filtered.kpis.currentAvailableInventory, null);
  assert.equal(filtered.kpis.currentInTransit, 20);
  assert.equal(filtered.markets[0].incomingQty, 20);
  const ai = query(ws, "query_world_state", {
    asOfDate: day(0), factoryId: source, marketId: market, productId: sku, includeDailySeries: true,
    sections: ["kpis", "corridors", "factories"]
  });
  assert.equal(ai.ok, true, ai.error);
  assert.equal(ai.data.kpis.currentAvailableInventory ?? null, null);
  assert.equal(ai.data.kpis.currentInTransit, 20);
  assert.equal(ai.data.corridors.length, 1);
  assert.equal(ai.data.corridors[0].inTransitQty, 20);
  assert.equal(ai.data.factories[0].dispatchesInWindow, 20);
  assert.equal(ai.data.dailySeries.points[0].inTransitInbound, 20);
  const raw = query(ws, "query_sales", {
    entity: "shipments", productId: "other", fromDate: day(0), toDate: day(0), aggregate: true
  });
  assert.equal(raw.ok, true, raw.error);
  assert.equal(raw.data.aggregation.totalQty, 30);
});

test("实绩产量更正与计划曲线独立，批次释放清理自身的生产待释放量", () => {
  let ws = workspace(0);
  ws.curves.crv_src_prod.points.forEach(p => { p.rate = 10; });
  ws = apply(ws, "batch.createFromInterval", source, {
    batchId: "smaller", startDate: day(0), endDate: day(3), extraWaitDays: 5
  });
  ws = apply(ws, "batch.createFromInterval", source, {
    batchId: "second", startDate: day(3), endDate: day(5), extraWaitDays: 0
  });
  ws = fact(ws, "smaller", "production_confirmed", day(3), 12);
  const sim = Sim.simulateWorkspace(ws, { today: day(0) });
  const rows = sim.nodeDaily[source];
  assert.equal(rows[4].unreleasedProductionAccum, 50);
  assert.equal(rows[5].unreleasedProductionAccum, 30);
  assert.equal(rows[8].unreleasedProductionAccum, 0);
  assert.equal(rows[8].releasedProduction, 22);

  const legacy = structuredClone(ws);
  legacy.batches.smaller.qtyOverride = null;
  const aggregate = query(legacy, "query_sales", { entity: "batches", aggregate: true });
  assert.equal(aggregate.ok, true, aggregate.error);
  assert.equal(aggregate.data.aggregation.totalQty, 32);
});

test("锚点前的查询保留缺历史数据提示，锚点余额只在锚定日生效", () => {
  let ws = workspace();
  ws.nodes[market].initialInventory = 50;
  ws.curves.crv_mkt_dem.points.forEach(p => { p.rate = 10; });
  ws = fact(ws, market, "inventory_stocktake", day(-1), 300);
  const sim = Sim.simulateWorkspace(ws, { today: day(-1) });
  assert.equal(sim.kpis.currentAvailableInventory, null);
  assert.equal(sim.marketSummaries[market].firstGapDate, day(5));
  assert.equal(sim.nodeDaily[market][0].endingAvailable, 0);
  assert.equal(sim.nodeDaily[market][1].endingAvailable, 40);
  const ai = query(ws, "query_world_state", { asOfDate: day(-1) });
  assert.match(ai.meta.historicalReplayCaveat, /缺少该历史时点快照/);
});

test("预测补货使用视窗末日作为可售上限，7 日预计上架单独按上架日统计", () => {
  let ws = order(workspace(), "boundary", { departDate: day(5), transitDays: 0, customsWaitDays: 0, putawayDays: 0 });
  ws = order(ws, "later-sellable", { departDate: day(7), transitDays: 0, customsWaitDays: 0, putawayDays: 0 });
  const sim = Sim.simulateWorkspace(ws, { today: day(0), viewHorizonDays: 7 });
  assert.equal(sim.viewEndDate, day(6));
  assert.equal(sim.marketSummaries[market].incomingQty, 20);
  assert.equal(sim.kpis.next7DaysExpectedArrivals, 40);
  const ai = query(ws, "query_world_state", { asOfDate: day(0), horizonDays: 7, sections: ["kpis", "markets"] });
  assert.equal(ai.ok, true, ai.error);
  assert.equal(ai.data.markets[0].incomingQty, 20);
  assert.equal(ai.data.kpis.next7DaysExpectedArrivals, 40);
});

test("已知实发之后的显式预计可覆盖推演，原计划与实际字段完整保留", () => {
  let ws = order(workspace(), "revised");
  ws = fact(ws, "revised", "shipment_dispatched", day(4), 20);
  ws.facts[0].recordedAt = 1;
  ws = apply(ws, "shipment.update", "revised", {
    borderArrivalPlannedDate: day(7),
    customsReleasePlannedDate: day(8),
    marketStockAvailablePlannedDate: day(10)
  });
  const actual = Sim.simulateWorkspace(ws, { today: day(4) }).shipmentStates.revised;
  assert.equal(actual.departPlannedDate, day(0));
  assert.equal(actual.departActualDate, day(4));
  assert.equal(actual.originalPlan.departDate, day(0));
  assert.equal(actual.originalPlan.borderArrivalPlannedDate, day(1));
  assert.equal(actual.estimatedBorderDate, day(7));
  assert.equal(actual.estimatedPutawayDate, day(10));
});
