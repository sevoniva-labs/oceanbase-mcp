import assert from "node:assert/strict";
import test from "node:test";

import { buildPerformanceReport } from "../dist/performance-report.js";

test("buildPerformanceReport combines plan and metadata evidence without DDL", () => {
  const report = buildPerformanceReport(
    {
      riskLevel: "high",
      inspectedRows: 1,
      findings: [{
        rule: "full_scan",
        severity: "high",
        message: "Execution plan indicates a full table scan.",
        evidence: ["TABLE ACCESS FULL ORDERS"]
      }],
      recommendations: ["Review predicates, table cardinality, and available indexes before using this query on large tables."]
    },
    [{
      schema: "biz_test",
      table: "orders",
      stats: {
        mode: "mysql",
        schema: "biz_test",
        table: "orders",
        rowEstimate: {
          value: 250_000,
          exact: false,
          source: "information_schema.tables.table_rows"
        },
        counts: {
          columns: 8,
          indexes: 0,
          constraints: 1,
          partitions: 0
        },
        warnings: []
      },
      indexes: []
    }]
  );

  const text = JSON.stringify(report);
  assert.equal(report.riskLevel, "high");
  assert(report.evidence.some((item) => item.rule === "table_row_estimate"));
  assert(report.recommendations.some((item) => item.includes("index design review")));
  assert.doesNotMatch(text, /CREATE\s+INDEX/i);
});
