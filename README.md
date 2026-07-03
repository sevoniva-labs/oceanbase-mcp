# OceanBase MCP

[中文文档](docs/zh-CN/README.md) | [English Docs](docs/en/README.md)

OceanBase MCP is a strictly read-only MCP server for OceanBase. It lets OpenCode and other MCP clients inspect schemas, metadata, query plans, ER relationships, and limited sample data without exposing write capability.

OceanBase MCP 是面向 OceanBase 的严格只读 MCP server。OpenCode 和其他 MCP 客户端可以通过它查看 schema、元数据、执行计划、ER 关系和受限样例数据，同时不暴露写入能力。

## What It Provides / 能力概览

| Area | 中文 | English |
| --- | --- | --- |
| Database modes | 支持 OceanBase MySQL 模式和 Oracle 模式。 | Supports OceanBase MySQL and Oracle compatibility modes. |
| Query workflow | 元数据优先、查询预览、分页查询、结果摘要和错误提示。 | Metadata-first query workflow with preview, paging, summaries, and error hints. |
| Metadata | 表结构、DDL、索引、约束、分区、统计信息和 Oracle 对象元数据。 | Table structure, DDL, indexes, constraints, partitions, statistics, and Oracle object metadata. |
| ER diagrams | Mermaid、JSON、自包含 HTML 和本地分片导出。 | Mermaid, JSON, self-contained HTML, and local chunked exports. |
| SQL assistance | 只读 SQL 生成、改写、lint、执行计划分析和性能建议。 | Read-only SQL generation, rewrite, lint, plan analysis, and performance advice. |
| Change review | 元数据快照、差异对比、项目 SQL 使用索引和影响报告。 | Metadata snapshots, diffs, project SQL usage index, and impact reports. |
| Deployment | stdio、本地 OpenCode、HTTP、Docker、Kubernetes、systemd 和 Nginx 示例。 | stdio, local OpenCode, HTTP, Docker, Kubernetes, systemd, and Nginx examples. |

Complete tool list / 完整工具列表按首次引入版本排序：

- [中文工具列表](docs/zh-CN/tools.md)
- [English tool list](docs/en/tools.md)

## Read-Only Contract / 只读边界

The server is read-only by design:

- No MCP tool can write data or change database objects.
- `OB_MCP_READ_ONLY=true` is the default and cannot be disabled.
- `OB_MCP_READ_ONLY=false` makes the server refuse to start.
- User SQL is limited to `SELECT`, `WITH`, and read-only `EXPLAIN`.
- `SELECT *`, multi-statement SQL, write/control keywords, executable comments, filesystem functions, sleeps, locks, and sequence `NEXTVAL` are blocked.
- User SQL runs in a database read-only transaction by default.

服务从设计上只读：

- 没有任何 MCP 工具可以写入数据或修改数据库对象。
- `OB_MCP_READ_ONLY=true` 是默认值，且不能关闭。
- 设置 `OB_MCP_READ_ONLY=false` 会导致服务拒绝启动。
- 用户 SQL 只允许 `SELECT`、`WITH` 和只读 `EXPLAIN`。
- 默认拦截 `SELECT *`、多语句、写入/控制关键字、可执行注释、文件函数、sleep、lock 和序列 `NEXTVAL`。
- 用户 SQL 默认在数据库只读事务中执行。

Even if the configured database account has write grants, the MCP surface remains read-only. A SELECT-only database account is still recommended as defense in depth.

即使配置的数据库账号具备写权限，MCP 对外仍然只能读。仍建议使用只有 SELECT 和元数据查看权限的数据库账号作为纵深防御。

## Quick Start / 快速开始

Node.js 20 or newer is required.

需要 Node.js 20 或更高版本。

```bash
npm install -g @sevoniva/oceanbase-mcp@1.5.0
ob-mcp init --mode mysql --schema app_schema
ob-mcp doctor
```

Use `npx` when you do not want a global install:

不想全局安装时，可以直接用 `npx`：

```bash
npx --registry=https://registry.npmjs.org/ --yes --package=@sevoniva/oceanbase-mcp@1.5.0 ob-mcp --help
```

Build from source:

从源码构建：

```bash
git clone https://github.com/sevoniva/oceanbase-mcp.git
cd oceanbase-mcp
npm ci
npm run build
cp .env.example .env
npm run config:doctor
npm run start
```

## OpenCode / 接入 OpenCode

For local OpenCode use, generate a project config and then verify the MCP connection:

本地使用 OpenCode 时，先生成项目配置，再检查 MCP 连接：

```bash
ob-mcp init --mode mysql --schema app_schema
opencode mcp list
```

An `npx`-based OpenCode entry looks like this:

