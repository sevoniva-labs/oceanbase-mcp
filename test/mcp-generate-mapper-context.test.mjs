import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import test from "node:test";

import { loadConfig } from "../dist/config.js";
import { createObMcpServer } from "../dist/mcp.js";

test("ob_generate_mapper_context returns MySQL mapper context from an XML file", async () => {
  const dir = mkdtempSync(join(process.cwd(), ".tmp-ob-mcp-mapper-context-"));
  try {
    const file = join(dir, "OrderMapper.xml");
    writeFileSync(file, `
      <mapper namespace="OrderMapper">
        <select id="findOrders">
          SELECT o.id, o.status FROM biz_test.orders o
          <where><if test="status != null">o.status = #{status}</if></where>
          LIMIT 10
        </select>
      </mapper>
    `);
    const config = loadConfig({
      OB_ALLOWED_SCHEMAS: "biz_test",
      OB_MASKED_COLUMNS: "biz_test.orders.status"
    });
    const server = createObMcpServer(runtime(config, mysqlPool()));

    const result = await server.executeToolHandler(server._registeredTools.ob_generate_mapper_context, {
      filePath: relative(process.cwd(), file),
      line: 3,
      format: "markdown",
      maxColumns: 10
    }, {});
    const output = JSON.parse(result.content[0].text);

    assert.equal(output.mode, "mysql");
    assert.equal(output.source.type, "file");
    assert.equal(output.source.dynamic, true);
    assert.equal(output.tables[0].schema, "biz_test");
    assert.equal(output.tables[0].table, "orders");
    assert(output.tables[0].primaryKeys.includes("id"));
    assert(output.tables[0].columns.some((column) => column.name === "status" && column.masked === true));
    assert.match(output.markdown, /# OceanBase Mapper Context/);
    assert.match(output.markdown, /biz_test\.orders/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ob_generate_mapper_context returns Oracle table context", async () => {
  const config = loadConfig({
    OB_COMPATIBILITY: "oracle",
    OB_ALLOWED_SCHEMAS: "APP"
  });
  const server = createObMcpServer(runtime(config, oraclePool()));

  const result = await server.executeToolHandler(server._registeredTools.ob_generate_mapper_context, {
    schema: "APP",
    table: "ORDERS",
    format: "json"
  }, {});
  const output = JSON.parse(result.content[0].text);

  assert.equal(output.mode, "oracle");
  assert.equal(output.tables[0].schema, "APP");
  assert.equal(output.tables[0].table, "ORDERS");
  assert(output.tables[0].primaryKeys.includes("ID"));
  assert(output.tables[0].columns.some((column) => column.name === "STATUS"));
  assert(output.tables[0].indexes.some((index) => index.name === "PK_ORDERS"));
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
      if (/FROM information_schema\.table_constraints/i.test(sql)) {
        return [[{ table_schema: "biz_test", table_name: "orders", constraint_name: "PRIMARY", constraint_type: "PRIMARY KEY", column_name: "id", ordinal_position: 1 }], []];
      }
      if (/FROM information_schema\.statistics/i.test(sql)) {
        return [[
          { table_schema: "biz_test", table_name: "orders", index_name: "PRIMARY", non_unique: 0, seq_in_index: 1, column_name: "id" },
          { table_schema: "biz_test", table_name: "orders", index_name: "idx_status", non_unique: 1, seq_in_index: 1, column_name: "status" }
        ], []];
      }
      if (/FROM information_schema\.columns/i.test(sql)) {
        return [[
          mysqlColumn("biz_test", "orders", "id", "bigint", "NO", 1),
          mysqlColumn("biz_test", "orders", "status", "varchar(32)", "YES", 2),
          mysqlColumn("biz_test", "orders", "created_at", "datetime", "YES", 3)
        ], []];
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    }
  };
}

function mysqlColumn(schema, table, name, type, nullable, position) {
  return {
    table_schema: schema,
    table_name: table,
    column_name: name,
    column_type: type,
    data_type: type.split("(")[0],
    is_nullable: nullable,
    ordinal_position: position
  };
}

function oraclePool() {
  return {
    async query({ sql }) {
      if (/USER AS schema_name FROM DUAL/i.test(sql)) {
        return [[{ SCHEMA_NAME: "APP" }], []];
      }
      if (/FROM user_tab_columns c/i.test(sql)) {
        return [[
          oracleColumn("APP", "ORDERS", "ID", "NUMBER", "N", 1),
          oracleColumn("APP", "ORDERS", "STATUS", "VARCHAR2", "Y", 2)
        ], []];
      }
      if (/FROM user_constraints c/i.test(sql)) {
        return [[{ OWNER: "APP", TABLE_NAME: "ORDERS", CONSTRAINT_NAME: "PK_ORDERS", CONSTRAINT_TYPE: "P", COLUMN_NAME: "ID", POSITION: 1 }], []];
      }
      if (/FROM user_indexes i/i.test(sql)) {
        return [[{ OWNER: "APP", TABLE_NAME: "ORDERS", INDEX_NAME: "PK_ORDERS", UNIQUENESS: "UNIQUE", COLUMN_NAME: "ID", COLUMN_POSITION: 1 }], []];
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    }
  };
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
