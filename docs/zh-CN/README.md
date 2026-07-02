# OceanBase MCP

[English](../en/README.md) | [返回根目录](../../README.md)

OceanBase MCP 是一个面向 OceanBase 的只读 MCP 网关。它用于 OpenCode 和其他 MCP 客户端，让开发者可以安全查看数据库、元数据和样例数据，同时不暴露任何写入能力。

## 能力概览

- 通过 OBProxy 或 MySQL 协议端点连接 OceanBase。
- 支持 OceanBase MySQL 模式和 Oracle 模式。
- 只暴露只读 MCP 工具。
- 支持 schema/table allowlist、系统库隐藏、敏感列拦截、字段级样例脱敏、行数和返回大小硬限制、SQL 长度限制和只读事务。
- 支持表 DDL/结构、索引、约束、分区、统计信息、关系发现和 ER 图生成。
- 支持只读 SQL 模板生成、执行计划分析和性能建议报告。
- 提供 OpenCode agent 和 skill，引导模型按元数据优先、只读预览、分页查询的流程使用 MCP。
- 支持元数据快照、迭代前后对比、项目 SQL 使用索引和变更影响报告。
- Oracle 模式支持查看 view、sequence、synonym、procedure、function、package 等对象元数据。
- 支持本地 stdio 模式，也支持共享部署的 HTTP 模式。
- HTTP 模式支持 Bearer token 策略、Host allowlist、来源 IP allowlist、端点鉴权、body 限制和限流。
- 提供数据库账号权限只读核验工具。
- 提供 Docker、Kubernetes、Nginx、systemd 和本地 OpenCode 示例。

## 版本路线

这张表只列版本主题；单个工具的版本归属见下方工具列表。

| 版本 | 主题 |
| --- | --- |
| v0.3.0 | 建立只读 MCP 网关、OceanBase MySQL/Oracle 连接、基础 SQL 策略、表元数据和脱敏样例数据。 |
| v0.4.0 | 增加 HTTP 部署、安全加固、Host/IP allowlist、限流、健康检查、指标、审计日志和数据库权限核验。 |
| v0.5.0 | 补齐开发元数据：表 DDL、统计信息、Oracle 对象、关系发现、ER 图、执行计划分析和性能建议。 |
| v0.5.1 | 改善 OpenCode 查询流程：表上下文、查询预览、分页查询、结果结构、错误提示、字段画像和业务字典。 |
| v1.0.0 | 完成本地开发助手能力：初始化/诊断、统一搜索、SQL 辅助、查询会话、数据理解、ER HTML、文档生成、项目 SQL 扫描和内网交付。 |
| v1.1.0 | 增加元数据快照、快照对比、SQL 使用索引、影响分析、变更报告和关系路径解释，用于迭代前后评审。 |
| v1.1.1 | 修复大 schema ER 生成稳定性，增加批量元数据加载、ER HTML 浏览器优化和本地分片导出规划。 |
| v1.1.2 | 修复本地 OpenCode 连续查询稳定性，放宽本地 HTTP 默认限流，增加故障日志，并兼容 Oracle 常见命名占位符。 |

所有数据访问能力都受 profile 权限、schema/table/column 策略、只读 SQL 策略、行数限制、输出大小限制、超时、并发限制、审计日志和错误脱敏约束。

## 只读边界

这个服务从设计上只读：

- 没有任何写入 MCP 工具。
- `OB_MCP_READ_ONLY=true` 是默认值，且不能关闭。
- 设置 `OB_MCP_READ_ONLY=false` 会导致服务拒绝启动。
- `ob_query` 只接受 `SELECT`、`WITH` 和只读 SQL 的 `EXPLAIN`。
- 默认拦截 `SELECT *`、多语句、写入/控制关键字、可执行注释、文件函数、sleep、lock 和序列 `NEXTVAL`。
- 用户 SQL 默认在数据库只读事务中执行。

即使 `OB_USER` 是数据库读写账号，MCP 对外仍然只能读。生产环境仍建议使用只有 SELECT/元数据权限的数据库账号作为纵深防御。

## 安装

```bash
git clone https://github.com/sevoniva/oceanbase-mcp.git
cd oceanbase-mcp
npm install
npm run build
cp .env.example .env
npm run config:doctor
```

需要 Node.js 20 或更高版本。

## 本地接入 OpenCode

仓库内置的 [opencode.jsonc](../../opencode.jsonc) 会从当前项目启动 stdio MCP server。

