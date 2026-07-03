import assert from "node:assert/strict";
import test from "node:test";

import {
  currentMysqlSchema,
  currentOracleSchema,
  isCurrentOracleSchema,
  qualifiedTableName,
  quoteIdentifier
} from "../dist/db/schema-context.js";

test("schema context quotes MySQL and Oracle identifiers", () => {
  assert.equal(quoteIdentifier("mysql", "order`items"), "`order``items`");
  assert.equal(quoteIdentifier("oracle", 'ORDER"ITEMS'), '"ORDER""ITEMS"');
  assert.equal(qualifiedTableName("mysql", "biz_test", "orders"), "`biz_test`.`orders`");
  assert.equal(qualifiedTableName("oracle", "app", "orders"), '"APP"."ORDERS"');
});

test("schema context reads current schemas from bounded metadata queries", async () => {
  const mysqlCalls = [];
  const mysqlPool = {
    async query(options) {
      mysqlCalls.push(options);
      return [[{ schema_name: "biz_test" }], []];
    }
  };
  assert.equal(await currentMysqlSchema(mysqlPool, 5000), "biz_test");
  assert.deepEqual(mysqlCalls, [{ sql: "SELECT DATABASE() AS schema_name", timeout: 5000 }]);

  const oraclePool = {
    async query(options) {
      assert.match(options.sql, /USER AS schema_name FROM DUAL/);
      assert.equal(options.timeout, 5000);
      return [[{ SCHEMA_NAME: "app" }], []];
    }
  };
  assert.equal(await currentOracleSchema(oraclePool, 5000), "APP");
  assert.equal(await isCurrentOracleSchema(oraclePool, "app", 5000), true);
});
