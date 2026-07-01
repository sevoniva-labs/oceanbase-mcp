import type { CompatibilityMode } from "./config.js";

export const SERVER_VERSION = "0.5.1";

export interface ToolCapability {
  name: string;
  since: string;
  group: string;
  mode: "all" | CompatibilityMode;
  description: string;
}

export const TOOL_CAPABILITIES: ToolCapability[] = [
  { name: "ob_list_profiles", since: "v0.3.0", group: "configuration", mode: "all", description: "List configured profiles with secrets redacted." },
  { name: "ob_config_diagnostics", since: "v0.3.0", group: "configuration", mode: "all", description: "Report deployment and policy checks." },
  { name: "ob_verify_permissions", since: "v0.4.0", group: "configuration", mode: "all", description: "Check current database grants for write or administrative privileges." },
  { name: "ob_check_opencode_setup", since: "v1.0.0", group: "assistant", mode: "all", description: "Check local OpenCode config, OceanBase agent, and query skill files." },
  { name: "ob_get_usage_guide", since: "v1.0.0", group: "assistant", mode: "all", description: "Return the recommended OpenCode workflow and safety rules." },
  { name: "ob_list_capabilities", since: "v1.0.0", group: "assistant", mode: "all", description: "List MCP tools, feature groups, versions, and read-only limits." },
  { name: "ob_ping", since: "v0.3.0", group: "connection", mode: "all", description: "Verify the OceanBase connection." },
  { name: "ob_policy_explain", since: "v0.3.0", group: "sql", mode: "all", description: "Explain whether SQL would be allowed." },
  { name: "ob_query_preview", since: "v0.5.1", group: "query", mode: "all", description: "Preview read-only policy and plan risk without returning data." },
  { name: "ob_query", since: "v0.3.0", group: "query", mode: "all", description: "Run strict read-only SQL." },
  { name: "ob_query_page", since: "v0.5.1", group: "query", mode: "all", description: "Run a paged read-only query." },
  { name: "ob_start_query_session", since: "v1.0.0", group: "query", mode: "all", description: "Start an in-memory read-only query context." },
  { name: "ob_get_query_session", since: "v1.0.0", group: "query", mode: "all", description: "Read a query session context without exposing stored parameter values." },
  { name: "ob_close_query_session", since: "v1.0.0", group: "query", mode: "all", description: "Close an in-memory query session." },
  { name: "ob_list_schemas", since: "v0.3.0", group: "metadata", mode: "all", description: "List visible schemas or databases." },
  { name: "ob_list_tables", since: "v0.3.0", group: "metadata", mode: "all", description: "List visible tables." },
  { name: "ob_describe_table", since: "v0.3.0", group: "metadata", mode: "all", description: "Return column metadata." },
  { name: "ob_get_schema_map", since: "v1.0.0", group: "metadata", mode: "all", description: "Return compact schema, table, key-field, and relationship summaries." },
  { name: "ob_get_database_dictionary", since: "v1.0.0", group: "metadata", mode: "all", description: "Generate bounded JSON or Markdown data dictionaries from visible metadata." },
  { name: "ob_search_catalog", since: "v0.3.0", group: "metadata", mode: "all", description: "Search schemas, tables, and columns." },
  { name: "ob_search_everything", since: "v1.0.0", group: "metadata", mode: "all", description: "Search schemas, tables, columns, comments, and business terms with evidence." },
  { name: "ob_search_business_glossary", since: "v0.5.1", group: "metadata", mode: "all", description: "Search visible business-term mappings." },
  { name: "ob_find_tables_by_business_term", since: "v1.0.0", group: "metadata", mode: "all", description: "Find candidate tables for a business term with evidence and related tables." },
  { name: "ob_find_columns", since: "v1.0.0", group: "metadata", mode: "all", description: "Find visible columns by name, comment, type, table pattern, or business term." },
  { name: "ob_get_table_summary", since: "v1.0.0", group: "metadata", mode: "all", description: "Summarize one table with inferred purpose, key fields, relationships, and query entry points." },
  { name: "ob_compare_tables", since: "v1.0.0", group: "metadata", mode: "all", description: "Compare two visible tables by columns, indexes, constraints, and partitions." },
  { name: "ob_compare_schemas", since: "v1.0.0", group: "metadata", mode: "all", description: "Compare two visible schemas by table list and bounded table metadata differences." },
  { name: "ob_get_table_schema", since: "v0.3.0", group: "metadata", mode: "all", description: "Return policy-filtered table schema." },
  { name: "ob_get_table_ddl", since: "v0.5.0", group: "metadata", mode: "all", description: "Return native or structured table DDL metadata." },
  { name: "ob_get_table_context", since: "v0.5.1", group: "metadata", mode: "all", description: "Return table context for SQL drafting and data inspection." },
  { name: "ob_find_related_tables", since: "v0.5.0", group: "relationships", mode: "all", description: "Find foreign-key and conservative naming-based relationships." },
  { name: "ob_get_table_stats", since: "v0.5.0", group: "metadata", mode: "all", description: "Return table estimates, counts, and storage statistics." },
  { name: "ob_profile_columns", since: "v0.5.1", group: "data_understanding", mode: "all", description: "Return bounded column profiles with sensitive values masked." },
  { name: "ob_prepare_query", since: "v1.0.0", group: "sql", mode: "all", description: "Prepare candidate tables, fields, SQL drafts, and safety previews from visible metadata." },
  { name: "ob_build_select", since: "v1.0.0", group: "sql", mode: "all", description: "Build parameterized read-only SELECT statements from validated structured input." },
  { name: "ob_lint_sql", since: "v1.0.0", group: "sql", mode: "all", description: "Lint read-only SQL for policy, dialect, pagination, ordering, sensitive fields, and plan risk." },
  { name: "ob_rewrite_sql", since: "v1.0.0", group: "sql", mode: "all", description: "Rewrite SELECT/WITH SQL into a safer read-only form without executing it." },
  { name: "ob_convert_sql_dialect", since: "v1.0.0", group: "sql", mode: "all", description: "Convert read-only SQL between OceanBase MySQL and Oracle modes with limitations." },
  { name: "ob_explain_error", since: "v1.0.0", group: "sql", mode: "all", description: "Explain SQL errors with policy context and visible metadata hints without executing SQL." },
  { name: "ob_generate_query_examples", since: "v1.0.0", group: "sql", mode: "all", description: "Generate scenario-based read-only SQL examples from visible table metadata." },
  { name: "ob_generate_query", since: "v0.5.0", group: "sql", mode: "all", description: "Generate read-only SQL templates from metadata." },
  { name: "ob_explain", since: "v0.3.0", group: "performance", mode: "all", description: "Run EXPLAIN for read-only SQL." },
  { name: "ob_analyze_query_plan", since: "v0.5.0", group: "performance", mode: "all", description: "Return evidence-based plan findings." },
  { name: "ob_generate_performance_report", since: "v0.5.0", group: "performance", mode: "all", description: "Generate a read-only performance advisory report." },
  { name: "ob_generate_er_diagram", since: "v0.5.0", group: "diagram", mode: "all", description: "Generate Mermaid and JSON ER metadata." },
  { name: "ob_get_indexes", since: "v0.3.0", group: "metadata", mode: "all", description: "Return table index metadata." },
  { name: "ob_get_constraints", since: "v0.3.0", group: "metadata", mode: "all", description: "Return primary, unique, foreign-key, check, and not-null constraints." },
  { name: "ob_get_partitions", since: "v0.3.0", group: "metadata", mode: "all", description: "Return table partition metadata." },
  { name: "ob_sample_rows", since: "v0.3.0", group: "query", mode: "all", description: "Return masked explicit-column sample rows." },
  { name: "ob_list_objects", since: "v0.5.0", group: "oracle_metadata", mode: "oracle", description: "List policy-filtered Oracle views, sequences, synonyms, procedures, functions, and packages." },
  { name: "ob_get_object_metadata", since: "v0.5.0", group: "oracle_metadata", mode: "oracle", description: "Return bounded metadata and source preview for one Oracle object." }
];

