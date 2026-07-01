import assert from "node:assert/strict";
import test from "node:test";

import { loadConfig } from "../dist/config.js";
import { createObMcpServer } from "../dist/mcp.js";

test("ob_get_table_summary returns MySQL purpose and query entry points", async () => {
  const config = loadConfig({ OB_ALLOWED_SCHEMAS: "biz_test" });
  const server = createObMcpServer(runtime(config, mysqlPool()));

  const result = await server.executeToolHandler(server._registeredTools.ob_get_table_summary, {
    schema: "biz_test",
    table: "orders",
    includeRelated: false
  }, {});
  const summary = JSON.parse(result.content[0].text);

  assert.equal(summary.schema, "biz_test");
  assert.equal(summary.table, "orders");
  assert.equal(summary.purpose.inferred, true);
  assert(summary.primaryKeys.includes("id"));
  assert(summary.timeFields.includes("created_at"));
  assert(summary.statusFields.includes("status"));
  assert(summary.queryEntryPoints.some((entry) => entry.type === "primary_key_lookup"));
});

test("ob_get_table_summary returns Oracle table summary", async () => {
  const config = loadConfig({
    OB_COMPATIBILITY: "oracle",
    OB_ALLOWED_SCHEMAS: "APP"
  });
  const server = createObMcpServer(runtime(config, oraclePool()));

  const result = await server.executeToolHandler(server._registeredTools.ob_get_table_summary, {
    schema: "APP",
    table: "ORDERS",
    includeRelated: false
  }, {});
  const summary = JSON.parse(result.content[0].text);

  assert.equal(summary.mode, "oracle");
  assert.equal(summary.schema, "APP");
  assert.equal(summary.table, "ORDERS");
  assert(summary.primaryKeys.includes("ID"));
  assert(summary.queryEntryPoints.some((entry) => entry.type === "primary_key_lookup"));
});

function runtime(config, pool) {
  return {
    defaultProfile: "default",
    configs: { default: config },
    pools: { default: pool },
    queryLimiters: { default: { active: 0, limit: 5 } }
  };
}

function mysqlPool() {
  return {
    async query({ sql }) {
      if (/SHOW CREATE TABLE/i.test(sql)) {
        return [[{ "Create Table": "CREATE TABLE `biz_test`.`orders` (`id` bigint NOT NULL, `status` varchar(32), `created_at` datetime, PRIMARY KEY (`id`))" }], []];
      }
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
      if (/FROM information_schema\.statistics/i.test(sql)) {
        return [[{ table_schema: "biz_test", table_name: "orders", index_name: "PRIMARY", non_unique: 0, seq_in_index: 1, column_name: "id" }], []];
      }
      if (/FROM information_schema\.table_constraints/i.test(sql)) {
        return [[{ table_schema: "biz_test", table_name: "orders", constraint_name: "PRIMARY", constraint_type: "PRIMARY KEY", column_name: "id", ordinal_position: 1 }], []];
      }
      if (/FROM information_schema\.partitions/i.test(sql)) {
        return [[], []];
      }
      if (/FROM information_schema\.tables/i.test(sql)) {
        return [[{ table_schema: "biz_test", table_name: "orders", table_type: "BASE TABLE", engine: "OceanBase", table_comment: "orders table", table_rows: 42, data_length: 4096, index_length: 1024 }], []];
      }
      if (/FROM information_schema\.columns/i.test(sql)) {
        return [[
          { table_schema: "biz_test", table_name: "orders", column_name: "id", column_type: "bigint", data_type: "bigint", is_nullable: "NO", ordinal_position: 1 },
          { table_schema: "biz_test", table_name: "orders", column_name: "status", column_type: "varchar(32)", data_type: "varchar", is_nullable: "YES", ordinal_position: 2, column_comment: "order status" },
          { table_schema: "biz_test", table_name: "orders", column_name: "created_at", column_type: "datetime", data_type: "datetime", is_nullable: "YES", ordinal_position: 3 }
        ], []];
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    }
  };
}

function oraclePool() {
  return {
    async query({ sql }) {
      if (/USER AS schema_name FROM DUAL/i.test(sql)) {
        return [[{ SCHEMA_NAME: "APP" }], []];
      }
      if (/COUNT\(\*\) AS item_count/i.test(sql)) {
        return [[{ ITEM_COUNT: 1 }], []];
      }
      if (/FROM all_tables t/i.test(sql)) {
        return [[{ OWNER: "APP", TABLE_NAME: "ORDERS", TABLE_COMMENT: "orders table", NUM_ROWS: 12 }], []];
      }
      if (/FROM all_tables/i.test(sql)) {
        return [[{ OWNER: "APP", TABLE_NAME: "ORDERS", NUM_ROWS: 12, BLOCKS: 2 }], []];
      }
      if (/FROM user_indexes i/i.test(sql)) {
        return [[{ OWNER: "APP", TABLE_NAME: "ORDERS", INDEX_NAME: "PK_ORDERS", UNIQUENESS: "UNIQUE", COLUMN_NAME: "ID", COLUMN_POSITION: 1 }], []];
      }
      if (/FROM user_constraints c/i.test(sql)) {
        return [[{ OWNER: "APP", TABLE_NAME: "ORDERS", CONSTRAINT_NAME: "PK_ORDERS", CONSTRAINT_TYPE: "P", COLUMN_NAME: "ID", POSITION: 1 }], []];
      }
      if (/FROM user_tab_partitions/i.test(sql)) {
        return [[], []];
      }
      if (/FROM user_tab_columns c/i.test(sql)) {
        return [[
          { OWNER: "APP", TABLE_NAME: "ORDERS", COLUMN_NAME: "ID", DATA_TYPE: "NUMBER", DATA_PRECISION: 20, NULLABLE: "N", COLUMN_ID: 1 },
          { OWNER: "APP", TABLE_NAME: "ORDERS", COLUMN_NAME: "CREATED_AT", DATA_TYPE: "DATE", NULLABLE: "Y", COLUMN_ID: 2 }
        ], []];
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    }
  };
}
