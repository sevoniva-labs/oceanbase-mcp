import assert from "node:assert/strict";
import test from "node:test";

import { loadConfig } from "../dist/config.js";
import { createObMcpServer } from "../dist/mcp.js";

test("ob_explain_error returns MySQL column candidates without executing SQL", async () => {
  const config = loadConfig({
    OB_ALLOWED_SCHEMAS: "biz_test"
  });
  const pool = mysqlPool();
  const server = createObMcpServer(runtime(config, pool));

  const result = await server.executeToolHandler(server._registeredTools.ob_explain_error, {
    schema: "biz_test",
    sql: "SELECT status FROM biz_test.orders",
    errorMessage: "Unknown column 'status' in 'field list'"
  }, {});
  const output = JSON.parse(result.content[0].text);

  assert.equal(output.errorClass, "unknown_column");
  assert.equal(output.extractedTerm, "status");
  assert.equal(output.executed, false);
  assert.equal(pool.targetSqlExecuted, false);
  assert(output.candidates.columns.some((column) =>
    column.schema === "biz_test" &&
    column.table === "orders" &&
    column.column === "status"
  ));
  assert(output.policy.checks.every((check) => typeof check.ok === "boolean"));
  assert(output.hints.length > 0);
});

test("ob_explain_error returns Oracle table candidates without executing SQL", async () => {
  const config = loadConfig({
    OB_COMPATIBILITY: "oracle",
    OB_ALLOWED_SCHEMAS: "APP"
  });
  const pool = oraclePool();
  const server = createObMcpServer(runtime(config, pool));

  const result = await server.executeToolHandler(server._registeredTools.ob_explain_error, {
    schema: "APP",
    sql: "SELECT ID FROM APP.ORDERS",
    errorMessage: 'ORA-00942: "ORDERS": table or view does not exist'
  }, {});
  const output = JSON.parse(result.content[0].text);

  assert.equal(output.errorClass, "unknown_table");
  assert.equal(output.extractedTerm, "ORDERS");
  assert.equal(output.executed, false);
  assert.equal(pool.targetSqlExecuted, false);
  assert(output.candidates.tables.some((table) =>
    table.schema === "APP" &&
    table.table === "ORDERS"
  ));
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
    async query({ sql }) {
      if (/SELECT status FROM biz_test\.orders/i.test(sql)) {
        this.targetSqlExecuted = true;
        throw new Error("Target SQL should not be executed");
      }
      if (/FROM information_schema\.columns/i.test(sql)) {
        return [[
          {
            table_schema: "biz_test",
            table_name: "orders",
            column_name: "status",
            column_type: "varchar(32)",
            data_type: "varchar",
            is_nullable: "YES",
            ordinal_position: 3,
            column_comment: "order status"
          }
        ], []];
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    }
  };
}

function oraclePool() {
  return {
    targetSqlExecuted: false,
    async query({ sql }) {
      if (/SELECT ID FROM APP\.ORDERS/i.test(sql)) {
        this.targetSqlExecuted = true;
        throw new Error("Target SQL should not be executed");
      }
      if (/USER AS schema_name FROM DUAL/i.test(sql)) {
        return [[{ SCHEMA_NAME: "APP" }], []];
      }
      if (/(FROM all_tables|FROM user_tables)/i.test(sql) && /UNION ALL/i.test(sql)) {
        return [[
          {
            MATCH_TYPE: "table",
            OWNER: "APP",
            TABLE_NAME: "ORDERS",
            COLUMN_NAME: null,
            COMMENT_TEXT: null
          }
        ], []];
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    }
  };
}
