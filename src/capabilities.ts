import type { CompatibilityMode, ObConfig } from "./config.js";

export const SERVER_VERSION = "1.2.0";

export type ToolOperationType = "metadata" | "read_data" | "analysis" | "local_export";
export type ToolDataTouch = "none" | "metadata" | "query_rows" | "sampled_rows" | "local_artifact";

export interface ToolBudgetManifest {
  maxRows: string | null;
  maxBytes: string;
  maxTables: string | null;
  maxColumns: string | null;
  maxDbCalls: string;
  timeoutMs: string;
}

export interface ToolSmokeManifest {
  mysql: boolean;
  oracle: boolean;
}

export interface ResolvedToolBudget {
  maxRows: number | null;
  maxBytes: number;
  maxTables: number | null;
  maxColumns: number | null;
  maxRelationships: number | null;
  maxDbCalls: number | null;
  timeoutMs: number;
}

export interface ToolCapability {
  name: string;
  since: string;
  group: string;
  mode: "all" | CompatibilityMode;
  description: string;
  operationType: ToolOperationType;
  readOnly: true;
  dataTouch: ToolDataTouch;
  requiresSqlGuard: boolean;
  requiresProfilePolicy: boolean;
  requiresAuditLog: true;
  budget: ToolBudgetManifest;
  mysqlSmoke: boolean;
  oracleSmoke: boolean;
  smoke: ToolSmokeManifest;
}

type ToolCapabilitySeed = Pick<ToolCapability, "name" | "since" | "group" | "mode" | "description">;

