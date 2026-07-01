import assert from "node:assert/strict";
import test from "node:test";

import { loadConfig } from "../dist/config.js";
import { createObMcpServer } from "../dist/mcp.js";

test("ob_check_data_quality reports bounded null and duplicate risks", async () => {
  const config = loadConfig({
    OB_ALLOWED_SCHEMAS: "biz_test",
    OB_MASKED_COLUMNS: "biz_test.orders.status",
    OB_MAX_ROWS: "5",
    OB_ENFORCE_READ_ONLY_TX: "false"
  });
  const server = createObMcpServer(runtime(config));

  const result = await server.executeToolHandler(server._registeredTools.ob_check_data_quality, {
    schema: "biz_test",
    table: "orders",
    columns: ["id", "status", "created_at"],
    rowLimit: 5
  }, {});
  const report = JSON.parse(result.content[0].text);
  const rules = new Set(report.checks.map((check) => check.rule));

  assert.equal(report.mode, "mysql");
  assert.equal(report.schema, "biz_test");
  assert.equal(report.table, "orders");
  assert.deepEqual(report.primaryKeys, ["id"]);
  assert.equal(report.profileScope.rowLimit, 5);
  assert(rules.has("duplicate_key_risk"));
  assert(rules.has("null_values"));
  assert(rules.has("time_column_nulls"));
  assert.equal(report.summary.high, 1);
  assert.equal(report.summary.status, "attention_required");
  assert(report.columnProfiles.find((column) => column.column === "status").topValues.every((item) => item.value === "***MASKED***"));
  assert.doesNotMatch(result.content[0].text, /PAID|NEW/);
  assert(report.warnings.some((warning) => /bounded samples/i.test(warning)));
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
  if (/FROM information_schema\.statistics/i.test(sql)) {
    return [[
      { table_schema: "biz_test", table_name: "orders", index_name: "PRIMARY", non_unique: 0, seq_in_index: 1, column_name: "id", index_type: "BTREE" }
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
        is_nullable: "YES",
        ordinal_position: 3,
        column_comment: "created time"
      }
    ], []];
  }

  const column = profileColumn(sql);
  if (!column) {
    throw new Error(`Unexpected SQL: ${sql}`);
  }
  if (/COUNT\(1\) AS sampled_count/i.test(sql)) {
    return [[{ sampled_count: 5, null_count: column === "status" || column === "created_at" ? 1 : 0 }], []];
  }
  if (/COUNT\(DISTINCT profile_value\)/i.test(sql)) {
    return [[{ distinct_count: column === "id" ? 4 : column === "status" ? 2 : 5 }], []];
  }
  if (/MIN\(profile_value\)/i.test(sql)) {
    if (column === "created_at") {
      return [[{ min_value: "2026-01-01 00:00:00", max_value: "2026-01-05 00:00:00" }], []];
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
    return [[column === "status" ? { sample_value: "PAID" } : { sample_value: 1 }], []];
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
  return undefined;
}
