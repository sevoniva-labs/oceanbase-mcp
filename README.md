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
| CLI / CLI | [CLI](docs/zh-CN/cli.md) | [CLI](docs/en/cli.md) |
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
| v1.0.0 | 本地初始化和能力发现：生成本地配置、检查 OpenCode 接入、提供 MCP 使用指南和工具能力清单。 | Local setup and capability discovery: generate local config, check OpenCode setup, and expose MCP usage guidance and tool capabilities. |

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

新项目可以使用 `ob-mcp init --mode mysql --schema <schema>` 生成 `.env`、`opencode.jsonc`、OpenCode agent/skill 和业务字典模板。

For a new local project, use `ob-mcp init --mode mysql --schema <schema>` to create `.env`, `opencode.jsonc`, OpenCode agent/skill files, and a business glossary template.

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
| `ob_check_opencode_setup` | v1.0.0 | 检查本地 OpenCode 配置、OceanBase agent 和查询 skill。 | Check local OpenCode config, OceanBase agent, and query skill files. |
| `ob_get_usage_guide` | v1.0.0 | 返回 OpenCode 推荐工作流、只读规则和 MySQL/Oracle 差异。 | Return the recommended OpenCode workflow, read-only rules, and MySQL/Oracle notes. |
| `ob_list_capabilities` | v1.0.0 | 返回当前 MCP 能力、工具分组、版本和只读限制。 | Return MCP capabilities, tool groups, versions, and read-only limits. |
| `ob_verify_permissions` | v0.4.0 | 检查数据库账号是否包含写入或管理权限。 | Check current database grants for write/admin privileges. |
| `ob_ping` | v0.3.0 | 验证 OceanBase 连接。 | Verify the OceanBase connection. |
| `ob_policy_explain` | v0.3.0 | 解释 SQL 是否会被允许。 | Explain whether SQL would be allowed. |
| `ob_query_preview` | v0.5.1 | 执行前预览只读策略和执行计划风险，不返回数据。 | Preview read-only policy and plan risk before execution, without returning data. |
| `ob_query` | v0.3.0 | 执行严格只读 SQL；v0.5.1 起返回列元数据、Markdown 预览和警告。 | Run strict read-only SQL; returns column metadata, Markdown preview, and warnings since v0.5.1. |
| `ob_query_page` | v0.5.1 | 执行带分页的只读查询。 | Run a paged read-only query. |
| `ob_start_query_session` | v1.0.0 | 创建内存查询上下文，记录表、字段、SQL、分页和警告。 | Start an in-memory query context for tables, columns, SQL, paging, and warnings. |
| `ob_get_query_session` | v1.0.0 | 读取查询上下文，不暴露已存参数值。 | Read a query session context without exposing stored parameter values. |
| `ob_close_query_session` | v1.0.0 | 关闭内存查询上下文。 | Close an in-memory query session. |
| `ob_query_next_page` | v1.0.0 | 基于查询上下文读取下一页，继续执行只读策略和行数限制。 | Run the next page for a query session with read-only policy and row limits enforced. |
| `ob_query_prev_page` | v1.0.0 | 基于查询上下文读取上一页，继续执行只读策略和行数限制。 | Run the previous page for a query session with read-only policy and row limits enforced. |
| `ob_query_refine` | v1.0.0 | 基于查询上下文生成细化后的只读 SELECT，不执行 SQL。 | Build refined read-only SELECT SQL from a query session without executing it. |
| `ob_summarize_result` | v1.0.0 | 汇总已返回结果，不额外读取数据库。 | Summarize already returned rows without reading the database. |
| `ob_compare_query_results` | v1.0.0 | 比较两份已返回结果，不额外读取数据库。 | Compare two already returned query results without reading the database. |
| `ob_export_result_preview` | v1.0.0 | 生成 Markdown/CSV 结果预览字符串，不落盘。 | Generate Markdown/CSV result preview text without writing files. |
| `ob_list_schemas` | v0.3.0 | 列出可见 schema/database。 | List visible schemas/databases. |
| `ob_list_tables` | v0.3.0 | 列出可见表。 | List visible tables. |
| `ob_describe_table` | v0.3.0 | 返回列元数据。 | Return column metadata. |
| `ob_get_schema_map` | v1.0.0 | 返回紧凑的 schema、表、关键字段和关系摘要。 | Return compact schema, table, key-field, and relationship summaries. |
| `ob_get_database_dictionary` | v1.0.0 | 基于可见元数据生成受限 JSON 或 Markdown 数据字典。 | Generate bounded JSON or Markdown data dictionaries from visible metadata. |
| `ob_explain` | v0.3.0 | 对只读 SQL 执行 `EXPLAIN`。 | Run `EXPLAIN` for read-only SQL. |
| `ob_analyze_query_plan` | v0.5.0 | 返回基于证据的执行计划分析。 | Return evidence-based plan findings. |
| `ob_generate_performance_report` | v0.5.0 | 基于 EXPLAIN 和元数据生成只读性能建议报告。 | Generate a read-only performance advisory report from EXPLAIN and metadata. |
| `ob_search_catalog` | v0.3.0 | 搜索 schema、表和列；v0.5.1 起可合并业务字典命中。 | Search schemas, tables, and columns; business glossary matches can be included since v0.5.1. |
| `ob_search_everything` | v1.0.0 | 统一搜索 schema、表、字段、注释和业务词，并返回依据。 | Search schemas, tables, columns, comments, and business terms with evidence. |
| `ob_search_business_glossary` | v0.5.1 | 搜索业务词到 schema/table/column 的可见映射。 | Search visible business-term mappings to schemas, tables, and columns. |
| `ob_find_tables_by_business_term` | v1.0.0 | 按业务词返回候选表、依据和关联表摘要。 | Find candidate tables for a business term with evidence and related tables. |
| `ob_find_columns` | v1.0.0 | 按字段名、注释、类型、表名模式或业务词查找字段。 | Find visible columns by name, comment, type, table pattern, or business term. |
| `ob_get_table_summary` | v1.0.0 | 汇总单表用途推断、关键字段、关系和查询入口。 | Summarize one table with inferred purpose, key fields, relationships, and query entry points. |
| `ob_compare_tables` | v1.0.0 | 比较两张表的字段、索引、约束和分区差异。 | Compare two visible tables by columns, indexes, constraints, and partitions. |
| `ob_compare_schemas` | v1.0.0 | 比较两个 schema 的表清单和受限表结构差异。 | Compare two visible schemas by table list and bounded table metadata differences. |
| `ob_list_objects` | v0.5.0 | 列出经过策略过滤的 Oracle 对象。 | List policy-filtered Oracle views, sequences, synonyms, procedures, functions, and packages. |
| `ob_get_object_metadata` | v0.5.0 | 返回单个 Oracle 对象的有限元数据和源码预览。 | Return bounded metadata and source preview for one Oracle object. |
| `ob_get_table_schema` | v0.3.0 | 返回经过策略过滤的表结构。 | Return policy-filtered table schema. |
| `ob_get_table_ddl` | v0.5.0 | 返回表的原生或结构化 DDL 元数据。 | Return native or structured table DDL metadata. |
| `ob_get_table_context` | v0.5.1 | 返回写 SQL 和查数据常用的表上下文。 | Return common table context for SQL drafting and data inspection. |
| `ob_find_related_tables` | v0.5.0 | 查找外键关系和保守的命名推断关系。 | Find foreign-key and conservative naming-based table relationships. |
| `ob_get_table_stats` | v0.5.0 | 返回表行数估算、对象计数和存储统计。 | Return table row estimates, counts, and storage statistics. |
| `ob_profile_table` | v1.0.0 | 返回受限样本内的表级画像、关键字段、空值概览和字段信号。 | Return bounded table profiles with key fields, null overview, and sampled field signals. |
| `ob_profile_columns` | v0.5.1 | 返回受限样本内的字段画像；v1.0.0 起包含类型策略和枚举候选信号。 | Return bounded-sample column profiles; includes type strategy and enum signals since v1.0.0. |
| `ob_prepare_query` | v1.0.0 | 基于可见元数据准备候选表、字段、SQL 草稿和安全预览，不执行查询。 | Prepare candidate tables, fields, SQL drafts, and safety previews from visible metadata without executing a query. |
| `ob_build_select` | v1.0.0 | 用经过校验的结构化输入生成参数化只读 SELECT。 | Build parameterized read-only SELECT statements from validated structured input. |
| `ob_lint_sql` | v1.0.0 | 检查只读 SQL 的策略、方言、分页、排序、敏感字段和计划风险。 | Lint read-only SQL for policy, dialect, pagination, ordering, sensitive fields, and plan risk. |
| `ob_rewrite_sql` | v1.0.0 | 将 SELECT/WITH 改写为更安全的只读形式，不执行 SQL。 | Rewrite SELECT/WITH SQL into a safer read-only form without executing it. |
| `ob_convert_sql_dialect` | v1.0.0 | 在 OceanBase MySQL/Oracle 模式间转换只读 SQL，并标明限制。 | Convert read-only SQL between OceanBase MySQL and Oracle modes with limitations. |
| `ob_explain_error` | v1.0.0 | 结合策略和可见元数据解释 SQL 错误，不执行 SQL。 | Explain SQL errors with policy context and visible metadata hints without executing SQL. |
| `ob_generate_query_examples` | v1.0.0 | 基于表上下文生成常用只读查询示例，不执行 SQL。 | Generate common read-only query examples from table context without executing SQL. |
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
