import assert from "node:assert/strict";
import test from "node:test";

import { loadConfig } from "../dist/config.js";
import { createObMcpServer } from "../dist/mcp.js";

test("core metadata and preview tools survive repeated read-only calls", async () => {
  const config = loadConfig({
    OB_ALLOWED_SCHEMAS: "biz_test",
    OB_ENFORCE_READ_ONLY_TX: "false",
    OB_MAX_ROWS: "20"
  });
  const queries = [];
  const server = createObMcpServer(runtime(config, {
    async query({ sql, values = [] }) {
      queries.push({ sql, values });
      assertReadOnlyMetadataSql(sql);
      return mockRows(sql, values);
    }
  }));

  const operations = [
    () => server.executeToolHandler(server._registeredTools.ob_describe_table, {
      schema: "biz_test",
      table: "orders"
    }, {}),
    () => server.executeToolHandler(server._registeredTools.ob_query_preview, {
      sql: "SELECT id FROM biz_test.orders WHERE id = ? ORDER BY id LIMIT 5",
      params: [1]
    }, {}),
    () => server.executeToolHandler(server._registeredTools.ob_get_table_context, {
      schema: "biz_test",
      table: "orders",
      includeSample: false,
      includeRelated: false,
      includeTemplates: false
    }, {}),
    () => server.executeToolHandler(server._registeredTools.ob_generate_er_diagram, {
      schema: "biz_test",
      table: "orders",
      relationshipMode: "none",
      maxTables: 5,
      maxRelationships: 5
    }, {})
  ];

  for (let index = 0; index < 32; index += 1) {
    const result = await operations[index % operations.length]();
    assert.equal(result.content.length, 1);
    const payload = JSON.parse(result.content[0].text);
    assert.notEqual(payload.ok, false);
    assert.equal(payload.error, undefined);
  }

  assert.equal(queries.some(({ sql }) => /^EXPLAIN\s+SELECT/i.test(sql)), true);
  assert.equal(queries.some(({ sql }) => /FROM information_schema\.columns/i.test(sql)), true);
  assert.equal(queries.some(({ sql }) => /FROM information_schema\.tables/i.test(sql)), true);
});

test("core Oracle metadata and preview tools survive repeated read-only calls", async () => {
  const config = loadConfig({
    OB_COMPATIBILITY: "oracle",
    OB_ALLOWED_SCHEMAS: "APP",
    OB_ENFORCE_READ_ONLY_TX: "false",
    OB_MAX_ROWS: "20"
  });
  const queries = [];
  const server = createObMcpServer(runtime(config, {
    async query({ sql, values = [] }) {
      queries.push({ sql, values });
      assertReadOnlyMetadataSql(sql);
      return mockOracleRows(sql, values);
    }
  }));

  const operations = [
    () => server.executeToolHandler(server._registeredTools.ob_describe_table, {
      schema: "APP",
      table: "ORDERS"
    }, {}),
    () => server.executeToolHandler(server._registeredTools.ob_query_preview, {
      sql: "SELECT ID FROM APP.ORDERS WHERE ID = :id",
      params: [1]
    }, {}),
    () => server.executeToolHandler(server._registeredTools.ob_get_table_context, {
      schema: "APP",
      table: "ORDERS",
      includeSample: false,
      includeRelated: false,
      includeTemplates: false
    }, {}),
    () => server.executeToolHandler(server._registeredTools.ob_generate_er_diagram, {
      schema: "APP",
      table: "ORDERS",
      relationshipMode: "none",
      maxTables: 5,
      maxRelationships: 5
    }, {})
  ];

  for (let index = 0; index < 32; index += 1) {
    const result = await operations[index % operations.length]();
    assert.equal(result.content.length, 1);
    const payload = JSON.parse(result.content[0].text);
    assert.notEqual(payload.ok, false);
    assert.equal(payload.error, undefined);
  }

  assert.equal(queries.some(({ sql }) => /^EXPLAIN\s+SELECT/i.test(sql)), true);
  assert.equal(queries.some(({ sql }) => /FROM user_tab_columns c/i.test(sql)), true);
  assert.equal(queries.some(({ sql }) => /FROM all_tables/i.test(sql)), true);
});

