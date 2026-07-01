import assert from "node:assert/strict";
import test from "node:test";

import { loadConfig } from "../dist/config.js";
import { createObMcpServer } from "../dist/mcp.js";

test("ob_generate_table_doc renders MySQL markdown from visible metadata", async () => {
  const config = loadConfig({ OB_ALLOWED_SCHEMAS: "biz_test" });
  const server = createObMcpServer(runtime(config, mysqlPool()));

  const result = await server.executeToolHandler(server._registeredTools.ob_generate_table_doc, {
    schema: "biz_test",
    table: "orders",
    format: "markdown",
    includeRelationships: false,
    maxColumns: 10
  }, {});
  const output = JSON.parse(result.content[0].text);

  assert.equal(output.executed, false);
  assert.equal(output.schema, "biz_test");
  assert.equal(output.table, "orders");
  assert.match(output.markdown, /# Table Documentation: biz_test\.orders/);
  assert.match(output.markdown, /order status/);
  assert.match(output.markdown, /No sample data values are included/);
  assert(output.document.primaryKeys.includes("id"));
  assert(output.document.indexes.some((index) => index.name === "PRIMARY"));
  assert(output.document.queryExamples.examples.some((example) => example.scenario === "by_primary_key" && example.executed === false));
});

test("ob_generate_table_doc returns Oracle JSON documentation", async () => {
  const config = loadConfig({
    OB_COMPATIBILITY: "oracle",
    OB_ALLOWED_SCHEMAS: "APP"
  });
  const server = createObMcpServer(runtime(config, oraclePool()));

  const result = await server.executeToolHandler(server._registeredTools.ob_generate_table_doc, {
    schema: "APP",
    table: "ORDERS",
    format: "json",
    includeRelationships: false,
    includeQueryExamples: true
  }, {});
  const output = JSON.parse(result.content[0].text);

  assert.equal(output.mode, "oracle");
  assert.equal(output.schema, "APP");
  assert.equal(output.table, "ORDERS");
  assert.equal(output.markdown, undefined);
  assert(output.document.primaryKeys.includes("ID"));
  assert(output.document.columns.some((column) => column.name === "CREATED_AT" && column.roles.includes("time")));
  assert(output.document.queryExamples.examples.some((example) => /FETCH FIRST|ROWNUM|OFFSET/.test(example.sql)));
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
