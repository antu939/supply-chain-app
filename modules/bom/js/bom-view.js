"use strict";

/* ---------------------------------------------------------------------------
   BOM 画布：节点、连线、缩放、平移、目录
--------------------------------------------------------------------------- */
function view() {
  return ui.bomView;
}
function applyView() {
  const world = $("#world");
  if (!world) return;
  const v = view();
  v.k = Math.max(0.2, Math.min(2, v.k));
  world.style.transform = `translate(${v.x}px,${v.y}px) scale(${v.k})`;
  const zoomValue = $("#zoomValue");
  if (zoomValue) zoomValue.textContent = Math.round(v.k * 100) + "%";
}
function zoomAt(factor, clientX, clientY) {
  const canvas = $("#canvas");
  if (!canvas) return;
  const rect = canvas.getBoundingClientRect();
  const v = view();
  const px = clientX ?? rect.left + rect.width / 2;
  const py = clientY ?? rect.top + rect.height / 2;
  const next = Math.max(0.2, Math.min(2, v.k * factor));
  const wx = (px - rect.left - v.x) / v.k;
  const wy = (py - rect.top - v.y) / v.k;
  v.x = px - rect.left - wx * next;
  v.y = py - rect.top - wy * next;
  v.k = next;
  applyView();
}
function fitView() {
  const canvas = $("#canvas");
  if (!canvas) return;
  const ids = activeIds();
  const v = view();
  if (!ids.length) {
    v.x = 40;
    v.y = 34;
    v.k = 1;
    applyView();
    return;
  }
  const nodes = ids.map(id => ({ id, ...nodePosition(id) }));
  const minX = Math.min(...nodes.map(n => n.x));
  const minY = Math.min(...nodes.map(n => n.y));
  const maxX = Math.max(...nodes.map(n => n.x + NODE_W));
  const maxY = Math.max(...nodes.map(n => n.y + NODE_H));
  const bounds = canvas.getBoundingClientRect();
  const width = Math.max(1, maxX - minX);
  const height = Math.max(1, maxY - minY);
  v.k = Math.max(0.28, Math.min(1.05, (bounds.width - 140) / width, (bounds.height - 130) / height));
  v.x = (bounds.width - width * v.k) / 2 - minX * v.k;
  v.y = (bounds.height - height * v.k) / 2 - minY * v.k;
  applyView();
}

function curve(a, b) {
  if (ui.bomOrientation === "vertical") {
    const sign = b.y >= a.y ? 1 : -1;
    const reach = Math.max(44, Math.abs(b.y - a.y) * 0.42);
    return `M${a.x},${a.y} C${a.x},${a.y + reach * sign} ${b.x},${b.y - reach * sign} ${b.x},${b.y}`;
  }
  const sign = b.x >= a.x ? 1 : -1;
  const reach = Math.max(56, Math.abs(b.x - a.x) * 0.45);
  return `M${a.x},${a.y} C${a.x + reach * sign},${a.y} ${b.x - reach * sign},${b.y} ${b.x},${b.y}`;
}
// 横向：父右 → 子左；纵向：父下 → 子上。端口与草稿线共用同一套方向规则。
function bomEndpoints(parent, child) {
  const p = nodePosition(parent.id), c = nodePosition(child.id);
  if (ui.bomOrientation === "vertical") {
    return [
      { x: p.x + NODE_W / 2, y: p.y + NODE_H },
      { x: c.x + NODE_W / 2, y: c.y }
    ];
  }
  return [
    { x: p.x + NODE_W, y: p.y + NODE_H / 2 },
    { x: c.x, y: c.y + NODE_H / 2 }
  ];
}
function drawEdges() {
  const layer = $("#edgePaths");
  if (!layer) return;
  const selected = ui.selected;
  layer.innerHTML = activeIds()
    .filter(id => state.nodes[id].parentId)
    .map(id => {
      const node = state.nodes[id];
      const parent = state.nodes[node.parentId];
      if (!parent) return "";
      const [a, b] = bomEndpoints(parent, node);
      const d = curve(a, b);
      const active = selected === id || selected === parent.id;
      const count = countLinksForNode(id);
      const cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2;
      return `<path class="wire ${active ? "active" : ""}" d="${d}" marker-end="url(#${active ? "arrowActive" : "arrow"})"/>
        <path class="wire-hit" d="${d}" data-action="open-line" data-node="${id}"/>
        <g class="wire-label ${count ? "has-links" : ""}" data-action="open-line" data-node="${id}" aria-label="Edit supply links">
          <rect x="${cx - 38}" y="${cy - 13}" width="76" height="26" rx="13"/>
          <text x="${cx}" y="${cy + 3.8}" text-anchor="middle">${count ? count + (count === 1 ? " link" : " links") : "+ Link"}</text>
        </g>`;
    })
    .join("");
}