export function listCapabilities(input: {
  compatibility: CompatibilityMode;
  tools: ToolCapability[];
  profile: string;
}) {
  const groups = [...new Set(input.tools.map((tool) => tool.group))].sort();
  return {
    name: "ob-mcp",
    version: SERVER_VERSION,
    profile: input.profile,
    compatibility: input.compatibility,
    readOnly: {
      enforced: true,
      writeTools: false,
      blockedSql: ["DDL", "DCL", "DML", "procedure calls", "sequence NEXTVAL", "locks", "file functions", "sleep functions", "multi-statement SQL"]
    },
    groups,
    tools: input.tools
  };
}

export function buildUsageGuide(input: { compatibility: CompatibilityMode; profile: string }) {
  return {
    name: "OceanBase MCP usage guide",
    version: SERVER_VERSION,
    profile: input.profile,
    compatibility: input.compatibility,
    workflow: [
      "Search business terms, schemas, tables, and columns before writing SQL.",
      "Read table context before selecting columns or joins.",
      "Generate SQL with explicit columns only.",
      "Preview or explain policy and plan risk before execution.",
      "Use paged queries for data inspection.",
      "Summarize SQL, row count, page state, warnings, masking, and assumptions."
    ],
    safetyRules: [
      "Do not run or suggest write SQL, DDL, DCL, procedure calls, sequence NEXTVAL, locks, file functions, sleep functions, or multi-statement SQL.",
      "Do not use SELECT *.",
      "Do not bypass profile, schema, table, column, tool, row, timeout, or output-size limits.",
      "Treat business glossary matches as hints; verify with metadata tools."
    ],
    dialectNotes: {
      mysql: [
        "MySQL mode can use LIMIT/OFFSET.",
        "Use backticks only when identifiers require quoting."
      ],
      oracle: [
        "Oracle mode usually exposes unquoted object names in uppercase.",
        "Use OFFSET/FETCH for pagination.",
        "Use Oracle-compatible date expressions and object metadata tools."
      ]
    },
    recommendedTools: [
      "ob_search_catalog",
      "ob_search_business_glossary",
      "ob_get_table_context",
      "ob_query_preview",
      "ob_query_page",
      "ob_profile_columns",
      "ob_generate_er_diagram"
    ],
    erDiagram: {
      currentFormats: ["mermaid", "json"],
      plannedFormats: ["html-static", "html-interactive", "html-compact", "html-detailed", "markdown", "dot", "plantuml"],
      rule: "Relationships must come from metadata or relationship discovery evidence."
    }
  };
}
