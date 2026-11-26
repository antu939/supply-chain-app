/** Targeted regression tests for bugs found in shipment cloning, facts filtering, and AI dry-run. */
"use strict";
const assert = require("node:assert/strict");
require("../modules/sales/js/timeseries.js");
const WM = require("../modules/sales/js/world-model.js");
const Act = require("../modules/sales/js/actions.js");
const Store = require("../storage/data-store.js");
const AI = require("../shared/ai-query.js");
let passed = 0;
function check(name, fn) { fn(); passed++; console.log(`✓ ${name}`); }
function dispatch(ws, type, targetId, payload) {
  const result = Act.dispatchAction(ws, Act.createAction(ws, type, targetId, payload));
  assert.equal(result.ok, true, `Action ${type} failed: ${JSON.stringify(result.errors)}`);
  return result.workspace;
}

check("复制发运单将 originMonth 改为新建月份，并保留原单的原始月份", () => {
  let ws = WM.createBlankWorkspace(null, "2026-11-24");
  ws.nodes.src = { id: "src", kind: "source", name: "一厂", initialInventory: 9999 };
  ws.nodes.dst = { id: "dst", kind: "market", name: "美国", initialInventory: 0 };
  ws = dispatch(ws, "shipment.create", "", { shipmentId: "original", fromNodeId: "src", toNodeId: "dst", departDate: "2026-10-20", qty: 10 });
  const createCollision = Act.dispatchAction(ws, Act.createAction(ws, "shipment.create", "", { shipmentId: "original", fromNodeId: "src", toNodeId: "dst", departDate: "2026-12-20", qty: 99 }));
  assert.equal(createCollision.ok, false, "creating an existing shipment ID must never overwrite it");
  ws = dispatch(ws, "shipment.duplicate", "original", { newShipmentId: "duplicate", departDate: "2026-12-20", qty: 20 });
  assert.equal(ws.shipments.original.originMonth, "2026-10");
  assert.equal(ws.shipments.duplicate.originMonth, "2026-12");
  assert.equal(ws.shipments.duplicate.qty, 20);
  const bundle = Store.exportLogicalBundle({ salesRaw: ws });
  assert.ok(bundle["sales/2026-10.json"].shipments.original);
  assert.equal(bundle["sales/2026-10.json"].shipments.duplicate, undefined);
  assert.ok(bundle["sales/2026-12.json"].shipments.duplicate);
  const newIdExists = Act.dispatchAction(ws, Act.createAction(ws, "shipment.duplicate", "original", { newShipmentId: "duplicate" }));
  assert.equal(newIdExists.ok, false, "collision must not overwrite an existing shipment");
  const invalidQty = Act.dispatchAction(ws, Act.createAction(ws, "shipment.duplicate", "original", { newShipmentId: "invalid", qty: "not-a-number" }));
  assert.equal(invalidQty.ok, false, "invalid qty must not persist as JSON null");
});

