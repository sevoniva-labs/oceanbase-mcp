# 配置说明

[English](../en/configuration.md) | [返回](README.md)

配置通过环境变量提供。本地 Node.js 运行时会自动加载 `.env`。

## 最小本地配置

```bash
OB_HOST=127.0.0.1
OB_PORT=2883
OB_USER=ob_user@ob_mysql#obcluster
OB_PASSWORD=ob_password
OB_COMPATIBILITY=mysql
OB_ALLOWED_SCHEMAS=biz_test
```

## 最小生产配置

```bash
NODE_ENV=production
OB_HOST=your-obproxy.example.com
OB_PORT=2883
OB_USER=readonly_user@tenant#cluster
OB_PASSWORD_FILE=/run/secrets/ob_password
OB_COMPATIBILITY=mysql
OB_PRODUCTION=true
OB_MCP_READ_ONLY=true
OB_DB_USER_READ_ONLY=true
OB_ALLOWED_SCHEMAS=app_schema
OB_ALLOW_SELECT_STAR=false
OB_ENFORCE_READ_ONLY_TX=true
OB_MAX_ROWS=100
OB_MAX_RESULT_BYTES=1048576
OB_MAX_CONCURRENT_QUERIES=5
OB_MCP_HOST=127.0.0.1
OB_MCP_PORT=3000
OB_MCP_PATH=/mcp
OB_MCP_AUTH_TOKEN_FILE=/run/secrets/ob_mcp_auth_token
OB_MCP_ALLOWED_IPS=127.0.0.1,10.0.0.0/8
```

## 连接配置

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `OB_HOST` | `127.0.0.1` | OceanBase 或 OBProxy 地址。 |
| `OB_PORT` | `2883` | OBProxy 端口。 |
| `OB_USER` | 仅本地默认 | OceanBase 完整用户名，例如 `user@tenant#cluster`。生产必填。 |
| `OB_USERNAME` | `ob_user` | 仅在非生产且未设置 `OB_USER` 时使用。 |
| `OB_TENANT` | `ob_mysql` | 仅在非生产且未设置 `OB_USER` 时使用。 |
| `OB_CLUSTER` | `obcluster` | 仅在非生产且未设置 `OB_USER` 时使用。 |
| `OB_PASSWORD` | 仅本地默认 | 直接密码。生产环境必须设置它或 `OB_PASSWORD_FILE`。 |
| `OB_PASSWORD_FILE` | 未设置 | 保存数据库密码的文件。部署环境推荐使用。 |
| `OB_DATABASE` | 未设置 | MySQL 模式下的默认 database/schema。 |
| `OB_COMPATIBILITY` | `mysql` | `mysql` 或 `oracle`。 |
| `OB_CONNECTION_LIMIT` | `5` | 连接池大小。 |
| `OB_CONNECT_TIMEOUT_MS` | `10000` | 连接超时。 |
| `OB_QUERY_TIMEOUT_MS` | `30000` | 单次查询超时，也会映射为 OceanBase query timeout hint。 |

## 只读与访问策略

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `OB_MCP_READ_ONLY` | `true` | MCP 网关只读开关，不可关闭。设置为 `false` 会启动失败。 |
| `OB_DB_USER_READ_ONLY` | `false` | 声明数据库账号本身是只读账号，用于诊断。 |
| `OB_PRODUCTION` | `false` | 启用生产 fail-closed 检查。`NODE_ENV=production` 也会启用。 |
| `OB_ALLOWED_SCHEMAS` | 未设置 | schema allowlist。生产环境必须设置它或 `OB_ALLOWED_TABLES`。 |
| `OB_ALLOWED_TABLES` | 未设置 | table allowlist。使用 `schema.table` 或 `schema.*`。 |
| `OB_DENIED_SCHEMAS` | 系统 schema | 被拒绝的 schema 列表。 |
| `OB_DENIED_TABLES` | 未设置 | 被拒绝的表列表，支持 `*`。 |
| `OB_DENIED_COLUMNS` | 敏感名称 | 被拒绝的列名/标识符列表。 |
| `OB_MASKED_COLUMNS` | 未设置 | 样例输出脱敏规则，支持 `schema.table.column`、`table.column`、`column` 和 `*` 通配。 |
| `OB_BUSINESS_GLOSSARY_FILE` | 未设置 | 可选业务字典 JSON 文件，仅用于搜索提示。 |
| `OB_ALLOW_SELECT_STAR` | `false` | 只有显式设为 `true` 才允许 `SELECT *`。 |
| `OB_REQUIRE_ACCESS_POLICY` | 生产：`true` | 生产环境要求配置 allowlist。 |
| `OB_INCLUDE_SYSTEM_SCHEMAS` | `false` | 元数据工具是否包含系统 schema。 |
| `OB_ENFORCE_READ_ONLY_TX` | `true` | 用户 SQL 是否放入数据库只读事务。 |
| `OB_MAX_ROWS` | `100` | 返回行数硬上限。客户端传入的 `maxRows` 或 `limit` 不能超过它。 |
| `OB_MAX_RESULT_BYTES` | `1048576` | 单次工具返回 JSON 大小硬上限，超出会拒绝返回。 |
| `OB_MAX_SQL_LENGTH` | `20000` | SQL 文本长度上限。 |
| `OB_MAX_PARAM_COUNT` | `500` | SQL 参数数量上限。 |
| `OB_MAX_CONCURRENT_QUERIES` | `5` | 每个 profile 同时执行的数据库操作上限。 |
| `OB_METADATA_CACHE_ENABLED` | `true` | 是否启用 profile 级元数据缓存。 |
| `OB_METADATA_CACHE_TTL_MS` | `60000` | 元数据缓存 TTL。仅缓存表结构、约束、关系等元数据。 |
| `OB_METADATA_CACHE_MAX_ENTRIES` | `500` | 每个 profile 的元数据缓存最大条目数。 |

