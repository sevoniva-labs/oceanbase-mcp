import type { ObConfig } from "../config.js";
import type { TableRelationship } from "../db.js";
import { assertTableAccess } from "../policy.js";
import { shouldMaskColumnValue } from "../query/output.js";
import { normalizeGlossaryText } from "./business-glossary.js";
import { policyContext } from "./policy-context.js";

export interface SearchEverythingResult {
  type: "schema" | "table" | "column" | "business_glossary";
  source: "catalog" | "schema" | "business_glossary";
  schema?: string;
  table?: string;
  column?: string;
  term?: string;
  description?: string;
  comment?: string;
  matchedField: string;
  confidence: number;
  evidence: Array<{ field: string; value: string; reason: string }>;
}

export interface BusinessTableCandidate {
  schema?: string;
  table: string;
  confidence: number;
  sources: string[];
  matchedColumns: string[];
  terms: string[];
  evidence: Array<{ source: string; type: string; field: string; value: string; reason: string }>;
  relatedTables?: Array<{
    schema?: string;
    table: string;
    relationType: string;
    direction: string;
    confidence: number;
    columns: string[];
    evidence: string[];
  }>;
}

export interface ColumnSearchResult {
  source: "catalog" | "business_glossary";
  schema?: string;
  table: string;
  column: string;
  type?: string;
  nullable?: boolean;
  comment?: string;
  ordinalPosition?: number;
  masked: boolean;
  confidence: number;
  evidence: Array<{ source: string; field: string; value: string; reason: string }>;
}

export function schemaSearchResult(
  row: unknown,
  query: string,
  config: ObConfig,
  schemaFilter?: string
): SearchEverythingResult[] {
  const record = row as Record<string, unknown>;
  const schema = stringRecordValue(record, "Database", "schema_name", "SCHEMA_NAME", "username", "USERNAME");
  if (!schema) {
    return [];
  }
  if (schemaFilter && normalizeTableName(config.compatibility, schema) !== normalizeTableName(config.compatibility, schemaFilter)) {
    return [];
  }
  const match = textMatchEvidence("schema", schema, query);
  if (!match) {
    return [];
  }
  return [{
    type: "schema",
    source: "schema",
    schema,
    matchedField: "schema",
    confidence: match.confidence,
    evidence: [match.evidence]
  }];
}

export function catalogSearchResult(row: unknown, query: string, config: ObConfig): SearchEverythingResult[] {
  const record = row as Record<string, unknown>;
  const matchType = stringRecordValue(record, "match_type", "MATCH_TYPE") ?? "table";
  const schema = stringRecordValue(record, "table_schema", "TABLE_SCHEMA", "owner", "OWNER");
  const table = stringRecordValue(record, "table_name", "TABLE_NAME");
  const column = stringRecordValue(record, "column_name", "COLUMN_NAME");
  const comment = stringRecordValue(record, "comment_text", "COMMENT_TEXT");
  const type = matchType.toLowerCase() === "column" && column ? "column" : "table";
  const candidates = [
    { field: "schema", value: schema },
    { field: "table", value: table },
    { field: "column", value: column },
    { field: "comment", value: comment }
  ];
  const matches = candidates
    .map((candidate) => candidate.value ? textMatchEvidence(candidate.field, candidate.value, query) : undefined)
    .filter((match): match is { confidence: number; evidence: SearchEverythingResult["evidence"][number] } => Boolean(match));

  if (!table || matches.length === 0) {
    return [];
  }
  const best = matches.reduce((left, right) => left.confidence >= right.confidence ? left : right);
  const allowed = type === "column"
    ? !column || !shouldMaskColumnValue(column, config, schema, table)
    : true;
  if (!allowed) {
    return [];
  }
  return [{
    type,
    source: "catalog",
    schema,
    table,
    column: type === "column" ? column : undefined,
    comment,
    matchedField: best.evidence.field,
    confidence: best.confidence,
    evidence: matches.map((match) => match.evidence)
  }];
}

