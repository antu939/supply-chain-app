"use strict";

/* ---------------------------------------------------------------------------
   对话框与命令
--------------------------------------------------------------------------- */
let companyAddState = null;

function ensureCompanyName(name, excludeId = null) {
  const duplicate = findCompanyByName(state, name, excludeId);
  if (duplicate) throw Error(`"${duplicate.name}" already exists. Reuse the existing company record.`);
}

/* ------------------------------- BOM Dialogs ------------------------------ */
function newDocumentDialog() {
  showDialog(
    "New BOM",
    `<label class="form-field"><span>Product Name <i class="required">*</i></span><input name="name" required maxlength="120" autocomplete="off" placeholder="Product name"></label>`,
    form => {
      const name = new FormData(form).get("name").trim();
      if (!name) throw Error("Product name is required");
      closeDialog();
      if (!change(() => {
        const id = addDocument(state, name);
        ui.selected = id;
        ui.focusNode = null;
        ui.view = "bom";
        ui.bomView = { x: 40, y: 34, k: 1 };
        ui.outline = false;
      })) return;
      requestAnimationFrame(fitView);
      notify("BOM created");
    },
    { submit: "Create" }
  );
}

function addNodeDialog(parentId = ui.selected, point = null) {
  if (!state.nodes[parentId]) {
    notify("Select a parent component first");
    return;
  }
  const materials = values(state.materials);
  showDialog(
    "Add Sub-component",
    `<label class="form-field"><span>Component Name <i class="required">*</i></span><input name="name" id="componentNameInput" required maxlength="120" autocomplete="off" placeholder="Component name"></label>
    <div class="form-grid">
      <label class="form-field"><span>Qty per Unit <i class="required">*</i></span><input name="qty" type="number" required min="0.0001" step="any" value="1"></label>
      <label class="form-field"><span>Unit</span><input name="unit" maxlength="30" placeholder="pcs / kg"></label>
    </div>
    <label class="form-field"><span>Reuse Component Definition <span class="optional">Optional</span></span>
      <select name="materialId" id="materialSource">
        <option value="">Create new component</option>
        ${materials.map(m => `<option value="${m.id}">${esc(m.name)}</option>`).join("")}
      </select>
    </label>`,
    form => {
      const data = new FormData(form);
      const materialId = data.get("materialId");
      const name = String(data.get("name") || "").trim();
      const qty = Number(data.get("qty"));
      const unit = String(data.get("unit") || "").trim();
      if (!materialId && !name) throw Error("Component name is required");
      if (!Number.isFinite(qty) || qty <= 0) throw Error("Quantity must be greater than 0");
      if (materialId && !state.materials[materialId]) throw Error("Component definition not found");
      const displayName = materialId ? state.materials[materialId].name : name;
      closeDialog();
      if (!change(() => {
        const id = addNode(state, parentId, { materialId, name, qty, unit });
        if (point) {
          state.nodes[id].x = Math.round(point.x);
          state.nodes[id].y = Math.round(point.y);
        }
        ui.selected = id;
      })) return;
      requestAnimationFrame(() => {
        ensureNodeVisible(ui.selected);
        renderSubbar();
      });
      notify(`Added "${displayName}"`);
    },
    { submit: "Add", subtitle: pathOf(parentId) }
  );
}

function editNodeDialog(nid = ui.selected) {
  const node = state.nodes[nid];
  const material = materialOf(state, nid);
  if (!node || !material) return;
  showDialog(
    "Edit Component",
    `<label class="form-field"><span>Name <i class="required">*</i></span><input name="name" required maxlength="120" value="${esc(material.name)}"></label>
    <label class="form-field"><span>Part Code</span><input name="code" maxlength="120" value="${esc(material.code)}" placeholder="Optional"></label>
    ${node.parentId ? `<div class="form-grid">
      <label class="form-field"><span>Qty per Unit</span><input name="qty" type="number" required min="0.0001" step="any" value="${node.qty}"></label>
      <label class="form-field"><span>Unit</span><input name="unit" maxlength="30" value="${esc(node.unit)}" placeholder="pcs / kg"></label>
    </div>` : ""}
    <label class="form-field"><span>Notes</span><textarea name="note" rows="3" maxlength="5000" placeholder="Optional">${esc(material.note)}</textarea></label>
    ${node.parentId ? `<div class="sheet-danger"><button type="button" class="btn ghost danger small" data-action="delete-node" data-node="${nid}">Delete Branch…</button></div>` : ""}`,
    form => {
      const data = new FormData(form);
      const name = String(data.get("name") || "").trim();
      const qty = node.parentId ? Number(data.get("qty")) : 1;
      if (!name) throw Error("Name is required");
      if (node.parentId && (!Number.isFinite(qty) || qty <= 0)) throw Error("Quantity must be greater than 0");
      closeDialog();
      if (!change(() => {
        material.name = name;
        material.code = String(data.get("code") || "").trim();
        material.note = String(data.get("note") || "").trim();
        if (node.parentId) {
          node.qty = qty;
          node.unit = String(data.get("unit") || "").trim();
        }
      })) return;
      notify("Component updated");
    },
    { subtitle: pathOf(nid) }
  );
}

