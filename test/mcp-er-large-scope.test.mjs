import assert from "node:assert/strict";
import test from "node:test";

import { loadConfig } from "../dist/config.js";
import { createObMcpServer } from "../dist/mcp.js";

test("ob_generate_er_diagram loads large schema metadata in bounded batches", async () => {
  const queryLog = [];
  const config = loadConfig({
    OB_ALLOWED_SCHEMAS: "big_model",
    OB_ER_MAX_TABLES: "250",
    OB_ER_MAX_COLUMNS_PER_TABLE: "4",
    OB_MAX_RESULT_BYTES: "4000000"
  });
  const server = createObMcpServer({
    defaultProfile: "default",
    configs: { default: config },
    pools: { default: { query: largeSchemaQuery(queryLog) } },
    queryLimiters: { default: { active: 0, limit: 5 } }
  });

  const result = await server.executeToolHandler(server._registeredTools.ob_generate_er_diagram, {
    schema: "big_model",
    maxTables: 220,
    relationshipMode: "none"
  }, {});
  const payload = JSON.parse(result.content[0].text);

  assert.equal(payload.tableCount, 220);
  assert.equal(payload.stats.loadedTables, 220);
  assert.equal(payload.stats.queryCount, 4);
  assert.equal(queryLog.filter((entry) => /SELECT table_schema, table_name, column_name, column_type/i.test(entry.sql)).length, 1);
  assert.equal(queryLog.filter((entry) => /information_schema\.statistics/i.test(entry.sql)).length, 1);
  assert.equal(queryLog.filter((entry) => /constraints_with_not_null/i.test(entry.sql)).length, 1);
});

test("ob_generate_er_diagram avoids duplicate metadata reads for foreign-key relationships", async () => {
  const queryLog = [];
  const config = loadConfig({
    OB_ALLOWED_SCHEMAS: "big_model",
    OB_ER_MAX_TABLES: "250",
    OB_ER_MAX_COLUMNS_PER_TABLE: "4",
    OB_MAX_RESULT_BYTES: "4000000"
  });
  const server = createObMcpServer({
    defaultProfile: "default",
    configs: { default: config },
    pools: { default: { query: largeSchemaQuery(queryLog) } },
    queryLimiters: { default: { active: 0, limit: 5 } }
  });

  const result = await server.executeToolHandler(server._registeredTools.ob_generate_er_diagram, {
    schema: "big_model",
    maxTables: 80,
    relationshipMode: "foreign_key"
  }, {});
  const payload = JSON.parse(result.content[0].text);

  assert.equal(payload.tableCount, 80);
  assert.equal(payload.stats.queryCount, 5);
  assert.equal(queryLog.filter((entry) => /SELECT table_schema, table_name, column_name, column_type/i.test(entry.sql)).length, 1);
  assert.equal(queryLog.filter((entry) => /FROM information_schema\.statistics/i.test(entry.sql)).length, 1);
  assert.equal(queryLog.filter((entry) => /constraints_with_not_null/i.test(entry.sql)).length, 1);
  assert.equal(queryLog.filter((entry) => /FROM information_schema\.key_column_usage kcu/i.test(entry.sql)).length, 1);
});

test("ob_generate_er_html skips schema-level inline rendering for large scopes", async () => {
  const queryLog = [];
  const config = loadConfig({
    OB_ALLOWED_SCHEMAS: "big_model",
    OB_ER_MAX_TABLES: "250",
    OB_ER_MAX_COLUMNS_PER_TABLE: "4",
    OB_MAX_RESULT_BYTES: "4000000"
  });
  const server = createObMcpServer({
    defaultProfile: "default",
    configs: { default: config },
    pools: { default: { query: largeSchemaQuery(queryLog) } },
    queryLimiters: { default: { active: 0, limit: 5 } }
  });

  const result = await server.executeToolHandler(server._registeredTools.ob_generate_er_html, {
    schema: "big_model",
    maxTables: 30,
    relationshipMode: "none",
    format: "html-interactive"
  }, {});
  const payload = JSON.parse(result.content[0].text);

  assert.equal(payload.tableCount, 30);
  assert.equal(payload.inline, false);
  assert.equal(payload.htmlOmitted, true);
  assert.equal(payload.renderSkipped, true);
  assert.equal("html" in payload, false);
  assert.match(payload.exportCommand, /ob-mcp export-er/);
  assert(payload.warnings.some((warning) => /Schema-level ER HTML rendering was skipped/.test(warning)));
  assert(payload.warnings.some((warning) => /cluster export/.test(warning)));
});

