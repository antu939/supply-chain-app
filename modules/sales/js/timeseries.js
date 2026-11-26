(function (global) {
  "use strict";

  const EPS = 1e-9;
  const DECIMAL = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i;
  const MS_PER_DAY = 86400000;
  const MAX_CALENDAR_DAYS = (Date.UTC(9999, 11, 31) - parseIsoDateUtc("0001-01-01")) / MS_PER_DAY;

  // Form/CSV numbers use an ungrouped decimal representation; blanks and null
  // are handled by the field owner before parsing, never converted to zero.
  function requireNumber(value, field, { min = 0, max = Number.MAX_SAFE_INTEGER, integer = false } = {}) {
    const text = typeof value === "string" ? value.trim() : null;
    const n = text !== null && DECIMAL.test(text) ? Number(text) : value;
    const underflow = n === 0 && text !== null && /[1-9]/.test(text.split(/e/i)[0]);
    if (typeof n !== "number" || !Number.isFinite(n) || underflow || n < min || n > max || (integer && !Number.isSafeInteger(n))) {
      throw new Error(`${field}: enter a valid ${integer ? "integer" : "number"} (${min} to ${max}, no thousand separators)`);
    }
    return n;
  }

  function roundQty(v) {
    const scaled = v * 1e6;
    return Math.abs(scaled) <= Number.MAX_SAFE_INTEGER ? Math.round(scaled) / 1e6 : Number(v.toFixed(6));
  }

  function requireQuantity(value, field, positive = false) {
    const qty = roundQty(requireNumber(value, field));
    if (positive && qty <= 0) throw new Error(`${field}: quantity must be greater than 0`);
    return qty;
  }

  const requireDays = (value, field) => requireNumber(value, field, { max: MAX_CALENDAR_DAYS, integer: true });
  function requireEtaDelta(value) {
    const delta = requireNumber(value, "ETA shift days", { min: -180, max: 180, integer: true });
    if (delta === 0) throw new Error("ETA shift days must be a non-zero integer");
    return delta;
  }
  const requireHorizon = (value, field, max) => requireNumber(value, field, { min: 7, max, integer: true });
  function requireAllocationPct(value) {
    const pct = Number(requireNumber(value, "allocationPct", { max: 100 }).toFixed(2));
    if (pct <= 0) throw new Error("Allocation % must be greater than 0");
    return pct;
  }

  /**
   * 获取用户本地时区的自然日 ISO 字符串 (YYYY-MM-DD)，避免 UTC 转换导致跨日偏移一天。
   */
  function todayLocalIso(nowDate) {
    const dt = nowDate instanceof Date ? nowDate : new Date();
    const y = String(dt.getFullYear()).padStart(4, "0");
    const m = String(dt.getMonth() + 1).padStart(2, "0");
    const d = String(dt.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }

  function parseIsoDateUtc(str) {
    if (typeof str !== "string" || str.length !== 10) return null;
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(str);
    if (!m) return null;
    const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
    if (y < 1 || mo < 1 || mo > 12 || d < 1 || d > 31) return null;
    const dt = new Date(0);
    dt.setUTCFullYear(y, mo - 1, d);
    if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
    return dt.getTime();
  }

  function requireDate(value, field) {
    if (parseIsoDateUtc(value) === null) throw new Error(`${field}: enter a valid date (YYYY-MM-DD)`);
    return value;
  }

  function addDaysToIso(isoDate, deltaDays) {
    const ts = parseIsoDateUtc(requireDate(isoDate, "Date"));
    const delta = requireNumber(deltaDays, "Date offset days", { min: -MAX_CALENDAR_DAYS, max: MAX_CALENDAR_DAYS, integer: true });
    const dt = new Date(ts + delta * MS_PER_DAY);
    const y = dt.getUTCFullYear();
    if (!Number.isInteger(y) || y < 1 || y > 9999) throw new Error("Date calculation out of YYYY-MM-DD range");
    const m = String(dt.getUTCMonth() + 1).padStart(2, "0");
    const d = String(dt.getUTCDate()).padStart(2, "0");
    return `${String(y).padStart(4, "0")}-${m}-${d}`;
  }

  function diffIsoDays(startIso, targetIso) {
    const a = parseIsoDateUtc(startIso);
    const b = parseIsoDateUtc(targetIso);
    if (a === null || b === null) return null;
    return Math.round((b - a) / MS_PER_DAY);
  }

  function formatShortDate(isoDate) {
    if (typeof isoDate !== "string" || isoDate.length < 10) return String(isoDate || "");
    const parts = isoDate.split("-");
    return `${Number(parts[1])}/${Number(parts[2])}`;
  }

  function formatCnDate(isoDate) {
    if (typeof isoDate !== "string" || isoDate.length < 10) return String(isoDate || "");
    const parts = isoDate.split("-");
    const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"]; return `${months[Number(parts[1]) - 1] || parts[1]} ${Number(parts[2])}`;
  }

  /**
   * 将曲线的绝对日期点/区间投影到以 baseDate 为原点的连续实数坐标 t（单位：天）。
   * 保证同一批绝对日期记录，无论今天滚到哪一天，在物理时间轴上的含义与积分完全不变。
   */
  function projectPoints(points, baseDate) {
    return (Array.isArray(points) ? points : [])
      .map(p => {
        const day = diffIsoDays(baseDate, p.date);
        const rate = Math.max(0, Number(p.rate));
        return { id: String(p.id), date: p.date, day, rate };
      })
      .filter(p => p.day !== null && Number.isFinite(p.rate))
      .sort((a, b) => a.day - b.day);
  }

  function projectSegments(segments, baseDate) {
    return (Array.isArray(segments) ? segments : [])
      .map(s => {
        const startDay = diffIsoDays(baseDate, s.startDate);
        const endDay = diffIsoDays(baseDate, s.endDate);
        return {
          ...s,
          startDay,
          endDay,
          totalQty: Math.max(0, Number(s.totalQty) || 0),
          distribution: s.distribution === "custom" ? "custom" : "uniform",
          sourcePrecision: "interval_total"
        };
      })
      .filter(s => s.startDay !== null && s.endDay !== null && s.endDay > s.startDay)
      .sort((a, b) => a.startDay - b.startDay);
  }

  function sortRatePointsByDate(points) {
    return points.slice().sort((a, b) => a.date.localeCompare(b.date));
  }

  function sortTotalSegmentsByDate(segments) {
    return segments.slice().sort((a, b) => a.startDate.localeCompare(b.startDate));
  }

  function evalPureRate(sortedPoints, t) {
    if (!sortedPoints.length) return 0;
    if (t < sortedPoints[0].day - EPS) return 0;
    if (t <= sortedPoints[0].day + EPS) return sortedPoints[0].rate;
    const last = sortedPoints[sortedPoints.length - 1];
    if (t >= last.day - EPS) return last.rate;

    for (let i = 0; i < sortedPoints.length - 1; i++) {
      const p0 = sortedPoints[i], p1 = sortedPoints[i + 1];
      if (t >= p0.day - EPS && t <= p1.day + EPS) {
        const span = p1.day - p0.day;
        if (span <= EPS) return p1.rate;
        return p0.rate + (p1.rate - p0.rate) * ((t - p0.day) / span);
      }
    }
    return last.rate;
  }

  function integratePureRate(sortedPoints, a, b) {
    if (!sortedPoints.length || b <= a + EPS) return 0;
    const cuts = [a, b];
    for (const p of sortedPoints) {
      if (p.day > a + EPS && p.day < b - EPS) cuts.push(p.day);
    }
    cuts.sort((x, y) => x - y);

    let total = 0;
    const firstDay = sortedPoints[0].day;
    for (let i = 0; i < cuts.length - 1; i++) {
      const u = cuts[i], v = cuts[i + 1];
      if (v <= u + EPS || v <= firstDay + EPS) continue;
      if ((u + v) * 0.5 < firstDay - EPS) continue;
      const ru = Math.abs(u - firstDay) <= EPS ? sortedPoints[0].rate : evalPureRate(sortedPoints, u);
      const rv = evalPureRate(sortedPoints, v);
      total += 0.5 * (ru + rv) * (v - u);
    }
    return Math.max(0, total);
  }

  function normalizeShapeAnchors(anchors) {
    let list = (Array.isArray(anchors) ? anchors : [])
      .map(a => ({ t: Math.max(0, Math.min(1, Number(a.t))), weight: Math.max(0, Number(a.weight)) }))
      .filter(a => Number.isFinite(a.t) && Number.isFinite(a.weight))
      .sort((a, b) => a.t - b.t);

    if (!list.length) return [{ t: 0, weight: 1 }, { t: 1, weight: 1 }];
    if (list[0].t > EPS) list = [{ t: 0, weight: list[0].weight }, ...list];
    else list[0].t = 0;
    if (list[list.length - 1].t < 1 - EPS) list = [...list, { t: 1, weight: list[list.length - 1].weight }];
    else list[list.length - 1].t = 1;
    return list;
  }

  function evalShapeWeight(anchors, u) {
    const c = Math.max(0, Math.min(1, u));
    for (let i = 0; i < anchors.length - 1; i++) {
      const a0 = anchors[i], a1 = anchors[i + 1];
      if (c >= a0.t - EPS && c <= a1.t + EPS) {
        const span = a1.t - a0.t;
        if (span <= EPS) return a1.weight;
        return a0.weight + (a1.weight - a0.weight) * ((c - a0.t) / span);
      }
    }
    return anchors[anchors.length - 1].weight;
  }

  function integrateShapeAnchors(anchors, u0, u1) {
    if (u1 <= u0 + EPS) return 0;
    const cuts = [u0, u1];
    for (const a of anchors) {
      if (a.t > u0 + EPS && a.t < u1 - EPS) cuts.push(a.t);
    }
    cuts.sort((x, y) => x - y);
    let area = 0;
    for (let i = 0; i < cuts.length - 1; i++) {
      const x0 = cuts[i], x1 = cuts[i + 1];
      if (x1 <= x0 + EPS) continue;
      area += 0.5 * (evalShapeWeight(anchors, x0) + evalShapeWeight(anchors, x1)) * (x1 - x0);
    }
    return area;
  }

  function evalTotalSegmentRate(seg, t) {
    const span = seg.endDay - seg.startDay;
    if (span <= EPS) return 0;
    if (seg.distribution !== "custom") return seg.totalQty / span;
    const anchors = normalizeShapeAnchors(seg.shapeAnchors);
    const totalArea = integrateShapeAnchors(anchors, 0, 1);
    if (totalArea <= EPS) return seg.totalQty / span;
    const u = Math.max(0, Math.min(1, (t - seg.startDay) / span));
    return (seg.totalQty / (span * totalArea)) * evalShapeWeight(anchors, u);
  }

  function integrateTotalSegment(seg, a, b) {
    const lo = Math.max(a, seg.startDay);
    const hi = Math.min(b, seg.endDay);
    if (hi <= lo + EPS) return 0;
    const span = seg.endDay - seg.startDay;
    if (span <= EPS) return 0;
    if (seg.distribution !== "custom") return (seg.totalQty / span) * (hi - lo);
    const anchors = normalizeShapeAnchors(seg.shapeAnchors);
    const totalArea = integrateShapeAnchors(anchors, 0, 1);
    if (totalArea <= EPS) return (seg.totalQty / span) * (hi - lo);
    const subArea = integrateShapeAnchors(anchors, (lo - seg.startDay) / span, (hi - seg.startDay) / span);
    return seg.totalQty * (subArea / totalArea);
  }

  /**
   * 按以 baseDate 为原点的连续时间 t（天）评估曲线速率 (units/day)。
   */
  function evaluateRateAtOffset(curve, baseDate, t) {
    if (!curve) return 0;
    const dayFloor = Math.floor(t + EPS);
    const targetIso = addDaysToIso(baseDate, dayFloor);
    const actuals = Array.isArray(curve.importedDailyActuals) ? curve.importedDailyActuals : [];
    const actual = actuals.find(item => item.date === targetIso);
    if (actual) return actual.qty;

    const segs = projectSegments(curve.totalSegments, baseDate);
    for (const seg of segs) {
      if (t >= seg.startDay - EPS && t < seg.endDay - EPS) {
        return evalTotalSegmentRate(seg, t);
      }
    }
    const pts = projectPoints(curve.points, baseDate);
    return evalPureRate(pts, t);
  }

  /**
   * 精确积分：计算曲线在 [startDate, endDate] 绝对日期区间内的累计总量。
   */
  function integrateCurveByDates(curve, startDate, endDate) {
    if (!curve) return 0;
    const span = diffIsoDays(startDate, endDate);
    if (span === null || span <= 0) return 0;
    return integrateCurveOffsets(curve, startDate, 0, span);
  }

  function integrateCurveOffsets(curve, baseDate, a, b) {
    if (!curve || b <= a + EPS) return 0;
    const pts = projectPoints(curve.points, baseDate);
    const segs = projectSegments(curve.totalSegments, baseDate);
    const actuals = (Array.isArray(curve.importedDailyActuals) ? curve.importedDailyActuals : [])
      .map(item => ({ ...item, day: diffIsoDays(baseDate, item.date) }))
      .filter(item => item.day !== null);

    const cutsSet = new Set([a, b]);
    for (const seg of segs) {
      if (seg.startDay > a && seg.startDay < b) cutsSet.add(seg.startDay);
      if (seg.endDay > a && seg.endDay < b) cutsSet.add(seg.endDay);
    }
    for (const act of actuals) {
      if (act.day > a && act.day < b) cutsSet.add(act.day);
      if (act.day + 1 > a && act.day + 1 < b) cutsSet.add(act.day + 1);
    }
    const cuts = Array.from(cutsSet).sort((x, y) => x - y);

    let sum = 0;
    for (let i = 0; i < cuts.length - 1; i++) {
      const u = cuts[i], v = cuts[i + 1];
      if (v <= u + EPS) continue;
      const mid = (u + v) * 0.5;
      const dayFloor = Math.floor(mid);
      const act = actuals.find(item => item.day === dayFloor);
      if (act) { sum += act.qty * (v - u); continue; }
      const seg = segs.find(s => mid >= s.startDay && mid < s.endDay);
      if (seg) { sum += integrateTotalSegment(seg, u, v); continue; }
      sum += integratePureRate(pts, u, v);
    }
    return roundQty(sum);
  }

  /**
   * 离散化为从 startDate 开始的 numDays 个自然日序列（每日为 [date, date+1) 的精确积分）。
   */
  function computeDailySeriesRange(curve, startDate, numDays) {
    const H = requireNumber(numDays === undefined ? 30 : numDays, "Time series days", {
      min: 1, max: MAX_CALENDAR_DAYS + 1, integer: true
    });
    addDaysToIso(startDate, H - 1);
    const segs = projectSegments(curve?.totalSegments, startDate);
    const actualsMap = new Map();
    for (const act of (curve?.importedDailyActuals || [])) {
      actualsMap.set(act.date, act);
    }

    const days = [];
    for (let d = 0; d < H; d++) {
      const date = addDaysToIso(startDate, d);
      const qty = integrateCurveOffsets(curve, startDate, d, d + 1);
      let mode = "rate";
      let segmentId = null;
      let sourcePrecision = "rate_curve_integral";
      let provenanceLabel = "Rate curve integral";

      if (actualsMap.has(date)) {
        mode = "csv_actual";
        sourcePrecision = "daily_actual_fact";
        provenanceLabel = "Imported daily actual";
      } else {
        const seg = segs.find(s => d >= s.startDay && d + 1 <= s.endDay);
        const partialSeg = !seg ? segs.find(s => d < s.endDay && d + 1 > s.startDay) : null;
        if (seg) {
          mode = seg.distribution === "custom" ? "total_custom" : "total_uniform";
          segmentId = seg.id;
          sourcePrecision = "estimated_from_interval_total";
          provenanceLabel = seg.distribution === "custom"
            ? "Range total · Custom shape"
            : "Range total · Uniform";
        } else if (partialSeg) {
          mode = "mixed";
          segmentId = partialSeg.id;
          sourcePrecision = "mixed_interval_estimate";
          provenanceLabel = "Mixed interval estimate";
        }
      }

      days.push({ day: d, date, qty, rateAvg: qty, mode, segmentId, sourcePrecision, provenanceLabel });
    }
    return days;
  }

  function findOverlappingSegmentsByDate(segments, startDate, endDate, excludeId) {
    return (segments || []).filter(s => {
      if (excludeId && s.id === excludeId) return false;
      return startDate < s.endDate && endDate > s.startDate;
    });
  }

  function splitCsvLine(line) {
    const fields = [];
    const field = /\s*(?:"((?:""|[^"])*)"|([^",]*))\s*(,|$)/y;
    for (;;) {
      const match = field.exec(line);
      if (!match) return null;
      fields.push((match[1] === undefined ? match[2] : match[1].replace(/""/g, '"')).trim());
      if (!match[3]) return field.lastIndex === line.length ? fields : null;
    }
  }

  /**
   * 严格校验自然日 CSV（表头须含 date/日期、sku/产品、qty/数量）。
   * 拒绝周度、月度、重复日期、负值。
   */
  function parseDailyCsv(csvText, options) {
    const expectedSku = options?.expectedSku || null;
    const errors = [];
    const warnings = [];
    const records = [];

    if (typeof csvText !== "string" || !csvText.trim()) {
      return { ok: false, errors: ["CSV content is empty"], warnings, records };
    }
    const lines = csvText.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n").map(l => l.trim()).filter(Boolean);
    if (lines.length < 2) {
      return { ok: false, errors: ["CSV requires a header row and at least one daily record"], warnings, records };
    }

    const rawHeaders = (splitCsvLine(lines[0]) || []).map(h => h.toLowerCase());
    const dateIdx = rawHeaders.findIndex(h => ["date", "日期", "day_date"].includes(h));
    const skuIdx = rawHeaders.findIndex(h => ["sku", "product", "product_id", "产品", "产品编码", "物料编码"].includes(h));
    const qtyIdx = rawHeaders.findIndex(h => ["qty", "quantity", "units", "数量", "日产量", "日需求"].includes(h));

    if (dateIdx < 0) errors.push("Missing required column: date (YYYY-MM-DD)");
    if (skuIdx < 0) errors.push("Missing required column: sku / product");
    if (qtyIdx < 0) errors.push("Missing required column: qty / quantity");
    if (errors.length) return { ok: false, errors, warnings, records };

    const seenKeys = new Set();
    for (let i = 1; i < lines.length; i++) {
      const rowNo = i + 1;
      const cols = splitCsvLine(lines[i]);
      if (!cols || cols.length !== rawHeaders.length) {
        errors.push(`Row ${rowNo}: invalid columns or quotes`);
        continue;
      }
      if (cols.length < Math.max(dateIdx, skuIdx, qtyIdx) + 1) {
        errors.push(`Row ${rowNo}: not enough columns`);
        continue;
      }
      const dateStr = cols[dateIdx];
      const sku = cols[skuIdx];
      const qtyRaw = cols[qtyIdx];

      if (/^\d{4}-W\d{1,2}$/i.test(dateStr) || /^\d{4}-\d{2}$/.test(dateStr)) {
        errors.push(`Row ${rowNo}: "${dateStr}" must be a daily date (YYYY-MM-DD); weekly/monthly rows are not supported`);
        continue;
      }
      if (parseIsoDateUtc(dateStr) === null) {
        errors.push(`Row ${rowNo}: invalid date "${dateStr}" (expected YYYY-MM-DD)`);
        continue;
      }
      if (!sku) { errors.push(`Row ${rowNo}: missing SKU/product`); continue; }
      if (expectedSku && sku.toLowerCase() !== String(expectedSku).toLowerCase()) {
        errors.push(`Row ${rowNo}: SKU "${sku}" does not match active product "${expectedSku}"`);
        continue;
      }
      let qty;
      try {
        qty = requireQuantity(qtyRaw, "Quantity");
      } catch (err) {
        errors.push(`Row ${rowNo}: ${err.message}`);
        continue;
      }
      const dupKey = `${dateStr}::${sku.toLowerCase()}`;
      if (seenKeys.has(dupKey)) {
        errors.push(`Row ${rowNo}: duplicate date (${dateStr} / ${sku})`);
        continue;
      }
      seenKeys.add(dupKey);
      records.push({ date: dateStr, sku, qty, source: "csv_daily_actual" });
    }
    records.sort((a, b) => a.date.localeCompare(b.date));
    return { ok: errors.length === 0, errors, warnings, records };
  }

  /**
   * 批量发运 CSV 导入解析器（支持直接导入真实发运计划/记录）。
   */
  function parseShipmentsCsv(csvText, nodes) {
    const errors = [];
    const records = [];
    if (typeof csvText !== "string" || !csvText.trim()) {
      return { ok: false, errors: ["CSV content is empty"], records };
    }
    const lines = csvText.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n").map(l => l.trim()).filter(Boolean);
    if (lines.length < 2) {
      return { ok: false, errors: ["CSV requires a header row and at least one shipment"], records };
    }
    const headers = (splitCsvLine(lines[0]) || []).map(h => h.toLowerCase());
    const idxOf = names => headers.findIndex(h => names.includes(h));
    const fromIdx = idxOf(["from", "from_factory", "factory", "工厂", "起点工厂"]);
    const toIdx = idxOf(["to", "to_market", "market", "市场", "目标市场"]);
    const dateIdx = idxOf(["depart_date", "date", "发运日期", "日期"]);
    const qtyIdx = idxOf(["qty", "quantity", "数量"]);
    const modeIdx = idxOf(["mode", "transport_mode", "运输方式"]);
    const daysIdx = idxOf(["transit_days", "days", "运输天数", "预计运输天数"]);
    const carrierIdx = idxOf(["carrier", "承运商"]);
    const costIdx = idxOf(["unit_cost", "单位运费"]);
    const fixedIdx = idxOf(["fixed_cost", "固定运费"]);
    const noteIdx = idxOf(["note", "备注"]);

    if (fromIdx < 0 || toIdx < 0 || dateIdx < 0 || qtyIdx < 0) {
      return { ok: false, errors: ["CSV header must include: from, to, depart_date (YYYY-MM-DD), qty"], records };
    }

    const nodeList = Object.values(nodes || {});
    const findNode = (raw, kind) => nodeList.find(n => n.kind === kind && (n.id === raw || n.name === raw || String(n.region ?? "").toLowerCase() === raw.toLowerCase() && raw !== ""));

    for (let i = 1; i < lines.length; i++) {
      const rowNo = i + 1;
      const cols = splitCsvLine(lines[i]);
      if (!cols || cols.length !== headers.length) {
        errors.push(`Row ${rowNo}: invalid columns or quotes`);
        continue;
      }
      const optional = index => index < 0 || cols[index] === "" ? undefined : cols[index];
      const fromNode = findNode(cols[fromIdx] || "", "source");
      const toNode = findNode(cols[toIdx] || "", "market");
      const departDate = cols[dateIdx] || "";

      if (!fromNode) { errors.push(`Row ${rowNo}: unknown origin factory "${cols[fromIdx] || ""}"`); continue; }
      if (!toNode) { errors.push(`Row ${rowNo}: unknown target market "${cols[toIdx] || ""}"`); continue; }
      if (parseIsoDateUtc(departDate) === null) { errors.push(`Row ${rowNo}: invalid dispatch date "${departDate}"`); continue; }

      const modeRaw = optional(modeIdx);
      const modeMap = { "海运": "sea", "快船": "sea_express", "海运快船": "sea_express", "空运": "air", "铁路": "rail", "陆运": "truck" };
      const mode = Object.hasOwn(modeMap, modeRaw) ? modeMap[modeRaw] : modeRaw;
      try {
        if (mode !== undefined && !["sea", "sea_express", "air", "rail", "truck"].includes(mode)) {
          throw new Error("Invalid transport mode");
        }
        const days = optional(daysIdx), cost = optional(costIdx), fixed = optional(fixedIdx);
        records.push({
          fromNodeId: fromNode.id,
          toNodeId: toNode.id,
          departDate,
          qty: requireQuantity(cols[qtyIdx], "Quantity", true),
          mode,
          transitDays: days === undefined ? undefined : requireDays(days, "Transit Days"),
          carrier: optional(carrierIdx),
          unitCost: cost === undefined ? undefined : requireNumber(cost, "Unit Freight"),
          fixedCost: fixed === undefined ? undefined : requireNumber(fixed, "Fixed Freight"),
          note: optional(noteIdx) || "CSV batch import"
        });
      } catch (err) {
        errors.push(`Row ${rowNo}: ${err.message}`);
      }
    }
    return { ok: errors.length === 0, errors, records };
  }

  const TimeSeries = {
    EPS,
    roundQty,
    requireNumber,
    requireQuantity,
    requireDays,
    requireEtaDelta,
    requireHorizon,
    requireAllocationPct,
    requireDate,
    todayLocalIso,
    parseIsoDateUtc,
    addDaysToIso,
    diffIsoDays,
    formatShortDate,
    formatCnDate,
    projectPoints,
    projectSegments,
    sortRatePointsByDate,
    sortTotalSegmentsByDate,
    normalizeShapeAnchors,
    evalPureRate,
    integratePureRate,
    evalTotalSegmentRate,
    integrateTotalSegment,
    evaluateRateAtOffset,
    integrateCurveByDates,
    integrateCurveOffsets,
    computeDailySeriesRange,
    findOverlappingSegmentsByDate,
    parseDailyCsv,
    parseShipmentsCsv
  };

  global.SC = global.SC || {};
  global.SC.TimeSeries = TimeSeries;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = TimeSeries;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
