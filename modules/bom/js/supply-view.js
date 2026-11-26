"use strict";

/* ---------------------------------------------------------------------------
   公司供货关系：左接收方 / 右供应方的二部图
   · 一行公司不再按矩阵排列；两侧各自成列，连线只表达当前组件连线上的关系
   · 先点一侧公司，再点另一侧公司即可建立关系；已有关系点连线管理工厂
--------------------------------------------------------------------------- */
let supplyPick = null;
let supplyFlash = null;
let supplyGraphKey = null;
let supplyObserver = null;
let supplyFrame = 0;
let supplyScroll = { receiver: 0, supplier: 0, board: 0 };

function companyLocation(cid) {
  return state.companies[cid]?.location || "—";
}

function supplyPairKey(role, cid) {
  return role + ":" + cid;
}

function supplyOwnerNodeId(nid, role) {
  const node = state.nodes[nid];
  return role === "receiver" ? node?.parentId : node?.id;
}

function validSupplyPick() {
  if (!supplyPick) return null;
  const node = state.nodes[ui.focusNode];
  if (!node || !node.parentId) {
    supplyPick = null;
    return null;
  }
  const ids = supplyPick.role === "receiver" ? groupOf(state, node.parentId) : groupOf(state, node.id);
  if (!ids.includes(supplyPick.cid) || !state.companies[supplyPick.cid]) {
    supplyPick = null;
    return null;
  }
  return supplyPick;
}

function linkedCounterparts(nid, role, cid) {
  const node = state.nodes[nid];
  if (!node || !node.parentId) return [];
  const rows = state.relationships[nid] || {};
  if (role === "receiver") {
    return (rows[cid] || []).filter(up => groupOf(state, node.id).includes(up));
  }
  return Object.entries(rows)
    .filter(([down, ups]) => groupOf(state, node.parentId).includes(down) && ups.includes(cid))
    .map(([down]) => down);
}

function supplyNodeHTML(nid, cid, role) {
  const company = state.companies[cid];
  if (!company) return "";
  const selected = supplyPick && supplyPick.role === role && supplyPick.cid === cid;
  const linked = linkedCounterparts(nid, role, cid).length;
  const roleLabel = role === "receiver" ? "Receiver" : "Supplier";
  const ownerId = supplyOwnerNodeId(nid, role);
  return `<div class="bip-node ${role} ${linked ? "has-links" : ""} ${selected ? "is-selected" : ""}" data-bip-node data-action="pick-supply-party" data-role="${role}" data-company="${cid}" data-node="${nid}">
    <button type="button" class="bip-node-main" data-action="pick-supply-party" data-role="${role}" data-company="${cid}" aria-pressed="${!!selected}" title="Select ${roleLabel}: ${esc(company.name)}">
      <span class="party-avatar">${esc(initials(company.name))}</span>
      <span class="bip-node-copy"><span class="bip-node-title"><strong>${esc(company.name)}</strong>${complianceBadgeHTML(cid)}</span><small>${esc(companyLocation(cid))}</small></span>
    </button>
    ${linked ? `<span class="bip-node-meta has-links">${icon("link", 11)}<b>${linked}</b></span>` : ""}
    <button type="button" class="bip-node-edit" data-action="open-company" data-company="${cid}" data-node="${ownerId}" title="View ${esc(company.name)}" aria-label="View ${esc(company.name)}">${icon("edit", 12)}</button>
    <span class="bip-node-cta" aria-hidden="true"></span>
    <span class="bip-node-check" aria-hidden="true">${icon("check", 11)}</span>
    <span class="bip-port ${role}" aria-hidden="true"></span>
  </div>`;
}