## ER 图保护

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `OB_ER_TOTAL_TIMEOUT_MS` | `15000` | 单次 ER 生成总时间预算。超时返回部分结果和提示。 |
| `OB_ER_QUERY_TIMEOUT_MS` | `5000` | ER 元数据查询的单次超时。 |
| `OB_ER_MAX_TABLES` | `50` | ER 表数量上限。默认保守，可按本地机器资源调高，工具输入最大 500。 |
| `OB_ER_MAX_COLUMNS_PER_TABLE` | `12` | 每张表在 ER 图中返回的最大字段数。 |
| `OB_ER_MAX_RELATIONSHIPS` | `100` | ER 关系数量上限。 |
| `OB_ER_INLINE_HTML_MAX_BYTES` | `262144` | MCP inline HTML 返回大小上限。大图建议使用 `ob-mcp export-er --out-dir` 导出 cluster 目录。 |

脱敏优先级：

1. `OB_DENIED_COLUMNS` 最强：匹配的列会被禁止出现在查询结果中，也会从元数据里隐藏。
2. `OB_MASKED_COLUMNS` 不隐藏元数据，只对查询结果、表上下文样例和字段画像中的值做脱敏。
3. 内置敏感字段识别仍然会对 password、token、secret、email、phone 等名称做值脱敏。

业务字典：

- `OB_BUSINESS_GLOSSARY_FILE` 指向 JSON 文件，格式见 [business-glossary.example.json](../../examples/business-glossary.example.json)。
- 字典只影响 `ob_search_business_glossary` 和 `ob_search_catalog` 的搜索提示，不授予额外数据库访问权限。
- 字典目标仍会经过 profile、schema、table 和 column 策略过滤。被拒绝的表或字段不会出现在返回结果中。

元数据缓存：

- 缓存按 profile 隔离，不跨 profile 共享。
- 缓存只用于表清单、字段、约束和关系等元数据读取，不缓存 `ob_query`、样例数据或用户 SQL 结果。
- 如需要每次都读取最新结构，可设置 `OB_METADATA_CACHE_ENABLED=false`。

## 日志

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `OB_MCP_LOG_FILE` | 未设置 | 可选 JSONL 日志文件，记录审计、错误、慢调用、HTTP 限流和进程崩溃事件。 |
| `OB_MCP_LOG_STDERR` | `true` | 是否同时把 JSON 日志写到 stderr。启动器已收集日志文件时可关闭。 |
| `OB_MCP_SLOW_CALL_MS` | `3000` | 慢操作阈值，单位毫秒。设置为 `0` 可关闭慢调用日志。 |

本地 OpenCode 排查问题时建议开启：

```bash
OB_MCP_LOG_FILE=/var/log/ob-mcp/ob-mcp.jsonl
OB_MCP_SLOW_CALL_MS=1000
```

日志为 JSON lines。写入前会对疑似密码、token、密钥等字段和值做脱敏。

