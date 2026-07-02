import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { loadConfig } from "../dist/config.js";
import { createObMcpServer } from "../dist/mcp.js";

test("ob_generate_er_diagram supports business term scope and relationship filters", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ob-mcp-er-"));
  try {
    const glossaryFile = join(dir, "glossary.json");
    writeFileSync(glossaryFile, JSON.stringify({
      terms: [
        {
          term: "订单",
          aliases: ["order"],
          description: "订单主表",
          targets: [{ schema: "biz_test", table: "orders" }]
        }
      ]
    }));
    const config = loadConfig({
      OB_ALLOWED_SCHEMAS: "biz_test",
      OB_DENIED_COLUMNS: "secret_token",
      OB_BUSINESS_GLOSSARY_FILE: glossaryFile
    });
    const server = createObMcpServer(runtime(config));

    const result = await server.executeToolHandler(server._registeredTools.ob_generate_er_diagram, {
      schema: "biz_test",
      businessTerm: "订单",
      includeInferred: false,
      minConfidence: 0.9,
      maxTables: 5
    }, {});
    const diagram = JSON.parse(result.content[0].text);

    assert.equal(diagram.mode, "mysql");
    assert.equal(diagram.businessTerm, "订单");
    assert.equal(diagram.tableCount, 2);
    assert.equal(diagram.relationshipCount, 1);
    assert.equal(diagram.relationshipMode, "foreign_key");
    assert.equal(diagram.includeInferred, false);
    assert.equal(diagram.filteredRelationshipCount, 0);
    assert.equal(diagram.stats.relationships, 1);
    assert(diagram.scope.find((item) => item.table === "orders").sources.includes("business_term"));
    assert.match(diagram.mermaid, /biz_test_users \|\|--o\{ biz_test_orders : "fk_orders_user"/);
    assert.doesNotMatch(result.content[0].text, /secret_token/);
    assert.equal(diagram.diagram.relationships[0].relationType, "foreign_key");
    assert.equal(diagram.status, "OK");
    assert.equal(diagram.graph.summary.confirmedRelationships, 1);
    assert.equal(diagram.graph.summary.visibleRelationships, 1);
    assert.match(diagram.graph.nodes[0].id, /^t_[a-f0-9]{14}$/);
    assert.equal(diagram.graph.edges[0].relationClass, "confirmed");
    assert.equal(diagram.graph.edges[0].visibleByDefault, true);
    assert(diagram.diagnostics.some((diagnostic) => diagnostic.code === "er_inferred_relationships_disabled"));
    assert(diagram.warnings.some((warning) => /Name-inferred relationships are disabled/i.test(warning)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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
  if (/catalog_matches/i.test(sql)) {
    return [[], []];
  }
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
    return [[{
      table_schema: "biz_test",
      table_name: "order_items",
      column_name: "order_id",
      indexed: 1
    }], []];
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
    return [[
      { table_schema: "biz_test", table_name: "users", column_name: "id", column_type: "bigint", data_type: "bigint", is_nullable: "NO", ordinal_position: 1 },
      { table_schema: "biz_test", table_name: "users", column_name: "name", column_type: "varchar(64)", data_type: "varchar", is_nullable: "YES", ordinal_position: 2 }
    ]][0];
  }
  return [[
    { table_schema: "biz_test", table_name: "orders", column_name: "id", column_type: "bigint", data_type: "bigint", is_nullable: "NO", ordinal_position: 1 },
    { table_schema: "biz_test", table_name: "orders", column_name: "user_id", column_type: "bigint", data_type: "bigint", is_nullable: "NO", ordinal_position: 2 },
    { table_schema: "biz_test", table_name: "orders", column_name: "secret_token", column_type: "varchar(128)", data_type: "varchar", is_nullable: "YES", ordinal_position: 3 }
  ]][0];
}
