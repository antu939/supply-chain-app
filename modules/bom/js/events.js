"use strict";

/* ---------------------------------------------------------------------------
   事件绑定
--------------------------------------------------------------------------- */
function syncComplianceStatusInputs() {
  const options = $("#complianceStatusOptions");
  const badge = $("#complianceStatusLabel");
  if (!options) return;
  const checked = options.querySelector('input[name="complianceStatus"]:checked');
  for (const label of $$(".comp-status-option", options)) {
    label.classList.toggle("is-checked", !!label.querySelector("input")?.checked);
  }
  if (!checked || !badge) return;
  const meta = complianceStatus(checked.value);
  badge.textContent = meta.label;
  badge.className = "comp-status-pill comp-status-" + meta.key;
}

const actions = {
  "nav-bom": () => {
    ui.view = "bom";
    ui.panel = null;
    ui.outline = false;
    render();
  },
  "nav-subjects": () => {
    ui.view = "subjects";
    ui.panel = null;
    render();
  },
  "nav-risk": () => {
    ui.view = "risk";
    ui.panel = null;
    ui.outline = false;
    render();
  },
  "undo": undo,
  "redo": redo,
  "new-document": newDocumentDialog,
  "delete-document": deleteDocumentDialog,
  "check": checkProject,
  "load-sample": () => {
    ui.moreOpen = false;
    renderHeader();
    loadSampleWorkspace();
  },
  "load-legacy": () => {
    ui.moreOpen = false;
    renderHeader();
    loadLegacyWorkspace();
  },
  "export-data": exportProjectData,
  "import-data": () => $("#importDataInput")?.click(),
  "toggle-more": () => {
    ui.moreOpen = !ui.moreOpen;
    $("#moreMenu").classList.toggle("hidden", !ui.moreOpen);
    $("#moreBtn").setAttribute("aria-expanded", String(ui.moreOpen));
  },
  "toggle-outline": () => {
    ui.outline = !ui.outline;
    render();
  },
  "add-node": el => {
    const point = el.dataset.context ? contextPoint : null;
    addNodeDialog(el.dataset.node || ui.selected, point);
  },
  "edit-node": el => editNodeDialog(el.dataset.node || ui.selected),
  "delete-node": el => deleteNode(el.dataset.node || ui.selected),
  "select-node": el => selectNode(el.dataset.node),
  "open-relations": el => openRelations(el.dataset.node),
  "open-line": el => openRelations(el.dataset.node, "edge"),
  "back-bom": () => {
    ui.selected = ui.focusNode || ui.selected;
    ui.view = "bom";
    ui.panel = null;
    render();
    if (ui.selected) requestAnimationFrame(() => ensureNodeVisible(ui.selected));
  },
  "layout": layoutBOM,
  "toggle-bom-orientation": () => {
    if (!doc()) return;
    const target = ui.bomOrientation === "horizontal" ? "vertical" : "horizontal";
    ui.bomOrientation = target;
    clearArmed();
    render();
    requestAnimationFrame(fitView);
    notify(target === "vertical" ? "Switched to vertical layout" : "Switched to horizontal layout");
  },
  "fit": fitView,
  "zoom-in": () => zoomAt(1.18),
  "zoom-out": () => zoomAt(1 / 1.18),
  "add-company": el => openCompanyAddDialog(el.dataset.node, el.dataset.role || "", el.dataset.label),
  "company-add-mode": el => changeCompanyAddMode(el.dataset.mode),
  "reuse-matched-company": el => reuseMatchedCompany(el.dataset.company),
  "review-duplicate-company": el => reviewDuplicateCompanies(el.dataset.company),
  "add-custom-field": () => {
    const rows = $("#cfRows");
    if (!rows) return;
    const count = rows.querySelectorAll("[data-cf-row]").length;
    if (count >= 60) {
      notify("Maximum 60 custom fields");
      return;
    }
    rows.insertAdjacentHTML("beforeend", customFieldRowHTML());
    rows.lastElementChild.querySelector("[data-cf-key]").focus();
  },
  "remove-custom-field": el => {
    el.closest("[data-cf-row]")?.remove();
  },
  "add-global-company": () => doc() ? openCompanyAddDialog(ui.selected || doc().rootNodeId, "", "Company") : openCompanyEditor(null),
  "new-global-company": () => openCompanyEditor(null),
  "edit-company": el => openCompanyEditor(el.dataset.company),
  "open-company": el => openCompanyPanel(el.dataset.company, el.dataset.node || null),
  "close-panel": closePanel,
  "pick-supply-party": el => pickSupplyParty(el.dataset.role, el.dataset.company),
  "clear-supply-pick": clearSupplyPick,
  "pick-factory-party": el => pickFactoryParty(el.dataset.role, el.dataset.factory),
  "clear-factory-pick": clearFactoryPick,
  "open-factories": el => openFactoriesPanel(el.dataset.nid || ui.focusNode, el.dataset.down, el.dataset.up),
  "link-company": el => createCompanyLink(el.dataset.nid || ui.focusNode, el.dataset.down, el.dataset.up),
  "toggle-factory-link": el => toggleFactoryLink(el.dataset.nid, el.dataset.down, el.dataset.up, el.dataset.receiver, el.dataset.supplier),
  "remove-company-link": el => removeCurrentCompanyLink(el.dataset.nid || ui.focusNode, el.dataset.down, el.dataset.up),
  "remove-company-from-node": el => removeGroupCompany(el.dataset.node, el.dataset.company),
  "goto-relations": el => openRelations(el.dataset.node),
  "add-factory": el => openFactoryEditor(null, { companyId: el.dataset.company }),
  "edit-factory": el => openFactoryEditor(el.dataset.factory),
  "delete-factory": el => deleteFactoryDialog(el.dataset.factory),
  "restore-factory": el => restoreFactoryAction(el.dataset.factory),
  "subject-filter": el => {
    ui.subjectFilter = el.dataset.filter;
    renderSubjectResults();
  },
  "subject-compliance": el => {
    ui.complianceFilter = el.dataset.filter;
    renderSubjectResults();
  },
  "subject-trace-toggle": () => {
    if (ui.subjectTraceRoot) {
      ui.subjectTraceRoot = null;
      ui.subjectTracePick = false;
    } else ui.subjectTracePick = !ui.subjectTracePick;
    renderSubjectResults();
  },
  "pick-subject-trace": el => {
    if (!state.companies[el.dataset.company]) return;
    ui.subjectTraceRoot = el.dataset.company;
    ui.subjectTracePick = false;
    renderSubjectResults();
  },
  "subject-trace-reset": () => {
    ui.subjectTraceRoot = null;
    ui.subjectTracePick = true;
    renderSubjectResults();
  },
  "subject-trace-exit": () => {
    ui.subjectTraceRoot = null;
    ui.subjectTracePick = false;
    renderSubjectResults();
  },
  "trace-company-downstream": el => {
    if (!state.companies[el.dataset.company]) return;
    ui.view = "subjects";
    ui.panel = null;
    ui.focusNode = null;
    ui.subjectTraceRoot = el.dataset.company;
    ui.subjectTracePick = false;
    render();
  },
  "risk-add-item": el => riskItemDialog(el.dataset.kind),
  "risk-edit-item": el => riskItemDialog(el.dataset.kind, Number(el.dataset.index)),
  "risk-delete-item": el => removeRiskItem(el.dataset.kind, Number(el.dataset.index)),
  "risk-save": commitRiskAssessment,
  "risk-clear": clearRiskAction,
  "clear-subject-search": () => {
    ui.subjectQuery = "";
    ui.subjectFilter = "all";
    ui.complianceFilter = "all";
    renderSubjects($("#main"));
    $("#subjectSearch")?.focus();
  },
  "close-dialog": closeDialog
};

