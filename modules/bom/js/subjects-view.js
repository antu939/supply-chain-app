"use strict";

/* ---------------------------------------------------------------------------
   公司总览：搜索 + 周期表式卡片网格
--------------------------------------------------------------------------- */
const SUBJECT_FILTERS = [
  { key: "all", label: "All" },
  { key: "supplier", label: "Supplier" },
  { key: "receiver", label: "Receiver" },
  { key: "both", label: "Both" },
  { key: "none", label: "Unlinked" }
];

function companySearchText(cid) {
  const c = state.companies[cid];
  if (!c) return "";
  const factories = factoriesOf(state, cid)
    .map(f => [f.name, f.location, f.contact, f.note, ...Object.keys(f.extraFields || {}), ...Object.values(f.extraFields || {})].join(" "))
    .join(" ");
  const compliance = complianceOf(cid);
  const complianceText = [complianceMetaOf(cid).label, compliance.reason || ""].join(" ");
  return [c.name, c.location, c.contact, c.note, ...Object.keys(c.extraFields || {}), ...Object.values(c.extraFields || {}), factories, complianceText]
    .join(" ")
    .toLocaleLowerCase();
}

function filteredCompanies() {
  const tokens = ui.subjectQuery.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  let list = values(state.companies).map(c => c.id);
  if (ui.subjectFilter !== "all") list = list.filter(cid => roleOf(cid) === ui.subjectFilter);
  if (COMPLIANCE_STATUS_KEYS.includes(ui.complianceFilter)) list = list.filter(cid => complianceOf(cid).status === ui.complianceFilter);
  if (tokens.length) list = list.filter(cid => tokens.every(token => companySearchText(cid).includes(token)));
  const stat = cid => companyStats(cid);
  const byName = (a, b) => state.companies[a].name.localeCompare(state.companies[b].name, "zh-CN");
  const sorters = {
    name: byName,
    links: (a, b) => stat(b).links - stat(a).links || byName(a, b),
    factories: (a, b) => stat(b).factories - stat(a).factories || byName(a, b),
    nodes: (a, b) => stat(b).nodes - stat(a).nodes || byName(a, b),
    compliance: (a, b) => {
      const ra = complianceMetaOf(a).rank, rb = complianceMetaOf(b).rank;
      return ra - rb || byName(a, b);
    }
  };
  return list.sort(sorters[ui.subjectSort] || sorters.name);
}

function companyCodeMap() {
  const sorted = values(state.companies).slice().sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
  const map = new Map();
  sorted.forEach((c, index) => map.set(c.id, "C-" + String(index + 1).padStart(2, "0")));
  return map;
}

function companyTileHTML(cid, codeMap) {
  const c = state.companies[cid];
  const role = roleOf(cid);
  const stat = companyStats(cid);
  const roleMeta = ROLE_META[role];
  const nodeCount=companyNodes(cid).length;
  const ownerPath = nodeCount ? `${nodeCount} BOM ${nodeCount === 1 ? "node" : "nodes"}` : "Unused";
  const compliance = complianceOf(cid);
  const meta = complianceMetaOf(cid);
  const tracePick = ui.subjectTracePick;
  return `<button type="button" class="company-tile role-${role} ${tracePick ? "is-trace-pick" : ""}" data-action="${tracePick ? "pick-subject-trace" : "open-company"}" data-company="${cid}" title="${tracePick ? `Trace downstream from ${esc(c.name)}` : `${esc(c.name)} · ${esc(c.location || "—")} · ${esc(meta.label)}`}">
    <span class="tile-top">
      <span class="tile-code">${codeMap.get(cid) || "C-—"}</span>
      <span class="tile-role ${role}"><span class="role-dot ${role}" aria-hidden="true"></span>${roleMeta.label}</span>
    </span>
    <strong class="tile-name">${highlight(c.name, ui.subjectQuery)}</strong>
    <span class="tile-location">${icon("building", 12)}<span class="tile-loc-text">${highlight(c.location || "—", ui.subjectQuery)}</span><span class="tile-comp comp-status-${meta.key}" title="Compliance: ${esc(meta.label)}"><i class="comp-status-dot" aria-hidden="true"></i>${esc(meta.label)}</span></span>
    <span class="tile-owner" title="${esc(ownerPath)}">${esc(ownerPath)}</span>
    <span class="tile-foot">
      <span><b>${stat.factories}</b> Plants</span>
      <span><b>${stat.upstream}</b> Up</span>
      <span><b>${stat.downstream}</b> Down</span>
      ${tracePick ? `<span class="tile-trace-hint">Trace</span>` : ""}
    </span>
  </button>`;
}

