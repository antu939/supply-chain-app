"use strict";

/* ---------------------------------------------------------------------------
   右侧抽屉：公司资料 / 工厂供货路径
--------------------------------------------------------------------------- */
let panelScrollMemory = { key: null, top: 0 };
let lastShellEntityKey = "";

function renderPanel() {
  const layer = $("#panelLayer");
  const panel = $("#panel");
  if (!layer || !panel) return;

  if (!ui.panel) {
    layer.classList.add("hidden");
    layer.setAttribute("aria-hidden", "true");
    panel.removeAttribute("aria-labelledby");
    panel.className = "panel";
    panel.innerHTML = "";
    panelScrollMemory = { key: null, top: 0 };
    if (lastShellEntityKey !== "" && typeof window !== "undefined" && window.BOMHostBridge?.postToShell) {
      lastShellEntityKey = "";
      window.BOMHostBridge.postToShell("sc:entity-cleared", { module: "bom" });
    }
    return;
  }

  const panelKey = JSON.stringify(ui.panel);
  const keepTop = panelScrollMemory.key === panelKey ? panelScrollMemory.top : 0;

  if (ui.panel.type === "company") {
    const company = state.companies[ui.panel.companyId];
    if (!company) {
      ui.panel = null;
      return renderPanel();
    }
    layer.classList.remove("hidden");
    layer.setAttribute("aria-hidden", "false");
    panel.setAttribute("aria-labelledby", "panelTitle");
    panel.className = "panel panel-company";
    panel.innerHTML = companyPanelHTML(company, ui.panel.nodeId || null);
    lastShellEntityKey = `company:${company.id}`;
  } else if (ui.panel.type === "factories") {
    const { nid, down, up } = ui.panel;
    if (!state.nodes[nid] || !hasCompanyLink(state, nid, down, up)) {
      ui.panel = null;
      return renderPanel();
    }
    if (lastShellEntityKey !== "" && typeof window !== "undefined" && window.BOMHostBridge?.postToShell) {
      lastShellEntityKey = "";
      window.BOMHostBridge.postToShell("sc:entity-cleared", { module: "bom" });
    }
    layer.classList.remove("hidden");
    layer.setAttribute("aria-hidden", "false");
    panel.setAttribute("aria-labelledby", "panelTitle");
    panel.className = "panel panel-factories";
    panel.innerHTML = factoryPanelHTML(nid, down, up);
  }

  const body = panel.querySelector(".panel-body");
  if (body) {
    body.scrollTop = keepTop;
    body.addEventListener("scroll", () => {
      panelScrollMemory = { key: panelKey, top: body.scrollTop };
    }, { passive: true });
  }
  if (ui.panel.type === "factories") setupFactoryGraph();

  if (ui.panelAttention) {
    ui.panelAttention = false;
    requestAnimationFrame(() => panel.focus({ preventScroll: true }));
  }
}

function panelSection(title, body, extra = "") {
  return `<section class="panel-section">
    <div class="panel-section-head"><h3>${esc(title)}</h3>${extra}</div>
    ${body}
  </section>`;
}

function infoRows(rows) {
  return `<dl class="info-rows">${rows.map(([label, value]) => `<div class="info-row"><dt>${esc(label)}</dt><dd>${value === "" || value === undefined ? '<span class="muted">—</span>' : esc(value)}</dd></div>`).join("")}</dl>`;
}

