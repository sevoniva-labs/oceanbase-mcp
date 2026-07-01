import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { extname, join, relative, resolve } from "node:path";

import { assertReadOnlySql, hasPaginationClause } from "./sql.js";

export type ScanSqlFormat = "json" | "text";

export interface ScanSqlOptions {
  cwd?: string;
  paths?: string[];
  ignore?: string[];
  extensions?: string[];
  maxFiles?: number;
  maxBytes?: number;
  format?: ScanSqlFormat;
  failOnRisk?: boolean;
}

export interface SqlScanFinding {
  file: string;
  line: number;
  source: "sql_file" | "xml_mapper" | "code_string";
  language: string;
  statementType: string;
  readOnlyCandidate: boolean;
  tables: string[];
  risks: string[];
  warnings: string[];
  sql: string;
}

export interface SqlScanReport {
  root: string;
  scannedFiles: number;
  skippedFiles: number;
  snippetCount: number;
  summary: {
    readOnlyCandidates: number;
    riskySnippets: number;
    byType: Record<string, number>;
    risks: Record<string, number>;
  };
  findings: SqlScanFinding[];
  warnings: string[];
  limits: {
    maxFiles: number;
    maxBytes: number;
    extensions: string[];
    ignore: string[];
  };
}

interface CandidateFile {
  absPath: string;
  relPath: string;
  ext: string;
}

interface RawSnippet {
  line: number;
  source: SqlScanFinding["source"];
  sql: string;
  dynamic: boolean;
}

const DEFAULT_EXTENSIONS = [".sql", ".xml", ".ts", ".js", ".java"];
const DEFAULT_IGNORE = [
  ".git",
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".next",
  "target"
];
const DEFAULT_MAX_FILES = 500;
const DEFAULT_MAX_BYTES = 512 * 1024;
const SQL_KEYWORD_PATTERN = /\b(select|with|explain|show|describe|insert|update|delete|merge|create|alter|drop|truncate)\b/i;

export async function runScanSqlCommand(args: string[], cwd = process.cwd()): Promise<number> {
  try {
    const options = parseScanSqlArgs(args);
    const report = scanSqlProject({ ...options, cwd });
    if ((options.format ?? "json") === "text") {
      console.log(renderScanSqlText(report));
    } else {
      console.log(JSON.stringify(report, null, 2));
    }
    return options.failOnRisk && report.summary.riskySnippets > 0 ? 2 : 0;
  } catch (error) {
    console.error(JSON.stringify({
      ok: false,
      error: (error as Error).message
    }, null, 2));
    return 1;
  }
}

export function parseScanSqlArgs(args: string[]): ScanSqlOptions {
  const options: ScanSqlOptions = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--fail-on-risk") {
      options.failOnRisk = true;
      continue;
    }
    const [name, inlineValue] = arg.includes("=") ? arg.split(/=(.*)/s, 2) : [arg, undefined];
    if (!name.startsWith("--")) {
      throw new Error(`Unknown scan-sql argument: ${arg}`);
    }
    const value = inlineValue ?? args[index + 1];
    if (inlineValue == null) {
      index += 1;
    }
    if (!value || value.startsWith("--")) {
      throw new Error(`Missing value for ${name}`);
    }
    switch (name) {
      case "--path":
        options.paths = [...(options.paths ?? []), ...splitCsv(value)];
        break;
      case "--ignore":
        options.ignore = [...(options.ignore ?? []), ...splitCsv(value)];
        break;
      case "--extensions":
      case "--ext":
        options.extensions = splitCsv(value).map(normalizeExtension);
        break;
      case "--max-files":
        options.maxFiles = parsePositiveInt(value, name, 10_000);
        break;
      case "--max-bytes":
        options.maxBytes = parsePositiveInt(value, name, 10 * 1024 * 1024);
        break;
      case "--format":
        options.format = parseScanSqlFormat(value);
        break;
      default:
        throw new Error(`Unknown scan-sql argument: ${name}`);
    }
  }
  return options;
}