export function glossarySearchResults(
  match: {
    term: string;
    aliases: string[];
    description?: string;
    targets: Array<{ schema?: string; table?: string; column?: string; description?: string }>;
    evidence: string[];
  },
  query: string
): SearchEverythingResult[] {
  const termMatch = textMatchEvidence("term", match.term, query);
  const aliasMatches = match.aliases
    .map((alias) => textMatchEvidence("alias", alias, query))
    .filter((item): item is { confidence: number; evidence: SearchEverythingResult["evidence"][number] } => Boolean(item));
  const baseEvidence = [
    ...(termMatch ? [termMatch.evidence] : []),
    ...aliasMatches.map((item) => item.evidence),
    ...match.evidence.map((item) => ({ field: "glossary", value: item, reason: "Matched configured business glossary evidence." }))
  ];
  const confidence = Math.max(0.72, termMatch?.confidence ?? 0, ...aliasMatches.map((item) => item.confidence));
  return match.targets.map((target) => ({
    type: "business_glossary" as const,
    source: "business_glossary" as const,
    schema: target.schema,
    table: target.table,
    column: target.column,
    term: match.term,
    description: target.description ?? match.description,
    matchedField: termMatch ? "term" : aliasMatches.length > 0 ? "alias" : "target",
    confidence,
    evidence: baseEvidence.slice(0, 10)
  }));
}

export function textMatchEvidence(
  field: string,
  value: string,
  query: string
): { confidence: number; evidence: SearchEverythingResult["evidence"][number] } | undefined {
  const normalizedValue = normalizeGlossaryText(value);
  const normalizedQuery = normalizeGlossaryText(query);
  if (!normalizedValue || !normalizedQuery) {
    return undefined;
  }
  if (normalizedValue === normalizedQuery) {
    return {
      confidence: field === "comment" ? 0.82 : 1,
      evidence: { field, value, reason: "Exact match." }
    };
  }
  if (normalizedValue.includes(normalizedQuery)) {
    return {
      confidence: field === "comment" ? 0.66 : 0.86,
      evidence: { field, value, reason: "Contains query text." }
    };
  }
  if (normalizedQuery.includes(normalizedValue)) {
    return {
      confidence: field === "comment" ? 0.58 : 0.74,
      evidence: { field, value, reason: "Query contains this metadata term." }
    };
  }
  return undefined;
}

export function dedupeSearchResults(results: SearchEverythingResult[]): SearchEverythingResult[] {
  const best = new Map<string, SearchEverythingResult>();
  for (const result of results) {
    const key = [
      result.type,
      result.schema ?? "",
      result.table ?? "",
      result.column ?? "",
      result.term ?? ""
    ].join(":").toLowerCase();
    const previous = best.get(key);
    if (!previous || result.confidence > previous.confidence) {
      best.set(key, result);
    }
  }
  return [...best.values()];
}

export function tableCandidatesFromSearchResults(
  results: SearchEverythingResult[],
  config: ObConfig,
  limit: number
): BusinessTableCandidate[] {
  const candidates = new Map<string, BusinessTableCandidate>();
  for (const result of results) {
    if (!result.table) {
      continue;
    }
    try {
      assertTableAccess(result.schema, result.table, policyContext(config));
    } catch {
      continue;
    }
    const key = tableRefKey(config.compatibility, result.schema, result.table);
    const current = candidates.get(key) ?? {
      schema: result.schema,
      table: result.table,
      confidence: 0,
      sources: [],
      matchedColumns: [],
      terms: [],
      evidence: []
    };
    current.confidence = Math.max(current.confidence, tableCandidateConfidence(result));
    current.sources = uniqueStrings([...current.sources, result.source]);
    if (result.column) {
      current.matchedColumns = uniqueStrings([...current.matchedColumns, result.column]);
    }
    if (result.term) {
      current.terms = uniqueStrings([...current.terms, result.term]);
    }
    current.evidence = [
      ...current.evidence,
      ...result.evidence.map((item) => ({
        source: result.source,
        type: result.type,
        field: item.field,
        value: item.value,
        reason: item.reason
      }))
    ].slice(0, 20);
    candidates.set(key, current);
  }
  return [...candidates.values()]
    .sort((left, right) => right.confidence - left.confidence || left.table.localeCompare(right.table))
    .slice(0, limit);
}