function companyRelationsHTML(cid) {
  const rows = companyLinkRows(cid);
  if (!rows.length) {
    return `<p class="panel-empty">No supply links</p>`;
  }
  const supplierRows = rows.filter(r => r.role === "supplier");
  const receiverRows = rows.filter(r => r.role === "receiver");
  const group = (label, list, role) => list.length
    ? `<div class="relation-group">
        <div class="relation-group-title"><span class="relation-tag ${role}">${label}</span><span>${list.length}</span></div>
        ${list.map(r => `<button type="button" class="relation-row" data-action="open-factories" data-nid="${r.nid}" data-down="${r.down}" data-up="${r.up}">
          <span class="relation-copy"><strong>${complianceBadgeHTML(r.other)}${esc(companyName(r.other))}</strong><small>${esc(pathOf(r.nid))}</small></span>
          <span class="relation-meta">${r.factoryCount ? r.factoryCount + (r.factoryCount === 1 ? " route" : " routes") : "No routes"}</span>
          ${icon("forward", 12)}
        </button>`).join("")}
      </div>`
    : "";
  return group("Supplies → Downstream", supplierRows, "supplier") + group("Receives ← Upstream", receiverRows, "receiver");
}

function companyFactoriesHTML(cid) {
  const list = factoriesOf(state, cid);
  return `<div class="factory-list">
    ${list.map(f => `<button type="button" class="factory-row ${f.status === "archived" ? "is-archived" : ""}" data-action="edit-factory" data-factory="${f.id}" title="Edit ${esc(f.name)}">
      <span class="factory-icon" aria-hidden="true">${icon("factory", 14)}</span>
      <span class="factory-copy"><strong>${esc(f.name)}${f.status === "archived" ? '<span class="archived-tag">Archived</span>' : ""}</strong><small>${esc(f.location || "—")}</small></span>
      <span class="factory-edit">${icon("edit", 12)}</span>
    </button>`).join("")}
    <button type="button" class="add-row" data-action="add-factory" data-company="${cid}">${icon("plus", 13)}Add Plant</button>
  </div>`;
}

function companyAppearancesHTML(cid) {
  const nodes = companyNodes(cid);
  if (!nodes.length) return `<p class="panel-empty">No BOM nodes</p>`;
  return `<div class="appearance-list">${nodes.map(n => `<button type="button" class="appearance-chip" data-action="goto-relations" data-node="${n.id}" title="Open ${esc(pathOf(n.id))}">
    <span>${esc(pathOf(n.id))}</span>${icon("forward", 11)}
  </button>`).join("")}</div>`;
}

function companyCustomFieldsHTML(company) {
  const entries = Object.entries(company.extraFields || {});
  if (!entries.length) return `<p class="panel-empty">No custom fields</p>`;
  return `<table class="kv-table"><tbody>${entries.map(([key, value]) => `<tr><th>${esc(key)}</th><td>${value ? esc(value) : '<span class="muted">—</span>'}</td></tr>`).join("")}</tbody></table>`;
}

function companyComplianceHTML(company) {
  const compliance = normalizeCompliance(company.compliance);
  const meta = complianceStatus(compliance.status);
  return `<div class="comp-face comp-status-${meta.key}">
    <div class="comp-face-main">
      <div class="comp-status-head">
        <span class="comp-status-dot large" aria-hidden="true"></span>
        <div class="comp-status-heading"><strong>${esc(meta.label)}</strong></div>
        ${Number.isSafeInteger(compliance.updatedAt) ? `<span class="comp-stamp">${stampText(compliance.updatedAt)}</span>` : ""}
      </div>
      ${compliance.reason ? `<p class="comp-reason">${esc(compliance.reason)}</p>` : `<p class="panel-empty">No notes</p>`}
    </div>
  </div>`;
}

function companyMergeHistoryHTML(cid){
  const archives=values(state.mergedCompanyArchives||{}).filter(c=>c&&c.mergedInto===cid||(!c.mergedInto&&normalizedCompanyName(c.name)===normalizedCompanyName(companyName(cid))));
  if(!archives.length)return "";
  return panelSection("Merge History",`${archives.map(c=>`<div class="archive-entry"><strong>${esc(c.name)} · ${esc(c.id)}</strong>
    ${infoRows([["Location",c.location],["Contact",c.contact],["Notes",c.note]])}
    ${Object.entries(c.extraFields||{}).length?`<p class="panel-empty">Custom: ${Object.entries(c.extraFields).map(([key,value])=>`${esc(key)}=${esc(value)}`).join(" · ")}</p>`:""}</div>`).join("")}`);
}

