(function (global) {
  "use strict";

  const MUTATIONS_VERSION = "1.0";

  const WORK_MODES = Object.freeze({
    READ_ONLY: "read_only",
    AUTHORIZED_WRITE: "authorized_write"
  });

  const SUPPORTED_OPERATIONS = Object.freeze({
    SHIPMENT_ADJUST_ETA: "shipment.adjust_eta",
    SHIPMENT_UPDATE_SCHEDULE: "shipment.update_schedule",
    BOM_UPDATE_COMPLIANCE: "bom.update_compliance"
  });

  const BLOCKED_HIGH_RISK_OPERATIONS = new Set([
    "shipment.cancel", "shipment.delete", "batch.delete", "node.delete",
    "company.delete", "factory.delete", "diagram.delete",
    "event.record", "fact.modify", "fact.delete", "bulk.update"
  ]);

  function getStore() {
    if (global.SCDataStore) return global.SCDataStore;
    if (typeof require === "function") return require("../storage/data-store.js");
    return null;
  }

  function getWM() {
    if (global.SC?.WorldModel) return global.SC.WorldModel;
    if (typeof require === "function") return require("../modules/sales/js/world-model.js");
    return null;
  }

  function getAct() {
    if (global.SC?.Actions) return global.SC.Actions;
    if (typeof require === "function") return require("../modules/sales/js/actions.js");
    return null;
  }

  function getTS() {
    if (global.SC?.TimeSeries) return global.SC.TimeSeries;
    if (typeof require === "function") return require("../modules/sales/js/timeseries.js");
    return null;
  }

  function getAuditMod() {
    if (global.SCAIAudit) return global.SCAIAudit;
    if (typeof require === "function") return require("./ai-audit.js");
    return null;
  }

  function clone(v) {
    return JSON.parse(JSON.stringify(v));
  }

  function genGrantId() {
    return `grant_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
  }

  function defaultStorage() {
    return typeof localStorage !== "undefined" ? localStorage : null;
  }

  function readSalesWorkspace(storage) {
    const WM = getWM();
    const Store = getStore();
    if (!storage || !WM) return null;
    const raw = storage.getItem(Store ? Store.STORAGE_KEYS.SALES : "sc-sales-world-v2")
      || storage.getItem(Store ? Store.STORAGE_KEYS.SALES_LEGACY : "sc-sales-world-v1");
    if (!raw) return null;
    return WM.validateWorkspace(JSON.parse(raw));
  }

  function writeSalesWorkspace(storage, ws) {
    const Store = getStore();
    const key = Store ? Store.STORAGE_KEYS.SALES : "sc-sales-world-v2";
    getWM().assertBusinessData(ws, { projected: true });
    storage.setItem(key, JSON.stringify(ws));
    if (Store && typeof Store.rebuildManifest === "function") {
      Store.rebuildManifest(storage);
    }
  }

  function readBomState(storage) {
    const Store = getStore();
    if (!storage) return null;
    const raw = storage.getItem(Store ? Store.STORAGE_KEYS.BOM : "bom-flow-sim-v5");
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (typeof global.validateState === "function") {
      return global.validateState(parsed);
    }
    return parsed;
  }

  function writeBomState(storage, bom) {
    const Store = getStore();
    const key = Store ? Store.STORAGE_KEYS.BOM : "bom-flow-sim-v5";
    storage.setItem(key, JSON.stringify(bom));
    if (Store && typeof Store.rebuildManifest === "function") {
      Store.rebuildManifest(storage);
    }
  }

  function extractShipmentSnapshot(shp, simState) {
    return {
      id: shp.id,
      code: shp.code,
      originMonth: shp.originMonth || (shp.departDate ? shp.departDate.slice(0, 7) : null),
      status: shp.status,
      departDate: shp.departDate,
      transitDays: shp.transitDays,
      customsWaitDays: shp.customsWaitDays,
      putawayDays: shp.putawayDays,
      originalPlan: shp.originalPlan ? clone(shp.originalPlan) : null,
      milestones: clone(shp.milestones || {}),
      earliestSellablePlannedDate: simState?.earliestSellablePlannedDate || null,
      effectiveSellableDate: simState?.effectiveSellableDate || null,
      progressStatus: simState?.progressStatus || null,
      overdueStage: simState?.overdueStage || null
    };
  }

  function buildFieldDiff(beforeObj, afterObj, fields) {
    const diff = [];
    for (const f of fields) {
      const bVal = f.get(beforeObj);
      const aVal = f.get(afterObj);
      if (JSON.stringify(bVal) !== JSON.stringify(aVal)) {
        diff.push({ field: f.path, label: f.label, before: bVal, after: aVal });
      }
    }
    return diff;
  }

  function analyzeMarketImpacts(baseSim, nextSim, targetMarketId) {
    const impacts = [];
    const newStockoutRisks = [];
    if (!baseSim?.marketSummaries || !nextSim?.marketSummaries) {
      return { impacts, newStockoutRisks };
    }
    for (const [mktId, after] of Object.entries(nextSim.marketSummaries)) {
      const before = baseSim.marketSummaries[mktId];
      if (!before) continue;
      const gapDelta = Math.round(((after.totalDemandGap || 0) - (before.totalDemandGap || 0)) * 100) / 100;
      const firstGapChanged = before.firstGapDate !== after.firstGapDate;
      const newlyStockout = !before.firstGapDate && Boolean(after.firstGapDate);
      const earlierStockout = Boolean(before.firstGapDate && after.firstGapDate && after.firstGapDate < before.firstGapDate);
      const increasedGap = gapDelta > 0.01;

      if (mktId === targetMarketId || newlyStockout || earlierStockout || increasedGap || firstGapChanged) {
        const entry = {
          marketId: mktId,
          marketName: after.name || mktId,
          firstGapDateBefore: before.firstGapDate || null,
          firstGapDateAfter: after.firstGapDate || null,
          totalDemandGapBefore: before.totalDemandGap || 0,
          totalDemandGapAfter: after.totalDemandGap || 0,
          gapDelta,
          daysOfCoverBefore: before.daysOfCoverNow,
          daysOfCoverAfter: after.daysOfCoverNow,
          nextSellableDateBefore: before.nextSellableDate || null,
          nextSellableDateAfter: after.nextSellableDate || null
        };
        impacts.push(entry);
        if (newlyStockout || earlierStockout || increasedGap) {
          newStockoutRisks.push(entry);
        }
      }
    }
    return { impacts, newStockoutRisks };
  }

  /**
   * Create a Read-Only / Scoped Authorized Write Controller.
   * Defaults strictly to READ_ONLY mode.
   */
  function createWriteController(config) {
    const cfg = config || {};
    const storage = cfg.storage !== undefined ? cfg.storage : defaultStorage();
    const auditStore = cfg.auditStore || (getAuditMod() ? getAuditMod().createAuditStore({ storage }) : null);
    const onPersisted = typeof cfg.onPersisted === "function" ? cfg.onPersisted : null;

    let activeGrant = null;
    const idempotencyCache = new Map();

    function isGrantActive(grant, nowTs) {
      if (!grant || grant.revokedAt) return false;
      const now = nowTs || Date.now();
      if (now > grant.expiresAt) return false;
      if (grant.maxOperations && grant.usedOperations >= grant.maxOperations) return false;
      return true;
    }

    function getStatus() {
      const active = isGrantActive(activeGrant);
      return {
        mode: active ? WORK_MODES.AUTHORIZED_WRITE : WORK_MODES.READ_ONLY,
        activeGrant: active ? clone(activeGrant) : null
      };
    }

    /**
     * Explicitly grant scoped, time-bounded, revocable write permission.
     */
    function grantAuthorization(grantInput) {
      const g = grantInput || {};
      const ttlMs = Math.max(60 * 1000, Math.min(24 * 60 * 60 * 1000, Number(g.ttlMs) || 30 * 60 * 1000));
      const allowedOperations = Array.isArray(g.allowedOperations)
        ? g.allowedOperations.filter(op => Object.values(SUPPORTED_OPERATIONS).includes(op))
        : [];
      if (!allowedOperations.length) {
        throw new Error("授权必须至少指定一项受支持的合法业务操作类型");
      }
      const modules = Array.isArray(g.modules) && g.modules.length
        ? g.modules.filter(m => m === "sales" || m === "bom")
        : Array.from(new Set(allowedOperations.map(op => op.startsWith("bom.") ? "bom" : "sales")));

      const workspaceId = g.workspaceId
        || (storage && modules.includes("sales") ? readSalesWorkspace(storage)?.workspaceId : null)
        || "default_workspace";
      const now = Date.now();

      activeGrant = {
        grantId: genGrantId(),
        workspaceId: String(workspaceId),
        modules,
        allowedOperations,
        allowedTargetIds: Array.isArray(g.allowedTargetIds) && g.allowedTargetIds.length
          ? g.allowedTargetIds.map(String)
          : null,
        grantedBy: String(g.grantedBy || "local_user"),
        reason: String(g.reason || "用户显式授权 AI 在限定范围内执行业务调整"),
        grantedAt: now,
        expiresAt: Number(g.expiresAt) > now ? Number(g.expiresAt) : (now + ttlMs),
        maxOperations: Number.isInteger(g.maxOperations) && g.maxOperations > 0 ? g.maxOperations : 20,
        usedOperations: 0,
        revokedAt: null
      };
      return clone(activeGrant);
    }

    function revokeAuthorization() {
      if (activeGrant && !activeGrant.revokedAt) {
        activeGrant.revokedAt = Date.now();
      }
      activeGrant = null;
      return getStatus();
    }

    /**
     * Strict 7-Step Authorized Mutation Pipeline:
     * 1. Parse intent & unambiguous target
     * 2. Validate authorization, safety guardrails & parameters
     * 3. Official dry-run preview (SimEngine / BOM validateState)
     * 4. Optimistic concurrency / data version check
     * 5. Official execution & persistence
     * 6. Recompute impact & refresh UI
     * 7. Generate & persist immutable audit voucher
     */
    function executeAuthorizedMutation(request, execOpts) {
      const req = request || {};
      const opts = execOpts || {};
      const op = String(req.operation || "").trim();
      const idempotencyKey = req.idempotencyKey ? String(req.idempotencyKey).trim()
        : (req.toolCallId ? `toolcall::${String(req.toolCallId).trim()}` : null);

      // Idempotency Check (P0 #2 + C4): duplicate call with same idempotencyKey MUST match operation & target
      if (idempotencyKey) {
        const reqTargetRaw = String(req.shipmentId || req.companyId || req.targetId || "").trim();
        const isCompatibleReplay = (prevOp, prevTargetId) => {
          if (prevOp && op && prevOp !== op) return false;
          if (reqTargetRaw && prevTargetId && !/^(?:COMP|SHP|FAC|MKT|BAT|PRD|MAT|DIAG)_\d+$/i.test(reqTargetRaw) && reqTargetRaw !== String(prevTargetId)) {
            return false;
          }
          return true;
        };
        if (idempotencyCache.has(idempotencyKey)) {
          const cached = idempotencyCache.get(idempotencyKey);
          if (isCompatibleReplay(cached.operation || cached.voucher?.operation, cached.targetId)) {
            return Object.assign({}, clone(cached), { idempotentReplay: true });
          }
        }
        if (auditStore && typeof auditStore.findVoucherByIdempotencyKey === "function") {
          const prevVoucher = auditStore.findVoucherByIdempotencyKey(idempotencyKey);
          if (prevVoucher && isCompatibleReplay(prevVoucher.operation, prevVoucher.target?.entityId)) {
            const replayed = {
              ok: true,
              executed: true,
              idempotentReplay: true,
              operation: prevVoucher.operation || op,
              module: prevVoucher.target?.module || "",
              targetId: prevVoucher.target?.entityId || "",
              targetDisplayName: prevVoucher.target?.displayName || "",
              before: prevVoucher.before,
              after: prevVoucher.after,
              diff: prevVoucher.diff || [],
              businessImpact: prevVoucher.businessImpact || null,
              voucher: prevVoucher,
              refreshed: false
            };
            idempotencyCache.set(idempotencyKey, clone(replayed));
            return replayed;
          }
        }
      }

      // Guardrail A: Hard-block high-risk destructive / historical fact / bulk operations
      if (BLOCKED_HIGH_RISK_OPERATIONS.has(op) || req.isBulk === true || (Array.isArray(req.targetIds) && req.targetIds.length > 1)) {
        return {
          ok: false,
          executed: false,
          needsConfirmation: true,
          code: "REQUIRES_CONFIRMATION_HIGH_RISK",
          error: "该操作涉及删除、历史事实更正或批量修改，禁止自动执行，请由用户在正式业务界面确认处理。"
        };
      }

      if (!Object.values(SUPPORTED_OPERATIONS).includes(op)) {
        return {
          ok: false,
          executed: false,
          needsConfirmation: false,
          code: "UNSUPPORTED_OPERATION",
          error: `不支持通过 AI 执行的写操作类型「${op}」`
        };
      }

      // Guardrail B: Check Read-Only vs Active Scoped Grant
      if (!activeGrant) {
        return {
          ok: false,
          executed: false,
          needsConfirmation: true,
          code: "READ_ONLY_MODE",
          error: "当前处于只读模式，AI 无法修改业务数据；如需执行调整，请先开启临时写入授权。"
        };
      }
      if (!isGrantActive(activeGrant)) {
        return {
          ok: false,
          executed: false,
          needsConfirmation: true,
          code: "AUTHORIZATION_EXPIRED",
          error: "临时写入授权已过期或达到次数上限，请重新授权后再执行。"
        };
      }
      if (!activeGrant.allowedOperations.includes(op)) {
        return {
          ok: false,
          executed: false,
          needsConfirmation: true,
          code: "UNAUTHORIZED_OPERATION",
          error: `当前授权范围不包含操作「${op}」，已拒绝执行。`
        };
      }

      const targetModule = op.startsWith("bom.") ? "bom" : "sales";
      if (!activeGrant.modules.includes(targetModule)) {
        return {
          ok: false,
          executed: false,
          needsConfirmation: true,
          code: "UNAUTHORIZED_MODULE",
          error: `当前授权范围不包含模块「${targetModule}」，已拒绝执行。`
        };
      }

      if (!storage) {
        return { ok: false, executed: false, code: "NO_STORAGE", error: "当前上下文缺少持久化存储，无法执行正式修改" };
      }

      /* ---------------- Sales Shipment ETA / Schedule Adjustment ---------------- */
      if (op === SUPPORTED_OPERATIONS.SHIPMENT_ADJUST_ETA || op === SUPPORTED_OPERATIONS.SHIPMENT_UPDATE_SCHEDULE) {
        const Act = getAct();
        const TS = getTS();
        if (!Act) return { ok: false, executed: false, code: "ENGINE_MISSING", error: "未加载官方销售操作引擎 SC.Actions" };

        let ws;
        try {
          ws = readSalesWorkspace(storage);
        } catch (err) {
          return { ok: false, executed: false, code: "INVALID_WORKSPACE", error: err.message };
        }
        if (!ws) return { ok: false, executed: false, code: "NO_WORKSPACE", error: "未找到正式销售工作区数据" };

        // Workspace binding check
        if (activeGrant.workspaceId && activeGrant.workspaceId !== "default_workspace" && ws.workspaceId !== activeGrant.workspaceId) {
          return {
            ok: false,
            executed: false,
            needsConfirmation: true,
            code: "WORKSPACE_MISMATCH",
            error: "当前授权绑定于其他工作区，已拒绝跨工作区写入。"
          };
        }

        // Step 1: Resolve exact unambiguous shipment target
        let rawShipmentId = req.shipmentId || req.targetId || null;
        if (rawShipmentId && opts.privacyContext) {
          rawShipmentId = opts.privacyContext.translateInputId("shipment", rawShipmentId);
        }
        if (!rawShipmentId && req.activeContext?.kind === "shipment" && req.activeContext.id) {
          rawShipmentId = req.activeContext.id;
        }
        if (!rawShipmentId) {
          return {
            ok: false,
            executed: false,
            needsConfirmation: true,
            code: "AMBIGUOUS_TARGET",
            error: "未能定位到唯一明确的发运单，请先选中具体发运单或明确指定发运单编号后再操作。"
          };
        }

        const shp = ws.shipments?.[rawShipmentId];
        if (!shp) {
          return { ok: false, executed: false, code: "TARGET_NOT_FOUND", error: "未找到指定的发运单记录" };
        }
        if (activeGrant.allowedTargetIds && !activeGrant.allowedTargetIds.includes(rawShipmentId)) {
          return {
            ok: false,
            executed: false,
            needsConfirmation: true,
            code: "TARGET_OUT_OF_SCOPE",
            error: "目标发运单不在当前临时授权允许的对象范围内，已拒绝执行。"
          };
        }
        if (shp.status === "cancelled") {
          return { ok: false, executed: false, code: "INVALID_STATE", error: "已取消的发运单不允许调整预计时间" };
        }
        if (shp.milestones?.marketStockAvailableActualDate) {
          return {
            ok: false,
            executed: false,
            needsConfirmation: true,
            code: "REQUIRES_CONFIRMATION_HISTORICAL_FACT",
            error: "该发运单已实际完成上架，属于历史事实记录，不可按预计延期调整。"
          };
        }

        // Guardrail: Reject any attempt to modify confirmed actual dates!
        if (req.departActualDate !== undefined || req.borderArrivalActualDate !== undefined
            || req.customsReleaseActualDate !== undefined || req.marketStockAvailableActualDate !== undefined) {
          return {
            ok: false,
            executed: false,
            needsConfirmation: true,
            code: "REQUIRES_CONFIRMATION_HISTORICAL_FACT",
            error: "禁止通过预计时间调整接口改写已确认的实际发生日期。"
          };
        }

        // The write grant keeps the existing 365-day limit for explicit AI
        // schedule changes. The Action owns the domain and milestone checks.
        const actionPayload = {};
        let expectedRevision, asOfDate;
        try {
          if (req.etaDelayDays !== undefined) actionPayload.etaDelayDays = TS.requireEtaDelta(req.etaDelayDays);
          for (const field of ["transitDays", "customsWaitDays", "putawayDays"]) {
            if (req[field] === undefined) continue;
            const days = TS.requireDays(req[field], field);
            if (days > 365) throw new Error(`${field}：AI 调整授权允许 0 至 365 天`);
            actionPayload[field] = days;
          }
          if (req.borderArrivalPlannedDate !== undefined) {
            actionPayload.borderArrivalPlannedDate = TS.requireDate(req.borderArrivalPlannedDate, "borderArrivalPlannedDate");
          }
          if (Object.keys(actionPayload).length === 0) throw new Error("缺少预计延期天数或计划时间调整参数");
          expectedRevision = req.expectedRevision === undefined ? ws.revision
            : TS.requireNumber(req.expectedRevision, "expectedRevision", { min: 1, integer: true });
          asOfDate = req.asOfDate === undefined ? TS.todayLocalIso() : TS.requireDate(req.asOfDate, "asOfDate");
        } catch (err) {
          return { ok: false, executed: false, code: "INVALID_ARGS", error: err.message };
        }
        if (req.reason) actionPayload.etaChangeReason = String(req.reason).slice(0, 200);
        const simOptions = { today: asOfDate, viewHorizonDays: ws.viewHorizonDays };

        // Step 3: Official dry-run preview via SC.Actions.simulateActions
        const action = Act.createAction(ws, "shipment.update", rawShipmentId, actionPayload, "ai_agent");
        const preview = Act.simulateActions(ws, [action], simOptions);
        if (!preview.ok) {
          return {
            ok: false,
            executed: false,
            code: "PREVIEW_FAILED",
            error: preview.errors?.map(err => err.message).join("；") || "业务规则预演未通过"
          };
        }

        // Step 4: Optimistic concurrency check immediately prior to commit
        let latestWs;
        try {
          latestWs = readSalesWorkspace(storage);
        } catch (err) {
          return { ok: false, executed: false, code: "INVALID_WORKSPACE", error: err.message };
        }
        if (!latestWs || latestWs.revision !== expectedRevision) {
          return {
            ok: false,
            executed: false,
            code: "VERSION_CONFLICT",
            error: `数据版本已变更（期望 v${expectedRevision}，当前 v${latestWs?.revision ?? "unknown"}），已中止写入以防覆盖并发修改。`
          };
        }

        const beforeSnap = extractShipmentSnapshot(latestWs.shipments[rawShipmentId], preview.baseSimulation?.shipmentStates?.[rawShipmentId]);

        // Step 5: Official execution & atomic persistence with rollback if audit voucher fails
        const Store = getStore();
        const salesKey = Store ? Store.STORAGE_KEYS.SALES : "sc-sales-world-v2";
        const rawSalesBeforeCommit = storage.getItem(salesKey);

        const commitAction = Act.createAction(latestWs, "shipment.update", rawShipmentId, actionPayload, "ai_agent");
        const committed = Act.applyActions(latestWs, [commitAction], simOptions);
        if (!committed.ok) {
          return {
            ok: false,
            executed: false,
            code: "EXECUTION_FAILED",
            error: committed.errors?.map(err => err.message).join("；") || "正式执行失败"
          };
        }

        // Step 6: Compute post-commit diff & business impact before committing
        const afterShp = committed.workspace.shipments[rawShipmentId];
        const afterSnap = extractShipmentSnapshot(afterShp, committed.simulation?.shipmentStates?.[rawShipmentId]);
        const diff = buildFieldDiff(beforeSnap, afterSnap, [
          { path: "transitDays", label: "运输天数", get: x => x.transitDays },
          { path: "customsWaitDays", label: "清关等待天数", get: x => x.customsWaitDays },
          { path: "putawayDays", label: "上架天数", get: x => x.putawayDays },
          { path: "milestones.borderArrivalPlannedDate", label: "最新预计抵港日", get: x => x.milestones?.borderArrivalPlannedDate || null },
          { path: "milestones.customsReleasePlannedDate", label: "最新预计放行日", get: x => x.milestones?.customsReleasePlannedDate || null },
          { path: "milestones.marketStockAvailablePlannedDate", label: "最新预计上架日", get: x => x.milestones?.marketStockAvailablePlannedDate || null },
          { path: "earliestSellablePlannedDate", label: "最新预计最早可售日", get: x => x.earliestSellablePlannedDate }
        ]);
        const impact = analyzeMarketImpacts(preview.baseSimulation, committed.simulation, afterShp.toNodeId);

        // Persist business data + mandatory audit voucher atomically (rollback business write if voucher fails!)
        try {
          writeSalesWorkspace(storage, committed.workspace);
        } catch (err) {
          return { ok: false, executed: false, code: "STORAGE_WRITE_FAILED", error: `业务数据持久化失败：${err?.message || String(err)}` };
        }

        let voucher = null;
        if (auditStore) {
          try {
            voucher = auditStore.recordMutationVoucher({
              idempotencyKey,
              actor: {
                userLabel: activeGrant.grantedBy,
                modelId: opts.modelId || "unknown_model",
                provider: opts.provider || "unknown_provider"
              },
              userInstruction: req.userInstruction || "",
              authorization: {
                grantId: activeGrant.grantId,
                workspaceId: activeGrant.workspaceId,
                operation: op,
                expiresAt: activeGrant.expiresAt
              },
              target: {
                module: "sales",
                entityType: "shipment",
                entityId: rawShipmentId,
                displayName: afterShp.code || rawShipmentId
              },
              action: { type: commitAction.type, payload: actionPayload },
              before: beforeSnap,
              after: afterSnap,
              diff,
              validation: { ok: true, errors: [] },
              preview: {
                ok: true,
                asOfDate,
                newStockoutRiskCount: impact.newStockoutRisks.length
              },
              execution: {
                ok: true,
                committedAt: Date.now(),
                revisionBefore: latestWs.revision,
                revisionAfter: committed.workspace.revision
              },
              dataVersion: {
                workspaceId: committed.workspace.workspaceId,
                revisionBefore: latestWs.revision,
                revisionAfter: committed.workspace.revision
              },
              businessImpact: impact,
              undoable: true,
              undoSpec: {
                module: "sales",
                entityType: "shipment",
                entityId: rawShipmentId,
                hadOriginalPlanBefore: Boolean(beforeSnap.originalPlan),
                restoreFields: {
                  transitDays: beforeSnap.transitDays,
                  customsWaitDays: beforeSnap.customsWaitDays,
                  putawayDays: beforeSnap.putawayDays,
                  borderArrivalPlannedDate: beforeSnap.milestones?.borderArrivalPlannedDate || null,
                  customsReleasePlannedDate: beforeSnap.milestones?.customsReleasePlannedDate || null,
                  marketStockAvailablePlannedDate: beforeSnap.milestones?.marketStockAvailablePlannedDate || null
                },
                actualDatesAtCommit: {
                  departActualDate: afterSnap.milestones?.departActualDate || null,
                  borderArrivalActualDate: afterSnap.milestones?.borderArrivalActualDate || null,
                  customsReleaseActualDate: afterSnap.milestones?.customsReleaseActualDate || null,
                  marketStockAvailableActualDate: afterSnap.milestones?.marketStockAvailableActualDate || null
                }
              }
            });
          } catch (auditErr) {
            // Roll back business data so business state and audit vouchers stay strictly consistent!
            let rolledBack = false;
            try {
              if (rawSalesBeforeCommit !== null && rawSalesBeforeCommit !== undefined) {
                storage.setItem(salesKey, rawSalesBeforeCommit);
                if (Store && typeof Store.rebuildManifest === "function") Store.rebuildManifest(storage);
                rolledBack = storage.getItem(salesKey) === rawSalesBeforeCommit;
              }
            } catch (_) {
              rolledBack = false;
            }
            return {
              ok: false,
              executed: false,
              rolledBack,
              criticalConsistencyError: !rolledBack,
              code: rolledBack ? "AUDIT_PERSIST_FAILED" : "AUDIT_AND_ROLLBACK_FAILED",
              error: rolledBack
                ? `正式修改凭证持久化失败，已自动回滚业务数据，本次修改未生效（${auditErr?.message || "存储异常"}）。`
                : `正式修改凭证持久化失败且业务数据回滚异常，请立即核查本地存储状态。`
            };
          }
        }

        activeGrant.usedOperations += 1;

        if (onPersisted) {
          try {
            onPersisted({ module: "sales", entityType: "shipment", entityId: rawShipmentId, voucher });
          } catch (_) {}
        }

        const resultObj = {
          ok: true,
          executed: true,
          idempotentReplay: false,
          operation: op,
          module: "sales",
          targetId: rawShipmentId,
          targetDisplayName: afterShp.code || rawShipmentId,
          before: beforeSnap,
          after: afterSnap,
          diff,
          businessImpact: impact,
          voucher,
          refreshed: Boolean(onPersisted)
        };
        if (idempotencyKey) idempotencyCache.set(idempotencyKey, clone(resultObj));
        return resultObj;
      }

      /* ---------------- BOM Company Compliance Status Update ---------------- */
      if (op === SUPPORTED_OPERATIONS.BOM_UPDATE_COMPLIANCE) {
        const bom = readBomState(storage);
        if (!bom) return { ok: false, executed: false, code: "NO_WORKSPACE", error: "未找到 BOM 数据" };

        let rawCompanyId = req.companyId || req.targetId || null;
        if (rawCompanyId && opts.privacyContext) {
          rawCompanyId = opts.privacyContext.translateInputId("company", rawCompanyId);
        }
        if (!rawCompanyId && req.activeContext?.kind === "company" && req.activeContext.id) {
          rawCompanyId = req.activeContext.id;
        }
        if (!rawCompanyId) {
          return { ok: false, executed: false, needsConfirmation: true, code: "AMBIGUOUS_TARGET", error: "未定位到唯一明确的公司主体" };
        }
        const comp = bom.companies?.[rawCompanyId];
        if (!comp) return { ok: false, executed: false, code: "TARGET_NOT_FOUND", error: "未找到指定公司档案" };
        if (activeGrant.allowedTargetIds && !activeGrant.allowedTargetIds.includes(rawCompanyId)) {
          return { ok: false, executed: false, needsConfirmation: true, code: "TARGET_OUT_OF_SCOPE", error: "目标公司不在当前临时授权允许的对象范围内，已拒绝执行。" };
        }

        const status = String(req.status || "").trim();
        if (!["severe", "risk", "qualified", "unverified"].includes(status)) {
          return { ok: false, executed: false, code: "INVALID_ARGS", error: "合规状态必须为 severe / risk / qualified / unverified 之一" };
        }
        const reason = String(req.reason ?? "").trim();
        if (reason.length > 5000) {
          return { ok: false, executed: false, code: "INVALID_ARGS", error: "合规说明长度不能超过 5000 字符" };
        }
        const expectedCounter = req.expectedCounter !== undefined ? Number(req.expectedCounter) : (bom.counter || 0);

        // Preview on clone
        const previewBom = clone(bom);
        if (typeof global.setCompanyCompliance === "function") {
          global.setCompanyCompliance(previewBom, rawCompanyId, { status, reason });
          if (typeof global.validateState === "function") global.validateState(previewBom);
        } else {
          previewBom.companies[rawCompanyId].compliance = {
            status,
            reason,
            updatedAt: Date.now(),
            legacyScore: previewBom.companies[rawCompanyId].compliance?.legacyScore ?? null
          };
        }

        // Concurrency check
        const latestBom = readBomState(storage);
        if (!latestBom || (latestBom.counter || 0) !== expectedCounter) {
          return { ok: false, executed: false, code: "VERSION_CONFLICT", error: "BOM 数据已并发变更，已中止写入" };
        }

        const Store = getStore();
        const bomKey = Store ? Store.STORAGE_KEYS.BOM : "bom-flow-sim-v5";
        const rawBomBeforeCommit = storage.getItem(bomKey);

        const beforeComp = clone(latestBom.companies[rawCompanyId].compliance || {});
        if (typeof global.setCompanyCompliance === "function") {
          global.setCompanyCompliance(latestBom, rawCompanyId, { status, reason });
        } else {
          latestBom.companies[rawCompanyId].compliance = {
            status,
            reason,
            updatedAt: Date.now(),
            legacyScore: beforeComp.legacyScore ?? null
          };
        }
        latestBom.counter = (latestBom.counter || 0) + 1;
        if (typeof global.validateState === "function") global.validateState(latestBom);

        const afterComp = clone(latestBom.companies[rawCompanyId].compliance);
        const diff = buildFieldDiff(beforeComp, afterComp, [
          { path: "compliance.status", label: "合规状态", get: x => x.status },
          { path: "compliance.reason", label: "合规说明", get: x => x.reason }
        ]);

        try {
          writeBomState(storage, latestBom);
        } catch (err) {
          return { ok: false, executed: false, code: "STORAGE_WRITE_FAILED", error: `BOM 数据持久化失败：${err?.message || String(err)}` };
        }

        let voucher = null;
        if (auditStore) {
          try {
            voucher = auditStore.recordMutationVoucher({
              idempotencyKey,
              actor: {
                userLabel: activeGrant.grantedBy,
                modelId: opts.modelId || "unknown_model",
                provider: opts.provider || "unknown_provider"
              },
              userInstruction: req.userInstruction || "",
              authorization: {
                grantId: activeGrant.grantId,
                workspaceId: activeGrant.workspaceId,
                operation: op,
                expiresAt: activeGrant.expiresAt
              },
              target: {
                module: "bom",
                entityType: "company",
                entityId: rawCompanyId,
                displayName: latestBom.companies[rawCompanyId].name || rawCompanyId
              },
              action: { type: "bom.setCompanyCompliance", payload: { status, reason } },
              before: beforeComp,
              after: afterComp,
              diff,
              validation: { ok: true, errors: [] },
              preview: { ok: true },
              execution: { ok: true, committedAt: Date.now(), counterBefore: expectedCounter, counterAfter: latestBom.counter },
              dataVersion: { bomCounterBefore: expectedCounter, bomCounterAfter: latestBom.counter },
              businessImpact: { complianceChanged: beforeComp.status !== afterComp.status },
              undoable: true,
              undoSpec: {
                module: "bom",
                entityType: "company",
                entityId: rawCompanyId,
                restoreCompliance: { status: beforeComp.status || "unverified", reason: beforeComp.reason || "" }
              }
            });
          } catch (auditErr) {
            let rolledBack = false;
            try {
              if (rawBomBeforeCommit !== null && rawBomBeforeCommit !== undefined) {
                storage.setItem(bomKey, rawBomBeforeCommit);
                if (Store && typeof Store.rebuildManifest === "function") Store.rebuildManifest(storage);
                rolledBack = storage.getItem(bomKey) === rawBomBeforeCommit;
              }
            } catch (_) {
              rolledBack = false;
            }
            return {
              ok: false,
              executed: false,
              rolledBack,
              criticalConsistencyError: !rolledBack,
              code: rolledBack ? "AUDIT_PERSIST_FAILED" : "AUDIT_AND_ROLLBACK_FAILED",
              error: rolledBack
                ? `正式修改凭证持久化失败，已自动回滚 BOM 数据，本次修改未生效（${auditErr?.message || "存储异常"}）。`
                : `正式修改凭证持久化失败且 BOM 数据回滚异常，请立即核查本地存储状态。`
            };
          }
        }

        activeGrant.usedOperations += 1;

        if (onPersisted) {
          try {
            onPersisted({ module: "bom", entityType: "company", entityId: rawCompanyId, voucher });
          } catch (_) {}
        }

        const bomResultObj = {
          ok: true,
          executed: true,
          idempotentReplay: false,
          operation: op,
          module: "bom",
          targetId: rawCompanyId,
          targetDisplayName: latestBom.companies[rawCompanyId].name || rawCompanyId,
          before: beforeComp,
          after: afterComp,
          diff,
          businessImpact: { complianceChanged: beforeComp.status !== afterComp.status },
          voucher,
          refreshed: Boolean(onPersisted)
        };
        if (idempotencyKey) idempotencyCache.set(idempotencyKey, clone(bomResultObj));
        return bomResultObj;
      }

      return { ok: false, executed: false, code: "UNSUPPORTED_OPERATION", error: `未实现的操作：${op}` };
    }

    /**
     * Safe, version- and business-rule-checked Undo for undoable AI mutations.
     * NEVER deletes or overwrites confirmed historical facts!
     */
    function undoMutation(voucherId) {
      if (!auditStore || !storage) {
        return { ok: false, code: "UNAVAILABLE", error: "当前上下文不支持审计撤销" };
      }
      const voucher = auditStore.getMutationVoucher(voucherId);
      if (!voucher) return { ok: false, code: "NOT_FOUND", error: "未找到对应的修改凭证" };
      if (!voucher.undoable || voucher.undoneAt) {
        return { ok: false, code: "NOT_UNDOABLE", error: "该凭证不支持撤销或已被撤销" };
      }
      const spec = voucher.undoSpec;
      if (!spec) return { ok: false, code: "NOT_UNDOABLE", error: "凭证缺少可安全恢复的回滚规格" };

      if (spec.module === "sales" && spec.entityType === "shipment") {
        const Act = getAct();
        const ws = readSalesWorkspace(storage);
        if (!ws || !Act) return { ok: false, code: "UNAVAILABLE", error: "销售工作区或操作引擎不可用" };
        if (ws.revision !== voucher.execution?.revisionAfter) {
          return {
            ok: false,
            code: "VERSION_CONFLICT",
            error: `工作区版本已从 v${voucher.execution?.revisionAfter} 演进至 v${ws.revision}，为避免覆盖后续业务变更，不能自动撤销。`
          };
        }
        const shp = ws.shipments?.[spec.entityId];
        if (!shp) return { ok: false, code: "TARGET_NOT_FOUND", error: "目标发运单已不存在" };

        // Ensure NO confirmed historical facts were added after the AI edit!
        const prevActuals = spec.actualDatesAtCommit || {};
        const curMs = shp.milestones || {};
        for (const k of ["departActualDate", "borderArrivalActualDate", "customsReleaseActualDate", "marketStockAvailableActualDate"]) {
          if ((curMs[k] || null) !== (prevActuals[k] || null)) {
            return {
              ok: false,
              code: "HISTORICAL_FACT_PROTECTED",
              error: "目标发运单已产生新的已确认实际业务事实，禁止通过撤销覆盖历史事实。"
            };
          }
        }

        const payload = Object.fromEntries(Object.entries(spec.restoreFields).filter(([, value]) => value != null));
        if (!spec.hadOriginalPlanBefore) payload.restoreOriginalPlan = true;
        const beforeSnap = extractShipmentSnapshot(shp, null);
        const undoAct = Act.createAction(ws, "shipment.update", spec.entityId, payload, "user");
        const res = Act.applyActions(ws, [undoAct]);
        if (!res.ok) {
          return { ok: false, code: "EXECUTION_FAILED", error: (res.errors || ["撤销校验失败"]).join("；") };
        }
        writeSalesWorkspace(storage, res.workspace);

        const afterSnap = extractShipmentSnapshot(res.workspace.shipments[spec.entityId], res.simulation?.shipmentStates?.[spec.entityId]);
        const undoVoucher = auditStore.recordMutationVoucher({
          actor: { userLabel: "local_user", modelId: "undo_action", provider: "local" },
          userInstruction: `撤销操作凭证 ${voucherId}`,
          authorization: { kind: "user_undo", revertsVoucherId: voucherId },
          target: voucher.target,
          action: { type: "shipment.update(undo)", payload },
          before: beforeSnap,
          after: afterSnap,
          diff: buildFieldDiff(beforeSnap, afterSnap, [
            { path: "transitDays", label: "运输天数", get: x => x.transitDays },
            { path: "milestones.borderArrivalPlannedDate", label: "预计抵港日", get: x => x.milestones?.borderArrivalPlannedDate || null },
            { path: "milestones.marketStockAvailablePlannedDate", label: "预计上架日", get: x => x.milestones?.marketStockAvailablePlannedDate || null }
          ]),
          execution: { ok: true, committedAt: Date.now(), revisionBefore: ws.revision, revisionAfter: res.workspace.revision },
          dataVersion: { workspaceId: res.workspace.workspaceId, revisionBefore: ws.revision, revisionAfter: res.workspace.revision },
          undoable: false,
          revertsVoucherId: voucherId
        });
        auditStore.markVoucherUndone(voucherId, undoVoucher.voucherId);

        if (onPersisted) {
          try { onPersisted({ module: "sales", entityType: "shipment", entityId: spec.entityId, voucher: undoVoucher }); } catch (_) {}
        }
        return { ok: true, undoneVoucherId: voucherId, undoVoucher };
      }

      if (spec.module === "bom" && spec.entityType === "company") {
        const bom = readBomState(storage);
        if (!bom) return { ok: false, code: "UNAVAILABLE", error: "BOM 数据不可用" };
        if ((bom.counter || 0) !== voucher.execution?.counterAfter) {
          return { ok: false, code: "VERSION_CONFLICT", error: "BOM 数据版本已变化，不能自动撤销" };
        }
        const comp = bom.companies?.[spec.entityId];
        if (!comp) return { ok: false, code: "TARGET_NOT_FOUND", error: "目标公司已不存在" };

        const beforeComp = clone(comp.compliance || {});
        if (typeof global.setCompanyCompliance === "function") {
          global.setCompanyCompliance(bom, spec.entityId, spec.restoreCompliance);
        } else {
          comp.compliance = Object.assign({}, comp.compliance, spec.restoreCompliance, { updatedAt: Date.now() });
        }
        bom.counter = (bom.counter || 0) + 1;
        writeBomState(storage, bom);

        const afterComp = clone(bom.companies[spec.entityId].compliance);
        const undoVoucher = auditStore.recordMutationVoucher({
          actor: { userLabel: "local_user", modelId: "undo_action", provider: "local" },
          userInstruction: `撤销操作凭证 ${voucherId}`,
          authorization: { kind: "user_undo", revertsVoucherId: voucherId },
          target: voucher.target,
          action: { type: "bom.setCompanyCompliance(undo)", payload: spec.restoreCompliance },
          before: beforeComp,
          after: afterComp,
          diff: buildFieldDiff(beforeComp, afterComp, [
            { path: "compliance.status", label: "合规状态", get: x => x.status },
            { path: "compliance.reason", label: "合规说明", get: x => x.reason }
          ]),
          execution: { ok: true, committedAt: Date.now(), counterBefore: bom.counter - 1, counterAfter: bom.counter },
          undoable: false,
          revertsVoucherId: voucherId
        });
        auditStore.markVoucherUndone(voucherId, undoVoucher.voucherId);

        if (onPersisted) {
          try { onPersisted({ module: "bom", entityType: "company", entityId: spec.entityId, voucher: undoVoucher }); } catch (_) {}
        }
        return { ok: true, undoneVoucherId: voucherId, undoVoucher };
      }

      return { ok: false, code: "NOT_UNDOABLE", error: "该修改类型不支持自动撤销" };
    }

    return Object.freeze({
      MUTATIONS_VERSION,
      getStatus,
      grantAuthorization,
      revokeAuthorization,
      executeAuthorizedMutation,
      undoMutation,
      getAuditStore: () => auditStore
    });
  }

  const SCAIMutations = Object.freeze({
    MUTATIONS_VERSION,
    WORK_MODES,
    SUPPORTED_OPERATIONS,
    createWriteController
  });

  global.SCAIMutations = SCAIMutations;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = SCAIMutations;
  }
})(typeof window !== "undefined" ? window : globalThis);
