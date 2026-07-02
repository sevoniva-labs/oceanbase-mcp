import type { SqlUsageIndex } from "./sql-scan.js";

export interface FindSqlUsagesInput {
  schema?: string;
  table?: string;
  column?: string;
  businessTerm?: string;
  maxResults?: number;
}

export interface SqlUsageSearchResult {
  file: string;
  line: number;
  statementType: string;
  sqlSnippet: string;
  tables: string[];
  columns: string[];
  dynamicSql: {
    detected: boolean;
    sources: string[];
  };
  risks: string[];
  dialectHints: string[];
  evidence: string[];
  matchType: "table" | "column" | "business_term";
}

export interface SqlUsageSearchOutput {
  indexVersion?: string;
  generatedAt?: string;
  query: {
    schema?: string;
    table?: string;
    column?: string;
    businessTerm?: string;
  };
  matchCount: number;
  results: SqlUsageSearchResult[];
  warnings: string[];
  executed: false;
}

export function parseSqlUsageIndexInput(value: SqlUsageIndex | string | Record<string, unknown>, name = "sqlIndex"): SqlUsageIndex {
  const parsed = typeof value === "string" ? JSON.parse(value) : value;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${name} must be a SQL usage index object or JSON string.`);
  }
  const record = parsed as Partial<SqlUsageIndex>;
  if (!Array.isArray(record.entries)) {
    throw new Error(`${name} is not a valid SQL usage index.`);
  }
  return record as SqlUsageIndex;
}

export function findSqlUsages(
  sqlIndexInput: SqlUsageIndex | string | Record<string, unknown>,
  input: FindSqlUsagesInput
): SqlUsageSearchOutput {
  const sqlIndex = parseSqlUsageIndexInput(sqlIndexInput);
  if (!input.table && !input.column && !input.businessTerm) {
    throw new Error("Pass table, column, or businessTerm when finding SQL usages.");
  }
  const limit = Math.min(Math.max(input.maxResults ?? 50, 1), 200);
  const results: SqlUsageSearchResult[] = [];

  for (const entry of sqlIndex.entries) {
    const match = matchSqlUsageEntry(entry, input);
    if (!match) {
      continue;
    }
    results.push({
      file: entry.file,
      line: entry.line,
      statementType: entry.statementType,
      sqlSnippet: entry.sql,
      tables: entry.tables,
      columns: entry.columns,
      dynamicSql: entry.dynamicSql,
      risks: entry.risks,
      dialectHints: entry.dialectHints,
      evidence: match.evidence,
      matchType: match.matchType
    });
    if (results.length >= limit) {
      break;
    }
  }

  const warnings = [
    results.length >= limit ? `Only the first ${limit} SQL usages are returned.` : "",
    "SQL usage lookup is based on a static project index. Dynamic SQL may require manual confirmation.",
    "No SQL is executed and no project files are modified."
  ].filter(Boolean);

  return {
    indexVersion: sqlIndex.indexVersion,
    generatedAt: sqlIndex.generatedAt,
    query: {
      schema: input.schema,
      table: input.table,
      column: input.column,
      businessTerm: input.businessTerm
    },
    matchCount: results.length,
    results,
    warnings,
    executed: false
  };
}

function matchSqlUsageEntry(
  entry: SqlUsageIndex["entries"][number],
  input: FindSqlUsagesInput
): { matchType: SqlUsageSearchResult["matchType"]; evidence: string[] } | undefined {
  const evidence: string[] = [];
  if (input.table) {
    const matched = entry.tables.some((table) => tableMatches(input.schema, input.table!, table));
    if (matched) {
      evidence.push(`Matched table ${input.schema ? `${input.schema}.` : ""}${input.table}.`);
      return { matchType: "table", evidence };
    }
  }

  if (input.column) {
    const normalizedColumn = normalizeIdentifier(input.column);
    const matched = entry.columns.some((column) => normalizeIdentifier(column) === normalizedColumn);
    if (matched) {
      evidence.push(`Matched column ${input.column}.`);
      if (input.table && entry.tables.some((table) => tableMatches(input.schema, input.table!, table))) {
        evidence.push(`The same SQL snippet also references table ${input.table}.`);
      }
      return { matchType: "column", evidence };
    }
  }

  if (input.businessTerm) {
    const term = normalizeIdentifier(input.businessTerm);
    const haystack = [
      entry.sql,
      ...entry.tables,
      ...entry.columns
    ].join(" ").toLowerCase();
    if (haystack.includes(term)) {
      evidence.push(`Matched business term text "${input.businessTerm}" in SQL index metadata.`);
      return { matchType: "business_term", evidence };
    }
  }

  return undefined;
}

function tableMatches(schema: string | undefined, requestedTable: string, indexedTable: string): boolean {
  const requested = normalizeIdentifier(requestedTable);
  const indexedParts = indexedTable.split(".").map(normalizeIdentifier).filter(Boolean);
  const indexedTableName = indexedParts[indexedParts.length - 1] ?? "";
  if (indexedTableName !== requested) {
    return false;
  }
  if (!schema) {
    return true;
  }
  const indexedSchema = indexedParts.length > 1 ? indexedParts[indexedParts.length - 2] : undefined;
  return !indexedSchema || indexedSchema === normalizeIdentifier(schema);
}

function normalizeIdentifier(value: string): string {
  return value.trim().replace(/[`"]/g, "").toLowerCase();
}
