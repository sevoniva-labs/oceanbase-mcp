---
name: oceanbase-query
description: Guide OpenCode to use OceanBase MCP for read-only schema discovery, SQL drafting, query preview, paged querying, and result explanation.
license: MIT
compatibility: opencode
metadata:
  mcp: oceanbase
  safety: read-only
---

## Purpose

Use this skill when a user asks to inspect OceanBase schemas, understand tables, write read-only SQL, query sample data, explain results, analyze a query plan, or draw an ER diagram.

## Workflow

1. Search metadata before writing SQL.
2. Read table context before choosing columns or joins.
3. Generate only read-only SQL with explicit columns.
4. Preview policy and plan risk before execution.
5. Query with pagination or a small limit.
6. Summarize rows, filters, warnings, and next steps.

## Metadata First

Use these tools before SQL:

- `ob_search_catalog` for business terms, table names, column names, and comments.
- `ob_search_business_glossary` for configured business-term mappings. Treat results as hints and verify with metadata tools.
- `ob_get_table_context` when available for table structure, indexes, constraints, partitions, related tables, templates, and safe samples.
- Existing metadata tools as fallback: `ob_get_table_ddl`, `ob_describe_table`, `ob_get_indexes`, `ob_get_constraints`, `ob_get_partitions`, `ob_get_table_stats`, `ob_find_related_tables`, `ob_generate_query`.

Never invent table names, fields, joins, or relationships. If metadata is insufficient, ask for the business term, schema, or table name.

## Query Rules

- Use `ob_query_preview` before executing a user-facing query when available.
- Prefer `ob_query_page` for data lookup when available.
- Use `ob_query` only with explicit selected columns, filters, ordering, and a small limit.
- Use `ob_profile_columns` for status values, top values, null rates, min/max, and time ranges.
- Use `ob_policy_explain` when checking whether SQL is allowed.
- Use `ob_analyze_query_plan` or `ob_generate_performance_report` for performance questions.

## Safety Rules

- Keep all work read-only.
- Do not run or propose write SQL, DDL, DCL, procedure calls, sequence `NEXTVAL`, lock commands, file functions, sleep functions, or multi-statement SQL.
- Do not use `SELECT *`.
- Do not bypass profile, schema, table, tool, row, timeout, or output-size limits.
- Do not output executable index creation or schema change statements.
- Report truncation, masking, unstable ordering, and policy rejections plainly.

## Compatibility

- MySQL mode can use MySQL syntax such as `LIMIT`.
- Oracle mode needs Oracle-compatible object casing, pagination, and date expressions.
- Oracle procedures, functions, packages, synonyms, sequences, and views are metadata only.

## Output

Return the answer first. Include the SQL used, row count, page information, relevant warnings, and any assumptions. Keep wording direct and avoid broad claims not supported by the query result.
