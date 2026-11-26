(function (global) {
  "use strict";

  const getTS = () => global.SC?.TimeSeries || (typeof require === "function" ? require("./timeseries.js") : null);
  const getWM = () => global.SC?.WorldModel || (typeof require === "function" ? require("./world-model.js") : null);

  const EPS = 1e-6;
  const r2 = v => Math.round((Number(v) || 0) * 100) / 100;
  const r4 = v => Math.round((Number(v) || 0) * 10000) / 10000;

  function getEffectiveFacts(workspace) {
    return getWM().getEffectiveFacts(workspace);
  }

  /**
   * 计算单笔发运的预计/实际里程碑、最早可销售日（上架完成日 D → D+1）及全程时间消耗比例。
   * 规则：
   * - 保留内部字段 marketStockAvailablePlannedDate / ActualDate 代表「上架完成日」以兼容旧数据；
   * - 派生 earliestSellablePlannedDate / ActualDate 代表「最早可销售日 = 上架完成日 + 1 天」；
   * - 逾期未确认的实际事件绝不自动视为完成，不会虚增当前真实库存；
   * - 全程时间消耗比例仅基于「计划发运日 → 计划上架完成日」，仅代表时间消耗，不代表实际进度。
   */
  function resolveShipmentDates(shp, factsByTarget, todayIso, anchorDate = todayIso) {
    const TS = getTS();
    const targetFacts = new Map((factsByTarget.get(shp.id) || []).map(f => [f.kind, f]));
    const actualDate = (kind, field) => targetFacts.get(kind)?.date || shp.milestones?.[field] || null;

    const departActual = actualDate("shipment_dispatched", "departActualDate") || (shp.status === "confirmed" ? shp.departDate : null);
    const borderActual = actualDate("border_arrival", "borderArrivalActualDate");
    const releaseActual = actualDate("customs_release", "customsReleaseActualDate");
    const putawayActual = actualDate("market_stock_available", "marketStockAvailableActualDate");
    const firstMovement = departActual || borderActual || releaseActual || putawayActual;
    const departPlanned = shp.departPlannedDate || shp.originalPlan?.departDate || shp.departDate;

    // Keep the existing replay convention when departure was skipped: use the
    // scheduled departure, bounded by the first downstream fact.
    const departDate = departActual || (firstMovement && firstMovement < shp.departDate ? firstMovement : shp.departDate);
    const transitDays = shp.transitDays ?? 0;
    const customsWaitDays = shp.customsWaitDays ?? 0;
    const putawayDays = shp.putawayDays ?? 0;
    const ms = shp.milestones || {};
    const borderPlanned = ms.borderArrivalPlannedDate || TS.addDaysToIso(departPlanned, transitDays);
    const releasePlanned = ms.customsReleasePlannedDate || TS.addDaysToIso(borderPlanned, customsWaitDays);
    const putawayPlanned = ms.marketStockAvailablePlannedDate || TS.addDaysToIso(releasePlanned, putawayDays);

    // The baseline stays intact. Anchor pending stages to the latest actual
    // or estimate. An explicit ETA recorded after that fact takes precedence.
    const revised = shp.revisedEstimate;
    function estimate(planned, baseline, previous, days, revisedDate, priorFact) {
      if (revisedDate && revisedDate >= previous
          && (!priorFact || (revised.updatedAt ?? 0) > (priorFact.recordedAt ?? 0))) return revisedDate;
      if (previous <= baseline && planned >= previous) return planned;
      return TS.addDaysToIso(previous, days);
    }

    const estimatedBorderDate = estimate(borderPlanned, departPlanned, departDate, transitDays,
      revised?.borderArrivalEstimatedDate, targetFacts.get("shipment_dispatched"));
    const estimatedReleaseDate = estimate(releasePlanned, borderPlanned, borderActual || estimatedBorderDate, customsWaitDays,
      revised?.customsReleaseEstimatedDate, targetFacts.get("border_arrival") || targetFacts.get("shipment_dispatched"));
    const estimatedPutawayDate = estimate(putawayPlanned, releasePlanned, releaseActual || estimatedReleaseDate, putawayDays,
      revised?.marketStockAvailableEstimatedDate, targetFacts.get("customs_release") || targetFacts.get("border_arrival") || targetFacts.get("shipment_dispatched"));

    const knownByToday = d => d && d <= todayIso;
    // Look only at the next milestone after the latest reached stage.
    const pending = knownByToday(putawayActual) || shp.status === "cancelled" || departDate > todayIso ? null
      : knownByToday(releaseActual) ? ["market_stock_available", estimatedPutawayDate]
      : knownByToday(borderActual) ? ["customs_release", estimatedReleaseDate]
      : ["border_arrival", estimatedBorderDate];

    // These are candidates until dispatch has passed the inventory checks.
    const overdueStage = pending && todayIso > pending[1] ? pending[0] : null;
    const overdueDueDate = overdueStage ? pending[1] : null;
    const overdueDays = overdueDueDate ? TS.diffIsoDays(overdueDueDate, todayIso) : 0;
    const atLeast = (a, b) => a < b ? b : a;
    const nextActual = (date, later) => later && date > later ? later : date;

    // Bound missing earlier milestones by a downstream fact. Actual dates
    // themselves are never filled in or clamped.
    const borderProjection = overdueStage === "border_arrival" ? todayIso : estimatedBorderDate;
    const effBorder = borderActual || nextActual(borderProjection, releaseActual || putawayActual);
    let releaseProjection = atLeast(estimatedReleaseDate, effBorder);
    if (effBorder > estimatedBorderDate) releaseProjection = TS.addDaysToIso(effBorder, customsWaitDays);
    if (overdueStage === "customs_release") releaseProjection = atLeast(releaseProjection, todayIso);
    const effRelease = releaseActual || nextActual(releaseProjection, putawayActual);
    let putawayProjection = atLeast(estimatedPutawayDate, effRelease);
    if (effRelease > estimatedReleaseDate) putawayProjection = TS.addDaysToIso(effRelease, putawayDays);

    // An unconfirmed putaway never releases sellable inventory on or before today.
    const effPutaway = putawayActual || atLeast(putawayProjection, atLeast(todayIso, anchorDate));
    const effSellable = TS.addDaysToIso(effPutaway, 1);
    const earliestSellablePlannedDate = TS.addDaysToIso(putawayPlanned, 1);
    const earliestSellableActualDate = putawayActual ? TS.addDaysToIso(putawayActual, 1) : null;

    // Full-cycle time elapsed ratio: planned depart -> planned putaway complete
    const plannedCycleStart = shp.originalPlan?.departDate || departPlanned;
    const plannedCycleEnd = shp.originalPlan?.marketStockAvailablePlannedDate || putawayPlanned;
    const fullCyclePlannedDays = TS.diffIsoDays(plannedCycleStart, plannedCycleEnd) || 0;
    let fullCycleElapsedPct = 0;
    let fullCycleZeroSpan = false;
    let fullCycleOverrun = false;

    if (fullCyclePlannedDays <= 0) {
      fullCycleZeroSpan = true;
      fullCycleElapsedPct = todayIso < plannedCycleStart ? 0 : 100;
      fullCycleOverrun = todayIso > plannedCycleEnd;
    } else {
      const elapsed = TS.diffIsoDays(plannedCycleStart, todayIso) || 0;
      fullCycleOverrun = elapsed > fullCyclePlannedDays;
      fullCycleElapsedPct = Math.max(0, Math.min(100, Math.round((elapsed / fullCyclePlannedDays) * 100)));
    }

    // Legacy transit-only elapsed pct (kept for compatibility)
    let elapsedTransitPct = 0;
    if (borderActual) elapsedTransitPct = 100;
    else if (todayIso >= departDate && transitDays > 0) {
      elapsedTransitPct = Math.max(0, Math.min(100, Math.round(((TS.diffIsoDays(departDate, todayIso) || 0) / transitDays) * 100)));
    }

    return {
      departDate,
      departPlannedDate: departPlanned,
      departActualDate: departActual,
      borderArrivalPlannedDate: borderPlanned,
      borderArrivalActualDate: borderActual,
      customsReleasePlannedDate: releasePlanned,
      customsReleaseActualDate: releaseActual,
      // Preserved internal keys = 上架完成日
      marketStockAvailablePlannedDate: putawayPlanned,
      marketStockAvailableActualDate: putawayActual,
      // Explicit display aliases & 最早可销售日 (D+1)
      putawayCompletePlannedDate: putawayPlanned,
      putawayCompleteActualDate: putawayActual,
      earliestSellablePlannedDate,
      earliestSellableActualDate,
      estimatedBorderDate,
      estimatedReleaseDate,
      estimatedPutawayDate,
      effectiveBorderDate: effBorder,
      effectiveReleaseDate: effRelease,
      effectivePutawayDate: effPutaway,
      effectiveAvailableDate: effPutaway, // alias for putaway complete date
      effectiveSellableDate: effSellable, // D + 1 sellable date!
      overdueStage,
      overdueDueDate,
      overdueDays,
      fullCyclePlannedDays,
      fullCycleElapsedPct,
      fullCycleZeroSpan,
      fullCycleOverrun,
      elapsedTransitPct,
      originalPlan: shp.originalPlan ? Object.assign({}, shp.originalPlan) : null,
      hasRevisedEstimate: Boolean(shp.originalPlan && shp.revisedEstimate)
    };
  }

  function firstDownstreamFact(st) {
    return st.borderArrivalActualDate || st.customsReleaseActualDate || st.putawayCompleteActualDate;
  }

  function firstActualMovement(st) {
    return st.departActualDate || firstDownstreamFact(st);
  }

  function hasActualMovement(st) {
    return Boolean(firstActualMovement(st));
  }

  function shipmentInventoryBucket(st, date, today) {
    if (!st.executed || st.departDate > date || st.effectiveSellableDate <= date) return null;
    if (date > today) {
      if (date >= st.effectivePutawayDate) return "shelvedPendingNextDay";
      if (date >= st.effectiveReleaseDate) return "inCustoms";
      if (date >= st.effectiveBorderDate) return "atBorder";
      return "inTransitInbound";
    }

    const firstActual = firstActualMovement(st);
    if (!firstActual || firstActual > date) return "projectedInPipeline";
    if (st.putawayCompleteActualDate && st.putawayCompleteActualDate <= date) return "shelvedPendingNextDay";
    if (st.customsReleaseActualDate && st.customsReleaseActualDate <= date) return "inCustoms";
    if (st.borderArrivalActualDate && st.borderArrivalActualDate <= date) return "atBorder";
    return "inTransitInbound";
  }

  function emptyPipeline() {
    return { inTransitInbound: 0, atBorder: 0, inCustoms: 0, shelvedPendingNextDay: 0, projectedInPipeline: 0 };
  }

  function addShipmentToPipeline(totals, st, bucket) {
    if (bucket) totals[bucket] = r4(totals[bucket] + st.executedQty);
  }

  function matchesShipmentScope(st, filters) {
    return (!filters.factoryId || filters.factoryId === "all" || filters.factoryId === st.fromNodeId)
      && (!filters.marketId || filters.marketId === "all" || filters.marketId === st.toNodeId)
      && (!filters.productId || filters.productId === st.productId);
  }

  /**
   * 确定性供需与库存推演引擎 V0.3：
   * - 工厂生产 → 发运 → 抵港 → 清关 → 上架完成(D) → 最早可销售(D+1) → 市场自然日预测需求直接匹配；
   * - 市场端无订单等待队列与超时流失，每日可满足需求 = min(预测需求, 当日可销售库存)，预计缺口 = max(0, 预测需求 - 当日可销售库存)；
   * - 全节点全周期严格库存守恒 (Δ = 0) 且零负库存。
   */
  function simulateWorkspace(workspace, options) {
    const TS = getTS();
    const WM = getWM();
    WM.assertBusinessData(workspace);
    const today = options?.today === undefined ? TS.todayLocalIso() : TS.requireDate(options.today, "Simulation base date (today)");
    const horizon = options?.viewHorizonDays === undefined ? workspace.viewHorizonDays ?? 30 : options.viewHorizonDays;
    const viewHorizonDays = TS.requireHorizon(horizon, "Simulation horizon (viewHorizonDays)", 180);
    const product = workspace.products[workspace.activeProductId] || Object.values(workspace.products)[0];
    const unitMfgCost = product?.unitManufacturingCost ?? 0;

    const anchorDate = workspace.inventoryAnchorDate ?? today;
    const simStartDate = anchorDate <= today ? anchorDate : today;
    const simEndDate = TS.addDaysToIso(today, Math.max(viewHorizonDays, 30));
    const totalDays = TS.diffIsoDays(simStartDate, simEndDate) + 1;
    if (workspace.facts?.length) workspace = WM.projectFacts(WM.clone(workspace));
    WM.assertBusinessData(workspace, { projected: true });
    const todayIdx = Math.max(0, Math.min(totalDays - 1, TS.diffIsoDays(simStartDate, today) || 0));
    const viewEndIdx = Math.min(totalDays - 1, todayIdx + viewHorizonDays - 1);
    const viewEndDate = TS.addDaysToIso(simStartDate, viewEndIdx);

    const dateToIdx = iso => TS.diffIsoDays(simStartDate, iso);
    const anchorIdx = dateToIdx(anchorDate);

    const effectiveFacts = getEffectiveFacts(workspace);
    const factsByTarget = new Map();
    for (const f of effectiveFacts) {
      if (!factsByTarget.has(f.targetId)) factsByTarget.set(f.targetId, []);
      factsByTarget.get(f.targetId).push(f);
    }

    const conflicts = [];
    let cflSeq = 0;
    const addConflict = c => {
      const id = `cfl_${++cflSeq}`;
      conflicts.push({ id, ...c });
      return id;
    };

    // 1. Precompute daily curves for factories & markets
    const productionDaily = {};
    const demandDaily = {};
    const batchByProductionDate = {};

    for (const node of Object.values(workspace.nodes)) {
      if (node.kind === "source") {
        const prodCurve = WM.findNodeCurve(workspace, node.id, "production");
        productionDaily[node.id] = prodCurve
          ? TS.computeDailySeriesRange(prodCurve, simStartDate, totalDays)
          : Array.from({ length: totalDays }, (_, d) => ({ day: d, date: TS.addDaysToIso(simStartDate, d), qty: 0 }));
        batchByProductionDate[node.id] = new Map();
      } else if (node.kind === "market") {
        const demCurve = WM.findNodeCurve(workspace, node.id, "demand");
        demandDaily[node.id] = demCurve
          ? TS.computeDailySeriesRange(demCurve, simStartDate, totalDays)
          : Array.from({ length: totalDays }, (_, d) => ({ day: d, date: TS.addDaysToIso(simStartDate, d), qty: 0 }));
      }
    }

    // 2. Resolve Production Batches
    const batchStates = {};
    const batchesReleasingByIdx = new Map();
    const batchRemaining = {};

    const sortedBatches = Object.values(workspace.batches).sort((a, b) => a.startDate.localeCompare(b.startDate) || a.id.localeCompare(b.id));
    for (const b of sortedBatches) {
      const src = workspace.nodes[b.sourceNodeId];
      if (!src || src.kind !== "source") continue;
      const computedQty = r4(WM.getBatchQuantity(workspace, b));
      const availDate = b.availableDate || TS.addDaysToIso(b.endDate, b.extraWaitDays ?? 0);

      const spanDays = Math.max(0, TS.diffIsoDays(b.startDate, b.endDate) || 0);
      for (let i = 0; i < spanDays; i++) {
        batchByProductionDate[src.id].set(TS.addDaysToIso(b.startDate, i), b.id);
      }

      batchStates[b.id] = {
        batchId: b.id,
        code: b.code,
        sourceNodeId: b.sourceNodeId,
        startDate: b.startDate,
        endDate: b.endDate,
        extraWaitDays: b.extraWaitDays || 0,
        availableDate: availDate,
        computedQty,
        plannedAllocatedQty: 0,
        actualDispatchedQty: 0,
        allocatedShipmentQty: 0,
        executedShipmentQty: 0,
        remainingBatchQty: computedQty,
        allocations: [],
        status: b.status || "planned"
      };
      batchRemaining[b.id] = computedQty;

      const relIdx = dateToIdx(availDate);
      if (relIdx !== null && relIdx >= anchorIdx && relIdx < totalDays) {
        if (!batchesReleasingByIdx.has(relIdx)) batchesReleasingByIdx.set(relIdx, []);
        batchesReleasingByIdx.get(relIdx).push({ batch: b, qty: computedQty });
      }
    }

    // 3. Resolve all shipments
    const shipmentStates = {};
    const shipmentsDepartingByIdx = new Map();
    const preAnchorDispatched = [];

    const activeShipments = Object.values(workspace.shipments)
      .sort((a, b) => (a.status === "confirmed" ? 0 : 1) - (b.status === "confirmed" ? 0 : 1) || a.departDate.localeCompare(b.departDate) || a.id.localeCompare(b.id));

    const validRoute = st => workspace.nodes[st.fromNodeId]?.kind === "source"
      && workspace.nodes[st.toNodeId]?.kind === "market";
    const blockInvalidRoute = st => {
      st.progressStatus = "blocked";
      st.conflictIds.push(addConflict({
        code: "ROUTE_INVALID", severity: "error", date: st.departDate, targetId: st.shipmentId,
        nodeId: st.fromNodeId, message: `Shipment ${st.code} has an invalid origin or destination`
      }));
    };

    for (const shp of activeShipments) {
      const dates = resolveShipmentDates(shp, factsByTarget, today, anchorDate);
      const depIdx = dateToIdx(dates.departDate);
      const putawayIdx = dateToIdx(dates.effectivePutawayDate);
      const sellableIdx = dateToIdx(dates.effectiveSellableDate);
      const borderIdx = dateToIdx(dates.effectiveBorderDate);
      const releaseIdx = dateToIdx(dates.effectiveReleaseDate);

      const st = {
        shipmentId: shp.id,
        code: shp.code,
        fromNodeId: shp.fromNodeId,
        toNodeId: shp.toNodeId,
        laneId: shp.laneId || null,
        batchId: shp.batchId || null,
        productId: shp.productId || null,
        qty: shp.qty,
        mode: shp.mode,
        carrier: shp.carrier || "",
        transitDays: shp.transitDays,
        status: shp.status,
        executed: false,
        executedQty: 0,
        ...dates,
        departIdx: depIdx,
        borderIdx,
        releaseIdx,
        putawayIdx,
        availableIdx: putawayIdx,
        sellableIdx,
        progressStatus: shp.status === "cancelled" ? "cancelled" : "planned",
        totalCost: 0,
        conflictIds: []
      };
      shipmentStates[shp.id] = st;

      if (shp.status === "cancelled") continue;

      // Track ALL active shipments bound to a batch (including planned future & cross-month shipments)
      if (shp.batchId && batchStates[shp.batchId]) {
        const bs = batchStates[shp.batchId];
        const isActual = hasActualMovement(st);
        if (isActual) bs.actualDispatchedQty = r4(bs.actualDispatchedQty + st.qty);
        else bs.plannedAllocatedQty = r4(bs.plannedAllocatedQty + st.qty);
        bs.allocatedShipmentQty = r4(bs.plannedAllocatedQty + bs.actualDispatchedQty);
        bs.remainingBatchQty = Math.max(0, r4(bs.computedQty - bs.allocatedShipmentQty));
        bs.allocations.push({
          shipmentId: shp.id,
          code: shp.code,
          toNodeId: shp.toNodeId,
          marketName: workspace.nodes[shp.toNodeId]?.name || shp.toNodeId,
          qty: st.qty,
          pct: bs.computedQty > 0 ? r2((st.qty / bs.computedQty) * 100) : 0,
          allocationPct: shp.allocationPct ?? null,
          status: shp.status,
          isActual,
          departDate: st.departDate,
          mode: shp.mode
        });
      }

      if (depIdx < anchorIdx) {
        if (!validRoute(st)) {
          blockInvalidRoute(st);
          continue;
        }
        if (!hasActualMovement(st)) {
          st.progressStatus = "blocked";
          st.conflictIds.push(addConflict({
            code: "PRE_ANCHOR_UNCONFIRMED", severity: "error", date: st.departDate, targetId: shp.id,
            message: `Shipment ${shp.code} is scheduled before the inventory anchor date`
          }));
          continue;
        }
        st.executed = true;
        st.executedQty = st.qty;
        if (shp.batchId && batchStates[shp.batchId]) {
          batchRemaining[shp.batchId] = Math.max(0, r4(batchRemaining[shp.batchId] - st.qty));
          batchStates[shp.batchId].executedShipmentQty = r4(batchStates[shp.batchId].executedShipmentQty + st.qty);
        }
        preAnchorDispatched.push({ shp, st });
      } else if (depIdx !== null && depIdx >= 0 && depIdx < totalDays) {
        if (!shipmentsDepartingByIdx.has(depIdx)) shipmentsDepartingByIdx.set(depIdx, []);
        shipmentsDepartingByIdx.get(depIdx).push({ shp, st });
      }
    }

    // 4. Initialize per-node balances (NO market waiting queue!)
    const nodeAvailable = {};      // Factories: shippable stock; Markets: sellable stock
    const nodeUnreleasedProd = {};
    const unreleasedByBatch = {};
    const nodeDaily = {};
    const marketTotals = {};

    for (const node of Object.values(workspace.nodes)) {
      nodeAvailable[node.id] = anchorIdx === 0 ? node.initialInventory ?? 0 : 0;
      nodeUnreleasedProd[node.id] = 0;
      nodeDaily[node.id] = [];
      if (node.kind === "market") {
        marketTotals[node.id] = {
          totalDemandView: 0,
          totalSatisfiedView: 0,
          totalGapView: 0,
          minAvailableView: Infinity,
          firstGapDate: null,
          gapWindows: []
        };
      }
    }

    const costs = {
      manufacturing: 0,
      freightFixed: 0,
      freightUnit: 0,
      customsAndImport: 0,
      localFulfillmentAndChannel: 0,
      total: 0,
      committedTotal: 0,
      projectedTotal: 0
    };

    const putawayByIdx = new Map();   // effectivePutawayDate -> physical putaway (NOT sellable yet!)
    const sellableByIdx = new Map();  // effectiveSellableDate (= putaway + 1) -> eligible to sell!
    const executedShipmentsList = [];

    const scheduleExecutedArrival = (st, dispatchDay = -1) => {
      // Goods that became sellable before the anchor are reflected in opening stock.
      const sellableDay = st.sellableIdx;
      if (sellableDay >= anchorIdx && sellableDay < totalDays) {
        if (!sellableByIdx.has(sellableDay)) sellableByIdx.set(sellableDay, []);
        sellableByIdx.get(sellableDay).push(st);
      }
      if (st.putawayIdx >= anchorIdx && st.putawayIdx > dispatchDay && st.putawayIdx < totalDays) {
        if (!putawayByIdx.has(st.putawayIdx)) putawayByIdx.set(st.putawayIdx, []);
        putawayByIdx.get(st.putawayIdx).push(st);
      }
    };

    const recordExecutedCosts = (shp, st) => {
      const fixed = shp.fixedCost ?? 0;
      const unit = (shp.unitCost ?? 0) * st.executedQty;
      const importFee = (shp.importFeeFixed ?? 0) + (shp.importFeePerUnit ?? 0) * st.executedQty;
      st.totalCost = r2(fixed + unit + importFee);
      costs.freightFixed = r2(costs.freightFixed + fixed);
      costs.freightUnit = r2(costs.freightUnit + unit);
      costs.customsAndImport = r2(costs.customsAndImport + importFee);
      if (hasActualMovement(st)) costs.committedTotal = r2(costs.committedTotal + st.totalCost);
      else costs.projectedTotal = r2(costs.projectedTotal + st.totalCost);
    };

    for (const { shp, st } of preAnchorDispatched) {
      executedShipmentsList.push(st);
      recordExecutedCosts(shp, st);
      scheduleExecutedArrival(st);
    }

    // 5. Day-by-day deterministic conservation loop
    for (let d = 0; d < totalDays; d++) {
      const dateIso = TS.addDaysToIso(simStartDate, d);
      const inViewWindow = d >= todayIdx && d <= viewEndIdx;

      const dayOpening = {};
      const dayReleasedProd = {};
      const daySellableIn = {};
      const dayPutawayIn = {};
      const dayDispatches = {};
      const daySatisfied = {};
      const dayAdjustments = {};
      const dayDemand = {};
      const dayGap = {};

      for (const nid of Object.keys(workspace.nodes)) {
        dayOpening[nid] = nodeAvailable[nid];
        dayReleasedProd[nid] = 0;
        daySellableIn[nid] = 0;
        dayPutawayIn[nid] = 0;
        dayDispatches[nid] = 0;
        daySatisfied[nid] = 0;
        dayAdjustments[nid] = 0;
        dayDemand[nid] = 0;
        dayGap[nid] = 0;
        if (d > 0 && d === anchorIdx) {
          const initial = workspace.nodes[nid].initialInventory ?? 0;
          nodeAvailable[nid] = initial;
          dayAdjustments[nid] = initial;
        }
      }

      // STEP 1: D+1 sellability and same-day putaway are separate events.
      for (const st of (sellableByIdx.get(d) || [])) {
        if (!workspace.nodes[st.toNodeId]) continue;
        nodeAvailable[st.toNodeId] = r4(nodeAvailable[st.toNodeId] + st.executedQty);
        daySellableIn[st.toNodeId] = r4(daySellableIn[st.toNodeId] + st.executedQty);
      }
      const recordPutaway = st => {
        if (workspace.nodes[st.toNodeId] && shipmentInventoryBucket(st, dateIso, today) === "shelvedPendingNextDay") {
          dayPutawayIn[st.toNodeId] = r4(dayPutawayIn[st.toNodeId] + st.executedQty);
        }
      };
      for (const st of (putawayByIdx.get(d) || [])) recordPutaway(st);

      // STEP 2: Factory production & batch release
      for (const node of Object.values(workspace.nodes)) {
        if (node.kind !== "source" || d < anchorIdx) continue;
        const pQty = productionDaily[node.id]?.[d]?.qty || 0;
        if (pQty > EPS) {
          const batchId = batchByProductionDate[node.id].get(dateIso);
          if (batchId) {
            // A confirmed batch can finish early. Its entire planned interval
            // is still reserved, but must not recreate work in progress later.
            if (dateIso < batchStates[batchId].availableDate) {
              unreleasedByBatch[batchId] = r4((unreleasedByBatch[batchId] || 0) + pQty);
              nodeUnreleasedProd[node.id] = r4(nodeUnreleasedProd[node.id] + pQty);
            }
          } else {
            nodeAvailable[node.id] = r4(nodeAvailable[node.id] + pQty);
            dayReleasedProd[node.id] = r4(dayReleasedProd[node.id] + pQty);
            const mc = pQty * unitMfgCost;
            costs.manufacturing = r2(costs.manufacturing + mc);
            costs.projectedTotal = r2(costs.projectedTotal + mc);
          }
        }
      }

      for (const item of (batchesReleasingByIdx.get(d) || [])) {
        const srcId = item.batch.sourceNodeId;
        if (!workspace.nodes[srcId]) continue;
        nodeAvailable[srcId] = r4(nodeAvailable[srcId] + item.qty);
        dayReleasedProd[srcId] = r4(dayReleasedProd[srcId] + item.qty);
        nodeUnreleasedProd[srcId] = r4(nodeUnreleasedProd[srcId] - (unreleasedByBatch[item.batch.id] || 0));
        const mc = item.qty * unitMfgCost;
        costs.manufacturing = r2(costs.manufacturing + mc);
        if (item.batch.status === "confirmed") costs.committedTotal = r2(costs.committedTotal + mc);
        else costs.projectedTotal = r2(costs.projectedTotal + mc);
      }

      // STEP 3: Validate & dispatch shipments departing on dateIso
      for (const { shp, st } of (shipmentsDepartingByIdx.get(d) || [])) {
        const origin = workspace.nodes[shp.fromNodeId];
        if (!validRoute(st)) {
          blockInvalidRoute(st);
          continue;
        }

        const actualDispatch = hasActualMovement(st);
        if (shp.batchId) {
          const bs = batchStates[shp.batchId];
          if (!bs || dateIso < bs.availableDate) {
            const cid = addConflict({
              code: "BATCH_NOT_RELEASED",
              severity: "error",
              date: dateIso,
              targetId: shp.id,
              nodeId: origin.id,
              message: `Shipment ${shp.code} departs ${dateIso}, before batch ${bs?.code || shp.batchId} is available (${bs?.availableDate || "—"})`
            });
            st.conflictIds.push(cid);
            if (!actualDispatch) {
              st.progressStatus = "blocked";
              continue;
            }
          } else if (st.qty > batchRemaining[shp.batchId] + EPS) {
            const cid = addConflict({
              code: "INSUFFICIENT_INVENTORY",
              severity: "error",
              date: dateIso,
              targetId: shp.id,
              nodeId: origin.id,
              message: `Insufficient remaining qty (${r2(batchRemaining[shp.batchId])}) in batch ${bs.code}`,
              shortfall: r2(st.qty - batchRemaining[shp.batchId])
            });
            st.conflictIds.push(cid);
            if (!actualDispatch) {
              st.progressStatus = "blocked";
              continue;
            }
          }
        }

        const avail = nodeAvailable[origin.id];
        if (st.qty > avail + EPS) {
          const cid = addConflict({
            code: "INSUFFICIENT_INVENTORY",
            severity: "error",
            date: dateIso,
            targetId: shp.id,
            nodeId: origin.id,
            message: `${origin.name} only has ${r2(avail)} available on ${dateIso}; cannot dispatch ${shp.code} (${r2(st.qty)})`,
            shortfall: r2(st.qty - avail)
          });
          st.conflictIds.push(cid);
          if (!actualDispatch) {
            st.progressStatus = "blocked";
            continue;
          }
          // Reconcile the modeled shortage explicitly while preserving the actual movement.
          dayAdjustments[origin.id] = r4(dayAdjustments[origin.id] + st.qty - avail);
          nodeAvailable[origin.id] = st.qty;
        }

        // Execute dispatch
        nodeAvailable[origin.id] = Math.max(0, r4(nodeAvailable[origin.id] - st.qty));
        dayDispatches[origin.id] = r4(dayDispatches[origin.id] + st.qty);
        st.executed = true;
        st.executedQty = st.qty;

        if (shp.batchId && batchStates[shp.batchId]) {
          batchRemaining[shp.batchId] = Math.max(0, r4(batchRemaining[shp.batchId] - st.qty));
          batchStates[shp.batchId].executedShipmentQty = r4(batchStates[shp.batchId].executedShipmentQty + st.qty);
        }

        // Zero-span shipments transfer to putaway after the same-day debit.
        if (st.putawayIdx === d) recordPutaway(st);
        scheduleExecutedArrival(st, d);
        executedShipmentsList.push(st);

        recordExecutedCosts(shp, st);
      }

      // STEP 4: Direct daily market demand matching against today's sellable stock ONLY (NO waiting queue!)
      for (const node of Object.values(workspace.nodes)) {
        if (node.kind !== "market") continue;
        const policy = node.marketPolicy || WM.defaultMarketPolicy();
        const dem = demandDaily[node.id]?.[d]?.qty || 0;
        dayDemand[node.id] = dem;
        if (d < anchorIdx) continue;

        const sellable = nodeAvailable[node.id];
        const satisfiedToday = r4(Math.min(dem, sellable));
        const gapToday = r4(Math.max(0, dem - sellable));

        nodeAvailable[node.id] = Math.max(0, r4(sellable - satisfiedToday));
        daySatisfied[node.id] = satisfiedToday;
        dayGap[node.id] = gapToday;

        if (inViewWindow) {
          const mt = marketTotals[node.id];
          mt.totalDemandView = r4(mt.totalDemandView + dem);
          mt.totalSatisfiedView = r4(mt.totalSatisfiedView + satisfiedToday);
          mt.totalGapView = r4(mt.totalGapView + gapToday);

          if (gapToday > EPS) {
            if (!mt.firstGapDate) mt.firstGapDate = dateIso;
            const prev = mt.gapWindows[mt.gapWindows.length - 1];
            if (prev && TS.diffIsoDays(prev.endDate, dateIso) === 1) {
              prev.endDate = dateIso;
              prev.peakShortfall = Math.max(prev.peakShortfall, gapToday);
              prev.gapQty = r4(prev.gapQty + gapToday);
              prev.lostQty = prev.gapQty;
            } else {
              mt.gapWindows.push({ startDate: dateIso, endDate: dateIso, peakShortfall: gapToday, gapQty: gapToday, lostQty: gapToday });
            }
          }
        }

        // Preserve financial unit fulfillment/channel/last-mile costs on satisfied volume
        if (satisfiedToday > EPS) {
          const localUnit = (policy.lastMileUnitCost ?? 0)
            + (policy.fulfillmentUnitCost ?? 0)
            + (policy.channelCommissionUnitCost ?? 0);
          const lc = r2(satisfiedToday * localUnit);
          costs.localFulfillmentAndChannel = r2(costs.localFulfillmentAndChannel + lc);
          costs.projectedTotal = r2(costs.projectedTotal + lc);
        }
      }

      // STEP 4b: End-of-day confirmed stocktake facts on dateIso (after same-day dispatches & demand consumption)
      for (const f of effectiveFacts) {
        if (d >= anchorIdx && f.kind === "inventory_stocktake" && f.date === dateIso && workspace.nodes[f.targetId]) {
          const targetQty = f.qty;
          const delta = r4(targetQty - nodeAvailable[f.targetId]);
          nodeAvailable[f.targetId] = targetQty;
          dayAdjustments[f.targetId] = r4(dayAdjustments[f.targetId] + delta);
        }
      }

      if (inViewWindow && d >= anchorIdx) {
        for (const node of Object.values(workspace.nodes)) {
          if (node.kind === "market" && marketTotals[node.id]) {
            marketTotals[node.id].minAvailableView = Math.min(marketTotals[node.id].minAvailableView, nodeAvailable[node.id]);
          }
        }
      }

      // STEP 5: Classify each quantity once, then roll up to market nodes.
      const pipelineByMarket = new Map();
      for (const st of executedShipmentsList) {
        const bucket = shipmentInventoryBucket(st, dateIso, today);
        if (!bucket) continue;
        if (!pipelineByMarket.has(st.toNodeId)) pipelineByMarket.set(st.toNodeId, emptyPipeline());
        addShipmentToPipeline(pipelineByMarket.get(st.toNodeId), st, bucket);
      }
      for (const node of Object.values(workspace.nodes)) {
        const nid = node.id;
        const pipeline = pipelineByMarket.get(nid) || emptyPipeline();

        const ending = nodeAvailable[nid];
        const expected = r4(dayOpening[nid] + dayReleasedProd[nid] + daySellableIn[nid] - dayDispatches[nid] - daySatisfied[nid] + dayAdjustments[nid]);
        const conservationDelta = r4(ending - expected);

        nodeDaily[nid].push({
          day: d,
          date: dateIso,
          openingAvailable: dayOpening[nid],
          releasedProduction: dayReleasedProd[nid],
          unreleasedProductionAccum: nodeUnreleasedProd[nid],
          arrivals: daySellableIn[nid],         // Newly sellable on day d (putaway D-1 -> sellable D)
          putawayArrivals: dayPutawayIn[nid],   // Newly shelved on day d (becomes sellable D+1)
          dispatches: dayDispatches[nid],
          satisfiedDemand: daySatisfied[nid],
          fulfilledConsumption: daySatisfied[nid],
          adjustments: dayAdjustments[nid],
          endingAvailable: ending,
          ...pipeline,
          demand: dayDemand[nid],
          demandGap: dayGap[nid],
          waitingDemand: 0,
          lostDemand: dayGap[nid],
          conservationDelta
        });
      }
    }

    // 6. The projected progress is retained for existing simulation clients.
    // Operational status and stock counts require a fact as of today.
    for (const st of Object.values(shipmentStates)) {
      st.inventoryBucket = shipmentInventoryBucket(st, today, today);
      const firstActual = firstActualMovement(st);
      st.dispatchBasis = firstActual && firstActual <= today && st.executed ? "confirmed"
        : st.executed && st.departDate <= today ? "projected" : "none";

      if (!st.executed || st.departDate > today) {
        st.overdueStage = null;
        st.overdueDueDate = null;
        st.overdueDays = 0;
      } else if (st.putawayCompleteActualDate && st.putawayCompleteActualDate <= today) {
        st.progressStatus = "available";
      } else if (st.overdueStage === "market_stock_available") {
        st.progressStatus = "overdue_putaway";
      } else if (st.inventoryBucket === "inCustoms") {
        st.progressStatus = "in_customs";
      } else if (st.overdueStage === "customs_release") {
        st.progressStatus = "overdue_customs";
      } else if (st.inventoryBucket === "atBorder") {
        st.progressStatus = "at_border";
      } else {
        st.progressStatus = st.overdueStage === "border_arrival" ? "overdue_border" : "in_transit";
      }
      st.operationalStatus = st.dispatchBasis === "projected" ? "dispatch_unconfirmed" : st.progressStatus;
      st.operationalOverdue = st.dispatchBasis === "confirmed" && Boolean(st.overdueStage);
    }

    // 7. Market summaries over [today .. today + viewHorizonDays - 1]
    const marketSummaries = {};
    const settledViewDays = Math.max(0, viewEndIdx - Math.max(todayIdx, anchorIdx) + 1);
    for (const node of Object.values(workspace.nodes)) {
      if (node.kind !== "market") continue;
      const mt = marketTotals[node.id];
      const daily = nodeDaily[node.id];
      const policy = node.marketPolicy || WM.defaultMarketPolicy();
      const todaySnap = daily[todayIdx] || {};
      const endSnap = daily[viewEndIdx] || {};
      const avgDailyDem = mt.totalDemandView > EPS ? mt.totalDemandView / settledViewDays : 0;
      const currentAvail = todaySnap.endingAvailable || 0;
      const daysOfCoverNow = avgDailyDem > EPS ? r2(currentAvail / avgDailyDem) : 999;
      const satisfactionRate = mt.totalDemandView > EPS ? r4(mt.totalSatisfiedView / mt.totalDemandView) : 1;

      marketSummaries[node.id] = {
        nodeId: node.id,
        name: node.name,
        region: node.region,
        priority: policy.priority,
        currentAvailable: today >= anchorDate ? r2(currentAvail) : null,
        shelvedPendingNextDay: r2(todaySnap.shelvedPendingNextDay || 0),
        endingAvailable: viewEndIdx >= anchorIdx ? r2(endSnap.endingAvailable || 0) : null,
        totalDemand: r2(mt.totalDemandView),
        totalSatisfied: r2(mt.totalSatisfiedView),
        totalDemandGap: r2(mt.totalGapView),
        demandSatisfactionRate: satisfactionRate,
        // Legacy aliases preserved
        totalFulfilled: r2(mt.totalSatisfiedView),
        totalLost: r2(mt.totalGapView),
        fulfillmentRate: satisfactionRate,
        minAvailable: settledViewDays > 0 ? r2(mt.minAvailableView) : null,
        daysOfCoverNow: today >= anchorDate ? daysOfCoverNow : null,
        firstGapDate: mt.firstGapDate,
        firstStockoutDate: mt.firstGapDate,
        gapWindows: mt.gapWindows,
        stockoutWindows: mt.gapWindows,
        ...summarizeReplenishments(shipmentStates, today, viewEndDate, { marketId: node.id })
      };
    }

    const corridors = summarizeCorridors(workspace, shipmentStates);

    // 9. Operational exceptions & upcoming events
    const exceptions = [];
    const upcomingEvents = [];
    const dayPlus7 = TS.addDaysToIso(today, 7);

    for (const st of Object.values(shipmentStates)) {
      if (st.status === "cancelled") continue;
      const toName = workspace.nodes[st.toNodeId]?.name || st.toNodeId;
      const fromName = workspace.nodes[st.fromNodeId]?.name || st.fromNodeId;

      if (st.operationalOverdue) {
        const stageLabel = st.overdueStage === "border_arrival" ? "Arrival Unconfirmed"
          : st.overdueStage === "customs_release" ? "Customs Unconfirmed"
          : "Putaway Unconfirmed";
        exceptions.push({
          id: `exc_${st.shipmentId}`,
          severity: "warn",
          kind: "overdue",
          date: st.overdueDueDate,
          title: `${st.code} · ${stageLabel} (${st.overdueDays}d overdue)`,
          detail: `${fromName} → ${toName} · ${r2(st.qty)} units`,
          target: { kind: "shipment", id: st.shipmentId }
        });
      }

      if (isExpectedPutaway(st, today, dayPlus7)) {
        upcomingEvents.push({
          id: `evt_put_${st.shipmentId}`,
          kind: "putaway",
          date: st.effectivePutawayDate,
          title: `${st.code} Est. Putaway at ${toName}`,
          detail: `${r2(st.qty)} units · Sellable ${st.effectiveSellableDate}`,
          target: { kind: "shipment", id: st.shipmentId }
        });
      } else if (st.executed && !firstDownstreamFact(st) && st.effectiveBorderDate >= today && st.effectiveBorderDate <= dayPlus7) {
        upcomingEvents.push({
          id: `evt_brd_${st.shipmentId}`,
          kind: "border",
          date: st.effectiveBorderDate,
          title: `${st.code} Est. Port Arrival (${toName})`,
          detail: `${r2(st.qty)} units · Putaway ${st.effectivePutawayDate} · Sellable ${st.effectiveSellableDate}`,
          target: { kind: "shipment", id: st.shipmentId }
        });
      }
    }

    for (const c of conflicts) {
      if (c.severity === "error") {
        exceptions.push({
          id: `exc_${c.id}`,
          severity: "danger",
          kind: c.code,
          date: c.date,
          title: c.message,
          detail: `Validation blocked`,
          target: workspace.shipments[c.targetId] ? { kind: "shipment", id: c.targetId } : { kind: "node", id: c.nodeId || c.targetId }
        });
      }
    }

    for (const m of Object.values(marketSummaries)) {
      if (m.firstGapDate) {
        exceptions.push({
          id: `exc_so_${m.nodeId}`,
          severity: "danger",
          kind: "stockout",
          date: m.firstGapDate,
          title: `${m.name} Projected Gap on ${m.firstGapDate}`,
          detail: `${m.daysOfCoverNow}d cover · Gap ${r2(m.totalDemandGap)} units · Fill ${Math.round(m.demandSatisfactionRate * 100)}%`,
          target: { kind: "node", id: m.nodeId }
        });
      }
    }

    exceptions.sort((a, b) => (a.severity === "danger" ? 0 : 1) - (b.severity === "danger" ? 0 : 1) || a.date.localeCompare(b.date));
    upcomingEvents.sort((a, b) => a.date.localeCompare(b.date));

    // 10. Today-centered KPIs
    costs.total = r2(costs.manufacturing + costs.freightFixed + costs.freightUnit + costs.customsAndImport + costs.localFulfillmentAndChannel);

    const simulation = {
      workspaceId: workspace.workspaceId,
      revision: workspace.revision,
      today,
      inventoryAnchorDate: anchorDate,
      simStartDate,
      simEndDate,
      todayIdx,
      viewEndIdx,
      viewEndDate,
      viewHorizonDays,
      nodeDaily,
      marketSummaries,
      shipmentStates,
      batchStates,
      corridors,
      exceptions,
      upcomingEvents,
      costs,
      conflicts
    };
    const { kpis, customsHoldCount, overduePlannedCount } = summarizeDashboard(workspace, simulation);
    simulation.kpis = kpis;
    simulation.shipmentCounts = { customsHoldCount, overduePlannedCount };
    return simulation;
  }

  function summarizeCorridors(workspace, shipmentStates, filters = {}) {
    const corridors = {};
    const ensureCorridor = (fromId, toId) => {
      const key = `${fromId}__${toId}`;
      if (!corridors[key]) {
        corridors[key] = {
          key,
          fromNodeId: fromId,
          toNodeId: toId,
          laneIds: [],
          shipmentIds: [],
          activeCount: 0,
          inTransitQty: 0,
          customsQty: 0,
          customsCount: 0,
          shelvedPendingNextDay: 0,
          projectedInPipeline: 0,
          overdueCount: 0,
          blockedCount: 0
        };
      }
      return corridors[key];
    };

    for (const lane of Object.values(workspace.lanes || {})) {
      if (!filters.productId && matchesShipmentScope(lane, filters)
          && workspace.nodes[lane.fromNodeId] && workspace.nodes[lane.toNodeId]) {
        ensureCorridor(lane.fromNodeId, lane.toNodeId).laneIds.push(lane.id);
      }
    }
    for (const st of Object.values(shipmentStates)) {
      if (st.status === "cancelled" || !matchesShipmentScope(st, filters)) continue;
      if (!workspace.nodes[st.fromNodeId] || !workspace.nodes[st.toNodeId]) continue;
      const cor = ensureCorridor(st.fromNodeId, st.toNodeId);
      cor.shipmentIds.push(st.shipmentId);
      cor.activeCount += 1;
      if (st.inventoryBucket === "inTransitInbound") cor.inTransitQty = r4(cor.inTransitQty + st.executedQty);
      if (st.inventoryBucket === "atBorder" || st.inventoryBucket === "inCustoms") {
        cor.customsQty = r4(cor.customsQty + st.executedQty);
        cor.customsCount += 1;
      }
      if (st.inventoryBucket === "shelvedPendingNextDay" || st.inventoryBucket === "projectedInPipeline") {
        addShipmentToPipeline(cor, st, st.inventoryBucket);
      }
      if (st.operationalOverdue) cor.overdueCount += 1;
      if (st.operationalStatus === "blocked") cor.blockedCount += 1;
    }
    return corridors;
  }

  function isExpectedPutaway(st, fromDate, toDate) {
    return st.executed && !st.putawayCompleteActualDate
      && st.effectivePutawayDate >= fromDate && st.effectivePutawayDate <= toDate;
  }

  function listReplenishments(shipmentStates, today, viewEndDate, filters) {
    return Object.values(shipmentStates)
      .filter(st => st.executed && st.effectiveSellableDate > today && st.effectiveSellableDate <= viewEndDate
        && matchesShipmentScope(st, filters))
      .sort((a, b) => a.effectiveSellableDate.localeCompare(b.effectiveSellableDate));
  }

  function summarizeReplenishments(shipmentStates, today, viewEndDate, filters) {
    const incoming = listReplenishments(shipmentStates, today, viewEndDate, filters);
    return {
      incomingCount: incoming.length,
      incomingQty: r2(incoming.reduce((qty, st) => qty + st.executedQty, 0)),
      nextPutawayDate: incoming[0]?.effectivePutawayDate || null,
      nextSellableDate: incoming[0]?.effectiveSellableDate || null,
      nextArrivalDate: incoming[0]?.effectiveSellableDate || null
    };
  }

  function summarizeShipmentFlow(shipments, simulation, date = simulation.today) {
    const totals = emptyPipeline();
    let arrivals = 0;
    let putawayArrivals = 0;
    for (const st of shipments) {
      const bucket = date === simulation.today ? st.inventoryBucket : shipmentInventoryBucket(st, date, simulation.today);
      addShipmentToPipeline(totals, st, bucket);
      if (date < simulation.inventoryAnchorDate) continue;
      if (st.executed && date === st.effectiveSellableDate) arrivals = r4(arrivals + st.executedQty);
      if (bucket === "shelvedPendingNextDay") putawayArrivals = r4(putawayArrivals + st.executedQty);
    }
    return { ...totals, arrivals, putawayArrivals };
  }

  function summarizeDashboard(workspace, simulation, filters = {}) {
    const factoryId = filters.factoryId === "all" ? null : filters.factoryId;
    const marketId = filters.marketId === "all" ? null : filters.marketId;
    const productId = filters.productId;
    const scoped = Boolean(factoryId || marketId || productId);
    const shipments = Object.values(simulation.shipmentStates)
      .filter(st => st.status !== "cancelled" && matchesShipmentScope(st, filters));
    const selectNode = node => node?.kind === "source"
      ? !marketId && (!factoryId || node.id === factoryId)
      : node?.kind === "market" && !factoryId && (!marketId || node.id === marketId);

    // Node balances and demand curves have no SKU dimension. A SKU-specific
    // attribution is safe only when the workspace has one known SKU.
    const productIds = Object.keys(workspace.products);
    const hasNodeProductScope = !productId || (productIds.length === 1 && productIds[0] === productId
      && !Object.values(simulation.shipmentStates).some(st => st.productId && st.productId !== productId)
      && !Object.values(workspace.batches).some(b => b.productId && b.productId !== productId));
    const nodeStockAttributable = hasNodeProductScope && !(factoryId && marketId)
      && simulation.today >= simulation.inventoryAnchorDate;
    const nodeSnapshots = nodeStockAttributable ? Object.values(workspace.nodes)
      .filter(selectNode).map(node => simulation.nodeDaily[node.id][simulation.todayIdx]) : [];
    const sumSnapshot = key => nodeStockAttributable
      ? r2(nodeSnapshots.reduce((sum, row) => sum + row[key], 0)) : null;

    const markets = Object.values(simulation.marketSummaries)
      .filter(m => !marketId || m.nodeId === marketId)
      .map(m => scoped ? {
        ...m,
        // Demand belongs to the market. Only attributable inventory or
        // replenishments are included under a factory/route/SKU scope.
        ...(factoryId || !hasNodeProductScope ? {
          currentAvailable: null, endingAvailable: null, minAvailable: null, daysOfCoverNow: null
        } : {}),
        ...summarizeReplenishments(simulation.shipmentStates, simulation.today, simulation.viewEndDate, { ...filters, marketId: m.nodeId }),
        shelvedPendingNextDay: r2(summarizeShipmentFlow(shipments.filter(st => st.toNodeId === m.nodeId), simulation).shelvedPendingNextDay)
      } : m);
    const shipmentIds = new Set(shipments.map(st => st.shipmentId));
    const exceptions = simulation.exceptions.filter(e => {
      if (e.target.kind === "shipment") return shipmentIds.has(e.target.id);
      const node = workspace.nodes[e.target.id];
      // Stockout risk remains the aggregate market context.
      if (node?.kind === "market" && e.kind === "stockout") return !marketId || node.id === marketId;
      return hasNodeProductScope && selectNode(node);
    });
    const upcomingEvents = simulation.upcomingEvents.filter(e => shipmentIds.has(e.target.id));
    const flow = summarizeShipmentFlow(shipments, simulation);
    const dayPlus7 = getTS().addDaysToIso(simulation.today, 7);
    const costs = simulation.costs;

    return {
      markets,
      shipments,
      exceptions,
      upcomingEvents,
      nodeStockAttributable,
      hasNodeProductScope,
      customsHoldCount: shipments.filter(st => st.inventoryBucket === "atBorder").length,
      overduePlannedCount: shipments.filter(st => st.dispatchBasis !== "confirmed" && st.departDate < simulation.today).length,
      kpis: {
        currentAvailableInventory: sumSnapshot("endingAvailable"),
        currentInTransit: r2(flow.inTransitInbound),
        awaitingCustoms: r2(flow.atBorder + flow.inCustoms),
        shelvedPendingNextDay: r2(flow.shelvedPendingNextDay),
        projectedInPipeline: r2(flow.projectedInPipeline),
        unreleasedProduction: sumSnapshot("unreleasedProductionAccum"),
        next7DaysExpectedArrivals: r2(shipments.filter(st => isExpectedPutaway(st, simulation.today, dayPlus7))
          .reduce((qty, st) => qty + st.executedQty, 0)),
        marketsAtRiskCount: markets.filter(m => m.firstGapDate !== null).length,
        pendingExceptionsCount: exceptions.length,
        totalLogisticsCost: scoped ? r2(shipments.reduce((cost, st) => cost + st.totalCost, 0))
          : r2(costs.freightFixed + costs.freightUnit + costs.customsAndImport),
        totalAllInCost: scoped ? null : costs.total
      }
    };
  }

  /**
   * 统一结构化发运单检索函数（供物流页面列表与未来 AI 共用）。
   * 支持组合：工厂、市场、状态、关键词、全程时间消耗比例区间、关键里程碑日期阈值（区分预计与实际）。
   */
  function queryShipments(workspace, simulation, filters) {
    const f = filters || {};
    const all = Object.values(workspace.shipments || {}).filter(s => s.status !== "cancelled");
    const q = String(f.query || "").trim().toLowerCase();
    const minPct = (f.elapsedMin !== "" && f.elapsedMin !== null && f.elapsedMin !== undefined && Number.isFinite(Number(f.elapsedMin)))
      ? Number(f.elapsedMin) : null;
    const maxPct = (f.elapsedMax !== "" && f.elapsedMax !== null && f.elapsedMax !== undefined && Number.isFinite(Number(f.elapsedMax)))
      ? Number(f.elapsedMax) : null;

    const statusMatch = (st, status) => {
      if (!status || status === "all") return true;
      if (status === "in_transit") return st.inventoryBucket === "inTransitInbound";
      if (status === "customs") return st.inventoryBucket === "atBorder" || st.inventoryBucket === "inCustoms";
      if (status === "overdue") return st.operationalOverdue;
      return st.operationalStatus === status;
    };

    const pickMilestoneDate = (st, field, source) => {
      const dates = {
        border: [st.borderArrivalPlannedDate, st.borderArrivalActualDate, st.effectiveBorderDate],
        customs: [st.customsReleasePlannedDate, st.customsReleaseActualDate, st.effectiveReleaseDate],
        putaway: [st.putawayCompletePlannedDate, st.putawayCompleteActualDate, st.effectivePutawayDate],
        sellable: [st.earliestSellablePlannedDate, st.earliestSellableActualDate, st.effectiveSellableDate]
      };
      const [planned, actual, effective] = dates[field] || [];
      if (source === "actual") return actual;
      if (source === "planned") return planned;
      if (source === "estimated") return effective;
      return actual || planned;
    };

    return all
      .filter(s => {
        const st = simulation.shipmentStates[s.id];
        if (!st || !matchesShipmentScope(st, f) || !statusMatch(st, f.status)) return false;

        if (minPct !== null && st.fullCycleElapsedPct < minPct) return false;
        if (maxPct !== null && st.fullCycleElapsedPct > maxPct) return false;

        if (f.dateThreshold && f.milestoneField) {
          const dt = pickMilestoneDate(st, f.milestoneField, f.dateSource || "any");
          if (!dt) return false;
          const op = f.dateOp || "on_or_before";
          if (op === "before" && !(dt < f.dateThreshold)) return false;
          if (op === "on_or_before" && !(dt <= f.dateThreshold)) return false;
          if (op === "after" && !(dt > f.dateThreshold)) return false;
          if (op === "on_or_after" && !(dt >= f.dateThreshold)) return false;
        }

        if (q) {
          const hay = [
            s.code, s.carrier, s.blNumber, s.trackingNumber, s.originPort, s.destinationPort,
            workspace.nodes[s.fromNodeId]?.name, workspace.nodes[s.toNodeId]?.name
          ].join(" ").toLowerCase();
          if (!hay.includes(q)) return false;
        }
        return true;
      })
      .sort((a, b) => {
        const sa = simulation.shipmentStates[a.id], sb = simulation.shipmentStates[b.id];
        return Number(sb.operationalOverdue) - Number(sa.operationalOverdue) || sa.departDate.localeCompare(sb.departDate);
      });
  }

  const SimEngine = {
    getEffectiveFacts,
    resolveShipmentDates,
    simulateWorkspace,
    summarizeDashboard,
    summarizeCorridors,
    summarizeShipmentFlow,
    listReplenishments,
    queryShipments
  };

  global.SC = global.SC || {};
  global.SC.SimEngine = SimEngine;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = SimEngine;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
