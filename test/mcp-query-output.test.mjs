import assert from "node:assert/strict";
import test from "node:test";

import { loadConfig } from "../dist/config.js";
import { createObMcpServer } from "../dist/mcp.js";

test("ob_query returns columns, markdown preview, warnings, and masked configured fields", async () => {
  const config = loadConfig({
    OB_ALLOWED_SCHEMAS: "biz_test",
    OB_MASKED_COLUMNS: "biz_test.orders.status",
    OB_ENFORCE_READ_ONLY_TX: "false",
    OB_MAX_ROWS: "10"
  });
  const pool = {
    async query({ sql }) {
      assert.match(sql, /^SELECT \* FROM \(SELECT id, status FROM biz_test\.orders ORDER BY id LIMIT 2\)/i);
      return [[
        { id: 1, status: "PAID" },
        { id: 2, status: "NEW" }
      ], [
        { name: "id", table: "orders", db: "biz_test", columnType: 8 },
        { name: "status", table: "orders", db: "biz_test", columnType: 253 }
      ]];
    }
  };
  const server = createObMcpServer(runtime(config, pool));
  const result = await server.executeToolHandler(server._registeredTools.ob_query, {
    sql: "SELECT id, status FROM biz_test.orders ORDER BY id LIMIT 2"
  }, {});
  const output = JSON.parse(result.content[0].text);

  assert.equal(output.columns[0].name, "id");
  assert.equal(output.columns[1].name, "status");
  assert.equal(output.columns[1].masked, true);
  assert.deepEqual(output.rows.map((row) => row.status), ["***MASKED***", "***MASKED***"]);
  assert.match(output.markdownPreview, /\| id \| status \|/);
  assert(output.warnings.some((warning) => /Masked result columns: status/.test(warning)));
});

function runtime(config, pool) {
  return {
    defaultProfile: "default",
    configs: { default: config },
    pools: { default: pool },
    queryLimiters: { default: { active: 0, limit: 5 } }
  };
}