function companyPanelHTML(company, nodeId) {
  const role = roleOf(company.id);
  const roleMeta = ROLE_META[role];
  const stat = companyStats(company.id);
  const removeLink = nodeId && groupOf(state, nodeId).includes(company.id)
    ? `<section class="panel-danger">
        <button type="button" class="btn ghost danger" data-action="remove-company-from-node" data-node="${nodeId}" data-company="${company.id}">${icon("trash", 13)}Unlink from "${esc(nodeName(nodeId))}"</button>
      </section>`
    : "";
  return `<header class="panel-head">
    <div class="panel-heading">
      <span class="panel-avatar">${esc(initials(company.name))}</span>
      <div class="panel-heading-copy">
        <p class="eyebrow">COMPANY</p>
        <h2 id="panelTitle">${esc(company.name)}</h2>
        <div class="panel-badges"><span class="role-badge ${role}"><i class="role-dot ${role}"></i>${roleMeta.label}</span><span class="panel-meta">${stat.factories} plants · ${stat.links} links</span></div>
      </div>
    </div>
    <button type="button" class="icon-btn panel-close" data-action="close-panel" aria-label="Close">${icon("close", 16)}</button>
  </header>
  <div class="panel-body">
    <div class="panel-actions">
      <button type="button" class="btn primary small" data-action="edit-company" data-company="${company.id}">${icon("edit", 13)}Edit</button>
      <button type="button" class="btn small" data-action="add-factory" data-company="${company.id}">${icon("plus", 13)}Add Plant</button>
      <button type="button" class="btn small" data-action="trace-company-downstream" data-company="${company.id}" title="Trace downstream">${icon("link", 13)}Trace</button>
    </div>
    ${panelSection("Details", infoRows([["Location", company.location], ["Contact", company.contact], ["Notes", company.note]]))}
    ${panelSection("Compliance", companyComplianceHTML(company), `<button type="button" class="text-btn" data-action="edit-company" data-company="${company.id}">Edit</button>`)}
    ${panelSection("Plants", companyFactoriesHTML(company.id), `<span class="section-count">${stat.factories}</span>`)}
    ${panelSection("Supply Links", companyRelationsHTML(company.id), `<span class="section-count">${stat.links}</span>`)}
    ${panelSection("BOM Usage", companyAppearancesHTML(company.id), `<span class="section-count">${stat.nodes}</span>`)}
    ${panelSection("Custom Fields", companyCustomFieldsHTML(company), `<button type="button" class="text-btn" data-action="edit-company" data-company="${company.id}">Edit</button>`)}
    ${companyMergeHistoryHTML(company.id)}
    ${removeLink}
  </div>`;
}

/* ---------------------------------------------------------------------------
   工厂供货路径：左接收方工厂 / 右供应方工厂的二部图
--------------------------------------------------------------------------- */
let factoryPick = null;
let factoryGraphKey = null;
let factoryObserver = null;
let factoryFrame = 0;
let factoryScroll = { receiver: 0, supplier: 0, board: 0 };

function factoryPanelContext() {
  const panel = ui.panel;
  if (!panel || panel.type !== "factories") return null;
  if (!state.nodes[panel.nid] || !hasCompanyLink(state, panel.nid, panel.down, panel.up)) return null;
  return panel;
}

function validFactoryPick() {
  if (!factoryPick) return null;
  const ctx = factoryPanelContext();
  if (!ctx) {
    factoryPick = null;
    return null;
  }
  const pool = factoryPick.role === "receiver" ? factoriesOf(state, ctx.down) : factoriesOf(state, ctx.up);
  if (!pool.some(factory => factory.id === factoryPick.cid)) {
    factoryPick = null;
    return null;
  }
  return factoryPick;
}

function factoryPairLinked(ctx, receiverId, supplierId) {
  return getFactoryLinks(state, ctx.nid, ctx.down, ctx.up)
    .some(pair => pair.receiverFactoryId === receiverId && pair.supplierFactoryId === supplierId);
}

