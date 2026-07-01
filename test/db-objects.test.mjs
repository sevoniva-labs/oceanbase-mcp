import assert from "node:assert/strict";
import test from "node:test";

import { getObjectMetadata, listObjects, normalizeOracleObjectType } from "../dist/db.js";

test("normalizeOracleObjectType accepts snake case package body", () => {
  assert.equal(normalizeOracleObjectType("package_body"), "PACKAGE BODY");
  assert.throws(() => normalizeOracleObjectType("trigger"), /Unsupported Oracle object type/);
});

test("listObjects returns Oracle object metadata from all_objects", async () => {
  const pool = {
    async query({ sql, values }) {
      assert.match(sql, /FROM all_objects/);
      assert.deepEqual(values.slice(0, 4), ["OB_USER", "OB_USER", "VIEW", "PACKAGE BODY"]);
      return [[
        {
          owner: "OB_USER",
          object_name: "ORDERS_V",
          object_type: "VIEW",
          status: "VALID"
        }
      ], []];
    }
  };

  const result = await listObjects(pool, "oracle", "OB_USER", "ORDERS", ["view", "package_body"], 10, 1_000);

  assert.equal(result.schema, "OB_USER");
  assert.deepEqual(result.objectTypes, ["VIEW", "PACKAGE BODY"]);
  assert.equal(result.objects.length, 1);
});

test("getObjectMetadata returns Oracle procedure arguments and source preview", async () => {
  const pool = {
    async query({ sql }) {
      if (sql.includes("FROM all_objects")) {
        return [[
          {
            owner: "OB_USER",
            object_name: "DO_WORK",
            object_type: "PROCEDURE",
            status: "VALID"
          }
        ], []];
      }
      if (sql.includes("FROM all_arguments")) {
        return [[
          {
            owner: "OB_USER",
            object_name: "DO_WORK",
            argument_name: "P_ID",
            position: 1,
            data_type: "NUMBER",
            in_out: "IN"
          }
        ], []];
      }
      if (sql.includes("FROM all_source")) {
        return [[
          { owner: "OB_USER", name: "DO_WORK", type: "PROCEDURE", line: 1, text: "PROCEDURE do_work(p_id IN NUMBER) IS\n" },
          { owner: "OB_USER", name: "DO_WORK", type: "PROCEDURE", line: 2, text: "BEGIN NULL; END;\n" }
        ], []];
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    }
  };

  const metadata = await getObjectMetadata(pool, "oracle", "DO_WORK", "procedure", "OB_USER", 1_000);

  assert.equal(metadata.objectType, "PROCEDURE");
  assert.equal(metadata.arguments.length, 1);
  assert.equal(metadata.sourcePreview.returnedLines, 2);
  assert.match(metadata.sourcePreview.text, /BEGIN NULL/);
});

test("getObjectMetadata returns Oracle synonym target metadata", async () => {
  const pool = {
    async query({ sql }) {
      if (sql.includes("FROM all_objects")) {
        return [[
          {
            owner: "OB_USER",
            object_name: "ORDERS_ALIAS",
            object_type: "SYNONYM",
            status: "VALID"
          }
        ], []];
      }
      if (sql.includes("FROM all_synonyms")) {
        return [[
          {
            owner: "OB_USER",
            synonym_name: "ORDERS_ALIAS",
            table_owner: "OB_USER",
            table_name: "ORDERS"
          }
        ], []];
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    }
  };

  const metadata = await getObjectMetadata(pool, "oracle", "ORDERS_ALIAS", "synonym", "OB_USER", 1_000);

  assert.equal(metadata.objectType, "SYNONYM");
  assert.equal(metadata.details.table_name, "ORDERS");
});

test("listObjects returns a read-only warning outside Oracle mode", async () => {
  const result = await listObjects({ query: async () => [[], []] }, "mysql", "biz_test", undefined, ["view"], 10, 1_000);

  assert.equal(result.mode, "mysql");
  assert.deepEqual(result.objects, []);
  assert.match(result.warnings[0], /Oracle object metadata/);
});
