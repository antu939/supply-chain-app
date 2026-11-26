# AI 统一工具接口与本地计算层说明（第二阶段）

本文档说明在第一阶段隐私保护层之上建立的统一、轻量、与模型供应商无关的只读 AI 工具调用层。

- **严格只读**：本阶段全部注册工具均为只读（`readOnly: true`），不允许任意代码执行、本地文件系统访问或正式业务数据写入；既有只读修改预演接口（`SCAIQuery.simulateSalesActions`）保留供第五阶段使用，暂不对外部模型开放。
- **复用官方计算引擎**：所有库存预测、需求缺口、发运进度、逾期未确认判定及曲线积分均直接复用官方 `SC.SimEngine`、`SC.TimeSeries`、`SC.WorldModel` 与 `SCAIQuery`，不另造第二套算法。
- **零外部 API 调用**：本阶段纯本地运行，通过 `simulateModelToolCalls` 进行结构化模拟测试。

---

## 一、模块结构

| 文件 | 全局对象 / 导出 | 职责 |
|---|---|---|
| `shared/ai-tool-registry.js` | `SCAIToolRegistry` | 白名单工具注册中心、JSON Schema 参数校验器及多供应商工具定义导出（`standard` / `openai` / `gemini` / `anthropic`） |
| `shared/ai-tool-handlers.js` | `SCAIToolHandlers` | 6 个核心只读工具实现，复用 `SCAIQuery` / `SCDataStore` / `SC.SimEngine` / `SC.TimeSeries` 并接入 `SCAIPrivacy` |
| `shared/ai-tools.js` | `SCAITools` | 统一工具执行入口（`executeTool`）、版本感知模拟缓存、元数据审计日志及本地模拟模型调用入口（`simulateModelToolCalls`） |
| `tests/ai-tools-check.js` | 自动化测试 | 覆盖 10 项核心验收场景及载荷体积/Token 估算统计 |

---

## 二、核心只读工具目录（共 6 个）

| 工具名称 | 分类 | 默认隐私范围 | 核心职责与适用场景 | 复用的已有接口 |
|---|---|---|---|---|
| `query_bom` | `bom` | `compliance_overview` | 按类型（公司/工厂/物料/产品图）和合规状态分页查询 BOM 主体，并附带分页前全局统计 | `SCAIQuery.queryBomEntities`、`SCDataStore.readPartition`、`SCAIPrivacy` |
| `get_bom_detail` | `bom` | `compliance_overview` | 按稳定 ID 或匿名代号钻取公司、工厂或产品 BOM 详情、工厂路径与准入摘要（支持 `maxNodes` 限流） | `SCAIQuery.getBomDetail`、`SCAIPrivacy.getBomDetail` |
| `trace_supply_chain` | `bom` | `compliance_overview` | 严格基于显式供货关系与 `bomFactoryId` 链接执行 `upstream` / `downstream` / `shared_upstream` / `cross_module` 追溯 | `SCDataStore.readPartition("bom/entities")`、`SCAIQuery.getCrossModuleFactoryView`、`SCAIPrivacy` |
| `query_sales` | `sales` | `inventory_risk` | 按月/时间窗/工厂/市场/批次查询发运、批次、事实、节点、物流方案及曲线积分摘要；通过索引跳过无关月份并支持分页前全局聚合 | `SCAIQuery.querySales`、`SC.TimeSeries.integrateCurveByDates` / `computeDailySeriesRange` |
| `query_world_state` | `simulation` | `inventory_risk` | 按指定 `asOfDate` 与 `horizonDays` 调用官方模拟引擎计算库存、需求缺口、断货日期、发运实时进度与异常预警 | `SC.WorldModel.validateWorkspace`、`SC.SimEngine.simulateWorkspace`、`SC.SimEngine.queryShipments` |
| `calculate` | `calculation` | `relationship_only` | 白名单声明式数值统计、分组聚合、比率/差值、库存覆盖天数与 ISO 日期计算（严禁 `eval` 或任意代码） | `SC.TimeSeries.diffIsoDays`、`SC.TimeSeries.addDaysToIso` |

---

## 三、参数示例

### 1. `query_bom`（查询严重合规供应商 + 分页前全局统计）
```json
{
  "name": "query_bom",
  "arguments": {
    "kind": "company",
    "complianceStatus": "severe",
    "includeSummary": true,
    "limit": 10,
    "offset": 0
  }
}
```

### 2. `get_bom_detail`（使用匿名代号钻取详情）
```json
{
  "name": "get_bom_detail",
  "arguments": {
    "companyId": "COMP_002",
    "includeAssessments": true,
    "includeFactoryPaths": true
  }
}
```

### 3. `trace_supply_chain`（识别两家主板供应商共享同一个上游芯片供应商 / 跨模块追溯）
```json
{
  "name": "trace_supply_chain",
  "arguments": {
    "mode": "shared_upstream",
    "companyIds": ["COMP_002", "COMP_003"],
    "maxDepth": 6
  }
}
```
```json
{
  "name": "trace_supply_chain",
  "arguments": {
    "mode": "cross_module",
    "bomFactoryId": "FAC_001",
    "monthFrom": "2026-10",
    "monthTo": "2026-11",
    "limit": 20
  }
}
```

### 4. `query_sales`（跨月筛选 + 分页前全局聚合，或仅取聚合统计）
```json
{
  "name": "query_sales",
  "arguments": {
    "entity": "shipments",
    "fromDate": "2026-11-01",
    "toDate": "2026-11-30",
    "aggregate": true,
    "includeItems": false
  }
}
```

