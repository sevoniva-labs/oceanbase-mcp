import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import { loadConfig } from "../dist/config.js";
import { createObMcpServer } from "../dist/mcp.js";

test("ob_find_tables_by_business_term returns MySQL table candidates with evidence", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ob-mcp-business-term-"));
  try {
    const glossaryFile = join(dir, "glossary.json");
    writeFileSync(glossaryFile, JSON.stringify({
      terms: [{
        term: "订单",
        aliases: ["order"],
        targets: [{ schema: "biz_test", table: "orders" }]
      }]
    }));
    const config = loadConfig({
      OB_ALLOWED_SCHEMAS: "biz_test",
      OB_BUSINESS_GLOSSARY_FILE: glossaryFile
    });
    const server = createObMcpServer(runtime(config, mysqlPool()));

    const result = await server.executeToolHandler(server._registeredTools.ob_find_tables_by_business_term, {
      term: "order",
      schema: "biz_test",
      includeRelated: false
    }, {});
    const output = JSON.parse(result.content[0].text);
    const orders = output.candidates.find((candidate) => candidate.table === "orders");

    assert.equal(output.glossaryConfigured, true);
    assert(orders);
    assert(orders.sources.includes("business_glossary"));
    assert(orders.sources.includes("catalog"));
    assert(orders.matchedColumns.includes("order_status"));
    assert(orders.evidence.length > 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ob_find_tables_by_business_term returns Oracle table candidates", async () => {
  const config = loadConfig({
    OB_COMPATIBILITY: "oracle",
    OB_ALLOWED_SCHEMAS: "APP"
  });
  const server = createObMcpServer(runtime(config, oraclePool()));

  const result = await server.executeToolHandler(server._registeredTools.ob_find_tables_by_business_term, {
    term: "ORDER",
    schema: "APP",
    includeRelated: false
  }, {});
  const output = JSON.parse(result.content[0].text);

  assert.equal(output.term, "ORDER");
  assert(output.candidates.some((candidate) => candidate.schema === "APP" && candidate.table === "ORDERS"));
  assert(output.candidates[0].evidence.some((item) => item.field === "table" || item.field === "column"));
});

function runtime(config, pool) {
  return {
    defaultProfile: "default",
    configs: { default: config },
    pools: { default: pool },
    queryLimiters: { default: { active: 0, limit: 5 } }
  };
}

function mysqlPool() {
  return {
    async query({ sql }) {
      if (/catalog_matches/i.test(sql)) {
        return [[
          {
            match_type: "table",
            table_schema: "biz_test",
            table_name: "orders",
            column_name: null,
            comment_text: "orders table"
          },
          {
            match_type: "column",
            table_schema: "biz_test",
            table_name: "orders",
            column_name: "order_status",
            comment_text: "order status"
          }
        ], []];
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    }
  };
}

function oraclePool() {
  return {
    async query({ sql }) {
      if (/USER AS schema_name FROM DUAL/i.test(sql)) {
        return [[{ SCHEMA_NAME: "APP" }], []];
      }
      if (/(FROM all_tables|FROM user_tables)/i.test(sql) && /UNION ALL/i.test(sql)) {
        return [[
          {
            MATCH_TYPE: "table",
            OWNER: "APP",
            TABLE_NAME: "ORDERS",
            COLUMN_NAME: null,
            COMMENT_TEXT: null
          },
          {
            MATCH_TYPE: "column",
            OWNER: "APP",
            TABLE_NAME: "ORDERS",
            COLUMN_NAME: "ORDER_STATUS",
            COMMENT_TEXT: null
          }
        ], []];
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    }
  };
}
