# OceanBase MCP

[中文](../zh-CN/README.md) | [Back to root](../../README.md)

OceanBase MCP is a read-only MCP gateway for OceanBase. It is designed for OpenCode and other MCP clients that need safe database inspection without exposing write capability.

## What It Does

- Connects to OceanBase through OBProxy or a MySQL protocol endpoint.
- Supports OceanBase MySQL and Oracle compatibility modes.
- Exposes only read-only MCP tools.
- Enforces schema/table allowlists, denied system schemas, denied sensitive columns, field-level sample masking, hard row/response caps, SQL length limits, and read-only transactions.
- Inspects table DDL/structure, indexes, constraints, partitions, statistics, related tables, and ER diagrams.
- Generates read-only SQL templates, query plan analysis, and performance advisory reports.
- Provides an OpenCode agent and skill for metadata-first, read-only query workflows.
- Captures metadata snapshots, compares iteration changes, indexes project SQL usage, and generates change impact reports.
- Inspects Oracle view, sequence, synonym, procedure, function, and package metadata.
- Provides stdio mode for local development and HTTP mode for shared deployments.
- Protects HTTP mode with bearer token policies, Host allowlist, source IP allowlist, endpoint auth, body limits, and rate limiting.
- Provides a read-only database account permission verification tool.
- Ships Docker, Kubernetes, Nginx, systemd, and local OpenCode examples.

## Release Timeline

This table lists release themes only. Per-tool versioning is in the Tools table below.

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

All data-access tools are governed by profile permissions, schema/table/column policy, read-only SQL policy, row caps, response-size caps, timeouts, concurrency limits, audit logging, and error redaction.

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

Install the Node.js CLI/runtime package from npmjs or a private npm registry:

```bash
npm install -g @sevoniva/oceanbase-mcp@1.2.0
ob-mcp doctor
npx --registry=https://registry.npmjs.org/ --yes --package=@sevoniva/oceanbase-mcp@1.2.0 ob-mcp --help
```

Build from source:

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
- [CLI](cli.md)
- [Configuration](configuration.md)
- [SQL assistance](sql-assistant.md)
- [ER diagrams](er.md)
- [Data dictionary and docs](data-dictionary.md)
- [Metadata change analysis](metadata-change.md)
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

Sorted by Since version in ascending order; tools with the same version are sorted by tool name.

