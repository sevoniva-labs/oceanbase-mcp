# Configuration

[中文](../zh-CN/configuration.md) | [Back](README.md)

Configuration is provided through environment variables. `.env` is loaded automatically for local Node.js runs.

## Minimal Local Config

```bash
OB_HOST=127.0.0.1
OB_PORT=2883
OB_USER=ob_user@ob_mysql#obcluster
OB_PASSWORD=ob_password
OB_COMPATIBILITY=mysql
OB_ALLOWED_SCHEMAS=biz_test
```

## Minimal Production Config

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

## Connection

| Variable | Default | Description |
| --- | --- | --- |
| `OB_HOST` | `127.0.0.1` | OceanBase or OBProxy host. |
| `OB_PORT` | `2883` | OBProxy port. |
| `OB_USER` | local default only | Full OceanBase user, for example `user@tenant#cluster`. Required in production. |
| `OB_USERNAME` | `ob_user` | Used only outside production when `OB_USER` is unset. |
| `OB_TENANT` | `ob_mysql` | Used only outside production when `OB_USER` is unset. |
| `OB_CLUSTER` | `obcluster` | Used only outside production when `OB_USER` is unset. |
| `OB_PASSWORD` | local default only | Direct password. Required in production unless `OB_PASSWORD_FILE` is set. |
| `OB_PASSWORD_FILE` | unset | File containing the database password. Recommended for deployment. |
| `OB_DATABASE` | unset | Optional default schema/database for MySQL mode. |
| `OB_COMPATIBILITY` | `mysql` | `mysql` or `oracle`. |
| `OB_CONNECTION_LIMIT` | `5` | Pool size. |
| `OB_CONNECT_TIMEOUT_MS` | `10000` | Connection timeout. |
| `OB_QUERY_TIMEOUT_MS` | `30000` | Per-query timeout. Also maps to OceanBase query timeout hints. |

## Read-Only And Policy

| Variable | Default | Description |
| --- | --- | --- |
| `OB_MCP_READ_ONLY` | `true` | Immutable read-only gateway flag. `false` is rejected. |
| `OB_DB_USER_READ_ONLY` | `false` | Declaration that the database account itself is read-only. Used for diagnostics. |
| `OB_PRODUCTION` | `false` | Enables production fail-closed checks. `NODE_ENV=production` also enables them. |
| `OB_ALLOWED_SCHEMAS` | unset | Comma-separated schema allowlist. Required in production unless `OB_ALLOWED_TABLES` is set. |
| `OB_ALLOWED_TABLES` | unset | Comma-separated table allowlist. Use `schema.table` or `schema.*`. |
| `OB_DENIED_SCHEMAS` | system schemas | Comma-separated denied schemas. |
| `OB_DENIED_TABLES` | unset | Comma-separated denied tables; glob-style `*` is supported. |
| `OB_DENIED_COLUMNS` | sensitive names | Comma-separated denied column/identifier names. |
| `OB_MASKED_COLUMNS` | unset | Comma-separated sample-output masking rules. Supports `schema.table.column`, `table.column`, `column`, and `*` globs. |
| `OB_BUSINESS_GLOSSARY_FILE` | unset | Optional business glossary JSON file used only for search hints. |
| `OB_ALLOW_SELECT_STAR` | `false` | Allows `SELECT *` only when explicitly set to `true`. |
| `OB_REQUIRE_ACCESS_POLICY` | production: `true` | Requires allowlist policy in production. |
| `OB_INCLUDE_SYSTEM_SCHEMAS` | `false` | Includes system schemas in metadata tools. |
| `OB_ENFORCE_READ_ONLY_TX` | `true` | Runs user SQL inside a database read-only transaction. |
| `OB_MAX_ROWS` | `100` | Hard row cap. Client `maxRows` or `limit` values cannot exceed it. |
| `OB_MAX_RESULT_BYTES` | `1048576` | Hard JSON response-size cap per tool call. |
| `OB_MAX_SQL_LENGTH` | `20000` | Maximum SQL text length. |
| `OB_MAX_PARAM_COUNT` | `500` | Maximum SQL parameter count. |
| `OB_MAX_CONCURRENT_QUERIES` | `5` | Maximum concurrent database operations per profile. |
| `OB_METADATA_CACHE_ENABLED` | `true` | Enables profile-scoped metadata caching. |
| `OB_METADATA_CACHE_TTL_MS` | `60000` | Metadata cache TTL. Only table, column, constraint, and relationship metadata is cached. |
| `OB_METADATA_CACHE_MAX_ENTRIES` | `500` | Maximum metadata cache entries per profile. |

## ER Diagram Limits

| Variable | Default | Description |
| --- | --- | --- |
| `OB_ER_TOTAL_TIMEOUT_MS` | `15000` | Total time budget for one ER generation request. Timeout returns partial results and warnings. |
| `OB_ER_QUERY_TIMEOUT_MS` | `5000` | Per-query timeout for ER metadata reads. |
| `OB_ER_MAX_TABLES` | `50` | Table-count cap for ER diagrams. The default is conservative; local use can raise it, with tool input capped at 500. |
| `OB_ER_MAX_COLUMNS_PER_TABLE` | `12` | Maximum columns returned per table in ER diagrams. |
| `OB_ER_MAX_RELATIONSHIPS` | `100` | Relationship-count cap for ER diagrams. |
| `OB_ER_INLINE_HTML_MAX_BYTES` | `262144` | Inline MCP HTML response cap. Use `ob-mcp export-er --out-dir` for chunked large-diagram export. |

