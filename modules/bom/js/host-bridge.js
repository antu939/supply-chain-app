"use strict";
/**
 * BOM 工作台 ↔ 统一外壳与共享实体层适配桥（P1 / P2）
 * 独立打开 bom/index.html 时完全静默兼容；嵌入统一外壳（?embedded=1）时负责实体同步与跨模块跳转。
 */
(function (global) {
  const params = new URLSearchParams(global.location.search || "");
  const isEmbedded = params.get("embedded") === "1" || global.parent !== global;
  if (params.get("embedded") === "1") {
    document.body.classList.add("is-embedded");
  }

  function targetOrigin() {
    return global.location.protocol === "file:" ? "*" : global.location.origin;
  }

  function postToShell(type, payload) {
    if (!isEmbedded || !global.parent || global.parent === global) return;
    try {
      global.parent.postMessage({ channel: "sc-unified", source: "bom", type, payload: payload || {} }, targetOrigin());
    } catch (_) {}
  }

  function readSalesForSync() {
    try {
      const raw = localStorage.getItem(global.SCShared?.SALES_STORAGE_KEY || "sc-sales-world-v2");
      return raw ? JSON.parse(raw) : null;
    } catch (_) {
      return null;
    }
  }

  function syncSharedFromBom(currentState) {
    if (!global.SCShared) return;
    try {
      const reg = global.SCShared.loadRegistry().registry;
      const salesState = readSalesForSync();
      const updated = global.SCShared.reconcileFromModules(currentState, salesState, reg);
      global.SCShared.saveRegistry(updated);
    } catch (_) {}
  }

  function onStatePersisted(currentState) {
    syncSharedFromBom(currentState);
    postToShell("sc:data-changed", { module: "bom" });
  }

  function reloadFromStorage(force) {
    let raw;
    let next;
    try {
      raw = localStorage.getItem(STORAGE_KEY);
      if (!force && !storageError && raw === savedBomText) return false;
      next = raw === null ? emptyState() : validateState(JSON.parse(raw));
    } catch (_) {
      // Remember the invalid raw value for an explicitly confirmed backup
      // restore, but keep normal editing blocked until a valid read.
      if (raw !== undefined) savedBomText = raw;
      storageReadFailed = true;
      storageError = true;
      updateSaveState();
      notify("Failed to read BOM data; keeping current workspace");
      postToShell("sc:save-status", { ok: false, message: "BOM read error" });
      return false;
    }
    state = next;
    savedBomText = raw;
    storageReadFailed = false;
    storageError = false;
    closeDialog();
    undoStack = [];
    redoStack = [];
    if (typeof resetRiskDraft === "function") resetRiskDraft();
    sanitizeUI();
    render();
    postToShell("sc:save-status", { ok: true });
    if (ui.view === "bom" && doc()) requestAnimationFrame(fitView);
    return true;
  }

  function inspectFactoryUsageInSales(fid) {
    const salesState = readSalesForSync();
    if (global.SCShared) {
      const reg = global.SCShared.loadRegistry().registry;
      return global.SCShared.inspectFactoryUsage(fid, state, salesState, reg);
    }
    if (global.SCBomFactories && typeof global.SCBomFactories.inspectFactoryUsageInSales === "function") {
      return global.SCBomFactories.inspectFactoryUsageInSales(fid, salesState);
    }
    if (!fid || !salesState || typeof salesState !== "object" || salesState.dataSourceMode === "demo") {
      return { hasSalesHistory: false, canHardDelete: true, summary: "" };
    }
    const linked = Object.values(salesState.nodes || {}).filter(
      n => n && n.kind === "source" && String(n.bomFactoryId || "") === String(fid)
    );
    if (!linked.length) return { hasSalesHistory: false, canHardDelete: true, summary: "" };
    return {
      hasSalesHistory: true,
      canHardDelete: false,
      summary: `${linked.length} linked Sales ${linked.length === 1 ? "plant" : "plants"}`
    };
  }

  global.addEventListener("message", ev => {
    if (!isEmbedded || global.parent === global || ev.source !== global.parent) return;
    if (!global.SCBridge.isTrustedEvent(ev)) return;
    const msg = ev.data;
    if (msg.source !== "shell") return;

    if (msg.type === "sc:on-show") {
      const changed = reloadFromStorage(false);
      if (!changed && ui.view === "bom" && doc()) {
        requestAnimationFrame(fitView);
      }
      return;
    }
    if (msg.type === "sc:reload-storage" || msg.type === "sc:reload-shared") {
      reloadFromStorage(true);
      return;
    }
    if (msg.type === "sc:navigate") {
      const targetView = msg.payload?.view;
      if (["bom", "subjects", "risk"].includes(targetView)) {
        ui.view = targetView;
        ui.panel = null;
        render();
        if (targetView === "bom" && doc()) requestAnimationFrame(fitView);
      }
      return;
    }
    if (msg.type === "sc:open-company") {
      reloadFromStorage(false);
      const cid = msg.payload?.companyId;
      ui.view = "subjects";
      ui.panel = cid && state.companies[cid] ? { type: "company", companyId: cid, nodeId: null } : null;
      render();
      return;
    }
    if (msg.type === "sc:open-diagram") {
      reloadFromStorage(false);
      const did = msg.payload?.diagramId;
      const targetView = msg.payload?.view === "risk" ? "risk" : "bom";
      const found = state.diagrams.find(d => d.id === did);
      if (found) {
        state.activeDiagramId = found.id;
        ui.selected = found.rootNodeId;
      }
      ui.view = targetView;
      ui.panel = null;
      ui.focusNode = null;
      render();
      if (targetView === "bom" && doc()) requestAnimationFrame(fitView);
      return;
    }
    if (msg.type === "sc:load-sample-direct") {
      if (typeof SAMPLE_BOM_STATE !== "undefined") {
        const before = state;
        state = validateState(clone(SAMPLE_BOM_STATE));
        if (!persist()) { state = before; return; }
        undoStack = [];
        redoStack = [];
        ui.view = "bom";
        ui.panel = null;
        ui.outline = true;
        ui.selected = doc()?.rootNodeId || null;
        render();
        if (doc()) requestAnimationFrame(fitView);
      }
    }
  });

  // 初始同步一次已有数据（仅当存在实体时，避免首次空白启动写入冗余存储）
  if (Object.keys(state.companies || {}).length || Object.keys(state.factories || {}).length || state.diagrams.length) {
    syncSharedFromBom(state);
  }

  global.BOMHostBridge = {
    isEmbedded,
    onStatePersisted,
    reloadFromStorage,
    inspectFactoryUsageInSales,
    postToShell
  };

  postToShell("sc:module-ready", { version: state.version });
})(window);
