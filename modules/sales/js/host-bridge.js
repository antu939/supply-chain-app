/**
 * Sales 工作台 ↔ 统一外壳与共享实体层适配桥（P1 / P2）
 */
(function (global) {
  "use strict";

  const params = new URLSearchParams(global.location.search || "");
  const isEmbedded = params.get("embedded") === "1" || global.parent !== global;
  if (params.get("embedded") === "1") {
    document.body.classList.add("is-embedded");
    const dashNav = document.querySelector(".mainnav [data-nav='dashboard']");
    if (dashNav) dashNav.textContent = "Overview";
  }

  function targetOrigin() {
    return global.location.protocol === "file:" ? "*" : global.location.origin;
  }

  function postToShell(type, payload) {
    if (!isEmbedded || !global.parent || global.parent === global) return;
    try {
      global.parent.postMessage({ channel: "sc-unified", source: "sales", type, payload: payload || {} }, targetOrigin());
    } catch (_) {}
  }

  function readBomForSync() {
    try {
      const raw = localStorage.getItem(global.SCShared?.BOM_STORAGE_KEY || "bom-flow-sim-v5");
      return raw ? JSON.parse(raw) : null;
    } catch (_) {
      return null;
    }
  }

  function onWorkspaceSaved(ws) {
    if (global.SCShared && ws && ws.dataSourceMode !== "demo") {
      try {
        const reg = global.SCShared.loadRegistry().registry;
        const bomState = readBomForSync();
        const updated = global.SCShared.reconcileFromModules(bomState, ws, reg);
        global.SCShared.saveRegistry(updated);
      } catch (_) {}
    }
    postToShell("sc:data-changed", { module: "sales" });
  }

  global.addEventListener("message", ev => {
    if (!isEmbedded || global.parent === global || ev.source !== global.parent) return;
    if (!global.SCBridge.isTrustedEvent(ev)) return;
    const msg = ev.data;
    if (msg.source !== "shell") return;
    const bridge = global.SC?.AppBridge;
    if (!bridge) return;

    if (msg.type === "sc:on-show" || msg.type === "sc:reload-shared") {
      bridge.syncShared();
      return;
    }
    if (msg.type === "sc:reload-storage") {
      bridge.reloadFromStorage();
      return;
    }
    if (msg.type === "sc:navigate") {
      if (msg.payload?.view) bridge.navigateView(msg.payload.view);
      return;
    }
    if (msg.type === "sc:focus-factory") {
      if (msg.payload?.sharedFactoryId) bridge.focusFactory(msg.payload.sharedFactoryId);
      return;
    }
    if (msg.type === "sc:focus-market") {
      if (msg.payload?.marketId) bridge.focusMarket(msg.payload.marketId);
      return;
    }
    if (msg.type === "sc:open-shipment") {
      if (msg.payload?.shipmentId) bridge.openShipment(msg.payload.shipmentId);
      return;
    }
    if (msg.type === "sc:load-demo-direct") {
      bridge.loadDemoDirect();
    }
  });

  global.SalesHostBridge = {
    isEmbedded,
    onWorkspaceSaved,
    postToShell
  };

  postToShell("sc:module-ready", { version: 2 });
})(window);
