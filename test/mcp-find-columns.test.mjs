import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import { loadConfig } from "../dist/config.js";
import { createObMcpServer } from "../dist/mcp.js";

test("ob_find_columns returns MySQL columns with catalog and glossary evidence", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ob-mcp-find-columns-"));
  try {
    const glossaryFile = join(dir, "glossary.json");
    writeFileSync(glossaryFile, JSON.stringify({
      terms: [{
        term: "状态",
        aliases: ["status"],
        targets: [{ schema: "biz_test", table: "orders", column: "order_status" }]
      }]
    }));
    const config = loadConfig({
      OB_ALLOWED_SCHEMAS: "biz_test",
      OB_BUSINESS_GLOSSARY_FILE: glossaryFile
    });
    const server = createObMcpServer(runtime(config, mysqlPool()));

    const result = await server.executeToolHandler(server._registeredTools.ob_find_columns, {
      query: "status",
      schema: "biz_test",
      dataType: "varchar",
      includeGlossary: true
    }, {});
    const output = JSON.parse(result.content[0].text);
    const status = output.columns.find((column) => column.table === "orders" && column.column === "order_status");

    assert(status);
    assert.equal(status.type, "varchar(32)");
    assert.equal(status.masked, false);
    assert(status.evidence.some((item) => item.source === "catalog"));
    assert(status.evidence.some((item) => item.source === "business_glossary"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ob_find_columns returns Oracle columns", async () => {
  const config = loadConfig({
    OB_COMPATIBILITY: "oracle",
    OB_ALLOWED_SCHEMAS: "APP"
  });
  const server = createObMcpServer(runtime(config, oraclePool()));

  const result = await server.executeToolHandler(server._registeredTools.ob_find_columns, {
    query: "STATUS",
    schema: "APP",
    includeGlossary: false
  }, {});
  const output = JSON.parse(result.content[0].text);

  assert.equal(output.schema, "APP");
  assert(output.columns.some((column) => column.table === "ORDERS" && column.column === "ORDER_STATUS"));
  assert(output.columns[0].evidence.length > 0);
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
      if (/FROM information_schema\.columns/i.test(sql)) {
        return [[
          {
            table_schema: "biz_test",
            table_name: "orders",
            column_name: "order_status",
            column_type: "varchar(32)",
            data_type: "varchar",
            is_nullable: "YES",
            ordinal_position: 3,
            column_comment: "order status"
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
      if (/FROM all_tab_columns c/i.test(sql)) {
        return [[
          {
            OWNER: "APP",
            TABLE_NAME: "ORDERS",
            COLUMN_NAME: "ORDER_STATUS",
            DATA_TYPE: "VARCHAR2",
            DATA_LENGTH: 32,
            NULLABLE: "Y",
            COLUMN_ID: 3,
            COMMENTS: "order status"
          }
        ], []];
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    }
  };
}
