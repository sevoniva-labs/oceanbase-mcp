import type { ObConfig } from "../../config.js";
import { describeTable } from "../../db.js";
import {
  assertTableAccess,
  filterColumnMetadata
} from "../../policy.js";
import { queryShape } from "../../query/preview.js";
import { withQuerySlot, type selectRuntimeProfile } from "../../runtime.js";
import { metadataTableRef } from "../metadata-scope.js";
import { policyContext } from "../policy-context.js";
import {
  normalizeTableName,
  profileColumnMetadata
} from "./profile-utils.js";
import type { LintFinding } from "./sql-lint.js";
import type { ProjectQuerySource } from "./sql-snippet-source.js";

export interface SnippetMetadataValidation {
  tables: Array<{
    schema?: string;
    table: string;
    visible: boolean;
    visibleColumnCount: number;
    checkedColumns: string[];
    unknownColumns: string[];
    error?: string;
  }>;
  qualifiedColumnRefs: Array<{
    qualifier: string;
    column: string;
    schema?: string;
    table?: string;
    ok?: boolean;
  }>;
  bareColumnRefs: Array<{
    column: string;
    schema?: string;
    table?: string;
    ok?: boolean;
    ambiguous?: boolean;
  }>;
  warnings: string[];
}

export async function validateSnippetMetadata(
  selected: ReturnType<typeof selectRuntimeProfile>,
  sql: string,
  tableRefs: Array<{ schema?: string; table: string }>,
  fallbackSchema: string | undefined
): Promise<SnippetMetadataValidation> {
  const warnings = [
    "Metadata validation is conservative; complex expressions, nested queries, and dynamic SQL may require manual review."
  ];
  const tables: SnippetMetadataValidation["tables"] = [];
  const tableMetadata = new Map<string, { schema?: string; table: string; columns: Set<string> }>();

  for (const ref of uniqueTableRefs(tableRefs).slice(0, 10)) {
    const metadataRef = normalizedSnippetTableRef(selected.config, ref.schema ?? fallbackSchema, ref.table);
    try {
      assertTableAccess(metadataRef.schema, metadataRef.table, policyContext(selected.config));
      const rows = filterColumnMetadata(
        await withQuerySlot(selected, () =>
          describeTable(
            selected.pool,
            selected.config.compatibility,
            metadataRef.table,
            metadataRef.schema,
            selected.config.queryTimeoutMs
          )
        ),
        selected.config.policy
      );
      const columnNames = rows
        .map((row) => profileColumnMetadata(row, selected.config.compatibility)?.name)
        .filter((value): value is string => Boolean(value));
      tableMetadata.set(tableRefKey(selected.config.compatibility, metadataRef.schema, metadataRef.table), {
        schema: metadataRef.schema,
        table: metadataRef.table,
        columns: new Set(columnNames.map((column) => normalizeTableName(selected.config.compatibility, column)))
      });
      tables.push({
        schema: metadataRef.schema,
        table: metadataRef.table,
        visible: rows.length > 0,
        visibleColumnCount: rows.length,
        checkedColumns: [],
        unknownColumns: []
      });
    } catch (error) {
      tables.push({
        schema: metadataRef.schema,
        table: metadataRef.table,
        visible: false,
        visibleColumnCount: 0,
        checkedColumns: [],
        unknownColumns: [],
        error: (error as Error).message
      });
    }
  }

  if (tables.length === 0) {
    warnings.push("No table reference was parsed from the SQL snippet.");
  }

  const aliasMap = snippetAliasMap(sql, selected.config.compatibility, tableMetadata);
  const qualifiedColumnRefs = snippetQualifiedColumnRefs(sql, selected.config.compatibility, aliasMap, tableMetadata, tables);
  const bareColumnRefs = snippetBareColumnRefs(sql, selected.config.compatibility, tableMetadata, tables);

  return { tables, qualifiedColumnRefs, bareColumnRefs, warnings };
}

export function normalizedSnippetTableRef(config: ObConfig, schema: string | undefined, table: string): { schema?: string; table: string } {
  const ref = metadataTableRef(config, schema, table);
  if (config.compatibility !== "oracle") {
    return ref;
  }
  return {
    schema: ref.schema?.toUpperCase(),
    table: ref.table.toUpperCase()
  };
}