export function scanSqlProject(options: ScanSqlOptions = {}): SqlScanReport {
  const root = resolve(options.cwd ?? process.cwd());
  const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const extensions = (options.extensions ?? DEFAULT_EXTENSIONS).map(normalizeExtension);
  const ignore = [...DEFAULT_IGNORE, ...(options.ignore ?? [])];
  const warnings: string[] = [];
  const files = collectCandidateFiles(root, options.paths ?? ["."], extensions, ignore, maxFiles, warnings);
  const findings: SqlScanFinding[] = [];
  let skippedFiles = 0;

  for (const file of files) {
    const stat = lstatSync(file.absPath);
    if (stat.size > maxBytes) {
      skippedFiles += 1;
      warnings.push(`${file.relPath} was skipped because it exceeds maxBytes.`);
      continue;
    }
    const content = readFileSync(file.absPath, "utf8");
    for (const snippet of extractSqlSnippets(file.ext, content)) {
      const finding = classifySqlSnippet(file, snippet);
      if (finding) {
        findings.push(finding);
      }
    }
  }

  return {
    root,
    scannedFiles: files.length,
    skippedFiles,
    snippetCount: findings.length,
    summary: summarizeScan(findings),
    findings,
    warnings,
    limits: {
      maxFiles,
      maxBytes,
      extensions,
      ignore
    }
  };
}

export function renderScanSqlText(report: SqlScanReport): string {
  const lines = [
    `root: ${report.root}`,
    `files: ${report.scannedFiles}`,
    `snippets: ${report.snippetCount}`,
    `risky: ${report.summary.riskySnippets}`
  ];
  for (const finding of report.findings) {
    lines.push("");
    lines.push(`${finding.file}:${finding.line} ${finding.statementType} ${finding.readOnlyCandidate ? "read-only" : "blocked"}`);
    if (finding.tables.length > 0) {
      lines.push(`tables: ${finding.tables.join(", ")}`);
    }
    if (finding.risks.length > 0) {
      lines.push(`risks: ${finding.risks.join(", ")}`);
    }
    if (finding.warnings.length > 0) {
      lines.push(`warnings: ${finding.warnings.join(", ")}`);
    }
    lines.push(finding.sql);
  }
  if (report.warnings.length > 0) {
    lines.push("");
    lines.push("scan warnings:");
    lines.push(...report.warnings.map((warning) => `- ${warning}`));
  }
  return lines.join("\n");
}

function collectCandidateFiles(
  root: string,
  inputPaths: string[],
  extensions: string[],
  ignore: string[],
  maxFiles: number,
  warnings: string[]
): CandidateFile[] {
  const files: CandidateFile[] = [];
  for (const inputPath of inputPaths) {
    const absPath = resolve(root, inputPath);
    if (!existsSync(absPath)) {
      warnings.push(`${inputPath} does not exist and was skipped.`);
      continue;
    }
    walkCandidatePath(root, absPath, extensions, ignore, maxFiles, files, warnings);
  }
  return files;
}

function walkCandidatePath(
  root: string,
  absPath: string,
  extensions: string[],
  ignore: string[],
  maxFiles: number,
  files: CandidateFile[],
  warnings: string[]
): void {
  if (files.length >= maxFiles) {
    return;
  }
  const relPath = normalizePath(relative(root, absPath) || ".");
  if (matchesIgnore(relPath, ignore)) {
    return;
  }
  const stat = lstatSync(absPath);
  if (stat.isSymbolicLink()) {
    return;
  }
  if (stat.isDirectory()) {
    for (const entry of readdirSync(absPath)) {
      walkCandidatePath(root, join(absPath, entry), extensions, ignore, maxFiles, files, warnings);
      if (files.length >= maxFiles) {
        warnings.push(`Only the first ${maxFiles} matching files were scanned.`);
        return;
      }
    }
    return;
  }
  if (!stat.isFile()) {
    return;
  }
  const ext = extname(absPath).toLowerCase();
  if (!extensions.includes(ext)) {
    return;
  }
  files.push({ absPath, relPath, ext });
}

