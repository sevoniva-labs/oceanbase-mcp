import assert from "node:assert/strict";
import test from "node:test";

import { loadConfig } from "../dist/config.js";
import { createObMcpServer } from "../dist/mcp.js";

test("tool errors include structured hints for read-only policy blocks", async () => {
  const config = loadConfig({ OB_ALLOWED_SCHEMAS: "biz_test", OB_ENFORCE_READ_ONLY_TX: "false" });
  const server = createObMcpServer(runtime(config));
  const result = await server.executeToolHandler(server._registeredTools.ob_query, {
    sql: "DROP TABLE biz_test.orders"
  }, {});
  const error = JSON.parse(result.content[0].text);

  assert.equal(result.isError, true);
  assert.equal(error.ok, false);
  assert(error.hints.some((hint) => /Only read-only SELECT/.test(hint)));
});

test("tool errors include hints for invalid paged query input", async () => {
  const config = loadConfig({ OB_ALLOWED_SCHEMAS: "biz_test", OB_ENFORCE_READ_ONLY_TX: "false" });
  const server = createObMcpServer(runtime(config));
  const result = await server.executeToolHandler(server._registeredTools.ob_query_page, {
    sql: "SELECT id FROM biz_test.orders LIMIT 10",
    page: 1,
    pageSize: 5
  }, {});
  const error = JSON.parse(result.content[0].text);

  assert.equal(result.isError, true);
  assert(error.hints.some((hint) => /without existing LIMIT/.test(hint)));
});

function runtime(config) {
  return {
    defaultProfile: "default",
    configs: { default: config },
    pools: { default: { async query() { throw new Error("DB should not be called"); } } },
    queryLimiters: { default: { active: 0, limit: 5 } }
  };
}
