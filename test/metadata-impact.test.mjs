import assert from "node:assert/strict";
import test from "node:test";

import { compareMetadataSnapshots, buildMetadataSnapshot } from "../dist/metadata-change.js";
import { analyzeChangeSqlImpact, analyzeMetadataImpact } from "../dist/metadata-impact.js";

test("analyzeChangeSqlImpact classifies clear and possible SQL impact", () => {
  const diff = sampleDiff();
  const impact = analyzeChangeSqlImpact({
    metadataDiff: diff,
    sqlIndex: sampleSqlIndex()
  });

  assert.equal(impact.executed, false);
  assert.equal(impact.summary.impactedSql, 2);
  assert.equal(impact.summary.clearMatches, 1);
  assert.equal(impact.summary.possibleMatches, 1);
  assert(impact.impacts.some((item) => item.file === "mapper/OrderMapper.xml" && item.matchLevel === "clear"));
  assert(impact.impacts.some((item) => item.file === "sql/order-report.sql" && item.matchLevel === "possible"));
});

test("analyzeMetadataImpact summarizes tables, columns, SQL impact, and glossary hints", () => {
  const impact = analyzeMetadataImpact({
    metadataDiff: sampleDiff(),
    sqlIndex: sampleSqlIndex(),
    businessGlossary: {
      terms: [{
        term: "订单",
        targets: [{ schema: "biz", table: "orders", column: "status" }]
      }]
    }
  });

  assert.equal(impact.summary.impactedTables, 1);
  assert.equal(impact.summary.impactedColumns, 1);
  assert.equal(impact.summary.impactedSql, 2);
  assert.equal(impact.glossaryHints[0].term, "订单");
  assert(impact.reviewItems.some((item) => item.includes("column")));
});

function sampleDiff() {
  const before = buildMetadataSnapshot({
    profile: "default",
    compatibility: "mysql",
    scope: snapshotScope(),
    tables: [{
      schema: "biz",
      table: "orders",
      columns: [
        { column_name: "id", column_type: "bigint", is_nullable: "NO", ordinal_position: 1 },
        { column_name: "status", column_type: "varchar(32)", is_nullable: "YES", ordinal_position: 2 }
      ],
      indexes: [],
      constraints: [],
      partitions: []
    }],
    relationships: []
  });
  const after = buildMetadataSnapshot({
    profile: "default",
    compatibility: "mysql",
    scope: snapshotScope(),
    tables: [{
      schema: "biz",
      table: "orders",
      columns: [{ column_name: "id", column_type: "bigint", is_nullable: "NO", ordinal_position: 1 }],
      indexes: [],
      constraints: [],
      partitions: []
    }],
    relationships: []
  });
  return compareMetadataSnapshots(before, after);
}

function sampleSqlIndex() {
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
        dynamicSql: { detected: false, sources: [] },
        risks: ["missing_pagination"],
        dialectHints: []
      },
      {
        file: "sql/order-report.sql",
        line: 3,
        sql: "SELECT * FROM biz.orders LIMIT 20",
        statementType: "select",
        tables: ["biz.orders"],
        columns: [],
        dynamicSql: { detected: false, sources: [] },
        risks: ["select_star"],
        dialectHints: ["mysql_limit", "select_star"]
      }
    ],
    warnings: [],
    limits: {
      maxFiles: 100,
      maxBytes: 1024,
      extensions: [".sql", ".xml"],
      ignore: []
    }
  };
}

function snapshotScope() {
  return {
    objectTypes: [],
    includeRelationships: false,
    includeOracleObjects: false,
    maxTables: 10,
    maxColumnsPerTable: 20,
    maxObjects: 10,
    maxRelationships: 10
  };
}