/* ---------------------------------------------------------------------------
   公司总览：下游追溯（只保留起点及其可达下游，重排为 DAG 后画细线）
--------------------------------------------------------------------------- */
const SUBJECT_TRACE_NODE_W = 190;
const SUBJECT_TRACE_NODE_H = 58;
const SUBJECT_TRACE_GAP_X = 64;
const SUBJECT_TRACE_GAP_Y = 22;
const SUBJECT_TRACE_PAD = 20;

function subjectTraceRootCompanyIds() {
  const ids = new Set();
  for (const diagram of state.diagrams) {
    for (const cid of groupOf(state, diagram.rootNodeId)) ids.add(cid);
  }
  return ids;
}

function subjectTraceLayout(graph) {
  const nodeSet = new Set(graph.nodes);
  const index = new Map(graph.nodes.map((cid, i) => [cid, i]));
  const outgoing = new Map(graph.nodes.map(cid => [cid, []]));
  const incoming = new Map(graph.nodes.map(cid => [cid, []]));
  for (const [up, down] of graph.edges) {
    if (up === down || !nodeSet.has(up) || !nodeSet.has(down)) continue;
    outgoing.get(up).push(down);
    incoming.get(down).push(up);
  }
  const indegree = new Map(graph.nodes.map(cid => [cid, 0]));
  for (const list of outgoing.values()) for (const cid of list) indegree.set(cid, indegree.get(cid) + 1);
  const queue = graph.nodes.filter(cid => indegree.get(cid) === 0);
  const layer = new Map(graph.nodes.map(cid => [cid, 0]));
  const processed = new Set();
  while (queue.length) {
    const up = queue.shift();
    processed.add(up);
    for (const down of outgoing.get(up)) {
      layer.set(down, Math.max(layer.get(down), layer.get(up) + 1));
      indegree.set(down, indegree.get(down) - 1);
      if (indegree.get(down) === 0) queue.push(down);
    }
  }
  // 供货关系异常成环时按最短下游距离兜底分层，避免节点重叠或死循环。
  if (processed.size < graph.nodes.length) {
    const depth = new Map([[graph.root, 0]]);
    const todo = [graph.root];
    while (todo.length) {
      const up = todo.shift();
      for (const down of outgoing.get(up) || []) {
        if (depth.has(down)) continue;
        depth.set(down, depth.get(up) + 1);
        todo.push(down);
      }
    }
    for (const cid of graph.nodes) if (!processed.has(cid)) layer.set(cid, depth.get(cid) ?? 1);
  }
  let maxLayer = 0;
  for (const value of layer.values()) maxLayer = Math.max(maxLayer, value);
  const layers = Array.from({ length: maxLayer + 1 }, () => []);
  for (const cid of graph.nodes) layers[layer.get(cid)].push(cid);
  // 两遍重心排序，减少交叉，同时保持同一层的紧凑间距。
  for (let l = 1; l < layers.length; l++) {
    const prev = new Map(layers[l - 1].map((cid, i) => [cid, i]));
    const average = cid => {
      const positions = incoming.get(cid).filter(parent => prev.has(parent)).map(parent => prev.get(parent));
      return positions.length ? positions.reduce((sum, value) => sum + value, 0) / positions.length : Infinity;
    };
    layers[l].sort((a, b) => average(a) - average(b) || index.get(a) - index.get(b));
  }
  for (let l = layers.length - 2; l >= 0; l--) {
    const next = new Map(layers[l + 1].map((cid, i) => [cid, i]));
    const average = cid => {
      const positions = outgoing.get(cid).filter(child => next.has(child)).map(child => next.get(child));
      return positions.length ? positions.reduce((sum, value) => sum + value, 0) / positions.length : Infinity;
    };
    layers[l].sort((a, b) => average(a) - average(b) || index.get(a) - index.get(b));
  }
  const layerHeights = layers.map(list => Math.max(SUBJECT_TRACE_NODE_H, list.length * SUBJECT_TRACE_NODE_H + Math.max(0, list.length - 1) * SUBJECT_TRACE_GAP_Y));
  const height = Math.max(SUBJECT_TRACE_NODE_H, ...layerHeights) + SUBJECT_TRACE_PAD * 2;
  const width = layers.length * (SUBJECT_TRACE_NODE_W + SUBJECT_TRACE_GAP_X) - SUBJECT_TRACE_GAP_X + SUBJECT_TRACE_PAD * 2;
  const positions = new Map();
  layers.forEach((list, layerIndex) => {
    const used = list.length * SUBJECT_TRACE_NODE_H + Math.max(0, list.length - 1) * SUBJECT_TRACE_GAP_Y;
    const top = SUBJECT_TRACE_PAD + (height - SUBJECT_TRACE_PAD * 2 - used) / 2;
    list.forEach((cid, rowIndex) => {
      positions.set(cid, {
        x: SUBJECT_TRACE_PAD + layerIndex * (SUBJECT_TRACE_NODE_W + SUBJECT_TRACE_GAP_X),
        y: top + rowIndex * (SUBJECT_TRACE_NODE_H + SUBJECT_TRACE_GAP_Y)
      });
    });
  });
  return { positions, layers, width, height };
}

