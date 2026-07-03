import assert from "node:assert/strict";
import test from "node:test";

import { loadConfig } from "../dist/config.js";
import { createObMcpServer } from "../dist/mcp.js";
import { metadataCacheKeyMatches, refreshMetadataCache } from "../dist/mcp/metadata-cache.js";

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

test("ob_refresh_metadata_cache clears scoped metadata entries", async () => {
  const config = loadConfig({
    OB_ALLOWED_SCHEMAS: "biz_test",
    OB_METADATA_CACHE_TTL_MS: "60000"
  });
  const calls = { tables: 0, columns: 0, constraints: 0 };
  const server = createObMcpServer(runtime(config, mysqlPool(calls)));

  await server.executeToolHandler(server._registeredTools.ob_generate_schema_doc, {
    schema: "biz_test",
    format: "json",
    includeRelationships: false,
    maxTables: 1
  }, {});
  const refreshed = JSON.parse((await server.executeToolHandler(server._registeredTools.ob_refresh_metadata_cache, {
    schema: "biz_test"
  }, {})).content[0].text);
  await server.executeToolHandler(server._registeredTools.ob_generate_schema_doc, {
    schema: "biz_test",
    format: "json",
    includeRelationships: false,
    maxTables: 1
  }, {});

  assert.equal(refreshed.executed, false);
  assert.equal(refreshed.scope.schema, "biz_test");
  assert(refreshed.removedEntries >= 3);
  assert.equal(calls.tables, 2);
  assert.equal(calls.columns, 2);
  assert.equal(calls.constraints, 2);
});

test("ob_get_cache_status returns counters without cached content", async () => {
  const config = loadConfig({
    OB_ALLOWED_SCHEMAS: "biz_test",
    OB_METADATA_CACHE_TTL_MS: "60000"
  });
  const server = createObMcpServer(runtime(config, mysqlPool({ tables: 0, columns: 0, constraints: 0 })));

  await server.executeToolHandler(server._registeredTools.ob_generate_schema_doc, {
    schema: "biz_test",
    format: "json",
    includeRelationships: false,
    maxTables: 1
  }, {});
  const status = JSON.parse((await server.executeToolHandler(server._registeredTools.ob_get_cache_status, {}, {})).content[0].text);

  assert.equal(status.executed, false);
  assert.equal(status.enabled, true);
  assert(status.entries >= 3);
  assert(status.namespaces.some((item) => item.namespace === "schema_map_tables"));
  assert(!JSON.stringify(status.namespaces).includes("orders"));
});

test("metadata cache refresh matches Oracle scoped entries case-insensitively", () => {
  const config = loadConfig({
    OB_COMPATIBILITY: "oracle",
    OB_ALLOWED_SCHEMAS: "APP",
    OB_METADATA_CACHE_TTL_MS: "60000"
  });
  const cacheKey = JSON.stringify(["describe_table", "oracle", "APP", "ORDERS"]);
  const selected = {
    profile: "default",
    config,
    metadataCache: {
      entries: new Map([
        [cacheKey, { value: [], createdAt: Date.now(), expiresAt: Date.now() + 60_000 }]
      ]),
      hits: 1,
      misses: 2,
      evictions: 0
    }
  };

  assert.equal(metadataCacheKeyMatches("oracle", cacheKey, "app", "orders"), true);
  const refreshed = refreshMetadataCache(selected, "app", "orders");

  assert.equal(refreshed.mode, "oracle");
  assert.equal(refreshed.removedEntries, 1);
  assert.equal(refreshed.afterEntries, 0);
  assert.equal(refreshed.stats.hits, 1);
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
