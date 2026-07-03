import assert from "node:assert/strict";
import test from "node:test";

import { oracleTimeoutHint, timeoutMicros } from "../dist/db/dialect/oracle.js";

test("oracleTimeoutHint renders bounded OceanBase query timeout hint", () => {
  assert.equal(timeoutMicros(30_000), 30_000_000);
  assert.equal(timeoutMicros(0), 1_000);
  assert.equal(oracleTimeoutHint(250), "/*+ query_timeout(250000) */");
});
