# OceanBase MCP

[中文文档](docs/zh-CN/README.md) | [English Docs](docs/en/README.md)

OceanBase 只读 MCP 网关，用于 OpenCode 和其他 MCP 客户端安全查看 OceanBase。支持本地 stdio、远程 HTTP、MySQL/Oracle 模式、访问策略、来源 IP 限制、诊断、指标以及 Docker/Kubernetes 部署模板。

Read-only MCP gateway for OceanBase. It lets OpenCode and other MCP clients inspect OceanBase safely through explicit read-only tools, schema/table policy, HTTP authentication, source IP allowlists, diagnostics, metrics, and production deployment templates.

服务从设计上只读：没有写入工具，拒绝写入/控制 SQL，默认阻止 `SELECT *`，用户 SQL 默认走只读事务，并且 `OB_MCP_READ_ONLY=false` 会直接启动失败。

OceanBase MCP is read-only by design. It has no write tool, rejects write/control SQL, blocks `SELECT *` by default, runs user SQL in read-only transactions, and refuses to start when `OB_MCP_READ_ONLY=false`.

## Documentation / 文档

| 主题 / Topic | 中文 | English |
| --- | --- | --- |
| 起步 / Start here | [快速开始](docs/zh-CN/README.md) | [Quick start](docs/en/README.md) |
| OpenCode 接入 / OpenCode | [接入 OpenCode](docs/zh-CN/opencode.md) | [OpenCode setup](docs/en/opencode.md) |
| 配置 / Configuration | [配置说明](docs/zh-CN/configuration.md) | [Configuration](docs/en/configuration.md) |
| 部署 / Deployment | [部署指南](docs/zh-CN/deployment.md) | [Deployment](docs/en/deployment.md) |
| 架构 / Architecture | [架构说明](docs/zh-CN/architecture.md) | [Architecture](docs/en/architecture.md) |
| 安全 / Security | [安全基线](docs/zh-CN/security.md) | [Security baseline](docs/en/security.md) |
| 示例 / Examples | [示例索引](examples/README.zh-CN.md) | [Examples](examples/README.en.md) |

## Versioned Capabilities / 功能版本

| Since | 中文 | English |
| --- | --- | --- |
| v0.3.0 | 基础只读 MCP 网关：stdio 接入、OceanBase MySQL/Oracle 模式连接、只读 SQL 执行和常用表元数据查看。 | Read-only MCP gateway foundation: stdio integration, OceanBase MySQL/Oracle connectivity, read-only SQL execution, and common table metadata inspection. |
| v0.3.0 | 基础安全策略：拒绝写入/控制 SQL、多语句、危险函数和默认 `SELECT *`；限制行数、SQL 长度和返回大小。 | Baseline SQL policy: blocks write/control SQL, multi-statement SQL, dangerous functions, and `SELECT *` by default; caps rows, SQL length, and response size. |
| v0.3.0 | 表结构、索引、约束、分区和脱敏样例数据工具。 | Tools for table schemas, indexes, constraints, partitions, and masked sample rows. |
| v0.4.0 | 生产部署硬化：HTTP 模式、Bearer token、Host allowlist、来源 IP allowlist、body 限制、限流、健康检查、指标和审计日志。 | Production hardening: HTTP mode, bearer token auth, Host allowlist, source IP allowlist, body limits, rate limits, health checks, metrics, and audit logs. |
| v0.4.0 | 数据库账号权限核验和更完整的配置诊断，用于上线前检查只读边界。 | Database permission verification and expanded configuration diagnostics for release checks. |
| v0.5.0 | 开发辅助元数据：表 DDL、表统计、Oracle 对象元数据、相关表发现和 ER 图生成。 | Developer metadata: table DDL, table statistics, Oracle object metadata, related-table discovery, and ER diagram generation. |
| v0.5.0 | SQL 辅助：只读 SQL 模板、执行计划分析和基于证据的性能建议报告。 | SQL assistance: read-only query templates, query plan analysis, and evidence-based performance advisory reports. |
| v0.5.0 | 字段级脱敏配置增强，支持精确字段匹配和自动敏感字段识别。 | Enhanced column masking with exact column matches and automatic sensitive-name detection. |
| v0.5.1 | OpenCode Agent/Skill：要求先查元数据，再生成只读 SQL，执行前预览风险，最后分页查询和总结结果。 | OpenCode Agent/Skill: metadata first, read-only SQL generation, pre-execution risk preview, paged query execution, and result summarization. |
| v0.5.1 | 查询体验增强：表上下文、查询预览、分页查询、列元数据、Markdown 预览、结果警告和结构化错误提示。 | Query workflow improvements: table context, query preview, paged queries, column metadata, Markdown preview, warnings, and structured SQL error hints. |
| v0.5.1 | 字段画像和业务字典：受限字段分布分析，以及业务词到 schema/table/column 的可见映射。 | Column profiling and business glossary: bounded column distribution analysis and visible business-term mappings to schemas, tables, and columns. |
| v0.5.1 | Release 交付补齐：npm 包、SBOM、amd64/arm64 离线镜像和源码归档。 | Release delivery assets: npm package, SBOM, amd64/arm64 offline images, and source archive. |