function deleteNode(nid) {
  const node = state.nodes[nid];
  if (!node?.parentId) {
    notify("Cannot delete root node. Delete the BOM instead.");
    return;
  }
  const parent = node.parentId;
  confirmAction(
    "Delete Branch",
    `Delete "${nodeName(nid)}" and its sub-components (${walk(state, nid).length} nodes)?`,
    () => {
      if (!change(() => {
        ui.selected = parent;
        deleteSubtree(state, nid);
      })) return;
      notify("Branch deleted");
    },
    "Delete"
  );
}

function deleteDocumentDialog() {
  const d = doc();
  if (!d) return;
  ui.moreOpen = false;
  renderHeader();
  confirmAction(
    "Delete BOM",
    `Delete "${nodeName(d.rootNodeId)}" and all its components and supply links?`,
    () => {
      if (!change(() => {
        deleteDocument(state, d.id);
        ui.view = "bom";
        ui.focusNode = null;
        ui.selected = doc()?.rootNodeId || null;
      })) return;
      requestAnimationFrame(fitView);
      notify("BOM deleted");
    },
    "Delete BOM"
  );
}

/* ------------------------------- 导航 ------------------------------------ */
function openRelations(nid, mode = "node") {
  const node = state.nodes[nid];
  if (!node) return;
  const diagram = diagramOf(state, nid);
  const before = state.activeDiagramId;
  if (diagram) state.activeDiagramId = diagram.id;
  ui.view = "relations";
  ui.relationMode = mode === "edge" && node.parentId ? "edge" : "node";
  ui.focusNode = nid;
  ui.selected = nid;
  ui.panel = null;
  ui.outline = false;
  ui.armed = null;
  if (!persist()) {
    state.activeDiagramId = before;
    sanitizeUI();
  }
  render();
}

function selectNode(nid) {
  if (!state.nodes[nid]) return;
  if (ui.view !== "bom") {
    openRelations(nid);
    return;
  }
  ui.selected = nid;
  syncNodeSelection();
  renderSubbar();
  ensureNodeVisible(nid);
}

/* ------------------------------- 公司资料 --------------------------------- */
function customFieldRowHTML(key = "", value = "", original = false) {
  return `<tr class="cf-row" data-cf-row>
    <td class="cf-key"><input data-cf-key aria-label="Field name" maxlength="80" value="${esc(key)}" placeholder="Field" autocomplete="off"></td>
    <td class="cf-value"><input data-cf-value aria-label="Field value" maxlength="5000" value="${esc(value)}" placeholder="Value" autocomplete="off"></td>
    <td class="cf-prop"><label title="Propagate field to other records"><input type="checkbox" data-cf-prop aria-label="Propagate field"><span>${original ? "" : "New"}</span></label></td>
    <td class="cf-del"><button type="button" class="icon-btn" data-action="remove-custom-field" aria-label="Remove field">${icon("close", 12)}</button></td>
  </tr>`;
}

