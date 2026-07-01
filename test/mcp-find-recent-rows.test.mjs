import assert from "node:assert/strict";
import test from "node:test";

import { loadConfig } from "../dist/config.js";
import { createObMcpServer } from "../dist/mcp.js";

test("ob_find_recent_rows reads recent rows through detected time column and masks sensitive values", async () => {
  const config = loadConfig({
    OB_ALLOWED_SCHEMAS: "biz_test",
    OB_MASKED_COLUMNS: "biz_test.orders.phone",
    OB_MAX_ROWS: "5",
    OB_ENFORCE_READ_ONLY_TX: "false"
  });
  const server = createObMcpServer(runtime(config));

  const result = await server.executeToolHandler(server._registeredTools.ob_find_recent_rows, {
    schema: "biz_test",
    table: "orders",
    columns: ["id", "phone"],
    pageSize: 2
  }, {});
  const recent = JSON.parse(result.content[0].text);

  assert.equal(recent.mode, "mysql");
  assert.equal(recent.schema, "biz_test");
  assert.equal(recent.table, "orders");
  assert.equal(recent.timeColumn.column, "created_at");
  assert.equal(recent.timeColumn.source, "detected");
  assert.match(recent.sql, /ORDER BY `created_at` DESC LIMIT \? OFFSET \?/);
  assert.equal(recent.pageSize, 2);
  assert.equal(recent.rows.length, 2);
  assert.equal(recent.rows[0].phone, "***MASKED***");
  assert.doesNotMatch(result.content[0].text, /13800000000/);
  assert(recent.warnings.some((warning) => /Time column was selected from metadata detection/i.test(warning)));
  assert(recent.markdownPreview.includes("***MASKED***"));
});

function runtime(config) {
  return {
    defaultProfile: "default",
    configs: { default: config },
    pools: { default: { query } },
    queryLimiters: { default: { active: 0, limit: 5 } }
  };
}

async function query({ sql, values }) {
  if (/FROM information_schema\.columns/i.test(sql)) {
    return [[
      {
        table_schema: "biz_test",
        table_name: "orders",
        column_name: "id",
        column_type: "bigint",
        data_type: "bigint",
        is_nullable: "NO",
        ordinal_position: 1
      },
      {
        table_schema: "biz_test",
        table_name: "orders",
        column_name: "created_at",
        column_type: "datetime",
        data_type: "datetime",
        is_nullable: "NO",
        ordinal_position: 2,
        column_comment: "created time"
      },
      {
        table_schema: "biz_test",
        table_name: "orders",
        column_name: "phone",
        column_type: "varchar(32)",
        data_type: "varchar",
        is_nullable: "YES",
        ordinal_position: 3
      }
    ], []];
  }
  if (/FROM `biz_test`\.`orders`/i.test(sql)) {
    assert.deepEqual(values, [2, 0]);
    return [[
      { created_at: "2026-06-02 10:00:00", id: 2, phone: "13800000000" },
      { created_at: "2026-06-01 10:00:00", id: 1, phone: "13900000000" }
    ], []];
  }
  throw new Error(`Unexpected SQL: ${sql}`);
}
