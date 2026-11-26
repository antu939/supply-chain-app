"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const TS = require("../modules/sales/js/timeseries.js");
const WM = require("../modules/sales/js/world-model.js");
const Sim = require("../modules/sales/js/sim-engine.js");
const Act = require("../modules/sales/js/actions.js");
const AI = require("../shared/ai-mutations.js");

const today = "2026-11-12";
const newWorkspace = () => WM.createBlankWorkspace(null, today);
const apply = (ws, type, id, payload, options = { today }) =>
  Act.applyActions(ws, Act.createAction(ws, type, id, payload), options);
const shipment = { shipmentId: "shp", fromNodeId: "src_main", toNodeId: "mkt_main", qty: 5, departDate: today };
const batch = { batchId: "bat", startDate: "2026-11-12", endDate: "2026-11-13" };

function reject(ws, type, id, payload, options) {
  const before = JSON.stringify(ws);
  const result = apply(ws, type, id, payload, options);
  assert.equal(result.ok, false, `${type} ${JSON.stringify(payload)}`);
  assert.equal(result.workspace, ws);
  assert.equal(JSON.stringify(ws), before);
}

test("Action 拒绝非数字、非有限、超精度范围及空数量", () => {
  for (const value of [NaN, Infinity, -Infinity, "abc", 1e30, "", " ", null, undefined, "1,000", "0x10", false, -1]) {
    reject(newWorkspace(), "inventory.initialize", "src_main", { initialInventory: value });
  }
  const ws = newWorkspace();
  reject(ws, "node.update", "src_main", { initialInventory: "invalid" });
  reject(ws, "timeseries.point.add", "crv_src_prod", { date: today, rate: -1 });
  reject(ws, "batch.createFromInterval", "src_main", { ...batch, qtyOverride: "N/A" });
  reject(ws, "shipment.create", "", { ...shipment, qty: 0.0000001 });
});

test("明确零、缺省值与可清空的批次数量，合法值跨保存与导入保持一致", () => {
  const ws = newWorkspace();
  const actions = [
    ["inventory.initialize", "src_main", { initialInventory: "0" }],
    ["timeseries.point.add", "crv_mkt_dem", { date: today, rate: "0" }],
    ["workspace.settings.update", "", { unitManufacturingCost: 0, viewHorizonDays: 180 }],
    ["batch.createFromInterval", "src_main", { ...batch, qtyOverride: null }],
    ["shipment.create", "", { ...shipment, transitDays: 0, customsWaitDays: 0, putawayDays: 0 }]
  ].map(x => Act.createAction(ws, ...x));
  const result = Act.applyActions(ws, actions, { today });
  assert.ok(result.ok, JSON.stringify(result.errors));
  const restored = WM.validateWorkspace(JSON.parse(JSON.stringify(result.workspace)));
  assert.deepEqual(JSON.parse(JSON.stringify(restored)), JSON.parse(JSON.stringify(result.workspace)));
  assert.equal(restored.products[restored.activeProductId].unitManufacturingCost, 0);
  assert.equal(restored.nodes.src_main.initialInventory, 0);
  assert.equal(restored.curves.crv_mkt_dem.points.find(p => p.date === today).rate, 0);
  assert.equal(restored.batches.bat.qtyOverride, null);
  assert.equal(restored.shipments.shp.milestones.marketStockAvailablePlannedDate, today);
});

test("严格自然日、闰年、运算溢出与模拟视窗", () => {
  assert.equal(TS.parseIsoDateUtc("2025-02-29"), null);
  assert.equal(TS.parseIsoDateUtc(" 2024-02-29 "), null);
  assert.notEqual(TS.parseIsoDateUtc("2024-02-29"), null);
  assert.equal(TS.addDaysToIso("2024-02-28", 1), "2024-02-29");
  for (const [date, days] of [["2025-02-29", 1], ["9999-12-31", 1], [today, Infinity], [today, 0.5]]) {
    assert.throws(() => TS.addDaysToIso(date, days));
  }
  const ws = newWorkspace();
  for (const options of [{ today: "2026-02-30" }, { viewHorizonDays: NaN }, { viewHorizonDays: 181 }, { viewHorizonDays: 7.5 }, { today: "9999-12-31" }]) {
    assert.throws(() => Sim.simulateWorkspace(ws, options));
    reject(ws, "node.update", "src_main", { note: "bad options" }, options);
  }
  reject(ws, "batch.createFromInterval", "src_main", { ...batch, endDate: "9999-12-31", extraWaitDays: 1 });
});

