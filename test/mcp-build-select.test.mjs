import assert from "node:assert/strict";
import test from "node:test";

import { loadConfig } from "../dist/config.js";
import { createObMcpServer } from "../dist/mcp.js";

test("ob_build_select builds parameterized MySQL SELECT with filters and pagination", async () => {
  const config = loadConfig({
    OB_ALLOWED_SCHEMAS: "biz_test",
    OB_MAX_ROWS: "20"
  });
  const server = createObMcpServer(runtime(config, mysqlPool()));

  const result = await server.executeToolHandler(server._registeredTools.ob_build_select, {
    schema: "biz_test",
    table: "orders",
    columns: ["id", "status", "created_at"],
    filters: [
      { column: "status", operator: "eq", value: "paid" },
      { column: "id", operator: "in", value: [1, 2] },
      { column: "created_at", operator: "between", value: ["2026-01-01", "2026-02-01"] }
    ],
    orderBy: [{ column: "id", direction: "desc" }],
    pageSize: 10,
    page: 2
  }, {});
  const built = JSON.parse(result.content[0].text);

  assert.equal(built.executed, false);
  assert.equal(
    built.sql,
    "SELECT `id`, `status`, `created_at` FROM `biz_test`.`orders` WHERE `status` = ? AND `id` IN (?, ?) AND `created_at` BETWEEN ? AND ? ORDER BY `id` DESC LIMIT ? OFFSET ?"
  );
  assert.deepEqual(built.params, ["paid", 1, 2, "2026-01-01", "2026-02-01", 10, 10]);
  assert.equal(built.policy.allowed, true);
  assert.equal(built.pagination.page, 2);
  assert.equal(built.pagination.pageSize, 10);
});

test("ob_build_select builds Oracle SELECT with capped pagination", async () => {
  const config = loadConfig({
    OB_COMPATIBILITY: "oracle",
    OB_ALLOWED_SCHEMAS: "APP",
    OB_MAX_ROWS: "5"
  });
  const server = createObMcpServer(runtime(config, oraclePool()));

  const result = await server.executeToolHandler(server._registeredTools.ob_build_select, {
    schema: "APP",
    table: "orders",
    columns: ["id", "status"],
    filters: [{ column: "status", operator: "is_not_null" }],
    orderBy: [{ column: "created_at", direction: "desc", nulls: "last" }],
    pageSize: 50,
    page: 1
  }, {});
  const built = JSON.parse(result.content[0].text);

  assert.equal(built.mode, "oracle");
  assert.equal(
    built.sql,
    'SELECT "ID", "STATUS" FROM "APP"."ORDERS" WHERE "STATUS" IS NOT NULL ORDER BY "CREATED_AT" DESC NULLS LAST OFFSET ? ROWS FETCH NEXT ? ROWS ONLY'
  );
  assert.deepEqual(built.params, [0, 5]);
  assert.equal(built.pagination.pageSize, 5);
  assert.equal(built.policy.allowed, true);
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
      if (/FROM information_schema\.columns/i.test(sql)) {
        return [mysqlColumns(String(values[1]), String(values[0])), []];
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    }
  };
}

function mysqlColumns(schema, table) {
  return [
    mysqlColumn(schema, table, "id", "bigint", "NO", 1),
    mysqlColumn(schema, table, "status", "varchar(32)", "YES", 2),
    mysqlColumn(schema, table, "created_at", "datetime", "YES", 3)
  ];
}

function mysqlColumn(schema, table, name, type, nullable, position) {
  return {
    table_schema: schema,
    table_name: table,
    column_name: name,
    column_type: type,
    data_type: type.split("(")[0],
    is_nullable: nullable,
    ordinal_position: position
  };
}

function oraclePool() {
  return {
    async query({ sql, values = [] }) {
      if (/USER AS schema_name FROM DUAL/i.test(sql)) {
        return [[{ SCHEMA_NAME: "CURRENT_USER" }], []];
      }
      if (/FROM all_tab_columns c/i.test(sql)) {
        return [oracleColumns(String(values[1]), String(values[0])), []];
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    }
  };
}

function oracleColumns(owner, table) {
  return [
    oracleColumn(owner, table, "ID", "NUMBER", "N", 1),
    oracleColumn(owner, table, "STATUS", "VARCHAR2", "Y", 2),
    oracleColumn(owner, table, "CREATED_AT", "DATE", "Y", 3)
  ];
}

function oracleColumn(owner, table, name, type, nullable, position) {
  return {
    OWNER: owner,
    TABLE_NAME: table,
    COLUMN_NAME: name,
    DATA_TYPE: type,
    DATA_LENGTH: type === "VARCHAR2" ? 32 : undefined,
    NULLABLE: nullable,
    COLUMN_ID: position
  };
}
