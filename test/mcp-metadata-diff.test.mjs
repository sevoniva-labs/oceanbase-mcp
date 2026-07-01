import assert from "node:assert/strict";
import test from "node:test";

import { loadConfig } from "../dist/config.js";
import { buildMetadataSnapshot } from "../dist/metadata-change.js";
import { createObMcpServer } from "../dist/mcp.js";

test("ob_compare_metadata_snapshots compares JSON snapshot inputs", async () => {
  const config = loadConfig();
  const server = createObMcpServer({
    defaultProfile: "default",
    configs: { default: config },
    pools: { default: { async query() { throw new Error("database should not be used"); } } },
    queryLimiters: { default: { active: 0, limit: 5 } },
    metadataCaches: { default: { entries: new Map(), hits: 0, misses: 0, evictions: 0 } }
  });

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
      indexes: [{ index_name: "idx_status", non_unique: 1, column_name: "status" }],
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

  const result = await server.executeToolHandler(server._registeredTools.ob_compare_metadata_snapshots, {
    beforeSnapshot: JSON.stringify(before),
    afterSnapshot: after,
    riskOnly: true
  }, {});
  const diff = JSON.parse(result.content[0].text);

  assert.equal(diff.executed, false);
  assert.equal(diff.summary.byCategory.column, 1);
  assert.equal(diff.summary.byCategory.index, 1);
  assert(diff.changes.columns.some((change) => change.affectedObject.column === "status"));
});

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