function factoryLinkCountFor(ctx, role, factoryId) {
  const pairs = getFactoryLinks(state, ctx.nid, ctx.down, ctx.up);
  return role === "receiver"
    ? pairs.filter(pair => pair.receiverFactoryId === factoryId).length
    : pairs.filter(pair => pair.supplierFactoryId === factoryId).length;
}

function factoryNodeHTML(ctx, role, factoryId) {
  const factory = state.factories[factoryId];
  if (!factory) return "";
  const selected = factoryPick && factoryPick.role === role && factoryPick.cid === factoryId;
  const linked = factoryLinkCountFor(ctx, role, factoryId);
  const roleLabel = role === "receiver" ? "Receiver" : "Supplier";
  return `<div class="bip-node factory-node ${role} ${linked ? "has-links" : ""} ${selected ? "is-selected" : ""}" data-fbip-node data-action="pick-factory-party" data-role="${role}" data-factory="${factoryId}">
    <button type="button" class="bip-node-main" data-action="pick-factory-party" data-role="${role}" data-factory="${factoryId}" aria-pressed="${!!selected}" title="Select ${roleLabel} plant: ${esc(factory.name)}">
      <span class="party-avatar factory">${icon("factory", 14)}</span>
      <span class="bip-node-copy"><strong>${esc(factory.name)}</strong><small>${esc(factory.location || "—")}</small></span>
    </button>
    ${linked ? `<span class="bip-node-meta has-links">${icon("link", 11)}<b>${linked}</b></span>` : ""}
    <button type="button" class="bip-node-edit" data-action="edit-factory" data-factory="${factoryId}" title="Edit ${esc(factory.name)}" aria-label="Edit ${esc(factory.name)}">${icon("edit", 12)}</button>
    <span class="bip-node-cta" aria-hidden="true"></span>
    <span class="bip-node-check" aria-hidden="true">${icon("check", 11)}</span>
    <span class="bip-port ${role}" aria-hidden="true"></span>
  </div>`;
}

function factoryColumnHTML(ctx, role) {
  const companyId = role === "receiver" ? ctx.down : ctx.up;
  const list = factoriesOf(state, companyId);
  const label = role === "receiver" ? "Receiver Plants" : "Supplier Plants";
  return `<section class="bip-column ${role} factory-column" data-role="${role}" aria-label="${label}">
    <header class="bip-col-head">
      <div class="bip-col-title">
        <span class="bip-role-pill ${role}"><span class="party-dot ${role}" aria-hidden="true"></span>${label}</span>
        <span class="count-badge">${list.length}</span>
      </div>
      <button type="button" class="bip-col-manage" data-action="add-factory" data-company="${companyId}" title="Add plant for ${esc(companyName(companyId))}">${icon("plus", 12)}<span>Plant</span></button>
    </header>
    <div class="bip-list">
      ${list.length ? list.map(factory => factoryNodeHTML(ctx, role, factory.id)).join("") : `<button type="button" class="bip-add" data-action="add-factory" data-company="${companyId}">
        <span class="bip-add-mark" aria-hidden="true">+</span>
        <span><strong>Add Plant</strong></span>
      </button>`}
    </div>
  </section>`;
}

function factoryHintHTML(ctx) {
  const receivers = factoriesOf(state, ctx.down);
  const suppliers = factoriesOf(state, ctx.up);
  const pairCount = getFactoryLinks(state, ctx.nid, ctx.down, ctx.up).length;
  if (!receivers.length || !suppliers.length) {
    const missing = !receivers.length && !suppliers.length ? "Both companies" : !receivers.length ? "Receiver" : "Supplier";
    return `<div class="bip-hint-main"><span class="bip-hint-icon">${icon("warn", 13)}</span><p>${missing} has no plants</p></div>`;
  }
  const pick = validFactoryPick();
  if (!pick) {
    return `<span class="bip-hint-side">${pairCount} ${pairCount === 1 ? "route" : "routes"}</span>`;
  }
  const roleLabel = pick.role === "receiver" ? "Receiver Plant" : "Supplier Plant";
  const linked = factoryLinkCountFor(ctx, pick.role, pick.cid);
  const factoryName = state.factories[pick.cid]?.name || "";
  return `<div class="bip-hint-main"><span class="bip-hint-icon is-pick">${icon("check", 13)}</span><p>${roleLabel}: <strong>${esc(factoryName)}</strong> · ${linked} ${linked === 1 ? "route" : "routes"}</p></div><button type="button" class="bip-hint-clear" data-action="clear-factory-pick">${icon("close", 12)}Clear</button>`;
}

