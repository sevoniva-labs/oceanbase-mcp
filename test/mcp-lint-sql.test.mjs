import assert from "node:assert/strict";
import test from "node:test";

import { loadConfig } from "../dist/config.js";
import { createObMcpServer } from "../dist/mcp.js";

test("ob_lint_sql reports MySQL policy, shape, and EXPLAIN findings", async () => {
  const config = loadConfig({
    OB_ALLOWED_SCHEMAS: "biz_test",
    OB_ENFORCE_READ_ONLY_TX: "false"
  });
  const server = createObMcpServer(runtime(config, explainPool()));

  const result = await server.executeToolHandler(server._registeredTools.ob_lint_sql, {
    sql: "SELECT id FROM biz_test.orders WHERE status = ?",
    params: ["paid"]
  }, {});
  const lint = JSON.parse(result.content[0].text);

  assert.equal(lint.allowed, true);
  assert.equal(lint.executed, false);
  assert.equal(lint.explainRun, true);
  assert.equal(lint.severity, "high");
  assert(lint.findings.some((finding) => finding.rule === "missing_limit"));
  assert(lint.findings.some((finding) => finding.rule === "missing_order_by"));
  assert(lint.findings.some((finding) => finding.rule === "explain_full_scan"));
});

test("ob_lint_sql skips EXPLAIN for blocked SQL", async () => {
  const config = loadConfig({
    OB_ALLOWED_SCHEMAS: "biz_test",
    OB_ENFORCE_READ_ONLY_TX: "false"
  });
  const server = createObMcpServer(runtime(config, failPool()));

  const result = await server.executeToolHandler(server._registeredTools.ob_lint_sql, {
    sql: "SELECT * FROM biz_test.orders"
  }, {});
  const lint = JSON.parse(result.content[0].text);

  assert.equal(lint.allowed, false);
  assert.equal(lint.explainRun, false);
  assert.equal(lint.severity, "high");
  assert(lint.findings.some((finding) => finding.rule === "select_star"));
  assert(lint.findings.some((finding) => finding.rule === "explain_skipped"));
});

test("ob_lint_sql reports Oracle dialect pagination issues without EXPLAIN", async () => {
  const config = loadConfig({
    OB_COMPATIBILITY: "oracle",
    OB_ALLOWED_SCHEMAS: "APP",
    OB_ENFORCE_READ_ONLY_TX: "false"
  });
  const server = createObMcpServer(runtime(config, failPool()));

  const result = await server.executeToolHandler(server._registeredTools.ob_lint_sql, {
    sql: "SELECT ID FROM APP.ORDERS LIMIT 10",
    runExplain: false
  }, {});
  const lint = JSON.parse(result.content[0].text);

  assert.equal(lint.explainRun, false);
  assert(lint.findings.some((finding) => finding.rule === "dialect_pagination"));
});

function runtime(config, pool) {
  return {
    defaultProfile: "default",
    configs: { default: config },
    pools: { default: pool },
    queryLimiters: { default: { active: 0, limit: 5 } }
  };
}

function explainPool() {
  return {
    async query({ sql }) {
      assert.match(sql, /^EXPLAIN\s+SELECT id FROM biz_test\.orders/i);
      return [[{ table: "orders", type: "ALL", Extra: "Using where" }], []];
    }
  };
}

function failPool() {
  return {
    async query() {
      throw new Error("EXPLAIN should not run");
    }
  };
}
