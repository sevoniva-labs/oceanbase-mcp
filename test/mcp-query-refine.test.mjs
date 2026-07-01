import assert from "node:assert/strict";
import test from "node:test";

import { loadConfig } from "../dist/config.js";
import { createObMcpServer } from "../dist/mcp.js";

test("ob_query_refine builds a refined MySQL SELECT without executing it", async () => {
  const config = loadConfig({
    OB_ALLOWED_SCHEMAS: "biz_test",
    OB_ENFORCE_READ_ONLY_TX: "false",
    OB_MAX_ROWS: "20"
  });
  const server = createObMcpServer(runtime(config, mysqlPool()));
  const startResult = await server.executeToolHandler(server._registeredTools.ob_start_query_session, {
    schema: "biz_test",
    table: "orders",
    columns: ["id"],
    sql: "SELECT id FROM biz_test.orders"
  }, {});
  const session = JSON.parse(startResult.content[0].text);

  const result = await server.executeToolHandler(server._registeredTools.ob_query_refine, {
    sessionId: session.sessionId,
    addColumns: ["status"],
    filters: [{ column: "status", operator: "eq", value: "PAID" }],
    orderBy: [{ column: "created_at", direction: "desc" }],
    page: 2,
    pageSize: 5
  }, {});
  const refined = JSON.parse(result.content[0].text);

  assert.equal(refined.executed, false);
  assert.equal(refined.sessionUpdated, false);
  assert.equal(
    refined.sql,
    "SELECT `id`, `status` FROM `biz_test`.`orders` WHERE `status` = ? ORDER BY `created_at` DESC LIMIT ? OFFSET ?"
  );
  assert.deepEqual(refined.params, ["PAID", 5, 5]);
  assert.equal(refined.preview.policy.allowed, true);
  assert(refined.changes.some((change) => /Added 1 structured filter/.test(change)));
});

test("ob_query_refine updates Oracle session when requested", async () => {
  const config = loadConfig({
    OB_COMPATIBILITY: "oracle",
    OB_ALLOWED_SCHEMAS: "APP",
    OB_ENFORCE_READ_ONLY_TX: "false",
    OB_MAX_ROWS: "20"
  });
  const server = createObMcpServer(runtime(config, oraclePool()));
  const startResult = await server.executeToolHandler(server._registeredTools.ob_start_query_session, {
    schema: "APP",
    table: "ORDERS",
    columns: ["ID"],
    sql: "SELECT ID FROM APP.ORDERS"
  }, {});
  const session = JSON.parse(startResult.content[0].text);

  const result = await server.executeToolHandler(server._registeredTools.ob_query_refine, {
    sessionId: session.sessionId,
    addColumns: ["STATUS"],
    filters: [{ column: "STATUS", operator: "eq", value: "PAID" }],
    orderBy: [{ column: "ID", direction: "asc" }],
    pageSize: 10,
    updateSession: true
  }, {});
  const refined = JSON.parse(result.content[0].text);

  assert.equal(refined.mode, "oracle");
  assert.equal(refined.sessionUpdated, true);
  assert.equal(
    refined.sql,
    'SELECT "ID", "STATUS" FROM "APP"."ORDERS" WHERE "STATUS" = ? ORDER BY "ID" ASC OFFSET ? ROWS FETCH NEXT ? ROWS ONLY'
  );
  assert.deepEqual(refined.params, ["PAID", 0, 10]);
  assert.deepEqual(refined.session.columns, ["ID", "STATUS"]);
  assert.equal(refined.session.paramCount, 3);
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
        return [oracleColumns(String(values[2]), String(values[0])), []];
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    }
  };
}

function oracleColumns(owner, table) {
  return [
    oracleColumn(owner, table, "ID", "NUMBER", "N", 1),
    oracleColumn(owner, table, "STATUS", "VARCHAR2", "Y", 2)
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