基于 `npx` 的 OpenCode 配置示例：

```jsonc
{
  "mcp": {
    "oceanbase": {
      "type": "local",
      "command": "npx",
      "args": [
        "--yes",
        "--package=@sevoniva/oceanbase-mcp@1.5.0",
        "ob-mcp"
      ],
      "enabled": true,
      "environment": {
        "OB_CONFIG_PATH": ".env"
      }
    }
  }
}
```

For the recommended OpenCode query workflow, see:

推荐的 OpenCode 查询流程见：

- [OpenCode setup](docs/en/opencode.md)
- [接入 OpenCode](docs/zh-CN/opencode.md)

## Common Workflows / 常用流程

| Workflow | 中文 | English |
| --- | --- | --- |
| Query data safely | 先搜索表和字段，再预览 SQL，最后分页查询。 | Search tables and columns, preview SQL, then run a paged query. |
| Understand a table | 获取表上下文、字段画像、索引、约束、统计信息和相关表。 | Get table context, column profiles, indexes, constraints, statistics, and related tables. |
| Draw ER diagrams | 小范围用 MCP 返回 Mermaid/HTML，大 schema 用 CLI 分片导出。 | Use MCP Mermaid/HTML for small scopes and CLI chunked export for large schemas. |
| Review schema changes | 迭代前后采集元数据快照，生成 diff 和影响报告。 | Capture metadata snapshots before and after an iteration, then generate diff and impact reports. |
| Review project SQL | 扫描本地 SQL 片段，结合元数据校验表字段和影响面。 | Scan local SQL snippets and validate tables, columns, and impact with metadata. |

## Documentation / 文档

| Topic | 中文 | English |
| --- | --- | --- |
| Start here | [快速开始](docs/zh-CN/README.md) | [Quick start](docs/en/README.md) |
| Tools | [工具列表](docs/zh-CN/tools.md) | [Tool list](docs/en/tools.md) |
| OpenCode | [接入 OpenCode](docs/zh-CN/opencode.md) | [OpenCode setup](docs/en/opencode.md) |
| CLI | [CLI](docs/zh-CN/cli.md) | [CLI](docs/en/cli.md) |
| Configuration | [配置说明](docs/zh-CN/configuration.md) | [Configuration](docs/en/configuration.md) |
| SQL assistance | [SQL 辅助](docs/zh-CN/sql-assistant.md) | [SQL assistance](docs/en/sql-assistant.md) |
| ER diagrams | [ER 图](docs/zh-CN/er.md) | [ER diagrams](docs/en/er.md) |
| Data dictionary | [数据字典与文档生成](docs/zh-CN/data-dictionary.md) | [Data dictionary and docs](docs/en/data-dictionary.md) |
| Metadata change | [元数据变更分析](docs/zh-CN/metadata-change.md) | [Metadata change analysis](docs/en/metadata-change.md) |
| Deployment | [部署指南](docs/zh-CN/deployment.md) | [Deployment](docs/en/deployment.md) |
| Architecture | [架构说明](docs/zh-CN/architecture.md) | [Architecture](docs/en/architecture.md) |
| Security | [安全基线](docs/zh-CN/security.md) | [Security baseline](docs/en/security.md) |
| Examples | [示例索引](examples/README.zh-CN.md) | [Examples](examples/README.en.md) |

## Release Timeline / 版本路线

