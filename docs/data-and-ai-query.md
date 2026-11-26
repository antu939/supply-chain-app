# JSON 数据组织与只读 AI 检索接口说明

## 一、逻辑 JSON 分区结构

应用保持原有 JSON 技术路线，不引入 SQL 或外部数据库。逻辑上分为 **BOM 按主体组织**、**销售按原始业务月份组织** 与 **轻量索引 `manifest.json`**，不划分 `current` / `history` 双目录：

```text
manifest.json          # 轻量索引：分区位置、月份、主体 ID、计数、跨模块显式关联与版本号
bom/
  entities.json        # BOM 稳定主体：companies、factories、materials、diagrams、nodes、relationships、assessments
sales/
  master.json          # 销售基础资料：nodes（工厂/市场）、products、lanes、curves、工作区设置
  2026-10.json         # 按原始业务月份归属的 batches、shipments、facts（永久归属，不随时间迁移）
  2026-11.json         # 同上
```

### 存储实现与未来桌面版映射

- **当前浏览器环境**：继续以既有键 `bom-flow-sim-v5` 与 `sc-sales-world-v2` 作为权威业务存储，确保旧数据、刷新与既有 JSON 备份/恢复 100% 兼容；派生索引缓存在 `sc-data-manifest-v1`，随时可从原始业务数据完整重建（`SCDataStore.rebuildManifest()`）。
- **未来桌面版文件存储**：`SCDataStore.readPartition(id, { partitionProvider })` 与 `SCDataStore.exportLogicalBundle()` 已采用完全一致的逻辑路径和结构，封装桌面端时只需提供按路径读写的 `partitionProvider`，即可直接落地为同名物理 JSON 文件，无需改动查询接口。

### 跨月与不可迁移规则

- 生产批次（`batch`）与发运单（`shipment`）在创建或首次编辑时锁定 `originMonth`（`YYYY-MM`），旧数据按 `startDate` / `departPlannedDate || departDate` 确定性推导；业务事件（`fact`）按 `date` 归属。
- 时间流逝或后续状态更新（如 10 月发运在 11 月抵港清关、或在 11 月调整预计发运日）不会迁移原记录所在月份分区；跨月批次、发运与事实通过原有稳定 ID（`batchId`、`targetId`、`supersedesEventId`）保持关联，并由 `manifest.json` 定位。

---

## 二、只读 AI 检索接口（`window.SCAIQuery`）

所有接口均为**严格只读**，默认分页（`limit` 默认 `20`，上限 `100`），返回值统一包含 `meta.partitionsRead`、`meta.total`、`meta.hasMore` 与版本信息，避免一次性将全部 JSON 展开到上下文。

### 1. 查询可用分区与索引（不读取业务正文）

```js
SCAIQuery.listPartitions({ domain: "all" });
// => { ok: true, data: { partitions: [...], links: { bomFactoryToSalesNode: {...} } }, meta: { partitionsRead: ["manifest.json"], ... } }
```

### 2. 按主体与合规条件查询 BOM

```js
// 查询存在严重合规问题的公司
SCAIQuery.queryBomEntities({ kind: "company", complianceStatus: "severe", limit: 10, offset: 0 });

// 按稳定 ID 深入读取某家公司、工厂或产品 BOM 结构
SCAIQuery.getBomDetail({ companyId: "c1" });
SCAIQuery.getBomDetail({ factoryId: "f1" });
SCAIQuery.getBomDetail({ diagramId: "d1" });
```

### 3. 按月份、时间范围、工厂或批次查询销售数据

```js
// 仅读取 2026-10 分区中的发运单（跳过其他无关月份）
SCAIQuery.querySales({ entity: "shipments", month: "2026-10", factoryId: "f1", limit: 20 });

// 按时间范围查询（自动通过索引覆盖跨月活跃记录）
SCAIQuery.querySales({ entity: "batches", fromDate: "2026-11-01", toDate: "2026-11-30" });

// 跨月追溯同一批次关联的全部发运单
SCAIQuery.querySales({ entity: "shipments", batchId: "bat_oct_01" });
```

### 4. 跨模块查询上下游资料（仅基于显式 `bomFactoryId` 关联）

```js
SCAIQuery.getCrossModuleFactoryView({ bomFactoryId: "f1", monthFrom: "2026-10", monthTo: "2026-11" });
// => { ok: true, data: { linked: true, bom: { factory, company, upstreamSuppliers, marketAssessments }, sales: { factoryNode, batches, shipments } }, meta: { ... } }
```
