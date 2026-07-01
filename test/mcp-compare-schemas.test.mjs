import assert from "node:assert/strict";
import test from "node:test";

import { loadConfig } from "../dist/config.js";
import { createObMcpServer } from "../dist/mcp.js";

test("ob_compare_schemas reports MySQL table and column differences", async () => {
  const config = loadConfig({
    OB_ALLOWED_SCHEMAS: "biz_a,biz_b"
  });
  const server = createObMcpServer(runtime(config, mysqlPool()));

  const result = await server.executeToolHandler(server._registeredTools.ob_compare_schemas, {
    leftSchema: "biz_a",
    rightSchema: "biz_b",
    maxTables: 10,
    compareCommonTables: 5
  }, {});
  const diff = JSON.parse(result.content[0].text);

  assert.equal(diff.mode, "mysql");
  assert.equal(diff.commonTableCount, 1);
  assert.equal(diff.leftTableListTruncated, false);
  assert.equal(diff.rightTableListTruncated, false);
  assert(diff.leftOnlyTables.some((table) => table.table === "legacy_orders"));
  assert(diff.rightOnlyTables.some((table) => table.table === "new_orders"));
  assert.equal(diff.changedTables.length, 1);
  assert.equal(diff.changedTables[0].left.table, "orders");
  assert(diff.changedTables[0].columns.leftOnly.some((column) => column.name === "status"));
  assert(diff.changedTables[0].columns.rightOnly.some((column) => column.name === "state"));
  assert(diff.changedTables[0].columns.changed.some((column) => column.column === "total_amount"));
});

test("ob_compare_schemas reports Oracle cross-schema table and column differences", async () => {
  const config = loadConfig({
    OB_COMPATIBILITY: "oracle",
    OB_ALLOWED_SCHEMAS: "APP_A,APP_B"
  });
  const server = createObMcpServer(runtime(config, oraclePool()));

  const result = await server.executeToolHandler(server._registeredTools.ob_compare_schemas, {
    leftSchema: "APP_A",
    rightSchema: "APP_B",
    maxTables: 10,
    compareCommonTables: 5
  }, {});
  const diff = JSON.parse(result.content[0].text);

  assert.equal(diff.mode, "oracle");
  assert.equal(diff.commonTableCount, 1);
  assert(diff.leftOnlyTables.some((table) => table.table === "LEGACY_ORDERS"));
  assert(diff.rightOnlyTables.some((table) => table.table === "NEW_ORDERS"));
  assert.equal(diff.changedTables.length, 1);
  assert.equal(diff.changedTables[0].left.schema, "APP_A");
  assert.equal(diff.changedTables[0].right.schema, "APP_B");
  assert(diff.changedTables[0].columns.leftOnly.some((column) => column.name === "STATUS"));
  assert(diff.changedTables[0].columns.rightOnly.some((column) => column.name === "STATE"));
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
      if (/SHOW CREATE TABLE/i.test(sql)) {
        const schema = String(sql).includes("`biz_b`") ? "biz_b" : "biz_a";
        return [[{ "Create Table": `CREATE TABLE ${schema}.orders (...)` }], []];
      }
      if (/SELECT table_schema, table_name, table_type, engine, table_comment, table_rows\s+FROM information_schema\.tables/i.test(sql)) {
        return [mysqlTables(String(values[1])), []];
      }
      if (/FROM information_schema\.statistics/i.test(sql)) {
        return [mysqlIndexes(String(values[0]), String(values[1])), []];
      }
      if (/FROM information_schema\.table_constraints/i.test(sql)) {
        return [mysqlConstraints(String(values[0]), String(values[1])), []];
      }
      if (/FROM information_schema\.partitions/i.test(sql)) {
        return [[], []];
      }
      if (/FROM information_schema\.columns/i.test(sql)) {
        return [mysqlColumns(String(values[1]), String(values[0])), []];
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    }
  };
}

function mysqlTables(schema) {
  const common = {
    table_schema: schema,
    table_type: "BASE TABLE",
    engine: "OceanBase",
    table_comment: "orders",
    table_rows: 100
  };
  return schema === "biz_a"
    ? [
        { ...common, table_name: "legacy_orders" },
        { ...common, table_name: "orders" }
      ]
    : [
        { ...common, table_name: "new_orders" },
        { ...common, table_name: "orders" }
      ];
}