function subjectTraceNodeHTML(cid, graph, layout, codeMap, rootCompanyIds) {
  const meta = complianceMetaOf(cid);
  const position = layout.positions.get(cid);
  const isStart = cid === graph.root;
  const isRoot = rootCompanyIds.has(cid);
  const downstream = graph.adjacency.get(cid)?.size || 0;
  return `<button type="button" class="trace-node comp-status-${meta.key} ${isStart ? "is-start" : ""} ${isRoot ? "is-root" : ""}" style="left:${position.x}px;top:${position.y}px" data-action="open-company" data-company="${cid}" title="${esc(companyName(cid))} · ${esc(meta.label)} · ${downstream ? downstream + " downstream" : "No downstream"}" aria-label="${esc(companyName(cid))}">
    <span class="trace-node-top"><span class="trace-node-code">${codeMap.get(cid) || "C-—"}</span><span class="trace-node-flags">${isStart ? '<span class="trace-flag start">START</span>' : ""}${isRoot ? '<span class="trace-flag root">ROOT</span>' : ""}</span></span>
    <strong class="trace-node-name">${esc(companyName(cid))}</strong>
    <span class="trace-node-foot"><span class="comp-status-dot" aria-hidden="true"></span><span>${esc(meta.label)}</span><span class="trace-node-out">${downstream ? downstream + " down" : "End"}</span></span>
  </button>`;
}

function subjectTraceEdgeHTML(up, down, layout) {
  const a = layout.positions.get(up), b = layout.positions.get(down);
  if (!a || !b) return "";
  const x1 = a.x + SUBJECT_TRACE_NODE_W, y1 = a.y + SUBJECT_TRACE_NODE_H / 2;
  const x2 = b.x, y2 = b.y + SUBJECT_TRACE_NODE_H / 2;
  const bend = Math.max(24, Math.abs(x2 - x1) * 0.45);
  const d = `M${x1.toFixed(1)},${y1.toFixed(1)} C${(x1 + bend).toFixed(1)},${y1.toFixed(1)} ${(x2 - bend).toFixed(1)},${y2.toFixed(1)} ${x2.toFixed(1)},${y2.toFixed(1)}`;
  return `<path class="subject-trace-edge" d="${d}" marker-end="url(#subjectTraceArrow)"><title>${esc(companyName(up))} → ${esc(companyName(down))}</title></path>`;
}

