import assert from "node:assert/strict";
import test from "node:test";

import { buildMetadataSnapshot, compareMetadataSnapshots } from "../dist/metadata-change.js";
import { analyzeMetadataImpact } from "../dist/metadata-impact.js";
import { generateMetadataChangeReport } from "../dist/metadata-report.js";

test("generateMetadataChangeReport renders markdown and html without executable change SQL", () => {
  const diff = sampleDiff();
  const impact = analyzeMetadataImpact({ metadataDiff: diff, sqlIndex: sampleSqlIndex() });

  const markdownReport = generateMetadataChangeReport({
    metadataDiff: diff,
    impact,
    title: "Iteration Metadata Impact",
    format: "markdown"
  });
  assert.equal(markdownReport.contentType, "text/markdown");
  assert.match(markdownReport.markdown, /Breaking Changes/);
  assert.match(markdownReport.markdown, /SQL Impact/);
  assert.doesNotMatch(markdownReport.markdown, /\b(ALTER|CREATE|DROP|GRANT)\s+(TABLE|INDEX|USER|ROLE|VIEW|SEQUENCE|PACKAGE)\b/i);

  const htmlReport = generateMetadataChangeReport({
    metadataDiff: JSON.stringify(diff),
    impact: JSON.stringify(impact),
    title: "Iteration Metadata Impact",
    format: "html",
    summaryOnly: true
  });
  assert.equal(htmlReport.contentType, "text/html");
  assert.match(htmlReport.html, /<!doctype html>/);
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
    scannedFiles: 1,
    skippedFiles: 0,
    snippetCount: 1,
    entries: [{
      file: "mapper/OrderMapper.xml",
      line: 12,
      sql: "SELECT id, status FROM biz.orders WHERE status = #{status}",
      statementType: "select",
      tables: ["biz.orders"],
      columns: ["id", "status"],
      dynamicSql: { detected: false, sources: [] },
      risks: ["missing_pagination"],
      dialectHints: []
    }],
    warnings: [],
    limits: {
      maxFiles: 100,
      maxBytes: 1024,
      extensions: [".xml"],
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
