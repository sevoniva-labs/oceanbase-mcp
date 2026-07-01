import assert from "node:assert/strict";
import test from "node:test";

import { loadConfig } from "../dist/config.js";
import { createObMcpServer } from "../dist/mcp.js";

test("ob_capture_metadata_snapshot captures bounded MySQL table metadata", async () => {
  const config = loadConfig({
    OB_ALLOWED_SCHEMAS: "biz_test",
    OB_MASKED_COLUMNS: "biz_test.orders.status"
  });
  const server = createObMcpServer(runtime(config, mysqlPool()));

  const result = await server.executeToolHandler(server._registeredTools.ob_capture_metadata_snapshot, {
    schema: "biz_test",
    includeRelationships: false,
    includeOracleObjects: false,
    maxTables: 5,
    maxColumnsPerTable: 5
  }, {});
  const snapshot = JSON.parse(result.content[0].text);

  assert.equal(snapshot.snapshotVersion, "1.1");
  assert.equal(snapshot.compatibility, "mysql");
  assert.equal(snapshot.executed, false);
  assert.equal(snapshot.tableCount, 1);
  assert.equal(snapshot.tables[0].table, "orders");
  assert.equal(snapshot.tables[0].columns.length, 2);
  assert.equal(snapshot.tables[0].columns.find((column) => column.name === "status").masked, true);
  assert.equal(snapshot.tables[0].indexes[0].name, "PRIMARY");
  assert.equal(snapshot.tables[0].constraints[0].name, "PRIMARY");
  assert.equal(snapshot.tables[0].stats.counts.columns, 2);
  assert.equal(typeof snapshot.tables[0].fingerprint, "string");
  assert.equal(typeof snapshot.fingerprint, "string");
  assert(snapshot.warnings.some((warning) => warning.includes("metadata only")));
});

test("ob_capture_metadata_snapshot captures Oracle table and object metadata without source text", async () => {
  const config = loadConfig({
    OB_COMPATIBILITY: "oracle",
    OB_ALLOWED_SCHEMAS: "APP"
  });
  const server = createObMcpServer(runtime(config, oraclePool()));

  const result = await server.executeToolHandler(server._registeredTools.ob_capture_metadata_snapshot, {
    schema: "APP",
    objectTypes: ["view"],
    includeRelationships: false,
    includeOracleObjects: true,
    maxTables: 5,
    maxObjects: 5
  }, {});
  const snapshot = JSON.parse(result.content[0].text);

  assert.equal(snapshot.compatibility, "oracle");
  assert.equal(snapshot.tableCount, 1);
  assert.equal(snapshot.objectCount, 1);
  assert.equal(snapshot.tables[0].table, "ORDERS");
  assert.equal(snapshot.oracleObjects[0].objectName, "ORDER_VIEW");
  assert.equal(snapshot.oracleObjects[0].objectType, "VIEW");
  assert.equal(typeof snapshot.oracleObjects[0].sourceFingerprint, "string");
  assert(!JSON.stringify(snapshot.oracleObjects[0]).includes("secret_token"));
});

function runtime(config, pool) {
  return {
    defaultProfile: "default",
    configs: { default: config },
    pools: { default: pool },
    queryLimiters: { default: { active: 0, limit: 5 } },
    metadataCaches: { default: { entries: new Map(), hits: 0, misses: 0, evictions: 0 } }
  };
}

