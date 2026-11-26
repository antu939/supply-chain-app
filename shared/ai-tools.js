(function (global) {
  "use strict";

  const TOOLS_VERSION = "1.0";
  const DEFAULT_MAX_LOG_ENTRIES = 200;

  function getRegistryMod() {
    if (global.SCAIToolRegistry) return global.SCAIToolRegistry;
    if (typeof require === "function") return require("./ai-tool-registry.js");
    throw new Error("未加载 SCAIToolRegistry (shared/ai-tool-registry.js)");
  }

  function getHandlersMod() {
    if (global.SCAIToolHandlers) return global.SCAIToolHandlers;
    if (typeof require === "function") return require("./ai-tool-handlers.js");
    throw new Error("未加载 SCAIToolHandlers (shared/ai-tool-handlers.js)");
  }

  function getPrivacyMod() {
    if (global.SCAIPrivacy) return global.SCAIPrivacy;
    if (typeof require === "function") return require("./ai-privacy.js");
    throw new Error("未加载 SCAIPrivacy (shared/ai-privacy.js)");
  }

  function getSchemaMod() {
    if (global.SCAIPrivacySchema) return global.SCAIPrivacySchema;
    if (typeof require === "function") return require("./ai-privacy-schema.js");
    throw new Error("未加载 SCAIPrivacySchema (shared/ai-privacy-schema.js)");
  }

  function getStoreMod() {
    if (global.SCDataStore) return global.SCDataStore;
    if (typeof require === "function") return require("../storage/data-store.js");
    return null;
  }

  function utf8ByteLength(str) {
    if (typeof TextEncoder === "function") {
      return new TextEncoder().encode(str).length;
    }
    // Lightweight pure-JS UTF-8 byte counter (compatible with jsc / older engines)
    let bytes = 0;
    for (let i = 0; i < str.length; i++) {
      const code = str.charCodeAt(i);
      if (code <= 0x7f) bytes += 1;
      else if (code <= 0x7ff) bytes += 2;
      else if (code >= 0xd800 && code <= 0xdbff) { bytes += 4; i++; }
      else bytes += 3;
    }
    return bytes;
  }

  /**
   * Normalize vendor-specific or standard Tool Call JSON into { callId, name, rawArgs }.
   * Supports: standard ({ name, arguments }), OpenAI ({ function: { name, arguments } }),
   * Anthropic ({ name, input }), Gemini ({ functionCall: { name, args } }).
   */
  function normalizeToolCall(call) {
    if (!call || typeof call !== "object" || Array.isArray(call)) {
      return { ok: false, error: "工具调用请求必须是结构化 JSON 对象" };
    }
    let callId = call.id || call.callId || null;
    let name = null;
    let rawArgs = undefined;

    if (call.function && typeof call.function === "object") {
      name = call.function.name;
      rawArgs = call.function.arguments;
    } else if (call.functionCall && typeof call.functionCall === "object") {
      name = call.functionCall.name;
      rawArgs = call.functionCall.args;
    } else {
      name = call.name;
      rawArgs = call.arguments !== undefined ? call.arguments : call.input;
    }

    if (typeof name !== "string" || !name.trim()) {
      return { ok: false, error: "工具调用缺少有效的工具名称 name" };
    }

    let parsedArgs = {};
    if (rawArgs === undefined || rawArgs === null || rawArgs === "") {
      parsedArgs = {};
    } else if (typeof rawArgs === "string") {
      try {
        parsedArgs = JSON.parse(rawArgs);
      } catch (_) {
        return { ok: false, error: "工具参数 JSON 解析失败" };
      }
      if (!parsedArgs || typeof parsedArgs !== "object" || Array.isArray(parsedArgs)) {
        return { ok: false, error: "工具参数 arguments 必须是 JSON 对象" };
      }
    } else if (typeof rawArgs === "object" && !Array.isArray(rawArgs)) {
      parsedArgs = rawArgs;
    } else {
      return { ok: false, error: "工具参数 arguments 必须是 JSON 对象" };
    }

    return {
      ok: true,
      callId: callId ? String(callId) : null,
      name: name.trim(),
      args: parsedArgs
    };
  }

  function readDataVersionSnapshot(queryCtx, workspace) {
    const Store = getStoreMod();
    let manifest = null;
    if (Store) {
      try {
        manifest = Store.loadManifest(queryCtx);
      } catch (_) {
        manifest = null;
      }
    }
    return {
      manifestVersion: manifest?.version || null,
      bomVersion: manifest?.sources?.bom?.version || null,
      bomCounter: manifest?.sources?.bom?.counter ?? null,
      salesVersion: workspace?.version || manifest?.sources?.sales?.version || null,
      salesRevision: workspace?.revision || manifest?.sources?.sales?.revision || null
    };
  }

  /**
   * Create a unified, vendor-agnostic, privacy-enforced AI Tool Execution Runtime.
   */
  function createRuntime(config) {
    const cfg = config || {};
    const RegistryMod = getRegistryMod();
    const HandlersMod = getHandlersMod();
    const PrivacyMod = getPrivacyMod();
    const SchemaMod = getSchemaMod();

    const registry = cfg.registry || HandlersMod.registerCoreTools(RegistryMod.createRegistry({ allowWriteTools: false }));

    const queryCtx = {};
    if (cfg.storage) queryCtx.storage = cfg.storage;
    if (cfg.partitionProvider) queryCtx.partitionProvider = cfg.partitionProvider;
    if (cfg.bomRaw !== undefined) queryCtx.bomRaw = cfg.bomRaw;
    if (cfg.salesRaw !== undefined) queryCtx.salesRaw = cfg.salesRaw;
    if (cfg.workspace && queryCtx.salesRaw === undefined) queryCtx.salesRaw = cfg.workspace;

    const privacy = cfg.privacyContext || PrivacyMod.createContext(Object.assign({}, queryCtx, {
      vault: cfg.vault,
      persistVault: cfg.persistVault === true,
      vaultStorage: cfg.vaultStorage || null,
      modelPolicy: cfg.modelPolicy || (cfg.scope || cfg.grants ? { scope: cfg.scope, grants: cfg.grants } : undefined),
      searchPolicy: cfg.searchPolicy
    }));

    const allowedToolsSet = Array.isArray(cfg.allowedTools) ? new Set(cfg.allowedTools) : null;
    const lockedScope = cfg.lockedScope || cfg.modelPolicy?.scope || cfg.scope || null;
    const allowedScopesSet = Array.isArray(cfg.allowedScopes)
      ? new Set(cfg.allowedScopes)
      : new Set([
        "relationship_only",
        "compliance_overview",
        "inventory_risk",
        "logistics_tracking",
        ...(cfg.allowCostAnalysis === true || lockedScope === "cost_analysis" ? ["cost_analysis"] : []),
        ...(lockedScope === "public_entity_lookup" ? ["public_entity_lookup"] : [])
      ]);

    const simCache = new Map();
    const executionLogs = [];
    const maxLogEntries = Math.max(10, Math.min(1000, Number(cfg.maxLogEntries) || DEFAULT_MAX_LOG_ENTRIES));

    function appendAuditLog(entry) {
      executionLogs.push(Object.freeze(entry));
      if (executionLogs.length > maxLogEntries) {
        executionLogs.splice(0, executionLogs.length - maxLogEntries);
      }
    }

    function resolveEffectiveScope(tool, callOpts) {
      const requested = callOpts?.scope || null;
      if (requested) {
        if (!Object.prototype.hasOwnProperty.call(SchemaMod.DISCLOSURE_SCOPES, requested)) {
          return { ok: false, error: `未知的披露范围 scope「${requested}」` };
        }
        if (!allowedScopesSet.has(requested)) {
          return { ok: false, error: `当前运行策略未授权披露范围「${requested}」` };
        }
        if (lockedScope && requested !== lockedScope && !Array.isArray(cfg.allowedScopes)) {
          return { ok: false, error: `当前会话已锁定披露范围「${lockedScope}」，拒绝提升为「${requested}」` };
        }
        return { ok: true, scope: requested };
      }

      if (lockedScope) {
        return { ok: true, scope: lockedScope };
      }

      // Default: tool's minimal scope bounded by allowedScopesSet
      const candidate = tool.defaultScope || SchemaMod.DEFAULT_SCOPE;
      return { ok: true, scope: allowedScopesSet.has(candidate) ? candidate : SchemaMod.DEFAULT_SCOPE };
    }

    function buildErrorResponse(callId, toolName, code, rawMessage, scope, startTs, argKeys) {
      const safeErr = privacy.sanitizeError(rawMessage);
      const durationMs = Math.max(0, Date.now() - startTs);
      const out = {
        ok: false,
        callId: callId || null,
        tool: toolName || null,
        data: null,
        meta: {
          toolVersion: TOOLS_VERSION,
          channel: SchemaMod.CHANNELS.MODEL_CONTEXT,
          scope: scope || null,
          asOfDate: null,
          dataVersion: readDataVersionSnapshot(queryCtx, cfg.workspace),
          partitionsRead: [],
          pagination: null,
          cacheHit: false,
          durationMs,
          payloadBytes: 0,
          estimatedTokens: 0,
          historicalReplayCaveat: null
        },
        error: {
          code,
          message: safeErr.message
        }
      };
      appendAuditLog({
        timestamp: Date.now(),
        callId: out.callId,
        tool: out.tool,
        ok: false,
        errorCode: code,
        scope: out.meta.scope,
        durationMs,
        payloadBytes: 0,
        estimatedTokens: 0,
        cacheHit: false,
        partitionsRead: [],
        argKeys: argKeys || []
      });
      return out;
    }

    /**
     * Execute a single structured tool call through validation, auth, privacy, and telemetry.
     */
    function executeTool(call, callOpts) {
      const startTs = Date.now();
      const opts = callOpts || {};

      // 1. Normalize call shape
      const norm = normalizeToolCall(call);
      if (!norm.ok) {
        return buildErrorResponse(null, null, "INVALID_CALL", norm.error, null, startTs, []);
      }
      const { callId, name, args } = norm;
      const argKeys = Object.keys(args || {});

      // 2. Verify tool exists in whitelist registry (blocks arbitrary code/paths/unregistered names)
      if (!registry.hasTool(name)) {
        return buildErrorResponse(callId, name, "UNKNOWN_TOOL", `工具「${name}」未注册，禁止调用未授权能力`, null, startTs, argKeys);
      }
      const tool = registry.getTool(name);

      // 3. Enforce Stage 2 read-only & tool allowlist authorization
      if (!tool.readOnly) {
        return buildErrorResponse(callId, name, "UNAUTHORIZED", `工具「${name}」为写入类工具，当前阶段禁止外部模型调用`, null, startTs, argKeys);
      }
      if (allowedToolsSet && !allowedToolsSet.has(name)) {
        return buildErrorResponse(callId, name, "UNAUTHORIZED", `工具「${name}」不在当前会话的授权工具白名单内`, null, startTs, argKeys);
      }

      // 4. Resolve & verify privacy disclosure scope
      const scopeCheck = resolveEffectiveScope(tool, opts);
      if (!scopeCheck.ok) {
        return buildErrorResponse(callId, name, "UNAUTHORIZED", scopeCheck.error, null, startTs, argKeys);
      }
      const effectiveScope = scopeCheck.scope;

      // 5. Reject unauthorized grants escalation from untrusted callOpts unless explicitly allowed
      const baseGrants = privacy.getPolicySnapshot().grants || {};
      const effectiveGrants = Object.assign({}, baseGrants);
      if (opts.grants && typeof opts.grants === "object") {
        if (opts.trustedHostCall === true) {
          Object.assign(effectiveGrants, opts.grants);
        } else {
          return buildErrorResponse(callId, name, "UNAUTHORIZED", "外部模型调用不允许自行附加 grants 权限覆盖", effectiveScope, startTs, argKeys);
        }
      }

      // 6. Strict JSON Schema parameter validation
      const validation = registry.validateToolArgs(name, args);
      if (!validation.ok) {
        return buildErrorResponse(callId, name, "INVALID_ARGS", validation.errors.join("；"), effectiveScope, startTs, argKeys);
      }

      // 7. Execute tool handler with privacy-enforced context
      const privacyCallOpts = {
        scope: effectiveScope,
        grants: effectiveGrants,
        userConfirmed: opts.userConfirmed === true,
        strictBlockUnreliable: opts.strictBlockUnreliable === true
      };

      const execCtx = {
        queryCtx,
        workspace: cfg.workspace || null,
        privacy,
        privacyCallOpts,
        effectiveScope,
        effectiveGrants,
        simCache
      };

      let handlerResult;
      try {
        handlerResult = tool.execute(args, execCtx);
      } catch (err) {
        return buildErrorResponse(callId, name, "EXECUTION_ERROR", err?.message || String(err), effectiveScope, startTs, argKeys);
      }

      if (!handlerResult || typeof handlerResult !== "object") {
        return buildErrorResponse(callId, name, "EXECUTION_ERROR", "工具未返回合法结果对象", effectiveScope, startTs, argKeys);
      }

      if (handlerResult.privacyBlocked) {
        const pb = handlerResult.privacyBlocked;
        const reason = (pb.blockedReasons || pb.confirmationReasons || ["触发隐私出口拦截"]).join("；");
        return buildErrorResponse(callId, name, "PRIVACY_BLOCKED", reason, effectiveScope, startTs, argKeys);
      }

      if (handlerResult.error) {
        return buildErrorResponse(callId, name, "EXECUTION_ERROR", handlerResult.error, effectiveScope, startTs, argKeys);
      }

      // 8. Defense-in-depth vault leakage guard on final output
      const leak = PrivacyMod.detectVaultLeak(handlerResult.data);
      if (leak) {
        return buildErrorResponse(callId, name, "PRIVACY_BLOCKED", leak.reason, effectiveScope, startTs, argKeys);
      }

      const serializedData = JSON.stringify(handlerResult.data ?? null);
      const payloadBytes = utf8ByteLength(serializedData);
      const estimatedTokens = Math.ceil(payloadBytes / 3.5);
      const durationMs = Math.max(0, Date.now() - startTs);
      const partitionsRead = Array.isArray(handlerResult.partitionsRead) ? handlerResult.partitionsRead.slice() : [];

      const response = {
        ok: true,
        callId: callId || null,
        tool: name,
        data: handlerResult.data,
        meta: {
          toolVersion: TOOLS_VERSION,
          channel: SchemaMod.CHANNELS.MODEL_CONTEXT,
          scope: effectiveScope,
          asOfDate: handlerResult.asOfDate || null,
          dataVersion: readDataVersionSnapshot(queryCtx, cfg.workspace),
          partitionsRead,
          pagination: handlerResult.pagination || null,
          cacheHit: Boolean(handlerResult.cacheHit),
          durationMs,
          payloadBytes,
          estimatedTokens,
          historicalReplayCaveat: handlerResult.historicalReplayCaveat || null
        },
        error: null
      };

      // Metadata-only execution log (NEVER records raw business payload or sensitive args!)
      appendAuditLog({
        timestamp: Date.now(),
        callId: response.callId,
        tool: name,
        ok: true,
        errorCode: null,
        scope: effectiveScope,
        durationMs,
        payloadBytes,
        estimatedTokens,
        cacheHit: response.meta.cacheHit,
        partitionsRead,
        argKeys
      });

      return response;
    }

    /**
     * Local simulated model tool-calling harness (zero real API calls).
     * Accepts a structured JSON request { toolCalls: [...], simulatedModelAnswer?: "..." }
     * or an array of tool calls, executes them sequentially, and optionally rehydrates
     * the simulated model reply locally.
     */
    function simulateModelToolCalls(request, callOpts) {
      const isArr = Array.isArray(request);
      const calls = isArr ? request : (Array.isArray(request?.toolCalls) ? request.toolCalls : []);
      const results = [];
      let succeeded = 0;
      let failed = 0;
      let totalPayloadBytes = 0;
      let totalEstimatedTokens = 0;
      let totalDurationMs = 0;

      for (const c of calls) {
        const res = executeTool(c, callOpts);
        results.push(res);
        if (res.ok) succeeded++;
        else failed++;
        totalPayloadBytes += res.meta?.payloadBytes || 0;
        totalEstimatedTokens += res.meta?.estimatedTokens || 0;
        totalDurationMs += res.meta?.durationMs || 0;
      }

      const out = {
        ok: failed === 0,
        simulated: true,
        results,
        summary: {
          totalCalls: calls.length,
          succeeded,
          failed,
          totalPayloadBytes,
          totalEstimatedTokens,
          totalDurationMs
        }
      };

      if (!isArr && request && request.simulatedModelAnswer !== undefined) {
        out.rehydratedAnswer = privacy.rehydrateResponse(
          request.simulatedModelAnswer,
          { mode: callOpts?.rehydrateMode || "name" }
        );
      }

      return out;
    }

    return Object.freeze({
      TOOLS_VERSION,
      listTools: (filterOpts) => registry.listTools(Object.assign(
        { allowedTools: allowedToolsSet ? Array.from(allowedToolsSet) : undefined, readOnlyOnly: true },
        filterOpts || {}
      )),
      exportToolDefinitions: (format, filterOpts) => registry.exportToolDefinitions(format, Object.assign(
        { allowedTools: allowedToolsSet ? Array.from(allowedToolsSet) : undefined, readOnlyOnly: true },
        filterOpts || {}
      )),
      executeTool,
      simulateModelToolCalls,
      rehydrateResponse: (resp, opts) => privacy.rehydrateResponse(resp, opts),
      resolveLocalAlias: (alias) => privacy.resolveLocalAlias(alias),
      getExecutionLogs: () => executionLogs.slice(),
      clearSimulationCache: () => simCache.clear(),
      getCacheSize: () => simCache.size,
      getPrivacyContext: () => privacy
    });
  }

  const SCAITools = Object.freeze({
    TOOLS_VERSION,
    createRuntime,
    normalizeToolCall
  });

  global.SCAITools = SCAITools;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = SCAITools;
  }
})(typeof window !== "undefined" ? window : globalThis);
