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
- Oracle 模式支持查看 view、sequence、synonym、procedure、function、package 等对象元数据。
- 支持本地 stdio 模式，也支持共享部署的 HTTP 模式。
- HTTP 模式支持 Bearer token 策略、Host allowlist、来源 IP allowlist、端点鉴权、body 限制和限流。
- 提供数据库账号权限只读核验工具。
- 提供 Docker、Kubernetes、Nginx、systemd 和本地 OpenCode 示例。

## 功能版本

| 版本 | 功能 | 说明 |
| --- | --- | --- |
| v0.3.0 | 基础只读网关 | stdio 接入、OceanBase MySQL/Oracle 模式连接、只读 SQL 执行、schema/table 元数据、索引、约束、分区和脱敏样例数据。 |
| v0.3.0 | 基础 SQL 策略 | 拒绝写入/控制 SQL、多语句、危险函数和默认 `SELECT *`；限制行数、SQL 长度和返回大小。 |
| v0.4.0 | 生产部署硬化 | HTTP 模式、Bearer token、Host allowlist、来源 IP allowlist、body 限制、限流、健康检查、Prometheus 指标和 JSON 审计日志。 |
| v0.4.0 | 上线前诊断 | 数据库账号权限核验和更完整的配置诊断，用于确认只读边界。 |
| v0.5.0 | 开发辅助元数据 | 表 DDL、表统计、Oracle 对象元数据、相关表发现和 ER 图生成。 |
| v0.5.0 | SQL 辅助 | 只读 SQL 模板、执行计划分析和基于证据的性能建议报告。 |
| v0.5.0 | 字段级脱敏增强 | 支持精确字段匹配、通配匹配和自动敏感字段识别。 |
| v0.5.1 | OpenCode Agent/Skill | 约束查询流程为先查元数据、生成只读 SQL、执行前预览风险、分页查询、总结结果。 |
| v0.5.1 | 查询体验增强 | 表上下文、查询预览、分页查询、列元数据、Markdown 预览、结果警告和结构化错误提示。 |
| v0.5.1 | 字段画像和业务字典 | 受限字段分布分析，以及业务词到 schema/table/column 的可见映射。 |
| v0.5.1 | Release 交付补齐 | npm 包、SBOM、amd64/arm64 离线镜像和源码归档，便于内网编译部署。 |
| v1.0.0 | 本地初始化和能力发现 | 生成本地配置、检查 OpenCode 接入、提供 MCP 使用指南和工具能力清单。 |
| v1.0.0 | 项目 SQL 辅助 | 扫描本地 SQL 片段，报告只读风险、分页风险和动态 SQL 提示，不修改业务文件。 |

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

