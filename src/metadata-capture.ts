import type { ObConfig } from "./config.js";
import {
  describeTable,
  findRelatedTables,
  getObjectMetadata,
  getTableDdlMetadata,
  getTableStats,
  listObjects,
  listSchemaMapTables,
  type ObPool,
  type SchemaMapTable,
  type TableRelationship
} from "./db.js";
import {
  buildMetadataSnapshot,
  type MetadataSnapshotCacheStats,
  type MetadataSnapshotObjectInput,
  type MetadataSnapshotTableInput
} from "./metadata-change.js";
import {
  assertTableAccess,
  filterColumnMetadata,
  filterObjects,
  filterTables,
  isDeniedColumn,
  isMaskedColumn,
  isSchemaAllowed
} from "./policy.js";
import { withMetadataCache, withQuerySlot, type MetadataCacheStore } from "./runtime.js";

const SENSITIVE_SNAPSHOT_COLUMN_PATTERN =
  /(password|passwd|pwd|secret|token|api[_-]?key|private[_-]?key|credential|session|cookie|email|phone|mobile|id[_-]?card|ssn)/i;

export interface SnapshotRuntimeProfile {
  profile: string;
  config: ObConfig;
  pool: ObPool;
  limiter: {
    active: number;
    limit: number;
  };
  metadataCache: MetadataCacheStore;
}

export interface CaptureMetadataSnapshotInput {
  schema?: string;
  tablePattern?: string;
  objectTypes?: string[];
  includeRelationships?: boolean;
  includeOracleObjects?: boolean;
  maxTables?: number;
  maxColumnsPerTable?: number;
  maxObjects?: number;
  maxRelationships?: number;
}

