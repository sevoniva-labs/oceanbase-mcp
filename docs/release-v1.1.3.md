# OceanBase MCP v1.1.3

v1.1.3 is a stability patch for large-schema ER planning and export. It reduces metadata load before export, adds explicit ER chunking options, and verifies the flow against local OceanBase schemas with more than 200 complex tables. The read-only boundary is unchanged.

## Changes

- `ob_plan_er_export` now uses lightweight table statistics and batched foreign-key metadata instead of loading full table details during planning.
- The ER export CLI supports `--strategy` and `--max-columns-per-table`.
- Connected-component and table-prefix export strategies now pack small isolated components into bounded chunks.
- MySQL table listing includes estimated row counts where available.
- ER planning output now reports estimated table count, estimated column count, estimated relationship count, large tables, risks, recommended next tools, and chunk commands.
- OpenCode and deployment documentation now point to the current large-schema ER workflow and v1.1.3 release assets.

## Validation

- `npm test`: 211 tests passed.
- `npm run docs:check`: passed.
- `npm audit --omit=dev --audit-level=moderate`: passed.
- `npm pack --dry-run`: passed.
- Docker build: passed.
- Local OceanBase MySQL stdio and HTTP smoke tests passed.
- Local OceanBase Oracle stdio and HTTP smoke tests passed.
- MySQL ER export: 222 tables, 5 chunks, 215 rendered relationships, 219 planned relationships.
- Oracle ER export: 352 tables, 8 chunks, 220 rendered relationships, 224 planned relationships.
- Oracle validation includes all 220 `OB_MCP_LG_*` complex test tables and covers a larger visible schema than the MySQL validation.
- Small-scope MySQL and Oracle ER HTML exports passed.
- MySQL and Oracle million-row `ob_describe_table` validations passed without scanning table data.
- Oracle `OB_MCP_MILLION_DESCRIBE` was verified with 1,048,576 rows after bounded batch data preparation.

## Offline Source Build

```bash
tar -xzf ob-mcp-1.1.3-source.tar.gz
cd ob-mcp-1.1.3
npm ci
npm run build
npm run start
```

The source archive does not include `node_modules` or `dist`. The npm registry mirror must provide the dependencies locked in `package-lock.json`.

## Assets

- `ob-mcp-1.1.3.tgz`
- `ob-mcp-1.1.3-source.tar.gz`
- `sbom.cdx.json`
- `oceanbase-mcp-1.1.3-amd64.tar.gz`
- `oceanbase-mcp-1.1.3-arm64.tar.gz`
- `ghcr.io/sevoniva/oceanbase-mcp:v1.1.3`

## 中文说明

v1.1.3 是大 schema ER 规划和导出的稳定性补丁。重点是降低导出前的元数据加载量，增加明确的 ER 分片参数，并用本地 OceanBase 200+ 复杂表完成验证。只读安全边界不变。

### 变更

- `ob_plan_er_export` 改为使用轻量表统计和批量外键元数据，不再在规划阶段加载完整表详情。
- ER 导出 CLI 增加 `--strategy` 和 `--max-columns-per-table`。
- connected-components 和 table-prefix 分片策略会把较小的孤立组件合并到受控 chunk 中。
- MySQL 表列表在可用时返回估算行数。
- ER 规划输出增加估算表数、估算字段数、估算关系数、大表提示、风险、推荐下一步工具和分片命令。
- OpenCode 和部署文档已更新到当前大 schema ER 工作流和 v1.1.3 交付资产。

### 验证

- `npm test`：211 个测试通过。
- `npm run docs:check`：通过。
- `npm audit --omit=dev --audit-level=moderate`：通过。
- `npm pack --dry-run`：通过。
- Docker build：通过。
- 本地 OceanBase MySQL stdio 和 HTTP smoke test 通过。
- 本地 OceanBase Oracle stdio 和 HTTP smoke test 通过。
- MySQL ER 导出：222 张表、5 个 chunk、215 条渲染关系、219 条规划关系。
- Oracle ER 导出：352 张表、8 个 chunk、220 条渲染关系、224 条规划关系。
- Oracle 验证包含全部 220 张 `OB_MCP_LG_*` 复杂测试表，可见 schema 覆盖范围大于 MySQL 验证。
- MySQL 和 Oracle 小范围 ER HTML 导出通过。
- MySQL 和 Oracle 百万行表 `ob_describe_table` 验证通过，未扫描目标表数据。
- Oracle `OB_MCP_MILLION_DESCRIBE` 已用 1,048,576 行真实数据验证，数据准备采用受控分批写入。

### 离线构建

```bash
tar -xzf ob-mcp-1.1.3-source.tar.gz
cd ob-mcp-1.1.3
npm ci
npm run build
npm run start
```

源码归档不包含 `node_modules` 和 `dist`。私有 npm 制品库需要能提供 `package-lock.json` 中锁定的依赖。

### 交付资产

- `ob-mcp-1.1.3.tgz`
- `ob-mcp-1.1.3-source.tar.gz`
- `sbom.cdx.json`
- `oceanbase-mcp-1.1.3-amd64.tar.gz`
- `oceanbase-mcp-1.1.3-arm64.tar.gz`
- `ghcr.io/sevoniva/oceanbase-mcp:v1.1.3`
