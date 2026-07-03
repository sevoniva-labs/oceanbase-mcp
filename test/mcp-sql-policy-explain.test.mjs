import assert from "node:assert/strict";
import test from "node:test";

import { loadConfig } from "../dist/config.js";
import { explainGeneratedQuery, runExplainCheck } from "../dist/mcp/sql-policy-explain.js";

test("runExplainCheck returns structured success and failure", () => {
  assert.deepEqual(runExplainCheck("read_only_sql", () => undefined), {
    name: "read_only_sql",
    ok: true,
    message: "Allowed."
  });

  const blocked = runExplainCheck("read_only_sql", () => {
    throw new Error("Only read-only SQL is allowed.");
  });

  assert.equal(blocked.name, "read_only_sql");
  assert.equal(blocked.ok, false);
  assert.match(blocked.message, /read-only SQL/i);
});

test("explainGeneratedQuery enforces read-only policy for generated SQL", () => {
  const config = loadConfig({ OB_ALLOWED_SCHEMAS: "biz_test" });
  const allowed = explainGeneratedQuery("SELECT id FROM biz_test.orders WHERE id = ?", 1, config);
  const blocked = explainGeneratedQuery("DELETE FROM biz_test.orders WHERE id = ?", 1, config);

  assert.equal(allowed.allowed, true);
  assert(allowed.tableRefs.some((ref) => ref.table === "orders"));
  assert.equal(blocked.allowed, false);
  assert(blocked.checks.some((check) => check.name === "read_only_sql" && check.ok === false));
});