export async function captureMetadataSnapshot(
  selected: SnapshotRuntimeProfile,
  input: CaptureMetadataSnapshotInput
) {
  const effectiveSchema = metadataSchema(selected.config, input.schema);
  if (effectiveSchema && !isSchemaAllowed(effectiveSchema, selected.config.policy)) {
    throw new Error(`Schema "${effectiveSchema}" is not allowed by the configured OceanBase MCP access policy.`);
  }

  const tableLimit = Math.min(input.maxTables ?? 30, 200);
  const columnLimit = Math.min(input.maxColumnsPerTable ?? 80, 200);
  const objectLimit = Math.min(input.maxObjects ?? 100, 500);
  const relationshipLimit = Math.min(input.maxRelationships ?? 200, 1_000);
  const includeRelationships = input.includeRelationships ?? true;
  const includeOracleObjects = input.includeOracleObjects ?? true;
  const requestedObjectTypes = input.objectTypes?.map((type) => type.replace(/_/g, " "));
  const warnings: string[] = [];
  const cacheBefore = metadataCacheCounters(selected);

  const rawTables = await cachedSchemaMapTables(selected, effectiveSchema, input.tablePattern, tableLimit + 1);
  const visibleTables = filterSchemaMapTables(rawTables, selected.config);
  const selectedTables = visibleTables.slice(0, tableLimit);
  const tables: MetadataSnapshotTableInput[] = [];
  const relationships: TableRelationship[] = [];
  let relationshipsTruncated = false;

  for (const tableInfo of selectedTables) {
    const schema = metadataSchema(selected.config, tableInfo.schema);
    const table = tableInfo.table;
    assertTableAccess(schema, table, policyContext(selected.config));
    const tableWarnings: string[] = [];
    const metadata = await cachedTableDdlMetadata(selected, schema, table, columnLimit);
    const visibleColumns = filterColumnMetadata(metadata.columns, selected.config.policy);
    const visibleIndexes = filterColumnMetadata(metadata.indexes, selected.config.policy);
    const visibleConstraints = filterColumnMetadata(metadata.constraints, selected.config.policy);
    const visiblePartitions = filterTables(metadata.partitions, selected.config.policy);
    let stats;
    try {
      stats = await cachedTableStats(selected, schema, table);
    } catch (error) {
      tableWarnings.push(`Table stats were skipped for ${schema ? `${schema}.` : ""}${table}: ${(error as Error).message}`);
    }

    tables.push({
      schema,
      table: metadata.table,
      tableType: tableInfo.tableType,
      engine: tableInfo.engine,
      comment: tableInfo.comment,
      rowEstimate: tableInfo.rowEstimate,
      stats,
      columns: visibleColumns.slice(0, columnLimit),
      indexes: visibleIndexes,
      constraints: visibleConstraints,
      partitions: visiblePartitions,
      maskedColumns: columnNames(visibleColumns).filter((column) => shouldMaskSnapshotColumn(column, selected.config, schema, table)),
      columnsTruncated: metadata.columnsTruncated || visibleColumns.length > columnLimit,
      warnings: uniqueStrings([
        ...metadata.warnings,
        ...tableWarnings
      ])
    });

    if (includeRelationships && relationships.length < relationshipLimit) {
      const remaining = relationshipLimit - relationships.length;
      const result = await cachedRelatedTables(selected, schema, table, 1, remaining + 1);
      const allowed = result.relations.filter((relation) => isRelationshipAllowed(relation, selected.config));
      relationships.push(...allowed.slice(0, remaining));
      if (result.truncated || allowed.length > remaining) {
        relationshipsTruncated = true;
      }
    }
  }

  const oracleObjects: MetadataSnapshotObjectInput[] = [];
  let objectsTruncated = false;
  if (includeOracleObjects) {
    if (selected.config.compatibility !== "oracle") {
      warnings.push("Oracle object snapshot is available only in Oracle compatibility mode.");
    } else {
      const objectList = await cachedOracleObjects(selected, effectiveSchema, requestedObjectTypes, objectLimit + 1);
      const visibleObjects = filterObjects(objectList.objects, selected.config.policy);
      objectsTruncated = visibleObjects.length > objectLimit || objectList.objects.length > objectLimit;
      for (const objectRow of visibleObjects.slice(0, objectLimit)) {
        const record = objectRow as Record<string, unknown>;
        const objectName = stringRecordValue(record, "object_name", "OBJECT_NAME");
        const objectType = stringRecordValue(record, "object_type", "OBJECT_TYPE");
        const objectSchema = stringRecordValue(record, "owner", "OWNER") ?? effectiveSchema;
        const objectWarnings: string[] = [];
        let objectMetadata: Record<string, unknown> | undefined;
        if (objectName && objectType) {
          try {
            objectMetadata = sanitizeObjectMetadata(
              await cachedOracleObjectMetadata(selected, objectSchema, objectName, objectType),
              selected.config
            );
          } catch (error) {
            objectWarnings.push(`Object metadata was skipped for ${objectSchema ? `${objectSchema}.` : ""}${objectName}: ${(error as Error).message}`);
          }
        }
        oracleObjects.push({
          summary: objectRow,
          metadata: objectMetadata,
          warnings: objectWarnings
        });
      }
    }
  }

  const cacheAfter = metadataCacheCounters(selected);
  return buildMetadataSnapshot({
    profile: selected.profile,
    compatibility: selected.config.compatibility,
    scope: {
      schema: effectiveSchema,
      tablePattern: input.tablePattern,
      objectTypes: requestedObjectTypes ?? ["view", "sequence", "synonym", "procedure", "function", "package", "package body"],
      includeRelationships,
      includeOracleObjects,
      maxTables: tableLimit,
      maxColumnsPerTable: columnLimit,
      maxObjects: objectLimit,
      maxRelationships: relationshipLimit
    },
    tables,
    oracleObjects,
    relationships: relationships.slice(0, relationshipLimit),
    cache: {
      used: selected.config.metadataCacheEnabled,
      before: cacheBefore,
      after: cacheAfter,
      delta: {
        entries: cacheAfter.entries - cacheBefore.entries,
        hits: cacheAfter.hits - cacheBefore.hits,
        misses: cacheAfter.misses - cacheBefore.misses,
        evictions: cacheAfter.evictions - cacheBefore.evictions
      },
      warnings: selected.config.metadataCacheEnabled
        ? ["Snapshot collection may reuse in-memory metadata cache. Use ob_refresh_metadata_cache when fresh metadata is required."]
        : []
    },
    truncated: {
      tables: visibleTables.length > tableLimit || rawTables.length > tableLimit,
      objects: objectsTruncated,
      relationships: relationshipsTruncated
    },
    warnings
  });
}

async function cachedSchemaMapTables(
  selected: SnapshotRuntimeProfile,
  schema: string | undefined,
  tablePattern: string | undefined,
  limit: number
) {
  return withMetadataCache(selected, "schema_map_tables", [selected.config.compatibility, schema ?? "", tablePattern ?? "", limit], () =>
    withQuerySlot(selected, () =>
      listSchemaMapTables(
        selected.pool,
        selected.config.compatibility,
        schema,
        tablePattern,
        limit,
        selected.config.queryTimeoutMs
      )
    )
  );
}

async function cachedTableDdlMetadata(
  selected: SnapshotRuntimeProfile,
  schema: string | undefined,
  table: string,
  maxColumns?: number
) {
  return withMetadataCache(selected, "table_ddl_metadata", [selected.config.compatibility, schema ?? "", table, maxColumns ?? ""], () =>
    withQuerySlot(selected, () =>
      getTableDdlMetadata(selected.pool, selected.config.compatibility, table, schema, selected.config.queryTimeoutMs, maxColumns)
    )
  );
}

async function cachedTableStats(
  selected: SnapshotRuntimeProfile,
  schema: string | undefined,
  table: string
) {
  return withMetadataCache(selected, "table_stats", [selected.config.compatibility, schema ?? "", table], () =>
    withQuerySlot(selected, () =>
      getTableStats(selected.pool, selected.config.compatibility, table, schema, selected.config.queryTimeoutMs)
    )
  );
}