| Since | Tool | Purpose |
| --- | --- | --- |
| v0.3.0 | `ob_config_diagnostics` | Report deployment and policy checks. |
| v0.3.0 | `ob_describe_table` | Return column metadata. |
| v0.3.0 | `ob_explain` | Run `EXPLAIN` for read-only SQL. |
| v0.3.0 | `ob_get_constraints` | Return primary, unique, foreign-key, check, and not-null constraints. |
| v0.3.0 | `ob_get_indexes` | Return table index metadata. |
| v0.3.0 | `ob_get_partitions` | Return table partition metadata. |
| v0.3.0 | `ob_get_table_schema` | Return policy-filtered table schema. |
| v0.3.0 | `ob_list_profiles` | List configured profiles with secrets redacted. |
| v0.3.0 | `ob_list_schemas` | List visible schemas/databases. |
| v0.3.0 | `ob_list_tables` | List visible tables. |
| v0.3.0 | `ob_ping` | Verify the OceanBase connection. |
| v0.3.0 | `ob_policy_explain` | Explain whether SQL would be allowed. |
| v0.3.0 | `ob_query` | Run strict read-only SQL; returns column metadata, Markdown preview, and warnings since v0.5.1. |
| v0.3.0 | `ob_sample_rows` | Return masked, explicit-column sample rows. |
| v0.3.0 | `ob_search_catalog` | Search schemas, tables, and columns; business glossary matches can be included since v0.5.1. |
| v0.4.0 | `ob_verify_permissions` | Check current database grants for write or administrative privileges. |
| v0.5.0 | `ob_analyze_query_plan` | Run `EXPLAIN` and return evidence-based plan findings. |
| v0.5.0 | `ob_find_related_tables` | Find foreign-key and conservative naming-based table relationships. |
| v0.5.0 | `ob_generate_er_diagram` | Generate Mermaid and JSON ER metadata from allowed tables; v1.2.0 adds stable graph IDs and relationship classes. |
| v0.5.0 | `ob_generate_performance_report` | Generate a read-only performance advisory report from EXPLAIN and metadata. |
| v0.5.0 | `ob_generate_query` | Generate read-only SQL templates from table metadata. |
| v0.5.0 | `ob_get_object_metadata` | Return bounded metadata and source preview for one Oracle object. |
| v0.5.0 | `ob_get_table_ddl` | Return native or structured table DDL metadata. |
| v0.5.0 | `ob_get_table_stats` | Return table row estimates, counts, and storage statistics. |
| v0.5.0 | `ob_list_objects` | List policy-filtered Oracle views, sequences, synonyms, procedures, functions, and packages. |
| v0.5.1 | `ob_get_table_context` | Return common table context for SQL drafting and data inspection. |
| v0.5.1 | `ob_profile_columns` | Return bounded-sample column profiles; includes type strategy and enum signals since v1.0.0. |
| v0.5.1 | `ob_query_page` | Run a paged read-only query. |
| v0.5.1 | `ob_query_preview` | Preview read-only policy and plan risk before execution, without returning data. |
| v0.5.1 | `ob_search_business_glossary` | Search visible business-term mappings to schemas, tables, and columns. |
| v1.0.0 | `ob_build_select` | Build parameterized read-only SELECT statements from validated structured input. |
| v1.0.0 | `ob_check_data_quality` | Run bounded read-only checks for nulls, duplicate key risk, dimensions, and time columns. |
| v1.0.0 | `ob_check_opencode_setup` | Check local OpenCode config, OceanBase agent, and query skill files. |
| v1.0.0 | `ob_close_query_session` | Close an in-memory query session. |
| v1.0.0 | `ob_compare_query_results` | Compare two already returned query results without reading the database. |
| v1.0.0 | `ob_compare_schemas` | Compare two visible schemas by table list and bounded table metadata differences. |
| v1.0.0 | `ob_compare_tables` | Compare two visible tables by columns, indexes, constraints, and partitions. |
| v1.0.0 | `ob_convert_sql_dialect` | Convert read-only SQL between OceanBase MySQL and Oracle modes with limitations. |
| v1.0.0 | `ob_detect_dimension_columns` | Detect likely status, type, channel, region, and category columns from metadata. |
| v1.0.0 | `ob_detect_time_columns` | Detect likely create, update, and business time columns from metadata. |
| v1.0.0 | `ob_explain_error` | Explain SQL errors with policy context and visible metadata hints without executing SQL. |
| v1.0.0 | `ob_explain_project_query` | Explain project SQL tables, fields, filters, pagination, and risk without executing it. |
| v1.0.0 | `ob_explain_relationship` | Explain visible relationship evidence and confidence between two tables; returns bounded relationship paths since v1.1.0. |
| v1.0.0 | `ob_export_result_preview` | Generate Markdown/CSV result preview text without writing files. |
| v1.0.0 | `ob_find_columns` | Find visible columns by name, comment, type, table pattern, or business term. |
| v1.0.0 | `ob_find_recent_rows` | Read recent rows using an explicit or detected time column with safe pagination. |
| v1.0.0 | `ob_find_tables_by_business_term` | Find candidate tables for a business term with evidence and related tables. |
| v1.0.0 | `ob_find_unknown_columns_in_sql` | Find unknown tables or columns in SQL with visible metadata-based candidates. |
| v1.0.0 | `ob_generate_data_dictionary` | Generate JSON, Markdown, or simple HTML data dictionaries. |
| v1.0.0 | `ob_generate_entity_diagram` | Generate local entity diagrams from a business term or table with Mermaid, JSON, HTML, and relationship evidence. |
| v1.0.0 | `ob_generate_er_document` | Generate Markdown, PlantUML, and DOT ER documentation from allowed metadata and relationship evidence. |
| v1.0.0 | `ob_generate_er_html` | Generate self-contained ER HTML from allowed metadata and relationship evidence; v1.2.0 uses an interactive graph canvas with stable IDs and evidence panels. |
| v1.0.0 | `ob_generate_mapper_context` | Generate table and column context for mapper or SQL files without modifying code. |
| v1.0.0 | `ob_generate_onboarding_doc` | Generate onboarding documentation from visible metadata and business glossary hints. |
| v1.0.0 | `ob_generate_query_doc` | Generate SQL snippet documentation without executing the target query. |
| v1.0.0 | `ob_generate_query_examples` | Generate common read-only query examples from table context without executing SQL. |
| v1.0.0 | `ob_generate_schema_doc` | Generate bounded Markdown or JSON documentation for visible tables in one schema. |
| v1.0.0 | `ob_generate_table_doc` | Generate Markdown or JSON documentation for one table without sample values. |
| v1.0.0 | `ob_get_cache_status` | Return profile-scoped metadata cache status without exposing cached content. |
| v1.0.0 | `ob_get_database_dictionary` | Generate bounded JSON or Markdown data dictionaries from visible metadata. |
| v1.0.0 | `ob_get_query_session` | Read a query session context without exposing stored parameter values. |
| v1.0.0 | `ob_get_schema_map` | Return compact schema, table, key-field, and relationship summaries. |
| v1.0.0 | `ob_get_table_summary` | Summarize one table with inferred purpose, key fields, relationships, and query entry points. |
| v1.0.0 | `ob_get_usage_guide` | Return the recommended OpenCode workflow, read-only rules, and MySQL/Oracle notes. |
| v1.0.0 | `ob_get_value_distribution` | Return bounded top-value distribution for one visible column. |
| v1.0.0 | `ob_lint_sql` | Lint read-only SQL for policy, dialect, pagination, ordering, sensitive fields, and plan risk. |
| v1.0.0 | `ob_list_capabilities` | Return MCP capabilities, tool groups, versions, and read-only limits. |
| v1.0.0 | `ob_prepare_query` | Prepare candidate tables, fields, SQL drafts, and safety previews from visible metadata without executing a query. |
| v1.0.0 | `ob_profile_table` | Return bounded table profiles with key fields, null overview, and sampled field signals. |
| v1.0.0 | `ob_query_next_page` | Run the next page for a query session with read-only policy and row limits enforced. |
| v1.0.0 | `ob_query_prev_page` | Run the previous page for a query session with read-only policy and row limits enforced. |
| v1.0.0 | `ob_query_refine` | Build refined read-only SELECT SQL from a query session without executing it. |
| v1.0.0 | `ob_refresh_metadata_cache` | Clear in-memory metadata cache entries by profile, schema, or table scope. |
| v1.0.0 | `ob_rewrite_sql` | Rewrite SELECT/WITH SQL into a safer read-only form without executing it. |
| v1.0.0 | `ob_search_everything` | Search schemas, tables, columns, comments, and business terms with evidence. |
| v1.0.0 | `ob_start_query_session` | Start an in-memory query context for tables, columns, SQL, paging, and warnings. |
| v1.0.0 | `ob_summarize_result` | Summarize already returned rows without reading the database. |
| v1.0.0 | `ob_validate_sql_snippet` | Validate pasted SQL snippets for read-only policy, dialect, pagination, risk, and visible table or column metadata. |
| v1.1.0 | `ob_analyze_change_sql_impact` | Analyze project SQL impact from metadata diff and SQL usage index evidence. |
| v1.1.0 | `ob_analyze_metadata_impact` | Summarize metadata diff impact with SQL index, relationship, and glossary evidence. |
| v1.1.0 | `ob_capture_metadata_snapshot` | Capture bounded metadata-only snapshots without reading business data. |
| v1.1.0 | `ob_compare_metadata_snapshots` | Compare metadata snapshots and return evidence-based structural changes. |
| v1.1.0 | `ob_find_sql_usages` | Find table, column, or business-term references from a static SQL usage index. |
| v1.1.0 | `ob_generate_metadata_change_report` | Generate Markdown or simple HTML change reports from diff and impact evidence. |
| v1.1.1 | `ob_plan_er_export` | Estimate large-schema ER size and plan local cluster ER export commands; v1.2.0 adds relationship index and diagnostics metadata. |