function entitySheetHTML(kind, data = {}) {
  const label = kind === "factory" ? "Plant" : "Company";
  const isNew = !data.id;
  const rows = Object.entries(data.extraFields || {});
  const compliance = kind === "company" ? normalizeCompliance(data.compliance) : null;
  const status = compliance ? complianceStatus(compliance.status) : null;
  return `<div class="entity-sheet">
    <div class="entity-sheet-head">
      <span class="entity-avatar ${kind}">${icon(kind === "factory" ? "factory" : "building", 17)}</span>
      <div class="entity-sheet-title"><strong>${label} Profile</strong></div>
    </div>
    <table class="sheet basic-sheet">
      <tbody>
        <tr><th>${label} Name <i class="required">*</i></th><td><input name="name" aria-label="${label} name" required maxlength="160" value="${esc(data.name || "")}" autocomplete="off" placeholder="${kind === "factory" ? "Plant name" : "Company name"}"></td></tr>
        <tr><th>Location</th><td><input name="location" aria-label="Location" maxlength="200" value="${esc(data.location || "")}" autocomplete="off" placeholder="City / Region / Address"></td></tr>
        <tr><th>Contact</th><td><input name="contact" aria-label="Contact" maxlength="200" value="${esc(data.contact || "")}" autocomplete="off" placeholder="Name · Phone · Email"></td></tr>
        <tr><th>Notes</th><td><textarea name="note" aria-label="Notes" rows="3" maxlength="5000" placeholder="Optional">${esc(data.note || "")}</textarea></td></tr>
      </tbody>
    </table>
    ${kind === "company" ? `<div class="sheet-title">
      <div><strong>Compliance</strong></div>
      <span class="comp-status-pill comp-status-${status.key}" id="complianceStatusLabel">${esc(status.label)}</span>
    </div>
    <table class="sheet comp-sheet">
      <tbody>
        <tr><th>Status</th><td>
          <div class="comp-status-options" id="complianceStatusOptions" role="radiogroup" aria-label="Compliance Status">
            ${COMPLIANCE_STATUSES.map(item => `<label class="comp-status-option comp-status-${item.key} ${item.key === compliance.status ? "is-checked" : ""}">
              <input type="radio" name="complianceStatus" value="${item.key}" ${item.key === compliance.status ? "checked" : ""}>
              <span class="comp-status-dot" aria-hidden="true"></span>
              <span class="comp-status-text"><strong>${esc(item.label)}</strong></span>
            </label>`).join("")}
          </div>
        </td></tr>
        <tr><th>Notes / Rationale</th><td><textarea name="complianceReason" id="complianceReason" maxlength="5000" rows="3" placeholder="Optional">${esc(compliance.reason || "")}</textarea></td></tr>
      </tbody>
    </table>` : ""}
    <div class="sheet-title">
      <div><strong>Custom Fields</strong></div>
      <span class="sheet-title-count">${rows.length}</span>
    </div>
    <table class="sheet cf-sheet">
      <thead><tr><th>Field</th><th>Value</th><th class="cf-prop-head">Sync</th><th class="cf-del-head"></th></tr></thead>
      <tbody id="cfRows">${rows.map(([key, value]) => customFieldRowHTML(key, value, true)).join("")}</tbody>
    </table>
    <button type="button" class="sheet-add" data-action="add-custom-field">${icon("plus", 13)}Add Field</button>
    ${kind === "factory" && !isNew ? `<div class="sheet-danger">
      ${data.status === "archived"
        ? `<button type="button" class="btn small" data-action="restore-factory" data-factory="${data.id}">Restore Plant</button>`
        : `<button type="button" class="btn ghost danger small" data-action="delete-factory" data-factory="${data.id}">${icon("trash", 13)}Delete or Archive Plant…</button>`}
    </div>` : ""}
  </div>`;
}

function readEntitySheet(form, kind) {
  const read = name => {
    const el = form.querySelector(`[name="${name}"]`);
    return String(el?.value || "").trim();
  };
  const fields = { name: read("name"), location: read("location"), contact: read("contact"), note: read("note"), extraFields: {} };
  if (!fields.name) throw Error(kind === "factory" ? "Plant name is required" : "Company name is required");
  if (kind === "company") {
    const checked = form.querySelector('[name="complianceStatus"]:checked');
    const status = checked?.value || DEFAULT_COMPLIANCE_STATUS;
    if (!COMPLIANCE_STATUS_KEYS.includes(status)) throw Error("Invalid compliance status");
    const reason = read("complianceReason");
    if (reason.length > 5000) throw Error("Notes cannot exceed 5000 characters");
    fields.compliance = { status, reason };
  }
  const propagate = [];
  const keys = new Set();
  for (const row of Array.from(form.querySelectorAll("[data-cf-row]"))) {
    const key = row.querySelector("[data-cf-key]")?.value.trim() || "";
    const value = row.querySelector("[data-cf-value]")?.value.trim() || "";
    if (!key) {
      if (value) throw Error("Field name is required");
      continue;
    }
    if (key.length > 80) throw Error("Field name cannot exceed 80 characters");
    if (value.length > 5000) throw Error("Field value is too long");
    if (keys.has(key)) throw Error(`Duplicate custom field "${key}"`);
    keys.add(key);
    if (keys.size > 60) throw Error("Maximum 60 custom fields");
    fields.extraFields[key] = value;
    if (row.querySelector("[data-cf-prop]")?.checked) propagate.push(key);
  }
  return { fields, propagate };
}

function propagateExtraFields(kind, entityId, keys) {
  if (!keys.length) return 0;
  const pool = kind === "factory" ? values(state.factories) : values(state.companies);
  let added = 0;
  for (const item of pool) {
    if (item.id === entityId) continue;
    item.extraFields = item.extraFields || {};
    for (const key of keys) {
      if (!own(item.extraFields, key)) {
        item.extraFields[key] = "";
        added++;
      }
    }
  }
  return added;
}

