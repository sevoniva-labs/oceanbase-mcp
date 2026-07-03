import assert from "node:assert/strict";
import test from "node:test";

import { normalizeSqlForDriver } from "../dist/db/sql-driver.js";

test("normalizeSqlForDriver leaves MySQL and unparameterized SQL unchanged", () => {
  assert.equal(
    normalizeSqlForDriver("mysql", "SELECT * FROM orders WHERE id = :id", [1]),
    "SELECT * FROM orders WHERE id = :id"
  );
  assert.equal(
    normalizeSqlForDriver("oracle", "SELECT * FROM orders WHERE id = :id", []),
    "SELECT * FROM orders WHERE id = :id"
  );
});

test("normalizeSqlForDriver converts Oracle named bind placeholders", () => {
  assert.equal(
    normalizeSqlForDriver(
      "oracle",
      "SELECT * FROM orders WHERE user_id = :user_id AND status = :status AND tenant_id = :tenant$",
      [10, "PAID", "t1"]
    ),
    "SELECT * FROM orders WHERE user_id = ? AND status = ? AND tenant_id = ?"
  );
});

test("normalizeSqlForDriver does not rewrite quoted text comments or double-colon tokens", () => {
  const sql = `
    SELECT ':literal' AS a, "COL:NAME" AS b, value::number AS c
    FROM orders
    WHERE id = :id
    -- :comment_bind
    AND note = 'it''s :not_bind'
    /* :block_bind */
  `;
  assert.equal(
    normalizeSqlForDriver("oracle", sql, [42]),
    `
    SELECT ':literal' AS a, "COL:NAME" AS b, value::number AS c
    FROM orders
    WHERE id = ?
    -- :comment_bind
    AND note = 'it''s :not_bind'
    /* :block_bind */
  `
  );
});
