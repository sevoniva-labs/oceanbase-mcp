import { markdownCell } from "../../query/output.js";

export interface TableDocumentMarkdownInput {
  generatedAt: string;
  mode: string;
  schema?: string;
  table: string;
  comment?: string;
  rowEstimate?: {
    value: number;
    source: string;
  };
  purpose: {
    summary: string;
    evidence: Array<{
      source: string;
      value: string;
      reason: string;
    }>;
  };
  columns: Array<{
    name: string;
    type?: string;
    nullable?: boolean | null;
    roles: string[];
    masked: boolean;
    comment?: string;
  }>;
  visibleColumnCount: number;
  columnsTruncated: boolean;
  primaryKeys: string[];
  uniqueKeys: Array<{
    name: string;
    columns: string[];
  }>;
  indexes: Array<{
    name: string;
    unique?: boolean | null;
    columns: string[];
  }>;
  constraints: Array<{
    name: string;
    type?: string;
    columns: string[];
  }>;
  partitions: Array<Record<string, unknown>>;
  relationships?: {
    relations: Array<{
      direction: string;
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
  };
  queryExamples?: {
    examples: Array<{
      title: string;
      purpose: string;
      sql: string;
      parameters: Array<{
        name: string;
        type?: string;
        description: string;
      }>;
    }>;
  };
  warnings: string[];
}

export function renderTableDocumentMarkdown(document: TableDocumentMarkdownInput, title?: string): string {
  const qualifiedName = `${document.schema ? `${document.schema}.` : ""}${document.table}`;
  const lines = [
    `# ${title ?? `Table Documentation: ${qualifiedName}`}`,
    "",
    `Generated at: ${document.generatedAt}`,
    "",
    `Mode: ${document.mode}`,
    `Table: ${qualifiedName}`,
    ""
  ];
  if (document.comment) {
    lines.push(`Comment: ${document.comment}`, "");
  }
  if (document.rowEstimate) {
    lines.push(`Row estimate: ${document.rowEstimate.value} (${document.rowEstimate.source})`, "");
  }
  lines.push("## Purpose", "", document.purpose.summary, "");
  if (document.purpose.evidence.length > 0) {
    lines.push("| Evidence | Value | Reason |", "| --- | --- | --- |");
    for (const item of document.purpose.evidence) {
      lines.push(`| ${markdownCell(item.source)} | ${markdownCell(item.value)} | ${markdownCell(item.reason)} |`);
    }
    lines.push("");
  }
  lines.push("## Columns", "");
  lines.push("| Column | Type | Nullable | Roles | Masked | Comment |");
  lines.push("| --- | --- | --- | --- | --- | --- |");
  for (const column of document.columns) {
    lines.push(`| ${markdownCell(column.name)} | ${markdownCell(column.type ?? "")} | ${column.nullable == null ? "" : column.nullable ? "YES" : "NO"} | ${markdownCell(column.roles.join(", "))} | ${column.masked ? "YES" : "NO"} | ${markdownCell(column.comment ?? "")} |`);
  }
  if (document.columnsTruncated) {
    lines.push("", `Only the first ${document.columns.length} of ${document.visibleColumnCount} visible columns are included.`, "");
  } else {
    lines.push("");
  }
  lines.push("## Keys And Indexes", "");
  lines.push(`Primary keys: ${document.primaryKeys.length > 0 ? document.primaryKeys.map(markdownCell).join(", ") : "None visible."}`, "");
  if (document.uniqueKeys.length > 0) {
    lines.push("| Unique Key | Columns |", "| --- | --- |");
    for (const key of document.uniqueKeys) {
      lines.push(`| ${markdownCell(key.name)} | ${markdownCell(key.columns.join(", "))} |`);
    }
    lines.push("");
  }
  if (document.indexes.length > 0) {
    lines.push("| Index | Unique | Columns |", "| --- | --- | --- |");
    for (const index of document.indexes) {
      lines.push(`| ${markdownCell(index.name)} | ${index.unique == null ? "" : index.unique ? "YES" : "NO"} | ${markdownCell(index.columns.join(", "))} |`);
    }
    lines.push("");
  }
  if (document.constraints.length > 0) {
    lines.push("## Constraints", "");
    lines.push("| Constraint | Type | Columns |", "| --- | --- | --- |");
    for (const constraint of document.constraints) {
      lines.push(`| ${markdownCell(constraint.name)} | ${markdownCell(constraint.type ?? "")} | ${markdownCell(constraint.columns.join(", "))} |`);
    }
    lines.push("");
  }
  if (document.partitions.length > 0) {
    lines.push("## Partitions", "");
    lines.push("| Partition | Subpartition | Method | Rows |", "| --- | --- | --- | --- |");
    for (const partition of document.partitions) {
      lines.push(`| ${markdownCell(String(partition.name ?? ""))} | ${markdownCell(String(partition.subpartition ?? ""))} | ${markdownCell(String(partition.method ?? ""))} | ${partition.rowEstimate ?? ""} |`);
    }
    lines.push("");
  }
  if (document.relationships) {
    lines.push("## Relationships", "");
    if (document.relationships.relations.length === 0) {
      lines.push("No visible relationships were found under the active policy.", "");
    } else {
      lines.push("| Direction | Type | Table | Columns | Confidence | Evidence |", "| --- | --- | --- | --- | --- | --- |");
      for (const relation of document.relationships.relations) {
        const table = relation.direction === "outbound"
          ? `${relation.targetSchema ? `${relation.targetSchema}.` : ""}${relation.targetTable}`
          : `${relation.sourceSchema ? `${relation.sourceSchema}.` : ""}${relation.sourceTable}`;
        const columns = relation.direction === "outbound" ? relation.sourceColumns : relation.targetColumns;
        lines.push(`| ${relation.direction} | ${relation.relationType} | ${markdownCell(table)} | ${markdownCell(columns.join(", "))} | ${relation.confidence} | ${markdownCell(relation.evidence.map((item) => item.detail).join("; "))} |`);
      }
      lines.push("");
    }
  }
  if (document.queryExamples) {
    lines.push("## Query Examples", "");
    for (const example of document.queryExamples.examples) {
      lines.push(`### ${example.title}`, "", `Purpose: ${example.purpose}`, "", "```sql", example.sql, "```", "");
      if (example.parameters.length > 0) {
        lines.push("| Parameter | Type | Description |", "| --- | --- | --- |");
        for (const parameter of example.parameters) {
          lines.push(`| ${markdownCell(parameter.name)} | ${markdownCell(parameter.type ?? "")} | ${markdownCell(parameter.description)} |`);
        }
        lines.push("");
      }
    }
  }
  lines.push("## Notes", "");
  for (const warning of document.warnings) {
    lines.push(`- ${warning}`);
  }
  return lines.join("\n");
}
