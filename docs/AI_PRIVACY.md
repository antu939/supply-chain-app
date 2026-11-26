# AI 隐私保护与数据脱敏层说明（第一阶段）

本文档说明供应链管理软件在现有只读 AI 查询接口（`SCAIQuery`）与未来外部模型/搜索 API 之间建立的独立隐私保护层。

- **只读与按需生成**：原始业务存储（`bom-flow-sim-v5`、`sc-sales-world-v2`、`sc-data-manifest-v1`）保持不变，脱敏视图全部按需即时生成，不建立需要持续同步的第二套业务数据库。
- **不调用外部服务**：本阶段纯本地实现，不发起任何真实模型 API 或外部搜索请求。

---

## 一、模块结构

| 文件 | 全局对象 / 导出 | 职责 |
|---|---|---|
| `shared/ai-privacy-schema.js` | `SCAIPrivacySchema` | 四级数据敏感度分类、字段正向白名单、披露范围（Scope）及双出口策略上限 |
| `shared/ai-anonymizer.js` | `SCAIAnonymizer` | 本地稳定匿名映射 Vault、原始 ID 替换、跨模块工厂映射关联及本地名称恢复 |
| `shared/ai-privacy.js` | `SCAIPrivacy` | 脱敏查询封装、模型出口网关（`model_context`）、联网搜索出口网关（`web_search`）、自由文本/对话/错误/日志检测与阻断 |
| `tests/ai-privacy-check.js` | 自动化测试 | 使用虚构数据验证全部脱敏、关系追溯、双出口隔离、只读性与本地恢复规则 |

---

## 二、数据敏感等级与白名单机制

采用**默认拒绝（Deny-by-Default）+ 逐层正向白名单**机制：任何未在 `SCAIPrivacySchema.ENTITY_SCHEMAS` 中显式声明的顶层字段或嵌套字段（包括自定义字段 `extraFields`、临时注入的嵌套属性）均默认丢弃，并记录在 `audit.droppedFields` 中，绝不向外部出口发送。

| 敏感等级 | 细分类别 | 典型字段 | 默认策略（`relationship_only`） |
|---|---|---|---|
| **L1 结构与关系** (`L1_STRUCTURAL`) | `structural.topology`、`structural.compliance_status`、`structural.schedule`、`structural.bom_recipe` | 匿名化后的各类 ID、上下游/跨模块关联、合规/准入状态枚举、排程日期与里程碑、BOM 单件用量与单位、证据条数 | 允许（所有原始 ID 必须替换为匿名代号） |
| **L2 主体身份** (`L2_IDENTITY`) | `identity.entity_name`、`identity.market_name`、`identity.product_name`、`identity.product_code`、`identity.region`、`identity.city`、`identity.carrier`、`identity.location_port` | 公司名、工厂名、市场名、产品名、SKU/料号、地区、城市、承运商、口岸 | 默认隐藏；按任务范围或单主体 `authorizedRealNameIds` 按需披露 |
| **L3 商业敏感** (`L3_COMMERCIAL`) | `commercial.volume`、`commercial.inventory`、`commercial.demand`、`commercial.cost`、`commercial.internal_score` | 批次/发运数量、初始与预测库存、需求预测、制造/运输/清关/尾程/渠道成本、历史内部评分 | 默认隐藏；仅在对应分析范围按需披露 |
| **L4 高敏与自由文本** (`L4_SENSITIVE`) | `sensitive.contact`、`sensitive.address`、`sensitive.document_number`、`sensitive.free_text` | 联系人/电话/邮箱/操作人、详细街道地址、批次号/发运号/提单号/箱号/追踪号/航次、备注 `note`、合规原因 `reason`、评估证据文本、`extraFields` | 联系方式/地址/单据号在模型出口硬禁止；自由文本默认丢弃，显式开启后须经文本检测并人工确认 |

---

## 三、稳定匿名映射与本地恢复

1. **稳定不透明代号**：按实体类型生成顺序代号，例如 `COMP_001`（公司）、`FAC_001`（BOM 工厂）、`SFAC_001`（销售工厂节点）、`MKT_001`（市场）、`BOM_001`（BOM 图）、`BNODE_001`（BOM 节点）、`MAT_001`（物料）、`PROD_001`（产品）、`LANE_001`（物流方案）、`BAT_001`（批次）、`SHP_001`（发运单）、`EVT_001`（事实事件）。
2. **原始 ID 同样映射**：即使原始 ID 内嵌敏感业务信息（如 `comp_xinglan_hq`、`XL-X900-VIP`），对外也一律替换为不透明代号；同时支持以匿名代号作为后续只读查询的过滤参数。
3. **跨模块与跨月关系不断裂**：
   - 通过仅读取 `manifest.json` 完成全量实体类型与 `bomFactoryToSalesNode` 显式关联建表，既保证不同查询顺序下别名稳定一致，又保持 Stage 3 按需跳过无关月份分区的特性。
   - 仅在存在显式 `bomFactoryId` 时建立 `FAC_xxx <-> SFAC_xxx` 映射；未关联同名工厂继续严格隔离。
4. **仅存本地、严禁外泄**：
   - 映射表保存在闭包私有内存结构中，默认不写入 `localStorage`；仅在显式配置 `persistVault: true` 时写入独立本地键 `sc-ai-privacy-vault-v1`。
   - `vault.toJSON()` 返回阻断占位符；`detectVaultLeak()` 在模型出口、搜索出口与日志净化中拦截任何 Vault 实例或本地备份对象。
