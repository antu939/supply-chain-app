"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const today = "2026-11-12";
const dates = { today };
const copy = value => JSON.parse(JSON.stringify(value));

function fixture() {
  const listeners = {};
  const elements = new Map();
  const data = new Map();
  const document = {
    querySelectorAll: () => [],
    querySelector(selector) {
      if (!elements.has(selector)) elements.set(selector, {
        classList: { add() {}, remove() {}, toggle() {} },
        setAttribute() {}, querySelector: () => null,
        addEventListener(type, handler) { listeners[selector + ":" + type] = handler; },
        showModal() { this.open = true; }, close() { this.open = false; }
      });
      return elements.get(selector);
    },
    addEventListener: (type, fn) => { listeners[type] = fn; }
  };
  const storage = {
    getItem: key => data.get(key) ?? null,
    setItem(key, value) {
      if (storage.fail) throw new Error("storage unavailable");
      data.set(key, value);
    }
  };
  class FileReader {
    readAsText(content) {
      this.result = content;
      this.onload();
    }
  }
  const context = vm.createContext({
    document, localStorage: storage, FileReader, FormData: class { constructor(form) { return form; } },
    console, setTimeout() {}, clearTimeout() {}
  });
  function load(...files) {
    for (const file of files) {
      const filename = path.join(__dirname, "../modules/sales/js", file + ".js");
      vm.runInContext(fs.readFileSync(filename, "utf8"), context, { filename });
    }
  }
  load("timeseries", "world-model", "sim-engine", "actions", "demo-world");
  const SC = context.SC;
  SC.Views = { renderView() {} };
  SC.Inspector = { renderPanel() {} };
  const key = SC.WorldModel.WORLD_STORAGE_KEY;
  storage.setItem(key, JSON.stringify(SC.WorldModel.createBlankWorkspace(null, "2026-11-01")));
  load("app");
  const ws = () => SC.App.getWorkspace();
  const dispatch = (...args) => SC.App.dispatch(...args);
  const apply = (...args) => {
    const result = dispatch(...args);
    assert.ok(result.ok, JSON.stringify(result.errors));
    return result;
  };
  const history = (redo = false) => listeners.keydown({
    target: { matches: () => false }, ctrlKey: true, key: "z", shiftKey: redo, preventDefault() {}
  });
  function clickDataset(match, dataset) {
    listeners.click({ target: { closest: selector => selector === match ? { dataset } : null } });
  }
  function click(action) {
    clickDataset("[data-app-action]", { appAction: action });
  }
  function submit(fields) {
    listeners["#dialogForm:submit"]({ preventDefault() {}, target: { get: name => fields[name] ?? null } });
  }
  function importWorkspace(raw) {
    listeners["#importWorldInput:change"]({ target: { files: [JSON.stringify(raw)] } });
  }
  function importBom(text) {
    listeners["#importBomInput:change"]({ target: { files: [text] } });
  }
  return { SC, ws, dispatch, apply, history, storage, key, document, click, clickDataset, submit, importWorkspace, importBom, load, context };
}

function batch(f, id = "bat") {
  f.apply("batch.createFromInterval", "src_main", {
    batchId: id, startDate: "2026-11-03", endDate: "2026-11-07", qtyOverride: 100
  });
}

function shipment(f, extra) {
  f.apply("shipment.create", "", {
    shipmentId: "shp", fromNodeId: "src_main", toNodeId: "mkt_main", qty: 20, departDate: today, ...extra
  });
}

function record(f, id, kind, qty, date = today, eventId = "original") {
  return f.apply("event.record", id, { kind, qty, date, eventId });
}

function rejected(f, type, id, payload) {
  const before = copy(f.ws());
  const persisted = f.storage.getItem(f.key);
  const res = f.dispatch(type, id, payload);
  assert.equal(res.ok, false, type);
  assert.ok(res.errors[0].message);
  assert.deepEqual(copy(f.ws()), before, type);
  assert.equal(f.storage.getItem(f.key), persisted, type);
}

