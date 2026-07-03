import assert from "node:assert/strict";
import test from "node:test";

import { loadConfig } from "../dist/config.js";
import { createObMcpServer } from "../dist/mcp.js";

test("ob_describe_table reads MySQL catalog metadata without scanning target data", async () => {
  const config = loadConfig({
    OB_ALLOWED_SCHEMAS: "biz_test",
    OB_MAX_ROWS: "100"
  });
  const table = "ob_mcp_million_describe";
  const queries = [];
  const pool = {
    async query({ sql, values }) {
      queries.push({ sql, values });
      assert.doesNotMatch(sql, new RegExp(`FROM\\\\s+.*${table}`, "i"));
      assert.match(sql, /FROM information_schema\.columns/i);
      assert.deepEqual(values, [table, "biz_test"]);
      return [[
        { table_schema: "biz_test", table_name: table, column_name: "id", column_type: "bigint", data_type: "bigint", is_nullable: "NO", column_key: "PRI", ordinal_position: 1 },
        { table_schema: "biz_test", table_name: table, column_name: "payload", column_type: "varchar(64)", data_type: "varchar", is_nullable: "YES", ordinal_position: 2 },
        { table_schema: "biz_test", table_name: table, column_name: "created_at", column_type: "datetime", data_type: "datetime", is_nullable: "YES", ordinal_position: 3 }
      ], []];
    }
  };
  const server = createObMcpServer(runtime(config, pool));
  const result = await server.executeToolHandler(server._registeredTools.ob_describe_table, {
    schema: "biz_test",
    table
  }, {});
  const rows = JSON.parse(result.content[0].text);

  assert.equal(rows.length, 3);
  assert.equal(queries.length, 1);
});

test("ob_describe_table reads Oracle catalog metadata without scanning target data", async () => {
  const config = loadConfig({
    OB_COMPATIBILITY: "oracle",
    OB_ALLOWED_SCHEMAS: "OB_USER",
    OB_MAX_ROWS: "100"
  });
  const table = "OB_MCP_MILLION_DESCRIBE";
  const queries = [];
  const pool = {
    async query({ sql, values }) {
      queries.push({ sql, values });
      assert.doesNotMatch(sql, new RegExp(`FROM\\\\s+.*${table}`, "i"));
      if (/USER AS schema_name FROM DUAL/i.test(sql)) {
        return [[{ SCHEMA_NAME: "OB_USER" }], []];
      }
      assert.match(sql, /FROM user_tab_columns c/i);
      assert.deepEqual(values, ["OB_USER", table]);
      return [[
        { owner: "OB_USER", table_name: table, column_name: "ID", data_type: "NUMBER", nullable: "N", column_id: 1 },
        { owner: "OB_USER", table_name: table, column_name: "PAYLOAD", data_type: "VARCHAR2", nullable: "Y", column_id: 2 },
        { owner: "OB_USER", table_name: table, column_name: "CREATED_AT", data_type: "DATE", nullable: "Y", column_id: 3 }
      ], []];
    }
  };
  const server = createObMcpServer(runtime(config, pool));
  const result = await server.executeToolHandler(server._registeredTools.ob_describe_table, {
    schema: "OB_USER",
    table
  }, {});
  const rows = JSON.parse(result.content[0].text);

  assert.equal(rows.length, 3);
  assert.equal(queries.length, 2);
});

test("ob_describe_table caps very wide MySQL metadata by output byte budget", async () => {
  const config = loadConfig({
    OB_ALLOWED_SCHEMAS: "biz_test",
    OB_MAX_RESULT_BYTES: "2600"
  });
  const table = "ob_mcp_wide_describe";
  const pool = {
    async query({ sql, values }) {
      assert.doesNotMatch(sql, new RegExp(`FROM\\\\s+.*${table}`, "i"));
      assert.match(sql, /FROM information_schema\.columns/i);
      assert.deepEqual(values, [table, "biz_test"]);
      return [wideMysqlColumns("biz_test", table, 120), []];
    }
  };
  const server = createObMcpServer(runtime(config, pool));
  const result = await server.executeToolHandler(server._registeredTools.ob_describe_table, {
    schema: "biz_test",
    table
  }, {});
  const payload = JSON.parse(result.content[0].text);

  assert.equal(payload.columnCount, 120);
  assert.equal(payload.truncated, true);
  assert(payload.returnedColumns < payload.columnCount);
  assert(payload.warnings.some((warning) => /OB_MAX_RESULT_BYTES/.test(warning)));
});

test("ob_describe_table caps Oracle metadata by maxColumns without scanning target data", async () => {
  const config = loadConfig({
    OB_COMPATIBILITY: "oracle",
    OB_ALLOWED_SCHEMAS: "OB_USER",
    OB_MAX_RESULT_BYTES: "20000"
  });
  const table = "OB_MCP_WIDE_DESCRIBE";
  const pool = {
    async query({ sql, values }) {
      assert.doesNotMatch(sql, new RegExp(`FROM\\\\s+.*${table}`, "i"));
      if (/USER AS schema_name FROM DUAL/i.test(sql)) {
        return [[{ SCHEMA_NAME: "OB_USER" }], []];
      }
      assert.match(sql, /FROM user_tab_columns c/i);
      assert.deepEqual(values, ["OB_USER", table]);
      return [wideOracleColumns("OB_USER", table, 25), []];
    }
  };
  const server = createObMcpServer(runtime(config, pool));
  const result = await server.executeToolHandler(server._registeredTools.ob_describe_table, {
    schema: "OB_USER",
    table,
    maxColumns: 5
  }, {});
  const payload = JSON.parse(result.content[0].text);

  assert.equal(payload.columnCount, 25);
  assert.equal(payload.returnedColumns, 5);
  assert.equal(payload.truncated, true);
  assert(payload.warnings.some((warning) => /Only 5 of 25/.test(warning)));
});

function runtime(config, pool) {
  return {
    defaultProfile: "default",
    configs: { default: config },
    pools: { default: pool },
    queryLimiters: { default: { active: 0, limit: 5 } }
  };
}

function wideMysqlColumns(schema, table, count) {
  return Array.from({ length: count }, (_, index) => ({
    table_schema: schema,
    table_name: table,
    column_name: `c_${String(index + 1).padStart(4, "0")}`,
    column_type: "varchar(256)",
    data_type: "varchar",
    is_nullable: "YES",
    column_key: index === 0 ? "PRI" : "",
    ordinal_position: index + 1,
    column_comment: `wide metadata column ${index + 1} ${"x".repeat(80)}`
  }));
}

function wideOracleColumns(owner, table, count) {
  return Array.from({ length: count }, (_, index) => ({
    owner,
    table_name: table,
    column_name: `C_${String(index + 1).padStart(4, "0")}`,
    data_type: "VARCHAR2",
    data_length: 256,
    nullable: "Y",
    column_id: index + 1,
    comments: `wide metadata column ${index + 1} ${"x".repeat(40)}`
  }));
}