export function snippetMetadataFindings(metadata: SnippetMetadataValidation): LintFinding[] {
  const findings: LintFinding[] = [];
  for (const table of metadata.tables) {
    if (!table.visible) {
      findings.push({
        rule: "metadata_table_unavailable",
        severity: "high",
        message: `Table ${formatSchemaTable(table.schema, table.table)} is not visible or is blocked by policy.`,
        evidence: [table.error ?? formatSchemaTable(table.schema, table.table)]
      });
    }
    if (table.unknownColumns.length > 0) {
      findings.push({
        rule: "metadata_unknown_column",
        severity: "high",
        message: `SQL references columns that are not visible on ${formatSchemaTable(table.schema, table.table)}.`,
        evidence: table.unknownColumns.slice(0, 20)
      });
    }
  }

  for (const column of metadata.bareColumnRefs.filter((ref) => ref.ambiguous)) {
    findings.push({
      rule: "metadata_ambiguous_column",
      severity: "warn",
      message: `Column ${column.column} is visible on multiple referenced tables; qualify it before execution.`,
      evidence: [column.column]
    });
  }
  return findings;
}

export function snippetMetadataRecommendations(findings: LintFinding[]): string[] {
  const output: string[] = [];
  if (findings.some((finding) => finding.rule === "metadata_table_unavailable")) {
    output.push("Search visible schemas and tables before executing the snippet.");
  }
  if (findings.some((finding) => finding.rule === "metadata_unknown_column")) {
    output.push("Use ob_get_table_context or ob_find_columns to confirm column names before execution.");
  }
  if (findings.some((finding) => finding.rule === "metadata_ambiguous_column")) {
    output.push("Qualify ambiguous columns with a table name or alias.");
  }
  return output;
}

export function projectQueryStructure(
  sql: string,
  mode: ObConfig["compatibility"],
  tableRefs: Array<{ schema?: string; table: string }>
) {
  const shape = queryShape(sql, mode);
  return {
    statementType: firstProjectSqlKeyword(sql) ?? "unknown",
    tables: uniqueTableRefs(tableRefs).map((ref) => ({
      schema: ref.schema,
      table: ref.table
    })),
    selectedColumns: projectSelectedColumns(sql),
    filtersPreview: projectClausePreview(sql, "where"),
    orderByPreview: projectClausePreview(sql, "order\\s+by"),
    shape
  };
}

export function projectQueryRecommendations(source: ProjectQuerySource): string[] {
  if (source.type === "file" && source.dynamic) {
    return ["Validate the rendered SQL after dynamic mapper or template conditions are applied."];
  }
  return [];
}

function formatSchemaTable(schema: string | undefined, table: string): string {
  return schema ? `${schema}.${table}` : table;
}

function snippetAliasMap(
  sql: string,
  mode: ObConfig["compatibility"],
  tableMetadata: Map<string, { schema?: string; table: string; columns: Set<string> }>
): Map<string, { schema?: string; table: string; columns: Set<string> }> {
  const aliases = new Map<string, { schema?: string; table: string; columns: Set<string> }>();
  const byTableName = new Map<string, { schema?: string; table: string; columns: Set<string> }>();
  for (const metadata of tableMetadata.values()) {
    const tableKey = normalizeTableName(mode, metadata.table);
    byTableName.set(tableKey, metadata);
    aliases.set(tableKey, metadata);
    if (metadata.schema) {
      aliases.set(`${normalizeTableName(mode, metadata.schema)}.${tableKey}`, metadata);
    }
  }

  for (const tableRef of snippetTableAliases(sql)) {
    const metadata = byTableName.get(normalizeTableName(mode, tableRef.table));
    if (!metadata) {
      continue;
    }
    if (tableRef.alias) {
      aliases.set(normalizeTableName(mode, tableRef.alias), metadata);
    }
    aliases.set(normalizeTableName(mode, tableRef.table), metadata);
  }
  return aliases;
}

const SQL_SNIPPET_ALIAS_STOPWORDS = new Set([
  "where",
  "on",
  "join",
  "inner",
  "left",
  "right",
  "full",
  "cross",
  "group",
  "order",
  "having",
  "limit",
  "offset",
  "fetch",
  "union",
  "connect",
  "start",
  "with"
]);