const TOOL_CAPABILITY_SEEDS: ToolCapabilitySeed[] = [
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
  { name: "ob_query_next_page", since: "v1.0.0", group: "query", mode: "all", description: "Run the next page for a read-only query session." },
  { name: "ob_query_prev_page", since: "v1.0.0", group: "query", mode: "all", description: "Run the previous page for a read-only query session." },
  { name: "ob_query_refine", since: "v1.0.0", group: "query", mode: "all", description: "Build refined read-only SELECT SQL from a query session without executing it." },
  { name: "ob_summarize_result", since: "v1.0.0", group: "query", mode: "all", description: "Summarize already returned rows without reading the database." },
  { name: "ob_compare_query_results", since: "v1.0.0", group: "query", mode: "all", description: "Compare two already returned query results without reading the database." },
  { name: "ob_export_result_preview", since: "v1.0.0", group: "query", mode: "all", description: "Generate bounded Markdown or CSV preview text without writing files." },
  { name: "ob_list_schemas", since: "v0.3.0", group: "metadata", mode: "all", description: "List visible schemas or databases." },
  { name: "ob_list_tables", since: "v0.3.0", group: "metadata", mode: "all", description: "List visible tables." },
  { name: "ob_describe_table", since: "v0.3.0", group: "metadata", mode: "all", description: "Return column metadata." },
  { name: "ob_get_cache_status", since: "v1.0.0", group: "configuration", mode: "all", description: "Return profile-scoped metadata cache status without exposing cached content." },
  { name: "ob_get_schema_map", since: "v1.0.0", group: "metadata", mode: "all", description: "Return compact schema, table, key-field, and relationship summaries." },
  { name: "ob_get_database_dictionary", since: "v1.0.0", group: "metadata", mode: "all", description: "Generate bounded JSON or Markdown data dictionaries from visible metadata." },
  { name: "ob_generate_data_dictionary", since: "v1.0.0", group: "documentation", mode: "all", description: "Generate bounded JSON, Markdown, or simple HTML data dictionaries from visible metadata." },
  { name: "ob_search_catalog", since: "v0.3.0", group: "metadata", mode: "all", description: "Search schemas, tables, and columns." },
  { name: "ob_search_everything", since: "v1.0.0", group: "metadata", mode: "all", description: "Search schemas, tables, columns, comments, and business terms with evidence." },
  { name: "ob_search_business_glossary", since: "v0.5.1", group: "metadata", mode: "all", description: "Search visible business-term mappings." },
  { name: "ob_find_tables_by_business_term", since: "v1.0.0", group: "metadata", mode: "all", description: "Find candidate tables for a business term with evidence and related tables." },
  { name: "ob_find_columns", since: "v1.0.0", group: "metadata", mode: "all", description: "Find visible columns by name, comment, type, table pattern, or business term." },
  { name: "ob_get_table_summary", since: "v1.0.0", group: "metadata", mode: "all", description: "Summarize one table with inferred purpose, key fields, relationships, and query entry points." },
  { name: "ob_compare_tables", since: "v1.0.0", group: "metadata", mode: "all", description: "Compare two visible tables by columns, indexes, constraints, and partitions." },
  { name: "ob_compare_schemas", since: "v1.0.0", group: "metadata", mode: "all", description: "Compare two visible schemas by table list and bounded table metadata differences." },
  { name: "ob_analyze_change_sql_impact", since: "v1.1.0", group: "metadata_change", mode: "all", description: "Analyze indexed project SQL impact from metadata snapshot changes." },
  { name: "ob_analyze_metadata_impact", since: "v1.1.0", group: "metadata_change", mode: "all", description: "Summarize metadata diff impact using SQL index, relationship changes, and glossary hints." },
  { name: "ob_capture_metadata_snapshot", since: "v1.1.0", group: "metadata_change", mode: "all", description: "Capture bounded metadata-only snapshots for offline diff and impact analysis." },
  { name: "ob_compare_metadata_snapshots", since: "v1.1.0", group: "metadata_change", mode: "all", description: "Compare metadata snapshots and return evidence-based structural changes." },
  { name: "ob_generate_metadata_change_report", since: "v1.1.0", group: "metadata_change", mode: "all", description: "Generate Markdown or simple HTML reports from metadata diff and impact evidence." },
  { name: "ob_get_table_schema", since: "v0.3.0", group: "metadata", mode: "all", description: "Return policy-filtered table schema." },
  { name: "ob_get_table_ddl", since: "v0.5.0", group: "metadata", mode: "all", description: "Return native or structured table DDL metadata." },
  { name: "ob_get_table_context", since: "v0.5.1", group: "metadata", mode: "all", description: "Return table context for SQL drafting and data inspection." },
  { name: "ob_find_related_tables", since: "v0.5.0", group: "relationships", mode: "all", description: "Find foreign-key and conservative naming-based relationships." },
  { name: "ob_get_table_stats", since: "v0.5.0", group: "metadata", mode: "all", description: "Return table estimates, counts, and storage statistics." },
  { name: "ob_profile_table", since: "v1.0.0", group: "data_understanding", mode: "all", description: "Return bounded table-level profiles with metadata counts and sampled field signals." },
  { name: "ob_profile_columns", since: "v0.5.1", group: "data_understanding", mode: "all", description: "Return bounded column profiles with masking, type strategy, and enum signals." },
  { name: "ob_refresh_metadata_cache", since: "v1.0.0", group: "configuration", mode: "all", description: "Clear profile-scoped metadata cache entries by profile, schema, or table scope." },
  { name: "ob_get_value_distribution", since: "v1.0.0", group: "data_understanding", mode: "all", description: "Return bounded top-value distribution for one visible column." },
  { name: "ob_detect_time_columns", since: "v1.0.0", group: "data_understanding", mode: "all", description: "Detect likely create, update, and business time columns from metadata." },
  { name: "ob_detect_dimension_columns", since: "v1.0.0", group: "data_understanding", mode: "all", description: "Detect likely status, type, channel, region, flag, and category columns from metadata." },
  { name: "ob_find_recent_rows", since: "v1.0.0", group: "query", mode: "all", description: "Read recent rows using an explicit or detected time column with safe pagination." },
  { name: "ob_check_data_quality", since: "v1.0.0", group: "data_understanding", mode: "all", description: "Run bounded read-only checks for nulls, duplicate key risk, dimensions, and time columns." },
  { name: "ob_prepare_query", since: "v1.0.0", group: "sql", mode: "all", description: "Prepare candidate tables, fields, SQL drafts, and safety previews from visible metadata." },
  { name: "ob_build_select", since: "v1.0.0", group: "sql", mode: "all", description: "Build parameterized read-only SELECT statements from validated structured input." },
  { name: "ob_lint_sql", since: "v1.0.0", group: "sql", mode: "all", description: "Lint read-only SQL for policy, dialect, pagination, ordering, sensitive fields, and plan risk." },
  { name: "ob_validate_sql_snippet", since: "v1.0.0", group: "sql", mode: "all", description: "Validate pasted SQL snippets for policy, dialect, pagination, risk, and visible table or column metadata." },
  { name: "ob_explain_project_query", since: "v1.0.0", group: "sql", mode: "all", description: "Explain project SQL from text or a local file without executing it." },
  { name: "ob_find_sql_usages", since: "v1.1.0", group: "metadata_change", mode: "all", description: "Find table, column, or business-term usages from a static SQL usage index." },
  { name: "ob_generate_mapper_context", since: "v1.0.0", group: "sql", mode: "all", description: "Generate table and column context for mapper or SQL files without modifying code." },
  { name: "ob_find_unknown_columns_in_sql", since: "v1.0.0", group: "sql", mode: "all", description: "Find unknown tables and columns in SQL with visible metadata-based candidates." },
  { name: "ob_generate_table_doc", since: "v1.0.0", group: "documentation", mode: "all", description: "Generate bounded JSON or Markdown documentation for one visible table." },
  { name: "ob_generate_schema_doc", since: "v1.0.0", group: "documentation", mode: "all", description: "Generate bounded JSON or Markdown documentation for visible tables in one schema." },
  { name: "ob_generate_query_doc", since: "v1.0.0", group: "documentation", mode: "all", description: "Generate bounded JSON or Markdown documentation for a SQL snippet without executing it." },
  { name: "ob_generate_onboarding_doc", since: "v1.0.0", group: "documentation", mode: "all", description: "Generate bounded onboarding documentation from visible metadata and business glossary hints." },
  { name: "ob_rewrite_sql", since: "v1.0.0", group: "sql", mode: "all", description: "Rewrite SELECT/WITH SQL into a safer read-only form without executing it." },
  { name: "ob_convert_sql_dialect", since: "v1.0.0", group: "sql", mode: "all", description: "Convert read-only SQL between OceanBase MySQL and Oracle modes with limitations." },
  { name: "ob_explain_error", since: "v1.0.0", group: "sql", mode: "all", description: "Explain SQL errors with policy context and visible metadata hints without executing SQL." },
  { name: "ob_generate_query_examples", since: "v1.0.0", group: "sql", mode: "all", description: "Generate scenario-based read-only SQL examples from visible table metadata." },
  { name: "ob_generate_query", since: "v0.5.0", group: "sql", mode: "all", description: "Generate read-only SQL templates from metadata." },
  { name: "ob_explain", since: "v0.3.0", group: "performance", mode: "all", description: "Run EXPLAIN for read-only SQL." },
  { name: "ob_analyze_query_plan", since: "v0.5.0", group: "performance", mode: "all", description: "Return evidence-based plan findings." },
  { name: "ob_generate_performance_report", since: "v0.5.0", group: "performance", mode: "all", description: "Generate a read-only performance advisory report." },
  { name: "ob_generate_er_diagram", since: "v0.5.0", group: "diagram", mode: "all", description: "Generate Mermaid and JSON ER metadata; v1.2.0 adds stable graph IDs and relationship classes for metadata maps." },
  { name: "ob_generate_er_html", since: "v1.0.0", group: "diagram", mode: "all", description: "Generate self-contained ER HTML; v1.2.0 uses an interactive graph canvas with stable IDs and evidence panels." },
  { name: "ob_generate_entity_diagram", since: "v1.0.0", group: "diagram", mode: "all", description: "Generate local entity diagrams from a business term or table with Mermaid, JSON, HTML, and relationship evidence." },
  { name: "ob_explain_relationship", since: "v1.0.0", group: "diagram", mode: "all", description: "Explain visible relationship evidence and confidence between two tables without inventing missing links." },
  { name: "ob_generate_er_document", since: "v1.0.0", group: "diagram", mode: "all", description: "Generate Markdown, PlantUML, and DOT ER documentation from allowed metadata and relationship evidence." },
  { name: "ob_plan_er_export", since: "v1.1.1", group: "diagram", mode: "all", description: "Estimate large-schema ER size and plan local cluster ER export commands with relationship and diagnostics metadata." },
  { name: "ob_get_indexes", since: "v0.3.0", group: "metadata", mode: "all", description: "Return table index metadata." },
  { name: "ob_get_constraints", since: "v0.3.0", group: "metadata", mode: "all", description: "Return primary, unique, foreign-key, check, and not-null constraints." },
  { name: "ob_get_partitions", since: "v0.3.0", group: "metadata", mode: "all", description: "Return table partition metadata." },
  { name: "ob_sample_rows", since: "v0.3.0", group: "query", mode: "all", description: "Return masked explicit-column sample rows." },
  { name: "ob_list_objects", since: "v0.5.0", group: "oracle_metadata", mode: "oracle", description: "List policy-filtered Oracle views, sequences, synonyms, procedures, functions, and packages." },
  { name: "ob_get_object_metadata", since: "v0.5.0", group: "oracle_metadata", mode: "oracle", description: "Return bounded metadata and source preview for one Oracle object." }
];

