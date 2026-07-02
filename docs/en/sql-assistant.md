# SQL Assistance

[中文](../zh-CN/sql-assistant.md) | [Back](README.md)

SQL assistance is for local development. It does not replace human review. The tools only generate, check, or explain read-only SQL; data access still goes through MCP read-only policy, permissions, row caps, response-size caps, timeouts, audit logging, and masking.

## Recommended Workflow

1. Use `ob_search_everything`, `ob_find_tables_by_business_term`, or `ob_get_schema_map` to find candidate tables.
2. Use `ob_get_table_context`, `ob_find_columns`, or `ob_get_table_summary` to confirm columns, indexes, relationships, and sample limits.
3. Use `ob_prepare_query` or `ob_build_select` to draft read-only SQL.
4. Use `ob_lint_sql`, `ob_query_preview`, or `ob_policy_explain` to check risk.
5. Use `ob_query_page` or query sessions to page through results.

Do not guess table names, column names, or relationships. Candidates must include evidence and confidence. If they are not clear, inspect more metadata first.

## SQL Generation And Checks

| Tool | Purpose |
| --- | --- |
| `ob_prepare_query` | Prepares candidate tables, columns, SQL drafts, and risk previews from a natural-language question, business term, and visible metadata. |
| `ob_build_select` | Builds SELECT statements from structured input after table and column validation. |
| `ob_lint_sql` | Checks read-only policy, dialect, pagination, ordering, sensitive fields, and plan risk. |
| `ob_rewrite_sql` | Rewrites SELECT/WITH SQL into a safer read-only form and explains the change. |
| `ob_convert_sql_dialect` | Converts read-only queries between OceanBase MySQL and Oracle modes and states limitations. |
| `ob_explain_error` | Explains SQL errors using policy context and visible metadata without executing SQL. |
| `ob_generate_query_examples` | Generates common read-only examples from table context. |

Use `ob_build_select` when the table, columns, and filters are known. Use `ob_prepare_query` when the user describes a business question and the assistant still needs to locate the tables.

Parameterized SQL uses positional `?` placeholders. In Oracle compatibility mode, simple `:name` bind placeholders are also accepted when `params` is supplied as a positional array; prefer `?` in generated MCP calls to avoid ambiguity.

## Query Sessions

Query sessions are in-memory context only:

- `ob_start_query_session` records confirmed tables, columns, SQL, paging, and warnings.
- `ob_query_next_page` and `ob_query_prev_page` page through results while enforcing read-only policy and row caps.
- `ob_query_refine` adds columns, filters, ordering, or paging to the current context and returns new SQL with a risk preview.
- `ob_close_query_session` closes the session.

If a query has no stable ordering column, paging tools warn that result order is unstable.

## Project SQL

The `ob-mcp scan-sql` CLI scans `.sql`, `.xml`, `.ts`, `.js`, and `.java` files. It reports findings only and does not modify code. For database-level validation, pass a reported SQL snippet to:

- `ob_validate_sql_snippet`
- `ob_explain_project_query`
- `ob_find_unknown_columns_in_sql`
- `ob_generate_mapper_context`

These tools do not execute target SQL or modify business files.

Since v1.1.0, `scan-sql` can also write a SQL usage index:

```bash
ob-mcp scan-sql --path src --path mapper --index-out snapshots/sql-index.json --format text
```

Use `ob_find_sql_usages` to search that index by table, column, or business term. Use `ob_analyze_change_sql_impact` when a metadata diff needs to be checked against project SQL references. Both tools use static evidence and do not execute project SQL.
