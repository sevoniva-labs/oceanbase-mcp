import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { buildMetadataSnapshot } from "../dist/metadata-change.js";
import { parseMetadataDiffArgs, parseMetadataSnapshotArgs, resolveMetadataOutputPath, runMetadataCommand } from "../dist/metadata-cli.js";

test("parseMetadataSnapshotArgs parses snapshot options", () => {
  assert.deepEqual(parseMetadataSnapshotArgs([
    "--profile", "local",
    "--schema=APP",
    "--table-pattern", "ORDER",
    "--object-types", "view,sequence",
    "--max-tables", "20",
    "--max-columns-per-table", "50",
    "--max-objects", "30",
    "--max-relationships", "40",
    "--no-relationships",
    "--include-oracle-objects",
    "--format", "json",
    "--out", "snapshots/start.json",
    "--overwrite"
  ]), {
    command: "snapshot",
    profile: "local",
    schema: "APP",
    tablePattern: "ORDER",
    objectTypes: ["view", "sequence"],
    maxTables: 20,
    maxColumnsPerTable: 50,
    maxObjects: 30,
    maxRelationships: 40,
    includeRelationships: false,
    includeOracleObjects: true,
    format: "json",
    output: "snapshots/start.json",
    overwrite: true
  });

  assert.throws(() => parseMetadataSnapshotArgs(["--format", "markdown"]), /--format/);
  assert.throws(() => parseMetadataSnapshotArgs(["--max-tables", "0"]), /--max-tables/);
});

test("resolveMetadataOutputPath keeps relative output inside cwd", () => {
  const cwd = "/tmp/ob-mcp-test";
  assert.equal(resolveMetadataOutputPath("snapshots/start.json", cwd), "/tmp/ob-mcp-test/snapshots/start.json");
  assert.throws(() => resolveMetadataOutputPath("../outside.json", cwd), /inside/);
  assert.equal(resolveMetadataOutputPath("/tmp/outside.json", cwd), "/tmp/outside.json");
});

test("parseMetadataDiffArgs parses diff options", () => {
  assert.deepEqual(parseMetadataDiffArgs([
    "--before", "before.json",
    "--after=after.json",
    "--format", "markdown",
    "--out", "diff.md",
    "--risk-only",
    "--summary-only",
    "--overwrite"
  ]), {
    command: "diff",
    before: "before.json",
    after: "after.json",
    format: "markdown",
    output: "diff.md",
    riskOnly: true,
    summaryOnly: true,
    overwrite: true
  });

  assert.throws(() => parseMetadataDiffArgs(["--after", "after.json"]), /--before/);
  assert.throws(() => parseMetadataDiffArgs(["--before", "before.json"]), /--after/);
});

test("metadata diff command writes markdown output from snapshot files", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ob-mcp-metadata-diff-"));
  try {
    const before = buildMetadataSnapshot({
      profile: "default",
      compatibility: "mysql",
      scope: snapshotScope(),
      tables: [{
        schema: "biz",
        table: "orders",
        columns: [
          { column_name: "id", column_type: "bigint", is_nullable: "NO", ordinal_position: 1 },
          { column_name: "status", column_type: "varchar(32)", is_nullable: "YES", ordinal_position: 2 }
        ],
        indexes: [],
        constraints: [],
        partitions: []
      }],
      relationships: []
    });
    const after = buildMetadataSnapshot({
      profile: "default",
      compatibility: "mysql",
      scope: snapshotScope(),
      tables: [{
        schema: "biz",
        table: "orders",
        columns: [{ column_name: "id", column_type: "bigint", is_nullable: "NO", ordinal_position: 1 }],
        indexes: [],
        constraints: [],
        partitions: []
      }],
      relationships: []
    });
    writeFileSync(join(dir, "before.json"), JSON.stringify(before));
    writeFileSync(join(dir, "after.json"), JSON.stringify(after));

    const code = await runMetadataCommand([
      "diff",
      "--before", "before.json",
      "--after", "after.json",
      "--format", "markdown",
      "--out", "diff.md"
    ], dir);
    assert.equal(code, 0);
    const markdown = readFileSync(join(dir, "diff.md"), "utf8");
    assert.match(markdown, /OceanBase Metadata Snapshot Diff/);
    assert.match(markdown, /biz\.orders\.status/);
    assert.doesNotMatch(markdown, /\b(ALTER|CREATE|DROP|GRANT)\b/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function snapshotScope() {
  return {
    objectTypes: [],
    includeRelationships: false,
    includeOracleObjects: false,
    maxTables: 10,
    maxColumnsPerTable: 20,
    maxObjects: 10,
    maxRelationships: 10
  };
}