function snippetTableAliases(sql: string): Array<{ table: string; alias?: string }> {
  const refs: Array<{ table: string; alias?: string }> = [];
  const identifier = String.raw`(?:"[^"]+"|` + "`[^`]+`" + String.raw`|[A-Za-z_][\w$#]*)`;
  const pattern = new RegExp(
    String.raw`\b(?:from|join)\s+((?:${identifier})(?:\s*\.\s*(?:${identifier}))?)(?:\s+(?:as\s+)?(${identifier}))?`,
    "gi"
  );
  for (const match of sql.matchAll(pattern)) {
    const rawRef = match[1];
    if (!rawRef) {
      continue;
    }
    const parts = rawRef.split(".").map((part) => unquoteIdentifier(part));
    const table = parts[parts.length - 1];
    const alias = match[2] ? unquoteIdentifier(match[2]) : undefined;
    const normalizedAlias = alias?.toLowerCase();
    refs.push({
      table,
      alias: alias && normalizedAlias && !SQL_SNIPPET_ALIAS_STOPWORDS.has(normalizedAlias) ? alias : undefined
    });
  }
  return refs;
}

function snippetQualifiedColumnRefs(
  sql: string,
  mode: ObConfig["compatibility"],
  aliasMap: Map<string, { schema?: string; table: string; columns: Set<string> }>,
  tableMetadata: Map<string, { schema?: string; table: string; columns: Set<string> }>,
  tables: SnippetMetadataValidation["tables"]
): SnippetMetadataValidation["qualifiedColumnRefs"] {
  const refs: SnippetMetadataValidation["qualifiedColumnRefs"] = [];
  const seen = new Set<string>();
  const identifier = String.raw`(?:"[^"]+"|` + "`[^`]+`" + String.raw`|[A-Za-z_][\w$#]*)`;
  const pattern = new RegExp(String.raw`(${identifier})\s*\.\s*(${identifier})`, "g");
  for (const match of sql.matchAll(pattern)) {
    const qualifier = unquoteIdentifier(match[1] ?? "");
    const column = unquoteIdentifier(match[2] ?? "");
    if (!qualifier || !column || isSchemaTableReference(mode, qualifier, column, tableMetadata)) {
      continue;
    }
    const key = `${normalizeTableName(mode, qualifier)}.${normalizeTableName(mode, column)}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    const metadata = aliasMap.get(normalizeTableName(mode, qualifier));
    const columnKey = normalizeTableName(mode, column);
    const ok = metadata ? metadata.columns.has(columnKey) : undefined;
    if (metadata) {
      markSnippetColumn(tables, mode, metadata.schema, metadata.table, column, ok === true);
    }
    refs.push({
      qualifier,
      column,
      schema: metadata?.schema,
      table: metadata?.table,
      ok
    });
  }
  return refs.slice(0, 50);
}

function snippetBareColumnRefs(
  sql: string,
  mode: ObConfig["compatibility"],
  tableMetadata: Map<string, { schema?: string; table: string; columns: Set<string> }>,
  tables: SnippetMetadataValidation["tables"]
): SnippetMetadataValidation["bareColumnRefs"] {
  const match = /\bselect\s+([\s\S]*?)\s+\bfrom\b/i.exec(sql);
  if (!match?.[1] || hasSelectStar(sql)) {
    return [];
  }
  const refs: SnippetMetadataValidation["bareColumnRefs"] = [];
  const seen = new Set<string>();
  for (const column of simpleSelectColumns(match[1])) {
    const columnKey = normalizeTableName(mode, column);
    if (seen.has(columnKey)) {
      continue;
    }
    seen.add(columnKey);
    const matches = [...tableMetadata.values()].filter((metadata) => metadata.columns.has(columnKey));
    if (matches.length === 1) {
      const metadata = matches[0];
      markSnippetColumn(tables, mode, metadata.schema, metadata.table, column, true);
      refs.push({ column, schema: metadata.schema, table: metadata.table, ok: true });
    } else if (matches.length > 1) {
      for (const metadata of matches) {
        markSnippetColumn(tables, mode, metadata.schema, metadata.table, column, true);
      }
      refs.push({ column, ok: true, ambiguous: true });
    } else if (tableMetadata.size === 1) {
      const metadata = [...tableMetadata.values()][0];
      markSnippetColumn(tables, mode, metadata.schema, metadata.table, column, false);
      refs.push({ column, schema: metadata.schema, table: metadata.table, ok: false });
    } else {
      refs.push({ column, ok: false });
    }
  }
  return refs.slice(0, 50);
}

function isSchemaTableReference(
  mode: ObConfig["compatibility"],
  qualifier: string,
  column: string,
  tableMetadata: Map<string, { schema?: string; table: string; columns: Set<string> }>
): boolean {
  for (const metadata of tableMetadata.values()) {
    if (
      metadata.schema &&
      normalizeTableName(mode, metadata.schema) === normalizeTableName(mode, qualifier) &&
      normalizeTableName(mode, metadata.table) === normalizeTableName(mode, column)
    ) {
      return true;
    }
  }
  return false;
}

function simpleSelectColumns(selectList: string): string[] {
  return splitTopLevelSqlComma(selectList)
    .map((item) => item.trim())
    .filter((item) => item && !/[()*/+-]/.test(item))
    .map((item) => item.replace(/\s+as\s+.+$/i, "").replace(/\s+[\w$#"`]+$/i, "").trim())
    .map((item) => item.split(".").pop() ?? "")
    .map(unquoteIdentifier)
    .filter((item) => /^[A-Za-z_][\w$#]*$/.test(item));
}

function splitTopLevelSqlComma(value: string): string[] {
  const segments: string[] = [];
  let current = "";
  let depth = 0;
  let quote: string | undefined;
  for (let i = 0; i < value.length; i += 1) {
    const char = value[i];
    if (quote) {
      current += char;
      if (char === quote) {
        quote = undefined;
      } else if (char === "\\") {
        i += 1;
        current += value[i] ?? "";
      }
      continue;
    }
    if (char === "'" || char === '"' || char === "`") {
      quote = char;
      current += char;
      continue;
    }
    if (char === "(") {
      depth += 1;
      current += char;
      continue;
    }
    if (char === ")") {
      depth = Math.max(0, depth - 1);
      current += char;
      continue;
    }
    if (char === "," && depth === 0) {
      segments.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  if (current.trim()) {
    segments.push(current);
  }
  return segments;
}

function markSnippetColumn(
  tables: SnippetMetadataValidation["tables"],
  mode: ObConfig["compatibility"],
  schema: string | undefined,
  table: string,
  column: string,
  ok: boolean
): void {
  const target = tables.find((item) => tableRefKey(mode, item.schema, item.table) === tableRefKey(mode, schema, table));
  if (!target) {
    return;
  }
  target.checkedColumns = uniqueStrings([...target.checkedColumns, column]).slice(0, 50);
  if (!ok) {
    target.unknownColumns = uniqueStrings([...target.unknownColumns, column]).slice(0, 50);
  }
}

function unquoteIdentifier(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith("`") && trimmed.endsWith("`")) ||
    (trimmed.startsWith('"') && trimmed.endsWith('"'))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function hasSelectStar(sql: string): boolean {
  return /\bselect\s+(?:\/\*.*?\*\/\s*)?\*/is.test(sql) || /,\s*\*/.test(sql);
}

function firstProjectSqlKeyword(sql: string): string | undefined {
  return /^[\s(]*(select|with|explain|show|describe|insert|update|delete|merge|create|alter|drop|truncate)\b/i.exec(sql)?.[1]?.toLowerCase();
}

function projectSelectedColumns(sql: string): string[] {
  const match = /\bselect\s+([\s\S]*?)\s+\bfrom\b/i.exec(sql);
  return match?.[1] ? simpleSelectColumns(match[1]).slice(0, 50) : [];
}

function projectClausePreview(sql: string, clause: "where" | "order\\s+by"): string | undefined {
  const end = clause === "where"
    ? String.raw`\b(group\s+by|order\s+by|having|limit|offset|fetch|union)\b`
    : String.raw`\b(limit|offset|fetch|union)\b`;
  const pattern = new RegExp(String.raw`\b${clause}\b\s+([\s\S]*?)(?=${end}|$)`, "i");
  const value = pattern.exec(sql)?.[1]?.trim();
  if (!value) {
    return undefined;
  }
  const compact = value.replace(/\s+/g, " ");
  return compact.length > 300 ? `${compact.slice(0, 300)}...` : compact;
}

function uniqueTableRefs(refs: Array<{ schema?: string; table: string }>): Array<{ schema?: string; table: string }> {
  const output: Array<{ schema?: string; table: string }> = [];
  const seen = new Set<string>();
  for (const ref of refs) {
    const key = `${ref.schema ?? ""}.${ref.table}`.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    output.push(ref);
  }
  return output;
}

function tableRefKey(mode: ObConfig["compatibility"], schema: string | undefined, table: string): string {
  return `${schema ? normalizeTableName(mode, schema) : ""}.${normalizeTableName(mode, table)}`;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}
