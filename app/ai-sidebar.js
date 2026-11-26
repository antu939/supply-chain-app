(function (global) {
  "use strict";

  const CHAT_STORAGE_KEY = "sc-ai-chat-v1";
  const SETTINGS_STORAGE_KEY = "sc-ai-settings-v1";
  const SESSION_KEY_STORAGE = "sc-ai-session-api-key";

  const esc = t => String(t ?? "").replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c]));

  const MODULE_LABELS = { overview: "Overview", bom: "BOM & Compliance", sales: "Sales & Operations" };
  const ENTITY_LABELS = { company: "Company", factory: "Plant", diagram: "Product BOM", shipment: "Shipment", market: "Market", batch: "Batch" };
  const TYPE_LABELS = { query: "Query", decision: "Advisory", mutation: "Mutation", unable: "Unable" };

  function loadSettings() {
    const defaults = {
      baseUrl: "",
      model: global.SCAIClient?.DEFAULT_BENCHMARK_MODEL || "deepseek-v4.1-flash",
      reasoningEffort: global.SCAIClient?.DEFAULT_REASONING_EFFORT || "low",
      maxOutputTokens: 800,
      maxToolCalls: 6,
      maxModelRounds: 5,
      maxTotalTokens: 12000,
      stream: true
    };
    try {
      const raw = localStorage.getItem(SETTINGS_STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === "object") {
          delete parsed.webSearchEndpoint;
          Object.assign(defaults, parsed);
        }
      }
    } catch (_) {}
    let apiKey = "";
    try {
      apiKey = sessionStorage.getItem(SESSION_KEY_STORAGE) || "";
    } catch (_) {}
    return { settings: defaults, apiKey };
  }

  function saveSettings(settings, apiKey) {
    const pub = {
      baseUrl: String(settings.baseUrl || "").trim(),
      model: String(settings.model || "deepseek-v4.1-flash").trim(),
      reasoningEffort: String(settings.reasoningEffort || "low"),
      maxOutputTokens: Math.max(64, Math.min(4096, Number(settings.maxOutputTokens) || 800)),
      maxToolCalls: Math.max(1, Math.min(12, Number(settings.maxToolCalls) || 6)),
      maxModelRounds: Math.max(1, Math.min(12, Number(settings.maxModelRounds) || 5)),
      maxTotalTokens: Math.max(500, Math.min(100000, Number(settings.maxTotalTokens) || 12000)),
      stream: Boolean(settings.stream)
    };
    try { localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(pub)); } catch (_) {}
    try {
      if (apiKey) sessionStorage.setItem(SESSION_KEY_STORAGE, apiKey);
      else sessionStorage.removeItem(SESSION_KEY_STORAGE);
    } catch (_) {}
    return pub;
  }

  function loadChatMessages() {
    try {
      const raw = localStorage.getItem(CHAT_STORAGE_KEY);
      if (!raw) return [];
      const arr = JSON.parse(raw);
      return Array.isArray(arr) ? arr.slice(-40) : [];
    } catch (_) {
      return [];
    }
  }

  function saveChatMessages(messages) {
    try {
      localStorage.setItem(CHAT_STORAGE_KEY, JSON.stringify(messages.slice(-40)));
    } catch (_) {}
  }

  function shouldHideStreamingPreview(text) {
    const t = String(text || "").trim();
    if (!t) return true;
    // Never show raw JSON envelopes, fenced JSON, or thinking tags during streaming
    if (t.startsWith("{") || t.startsWith("```") || t.startsWith("<think") || t.startsWith("<reasoning")) return true;
    // Never stream unverified mutation claims before final verification
    if (global.SCAIClient?.containsUnverifiedMutationClaim && global.SCAIClient.containsUnverifiedMutationClaim(t)) return true;
    return false;
  }

  function renderDataCardsHtml(cards) {
    if (!Array.isArray(cards) || !cards.length) return "";
    return cards.map(card => {
      if (!card || typeof card !== "object") return "";
      if (card.kind === "world_state") {
        const k = card.kpis || null;
        const markets = Array.isArray(card.markets) ? card.markets : [];
        return `
          <div class="ai-card-box">
            <h4>Engine Calculation${card.asOfDate ? ` · ${esc(card.asOfDate)}` : ""}</h4>
            ${k ? `
              <div class="ai-diff-row"><span>Available Inventory</span><strong>${esc(k.currentAvailableInventory ?? "-")}</strong></div>
              <div class="ai-diff-row"><span>In Transit / Customs</span><strong>${esc(k.currentInTransit ?? "-")} / ${esc(k.awaitingCustoms ?? "-")}</strong></div>
              <div class="ai-diff-row"><span>7-Day Arrivals</span><strong>${esc(k.next7DaysExpectedArrivals ?? "-")}</strong></div>
              <div class="ai-diff-row"><span>Markets at Risk</span><strong>${esc(k.marketsAtRiskCount ?? 0)}</strong></div>
            ` : ""}
            ${markets.map(m => `
              <div class="ai-diff-row">
                <span>${esc(m.name || m.nodeId)}</span>
                <span>Avail ${esc(m.currentAvailable ?? "-")} · Gap <strong>${esc(m.totalDemandGap ?? 0)}</strong>${m.firstGapDate ? ` (${esc(m.firstGapDate)})` : ""}</span>
              </div>
            `).join("")}
          </div>`;
      }
      if (card.kind === "supply_chain_trace") {
        const shared = Array.isArray(card.sharedSuppliers) ? card.sharedSuppliers : [];
        const sum = card.summary || null;
        return `
          <div class="ai-card-box">
            <h4>Supply Chain Trace</h4>
            ${sum && sum.sharedSupplierCount !== undefined ? `<div class="ai-diff-row"><span>Shared Upstream</span><strong>${esc(sum.sharedSupplierCount)}</strong></div>` : ""}
            ${shared.slice(0, 5).map(s => `
              <div class="ai-diff-row">
                <span>${esc(s.supplier?.name || s.supplier?.id || "-")}</span>
                <span>${esc(s.supplier?.complianceStatus || "-")} · Shared by ${esc((s.sharedByCompanyIds || s.servedReceiverIds || []).length)}</span>
              </div>
            `).join("")}
          </div>`;
      }
      return "";
    }).join("");
  }

  function mount(hostOptions) {
    const host = hostOptions || {};
    const sidebarEl = document.getElementById("aiSidebar");
    const toggleBtn = document.getElementById("shellAiBtn");
    if (!sidebarEl || !toggleBtn || !global.SCAIClient) return null;

    const loaded = loadSettings();
    const assistant = global.SCAIClient.createAssistant({
      storage: typeof localStorage !== "undefined" ? localStorage : null,
      modelConfig: Object.assign({}, loaded.settings, { apiKey: loaded.apiKey }),
      maxToolCalls: loaded.settings.maxToolCalls,
      maxModelRounds: loaded.settings.maxModelRounds,
      maxTotalTokens: loaded.settings.maxTotalTokens,
      onDataMutated: (info) => {
        if (typeof host.onDataMutated === "function") host.onDataMutated(info);
      }
    });

    const ui = {
      open: false,
      tab: "chat",
      authDrawerOpen: false,
      activeModule: host.initialModule || "overview",
      selectedEntity: null, // { module, kind, id, name }
      contextDetached: false,
      messages: loadChatMessages(),
      busy: false,
      statusText: "",
      streamingText: "",
      liveMutationReceipts: [],
      pendingConfirmation: null, // { prompt, redactedPreview, reason }
      abortController: null,
      settings: loaded.settings,
      apiKey: loaded.apiKey
    };

    function getActiveContext() {
      if (ui.contextDetached) return null;
      const validEntity = ui.selectedEntity && ui.selectedEntity.module === ui.activeModule
        ? ui.selectedEntity
        : null;
      return {
        module: ui.activeModule,
        entity: validEntity
      };
    }

    function setOpen(next) {
      ui.open = Boolean(next);
      sidebarEl.classList.toggle("hidden", !ui.open);
      toggleBtn.classList.toggle("is-open", ui.open);
      toggleBtn.setAttribute("aria-expanded", String(ui.open));
      if (ui.open) render();
    }

    function setActiveModule(route) {
      const next = route || "overview";
      if (next !== ui.activeModule) {
        ui.activeModule = next;
        // Always clear stale entity from previous module (P1 #9)
        ui.selectedEntity = null;
      }
      if (ui.open) render();
    }

    function setSelectedEntity(entity) {
      if (!entity || !entity.id) {
        ui.selectedEntity = null;
        if (ui.open) render();
        return;
      }
      ui.selectedEntity = {
        module: String(entity.module || ui.activeModule),
        kind: String(entity.kind || ""),
        id: String(entity.id),
        name: String(entity.name || entity.id)
      };
      ui.contextDetached = false;
      if (ui.open) render();
    }

    function clearSelectedEntity(moduleFilter) {
      if (!ui.selectedEntity) return;
      if (moduleFilter && ui.selectedEntity.module !== moduleFilter) return;
      ui.selectedEntity = null;
      if (ui.open) render();
    }

    function renderContextBar() {
      if (ui.contextDetached) {
        return `
          <div class="ai-ctx-bar">
            <span class="ai-ctx-chip">No context</span>
            <button type="button" class="ai-ctx-clear" data-ai-act="restore-ctx">Attach</button>
          </div>`;
      }
      const modLabel = MODULE_LABELS[ui.activeModule] || ui.activeModule;
      const ent = ui.selectedEntity && ui.selectedEntity.module === ui.activeModule ? ui.selectedEntity : null;
      const entPart = ent
        ? ` · ${ENTITY_LABELS[ent.kind] || ent.kind} <strong>${esc(ent.name)}</strong>`
        : "";
      return `
        <div class="ai-ctx-bar">
          <span class="ai-ctx-chip">Context: <strong>${esc(modLabel)}</strong>${entPart}</span>
          <button type="button" class="ai-ctx-clear" data-ai-act="clear-ctx">Clear</button>
        </div>`;
    }

    function renderAuthDrawer() {
      if (!ui.authDrawerOpen) return "";
      const st = assistant.getWriteStatus();
      if (st.mode === "authorized_write" && st.activeGrant) {
        const minsLeft = Math.max(1, Math.ceil((st.activeGrant.expiresAt - Date.now()) / 60000));
        return `
          <div class="ai-auth-drawer">
            <div class="ai-auth-row">
              <strong>Write access active · ${minsLeft}m left</strong>
              <button type="button" class="ai-btn-sm danger" data-ai-act="revoke-auth">Revoke</button>
            </div>
            <div>${esc(st.activeGrant.allowedOperations.join(", "))}</div>
          </div>`;
      }
      return `
        <div class="ai-auth-drawer">
          <label><input type="checkbox" id="aiAuthOpEta" checked> Shipment ETA Adjustment</label>
          <label><input type="checkbox" id="aiAuthOpComp"> BOM Compliance Update</label>
          <div class="ai-auth-row">
            <select id="aiAuthTtl">
              <option value="15">15 min</option>
              <option value="30" selected>30 min</option>
              <option value="60">60 min</option>
            </select>
            <button type="button" class="ai-btn-sm primary" data-ai-act="grant-auth">Grant</button>
          </div>
        </div>`;
    }

    function renderAssistantCard(msg) {
      const typeTag = TYPE_LABELS[msg.type] || "Reply";
      const tagClass = msg.type === "mutation" ? "is-mutation" : (msg.type === "unable" ? "is-unable" : "");

      const pointsHtml = Array.isArray(msg.keyPoints) && msg.keyPoints.length
        ? `<ul class="ai-points">${msg.keyPoints.map(p => `<li>${esc(p)}</li>`).join("")}</ul>`
        : "";

      const uncertHtml = msg.uncertainty
        ? `<div class="ai-uncertainty">${esc(msg.uncertainty)}</div>`
        : "";

      const dataCardsHtml = renderDataCardsHtml(msg.dataCards);

      const refsHtml = Array.isArray(msg.entityRefs) && msg.entityRefs.length
        ? `<div class="ai-refs">${msg.entityRefs.slice(0, 6).map(r =>
            `<button type="button" class="ai-ref-pill" data-ai-jump-type="${esc(r.type)}" data-ai-jump-id="${esc(r.rawId)}">${esc(r.displayName || r.rawId)}</button>`
          ).join("")}</div>`
        : "";

      const mutationsHtml = Array.isArray(msg.mutations) && msg.mutations.length
        ? msg.mutations.map(m => `
            <div class="ai-card-box">
              <h4>Applied Change · ${esc(m.targetDisplayName)} (${esc(m.voucherId || "-")})</h4>
              ${(m.diff || []).map(d => `
                <div class="ai-diff-row">
                  <span>${esc(d.label || d.field)}</span>
                  <span>${esc(d.before ?? "-")} → <strong>${esc(d.after ?? "-")}</strong></span>
                </div>
              `).join("")}
              ${m.originalPlan ? `<div class="ai-diff-row"><span>Original Plan</span><span>Arrival ${esc(m.originalPlan.borderArrivalPlannedDate || "-")}</span></div>` : ""}
              ${(m.businessImpact?.newStockoutRisks || []).length
                ? `<div class="ai-uncertainty">Stockout Risk: ${m.businessImpact.newStockoutRisks.map(r => `${esc(r.marketName)} ${esc(r.firstGapDateAfter || "-")}`).join("; ")}</div>`
                : ""}
              ${m.undoable && m.voucherId
                ? `<div style="margin-top:6px"><button type="button" class="ai-btn-sm" data-ai-undo="${esc(m.voucherId)}">Undo</button></div>`
                : ""}
            </div>
          `).join("")
        : "";

      const sourcesHtml = Array.isArray(msg.sources) && msg.sources.length
        ? `<div class="ai-card-box"><h4>Sources</h4>${msg.sources.map(s =>
            `<div class="ai-diff-row"><a href="${esc(s.url)}" target="_blank" rel="noopener noreferrer">${esc(s.title)}</a><span>${esc((s.verifiedAt || "").slice(0, 10))}</span></div>`
          ).join("")}</div>`
        : "";

      const metricsHtml = msg.metrics
        ? `<details class="ai-details"><summary>Trace (${msg.metrics.toolCallCount || 0} tools · ${msg.metrics.durationMs || 0}ms${msg.metrics.usage?.totalTokens ? ` · ${msg.metrics.usage.totalTokens} tokens` : ""})</summary>
            <div style="margin-top:4px">${esc((msg.toolTraces || []).map(t => `${t.tool}(${t.ok ? "ok" : t.errorCode})`).join(", ") || "None")}</div>
            ${msg.evidenceId ? `<div>${esc(msg.evidenceId)}</div>` : ""}
          </details>`
        : "";

      return `
        <div class="ai-msg is-assistant">
          <div class="ai-msg-bubble">
            <div class="ai-msg-head"><span class="ai-type-tag ${tagClass}">${esc(typeTag)}</span></div>
            <div>${esc(msg.answer)}</div>
            ${pointsHtml}
            ${uncertHtml}
            ${dataCardsHtml}
            ${mutationsHtml}
            ${sourcesHtml}
            ${refsHtml}
            ${metricsHtml}
          </div>
        </div>`;
    }

    function renderChatPane() {
      const listHtml = ui.messages.length
        ? ui.messages.map(m => m.role === "user"
            ? `<div class="ai-msg is-user"><div class="ai-msg-bubble">${esc(m.content)}</div></div>`
            : renderAssistantCard(m)
          ).join("")
        : `
          <div class="ai-empty">
            <div class="ai-quick-list">
              <button type="button" class="ai-quick-btn" data-ai-prompt="Which suppliers have severe compliance issues?">Check severe compliance suppliers</button>
              <button type="button" class="ai-quick-btn" data-ai-prompt="Analyze current inventory coverage and stockout risks across target markets">Analyze market inventory &amp; gaps</button>
              <button type="button" class="ai-quick-btn" data-ai-prompt="Check for any overdue unconfirmed in-transit shipments">Check overdue unconfirmed shipments</button>
            </div>
          </div>`;

      const liveReceiptsHtml = ui.busy && ui.liveMutationReceipts.length
        ? ui.liveMutationReceipts.map(r => `<div class="ai-msg is-assistant"><div class="ai-msg-bubble">${esc(r.receiptText)}</div></div>`).join("")
        : "";

      const streamHtml = ui.busy && !shouldHideStreamingPreview(ui.streamingText)
        ? `<div class="ai-msg is-assistant"><div class="ai-msg-bubble">${esc(ui.streamingText)}</div></div>`
        : "";

      const confirmHtml = ui.pendingConfirmation
        ? `<div class="ai-card-box">
            <h4>Confirm Redacted Content</h4>
            <div style="margin-bottom:6px;white-space:pre-wrap">${esc(typeof ui.pendingConfirmation.redactedPreview === "string" ? ui.pendingConfirmation.redactedPreview : JSON.stringify(ui.pendingConfirmation.redactedPreview))}</div>
            <div style="display:flex;gap:8px">
              <button type="button" class="ai-btn-sm primary" data-ai-act="confirm-send">Confirm &amp; Send</button>
              <button type="button" class="ai-btn-sm" data-ai-act="cancel-confirm">Cancel</button>
            </div>
          </div>`
        : "";

      return `<div class="ai-sb-pane" id="aiChatPane">${listHtml}${liveReceiptsHtml}${streamHtml}${confirmHtml}</div>`;
    }

    function renderAuditPane() {
      const store = assistant.getAuditStore();
      const vouchers = store ? store.listMutationVouchers({ limit: 30 }) : [];
      const counts = store ? store.getCounts() : { archivedMutationVouchers: 0 };
      const evidences = store ? store.listEvidenceRecords({ limit: 20 }) : [];
      return `
        <div class="ai-sb-pane">
          <div class="ai-card-box">
            <h4>Mutation Vouchers (${vouchers.length}${counts.archivedMutationVouchers ? ` / ${counts.archivedMutationVouchers} archived` : ""})</h4>
            ${vouchers.length ? vouchers.map(v => `
              <div style="padding:7px 0;border-top:1px solid var(--line)">
                <div class="ai-diff-row"><strong>${esc(v.target?.displayName || v.target?.entityId)}</strong><span>${esc((v.isoTime || "").slice(0, 19).replace("T", " "))}</span></div>
                <div style="color:var(--muted);font-size:11px">${esc(v.voucherId)} · ${esc(v.action?.type)}</div>
                ${(v.diff || []).map(d => `<div class="ai-diff-row"><span>${esc(d.label || d.field)}</span><span>${esc(d.before ?? "-")} → ${esc(d.after ?? "-")}</span></div>`).join("")}
                ${v.undoneAt
                  ? `<div style="font-size:11px;color:var(--muted)">Undone (${esc(v.undoVoucherId)})</div>`
                  : (v.undoable ? `<button type="button" class="ai-btn-sm" style="margin-top:4px" data-ai-undo="${esc(v.voucherId)}">Undo</button>` : "")}
              </div>
            `).join("") : `<div style="color:var(--muted)">No records</div>`}
          </div>
          <div class="ai-card-box">
            <h4>Evidence Log (${evidences.length})</h4>
            ${evidences.length ? evidences.map(e => `
              <div style="padding:6px 0;border-top:1px solid var(--line);font-size:11.5px">
                <div><strong>${esc(e.kind === "web_research" ? "Web Research" : "Decision")}</strong> · ${esc(e.evidenceId)}</div>
                <div style="color:var(--muted)">${esc(e.userQuery)}</div>
                ${e.externalSources?.length ? e.externalSources.map(s => `<div><a href="${esc(s.url)}" target="_blank" rel="noopener noreferrer">${esc(s.title)}</a></div>`).join("") : ""}
              </div>
            `).join("") : `<div style="color:var(--muted)">No records</div>`}
          </div>
        </div>`;
    }

    function renderSettingsPane() {
      const s = ui.settings;
      return `
        <div class="ai-sb-pane">
          <div class="ai-form-group">
            <label for="aiCfgBaseUrl">API Base URL</label>
            <input id="aiCfgBaseUrl" type="url" value="${esc(s.baseUrl)}" placeholder="https://api.deepseek.com/v1">
          </div>
          <div class="ai-form-group">
            <label for="aiCfgApiKey">API Key</label>
            <input id="aiCfgApiKey" type="password" value="${esc(ui.apiKey)}" placeholder="sk-..." autocomplete="off">
          </div>
          <div class="ai-form-group">
            <label for="aiCfgModel">Model</label>
            <input id="aiCfgModel" type="text" value="${esc(s.model)}" placeholder="deepseek-v4.1-flash">
          </div>
          <div class="ai-form-group">
            <label for="aiCfgReasoning">Reasoning Effort</label>
            <select id="aiCfgReasoning">
              ${["low", "medium", "high", "none"].map(v => `<option value="${v}" ${s.reasoningEffort === v ? "selected" : ""}>${v}</option>`).join("")}
            </select>
          </div>
          <div class="ai-form-group">
            <label for="aiCfgMaxTokens">Max Output Tokens</label>
            <input id="aiCfgMaxTokens" type="number" min="64" max="4096" value="${esc(s.maxOutputTokens)}">
          </div>
          <div class="ai-form-group">
            <label for="aiCfgMaxTools">Max Tool Calls</label>
            <input id="aiCfgMaxTools" type="number" min="1" max="12" value="${esc(s.maxToolCalls)}">
          </div>
          <div class="ai-form-group">
            <label for="aiCfgMaxRounds">Max Model Rounds</label>
            <input id="aiCfgMaxRounds" type="number" min="1" max="12" value="${esc(s.maxModelRounds || 5)}">
          </div>
          <div class="ai-form-group">
            <label for="aiCfgMaxTotalTokens">Max Total Tokens</label>
            <input id="aiCfgMaxTotalTokens" type="number" min="500" max="100000" value="${esc(s.maxTotalTokens || 12000)}">
          </div>
          <label style="display:flex;align-items:center;gap:6px;font-size:12px">
            <input id="aiCfgStream" type="checkbox" ${s.stream ? "checked" : ""}> Streaming
          </label>
          <div style="display:flex;gap:8px;margin-top:4px">
            <button type="button" class="ai-btn-sm primary" data-ai-act="save-settings">Save</button>
            <button type="button" class="ai-btn-sm" data-ai-act="back-chat">Back</button>
          </div>
        </div>`;
    }

    function render() {
      const writeSt = assistant.getWriteStatus();
      const isWrite = writeSt.mode === "authorized_write";
      sidebarEl.innerHTML = `
        <header class="ai-sb-head">
          <div class="ai-sb-title">
            <span>AI Assistant</span>
            <button type="button" class="ai-mode-pill ${isWrite ? "is-write" : ""}" data-ai-act="toggle-auth">
              ${isWrite ? "Write" : "Read"}
            </button>
          </div>
          <div class="ai-sb-tools">
            <button type="button" class="ai-sb-icon-btn" data-ai-act="new-chat">New</button>
            <button type="button" class="ai-sb-icon-btn" data-ai-act="clear-chat">Clear</button>
            <button type="button" class="ai-sb-icon-btn ${ui.tab === "audit" ? "is-active" : ""}" data-ai-tab="audit">Audit</button>
            <button type="button" class="ai-sb-icon-btn ${ui.tab === "settings" ? "is-active" : ""}" data-ai-tab="settings">Settings</button>
            <button type="button" class="ai-sb-icon-btn" data-ai-act="close" aria-label="Collapse">×</button>
          </div>
        </header>
        ${renderContextBar()}
        ${renderAuthDrawer()}
        ${ui.tab === "settings" ? renderSettingsPane() : (ui.tab === "audit" ? renderAuditPane() : renderChatPane())}
        ${ui.busy ? `
          <div class="ai-status-line">
            <span>${esc(ui.statusText || "Processing…")}</span>
            <button type="button" class="ai-btn-sm danger" data-ai-act="cancel">Stop</button>
          </div>` : ""}
        ${ui.tab === "chat" ? `
          <div class="ai-composer">
            <textarea class="ai-input" id="aiPromptInput" placeholder="Ask a question or enter a command…" ${ui.busy ? "disabled" : ""}></textarea>
            <div class="ai-composer-foot">
              <span class="ai-composer-hint">${esc(ui.settings.model)}</span>
              <button type="button" class="ai-btn-sm primary" data-ai-act="send" ${ui.busy ? "disabled" : ""}>Send</button>
            </div>
          </div>` : ""}
      `;
      const pane = sidebarEl.querySelector("#aiChatPane");
      if (pane) pane.scrollTop = pane.scrollHeight;
    }

    async function sendPrompt(text, userConfirmed) {
      const prompt = String(text || "").trim();
      if (!prompt || ui.busy) return;

      ui.tab = "chat";
      ui.pendingConfirmation = null;
      if (!userConfirmed) {
        ui.messages.push({ role: "user", content: prompt, ts: Date.now() });
        saveChatMessages(ui.messages);
      }
      ui.busy = true;
      ui.statusText = "Processing…";
      ui.streamingText = "";
      ui.liveMutationReceipts = [];
      ui.abortController = typeof AbortController === "function" ? new AbortController() : null;
      render();

      const history = ui.messages
        .slice(0, -1)
        .slice(-6)
        .map(m => ({ role: m.role, content: m.role === "user" ? m.content : m.answer }));

      const res = await assistant.ask({
        userMessage: prompt,
        history,
        userConfirmed: userConfirmed === true,
        activeContext: getActiveContext(),
        signal: ui.abortController ? ui.abortController.signal : null,
        onStatus: (st) => {
          ui.statusText = st.label || "Processing…";
          const line = sidebarEl.querySelector(".ai-status-line span");
          if (line) line.textContent = ui.statusText;
        },
        onMutationCommitted: (rec) => {
          ui.liveMutationReceipts.push(rec);
          render();
        },
        onToken: (delta) => {
          ui.streamingText += delta;
          if (!shouldHideStreamingPreview(ui.streamingText)) render();
        }
      });

      ui.busy = false;
      ui.statusText = "";
      ui.streamingText = "";
      ui.liveMutationReceipts = [];
      ui.abortController = null;

      if (res.requiresConfirmation && !userConfirmed) {
        ui.pendingConfirmation = {
          prompt,
          redactedPreview: res.redactedPreview,
          reason: res.confirmationReason
        };
        render();
        return;
      }

      ui.messages.push({
        role: "assistant",
        type: res.type || (res.ok ? "query" : "unable"),
        answer: res.answer || res.error?.message || "No valid response received",
        keyPoints: res.keyPoints || [],
        uncertainty: res.uncertainty || "",
        dataCards: res.dataCards || [],
        entityRefs: res.entityRefs || [],
        mutations: res.mutations || [],
        sources: res.sources || [],
        evidenceId: res.evidenceId || null,
        toolTraces: res.toolTraces || [],
        metrics: res.metrics || null,
        ts: Date.now()
      });
      saveChatMessages(ui.messages);
      render();
    }

    toggleBtn.addEventListener("click", () => setOpen(!ui.open));

    sidebarEl.addEventListener("click", ev => {
      const actBtn = ev.target.closest("[data-ai-act]");
      if (actBtn) {
        const act = actBtn.dataset.aiAct;
        if (act === "close") setOpen(false);
        else if (act === "toggle-auth") { ui.authDrawerOpen = !ui.authDrawerOpen; render(); }
        else if (act === "clear-ctx") { ui.contextDetached = true; render(); }
        else if (act === "restore-ctx") { ui.contextDetached = false; render(); }
        else if (act === "new-chat" || act === "clear-chat") {
          ui.messages = [];
          ui.pendingConfirmation = null;
          saveChatMessages([]);
          ui.tab = "chat";
          render();
        } else if (act === "cancel") {
          if (ui.abortController) ui.abortController.abort();
        } else if (act === "send") {
          const inp = sidebarEl.querySelector("#aiPromptInput");
          if (inp) sendPrompt(inp.value, false);
        } else if (act === "confirm-send" && ui.pendingConfirmation) {
          sendPrompt(ui.pendingConfirmation.prompt, true);
        } else if (act === "cancel-confirm") {
          ui.pendingConfirmation = null;
          render();
        } else if (act === "back-chat") {
          ui.tab = "chat";
          render();
        } else if (act === "save-settings") {
          const nextSettings = {
            baseUrl: sidebarEl.querySelector("#aiCfgBaseUrl")?.value || "",
            model: sidebarEl.querySelector("#aiCfgModel")?.value || "deepseek-v4.1-flash",
            reasoningEffort: sidebarEl.querySelector("#aiCfgReasoning")?.value || "low",
            maxOutputTokens: Number(sidebarEl.querySelector("#aiCfgMaxTokens")?.value) || 800,
            maxToolCalls: Number(sidebarEl.querySelector("#aiCfgMaxTools")?.value) || 6,
            maxModelRounds: Number(sidebarEl.querySelector("#aiCfgMaxRounds")?.value) || 5,
            maxTotalTokens: Number(sidebarEl.querySelector("#aiCfgMaxTotalTokens")?.value) || 12000,
            stream: Boolean(sidebarEl.querySelector("#aiCfgStream")?.checked)
          };
          const nextKey = sidebarEl.querySelector("#aiCfgApiKey")?.value || "";
          ui.settings = saveSettings(nextSettings, nextKey);
          ui.apiKey = nextKey;
          assistant.updateModelConfig(Object.assign({}, ui.settings, { apiKey: nextKey }));
          assistant.updateBudgets({
            maxToolCalls: ui.settings.maxToolCalls,
            maxModelRounds: ui.settings.maxModelRounds,
            maxTotalTokens: ui.settings.maxTotalTokens
          });
          ui.tab = "chat";
          render();
        } else if (act === "grant-auth") {
          const ops = [];
          if (sidebarEl.querySelector("#aiAuthOpEta")?.checked) ops.push("shipment.adjust_eta");
          if (sidebarEl.querySelector("#aiAuthOpComp")?.checked) ops.push("bom.update_compliance");
          if (!ops.length) return;
          const mins = Number(sidebarEl.querySelector("#aiAuthTtl")?.value) || 30;
          assistant.grantWriteAuthorization({ allowedOperations: ops, ttlMs: mins * 60 * 1000 });
          ui.authDrawerOpen = false;
          render();
        } else if (act === "revoke-auth") {
          assistant.revokeWriteAuthorization();
          ui.authDrawerOpen = false;
          render();
        }
        return;
      }

      const tabBtn = ev.target.closest("[data-ai-tab]");
      if (tabBtn) {
        const nextTab = tabBtn.dataset.aiTab;
        ui.tab = ui.tab === nextTab ? "chat" : nextTab;
        render();
        return;
      }

      const quickBtn = ev.target.closest("[data-ai-prompt]");
      if (quickBtn) {
        sendPrompt(quickBtn.dataset.aiPrompt, false);
        return;
      }

      const undoBtn = ev.target.closest("[data-ai-undo]");
      if (undoBtn) {
        const res = assistant.undoMutation(undoBtn.dataset.aiUndo);
        ui.messages.push({
          role: "assistant",
          type: res.ok ? "mutation" : "unable",
          answer: res.ok
            ? `Undone voucher ${undoBtn.dataset.aiUndo} (${res.undoVoucher?.voucherId || ""}).`
            : `Undo failed: ${res.error || "Validation error"}`,
          ts: Date.now()
        });
        saveChatMessages(ui.messages);
        render();
        return;
      }

      const jumpBtn = ev.target.closest("[data-ai-jump-type]");
      if (jumpBtn && typeof host.onNavigateEntity === "function") {
        host.onNavigateEntity(jumpBtn.dataset.aiJumpType, jumpBtn.dataset.aiJumpId);
      }
    });

    sidebarEl.addEventListener("keydown", ev => {
      if (ev.target && ev.target.id === "aiPromptInput" && ev.key === "Enter" && !ev.shiftKey) {
        ev.preventDefault();
        sendPrompt(ev.target.value, false);
      }
    });

    return Object.freeze({
      setOpen,
      setActiveModule,
      setSelectedEntity,
      clearSelectedEntity,
      getActiveContext,
      refreshIndex: () => assistant.refreshPrivacyIndex?.(),
      getAssistant: () => assistant
    });
  }

  global.SCAISidebar = Object.freeze({
    CHAT_STORAGE_KEY,
    SETTINGS_STORAGE_KEY,
    renderDataCardsHtml,
    shouldHideStreamingPreview,
    mount
  });
})(typeof window !== "undefined" ? window : globalThis);
