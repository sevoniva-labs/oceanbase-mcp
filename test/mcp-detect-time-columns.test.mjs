import assert from "node:assert/strict";
import test from "node:test";

import { loadConfig } from "../dist/config.js";
import { createObMcpServer } from "../dist/mcp.js";

test("ob_detect_time_columns returns metadata-based time column candidates", async () => {
  const config = loadConfig({
    OB_ALLOWED_SCHEMAS: "biz_test",
    OB_DENIED_COLUMNS: "secret_token",
    OB_ENFORCE_READ_ONLY_TX: "false"
  });
  const server = createObMcpServer(runtime(config));

  const result = await server.executeToolHandler(server._registeredTools.ob_detect_time_columns, {
    schema: "biz_test",
    table: "orders"
  }, {});
  const detection = JSON.parse(result.content[0].text);
  const byColumn = new Map(detection.candidates.map((candidate) => [candidate.column, candidate]));

  assert.equal(detection.mode, "mysql");
  assert.equal(detection.schema, "biz_test");
  assert.equal(detection.table, "orders");
  assert.equal(byColumn.get("created_at").kind, "created_time");
  assert.equal(byColumn.get("updated_at").kind, "updated_time");
  assert.equal(byColumn.get("paid_time").kind, "business_time");
  assert(byColumn.get("created_at").confidence >= 0.8);
  assert(byColumn.get("paid_time").evidence.some((item) => /business event time/i.test(item)));
  assert(!byColumn.has("status"));
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
        ordinal_position: 2
      },
      {
        table_schema: "biz_test",
        table_name: "orders",
        column_name: "created_at",
        column_type: "datetime",
        data_type: "datetime",
        is_nullable: "NO",
        ordinal_position: 3,
        column_comment: "created time"
      },
      {
        table_schema: "biz_test",
        table_name: "orders",
        column_name: "updated_at",
        column_type: "timestamp",
        data_type: "timestamp",
        is_nullable: "YES",
        ordinal_position: 4,
        column_comment: "updated time"
      },
      {
        table_schema: "biz_test",
        table_name: "orders",
        column_name: "paid_time",
        column_type: "datetime",
        data_type: "datetime",
        is_nullable: "YES",
        ordinal_position: 5,
        column_comment: "payment event time"
      },
      {
        table_schema: "biz_test",
        table_name: "orders",
        column_name: "secret_token",
        column_type: "varchar(128)",
        data_type: "varchar",
        is_nullable: "YES",
        ordinal_position: 6
      }
    ], []];
  }
  throw new Error(`Unexpected SQL: ${sql}`);
}
