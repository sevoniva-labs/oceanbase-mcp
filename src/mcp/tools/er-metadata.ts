import type { ObConfig } from "../../config.js";
import type { ErEntity } from "../../er.js";
import { columnTypeLabel, normalizeTableName, stringRecordValue } from "./profile-utils.js";
import { tableRefKey } from "./er-relationships.js";

export interface ErScopeTable {
  schema?: string;
  table: string;
  sources: string[];
  confidence: number;
  evidence: string[];
}

export function addErScopeTable(
  scope: Map<string, ErScopeTable>,
  mode: ObConfig["compatibility"],
  schema: string | undefined,
  table: string,
  limit: number,
  detail: { source: string; confidence: number; evidence: string[] }
): boolean {
  const normalizedSchema = mode === "oracle" && schema ? schema.toUpperCase() : schema;
  const normalizedTable = mode === "oracle" ? table.toUpperCase() : table;
  const key = tableRefKey(mode, normalizedSchema, normalizedTable);
  const existing = scope.get(key);
  if (!existing && scope.size >= limit) {
    return false;
  }
  if (!existing) {
    scope.set(key, {
      schema: normalizedSchema,
      table: normalizedTable,
      sources: [detail.source],
      confidence: detail.confidence,
      evidence: detail.evidence.slice(0, 20)
    });
    return true;
  }
  existing.sources = uniqueStrings([...existing.sources, detail.source]);
  existing.confidence = Math.max(existing.confidence, detail.confidence);
  existing.evidence = uniqueStrings([...existing.evidence, ...detail.evidence]).slice(0, 20);
  return true;
}

export function erScopeTableOutput(table: ErScopeTable) {
  return {
    schema: table.schema,
    table: table.table,
    sources: table.sources,
    confidence: Number(table.confidence.toFixed(3)),
    evidence: table.evidence
  };
}

export function tableRefFromMetadata(
  row: unknown,
  fallbackSchema: string | undefined
): { schema?: string; table: string } | undefined {
  const record = row as Record<string, unknown>;
  const table = stringRecordValue(record, "table_name", "TABLE_NAME");
  if (!table) {
    return undefined;
  }
  return {
    schema:
      stringRecordValue(record, "table_schema", "TABLE_SCHEMA", "owner", "OWNER", "table_owner", "TABLE_OWNER") ??
      fallbackSchema,
    table
  };
}

export function erEntityFromMetadata(
  mode: ObConfig["compatibility"],
  schema: string | undefined,
  table: string,
  columns: unknown[],
  constraints: unknown[],
  indexes: unknown[] = []
): ErEntity {
  const primaryKeys = new Set(primaryKeyColumns(mode, constraints));
  const indexMap = erIndexMap(mode, indexes);
  return {
    schema,
    table,
    columns: columns.map((row) => {
      const record = row as Record<string, unknown>;
      const name = stringRecordValue(record, "column_name", "COLUMN_NAME") ?? "column";
      const nullable = stringRecordValue(record, "is_nullable", "IS_NULLABLE", "nullable", "NULLABLE");
      const indexNames = indexMap.get(normalizeTableName(mode, name)) ?? [];
      return {
        name,
        type: columnTypeLabel(mode, record),
        primaryKey: primaryKeys.has(normalizeTableName(mode, name)),
        nullable: nullable ? !["NO", "N"].includes(nullable.toUpperCase()) : undefined,
        comment: stringRecordValue(record, "column_comment", "COLUMN_COMMENT", "comments", "COMMENTS"),
        indexed: indexNames.length > 0,
        indexNames
      };
    })
  };
}

export function groupErMetadataRows(mode: ObConfig["compatibility"], rows: unknown[]): Map<string, unknown[]> {
  const output = new Map<string, unknown[]>();
  for (const row of rows) {
    const record = row as Record<string, unknown>;
    const table = stringRecordValue(record, "table_name", "TABLE_NAME");
    if (!table) {
      continue;
    }
    const schema = stringRecordValue(record, "table_schema", "TABLE_SCHEMA", "owner", "OWNER", "table_owner", "TABLE_OWNER");
    const key = tableRefKey(mode, schema, table);
    output.set(key, [...(output.get(key) ?? []), row]);
  }
  return output;
}

export function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const output = [];
  for (const value of values) {
    const normalized = value.trim().toLowerCase();
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    output.push(value);
  }
  return output;
}

function erIndexMap(mode: ObConfig["compatibility"], indexes: unknown[]): Map<string, string[]> {
  const output = new Map<string, string[]>();
  for (const row of indexes) {
    const record = row as Record<string, unknown>;
    const column = stringRecordValue(record, "column_name", "COLUMN_NAME");
    const indexName = stringRecordValue(record, "index_name", "INDEX_NAME");
    if (!column || !indexName) {
      continue;
    }
    const key = normalizeTableName(mode, column);
    output.set(key, uniqueStrings([...(output.get(key) ?? []), indexName]));
  }
  return output;
}

function primaryKeyColumns(mode: ObConfig["compatibility"], constraints: unknown[]): string[] {
  return constraints
    .filter((row) => {
      const type = stringRecordValue(row as Record<string, unknown>, "constraint_type", "CONSTRAINT_TYPE");
      return type === "PRIMARY KEY" || type === "P";
    })
    .map((row) => stringRecordValue(row as Record<string, unknown>, "column_name", "COLUMN_NAME"))
    .filter((value): value is string => Boolean(value))
    .map((value) => normalizeTableName(mode, value));
}
