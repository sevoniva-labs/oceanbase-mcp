import assert from "node:assert/strict";
import test from "node:test";

import { loadErMetadataBatch } from "../dist/db.js";

test("loadErMetadataBatch bounds MySQL column metadata per table", async () => {
  const queries = [];
  const pool = {
    async query({ sql, values = [] }) {
      queries.push({ sql, values });
      if (sql.includes("information_schema.statistics") || sql.includes("information_schema.table_constraints")) {
        assert.match(sql, /ROW_NUMBER\(\) OVER/i);
        return [[], []];
      }
      if (sql.includes("information_schema.columns")) {
        assert.match(sql, /ROW_NUMBER\(\) OVER \(PARTITION BY table_schema, table_name ORDER BY ordinal_position\)/i);
        assert.equal(values.at(-1), 3);
        return [[
          column("orders", "id", 1),
          column("orders", "status", 2),
          column("orders", "created_at", 3)
        ], []];
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    }
  };

  const batch = await loadErMetadataBatch(pool, "mysql", [{ schema: "biz", table: "orders" }], {
    relationshipMode: "none",
    maxRelationships: 1,
    maxColumnsPerTable: 2,
    maxIndexRowsPerTable: 4,
    maxConstraintRowsPerTable: 4,
    timeoutMs: 1_000
  });

  assert.equal(batch.columns.length, 2);
  assert.equal(batch.truncated, true);
  assert.deepEqual(batch.truncatedColumnTables, ["biz.orders"]);
  assert.equal(batch.truncatedColumns, 1);
  assert.equal(queries.length, 3);
});

test("loadErMetadataBatch bounds Oracle column metadata per table", async () => {
  const queries = [];
  const pool = {
    async query({ sql, values = [] }) {
      queries.push({ sql, values });
      if (sql.includes("all_indexes") || sql.includes("all_constraints")) {
        assert.match(sql, /ROW_NUMBER\(\) OVER/i);
        return [[], []];
      }
      if (sql.includes("all_tab_columns")) {
        assert.match(sql, /ROW_NUMBER\(\) OVER \(PARTITION BY c\.owner, c\.table_name ORDER BY c\.column_id\)/i);
        assert.equal(values.at(-1), 3);
        return [[
          oracleColumn("ID", 1),
          oracleColumn("STATUS", 2),
          oracleColumn("CREATED_AT", 3)
        ], []];
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    }
  };

  const batch = await loadErMetadataBatch(pool, "oracle", [{ schema: "APP", table: "ORDERS" }], {
    relationshipMode: "none",
    maxRelationships: 1,
    maxColumnsPerTable: 2,
    maxIndexRowsPerTable: 4,
    maxConstraintRowsPerTable: 4,
    timeoutMs: 1_000
  });

  assert.equal(batch.columns.length, 2);
  assert.equal(batch.truncated, true);
  assert.deepEqual(batch.truncatedColumnTables, ["APP.ORDERS"]);
  assert.equal(batch.truncatedColumns, 1);
  assert.equal(queries.length, 3);
});

function column(table, name, position) {
  return {
    table_schema: "biz",
    table_name: table,
    column_name: name,
    column_type: "varchar(32)",
    data_type: "varchar",
    ordinal_position: position
  };
}

function oracleColumn(name, position) {
  return {
    OWNER: "APP",
    TABLE_NAME: "ORDERS",
    COLUMN_NAME: name,
    DATA_TYPE: "VARCHAR2",
    COLUMN_ID: position
  };
}
