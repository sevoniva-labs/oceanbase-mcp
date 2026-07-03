import assert from "node:assert/strict";
import test from "node:test";

import { fieldValue, groupBy, numberField, rowRecord, stringField } from "../dist/db/metadata-values.js";

test("metadata value helpers normalize records and typed fields", () => {
  assert.deepEqual(rowRecord(null), {});
  assert.deepEqual(rowRecord(["not", "a", "record"]), {});

  const record = rowRecord({ count_value: "42", empty: "   ", name: " ORDERS ", fallback: 0 });
  assert.equal(fieldValue(record, "missing", "fallback"), 0);
  assert.equal(stringField(record, "name"), "ORDERS");
  assert.equal(stringField(record, "empty"), undefined);
  assert.equal(numberField(record, "count_value"), 42);
  assert.equal(numberField(record, "name"), undefined);
});

test("groupBy preserves insertion order inside each group", () => {
  const grouped = groupBy([
    { type: "table", name: "orders" },
    { type: "view", name: "order_view" },
    { type: "table", name: "users" }
  ], (item) => item.type);

  assert.deepEqual(grouped.get("table").map((item) => item.name), ["orders", "users"]);
  assert.deepEqual(grouped.get("view").map((item) => item.name), ["order_view"]);
});
