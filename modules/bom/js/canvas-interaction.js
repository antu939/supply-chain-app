"use strict";

/* ---------------------------------------------------------------------------
   画布手势：拖动节点、平移、缩放、端口连线
--------------------------------------------------------------------------- */
let gesture = null;
let suppressPortClick = false;

function portData(port) {
  return { type: port.dataset.port, node: port.dataset.node || null };
}
function portPoint(data) {
  const position = nodePosition(data.node);
  if (!position) return null;
  if (ui.bomOrientation === "vertical") {
    return {
      x: position.x + NODE_W / 2,
      y: data.type === "bom-out" ? position.y + NODE_H : position.y
    };
  }
  return {
    x: data.type === "bom-out" ? position.x + NODE_W : position.x,
    y: position.y + NODE_H / 2
  };
}
function drawDraft(source, to) {
  const point = portPoint(source);
  const wire = $("#draftWire");
  if (!point || !wire) return;
  wire.classList.remove("hidden");
  wire.setAttribute("d", source.type === "bom-out" ? curve(point, to) : curve(to, point));
}
function clearArmed() {
  ui.armed = null;
  $$(".port.armed").forEach(p => p.classList.remove("armed"));
  $("#draftWire")?.classList.add("hidden");
}

function reparentNode(nid, parent) {
  if (!state.nodes[nid] || !state.nodes[parent]) return;
  if (state.nodes[nid].parentId === parent) {
    notify("Already linked as parent and child");
    return;
  }
  try {
    reparent(clone(state), nid, parent);
  } catch (error) {
    notify(error.message);
    return;
  }
  const hasLinks = Object.keys(state.relationships[nid] || {}).length > 0;
  const apply = () => {
    if (!change(() => {
      reparent(state, nid, parent);
      ui.selected = nid;
    })) return;
    notify("BOM hierarchy updated");
  };
  if (hasLinks) {
    confirmAction(
      "Reparent Component",
      `Changing parent will clear supply links and plant routes for "${nodeName(nid)}".`,
      apply,
      "Reparent"
    );
  } else {
    apply();
  }
}

function connectPorts(a, b) {
  clearArmed();
  const types = [a.type, b.type];
  if (types.includes("bom-out") && types.includes("bom-in")) {
    const parent = a.type === "bom-out" ? a.node : b.node;
    const child = a.type === "bom-in" ? a.node : b.node;
    if (parent === child) {
      notify("Cannot connect a node to itself");
      return;
    }
    reparentNode(child, parent);
    return;
  }
  notify("Connect an output port to an input port");
}

function handlePortClick(port) {
  if (suppressPortClick) {
    suppressPortClick = false;
    return;
  }
  const data = portData(port);
  if (ui.armed) {
    if (ui.armed.type === data.type && ui.armed.node === data.node) {
      clearArmed();
      return;
    }
    connectPorts(ui.armed, data);
  } else {
    ui.armed = data;
    port.classList.add("armed");
    notify("Select a target port to connect");
  }
}

document.addEventListener("pointerdown", event => {
  if (event.button !== 0 && event.button !== 1) return;
  const canvas = event.target.closest("#canvas");
  if (!canvas) return;

  const port = event.target.closest("[data-port]");
  if (port && event.button === 0) {
    gesture = { kind: "port", source: portData(port), x: event.clientX, y: event.clientY, moved: false };
    return;
  }

  const nodeEl = event.target.closest(".bom-node");
  if (nodeEl && event.button === 0 && !spaceDown && !event.target.closest("button,a,input,textarea,select")) {
    const id = nodeEl.dataset.node;
    const node = state.nodes[id];
    if (!node) return;
    const position = nodePosition(id);
    if (ui.selected !== id) {
      ui.selected = id;
      syncNodeSelection();
      renderSubbar();
    }
    gesture = {
      kind: "node",
      id,
      ox: event.clientX,
      oy: event.clientY,
      startX: position.x,
      startY: position.y,
      before: JSON.stringify(state),
      moved: false
    };
    nodeEl.classList.add("dragging");
    return;
  }

  if (event.button === 1 || spaceDown || (event.button === 0 && !event.target.closest("[data-action],.outline-panel,.zoom-controls"))) {
    const v = view();
    gesture = { kind: "pan", x: event.clientX, y: event.clientY, startX: v.x, startY: v.y, moved: false };
    canvas.classList.add("panning");
    if (event.button === 1) event.preventDefault();
  }
});

