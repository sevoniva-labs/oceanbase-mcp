# OceanBase MCP v1.3.0

v1.3.0 focuses on stability, performance protection, maintainability, and release readiness. It keeps the MCP surface strictly read-only and does not add write, DDL, DCL, procedure execution, or sequence `NEXTVAL` capability.

## Changes

- Added DB call budgets for tools that can read metadata or query data.
- Added tool execution deadlines so late DB calls are rejected after the configured timeout budget is exhausted.
- Kept large-schema and large-table paths bounded by rows, bytes, tables, columns, relationships, DB calls, and timeout limits.
- Continued ER large-schema handling through export planning, clustered artifacts, and bounded inline responses.
- Split DB runtime code into smaller modules for pool setup, query execution, metadata value helpers, and schema context helpers.
- Added regression tests for DB runtime query handling, metadata value helpers, and schema context helpers.
- Kept audit logs, structured error output, and sensitive value redaction in the tool runtime.
- Updated current package, server, Docker Compose, Kubernetes, README, and deployment examples to v1.3.0.

## Validation

- `npm test`: passed, 268 tests.
- `npm run docs:check`: passed, 38 Markdown files checked.
- `npm audit --omit=dev --audit-level=moderate --registry=https://registry.npmjs.org/`: passed, 0 vulnerabilities.
- `npm pack --dry-run`: passed for `sevoniva-oceanbase-mcp-1.3.0.tgz`.
- Docker build: passed for `oceanbase-mcp:1.3.0`.
- Local npm package install: passed; installed the generated tgz and verified `ob-mcp --help`.
- Local OpenCode MCP startup: passed; `opencode mcp list` reported `oceanbase connected`.
- Local OceanBase MySQL smoke test: passed on `5.7.25-OceanBase-v4.2.5.7`.
- Local OceanBase MySQL MCP smoke test: passed with server version `1.3.0`.
- Local OceanBase Oracle MCP smoke test: passed with object metadata, partition metadata, ER, snapshot, diff, impact, and read-only enforcement checks.
- Large-schema verification: passed with 220 tables, 1,980 columns, 219 estimated relationships, and 4 DB calls.
- Large-table verification: passed against `biz_test.ob_mcp_million_describe` with 1,048,576 rows; `describeTable` returned 5 columns without process restart.
- ER HTML browser verification: passed for a 220-table export with 6 clusters and 220 table pages. The index and a cluster page opened in a real browser; the only observed console error was a missing favicon.

## Install

```bash
npm install -g @sevoniva/oceanbase-mcp@1.3.0
ob-mcp --help
npx --registry=https://registry.npmjs.org/ --yes --package=@sevoniva/oceanbase-mcp@1.3.0 ob-mcp --help
```

Registry mirrors can mirror npmjs and install the same pinned package version.

## Offline Source Build

```bash
tar -xzf oceanbase-mcp-1.3.0-source.tar.gz
cd oceanbase-mcp-1.3.0
npm ci
npm run build
npm run start
```

The source archive does not include `node_modules` or `dist`. The npm registry used for the build must provide the dependencies locked in `package-lock.json`.

## Assets

- `sevoniva-oceanbase-mcp-1.3.0.tgz`
- `oceanbase-mcp-1.3.0-source.tar.gz`
- `sbom.cdx.json`
- `oceanbase-mcp-1.3.0-amd64.tar.gz`
- `oceanbase-mcp-1.3.0-arm64.tar.gz`
- `ghcr.io/sevoniva/oceanbase-mcp:v1.3.0`
- `ghcr.io/sevoniva/oceanbase-mcp:1.3.0`

## Known Limits

- Large schemas should use `ob_plan_er_export` or `ob-mcp export-er --out-dir`; inline MCP responses remain intentionally bounded.
- Relationship planning is capped by configured limits. Increase limits only for a focused schema or table range.
- OceanBase row counts and optimizer statistics may be estimated or stale.
- Inferred relationships must be reviewed through confidence and evidence before being treated as design facts.

## Production Notes

- Database accounts should still use read-only privileges. MCP continues to block writes, DDL, DCL, procedure calls, sequence `NEXTVAL`, locks, and unsafe functions.
- Keep `OB_MAX_DB_CALLS`, `OB_METADATA_MAX_DB_CALLS`, `OB_ER_MAX_DB_CALLS`, `OB_MAX_RESULT_BYTES`, tool timeouts, and concurrency limits aligned with local machine resources.
- For large ER work, start with planning, then export clustered HTML to a directory.
- Review diagnostics before sharing an ER export, especially when tables, columns, relationships, or DB calls were truncated by configured limits.

## 中文说明

v1.3.0 聚焦稳定性、性能保护、可维护性和发布交付。本版本继续保持 MCP 只读边界，不增加写入、DDL、DCL、过程执行或序列 `NEXTVAL` 能力。

