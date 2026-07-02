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
| SQL 辅助 / SQL assistance | [SQL 辅助](docs/zh-CN/sql-assistant.md) | [SQL assistance](docs/en/sql-assistant.md) |
| ER 图 / ER diagrams | [ER 图](docs/zh-CN/er.md) | [ER diagrams](docs/en/er.md) |
| 数据字典 / Data dictionary | [数据字典与文档生成](docs/zh-CN/data-dictionary.md) | [Data dictionary and docs](docs/en/data-dictionary.md) |
| 元数据变更 / Metadata change | [元数据变更分析](docs/zh-CN/metadata-change.md) | [Metadata change analysis](docs/en/metadata-change.md) |
| 部署 / Deployment | [部署指南](docs/zh-CN/deployment.md) | [Deployment](docs/en/deployment.md) |
| 架构 / Architecture | [架构说明](docs/zh-CN/architecture.md) | [Architecture](docs/en/architecture.md) |
| 安全 / Security | [安全基线](docs/zh-CN/security.md) | [Security baseline](docs/en/security.md) |
| 示例 / Examples | [示例索引](examples/README.zh-CN.md) | [Examples](examples/README.en.md) |

## Release Timeline / 版本路线

这张表只列版本主题；单个工具的版本归属见下方 `Tools / 工具` 表。

This table lists release themes only. Per-tool versioning is in the `Tools / 工具` table below.

| Version | 中文 | English |
| --- | --- | --- |
| v0.3.0 | 建立只读 MCP 网关、OceanBase MySQL/Oracle 连接、基础 SQL 策略、表元数据和脱敏样例数据。 | Read-only MCP gateway, OceanBase MySQL/Oracle connectivity, baseline SQL policy, table metadata, and masked sample rows. |
| v0.4.0 | 增加 HTTP 部署、安全加固、Host/IP allowlist、限流、健康检查、指标、审计日志和数据库权限核验。 | HTTP deployment, security hardening, Host/IP allowlists, rate limits, health checks, metrics, audit logs, and database permission checks. |
| v0.5.0 | 补齐开发元数据：表 DDL、统计信息、Oracle 对象、关系发现、ER 图、执行计划分析和性能建议。 | Developer metadata: table DDL, statistics, Oracle objects, relationship discovery, ER diagrams, plan analysis, and performance advice. |
| v0.5.1 | 改善 OpenCode 查询流程：表上下文、查询预览、分页查询、结果结构、错误提示、字段画像和业务字典。 | OpenCode query workflow: table context, query preview, paged queries, result structure, error hints, column profiling, and business glossary. |
| v1.0.0 | 完成本地开发助手能力：初始化/诊断、统一搜索、SQL 辅助、查询会话、数据理解、ER HTML、文档生成、项目 SQL 扫描和内网交付。 | Local developer assistant scope: init/doctor, unified search, SQL assistance, query sessions, data understanding, ER HTML, documentation, project SQL scanning, and internal delivery. |
| v1.1.0 | 增加元数据快照、快照对比、SQL 使用索引、影响分析、变更报告和关系路径解释，用于迭代前后评审。 | Metadata snapshots, snapshot diff, SQL usage index, impact analysis, change reports, and relationship paths for iteration review. |
| v1.1.1 | 修复大 schema ER 生成稳定性，增加批量元数据加载、ER HTML 浏览器优化和本地分片导出规划。 | Large-schema ER stability, batched metadata loading, improved ER HTML browser, and chunked local export planning. |

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

按 Since 版本升序排列；同一版本内按工具名升序排列。

Sorted by Since version in ascending order; tools with the same version are sorted by tool name.