test("H17 完工更正逐次追加并投影实际数量与可用日期", () => {
  const f = fixture();
  batch(f);
  record(f, "bat", "production_confirmed", 80, "2026-11-07");
  const history = copy(f.ws().facts);
  f.apply("event.correct", "original", { qty: 65, date: "2026-11-08", note: "复核", eventId: "corr1" });
  f.apply("event.correct", "corr1", { qty: 0, note: "复核退回", eventId: "corr2" });
  assert.deepEqual(copy(f.ws().facts.slice(0, 1)), history);
  assert.deepEqual(copy(f.ws().facts.map(x => x.supersedesEventId)), [null, "original", "corr1"]);
  const facts = f.SC.SimEngine.getEffectiveFacts(f.ws());
  assert.equal(facts.length, 1);
  assert.equal(facts[0].qty, 0);
  assert.equal(f.ws().batches.bat.qtyOverride, 0);
  assert.equal(f.ws().batches.bat.status, "confirmed");
  assert.equal(f.ws().batches.bat.availableDate, "2026-11-08");
  const sim = f.SC.SimEngine.simulateWorkspace(f.ws(), dates);
  assert.equal(sim.batchStates.bat.computedQty, 0);
  assert.equal(sim.batchStates.bat.availableDate, "2026-11-08");
  rejected(f, "event.correct", "original", { qty: 52, note: "过时版本" });
});

test("H18 撤销和重做跨过确认与更正，持续撤销不同计划变更", () => {
  const f = fixture();
  f.apply("node.update", "mkt_main", { note: "较早变更" });
  batch(f);
  f.apply("batch.update", "bat", { code: "ACTUAL" });
  record(f, "bat", "production_confirmed", 65, "2026-11-07");
  f.apply("node.update", "src_main", { note: "较晚变更" });
  f.history();
  assert.notEqual(f.ws().nodes.src_main.note, "较晚变更");
  f.history(true);
  assert.equal(f.ws().nodes.src_main.note, "较晚变更");
  f.apply("event.correct", "original", { qty: 61, note: "查验", eventId: "corrected" });
  const facts = copy(f.ws().facts);
  const revision = f.ws().revision;
  f.history();
  f.history();
  f.history();
  assert.ok(f.ws().revision > revision);
  assert.equal(f.ws().batches.bat.status, "confirmed");
  assert.equal(f.ws().batches.bat.qtyOverride, 61);
  assert.equal(f.ws().batches.bat.code, "ACTUAL");
  assert.notEqual(f.ws().nodes.mkt_main.note, "较早变更");
  assert.deepEqual(copy(f.ws().facts), facts);
  f.history(true);
  f.history(true);
  assert.equal(f.ws().nodes.src_main.note, "较晚变更");
  assert.equal(f.ws().nodes.mkt_main.note, "较早变更");
  assert.deepEqual(copy(f.ws().facts), facts);
});

test("H20 阻止删除事实目标及其依赖，历史发运不可取消或改量", () => {
  const f = fixture();
  batch(f);
  shipment(f, { batchId: "bat" });
  record(f, "shp", "border_arrival", 20);
  record(f, "bat", "production_confirmed", 70, "2026-11-07", "production");
  f.apply("node.create", "", { nodeId: "stock", name: "历史市场", kind: "market" });
  record(f, "stock", "inventory_stocktake", 120, today, "inventory");
  rejected(f, "node.delete", "src_main");
  rejected(f, "node.delete", "mkt_main");
  rejected(f, "node.delete", "stock");
  rejected(f, "batch.delete", "bat");
  rejected(f, "shipment.cancel", "shp");
  rejected(f, "shipment.update", "shp", { qty: 25 });
  f.apply("shipment.update", "shp", { trackingNumber: "receipt" });
});

test("工厂仅通过完工事实受保护，兼容只有已确认标记的旧批次", () => {
  const f = fixture();
  batch(f);
  record(f, "bat", "production_confirmed", 60);
  rejected(f, "node.delete", "src_main");
  const legacy = copy(f.ws());
  legacy.facts = [];
  legacy.batches.bat.qtyOverride = null;
  legacy.curves.crv_src_prod.points.forEach(point => { point.rate = 20; });
  f.storage.setItem(f.key, JSON.stringify(legacy));
  f.SC.AppBridge.reloadFromStorage();
  assert.equal(f.ws().batches.bat.qtyOverride, 80);
  rejected(f, "node.delete", "src_main");
  f.apply("timeseries.point.move", "crv_src_prod", { pointId: "pt_0", rate: 100 });
  assert.equal(f.SC.SimEngine.simulateWorkspace(f.ws(), dates).batchStates.bat.computedQty, 80);
});

