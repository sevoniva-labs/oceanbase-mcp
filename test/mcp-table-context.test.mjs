import assert from "node:assert/strict";
import test from "node:test";

import { loadConfig } from "../dist/config.js";
import { createObMcpServer } from "../dist/mcp.js";

test("ob_get_table_context returns policy-filtered metadata and masked sample rows", async () => {
  const config = loadConfig({
    OB_ALLOWED_SCHEMAS: "biz_test",
    OB_MASKED_COLUMNS: "biz_test.orders.status",
    OB_MAX_ROWS: "10"
  });
  const pool = {
    async query({ sql }) {
      if (/SHOW CREATE TABLE/i.test(sql)) {
        return [[{ "Create Table": "CREATE TABLE `biz_test`.`orders` (`id` bigint NOT NULL, `status` varchar(32), `payload` longtext, PRIMARY KEY (`id`))" }], []];
      }
      if (/COUNT\(DISTINCT index_name\)/i.test(sql)) {
        return [[{ item_count: 1 }], []];
      }
      if (/COUNT\(DISTINCT constraint_name\)/i.test(sql)) {
        return [[{ item_count: 2 }], []];
      }
      if (/COUNT\(\*\) AS item_count FROM information_schema\.columns/i.test(sql)) {
        return [[{ item_count: 3 }], []];
      }
      if (/COUNT\(\*\) AS item_count\s+FROM information_schema\.partitions/i.test(sql)) {
        return [[{ item_count: 0 }], []];
      }
      if (/FROM information_schema\.tables/i.test(sql)) {
        return [[{
          table_schema: "biz_test",
          table_name: "orders",
          table_rows: 42,
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
      if (/FROM information_schema\.table_constraints/i.test(sql)) {
        return [[{
          table_schema: "biz_test",
          table_name: "orders",
          constraint_name: "PRIMARY",
          constraint_type: "PRIMARY KEY",
          column_name: "id",
          ordinal_position: 1
        }], []];
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
          },
          {
            table_schema: "biz_test",
            table_name: "orders",
            column_name: "payload",
            column_type: "longtext",
            data_type: "longtext",
            is_nullable: "YES",
            ordinal_position: 3,
            column_comment: "large payload"
          }
        ], []];
      }
      if (/FROM information_schema\.partitions/i.test(sql)) {
        return [[], []];
      }
      if (/SELECT `id`, `status` FROM `biz_test`\.`orders` LIMIT 3/i.test(sql)) {
        return [[
          { id: 1, status: "PAID" },
          { id: 2, status: "NEW" },
          { id: 3, status: "CANCELLED" }
        ], [
          { name: "id", table: "orders", db: "biz_test", columnType: 8 },
          { name: "status", table: "orders", db: "biz_test", columnType: 253 }
        ]];
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    }
  };
  const runtime = {
    defaultProfile: "default",
    configs: { default: config },
    pools: { default: pool },
    queryLimiters: { default: { active: 0, limit: 5 } }
  };
  const server = createObMcpServer(runtime);
  const tool = server._registeredTools.ob_get_table_context;
  const result = await server.executeToolHandler(tool, {
    schema: "biz_test",
    table: "orders",
    includeRelated: false,
    includeTemplates: false,
    sampleLimit: 2
  }, {});
  const context = JSON.parse(result.content[0].text);

  assert.equal(context.mode, "mysql");
  assert.equal(context.schema, "biz_test");
  assert.equal(context.table, "orders");
  assert.equal(context.ddl.source, "native");
  assert.equal(context.columns[0].column_comment, "order id");
  assert.equal(context.statistics.rowEstimate.value, 42);
  assert.equal(context.relatedTables, undefined);
  assert.equal(context.queryTemplates, undefined);
  assert.equal(context.sample.rows.length, 2);
  assert.equal(context.sample.truncated, true);
  assert.equal(context.sample.fields.some((field) => field.name === "payload"), false);
  assert.deepEqual(context.sample.rows.map((row) => row.status), ["***MASKED***", "***MASKED***"]);
  assert(context.warnings.some((warning) => /skipped large or binary columns: payload/i.test(warning)));
});

test("ob_get_table_context skips default sample rows for large tables", async () => {
  const config = loadConfig({
    OB_ALLOWED_SCHEMAS: "biz_test",
    OB_MAX_ROWS: "10"
  });
  const table = "large_orders";
  const queries = [];
  const pool = {
    async query({ sql }) {
      queries.push(sql);
      if (/SELECT `id`, `status` FROM `biz_test`\.`large_orders`/i.test(sql)) {
        throw new Error("sample query should not run for large table context without explicit sampleLimit");
      }
      if (/SHOW CREATE TABLE/i.test(sql)) {
        return [[{ "Create Table": "CREATE TABLE `biz_test`.`large_orders` (`id` bigint NOT NULL, `status` varchar(32), PRIMARY KEY (`id`))" }], []];
      }
      if (/COUNT\(DISTINCT index_name\)/i.test(sql)) {
        return [[{ item_count: 1 }], []];
      }
      if (/COUNT\(DISTINCT constraint_name\)/i.test(sql)) {
        return [[{ item_count: 1 }], []];
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
          table_name: table,
          table_rows: 1_000_001,
          data_length: 1048576,
          index_length: 131072
        }], []];
      }
      if (/FROM information_schema\.statistics/i.test(sql)) {
        return [[{
          table_schema: "biz_test",
          table_name: table,
          index_name: "PRIMARY",
          non_unique: 0,
          seq_in_index: 1,
          column_name: "id"
        }], []];
      }
      if (/FROM information_schema\.table_constraints/i.test(sql)) {
        return [[{
          table_schema: "biz_test",
          table_name: table,
          constraint_name: "PRIMARY",
          constraint_type: "PRIMARY KEY",
          column_name: "id",
          ordinal_position: 1
        }], []];
      }
      if (/FROM information_schema\.columns/i.test(sql)) {
        return [[
          { table_schema: "biz_test", table_name: table, column_name: "id", column_type: "bigint", data_type: "bigint", is_nullable: "NO", column_key: "PRI", ordinal_position: 1 },
          { table_schema: "biz_test", table_name: table, column_name: "status", column_type: "varchar(32)", data_type: "varchar", is_nullable: "YES", ordinal_position: 2 }
        ], []];
      }
      if (/FROM information_schema\.partitions/i.test(sql)) {
        return [[], []];
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    }
  };
  const server = createObMcpServer({
    defaultProfile: "default",
    configs: { default: config },
    pools: { default: pool },
    queryLimiters: { default: { active: 0, limit: 5 } }
  });
  const result = await server.executeToolHandler(server._registeredTools.ob_get_table_context, {
    schema: "biz_test",
    table,
    includeRelated: false,
    includeTemplates: false
  }, {});
  const context = JSON.parse(result.content[0].text);

  assert.equal(context.statistics.rowEstimate.value, 1_000_001);
  assert.equal(context.sample, undefined);
  assert(context.warnings.some((warning) => /Sample rows were skipped because the table row estimate is 1000001/i.test(warning)));
  assert.equal(queries.some((sql) => /SELECT `id`, `status` FROM `biz_test`\.`large_orders`/i.test(sql)), false);
});