test("ob_plan_er_export returns cluster local export commands", async () => {
  const queryLog = [];
  const config = loadConfig({
    OB_ALLOWED_SCHEMAS: "big_model",
    OB_ER_MAX_TABLES: "250",
    OB_ER_MAX_COLUMNS_PER_TABLE: "4",
    OB_MAX_RESULT_BYTES: "4000000"
  });
  const server = createObMcpServer({
    defaultProfile: "default",
    configs: { default: config },
    pools: { default: { query: largeSchemaQuery(queryLog) } },
    queryLimiters: { default: { active: 0, limit: 5 } }
  });

  const result = await server.executeToolHandler(server._registeredTools.ob_plan_er_export, {
    schema: "big_model",
    maxTables: 55,
    relationshipMode: "none",
    strategy: "table-prefix",
    maxColumnsPerTable: 6,
    chunkSize: 20,
    outputDir: "er-output"
  }, {});
  const payload = JSON.parse(result.content[0].text);

  assert.equal(payload.tableCount, 55);
  assert.equal(payload.estimatedTableCount, 220);
  assert.equal(payload.estimatedColumnCount, 3000);
  assert.equal(payload.strategy, "table-prefix");
  assert.equal(payload.chunkCount, 3);
  assert.equal(payload.chunks[0].tableCount, 20);
  assert.equal(payload.chunks[2].tableCount, 15);
  assert.match(payload.singleFileCommand, /ob-mcp export-er/);
  assert.match(payload.singleFileCommand, /--max-columns-per-table 6/);
  assert.match(payload.chunks[0].command, /--tables/);
  assert.equal(payload.chunks[0].file, "er-output/clusters/cluster-001.html");
  assert.deepEqual(payload.relationships, []);
  assert(payload.warnings.some((warning) => /cluster export commands/.test(warning)));
  assert.equal(queryLog.filter((entry) => /SELECT table_schema, table_name, column_name/i.test(entry.sql)).length, 0);
  assert.equal(queryLog.filter((entry) => /FROM information_schema\.statistics/i.test(entry.sql)).length, 0);
  assert.equal(queryLog.filter((entry) => /constraints_with_not_null/i.test(entry.sql)).length, 0);
});

test("ob_plan_er_export uses lightweight Oracle metadata planning", async () => {
  const queryLog = [];
  const config = loadConfig({
    OB_COMPATIBILITY: "oracle",
    OB_DATABASE: "OB_USER",
    OB_ALLOWED_SCHEMAS: "OB_USER",
    OB_ER_MAX_TABLES: "250",
    OB_ER_MAX_COLUMNS_PER_TABLE: "4",
    OB_MAX_RESULT_BYTES: "4000000"
  });
  const server = createObMcpServer({
    defaultProfile: "default",
    configs: { default: config },
    pools: { default: { query: oracleLargeSchemaQuery(queryLog) } },
    queryLimiters: { default: { active: 0, limit: 5 } }
  });

  const result = await server.executeToolHandler(server._registeredTools.ob_plan_er_export, {
    schema: "OB_USER",
    maxTables: 80,
    relationshipMode: "foreign_key",
    strategy: "connected-components",
    chunkSize: 25,
    outputDir: "oracle-er"
  }, {});
  const payload = JSON.parse(result.content[0].text);

  assert.equal(payload.mode, "oracle");
  assert.equal(payload.estimatedTableCount, 240);
  assert.equal(payload.estimatedColumnCount, 3600);
  assert.equal(payload.estimatedRelationshipCount, 30);
  assert.equal(payload.relationshipCount, 2);
  assert.equal(payload.crossClusterRelationshipCount, 0);
  assert.equal(payload.relationships.length, 2);
  assert.equal(payload.relationships[0].source.label, "OB_USER.ORDER_ITEMS");
  assert.equal(payload.relationships[0].target.label, "OB_USER.ORDERS");
  assert.deepEqual(payload.relationships[0].source.columns, ["ORDER_ID"]);
  assert.deepEqual(payload.relationships[0].target.columns, ["ID"]);
  assert.equal(payload.strategy, "connected-components");
  assert.equal(payload.chunkCount, 4);
  assert.match(payload.chunks[0].command, /--relationship-mode foreign_key/);
  assert.equal(queryLog.filter((entry) => /FROM all_tab_columns c/i.test(entry.sql)).length, 0);
  assert.equal(queryLog.filter((entry) => /FROM all_indexes i/i.test(entry.sql)).length, 0);
});

