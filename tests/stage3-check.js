/**
 * Stage 3 automated verification (compatible with macOS `jsc` and Node.js)
 * Verifies:
 * 1. BOM entity-based indexing & on-demand query / drill-down
 * 2. Sales monthly partitioning (sales/YYYY-MM.json, no current/history split)
 * 3. Manifest-guided selective reads (does NOT read unrelated months!)
 * 4. Cross-month association & immutability (records never migrate as time advances or dates update)
 * 5. Manifest rebuildability from raw data & zero write on blank storage
 * 6. Cross-module upstream/downstream lookup ONLY when explicit bomFactoryId link exists
 * 7. Legacy data compatibility, pagination limits, read-only guarantee & dry-run simulation wrapper
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
    load(base + "/modules/bom/js/model.js");
    load(base + "/modules/sales/js/timeseries.js");
    load(base + "/modules/sales/js/world-model.js");
    load(base + "/modules/sales/js/sim-engine.js");
    load(base + "/modules/sales/js/actions.js");
    load(base + "/storage/data-store.js");
    load(base + "/shared/ai-query.js");
  }

  const Store = globalThis.SCDataStore;
  const AI = globalThis.SCAIQuery;
  const WM = globalThis.SC.WorldModel;
  const Act = globalThis.SC.Actions;

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
      raw: map
    };
  }

  // Build rich multi-month fixture (BOM + Sales across 2026-09, 2026-10, 2026-11, 2026-12)
  function buildFixture() {
    const bom = emptyState();
    const rootNode = addDocument(bom, "智能网关 G200");
    const mcuNode = addNode(bom, rootNode, { name: "主控模组", qty: 1, unit: "件" });
    const compA = addCompany(bom, "华东总装公司", { location: "杭州", compliance: { status: "qualified", reason: "已通过年度审核" } }).id;
    const compSup = addCompany(bom, "芯联半导体", { location: "深圳", compliance: { status: "severe", reason: "缺少关键产地证明" } }).id;
    assignCompany(bom, rootNode, compA);
    assignCompany(bom, mcuNode, compSup);
    linkCompany(bom, mcuNode, compA, compSup);
    const facB = addFactory(bom, compA, "杭州总装一厂", { location: "杭州滨江" });
    const facC = addFactory(bom, compA, "苏州总装二厂", { location: "苏州园区" });
    const facSup = addFactory(bom, compSup, "深圳模组厂", { location: "深圳南山" });
    linkFactory(bom, mcuNode, compA, compSup, facB, facSup);
    setMarketAssessment(bom, bom.diagrams[0].id, compA, "eu", {
      status: "blocked",
      evidence: [{ id: "a1", title: "主控模组原产地证明缺失", detail: "尚缺上游晶圆厂声明", source: "合规审查记录" }],
      pendingItems: [{ id: "a2", title: "补充原产地声明", detail: "待供应商提交" }]
    });

    let ws = WM.createLiveWorkspaceFromShared(null, null, "2026-09-01");
    ws = Act.dispatchAction(ws, Act.createAction(ws, "node.create", "", {
      nodeId: "src_b", kind: "source", name: "杭州总装一厂", bomFactoryId: facB, bomCompanyId: compA, initialInventory: 5000
    })).workspace;
    ws = Act.dispatchAction(ws, Act.createAction(ws, "node.create", "", {
      nodeId: "src_legacy", kind: "source", name: "苏州总装二厂", initialInventory: 2000 // intentionally unlinked!
    })).workspace;
    ws = Act.dispatchAction(ws, Act.createAction(ws, "node.create", "", {
      nodeId: "mkt_us", kind: "market", name: "美国市场", region: "US", initialInventory: 500
    })).workspace;
    ws = Act.dispatchAction(ws, Act.createAction(ws, "node.create", "", {
      nodeId: "mkt_eu", kind: "market", name: "欧盟市场", region: "EU", initialInventory: 300
    })).workspace;

    // 2026-09 shipment
    ws = Act.dispatchAction(ws, Act.createAction(ws, "shipment.create", "", {
      shipmentId: "shp_sep", code: "SHP-SEP", fromNodeId: "src_b", toNodeId: "mkt_us",
      departDate: "2026-09-12", qty: 400, transitDays: 14
    })).workspace;

    // 2026-10 cross-month batch (2026-10-25 .. 2026-11-03)
    ws = Act.dispatchAction(ws, Act.createAction(ws, "batch.createFromInterval", "src_b", {
      batchId: "bat_oct", code: "BAT-OCT", startDate: "2026-10-25", endDate: "2026-11-03", extraWaitDays: 1
    })).workspace;

    // 2026-10 shipment that later gets rescheduled into 2026-11 AND receives a 2026-11 fact!
    ws = Act.dispatchAction(ws, Act.createAction(ws, "shipment.create", "", {
      shipmentId: "shp_oct", code: "SHP-OCT", fromNodeId: "src_b", toNodeId: "mkt_eu",
      departDate: "2026-10-28", qty: 600, transitDays: 15
    })).workspace;
    ws = Act.dispatchAction(ws, Act.createAction(ws, "shipment.update", "shp_oct", {
      departDate: "2026-11-02"
    })).workspace;
    ws = Act.dispatchAction(ws, Act.createAction(ws, "event.record", "shp_oct", {
      kind: "customs_release", date: "2026-11-18", note: "11月清关放行"
    })).workspace;

    // 2026-11 shipment referencing 2026-10 batch (cross-month batch -> shipment!)
    ws = Act.dispatchAction(ws, Act.createAction(ws, "shipment.create", "", {
      shipmentId: "shp_nov_from_oct", code: "SHP-NOV-01", fromNodeId: "src_b", toNodeId: "mkt_us",
      batchId: "bat_oct", departDate: "2026-11-06", qty: 300, transitDays: 12
    })).workspace;

    // 2026-12 shipment from unlinked legacy factory
    ws = Act.dispatchAction(ws, Act.createAction(ws, "shipment.create", "", {
      shipmentId: "shp_dec", code: "SHP-DEC", fromNodeId: "src_legacy", toNodeId: "mkt_eu",
      departDate: "2026-12-10", qty: 250, transitDays: 10
    })).workspace;

    return { bom, ws, compA, compSup, facB, facC, facSup, diagId: bom.diagrams[0].id };
  }

  test("1. BOM 按稳定主体 ID 建索引与按需查询（公司/工厂/产品/合规/分页）", () => {
    const f = buildFixture();
    const store = createMemoryStorage({
      "bom-flow-sim-v5": JSON.stringify(f.bom),
      "sc-sales-world-v2": JSON.stringify(f.ws)
    });

    const parts = AI.listPartitions({ domain: "all" }, { storage: store });
    assert(parts.ok, "listPartitions ok");
    assert(parts.meta.partitionsRead.length === 1 && parts.meta.partitionsRead[0] === "manifest.json", "listPartitions reads manifest only");
    assert(parts.data.partitions.some(p => p.id === "bom/entities"), "has bom/entities partition");

    const severe = AI.queryBomEntities({ kind: "company", complianceStatus: "severe" }, { storage: store });
    assert(severe.ok && severe.data.length === 1 && severe.data[0].id === f.compSup, "found severe compliance supplier by filter");

    const detail = AI.getBomDetail({ companyId: f.compA }, { storage: store });
    assert(detail.ok && detail.data.upstreamSuppliers.length === 1 && detail.data.upstreamSuppliers[0].id === f.compSup, "upstream supplier resolved");
    assert(detail.data.marketAssessments.length === 1 && detail.data.marketAssessments[0].status === "blocked", "market assessment preserved");

    const diagDetail = AI.getBomDetail({ diagramId: f.diagId }, { storage: store });
    assert(diagDetail.ok && diagDetail.data.nodes.length === 2, "BOM product tree queried cleanly");
    assert(store.getWrites() === 0, "all BOM AI queries are strictly read-only");
  });

  test("2. 销售按原始月份分区（无 current/history 双目录），且跨月修改不触发分区迁移", () => {
    const f = buildFixture();
    const bundle = Store.exportLogicalBundle({ bomRaw: f.bom, salesRaw: f.ws });

    assert(Boolean(bundle["manifest.json"]), "manifest.json generated");
    assert(Boolean(bundle["bom/entities.json"]), "bom/entities.json generated");
    assert(Boolean(bundle["sales/master.json"]), "sales/master.json generated");
    assert(Boolean(bundle["sales/2026-09.json"]), "sales/2026-09.json generated");
    assert(Boolean(bundle["sales/2026-10.json"]), "sales/2026-10.json generated");
    assert(Boolean(bundle["sales/2026-11.json"]), "sales/2026-11.json generated");
    assert(Boolean(bundle["sales/2026-12.json"]), "sales/2026-12.json generated");
    assert(!Object.keys(bundle).some(k => k.includes("current") || k.includes("history")), "MUST NOT split current/history directories");

    // shp_oct was created in 2026-10 and later rescheduled to 2026-11-02 -> MUST stay in 2026-10.json!
    assert(Boolean(bundle["sales/2026-10.json"].shipments.shp_oct), "shp_oct stays permanently in 2026-10.json");
    assert(!bundle["sales/2026-11.json"].shipments.shp_oct, "shp_oct did NOT migrate to 2026-11.json");
    assert(bundle["sales/2026-10.json"].shipments.shp_oct.departDate === "2026-11-02", "updated departDate preserved in place");

    // Its November customs fact lives in 2026-11.json referencing targetId="shp_oct"
    assert(bundle["sales/2026-11.json"].facts.some(x => x.targetId === "shp_oct" && x.kind === "customs_release"), "cross-month fact linked in 2026-11.json");

    // bat_oct stays in 2026-10.json while shp_nov_from_oct lives in 2026-11.json referencing bat_oct
    assert(Boolean(bundle["sales/2026-10.json"].batches.bat_oct), "bat_oct in 2026-10.json");
    assert(bundle["sales/2026-11.json"].shipments.shp_nov_from_oct.batchId === "bat_oct", "cross-month batch->shipment link intact");
  });

  test("3. 索引精准定位分区：按月/按工厂/按批次查询跳过无关月份，绝不全量读取", () => {
    const f = buildFixture();
    const bundle = Store.exportLogicalBundle({ bomRaw: f.bom, salesRaw: f.ws });

    // Simulate physical file provider and trace every partition read!
    function makeTrackedProvider() {
      const reads = [];
      return {
        reads,
        provider: {
          readManifest: () => bundle["manifest.json"],
          readPartition: (id) => {
            reads.push(id);
            return bundle[`${id}.json`] || null;
          }
        }
      };
    }

    // Query ONLY 2026-09
    const t1 = makeTrackedProvider();
    const rSep = AI.querySales({ entity: "shipments", month: "2026-09" }, { partitionProvider: t1.provider });
    assert(rSep.ok && rSep.data.length === 1 && rSep.data[0].id === "shp_sep", "found September shipment");
    assert(t1.reads.length === 1 && t1.reads[0] === "sales/2026-09", `expected only sales/2026-09 read, got ${t1.reads}`);

    // Query cross-month batch bat_oct shipments -> should ONLY read sales/2026-10 & sales/2026-11 (NEVER 2026-09 or 2026-12!)
    const t2 = makeTrackedProvider();
    const rBatShp = AI.querySales({ entity: "shipments", batchId: "bat_oct" }, { partitionProvider: t2.provider });
    assert(rBatShp.ok && rBatShp.data.length === 1 && rBatShp.data[0].id === "shp_nov_from_oct", "found November shipment linked to October batch");
    assert(!t2.reads.includes("sales/2026-09") && !t2.reads.includes("sales/2026-12"), `unrelated months must be skipped, got ${t2.reads}`);

    // Query by November date range (2026-11-01..2026-11-30) -> finds BOTH shp_nov_from_oct AND rescheduled shp_oct, still skips 2026-09 & 2026-12!
    const t3 = makeTrackedProvider();
    const rNovRange = AI.querySales({ entity: "shipments", fromDate: "2026-11-01", toDate: "2026-11-30" }, { partitionProvider: t3.provider });
    assert(rNovRange.ok && rNovRange.data.length === 2, `expected 2 shipments in Nov date window, got ${rNovRange.data.length}`);
    assert(!t3.reads.includes("sales/2026-09") && !t3.reads.includes("sales/2026-12"), `unrelated months skipped on date range, got ${t3.reads}`);

    // Query by factoryId using BOM factory ID directly!
    const t4 = makeTrackedProvider();
    const rByBomFac = AI.querySales({ entity: "shipments", factoryId: f.facB }, { partitionProvider: t4.provider });
    assert(rByBomFac.ok && rByBomFac.data.length === 3, "resolved bomFactoryId -> src_b and found its 3 shipments");
    assert(!t4.reads.includes("sales/2026-12"), "skipped 2026-12 which only had src_legacy");
  });

  test("4. 索引可从原始数据完整重建，空白启动不写入存储", () => {
    const emptyStore = createMemoryStorage();
    const emptyManifest = Store.rebuildManifest(emptyStore);
    assert(emptyManifest.partitions.length === 0, "empty storage -> 0 partitions");
    assert(emptyStore.getWrites() === 0, "empty storage must NEVER write manifest key");

    const f = buildFixture();
    const store = createMemoryStorage({
      "bom-flow-sim-v5": JSON.stringify(f.bom),
      "sc-sales-world-v2": JSON.stringify(f.ws)
    });
    const m1 = Store.rebuildManifest(store);
    assert(Boolean(store.getItem(Store.STORAGE_KEYS.MANIFEST)), "manifest cached in browser storage");

    // Delete manifest and rebuild -> identical partition structure
    store.removeItem(Store.STORAGE_KEYS.MANIFEST);
    const m2 = Store.rebuildManifest(store);
    assert(JSON.stringify(m1.partitions) === JSON.stringify(m2.partitions), "rebuilt manifest matches identically");
    assert(store.getItem("bom-flow-sim-v5") === JSON.stringify(f.bom), "raw BOM JSON untouched");
    assert(store.getItem("sc-sales-world-v2") === JSON.stringify(f.ws), "raw Sales JSON untouched");
  });

  test("5. 跨模块查询仅在存在显式 bomFactoryId 关联时打通上下游，绝不按同名猜测", () => {
    const f = buildFixture();
    const store = createMemoryStorage({
      "bom-flow-sim-v5": JSON.stringify(f.bom),
      "sc-sales-world-v2": JSON.stringify(f.ws)
    });

    // Linked factory facB <-> src_b
    const linkedView = AI.getCrossModuleFactoryView({ bomFactoryId: f.facB }, { storage: store });
    assert(linkedView.ok && linkedView.data.linked === true, "facB reliably linked to src_b");
    assert(linkedView.data.bom.upstreamSuppliers.length === 1, "upstream BOM supplier included");
    assert(linkedView.data.sales.factoryNode.id === "src_b" && linkedView.data.sales.shipmentsTotal === 3, "downstream Sales records included");

    // Unlinked same-name factory facC ("苏州总装二厂") vs src_legacy ("苏州总装二厂" without bomFactoryId)
    const unlinkedView = AI.getCrossModuleFactoryView({ bomFactoryId: f.facC }, { storage: store });
    assert(unlinkedView.ok && unlinkedView.data.linked === false, "same-name unlinked factory MUST report linked=false");
    assert(unlinkedView.data.bom && unlinkedView.data.sales === null, "does NOT guess or attach unlinked Sales factory");
  });

  test("6. 兼容无 originMonth 的旧版数据、分页限流与只读预演封装", () => {
    const f = buildFixture();
    // Strip originMonth to simulate legacy v2 backup data
    delete f.ws.shipments.shp_sep.originMonth;
    delete f.ws.batches.bat_oct.originMonth;
    const store = createMemoryStorage({
      "bom-flow-sim-v5": JSON.stringify(f.bom),
      "sc-sales-world-v2": JSON.stringify(f.ws)
    });

    // Legacy records still route deterministically to their original months
    const m = Store.loadManifest({ storage: store });
    const sepMeta = m.partitions.find(p => p.id === "sales/2026-09");
    const octMeta = m.partitions.find(p => p.id === "sales/2026-10");
    assert(sepMeta && sepMeta.entityIds.shipments.includes("shp_sep"), "legacy shipment mapped to 2026-09");
    assert(octMeta && octMeta.entityIds.batches.includes("bat_oct"), "legacy batch mapped to 2026-10");

    // Pagination check
    const page1 = AI.querySales({ entity: "shipments", limit: 2, offset: 0 }, { storage: store });
    const page2 = AI.querySales({ entity: "shipments", limit: 2, offset: 2 }, { storage: store });
    assert(page1.data.length === 2 && page1.meta.hasMore === true && page1.meta.total === 4, "page 1 bounded with hasMore=true");
    assert(page2.data.length === 2 && page2.meta.hasMore === false, "page 2 returns remaining 2");

    // Read-only dry-run simulation wrapper reuses existing deterministic Sales engine without mutating ws
    const beforeCount = Object.keys(f.ws.shipments).length;
    const simRes = AI.simulateSalesActions([
      Act.createAction(f.ws, "shipment.create", "", {
        fromNodeId: "src_b", toNodeId: "mkt_us", departDate: "2026-12-15", qty: 100, transitDays: 10
      })
    ], { workspace: f.ws, actionsEngine: Act, worldModel: WM });
    assert(simRes.ok && Object.keys(simRes.previewWorkspace.shipments).length === beforeCount + 1, "dry-run simulation succeeded");
    assert(Object.keys(f.ws.shipments).length === beforeCount, "original workspace strictly unchanged");
  });

  log(`\nStage 3 verification summary: ${passed} passed, ${failed} failed.`);
  if (failed > 0 && typeof quit === "function") quit(1);
  if (failed > 0 && typeof process !== "undefined") process.exit(1);
})();
