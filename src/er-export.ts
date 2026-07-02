import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";

import { loadGatewayConfig, type GatewayConfig } from "./config.js";
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
  outputDir?: string;
  chunkSize?: number;
  overwrite?: boolean;
  dryRun?: boolean;
}

interface ToolExecutorServer {
  _registeredTools: Record<string, unknown>;
  executeToolHandler(tool: unknown, args: unknown, extra: unknown): Promise<{ content?: Array<{ text?: string }> }>;
  close(): Promise<void>;
}

interface ParsedErPlan {
  mode?: string;
  schema?: string;
  rootTable?: string;
  businessTerm?: string;
  format?: string;
  tableCount?: number;
  relationshipCount?: number;
  chunkSize?: number;
  warnings: string[];
  chunks: Array<{ index: number; tableCount: number; tables: string[]; file: string }>;
}

interface ErDirectoryChunk {
  index: number;
  file: string;
  tableCount: number;
  relationshipCount?: number;
  tables: string[];
}

interface ErDirectoryTablePage {
  table: string;
  file: string;
  chunkFile: string;
}

interface ErDirectorySummary {
  mode?: string;
  schema?: string;
  rootTable?: string;
  businessTerm?: string;
  format?: string;
  tableCount?: number;
  relationshipCount?: number;
  plannedRelationshipCount?: number;
  chunkCount: number;
  chunkSize?: number;
  chunks: ErDirectoryChunk[];
  tablePages: ErDirectoryTablePage[];
  warnings: string[];
  generatedAt: string;
}