function runtime(config, pool) {
  return {
    defaultProfile: "default",
    configs: { default: config },
    pools: { default: pool },
    queryLimiters: { default: { active: 0, limit: 5 } }
  };
}

function assertReadOnlyMetadataSql(sql) {
  const normalized = sql.replace(/\s+/g, " ").trim();
  assert.doesNotMatch(normalized, /^(INSERT|UPDATE|DELETE|MERGE|CREATE|ALTER|DROP|TRUNCATE|GRANT|REVOKE)\b/i);
  if (/FROM\s+`?biz_test`?\.`?orders`?/i.test(normalized)) {
    assert.match(normalized, /^EXPLAIN\s+SELECT\b/i);
  }
  if (/FROM\s+"?APP"?\."?ORDERS"?/i.test(normalized)) {
    assert.match(normalized, /^EXPLAIN\s+SELECT\b/i);
  }
}

function mockRows(sql, values) {
  if (/^EXPLAIN\s+SELECT/i.test(sql)) {
    return [[{ id: 1, select_type: "SIMPLE", table: "orders", type: "const", key: "PRIMARY" }], []];
  }
  if (/SHOW CREATE TABLE/i.test(sql)) {
    return [[{ "Create Table": "CREATE TABLE `biz_test`.`orders` (`id` bigint NOT NULL, `status` varchar(32), PRIMARY KEY (`id`))" }], []];
  }
  if (/COUNT\(DISTINCT index_name\)/i.test(sql)) {
    return [[{ item_count: 1 }], []];
  }
  if (/COUNT\(DISTINCT constraint_name\)/i.test(sql)) {
    return [[{ item_count: 2 }], []];
  }
  if (/COUNT\(\*\) AS item_count FROM information_schema\.columns/i.test(sql)) {
    return [[{ item_count: 2 }], []];
  }
  if (/COUNT\(\*\) AS item_count\s+FROM information_schema\.partitions/i.test(sql)) {
    return [[{ item_count: 0 }], []];
  }
  if (/FROM information_schema\.tables/i.test(sql)) {
    return [[{
      table_schema: "biz_test",
      table_name: "orders",
      table_rows: 1000000,
      data_length: 4096,
      index_length: 1024,
      update_time: "2026-07-01 10:00:00"
    }], []];
  }
  if (/FROM information_schema\.statistics/i.test(sql)) {
    return [[{
      table_schema: "biz_test",
      table_name: "orders",
      index_name: "PRIMARY",
      non_unique: 0,
      seq_in_index: 1,
      column_name: "id"
    }], []];
  }
  if (/constraints_with_not_null/i.test(sql) || /FROM information_schema\.table_constraints/i.test(sql)) {
    return [[{
      table_schema: "biz_test",
      table_name: values.includes("orders") ? "orders" : "users",
      constraint_name: "PRIMARY",
      constraint_type: "PRIMARY KEY",
      column_name: "id",
      ordinal_position: 1
    }], []];
  }
  if (/FROM information_schema\.partitions/i.test(sql)) {
    return [[], []];
  }
  if (/FROM information_schema\.columns/i.test(sql)) {
    return [[
      {
        table_schema: "biz_test",
        table_name: "orders",
        column_name: "id",
        column_type: "bigint",
        data_type: "bigint",
        is_nullable: "NO",
        column_key: "PRI",
        ordinal_position: 1,
        column_comment: "order id"
      },
      {
        table_schema: "biz_test",
        table_name: "orders",
        column_name: "status",
        column_type: "varchar(32)",
        data_type: "varchar",
        is_nullable: "YES",
        ordinal_position: 2,
        column_comment: "order status"
      }
    ], []];
  }
  throw new Error(`Unexpected SQL: ${sql}`);
}

