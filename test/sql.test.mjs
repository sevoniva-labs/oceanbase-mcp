import assert from "node:assert/strict";
import test from "node:test";

import {
  assertReadOnlySql,
  assertSingleStatement,
  assertSqlInputLimits,
  buildExplainSql,
  buildPagedReadOnlySql,
  prepareReadOnlySql
} from "../dist/sql.js";

test("assertReadOnlySql allows common read-only statements", () => {
  assert.doesNotThrow(() => assertReadOnlySql("SELECT ';' AS semi;"));
  assert.doesNotThrow(() => assertReadOnlySql("WITH c AS (SELECT 1) SELECT * FROM c"));
  assert.doesNotThrow(() => assertReadOnlySql("EXPLAIN SELECT 1"));
  assert.doesNotThrow(() => assertReadOnlySql("EXPLAIN FORMAT=JSON SELECT 1"));
});

test("assertReadOnlySql rejects multi-statement and write SQL", () => {
  assert.throws(() => assertReadOnlySql("SELECT 1; SELECT 2"), /Multiple SQL statements/);
  assert.throws(() => assertReadOnlySql("DROP TABLE demo"), /this MCP server has no write execution tool/);
  assert.throws(() => assertReadOnlySql("SHOW DATABASES"), /Only read-only SQL/);
  assert.throws(() => assertReadOnlySql("SHOW TABLES FROM mysql"), /Only read-only SQL/);
  assert.throws(() => assertReadOnlySql("DESCRIBE demo"), /Only read-only SQL/);
  assert.throws(() => assertReadOnlySql("EXPLAIN UPDATE biz_test.ob_sample SET name = 'x'"), /EXPLAIN is allowed only/);
  assert.throws(() => assertReadOnlySql("EXPLAIN PLAN FOR SELECT 1"), /EXPLAIN is allowed only/);
  assert.throws(
    () => assertReadOnlySql("SELECT 0 AS id /*!50000 UNION ALL SELECT password FROM mysql.user */"),
    /executable comments/
  );
  assert.throws(() => assertReadOnlySql("WITH c AS (SELECT 1) DELETE FROM demo"), /write\/control keyword/);
});

test("assertReadOnlySql rejects side-effect patterns", () => {
  assert.throws(() => assertReadOnlySql("SELECT LOAD_FILE('/etc/passwd')"), /blocked side-effect/);
  assert.throws(() => assertReadOnlySql("SELECT SLEEP(10)"), /blocked side-effect/);
  assert.throws(() => assertReadOnlySql("SELECT seq.NEXTVAL FROM DUAL"), /blocked side-effect/);
  assert.throws(() => assertReadOnlySql("SELECT id INTO @captured FROM biz_test.orders"), /blocked side-effect/);
  assert.throws(() => assertReadOnlySql("SELECT id INTO captured_id FROM biz_test.orders"), /blocked side-effect/);
});

test("assertSingleStatement allows semicolons inside strings", () => {
  assert.doesNotThrow(() => assertSingleStatement("SELECT 'a;b;c' AS value;"));
  assert.throws(() => assertSingleStatement("SELECT 'ok'; SELECT 'no'"), /Multiple SQL statements/);
});

test("assertSqlInputLimits enforces configured request limits", () => {
  assert.doesNotThrow(() => assertSqlInputLimits("SELECT ?", [1], { maxSqlLength: 20, maxParamCount: 1 }));
  assert.throws(() => assertSqlInputLimits("SELECT 123456", [], { maxSqlLength: 5, maxParamCount: 1 }), /SQL length/);
  assert.throws(() => assertSqlInputLimits("SELECT ?, ?", [1, 2], { maxSqlLength: 20, maxParamCount: 1 }), /parameter count/);
});

test("prepareReadOnlySql adds conservative row caps to SELECT statements", () => {
  assert.equal(prepareReadOnlySql("SELECT 1", 100, "mysql"), "SELECT * FROM (SELECT 1) AS ob_mcp_limited LIMIT 101");
  assert.equal(
    prepareReadOnlySql("SELECT 1 LIMIT 5", 100, "mysql"),
    "SELECT * FROM (SELECT 1 LIMIT 5) AS ob_mcp_limited LIMIT 101"
  );
  assert.match(
    prepareReadOnlySql("SELECT 1 AS ok FROM DUAL FETCH FIRST 10000 ROWS ONLY", 100, "oracle"),
    /^SELECT \* FROM \(SELECT 1 AS ok FROM DUAL FETCH FIRST 10000 ROWS ONLY\) WHERE ROWNUM <= 101$/
  );
});

test("buildExplainSql normalizes trailing semicolons", () => {
  assert.equal(buildExplainSql("SELECT 1;"), "EXPLAIN SELECT 1");
  assert.equal(buildExplainSql("EXPLAIN SELECT 1;"), "EXPLAIN SELECT 1");
});

test("buildPagedReadOnlySql appends dialect-specific pagination", () => {
  assert.equal(
    buildPagedReadOnlySql("SELECT id FROM biz_test.orders", "mysql", {
      page: 2,
      pageSize: 10,
      fetchRows: 11,
      orderBy: "id DESC"
    }),
    "SELECT id FROM biz_test.orders ORDER BY id DESC LIMIT 11 OFFSET 10"
  );
  assert.equal(
    buildPagedReadOnlySql("SELECT ID FROM OB_USER.ORDERS ORDER BY ID", "oracle", {
      page: 3,
      pageSize: 5,
      fetchRows: 6
    }),
    "SELECT ID FROM OB_USER.ORDERS ORDER BY ID OFFSET 10 ROWS FETCH NEXT 6 ROWS ONLY"
  );
  assert.throws(
    () => buildPagedReadOnlySql("SELECT id FROM biz_test.orders LIMIT 10", "mysql", { page: 1, pageSize: 5, fetchRows: 6 }),
    /must not already contain/
  );
  assert.throws(
    () => buildPagedReadOnlySql("SELECT id FROM biz_test.orders", "mysql", { page: 1, pageSize: 5, fetchRows: 6, orderBy: "SLEEP(1)" }),
    /orderBy must contain/
  );
});