test("允许删除普通计划和清理其已取消发运，引用保持完整", () => {
  const f = fixture();
  batch(f);
  shipment(f, { batchId: "bat" });
  f.apply("shipment.cancel", "shp");
  f.apply("batch.delete", "bat");
  assert.equal(f.ws().shipments.shp.batchId, null);
  f.apply("node.delete", "mkt_main");
  assert.equal(f.ws().nodes.mkt_main, undefined);
  assert.equal(f.ws().shipments.shp, undefined);
  assert.equal(f.ws().curves.crv_mkt_dem, undefined);
  f.history();
  assert.ok(f.ws().nodes.mkt_main && f.ws().shipments.shp);
  f.history(true);
  assert.equal(f.ws().shipments.shp, undefined);
});

test("拒绝孤立事实、重复确认和实体 ID 覆盖，批量预演失败保持原状", () => {
  const f = fixture();
  batch(f);
  record(f, "bat", "production_confirmed", 71);
  rejected(f, "event.record", "missing", { kind: "production_confirmed", date: today, qty: 15 });
  rejected(f, "event.record", "bat", { kind: "production_confirmed", date: today, qty: 15 });
  rejected(f, "event.record", "bat", { kind: "inventory_stocktake", date: today, qty: 15 });
  rejected(f, "event.correct", "original", { qty: "", note: "无效" });
  rejected(f, "event.correct", "original", { qty: "1,000", note: "无效" });
  rejected(f, "event.correct", "original", { qty: 1e308, note: "无效" });
  rejected(f, "event.correct", "original", { qty: 50, note: "重复 ID", eventId: "original" });
  rejected(f, "node.create", "", { nodeId: "src_main", kind: "market", name: "overwrite" });
  rejected(f, "batch.createFromInterval", "src_main", {
    batchId: "bat", startDate: "2026-11-20", endDate: "2026-11-21"
  });
  const before = copy(f.ws());
  const actions = [
    f.SC.Actions.createAction(f.ws(), "node.update", "mkt_main", { note: "不得提交" }),
    f.SC.Actions.createAction(f.ws(), "node.delete", "src_main", {})
  ];
  const res = f.SC.Actions.applyActions(f.ws(), actions, dates);
  assert.equal(res.ok, false);
  assert.deepEqual(copy(res.workspace), before);
});

test("保存和重载修正旧投影，拒绝落盘失败和过时页面写入", () => {
  const f = fixture();
  batch(f);
  record(f, "bat", "production_confirmed", 81);
  f.apply("event.correct", "original", { qty: 68, note: "修正", eventId: "corr" });
  const persisted = f.storage.getItem(f.key);
  const stale = JSON.parse(persisted);
  stale.batches.bat.status = "planned";
  stale.batches.bat.qtyOverride = 100;
  f.storage.setItem(f.key, JSON.stringify(stale));
  rejected(f, "node.update", "mkt_main", { note: "来自旧页面" });
  f.SC.AppBridge.reloadFromStorage();
  assert.equal(f.ws().batches.bat.status, "confirmed");
  assert.equal(f.ws().batches.bat.qtyOverride, 68);
  f.storage.fail = true;
  rejected(f, "event.correct", "corr", { qty: 60, note: "保存失败" });
  f.storage.fail = false;
  f.apply("node.update", "mkt_main", { note: "触发正常保存" });
  f.SC.AppBridge.reloadFromStorage();
  assert.equal(f.ws().batches.bat.qtyOverride, 68);
  assert.equal(f.SC.App.queryWorldState().batches.bat.computedQty, 68);
  assert.deepEqual(copy(f.ws().facts), stale.facts);
});

