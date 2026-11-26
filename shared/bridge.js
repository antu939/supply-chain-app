(function (global) {
  "use strict";

  const CHANNEL = "sc-unified";
  // Loading the bridge must never clear or modify persisted workspace data.
  // The BOM and Sales modules handle empty workspaces and their own migrations.
  // Keep this module side-effect-free with respect to browser storage.

  const MESSAGE_TYPES = Object.freeze({
    MODULE_READY: "sc:module-ready",
    DATA_CHANGED: "sc:data-changed",
    SAVE_STATUS: "sc:save-status",
    ENTITY_VISITED: "sc:entity-visited",
    ENTITY_CLEARED: "sc:entity-cleared",
    NAVIGATE_SHELL: "sc:navigate-shell",
    ON_SHOW: "sc:on-show",
    RELOAD_STORAGE: "sc:reload-storage",
    NAVIGATE: "sc:navigate",
    OPEN_COMPANY: "sc:open-company",
    OPEN_DIAGRAM: "sc:open-diagram",
    FOCUS_FACTORY: "sc:focus-factory",
    FOCUS_MARKET: "sc:focus-market",
    OPEN_SHIPMENT: "sc:open-shipment"
  });

  function resolveTargetOrigin() {
    try {
      if (global.location && global.location.protocol !== "file:" && global.location.origin) {
        return global.location.origin;
      }
    } catch (_) {}
    return "*";
  }

  function isTrustedEvent(ev) {
    if (!ev || !ev.data || ev.data.channel !== CHANNEL || typeof ev.data.type !== "string") return false;
    try {
      if (global.location && global.location.protocol !== "file:") {
        if (ev.origin !== global.location.origin) return false;
      }
    } catch (_) {}
    return true;
  }

  function postToFrame(iframe, type, payload) {
    if (!iframe || !iframe.contentWindow) return false;
    try {
      iframe.contentWindow.postMessage(
        { channel: CHANNEL, source: "shell", type, payload: payload || {} },
        resolveTargetOrigin()
      );
      return true;
    } catch (_) {
      return false;
    }
  }

  function postToParent(source, type, payload) {
    if (!global.parent || global.parent === global) return false;
    try {
      global.parent.postMessage(
        { channel: CHANNEL, source: source || "module", type, payload: payload || {} },
        resolveTargetOrigin()
      );
      return true;
    } catch (_) {
      return false;
    }
  }

  const SCBridge = Object.freeze({
    CHANNEL,
    MESSAGE_TYPES,
    resolveTargetOrigin,
    isTrustedEvent,
    postToFrame,
    postToParent
  });

  global.SCBridge = SCBridge;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = SCBridge;
  }
})(typeof window !== "undefined" ? window : globalThis);