function supplyColumnHTML(nid, role, ids) {
  const ownerId = supplyOwnerNodeId(nid, role);
  const label = role === "receiver" ? "Receiver" : "Supplier";
  return `<section class="bip-column ${role}" data-role="${role}" aria-label="${label} companies">
    <header class="bip-col-head">
      <div class="bip-col-title">
        <span class="bip-role-pill ${role}"><span class="party-dot ${role}" aria-hidden="true"></span>${label}</span>
        <span class="count-badge">${ids.length}</span>
      </div>
      <div class="bip-col-actions">
        <button type="button" class="bip-col-manage" data-action="add-company" data-node="${ownerId}" data-role="${role}" data-label="${label}" title="Add ${label}">${icon("plus", 12)}<span>Add</span></button>
        <button type="button" class="bip-col-manage" data-action="open-relations" data-node="${ownerId}" title="Manage companies">${icon("building", 12)}<span>Manage</span></button>
      </div>
    </header>
    <div class="bip-list">
      ${ids.length ? ids.map(cid => supplyNodeHTML(nid, cid, role)).join("") : `<button type="button" class="bip-add" data-action="add-company" data-node="${ownerId}" data-role="${role}" data-label="${label}">
        <span class="bip-add-mark" aria-hidden="true">+</span>
        <span><strong>Add ${label}</strong></span>
      </button>`}
    </div>
  </section>`;
}

function supplyHintHTML() {
  const node = state.nodes[ui.focusNode];
  if (!node || !node.parentId) return "";
  const downIds = groupOf(state, node.parentId);
  const upIds = groupOf(state, node.id);
  const total = countLinksForNode(node.id);
  if (!downIds.length || !upIds.length) {
    const missing = !downIds.length && !upIds.length ? "Parent and child nodes" : !downIds.length ? "Parent node" : "Component node";
    return `<div class="bip-hint-main"><span class="bip-hint-icon">${icon("warn", 14)}</span><p>${missing} have no companies</p></div>`;
  }
  const pick = validSupplyPick();
  if (!pick) {
    return `<span class="bip-hint-side">${total} ${total === 1 ? "link" : "links"}</span>`;
  }
  const roleLabel = pick.role === "receiver" ? "Receiver" : "Supplier";
  const linked = linkedCounterparts(node.id, pick.role, pick.cid).length;
  return `<div class="bip-hint-main"><span class="bip-hint-icon is-pick">${icon("check", 14)}</span><p>${roleLabel}: <strong>${esc(companyName(pick.cid))}</strong> · ${linked} ${linked === 1 ? "link" : "links"}</p></div><button type="button" class="bip-hint-clear" data-action="clear-supply-pick">${icon("close", 12)}Clear</button>`;
}

function supplyMarkersHTML() {
  return `<defs>
    <marker id="bipArrow" markerWidth="9" markerHeight="9" refX="8" refY="4.5" orient="auto" markerUnits="userSpaceOnUse"><path d="M1 1.2 8 4.5 1 7.8" fill="none" stroke="#a7c2b5" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></marker>
    <marker id="bipArrowHot" markerWidth="9" markerHeight="9" refX="8" refY="4.5" orient="auto" markerUnits="userSpaceOnUse"><path d="M1 1.2 8 4.5 1 7.8" fill="none" stroke="#256b56" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></marker>
  </defs>`;
}

function supplyEdgeLabelHTML(cx, cy, text) {
  const width = Math.max(76, text.length * 9.5 + 16);
  return `<g class="bip-edge-label" aria-hidden="true">
    <rect x="${(cx - width / 2).toFixed(1)}" y="${(cy - 11).toFixed(1)}" width="${width.toFixed(1)}" height="22" rx="11"/>
    <text x="${cx.toFixed(1)}" y="${(cy + 3.4).toFixed(1)}" text-anchor="middle">${esc(text)}</text>
  </g>`;
}

function bipFanOffset(index, total, height) {
  if (!total || total <= 1) return 0;
  const spacing = Math.min(5.5, Math.max(2.5, (Math.max(26, height) - 26) / (total - 1)));
  return (index - (total - 1) / 2) * spacing;
}

