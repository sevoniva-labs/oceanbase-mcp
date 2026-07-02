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

export interface CompareMetadataSnapshotsOptions {
  changedOnly?: boolean;
  riskOnly?: boolean;
  summaryOnly?: boolean;
}

export interface MetadataSnapshotChange {
  category: "schema" | "table" | "column" | "index" | "constraint" | "partition" | "oracle_object" | "relationship";
  changeType: "added" | "removed" | "modified";
  severity: "low" | "medium" | "high";
  breaking: boolean;
  affectedObject: {
    schema?: string;
    table?: string;
    column?: string;
    name?: string;
    objectName?: string;
    objectType?: string;
  };
  evidence: string[];
  before?: unknown;
  after?: unknown;
  changes?: Array<{ field: string; before: unknown; after: unknown }>;
}

export interface MetadataSnapshotComparison {
  comparisonVersion: string;
  before: MetadataSnapshotComparisonSide;
  after: MetadataSnapshotComparisonSide;
  fingerprintEqual: boolean;
  options: Required<CompareMetadataSnapshotsOptions>;
  summary: {
    totalChanges: number;
    breakingChanges: number;
    byCategory: Record<string, number>;
    bySeverity: Record<string, number>;
  };
  changes: {
    schemas: MetadataSnapshotChange[];
    tables: MetadataSnapshotChange[];
    columns: MetadataSnapshotChange[];
    indexes: MetadataSnapshotChange[];
    constraints: MetadataSnapshotChange[];
    partitions: MetadataSnapshotChange[];
    oracleObjects: MetadataSnapshotChange[];
    relationships: MetadataSnapshotChange[];
  };
  breakingChanges: MetadataSnapshotChange[];
  warnings: string[];
  executed: false;
}

export interface MetadataSnapshotComparisonSide {
  snapshotVersion?: string;
  capturedAt?: string;
  profile?: string;
  compatibility?: CompatibilityMode;
  fingerprint?: string;
  tableCount: number;
  objectCount: number;
  relationshipCount: number;
  scope?: MetadataSnapshotScope;
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

export function parseMetadataSnapshotInput(value: MetadataSnapshot | string | Record<string, unknown>, name: string): MetadataSnapshot {
  const parsed = typeof value === "string" ? JSON.parse(value) : value;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${name} must be a metadata snapshot object or JSON string.`);
  }
  const record = parsed as Partial<MetadataSnapshot>;
  if (!Array.isArray(record.tables) || !Array.isArray(record.oracleObjects) || !Array.isArray(record.relationships)) {
    throw new Error(`${name} is not a valid metadata snapshot.`);
  }
  return record as MetadataSnapshot;
}

export function parseMetadataComparisonInput(
  value: MetadataSnapshotComparison | string | Record<string, unknown>,
  name = "metadataDiff"
): MetadataSnapshotComparison {
  const parsed = typeof value === "string" ? JSON.parse(value) : value;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${name} must be a metadata snapshot comparison object or JSON string.`);
  }
  const record = parsed as Partial<MetadataSnapshotComparison>;
  if (!record.changes || typeof record.changes !== "object" || !record.summary) {
    throw new Error(`${name} is not a valid metadata snapshot comparison.`);
  }
  return record as MetadataSnapshotComparison;
}

