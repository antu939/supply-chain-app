/**
 * Sales 供应链业务系统 V0.2
 * 统一业务数据模型（单一正式业务计划、绝对自然日期、工厂→市场直连、三级数据继承）
 */

export type NodeKind = "source" | "market";
export type TransportMode = "sea" | "sea_express" | "air" | "rail" | "truck";
export type DataSourceMode = "demo" | "live";

export interface ProductRef {
  productId: string;
  skuCode: string;
  name: string;
  unit: string;
  bomDiagramId: string | null;
  bomMaterialId: string | null;
  bomVersion: number | null;
  unitManufacturingCost: number;
  costSource: "bom_linked" | "user_input";
  note?: string;
}

export interface RatePoint {
  id: string;
  date: string;  // Absolute local ISO date YYYY-MM-DD
  rate: number;  // >= 0, units/day
}

export interface ShapeAnchor {
  t: number;      // [0, 1]
  weight: number; // >= 0
}

export interface TotalSegment {
  id: string;
  startDate: string; // Absolute ISO date YYYY-MM-DD
  endDate: string;   // Absolute ISO date YYYY-MM-DD (strictly > startDate)
  totalQty: number;
  distribution: "uniform" | "custom";
  shapeAnchors?: ShapeAnchor[];
  label?: string;
  sourcePrecision: "interval_total";
}

export interface DailyActualPoint {
  date: string; // Absolute ISO date YYYY-MM-DD
  qty: number;
  source: "csv_daily_actual";
}

export interface TimeSeriesCurve {
  id: string;
  targetNodeId: string;
  kind: "production" | "capacity" | "demand";
  unit: "units/day";
  points: RatePoint[];
  totalSegments: TotalSegment[];
  importedDailyActuals: DailyActualPoint[];
}

export interface MarketPolicy {
  priority: number;
  lastMileUnitCost: number;
  fulfillmentUnitCost: number;
  channelCommissionUnitCost: number;
  /** @deprecated V0.3 起不再参与市场预测计算，仅保留兼容旧数据读取 */
  orderToShipToleranceDays?: number;
  /** @deprecated V0.3 起不再参与市场预测计算，仅保留兼容旧数据读取 */
  orderToDeliveryToleranceDays?: number;
  /** @deprecated V0.3 起不再参与市场预测计算，仅保留兼容旧数据读取 */
  orderProcessingDays?: number;
  /** @deprecated V0.3 起不再参与市场预测计算，仅保留兼容旧数据读取 */
  lastMileDays?: number;
  /** @deprecated V0.3 起不再参与市场预测计算，仅保留兼容旧数据读取 */
  initialUnfulfilledDemand?: number;
}

export interface BusinessNode {
  id: string;
  kind: NodeKind; // Strictly "source" (工厂) or "market" (目标市场)
  name: string;
  region: string;
  city?: string;
  /** Schematic map coordinate (0..1000 x 0..300) for clean factory->market display */
  mapX?: number;
  mapY?: number;
  bomFactoryId?: string | null;
  bomCompanyId?: string | null;
  initialInventory: number;
  marketPolicy?: MarketPolicy;
  note?: string;
}

/**
 * 第二层：常用物流方案（仅作默认值模板，修改模板绝不改写历史或已有发运单）
 */
export interface LogisticsLaneTemplate {
  id: string;
  name: string;
  fromNodeId: string; // Factory ID
  toNodeId: string;   // Market ID
  defaultMode: TransportMode;
  defaultCarrier: string;
  defaultTransitDays: number;
  defaultFixedCost: number;
  defaultUnitCost: number;
  defaultOriginPort: string;
  defaultDestinationPort: string;
  defaultCustomsWaitDays: number;
  defaultPutawayDays: number;
  defaultImportFeeFixed: number;
  defaultImportFeePerUnit: number;
  note?: string;
}

export interface StopoverPort {
  port: string;
  plannedDate?: string | null;
  actualDate?: string | null;
  note?: string;
}

