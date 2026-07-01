import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import { loadConfig } from "../dist/config.js";
import { createObMcpServer } from "../dist/mcp.js";

test("business glossary search filters targets through the active access policy", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ob-mcp-test-"));
  try {
    const glossaryFile = join(dir, "glossary.json");
    writeFileSync(glossaryFile, JSON.stringify({
      terms: [
        {
          term: "订单",
          aliases: ["order"],
          description: "订单主表和明细表",
          targets: [
            { schema: "biz_test", table: "orders" },
            { schema: "biz_test", table: "order_items" }
          ]
        },
        {
          term: "支付",
          aliases: ["payment"],
          targets: [
            { schema: "biz_test", table: "payments" },
            { schema: "biz_test", table: "transactions" }
          ]
        },
        {
          term: "密钥",
          aliases: ["token"],
          targets: [
            { schema: "biz_test", table: "users", column: "secret_token" }
          ]
        }
      ]
    }));
    const config = loadConfig({
      OB_ALLOWED_SCHEMAS: "biz_test",
      OB_DENIED_TABLES: "payments",
      OB_DENIED_COLUMNS: "secret_token",
      OB_BUSINESS_GLOSSARY_FILE: glossaryFile
    });
    const server = createObMcpServer(runtime(config));

    const orders = JSON.parse((await server.executeToolHandler(server._registeredTools.ob_search_business_glossary, {
      query: "订单",
      limit: 10
    }, {})).content[0].text);
    assert.equal(orders.configured, true);
    assert.equal(orders.matches.length, 1);
    assert.deepEqual(orders.matches[0].targets.map((target) => target.table), ["orders", "order_items"]);

    const payments = JSON.parse((await server.executeToolHandler(server._registeredTools.ob_search_business_glossary, {
      query: "支付",
      limit: 10
    }, {})).content[0].text);
    assert.equal(payments.matches.length, 1);
    assert.deepEqual(payments.matches[0].targets.map((target) => target.table), ["transactions"]);
    assert.equal(payments.policyFiltered, true);

    const hidden = JSON.parse((await server.executeToolHandler(server._registeredTools.ob_search_business_glossary, {
      query: "密钥",
      limit: 10
    }, {})).content[0].text);
    assert.equal(hidden.matches.length, 0);
    assert.equal(hidden.policyFiltered, true);

    const catalog = JSON.parse((await server.executeToolHandler(server._registeredTools.ob_search_catalog, {
      query: "订单",
      schema: "biz_test",
      limit: 10
    }, {})).content[0].text);
    assert.equal(catalog[0].match_type, "business_glossary");
    assert.equal(catalog[0].term, "订单");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function runtime(config) {
  return {
    defaultProfile: "default",
    configs: { default: config },
    pools: {
      default: {
        async query() {
          return [[], []];
        }
      }
    },
    queryLimiters: { default: { active: 0, limit: 5 } }
  };
}
