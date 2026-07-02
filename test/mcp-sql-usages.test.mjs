import assert from "node:assert/strict";
import test from "node:test";

import { loadConfig } from "../dist/config.js";
import { createObMcpServer } from "../dist/mcp.js";

test("ob_find_sql_usages searches static SQL usage index", async () => {
  const config = loadConfig({ OB_ALLOWED_SCHEMAS: "biz" });
  const server = createObMcpServer({
    defaultProfile: "default",
    configs: { default: config },
    pools: { default: { async query() { throw new Error("database should not be used"); } } },
    queryLimiters: { default: { active: 0, limit: 5 } },
    metadataCaches: { default: { entries: new Map(), hits: 0, misses: 0, evictions: 0 } }
  });

  const result = await server.executeToolHandler(server._registeredTools.ob_find_sql_usages, {
    sqlIndex: JSON.stringify(sampleIndex()),
    schema: "biz",
    table: "orders",
    column: "status"
  }, {});
  const output = JSON.parse(result.content[0].text);

  assert.equal(output.executed, false);
  assert.equal(output.matchCount, 1);
  assert.equal(output.results[0].file, "mapper/OrderMapper.xml");
  assert(output.results[0].evidence.some((item) => item.includes("orders")));
});

function sampleIndex() {
  return {
    indexVersion: "1.1",
    generatedAt: "2026-07-01T00:00:00.000Z",
    root: "/repo",
    scannedFiles: 1,
    skippedFiles: 0,
    snippetCount: 1,
    entries: [{
      file: "mapper/OrderMapper.xml",
      line: 12,
      sql: "SELECT id, status FROM biz.orders WHERE status = #{status}",
      statementType: "select",
      tables: ["biz.orders"],
      columns: ["id", "status"],
      dynamicSql: { detected: true, sources: ["mybatis_parameter"] },
      risks: ["missing_pagination"],
      dialectHints: []
    }],
    warnings: [],
    limits: {
      maxFiles: 100,
      maxBytes: 1024,
      extensions: [".xml"],
      ignore: []
    }
  };
}
