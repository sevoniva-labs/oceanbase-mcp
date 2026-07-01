import assert from "node:assert/strict";
import test from "node:test";

import { loadConfig } from "../dist/config.js";
import { createObMcpServer } from "../dist/mcp.js";

test("ob_compare_query_results compares row counts, keys, and value distributions", async () => {
  const config = loadConfig({
    OB_ALLOWED_SCHEMAS: "biz_test",
    OB_MASKED_COLUMNS: "biz_test.orders.email",
    OB_ENFORCE_READ_ONLY_TX: "false"
  });
  const server = createObMcpServer(runtime(config));

  const result = await server.executeToolHandler(server._registeredTools.ob_compare_query_results, {
    leftName: "before",
    rightName: "after",
    leftRows: [
      { id: 1, status: "NEW", amount: 10, email: "a@example.com" },
      { id: 2, status: "PAID", amount: 20, email: "b@example.com" }
    ],
    rightRows: [
      { id: 2, status: "PAID", amount: 25, email: "b@example.com" },
      { id: 3, status: "REFUND", amount: 5, email: "c@example.com" },
      { id: 4, status: "PAID", amount: 30, email: "d@example.com" }
    ],
    columns: [
      { name: "id", type: "bigint", table: "orders", schema: "biz_test" },
      { name: "status", type: "varchar(32)", table: "orders", schema: "biz_test" },
      { name: "amount", type: "decimal", table: "orders", schema: "biz_test" },
      { name: "email", type: "varchar(128)", table: "orders", schema: "biz_test", masked: true }
    ],
    keyColumns: ["id"]
  }, {});
  const comparison = JSON.parse(result.content[0].text);
  const statusDiff = comparison.valueDifferences.find((item) => item.column === "status");
  const emailDiff = comparison.valueDifferences.find((item) => item.column === "email");

  assert.equal(comparison.executed, false);
  assert.deepEqual(comparison.rowCounts, { left: 2, right: 3, delta: 1 });
  assert.equal(comparison.keyComparison.onlyInLeftCount, 1);
  assert.equal(comparison.keyComparison.onlyInRightCount, 2);
  assert.deepEqual(comparison.keyComparison.sampleOnlyInLeft, ["1"]);
  assert(statusDiff.valueDeltas.some((delta) => delta.value === "REFUND" && delta.rightCount === 1));
  assert.equal(emailDiff.masked, true);
  assert(emailDiff.valueDeltas.every((delta) => delta.value === "[masked]"));
});

function runtime(config) {
  return {
    defaultProfile: "default",
    configs: { default: config },
    pools: { default: { async query() { throw new Error("DB should not be called"); } } },
    queryLimiters: { default: { active: 0, limit: 5 } }
  };
}