export function compareMetadataSnapshots(
  beforeInput: MetadataSnapshot | string | Record<string, unknown>,
  afterInput: MetadataSnapshot | string | Record<string, unknown>,
  options: CompareMetadataSnapshotsOptions = {}
): MetadataSnapshotComparison {
  const before = parseMetadataSnapshotInput(beforeInput, "before");
  const after = parseMetadataSnapshotInput(afterInput, "after");
  const effectiveOptions = {
    changedOnly: options.changedOnly ?? true,
    riskOnly: options.riskOnly ?? false,
    summaryOnly: options.summaryOnly ?? false
  };
  const mode = after.compatibility ?? before.compatibility ?? "mysql";
  const warnings = uniqueStrings([
    before.compatibility !== after.compatibility ? "Snapshots use different compatibility modes; identifier comparison uses the after snapshot mode." : "",
    before.snapshotVersion !== after.snapshotVersion ? "Snapshots use different snapshot versions." : "",
    before.truncated?.tables || before.truncated?.columns || before.truncated?.objects || before.truncated?.relationships ? "Before snapshot is truncated; diff may be incomplete." : "",
    after.truncated?.tables || after.truncated?.columns || after.truncated?.objects || after.truncated?.relationships ? "After snapshot is truncated; diff may be incomplete." : "",
    "Diff is based only on metadata present in the two snapshots."
  ]);

  const changes = {
    schemas: compareSchemas(mode, before, after),
    tables: compareTables(mode, before, after),
    columns: compareTableChildren(mode, before, after, "column"),
    indexes: compareTableChildren(mode, before, after, "index"),
    constraints: compareTableChildren(mode, before, after, "constraint"),
    partitions: compareTableChildren(mode, before, after, "partition"),
    oracleObjects: compareOracleObjects(mode, before, after),
    relationships: compareRelationships(before, after)
  };
  const filteredChanges = filterComparisonChanges(changes, effectiveOptions);
  const flat = flattenComparisonChanges(filteredChanges);
  const summary = summarizeComparisonChanges(flat);

  return {
    comparisonVersion: METADATA_SNAPSHOT_VERSION,
    before: comparisonSide(before),
    after: comparisonSide(after),
    fingerprintEqual: Boolean(before.fingerprint && before.fingerprint === after.fingerprint),
    options: effectiveOptions,
    summary,
    changes: effectiveOptions.summaryOnly ? emptyComparisonChanges() : filteredChanges,
    breakingChanges: flat.filter((change) => change.breaking),
    warnings,
    executed: false
  };
}

export function renderMetadataComparisonMarkdown(
  comparison: MetadataSnapshotComparison,
  title = "OceanBase Metadata Snapshot Diff"
): string {
  const lines = [
    `# ${title}`,
    "",
    "## Summary",
    "",
    `- Before: ${comparison.before.capturedAt ?? "(unknown)"} (${comparison.before.fingerprint ?? "no fingerprint"})`,
    `- After: ${comparison.after.capturedAt ?? "(unknown)"} (${comparison.after.fingerprint ?? "no fingerprint"})`,
    `- Total changes: ${comparison.summary.totalChanges}`,
    `- Breaking changes: ${comparison.summary.breakingChanges}`,
    `- Fingerprint equal: ${comparison.fingerprintEqual ? "yes" : "no"}`,
    "",
    "| Category | Count |",
    "| --- | ---: |",
    ...Object.entries(comparison.summary.byCategory)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([category, count]) => `| ${markdownCell(category)} | ${count} |`),
    "",
    "## Changes",
    ""
  ];

  for (const [label, changes] of comparisonChangeGroups(comparison)) {
    if (changes.length === 0) {
      continue;
    }
    lines.push(`### ${label}`);
    lines.push("");
    lines.push("| Severity | Change | Object | Breaking | Evidence |");
    lines.push("| --- | --- | --- | --- | --- |");
    for (const change of changes) {
      lines.push([
        change.severity,
        change.changeType,
        changeObjectLabel(change),
        change.breaking ? "yes" : "no",
        change.evidence.join("; ")
      ].map((value) => markdownCell(String(value))).join(" | ").replace(/^/, "| ").replace(/$/, " |"));
    }
    lines.push("");
  }

  if (comparison.breakingChanges.length > 0) {
    lines.push("## Review Items");
    lines.push("");
    for (const change of comparison.breakingChanges) {
      lines.push(`- ${changeObjectLabel(change)}: ${change.evidence.join("; ")}`);
    }
    lines.push("");
  }

  if (comparison.warnings.length > 0) {
    lines.push("## Limits");
    lines.push("");
    for (const warning of comparison.warnings) {
      lines.push(`- ${warning}`);
    }
    lines.push("");
  }

  lines.push("No executable DDL, DCL, or DML is included in this report.");
  return lines.join("\n");
}

