import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { loadGatewayConfig } from "./config.js";
import { closeGatewayRuntime, createGatewayRuntime } from "./runtime.js";
import { createObMcpServer } from "./mcp.js";

export type ExportErFormat = "html-static" | "html-interactive" | "html-compact" | "html-detailed";

export interface ExportErOptions {
  cwd?: string;
  profile?: string;
  schema?: string;
  table?: string;
  tables?: string[];
  businessTerm?: string;
  depth?: number;
  maxTables?: number;
  maxRelationships?: number;
  minConfidence?: number;
  relationshipMode?: "none" | "foreign_key" | "inferred";
  includeInferred?: boolean;
  format?: ExportErFormat;
  title?: string;
  output?: string;
  overwrite?: boolean;
  dryRun?: boolean;
}

interface ToolExecutorServer {
  _registeredTools: Record<string, unknown>;
  executeToolHandler(tool: unknown, args: unknown, extra: unknown): Promise<{ content?: Array<{ text?: string }> }>;
  close(): Promise<void>;
}

export async function runExportErCommand(args: string[], cwd = process.cwd()): Promise<number> {
  let runtime: ReturnType<typeof createGatewayRuntime> | undefined;
  let server: ToolExecutorServer | undefined;
  try {
    const options = parseExportErArgs(args);
    const outputPath = resolveErOutputPath(options, cwd);
    if (options.dryRun) {
      console.log(JSON.stringify({
        ok: true,
        file: outputPath,
        tool: "ob_generate_er_html",
        args: erToolArgs(options),
        write: false
      }, null, 2));
      return 0;
    }

    runtime = createGatewayRuntime(loadGatewayConfig());
    server = createObMcpServer(runtime) as unknown as ToolExecutorServer;
    const tool = server._registeredTools.ob_generate_er_html;
    if (!tool) {
      throw new Error("ob_generate_er_html is not registered.");
    }
    const result = await server.executeToolHandler(tool, erToolArgs(options), {});
    const payload = parseHtmlPayload(result);
    writeErArtifact(outputPath, payload.html, { overwrite: options.overwrite });
    console.log(JSON.stringify({
      ok: true,
      file: outputPath,
      format: payload.format,
      tableCount: payload.tableCount,
      relationshipCount: payload.relationshipCount
    }, null, 2));
    return 0;
  } catch (error) {
    console.error(JSON.stringify({
      ok: false,
      error: (error as Error).message
    }, null, 2));
    return 1;
  } finally {
    if (server) {
      await server.close();
    }
    if (runtime) {
      await closeGatewayRuntime(runtime);
    }
  }
}

export function parseExportErArgs(args: string[]): ExportErOptions {
  const options: ExportErOptions = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--overwrite") {
      options.overwrite = true;
      continue;
    }
    if (arg === "--dry-run") {
      options.dryRun = true;
      continue;
    }
    if (arg === "--no-include-inferred") {
      options.includeInferred = false;
      options.relationshipMode = "foreign_key";
      continue;
    }
    if (arg === "--include-inferred") {
      options.includeInferred = true;
      options.relationshipMode = "inferred";
      continue;
    }
    const [name, inlineValue] = arg.includes("=") ? arg.split(/=(.*)/s, 2) : [arg, undefined];
    if (!name.startsWith("--")) {
      throw new Error(`Unknown export-er argument: ${arg}`);
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
      case "--table":
        options.table = value;
        break;
      case "--tables":
        options.tables = value.split(",").map((item) => item.trim()).filter(Boolean);
        break;
      case "--business-term":
        options.businessTerm = value;
        break;
      case "--depth":
        options.depth = parsePositiveInt(value, name, 3);
        break;
      case "--max-tables":
        options.maxTables = parsePositiveInt(value, name, 200);
        break;
      case "--max-relationships":
        options.maxRelationships = parsePositiveInt(value, name, 1000);
        break;
      case "--min-confidence":
        options.minConfidence = parseConfidence(value, name);
        break;
      case "--relationship-mode":
        options.relationshipMode = parseRelationshipMode(value);
        options.includeInferred = options.relationshipMode === "inferred";
        break;
      case "--format":
        options.format = parseExportErFormat(value);
        break;
      case "--title":
        options.title = value;
        break;
      case "--out":
        options.output = value;
        break;
      default:
        throw new Error(`Unknown export-er argument: ${name}`);
    }
  }
  return options;
}

export function resolveErOutputPath(options: ExportErOptions, cwd = process.cwd()): string {
  if (options.output) {
    return resolve(cwd, options.output);
  }
  const name = safeFileName([
    options.businessTerm,
    options.table,
    options.tables?.[0],
    options.schema
  ].find((value) => value && value.trim()) ?? "oceanbase-er");
  return resolve(cwd, `${name}.html`);
}

export function writeErArtifact(path: string, html: string, options: { overwrite?: boolean } = {}): void {
  if (!options.overwrite && existsSync(path)) {
    throw new Error(`${path} already exists. Re-run with --overwrite to replace it.`);
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, html);
}

function erToolArgs(options: ExportErOptions): Record<string, unknown> {
  return {
    profile: options.profile,
    schema: options.schema,
    table: options.table,
    tables: options.tables,
    businessTerm: options.businessTerm,
    depth: options.depth,
    maxTables: options.maxTables,
    maxRelationships: options.maxRelationships,
    minConfidence: options.minConfidence,
    relationshipMode: options.relationshipMode ?? (options.includeInferred ? "inferred" : "foreign_key"),
    includeInferred: options.includeInferred ?? false,
    format: options.format ?? "html-static",
    title: options.title
  };
}

function parseHtmlPayload(result: { content?: Array<{ text?: string }> }): {
  html: string;
  format?: string;
  tableCount?: number;
  relationshipCount?: number;
} {
  const text = result.content?.[0]?.text;
  if (!text) {
    throw new Error("ob_generate_er_html returned an empty response.");
  }
  const payload = JSON.parse(text) as { html?: unknown; format?: string; tableCount?: number; relationshipCount?: number };
  if (typeof payload.html !== "string" || !payload.html.trim()) {
    throw new Error("ob_generate_er_html did not return HTML content.");
  }
  return {
    html: payload.html,
    format: payload.format,
    tableCount: payload.tableCount,
    relationshipCount: payload.relationshipCount
  };
}

function parsePositiveInt(value: string, name: string, max: number): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > max) {
    throw new Error(`${name} must be an integer between 1 and ${max}.`);
  }
  return parsed;
}

function parseConfidence(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    throw new Error(`${name} must be between 0 and 1.`);
  }
  return parsed;
}

function parseExportErFormat(value: string): ExportErFormat {
  const normalized = value.startsWith("html-") ? value : `html-${value}`;
  if (
    normalized === "html-static" ||
    normalized === "html-interactive" ||
    normalized === "html-compact" ||
    normalized === "html-detailed"
  ) {
    return normalized;
  }
  throw new Error("--format must be static, interactive, compact, or detailed.");
}

function parseRelationshipMode(value: string): "none" | "foreign_key" | "inferred" {
  const normalized = value.trim().replace(/-/g, "_");
  if (normalized === "none" || normalized === "foreign_key" || normalized === "inferred") {
    return normalized;
  }
  throw new Error("--relationship-mode must be none, foreign_key, or inferred.");
}

function safeFileName(value: string): string {
  return value
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "oceanbase-er";
}
