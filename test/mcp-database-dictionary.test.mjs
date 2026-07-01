import assert from "node:assert/strict";
import test from "node:test";

import { loadConfig } from "../dist/config.js";
import { createObMcpServer } from "../dist/mcp.js";

test("ob_get_database_dictionary renders MySQL markdown", async () => {
  const config = loadConfig({ OB_ALLOWED_SCHEMAS: "biz_test" });
  const server = createObMcpServer(runtime(config, mysqlPool()));

  const result = await server.executeToolHandler(server._registeredTools.ob_get_database_dictionary, {
    schema: "biz_test",
    format: "markdown",
    maxTables: 5,
    maxColumnsPerTable: 5
  }, {});
  const output = JSON.parse(result.content[0].text);

  assert.equal(output.format, "markdown");
  assert.equal(output.dictionary.tables[0].table, "orders");
  assert(output.markdown.includes("# OceanBase Data Dictionary"));
  assert(output.markdown.includes("orders"));
});

test("ob_get_database_dictionary returns Oracle JSON dictionary", async () => {
  const config = loadConfig({
    OB_COMPATIBILITY: "oracle",
    OB_ALLOWED_SCHEMAS: "APP"
  });
  const server = createObMcpServer(runtime(config, oraclePool()));

  const result = await server.executeToolHandler(server._registeredTools.ob_get_database_dictionary, {
    schema: "APP",
    format: "json",
    maxTables: 5
  }, {});
  const output = JSON.parse(result.content[0].text);

  assert.equal(output.format, "json");
  assert.equal(output.dictionary.tables[0].schema, "APP");
  assert.equal(output.dictionary.tables[0].columns[0].name, "ID");
  assert.equal(output.markdown, undefined);
});

test("ob_generate_data_dictionary renders MySQL HTML", async () => {
  const config = loadConfig({ OB_ALLOWED_SCHEMAS: "biz_test" });
  const server = createObMcpServer(runtime(config, mysqlPool()));

  const result = await server.executeToolHandler(server._registeredTools.ob_generate_data_dictionary, {
    schema: "biz_test",
    format: "html",
    maxTables: 5,
    maxColumnsPerTable: 5,
    title: "Local Dictionary"
  }, {});
  const output = JSON.parse(result.content[0].text);

  assert.equal(output.format, "html");
  assert.equal(output.contentType, "text/html");
  assert.equal(output.executed, false);
  assert.match(output.html, /<title>Local Dictionary<\/title>/);
  assert.match(output.html, /orders table/);
  assert.match(output.html, /No sample data values are included/);
});

test("ob_generate_data_dictionary returns Oracle JSON dictionary", async () => {
  const config = loadConfig({
    OB_COMPATIBILITY: "oracle",
    OB_ALLOWED_SCHEMAS: "APP"
  });
  const server = createObMcpServer(runtime(config, oraclePool()));

  const result = await server.executeToolHandler(server._registeredTools.ob_generate_data_dictionary, {
    schema: "APP",
    format: "json",
    maxTables: 5
  }, {});
  const output = JSON.parse(result.content[0].text);

  assert.equal(output.format, "json");
  assert.equal(output.dictionary.tables[0].schema, "APP");
  assert.equal(output.html, undefined);
  assert.equal(output.markdown, undefined);
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
      if (/FROM information_schema\.table_constraints/i.test(sql)) {
        return [[{ table_schema: "biz_test", table_name: "orders", constraint_name: "PRIMARY", constraint_type: "PRIMARY KEY", column_name: "id" }], []];
      }
      if (/FROM information_schema\.tables/i.test(sql)) {
        return [[{ table_schema: "biz_test", table_name: "orders", table_type: "BASE TABLE", engine: "OceanBase", table_comment: "orders table", table_rows: 42 }], []];
      }
      if (/FROM information_schema\.columns/i.test(sql)) {
        return [[
          { table_schema: "biz_test", table_name: "orders", column_name: "id", column_type: "bigint", data_type: "bigint", is_nullable: "NO", ordinal_position: 1 },
          { table_schema: "biz_test", table_name: "orders", column_name: "status", column_type: "varchar(32)", data_type: "varchar", is_nullable: "YES", ordinal_position: 2, column_comment: "order status" }
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
      if (/FROM all_tables t/i.test(sql)) {
        return [[{ OWNER: "APP", TABLE_NAME: "ORDERS", TABLE_COMMENT: "orders table", NUM_ROWS: 12 }], []];
      }
      if (/FROM user_constraints c/i.test(sql)) {
        return [[{ OWNER: "APP", TABLE_NAME: "ORDERS", CONSTRAINT_NAME: "PK_ORDERS", CONSTRAINT_TYPE: "P", COLUMN_NAME: "ID", POSITION: 1 }], []];
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
