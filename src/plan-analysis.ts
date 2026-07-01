import type { QueryOutput } from "./format.js";

export interface QueryPlanFinding {
  rule: string;
  severity: "info" | "warn" | "high";
  message: string;
  evidence: string[];
}

export interface QueryPlanAnalysis {
  riskLevel: "low" | "medium" | "high";
  inspectedRows: number;
  findings: QueryPlanFinding[];
  recommendations: string[];
}

export function analyzeQueryPlan(output: QueryOutput, sql: string): QueryPlanAnalysis {
  const planLines = output.rows.map(rowToText).filter(Boolean);
  const findings: QueryPlanFinding[] = [];
  addFinding(findings, "full_scan", "high", "Execution plan indicates a full table scan.", planLines, [
    /\btable\s+scan\b/i,
    /\bfull\s+scan\b/i,
    /\btable\s+access\s+full\b/i,
    /\baccess_type["']?\s*:\s*["']?all\b/i,
    /\btype["']?\s*:\s*["']?all\b/i
  ]);
  addFinding(findings, "missing_index", "warn", "Execution plan suggests weak or missing index access.", planLines, [
    /\bno\s+index\b/i,
    /\bwithout\s+index\b/i,
    /\bindex\s+skip\b/i,
    /\baccess["']?\s*:\s*["']?full\b/i
  ]);
  addFinding(findings, "sort_or_temp", "warn", "Execution plan includes sort or temporary-table work.", planLines, [
    /\bfilesort\b/i,
    /\busing\s+temporary\b/i,
    /\btemp(orary)?\s+table\b/i,
    /\bsort\b/i
  ]);
  if (/\bjoin\b/i.test(sql)) {
    findings.push({
      rule: "join_review",
      severity: "info",
      message: "Query contains JOIN; verify join keys, row estimates, and join order against the plan.",
      evidence: matchingEvidence(planLines, [/\bjoin\b/i, /\bnested\s+loop\b/i, /\bhash\s+join\b/i])
    });
  }
  if (matchingEvidence(planLines, [/\bpartition\b/i, /\bpstart\b/i, /\bpstop\b/i]).length > 0) {
    findings.push({
      rule: "partition_metadata",
      severity: "info",
      message: "Plan includes partition metadata; check whether partition pruning matches the query predicate.",
      evidence: matchingEvidence(planLines, [/\bpartition\b/i, /\bpstart\b/i, /\bpstop\b/i])
    });
  }
  if (findings.length === 0) {
    findings.push({
      rule: "no_obvious_risk",
      severity: "info",
      message: "No obvious full scan, missing-index, sort, or temporary-table risk was detected from the returned plan.",
      evidence: planLines.slice(0, 3)
    });
  }

  return {
    riskLevel: riskLevel(findings),
    inspectedRows: output.rows.length,
    findings,
    recommendations: recommendations(findings)
  };
}

function addFinding(
  findings: QueryPlanFinding[],
  rule: string,
  severity: QueryPlanFinding["severity"],
  message: string,
  planLines: string[],
  patterns: RegExp[]
): void {
  const evidence = matchingEvidence(planLines, patterns);
  if (evidence.length > 0) {
    findings.push({ rule, severity, message, evidence });
  }
}

function matchingEvidence(planLines: string[], patterns: RegExp[]): string[] {
  return planLines.filter((line) => patterns.some((pattern) => pattern.test(line))).slice(0, 5);
}

function riskLevel(findings: QueryPlanFinding[]): QueryPlanAnalysis["riskLevel"] {
  if (findings.some((finding) => finding.severity === "high")) {
    return "high";
  }
  if (findings.some((finding) => finding.severity === "warn")) {
    return "medium";
  }
  return "low";
}

function recommendations(findings: QueryPlanFinding[]): string[] {
  const output: string[] = [];
  if (findings.some((finding) => finding.rule === "full_scan")) {
    output.push("Review predicates, table cardinality, and available indexes before using this query on large tables.");
  }
  if (findings.some((finding) => finding.rule === "missing_index")) {
    output.push("Check whether the filter and join columns are covered by existing indexes.");
  }
  if (findings.some((finding) => finding.rule === "sort_or_temp")) {
    output.push("Review ORDER BY, GROUP BY, and DISTINCT clauses for avoidable sort or temporary-table work.");
  }
  if (output.length === 0) {
    output.push("Review row estimates and predicates with production data volume before relying on the query shape.");
  }
  return output;
}

function rowToText(row: unknown): string {
  if (row == null) {
    return "";
  }
  if (typeof row === "string") {
    return row;
  }
  return JSON.stringify(row);
}
