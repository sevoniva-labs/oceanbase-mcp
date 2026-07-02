import assert from "node:assert/strict";
import test from "node:test";

import { loadConfig } from "../dist/config.js";
import { buildMetadataSnapshot, compareMetadataSnapshots } from "../dist/metadata-change.js";
import { createObMcpServer } from "../dist/mcp.js";

test("ob_analyze_change_sql_impact and ob_analyze_metadata_impact use supplied indexes only", async () => {
  const config = loadConfig({ OB_ALLOWED_SCHEMAS: "biz" });
  const server = createObMcpServer({
    defaultProfile: "default",
    configs: { default: config },
    pools: { default: { async query() { throw new Error("database should not be used"); } } },
    queryLimiters: { default: { active: 0, limit: 5 } },
    metadataCaches: { default: { entries: new Map(), hits: 0, misses: 0, evictions: 0 } }
  });
  const diff = sampleDiff();

  const sqlResult = await server.executeToolHandler(server._registeredTools.ob_analyze_change_sql_impact, {
    metadataDiff: diff,
    sqlIndex: sampleSqlIndex()
  }, {});
  const sqlImpact = JSON.parse(sqlResult.content[0].text);
  assert.equal(sqlImpact.executed, false);
  assert.equal(sqlImpact.summary.impactedSql, 1);

  const metadataResult = await server.executeToolHandler(server._registeredTools.ob_analyze_metadata_impact, {
    metadataDiff: JSON.stringify(diff),
    sqlIndex: JSON.stringify(sampleSqlIndex())
  }, {});
  const metadataImpact = JSON.parse(metadataResult.content[0].text);
  assert.equal(metadataImpact.summary.impactedColumns, 1);
  assert.equal(metadataImpact.sqlImpact.summary.impactedSql, 1);
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
