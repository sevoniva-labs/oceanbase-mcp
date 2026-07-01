import assert from "node:assert/strict";
import test from "node:test";

import { loadConfig } from "../dist/config.js";
import { createObMcpServer } from "../dist/mcp.js";

test("ob_rewrite_sql replaces MySQL SELECT star and adds a row cap", async () => {
  const config = loadConfig({
    OB_ALLOWED_SCHEMAS: "biz_test",
    OB_MAX_ROWS: "50"
  });
  const server = createObMcpServer(runtime(config, mysqlPool()));

  const result = await server.executeToolHandler(server._registeredTools.ob_rewrite_sql, {
    sql: "SELECT * FROM biz_test.orders WHERE status = ?",
    params: ["paid"],
    maxRows: 20
  }, {});
  const rewritten = JSON.parse(result.content[0].text);

  assert.equal(rewritten.changed, true);
  assert.equal(rewritten.allowed, true);
  assert.equal(rewritten.executed, false);
  assert.equal(
    rewritten.rewrittenSql,
    "SELECT `id`, `status`, `created_at` FROM biz_test.orders WHERE status = ? LIMIT 20 OFFSET 0"
  );
  assert(rewritten.changes.some((change) => change.rule === "replace_select_star"));
  assert(rewritten.changes.some((change) => change.rule === "add_pagination"));
});

test("ob_rewrite_sql adds Oracle pagination without metadata reads when projection is explicit", async () => {
  const config = loadConfig({
    OB_COMPATIBILITY: "oracle",
    OB_ALLOWED_SCHEMAS: "APP",
    OB_MAX_ROWS: "5"
  });
  const server = createObMcpServer(runtime(config, failPool()));

  const result = await server.executeToolHandler(server._registeredTools.ob_rewrite_sql, {
    sql: "SELECT ID FROM APP.ORDERS WHERE STATUS = ?",
    params: ["PAID"],
    orderBy: "ID DESC",
    maxRows: 5
  }, {});
  const rewritten = JSON.parse(result.content[0].text);

  assert.equal(rewritten.allowed, true);
  assert.equal(
    rewritten.rewrittenSql,
    "SELECT ID FROM APP.ORDERS WHERE STATUS = ? ORDER BY ID DESC OFFSET 0 ROWS FETCH NEXT 5 ROWS ONLY"
  );
});

test("ob_rewrite_sql refuses to rewrite write SQL", async () => {
  const config = loadConfig({
    OB_ALLOWED_SCHEMAS: "biz_test"
  });
  const server = createObMcpServer(runtime(config, failPool()));

  const result = await server.executeToolHandler(server._registeredTools.ob_rewrite_sql, {
    sql: "DELETE FROM biz_test.orders WHERE id = ?",
    params: [1]
  }, {});
  const rewritten = JSON.parse(result.content[0].text);

  assert.equal(rewritten.changed, false);
  assert.equal(rewritten.allowed, false);
  assert.equal(rewritten.rewrittenSql, null);
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
    ordinal_position: position
  };
}

function failPool() {
  return {
    async query() {
      throw new Error("Database should not be queried");
    }
  };
}