function nodeHTML(id) {
  const node = state.nodes[id];
  const material = materialOf(state, id);
  const depth = depthOf(id);
  const selected = ui.selected === id;
  const position = nodePosition(id);
  return `<article class="bom-node ${selected ? "selected" : ""}" data-node="${id}" data-depth="${Math.min(depth, 4)}" style="left:${position.x}px;top:${position.y}px" tabindex="0" aria-label="Component: ${esc(material.name)}">
    <span class="node-accent" aria-hidden="true"></span>
    <header class="bom-node-head">
      <span class="node-kind">${node.parentId ? "Component" : "Finished Good"}</span>
      <span class="node-depth">${depth === 0 ? "ROOT" : "L" + depth}</span>
      <button type="button" class="node-edit" data-action="edit-node" data-node="${id}" title="Edit component" aria-label="Edit ${esc(material.name)}">${icon("edit", 13)}</button>
    </header>
    <h3 class="node-name" title="${esc(material.name)}">${esc(material.name)}</h3>
    <div class="node-meta">
      <span>${node.parentId ? `Qty <b>${fmt(node.qty)}</b>${node.unit ? " " + esc(node.unit) : ""}` : "Root"}</span>
      <span class="node-meta-sep" aria-hidden="true"></span>
      <span><b>${groupOf(state,id).length}</b> companies</span>
    </div>
    <footer class="node-foot">
      <button type="button" data-action="add-node" data-node="${id}">${icon("plus", 12)}Sub-item</button>
      <button type="button" data-action="open-relations" data-node="${id}">${icon("building",12)}Companies</button>
      ${node.parentId ? "" : `<button type="button" data-action="nav-risk" title="Market access assessment">${icon("shield", 12)}Access</button>`}
    </footer>
    ${node.parentId ? `<button type="button" class="port in" data-port="bom-in" data-node="${id}" aria-label="Parent port for ${esc(material.name)}" title="Drop link to reparent"></button>` : ""}
    <button type="button" class="port out" data-port="bom-out" data-node="${id}" aria-label="Child port for ${esc(material.name)}" title="Drag to add sub-component or reparent"></button>
  </article>`;
}

function childVisualOrder(a, b) {
  if (ui.bomOrientation === "vertical") {
    const pa = nodePosition(a.id), pb = nodePosition(b.id);
    return pa.x - pb.x || a.y - b.y || nodeName(a.id).localeCompare(nodeName(b.id), "en");
  }
  return a.y - b.y || nodeName(a.id).localeCompare(nodeName(b.id), "en");
}

function outlineRowsHTML() {
  if (!doc()) return `<p class="outline-empty">No components</p>`;
  const rows = [];
  const visit = (id, depth) => {
    const node = state.nodes[id];
    const active = (ui.view === "relations" ? ui.focusNode : ui.selected) === id;
    rows.push(`<div class="outline-row" style="--depth:${Math.min(depth, 8)}">
      <button type="button" class="outline-item ${active ? "active" : ""}" data-action="select-node" data-node="${id}" title="${esc(pathOf(id))}">
        <span class="outline-branch" aria-hidden="true"></span>
        <span class="outline-name">${esc(nodeName(id))}</span>
        ${node.parentId ? `<span class="outline-qty">×${fmt(node.qty)}</span>` : `<span class="outline-qty root">Root</span>`}
      </button>
    </div>`);
    childrenOf(state, id)
      .slice()
      .sort(childVisualOrder)
      .forEach(child => visit(child.id, depth + 1));
  };
  visit(doc().rootNodeId, 0);
  return `<div class="outline-list">${rows.join("")}</div>`;
}

function renderBOM(main) {
  const d = doc();
  if (!d) {
    main.innerHTML = `<div class="canvas canvas-blank">
      <div class="empty-stage">
        <div class="empty-graph" aria-hidden="true">
          <span class="eg-node root">Product</span>
          <span class="eg-wire"></span>
          <span class="eg-node">Part</span>
          <span class="eg-wire short"></span>
          <span class="eg-node dim">Part</span>
        </div>
        <p class="eyebrow">PRODUCT STRUCTURE</p>
        <h2>New BOM</h2>
        <button type="button" class="btn primary" data-action="new-document">${icon("plus", 14)}New BOM</button>
      </div>
    </div>`;
    return;
  }
  if (ui.bomOrientation === "vertical") ensureVerticalLayout(d);
  main.innerHTML = `<div class="canvas ${ui.bomOrientation === "vertical" ? "is-vertical" : "is-horizontal"}" id="canvas" aria-label="BOM Canvas">
    <div class="world" id="world">
      <svg class="wire-layer" id="wires" aria-hidden="true">
        <defs>
          <marker id="arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto" markerUnits="userSpaceOnUse"><path d="M1 1 L7 4 L1 7" fill="none" stroke="#98a29a" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></marker>
          <marker id="arrowActive" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto" markerUnits="userSpaceOnUse"><path d="M1 1 L7 4 L1 7" fill="none" stroke="var(--accent)" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></marker>
        </defs>
        <g id="edgePaths"></g>
        <path id="draftWire" class="draft-wire hidden"/>
      </svg>
      <div id="nodes">${activeIds().map(nodeHTML).join("")}</div>
    </div>
    ${ui.outline ? `<div class="outline-panel" id="outlinePanel">
      <div class="outline-head"><span>Structure</span><button type="button" class="icon-btn" data-action="toggle-outline" aria-label="Close outline">${icon("close", 14)}</button></div>
      ${outlineRowsHTML()}
    </div>` : ""}
    <div class="zoom-controls" role="group" aria-label="Zoom">
      <button type="button" data-action="zoom-out" aria-label="Zoom out">−</button>
      <span class="zoom-value" id="zoomValue">100%</span>
      <button type="button" data-action="zoom-in" aria-label="Zoom in">+</button>
      <span class="zoom-sep" aria-hidden="true"></span>
      <button type="button" data-action="fit" aria-label="Fit view" title="Fit view">${icon("fit", 14)}</button>
    </div>
  </div>`;
  drawEdges();
  applyView();
}