test("发运实绩优先于计划库存，数量更正后仍守恒并明确显示差额", () => {
  const f = fixture();
  batch(f);
  shipment(f, { batchId: "bat" });
  record(f, "shp", "shipment_dispatched", 20);
  record(f, "bat", "production_confirmed", 12, "2026-11-07", "actual-production");
  f.apply("event.correct", "original", { qty: 30, note: "复核实际装船量", eventId: "actual-shipment" });
  const sim = f.SC.SimEngine.simulateWorkspace(f.ws(), dates);
  assert.equal(f.ws().shipments.shp.qty, 30);
  assert.equal(sim.shipmentStates.shp.executedQty, 30);
  assert.equal(sim.batchStates.bat.actualDispatchedQty, 30);
  assert.ok(sim.conflicts.some(conflict => conflict.targetId === "shp" && conflict.shortfall === 18));
  const day = sim.nodeDaily.src_main[sim.todayIdx];
  assert.equal(day.dispatches, 30);
  assert.equal(day.adjustments, 18);
  assert.equal(day.conservationDelta, 0);
});

test("跳过抵港的清关实绩仍进入模拟，冲突的正式日期拒绝保存", () => {
  const f = fixture();
  shipment(f, { departDate: "2026-11-17" });
  record(f, "shp", "customs_release", 20);
  f.apply("event.correct", "original", { date: "2026-11-11", note: "单据回执", eventId: "release" });
  rejected(f, "event.record", "shp", { kind: "border_arrival", date: today, qty: 20 });
  const sim = f.SC.SimEngine.simulateWorkspace(f.ws(), dates);
  const state = sim.shipmentStates.shp;
  assert.equal(state.departActualDate, null);
  assert.equal(state.customsReleaseActualDate, "2026-11-11");
  assert.equal(state.effectiveReleaseDate, "2026-11-11");
  assert.equal(state.executedQty, 20);
});

test("盘点更正仍在日终结算，移日后旧的重复盘点不会重新生效", () => {
  const f = fixture();
  const old = copy(f.ws());
  old.facts = [
    { eventId: "old", targetId: "mkt_main", kind: "inventory_stocktake", date: today, qty: 99 },
    { eventId: "new", targetId: "mkt_main", kind: "inventory_stocktake", date: today, qty: 80 }
  ];
  f.storage.setItem(f.key, JSON.stringify(old));
  f.SC.AppBridge.reloadFromStorage();
  rejected(f, "event.record", "mkt_main", { kind: "inventory_stocktake", date: today, qty: 50 });
  f.apply("event.correct", "new", { qty: 35, date: "2026-11-13", note: "盘点日期与数量复核" });
  const sim = f.SC.SimEngine.simulateWorkspace(f.ws(), dates);
  const daily = sim.nodeDaily.mkt_main;
  assert.equal(daily[sim.todayIdx].endingAvailable, 0);
  assert.equal(daily[sim.todayIdx + 1].endingAvailable, 35);
  assert.equal(f.ws().facts.length, 3);
});

test("撤销历史发运创建时同时保护工厂、市场、来源批次和被引用的方案", () => {
  const f = fixture();
  f.apply("node.update", "mkt_main", { note: "允许撤销" });
  f.apply("node.create", "", { nodeId: "src_new", name: "新工厂", kind: "source" });
  f.apply("node.create", "", { nodeId: "mkt_new", name: "新市场", kind: "market" });
  f.apply("lane.save", "", { laneId: "lane", fromNodeId: "src_new", toNodeId: "mkt_new" });
  f.apply("batch.createFromInterval", "src_new", {
    batchId: "bat", startDate: "2026-11-03", endDate: "2026-11-07", qtyOverride: 60
  });
  shipment(f, { batchId: "bat", fromNodeId: "src_new", toNodeId: "mkt_new", laneId: "lane" });
  record(f, "shp", "shipment_dispatched", 20);
  rejected(f, "lane.delete", "lane");
  f.history();
  assert.ok(f.ws().nodes.src_new && f.ws().nodes.mkt_new && f.ws().lanes.lane);
  assert.ok(f.ws().batches.bat && f.ws().shipments.shp);
  assert.notEqual(f.ws().nodes.mkt_main.note, "允许撤销");
  f.storage.fail = true;
  f.history(true);
  assert.notEqual(f.ws().nodes.mkt_main.note, "允许撤销");
  f.storage.fail = false;
  f.history(true);
  assert.equal(f.ws().nodes.mkt_main.note, "允许撤销");
});

