(function (global) {
  "use strict";

  const CLIENT_VERSION = "1.1";
  const DEFAULT_BENCHMARK_MODEL = "deepseek-v4.1-flash";
  const DEFAULT_REASONING_EFFORT = "low";
  const DEFAULT_TIMEOUT_MS = 30000;
  const DEFAULT_MAX_TOOL_CALLS = 6;
  const DEFAULT_MAX_MODEL_ROUNDS = 5;
  const DEFAULT_MAX_TOTAL_DURATION_MS = 45000;
  const DEFAULT_MAX_TOTAL_TOKENS = 12000;
  const DEFAULT_MAX_OUTPUT_TOKENS = 800;
  const DEFAULT_MAX_HISTORY_MESSAGES = 6;

  // Strict L1 whitelist of mutation diff fields safe to echo back to an external model
  const SAFE_MODEL_DIFF_FIELDS = new Set([
    "transitDays",
    "customsWaitDays",
    "putawayDays",
    "milestones.borderArrivalPlannedDate",
    "milestones.customsReleasePlannedDate",
    "milestones.marketStockAvailablePlannedDate",
    "earliestSellablePlannedDate",
    "compliance.status"
  ]);

  function getPrivacyMod() {
    if (global.SCAIPrivacy) return global.SCAIPrivacy;
    if (typeof require === "function") return require("./ai-privacy.js");
    throw new Error("SCAIPrivacy (shared/ai-privacy.js) not loaded");
  }

  function getToolsMod() {
    if (global.SCAITools) return global.SCAITools;
    if (typeof require === "function") return require("./ai-tools.js");
    throw new Error("SCAITools (shared/ai-tools.js) not loaded");
  }

  function getMutationsMod() {
    if (global.SCAIMutations) return global.SCAIMutations;
    if (typeof require === "function") return require("./ai-mutations.js");
    return null;
  }

  function getAuditMod() {
    if (global.SCAIAudit) return global.SCAIAudit;
    if (typeof require === "function") return require("./ai-audit.js");
    return null;
  }

  function stripSecretFromError(msg, secretValue) {
    let out = String(msg || "");
    if (secretValue && typeof secretValue === "string" && secretValue.length >= 6) {
      out = out.split(secretValue).join("[REDACTED_API_KEY]");
    }
    return out.replace(/\b(?:sk-[A-Za-z0-9_-]{8,}|Bearer\s+[A-Za-z0-9._-]{8,})\b/gi, "[REDACTED_API_KEY]");
  }

  /**
   * Distinguish explicit user modification intent from read-only queries / hypothetical questions.
   * Prevents temporary write grants from allowing unsolicited writes on normal queries.
   */
  function detectUserWriteIntent(userMessage, allowedOperations) {
    const text = String(userMessage || "").trim();
    if (!text || !Array.isArray(allowedOperations) || !allowedOperations.length) {
      return { allowedOps: [], hasWriteIntent: false };
    }
    // Purely hypothetical / analytical / read-only phrasing MUST NOT trigger writes
    const isHypotheticalOrQueryOnly = /(?:如果|假如|假设|要是|若.*会怎样|模拟一下|测算一下|帮我查|查询一下|看一下|检查一下|排查|分析一下|有没有|是否|请问.*为什么|帮我检索|联网查|搜一下|\bwhat\s+if\b|\bsuppose\b|\bsimulate\b|\bcheck\b|\banalyze\b|\bquery\b|\blist\b)/i.test(text)
      && !/(?:帮我调整|帮我改|请调整|请修改|请更新|直接调整|直接改|改成|改为|标记为|更新为|顺延|延后|推迟|提前.*天.*调整|\b(?:adjust|update|change|set|delay|postpone|mark)\b)/i.test(text);
    if (isHypotheticalOrQueryOnly) {
      return { allowedOps: [], hasWriteIntent: false };
    }

    const matched = [];
    for (const op of allowedOperations) {
      if (op === "shipment.adjust_eta" || op === "shipment.update_schedule") {
        const hasAction = /(?:调整|修改|改一下|改为|改成|延后|延期|顺延|推迟|提前|晚到|更新|\b(?:adjust|update|change|delay|postpone|push|move|shift)\b)/i.test(text);
        const hasDomain = /(?:发运|这批货|这笔货|货运|运输|预计|抵港|到港|清关|上架|晚到|延误|延期|提前|\d+\s*(?:天|days?|d\b)|SHP|shp_|shipment|eta|transit|arrival|customs)/i.test(text);
        if (hasAction && hasDomain) matched.push(op);
      } else if (op === "bom.update_compliance") {
        const hasAction = /(?:修改|更新|改为|改成|标记为|设为|调整|\b(?:update|change|set|mark)\b)/i.test(text);
        const hasDomain = /(?:合规|严重违规|违规风险|合格|尚未核实|severe|risk|qualified|unverified|compliance|compliant)/i.test(text);
        if (hasAction && hasDomain) matched.push(op);
      }
    }
    return { allowedOps: matched, hasWriteIntent: matched.length > 0 };
  }

  /**
   * Check whether free-text findings consist ONLY of deterministic known-entity alias replacements
   * (zero PII, zero doc numbers, zero prices, zero addresses, zero unindexed org heuristics).
   */
  function hasOnlyDeterministicEntityFindings(findings) {
    if (!Array.isArray(findings) || findings.length === 0) return true;
    return findings.every(f =>
      f && f.source === "vault_dictionary" && Boolean(f.alias)
      && (f.category === "identity.entity_name" || f.category === "identity.market_name")
    );
  }

  /**
   * Sanitize a committed or failed mutation result BEFORE sending it back to the external model.
   * Ensures free text (like compliance.reason), real names, contacts, and raw error strings NEVER leak!
   */
  function sanitizeMutationOutputForModel(mRes, privacy) {
    if (!mRes || !mRes.ok) {
      const safeMsg = privacy ? privacy.sanitizeError(mRes?.error || "Operation not executed").message : "Operation not executed";
      return {
        ok: false,
        executed: false,
        needsConfirmation: Boolean(mRes?.needsConfirmation),
        code: mRes?.code || "EXECUTION_FAILED",
        error: safeMsg
      };
    }

    const targetAlias = privacy.anonymizeId(
      mRes.module === "bom" ? "company" : "shipment",
      mRes.targetId,
      { displayName: mRes.targetDisplayName }
    );

    const safeDiff = (Array.isArray(mRes.diff) ? mRes.diff : []).map(d => {
      if (SAFE_MODEL_DIFF_FIELDS.has(d.field)) {
        return {
          field: d.field,
          label: d.label,
          before: d.before ?? null,
          after: d.after ?? null
        };
      }
      // Free text (e.g. compliance.reason, note) or unknown fields MUST be redacted before sending to model!
      return {
        field: d.field,
        label: d.label,
        updated: true,
        redacted: true
      };
    });

    const safeRisks = (mRes.businessImpact?.newStockoutRisks || []).map(r => ({
      marketId: privacy.anonymizeId("market", r.marketId, { displayName: r.marketName }),
      firstGapDateBefore: r.firstGapDateBefore || null,
      firstGapDateAfter: r.firstGapDateAfter || null,
      gapDelta: r.gapDelta
    }));

    return {
      ok: true,
      executed: true,
      idempotentReplay: Boolean(mRes.idempotentReplay),
      voucherId: mRes.voucher?.voucherId || null,
      targetId: targetAlias,
      diff: safeDiff,
      originalPlanPreserved: Boolean(mRes.after?.originalPlan),
      newStockoutRisks: safeRisks
    };
  }

  /**
   * Deterministic system-generated receipt independent of the model (P0 #4 & P1 #7).
   */
  function buildSystemMutationReceipt(mutationResults) {
    if (!Array.isArray(mutationResults) || !mutationResults.length) return "";
    return mutationResults.map(m => {
      const diffParts = (m.diff || []).map(d => `${d.label || d.field}：${d.before ?? "-"} → ${d.after ?? "-"}`);
      const risks = m.businessImpact?.newStockoutRisks || [];
      const riskText = risks.length
        ? `; Alert: ${risks.map(r => `${r.marketName} projected gap ${r.firstGapDateAfter || "-"}`).join(", ")}`
        : "";
      const origNote = m.after?.originalPlan ? " (original plan and confirmed actual dates preserved)" : "";
      return `Updated ${m.targetDisplayName} (Voucher ${m.voucher?.voucherId || "-"}): ${diffParts.join(", ")}${origNote}${riskText}.`;
    }).join("\n");
  }

  function containsUnverifiedMutationClaim(text) {
    if (typeof text !== "string" || !text.trim()) return false;
    // Detect positive claims of having modified/saved business data
    if (/(?:未执行|未能|无法|没有|并未|尚未|禁止).{0,12}(?:修改|调整|更新|延后|顺延|保存)/.test(text)
      || /\b(?:not|never|unable to|failed to|did not|cannot)\b.{0,18}\b(?:modified|updated|adjusted|delayed|saved|changed)\b/i.test(text)) {
      return false;
    }
    return /(?:已为您|已成功|已完成|已将|已把).{0,16}(?:修改|调整|更新|延后|顺延|推迟|保存|变更)/.test(text)
      || /(?:修改成功|调整完成|更新完成|已修改为|已调整为)/.test(text)
      || /\b(?:successfully\s+(?:updated|modified|adjusted|delayed|saved|changed)|has\s+been\s+(?:updated|modified|adjusted|delayed|saved)|have\s+(?:updated|modified|adjusted|delayed|saved))\b/i.test(text);
  }

  /* =========================================================================
     1. Vendor-Agnostic Model API Adapter (OpenAI-Compatible + Streaming + Mock)
     ========================================================================= */
  function buildChatUrl(baseUrl) {
    const clean = String(baseUrl || "").trim().replace(/\/+$/, "");
    if (!clean) return "";
    if (/\/chat\/completions$/i.test(clean)) return clean;
    return `${clean}/chat/completions`;
  }

  async function readOpenAiSseStream(response, onToken, signal) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8");
    let buffer = "";
    let content = "";
    let finishReason = null;
    let usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
    const toolCallsByIndex = new Map();

    try {
      while (true) {
        if (signal && signal.aborted) {
          throw Object.assign(new Error("Request cancelled"), { name: "AbortError" });
        }
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() || "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("data:")) continue;
          const payload = trimmed.slice(5).trim();
          if (!payload || payload === "[DONE]") continue;
          let chunk;
          try {
            chunk = JSON.parse(payload);
          } catch (_) {
            continue;
          }
          if (chunk.usage) {
            usage = {
              promptTokens: Number(chunk.usage.prompt_tokens) || usage.promptTokens,
              completionTokens: Number(chunk.usage.completion_tokens) || usage.completionTokens,
              totalTokens: Number(chunk.usage.total_tokens) || usage.totalTokens
            };
          }
          const choice = chunk.choices?.[0];
          if (!choice) continue;
          if (choice.finish_reason) finishReason = choice.finish_reason;
          const delta = choice.delta || {};
          if (typeof delta.content === "string" && delta.content) {
            content += delta.content;
            if (typeof onToken === "function") onToken(delta.content);
          }
          if (Array.isArray(delta.tool_calls)) {
            for (const tc of delta.tool_calls) {
              const idx = Number.isInteger(tc.index) ? tc.index : 0;
              if (!toolCallsByIndex.has(idx)) {
                toolCallsByIndex.set(idx, { id: tc.id || "", type: "function", function: { name: "", arguments: "" } });
              }
              const acc = toolCallsByIndex.get(idx);
              if (tc.id) acc.id = tc.id;
              if (tc.function?.name) acc.function.name += tc.function.name;
              if (tc.function?.arguments) acc.function.arguments += tc.function.arguments;
            }
          }
        }
      }
    } finally {
      try { reader.releaseLock(); } catch (_) {}
    }

    const toolCalls = Array.from(toolCallsByIndex.entries())
      .sort((a, b) => a[0] - b[0])
      .map(entry => entry[1]);

    return { content, toolCalls, usage, finishReason, streamed: true };
  }

  function createModelAdapter(initialConfig) {
    let config = {
      provider: initialConfig?.provider || "openai_compatible",
      baseUrl: String(initialConfig?.baseUrl || "").trim(),
      model: String(initialConfig?.model || DEFAULT_BENCHMARK_MODEL).trim(),
      reasoningEffort: initialConfig?.reasoningEffort || DEFAULT_REASONING_EFFORT,
      timeoutMs: Math.max(2000, Math.min(180000, Number(initialConfig?.timeoutMs) || DEFAULT_TIMEOUT_MS)),
      maxOutputTokens: Math.max(64, Math.min(4096, Number(initialConfig?.maxOutputTokens) || DEFAULT_MAX_OUTPUT_TOKENS)),
      stream: initialConfig?.stream !== false
    };
    let secretApiKey = String(initialConfig?.apiKey || "").trim();
    const customTransport = typeof initialConfig?.transport === "function" ? initialConfig.transport : null;

    function updateConfig(patch) {
      if (!patch || typeof patch !== "object") return getPublicConfig();
      if (patch.provider !== undefined) config.provider = String(patch.provider || "openai_compatible").trim();
      if (patch.baseUrl !== undefined) config.baseUrl = String(patch.baseUrl || "").trim();
      if (patch.model !== undefined) config.model = String(patch.model || DEFAULT_BENCHMARK_MODEL).trim();
      if (patch.reasoningEffort !== undefined) config.reasoningEffort = String(patch.reasoningEffort || "low").trim();
      if (patch.timeoutMs !== undefined) config.timeoutMs = Math.max(2000, Math.min(180000, Number(patch.timeoutMs) || DEFAULT_TIMEOUT_MS));
      if (patch.maxOutputTokens !== undefined) config.maxOutputTokens = Math.max(64, Math.min(4096, Number(patch.maxOutputTokens) || DEFAULT_MAX_OUTPUT_TOKENS));
      if (patch.stream !== undefined) config.stream = Boolean(patch.stream);
      if (patch.apiKey !== undefined) secretApiKey = String(patch.apiKey || "").trim();
      return getPublicConfig();
    }

    function getPublicConfig() {
      return {
        provider: config.provider,
        baseUrl: config.baseUrl,
        model: config.model,
        reasoningEffort: config.reasoningEffort,
        timeoutMs: config.timeoutMs,
        maxOutputTokens: config.maxOutputTokens,
        stream: config.stream,
        hasApiKey: Boolean(secretApiKey),
        hasCustomTransport: Boolean(customTransport)
      };
    }

    function isConfigured() {
      return Boolean(customTransport || (config.baseUrl && secretApiKey && config.model));
    }

    async function complete(params) {
      const p = params || {};
      const startTs = Date.now();

      if (!isConfigured()) {
        return {
          ok: false,
          durationMs: 0,
          usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
          error: { code: "NOT_CONFIGURED", message: "Model API is not configured. Enter Base URL, API Key, and Model in Settings." }
        };
      }

      const body = {
        model: config.model,
        messages: p.messages || [],
        max_tokens: p.maxOutputTokens || config.maxOutputTokens,
        temperature: typeof p.temperature === "number" ? p.temperature : 0.2,
        stream: Boolean(config.stream && !p.disableStream)
      };
      if (Array.isArray(p.tools) && p.tools.length > 0) {
        body.tools = p.tools;
        body.tool_choice = "auto";
      }
      if (config.reasoningEffort && config.reasoningEffort !== "none") {
        body.reasoning_effort = config.reasoningEffort;
      }

      const bodyStr = JSON.stringify(body);
      if (secretApiKey && secretApiKey.length >= 6 && bodyStr.includes(secretApiKey)) {
        return {
          ok: false,
          durationMs: Date.now() - startTs,
          usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
          error: { code: "SECRET_LEAK_BLOCKED", message: "Blocked: API key detected in request body" }
        };
      }

      const controller = typeof AbortController === "function" ? new AbortController() : null;
      let timedOut = false;
      let timerId = null;
      const onExternalAbort = () => { if (controller) controller.abort(); };
      if (p.signal) {
        if (p.signal.aborted) {
          return {
            ok: false,
            cancelled: true,
            durationMs: 0,
            usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
            error: { code: "CANCELLED", message: "Request cancelled" }
          };
        }
        if (typeof p.signal.addEventListener === "function") {
          p.signal.addEventListener("abort", onExternalAbort, { once: true });
        }
      }
      const effectiveTimeout = Math.max(500, Math.min(config.timeoutMs, Number(p.timeoutMs) || config.timeoutMs));
      if (controller && typeof setTimeout === "function") {
        timerId = setTimeout(() => {
          timedOut = true;
          controller.abort();
        }, effectiveTimeout);
      }

      try {
        if (customTransport) {
          const resp = await customTransport({
            url: buildChatUrl(config.baseUrl || "https://mock.local/v1"),
            headers: { "Content-Type": "application/json" },
            body,
            onToken: p.onToken
          }, controller ? controller.signal : p.signal);

          if ((controller && controller.signal.aborted) || (p.signal && p.signal.aborted)) {
            return {
              ok: false,
              cancelled: !timedOut,
              timedOut,
              durationMs: Date.now() - startTs,
              usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
              error: { code: timedOut ? "TIMEOUT" : "CANCELLED", message: timedOut ? "Model response timed out" : "Request cancelled" }
            };
          }

          if (resp && resp.ok === false) {
            return {
              ok: false,
              timedOut: Boolean(resp.timedOut || resp.error?.code === "TIMEOUT"),
              cancelled: Boolean(resp.cancelled || resp.error?.code === "CANCELLED"),
              durationMs: Date.now() - startTs,
              usage: resp.usage || { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
              error: {
                code: resp.error?.code || "API_ERROR",
                message: stripSecretFromError(resp.error?.message || "Model service returned an error", secretApiKey)
              }
            };
          }

          return {
            ok: true,
            content: typeof resp?.content === "string" ? resp.content : "",
            toolCalls: Array.isArray(resp?.toolCalls) ? resp.toolCalls : [],
            usage: {
              promptTokens: Number(resp?.usage?.promptTokens) || 0,
              completionTokens: Number(resp?.usage?.completionTokens) || 0,
              totalTokens: Number(resp?.usage?.totalTokens) || ((Number(resp?.usage?.promptTokens) || 0) + (Number(resp?.usage?.completionTokens) || 0))
            },
            finishReason: resp?.finishReason || "stop",
            streamed: Boolean(resp?.streamed),
            durationMs: Date.now() - startTs
          };
        }

        if (typeof fetch !== "function") {
          return {
            ok: false,
            durationMs: Date.now() - startTs,
            usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
            error: { code: "NO_FETCH", message: "Fetch API is not available in this environment" }
          };
        }

        const url = buildChatUrl(config.baseUrl);
        if (!/^https?:\/\//i.test(url)) {
          return {
            ok: false,
            durationMs: Date.now() - startTs,
            usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
            error: { code: "INVALID_URL", message: "API Base URL must start with https:// or http://localhost" }
          };
        }

        const response = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${secretApiKey}`
          },
          body: bodyStr,
          signal: controller ? controller.signal : undefined
        });

        if (!response.ok) {
          let errText = `HTTP ${response.status}`;
          try {
            const rawErr = await response.text();
            if (rawErr) errText += `: ${rawErr.slice(0, 240)}`;
          } catch (_) {}
          return {
            ok: false,
            durationMs: Date.now() - startTs,
            usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
            error: { code: "API_HTTP_ERROR", message: stripSecretFromError(errText, secretApiKey) }
          };
        }

        const contentType = (response.headers && response.headers.get("content-type")) || "";
        if (body.stream && contentType.includes("text/event-stream") && response.body && typeof response.body.getReader === "function") {
          const streamed = await readOpenAiSseStream(response, p.onToken, controller ? controller.signal : p.signal);
          return Object.assign({ ok: true, durationMs: Date.now() - startTs }, streamed);
        }

        const data = await response.json();
        const choice = data.choices?.[0] || {};
        const msg = choice.message || {};
        const content = typeof msg.content === "string" ? msg.content : "";
        if (content && typeof p.onToken === "function") p.onToken(content);
        return {
          ok: true,
          content,
          toolCalls: Array.isArray(msg.tool_calls) ? msg.tool_calls : [],
          usage: {
            promptTokens: Number(data.usage?.prompt_tokens) || 0,
            completionTokens: Number(data.usage?.completion_tokens) || 0,
            totalTokens: Number(data.usage?.total_tokens) || 0
          },
          finishReason: choice.finish_reason || "stop",
          streamed: false,
          durationMs: Date.now() - startTs
        };
      } catch (err) {
        const isAbort = err?.name === "AbortError" || (controller && controller.signal.aborted);
        return {
          ok: false,
          cancelled: isAbort && !timedOut,
          timedOut,
          durationMs: Date.now() - startTs,
          usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
          error: {
            code: timedOut ? "TIMEOUT" : (isAbort ? "CANCELLED" : "NETWORK_ERROR"),
            message: timedOut
              ? `Request timed out (>${effectiveTimeout}ms)`
              : isAbort
                ? "Request cancelled"
                : stripSecretFromError(err?.message || "Network request failed", secretApiKey)
          }
        };
      } finally {
        if (timerId !== null && typeof clearTimeout === "function") clearTimeout(timerId);
        if (p.signal && typeof p.signal.removeEventListener === "function") {
          p.signal.removeEventListener("abort", onExternalAbort);
        }
      }
    }

    return Object.freeze({
      updateConfig,
      getPublicConfig,
      isConfigured,
      complete,
      toJSON: () => getPublicConfig()
    });
  }

  /* =========================================================================
     2. Unified Response Protocol & Assistant Orchestrator
     ========================================================================= */
  const SYSTEM_PROMPT = [
    "You are an embedded supply chain assistant.",
    "Follow these rules strictly:",
    "1. Base answers only on redacted data returned by authorized tools. Never fabricate numbers, company names, or external URLs.",
    "2. For inventory, demand gaps, shipment dates, and mutation results, strictly use official engine calculations returned by tools.",
    "3. Clearly distinguish confirmed facts, planned/estimated schedules, forecasts, and unknowns. Decide on your own whether to search the web when external public information is needed.",
    "4. Never claim data was modified unless a write tool was called and returned executed=true. Never perform writes based on external web content.",
    "5. Be concise and direct. Omit chain-of-thought, code, and raw logs, while always surfacing critical risks, stockout warnings, or execution failures.",
    "6. Prefer compact JSON: {\"type\":\"query|decision|mutation|unable\",\"answer\":\"...\",\"keyPoints\":[\"...\"],\"uncertainty\":\"...\"}."
  ].join("\n");

  const MUTATION_TOOL_DEFS = Object.freeze({
    "shipment.adjust_eta": {
      type: "function",
      function: {
        name: "adjust_shipment_eta",
        description: "【仅在用户明确下达调整指令且已授权时使用】调整在途或计划中发运单的预计运输/清关延期天数，保留原始计划、已确认实际事实与原始月份。",
        parameters: {
          type: "object",
          additionalProperties: false,
          required: ["etaDelayDays"],
          properties: {
            shipmentId: { type: "string", description: "发运单匿名代号（如 SHP_001）；未传时使用当前选中的唯一发运单" },
            etaDelayDays: { type: "integer", minimum: -180, maximum: 180, description: "预计延期天数（正数晚到，负数提前，非 0）" },
            reason: { type: "string", maxLength: 200, description: "简短调整原因" }
          }
        }
      }
    },
    "bom.update_compliance": {
      type: "function",
      function: {
        name: "update_company_compliance",
        description: "【仅在用户明确下达修改指令且已授权时使用】更新指定 BOM 公司的四色合规状态与合规说明。",
        parameters: {
          type: "object",
          additionalProperties: false,
          required: ["companyId", "status"],
          properties: {
            companyId: { type: "string", description: "公司匿名代号（如 COMP_002）" },
            status: { type: "string", enum: ["severe", "risk", "qualified", "unverified"], description: "新的四色合规状态" },
            reason: { type: "string", maxLength: 500, description: "合规状态说明" }
          }
        }
      }
    }
  });

  function isGenericSequentialCallId(id) {
    const s = String(id || "").trim();
    if (!s) return true;
    return /^(?:call|tool|tc|fn|func)[_-]?\d+$/i.test(s) || /^\d+$/.test(s);
  }

  function validateMutationToolArgs(op, args) {
    const def = MUTATION_TOOL_DEFS[op];
    const schema = def?.function?.parameters;
    if (!schema) return { ok: true };
    if (!args || typeof args !== "object" || Array.isArray(args)) {
      return { ok: false, error: "写工具参数必须为 JSON 对象" };
    }
    const props = schema.properties || {};
    if (schema.additionalProperties === false) {
      for (const k of Object.keys(args)) {
        if (!Object.prototype.hasOwnProperty.call(props, k)) {
          return { ok: false, error: `写工具不支持的参数字段：${k}` };
        }
      }
    }
    if (Array.isArray(schema.required)) {
      for (const reqKey of schema.required) {
        if (args[reqKey] === undefined || args[reqKey] === null || args[reqKey] === "") {
          return { ok: false, error: `写工具缺少必填参数：${reqKey}` };
        }
      }
    }
    for (const [k, rule] of Object.entries(props)) {
      if (args[k] === undefined) continue;
      const v = args[k];
      if (rule.type === "integer") {
        if (typeof v !== "number" || !Number.isFinite(v) || !Number.isInteger(v)) {
          return { ok: false, error: `参数 ${k} 必须为整数` };
        }
        if (rule.minimum !== undefined && v < rule.minimum) return { ok: false, error: `参数 ${k} 不能小于 ${rule.minimum}` };
        if (rule.maximum !== undefined && v > rule.maximum) return { ok: false, error: `参数 ${k} 不能大于 ${rule.maximum}` };
      } else if (rule.type === "string") {
        if (typeof v !== "string") return { ok: false, error: `参数 ${k} 必须为字符串` };
        if (rule.enum && !rule.enum.includes(v)) return { ok: false, error: `参数 ${k} 取值不在允许范围内` };
        if (rule.maxLength !== undefined && v.length > rule.maxLength) return { ok: false, error: `参数 ${k} 长度不能超过 ${rule.maxLength}` };
      }
    }
    return { ok: true };
  }

  function stripThinkingTags(text) {
    return String(text || "")
      .replace(/<think>[\s\S]*?<\/think>/gi, "")
      .replace(/<reasoning>[\s\S]*?<\/reasoning>/gi, "")
      .trim();
  }

  function parseStructuredModelOutput(rawText, fallbackType) {
    const cleaned0 = stripThinkingTags(rawText);
    const cleaned = cleaned0.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
    if (cleaned.startsWith("{") && cleaned.endsWith("}")) {
      try {
        const obj = JSON.parse(cleaned);
        if (obj && typeof obj.answer === "string") {
          const validTypes = ["query", "decision", "mutation", "unable"];
          return {
            type: validTypes.includes(obj.type) ? obj.type : (fallbackType || "query"),
            answer: stripThinkingTags(obj.answer),
            keyPoints: Array.isArray(obj.keyPoints) ? obj.keyPoints.map(x => stripThinkingTags(String(x))).filter(Boolean).slice(0, 6) : [],
            uncertainty: typeof obj.uncertainty === "string" ? stripThinkingTags(obj.uncertainty) : ""
          };
        }
      } catch (_) {}
    }
    return {
      type: fallbackType || "query",
      answer: cleaned0,
      keyPoints: [],
      uncertainty: ""
    };
  }

  function createAssistant(config) {
    const cfg = config || {};
    const PrivacyMod = getPrivacyMod();
    const ToolsMod = getToolsMod();
    const MutationsMod = getMutationsMod();
    const AuditMod = getAuditMod();

    const storage = cfg.storage !== undefined ? cfg.storage : (typeof localStorage !== "undefined" ? localStorage : null);
    const auditStore = cfg.auditStore || (AuditMod ? AuditMod.createAuditStore({ storage }) : null);
    const toolRuntime = cfg.toolRuntime || ToolsMod.createRuntime({
      storage,
      partitionProvider: cfg.partitionProvider,
      bomRaw: cfg.bomRaw,
      salesRaw: cfg.salesRaw,
      workspace: cfg.workspace,
      scope: cfg.scope,
      allowedScopes: cfg.allowedScopes,
      allowedTools: cfg.allowedTools,
      grants: cfg.grants,
      searchPolicy: cfg.searchPolicy
    });
    const privacy = toolRuntime.getPrivacyContext();
    const writeController = cfg.writeController || (MutationsMod ? MutationsMod.createWriteController({
      storage,
      auditStore,
      onPersisted: cfg.onDataMutated
    }) : null);
    const modelAdapter = cfg.modelAdapter || createModelAdapter(cfg.modelConfig || {});

    // Live-updatable per-request execution budgets (P1 #6)
    const budgets = {
      maxToolCalls: Math.max(1, Math.min(12, Number(cfg.maxToolCalls) || DEFAULT_MAX_TOOL_CALLS)),
      maxModelRounds: Math.max(1, Math.min(12, Number(cfg.maxModelRounds) || DEFAULT_MAX_MODEL_ROUNDS)),
      maxTotalDurationMs: Math.max(2000, Math.min(300000, Number(cfg.maxTotalDurationMs) || DEFAULT_MAX_TOTAL_DURATION_MS)),
      maxTotalTokens: Math.max(200, Math.min(100000, Number(cfg.maxTotalTokens) || DEFAULT_MAX_TOTAL_TOKENS)),
      maxHistoryMessages: Math.max(2, Math.min(20, Number(cfg.maxHistoryMessages) || DEFAULT_MAX_HISTORY_MESSAGES))
    };

    function updateBudgets(patch) {
      if (!patch || typeof patch !== "object") return Object.assign({}, budgets);
      if (patch.maxToolCalls !== undefined) budgets.maxToolCalls = Math.max(1, Math.min(12, Number(patch.maxToolCalls) || DEFAULT_MAX_TOOL_CALLS));
      if (patch.maxModelRounds !== undefined) budgets.maxModelRounds = Math.max(1, Math.min(12, Number(patch.maxModelRounds) || DEFAULT_MAX_MODEL_ROUNDS));
      if (patch.maxTotalDurationMs !== undefined) budgets.maxTotalDurationMs = Math.max(2000, Math.min(300000, Number(patch.maxTotalDurationMs) || DEFAULT_MAX_TOTAL_DURATION_MS));
      if (patch.maxTotalTokens !== undefined) budgets.maxTotalTokens = Math.max(200, Math.min(100000, Number(patch.maxTotalTokens) || DEFAULT_MAX_TOTAL_TOKENS));
      if (patch.maxHistoryMessages !== undefined) budgets.maxHistoryMessages = Math.max(2, Math.min(20, Number(patch.maxHistoryMessages) || DEFAULT_MAX_HISTORY_MESSAGES));
      return Object.assign({}, budgets);
    }

    let inFlightRequest = null;

    function buildActiveToolsList(turnAllowedWriteOps) {
      const list = toolRuntime.exportToolDefinitions("openai");
      if (Array.isArray(turnAllowedWriteOps) && turnAllowedWriteOps.length > 0) {
        for (const op of turnAllowedWriteOps) {
          if (MUTATION_TOOL_DEFS[op]) {
            list.push(MUTATION_TOOL_DEFS[op]);
          }
        }
      }
      return list;
    }

    function buildAnonymizedContextNote(activeContext, turnAllowedWriteOps) {
      if (!activeContext || (!activeContext.module && !activeContext.entity)) return "";
      const parts = [];
      if (activeContext.module) parts.push(`当前所在模块：${activeContext.module}`);
      if (activeContext.entity && activeContext.entity.id) {
        const k = activeContext.entity.kind;
        const typeMap = { company: "company", factory: "factory", diagram: "diagram", shipment: "shipment", market: "market", batch: "batch" };
        const alias = privacy.anonymizeId(typeMap[k] || "entity", activeContext.entity.id, { displayName: activeContext.entity.name || "" });
        parts.push(`当前选中对象：kind=${k}，匿名ID=${alias}`);
      }
      parts.push(`本轮允许写入：${turnAllowedWriteOps.length ? turnAllowedWriteOps.join(",") : "无（只读）"}`);
      return `[当前界面上下文]\n${parts.join("；")}`;
    }

    function formatMutationList(mutationResults) {
      return mutationResults.map(m => ({
        module: m.module,
        targetId: m.targetId,
        targetDisplayName: m.targetDisplayName,
        diff: m.diff,
        originalPlan: m.after?.originalPlan || null,
        latestMilestones: m.after?.milestones || null,
        businessImpact: m.businessImpact,
        voucherId: m.voucher?.voucherId || null,
        undoable: Boolean(m.voucher?.undoable)
      }));
    }

    function collectEntityRefs(rehydratedRefs, mutationResults) {
      const map = new Map();
      for (const r of (rehydratedRefs || [])) {
        map.set(`${r.type}:${r.rawId}`, r);
      }
      for (const m of (mutationResults || [])) {
        const t = m.module === "bom" ? "company" : "shipment";
        map.set(`${t}:${m.targetId}`, { type: t, rawId: m.targetId, displayName: m.targetDisplayName });
      }
      return Array.from(map.values());
    }

    async function ask(params) {
      const p = params || {};
      const userMessage = String(p.userMessage || "").trim();
      const startTs = Date.now();
      const requestId = `req_${startTs.toString(36)}_${Math.random().toString(36).slice(2, 6)}`;

      if (!userMessage) {
        return { ok: false, type: "unable", answer: "请输入问题或指令。", error: { code: "EMPTY_INPUT", message: "输入不能为空" } };
      }

      const reqFingerprint = `${userMessage}::${p.activeContext?.entity?.id || ""}`;
      if (inFlightRequest && inFlightRequest.fingerprint === reqFingerprint) {
        return {
          ok: false,
          type: "unable",
          answer: "相同请求正在处理中，请勿重复提交。",
          error: { code: "DUPLICATE_IN_FLIGHT", message: "相同请求正在执行中" }
        };
      }
      if (inFlightRequest) {
        return {
          ok: false,
          type: "unable",
          answer: "上一条请求仍在执行中，请等待完成或先取消后再发送。",
          error: { code: "BUSY", message: "已有进行中的请求" }
        };
      }

      const activeToken = { fingerprint: reqFingerprint };
      inFlightRequest = activeToken;

      const onStatus = typeof p.onStatus === "function" ? p.onStatus : null;
      const onToken = typeof p.onToken === "function" ? p.onToken : null;
      const onMutationCommitted = typeof p.onMutationCommitted === "function" ? p.onMutationCommitted : null;
      const signal = p.signal || null;

      try {
        // 1. Privacy check on user input (DO NOT unconditionally bypass userConfirmed! P0 #1)
        const userConfirmed = p.userConfirmed === true;
        const userSan = privacy.sanitizeText(userMessage, {
          sourceKind: "user_input",
          userConfirmed
        });
        if (!userSan.allowed) {
          if (userSan.decision === "block") {
            return {
              ok: false,
              type: "unable",
              answer: "输入包含高敏感凭据或受限信息，已被隐私保护层阻断，未向外部模型发送。",
              error: { code: "PRIVACY_BLOCKED", message: userSan.blockedReason || "高敏感输入已阻断" },
              metrics: { durationMs: Date.now() - startTs, toolCallCount: 0, modelRounds: 0, usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } }
            };
          }
          // Only auto-proceed without extra confirmation when findings are strictly deterministic vault-entity alias substitutions
          if (!hasOnlyDeterministicEntityFindings(userSan.findings)) {
            return {
              ok: false,
              type: "unable",
              requiresConfirmation: true,
              redactedPreview: userSan.redactedPreview,
              confirmationReason: userSan.confirmationReason || "检测到输入包含潜在敏感信息，请确认脱敏预览后再发送。",
              answer: "检测到输入包含潜在敏感信息（如联系方式、地址、单据号或价格），请确认脱敏预览后再发送。",
              error: { code: "PRIVACY_REQUIRES_CONFIRMATION", message: userSan.confirmationReason || "需要人工确认脱敏预览" },
              metrics: { durationMs: Date.now() - startTs, toolCallCount: 0, modelRounds: 0, usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } }
            };
          }
        }
        const safeUserText = userSan.allowed ? userSan.text : userSan.redactedPreview;

        // 2. Bounded & sanitized conversation history (respect userConfirmed!)
        const rawHistory = Array.isArray(p.history) ? p.history.slice(-budgets.maxHistoryMessages) : [];
        const histRes = privacy.prepareConversationHistory(rawHistory, { userConfirmed });
        if (!histRes.allowed) {
          if (histRes.decision === "block") {
            return {
              ok: false,
              type: "unable",
              answer: "对话历史包含高敏感凭据，已被隐私保护层阻断。",
              error: { code: "PRIVACY_BLOCKED", message: histRes.reasons.join("；") }
            };
          }
          if (!hasOnlyDeterministicEntityFindings(histRes.findings)) {
            return {
              ok: false,
              type: "unable",
              requiresConfirmation: true,
              redactedPreview: histRes.redactedPreview,
              confirmationReason: "对话历史包含潜在敏感信息，请确认脱敏后再发送或新建对话。",
              answer: "对话历史包含潜在敏感信息，请确认脱敏后再发送，或点击「新对话」重新开始。",
              error: { code: "PRIVACY_REQUIRES_CONFIRMATION", message: histRes.reasons.join("；") }
            };
          }
        }
        const safeHistory = histRes.allowed ? (histRes.messages || []) : (histRes.redactedPreview || []);

        // 3. Determine turn-level write eligibility: requires BOTH active grant AND explicit user write intent (P0 #5)
        const writeStatus = writeController ? writeController.getStatus() : { mode: "read_only", activeGrant: null };
        const grantedOps = (writeStatus.mode === "authorized_write" && writeStatus.activeGrant)
          ? writeStatus.activeGrant.allowedOperations
          : [];
        const intentCheck = detectUserWriteIntent(userMessage, grantedOps);
        const turnAllowedWriteOps = (p.allowWriteForThisTurn === false)
          ? []
          : (p.allowWriteForThisTurn === true ? grantedOps.slice() : intentCheck.allowedOps);

        const messages = [{ role: "system", content: SYSTEM_PROMPT }];
        const ctxNote = buildAnonymizedContextNote(p.activeContext, turnAllowedWriteOps);
        if (ctxNote) messages.push({ role: "system", content: ctxNote });
        for (const h of safeHistory) messages.push(h);
        messages.push({ role: "user", content: safeUserText });

        const availableTools = buildActiveToolsList(turnAllowedWriteOps);
        const toolTraces = [];
        const dataCards = [];
        const mutationResults = [];
        const externalSources = [];
        const internalDataRefs = [];
        const executedWriteCallIds = new Map();       // toolCallId -> sanitized output
        const executedWriteSignatures = new Map();    // semantic sig -> sanitized output
        let lastDataVersion = null;
        let lastAsOfDate = null;
        let totalPromptTokens = 0;
        let totalCompletionTokens = 0;
        let totalTokens = 0;
        let modelRounds = 0;
        let toolCallCount = 0;
        let failedToolCalls = 0;
        let streamedAny = false;
        let finalRawContent = "";
        let earlyAbortInfo = null; // { code, message, cancelled, timedOut, budgetExceeded }

        // 4. Multi-step Tool Calling Loop with 4-way Budget Enforcement (P1 #6)
        while (true) {
          if (signal && signal.aborted) {
            earlyAbortInfo = { code: "CANCELLED", message: "用户已取消", cancelled: true };
            break;
          }
          if (modelRounds >= budgets.maxModelRounds) {
            earlyAbortInfo = { code: "BUDGET_MAX_ROUNDS", message: `已达单次请求最大模型轮数上限（${budgets.maxModelRounds}）`, budgetExceeded: "maxModelRounds" };
            break;
          }
          const elapsed = Date.now() - startTs;
          if (elapsed >= budgets.maxTotalDurationMs) {
            earlyAbortInfo = { code: "BUDGET_MAX_DURATION", message: `已达单次请求总耗时上限（${budgets.maxTotalDurationMs}ms）`, budgetExceeded: "maxTotalDurationMs", timedOut: true };
            break;
          }
          if (totalTokens >= budgets.maxTotalTokens) {
            earlyAbortInfo = { code: "BUDGET_MAX_TOKENS", message: `已达单次请求累计 Token 上限（${budgets.maxTotalTokens}）`, budgetExceeded: "maxTotalTokens" };
            break;
          }

          modelRounds += 1;
          if (onStatus) onStatus({ stage: "thinking", round: modelRounds, label: modelRounds === 1 ? "Analyzing…" : "Summarizing…" });

          const remainingMs = Math.max(500, budgets.maxTotalDurationMs - (Date.now() - startTs));
          const allowToolsThisRound = toolCallCount < budgets.maxToolCalls && modelRounds < budgets.maxModelRounds;
          const roundTools = allowToolsThisRound ? availableTools : [];

          const modelResp = await modelAdapter.complete({
            messages,
            tools: roundTools,
            timeoutMs: remainingMs,
            onToken: (delta) => {
              // Suppress streaming unverified mutation claims when no mutation actually executed
              if (onToken) onToken(delta);
            },
            signal
          });

          totalPromptTokens += modelResp.usage?.promptTokens || 0;
          totalCompletionTokens += modelResp.usage?.completionTokens || 0;
          totalTokens += modelResp.usage?.totalTokens || 0;
          if (modelResp.streamed) streamedAny = true;

          if (!modelResp.ok) {
            earlyAbortInfo = {
              code: modelResp.error?.code || "API_ERROR",
              message: modelResp.error?.message || "模型调用失败",
              cancelled: Boolean(modelResp.cancelled),
              timedOut: Boolean(modelResp.timedOut)
            };
            break;
          }

          const pendingCalls = Array.isArray(modelResp.toolCalls) ? modelResp.toolCalls : [];
          if (pendingCalls.length === 0) {
            finalRawContent = modelResp.content || "";
            break;
          }

          // If model still returns tool_calls after tools were disabled by budget, exit cleanly without looping!
          if (!allowToolsThisRound) {
            earlyAbortInfo = { code: "BUDGET_MAX_TOOLS", message: `已达工具调用或轮数预算上限（${budgets.maxToolCalls} 次工具 / ${budgets.maxModelRounds} 轮）`, budgetExceeded: "maxToolCalls" };
            break;
          }

          messages.push({
            role: "assistant",
            content: modelResp.content || "",
            tool_calls: pendingCalls
          });

          for (const tc of pendingCalls) {
            if (signal && signal.aborted) {
              earlyAbortInfo = { code: "CANCELLED", message: "用户已取消", cancelled: true };
              break;
            }
            if (toolCallCount >= budgets.maxToolCalls) {
              failedToolCalls += 1;
              const limitErr = { ok: false, error: { code: "TOOL_CALL_LIMIT", message: `已达到单轮工具调用次数上限（${budgets.maxToolCalls}）` } };
              messages.push({ role: "tool", tool_call_id: tc.id || `call_${toolCallCount}`, content: JSON.stringify(limitErr) });
              toolTraces.push({ tool: tc.function?.name || tc.name, ok: false, errorCode: "TOOL_CALL_LIMIT" });
              continue;
            }

            toolCallCount += 1;
            const norm = ToolsMod.normalizeToolCall(tc);
            const rawToolName = tc.function?.name || tc.name || "unknown";
            const callId = tc.id ? String(tc.id) : `call_${toolCallCount}`;

            if (!norm.ok) {
              failedToolCalls += 1;
              const badArgsOut = {
                ok: false,
                executed: false,
                code: "INVALID_ARGS",
                error: norm.error || "工具调用参数无效"
              };
              toolTraces.push({ tool: rawToolName, ok: false, executed: false, errorCode: "INVALID_ARGS" });
              messages.push({
                role: "tool",
                tool_call_id: callId,
                content: JSON.stringify(badArgsOut)
              });
              continue;
            }

            const toolName = norm.name;
            const toolArgs = norm.args;

            if (onStatus) onStatus({ stage: "tool", tool: toolName, count: toolCallCount, label: `Running ${toolName}…` });

            let toolOutputForModel;

            // Route A: Authorized Write Tools (Intent + Idempotency + Full Sanitization!)
            if (toolName === "adjust_shipment_eta" || toolName === "update_company_compliance") {
              const op = toolName === "adjust_shipment_eta" ? "shipment.adjust_eta" : "bom.update_compliance";

              // Guard 1: Active authorization & explicit user intent check (P0 #5)
              if (!writeController || writeController.getStatus().mode !== "authorized_write") {
                failedToolCalls += 1;
                toolOutputForModel = sanitizeMutationOutputForModel({
                  ok: false,
                  needsConfirmation: true,
                  code: "READ_ONLY_MODE",
                  error: "当前处于只读模式，禁止修改业务数据。"
                }, privacy);
                toolTraces.push({ tool: toolName, ok: false, executed: false, errorCode: "READ_ONLY_MODE" });
              }
              else if (!turnAllowedWriteOps.includes(op)) {
                failedToolCalls += 1;
                toolOutputForModel = sanitizeMutationOutputForModel({
                  ok: false,
                  needsConfirmation: true,
                  code: "NO_USER_WRITE_INTENT",
                  error: "当前用户提问未包含明确的业务修改指令，即使存在临时授权也不允许主动修改。"
                }, privacy);
                toolTraces.push({ tool: toolName, ok: false, executed: false, errorCode: "NO_USER_WRITE_INTENT" });
              }
              // Guard 2b & 3: Strict mutation tool schema validation (C5) + Idempotency check (P0 #2 + C4)
              else {
                const argCheck = validateMutationToolArgs(op, toolArgs);
                if (!argCheck.ok) {
                  failedToolCalls += 1;
                  toolOutputForModel = sanitizeMutationOutputForModel({
                    ok: false,
                    code: "INVALID_ARGS",
                    error: argCheck.error
                  }, privacy);
                  toolTraces.push({ tool: toolName, ok: false, executed: false, errorCode: "INVALID_ARGS" });
                } else {
                  const targetHint = toolArgs.shipmentId || toolArgs.companyId || p.activeContext?.entity?.id || "";
                  const semanticSig = `${op}::${targetHint}::${JSON.stringify(toolArgs)}`;
                  if (executedWriteCallIds.has(callId)) {
                    toolOutputForModel = Object.assign({}, executedWriteCallIds.get(callId), { idempotentReplay: true });
                    toolTraces.push({ tool: toolName, ok: true, executed: true, idempotentReplay: true, voucherId: toolOutputForModel.voucherId });
                  } else if (executedWriteSignatures.has(semanticSig)) {
                    toolOutputForModel = Object.assign({}, executedWriteSignatures.get(semanticSig), { idempotentReplay: true });
                    toolTraces.push({ tool: toolName, ok: true, executed: true, idempotentReplay: true, voucherId: toolOutputForModel.voucherId });
                  } else {
                    const rawTcId = tc.id ? String(tc.id).trim() : "";
                    const idempotencyKey = (rawTcId && !isGenericSequentialCallId(rawTcId))
                      ? `call::${rawTcId}`
                      : (rawTcId ? `${requestId}::call::${rawTcId}::${semanticSig}` : `${requestId}::${semanticSig}`);
                    const mRes = writeController.executeAuthorizedMutation(Object.assign({}, toolArgs, {
                      operation: op,
                      idempotencyKey,
                      toolCallId: rawTcId || null,
                      userInstruction: userMessage,
                      activeContext: p.activeContext?.entity || null,
                      asOfDate: p.asOfDate
                    }), {
                      privacyContext: privacy,
                      modelId: modelAdapter.getPublicConfig().model,
                      provider: modelAdapter.getPublicConfig().provider
                    });

                    toolOutputForModel = sanitizeMutationOutputForModel(mRes, privacy);

                    if (!mRes.ok) {
                      failedToolCalls += 1;
                    } else {
                      if (!mRes.idempotentReplay) {
                        mutationResults.push(mRes);
                        // Emit immediate system receipt right after commit, independent of Round 2! (P0 #4)
                        if (onMutationCommitted) {
                          try {
                            onMutationCommitted({
                              mutation: formatMutationList([mRes])[0],
                              receiptText: buildSystemMutationReceipt([mRes])
                            });
                          } catch (_) {}
                        }
                      }
                      executedWriteCallIds.set(callId, toolOutputForModel);
                      executedWriteSignatures.set(semanticSig, toolOutputForModel);
                    }
                    toolTraces.push({
                      tool: toolName,
                      ok: Boolean(mRes.ok),
                      executed: Boolean(mRes.executed),
                      idempotentReplay: Boolean(mRes.idempotentReplay),
                      voucherId: mRes.voucher?.voucherId || null,
                      errorCode: mRes.code || null
                    });
                  }
                }
              }
            }
            // Route C: Standard Stage 2 Read-Only Tools
            else {
              const tRes = toolRuntime.executeTool(tc);
              if (!tRes.ok) failedToolCalls += 1;
              else {
                if (tRes.meta?.dataVersion) lastDataVersion = tRes.meta.dataVersion;
                if (tRes.meta?.asOfDate) lastAsOfDate = tRes.meta.asOfDate;
                internalDataRefs.push({ tool: toolName, partitionsRead: tRes.meta?.partitionsRead || [], dataVersion: tRes.meta?.dataVersion || null });
                if (toolName === "query_world_state" && tRes.data) {
                  dataCards.push({
                    kind: "world_state",
                    asOfDate: tRes.data.asOfDate,
                    kpis: tRes.data.kpis || null,
                    markets: tRes.data.markets || null,
                    shipmentsSummary: tRes.data.shipmentsSummary || null
                  });
                } else if (toolName === "trace_supply_chain" && tRes.data) {
                  dataCards.push({
                    kind: "supply_chain_trace",
                    mode: tRes.data.mode || (tRes.data.linked !== undefined ? "cross_module" : "trace"),
                    summary: tRes.data.summary || null,
                    sharedSuppliers: tRes.data.sharedSuppliers || tRes.data.sharedUpstreamSuppliers || null
                  });
                }
              }
              toolTraces.push({
                tool: toolName,
                ok: tRes.ok,
                durationMs: tRes.meta?.durationMs || 0,
                payloadBytes: tRes.meta?.payloadBytes || 0,
                cacheHit: Boolean(tRes.meta?.cacheHit),
                errorCode: tRes.error?.code || null
              });
              toolOutputForModel = tRes;
            }

            if (PrivacyMod.detectVaultLeak(toolOutputForModel)) {
              toolOutputForModel = { ok: false, error: { code: "PRIVACY_BLOCKED", message: "工具输出触发隐私拦截" } };
            }

            messages.push({
              role: "tool",
              tool_call_id: callId,
              content: JSON.stringify(toolOutputForModel)
            });
          }

          if (earlyAbortInfo) break;
        }

        const metrics = {
          durationMs: Date.now() - startTs,
          toolCallCount,
          modelRounds,
          failedToolCalls,
          streamed: streamedAny,
          usage: {
            promptTokens: totalPromptTokens,
            completionTokens: totalCompletionTokens,
            totalTokens
          }
        };
        const rehydratedCards = dataCards.map(card => privacy.rehydrateResponse(card, { mode: "name" }).data);
        const formattedMutations = formatMutationList(mutationResults);
        const systemReceipt = buildSystemMutationReceipt(mutationResults);

        // 5. Handle early abort (model error / timeout / cancel / budget exceeded):
        // CRITICAL (P0 #4): If any business mutation ALREADY committed, MUST return real mutation receipt & vouchers!
        if (earlyAbortInfo) {
          if (mutationResults.length > 0) {
            return {
              ok: true,
              partialModelFailure: true,
              cancelled: Boolean(earlyAbortInfo.cancelled),
              timedOut: Boolean(earlyAbortInfo.timedOut),
              budgetExceeded: earlyAbortInfo.budgetExceeded || null,
              type: "mutation",
              answer: `${systemReceipt}\n（后续模型总结未完成：${earlyAbortInfo.message}）`,
              systemReceipt,
              keyPoints: [],
              uncertainty: `业务修改已正式提交并落盘留证；后续模型请求中断（${earlyAbortInfo.code}）。`,
              entityRefs: collectEntityRefs([], mutationResults),
              dataCards: rehydratedCards,
              mutations: formattedMutations,
              sources: externalSources,
              toolTraces,
              error: { code: earlyAbortInfo.code, message: earlyAbortInfo.message },
              metrics
            };
          }
          return {
            ok: false,
            cancelled: Boolean(earlyAbortInfo.cancelled),
            timedOut: Boolean(earlyAbortInfo.timedOut),
            budgetExceeded: earlyAbortInfo.budgetExceeded || null,
            type: "unable",
            answer: earlyAbortInfo.cancelled
              ? "已取消本次 AI 请求。"
              : (earlyAbortInfo.budgetExceeded ? `${earlyAbortInfo.message}，已停止继续请求模型。` : `模型调用失败：${earlyAbortInfo.message}`),
            keyPoints: [],
            uncertainty: "",
            entityRefs: [],
            dataCards: rehydratedCards,
            mutations: [],
            sources: externalSources,
            toolTraces,
            error: { code: earlyAbortInfo.code, message: earlyAbortInfo.message },
            metrics
          };
        }

        // 6. Normal completion: parse response, enforce unverified-mutation guard (P1 #7), rehydrate locally
        const defaultType = mutationResults.length > 0 ? "mutation" : "query";
        const parsed = parseStructuredModelOutput(finalRawContent, defaultType);

        let unverifiedMutationClaimBlocked = false;
        if (mutationResults.length === 0 && (parsed.type === "mutation" || containsUnverifiedMutationClaim(parsed.answer))) {
          parsed.type = "unable";
          unverifiedMutationClaimBlocked = true;
          parsed.answer = `本次未执行任何实际业务修改。${parsed.uncertainty || "请先确认处于授权写入状态并明确指定目标对象后重试。"}`;
          parsed.uncertainty = "系统拦截了未经实际执行成功的修改宣称，业务数据未被改动。";
        }

        const rehydratedAnswer = privacy.rehydrateResponse(parsed.answer, { mode: "name" });
        const rehydratedPoints = parsed.keyPoints.map(pt => privacy.rehydrateResponse(pt, { mode: "name" }).text);
        const rehydratedUncertainty = parsed.uncertainty ? privacy.rehydrateResponse(parsed.uncertainty, { mode: "name" }).text : "";

        // When real mutations occurred, system receipt is authoritative (P1 #7)
        const finalAnswer = mutationResults.length > 0
          ? (rehydratedAnswer.text ? `${systemReceipt}\n${rehydratedAnswer.text}` : systemReceipt)
          : rehydratedAnswer.text;

        const entityRefs = collectEntityRefs(rehydratedAnswer.resolvedRefs, mutationResults);

        // 7. Record local decision/research evidence in SCAIAudit
        let evidenceRecord = null;
        if (auditStore && (toolCallCount > 0 || externalSources.length > 0)) {
          try {
            evidenceRecord = auditStore.recordEvidence({
              kind: externalSources.length > 0 ? "web_research" : "decision",
              modelId: modelAdapter.getPublicConfig().model,
              userQuery: userMessage,
              internalDataRefs,
              dataVersion: lastDataVersion,
              calculationBasis: {
                asOfDate: lastAsOfDate,
                toolsUsed: toolTraces.map(t => t.tool),
                toolCallCount
              },
              externalSources,
              epistemicLabels: {
                facts: mutationResults.map(m => `已执行修改：${m.targetDisplayName}（凭证 ${m.voucher?.voucherId}）`),
                projections: lastAsOfDate ? [`基于基准日 ${lastAsOfDate} 的官方模拟引擎推演`] : [],
                inferences: rehydratedPoints,
                unknowns: rehydratedUncertainty ? [rehydratedUncertainty] : []
              }
            });
          } catch (_) {
            // Non-fatal for read-only decision evidence; mutation vouchers are strictly atomic in SCAIMutations
          }
        }

        return {
          ok: true,
          type: parsed.type,
          answer: finalAnswer,
          systemReceipt: mutationResults.length > 0 ? systemReceipt : null,
          unverifiedMutationClaimBlocked,
          keyPoints: rehydratedPoints,
          uncertainty: rehydratedUncertainty,
          entityRefs,
          dataCards: rehydratedCards,
          mutations: formattedMutations,
          sources: externalSources,
          evidenceId: evidenceRecord?.evidenceId || null,
          toolTraces,
          metrics
        };
      } finally {
        if (inFlightRequest === activeToken) {
          inFlightRequest = null;
        }
      }
    }

    return Object.freeze({
      CLIENT_VERSION,
      ask,
      getModelConfig: () => modelAdapter.getPublicConfig(),
      updateModelConfig: (patch) => modelAdapter.updateConfig(patch),
      getBudgets: () => Object.assign({}, budgets),
      updateBudgets,
      getWriteStatus: () => (writeController ? writeController.getStatus() : { mode: "read_only", activeGrant: null }),
      grantWriteAuthorization: (grant) => (writeController ? writeController.grantAuthorization(grant) : null),
      revokeWriteAuthorization: () => (writeController ? writeController.revokeAuthorization() : null),
      undoMutation: (voucherId) => (writeController ? writeController.undoMutation(voucherId) : { ok: false, error: "不支持撤销" }),
      getAuditStore: () => auditStore,
      getToolRuntime: () => toolRuntime,
      refreshPrivacyIndex: () => {
        if (privacy && typeof privacy.invalidateIndex === "function") privacy.invalidateIndex();
      }
    });
  }

  const SCAIClient = Object.freeze({
    CLIENT_VERSION,
    DEFAULT_BENCHMARK_MODEL,
    DEFAULT_REASONING_EFFORT,
    SYSTEM_PROMPT,
    SAFE_MODEL_DIFF_FIELDS,
    detectUserWriteIntent,
    sanitizeMutationOutputForModel,
    buildSystemMutationReceipt,
    containsUnverifiedMutationClaim,
    createModelAdapter,
    createAssistant,
    parseStructuredModelOutput
  });

  global.SCAIClient = SCAIClient;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = SCAIClient;
  }
})(typeof window !== "undefined" ? window : globalThis);
