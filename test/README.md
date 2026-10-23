# 本地测试工具

## NORIN 公开状态与权限回归

```bash
npm run test:permissions
npm run build:frontend
npm run test:all
```

权限测试使用 Node.js 内置 SQLite（本地使用 Node 24），执行项目实际建表和查询 SQL；
测试数据库只在内存中，所有凭据均为测试值，外部版本请求被本地替身替代，不访问 Cloudflare。
它不替代 Miniflare/workerd 的完整运行时回归。

完整回归已在隔离 Docker `node:22.20.0-bookworm-slim`（Debian 12、glibc 2.36）验证。
宿主 Ubuntu 20.04 的 glibc 2.31 无法运行当前锁定的 workerd；无需升级宿主机。
`npm run test:all` 包含主测试、Agent 配置、历史查询和 `test:runtime`。
后者会构建前端、执行 **仅本地** Wrangler dry-run，并用 Miniflare 启动打包后的 Worker、
临时 D1、SQLite DO、Assets 和真实 WebSocket；不部署、不使用线上数据库或凭据。
运行时测试依赖 devDependencies 中 Wrangler 提供的 Miniflare。

前端 WebSocket 单元测试以 `https: false` 和 middleware 模式启动 Vite：测试目标是模拟连接的
生命周期，不需要 mkcert，也不会安装系统信任证书。真实连接由运行时回归另行覆盖。

- `/`：NORIN 公开状态页，每 60 秒读取 `/api/status`，仅返回未隐藏节点的 `name`、`region`、`online` 和汇总数量。
- `/admin#/admin`：原管理后台；登录后“监控详情”进入 `/#/dashboard`，保留原仪表盘及详情页。
- `/api/servers`、`/api/server`、`/api/history/all` 和浏览器 `/api/ws`：始终要求管理员 JWT/Cookie，不受旧 `is_public` 开关影响。
- 匿名 `/api/config` 仅返回启动/登录验证所需字段；公开状态页不请求私有配置，也不建立指标 WebSocket。
- Agent `/update` 的 Secret 校验、WSS 协议及数据库结构保持原样。

覆盖匿名/伪造/过期凭据、管理员 Bearer/Cookie/WS 查询 JWT、隐藏节点、管理员缓存后的公开投影、
真实指标及历史查询、后台登录与 Turnstile、Agent 独立鉴权和数据库错误响应。

本目录包含用于本地测试聚合功能的完整工具，可以无需部署到 Cloudflare 就验证效果。

## 快速开始

### 方式一：使用 Wrangler 本地模式（推荐）

这是最真实的测试方式，体验与生产环境完全一致。

1. **生成模拟数据 SQL**
   ```bash
   # 在项目根目录
   node test/generate-sql.js
   ```

2. **初始化数据库结构**
   （如果数据库是空的，先启动一次 dev 来自动创建表）
   ```bash
   # 在项目根目录
   npm run dev
   # 访问一次 http://localhost:8787 会自动初始化表结构
   # 然后按 Ctrl+C 停止
   ```

3. **导入模拟数据**
   ```bash
   # 执行 SQL 导入数据
   wrangler d1 execute server-monitor-db --file=test/mock-data.sql
   ```

4. **启动本地开发服务器**
   ```bash
   npm run dev
   ```

5. **访问界面**
   - 首页仪表盘: http://localhost:8787
   - 服务器详情页: http://localhost:8787/?id=s550e8400-e29b-41d4-a716-446655440001
   - 后台管理: http://localhost:8787/admin

## 模拟数据说明

### 服务器配置

- **US-East-Fast** (`s550e8400-e29b-41d4-a716-446655440001`)
  - 位置: 美国东部
  - 上报间隔: 60 秒
  - 配置: 4 核 / 32G RAM

- **JP-Tokyo-Stable** (`550e8400-e29b-41d4-a716-446655440002`)
  - 位置: 日本东京
  - 上报间隔: 120 秒
  - 配置: 2 核 / 16G RAM

### 数据特点

- 72 小时完整历史数据
- 指标带有真实波动（白天负载高、晚上负载低）
- 包含完整的 CPU、RAM、网络、Ping 等指标
- 聚合表保持空，方便测试聚合逻辑

## 文件说明

- `generate-sql.js` - 生成 SQL 格式模拟数据的脚本
- `mock-data.sql` - 生成后的 SQL 文件（运行脚本后产生）
- `README.md` - 本文档

## 测试流程建议

1. **测试仪表盘显示** - 访问 http://localhost:8787 查看是否正常显示两台服务器
2. **测试历史图表** - 点击服务器查看详情页，验证历史数据展示
