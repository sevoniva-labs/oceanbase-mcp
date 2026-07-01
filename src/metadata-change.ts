import { createHash } from "node:crypto";

import type { CompatibilityMode } from "./config.js";
import type { ObjectMetadataResult, TableRelationship, TableStats } from "./db.js";

export const METADATA_SNAPSHOT_VERSION = "1.1";

export interface MetadataSnapshotScope {
  schema?: string;
  tablePattern?: string;
  objectTypes: string[];
  includeRelationships: boolean;
  includeOracleObjects: boolean;
  maxTables: number;
  maxColumnsPerTable: number;
  maxObjects: number;
  maxRelationships: number;
}

export interface MetadataSnapshotCacheInfo {
  used: boolean;
  before: MetadataSnapshotCacheStats;
  after: MetadataSnapshotCacheStats;
  delta: MetadataSnapshotCacheStats;
  warnings: string[];
}

export interface MetadataSnapshotCacheStats {
  entries: number;
  hits: number;
  misses: number;
  evictions: number;
}

export interface MetadataSnapshotColumn {
  name: string;
  type?: string;
  nullable?: boolean;
  defaultValue?: unknown;
  comment?: string;
  position?: number;
  key?: string;
  masked: boolean;
}

export interface MetadataSnapshotIndex {
  name: string;
  unique?: boolean;
  type?: string;
  columns: string[];
  rows: unknown[];
}

export interface MetadataSnapshotConstraint {
  name: string;
  type?: string;
  columns: string[];
  referencedSchema?: string;
  referencedTable?: string;
  referencedColumns: string[];
  rows: unknown[];
}

export interface MetadataSnapshotPartition {
  name?: string;
  subpartitionName?: string;
  method?: string;
  expression?: string;
  description?: string;
  position?: number;
  rowEstimate?: number;
  tablespace?: string;
  row: unknown;
}

export interface MetadataSnapshotRelationship {
  relationType: TableRelationship["relationType"];
  direction: TableRelationship["direction"];
  confidence: number;
  sourceSchema?: string;
  sourceTable: string;
  sourceColumns: string[];
  targetSchema?: string;
  targetTable: string;
  targetColumns: string[];
  constraintName?: string;
  depth: number;
  evidence: TableRelationship["evidence"];
  fingerprint: string;
}

export interface MetadataSnapshotTable {
  schema?: string;
  table: string;
  tableType?: string;
  engine?: string;
  comment?: string;
  rowEstimate?: {
    value: number;
    exact: false;
    source: string;
  };
  stats?: TableStats;
  columns: MetadataSnapshotColumn[];
  indexes: MetadataSnapshotIndex[];
  constraints: MetadataSnapshotConstraint[];
  partitions: MetadataSnapshotPartition[];
  warnings: string[];
  truncated: {
    columns: boolean;
  };
  fingerprint: string;
}

export interface MetadataSnapshotOracleObject {
  schema?: string;
  objectName: string;
  objectType: string;
  status?: string;
  created?: string;
  lastDdlTime?: string;
  summary?: Record<string, unknown>;
  details?: Record<string, unknown>;
  columns?: MetadataSnapshotColumn[];
  arguments?: unknown[];
  sourceFingerprint?: string;
  warnings: string[];
  fingerprint: string;
}

export interface MetadataSnapshot {
  snapshotVersion: string;
  capturedAt: string;
  profile: string;
  compatibility: CompatibilityMode;
  scope: MetadataSnapshotScope;
  tableCount: number;
  objectCount: number;
  relationshipCount: number;
  schemas: Array<{ schema?: string; tableCount: number; objectCount: number }>;
  tables: MetadataSnapshotTable[];
  oracleObjects: MetadataSnapshotOracleObject[];
  relationships: MetadataSnapshotRelationship[];
  fingerprint: string;
  truncated: {
    tables: boolean;
    columns: boolean;
    objects: boolean;
    relationships: boolean;
  };
  cache?: MetadataSnapshotCacheInfo;
  warnings: string[];
  executed: false;
}

export interface MetadataSnapshotTableInput {
  schema?: string;
  table: string;
  tableType?: string;
  engine?: string;
  comment?: string;
  rowEstimate?: MetadataSnapshotTable["rowEstimate"];
  stats?: TableStats;
  columns: unknown[];
  indexes: unknown[];
  constraints: unknown[];
  partitions: unknown[];
  maskedColumns?: string[];
  columnsTruncated?: boolean;
  warnings?: string[];
}

export interface MetadataSnapshotObjectInput {
  summary: unknown;
  metadata?: ObjectMetadataResult | Record<string, unknown>;
  warnings?: string[];
}

