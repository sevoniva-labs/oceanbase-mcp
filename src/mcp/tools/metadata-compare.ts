import { z } from "zod";

import type { ObConfig } from "../../config.js";
import {
  getTableDdlMetadata,
  listSchemaMapTables,
  type SchemaMapTable
} from "../../db.js";
import {
  assertTableAccess,
  filterColumnMetadata,
  filterTables,
  isSchemaAllowed
} from "../../policy.js";
import { selectRuntimeProfile, withQuerySlot, type GatewayRuntime } from "../../runtime.js";
import { selectAuthorizedProfile } from "../access.js";
import type { McpRequestContext } from "../context.js";
import { metadataTableRef } from "../metadata-scope.js";
import { policyContext } from "../policy-context.js";
import { profileInput } from "../schemas.js";
import { toLimitedResult } from "../tool-runtime.js";
import type { ToolRegistrar } from "../tool-registry.js";
import { filterSchemaMapTables } from "./schema-map.js";

export function registerMetadataCompareTools(
  registerTool: ToolRegistrar,
  runtime: GatewayRuntime,
  context: McpRequestContext
): void {
  registerTool(
    "ob_compare_tables",
    {
      title: "Compare Tables",
      description: "Compare two visible tables by columns, indexes, constraints, and partitions.",
      inputSchema: {
        ...profileInput,
        leftTable: z.string().min(1),
        leftSchema: z.string().optional(),
        rightTable: z.string().min(1),
        rightSchema: z.string().optional()
      }
    },
    async ({ profile, leftTable, leftSchema, rightTable, rightSchema }) => {
      const selected = selectAuthorizedProfile(runtime, profile, context);
      const left = metadataTableRef(selected.config, leftSchema, leftTable);
      const right = metadataTableRef(selected.config, rightSchema, rightTable);
      assertTableAccess(left.schema, left.table, policyContext(selected.config));
      assertTableAccess(right.schema, right.table, policyContext(selected.config));
      const leftMetadata = await withQuerySlot(selected, () =>
        getTableDdlMetadata(selected.pool, selected.config.compatibility, left.table, left.schema, selected.config.queryTimeoutMs)
      );
      const rightMetadata = await withQuerySlot(selected, () =>
        getTableDdlMetadata(selected.pool, selected.config.compatibility, right.table, right.schema, selected.config.queryTimeoutMs)
      );

      return toLimitedResult(
        compareTableMetadata(selected.config, leftMetadata, rightMetadata),
        selected.config
      );
    }
  );

  registerTool(
    "ob_compare_schemas",
    {
      title: "Compare Schemas",
      description: "Compare two visible schemas by table list and bounded per-table metadata differences.",
      inputSchema: {
        ...profileInput,
        leftSchema: z.string().min(1),
        rightSchema: z.string().min(1),
        tablePattern: z.string().optional(),
        maxTables: z.number().int().positive().max(500).optional(),
        compareCommonTables: z.number().int().positive().max(50).optional()
      }
    },
    async ({ profile, leftSchema, rightSchema, tablePattern, maxTables, compareCommonTables }) => {
      const selected = selectAuthorizedProfile(runtime, profile, context);
      if (!isSchemaAllowed(leftSchema, selected.config.policy)) {
        throw new Error(`Schema "${leftSchema}" is not allowed by the configured OceanBase MCP access policy.`);
      }
      if (!isSchemaAllowed(rightSchema, selected.config.policy)) {
        throw new Error(`Schema "${rightSchema}" is not allowed by the configured OceanBase MCP access policy.`);
      }
      const tableLimit = Math.min(maxTables ?? 100, 200);
      const leftVisibleTables = filterSchemaMapTables(
        await withQuerySlot(selected, () =>
          listSchemaMapTables(selected.pool, selected.config.compatibility, leftSchema, tablePattern, tableLimit + 1, selected.config.queryTimeoutMs)
        ),
        selected.config
      );
      const rightVisibleTables = filterSchemaMapTables(
        await withQuerySlot(selected, () =>
          listSchemaMapTables(selected.pool, selected.config.compatibility, rightSchema, tablePattern, tableLimit + 1, selected.config.queryTimeoutMs)
        ),
        selected.config
      );
      const leftTables = leftVisibleTables.slice(0, tableLimit);
      const rightTables = rightVisibleTables.slice(0, tableLimit);
      const comparison = await compareSchemaMetadata(
        selected,
        leftSchema,
        rightSchema,
        leftTables,
        rightTables,
        Math.min(compareCommonTables ?? 20, 50)
      );
      const warnings = [...comparison.warnings];
      const leftTableListTruncated = leftVisibleTables.length > tableLimit;
      const rightTableListTruncated = rightVisibleTables.length > tableLimit;
      if (leftTableListTruncated || rightTableListTruncated) {
        warnings.push("At least one schema has more visible tables than maxTables; narrow tablePattern or raise maxTables within the configured limit.");
      }

      return toLimitedResult(
        {
          mode: selected.config.compatibility,
          leftSchema,
          rightSchema,
          tablePattern: tablePattern ?? null,
          maxTables: tableLimit,
          ...comparison,
          leftTableListTruncated,
          rightTableListTruncated,
          warnings
        },
        selected.config
      );
    }
  );
}

