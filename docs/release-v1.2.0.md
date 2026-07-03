# OceanBase MCP v1.2.0

v1.2.0 rebuilds the ER diagram capability as a browsable OceanBase metadata map. The release keeps the read-only security boundary unchanged and focuses on large-schema stability, interactive ER navigation, diagnostics, and npmjs delivery.

## Changes

- Rebuilt ER metadata with stable internal graph IDs separated from display names, search names, and export names.
- Added an interactive graph canvas for ER HTML with search, filters, zoom, table details, relationship details, and evidence panels.
- Added clustered ER directory export for large schemas, including overview pages, cluster pages, table pages, graph metadata, relationship metadata, diagnostics, and export summary files.
- Preserved cross-cluster relationships through relationship indexes and table-neighborhood pages instead of dropping them from large exports.
- Classified relationships by source and confidence, with evidence for confirmed and inferred relationships.
- Replaced expanded warning blocks in large ER exports with a status card and collapsed diagnostics.
- Improved medium and large graph framing so generated pages open with readable table nodes and relationships.
- Added response-size audit metadata for ER generation and export flows.
- Hardened Oracle smoke validation for object metadata responses.
- Kept MCP inline ER bounded; large schemas should use `export-er --out-dir`.

## Validation

- `npm test`: passed, 221 tests.
- `npm run docs:check`: passed, 36 Markdown files checked.
- `npm audit --omit=dev --audit-level=moderate`: passed against the npmjs registry.
- `npm pack --dry-run`: passed.
- Docker build: passed for `oceanbase-mcp:1.2.0`.
- Local OceanBase MySQL stdio smoke test: passed.
- Local OceanBase MySQL HTTP smoke test: passed.
- Local OceanBase Oracle stdio smoke test: passed.
- Local OceanBase Oracle HTTP smoke test: passed.
- Local large-schema ER export, MySQL mode: 222 tables, 9 clusters, 222 table pages.
- Local large-schema ER export, Oracle mode: 340 tables, 15 clusters, 340 table pages.
- Browser QA: index page status and diagnostics rendered correctly; cluster pages opened without console errors; search, table click, and relationship evidence panels worked.
- Large-table metadata check: MySQL table statistics validated with a 1,048,576-row table without scanning business rows. Oracle metadata paths were validated locally and through regression tests.

## Install

```bash
npm install -g @sevoniva/oceanbase-mcp@1.2.0
ob-mcp --help
npx --registry=https://registry.npmjs.org/ --yes --package=@sevoniva/oceanbase-mcp@1.2.0 ob-mcp --help
```

Registry mirrors can mirror npmjs and install the same pinned package version.

## Offline Source Build

```bash
tar -xzf oceanbase-mcp-1.2.0-source.tar.gz
cd oceanbase-mcp-1.2.0
npm ci
npm run build
npm run start
```

The source archive does not include `node_modules` or `dist`. The npm registry mirror must provide the dependencies locked in `package-lock.json`.

## Assets

- `sevoniva-oceanbase-mcp-1.2.0.tgz`
- `oceanbase-mcp-1.2.0-source.tar.gz`
- `sbom.cdx.json`
- `oceanbase-mcp-1.2.0-amd64.tar.gz`
- `oceanbase-mcp-1.2.0-arm64.tar.gz`
- `ghcr.io/sevoniva/oceanbase-mcp:v1.2.0`
- `ghcr.io/sevoniva/oceanbase-mcp:1.2.0`

## Known Limits

- Large schemas should use `ob_plan_er_export` or `ob-mcp export-er --out-dir`; inline MCP responses remain intentionally bounded.
- Relationship planning is capped by configured limits. Increase the limit only for a focused schema or table range.
- OceanBase row counts and optimizer statistics may be estimated or stale.
- Inferred relationships must be reviewed through confidence and evidence before being treated as design facts.

## Production Notes

- Database accounts should still use read-only privileges. MCP continues to block writes, DDL, DCL, procedure calls, sequence `NEXTVAL`, locks, and unsafe functions.
- Keep `OB_ER_MAX_TABLES`, `OB_MAX_RESULT_BYTES`, tool timeouts, and concurrency limits aligned with local machine resources.
- For large ER work, start with planning, then export clustered HTML to a directory.
- Review diagnostics before sharing an ER export, especially when tables, columns, or relationships were truncated by configured limits.

## 中文说明