## Metadata Change Workflow

Capture metadata before and after an iteration, then combine the diff with a project SQL usage index:

```bash
ob-mcp metadata snapshot --schema biz_test --out snapshots/before.json
ob-mcp scan-sql --path src --path mapper --index-out snapshots/sql-index.json --format text
ob-mcp metadata snapshot --schema biz_test --out snapshots/after.json
ob-mcp metadata diff --before snapshots/before.json --after snapshots/after.json --format markdown --out snapshots/diff.md
ob-mcp metadata report --before snapshots/before.json --after snapshots/after.json --sql-index snapshots/sql-index.json --format markdown --out snapshots/report.md
```

These commands only read metadata or local project files. Reports contain risks, evidence, and review guidance; they do not emit executable DDL.

## Distribution

The public npm package is `@sevoniva/oceanbase-mcp`, and the CLI commands remain `ob-mcp`, `ob-mcp-http`, and `ob-mcp-doctor`. It is the Node.js CLI/runtime distribution and can be installed globally or launched with `npx --package` from another terminal. Private registries can mirror npmjs and install pinned versions from the private registry.

```bash
npm install -g @sevoniva/oceanbase-mcp@1.2.0
ob-mcp --help
npx --registry=https://registry.npmjs.org/ --yes --package=@sevoniva/oceanbase-mcp@1.2.0 ob-mcp --help
```

Release assets still include a source archive for offline source builds:

```bash
tar -xzf oceanbase-mcp-1.2.0-source.tar.gz
cd oceanbase-mcp-1.2.0
npm ci
npm run build
npm run start
```

The source archive excludes `node_modules` and `dist`. The private npm registry must provide the dependencies locked by `package-lock.json`.

## Release Assets

| Asset | Purpose |
| --- | --- |
| `sevoniva-oceanbase-mcp-1.2.0.tgz` | npm package. |
| `oceanbase-mcp-1.2.0-source.tar.gz` | Source archive for offline source builds. |
| `sbom.cdx.json` | CycloneDX SBOM. |
| `oceanbase-mcp-1.2.0-amd64.tar.gz` | amd64 offline image. |
| `oceanbase-mcp-1.2.0-arm64.tar.gz` | arm64 offline image. |
| `ghcr.io/sevoniva/oceanbase-mcp:v1.2.0` | GHCR image tag. |

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