test("演示、空白重置和旧备份无法覆盖正式事实，完整的较新备份可以恢复", () => {
  const f = fixture();
  batch(f);
  const oldBackup = copy(f.ws());
  record(f, "bat", "production_confirmed", 74);
  const persisted = f.storage.getItem(f.key);
  assert.equal(f.SC.AppBridge.loadDemoDirect(), false);
  f.click("new-blank-live");
  f.importWorkspace(oldBackup);
  assert.equal(f.storage.getItem(f.key), persisted);

  f.apply("batch.createFromInterval", "src_main", { batchId: "another", startDate: "2026-11-15", endDate: "2026-11-20" });
  const actions = [
    f.SC.Actions.createAction(f.ws(), "event.correct", "original", { qty: 53, note: "异机备份中的复核" }),
    f.SC.Actions.createAction(f.ws(), "batch.update", "another", { code: "已更新的计划批次" }),
    f.SC.Actions.createAction(f.ws(), "event.record", "another", { kind: "production_confirmed", date: "2026-11-20", qty: 47 })
  ];
  const upgraded = f.SC.Actions.applyActions(f.ws(), actions, dates);
  assert.ok(upgraded.ok);
  f.importWorkspace(upgraded.workspace);
  assert.equal(f.ws().facts.length, 3);
  assert.equal(f.ws().batches.bat.qtyOverride, 53);
  assert.equal(f.ws().batches.another.code, "已更新的计划批次");
  assert.equal(f.ws().batches.another.qtyOverride, 47);
  const overwritten = copy(f.ws());
  overwritten.facts[0].qty = 100;
  const saved = f.storage.getItem(f.key);
  f.importWorkspace(overwritten);
  assert.equal(f.storage.getItem(f.key), saved);
});

test("表单采用 BOM 工厂与创建批次是同一次提交，校验失败时无部分写入", () => {
  const f = fixture();
  f.storage.setItem("bom-flow-sim-v5", JSON.stringify({
    factories: { fresh: { id: "fresh", name: "可选装配厂", companyId: "co" } },
    companies: { co: { id: "co", name: "总装公司" } }
  }));
  const saved = f.storage.getItem(f.key);
  f.click("new-batch");
  f.submit({ sourceNodeId: "bom:fresh", startDate: "2026-11-07", endDate: "2026-11-06" });
  assert.equal(f.storage.getItem(f.key), saved);
  assert.equal(f.ws().nodes.src_fresh, undefined);
  assert.match(f.document.querySelector("#dialogError").textContent, /Batch end date must be after start date/);
  f.submit({ sourceNodeId: "bom:fresh", startDate: "2026-11-06", endDate: "2026-11-07" });
  assert.ok(f.ws().nodes.src_fresh);
  assert.equal(Object.values(f.ws().batches)[0].sourceNodeId, "src_fresh");
  f.history();
  assert.equal(Object.keys(f.ws().batches).length, 0);
  assert.equal(f.ws().nodes.src_fresh, undefined);
});

test("事实账本数量更正入口接受零并传入正式更正 Action", () => {
  const f = fixture();
  batch(f);
  record(f, "bat", "production_confirmed", 80);
  f.load("inspector");
  const prompts = ["2026-11-12", "0", "质检复核"];
  f.context.prompt = () => prompts.shift();
  let correct;
  const panel = {
    querySelector: () => null,
    querySelectorAll: selector => selector === "[data-correct-fact]" ? [{
      dataset: { correctFact: "original" },
      addEventListener(type, handler) { correct = handler; }
    }] : []
  };
  f.SC.Inspector.renderPanel(panel, { workspace: f.ws(), panel: { kind: "facts" }, onDispatch: f.apply });
  correct();
  assert.equal(f.ws().facts[1].supersedesEventId, "original");
  assert.equal(f.ws().batches.bat.qtyOverride, 0);
});

