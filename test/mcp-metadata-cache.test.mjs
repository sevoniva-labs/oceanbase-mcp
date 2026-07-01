import assert from "node:assert/strict";
import test from "node:test";

import { loadConfig } from "../dist/config.js";
import { createObMcpServer } from "../dist/mcp.js";

test("metadata cache reuses schema documentation metadata within TTL", async () => {
  const config = loadConfig({
    OB_ALLOWED_SCHEMAS: "biz_test",
    OB_METADATA_CACHE_TTL_MS: "60000",
    OB_METADATA_CACHE_MAX_ENTRIES: "20"
  });
  const calls = { tables: 0, columns: 0, constraints: 0 };
  const server = createObMcpServer(runtime(config, mysqlPool(calls)));

  await server.executeToolHandler(server._registeredTools.ob_generate_schema_doc, {
    schema: "biz_test",
    format: "json",
    includeRelationships: false,
    maxTables: 1
  }, {});
  await server.executeToolHandler(server._registeredTools.ob_generate_schema_doc, {
    schema: "biz_test",
    format: "json",
    includeRelationships: false,
    maxTables: 1
  }, {});

  assert.equal(calls.tables, 1);
  assert.equal(calls.columns, 1);
  assert.equal(calls.constraints, 1);
});

test("metadata cache can be disabled", async () => {
  const config = loadConfig({
    OB_ALLOWED_SCHEMAS: "biz_test",
    OB_METADATA_CACHE_ENABLED: "false"
  });
  const calls = { tables: 0, columns: 0, constraints: 0 };
  const server = createObMcpServer(runtime(config, mysqlPool(calls)));

  await server.executeToolHandler(server._registeredTools.ob_generate_schema_doc, {
    schema: "biz_test",
    format: "json",
    includeRelationships: false,
    maxTables: 1
  }, {});
  await server.executeToolHandler(server._registeredTools.ob_generate_schema_doc, {
    schema: "biz_test",
    format: "json",
    includeRelationships: false,
    maxTables: 1
  }, {});

  assert.equal(calls.tables, 2);
  assert.equal(calls.columns, 2);
  assert.equal(calls.constraints, 2);
});

function runtime(config, pool) {
  return {
    defaultProfile: "default",
    configs: { default: config },
    pools: { default: pool },
    queryLimiters: { default: { active: 0, limit: 5 } }
  };
}

function mysqlPool(calls) {
  return {
    async query({ sql, values = [] }) {
      if (/FROM information_schema\.table_constraints tc/i.test(sql)) {
        calls.constraints += 1;
        const table = String(values[1]);
        return [[{ table_schema: "biz_test", table_name: table, constraint_name: `PK_${table}`, constraint_type: "PRIMARY KEY", column_name: "id", ordinal_position: 1 }], []];
      }
      if (/FROM information_schema\.tables/i.test(sql)) {
        calls.tables += 1;
        return [[{ table_schema: "biz_test", table_name: "orders", table_type: "BASE TABLE", engine: "OceanBase", table_comment: "orders table", table_rows: 42 }], []];
      }
      if (/FROM information_schema\.columns/i.test(sql)) {
        calls.columns += 1;
        const table = String(values[0]);
        return [[
          { table_schema: "biz_test", table_name: table, column_name: "id", column_type: "bigint", data_type: "bigint", is_nullable: "NO", ordinal_position: 1 },
          { table_schema: "biz_test", table_name: table, column_name: "created_at", column_type: "datetime", data_type: "datetime", is_nullable: "YES", ordinal_position: 2 }
        ], []];
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    }
  };
}