function factoryMarkersHTML() {
  return `<defs>
    <marker id="fbipArrow" markerWidth="9" markerHeight="9" refX="8" refY="4.5" orient="auto" markerUnits="userSpaceOnUse"><path d="M1 1.2 8 4.5 1 7.8" fill="none" stroke="#a7c2b5" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></marker>
    <marker id="fbipArrowHot" markerWidth="9" markerHeight="9" refX="8" refY="4.5" orient="auto" markerUnits="userSpaceOnUse"><path d="M1 1.2 8 4.5 1 7.8" fill="none" stroke="#256b56" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></marker>
  </defs>`;
}

function factoryEdgeLabelHTML(cx, cy, text) {
  const width = Math.max(74, text.length * 9.5 + 16);
  return `<g class="bip-edge-label" aria-hidden="true">
    <rect x="${(cx - width / 2).toFixed(1)}" y="${(cy - 11).toFixed(1)}" width="${width.toFixed(1)}" height="22" rx="11"/>
    <text x="${cx.toFixed(1)}" y="${(cy + 3.4).toFixed(1)}" text-anchor="middle">${esc(text)}</text>
  </g>`;
}

function factoryBipHTML(ctx) {
  const graphKey = [ctx.nid, ctx.down, ctx.up].join("|");
  if (factoryGraphKey !== graphKey) {
    factoryGraphKey = graphKey;
    factoryPick = null;
    factoryScroll = { receiver: 0, supplier: 0, board: 0 };
  }
  validFactoryPick();
  return `<div class="factory-bip">
    <div class="bip-hint factory-bip-hint" id="factoryHint" role="status">${factoryHintHTML(ctx)}</div>
    <div class="bip-board bip-board-factory" id="factoryBoard">
      <div class="bip-columns">
        ${factoryColumnHTML(ctx, "receiver")}
        <div class="bip-gap" aria-hidden="true"></div>
        ${factoryColumnHTML(ctx, "supplier")}
      </div>
      <svg class="bip-edges" id="factoryEdges" role="group" aria-label="Factory supply links"></svg>
    </div>
  </div>`;
}