| Since | 工具 / Tool | 中文 | English |
| --- | --- | --- | --- |
| v0.3.0 | `ob_config_diagnostics` | 输出部署和策略诊断。 | Report deployment and policy checks. |
| v0.3.0 | `ob_describe_table` | 返回列元数据。 | Return column metadata. |
| v0.3.0 | `ob_explain` | 对只读 SQL 执行 `EXPLAIN`。 | Run `EXPLAIN` for read-only SQL. |
| v0.3.0 | `ob_get_constraints` | 返回主键、唯一键、外键、check 和 not-null 约束。 | Return primary, unique, foreign-key, check, and not-null constraints. |
| v0.3.0 | `ob_get_indexes` | 返回表索引元数据。 | Return table index metadata. |
| v0.3.0 | `ob_get_partitions` | 返回表分区元数据。 | Return table partition metadata. |
| v0.3.0 | `ob_get_table_schema` | 返回经过策略过滤的表结构。 | Return policy-filtered table schema. |
| v0.3.0 | `ob_list_profiles` | 列出 profile，并隐藏敏感信息。 | List configured profiles with secrets redacted. |
| v0.3.0 | `ob_list_schemas` | 列出可见 schema/database。 | List visible schemas/databases. |
| v0.3.0 | `ob_list_tables` | 列出可见表。 | List visible tables. |
| v0.3.0 | `ob_ping` | 验证 OceanBase 连接。 | Verify the OceanBase connection. |
| v0.3.0 | `ob_policy_explain` | 解释 SQL 是否会被允许。 | Explain whether SQL would be allowed. |
| v0.3.0 | `ob_query` | 执行严格只读 SQL；v0.5.1 起返回列元数据、Markdown 预览和警告。 | Run strict read-only SQL; returns column metadata, Markdown preview, and warnings since v0.5.1. |
| v0.3.0 | `ob_sample_rows` | 返回显式列样例数据，并默认脱敏。 | Return masked, explicit-column sample rows. |
| v0.3.0 | `ob_search_catalog` | 搜索 schema、表和列；v0.5.1 起可合并业务字典命中。 | Search schemas, tables, and columns; business glossary matches can be included since v0.5.1. |
| v0.4.0 | `ob_verify_permissions` | 检查数据库账号是否包含写入或管理权限。 | Check current database grants for write/admin privileges. |
| v0.5.0 | `ob_analyze_query_plan` | 返回基于证据的执行计划分析。 | Return evidence-based plan findings. |
| v0.5.0 | `ob_find_related_tables` | 查找外键关系和保守的命名推断关系。 | Find foreign-key and conservative naming-based table relationships. |
| v0.5.0 | `ob_generate_er_diagram` | 基于允许访问的表生成 Mermaid 和 JSON ER 元数据；v1.0.0 增强业务词、表清单、深度、置信度和推断关系控制。 | Generate Mermaid and JSON ER metadata from allowed tables; v1.0.0 adds business-term scope, table lists, depth, confidence, and inferred-relation controls. |
| v0.5.0 | `ob_generate_performance_report` | 基于 EXPLAIN 和元数据生成只读性能建议报告。 | Generate a read-only performance advisory report from EXPLAIN and metadata. |
| v0.5.0 | `ob_generate_query` | 基于表元数据生成只读 SQL 模板。 | Generate read-only SQL templates from table metadata. |
| v0.5.0 | `ob_get_object_metadata` | 返回单个 Oracle 对象的有限元数据和源码预览。 | Return bounded metadata and source preview for one Oracle object. |
| v0.5.0 | `ob_get_table_ddl` | 返回表的原生或结构化 DDL 元数据。 | Return native or structured table DDL metadata. |
| v0.5.0 | `ob_get_table_stats` | 返回表行数估算、对象计数和存储统计。 | Return table row estimates, counts, and storage statistics. |
| v0.5.0 | `ob_list_objects` | 列出经过策略过滤的 Oracle 对象。 | List policy-filtered Oracle views, sequences, synonyms, procedures, functions, and packages. |
| v0.5.1 | `ob_get_table_context` | 返回写 SQL 和查数据常用的表上下文。 | Return common table context for SQL drafting and data inspection. |
| v0.5.1 | `ob_profile_columns` | 返回受限样本内的字段画像；v1.0.0 起包含类型策略和枚举候选信号。 | Return bounded-sample column profiles; includes type strategy and enum signals since v1.0.0. |
| v0.5.1 | `ob_query_page` | 执行带分页的只读查询。 | Run a paged read-only query. |
| v0.5.1 | `ob_query_preview` | 执行前预览只读策略和执行计划风险，不返回数据。 | Preview read-only policy and plan risk before execution, without returning data. |
| v0.5.1 | `ob_search_business_glossary` | 搜索业务词到 schema/table/column 的可见映射。 | Search visible business-term mappings to schemas, tables, and columns. |
| v1.0.0 | `ob_build_select` | 用经过校验的结构化输入生成参数化只读 SELECT。 | Build parameterized read-only SELECT statements from validated structured input. |
| v1.0.0 | `ob_check_data_quality` | 受限采样检查空值、重复键风险、维度和时间字段异常。 | Run bounded read-only checks for nulls, duplicate key risk, dimensions, and time columns. |
| v1.0.0 | `ob_check_opencode_setup` | 检查本地 OpenCode 配置、OceanBase agent 和查询 skill。 | Check local OpenCode config, OceanBase agent, and query skill files. |
| v1.0.0 | `ob_close_query_session` | 关闭内存查询上下文。 | Close an in-memory query session. |
| v1.0.0 | `ob_compare_query_results` | 比较两份已返回结果，不额外读取数据库。 | Compare two already returned query results without reading the database. |
| v1.0.0 | `ob_compare_schemas` | 比较两个 schema 的表清单和受限表结构差异。 | Compare two visible schemas by table list and bounded table metadata differences. |
| v1.0.0 | `ob_compare_tables` | 比较两张表的字段、索引、约束和分区差异。 | Compare two visible tables by columns, indexes, constraints, and partitions. |
| v1.0.0 | `ob_convert_sql_dialect` | 在 OceanBase MySQL/Oracle 模式间转换只读 SQL，并标明限制。 | Convert read-only SQL between OceanBase MySQL and Oracle modes with limitations. |
| v1.0.0 | `ob_detect_dimension_columns` | 基于元数据识别状态、类型、渠道、地区等维度字段。 | Detect likely status, type, channel, region, and category columns from metadata. |
| v1.0.0 | `ob_detect_time_columns` | 基于元数据识别创建、更新和业务时间字段。 | Detect likely create, update, and business time columns from metadata. |
| v1.0.0 | `ob_explain_error` | 结合策略和可见元数据解释 SQL 错误，不执行 SQL。 | Explain SQL errors with policy context and visible metadata hints without executing SQL. |
| v1.0.0 | `ob_explain_project_query` | 解释项目 SQL 的表、字段、过滤、分页和风险，不执行查询。 | Explain project SQL tables, fields, filters, pagination, and risk without executing it. |
| v1.0.0 | `ob_explain_relationship` | 解释两张表之间可见关系的字段依据、约束依据、命名依据和置信度；v1.1.0 起返回有限深度关系路径。 | Explain visible relationship evidence and confidence between two tables; returns bounded relationship paths since v1.1.0. |
| v1.0.0 | `ob_export_result_preview` | 生成 Markdown/CSV 结果预览字符串，不落盘。 | Generate Markdown/CSV result preview text without writing files. |
| v1.0.0 | `ob_find_columns` | 按字段名、注释、类型、表名模式或业务词查找字段。 | Find visible columns by name, comment, type, table pattern, or business term. |
| v1.0.0 | `ob_find_recent_rows` | 基于明确或识别出的时间字段分页查看最近数据。 | Read recent rows using an explicit or detected time column with safe pagination. |
| v1.0.0 | `ob_find_tables_by_business_term` | 按业务词返回候选表、依据和关联表摘要。 | Find candidate tables for a business term with evidence and related tables. |
| v1.0.0 | `ob_find_unknown_columns_in_sql` | 发现 SQL 中未知表或字段，并给出可见元数据候选。 | Find unknown tables or columns in SQL with visible metadata-based candidates. |
| v1.0.0 | `ob_generate_data_dictionary` | 生成 JSON、Markdown 或简版 HTML 数据字典。 | Generate JSON, Markdown, or simple HTML data dictionaries. |
| v1.0.0 | `ob_generate_entity_diagram` | 围绕业务词或表名生成局部实体图，返回 Mermaid、JSON、HTML 和关系依据。 | Generate local entity diagrams from a business term or table with Mermaid, JSON, HTML, and relationship evidence. |
| v1.0.0 | `ob_generate_er_document` | 基于允许访问的元数据和关系证据生成 Markdown、PlantUML 和 DOT 模型文档。 | Generate Markdown, PlantUML, and DOT ER documentation from allowed metadata and relationship evidence. |
| v1.0.0 | `ob_generate_er_html` | 基于允许访问的元数据和关系证据生成静态、交互、紧凑或详细版自包含 HTML ER 图。 | Generate self-contained static, interactive, compact, or detailed HTML ER diagrams from allowed metadata and relationship evidence. |
| v1.0.0 | `ob_generate_mapper_context` | 为 mapper 或 SQL 文件生成表字段上下文，不修改代码。 | Generate table and column context for mapper or SQL files without modifying code. |
| v1.0.0 | `ob_generate_onboarding_doc` | 基于可见元数据和业务字典生成新开发者入门文档。 | Generate onboarding documentation from visible metadata and business glossary hints. |
| v1.0.0 | `ob_generate_query_doc` | 生成 SQL 片段说明文档，不执行目标查询。 | Generate SQL snippet documentation without executing the target query. |
| v1.0.0 | `ob_generate_query_examples` | 基于表上下文生成常用只读查询示例，不执行 SQL。 | Generate common read-only query examples from table context without executing SQL. |
| v1.0.0 | `ob_generate_schema_doc` | 生成 schema 级 Markdown 或 JSON 文档，带表和字段数量限制。 | Generate bounded Markdown or JSON documentation for visible tables in one schema. |
| v1.0.0 | `ob_generate_table_doc` | 生成单表 Markdown 或 JSON 文档，不包含敏感样例值。 | Generate Markdown or JSON documentation for one table without sample values. |
| v1.0.0 | `ob_get_cache_status` | 返回当前 profile 的元数据缓存状态，不暴露缓存内容。 | Return profile-scoped metadata cache status without exposing cached content. |
| v1.0.0 | `ob_get_database_dictionary` | 基于可见元数据生成受限 JSON 或 Markdown 数据字典。 | Generate bounded JSON or Markdown data dictionaries from visible metadata. |
| v1.0.0 | `ob_get_query_session` | 读取查询上下文，不暴露已存参数值。 | Read a query session context without exposing stored parameter values. |
| v1.0.0 | `ob_get_schema_map` | 返回紧凑的 schema、表、关键字段和关系摘要。 | Return compact schema, table, key-field, and relationship summaries. |
| v1.0.0 | `ob_get_table_summary` | 汇总单表用途推断、关键字段、关系和查询入口。 | Summarize one table with inferred purpose, key fields, relationships, and query entry points. |
| v1.0.0 | `ob_get_usage_guide` | 返回 OpenCode 推荐工作流、只读规则和 MySQL/Oracle 差异。 | Return the recommended OpenCode workflow, read-only rules, and MySQL/Oracle notes. |
| v1.0.0 | `ob_get_value_distribution` | 返回单个可见字段的受限 top value 分布。 | Return bounded top-value distribution for one visible column. |
| v1.0.0 | `ob_lint_sql` | 检查只读 SQL 的策略、方言、分页、排序、敏感字段和计划风险。 | Lint read-only SQL for policy, dialect, pagination, ordering, sensitive fields, and plan risk. |
| v1.0.0 | `ob_list_capabilities` | 返回当前 MCP 能力、工具分组、版本和只读限制。 | Return MCP capabilities, tool groups, versions, and read-only limits. |
| v1.0.0 | `ob_prepare_query` | 基于可见元数据准备候选表、字段、SQL 草稿和安全预览，不执行查询。 | Prepare candidate tables, fields, SQL drafts, and safety previews from visible metadata without executing a query. |
| v1.0.0 | `ob_profile_table` | 返回受限样本内的表级画像、关键字段、空值概览和字段信号。 | Return bounded table profiles with key fields, null overview, and sampled field signals. |
| v1.0.0 | `ob_query_next_page` | 基于查询上下文读取下一页，继续执行只读策略和行数限制。 | Run the next page for a query session with read-only policy and row limits enforced. |
| v1.0.0 | `ob_query_prev_page` | 基于查询上下文读取上一页，继续执行只读策略和行数限制。 | Run the previous page for a query session with read-only policy and row limits enforced. |
| v1.0.0 | `ob_query_refine` | 基于查询上下文生成细化后的只读 SELECT，不执行 SQL。 | Build refined read-only SELECT SQL from a query session without executing it. |
| v1.0.0 | `ob_refresh_metadata_cache` | 按 profile、schema 或 table 清理内存元数据缓存。 | Clear in-memory metadata cache entries by profile, schema, or table scope. |
| v1.0.0 | `ob_rewrite_sql` | 将 SELECT/WITH 改写为更安全的只读形式，不执行 SQL。 | Rewrite SELECT/WITH SQL into a safer read-only form without executing it. |
| v1.0.0 | `ob_search_everything` | 统一搜索 schema、表、字段、注释和业务词，并返回依据。 | Search schemas, tables, columns, comments, and business terms with evidence. |
| v1.0.0 | `ob_start_query_session` | 创建内存查询上下文，记录表、字段、SQL、分页和警告。 | Start an in-memory query context for tables, columns, SQL, paging, and warnings. |
| v1.0.0 | `ob_summarize_result` | 汇总已返回结果，不额外读取数据库。 | Summarize already returned rows without reading the database. |
| v1.0.0 | `ob_validate_sql_snippet` | 校验贴入 SQL 的只读策略、方言、分页、风险和可见表字段。 | Validate pasted SQL snippets for read-only policy, dialect, pagination, risk, and visible table or column metadata. |
| v1.1.0 | `ob_analyze_change_sql_impact` | 基于元数据 diff 和 SQL 使用索引分析项目 SQL 影响。 | Analyze project SQL impact from metadata diff and SQL usage index evidence. |
| v1.1.0 | `ob_analyze_metadata_impact` | 基于快照 diff、SQL 使用索引、关系和业务字典汇总影响面。 | Summarize metadata diff impact with SQL index, relationship, and glossary evidence. |
| v1.1.0 | `ob_capture_metadata_snapshot` | 采集受限的纯元数据快照，不读取业务数据。 | Capture bounded metadata-only snapshots without reading business data. |
| v1.1.0 | `ob_compare_metadata_snapshots` | 对比两份元数据快照，返回基于证据的结构变化。 | Compare metadata snapshots and return evidence-based structural changes. |
| v1.1.0 | `ob_find_sql_usages` | 从静态 SQL 使用索引中查找表、字段或业务词引用。 | Find table, column, or business-term references from a static SQL usage index. |
| v1.1.0 | `ob_generate_metadata_change_report` | 基于 diff 和影响分析生成 Markdown 或简版 HTML 变更报告。 | Generate Markdown or simple HTML change reports from diff and impact evidence. |
| v1.1.1 | `ob_plan_er_export` | 为大 schema 规划本地 ER HTML 分片导出命令，避免 MCP inline 返回过大。 | Plan chunked local ER HTML export commands for large schemas without returning large inline HTML. |

