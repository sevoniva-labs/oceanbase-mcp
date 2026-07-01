import assert from "node:assert/strict";
import test from "node:test";

import { loadConfig } from "../dist/config.js";
import { createObMcpServer } from "../dist/mcp.js";

test("ob_get_value_distribution returns masked bounded top values for one column", async () => {
  const config = loadConfig({
    OB_ALLOWED_SCHEMAS: "biz_test",
    OB_DENIED_COLUMNS: "secret_token",
    OB_MASKED_COLUMNS: "biz_test.orders.status",
    OB_MAX_ROWS: "5",
    OB_ENFORCE_READ_ONLY_TX: "false"
  });
  const server = createObMcpServer(runtime(config));

  const result = await server.executeToolHandler(server._registeredTools.ob_get_value_distribution, {
    schema: "biz_test",
    table: "orders",
    column: "status",
    rowLimit: 5,
    topN: 2
  }, {});
  const distribution = JSON.parse(result.content[0].text);
  const text = result.content[0].text;

  assert.equal(distribution.mode, "mysql");
  assert.equal(distribution.schema, "biz_test");
  assert.equal(distribution.table, "orders");
  assert.equal(distribution.column, "status");
  assert.equal(distribution.topN, 2);
  assert.equal(distribution.sampledRows, 5);
  assert.equal(distribution.masked, true);
  assert.equal(distribution.typeCategory, "string");
  assert.equal(distribution.enumCandidate.likely, true);
  assert.equal(distribution.nulls.count, 1);
  assert.equal(distribution.distinct.value, 2);
  assert.deepEqual(distribution.distribution.map((item) => item.value), ["***MASKED***", "***MASKED***"]);
  assert(distribution.warnings.some((warning) => /top 2 values/i.test(warning)));
  assert(distribution.warnings.some((warning) => /masked/i.test(warning)));
  assert.doesNotMatch(text, /PAID|NEW/);
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
    return [[{ sampled_count: 5, null_count: 1 }], []];
  }
  if (/COUNT\(DISTINCT profile_value\)/i.test(sql)) {
    return [[{ distinct_count: 2 }], []];
  }
  if (/MIN\(profile_value\)/i.test(sql)) {
    return [[{ min_value: "NEW", max_value: "PAID" }], []];
  }
  if (/GROUP BY profile_value/i.test(sql)) {
    return [[{ profile_value: "PAID", value_count: 3 }, { profile_value: "NEW", value_count: 1 }], []];
  }
  if (/profile_value AS sample_value/i.test(sql)) {
    return [[{ sample_value: "PAID" }], []];
  }

  throw new Error(`Unexpected SQL: ${sql}`);
}

function profileColumn(sql) {
  if (/`status` AS profile_value/i.test(sql)) {
    return "status";
  }
  if (/secret_token/i.test(sql)) {
    throw new Error("Denied column was queried");
  }
  return undefined;
}
