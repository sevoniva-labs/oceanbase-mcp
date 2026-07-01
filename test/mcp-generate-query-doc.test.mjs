import assert from "node:assert/strict";
import test from "node:test";

import { loadConfig } from "../dist/config.js";
import { createObMcpServer } from "../dist/mcp.js";

test("ob_generate_query_doc renders MySQL markdown without executing target SQL", async () => {
  const config = loadConfig({
    OB_ALLOWED_SCHEMAS: "biz_test",
    OB_ENFORCE_READ_ONLY_TX: "false"
  });
  const pool = mysqlPool();
  const server = createObMcpServer(runtime(config, pool));

  const result = await server.executeToolHandler(server._registeredTools.ob_generate_query_doc, {
    schema: "biz_test",
    sql: "SELECT o.id, o.status FROM biz_test.orders o WHERE o.status = ? ORDER BY o.id LIMIT 5",
    params: ["paid"],
    format: "markdown"
  }, {});
  const output = JSON.parse(result.content[0].text);

  assert.equal(output.executed, false);
  assert.equal(pool.targetSqlExecuted, false);
  assert.equal(output.document.allowed, true);
  assert.match(output.markdown, /# Query Documentation/);
  assert.match(output.markdown, /Filter preview/);
  assert(output.document.metadata.tables.some((table) => table.checkedColumns.includes("status")));
});

test("ob_generate_query_doc returns Oracle JSON documentation", async () => {
  const config = loadConfig({
    OB_COMPATIBILITY: "oracle",
    OB_ALLOWED_SCHEMAS: "APP",
    OB_ENFORCE_READ_ONLY_TX: "false"
  });
  const server = createObMcpServer(runtime(config, oraclePool()));

  const result = await server.executeToolHandler(server._registeredTools.ob_generate_query_doc, {
    schema: "APP",
    sql: "SELECT o.ID, o.STATUS FROM APP.ORDERS o ORDER BY o.ID FETCH FIRST 5 ROWS ONLY",
    format: "json"
  }, {});
  const output = JSON.parse(result.content[0].text);

  assert.equal(output.mode, "oracle");
  assert.equal(output.markdown, undefined);
  assert.equal(output.document.executed, false);
  assert.equal(output.document.structure.statementType, "select");
  assert(output.document.metadata.tables.some((table) => table.schema === "APP" && table.table === "ORDERS"));
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
    targetSqlExecuted: false,
    async query({ sql, values = [] }) {
      if (/SELECT o\.id/i.test(sql)) {
        this.targetSqlExecuted = true;
        throw new Error("Target SQL should not be executed");
      }
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
    mysqlColumn(schema, table, "status", "varchar(32)", "YES", 2)
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