function extractSqlSnippets(ext: string, content: string): RawSnippet[] {
  if (ext === ".sql") {
    return splitSqlStatements(content).map((item) => ({
      line: lineNumberAt(content, item.index),
      source: "sql_file" as const,
      sql: item.sql,
      dynamic: false
    }));
  }
  if (ext === ".xml") {
    return extractXmlMapperSql(content);
  }
  return extractCodeStringSql(content);
}

function extractXmlMapperSql(content: string): RawSnippet[] {
  const snippets: RawSnippet[] = [];
  const pattern = /<(select|insert|update|delete)\b[^>]*>([\s\S]*?)<\/\1>/gi;
  for (const match of content.matchAll(pattern)) {
    const body = match[2] ?? "";
    const sql = normalizeSqlText(stripXmlTags(body));
    if (!sql || !SQL_KEYWORD_PATTERN.test(sql)) {
      continue;
    }
    snippets.push({
      line: lineNumberAt(content, match.index ?? 0),
      source: "xml_mapper",
      sql,
      dynamic: /<\s*(if|choose|foreach|where|trim|set)\b/i.test(body) || /[#\$]\{/.test(body)
    });
  }
  return snippets;
}

function extractCodeStringSql(content: string): RawSnippet[] {
  const snippets: RawSnippet[] = [];
  const stringPattern = /`(?:\\[\s\S]|[^`\\])*`|'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"/g;
  for (const match of content.matchAll(stringPattern)) {
    const raw = match[0] ?? "";
    const body = raw.slice(1, -1);
    const sql = normalizeSqlText(unescapeCodeString(body));
    if (!sql || !SQL_KEYWORD_PATTERN.test(sql)) {
      continue;
    }
    snippets.push({
      line: lineNumberAt(content, match.index ?? 0),
      source: "code_string",
      sql,
      dynamic: raw.startsWith("`") && /\$\{/.test(body)
    });
  }
  return snippets;
}

function classifySqlSnippet(file: CandidateFile, snippet: RawSnippet): SqlScanFinding | undefined {
  const sql = normalizeSqlText(snippet.sql);
  if (!sql || !SQL_KEYWORD_PATTERN.test(sql)) {
    return undefined;
  }
  const statementType = firstSqlKeyword(sql) ?? "unknown";
  const risks: string[] = [];
  const warnings: string[] = [];
  let readOnlyCandidate = true;
  try {
    assertReadOnlySql(sql);
  } catch (error) {
    readOnlyCandidate = false;
    risks.push("not_read_only");
    warnings.push((error as Error).message);
  }
  if (/\bselect\s+\*/i.test(sql) || /,\s*\*/.test(sql)) {
    risks.push("select_star");
  }
  if ((statementType === "select" || statementType === "with") && !hasPaginationClause(sql)) {
    risks.push("missing_pagination");
  }
  if (snippet.dynamic) {
    warnings.push("SQL contains dynamic placeholders or template interpolation; review the rendered SQL before execution.");
  }
  if (/\border\s+by\b/i.test(sql) === false && hasPaginationClause(sql)) {
    warnings.push("Pagination without ORDER BY may produce unstable pages.");
  }
  return {
    file: file.relPath,
    line: snippet.line,
    source: snippet.source,
    language: languageFromExtension(file.ext),
    statementType,
    readOnlyCandidate,
    tables: extractTableRefs(sql),
    risks: uniqueStrings(risks),
    warnings: uniqueStrings(warnings),
    sql: truncateSql(sql)
  };
}

function summarizeScan(findings: SqlScanFinding[]): SqlScanReport["summary"] {
  const byType: Record<string, number> = {};
  const risks: Record<string, number> = {};
  for (const finding of findings) {
    byType[finding.statementType] = (byType[finding.statementType] ?? 0) + 1;
    for (const risk of finding.risks) {
      risks[risk] = (risks[risk] ?? 0) + 1;
    }
  }
  return {
    readOnlyCandidates: findings.filter((finding) => finding.readOnlyCandidate).length,
    riskySnippets: findings.filter((finding) => finding.risks.length > 0).length,
    byType,
    risks
  };
}