test("发运计划必须顺序正确，实际日期早晚独立于历史计划", () => {
  const ws = newWorkspace();
  reject(ws, "shipment.create", "", { ...shipment, borderArrivalPlannedDate: "2026-11-11" });
  const result = apply(ws, "shipment.create", "", shipment);
  assert.ok(result.ok);
  reject(result.workspace, "shipment.update", "shp", { borderArrivalPlannedDate: "2026-11-31" });
  reject(result.workspace, "shipment.update", "shp", { customsReleasePlannedDate: "2026-11-13" });
  const actual = apply(result.workspace, "event.record", "shp", { kind: "shipment_dispatched", date: "2026-12-12" });
  assert.ok(actual.ok, JSON.stringify(actual.errors));
  const saved = WM.validateWorkspace(JSON.parse(JSON.stringify(actual.workspace)));
  assert.equal(saved.shipments.shp.milestones.departActualDate, "2026-12-12");
  assert.equal(saved.shipments.shp.milestones.borderArrivalPlannedDate, result.workspace.shipments.shp.milestones.borderArrivalPlannedDate);
});

test("CSV 空白走模版继承，显式零保留，坏行使整批失败", () => {
  const header = "from,to,depart_date,qty,transit_days,unit_cost";
  const row = "src_main,mkt_main,2026-11-12";
  let ws = newWorkspace();
  const lane = apply(ws, "lane.save", "", { fromNodeId: "src_main", toNodeId: "mkt_main", defaultTransitDays: 8, defaultUnitCost: 2 });
  assert.ok(lane.ok);
  ws = lane.workspace;
  const res = apply(ws, "shipment.batchImport", "", { csvText: `${header}\n${row},5,,\n${row},6,0,0` });
  assert.ok(res.ok, JSON.stringify(res.errors));
  assert.deepEqual(Object.values(res.workspace.shipments).map(s => [s.transitDays, s.unitCost]), [[8, 2], [0, 0]]);
  for (const bad of [`${row},6,no,0`, `${row},"1,000",0,0`, `${row},1,000,0,0`]) {
    reject(ws, "shipment.batchImport", "", { csvText: `${header}\n${row},5,0,0\n${bad}` });
  }
  for (const qty of ["", " ", '"1,000"', "1,000"]) {
    assert.equal(TS.parseDailyCsv(`date,sku,qty\n${today},sku,${qty}`).ok, false);
  }
  assert.equal(TS.parseDailyCsv(`date,sku,qty\n${today},sku,0`).records[0].qty, 0);
});

test("JSON 导入在克隆、默认值和事实投影前拒绝非法值", () => {
  for (const value of [NaN, Infinity, "abc", 1e30, "", " ", null, "0"]) {
    const ws = newWorkspace();
    ws.nodes.src_main.initialInventory = value;
    assert.throws(() => WM.validateWorkspace(ws), /initialInventory/);
  }
  const ws = newWorkspace();
  ws.inventoryAnchorDate = "2026-02-30";
  assert.throws(() => WM.validateWorkspace(ws), /inventoryAnchorDate/);
  const badFact = newWorkspace();
  badFact.facts.push({ eventId: "bad", kind: "inventory_stocktake", date: today, targetId: "src_main", qty: null });
  assert.throws(() => WM.validateWorkspace(badFact), /qty/);
});

