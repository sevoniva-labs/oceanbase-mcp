# Security Baseline

[中文](../zh-CN/security.md) | [Back](README.md)

## Boundary

OceanBase MCP is a read-only gateway between an MCP client and OceanBase. It protects data inspection workflows; it is not a database firewall and should not replace OceanBase account permissions.

Use both layers:

- MCP layer: no write tools, SQL guards, policy checks, row limits, output filtering.
- Database layer: least-privileged account with SELECT/metadata grants where possible.

## Controls

| Control | Status |
| --- | --- |
| No write tool | Always enforced. |
| Immutable read-only mode | `OB_MCP_READ_ONLY=false` is rejected. |
| SQL start keyword allowlist | Only `SELECT`, `WITH`, and read-only `EXPLAIN`. |
| Multi-statement block | Enabled. |
| `SELECT *` block | Enabled by default. |
| System schema denial | Enabled by default. |
| Sensitive column denial | Enabled by default. |
| Read-only transaction | Enabled by default. |
| Row cap | Enabled by default. |
| HTTP bearer token | Required in production HTTP and non-local bind. |
| Host allowlist | Required for non-local bind. |
| Source IP allowlist | Required for non-local bind. |
| Rate limit and body limit | Enabled by default. |
| Secret file loading | Supported for database password and bearer token. |

## Source IP Allowlist

Configure exact IP addresses and CIDR ranges:

```bash
OB_MCP_ALLOWED_IPS=203.0.113.10,10.0.0.0/8,2001:db8::/32
```

When the server is behind a trusted proxy:

```bash
OB_MCP_TRUST_PROXY=true
```

Only enable proxy trust when the MCP server cannot be reached directly by untrusted clients.

## Production Recommendations

- Bind MCP HTTP to `127.0.0.1` and put Nginx, Ingress, or a load balancer in front.
- Use TLS at the edge.
- Set `OB_MCP_AUTH_TOKEN_FILE` instead of inline tokens.
- Set `OB_PASSWORD_FILE` instead of inline database passwords.
- Use `OB_ALLOWED_SCHEMAS` or schema-qualified `OB_ALLOWED_TABLES`.
- Keep `OB_ALLOW_SELECT_STAR=false`.
- Keep `OB_ENFORCE_READ_ONLY_TX=true`.
- Prefer a database account with only SELECT/metadata grants.
- Collect JSON logs and scrape `/metrics`.

## What Is Intentionally Not Supported

- Write SQL execution.
- Schema changes.
- Stored procedure calls.
- File import/export functions.
- `SHOW` and `DESCRIBE` through `ob_query`; use metadata tools instead.
- Disabling MCP read-only mode.

## Verification

```bash
npm test
npm run mcp:smoke
npm run http:smoke
npm audit --omit=dev --audit-level=moderate
```

The HTTP smoke verifies unauthenticated requests return `401` and disallowed source IPs return `403`.
