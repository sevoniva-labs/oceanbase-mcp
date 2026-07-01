import assert from "node:assert/strict";
import test from "node:test";

import { loadConfig } from "../dist/config.js";
import { createObMcpServer } from "../dist/mcp.js";

test("ob_query_page returns a capped page and hasMore flag", async () => {
  const config = loadConfig({
    OB_ALLOWED_SCHEMAS: "biz_test",
    OB_ENFORCE_READ_ONLY_TX: "false",
    OB_MAX_ROWS: "10"
  });
  let executedSql = "";
  const pool = {
    async query({ sql }) {
      executedSql = sql;
      assert.equal(sql, "SELECT id FROM biz_test.orders ORDER BY id LIMIT 3 OFFSET 2");
      return [[{ id: 3 }, { id: 4 }, { id: 5 }], [{ name: "id", table: "orders", db: "biz_test", columnType: 8 }]];
    }
  };
  const server = createObMcpServer(runtime(config, pool));
  const result = await server.executeToolHandler(server._registeredTools.ob_query_page, {
    sql: "SELECT id FROM biz_test.orders",
    page: 2,
    pageSize: 2,
    orderBy: "id"
  }, {});
  const page = JSON.parse(result.content[0].text);

  assert.equal(page.executed, true);
  assert.equal(page.page, 2);
  assert.equal(page.pageSize, 2);
  assert.equal(page.hasMore, true);
  assert.equal(page.truncated, true);
  assert.deepEqual(page.rows, [{ id: 3 }, { id: 4 }]);
  assert.equal(page.columns[0].name, "id");
  assert.equal(page.pagedSql, executedSql);
});

function runtime(config, pool) {
  return {
    defaultProfile: "default",
    configs: { default: config },
    pools: { default: pool },
    queryLimiters: { default: { active: 0, limit: 5 } }
  };
}