export interface BuildMetadataSnapshotInput {
  capturedAt?: string;
  profile: string;
  compatibility: CompatibilityMode;
  scope: MetadataSnapshotScope;
  tables: MetadataSnapshotTableInput[];
  oracleObjects?: MetadataSnapshotObjectInput[];
  relationships?: TableRelationship[];
  cache?: MetadataSnapshotCacheInfo;
  truncated?: Partial<MetadataSnapshot["truncated"]>;
  warnings?: string[];
}

export function buildMetadataSnapshot(input: BuildMetadataSnapshotInput): MetadataSnapshot {
  const tables = input.tables.map((table) => normalizeSnapshotTable(input.compatibility, table));
  const oracleObjects = (input.oracleObjects ?? []).map((object) =>
    normalizeSnapshotOracleObject(input.compatibility, object)
  );
  const relationships = dedupeSnapshotRelationships(input.compatibility, input.relationships ?? []);
  const schemas = summarizeSnapshotSchemas(input.compatibility, tables, oracleObjects);
  const truncated = {
    tables: Boolean(input.truncated?.tables),
    columns: Boolean(input.truncated?.columns) || tables.some((table) => table.truncated.columns),
    objects: Boolean(input.truncated?.objects),
    relationships: Boolean(input.truncated?.relationships)
  };
  const warnings = uniqueStrings([
    ...(input.warnings ?? []),
    ...tables.flatMap((table) => table.warnings),
    ...oracleObjects.flatMap((object) => object.warnings),
    ...(input.cache?.warnings ?? []),
    truncated.tables ? "Table list was truncated by maxTables; narrow schema or tablePattern for a complete snapshot." : "",
    truncated.columns ? "Some table columns were truncated by maxColumnsPerTable; raise the limit for a complete column diff." : "",
    truncated.objects ? "Oracle object list was truncated by maxObjects." : "",
    truncated.relationships ? "Relationship list was truncated by maxRelationships." : "",
    "Snapshot contains metadata only. It does not include sample data values or connection secrets."
  ]);
  const fingerprint = stableHash({
    snapshotVersion: METADATA_SNAPSHOT_VERSION,
    compatibility: input.compatibility,
    scope: input.scope,
    tables: tables.map((table) => ({
      schema: table.schema,
      table: table.table,
      fingerprint: table.fingerprint
    })),
    oracleObjects: oracleObjects.map((object) => ({
      schema: object.schema,
      objectName: object.objectName,
      objectType: object.objectType,
      fingerprint: object.fingerprint
    })),
    relationships: relationships.map((relationship) => relationship.fingerprint)
  });

  return {
    snapshotVersion: METADATA_SNAPSHOT_VERSION,
    capturedAt: input.capturedAt ?? new Date().toISOString(),
    profile: input.profile,
    compatibility: input.compatibility,
    scope: input.scope,
    tableCount: tables.length,
    objectCount: oracleObjects.length,
    relationshipCount: relationships.length,
    schemas,
    tables,
    oracleObjects,
    relationships,
    fingerprint,
    truncated,
    cache: input.cache,
    warnings,
    executed: false
  };
}

