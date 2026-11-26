"use strict";

/* ---------------------------------------------------------------------------
   基础工具
--------------------------------------------------------------------------- */
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
const esc = text => String(text ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmt = n => Number(n).toLocaleString("en-US", { maximumFractionDigits: 4 });
const stampText = ts => {
  if (!Number.isSafeInteger(ts)) return "";
  const date = new Date(ts);
  const pad = n => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
};

const NODE_W = 236;
const NODE_H = 138;

const ICON_PATHS = {
  plus: '<path d="M8 3v10M3 8h10"/>',
  search: '<circle cx="7" cy="7" r="4.3"/><path d="M10.2 10.2 14 14"/>',
  close: '<path d="M4 4l8 8M12 4l-8 8"/>',
  edit: '<path d="M11.3 2.7l2 2-8.1 8.1H3.2v-2z"/><path d="M9.6 4.4l2 2"/>',
  back: '<path d="M13 8H3M7 4 3 8l4 4"/>',
  forward: '<path d="M3 8h10M9 4l4 4-4 4"/>',
  fit: '<path d="M3 6V3h3M10 3h3v3M13 10v3h-3M6 13H3v-3"/>',
  chevron: '<path d="M4 6l4 4 4-4"/>',
  check: '<path d="M3 8.4l3 3 7-7"/>',
  dots: '<circle cx="3.2" cy="8" r=".9" fill="currentColor" stroke="none"/><circle cx="8" cy="8" r=".9" fill="currentColor" stroke="none"/><circle cx="12.8" cy="8" r=".9" fill="currentColor" stroke="none"/>',
  info: '<circle cx="8" cy="8" r="5.6"/><path d="M8 7.3v3.4M8 5.2v.1"/>',
  factory: '<path d="M2.5 13V6.5l3.4 2v-2l3.4 2v-2l3.2 2V13z"/><path d="M5 13v-2M8.2 13v-2M11.4 13v-2"/>',
  building: '<path d="M3.2 13V4.5L8 2.5l4.8 2V13"/><path d="M2 13h12M6 6h.1M10 6h.1M6 9h.1M10 9h.1M6.5 13v-2h3v2"/>',
  link: '<path d="M6.5 9.5l3-3"/><path d="M5.2 11.6l-1 1a2.3 2.3 0 0 1-3.3-3.3l2-2A2.3 2.3 0 0 1 6.4 7"/><path d="M10.8 4.4l1-1a2.3 2.3 0 0 1 3.3 3.3l-2 2A2.3 2.3 0 0 1 10 9.1"/>',
  trash: '<path d="M3 5h10M6 5V3h4v2M5 5l.5 8h5L11 5"/>',
  grid: '<rect x="2.5" y="2.5" width="4.5" height="4.5" rx="1"/><rect x="9" y="2.5" width="4.5" height="4.5" rx="1"/><rect x="2.5" y="9" width="4.5" height="4.5" rx="1"/><rect x="9" y="9" width="4.5" height="4.5" rx="1"/>',
  arrowLeft: '<path d="M12.5 8H4M7.5 4.5 4 8l3.5 3.5"/>',
  arrowRight: '<path d="M3.5 8H12M8.5 4.5 12 8l-3.5 3.5"/>',
  swap: '<path d="M3 6.5h9M9 3.5l3 3-3 3M13 11.5H4M7 8.5l-3 3 3 3"/>',
  warn: '<path d="M8 2.8 14 13H2z"/><path d="M8 6.5v3M8 11.4v.1"/>',
  shield: '<path d="M8 2 13 4v4.1c0 3-2 5-5 5.9-3-.9-5-2.9-5-5.9V4z"/><path d="M5.9 8.1 7.4 9.6 10.3 6.7"/>',
  gauge: '<path d="M2.6 11.6a5.4 5.4 0 1 1 10.8 0"/><path d="M8 10.9 10.4 7"/><circle cx="8" cy="11.2" r="1"/>',
  rotate: '<path d="M13.2 6.1A5.4 5.4 0 1 0 13.1 9.7"/><path d="M13.2 2.8v3.5h-3.5"/>'
};
function icon(name, size = 15) {
  return `<svg class="ic" width="${size}" height="${size}" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON_PATHS[name] || ""}</svg>`;
}

const ROLE_META = {
  supplier: { label: "Supplier", short: "S" },
  receiver: { label: "Receiver", short: "R" },
  both: { label: "Both", short: "B" },
  none: { label: "Unlinked", short: "—" }
};

/* ---------------------------------------------------------------------------
   UI 状态
--------------------------------------------------------------------------- */
let state = emptyState();
let ui = {
  view: "bom",
  selected: null,
  focusNode: null,
  relationMode: "node",
  panel: null,
  outline: false,
  armed: null,
  moreOpen: false,
  subjectQuery: "",
  subjectFilter: "all",
  subjectSort: "name",
  complianceFilter: "all",
  subjectTraceRoot: null,
  subjectTracePick: false,
  riskCompany: null,
  riskMarket: "eu",
  bomView: { x: 40, y: 34, k: 1 },
  bomOrientation: "horizontal",
  bomVerticalPositions: {},
  panelAttention: false,
  panelReturnFocus: null
};

let undoStack = [];
let redoStack = [];
let toastTimer = null;
let dialogHandler = null;
let storageError = false;
let storageReadFailed = false;
let savedBomText = null;
let spaceDown = false;
let contextPoint = null;
let sampleLoaded = false;

function hasLegacyWorkspace() {
  try {
    return !!localStorage.getItem(LEGACY_STORAGE_KEY);
  } catch (_) {
    return false;
  }
}

function loadBuiltInSampleState() {
  if (typeof SAMPLE_BOM_STATE === "undefined") return false;
  state = validateState(clone(SAMPLE_BOM_STATE));
  return true;
}

try {
  const text = localStorage.getItem(STORAGE_KEY);
  savedBomText = text;
  if (text !== null) {
    const raw = JSON.parse(text);
    // 在升级旧版公司归属结构前留存一次原始本地数据，避免覆盖历史记录。
    if (raw.version < 3) {
      const backupKey = STORAGE_KEY + "-before-v3";
      try { if (!localStorage.getItem(backupKey)) localStorage.setItem(backupKey, text); } catch (_) { /* 存储空间不足仍允许加载原数据 */ }
    }
    if(raw.version<4){
      const backupKey=STORAGE_KEY+"-before-v4";
      try{if(!localStorage.getItem(backupKey))localStorage.setItem(backupKey,text);}catch(_){}
    }
    if(raw.version<5){
      const backupKey=STORAGE_KEY+"-before-v5";
      try{if(!localStorage.getItem(backupKey))localStorage.setItem(backupKey,text);}catch(_){}
    }
    if(raw.version<6){
      const backupKey=STORAGE_KEY+"-before-v6";
      try{if(!localStorage.getItem(backupKey))localStorage.setItem(backupKey,text);}catch(_){}
    }
    if(raw.version<7){
      const backupKey=STORAGE_KEY+"-before-v7";
      try{if(!localStorage.getItem(backupKey))localStorage.setItem(backupKey,text);}catch(_){}
    }
    state = validateState(raw);
  } else {
    // 首次进入工作区保持空白，不自动载入虚构示例数据；示例可由用户从「…」菜单显式载入。
    // 上一版本机数据原样保留，可从「…」菜单恢复。
    try {
      const legacy = localStorage.getItem(LEGACY_STORAGE_KEY);
      if (legacy && !localStorage.getItem(STORAGE_KEY + "-legacy-backup")) localStorage.setItem(STORAGE_KEY + "-legacy-backup", legacy);
    } catch (_) { /* 存储不可用时保持空白工作区 */ }
  }
} catch (e) {
  storageError = true;
  storageReadFailed = true;
  // 读取异常时保持空白视图，绝不自动覆盖已有本地存储或注入虚构示例数据。
}

// 复杂示例默认展开结构面板，兼顾全图概览与按名称导航。
if (sampleLoaded) ui.outline = true;

if (state.activeDiagramId) {
  const d = state.diagrams.find(x => x.id === state.activeDiagramId);
  ui.selected = d?.rootNodeId || null;
}

/* ---------------------------------------------------------------------------
   数据读取
--------------------------------------------------------------------------- */
function doc() {
  return state.diagrams.find(d => d.id === state.activeDiagramId) || null;
}
function activeIds() {
  return doc() ? walk(state, doc().rootNodeId) : [];
}
function nodeName(id) {
  return nameOf(state, id);
}
function companyName(id) {
  return state.companies[id]?.name || "";
}
function pathOf(id) {
  const names = [];
  const seen = new Set();
  while (state.nodes[id] && !seen.has(id)) {
    seen.add(id);
    names.unshift(nodeName(id));
    id = state.nodes[id].parentId;
  }
  return names.join(" / ");
}
function ancestorChain(id) {
  const chain = [];
  const seen = new Set();
  let cursor = id;
  while (state.nodes[cursor] && !seen.has(cursor)) {
    seen.add(cursor);
    chain.unshift({ id: cursor, name: nodeName(cursor) });
    cursor = state.nodes[cursor].parentId;
  }
  return chain;
}
function depthOf(id) {
  let depth = 0;
  let cursor = state.nodes[id]?.parentId;
  const seen = new Set();
  while (cursor && !seen.has(cursor)) {
    seen.add(cursor);
    depth++;
    cursor = state.nodes[cursor].parentId;
  }
  return depth;
}
// 纵向布局只把坐标保存在 UI 缓存中：state.nodes 的 x/y 仍是横向布局，业务数据不因转向而改写。
function nodePosition(nid) {
  const node = state.nodes[nid];
  if (!node) return null;
  if (ui.bomOrientation === "vertical") {
    const cached = ui.bomVerticalPositions[nid];
    if (cached) return cached;
  }
  return { x: node.x, y: node.y };
}
function setNodePosition(nid, x, y) {
  const node = state.nodes[nid];
  if (!node) return;
  if (ui.bomOrientation === "vertical") ui.bomVerticalPositions[nid] = { x, y };
  else {
    node.x = x;
    node.y = y;
  }
}
function resetBomOrientationCache() {
  ui.bomVerticalPositions = {};
}
function companiesInDoc() {
  const set = new Set();
  for (const id of activeIds()) for (const cid of groupOf(state, id)) set.add(cid);
  return set;
}
function companyNodes(cid) {
  return values(state.nodes).filter(n => groupOf(state, n.id).includes(cid));
}
function companyLinkRows(cid) {
  const rows = [];
  for (const [nid, byDown] of Object.entries(state.relationships)) {
    for (const [down, ups] of Object.entries(byDown)) {
      if (down === cid) {
        for (const up of ups) {
          rows.push({ nid, role: "receiver", other: up, down: cid, up, factoryCount: getFactoryLinks(state, nid, cid, up).length });
        }
      }
      if (ups.includes(cid)) {
        rows.push({ nid, role: "supplier", other: down, down, up: cid, factoryCount: getFactoryLinks(state, nid, down, cid).length });
      }
    }
  }
  return rows;
}
function companyStats(cid) {
  const rows = companyLinkRows(cid);
  return {
    factories: factoriesOf(state, cid).length,
    supplier: rows.filter(r => r.role === "supplier").length,
    receiver: rows.filter(r => r.role === "receiver").length,
    upstream: new Set(rows.filter(r => r.role === "receiver").map(r => r.other)).size,
    downstream: new Set(rows.filter(r => r.role === "supplier").map(r => r.other)).size,
    links: rows.length,
    nodes: companyNodes(cid).length
  };
}
function roleOf(cid) {
  const stat = companyStats(cid);
  if (stat.supplier && stat.receiver) return "both";
  if (stat.supplier) return "supplier";
  if (stat.receiver) return "receiver";
  return "none";
}
/* 合规状态：四色制度，未填写默认「尚未核实」。 */
function complianceOf(cid) {
  return normalizeCompliance(state.companies[cid]?.compliance);
}
function complianceStatus(key) {
  return COMPLIANCE_STATUSES.find(item => item.key === key) || COMPLIANCE_STATUSES.find(item => item.key === DEFAULT_COMPLIANCE_STATUS);
}
function complianceMetaOf(cid) {
  return complianceStatus(complianceOf(cid).status);
}
function complianceStats() {
  const counts = { severe: 0, risk: 0, qualified: 0, unverified: 0 };
  for (const company of values(state.companies)) counts[complianceOf(company.id).status]++;
  return {
    total: values(state.companies).length,
    ...counts,
    attention: counts.severe + counts.risk,
    assessed: counts.severe + counts.risk + counts.qualified
  };
}
function complianceBadgeHTML(cid, { label = false, extraClass = "" } = {}) {
  const meta = complianceMetaOf(cid);
  return `<span class="comp-status-badge comp-status-${meta.key}${extraClass ? " " + extraClass : ""}" title="Compliance: ${esc(meta.label)}">
    <i class="comp-status-dot" aria-hidden="true"></i>${label ? `<span>${esc(meta.label)}</span>` : ""}
  </span>`;
}
function initials(name) {
  return String(name || "").trim().slice(0, 2).toUpperCase() || "—";
}
function highlight(text, query) {
  const source = String(text ?? "");
  const tokens = query.trim().split(/\s+/).filter(Boolean);
  if (!tokens.length) return esc(source);
  const re = new RegExp(tokens.map(t => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "gi");
  let out = "";
  let last = 0;
  let match;
  while ((match = re.exec(source))) {
    out += esc(source.slice(last, match.index)) + "<mark>" + esc(match[0]) + "</mark>";
    last = match.index + match[0].length;
    if (!match[0]) re.lastIndex++;
  }
  return out + esc(source.slice(last));
}

/* ---------------------------------------------------------------------------
   通知 / 存储 / 历史
--------------------------------------------------------------------------- */
function notify(text) {
  const el = $("#toast");
  el.textContent = text;
  el.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add("hidden"), 3200);
}
function persist({ restoreBackup = false } = {}) {
  let errMessage = "";
  try {
    if (storageReadFailed && !restoreBackup) throw Error("Local storage read failed. Reload or import a backup.");
    if (!restoreBackup && localStorage.getItem(STORAGE_KEY) !== savedBomText) throw Error("BOM data changed externally. Reload to continue.");
    const text = JSON.stringify(state);
    localStorage.setItem(STORAGE_KEY, text);
    savedBomText = text;
    storageError = false;
    storageReadFailed = false;
  } catch (e) {
    storageError = true;
    errMessage = e?.name === "QuotaExceededError" ? "Storage quota exceeded" : (e?.message || "Local storage unavailable");
    notify(errMessage);
  }
  updateSaveState();
  if (typeof window !== "undefined" && window.BOMHostBridge) {
    window.BOMHostBridge.postToShell?.("sc:save-status", { ok: !storageError, message: errMessage });
    if (!storageError && window.BOMHostBridge.onStatePersisted) {
      window.BOMHostBridge.onStatePersisted(state);
    }
  }
  return !storageError;
}
function updateSaveState() {
  const el = $("#saveState");
  if (!el) return;
  const hasContent = state.diagrams.length || Object.keys(state.companies).length;
  el.textContent = storageError ? "Save failed" : hasContent ? "Saved" : "Empty";
  el.classList.toggle("is-empty", !hasContent);
  el.classList.toggle("is-error", storageError);
}
function pushHistory(before) {
  if (before === JSON.stringify(state)) return;
  undoStack.push(before);
  if (undoStack.length > 80) undoStack.shift();
  redoStack = [];
}
function change(fn, { renderAfter = true, restoreBackup = false } = {}) {
  const before = JSON.stringify(state);
  const beforeUI = { ...ui };
  let result;
  try {
    result = fn();
  } catch (e) {
    state = JSON.parse(before);
    ui = beforeUI;
    notify(e.message);
    return undefined;
  }
  if (!persist({ restoreBackup })) {
    state = JSON.parse(before);
    ui = beforeUI;
    sanitizeUI();
    render();
    return undefined;
  }
  pushHistory(before);
  if (renderAfter) render();
  return result === undefined ? true : result;
}
function undo() {
  if (!undoStack.length) return;
  const before = state;
  state = JSON.parse(undoStack[undoStack.length - 1]);
  if (!persist()) { state = before; return; }
  undoStack.pop();
  redoStack.push(JSON.stringify(before));
  if (typeof resetRiskDraft === "function") resetRiskDraft();
  sanitizeUI();
  render();
  notify("Undone");
}
function redo() {
  if (!redoStack.length) return;
  const before = state;
  state = JSON.parse(redoStack[redoStack.length - 1]);
  if (!persist()) { state = before; return; }
  redoStack.pop();
  undoStack.push(JSON.stringify(before));
  if (typeof resetRiskDraft === "function") resetRiskDraft();
  sanitizeUI();
  render();
  notify("Redone");
}

/* ---------------------------------------------------------------------------
   UI 一致性
--------------------------------------------------------------------------- */
function sanitizeUI() {
  if (!doc()) {
    ui.selected = null;
    ui.focusNode = null;
    if (ui.view !== "subjects" && ui.view !== "risk") ui.view = "bom";
  }
  if (doc() && !state.nodes[ui.selected]) ui.selected = doc().rootNodeId;
  if (ui.focusNode && !state.nodes[ui.focusNode]) {
    ui.focusNode = null;
    if (ui.view === "relations") ui.view = "bom";
  }
  if (ui.view === "relations" && !ui.focusNode) ui.view = "bom";
  if (ui.view === "risk") {
    const rootCompanies = doc() ? groupOf(state, doc().rootNodeId) : [];
    if (!rootCompanies.includes(ui.riskCompany)) ui.riskCompany = rootCompanies[0] || null;
  }
  if (ui.subjectTraceRoot && !state.companies[ui.subjectTraceRoot]) {
    ui.subjectTraceRoot = null;
    ui.subjectTracePick = false;
  }
  if (ui.panel?.type === "company" && !state.companies[ui.panel.companyId]) ui.panel = null;
  if (ui.panel?.type === "factories") {
    const { nid, down, up } = ui.panel;
    if (!state.nodes[nid] || !hasCompanyLink(state, nid, down, up)) ui.panel = null;
  }
}

/* ---------------------------------------------------------------------------
   弹窗
--------------------------------------------------------------------------- */
function showDialog(title, body, onSubmit, options = {}) {
  closeContext();
  const dialog = $("#dialog");
  const opts = {
    submit: "Save",
    cancel: "Cancel",
    subtitle: "",
    wide: false,
    footerLeft: "",
    hideSubmit: false,
    submitDisabled: false,
    ...options
  };
  $("#dialogTitle").textContent = title;
  $("#dialogSubtitle").textContent = opts.subtitle;
  $("#dialogSubtitle").classList.toggle("hidden", !opts.subtitle);
  $("#dialogBody").innerHTML = body;
  $("#dialogError").textContent = "";
  $("#dialogForm").classList.toggle("wide", !!opts.wide);
  dialog.classList.toggle("wide", !!opts.wide);
  const submitButton = opts.hideSubmit ? "" : `<button type="submit" class="btn primary" id="dialogSubmit" ${opts.submitDisabled ? "disabled" : ""}>${esc(opts.submit)}</button>`;
  $("#dialogFooter").innerHTML = `${opts.footerLeft}<span class="spacer"></span><button type="button" class="btn ghost" data-action="close-dialog">${esc(opts.cancel)}</button>${submitButton}`;
  dialogHandler = onSubmit;
  if (!dialog.open) dialog.showModal();
  $("#dialogBody").scrollTop = 0;
  const first = $("#dialogBody").querySelector("input:not([type=hidden]):not([disabled]),textarea,select");
  if (first) first.focus();
}
function closeDialog() {
  const dialog = $("#dialog");
  if (dialog?.open) dialog.close();
  dialogHandler = null;
}
function setDialogSubmit(label, disabled) {
  const btn = $("#dialogSubmit");
  if (!btn) return;
  btn.textContent = label;
  btn.disabled = !!disabled;
}
function setDialogError(message) {
  $("#dialogError").textContent = message || "";
}
function confirmAction(title, message, fn, submit = "Confirm") {
  showDialog(
    title,
    `<div class="confirm-box"><span class="confirm-icon">${icon("warn", 18)}</span><p>${esc(message)}</p></div>`,
    () => {
      closeDialog();
      fn();
    },
    { submit }
  );
  $("#dialogSubmit").classList.add("danger-btn");
}

/* ---------------------------------------------------------------------------
   侧边面板
--------------------------------------------------------------------------- */
function openPanel(panel) {
  if (!ui.panel) ui.panelReturnFocus = document.activeElement;
  ui.panel = panel;
  ui.panelAttention = true;
  renderPanel();
}
function closePanel() {
  if (!ui.panel) return;
  const returnFocus = ui.panelReturnFocus;
  ui.panel = null;
  ui.panelReturnFocus = null;
  renderPanel();
  if (returnFocus && typeof returnFocus.focus === "function" && document.contains(returnFocus)) {
    returnFocus.focus({ preventScroll: true });
  }
}

/* ---------------------------------------------------------------------------
   全局渲染
--------------------------------------------------------------------------- */
function render() {
  sanitizeUI();
  renderHeader();
  renderSubbar();
  const main = $("#main");
  if (ui.view === "bom") renderBOM(main);
  else if (ui.view === "relations") renderRelations(main);
  else if (ui.view === "risk") renderRisk(main);
  else renderSubjects(main);
  renderPanel();
  renderStatus();
  $("#moreMenu")?.classList.toggle("hidden", !ui.moreOpen);
  $("#moreBtn")?.setAttribute("aria-expanded", String(ui.moreOpen));
}

function renderHeader() {
  const currentNav = ui.view === "subjects" ? "subjects" : ui.view === "risk" ? "risk" : "bom";
  $$("[data-nav]").forEach(el => {
    const active = el.dataset.nav === currentNav;
    el.classList.toggle("active", active);
    el.setAttribute("aria-current", active ? "page" : "false");
  });
  const undoBtn = $("#undoBtn");
  const redoBtn = $("#redoBtn");
  if (undoBtn) undoBtn.disabled = !undoStack.length;
  if (redoBtn) redoBtn.disabled = !redoStack.length;
  const moreMenu = $("#moreMenu");
  const moreBtn = $("#moreBtn");
  if (moreMenu) moreMenu.classList.toggle("hidden", !ui.moreOpen);
  if (moreBtn) moreBtn.setAttribute("aria-expanded", String(ui.moreOpen));
  const legacyItem = $("#legacyWorkspaceItem");
  if (legacyItem) legacyItem.classList.toggle("hidden", !hasLegacyWorkspace());
  updateSaveState();
}

function renderSubbar() {
  const subbar = $("#subbar");
  if (ui.view === "bom") {
    const d = doc();
    const count = activeIds().length;
    const companies = companiesInDoc().size;
    subbar.innerHTML = `
      <div class="crumbs">
        <span class="crumb-eyebrow">BOM</span>
        <span class="crumb-sep">/</span>
        ${d
          ? `<select class="doc-select" id="documentSelect" aria-label="Select BOM">${state.diagrams.map(x => `<option value="${x.id}" ${x.id === state.activeDiagramId ? "selected" : ""}>${esc(nodeName(x.rootNodeId))}</option>`).join("")}</select>`
          : `<span class="crumb-current muted">None</span>`}
        ${d ? `<span class="crumb-meta">${count} nodes · ${companies} companies</span>` : ""}
      </div>
      <div class="subbar-actions">
        <button type="button" class="btn ghost small ${ui.outline ? "is-on" : ""}" data-action="toggle-outline" ${!d ? "disabled" : ""}>${icon("grid", 14)}Outline</button>
        <button type="button" class="btn" data-action="add-node" ${!d || !ui.selected ? "disabled" : ""}>${icon("plus", 14)}Component</button>
        <button type="button" class="btn ghost small" data-action="toggle-bom-orientation" ${!d ? "disabled" : ""} title="${ui.bomOrientation === "vertical" ? "Switch to horizontal layout" : "Switch to vertical layout"}" aria-label="${ui.bomOrientation === "vertical" ? "Switch to horizontal layout" : "Switch to vertical layout"}">${icon("rotate", 14)}${ui.bomOrientation === "vertical" ? "Horizontal" : "Vertical"}</button>
        <button type="button" class="btn ghost small" data-action="layout" ${!d ? "disabled" : ""}>Auto Layout</button>
        <button type="button" class="btn ghost small" data-action="fit" ${!d ? "disabled" : ""}>Fit View</button>
      </div>`;
  } else if (ui.view === "relations") {
    const chain = ui.focusNode ? ancestorChain(ui.focusNode) : [];
    const last = chain.at(-1);
    subbar.innerHTML = `
      <div class="crumbs">
        <button type="button" class="crumb-back" data-action="back-bom">${icon("back", 14)}<span>BOM</span></button>
        <span class="crumb-sep">/</span>
        ${chain.slice(0, -1).map(item => `<button type="button" class="crumb-link" data-action="open-relations" data-node="${item.id}">${esc(item.name)}</button><span class="crumb-sep">/</span>`).join("")}
        <span class="crumb-current">${esc(last?.name || "")}</span>
        <span class="crumb-tag">${ui.relationMode === "edge" ? "Supply Links" : "Companies"}</span>
      </div>
      <div class="subbar-actions">
        <button type="button" class="btn ghost small" data-action="nav-subjects">${icon("building", 14)}Companies</button>
      </div>`;
  } else if (ui.view === "risk") {
    const d = doc();
    const rootCount = d ? groupOf(state, d.rootNodeId).length : 0;
    subbar.innerHTML = `
      <div class="crumbs">
        <span class="crumb-eyebrow">MARKET ACCESS</span>
        <span class="crumb-sep">/</span>
        ${d
          ? `<select class="doc-select" id="documentSelect" aria-label="Select BOM">${state.diagrams.map(x => `<option value="${x.id}" ${x.id === state.activeDiagramId ? "selected" : ""}>${esc(nodeName(x.rootNodeId))}</option>`).join("")}</select>`
          : `<span class="crumb-current muted">None</span>`}
        <span class="crumb-tag">Compliance</span>
        ${d ? `<span class="crumb-meta">${rootCount} entities · ${activeIds().length} nodes</span>` : ""}
      </div>
      <div class="subbar-actions">
        <button type="button" class="btn ghost small" data-action="nav-bom">${icon("grid", 14)}BOM Tree</button>
        <button type="button" class="btn ghost small" data-action="nav-subjects">${icon("building", 14)}Companies</button>
      </div>`;
  } else {
    subbar.innerHTML = `
      <div class="crumbs">
        <span class="crumb-eyebrow">DIRECTORY</span>
        <span class="crumb-sep">/</span>
        <span class="crumb-current">Companies</span>
      </div>
      <div class="subbar-actions">
        <button type="button" class="btn primary small" data-action="new-global-company">${icon("plus", 13)}New Company</button>
        <button type="button" class="btn small" data-action="nav-bom">${icon("grid", 14)}BOM Tree</button>
      </div>`;
  }
}

function renderStatus() {
  const status = $("#status");
  const hint = $("#statusHint");
  if (!status) return;
  if (hint) hint.textContent = "";
  if (ui.view === "bom") {
    if (doc()) {
      const links = countCompanyLinksForDoc();
      status.textContent = `${activeIds().length} nodes · ${companiesInDoc().size} companies · ${links} supply links`;
    } else {
      status.textContent = "Empty workspace";
    }
  } else if (ui.view === "relations") {
    const n = state.nodes[ui.focusNode];
    if (ui.relationMode === "edge" && n?.parentId) {
      const down = groupOf(state, n.parentId).length;
      const up = groupOf(state, n.id).length;
      status.textContent = `${down} receivers · ${up} suppliers · ${countLinksForNode(n.id)} links`;
    } else {
      status.textContent = `${groupOf(state, ui.focusNode || "").length} linked companies`;
    }
  } else if (ui.view === "risk") {
    const d = doc();
    const companies = d ? groupOf(state, d.rootNodeId) : [];
    if (!d) {
      status.textContent = "No BOM";
    } else if (!companies.length) {
      status.textContent = "No entity linked";
    } else {
      const cid = currentRiskCompanyId(), market = currentRiskMarket();
      const draft = ensureRiskDraft();
      status.textContent = `${companyName(cid)} · ${riskMarketName(market)} · ${riskStatusMeta(draft.status).label}`;
    }
  } else {
    const role = ROLE_META[ui.subjectFilter];
    const compliance = complianceStats();
    status.textContent = `${values(state.companies).length} companies · ${values(state.factories).length} plants${ui.subjectFilter !== "all" ? ` · ${role.label}` : ""}${compliance.attention ? ` · ${compliance.attention} flagged` : ""}`;
  }
}

function countCompanyLinksForDoc() {
  return activeIds().reduce((sum, id) => sum + countLinksForNode(id), 0);
}
function countLinksForNode(nid) {
  const rows = state.relationships[nid] || {};
  return values(rows).reduce((sum, ups) => sum + ups.length, 0);
}
function countCompanyLinks(s = state) {
  return values(s.relationships).reduce((total, rows) => total + values(rows).reduce((n, ups) => n + ups.length, 0), 0);
}
function countFactoryLinks(s = state) {
  return values(s.factoryLinks).reduce((total, rows) => total + values(rows).reduce((n, groups) => n + values(groups).reduce((m, pairs) => m + pairs.length, 0), 0), 0);
}