Masking priority:

1. `OB_DENIED_COLUMNS` is strongest: matching columns are blocked from query output and hidden from metadata.
2. `OB_MASKED_COLUMNS` keeps the column visible in metadata but masks values in query output, table-context samples, and column profiles.
3. Built-in sensitive-name detection still masks values for fields such as password, token, secret, email, phone, and similar names.

Business glossary:

- `OB_BUSINESS_GLOSSARY_FILE` points to a JSON file. See [business-glossary.example.json](../../examples/business-glossary.example.json).
- The glossary only affects search hints from `ob_search_business_glossary` and `ob_search_catalog`; it does not grant database access.
- Glossary targets are still filtered by profile, schema, table, and column policy. Denied tables or columns are not returned.

Metadata cache:

- Cache entries are isolated per profile and are not shared across profiles.
- Only metadata such as table lists, columns, constraints, and relationships is cached. `ob_query`, sample rows, and user SQL results are not cached.
- Set `OB_METADATA_CACHE_ENABLED=false` when every metadata request must read the current database structure.

## HTTP Server

| Variable | Default | Description |
| --- | --- | --- |
| `OB_MCP_HOST` | `127.0.0.1` | HTTP bind host. Use `0.0.0.0` only behind a trusted boundary. |
| `OB_MCP_PORT` | `3000` | HTTP port. |
| `OB_MCP_PATH` | `/mcp` | MCP endpoint path. |
| `OB_MCP_AUTH_TOKEN` | unset | Bearer token for HTTP MCP. Required in production and any non-local bind. |
| `OB_MCP_AUTH_TOKEN_FILE` | unset | File containing the bearer token. |
| `OB_MCP_AUTH_TOKENS` | unset | JSON array of token policies with optional `profiles` and `tools` scopes. |
| `OB_MCP_AUTH_TOKENS_FILE` | unset | File containing the token-policy JSON array. |
| `OB_MCP_ALLOWED_HOSTS` | unset | Comma-separated allowed Host headers. Required for non-local binds. |
| `OB_MCP_ALLOWED_IPS` | unset | Comma-separated source IP/CIDR allowlist. Required for non-local binds. |
| `OB_MCP_TRUST_PROXY` | `false` | Reverse-proxy trust policy. Supports `false`, `true`, hop count such as `1`, `loopback`, or IP/CIDR entries. |
| `OB_MCP_METRICS_AUTH_REQUIRED` | production/non-local: `true` | Requires bearer auth for `/metrics`. |
| `OB_MCP_HEALTH_AUTH_REQUIRED` | `false` | Requires bearer auth for `/healthz`. Usually keep `false` for Kubernetes probes. |
| `OB_MCP_CLIENT_ID_HEADER` | `x-ob-mcp-client-id` | Request header copied into audit logs as the client id. |
| `OB_MCP_BODY_LIMIT` | `256kb` | Maximum JSON request body size. |
| `OB_MCP_RATE_LIMIT_WINDOW_MS` | `60000` | HTTP rate-limit window. |
| `OB_MCP_RATE_LIMIT_MAX` | `60` | Requests per rate-limit window. |

`OB_MCP_ALLOWED_IPS` accepts exact IPs and CIDR ranges:

```bash
OB_MCP_ALLOWED_IPS=127.0.0.1,10.0.0.0/8,203.0.113.10,2001:db8::/32
```

When behind Nginx or Kubernetes Ingress, prefer an explicit hop count or proxy CIDR:

```bash
OB_MCP_TRUST_PROXY=1
# or
OB_MCP_TRUST_PROXY=loopback,10.0.0.0/8
```

`OB_MCP_TRUST_PROXY=true` trusts all forwarded headers and should be used only when clients cannot bypass the trusted entrypoint.

Multiple HTTP tokens can be configured with JSON:

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

| Variable | Default | Description |
| --- | --- | --- |
| `OB_REQUIRE_TLS` | `false` | Requires SSL material for database connections. |
| `OB_SSL` | unset | Enables SSL without certificate files. |
| `OB_SSL_CA` | unset | CA certificate path. |
| `OB_SSL_CERT` | unset | Client certificate path. |
| `OB_SSL_KEY` | unset | Client key path. |
| `OB_SSL_REJECT_UNAUTHORIZED` | `true` | Verifies server certificate. |

HTTP TLS should normally terminate at Nginx, an ingress controller, or a cloud load balancer.

## Profiles

Use profiles to connect to multiple tenants or environments from one server.

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

Every MCP tool accepts an optional `profile` argument.

## Diagnostics

```bash
npm run config:doctor
```

The doctor checks credentials, read-only mode, access policy, HTTP auth, Host allowlist, source IP allowlist, rate limit, body limit, response-size caps, concurrency caps, and TLS posture.

Database account permissions can be checked through the MCP tool:

```text
ob_verify_permissions
```

It reads current grants/session privileges and reports write or administrative privileges if present.
