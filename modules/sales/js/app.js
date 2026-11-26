(function (global) {
  "use strict";

  const TS = global.SC.TimeSeries;
  const WM = global.SC.WorldModel;
  const Sim = global.SC.SimEngine;
  const Act = global.SC.Actions;
  const Demo = global.SC.DemoWorld;
  const Views = global.SC.Views;
  const Inspector = global.SC.Inspector;

  const $ = (sel, root = document) => root.querySelector(sel);
  const esc = t => String(t ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const fmtNum = n => Number(n || 0).toLocaleString("en-US", { maximumFractionDigits: 0 });

  let storageError = null;
  let savedWorkspaceText = null;
  let bomCatalog = WM.readLinkedBomCatalog({ allowBuiltinFallback: false });
  let bomFactories = WM.readBomFinalAssemblyFactories();
  let workspace = loadInitialWorkspace();
  let currentSim = null;
  let undoStack = [];
  let redoStack = [];
  let toastTimer = null;
  let dialogSubmitHandler = null;

  function defaultLogiFilter() {
    return {
      marketId: null,
      factoryId: null,
      status: "all",
      query: "",
      elapsedMin: "",
      elapsedMax: "",
      milestoneField: "putaway",
      dateOp: "on_or_before",
      dateThreshold: "",
      dateSource: "any",
      advOpen: false
    };
  }

  const ui = {
    view: "dashboard", // dashboard | supply | logistics | market
    panel: null,       // { kind: "shipment"|"node"|"batch"|"lanes"|"bom"|"facts", id? }
    dashFactory: "all",
    dashMarket: "all",
    supplyNodeId: null,
    marketNodeId: null,
    logiFilter: defaultLogiFilter(),
    tsState: { toolMode: "rate", curveId: null, selectedPointId: null, selectedSegmentId: null, brush: null },
    moreOpen: false
  };

  function readSharedRegistry() {
    try {
      return global.SCShared ? global.SCShared.loadRegistry().registry : null;
    } catch (_) {
      return null;
    }
  }

  function loadInitialWorkspace(lastGoodWorkspace) {
    storageError = null;
    const sharedReg = readSharedRegistry();
    const bomRaw = WM.readRawBomFromStorage();
    try {
      const v2Text = localStorage.getItem(WM.WORLD_STORAGE_KEY);
      savedWorkspaceText = v2Text;
      if (v2Text !== null) {
        const ws = WM.validateWorkspace(JSON.parse(v2Text));
        if (ws.dataSourceMode !== "demo") {
          WM.syncSharedEntitiesIntoWorkspace(ws, sharedReg, bomRaw);
        }
        return ws;
      }

      // Safe migration from V1 with automatic pre-migration backup
      const v1Text = localStorage.getItem(WM.LEGACY_V1_STORAGE_KEY);
      if (v1Text) {
        const migrated = WM.validateWorkspace(JSON.parse(v1Text), { backupKey: WM.LEGACY_V1_BACKUP_KEY });
        if (migrated.dataSourceMode !== "demo") {
          WM.syncSharedEntitiesIntoWorkspace(migrated, sharedReg, bomRaw);
        }
        WM.assertBusinessData(migrated, { projected: true });
        if (!localStorage.getItem(WM.LEGACY_V1_BACKUP_KEY)) {
          localStorage.setItem(WM.LEGACY_V1_BACKUP_KEY, v1Text);
        }
        try {
          const text = JSON.stringify(migrated);
          localStorage.setItem(WM.WORLD_STORAGE_KEY, text);
          savedWorkspaceText = text;
        } catch (_) {}
        return migrated;
      }
    } catch (err) {
      storageError = err.message || String(err);
      // A failed reload keeps the last usable workspace in memory.
      return lastGoodWorkspace ?? WM.createLiveWorkspaceFromShared(sharedReg, bomRaw);
    }
    // 首次启动：基于共享实体建立真实空白工作区，绝不自动载入示例数据
    return WM.createLiveWorkspaceFromShared(sharedReg, bomRaw);
  }

  function saveWorkspace(next, { restoreBackup = false } = {}) {
    const el = $("#saveState");
    let text;
    try {
      if (storageError && !restoreBackup) throw new Error(`Failed to read local data (${storageError}). Please restore from a backup.`);
      if (!restoreBackup && localStorage.getItem(WM.WORLD_STORAGE_KEY) !== savedWorkspaceText) {
        throw new Error("Local data was updated elsewhere. Please reload before continuing.");
      }
      WM.assertBusinessData(next, { projected: true });
      text = JSON.stringify(next);
      localStorage.setItem(WM.WORLD_STORAGE_KEY, text);
    } catch (err) {
      const msg = err?.name === "QuotaExceededError" ? "Save failed (local storage quota exceeded)"
        : err?.message || "Save failed (local storage unavailable)";
      if (el) { el.textContent = msg; el.classList.add("is-error"); }
      notify(msg, true);
      global.SalesHostBridge?.postToShell?.("sc:save-status", { ok: false, message: msg });
      return false;
    }
    savedWorkspaceText = text;
    workspace = next;
    storageError = null;
    if (el) { el.textContent = "Saved locally"; el.classList.remove("is-error"); }
    global.SalesHostBridge?.postToShell?.("sc:save-status", { ok: true, message: "" });
    global.SalesHostBridge?.onWorkspaceSaved?.(workspace);
    return true;
  }

  function notify(msg, isError) {
    const el = $("#toast");
    if (!el) return;
    el.textContent = msg;
    el.classList.toggle("is-error", Boolean(isError));
    el.classList.remove("hidden");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.add("hidden"), 3400);
  }

  function recomputeSim() {
    currentSim = Sim.simulateWorkspace(workspace, { viewHorizonDays: workspace.viewHorizonDays });
    return currentSim;
  }

  function finishAction(res, options) {
    if (!res.ok) {
      notify(res.errors[0]?.message || "Validation failed", true);
      return res;
    }
    const before = workspace;
    if (!saveWorkspace(res.workspace)) {
      return { ok: false, errors: [{ message: "Changes were not saved. Check local storage or reload." }], workspace: before, simulation: currentSim };
    }
    if (!options?.skipUndo && res.workspace.facts.length === before.facts.length) {
      undoStack.push({ before, after: res.workspace });
      if (undoStack.length > 50) undoStack.shift();
      redoStack = [];
    }
    currentSim = res.simulation;
    renderAll({ preserveViewShell: true });
    if (options?.toast) notify(options.toast);
    return res;
  }

  function dispatch(type, targetId, payload, options) {
    const action = Act.createAction(workspace, type, targetId, payload, { actor: options?.actor || "user" });
    return finishAction(Act.dispatchAction(workspace, action), {
      ...options, skipUndo: options?.skipUndo || type === "workspace.settings.update"
    });
  }

  function dispatchBatch(actionSpecs, options) {
    const actions = (actionSpecs || []).map(spec =>
      Act.createAction(workspace, spec.type, spec.targetId || "", spec.payload || {}, { actor: options?.actor || "user" })
    );
    if (!actions.length) return { ok: false, errors: [{ message: "Enter at least one valid allocation" }] };
    return finishAction(Act.applyActions(workspace, actions), options);
  }

  // Reapply only the fields changed by the plan operation, using the original
  // value as a precondition. A conflict rejects the whole history entry.
  function replayPlanChange(current, from, to) {
    if (WM.sameValue(from, to)) return current;
    const isRecord = value => value && typeof value === "object" && !Array.isArray(value);
    if (isRecord(current) && isRecord(from) && isRecord(to)) {
      const merged = { ...current };
      for (const key of new Set([...Object.keys(from), ...Object.keys(to)])) {
        const next = replayPlanChange(current[key], from[key], to[key]);
        if (next === undefined) delete merged[key];
        else merged[key] = next;
      }
      return merged;
    }
    if (!WM.sameValue(current, from)) throw new Error("Plan was modified by a later change");
    return to;
  }

  function restoreHistory(isRedo) {
    const source = isRedo ? redoStack : undoStack;
    const destination = isRedo ? undoStack : redoStack;
    if (!source.length) return;
    let blocked;
    for (let i = source.length - 1; i >= 0; i--) {
      const entry = source[i];
      const [from, to] = isRedo ? [entry.before, entry.after] : [entry.after, entry.before];
      const next = { ...workspace, revision: workspace.revision + 1 };
      try {
        for (const key of ["nodes", "curves", "batches", "shipments", "lanes", "products", "activeProductId"]) {
          next[key] = replayPlanChange(workspace[key], from[key], to[key]);
        }
        WM.assertProtectedEntities(workspace, next);
        WM.assertNoNewMissingReferences(workspace, next);
        WM.assertBusinessData(next, { projected: true });
      } catch (err) {
        blocked = err.message;
        continue;
      }
      const candidate = WM.clone(next);
      WM.syncLinkedBomFactoryNames(candidate, undefined, WM.readRawBomFromStorage());
      const simulation = Sim.simulateWorkspace(candidate, { viewHorizonDays: candidate.viewHorizonDays });
      if (!saveWorkspace(candidate)) return;
      currentSim = simulation;
      source.splice(i);
      destination.push(entry);
      renderAll({ preserveViewShell: true });
      notify((isRedo ? "Redone" : "Undone") + (blocked ? " (skipped protected or conflicting entries)" : ""));
      return;
    }
    source.length = 0;
    renderAll({ preserveViewShell: true });
    notify(blocked || "Nothing to restore", true);
  }

  function undo() { restoreHistory(false); }
  function redo() { restoreHistory(true); }

  function replaceWorkspace(next, { restoreBackup = false, forceOverwrite = false, catalog = bomCatalog } = {}) {
    if (!forceOverwrite) WM.assertWorkspaceReplacement(workspace, next);
    if (next.workspaceId === workspace.workspaceId) next.revision = Math.max(next.revision, workspace.revision + 1);
    const simulation = Sim.simulateWorkspace(next, { viewHorizonDays: next.viewHorizonDays });
    if (!saveWorkspace(next, { restoreBackup })) return false;
    bomCatalog = catalog;
    refreshBomFactoryList();
    undoStack = [];
    redoStack = [];
    ui.panel = null;
    ui.logiFilter = defaultLogiFilter();
    currentSim = simulation;
    renderAll({ preserveViewShell: false });
    return true;
  }

  /* =========================================================================
     DIALOGS
     ========================================================================= */
  function openDialog({ title, subtitle, bodyHtml, submitLabel, wide, onSubmit }) {
    const dlg = $("#dialog");
    dlg.classList.toggle("wide", Boolean(wide));
    $("#dialogTitle").textContent = title;
    const subEl = $("#dialogSubtitle");
    subEl.textContent = subtitle || "";
    subEl.classList.toggle("hidden", !subtitle);
    $("#dialogBody").innerHTML = bodyHtml;
    $("#dialogError").textContent = "";
    $("#dialogFooter").innerHTML = `
      <button type="button" class="btn" data-close-dialog="1">Cancel</button>
      ${submitLabel ? `<button type="submit" class="btn primary">${esc(submitLabel)}</button>` : ""}
    `;
    dialogSubmitHandler = onSubmit || null;
    if (!dlg.open) dlg.showModal();
  }

  function closeDialog() {
    dialogSubmitHandler = null;
    const dlg = $("#dialog");
    if (dlg.open) dlg.close();
  }

  function openProductSkuDialog() {
    const existing = workspace.products[workspace.activeProductId] || Object.values(workspace.products)[0] || null;
    openDialog({
      title: existing ? "Edit Product / SKU" : "Register Product / SKU",
      submitLabel: "Save",
      bodyHtml: `
        <div class="form-grid">
          <label class="span-2"><span>Product Name</span><input name="name" value="${esc(existing?.name || "")}" placeholder="Enter product name" required></label>
          <label><span>Sales SKU</span><input name="skuCode" value="${esc(existing?.skuCode || "")}" placeholder="Enter SKU code" required></label>
          <label><span>Unit</span><input name="unit" value="${esc(existing?.unit || "")}" placeholder="units / pcs / sets"></label>
          <label class="span-2"><span>Unit Mfg Cost ($)</span><input name="unitManufacturingCost" type="number" min="0" step="any" value="${existing?.unitManufacturingCost ?? 0}"></label>
        </div>`,
      onSubmit(fd) {
        return dispatch("product.save", existing?.productId || "", {
          name: fd.get("name"),
          skuCode: fd.get("skuCode"),
          unit: fd.get("unit"),
          unitManufacturingCost: fd.get("unitManufacturingCost")
        }, { toast: "Product SKU saved" }).ok;
      }
    });
  }

  function openNewMarketDialog() {
    openDialog({
      title: "Add Target Market",
      submitLabel: "Create",
      bodyHtml: `
        <div class="form-grid">
          <label class="span-2"><span>Market Name</span><input name="name" placeholder="Enter market name" required></label>
          <label><span>Region Code</span><input name="region" value="" placeholder="US / EU / UK" required></label>
          <label><span>City / Port</span><input name="city" placeholder="Enter city or port"></label>
          <label class="span-2"><span>Initial Sellable Inventory</span><input name="initialInventory" type="number" min="0" step="any" value="0"></label>
        </div>`,
      onSubmit(fd) {
        return dispatch("node.create", "", {
          kind: "market",
          name: fd.get("name"),
          region: fd.get("region"),
          city: fd.get("city"),
          initialInventory: fd.get("initialInventory")
        }, { toast: `Added "${fd.get("name")}"` }).ok;
      }
    });
  }

  function refreshBomFactoryList() {
    bomFactories = WM.readBomFinalAssemblyFactories();
    return bomFactories;
  }

  function getSelectableFactories() {
    const active = Object.values(workspace.nodes).filter(n => n.kind === "source" && n.entityStatus !== "archived");
    const linkedBomIds = new Set(active.map(n => n.bomFactoryId).filter(Boolean));
    const availableBom = refreshBomFactoryList().filter(bf => !linkedBomIds.has(bf.id));
    return { active, availableBom };
  }

  function buildFactorySelectOptionsHtml(selectedNodeId) {
    const { active, availableBom } = getSelectableFactories();
    const parts = [];
    for (const f of active) {
      parts.push(`<option value="${esc(f.id)}" ${f.id === selectedNodeId ? "selected" : ""}>${esc(f.name)}</option>`);
    }
    for (const bf of availableBom) {
      const val = `bom:${bf.id}`;
      const label = bf.companyName ? `${bf.name} (${bf.companyName})` : bf.name;
      parts.push(`<option value="${esc(val)}" ${val === selectedNodeId ? "selected" : ""}>${esc(label)}</option>`);
    }
    return { html: parts.join(""), total: active.length + availableBom.length, active, availableBom };
  }

  function planFactorySelection(rawValue) {
    const value = String(rawValue || "");
    if (!value) throw new Error("Select a valid origin factory");
    if (!value.startsWith("bom:")) return { nodeId: value };
    const factory = refreshBomFactoryList().find(item => item.id === value.slice(4));
    if (!factory) throw new Error("Assembly factory not found. Refresh and try again.");
    const existing = Object.values(workspace.nodes).find(n => n.kind === "source" && n.bomFactoryId === factory.id);
    if (existing) return { nodeId: existing.id, factory };

    const candidateId = `src_${factory.id}`;
    const nodeId = workspace.nodes[candidateId] ? WM.genId("src") : candidateId;
    return { nodeId, factory, create: { type: "node.create", payload: {
      nodeId,
      kind: "source",
      name: factory.name,
      region: "CN",
      city: factory.location || "",
      bomFactoryId: factory.id,
      bomCompanyId: factory.companyId || null,
      initialInventory: 0,
      emptyCurve: true,
      note: factory.note || ""
    } } };
  }

  function dispatchWithFactory(selection, type, targetId, payload, options) {
    if (!selection.create) return dispatch(type, targetId, payload, options);
    const result = dispatchBatch([selection.create, { type, targetId, payload }], options);
    if (result.ok) {
      ui.supplyNodeId = selection.nodeId;
      renderMain({ preserveViewShell: true });
    } else {
      $("#dialogError").textContent = result.errors[0]?.message || "Changes not saved";
    }
    return result;
  }

  function adoptBomFactory(bomFactoryId) {
    try {
      const selection = planFactorySelection(`bom:${bomFactoryId}`);
      if (selection.create && !dispatchBatch([selection.create], { toast: `Selected factory "${selection.factory.name}"` }).ok) return null;
      ui.supplyNodeId = selection.nodeId;
      renderAll({ preserveViewShell: true });
      return selection.nodeId;
    } catch (err) {
      notify(err.message, true);
      return null;
    }
  }

  function openFactoryPickerDialog() {
    const list = refreshBomFactoryList();
    const linkedBomIds = new Set(
      Object.values(workspace.nodes).filter(n => n.kind === "source" && n.bomFactoryId).map(n => n.bomFactoryId)
    );

    openDialog({
      title: "Select Factory",
      submitLabel: null,
      bodyHtml: `
        <div class="factory-picker">
          <input type="search" class="factory-picker-search" id="factoryPickerSearch" placeholder="Search assembly factory or company…" autocomplete="off">
          <div class="factory-picker-list" id="factoryPickerList"></div>
          <div class="factory-picker-manual">
            <div class="factory-picker-manual-row">
              <input type="text" id="manualFactoryName" placeholder="Add factory manually">
              <button type="button" class="btn small" id="manualFactoryAddBtn">Add</button>
            </div>
          </div>
        </div>`,
      onSubmit() { return false; }
    });

    const renderList = (query) => {
      const q = String(query || "").trim().toLowerCase();
      const filtered = list.filter(bf =>
        !q ||
        bf.name.toLowerCase().includes(q) ||
        bf.companyName.toLowerCase().includes(q) ||
        bf.location.toLowerCase().includes(q)
      );
      const box = $("#factoryPickerList");
      if (!box) return;
      if (!list.length) {
        box.innerHTML = `<div class="empty-card">No available assembly factories</div>`;
        return;
      }
      if (!filtered.length) {
        box.innerHTML = `<div class="empty-card">No factories matching "${esc(query)}"</div>`;
        return;
      }
      box.innerHTML = filtered.map(bf => {
        const adopted = linkedBomIds.has(bf.id);
        return `
          <div class="factory-picker-row">
            <div class="factory-picker-copy">
              <strong>${esc(bf.name)}</strong>
              <span class="muted small">${esc([bf.companyName, bf.location].filter(Boolean).join(" · ") || "Final Assembly Factory")}</span>
            </div>
            ${adopted
              ? `<span class="badge subtle">Selected</span>`
              : `<button type="button" class="btn small primary" data-pick-bom-id="${esc(bf.id)}">Select</button>`}
          </div>`;
      }).join("");
    };

    renderList("");
    const searchEl = $("#factoryPickerSearch");
    searchEl?.addEventListener("input", () => renderList(searchEl.value));
    searchEl?.focus();

    $("#factoryPickerList")?.addEventListener("click", ev => {
      const btn = ev.target.closest("[data-pick-bom-id]");
      if (!btn) return;
      const nid = adoptBomFactory(btn.dataset.pickBomId);
      if (nid) closeDialog();
    });

    $("#manualFactoryAddBtn")?.addEventListener("click", () => {
      const nameInput = $("#manualFactoryName");
      const name = String(nameInput?.value || "").trim();
      if (!name) { $("#dialogError").textContent = "Enter a factory name"; return; }
      const res = dispatch("node.create", "", {
        kind: "source",
        name,
        region: "CN",
        city: "",
        initialInventory: 0,
        emptyCurve: true
      }, { toast: `Added factory "${name}"` });
      if (res.ok) {
        const created = Object.values(workspace.nodes).filter(n => n.kind === "source").slice(-1)[0];
        if (created) ui.supplyNodeId = created.id;
        renderMain({ preserveViewShell: true });
        closeDialog();
      }
    });
  }

  function openLaneDialog(editLaneId) {
    const existing = editLaneId ? workspace.lanes[editLaneId] : null;
    const facOpts = buildFactorySelectOptionsHtml(existing?.fromNodeId || "");
    const markets = Object.values(workspace.nodes).filter(n => n.kind === "market");
    if (!facOpts.total) { notify("No factories available. Add one in BOM or click Select Factory.", true); return; }
    if (!markets.length) { notify("Add at least one target market in Markets & Demand first.", true); openNewMarketDialog(); return; }
    openDialog({
      title: existing ? "Edit Logistics Lane" : "New Logistics Lane",
      submitLabel: "Save",
      bodyHtml: `
        <div class="form-grid">
          <label class="span-2"><span>Lane Name</span><input name="name" value="${esc(existing?.name || "")}" placeholder="e.g., Factory A → US (Ocean Express)" required></label>
          <label><span>Origin Factory</span>
            <select name="fromNodeId">${facOpts.html}</select>
          </label>
          <label><span>Target Market</span>
            <select name="toNodeId">${markets.map(m => `<option value="${m.id}" ${existing?.toNodeId === m.id ? "selected" : ""}>${esc(m.name)}</option>`).join("")}</select>
          </label>
          <label><span>Transport Mode</span>
            <select name="defaultMode">${WM.TRANSPORT_MODES.map(m => `<option value="${m.key}" ${(existing?.defaultMode || "sea") === m.key ? "selected" : ""}>${esc(m.label)}</option>`).join("")}</select>
          </label>
          <label><span>Carrier</span><input name="defaultCarrier" value="${esc(existing?.defaultCarrier || "")}"></label>
          <label><span>Est. Transit Days</span><input name="defaultTransitDays" type="number" min="0" value="${existing?.defaultTransitDays ?? 14}"></label>
          <label><span>Customs / Putaway (d)</span>
            <div style="display:flex;gap:6px">
              <input name="defaultCustomsWaitDays" type="number" min="0" value="${existing?.defaultCustomsWaitDays ?? 4}">
              <input name="defaultPutawayDays" type="number" min="0" value="${existing?.defaultPutawayDays ?? 2}">
            </div>
          </label>
          <label><span>Fixed Freight ($)</span><input name="defaultFixedCost" type="number" min="0" step="any" value="${existing?.defaultFixedCost ?? 2800}"></label>
          <label><span>Unit Freight ($)</span><input name="defaultUnitCost" type="number" min="0" step="any" value="${existing?.defaultUnitCost ?? 9.5}"></label>
          <label><span>Origin Port</span><input name="defaultOriginPort" value="${esc(existing?.defaultOriginPort || "")}"></label>
          <label><span>Destination Port</span><input name="defaultDestinationPort" value="${esc(existing?.defaultDestinationPort || "")}"></label>
        </div>`,
      onSubmit(fd) {
        const factory = planFactorySelection(fd.get("fromNodeId"));
        return dispatchWithFactory(factory, "lane.save", editLaneId || "", {
          name: fd.get("name"),
          fromNodeId: factory.nodeId,
          toNodeId: fd.get("toNodeId"),
          defaultMode: fd.get("defaultMode"),
          defaultCarrier: fd.get("defaultCarrier"),
          defaultTransitDays: fd.get("defaultTransitDays"),
          defaultCustomsWaitDays: fd.get("defaultCustomsWaitDays"),
          defaultPutawayDays: fd.get("defaultPutawayDays"),
          defaultFixedCost: fd.get("defaultFixedCost"),
          defaultUnitCost: fd.get("defaultUnitCost"),
          defaultOriginPort: fd.get("defaultOriginPort"),
          defaultDestinationPort: fd.get("defaultDestinationPort")
        }, { toast: "Lane saved" }).ok;
      }
    });
  }

  function openBatchAllocationShipmentDialog(prefill) {
    const p = prefill || {};
    const bat = workspace.batches[p.batchId];
    if (!bat) { notify("Selected batch does not exist", true); return; }
    const summary = Act.getBatchAllocationSummary(workspace, bat.id);
    const src = workspace.nodes[bat.sourceNodeId];
    const markets = Object.values(workspace.nodes).filter(n => n.kind === "market");
    if (!markets.length) { notify("Add at least one target market before scheduling a shipment", true); openNewMarketDialog(); return; }
    if (!summary || summary.totalQty <= 0) { notify("Batch quantity is 0; cannot allocate shipments", true); return; }
    if (summary.remainingQty <= 0) { notify(`Batch ${bat.code} is already 100% allocated`, true); return; }

    const lanes = Object.values(workspace.lanes || {}).filter(l => l.fromNodeId === bat.sourceNodeId);
    const allLanes = lanes.length ? lanes : Object.values(workspace.lanes || {});
    const defaultDepart = p.departDate || bat.availableDate || TS.addDaysToIso(currentSim.today, 2);

    const findLaneFor = (toId) =>
      lanes.find(l => l.toNodeId === toId) || allLanes.find(l => l.toNodeId === toId) || null;

    const makeRow = (toNodeId, pct) => {
      const lane = findLaneFor(toNodeId);
      return {
        toNodeId,
        pct: Math.round(Math.max(0, Number(pct) || 0) * 100) / 100,
        laneId: lane?.id || "",
        departDate: defaultDepart,
        mode: lane?.defaultMode || "sea",
        transitDays: lane?.defaultTransitDays ?? 14,
        carrier: lane?.defaultCarrier || "",
        fixedCost: lane?.defaultFixedCost ?? 2500,
        unitCost: lane?.defaultUnitCost ?? 9.5,
        customsWaitDays: lane?.defaultCustomsWaitDays ?? 4,
        putawayDays: lane?.defaultPutawayDays ?? 2,
        originPort: lane?.defaultOriginPort || "",
        destinationPort: lane?.defaultDestinationPort || "",
        note: ""
      };
    };

    const rows = [makeRow(p.toNodeId || markets[0].id, summary.remainingPct)];

    openDialog({
      title: `Schedule Batch Shipment · ${bat.code}`,
      subtitle: src?.name || "",
      submitLabel: "Create Shipment",
      wide: true,
      bodyHtml: `
        <div class="batch-alloc-summary" id="batchAllocSummary"></div>
        <div class="batch-alloc-rows" id="batchAllocRows"></div>
        <div class="batch-alloc-add-bar">
          <button type="button" class="btn small" id="addMarketAllocBtn">+ Add Market Allocation</button>
        </div>`,
      onSubmit() {
        const errEl = $("#dialogError");
        if (!rows.length) { errEl.textContent = "Keep at least one market allocation"; return false; }
        const pcts = rows.map(r => TS.requireAllocationPct(r.pct));
        const addedPct = pcts.reduce((a, b) => a + b, 0);
        if (summary.allocatedPct + addedPct > 100 + 1e-4) {
          errEl.textContent = `Total allocation (${(summary.allocatedPct + addedPct).toFixed(2)}%) exceeds 100%. Max remaining: ${summary.remainingPct}%`;
          return false;
        }
        const qtys = Act.computeProportionalQuantities(summary.totalQty, pcts, summary.remainingQty);
        for (let i = 0; i < qtys.length; i++) {
          if (qtys[i] <= 0) { errEl.textContent = `Row #${i + 1} evaluates to 0 units. Increase percentage or remove it.`; return false; }
        }
        const addedQty = qtys.reduce((a, b) => a + b, 0);
        if (summary.allocatedQty + addedQty > summary.totalQty + 1e-4) {
          errEl.textContent = `Total allocated quantity (${summary.allocatedQty + addedQty}) exceeds batch total (${summary.totalQty})`;
          return false;
        }

        const actionSpecs = rows.map((r, i) => ({
          type: "shipment.create",
          targetId: "",
          payload: {
            laneId: r.laneId || null,
            fromNodeId: bat.sourceNodeId,
            toNodeId: r.toNodeId,
            batchId: bat.id,
            allocationPct: pcts[i],
            departDate: r.departDate,
            qty: qtys[i],
            mode: r.mode,
            transitDays: r.transitDays,
            carrier: r.carrier,
            fixedCost: r.fixedCost,
            unitCost: r.unitCost,
            customsWaitDays: r.customsWaitDays,
            putawayDays: r.putawayDays,
            originPort: r.originPort,
            destinationPort: r.destinationPort,
            note: r.note
          }
        }));
        const res = dispatchBatch(actionSpecs, {
          toast: actionSpecs.length > 1 ? `Created ${actionSpecs.length} shipments for batch ${bat.code}` : "Shipment created"
        });
        if (!res.ok) {
          errEl.textContent = res.errors[0]?.message || "Validation failed";
          return false;
        }
        return true;
      }
    });

    const updateSummaryAndQtys = () => {
      const pcts = rows.map(r => Math.max(0, Number(r.pct) || 0));
      const addedPct = Math.round(pcts.reduce((a, b) => a + b, 0) * 100) / 100;
      const totalPct = Math.round((summary.allocatedPct + addedPct) * 100) / 100;
      const remPct = Math.round((100 - totalPct) * 100) / 100;
      const qtys = Act.computeProportionalQuantities(summary.totalQty, pcts, summary.remainingQty);
      const addedQty = qtys.reduce((a, b) => a + b, 0);
      const totalAllocQty = Math.round((summary.allocatedQty + addedQty) * 100) / 100;
      const remQty = Math.round((summary.totalQty - totalAllocQty) * 100) / 100;
      const over = totalPct > 100 + 1e-4 || remQty < -1e-4;

      rows.forEach((_, idx) => {
        const qEl = $(`[data-alloc-qty="${idx}"]`);
        if (qEl) qEl.textContent = `${fmtNum(qtys[idx])} units`;
      });

      const sumEl = $("#batchAllocSummary");
      if (sumEl) {
        sumEl.classList.toggle("is-over", over);
        sumEl.innerHTML = `
          <div class="alloc-metric"><span>Batch Total</span><b>${fmtNum(summary.totalQty)}</b></div>
          <div class="alloc-metric"><span>Previously Allocated</span><b>${fmtNum(summary.allocatedQty)} <small>(${summary.allocatedPct}%)</small></b></div>
          <div class="alloc-metric"><span>This Allocation</span><b>${fmtNum(addedQty)} <small>(${addedPct}%)</small></b></div>
          <div class="alloc-metric ${over ? "is-danger" : ""}"><span>Remaining</span><b>${fmtNum(Math.max(0, remQty))} <small>(${over ? `Over ${Math.abs(remPct).toFixed(1)}%` : `${Math.max(0, remPct)}%`})</small></b></div>`;
      }
      const errEl = $("#dialogError");
      if (errEl) {
        errEl.textContent = over ? `Total allocation (${totalPct}%) exceeds 100%. Adjust before submitting.` : "";
      }
    };

    const renderRows = () => {
      const box = $("#batchAllocRows");
      if (!box) return;
      box.innerHTML = rows.map((r, idx) => `
        <div class="alloc-row-card" data-alloc-idx="${idx}">
          <div class="alloc-row-head">
            <span class="alloc-row-index">#${idx + 1}</span>
            <label class="alloc-field-market">
              <span>Target Market</span>
              <select data-alloc-field="toNodeId">
                ${markets.map(m => `<option value="${esc(m.id)}" ${m.id === r.toNodeId ? "selected" : ""}>${esc(m.name)}</option>`).join("")}
              </select>
            </label>
            <label class="alloc-field-pct">
              <span>Allocation (%)</span>
              <input type="number" min="0.01" max="100" step="any" data-alloc-field="pct" value="${r.pct}" required>
            </label>
            <div class="alloc-field-qty">
              <span>Computed Qty</span>
              <strong data-alloc-qty="${idx}">0 units</strong>
            </div>
            ${rows.length > 1 ? `<button type="button" class="icon-btn alloc-remove-btn" data-remove-alloc="${idx}" title="Remove allocation" aria-label="Remove">✕</button>` : ""}
          </div>
          <div class="form-grid alloc-row-grid">
            <label><span>Saved Lane</span>
              <select data-alloc-field="laneId">
                <option value="">Custom</option>
                ${allLanes.map(l => `<option value="${esc(l.id)}" ${l.id === r.laneId ? "selected" : ""}>${esc(l.name)} · ${l.defaultTransitDays}d</option>`).join("")}
              </select>
            </label>
            <label><span>Dispatch Date</span><input type="date" data-alloc-field="departDate" value="${esc(r.departDate)}" required></label>
            <label><span>Transport Mode</span>
              <select data-alloc-field="mode">${WM.TRANSPORT_MODES.map(m => `<option value="${m.key}" ${r.mode === m.key ? "selected" : ""}>${esc(m.label)}</option>`).join("")}</select>
            </label>
            <label><span>Transit Days</span><input type="number" min="0" data-alloc-field="transitDays" value="${r.transitDays}" required></label>
            <label><span>Carrier</span><input data-alloc-field="carrier" value="${esc(r.carrier)}"></label>
            <label><span>Customs / Putaway (d)</span>
              <div style="display:flex;gap:6px">
                <input type="number" min="0" data-alloc-field="customsWaitDays" value="${r.customsWaitDays}">
                <input type="number" min="0" data-alloc-field="putawayDays" value="${r.putawayDays}">
              </div>
            </label>
            <label><span>Fixed Freight ($)</span><input type="number" min="0" step="any" data-alloc-field="fixedCost" value="${r.fixedCost}"></label>
            <label><span>Unit Freight ($)</span><input type="number" min="0" step="any" data-alloc-field="unitCost" value="${r.unitCost}"></label>
            <label><span>Origin Port</span><input data-alloc-field="originPort" value="${esc(r.originPort)}"></label>
            <label><span>Destination Port</span><input data-alloc-field="destinationPort" value="${esc(r.destinationPort)}"></label>
            <label class="span-2"><span>Notes</span><input data-alloc-field="note" value="${esc(r.note)}"></label>
          </div>
        </div>`).join("");
      updateSummaryAndQtys();
    };

    renderRows();

    const rowsEl = $("#batchAllocRows");
    rowsEl?.addEventListener("input", ev => {
      const card = ev.target.closest("[data-alloc-idx]");
      if (!card) return;
      const idx = Number(card.dataset.allocIdx);
      const field = ev.target.dataset.allocField;
      if (!field || !rows[idx]) return;
      rows[idx][field] = ev.target.value;
      if (field === "pct") updateSummaryAndQtys();
    });

    rowsEl?.addEventListener("change", ev => {
      const card = ev.target.closest("[data-alloc-idx]");
      if (!card) return;
      const idx = Number(card.dataset.allocIdx);
      const field = ev.target.dataset.allocField;
      if (!field || !rows[idx]) return;
      rows[idx][field] = ev.target.value;
      if (field === "laneId") {
        const l = workspace.lanes[ev.target.value];
        if (l) {
          rows[idx].toNodeId = l.toNodeId;
          rows[idx].mode = l.defaultMode;
          rows[idx].carrier = l.defaultCarrier || "";
          rows[idx].transitDays = l.defaultTransitDays;
          rows[idx].fixedCost = l.defaultFixedCost;
          rows[idx].unitCost = l.defaultUnitCost;
          rows[idx].customsWaitDays = l.defaultCustomsWaitDays;
          rows[idx].putawayDays = l.defaultPutawayDays;
          rows[idx].originPort = l.defaultOriginPort || "";
          rows[idx].destinationPort = l.defaultDestinationPort || "";
          renderRows();
        }
      } else if (field === "toNodeId") {
        const matchLane = findLaneFor(ev.target.value);
        if (matchLane && !rows[idx].laneId) {
          rows[idx].laneId = matchLane.id;
          rows[idx].mode = matchLane.defaultMode;
          rows[idx].carrier = matchLane.defaultCarrier || "";
          rows[idx].transitDays = matchLane.defaultTransitDays;
          rows[idx].fixedCost = matchLane.defaultFixedCost;
          rows[idx].unitCost = matchLane.defaultUnitCost;
          rows[idx].customsWaitDays = matchLane.defaultCustomsWaitDays;
          rows[idx].putawayDays = matchLane.defaultPutawayDays;
          rows[idx].originPort = matchLane.defaultOriginPort || "";
          rows[idx].destinationPort = matchLane.defaultDestinationPort || "";
          renderRows();
        }
      }
    });

    rowsEl?.addEventListener("click", ev => {
      const rm = ev.target.closest("[data-remove-alloc]");
      if (!rm || rows.length <= 1) return;
      rows.splice(Number(rm.dataset.removeAlloc), 1);
      renderRows();
    });

    $("#addMarketAllocBtn")?.addEventListener("click", () => {
      const used = new Set(rows.map(r => r.toNodeId));
      const nextMarket = markets.find(m => !used.has(m.id)) || markets[0];
      const usedPct = rows.reduce((s, r) => s + Math.max(0, Number(r.pct) || 0), 0);
      const leftPct = Math.max(0, Math.round((100 - summary.allocatedPct - usedPct) * 100) / 100);
      rows.push(makeRow(nextMarket.id, leftPct));
      renderRows();
    });
  }

  function openNewShipmentDialog(prefill) {
    const p = prefill || {};
    if (p.batchId && workspace.batches[p.batchId]) {
      openBatchAllocationShipmentDialog(p);
      return;
    }
    const markets = Object.values(workspace.nodes).filter(n => n.kind === "market");
    const lanes = Object.values(workspace.lanes || {});
    const batches = Object.values(workspace.batches || {});
    const lastShp = Object.values(workspace.shipments || {}).filter(s => s.status !== "cancelled").slice(-1)[0] || null;

    const initLane = lanes.find(l =>
      (!p.fromNodeId || l.fromNodeId === p.fromNodeId) &&
      (!p.toNodeId || l.toNodeId === p.toNodeId)
    ) || lanes[0] || null;

    const facOpts = buildFactorySelectOptionsHtml(p.fromNodeId || initLane?.fromNodeId || "");
    if (!facOpts.total) { notify("No factories available. Add one in BOM or click Select Factory.", true); return; }
    if (!markets.length) { notify("Add at least one target market before scheduling a shipment", true); openNewMarketDialog(); return; }

    const toId = p.toNodeId || initLane?.toNodeId || markets[0]?.id || "";

    openDialog({
      title: "New Shipment",
      submitLabel: "Create Shipment",
      wide: true,
      bodyHtml: `
        <div class="lane-quick-bar">
          <label style="flex:1;display:flex;flex-direction:column;gap:4px;font-size:11.5px;color:var(--muted)">
            <span>Saved Lane</span>
            <select name="laneId" data-lane-autofill="1">
              <option value="">Custom</option>
              ${lanes.map(l => `<option value="${l.id}" ${initLane?.id === l.id ? "selected" : ""}>${esc(l.name)} · ${l.defaultTransitDays}d</option>`).join("")}
            </select>
          </label>
          ${lastShp ? `<button type="button" class="btn small" style="align-self:flex-end" data-copy-last-shp="1">Clone ${esc(lastShp.code)}</button>` : ""}
        </div>

        <div class="form-grid" style="margin-top:12px">
          <label><span>Origin Factory</span>
            <select name="fromNodeId">${facOpts.html}</select>
          </label>
          <label><span>Target Market</span>
            <select name="toNodeId">${markets.map(m => `<option value="${m.id}" ${m.id === toId ? "selected" : ""}>${esc(m.name)}</option>`).join("")}</select>
          </label>
          <label><span>Dispatch Date</span><input name="departDate" type="date" value="${esc(p.departDate || TS.addDaysToIso(currentSim.today, 2))}" required></label>
          <label><span>Quantity</span><input name="qty" type="number" min="0.000001" step="any" value="${p.qty ?? 800}" required></label>
          <label><span>Transport Mode</span>
            <select name="mode">${WM.TRANSPORT_MODES.map(m => `<option value="${m.key}" ${(initLane?.defaultMode || "sea") === m.key ? "selected" : ""}>${esc(m.label)}</option>`).join("")}</select>
          </label>
          <label><span>Transit Days</span><input name="transitDays" type="number" min="0" value="${initLane?.defaultTransitDays ?? 14}" required></label>
          <label><span>Carrier</span><input name="carrier" value="${esc(initLane?.defaultCarrier || "")}"></label>
          <label><span>Source Batch</span>
            <select name="batchId">
              <option value="">None</option>
              ${batches.map(b => `<option value="${b.id}" ${p.batchId === b.id ? "selected" : ""}>${esc(b.code)} (${b.availableDate})</option>`).join("")}
            </select>
          </label>
          <label><span>Fixed Freight ($)</span><input name="fixedCost" type="number" min="0" step="any" value="${initLane?.defaultFixedCost ?? 2500}"></label>
          <label><span>Unit Freight ($)</span><input name="unitCost" type="number" min="0" step="any" value="${initLane?.defaultUnitCost ?? 9.5}"></label>
          <label><span>Customs Days</span><input name="customsWaitDays" type="number" min="0" value="${initLane?.defaultCustomsWaitDays ?? 4}"></label>
          <label><span>Putaway Days</span><input name="putawayDays" type="number" min="0" value="${initLane?.defaultPutawayDays ?? 2}"></label>
          <label><span>Origin Port</span><input name="originPort" value="${esc(initLane?.defaultOriginPort || "")}"></label>
          <label><span>Destination Port</span><input name="destinationPort" value="${esc(initLane?.defaultDestinationPort || "")}"></label>
          <label class="span-2"><span>Notes</span><input name="note"></label>
        </div>`,
      onSubmit(fd) {
        const factory = planFactorySelection(fd.get("fromNodeId"));
        return dispatchWithFactory(factory, "shipment.create", "", {
          laneId: fd.get("laneId") || null,
          fromNodeId: factory.nodeId,
          toNodeId: fd.get("toNodeId"),
          departDate: fd.get("departDate"),
          qty: fd.get("qty"),
          mode: fd.get("mode"),
          transitDays: fd.get("transitDays"),
          carrier: fd.get("carrier"),
          batchId: fd.get("batchId") || null,
          fixedCost: fd.get("fixedCost"),
          unitCost: fd.get("unitCost"),
          customsWaitDays: fd.get("customsWaitDays"),
          putawayDays: fd.get("putawayDays"),
          originPort: fd.get("originPort"),
          destinationPort: fd.get("destinationPort"),
          note: fd.get("note")
        }, { toast: "Shipment created" }).ok;
      }
    });

    const form = $("#dialogForm");
    const setVal = (name, val) => { const el = form.querySelector(`[name="${name}"]`); if (el && val !== undefined) el.value = val; };
    form.querySelector("[data-lane-autofill]")?.addEventListener("change", e => {
      const l = workspace.lanes[e.target.value];
      if (!l) return;
      setVal("fromNodeId", l.fromNodeId);
      setVal("toNodeId", l.toNodeId);
      setVal("mode", l.defaultMode);
      setVal("carrier", l.defaultCarrier);
      setVal("transitDays", l.defaultTransitDays);
      setVal("fixedCost", l.defaultFixedCost);
      setVal("unitCost", l.defaultUnitCost);
      setVal("customsWaitDays", l.defaultCustomsWaitDays);
      setVal("putawayDays", l.defaultPutawayDays);
      setVal("originPort", l.defaultOriginPort);
      setVal("destinationPort", l.defaultDestinationPort);
    });
    form.querySelector("[data-copy-last-shp]")?.addEventListener("click", () => {
      if (!lastShp) return;
      setVal("fromNodeId", lastShp.fromNodeId);
      setVal("toNodeId", lastShp.toNodeId);
      setVal("mode", lastShp.mode);
      setVal("carrier", lastShp.carrier);
      setVal("transitDays", lastShp.transitDays);
      setVal("fixedCost", lastShp.fixedCost);
      setVal("unitCost", lastShp.unitCost);
      setVal("customsWaitDays", lastShp.customsWaitDays);
      setVal("putawayDays", lastShp.putawayDays);
      setVal("originPort", lastShp.originPort);
      setVal("destinationPort", lastShp.destinationPort);
      setVal("qty", lastShp.qty);
    });
  }

  function openNewBatchDialog(nodeId, startDate, endDate, estQty) {
    const facOpts = buildFactorySelectOptionsHtml(nodeId || ui.supplyNodeId || "");
    if (!facOpts.total) { notify("No factories available. Select or add a factory first.", true); openFactoryPickerDialog(); return; }
    const sDate = startDate || currentSim.today;
    const eDate = endDate || TS.addDaysToIso(sDate, 10);
    openDialog({
      title: "New Production Batch",
      submitLabel: "Create",
      bodyHtml: `
        <div class="form-grid">
          <label class="span-2"><span>Factory</span>
            <select name="sourceNodeId">${facOpts.html}</select>
          </label>
          <label><span>Start Date</span><input name="startDate" type="date" value="${esc(sDate)}" required></label>
          <label><span>End Date</span><input name="endDate" type="date" value="${esc(eDate)}" required></label>
          <label><span>Extra Wait (d)</span><input name="extraWaitDays" type="number" min="0" value="2"></label>
          <label><span>Batch Code</span><input name="code" placeholder="Auto-generated"></label>
          ${estQty !== undefined ? `<div class="muted small span-2">Est. Total ${fmtNum(estQty)} units</div>` : ""}
        </div>`,
      onSubmit(fd) {
        const factory = planFactorySelection(fd.get("sourceNodeId"));
        // Reset selection before rerendering, restoring it on validation failure.
        const previousBrush = ui.tsState.brush;
        ui.tsState.brush = null;
        const r = dispatchWithFactory(factory, "batch.createFromInterval", factory.nodeId, {
          startDate: fd.get("startDate"),
          endDate: fd.get("endDate"),
          extraWaitDays: fd.get("extraWaitDays") ?? undefined,
          code: fd.get("code") || undefined
        }, { toast: "Batch created" });
        if (!r.ok) ui.tsState.brush = previousBrush;
        return r.ok;
      }
    });
  }

  function openSegmentDialog(curveId, startDate, endDate, area) {
    openDialog({
      title: "Range Total Mode",
      submitLabel: "Apply",
      bodyHtml: `
        <div class="form-grid">
          <label><span>Start Date</span><input name="startDate" type="date" value="${esc(startDate)}" required></label>
          <label><span>End Date</span><input name="endDate" type="date" value="${esc(endDate)}" required></label>
          <label><span>Range Total</span><input name="totalQty" type="number" min="0" step="any" value="${area}" required></label>
          <label><span>Distribution</span>
            <select name="distribution">
              <option value="uniform">Uniform</option>
              <option value="custom">Custom Shape</option>
            </select>
          </label>
        </div>`,
      onSubmit(fd) {
        const r = dispatch("timeseries.segment.setMode", curveId, {
          mode: "total",
          startDate: fd.get("startDate"),
          endDate: fd.get("endDate"),
          totalQty: fd.get("totalQty"),
          distribution: fd.get("distribution")
        }, { toast: "Range total applied" });
        if (r.ok) ui.tsState.brush = null;
        return r.ok;
      }
    });
  }

  function openDailyCsvDialog(curveId) {
    const sku = workspace.activeProductId || "";
    openDialog({
      title: "Import Daily CSV",
      submitLabel: "Import",
      bodyHtml: `
        <div class="form-grid">
          <label class="span-2"><span>CSV File</span><input type="file" accept=".csv,text/csv" data-csv-file="1"></label>
          <label class="span-2"><span>Content (date, sku, qty)</span><textarea name="csvText" rows="6" style="font-family:var(--mono);font-size:11.5px" placeholder="date,sku,qty"></textarea></label>
        </div>`,
      onSubmit(fd) {
        return dispatch("timeseries.importCsv", curveId, { csvText: fd.get("csvText"), expectedSku: sku || undefined }, { toast: "CSV imported" }).ok;
      }
    });
    const fIn = $("#dialogBody [data-csv-file]"), area = $("#dialogBody textarea[name='csvText']");
    fIn?.addEventListener("change", () => {
      const f = fIn.files?.[0];
      if (!f) return;
      const r = new FileReader();
      r.onload = () => { if (area) area.value = String(r.result || ""); };
      r.readAsText(f);
    });
  }

  function openShipmentsCsvDialog() {
    openDialog({
      title: "Import Shipments CSV",
      submitLabel: "Import",
      bodyHtml: `
        <div class="form-grid">
          <label class="span-2"><span>CSV File</span><input type="file" accept=".csv,text/csv" data-csv-file="1"></label>
          <label class="span-2"><span>Content</span><textarea name="csvText" rows="6" style="font-family:var(--mono);font-size:11.5px" placeholder="from,to,depart_date,qty,mode,transit_days,carrier"></textarea></label>
        </div>`,
      onSubmit(fd) {
        return dispatch("shipment.batchImport", "", { csvText: fd.get("csvText") }, { toast: "Shipments imported" }).ok;
      }
    });
    const fIn = $("#dialogBody [data-csv-file]"), area = $("#dialogBody textarea[name='csvText']");
    fIn?.addEventListener("change", () => {
      const f = fIn.files?.[0];
      if (!f) return;
      const r = new FileReader();
      r.onload = () => { if (area) area.value = String(r.result || ""); };
      r.readAsText(f);
    });
  }

  /* =========================================================================
     SURGICAL RENDERING (ZERO SCROLL JUMP!)
     ========================================================================= */
  function buildViewCtx() {
    return {
      workspace,
      simulation: currentSim,
      ui,
      bomFactories,
      tsHooks: {
        workspace,
        today: currentSim.today,
        editorState: ui.tsState,
        onDispatch: (type, tid, payload) => dispatch(type, tid, payload),
        onOpenCsvImport: cid => openDailyCsvDialog(cid),
        onCreateBatchFromRange: (nid, s, e, qty) => openNewBatchDialog(nid, s, e, qty),
        onOpenSegmentDialog: (cid, s, e, area) => openSegmentDialog(cid, s, e, area),
        onLocalRefresh: () => renderMain({ preserveViewShell: true })
      },
      onUpdateLogiFilter: patch => {
        Object.assign(ui.logiFilter, patch);
        renderMain({ preserveViewShell: true });
      },
      onOpenTarget: (kind, id) => {
        ui.panel = { kind, id };
        renderDrawer(); // ONLY opens drawer — NEVER rebuilds #main or resets scroll!
      }
    };
  }

  function renderAppbar() {
    const prod = workspace.products[workspace.activeProductId] || Object.values(workspace.products)[0] || null;
    document.querySelectorAll(".mainnav [data-nav]").forEach(btn => {
      btn.classList.toggle("active", btn.dataset.nav === ui.view);
    });
    const skuPill = $("#brandSku");
    if (skuPill) skuPill.textContent = prod ? `${prod.name} · ${prod.skuCode}` : "No Product";
    $("#undoBtn").disabled = undoStack.length === 0;
    $("#redoBtn").disabled = redoStack.length === 0;

    const facCount = Object.values(workspace.nodes).filter(n => n.kind === "source").length;
    const mktCount = Object.values(workspace.nodes).filter(n => n.kind === "market").length;
    const shpCount = Object.values(workspace.shipments).filter(s => s.status !== "cancelled").length;
    $("#status").textContent = `${facCount} Factories · ${mktCount} Markets · ${shpCount} Shipments`;
    const statusHint = $("#statusHint");
    if (statusHint) {
      if (storageError) statusHint.textContent = `Storage read failed: ${storageError}`;
      else statusHint.textContent = currentSim.kpis.pendingExceptionsCount > 0
        ? `${currentSim.kpis.pendingExceptionsCount} Exceptions · ${currentSim.today}`
        : currentSim.today;
    }
  }

  function renderMain(opts) {
    Views.renderView($("#main"), ui.view, buildViewCtx(), !opts?.preserveViewShell);
  }

  function renderDrawer() {
    const layer = $("#panelLayer");
    const panelEl = $("#panel");
    if (!ui.panel) {
      layer.classList.add("hidden");
      layer.setAttribute("aria-hidden", "true");
      panelEl.innerHTML = "";
      if (global.SalesHostBridge?.postToShell) {
        global.SalesHostBridge.postToShell("sc:entity-cleared", { module: "sales" });
      }
      return;
    }
    if (global.SalesHostBridge?.postToShell) {
      if (ui.panel.kind === "shipment" && workspace.shipments[ui.panel.id]) {
        global.SalesHostBridge.postToShell("sc:entity-visited", { kind: "shipment", id: ui.panel.id, name: workspace.shipments[ui.panel.id].code || ui.panel.id });
      } else if (ui.panel.kind === "node" && workspace.nodes[ui.panel.id]?.kind === "market") {
        global.SalesHostBridge.postToShell("sc:entity-visited", { kind: "market", id: ui.panel.id, name: workspace.nodes[ui.panel.id].name });
      } else {
        global.SalesHostBridge.postToShell("sc:entity-cleared", { module: "sales" });
      }
    }
    layer.classList.remove("hidden");
    layer.setAttribute("aria-hidden", "false");
    Inspector.renderPanel(panelEl, {
      workspace,
      simulation: currentSim,
      bomCatalog,
      panel: ui.panel,
      onClose: () => { ui.panel = null; renderDrawer(); },
      onDispatch: (type, tid, payload, o) => dispatch(type, tid, payload, o),
      onOpenNewShipment: pre => openNewShipmentDialog(pre),
      onOpenNewLane: id => openLaneDialog(id),
      onOpenBomDrawer: () => { ui.panel = { kind: "bom" }; renderDrawer(); },
      onSyncBom: () => {
        bomCatalog = WM.readLinkedBomCatalog({ allowBuiltinFallback: workspace.dataSourceMode === "demo" });
        refreshBomFactoryList();
        const rawBom = workspace.dataSourceMode === "demo" ? null : WM.readRawBomFromStorage();
        const synced = WM.syncLinkedBomFactoryNames(WM.clone(workspace), bomFactories, rawBom);
        if (synced.changed) {
          if (!saveWorkspace(synced.workspace)) return;
          recomputeSim();
        }
        renderAll({ preserveViewShell: true });
        notify("Synced BOM assembly factories (read-only)");
      },
      onImportBom: () => $("#importBomInput")?.click(),
      onEditProductSku: () => openProductSkuDialog(),
      onOpenBomModule: () => {
        if (global.SalesHostBridge?.isEmbedded) {
          global.SalesHostBridge.postToShell("sc:navigate-shell", { route: "bom" });
        } else {
          global.open("../bom/index.html", "_blank", "noopener");
        }
      },
      onEditMfgCost: () => {
        const prod = workspace.products[workspace.activeProductId];
        if (!prod) { openProductSkuDialog(); return; }
        const v = prompt(`Set unit manufacturing cost ($) for "${prod.name}":`, String(prod.unitManufacturingCost));
        if (v !== null) {
          dispatch("workspace.settings.update", "", { unitManufacturingCost: v }, { toast: "Unit manufacturing cost updated" });
        }
      }
    });
  }

  function renderAll(opts) {
    if (!currentSim) recomputeSim();
    renderAppbar();
    renderMain(opts);
    renderDrawer();
  }

  /* =========================================================================
     GLOBAL EVENT DELEGATION
     ========================================================================= */
  document.addEventListener("click", ev => {
    if (ui.moreOpen && !ev.target.closest(".menu-anchor")) {
      ui.moreOpen = false;
      $("#moreMenu")?.classList.add("hidden");
    }

    if (ev.target.closest("[data-close-dialog]")) { closeDialog(); return; }
    if (ev.target.closest("[data-close-panel]")) { ui.panel = null; renderDrawer(); return; }

    // Top navigation & in-page jump links
    const navBtn = ev.target.closest("[data-nav], [data-nav-jump]");
    if (navBtn) {
      const nextView = navBtn.dataset.nav || navBtn.dataset.navJump;
      if (nextView !== ui.view) {
        ui.view = nextView;
        renderAppbar();
        renderMain({ preserveViewShell: false });
      }
      return;
    }

    // Open contextual drawer without touching #main scroll!
    const dupShpBtn = ev.target.closest("[data-dup-shipment]");
    if (dupShpBtn) {
      ev.stopPropagation();
      dispatch("shipment.duplicate", dupShpBtn.dataset.dupShipment, { departDate: TS.addDaysToIso(currentSim.today, 3) }, { toast: "Shipment cloned" });
      return;
    }

    const shipBatchBtn = ev.target.closest("[data-quick-ship-batch]");
    if (shipBatchBtn) {
      ev.stopPropagation();
      openNewShipmentDialog({
        fromNodeId: shipBatchBtn.dataset.nodeId,
        batchId: shipBatchBtn.dataset.quickShipBatch,
        departDate: shipBatchBtn.dataset.availDate,
        qty: Math.max(1, Number(shipBatchBtn.dataset.remQty))
      });
      return;
    }

    const targetEl = ev.target.closest("[data-open-target]");
    if (targetEl) {
      const [kind, id] = targetEl.dataset.openTarget.split(":");
      ui.panel = { kind, id };
      renderDrawer();
      if (global.SalesHostBridge?.postToShell) {
        if (kind === "shipment" && workspace.shipments[id]) {
          global.SalesHostBridge.postToShell("sc:entity-visited", { kind: "shipment", id, name: workspace.shipments[id].code || id });
        } else if (kind === "node" && workspace.nodes[id]?.kind === "market") {
          global.SalesHostBridge.postToShell("sc:entity-visited", { kind: "market", id, name: workspace.nodes[id].name });
        }
      }
      return;
    }

    const pickSupply = ev.target.closest("[data-pick-supply]");
    if (pickSupply) {
      ui.supplyNodeId = pickSupply.dataset.pickSupply;
      renderMain({ preserveViewShell: true });
      return;
    }

    const adoptBomFac = ev.target.closest("[data-adopt-bom-factory]");
    if (adoptBomFac) {
      adoptBomFactory(adoptBomFac.dataset.adoptBomFactory);
      return;
    }

    const pickMarket = ev.target.closest("[data-pick-market]");
    if (pickMarket) {
      ui.marketNodeId = pickMarket.dataset.pickMarket;
      renderMain({ preserveViewShell: true });
      return;
    }

    const logiStatusBtn = ev.target.closest("[data-logi-status]");
    if (logiStatusBtn) {
      ui.logiFilter.status = logiStatusBtn.dataset.logiStatus;
      renderMain({ preserveViewShell: true });
      return;
    }

    if (ev.target.closest("[data-toggle-adv]")) {
      ui.logiFilter.advOpen = !ui.logiFilter.advOpen;
      renderMain({ preserveViewShell: true });
      return;
    }

    if (ev.target.closest("[data-reset-logi-filters]")) {
      const keepOpen = ui.logiFilter.advOpen;
      ui.logiFilter = { ...defaultLogiFilter(), advOpen: keepOpen };
      renderMain({ preserveViewShell: true });
      return;
    }

    const presetBtn = ev.target.closest("[data-elapsed-preset]");
    if (presetBtn) {
      const [lo, hi] = presetBtn.dataset.elapsedPreset.split(",");
      if (String(ui.logiFilter.elapsedMin) === lo && String(ui.logiFilter.elapsedMax) === hi) {
        ui.logiFilter.elapsedMin = "";
        ui.logiFilter.elapsedMax = "";
      } else {
        ui.logiFilter.elapsedMin = lo;
        ui.logiFilter.elapsedMax = hi;
      }
      renderMain({ preserveViewShell: true });
      return;
    }

    const stocktakeBtn = ev.target.closest("[data-quick-stocktake]");
    if (stocktakeBtn) {
      const nid = stocktakeBtn.dataset.quickStocktake;
      const node = workspace.nodes[nid];
      if (!node) return;
      const snap = currentSim.nodeDaily[nid]?.[currentSim.todayIdx] || {};
      const qtyStr = prompt(`${node.name} — Actual available inventory today (${currentSim.today}):`, String(Math.round(snap.endingAvailable || 0)));
      if (qtyStr === null) return;
      dispatch("event.record", nid, {
        kind: "inventory_stocktake", date: currentSim.today, qty: qtyStr, note: "Stocktake adjustment"
      }, { toast: "Stocktake inventory updated" });
      return;
    }

    const actBtn = ev.target.closest("[data-app-action]");
    if (!actBtn) return;
    const act = actBtn.dataset.appAction;

    if (act === "undo") undo();
    else if (act === "redo") redo();
    else if (act === "toggle-more") {
      ui.moreOpen = !ui.moreOpen;
      $("#moreMenu")?.classList.toggle("hidden", !ui.moreOpen);
    }
    else if (act === "new-shipment-to-market") openNewShipmentDialog({ toNodeId: actBtn.dataset.marketId });
    else if (act === "pick-factory") openFactoryPickerDialog();
    else if (act === "new-batch") openNewBatchDialog(ui.supplyNodeId);
    else if (act === "add-market") openNewMarketDialog();
    else if (act === "edit-active-market") {
      if (!ui.marketNodeId || !workspace.nodes[ui.marketNodeId]) { notify("Add at least one target market first"); openNewMarketDialog(); }
      else { ui.panel = { kind: "node", id: ui.marketNodeId }; renderDrawer(); }
    }
    else if (act === "edit-product-sku") openProductSkuDialog();
    else if (act === "open-lanes") { ui.panel = { kind: "lanes" }; renderDrawer(); }
    else if (act === "open-bom") { ui.panel = { kind: "bom" }; renderDrawer(); }
    else if (act === "open-facts") { ui.panel = { kind: "facts" }; renderDrawer(); }
    else if (act === "import-shipments-csv") openShipmentsCsvDialog();
    else if (act === "dismiss-migration") dispatch("workspace.settings.update", "", { dismissMigrationNotice: true }, { skipUndo: true });
    else if (act === "load-demo") global.SC.AppBridge.loadDemoDirect();
    else if (act === "new-blank-live") {
      try {
        const next = WM.createLiveWorkspaceFromShared(readSharedRegistry(), WM.readRawBomFromStorage());
        const catalog = WM.readLinkedBomCatalog({ allowBuiltinFallback: false });
        if (replaceWorkspace(next, { catalog })) notify("Created blank workspace");
      } catch (err) { notify(err.message, true); }
    }
    else if (act === "export-world") {
      const blob = new Blob([JSON.stringify(workspace, null, 2)], { type: "application/json;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `sales-supply-chain-${workspace.activeProductId || "workspace"}-${currentSim.today}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1500);
      notify("Exported backup (JSON)");
    }
    else if (act === "import-world") $("#importWorldInput")?.click();
    else if (act === "import-bom") $("#importBomInput")?.click();
  });

  // Dashboard filters & Logistics live search (surgical updates — NEVER resets scroll or blurs input!)
  document.addEventListener("change", ev => {
    const df = ev.target.closest("[data-dash-filter]");
    if (df) {
      const kind = df.dataset.dashFilter;
      if (kind === "factory") { ui.dashFactory = df.value; renderMain({ preserveViewShell: true }); }
      else if (kind === "market") { ui.dashMarket = df.value; renderMain({ preserveViewShell: true }); }
      else if (kind === "horizon") {
        dispatch("workspace.settings.update", "", { viewHorizonDays: df.value }, { skipUndo: true });
      }
      return;
    }
    const advEl = ev.target.closest("[data-logi-adv]");
    if (advEl) {
      ui.logiFilter[advEl.dataset.logiAdv] = advEl.value;
      renderMain({ preserveViewShell: true });
    }
  });

  document.addEventListener("input", ev => {
    if (ev.target.matches("[data-logi-search]")) {
      ui.logiFilter.query = ev.target.value;
      renderMain({ preserveViewShell: true });
    } else if (ev.target.matches("[data-logi-adv='elapsedMin'], [data-logi-adv='elapsedMax']")) {
      ui.logiFilter[ev.target.dataset.logiAdv] = ev.target.value;
      renderMain({ preserveViewShell: true });
    }
  });

  $("#dialogForm")?.addEventListener("submit", ev => {
    ev.preventDefault();
    if (!dialogSubmitHandler) { closeDialog(); return; }
    try {
      const ok = dialogSubmitHandler(new FormData(ev.target));
      if (ok !== false) closeDialog();
    } catch (err) {
      $("#dialogError").textContent = err.message || String(err);
    }
  });

  $("#importWorldInput")?.addEventListener("change", ev => {
    const f = ev.target.files?.[0];
    if (!f) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const rawText = String(reader.result || "");
        const parsed = JSON.parse(rawText);
        const next = WM.validateWorkspace(parsed, { backupKey: WM.LEGACY_V1_BACKUP_KEY });
        const commitImport = (forceOverwrite = false) => {
          if (!replaceWorkspace(next, { restoreBackup: true, forceOverwrite })) return false;
          if (parsed.version === 1) {
            try { localStorage.setItem(WM.LEGACY_V1_BACKUP_KEY, rawText); } catch (_) {}
          }
          notify(workspace.migrationNotice ? "Migrated legacy V1 backup" : "Backup imported");
          return true;
        };
        try {
          commitImport(false);
        } catch (replaceErr) {
          openDialog({
            title: "Overwrite Sales Data",
            subtitle: f.name || "",
            submitLabel: "Overwrite",
            bodyHtml: `<p class="small">This workspace contains confirmed records. Importing will overwrite all current Sales data.</p>`,
            onSubmit() {
              try {
                return commitImport(true);
              } catch (err) {
                notify(err.message, true);
                return false;
              }
            }
          });
        }
      } catch (err) {
        notify(err.message, true);
      }
    };
    reader.readAsText(f);
    ev.target.value = "";
  });

  $("#importBomInput")?.addEventListener("change", ev => {
    const f = ev.target.files?.[0];
    if (!f) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const cat = WM.extractBomCatalog(JSON.parse(String(reader.result || "")), `imported:${f.name}`);
        if (!cat) throw new Error("Please select a valid BOM JSON export (format: bom-flow)");
        const next = WM.clone(workspace);
        const p = cat.products[0];
        if (p) {
          next.products[p.skuCode] = {
            productId: p.skuCode, skuCode: p.skuCode, name: p.name, unit: p.unit || "units",
            bomDiagramId: p.diagramId, bomMaterialId: p.materialId, bomVersion: p.bomVersion,
            unitManufacturingCost: workspace.products[workspace.activeProductId]?.unitManufacturingCost ?? 185,
            costSource: "bom_linked", note: p.note || ""
          };
          next.activeProductId = p.skuCode;
        }
        if (!saveWorkspace(next)) return;
        bomCatalog = cat;
        renderAll({ preserveViewShell: true });
        notify(`Linked BOM file "${f.name}" (read-only)`);
      } catch (err) { notify(err.message, true); }
    };
    reader.readAsText(f);
    ev.target.value = "";
  });

  document.addEventListener("keydown", ev => {
    const inField = ev.target.matches("input, textarea, select");
    if ((ev.metaKey || ev.ctrlKey) && ev.key.toLowerCase() === "z" && !inField) {
      ev.preventDefault();
      if (ev.shiftKey) redo(); else undo();
    } else if (ev.key === "Escape") {
      if (ui.panel) { ui.panel = null; renderDrawer(); }
      else if (ui.moreOpen) { ui.moreOpen = false; $("#moreMenu")?.classList.add("hidden"); }
    }
  });

  // Preserve clean programmatic API for future AI layer & unified host bridge
  global.SC.App = {
    getWorkspace: () => workspace,
    dispatch,
    simulateActions: (actions) => Act.simulateActions(workspace, actions),
    queryWorldState: () => Act.queryWorldState(workspace),
    listAvailableActions: (tid) => Act.listAvailableActions(workspace, tid),
    queryShipments: (filters) => Sim.queryShipments(workspace, currentSim, filters)
  };

  global.SC.AppBridge = {
    reloadFromStorage() {
      bomCatalog = WM.readLinkedBomCatalog({ allowBuiltinFallback: false });
      refreshBomFactoryList();
      const next = loadInitialWorkspace(workspace);
      if (storageError) {
        renderAppbar();
        notify(`Failed to read local data: ${storageError}`, true);
        global.SalesHostBridge?.postToShell?.("sc:save-status", { ok: false, message: "Sales storage read error" });
        return false;
      }
      closeDialog();
      workspace = next;
      undoStack = [];
      redoStack = [];
      ui.panel = null;
      recomputeSim();
      renderAll({ preserveViewShell: false });
      const saveState = $("#saveState");
      if (saveState) {
        saveState.textContent = savedWorkspaceText === null ? "Empty" : "Saved locally";
        saveState.classList.remove("is-error");
      }
      global.SalesHostBridge?.postToShell?.("sc:save-status", { ok: true });
      return true;
    },
    syncShared() {
      // The shell may have been hidden while another tab or the AI updated Sales.
      // Reload the authoritative workspace before applying shared-entity changes.
      try {
        if (localStorage.getItem(WM.WORLD_STORAGE_KEY) !== savedWorkspaceText || storageError) {
          return this.reloadFromStorage();
        }
      } catch (err) {
        notify("Unable to read local data", true);
        return false;
      }
      bomCatalog = WM.readLinkedBomCatalog({ allowBuiltinFallback: workspace.dataSourceMode === "demo" });
      const prevSig = JSON.stringify(bomFactories);
      refreshBomFactoryList();
      const listChanged = JSON.stringify(bomFactories) !== prevSig;
      const rawBom = workspace.dataSourceMode === "demo" ? null : WM.readRawBomFromStorage();
      const synced = workspace.dataSourceMode === "demo"
        ? { workspace, changed: false }
        : WM.syncLinkedBomFactoryNames(WM.clone(workspace), bomFactories, rawBom);
      if (synced.changed) {
        // 仅当本机已有销售记录时才持久化更名，避免空白首次打开写入存储
        if (savedWorkspaceText !== null) {
          if (!saveWorkspace(synced.workspace)) return false;
        } else {
          workspace = synced.workspace;
        }
        recomputeSim();
      }
      if (synced.changed || listChanged) {
        renderAll({ preserveViewShell: true });
      }
      return synced.changed || listChanged;
    },
    navigateView(viewName) {
      if (["dashboard", "supply", "logistics", "market"].includes(viewName)) {
        ui.view = viewName;
        renderAll({ preserveViewShell: false });
      }
    },
    focusFactory(sharedFactoryId) {
      this.syncShared();
      const target = Object.values(workspace.nodes).find(
        n => n.kind === "source" && (n.sharedFactoryId === sharedFactoryId || n.id === sharedFactoryId || n.bomFactoryId === sharedFactoryId)
      );
      ui.view = "supply";
      if (target) ui.supplyNodeId = target.id;
      renderAll({ preserveViewShell: false });
    },
    focusMarket(marketId) {
      this.syncShared();
      ui.view = "market";
      if (marketId && workspace.nodes[marketId]?.kind === "market") {
        ui.marketNodeId = marketId;
      }
      ui.panel = null;
      renderAll({ preserveViewShell: false });
    },
    openShipment(shipmentId) {
      this.syncShared();
      ui.view = "logistics";
      ui.panel = shipmentId && workspace.shipments[shipmentId] ? { kind: "shipment", id: shipmentId } : null;
      renderAll({ preserveViewShell: false });
    },
    loadDemoDirect() {
      try {
        const catalog = WM.readLinkedBomCatalog({ allowBuiltinFallback: true });
        if (!replaceWorkspace(Demo.createDemoWorkspace(catalog), { catalog })) return false;
        notify("Loaded demo dataset");
        return true;
      } catch (err) {
        notify(err.message, true);
        return false;
      }
    }
  };

  recomputeSim();
  renderAll({ preserveViewShell: false });
})(typeof globalThis !== "undefined" ? globalThis : this);