document.addEventListener("click", event => {
  const port = event.target.closest("[data-port]");
  if (port) {
    handlePortClick(port);
    return;
  }
  const actionEl = event.target.closest("[data-action]");
  if (actionEl && !actionEl.disabled) {
    const fn = actions[actionEl.dataset.action];
    if (fn) {
      try {
        fn(actionEl, event);
      } catch (error) {
        console.error(error);
        notify(error.message || "Action failed");
      }
    }
    if (ui.moreOpen && actionEl.dataset.action !== "toggle-more") {
      ui.moreOpen = false;
      renderHeader();
    }
    closeContext();
    return;
  }
  if (ui.moreOpen && !event.target.closest("#moreMenu") && !event.target.closest("#moreBtn")) {
    ui.moreOpen = false;
    renderHeader();
  }
  if (ui.armed) clearArmed();
  if (!event.target.closest("#contextMenu")) closeContext();
});

document.addEventListener("input", event => {
  if(event.target.id==="existingCompanySearch")filterExistingCompanies(event.target.value);
  if(companyAddState?.mode==="new"&&event.target.closest("#newCompanyFields")&&event.target.name==="name")updateNewCompanyNameMatch(event.target.value);
  if (event.target.id === "subjectSearch") {
    ui.subjectQuery = event.target.value;
    renderSubjectResults();
  }
});

