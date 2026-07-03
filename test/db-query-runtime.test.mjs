import assert from "node:assert/strict";
import test from "node:test";

import { runQuery, runReadOnlyQuery } from "../dist/db.js";

test("runQuery keeps result shaping behind the db entrypoint", async () => {
  const calls = [];
  const pool = {
    async query(options) {
      calls.push(options);
      return [[{ id: 1, name: "orders" }], [{ name: "id", table: "orders", db: "biz_test", columnType: 8 }]];
    }
  };

  const output = await runQuery(pool, "SELECT id, name FROM orders WHERE id = ?", [1], 10, 5000);

  assert.deepEqual(calls, [{ sql: "SELECT id, name FROM orders WHERE id = ?", values: [1], timeout: 5000 }]);
  assert.equal(output.rowCount, 1);
  assert.deepEqual(output.rows, [{ id: 1, name: "orders" }]);
  assert.equal(output.fields[0].name, "id");
});

test("runReadOnlyQuery uses a read-only transaction and Oracle bind normalization", async () => {
  const calls = [];
  let released = false;
  const connection = {
    async query(options) {
      calls.push(options);
      if (String(options.sql).startsWith("SELECT")) {
        return [[{ id: 7 }], [{ name: "id", table: "orders", db: "biz_test", columnType: 8 }]];
      }
      return [[], []];
    },
    release() {
      released = true;
    }
  };
  const pool = {
    async getConnection() {
      return connection;
    }
  };

  const output = await runReadOnlyQuery(pool, "oracle", "SELECT id FROM orders WHERE id = :id", [7], 10, 5000, true);

  assert.equal(calls[0].sql, "SET ob_query_timeout = 5000000");
  assert.equal(calls[1].sql, "SET TRANSACTION READ ONLY");
  assert.equal(calls[2].sql, "SELECT id FROM orders WHERE id = ?");
  assert.deepEqual(calls[2].values, [7]);
  assert.equal(calls[3].sql, "ROLLBACK");
  assert.equal(output.rowCount, 1);
  assert.equal(output.rows[0].id, 7);
  assert.equal(released, true);
});
