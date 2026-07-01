import assert from "node:assert/strict";
import test from "node:test";

import { loadConfig } from "../dist/config.js";
import { createObMcpServer } from "../dist/mcp.js";

test("ob_export_result_preview renders a masked markdown preview without querying the database", async () => {
  const config = loadConfig({
    OB_ALLOWED_SCHEMAS: "biz_test",
    OB_MASKED_COLUMNS: "biz_test.orders.phone",
    OB_ENFORCE_READ_ONLY_TX: "false"
  });
  const server = createObMcpServer(runtime(config));

  const result = await server.executeToolHandler(server._registeredTools.ob_export_result_preview, {
    rows: [
      { id: 1, status: "PAID", phone: "13800000000" },
      { id: 2, status: "NEW", phone: "13900000000" }
    ],
    columns: [
      { name: "id", type: "bigint", table: "orders", schema: "biz_test" },
      { name: "status", type: "varchar(32)", table: "orders", schema: "biz_test" },
      { name: "phone", type: "varchar(32)", table: "orders", schema: "biz_test", masked: true }
    ],
    format: "markdown",
    maxRows: 1
  }, {});
  const preview = JSON.parse(result.content[0].text);

  assert.equal(preview.executed, false);
  assert.equal(preview.format, "markdown");
  assert.equal(preview.rowCount, 2);
  assert.equal(preview.returnedRows, 1);
  assert.match(preview.text, /\| id \| status \| phone \|/);
  assert.match(preview.text, /\*\*\*MASKED\*\*\*/);
  assert.doesNotMatch(preview.text, /13800000000/);
  assert(preview.warnings.some((warning) => /Masked preview columns: phone/.test(warning)));
  assert(preview.warnings.some((warning) => /limited to 1 of 2 rows/.test(warning)));
});

test("ob_export_result_preview renders csv with escaping and masking", async () => {
  const config = loadConfig({
    OB_ALLOWED_SCHEMAS: "biz_test",
    OB_MASKED_COLUMNS: "biz_test.orders.phone",
    OB_ENFORCE_READ_ONLY_TX: "false"
  });
  const server = createObMcpServer(runtime(config));

  const result = await server.executeToolHandler(server._registeredTools.ob_export_result_preview, {
    rows: [
      { id: 1, status: "PAID,OK", note: "hello \"quoted\"", phone: "13800000000" }
    ],
    columns: [
      { name: "id", type: "bigint", table: "orders", schema: "biz_test" },
      { name: "status", type: "varchar(32)", table: "orders", schema: "biz_test" },
      { name: "note", type: "varchar(64)", table: "orders", schema: "biz_test" },
      { name: "phone", type: "varchar(32)", table: "orders", schema: "biz_test", masked: true }
    ],
    format: "csv"
  }, {});
  const preview = JSON.parse(result.content[0].text);

  assert.equal(preview.format, "csv");
  assert.equal(preview.text.split("\n")[0], "id,status,note,phone");
  assert.match(preview.text, /"PAID,OK"/);
  assert.match(preview.text, /"hello ""quoted"""/);
  assert.match(preview.text, /\*\*\*MASKED\*\*\*/);
  assert.doesNotMatch(preview.text, /13800000000/);
});

function runtime(config) {
  return {
    defaultProfile: "default",
    configs: { default: config },
    pools: { default: { async query() { throw new Error("DB should not be called"); } } },
    queryLimiters: { default: { active: 0, limit: 5 } }
  };
}