### 5. `query_world_state`（按指定业务日期重算运输状态与缺口风险）
```json
{
  "name": "query_world_state",
  "arguments": {
    "asOfDate": "2026-11-25",
    "horizonDays": 30,
    "sections": ["kpis", "markets", "shipments", "exceptions"],
    "overdueOnly": false,
    "limit": 20
  }
}
```

### 6. `calculate`（声明式聚合与日期计算）
```json
{
  "name": "calculate",
  "arguments": {
    "operation": "group_aggregate",
    "rows": [
      { "group": "MKT_001", "value": 900 },
      { "group": "MKT_001", "value": 1100 },
      { "group": "MKT_002", "value": 1000 }
    ]
  }
}
```
支持的操作白名单：`sum`、`avg`、`min_max`、`median_percentile`、`ratio`、`delta`、`weighted_avg`、`group_aggregate`、`date_diff`、`date_add`、`days_of_cover`。

---

## 四、统一返回格式与多供应商适配

每次调用 `runtime.executeTool(call)` 均返回统一结构：

```json
{
  "ok": true,
  "callId": "call_1",
  "tool": "query_world_state",
  "data": { "...": "脱敏后的结构化业务结果" },
  "meta": {
    "toolVersion": "1.0",
    "channel": "model_context",
    "scope": "inventory_risk",
    "asOfDate": "2026-11-25",
    "dataVersion": {
      "manifestVersion": 2,
      "bomVersion": 7,
      "bomCounter": 89,
      "salesVersion": 2,
      "salesRevision": 1
    },
    "partitionsRead": ["sales/workspace_simulation"],
    "pagination": { "total": 4, "returned": 4, "limit": 20, "offset": 0, "hasMore": false, "truncated": false },
    "cacheHit": false,
    "durationMs": 3,
    "payloadBytes": 2525,
    "estimatedTokens": 722,
    "historicalReplayCaveat": null
  },
  "error": null
}
```

- 失败时 `ok: false`、`data: null`，`error` 为 `{ code, message }`（错误代码包含 `INVALID_CALL` / `UNKNOWN_TOOL` / `UNAUTHORIZED` / `INVALID_ARGS` / `PRIVACY_BLOCKED` / `EXECUTION_ERROR`，且错误消息经 `SCAIPrivacy.sanitizeError` 脱敏）。
- `runtime.exportToolDefinitions(format)` 支持导出 `"standard"`、`"openai"`、`"gemini"`、`"anthropic"` 四种工具声明结构。
- `runtime.normalizeToolCall` / `runtime.simulateModelToolCalls` 直接兼容上述四种工具调用请求 JSON 形态。

---

## 五、数据权限、复杂度控制与缓存规则

1. **全链路隐私保护**：
   - 匿名代号（`COMP_001`、`FAC_001`、`BAT_001`、`MKT_001` 等）在本地自动解析为原始 ID 参与计算，返回结果全部经第一阶段正向白名单与匿名化器脱敏，并执行 `detectVaultLeak` 兜底检查。
   - 外部模型调用不允许自行附加 `grants` 或越权申请未授权范围（如默认不开放 `cost_analysis`）；执行审计日志（`getExecutionLogs()`）仅记录工具名、耗时、字节数、分页与参数键名，不记录原始参数值与业务正文。
2. **返回体积控制**：
   - 列表查询强制上限 `limit <= 50`（默认 `20`），`query_world_state` 默认仅返回 `["kpis", "markets", "exceptions"]`，不默认输出全量日度序列或全部发运明细；`includeDailySeries` 必须限定单节点且上限 31 天。
   - 所有汇总指标明确标注 `scopeNote: "global_filtered_before_pagination"` / `"global_matched_before_pagination"`，避免将分页切片误认为全局统计。
3. **版本感知模拟缓存**：
   - `query_world_state` 的本地缓存键同时包含 `workspaceId`、`revision`、核心工作区结构校验摘要（FNV-1a）、`asOfDate` 与 `horizonDays`，任何底层数据、基准日期或视窗变化均自动失效缓存。

---

## 六、已知限制

1. **历史回放无快照限制**：销售工作区只维护单一正式计划与最新已确认事实，不保留历史某天当时的计划快照；当 `asOfDate < inventoryAnchorDate` 或存在晚于 `asOfDate` 的事实记录时，`meta.historicalReplayCaveat` 会明确提示结果属于“按当前数据在目标日期重新推演”，不宣称精确还原历史快照。
2. **物流实绩与推演进度**：`operationalStatus`、`operationalOverdue` 以及 `overdueOnly`、`in_transit`、`customs` 筛选使用基准日已知的实际里程碑。超出下一项待确认里程碑的预计日期产生实际逾期预警。通过库存校验但缺实发事实的计划列为 `dispatch_unconfirmed`，阻断的计划列为 `blocked`。`progressStatus` 和 `isOverdueUnconfirmed` 保留旧版模拟进度口径。
3. **时间及范围**：`query_sales` 的日期筛选按自然日双端包含。曲线同日查询积分一天，显式范围最多 180 天。批次按生产区间与查询窗相交选取，聚合量为完整批次数量。详见 [Sales 模拟口径](SALES_SIMULATION_STAGE3.md)。
3. **阶段边界**：Token 预算控制、多轮调用循环治理与真实大模型 API 适配留待第三阶段；修改类工具与人工确认写回留待第五阶段。