function compareTableMetadata(
  config: ObConfig,
  left: Awaited<ReturnType<typeof getTableDdlMetadata>>,
  right: Awaited<ReturnType<typeof getTableDdlMetadata>>
) {
  const leftColumns = filterColumnMetadata(left.columns, config.policy);
  const rightColumns = filterColumnMetadata(right.columns, config.policy);
  const leftIndexes = filterColumnMetadata(left.indexes, config.policy);
  const rightIndexes = filterColumnMetadata(right.indexes, config.policy);
  const leftConstraints = filterColumnMetadata(left.constraints, config.policy);
  const rightConstraints = filterColumnMetadata(right.constraints, config.policy);
  const leftPartitions = filterTables(left.partitions, config.policy);
  const rightPartitions = filterTables(right.partitions, config.policy);

  return {
    mode: config.compatibility,
    left: { schema: left.schema, table: left.table },
    right: { schema: right.schema, table: right.table },
    columns: compareColumnMetadata(config.compatibility, leftColumns, rightColumns),
    indexes: compareMetadataRows(config.compatibility, leftIndexes, rightIndexes, ["index_name", "INDEX_NAME", "column_name", "COLUMN_NAME"]),
    constraints: compareMetadataRows(config.compatibility, leftConstraints, rightConstraints, ["constraint_name", "CONSTRAINT_NAME", "column_name", "COLUMN_NAME"]),
    partitions: compareMetadataRows(config.compatibility, leftPartitions, rightPartitions, ["partition_name", "PARTITION_NAME", "subpartition_name", "SUBPARTITION_NAME"]),
    warnings: [
      "Comparison uses metadata visible to the active MCP policy; hidden columns or objects are not included."
    ]
  };
}

async function compareSchemaMetadata(
  selected: ReturnType<typeof selectRuntimeProfile>,
  leftSchema: string,
  rightSchema: string,
  leftTables: SchemaMapTable[],
  rightTables: SchemaMapTable[],
  commonCompareLimit: number
) {
  const leftByName = new Map(leftTables.map((table) => [normalizeTableName(selected.config.compatibility, table.table), table]));
  const rightByName = new Map(rightTables.map((table) => [normalizeTableName(selected.config.compatibility, table.table), table]));
  const leftOnlyTables = [...leftByName.entries()]
    .filter(([key]) => !rightByName.has(key))
    .map(([, table]) => table);
  const rightOnlyTables = [...rightByName.entries()]
    .filter(([key]) => !leftByName.has(key))
    .map(([, table]) => table);
  const commonNames = [...leftByName.keys()].filter((key) => rightByName.has(key)).sort();
  const comparedTables = [];
  for (const key of commonNames.slice(0, commonCompareLimit)) {
    const leftTable = leftByName.get(key)!;
    const rightTable = rightByName.get(key)!;
    const leftMetadata = await withQuerySlot(selected, () =>
      getTableDdlMetadata(selected.pool, selected.config.compatibility, leftTable.table, leftSchema, selected.config.queryTimeoutMs)
    );
    const rightMetadata = await withQuerySlot(selected, () =>
      getTableDdlMetadata(selected.pool, selected.config.compatibility, rightTable.table, rightSchema, selected.config.queryTimeoutMs)
    );
    const diff = compareTableMetadata(selected.config, leftMetadata, rightMetadata);
    if (hasTableMetadataDiff(diff)) {
      comparedTables.push(diff);
    }
  }
  return {
    leftTableCount: leftTables.length,
    rightTableCount: rightTables.length,
    commonTableCount: commonNames.length,
    comparedCommonTables: Math.min(commonNames.length, commonCompareLimit),
    comparisonTruncated: commonNames.length > commonCompareLimit,
    leftOnlyTables,
    rightOnlyTables,
    changedTables: comparedTables,
    warnings: [
      "Schema comparison is bounded by maxTables and compareCommonTables.",
      "Only metadata visible to the active MCP policy is included."
    ]
  };
}

