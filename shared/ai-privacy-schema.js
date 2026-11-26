(function (global) {
  "use strict";

  const SCHEMA_VERSION = "1.0";

  /**
   * Four-tier data sensitivity classification.
   * Unknown fields are ALWAYS denied by default (never sent externally).
   */
  const SENSITIVITY_LEVELS = Object.freeze({
    L1_STRUCTURAL: "L1_STRUCTURAL", // 业务关系与必要结构信息（原始 ID 仍须映射为稳定匿名代号）
    L2_IDENTITY: "L2_IDENTITY",     // 企业、工厂、产品、市场、承运商、口岸、地区等身份信息
    L3_COMMERCIAL: "L3_COMMERCIAL", // 产量、需求、库存、成本、历史内部评分等商业敏感信息
    L4_SENSITIVE: "L4_SENSITIVE"    // 联系方式、详细地址、单据编号、操作人、自由文本备注、自定义字段
  });

  const FIELD_CATEGORIES = Object.freeze({
    // L1: Structural & relational
    "structural.topology": SENSITIVITY_LEVELS.L1_STRUCTURAL,
    "structural.compliance_status": SENSITIVITY_LEVELS.L1_STRUCTURAL,
    "structural.schedule": SENSITIVITY_LEVELS.L1_STRUCTURAL,
    "structural.bom_recipe": SENSITIVITY_LEVELS.L1_STRUCTURAL,

    // L2: Identity
    "identity.entity_name": SENSITIVITY_LEVELS.L2_IDENTITY,
    "identity.market_name": SENSITIVITY_LEVELS.L2_IDENTITY,
    "identity.product_name": SENSITIVITY_LEVELS.L2_IDENTITY,
    "identity.product_code": SENSITIVITY_LEVELS.L2_IDENTITY,
    "identity.region": SENSITIVITY_LEVELS.L2_IDENTITY,
    "identity.city": SENSITIVITY_LEVELS.L2_IDENTITY,
    "identity.carrier": SENSITIVITY_LEVELS.L2_IDENTITY,
    "identity.location_port": SENSITIVITY_LEVELS.L2_IDENTITY,

    // L3: Commercial & operational metrics
    "commercial.volume": SENSITIVITY_LEVELS.L3_COMMERCIAL,
    "commercial.inventory": SENSITIVITY_LEVELS.L3_COMMERCIAL,
    "commercial.demand": SENSITIVITY_LEVELS.L3_COMMERCIAL,
    "commercial.cost": SENSITIVITY_LEVELS.L3_COMMERCIAL,
    "commercial.internal_score": SENSITIVITY_LEVELS.L3_COMMERCIAL,

    // L4: PII, document numbers, free text
    "sensitive.contact": SENSITIVITY_LEVELS.L4_SENSITIVE,
    "sensitive.address": SENSITIVITY_LEVELS.L4_SENSITIVE,
    "sensitive.document_number": SENSITIVITY_LEVELS.L4_SENSITIVE,
    "sensitive.free_text": SENSITIVITY_LEVELS.L4_SENSITIVE
  });

  /**
   * Independent egress channels.
   * Granting access on MODEL_CONTEXT NEVER grants access on WEB_SEARCH.
   */
  const CHANNELS = Object.freeze({
    MODEL_CONTEXT: "model_context",
    WEB_SEARCH: "web_search"
  });

  const CHANNEL_POLICIES = Object.freeze({
    [CHANNELS.MODEL_CONTEXT]: Object.freeze({
      allowAnonymousIds: true,
      allowRawIds: false,
      allowVaultExport: false,
      unknownFieldPolicy: "deny",
      inheritFromOtherChannel: false,
      hardDeniedCategories: Object.freeze([
        "sensitive.contact",
        "sensitive.address",
        "sensitive.document_number"
      ]),
      confirmationRequiredCategories: Object.freeze([
        "sensitive.free_text"
      ])
    }),
    [CHANNELS.WEB_SEARCH]: Object.freeze({
      allowAnonymousIds: false,
      allowRawIds: false,
      allowVaultExport: false,
      unknownFieldPolicy: "deny",
      inheritFromOtherChannel: false,
      hardDeniedCategories: Object.freeze([
        "commercial.volume",
        "commercial.inventory",
        "commercial.demand",
        "commercial.cost",
        "commercial.internal_score",
        "sensitive.contact",
        "sensitive.address",
        "sensitive.document_number",
        "sensitive.free_text",
        "identity.product_code"
      ]),
      confirmationRequiredCategories: Object.freeze([])
    })
  });

  /**
   * Minimal-disclosure task scopes for MODEL_CONTEXT.
   * Default scope is `relationship_only` (strictly L1 structural & pseudonymized topology).
   */
  const DISCLOSURE_SCOPES = Object.freeze({
    relationship_only: Object.freeze({
      name: "relationship_only",
      description: "最小必要披露：仅包含匿名化主体 ID、上下游/跨模块拓扑、合规状态枚举与基础排程结构，不含真实名称、商业金额数量或自由文本。",
      allowedCategories: Object.freeze([
        "structural.topology",
        "structural.compliance_status",
        "structural.schedule",
        "structural.bom_recipe"
      ])
    }),
    compliance_overview: Object.freeze({
      name: "compliance_overview",
      description: "合规总览：包含匿名主体关系、四色合规状态、市场准入状态与粗粒度地区，不含真实名称、价格产量、联系方式或自由文本。",
      allowedCategories: Object.freeze([
        "structural.topology",
        "structural.compliance_status",
        "structural.schedule",
        "structural.bom_recipe",
        "identity.region"
      ])
    }),
    inventory_risk: Object.freeze({
      name: "inventory_risk",
      description: "库存与断货风险分析：包含匿名工厂/市场拓扑、排程、库存/需求/发运数量与市场大区，不含真实企业名称与采购/物流成本。",
      allowedCategories: Object.freeze([
        "structural.topology",
        "structural.schedule",
        "identity.region",
        "commercial.volume",
        "commercial.inventory",
        "commercial.demand"
      ])
    }),
    logistics_tracking: Object.freeze({
      name: "logistics_tracking",
      description: "物流与清关进度追踪：包含匿名发运节点、里程碑、运输方式、大区/口岸/承运商与发运数量，不含真实企业名称、费用与提单/箱号/追踪号。",
      allowedCategories: Object.freeze([
        "structural.topology",
        "structural.schedule",
        "identity.region",
        "identity.location_port",
        "identity.carrier",
        "commercial.volume"
      ])
    }),
    cost_analysis: Object.freeze({
      name: "cost_analysis",
      description: "成本测算分析（需显式指定）：包含匿名主体与成本/数量/库存/需求指标，仍保持企业与工厂匿名，不含联系方式、单据号和自由文本。",
      allowedCategories: Object.freeze([
        "structural.topology",
        "structural.schedule",
        "structural.bom_recipe",
        "commercial.volume",
        "commercial.inventory",
        "commercial.demand",
        "commercial.cost"
      ])
    }),
    public_entity_lookup: Object.freeze({
      name: "public_entity_lookup",
      description: "指定主体公开信息核查：默认仍为匿名结构，仅对用户显式授权的 authorizedRealNameIds 披露真实名称，不含任何商业数量、成本或自由文本。",
      allowedCategories: Object.freeze([
        "structural.topology",
        "structural.compliance_status",
        "identity.region"
      ])
    })
  });

  const DEFAULT_SCOPE = "relationship_only";

  /**
   * Explicit positive field whitelists for every known business object shape.
   * Any field NOT listed here is dropped by default (deny-by-default).
   */
  const ENTITY_SCHEMAS = Object.freeze({
    bom_compliance: Object.freeze({
      status: { category: "structural.compliance_status" },
      updatedAt: { category: "structural.schedule" },
      legacyScore: { category: "commercial.internal_score" },
      reason: { category: "sensitive.free_text", freeText: true }
    }),

    bom_company_summary: Object.freeze({
      kind: { category: "structural.topology" },
      id: { category: "structural.topology", idType: "company" },
      name: { category: "identity.entity_name", entityNameOf: { field: "id", type: "company" } },
      location: { category: "sensitive.address" },
      factoryCount: { category: "structural.topology" },
      compliance: { category: "structural.compliance_status", nestedSchema: "bom_compliance" }
    }),

    bom_company_detail: Object.freeze({
      id: { category: "structural.topology", idType: "company" },
      name: { category: "identity.entity_name", entityNameOf: { field: "id", type: "company" } },
      location: { category: "sensitive.address" },
      contact: { category: "sensitive.contact" },
      note: { category: "sensitive.free_text", freeText: true },
      status: { category: "structural.topology" },
      isFinalAssembler: { category: "structural.topology" },
      compliance: { category: "structural.compliance_status", nestedSchema: "bom_compliance" }
      // extraFields intentionally NOT whitelisted for direct egress (L4 custom free text)
    }),

    bom_factory_summary: Object.freeze({
      kind: { category: "structural.topology" },
      id: { category: "structural.topology", idType: "factory" },
      name: { category: "identity.entity_name", entityNameOf: { field: "id", type: "factory" } },
      companyId: { category: "structural.topology", idType: "company" },
      companyName: { category: "identity.entity_name", entityNameOf: { field: "companyId", type: "company" } },
      location: { category: "sensitive.address" },
      region: { category: "identity.region" },
      city: { category: "identity.city" },
      status: { category: "structural.topology" },
      isFinalAssembly: { category: "structural.topology" },
      linkedSalesNodeId: { category: "structural.topology", idType: "sales_factory" }
    }),

    bom_factory_detail: Object.freeze({
      id: { category: "structural.topology", idType: "factory" },
      companyId: { category: "structural.topology", idType: "company" },
      name: { category: "identity.entity_name", entityNameOf: { field: "id", type: "factory" } },
      location: { category: "sensitive.address" },
      contact: { category: "sensitive.contact" },
      note: { category: "sensitive.free_text", freeText: true },
      region: { category: "identity.region" },
      city: { category: "identity.city" },
      status: { category: "structural.topology" },
      isFinalAssembly: { category: "structural.topology" }
      // extraFields intentionally NOT whitelisted
    }),

    bom_material_summary: Object.freeze({
      kind: { category: "structural.topology" },
      id: { category: "structural.topology", idType: "material" },
      code: { category: "identity.product_code" },
      name: { category: "identity.product_name", entityNameOf: { field: "id", type: "material" } },
      usedInDiagramIds: { category: "structural.topology", idArrayType: "diagram" },
      usageCount: { category: "structural.topology" },
      supplierCompanyIds: { category: "structural.topology", idArrayType: "company" },
      note: { category: "sensitive.free_text", freeText: true }
    }),

    bom_diagram_summary: Object.freeze({
      kind: { category: "structural.topology" },
      id: { category: "structural.topology", idType: "diagram" },
      productId: { category: "structural.topology", idType: "material" },
      skuCode: { category: "identity.product_code" },
      name: { category: "identity.product_name", entityNameOf: { field: "productId", type: "material" } },
      rootNodeId: { category: "structural.topology", idType: "bom_node" },
      rootCompanyIds: { category: "structural.topology", idArrayType: "company" },
      componentCount: { category: "structural.topology" }
    }),

    bom_supplier_ref: Object.freeze({
      id: { category: "structural.topology", idType: "company" },
      name: { category: "identity.entity_name", entityNameOf: { field: "id", type: "company" } },
      complianceStatus: { category: "structural.compliance_status" }
    }),

    bom_receiver_ref: Object.freeze({
      id: { category: "structural.topology", idType: "company" },
      name: { category: "identity.entity_name", entityNameOf: { field: "id", type: "company" } }
    }),

    bom_factory_path: Object.freeze({
      nodeId: { category: "structural.topology", idType: "bom_node" },
      componentName: { category: "identity.product_name" },
      receiverCompanyId: { category: "structural.topology", idType: "company" },
      supplierCompanyId: { category: "structural.topology", idType: "company" },
      receiverFactoryId: { category: "structural.topology", idType: "factory" },
      supplierFactoryId: { category: "structural.topology", idType: "factory" }
    }),

    bom_assessment_item: Object.freeze({
      id: { category: "structural.topology", idType: "assessment_item" },
      title: { category: "sensitive.free_text", freeText: true },
      detail: { category: "sensitive.free_text", freeText: true },
      source: { category: "sensitive.free_text", freeText: true }
    }),

    bom_assessment: Object.freeze({
      diagramId: { category: "structural.topology", idType: "diagram" },
      productName: { category: "identity.product_name" },
      market: { category: "structural.compliance_status" },
      status: { category: "structural.compliance_status" },
      updatedAt: { category: "structural.schedule" },
      evidenceCount: { category: "structural.compliance_status", derivedCountFrom: "evidence" },
      pendingItemCount: { category: "structural.compliance_status", derivedCountFrom: "pendingItems" },
      evidence: { category: "sensitive.free_text", nestedArraySchema: "bom_assessment_item", freeTextContainer: true },
      pendingItems: { category: "sensitive.free_text", nestedArraySchema: "bom_assessment_item", freeTextContainer: true }
    }),

    bom_node_detail: Object.freeze({
      id: { category: "structural.topology", idType: "bom_node" },
      parentId: { category: "structural.topology", idType: "bom_node" },
      materialId: { category: "structural.topology", idType: "material" },
      name: { category: "identity.product_name", entityNameOf: { field: "materialId", type: "material" } },
      code: { category: "identity.product_code" },
      qty: { category: "structural.bom_recipe" },
      unit: { category: "structural.bom_recipe" },
      companies: { category: "structural.topology", nestedArraySchema: "bom_supplier_ref" }
    }),

    sales_market_policy: Object.freeze({
      priority: { category: "structural.topology" },
      lastMileUnitCost: { category: "commercial.cost" },
      fulfillmentUnitCost: { category: "commercial.cost" },
      channelCommissionUnitCost: { category: "commercial.cost" }
    }),

    sales_node: Object.freeze({
      id: { category: "structural.topology", idType: "sales_node_auto" },
      kind: { category: "structural.topology" },
      name: { category: "identity.entity_name", entityNameOf: { field: "id", type: "sales_node_auto" }, marketNameCategory: "identity.market_name" },
      region: { category: "identity.region" },
      city: { category: "identity.city" },
      bomFactoryId: { category: "structural.topology", idType: "factory" },
      bomCompanyId: { category: "structural.topology", idType: "company" },
      entityStatus: { category: "structural.topology" },
      initialInventory: { category: "commercial.inventory" },
      marketPolicy: { category: "structural.topology", nestedSchema: "sales_market_policy" },
      note: { category: "sensitive.free_text", freeText: true }
      // mapX, mapY, sharedFactoryId, sharedCompanyId intentionally omitted
    }),

    sales_lane: Object.freeze({
      id: { category: "structural.topology", idType: "lane" },
      name: { category: "identity.entity_name" },
      fromNodeId: { category: "structural.topology", idType: "sales_factory" },
      toNodeId: { category: "structural.topology", idType: "market" },
      defaultMode: { category: "structural.schedule" },
      defaultCarrier: { category: "identity.carrier" },
      defaultTransitDays: { category: "structural.schedule" },
      defaultCustomsWaitDays: { category: "structural.schedule" },
      defaultPutawayDays: { category: "structural.schedule" },
      defaultOriginPort: { category: "identity.location_port" },
      defaultDestinationPort: { category: "identity.location_port" },
      defaultFixedCost: { category: "commercial.cost" },
      defaultUnitCost: { category: "commercial.cost" },
      defaultImportFeeFixed: { category: "commercial.cost" },
      defaultImportFeePerUnit: { category: "commercial.cost" },
      note: { category: "sensitive.free_text", freeText: true }
    }),

    sales_batch: Object.freeze({
      recordType: { category: "structural.topology" },
      partitionId: { category: "structural.topology" },
      id: { category: "structural.topology", idType: "batch" },
      code: { category: "sensitive.document_number" },
      sourceNodeId: { category: "structural.topology", idType: "sales_factory" },
      productId: { category: "structural.topology", idType: "product" },
      originMonth: { category: "structural.schedule" },
      startDate: { category: "structural.schedule" },
      endDate: { category: "structural.schedule" },
      extraWaitDays: { category: "structural.schedule" },
      availableDate: { category: "structural.schedule" },
      qtyOverride: { category: "commercial.volume" },
      status: { category: "structural.topology" },
      note: { category: "sensitive.free_text", freeText: true }
    }),

    sales_original_plan: Object.freeze({
      departDate: { category: "structural.schedule" },
      transitDays: { category: "structural.schedule" },
      customsWaitDays: { category: "structural.schedule" },
      putawayDays: { category: "structural.schedule" },
      borderArrivalPlannedDate: { category: "structural.schedule" },
      customsReleasePlannedDate: { category: "structural.schedule" },
      marketStockAvailablePlannedDate: { category: "structural.schedule" }
    }),

    sales_milestones: Object.freeze({
      departActualDate: { category: "structural.schedule" },
      borderArrivalPlannedDate: { category: "structural.schedule" },
      borderArrivalActualDate: { category: "structural.schedule" },
      customsReleasePlannedDate: { category: "structural.schedule" },
      customsReleaseActualDate: { category: "structural.schedule" },
      marketStockAvailablePlannedDate: { category: "structural.schedule" },
      marketStockAvailableActualDate: { category: "structural.schedule" }
    }),

    sales_stopover_port: Object.freeze({
      port: { category: "identity.location_port" },
      plannedDate: { category: "structural.schedule" },
      actualDate: { category: "structural.schedule" },
      note: { category: "sensitive.free_text", freeText: true }
    }),

    sales_shipment: Object.freeze({
      recordType: { category: "structural.topology" },
      partitionId: { category: "structural.topology" },
      id: { category: "structural.topology", idType: "shipment" },
      code: { category: "sensitive.document_number" },
      productId: { category: "structural.topology", idType: "product" },
      laneId: { category: "structural.topology", idType: "lane" },
      fromNodeId: { category: "structural.topology", idType: "sales_factory" },
      toNodeId: { category: "structural.topology", idType: "market" },
      batchId: { category: "structural.topology", idType: "batch" },
      originMonth: { category: "structural.schedule" },
      departDate: { category: "structural.schedule" },
      mode: { category: "structural.schedule" },
      carrier: { category: "identity.carrier" },
      transitDays: { category: "structural.schedule" },
      customsWaitDays: { category: "structural.schedule" },
      putawayDays: { category: "structural.schedule" },
      qty: { category: "commercial.volume" },
      allocationPct: { category: "commercial.volume" },
      fixedCost: { category: "commercial.cost" },
      unitCost: { category: "commercial.cost" },
      importFeeFixed: { category: "commercial.cost" },
      importFeePerUnit: { category: "commercial.cost" },
      originPort: { category: "identity.location_port" },
      destinationPort: { category: "identity.location_port" },
      stopoverPorts: { category: "structural.schedule", nestedArraySchema: "sales_stopover_port" },
      trackingNumber: { category: "sensitive.document_number" },
      blNumber: { category: "sensitive.document_number" },
      containerNo: { category: "sensitive.document_number" },
      voyageNo: { category: "sensitive.document_number" },
      status: { category: "structural.topology" },
      milestones: { category: "structural.schedule", nestedSchema: "sales_milestones" },
      originalPlan: { category: "structural.schedule", nestedSchema: "sales_original_plan" },
      note: { category: "sensitive.free_text", freeText: true }
    }),

    sales_fact: Object.freeze({
      eventId: { category: "structural.topology", idType: "fact" },
      kind: { category: "structural.topology" },
      date: { category: "structural.schedule" },
      originMonth: { category: "structural.schedule" },
      targetId: { category: "structural.topology", idType: "target_auto" },
      qty: { category: "commercial.volume" },
      recordedAt: { category: "structural.schedule" },
      actor: { category: "sensitive.contact" },
      supersedesEventId: { category: "structural.topology", idType: "fact" },
      note: { category: "sensitive.free_text", freeText: true }
    }),

    sales_product: Object.freeze({
      productId: { category: "structural.topology", idType: "product" },
      skuCode: { category: "identity.product_code" },
      name: { category: "identity.product_name", entityNameOf: { field: "productId", type: "product" } },
      unit: { category: "structural.bom_recipe" },
      bomDiagramId: { category: "structural.topology", idType: "diagram" },
      bomMaterialId: { category: "structural.topology", idType: "material" },
      bomVersion: { category: "structural.bom_recipe" },
      unitManufacturingCost: { category: "commercial.cost" },
      costSource: { category: "structural.bom_recipe" },
      note: { category: "sensitive.free_text", freeText: true }
    }),

    sales_curve_summary: Object.freeze({
      id: { category: "structural.topology", idType: "curve" },
      targetNodeId: { category: "structural.topology", idType: "target_auto" },
      targetKind: { category: "structural.topology" },
      kind: { category: "structural.topology" },
      unit: { category: "structural.bom_recipe" },
      horizonDays: { category: "structural.schedule" },
      pointCount: { category: "structural.topology" },
      segmentCount: { category: "structural.topology" },
      actualCount: { category: "structural.topology" },
      rangeFrom: { category: "structural.schedule" },
      rangeTo: { category: "structural.schedule" },
      rangeDays: { category: "structural.schedule" },
      integratedTotal: { category: "commercial.demand" },
      avgDailyRate: { category: "commercial.demand" },
      minDailyQty: { category: "commercial.demand" },
      maxDailyQty: { category: "commercial.demand" }
    }),

    simulation_costs: Object.freeze({
      manufacturing: { category: "commercial.cost" },
      freightFixed: { category: "commercial.cost" },
      freightUnit: { category: "commercial.cost" },
      customsAndImport: { category: "commercial.cost" },
      localFulfillmentAndChannel: { category: "commercial.cost" },
      total: { category: "commercial.cost" },
      committedTotal: { category: "commercial.cost" },
      projectedTotal: { category: "commercial.cost" }
    }),

    simulation_kpis: Object.freeze({
      currentAvailableInventory: { category: "commercial.inventory" },
      currentInTransit: { category: "commercial.inventory" },
      awaitingCustoms: { category: "commercial.inventory" },
      shelvedPendingNextDay: { category: "commercial.inventory" },
      projectedInPipeline: { category: "commercial.inventory" },
      unreleasedProduction: { category: "commercial.inventory" },
      next7DaysExpectedArrivals: { category: "commercial.inventory" },
      marketsAtRiskCount: { category: "structural.topology" },
      pendingExceptionsCount: { category: "structural.topology" },
      totalLogisticsCost: { category: "commercial.cost" },
      totalAllInCost: { category: "commercial.cost" }
    }),

    simulation_gap_window: Object.freeze({
      startDate: { category: "structural.schedule" },
      endDate: { category: "structural.schedule" },
      peakShortfall: { category: "commercial.demand" },
      gapQty: { category: "commercial.demand" }
    }),

    simulation_market_summary: Object.freeze({
      nodeId: { category: "structural.topology", idType: "market" },
      name: { category: "identity.market_name", entityNameOf: { field: "nodeId", type: "market" } },
      region: { category: "identity.region" },
      priority: { category: "structural.topology" },
      currentAvailable: { category: "commercial.inventory" },
      shelvedPendingNextDay: { category: "commercial.inventory" },
      endingAvailable: { category: "commercial.inventory" },
      minAvailable: { category: "commercial.inventory" },
      daysOfCoverNow: { category: "commercial.inventory" },
      totalDemand: { category: "commercial.demand" },
      totalSatisfied: { category: "commercial.demand" },
      totalDemandGap: { category: "commercial.demand" },
      demandSatisfactionRate: { category: "commercial.demand" },
      firstGapDate: { category: "structural.schedule" },
      gapWindows: { category: "structural.schedule", nestedArraySchema: "simulation_gap_window" },
      incomingCount: { category: "structural.topology" },
      incomingQty: { category: "commercial.inventory" },
      nextPutawayDate: { category: "structural.schedule" },
      nextSellableDate: { category: "structural.schedule" }
    }),

    simulation_factory_snapshot: Object.freeze({
      nodeId: { category: "structural.topology", idType: "sales_factory" },
      bomFactoryId: { category: "structural.topology", idType: "factory" },
      name: { category: "identity.entity_name", entityNameOf: { field: "nodeId", type: "sales_factory" } },
      region: { category: "identity.region" },
      currentAvailable: { category: "commercial.inventory" },
      endingAvailable: { category: "commercial.inventory" },
      releasedProductionInWindow: { category: "commercial.volume" },
      dispatchesInWindow: { category: "commercial.volume" }
    }),

    simulation_shipment_state: Object.freeze({
      shipmentId: { category: "structural.topology", idType: "shipment" },
      fromNodeId: { category: "structural.topology", idType: "sales_factory" },
      toNodeId: { category: "structural.topology", idType: "market" },
      laneId: { category: "structural.topology", idType: "lane" },
      batchId: { category: "structural.topology", idType: "batch" },
      status: { category: "structural.topology" },
      progressStatus: { category: "structural.topology" },
      operationalStatus: { category: "structural.topology" },
      dispatchBasis: { category: "structural.topology" },
      operationalOverdue: { category: "structural.topology" },
      inventoryBucket: { category: "structural.topology" },
      productId: { category: "structural.topology", idType: "product" },
      executed: { category: "structural.topology" },
      mode: { category: "structural.schedule" },
      carrier: { category: "identity.carrier" },
      transitDays: { category: "structural.schedule" },
      qty: { category: "commercial.volume" },
      executedQty: { category: "commercial.volume" },
      totalCost: { category: "commercial.cost" },
      departDate: { category: "structural.schedule" },
      departPlannedDate: { category: "structural.schedule" },
      departActualDate: { category: "structural.schedule" },
      borderArrivalPlannedDate: { category: "structural.schedule" },
      borderArrivalActualDate: { category: "structural.schedule" },
      customsReleasePlannedDate: { category: "structural.schedule" },
      customsReleaseActualDate: { category: "structural.schedule" },
      putawayCompletePlannedDate: { category: "structural.schedule" },
      putawayCompleteActualDate: { category: "structural.schedule" },
      earliestSellablePlannedDate: { category: "structural.schedule" },
      earliestSellableActualDate: { category: "structural.schedule" },
      estimatedBorderDate: { category: "structural.schedule" },
      estimatedReleaseDate: { category: "structural.schedule" },
      estimatedPutawayDate: { category: "structural.schedule" },
      effectiveBorderDate: { category: "structural.schedule" },
      effectiveReleaseDate: { category: "structural.schedule" },
      effectivePutawayDate: { category: "structural.schedule" },
      effectiveSellableDate: { category: "structural.schedule" },
      overdueStage: { category: "structural.topology" },
      overdueDueDate: { category: "structural.schedule" },
      overdueDays: { category: "structural.schedule" },
      isOverdueUnconfirmed: { category: "structural.topology" },
      fullCyclePlannedDays: { category: "structural.schedule" },
      fullCycleElapsedPct: { category: "structural.schedule" },
      fullCycleOverrun: { category: "structural.topology" },
      originalPlan: { category: "structural.schedule", nestedSchema: "sales_original_plan" },
      hasRevisedEstimate: { category: "structural.topology" }
    }),

    simulation_batch_allocation: Object.freeze({
      shipmentId: { category: "structural.topology", idType: "shipment" },
      toNodeId: { category: "structural.topology", idType: "market" },
      qty: { category: "commercial.volume" },
      pct: { category: "commercial.volume" },
      allocationPct: { category: "commercial.volume" },
      status: { category: "structural.topology" },
      isActual: { category: "structural.topology" },
      departDate: { category: "structural.schedule" },
      mode: { category: "structural.schedule" }
    }),

    simulation_batch_state: Object.freeze({
      batchId: { category: "structural.topology", idType: "batch" },
      sourceNodeId: { category: "structural.topology", idType: "sales_factory" },
      startDate: { category: "structural.schedule" },
      endDate: { category: "structural.schedule" },
      extraWaitDays: { category: "structural.schedule" },
      availableDate: { category: "structural.schedule" },
      status: { category: "structural.topology" },
      computedQty: { category: "commercial.volume" },
      plannedAllocatedQty: { category: "commercial.volume" },
      actualDispatchedQty: { category: "commercial.volume" },
      allocatedShipmentQty: { category: "commercial.volume" },
      executedShipmentQty: { category: "commercial.volume" },
      remainingBatchQty: { category: "commercial.volume" },
      allocations: { category: "structural.topology", nestedArraySchema: "simulation_batch_allocation" }
    }),

    simulation_corridor: Object.freeze({
      fromNodeId: { category: "structural.topology", idType: "sales_factory" },
      toNodeId: { category: "structural.topology", idType: "market" },
      laneIds: { category: "structural.topology", idArrayType: "lane" },
      shipmentIds: { category: "structural.topology", idArrayType: "shipment" },
      activeCount: { category: "structural.topology" },
      overdueCount: { category: "structural.topology" },
      blockedCount: { category: "structural.topology" },
      inTransitQty: { category: "commercial.inventory" },
      customsQty: { category: "commercial.inventory" },
      customsCount: { category: "structural.topology" },
      shelvedPendingNextDay: { category: "commercial.inventory" },
      projectedInPipeline: { category: "commercial.inventory" }
    }),

    simulation_upcoming_event: Object.freeze({
      id: { category: "structural.topology", idType: "fact" },
      kind: { category: "structural.topology" },
      date: { category: "structural.schedule" },
      target: { category: "structural.topology", nestedSchema: "simulation_exception_target" },
      title: { category: "sensitive.free_text", freeText: true },
      detail: { category: "sensitive.free_text", freeText: true }
    }),

    simulation_daily_point: Object.freeze({
      date: { category: "structural.schedule" },
      openingAvailable: { category: "commercial.inventory" },
      releasedProduction: { category: "commercial.volume" },
      arrivals: { category: "commercial.inventory" },
      putawayArrivals: { category: "commercial.inventory" },
      shelvedPendingNextDay: { category: "commercial.inventory" },
      projectedInPipeline: { category: "commercial.inventory" },
      unreleasedProductionAccum: { category: "commercial.inventory" },
      dispatches: { category: "commercial.volume" },
      demand: { category: "commercial.demand" },
      satisfiedDemand: { category: "commercial.demand" },
      demandGap: { category: "commercial.demand" },
      endingAvailable: { category: "commercial.inventory" },
      inTransitInbound: { category: "commercial.inventory" },
      atBorder: { category: "commercial.inventory" },
      inCustoms: { category: "commercial.inventory" }
    }),

    simulation_exception_target: Object.freeze({
      kind: { category: "structural.topology" },
      id: { category: "structural.topology", idType: "target_auto" }
    }),

    simulation_exception: Object.freeze({
      id: { category: "structural.topology", idType: "fact" },
      severity: { category: "structural.topology" },
      kind: { category: "structural.topology" },
      date: { category: "structural.schedule" },
      target: { category: "structural.topology", nestedSchema: "simulation_exception_target" },
      title: { category: "sensitive.free_text", freeText: true },
      detail: { category: "sensitive.free_text", freeText: true }
    })
  });

  function getScope(scopeName) {
    if (scopeName && Object.prototype.hasOwnProperty.call(DISCLOSURE_SCOPES, scopeName)) {
      return DISCLOSURE_SCOPES[scopeName];
    }
    return DISCLOSURE_SCOPES[DEFAULT_SCOPE];
  }

  function getChannelPolicy(channel) {
    return CHANNEL_POLICIES[channel] || CHANNEL_POLICIES[CHANNELS.MODEL_CONTEXT];
  }

  function getCategoryLevel(category) {
    return FIELD_CATEGORIES[category] || null;
  }

  /**
   * Compute effective allowed categories for a channel + scope + optional grants.
   * Channel hard-denied categories can NEVER be enabled by scope or grants.
   */
  function resolveAllowedCategories(channel, scopeName, grants) {
    const policy = getChannelPolicy(channel);
    const hardDenied = new Set(policy.hardDeniedCategories || []);
    const allowed = new Set();

    if (channel === CHANNELS.MODEL_CONTEXT) {
      const scope = getScope(scopeName);
      for (const cat of scope.allowedCategories) {
        if (!hardDenied.has(cat)) allowed.add(cat);
      }
      if (grants && Array.isArray(grants.allowedCategories)) {
        for (const cat of grants.allowedCategories) {
          if (Object.prototype.hasOwnProperty.call(FIELD_CATEGORIES, cat) && !hardDenied.has(cat)) {
            allowed.add(cat);
          }
        }
      }
      if (grants && grants.allowFreeText === true && !hardDenied.has("sensitive.free_text")) {
        allowed.add("sensitive.free_text");
      }
    }
    // WEB_SEARCH never inherits MODEL_CONTEXT scope categories; handled strictly by search egress gate.
    return allowed;
  }

  const SCAIPrivacySchema = Object.freeze({
    SCHEMA_VERSION,
    SENSITIVITY_LEVELS,
    FIELD_CATEGORIES,
    CHANNELS,
    CHANNEL_POLICIES,
    DISCLOSURE_SCOPES,
    DEFAULT_SCOPE,
    ENTITY_SCHEMAS,
    getScope,
    getChannelPolicy,
    getCategoryLevel,
    resolveAllowedCategories
  });

  global.SCAIPrivacySchema = SCAIPrivacySchema;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = SCAIPrivacySchema;
  }
})(typeof window !== "undefined" ? window : globalThis);