export const TOOL_CAPABILITIES: ToolCapability[] = TOOL_CAPABILITY_SEEDS.map(buildToolCapability);
const TOOL_CAPABILITY_BY_NAME = new Map(TOOL_CAPABILITIES.map((tool) => [tool.name, tool]));

export function getToolCapability(name: string): ToolCapability | undefined {
  return TOOL_CAPABILITY_BY_NAME.get(name);
}

export function assertToolManifest(name: string): ToolCapability {
  const manifest = getToolCapability(name);
  if (!manifest) {
    throw new Error(`Tool "${name}" is missing a tool manifest entry.`);
  }
  if (manifest.readOnly !== true) {
    throw new Error(`Tool "${name}" is not declared read-only.`);
  }
  if (!["metadata", "read_data", "analysis", "local_export"].includes(manifest.operationType)) {
    throw new Error(`Tool "${name}" has an invalid operation type.`);
  }
  if (!manifest.requiresAuditLog) {
    throw new Error(`Tool "${name}" must require audit logging.`);
  }
  assertBudgetManifest(name, manifest.budget);
  assertSmokeManifest(name, manifest);
  if (manifest.operationType === "read_data" && !manifest.requiresSqlGuard) {
    throw new Error(`Read-data tool "${name}" must require the SQL guard.`);
  }
  if (manifest.dataTouch !== "none" && !manifest.requiresProfilePolicy) {
    throw new Error(`Tool "${name}" touches data or metadata and must require profile policy checks.`);
  }
  return manifest;
}