export function relatedTableEvidence(
  candidate: BusinessTableCandidate,
  relation: TableRelationship,
  mode: ObConfig["compatibility"]
): NonNullable<BusinessTableCandidate["relatedTables"]>[number] | undefined {
  const sourceMatches =
    normalizeTableName(mode, relation.sourceTable) === normalizeTableName(mode, candidate.table) &&
    normalizeTableName(mode, relation.sourceSchema ?? "") === normalizeTableName(mode, candidate.schema ?? "");
  const schema = sourceMatches ? relation.targetSchema : relation.sourceSchema;
  const table = sourceMatches ? relation.targetTable : relation.sourceTable;
  const columns = sourceMatches ? relation.sourceColumns : relation.targetColumns;
  if (!table || normalizeTableName(mode, table) === normalizeTableName(mode, candidate.table)) {
    return undefined;
  }
  return {
    schema,
    table,
    relationType: relation.relationType,
    direction: sourceMatches ? "outbound" : "inbound",
    confidence: relation.confidence,
    columns,
    evidence: relation.evidence.map((item) => item.detail).slice(0, 5)
  };
}

export function columnSearchRows(
  row: unknown,
  query: string | undefined,
  dataType: string | undefined,
  config: ObConfig
): ColumnSearchResult[] {
  const record = row as Record<string, unknown>;
  const schema = stringRecordValue(record, "table_schema", "TABLE_SCHEMA", "owner", "OWNER");
  const table = stringRecordValue(record, "table_name", "TABLE_NAME");
  const column = stringRecordValue(record, "column_name", "COLUMN_NAME");
  if (!table || !column) {
    return [];
  }
  const metadata = profileColumnMetadata(row, config.compatibility);
  const type = metadata?.dataType ?? columnTypeLabel(config.compatibility, record);
  const comment = metadata?.comment;
  const evidence = [
    ...(query ? columnSearchEvidence(query, schema, table, column, type, comment) : []),
    ...(dataType && type ? dataTypeEvidence(type, dataType) : [])
  ];
  if (evidence.length === 0 && !query && !dataType) {
    evidence.push({ source: "catalog", field: "metadata", value: column, reason: "Returned from visible column metadata." });
  }
  if (evidence.length === 0) {
    return [];
  }
  return [{
    source: "catalog",
    schema,
    table,
    column,
    type,
    nullable: metadata?.nullable,
    comment,
    ordinalPosition: numberRecordValue(record, "ordinal_position", "ORDINAL_POSITION", "column_id", "COLUMN_ID"),
    masked: shouldMaskColumnValue(column, config, schema, table),
    confidence: Math.max(...evidence.map((item) => evidenceConfidence(item.field))),
    evidence
  }];
}

export function glossaryColumnRows(
  match: {
    term: string;
    targets: Array<{ schema?: string; table?: string; column?: string; description?: string }>;
    evidence: string[];
  },
  query: string,
  config: ObConfig
): ColumnSearchResult[] {
  const termEvidence = textMatchEvidence("business_glossary", match.term, query);
  return match.targets
    .filter((target) => target.table && target.column)
    .map((target) => ({
      source: "business_glossary" as const,
      schema: target.schema,
      table: target.table!,
      column: target.column!,
      comment: target.description,
      masked: shouldMaskColumnValue(target.column!, config, target.schema, target.table),
      confidence: Math.max(0.9, termEvidence?.confidence ?? 0),
      evidence: [
        ...(termEvidence
          ? [{ source: "business_glossary", field: termEvidence.evidence.field, value: termEvidence.evidence.value, reason: termEvidence.evidence.reason }]
          : []),
        ...match.evidence.map((item) => ({
          source: "business_glossary",
          field: "business_glossary",
          value: item,
          reason: "Matched configured business glossary evidence."
        }))
      ].slice(0, 10)
    }));
}

export function dedupeColumnSearchResults(results: ColumnSearchResult[]): ColumnSearchResult[] {
  const best = new Map<string, ColumnSearchResult>();
  for (const result of results) {
    const key = [result.schema ?? "", result.table, result.column].join(":").toLowerCase();
    const previous = best.get(key);
    if (!previous) {
      best.set(key, result);
      continue;
    }
    best.set(key, {
      ...previous,
      ...Object.fromEntries(Object.entries(result).filter(([, value]) => value != null)),
      masked: previous.masked || result.masked,
      confidence: Math.max(previous.confidence, result.confidence),
      evidence: [...previous.evidence, ...result.evidence].slice(0, 20)
    });
  }
  return [...best.values()];
}

