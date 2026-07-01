import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";

import { loadGatewayConfig } from "./config.js";
import { assertJsonByteLimit, jsonText } from "./format.js";
import { captureMetadataSnapshot, type CaptureMetadataSnapshotInput } from "./metadata-capture.js";
import { compareMetadataSnapshots, renderMetadataComparisonMarkdown } from "./metadata-change.js";
import { closeGatewayRuntime, createGatewayRuntime, selectRuntimeProfile } from "./runtime.js";

export type MetadataCommand = "snapshot" | "diff";
export type MetadataOutputFormat = "json" | "markdown";

export interface MetadataSnapshotCliOptions extends CaptureMetadataSnapshotInput {
  command: "snapshot";
  profile?: string;
  format?: "json";
  output?: string;
  overwrite?: boolean;
}

export interface MetadataDiffCliOptions {
  command: "diff";
  before?: string;
  after?: string;
  format?: MetadataOutputFormat;
  output?: string;
  overwrite?: boolean;
  riskOnly?: boolean;
  summaryOnly?: boolean;
}

export async function runMetadataCommand(args: string[], cwd = process.cwd()): Promise<number> {
  const [command, ...rest] = args;
  try {
    if (command === "snapshot") {
      return await runMetadataSnapshotCommand(parseMetadataSnapshotArgs(rest), cwd);
    }
    if (command === "diff") {
      return await runMetadataDiffCommand(parseMetadataDiffArgs(rest), cwd);
    }
    if (!command || command === "--help" || command === "-h" || command === "help") {
      printMetadataHelp();
      return 0;
    }
    throw new Error(`Unknown metadata command: ${command}`);
  } catch (error) {
    console.error(JSON.stringify({
      ok: false,
      error: (error as Error).message
    }, null, 2));
    return 1;
  }
}

export function parseMetadataDiffArgs(args: string[]): MetadataDiffCliOptions {
  const options: MetadataDiffCliOptions = { command: "diff" };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--overwrite") {
      options.overwrite = true;
      continue;
    }
    if (arg === "--risk-only") {
      options.riskOnly = true;
      continue;
    }
    if (arg === "--summary-only") {
      options.summaryOnly = true;
      continue;
    }
    const [name, inlineValue] = arg.includes("=") ? arg.split(/=(.*)/s, 2) : [arg, undefined];
    if (!name.startsWith("--")) {
      throw new Error(`Unknown metadata diff argument: ${arg}`);
    }
    const value = inlineValue ?? args[index + 1];
    if (inlineValue == null) {
      index += 1;
    }
    if (!value || value.startsWith("--")) {
      throw new Error(`Missing value for ${name}`);
    }
    switch (name) {
      case "--before":
        options.before = value;
        break;
      case "--after":
        options.after = value;
        break;
      case "--format":
        options.format = parseMetadataOutputFormat(value);
        break;
      case "--out":
        options.output = value;
        break;
      default:
        throw new Error(`Unknown metadata diff argument: ${name}`);
    }
  }
  if (!options.before) {
    throw new Error("metadata diff requires --before.");
  }
  if (!options.after) {
    throw new Error("metadata diff requires --after.");
  }
  return options;
}

export function parseMetadataSnapshotArgs(args: string[]): MetadataSnapshotCliOptions {
  const options: MetadataSnapshotCliOptions = { command: "snapshot" };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--overwrite") {
      options.overwrite = true;
      continue;
    }
    if (arg === "--no-relationships") {
      options.includeRelationships = false;
      continue;
    }
    if (arg === "--include-relationships") {
      options.includeRelationships = true;
      continue;
    }
    if (arg === "--no-oracle-objects") {
      options.includeOracleObjects = false;
      continue;
    }
    if (arg === "--include-oracle-objects") {
      options.includeOracleObjects = true;
      continue;
    }
    const [name, inlineValue] = arg.includes("=") ? arg.split(/=(.*)/s, 2) : [arg, undefined];
    if (!name.startsWith("--")) {
      throw new Error(`Unknown metadata snapshot argument: ${arg}`);
    }
    const value = inlineValue ?? args[index + 1];
    if (inlineValue == null) {
      index += 1;
    }
    if (!value || value.startsWith("--")) {
      throw new Error(`Missing value for ${name}`);
    }
    switch (name) {
      case "--profile":
        options.profile = value;
        break;
      case "--schema":
        options.schema = value;
        break;
      case "--table-pattern":
        options.tablePattern = value;
        break;
      case "--object-types":
        options.objectTypes = splitCsv(value);
        break;
      case "--max-tables":
        options.maxTables = parsePositiveInt(value, name, 200);
        break;
      case "--max-columns-per-table":
        options.maxColumnsPerTable = parsePositiveInt(value, name, 200);
        break;
      case "--max-objects":
        options.maxObjects = parsePositiveInt(value, name, 500);
        break;
      case "--max-relationships":
        options.maxRelationships = parsePositiveInt(value, name, 1_000);
        break;
      case "--format":
        options.format = parseSnapshotOutputFormat(value);
        break;
      case "--out":
        options.output = value;
        break;
      default:
        throw new Error(`Unknown metadata snapshot argument: ${name}`);
    }
  }
  return options;
}

