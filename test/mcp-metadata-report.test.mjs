import assert from "node:assert/strict";
import test from "node:test";

import { loadConfig } from "../dist/config.js";
import { buildMetadataSnapshot, compareMetadataSnapshots } from "../dist/metadata-change.js";
import { analyzeMetadataImpact } from "../dist/metadata-impact.js";
import { createObMcpServer } from "../dist/mcp.js";

test("ob_generate_metadata_change_report returns markdown report", async () => {
  const config = loadConfig({ OB_ALLOWED_SCHEMAS: "biz" });
  const server = createObMcpServer({
    defaultProfile: "default",
    configs: { default: config },
    pools: { default: { async query() { throw new Error("database should not be used"); } } },
    queryLimiters: { default: { active: 0, limit: 5 } },
    metadataCaches: { default: { entries: new Map(), hits: 0, misses: 0, evictions: 0 } }
  });
  const diff = sampleDiff();
  const impact = analyzeMetadataImpact({ metadataDiff: diff, sqlIndex: sampleSqlIndex() });

  const result = await server.executeToolHandler(server._registeredTools.ob_generate_metadata_change_report, {
    metadataDiff: JSON.stringify(diff),
    impact,
    title: "Iteration Report",
    format: "markdown"
  }, {});
  const report = JSON.parse(result.content[0].text);

  assert.equal(report.executed, false);
  assert.equal(report.contentType, "text/markdown");
  assert.match(report.markdown, /Iteration Report/);
  assert.match(report.markdown, /SQL Impact/);
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
      sql: "SELECT id, status FROM biz.orders",
      statementType: "select",
      tables: ["biz.orders"],
      columns: ["id", "status"],
      dynamicSql: { detected: false, sources: [] },
      risks: ["missing_pagination"],
      dialectHints: []
    }],
    warnings: [],
    limits: { maxFiles: 100, maxBytes: 1024, extensions: [".xml"], ignore: [] }
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