function drawFactoryEdges() {
  const ctx = factoryPanelContext();
  const board = $("#factoryBoard");
  const svg = $("#factoryEdges");
  const columns = board ? $(".bip-columns", board) : null;
  if (!ctx || !board || !svg || !columns) return;
  const width = Math.max(board.clientWidth, columns.offsetWidth);
  const height = Math.max(board.clientHeight, columns.offsetHeight);
  svg.setAttribute("width", width);
  svg.setAttribute("height", height);
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.style.width = width + "px";
  svg.style.height = height + "px";
  const pick = validFactoryPick();
  if (!pick) {
    svg.innerHTML = factoryMarkersHTML();
    return;
  }
  const allPairs = getFactoryLinks(state, ctx.nid, ctx.down, ctx.up);
  const pairs = pick.role === "receiver"
    ? allPairs.filter(pair => pair.receiverFactoryId === pick.cid)
    : allPairs.filter(pair => pair.supplierFactoryId === pick.cid);
  if (!pairs.length) {
    svg.innerHTML = factoryMarkersHTML();
    return;
  }
  const boardRect = board.getBoundingClientRect();
  const offsetX = boardRect.left - board.scrollLeft;
  const offsetY = boardRect.top - board.scrollTop;
  const positions = new Map();
  for (const card of $$("[data-fbip-node]", board)) {
    const list = card.closest(".bip-list");
    if (!list) continue;
    const cardRect = card.getBoundingClientRect();
    const listRect = list.getBoundingClientRect();
    if (cardRect.height < 1 || cardRect.top < listRect.top - 1 || cardRect.bottom > listRect.bottom + 1) continue;
    const role = card.dataset.role;
    const x = (role === "receiver" ? cardRect.right : cardRect.left) - offsetX;
    const y = cardRect.top + cardRect.height / 2 - offsetY;
    positions.set(role + ":" + card.dataset.factory, { x, y, h: cardRect.height });
  }
  let html = factoryMarkersHTML();
  const total = pairs.length;
  pairs.forEach((pair, index) => {
    const a = positions.get("receiver:" + pair.receiverFactoryId);
    const b = positions.get("supplier:" + pair.supplierFactoryId);
    if (!a || !b) return;
    const ay = pick.role === "receiver" ? a.y + bipFanOffset(index, total, a.h) : a.y;
    const by = pick.role === "supplier" ? b.y + bipFanOffset(index, total, b.h) : b.y;
    const dx = Math.max(36, (b.x - a.x) * 0.45);
    const d = `M${b.x.toFixed(1)},${by.toFixed(1)} C${(b.x - dx).toFixed(1)},${by.toFixed(1)} ${(a.x + dx).toFixed(1)},${ay.toFixed(1)} ${a.x.toFixed(1)},${ay.toFixed(1)}`;
    const receiverName = state.factories[pair.receiverFactoryId]?.name || "";
    const supplierName = state.factories[pair.supplierFactoryId]?.name || "";
    const cx = (a.x + b.x) / 2;
    const cy = (ay + by) / 2;
    html += `<g class="bip-edge factory-edge" data-action="toggle-factory-link" data-nid="${ctx.nid}" data-down="${ctx.down}" data-up="${ctx.up}" data-receiver="${pair.receiverFactoryId}" data-supplier="${pair.supplierFactoryId}" role="button" tabindex="0" aria-label="Remove route ${esc(supplierName)} to ${esc(receiverName)}">
      <title>${esc(supplierName)} → ${esc(receiverName)} · Click to remove</title>
      <path class="bip-edge-hit" d="${d}"/>
      <path class="bip-edge-line" d="${d}" marker-end="url(#fbipArrow)"/>
      ${factoryEdgeLabelHTML(cx, cy, "Remove")}
    </g>`;
  });
  svg.innerHTML = html;
}

function paintFactoryFocus() {
  const ctx = factoryPanelContext();
  const board = $("#factoryBoard");
  if (!ctx || !board) return;
  const pick = validFactoryPick();
  if (!pick) {
    board.classList.remove("has-focus");
    for (const card of $$("[data-fbip-node]", board)) {
      card.classList.remove("is-connected", "is-target", "is-dim");
      const cta = card.querySelector(".bip-node-cta");
      if (cta) {
        cta.textContent = "";
        cta.classList.remove("is-linked");
      }
    }
    for (const edge of $$(".bip-edge", board)) edge.classList.remove("is-hot", "is-dim");
    return;
  }
  const connected = new Set([pick.role + ":" + pick.cid]);
  for (const pair of getFactoryLinks(state, ctx.nid, ctx.down, ctx.up)) {
    if (pick.role === "receiver" && pair.receiverFactoryId === pick.cid) {
      connected.add("supplier:" + pair.supplierFactoryId);
    } else if (pick.role === "supplier" && pair.supplierFactoryId === pick.cid) {
      connected.add("receiver:" + pair.receiverFactoryId);
    }
  }
  board.classList.add("has-focus");
  for (const card of $$("[data-fbip-node]", board)) {
    const role = card.dataset.role;
    const factoryId = card.dataset.factory;
    const isConnected = connected.has(role + ":" + factoryId);
    const isOpposite = role !== pick.role;
    card.classList.toggle("is-connected", isConnected);
    card.classList.toggle("is-target", isOpposite);
    card.classList.toggle("is-dim", !isOpposite && !isConnected);
    const cta = card.querySelector(".bip-node-cta");
    if (cta && isOpposite) {
      const receiverId = role === "receiver" ? factoryId : pick.cid;
      const supplierId = role === "supplier" ? factoryId : pick.cid;
      const linked = factoryPairLinked(ctx, receiverId, supplierId);
      cta.textContent = linked ? "Remove" : "+ Route";
      cta.classList.toggle("is-linked", linked);
    } else if (cta) {
      cta.textContent = "";
      cta.classList.remove("is-linked");
    }
  }
  for (const edge of $$(".bip-edge", board)) {
    edge.classList.add("is-hot");
    edge.classList.remove("is-dim");
  }
}

