import assert from "node:assert/strict";
import test from "node:test";

import { findRelatedTables } from "../dist/db.js";

test("findRelatedTables returns MySQL foreign-key relationships with evidence", async () => {
  const pool = relationPool({
    foreignKeys: [
      {
        constraint_name: "fk_orders_user",
        source_schema: "biz_test",
        source_table: "orders",
        source_column: "user_id",
        target_schema: "biz_test",
        target_table: "users",
        target_column: "id"
      }
    ],
    columns: [{ column_name: "user_id" }],
    indexes: [{ index_name: "idx_user_id", column_name: "user_id", non_unique: 1 }],
    tables: [{ table_schema: "biz_test", table_name: "users" }],
    keyColumns: [{ column_name: "id" }],
    inboundColumns: []
  });

  const result = await findRelatedTables(pool, "mysql", "orders", "biz_test", 1, 20, 1_000);

  assert.equal(result.relations.length, 1);
  assert.equal(result.relations[0].relationType, "foreign_key");
  assert.equal(result.relations[0].confidence, 1);
  assert.deepEqual(result.relations[0].sourceColumns, ["user_id"]);
  assert.deepEqual(result.relations[0].targetColumns, ["id"]);
  assert.equal(result.relations[0].evidence[0].type, "foreign_key");
});

test("findRelatedTables returns conservative naming inference", async () => {
  const pool = relationPool({
    foreignKeys: [],
    columns: [{ column_name: "account_id" }],
    indexes: [{ index_name: "idx_account_id", column_name: "account_id", non_unique: 1 }],
    tables: [{ table_schema: "biz_test", table_name: "accounts" }],
    keyColumns: [{ column_name: "id" }],
    inboundColumns: []
  });

  const result = await findRelatedTables(pool, "mysql", "orders", "biz_test", 1, 20, 1_000);

  assert.equal(result.relations.length, 1);
  assert.equal(result.relations[0].relationType, "name_inference");
  assert.equal(result.relations[0].direction, "outbound");
  assert.equal(result.relations[0].targetTable, "accounts");
  assert(result.relations[0].confidence < 1);
  assert(result.relations[0].evidence.some((item) => item.type === "primary_or_unique_key"));
});

function relationPool(fixtures) {
  return {
    async query({ sql }) {
      if (sql.includes("FROM information_schema.table_constraints tc")) {
        return [fixtures.keyColumns, []];
      }
      if (sql.includes("information_schema.key_column_usage kcu")) {
        return sql.includes("kcu.table_schema = ? AND kcu.table_name = ?")
          ? [fixtures.foreignKeys, []]
          : [[], []];
      }
      if (sql.includes("FROM information_schema.tables")) {
        return [fixtures.tables, []];
      }
      if (sql.includes("FROM information_schema.columns c")) {
        return [fixtures.inboundColumns, []];
      }
      if (sql.includes("FROM information_schema.statistics")) {
        return [fixtures.indexes, []];
      }
      if (sql.includes("FROM information_schema.columns")) {
        return [fixtures.columns, []];
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    }
  };
}