function subjectTraceHTML(rootId) {
  const graph = companyDownstreamGraph(state, rootId);
  if (!graph.nodes.length) return "";
  const layout = subjectTraceLayout(graph);
  const codeMap = companyCodeMap();
  const rootCompanyIds = subjectTraceRootCompanyIds();
  const downstreamCount = graph.nodes.length - 1;
  const scope = state.diagrams.length === 0 ? "All" : state.diagrams.length > 1 ? `${state.diagrams.length} BOMs` : "Current BOM";
  const edges = graph.edges.map(([up, down]) => subjectTraceEdgeHTML(up, down, layout)).join("");
  return `<div class="subject-trace" aria-label="Downstream Trace">
    <div class="subject-trace-bar">
      <div class="subject-trace-title">
        <span class="subject-trace-icon">${icon("link", 15)}</span>
        <div><strong>Downstream Trace</strong><small>${esc(companyName(rootId))} · ${downstreamCount} downstream · ${layout.layers.length} tiers · ${scope}</small></div>
      </div>
      <div class="subject-trace-actions">
        <button type="button" class="btn small" data-action="subject-trace-reset">${icon("search", 12)}Re-select</button>
        <button type="button" class="btn ghost small" data-action="subject-trace-exit">Exit Trace</button>
      </div>
    </div>
    <div class="subject-trace-board" tabindex="0" aria-label="Downstream trace graph">
      <div class="subject-trace-stage" style="width:${layout.width}px;height:${layout.height}px">
        <svg class="subject-trace-edges" width="${layout.width}" height="${layout.height}" viewBox="0 0 ${layout.width} ${layout.height}" aria-hidden="true">
          <defs><marker id="subjectTraceArrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto" markerUnits="userSpaceOnUse"><path d="M1 1 L7 4 L1 7" fill="none" stroke="#a9b8ae" stroke-width="1.1" stroke-linecap="round" stroke-linejoin="round"/></marker></defs>
          ${edges}
        </svg>
        <div class="subject-trace-nodes">${graph.nodes.map(cid => subjectTraceNodeHTML(cid, graph, layout, codeMap, rootCompanyIds)).join("")}</div>
      </div>
    </div>
    ${downstreamCount ? "" : `<p class="subject-trace-note">No downstream companies</p>`}
  </div>`;
}

function subjectResultsHTML() {
  if (ui.subjectTraceRoot) {
    if (!state.companies[ui.subjectTraceRoot]) {
      ui.subjectTraceRoot = null;
      ui.subjectTracePick = false;
    } else {
      return subjectTraceHTML(ui.subjectTraceRoot);
    }
  }
  const all = values(state.companies);
  const filtered = filteredCompanies();
  const codeMap = companyCodeMap();
  const roleCounts = { all: all.length, supplier: 0, receiver: 0, both: 0, none: 0 };
  for (const c of all) roleCounts[roleOf(c.id)]++;
  const query = ui.subjectQuery.trim();
  const duplicates=duplicateCompanyGroups(state);

  const chips = SUBJECT_FILTERS.map(f => `<button type="button" class="filter-chip ${ui.subjectFilter === f.key ? "active" : ""}" data-action="subject-filter" data-filter="${f.key}" aria-pressed="${ui.subjectFilter === f.key}">${f.label}<span class="chip-count">${roleCounts[f.key]}</span></button>`).join("");
  const complianceStatsValue = complianceStats();
  const complianceChips = [["all", "All", complianceStatsValue.total, null], ...COMPLIANCE_STATUSES.map(item => [item.key, item.label, complianceStatsValue[item.key], item.key])]
    .map(([key, label, count, statusKey]) => `<button type="button" class="cf-chip ${ui.complianceFilter === key ? "active" : ""} ${statusKey ? "comp-status-" + statusKey : ""}" data-action="subject-compliance" data-filter="${key}" aria-pressed="${ui.complianceFilter === key}">${statusKey ? '<i class="comp-status-dot" aria-hidden="true"></i>' : ""}${label}<span class="chip-count">${count}</span></button>`).join("");

  let body;
  if (!all.length) {
    body = `<div class="no-results first-run">
      <span class="no-results-icon">${icon("building", 26)}</span>
      <h3>No Companies</h3>
      <div style="display:flex;gap:10px;justify-content:center;flex-wrap:wrap">
        <button type="button" class="btn primary" data-action="new-global-company">${icon("plus", 14)}New Company</button>
        <button type="button" class="btn" data-action="nav-bom">${icon("grid", 14)}BOM Tree</button>
      </div>
    </div>`;
  } else if (!filtered.length) {
    body = `<div class="no-results">
      <span class="no-results-icon">${icon("search", 24)}</span>
      <h3>No Matching Companies</h3>
      <button type="button" class="btn" data-action="clear-subject-search">Clear Filters</button>
    </div>`;
  } else {
    body = `<div class="company-grid">${filtered.map(cid => companyTileHTML(cid, codeMap)).join("")}</div>`;
  }

  return `${duplicates.length?`<div class="duplicate-banner" role="alert"><div><strong>${icon("warn",16)} ${duplicates.length} duplicate company ${duplicates.length === 1 ? "group" : "groups"}</strong></div><div class="duplicate-actions">${duplicates.map(group=>`<button type="button" class="btn small" data-action="review-duplicate-company" data-company="${esc(group[0].id)}">Review "${esc(group[0].name)}" (${group.length})</button>`).join("")}</div></div>`:""}
    ${ui.subjectTracePick ? `<div class="subject-trace-pick" role="status">${icon("link", 14)}<span><strong>Trace Mode</strong> · Select starting company</span><button type="button" class="text-btn" data-action="subject-trace-toggle">Cancel</button></div>` : ""}
    <div class="results-toolbar">
      <div class="filter-chips">${chips}</div>
      <div class="results-tools">
        <button type="button" class="cf-chip trace-toggle ${ui.subjectTracePick ? "active" : ""}" data-action="subject-trace-toggle" aria-pressed="${ui.subjectTracePick}" title="Trace downstream supply chain">${icon("link", 12)}${ui.subjectTracePick ? "Cancel Trace" : "Trace Downstream"}</button>
        <div class="compliance-filter" role="group" aria-label="Filter by compliance">
          <span class="cf-label">${icon("shield", 12)}Compliance</span>
          ${complianceChips}
        </div>
        <label class="sort-control"><span>Sort</span><select id="subjectSort" aria-label="Sort companies">
          <option value="name" ${ui.subjectSort === "name" ? "selected" : ""}>Name</option>
          <option value="links" ${ui.subjectSort === "links" ? "selected" : ""}>Supply Links</option>
          <option value="factories" ${ui.subjectSort === "factories" ? "selected" : ""}>Plants</option>
          <option value="nodes" ${ui.subjectSort === "nodes" ? "selected" : ""}>BOM Nodes</option>
          <option value="compliance" ${ui.subjectSort === "compliance" ? "selected" : ""}>Compliance</option>
        </select></label>
      </div>
    </div>
    <div class="results-line">
      <span>${query ? `<b>${filtered.length}</b> matched` : `<b>${filtered.length}</b> companies`}${ui.subjectFilter !== "all" ? ` · ${ROLE_META[ui.subjectFilter].label}` : ""}${COMPLIANCE_STATUS_KEYS.includes(ui.complianceFilter) ? ` · ${complianceStatus(ui.complianceFilter).label}` : ""}</span>
      <span class="legend"><i class="role-dot supplier"></i>Supplier<i class="role-dot receiver"></i>Receiver<i class="role-dot both"></i>Both<i class="role-dot none"></i>Unlinked<i class="comp-status-dot comp-status-unverified"></i>Unverified</span>
    </div>
    ${body}`;
}