export function resolveToolBudget(tool: ToolCapability | string, config: ObConfig): ResolvedToolBudget {
  const manifest = typeof tool === "string" ? assertToolManifest(tool) : assertToolManifest(tool.name);
  return {
    maxRows: manifest.budget.maxRows === "profile.maxRows" ? config.maxRows : null,
    maxBytes: config.maxResultBytes,
    maxTables: manifest.budget.maxTables === "profile.erMaxTables" ? config.erMaxTables : null,
    maxColumns: manifest.budget.maxColumns === "profile.erMaxColumnsPerTable" ? config.erMaxColumnsPerTable : null,
    maxRelationships: manifest.group === "diagram" || manifest.name === "ob_plan_er_export" ? config.erMaxRelationships : null,
    maxDbCalls: null,
    timeoutMs: manifest.budget.timeoutMs === "profile.erTotalTimeoutMs" ? config.erTotalTimeoutMs : config.queryTimeoutMs
  };
}

function assertBudgetManifest(name: string, budget: ToolBudgetManifest) {
  if (!budget || typeof budget !== "object") {
    throw new Error(`Tool "${name}" is missing execution budget metadata.`);
  }
  const optionalBudgetKeys = ["maxRows", "maxTables", "maxColumns"] as const;
  for (const key of optionalBudgetKeys) {
    if (!(key in budget) || (budget[key] !== null && typeof budget[key] !== "string")) {
      throw new Error(`Tool "${name}" has an invalid ${key} budget declaration.`);
    }
  }
  const requiredBudgetKeys = ["maxBytes", "maxDbCalls", "timeoutMs"] as const;
  for (const key of requiredBudgetKeys) {
    if (typeof budget[key] !== "string" || budget[key].trim().length === 0) {
      throw new Error(`Tool "${name}" has an invalid ${key} budget declaration.`);
    }
  }
}

