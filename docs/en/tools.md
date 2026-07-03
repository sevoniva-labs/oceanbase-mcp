# OceanBase MCP Tool List

[中文](../zh-CN/tools.md) | [Back to docs](README.md)

This list is sorted by the version in which each tool first appeared. Tools with the same version are sorted by tool name.

All tools remain under the same read-only safety boundary: profile permissions, schema/table/column policy, SQL policy, row caps, response-size caps, timeouts, concurrency limits, audit logging, and error redaction.

## Tools

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
| v1.0.0 | `ob_query_refine` | Build refined read-only SELECT SQL from a query session without executing SQL. |
| v1.0.0 | `ob_refresh_metadata_cache` | Clear in-memory metadata cache entries by profile, schema, or table scope. |
| v1.0.0 | `ob_rewrite_sql` | Rewrite SELECT/WITH SQL into a safer read-only form without executing SQL. |
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
