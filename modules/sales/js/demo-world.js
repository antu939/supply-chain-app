(function (global) {
  "use strict";

  const getTS = () => global.SC?.TimeSeries || (typeof require === "function" ? require("./timeseries.js") : null);
  const getWM = () => global.SC?.WorldModel || (typeof require === "function" ? require("./world-model.js") : null);

  function createDemoWorkspace(bomCatalog, referenceTodayIso) {
    const TS = getTS();
    const WM = getWM();
    const today = (referenceTodayIso && TS.parseIsoDateUtc(referenceTodayIso) !== null)
      ? referenceTodayIso
      : TS.todayLocalIso();
    const d = offset => TS.addDaysToIso(today, offset);

    const catalog = bomCatalog || WM.readLinkedBomCatalog({ allowBuiltinFallback: true });
    const bomProd = catalog?.products?.[0] || WM.BUILTIN_BOM_SNAPSHOT.products[0];
    const sku = bomProd.skuCode || "GW-G200";
    const anchorDate = d(-14);

    const nodes = {
      src_cn_hz: {
        id: "src_cn_hz",
        kind: "source",
        name: "杭州总装一厂",
        region: "CN",
        city: "杭州",
        mapX: 165,
        mapY: 92,
        bomFactoryId: bomProd.factories?.[0]?.id || "f65",
        bomCompanyId: bomProd.rootCompanyId || "c44",
        initialInventory: 3200,
        note: "关联 BOM 成品主装厂（f65），承担欧美及日本主力出货。"
      },
      src_cn_hz2: {
        id: "src_cn_hz2",
        kind: "source",
        name: "杭州总装二厂",
        region: "CN",
        city: "杭州萧山",
        mapX: 165,
        mapY: 205,
        bomFactoryId: bomProd.factories?.[1]?.id || "f66",
        bomCompanyId: bomProd.rootCompanyId || "c44",
        initialInventory: 950,
        note: "关联 BOM 专线工厂（f66），支持高紧急度空运补库。"
      },
      mkt_us: {
        id: "mkt_us",
        kind: "market",
        name: "美国市场",
        region: "US",
        city: "洛杉矶 / 长滩",
        mapX: 815,
        mapY: 58,
        initialInventory: 3400,
        marketPolicy: {
          priority: 1,
          lastMileUnitCost: 14,
          fulfillmentUnitCost: 4.5,
          channelCommissionUnitCost: 18
        },
        note: "核心高优先级市场（P1）。入境需完成抵港、清关放行与上架后次日可售。"
      },
      mkt_eu: {
        id: "mkt_eu",
        kind: "market",
        name: "欧盟市场",
        region: "EU",
        city: "汉堡",
        mapX: 815,
        mapY: 148,
        initialInventory: 1950,
        marketPolicy: {
          priority: 2,
          lastMileUnitCost: 11.5,
          fulfillmentUnitCost: 4.0,
          channelCommissionUnitCost: 15
        },
        note: "欧洲工业渠道（P2），海运周期较长，需提前规划补库。"
      },
      mkt_jp: {
        id: "mkt_jp",
        kind: "market",
        name: "日本市场",
        region: "JP",
        city: "东京",
        mapX: 815,
        mapY: 238,
        initialInventory: 1450,
        marketPolicy: {
          priority: 2,
          lastMileUnitCost: 9.5,
          fulfillmentUnitCost: 3.5,
          channelCommissionUnitCost: 14
        },
        note: "东亚近洋市场（P2），航程短，近期存在渠道促销波峰。"
      }
    };

    const lanes = {
      lane_hz_us_sea: {
        id: "lane_hz_us_sea",
        name: "杭州一厂 → 美国（美森快船）",
        fromNodeId: "src_cn_hz",
        toNodeId: "mkt_us",
        defaultMode: "sea_express",
        defaultCarrier: "美森轮船 Matson",
        defaultTransitDays: 14,
        defaultFixedCost: 3200,
        defaultUnitCost: 9.8,
        defaultOriginPort: "宁波舟山港",
        defaultDestinationPort: "洛杉矶长滩港",
        defaultCustomsWaitDays: 4,
        defaultPutawayDays: 2,
        defaultImportFeeFixed: 850,
        defaultImportFeePerUnit: 11.5,
        note: "常规对美快船方案（每笔发运可独立修改时效与费用）"
      },
      lane_hz2_us_air: {
        id: "lane_hz2_us_air",
        name: "杭州二厂 → 美国（空运专线）",
        fromNodeId: "src_cn_hz2",
        toNodeId: "mkt_us",
        defaultMode: "air",
        defaultCarrier: "跨太平洋货航",
        defaultTransitDays: 5,
        defaultFixedCost: 4500,
        defaultUnitCost: 23.5,
        defaultOriginPort: "杭州萧山机场",
        defaultDestinationPort: "洛杉矶 LAX",
        defaultCustomsWaitDays: 2,
        defaultPutawayDays: 1,
        defaultImportFeeFixed: 650,
        defaultImportFeePerUnit: 11.0,
        note: "断货急补空运方案"
      },
      lane_hz_eu_sea: {
        id: "lane_hz_eu_sea",
        name: "杭州一厂 → 欧盟（海运整柜）",
        fromNodeId: "src_cn_hz",
        toNodeId: "mkt_eu",
        defaultMode: "sea",
        defaultCarrier: "中远海运 COSCO",
        defaultTransitDays: 26,
        defaultFixedCost: 3600,
        defaultUnitCost: 8.4,
        defaultOriginPort: "上海洋山港",
        defaultDestinationPort: "汉堡港",
        defaultCustomsWaitDays: 4,
        defaultPutawayDays: 2,
        defaultImportFeeFixed: 720,
        defaultImportFeePerUnit: 9.0,
        note: "常规欧洲干线海运"
      },
      lane_hz_jp_sea: {
        id: "lane_hz_jp_sea",
        name: "杭州一厂 → 日本（近洋海运）",
        fromNodeId: "src_cn_hz",
        toNodeId: "mkt_jp",
        defaultMode: "sea",
        defaultCarrier: "锦江航运",
        defaultTransitDays: 6,
        defaultFixedCost: 1150,
        defaultUnitCost: 3.8,
        defaultOriginPort: "宁波港",
        defaultDestinationPort: "东京港",
        defaultCustomsWaitDays: 2,
        defaultPutawayDays: 1,
        defaultImportFeeFixed: 420,
        defaultImportFeePerUnit: 6.5,
        note: "日本近洋周班船"
      }
    };

    const curves = {
      crv_hz_prod: {
        id: "crv_hz_prod",
        targetNodeId: "src_cn_hz",
        kind: "production",
        unit: "units/day",
        horizonDays: 90,
        points: [
          { id: "pt_hz_anchor", date: anchorDate, rate: 100 },
          { id: "pt_hz_0", date: today, rate: 100 },
          { id: "pt_hz_10", date: d(10), rate: 200 },
          { id: "pt_hz_35", date: d(35), rate: 210 },
          { id: "pt_hz_90", date: d(90), rate: 190 }
        ],
        totalSegments: [
          {
            id: "seg_hz_month",
            startDate: d(20),
            endDate: d(30),
            totalQty: 1800,
            distribution: "uniform",
            label: "下旬排产",
            sourcePrecision: "interval_total"
          }
        ],
        importedDailyActuals: []
      },
      crv_hz2_prod: {
        id: "crv_hz2_prod",
        targetNodeId: "src_cn_hz2",
        kind: "production",
        unit: "units/day",
        horizonDays: 30,
        points: [
          { id: "pt_hz2_0", date: anchorDate, rate: 50 },
          { id: "pt_hz2_1", date: d(15), rate: 75 },
          { id: "pt_hz2_2", date: d(30), rate: 75 }
        ],
        totalSegments: [],
        importedDailyActuals: []
      },
      crv_us_dem: {
        id: "crv_us_dem",
        targetNodeId: "mkt_us",
        kind: "demand",
        unit: "units/day",
        horizonDays: 60,
        points: [
          { id: "pt_us_0", date: anchorDate, rate: 130 },
          { id: "pt_us_1", date: today, rate: 145 },
          { id: "pt_us_20", date: d(20), rate: 175 },
          { id: "pt_us_60", date: d(60), rate: 165 }
        ],
        totalSegments: [],
        importedDailyActuals: []
      },
      crv_eu_dem: {
        id: "crv_eu_dem",
        targetNodeId: "mkt_eu",
        kind: "demand",
        unit: "units/day",
        horizonDays: 90,
        points: [
          { id: "pt_eu_0", date: anchorDate, rate: 55 },
          { id: "pt_eu_1", date: d(30), rate: 68 },
          { id: "pt_eu_2", date: d(90), rate: 65 }
        ],
        totalSegments: [],
        importedDailyActuals: []
      },
      crv_jp_dem: {
        id: "crv_jp_dem",
        targetNodeId: "mkt_jp",
        kind: "demand",
        unit: "units/day",
        horizonDays: 30,
        points: [
          { id: "pt_jp_0", date: anchorDate, rate: 48 },
          { id: "pt_jp_1", date: d(15), rate: 55 },
          { id: "pt_jp_2", date: d(30), rate: 52 }
        ],
        totalSegments: [
          {
            id: "seg_jp_promo",
            startDate: d(12),
            endDate: d(22),
            totalQty: 780,
            distribution: "custom",
            shapeAnchors: [
              { t: 0, weight: 0.7 },
              { t: 0.45, weight: 1.65 },
              { t: 1, weight: 0.85 }
            ],
            label: "促销期",
            sourcePrecision: "interval_total"
          }
        ],
        importedDailyActuals: []
      }
    };

    const batches = {
      bat_hz_01: {
        id: "bat_hz_01",
        code: "BAT-HZ-01",
        sourceNodeId: "src_cn_hz",
        productId: sku,
        startDate: today,
        endDate: d(10),
        extraWaitDays: 2,
        availableDate: d(12),
        qtyOverride: null,
        status: "planned",
        note: "未来 10 天排产聚合批次（100→200 台/天，积分精确 1,500 台），含 2 天老化检验等待。"
      }
    };

    // Multiple shipments with DIFFERENT independent durations & modes on the same Hangzhou -> US corridor!
    const shipments = {
      shp_001: {
        id: "shp_001",
        code: "SHP-001",
        productId: sku,
        laneId: "lane_hz_us_sea",
        fromNodeId: "src_cn_hz",
        toNodeId: "mkt_us",
        batchId: null,
        qty: 900,
        departDate: d(-18),
        mode: "sea",
        carrier: "达飞轮船 CMA CGM",
        transitDays: 16,
        fixedCost: 2950,
        unitCost: 8.9,
        customsWaitDays: 4,
        putawayDays: 2,
        importFeeFixed: 850,
        importFeePerUnit: 11.5,
        originPort: "宁波舟山港",
        destinationPort: "洛杉矶长滩港",
        stopoverPorts: [{ port: "釜山港", plannedDate: d(-14), actualDate: d(-14), note: "船司挂靠中转港（仅作事件记录，不产生库存）" }],
        trackingNumber: "CMAU-8841209",
        blNumber: "BL-2611-001",
        containerNo: "CMAU4829102",
        voyageNo: "V.2611E",
        status: "confirmed",
        milestones: {
          departActualDate: d(-18),
          borderArrivalPlannedDate: d(-2),
          borderArrivalActualDate: null, // Overdue 2 days unconfirmed -> triggers real operational exception!
          customsReleasePlannedDate: d(2),
          customsReleaseActualDate: null,
          marketStockAvailablePlannedDate: d(4),
          marketStockAvailableActualDate: null
        },
        note: "已超过预计抵港日 2 天但尚未收到到港确认回执，请向货代核实。"
      },
      shp_002: {
        id: "shp_002",
        code: "SHP-002",
        productId: sku,
        laneId: "lane_hz_us_sea",
        fromNodeId: "src_cn_hz",
        toNodeId: "mkt_us",
        batchId: null,
        qty: 1100,
        departDate: d(-14),
        mode: "sea_express",
        carrier: "美森轮船 Matson",
        transitDays: 13,
        fixedCost: 3350,
        unitCost: 10.2,
        customsWaitDays: 4,
        putawayDays: 2,
        importFeeFixed: 850,
        importFeePerUnit: 11.5,
        originPort: "宁波舟山港",
        destinationPort: "洛杉矶长滩港",
        stopoverPorts: [],
        trackingNumber: "MATS-7710394",
        blNumber: "BL-2611-008",
        containerNo: "MATU9120441",
        voyageNo: "CLX-2645",
        status: "confirmed",
        milestones: {
          departActualDate: d(-14),
          borderArrivalPlannedDate: d(-1),
          borderArrivalActualDate: d(-1), // Confirmed arrived at port yesterday -> Awaiting Customs!
          customsReleasePlannedDate: d(3),
          customsReleaseActualDate: null,
          marketStockAvailablePlannedDate: d(5),
          marketStockAvailableActualDate: null
        },
        note: "昨日已实际靠泊长滩港，正在美国海关清关中。"
      },
      shp_003: {
        id: "shp_003",
        code: "SHP-003",
        productId: sku,
        laneId: "lane_hz_us_sea",
        fromNodeId: "src_cn_hz",
        toNodeId: "mkt_us",
        batchId: null,
        qty: 1300,
        departDate: d(4),
        mode: "sea",
        carrier: "以星航运 ZIM",
        transitDays: 21, // Different duration on same corridor!
        fixedCost: 2700,
        unitCost: 8.2,
        customsWaitDays: 4,
        putawayDays: 2,
        importFeeFixed: 850,
        importFeePerUnit: 11.5,
        originPort: "上海洋山港",
        destinationPort: "奥克兰港",
        stopoverPorts: [],
        trackingNumber: "",
        blNumber: "",
        containerNo: "",
        voyageNo: "",
        status: "planned",
        milestones: WM.computeDefaultMilestones(d(4), 21, 4, 2),
        note: "常规慢船补货计划（独立运输时长 21 天）"
      },
      shp_004: {
        id: "shp_004",
        code: "SHP-004",
        productId: sku,
        laneId: "lane_hz2_us_air",
        fromNodeId: "src_cn_hz2",
        toNodeId: "mkt_us",
        batchId: null,
        qty: 650,
        departDate: d(3),
        mode: "air",
        carrier: "跨太平洋货航",
        transitDays: 5,
        fixedCost: 4500,
        unitCost: 23.5,
        customsWaitDays: 2,
        putawayDays: 1,
        importFeeFixed: 650,
        importFeePerUnit: 11.0,
        originPort: "杭州萧山机场",
        destinationPort: "洛杉矶 LAX",
        stopoverPorts: [],
        trackingNumber: "",
        blNumber: "",
        containerNo: "",
        voyageNo: "",
        status: "planned",
        milestones: WM.computeDefaultMilestones(d(3), 5, 2, 1),
        note: "二厂空运紧急补库，缓冲美国市场中期需求爬坡"
      },
      shp_005: {
        id: "shp_005",
        code: "SHP-005",
        productId: sku,
        laneId: "lane_hz_eu_sea",
        fromNodeId: "src_cn_hz",
        toNodeId: "mkt_eu",
        batchId: null,
        qty: 1200,
        departDate: d(-10),
        mode: "sea",
        carrier: "中远海运 COSCO",
        transitDays: 26,
        fixedCost: 3600,
        unitCost: 8.4,
        customsWaitDays: 4,
        putawayDays: 2,
        importFeeFixed: 720,
        importFeePerUnit: 9.0,
        originPort: "上海洋山港",
        destinationPort: "汉堡港",
        stopoverPorts: [{ port: "新加坡港", plannedDate: d(-4), actualDate: d(-4), note: "干线挂靠停泊" }],
        trackingNumber: "COSU-6291044",
        blNumber: "BL-2611-012",
        containerNo: "CSLU2910442",
        voyageNo: "AEU3-2644W",
        status: "confirmed",
        milestones: {
          departActualDate: d(-10),
          borderArrivalPlannedDate: d(16),
          borderArrivalActualDate: null,
          customsReleasePlannedDate: d(20),
          customsReleaseActualDate: null,
          marketStockAvailablePlannedDate: d(22),
          marketStockAvailableActualDate: null
        },
        note: "正常在途，已离泊新加坡港。"
      },
      shp_006: {
        id: "shp_006",
        code: "SHP-006",
        productId: sku,
        laneId: "lane_hz_jp_sea",
        fromNodeId: "src_cn_hz",
        toNodeId: "mkt_jp",
        batchId: null,
        qty: 850,
        departDate: d(-5),
        mode: "sea",
        carrier: "锦江航运",
        transitDays: 6,
        fixedCost: 1150,
        unitCost: 3.8,
        customsWaitDays: 2,
        putawayDays: 1,
        importFeeFixed: 420,
        importFeePerUnit: 6.5,
        originPort: "宁波港",
        destinationPort: "东京港",
        stopoverPorts: [],
        trackingNumber: "JJSH-440219",
        blNumber: "BL-2611-019",
        containerNo: "JJSU1029384",
        voyageNo: "JP-2647",
        status: "confirmed",
        milestones: {
          departActualDate: d(-5),
          borderArrivalPlannedDate: d(1),
          borderArrivalActualDate: null,
          customsReleasePlannedDate: d(3),
          customsReleaseActualDate: null,
          marketStockAvailablePlannedDate: d(4),
          marketStockAvailableActualDate: null
        },
        note: "预计明日靠泊东京港，未来 4 天内入库可用。"
      },
      shp_007: {
        id: "shp_007",
        code: "SHP-007",
        productId: sku,
        laneId: "lane_hz_us_sea",
        fromNodeId: "src_cn_hz",
        toNodeId: "mkt_us",
        batchId: "bat_hz_01",
        qty: 1500,
        departDate: d(13),
        mode: "sea_express",
        carrier: "美森轮船 Matson",
        transitDays: 14,
        fixedCost: 3200,
        unitCost: 9.8,
        customsWaitDays: 4,
        putawayDays: 2,
        importFeeFixed: 850,
        importFeePerUnit: 11.5,
        originPort: "宁波舟山港",
        destinationPort: "洛杉矶长滩港",
        stopoverPorts: [],
        trackingNumber: "",
        blNumber: "",
        containerNo: "",
        voyageNo: "",
        status: "planned",
        milestones: WM.computeDefaultMilestones(d(13), 14, 4, 2),
        note: "绑定 BAT-HZ-01 批次（12天后可用），次日装船发往美国。"
      }
    };

    const facts = [
      { eventId: "ev_001", kind: "shipment_dispatched", date: d(-18), targetId: "shp_001", qty: 900, note: "SHP-001 确认宁波港装船离泊（示例数据）", recordedAt: Date.now() - 86400000 * 18, actor: "demo_ops", supersedesEventId: null },
      { eventId: "ev_002", kind: "shipment_dispatched", date: d(-14), targetId: "shp_002", qty: 1100, note: "SHP-002 确认美森快船离港（示例数据）", recordedAt: Date.now() - 86400000 * 14, actor: "demo_ops", supersedesEventId: null },
      { eventId: "ev_003", kind: "border_arrival", date: d(-1), targetId: "shp_002", qty: 1100, note: "SHP-002 实际靠泊长滩港，等待清关（示例数据）", recordedAt: Date.now() - 86400000, actor: "demo_ops", supersedesEventId: null },
      { eventId: "ev_004", kind: "shipment_dispatched", date: d(-10), targetId: "shp_005", qty: 1200, note: "SHP-005 确认上海港开船发往汉堡（示例数据）", recordedAt: Date.now() - 86400000 * 10, actor: "demo_ops", supersedesEventId: null },
      { eventId: "ev_005", kind: "shipment_dispatched", date: d(-5), targetId: "shp_006", qty: 850, note: "SHP-006 确认宁波港开船发往东京（示例数据）", recordedAt: Date.now() - 86400000 * 5, actor: "demo_ops", supersedesEventId: null }
    ];

    return {
      format: WM.WORLD_FORMAT,
      version: WM.WORLD_VERSION,
      workspaceId: "ws_gw_g200_demo_v2",
      name: `智能网关 G200 · 销售供应链运营（示例数据）`,
      dataSourceMode: "demo",
      inventoryAnchorDate: anchorDate,
      viewHorizonDays: 30,
      revision: 1,
      activeProductId: sku,
      products: {
        [sku]: {
          productId: sku,
          skuCode: sku,
          name: bomProd.name || "智能网关 G200",
          unit: bomProd.unit || "台",
          bomDiagramId: bomProd.diagramId || "d1",
          bomMaterialId: bomProd.materialId || "m2",
          bomVersion: bomProd.bomVersion || 7,
          unitManufacturingCost: 185,
          costSource: "bom_linked",
          note: bomProd.note || ""
        }
      },
      nodes,
      lanes,
      curves,
      batches,
      shipments,
      facts,
      processedActionIds: [],
      actionLog: [],
      migrationNotice: null,
      legacyArchive: null
    };
  }

  const DemoWorld = { createDemoWorkspace };
  global.SC = global.SC || {};
  global.SC.DemoWorld = DemoWorld;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = DemoWorld;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