function drawSupplyEdges() {
  const board = $("#supplyBoard");
  const svg = $("#supplyEdges");
  const node = state.nodes[ui.focusNode];
  if (!board || !svg || !node || !node.parentId) return;
  const columns = $(".bip-columns", board);
  if (!columns) return;
  const width = Math.max(board.clientWidth, columns.offsetWidth);
  const height = Math.max(board.clientHeight, columns.offsetHeight);
  svg.setAttribute("width", width);
  svg.setAttribute("height", height);
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.style.width = width + "px";
  svg.style.height = height + "px";
  const pick = validSupplyPick();
  if (!pick) {
    svg.innerHTML = supplyMarkersHTML();
    return;
  }
  const rows = state.relationships[node.id] || {};
  const pairs = [];
  if (pick.role === "receiver") {
    for (const up of rows[pick.cid] || []) pairs.push({ down: pick.cid, up });
  } else {
    for (const [down, ups] of Object.entries(rows)) {
      if (ups.includes(pick.cid)) pairs.push({ down, up: pick.cid });
    }
  }
  if (!pairs.length) {
    svg.innerHTML = supplyMarkersHTML();
    return;
  }
  const boardRect = board.getBoundingClientRect();
  const offsetX = boardRect.left - board.scrollLeft;
  const offsetY = boardRect.top - board.scrollTop;
  const positions = new Map();
  for (const card of $$("[data-bip-node]", board)) {
    const list = card.closest(".bip-list");
    if (!list) continue;
    const cardRect = card.getBoundingClientRect();
    const listRect = list.getBoundingClientRect();
    if (cardRect.height < 1 || cardRect.top < listRect.top - 1 || cardRect.bottom > listRect.bottom + 1) continue;
    const role = card.dataset.role;
    const x = (role === "receiver" ? cardRect.right : cardRect.left) - offsetX;
    const y = cardRect.top + cardRect.height / 2 - offsetY;
    positions.set(supplyPairKey(role, card.dataset.company), { x, y, h: cardRect.height });
  }
  let html = supplyMarkersHTML();
  const total = pairs.length;
  pairs.forEach((pair, index) => {
    const a = positions.get(supplyPairKey("receiver", pair.down));
    const b = positions.get(supplyPairKey("supplier", pair.up));
    if (!a || !b) return;
    const ay = pick.role === "receiver" ? a.y + bipFanOffset(index, total, a.h) : a.y;
    const by = pick.role === "supplier" ? b.y + bipFanOffset(index, total, b.h) : b.y;
    const dx = Math.max(36, (b.x - a.x) * 0.45);
    const d = `M${b.x.toFixed(1)},${by.toFixed(1)} C${(b.x - dx).toFixed(1)},${by.toFixed(1)} ${(a.x + dx).toFixed(1)},${ay.toFixed(1)} ${a.x.toFixed(1)},${ay.toFixed(1)}`;
    const factoryCount = getFactoryLinks(state, node.id, pair.down, pair.up).length;
    const flash = supplyFlash && supplyFlash.nid === node.id && supplyFlash.down === pair.down && supplyFlash.up === pair.up;
    const label = factoryCount ? `${factoryCount} ${factoryCount === 1 ? "route" : "routes"}` : "Set Routes";
    const cx = (a.x + b.x) / 2;
    const cy = (ay + by) / 2;
    html += `<g class="bip-edge ${flash ? "is-flash" : ""}" data-action="open-factories" data-nid="${node.id}" data-down="${pair.down}" data-up="${pair.up}" role="button" tabindex="0" aria-label="${esc(companyName(pair.up))} to ${esc(companyName(pair.down))}">
      <title>${esc(companyName(pair.up))} → ${esc(companyName(pair.down))} · ${factoryCount ? factoryCount + " plant routes" : "No plant routes"}</title>
      <path class="bip-edge-hit" d="${d}"/>
      <path class="bip-edge-line" d="${d}" marker-end="url(#bipArrow)"/>
      ${supplyEdgeLabelHTML(cx, cy, label)}
    </g>`;
  });
  svg.innerHTML = html;
  if (supplyFlash) {
    const flash = supplyFlash;
    setTimeout(() => { if (supplyFlash === flash) supplyFlash = null; }, 1100);
  }
}