| Version | 中文 | English |
| --- | --- | --- |
| v0.3.0 | 建立只读 MCP 网关、OceanBase MySQL/Oracle 连接、基础 SQL 策略、表元数据和脱敏样例数据。 | Read-only MCP gateway, OceanBase MySQL/Oracle connectivity, baseline SQL policy, table metadata, and masked sample rows. |
| v0.4.0 | 增加 HTTP 部署、安全加固、Host/IP allowlist、限流、健康检查、指标、审计日志和数据库权限核验。 | HTTP deployment, security hardening, Host/IP allowlists, rate limits, health checks, metrics, audit logs, and database permission checks. |
| v0.5.0 | 补齐开发元数据：表 DDL、统计信息、Oracle 对象、关系发现、ER 图、执行计划分析和性能建议。 | Developer metadata: table DDL, statistics, Oracle objects, relationship discovery, ER diagrams, plan analysis, and performance advice. |
| v0.5.1 | 改善 OpenCode 查询流程：表上下文、查询预览、分页查询、结果结构、错误提示、字段画像和业务字典。 | OpenCode query workflow: table context, query preview, paged queries, result structure, error hints, column profiling, and business glossary. |
| v1.0.0 | 完成本地开发助手能力：初始化/诊断、统一搜索、SQL 辅助、查询会话、数据理解、ER HTML、文档生成、项目 SQL 扫描和离线交付。 | Local developer assistant scope: init/doctor, unified search, SQL assistance, query sessions, data understanding, ER HTML, documentation, project SQL scanning, and offline delivery. |
| v1.1.0 | 增加元数据快照、快照对比、SQL 使用索引、影响分析、变更报告和关系路径解释，用于迭代前后评审。 | Metadata snapshots, snapshot diff, SQL usage index, impact analysis, change reports, and relationship paths for iteration review. |
| v1.1.1 | 修复大 schema ER 生成稳定性，增加批量元数据加载、ER HTML 浏览器优化和本地分片导出规划。 | Large-schema ER stability, batched metadata loading, improved ER HTML browser, and chunked local export planning. |
| v1.1.2 | 修复本地 OpenCode 连续查询稳定性，放宽本地 HTTP 默认限流，增加故障日志，并兼容 Oracle 常见命名占位符。 | Local OpenCode query stability, higher local HTTP rate-limit default, crash/slow-call logging, and Oracle named bind compatibility. |
| v1.1.3 | 优化大 schema ER 规划为轻量估算，增加分片策略参数，并完成 200+ 表本地验证。 | Lightweight large-schema ER planning, chunk strategy options, and 200+ table local validation. |
| v1.1.4 | 减少 ER 默认关系发现的重复元数据读取，并对大范围 inline ER HTML 提前降级。 | Reduced duplicate ER metadata reads and early fallback for large inline ER HTML. |
| v1.1.5 | 增加 npmjs 分发，包名为 `@sevoniva/oceanbase-mcp`，CLI 命令继续保持 `ob-mcp`。 | npmjs distribution under `@sevoniva/oceanbase-mcp`, while CLI commands remain `ob-mcp`. |
| v1.1.6 | 修正 npmjs 启动示例，补充 Apache-2.0 包许可元数据和 Trusted Publishing 发布流程，并验证公开 npm 安装。 | Correct npmjs startup examples, add Apache-2.0 package license metadata, document Trusted Publishing, and verify public npm installation. |
| v1.2.0 | 重构 ER 元数据地图：稳定图 ID、交互式 graph 画布、cluster 目录导出、跨 cluster 关系索引、诊断元数据和响应大小日志。 | Rebuilt ER metadata maps with stable graph IDs, interactive graph canvas, cluster directory export, cross-cluster relationship index, diagnostic metadata, and response-size logging. |
| v1.3.0 | 强化稳定性和可维护性：DB 调用预算、工具截止时间、结构化日志、崩溃回归测试、DB 运行时模块拆分和大库验证记录。 | Stability and maintainability: DB call budgets, tool deadlines, structured logs, crash regression coverage, DB runtime module split, and large-schema validation records. |
| v1.4.0 | 精简 npm 包内容，移除运行时不需要的历史 release 文档和 smoke 脚本，保留源码归档用于完整构建。 | Trimmed npm package contents by excluding release-note history and smoke scripts that are not needed at runtime; source archives remain complete for source builds. |
| v1.5.0 | 重整公开文档入口、拆分工具清单、清理发布文案，并增加公开文档措辞检查。 | Public documentation refresh, separate tool list, cleaner release wording, and public documentation wording checks. |

## Distribution / 分发

The public npm package is `@sevoniva/oceanbase-mcp`, and the CLI commands are `ob-mcp`, `ob-mcp-http`, and `ob-mcp-doctor`. Release assets also include a source archive, CycloneDX SBOM, and amd64/arm64 offline image archives.

公开 npm 包名为 `@sevoniva/oceanbase-mcp`，CLI 命令为 `ob-mcp`、`ob-mcp-http` 和 `ob-mcp-doctor`。Release 附件同时提供源码归档、CycloneDX SBOM，以及 amd64/arm64 离线镜像归档。

```bash
npm install -g @sevoniva/oceanbase-mcp@1.5.0
ob-mcp --help
```

Source archive build:

源码归档构建：

```bash
tar -xzf oceanbase-mcp-1.5.0-source.tar.gz
cd oceanbase-mcp-1.5.0
npm ci
npm run build
npm run start
```

The source archive excludes `node_modules` and `dist`. Your npm registry mirror must provide the dependencies locked by `package-lock.json`.

源码归档不包含 `node_modules` 和 `dist`。npm registry 镜像需要能提供 `package-lock.json` 中锁定的依赖。

## Validation / 验证

```bash
npm test
npm run docs:check
npm audit --omit=dev --audit-level=moderate
npm pack --dry-run
docker build -t oceanbase-mcp:local .
```

Smoke tests are documented in [Deployment](docs/en/deployment.md) and [部署指南](docs/zh-CN/deployment.md).
