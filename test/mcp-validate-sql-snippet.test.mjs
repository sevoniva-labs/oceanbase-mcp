import assert from "node:assert/strict";
import test from "node:test";

import { loadConfig } from "../dist/config.js";
import { createObMcpServer } from "../dist/mcp.js";

test("ob_validate_sql_snippet checks MySQL visible columns without executing target SQL", async () => {
  const config = loadConfig({
    OB_ALLOWED_SCHEMAS: "biz_test",
    OB_ENFORCE_READ_ONLY_TX: "false"
  });
  const pool = mysqlPool();
  const server = createObMcpServer(runtime(config, pool));

  const result = await server.executeToolHandler(server._registeredTools.ob_validate_sql_snippet, {
    schema: "biz_test",
    sql: "SELECT o.id, o.missing_col FROM biz_test.orders o WHERE o.status = ? ORDER BY o.id LIMIT 10",
    params: ["paid"]
  }, {});
  const output = JSON.parse(result.content[0].text);

  assert.equal(output.allowed, false);
  assert.equal(output.executed, false);
  assert.equal(output.explainRun, false);
  assert.equal(pool.targetSqlExecuted, false);
  assert(output.findings.some((finding) => finding.rule === "metadata_unknown_column"));
  assert(output.metadata.tables.some((table) =>
    table.schema === "biz_test" &&
    table.table === "orders" &&
    table.unknownColumns.includes("missing_col")
  ));
  assert(output.metadata.qualifiedColumnRefs.some((ref) =>
    ref.qualifier === "o" &&
    ref.column === "id" &&
    ref.ok === true
  ));
});

test("ob_validate_sql_snippet validates Oracle metadata with dialect pagination", async () => {
  const config = loadConfig({
    OB_COMPATIBILITY: "oracle",
    OB_ALLOWED_SCHEMAS: "APP",
    OB_ENFORCE_READ_ONLY_TX: "false"
  });
  const pool = oraclePool();
  const server = createObMcpServer(runtime(config, pool));

  const result = await server.executeToolHandler(server._registeredTools.ob_validate_sql_snippet, {
    schema: "APP",
    sql: "SELECT o.ID, o.STATUS FROM APP.ORDERS o WHERE o.STATUS = ? ORDER BY o.ID FETCH FIRST 10 ROWS ONLY",
    params: ["PAID"]
  }, {});
  const output = JSON.parse(result.content[0].text);

  assert.equal(output.allowed, true);
  assert.equal(output.executed, false);
  assert.equal(output.explainRun, false);
  assert.equal(pool.targetSqlExecuted, false);
  assert(output.metadata.tables.some((table) =>
    table.schema === "APP" &&
    table.table === "ORDERS" &&
    table.checkedColumns.includes("ID") &&
    table.checkedColumns.includes("STATUS")
  ));
});

test("ob_validate_sql_snippet blocks write SQL before metadata lookup", async () => {
  const config = loadConfig({
    OB_ALLOWED_SCHEMAS: "biz_test"
  });
  const pool = failPool();
  const server = createObMcpServer(runtime(config, pool));

  const result = await server.executeToolHandler(server._registeredTools.ob_validate_sql_snippet, {
    sql: "UPDATE biz_test.orders SET status = 'paid'"
  }, {});
  const output = JSON.parse(result.content[0].text);

  assert.equal(output.allowed, false);
  assert.equal(output.executed, false);
  assert(output.findings.some((finding) => finding.rule === "read_only_sql"));
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
      if (/SELECT o\.id, o\.missing_col/i.test(sql)) {
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
    targetSqlExecuted: false,
    async query({ sql, values = [] }) {
      if (/SELECT o\.ID, o\.STATUS/i.test(sql)) {
        this.targetSqlExecuted = true;
        throw new Error("Target SQL should not be executed");
      }
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

function failPool() {
  return {
    async query() {
      throw new Error("Database should not be queried");
    }
  };
}
