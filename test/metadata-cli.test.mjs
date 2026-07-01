import assert from "node:assert/strict";
import test from "node:test";

import { parseMetadataSnapshotArgs, resolveMetadataOutputPath } from "../dist/metadata-cli.js";

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
