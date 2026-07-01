import assert from "node:assert/strict";
import test from "node:test";

import { loadConfig } from "../dist/config.js";
import { createObMcpServer } from "../dist/mcp.js";

test("ob_generate_schema_doc renders bounded MySQL markdown", async () => {
  const config = loadConfig({ OB_ALLOWED_SCHEMAS: "biz_test" });
  const server = createObMcpServer(runtime(config, mysqlPool()));

  const result = await server.executeToolHandler(server._registeredTools.ob_generate_schema_doc, {
    schema: "biz_test",
    format: "markdown",
    includeRelationships: false,
    maxTables: 2,
    maxColumnsPerTable: 5
  }, {});
  const output = JSON.parse(result.content[0].text);

  assert.equal(output.executed, false);
  assert.equal(output.schema, "biz_test");
  assert.equal(output.document.tableCount, 2);
  assert.match(output.markdown, /# Schema Documentation: biz_test/);
  assert.match(output.markdown, /orders table/);
  assert.match(output.markdown, /No sample data values are included/);
  assert(output.document.tables.some((table) => table.table === "orders" && table.primaryKeys.includes("id")));
});

test("ob_generate_schema_doc returns Oracle JSON with visible tables", async () => {
  const config = loadConfig({
    OB_COMPATIBILITY: "oracle",
    OB_ALLOWED_SCHEMAS: "APP"
  });
  const server = createObMcpServer(runtime(config, oraclePool()));

  const result = await server.executeToolHandler(server._registeredTools.ob_generate_schema_doc, {
    schema: "APP",
    format: "json",
    includeRelationships: false,
    maxTables: 1
  }, {});
  const output = JSON.parse(result.content[0].text);

  assert.equal(output.mode, "oracle");
  assert.equal(output.schema, "APP");
  assert.equal(output.markdown, undefined);
  assert.equal(output.document.tableCount, 1);
  assert.equal(output.document.tables[0].table, "ORDERS");
  assert(output.document.tables[0].timeFields.includes("CREATED_AT"));
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
      if (/FROM information_schema\.tables/i.test(sql)) {
        return [[
          { table_schema: "biz_test", table_name: "orders", table_type: "BASE TABLE", engine: "OceanBase", table_comment: "orders table", table_rows: 42 },
          { table_schema: "biz_test", table_name: "order_items", table_type: "BASE TABLE", engine: "OceanBase", table_comment: "order item table", table_rows: 100 }
        ], []];
      }
      if (/FROM information_schema\.table_constraints/i.test(sql)) {
        const table = String(values[1]);
        return [[{ table_schema: "biz_test", table_name: table, constraint_name: `PK_${table}`, constraint_type: "PRIMARY KEY", column_name: "id", ordinal_position: 1 }], []];
      }
      if (/FROM information_schema\.columns/i.test(sql)) {
        const table = String(values[0]);
        return [[
          { table_schema: "biz_test", table_name: table, column_name: "id", column_type: "bigint", data_type: "bigint", is_nullable: "NO", ordinal_position: 1 },
          { table_schema: "biz_test", table_name: table, column_name: "status", column_type: "varchar(32)", data_type: "varchar", is_nullable: "YES", ordinal_position: 2, column_comment: "status" },
          { table_schema: "biz_test", table_name: table, column_name: "created_at", column_type: "datetime", data_type: "datetime", is_nullable: "YES", ordinal_position: 3 }
        ], []];
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
        return [[{ OWNER: "APP", TABLE_NAME: "ORDERS", TABLE_COMMENT: "orders table", NUM_ROWS: 12 }], []];
      }
      if (/FROM user_constraints c/i.test(sql)) {
        return [[{ OWNER: "APP", TABLE_NAME: "ORDERS", CONSTRAINT_NAME: "PK_ORDERS", CONSTRAINT_TYPE: "P", COLUMN_NAME: "ID", POSITION: 1 }], []];
      }
      if (/FROM user_tab_columns c/i.test(sql)) {
        const table = String(values[1]);
        return [[
          { OWNER: "APP", TABLE_NAME: table, COLUMN_NAME: "ID", DATA_TYPE: "NUMBER", DATA_PRECISION: 20, NULLABLE: "N", COLUMN_ID: 1 },
          { OWNER: "APP", TABLE_NAME: table, COLUMN_NAME: "CREATED_AT", DATA_TYPE: "DATE", NULLABLE: "Y", COLUMN_ID: 2 }
        ], []];
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    }
  };
}
