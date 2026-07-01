import assert from "node:assert/strict";
import test from "node:test";

import { loadConfig } from "../dist/config.js";
import { createObMcpServer } from "../dist/mcp.js";

test("ob_generate_onboarding_doc renders MySQL markdown from metadata and glossary", async () => {
  const config = loadConfig({ OB_ALLOWED_SCHEMAS: "biz_test" });
  config.businessGlossary = {
    file: "inline",
    entries: [{
      term: "订单",
      aliases: ["order"],
      description: "订单业务对象",
      targets: [
        { schema: "biz_test", table: "orders", description: "订单主表" },
        { schema: "biz_test", table: "order_items", description: "订单明细表" }
      ]
    }]
  };
  const server = createObMcpServer(runtime(config, mysqlPool()));

  const result = await server.executeToolHandler(server._registeredTools.ob_generate_onboarding_doc, {
    schema: "biz_test",
    businessTerms: ["订单"],
    format: "markdown",
    maxTables: 5,
    maxCoreTables: 3,
    maxColumnsPerTable: 5,
    title: "Local Onboarding"
  }, {});
  const output = JSON.parse(result.content[0].text);

  assert.equal(output.executed, false);
  assert.equal(output.schema, "biz_test");
  assert.equal(output.document.businessGlossary.configured, true);
  assert(output.document.coreTables.some((table) => table.table === "orders"));
  assert(output.document.relationships.some((relation) => relation.sourceTable === "order_items" && relation.targetTable === "orders"));
  assert(output.document.queryEntryPoints.some((entry) => entry.type === "primary_key_lookup"));
  assert.match(output.markdown, /# Local Onboarding/);
  assert.match(output.markdown, /订单业务对象/);
  assert.match(output.markdown, /No sample data values are included/);
});

test("ob_generate_onboarding_doc returns Oracle JSON onboarding document", async () => {
  const config = loadConfig({
    OB_COMPATIBILITY: "oracle",
    OB_ALLOWED_SCHEMAS: "APP"
  });
  const server = createObMcpServer(runtime(config, oraclePool()));

  const result = await server.executeToolHandler(server._registeredTools.ob_generate_onboarding_doc, {
    schema: "APP",
    format: "json",
    maxTables: 3,
    maxCoreTables: 2,
    maxColumnsPerTable: 5
  }, {});
  const output = JSON.parse(result.content[0].text);

  assert.equal(output.mode, "oracle");
  assert.equal(output.schema, "APP");
  assert.equal(output.markdown, undefined);
  assert.equal(output.document.coreTables[0].table, "ORDERS");
  assert(output.document.coreTables[0].primaryKeys.includes("ID"));
  assert(output.document.queryEntryPoints.some((entry) => entry.type === "time_range"));
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
    async query({ sql, values = [] }) {
      if (/LOWER\(table_name\) IN/i.test(sql)) {
        return [[], []];
      }
      if (/FROM information_schema\.tables/i.test(sql)) {
        return [[
          { table_schema: "biz_test", table_name: "orders", table_type: "BASE TABLE", engine: "OceanBase", table_comment: "orders table", table_rows: 42 },
          { table_schema: "biz_test", table_name: "order_items", table_type: "BASE TABLE", engine: "OceanBase", table_comment: "order item table", table_rows: 100 }
        ], []];
      }
      if (/FROM information_schema\.table_constraints tc/i.test(sql)) {
        const table = String(values[1]);
        return [[{ table_schema: "biz_test", table_name: table, constraint_name: `PK_${table}`, constraint_type: "PRIMARY KEY", column_name: "id", ordinal_position: 1 }], []];
      }
      if (/FROM information_schema\.columns c\s+LEFT JOIN information_schema\.statistics/i.test(sql)) {
        return [[], []];
      }
      if (/FROM information_schema\.columns/i.test(sql)) {
        const table = String(values[0]);
        return [[
          { table_schema: "biz_test", table_name: table, column_name: "id", column_type: "bigint", data_type: "bigint", is_nullable: "NO", ordinal_position: 1 },
          { table_schema: "biz_test", table_name: table, column_name: table === "order_items" ? "order_id" : "status", column_type: "bigint", data_type: table === "order_items" ? "bigint" : "varchar", is_nullable: "YES", ordinal_position: 2, column_comment: table === "order_items" ? "order id" : "order status" },
          { table_schema: "biz_test", table_name: table, column_name: "created_at", column_type: "datetime", data_type: "datetime", is_nullable: "YES", ordinal_position: 3 }
        ], []];
      }
      if (/FROM information_schema\.statistics/i.test(sql)) {
        return [[], []];
      }
      if (/FROM information_schema\.key_column_usage kcu/i.test(sql)) {
        const table = String(values[1]);
        if (/referenced_table_schema = \?/i.test(sql) && table === "orders") {
          return [[{
            constraint_name: "fk_order_items_order",
            source_schema: "biz_test",
            source_table: "order_items",
            source_column: "order_id",
            target_schema: "biz_test",
            target_table: "orders",
            target_column: "id"
          }], []];
        }
        if (/kcu\.table_schema = \?/i.test(sql) && table === "order_items") {
          return [[{
            constraint_name: "fk_order_items_order",
            source_schema: "biz_test",
            source_table: "order_items",
            source_column: "order_id",
            target_schema: "biz_test",
            target_table: "orders",
            target_column: "id"
          }], []];
        }
        return [[], []];
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    }
  };
}

function oraclePool() {
  return {
    async query({ sql, values = [] }) {
      if (/USER AS schema_name FROM DUAL/i.test(sql)) {
        return [[{ SCHEMA_NAME: "APP" }], []];
      }
      if (/FROM all_tables t/i.test(sql)) {
        return [[
          { OWNER: "APP", TABLE_NAME: "ORDERS", TABLE_COMMENT: "orders table", NUM_ROWS: 12 },
          { OWNER: "APP", TABLE_NAME: "ORDER_ITEMS", TABLE_COMMENT: "order item table", NUM_ROWS: 20 }
        ], []];
      }
      if (/FROM user_tab_columns c/i.test(sql)) {
        const table = String(values[1]);
        return [[
          { OWNER: "APP", TABLE_NAME: table, COLUMN_NAME: "ID", DATA_TYPE: "NUMBER", DATA_PRECISION: 20, NULLABLE: "N", COLUMN_ID: 1 },
          { OWNER: "APP", TABLE_NAME: table, COLUMN_NAME: table === "ORDER_ITEMS" ? "ORDER_ID" : "STATUS", DATA_TYPE: table === "ORDER_ITEMS" ? "NUMBER" : "VARCHAR2", DATA_LENGTH: 32, NULLABLE: "Y", COLUMN_ID: 2 },
          { OWNER: "APP", TABLE_NAME: table, COLUMN_NAME: "CREATED_AT", DATA_TYPE: "DATE", NULLABLE: "Y", COLUMN_ID: 3 }
        ], []];
      }
      if (/FROM user_constraints c/i.test(sql)) {
        const table = String(values[1]);
        return [[{ OWNER: "APP", TABLE_NAME: table, CONSTRAINT_NAME: `PK_${table}`, CONSTRAINT_TYPE: "P", COLUMN_NAME: "ID", POSITION: 1 }], []];
      }
      if (/FROM user_indexes i/i.test(sql)) {
        return [[], []];
      }
      if (/FROM all_constraints c\s+JOIN all_cons_columns cc/i.test(sql) && /c\.constraint_type = 'R'/i.test(sql)) {
        const table = String(values[1]);
        if (/r\.owner = \?/i.test(sql) && table === "ORDERS") {
          return [[{
            CONSTRAINT_NAME: "FK_ORDER_ITEMS_ORDER",
            SOURCE_SCHEMA: "APP",
            SOURCE_TABLE: "ORDER_ITEMS",
            SOURCE_COLUMN: "ORDER_ID",
            TARGET_SCHEMA: "APP",
            TARGET_TABLE: "ORDERS",
            TARGET_COLUMN: "ID"
          }], []];
        }
        if (/c\.owner = \?/i.test(sql) && table === "ORDER_ITEMS") {
          return [[{
            CONSTRAINT_NAME: "FK_ORDER_ITEMS_ORDER",
            SOURCE_SCHEMA: "APP",
            SOURCE_TABLE: "ORDER_ITEMS",
            SOURCE_COLUMN: "ORDER_ID",
            TARGET_SCHEMA: "APP",
            TARGET_TABLE: "ORDERS",
            TARGET_COLUMN: "ID"
          }], []];
        }
        return [[], []];
      }
      if (/FROM all_constraints c\s+JOIN all_cons_columns cc/i.test(sql)) {
        return [[{ COLUMN_NAME: "ID" }], []];
      }
      if (/FROM all_tab_columns c\s+LEFT JOIN all_ind_columns/i.test(sql)) {
        return [[], []];
      }
      if (/FROM all_tables/i.test(sql) && /table_name IN/i.test(sql)) {
        return [[], []];
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    }
  };
}
