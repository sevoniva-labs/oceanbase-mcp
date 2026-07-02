import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  extractEmbeddedErGraph,
  parseExportErArgs,
  renderErExportIndexHtml,
  renderErExportOverviewHtml,
  renderErExportTableHtml,
  resolveErOutputPath,
  writeErArtifact
} from "../dist/er-export.js";

test("parseExportErArgs parses ER export options", () => {
  assert.deepEqual(parseExportErArgs([
    "--profile", "local",
    "--schema", "biz_test",
    "--table", "orders",
    "--tables", "orders,users",
    "--business-term", "订单",
    "--depth", "2",
    "--max-tables", "12",
    "--max-columns-per-table", "18",
    "--min-confidence", "0.8",
    "--strategy", "table-prefix",
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
    maxColumnsPerTable: 18,
    minConfidence: 0.8,
    strategy: "table-prefix",
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
  assert.throws(() => parseExportErArgs(["--strategy", "wide"]), /--strategy/);
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

test("extractEmbeddedErGraph reads interactive ER graph metadata", () => {
  const html = `<html><body><script type="application/json" id="er-graph-data">{"nodes":[{"label":"orders\\u003citems"}],"edges":[],"status":"OK","diagnostics":[],"summary":{"tableCount":1}}</script></body></html>`;
  assert.deepEqual(extractEmbeddedErGraph(html), {
    nodes: [{ label: "orders<items" }],
    edges: [],
    status: "OK",
    diagnostics: [],
    summary: { tableCount: 1 }
  });
  assert.equal(extractEmbeddedErGraph("<html></html>"), undefined);
});

test("ER export directory pages link chunks tables and metadata", () => {
  const summary = {
    mode: "mysql",
    schema: "biz_test",
    format: "html-interactive",
    tableCount: 2,
    relationshipCount: 1,
    plannedRelationshipCount: 2,
    chunkCount: 1,
    chunkSize: 25,
    generatedAt: "2026-07-02T00:00:00.000Z",
    warnings: ["Use cluster export commands for large schemas."],
    chunks: [
      {
        index: 1,
        file: "clusters/cluster-001.html",
        tableCount: 2,
        relationshipCount: 1,
        tables: ["biz_test.orders", "biz_test.users"]
      }
    ],
    tablePages: [
      {
        table: "biz_test.orders",
        file: "tables/biz_test.orders.html",
        chunkFile: "clusters/cluster-001.html"
      }
    ]
  };

  const index = renderErExportIndexHtml(summary);
  assert.match(index, /metadata\/graph\.json/);
  assert.match(index, /metadata\/diagnostics\.json/);
  assert.match(index, /metadata\/er-summary\.json/);
  assert.match(index, /clusters\/cluster-001\.html/);
  assert.match(index, /tables\/biz_test\.orders\.html/);
  assert.match(index, /Planned relationships/);
  assert.match(index, /Warnings \(1\)/);

  const overview = renderErExportOverviewHtml(summary, [
    {
      index: 1,
      relationType: "foreign_key",
      confidence: 1,
      sourceRule: "foreign_key",
      source: { schema: "biz_test", table: "orders", label: "biz_test.orders", columns: ["user_id"], cluster: 1 },
      target: { schema: "biz_test", table: "users", label: "biz_test.users", columns: ["id"], cluster: 2 },
      evidence: [],
      crossCluster: true
    }
  ]);
  assert.match(overview, /metadata-only/);
  assert.match(overview, /Cluster 1/);
  assert.match(overview, /Cross-Cluster Relationships/);
  assert.match(overview, /Warnings \(1\)/);

  const table = renderErExportTableHtml({
    table: "biz_test.orders",
    chunkFile: "../clusters/cluster-001.html",
    indexFile: "../index.html",
    relationships: [
      {
        direction: "outbound",
        peer: "biz_test.users",
        peerFile: "biz_test.users.html",
        columns: "user_id -> id",
        relationType: "foreign_key",
        confidence: 1,
        crossCluster: true
      }
    ]
  });
  assert.match(table, /biz_test\.orders/);
  assert.match(table, /\.\.\/clusters\/cluster-001\.html/);
  assert.match(table, /Direct Relationships/);
  assert.match(table, /user_id -&gt; id/);
});