function mockOracleRows(sql, values) {
  if (/USER AS schema_name FROM DUAL/i.test(sql)) {
    return [[{ SCHEMA_NAME: "APP" }], []];
  }
  if (/^EXPLAIN\s+SELECT/i.test(sql)) {
    assert.deepEqual(values, [1]);
    return [[{ OPERATOR: "TABLE GET", NAME: "ORDERS", ROWS: 1 }], []];
  }
  if (/FROM user_tab_columns c/i.test(sql)) {
    return [[
      { OWNER: "APP", TABLE_NAME: "ORDERS", COLUMN_NAME: "ID", DATA_TYPE: "NUMBER", DATA_PRECISION: 20, NULLABLE: "N", COLUMN_ID: 1, COMMENTS: "order id" },
      { OWNER: "APP", TABLE_NAME: "ORDERS", COLUMN_NAME: "STATUS", DATA_TYPE: "VARCHAR2", DATA_LENGTH: 32, NULLABLE: "Y", COLUMN_ID: 2, COMMENTS: "order status" }
    ], []];
  }
  if (/FROM all_tab_columns c/i.test(sql)) {
    return [[
      { OWNER: "APP", TABLE_NAME: "ORDERS", COLUMN_NAME: "ID", DATA_TYPE: "NUMBER", DATA_PRECISION: 20, NULLABLE: "N", COLUMN_ID: 1, COMMENTS: "order id" },
      { OWNER: "APP", TABLE_NAME: "ORDERS", COLUMN_NAME: "STATUS", DATA_TYPE: "VARCHAR2", DATA_LENGTH: 32, NULLABLE: "Y", COLUMN_ID: 2, COMMENTS: "order status" }
    ], []];
  }
  if (/FROM user_indexes i/i.test(sql)) {
    return [[{
      OWNER: "APP",
      TABLE_NAME: "ORDERS",
      INDEX_NAME: "PK_ORDERS",
      UNIQUENESS: "UNIQUE",
      COLUMN_NAME: "ID",
      COLUMN_POSITION: 1
    }], []];
  }
  if (/FROM all_indexes i/i.test(sql) && /all_ind_columns/i.test(sql)) {
    return [[{
      OWNER: "APP",
      TABLE_NAME: "ORDERS",
      INDEX_NAME: "PK_ORDERS",
      UNIQUENESS: "UNIQUE",
      COLUMN_NAME: "ID",
      COLUMN_POSITION: 1
    }], []];
  }
  if (/FROM user_constraints c/i.test(sql)) {
    return [[{
      OWNER: "APP",
      TABLE_NAME: "ORDERS",
      CONSTRAINT_NAME: "PK_ORDERS",
      CONSTRAINT_TYPE: "P",
      COLUMN_NAME: "ID",
      POSITION: 1
    }], []];
  }
  if (/FROM all_constraints c/i.test(sql) && /all_cons_columns/i.test(sql)) {
    return [[{
      OWNER: "APP",
      TABLE_NAME: "ORDERS",
      CONSTRAINT_NAME: "PK_ORDERS",
      CONSTRAINT_TYPE: "P",
      COLUMN_NAME: "ID",
      POSITION: 1
    }], []];
  }
  if (/FROM user_tab_partitions/i.test(sql)) {
    return [[], []];
  }
  if (/FROM all_tables/i.test(sql)) {
    return [[{
      OWNER: "APP",
      TABLE_NAME: "ORDERS",
      NUM_ROWS: 1000000,
      BLOCKS: 128,
      LAST_ANALYZED: "2026-07-01 10:00:00"
    }], []];
  }
  if (/COUNT\(\*\) AS item_count\s+FROM all_tab_columns/i.test(sql)) {
    return [[{ ITEM_COUNT: 2 }], []];
  }
  if (/COUNT\(\*\) AS item_count\s+FROM all_indexes/i.test(sql)) {
    return [[{ ITEM_COUNT: 1 }], []];
  }
  if (/COUNT\(\*\) AS item_count\s+FROM all_constraints/i.test(sql)) {
    return [[{ ITEM_COUNT: 2 }], []];
  }
  if (/COUNT\(\*\) AS item_count\s+FROM all_tab_partitions/i.test(sql)) {
    return [[{ ITEM_COUNT: 0 }], []];
  }
  throw new Error(`Unexpected Oracle SQL: ${sql}`);
}
