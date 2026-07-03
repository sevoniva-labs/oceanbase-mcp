# OceanBase MCP

[English](../en/README.md) | [返回根目录](../../README.md)

OceanBase MCP 是面向 OceanBase 的严格只读 MCP server。它用于 OpenCode 和其他 MCP 客户端，提供数据库上下文、元数据、SQL 辅助和变更评审能力，同时不暴露写入能力。

## 核心能力

- 通过 OBProxy 或 MySQL 协议端点连接 OceanBase。
- 支持 OceanBase MySQL 模式和 Oracle 模式。
- 提供元数据、SQL 辅助、ER 图、结果查看和 schema 变更评审相关的只读 MCP 工具。
- 提供 OpenCode agent 和 skill，引导模型按元数据优先的流程查询。
- 所有数据访问都受 profile 权限、schema/table/column 策略、SQL 策略、行数限制、输出大小限制、超时、并发限制、审计日志和错误脱敏约束。
- 提供 stdio、HTTP、Docker、Kubernetes、Nginx、systemd 和 OpenCode 示例。

完整 MCP 工具和首次引入版本见 [工具列表](tools.md)。

## 只读边界

- 没有任何写入 MCP 工具。
- `OB_MCP_READ_ONLY=true` 是默认值，且不能关闭。
- 设置 `OB_MCP_READ_ONLY=false` 会导致服务拒绝启动。
- 用户 SQL 只允许 `SELECT`、`WITH` 和只读 `EXPLAIN`。
- 默认拦截 `SELECT *`、多语句、写入/控制关键字、可执行注释、文件函数、sleep、lock 和序列 `NEXTVAL`。
- 用户 SQL 默认在数据库只读事务中执行。

即使 `OB_USER` 是数据库读写账号，MCP 对外仍然只能读。仍建议使用只有 SELECT 和元数据查看权限的数据库账号作为纵深防御。

## 安装

需要 Node.js 20 或更高版本。

```bash
npm install -g @sevoniva/oceanbase-mcp@1.4.0
ob-mcp init --mode mysql --schema app_schema
ob-mcp doctor
```

不想全局安装时，可以直接用 `npx`：

```bash
npx --registry=https://registry.npmjs.org/ --yes --package=@sevoniva/oceanbase-mcp@1.4.0 ob-mcp --help
```

从源码构建：

```bash
git clone https://github.com/sevoniva/oceanbase-mcp.git
cd oceanbase-mcp
npm ci
npm run build
cp .env.example .env
npm run config:doctor
```

## 接入 OpenCode

生成项目配置：

```bash
ob-mcp init --mode mysql --schema app_schema
```

检查 MCP 连接：

```bash
opencode mcp list
```

预期结果：

```text
oceanbase connected
```

运行一个只读查询：

```bash
opencode run "Use the oceanbase MCP server to run SELECT 1 AS ok and return only the result."
```

本地、`npx` 和 HTTP 配置示例见 [接入 OpenCode](opencode.md)。

## 推荐查询流程

1. 先搜索可见 schema、表、字段、注释和业务词。
2. 写 SQL 前读取表上下文。
3. 使用显式字段生成或编写只读 SQL。
4. 执行前预览策略、敏感字段和 `EXPLAIN` 风险。
5. 尽量使用稳定排序字段做分页查询。
6. 只汇总已返回的数据，不额外读取数据库。

## 大 Schema 建议

- 大 schema 生成 ER 图前，先使用 `ob_plan_er_export` 规划范围。
- 大型 ER HTML 使用 CLI cluster 导出。
- MCP inline ER 适合小范围表关系查看。
- 优先使用外键关系；推断关系必须查看 confidence 和 evidence。

## 文档

| 主题 | 文档 |
| --- | --- |
| 工具 | [工具列表](tools.md) |
| OpenCode | [接入 OpenCode](opencode.md) |
| CLI | [CLI](cli.md) |
| 配置 | [配置说明](configuration.md) |
| SQL 辅助 | [SQL 辅助](sql-assistant.md) |
| ER 图 | [ER 图](er.md) |
| 数据字典 | [数据字典与文档生成](data-dictionary.md) |
| 元数据变更 | [元数据变更分析](metadata-change.md) |
| 部署 | [部署指南](deployment.md) |
| 架构 | [架构说明](architecture.md) |
| 安全 | [安全基线](security.md) |
| 示例 | [示例文件](../../examples/README.zh-CN.md) |

