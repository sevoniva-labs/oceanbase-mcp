---
name: oceanbase-query
description: Guide OpenCode to use OceanBase MCP for metadata-first OceanBase querying, SQL assistance, ER diagrams, metadata change review, and result documentation.
license: MIT
compatibility: opencode
metadata:
  mcp: oceanbase
  safety: read-only
---

## Purpose

Use this skill when a user asks to inspect OceanBase schemas, understand tables, write read-only SQL, query data, explain results, analyze a query plan, generate ER diagrams, review metadata changes, or produce data documentation.

## Workflow

1. Search metadata before writing SQL.
2. Read table context, schema map, or onboarding documentation before choosing columns or joins.
3. Prepare or build only read-only SQL with explicit columns.
4. Lint or preview policy and plan risk before execution.
5. Query with a session and pagination when inspecting data.
6. Summarize rows, filters, page state, warnings, and next steps.

## Metadata First

Use these tools before SQL:

- `ob_search_everything` for business terms, table names, column names, comments, and glossary hits.
- `ob_search_business_glossary` for configured business-term mappings. Treat results as hints and verify with metadata tools.
- `ob_get_schema_map`, `ob_find_tables_by_business_term`, and `ob_find_columns` to narrow candidate tables and fields.
- `ob_get_table_context`, `ob_get_table_summary`, or `ob_generate_onboarding_doc` for table structure, relationships, query entry points, and glossary hints.
- Existing metadata tools as fallback: `ob_get_table_ddl`, `ob_describe_table`, `ob_get_indexes`, `ob_get_constraints`, `ob_get_partitions`, `ob_get_table_stats`, `ob_find_related_tables`, and `ob_generate_query`.

Never invent table names, fields, joins, or relationships. If metadata is insufficient, ask for the business term, schema, or table name.

## Query Rules

- Use `ob_prepare_query` for natural-language questions and `ob_build_select` for structured SELECT generation.
- Use `ob_lint_sql` or `ob_query_preview` before executing a user-facing query.
- Prefer `ob_start_query_session` with `ob_query_page`, then `ob_query_next_page` or `ob_query_prev_page` for data lookup.
- Use `ob_query` only with explicit selected columns, filters, ordering, and a small limit.
- Use `ob_profile_table`, `ob_profile_columns`, `ob_get_value_distribution`, `ob_detect_time_columns`, and `ob_detect_dimension_columns` for data understanding.
- Use `ob_policy_explain` when checking whether SQL is allowed.
- Use `ob_analyze_query_plan` or `ob_generate_performance_report` for performance questions.

## Diagrams And Documentation

- Use `ob_generate_er_diagram`, `ob_generate_er_html`, `ob_generate_entity_diagram`, `ob_explain_relationship`, and `ob_generate_er_document` for ER work. Keep only relationships with metadata evidence.
- Use `ob_generate_table_doc`, `ob_generate_schema_doc`, `ob_generate_data_dictionary`, `ob_generate_query_doc`, and `ob_generate_onboarding_doc` for documentation.
- Use `ob_get_cache_status` or `ob_refresh_metadata_cache` only when metadata appears stale or the user asks about cache behavior.

## Metadata Change Review

Use this workflow when the user asks what changed in an iteration or what a metadata change affects:

1. Capture a before snapshot with `ob_capture_metadata_snapshot` or `ob-mcp metadata snapshot`.
2. Build a SQL usage index with `ob-mcp scan-sql --index-out`.
3. Capture an after snapshot.
4. Compare snapshots with `ob_compare_metadata_snapshots` or `ob-mcp metadata diff`.
5. Analyze impact with `ob_analyze_metadata_impact` and `ob_analyze_change_sql_impact`.
6. Generate a Markdown or HTML report with `ob_generate_metadata_change_report` or `ob-mcp metadata report`.
7. Summarize affected files, tables, columns, relationship paths, risks, evidence, and review items.

Do not invent relationships, SQL usages, or impact conclusions. Use only snapshot diff, SQL index, relationship metadata, or business glossary evidence.

## Safety Rules

- Keep all work read-only.
- Do not run or propose write SQL, DDL, DCL, procedure calls, sequence `NEXTVAL`, lock commands, file functions, sleep functions, or multi-statement SQL.
- Do not use `SELECT *`.
- Do not bypass profile, schema, table, tool, row, timeout, or output-size limits.
- Do not output executable index creation or schema change statements.
- Do not emit executable `ALTER`, `CREATE`, `DROP`, `GRANT`, or index DDL in metadata change reports.
- Report truncation, masking, unstable ordering, and policy rejections plainly.

## Compatibility

- MySQL mode can use MySQL syntax such as `LIMIT`.
- Oracle mode needs Oracle-compatible object casing, pagination, and date expressions.
- Oracle procedures, functions, packages, synonyms, sequences, and views are metadata only.

## Output

Return the answer first. Include the SQL used, row count, page information, relevant warnings, and any assumptions. Keep wording direct and avoid broad claims not supported by the query result.
