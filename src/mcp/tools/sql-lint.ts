import { z } from "zod";

import type { ObConfig } from "../../config.js";
import type { SqlParam } from "../../db.js";
import { runReadOnlyQuery } from "../../db.js";
import type { QueryOutput } from "../../format.js";
import { metrics } from "../../metrics.js";
import { analyzeQueryPlan } from "../../plan-analysis.js";
import { explainSqlPolicy } from "../../policy.js";
import { effectiveRowLimit } from "../../query/output.js";
import { queryShape, sensitiveSqlTerms } from "../../query/preview.js";
import { selectRuntimeProfile, withQuerySlot, type GatewayRuntime } from "../../runtime.js";
import { assertReadOnlySql, assertSqlInputLimits, buildExplainSql } from "../../sql.js";
import { selectAuthorizedProfile } from "../access.js";
import type { McpRequestContext } from "../context.js";
import { policyContext } from "../policy-context.js";
import { profileInput, sqlParamSchema } from "../schemas.js";
import { runExplainCheck } from "../sql-policy-explain.js";
import { toLimitedResult } from "../tool-runtime.js";
import type { ToolRegistrar } from "../tool-registry.js";

export type LintFinding = {
  rule: string;
  severity: "info" | "warn" | "high";
  message: string;
  evidence: string[];
};

export function registerSqlLintTools(
  registerTool: ToolRegistrar,
  runtime: GatewayRuntime,
  context: McpRequestContext
): void {
  registerTool(
    "ob_lint_sql",
    {
      title: "Lint SQL",
      description: "Lint read-only SQL for policy, dialect, pagination, ordering, sensitive fields, and optional EXPLAIN risk without returning data.",
      inputSchema: {
        ...profileInput,
        sql: z.string().min(1),
        params: z.array(sqlParamSchema).optional().default([]),
        maxRows: z.number().int().positive().max(10_000).optional(),
        runExplain: z.boolean().optional().default(true)
      }
    },
    async ({ profile, sql, params = [], maxRows, runExplain = true }) => {
      const selected = selectAuthorizedProfile(runtime, profile, context);
      const sqlParams = params as SqlParam[];
      const lint = await lintReadOnlySql(selected, sql, sqlParams, effectiveRowLimit(maxRows, selected.config), runExplain);
      return toLimitedResult(lint, selected.config);
    }
  );
}

export async function lintReadOnlySql(
  selected: ReturnType<typeof selectRuntimeProfile>,
  sql: string,
  params: SqlParam[],
  maxRows: number,
  runExplain: boolean
) {
  const checks = [
    runExplainCheck("input_limits", () => assertSqlInputLimits(sql, params, selected.config)),
    runExplainCheck("read_only_sql", () => assertReadOnlySql(sql))
  ];
  const policy = explainSqlPolicy(sql, policyContext(selected.config));
  const allowed = checks.every((check) => check.ok) && policy.allowed;
  const shape = queryShape(sql, selected.config.compatibility);
  const sensitiveColumnRisk = sensitiveSqlTerms(sql, selected.config);
  const findings: LintFinding[] = [
    ...lintCheckFindings(checks, policy.checks),
    ...lintShapeFindings(sql, selected.config.compatibility, shape),
    ...lintSensitiveFindings(sensitiveColumnRisk),
    ...lintDialectFindings(sql, selected.config.compatibility)
  ];

  let plan: QueryOutput | undefined;
  let analysis: ReturnType<typeof analyzeQueryPlan> | undefined;
  let explainRun = false;
  if (allowed && runExplain) {
    const explainSql = buildExplainSql(sql);
    const started = Date.now();
    plan = await withQuerySlot(selected, () =>
      runReadOnlyQuery(
        selected.pool,
        selected.config.compatibility,
        explainSql,
        params,
        maxRows,
        selected.config.queryTimeoutMs,
        selected.config.enforceReadOnlyTransaction,
        selected.config.maxResultBytes
      )
    );
    metrics.recordQueryDuration(Date.now() - started);
    analysis = analyzeQueryPlan(plan, sql);
    explainRun = true;
    findings.push(...analysis.findings.map((finding) => ({
      rule: `explain_${finding.rule}`,
      severity: finding.severity,
      message: finding.message,
      evidence: finding.evidence
    })));
  } else if (!allowed) {
    findings.push({
      rule: "explain_skipped",
      severity: "info" as const,
      message: "EXPLAIN was skipped because SQL is not allowed by the current policy checks.",
      evidence: []
    });
  } else if (!runExplain) {
    findings.push({
      rule: "explain_skipped",
      severity: "info" as const,
      message: "EXPLAIN was skipped by request.",
      evidence: []
    });
  }

  const severity = lintSeverity(findings);
  return {
    sql,
    paramCount: params.length,
    allowed,
    severity,
    executed: false,
    explainRun,
    checks: [...checks, ...policy.checks],
    policy,
    shape,
    sensitiveColumnRisk,
    findings,
    recommendations: lintRecommendations(findings, analysis?.recommendations ?? []),
    plan: plan ? { rowCount: plan.rowCount, rows: plan.rows.slice(0, 20), truncated: plan.truncated } : undefined
  };
}