async function cachedRelatedTables(
  selected: SnapshotRuntimeProfile,
  schema: string | undefined,
  table: string,
  depth: number,
  limit: number
) {
  return withMetadataCache(selected, "related_tables", [selected.config.compatibility, schema ?? "", table, depth, limit], () =>
    withQuerySlot(selected, () =>
      findRelatedTables(
        selected.pool,
        selected.config.compatibility,
        table,
        schema,
        depth,
        limit,
        selected.config.queryTimeoutMs
      )
    )
  );
}

async function cachedOracleObjects(
  selected: SnapshotRuntimeProfile,
  schema: string | undefined,
  objectTypes: string[] | undefined,
  limit: number
) {
  return withMetadataCache(selected, "oracle_objects", [selected.config.compatibility, schema ?? "", objectTypes ?? [], limit], () =>
    withQuerySlot(selected, () =>
      listObjects(
        selected.pool,
        selected.config.compatibility,
        schema,
        undefined,
        objectTypes,
        limit,
        selected.config.queryTimeoutMs
      )
    )
  );
}

async function cachedOracleObjectMetadata(
  selected: SnapshotRuntimeProfile,
  schema: string | undefined,
  objectName: string,
  objectType: string
) {
  return withMetadataCache(selected, "oracle_object_metadata", [selected.config.compatibility, schema ?? "", objectName, objectType], () =>
    withQuerySlot(selected, () =>
      getObjectMetadata(
        selected.pool,
        selected.config.compatibility,
        objectName,
        objectType,
        schema,
        selected.config.queryTimeoutMs
      )
    )
  );
}

function metadataCacheCounters(selected: SnapshotRuntimeProfile): MetadataSnapshotCacheStats {
  return {
    entries: selected.metadataCache.entries.size,
    hits: selected.metadataCache.hits,
    misses: selected.metadataCache.misses,
    evictions: selected.metadataCache.evictions
  };
}

function filterSchemaMapTables(rows: SchemaMapTable[], config: ObConfig) {
  return rows.filter((table) => {
    try {
      assertTableAccess(table.schema, table.table, policyContext(config));
      return true;
    } catch {
      return false;
    }
  });
}

function isRelationshipAllowed(relation: TableRelationship, config: ObConfig): boolean {
  try {
    assertTableAccess(relation.sourceSchema, relation.sourceTable, policyContext(config));
    assertTableAccess(relation.targetSchema, relation.targetTable, policyContext(config));
  } catch {
    return false;
  }
  return [...relation.sourceColumns, ...relation.targetColumns].every(
    (column) => !isDeniedColumn(column, config.policy)
  );
}

function sanitizeObjectMetadata(metadata: unknown, config: ObConfig): Record<string, unknown> {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return { value: metadata };
  }
  const record = metadata as Record<string, unknown>;
  const columns = Array.isArray(record.columns) ? filterColumnMetadata(record.columns, config.policy) : undefined;
  const argumentRows = Array.isArray(record.arguments) ? filterArgumentMetadata(record.arguments, config) : undefined;
  return {
    ...record,
    ...(columns ? { columns } : {}),
    ...(argumentRows ? { arguments: argumentRows } : {})
  };
}

function filterArgumentMetadata(rows: unknown[], config: ObConfig): unknown[] {
  return rows.filter((row) => {
    const record = row as Record<string, unknown>;
    const argument = stringRecordValue(record, "argument_name", "ARGUMENT_NAME");
    return !argument || !isDeniedColumn(argument, config.policy);
  });
}

function columnNames(rows: unknown[]): string[] {
  const names: string[] = [];
  for (const row of rows) {
    const record = row as Record<string, unknown>;
    const value = record.column_name ?? record.COLUMN_NAME;
    if (typeof value === "string" && value.trim()) {
      names.push(value.trim());
    }
  }
  return [...new Set(names)];
}

function shouldMaskSnapshotColumn(column: string, config: ObConfig, schema?: string, table?: string): boolean {
  return (
    isMaskedColumn(column, config.policy, schema, table) ||
    isDeniedColumn(column, config.policy) ||
    SENSITIVE_SNAPSHOT_COLUMN_PATTERN.test(column)
  );
}

function metadataSchema(config: ObConfig, schema: string | undefined): string | undefined {
  return config.compatibility === "oracle" ? schema?.trim().toUpperCase() : schema?.trim();
}

function policyContext(config: ObConfig) {
  return {
    policy: config.policy,
    compatibility: config.compatibility
  };
}

function stringRecordValue(record: Record<string, unknown>, ...keys: string[]): string | undefined {
  const value = keys.map((key) => record[key]).find((item) => typeof item === "string" && item.trim());
  return typeof value === "string" ? value.trim() : undefined;
}

function uniqueStrings(values: string[]): string[] {
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