function openCompanyEditor(cid = null) {
  const company = cid ? state.companies[cid] : null;
  if (cid && !company) return;
  showDialog(
    company ? "Edit Company" : "New Company",
    entitySheetHTML("company", company || {}),
    form => {
      const { fields, propagate } = readEntitySheet(form, "company");
      ensureCompanyName(fields.name, cid);
      closeDialog();
      let added = 0;
      let createdId = cid;
      if (!change(() => {
        let id = cid;
        const previousLegacyScore = company ? normalizeCompliance(company.compliance).legacyScore : null;
        if (company) Object.assign(company, fields);
        else {
          const result = addCompany(state, fields.name, fields);
          id = result.id;
          createdId = id;
        }
        if (fields.compliance) setCompanyCompliance(state, id, { ...fields.compliance, legacyScore: previousLegacyScore });
        added = propagateExtraFields("company", id, propagate);
      })) return;
      if (!cid && createdId && ui.view === "subjects") openCompanyPanel(createdId);
      notify(added ? `Saved (synced ${added} fields)` : (company ? "Company saved" : "Company created"));
    },
    { wide: true, subtitle: company ? company.name : "" }
  );
}

function openFactoryEditor(fid = null, options = {}) {
  const factory = fid ? state.factories[fid] : null;
  const companyId = factory ? factory.companyId : options.companyId;
  if (!companyId || !state.companies[companyId]) return;
  showDialog(
    factory ? "Edit Plant" : "New Plant",
    entitySheetHTML("factory", factory || {}),
    form => {
      const { fields, propagate } = readEntitySheet(form, "factory");
      closeDialog();
      let added = 0;
      if (!change(() => {
        let id = fid;
        if (factory) Object.assign(factory, fields);
        else id = addFactory(state, companyId, fields.name, fields);
        added = propagateExtraFields("factory", id, propagate);
      })) return;
      notify(added ? `Saved (synced ${added} fields)` : "Plant saved");
    },
    { wide: true, subtitle: `${companyName(companyId)} · Plant` }
  );
}

function deleteFactoryDialog(fid) {
  const factory = state.factories[fid];
  if (!factory) return;
  const usage = window.BOMHostBridge?.inspectFactoryUsageInSales?.(fid);
  if (usage && usage.hasSalesHistory) {
    showDialog(
      "Cannot Delete Plant",
      `<div class="confirm-box">
        <span class="confirm-icon">${icon("warn", 18)}</span>
        <p><strong>"${esc(factory.name)}" has active Sales records (${esc(usage.summary)})</strong> and can only be archived.</p>
      </div>`,
      () => {
        closeDialog();
        if (window.SCShared) {
          window.SCShared.setFactoryStatus(fid, "archived", "Archived due to linked Sales records");
          window.BOMHostBridge?.reloadFromStorage?.(true);
          window.BOMHostBridge?.postToShell?.("sc:data-changed", { module: "bom" });
        } else {
          if (!change(() => {
            factory.status = "archived";
            factory.archivedAt = Date.now();
            factory.archiveReason = "Archived due to linked Sales records";
          })) return;
        }
        notify(`Archived "${factory.name}"`);
      },
      { submit: "Archive Plant" }
    );
    return;
  }
  confirmAction(
    "Delete Plant",
    `Delete "${factory.name}" and its supply routes?`,
    () => {
      if (!change(() => {
        removeFactory(state, fid);
        if (ui.panel?.type === "factories") ui.panel = null;
      })) return;
      notify("Plant deleted");
    },
    "Delete Plant"
  );
}

function restoreFactoryAction(fid) {
  const factory = state.factories[fid];
  if (!factory) return;
  closeDialog();
  if (window.SCShared) {
    window.SCShared.setFactoryStatus(fid, "active", "");
    window.BOMHostBridge?.reloadFromStorage?.(true);
    window.BOMHostBridge?.postToShell?.("sc:data-changed", { module: "bom" });
  } else {
    if (!change(() => { factory.status = "active"; delete factory.archivedAt; delete factory.archiveReason; })) return;
  }
  notify(`Restored "${factory.name}"`);
}