function assertSmokeManifest(name: string, manifest: ToolCapability) {
  if (typeof manifest.mysqlSmoke !== "boolean" || typeof manifest.oracleSmoke !== "boolean") {
    throw new Error(`Tool "${name}" is missing MySQL or Oracle smoke coverage metadata.`);
  }
  if (!manifest.smoke || manifest.smoke.mysql !== manifest.mysqlSmoke || manifest.smoke.oracle !== manifest.oracleSmoke) {
    throw new Error(`Tool "${name}" has inconsistent smoke coverage metadata.`);
  }
  if (manifest.mode === "mysql" && !manifest.mysqlSmoke) {
    throw new Error(`MySQL-only tool "${name}" must declare MySQL smoke coverage.`);
  }
  if (manifest.mode === "oracle" && !manifest.oracleSmoke) {
    throw new Error(`Oracle-only tool "${name}" must declare Oracle smoke coverage.`);
  }
  if (manifest.mode === "all" && (!manifest.mysqlSmoke || !manifest.oracleSmoke)) {
    throw new Error(`Cross-mode tool "${name}" must declare MySQL and Oracle smoke coverage.`);
  }
}

function buildToolCapability(seed: ToolCapabilitySeed): ToolCapability {
  const operationType = operationTypeForGroup(seed.group);
  const smoke = smokeForMode(seed.mode);
  return {
    ...seed,
    operationType,
    readOnly: true,
    dataTouch: dataTouchFor(seed.name, seed.group, operationType),
    requiresSqlGuard: requiresSqlGuard(seed.name, seed.group, operationType),
    requiresProfilePolicy: requiresProfilePolicy(seed.name, seed.group),
    requiresAuditLog: true,
    budget: budgetFor(seed.name, seed.group, operationType),
    mysqlSmoke: smoke.mysql,
    oracleSmoke: smoke.oracle,
    smoke
  };
}

function operationTypeForGroup(group: string): ToolOperationType {
  switch (group) {
    case "query":
      return "read_data";
    case "documentation":
      return "local_export";
    case "configuration":
    case "connection":
    case "metadata":
    case "oracle_metadata":
      return "metadata";
    default:
      return "analysis";
  }
}

function dataTouchFor(name: string, group: string, operationType: ToolOperationType): ToolDataTouch {
  if (name === "ob_check_opencode_setup" || name === "ob_list_capabilities" || name === "ob_get_usage_guide") {
    return "none";
  }
  if (operationType === "local_export") {
    return "local_artifact";
  }
  if (group === "query") {
    return name === "ob_summarize_result" || name === "ob_compare_query_results" || name === "ob_export_result_preview"
      ? "none"
      : "query_rows";
  }
  if (group === "data_understanding") {
    return "sampled_rows";
  }
  return "metadata";
}

function requiresSqlGuard(name: string, group: string, operationType: ToolOperationType): boolean {
  if (name === "ob_policy_explain" || name === "ob_query_preview" || name === "ob_query" || name === "ob_query_page") {
    return true;
  }
  if (group === "sql" || group === "performance") {
    return true;
  }
  return operationType === "read_data";
}

function requiresProfilePolicy(name: string, group: string): boolean {
  if (name === "ob_check_opencode_setup") {
    return false;
  }
  return group !== "assistant";
}