function refreshFactorySelection() {
  const ctx = factoryPanelContext();
  if (!ctx) {
    factoryPick = null;
    return;
  }
  validFactoryPick();
  const hint = $("#factoryHint");
  if (hint) hint.innerHTML = factoryHintHTML(ctx);
  const board = $("#factoryBoard");
  if (!board) return;
  for (const card of $$("[data-fbip-node]", board)) {
    const selected = !!(factoryPick && factoryPick.role === card.dataset.role && factoryPick.cid === card.dataset.factory);
    card.classList.toggle("is-selected", selected);
    const main = card.querySelector('[data-action="pick-factory-party"]');
    if (main) main.setAttribute("aria-pressed", String(selected));
  }
  paintFactoryFocus();
  scheduleFactoryDraw();
}

function pickFactoryParty(role, factoryId) {
  const ctx = factoryPanelContext();
  if (!ctx || !["receiver", "supplier"].includes(role)) return;
  const pool = role === "receiver" ? factoriesOf(state, ctx.down) : factoriesOf(state, ctx.up);
  if (!pool.some(factory => factory.id === factoryId)) return;
  const pick = validFactoryPick();
  if (pick && pick.role === role && pick.cid === factoryId) {
    factoryPick = null;
    refreshFactorySelection();
    return;
  }
  if (pick && pick.role !== role) {
    const receiverId = role === "receiver" ? factoryId : pick.cid;
    const supplierId = role === "supplier" ? factoryId : pick.cid;
    toggleFactoryLink(ctx.nid, ctx.down, ctx.up, receiverId, supplierId);
    return;
  }
  factoryPick = { role, cid: factoryId };
  refreshFactorySelection();
}

function clearFactoryPick() {
  factoryPick = null;
  refreshFactorySelection();
}

function restoreFactoryScroll() {
  const board = $("#factoryBoard");
  if (!board) return;
  for (const role of ["receiver", "supplier"]) {
    const list = $(`.bip-column.${role} .bip-list`, board);
    if (list) list.scrollTop = factoryScroll[role] || 0;
  }
  board.scrollLeft = factoryScroll.board || 0;
}

function scheduleFactoryDraw() {
  if (factoryFrame) return;
  factoryFrame = requestAnimationFrame(() => {
    factoryFrame = 0;
    drawFactoryEdges();
    paintFactoryFocus();
  });
}

function observeFactoryBoard(board) {
  if (typeof ResizeObserver === "undefined") return;
  if (!factoryObserver) factoryObserver = new ResizeObserver(() => scheduleFactoryDraw());
  factoryObserver.disconnect();
  factoryObserver.observe(board);
  $$(".bip-list", board).forEach(el => factoryObserver.observe(el));
  $$("[data-fbip-node]", board).forEach(el => factoryObserver.observe(el));
}