function mysqlColumns(schema, table) {
  const common = [
    column(schema, table, "id", "bigint", "NO", 1),
    column(schema, table, "total_amount", schema === "biz_a" ? "decimal(10,2)" : "decimal(12,2)", "YES", 3)
  ];
  return schema === "biz_a"
    ? [...common, column(schema, table, "status", "varchar(32)", "YES", 2)]
    : [...common, column(schema, table, "state", "varchar(32)", "YES", 2)];
}

function column(schema, table, name, type, nullable, position) {
  return {
    table_schema: schema,
    table_name: table,
    column_name: name,
    column_type: type,
    data_type: type.split("(")[0],
    is_nullable: nullable,
    column_key: name === "id" ? "PRI" : "",
    ordinal_position: position
  };
}

function mysqlIndexes(schema, table) {
  return [{
    table_schema: schema,
    table_name: table,
    index_name: "PRIMARY",
    non_unique: 0,
    seq_in_index: 1,
    column_name: "id",
    index_type: "BTREE"
  }];
}

function mysqlConstraints(schema, table) {
  return [{
    table_schema: schema,
    table_name: table,
    constraint_name: "PRIMARY",
    constraint_type: "PRIMARY KEY",
    column_name: "id",
    ordinal_position: 1
  }];
}

function oraclePool() {
  return {
    async query({ sql, values = [] }) {
      if (/USER AS schema_name FROM DUAL/i.test(sql)) {
        return [[{ SCHEMA_NAME: "CURRENT_USER" }], []];
      }
      if (/FROM all_tables t/i.test(sql)) {
        return [oracleTables(String(values[1])), []];
      }
      if (/FROM all_indexes i/i.test(sql)) {
        return [oracleIndexes(String(values[1]), String(values[0])), []];
      }
      if (/FROM all_constraints c/i.test(sql)) {
        return [oracleConstraints(String(values[1]), String(values[0])), []];
      }
      if (/FROM all_tab_partitions/i.test(sql)) {
        return [[], []];
      }
      if (/FROM all_tab_columns c/i.test(sql)) {
        return [oracleColumns(String(values[1]), String(values[0])), []];
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    }
  };
}

function oracleTables(owner) {
  const common = {
    OWNER: owner,
    TABLE_COMMENT: "orders",
    NUM_ROWS: 100
  };
  return owner === "APP_A"
    ? [
        { ...common, TABLE_NAME: "LEGACY_ORDERS" },
        { ...common, TABLE_NAME: "ORDERS" }
      ]
    : [
        { ...common, TABLE_NAME: "NEW_ORDERS" },
        { ...common, TABLE_NAME: "ORDERS" }
      ];
}

function oracleColumns(owner, table) {
  const common = [
    oracleColumn(owner, table, "ID", "NUMBER", "N", 1),
    oracleColumn(owner, table, "TOTAL_AMOUNT", owner === "APP_A" ? "NUMBER(10,2)" : "NUMBER(12,2)", "Y", 3)
  ];
  return owner === "APP_A"
    ? [...common, oracleColumn(owner, table, "STATUS", "VARCHAR2", "Y", 2)]
    : [...common, oracleColumn(owner, table, "STATE", "VARCHAR2", "Y", 2)];
}

function oracleColumn(owner, table, name, type, nullable, position) {
  return {
    OWNER: owner,
    TABLE_NAME: table,
    COLUMN_NAME: name,
    DATA_TYPE: type,
    NULLABLE: nullable,
    COLUMN_ID: position
  };
}

function oracleIndexes(owner, table) {
  return [{
    OWNER: owner,
    TABLE_NAME: table,
    INDEX_NAME: `PK_${table}`,
    UNIQUENESS: "UNIQUE",
    COLUMN_NAME: "ID",
    COLUMN_POSITION: 1
  }];
}

function oracleConstraints(owner, table) {
  return [{
    OWNER: owner,
    TABLE_NAME: table,
    CONSTRAINT_NAME: `PK_${table}`,
    CONSTRAINT_TYPE: "P",
    COLUMN_NAME: "ID",
    POSITION: 1
  }];
}