function budgetFor(name: string, group: string, operationType: ToolOperationType): ToolBudgetManifest {
  if (group === "diagram" || name === "ob_plan_er_export") {
    return {
      maxRows: null,
      maxBytes: "profile.maxResultBytes",
      maxTables: "profile.erMaxTables",
      maxColumns: "profile.erMaxColumnsPerTable",
      maxDbCalls: "bounded by ER batch/window planning",
      timeoutMs: "profile.erTotalTimeoutMs"
    };
  }
  if (group === "metadata_change" || operationType === "local_export") {
    return {
      maxRows: null,
      maxBytes: "profile.maxResultBytes",
      maxTables: "tool input limit",
      maxColumns: "tool input limit",
      maxDbCalls: "bounded by snapshot/report scope",
      timeoutMs: "profile.queryTimeoutMs"
    };
  }
  return {
    maxRows: operationType === "read_data" || group === "data_understanding" ? "profile.maxRows" : null,
    maxBytes: "profile.maxResultBytes",
    maxTables: "tool input limit",
    maxColumns: "tool input limit",
    maxDbCalls: "bounded by tool implementation",
    timeoutMs: "profile.queryTimeoutMs"
  };
}

function smokeForMode(mode: ToolCapability["mode"]): ToolSmokeManifest {
  return {
    mysql: mode === "all" || mode === "mysql",
    oracle: mode === "all" || mode === "oracle"
  };
}

function compareToolCapabilities(left: ToolCapability, right: ToolCapability): number {
  const versionOrder = compareCapabilityVersions(left.since, right.since);
  if (versionOrder !== 0) {
    return versionOrder;
  }
  return left.name.localeCompare(right.name);
}

function compareCapabilityVersions(left: string, right: string): number {
  const leftVersion = parseCapabilityVersion(left);
  const rightVersion = parseCapabilityVersion(right);
  for (let i = 0; i < 3; i += 1) {
    if (leftVersion[i] !== rightVersion[i]) {
      return leftVersion[i] - rightVersion[i];
    }
  }
  return 0;
}

function parseCapabilityVersion(value: string): [number, number, number] {
  const match = /^v(\d+)\.(\d+)\.(\d+)$/.exec(value);
  if (!match) {
    return [Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER];
  }
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function listCapabilities(input: {
  compatibility: CompatibilityMode;
  tools: ToolCapability[];
  profile: string;
}) {
  const tools = [...input.tools].sort(compareToolCapabilities);
  const groups = [...new Set(tools.map((tool) => tool.group))].sort();
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
    tools
  };
}

export function buildUsageGuide(input: { compatibility: CompatibilityMode; profile: string }) {
  return {
    name: "OceanBase MCP usage guide",
    version: SERVER_VERSION,
    profile: input.profile,
    compatibility: input.compatibility,
    workflow: [
      "Search business terms, schemas, tables, columns, comments, and glossary hints before writing SQL.",
      "Read table context, schema map, table summary, or onboarding documentation before selecting columns or joins.",
      "Use ob_prepare_query or ob_build_select to generate explicit-column read-only SQL.",
      "Use ob_lint_sql or ob_query_preview before execution.",
      "Use query sessions and paged queries for data inspection.",
      "Use profiling, ER, dictionary, and documentation tools when the user asks for structure or data understanding.",
      "Summarize SQL, row count, page state, warnings, masking, truncation, and assumptions."
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
      "ob_search_everything",
      "ob_search_business_glossary",
      "ob_get_schema_map",
      "ob_get_table_context",
      "ob_prepare_query",
      "ob_build_select",
      "ob_lint_sql",
      "ob_query_preview",
      "ob_start_query_session",
      "ob_query_page",
      "ob_query_next_page",
      "ob_summarize_result",
      "ob_profile_columns",
      "ob_generate_er_html",
      "ob_generate_data_dictionary",
      "ob_generate_onboarding_doc"
    ],
    erDiagram: {
      currentFormats: ["mermaid", "json", "html-static", "html-interactive", "html-compact", "html-detailed", "markdown", "dot", "plantuml"],
      rule: "Relationships must come from metadata or relationship discovery evidence."
    }
  };
}
