import assert from "node:assert/strict";
import test from "node:test";

import { loadConfig } from "../dist/config.js";
import { createObMcpServer } from "../dist/mcp.js";

test("ob_query_preview runs EXPLAIN for allowed read-only SQL", async () => {
  const config = loadConfig({
    OB_ALLOWED_SCHEMAS: "biz_test",
    OB_ENFORCE_READ_ONLY_TX: "false",
    OB_MAX_ROWS: "20"
  });
  let explainCalls = 0;
  const pool = {
    async query({ sql }) {
      assert.match(sql, /^EXPLAIN\s+SELECT id FROM biz_test\.orders/i);
      explainCalls += 1;
      return [[{ id: 1, select_type: "SIMPLE", table: "orders", type: "const", key: "PRIMARY" }], []];
    }
  };
  const server = createObMcpServer(runtime(config, pool));
  const result = await server.executeToolHandler(server._registeredTools.ob_query_preview, {
    sql: "SELECT id FROM biz_test.orders WHERE id = ? ORDER BY id LIMIT 5",
    params: [1]
  }, {});
  const preview = JSON.parse(result.content[0].text);

  assert.equal(preview.allowed, true);
  assert.equal(preview.executed, false);
  assert.equal(preview.explainRun, true);
  assert.equal(preview.paramCount, 1);
  assert.equal(preview.shape.hasRowLimit, true);
  assert.equal(preview.shape.hasOrderBy, true);
  assert.equal(preview.analysis.riskLevel, "low");
  assert.equal(explainCalls, 1);
});

test("ob_query_preview reports blocked SQL without running EXPLAIN", async () => {
  const config = loadConfig({
    OB_ALLOWED_SCHEMAS: "biz_test",
    OB_ENFORCE_READ_ONLY_TX: "false"
  });
  const pool = {
    async query() {
      throw new Error("EXPLAIN should not run");
    }
  };
  const server = createObMcpServer(runtime(config, pool));
  const result = await server.executeToolHandler(server._registeredTools.ob_query_preview, {
    sql: "DROP TABLE biz_test.orders"
  }, {});
  const preview = JSON.parse(result.content[0].text);

  assert.equal(preview.allowed, false);
  assert.equal(preview.executed, false);
  assert.equal(preview.explainRun, false);
  assert(preview.checks.some((check) => check.name === "read_only_sql" && check.ok === false));
  assert(preview.warnings.some((warning) => /skipped/i.test(warning)));
});

function runtime(config, pool) {
  return {
    defaultProfile: "default",
    configs: { default: config },
    pools: { default: pool },
    queryLimiters: { default: { active: 0, limit: 5 } }
  };
}