/* ------------------------------- Link Company ----------------------------- */
function companyAddBodyHTML() {
  const nid=companyAddState?.nodeId;
  const all=values(state.companies).slice().sort((a,b)=>a.name.localeCompare(b.name,"en"));
  const linked=new Set(groupOf(state,nid));
  const mode=companyAddState?.mode||(all.length?"existing":"new");
  const options=all.map(c=>`<option value="${esc(c.id)}" ${linked.has(c.id)?"disabled":""}>${esc(c.name)}${linked.has(c.id)?" (linked)":""} · ${esc(c.location||"—")}</option>`).join("");
  return `<div class="segmented company-add-tabs" role="group" aria-label="Add company mode">
      <button type="button" class="segment ${mode==="existing"?"active":""}" data-action="company-add-mode" data-mode="existing" aria-pressed="${mode==="existing"}">Existing (${all.length})</button>
      <button type="button" class="segment ${mode==="new"?"active":""}" data-action="company-add-mode" data-mode="new" aria-pressed="${mode==="new"}">New Company</button>
    </div>
    ${mode==="existing"?`${all.length?`<label class="form-field"><span>Search</span><input id="existingCompanySearch" type="search" placeholder="Search company name or location…" autocomplete="off"></label>
        <label class="form-field"><span>Select Company <i class="required">*</i></span><select id="existingCompanySelect" name="existingCompanyId" size="7" required aria-label="Select company">${options}</select></label>
        <p id="existingCompanySummary" class="form-hint"></p>`:`<p class="form-hint">No companies yet</p>`}`
      :`<div id="newCompanyFields">${entitySheetHTML("company",{})}</div>
        <div id="globalCompanyMatch" class="global-match hidden" role="status"></div>`}`;
}
function renderCompanyAddBody(){
  const host=$("#companyAddBody");if(!host)return;
  host.innerHTML=companyAddBodyHTML();
  setDialogError("");
  setDialogSubmit(companyAddState.mode==="existing"?"Link Company":"Create & Link",companyAddState.mode==="existing"&&!values(state.companies).some(c=>!groupOf(state,companyAddState.nodeId).includes(c.id)));
  if(companyAddState.mode==="existing"){
    const select=$("#existingCompanySelect");
    if(select){select.selectedIndex=-1;select.focus();}
  }else $("#newCompanyFields input[name=name]")?.focus();
}
function changeCompanyAddMode(mode){
  if(!companyAddState||!["existing","new"].includes(mode))return;
  companyAddState.mode=mode;renderCompanyAddBody();
}
function filterExistingCompanies(query){
  const select=$("#existingCompanySelect");if(!select)return;
  const key=normalizedCompanyName(query);
  for(const opt of select.options){
    const company=state.companies[opt.value];
    opt.hidden=!!key&&!normalizedCompanyName([company?.name,company?.location,company?.contact].join(" ")).includes(key);
  }
  select.selectedIndex=-1;
  setDialogSubmit("Link Company",true);
  const summary=$("#existingCompanySummary");if(summary)summary.textContent="";
}
function updateExistingCompanySelection(){
  const select=$("#existingCompanySelect");
  const cid=select?.value;
  const already=groupOf(state,companyAddState?.nodeId).includes(cid);
  setDialogSubmit("Link Company",!cid||already);
  const c=state.companies[cid];
  const summary=$("#existingCompanySummary");
  if(summary)summary.textContent=c?`${c.name} · ${c.location||"—"} · ${companyNodes(cid).length} nodes · ${factoriesOf(state,cid).length} plants`:"";
}
function updateNewCompanyNameMatch(name){
  const host=$("#globalCompanyMatch");if(!host)return;
  const match=name.trim()?findCompanyByName(state,name):null;
  if(match){
    host.classList.remove("hidden");
    host.innerHTML=`${icon("warn",15)}<span>Duplicate: <strong>${esc(match.name)}</strong></span><button type="button" class="btn small" data-action="reuse-matched-company" data-company="${esc(match.id)}">Reuse</button>`;
    setDialogSubmit("Create & Link",true);
  }else{
    host.classList.add("hidden");host.innerHTML="";
    setDialogSubmit("Create & Link",false);
  }
}
function reuseMatchedCompany(cid){
  if(!companyAddState||!state.companies[cid])return;
  companyAddState.mode="existing";
  renderCompanyAddBody();
  const select=$("#existingCompanySelect");
  if(select){select.value=cid;updateExistingCompanySelection();}
}
function openCompanyAddDialog(nodeId,role,label){
  if(!state.nodes[nodeId])return;
  companyAddState={nodeId,mode:values(state.companies).length?"existing":"new"};
  showDialog("Link Company",
    `<div id="companyAddBody"></div>`,
    form=>{
      if(!companyAddState)return;
      const nid=companyAddState.nodeId;
      if(companyAddState.mode==="existing"){
        const cid=$("#existingCompanySelect")?.value;
        if(!cid||!state.companies[cid])throw Error("Select an existing company");
        if(groupOf(state,nid).includes(cid))throw Error("Company already linked");
        assignCompany(clone(state),nid,cid);
        closeDialog();
        if (!change(()=>assignCompany(state,nid,cid))) return;
        notify(`Linked "${companyName(cid)}"`);
      }else{
        const {fields,propagate}=readEntitySheet(form,"company");
        ensureCompanyName(fields.name);
        const trial=clone(state),test=addCompany(trial,fields.name,fields);
        assignCompany(trial,nid,test.id);
        closeDialog();
        if (!change(()=>{
          const result=addCompany(state,fields.name,fields);
          assignCompany(state,nid,result.id);
          if(fields.compliance)setCompanyCompliance(state,result.id,fields.compliance);
          propagateExtraFields("company",result.id,propagate);
        })) return;
        notify(`Created and linked "${fields.name}"`);
      }
    },{wide:true,subtitle:pathOf(nodeId)});
  renderCompanyAddBody();
}