function renderSubjectResults() {
  const container = $("#subjectResults");
  if (!container) return;
  container.innerHTML = subjectResultsHTML();
  const searchBand = $(".subjects-page .search-band");
  if (searchBand) searchBand.classList.toggle("hidden", !!ui.subjectTraceRoot);
}

function renderSubjects(main) {
  const companyList = values(state.companies);
  const factories = values(state.factories).length;
  const unlinked = companyList.filter(c => roleOf(c.id) === "none").length;
  const compliance = complianceStats();
  main.innerHTML = `<div class="page subjects-page">
    <div class="page-head subjects-head">
      <div class="page-head-copy">
        <p class="eyebrow">ENTITY DIRECTORY</p>
        <h1>Companies</h1>
      </div>
      <div class="stat-strip">
        <div class="stat"><b>${companyList.length}</b><span>Companies</span></div>
        <div class="stat"><b>${factories}</b><span>Plants</span></div>
        <div class="stat"><b>${countCompanyLinks(state)}</b><span>Links</span></div>
        <div class="stat"><b>${unlinked}</b><span>Unlinked</span></div>
        <div class="stat ${compliance.severe ? "stat-severe" : ""}"><b>${compliance.severe}</b><span>Severe</span></div>
        <div class="stat"><b>${compliance.unverified}</b><span>Unverified</span></div>
      </div>
    </div>
    <div class="search-band ${ui.subjectTraceRoot ? "hidden" : ""}">
      <div class="search-field">
        ${icon("search", 19)}
        <input id="subjectSearch" type="search" placeholder="Search companies, locations, contacts, plants…" value="${esc(ui.subjectQuery)}" autocomplete="off" spellcheck="false" aria-label="Search companies">
        <kbd title="Press / to search">/</kbd>
      </div>
    </div>
    <div id="subjectResults">${subjectResultsHTML()}</div>
  </div>`;
}