export function lintSeverity(findings: LintFinding[]): "low" | "medium" | "high" {
  if (findings.some((finding) => finding.severity === "high")) {
    return "high";
  }
  if (findings.some((finding) => finding.severity === "warn")) {
    return "medium";
  }
  return "low";
}

function lintCheckFindings(
  checks: Array<{ name: string; ok: boolean; message: string }>,
  policyChecks: Array<{ name: string; ok: boolean; message: string }>
): LintFinding[] {
  return [...checks, ...policyChecks]
    .filter((check) => !check.ok)
    .map((check) => ({
      rule: check.name,
      severity: "high" as const,
      message: check.message,
      evidence: [check.name]
    }));
}

function lintShapeFindings(
  sql: string,
  mode: ObConfig["compatibility"],
  shape: ReturnType<typeof queryShape>
): LintFinding[] {
  const findings: LintFinding[] = [];
  if (hasSelectStar(sql)) {
    findings.push({
      rule: "select_star",
      severity: "high" as const,
      message: "SELECT * is not allowed by the MCP SQL policy. Use explicit columns.",
      evidence: ["SELECT *"]
    });
  }
  if (!shape.hasRowLimit) {
    findings.push({
      rule: "missing_limit",
      severity: "warn" as const,
      message: "No row limit or pagination clause was detected.",
      evidence: [mode === "oracle" ? "Use FETCH FIRST/OFFSET or ob_query_page." : "Use LIMIT or ob_query_page."]
    });
  }
  if (!shape.hasOrderBy) {
    findings.push({
      rule: "missing_order_by",
      severity: "warn" as const,
      message: "No ORDER BY was detected. Result order may be unstable.",
      evidence: []
    });
  }
  if (!shape.hasWhere && !shape.hasRowLimit) {
    findings.push({
      rule: "broad_scan_shape",
      severity: "warn" as const,
      message: "The query has no WHERE clause and no row limit; it may scan a large table.",
      evidence: []
    });
  }
  return findings;
}

function lintSensitiveFindings(sensitiveColumnRisk: ReturnType<typeof sensitiveSqlTerms>): LintFinding[] {
  if (!sensitiveColumnRisk.detected) {
    return [];
  }
  return [{
    rule: "sensitive_field_reference",
    severity: "warn" as const,
    message: "SQL references fields that look sensitive or are configured for masking.",
    evidence: sensitiveColumnRisk.terms
  }];
}

function lintDialectFindings(sql: string, mode: ObConfig["compatibility"]): LintFinding[] {
  const findings: LintFinding[] = [];
  if (mode === "oracle" && /\blimit\s+\d+/i.test(sql)) {
    findings.push({
      rule: "dialect_pagination",
      severity: "warn" as const,
      message: "Oracle mode should use OFFSET/FETCH or ROWNUM instead of LIMIT.",
      evidence: ["LIMIT"]
    });
  }
  if (mode === "mysql" && (/\bfetch\s+(?:first|next)\s+\d+\s+rows\b/i.test(sql) || /\brownum\b/i.test(sql))) {
    findings.push({
      rule: "dialect_pagination",
      severity: "warn" as const,
      message: "MySQL mode should use LIMIT/OFFSET instead of Oracle pagination syntax.",
      evidence: ["FETCH/ROWNUM"]
    });
  }
  return findings;
}

function hasSelectStar(sql: string): boolean {
  return /\bselect\s+(?:\/\*.*?\*\/\s*)?\*/is.test(sql) || /,\s*\*/.test(sql);
}

function lintRecommendations(
  findings: LintFinding[],
  planRecommendations: string[]
): string[] {
  const output: string[] = [];
  if (findings.some((finding) => finding.rule === "select_star")) {
    output.push("Select explicit columns from metadata before running the query.");
  }
  if (findings.some((finding) => finding.rule === "missing_limit")) {
    output.push("Use ob_query_page or add a dialect-correct row limit for inspection queries.");
  }
  if (findings.some((finding) => finding.rule === "missing_order_by")) {
    output.push("Add a stable ORDER BY for repeatable pagination.");
  }
  if (findings.some((finding) => finding.rule === "sensitive_field_reference")) {
    output.push("Avoid selecting sensitive fields unless the configured masking policy is acceptable for the task.");
  }
  return uniqueStrings([...output, ...planRecommendations]).slice(0, 10);
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.trim()))];
}