所有数据访问能力都受 profile 权限、schema/table/column 策略、只读 SQL 策略、行数限制、输出大小限制、超时、并发限制、审计日志和错误脱敏约束。

All data-access tools are governed by profile permissions, schema/table/column policy, read-only SQL policy, row caps, response-size caps, timeouts, concurrency limits, audit logging, and error redaction.

## Quick Start / 快速开始

```bash
git clone https://github.com/sevoniva/oceanbase-mcp.git
cd oceanbase-mcp
npm install
npm run build
cp .env.example .env
npm run config:doctor
npm run start
```

随后使用 `opencode.jsonc` 或 [examples](examples) 目录中的示例接入 OpenCode。

Then configure OpenCode with `opencode.jsonc` or one of the files under [examples](examples).

## Production Minimum / 生产最小配置

```bash
NODE_ENV=production
OB_HOST=your-obproxy.example.com
OB_PORT=2883
OB_USER=readonly_user@tenant#cluster
OB_PASSWORD_FILE=/run/secrets/ob_password
OB_COMPATIBILITY=mysql
OB_PRODUCTION=true
OB_MCP_READ_ONLY=true
OB_ALLOWED_SCHEMAS=app_schema
OB_ALLOW_SELECT_STAR=false
OB_ENFORCE_READ_ONLY_TX=true
OB_MAX_ROWS=100
OB_MAX_RESULT_BYTES=1048576
OB_MCP_HOST=127.0.0.1
OB_MCP_AUTH_TOKEN_FILE=/run/secrets/ob_mcp_auth_token
OB_MCP_ALLOWED_IPS=127.0.0.1,10.0.0.0/8
```

只有在 TLS/反向代理或可信网络边界后，才使用 `OB_MCP_HOST=0.0.0.0`。非本地 HTTP 绑定必须配置 `OB_MCP_AUTH_TOKEN`、`OB_MCP_ALLOWED_HOSTS` 和 `OB_MCP_ALLOWED_IPS`。

Use `OB_MCP_HOST=0.0.0.0` only behind TLS/reverse proxy or a trusted network boundary. Non-local HTTP binds require `OB_MCP_AUTH_TOKEN`, `OB_MCP_ALLOWED_HOSTS`, and `OB_MCP_ALLOWED_IPS`.

## Tools / 工具

