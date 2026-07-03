import assert from "node:assert/strict";
import test from "node:test";

import { getTableDdlMetadata, listConstraints, listIndexes, listPartitions, renderStructuredTableDdl } from "../dist/db.js";

test("getTableDdlMetadata returns MySQL native DDL and structured metadata", async () => {
  const pool = {
    async query({ sql }) {
      if (sql.includes("SHOW CREATE TABLE")) {
        return [[{ "Create Table": "CREATE TABLE `biz_test`.`orders` (`id` bigint NOT NULL, PRIMARY KEY (`id`))" }], []];
      }
      if (sql.includes("information_schema.statistics")) {
        return [[
          {
            table_schema: "biz_test",
            table_name: "orders",
            index_name: "PRIMARY",
            non_unique: 0,
            seq_in_index: 1,
            column_name: "id"
          }
        ], []];
      }
      if (sql.includes("information_schema.table_constraints")) {
        return [[
          {
            table_schema: "biz_test",
            table_name: "orders",
            constraint_name: "PRIMARY",
            constraint_type: "PRIMARY KEY",
            column_name: "id"
          }
        ], []];
      }
      if (sql.includes("information_schema.columns")) {
        return [[
          {
            table_schema: "biz_test",
            table_name: "orders",
            column_name: "id",
            column_type: "bigint",
            is_nullable: "NO",
            column_default: null,
            extra: ""
          }
        ], []];
      }
      if (sql.includes("information_schema.partitions")) {
        return [[], []];
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    }
  };

  const metadata = await getTableDdlMetadata(pool, "mysql", "orders", "biz_test", 1_000);

  assert.equal(metadata.schema, "biz_test");
  assert.equal(metadata.table, "orders");
  assert.match(metadata.nativeDdl, /CREATE TABLE `biz_test`.`orders`/);
  assert.match(metadata.structuredDdl, /PRIMARY KEY/);
});

test("getTableDdlMetadata pushes MySQL column limits into catalog SQL", async () => {
  const queries = [];
  const pool = {
    async query({ sql, values = [] }) {
      queries.push({ sql, values });
      if (sql.includes("SHOW CREATE TABLE")) {
        return [[{ "Create Table": "CREATE TABLE `biz_test`.`orders` (`id` bigint NOT NULL)" }], []];
      }
      if (sql.includes("information_schema.statistics") || sql.includes("information_schema.table_constraints") || sql.includes("information_schema.partitions")) {
        return [[], []];
      }
      if (sql.includes("information_schema.columns")) {
        assert.match(sql, /LIMIT \?/i);
        assert.deepEqual(values, ["orders", "biz_test", 3]);
        return [[
          { table_schema: "biz_test", table_name: "orders", column_name: "id", column_type: "bigint", ordinal_position: 1 },
          { table_schema: "biz_test", table_name: "orders", column_name: "status", column_type: "varchar(32)", ordinal_position: 2 },
          { table_schema: "biz_test", table_name: "orders", column_name: "note", column_type: "varchar(64)", ordinal_position: 3 }
        ], []];
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    }
  };

  const metadata = await getTableDdlMetadata(pool, "mysql", "orders", "biz_test", 1_000, 2);

  assert.equal(metadata.columns.length, 2);
  assert.equal(metadata.columnsTruncated, true);
  assert(metadata.warnings.some((warning) => /limited to 2 column/.test(warning)));
  assert(queries.some((query) => /LIMIT \?/i.test(query.sql)));
});

test("getTableDdlMetadata bounds MySQL index constraint and partition metadata", async () => {
  const queries = [];
  const pool = {
    async query({ sql, values = [] }) {
      queries.push({ sql, values });
      if (sql.includes("SHOW CREATE TABLE")) {
        return [[{ "Create Table": "CREATE TABLE `biz_test`.`orders` (`id` bigint NOT NULL)" }], []];
      }
      if (sql.includes("information_schema.statistics")) {
        assert.match(sql, /LIMIT \?/i);
        assert.equal(values.at(-1), 3);
        return [[
          { table_schema: "biz_test", table_name: "orders", index_name: "idx_1", non_unique: 1, seq_in_index: 1, column_name: "c1" },
          { table_schema: "biz_test", table_name: "orders", index_name: "idx_2", non_unique: 1, seq_in_index: 1, column_name: "c2" },
          { table_schema: "biz_test", table_name: "orders", index_name: "idx_3", non_unique: 1, seq_in_index: 1, column_name: "c3" }
        ], []];
      }
      if (sql.includes("information_schema.table_constraints")) {
        assert.match(sql, /LIMIT \?/i);
        assert.equal(values.at(-1), 3);
        return [[
          { table_schema: "biz_test", table_name: "orders", constraint_name: "ck_1", constraint_type: "CHECK", column_name: "c1" },
          { table_schema: "biz_test", table_name: "orders", constraint_name: "ck_2", constraint_type: "CHECK", column_name: "c2" },
          { table_schema: "biz_test", table_name: "orders", constraint_name: "ck_3", constraint_type: "CHECK", column_name: "c3" }
        ], []];
      }
      if (sql.includes("information_schema.columns")) {
        return [[
          { table_schema: "biz_test", table_name: "orders", column_name: "id", column_type: "bigint", ordinal_position: 1 }
        ], []];
      }
      if (sql.includes("information_schema.partitions")) {
        assert.match(sql, /LIMIT \?/i);
        assert.equal(values.at(-1), 3);
        return [[
          { table_schema: "biz_test", table_name: "orders", partition_name: "p1", partition_method: "RANGE" },
          { table_schema: "biz_test", table_name: "orders", partition_name: "p2", partition_method: "RANGE" },
          { table_schema: "biz_test", table_name: "orders", partition_name: "p3", partition_method: "RANGE" }
        ], []];
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    }
  };

  const metadata = await getTableDdlMetadata(pool, "mysql", "orders", "biz_test", 1_000, 10, 2);

  assert.equal(metadata.indexes.length, 2);
  assert.equal(metadata.indexesTruncated, true);
  assert.equal(metadata.constraints.length, 2);
  assert.equal(metadata.constraintsTruncated, true);
  assert.equal(metadata.partitions.length, 2);
  assert.equal(metadata.partitionsTruncated, true);
  assert(metadata.warnings.some((warning) => /Index metadata was limited to 2 row/.test(warning)));
  assert(metadata.warnings.some((warning) => /Constraint metadata was limited to 2 row/.test(warning)));
  assert(metadata.warnings.some((warning) => /Partition metadata was limited to 2 row/.test(warning)));
  assert.equal(queries.filter((query) => /LIMIT \?/i.test(query.sql)).length >= 4, true);
});

test("Oracle table metadata list functions push row limits into catalog SQL", async () => {
  const checked = new Set();
  const pool = {
    async query({ sql, values = [] }) {
      if (sql.includes("FROM DUAL")) {
        return [[{ SCHEMA_NAME: "OTHER" }], []];
      }
      if (sql.includes("all_indexes")) {
        checked.add("indexes");
        assert.match(sql, /ROWNUM <= \?/i);
        assert.equal(values.at(-1), 4);
        return [[], []];
      }
      if (sql.includes("all_constraints")) {
        checked.add("constraints");
        assert.match(sql, /ROWNUM <= \?/i);
        assert.equal(values.at(-1), 5);
        return [[], []];
      }
      if (sql.includes("all_tab_partitions")) {
        checked.add("partitions");
        assert.match(sql, /ROWNUM <= \?/i);
        assert.equal(values.at(-1), 6);
        return [[], []];
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    }
  };

  await listIndexes(pool, "oracle", "ORDERS", "APP", 1_000, 4);
  await listConstraints(pool, "oracle", "ORDERS", "APP", 1_000, 5);
  await listPartitions(pool, "oracle", "ORDERS", "APP", 1_000, 6);

  assert.deepEqual([...checked].sort(), ["constraints", "indexes", "partitions"]);
});

test("renderStructuredTableDdl renders Oracle-compatible table metadata", () => {
  const ddl = renderStructuredTableDdl(
    "oracle",
    "OB_USER",
    "ORDERS",
    [
      {
        owner: "OB_USER",
        table_name: "ORDERS",
        column_name: "ID",
        data_type: "NUMBER",
        data_precision: 20,
        data_scale: 0,
        nullable: "N"
      },
      {
        owner: "OB_USER",
        table_name: "ORDERS",
        column_name: "STATUS",
        data_type: "VARCHAR2",
        data_length: 32,
        data_default: "'NEW'",
        nullable: "Y"
      }
    ],
    [],
    [
      {
        owner: "OB_USER",
        table_name: "ORDERS",
        constraint_name: "PK_ORDERS",
        constraint_type: "P",
        column_name: "ID"
      }
    ],
    []
  );

  assert.match(ddl, /CREATE TABLE "OB_USER"."ORDERS"/);
  assert.match(ddl, /"ID" NUMBER\(20,0\) NOT NULL/);
  assert.match(ddl, /"STATUS" VARCHAR2\(32\) DEFAULT 'NEW'/);
  assert.match(ddl, /CONSTRAINT "PK_ORDERS" PRIMARY KEY \("ID"\)/);
});
