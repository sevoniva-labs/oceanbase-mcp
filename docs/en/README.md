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
- Inspects Oracle view, sequence, synonym, procedure, function, and package metadata.
- Provides stdio mode for local development and HTTP mode for shared deployments.
- Protects HTTP mode with bearer token policies, Host allowlist, source IP allowlist, endpoint auth, body limits, and rate limiting.
- Provides a read-only database account permission verification tool.
- Ships Docker, Kubernetes, Nginx, systemd, and local OpenCode examples.

## Versioned Capabilities

| Version | Capability | Details |
| --- | --- | --- |
| v0.3.0 | Read-only gateway foundation | stdio integration, OceanBase MySQL/Oracle connectivity, read-only SQL execution, schema/table metadata, indexes, constraints, partitions, and masked sample rows. |
| v0.3.0 | Baseline SQL policy | Blocks write/control SQL, multi-statement SQL, dangerous functions, and `SELECT *` by default; caps rows, SQL length, and response size. |
| v0.4.0 | Production deployment hardening | HTTP mode, bearer token auth, Host allowlist, source IP allowlist, body limits, rate limits, health checks, Prometheus metrics, and JSON audit logs. |
| v0.4.0 | Pre-release diagnostics | Database permission verification and expanded configuration diagnostics for read-only boundary checks. |
| v0.5.0 | Developer metadata | Table DDL, table statistics, Oracle object metadata, related-table discovery, and ER diagram generation. |
| v0.5.0 | SQL assistance | Read-only query templates, query plan analysis, and evidence-based performance advisory reports. |
| v0.5.0 | Column masking enhancements | Exact column matches, wildcard matches, and automatic sensitive-name detection. |
| v0.5.1 | OpenCode Agent/Skill | Guides the workflow to inspect metadata, generate read-only SQL, preview risk, page through results, and summarize output. |
| v0.5.1 | Query workflow improvements | Table context, query preview, paged queries, column metadata, Markdown preview, result warnings, and structured SQL error hints. |
| v0.5.1 | Column profiling and business glossary | Bounded column distribution analysis and visible business-term mappings to schemas, tables, and columns. |
| v0.5.1 | Release delivery assets | npm package, SBOM, amd64/arm64 offline images, and source archive for internal builds. |
| v1.0.0 | Local setup and capability discovery | Generate local config, check OpenCode setup, and expose MCP usage guidance and tool capabilities. |
| v1.0.0 | Project SQL assistance | Scan local SQL snippets, report read-only risk, pagination risk, and dynamic SQL hints without modifying project files. |

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

