import assert from "node:assert/strict";
import test from "node:test";

import { loadConfig } from "../dist/config.js";
import { createObMcpServer } from "../dist/mcp.js";

test("ob_explain_relationship returns evidence for visible table relationships", async () => {
  const config = loadConfig({ OB_ALLOWED_SCHEMAS: "biz_test" });
  const server = createObMcpServer(runtime(config));

  const found = JSON.parse((await server.executeToolHandler(server._registeredTools.ob_explain_relationship, {
    schema: "biz_test",
    sourceTable: "orders",
    targetTable: "users",
    includeInferred: false
  }, {})).content[0].text);

  assert.equal(found.conclusion, "relationship_found");
  assert.equal(found.relationshipCount, 1);
  assert.equal(found.relationships[0].relationType, "foreign_key");
  assert.equal(found.relationships[0].source.table, "orders");
  assert.equal(found.relationships[0].target.table, "users");
  assert.match(found.relationships[0].evidence[0].detail, /foreign-key metadata/i);

  const missing = JSON.parse((await server.executeToolHandler(server._registeredTools.ob_explain_relationship, {
    schema: "biz_test",
    sourceTable: "orders",
    targetTable: "payments",
    includeInferred: false
  }, {})).content[0].text);
  assert.equal(missing.conclusion, "not_found");
  assert.equal(missing.relationshipCount, 0);
  assert.match(missing.warnings[0], /No visible relationship/);
});

function runtime(config) {
  return {
    defaultProfile: "default",
    configs: { default: config },
    pools: { default: { query } },
    queryLimiters: { default: { active: 0, limit: 5 } }
  };
}

async function query({ sql }) {
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
  if (/FROM information_schema\.columns/i.test(sql)) {
    return [[
      { table_schema: "biz_test", table_name: "orders", column_name: "id", column_type: "bigint", data_type: "bigint", is_nullable: "NO", ordinal_position: 1 },
      { table_schema: "biz_test", table_name: "orders", column_name: "user_id", column_type: "bigint", data_type: "bigint", is_nullable: "NO", ordinal_position: 2 }
    ], []];
  }
  throw new Error(`Unexpected SQL: ${sql}`);
}
