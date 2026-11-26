(function (global) {
  "use strict";

  const getTS = () => global.SC?.TimeSeries || (typeof require === "function" ? require("./timeseries.js") : null);
  const getWM = () => global.SC?.WorldModel || (typeof require === "function" ? require("./world-model.js") : null);
  const getSim = () => global.SC?.SimEngine || (typeof require === "function" ? require("./sim-engine.js") : null);

  function createAction(workspace, type, targetId, payload, options) {
    const WM = getWM();
    return {
      actionId: options?.actionId || WM.genId("act"),
      workspaceId: workspace.workspaceId,
      baseRevision: options?.baseRevision !== undefined ? options.baseRevision : workspace.revision,
      actor: options?.actor || "user",
      type,
      targetId: targetId || "",
      payload: payload === undefined ? {} : payload,
      timestamp: Date.now()
    };
  }

  function validateEnvelope(workspace, action, opts) {
    if (!action || typeof action !== "object") return "Action object is empty";
    if (!action.actionId || typeof action.actionId !== "string") return "Missing actionId";
    if (action.workspaceId && action.workspaceId !== workspace.workspaceId) return `workspaceId mismatch`;
    if (!action.type || typeof action.type !== "string") return "Missing action type";
    if (!opts?.skipIdempotency && workspace.processedActionIds.includes(action.actionId)) {
      return `DUPLICATE_ACTION:${action.actionId}`;
    }
    if (!opts?.skipRevisionCheck && typeof action.baseRevision === "number" && action.baseRevision !== workspace.revision) {
      return `Version conflict: action based on rev #${action.baseRevision}, current is rev #${workspace.revision}`;
    }
    return null;
  }

  function nextShipmentCode(workspace) {
    const nums = Object.values(workspace.shipments || {})
      .map(s => {
        const m = /(\d+)$/.exec(String(s.code || ""));
        return m ? Number(m[1]) : 0;
      });
    const next = (nums.length ? Math.max(...nums) : 0) + 1;
    return `SHP-${String(next).padStart(3, "0")}`;
  }

  /**
   * 统计指定生产批次的总量、已分配数量（含未执行的计划发运与已确认的实际发运）及剩余可分配量。
   */
  function getBatchAllocationSummary(ws, batchId, excludeShipmentId) {
    const TS = getTS();
    const WM = getWM();
    const b = ws?.batches?.[batchId];
    if (!b) return null;
    const totalQty = TS.roundQty(WM.getBatchQuantity(ws, b));

    let plannedQty = 0;
    let actualQty = 0;
    for (const s of Object.values(ws.shipments || {})) {
      if (!s || s.status === "cancelled" || s.batchId !== batchId) continue;
      if (excludeShipmentId && s.id === excludeShipmentId) continue;
      const q = Math.max(0, Number(s.qty) || 0);
      const isActual = s.status === "confirmed"
        || Object.values(WM.SHIPMENT_FACT_FIELDS).some(field => s.milestones?.[field]);
      if (isActual) actualQty += q;
      else plannedQty += q;
    }
    plannedQty = TS.roundQty(plannedQty);
    actualQty = TS.roundQty(actualQty);
    const allocatedQty = TS.roundQty(plannedQty + actualQty);
    const remainingQty = Math.max(0, TS.roundQty(totalQty - allocatedQty));
    const allocatedPct = totalQty > 0 ? Math.round((allocatedQty / totalQty) * 10000) / 100 : 0;
    const remainingPct = totalQty > 0 ? Math.max(0, Math.round((remainingQty / totalQty) * 10000) / 100) : 0;
    return { batch: b, totalQty, plannedQty, actualQty, allocatedQty, remainingQty, allocatedPct, remainingPct };
  }

  /**
   * 按原生产批次总量与比例列表计算各市场整数分配数量（最大余数法），严格保证总和不超过批次总量与剩余可分配量。
   */
  function computeProportionalQuantities(batchTotalQty, pctList, remainingQty) {
    const total = Math.max(0, Number(batchTotalQty) || 0);
    const cap = remainingQty !== undefined && remainingQty !== null
      ? Math.max(0, Math.min(total, Number(remainingQty) || 0))
      : total;
    const pcts = (pctList || []).map(v => Math.max(0, Number(v) || 0));
    const pctSum = pcts.reduce((a, b) => a + b, 0);
    if (total <= 0 || pcts.length === 0 || pctSum <= 0) return pcts.map(() => 0);

    const exact = pcts.map(p => (total * p) / 100);
    const floored = exact.map(v => Math.floor(v + 1e-9));
    const floorSum = floored.reduce((a, b) => a + b, 0);

    // Target integer total never exceeds cap (or floor(exactSum) when pctSum < 100%)
    const exactSum = (total * pctSum) / 100;
    const capInt = Math.floor(cap + 1e-6);
    const targetSum = Math.min(capInt, Math.round(exactSum + 1e-9));

    const result = floored.slice();
    let diff = targetSum - floorSum;
    if (diff > 0) {
      const order = exact
        .map((v, idx) => ({ idx, rem: v - floored[idx], pct: pcts[idx] }))
        .filter(x => x.pct > 0)
        .sort((a, b) => b.rem - a.rem || a.idx - b.idx);
      for (let i = 0; i < order.length && diff > 0; i++) {
        result[order[i].idx] += 1;
        diff -= 1;
      }
    } else if (diff < 0) {
      let excess = -diff;
      const order = exact
        .map((v, idx) => ({ idx, rem: v - floored[idx] }))
        .sort((a, b) => a.rem - b.rem || b.idx - a.idx);
      for (let i = 0; i < order.length && excess > 0; i++) {
        const take = Math.min(result[order[i].idx], excess);
        result[order[i].idx] -= take;
        excess -= take;
      }
    }
    return result;
  }

  function appendFact(workspace, action) {
    const WM = getWM();
    const TS = getTS();
    const p = action.payload;
    const correcting = action.type === "event.correct";
    const original = correcting ? workspace.facts.find(f => f?.eventId === action.targetId) : null;
    const reason = String(p.note || "").trim();
    if (correcting && !original) throw new Error("Original fact record not found");
    if (correcting && !reason) throw new Error("A correction reason is required");

    const kind = original?.kind || p.kind;
    const targetId = original?.targetId || action.targetId;
    const date = p.date === undefined ? original?.date : p.date;
    const collection = WM.factTargetCollection(kind);
    if (!collection) throw new Error("Invalid fact event type");
    const entity = Object.hasOwn(workspace[collection], targetId) && workspace[collection][targetId];
    if (!entity) throw new Error("Target entity not found");
    if (collection === "shipments" && entity.status === "cancelled") throw new Error("Cannot confirm milestones for a cancelled shipment");
    if (TS.parseIsoDateUtc(date) === null) throw new Error("Enter a valid actual date (YYYY-MM-DD)");

    const previous = WM.findEffectiveFact(workspace, targetId, kind, original?.date || date);
    if (correcting && previous !== original) throw new Error("Amend the current active record from the Fact Ledger");
    if (!correcting && previous) throw new Error("This fact is already confirmed; amend it in the Fact Ledger");
    if (correcting && kind === "inventory_stocktake" && date !== original.date && WM.findEffectiveFact(workspace, targetId, kind, date)) {
      throw new Error("A stocktake already exists on that date for this node");
    }

    let qty = original?.qty;
    if (["production_confirmed", "inventory_stocktake", "shipment_dispatched"].includes(kind)) {
      if (p.qty !== undefined) qty = TS.requireQuantity(p.qty, "Actual qty", kind === "shipment_dispatched");
      else if (kind === "production_confirmed") qty = TS.requireQuantity(qty ?? WM.getBatchQuantity(workspace, entity), "Actual completed qty");
      else if (kind === "shipment_dispatched") qty = TS.requireQuantity(qty ?? entity.qty, "Actual dispatched qty", true);
      else qty = TS.requireQuantity(qty, "Actual stocktake qty");
    } else if (correcting && p.qty !== undefined) {
      throw new Error("Only dates can be amended on this milestone; amend quantity on the dispatch record");
    } else if (p.qty !== undefined) {
      qty = TS.requireQuantity(p.qty, "Actual qty", kind === "shipment_dispatched");
      if (qty !== entity.qty) throw new Error("Milestone quantity must match the shipment");
    }
    // Older workspaces can carry actual values on the entity with no ledger entry.
    // Registering the same values makes those legacy actuals eligible for an audited correction.
    if (!correcting) WM.assertLegacyFactValues(workspace, kind, targetId, date, qty);

    if (collection === "shipments") {
      const fields = Object.values(WM.SHIPMENT_FACT_FIELDS);
      const step = fields.indexOf(WM.SHIPMENT_FACT_FIELDS[kind]);
      const actuals = fields.map(field => entity.milestones?.[field]);
      if (!actuals[0] && entity.status === "confirmed") actuals[0] = entity.departDate;
      if (date !== actuals[step] && actuals.some((actual, index) =>
        actual && ((index < step && actual > date) || (index > step && actual < date)))) {
        throw new Error("Actual date conflicts with the order of other confirmed milestones");
      }
    }

    const eventId = p.eventId || WM.genId(correcting ? "ev_corr" : "ev");
    if (workspace.facts.some(f => f?.eventId === eventId)) throw new Error("Fact event ID already exists");
    workspace.facts.push({
      eventId, kind, date, targetId, qty,
      note: correcting ? `[Amended ${original.eventId}] ${reason}` : reason || "Confirmed",
      recordedAt: Date.now(),
      actor: action.actor || "user",
      supersedesEventId: original?.eventId || null
    });
    WM.projectFacts(workspace);
  }

  function ensureNewEntity(workspace, collection, id) {
    if (Object.hasOwn(workspace[collection], id)
      || workspace.facts.some(fact => fact?.targetId === id && getWM().factTargetCollection(fact.kind) === collection)) {
      throw new Error(`Entity ID ${id} already exists or is referenced by facts`);
    }
  }

  function readMarketPolicy(input = {}, current) {
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("marketPolicy must be an object");
    const TS = getTS();
    const policy = { ...getWM().defaultMarketPolicy(), ...current };
    for (const field of ["lastMileUnitCost", "fulfillmentUnitCost", "channelCommissionUnitCost"]) {
      if (input[field] !== undefined) policy[field] = TS.requireNumber(input[field], field);
    }
    if (input.priority !== undefined) {
      policy.priority = TS.requireNumber(input.priority, "priority", { min: 1, integer: true });
    }
    return policy;
  }

  function executeOneAction(ws, action) {
    const TS = getTS();
    const WM = getWM();
    const p = action.payload === undefined ? {} : action.payload;
    if (!p || typeof p !== "object" || Array.isArray(p)) throw new Error("Action payload must be an object");
    const targetId = action.targetId;

    switch (action.type) {
      /* ================= TimeSeries: Rate Points (Absolute Dates) ================= */
      case "timeseries.point.add": {
        const curve = ws.curves[targetId];
        if (!curve) throw new Error(`Curve ${targetId} not found`);
        if (TS.parseIsoDateUtc(p.date) === null) throw new Error("Invalid date (expected YYYY-MM-DD)");
        const rate = TS.requireQuantity(p.rate, "Rate");
        const existing = curve.points.find(pt => pt.date === p.date);
        if (existing) existing.rate = rate;
        else curve.points.push({ id: p.pointId || WM.genId("pt"), date: p.date, rate: rate });
        curve.points = TS.sortRatePointsByDate(curve.points);
        break;
      }

      case "timeseries.point.move": {
        const curve = ws.curves[targetId];
        if (!curve) throw new Error(`Curve ${targetId} not found`);
        const pt = curve.points.find(item => item.id === p.pointId);
        if (!pt) throw new Error(`Control point ${p.pointId} not found`);
        const nextDate = p.date !== undefined ? p.date : pt.date;
        const nextRate = p.rate !== undefined ? TS.requireQuantity(p.rate, "Rate") : pt.rate;
        if (TS.parseIsoDateUtc(nextDate) === null || !Number.isFinite(nextRate)) throw new Error("Invalid control point date or rate");
        const clash = curve.points.find(item => item.id !== pt.id && item.date === nextDate);
        if (clash) throw new Error(`A point already exists on ${nextDate}`);
        pt.date = nextDate;
        pt.rate = nextRate;
        curve.points = TS.sortRatePointsByDate(curve.points);
        break;
      }

      case "timeseries.point.delete": {
        const curve = ws.curves[targetId];
        if (!curve) throw new Error(`Curve ${targetId} not found`);
        const before = curve.points.length;
        curve.points = curve.points.filter(item => item.id !== p.pointId);
        if (curve.points.length === before) throw new Error(`Control point ${p.pointId} not found`);
        break;
      }

      /* ================= TimeSeries: Total Mode Segments ================= */
      case "timeseries.segment.setMode": {
        const curve = ws.curves[targetId];
        if (!curve) throw new Error(`Curve ${targetId} not found`);
        if (p.mode === "rate") {
          curve.totalSegments = p.segmentId
            ? curve.totalSegments.filter(s => s.id !== p.segmentId)
            : curve.totalSegments.filter(s => !(s.startDate === p.startDate && s.endDate === p.endDate));
          break;
        }
        if (p.mode !== "total") throw new Error("Mode must be total or rate");
        if (TS.parseIsoDateUtc(p.startDate) === null || TS.parseIsoDateUtc(p.endDate) === null || p.endDate <= p.startDate) {
          throw new Error("End date must be after start date");
        }
        const overlaps = TS.findOverlappingSegmentsByDate(curve.totalSegments, p.startDate, p.endDate, p.segmentId);
        if (overlaps.length) {
          throw new Error(`Range [${p.startDate}, ${p.endDate}] overlaps existing segment [${overlaps[0].startDate}, ${overlaps[0].endDate}]`);
        }
        const totalQty = TS.requireQuantity(p.totalQty === undefined
          ? TS.integrateCurveByDates(curve, p.startDate, p.endDate) : p.totalQty, "Range total");
        const segment = {
          id: p.segmentId || WM.genId("seg"),
          startDate: p.startDate,
          endDate: p.endDate,
          totalQty,
          distribution: p.distribution === "custom" ? "custom" : "uniform",
          shapeAnchors: p.distribution === "custom"
            ? TS.normalizeShapeAnchors(WM.requireShapeAnchors(p.shapeAnchors === undefined
              ? [{ t: 0, weight: 0.7 }, { t: 0.5, weight: 1.5 }, { t: 1, weight: 0.8 }] : p.shapeAnchors))
            : undefined,
          label: p.label || `${TS.formatShortDate(p.startDate)}–${TS.formatShortDate(p.endDate)} Total`,
          sourcePrecision: "interval_total"
        };
        curve.totalSegments = TS.sortTotalSegmentsByDate([
          ...curve.totalSegments.filter(item => item.id !== segment.id), segment
        ]);
        break;
      }

      case "timeseries.segment.setTotal": {
        const curve = ws.curves[targetId];
        if (!curve) throw new Error(`Curve ${targetId} not found`);
        const seg = curve.totalSegments.find(s => s.id === p.segmentId);
        if (!seg) throw new Error(`Segment ${p.segmentId} not found`);
        seg.totalQty = TS.requireQuantity(p.totalQty, "Range total");
        if (p.distribution === "uniform" || p.distribution === "custom") {
          seg.distribution = p.distribution;
          if (seg.distribution === "custom" && !seg.shapeAnchors?.length) {
            seg.shapeAnchors = [{ t: 0, weight: 0.7 }, { t: 0.5, weight: 1.5 }, { t: 1, weight: 0.8 }];
          }
        }
        if (p.label !== undefined) seg.label = String(p.label);
        break;
      }

      case "timeseries.segment.setShape": {
        const curve = ws.curves[targetId];
        if (!curve) throw new Error(`Curve ${targetId} not found`);
        const seg = curve.totalSegments.find(s => s.id === p.segmentId);
        if (!seg) throw new Error(`Segment ${p.segmentId} not found`);
        seg.distribution = "custom";
        seg.shapeAnchors = TS.normalizeShapeAnchors(WM.requireShapeAnchors(p.shapeAnchors));
        break;
      }

      case "timeseries.segment.remove": {
        const curve = ws.curves[targetId];
        if (!curve) throw new Error(`Curve ${targetId} not found`);
        curve.totalSegments = curve.totalSegments.filter(s => s.id !== p.segmentId);
        break;
      }

      case "timeseries.setHorizon": {
        const curve = ws.curves[targetId];
        if (!curve) throw new Error(`Curve ${targetId} not found`);
        curve.horizonDays = TS.requireHorizon(p.horizonDays, "Curve horizon (days)", 365);
        break;
      }

      case "timeseries.importCsv": {
        const curve = ws.curves[targetId];
        if (!curve) throw new Error(`Curve ${targetId} not found`);
        const parsed = TS.parseDailyCsv(p.csvText, { expectedSku: p.expectedSku || null });
        if (!parsed.ok) throw new Error("CSV validation failed: " + parsed.errors.join("; "));
        if (!parsed.records.length) throw new Error("No valid daily records in CSV");
        const map = new Map();
        if (p.merge !== false) {
          for (const ex of (curve.importedDailyActuals || [])) map.set(ex.date, ex);
        }
        for (const rec of parsed.records) {
          map.set(rec.date, { date: rec.date, qty: rec.qty, source: "csv_daily_actual" });
        }
        curve.importedDailyActuals = Array.from(map.values()).sort((a, b) => a.date.localeCompare(b.date));
        break;
      }

      /* ================= Inventory ================= */
      case "inventory.initialize": {
        const node = ws.nodes[targetId];
        if (!node) throw new Error(`Node ${targetId} not found`);
        node.initialInventory = TS.requireQuantity(p.initialInventory, "Initial inventory");
        break;
      }

      /* ================= Production Batches ================= */
      case "batch.createFromInterval": {
        const src = ws.nodes[targetId];
        if (!src || src.kind !== "source") throw new Error("Batches can only be created for factories");
        if (src.entityStatus === "archived") throw new Error(`Factory "${src.name}" is archived`);
        if (TS.parseIsoDateUtc(p.startDate) === null || TS.parseIsoDateUtc(p.endDate) === null || p.endDate <= p.startDate) {
          throw new Error("Batch end date must be after start date");
        }
        const extra = TS.requireDays(p.extraWaitDays === undefined ? 0 : p.extraWaitDays, "Extra wait days");
        for (const eb of Object.values(ws.batches)) {
          if (eb.sourceNodeId === targetId && p.startDate < eb.endDate && p.endDate > eb.startDate) {
            throw new Error(`Range [${p.startDate}, ${p.endDate}] overlaps existing batch ${eb.code}`);
          }
        }
        const id = p.batchId || WM.genId("bat");
        ensureNewEntity(ws, "batches", id);
        const seq = Object.keys(ws.batches).length + 1;
        ws.batches[id] = {
          id,
          code: p.code || `BAT-${String(seq).padStart(2, "0")}`,
          sourceNodeId: targetId,
          productId: ws.activeProductId,
          originMonth: p.startDate.slice(0, 7),
          startDate: p.startDate,
          endDate: p.endDate,
          extraWaitDays: extra,
          availableDate: TS.addDaysToIso(p.endDate, extra),
          qtyOverride: p.qtyOverride == null ? null : TS.requireQuantity(p.qtyOverride, "Batch quantity"),
          status: "planned",
          note: String(p.note || "")
        };
        break;
      }

      case "batch.update": {
        const b = ws.batches[targetId];
        if (!b) throw new Error(`Batch ${targetId} not found`);
        if (b.status === "confirmed") throw new Error("Completed batches cannot be edited directly");
        const sDate = p.startDate === undefined ? b.startDate : TS.requireDate(p.startDate, "Batch start date");
        const eDate = p.endDate === undefined ? b.endDate : TS.requireDate(p.endDate, "Batch end date");
        if (eDate <= sDate) throw new Error("End date must be after start date");
        for (const eb of Object.values(ws.batches)) {
          if (eb.id !== b.id && eb.sourceNodeId === b.sourceNodeId && sDate < eb.endDate && eDate > eb.startDate) {
            throw new Error(`Adjusted window overlaps batch ${eb.code}`);
          }
        }
        if (!b.originMonth && b.startDate) b.originMonth = b.startDate.slice(0, 7);
        b.startDate = sDate;
        b.endDate = eDate;
        if (p.extraWaitDays !== undefined) b.extraWaitDays = TS.requireDays(p.extraWaitDays, "Extra wait days");
        b.availableDate = TS.addDaysToIso(b.endDate, b.extraWaitDays);
        if (p.code !== undefined && String(p.code).trim()) b.code = String(p.code).trim();
        if (p.note !== undefined) b.note = String(p.note);
        break;
      }

      case "batch.delete": {
        const b = ws.batches[targetId];
        if (!b) throw new Error(`Batch ${targetId} not found`);
        if (b.status === "confirmed") throw new Error("Completed batches cannot be deleted");
        const linked = Object.values(ws.shipments).find(s => s.batchId === targetId && s.status !== "cancelled");
        if (linked) throw new Error(`Batch ${b.code} is linked to shipment ${linked.code}`);
        for (const shipment of Object.values(ws.shipments)) {
          if (shipment.batchId === targetId) shipment.batchId = null;
        }
        delete ws.batches[targetId];
        break;
      }

      /* ================= Layer 2: Reusable Logistics Lane Templates ================= */
      case "lane.save": {
        const from = ws.nodes[p.fromNodeId];
        const to = ws.nodes[p.toNodeId];
        if (!from || from.kind !== "source" || !to || to.kind !== "market") {
          throw new Error("Logistics lanes must connect a Factory to a Target Market");
        }
        const id = (targetId && ws.lanes[targetId]) ? targetId : (p.laneId || WM.genId("lane"));
        const mode = WM.requireMode(p.defaultMode === undefined ? "sea" : p.defaultMode);
        ws.lanes[id] = {
          id,
          name: String(p.name || `${from.name} → ${to.name} (${WM.modeLabel(mode)})`).trim(),
          fromNodeId: from.id,
          toNodeId: to.id,
          defaultMode: mode,
          defaultCarrier: String(p.defaultCarrier || "").trim(),
          defaultTransitDays: TS.requireDays(p.defaultTransitDays === undefined ? 14 : p.defaultTransitDays, "defaultTransitDays"),
          defaultFixedCost: TS.requireNumber(p.defaultFixedCost === undefined ? 0 : p.defaultFixedCost, "defaultFixedCost"),
          defaultUnitCost: TS.requireNumber(p.defaultUnitCost === undefined ? 0 : p.defaultUnitCost, "defaultUnitCost"),
          defaultOriginPort: String(p.defaultOriginPort || "").trim(),
          defaultDestinationPort: String(p.defaultDestinationPort || "").trim(),
          defaultCustomsWaitDays: TS.requireDays(p.defaultCustomsWaitDays === undefined ? 3 : p.defaultCustomsWaitDays, "defaultCustomsWaitDays"),
          defaultPutawayDays: TS.requireDays(p.defaultPutawayDays === undefined ? 1 : p.defaultPutawayDays, "defaultPutawayDays"),
          defaultImportFeeFixed: TS.requireNumber(p.defaultImportFeeFixed === undefined ? 0 : p.defaultImportFeeFixed, "defaultImportFeeFixed"),
          defaultImportFeePerUnit: TS.requireNumber(p.defaultImportFeePerUnit === undefined ? 0 : p.defaultImportFeePerUnit, "defaultImportFeePerUnit"),
          note: String(p.note || "")
        };
        // CRITICAL: Saving a lane template NEVER mutates existing shipments or historical facts!
        break;
      }

      case "lane.delete": {
        if (!ws.lanes[targetId]) throw new Error(`Lane ${targetId} not found`);
        for (const shipment of Object.values(ws.shipments)) {
          if (shipment.laneId === targetId) shipment.laneId = null;
        }
        delete ws.lanes[targetId];
        break;
      }

      /* ================= Layer 3: Independent Shipments ================= */
      case "shipment.create": {
        const lane = p.laneId ? ws.lanes[p.laneId] : null;
        if (p.laneId && !lane) throw new Error("Selected logistics lane not found");
        const fromId = p.fromNodeId || lane?.fromNodeId;
        const toId = p.toNodeId || lane?.toNodeId;
        const from = ws.nodes[fromId];
        const to = ws.nodes[toId];
        if (!from || from.kind !== "source") throw new Error("Select a valid origin factory");
        if (from.entityStatus === "archived") throw new Error(`Factory "${from.name}" is archived`);
        if (!to || to.kind !== "market") throw new Error("Select a valid target market");
        if (TS.parseIsoDateUtc(p.departDate) === null) throw new Error("Select a valid dispatch date (YYYY-MM-DD)");
        const qty = TS.requireQuantity(p.qty, "Shipment quantity", true);
        if (p.batchId) {
          const summary = getBatchAllocationSummary(ws, p.batchId);
          if (!summary) throw new Error("Selected batch not found");
          if (summary.batch.sourceNodeId !== from.id) {
            throw new Error(`Origin factory must match batch ${summary.batch.code}`);
          }
          if (summary.allocatedQty + qty > summary.totalQty + 1e-4) {
            throw new Error(`Allocated qty (${TS.roundQty(summary.allocatedQty + qty)}) exceeds batch ${summary.batch.code} total (${summary.totalQty}); remaining: ${summary.remainingQty}`);
          }
        }

        const transitDays = TS.requireDays(p.transitDays === undefined ? lane?.defaultTransitDays ?? 14 : p.transitDays, "transitDays");
        const customsWaitDays = TS.requireDays(p.customsWaitDays === undefined ? lane?.defaultCustomsWaitDays ?? 3 : p.customsWaitDays, "customsWaitDays");
        const putawayDays = TS.requireDays(p.putawayDays === undefined ? lane?.defaultPutawayDays ?? 1 : p.putawayDays, "putawayDays");
        const milestones = WM.computeDefaultMilestones(p.departDate, transitDays, customsWaitDays, putawayDays, { overrides: p });
        const id = p.shipmentId || WM.genId("shp");
        ensureNewEntity(ws, "shipments", id);

        ws.shipments[id] = {
          id,
          code: String(p.code || nextShipmentCode(ws)).trim(),
          productId: p.productId || ws.activeProductId,
          laneId: lane ? lane.id : null,
          fromNodeId: from.id,
          toNodeId: to.id,
          batchId: p.batchId || null,
          allocationPct: p.allocationPct == null ? null : TS.requireAllocationPct(p.allocationPct),
          qty,
          originMonth: p.departDate.slice(0, 7),
          departDate: p.departDate,
          mode: WM.requireMode(p.mode === undefined ? lane?.defaultMode ?? "sea" : p.mode),
          carrier: String(p.carrier ?? lane?.defaultCarrier ?? "").trim(),
          transitDays,
          fixedCost: TS.requireNumber(p.fixedCost === undefined ? lane?.defaultFixedCost ?? 0 : p.fixedCost, "fixedCost"),
          unitCost: TS.requireNumber(p.unitCost === undefined ? lane?.defaultUnitCost ?? 0 : p.unitCost, "unitCost"),
          customsWaitDays,
          putawayDays,
          importFeeFixed: TS.requireNumber(p.importFeeFixed === undefined ? lane?.defaultImportFeeFixed ?? 0 : p.importFeeFixed, "importFeeFixed"),
          importFeePerUnit: TS.requireNumber(p.importFeePerUnit === undefined ? lane?.defaultImportFeePerUnit ?? 0 : p.importFeePerUnit, "importFeePerUnit"),
          originPort: String(p.originPort ?? lane?.defaultOriginPort ?? "").trim(),
          destinationPort: String(p.destinationPort ?? lane?.defaultDestinationPort ?? "").trim(),
          stopoverPorts: p.stopoverPorts === undefined ? [] : WM.readStopoverPorts(p.stopoverPorts),
          trackingNumber: String(p.trackingNumber || "").trim(),
          blNumber: String(p.blNumber || "").trim(),
          containerNo: String(p.containerNo || "").trim(),
          voyageNo: String(p.voyageNo || "").trim(),
          status: "planned",
          milestones,
          note: String(p.note || "")
        };
        if (p.allocationPct != null && !p.batchId) throw new Error("Allocation % applies only to batch-linked shipments");
        WM.assertShipmentSchedule(ws.shipments[id]);
        if (p.status === "confirmed") {
          appendFact(ws, { ...action, type: "event.record", targetId: id, payload: {
            kind: "shipment_dispatched", date: p.departDate, qty
          } });
        }
        break;
      }

      case "shipment.update": {
        const shp = ws.shipments[targetId];
        if (!shp) throw new Error(`Shipment ${targetId} not found`);
        if (shp.status === "cancelled") throw new Error("Cancelled shipments cannot be edited");
        if (!shp.originMonth && shp.departDate) shp.originMonth = shp.departDate.slice(0, 7);
        const isFact = WM.hasShipmentActuals(shp);
        const lockedFields = ["departDate", "qty", "fromNodeId", "toNodeId", "batchId"];
        if (isFact && lockedFields.some(field => p[field] !== undefined && p[field] !== shp[field])) {
          throw new Error("Confirmed shipment dates, qty, route, and batch are locked; amend via Fact Ledger");
        }

        // Preserve immutable original baseline plan before any ETA/schedule adjustment
        const isScheduleAdjustment = p.etaDelayDays !== undefined
          || p.restoreOriginalPlan === true
          || p.transitDays !== undefined
          || p.customsWaitDays !== undefined
          || p.putawayDays !== undefined
          || p.borderArrivalPlannedDate !== undefined
          || p.customsReleasePlannedDate !== undefined
          || p.marketStockAvailablePlannedDate !== undefined;

        if (isScheduleAdjustment && !shp.originalPlan) {
          shp.originalPlan = {
            departDate: shp.departPlannedDate || shp.departDate,
            transitDays: shp.transitDays,
            customsWaitDays: shp.customsWaitDays,
            putawayDays: shp.putawayDays,
            borderArrivalPlannedDate: shp.milestones?.borderArrivalPlannedDate || null,
            customsReleasePlannedDate: shp.milestones?.customsReleasePlannedDate || null,
            marketStockAvailablePlannedDate: shp.milestones?.marketStockAvailablePlannedDate || null,
            capturedAt: Date.now()
          };
        }

        // Confirmed shipment: lock departure date & quantity (use fact correction instead), allow updating carrier/tracking/ports/planned future ETA!
        if (!isFact) {
          if (p.departDate !== undefined) {
            if (TS.parseIsoDateUtc(p.departDate) === null) throw new Error("Invalid dispatch date");
            if (!shp.originMonth && shp.departDate) shp.originMonth = shp.departDate.slice(0, 7);
            shp.departDate = p.departDate;
          }
          if (p.qty !== undefined) {
            shp.qty = TS.requireQuantity(p.qty, "Shipment quantity", true);
          }
          if (p.fromNodeId !== undefined) {
            if (ws.nodes[p.fromNodeId]?.kind !== "source") throw new Error("Select a valid origin factory");
            shp.fromNodeId = p.fromNodeId;
          }
          if (p.toNodeId !== undefined) {
            if (ws.nodes[p.toNodeId]?.kind !== "market") throw new Error("Select a valid target market");
            shp.toNodeId = p.toNodeId;
          }
          if (p.batchId !== undefined) shp.batchId = p.batchId || null;
          if (shp.batchId) {
            const summary = getBatchAllocationSummary(ws, shp.batchId, shp.id);
            if (!summary) throw new Error("Selected batch not found");
            if (summary.batch.sourceNodeId !== shp.fromNodeId) {
              throw new Error(`Origin factory must match batch ${summary.batch.code}`);
            }
            if (summary.allocatedQty + shp.qty > summary.totalQty + 1e-4) {
              throw new Error(`Allocated qty (${TS.roundQty(summary.allocatedQty + shp.qty)}) exceeds batch ${summary.batch.code} total (${summary.totalQty}); remaining: ${summary.remainingQty}`);
            }
          }
        }

        const delta = p.etaDelayDays === undefined ? undefined : TS.requireEtaDelta(p.etaDelayDays);
        if (p.restoreOriginalPlan === true && shp.originalPlan) {
          shp.transitDays = shp.originalPlan.transitDays;
          shp.customsWaitDays = shp.originalPlan.customsWaitDays;
          shp.putawayDays = shp.originalPlan.putawayDays;
        } else if (delta !== undefined) {
          if (shp.milestones?.marketStockAvailableActualDate) {
            throw new Error("Shipment is already shelved; ETA cannot be adjusted");
          }
          // Shift the earliest unconfirmed downstream stage while keeping all confirmed actual dates untouched
          if (!shp.milestones?.borderArrivalActualDate) {
            shp.transitDays = Math.max(0, (shp.transitDays ?? 0) + delta);
          } else if (!shp.milestones?.customsReleaseActualDate) {
            shp.customsWaitDays = Math.max(0, (shp.customsWaitDays ?? 0) + delta);
          } else {
            shp.putawayDays = Math.max(0, (shp.putawayDays ?? 0) + delta);
          }
        }

        if (p.mode !== undefined) shp.mode = WM.requireMode(p.mode);
        if (p.carrier !== undefined) shp.carrier = String(p.carrier).trim();
        if (p.transitDays !== undefined) shp.transitDays = TS.requireDays(p.transitDays, "transitDays");
        if (p.fixedCost !== undefined) shp.fixedCost = TS.requireNumber(p.fixedCost, "fixedCost");
        if (p.unitCost !== undefined) shp.unitCost = TS.requireNumber(p.unitCost, "unitCost");
        if (p.customsWaitDays !== undefined) shp.customsWaitDays = TS.requireDays(p.customsWaitDays, "customsWaitDays");
        if (p.putawayDays !== undefined) shp.putawayDays = TS.requireDays(p.putawayDays, "putawayDays");
        if (p.importFeeFixed !== undefined) shp.importFeeFixed = TS.requireNumber(p.importFeeFixed, "importFeeFixed");
        if (p.importFeePerUnit !== undefined) shp.importFeePerUnit = TS.requireNumber(p.importFeePerUnit, "importFeePerUnit");
        if (p.originPort !== undefined) shp.originPort = String(p.originPort).trim();
        if (p.destinationPort !== undefined) shp.destinationPort = String(p.destinationPort).trim();
        if (p.stopoverPorts !== undefined) shp.stopoverPorts = WM.readStopoverPorts(p.stopoverPorts);
        if (p.trackingNumber !== undefined) shp.trackingNumber = String(p.trackingNumber).trim();
        if (p.blNumber !== undefined) shp.blNumber = String(p.blNumber).trim();
        if (p.containerNo !== undefined) shp.containerNo = String(p.containerNo).trim();
        if (p.voyageNo !== undefined) shp.voyageNo = String(p.voyageNo).trim();
        if (p.note !== undefined) shp.note = String(p.note);

        // Recompute ONLY latest estimated milestone dates (NEVER overwrite confirmed actual dates or originalPlan!)
        if (!isScheduleAdjustment && p.departDate === undefined) break;
        shp.milestones ??= {};
        const {
          borderArrivalPlannedDate: borderP,
          customsReleasePlannedDate: releaseP,
          marketStockAvailablePlannedDate: availP
        } = WM.computeDefaultMilestones(shp.departDate, shp.transitDays, shp.customsWaitDays, shp.putawayDays, {
          overrides: p, actuals: shp.milestones
        });
        shp.milestones.borderArrivalPlannedDate = borderP;
        shp.milestones.customsReleasePlannedDate = releaseP;
        shp.milestones.marketStockAvailablePlannedDate = availP;
        WM.assertShipmentSchedule(shp, p);

        if (p.restoreOriginalPlan === true) {
          shp.revisedEstimate = null;
        } else if (isScheduleAdjustment && shp.originalPlan) {
          shp.revisedEstimate = {
            updatedAt: Date.now(),
            borderArrivalEstimatedDate: borderP,
            customsReleaseEstimatedDate: releaseP,
            marketStockAvailableEstimatedDate: availP,
            reason: p.etaChangeReason ? String(p.etaChangeReason).slice(0, 200) : ""
          };
        }
        break;
      }

      case "shipment.duplicate": {
        const orig = ws.shipments[targetId];
        if (!orig) throw new Error(`Source shipment ${targetId} not found`);
        if (ws.nodes[orig.fromNodeId]?.entityStatus === "archived") throw new Error("Origin factory is archived; cannot clone shipment");
        const nextDepart = p.departDate === undefined ? TS.addDaysToIso(orig.departDate, 7)
          : TS.requireDate(p.departDate, "Dispatch date");
        const defMs = WM.computeDefaultMilestones(nextDepart, orig.transitDays, orig.customsWaitDays, orig.putawayDays);
        const id = p.newShipmentId || WM.genId("shp");
        ensureNewEntity(ws, "shipments", id);
        const qty = TS.requireQuantity(p.qty === undefined ? orig.qty : p.qty, "Shipment quantity", true);
        ws.shipments[id] = {
          ...WM.clone(orig),
          id,
          code: p.code || nextShipmentCode(ws),
          batchId: null,
          originMonth: nextDepart.slice(0, 7), // New shipment: never inherit the source record's immutable origin.
          departDate: nextDepart,
          qty,
          trackingNumber: "",
          blNumber: "",
          containerNo: "",
          voyageNo: "",
          status: "planned",
          stopoverPorts: (orig.stopoverPorts || []).map(port => ({ ...port, actualDate: null })),
          milestones: defMs,
          note: p.note || `Cloned from ${orig.code}`
        };
        break;
      }

      case "shipment.cancel": {
        const shp = ws.shipments[targetId];
        if (!shp) throw new Error(`Shipment ${targetId} not found`);
        if (WM.hasShipmentActuals(shp)) {
          throw new Error("Confirmed shipments cannot be cancelled");
        }
        shp.status = "cancelled";
        break;
      }

      case "shipment.batchImport": {
        const parsed = TS.parseShipmentsCsv(p.csvText, ws.nodes);
        if (!parsed.ok) throw new Error("Shipment CSV validation failed: " + parsed.errors.join("; "));
        for (const rec of parsed.records) {
          const matchingLane = Object.values(ws.lanes).find(l => l.fromNodeId === rec.fromNodeId && l.toNodeId === rec.toNodeId && l.defaultMode === rec.mode)
            || Object.values(ws.lanes).find(l => l.fromNodeId === rec.fromNodeId && l.toNodeId === rec.toNodeId);
          executeOneAction(ws, {
            ...action,
            type: "shipment.create",
            targetId: "",
            payload: {
              ...rec,
              laneId: matchingLane?.id || null
            }
          });
        }
        break;
      }

      /* ================= Nodes (Strictly Factory & Market) ================= */
      case "node.create": {
        if (p.kind !== "source" && p.kind !== "market") {
          throw new Error("Only Factory and Market nodes are supported");
        }
        const name = String(p.name || "").trim();
        if (!name) throw new Error("Enter a name");
        const initialInventory = TS.requireQuantity(p.initialInventory === undefined ? 0 : p.initialInventory, "Initial inventory");
        if (p.kind === "source" && p.bomFactoryId) {
          const dup = Object.values(ws.nodes).find(n => n.kind === "source" && n.bomFactoryId === p.bomFactoryId);
          if (dup) {
            dup.name = name;
            if (p.bomCompanyId) dup.bomCompanyId = p.bomCompanyId;
            break;
          }
        }
        const id = p.nodeId || WM.genId(p.kind === "source" ? "src" : "mkt");
        ensureNewEntity(ws, "nodes", id);
        const sameKindCount = Object.values(ws.nodes).filter(n => n.kind === p.kind).length;
        const node = {
          id,
          kind: p.kind,
          name,
          region: String(p.region || (p.kind === "source" ? "CN" : "US")).trim(),
          city: String(p.city || "").trim(),
          mapX: p.kind === "source" ? 165 : 815,
          mapY: 75 + sameKindCount * 95,
          bomFactoryId: p.bomFactoryId || null,
          bomCompanyId: p.bomCompanyId || null,
          initialInventory,
          note: String(p.note || "")
        };
        if (p.kind === "market") {
          node.marketPolicy = readMarketPolicy(p.marketPolicy);
        }
        ws.nodes[id] = node;
        const today = TS.todayLocalIso();
        if (p.kind === "source") {
          const pcId = WM.genId("crv");
          const initPts = p.emptyCurve
            ? []
            : [
                { id: WM.genId("pt"), date: ws.inventoryAnchorDate || today, rate: 80 },
                { id: WM.genId("pt"), date: TS.addDaysToIso(today, 30), rate: 100 }
              ];
          ws.curves[pcId] = WM.createEmptyCurve(pcId, id, "production", initPts, 30);
        } else {
          const dcId = WM.genId("crv");
          ws.curves[dcId] = WM.createEmptyCurve(dcId, id, "demand", [
            { id: WM.genId("pt"), date: ws.inventoryAnchorDate || today, rate: 60 },
            { id: WM.genId("pt"), date: TS.addDaysToIso(today, 30), rate: 75 }
          ], 30);
        }
        break;
      }

      case "node.update": {
        const node = ws.nodes[targetId];
        if (!node) throw new Error(`Node ${targetId} not found`);
        if (p.name !== undefined && String(p.name).trim()) node.name = String(p.name).trim();
        if (p.region !== undefined) node.region = String(p.region).trim();
        if (p.city !== undefined) node.city = String(p.city).trim();
        if (p.initialInventory !== undefined) node.initialInventory = TS.requireQuantity(p.initialInventory, "Initial inventory");
        if (p.note !== undefined) node.note = String(p.note);
        break;
      }

      case "node.delete": {
        const node = ws.nodes[targetId];
        if (!node) throw new Error(`Node ${targetId} not found`);
        const used = Object.values(ws.shipments).find(s => s.status !== "cancelled" && (s.fromNodeId === targetId || s.toNodeId === targetId));
        if (used) throw new Error(`"${node.name}" is linked to shipment ${used.code}`);
        for (const [lid, l] of Object.entries(ws.lanes)) {
          if (l.fromNodeId !== targetId && l.toNodeId !== targetId) continue;
          for (const shipment of Object.values(ws.shipments)) {
            if (shipment.laneId === lid) shipment.laneId = null;
          }
          delete ws.lanes[lid];
        }
        for (const [cid, c] of Object.entries(ws.curves)) {
          if (c.targetNodeId === targetId) delete ws.curves[cid];
        }
        for (const [bid, b] of Object.entries(ws.batches)) {
          if (b.sourceNodeId !== targetId) continue;
          for (const shipment of Object.values(ws.shipments)) {
            if (shipment.batchId === bid) shipment.batchId = null;
          }
          delete ws.batches[bid];
        }
        for (const [id, shipment] of Object.entries(ws.shipments)) {
          if (shipment.fromNodeId === targetId || shipment.toNodeId === targetId) delete ws.shipments[id];
        }
        delete ws.nodes[targetId];
        break;
      }

      /* ================= Market Policy (Cost & Priority Only; Wait/Order Timers Removed) ================= */
      case "market.policy.update": {
        const node = ws.nodes[targetId];
        if (!node || node.kind !== "market") throw new Error("Target is not a market node");
        node.marketPolicy = readMarketPolicy(p, node.marketPolicy);
        break;
      }

      /* ================= Confirmed Facts & Audit Corrections ================= */
      case "event.record":
      case "event.correct": {
        appendFact(ws, action);
        break;
      }

      /* ================= Product SKU Registration (On-Demand) ================= */
      case "product.save": {
        const name = String(p.name || "").trim();
        const skuCode = String(p.skuCode || "").trim();
        if (!name) throw new Error("Enter a product name");
        if (!skuCode) throw new Error("Enter a SKU code");
        const pid = (targetId && ws.products[targetId]) ? targetId : (p.productId || skuCode);
        const existing = ws.products[pid] || {};
        ws.products[pid] = {
          productId: pid,
          skuCode,
          name,
          unit: String(p.unit || existing.unit || "units").trim() || "units",
          bomDiagramId: p.bomDiagramId !== undefined ? p.bomDiagramId : (existing.bomDiagramId || null),
          bomMaterialId: p.bomMaterialId !== undefined ? p.bomMaterialId : (existing.bomMaterialId || null),
          bomVersion: existing.bomVersion || null,
          unitManufacturingCost: TS.requireNumber(p.unitManufacturingCost === undefined
            ? existing.unitManufacturingCost ?? 0 : p.unitManufacturingCost, "unitManufacturingCost"),
          costSource: p.unitManufacturingCost !== undefined ? "user_input" : (existing.costSource || "user_input"),
          note: String(p.note ?? existing.note ?? "")
        };
        ws.activeProductId = pid;
        break;
      }

      /* ================= Workspace Settings ================= */
      case "workspace.settings.update": {
        if (p.viewHorizonDays !== undefined) {
          ws.viewHorizonDays = TS.requireHorizon(p.viewHorizonDays, "Simulation horizon (days)", 180);
        }
        if (p.activeProductId && ws.products[p.activeProductId]) {
          ws.activeProductId = p.activeProductId;
        }
        if (p.unitManufacturingCost !== undefined) {
          const cost = TS.requireNumber(p.unitManufacturingCost, "unitManufacturingCost");
          const prod = ws.products[ws.activeProductId];
          if (prod) {
            prod.unitManufacturingCost = cost;
            prod.costSource = "user_input";
          }
        }
        if (p.dismissMigrationNotice && ws.migrationNotice) {
          ws.migrationNotice.dismissed = true;
        }
        break;
      }

      default:
        throw new Error(`Unsupported action type: ${action.type}`);
    }

    if (action.type !== "workspace.settings.update") {
      ws.revision += 1;
    }
  }

  /**
   * 内存干跑预演接口（供未来 AI 在不修改当前正式业务计划的前提下验证建议后果）。
   */
  function simulateActions(workspace, actions, simOptions) {
    const WM = getWM();
    const Sim = getSim();
    const list = Array.isArray(actions) ? actions : [actions];
    let preview, baseSim;
    const errors = [];
    try {
      baseSim = Sim.simulateWorkspace(workspace, simOptions);
      preview = WM.projectFacts(WM.clone(workspace));
    } catch (error) {
      return { ok: false, errors: [{ message: error.message }], previewWorkspace: null, simulation: null, baseSimulation: null };
    }

    for (let i = 0; i < list.length; i++) {
      const act = list[i];
      const err = validateEnvelope(preview, act, { skipRevisionCheck: i > 0, skipIdempotency: false });
      if (err) {
        errors.push({ index: i, actionId: act?.actionId, message: err });
        break;
      }
      try {
        const before = WM.clone(preview);
        executeOneAction(preview, act);
        if (act.type !== "event.record" && act.type !== "event.correct") WM.assertProtectedEntities(before, preview);
        WM.assertNoNewMissingReferences(before, preview);
        WM.assertBusinessData(preview, { projected: true });
        preview.processedActionIds.push(act.actionId);
      } catch (e) {
        errors.push({ index: i, actionId: act.actionId, message: e.message });
        break;
      }
    }

    if (errors.length) {
      return { ok: false, errors, previewWorkspace: null, simulation: baseSim, baseSimulation: baseSim };
    }
    try {
      const nextSim = Sim.simulateWorkspace(preview, simOptions);
      return { ok: true, errors: [], previewWorkspace: preview, simulation: nextSim, baseSimulation: baseSim };
    } catch (error) {
      return { ok: false, errors: [{ message: error.message }], previewWorkspace: null, simulation: baseSim, baseSimulation: baseSim };
    }
  }

  function applyActions(workspace, actions, simOptions) {
    const list = Array.isArray(actions) ? actions : [actions];
    const res = simulateActions(workspace, list, simOptions);
    if (!res.ok) return { ok: false, errors: res.errors, workspace, simulation: res.baseSimulation };
    const committed = res.previewWorkspace;
    for (const act of list) {
      committed.actionLog.push({ ...act, timestamp: act.timestamp || Date.now() });
    }
    if (committed.actionLog.length > 300) committed.actionLog = committed.actionLog.slice(-300);
    if (committed.processedActionIds.length > 600) committed.processedActionIds = committed.processedActionIds.slice(-600);
    return { ok: true, errors: [], workspace: committed, simulation: res.simulation };
  }

  function dispatchAction(workspace, action, options) {
    if (options?.dryRun) return simulateActions(workspace, [action], options?.simOptions);
    return applyActions(workspace, [action], options?.simOptions);
  }

  /**
   * 保留面向未来 AI 的结构化只读接口与可用操作目录（不在前台 UI 堆积 AI 控件）。
   */
  function queryWorldState(workspace, simOptions) {
    const Sim = getSim();
    const sim = Sim.simulateWorkspace(workspace, simOptions);
    return {
      workspaceId: workspace.workspaceId,
      revision: workspace.revision,
      today: sim.today,
      activeProduct: workspace.products[workspace.activeProductId],
      kpis: sim.kpis,
      exceptions: sim.exceptions,
      markets: sim.marketSummaries,
      shipments: sim.shipmentStates,
      batches: sim.batchStates,
      factsCount: workspace.facts.length
    };
  }

  function listAvailableActions(workspace, targetId) {
    const WM = getWM();
    const list = [];
    const nodes = targetId && workspace.nodes[targetId] ? [workspace.nodes[targetId]] : Object.values(workspace.nodes);
    for (const n of nodes) {
      if (n.kind === "source") {
        const pc = WM.findNodeCurve(workspace, n.id, "production");
        if (pc) list.push({ type: "timeseries.point.add", targetId: pc.id, label: `Edit ${n.name} production curve` });
        list.push({ type: "batch.createFromInterval", targetId: n.id, label: `Create batch at ${n.name}` });
        list.push({ type: "shipment.create", targetId: n.id, label: `Schedule shipment from ${n.name}` });
      } else if (n.kind === "market") {
        list.push({ type: "market.policy.update", targetId: n.id, label: `Update ${n.name} fulfillment settings` });
      }
    }
    const shps = targetId && workspace.shipments[targetId] ? [workspace.shipments[targetId]] : Object.values(workspace.shipments);
    for (const s of shps) {
      if (s.status === "cancelled") continue;
      list.push({ type: "shipment.update", targetId: s.id, label: `Update ${s.code} schedule or documents` });
      list.push({ type: "event.record", targetId: s.id, label: `Confirm ${s.code} actual milestone dates` });
    }
    return list;
  }

  const Actions = {
    createAction,
    validateEnvelope,
    getBatchAllocationSummary,
    computeProportionalQuantities,
    simulateActions,
    applyActions,
    dispatchAction,
    queryWorldState,
    listAvailableActions
  };

  global.SC = global.SC || {};
  global.SC.Actions = Actions;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = Actions;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