test("同一发运天数在 Action 与 AI 写入均拒绝非法值，持久化不变", () => {
  const ws = apply(newWorkspace(), "shipment.create", "", shipment).workspace;
  const entries = new Map([[WM.WORLD_STORAGE_KEY, JSON.stringify(ws)]]);
  const storage = { getItem: key => entries.get(key) ?? null, setItem: (key, value) => entries.set(key, value) };
  const ai = AI.createWriteController({ storage });
  ai.grantAuthorization({ workspaceId: ws.workspaceId, allowedOperations: ["shipment.update_schedule"] });
  const before = storage.getItem(WM.WORLD_STORAGE_KEY);
  for (const transitDays of [" ", null, 1.5, NaN, Infinity, "abc", 1e12]) {
    const result = ai.executeAuthorizedMutation({ operation: "shipment.update_schedule", shipmentId: "shp", transitDays });
    assert.equal(result.ok, false, String(transitDays));
    assert.equal(storage.getItem(WM.WORLD_STORAGE_KEY), before);
    reject(ws, "shipment.update", "shp", { transitDays });
  }
});

test("V1 迁移保留零时长、零成本及小数，拒绝旧记录的坏数量与日期偏移", () => {
  const v1 = {
    format: "sc-sales-world", version: 1, startDate: "2024-02-28",
    products: { sku: { productId: "sku", unitManufacturingCost: 0 } },
    scenarios: { BASE: {
      nodes: { s: { kind: "source", initialInventory: 0 }, m: { kind: "market", initialInventory: 0 } },
      routes: { r: { fromNodeId: "s", toNodeId: "m", transitDays: 0, customsWaitDays: 0, putawayDays: 0 } },
      shipments: { x: { fromNodeId: "s", toNodeId: "m", routeId: "r", departDay: 1, qty: 0.5 } },
      curves: { d: { targetNodeId: "m", kind: "demand", points: [{ day: 1, rate: 0 }] } }
    } }
  };
  const migrated = WM.validateWorkspace(v1);
  assert.equal(migrated.shipments.x.qty, 0.5);
  assert.equal(migrated.lanes.r.defaultTransitDays, 0);
  assert.equal(migrated.shipments.x.milestones.marketStockAvailablePlannedDate, "2024-02-29");
  assert.equal(migrated.products.sku.unitManufacturingCost, 0);
  assert.deepEqual(WM.validateWorkspace(JSON.parse(JSON.stringify(migrated))), migrated);
  for (const shipmentOverrides of [{ qty: "N/A" }, { qty: null }, { departDay: 0.5 }, { departDay: 1e12 }]) {
    const bad = structuredClone(v1);
    Object.assign(bad.scenarios.BASE.shipments.x, shipmentOverrides);
    const before = JSON.stringify(bad);
    assert.throws(() => WM.validateWorkspace(bad));
    assert.equal(JSON.stringify(bad), before);
  }
});

test("区间、形态与事实经解析或导入失败后保持整批原子性", () => {
  const ws = newWorkspace();
  const bat = apply(ws, "batch.createFromInterval", "src_main", batch).workspace;
  for (const value of ["1,000", "1e-999", false, -1, null, Infinity]) {
    reject(bat, "event.record", "bat", { kind: "production_confirmed", qty: value, date: today });
    reject(bat, "event.record", "src_main", { kind: "inventory_stocktake", qty: value, date: today });
  }
  reject(bat, "batch.update", "bat", { endDate: "2026-12-32" });
  reject(bat, "timeseries.segment.setMode", "crv_src_prod", {
    ...batch, startDate: today, mode: "total", distribution: "custom", shapeAnchors: [{ t: 2, weight: 1 }]
  });
  const invalid = structuredClone(bat);
  invalid.batches.overlap = { ...invalid.batches.bat, id: "overlap" };
  assert.throws(() => WM.validateWorkspace(invalid), /区间不可重叠/);

  const planned = apply(bat, "shipment.create", "", shipment).workspace;
  const invalidPlan = structuredClone(planned);
  invalidPlan.shipments.shp.milestones.customsReleasePlannedDate = today;
  assert.throws(() => WM.validateWorkspace(invalidPlan), /customsReleasePlannedDate/);
  const result = Act.applyActions(planned, [
    Act.createAction(planned, "node.create", "", { kind: "source", name: "未保存", nodeId: "never-created" }),
    Act.createAction(planned, "shipment.update", "shp", { transitDays: "bad" })
  ], { today });
  assert.equal(result.ok, false);
  assert.equal(result.workspace, planned);
  assert.equal(result.workspace.nodes["never-created"], undefined);
});