export async function runExportErCommand(args: string[], cwd = process.cwd()): Promise<number> {
  let runtime: ReturnType<typeof createGatewayRuntime> | undefined;
  let server: ToolExecutorServer | undefined;
  try {
    const options = parseExportErArgs(args);
    const outputPath = options.outputDir ? undefined : resolveErOutputPath(options, cwd);
    if (options.dryRun) {
      console.log(JSON.stringify({
        ok: true,
        file: outputPath,
        directory: options.outputDir ? resolve(cwd, options.outputDir) : undefined,
        tool: options.outputDir ? "ob_plan_er_export" : "ob_generate_er_html",
        args: options.outputDir ? erPlanArgs(options) : erToolArgs(options),
        write: false
      }, null, 2));
      return 0;
    }

    const gatewayConfig = loadGatewayConfig();
    allowLocalErHtmlExport(gatewayConfig);
    runtime = createGatewayRuntime(gatewayConfig);
    server = createObMcpServer(runtime) as unknown as ToolExecutorServer;
    if (options.outputDir) {
      return await runExportErDirectory(server, options, cwd);
    }
    const tool = server._registeredTools.ob_generate_er_html;
    if (!tool) {
      throw new Error("ob_generate_er_html is not registered.");
    }
    const result = await server.executeToolHandler(tool, erToolArgs(options), {});
    const payload = parseHtmlPayload(result);
    writeErArtifact(outputPath!, payload.html, { overwrite: options.overwrite });
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

function allowLocalErHtmlExport(config: GatewayConfig): void {
  for (const profile of Object.values(config.profiles)) {
    profile.erInlineHtmlMaxBytes = Math.max(
      profile.erInlineHtmlMaxBytes,
      Math.min(profile.maxResultBytes, 64 * 1024 * 1024)
    );
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
        options.maxTables = parsePositiveInt(value, name, 500);
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
      case "--out-dir":
        options.outputDir = value;
        break;
      case "--chunk-size":
        options.chunkSize = parsePositiveInt(value, name, 100);
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

function erPlanArgs(options: ExportErOptions): Record<string, unknown> {
  return {
    ...erToolArgs(options),
    outputDir: options.outputDir,
    chunkSize: options.chunkSize
  };
}

async function runExportErDirectory(
  server: ToolExecutorServer,
  options: ExportErOptions,
  cwd: string
): Promise<number> {
  const planTool = server._registeredTools.ob_plan_er_export;
  const htmlTool = server._registeredTools.ob_generate_er_html;
  if (!planTool) {
    throw new Error("ob_plan_er_export is not registered.");
  }
  if (!htmlTool) {
    throw new Error("ob_generate_er_html is not registered.");
  }
  const planResult = await server.executeToolHandler(planTool, erPlanArgs(options), {});
  const plan = parsePlanPayload(planResult);
  const outputRoot = resolve(cwd, options.outputDir!);
  const tablePages = planTablePages(plan, cwd, outputRoot);
  const metadataFiles = [
    resolve(outputRoot, "index.html"),
    resolve(outputRoot, "overview.html"),
    resolve(outputRoot, "metadata/er-summary.json"),
    resolve(outputRoot, "metadata/relationships.json"),
    resolve(outputRoot, "metadata/warnings.json")
  ];
  const files = [
    ...plan.chunks.map((chunk) => resolve(cwd, chunk.file)),
    ...tablePages.map((page) => page.absoluteFile),
    ...metadataFiles
  ];
  if (!options.overwrite) {
    const existing = files.find((file) => existsSync(file));
    if (existing) {
      throw new Error(`${existing} already exists. Re-run with --overwrite to replace it.`);
    }
  }

  const written: ErDirectoryChunk[] = [];
  for (const chunk of plan.chunks) {
    const file = resolve(cwd, chunk.file);
    const result = await server.executeToolHandler(htmlTool, {
      ...erToolArgs(options),
      table: undefined,
      businessTerm: undefined,
      tables: chunk.tables,
      maxTables: chunk.tableCount
    }, {});
    const payload = parseHtmlPayload(result);
    writeErArtifact(file, payload.html, { overwrite: options.overwrite });
    written.push({
      index: chunk.index,
      file,
      tableCount: payload.tableCount ?? chunk.tableCount,
      relationshipCount: payload.relationshipCount,
      tables: chunk.tables
    });
  }
  const visibleRelationshipCount = sumVisibleRelationships(written);
  const warnings = [...plan.warnings];
  if (plan.chunks.length > 1) {
    warnings.push("Chunk files show relationships where both tables are present in the same chunk. Use a smaller manual scope when cross-chunk relationships must be inspected.");
  }
  if (
    typeof visibleRelationshipCount === "number" &&
    typeof plan.relationshipCount === "number" &&
    visibleRelationshipCount !== plan.relationshipCount
  ) {
    warnings.push(`Rendered chunk relationships (${visibleRelationshipCount}) differ from the planning estimate or limit (${plan.relationshipCount}). Use chunk stats for rendered ER files.`);
  }
  const summary: ErDirectorySummary = {
    mode: plan.mode,
    schema: plan.schema,
    rootTable: plan.rootTable,
    businessTerm: plan.businessTerm,
    format: plan.format,
    tableCount: plan.tableCount,
    relationshipCount: visibleRelationshipCount ?? plan.relationshipCount,
    plannedRelationshipCount: plan.relationshipCount,
    chunkCount: plan.chunks.length,
    chunkSize: plan.chunkSize,
    chunks: written.map((chunk) => ({
      ...chunk,
      file: toPosixPath(relative(outputRoot, chunk.file))
    })),
    tablePages: tablePages.map((page) => ({
      table: page.table,
      file: toPosixPath(relative(outputRoot, page.absoluteFile)),
      chunkFile: toPosixPath(relative(outputRoot, page.chunkFile))
    })),
    warnings,
    generatedAt: new Date().toISOString()
  };
  writeErArtifact(resolve(outputRoot, "index.html"), renderErExportIndexHtml(summary), { overwrite: options.overwrite });
  writeErArtifact(resolve(outputRoot, "overview.html"), renderErExportOverviewHtml(summary), { overwrite: options.overwrite });
  writeErArtifact(resolve(outputRoot, "metadata/er-summary.json"), `${JSON.stringify(summary, null, 2)}\n`, { overwrite: options.overwrite });
  writeErArtifact(resolve(outputRoot, "metadata/relationships.json"), `${JSON.stringify({
    relationshipCount: summary.relationshipCount,
    visibleRelationshipCount: summary.relationshipCount,
    plannedRelationshipCount: summary.plannedRelationshipCount,
    chunks: summary.chunks.map((chunk) => ({
      index: chunk.index,
      file: chunk.file,
      tableCount: chunk.tableCount,
      relationshipCount: chunk.relationshipCount
    })),
    note: "relationshipCount is the sum of relationships rendered inside chunk HTML files. Relationship details are embedded in each chunk HTML artifact."
  }, null, 2)}\n`, { overwrite: options.overwrite });
  writeErArtifact(resolve(outputRoot, "metadata/warnings.json"), `${JSON.stringify(summary.warnings, null, 2)}\n`, { overwrite: options.overwrite });
  for (const page of tablePages) {
    writeErArtifact(page.absoluteFile, renderErExportTableHtml({
      table: page.table,
      chunkFile: toPosixPath(relative(dirname(page.absoluteFile), page.chunkFile)),
      indexFile: toPosixPath(relative(dirname(page.absoluteFile), resolve(outputRoot, "index.html")))
    }), { overwrite: options.overwrite });
  }

  console.log(JSON.stringify({
    ok: true,
    directory: outputRoot,
    index: resolve(outputRoot, "index.html"),
    overview: resolve(outputRoot, "overview.html"),
    metadata: resolve(outputRoot, "metadata/er-summary.json"),
    format: plan.format,
    chunkCount: plan.chunks.length,
    tableCount: plan.tableCount,
    tablePageCount: tablePages.length,
    files: written
  }, null, 2));
  return 0;
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

function parsePlanPayload(result: { content?: Array<{ text?: string }> }): ParsedErPlan {
  const text = result.content?.[0]?.text;
  if (!text) {
    throw new Error("ob_plan_er_export returned an empty response.");
  }
  const payload = JSON.parse(text) as {
    mode?: unknown;
    schema?: unknown;
    rootTable?: unknown;
    businessTerm?: unknown;
    format?: string;
    tableCount?: number;
    relationshipCount?: number;
    chunkSize?: number;
    warnings?: unknown;
    chunks?: unknown;
  };
  if (!Array.isArray(payload.chunks)) {
    throw new Error("ob_plan_er_export did not return export chunks.");
  }
  return {
    mode: typeof payload.mode === "string" ? payload.mode : undefined,
    schema: typeof payload.schema === "string" ? payload.schema : undefined,
    rootTable: typeof payload.rootTable === "string" ? payload.rootTable : undefined,
    businessTerm: typeof payload.businessTerm === "string" ? payload.businessTerm : undefined,
    format: payload.format,
    tableCount: payload.tableCount,
    relationshipCount: payload.relationshipCount,
    chunkSize: payload.chunkSize,
    warnings: Array.isArray(payload.warnings) ? payload.warnings.filter((item): item is string => typeof item === "string") : [],
    chunks: payload.chunks.map((chunk) => {
      const record = chunk as { index?: unknown; tableCount?: unknown; tables?: unknown; file?: unknown };
      if (!Array.isArray(record.tables) || typeof record.file !== "string") {
        throw new Error("ob_plan_er_export returned an invalid chunk.");
      }
      return {
        index: typeof record.index === "number" ? record.index : 0,
        tableCount: typeof record.tableCount === "number" ? record.tableCount : record.tables.length,
        tables: record.tables.filter((table): table is string => typeof table === "string" && table.trim().length > 0),
        file: record.file
      };
    })
  };
}

function planTablePages(plan: ParsedErPlan, cwd: string, outputRoot: string): Array<{ table: string; absoluteFile: string; chunkFile: string }> {
  const used = new Set<string>();
  const pages: Array<{ table: string; absoluteFile: string; chunkFile: string }> = [];
  for (const chunk of plan.chunks) {
    const chunkFile = resolve(cwd, chunk.file);
    for (const table of chunk.tables) {
      const baseName = safeFileName(table);
      let fileName = `${baseName}.html`;
      let suffix = 2;
      while (used.has(fileName)) {
        fileName = `${baseName}-${suffix}.html`;
        suffix += 1;
      }
      used.add(fileName);
      pages.push({
        table,
        absoluteFile: resolve(outputRoot, "tables", fileName),
        chunkFile
      });
    }
  }
  return pages;
}

function sumVisibleRelationships(chunks: ErDirectoryChunk[]): number | undefined {
  if (chunks.some((chunk) => typeof chunk.relationshipCount !== "number")) {
    return undefined;
  }
  return chunks.reduce((sum, chunk) => sum + (chunk.relationshipCount ?? 0), 0);
}

export function renderErExportIndexHtml(summary: ErDirectorySummary): string {
  const chunkRows = summary.chunks.map((chunk) => `<tr>
    <td>${chunk.index}</td>
    <td><a href="${escapeHtml(chunk.file)}">${escapeHtml(chunk.file)}</a></td>
    <td>${chunk.tableCount}</td>
    <td>${chunk.relationshipCount ?? ""}</td>
  </tr>`).join("");
  const tableRows = summary.tablePages.slice(0, 500).map((page) => `<tr>
    <td>${escapeHtml(page.table)}</td>
    <td><a href="${escapeHtml(page.file)}">table page</a></td>
    <td><a href="${escapeHtml(page.chunkFile)}">chunk</a></td>
  </tr>`).join("");
  return renderExportShell("OceanBase ER Export", `
    <section class="hero">
      <h1>OceanBase ER Export</h1>
      <p>${escapeHtml(summary.schema ? `Schema: ${summary.schema}` : "Local ER export")}</p>
    </section>
    ${renderSummaryStats(summary)}
    ${renderWarnings(summary.warnings)}
    <section>
      <h2>Files</h2>
      <ul>
        <li><a href="overview.html">overview.html</a></li>
        <li><a href="metadata/er-summary.json">metadata/er-summary.json</a></li>
        <li><a href="metadata/relationships.json">metadata/relationships.json</a></li>
        <li><a href="metadata/warnings.json">metadata/warnings.json</a></li>
      </ul>
    </section>
    <section>
      <h2>Chunks</h2>
      <table><thead><tr><th>#</th><th>File</th><th>Tables</th><th>Relationships</th></tr></thead><tbody>${chunkRows}</tbody></table>
    </section>
    <section>
      <h2>Tables</h2>
      <table><thead><tr><th>Table</th><th>Page</th><th>Chunk</th></tr></thead><tbody>${tableRows}</tbody></table>
    </section>`);
}

export function renderErExportOverviewHtml(summary: ErDirectorySummary): string {
  const chunkList = summary.chunks.map((chunk) => `<li><a href="${escapeHtml(chunk.file)}">Chunk ${chunk.index}</a>: ${chunk.tableCount} table(s), ${chunk.relationshipCount ?? 0} relationship(s)</li>`).join("");
  return renderExportShell("OceanBase ER Overview", `
    <section class="hero">
      <h1>OceanBase ER Overview</h1>
      <p>Open a chunk for the diagram, or use table pages to jump from a table name to its chunk.</p>
    </section>
    ${renderSummaryStats(summary)}
    ${renderWarnings(summary.warnings)}
    <section>
      <h2>Chunk Navigation</h2>
      <ul>${chunkList}</ul>
    </section>
    <section>
      <h2>Notes</h2>
      <p>The export is metadata-only. It does not read table data and does not execute database changes.</p>
    </section>`);
}

export function renderErExportTableHtml(input: { table: string; chunkFile: string; indexFile: string }): string {
  return renderExportShell(`Table ${input.table}`, `
    <section class="hero">
      <h1>${escapeHtml(input.table)}</h1>
      <p>This table is included in the linked ER chunk.</p>
    </section>
    <section>
      <h2>Links</h2>
      <ul>
        <li><a href="${escapeHtml(input.chunkFile)}">Open ER chunk</a></li>
        <li><a href="${escapeHtml(input.indexFile)}">Back to index</a></li>
      </ul>
    </section>`);
}

function renderSummaryStats(summary: ErDirectorySummary): string {
  const stats = [
    ["Mode", summary.mode ?? ""],
    ["Schema", summary.schema ?? ""],
    ["Format", summary.format ?? ""],
    ["Tables", String(summary.tableCount ?? summary.tablePages.length)],
    ["Relationships", String(summary.relationshipCount ?? "")],
    [
      "Planned relationships",
      typeof summary.plannedRelationshipCount === "number" &&
        summary.plannedRelationshipCount !== summary.relationshipCount
        ? String(summary.plannedRelationshipCount)
        : ""
    ],
    ["Chunks", String(summary.chunkCount)],
    ["Generated", summary.generatedAt]
  ].filter(([, value]) => value);
  return `<section>
    <h2>Summary</h2>
    <div class="stats">${stats.map(([label, value]) => `<div><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`).join("")}</div>
  </section>`;
}

function renderWarnings(warnings: string[]): string {
  if (warnings.length === 0) {
    return "";
  }
  return `<section class="warnings">
    <h2>Warnings (${warnings.length})</h2>
    <ul>${warnings.map((warning) => `<li>${escapeHtml(warning)}</li>`).join("")}</ul>
  </section>`;
}

function renderExportShell(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <style>
    :root { color-scheme: light; --bg: #f5f7f9; --panel: #fff; --text: #16202a; --muted: #607080; --line: #d8e0e8; --accent: #0f766e; --warn: #8a5a00; --warn-bg: #fff6db; }
    * { box-sizing: border-box; }
    body { margin: 0; background: var(--bg); color: var(--text); font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    main { max-width: 1180px; margin: 0 auto; padding: 24px; }
    section { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 16px; margin-bottom: 16px; }
    .hero { border-left: 4px solid var(--accent); }
    h1 { margin: 0 0 8px; font-size: 24px; letter-spacing: 0; }
    h2 { margin: 0 0 12px; font-size: 16px; letter-spacing: 0; }
    p { margin: 0; color: var(--muted); }
    a { color: var(--accent); text-decoration: none; }
    a:hover { text-decoration: underline; }
    table { width: 100%; border-collapse: collapse; border: 1px solid var(--line); }
    th, td { padding: 8px 10px; border-bottom: 1px solid var(--line); text-align: left; vertical-align: top; }
    th { background: #eef3f6; }
    .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 10px; }
    .stats div { border: 1px solid var(--line); border-radius: 6px; padding: 10px; background: #fafbfc; }
    .stats span { display: block; color: var(--muted); font-size: 12px; }
    .stats strong { display: block; margin-top: 4px; overflow-wrap: anywhere; }
    .warnings { border-color: #f0cf84; background: var(--warn-bg); color: var(--warn); max-height: 240px; overflow: auto; }
    .warnings ul { margin-bottom: 0; }
  </style>
</head>
<body>
  <main>${body}</main>
</body>
</html>`;
}

function toPosixPath(value: string): string {
  return value.split(sep).join("/");
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
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
