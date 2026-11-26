"use strict";

/* ---------------------------------------------------------------------------
   市场合规准入评估（人工版）
   一份记录 = BOM + 评估主体（成品节点关联公司）+ 目标市场。
   无算法打分、无自动准入结论；AI 辅助核验留待后续版本。
--------------------------------------------------------------------------- */
let riskDraft = null;

function resetRiskDraft() { riskDraft = null; }
function rootCompanies() {
  const current = doc();
  return current ? groupOf(state, current.rootNodeId) : [];
}
function currentRiskCompanyId() {
  const list = rootCompanies();
  return list.includes(ui.riskCompany) ? ui.riskCompany : (list[0] || null);
}
function currentRiskMarket() {
  return ASSESSMENT_MARKETS.some(item => item.key === ui.riskMarket) ? ui.riskMarket : "eu";
}
// 确定性提示：沿当前 BOM 供货关系向上游遍历，只读取人工填写的公司合规状态。
// 不调用 AI，也不改变准入状态。
function upstreamComplianceAlerts(cid) {
  const current = doc();
  if (!current || !cid) return { severe: [], risk: [] };
  const severe = [], risk = [];
  for (const upstreamId of upstreamCompanyIds(state, current.id, cid)) {
    const meta = complianceMetaOf(upstreamId);
    if (meta.key === "severe") severe.push({ id: upstreamId, name: companyName(upstreamId), meta });
    else if (meta.key === "risk") risk.push({ id: upstreamId, name: companyName(upstreamId), meta });
  }
  return { severe, risk };
}
function upstreamAlertHTML(cid) {
  const { severe, risk } = upstreamComplianceAlerts(cid);
  if (!severe.length && !risk.length) return "";
  const primary = severe.length ? severe : risk;
  const meta = severe.length ? complianceStatus("severe") : complianceStatus("risk");
  const names = primary.slice(0, 3).map(item => item.name).join(", ");
  const more = primary.length > 3 ? ` +${primary.length - 3} more` : "";
  const secondary = severe.length && risk.length ? ` · ${risk.length} at risk` : "";
  return `<div class="market-upstream-alert comp-status-${meta.key}" role="status">
    <span class="comp-status-dot large" aria-hidden="true"></span>
    <div class="market-alert-copy">
      <strong>${severe.length ? "Upstream Severe Compliance Alert" : "Upstream Compliance Risk"}</strong>
      <small>${esc(names)}${esc(more)}${esc(secondary)}</small>
    </div>
    <span class="market-alert-count">${primary.length}</span>
  </div>`;
}
function riskMarketName(id) {
  return ASSESSMENT_MARKETS.find(item => item.key === id)?.label || "Unselected";
}
function riskStatusMeta(key) {
  return ASSESSMENT_STATUSES.find(item => item.key === key) || ASSESSMENT_STATUSES[0];
}
function ensureRiskDraft() {
  const current = doc(), cid = currentRiskCompanyId(), market = currentRiskMarket();
  if (!current || !cid) { riskDraft = null; return null; }
  if (riskDraft?.did === current.id && riskDraft.cid === cid && riskDraft.market === market) return riskDraft;
  const saved = assessmentOf(state, current.id, cid, market);
  riskDraft = {
    did: current.id, cid, market, status: saved?.status || "pending",
    evidence: clone(saved?.evidence || []),
    pendingItems: clone(saved?.pendingItems || []),
    saved: !!saved, updatedAt: saved?.updatedAt || null, dirty: false
  };
  return riskDraft;
}
function withRiskDraftSwitch(onSwitch) {
  if (riskDraft?.dirty) {
    confirmAction("Discard unsaved changes?", "Switching entity or market will discard unsaved edits.", () => {
      riskDraft = null;
      onSwitch();
    }, "Discard");
  } else onSwitch();
}
function selectRiskCompany(cid) {
  const current = doc();
  if (!current || !groupOf(state, current.rootNodeId).includes(cid)) return;
  if (currentRiskCompanyId() === cid) return;
  withRiskDraftSwitch(() => { ui.riskCompany = cid; riskDraft = null; render(); });
}
function selectRiskMarket(market) {
  if (!ASSESSMENT_MARKETS.some(item => item.key === market)) return;
  if (currentRiskMarket() === market) return;
  withRiskDraftSwitch(() => { ui.riskMarket = market; riskDraft = null; render(); });
}
function editRiskStatus(status) {
  const draft = ensureRiskDraft();
  if (!draft || !ASSESSMENT_STATUSES.some(item => item.key === status)) return;
  draft.status = status;
  draft.dirty = true;
  paintRiskDraft();
}
function paintRiskDraft() {
  const draft = riskDraft, stateEl = $("#riskSaveState");
  if (!draft || !stateEl) return;
  stateEl.classList.toggle("is-dirty", draft.dirty);
  stateEl.textContent = draft.dirty ? "Unsaved changes" : draft.saved
    ? `Saved · ${stampText(draft.updatedAt)}` : "Not saved";
}
function preserveRiskScroll(renderPage = true) {
  const scroll = $(".risk-page")?.scrollTop || 0;
  if (renderPage) render();
  const page = $(".risk-page");
  if (page) page.scrollTop = scroll;
}
function riskItemDialog(kind, index = -1) {
  const draft = ensureRiskDraft();
  if (!draft) return;
  const evidence = kind === "evidence";
  const items = evidence ? draft.evidence : draft.pendingItems;
  const item = index >= 0 ? items[index] : null;
  if (index >= 0 && !item) return;
  const title = evidence ? "Key Evidence" : "Open Item";
  showDialog(`${item ? "Edit" : "Add"} ${title}`, `
    <label class="form-field"><span>${evidence ? "Evidence Title" : "Item Title"}</span>
      <input name="itemTitle" maxlength="120" required value="${esc(item?.title || "")}" placeholder="${evidence ? "e.g. Material test report" : "e.g. Verify restricted substances"}">
    </label>
    <label class="form-field"><span>${evidence ? "Summary" : "Details"} <em class="optional">Optional</em></span>
      <textarea name="itemDetail" maxlength="3000" rows="3" placeholder="Details">${esc(item?.detail || "")}</textarea>
    </label>
    ${evidence ? `<label class="form-field"><span>Source / Reference <em class="optional">Optional</em></span>
      <input name="itemSource" maxlength="1000" value="${esc(item?.source || "")}" placeholder="Document, URL, or report ID">
    </label>` : ""}
  `, form => {
    const data = new FormData(form);
    const name = String(data.get("itemTitle") || "").trim();
    if (!name) throw Error("Title is required");
    const updated = {
      id: item?.id || `a${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`,
      title: name, detail: String(data.get("itemDetail") || "").trim()
    };
    if (evidence) updated.source = String(data.get("itemSource") || "").trim();
    if (item) items[index] = updated;
    else {
      if (items.length >= 300) throw Error("Maximum 300 items per list");
      items.push(updated);
    }
    draft.dirty = true;
    closeDialog();
    preserveRiskScroll();
    notify(item ? `Updated ${title} (unsaved)` : `Added ${title} (unsaved)`);
  });
}
function removeRiskItem(kind, index) {
  const draft = ensureRiskDraft();
  if (!draft) return;
  const items = kind === "evidence" ? draft.evidence : draft.pendingItems;
  const item = items[index];
  if (!item) return;
  confirmAction("Delete Item", `Delete "${item.title}"?`, () => {
    items.splice(index, 1);
    draft.dirty = true;
    preserveRiskScroll();
  }, "Delete");
}
function commitRiskAssessment() {
  const current = doc(), draft = ensureRiskDraft();
  if (!current || !draft) return;
  const saved = change(() => setMarketAssessment(state, current.id, draft.cid, draft.market, {
    status: draft.status, evidence: draft.evidence, pendingItems: draft.pendingItems
  }), {renderAfter:false});
  if (!saved) return;
  riskDraft = null;
  preserveRiskScroll();
  notify("Assessment saved");
}
function clearRiskAction() {
  const current = doc(), draft = ensureRiskDraft();
  if (!current || !draft || !draft.saved) return;
  confirmAction("Delete Assessment", `Delete assessment for "${companyName(draft.cid)} · ${riskMarketName(draft.market)}"?`, () => {
    if (!change(() => clearMarketAssessment(state, current.id, draft.cid, draft.market), {renderAfter:false})) return;
    riskDraft = null;
    preserveRiskScroll();
    notify("Assessment deleted");
  }, "Delete");
}
function riskRecordRows(items, kind) {
  const evidence = kind === "evidence";
  if (!items.length) return `<div class="market-empty">${evidence ? "No evidence" : "No open items"}</div>`;
  return `<div class="market-records">${items.map((item, index) => `
    <div class="market-record">
      <div class="market-record-indicator ${evidence ? "evidence" : "pending"}">${icon(evidence ? "shield" : "warn", 16)}</div>
      <div class="market-record-copy">
        <strong>${esc(item.title)}</strong>
        ${item.detail ? `<p>${esc(item.detail)}</p>` : ""}
        ${evidence && item.source ? `<small>Source: ${esc(item.source)}</small>` : ""}
      </div>
      <div class="market-record-actions">
        <button type="button" class="icon-btn" data-action="risk-edit-item" data-kind="${kind}" data-index="${index}" aria-label="Edit ${esc(item.title)}" title="Edit">${icon("edit",14)}</button>
        <button type="button" class="icon-btn market-delete" data-action="risk-delete-item" data-kind="${kind}" data-index="${index}" aria-label="Delete ${esc(item.title)}" title="Delete">${icon("close",14)}</button>
      </div>
    </div>`).join("")}</div>`;
}
function riskPickerOptions(options, selected) {
  return options.map(item => `<option value="${esc(item.key)}" ${selected === item.key ? "selected" : ""}>${esc(item.label)}</option>`).join("");
}
function renderRisk(main) {
  const current = doc();
  if (!current) {
    riskDraft = null;
    main.innerHTML = `<div class="page risk-page market-page">
      <header class="page-head"><div class="page-head-copy"><p class="eyebrow">MARKET ACCESS</p><h1>Market Access Assessment</h1></div></header>
      <div class="market-empty-card"><h2>No BOM</h2>
      <button type="button" class="btn primary" data-action="new-document">${icon("plus",14)}New BOM</button></div></div>`;
    return;
  }
  const root = state.nodes[current.rootNodeId], companies = rootCompanies();
  const cid = currentRiskCompanyId(), market = currentRiskMarket();
  const draft = cid ? ensureRiskDraft() : null;
  const meta = riskStatusMeta(draft?.status || "pending");
  main.innerHTML = `<div class="page risk-page market-page">
    <header class="market-heading"><p class="eyebrow">MARKET ACCESS</p><h1>Market Access Assessment</h1><p>${esc(nodeName(root.id))}</p></header>
    <div class="market-content">
      <section class="market-pickers" aria-label="Scope">
        <label class="market-picker"><span>Entity</span><select id="riskCompanySelect" ${!companies.length ? "disabled" : ""}>
          ${companies.length ? companies.map(id => `<option value="${esc(id)}" ${id === cid ? "selected" : ""}>${esc(companyName(id))} · ${esc(complianceMetaOf(id).label)}</option>`).join("") : `<option>No linked entity</option>`}
        </select></label>
        <label class="market-picker"><span>Target Market</span><select id="riskMarketSelect">${riskPickerOptions(ASSESSMENT_MARKETS,market)}</select></label>
      </section>
      ${cid ? upstreamAlertHTML(cid) : ""}
      ${!cid ? `<div class="market-empty-card"><h2>No Entity Linked</h2>
        <button type="button" class="btn primary" data-action="add-company" data-node="${esc(root.id)}" data-role="" data-label="Entity">${icon("plus",14)}Link Company</button></div>` : `
      <section class="market-status market-status-${meta.key}">
        <div class="market-section-top"><h2>Access Status</h2></div>
        <div class="market-status-main"><span class="market-status-icon">${icon(meta.key === "verified" ? "shield" : meta.key === "blocked" ? "warn" : "info",22)}</span>
          <div class="market-status-copy"><strong>${esc(meta.label)}</strong><small>${esc(companyName(cid))} · ${esc(riskMarketName(market))}</small></div>
          <label class="market-status-change"><span>Status</span><select id="riskStatusSelect">${riskPickerOptions(ASSESSMENT_STATUSES,meta.key)}</select></label>
        </div>
      </section>
      <div class="market-sections">
        <section class="market-section">
          <header class="market-section-top"><div><h2>Key Evidence</h2><span>${draft.evidence.length}</span></div>
            <button type="button" class="btn small" data-action="risk-add-item" data-kind="evidence">${icon("plus",13)}Add Evidence</button></header>
          ${riskRecordRows(draft.evidence,"evidence")}
        </section>
        <section class="market-section">
          <header class="market-section-top"><div><h2>Open Items</h2><span>${draft.pendingItems.length}</span></div>
            <button type="button" class="btn small" data-action="risk-add-item" data-kind="pending">${icon("plus",13)}Add Item</button></header>
          ${riskRecordRows(draft.pendingItems,"pending")}
        </section>
      </div>
      <footer class="market-footer">
        <span class="risk-save-state${draft.dirty ? " is-dirty" : ""}" id="riskSaveState">${draft.dirty ? "Unsaved changes" : draft.saved ? `Saved · ${stampText(draft.updatedAt)}` : "Not saved"}</span>
        ${draft.saved ? `<button type="button" class="btn ghost small danger" data-action="risk-clear">Delete</button>` : ""}
        <button type="button" class="btn primary" data-action="risk-save">${icon("check",14)}Save Assessment</button>
      </footer>`}
    </div>
  </div>`;
}
