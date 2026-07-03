import assert from "node:assert/strict";
import test from "node:test";

import {
  buildErExportCommand,
  formatErColumnLimitWarnings,
  shouldSkipSchemaInlineErHtmlRender
} from "../dist/mcp/tools/er-response.js";

test("ER response helpers skip broad inline rendering only for large implicit scopes", () => {
  assert.equal(shouldSkipSchemaInlineErHtmlRender({ tableCount: 26 }, {}), true);
  assert.equal(shouldSkipSchemaInlineErHtmlRender({ tableCount: 25 }, {}), false);
  assert.equal(shouldSkipSchemaInlineErHtmlRender({ tableCount: 80 }, { table: "orders" }), false);
  assert.equal(shouldSkipSchemaInlineErHtmlRender({ tableCount: 80 }, { tables: ["orders"] }), false);
  assert.equal(shouldSkipSchemaInlineErHtmlRender({ tableCount: 80 }, { businessTerm: "orders" }), false);
});

test("ER column limit warnings are summarized for large schemas", () => {
  const warnings = formatErColumnLimitWarnings(
    Array.from({ length: 12 }, (_, index) => `biz.t_${String(index + 1).padStart(3, "0")}`),
    4,
    120
  );

  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /12 table\(s\)/);
  assert.match(warnings[0], /120 column\(s\) were omitted/);
  assert.match(warnings[0], /biz\.t_001/);
  assert.match(warnings[0], /and 2 more/);
});

test("ER export command quotes unsafe shell arguments", () => {
  const command = buildErExportCommand(
    {
      schema: "biz test",
      rootTable: null,
      businessTerm: "O'Brien orders",
      relationshipMode: "foreign_key",
      maxTables: 30,
      maxRelationships: 100
    },
    "html-interactive",
    { output: "er output/orders.html", maxColumnsPerTable: 12 }
  );

  assert.match(command, /--schema 'biz test'/);
  assert.match(command, /--business-term 'O'\\''Brien orders'/);
  assert.match(command, /--format interactive/);
  assert.match(command, /--out 'er output\/orders\.html'/);
});