### 变更

- 增加工具级 DB 调用预算，覆盖可能读取元数据或查询数据的工具。
- 增加工具执行截止时间；超过配置超时预算后，后续 DB 调用会被拒绝。
- 大 schema 和大表路径继续受行数、字节数、表数、字段数、关系数、DB 调用次数和超时限制控制。
- 大库 ER 继续通过导出规划、cluster artifact 和受限 inline 响应处理。
- 拆分 DB runtime 代码，独立出连接池、查询执行、元数据取值 helper 和 schema 上下文 helper。
- 增加 DB runtime 查询、元数据取值 helper 和 schema 上下文 helper 的回归测试。
- 保持工具运行时审计日志、结构化错误输出和敏感信息脱敏。
- 当前 package、server、Docker Compose、Kubernetes、README 和部署示例更新到 v1.3.0。

### 验证结果

- `npm test`：通过，268 个测试。
- `npm run docs:check`：通过，检查 38 个 Markdown 文件。
- `npm audit --omit=dev --audit-level=moderate --registry=https://registry.npmjs.org/`：通过，0 个漏洞。
- `npm pack --dry-run`：通过，包名为 `sevoniva-oceanbase-mcp-1.3.0.tgz`。
- Docker build：通过，镜像为 `oceanbase-mcp:1.3.0`。
- 本地 npm 包安装：通过，安装生成的 tgz 后验证 `ob-mcp --help`。
- 本地 OpenCode MCP 启动：通过，`opencode mcp list` 显示 `oceanbase connected`。
- 本地 OceanBase MySQL smoke test：通过，版本为 `5.7.25-OceanBase-v4.2.5.7`。
- 本地 OceanBase MySQL MCP smoke test：通过，server version 为 `1.3.0`。
- 本地 OceanBase Oracle MCP smoke test：通过，覆盖对象元数据、分区元数据、ER、snapshot、diff、impact 和只读拦截。
- 大 schema 验证：通过，覆盖 220 张表、1,980 个字段、219 条估算关系，DB 调用 4 次。
- 百万行表验证：通过，`biz_test.ob_mcp_million_describe` 有 1,048,576 行；`describeTable` 返回 5 个字段，服务未重启。
- ER HTML 浏览器验证：通过，220 张表导出为 6 个 cluster 和 220 个表页面。index 和 cluster 页面均已在真实浏览器打开；唯一观察到的 console error 是缺失 favicon。

### 安装

```bash
npm install -g @sevoniva/oceanbase-mcp@1.3.0
ob-mcp --help
npx --registry=https://registry.npmjs.org/ --yes --package=@sevoniva/oceanbase-mcp@1.3.0 ob-mcp --help
```

私有 registry 可以同步 npmjs，并安装相同的固定版本。

### 离线源码构建

```bash
tar -xzf oceanbase-mcp-1.3.0-source.tar.gz
cd oceanbase-mcp-1.3.0
npm ci
npm run build
npm run start
```

源码归档不包含 `node_modules` 和 `dist`。构建使用的 npm registry 需要能提供 `package-lock.json` 中锁定的依赖。

### 交付资产

- `sevoniva-oceanbase-mcp-1.3.0.tgz`
- `oceanbase-mcp-1.3.0-source.tar.gz`
- `sbom.cdx.json`
- `oceanbase-mcp-1.3.0-amd64.tar.gz`
- `oceanbase-mcp-1.3.0-arm64.tar.gz`
- `ghcr.io/sevoniva/oceanbase-mcp:v1.3.0`
- `ghcr.io/sevoniva/oceanbase-mcp:1.3.0`

### 已知限制

- 大 schema 应使用 `ob_plan_er_export` 或 `ob-mcp export-er --out-dir`；MCP inline 响应会继续保持硬限制。
- 关系规划受配置上限控制。需要更多关系时，应先缩小 schema 或 table 范围，再调整上限。
- OceanBase 行数和优化器统计信息可能是估算值，也可能不是最新值。
- inferred 关系需要结合 confidence 和 evidence 审阅后再作为设计事实使用。

### 生产注意事项

- 数据库账号仍建议使用只读权限；MCP 会继续拦截写入、DDL、DCL、过程调用、序列 `NEXTVAL`、锁和危险函数。
- `OB_MAX_DB_CALLS`、`OB_METADATA_MAX_DB_CALLS`、`OB_ER_MAX_DB_CALLS`、`OB_MAX_RESULT_BYTES`、工具超时和并发限制应与本机资源匹配。
- 大库 ER 先做规划，再导出 cluster HTML 目录。
- 分享 ER 导出前先查看 diagnostics，确认是否有表、字段、关系或 DB 调用被配置上限截断。
