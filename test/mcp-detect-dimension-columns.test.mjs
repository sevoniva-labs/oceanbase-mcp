import assert from "node:assert/strict";
import test from "node:test";

import { loadConfig } from "../dist/config.js";
import { createObMcpServer } from "../dist/mcp.js";

test("ob_detect_dimension_columns returns metadata-based dimension candidates", async () => {
  const config = loadConfig({
    OB_ALLOWED_SCHEMAS: "biz_test",
    OB_DENIED_COLUMNS: "secret_token",
    OB_MASKED_COLUMNS: "biz_test.orders.status",
    OB_ENFORCE_READ_ONLY_TX: "false"
  });
  const server = createObMcpServer(runtime(config));

  const result = await server.executeToolHandler(server._registeredTools.ob_detect_dimension_columns, {
    schema: "biz_test",
    table: "orders"
  }, {});
  const detection = JSON.parse(result.content[0].text);
  const byColumn = new Map(detection.candidates.map((candidate) => [candidate.column, candidate]));

  assert.equal(detection.mode, "mysql");
  assert.equal(detection.schema, "biz_test");
  assert.equal(detection.table, "orders");
  assert.equal(byColumn.get("status").kind, "status");
  assert.equal(byColumn.get("status").masked, true);
  assert.equal(byColumn.get("order_type").kind, "type");
  assert.equal(byColumn.get("source_channel").kind, "channel");
  assert.equal(byColumn.get("region_code").kind, "region");
  assert.equal(byColumn.get("is_deleted").kind, "flag");
  assert(byColumn.get("status").confidence >= 0.5);
  assert(byColumn.get("source_channel").evidence.some((item) => /channel/i.test(item)));
  assert(!byColumn.has("id"));
  assert(!byColumn.has("secret_token"));
  assert(detection.warnings.some((warning) => /metadata-based/i.test(warning)));
});

function runtime(config) {
  return {
    defaultProfile: "default",
    configs: { default: config },
    pools: { default: { query } },
    queryLimiters: { default: { active: 0, limit: 5 } }
  };
}

async function query({ sql }) {
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
        column_name: "status",
        column_type: "varchar(32)",
        data_type: "varchar",
        is_nullable: "YES",
        ordinal_position: 2,
        column_comment: "order status"
      },
      {
        table_schema: "biz_test",
        table_name: "orders",
        column_name: "order_type",
        column_type: "varchar(32)",
        data_type: "varchar",
        is_nullable: "YES",
        ordinal_position: 3,
        column_comment: "order type"
      },
      {
        table_schema: "biz_test",
        table_name: "orders",
        column_name: "source_channel",
        column_type: "varchar(32)",
        data_type: "varchar",
        is_nullable: "YES",
        ordinal_position: 4,
        column_comment: "source channel"
      },
      {
        table_schema: "biz_test",
        table_name: "orders",
        column_name: "region_code",
        column_type: "varchar(32)",
        data_type: "varchar",
        is_nullable: "YES",
        ordinal_position: 5,
        column_comment: "region code"
      },
      {
        table_schema: "biz_test",
        table_name: "orders",
        column_name: "is_deleted",
        column_type: "tinyint(1)",
        data_type: "tinyint",
        is_nullable: "NO",
        ordinal_position: 6,
        column_comment: "delete flag"
      },
      {
        table_schema: "biz_test",
        table_name: "orders",
        column_name: "secret_token",
        column_type: "varchar(128)",
        data_type: "varchar",
        is_nullable: "YES",
        ordinal_position: 7
      }
    ], []];
  }
  throw new Error(`Unexpected SQL: ${sql}`);
}
