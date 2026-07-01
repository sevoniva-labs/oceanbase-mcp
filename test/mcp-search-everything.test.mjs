import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import { loadConfig } from "../dist/config.js";
import { createObMcpServer } from "../dist/mcp.js";

test("ob_search_everything merges MySQL catalog and business glossary evidence", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ob-mcp-search-"));
  try {
    const glossaryFile = join(dir, "glossary.json");
    writeFileSync(glossaryFile, JSON.stringify({
      terms: [{
        term: "订单",
        aliases: ["order"],
        description: "订单主表",
        targets: [{ schema: "biz_test", table: "orders" }]
      }]
    }));
    const config = loadConfig({
      OB_ALLOWED_SCHEMAS: "biz_test",
      OB_BUSINESS_GLOSSARY_FILE: glossaryFile
    });
    const server = createObMcpServer(runtime(config, mysqlPool()));

    const result = await server.executeToolHandler(server._registeredTools.ob_search_everything, {
      query: "order",
      schema: "biz_test",
      limit: 10
    }, {});
    const search = JSON.parse(result.content[0].text);

    assert.equal(search.query, "order");
    assert.equal(search.glossaryConfigured, true);
    assert(search.results.some((item) => item.type === "business_glossary" && item.term === "订单"));
    assert(search.results.some((item) => item.type === "table" && item.table === "orders"));
    assert(search.results.some((item) => item.type === "column" && item.column === "order_status"));
    assert(search.results.every((item) => typeof item.confidence === "number" && item.evidence.length > 0));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ob_search_everything returns Oracle catalog matches", async () => {
  const config = loadConfig({
    OB_COMPATIBILITY: "oracle",
    OB_ALLOWED_SCHEMAS: "APP"
  });
  const server = createObMcpServer(runtime(config, oraclePool()));

  const result = await server.executeToolHandler(server._registeredTools.ob_search_everything, {
    query: "ORDER",
    schema: "APP",
    limit: 10,
    includeGlossary: false
  }, {});
  const search = JSON.parse(result.content[0].text);

  assert.equal(search.query, "ORDER");
  assert(search.results.some((item) => item.type === "table" && item.table === "ORDERS"));
  assert(search.results.some((item) => item.type === "column" && item.column === "ORDER_STATUS"));
  assert(search.results.every((item) => item.source !== "business_glossary"));
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
      if (/SHOW DATABASES/i.test(sql)) {
        return [[{ Database: "biz_test" }], []];
      }
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
      if (/FROM all_users/i.test(sql)) {
        return [[{ USERNAME: "APP" }], []];
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
