import type { ObConfig } from "../../config.js";
import { markdownCell } from "../../query/output.js";
import type { LintFinding } from "./sql-lint.js";
import type {
  projectQueryStructure,
  SnippetMetadataValidation
} from "./sql-snippet-metadata.js";
import type { ProjectQuerySource } from "./sql-snippet-source.js";

export function renderQueryDocumentMarkdown(document: {
  generatedAt: string;
  mode: ObConfig["compatibility"];
  source: ProjectQuerySource;
  sql: string;
  paramCount: number;
  executed: boolean;
  explainRun: boolean;
  allowed: boolean;
  severity: "low" | "medium" | "high";
  structure: ReturnType<typeof projectQueryStructure>;
  metadata: SnippetMetadataValidation;
  findings: LintFinding[];
  recommendations: string[];
  warnings: string[];
}, title?: string): string {
  const lines = [
    `# ${title ?? "Query Documentation"}`,
    "",
    `Generated at: ${document.generatedAt}`,
    "",
    `Mode: ${document.mode}`,
    `Executed: ${document.executed ? "yes" : "no"}`,
    `Allowed by current checks: ${document.allowed ? "yes" : "no"}`,
    `Severity: ${document.severity}`,
    `EXPLAIN run: ${document.explainRun ? "yes" : "no"}`,
    "",
    "## SQL",
    "",
    "```sql",
    document.sql,
    "```",
    ""
  ];
  lines.push("## Structure", "");
  lines.push(`Statement type: ${document.structure.statementType}`);
  lines.push(`Parameters: ${document.paramCount}`);
  lines.push(`Has WHERE: ${document.structure.shape.hasWhere ? "yes" : "no"}`);
  lines.push(`Has ORDER BY: ${document.structure.shape.hasOrderBy ? "yes" : "no"}`);
  lines.push(`Has row limit: ${document.structure.shape.hasRowLimit ? "yes" : "no"}`);
  lines.push(`Has JOIN: ${document.structure.shape.hasJoin ? "yes" : "no"}`, "");
  if (document.structure.filtersPreview) {
    lines.push(`Filter preview: ${document.structure.filtersPreview}`, "");
  }
  if (document.structure.orderByPreview) {
    lines.push(`Order preview: ${document.structure.orderByPreview}`, "");
  }
  lines.push("## Tables", "");
  if (document.structure.tables.length === 0) {
    lines.push("No table reference was parsed from the SQL.", "");
  } else {
    lines.push("| Schema | Table | Visible | Columns Checked | Unknown Columns |");
    lines.push("| --- | --- | --- | --- | --- |");
    for (const table of document.metadata.tables) {
      lines.push(`| ${markdownCell(table.schema ?? "")} | ${markdownCell(table.table)} | ${table.visible ? "YES" : "NO"} | ${markdownCell(table.checkedColumns.join(", "))} | ${markdownCell(table.unknownColumns.join(", "))} |`);
    }
    lines.push("");
  }
  lines.push("## Field Sources", "");
  const fieldRefs = [
    ...document.metadata.qualifiedColumnRefs.map((ref) => ({ kind: "qualified", ...ref })),
    ...document.metadata.bareColumnRefs.map((ref) => ({ kind: "bare", ...ref }))
  ];
  if (fieldRefs.length === 0) {
    lines.push("No column reference was parsed from the SQL.", "");
  } else {
    lines.push("| Kind | Column | Schema | Table | Status |");
    lines.push("| --- | --- | --- | --- | --- |");
    for (const ref of fieldRefs.slice(0, 80)) {
      const status = "ambiguous" in ref && ref.ambiguous ? "ambiguous" : ref.ok === false ? "unknown" : ref.ok === true ? "ok" : "";
      lines.push(`| ${ref.kind} | ${markdownCell(ref.column)} | ${markdownCell(ref.schema ?? "")} | ${markdownCell(ref.table ?? "")} | ${status} |`);
    }
    lines.push("");
  }
  if (document.findings.length > 0) {
    lines.push("## Findings", "");
    lines.push("| Severity | Rule | Message | Evidence |");
    lines.push("| --- | --- | --- | --- |");
    for (const finding of document.findings) {
      lines.push(`| ${finding.severity} | ${markdownCell(finding.rule)} | ${markdownCell(finding.message)} | ${markdownCell(finding.evidence.join("; "))} |`);
    }
    lines.push("");
  }
  if (document.recommendations.length > 0) {
    lines.push("## Recommendations", "");
    for (const recommendation of document.recommendations) {
      lines.push(`- ${recommendation}`);
    }
    lines.push("");
  }
  lines.push("## Notes", "");
  for (const warning of document.warnings) {
    lines.push(`- ${warning}`);
  }
  return lines.join("\n");
}
