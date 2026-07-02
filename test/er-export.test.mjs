import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { parseExportErArgs, resolveErOutputPath, writeErArtifact } from "../dist/er-export.js";

test("parseExportErArgs parses ER export options", () => {
  assert.deepEqual(parseExportErArgs([
    "--profile", "local",
    "--schema", "biz_test",
    "--table", "orders",
    "--tables", "orders,users",
    "--business-term", "订单",
    "--depth", "2",
    "--max-tables", "12",
    "--min-confidence", "0.8",
    "--format", "interactive",
    "--title", "Order ER",
    "--out", "er/order.html",
    "--out-dir", "er/chunks",
    "--chunk-size", "20",
    "--no-include-inferred",
    "--overwrite",
    "--dry-run"
  ]), {
    profile: "local",
    schema: "biz_test",
    table: "orders",
    tables: ["orders", "users"],
    businessTerm: "订单",
    depth: 2,
    maxTables: 12,
    minConfidence: 0.8,
    format: "html-interactive",
    title: "Order ER",
    output: "er/order.html",
    outputDir: "er/chunks",
    chunkSize: 20,
    includeInferred: false,
    relationshipMode: "foreign_key",
    overwrite: true,
    dryRun: true
  });
  assert.deepEqual(parseExportErArgs(["--relationship-mode", "inferred", "--max-relationships", "40"]), {
    relationshipMode: "inferred",
    includeInferred: true,
    maxRelationships: 40
  });
  assert.throws(() => parseExportErArgs(["--format", "svg"]), /--format/);
  assert.throws(() => parseExportErArgs(["--depth", "9"]), /--depth/);
  assert.throws(() => parseExportErArgs(["--relationship-mode", "wide"]), /--relationship-mode/);
});

test("resolveErOutputPath uses safe default names", () => {
  const dir = mkdtempSync(join(tmpdir(), "ob-mcp-er-export-"));
  try {
    assert.equal(resolveErOutputPath({ table: "orders/items" }, dir), join(dir, "orders-items.html"));
    assert.equal(resolveErOutputPath({ output: "docs/order-er.html" }, dir), join(dir, "docs/order-er.html"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("writeErArtifact refuses to overwrite by default", () => {
  const dir = mkdtempSync(join(tmpdir(), "ob-mcp-er-export-"));
  try {
    const file = join(dir, "er", "orders.html");
    writeErArtifact(file, "<html>first</html>");
    assert.equal(existsSync(file), true);
    assert.throws(() => writeErArtifact(file, "<html>second</html>"), /already exists/);
    writeErArtifact(file, "<html>second</html>", { overwrite: true });
    assert.equal(readFileSync(file, "utf8"), "<html>second</html>");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
