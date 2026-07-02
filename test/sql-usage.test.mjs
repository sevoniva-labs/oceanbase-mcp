import assert from "node:assert/strict";
import test from "node:test";

import { findSqlUsages, parseSqlUsageIndexInput } from "../dist/sql-usage.js";

test("findSqlUsages matches table and column references from index", () => {
  const index = sampleIndex();
  const tableResult = findSqlUsages(index, { schema: "biz", table: "orders" });
  assert.equal(tableResult.matchCount, 1);
  assert(tableResult.results.some((result) => result.file === "mapper/OrderMapper.xml"));

  const columnResult = findSqlUsages(JSON.stringify(index), { column: "status" });
  assert.equal(columnResult.matchCount, 2);
  assert(columnResult.results.every((result) => result.evidence.some((item) => item.includes("status"))));
  assert.equal(columnResult.executed, false);
});

test("findSqlUsages matches business term text without database access", () => {
  const result = findSqlUsages(sampleIndex(), { businessTerm: "payment" });
  assert.equal(result.matchCount, 1);
  assert.equal(result.results[0].file, "sql/payment.sql");
  assert(result.warnings.some((warning) => warning.includes("No SQL is executed")));
});

test("parseSqlUsageIndexInput rejects invalid index", () => {
  assert.throws(() => parseSqlUsageIndexInput({ entries: "nope" }), /valid SQL usage index/);
  assert.throws(() => findSqlUsages(sampleIndex(), {}), /Pass table, column, or businessTerm/);
});

function sampleIndex() {
  return {
    indexVersion: "1.1",
    generatedAt: "2026-07-01T00:00:00.000Z",
    root: "/repo",
    scannedFiles: 2,
    skippedFiles: 0,
    snippetCount: 2,
    entries: [
      {
        file: "mapper/OrderMapper.xml",
        line: 12,
        sql: "SELECT id, status FROM biz.orders WHERE status = #{status}",
        statementType: "select",
        tables: ["biz.orders"],
        columns: ["id", "status"],
        dynamicSql: { detected: true, sources: ["mybatis_parameter"] },
        risks: ["missing_pagination"],
        dialectHints: []
      },
      {
        file: "sql/payment.sql",
        line: 1,
        sql: "SELECT order_id, status FROM payments WHERE status = 'PAID' LIMIT 20",
        statementType: "select",
        tables: ["payments"],
        columns: ["order_id", "status"],
        dynamicSql: { detected: false, sources: [] },
        risks: [],
        dialectHints: ["mysql_limit"]
      }
    ],
    warnings: [],
    limits: {
      maxFiles: 100,
      maxBytes: 1024,
      extensions: [".sql"],
      ignore: []
    }
  };
}