/* ------------------------------- Merge Duplicates ------------------------- */
function reviewDuplicateCompanies(companyId){
  const target=state.companies[companyId];if(!target)return;
  const list=values(state.companies).filter(c=>normalizedCompanyName(c.name)===normalizedCompanyName(target.name));
  if(list.length<2){notify("No duplicate companies found");return;}
  const detail=c=>`<strong>${esc(c.name)}</strong><small>ID ${esc(c.id)} · ${companyNodes(c.id).length} nodes · ${companyStats(c.id).links} links · ${factoriesOf(state,c.id).length} plants</small><small>Location: ${esc(c.location||"—")} · Contact: ${esc(c.contact||"—")}</small><small>Notes: ${esc(c.note||"—")} · ${Object.keys(c.extraFields||{}).length} custom fields</small>`;
  showDialog("Merge Duplicate Companies",
    `<div class="duplicate-review">${list.map((c,i)=>`<label class="duplicate-candidate"><input type="radio" name="keepCompany" value="${esc(c.id)}" ${i===0?"checked":""}><span>${detail(c)}</span></label>`).join("")}</div>
    <label class="duplicate-confirm"><input type="checkbox" name="confirmMerge" required>Confirm merge into a single entity</label>`,
    form=>{
      const data=new FormData(form),keepId=data.get("keepCompany");
      if(data.get("confirmMerge")!=="on")throw Error("Confirm merge to proceed");
      const oldIds=list.filter(c=>c.id!==keepId).map(c=>c.id);
      const trial=clone(state);
      mergeCompanyRecords(trial,keepId,oldIds);
      validateState(trial);
      closeDialog();
      if (!change(()=>mergeCompanyRecords(state,keepId,oldIds))) return;
      ui.panel=null;
      notify(`Merged ${oldIds.length+1} duplicate records`);
    },{wide:true,subtitle:target.name,submit:"Merge"});
}

/* ------------------------------- 示例与旧工作区 --------------------------- */
function applyWorkspace(next, options = {}) {
  if (!change(() => {
    state = next;
    resetBomOrientationCache();
    if (typeof resetRiskDraft === "function") resetRiskDraft();
    ui.view = "bom";
    ui.panel = null;
    ui.focusNode = null;
    ui.outline = !!options.outline;
    ui.riskCompany = null;
    ui.armed = null;
    ui.selected = doc()?.rootNodeId || null;
    ui.bomView = { x: 40, y: 34, k: 1 };
    ui.subjectQuery = "";
    ui.subjectFilter = "all";
    ui.complianceFilter = "all";
    ui.subjectSort = "name";
  }, { restoreBackup: !!options.restoreBackup })) return false;
  requestAnimationFrame(fitView);
  return true;
}

function loadSampleWorkspace() {
  if (typeof SAMPLE_BOM_STATE === "undefined") {
    notify("Sample data unavailable");
    return;
  }
  const next = validateState(clone(SAMPLE_BOM_STATE));
  confirmAction(
    "Load Sample Data",
    "Replace current workspace with sample BOM data?",
    () => {
      if (!applyWorkspace(next, { outline: true })) return;
      notify("Sample data loaded");
    },
    "Load"
  );
}

function loadLegacyWorkspace() {
  let next;
  try {
    const text = localStorage.getItem(LEGACY_STORAGE_KEY);
    if (!text) {
      notify("No previous workspace found");
      return;
    }
    next = validateState(JSON.parse(text));
  } catch (e) {
    notify("Failed to read previous workspace: " + (e?.message || "Invalid format"));
    return;
  }
  confirmAction(
    "Restore Previous Workspace",
    `${next.diagrams.length} BOMs · ${Object.keys(next.companies).length} companies · ${Object.keys(next.factories).length} plants.`,
    () => {
      if (!applyWorkspace(next, { restoreBackup: true })) return;
      notify("Previous workspace restored");
    },
    "Restore"
  );
}

