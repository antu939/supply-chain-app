# Bugfix 报告（2026-11-24）

## 已修复

1. **复制发运单跨月归档错误**：`shipment.duplicate` 原先继承源单的 `originMonth`，即使复制单发运日期属于新的月份，新单也会错误进入旧月份分区。现按照复制单的新发运日期重新设置 `originMonth`，原单保留其原始月份。
2. **发运单重复 ID 覆盖风险和非法复制数量**：`shipment.create` / `shipment.duplicate` 创建时检查 ID 是否已存在；复制时拒绝非数字与非正数数量，防止旧单被覆盖或 `NaN` 在 JSON 序列化后变成 `null`。
3. **事实记录查询忽略工厂 / 市场条件**：`SCAIQuery.querySales({entity:"facts",factoryId/...})` 原先没有筛选事实，可能返回其他工厂或市场的事实。索引现在能将跨月事实目标（批次 / 发运 / 工厂 / 市场）映射到正确主体，按条件精准查询，并跳过无关月份。
4. **通过 shipmentId 查询时月筛选被忽略**：修复查询分区选择时提前 `return` 的问题，`month`, `monthFrom`, `monthTo`, `fromDate`, `toDate` 仍然生效。
5. **AI 预演空数据抛异常**：`SCAIQuery.simulateSalesActions` 原先直接访问全局 `localStorage` 并尝试校验空值；现在支持显式传入 `storage`，对于没有数据/坏 JSON 返回清晰的 `{ok:false,error}`，不会误用全局存储。
6. **Stage 2 / 3 测试无法直接在 Node.js 运行**：移除机器专属路径，加入 Node.js 加载器兼容逻辑，直接执行 `node tests/stage2-check.js` 和 `node tests/stage3-check.js`。
7. **旧查询索引缓存兼容**：manifest schema version 升为 2，旧版本索引会从权威业务数据重新构建，不会沿用缺少新事实索引字段的缓存。原始业务数据键及结构不变。

## 运行检查

在项目根目录执行：

```sh
node tests/stage1-check.js
node tests/stage2-check.js
node tests/stage3-check.js
node modules/bom/tests/regression.js
node modules/sales/tests/engine.test.js
node tests/bugfix-regression.js
```

回归用例覆盖新发运单的分区位置、重复 ID / 非法数量防护、跨月事实及工厂市场条件查询、月份条件交叉过滤、旧 manifest 缓存重建和空数据 AI 预演。

## 测试范围与限制

项目静态 HTML 入口的浏览器脚本注入式启动、总览渲染、菜单操作及主导航经过无脚本错误烟雾测试；由于此调试环境禁止 Chromium 访问本地 HTTP 和 `file:` 地址，未能实际完成 iframe 模块的端到端操作。推荐在本地按 `docs/README.md` 的 HTTP 启动步骤复查完整 UI 和真实存储行为。