function mysqlPool() {
  return {
    async query({ sql, values = [] }) {
      if (/SHOW CREATE TABLE/i.test(sql)) {
        return [[{ "Create Table": "CREATE TABLE `biz_test`.`orders` (`id` bigint primary key)" }], []];
      }
      if (/COUNT\(DISTINCT index_name\)/i.test(sql)) {
        return [[{ item_count: 1 }], []];
      }
      if (/COUNT\(DISTINCT constraint_name\)/i.test(sql)) {
        return [[{ item_count: 1 }], []];
      }
      if (/COUNT\(\*\) AS item_count\s+FROM information_schema\.columns/i.test(sql)) {
        return [[{ item_count: 2 }], []];
      }
      if (/COUNT\(\*\) AS item_count\s+FROM information_schema\.partitions/i.test(sql)) {
        return [[{ item_count: 0 }], []];
      }
      if (/SELECT table_schema, table_name, table_rows, data_length, index_length, update_time/i.test(sql)) {
        return [[{ table_schema: "biz_test", table_name: "orders", table_rows: 42, data_length: 1024, index_length: 256 }], []];
      }
      if (/SELECT table_schema, table_name, table_type, engine, table_comment, table_rows/i.test(sql)) {
        return [[{ table_schema: "biz_test", table_name: "orders", table_type: "BASE TABLE", engine: "OceanBase", table_comment: "orders table", table_rows: 42 }], []];
      }
      if (/FROM information_schema\.statistics/i.test(sql)) {
        return [[{ table_schema: "biz_test", table_name: "orders", index_name: "PRIMARY", non_unique: 0, seq_in_index: 1, column_name: "id", index_type: "BTREE" }], []];
      }
      if (/FROM information_schema\.table_constraints/i.test(sql)) {
        return [[{ table_schema: "biz_test", table_name: "orders", constraint_name: "PRIMARY", constraint_type: "PRIMARY KEY", column_name: "id", ordinal_position: 1 }], []];
      }
      if (/FROM information_schema\.partitions/i.test(sql)) {
        return [[], []];
      }
      if (/FROM information_schema\.columns/i.test(sql)) {
        return [[
          { table_schema: "biz_test", table_name: "orders", column_name: "id", column_type: "bigint", data_type: "bigint", is_nullable: "NO", ordinal_position: 1, column_key: "PRI" },
          { table_schema: "biz_test", table_name: "orders", column_name: "status", column_type: "varchar(32)", data_type: "varchar", is_nullable: "YES", ordinal_position: 2, column_comment: "order status" }
        ], []];
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    }
  };
}

function oraclePool() {
  return {
    async query({ sql, values = [] }) {
      if (/USER AS schema_name FROM DUAL/i.test(sql)) {
        return [[{ SCHEMA_NAME: "APP" }], []];
      }
      if (/COUNT\(\*\) AS item_count\s+FROM all_tab_columns/i.test(sql)) {
        return [[{ ITEM_COUNT: 2 }], []];
      }
      if (/COUNT\(\*\) AS item_count\s+FROM all_indexes/i.test(sql)) {
        return [[{ ITEM_COUNT: 1 }], []];
      }
      if (/COUNT\(\*\) AS item_count\s+FROM all_constraints/i.test(sql)) {
        return [[{ ITEM_COUNT: 1 }], []];
      }
      if (/COUNT\(\*\) AS item_count\s+FROM all_tab_partitions/i.test(sql)) {
        return [[{ ITEM_COUNT: 0 }], []];
      }
      if (/SELECT .*owner, table_name, num_rows, blocks, last_analyzed/i.test(sql)) {
        return [[{ OWNER: "APP", TABLE_NAME: "ORDERS", NUM_ROWS: 12, BLOCKS: 3, LAST_ANALYZED: "2026-07-01" }], []];
      }
      if (/FROM all_tables t/i.test(sql)) {
        return [[{ OWNER: "APP", TABLE_NAME: "ORDERS", TABLE_COMMENT: "orders table", NUM_ROWS: 12 }], []];
      }
      if (/FROM user_indexes i/i.test(sql)) {
        return [[{ OWNER: "APP", TABLE_NAME: "ORDERS", INDEX_NAME: "PK_ORDERS", UNIQUENESS: "UNIQUE", COLUMN_NAME: "ID", COLUMN_POSITION: 1 }], []];
      }
      if (/FROM all_indexes i/i.test(sql)) {
        return [[{ OWNER: "APP", TABLE_NAME: "ORDERS", INDEX_NAME: "PK_ORDERS", UNIQUENESS: "UNIQUE", COLUMN_NAME: "ID", COLUMN_POSITION: 1 }], []];
      }
      if (/FROM user_constraints c/i.test(sql)) {
        return [[{ OWNER: "APP", TABLE_NAME: "ORDERS", CONSTRAINT_NAME: "PK_ORDERS", CONSTRAINT_TYPE: "P", COLUMN_NAME: "ID", POSITION: 1 }], []];
      }
      if (/FROM all_constraints c/i.test(sql)) {
        return [[{ OWNER: "APP", TABLE_NAME: "ORDERS", CONSTRAINT_NAME: "PK_ORDERS", CONSTRAINT_TYPE: "P", COLUMN_NAME: "ID", POSITION: 1 }], []];
      }
      if (/FROM user_tab_partitions/i.test(sql)) {
        return [[], []];
      }
      if (/FROM all_tab_partitions/i.test(sql)) {
        return [[], []];
      }
      if (/FROM user_tab_columns c/i.test(sql)) {
        return [[
          { OWNER: "APP", TABLE_NAME: "ORDERS", COLUMN_NAME: "ID", DATA_TYPE: "NUMBER", DATA_PRECISION: 20, NULLABLE: "N", COLUMN_ID: 1 },
          { OWNER: "APP", TABLE_NAME: "ORDERS", COLUMN_NAME: "STATUS", DATA_TYPE: "VARCHAR2", DATA_LENGTH: 32, NULLABLE: "Y", COLUMN_ID: 2, COMMENTS: "order status" }
        ], []];
      }
      if (/FROM all_tab_columns c/i.test(sql)) {
        return [[
          { OWNER: "APP", TABLE_NAME: "ORDERS", COLUMN_NAME: "ID", DATA_TYPE: "NUMBER", DATA_PRECISION: 20, NULLABLE: "N", COLUMN_ID: 1 },
          { OWNER: "APP", TABLE_NAME: "ORDERS", COLUMN_NAME: "STATUS", DATA_TYPE: "VARCHAR2", DATA_LENGTH: 32, NULLABLE: "Y", COLUMN_ID: 2, COMMENTS: "order status" }
        ], []];
      }
      if (/FROM all_objects\s+WHERE .*object_type IN/is.test(sql)) {
        return [[{ OWNER: "APP", OBJECT_NAME: "ORDER_VIEW", OBJECT_TYPE: "VIEW", STATUS: "VALID", CREATED: "2026-07-01", LAST_DDL_TIME: "2026-07-01" }], []];
      }
      if (/FROM all_objects\s+WHERE .*object_name = \?/is.test(sql)) {
        return [[{ OWNER: "APP", OBJECT_NAME: String(values[2]), OBJECT_TYPE: String(values[3]), STATUS: "VALID", LAST_DDL_TIME: "2026-07-01" }], []];
      }
      if (/FROM all_views/i.test(sql)) {
        return [[{ OWNER: "APP", VIEW_NAME: "ORDER_VIEW", TEXT_LENGTH: 32, TEXT: "SELECT secret_token FROM ORDERS" }], []];
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    }
  };
}