function largeSchemaQuery(queryLog) {
  return async ({ sql, values = [] }) => {
    queryLog.push({ sql, values });
    if (/COUNT\(\*\) AS count_value FROM information_schema\.tables/i.test(sql)) {
      return [[{ count_value: 220 }], []];
    }
    if (/COUNT\(\*\) AS count_value FROM information_schema\.columns/i.test(sql)) {
      return [[{ count_value: 3000 }], []];
    }
    if (/COUNT\(DISTINCT CONCAT_WS/i.test(sql)) {
      return [[{ count_value: 12 }], []];
    }
    if (/SELECT table_schema, table_name, table_rows/i.test(sql)) {
      return [[
        { table_schema: "big_model", table_name: "t_001", table_rows: 1000000 },
        { table_schema: "big_model", table_name: "t_002", table_rows: 900000 }
      ], []];
    }
    if (/FROM information_schema\.key_column_usage kcu/i.test(sql)) {
      return [[], []];
    }
    if (/FROM information_schema\.tables/i.test(sql)) {
      const limit = Number(values.at(-1) ?? 220);
      return [Array.from({ length: Math.min(limit, 220) }, (_, index) => ({
        table_schema: "big_model",
        table_name: `t_${String(index + 1).padStart(3, "0")}`,
        table_type: "BASE TABLE",
        table_comment: `table ${index + 1}`
      })), []];
    }
    if (/FROM information_schema\.statistics/i.test(sql)) {
      return [tableNamesFromPairs(values).map((table) => ({
        table_schema: "big_model",
        table_name: table,
        index_name: `idx_${table}_code`,
        non_unique: 1,
        seq_in_index: 1,
        column_name: "code",
        index_type: "BTREE"
      })), []];
    }
    if (/constraints_with_not_null/i.test(sql)) {
      return [tableNamesFromPairs(values).map((table) => ({
        table_schema: "big_model",
        table_name: table,
        constraint_name: `pk_${table}`,
        constraint_type: "PRIMARY KEY",
        column_name: "id",
        ordinal_position: 1
      })), []];
    }
    if (/FROM information_schema\.columns/i.test(sql)) {
      return [tableNamesFromPairs(values).flatMap((table) => [
        column(table, "id", "bigint", "NO", 1),
        column(table, "code", "varchar(64)", "NO", 2),
        column(table, "status", "varchar(32)", "YES", 3),
        column(table, "created_at", "datetime", "YES", 4),
        column(table, "updated_at", "datetime", "YES", 5)
      ]), []];
    }
    throw new Error(`Unexpected SQL: ${sql}`);
  };
}

function oracleLargeSchemaQuery(queryLog) {
  return async ({ sql, values = [] }) => {
    queryLog.push({ sql, values });
    if (/COUNT\(\*\) AS count_value FROM all_tables/i.test(sql)) {
      return [[{ COUNT_VALUE: 240 }], []];
    }
    if (/COUNT\(\*\) AS count_value FROM all_tab_columns/i.test(sql)) {
      return [[{ COUNT_VALUE: 3600 }], []];
    }
    if (/COUNT\(\*\) AS count_value FROM all_constraints/i.test(sql)) {
      return [[{ COUNT_VALUE: 30 }], []];
    }
    if (/SELECT .*owner, table_name, num_rows/i.test(sql)) {
      return [[
        { OWNER: "OB_USER", TABLE_NAME: "ORDERS", NUM_ROWS: 1200000 },
        { OWNER: "OB_USER", TABLE_NAME: "ORDER_ITEMS", NUM_ROWS: 3000000 }
      ], []];
    }
    if (/FROM all_tables/i.test(sql)) {
      const limit = Number(values.at(-1) ?? 80);
      return [Array.from({ length: Math.min(limit, 80) }, (_, index) => ({
        OWNER: "OB_USER",
        TABLE_NAME: index === 0 ? "ORDERS" : index === 1 ? "ORDER_ITEMS" : index === 2 ? "USERS" : `BIZ_${String(index + 1).padStart(3, "0")}`,
        NUM_ROWS: 1000 - index
      })), []];
    }
    if (/FROM all_constraints c/i.test(sql) && /JOIN all_cons_columns cc/i.test(sql)) {
      return [[
        {
          CONSTRAINT_NAME: "FK_ORDER_ITEMS_ORDER",
          SOURCE_SCHEMA: "OB_USER",
          SOURCE_TABLE: "ORDER_ITEMS",
          SOURCE_COLUMN: "ORDER_ID",
          TARGET_SCHEMA: "OB_USER",
          TARGET_TABLE: "ORDERS",
          TARGET_COLUMN: "ID"
        },
        {
          CONSTRAINT_NAME: "FK_ORDERS_USER",
          SOURCE_SCHEMA: "OB_USER",
          SOURCE_TABLE: "ORDERS",
          SOURCE_COLUMN: "USER_ID",
          TARGET_SCHEMA: "OB_USER",
          TARGET_TABLE: "USERS",
          TARGET_COLUMN: "ID"
        }
      ], []];
    }
    throw new Error(`Unexpected Oracle SQL: ${sql}`);
  };
}

function tableNamesFromPairs(values) {
  const tables = [];
  for (let index = 1; index < values.length; index += 2) {
    tables.push(values[index]);
  }
  return tables;
}

function column(table, name, type, nullable, position) {
  return {
    table_schema: "big_model",
    table_name: table,
    column_name: name,
    column_type: type,
    data_type: type.replace(/\(.*/, ""),
    is_nullable: nullable,
    ordinal_position: position
  };
}
