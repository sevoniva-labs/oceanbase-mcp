import assert from "node:assert/strict";
import test from "node:test";

import {
  assertObjectAccess,
  assertOutputAllowed,
  assertSqlPolicy,
  explainSqlPolicy,
  filterColumnMetadata,
  filterObjects,
  filterSchemas
} from "../dist/policy.js";

const basePolicy = {
  allowedSchemas: ["biz_test"],
  allowedTables: [],
  deniedSchemas: ["information_schema", "mysql", "oceanbase", "performance_schema", "sys"],
  deniedTables: [],
  deniedColumns: ["password", "token", "secret"],
  allowSelectStar: false,
  includeSystemSchemas: false,
  requireAccessPolicy: true
};

const context = {
  compatibility: "mysql",
  defaultSchema: undefined,
  policy: basePolicy
};

test("assertSqlPolicy allows references inside allowed schemas", () => {
  assert.doesNotThrow(() => assertSqlPolicy("SELECT id, name FROM biz_test.ob_sample", context));
  assert.doesNotThrow(() => assertSqlPolicy('SELECT id FROM "BIZ_TEST"."OB_SAMPLE"', context));
});

test("assertSqlPolicy rejects references outside allowed schemas", () => {
  assert.throws(() => assertSqlPolicy("SELECT id FROM mysql.user", context), /not allowed/);
  assert.throws(() => assertSqlPolicy("SELECT User FROM (mysql.user)", context), /not allowed/);
  assert.throws(() => assertSqlPolicy("SELECT a.id FROM biz_test.ob_sample a, (mysql.user) u", context), /not allowed/);
  assert.throws(() => assertSqlPolicy("SELECT id FROM other_schema.orders", context), /not allowed/);
  assert.throws(() => assertSqlPolicy('SELECT id FROM "OTHER_SCHEMA"."ORDERS"', context), /not allowed/);
  assert.throws(() => assertSqlPolicy("SELECT a.id FROM biz_test.ob_sample a, mysql.user u", context), /not allowed/);
  assert.throws(
    () => assertSqlPolicy("WITH u AS (SELECT User FROM mysql.user) SELECT User FROM u", context),
    /not allowed/
  );
  assert.throws(
    () => assertSqlPolicy("SELECT id FROM biz_test.ob_sample UNION ALL SELECT User FROM mysql.user", context),
    /not allowed/
  );
});

test("assertSqlPolicy rejects unqualified tables when schema policy is ambiguous", () => {
  const ambiguous = {
    ...context,
    policy: {
      ...basePolicy,
      allowedSchemas: ["biz_test", "analytics"]
    }
  };
  assert.throws(() => assertSqlPolicy("SELECT id FROM ob_sample", ambiguous), /Unqualified table reference/);
});

test("assertSqlPolicy rejects SELECT star and sensitive identifiers", () => {
  assert.throws(() => assertSqlPolicy("SELECT * FROM biz_test.ob_sample", context), /SELECT \*/);
  assert.throws(() => assertSqlPolicy("SELECT t.* FROM biz_test.ob_sample t", context), /SELECT \*/);
  assert.throws(() => assertSqlPolicy("SELECT DISTINCTROW * FROM biz_test.ob_sample", context), /SELECT \*/);
  assert.throws(() => assertSqlPolicy("SELECT HIGH_PRIORITY SQL_SMALL_RESULT * FROM biz_test.ob_sample", context), /SELECT \*/);
  assert.throws(() => assertSqlPolicy('SELECT "t".* FROM biz_test.ob_sample "t"', context), /SELECT \*/);
  assert.throws(() => assertSqlPolicy("SELECT `t`.* FROM biz_test.ob_sample `t`", context), /SELECT \*/);
  assert.throws(() => assertSqlPolicy("SELECT user_id, password FROM biz_test.users", context), /OB_DENIED_COLUMNS/);
  assert.throws(() => assertSqlPolicy('SELECT "PASSWORD" FROM "BIZ_TEST"."USERS"', context), /OB_DENIED_COLUMNS/);
});

test("assertSqlPolicy applies denied column globs to identifiers before aliasing", () => {
  const globContext = {
    ...context,
    policy: {
      ...basePolicy,
      deniedColumns: ["*_token"]
    }
  };

  assert.throws(() => assertSqlPolicy("SELECT api_token AS value FROM biz_test.users", globContext), /OB_DENIED_COLUMNS/);
  assert.throws(() => assertSqlPolicy('SELECT "API_TOKEN" AS value FROM "BIZ_TEST"."USERS"', globContext), /OB_DENIED_COLUMNS/);
});

test("assertOutputAllowed rejects sensitive result fields before returning data", () => {
  assert.throws(
    () =>
      assertOutputAllowed(
        {
          rowCount: 1,
          rows: [{ password: "not returned" }],
          truncated: false,
          fields: [{ name: "password" }]
        },
        basePolicy
      ),
    /blocked/
  );
});

test("filterSchemas hides denied schemas by default", () => {
  assert.deepEqual(
    filterSchemas([{ Database: "biz_test" }, { Database: "mysql" }, { Database: "information_schema" }], basePolicy),
    [{ Database: "biz_test" }]
  );
});

test("filterColumnMetadata hides referenced denied columns", () => {
  assert.deepEqual(
    filterColumnMetadata(
      [
        { table_schema: "biz_test", table_name: "orders", column_name: "user_id", referenced_column_name: "id" },
        { table_schema: "biz_test", table_name: "orders", column_name: "secret_id", referenced_column_name: "secret" }
      ],
      basePolicy
    ),
    [{ table_schema: "biz_test", table_name: "orders", column_name: "user_id", referenced_column_name: "id" }]
  );
});

test("object policy uses schema and object name allow rules", () => {
  assert.doesNotThrow(() => assertObjectAccess("biz_test", "orders_view", context));
  assert.throws(() => assertObjectAccess("other_schema", "orders_view", context), /Object reference/);
  assert.deepEqual(
    filterObjects(
      [
        { OWNER: "biz_test", OBJECT_NAME: "orders_view", OBJECT_TYPE: "VIEW" },
        { OWNER: "other_schema", OBJECT_NAME: "orders_view", OBJECT_TYPE: "VIEW" }
      ],
      basePolicy
    ),
    [{ OWNER: "biz_test", OBJECT_NAME: "orders_view", OBJECT_TYPE: "VIEW" }]
  );
});

test("filterTables recognizes Oracle table owner metadata columns", async () => {
  const { filterTables } = await import("../dist/policy.js");
  assert.deepEqual(
    filterTables(
      [
        { TABLE_OWNER: "BIZ_TEST", TABLE_NAME: "OB_SAMPLE", PARTITION_NAME: "P0" },
        { TABLE_OWNER: "OTHER_SCHEMA", TABLE_NAME: "OB_SAMPLE", PARTITION_NAME: "P0" }
      ],
      basePolicy
    ),
    [{ TABLE_OWNER: "BIZ_TEST", TABLE_NAME: "OB_SAMPLE", PARTITION_NAME: "P0" }]
  );
});

test("explainSqlPolicy returns structured policy checks", () => {
  const allowed = explainSqlPolicy("SELECT id, name FROM biz_test.ob_sample", context);
  assert.equal(allowed.allowed, true);
  assert(allowed.checks.every((check) => check.ok));

  const denied = explainSqlPolicy("SELECT User FROM (mysql.user)", context);
  assert.equal(denied.allowed, false);
  assert(denied.checks.some((check) => check.name.includes("mysql.user") && !check.ok));
});
