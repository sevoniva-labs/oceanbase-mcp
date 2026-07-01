import assert from "node:assert/strict";
import test from "node:test";

import { loadConfig } from "../dist/config.js";
import { createObMcpServer } from "../dist/mcp.js";

test("query session next and previous page reuse stored MySQL context", async () => {
  const config = loadConfig({
    OB_ALLOWED_SCHEMAS: "biz_test",
    OB_ENFORCE_READ_ONLY_TX: "false",
    OB_MAX_ROWS: "10"
  });
  const pool = mysqlPool();
  const server = createObMcpServer(runtime(config, pool));
  const startResult = await server.executeToolHandler(server._registeredTools.ob_start_query_session, {
    schema: "biz_test",
    table: "orders",
    columns: ["id"],
    sql: "SELECT id FROM biz_test.orders",
    page: 1,
    pageSize: 2,
    orderBy: "id"
  }, {});
  const session = JSON.parse(startResult.content[0].text);

  const nextResult = await server.executeToolHandler(server._registeredTools.ob_query_next_page, {
    sessionId: session.sessionId
  }, {});
  const nextPage = JSON.parse(nextResult.content[0].text);

  assert.equal(nextPage.executed, true);
  assert.equal(nextPage.page, 2);
  assert.equal(nextPage.pageSize, 2);
  assert.equal(nextPage.hasMore, true);
  assert.deepEqual(nextPage.rows, [{ id: 3 }, { id: 4 }]);
  assert.equal(nextPage.session.page, 2);
  assert.equal(pool.sql[0], "SELECT id FROM biz_test.orders ORDER BY id LIMIT 3 OFFSET 2");

  const prevResult = await server.executeToolHandler(server._registeredTools.ob_query_prev_page, {
    sessionId: session.sessionId
  }, {});
  const prevPage = JSON.parse(prevResult.content[0].text);

  assert.equal(prevPage.page, 1);
  assert.equal(prevPage.hasMore, false);
  assert.deepEqual(prevPage.rows, [{ id: 1 }, { id: 2 }]);
  assert.equal(prevPage.session.page, 1);
  assert.equal(pool.sql[1], "SELECT id FROM biz_test.orders ORDER BY id LIMIT 3 OFFSET 0");
});

test("query session next page uses Oracle pagination syntax", async () => {
  const config = loadConfig({
    OB_COMPATIBILITY: "oracle",
    OB_ALLOWED_SCHEMAS: "APP",
    OB_ENFORCE_READ_ONLY_TX: "false",
    OB_MAX_ROWS: "10"
  });
  const pool = oraclePool();
  const server = createObMcpServer(runtime(config, pool));
  const startResult = await server.executeToolHandler(server._registeredTools.ob_start_query_session, {
    schema: "APP",
    table: "ORDERS",
    columns: ["ID"],
    sql: "SELECT ID FROM APP.ORDERS ORDER BY ID",
    page: 1,
    pageSize: 2
  }, {});
  const session = JSON.parse(startResult.content[0].text);

  const nextResult = await server.executeToolHandler(server._registeredTools.ob_query_next_page, {
    sessionId: session.sessionId
  }, {});
  const nextPage = JSON.parse(nextResult.content[0].text);

  assert.equal(nextPage.mode, "oracle");
  assert.equal(nextPage.page, 2);
  assert.deepEqual(nextPage.rows, [{ ID: 3 }, { ID: 4 }]);
  assert.equal(
    pool.sql[0],
    "SELECT ID FROM APP.ORDERS ORDER BY ID OFFSET 2 ROWS FETCH NEXT 3 ROWS ONLY"
  );
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
    sql: [],
    async query({ sql }) {
      this.sql.push(sql);
      if (/OFFSET 2$/.test(sql)) {
        return [[{ id: 3 }, { id: 4 }, { id: 5 }], [{ name: "id", table: "orders", db: "biz_test", columnType: 8 }]];
      }
      if (/OFFSET 0$/.test(sql)) {
        return [[{ id: 1 }, { id: 2 }], [{ name: "id", table: "orders", db: "biz_test", columnType: 8 }]];
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    }
  };
}

function oraclePool() {
  return {
    sql: [],
    async query({ sql }) {
      this.sql.push(sql);
      return [[{ ID: 3 }, { ID: 4 }, { ID: 5 }], [{ name: "ID", table: "ORDERS", db: "APP", columnType: 2 }]];
    }
  };
}