function paintSupplyFocus() {
  const board = $("#supplyBoard");
  const node = state.nodes[ui.focusNode];
  if (!board || !node || !node.parentId) return;
  const pick = validSupplyPick();
  if (!pick) {
    board.classList.remove("has-focus");
    for (const card of $$("[data-bip-node]", board)) {
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
  const connected = new Set([supplyPairKey(pick.role, pick.cid)]);
  const rows = state.relationships[node.id] || {};
  if (pick.role === "receiver") {
    for (const up of rows[pick.cid] || []) connected.add(supplyPairKey("supplier", up));
  } else {
    for (const [down, ups] of Object.entries(rows)) {
      if (ups.includes(pick.cid)) connected.add(supplyPairKey("receiver", down));
    }
  }
  board.classList.add("has-focus");
  for (const card of $$("[data-bip-node]", board)) {
    const role = card.dataset.role;
    const cid = card.dataset.company;
    const isConnected = connected.has(supplyPairKey(role, cid));
    const isOpposite = role !== pick.role;
    card.classList.toggle("is-connected", isConnected);
    card.classList.toggle("is-target", isOpposite);
    card.classList.toggle("is-dim", !isOpposite && !isConnected);
    const cta = card.querySelector(".bip-node-cta");
    if (cta && isOpposite) {
      const down = role === "receiver" ? cid : pick.cid;
      const up = role === "supplier" ? cid : pick.cid;
      const linked = hasCompanyLink(state, node.id, down, up);
      cta.textContent = linked ? "Plant Routes" : "+ Link";
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

function refreshSupplySelection() {
  const node = state.nodes[ui.focusNode];
  if (!node || !node.parentId) {
    supplyPick = null;
    return;
  }
  validSupplyPick();
  const hint = $("#supplyHint");
  if (hint) hint.innerHTML = supplyHintHTML();
  const board = $("#supplyBoard");
  if (!board) return;
  for (const card of $$("[data-bip-node]", board)) {
    const selected = !!(supplyPick && supplyPick.role === card.dataset.role && supplyPick.cid === card.dataset.company);
    card.classList.toggle("is-selected", selected);
    const main = card.querySelector('[data-action="pick-supply-party"]');
    if (main) main.setAttribute("aria-pressed", String(selected));
  }
  paintSupplyFocus();
  scheduleSupplyDraw();
}

function pickSupplyParty(role, cid) {
  const node = state.nodes[ui.focusNode];
  if (!node || !node.parentId || !["receiver", "supplier"].includes(role)) return;
  const ids = role === "receiver" ? groupOf(state, node.parentId) : groupOf(state, node.id);
  if (!ids.includes(cid) || !state.companies[cid]) return;
  const pick = validSupplyPick();
  if (pick && pick.role === role && pick.cid === cid) {
    supplyPick = null;
    refreshSupplySelection();
    return;
  }
  if (pick && pick.role !== role) {
    const down = role === "receiver" ? cid : pick.cid;
    const up = role === "supplier" ? cid : pick.cid;
    if (hasCompanyLink(state, node.id, down, up)) {
      openFactoriesPanel(node.id, down, up);
      return;
    }
    createCompanyLink(node.id, down, up);
    return;
  }
  supplyPick = { role, cid };
  refreshSupplySelection();
}

function clearSupplyPick() {
  supplyPick = null;
  refreshSupplySelection();
}

function restoreSupplyScroll() {
  const board = $("#supplyBoard");
  if (!board) return;
  for (const role of ["receiver", "supplier"]) {
    const list = $(`.bip-column.${role} .bip-list`, board);
    if (list) list.scrollTop = supplyScroll[role] || 0;
  }
  board.scrollLeft = supplyScroll.board || 0;
}

function scheduleSupplyDraw() {
  if (supplyFrame) return;
  supplyFrame = requestAnimationFrame(() => {
    supplyFrame = 0;
    drawSupplyEdges();
    paintSupplyFocus();
  });
}

function observeSupplyBoard(board) {
  if (typeof ResizeObserver === "undefined") return;
  if (!supplyObserver) supplyObserver = new ResizeObserver(() => scheduleSupplyDraw());
  supplyObserver.disconnect();
  supplyObserver.observe(board);
  $$(".bip-list", board).forEach(el => supplyObserver.observe(el));
  $$("[data-bip-node]", board).forEach(el => supplyObserver.observe(el));
}

function setupSupplyGraph() {
  const board = $("#supplyBoard");
  if (!board) return;
  restoreSupplyScroll();
  board.addEventListener("keydown", event => {
    const edge = event.target.closest?.(".bip-edge");
    if (edge && (event.key === "Enter" || event.key === " ")) {
      event.preventDefault();
      edge.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
    }
  });
  board.addEventListener("click", event => {
    if (event.target.closest("[data-bip-node], .bip-edge, button, [data-action]")) return;
    if (!supplyPick) return;
    supplyPick = null;
    refreshSupplySelection();
  });
  for (const list of $$(".bip-list", board)) {
    const role = list.closest(".bip-column")?.dataset.role;
    list.addEventListener("scroll", () => {
      if (role) supplyScroll[role] = list.scrollTop;
      scheduleSupplyDraw();
    }, { passive: true });
  }
  board.addEventListener("scroll", () => {
    supplyScroll.board = board.scrollLeft;
  }, { passive: true });
  observeSupplyBoard(board);
  scheduleSupplyDraw();
}

function renderRelations(main) {
  const node = state.nodes[ui.focusNode];
  if (!node) {
    ui.view = "bom";
    return renderBOM(main);
  }
  if (ui.relationMode !== "edge" || !node.parentId) return renderNodeCompanies(main, node);

  const downIds = groupOf(state, node.parentId);
  const upIds = groupOf(state, node.id);
  const linkCount = countLinksForNode(node.id);
  const graphKey = node.id + "|" + node.parentId;
  if (supplyGraphKey !== graphKey) {
    supplyGraphKey = graphKey;
    supplyPick = null;
    supplyFlash = null;
    supplyScroll = { receiver: 0, supplier: 0, board: 0 };
  }
  validSupplyPick();

  main.innerHTML = `<div class="page relations-page">
    <div class="page-head">
      <div class="page-head-copy">
        <p class="eyebrow">SUPPLY LINKS</p>
        <h1>${esc(nodeName(node.id))}</h1>
      </div>
      <div class="stat-strip">
        <div class="stat"><b>${downIds.length}</b><span>Receivers</span></div>
        <div class="stat"><b>${upIds.length}</b><span>Suppliers</span></div>
        <div class="stat"><b>${linkCount}</b><span>Links</span></div>
        <div class="stat"><b>${countFactoryLinksForNode(node.id)}</b><span>Plant Routes</span></div>
      </div>
    </div>
    <div class="bip-card">
      <div class="bip-sticky">
        <div class="bip-toolbar">
          <div class="bip-toolbar-title">${icon("link", 14)}<strong>Company Supply Links</strong><span class="bip-toolbar-count">${linkCount}</span></div>
          <span class="bip-direction">${icon("arrowLeft", 13)}Supplier → Receiver</span>
        </div>
        <div class="bip-hint" id="supplyHint" role="status">${supplyHintHTML()}</div>
      </div>
      <div class="bip-board" id="supplyBoard">
        <div class="bip-columns">
          ${supplyColumnHTML(node.id, "receiver", downIds)}
          <div class="bip-gap" aria-hidden="true"></div>
          ${supplyColumnHTML(node.id, "supplier", upIds)}
        </div>
        <svg class="bip-edges" id="supplyEdges" role="group" aria-label="Supply links"></svg>
      </div>
    </div>
  </div>`;
  setupSupplyGraph();
}

function renderNodeCompanies(main, node) {
  supplyPick = null;
  supplyGraphKey = null;
  const ids = groupOf(state, node.id);
  main.innerHTML = `<div class="page relations-page">
    <div class="page-head">
      <div class="page-head-copy">
        <p class="eyebrow">NODE COMPANIES</p>
        <h1>${esc(nodeName(node.id))}</h1>
      </div>
      <div class="stat-strip">
        <div class="stat"><b>${ids.length}</b><span>Linked</span></div>
        <div class="stat"><b>${activeIds().length}</b><span>BOM Nodes</span></div>
      </div>
    </div>
    <div class="root-company-grid">
      ${ids.map(cid => `<button type="button" class="root-company-card" data-action="open-company" data-company="${cid}" data-node="${node.id}">
        <span class="party-avatar large">${esc(initials(companyName(cid)))}</span>
        <span class="root-company-copy">
          <strong>${esc(companyName(cid))}</strong>
          <small>${esc(companyLocation(cid))}</small>
        </span>
        ${complianceBadgeHTML(cid, { label: true, extraClass: "root-company-status" })}
        <span class="root-company-tag">Linked</span>
      </button>`).join("")}
      <button type="button" class="root-add-card" data-action="add-company" data-node="${node.id}" data-role="" data-label="Company">
        <span class="root-add-icon" aria-hidden="true">${icon("plus", 18)}</span>
        <strong>Add Company</strong>
      </button>
    </div>
  </div>`;
}

function countFactoryLinksForNode(nid) {
  const rows = state.factoryLinks[nid] || {};
  return values(rows).reduce((total, groups) => total + values(groups).reduce((sum, pairs) => sum + pairs.length, 0), 0);
}

window.addEventListener("resize", () => {
  if (ui.view === "relations" && $("#supplyBoard")) scheduleSupplyDraw();
});
