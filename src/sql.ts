import type { CompatibilityMode } from "./config.js";
import type { SqlParam } from "./db.js";

const READONLY_START_KEYWORDS = new Set(["select", "explain", "with"]);
const EXPLAIN_TARGET_KEYWORDS = new Set(["select", "with"]);

const DANGEROUS_READ_PATTERNS = [
  /\binto\s+outfile\b/i,
  /\binto\s+dumpfile\b/i,
  /\binto\s+@[\w$]+\b/i,
  /\binto\s+(?:local\s+)?[A-Za-z_][\w$]*(?:\s*,|\s*(?:from|$))/i,
  /\bload_file\s*\(/i,
  /\bfor\s+update\b/i,
  /\bget_lock\s*\(/i,
  /\brelease_lock\s*\(/i,
  /\bsleep\s*\(/i,
  /\bbenchmark\s*\(/i,
  /\bnextval\b/i,
  /@[\w$]+\s*:=/i
];

const SELECT_SIDE_EFFECT_KEYWORDS =
  /\b(insert|update|delete|replace|merge|create|alter|drop|truncate|rename|grant|revoke|call|begin|commit|rollback|savepoint|load|lock|unlock|kill)\b/i;
const MYSQL_EXECUTABLE_COMMENT_PATTERN = /\/\*!/i;

export interface SqlLimitOptions {
  maxSqlLength: number;
  maxParamCount: number;
}

export interface PagedSqlOptions {
  page: number;
  pageSize: number;
  fetchRows: number;
  orderBy?: string;
}

export function assertSqlInputLimits(sql: string, params: SqlParam[], options: SqlLimitOptions): void {
  if (sql.length > options.maxSqlLength) {
    throw new Error(`SQL length ${sql.length} exceeds configured limit ${options.maxSqlLength}.`);
  }

  if (params.length > options.maxParamCount) {
    throw new Error(`SQL parameter count ${params.length} exceeds configured limit ${options.maxParamCount}.`);
  }
}

export function assertReadOnlySql(sql: string): void {
  const normalized = trimSql(sql);
  if (!normalized) {
    throw new Error("SQL cannot be empty.");
  }

  if (hasMultipleStatements(normalized)) {
    throw new Error("Multiple SQL statements are not allowed.");
  }

  if (MYSQL_EXECUTABLE_COMMENT_PATTERN.test(normalized)) {
    throw new Error("MySQL executable comments are not allowed.");
  }

  const code = codeOnly(normalized);
  const keyword = firstKeywordFromCode(code);
  if (!keyword || !READONLY_START_KEYWORDS.has(keyword)) {
    throw new Error(
      `Only read-only SQL is allowed here. Got "${keyword ?? "unknown"}"; this MCP server has no write execution tool.`
    );
  }

  if (/^\s*explain\s+analyze\b/i.test(code)) {
    throw new Error("EXPLAIN ANALYZE is not allowed because it may execute the query.");
  }

  if (keyword === "explain") {
    const targetCode = explainTargetCode(code);
    const targetKeyword = firstKeywordFromCode(targetCode);
    if (!targetKeyword || !EXPLAIN_TARGET_KEYWORDS.has(targetKeyword)) {
      throw new Error("EXPLAIN is allowed only for SELECT or WITH statements.");
    }
    if (SELECT_SIDE_EFFECT_KEYWORDS.test(targetCode)) {
      throw new Error("Read-only SQL contains a write/control keyword and was blocked.");
    }
  }

  if ((keyword === "select" || keyword === "with") && SELECT_SIDE_EFFECT_KEYWORDS.test(code)) {
    throw new Error("Read-only SQL contains a write/control keyword and was blocked.");
  }

  for (const pattern of DANGEROUS_READ_PATTERNS) {
    if (pattern.test(code)) {
      throw new Error("Read-only SQL contains a blocked side-effect or filesystem access pattern.");
    }
  }
}

export function assertSingleStatement(sql: string): void {
  const normalized = trimSql(sql);
  if (!normalized) {
    throw new Error("SQL cannot be empty.");
  }
  if (hasMultipleStatements(normalized)) {
    throw new Error("Multiple SQL statements are not allowed.");
  }
}

export function prepareReadOnlySql(sql: string, maxRows: number, mode: CompatibilityMode): string {
  assertReadOnlySql(sql);

  const normalized = trimTrailingSemicolons(trimSql(sql));
  const code = codeOnly(normalized);
  const keyword = firstKeywordFromCode(code);
  if (keyword !== "select" && keyword !== "with") {
    return normalized;
  }

  const fetchRows = maxRows + 1;
  if (mode === "oracle") {
    return `SELECT * FROM (${normalized}) WHERE ROWNUM <= ${fetchRows}`;
  }

  return `SELECT * FROM (${normalized}) AS ob_mcp_limited LIMIT ${fetchRows}`;
}

export function buildExplainSql(sql: string): string {
  const normalized = trimTrailingSemicolons(trimSql(sql));
  if (!normalized) {
    throw new Error("SQL cannot be empty.");
  }
  if (/^\s*explain\b/i.test(codeOnly(normalized))) {
    return normalized;
  }
  return `EXPLAIN ${normalized}`;
}

export function buildPagedReadOnlySql(sql: string, mode: CompatibilityMode, options: PagedSqlOptions): string {
  const normalized = trimTrailingSemicolons(trimSql(sql));
  if (!normalized) {
    throw new Error("SQL cannot be empty.");
  }
  const code = codeOnly(normalized);
  const keyword = firstKeywordFromCode(code);
  if (keyword !== "select" && keyword !== "with") {
    throw new Error("Paged queries require SELECT or WITH SQL.");
  }
  if (hasPaginationClause(code)) {
    throw new Error("Paged query input must not already contain LIMIT, OFFSET/FETCH, or ROWNUM pagination.");
  }
  const hasOrderBy = /\border\s+by\b/i.test(code);
  const orderBy = options.orderBy?.trim();
  if (orderBy && hasOrderBy) {
    throw new Error("Do not pass orderBy when SQL already contains ORDER BY.");
  }
  if (orderBy) {
    assertSafeOrderByClause(orderBy);
  }

  const orderClause = orderBy && !hasOrderBy ? ` ORDER BY ${orderBy}` : "";
  const offset = (options.page - 1) * options.pageSize;
  if (mode === "oracle") {
    return `${normalized}${orderClause} OFFSET ${offset} ROWS FETCH NEXT ${options.fetchRows} ROWS ONLY`;
  }
  return `${normalized}${orderClause} LIMIT ${options.fetchRows} OFFSET ${offset}`;
}

export function hasPaginationClause(sql: string): boolean {
  return /\blimit\s+\d+/i.test(sql) || /\boffset\s+\d+\s+rows\b/i.test(sql) || /\bfetch\s+(?:first|next)\s+\d+\s+rows\b/i.test(sql) || /\brownum\b/i.test(sql);
}

export function assertSafeOrderByClause(orderBy: string): void {
  const identifier = String.raw`(?:` + "`[^`]+`" + String.raw`|"(?:""|[^"])+"|[A-Za-z_][\w$]*)`;
  const item = String.raw`${identifier}(?:\s*\.\s*${identifier}){0,2}(?:\s+(?:ASC|DESC))?(?:\s+NULLS\s+(?:FIRST|LAST))?`;
  const pattern = new RegExp(String.raw`^\s*${item}(?:\s*,\s*${item})*\s*$`, "i");
  if (!pattern.test(orderBy)) {
    throw new Error("orderBy must contain only identifiers, optional ASC/DESC, optional NULLS FIRST/LAST, and commas.");
  }
}

function trimSql(sql: string): string {
  return sql.trim();
}

function trimTrailingSemicolons(sql: string): string {
  let output = sql.trim();
  while (output.endsWith(";")) {
    output = output.slice(0, -1).trimEnd();
  }
  return output;
}

function firstKeywordFromCode(code: string): string | undefined {
  return /^[\s(]*([a-zA-Z]+)/.exec(code)?.[1]?.toLowerCase();
}

function explainTargetCode(code: string): string {
  let rest = code.replace(/^[\s(]*explain\b/i, "").trimStart();

  for (;;) {
    const option = /^(?:extended|partitions)\b/i.exec(rest);
    if (option) {
      rest = rest.slice(option[0].length).trimStart();
      continue;
    }

    const format = /^format\s*=\s*(?:json|traditional|tree)\b/i.exec(rest);
    if (format) {
      rest = rest.slice(format[0].length).trimStart();
      continue;
    }

    return rest;
  }
}

function hasMultipleStatements(sql: string): boolean {
  let state: ScanState = "code";

  for (let i = 0; i < sql.length; i += 1) {
    const char = sql[i];
    const next = sql[i + 1];

    if (state === "code") {
      if (char === "'" || char === '"' || char === "`") {
        state = quoteState(char);
        continue;
      }
      if (char === "-" && next === "-") {
        state = "lineComment";
        i += 1;
        continue;
      }
      if (char === "#") {
        state = "lineComment";
        continue;
      }
      if (char === "/" && next === "*") {
        state = "blockComment";
        i += 1;
        continue;
      }
      if (char === ";" && containsCode(sql.slice(i + 1))) {
        return true;
      }
      continue;
    }

    if (state === "lineComment") {
      if (char === "\n" || char === "\r") {
        state = "code";
      }
      continue;
    }

    if (state === "blockComment") {
      if (char === "*" && next === "/") {
        state = "code";
        i += 1;
      }
      continue;
    }

    if (isQuoteState(state)) {
      if (char === "\\" && state !== "backtick") {
        i += 1;
        continue;
      }
      if (isQuoteEnd(state, char)) {
        if ((state === "singleQuote" || state === "doubleQuote") && next === char) {
          i += 1;
          continue;
        }
        state = "code";
      }
    }
  }

  return false;
}

function containsCode(sql: string): boolean {
  return codeOnly(sql).replace(/;/g, "").trim().length > 0;
}

function codeOnly(sql: string): string {
  let state: ScanState = "code";
  let output = "";

  for (let i = 0; i < sql.length; i += 1) {
    const char = sql[i];
    const next = sql[i + 1];

    if (state === "code") {
      if (char === "'" || char === '"' || char === "`") {
        state = quoteState(char);
        output += " ";
        continue;
      }
      if (char === "-" && next === "-") {
        state = "lineComment";
        output += "  ";
        i += 1;
        continue;
      }
      if (char === "#") {
        state = "lineComment";
        output += " ";
        continue;
      }
      if (char === "/" && next === "*") {
        state = "blockComment";
        output += "  ";
        i += 1;
        continue;
      }
      output += char;
      continue;
    }

    output += char === "\n" || char === "\r" ? char : " ";

    if (state === "lineComment") {
      if (char === "\n" || char === "\r") {
        state = "code";
      }
      continue;
    }

    if (state === "blockComment") {
      if (char === "*" && next === "/") {
        output += " ";
        state = "code";
        i += 1;
      }
      continue;
    }

    if (isQuoteState(state)) {
      if (char === "\\" && state !== "backtick") {
        output += " ";
        i += 1;
        continue;
      }
      if (isQuoteEnd(state, char)) {
        if ((state === "singleQuote" || state === "doubleQuote") && next === char) {
          output += " ";
          i += 1;
          continue;
        }
        state = "code";
      }
    }
  }

  return output;
}

type ScanState = "code" | "singleQuote" | "doubleQuote" | "backtick" | "lineComment" | "blockComment";

function quoteState(char: string): ScanState {
  if (char === "'") {
    return "singleQuote";
  }
  if (char === '"') {
    return "doubleQuote";
  }
  return "backtick";
}

function isQuoteState(state: ScanState): state is "singleQuote" | "doubleQuote" | "backtick" {
  return state === "singleQuote" || state === "doubleQuote" || state === "backtick";
}

function isQuoteEnd(state: "singleQuote" | "doubleQuote" | "backtick", char: string): boolean {
  return (
    (state === "singleQuote" && char === "'") ||
    (state === "doubleQuote" && char === '"') ||
    (state === "backtick" && char === "`")
  );
}