## Metadata Change Workflow / 元数据变更流程

迭代开始和结束各采集一次元数据快照，再结合项目 SQL 使用索引生成影响报告：

Capture metadata before and after an iteration, then combine the diff with a project SQL usage index:

```bash
ob-mcp metadata snapshot --schema biz_test --out snapshots/before.json
ob-mcp scan-sql --path src --path mapper --index-out snapshots/sql-index.json --format text
ob-mcp metadata snapshot --schema biz_test --out snapshots/after.json
ob-mcp metadata diff --before snapshots/before.json --after snapshots/after.json --format markdown --out snapshots/diff.md
ob-mcp metadata report --before snapshots/before.json --after snapshots/after.json --sql-index snapshots/sql-index.json --format markdown --out snapshots/report.md
```

这些命令只读取元数据或本地项目文件，不执行数据库变更。报告只输出风险、证据和评审建议，不输出可直接执行的 DDL。

These commands only read metadata or local project files. Reports contain risks, evidence, and review guidance; they do not emit executable DDL.

## Internal Build / 内网编译

Release 附带源码归档，适合放入内网后通过内部 npm 制品库编译运行：

Release assets include a source archive for internal builds with an internal npm registry:

```bash
tar -xzf ob-mcp-1.1.1-source.tar.gz
cd ob-mcp-1.1.1
npm ci
npm run build
npm run start
```

源码归档不包含 `node_modules` 和 `dist`。内网 npm 制品库需要能提供 `package-lock.json` 中锁定的依赖。

The source archive excludes `node_modules` and `dist`. The internal npm registry must provide the dependencies locked by `package-lock.json`.

## Release Assets / 发布资产

| Asset | 中文 | English |
| --- | --- | --- |
| `ob-mcp-1.1.1.tgz` | npm 包。 | npm package. |
| `ob-mcp-1.1.1-source.tar.gz` | 源码归档，用于内网编译。 | Source archive for internal builds. |
| `sbom.cdx.json` | CycloneDX SBOM。 | CycloneDX SBOM. |
| `oceanbase-mcp-1.1.1-amd64.tar.gz` | amd64 离线镜像。 | amd64 offline image. |
| `oceanbase-mcp-1.1.1-arm64.tar.gz` | arm64 离线镜像。 | arm64 offline image. |
| `ghcr.io/sevoniva/oceanbase-mcp:v1.1.1` | GHCR 镜像 tag。 | GHCR image tag. |

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