/* ------------------------------- Export / Import -------------------------- */
function exportProjectData(){
  const stamp=new Date().toISOString().replace(/[:.]/g,"-").slice(0,19);
  const blob=new Blob([JSON.stringify(state,null,2)],{type:"application/json;charset=utf-8"});
  const url=URL.createObjectURL(blob),a=document.createElement("a");
  a.href=url;a.download=`BOM_backup_${stamp}.json`;
  document.body.appendChild(a);a.click();a.remove();
  setTimeout(()=>URL.revokeObjectURL(url),1500);
  notify("Backup exported");
}
async function importProjectDataFile(file){
  if(!file)return;
  if(file.size>30*1024*1024)throw Error("File exceeds 30 MB limit");
  const parsed=JSON.parse(await file.text());
  const incoming=validateState(parsed);
  const totalNodes=Object.keys(incoming.nodes).length;
  const duplicateCount=duplicateCompanyGroups(incoming).length;
  showDialog("Import Backup",
    `<p class="form-hint">${incoming.diagrams.length} BOMs · ${totalNodes} nodes · ${Object.keys(incoming.companies).length} companies · ${Object.keys(incoming.factories).length} plants${duplicateCount?` · ${duplicateCount} duplicate groups`:""}</p>`,
    ()=>{
      try {
        const original = localStorage.getItem(STORAGE_KEY);
        if (original === savedBomText && original !== null) {
          localStorage.setItem(STORAGE_KEY + "-before-import-v4", original);
        }
      } catch (_) {}
      closeDialog();
      if (!change(()=>{
        state=incoming;
        resetBomOrientationCache();
        if(typeof resetRiskDraft==="function")resetRiskDraft();
        ui.view="bom";ui.panel=null;ui.focusNode=null;ui.selected=doc()?.rootNodeId||null;ui.outline=false;
      }, { restoreBackup: true })) return;
      undoStack=[];redoStack=[];
      if (doc()) requestAnimationFrame(fitView);
      notify("Backup imported");
    },{submit:"Import",subtitle:file.name});
}

/* ------------------------------- Links ------------------------------------ */
function createCompanyLink(nid, down, up) {
  if (hasCompanyLink(state, nid, down, up)) {
    openFactoriesPanel(nid, down, up);
    return;
  }
  try {
    linkCompany(clone(state), nid, down, up);
  } catch (e) {
    notify(e.message);
    return;
  }
  supplyFlash = { nid, down, up };
  if (!change(() => linkCompany(state, nid, down, up))) return;
  notify("Supply link created");
}

function toggleFactoryLink(nid, down, up, receiverId, supplierId) {
  const linked = getFactoryLinks(state, nid, down, up).some(p => p.receiverFactoryId === receiverId && p.supplierFactoryId === supplierId);
  try {
    if (linked) {
      if (!change(() => unlinkFactory(state, nid, down, up, receiverId, supplierId))) return;
      notify("Plant route removed");
    } else {
      linkFactory(clone(state), nid, down, up, receiverId, supplierId);
      if (!change(() => linkFactory(state, nid, down, up, receiverId, supplierId))) return;
      notify("Plant route added");
    }
  } catch (e) {
    notify(e.message);
  }
}

function removeCurrentCompanyLink(nid, down, up) {
  const factoryCount = getFactoryLinks(state, nid, down, up).length;
  confirmAction(
    "Remove Supply Link",
    `Remove "${companyName(up)} → ${companyName(down)}"${factoryCount ? ` and its ${factoryCount} plant routes` : ""}?`,
    () => {
      if (!change(() => {
        unlinkCompany(state, nid, down, up);
        ui.panel = null;
      })) return;
      notify("Supply link removed");
    },
    "Remove"
  );
}

function removeGroupCompany(nid, cid) {
  if (!state.nodes[nid] || !groupOf(state, nid).includes(cid)) return;
  const trial = clone(state);
  removeCompanyFromGroup(trial, nid, cid);
  const removedCompanies = countCompanyLinks(state) - countCompanyLinks(trial);
  const removedFactories = countFactoryLinks(state) - countFactoryLinks(trial);
  confirmAction(
    "Unlink Company",
    `Remove "${companyName(cid)}" from "${nodeName(nid)}" (${removedCompanies} supply links, ${removedFactories} plant routes)?`,
    () => {
      if (!change(() => {
        removeCompanyFromGroup(state, nid, cid);
        ui.panel = null;
      })) return;
      notify("Company unlinked");
    },
    "Unlink"
  );
}

