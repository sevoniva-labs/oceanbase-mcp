import assert from "node:assert/strict";
import test from "node:test";

import { analyzeQueryPlan } from "../dist/plan-analysis.js";

test("analyzeQueryPlan flags full table scans and sort work", () => {
  const analysis = analyzeQueryPlan(
    {
      rowCount: 1,
      rows: [{ operation: "TABLE ACCESS FULL", extra: "Using filesort" }],
      truncated: false
    },
    "SELECT id FROM orders ORDER BY created_at"
  );

  assert.equal(analysis.riskLevel, "high");
  assert(analysis.findings.some((finding) => finding.rule === "full_scan"));
  assert(analysis.findings.some((finding) => finding.rule === "sort_or_temp"));
  assert(analysis.recommendations.every((item) => !/^CREATE\s+/i.test(item)));
});

test("analyzeQueryPlan returns low risk when no heuristic matches", () => {
  const analysis = analyzeQueryPlan(
    {
      rowCount: 1,
      rows: [{ operation: "INDEX RANGE SCAN", key: "idx_orders_id" }],
      truncated: false
    },
    "SELECT id FROM orders WHERE id = ?"
  );

  assert.equal(analysis.riskLevel, "low");
  assert.equal(analysis.findings[0].rule, "no_obvious_risk");
});
