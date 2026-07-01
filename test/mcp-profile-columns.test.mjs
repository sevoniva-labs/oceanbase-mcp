import assert from "node:assert/strict";
import test from "node:test";

import { loadConfig } from "../dist/config.js";
import { createObMcpServer } from "../dist/mcp.js";

test("ob_profile_columns returns bounded profiles and masks sensitive values", async () => {
  const config = loadConfig({
    OB_ALLOWED_SCHEMAS: "biz_test",
    OB_DENIED_COLUMNS: "secret_token",
    OB_MASKED_COLUMNS: "biz_test.orders.status",
    OB_MAX_ROWS: "5"
  });
  const server = createObMcpServer(runtime(config));
  const result = await server.executeToolHandler(server._registeredTools.ob_profile_columns, {
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
  assert.equal(profile.rowLimit, 5);
  assert.deepEqual(profile.columns.map((column) => column.column), ["id", "status"]);
  assert(profile.warnings.some((warning) => /bounded sample/.test(warning)));
  assert(profile.warnings.some((warning) => /row estimate is 42/i.test(warning)));

  const id = profile.columns.find((column) => column.column === "id");
  assert.equal(id.sampledRows, 5);
  assert.equal(id.nulls.count, 0);
  assert.equal(id.distinct.value, 5);
  assert.equal(id.min, 1);
  assert.equal(id.max, 5);
  assert.deepEqual(id.sampleValues, [1, 2]);

  const status = profile.columns.find((column) => column.column === "status");
  assert.equal(status.masked, true);
  assert.equal(status.nulls.count, 1);
  assert.equal(status.min, "***MASKED***");
  assert.equal(status.max, "***MASKED***");
  assert.deepEqual(status.topValues.map((item) => item.value), ["***MASKED***", "***MASKED***"]);
  assert.deepEqual(status.sampleValues, ["***MASKED***", "***MASKED***"]);
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
  if (/COUNT\(DISTINCT index_name\)/i.test(sql)) {
    return [[{ item_count: 1 }], []];
  }
  if (/COUNT\(DISTINCT constraint_name\)/i.test(sql)) {
    return [[{ item_count: 1 }], []];
  }
  if (/COUNT\(\*\) AS item_count FROM information_schema\.columns/i.test(sql)) {
    return [[{ item_count: 3 }], []];
  }
  if (/COUNT\(\*\) AS item_count\s+FROM information_schema\.partitions/i.test(sql)) {
    return [[{ item_count: 0 }], []];
  }
  if (/FROM information_schema\.tables/i.test(sql)) {
    return [[{
      table_schema: "biz_test",
      table_name: "orders",
      table_rows: 42,
      data_length: 4096,
      index_length: 1024
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
        column_name: "secret_token",
        column_type: "varchar(128)",
        data_type: "varchar",
        is_nullable: "YES",
        ordinal_position: 3
      }
    ], []];
  }

  const column = profileColumn(sql);
  if (!column) {
    throw new Error(`Unexpected SQL: ${sql}`);
  }
  if (/COUNT\(1\) AS sampled_count/i.test(sql)) {
    return [[{ sampled_count: 5, null_count: column === "status" ? 1 : 0 }], []];
  }
  if (/COUNT\(DISTINCT profile_value\)/i.test(sql)) {
    return [[{ distinct_count: column === "status" ? 2 : 5 }], []];
  }
  if (/MIN\(profile_value\)/i.test(sql)) {
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
  if (/secret_token/i.test(sql)) {
    throw new Error("Denied column was queried");
  }
  return undefined;
}