document.addEventListener("pointermove", event => {
  if (!gesture) {
    if (ui.armed && event.target.closest("#canvas")) drawDraft(ui.armed, worldPoint(event));
    return;
  }
  const g = gesture;
  const baseX = g.kind === "node" ? g.ox : g.x;
  const baseY = g.kind === "node" ? g.oy : g.y;
  const dx = event.clientX - baseX;
  const dy = event.clientY - baseY;
  if (Math.abs(dx) + Math.abs(dy) > 4) g.moved = true;
  if (!g.moved) return;

  if (g.kind === "pan") {
    const v = view();
    v.x = g.startX + dx;
    v.y = g.startY + dy;
    applyView();
    return;
  }
  if (g.kind === "node") {
    const v = view();
    const x = g.startX + (event.clientX - g.ox) / v.k;
    const y = g.startY + (event.clientY - g.oy) / v.k;
    setNodePosition(g.id, x, y);
    const el = $(`.bom-node[data-node="${g.id}"]`);
    if (el) {
      el.style.left = x + "px";
      el.style.top = y + "px";
    }
    drawEdges();
    return;
  }
  if (g.kind === "port") {
    drawDraft(g.source, worldPoint(event));
  }
});

document.addEventListener("pointerup", event => {
  if (!gesture) return;
  const g = gesture;
  gesture = null;
  $("#canvas")?.classList.remove("panning");
  $(`.bom-node[data-node="${g.id}"]`)?.classList.remove("dragging");

  if (g.kind === "node" && g.moved) {
    if (ui.bomOrientation === "horizontal") {
      if (!persist()) {
        state = JSON.parse(g.before);
        sanitizeUI();
        render();
        return;
      }
      pushHistory(g.before);
      renderHeader();
    }
    return;
  }
  if (g.kind === "port" && g.moved) {
    suppressPortClick = true;
    setTimeout(() => { suppressPortClick = false; }, 80);
    $("#draftWire")?.classList.add("hidden");
    const el = document.elementFromPoint(event.clientX, event.clientY);
    const target = el?.closest("[data-port]");
    if (target) {
      connectPorts(g.source, portData(target));
      return;
    }
    const targetNode = el?.closest(".bom-node");
    if (targetNode && g.source.type === "bom-out" && targetNode.dataset.node !== g.source.node) {
      reparentNode(targetNode.dataset.node, g.source.node);
      return;
    }
    if (g.source.type === "bom-out" && el?.closest("#canvas") && !el.closest(".outline-panel,.zoom-controls")) {
      addNodeDialog(g.source.node, worldPoint(event));
      return;
    }
    notify("Drop on a component port or empty canvas to add a sub-component");
  }
});

document.addEventListener("pointercancel", () => {
  if (gesture?.kind === "node") {
    const node = state.nodes[gesture.id];
    if (node) {
      setNodePosition(gesture.id, gesture.startX, gesture.startY);
      const el = $(`.bom-node[data-node="${gesture.id}"]`);
      if (el) {
        el.style.left = gesture.startX + "px";
        el.style.top = gesture.startY + "px";
      }
      drawEdges();
    }
  }
  gesture = null;
  $("#canvas")?.classList.remove("panning");
  $("#draftWire")?.classList.add("hidden");
});

document.addEventListener("wheel", event => {
  if (!event.target.closest("#canvas")) return;
  event.preventDefault();
  zoomAt(Math.exp(-event.deltaY * 0.0015), event.clientX, event.clientY);
}, { passive: false });
