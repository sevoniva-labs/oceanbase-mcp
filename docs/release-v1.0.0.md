## OceanBase MCP v1.0.0

v1.0.0 completes the local OceanBase Developer Assistant scope for OpenCode. It improves metadata discovery, read-only SQL assistance, paged query workflows, ER diagrams, data dictionaries, project SQL scanning, local setup checks, and internal delivery assets. The server remains strictly read-only.

## 新增能力

- 本地初始化和诊断：`ob-mcp init`、`ob-mcp doctor`、`ob_check_opencode_setup`、`ob_get_usage_guide`、`ob_list_capabilities`。
- 元数据和字典：schema map、统一搜索、业务词找表、跨表找字段、表摘要、数据库字典、表和 schema 对比。
- SQL 辅助：查询准备、结构化 SELECT 构建、SQL lint、SQL 改写、MySQL/Oracle 方言转换、错误解释和查询示例。
- 查询体验：内存查询会话、上一页/下一页、查询细化、结果摘要、结果对比和 Markdown/CSV 预览。
- 数据理解：表画像、字段画像增强、值分布、时间字段识别、维度字段识别、最近数据查询和数据质量检查。
- ER 图：Mermaid、JSON、HTML static/interactive/compact/detailed、实体图、关系解释、Markdown/PlantUML/DOT 文档和 CLI 导出。
- 项目代码辅助：`ob-mcp scan-sql`、SQL 片段校验、项目 SQL 解释、mapper 上下文和未知字段候选。
- 文档生成：表文档、schema 文档、数据字典、SQL 文档和新开发者入门文档。

## Delivery Assets

- `ob-mcp-1.0.0-source.tar.gz`：源码归档，用于内网编译。
- `ob-mcp-1.0.0.tgz`：npm package。
- `sbom.cdx.json`：CycloneDX SBOM。
- `oceanbase-mcp-1.0.0-amd64.tar.gz`：amd64 离线镜像。
- `oceanbase-mcp-1.0.0-arm64.tar.gz`：arm64 离线镜像。
- `ghcr.io/sevoniva/oceanbase-mcp:v1.0.0`
- `ghcr.io/sevoniva/oceanbase-mcp:1.0.0`

## 内网源码编译

```bash
tar -xzf ob-mcp-1.0.0-source.tar.gz
cd ob-mcp-1.0.0
npm ci
npm run build
npm run start
```

源码归档不包含 `node_modules` 和 `dist`。内网 npm 制品库需要能提供 `package-lock.json` 中锁定的依赖。

## 验证结果

- OceanBase MySQL 模式：`npm run smoke`、`npm run mcp:smoke`、`npm run http:smoke` 通过。
- OceanBase Oracle 模式：`npm run mcp:smoke:oracle`、`npm run http:smoke:oracle` 通过。
- 1.0 核心 smoke 覆盖：schema map、prepare query、build select、lint sql、query session、ER HTML、data dictionary、project SQL validation。
- 工程检查：`npm test`、`npm run docs:check`、`npm audit --omit=dev --audit-level=moderate`、`npm pack --dry-run`、Docker build 通过。

## 生产注意事项

- 建议数据库账号仍使用只读权限；MCP 会继续拦截写入、DDL、DCL、过程调用、序列 `NEXTVAL`、锁表、文件函数和 sleep。
- 业务字典只用于搜索提示，结果仍受 profile、schema、table、column 权限过滤。
- 字段画像、数据质量和最近数据查询使用受限查询，不做无边界全表扫描。
- ER 图关系来自约束、索引或带证据的保守推断，低置信度关系不能当作真实外键。
- OpenCode 使用前建议先加载随包提供的 Agent/Skill 配置。