5. **本地恢复**：`ctx.rehydrateResponse(response, { mode })` 支持将 AI 返回的文本或结构化 JSON 中的匿名引用在本地还原为真实名称（`name` / `annotated` / `detailed_object`），不修改输入对象；对模型幻觉产生的未知代号（如 `COMP_999`）保持原样并记录在 `unresolvedRefs`。

---

## 四、按需数据披露与双出口权限边界

### 1. 模型上下文出口（`channel: "model_context"`）

内置最小必要披露预设（`SCAIPrivacySchema.DISCLOSURE_SCOPES`）：

- `relationship_only`（默认）：仅 L1 拓扑、状态与排程，不含实名、数量、成本和自由文本。
- `compliance_overview`：L1 + 粗粒度大区（`identity.region`），用于匿名合规与准入概览。
- `inventory_risk`：L1 + 大区 + 数量/库存/需求，**不含真实企业/工厂名与成本**。
- `logistics_tracking`：L1 + 大区/口岸/承运商 + 发运数量，**不含真实企业/工厂名、成本与提单/箱号/追踪号**。
- `cost_analysis`：L1 + 数量/库存/需求/成本，**仍保持企业与工厂匿名**，不含 L4 字段。
- `public_entity_lookup`：默认仍匿名，仅对用户显式授权的 `grants.authorizedRealNameIds`（可传原始 ID 或匿名代号）披露该指定主体的真实名称，同响应内其他主体继续保持匿名。

### 2. 外部联网搜索出口（`channel: "web_search"`）

`prepareSearchQuery` 使用完全独立的 `searchPolicy` / `searchGrants`，**绝不继承 `model_context` 的任何范围或实名授权**：

- **硬阻断（`decision: "block"`）**：
  - 未获 `searchGrants.authorizedRealNameIds` 授权的任何内部公司、工厂、产品名称或原始 ID；
  - 任何内部匿名代号（如 `COMP_001`、`SHP_001`）；
  - 任何商业价格/成本/产量/库存指标、联系方式、街道地址、单据编号、证件号、凭据密钥。
- **人工确认（`decision: "require_confirmation"`）**：
  - 搜索词包含未登记的企业/工厂名等无法确定归属的敏感线索时，要求人工确认后放行。
- **允许（`decision: "allow"`）**：
  - 纯通用行业/法规公开查询，或仅包含已显式授予搜索权限的指定主体实名 + 公开检索关键词且无任何内部指标泄露的查询。

---

## 五、核心接口速览

```js
const ctx = SCAIPrivacy.createContext({
  storage, // 或 partitionProvider
  modelPolicy: { scope: "relationship_only", grants: {} },
  searchPolicy: { enabled: true, authorizedRealNameIds: [] }
});

// 1. 只读脱敏业务查询（返回 { ok, allowed, decision, channel, scope, data, meta, audit }）
ctx.listPartitions({ domain: "all" });
ctx.queryBomEntities({ kind: "company", complianceStatus: "severe" });
ctx.getBomDetail({ companyId: "COMP_001" }, { scope: "compliance_overview" });
ctx.querySales({ entity: "shipments", month: "2026-11" }, { scope: "inventory_risk" });
ctx.getCrossModuleFactoryView({ bomFactoryId: "FAC_001" }, { scope: "relationship_only" });
ctx.simulateSalesActions(actions, { workspace, actionsEngine, worldModel, scope: "inventory_risk" });
ctx.sanitizeBusinessPayload("sales_shipment", rawShipment, { scope: "logistics_tracking" });

// 2. 模型上下文总出口 & 对话/文本/错误/日志净化
ctx.prepareModelContext({ userMessage, conversationHistory, dataViews, errors, logs }, options);
ctx.prepareConversationHistory(messages, options);
ctx.inspectText(text, options);
ctx.sanitizeText(text, options);
ctx.sanitizeError(err);
ctx.sanitizeLog(logEntry);

// 3. 独立的联网搜索出口策略校验
ctx.prepareSearchQuery({ query, searchGrants: { authorizedRealNameIds: ["COMP_002"] } }, options);

// 4. 本地恢复匿名引用
ctx.rehydrateResponse(aiResponse, { mode: "name" }); // "name" | "annotated" | "detailed_object"
ctx.resolveLocalAlias("COMP_001");
```

---

## 六、已知限制与非目标声明

1. **不宣称自由文本 100% 完全匿名**：自由文本（用户提问、多轮对话、业务备注 `note`、合规说明 `reason`、评估证据文本）可能包含简称、代称、错别字、未登记的个人姓名或隐含商业语义，词典与正则检测无法保证零漏报。系统对此采取默认丢弃 + `require_confirmation` 人工复核机制（或通过 `strictBlockUnreliable: true` 直接硬阻断），并在返回结果中附带明确风险提示。
2. **间接推断（准标识符）风险**：即使移除真实名称，极端独特的拓扑结构、特定日期组合或精确库存数字在结合外部背景知识时仍可能存在重识别风险；因此默认策略为 `relationship_only`，商业数值应按任务最小范围开启。
3. **本地映射表存储安全**：当前浏览器环境下可选持久化键 `sc-ai-privacy-vault-v1` 为明文 JSON（默认关闭持久化，仅内存会话有效）；未来桌面版接入时应将本地映射表交由操作系统安全存储或加密文件保存。
4. **阶段边界**：本阶段不包含模型 API 客户端、联网搜索执行器、聊天界面、权限配置界面、幕布或任何数据反向写回能力。
