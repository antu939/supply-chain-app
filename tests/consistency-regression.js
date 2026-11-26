"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");
const Store = require("../storage/data-store.js");
const Snapshot = require("../storage/snapshot.js");

function memory(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: key => data.get(key) ?? null,
    setItem(key, value) {
      if (this.fail) throw Object.assign(new Error("Storage full"), { name: "QuotaExceededError" });
      data.set(key, String(value));
    },
    removeItem: key => data.delete(key)
  };
}
function runFile(context, filename) {
  const full = path.join(__dirname, "..", filename);
  return vm.runInContext(fs.readFileSync(full, "utf8"), context, { filename: full });
}
function bomFixture(storage) {
  const context = vm.createContext({
    localStorage: storage, console,
    document: { querySelector: () => null, querySelectorAll: () => [] },
    setTimeout() {}, clearTimeout() {}
  });
  runFile(context, "modules/bom/js/model.js");
  runFile(context, "modules/bom/js/core.js");
  vm.runInContext("render = () => {}; notify = () => {}; updateSaveState = () => {};", context);
  return source => vm.runInContext(source, context);
}

test("BOM 保存失败不会改变内存状态、撤销历史或已存数据", () => {
  const store = memory();
  const evalBom = bomFixture(store);
  assert.ok(evalBom('change(() => addCompany(state, "工厂公司 A"))'));
  const before = store.getItem(Store.STORAGE_KEYS.BOM);
  const count = evalBom("undoStack.length");
  store.fail = true;
  assert.equal(evalBom('change(() => addCompany(state, "工厂公司 B"))'), undefined);
  assert.equal(evalBom("JSON.stringify(state)"), before);
  assert.equal(evalBom("undoStack.length"), count);
  evalBom("undo()");
  assert.equal(evalBom("JSON.stringify(state)"), before);
  assert.equal(evalBom("undoStack.length"), count);
  assert.equal(store.getItem(Store.STORAGE_KEYS.BOM), before);
  store.fail = false;
  evalBom("undo()");
  assert.equal(evalBom("Object.keys(state.companies).length"), 0);
});

test("BOM 不覆盖其他窗口已保存的工作区", () => {
  const store = memory();
  const first = bomFixture(store);
  const second = bomFixture(store);
  assert.ok(first('change(() => addCompany(state, "公司 A"))'));
  const saved = store.getItem(Store.STORAGE_KEYS.BOM);
  assert.equal(second('change(() => addCompany(state, "公司 B"))'), undefined);
  assert.equal(store.getItem(Store.STORAGE_KEYS.BOM), saved);
  assert.equal(second("Object.keys(state.companies).length"), 0);
  assert.equal(second("undoStack.length"), 0);
});

test("BOM 读取异常时阻止常规写入，明确恢复才可替换", () => {
  const key = Store.STORAGE_KEYS.BOM;
  const store = memory({ [key]: "broken JSON" });
  const evalBom = bomFixture(store);
  assert.equal(evalBom('change(() => addCompany(state, "公司 A"))'), undefined);
  assert.equal(store.getItem(key), "broken JSON");
  assert.ok(evalBom('change(() => addCompany(state, "恢复的公司"), { restoreBackup: true })'));
  assert.equal(evalBom("storageReadFailed"), false);
  assert.equal(Object.keys(JSON.parse(store.getItem(key)).companies).length, 1);
});

test("manifest 同修订号内容变更仍反映真实月分区", () => {
  const key = Store.STORAGE_KEYS.SALES;
  const sales = {
    revision: 1, inventoryAnchorDate: "2026-01-01",
    shipments: { shp_a: { id: "shp_a", originMonth: "2026-01", departDate: "2026-01-10" } }
  };
  const store = memory({ [key]: JSON.stringify(sales) });
  Store.rebuildManifest(store);
  sales.shipments = { shp_b: { id: "shp_b", originMonth: "2026-02", departDate: "2026-02-10" } };
  store.setItem(key, JSON.stringify(sales));
  const manifest = Store.loadManifest({ storage: store });
  assert.ok(manifest.partitions.some(p => p.id === "sales/2026-02"));
  assert.ok(!manifest.partitions.some(p => p.id === "sales/2026-01"));
});

test("当前销售数据损坏不回退至历史记录；只有缺失才允许旧版兼容", () => {
  const { SALES, SALES_LEGACY } = Store.STORAGE_KEYS;
  const legacy = { nodes: { src_a: { id: "src_a", kind: "source" } } };
  const store = memory({ [SALES]: "invalid", [SALES_LEGACY]: JSON.stringify(legacy) });
  assert.equal(Store.readPartition("sales/master", { storage: store }), null);
  store.removeItem(SALES);
  assert.ok(Store.readPartition("sales/master", { storage: store }).nodes.src_a);
});

test("修正无效归档月份时，记录内部月份与分区保持一致", () => {
  const sales = {
    inventoryAnchorDate: "2026-01-01",
    batches: { bat_a: { id: "bat_a", originMonth: "2026-99", startDate: "2026-02-01" } },
    shipments: { shp_a: { id: "shp_a", originMonth: null, departDate: "2026-03-01" } },
    facts: [{ id: "fact_a", originMonth: "", date: "2026-04-01" }]
  };
  const part = Store.partitionSales(sales);
  assert.deepEqual(part.months, ["2026-02", "2026-03", "2026-04"]);
  assert.equal(part.monthly["2026-02"].batches.bat_a.originMonth, "2026-02");
  assert.equal(part.monthly["2026-03"].shipments.shp_a.originMonth, "2026-03");
  assert.equal(part.monthly["2026-04"].facts[0].originMonth, "2026-04");
});

test("总览能显示合法 JSON 但结构异常的数据警告", () => {
  const store = memory({
    [Store.STORAGE_KEYS.BOM]: JSON.stringify({ diagrams: [null] }),
    [Store.STORAGE_KEYS.SALES]: "null"
  });
  const snapshot = Snapshot.readBusinessSnapshot(store);
  assert.ok(snapshot.hasRealData);
  assert.ok(snapshot.bom.parseError);
  assert.ok(snapshot.sales.parseError);
  assert.equal(snapshot.reminders.length, 2);
  assert.equal(store.getItem(Store.STORAGE_KEYS.SALES), "null");
});
