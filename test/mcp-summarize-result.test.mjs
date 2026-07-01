import assert from "node:assert/strict";
import test from "node:test";

import { loadConfig } from "../dist/config.js";
import { createObMcpServer } from "../dist/mcp.js";

test("ob_summarize_result summarizes returned rows without querying the database", async () => {
  const config = loadConfig({
    OB_ALLOWED_SCHEMAS: "biz_test",
    OB_MASKED_COLUMNS: "biz_test.orders.phone",
    OB_ENFORCE_READ_ONLY_TX: "false"
  });
  const server = createObMcpServer(runtime(config));

  const result = await server.executeToolHandler(server._registeredTools.ob_summarize_result, {
    rows: [
      { id: 1, status: "PAID", amount: 10, created_at: "2026-01-01T00:00:00Z", phone: "13800000000" },
      { id: 2, status: "NEW", amount: 20, created_at: "2026-01-02T00:00:00Z", phone: "13900000000" },
      { id: 3, status: "PAID", amount: null, created_at: "2026-01-03T00:00:00Z", phone: "13700000000" }
    ],
    columns: [
      { name: "id", type: "bigint", table: "orders", schema: "biz_test" },
      { name: "status", type: "varchar(32)", table: "orders", schema: "biz_test" },
      { name: "amount", type: "decimal", table: "orders", schema: "biz_test" },
      { name: "created_at", type: "datetime", table: "orders", schema: "biz_test" },
      { name: "phone", type: "varchar(32)", table: "orders", schema: "biz_test", masked: true }
    ]
  }, {});
  const summary = JSON.parse(result.content[0].text);
  const status = summary.columns.find((column) => column.name === "status");
  const amount = summary.columns.find((column) => column.name === "amount");
  const createdAt = summary.columns.find((column) => column.name === "created_at");
  const phone = summary.columns.find((column) => column.name === "phone");

  assert.equal(summary.executed, false);
  assert.equal(summary.rowCount, 3);
  assert.equal(status.distinct.count, 2);
  assert.deepEqual(status.topValues[0], { value: "PAID", count: 2, ratio: 2 / 3 });
  assert.equal(amount.nulls.count, 1);
  assert.deepEqual(amount.numericRange, { min: 10, max: 20 });
  assert.equal(createdAt.timeRange.min, "2026-01-01T00:00:00.000Z");
  assert.equal(createdAt.timeRange.max, "2026-01-03T00:00:00.000Z");
  assert.equal(phone.masked, true);
  assert.deepEqual(phone.topValues, []);
  assert(summary.nextSteps.some((step) => /Masked columns/.test(step)));
});

function runtime(config) {
  return {
    defaultProfile: "default",
    configs: { default: config },
    pools: { default: { async query() { throw new Error("DB should not be called"); } } },
    queryLimiters: { default: { active: 0, limit: 5 } }
  };
}
