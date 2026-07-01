import assert from "node:assert/strict";
import test from "node:test";

import { loadConfig } from "../dist/config.js";
import { createObMcpServer } from "../dist/mcp.js";

test("ob_profile_table returns bounded table profile with masked sampled signals", async () => {
  const config = loadConfig({
    OB_ALLOWED_SCHEMAS: "biz_test",
    OB_DENIED_COLUMNS: "secret_token",
    OB_MASKED_COLUMNS: "biz_test.orders.status",
    OB_MAX_ROWS: "5",
    OB_ENFORCE_READ_ONLY_TX: "false"
  });
  const server = createObMcpServer(runtime(config));

  const result = await server.executeToolHandler(server._registeredTools.ob_profile_table, {
    schema: "biz_test",
    table: "orders",
    rowLimit: 5,
    topValues: 2,
    sampleValues: 2
  }, {});
  const profile = JSON.parse(result.content[0].text);

  assert.equal(profile.mode, "mysql");
  assert.equal(profile.schema, "biz_test");
  assert.equal(profile.table, "orders");
  assert.equal(profile.rowEstimate.value, 42);
  assert.equal(profile.objectCounts.visibleColumns, 4);
  assert.deepEqual(profile.primaryKeys, ["id"]);
  assert(profile.keyFields.includes("id"));
  assert(profile.keyFields.includes("status"));
  assert(profile.timeFields.some((field) => field.column === "created_at" && field.min === "2026-01-01 00:00:00"));
  assert(profile.statusFields.some((field) => field.column === "status" && field.masked === true));
  assert(profile.nullOverview.some((field) => field.column === "status" && field.masked === true && field.nullRatio === 0.2));
  assert(profile.indexSummary.some((index) => index.name === "idx_status" && index.columns.includes("status")));
  assert.equal(profile.profileScope.rowLimit, 5);
  assert(!profile.profileScope.selectedColumns.includes("secret_token"));
  assert(!profile.columnProfiles.some((column) => column.column === "secret_token"));
  assert(profile.columnProfiles.find((column) => column.column === "status").topValues.every((item) => item.value === "***MASKED***"));
  assert(profile.warnings.some((warning) => /bounded column samples/i.test(warning)));
  assert(profile.warnings.some((warning) => /row estimate is 42/i.test(warning)));
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
  if (/SHOW CREATE TABLE/i.test(sql)) {
    return [[{ "Create Table": "CREATE TABLE `orders` (`id` bigint PRIMARY KEY)" }], []];
  }
  if (/COUNT\(DISTINCT index_name\)/i.test(sql)) {
    return [[{ item_count: 2 }], []];
  }
  if (/COUNT\(DISTINCT constraint_name\)/i.test(sql)) {
    return [[{ item_count: 2 }], []];
  }
  if (/COUNT\(\*\) AS item_count\s+FROM information_schema\.columns/i.test(sql)) {
    return [[{ item_count: 5 }], []];
  }
  if (/COUNT\(\*\) AS item_count\s+FROM information_schema\.partitions/i.test(sql)) {
    return [[{ item_count: 0 }], []];
  }
  if (/FROM information_schema\.statistics/i.test(sql)) {
    return [[
      { table_schema: "biz_test", table_name: "orders", index_name: "PRIMARY", non_unique: 0, seq_in_index: 1, column_name: "id", index_type: "BTREE" },
      { table_schema: "biz_test", table_name: "orders", index_name: "idx_status", non_unique: 1, seq_in_index: 1, column_name: "status", index_type: "BTREE" }
    ], []];
  }
  if (/FROM information_schema\.table_constraints/i.test(sql)) {
    return [[
      {
        table_schema: "biz_test",
        table_name: "orders",
        constraint_name: "PRIMARY",
        constraint_type: "PRIMARY KEY",
        column_name: "id",
        ordinal_position: 1
      },
      {
        table_schema: "biz_test",
        table_name: "orders",
        constraint_name: "NOT_NULL_id",
        constraint_type: "NOT_NULL",
        column_name: "id",
        ordinal_position: 1
      }
    ], []];
  }
  if (/FROM information_schema\.partitions/i.test(sql)) {
    return [[], []];
  }
  if (/FROM information_schema\.tables/i.test(sql)) {
    return [[{
      table_schema: "biz_test",
      table_name: "orders",
      table_rows: 42,
      data_length: 4096,
      index_length: 1024,
      update_time: "2026-06-01 10:00:00"
    }], []];
  }
  if (/FROM information_schema\.columns/i.test(sql)) {
    return [[
      {
        table_schema: "biz_test",
        table_name: "orders",
        column_name: "id",
        column_type: "bigint",
        data_type: "bigint",
        is_nullable: "NO",
        ordinal_position: 1,
        column_comment: "primary key"
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
        column_type: "datetime",
        data_type: "datetime",
        is_nullable: "YES",
        ordinal_position: 4,
        column_comment: "updated time"
      },
      {
        table_schema: "biz_test",
        table_name: "orders",
        column_name: "secret_token",
        column_type: "varchar(128)",
        data_type: "varchar",
        is_nullable: "YES",
        ordinal_position: 5,
        column_comment: "secret"
      }
    ], []];
  }

  const column = profileColumn(sql);
  if (!column) {
    throw new Error(`Unexpected SQL: ${sql}`);
  }
  if (/COUNT\(1\) AS sampled_count/i.test(sql)) {
    return [[{ sampled_count: 5, null_count: column === "status" ? 1 : column === "updated_at" ? 2 : 0 }], []];
  }
  if (/COUNT\(DISTINCT profile_value\)/i.test(sql)) {
    return [[{ distinct_count: column === "status" ? 2 : 5 }], []];
  }
  if (/MIN\(profile_value\)/i.test(sql)) {
    if (column === "created_at") {
      return [[{ min_value: "2026-01-01 00:00:00", max_value: "2026-01-05 00:00:00" }], []];
    }
    if (column === "updated_at") {
      return [[{ min_value: "2026-01-02 00:00:00", max_value: "2026-01-06 00:00:00" }], []];
    }
    return [[column === "status" ? { min_value: "NEW", max_value: "PAID" } : { min_value: 1, max_value: 5 }], []];
  }
  if (/GROUP BY profile_value/i.test(sql)) {
    return [
      column === "status"
        ? [{ profile_value: "PAID", value_count: 3 }, { profile_value: "NEW", value_count: 1 }]
        : [{ profile_value: 1, value_count: 1 }, { profile_value: 2, value_count: 1 }],
      []
    ];
  }
  if (/profile_value AS sample_value/i.test(sql)) {
    return [
      column === "status" ? [{ sample_value: "PAID" }, { sample_value: "NEW" }] : [{ sample_value: 1 }, { sample_value: 2 }],
      []
    ];
  }

  throw new Error(`Unexpected SQL: ${sql}`);
}

function profileColumn(sql) {
  if (/`id` AS profile_value/i.test(sql)) {
    return "id";
  }
  if (/`status` AS profile_value/i.test(sql)) {
    return "status";
  }
  if (/`created_at` AS profile_value/i.test(sql)) {
    return "created_at";
  }
  if (/`updated_at` AS profile_value/i.test(sql)) {
    return "updated_at";
  }
  if (/secret_token/i.test(sql)) {
    throw new Error("Denied column was queried");
  }
  return undefined;
}
