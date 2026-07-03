import { markdownCell } from "../../query/output.js";

export interface OnboardingDocumentMarkdownInput {
  generatedAt: string;
  mode: string;
  schema?: string;
  tablePattern?: string | null;
  scope: {
    tableCount: number;
  };
  coreTables: Array<{
    schema?: string;
    table: string;
    purpose: {
      summary: string;
    };
    primaryKeys: string[];
    keyFields: string[];
    timeFields: string[];
    statusFields: string[];
    relationshipCount: number;
    rowEstimate?: {
      value: number;
    };
  }>;
  businessGlossary: {
    terms: Array<{
      term: string;
      description?: string;
      targets: Array<{
        schema?: string;
        table?: string;
        column?: string;
      }>;
      evidence: string[];
    }>;
  };
  relationships: Array<{
    relationType: string;
    confidence: number;
    sourceSchema?: string;
    sourceTable: string;
    sourceColumns: string[];
    targetSchema?: string;
    targetTable: string;
    targetColumns: string[];
    evidence: Array<{ detail: string }>;
  }>;
  queryEntryPoints: Array<{
    schema?: string;
    table: string;
    type: string;
    fields: unknown;
    reason: string;
  }>;
  readingPath: Array<{
    step: string;
    reason: string;
    table?: string;
    terms?: string[];
  }>;
  warnings: string[];
}

export function renderOnboardingDocumentMarkdown(document: OnboardingDocumentMarkdownInput, title?: string): string {
  const lines = [
    `# ${title ?? "OceanBase Onboarding Guide"}`,
    "",
    `Generated at: ${document.generatedAt}`,
    "",
    `Mode: ${document.mode}`,
    `Schema: ${document.schema ?? "default"}`,
    `Tables in scope: ${document.scope.tableCount}`,
    ""
  ];
  if (document.tablePattern) {
    lines.push(`Table pattern: ${document.tablePattern}`, "");
  }
  lines.push("## Core Tables", "");
  if (document.coreTables.length === 0) {
    lines.push("No visible tables matched the requested scope.", "");
  } else {
    lines.push("| Table | Purpose | Primary Keys | Key Fields | Time Fields | Status Fields | Relationships | Row Estimate |");
    lines.push("| --- | --- | --- | --- | --- | --- | --- | --- |");
    for (const table of document.coreTables) {
      lines.push(`| ${markdownCell(qualifiedTableName(table))} | ${markdownCell(table.purpose.summary)} | ${markdownCell(table.primaryKeys.join(", "))} | ${markdownCell(table.keyFields.join(", "))} | ${markdownCell(table.timeFields.join(", "))} | ${markdownCell(table.statusFields.join(", "))} | ${table.relationshipCount} | ${table.rowEstimate?.value ?? ""} |`);
    }
    lines.push("");
  }
  if (document.businessGlossary.terms.length > 0) {
    lines.push("## Business Terms", "");
    lines.push("| Term | Description | Targets | Evidence |");
    lines.push("| --- | --- | --- | --- |");
    for (const term of document.businessGlossary.terms) {
      lines.push(`| ${markdownCell(term.term)} | ${markdownCell(term.description ?? "")} | ${markdownCell(term.targets.map(glossaryTargetLabel).join(", "))} | ${markdownCell(term.evidence.join("; "))} |`);
    }
    lines.push("");
  }
  lines.push("## Relationships", "");
  if (document.relationships.length === 0) {
    lines.push("No visible relationships were found under the active policy.", "");
  } else {
    lines.push("| Type | Source | Target | Confidence | Evidence |");
    lines.push("| --- | --- | --- | --- | --- |");
    for (const relation of document.relationships) {
      const source = `${relation.sourceSchema ? `${relation.sourceSchema}.` : ""}${relation.sourceTable}(${relation.sourceColumns.join(", ")})`;
      const target = `${relation.targetSchema ? `${relation.targetSchema}.` : ""}${relation.targetTable}(${relation.targetColumns.join(", ")})`;
      lines.push(`| ${relation.relationType} | ${markdownCell(source)} | ${markdownCell(target)} | ${relation.confidence} | ${markdownCell(relation.evidence.map((item) => item.detail).join("; "))} |`);
    }
    lines.push("");
  }
  lines.push("## Query Entry Points", "");
  if (document.queryEntryPoints.length === 0) {
    lines.push("No query entry points were detected from visible metadata.", "");
  } else {
    lines.push("| Table | Type | Fields | Reason |");
    lines.push("| --- | --- | --- | --- |");
    for (const entry of document.queryEntryPoints.slice(0, 30)) {
      lines.push(`| ${markdownCell(`${entry.schema ? `${entry.schema}.` : ""}${entry.table}`)} | ${markdownCell(entry.type)} | ${markdownCell(formatQueryEntryFields(entry.fields))} | ${markdownCell(entry.reason)} |`);
    }
    lines.push("");
  }
  if (document.readingPath.length > 0) {
    lines.push("## Suggested Reading Path", "");
    for (const [index, item] of document.readingPath.entries()) {
      const subject = item.table ? ` ${item.table}` : item.terms ? ` ${item.terms.join(", ")}` : "";
      lines.push(`${index + 1}. ${item.step}${subject ? `: ${subject}` : ""}`);
      lines.push(`   Reason: ${item.reason}`);
    }
    lines.push("");
  }
  lines.push("## Notes", "");
  for (const warning of document.warnings) {
    lines.push(`- ${warning}`);
  }
  return lines.join("\n");
}

function qualifiedTableName(table: { schema?: string; table: string }): string {
  return `${table.schema ? `${table.schema}.` : ""}${table.table}`;
}

function glossaryTargetLabel(target: { schema?: string; table?: string; column?: string }): string {
  const table = `${target.schema ? `${target.schema}.` : ""}${target.table ?? "*"}`;
  return target.column ? `${table}.${target.column}` : table;
}

function formatQueryEntryFields(fields: unknown): string {
  if (!Array.isArray(fields)) {
    return "";
  }
  return fields.map((field) => {
    if (typeof field === "string") {
      return field;
    }
    if (field && typeof field === "object") {
      const record = field as Record<string, unknown>;
      const table = String(record.table ?? "");
      const columns = Array.isArray(record.columns) ? record.columns.join(", ") : "";
      return columns ? `${table}(${columns})` : table;
    }
    return String(field);
  }).filter(Boolean).join(", ");
}