| Tool | Since | Purpose |
| --- | --- | --- |
| `ob_list_profiles` | v0.3.0 | List configured profiles with secrets redacted. |
| `ob_config_diagnostics` | v0.3.0 | Report deployment and policy checks. |
| `ob_ping` | v0.3.0 | Verify the OceanBase connection. |
| `ob_policy_explain` | v0.3.0 | Explain whether SQL would be allowed. |
| `ob_query` | v0.3.0 | Run strict read-only SQL; returns column metadata, Markdown preview, and warnings since v0.5.1. |
| `ob_list_schemas` | v0.3.0 | List visible schemas/databases. |
| `ob_list_tables` | v0.3.0 | List visible tables. |
| `ob_describe_table` | v0.3.0 | Return column metadata. |
| `ob_explain` | v0.3.0 | Run `EXPLAIN` for read-only SQL. |
| `ob_search_catalog` | v0.3.0 | Search schemas, tables, and columns; business glossary matches can be included since v0.5.1. |
| `ob_get_table_schema` | v0.3.0 | Return policy-filtered table schema. |
| `ob_get_indexes` | v0.3.0 | Return table index metadata. |
| `ob_get_constraints` | v0.3.0 | Return primary, unique, foreign-key, check, and not-null constraints. |
| `ob_get_partitions` | v0.3.0 | Return table partition metadata. |
| `ob_sample_rows` | v0.3.0 | Return masked, explicit-column sample rows. |
| `ob_verify_permissions` | v0.4.0 | Check current database grants for write or administrative privileges. |
| `ob_analyze_query_plan` | v0.5.0 | Run `EXPLAIN` and return evidence-based plan findings. |
| `ob_generate_performance_report` | v0.5.0 | Generate a read-only performance advisory report from EXPLAIN and metadata. |
| `ob_list_objects` | v0.5.0 | List policy-filtered Oracle views, sequences, synonyms, procedures, functions, and packages. |
| `ob_get_object_metadata` | v0.5.0 | Return bounded metadata and source preview for one Oracle object. |
| `ob_get_table_ddl` | v0.5.0 | Return native or structured table DDL metadata. |
| `ob_find_related_tables` | v0.5.0 | Find foreign-key and conservative naming-based table relationships. |
| `ob_get_table_stats` | v0.5.0 | Return table row estimates, counts, and storage statistics. |
| `ob_generate_query` | v0.5.0 | Generate read-only SQL templates from table metadata. |
| `ob_generate_er_diagram` | v0.5.0 | Generate Mermaid and JSON ER metadata from allowed tables; v1.0.0 adds business-term scope, table lists, depth, confidence, and inferred-relation controls. |
| `ob_query_preview` | v0.5.1 | Preview read-only policy and plan risk before execution, without returning data. |
| `ob_query_page` | v0.5.1 | Run a paged read-only query. |
| `ob_search_business_glossary` | v0.5.1 | Search visible business-term mappings to schemas, tables, and columns. |
| `ob_get_table_context` | v0.5.1 | Return common table context for SQL drafting and data inspection. |
| `ob_profile_columns` | v0.5.1 | Return bounded-sample column profiles; includes type strategy and enum signals since v1.0.0. |
| `ob_check_opencode_setup` | v1.0.0 | Check local OpenCode config, OceanBase agent, and query skill files. |
| `ob_get_usage_guide` | v1.0.0 | Return the recommended OpenCode workflow, read-only rules, and MySQL/Oracle notes. |
| `ob_list_capabilities` | v1.0.0 | Return MCP capabilities, tool groups, versions, and read-only limits. |
| `ob_start_query_session` | v1.0.0 | Start an in-memory query context for tables, columns, SQL, paging, and warnings. |
| `ob_get_query_session` | v1.0.0 | Read a query session context without exposing stored parameter values. |
| `ob_close_query_session` | v1.0.0 | Close an in-memory query session. |
| `ob_query_next_page` | v1.0.0 | Run the next page for a query session with read-only policy and row limits enforced. |
| `ob_query_prev_page` | v1.0.0 | Run the previous page for a query session with read-only policy and row limits enforced. |
| `ob_query_refine` | v1.0.0 | Build refined read-only SELECT SQL from a query session without executing it. |
| `ob_summarize_result` | v1.0.0 | Summarize already returned rows without reading the database. |
| `ob_compare_query_results` | v1.0.0 | Compare two already returned query results without reading the database. |
| `ob_export_result_preview` | v1.0.0 | Generate Markdown/CSV result preview text without writing files. |
| `ob_get_schema_map` | v1.0.0 | Return compact schema, table, key-field, and relationship summaries. |
| `ob_get_database_dictionary` | v1.0.0 | Generate bounded JSON or Markdown data dictionaries from visible metadata. |
| `ob_search_everything` | v1.0.0 | Search schemas, tables, columns, comments, and business terms with evidence. |
| `ob_find_tables_by_business_term` | v1.0.0 | Find candidate tables for a business term with evidence and related tables. |
| `ob_find_columns` | v1.0.0 | Find visible columns by name, comment, type, table pattern, or business term. |
| `ob_get_table_summary` | v1.0.0 | Summarize one table with inferred purpose, key fields, relationships, and query entry points. |
| `ob_compare_tables` | v1.0.0 | Compare two visible tables by columns, indexes, constraints, and partitions. |
| `ob_compare_schemas` | v1.0.0 | Compare two visible schemas by table list and bounded table metadata differences. |
| `ob_profile_table` | v1.0.0 | Return bounded table profiles with key fields, null overview, and sampled field signals. |
| `ob_get_value_distribution` | v1.0.0 | Return bounded top-value distribution for one visible column. |
| `ob_detect_time_columns` | v1.0.0 | Detect likely create, update, and business time columns from metadata. |
| `ob_detect_dimension_columns` | v1.0.0 | Detect likely status, type, channel, region, and category columns from metadata. |
| `ob_find_recent_rows` | v1.0.0 | Read recent rows using an explicit or detected time column with safe pagination. |
| `ob_check_data_quality` | v1.0.0 | Run bounded read-only checks for nulls, duplicate key risk, dimensions, and time columns. |
| `ob_prepare_query` | v1.0.0 | Prepare candidate tables, fields, SQL drafts, and safety previews from visible metadata without executing a query. |
| `ob_build_select` | v1.0.0 | Build parameterized read-only SELECT statements from validated structured input. |
| `ob_lint_sql` | v1.0.0 | Lint read-only SQL for policy, dialect, pagination, ordering, sensitive fields, and plan risk. |
| `ob_validate_sql_snippet` | v1.0.0 | Validate pasted SQL snippets for read-only policy, dialect, pagination, risk, and visible table or column metadata. |
| `ob_explain_project_query` | v1.0.0 | Explain project SQL tables, fields, filters, pagination, and risk without executing it. |
| `ob_rewrite_sql` | v1.0.0 | Rewrite SELECT/WITH SQL into a safer read-only form without executing it. |
| `ob_convert_sql_dialect` | v1.0.0 | Convert read-only SQL between OceanBase MySQL and Oracle modes with limitations. |
| `ob_explain_error` | v1.0.0 | Explain SQL errors with policy context and visible metadata hints without executing SQL. |
| `ob_generate_query_examples` | v1.0.0 | Generate common read-only query examples from table context without executing SQL. |
| `ob_generate_er_html` | v1.0.0 | Generate self-contained static, interactive, compact, or detailed HTML ER diagrams from allowed metadata and relationship evidence. |
| `ob_generate_entity_diagram` | v1.0.0 | Generate local entity diagrams from a business term or table with Mermaid, JSON, HTML, and relationship evidence. |
| `ob_explain_relationship` | v1.0.0 | Explain visible relationship evidence and confidence between two tables without inventing missing links. |
| `ob_generate_er_document` | v1.0.0 | Generate Markdown, PlantUML, and DOT ER documentation from allowed metadata and relationship evidence. |

## Oracle Object Metadata

`ob_list_objects` and `ob_get_object_metadata` support Oracle-compatible `view`, `sequence`, `synonym`, `procedure`, `function`, `package`, and `package_body` objects. Object names are filtered by the same schema and object-name policy used for table metadata.

Procedure, function, and package source is returned as a bounded preview, not as an unrestricted dump. Source previews are capped and passed through sensitive-name redaction before output. Synonym metadata is returned only when the connected database account can see the synonym in `all_synonyms`.

## Query Templates

`ob_generate_query` produces read-only SQL templates for primary-key lookup, pagination, time-range filtering, aggregation, and related-table joins. It returns SQL text, parameter descriptions, notes, and policy checks; it does not execute the generated SQL.

## Performance Reports

`ob_generate_performance_report` runs read-only `EXPLAIN`, collects visible table statistics and index metadata, and returns risk level, evidence, and review recommendations. It does not execute the target SQL and does not output DDL or directly executable index changes.

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
