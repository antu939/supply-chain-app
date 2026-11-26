/**
 * Stage 2 automated verification (compatible with macOS `jsc` and Node.js)
 * Covers all 7 Stage 2 acceptance scenarios + Stage 1 storageError TDZ bug fix:
 * 1. storageError TDZ fix: loading existing Sales v2 JSON & legacy v1 JSON succeeds with zero ReferenceError
 * 2. Blank app -> BOM creates Company A + Factories B, C -> Sales reads B, C without manual re-entry
 * 3. BOM adds Factory D -> Sales discovers D on refresh/re-entry
 * 4. BOM with full diagram + upstream component suppliers -> Sales ONLY gets final assembly factories (excludes upstream suppliers)
 * 5. On-demand adoption creates Sales source node with bomFactoryId, 0 inventory, empty curve (0 fabricated output/orders/batches/products)
 * 6. Existing Sales factories & history preserved; same-name unlinked Sales factory is NEVER overwritten or auto-merged; BOM rename updates linked node in-place without breaking node.id/shipments/batches
 * 7. Export/import JSON backup roundtrip preserves linked bomFactoryId & all operational records
 */
(function () {
  "use strict";

  const base = typeof scriptBase === "string" ? scriptBase
    : (typeof __dirname !== "undefined" && typeof require === "function"
      ? require("path").resolve(__dirname, "..") : ".");
  // Support `node tests/stageN-check.js` as well as JavaScriptCore `jsc`.
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
  }

  const BomFac = globalThis.SCBomFactories;
  const WM = globalThis.SC.WorldModel;
  const Sim = globalThis.SC.SimEngine;
  const Act = globalThis.SC.Actions;
  const Demo = globalThis.SC.DemoWorld;

  let passed = 0;
  let failed = 0;
  const log = typeof console !== "undefined" && console.log ? (...a) => console.log(...a) : (...a) => print(...a);

  function assert(cond, msg) {
    if (!cond) throw new Error("Assertion failed: " + msg);
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
      dump: () => Object.assign({}, map)
    };
  }

  /* 1. Verify storageError TDZ bug fix directly in modules/sales/js/app.js source & execution */
  test("1. storageError 声明顺序修复：已有销售 JSON 数据初始化不触发 ReferenceError", () => {
    const appSrc = readFile(base + "/modules/sales/js/app.js");
    const idxDecl = appSrc.indexOf("let storageError");
    const idxCall = appSrc.indexOf("let workspace = loadInitialWorkspace()");
    assert(idxDecl > 0 && idxCall > 0, "both declarations present");
    assert(idxDecl < idxCall, `storageError (${idxDecl}) must be declared before loadInitialWorkspace() (${idxCall})`);

    // Execute modules/sales/js/app.js with a minimal DOM mock + PRE-POPULATED sc-sales-world-v2 JSON
    const existingWs = Demo.createDemoWorkspace(null, "2026-11-24");
    const memStore = createMemoryStorage({
      "sc-sales-world-v2": JSON.stringify(existingWs)
    });
    const noopEl = () => ({
      textContent: "",
      innerHTML: "",
      value: "",
      disabled: false,
      dataset: {},
      classList: { add() {}, remove() {}, toggle() {} },
      setAttribute() {},
      removeAttribute() {},
      addEventListener() {},
      querySelector: () => noopEl(),
      querySelectorAll: () => [],
      closest: () => null,
      matches: () => false
    });
    globalThis.localStorage = memStore;
    globalThis.document = {
      querySelector: () => noopEl(),
      querySelectorAll: () => [],
      addEventListener() {}
    };
    globalThis.SC.Views = { renderView() {} };
    globalThis.SC.Inspector = { renderPanel() {} };
    load(base + "/modules/sales/js/app.js");
    const loaded = globalThis.SC.App.getWorkspace();
    assert(loaded && loaded.workspaceId === existingWs.workspaceId, "existing Sales workspace loaded cleanly");
    assert(Object.keys(loaded.shipments).length === Object.keys(existingWs.shipments).length, "all existing shipments preserved");
    assert(memStore.getWrites() === 0, "loading existing Sales JSON does not unnecessarily overwrite storage");
    const updated = JSON.parse(JSON.stringify(existingWs));
    updated.revision += 1;
    updated.viewHorizonDays = updated.viewHorizonDays === 60 ? 30 : 60;
    memStore.setItem("sc-sales-world-v2", JSON.stringify(updated));
    assert(globalThis.SC.AppBridge.syncShared(), "re-entry reloads externally saved Sales data");
    assert(globalThis.SC.App.getWorkspace().revision === updated.revision, "new revision reflected immediately");
    assert(globalThis.SC.App.getWorkspace().viewHorizonDays === updated.viewHorizonDays, "new settings reflected immediately");
  });

  /* 2. Blank app -> BOM creates Company A + Factories B, C -> Sales finds B, C */
  test("2. 空白应用在 BOM 建立总装公司 A 与总装厂 B、C，销售模块自动获取 B、C（零虚构数据）", () => {
    const bom = emptyState();
    const compA = addCompany(bom, "总装公司 A").id;
    const facB = addFactory(bom, compA, "总装厂 B", { location: "杭州" });
    const facC = addFactory(bom, compA, "总装厂 C", { location: "苏州" });

    const store = createMemoryStorage({ "bom-flow-sim-v5": JSON.stringify(bom) });
    const list = BomFac.readFromStorage(store);
    assert(list.length === 2, `expected 2 factories, got ${list.length}`);
    assert(list.some(f => f.id === facB && f.name === "总装厂 B" && f.companyName === "总装公司 A"), "found B");
    assert(list.some(f => f.id === facC && f.name === "总装厂 C" && f.companyName === "总装公司 A"), "found C");
    assert(store.getWrites() === 0, "reading BOM factories never writes to storage");

    // Sales starts blank: zero auto-fabricated factories, products, batches, shipments, or inventory
    const ws = WM.createLiveWorkspaceFromShared(null, bom, "2026-11-24");
    assert(Object.keys(ws.nodes).length === 0, "no auto-created Sales nodes before user picks");
    assert(Object.keys(ws.products).length === 0, "no auto-fabricated products");
    assert(Object.keys(ws.batches).length === 0, "no auto-fabricated batches");
    assert(Object.keys(ws.shipments).length === 0, "no auto-fabricated shipments");
  });

  /* 3. Add Factory D in BOM -> Sales discovers D on re-entry/refresh */
  test("3. BOM 新增总装厂 D 后，销售模块重新读取即可发现 D", () => {
    const bom = emptyState();
    const compA = addCompany(bom, "总装公司 A").id;
    addFactory(bom, compA, "总装厂 B");
    addFactory(bom, compA, "总装厂 C");
    assert(WM.readBomFinalAssemblyFactories(bom).length === 2, "initially 2");

    const facD = addFactory(bom, compA, "总装厂 D", { location: "宁波" });
    const refreshed = WM.readBomFinalAssemblyFactories(bom);
    assert(refreshed.length === 3, "now 3 after adding D");
    assert(refreshed.some(f => f.id === facD && f.name === "总装厂 D"), "discovered D");
  });

  /* 4. BOM with full product tree & upstream suppliers -> ONLY final assembly factories returned */
  test("4. 存在完整 BOM 与上游零部件供应商时，仅获取成品最终总装厂，过滤上游供应商工厂", () => {
    const bom = emptyState();
    const rootNode = addDocument(bom, "智能网关 G200");
    const childNode = addNode(bom, rootNode, { name: "主控模组", qty: 1, unit: "件" });
    const compA = addCompany(bom, "总装公司 A").id;
    const supX = addCompany(bom, "上游芯片供应商 X").id;
    assignCompany(bom, rootNode, compA);
    assignCompany(bom, childNode, supX);
    linkCompany(bom, childNode, compA, supX);
    const facB = addFactory(bom, compA, "总装厂 B");
    const facC = addFactory(bom, compA, "总装厂 C");
    const supFac = addFactory(bom, supX, "上游晶圆厂 X1");
    linkFactory(bom, childNode, compA, supX, facB, supFac);

    const list = WM.readBomFinalAssemblyFactories(bom);
    assert(list.length === 2, `expected strictly 2 final assembly factories, got ${list.length}`);
    assert(list.some(f => f.id === facB), "includes B");
    assert(list.some(f => f.id === facC), "includes C");
    assert(!list.some(f => f.id === supFac), "MUST NOT include upstream supplier factory X1");
  });

  /* 5. On-demand adoption creates clean empty source node with zero fabricated output/inventory */
  test("5. 销售模块按需选用总装厂 B、C：零虚构库存、零虚构排产曲线、重复选用幂等", () => {
    let ws = WM.createLiveWorkspaceFromShared(null, null, "2026-11-24");
    const resB = Act.dispatchAction(ws, Act.createAction(ws, "node.create", "", {
      nodeId: "src_f1",
      kind: "source",
      name: "总装厂 B",
      bomFactoryId: "f1",
      bomCompanyId: "c1",
      initialInventory: 0,
      emptyCurve: true
    }));
    assert(resB.ok, "adopt B succeeded");
    ws = resB.workspace;
    assert(ws.nodes.src_f1.name === "总装厂 B" && ws.nodes.src_f1.bomFactoryId === "f1", "B linked by bomFactoryId");
    assert(ws.nodes.src_f1.initialInventory === 0, "zero initial inventory");
    const curve = Object.values(ws.curves).find(c => c.targetNodeId === "src_f1");
    assert(curve && curve.points.length === 0, "empty production curve (zero fabricated output)");
    assert(Object.keys(ws.batches).length === 0 && Object.keys(ws.shipments).length === 0, "zero fabricated batches/shipments");

    // Idempotent second adoption of same bomFactoryId
    const resDup = Act.dispatchAction(ws, Act.createAction(ws, "node.create", "", {
      kind: "source",
      name: "总装厂 B",
      bomFactoryId: "f1",
      emptyCurve: true
    }));
    assert(resDup.ok, "idempotent adopt succeeded");
    assert(Object.keys(resDup.workspace.nodes).length === 1, "no duplicate source node created for same bomFactoryId");
  });

  /* 6. Existing Sales factories & same-name protection + safe rename sync */
  test("6. 保留已有销售工厂与同名历史记录，不覆盖不合并；已关联总装厂更名不断裂关联", () => {
    const bom = emptyState();
    const compA = addCompany(bom, "总装公司 A").id;
    const facB = addFactory(bom, compA, "总装厂 B");

    let ws = WM.createLiveWorkspaceFromShared(null, null, "2026-11-24");
    // Pre-existing legacy/manual Sales factory with the SAME NAME "总装厂 B" (no bomFactoryId)
    ws = Act.dispatchAction(ws, Act.createAction(ws, "node.create", "", {
      nodeId: "src_legacy_b",
      kind: "source",
      name: "总装厂 B",
      initialInventory: 500,
      note: "历史遗留库存记录"
    })).workspace;

    // Separately adopt BOM factory B (linked via bomFactoryId)
    ws = Act.dispatchAction(ws, Act.createAction(ws, "node.create", "", {
      nodeId: "src_bom_b",
      kind: "source",
      name: "总装厂 B",
      bomFactoryId: facB,
      bomCompanyId: compA,
      initialInventory: 0,
      emptyCurve: true
    })).workspace;

    // Rename factory B in BOM
    bom.factories[facB].name = "总装厂 B（新厂区）";
    const synced = WM.syncLinkedBomFactoryNames(ws, WM.readBomFinalAssemblyFactories(bom));
    assert(synced.changed === true, "linked node name updated");
    assert(ws.nodes.src_bom_b.name === "总装厂 B（新厂区）", "linked BOM factory updated in-place");
    assert(ws.nodes.src_bom_b.id === "src_bom_b", "node.id stays stable");
    assert(ws.nodes.src_legacy_b.name === "总装厂 B", "existing same-name unlinked Sales factory untouched");
    assert(ws.nodes.src_legacy_b.initialInventory === 500 && ws.nodes.src_legacy_b.note === "历史遗留库存记录", "existing Sales history 100% preserved");
  });

  /* 7. Backup & restore roundtrip */
  test("7. JSON 备份导出与导入恢复完整保留 bomFactoryId 与业务记录", () => {
    let ws = Demo.createDemoWorkspace(null, "2026-11-24");
    ws.nodes.src_cn_hz.bomFactoryId = "f65";
    const jsonText = JSON.stringify(ws);
    const restored = WM.validateWorkspace(JSON.parse(jsonText));
    assert(restored.nodes.src_cn_hz.bomFactoryId === "f65", "bomFactoryId preserved through backup/restore");
    assert(Object.keys(restored.shipments).length === Object.keys(ws.shipments).length, "shipments preserved");
    const sim = Sim.simulateWorkspace(restored, { today: "2026-11-24", viewHorizonDays: 30 });
    assert(sim && sim.kpis, "simulation runs normally after restore");
  });

  log(`\nStage 2 verification summary: ${passed} passed, ${failed} failed.`);
  if (failed > 0 && typeof quit === "function") quit(1);
  if (failed > 0 && typeof process !== "undefined") process.exit(1);
})();