## HTTP 服务

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `OB_MCP_HOST` | `127.0.0.1` | HTTP 绑定地址。只有在可信边界后才使用 `0.0.0.0`。 |
| `OB_MCP_PORT` | `3000` | HTTP 端口。 |
| `OB_MCP_PATH` | `/mcp` | MCP endpoint 路径。 |
| `OB_MCP_AUTH_TOKEN` | 未设置 | HTTP MCP Bearer token。生产和非本地绑定必填。 |
| `OB_MCP_AUTH_TOKEN_FILE` | 未设置 | 保存 Bearer token 的文件。 |
| `OB_MCP_AUTH_TOKENS` | 未设置 | JSON 数组，配置多个 token 及其允许的 `profiles`、`tools`。 |
| `OB_MCP_AUTH_TOKENS_FILE` | 未设置 | 保存上述 JSON 数组的文件。 |
| `OB_MCP_ALLOWED_HOSTS` | 未设置 | 允许的 Host header，逗号分隔。非本地绑定必填。 |
| `OB_MCP_ALLOWED_IPS` | 未设置 | 来源 IP/CIDR allowlist，逗号分隔。非本地绑定必填。 |
| `OB_MCP_TRUST_PROXY` | `false` | 反向代理信任策略。支持 `false`、`true`、可信跳数（如 `1`）、`loopback` 或 IP/CIDR 列表。 |
| `OB_MCP_METRICS_AUTH_REQUIRED` | 生产/非本地：`true` | `/metrics` 是否要求 Bearer token。 |
| `OB_MCP_HEALTH_AUTH_REQUIRED` | `false` | `/healthz` 是否要求 Bearer token。Kubernetes probe 通常保持 `false`。 |
| `OB_MCP_CLIENT_ID_HEADER` | `x-ob-mcp-client-id` | 写入审计日志的客户端标识请求头。 |
| `OB_MCP_BODY_LIMIT` | `256kb` | JSON 请求体大小上限。 |
| `OB_MCP_RATE_LIMIT_WINDOW_MS` | `60000` | HTTP 限流窗口。 |
| `OB_MCP_RATE_LIMIT_MAX` | 本地：`600`；生产/非本地：`60` | 每个限流窗口内的请求上限。OpenCode 本地连续调用较多时可按需调高。 |

`OB_MCP_ALLOWED_IPS` 支持精确 IP 和 CIDR：

```bash
OB_MCP_ALLOWED_IPS=127.0.0.1,10.0.0.0/8,203.0.113.10,2001:db8::/32
```

部署在 Nginx 或 Kubernetes Ingress 后时，推荐使用明确跳数或代理网段，例如：

```bash
OB_MCP_TRUST_PROXY=1
# 或
OB_MCP_TRUST_PROXY=loopback,10.0.0.0/8
```

`OB_MCP_TRUST_PROXY=true` 会信任所有代理转发头，只适合客户端无法绕过可信入口的封闭网络。

多个 HTTP token 可使用 JSON 配置：

```json
[
  {
    "name": "readonly-app",
    "tokenFile": "/run/secrets/readonly_app_token",
    "profiles": ["prod"],
    "tools": ["ob_query", "ob_list_tables", "ob_describe_table"]
  }
]
```

## TLS

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `OB_REQUIRE_TLS` | `false` | 数据库连接必须配置 SSL。 |
| `OB_SSL` | 未设置 | 不提供证书文件时启用 SSL。 |
| `OB_SSL_CA` | 未设置 | CA 证书路径。 |
| `OB_SSL_CERT` | 未设置 | 客户端证书路径。 |
| `OB_SSL_KEY` | 未设置 | 客户端私钥路径。 |
| `OB_SSL_REJECT_UNAUTHORIZED` | `true` | 是否校验证书。 |

HTTP TLS 通常应由 Nginx、Ingress Controller 或云负载均衡终止。

## 多 Profile

profile 用于一个服务连接多个租户或环境。

```bash
OB_PROFILES=dev,prod
OB_DEFAULT_PROFILE=dev

OB_PROFILE_DEV_HOST=127.0.0.1
OB_PROFILE_DEV_USER=dev_user@dev_tenant#obcluster
OB_PROFILE_DEV_PASSWORD_FILE=/run/secrets/dev_ob_password
OB_PROFILE_DEV_ALLOWED_SCHEMAS=dev_app

OB_PROFILE_PROD_HOST=your-obproxy.example.com
OB_PROFILE_PROD_USER=readonly_user@prod_tenant#obcluster
OB_PROFILE_PROD_PASSWORD_FILE=/run/secrets/prod_ob_password
OB_PROFILE_PROD_PRODUCTION=true
OB_PROFILE_PROD_ALLOWED_SCHEMAS=app_schema
```

每个 MCP 工具都支持可选的 `profile` 参数。

## 配置诊断

```bash
npm run config:doctor
```

诊断会检查凭据、只读模式、访问策略、HTTP 认证、Host allowlist、来源 IP allowlist、限流、body 限制、返回大小、并发限制和 TLS 状态。

数据库账号权限可通过 MCP 工具核验：

```text
ob_verify_permissions
```

该工具只读取当前账号 grants/session privileges，用于确认账号是否仍带有写入或管理权限。