export function resolveMetadataOutputPath(output: string, cwd = process.cwd()): string {
  if (output.includes("\0")) {
    throw new Error("Output path contains an invalid character.");
  }
  const resolved = isAbsolute(output) ? resolve(output) : resolve(cwd, output);
  if (!isAbsolute(output) && !isPathInside(resolved, resolve(cwd))) {
    throw new Error("Relative output paths must stay inside the current working directory.");
  }
  return resolved;
}

async function runMetadataSnapshotCommand(options: MetadataSnapshotCliOptions, cwd: string): Promise<number> {
  if ((options.format ?? "json") !== "json") {
    throw new Error("metadata snapshot currently supports --format json.");
  }

  const runtime = createGatewayRuntime(loadGatewayConfig());
  try {
    const selected = selectRuntimeProfile(runtime, options.profile);
    const snapshot = await captureMetadataSnapshot(selected, {
      schema: options.schema,
      tablePattern: options.tablePattern,
      objectTypes: options.objectTypes,
      includeRelationships: options.includeRelationships,
      includeOracleObjects: options.includeOracleObjects,
      maxTables: options.maxTables,
      maxColumnsPerTable: options.maxColumnsPerTable,
      maxObjects: options.maxObjects,
      maxRelationships: options.maxRelationships
    });
    assertJsonByteLimit(snapshot, selected.config.maxResultBytes);
    const content = `${jsonText(snapshot)}\n`;
    if (!options.output) {
      console.log(content.trimEnd());
      return 0;
    }
    const outputPath = resolveMetadataOutputPath(options.output, cwd);
    writeMetadataFile(outputPath, content, { overwrite: options.overwrite });
    console.log(JSON.stringify({
      ok: true,
      file: outputPath,
      format: "json",
      snapshotVersion: snapshot.snapshotVersion,
      tableCount: snapshot.tableCount,
      objectCount: snapshot.objectCount,
      relationshipCount: snapshot.relationshipCount,
      fingerprint: snapshot.fingerprint
    }, null, 2));
    return 0;
  } finally {
    await closeGatewayRuntime(runtime);
  }
}

async function runMetadataDiffCommand(options: MetadataDiffCliOptions, cwd: string): Promise<number> {
  const beforePath = resolveMetadataInputPath(options.before!, cwd);
  const afterPath = resolveMetadataInputPath(options.after!, cwd);
  const before = readFileSync(beforePath, "utf8");
  const after = readFileSync(afterPath, "utf8");
  const comparison = compareMetadataSnapshots(before, after, {
    riskOnly: options.riskOnly,
    summaryOnly: options.summaryOnly
  });
  const format = options.format ?? "json";
  const content = format === "markdown"
    ? `${renderMetadataComparisonMarkdown(comparison)}\n`
    : `${jsonText(comparison)}\n`;
  if (!options.output) {
    console.log(content.trimEnd());
    return 0;
  }
  const outputPath = resolveMetadataOutputPath(options.output, cwd);
  writeMetadataFile(outputPath, content, { overwrite: options.overwrite });
  console.log(JSON.stringify({
    ok: true,
    file: outputPath,
    format,
    totalChanges: comparison.summary.totalChanges,
    breakingChanges: comparison.summary.breakingChanges,
    fingerprintEqual: comparison.fingerprintEqual
  }, null, 2));
  return 0;
}

function writeMetadataFile(path: string, content: string, options: { overwrite?: boolean } = {}): void {
  if (!options.overwrite && existsSync(path)) {
    throw new Error(`${path} already exists. Re-run with --overwrite to replace it.`);
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function parseMetadataOutputFormat(value: string): MetadataOutputFormat {
  if (value === "json" || value === "markdown") {
    return value;
  }
  throw new Error("--format must be json or markdown.");
}

function parseSnapshotOutputFormat(value: string): "json" {
  if (value === "json") {
    return value;
  }
  throw new Error("metadata snapshot currently supports --format json.");
}

function parsePositiveInt(value: string, name: string, max: number): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > max) {
    throw new Error(`${name} must be an integer between 1 and ${max}.`);
  }
  return parsed;
}

function splitCsv(value: string): string[] {
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

function isPathInside(child: string, parent: string): boolean {
  const normalizedParent = parent.endsWith("/") ? parent : `${parent}/`;
  return child === parent || child.startsWith(normalizedParent);
}

function resolveMetadataInputPath(input: string, cwd: string): string {
  if (input.includes("\0")) {
    throw new Error("Input path contains an invalid character.");
  }
  return isAbsolute(input) ? resolve(input) : resolve(cwd, input);
}

function printMetadataHelp() {
  console.log(`OceanBase MCP metadata

Usage:
  ob-mcp metadata snapshot [options]
  ob-mcp metadata diff --before <file> --after <file> [options]

Snapshot options:
  --profile <name>
  --schema <schema>
  --table-pattern <pattern>
  --object-types <view,sequence,synonym,procedure,function,package>
  --max-tables <n>
  --max-columns-per-table <n>
  --max-objects <n>
  --max-relationships <n>
  --no-relationships
  --no-oracle-objects
  --format json
  --out <file>
  --overwrite

Diff options:
  --before <file>
  --after <file>
  --format json|markdown
  --out <file>
  --risk-only
  --summary-only
  --overwrite
`);
}
