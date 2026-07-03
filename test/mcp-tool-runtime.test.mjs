import assert from "node:assert/strict";
import test from "node:test";

import { errorHints, toErrorResult } from "../dist/mcp/tool-runtime.js";

test("tool runtime error hints explain read-only and metadata failures", () => {
  assert(
    errorHints(new Error("ORA-00904 invalid identifier"), {}).some((hint) =>
      /Search visible metadata/.test(hint)
    )
  );
  assert(
    errorHints(new Error("Only read-only SQL is allowed because NEXTVAL was found"), {}).some((hint) =>
      /sequence NEXTVAL/.test(hint)
    )
  );
  assert(
    errorHints(new Error("paged query input rejected"), { sql: "select id from orders" }).some((hint) =>
      /stable ORDER BY/.test(hint)
    )
  );
});

test("tool runtime error result hides driver sqlMessage details", () => {
  const error = new Error("Only read-only SQL is allowed password=secret");
  error.sqlMessage = "password=secret";

  const result = toErrorResult(error, { sql: "select * from orders" });
  const payload = JSON.parse(result.content[0].text);

  assert.equal(result.isError, true);
  assert.equal(payload.ok, false);
  assert.equal(payload.error.sqlMessage, undefined);
  assert.match(payload.error.message, /password=\[redacted\]/);
  assert(payload.hints.length > 0);
});