function columnSearchEvidence(
  query: string,
  schema: string | undefined,
  table: string,
  column: string,
  type: string | undefined,
  comment: string | undefined
): ColumnSearchResult["evidence"] {
  return [
    { field: "schema", value: schema },
    { field: "table", value: table },
    { field: "column", value: column },
    { field: "type", value: type },
    { field: "comment", value: comment }
  ]
    .map((item) => item.value ? textMatchEvidence(item.field, item.value, query) : undefined)
    .filter((item): item is { confidence: number; evidence: SearchEverythingResult["evidence"][number] } => Boolean(item))
    .map((item) => ({
      source: "catalog",
      field: item.evidence.field,
      value: item.evidence.value,
      reason: item.evidence.reason
    }));
}

function dataTypeEvidence(type: string, expectedType: string): ColumnSearchResult["evidence"] {
  const match = textMatchEvidence("type", type, expectedType);
  return match
    ? [{ source: "catalog", field: match.evidence.field, value: match.evidence.value, reason: match.evidence.reason }]
    : [];
}

function evidenceConfidence(field: string): number {
  if (field === "column") {
    return 0.95;
  }
  if (field === "table") {
    return 0.78;
  }
  if (field === "type") {
    return 0.72;
  }
  if (field === "comment") {
    return 0.66;
  }
  if (field === "business_glossary") {
    return 0.9;
  }
  return 0.58;
}

function tableCandidateConfidence(result: SearchEverythingResult): number {
  if (result.source === "business_glossary") {
    return Math.max(result.confidence, 0.9);
  }
  if (result.type === "table") {
    return result.confidence;
  }
  if (result.type === "column") {
    return Math.min(result.confidence, 0.82);
  }
  return Math.min(result.confidence, 0.7);
}

function tableRefKey(mode: ObConfig["compatibility"], schema: string | undefined, table: string): string {
  return `${schema ? normalizeTableName(mode, schema) : ""}.${normalizeTableName(mode, table)}`;
}

function normalizeTableName(mode: ObConfig["compatibility"], value: string): string {
  return mode === "oracle" ? value.trim().toUpperCase() : value.trim().toLowerCase();
}

function uniqueStrings(values: string[]): string[] {
  const output: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    if (!value || seen.has(value)) {
      continue;
    }
    seen.add(value);
    output.push(value);
  }
  return output;
}

function stringRecordValue(record: Record<string, unknown>, ...keys: string[]): string | undefined {
  const value = keys.map((key) => record[key]).find((item) => typeof item === "string" && item.trim());
  return typeof value === "string" ? value.trim() : undefined;
}

function numberRecordValue(record: Record<string, unknown>, ...keys: string[]): number | undefined {
  const value = keys
    .map((key) => record[key])
    .find((item) => typeof item === "number" || typeof item === "string");
  if (typeof value === "number") {
    return value;
  }
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return undefined;
}

function profileColumnMetadata(
  row: unknown,
  mode: ObConfig["compatibility"]
): { name: string; dataType?: string; nullable?: boolean; comment?: string } | undefined {
  const record = row as Record<string, unknown>;
  const name = stringRecordValue(record, "column_name", "COLUMN_NAME");
  if (!name) {
    return undefined;
  }
  const nullableText = stringRecordValue(record, "is_nullable", "IS_NULLABLE", "nullable", "NULLABLE");
  return {
    name,
    dataType: columnTypeLabel(mode, record),
    nullable: nullableText ? !["NO", "N"].includes(nullableText.toUpperCase()) : undefined,
    comment: stringRecordValue(record, "column_comment", "COLUMN_COMMENT", "comments", "COMMENTS")
  };
}

function columnTypeLabel(mode: ObConfig["compatibility"], record: Record<string, unknown>): string | undefined {
  const mysqlType = stringRecordValue(record, "column_type", "COLUMN_TYPE");
  if (mysqlType) {
    return mysqlType;
  }
  const dataType = stringRecordValue(record, "data_type", "DATA_TYPE");
  const length = numberRecordValue(record, "data_length", "DATA_LENGTH");
  if (
    mode === "oracle" &&
    dataType &&
    length &&
    ["CHAR", "NCHAR", "VARCHAR2", "NVARCHAR2", "RAW"].includes(dataType)
  ) {
    return `${dataType}(${length})`;
  }
  return dataType;
}
