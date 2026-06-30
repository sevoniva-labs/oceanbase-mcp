# OceanBase MCP

[中文](../zh-CN/README.md) | [Back to root](../../README.md)

OceanBase MCP is a read-only MCP gateway for OceanBase. It is designed for OpenCode and other MCP clients that need safe database inspection without exposing write capability.

## What It Does

- Connects to OceanBase through OBProxy or a MySQL protocol endpoint.
- Supports OceanBase MySQL and Oracle compatibility modes.
- Exposes only read-only MCP tools.
- Enforces schema/table allowlists, denied system schemas, denied sensitive columns, hard row/response caps, SQL length limits, and read-only transactions.
- Provides stdio mode for local development and HTTP mode for shared deployments.
- Protects HTTP mode with bearer token policies, Host allowlist, source IP allowlist, endpoint auth, body limits, and rate limiting.
- Provides a read-only database account permission verification tool.
- Ships Docker, Kubernetes, Nginx, systemd, and local OpenCode examples.

## Read-Only Contract

The server is read-only by design:

- There is no write-capable MCP tool.
- `OB_MCP_READ_ONLY=true` is the default and cannot be disabled.
- `OB_MCP_READ_ONLY=false` makes the server refuse to start.
- `ob_query` accepts only `SELECT`, `WITH`, and `EXPLAIN` for read-only SQL.
- `SELECT *`, multi-statement SQL, write/control keywords, executable comments, filesystem functions, sleeps, locks, and sequence `NEXTVAL` are blocked.
- User SQL runs in a database read-only transaction by default.

Even if `OB_USER` is a read-write database account, the MCP surface remains read-only. A database account with SELECT/metadata grants only is still recommended as defense in depth.

## Install

```bash
git clone https://github.com/sevoniva/oceanbase-mcp.git
cd oceanbase-mcp
npm install
npm run build
cp .env.example .env
npm run config:doctor
```

Node.js 20 or newer is required.

## Local OpenCode Use

The included [opencode.jsonc](../../opencode.jsonc) runs the stdio MCP server from the current project.

```bash
npm run build
opencode mcp list
```

Expected result:

```text
oceanbase connected
```

Run a simple read:

```bash
opencode run "Use the oceanbase MCP server to run SELECT 1 AS ok and return only the result."
```

More examples:

- [OpenCode setup](opencode.md)
- [Configuration](configuration.md)
- [Deployment](deployment.md)
- [Architecture](architecture.md)
- [Security baseline](security.md)
- [Example files](../../examples/README.en.md)

## Run Modes

### Stdio

Use stdio for local IDE or OpenCode integration:

```bash
npm run start
```

### HTTP

Use HTTP for shared deployments:

```bash
OB_MCP_AUTH_TOKEN="change-me-long-random-token" \
OB_MCP_ALLOWED_IPS="127.0.0.1" \
npm run start:http
```

When binding to a non-local interface such as `0.0.0.0`, the server requires:

- `OB_MCP_AUTH_TOKEN` or `OB_MCP_AUTH_TOKEN_FILE`
- `OB_MCP_ALLOWED_HOSTS`
- `OB_MCP_ALLOWED_IPS`

## Tools

| Tool | Purpose |
| --- | --- |
| `ob_list_profiles` | List configured profiles with secrets redacted. |
| `ob_config_diagnostics` | Report deployment and policy checks. |
| `ob_verify_permissions` | Check current database grants for write or administrative privileges. |
| `ob_ping` | Verify the OceanBase connection. |
| `ob_policy_explain` | Explain whether SQL would be allowed. |
| `ob_query` | Run strict read-only SQL. |
| `ob_list_schemas` | List visible schemas/databases. |
| `ob_list_tables` | List visible tables. |
| `ob_describe_table` | Return column metadata. |
| `ob_explain` | Run `EXPLAIN` for read-only SQL. |
| `ob_search_catalog` | Search schemas, tables, and columns. |
| `ob_get_table_schema` | Return policy-filtered table schema. |
| `ob_get_indexes` | Return table index metadata. |
| `ob_get_constraints` | Return primary, unique, foreign-key, check, and not-null constraints. |
| `ob_get_partitions` | Return table partition metadata. |
| `ob_sample_rows` | Return masked, explicit-column sample rows. |

## Resources

| Resource | Purpose |
| --- | --- |
| `ob://connection` | Redacted default profile settings. |
| `ob://profiles` | Redacted settings for all profiles. |
| `ob://profile/{profile}/schema/{schema}/table/{table}` | Policy-filtered table schema. |

## Verify

```bash
npm test
npm run smoke
npm run mcp:smoke
npm run http:smoke
npm audit --omit=dev --audit-level=moderate
npm pack --dry-run
```

Oracle compatibility:

```bash
npm run mcp:smoke:oracle
npm run http:smoke:oracle
```

See [deployment.md](deployment.md) for Docker and Kubernetes validation steps.