test("Sales 产品表单、BOM 关联及坏 JSON 导入遵循校验和落盘边界", () => {
  const f = fixture();
  const id = f.ws().activeProductId;
  const before = f.storage.getItem(f.key);
  f.click("edit-product-sku");
  f.submit({ name: "更新产品", skuCode: id, unit: "台", unitManufacturingCost: " " });
  assert.equal(f.storage.getItem(f.key), before);
  assert.notEqual(f.ws().products[id].name, "更新产品");
  f.submit({ name: "更新产品", skuCode: id, unit: "台", unitManufacturingCost: "0" });
  assert.equal(f.ws().products[id].unitManufacturingCost, 0);

  const valid = f.storage.getItem(f.key);
  const invalid = JSON.parse(valid);
  invalid.curves.crv_mkt_dem.points[0].rate = null;
  f.importWorkspace(invalid);
  assert.equal(f.storage.getItem(f.key), valid);
  assert.deepEqual(copy(f.ws()), JSON.parse(valid));

  const bomSample = path.join(__dirname, "../modules/bom/data/示例供应链-BOM.json");
  f.importBom(fs.readFileSync(bomSample, "utf8"));
  assert.equal(f.ws().products[f.ws().activeProductId].unitManufacturingCost, 0);
  f.SC.AppBridge.reloadFromStorage();
  assert.equal(f.ws().products[f.ws().activeProductId].unitManufacturingCost, 0);
});

test("Sales 表单拒绝空库存，盘点 prompt 拒绝非法数量且接受零", () => {
  const f = fixture();
  const before = f.storage.getItem(f.key);
  f.click("add-market");
  f.submit({ name: "测试市场", region: "US", initialInventory: "" });
  assert.equal(f.storage.getItem(f.key), before);
  assert.equal(Object.keys(f.ws().nodes).length, 2);

  for (const value of [null, "", " ", "abc", "1,000", "Infinity", "1e250"]) {
    f.context.prompt = () => value;
    f.clickDataset("[data-quick-stocktake]", { quickStocktake: "src_main" });
    assert.equal(f.storage.getItem(f.key), before);
    assert.equal(f.ws().facts.length, 0);
  }
  f.context.prompt = () => "0";
  f.clickDataset("[data-quick-stocktake]", { quickStocktake: "src_main" });
  assert.equal(f.ws().facts[0].qty, 0);

  const valid = f.storage.getItem(f.key);
  const invalid = JSON.parse(valid);
  invalid.facts[0].qty = null;
  f.storage.setItem(f.key, JSON.stringify(invalid));
  assert.equal(f.SC.AppBridge.reloadFromStorage(), false);
  assert.equal(f.ws().facts[0].qty, 0);
  rejected(f, "node.update", "mkt_main", { note: "校验失败后不可写入" });
  f.importWorkspace(JSON.parse(valid));
  assert.equal(f.ws().facts[0].qty, 0);
});

test("同一小数运输天数在表单、Action、CSV、JSON 与 AI 入口均被拒绝", () => {
  const f = fixture();
  shipment(f);
  const before = f.storage.getItem(f.key);
  const invalid = "1.5";
  f.clickDataset("[data-app-action]", { appAction: "new-shipment-to-market", marketId: "mkt_main" });
  f.submit({
    fromNodeId: "src_main", toNodeId: "mkt_main", departDate: today, qty: "20", mode: "sea",
    transitDays: invalid, customsWaitDays: "0", putawayDays: "0", fixedCost: "0", unitCost: "0"
  });
  assert.equal(f.storage.getItem(f.key), before);
  assert.deepEqual(Object.keys(f.ws().shipments), ["shp"]);

  rejected(f, "shipment.update", "shp", { transitDays: invalid });
  rejected(f, "shipment.batchImport", "", {
    csvText: `from,to,depart_date,qty,transit_days\nsrc_main,mkt_main,${today},20,${invalid}`
  });
  const bad = JSON.parse(before);
  bad.shipments.shp.transitDays = Number(invalid);
  f.importWorkspace(bad);
  assert.equal(f.storage.getItem(f.key), before);

  const AI = require("../shared/ai-mutations.js");
  const controller = AI.createWriteController({ storage: f.storage });
  controller.grantAuthorization({ workspaceId: f.ws().workspaceId, allowedOperations: ["shipment.update_schedule"] });
  const result = controller.executeAuthorizedMutation({
    operation: "shipment.update_schedule", shipmentId: "shp", transitDays: Number(invalid)
  });
  assert.equal(result.ok, false);
  assert.equal(f.storage.getItem(f.key), before);
  assert.deepEqual(copy(f.ws()), JSON.parse(before));
});