function splitSqlStatements(content: string): Array<{ sql: string; index: number }> {
  const statements: Array<{ sql: string; index: number }> = [];
  let current = "";
  let startIndex = 0;
  let quote: string | undefined;
  for (let i = 0; i < content.length; i += 1) {
    const char = content[i];
    if (quote) {
      current += char;
      if (char === quote) {
        quote = undefined;
      } else if (char === "\\") {
        i += 1;
        current += content[i] ?? "";
      }
      continue;
    }
    if (char === "'" || char === '"' || char === "`") {
      quote = char;
      current += char;
      continue;
    }
    if (char === ";") {
      const sql = normalizeSqlText(current);
      if (sql && SQL_KEYWORD_PATTERN.test(sql)) {
        statements.push({ sql, index: startIndex });
      }
      current = "";
      startIndex = i + 1;
      continue;
    }
    current += char;
  }
  const sql = normalizeSqlText(current);
  if (sql && SQL_KEYWORD_PATTERN.test(sql)) {
    statements.push({ sql, index: startIndex });
  }
  return statements;
}

function stripXmlTags(value: string): string {
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/<[^>]+>/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function unescapeCodeString(value: string): string {
  return value
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "\r")
    .replace(/\\t/g, "\t")
    .replace(/\\"/g, "\"")
    .replace(/\\'/g, "'")
    .replace(/\\\\/g, "\\");
}

function extractTableRefs(sql: string): string[] {
  const refs: string[] = [];
  const pattern = /\b(?:from|join|into|update|table)\s+((?:"[^"]+"|`[^`]+`|[A-Za-z_][\w$#]*)(?:\s*\.\s*(?:"[^"]+"|`[^`]+`|[A-Za-z_][\w$#]*)){0,2})/gi;
  for (const match of sql.matchAll(pattern)) {
    const raw = (match[1] ?? "").replace(/\s+/g, "");
    const normalized = raw.replace(/[`"]/g, "");
    if (normalized && normalized.toLowerCase() !== "select") {
      refs.push(normalized);
    }
  }
  return uniqueStrings(refs).slice(0, 20);
}

function firstSqlKeyword(sql: string): string | undefined {
  return /^[\s(]*(select|with|explain|show|describe|insert|update|delete|merge|create|alter|drop|truncate)\b/i.exec(sql)?.[1]?.toLowerCase();
}

function lineNumberAt(content: string, index: number): number {
  return content.slice(0, index).split(/\r?\n/).length;
}

function normalizeSqlText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function truncateSql(sql: string): string {
  return sql.length > 500 ? `${sql.slice(0, 500)}...` : sql;
}

function languageFromExtension(ext: string): string {
  return ext.slice(1) || "text";
}

function splitCsv(value: string): string[] {
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

function normalizeExtension(value: string): string {
  const trimmed = value.trim().toLowerCase();
  return trimmed.startsWith(".") ? trimmed : `.${trimmed}`;
}

function parseScanSqlFormat(value: string): ScanSqlFormat {
  if (value === "json" || value === "text") {
    return value;
  }
  throw new Error("--format must be json or text.");
}

function parsePositiveInt(value: string, name: string, max: number): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > max) {
    throw new Error(`${name} must be an integer between 1 and ${max}.`);
  }
  return parsed;
}

function matchesIgnore(relPath: string, patterns: string[]): boolean {
  return patterns.some((pattern) => matchPathPattern(relPath, normalizePath(pattern)));
}

function matchPathPattern(relPath: string, pattern: string): boolean {
  if (!pattern) {
    return false;
  }
  if (!/[?*]/.test(pattern)) {
    return relPath === pattern || relPath.startsWith(`${pattern}/`) || relPath.includes(`/${pattern}/`);
  }
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, ".*")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`).test(relPath);
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\/+/, "");
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}
