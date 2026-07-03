import type { ObConfig } from "../../config.js";
import type { ErGraph, ErGraphDiagnostic } from "../../er-graph.js";
import { jsonByteLength } from "../../format.js";

export const SCHEMA_INLINE_ER_TABLE_RENDER_LIMIT = 25;

export interface ErResponseSummary {
  schema?: string;
  rootTable: string | null;
  businessTerm: string | null;
  relationshipMode: "none" | "foreign_key" | "inferred";
  maxTables: number;
  maxRelationships: number;
  tableCount: number;
}

export interface ErResponsePayload extends ErResponseSummary {
  warnings: string[];
  mermaid: string;
  diagram: {
    entities: unknown[];
    relationships: unknown[];
  };
  graph: ErGraph;
}

export function defaultErHtmlTitle(response: Pick<ErResponseSummary, "businessTerm" | "rootTable" | "schema">): string {
  if (response.businessTerm) {
    return `OceanBase ER Diagram - ${response.businessTerm}`;
  }
  if (response.rootTable) {
    return `OceanBase ER Diagram - ${response.rootTable}`;
  }
  return response.schema ? `OceanBase ER Diagram - ${response.schema}` : "OceanBase ER Diagram";
}

export function shouldSkipSchemaInlineErHtmlRender(
  response: Pick<ErResponseSummary, "tableCount">,
  input: { table?: string; tables?: string[]; businessTerm?: string }
): boolean {
  const explicitScope = Boolean(input.table || input.businessTerm || (input.tables && input.tables.length > 0));
  return !explicitScope && response.tableCount > SCHEMA_INLINE_ER_TABLE_RENDER_LIMIT;
}

export function formatErColumnLimitWarnings(tables: string[], columnLimit: number, omittedColumns: number): string[] {
  if (tables.length === 0) {
    return [];
  }
  const sample = tables.slice(0, 10).join(", ");
  const remaining = tables.length > 10 ? `, and ${tables.length - 10} more` : "";
  return [
    `Columns were limited to OB_ER_MAX_COLUMNS_PER_TABLE=${columnLimit} for ${tables.length} table(s); ${omittedColumns} column(s) were omitted. Sample: ${sample}${remaining}.`
  ];
}

export function erDiagnosticsFromWarnings(
  warnings: string[],
  context: {
    truncated: boolean;
    relationshipScopeLimited: boolean;
    filteredRelationshipCount: number;
  }
): ErGraphDiagnostic[] {
  const diagnostics: ErGraphDiagnostic[] = [];
  if (context.truncated) {
    diagnostics.push({
      level: "warning",
      code: "er_scope_truncated",
      message: "ER metadata was truncated by configured limits or timeout.",
      action: "Use a narrower schema/table scope or run a chunked ER export."
    });
  }
  if (context.relationshipScopeLimited) {
    diagnostics.push({
      level: "warning",
      code: "er_relationship_scope_limited",
      message: "Some related tables were omitted from the ER scope.",
      action: "Increase maxTables within the configured limit or inspect a smaller table neighborhood."
    });
  }
  if (context.filteredRelationshipCount > 0) {
    diagnostics.push({
      level: "note",
      code: "er_relationships_filtered",
      message: `${context.filteredRelationshipCount} relationship(s) were hidden by policy or confidence settings.`,
      action: "Review relationshipMode, minConfidence, and active access policy.",
      count: context.filteredRelationshipCount
    });
  }
  if (warnings.some((warning) => /Name-inferred relationships are disabled/i.test(warning))) {
    diagnostics.push({
      level: "note",
      code: "er_inferred_relationships_disabled",
      message: "Name-inferred relationships are disabled for this ER request.",
      action: "Use relationshipMode=inferred for a bounded explicit scope when database foreign keys are not available."
    });
  }
  return diagnostics;
}

export function fitErDiagramResponseForLimit<T extends ErResponsePayload>(
  response: T,
  config: Pick<ObConfig, "maxResultBytes">
): T | (Omit<T, "mermaid" | "diagram"> & {
  mermaidOmitted: boolean;
  diagramOmitted: boolean;
  graphOmitted: boolean;
  estimatedBytes: number;
}) {
  const estimatedBytes = jsonByteLength(response);
  if (estimatedBytes <= config.maxResultBytes * 0.75) {
    return response;
  }
  return {
    ...response,
    mermaid: "",
    diagram: {
      entities: [],
      relationships: []
    },
    graph: {
      ...response.graph,
      nodes: [],
      edges: []
    },
    mermaidOmitted: true,
    diagramOmitted: true,
    graphOmitted: true,
    estimatedBytes,
    warnings: uniqueStrings([
      ...response.warnings,
      `ER diagram metadata is ${estimatedBytes} bytes; Mermaid, graph nodes, graph edges, and JSON details were omitted to stay within OB_MAX_RESULT_BYTES. Use CLI ER export for the full artifact.`
    ])
  };
}

export function buildErExportCommand(
  response: Pick<
    ErResponseSummary,
    "schema" | "rootTable" | "businessTerm" | "relationshipMode" | "maxTables" | "maxRelationships"
  >,
  format: string,
  options: { tables?: string[]; output?: string; maxTables?: number; maxColumnsPerTable?: number } = {}
): string {
  const args = ["ob-mcp", "export-er"];
  if (response.schema) {
    args.push("--schema", shellArg(response.schema));
  }
  if (options.tables && options.tables.length > 0) {
    args.push("--tables", shellArg(options.tables.join(",")));
  } else if (response.rootTable) {
    args.push("--table", shellArg(response.rootTable));
  } else if (response.businessTerm) {
    args.push("--business-term", shellArg(response.businessTerm));
  }
  args.push("--relationship-mode", response.relationshipMode);
  args.push("--max-tables", String(options.maxTables ?? response.maxTables));
  args.push("--max-relationships", String(response.maxRelationships));
  if (options.maxColumnsPerTable) {
    args.push("--max-columns-per-table", String(options.maxColumnsPerTable));
  }
  args.push("--format", format.replace(/^html-/, ""));
  args.push("--out", shellArg(options.output ?? "er-output.html"));
  return args.join(" ");
}

function shellArg(value: string): string {
  return /^[A-Za-z0-9_./:-]+$/.test(value) ? value : `'${value.replace(/'/g, "'\\''")}'`;
}

function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const output = [];
  for (const value of values) {
    const normalized = value.trim().toLowerCase();
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    output.push(value);
  }
  return output;
}
