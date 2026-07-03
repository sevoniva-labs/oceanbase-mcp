import {
  parseMetadataComparisonInput,
  renderMetadataComparisonMarkdown,
  type MetadataSnapshotComparison
} from "./metadata-change.js";
import type { MetadataImpactOutput } from "./metadata-impact.js";

export type MetadataChangeReportFormat = "markdown" | "html";

export interface GenerateMetadataChangeReportInput {
  metadataDiff: MetadataSnapshotComparison | string | Record<string, unknown>;
  impact?: MetadataImpactOutput | string | Record<string, unknown>;
  title?: string;
  format?: MetadataChangeReportFormat;
  summaryOnly?: boolean;
}

export interface MetadataChangeReportOutput {
  reportVersion: "1.1";
  title: string;
  format: MetadataChangeReportFormat;
  contentType: "text/markdown" | "text/html";
  markdown?: string;
  html?: string;
  summary: MetadataSnapshotComparison["summary"] & {
    impactedSql?: number;
    impactedFiles?: number;
  };
  warnings: string[];
  executed: false;
}

export function generateMetadataChangeReport(input: GenerateMetadataChangeReportInput): MetadataChangeReportOutput {
  const diff = parseMetadataComparisonInput(input.metadataDiff);
  const impact = input.impact ? parseMetadataImpactInput(input.impact) : undefined;
  const title = input.title?.trim() || "OceanBase Metadata Change Report";
  const markdown = renderMetadataChangeReportMarkdown(diff, impact, title, input.summaryOnly ?? false);
  const format = input.format ?? "markdown";

  return {
    reportVersion: "1.1",
    title,
    format,
    contentType: format === "html" ? "text/html" : "text/markdown",
    markdown: format === "markdown" ? markdown : undefined,
    html: format === "html" ? renderMetadataChangeReportHtml(markdown, title) : undefined,
    summary: {
      ...diff.summary,
      impactedSql: impact?.summary.impactedSql,
      impactedFiles: impact?.summary.impactedFiles
    },
    warnings: [
      ...diff.warnings,
      ...(impact?.warnings ?? []),
      "Report is generated from supplied metadata diff and impact evidence only.",
      "No executable DDL, DCL, or DML is included."
    ],
    executed: false
  };
}

function renderMetadataChangeReportMarkdown(
  diff: MetadataSnapshotComparison,
  impact: MetadataImpactOutput | undefined,
  title: string,
  summaryOnly: boolean
): string {
  const lines = [
    `# ${title}`,
    "",
    "## Iteration Scope",
    "",
    `- Before snapshot: ${diff.before.capturedAt ?? "(unknown)"}`,
    `- After snapshot: ${diff.after.capturedAt ?? "(unknown)"}`,
    `- Compatibility: ${diff.after.compatibility ?? diff.before.compatibility ?? "(unknown)"}`,
    "",
    "## Change Summary",
    "",
    `- Total changes: ${diff.summary.totalChanges}`,
    `- Breaking changes: ${diff.summary.breakingChanges}`,
    `- Impacted SQL: ${impact?.summary.impactedSql ?? 0}`,
    `- Impacted files: ${impact?.summary.impactedFiles ?? 0}`,
    ""
  ];

  if (diff.breakingChanges.length > 0) {
    lines.push("## Breaking Changes", "");
    for (const change of diff.breakingChanges) {
      lines.push(`- ${change.category} ${changeObjectLabel(change)}: ${change.evidence.join("; ")}`);
    }
    lines.push("");
  }

  if (!summaryOnly) {
    lines.push(renderMetadataComparisonMarkdown(diff, "Metadata Diff Details"));
    lines.push("");
  }

  if (impact) {
    lines.push("## SQL Impact", "");
    if (impact.sqlImpact && impact.sqlImpact.impacts.length > 0) {
      lines.push("| File | Line | Match | Evidence | Risks |");
      lines.push("| --- | ---: | --- | --- | --- |");
      for (const item of impact.sqlImpact.impacts.slice(0, summaryOnly ? 20 : 200)) {
        lines.push(`| ${markdownCell(item.file)} | ${item.line} | ${item.matchLevel} | ${markdownCell(item.evidence.join("; "))} | ${markdownCell(item.risks.join(", "))} |`);
      }
      lines.push("");
    } else {
      lines.push("No SQL usage impact was found from the supplied SQL index.", "");
    }

    if (impact.relationshipImpact.length > 0) {
      lines.push("## Upstream And Downstream", "");
      for (const relation of impact.relationshipImpact) {
        lines.push(`- ${relation.changeType}: ${relation.object} (${relation.evidence.join("; ")})`);
      }
      lines.push("");
    }

    if (impact.glossaryHints.length > 0) {
      lines.push("## Business Glossary Hints", "");
      for (const hint of impact.glossaryHints) {
        lines.push(`- ${hint.term}: ${hint.target} (${hint.evidence.join("; ")})`);
      }
      lines.push("");
    }

    if (impact.reviewItems.length > 0) {
      lines.push("## Review Items", "");
      for (const item of impact.reviewItems) {
        lines.push(`- ${item}`);
      }
      lines.push("");
    }
  }

  lines.push("## Evidence And Limits", "");
  for (const warning of [...diff.warnings, ...(impact?.warnings ?? [])]) {
    lines.push(`- ${warning}`);
  }
  lines.push("- This report does not include executable DDL, DCL, DML, GRANT, or procedure calls.");
  return lines.join("\n");
}

function renderMetadataChangeReportHtml(markdown: string, title: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 32px; color: #1f2937; line-height: 1.55; }
    pre { white-space: pre-wrap; word-break: break-word; background: #f8fafc; border: 1px solid #e5e7eb; padding: 16px; border-radius: 6px; }
  </style>
</head>
<body>
  <pre>${escapeHtml(markdown)}</pre>
</body>
</html>`;
}

function parseMetadataImpactInput(value: MetadataImpactOutput | string | Record<string, unknown>): MetadataImpactOutput {
  const parsed = typeof value === "string" ? JSON.parse(value) : value;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("impact must be a metadata impact object or JSON string.");
  }
  const record = parsed as Partial<MetadataImpactOutput>;
  if (!record.summary || !Array.isArray(record.impactedTables)) {
    throw new Error("impact is not a valid metadata impact result.");
  }
  return record as MetadataImpactOutput;
}

function changeObjectLabel(change: MetadataSnapshotComparison["breakingChanges"][number]): string {
  const object = change.affectedObject;
  if (object.objectName) {
    return `${object.schema ? `${object.schema}.` : ""}${object.objectName}`;
  }
  if (object.column) {
    return `${object.schema ? `${object.schema}.` : ""}${object.table ?? "*"}.${object.column}`;
  }
  if (object.name) {
    return `${object.schema ? `${object.schema}.` : ""}${object.table ?? "*"}.${object.name}`;
  }
  if (object.table) {
    return `${object.schema ? `${object.schema}.` : ""}${object.table}`;
  }
  return object.schema ?? "(unknown)";
}

function markdownCell(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/[\r\n]+/g, " ");
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