export interface ShipmentMilestones {
  departActualDate: string | null;
  borderArrivalPlannedDate: string;
  borderArrivalActualDate: string | null;
  customsReleasePlannedDate: string;
  customsReleaseActualDate: string | null;
  marketStockAvailablePlannedDate: string;
  marketStockAvailableActualDate: string | null;
}

/**
 * 第三层：单次发运单（真实业务对象，每笔发运拥有独立时效、费用与进度）
 */
export interface ShipmentOrder {
  id: string;
  code: string;
  productId: string;
  laneId?: string | null; // Optional template reference
  fromNodeId: string;     // Factory ID
  toNodeId: string;       // Market ID
  batchId?: string | null;
  allocationPct?: number | null; // Optional input ratio (%) relative to batch total; qty remains the calculation basis
  qty: number;
  originMonth?: string;   // Immutable YYYY-MM business partition month
  departDate: string;     // Absolute YYYY-MM-DD
  mode: TransportMode;
  carrier: string;
  transitDays: number;    // Independent per shipment
  fixedCost: number;      // Independent per shipment
  unitCost: number;       // Independent per shipment
  customsWaitDays: number;
  putawayDays: number;
  importFeeFixed: number;
  importFeePerUnit: number;
  originPort?: string;
  destinationPort?: string;
  stopoverPorts?: StopoverPort[]; // Informational only, NEVER creates inventory
  trackingNumber?: string;
  blNumber?: string;
  containerNo?: string;
  voyageNo?: string;
  status: "planned" | "confirmed" | "cancelled";
  milestones: ShipmentMilestones;
  note?: string;
}

export interface ProductionBatch {
  id: string;
  code: string;
  sourceNodeId: string;
  productId: string;
  startDate: string; // Absolute YYYY-MM-DD
  endDate: string;   // Absolute YYYY-MM-DD
  extraWaitDays: number;
  availableDate: string; // endDate + extraWaitDays
  qtyOverride?: number | null;
  status: "planned" | "confirmed";
  note?: string;
}

export type FactEventKind =
  | "production_confirmed"
  | "shipment_dispatched"
  | "border_arrival"
  | "customs_release"
  | "market_stock_available"
  | "inventory_stocktake";

export interface ConfirmedFactEvent {
  eventId: string;
  kind: FactEventKind;
  date: string; // Absolute YYYY-MM-DD
  targetId: string;
  qty?: number;
  note: string;
  recordedAt: number;
  actor: string;
  supersedesEventId?: string | null;
}

export interface ActionEnvelope {
  actionId: string;
  workspaceId: string;
  baseRevision: number;
  actor: "user" | "ai_agent" | "system" | string;
  type: string;
  targetId: string;
  payload: Record<string, unknown>;
  timestamp?: number;
}

export interface MigrationNotice {
  migratedAt: number;
  fromVersion: number;
  backupKey: string | null;
  archivedBufferCount: number;
  archivedShipmentCount: number;
  messages: string[];
  dismissed: boolean;
}

export interface SalesWorkspace {
  format: "sc-sales-world";
  version: 2;
  workspaceId: string;
  name: string;
  dataSourceMode: DataSourceMode;
  inventoryAnchorDate: string; // Absolute YYYY-MM-DD where initialInventory applies
  viewHorizonDays: number;     // Integer in [7, 180]; UI offers presets
  revision: number;
  activeProductId: string;
  products: Record<string, ProductRef>;
  nodes: Record<string, BusinessNode>;
  lanes: Record<string, LogisticsLaneTemplate>;
  curves: Record<string, TimeSeriesCurve>;
  batches: Record<string, ProductionBatch>;
  shipments: Record<string, ShipmentOrder>;
  facts: ConfirmedFactEvent[];
  processedActionIds: string[];
  actionLog: ActionEnvelope[];
  migrationNotice?: MigrationNotice | null;
  legacyArchive?: {
    removedBuffers?: Record<string, unknown>;
    incompatibleShipments?: Record<string, unknown>;
  } | null;
}
