/**
 * 生产批次多市场按比例分配发运专项自动化测试（兼容 macOS `jsc` 与 Node.js）
 * 覆盖：
 * 1. 多市场分配（50%/30%/20% on 10000）生成独立 ShipmentOrder 且批次产量仅计入一次
 * 2. 部分分配（<100%）未分配部分留厂，二次分配以原批次总量为基准
 * 3. 超额分配（含未执行计划发运累计校验）原子拒绝，零部分创建
 * 4. 舍入误差保护（7 台 50%/50%、100 台 33.33/33.33/33.34 等均不超批次总量）
 * 5. 取消发运释放可分配额度并支持重新分配
 * 6. 跨月发运（超出当前视图窗口的远期计划发运）纳入累计校验 + Stage 3 AI 索引跨月关联
 * 7. 全节点全周期库存守恒 Δ=0、零负库存、已确认历史发运不受后续变更改写、旧版无 allocationPct 数据兼容
 */
(function () {
  "use strict";

  const base = typeof scriptBase === "string" ? scriptBase
    : (typeof __dirname !== "undefined" && typeof require === "function"
      ? require("path").resolve(__dirname, "..") : ".");
  // Support `node tests/batch-allocation-check.js` as well as JavaScriptCore `jsc`.
  if (typeof load !== "function" && typeof require === "function") {
    const fs = require("fs"), vm = require("vm");
    globalThis.readFile = path => fs.readFileSync(path, "utf8");
    globalThis.load = path => vm.runInThisContext(fs.readFileSync(path, "utf8"), { filename: path });
  }
  if (typeof load === "function") {
    load(base + "/modules/sales/js/timeseries.js");
    load(base + "/modules/sales/js/world-model.js");
    load(base + "/modules/sales/js/sim-engine.js");
    load(base + "/modules/sales/js/actions.js");
    load(base + "/storage/data-store.js");
    load(base + "/shared/ai-query.js");
  }

  const TS = globalThis.SC.TimeSeries;
  const WM = globalThis.SC.WorldModel;
  const Sim = globalThis.SC.SimEngine;
  const Act = globalThis.SC.Actions;
  const AI = globalThis.SCAIQuery;

  let passed = 0;
  let failed = 0;
  const log = typeof console !== "undefined" && console.log ? (...a) => console.log(...a) : (...a) => print(...a);

  function assert(cond, msg) {
    if (!cond) throw new Error("Assertion failed: " + msg);
  }
  function assertClose(a, e, tol, msg) {
    if (Math.abs(a - e) > tol) throw new Error(`${msg}: expected ${e}±${tol}, got ${a}`);
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

  function buildWorkspaceWithBatch(batchQty, anchorDate) {
    const today = anchorDate || "2026-10-01";
    let ws = WM.createLiveWorkspaceFromShared(null, null, today);
    ws = Act.dispatchAction(ws, Act.createAction(ws, "node.create", "", {
      nodeId: "src_hz", kind: "source", name: "杭州总装厂", initialInventory: 0, emptyCurve: true
    })).workspace;
    ws = Act.dispatchAction(ws, Act.createAction(ws, "node.create", "", {
      nodeId: "mkt_us", kind: "market", name: "美国市场", region: "US", initialInventory: 0
    })).workspace;
    ws = Act.dispatchAction(ws, Act.createAction(ws, "node.create", "", {
      nodeId: "mkt_eu", kind: "market", name: "欧洲市场", region: "EU", initialInventory: 0
    })).workspace;
    ws = Act.dispatchAction(ws, Act.createAction(ws, "node.create", "", {
      nodeId: "mkt_jp", kind: "market", name: "日本市场", region: "JP", initialInventory: 0
    })).workspace;

    // Create a 10-day batch with explicit total = batchQty (e.g. 10000)
    ws = Act.dispatchAction(ws, Act.createAction(ws, "batch.createFromInterval", "src_hz", {
      batchId: "bat_01", code: "BAT-01", startDate: "2026-10-01", endDate: "2026-10-11", extraWaitDays: 2, qtyOverride: batchQty
    })).workspace;
    return ws;
  }

  test("1. 多市场分配：10000 台批次按 50% 美国 / 30% 欧洲 / 20% 日本生成 3 笔独立发运单且严格守恒", () => {
    let ws = buildWorkspaceWithBatch(10000, "2026-10-01");
    const qtys = Act.computeProportionalQuantities(10000, [50, 30, 20], 10000);
    assert(qtys[0] === 5000 && qtys[1] === 3000 && qtys[2] === 2000, `expected [5000,3000,2000], got ${qtys}`);

    const actions = [
      Act.createAction(ws, "shipment.create", "", {
        shipmentId: "shp_us", fromNodeId: "src_hz", toNodeId: "mkt_us", batchId: "bat_01",
        allocationPct: 50, qty: qtys[0], departDate: "2026-10-14", mode: "sea_express", transitDays: 14, fixedCost: 3000, unitCost: 10
      }),
      Act.createAction(ws, "shipment.create", "", {
        shipmentId: "shp_eu", fromNodeId: "src_hz", toNodeId: "mkt_eu", batchId: "bat_01",
        allocationPct: 30, qty: qtys[1], departDate: "2026-10-15", mode: "sea", transitDays: 20, fixedCost: 2200, unitCost: 8
      }),
      Act.createAction(ws, "shipment.create", "", {
        shipmentId: "shp_jp", fromNodeId: "src_hz", toNodeId: "mkt_jp", batchId: "bat_01",
        allocationPct: 20, qty: qtys[2], departDate: "2026-10-16", mode: "air", transitDays: 4, fixedCost: 1500, unitCost: 18
      })
    ];
    const res = Act.applyActions(ws, actions, { today: "2026-10-01", viewHorizonDays: 60 });
    assert(res.ok, "atomic multi-market allocation succeeded");
    ws = res.workspace;

    assert(Object.keys(ws.shipments).length === 3, "created 3 independent ShipmentOrders");
    assert(ws.shipments.shp_us.batchId === "bat_01" && ws.shipments.shp_eu.batchId === "bat_01" && ws.shipments.shp_jp.batchId === "bat_01", "all share same batchId");
    assert(ws.shipments.shp_us.mode === "sea_express" && ws.shipments.shp_eu.mode === "sea" && ws.shipments.shp_jp.mode === "air", "independent logistics params preserved");

    const sim = res.simulation;
    const bs = sim.batchStates.bat_01;
    assertClose(bs.computedQty, 10000, 1e-6, "batch output counted strictly once = 10000");
    assertClose(bs.allocatedShipmentQty, 10000, 1e-6, "allocatedShipmentQty = 10000");
    assertClose(bs.remainingBatchQty, 0, 1e-6, "remainingBatchQty = 0");
    assert(bs.allocations.length === 3, "batch detail lists all 3 market allocations");

    // Factory ending inventory after all 3 depart (e.g. Oct 20) MUST be 0 (never duplicated!)
    const hzOct20 = sim.nodeDaily.src_hz.find(x => x.date === "2026-10-20");
    assertClose(hzOct20.endingAvailable, 0, 1e-6, "factory stock after 100% dispatch must be 0");

    // Strict conservation across all nodes and all days
    for (const [nid, days] of Object.entries(sim.nodeDaily)) {
      for (const snap of days) {
        assert(snap.endingAvailable >= -1e-6, `${nid} ${snap.date} non-negative inventory`);
        assertClose(snap.conservationDelta, 0, 1e-4, `${nid} ${snap.date} conservation delta = 0`);
      }
    }
  });

  test("2. 部分分配（<100%）与二次分配以原批次总量为基准，未分配部分保留在工厂", () => {
    let ws = buildWorkspaceWithBatch(10000, "2026-10-01");
    // Round 1: allocate 40% US + 25% EU = 65% (6500), leave 35% (3500) at factory
    let res = Act.applyActions(ws, [
      Act.createAction(ws, "shipment.create", "", {
        shipmentId: "shp_1", fromNodeId: "src_hz", toNodeId: "mkt_us", batchId: "bat_01", allocationPct: 40, qty: 4000, departDate: "2026-10-14", transitDays: 14
      }),
      Act.createAction(ws, "shipment.create", "", {
        shipmentId: "shp_2", fromNodeId: "src_hz", toNodeId: "mkt_eu", batchId: "bat_01", allocationPct: 25, qty: 2500, departDate: "2026-10-15", transitDays: 18
      })
    ], { today: "2026-10-01", viewHorizonDays: 45 });
    assert(res.ok, "partial allocation ok");
    ws = res.workspace;

    let sum = Act.getBatchAllocationSummary(ws, "bat_01");
    assertClose(sum.allocatedQty, 6500, 1e-6, "allocated 6500");
    assertClose(sum.remainingQty, 3500, 1e-6, "remaining 3500");
    const hzOct20 = res.simulation.nodeDaily.src_hz.find(x => x.date === "2026-10-20");
    assertClose(hzOct20.endingAvailable, 3500, 1e-6, "unallocated 3500 remains at factory");

    // Round 2: allocate 20% to JP -> MUST calculate 20% of ORIGINAL 10000 = 2000 (NOT 20% of 3500!)
    const round2Qty = Act.computeProportionalQuantities(sum.totalQty, [20], sum.remainingQty);
    assert(round2Qty[0] === 2000, `20% of original 10000 must be 2000, got ${round2Qty[0]}`);
    res = Act.dispatchAction(ws, Act.createAction(ws, "shipment.create", "", {
      shipmentId: "shp_3", fromNodeId: "src_hz", toNodeId: "mkt_jp", batchId: "bat_01", allocationPct: 20, qty: round2Qty[0], departDate: "2026-10-18", transitDays: 5
    }), { simOptions: { today: "2026-10-01", viewHorizonDays: 45 } });
    assert(res.ok, "second partial allocation ok");
    sum = Act.getBatchAllocationSummary(res.workspace, "bat_01");
    assertClose(sum.allocatedQty, 8500, 1e-6, "cumulative 8500");
    assertClose(sum.remainingQty, 1500, 1e-6, "remaining 1500");
  });

  test("3. 超额分配原子拦截：批量超 100% 与累计（含未执行计划发运）超额均拒绝，零部分创建", () => {
    let ws = buildWorkspaceWithBatch(10000, "2026-10-01");

    // Attempt atomic batch of 6000 + 5000 = 11000 -> MUST reject ALL (0 shipments created!)
    const over1 = Act.applyActions(ws, [
      Act.createAction(ws, "shipment.create", "", {
        shipmentId: "shp_a", fromNodeId: "src_hz", toNodeId: "mkt_us", batchId: "bat_01", qty: 6000, departDate: "2026-10-14", transitDays: 14
      }),
      Act.createAction(ws, "shipment.create", "", {
        shipmentId: "shp_b", fromNodeId: "src_hz", toNodeId: "mkt_eu", batchId: "bat_01", qty: 5000, departDate: "2026-10-15", transitDays: 18
      })
    ]);
    assert(!over1.ok, "110% batch must fail");
    assert(Object.keys(over1.workspace.shipments).length === 0, "atomic rollback: 0 shipments created on failure");

    // Create 1 unexecuted planned shipment for 6000 in future (Nov 20, beyond 30d window!)
    const ok1 = Act.dispatchAction(ws, Act.createAction(ws, "shipment.create", "", {
      shipmentId: "shp_future", fromNodeId: "src_hz", toNodeId: "mkt_us", batchId: "bat_01", qty: 6000, departDate: "2026-11-20", transitDays: 14
    }));
    assert(ok1.ok, "future planned 6000 ok");
    ws = ok1.workspace;

    // Now attempt to allocate 2500 + 2000 = 4500 (cumulative 10500 > 10000) -> MUST reject ALL!
    const over2 = Act.applyActions(ws, [
      Act.createAction(ws, "shipment.create", "", {
        shipmentId: "shp_c", fromNodeId: "src_hz", toNodeId: "mkt_eu", batchId: "bat_01", qty: 2500, departDate: "2026-10-20", transitDays: 18
      }),
      Act.createAction(ws, "shipment.create", "", {
        shipmentId: "shp_d", fromNodeId: "src_hz", toNodeId: "mkt_jp", batchId: "bat_01", qty: 2000, departDate: "2026-10-22", transitDays: 5
      })
    ]);
    assert(!over2.ok, "cumulative over-allocation including unexecuted planned shipment must fail");
    assert(Object.keys(over2.workspace.shipments).length === 1, "only original shp_future remains, 0 partial new shipments");

    // Editing shp_future qty up to 10500 must also fail
    const badUpd = Act.dispatchAction(ws, Act.createAction(ws, "shipment.update", "shp_future", { qty: 10500 }));
    assert(!badUpd.ok, "shipment.update exceeding batch total must fail");
  });

  test("4. 舍入误差保护：任意奇偶总量与小数比例求和永不超过批次总量或剩余量", () => {
    const q7 = Act.computeProportionalQuantities(7, [50, 50], 7);
    assert(q7[0] + q7[1] === 7, `7 split 50/50 must sum to 7, got ${q7}`);

    const q100 = Act.computeProportionalQuantities(100, [33.33, 33.33, 33.34], 100);
    assert(q100[0] + q100[1] + q100[2] === 100, `100 split 33.33/33.33/33.34 must sum to 100, got ${q100}`);

    const qRem = Act.computeProportionalQuantities(1000, [13.33, 13.33, 13.34], 400);
    assert(qRem[0] + qRem[1] + qRem[2] === 400, `remaining 400 split 13.33/13.33/13.34 must sum to 400, got ${qRem}`);

    const qUnder = Act.computeProportionalQuantities(10, [33.3, 33.3, 33.3], 10);
    assert(qUnder.reduce((a, b) => a + b, 0) <= 10, `sum must never exceed 10, got ${qUnder}`);
  });

  test("5. 取消发运释放批次额度并允许重新分配，且不影响同批次其他市场发运", () => {
    let ws = buildWorkspaceWithBatch(10000, "2026-10-01");
    ws = Act.applyActions(ws, [
      Act.createAction(ws, "shipment.create", "", {
        shipmentId: "shp_us", fromNodeId: "src_hz", toNodeId: "mkt_us", batchId: "bat_01", allocationPct: 50, qty: 5000, departDate: "2026-10-14", transitDays: 14
      }),
      Act.createAction(ws, "shipment.create", "", {
        shipmentId: "shp_eu", fromNodeId: "src_hz", toNodeId: "mkt_eu", batchId: "bat_01", allocationPct: 50, qty: 5000, departDate: "2026-10-15", transitDays: 18
      })
    ]).workspace;
    assertClose(Act.getBatchAllocationSummary(ws, "bat_01").remainingQty, 0, 1e-6, "initially 0 remaining");

    // Cancel EU shipment -> frees 5000
    ws = Act.dispatchAction(ws, Act.createAction(ws, "shipment.cancel", "shp_eu", {})).workspace;
    const sum = Act.getBatchAllocationSummary(ws, "bat_01");
    assertClose(sum.allocatedQty, 5000, 1e-6, "only US 5000 remains allocated");
    assertClose(sum.remainingQty, 5000, 1e-6, "5000 freed after cancellation");

    // Re-allocate freed 5000 to JP (3000) + EU (2000)
    const realloc = Act.applyActions(ws, [
      Act.createAction(ws, "shipment.create", "", {
        shipmentId: "shp_jp2", fromNodeId: "src_hz", toNodeId: "mkt_jp", batchId: "bat_01", allocationPct: 30, qty: 3000, departDate: "2026-10-18", transitDays: 5
      }),
      Act.createAction(ws, "shipment.create", "", {
        shipmentId: "shp_eu2", fromNodeId: "src_hz", toNodeId: "mkt_eu", batchId: "bat_01", allocationPct: 20, qty: 2000, departDate: "2026-10-20", transitDays: 18
      })
    ]);
    assert(realloc.ok, "re-allocation after cancellation succeeded");
    assert(realloc.workspace.shipments.shp_us.qty === 5000, "US shipment untouched");
    assertClose(realloc.simulation.batchStates.bat_01.remainingBatchQty, 0, 1e-6, "fully allocated again");
  });

  test("6. 跨月发运联动：10月批次分配至 10/11/12 月，sim-engine 与 Stage 3 AI 索引均完整关联", () => {
    let ws = buildWorkspaceWithBatch(10000, "2026-10-01");
    ws = Act.applyActions(ws, [
      Act.createAction(ws, "shipment.create", "", {
        shipmentId: "shp_m10", fromNodeId: "src_hz", toNodeId: "mkt_us", batchId: "bat_01", allocationPct: 50, qty: 5000, departDate: "2026-10-20", transitDays: 14
      }),
      Act.createAction(ws, "shipment.create", "", {
        shipmentId: "shp_m11", fromNodeId: "src_hz", toNodeId: "mkt_eu", batchId: "bat_01", allocationPct: 30, qty: 3000, departDate: "2026-11-10", transitDays: 18
      }),
      Act.createAction(ws, "shipment.create", "", {
        shipmentId: "shp_m12", fromNodeId: "src_hz", toNodeId: "mkt_jp", batchId: "bat_01", allocationPct: 20, qty: 2000, departDate: "2026-12-05", transitDays: 5
      })
    ]).workspace;

    // Even when viewing only 30 days from Oct 1 (so Dec 5 is outside view window!), allocatedShipmentQty MUST be 10000!
    const sim30 = Sim.simulateWorkspace(ws, { today: "2026-10-01", viewHorizonDays: 30 });
    assertClose(sim30.batchStates.bat_01.allocatedShipmentQty, 10000, 1e-6, "cross-month future shipments counted in allocatedShipmentQty");
    assertClose(sim30.batchStates.bat_01.remainingBatchQty, 0, 1e-6, "remainingBatchQty = 0 across months");

    // Stage 3 AI query by batchId finds all 3 shipments across 2026-10, 2026-11, 2026-12!
    const q = AI.querySales({ entity: "shipments", batchId: "bat_01" }, { bomRaw: null, salesRaw: ws });
    assert(q.ok && q.data.length === 3, `AI query by batchId found all 3 cross-month shipments, got ${q.data.length}`);
    assert(ws.shipments.shp_m10.originMonth === "2026-10" && ws.shipments.shp_m11.originMonth === "2026-11" && ws.shipments.shp_m12.originMonth === "2026-12", "originMonths preserved");
  });

  test("7. 区分计划分配与实际发运、保护已确认历史发运不被改写、兼容旧版无 allocationPct 数据", () => {
    let ws = buildWorkspaceWithBatch(10000, "2026-10-01");
    // Simulate legacy shipment without allocationPct field
    ws = Act.applyActions(ws, [
      Act.createAction(ws, "shipment.create", "", {
        shipmentId: "shp_legacy", fromNodeId: "src_hz", toNodeId: "mkt_us", batchId: "bat_01", qty: 4000, departDate: "2026-10-14", transitDays: 14
      }),
      Act.createAction(ws, "shipment.create", "", {
        shipmentId: "shp_plan", fromNodeId: "src_hz", toNodeId: "mkt_eu", batchId: "bat_01", allocationPct: 30, qty: 3000, departDate: "2026-10-20", transitDays: 18
      })
    ]).workspace;
    delete ws.shipments.shp_legacy.allocationPct;

    // Confirm dispatch fact on shp_legacy
    ws = Act.dispatchAction(ws, Act.createAction(ws, "event.record", "shp_legacy", {
      kind: "shipment_dispatched", date: "2026-10-14", qty: 4000, note: "实际发运确认"
    })).workspace;

    // Validate legacy workspace round-trip
    const validated = WM.validateWorkspace(JSON.parse(JSON.stringify(ws)));
    // Change batch confirmed qtyOverride later (e.g. actual production came out 9500) -> confirmed shipment qty 4000 MUST NOT be auto-rewritten!
    const afterBatchConfirm = Act.dispatchAction(validated, Act.createAction(validated, "event.record", "bat_01", {
      kind: "production_confirmed", date: "2026-10-11", qty: 9500, note: "实际完工 9500"
    }));
    assert(afterBatchConfirm.ok, "batch production confirmation ok");
    assert(afterBatchConfirm.workspace.shipments.shp_legacy.qty === 4000, "confirmed historical shipment qty MUST NOT be rewritten");

    const bs = afterBatchConfirm.simulation.batchStates.bat_01;
    assertClose(bs.actualDispatchedQty, 4000, 1e-6, "actualDispatchedQty = 4000");
    assertClose(bs.plannedAllocatedQty, 3000, 1e-6, "plannedAllocatedQty = 3000");
    assertClose(bs.allocatedShipmentQty, 7000, 1e-6, "total allocated = 7000");
    assertClose(bs.remainingBatchQty, 2500, 1e-6, "remaining = 9500 - 7000 = 2500");
    assert(bs.allocations.some(a => a.shipmentId === "shp_legacy" && a.isActual === true), "marks confirmed shipment as actual");
    assert(bs.allocations.some(a => a.shipmentId === "shp_plan" && a.isActual === false), "marks planned shipment as planned");
  });

  log(`\nBatch multi-market allocation check summary: ${passed} passed, ${failed} failed.`);
  if (failed > 0 && typeof quit === "function") quit(1);
  if (failed > 0 && typeof process !== "undefined") process.exit(1);
})();