| 工具 / Tool | Since | 中文 | English |
| --- | --- | --- | --- |
| `ob_list_profiles` | v0.3.0 | 列出 profile，并隐藏敏感信息。 | List configured profiles with secrets redacted. |
| `ob_config_diagnostics` | v0.3.0 | 输出部署和策略诊断。 | Report deployment and policy checks. |
| `ob_verify_permissions` | v0.4.0 | 检查数据库账号是否包含写入或管理权限。 | Check current database grants for write/admin privileges. |
| `ob_ping` | v0.3.0 | 验证 OceanBase 连接。 | Verify the OceanBase connection. |
| `ob_policy_explain` | v0.3.0 | 解释 SQL 是否会被允许。 | Explain whether SQL would be allowed. |
| `ob_query_preview` | v0.5.1 | 执行前预览只读策略和执行计划风险，不返回数据。 | Preview read-only policy and plan risk before execution, without returning data. |
| `ob_query` | v0.3.0 | 执行严格只读 SQL；v0.5.1 起返回列元数据、Markdown 预览和警告。 | Run strict read-only SQL; returns column metadata, Markdown preview, and warnings since v0.5.1. |
| `ob_query_page` | v0.5.1 | 执行带分页的只读查询。 | Run a paged read-only query. |
| `ob_list_schemas` | v0.3.0 | 列出可见 schema/database。 | List visible schemas/databases. |
| `ob_list_tables` | v0.3.0 | 列出可见表。 | List visible tables. |
| `ob_describe_table` | v0.3.0 | 返回列元数据。 | Return column metadata. |
| `ob_explain` | v0.3.0 | 对只读 SQL 执行 `EXPLAIN`。 | Run `EXPLAIN` for read-only SQL. |
| `ob_analyze_query_plan` | v0.5.0 | 返回基于证据的执行计划分析。 | Return evidence-based plan findings. |
| `ob_generate_performance_report` | v0.5.0 | 基于 EXPLAIN 和元数据生成只读性能建议报告。 | Generate a read-only performance advisory report from EXPLAIN and metadata. |
| `ob_search_catalog` | v0.3.0 | 搜索 schema、表和列；v0.5.1 起可合并业务字典命中。 | Search schemas, tables, and columns; business glossary matches can be included since v0.5.1. |
| `ob_search_business_glossary` | v0.5.1 | 搜索业务词到 schema/table/column 的可见映射。 | Search visible business-term mappings to schemas, tables, and columns. |
| `ob_list_objects` | v0.5.0 | 列出经过策略过滤的 Oracle 对象。 | List policy-filtered Oracle views, sequences, synonyms, procedures, functions, and packages. |
| `ob_get_object_metadata` | v0.5.0 | 返回单个 Oracle 对象的有限元数据和源码预览。 | Return bounded metadata and source preview for one Oracle object. |
| `ob_get_table_schema` | v0.3.0 | 返回经过策略过滤的表结构。 | Return policy-filtered table schema. |
| `ob_get_table_ddl` | v0.5.0 | 返回表的原生或结构化 DDL 元数据。 | Return native or structured table DDL metadata. |
| `ob_get_table_context` | v0.5.1 | 返回写 SQL 和查数据常用的表上下文。 | Return common table context for SQL drafting and data inspection. |
| `ob_find_related_tables` | v0.5.0 | 查找外键关系和保守的命名推断关系。 | Find foreign-key and conservative naming-based table relationships. |
| `ob_get_table_stats` | v0.5.0 | 返回表行数估算、对象计数和存储统计。 | Return table row estimates, counts, and storage statistics. |
| `ob_profile_columns` | v0.5.1 | 返回受限样本内的字段画像，并对敏感值脱敏。 | Return bounded-sample column profiles with sensitive values masked. |
| `ob_generate_query` | v0.5.0 | 基于表元数据生成只读 SQL 模板。 | Generate read-only SQL templates from table metadata. |
| `ob_generate_er_diagram` | v0.5.0 | 基于允许访问的表生成 Mermaid 和 JSON ER 元数据。 | Generate Mermaid and JSON ER metadata from allowed tables. |
| `ob_get_indexes` | v0.3.0 | 返回表索引元数据。 | Return table index metadata. |
| `ob_get_constraints` | v0.3.0 | 返回主键、唯一键、外键、check 和 not-null 约束。 | Return primary, unique, foreign-key, check, and not-null constraints. |
| `ob_get_partitions` | v0.3.0 | 返回表分区元数据。 | Return table partition metadata. |
| `ob_sample_rows` | v0.3.0 | 返回显式列样例数据，并默认脱敏。 | Return masked, explicit-column sample rows. |

## Validation / 验证

```bash
npm test
npm run smoke
npm run mcp:smoke
npm run http:smoke
npm audit --omit=dev --audit-level=moderate
npm pack --dry-run
```

Oracle 模式验证：

Oracle compatibility:

```bash
npm run mcp:smoke:oracle
npm run http:smoke:oracle
```

完整配置见 [中文文档](docs/zh-CN/README.md) 或 [English Docs](docs/en/README.md)。

See [docs/en/README.md](docs/en/README.md) or [docs/zh-CN/README.md](docs/zh-CN/README.md) for complete setup.