function hasTableMetadataDiff(diff: ReturnType<typeof compareTableMetadata>): boolean {
  return (
    diff.columns.leftOnly.length > 0 ||
    diff.columns.rightOnly.length > 0 ||
    diff.columns.changed.length > 0 ||
    diff.indexes.leftOnly.length > 0 ||
    diff.indexes.rightOnly.length > 0 ||
    diff.constraints.leftOnly.length > 0 ||
    diff.constraints.rightOnly.length > 0 ||
    diff.partitions.leftOnly.length > 0 ||
    diff.partitions.rightOnly.length > 0
  );
}

function compareColumnMetadata(
  mode: ObConfig["compatibility"],
  leftRows: unknown[],
  rightRows: unknown[]
) {
  const left = columnCompareMap(mode, leftRows);
  const right = columnCompareMap(mode, rightRows);
  const leftOnly = [];
  const rightOnly = [];
  const changed = [];
  for (const [key, leftColumn] of left) {
    const rightColumn = right.get(key);
    if (!rightColumn) {
      leftOnly.push(leftColumn);
      continue;
    }
    const changes = [];
    for (const field of ["type", "nullable", "comment"] as const) {
      if (leftColumn[field] !== rightColumn[field]) {
        changes.push({ field, left: leftColumn[field], right: rightColumn[field] });
      }
    }
    if (changes.length > 0) {
      changed.push({ column: leftColumn.name, left: leftColumn, right: rightColumn, changes });
    }
  }
  for (const [key, rightColumn] of right) {
    if (!left.has(key)) {
      rightOnly.push(rightColumn);
    }
  }
  return {
    leftOnly,
    rightOnly,
    changed,
    commonCount: [...left.keys()].filter((key) => right.has(key)).length
  };
}

function columnCompareMap(mode: ObConfig["compatibility"], rows: unknown[]) {
  const output = new Map<string, { name: string; type?: string; nullable?: boolean; comment?: string }>();
  for (const row of rows) {
    const column = profileColumnMetadata(row, mode);
    if (!column) {
      continue;
    }
    output.set(normalizeTableName(mode, column.name), {
      name: column.name,
      type: column.dataType,
      nullable: column.nullable,
      comment: column.comment
    });
  }
  return output;
}

function compareMetadataRows(
  mode: ObConfig["compatibility"],
  leftRows: unknown[],
  rightRows: unknown[],
  preferredKeys: string[]
) {
  const left = metadataSignatureMap(mode, leftRows, preferredKeys);
  const right = metadataSignatureMap(mode, rightRows, preferredKeys);
  return {
    leftOnly: [...left.entries()].filter(([key]) => !right.has(key)).map(([, row]) => row),
    rightOnly: [...right.entries()].filter(([key]) => !left.has(key)).map(([, row]) => row),
    commonCount: [...left.keys()].filter((key) => right.has(key)).length
  };
}

function metadataSignatureMap(
  mode: ObConfig["compatibility"],
  rows: unknown[],
  preferredKeys: string[]
) {
  const output = new Map<string, Record<string, unknown>>();
  for (const row of rows) {
    if (!row || typeof row !== "object" || Array.isArray(row)) {
      continue;
    }
    const record = row as Record<string, unknown>;
    const parts = preferredKeys
      .map((key) => record[key])
      .filter((value) => value != null)
      .map((value) => normalizeTableName(mode, String(value)));
    const signature = parts.length > 0
      ? parts.join(":")
      : JSON.stringify(record, Object.keys(record).sort());
    output.set(signature, record);
  }
  return output;
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

function normalizeTableName(mode: ObConfig["compatibility"], value: string): string {
  return mode === "oracle" ? value.trim().toUpperCase() : value.trim().toLowerCase();
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