function syncNodeSelection() {
  $$(".bom-node").forEach(el => el.classList.toggle("selected", el.dataset.node === ui.selected));
  $$(".outline-item").forEach(el => el.classList.toggle("active", el.dataset.node === ui.selected));
  drawEdges();
  renderStatus();
}

// 纵向布局：父在上、子在下；每个子树按自己的宽度占位，父节点居中于子节点，
// 因此横向长方形节点不会因为简单交换坐标而重叠。
function verticalLayoutPositions(s, diagram) {
  const GAP_X = 38, GAP_Y = 90, PAD_X = 52, PAD_Y = 56;
  const info = new Map();
  const measure = nid => {
    const kids = childrenOf(s, nid)
      .slice()
      .sort((a, b) => a.y - b.y || nodeName(a.id).localeCompare(nodeName(b.id), "zh-CN"));
    if (!kids.length) {
      const item = { kids, children: [], width: NODE_W };
      info.set(nid, item);
      return item;
    }
    const children = kids.map(kid => measure(kid.id));
    const total = children.reduce((sum, child) => sum + child.width, 0) + GAP_X * (kids.length - 1);
    const item = { kids, children, width: Math.max(NODE_W, total) };
    info.set(nid, item);
    return item;
  };
  const positions = new Map();
  const place = (nid, left, depth) => {
    const item = info.get(nid);
    positions.set(nid, {
      x: Math.round(left + (item.width - NODE_W) / 2),
      y: PAD_Y + depth * (NODE_H + GAP_Y)
    });
    if (!item.kids.length) return;
    const total = item.children.reduce((sum, child) => sum + child.width, 0) + GAP_X * (item.children.length - 1);
    let cursor = left + (item.width - total) / 2;
    item.kids.forEach((kid, index) => {
      place(kid.id, cursor, depth + 1);
      cursor += item.children[index].width + GAP_X;
    });
  };
  measure(diagram.rootNodeId);
  place(diagram.rootNodeId, PAD_X, 0);
  return positions;
}

function ensureVerticalLayout(diagram = doc(), force = false) {
  if (!diagram) return false;
  const ids = walk(state, diagram.rootNodeId);
  if (!force && ids.every(id => ui.bomVerticalPositions[id])) return false;
  const positions = verticalLayoutPositions(state, diagram);
  for (const [id, position] of positions) ui.bomVerticalPositions[id] = position;
  return true;
}

function layoutBOM() {
  if (!doc()) return;
  if (ui.bomOrientation === "vertical") {
    ensureVerticalLayout(doc(), true);
    render();
    requestAnimationFrame(fitView);
    notify("Vertical layout applied");
    return;
  }
  if (!change(() => {
    let leaf = 0;
    const place = (id, depth) => {
      const kids = childrenOf(state, id)
        .slice()
        .sort((a, b) => a.y - b.y || nodeName(a.id).localeCompare(nodeName(b.id), "zh-CN"));
      let y;
      if (!kids.length) {
        y = leaf * 168 + 64;
        leaf++;
      } else {
        const ys = kids.map(kid => place(kid.id, depth + 1));
        y = (ys[0] + ys[ys.length - 1]) / 2;
      }
      state.nodes[id].x = 52 + depth * 318;
      state.nodes[id].y = y;
      return y;
    };
    place(doc().rootNodeId, 0);
  })) return;
  fitView();
}

function ensureNodeVisible(id) {
  if (!doc() || !$("#canvas")) return;
  const canvas = $("#canvas");
  const node = state.nodes[id];
  if (!node) return;
  const position = nodePosition(id);
  const rect = canvas.getBoundingClientRect();
  const v = view();
  const x = position.x * v.k + v.x;
  const y = position.y * v.k + v.y;
  if (x < 16 || y < 16 || x + NODE_W * v.k > rect.width - 16 || y + NODE_H * v.k > rect.height - 16) {
    v.x = rect.width / 2 - (position.x + NODE_W / 2) * v.k;
    v.y = rect.height / 2 - (position.y + NODE_H / 2) * v.k;
    applyView();
  }
}

function worldPoint(event) {
  const rect = $("#canvas").getBoundingClientRect();
  const v = view();
  return { x: (event.clientX - rect.left - v.x) / v.k, y: (event.clientY - rect.top - v.y) / v.k };
}
