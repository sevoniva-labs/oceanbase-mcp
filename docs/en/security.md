# Security Baseline

[中文](../zh-CN/security.md) | [Back](README.md)

## Boundary

OceanBase MCP is a read-only gateway between an MCP client and OceanBase. It protects data inspection workflows; it is not a database firewall and should not replace OceanBase account permissions.

Use both layers:

- MCP layer: no write tools, SQL guards, policy checks, row/response-size caps, concurrency caps, output filtering.
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
| Field-level value masking | `OB_MASKED_COLUMNS` supports exact column and wildcard rules. |
| Developer assistant tools | DDL, ER, SQL template, and performance-report tools only read metadata or run read-only `EXPLAIN`. |
| Metadata change analysis | Snapshot, diff, impact, and report tools read metadata or local files only and do not emit executable DDL. |
| Business glossary | Used only for search hints and filtered by access policy before return. |
| Read-only transaction | Enabled by default. |
| Row and response-size caps | Enabled by default and cannot be raised by clients. |
| Concurrency cap | Enabled per profile by default. |
| HTTP bearer token | Required in production HTTP and non-local bind; can be scoped by profile/tool. |
| Host allowlist | Required for non-local bind. |
| Source IP allowlist | Required for non-local bind. |
| `/metrics` auth | Enabled by default in production and non-local bind. |
| Rate limit and body limit | Enabled by default. |
| Secret file loading | Supported for database password and bearer token. |
| Database permission check | `ob_verify_permissions` reads grants/session privileges. |

## CI Security Checks

The `Security` GitHub Actions workflow runs:

- CodeQL with `security-extended` and `security-and-quality` queries.
- Semgrep `p/ci` rules as a blocking SAST gate.
- `npm audit` for all dependencies and production dependencies.
- OSV Scanner against `package-lock.json`.
- `secretlint` with the recommended rule preset.
- Repository policy checks for pinned GitHub Actions, workflow permissions, Docker base-image digest pinning, and npm package scope.

Local equivalents:

```bash
npm run security:gates
npm run security:secrets
npm run security:sca
semgrep --config p/ci --error --exclude node_modules --exclude dist --exclude .git --exclude output --exclude tmp .
```

## Source IP Allowlist

Configure exact IP addresses and CIDR ranges:

```bash
OB_MCP_ALLOWED_IPS=203.0.113.10,10.0.0.0/8,2001:db8::/32
```

When the server is behind a trusted proxy:

```bash
OB_MCP_TRUST_PROXY=1
```

Only enable proxy trust when the MCP server cannot be reached directly by untrusted clients. `true` trusts all forwarded headers; prefer a hop count or explicit proxy CIDR.

## Production Recommendations

- Bind MCP HTTP to `127.0.0.1` and put Nginx, Ingress, or a load balancer in front.
- Use TLS at the edge.
- Set `OB_MCP_AUTH_TOKEN_FILE` instead of inline tokens.
- Set `OB_PASSWORD_FILE` instead of inline database passwords.
- Use `OB_ALLOWED_SCHEMAS` or schema-qualified `OB_ALLOWED_TABLES`.
- Set `OB_MASKED_COLUMNS` when sample output needs field-level masking.
- Keep `OB_ALLOW_SELECT_STAR=false`.
- Keep `OB_ENFORCE_READ_ONLY_TX=true`.
- Set `OB_MAX_ROWS`, `OB_MAX_RESULT_BYTES`, and `OB_MAX_CONCURRENT_QUERIES`.
- Prefer a database account with only SELECT/metadata grants.
- Run `ob_verify_permissions` for the configured database account.
- Collect JSON logs and scrape `/metrics`.

## What Is Intentionally Not Supported

- Write SQL execution.
- Schema changes.
- Stored procedure calls.
- Directly executable DDL or index-change recommendations.
- Directly executable `ALTER`, `CREATE`, `DROP`, `GRANT`, or index DDL in metadata change reports.
- File import/export functions.
- `SHOW` and `DESCRIBE` through `ob_query`; use metadata tools instead.
- Disabling MCP read-only mode.

## Verification

```bash
npm test
npm run mcp:smoke
npm run http:smoke
npm run security:gates
npm run security:secrets
npm run security:sca
npm audit --omit=dev --audit-level=moderate
```

The HTTP smoke verifies unauthenticated requests return `401` and disallowed source IPs return `403`.
