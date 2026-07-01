import assert from "node:assert/strict";
import test from "node:test";

import { loadConfig } from "../dist/config.js";
import { createObMcpServer } from "../dist/mcp.js";

test("ob_compare_tables reports MySQL column differences", async () => {
  const config = loadConfig({ OB_ALLOWED_SCHEMAS: "biz_test" });
  const server = createObMcpServer(runtime(config, mysqlPool()));

  const result = await server.executeToolHandler(server._registeredTools.ob_compare_tables, {
    leftSchema: "biz_test",
    leftTable: "orders",
    rightSchema: "biz_test",
    rightTable: "orders_archive"
  }, {});
  const diff = JSON.parse(result.content[0].text);

  assert.equal(diff.left.table, "orders");
  assert(diff.columns.leftOnly.some((column) => column.name === "status"));
  assert(diff.columns.rightOnly.some((column) => column.name === "state"));
  assert(diff.columns.changed.some((column) => column.column === "total_amount"));
});

test("ob_compare_tables reports Oracle column differences", async () => {
  const config = loadConfig({
    OB_COMPATIBILITY: "oracle",
    OB_ALLOWED_SCHEMAS: "APP"
  });
  const server = createObMcpServer(runtime(config, oraclePool()));

  const result = await server.executeToolHandler(server._registeredTools.ob_compare_tables, {
    leftSchema: "APP",
    leftTable: "ORDERS",
    rightSchema: "APP",
    rightTable: "ORDERS_ARCHIVE"
  }, {});
  const diff = JSON.parse(result.content[0].text);

  assert.equal(diff.mode, "oracle");
  assert(diff.columns.leftOnly.some((column) => column.name === "STATUS"));
  assert(diff.columns.rightOnly.some((column) => column.name === "STATE"));
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
      const table = String(sql).includes("information_schema.columns")
        ? values[0]
        : values[1] ?? (String(sql).includes("orders_archive") ? "orders_archive" : "orders");
      if (/SHOW CREATE TABLE/i.test(sql)) {
        return [[{ "Create Table": `CREATE TABLE ${table} (...)` }], []];
      }
      if (/FROM information_schema\.statistics/i.test(sql)) {
        return [[{ table_schema: "biz_test", table_name: table, index_name: "PRIMARY", non_unique: 0, seq_in_index: 1, column_name: "id" }], []];
      }
      if (/FROM information_schema\.table_constraints/i.test(sql)) {
        return [[{ table_schema: "biz_test", table_name: table, constraint_name: "PRIMARY", constraint_type: "PRIMARY KEY", column_name: "id", ordinal_position: 1 }], []];
      }
      if (/FROM information_schema\.partitions/i.test(sql)) {
        return [[], []];
      }
      if (/FROM information_schema\.columns/i.test(sql)) {
        return [mysqlColumns(String(table)), []];
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    }
  };
}

function mysqlColumns(table) {
  const common = [
    { table_schema: "biz_test", table_name: table, column_name: "id", column_type: "bigint", data_type: "bigint", is_nullable: "NO", ordinal_position: 1 },
    { table_schema: "biz_test", table_name: table, column_name: "total_amount", column_type: table === "orders" ? "decimal(10,2)" : "decimal(12,2)", data_type: "decimal", is_nullable: "YES", ordinal_position: 3 }
  ];
  return table === "orders"
    ? [...common, { table_schema: "biz_test", table_name: table, column_name: "status", column_type: "varchar(32)", data_type: "varchar", is_nullable: "YES", ordinal_position: 2 }]
    : [...common, { table_schema: "biz_test", table_name: table, column_name: "state", column_type: "varchar(32)", data_type: "varchar", is_nullable: "YES", ordinal_position: 2 }];
}

function oraclePool() {
  return {
    async query({ sql, values = [] }) {
      if (/USER AS schema_name FROM DUAL/i.test(sql)) {
        return [[{ SCHEMA_NAME: "APP" }], []];
      }
      const table = String(values[1] ?? "ORDERS");
      if (/FROM user_indexes i/i.test(sql)) {
        return [[{ OWNER: "APP", TABLE_NAME: table, INDEX_NAME: `PK_${table}`, UNIQUENESS: "UNIQUE", COLUMN_NAME: "ID", COLUMN_POSITION: 1 }], []];
      }
      if (/FROM user_constraints c/i.test(sql)) {
        return [[{ OWNER: "APP", TABLE_NAME: table, CONSTRAINT_NAME: `PK_${table}`, CONSTRAINT_TYPE: "P", COLUMN_NAME: "ID", POSITION: 1 }], []];
      }
      if (/FROM user_tab_partitions/i.test(sql)) {
        return [[], []];
      }
      if (/FROM user_tab_columns c/i.test(sql)) {
        return [oracleColumns(table), []];
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    }
  };
}

function oracleColumns(table) {
  const common = [
    { OWNER: "APP", TABLE_NAME: table, COLUMN_NAME: "ID", DATA_TYPE: "NUMBER", DATA_PRECISION: 20, NULLABLE: "N", COLUMN_ID: 1 }
  ];
  return table === "ORDERS"
    ? [...common, { OWNER: "APP", TABLE_NAME: table, COLUMN_NAME: "STATUS", DATA_TYPE: "VARCHAR2", DATA_LENGTH: 32, NULLABLE: "Y", COLUMN_ID: 2 }]
    : [...common, { OWNER: "APP", TABLE_NAME: table, COLUMN_NAME: "STATE", DATA_TYPE: "VARCHAR2", DATA_LENGTH: 32, NULLABLE: "Y", COLUMN_ID: 2 }];
}
