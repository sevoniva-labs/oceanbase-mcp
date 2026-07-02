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

function runtime(config, pool) {
  return {
    defaultProfile: "default",
    configs: { default: config },
    pools: { default: pool },
    queryLimiters: { default: { active: 0, limit: 5 } }
  };
}
