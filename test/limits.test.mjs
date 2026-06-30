import assert from "node:assert/strict";
import test from "node:test";

import { assertJsonByteLimit } from "../dist/format.js";
import { effectiveRowLimit, isToolAllowed } from "../dist/mcp.js";
import { withQuerySlot } from "../dist/runtime.js";

test("effectiveRowLimit treats OB_MAX_ROWS as a hard cap", () => {
  const config = { maxRows: 100 };

  assert.equal(effectiveRowLimit(undefined, config), 100);
  assert.equal(effectiveRowLimit(10, config), 10);
  assert.equal(effectiveRowLimit(10_000, config), 100);
});

test("assertJsonByteLimit blocks oversized tool output", () => {
  assert.doesNotThrow(() => assertJsonByteLimit({ rows: ["ok"] }, 1_000));
  assert.throws(() => assertJsonByteLimit({ rows: ["x".repeat(256)] }, 64), /OB_MAX_RESULT_BYTES/);
});

test("withQuerySlot enforces per-profile concurrency", async () => {
  let release;
  const selected = {
    profile: "default",
    limiter: {
      active: 0,
      limit: 1
    }
  };

  const first = withQuerySlot(
    selected,
    () =>
      new Promise((resolve) => {
        release = resolve;
      })
  );

  await assert.rejects(() => withQuerySlot(selected, async () => "second"), /OB_MAX_CONCURRENT_QUERIES=1/);
  release("done");
  await first;
  assert.equal(selected.limiter.active, 0);
});

test("isToolAllowed supports scoped bearer token tool visibility", () => {
  assert.equal(isToolAllowed("ob_query"), true);
  assert.equal(isToolAllowed("ob_query", { name: "default" }), true);
  assert.equal(isToolAllowed("ob_query", { name: "limited", tools: ["ob_query"] }), true);
  assert.equal(isToolAllowed("ob_ping", { name: "limited", tools: ["ob_query"] }), false);
});