function setupFactoryGraph() {
  const ctx = factoryPanelContext();
  const board = $("#factoryBoard");
  if (!ctx || !board) return;
  restoreFactoryScroll();
  board.addEventListener("keydown", event => {
    const edge = event.target.closest?.(".bip-edge");
    if (edge && (event.key === "Enter" || event.key === " ")) {
      event.preventDefault();
      edge.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
    }
  });
  board.addEventListener("click", event => {
    if (event.target.closest("[data-fbip-node], .bip-edge, button, [data-action]")) return;
    if (!factoryPick) return;
    factoryPick = null;
    refreshFactorySelection();
  });
  for (const list of $$(".bip-list", board)) {
    const role = list.closest(".bip-column")?.dataset.role;
    list.addEventListener("scroll", () => {
      if (role) factoryScroll[role] = list.scrollTop;
      scheduleFactoryDraw();
    }, { passive: true });
  }
  board.addEventListener("scroll", () => {
    factoryScroll.board = board.scrollLeft;
  }, { passive: true });
  observeFactoryBoard(board);
  scheduleFactoryDraw();
}

function factoryPanelHTML(nid, down, up) {
  const pairCount = getFactoryLinks(state, nid, down, up).length;
  return `<header class="panel-head">
    <div class="panel-heading">
      <span class="panel-avatar factory">${icon("factory", 17)}</span>
      <div class="panel-heading-copy">
        <p class="eyebrow">PLANT ROUTES</p>
        <h2 id="panelTitle">${esc(companyName(down))} <span class="panel-title-arrow">←</span> ${esc(companyName(up))}</h2>
        <div class="panel-badges"><span class="panel-meta">${esc(pathOf(nid))}</span></div>
      </div>
    </div>
    <button type="button" class="icon-btn panel-close" data-action="close-panel" aria-label="Close">${icon("close", 16)}</button>
  </header>
  <div class="panel-body">
    <div class="pair-banner">
      <button type="button" class="pair-party" data-action="open-company" data-company="${down}" data-node="${nid}">
        <span class="axis-pill receiver">Receiver</span>
        <strong>${complianceBadgeHTML(down)}${esc(companyName(down))}</strong>
        <small>${esc(companyLocation(down))}</small>
      </button>
      <span class="pair-arrow" aria-hidden="true">${icon("arrowLeft", 18)}</span>
      <button type="button" class="pair-party right" data-action="open-company" data-company="${up}" data-node="${nid}">
        <span class="axis-pill supplier">Supplier</span>
        <strong>${complianceBadgeHTML(up)}${esc(companyName(up))}</strong>
        <small>${esc(companyLocation(up))}</small>
      </button>
    </div>
    ${panelSection("Plant Routes", factoryBipHTML({ nid, down, up }), `<span class="section-count">${pairCount}</span>`)}
    <section class="panel-danger">
      <button type="button" class="btn ghost danger" data-action="remove-company-link" data-nid="${nid}" data-down="${down}" data-up="${up}">${icon("trash", 13)}Remove Supply Link…</button>
    </section>
  </div>`;
}

function openCompanyPanel(companyId, nodeId = null) {
  if (!state.companies[companyId]) return;
  openPanel({ type: "company", companyId, nodeId });
  if (typeof window !== "undefined" && window.BOMHostBridge?.postToShell) {
    window.BOMHostBridge.postToShell("sc:entity-visited", {
      kind: "company",
      id: companyId,
      name: state.companies[companyId].name
    });
  }
}
function openFactoriesPanel(nid, down, up) {
  if (!state.nodes[nid] || !hasCompanyLink(state, nid, down, up)) {
    notify("Create a company supply link first");
    return;
  }
  const current = ui.panel;
  if (!current || current.type !== "factories" || current.nid !== nid || current.down !== down || current.up !== up) {
    factoryPick = null;
    factoryGraphKey = null;
    factoryScroll = { receiver: 0, supplier: 0, board: 0 };
    panelScrollMemory = { key: null, top: 0 };
  }
  openPanel({ type: "factories", nid, down, up });
}

window.addEventListener("resize", () => {
  if (ui.panel?.type === "factories" && $("#factoryBoard")) scheduleFactoryDraw();
});
