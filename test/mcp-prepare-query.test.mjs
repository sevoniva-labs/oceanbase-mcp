import assert from "node:assert/strict";
import test from "node:test";

import { loadConfig } from "../dist/config.js";
import { createObMcpServer } from "../dist/mcp.js";

test("ob_prepare_query prepares MySQL candidates and SQL drafts from metadata", async () => {
  const config = loadConfig({
    OB_ALLOWED_SCHEMAS: "biz_test",
    OB_MAX_ROWS: "50"
  });
  const server = createObMcpServer(runtime(config, mysqlPool()));

  const result = await server.executeToolHandler(server._registeredTools.ob_prepare_query, {
    question: "show recent orders",
    schema: "biz_test"
  }, {});
  const prepared = JSON.parse(result.content[0].text);

  assert.equal(prepared.executed, false);
  assert.equal(prepared.mode, "mysql");
  assert.equal(prepared.candidateCount, 1);
  assert(prepared.searchTerms.includes("orders"));
  assert.equal(prepared.candidates[0].table, "orders");
  assert(prepared.candidates[0].fields.some((field) => field.name === "created_at"));
  assert.equal(prepared.candidates[0].suggestedSql.scenario, "time_range");
  assert.match(prepared.candidates[0].suggestedSql.sql, /created_at/);
  assert.equal(prepared.candidates[0].suggestedSql.policy.allowed, true);
  assert.equal(prepared.candidates[0].pagination.tool, "ob_query_page");
});

test("ob_prepare_query prepares Oracle SQL drafts for an explicit table", async () => {
  const config = loadConfig({
    OB_COMPATIBILITY: "oracle",
    OB_ALLOWED_SCHEMAS: "APP",
    OB_MAX_ROWS: "25"
  });
  const server = createObMcpServer(runtime(config, oraclePool()));

  const result = await server.executeToolHandler(server._registeredTools.ob_prepare_query, {
    question: "按主键查询订单",
    schema: "APP",
    table: "ORDERS"
  }, {});
  const prepared = JSON.parse(result.content[0].text);

  assert.equal(prepared.executed, false);
  assert.equal(prepared.mode, "oracle");
  assert.equal(prepared.candidateCount, 1);
  assert.equal(prepared.candidates[0].table, "ORDERS");
  assert.equal(prepared.candidates[0].suggestedSql.scenario, "by_primary_key");
  assert.match(prepared.candidates[0].suggestedSql.sql, /ROWNUM <= 1/);
  assert.equal(prepared.candidates[0].suggestedSql.policy.allowed, true);
  assert.equal(prepared.candidates[0].pagination.pageSize, 25);
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
    async query({ sql, values = [] }) {
      if (/catalog_matches/i.test(sql)) {
        return [[
          {
            match_type: "table",
            table_schema: "biz_test",
            table_name: "orders",
            comment_text: "customer orders"
          },
          {
            match_type: "column",
            table_schema: "biz_test",
            table_name: "orders",
            column_name: "created_at",
            comment_text: "order creation time"
          }
        ], []];
      }
      if (/FROM information_schema\.key_column_usage kcu\s+WHERE/i.test(sql)) {
        return [[], []];
      }
      if (/FROM information_schema\.columns c\s+LEFT JOIN information_schema\.statistics/i.test(sql)) {
        return [[], []];
      }
      if (/JOIN information_schema\.key_column_usage kcu/i.test(sql)) {
        return [[{ column_name: "id" }], []];
      }
      if (/FROM information_schema\.tables\s+WHERE table_schema =/i.test(sql)) {
        return [[], []];
      }
      if (/FROM information_schema\.statistics/i.test(sql)) {
        return [[
          {
            table_schema: "biz_test",
            table_name: "orders",
            index_name: "PRIMARY",
            non_unique: 0,
            seq_in_index: 1,
            column_name: "id",
            index_type: "BTREE"
          }
        ], []];
      }
      if (/constraints_with_not_null/i.test(sql)) {
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
    column_key: name === "id" ? "PRI" : "",
    ordinal_position: position,
    column_comment: name === "created_at" ? "order creation time" : ""
  };
}

function oraclePool() {
  return {
    async query({ sql, values = [] }) {
      if (/USER AS schema_name FROM DUAL/i.test(sql)) {
        return [[{ SCHEMA_NAME: "CURRENT_USER" }], []];
      }
      if (/JOIN all_constraints r/i.test(sql)) {
        return [[], []];
      }
      if (/FROM all_tab_columns c\s+LEFT JOIN all_ind_columns/i.test(sql)) {
        return [[], []];
      }
      if (/FROM all_tables\s+WHERE owner =/i.test(sql)) {
        return [[], []];
      }
      if (/FROM all_indexes i/i.test(sql)) {
        return [[
          {
            OWNER: "APP",
            TABLE_NAME: "ORDERS",
            INDEX_NAME: "PK_ORDERS",
            UNIQUENESS: "UNIQUE",
            COLUMN_NAME: "ID",
            COLUMN_POSITION: 1
          }
        ], []];
      }
      if (/FROM all_constraints c\s+JOIN all_cons_columns cc/i.test(sql)) {
        return [[{ COLUMN_NAME: "ID" }], []];
      }
      if (/FROM all_constraints c/i.test(sql)) {
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
