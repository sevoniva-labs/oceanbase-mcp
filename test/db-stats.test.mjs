import assert from "node:assert/strict";
import test from "node:test";

import { getTableStats } from "../dist/db.js";

test("getTableStats returns MySQL table estimates and metadata counts", async () => {
  const pool = {
    async query({ sql }) {
      if (sql.includes("FROM information_schema.tables")) {
        return [[{ table_rows: 42, data_length: 1024, index_length: 256, update_time: "2026-01-01 00:00:00" }], []];
      }
      if (sql.includes("FROM information_schema.columns")) {
        return [[{ item_count: 4 }], []];
      }
      if (sql.includes("FROM information_schema.statistics")) {
        return [[{ item_count: 2 }], []];
      }
      if (sql.includes("FROM information_schema.table_constraints")) {
        return [[{ item_count: 1 }], []];
      }
      if (sql.includes("FROM information_schema.partitions")) {
        return [[{ item_count: 0 }], []];
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    }
  };

  const stats = await getTableStats(pool, "mysql", "orders", "biz_test", 1_000);

  assert.equal(stats.rowEstimate.value, 42);
  assert.equal(stats.rowEstimate.exact, false);
  assert.deepEqual(stats.counts, { columns: 4, indexes: 2, constraints: 1, partitions: 0 });
  assert.equal(stats.storage.dataBytes, 1024);
  assert.match(stats.warnings[0], /estimate/);
});
