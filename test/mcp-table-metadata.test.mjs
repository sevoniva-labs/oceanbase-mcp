import assert from "node:assert/strict";
import test from "node:test";

import { loadConfig } from "../dist/config.js";
import { createObMcpServer } from "../dist/mcp.js";

test("table metadata tools filter denied columns and cap schema output", async () => {
  const config = loadConfig({
    OB_ALLOWED_SCHEMAS: "biz_test",
    OB_DENIED_COLUMNS: "secret_token",
    OB_ENFORCE_READ_ONLY_TX: "false"
  });
  const server = createObMcpServer(runtime(config, tableMetadataPool()));

  const result = await server.executeToolHandler(server._registeredTools.ob_get_table_schema, {
    schema: "biz_test",
    table: "orders",
    maxColumns: 2
  }, {});
  const output = JSON.parse(result.content[0].text);

  assert.equal(output.returnedColumns, 2);
  assert.equal(output.columnCountLowerBound, true);
  assert.deepEqual(output.columns.map((column) => column.column_name), ["id", "status"]);
});

test("ob_sample_rows skips large columns and masks configured fields", async () => {
  const config = loadConfig({
    OB_ALLOWED_SCHEMAS: "biz_test",
    OB_MASKED_COLUMNS: "biz_test.orders.status",
    OB_ENFORCE_READ_ONLY_TX: "false",
    OB_MAX_ROWS: "10"
  });
  const pool = tableMetadataPool();
  const server = createObMcpServer(runtime(config, pool));

  const result = await server.executeToolHandler(server._registeredTools.ob_sample_rows, {
    schema: "biz_test",
    table: "orders",
    limit: 2
  }, {});
  const output = JSON.parse(result.content[0].text);

  assert.equal(pool.sampleSql.includes("payload"), false);
  assert.deepEqual(output.rows.map((row) => row.status), ["***MASKED***", "***MASKED***"]);
  assert.equal(output.rows.some((row) => "payload" in row), false);
});

function runtime(config, pool) {
  return {
    defaultProfile: "default",
    configs: { default: config },
    pools: { default: pool },
    queryLimiters: { default: { active: 0, limit: 5 } }
  };
}

function tableMetadataPool() {
  return {
    sampleSql: "",
    async query({ sql }) {
      if (/FROM information_schema\.columns/i.test(sql)) {
        return [[
          column("id", "bigint", "bigint", "NO", 1),
          column("status", "varchar(32)", "varchar", "YES", 2),
          column("secret_token", "varchar(64)", "varchar", "YES", 3),
          column("payload", "blob", "blob", "YES", 4)
        ], []];
      }
      if (/^SELECT `id`, `status`, `secret_token` FROM `biz_test`\.`orders` LIMIT 3$/i.test(sql)) {
        this.sampleSql = sql;
        return [[
          { id: 1, status: "PAID", secret_token: "a" },
          { id: 2, status: "NEW", secret_token: "b" },
          { id: 3, status: "DONE", secret_token: "c" }
        ], [
          { name: "id", table: "orders", db: "biz_test", columnType: 8 },
          { name: "status", table: "orders", db: "biz_test", columnType: 253 },
          { name: "secret_token", table: "orders", db: "biz_test", columnType: 253 }
        ]];
      }
      if (/^SELECT `id`, `status` FROM `biz_test`\.`orders` LIMIT 3$/i.test(sql)) {
        this.sampleSql = sql;
        return [[
          { id: 1, status: "PAID" },
          { id: 2, status: "NEW" },
          { id: 3, status: "DONE" }
        ], [
          { name: "id", table: "orders", db: "biz_test", columnType: 8 },
          { name: "status", table: "orders", db: "biz_test", columnType: 253 }
        ]];
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    }
  };
}

function column(name, columnType, dataType, nullable, position) {
  return {
    table_schema: "biz_test",
    table_name: "orders",
    column_name: name,
    column_type: columnType,
    data_type: dataType,
    is_nullable: nullable,
    ordinal_position: position
  };
}
