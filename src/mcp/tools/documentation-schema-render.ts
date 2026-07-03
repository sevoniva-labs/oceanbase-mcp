import { markdownCell } from "../../query/output.js";

export interface SchemaDocumentMarkdownInput {
  generatedAt: string;
  mode: string;
  schema?: string;
  tablePattern?: string | null;
  tableCount: number;
  maxColumnsPerTable: number;
  tables: Array<{
    schema?: string;
    table: string;
    comment?: string;
    rowEstimate?: {
      value: number;
      source: string;
    };
    primaryKeys: string[];
    keyFields: string[];
    timeFields: string[];
    statusFields: string[];
    columns?: Array<{
      name: string;
      type?: string;
      nullable?: boolean | null;
      roles: string[];
      masked: boolean;
      comment?: string;
    }>;
    columnsTruncated?: boolean;
    relationSummary?: {
      outbound: number;
      inbound: number;
      inferred: number;
    };
  }>;
  warnings: string[];
}

export function renderSchemaDocumentMarkdown(document: SchemaDocumentMarkdownInput, title?: string): string {
  const lines = [
    `# ${title ?? `Schema Documentation: ${document.schema ?? "default"}`}`,
    "",
    `Generated at: ${document.generatedAt}`,
    "",
    `Mode: ${document.mode}`,
    `Schema: ${document.schema ?? "default"}`,
    `Tables: ${document.tableCount}`,
    ""
  ];
  if (document.tablePattern) {
    lines.push(`Table pattern: ${document.tablePattern}`, "");
  }
  lines.push("## Tables", "");
  if (document.tables.length === 0) {
    lines.push("No visible tables matched the requested scope.", "");
  }
  for (const table of document.tables) {
    const qualifiedName = `${table.schema ? `${table.schema}.` : ""}${table.table}`;
    lines.push(`### ${qualifiedName}`, "");
    if (table.comment) {
      lines.push(`Comment: ${table.comment}`, "");
    }
    if (table.rowEstimate) {
      lines.push(`Row estimate: ${table.rowEstimate.value} (${table.rowEstimate.source})`, "");
    }
    lines.push(`Primary keys: ${table.primaryKeys.length > 0 ? table.primaryKeys.map(markdownCell).join(", ") : "None visible."}`);
    lines.push(`Key fields: ${table.keyFields.length > 0 ? table.keyFields.map(markdownCell).join(", ") : "None detected."}`);
    lines.push(`Time fields: ${table.timeFields.length > 0 ? table.timeFields.map(markdownCell).join(", ") : "None detected."}`);
    lines.push(`Status fields: ${table.statusFields.length > 0 ? table.statusFields.map(markdownCell).join(", ") : "None detected."}`, "");
    if (table.columns && table.columns.length > 0) {
      lines.push("| Column | Type | Nullable | Roles | Masked | Comment |");
      lines.push("| --- | --- | --- | --- | --- | --- |");
      for (const column of table.columns) {
        lines.push(`| ${markdownCell(column.name)} | ${markdownCell(column.type ?? "")} | ${column.nullable == null ? "" : column.nullable ? "YES" : "NO"} | ${markdownCell(column.roles.join(", "))} | ${column.masked ? "YES" : "NO"} | ${markdownCell(column.comment ?? "")} |`);
      }
      if (table.columnsTruncated) {
        lines.push("", `Columns were truncated by maxColumnsPerTable (${document.maxColumnsPerTable}).`);
      }
      lines.push("");
    }
    if (table.relationSummary) {
      lines.push(`Relationships: outbound ${table.relationSummary.outbound}, inbound ${table.relationSummary.inbound}, inferred ${table.relationSummary.inferred}.`, "");
    }
  }
  lines.push("## Notes", "");
  for (const warning of document.warnings) {
    lines.push(`- ${warning}`);
  }
  return lines.join("\n");
}