document.addEventListener("change", event => {
  if(event.target.id==="importDataInput"){
    const file=event.target.files?.[0];event.target.value="";
    if(file)importProjectDataFile(file).catch(e=>notify("Import failed: "+(e?.message||"Invalid file")));
    return;
  }
  if(event.target.id==="existingCompanySelect")updateExistingCompanySelection();
  if (event.target.name === "complianceStatus") syncComplianceStatusInputs();
  if (event.target.id === "documentSelect") {
    const chosen = event.target.value;
    if (chosen === state.activeDiagramId) return;
    event.target.value = state.activeDiagramId || "";
    const keepRisk = ui.view === "risk";
    const switchDocument = () => {
      const before = state.activeDiagramId;
      state.activeDiagramId = chosen;
      ui.view = keepRisk ? "risk" : "bom";
      ui.focusNode = null;
      ui.selected = doc()?.rootNodeId || null;
      ui.panel = null;
      ui.riskCompany = null;
      riskDraft = null;
      ui.bomView = { x: 40, y: 34, k: 1 };
      if (!persist()) {
        state.activeDiagramId = before;
        sanitizeUI();
      }
      render();
      if (!keepRisk) requestAnimationFrame(fitView);
    };
    if (keepRisk) withRiskDraftSwitch(switchDocument);
    else switchDocument();
  }
  if (event.target.id === "subjectSort") {
    ui.subjectSort = event.target.value;
    renderSubjectResults();
  }
  if (event.target.id === "riskCompanySelect") {
    const selected = event.target.value;
    event.target.value = currentRiskCompanyId() || "";
    selectRiskCompany(selected);
  }
  if (event.target.id === "riskMarketSelect") {
    const selected = event.target.value;
    event.target.value = currentRiskMarket();
    selectRiskMarket(selected);
  }
  if (event.target.id === "riskStatusSelect") {
    editRiskStatus(event.target.value);
    // 状态文字、提示与样式保持同步；状态本身仍只存在草稿中，直到人工保存。
    preserveRiskScroll();
  }
  if (event.target.id === "materialSource") {
    const reuse = !!event.target.value;
    const input = $("#componentNameInput");
    if (input) {
      input.required = !reuse;
      input.closest(".form-field")?.classList.toggle("hidden", reuse);
    }
    const note = $("#reuseNote");
    if (note) note.hidden = !reuse;
  }
});

$("#dialogForm").addEventListener("submit", event => {
  event.preventDefault();
  setDialogError("");
  try {
    dialogHandler?.(event.currentTarget);
  } catch (error) {
    setDialogError(error.message || "Please check your input");
  }
});
$("#dialog").addEventListener("close", () => {
  dialogHandler = null;
  companyAddState = null;
});

