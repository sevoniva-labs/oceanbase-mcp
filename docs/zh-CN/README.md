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

| 工具 | 用途 |
| --- | --- |
| `ob_list_profiles` | 列出已配置 profile，并隐藏敏感信息。 |
| `ob_config_diagnostics` | 输出部署和策略诊断。 |
| `ob_verify_permissions` | 检查当前数据库账号是否包含写入或管理权限。 |
| `ob_ping` | 验证 OceanBase 连接。 |
| `ob_policy_explain` | 解释 SQL 是否会被允许。 |
| `ob_query_preview` | 执行前预览只读策略和执行计划风险，不返回数据。 |
| `ob_query` | 执行严格只读 SQL。 |
| `ob_query_page` | 执行带分页的只读查询。 |
| `ob_list_schemas` | 列出可见 schema/database。 |
| `ob_list_tables` | 列出可见表。 |
| `ob_describe_table` | 返回列元数据。 |
| `ob_explain` | 对只读 SQL 执行 `EXPLAIN`。 |
| `ob_analyze_query_plan` | 执行 `EXPLAIN` 并返回基于证据的执行计划分析。 |
| `ob_generate_performance_report` | 基于 EXPLAIN 和元数据生成只读性能建议报告。 |
| `ob_search_catalog` | 搜索 schema、表和列。 |
| `ob_list_objects` | 列出经过策略过滤的 Oracle view、sequence、synonym、procedure、function 和 package。 |
| `ob_get_object_metadata` | 返回单个 Oracle 对象的有限元数据和源码预览。 |
| `ob_get_table_schema` | 返回经过策略过滤的表结构。 |
| `ob_get_table_ddl` | 返回表的原生或结构化 DDL 元数据。 |
| `ob_get_table_context` | 返回写 SQL 和查数据常用的表上下文。 |
| `ob_find_related_tables` | 查找外键关系和保守的命名推断表关系。 |
| `ob_get_table_stats` | 返回表行数估算、对象计数和存储统计。 |
| `ob_profile_columns` | 返回受限样本内的字段画像，并对敏感值脱敏。 |
| `ob_generate_query` | 基于表元数据生成只读 SQL 模板。 |
| `ob_generate_er_diagram` | 基于允许访问的表生成 Mermaid 和 JSON ER 元数据。 |
| `ob_get_indexes` | 返回表索引元数据。 |
| `ob_get_constraints` | 返回主键、唯一键、外键、check 和 not-null 约束。 |
| `ob_get_partitions` | 返回表分区元数据。 |
| `ob_sample_rows` | 返回显式列样例数据，并默认脱敏。 |

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
