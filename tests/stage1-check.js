/**
 * Stage 1 automated verification (compatible with macOS `jsc` and Node.js)
 * Verifies:
 * 1. SCBridge message protocol constants & helpers
 * 2. SCStorage snapshot logic for empty state, BOM-only state, Sales-only state,
 *    combined state, reminders, and corrupted JSON resilience (never overwrites).
 */
(function () {
  "use strict";

  let SCBridge, SCStorage;
  if (typeof require === "function") {
    SCBridge = require("../shared/bridge.js");
    SCStorage = require("../storage/snapshot.js");
  } else if (typeof load === "function") {
    const base = typeof scriptBase === "string" ? scriptBase : ".";
    load(base + "/shared/bridge.js");
    load(base + "/storage/snapshot.js");
    SCBridge = globalThis.SCBridge;
    SCStorage = globalThis.SCStorage;
  }

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
    let writeCount = 0;
    return {
      getItem: k => (Object.prototype.hasOwnProperty.call(map, k) ? map[k] : null),
      setItem: (k, v) => { map[k] = String(v); writeCount++; },
      removeItem: k => { delete map[k]; writeCount++; },
      getWriteCount: () => writeCount
    };
  }

  test("1. SCBridge exports required channel and message types", () => {
    assert(SCBridge && SCBridge.CHANNEL === "sc-unified", "channel should be sc-unified");
    assert(SCBridge.MESSAGE_TYPES.ON_SHOW === "sc:on-show", "ON_SHOW type matches");
    assert(SCBridge.MESSAGE_TYPES.DATA_CHANGED === "sc:data-changed", "DATA_CHANGED type matches");
    assert(SCBridge.isTrustedEvent({ data: { channel: "sc-unified", type: "sc:on-show" } }), "valid event passes");
    assert(!SCBridge.isTrustedEvent({ data: { channel: "other" } }), "foreign channel rejected");
  });

  test("2. Empty storage returns clean first-time state without writing anything", () => {
    const store = createMemoryStorage();
    const snap = SCStorage.readBusinessSnapshot(store);
    assert(snap.hasRealData === false, "hasRealData should be false on empty storage");
    assert(snap.bom.companyCount === 0 && snap.bom.factoryCount === 0 && snap.bom.diagramCount === 0, "BOM counts are 0");
    assert(snap.sales.marketCount === 0 && snap.sales.activeShipmentCount === 0, "Sales counts are 0");
    assert(snap.reminders.length === 0, "no fake reminders on empty state");
    assert(store.getWriteCount() === 0, "must never write to storage during snapshot read");
  });

  test("3. Real BOM data activates business overview and surfaces real compliance reminders", () => {
    const bom = {
      format: "bom-flow",
      version: 7,
      diagrams: [{ id: "d1", rootNodeId: "n1", assessments: { c1: { eu: { status: "blocked" } } } }],
      nodes: { n1: { id: "n1", diagramId: "d1", materialId: "m1" } },
      materials: { m1: { id: "m1", name: "总装网关 G200" } },
      companies: {
        c1: { id: "c1", name: "总装公司 A", compliance: { status: "severe" } },
        c2: { id: "c2", name: "供应公司 B", compliance: { status: "risk" } }
      },
      factories: {
        f1: { id: "f1", companyId: "c1", name: "总装厂 B" }
      },
      relationships: { n1: { c1: ["c2"] } }
    };
    const store = createMemoryStorage({ "bom-flow-sim-v5": JSON.stringify(bom) });
    const snap = SCStorage.readBusinessSnapshot(store);
    assert(snap.hasRealData === true, "hasRealData should be true");
    assert(snap.bom.companyCount === 2, "companyCount should be 2");
    assert(snap.bom.factoryCount === 1, "factoryCount should be 1");
    assert(snap.bom.diagramCount === 1, "diagramCount should be 1");
    assert(snap.bom.severeCount === 1, "severeCount should be 1");
    assert(snap.bom.blockedMarketCount === 1, "blockedMarketCount should be 1");
    assert(snap.reminders.some(r => r.severity === "danger" && r.route === "bom" && r.message?.type === "sc:navigate" && r.message?.payload?.view === "subjects" && r.title === "1 company with severe compliance issues"), "severe reminder surfaced");
    assert(snap.fallbackRecent.length >= 2, "fallback recent items populated from real saved entities");
    assert(store.getWriteCount() === 0, "snapshot read remains strictly read-only");
  });

  test("4. Corrupted JSON does not crash and never overwrites user storage", () => {
    const store = createMemoryStorage({
      "bom-flow-sim-v5": "{corrupted-json",
      "sc-sales-world-v2": "not-json"
    });
    const snap = SCStorage.readBusinessSnapshot(store);
    assert(snap.hasRealData === true, "corrupted existing data treated as non-blank to protect user data");
    assert(snap.bom.parseError === true && snap.sales.parseError === true, "parse errors recorded");
    assert(snap.reminders.length >= 2, "data warning reminders surfaced");
    assert(store.getWriteCount() === 0, "corrupted storage must NEVER be overwritten or cleared");
  });

  test("5. Recent work records and deduplicates user visits cleanly", () => {
    const store = createMemoryStorage();
    SCStorage.recordRecentWork({ kind: "company", id: "c1", name: "总装公司 A", route: "bom" }, store);
    SCStorage.recordRecentWork({ kind: "market", id: "m1", name: "欧盟市场", route: "sales" }, store);
    SCStorage.recordRecentWork({ kind: "company", id: "c1", name: "总装公司 A", route: "bom" }, store);
    const list = SCStorage.loadRecentWork(store);
    assert(list.length === 2, "deduplicated to 2 items");
    assert(list[0].kind === "company" && list[0].id === "c1", "most recent visit is first");
  });

  log(`\nStage 1 JS check summary: ${passed} passed, ${failed} failed.`);
  if (failed > 0 && typeof quit === "function") quit(1);
  if (failed > 0 && typeof process !== "undefined") process.exit(1);
})();
