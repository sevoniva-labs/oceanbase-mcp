import assert from "node:assert/strict";
import test from "node:test";

import {
  createExecutionDiagnostics,
  withExecutionDiagnostics,
  withQuerySlot
} from "../dist/runtime.js";

test("execution diagnostics enforce DB call budget before running the next operation", async () => {
  const selected = {
    profile: "default",
    limiter: { active: 0, limit: 5 }
  };
  const diagnostics = createExecutionDiagnostics(1, "ob_test_tool");

  await withExecutionDiagnostics(diagnostics, async () => {
    assert.equal(await withQuerySlot(selected, async () => "ok"), "ok");
    await assert.rejects(
      () => withQuerySlot(selected, async () => "should-not-run"),
      /Tool "ob_test_tool" exceeded DB call budget maxDbCalls=1/
    );
  });

  assert.equal(diagnostics.dbCalls, 2);
  assert.equal(selected.limiter.active, 0);
});