```bash
npm run build
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

更多文档：

- [接入 OpenCode](opencode.md)
- [CLI](cli.md)
- [配置说明](configuration.md)
- [SQL 辅助](sql-assistant.md)
- [ER 图](er.md)
- [数据字典与文档生成](data-dictionary.md)
- [元数据变更分析](metadata-change.md)
- [部署指南](deployment.md)
- [架构说明](architecture.md)
- [安全基线](security.md)
- [示例文件](../../examples/README.zh-CN.md)

## 运行模式

### Stdio

stdio 适合本地 IDE 或 OpenCode 集成：

```bash
npm run start
```

### HTTP

HTTP 适合共享部署：

```bash
OB_MCP_AUTH_TOKEN="change-me-long-random-token" \
OB_MCP_ALLOWED_IPS="127.0.0.1" \
npm run start:http
```

如果绑定到 `0.0.0.0` 这类非本地地址，服务会强制要求：

- `OB_MCP_AUTH_TOKEN` 或 `OB_MCP_AUTH_TOKEN_FILE`
- `OB_MCP_ALLOWED_HOSTS`
- `OB_MCP_ALLOWED_IPS`

## 工具列表

按版本升序排列；同一版本内按工具名升序排列。

| 版本 | 工具 | 用途 |
| --- | --- | --- |
| v0.3.0 | `ob_config_diagnostics` | 输出部署和策略诊断。 |
| v0.3.0 | `ob_describe_table` | 返回列元数据。 |
| v0.3.0 | `ob_explain` | 对只读 SQL 执行 `EXPLAIN`。 |
| v0.3.0 | `ob_get_constraints` | 返回主键、唯一键、外键、check 和 not-null 约束。 |
| v0.3.0 | `ob_get_indexes` | 返回表索引元数据。 |
| v0.3.0 | `ob_get_partitions` | 返回表分区元数据。 |
| v0.3.0 | `ob_get_table_schema` | 返回经过策略过滤的表结构。 |
| v0.3.0 | `ob_list_profiles` | 列出已配置 profile，并隐藏敏感信息。 |
| v0.3.0 | `ob_list_schemas` | 列出可见 schema/database。 |
| v0.3.0 | `ob_list_tables` | 列出可见表。 |
| v0.3.0 | `ob_ping` | 验证 OceanBase 连接。 |
| v0.3.0 | `ob_policy_explain` | 解释 SQL 是否会被允许。 |
| v0.3.0 | `ob_query` | 执行严格只读 SQL；v0.5.1 起返回列元数据、Markdown 预览和警告。 |
| v0.3.0 | `ob_sample_rows` | 返回显式列样例数据，并默认脱敏。 |
| v0.3.0 | `ob_search_catalog` | 搜索 schema、表和列；v0.5.1 起可合并业务字典命中。 |
| v0.4.0 | `ob_verify_permissions` | 检查当前数据库账号是否包含写入或管理权限。 |
| v0.5.0 | `ob_analyze_query_plan` | 执行 `EXPLAIN` 并返回基于证据的执行计划分析。 |
| v0.5.0 | `ob_find_related_tables` | 查找外键关系和保守的命名推断表关系。 |
| v0.5.0 | `ob_generate_er_diagram` | 基于允许访问的表生成 Mermaid 和 JSON ER 元数据；v1.0.0 增强业务词、表清单、深度、置信度和推断关系控制。 |
| v0.5.0 | `ob_generate_performance_report` | 基于 EXPLAIN 和元数据生成只读性能建议报告。 |
| v0.5.0 | `ob_generate_query` | 基于表元数据生成只读 SQL 模板。 |
| v0.5.0 | `ob_get_object_metadata` | 返回单个 Oracle 对象的有限元数据和源码预览。 |
| v0.5.0 | `ob_get_table_ddl` | 返回表的原生或结构化 DDL 元数据。 |
| v0.5.0 | `ob_get_table_stats` | 返回表行数估算、对象计数和存储统计。 |
| v0.5.0 | `ob_list_objects` | 列出经过策略过滤的 Oracle view、sequence、synonym、procedure、function 和 package。 |
| v0.5.1 | `ob_get_table_context` | 返回写 SQL 和查数据常用的表上下文。 |
| v0.5.1 | `ob_profile_columns` | 返回受限样本内的字段画像；v1.0.0 起包含类型策略和枚举候选信号。 |
| v0.5.1 | `ob_query_page` | 执行带分页的只读查询。 |
| v0.5.1 | `ob_query_preview` | 执行前预览只读策略和执行计划风险，不返回数据。 |
| v0.5.1 | `ob_search_business_glossary` | 搜索业务词到 schema/table/column 的可见映射。 |
| v1.0.0 | `ob_build_select` | 用经过校验的结构化输入生成参数化只读 SELECT。 |
| v1.0.0 | `ob_check_data_quality` | 受限采样检查空值、重复键风险、维度和时间字段异常。 |
| v1.0.0 | `ob_check_opencode_setup` | 检查本地 OpenCode 配置、OceanBase agent 和查询 skill。 |
| v1.0.0 | `ob_close_query_session` | 关闭内存查询上下文。 |
| v1.0.0 | `ob_compare_query_results` | 比较两份已返回结果，不额外读取数据库。 |
| v1.0.0 | `ob_compare_schemas` | 比较两个 schema 的表清单和受限表结构差异。 |
| v1.0.0 | `ob_compare_tables` | 比较两张表的字段、索引、约束和分区差异。 |
| v1.0.0 | `ob_convert_sql_dialect` | 在 OceanBase MySQL/Oracle 模式间转换只读 SQL，并标明限制。 |
| v1.0.0 | `ob_detect_dimension_columns` | 基于元数据识别状态、类型、渠道、地区等维度字段。 |
| v1.0.0 | `ob_detect_time_columns` | 基于元数据识别创建、更新和业务时间字段。 |
| v1.0.0 | `ob_explain_error` | 结合策略和可见元数据解释 SQL 错误，不执行 SQL。 |
| v1.0.0 | `ob_explain_project_query` | 解释项目 SQL 的表、字段、过滤、分页和风险，不执行查询。 |
| v1.0.0 | `ob_explain_relationship` | 解释两张表之间可见关系的字段依据、约束依据、命名依据和置信度；v1.1.0 起返回有限深度关系路径。 |
| v1.0.0 | `ob_export_result_preview` | 生成 Markdown/CSV 结果预览字符串，不落盘。 |
| v1.0.0 | `ob_find_columns` | 按字段名、注释、类型、表名模式或业务词查找字段。 |
| v1.0.0 | `ob_find_recent_rows` | 基于明确或识别出的时间字段分页查看最近数据。 |
| v1.0.0 | `ob_find_tables_by_business_term` | 按业务词返回候选表、依据和关联表摘要。 |
| v1.0.0 | `ob_find_unknown_columns_in_sql` | 发现 SQL 中未知表或字段，并给出可见元数据候选。 |
| v1.0.0 | `ob_generate_data_dictionary` | 生成 JSON、Markdown 或简版 HTML 数据字典。 |
| v1.0.0 | `ob_generate_entity_diagram` | 围绕业务词或表名生成局部实体图，返回 Mermaid、JSON、HTML 和关系依据。 |
| v1.0.0 | `ob_generate_er_document` | 基于允许访问的元数据和关系证据生成 Markdown、PlantUML 和 DOT 模型文档。 |
| v1.0.0 | `ob_generate_er_html` | 基于允许访问的元数据和关系证据生成静态、交互、紧凑或详细版自包含 HTML ER 图。 |
| v1.0.0 | `ob_generate_mapper_context` | 为 mapper 或 SQL 文件生成表字段上下文，不修改代码。 |
| v1.0.0 | `ob_generate_onboarding_doc` | 基于可见元数据和业务字典生成新开发者入门文档。 |
| v1.0.0 | `ob_generate_query_doc` | 生成 SQL 片段说明文档，不执行目标查询。 |
| v1.0.0 | `ob_generate_query_examples` | 基于表上下文生成常用只读查询示例，不执行 SQL。 |
| v1.0.0 | `ob_generate_schema_doc` | 生成 schema 级 Markdown 或 JSON 文档，带表和字段数量限制。 |
| v1.0.0 | `ob_generate_table_doc` | 生成单表 Markdown 或 JSON 文档，不包含敏感样例值。 |
| v1.0.0 | `ob_get_cache_status` | 返回当前 profile 的元数据缓存状态，不暴露缓存内容。 |
| v1.0.0 | `ob_get_database_dictionary` | 基于可见元数据生成受限 JSON 或 Markdown 数据字典。 |
| v1.0.0 | `ob_get_query_session` | 读取查询上下文，不暴露已存参数值。 |
| v1.0.0 | `ob_get_schema_map` | 返回紧凑的 schema、表、关键字段和关系摘要。 |
| v1.0.0 | `ob_get_table_summary` | 汇总单表用途推断、关键字段、关系和查询入口。 |
| v1.0.0 | `ob_get_usage_guide` | 返回 OpenCode 推荐工作流、只读规则和 MySQL/Oracle 差异。 |
| v1.0.0 | `ob_get_value_distribution` | 返回单个可见字段的受限 top value 分布。 |
| v1.0.0 | `ob_lint_sql` | 检查只读 SQL 的策略、方言、分页、排序、敏感字段和计划风险。 |
| v1.0.0 | `ob_list_capabilities` | 返回当前 MCP 能力、工具分组、版本和只读限制。 |
| v1.0.0 | `ob_prepare_query` | 基于可见元数据准备候选表、字段、SQL 草稿和安全预览，不执行查询。 |
| v1.0.0 | `ob_profile_table` | 返回受限样本内的表级画像、关键字段、空值概览和字段信号。 |
| v1.0.0 | `ob_query_next_page` | 基于查询上下文读取下一页，继续执行只读策略和行数限制。 |
| v1.0.0 | `ob_query_prev_page` | 基于查询上下文读取上一页，继续执行只读策略和行数限制。 |
| v1.0.0 | `ob_query_refine` | 基于查询上下文生成细化后的只读 SELECT，不执行 SQL。 |
| v1.0.0 | `ob_refresh_metadata_cache` | 按 profile、schema 或 table 清理内存元数据缓存。 |
| v1.0.0 | `ob_rewrite_sql` | 将 SELECT/WITH 改写为更安全的只读形式，不执行 SQL。 |
| v1.0.0 | `ob_search_everything` | 统一搜索 schema、表、字段、注释和业务词，并返回依据。 |
| v1.0.0 | `ob_start_query_session` | 创建内存查询上下文，记录表、字段、SQL、分页和警告。 |
| v1.0.0 | `ob_summarize_result` | 汇总已返回结果，不额外读取数据库。 |
| v1.0.0 | `ob_validate_sql_snippet` | 校验贴入 SQL 的只读策略、方言、分页、风险和可见表字段。 |
| v1.1.0 | `ob_analyze_change_sql_impact` | 基于元数据 diff 和 SQL 使用索引分析项目 SQL 影响。 |
| v1.1.0 | `ob_analyze_metadata_impact` | 基于快照 diff、SQL 使用索引、关系和业务字典汇总影响面。 |
| v1.1.0 | `ob_capture_metadata_snapshot` | 采集受限的纯元数据快照，不读取业务数据。 |
| v1.1.0 | `ob_compare_metadata_snapshots` | 对比两份元数据快照，返回基于证据的结构变化。 |
| v1.1.0 | `ob_find_sql_usages` | 从静态 SQL 使用索引中查找表、字段或业务词引用。 |
| v1.1.0 | `ob_generate_metadata_change_report` | 基于 diff 和影响分析生成 Markdown 或简版 HTML 变更报告。 |
| v1.1.1 | `ob_plan_er_export` | 轻量估算大 schema 表、字段和关系规模，并规划本地 ER HTML 分片导出命令。 |

## 元数据变更流程

迭代开始和结束各采集一次元数据快照，再结合项目 SQL 使用索引生成影响报告：

```bash
ob-mcp metadata snapshot --schema biz_test --out snapshots/before.json
ob-mcp scan-sql --path src --path mapper --index-out snapshots/sql-index.json --format text
ob-mcp metadata snapshot --schema biz_test --out snapshots/after.json
ob-mcp metadata diff --before snapshots/before.json --after snapshots/after.json --format markdown --out snapshots/diff.md
ob-mcp metadata report --before snapshots/before.json --after snapshots/after.json --sql-index snapshots/sql-index.json --format markdown --out snapshots/report.md
```

这些命令只读取元数据或本地项目文件，不执行数据库变更。报告只输出风险、证据和评审建议，不输出可直接执行的 DDL。

## 内网编译

Release 附带源码归档，适合放入内网后通过内部 npm 制品库编译运行：

```bash
tar -xzf ob-mcp-1.1.2-source.tar.gz
cd ob-mcp-1.1.2
npm ci
npm run build
npm run start
```

源码归档不包含 `node_modules` 和 `dist`。内网 npm 制品库需要能提供 `package-lock.json` 中锁定的依赖。

## Release 资产

| 资产 | 用途 |
| --- | --- |
| `ob-mcp-1.1.2.tgz` | npm 包。 |
| `ob-mcp-1.1.2-source.tar.gz` | 源码归档，用于内网编译。 |
| `sbom.cdx.json` | CycloneDX SBOM。 |
| `oceanbase-mcp-1.1.2-amd64.tar.gz` | amd64 离线镜像。 |
| `oceanbase-mcp-1.1.2-arm64.tar.gz` | arm64 离线镜像。 |
| `ghcr.io/sevoniva/oceanbase-mcp:v1.1.2` | GHCR 镜像 tag。 |

## 资源

| 资源 | 用途 |
| --- | --- |
| `ob://connection` | 默认 profile 的脱敏连接配置。 |
| `ob://profiles` | 全部 profile 的脱敏配置。 |
| `ob://profile/{profile}/schema/{schema}/table/{table}` | 经过策略过滤的表结构。 |

## 验证

```bash
npm test
npm run smoke
npm run mcp:smoke
npm run http:smoke
npm audit --omit=dev --audit-level=moderate
npm pack --dry-run
```

Oracle 模式验证：

```bash
npm run mcp:smoke:oracle
npm run http:smoke:oracle
```

Docker 和 Kubernetes 的验证步骤见 [deployment.md](deployment.md)。
