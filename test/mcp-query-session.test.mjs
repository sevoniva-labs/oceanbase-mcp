import assert from "node:assert/strict";
import test from "node:test";

import { loadConfig } from "../dist/config.js";
import { createObMcpServer } from "../dist/mcp.js";

test("query sessions persist context without exposing parameter values", async () => {
  const config = loadConfig({
    OB_ALLOWED_SCHEMAS: "biz_test",
    OB_MASKED_COLUMNS: "biz_test.orders.status",
    OB_ENFORCE_READ_ONLY_TX: "false"
  });
  const sharedRuntime = runtime(config);
  const server = createObMcpServer(sharedRuntime);

  const startedResult = await server.executeToolHandler(server._registeredTools.ob_start_query_session, {
    businessTerm: "orders",
    schema: "biz_test",
    table: "orders",
    columns: ["id", "status"],
    sql: "SELECT id, status FROM biz_test.orders WHERE id = ? ORDER BY id",
    params: [1001],
    page: 2,
    pageSize: 20,
    orderBy: "id",
    warnings: ["Reviewed with table metadata."]
  }, {});
  const started = JSON.parse(startedResult.content[0].text);

  assert.match(started.sessionId, /^qs_/);
  assert.equal(started.profile, "default");
  assert.equal(started.mode, "mysql");
  assert.equal(started.paramCount, 1);
  assert.equal(started.params, undefined);
  assert.deepEqual(started.masking.maskedColumns, ["status"]);
  assert(started.policy.allowed);
  assert.equal(started.executed, false);

  const secondServer = createObMcpServer(sharedRuntime);
  const readResult = await secondServer.executeToolHandler(secondServer._registeredTools.ob_get_query_session, {
    sessionId: started.sessionId
  }, {});
  const read = JSON.parse(readResult.content[0].text);

  assert.equal(read.sessionId, started.sessionId);
  assert.equal(read.sql, "SELECT id, status FROM biz_test.orders WHERE id = ? ORDER BY id");
  assert.equal(read.paramCount, 1);
  assert.equal(read.params, undefined);
  assert.equal(read.page, 2);
  assert.equal(read.pageSize, 20);
  assert(read.warnings.includes("Reviewed with table metadata."));

  const closedResult = await secondServer.executeToolHandler(secondServer._registeredTools.ob_close_query_session, {
    sessionId: started.sessionId
  }, {});
  const closed = JSON.parse(closedResult.content[0].text);

  assert.equal(closed.closed, true);
  assert.equal(closed.sessionId, started.sessionId);

  const missingResult = await server.executeToolHandler(server._registeredTools.ob_get_query_session, {
    sessionId: started.sessionId
  }, {});
  assert.equal(missingResult.isError, true);
});

test("query sessions support Oracle mode context", async () => {
  const config = loadConfig({
    OB_COMPATIBILITY: "oracle",
    OB_ALLOWED_SCHEMAS: "APP",
    OB_ENFORCE_READ_ONLY_TX: "false"
  });
  const server = createObMcpServer(runtime(config));

  const result = await server.executeToolHandler(server._registeredTools.ob_start_query_session, {
    schema: "APP",
    table: "ORDERS",
    columns: ["ID", "STATUS"],
    sql: "SELECT ID, STATUS FROM APP.ORDERS ORDER BY ID",
    page: 1,
    pageSize: 10,
    orderBy: "ID"
  }, {});
  const session = JSON.parse(result.content[0].text);

  assert.equal(session.mode, "oracle");
  assert.equal(session.schema, "APP");
  assert.equal(session.table, "ORDERS");
  assert.equal(session.paramCount, 0);
  assert(session.policy.allowed);
});

test("query sessions reject write SQL", async () => {
  const config = loadConfig({
    OB_ALLOWED_SCHEMAS: "biz_test",
    OB_ENFORCE_READ_ONLY_TX: "false"
  });
  const server = createObMcpServer(runtime(config));

  const result = await server.executeToolHandler(server._registeredTools.ob_start_query_session, {
    schema: "biz_test",
    table: "orders",
    sql: "UPDATE biz_test.orders SET status = 'x'"
  }, {});
  const error = JSON.parse(result.content[0].text);

  assert.equal(result.isError, true);
  assert.equal(error.ok, false);
  assert.match(error.error.message, /Only read-only SQL/);
});

function runtime(config) {
  return {
    defaultProfile: "default",
    configs: { default: config },
    pools: { default: failPool() },
    queryLimiters: { default: { active: 0, limit: 5 } }
  };
}

function failPool() {
  return {
    async query() {
      throw new Error("DB should not be called");
    }
  };
}
