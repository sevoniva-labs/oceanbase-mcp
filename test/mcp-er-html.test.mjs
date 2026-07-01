import assert from "node:assert/strict";
import test from "node:test";

import { loadConfig } from "../dist/config.js";
import { createObMcpServer } from "../dist/mcp.js";

test("ob_generate_er_html returns self-contained ER HTML from visible metadata", async () => {
  const config = loadConfig({
    OB_ALLOWED_SCHEMAS: "biz_test",
    OB_DENIED_COLUMNS: "secret_token"
  });
  const server = createObMcpServer(runtime(config));

  const result = await server.executeToolHandler(server._registeredTools.ob_generate_er_html, {
    schema: "biz_test",
    table: "orders",
    includeInferred: false,
    title: "Order ER"
  }, {});
  const payload = JSON.parse(result.content[0].text);

  assert.equal(payload.contentType, "text/html");
  assert.equal(payload.tableCount, 2);
  assert.equal(payload.relationshipCount, 1);
  assert.match(payload.html, /<svg role="img" aria-label="OceanBase ER diagram"/);
  assert.match(payload.html, /Order ER/);
  assert.match(payload.html, /fk_orders_user/);
  assert.match(payload.html, /Mermaid Source/);
  assert.doesNotMatch(payload.html, /<script/i);
  assert.doesNotMatch(payload.html, /<link/i);
  assert.doesNotMatch(payload.html, /secret_token/);
});

function runtime(config) {
  return {
    defaultProfile: "default",
    configs: { default: config },
    pools: { default: { query } },
    queryLimiters: { default: { active: 0, limit: 5 } }
  };
}

async function query({ sql, values = [] }) {
  if (/kcu\.table_schema = \? AND kcu\.table_name = \?/i.test(sql)) {
    return [[{
      constraint_name: "fk_orders_user",
      source_schema: "biz_test",
      source_table: "orders",
      source_column: "user_id",
      target_schema: "biz_test",
      target_table: "users",
      target_column: "id"
    }], []];
  }
  if (/kcu\.referenced_table_schema = \? AND kcu\.referenced_table_name = \?/i.test(sql)) {
    return [[], []];
  }
  if (/FROM information_schema\.columns\s+c\s+LEFT JOIN information_schema\.statistics/i.test(sql)) {
    return [[], []];
  }
  if (/FROM information_schema\.table_constraints tc\s+JOIN information_schema\.key_column_usage/i.test(sql)) {
    return [[{ column_name: "id" }], []];
  }
  if (/LOWER\(table_name\) IN/i.test(sql)) {
    return [[{ table_schema: "biz_test", table_name: "users" }], []];
  }
  if (/FROM information_schema\.statistics/i.test(sql)) {
    return [[
      { table_schema: "biz_test", table_name: "orders", index_name: "idx_orders_user", non_unique: 1, seq_in_index: 1, column_name: "user_id" }
    ], []];
  }
  if (/constraints_with_not_null/i.test(sql)) {
    const table = values[1];
    return [[
      { table_schema: "biz_test", table_name: table, constraint_name: "PRIMARY", constraint_type: "PRIMARY KEY", column_name: "id", ordinal_position: 1 }
    ], []];
  }
  if (/FROM information_schema\.columns/i.test(sql)) {
    const table = values[0];
    return [columnsFor(table), []];
  }
  throw new Error(`Unexpected SQL: ${sql}`);
}

function columnsFor(table) {
  if (table === "users") {
    return [
      { table_schema: "biz_test", table_name: "users", column_name: "id", column_type: "bigint", data_type: "bigint", is_nullable: "NO", ordinal_position: 1 },
      { table_schema: "biz_test", table_name: "users", column_name: "name", column_type: "varchar(64)", data_type: "varchar", is_nullable: "YES", ordinal_position: 2 }
    ];
  }
  return [
    { table_schema: "biz_test", table_name: "orders", column_name: "id", column_type: "bigint", data_type: "bigint", is_nullable: "NO", ordinal_position: 1 },
    { table_schema: "biz_test", table_name: "orders", column_name: "user_id", column_type: "bigint", data_type: "bigint", is_nullable: "NO", ordinal_position: 2 },
    { table_schema: "biz_test", table_name: "orders", column_name: "secret_token", column_type: "varchar(128)", data_type: "varchar", is_nullable: "YES", ordinal_position: 3 }
  ];
}