check("按工厂 / 目标市场查询事实，跨月关联批次与发运，且只读必要分区", () => {
  const ws = WM.createBlankWorkspace(null, "2026-11-24");
  ws.nodes = {
    src_a: { id: "src_a", kind: "source", name: "A 工厂" },
    src_b: { id: "src_b", kind: "source", name: "B 工厂" },
    mkt_us: { id: "mkt_us", kind: "market", name: "US" },
    mkt_eu: { id: "mkt_eu", kind: "market", name: "EU" }
  };
  ws.batches = { bat_a: { id: "bat_a", sourceNodeId: "src_a", startDate: "2026-10-25", endDate: "2026-10-27", originMonth: "2026-10" } };
  ws.shipments = {
    sh_a: { id: "sh_a", fromNodeId: "src_a", toNodeId: "mkt_us", departDate: "2026-10-26", originMonth: "2026-10" },
    sh_b: { id: "sh_b", fromNodeId: "src_b", toNodeId: "mkt_eu", departDate: "2026-10-27", originMonth: "2026-10" }
  };
  const fact = (id, date, targetId) => ({ eventId: id, date, targetId, kind: "inventory_stocktake" });
  ws.facts = [
    fact("fact_ship_a", "2026-11-09", "sh_a"),
    fact("fact_batch_a", "2026-11-10", "bat_a"),
    fact("fact_factory_a", "2026-11-11", "src_a"),
    fact("fact_ship_b", "2026-11-12", "sh_b"),
    fact("fact_market_eu", "2026-11-13", "mkt_eu"),
    fact("fact_ship_b_dec", "2026-12-01", "sh_b")
  ];
  const bundle = Store.exportLogicalBundle({ salesRaw: ws });
  const reads = [];
  const ctx = { partitionProvider: {
    readManifest: () => bundle["manifest.json"],
    readPartition: id => { reads.push(id); return bundle[id + ".json"] || null; }
  } };
  const byFactory = AI.querySales({ entity: "facts", factoryId: "src_a" }, ctx);
  assert.deepEqual(byFactory.data.map(f => f.eventId).sort(), ["fact_batch_a", "fact_factory_a", "fact_ship_a"]);
  assert.deepEqual(reads, ["sales/2026-11"], "read November only; skip unrelated October / December");
  const byOther = AI.querySales({ entity: "facts", factoryId: "src_b" }, ctx);
  assert.deepEqual(byOther.data.map(f => f.eventId).sort(), ["fact_ship_b", "fact_ship_b_dec"]);
  const byUs = AI.querySales({ entity: "facts", marketId: "mkt_us" }, ctx);
  assert.deepEqual(byUs.data.map(f => f.eventId), ["fact_ship_a"]);
  const byEu = AI.querySales({ entity: "facts", marketId: "mkt_eu" }, ctx);
  assert.deepEqual(byEu.data.map(f => f.eventId).sort(), ["fact_market_eu", "fact_ship_b", "fact_ship_b_dec"]);
  const novShipmentFacts = AI.querySales({ entity: "facts", shipmentId: "sh_b", month: "2026-11" }, ctx);
  assert.deepEqual(novShipmentFacts.data.map(f => f.eventId), ["fact_ship_b"], "shipmentId must not bypass month filter");
  // Reuse a stale cache with the same data revision: new schema must be rebuilt.
  const cache = { ...bundle["manifest.json"], version: 1, partitions: [] };
  const memory = { getItem(k) {
    if (k === Store.STORAGE_KEYS.MANIFEST) return JSON.stringify(cache);
    if (k === Store.STORAGE_KEYS.SALES) return JSON.stringify(ws);
    return null;
  }};
  const rebuilt = Store.loadManifest({ storage: memory });
  assert.equal(rebuilt.version, Store.MANIFEST_VERSION);
  assert.ok(rebuilt.partitions.length > 0, "old manifest cache must not suppress facts");
});

check("AI 预演空数据返回明确错误，不抛异常，也不读取全局 localStorage", () => {
  const emptyStore = { getItem() { return null; } };
  const empty = AI.simulateSalesActions([], { actionsEngine: Act, worldModel: WM, storage: emptyStore });
  assert.equal(empty.ok, false);
  assert.match(empty.error, /未提供销售工作区/);
  const corrupt = AI.simulateSalesActions([], { actionsEngine: Act, worldModel: WM, storage: { getItem: () => "{" } });
  assert.equal(corrupt.ok, false);
  assert.match(corrupt.error, /无法读取销售工作区/);
  const ws = WM.createBlankWorkspace(null, "2026-11-24");
  const before = JSON.stringify(ws);
  const res = AI.simulateSalesActions([], { actionsEngine: Act, worldModel: WM, storage: { getItem: () => JSON.stringify(ws) } });
  assert.equal(res.ok, true);
  assert.equal(JSON.stringify(ws), before);
});
console.log(`\nBugfix regression summary: ${passed} passed.`);