v1.2.0 将 ER 图能力重构为可浏览的 OceanBase 元数据地图。本版本保持只读安全边界不变，重点改善大库稳定性、交互式 ER 浏览、诊断信息和 npmjs 分发。

### 变更

- 重构 ER 元数据模型，稳定内部 graph ID 与展示名、搜索名、导出名分离。
- 新增交互式 ER HTML 画布，支持搜索、筛选、缩放、表详情、关系详情和证据面板。
- 新增大库 cluster 目录导出，包含总览页、cluster 页、表详情页、graph 元数据、关系元数据、诊断信息和导出摘要。
- 通过关系索引和表邻域页面保留跨 cluster 关系，避免大库导出丢关系。
- 按来源和置信度对关系分级，confirmed 和 inferred 关系都带 evidence。
- 大库 ER 导出不再展开大量 warning，改为顶部状态卡和折叠诊断面板。
- 优化中大型图初始视角，页面打开后表节点和关系更容易阅读。
- ER 生成和导出流程增加响应大小审计信息。
- 加强 Oracle smoke test 的对象元数据响应校验。
- MCP inline ER 保持有界；大 schema 应使用 `export-er --out-dir`。

### 验证结果

- `npm test`：通过，221 个测试。
- `npm run docs:check`：通过，检查 36 个 Markdown 文件。
- `npm audit --omit=dev --audit-level=moderate`：通过，使用 npmjs registry 验证。
- `npm pack --dry-run`：通过。
- Docker build：通过，镜像 tag 为 `oceanbase-mcp:1.2.0`。
- 本地 OceanBase MySQL stdio smoke test：通过。
- 本地 OceanBase MySQL HTTP smoke test：通过。
- 本地 OceanBase Oracle stdio smoke test：通过。
- 本地 OceanBase Oracle HTTP smoke test：通过。
- 本地 MySQL 大库 ER 导出：222 张表、9 个 cluster、222 个表详情页。
- 本地 Oracle 大库 ER 导出：340 张表、15 个 cluster、340 个表详情页。
- 浏览器验证：index 页状态和诊断正常；cluster 页无控制台错误；搜索、表点击、关系证据面板可用。
- 大表元数据验证：MySQL 1,048,576 行表统计验证通过，未扫描业务行；Oracle 元数据路径已通过本地验证和回归测试覆盖。

### 安装

```bash
npm install -g @sevoniva/oceanbase-mcp@1.2.0
ob-mcp --help
npx --registry=https://registry.npmjs.org/ --yes --package=@sevoniva/oceanbase-mcp@1.2.0 ob-mcp --help
```

私有 registry 可以同步 npmjs，并安装相同的固定版本。

### 离线源码构建

```bash
tar -xzf oceanbase-mcp-1.2.0-source.tar.gz
cd oceanbase-mcp-1.2.0
npm ci
npm run build
npm run start
```

源码归档不包含 `node_modules` 和 `dist`。私有 npm registry 需要能提供 `package-lock.json` 中锁定的依赖。

### 交付资产

- `sevoniva-oceanbase-mcp-1.2.0.tgz`
- `oceanbase-mcp-1.2.0-source.tar.gz`
- `sbom.cdx.json`
- `oceanbase-mcp-1.2.0-amd64.tar.gz`
- `oceanbase-mcp-1.2.0-arm64.tar.gz`
- `ghcr.io/sevoniva/oceanbase-mcp:v1.2.0`
- `ghcr.io/sevoniva/oceanbase-mcp:1.2.0`

### 已知限制

- 大 schema 应使用 `ob_plan_er_export` 或 `ob-mcp export-er --out-dir`；MCP inline 响应会继续保持硬限制。
- 关系规划受配置上限控制。需要更多关系时，应先缩小 schema 或 table 范围，再调整上限。
- OceanBase 行数和优化器统计信息可能是估算值，也可能不是最新值。
- inferred 关系需要结合 confidence 和 evidence 审阅后再作为设计事实使用。

### 生产注意事项

- 数据库账号仍建议使用只读权限；MCP 会继续拦截写入、DDL、DCL、过程调用、序列 `NEXTVAL`、锁和危险函数。
- `OB_ER_MAX_TABLES`、`OB_MAX_RESULT_BYTES`、工具超时和并发限制应与本机资源匹配。
- 大库 ER 先做规划，再导出 cluster HTML 目录。
- 分享 ER 导出前先查看 diagnostics，确认是否有表、字段或关系被配置上限截断。
