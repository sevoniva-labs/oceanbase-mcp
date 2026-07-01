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

## Capabilities / 能力

| 中文 | English |
| --- | --- |
| 支持 OceanBase MySQL 模式和 Oracle 模式。 | Supports OceanBase MySQL and Oracle compatibility modes. |
| 支持本地 stdio 接入 OpenCode，也支持远程 Streamable HTTP 部署。 | Supports local stdio for OpenCode and remote Streamable HTTP deployments. |
| 提供 OpenCode agent 和 skill，引导模型按元数据优先、只读预览、分页查询的流程使用 MCP。 | Provides an OpenCode agent and skill for metadata-first, read-only query workflows. |
| 支持多 profile，用于不同环境、租户或集群。 | Supports multiple profiles for environments, tenants, or clusters. |
| 支持 schema/table allowlist、系统 schema 隐藏、敏感列拦截、字段级样例脱敏、行数和返回大小硬限制。 | Supports schema/table allowlists, system-schema hiding, sensitive-column blocking, field-level sample masking, and hard row/response limits. |
| 支持来源 IP allowlist、Bearer token 策略、Host allowlist、body 限制、端点鉴权和限流。 | Supports source IP allowlists, bearer-token policies, Host allowlists, body limits, endpoint auth, and rate limiting. |
| 提供健康检查、Prometheus 指标、JSON 审计日志、配置诊断和数据库账号权限核验。 | Provides health checks, Prometheus metrics, JSON audit logs, config diagnostics, and database permission verification. |
| 提供 Docker、Docker Compose、Kubernetes、Nginx、systemd 和本地客户端示例。 | Provides Docker, Docker Compose, Kubernetes, Nginx, systemd, and local client examples. |
| 提供 CI、tagged release、GHCR 多架构镜像和离线镜像归档流程。 | Provides CI, tagged releases, GHCR multi-architecture images, and offline image archives. |

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

| 工具 / Tool | 中文 | English |
| --- | --- | --- |
| `ob_list_profiles` | 列出 profile，并隐藏敏感信息。 | List configured profiles with secrets redacted. |
| `ob_config_diagnostics` | 输出部署和策略诊断。 | Report deployment and policy checks. |
| `ob_verify_permissions` | 检查数据库账号是否包含写入或管理权限。 | Check current database grants for write/admin privileges. |
| `ob_ping` | 验证 OceanBase 连接。 | Verify the OceanBase connection. |
| `ob_policy_explain` | 解释 SQL 是否会被允许。 | Explain whether SQL would be allowed. |
| `ob_query_preview` | 执行前预览只读策略和执行计划风险，不返回数据。 | Preview read-only policy and plan risk before execution, without returning data. |
| `ob_query` | 执行严格只读 SQL。 | Run strict read-only SQL. |
| `ob_query_page` | 执行带分页的只读查询。 | Run a paged read-only query. |
| `ob_list_schemas` | 列出可见 schema/database。 | List visible schemas/databases. |
| `ob_list_tables` | 列出可见表。 | List visible tables. |
| `ob_describe_table` | 返回列元数据。 | Return column metadata. |
| `ob_explain` | 对只读 SQL 执行 `EXPLAIN`。 | Run `EXPLAIN` for read-only SQL. |
| `ob_analyze_query_plan` | 返回基于证据的执行计划分析。 | Return evidence-based plan findings. |
| `ob_generate_performance_report` | 基于 EXPLAIN 和元数据生成只读性能建议报告。 | Generate a read-only performance advisory report from EXPLAIN and metadata. |
| `ob_search_catalog` | 搜索 schema、表和列。 | Search schemas, tables, and columns. |
| `ob_search_business_glossary` | 搜索业务词到 schema/table/column 的可见映射。 | Search visible business-term mappings to schemas, tables, and columns. |
| `ob_list_objects` | 列出经过策略过滤的 Oracle 对象。 | List policy-filtered Oracle views, sequences, synonyms, procedures, functions, and packages. |
| `ob_get_object_metadata` | 返回单个 Oracle 对象的有限元数据和源码预览。 | Return bounded metadata and source preview for one Oracle object. |
| `ob_get_table_schema` | 返回经过策略过滤的表结构。 | Return policy-filtered table schema. |
| `ob_get_table_ddl` | 返回表的原生或结构化 DDL 元数据。 | Return native or structured table DDL metadata. |
| `ob_get_table_context` | 返回写 SQL 和查数据常用的表上下文。 | Return common table context for SQL drafting and data inspection. |
| `ob_find_related_tables` | 查找外键关系和保守的命名推断关系。 | Find foreign-key and conservative naming-based table relationships. |
| `ob_get_table_stats` | 返回表行数估算、对象计数和存储统计。 | Return table row estimates, counts, and storage statistics. |
| `ob_profile_columns` | 返回受限样本内的字段画像，并对敏感值脱敏。 | Return bounded-sample column profiles with sensitive values masked. |
| `ob_generate_query` | 基于表元数据生成只读 SQL 模板。 | Generate read-only SQL templates from table metadata. |
| `ob_generate_er_diagram` | 基于允许访问的表生成 Mermaid 和 JSON ER 元数据。 | Generate Mermaid and JSON ER metadata from allowed tables. |
| `ob_get_indexes` | 返回表索引元数据。 | Return table index metadata. |
| `ob_get_constraints` | 返回主键、唯一键、外键、check 和 not-null 约束。 | Return primary, unique, foreign-key, check, and not-null constraints. |
| `ob_get_partitions` | 返回表分区元数据。 | Return table partition metadata. |
| `ob_sample_rows` | 返回显式列样例数据，并默认脱敏。 | Return masked, explicit-column sample rows. |

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
