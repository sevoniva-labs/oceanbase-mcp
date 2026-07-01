import assert from "node:assert/strict";
import test from "node:test";

import { loadConfig } from "../dist/config.js";
import { createObMcpServer } from "../dist/mcp.js";

test("ob_get_schema_map returns compact MySQL table summaries", async () => {
  const config = loadConfig({
    OB_ALLOWED_SCHEMAS: "biz_test",
    OB_MASKED_COLUMNS: "biz_test.orders.status"
  });
  const server = createObMcpServer(runtime(config, mysqlPool()));

  const result = await server.executeToolHandler(server._registeredTools.ob_get_schema_map, {
    schema: "biz_test",
    tablePattern: "order",
    includeRelationships: false,
    maxTables: 5,
    maxColumnsPerTable: 3
  }, {});
  const map = JSON.parse(result.content[0].text);

  assert.equal(map.mode, "mysql");
  assert.equal(map.tableCount, 1);
  assert.equal(map.schemas[0].schema, "biz_test");
  assert.equal(map.schemas[0].tables[0].table, "orders");
  assert.deepEqual(map.schemas[0].tables[0].primaryKeys, ["id"]);
  assert(map.schemas[0].tables[0].keyFields.includes("created_at"));
  assert(map.schemas[0].tables[0].statusFields.includes("status"));
  assert.equal(map.schemas[0].tables[0].columns.find((column) => column.name === "status").masked, true);
  assert.equal(map.schemas[0].tables[0].relationSummary, undefined);
});

test("ob_get_schema_map returns compact Oracle table summaries", async () => {
  const config = loadConfig({
    OB_COMPATIBILITY: "oracle",
    OB_ALLOWED_SCHEMAS: "APP"
  });
  const server = createObMcpServer(runtime(config, oraclePool()));

  const result = await server.executeToolHandler(server._registeredTools.ob_get_schema_map, {
    schema: "APP",
    includeRelationships: false,
    maxTables: 5
  }, {});
  const map = JSON.parse(result.content[0].text);

  assert.equal(map.mode, "oracle");
  assert.equal(map.schemas[0].schema, "APP");
  assert.equal(map.schemas[0].tables[0].table, "ORDERS");
  assert.deepEqual(map.schemas[0].tables[0].primaryKeys, ["ID"]);
  assert(map.schemas[0].tables[0].timeFields.includes("CREATED_AT"));
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
      if (/FROM information_schema\.table_constraints tc/i.test(sql)) {
        return [[
          {
            table_schema: "biz_test",
            table_name: "orders",
            constraint_name: "PRIMARY",
            constraint_type: "PRIMARY KEY",
            column_name: "id",
            ordinal_position: 1
          }
        ], []];
      }
      if (/FROM information_schema\.tables/i.test(sql)) {
        return [[
          {
            table_schema: "biz_test",
            table_name: "orders",
            table_type: "BASE TABLE",
            engine: "OceanBase",
            table_comment: "orders table",
            table_rows: 42
          }
        ], []];
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
            ordinal_position: 1
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
          },
          {
            table_schema: "biz_test",
            table_name: "orders",
            column_name: "created_at",
            column_type: "datetime",
            data_type: "datetime",
            is_nullable: "YES",
            ordinal_position: 3
          }
        ], []];
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    }
  };
}

function oraclePool() {
  return {
    async query({ sql }) {
      if (/USER AS schema_name FROM DUAL/i.test(sql)) {
        return [[{ SCHEMA_NAME: "APP" }], []];
      }
      if (/FROM all_tables t/i.test(sql)) {
        return [[
          {
            OWNER: "APP",
            TABLE_NAME: "ORDERS",
            TABLE_COMMENT: "orders table",
            NUM_ROWS: 10
          }
        ], []];
      }
      if (/FROM user_constraints c/i.test(sql)) {
        return [[
          {
            OWNER: "APP",
            TABLE_NAME: "ORDERS",
            CONSTRAINT_NAME: "PK_ORDERS",
            CONSTRAINT_TYPE: "P",
            COLUMN_NAME: "ID",
            POSITION: 1
          }
        ], []];
      }
      if (/FROM user_tab_columns c/i.test(sql)) {
        return [[
          {
            OWNER: "APP",
            TABLE_NAME: "ORDERS",
            COLUMN_NAME: "ID",
            DATA_TYPE: "NUMBER",
            DATA_PRECISION: 20,
            NULLABLE: "N",
            COLUMN_ID: 1
          },
          {
            OWNER: "APP",
            TABLE_NAME: "ORDERS",
            COLUMN_NAME: "CREATED_AT",
            DATA_TYPE: "DATE",
            NULLABLE: "Y",
            COLUMN_ID: 2
          }
        ], []];
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    }
  };
}
