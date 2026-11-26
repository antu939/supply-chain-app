(function (global) {
  "use strict";

  const Bridge = global.SCBridge;
  const Storage = global.SCStorage;

  const ROUTES = ["overview", "bom", "sales"];
  const MODULE_URLS = {
    bom: "modules/bom/index.html?embedded=1",
    sales: "modules/sales/index.html?embedded=1"
  };

  const $ = (sel, root = document) => root.querySelector(sel);
  const esc = t => String(t ?? "").replace(/[&<>"']/g, c => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  }[c]));

  const state = {
    route: "overview",
    menuOpen: false,
    frames: { bom: null, sales: null },
    ready: { bom: false, sales: false },
    pending: { bom: [], sales: [] },
    saveStatus: { bom: { ok: true }, sales: { ok: true } }
  };
  let navigationSequence = 0;

  function formatTodayEnglish() {
    const now = new Date();
    return now.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
  }

  function resolveRouteFromHash() {
    const raw = (global.location.hash || "").replace(/^#\/?/, "").trim().toLowerCase();
    return ROUTES.includes(raw) ? raw : "overview";
  }

  function updateHash(route) {
    const target = `#${route}`;
    if (global.location.hash !== target) {
      try {
        history.replaceState(null, "", target);
      } catch (_) {
        global.location.hash = target;
      }
    }
  }

  function setMenuOpen(open) {
    state.menuOpen = Boolean(open);
    const menu = $("#shellMenu");
    const btn = $("#shellMenuBtn");
    if (menu) menu.classList.toggle("hidden", !state.menuOpen);
    if (btn) btn.setAttribute("aria-expanded", String(state.menuOpen));
  }

  function updateSaveIndicator(snapshot) {
    const el = $("#shellSaveState");
    if (!el) return;
    el.classList.remove("is-error", "is-idle");
    const failedModule = [state.route, "bom", "sales"].find(route => state.saveStatus[route]?.ok === false);
    if (failedModule) {
      el.textContent = state.saveStatus[failedModule].message || "Save error";
      el.classList.add("is-error");
      return;
    }
    const snap = snapshot || Storage.readBusinessSnapshot();
    if (!snap.hasRealData) {
      el.textContent = "Ready";
      el.classList.add("is-idle");
    } else {
      el.textContent = "Saved";
    }
  }

  function ensureModuleFrame(route) {
    if (route !== "bom" && route !== "sales") return null;
    if (state.frames[route]) return state.frames[route];

    const host = route === "bom" ? $("#bomView") : $("#salesView");
    const iframe = document.createElement("iframe");
    iframe.src = MODULE_URLS[route];
    iframe.title = route === "bom" ? "BOM & Compliance" : "Sales & Operations";
    iframe.dataset.module = route;
    iframe.addEventListener("load", () => {
      // Fallback flush in case module-ready fired before or without bridge handshake
      if (!state.ready[route]) {
        state.ready[route] = true;
        flushPendingMessages(route);
      }
    });
    host.appendChild(iframe);
    state.frames[route] = iframe;
    return iframe;
  }

  function flushPendingMessages(route) {
    const iframe = state.frames[route];
    if (!iframe || !state.pending[route].length) return;
    const queue = state.pending[route].splice(0);
    for (const msg of queue) {
      Bridge.postToFrame(iframe, msg.type, msg.payload);
    }
  }

  function sendToModule(route, type, payload) {
    if (route !== "bom" && route !== "sales") return;
    ensureModuleFrame(route);
    if (state.ready[route] && state.frames[route]) {
      Bridge.postToFrame(state.frames[route], type, payload);
    } else {
      state.pending[route].push({ type, payload: payload || {} });
    }
  }

  function navigate(route, options) {
    const sequence = ++navigationSequence;
    const target = ROUTES.includes(route) ? route : "overview";
    state.route = target;
    setMenuOpen(false);
    updateHash(target);

    document.querySelectorAll(".shell-nav-btn").forEach(btn => {
      const active = btn.dataset.route === target;
      btn.classList.toggle("is-active", active);
      if (active) btn.setAttribute("aria-current", "page");
      else btn.removeAttribute("aria-current");
    });

    $("#overviewView").classList.toggle("is-active", target === "overview");
    $("#bomView").classList.toggle("is-active", target === "bom");
    $("#salesView").classList.toggle("is-active", target === "sales");

    if (aiSidebar) aiSidebar.setActiveModule(target);

    if (target === "overview") {
      renderOverview();
      return;
    }

    ensureModuleFrame(target);
    requestAnimationFrame(() => {
      if (sequence !== navigationSequence) return;
      sendToModule(target, Bridge.MESSAGE_TYPES.ON_SHOW, {});
      if (options?.message) {
        sendToModule(target, options.message.type, options.message.payload);
      }
    });
  }

  /* -------------------------------------------------------------------------
     Overview Rendering (State A: First-time Guide | State B: Active Business)
     ------------------------------------------------------------------------- */
  function renderFirstTimeOverview() {
    return `
      <div class="onboarding-page">
        <header class="onboarding-hero">
          <h1>Supply Chain Workspace</h1>
        </header>

        <section class="onboarding-card" aria-label="Setup Steps">
          <div class="onboarding-steps">
            <div class="onboarding-step">
              <span class="step-num">01</span>
              <h2>Set Up Assembly Company &amp; Plant</h2>
            </div>
            <div class="onboarding-step">
              <span class="step-num">02</span>
              <h2>Build BOM &amp; Compliance</h2>
            </div>
            <div class="onboarding-step">
              <span class="step-num">03</span>
              <h2>Plan Sales &amp; Operations</h2>
            </div>
          </div>
          <div class="onboarding-foot">
            <div class="onboarding-cta-group">
              <button type="button" class="btn primary lg" data-jump-module="bom" data-jump-view="subjects">Set Up Company &amp; Plant</button>
              <button type="button" class="btn lg" data-jump-module="bom" data-jump-view="bom">New Product BOM</button>
            </div>
          </div>
        </section>

        <section class="entry-grid" aria-label="Modules">
          <button type="button" class="entry-card" data-jump-module="bom">
            <div class="entry-card-top">
              <div class="entry-card-title">
                <span class="entry-icon" aria-hidden="true">
                  <svg width="17" height="17" viewBox="0 0 18 18" fill="none">
                    <rect x="1.5" y="1.5" width="6" height="6" rx="1.5" stroke="currentColor" stroke-width="1.4"/>
                    <rect x="10.5" y="1.5" width="6" height="6" rx="1.5" stroke="currentColor" stroke-width="1.4"/>
                    <rect x="1.5" y="10.5" width="6" height="6" rx="1.5" stroke="currentColor" stroke-width="1.4"/>
                    <path d="M10.5 13.5h6M13.5 10.5v6" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>
                  </svg>
                </span>
                <h3>BOM &amp; Compliance</h3>
              </div>
              <span class="entry-arrow">Open →</span>
            </div>
          </button>

          <button type="button" class="entry-card" data-jump-module="sales">
            <div class="entry-card-top">
              <div class="entry-card-title">
                <span class="entry-icon" aria-hidden="true">
                  <svg width="17" height="17" viewBox="0 0 18 18" fill="none">
                    <circle cx="3.5" cy="9" r="2.2" stroke="currentColor" stroke-width="1.4"/>
                    <circle cx="14.5" cy="4.2" r="2.2" stroke="currentColor" stroke-width="1.4"/>
                    <circle cx="14.5" cy="13.8" r="2.2" stroke="currentColor" stroke-width="1.4"/>
                    <path d="M5.6 8.2L12.3 5.1M5.6 9.8L12.3 12.9" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>
                  </svg>
                </span>
                <h3>Sales &amp; Operations</h3>
              </div>
              <span class="entry-arrow">Open →</span>
            </div>
          </button>
        </section>
      </div>`;
  }

  function buildRecentList(snapshot) {
    const visited = Storage.loadRecentWork();
    const merged = [];
    const seen = new Set();

    const kindMeta = {
      company: "Company",
      diagram: "Product BOM",
      shipment: "Shipment",
      market: "Target Market"
    };

    for (const item of visited) {
      const key = `${item.kind}:${item.id}`;
      if (seen.has(key)) continue;
      // Only show entities that still exist in saved data
      if (item.kind === "company" && !snapshot.bom.companies.some(c => c.id === item.id)) continue;
      if (item.kind === "diagram" && !snapshot.bom.diagrams.some(d => d.id === item.id)) continue;
      if (item.kind === "shipment" && !snapshot.sales.shipments.some(s => s.id === item.id)) continue;
      if (item.kind === "market" && !snapshot.sales.markets.some(m => m.id === item.id)) continue;
      seen.add(key);
      merged.push({
        kind: item.kind,
        id: item.id,
        name: item.name,
        meta: kindMeta[item.kind] || "Record",
        route: item.route
      });
    }

    for (const item of snapshot.fallbackRecent) {
      const key = `${item.kind}:${item.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(item);
    }

    return merged.slice(0, 5);
  }

  function renderActiveOverview(snapshot) {
    const { bom, sales, reminders } = snapshot;
    const recent = buildRecentList(snapshot);

    const bomSummary = (bom.diagramCount || bom.companyCount || bom.factoryCount)
      ? `${bom.diagramCount} BOMs · ${bom.companyCount} Companies · ${bom.factoryCount} Plants · ${bom.linkCount} Links`
      : "";

    const salesSummary = (sales.factoryCount || sales.marketCount || sales.batchCount || sales.activeShipmentCount)
      ? `${sales.activeProductName ? `${sales.activeProductName} · ` : ""}${sales.batchCount} Batches · ${sales.activeShipmentCount} Shipments · ${sales.marketCount} Markets`
      : "";
    const salesFlow = sales.kpis
      ? `In Transit ${sales.kpis.currentInTransit} · Customs/Putaway ${sales.kpis.awaitingCustoms} · Next-Day ${sales.kpis.shelvedPendingNextDay}`
      : "";

    const productHeadline = sales.activeProductName
      ? `${sales.activeProductName}${sales.activeProductSku ? ` (${sales.activeProductSku})` : ""}`
      : bom.diagrams[0]
        ? bom.diagrams[0].name
        : "";

    return `
      <div class="overview-page">
        <header class="overview-head">
          <div>
            <h1>Overview</h1>
            ${productHeadline ? `<p class="overview-subtitle">${esc(productHeadline)}</p>` : ""}
          </div>
          <span class="overview-date">${esc(formatTodayEnglish())}</span>
        </header>

        <section class="summary-strip" aria-label="Key Metrics">
          <button type="button" class="summary-card" data-jump-module="bom" data-jump-view="subjects">
            <span class="summary-label">Companies &amp; Plants</span>
            <div class="summary-value">${bom.companyCount}<small>Companies</small></div>
            <span class="summary-meta">${bom.factoryCount} Plants</span>
          </button>

          <button type="button" class="summary-card" data-jump-module="bom" data-jump-view="bom">
            <span class="summary-label">Product BOMs</span>
            <div class="summary-value">${bom.diagramCount}<small>BOMs</small></div>
            <span class="summary-meta">${bom.linkCount} Supply Links</span>
          </button>

          <button type="button" class="summary-card" data-jump-module="sales" data-jump-view="logistics">
            <span class="summary-label">Active Shipments</span>
            <div class="summary-value">${sales.activeShipmentCount}<small>Active</small></div>
            <span class="summary-meta">${sales.batchCount} Production Batches</span>
          </button>

          <button type="button" class="summary-card" data-jump-module="sales" data-jump-view="market">
            <span class="summary-label">Target Markets</span>
            <div class="summary-value">${sales.marketCount}<small>Markets</small></div>
            ${sales.activeProductSku ? `<span class="summary-meta">SKU ${esc(sales.activeProductSku)}</span>` : ""}
          </button>
        </section>

        <div class="overview-columns">
          <div class="overview-col">
            <section class="module-card" aria-label="BOM & Compliance">
              <div class="module-card-head">
                <div class="module-card-ident">
                  <span class="entry-icon" aria-hidden="true">
                    <svg width="17" height="17" viewBox="0 0 18 18" fill="none">
                      <rect x="1.5" y="1.5" width="6" height="6" rx="1.5" stroke="currentColor" stroke-width="1.4"/>
                      <rect x="10.5" y="1.5" width="6" height="6" rx="1.5" stroke="currentColor" stroke-width="1.4"/>
                      <rect x="1.5" y="10.5" width="6" height="6" rx="1.5" stroke="currentColor" stroke-width="1.4"/>
                      <path d="M10.5 13.5h6M13.5 10.5v6" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>
                    </svg>
                  </span>
                  <h2>BOM &amp; Compliance</h2>
                </div>
                <button type="button" class="btn primary" data-jump-module="bom">Open</button>
              </div>
              ${bomSummary ? `<p class="module-card-desc">${esc(bomSummary)}</p>` : ""}
              <div class="module-shortcuts">
                <button type="button" class="shortcut-btn" data-jump-module="bom" data-jump-view="bom">BOM Tree</button>
                <button type="button" class="shortcut-btn" data-jump-module="bom" data-jump-view="subjects">Companies</button>
                <button type="button" class="shortcut-btn" data-jump-module="bom" data-jump-view="risk">Market Access</button>
              </div>
            </section>

            <section class="module-card" aria-label="Sales & Operations">
              <div class="module-card-head">
                <div class="module-card-ident">
                  <span class="entry-icon" aria-hidden="true">
                    <svg width="17" height="17" viewBox="0 0 18 18" fill="none">
                      <circle cx="3.5" cy="9" r="2.2" stroke="currentColor" stroke-width="1.4"/>
                      <circle cx="14.5" cy="4.2" r="2.2" stroke="currentColor" stroke-width="1.4"/>
                      <circle cx="14.5" cy="13.8" r="2.2" stroke="currentColor" stroke-width="1.4"/>
                      <path d="M5.6 8.2L12.3 5.1M5.6 9.8L12.3 12.9" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>
                    </svg>
                  </span>
                  <h2>Sales &amp; Operations</h2>
                </div>
                <button type="button" class="btn primary" data-jump-module="sales">Open</button>
              </div>
              ${(salesSummary || salesFlow) ? `<p class="module-card-desc">${esc(salesSummary)}${salesSummary && salesFlow ? "<br>" : ""}${esc(salesFlow)}</p>` : ""}
              <div class="module-shortcuts">
                <button type="button" class="shortcut-btn" data-jump-module="sales" data-jump-view="dashboard">Overview</button>
                <button type="button" class="shortcut-btn" data-jump-module="sales" data-jump-view="supply">Supply &amp; Batches</button>
                <button type="button" class="shortcut-btn" data-jump-module="sales" data-jump-view="logistics">Logistics &amp; Customs</button>
                <button type="button" class="shortcut-btn" data-jump-module="sales" data-jump-view="market">Markets &amp; Demand</button>
              </div>
            </section>
          </div>

          <div class="overview-col">
            <section class="panel-card" aria-label="Attention Required">
              <div class="panel-card-head">
                <h2>Attention Required</h2>
              </div>
              ${reminders.length ? `
                <div class="quiet-list">
                  ${reminders.map((r, idx) => `
                    <button type="button" class="list-row" data-reminder-index="${idx}">
                      <span class="status-dot ${esc(r.severity)}" aria-hidden="true"></span>
                      <span class="list-row-copy">
                        <strong>${esc(r.title)}</strong>
                      </span>
                    </button>
                  `).join("")}
                </div>` : `
                <div class="quiet-empty">
                  <span class="status-dot ok" aria-hidden="true" style="margin-top:0"></span>
                  <span>No alerts</span>
                </div>`}
            </section>

            <section class="panel-card" aria-label="Recent Activity">
              <div class="panel-card-head">
                <h2>Recent Activity</h2>
              </div>
              ${recent.length ? `
                <div class="quiet-list">
                  ${recent.map(item => `
                    <button type="button" class="list-row" data-recent-kind="${esc(item.kind)}" data-recent-id="${esc(item.id)}" data-recent-route="${esc(item.route)}">
                      <span class="list-row-copy">
                        <strong>${esc(item.name)}</strong>
                        <span>${esc(item.meta)}</span>
                      </span>
                      <span class="list-row-tag">${item.route === "bom" ? "BOM" : "Sales"}</span>
                    </button>
                  `).join("")}
                </div>` : `
                <div class="quiet-empty">
                  <span>No activity yet</span>
                </div>`}
            </section>
          </div>
        </div>
      </div>`;
  }

  let latestSnapshot = null;
  let aiSidebar = null;

  function renderOverview() {
    latestSnapshot = Storage.readBusinessSnapshot();
    updateSaveIndicator(latestSnapshot);
    const root = $("#overviewView");
    root.innerHTML = latestSnapshot.hasRealData
      ? renderActiveOverview(latestSnapshot)
      : renderFirstTimeOverview();
  }

  function openRecentEntity(kind, id, route) {
    if (kind === "company") {
      navigate("bom", { message: { type: Bridge.MESSAGE_TYPES.OPEN_COMPANY, payload: { companyId: id } } });
    } else if (kind === "diagram") {
      navigate("bom", { message: { type: Bridge.MESSAGE_TYPES.OPEN_DIAGRAM, payload: { diagramId: id, view: "bom" } } });
    } else if (kind === "shipment") {
      navigate("sales", { message: { type: Bridge.MESSAGE_TYPES.OPEN_SHIPMENT, payload: { shipmentId: id } } });
    } else if (kind === "market") {
      navigate("sales", { message: { type: Bridge.MESSAGE_TYPES.FOCUS_MARKET, payload: { marketId: id } } });
    } else {
      navigate(route || "overview");
    }
  }

  /* -------------------------------------------------------------------------
     Event Binding & Inter-Module Messaging
     ------------------------------------------------------------------------- */
  document.addEventListener("click", ev => {
    if (state.menuOpen && !ev.target.closest(".shell-menu-wrap")) {
      setMenuOpen(false);
    }

    const menuBtn = ev.target.closest("#shellMenuBtn");
    if (menuBtn) {
      setMenuOpen(!state.menuOpen);
      return;
    }

    const shellAct = ev.target.closest("[data-shell-action]");
    if (shellAct) {
      const act = shellAct.dataset.shellAction;
      setMenuOpen(false);
      if (act === "refresh") {
        renderOverview();
        if (state.route === "bom" || state.route === "sales") {
          sendToModule(state.route, Bridge.MESSAGE_TYPES.RELOAD_STORAGE, {});
        }
      }
      return;
    }

    const navTrigger = ev.target.closest("[data-route]");
    if (navTrigger) {
      navigate(navTrigger.dataset.route);
      return;
    }

    const jumpBtn = ev.target.closest("[data-jump-module]");
    if (jumpBtn) {
      const mod = jumpBtn.dataset.jumpModule;
      const view = jumpBtn.dataset.jumpView;
      navigate(mod, view ? {
        message: { type: Bridge.MESSAGE_TYPES.NAVIGATE, payload: { view } }
      } : undefined);
      return;
    }

    const remBtn = ev.target.closest("[data-reminder-index]");
    if (remBtn && latestSnapshot) {
      const item = latestSnapshot.reminders[Number(remBtn.dataset.reminderIndex)];
      if (item) {
        navigate(item.route, item.message ? { message: item.message } : undefined);
      }
      return;
    }

    const recBtn = ev.target.closest("[data-recent-kind]");
    if (recBtn) {
      openRecentEntity(recBtn.dataset.recentKind, recBtn.dataset.recentId, recBtn.dataset.recentRoute);
    }
  });

  document.addEventListener("keydown", ev => {
    if (ev.key === "Escape" && state.menuOpen) {
      setMenuOpen(false);
    }
  });

  // Close shell dropdown when focus shifts into a module iframe
  global.addEventListener("blur", () => {
    if (state.menuOpen) setMenuOpen(false);
  });

  global.addEventListener("hashchange", () => {
    const next = resolveRouteFromHash();
    if (next !== state.route) navigate(next);
  });

  global.addEventListener("storage", () => {
    if (aiSidebar?.refreshIndex) aiSidebar.refreshIndex();
    if (state.route === "overview") renderOverview();
    else updateSaveIndicator();
  });

  global.addEventListener("message", ev => {
    if (!Bridge.isTrustedEvent(ev)) return;
    const msg = ev.data;
    const source = msg.source;
    if (source !== "bom" && source !== "sales") return;
    if (!state.frames[source] || ev.source !== state.frames[source].contentWindow) return;

    if (msg.type === Bridge.MESSAGE_TYPES.MODULE_READY && (source === "bom" || source === "sales")) {
      state.ready[source] = true;
      flushPendingMessages(source);
      return;
    }

    if (msg.type === Bridge.MESSAGE_TYPES.SAVE_STATUS) {
      state.saveStatus[source] = {
        ok: msg.payload?.ok !== false,
        message: msg.payload?.message || ""
      };
      updateSaveIndicator();
      return;
    }

    if (msg.type === Bridge.MESSAGE_TYPES.DATA_CHANGED) {
      if (global.SCDataStore?.rebuildManifest) {
        global.SCDataStore.rebuildManifest();
      }
      if (aiSidebar?.refreshIndex) aiSidebar.refreshIndex();
      if (state.route === "overview") renderOverview();
      else updateSaveIndicator();
      return;
    }

    if (msg.type === Bridge.MESSAGE_TYPES.ENTITY_VISITED && msg.payload) {
      const entityModule = source === "bom" ? "bom" : "sales";
      Storage.recordRecentWork({
        kind: msg.payload.kind,
        id: msg.payload.id,
        name: msg.payload.name,
        route: entityModule
      });
      if (aiSidebar) aiSidebar.setSelectedEntity(Object.assign({ module: entityModule }, msg.payload));
      if (state.route === "overview") renderOverview();
      return;
    }

    if (msg.type === Bridge.MESSAGE_TYPES.ENTITY_CLEARED) {
      if (aiSidebar) aiSidebar.clearSelectedEntity(source === "bom" ? "bom" : "sales");
      return;
    }

    if (msg.type === Bridge.MESSAGE_TYPES.NAVIGATE_SHELL && msg.payload?.route) {
      navigate(msg.payload.route);
    }
  });

  // Boot cleanly without writing or clearing any user business storage
  renderOverview();
  const initialRoute = resolveRouteFromHash();
  if (global.SCAISidebar && typeof global.SCAISidebar.mount === "function") {
    aiSidebar = global.SCAISidebar.mount({
      initialModule: initialRoute,
      onDataMutated: (info) => {
        if (global.SCDataStore?.rebuildManifest) {
          global.SCDataStore.rebuildManifest();
        }
        if (aiSidebar?.refreshIndex) aiSidebar.refreshIndex();
        renderOverview();
        if (info?.module === "sales" && state.frames.sales) {
          sendToModule("sales", Bridge.MESSAGE_TYPES.RELOAD_STORAGE, {});
        } else if (info?.module === "bom" && state.frames.bom) {
          sendToModule("bom", Bridge.MESSAGE_TYPES.RELOAD_STORAGE, {});
        }
      },
      onNavigateEntity: (type, id) => {
        const kindMap = { company: "company", diagram: "diagram", shipment: "shipment", market: "market" };
        if (kindMap[type]) openRecentEntity(kindMap[type], id, type === "company" || type === "diagram" ? "bom" : "sales");
      }
    });
  }
  if (initialRoute !== "overview") {
    navigate(initialRoute);
  }
})(window);
