## OceanBase MCP v0.5.1

v0.5.1 focuses on daily OceanBase query workflows in OpenCode. It adds metadata-first query guidance, safer query previews, paged result browsing, clearer result output, structured SQL error hints, column profiling, and an optional business glossary. The server remains strictly read-only.

## 新增能力

- OpenCode OceanBase Developer Assistant Agent/Skill：约束查询流程为“先查元数据，再生成只读 SQL，执行前预览风险，最后分页查看结果”。
- `ob_get_table_context`：返回字段、注释、类型、主键、索引、约束、分区、估算行数、相关表、查询模板和脱敏样例数据。
- `ob_query_preview`：执行前检查只读策略、涉及对象、敏感字段、`EXPLAIN` 风险、缺少 `LIMIT` 和潜在全表扫描。
- `ob_query_page`：提供受限分页查询，返回 `rows`、`columns`、分页信息、截断状态和排序稳定性提示。
- 查询结果增强：`ob_query` 和 `ob_query_page` 返回列元数据、脱敏标记、Markdown 预览和结果警告。
- SQL 错误提示：覆盖表/字段不存在、schema 不允许、Oracle 大小写、分页语法、权限不足和策略拒绝等常见问题。
- `ob_profile_columns`：返回字段空值比例、distinct、top values、min/max、时间范围和脱敏样例值。
- 业务字典：支持把业务词映射到 schema/table/column，用于搜索和提示，不扩大数据库访问权限。
- 内网交付：Release 附带源码归档，可在内网 npm 制品库环境中编译运行。

## Delivery Assets

- `ob-mcp-0.5.1-source.tar.gz`：源码归档，用于内网编译。
- `ob-mcp-0.5.1.tgz`：npm package。
- `sbom.cdx.json`：CycloneDX SBOM。
- `oceanbase-mcp-0.5.1-amd64.tar.gz`：amd64 离线镜像。
- `oceanbase-mcp-0.5.1-arm64.tar.gz`：arm64 离线镜像。
- `ghcr.io/sevoniva/oceanbase-mcp:v0.5.1`
- `ghcr.io/sevoniva/oceanbase-mcp:0.5.1`

## 内网源码编译

```bash
tar -xzf ob-mcp-0.5.1-source.tar.gz
cd ob-mcp-0.5.1
npm ci
npm run build
npm run start
```

源码归档不包含 `node_modules` 和 `dist`。内网 npm 制品库需要能提供 `package-lock.json` 中锁定的依赖。

## 验证结果

- OceanBase MySQL 模式：`npm run smoke`、`npm run mcp:smoke`、`npm run http:smoke` 通过。
- OceanBase Oracle 模式：`npm run smoke`、`npm run mcp:smoke:oracle`、`npm run http:smoke:oracle` 通过。
- 工程检查：`npm test`、`npm run docs:check`、`npm audit --omit=dev --audit-level=moderate`、`npm pack --dry-run`、Docker build 通过。

## 生产注意事项

- 建议数据库账号仍使用只读权限；MCP 会继续拦截写入、DDL、DCL、过程调用和序列 `NEXTVAL`。
- 业务字典只用于搜索提示，结果仍受 profile、schema、table、column 权限过滤。
- 字段画像使用受限查询和输出限制，不做无边界全表扫描。
- OpenCode 使用前建议先加载随包提供的 Agent/Skill 配置。
