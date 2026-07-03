# OceanBase MCP

[中文](../zh-CN/README.md) | [Back to root](../../README.md)

OceanBase MCP is a strictly read-only MCP server for OceanBase. It is designed for OpenCode and other MCP clients that need database context, metadata, query assistance, and change review without exposing write capability.

## Main Capabilities

- Connects to OceanBase through OBProxy or a MySQL protocol endpoint.
- Supports OceanBase MySQL and Oracle compatibility modes.
- Exposes read-only MCP tools for metadata, SQL assistance, ER diagrams, result inspection, and schema change review.
- Provides an OpenCode agent and skill that guide a metadata-first query workflow.
- Protects every data-access path with profile permissions, schema/table/column policy, SQL policy, row caps, response-size caps, timeouts, concurrency limits, audit logging, and error redaction.
- Ships stdio, HTTP, Docker, Kubernetes, Nginx, systemd, and OpenCode examples.

See the full [tool list](tools.md) for every MCP tool and the version in which it was introduced.

## Read-Only Contract

- There is no write-capable MCP tool.
- `OB_MCP_READ_ONLY=true` is the default and cannot be disabled.
- `OB_MCP_READ_ONLY=false` makes the server refuse to start.
- User SQL is limited to `SELECT`, `WITH`, and read-only `EXPLAIN`.
- `SELECT *`, multi-statement SQL, write/control keywords, executable comments, filesystem functions, sleeps, locks, and sequence `NEXTVAL` are blocked.
- User SQL runs in a database read-only transaction by default.

Even if `OB_USER` is a read-write database account, the MCP surface remains read-only. A SELECT-only database account is still recommended as defense in depth.

## Install

Node.js 20 or newer is required.

```bash
npm install -g @sevoniva/oceanbase-mcp@1.4.0
ob-mcp init --mode mysql --schema app_schema
ob-mcp doctor
```

Use `npx` when you do not want a global install:

```bash
npx --registry=https://registry.npmjs.org/ --yes --package=@sevoniva/oceanbase-mcp@1.4.0 ob-mcp --help
```

Build from source:

```bash
git clone https://github.com/sevoniva/oceanbase-mcp.git
cd oceanbase-mcp
npm ci
npm run build
cp .env.example .env
npm run config:doctor
```

## OpenCode

Generate project files:

```bash
ob-mcp init --mode mysql --schema app_schema
```

Then verify the MCP connection:

```bash
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

See [OpenCode setup](opencode.md) for local, `npx`, and HTTP examples.

## Recommended Query Workflow

1. Search visible schemas, tables, columns, comments, and business terms.
2. Read table context before writing SQL.
3. Generate or draft a read-only SQL statement with explicit columns.
4. Preview policy, sensitive columns, and `EXPLAIN` risk.
5. Run paged queries with a stable ordering when possible.
6. Summarize returned rows without issuing extra database reads.

## Large Schema Guidance

- Use `ob_plan_er_export` before generating an ER diagram for a large schema.
- Use CLI cluster export for large ER HTML artifacts.
- Keep MCP inline ER output for small scopes.
- Prefer foreign-key relationships first; inferred relationships should be reviewed with confidence and evidence.

## Documentation

| Topic | Document |
| --- | --- |
| Tools | [Tool list](tools.md) |
| OpenCode | [OpenCode setup](opencode.md) |
| CLI | [CLI](cli.md) |
| Configuration | [Configuration](configuration.md) |
| SQL assistance | [SQL assistance](sql-assistant.md) |
| ER diagrams | [ER diagrams](er.md) |
| Data dictionary | [Data dictionary and docs](data-dictionary.md) |
| Metadata change | [Metadata change analysis](metadata-change.md) |
| Deployment | [Deployment](deployment.md) |
| Architecture | [Architecture](architecture.md) |
| Security | [Security baseline](security.md) |
| Examples | [Example files](../../examples/README.en.md) |

## Release Timeline

| Version | Theme |
| --- | --- |
| v0.3.0 | Read-only MCP gateway, OceanBase MySQL/Oracle connectivity, baseline SQL policy, table metadata, and masked sample rows. |
| v0.4.0 | HTTP deployment, security hardening, Host/IP allowlists, rate limits, health checks, metrics, audit logs, and database permission checks. |
| v0.5.0 | Developer metadata: table DDL, statistics, Oracle objects, relationship discovery, ER diagrams, plan analysis, and performance advice. |
| v0.5.1 | OpenCode query workflow: table context, query preview, paged queries, result structure, error hints, column profiling, and business glossary. |
| v1.0.0 | Local developer assistant scope: init/doctor, unified search, SQL assistance, query sessions, data understanding, ER HTML, documentation, project SQL scanning, and offline delivery. |
| v1.1.0 | Metadata snapshots, snapshot diff, SQL usage index, impact analysis, change reports, and relationship paths for iteration review. |
| v1.1.1 | Large-schema ER stability, batched metadata loading, improved ER HTML browser, and chunked local export planning. |
| v1.1.2 | Local OpenCode query stability, higher local HTTP rate-limit default, crash/slow-call logging, and Oracle named bind compatibility. |
| v1.1.3 | Lightweight large-schema ER planning, chunk strategy options, and 200+ table local validation. |
| v1.1.4 | Reduced duplicate ER metadata reads and early fallback for large inline ER HTML. |
| v1.1.5 | npmjs distribution under `@sevoniva/oceanbase-mcp`, while CLI commands remain `ob-mcp`. |
| v1.1.6 | Correct npmjs startup examples, add Apache-2.0 package license metadata, document Trusted Publishing, and verify public npm installation. |
| v1.2.0 | Rebuilt ER metadata maps with stable graph IDs, interactive graph canvas, cluster directory export, cross-cluster relationship index, diagnostic metadata, and response-size logging. |
| v1.3.0 | Stability and maintainability: DB call budgets, tool deadlines, structured logs, crash regression coverage, DB runtime module split, and large-schema validation records. |
| v1.4.0 | Trimmed npm package contents by excluding release-note history and smoke scripts that are not needed at runtime; source archives remain complete for source builds. |

## Distribution

The public npm package is `@sevoniva/oceanbase-mcp`, and the CLI commands are `ob-mcp`, `ob-mcp-http`, and `ob-mcp-doctor`.

```bash
npm install -g @sevoniva/oceanbase-mcp@1.4.0
ob-mcp --help
```

Release assets include:

| Asset | Purpose |
| --- | --- |
| `sevoniva-oceanbase-mcp-1.4.0.tgz` | npm package. |
| `oceanbase-mcp-1.4.0-source.tar.gz` | Source archive for source builds. |
| `sbom.cdx.json` | CycloneDX SBOM. |
| `oceanbase-mcp-1.4.0-amd64.tar.gz` | amd64 offline image. |
| `oceanbase-mcp-1.4.0-arm64.tar.gz` | arm64 offline image. |
| `ghcr.io/sevoniva/oceanbase-mcp:v1.4.0` | GHCR image tag. |

The source archive excludes `node_modules` and `dist`. Your npm registry mirror must provide the dependencies locked by `package-lock.json`.

## Verify

```bash
npm test
npm run docs:check
npm audit --omit=dev --audit-level=moderate
npm pack --dry-run
```

See [deployment.md](deployment.md) for Docker, Kubernetes, and smoke-test validation steps.
