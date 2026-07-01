import assert from "node:assert/strict";
import test from "node:test";

import { loadConfig } from "../dist/config.js";
import { createObMcpServer } from "../dist/mcp.js";

test("ob_find_unknown_columns_in_sql suggests visible MySQL column candidates", async () => {
  const config = loadConfig({
    OB_ALLOWED_SCHEMAS: "biz_test",
    OB_ENFORCE_READ_ONLY_TX: "false"
  });
  const server = createObMcpServer(runtime(config, mysqlPool()));

  const result = await server.executeToolHandler(server._registeredTools.ob_find_unknown_columns_in_sql, {
    schema: "biz_test",
    sql: "SELECT o.id, o.statuz FROM biz_test.orders o WHERE o.created_at >= ? LIMIT 10"
  }, {});
  const output = JSON.parse(result.content[0].text);

  assert.equal(output.executed, false);
  assert.equal(output.unknownColumnCount, 1);
  assert.equal(output.unknownTableCount, 0);
  assert.equal(output.columnIssues[0].column, "statuz");
  assert(output.columnIssues[0].candidates.some((candidate) =>
    candidate.column === "status" &&
    candidate.score > 0.5 &&
    candidate.evidence.length > 0
  ));
});

test("ob_find_unknown_columns_in_sql suggests visible Oracle table candidates", async () => {
  const config = loadConfig({
    OB_COMPATIBILITY: "oracle",
    OB_ALLOWED_SCHEMAS: "APP",
    OB_ENFORCE_READ_ONLY_TX: "false"
  });
  const server = createObMcpServer(runtime(config, oraclePool()));

  const result = await server.executeToolHandler(server._registeredTools.ob_find_unknown_columns_in_sql, {
    schema: "APP",
    sql: "SELECT o.ID FROM APP.ORDERZ o FETCH FIRST 5 ROWS ONLY"
  }, {});
  const output = JSON.parse(result.content[0].text);

  assert.equal(output.executed, false);
  assert.equal(output.unknownTableCount, 1);
  assert.equal(output.tableIssues[0].table, "ORDERZ");
  assert(output.tableIssues[0].candidates.some((candidate) =>
    candidate.table === "ORDERS" &&
    candidate.score > 0.5
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
    async query({ sql }) {
      if (/FROM information_schema\.columns/i.test(sql)) {
        return [[
          mysqlColumn("biz_test", "orders", "id", "bigint", "NO", 1),
          mysqlColumn("biz_test", "orders", "status", "varchar(32)", "YES", 2),
          mysqlColumn("biz_test", "orders", "created_at", "datetime", "YES", 3)
        ], []];
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    }
  };
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
        const table = String(values[0]);
        return [table === "ORDERZ" ? [] : [oracleColumn("APP", table, "ID", "NUMBER", "N", 1)], []];
      }
      if (/FROM all_tables/i.test(sql)) {
        return [[
          { OWNER: "APP", TABLE_NAME: "ORDERS", TABLESPACE_NAME: "DATA", NUM_ROWS: 12 },
          { OWNER: "APP", TABLE_NAME: "ORDER_ITEMS", TABLESPACE_NAME: "DATA", NUM_ROWS: 30 }
        ], []];
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    }
  };
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
