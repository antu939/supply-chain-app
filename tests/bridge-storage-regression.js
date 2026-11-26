/**
 * Regression: loading the shell/module message bridge must never mutate
 * browser storage, including when the former clean-init marker is absent.
 * Run: node tests/bridge-storage-regression.js
 */
"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");

const source = fs.readFileSync(path.join(__dirname, "../shared/bridge.js"), "utf8");
const persistentKeys = [
  "bom-flow-sim-v5",
  "bom-flow-sim-v5-before-v3",
  "bom-flow-sim-v5-before-v4",
  "bom-flow-sim-v5-before-v5",
  "bom-flow-sim-v5-before-v6",
  "bom-flow-sim-v5-before-v7",
  "bom-flow-sim-v5-legacy-backup",
  "bom-flow-sim-v5-before-import-v4",
  "bom-flow-user-work-v1",
  "sc-sales-world-v2",
  "sc-sales-world-v1",
  "sc-sales-world-v1-backup",
  "sc-data-manifest-v1",
  "sc-app-recent-v1",
  "sc-shared-entities-v1",
  "sc-ai-chat-v1",
  "sc-ai-audit-v1",
  "sc-ai-privacy-vault-v1"
];

function memoryStorage(initial = {}) {
  const data = new Map(Object.entries(initial));
  const operations = [];
  return {
    getItem(key) { operations.push(["get", key]); return data.get(key) ?? null; },
    setItem(key, value) { operations.push(["set", key]); data.set(key, String(value)); },
    removeItem(key) { operations.push(["remove", key]); data.delete(key); },
    clear() { operations.push(["clear"]); data.clear(); },
    snapshot() { return Object.fromEntries(data); },
    operations
  };
}

function browser(localStorage, sessionStorage) {
  const context = vm.createContext({
    document: {},
    location: { protocol: "https:", origin: "https://example.test" },
    localStorage,
    sessionStorage
  });
  context.window = context;
  context.parent = context;
  vm.runInContext(source, context, { filename: "bridge.js" });
  assert.equal(context.SCBridge.CHANNEL, "sc-unified");
  assert.equal(context.SCBridge.MESSAGE_TYPES.DATA_CHANGED, "sc:data-changed");
  return context;
}

for (const marker of [undefined, "0", "1"]) {
  test(`Preserves existing storage with clean-init marker ${String(marker)}`, () => {
    const local = Object.fromEntries(persistentKeys.map(key => [key, JSON.stringify({ key })]));
    local["sc-ai-settings-v1"] = JSON.stringify({ model: "test", webSearchEndpoint: "legacy" });
    local["unrelated-key"] = "keep";
    // Corrupted data must also survive intact, for manual recovery.
    local["bom-flow-sim-v5-before-v7"] = "{corrupted-json";
    if (marker !== undefined) local["sc-clean-init-v1"] = marker;
    const session = {
      "sc-ai-session-api-key": "test-session-value",
      "sc-ai-session-search-key": "legacy-test-session-value"
    };
    const persistent = memoryStorage(local);
    const transient = memoryStorage(session);
    const context = browser(persistent, transient);
    vm.runInContext(source, context, { filename: "bridge-reload.js" });
    assert.deepEqual(persistent.snapshot(), local);
    assert.deepEqual(transient.snapshot(), session);
    assert.deepEqual(persistent.operations, []);
    assert.deepEqual(transient.operations, []);
  });
}

test("Empty storage remains empty after bridge initialization", () => {
  const local = memoryStorage();
  const session = memoryStorage();
  browser(local, session);
  assert.deepEqual(local.snapshot(), {});
  assert.deepEqual(session.snapshot(), {});
  assert.deepEqual(local.operations, []);
  assert.deepEqual(session.operations, []);
});

test("Bridge works when storage is unavailable", () => {
  const context = vm.createContext({ document: {} });
  context.window = context;
  context.parent = context;
  for (const name of ["localStorage", "sessionStorage"]) {
    Object.defineProperty(context, name, {
      get() { throw new Error("Storage access denied"); }
    });
  }
  vm.runInContext(source, context, { filename: "bridge.js" });
  assert.equal(context.SCBridge.CHANNEL, "sc-unified");
});