export function stableHash(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

function compareSchemas(mode: CompatibilityMode, before: MetadataSnapshot, after: MetadataSnapshot): MetadataSnapshotChange[] {
  const beforeSchemas = new Map(before.schemas.map((schema) => [normalizeIdentifier(mode, schema.schema ?? ""), schema]));
  const afterSchemas = new Map(after.schemas.map((schema) => [normalizeIdentifier(mode, schema.schema ?? ""), schema]));
  const changes: MetadataSnapshotChange[] = [];
  for (const [key, beforeSchema] of beforeSchemas) {
    if (!afterSchemas.has(key)) {
      changes.push({
        category: "schema",
        changeType: "removed",
        severity: "high",
        breaking: true,
        affectedObject: { schema: beforeSchema.schema },
        evidence: [`Schema ${beforeSchema.schema ?? "(default)"} was present before and missing after.`],
        before: beforeSchema
      });
    }
  }
  for (const [key, afterSchema] of afterSchemas) {
    if (!beforeSchemas.has(key)) {
      changes.push({
        category: "schema",
        changeType: "added",
        severity: "low",
        breaking: false,
        affectedObject: { schema: afterSchema.schema },
        evidence: [`Schema ${afterSchema.schema ?? "(default)"} was added in the after snapshot.`],
        after: afterSchema
      });
    }
  }
  return changes;
}

function compareTables(mode: CompatibilityMode, before: MetadataSnapshot, after: MetadataSnapshot): MetadataSnapshotChange[] {
  const beforeTables = tableMap(mode, before.tables);
  const afterTables = tableMap(mode, after.tables);
  const changes: MetadataSnapshotChange[] = [];
  for (const [key, beforeTable] of beforeTables) {
    const afterTable = afterTables.get(key);
    if (!afterTable) {
      changes.push({
        category: "table",
        changeType: "removed",
        severity: "high",
        breaking: true,
        affectedObject: { schema: beforeTable.schema, table: beforeTable.table },
        evidence: [`Table ${qualifiedName(beforeTable.schema, beforeTable.table)} was removed.`],
        before: tableSummaryForDiff(beforeTable)
      });
      continue;
    }
    if (beforeTable.fingerprint === afterTable.fingerprint) {
      continue;
    }
    const tableChanges = changedFields(beforeTable, afterTable, ["tableType", "engine", "comment"]);
    if (tableChanges.length > 0) {
      changes.push({
        category: "table",
        changeType: "modified",
        severity: "low",
        breaking: false,
        affectedObject: { schema: afterTable.schema, table: afterTable.table },
        evidence: tableChanges.map((change) => `Table ${qualifiedName(afterTable.schema, afterTable.table)} changed ${change.field}.`),
        before: tableSummaryForDiff(beforeTable),
        after: tableSummaryForDiff(afterTable),
        changes: tableChanges
      });
    }
  }
  for (const [key, afterTable] of afterTables) {
    if (!beforeTables.has(key)) {
      changes.push({
        category: "table",
        changeType: "added",
        severity: "low",
        breaking: false,
        affectedObject: { schema: afterTable.schema, table: afterTable.table },
        evidence: [`Table ${qualifiedName(afterTable.schema, afterTable.table)} was added.`],
        after: tableSummaryForDiff(afterTable)
      });
    }
  }
  return changes;
}

function compareTableChildren(
  mode: CompatibilityMode,
  before: MetadataSnapshot,
  after: MetadataSnapshot,
  kind: "column" | "index" | "constraint" | "partition"
): MetadataSnapshotChange[] {
  const beforeTables = tableMap(mode, before.tables);
  const afterTables = tableMap(mode, after.tables);
  const changes: MetadataSnapshotChange[] = [];
  for (const [key, beforeTable] of beforeTables) {
    const afterTable = afterTables.get(key);
    if (!afterTable || beforeTable.fingerprint === afterTable.fingerprint) {
      continue;
    }
    const beforeItems = childMap(mode, beforeTable, kind);
    const afterItems = childMap(mode, afterTable, kind);
    for (const [itemKey, beforeItem] of beforeItems) {
      const afterItem = afterItems.get(itemKey);
      if (!afterItem) {
        changes.push(removedChildChange(kind, beforeTable, beforeItem));
        continue;
      }
      const itemChanges = childChangedFields(kind, beforeItem, afterItem);
      if (itemChanges.length > 0) {
        changes.push(modifiedChildChange(kind, afterTable, beforeItem, afterItem, itemChanges));
      }
    }
    for (const [itemKey, afterItem] of afterItems) {
      if (!beforeItems.has(itemKey)) {
        changes.push(addedChildChange(kind, afterTable, afterItem));
      }
    }
  }
  return changes;
}

function compareOracleObjects(mode: CompatibilityMode, before: MetadataSnapshot, after: MetadataSnapshot): MetadataSnapshotChange[] {
  const beforeObjects = oracleObjectMap(mode, before.oracleObjects);
  const afterObjects = oracleObjectMap(mode, after.oracleObjects);
  const changes: MetadataSnapshotChange[] = [];
  for (const [key, beforeObject] of beforeObjects) {
    const afterObject = afterObjects.get(key);
    if (!afterObject) {
      changes.push({
        category: "oracle_object",
        changeType: "removed",
        severity: "high",
        breaking: true,
        affectedObject: { schema: beforeObject.schema, objectName: beforeObject.objectName, objectType: beforeObject.objectType },
        evidence: [`Oracle object ${qualifiedName(beforeObject.schema, beforeObject.objectName)} (${beforeObject.objectType}) was removed.`],
        before: oracleObjectSummaryForDiff(beforeObject)
      });
      continue;
    }
    if (beforeObject.fingerprint === afterObject.fingerprint) {
      continue;
    }
    const objectChanges = changedFields(beforeObject, afterObject, ["status", "lastDdlTime", "details", "columns", "arguments", "sourceFingerprint"]);
    changes.push({
      category: "oracle_object",
      changeType: "modified",
      severity: afterObject.status && afterObject.status !== "VALID" ? "high" : "medium",
      breaking: afterObject.status ? afterObject.status !== "VALID" : false,
      affectedObject: { schema: afterObject.schema, objectName: afterObject.objectName, objectType: afterObject.objectType },
      evidence: objectChanges.map((change) => `Oracle object ${qualifiedName(afterObject.schema, afterObject.objectName)} changed ${change.field}.`),
      before: oracleObjectSummaryForDiff(beforeObject),
      after: oracleObjectSummaryForDiff(afterObject),
      changes: objectChanges
    });
  }
  for (const [key, afterObject] of afterObjects) {
    if (!beforeObjects.has(key)) {
      changes.push({
        category: "oracle_object",
        changeType: "added",
        severity: "low",
        breaking: false,
        affectedObject: { schema: afterObject.schema, objectName: afterObject.objectName, objectType: afterObject.objectType },
        evidence: [`Oracle object ${qualifiedName(afterObject.schema, afterObject.objectName)} (${afterObject.objectType}) was added.`],
        after: oracleObjectSummaryForDiff(afterObject)
      });
    }
  }
  return changes;
}

function compareRelationships(before: MetadataSnapshot, after: MetadataSnapshot): MetadataSnapshotChange[] {
  const beforeRelationships = new Map(before.relationships.map((relationship) => [relationship.fingerprint, relationship]));
  const afterRelationships = new Map(after.relationships.map((relationship) => [relationship.fingerprint, relationship]));
  const changes: MetadataSnapshotChange[] = [];
  for (const [key, beforeRelationship] of beforeRelationships) {
    if (!afterRelationships.has(key)) {
      changes.push({
        category: "relationship",
        changeType: "removed",
        severity: "medium",
        breaking: false,
        affectedObject: {
          schema: beforeRelationship.sourceSchema,
          table: beforeRelationship.sourceTable,
          name: relationshipLabel(beforeRelationship)
        },
        evidence: [`Relationship ${relationshipLabel(beforeRelationship)} was removed from the after snapshot.`],
        before: beforeRelationship
      });
    }
  }
  for (const [key, afterRelationship] of afterRelationships) {
    if (!beforeRelationships.has(key)) {
      changes.push({
        category: "relationship",
        changeType: "added",
        severity: "low",
        breaking: false,
        affectedObject: {
          schema: afterRelationship.sourceSchema,
          table: afterRelationship.sourceTable,
          name: relationshipLabel(afterRelationship)
        },
        evidence: [`Relationship ${relationshipLabel(afterRelationship)} was added in the after snapshot.`],
        after: afterRelationship
      });
    }
  }
  return changes;
}

function comparisonSide(snapshot: MetadataSnapshot): MetadataSnapshotComparisonSide {
  return {
    snapshotVersion: snapshot.snapshotVersion,
    capturedAt: snapshot.capturedAt,
    profile: snapshot.profile,
    compatibility: snapshot.compatibility,
    fingerprint: snapshot.fingerprint,
    tableCount: snapshot.tableCount,
    objectCount: snapshot.objectCount,
    relationshipCount: snapshot.relationshipCount,
    scope: snapshot.scope
  };
}

function filterComparisonChanges(
  changes: MetadataSnapshotComparison["changes"],
  options: Required<CompareMetadataSnapshotsOptions>
): MetadataSnapshotComparison["changes"] {
  const filter = (items: MetadataSnapshotChange[]) =>
    options.riskOnly ? items.filter((item) => item.breaking || item.severity === "high" || item.severity === "medium") : items;
  return {
    schemas: filter(changes.schemas),
    tables: filter(changes.tables),
    columns: filter(changes.columns),
    indexes: filter(changes.indexes),
    constraints: filter(changes.constraints),
    partitions: filter(changes.partitions),
    oracleObjects: filter(changes.oracleObjects),
    relationships: filter(changes.relationships)
  };
}

function emptyComparisonChanges(): MetadataSnapshotComparison["changes"] {
  return {
    schemas: [],
    tables: [],
    columns: [],
    indexes: [],
    constraints: [],
    partitions: [],
    oracleObjects: [],
    relationships: []
  };
}

function flattenComparisonChanges(changes: MetadataSnapshotComparison["changes"]): MetadataSnapshotChange[] {
  return [
    ...changes.schemas,
    ...changes.tables,
    ...changes.columns,
    ...changes.indexes,
    ...changes.constraints,
    ...changes.partitions,
    ...changes.oracleObjects,
    ...changes.relationships
  ];
}

function summarizeComparisonChanges(changes: MetadataSnapshotChange[]): MetadataSnapshotComparison["summary"] {
  const byCategory: Record<string, number> = {};
  const bySeverity: Record<string, number> = {};
  for (const change of changes) {
    byCategory[change.category] = (byCategory[change.category] ?? 0) + 1;
    bySeverity[change.severity] = (bySeverity[change.severity] ?? 0) + 1;
  }
  return {
    totalChanges: changes.length,
    breakingChanges: changes.filter((change) => change.breaking).length,
    byCategory,
    bySeverity
  };
}

function comparisonChangeGroups(comparison: MetadataSnapshotComparison): Array<[string, MetadataSnapshotChange[]]> {
  return [
    ["Schemas", comparison.changes.schemas],
    ["Tables", comparison.changes.tables],
    ["Columns", comparison.changes.columns],
    ["Indexes", comparison.changes.indexes],
    ["Constraints", comparison.changes.constraints],
    ["Partitions", comparison.changes.partitions],
    ["Oracle Objects", comparison.changes.oracleObjects],
    ["Relationships", comparison.changes.relationships]
  ];
}

function changeObjectLabel(change: MetadataSnapshotChange): string {
  const object = change.affectedObject;
  if (object.objectName) {
    return `${object.schema ? `${object.schema}.` : ""}${object.objectName}${object.objectType ? ` (${object.objectType})` : ""}`;
  }
  if (object.column) {
    return `${object.schema ? `${object.schema}.` : ""}${object.table ?? "*"}.${object.column}`;
  }
  if (object.name) {
    return `${object.schema ? `${object.schema}.` : ""}${object.table ?? "*"}.${object.name}`;
  }
  if (object.table) {
    return `${object.schema ? `${object.schema}.` : ""}${object.table}`;
  }
  return object.schema ?? "(unknown)";
}

function tableMap(mode: CompatibilityMode, tables: MetadataSnapshotTable[]): Map<string, MetadataSnapshotTable> {
  return new Map(tables.map((table) => [tableRefKey(mode, table.schema, table.table), table]));
}

function oracleObjectMap(mode: CompatibilityMode, objects: MetadataSnapshotOracleObject[]): Map<string, MetadataSnapshotOracleObject> {
  return new Map(objects.map((object) => [
    [
      normalizeIdentifier(mode, object.schema ?? ""),
      normalizeIdentifier(mode, object.objectName),
      normalizeIdentifier(mode, object.objectType)
    ].join("."),
    object
  ]));
}

function childMap(
  mode: CompatibilityMode,
  table: MetadataSnapshotTable,
  kind: "column" | "index" | "constraint" | "partition"
): Map<string, unknown> {
  if (kind === "column") {
    return new Map(table.columns.map((column) => [normalizeIdentifier(mode, column.name), column]));
  }
  if (kind === "index") {
    return new Map(table.indexes.map((index) => [normalizeIdentifier(mode, index.name), index]));
  }
  if (kind === "constraint") {
    return new Map(table.constraints.map((constraint) => [normalizeIdentifier(mode, constraint.name), constraint]));
  }
  return new Map(table.partitions.map((partition) => [normalizeIdentifier(mode, partitionLabel(partition)), partition]));
}

function removedChildChange(
  kind: "column" | "index" | "constraint" | "partition",
  table: MetadataSnapshotTable,
  item: unknown
): MetadataSnapshotChange {
  const name = childName(kind, item);
  const severity = removedChildSeverity(kind, item);
  return {
    category: childCategory(kind),
    changeType: "removed",
    severity,
    breaking: kind === "column" || severity === "high",
    affectedObject: { schema: table.schema, table: table.table, column: kind === "column" ? name : undefined, name },
    evidence: [`${childLabel(kind)} ${qualifiedName(table.schema, table.table)}.${name} was removed.`],
    before: item
  };
}

function addedChildChange(
  kind: "column" | "index" | "constraint" | "partition",
  table: MetadataSnapshotTable,
  item: unknown
): MetadataSnapshotChange {
  const name = childName(kind, item);
  const severity = addedChildSeverity(kind, item);
  return {
    category: childCategory(kind),
    changeType: "added",
    severity,
    breaking: kind === "column" && isRequiredColumn(item),
    affectedObject: { schema: table.schema, table: table.table, column: kind === "column" ? name : undefined, name },
    evidence: [`${childLabel(kind)} ${qualifiedName(table.schema, table.table)}.${name} was added.`],
    after: item
  };
}

function modifiedChildChange(
  kind: "column" | "index" | "constraint" | "partition",
  table: MetadataSnapshotTable,
  before: unknown,
  after: unknown,
  changes: Array<{ field: string; before: unknown; after: unknown }>
): MetadataSnapshotChange {
  const name = childName(kind, after);
  const severity = modifiedChildSeverity(kind, changes);
  return {
    category: childCategory(kind),
    changeType: "modified",
    severity,
    breaking: severity === "high",
    affectedObject: { schema: table.schema, table: table.table, column: kind === "column" ? name : undefined, name },
    evidence: changes.map((change) => `${childLabel(kind)} ${qualifiedName(table.schema, table.table)}.${name} changed ${change.field}.`),
    before,
    after,
    changes
  };
}

function childChangedFields(
  kind: "column" | "index" | "constraint" | "partition",
  before: unknown,
  after: unknown
): Array<{ field: string; before: unknown; after: unknown }> {
  if (kind === "column") {
    return changedFields(before, after, ["type", "nullable", "defaultValue", "comment", "key"]);
  }
  if (kind === "index") {
    return changedFields(before, after, ["unique", "type", "columns"]);
  }
  if (kind === "constraint") {
    return changedFields(before, after, ["type", "columns", "referencedSchema", "referencedTable", "referencedColumns"]);
  }
  return changedFields(before, after, ["method", "expression", "description", "tablespace"]);
}

function changedFields(
  before: unknown,
  after: unknown,
  fields: string[]
): Array<{ field: string; before: unknown; after: unknown }> {
  const beforeRecord = before && typeof before === "object" ? before as Record<string, unknown> : {};
  const afterRecord = after && typeof after === "object" ? after as Record<string, unknown> : {};
  return fields
    .filter((field) => stableStringify(beforeRecord[field]) !== stableStringify(afterRecord[field]))
    .map((field) => ({ field, before: beforeRecord[field], after: afterRecord[field] }));
}

function childCategory(kind: "column" | "index" | "constraint" | "partition"): MetadataSnapshotChange["category"] {
  if (kind === "column") {
    return "column";
  }
  if (kind === "index") {
    return "index";
  }
  if (kind === "constraint") {
    return "constraint";
  }
  return "partition";
}

function childLabel(kind: "column" | "index" | "constraint" | "partition"): string {
  return kind[0].toUpperCase() + kind.slice(1);
}

function childName(kind: "column" | "index" | "constraint" | "partition", item: unknown): string {
  const record = item && typeof item === "object" ? item as Record<string, unknown> : {};
  if (kind === "column" || kind === "index" || kind === "constraint") {
    return String(record.name ?? "");
  }
  return [record.name, record.subpartitionName].filter((value) => typeof value === "string" && value.trim()).join(".") || "(partition)";
}

function partitionLabel(partition: MetadataSnapshotPartition): string {
  return [partition.name, partition.subpartitionName].filter(Boolean).join(".") || "(partition)";
}

function removedChildSeverity(kind: "column" | "index" | "constraint" | "partition", item: unknown): MetadataSnapshotChange["severity"] {
  if (kind === "column") {
    return "high";
  }
  if (kind === "constraint") {
    return importantConstraint(item) ? "high" : "medium";
  }
  return "medium";
}

function addedChildSeverity(kind: "column" | "index" | "constraint" | "partition", item: unknown): MetadataSnapshotChange["severity"] {
  if (kind === "column" && isRequiredColumn(item)) {
    return "medium";
  }
  return "low";
}

function modifiedChildSeverity(
  kind: "column" | "index" | "constraint" | "partition",
  changes: Array<{ field: string; before: unknown; after: unknown }>
): MetadataSnapshotChange["severity"] {
  if (kind === "column" && changes.some((change) => ["type", "nullable", "defaultValue"].includes(change.field))) {
    return "high";
  }
  if (kind === "constraint" || kind === "partition") {
    return "medium";
  }
  if (kind === "index" && changes.some((change) => change.field === "columns" || change.field === "unique")) {
    return "medium";
  }
  return "low";
}

function isRequiredColumn(item: unknown): boolean {
  const record = item && typeof item === "object" ? item as Partial<MetadataSnapshotColumn> : {};
  return record.nullable === false && record.defaultValue == null;
}

function importantConstraint(item: unknown): boolean {
  const record = item && typeof item === "object" ? item as Partial<MetadataSnapshotConstraint> : {};
  const type = String(record.type ?? "").toUpperCase();
  return ["PRIMARY KEY", "P", "UNIQUE", "U", "R", "FOREIGN KEY", "NOT_NULL"].includes(type);
}

function tableSummaryForDiff(table: MetadataSnapshotTable): Record<string, unknown> {
  return {
    schema: table.schema,
    table: table.table,
    tableType: table.tableType,
    engine: table.engine,
    comment: table.comment,
    columnCount: table.columns.length,
    indexCount: table.indexes.length,
    constraintCount: table.constraints.length,
    partitionCount: table.partitions.length,
    fingerprint: table.fingerprint
  };
}

function oracleObjectSummaryForDiff(object: MetadataSnapshotOracleObject): Record<string, unknown> {
  return {
    schema: object.schema,
    objectName: object.objectName,
    objectType: object.objectType,
    status: object.status,
    lastDdlTime: object.lastDdlTime,
    sourceFingerprint: object.sourceFingerprint,
    fingerprint: object.fingerprint
  };
}

function relationshipLabel(relationship: MetadataSnapshotRelationship): string {
  return `${qualifiedName(relationship.sourceSchema, relationship.sourceTable)}(${relationship.sourceColumns.join(",")}) -> ${qualifiedName(relationship.targetSchema, relationship.targetTable)}(${relationship.targetColumns.join(",")})`;
}

function qualifiedName(schema: string | undefined, name: string): string {
  return schema ? `${schema}.${name}` : name;
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

function markdownCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}