export function stableHash(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

function normalizeSnapshotTable(mode: CompatibilityMode, input: MetadataSnapshotTableInput): MetadataSnapshotTable {
  const maskedColumns = new Set((input.maskedColumns ?? []).map((column) => normalizeIdentifier(mode, column)));
  const columns = input.columns
    .map((row) => normalizeColumn(mode, row, maskedColumns))
    .filter((column): column is MetadataSnapshotColumn => Boolean(column))
    .sort(compareSnapshotColumns);
  const indexes = normalizeIndexes(mode, input.indexes);
  const constraints = normalizeConstraints(mode, input.constraints);
  const partitions = input.partitions
    .map((row) => normalizePartition(row))
    .sort(comparePartitions);
  const table: Omit<MetadataSnapshotTable, "fingerprint"> = {
    schema: input.schema,
    table: input.table,
    tableType: input.tableType,
    engine: input.engine,
    comment: input.comment,
    rowEstimate: input.rowEstimate,
    stats: input.stats,
    columns,
    indexes,
    constraints,
    partitions,
    warnings: uniqueStrings(input.warnings ?? []),
    truncated: {
      columns: Boolean(input.columnsTruncated)
    }
  };
  return {
    ...table,
    fingerprint: stableHash(tableFingerprintPayload(table))
  };
}

function normalizeColumn(
  mode: CompatibilityMode,
  row: unknown,
  maskedColumns: Set<string>
): MetadataSnapshotColumn | undefined {
  const record = rowRecord(row);
  const name = stringField(record, "column_name", "COLUMN_NAME");
  if (!name) {
    return undefined;
  }
  const nullableText = stringField(record, "is_nullable", "IS_NULLABLE", "nullable", "NULLABLE");
  return {
    name,
    type: columnTypeLabel(mode, record),
    nullable: nullableText ? !["NO", "N"].includes(nullableText.toUpperCase()) : undefined,
    defaultValue: firstDefined(record, "column_default", "COLUMN_DEFAULT", "data_default", "DATA_DEFAULT"),
    comment: stringField(record, "column_comment", "COLUMN_COMMENT", "comments", "COMMENTS"),
    position: numberField(record, "ordinal_position", "ORDINAL_POSITION", "column_id", "COLUMN_ID"),
    key: stringField(record, "column_key", "COLUMN_KEY"),
    masked: maskedColumns.has(normalizeIdentifier(mode, name))
  };
}

function normalizeIndexes(mode: CompatibilityMode, rows: unknown[]): MetadataSnapshotIndex[] {
  const grouped = new Map<string, MetadataSnapshotIndex>();
  for (const row of rows) {
    const record = rowRecord(row);
    const name = stringField(record, "index_name", "INDEX_NAME");
    if (!name) {
      continue;
    }
    const column = stringField(record, "column_name", "COLUMN_NAME");
    const unique = indexUnique(record);
    const current = grouped.get(normalizeIdentifier(mode, name)) ?? {
      name,
      unique,
      type: stringField(record, "index_type", "INDEX_TYPE"),
      columns: [],
      rows: []
    };
    current.unique = current.unique ?? unique;
    current.type = current.type ?? stringField(record, "index_type", "INDEX_TYPE");
    if (column) {
      current.columns = uniqueStrings([...current.columns, column]);
    }
    current.rows.push(stableRow(record));
    grouped.set(normalizeIdentifier(mode, name), current);
  }
  return [...grouped.values()].sort((left, right) =>
    normalizeIdentifier(mode, left.name).localeCompare(normalizeIdentifier(mode, right.name))
  );
}

function normalizeConstraints(mode: CompatibilityMode, rows: unknown[]): MetadataSnapshotConstraint[] {
  const grouped = new Map<string, MetadataSnapshotConstraint>();
  for (const row of rows) {
    const record = rowRecord(row);
    const name = stringField(record, "constraint_name", "CONSTRAINT_NAME");
    if (!name) {
      continue;
    }
    const column = stringField(record, "column_name", "COLUMN_NAME");
    const referencedColumn = stringField(record, "referenced_column_name", "REFERENCED_COLUMN_NAME");
    const current = grouped.get(normalizeIdentifier(mode, name)) ?? {
      name,
      type: stringField(record, "constraint_type", "CONSTRAINT_TYPE"),
      columns: [],
      referencedSchema: stringField(record, "referenced_table_schema", "REFERENCED_TABLE_SCHEMA"),
      referencedTable: stringField(record, "referenced_table_name", "REFERENCED_TABLE_NAME"),
      referencedColumns: [],
      rows: []
    };
    current.type = current.type ?? stringField(record, "constraint_type", "CONSTRAINT_TYPE");
    current.referencedSchema = current.referencedSchema ?? stringField(record, "referenced_table_schema", "REFERENCED_TABLE_SCHEMA");
    current.referencedTable = current.referencedTable ?? stringField(record, "referenced_table_name", "REFERENCED_TABLE_NAME");
    if (column) {
      current.columns = uniqueStrings([...current.columns, column]);
    }
    if (referencedColumn) {
      current.referencedColumns = uniqueStrings([...current.referencedColumns, referencedColumn]);
    }
    current.rows.push(stableRow(record));
    grouped.set(normalizeIdentifier(mode, name), current);
  }
  return [...grouped.values()].sort((left, right) =>
    normalizeIdentifier(mode, left.name).localeCompare(normalizeIdentifier(mode, right.name))
  );
}

function normalizePartition(row: unknown): MetadataSnapshotPartition {
  const record = rowRecord(row);
  return {
    name: stringField(record, "partition_name", "PARTITION_NAME"),
    subpartitionName: stringField(record, "subpartition_name", "SUBPARTITION_NAME"),
    method: stringField(record, "partition_method", "PARTITION_METHOD"),
    expression: stringField(record, "partition_expression", "PARTITION_EXPRESSION"),
    description: stringField(record, "partition_description", "PARTITION_DESCRIPTION", "high_value", "HIGH_VALUE"),
    position: numberField(record, "partition_position", "PARTITION_POSITION"),
    rowEstimate: numberField(record, "table_rows", "TABLE_ROWS", "num_rows", "NUM_ROWS"),
    tablespace: stringField(record, "tablespace_name", "TABLESPACE_NAME"),
    row: stableRow(record)
  };
}

function dedupeSnapshotRelationships(
  mode: CompatibilityMode,
  relationships: TableRelationship[]
): MetadataSnapshotRelationship[] {
  const output = new Map<string, MetadataSnapshotRelationship>();
  for (const relationship of relationships) {
    const normalized: Omit<MetadataSnapshotRelationship, "fingerprint"> = {
      relationType: relationship.relationType,
      direction: relationship.direction,
      confidence: relationship.confidence,
      sourceSchema: relationship.sourceSchema,
      sourceTable: relationship.sourceTable,
      sourceColumns: relationship.sourceColumns,
      targetSchema: relationship.targetSchema,
      targetTable: relationship.targetTable,
      targetColumns: relationship.targetColumns,
      constraintName: relationship.constraintName,
      depth: relationship.depth,
      evidence: relationship.evidence
    };
    const fingerprint = stableHash({
      relationType: normalized.relationType,
      source: tableRefKey(mode, normalized.sourceSchema, normalized.sourceTable),
      sourceColumns: normalized.sourceColumns.map((column) => normalizeIdentifier(mode, column)).sort(),
      target: tableRefKey(mode, normalized.targetSchema, normalized.targetTable),
      targetColumns: normalized.targetColumns.map((column) => normalizeIdentifier(mode, column)).sort(),
      constraintName: normalized.constraintName,
      evidence: normalized.evidence
    });
    output.set(fingerprint, { ...normalized, fingerprint });
  }
  return [...output.values()].sort((left, right) => left.fingerprint.localeCompare(right.fingerprint));
}

function normalizeSnapshotOracleObject(
  mode: CompatibilityMode,
  input: MetadataSnapshotObjectInput
): MetadataSnapshotOracleObject {
  const summary = rowRecord(input.summary);
  const metadata = objectRecord(input.metadata);
  const sourcePreview = objectRecord(metadata?.sourcePreview);
  const columns = Array.isArray(metadata?.columns)
    ? metadata.columns
      .map((row) => normalizeColumn(mode, row, new Set()))
      .filter((column): column is MetadataSnapshotColumn => Boolean(column))
      .sort(compareSnapshotColumns)
    : undefined;
  const object: Omit<MetadataSnapshotOracleObject, "fingerprint"> = {
    schema: stringField(summary, "owner", "OWNER") ?? stringField(metadata, "schema"),
    objectName: stringField(summary, "object_name", "OBJECT_NAME") ?? stringField(metadata, "objectName") ?? "",
    objectType: stringField(summary, "object_type", "OBJECT_TYPE") ?? stringField(metadata, "objectType") ?? "",
    status: stringField(summary, "status", "STATUS"),
    created: stringField(summary, "created", "CREATED"),
    lastDdlTime: stringField(summary, "last_ddl_time", "LAST_DDL_TIME"),
    summary: stableRow(summary),
    details: objectRecord(metadata?.details) ? stableRow(objectRecord(metadata?.details)) : undefined,
    columns,
    arguments: Array.isArray(metadata?.arguments) ? metadata.arguments.map(stableRow) : undefined,
    sourceFingerprint: typeof sourcePreview?.text === "string" ? stableHash(sourcePreview.text) : undefined,
    warnings: uniqueStrings(input.warnings ?? [])
  };
  return {
    ...object,
    fingerprint: stableHash({
      schema: object.schema,
      objectName: object.objectName,
      objectType: object.objectType,
      status: object.status,
      lastDdlTime: object.lastDdlTime,
      details: object.details,
      columns: object.columns,
      arguments: object.arguments,
      sourceFingerprint: object.sourceFingerprint
    })
  };
}

function summarizeSnapshotSchemas(
  mode: CompatibilityMode,
  tables: MetadataSnapshotTable[],
  objects: MetadataSnapshotOracleObject[]
): Array<{ schema?: string; tableCount: number; objectCount: number }> {
  const grouped = new Map<string, { schema?: string; tableCount: number; objectCount: number }>();
  for (const table of tables) {
    const key = normalizeIdentifier(mode, table.schema ?? "");
    const current = grouped.get(key) ?? { schema: table.schema, tableCount: 0, objectCount: 0 };
    current.tableCount += 1;
    grouped.set(key, current);
  }
  for (const object of objects) {
    const key = normalizeIdentifier(mode, object.schema ?? "");
    const current = grouped.get(key) ?? { schema: object.schema, tableCount: 0, objectCount: 0 };
    current.objectCount += 1;
    grouped.set(key, current);
  }
  return [...grouped.values()].sort((left, right) =>
    normalizeIdentifier(mode, left.schema ?? "").localeCompare(normalizeIdentifier(mode, right.schema ?? ""))
  );
}

function tableFingerprintPayload(table: Omit<MetadataSnapshotTable, "fingerprint">): unknown {
  return {
    schema: table.schema,
    table: table.table,
    tableType: table.tableType,
    engine: table.engine,
    comment: table.comment,
    rowEstimate: table.rowEstimate,
    stats: table.stats,
    columns: table.columns,
    indexes: table.indexes,
    constraints: table.constraints,
    partitions: table.partitions,
    truncated: table.truncated
  };
}

function columnTypeLabel(mode: CompatibilityMode, record: Record<string, unknown>): string | undefined {
  const columnType = stringField(record, "column_type", "COLUMN_TYPE");
  if (columnType) {
    return columnType;
  }
  const dataType = stringField(record, "data_type", "DATA_TYPE");
  if (!dataType) {
    return undefined;
  }
  const precision = numberField(record, "data_precision", "DATA_PRECISION");
  const scale = numberField(record, "data_scale", "DATA_SCALE");
  const length = numberField(record, "data_length", "DATA_LENGTH");
  if (mode === "oracle" && precision != null) {
    return scale != null ? `${dataType}(${precision},${scale})` : `${dataType}(${precision})`;
  }
  if (mode === "oracle" && length != null && ["CHAR", "NCHAR", "VARCHAR2", "NVARCHAR2", "RAW"].includes(dataType.toUpperCase())) {
    return `${dataType}(${length})`;
  }
  return dataType;
}

function indexUnique(record: Record<string, unknown>): boolean | undefined {
  const nonUnique = numberField(record, "non_unique", "NON_UNIQUE");
  if (nonUnique != null) {
    return nonUnique === 0;
  }
  const uniqueness = stringField(record, "uniqueness", "UNIQUENESS");
  return uniqueness ? uniqueness.toUpperCase() === "UNIQUE" : undefined;
}

function compareSnapshotColumns(left: MetadataSnapshotColumn, right: MetadataSnapshotColumn): number {
  if (left.position != null && right.position != null && left.position !== right.position) {
    return left.position - right.position;
  }
  return left.name.localeCompare(right.name);
}

function comparePartitions(left: MetadataSnapshotPartition, right: MetadataSnapshotPartition): number {
  const leftName = `${left.name ?? ""}.${left.subpartitionName ?? ""}`;
  const rightName = `${right.name ?? ""}.${right.subpartitionName ?? ""}`;
  return leftName.localeCompare(rightName);
}

function tableRefKey(mode: CompatibilityMode, schema: string | undefined, table: string): string {
  return `${schema ? normalizeIdentifier(mode, schema) : ""}.${normalizeIdentifier(mode, table)}`;
}

function normalizeIdentifier(mode: CompatibilityMode, value: string): string {
  return mode === "oracle" ? value.trim().toUpperCase() : value.trim().toLowerCase();
}

function rowRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function stringField(record: Record<string, unknown> | undefined, ...keys: string[]): string | undefined {
  if (!record) {
    return undefined;
  }
  const value = keys.map((key) => record[key]).find((item) => typeof item === "string" && item.trim());
  return typeof value === "string" ? value.trim() : undefined;
}

function numberField(record: Record<string, unknown>, ...keys: string[]): number | undefined {
  const value = keys.map((key) => record[key]).find((item) =>
    typeof item === "number" || (typeof item === "string" && item.trim() && Number.isFinite(Number(item)))
  );
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  return typeof value === "string" ? Number(value) : undefined;
}

function firstDefined(record: Record<string, unknown>, ...keys: string[]): unknown {
  return keys.map((key) => record[key]).find((item) => item !== undefined);
}

function stableRow(record: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!record) {
    return {};
  }
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record).sort(([left], [right]) => left.localeCompare(right))) {
    if (value instanceof Date) {
      output[key] = value.toISOString();
    } else if (typeof value === "bigint") {
      output[key] = value.toString();
    } else if (value && typeof value === "object" && !Array.isArray(value)) {
      output[key] = stableRow(value as Record<string, unknown>);
    } else if (Array.isArray(value)) {
      output[key] = value.map((item) => item && typeof item === "object" && !Array.isArray(item) ? stableRow(item as Record<string, unknown>) : item);
    } else {
      output[key] = value;
    }
  }
  return output;
}

function stableStringify(value: unknown): string {
  if (value == null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(",")}}`;
}

function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const output: string[] = [];
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
