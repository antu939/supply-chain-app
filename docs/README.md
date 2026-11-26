# 供应链管理软件

集成「BOM 与合规」及「销售与运营」两大业务模块的统一桌面/浏览器原生应用。

## 启动方式

在 `supply-chain-app` 目录下启动本地静态服务后，在浏览器打开入口页即可使用：

```bash
cd supply-chain-app
python3 -m http.server 8765
```

浏览器访问：

```text
http://127.0.0.1:8765/
```

> 说明：使用本地 HTTP 服务启动可保证所有模块在同一源下共享浏览器本地存储（`localStorage`），切换栏目、返回总览或刷新页面均不会丢失已保存的业务数据。

## 目录结构

```text
supply-chain-app/
├── index.html          # 唯一正式应用入口
├── app/                # 统一界面框架与首页总览
│   ├── app.js
│   └── app.css
├── modules/
│   ├── bom/            # BOM 结构、公司、工厂、供应关系与市场合规准入模块
│   └── sales/          # 生产批次、物流清关、库存与市场需求模拟模块
├── shared/             # 模块间通信协议（后续扩展共享实体层）
├── storage/            # 统一数据快照读取与存储键定义（后续扩展迁移与备份）
├── tests/              # 自动化检查脚本
└── docs/               # 使用与工程文档
```

## 主导航说明

- **总览**：首次使用展示空白初始化引导；录入真实业务数据后自动切换为简洁的业务总览、提醒、最近工作与模块入口。
- **BOM 与合规**：管理成品与组件 BOM 结构、公司与工厂主体库及目标市场准入评估。
- **销售与运营**：管理工厂排产曲线、生产批次、发运清关节点及目标市场需求与库存模拟。

## 运行自动化测试

安装 Node.js（无需 npm 依赖），在应用根目录依次执行：

```sh
node tests/stage1-check.js
node tests/stage2-check.js
node tests/stage3-check.js
node modules/bom/tests/regression.js
node modules/sales/tests/engine.test.js
node tests/bugfix-regression.js
node tests/consistency-regression.js
```

修复记录请参阅 [BUGFIX_REPORT.md](BUGFIX_REPORT.md)。
本轮一致性、安全性与交互稳定性修复见 [CONSISTENCY_FIX_REPORT.md](CONSISTENCY_FIX_REPORT.md)。