## 版本路线

| 版本 | 主题 |
| --- | --- |
| v0.3.0 | 建立只读 MCP 网关、OceanBase MySQL/Oracle 连接、基础 SQL 策略、表元数据和脱敏样例数据。 |
| v0.4.0 | 增加 HTTP 部署、安全加固、Host/IP allowlist、限流、健康检查、指标、审计日志和数据库权限核验。 |
| v0.5.0 | 补齐开发元数据：表 DDL、统计信息、Oracle 对象、关系发现、ER 图、执行计划分析和性能建议。 |
| v0.5.1 | 改善 OpenCode 查询流程：表上下文、查询预览、分页查询、结果结构、错误提示、字段画像和业务字典。 |
| v1.0.0 | 完成本地开发助手能力：初始化/诊断、统一搜索、SQL 辅助、查询会话、数据理解、ER HTML、文档生成、项目 SQL 扫描和离线交付。 |
| v1.1.0 | 增加元数据快照、快照对比、SQL 使用索引、影响分析、变更报告和关系路径解释，用于迭代前后评审。 |
| v1.1.1 | 修复大 schema ER 生成稳定性，增加批量元数据加载、ER HTML 浏览器优化和本地分片导出规划。 |
| v1.1.2 | 修复本地 OpenCode 连续查询稳定性，放宽本地 HTTP 默认限流，增加故障日志，并兼容 Oracle 常见命名占位符。 |
| v1.1.3 | 将大 schema ER 规划改为轻量估算，增加分片策略参数，并完成 200+ 表本地验证。 |
| v1.1.4 | 减少 ER 默认关系发现的重复元数据读取，并对大范围 inline ER HTML 提前降级。 |
| v1.1.5 | 增加 npmjs 分发，包名为 `@sevoniva/oceanbase-mcp`，CLI 命令继续保持 `ob-mcp`。 |
| v1.1.6 | 修正 npmjs 启动示例，补充 Apache-2.0 包许可元数据和 Trusted Publishing 发布流程，并验证公开 npm 安装。 |
| v1.2.0 | 重构 ER 元数据地图：稳定图 ID、交互式 graph 画布、cluster 目录导出、跨 cluster 关系索引、诊断元数据和响应大小日志。 |
| v1.3.0 | 强化稳定性和可维护性：DB 调用预算、工具截止时间、结构化日志、崩溃回归测试、DB 运行时模块拆分和大库验证记录。 |
| v1.4.0 | 精简 npm 包内容，移除运行时不需要的历史 release 文档和 smoke 脚本，保留源码归档用于完整构建。 |

## 分发

公开 npm 包名为 `@sevoniva/oceanbase-mcp`，CLI 命令为 `ob-mcp`、`ob-mcp-http` 和 `ob-mcp-doctor`。

```bash
npm install -g @sevoniva/oceanbase-mcp@1.4.0
ob-mcp --help
```

Release 附件包括：

| 资产 | 用途 |
| --- | --- |
| `sevoniva-oceanbase-mcp-1.4.0.tgz` | npm 包。 |
| `oceanbase-mcp-1.4.0-source.tar.gz` | 源码归档，用于源码构建。 |
| `sbom.cdx.json` | CycloneDX SBOM。 |
| `oceanbase-mcp-1.4.0-amd64.tar.gz` | amd64 离线镜像。 |
| `oceanbase-mcp-1.4.0-arm64.tar.gz` | arm64 离线镜像。 |
| `ghcr.io/sevoniva/oceanbase-mcp:v1.4.0` | GHCR 镜像 tag。 |

源码归档不包含 `node_modules` 和 `dist`。npm registry 镜像需要能提供 `package-lock.json` 中锁定的依赖。

## 验证

```bash
npm test
npm run docs:check
npm audit --omit=dev --audit-level=moderate
npm pack --dry-run
```

Docker、Kubernetes 和 smoke test 验证步骤见 [部署指南](deployment.md)。