document.addEventListener("keydown", event => {
  const editable = event.target.matches("input,textarea,select,[contenteditable=true]");
  const meta = event.ctrlKey || event.metaKey;

  if (event.key === "Tab" && ui.panel && !$("#dialog").open) {
    const panel = $("#panel");
    const focusables = $$("button, [href], input, select, textarea, [tabindex]:not([tabindex='-1'])", panel)
      .filter(el => !el.disabled && el.offsetParent !== null);
    if (focusables.length) {
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (document.activeElement === panel || !panel.contains(document.activeElement)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
        return;
      }
      if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
        return;
      }
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
        return;
      }
    }
  }

  if (event.code === "Space" && !editable && !event.target.closest("button")) {
    event.preventDefault();
    spaceDown = true;
    $("#canvas")?.classList.add("space-pan");
  }

  if (event.key === "Escape") {
    if ($("#dialog").open) return;
    if (ui.panel) {
      closePanel();
      return;
    }
    if (!$("#contextMenu").classList.contains("hidden")) {
      closeContext();
      return;
    }
    if (ui.moreOpen) {
      ui.moreOpen = false;
      renderHeader();
      return;
    }
    if (ui.armed) {
      ui.armed = null;
      $$(".port.armed").forEach(p => p.classList.remove("armed"));
      $("#draftWire")?.classList.add("hidden");
      return;
    }
    if (ui.outline) {
      ui.outline = false;
      render();
    }
    return;
  }

  if ($("#dialog").open) return;
  if (editable) return;

  if (meta && event.key.toLowerCase() === "z") {
    event.preventDefault();
    if (event.shiftKey) redo();
    else undo();
    return;
  }
  if (meta && event.key.toLowerCase() === "y") {
    event.preventDefault();
    redo();
    return;
  }
  if ((meta && event.key.toLowerCase() === "k") || event.key === "/") {
    event.preventDefault();
    ui.view = "subjects";
    ui.panel = null;
    render();
    requestAnimationFrame(() => {
      const input = $("#subjectSearch");
      input?.focus();
      input?.select();
    });
    return;
  }
  if (event.key === "Delete" && ui.view === "bom" && ui.selected) {
    event.preventDefault();
    deleteNode(ui.selected);
    return;
  }
  if (event.key === "Enter" && event.target.classList.contains("bom-node")) {
    event.preventDefault();
    openRelations(event.target.dataset.node);
    return;
  }
  if (event.key.toLowerCase() === "f" && ui.view === "bom") {
    event.preventDefault();
    fitView();
  }
});

document.addEventListener("keyup", event => {
  if (event.code === "Space") {
    spaceDown = false;
    $("#canvas")?.classList.remove("space-pan");
  }
});

document.addEventListener("dblclick", event => {
  if (event.target.closest("button,input,textarea,select")) return;
  const node = event.target.closest(".bom-node");
  if (node && ui.view === "bom") {
    openRelations(node.dataset.node);
    return;
  }
  if (event.target.closest("#canvas") && ui.view === "bom") {
    if (!doc()) return;
    addNodeDialog(ui.selected || doc().rootNodeId, worldPoint(event));
  }
});

document.addEventListener("contextmenu", event => {
  const canvas = event.target.closest("#canvas");
  if (canvas && ui.view === "bom" && doc()) {
    showContext(event, event.target.closest(".bom-node")?.dataset.node);
  }
});

window.addEventListener("resize", () => closeContext());

/* 启动 */
render();
if (doc()) requestAnimationFrame(fitView);
if (sampleLoaded) notify(hasLegacyWorkspace() ? "Loaded sample supply chain; previous workspace can be restored from …" : "Loaded sample supply chain");
if (storageError && !sampleLoaded) notify("Could not restore local data; started empty workspace");
