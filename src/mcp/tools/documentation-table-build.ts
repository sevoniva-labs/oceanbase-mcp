import {
  getTableDdlMetadata,
  getTableStats,
  type TableRelationship
} from "../../db.js";
import {
  assertTableAccess,
  filterColumnMetadata,
  filterTables
} from "../../policy.js";
import { effectiveRowLimit } from "../../query/output.js";
import { generateQueryTemplates } from "../../query-generation.js";
import { withQuerySlot, type selectRuntimeProfile } from "../../runtime.js";
import {
  inferTablePurpose,
  mapperConstraintSummary,
  mapperIndexSummary
} from "../metadata-summary.js";
import { metadataTableRef } from "../metadata-scope.js";
import { policyContext } from "../policy-context.js";
import { queryExampleFromTemplate } from "../query-examples.js";
import {
  buildSchemaMapRelationshipSummary,
  compactSchemaColumns,
  findSchemaMapTableInfo,
  importantSchemaMapFields,
  schemaMapPrimaryKeyColumns,
  uniqueKeyGroups
} from "./schema-map.js";

export async function buildTableDocument(
  selected: ReturnType<typeof selectRuntimeProfile>,
  input: {
    schema?: string;
    table: string;
    includeRelationships: boolean;
    includeQueryExamples: boolean;
    maxColumns: number;
    relationshipLimit: number;
    maxExamples: number;
  }
) {
  const ref = metadataTableRef(selected.config, input.schema, input.table);
  assertTableAccess(ref.schema, ref.table, policyContext(selected.config));
  const metadata = await withQuerySlot(selected, () =>
    getTableDdlMetadata(selected.pool, selected.config.compatibility, ref.table, ref.schema, selected.config.queryTimeoutMs)
  );
  const columns = filterColumnMetadata(metadata.columns, selected.config.policy);
  const indexes = filterColumnMetadata(metadata.indexes, selected.config.policy);
  const constraints = filterColumnMetadata(metadata.constraints, selected.config.policy);
  const partitions = filterTables(metadata.partitions, selected.config.policy);
  const compactColumns = compactSchemaColumns(columns, constraints, selected.config, metadata.schema, metadata.table);
  const columnLimit = Math.min(input.maxColumns, 200);
  const primaryKeys = schemaMapPrimaryKeyColumns(constraints);
  const uniqueKeys = uniqueKeyGroups(constraints);
  const timeFields = compactColumns.filter((column) => column.roles.includes("time")).map((column) => column.name);
  const statusFields = compactColumns.filter((column) => column.roles.includes("status")).map((column) => column.name);
  const keyFields = importantSchemaMapFields(compactColumns, primaryKeys, timeFields, statusFields);
  const tableInfo = await findSchemaMapTableInfo(selected, metadata.schema, metadata.table);
  const statistics = await withQuerySlot(selected, () =>
    getTableStats(selected.pool, selected.config.compatibility, metadata.table, metadata.schema, selected.config.queryTimeoutMs)
  );
  const relationshipLimit = Math.min(input.relationshipLimit, 50);
  const relationships = input.includeRelationships
    ? await buildSchemaMapRelationshipSummary(selected, metadata.schema, metadata.table, relationshipLimit)
    : undefined;
  const queryExamples = input.includeQueryExamples
    ? buildTableDocumentQueryExamples(
        selected,
        metadata.schema,
        metadata.table,
        columns,
        constraints,
        relationships?.relations ?? [],
        input.maxExamples
      )
    : undefined;
  const purpose = inferTablePurpose(metadata.table, tableInfo?.comment, compactColumns);
  const warnings = uniqueStrings([
    ...metadata.warnings,
    "Document content is based on metadata visible to the active MCP policy.",
    "No sample data values are included.",
    "Purpose and field roles are inferred from visible metadata; verify with domain knowledge before using them as business facts.",
    compactColumns.length > columnLimit ? `Only the first ${columnLimit} visible columns are included.` : "",
    statistics.warnings.length > 0 ? statistics.warnings.join(" ") : "",
    relationships?.truncated ? "Relationship output was truncated by relationshipLimit." : ""
  ]);

  return {
    generatedAt: new Date().toISOString(),
    mode: selected.config.compatibility,
    schema: metadata.schema,
    table: metadata.table,
    comment: tableInfo?.comment,
    tableType: tableInfo?.tableType,
    engine: tableInfo?.engine,
    purpose,
    rowEstimate: tableInfo?.rowEstimate ?? statistics.rowEstimate,
    statistics,
    primaryKeys,
    uniqueKeys,
    keyFields,
    timeFields,
    statusFields,
    columns: compactColumns.slice(0, columnLimit),
    visibleColumnCount: compactColumns.length,
    columnsTruncated: compactColumns.length > columnLimit,
    indexes: mapperIndexSummary(indexes),
    constraints: mapperConstraintSummary(constraints),
    partitions: tableDocumentPartitionSummary(partitions),
    relationships,
    queryExamples,
    structuredDdl: metadata.structuredDdl,
    warnings
  };
}

function buildTableDocumentQueryExamples(
  selected: ReturnType<typeof selectRuntimeProfile>,
  schema: string | undefined,
  table: string,
  columns: unknown[],
  constraints: unknown[],
  relationships: Array<{
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
    evidence: TableRelationship["evidence"];
  }>,
  maxExamples: number
) {
  const generated = generateQueryTemplates({
    mode: selected.config.compatibility,
    schema,
    table,
    columns,
    constraints,
    relationships: relationships as TableRelationship[],
    maxColumns: 12,
    rowLimit: effectiveRowLimit(undefined, selected.config)
  });
  return {
    examples: generated.templates
      .slice(0, Math.min(maxExamples, 10))
      .map((template) => queryExampleFromTemplate(template, selected.config)),
    warnings: generated.warnings,
    executed: false
  };
}

function tableDocumentPartitionSummary(rows: unknown[]): Array<Record<string, unknown>> {
  return rows.slice(0, 50).map((row) => {
    const record = row as Record<string, unknown>;
    return {
      name: stringRecordValue(record, "partition_name", "PARTITION_NAME"),
      subpartition: stringRecordValue(record, "subpartition_name", "SUBPARTITION_NAME"),
      method: stringRecordValue(record, "partition_method", "PARTITION_METHOD"),
      expression: stringRecordValue(record, "partition_expression", "PARTITION_EXPRESSION"),
      description: stringRecordValue(record, "partition_description", "HIGH_VALUE"),
      rowEstimate: numberRecordValue(record, "table_rows", "NUM_ROWS")
    };
  });
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
