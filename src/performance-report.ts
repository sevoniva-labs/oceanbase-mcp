import type { TableStats } from "./db.js";
import type { QueryPlanAnalysis } from "./plan-analysis.js";

export interface PerformanceTableContext {
  schema?: string;
  table: string;
  stats?: TableStats;
  indexes: unknown[];
}

export interface PerformanceEvidence {
  rule: string;
  severity: "info" | "warn" | "high";
  message: string;
  evidence: string[];
}

export interface PerformanceReport {
  riskLevel: "low" | "medium" | "high";
  evidence: PerformanceEvidence[];
  recommendations: string[];
  notes: string[];
}

const LARGE_TABLE_WARN_ROWS = 100_000;

export function buildPerformanceReport(
  planAnalysis: QueryPlanAnalysis,
  tables: PerformanceTableContext[]
): PerformanceReport {
  const evidence: PerformanceEvidence[] = planAnalysis.findings.map((finding) => ({
    rule: `plan_${finding.rule}`,
    severity: finding.severity,
    message: finding.message,
    evidence: finding.evidence
  }));

  for (const table of tables) {
    const name = table.schema ? `${table.schema}.${table.table}` : table.table;
    const rowEstimate = table.stats?.rowEstimate?.value;
    if (rowEstimate != null) {
      evidence.push({
        rule: "table_row_estimate",
        severity: rowEstimate >= LARGE_TABLE_WARN_ROWS ? "warn" : "info",
        message: `${name} has optimizer row estimate ${rowEstimate}.`,
        evidence: [`source=${table.stats?.rowEstimate?.source ?? "unknown"}`, `exact=false`]
      });
    }
    const indexCount = table.stats?.counts.indexes ?? table.indexes.length;
    evidence.push({
      rule: "index_inventory",
      severity: indexCount === 0 ? "warn" : "info",
      message: `${name} has ${indexCount} visible index metadata entries.`,
      evidence: indexNames(table.indexes).slice(0, 8)
    });
    const partitionCount = table.stats?.counts.partitions;
    if (partitionCount != null && partitionCount > 0) {
      evidence.push({
        rule: "partition_inventory",
        severity: "info",
        message: `${name} has ${partitionCount} visible partition metadata entries.`,
        evidence: ["Check whether the plan shows partition pruning for partition-key predicates."]
      });
    }
  }

  return {
    riskLevel: reportRiskLevel(planAnalysis.riskLevel, evidence),
    evidence,
    recommendations: recommendations(planAnalysis, evidence),
    notes: [
      "This report is based on EXPLAIN output and optimizer metadata. It does not execute the query.",
      "Recommendations are review directions only; no write, DDL, or index creation SQL is generated."
    ]
  };
}

function reportRiskLevel(
  planRisk: QueryPlanAnalysis["riskLevel"],
  evidence: PerformanceEvidence[]
): PerformanceReport["riskLevel"] {
  if (planRisk === "high" || evidence.some((item) => item.severity === "high")) {
    return "high";
  }
  if (planRisk === "medium" || evidence.some((item) => item.severity === "warn")) {
    return "medium";
  }
  return "low";
}

function recommendations(planAnalysis: QueryPlanAnalysis, evidence: PerformanceEvidence[]): string[] {
  const output = new Set<string>(planAnalysis.recommendations);
  if (evidence.some((item) => item.rule === "table_row_estimate" && item.severity === "warn")) {
    output.add("For large estimated tables, confirm predicates are selective before using the query in latency-sensitive paths.");
  }
  if (evidence.some((item) => item.rule === "index_inventory" && item.severity === "warn")) {
    output.add("Evaluate whether important filter or join columns need an index design review.");
  }
  if (planAnalysis.findings.some((finding) => finding.rule === "sort_or_temp")) {
    output.add("Check whether ORDER BY, GROUP BY, or DISTINCT can use existing access paths or smaller intermediate result sets.");
  }
  if (planAnalysis.findings.some((finding) => finding.rule === "partition_metadata")) {
    output.add("Compare partition predicates with the plan to confirm expected partition pruning.");
  }
  return [...output];
}

function indexNames(indexes: unknown[]): string[] {
  const names = indexes
    .map((row) => {
      const record = row as Record<string, unknown>;
      const value = record.index_name ?? record.INDEX_NAME;
      return typeof value === "string" && value.trim() ? value.trim() : undefined;
    })
    .filter((value): value is string => Boolean(value));
  return [...new Set(names)];
}
