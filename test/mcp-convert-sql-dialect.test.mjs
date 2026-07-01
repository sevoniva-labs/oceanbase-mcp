import assert from "node:assert/strict";
import test from "node:test";

import { loadConfig } from "../dist/config.js";
import { createObMcpServer } from "../dist/mcp.js";

test("ob_convert_sql_dialect converts MySQL pagination and common functions to Oracle", async () => {
  const config = loadConfig({
    OB_ALLOWED_SCHEMAS: "biz_test"
  });
  const server = createObMcpServer(runtime(config));

  const result = await server.executeToolHandler(server._registeredTools.ob_convert_sql_dialect, {
    sourceMode: "mysql",
    targetMode: "oracle",
    sql: "SELECT `id`, IFNULL(`status`, 'N') FROM `biz_test`.`orders` WHERE `created_at` >= NOW() ORDER BY `id` LIMIT 10 OFFSET 20"
  }, {});
  const converted = JSON.parse(result.content[0].text);

  assert.equal(converted.changed, true);
  assert.equal(
    converted.convertedSql,
    'SELECT "ID", NVL("STATUS", \'N\') FROM "BIZ_TEST"."ORDERS" WHERE "CREATED_AT" >= SYSTIMESTAMP ORDER BY "ID" OFFSET 20 ROWS FETCH NEXT 10 ROWS ONLY'
  );
  assert.equal(converted.allowed, true);
  assert.equal(converted.executed, false);
});

test("ob_convert_sql_dialect converts Oracle pagination and NVL to MySQL", async () => {
  const config = loadConfig({
    OB_COMPATIBILITY: "oracle",
    OB_ALLOWED_SCHEMAS: "APP"
  });
  const server = createObMcpServer(runtime(config));

  const result = await server.executeToolHandler(server._registeredTools.ob_convert_sql_dialect, {
    sourceMode: "oracle",
    targetMode: "mysql",
    sql: 'SELECT "ID" FROM "APP"."ORDERS" WHERE "STATUS" = NVL(?, "STATUS") OFFSET 5 ROWS FETCH NEXT 10 ROWS ONLY'
  }, {});
  const converted = JSON.parse(result.content[0].text);

  assert.equal(
    converted.convertedSql,
    "SELECT `ID` FROM `APP`.`ORDERS` WHERE `STATUS` = IFNULL(?, `STATUS`) LIMIT 10 OFFSET 5"
  );
  assert.equal(converted.allowed, true);
});

test("ob_convert_sql_dialect rejects write SQL", async () => {
  const config = loadConfig({
    OB_ALLOWED_SCHEMAS: "biz_test"
  });
  const server = createObMcpServer(runtime(config));

  const result = await server.executeToolHandler(server._registeredTools.ob_convert_sql_dialect, {
    sourceMode: "mysql",
    targetMode: "oracle",
    sql: "UPDATE biz_test.orders SET status = 'x'"
  }, {});
  const converted = JSON.parse(result.content[0].text);

  assert.equal(converted.convertedSql, null);
  assert.equal(converted.changed, false);
});

function runtime(config) {
  return {
    defaultProfile: "default",
    configs: { default: config },
    pools: { default: failPool() },
    queryLimiters: { default: { active: 0, limit: 5 } }
  };
}

function failPool() {
  return {
    async query() {
      throw new Error("Database should not be queried");
    }
  };
}
