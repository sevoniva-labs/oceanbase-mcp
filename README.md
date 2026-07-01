# OceanBase MCP

[中文文档](docs/zh-CN/README.md) | [English Docs](docs/en/README.md)

OceanBase 只读 MCP 网关，用于 OpenCode 和其他 MCP 客户端安全查看 OceanBase。支持本地 stdio、远程 HTTP、MySQL/Oracle 模式、访问策略、来源 IP 限制、诊断、指标以及 Docker/Kubernetes 部署模板。

Read-only MCP gateway for OceanBase. It lets OpenCode and other MCP clients inspect OceanBase safely through explicit read-only tools, schema/table policy, HTTP authentication, source IP allowlists, diagnostics, metrics, and production deployment templates.

服务从设计上只读：没有写入工具，拒绝写入/控制 SQL，默认阻止 `SELECT *`，用户 SQL 默认走只读事务，并且 `OB_MCP_READ_ONLY=false` 会直接启动失败。

OceanBase MCP is read-only by design. It has no write tool, rejects write/control SQL, blocks `SELECT *` by default, runs user SQL in read-only transactions, and refuses to start when `OB_MCP_READ_ONLY=false`.

## Documentation / 文档

| Topic | 中文 | English |
| --- | --- | --- |
| Start here | [快速开始](docs/zh-CN/README.md) | [Quick start](docs/en/README.md) |
| OpenCode | [接入 OpenCode](docs/zh-CN/opencode.md) | [OpenCode setup](docs/en/opencode.md) |
| Configuration | [配置说明](docs/zh-CN/configuration.md) | [Configuration](docs/en/configuration.md) |
| Deployment | [部署指南](docs/zh-CN/deployment.md) | [Deployment](docs/en/deployment.md) |
| Architecture | [架构说明](docs/zh-CN/architecture.md) | [Architecture](docs/en/architecture.md) |
| Security | [安全基线](docs/zh-CN/security.md) | [Security baseline](docs/en/security.md) |
| Examples | [示例索引](examples/README.zh-CN.md) | [Examples](examples/README.en.md) |

## Capabilities / 能力

- MySQL and Oracle compatibility modes for OceanBase tenants.
- Local stdio MCP server for OpenCode desktop/local workflows.
- Streamable HTTP MCP server for shared or remote deployments.
- Multiple profiles for dev, staging, production, tenants, or clusters.
- Schema/table allowlist, denied system schemas, denied sensitive columns, hard row/response caps, and masked sample rows.
- Source IP allowlist with exact IP and CIDR entries through `OB_MCP_ALLOWED_IPS`.
- HTTP bearer token policies, Host allowlist, body limit, endpoint auth, and rate limiting.
- Health endpoint, Prometheus metrics, JSON audit logs, and config diagnostics.
- Database grant verification through a read-only permission check tool.
- Docker, Docker Compose, Kubernetes, Nginx, systemd, and local macOS/Linux/Windows client examples.
- GitHub Actions for CI, tagged releases, GHCR multi-architecture images, and offline image archives.

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

Use `OB_MCP_HOST=0.0.0.0` only behind TLS/reverse proxy or a trusted network boundary. Non-local HTTP binds require `OB_MCP_AUTH_TOKEN`, `OB_MCP_ALLOWED_HOSTS`, and `OB_MCP_ALLOWED_IPS`.

## Tools / 工具

| Tool | Purpose |
| --- | --- |
| `ob_list_profiles` | List configured profiles with secrets redacted. |
| `ob_config_diagnostics` | Report deployment and policy checks. |
| `ob_verify_permissions` | Check current database grants for write/admin privileges. |
| `ob_ping` | Verify the OceanBase connection. |
| `ob_policy_explain` | Explain whether SQL would be allowed. |
| `ob_query` | Run strict read-only SQL. |
| `ob_list_schemas` | List visible schemas/databases. |
| `ob_list_tables` | List visible tables. |
| `ob_describe_table` | Return column metadata. |
| `ob_explain` | Run `EXPLAIN` for read-only SQL. |
| `ob_analyze_query_plan` | Run `EXPLAIN` and return evidence-based plan findings. |
| `ob_search_catalog` | Search schemas, tables, and columns. |
| `ob_list_objects` | List policy-filtered Oracle views, sequences, synonyms, procedures, functions, and packages. |
| `ob_get_object_metadata` | Return bounded metadata and source preview for one Oracle object. |
| `ob_get_table_schema` | Return policy-filtered table schema. |
| `ob_get_table_ddl` | Return native or structured table DDL metadata. |
| `ob_find_related_tables` | Find foreign-key and conservative naming-based table relationships. |
| `ob_get_table_stats` | Return table row estimates, counts, and storage statistics. |
| `ob_generate_er_diagram` | Generate Mermaid and JSON ER metadata from allowed tables. |
| `ob_get_indexes` | Return table index metadata. |
| `ob_get_constraints` | Return primary, unique, foreign-key, check, and not-null constraints. |
| `ob_get_partitions` | Return table partition metadata. |
| `ob_sample_rows` | Return masked, explicit-column sample rows. |

## Validation / 验证

```bash
npm test
npm run smoke
npm run mcp:smoke
npm run http:smoke
npm audit --omit=dev --audit-level=moderate
npm pack --dry-run
```

Oracle compatibility can be verified with:

```bash
npm run mcp:smoke:oracle
npm run http:smoke:oracle
```

See [docs/en/README.md](docs/en/README.md) or [docs/zh-CN/README.md](docs/zh-CN/README.md) for complete setup.