/* ------------------------------- Validation ------------------------------- */
function checkProject() {
  ui.moreOpen = false;
  renderHeader();
  const problems = [];
  const duplicateGroups=duplicateCompanyGroups(state);
  for(const g of duplicateGroups)problems.push(`${g.length} duplicate company records for "${g[0].name}"`);
  for (const cid of companiesInDoc()) {
    const meta = complianceMetaOf(cid);
    if (meta.key === "severe") problems.push(`"${companyName(cid)}" has Severe compliance status`);
  }
  const unverified = [...companiesInDoc()].filter(cid => complianceOf(cid).status === "unverified").length;
  if (unverified) problems.push(`${unverified} linked ${unverified === 1 ? "company is" : "companies are"} Unverified`);
  if (doc()) {
    const rootIds = groupOf(state, doc().rootNodeId);
    if (rootIds.length) {
      const assessed = rootIds.filter(cid => Object.keys(doc().assessments?.[cid] || {}).length).length;
      if (!assessed) problems.push("No market access assessment recorded for this BOM");
    }
  }
  if (!doc() && !duplicateGroups.length) {
    showDialog("BOM Validation", `<p class="small">No BOM created yet.</p>`, () => closeDialog(), { submit: "Close", hideSubmit: true, cancel: "Close" });
    return;
  }
  for (const id of activeIds()) {
    const node = state.nodes[id];
    if (!groupOf(state, id).length) problems.push(`${pathOf(id)}: no linked companies`);
    if (node.parentId) {
      const links = state.relationships[id] || {};
      const total = values(links).reduce((sum, ups) => sum + ups.length, 0);
      if (!total && groupOf(state, id).length && groupOf(state, node.parentId).length) problems.push(`${pathOf(id)}: no supply links`);
      if (total) {
        let missingFactories = 0;
        for (const [down, ups] of Object.entries(links)) {
          for (const up of ups) if (!getFactoryLinks(state, id, down, up).length) missingFactories++;
        }
        if (missingFactories) problems.push(`${pathOf(id)}: ${missingFactories} links missing plant routes`);
      }
    }
  }
  showDialog(
    "BOM Validation",
    problems.length
      ? `<p class="small muted">${problems.length} ${problems.length === 1 ? "issue" : "issues"} found:</p><ul class="validation-list">${problems.slice(0, 40).map(t => `<li>${esc(t)}</li>`).join("")}</ul>${problems.length > 40 ? `<p class="small muted">Showing first 40.</p>` : ""}`
      : `<div class="check-ok">${icon("check", 18)}<p>No structural issues found.</p></div>`,
    () => closeDialog(),
    { submit: "Close", hideSubmit: true, cancel: "Close" }
  );
}


/* ------------------------------- Context Menu ----------------------------- */
function closeContext() {
  $("#contextMenu")?.classList.add("hidden");
}
function showContext(event, nid) {
  event.preventDefault();
  if (!doc() || ui.view !== "bom" || event.target.closest(".outline-panel,.zoom-controls")) return;
  const canvas = $("#canvas");
  const rect = canvas.getBoundingClientRect();
  const v = view();
  contextPoint = { x: (event.clientX - rect.left - v.x) / v.k, y: (event.clientY - rect.top - v.y) / v.k };
  if (nid) selectNode(nid);
  const target = nid || ui.selected || doc().rootNodeId;
  let html = `<button type="button" role="menuitem" data-action="add-node" data-context="1" data-node="${target}">${icon("plus", 13)}Add Sub-component</button>`;
  if (nid) {
    html += `<button type="button" role="menuitem" data-action="edit-node" data-node="${nid}">${icon("edit", 13)}Edit Component</button>`;
    html += `<button type="button" role="menuitem" data-action="open-relations" data-node="${nid}">${icon("building", 13)}Manage Companies</button>`;
    if (state.nodes[nid].parentId) html += `<button type="button" role="menuitem" data-action="open-line" data-node="${nid}">${icon("link",13)}Edit Supply Links</button>`;
    if (state.nodes[nid].parentId) html += `<div class="menu-sep"></div><button type="button" role="menuitem" class="danger" data-action="delete-node" data-node="${nid}">${icon("trash", 13)}Delete Branch…</button>`;
  }
  const menu = $("#contextMenu");
  menu.innerHTML = html;
  menu.classList.remove("hidden");
  menu.style.left = Math.min(event.clientX, innerWidth - menu.offsetWidth - 10) + "px";
  menu.style.top = Math.min(event.clientY, innerHeight - menu.offsetHeight - 10) + "px";
}
