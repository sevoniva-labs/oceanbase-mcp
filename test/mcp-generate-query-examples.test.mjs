import assert from "node:assert/strict";
import test from "node:test";

import { loadConfig } from "../dist/config.js";
import { createObMcpServer } from "../dist/mcp.js";

test("ob_generate_query returns policy-checked MySQL templates", async () => {
  const config = loadConfig({
    OB_ALLOWED_SCHEMAS: "biz_test",
    OB_MAX_ROWS: "30"
  });
  const server = createObMcpServer(runtime(config, mysqlPool()));

  const result = await server.executeToolHandler(server._registeredTools.ob_generate_query, {
    schema: "biz_test",
    table: "orders",
    scenarios: ["by_primary_key", "pagination"]
  }, {});
  const output = JSON.parse(result.content[0].text);

  assert.equal(output.executed, false);
  assert.equal(output.mode, "mysql");
  assert.equal(output.templates.length, 2);
  assert(output.templates.every((template) => template.policy.allowed));
  assert(output.templates.every((template) => !/SELECT\s+\*/i.test(template.sql)));
});

test("ob_generate_query returns Oracle-compatible templates", async () => {
  const config = loadConfig({
    OB_COMPATIBILITY: "oracle",
    OB_ALLOWED_SCHEMAS: "APP",
    OB_MAX_ROWS: "25"
  });
  const server = createObMcpServer(runtime(config, oraclePool()));

  const result = await server.executeToolHandler(server._registeredTools.ob_generate_query, {
    schema: "APP",
    table: "ORDERS",
    scenarios: ["by_primary_key", "pagination"]
  }, {});
  const output = JSON.parse(result.content[0].text);
  const sql = output.templates.map((template) => template.sql).join("\n");

  assert.equal(output.executed, false);
  assert.equal(output.mode, "oracle");
  assert(output.templates.every((template) => template.policy.allowed));
  assert.match(sql, /"APP"\."ORDERS"/);
  assert.doesNotMatch(sql, /\bLIMIT\b/i);
});

test("ob_generate_query_examples returns MySQL read-only examples from metadata", async () => {
  const config = loadConfig({
    OB_ALLOWED_SCHEMAS: "biz_test",
    OB_MAX_ROWS: "30"
  });
  const server = createObMcpServer(runtime(config, mysqlPool()));

  const result = await server.executeToolHandler(server._registeredTools.ob_generate_query_examples, {
    schema: "biz_test",
    table: "orders",
    scenarios: ["by_primary_key", "pagination", "time_range", "aggregation"]
  }, {});
  const output = JSON.parse(result.content[0].text);

  assert.equal(output.executed, false);
  assert.equal(output.mode, "mysql");
  assert.equal(output.rowLimit, 30);
  assert.equal(output.examples.length, 4);
  assert(output.examples.some((example) => example.scenario === "pagination"));
  assert(output.examples.every((example) => example.policy.allowed));
  assert(output.examples.every((example) => !/SELECT\s+\*/i.test(example.sql)));
  assert(output.examples.some((example) =>
    example.parameters.some((parameter) => parameter.name === "limit" && parameter.exampleValue === 30)
  ));
});

test("ob_generate_query_examples returns Oracle-compatible examples from metadata", async () => {
  const config = loadConfig({
    OB_COMPATIBILITY: "oracle",
    OB_ALLOWED_SCHEMAS: "APP",
    OB_MAX_ROWS: "25"
  });
  const server = createObMcpServer(runtime(config, oraclePool()));

  const result = await server.executeToolHandler(server._registeredTools.ob_generate_query_examples, {
    schema: "APP",
    table: "ORDERS",
    scenarios: ["by_primary_key", "pagination", "time_range", "aggregation"]
  }, {});
  const output = JSON.parse(result.content[0].text);
  const sql = output.examples.map((example) => example.sql).join("\n");

  assert.equal(output.executed, false);
  assert.equal(output.mode, "oracle");
  assert.equal(output.rowLimit, 25);
  assert(output.examples.every((example) => example.policy.allowed));
  assert.match(sql, /"APP"\."ORDERS"/);
  assert.match(sql, /ROWNUM <= 1|FETCH NEXT \? ROWS ONLY|FETCH FIRST 25 ROWS ONLY/);
  assert.doesNotMatch(sql, /\bLIMIT\b/i);
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
        return [oracleColumns(String(values[2]), String(values[0])), []];
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
