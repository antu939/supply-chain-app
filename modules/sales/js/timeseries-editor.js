(function (global) {
  "use strict";

  const getTS = () => global.SC.TimeSeries;
  const getWM = () => global.SC.WorldModel;

  const fmtNum = (n, maxD = 1) => Number(n || 0).toLocaleString("en-US", { maximumFractionDigits: maxD });
  const esc = t => String(t ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  /**
   * 函数式时间序列编辑器（原点严格锁定为本地今天，用户可为每条曲线独立决定时间跨度）
   */
  function mountTimeSeriesEditor(container, ctx) {
    if (!container) return;
    const TS = getTS();
    const WM = getWM();

    const {
      workspace,
      today,
      curveId,
      batches,
      editorState,
      onDispatch,
      onOpenCsvImport,
      onCreateBatchFromRange,
      onOpenSegmentDialog,
      onLocalRefresh
    } = ctx;

    const curve = workspace.curves[curveId];
    if (!curve) {
      container.innerHTML = `<div class="empty-card">No curve data available</div>`;
      return;
    }

    const isSupply = curve.kind === "production";
    const unitLabel = workspace.products[workspace.activeProductId]?.unit || "units";

    if (editorState.curveId !== curveId) {
      editorState.curveId = curveId;
      editorState.selectedPointId = null;
      editorState.selectedSegmentId = null;
      editorState.brush = null;
    }

    // 坐标原点永远锁定为「今天」，自动随自然日推进；长度由当前曲线自身 horizonDays 决定
    const viewStartDate = today;
    const viewSpan = curve.horizonDays ?? 30;
    const viewEndDate = TS.addDaysToIso(viewStartDate, viewSpan);
    const toolMode = editorState.toolMode || "rate";
    const selectedPointId = editorState.selectedPointId || null;
    const selectedSegmentId = editorState.selectedSegmentId || null;
    const brush = editorState.brush || null;

    const daily = TS.computeDailySeriesRange(curve, viewStartDate, viewSpan);
    let maxVal = 80;
    for (const pt of curve.points) {
      if (pt.date >= viewStartDate && pt.date <= viewEndDate) maxVal = Math.max(maxVal, pt.rate);
    }
    for (const d of daily) maxVal = Math.max(maxVal, d.rateAvg);
    const yMax = Math.max(50, Math.ceil((maxVal * 1.22) / 50) * 50);

    const W = Math.max(600, container.clientWidth || 820);
    const height = 316;
    const pad = { top: 24, right: 24, bottom: 40, left: 56 };
    const plotW = W - pad.left - pad.right;
    const plotH = height - pad.top - pad.bottom;

    const offsetToX = off => pad.left + (off / viewSpan) * plotW;
    const xToOffset = x => ((x - pad.left) / plotW) * viewSpan;
    const rateToY = r => pad.top + plotH - (Math.max(0, Math.min(yMax, r)) / yMax) * plotH;
    const yToRate = y => Math.max(0, ((pad.top + plotH - y) / plotH) * yMax);

    const buildCurvePointsAttr = (targetCurve) => {
      const steps = Math.max(120, Math.min(320, viewSpan * 3));
      const linePts = [];
      const areaPts = [`${offsetToX(0).toFixed(1)},${(pad.top + plotH).toFixed(1)}`];
      for (let i = 0; i <= steps; i++) {
        const t = (viewSpan * i) / steps;
        const sampleT = i === steps ? Math.max(0, t - 1e-4) : t + 1e-5;
        const r = TS.evaluateRateAtOffset(targetCurve, viewStartDate, sampleT);
        const sx = offsetToX(t).toFixed(1);
        const sy = rateToY(r).toFixed(1);
        linePts.push(`${sx},${sy}`);
        areaPts.push(`${sx},${sy}`);
      }
      areaPts.push(`${offsetToX(viewSpan).toFixed(1)},${(pad.top + plotH).toFixed(1)}`);
      return { lineAttr: linePts.join(" "), areaAttr: areaPts.join(" ") };
    };

    const { lineAttr, areaAttr } = buildCurvePointsAttr(curve);
    const totalIntegral = TS.integrateCurveByDates(curve, viewStartDate, viewEndDate);
    const brushIntegral = brush && brush.endDate > brush.startDate
      ? TS.integrateCurveByDates(curve, brush.startDate, brush.endDate)
      : null;

    // Y Grid
    const yTicks = 4;
    let yGridHtml = "";
    for (let i = 0; i <= yTicks; i++) {
      const val = (yMax / yTicks) * i;
      const y = rateToY(val);
      yGridHtml += `<line class="ts-grid-line" x1="${pad.left}" y1="${y.toFixed(1)}" x2="${W - pad.right}" y2="${y.toFixed(1)}"/>
        <text class="ts-axis-label" x="${pad.left - 8}" y="${(y + 3.5).toFixed(1)}" text-anchor="end">${Math.round(val)}</text>`;
    }

    // X Grid (Origin = Today)
    const xStep = viewSpan <= 20 ? 2 : viewSpan <= 45 ? 5 : viewSpan <= 100 ? 10 : viewSpan <= 200 ? 20 : 30;
    let xGridHtml = "";
    for (let off = 0; off <= viewSpan; off += xStep) {
      const x = offsetToX(off);
      const iso = TS.addDaysToIso(viewStartDate, off);
      const label = off === 0 ? `Today ${TS.formatShortDate(iso)}` : TS.formatShortDate(iso);
      xGridHtml += `<line class="ts-grid-line vertical" x1="${x.toFixed(1)}" y1="${pad.top}" x2="${x.toFixed(1)}" y2="${pad.top + plotH}"/>
        <text class="ts-axis-label ${off === 0 ? "is-origin" : ""}" x="${x.toFixed(1)}" y="${pad.top + plotH + 17}" text-anchor="${off === 0 ? "start" : "middle"}">${label}</text>`;
    }

    // Total Mode segments
    const projectedSegs = TS.projectSegments(curve.totalSegments, viewStartDate);
    let segHtml = "";
    for (const seg of projectedSegs) {
      if (seg.endDay <= 0 || seg.startDay >= viewSpan) continue;
      const sClamped = Math.max(0, seg.startDay);
      const eClamped = Math.min(viewSpan, seg.endDay);
      const x0 = offsetToX(sClamped);
      const x1 = offsetToX(eClamped);
      const segW = Math.max(4, x1 - x0);
      const isSel = selectedSegmentId === seg.id;

      const buildSegPoly = (sObj) => {
        const pts = [`${x0.toFixed(1)},${(pad.top + plotH).toFixed(1)}`];
        for (let i = 0; i <= 28; i++) {
          const t = sClamped + ((eClamped - sClamped) * i) / 28;
          const r = TS.evalTotalSegmentRate(sObj, Math.min(sObj.endDay - 1e-4, t));
          pts.push(`${offsetToX(t).toFixed(1)},${rateToY(r).toFixed(1)}`);
        }
        pts.push(`${x1.toFixed(1)},${(pad.top + plotH).toFixed(1)}`);
        return pts.join(" ");
      };

      let anchorHtml = "";
      if (seg.distribution === "custom") {
        const anchors = TS.normalizeShapeAnchors(seg.shapeAnchors);
        anchors.forEach((anc, idx) => {
          const td = seg.startDay + anc.t * (seg.endDay - seg.startDay);
          if (td < 0 || td > viewSpan) return;
          const r = TS.evalTotalSegmentRate(seg, Math.min(seg.endDay - 1e-4, td));
          const ax = offsetToX(td);
          const ay = rateToY(r);
          anchorHtml += `<g class="ts-shape-handle" data-seg-id="${seg.id}" data-anchor-idx="${idx}">
            <circle class="ts-point-hit" cx="${ax.toFixed(1)}" cy="${ay.toFixed(1)}" r="15"/>
            <rect class="ts-shape-anchor" x="${(ax - 4).toFixed(1)}" y="${(ay - 4).toFixed(1)}" width="8" height="8" rx="1.5" transform="rotate(45 ${ax.toFixed(1)} ${ay.toFixed(1)})"/>
          </g>`;
        });
      }

      const cx = (x0 + x1) / 2;
      const pillLabel = `${fmtNum(seg.totalQty, 0)} ${unitLabel} · ${seg.distribution === "custom" ? "Custom" : "Uniform"}`;
      const pillW = Math.max(96, pillLabel.length * 6.8 + 16);

      segHtml += `
        <g class="ts-total-seg ${isSel ? "is-selected" : ""}" data-seg-group="${seg.id}">
          <rect class="ts-total-bg" x="${x0.toFixed(1)}" y="${pad.top}" width="${segW.toFixed(1)}" height="${plotH}" fill="url(#tsHatch)"/>
          <polygon class="ts-total-area" data-seg-poly="${seg.id}" points="${buildSegPoly(seg)}"/>
          <line class="ts-total-bound" x1="${x0.toFixed(1)}" y1="${pad.top}" x2="${x0.toFixed(1)}" y2="${pad.top + plotH}"/>
          <line class="ts-total-bound" x1="${x1.toFixed(1)}" y1="${pad.top}" x2="${x1.toFixed(1)}" y2="${pad.top + plotH}"/>
          <g class="ts-total-pill" data-select-seg="${seg.id}">
            <rect x="${(cx - pillW / 2).toFixed(1)}" y="${pad.top + 6}" width="${pillW.toFixed(1)}" height="20" rx="10"/>
            <text x="${cx.toFixed(1)}" y="${pad.top + 19.2}" text-anchor="middle">${esc(pillLabel)}</text>
          </g>
          ${anchorHtml}
        </g>`;
    }

    // Imported verified daily actuals
    let actualsHtml = "";
    for (const act of (curve.importedDailyActuals || [])) {
      const off = TS.diffIsoDays(viewStartDate, act.date);
      if (off === null || off + 1 <= 0 || off >= viewSpan) continue;
      const x0 = offsetToX(Math.max(0, off));
      const x1 = offsetToX(Math.min(viewSpan, off + 1));
      const y = rateToY(act.qty);
      actualsHtml += `<rect class="ts-actual-bar" x="${(x0 + 1).toFixed(1)}" y="${y.toFixed(1)}" width="${Math.max(3, x1 - x0 - 2).toFixed(1)}" height="${Math.max(1, pad.top + plotH - y).toFixed(1)}" rx="1.5">
        <title>${act.date}: ${act.qty} ${unitLabel}/day</title>
      </rect>`;
    }

    // Batches strip
    let batchHtml = "";
    if (isSupply && Array.isArray(batches) && batches.length) {
      for (const b of batches) {
        const sOff = TS.diffIsoDays(viewStartDate, b.startDate);
        const eOff = TS.diffIsoDays(viewStartDate, b.endDate);
        if (sOff === null || eOff === null || eOff <= 0 || sOff >= viewSpan) continue;
        const bx0 = offsetToX(Math.max(0, sOff));
        const bx1 = offsetToX(Math.min(viewSpan, eOff));
        batchHtml += `<g class="ts-batch-strip">
          <rect x="${bx0.toFixed(1)}" y="${pad.top + plotH - 5}" width="${Math.max(8, bx1 - bx0).toFixed(1)}" height="3.5" rx="1.75"/>
          <title>${b.code} (${b.startDate} – ${b.endDate} · ${fmtNum(b.computedQty, 0)} ${unitLabel})</title>
        </g>`;
      }
    }

    // Brush overlay
    let brushHtml = "";
    if (brush && brush.endDate > brush.startDate) {
      const b0 = TS.diffIsoDays(viewStartDate, brush.startDate);
      const b1 = TS.diffIsoDays(viewStartDate, brush.endDate);
      if (b0 !== null && b1 !== null && b1 > 0 && b0 < viewSpan) {
        const bx0 = offsetToX(Math.max(0, b0));
        const bx1 = offsetToX(Math.min(viewSpan, b1));
        brushHtml = `<rect class="ts-brush-rect" x="${bx0.toFixed(1)}" y="${pad.top}" width="${Math.max(2, bx1 - bx0).toFixed(1)}" height="${plotH}"/>`;
      }
    }

    // Rate Mode control points (delicate r=3.8 visual dot + generous r=16 hit area)
    const projectedPts = TS.projectPoints(curve.points, viewStartDate);
    let pointsHtml = "";
    for (const pt of projectedPts) {
      if (pt.day < 0 || pt.day > viewSpan) continue;
      const covered = projectedSegs.some(s => pt.day >= s.startDay && pt.day < s.endDay);
      const px = offsetToX(pt.day);
      const py = rateToY(pt.rate);
      const isSel = selectedPointId === pt.id;
      pointsHtml += `<g class="ts-point ${isSel ? "is-selected" : ""} ${covered ? "is-covered" : ""}" data-point-id="${pt.id}">
        <circle class="ts-point-hit" cx="${px.toFixed(1)}" cy="${py.toFixed(1)}" r="16"/>
        <circle class="ts-point-dot" cx="${px.toFixed(1)}" cy="${py.toFixed(1)}" r="${isSel ? 4.8 : 3.8}"/>
        <text class="ts-point-tag" x="${px.toFixed(1)}" y="${(py - 10).toFixed(1)}" text-anchor="middle">${Math.round(pt.rate)}</text>
      </g>`;
    }

    // Inline contextual bar
    const selPt = projectedPts.find(p => p.id === selectedPointId);
    const selSeg = projectedSegs.find(s => s.id === selectedSegmentId);
    let detailBarHtml = "";

    if (brush && brush.endDate > brush.startDate) {
      detailBarHtml = `
        <div class="ts-selection-bar">
          <div class="ts-selection-copy">
            <span class="pill-tag accent">${brush.startDate} ~ ${brush.endDate}</span>
            <span>Total <strong>${fmtNum(brushIntegral, 1)}</strong> ${unitLabel}</span>
          </div>
          <div class="ts-selection-actions">
            <button type="button" class="btn small" data-ts-action="convert-total">Set Range Total</button>
            ${isSupply ? `<button type="button" class="btn small primary" data-ts-action="create-batch">Create Batch</button>` : ""}
            <button type="button" class="btn small ghost" data-ts-action="clear-brush">Cancel</button>
          </div>
        </div>`;
    } else if (selSeg) {
      detailBarHtml = `
        <div class="ts-selection-bar is-total">
          <div class="ts-selection-copy">
            <span class="pill-tag ochre">${selSeg.startDate} ~ ${selSeg.endDate}</span>
            <label class="inline-num">Total <input type="number" min="0" step="any" value="${selSeg.totalQty}" data-seg-total-input="${selSeg.id}"> ${unitLabel}</label>
          </div>
          <div class="ts-selection-actions">
            <button type="button" class="btn small" data-ts-action="toggle-seg-dist" data-seg-id="${selSeg.id}">${selSeg.distribution === "custom" ? "Switch to Uniform" : "Custom Shape"}</button>
            <button type="button" class="btn small ghost danger" data-ts-action="remove-seg" data-seg-id="${selSeg.id}">Revert to Rate</button>
          </div>
        </div>`;
    } else if (selPt) {
      detailBarHtml = `
        <div class="ts-selection-bar">
          <div class="ts-selection-copy">
            <label class="inline-num">Date <input type="date" min="${viewStartDate}" max="${viewEndDate}" value="${selPt.date}" data-pt-date-input="${selPt.id}"></label>
            <label class="inline-num">${isSupply ? "Daily Output" : "Daily Demand"} <input type="number" min="0" step="any" value="${selPt.rate}" data-pt-rate-input="${selPt.id}"> ${unitLabel}/day</label>
          </div>
          <div class="ts-selection-actions">
            <button type="button" class="btn small primary" data-ts-action="apply-pt-edit" data-pt-id="${selPt.id}">Apply</button>
            <button type="button" class="btn small ghost danger" data-ts-action="delete-pt" data-pt-id="${selPt.id}">Delete</button>
          </div>
        </div>`;
    }

    const accentClass = isSupply ? "is-supply" : "is-demand";
    const presetSpans = [
      { days: 30, label: "1M" },
      { days: 60, label: "2M" },
      { days: 90, label: "3M" },
      { days: 180, label: "6M" }
    ];

    container.innerHTML = `
      <div class="ts-editor ${accentClass}">
        <div class="ts-toolbar">
          <div class="ts-toolbar-left">
            <div class="seg-pills" role="group">
              <button type="button" class="${toolMode === "rate" ? "active" : ""}" data-ts-mode="rate">Rate Points</button>
              <button type="button" class="${toolMode === "brush" ? "active" : ""}" data-ts-mode="brush">Select Range</button>
            </div>
            <span class="ts-summary-badge">
              Next ${viewSpan}d Total <strong data-ts-total="1">${fmtNum(totalIntegral, 0)}</strong> ${unitLabel}
            </span>
          </div>
          <div class="ts-toolbar-right">
            <div class="span-control" role="group" aria-label="Curve Horizon">
              ${presetSpans.map(ps => `<button type="button" class="span-pill ${viewSpan === ps.days ? "active" : ""}" data-set-span="${ps.days}">${ps.label}</button>`).join("")}
              <label class="span-custom"><input type="number" min="7" max="365" value="${viewSpan}" data-custom-span="1" aria-label="Custom Days"><span>d</span></label>
            </div>
            <button type="button" class="btn small" data-ts-action="import-csv">Import CSV</button>
          </div>
        </div>

        <div class="ts-canvas-wrap">
          <svg class="ts-svg" width="100%" height="${height}" viewBox="0 0 ${W} ${height}" data-ts-svg="1">
            <defs>
              <pattern id="tsHatch" width="8" height="8" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
                <line x1="0" y1="0" x2="0" y2="8" stroke="#c99a5b" stroke-width="0.9" stroke-opacity="0.20"/>
              </pattern>
            </defs>

            <text class="ts-unit-label" x="${pad.left}" y="13">${isSupply ? `${unitLabel}/day` : `Demand (${unitLabel}/day)`}</text>

            <g class="ts-grid">${yGridHtml}${xGridHtml}</g>
            <line class="ts-axis-base" x1="${pad.left}" y1="${pad.top + plotH}" x2="${W - pad.right}" y2="${pad.top + plotH}"/>
            <line class="ts-axis-base" x1="${pad.left}" y1="${pad.top}" x2="${pad.left}" y2="${pad.top + plotH}"/>

            ${segHtml}

            <polygon class="ts-area-fill" data-ts-area="1" points="${areaAttr}"/>
            ${actualsHtml}
            <polyline class="ts-curve-line" data-ts-line="1" points="${lineAttr}"/>

            ${brushHtml}
            ${batchHtml}

            <g class="ts-crosshair hidden" data-crosshair="1">
              <line class="ts-cross-v" x1="0" y1="${pad.top}" x2="0" y2="${pad.top + plotH}"/>
              <circle class="ts-cross-dot" cx="0" cy="0" r="2.8"/>
            </g>

            ${pointsHtml}
          </svg>
          <div class="ts-hover-readout hidden" data-readout="1"></div>
        </div>

        ${detailBarHtml}
      </div>
    `;

    const svg = container.querySelector("[data-ts-svg]");
    const lineEl = container.querySelector("[data-ts-line]");
    const areaEl = container.querySelector("[data-ts-area]");
    const totalEl = container.querySelector("[data-ts-total]");
    const crosshair = container.querySelector("[data-crosshair]");
    const crossV = crosshair?.querySelector(".ts-cross-v");
    const crossDot = crosshair?.querySelector(".ts-cross-dot");
    const readout = container.querySelector("[data-readout]");

    const toSvgCoords = ev => {
      const rect = svg.getBoundingClientRect();
      return {
        sx: ((ev.clientX - rect.left) / rect.width) * W,
        sy: ((ev.clientY - rect.top) / rect.height) * height
      };
    };

    container.querySelectorAll("[data-ts-mode]").forEach(btn => {
      btn.addEventListener("click", () => {
        editorState.toolMode = btn.dataset.tsMode;
        editorState.brush = null;
        onLocalRefresh();
      });
    });

    // Per-curve duration presets & custom days input
    container.querySelectorAll("[data-set-span]").forEach(btn => {
      btn.addEventListener("click", () => {
        const days = Number(btn.dataset.setSpan);
        if (days !== viewSpan) onDispatch("timeseries.setHorizon", curveId, { horizonDays: days });
      });
    });
    const customSpanIn = container.querySelector("[data-custom-span]");
    if (customSpanIn) {
      customSpanIn.addEventListener("change", () => {
        if (customSpanIn.value !== String(viewSpan)) onDispatch("timeseries.setHorizon", curveId, { horizonDays: customSpanIn.value });
      });
    }

    const bind = (act, fn) => container.querySelector(`[data-ts-action="${act}"]`)?.addEventListener("click", fn);
    bind("import-csv", () => onOpenCsvImport && onOpenCsvImport(curveId));
    bind("clear-brush", () => { editorState.brush = null; onLocalRefresh(); });
    bind("convert-total", () => {
      if (!brush || brush.endDate <= brush.startDate) return;
      onOpenSegmentDialog && onOpenSegmentDialog(curveId, brush.startDate, brush.endDate, Math.round(brushIntegral));
    });
    bind("create-batch", () => {
      if (!brush || brush.endDate <= brush.startDate) return;
      onCreateBatchFromRange && onCreateBatchFromRange(curve.targetNodeId, brush.startDate, brush.endDate, Math.round(brushIntegral));
    });
    bind("apply-pt-edit", () => {
      const ptId = container.querySelector("[data-ts-action='apply-pt-edit']")?.dataset.ptId;
      const dIn = container.querySelector(`[data-pt-date-input="${ptId}"]`);
      const rIn = container.querySelector(`[data-pt-rate-input="${ptId}"]`);
      if (dIn && rIn) onDispatch("timeseries.point.move", curveId, { pointId: ptId, date: dIn.value, rate: rIn.value });
    });
    bind("delete-pt", () => {
      const ptId = container.querySelector("[data-ts-action='delete-pt']")?.dataset.ptId;
      editorState.selectedPointId = null;
      onDispatch("timeseries.point.delete", curveId, { pointId: ptId });
    });
    bind("toggle-seg-dist", () => {
      const segId = container.querySelector("[data-ts-action='toggle-seg-dist']")?.dataset.segId;
      const seg = projectedSegs.find(s => s.id === segId);
      if (seg) {
        onDispatch("timeseries.segment.setTotal", curveId, {
          segmentId: segId,
          totalQty: seg.totalQty,
          distribution: seg.distribution === "custom" ? "uniform" : "custom"
        });
      }
    });
    bind("remove-seg", () => {
      const segId = container.querySelector("[data-ts-action='remove-seg']")?.dataset.segId;
      editorState.selectedSegmentId = null;
      onDispatch("timeseries.segment.remove", curveId, { segmentId: segId });
    });

    const segTotalIn = container.querySelector("[data-seg-total-input]");
    if (segTotalIn) {
      segTotalIn.addEventListener("change", () => {
        onDispatch("timeseries.segment.setTotal", curveId, {
          segmentId: segTotalIn.dataset.segTotalInput,
          totalQty: segTotalIn.value
        });
      });
    }

    container.querySelectorAll("[data-select-seg]").forEach(el => {
      el.addEventListener("pointerdown", e => {
        e.stopPropagation();
        editorState.selectedSegmentId = el.dataset.selectSeg;
        editorState.selectedPointId = null;
        editorState.brush = null;
        onLocalRefresh();
      });
    });

    /* =======================================================================
       60fps requestAnimationFrame 局部 SVG 拖动
       ======================================================================= */
    let dragOp = null;
    let rafId = null;
    let pendingEv = null;

    const processDragFrame = () => {
      rafId = null;
      if (!dragOp || !pendingEv) return;
      const ev = pendingEv;
      const { sx, sy } = toSvgCoords(ev);

      if (dragOp.kind === "point") {
        if (Math.hypot(ev.clientX - dragOp.startX, ev.clientY - dragOp.startY) > 3) dragOp.moved = true;
        const off = Math.max(0, Math.min(viewSpan, Math.round(xToOffset(sx))));
        const nextDate = TS.addDaysToIso(viewStartDate, off);
        const nextRate = Math.max(0, Math.round(yToRate(sy) / 5) * 5);

        const clash = dragOp.liveCurve.points.some(p => p.id !== dragOp.pointId && p.date === nextDate);
        if (!clash) {
          dragOp.curDate = nextDate;
          dragOp.curOff = off;
        }
        dragOp.curRate = nextRate;

        const livePt = dragOp.liveCurve.points.find(p => p.id === dragOp.pointId);
        if (livePt) {
          livePt.date = dragOp.curDate;
          livePt.rate = dragOp.curRate;
          dragOp.liveCurve.points.sort((a, b) => a.date.localeCompare(b.date));
        }

        const { lineAttr: nl, areaAttr: na } = buildCurvePointsAttr(dragOp.liveCurve);
        lineEl?.setAttribute("points", nl);
        areaEl?.setAttribute("points", na);

        const ptGroup = svg.querySelector(`[data-point-id="${dragOp.pointId}"]`);
        if (ptGroup) {
          const nx = offsetToX(dragOp.curOff).toFixed(1);
          const ny = rateToY(dragOp.curRate).toFixed(1);
          ptGroup.querySelectorAll("circle").forEach(c => { c.setAttribute("cx", nx); c.setAttribute("cy", ny); });
          const tag = ptGroup.querySelector(".ts-point-tag");
          if (tag) {
            tag.setAttribute("x", nx);
            tag.setAttribute("y", (Number(ny) - 10).toFixed(1));
            tag.textContent = String(dragOp.curRate);
          }
        }
        const liveTotal = TS.integrateCurveByDates(dragOp.liveCurve, viewStartDate, viewEndDate);
        if (totalEl) totalEl.textContent = fmtNum(liveTotal, 0);
        if (readout) {
          readout.classList.remove("hidden");
          readout.innerHTML = `<strong>${dragOp.curDate}</strong> · <b>${dragOp.curRate}</b> ${unitLabel}/day`;
        }
      } else if (dragOp.kind === "brush") {
        const offCur = Math.max(0, Math.min(viewSpan, Math.round(xToOffset(sx))));
        dragOp.endOff = offCur;
        dragOp.moved = Math.abs(offCur - dragOp.startOff) >= 1;
        const lo = Math.min(dragOp.startOff, dragOp.endOff);
        const hi = Math.max(dragOp.startOff, dragOp.endOff);
        let rect = svg.querySelector(".ts-brush-rect");
        if (!rect) {
          rect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
          rect.setAttribute("class", "ts-brush-rect");
          svg.appendChild(rect);
        }
        rect.setAttribute("x", offsetToX(lo).toFixed(1));
        rect.setAttribute("y", pad.top);
        rect.setAttribute("width", Math.max(2, offsetToX(hi) - offsetToX(lo)).toFixed(1));
        rect.setAttribute("height", plotH);
        if (readout && hi > lo) {
          const sIso = TS.addDaysToIso(viewStartDate, lo);
          const eIso = TS.addDaysToIso(viewStartDate, hi);
          const area = TS.integrateCurveByDates(curve, sIso, eIso);
          readout.classList.remove("hidden");
          readout.innerHTML = `<strong>${sIso} ~ ${eIso}</strong> · <b>${fmtNum(area, 1)}</b> ${unitLabel}`;
        }
      } else if (dragOp.kind === "shape") {
        dragOp.moved = true;
        const seg = dragOp.liveCurve.totalSegments.find(s => s.id === dragOp.segId);
        const pSeg = projectedSegs.find(s => s.id === dragOp.segId);
        if (!seg || !pSeg) return;
        const avgRate = Math.max(1, seg.totalQty / Math.max(1, pSeg.endDay - pSeg.startDay));
        const nextW = Math.max(0.05, Math.round((yToRate(sy) / avgRate) * 100) / 100);
        const anchors = TS.normalizeShapeAnchors(seg.shapeAnchors).map(a => ({ ...a }));
        if (anchors[dragOp.anchorIdx]) anchors[dragOp.anchorIdx].weight = nextW;
        seg.shapeAnchors = anchors;
        dragOp.latestAnchors = anchors;

        const { lineAttr: nl, areaAttr: na } = buildCurvePointsAttr(dragOp.liveCurve);
        lineEl?.setAttribute("points", nl);
        areaEl?.setAttribute("points", na);

        const pSegLive = { ...pSeg, shapeAnchors: anchors };
        const polyEl = svg.querySelector(`[data-seg-poly="${dragOp.segId}"]`);
        if (polyEl) {
          const sC = Math.max(0, pSegLive.startDay), eC = Math.min(viewSpan, pSegLive.endDay);
          const pts = [`${offsetToX(sC).toFixed(1)},${(pad.top + plotH).toFixed(1)}`];
          for (let i = 0; i <= 28; i++) {
            const t = sC + ((eC - sC) * i) / 28;
            pts.push(`${offsetToX(t).toFixed(1)},${rateToY(TS.evalTotalSegmentRate(pSegLive, Math.min(pSegLive.endDay - 1e-4, t))).toFixed(1)}`);
          }
          pts.push(`${offsetToX(eC).toFixed(1)},${(pad.top + plotH).toFixed(1)}`);
          polyEl.setAttribute("points", pts.join(" "));
        }
        anchors.forEach((anc, idx) => {
          const handle = svg.querySelector(`[data-seg-id="${dragOp.segId}"][data-anchor-idx="${idx}"]`);
          if (!handle) return;
          const td = pSegLive.startDay + anc.t * (pSegLive.endDay - pSegLive.startDay);
          const ax = offsetToX(td), ay = rateToY(TS.evalTotalSegmentRate(pSegLive, Math.min(pSegLive.endDay - 1e-4, td)));
          handle.querySelector("circle")?.setAttribute("cx", ax.toFixed(1));
          handle.querySelector("circle")?.setAttribute("cy", ay.toFixed(1));
          const rEl = handle.querySelector("rect");
          if (rEl) {
            rEl.setAttribute("x", (ax - 4).toFixed(1));
            rEl.setAttribute("y", (ay - 4).toFixed(1));
            rEl.setAttribute("transform", `rotate(45 ${ax.toFixed(1)} ${ay.toFixed(1)})`);
          }
        });
        if (readout) {
          readout.classList.remove("hidden");
          readout.innerHTML = `Weight <b>${nextW}x</b> · Fixed Total <b>${fmtNum(seg.totalQty, 0)}</b> ${unitLabel}`;
        }
      }
    };

    svg.addEventListener("pointerdown", ev => {
      if (ev.button !== 0) return;
      const { sx, sy } = toSvgCoords(ev);

      const shapeEl = ev.target.closest("[data-anchor-idx]");
      if (shapeEl) {
        ev.preventDefault();
        svg.setPointerCapture(ev.pointerId);
        dragOp = {
          kind: "shape",
          segId: shapeEl.dataset.segId,
          anchorIdx: Number(shapeEl.dataset.anchorIdx),
          liveCurve: WM.clone(curve),
          moved: false
        };
        return;
      }

      const ptEl = ev.target.closest("[data-point-id]");
      if (ptEl) {
        ev.preventDefault();
        svg.setPointerCapture(ev.pointerId);
        const ptId = ptEl.dataset.pointId;
        const origPt = projectedPts.find(p => p.id === ptId);
        if (!origPt) return;
        dragOp = {
          kind: "point",
          pointId: ptId,
          origDate: origPt.date,
          origRate: origPt.rate,
          curDate: origPt.date,
          curOff: origPt.day,
          curRate: origPt.rate,
          liveCurve: WM.clone(curve),
          startX: ev.clientX,
          startY: ev.clientY,
          moved: false
        };
        return;
      }

      if (sx < pad.left || sx > W - pad.right || sy < pad.top || sy > pad.top + plotH) return;

      if (toolMode === "brush" || ev.shiftKey) {
        ev.preventDefault();
        svg.setPointerCapture(ev.pointerId);
        const off0 = Math.max(0, Math.min(viewSpan, Math.round(xToOffset(sx))));
        dragOp = { kind: "brush", startOff: off0, endOff: off0, moved: false };
        return;
      }

      ev.preventDefault();
      const snapOff = Math.max(0, Math.min(viewSpan, Math.round(xToOffset(sx))));
      const snapDate = TS.addDaysToIso(viewStartDate, snapOff);
      const snapRate = Math.max(0, Math.round(yToRate(sy) / 5) * 5);
      const newId = WM.genId("pt");
      editorState.selectedPointId = newId;
      editorState.selectedSegmentId = null;
      editorState.brush = null;
      onDispatch("timeseries.point.add", curveId, { pointId: newId, date: snapDate, rate: snapRate });
    });

    svg.addEventListener("pointermove", ev => {
      if (!dragOp) {
        const { sx, sy } = toSvgCoords(ev);
        if (sx >= pad.left && sx <= W - pad.right && sy >= pad.top && sy <= pad.top + plotH) {
          const offFloat = Math.max(0, Math.min(viewSpan, xToOffset(sx)));
          const offInt = Math.min(viewSpan - 1, Math.max(0, Math.floor(offFloat)));
          const rVal = TS.evaluateRateAtOffset(curve, viewStartDate, offFloat);
          const info = daily[offInt];
          crosshair?.classList.remove("hidden");
          crossV?.setAttribute("x1", sx.toFixed(1));
          crossV?.setAttribute("x2", sx.toFixed(1));
          crossDot?.setAttribute("cx", sx.toFixed(1));
          crossDot?.setAttribute("cy", rateToY(rVal).toFixed(1));
          if (readout) {
            readout.classList.remove("hidden");
            readout.innerHTML = `<strong>${info?.date || TS.addDaysToIso(viewStartDate, offInt)}</strong> · <b>${fmtNum(rVal, 1)}</b> ${unitLabel}/day`;
          }
        } else {
          crosshair?.classList.add("hidden");
          readout?.classList.add("hidden");
        }
        return;
      }

      ev.preventDefault();
      pendingEv = ev;
      if (rafId === null) rafId = requestAnimationFrame(processDragFrame);
    });

    const finishDrag = (cancelled) => {
      if (rafId !== null) { cancelAnimationFrame(rafId); rafId = null; }
      pendingEv = null;
      if (!dragOp) return;
      const op = dragOp;
      dragOp = null;

      if (cancelled) { onLocalRefresh(); return; }

      if (op.kind === "point") {
        editorState.selectedPointId = op.pointId;
        editorState.selectedSegmentId = null;
        editorState.brush = null;
        if (op.moved && (op.curDate !== op.origDate || op.curRate !== op.origRate)) {
          onDispatch("timeseries.point.move", curveId, { pointId: op.pointId, date: op.curDate, rate: op.curRate });
        } else {
          onLocalRefresh();
        }
      } else if (op.kind === "brush") {
        const lo = Math.min(op.startOff, op.endOff);
        const hi = Math.max(op.startOff, op.endOff);
        if (hi > lo) {
          editorState.brush = {
            startDate: TS.addDaysToIso(viewStartDate, lo),
            endDate: TS.addDaysToIso(viewStartDate, hi)
          };
          editorState.selectedPointId = null;
          editorState.selectedSegmentId = null;
          onLocalRefresh();
        }
      } else if (op.kind === "shape" && op.moved && op.latestAnchors) {
        onDispatch("timeseries.segment.setShape", curveId, { segmentId: op.segId, shapeAnchors: op.latestAnchors });
      }
    };

    svg.addEventListener("pointerup", () => finishDrag(false));
    svg.addEventListener("pointercancel", () => finishDrag(true));
    svg.addEventListener("pointerleave", () => {
      if (!dragOp) {
        crosshair?.classList.add("hidden");
        readout?.classList.add("hidden");
      }
    });
  }

  global.SC = global.SC || {};
  global.SC.TimeSeriesEditor = { mountTimeSeriesEditor };
})(typeof globalThis !== "undefined" ? globalThis : this);
