import assert from "node:assert/strict";
import test from "node:test";

import { generateQueryTemplates } from "../dist/query-generation.js";
import { assertReadOnlySql } from "../dist/sql.js";

const mysqlColumns = [
  { table_schema: "biz_test", table_name: "orders", column_name: "id", column_type: "bigint", is_nullable: "NO" },
  { table_schema: "biz_test", table_name: "orders", column_name: "user_id", column_type: "bigint", is_nullable: "NO" },
  { table_schema: "biz_test", table_name: "orders", column_name: "status", column_type: "varchar(32)", is_nullable: "YES" },
  { table_schema: "biz_test", table_name: "orders", column_name: "created_at", column_type: "datetime", is_nullable: "NO" }
];

const mysqlConstraints = [
  { table_schema: "biz_test", table_name: "orders", constraint_type: "PRIMARY KEY", column_name: "id" }
];

test("generateQueryTemplates builds MySQL read-only templates from metadata", () => {
  const result = generateQueryTemplates({
    mode: "mysql",
    schema: "biz_test",
    table: "orders",
    columns: mysqlColumns,
    constraints: mysqlConstraints,
    relationships: [{
      relationType: "foreign_key",
      direction: "outbound",
      confidence: 1,
      sourceSchema: "biz_test",
      sourceTable: "orders",
      sourceColumns: ["user_id"],
      targetSchema: "biz_test",
      targetTable: "users",
      targetColumns: ["id"],
      depth: 1,
      evidence: []
    }],
    maxColumns: 4,
    rowLimit: 20
  });

  assert(result.templates.some((template) => template.scenario === "by_primary_key"));
  assert(result.templates.some((template) => template.scenario === "time_range"));
  assert(result.templates.some((template) => template.scenario === "join"));
  for (const template of result.templates) {
    assert.doesNotThrow(() => assertReadOnlySql(template.sql));
    assert.doesNotMatch(template.sql, /SELECT\s+\*/i);
  }
});

test("generateQueryTemplates builds Oracle-compatible templates", () => {
  const result = generateQueryTemplates({
    mode: "oracle",
    schema: "OB_USER",
    table: "ORDERS",
    columns: [
      { owner: "OB_USER", table_name: "ORDERS", column_name: "ID", data_type: "NUMBER", nullable: "N" },
      { owner: "OB_USER", table_name: "ORDERS", column_name: "STATUS", data_type: "VARCHAR2", data_length: 32, nullable: "Y" },
      { owner: "OB_USER", table_name: "ORDERS", column_name: "CREATED_AT", data_type: "DATE", nullable: "N" }
    ],
    constraints: [
      { owner: "OB_USER", table_name: "ORDERS", constraint_type: "P", column_name: "ID" }
    ],
    relationships: [],
    scenarios: ["by_primary_key", "pagination", "time_range", "aggregation"],
    maxColumns: 3,
    rowLimit: 10
  });

  const sql = result.templates.map((template) => template.sql).join("\n");
  assert.match(sql, /"OB_USER"\."ORDERS"/);
  assert.match(sql, /ROWNUM <= 1|FETCH FIRST 10 ROWS ONLY/);
  for (const template of result.templates) {
    assert.doesNotThrow(() => assertReadOnlySql(template.sql));
    assert.doesNotMatch(template.sql, /SELECT\s+\*/i);
  }
});