| 工具 | 版本 | 用途 |
| --- | --- | --- |
| `ob_list_profiles` | v0.3.0 | 列出已配置 profile，并隐藏敏感信息。 |
| `ob_config_diagnostics` | v0.3.0 | 输出部署和策略诊断。 |
| `ob_ping` | v0.3.0 | 验证 OceanBase 连接。 |
| `ob_policy_explain` | v0.3.0 | 解释 SQL 是否会被允许。 |
| `ob_query` | v0.3.0 | 执行严格只读 SQL；v0.5.1 起返回列元数据、Markdown 预览和警告。 |
| `ob_list_schemas` | v0.3.0 | 列出可见 schema/database。 |
| `ob_list_tables` | v0.3.0 | 列出可见表。 |
| `ob_describe_table` | v0.3.0 | 返回列元数据。 |
| `ob_explain` | v0.3.0 | 对只读 SQL 执行 `EXPLAIN`。 |
| `ob_search_catalog` | v0.3.0 | 搜索 schema、表和列；v0.5.1 起可合并业务字典命中。 |
| `ob_get_table_schema` | v0.3.0 | 返回经过策略过滤的表结构。 |
| `ob_get_indexes` | v0.3.0 | 返回表索引元数据。 |
| `ob_get_constraints` | v0.3.0 | 返回主键、唯一键、外键、check 和 not-null 约束。 |
| `ob_get_partitions` | v0.3.0 | 返回表分区元数据。 |
| `ob_sample_rows` | v0.3.0 | 返回显式列样例数据，并默认脱敏。 |
| `ob_verify_permissions` | v0.4.0 | 检查当前数据库账号是否包含写入或管理权限。 |
| `ob_analyze_query_plan` | v0.5.0 | 执行 `EXPLAIN` 并返回基于证据的执行计划分析。 |
| `ob_generate_performance_report` | v0.5.0 | 基于 EXPLAIN 和元数据生成只读性能建议报告。 |
| `ob_list_objects` | v0.5.0 | 列出经过策略过滤的 Oracle view、sequence、synonym、procedure、function 和 package。 |
| `ob_get_object_metadata` | v0.5.0 | 返回单个 Oracle 对象的有限元数据和源码预览。 |
| `ob_get_table_ddl` | v0.5.0 | 返回表的原生或结构化 DDL 元数据。 |
| `ob_find_related_tables` | v0.5.0 | 查找外键关系和保守的命名推断表关系。 |
| `ob_get_table_stats` | v0.5.0 | 返回表行数估算、对象计数和存储统计。 |
| `ob_generate_query` | v0.5.0 | 基于表元数据生成只读 SQL 模板。 |
| `ob_generate_er_diagram` | v0.5.0 | 基于允许访问的表生成 Mermaid 和 JSON ER 元数据；v1.0.0 增强业务词、表清单、深度、置信度和推断关系控制。 |
| `ob_query_preview` | v0.5.1 | 执行前预览只读策略和执行计划风险，不返回数据。 |
| `ob_query_page` | v0.5.1 | 执行带分页的只读查询。 |
| `ob_search_business_glossary` | v0.5.1 | 搜索业务词到 schema/table/column 的可见映射。 |
| `ob_get_table_context` | v0.5.1 | 返回写 SQL 和查数据常用的表上下文。 |
| `ob_profile_columns` | v0.5.1 | 返回受限样本内的字段画像；v1.0.0 起包含类型策略和枚举候选信号。 |
| `ob_check_opencode_setup` | v1.0.0 | 检查本地 OpenCode 配置、OceanBase agent 和查询 skill。 |
| `ob_get_usage_guide` | v1.0.0 | 返回 OpenCode 推荐工作流、只读规则和 MySQL/Oracle 差异。 |
| `ob_list_capabilities` | v1.0.0 | 返回当前 MCP 能力、工具分组、版本和只读限制。 |
| `ob_start_query_session` | v1.0.0 | 创建内存查询上下文，记录表、字段、SQL、分页和警告。 |
| `ob_get_query_session` | v1.0.0 | 读取查询上下文，不暴露已存参数值。 |
| `ob_close_query_session` | v1.0.0 | 关闭内存查询上下文。 |
| `ob_query_next_page` | v1.0.0 | 基于查询上下文读取下一页，继续执行只读策略和行数限制。 |
| `ob_query_prev_page` | v1.0.0 | 基于查询上下文读取上一页，继续执行只读策略和行数限制。 |
| `ob_query_refine` | v1.0.0 | 基于查询上下文生成细化后的只读 SELECT，不执行 SQL。 |
| `ob_summarize_result` | v1.0.0 | 汇总已返回结果，不额外读取数据库。 |
| `ob_compare_query_results` | v1.0.0 | 比较两份已返回结果，不额外读取数据库。 |
| `ob_export_result_preview` | v1.0.0 | 生成 Markdown/CSV 结果预览字符串，不落盘。 |
| `ob_get_schema_map` | v1.0.0 | 返回紧凑的 schema、表、关键字段和关系摘要。 |
| `ob_get_database_dictionary` | v1.0.0 | 基于可见元数据生成受限 JSON 或 Markdown 数据字典。 |
| `ob_search_everything` | v1.0.0 | 统一搜索 schema、表、字段、注释和业务词，并返回依据。 |
| `ob_find_tables_by_business_term` | v1.0.0 | 按业务词返回候选表、依据和关联表摘要。 |
| `ob_find_columns` | v1.0.0 | 按字段名、注释、类型、表名模式或业务词查找字段。 |
| `ob_get_table_summary` | v1.0.0 | 汇总单表用途推断、关键字段、关系和查询入口。 |
| `ob_compare_tables` | v1.0.0 | 比较两张表的字段、索引、约束和分区差异。 |
| `ob_compare_schemas` | v1.0.0 | 比较两个 schema 的表清单和受限表结构差异。 |
| `ob_profile_table` | v1.0.0 | 返回受限样本内的表级画像、关键字段、空值概览和字段信号。 |
| `ob_get_value_distribution` | v1.0.0 | 返回单个可见字段的受限 top value 分布。 |
| `ob_detect_time_columns` | v1.0.0 | 基于元数据识别创建、更新和业务时间字段。 |
| `ob_detect_dimension_columns` | v1.0.0 | 基于元数据识别状态、类型、渠道、地区等维度字段。 |
| `ob_find_recent_rows` | v1.0.0 | 基于明确或识别出的时间字段分页查看最近数据。 |
| `ob_check_data_quality` | v1.0.0 | 受限采样检查空值、重复键风险、维度和时间字段异常。 |
| `ob_prepare_query` | v1.0.0 | 基于可见元数据准备候选表、字段、SQL 草稿和安全预览，不执行查询。 |
| `ob_build_select` | v1.0.0 | 用经过校验的结构化输入生成参数化只读 SELECT。 |
| `ob_lint_sql` | v1.0.0 | 检查只读 SQL 的策略、方言、分页、排序、敏感字段和计划风险。 |
| `ob_validate_sql_snippet` | v1.0.0 | 校验贴入 SQL 的只读策略、方言、分页、风险和可见表字段。 |
| `ob_explain_project_query` | v1.0.0 | 解释项目 SQL 的表、字段、过滤、分页和风险，不执行查询。 |
| `ob_rewrite_sql` | v1.0.0 | 将 SELECT/WITH 改写为更安全的只读形式，不执行 SQL。 |
| `ob_convert_sql_dialect` | v1.0.0 | 在 OceanBase MySQL/Oracle 模式间转换只读 SQL，并标明限制。 |
| `ob_explain_error` | v1.0.0 | 结合策略和可见元数据解释 SQL 错误，不执行 SQL。 |
| `ob_generate_query_examples` | v1.0.0 | 基于表上下文生成常用只读查询示例，不执行 SQL。 |
| `ob_generate_er_html` | v1.0.0 | 基于允许访问的元数据和关系证据生成静态、交互、紧凑或详细版自包含 HTML ER 图。 |
| `ob_generate_entity_diagram` | v1.0.0 | 围绕业务词或表名生成局部实体图，返回 Mermaid、JSON、HTML 和关系依据。 |
| `ob_explain_relationship` | v1.0.0 | 解释两张表之间可见关系的字段依据、约束依据、命名依据和置信度。 |
| `ob_generate_er_document` | v1.0.0 | 基于允许访问的元数据和关系证据生成 Markdown、PlantUML 和 DOT 模型文档。 |

## Oracle 对象元数据

`ob_list_objects` 和 `ob_get_object_metadata` 支持 Oracle 兼容模式下的 `view`、`sequence`、`synonym`、`procedure`、`function`、`package` 和 `package_body`。对象名会使用和表元数据相同的 schema、对象名访问策略过滤。

procedure、function、package 的源码只返回有限预览，不返回不受限制的完整源码。源码预览有固定上限，输出前会按敏感字段名称做脱敏。synonym 元数据只有在当前数据库账号能从 `all_synonyms` 看到该 synonym 时才会返回。

## SQL 模板生成

`ob_generate_query` 会生成主键查询、分页查询、时间范围查询、聚合统计和关联表查询模板。输出包含 SQL 文本、参数说明、注意事项和策略检查结果；它不会执行生成的 SQL。

## 性能建议报告

`ob_generate_performance_report` 会执行只读 `EXPLAIN`，读取可见的表统计和索引元数据，并返回风险等级、证据和建议方向。它不会执行目标 SQL，也不会输出 DDL 或可直接执行的索引变更语句。

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
