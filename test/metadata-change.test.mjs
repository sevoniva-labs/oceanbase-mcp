import assert from "node:assert/strict";
import test from "node:test";

import { buildMetadataSnapshot } from "../dist/metadata-change.js";

test("buildMetadataSnapshot creates stable fingerprints for equivalent metadata", () => {
  const input = {
    profile: "default",
    compatibility: "mysql",
    scope: {
      objectTypes: [],
      includeRelationships: true,
      includeOracleObjects: false,
      maxTables: 10,
      maxColumnsPerTable: 10,
      maxObjects: 0,
      maxRelationships: 10
    },
    tables: [{
      schema: "biz",
      table: "orders",
      columns: [
        { column_name: "status", column_type: "varchar(32)", is_nullable: "YES", ordinal_position: 2 },
        { column_name: "id", column_type: "bigint", is_nullable: "NO", ordinal_position: 1 }
      ],
      indexes: [{ index_name: "PRIMARY", non_unique: 0, column_name: "id" }],
      constraints: [{ constraint_name: "PRIMARY", constraint_type: "PRIMARY KEY", column_name: "id" }],
      partitions: [],
      maskedColumns: ["status"]
    }],
    relationships: []
  };

  const first = buildMetadataSnapshot(input);
  const second = buildMetadataSnapshot({
    ...input,
    capturedAt: "2030-01-01T00:00:00.000Z"
  });

  assert.equal(first.snapshotVersion, "1.1");
  assert.equal(first.fingerprint, second.fingerprint);
  assert.equal(first.tables[0].columns[0].name, "id");
  assert.equal(first.tables[0].columns[1].masked, true);
});

test("buildMetadataSnapshot keeps Oracle source text out of object output", () => {
  const snapshot = buildMetadataSnapshot({
    profile: "default",
    compatibility: "oracle",
    scope: {
      objectTypes: ["view"],
      includeRelationships: false,
      includeOracleObjects: true,
      maxTables: 10,
      maxColumnsPerTable: 10,
      maxObjects: 10,
      maxRelationships: 10
    },
    tables: [],
    oracleObjects: [{
      summary: {
        OWNER: "APP",
        OBJECT_NAME: "ORDER_VIEW",
        OBJECT_TYPE: "VIEW",
        STATUS: "VALID",
        LAST_DDL_TIME: "2026-07-01"
      },
      metadata: {
        schema: "APP",
        objectName: "ORDER_VIEW",
        objectType: "VIEW",
        sourcePreview: {
          text: "SELECT token_secret FROM orders"
        }
      }
    }]
  });

  const object = snapshot.oracleObjects[0];
  assert.equal(object.objectName, "ORDER_VIEW");
  assert.equal(typeof object.sourceFingerprint, "string");
  assert(!JSON.stringify(object).includes("token_secret"));
});
