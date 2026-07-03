import { z } from "zod";

import {
  describeTable,
  getTableDdlMetadata,
  getTableStats,
  listConstraints,
  listIndexes,
  listPartitions,
  renderStructuredTableDdl,
  sampleRows
} from "../../db.js";
import {
  assertOutputAllowed,
  assertTableAccess,
  filterColumnMetadata,
  filterTables
} from "../../policy.js";
import { maskOutput } from "../../query/output.js";
import { withQuerySlot, type GatewayRuntime } from "../../runtime.js";
import { selectAuthorizedProfile } from "../access.js";
import type { McpRequestContext } from "../context.js";
import {
  inferTablePurpose,
  tableSummaryQueryEntryPoints
} from "../metadata-summary.js";
import { metadataSchema } from "../metadata-scope.js";
import { policyContext } from "../policy-context.js";
import { profileInput } from "../schemas.js";
import { toLimitedResult } from "../tool-runtime.js";
import type { ToolRegistrar } from "../tool-registry.js";
import {
  DESCRIBE_TABLE_DEFAULT_COLUMN_LIMIT,
  describeTablePayload
} from "./catalog.js";
import {
  buildSchemaMapRelationshipSummary,
  compactSchemaColumns,
  findSchemaMapTableInfo,
  importantSchemaMapFields,
  schemaMapPrimaryKeyColumns,
  uniqueKeyGroups
} from "./schema-map.js";

export function registerTableMetadataTools(
  registerTool: ToolRegistrar,
  runtime: GatewayRuntime,
  context: McpRequestContext
): void {
  registerTool(
    "ob_get_table_schema",
    {
      title: "Get Table Schema",
      description: "Return policy-filtered table columns and types for one table.",
      inputSchema: {
        ...profileInput,
        table: z.string().min(1),
        schema: z.string().optional(),
        maxColumns: z.number().int().positive().max(10_000).optional()
      }
    },
    async ({ profile, table, schema, maxColumns }) => {
      const selected = selectAuthorizedProfile(runtime, profile, context);
      const effectiveSchema = metadataSchema(selected.config, schema);
      assertTableAccess(effectiveSchema, table, policyContext(selected.config));
      const columnLimit = Math.min(maxColumns ?? DESCRIBE_TABLE_DEFAULT_COLUMN_LIMIT, 10_000);
      const rows = await withQuerySlot(selected, () =>
        describeTable(selected.pool, selected.config.compatibility, table, effectiveSchema, selected.config.queryTimeoutMs, columnLimit + 1)
      );
      return toLimitedResult(
        describeTablePayload(filterColumnMetadata(rows, selected.config.policy), selected.config, maxColumns, {
          columnLimit,
          columnCountLowerBound: rows.length > columnLimit
        }),
        selected.config
      );
    }
  );

  registerTool(
    "ob_get_table_ddl",
    {
      title: "Get Table DDL",
      description: "Return native or structured DDL metadata for an allowed OceanBase table.",
      inputSchema: {
        ...profileInput,
        table: z.string().min(1),
        schema: z.string().optional(),
        maxColumns: z.number().int().positive().max(10_000).optional()
      }
    },
    async ({ profile, table, schema, maxColumns }) => {
      const selected = selectAuthorizedProfile(runtime, profile, context);
      const effectiveSchema = metadataSchema(selected.config, schema);
      assertTableAccess(effectiveSchema, table, policyContext(selected.config));
      const columnLimit = Math.min(maxColumns ?? DESCRIBE_TABLE_DEFAULT_COLUMN_LIMIT, 10_000);
      const metadata = await withQuerySlot(selected, () =>
        getTableDdlMetadata(selected.pool, selected.config.compatibility, table, effectiveSchema, selected.config.queryTimeoutMs, columnLimit)
      );
      const columns = filterColumnMetadata(metadata.columns, selected.config.policy);
      const indexes = filterColumnMetadata(metadata.indexes, selected.config.policy);
      const constraints = filterColumnMetadata(metadata.constraints, selected.config.policy);
      const partitions = filterTables(metadata.partitions, selected.config.policy);
      const policyFiltered =
        columns.length !== metadata.columns.length ||
        indexes.length !== metadata.indexes.length ||
        constraints.length !== metadata.constraints.length ||
        partitions.length !== metadata.partitions.length;
      const ddl =
        metadata.nativeDdl && !policyFiltered
          ? metadata.nativeDdl
          : renderStructuredTableDdl(selected.config.compatibility, metadata.schema, metadata.table, columns, indexes, constraints, partitions);

      return toLimitedResult(
        {
          mode: metadata.mode,
          schema: metadata.schema,
          table: metadata.table,
          source: metadata.nativeDdl && !policyFiltered ? "native" : "structured",
          policyFiltered,
          columnsTruncated: metadata.columnsTruncated,
          columnLimit,
          ddl,
          columns,
          indexes,
          constraints,
          partitions,
          warnings: policyFiltered
            ? [...metadata.warnings, "DDL was rendered from policy-filtered metadata because one or more metadata rows were hidden."]
            : metadata.warnings
        },
        selected.config
      );
    }
  );

  registerTool(
    "ob_get_table_stats",
    {
      title: "Get Table Statistics",
      description: "Return table-level optimizer statistics and metadata counts for an allowed OceanBase table.",
      inputSchema: {
        ...profileInput,
        table: z.string().min(1),
        schema: z.string().optional()
      }
    },
    async ({ profile, table, schema }) => {
      const selected = selectAuthorizedProfile(runtime, profile, context);
      const effectiveSchema = metadataSchema(selected.config, schema);
      assertTableAccess(effectiveSchema, table, policyContext(selected.config));
      const stats = await withQuerySlot(selected, () =>
        getTableStats(selected.pool, selected.config.compatibility, table, effectiveSchema, selected.config.queryTimeoutMs)
      );
      return toLimitedResult(stats, selected.config);
    }
  );

  registerTool(
    "ob_get_table_summary",
    {
      title: "Get Table Summary",
      description: "Return a compact table summary with inferred purpose, key fields, relationship hints, and query entry points.",
      inputSchema: {
        ...profileInput,
        table: z.string().min(1),
        schema: z.string().optional(),
        includeRelated: z.boolean().optional().default(true),
        relationshipLimit: z.number().int().positive().max(50).optional(),
        maxColumns: z.number().int().positive().max(100).optional()
      }
    },
    async ({ profile, table, schema, includeRelated = true, relationshipLimit, maxColumns }) => {
      const selected = selectAuthorizedProfile(runtime, profile, context);
      const effectiveSchema = metadataSchema(selected.config, schema);
      assertTableAccess(effectiveSchema, table, policyContext(selected.config));
      const metadata = await withQuerySlot(selected, () =>
        getTableDdlMetadata(selected.pool, selected.config.compatibility, table, effectiveSchema, selected.config.queryTimeoutMs)
      );
      const columns = filterColumnMetadata(metadata.columns, selected.config.policy);
      const constraints = filterColumnMetadata(metadata.constraints, selected.config.policy);
      const compactColumns = compactSchemaColumns(columns, constraints, selected.config, metadata.schema, metadata.table);
      const primaryKeys = schemaMapPrimaryKeyColumns(constraints);
      const uniqueKeys = uniqueKeyGroups(constraints);
      const timeFields = compactColumns.filter((column) => column.roles.includes("time")).map((column) => column.name);
      const statusFields = compactColumns.filter((column) => column.roles.includes("status")).map((column) => column.name);
      const keyFields = importantSchemaMapFields(compactColumns, primaryKeys, timeFields, statusFields);
      const tableInfo = await findSchemaMapTableInfo(selected, metadata.schema, metadata.table);
      const statistics = await withQuerySlot(selected, () =>
        getTableStats(selected.pool, selected.config.compatibility, metadata.table, metadata.schema, selected.config.queryTimeoutMs)
      );
      const relationSummary = includeRelated
        ? await buildSchemaMapRelationshipSummary(selected, metadata.schema, metadata.table, Math.min(relationshipLimit ?? 10, 50))
        : undefined;

      return toLimitedResult(
        {
          mode: selected.config.compatibility,
          schema: metadata.schema,
          table: metadata.table,
          purpose: inferTablePurpose(metadata.table, tableInfo?.comment, compactColumns),
          rowEstimate: tableInfo?.rowEstimate ?? statistics.rowEstimate,
          statistics,
          primaryKeys,
          uniqueKeys,
          keyFields,
          timeFields,
          statusFields,
          columns: compactColumns.slice(0, Math.min(maxColumns ?? 20, 100)),
          columnsTruncated: compactColumns.length > Math.min(maxColumns ?? 20, 100),
          relatedTables: relationSummary,
          queryEntryPoints: tableSummaryQueryEntryPoints(primaryKeys, timeFields, statusFields, relationSummary),
          warnings: [
            "Purpose and field roles are inferred from visible metadata; verify with domain knowledge before using them as business facts."
          ]
        },
        selected.config
      );
    }
  );

  registerTool(
    "ob_get_indexes",
    {
      title: "Get Table Indexes",
      description: "Return indexes for an allowed OceanBase table.",
      inputSchema: {
        ...profileInput,
        table: z.string().min(1),
        schema: z.string().optional()
      }
    },
    async ({ profile, table, schema }) => {
      const selected = selectAuthorizedProfile(runtime, profile, context);
      const effectiveSchema = metadataSchema(selected.config, schema);
      assertTableAccess(effectiveSchema, table, policyContext(selected.config));
      const rows = await withQuerySlot(selected, () =>
        listIndexes(selected.pool, selected.config.compatibility, table, effectiveSchema, selected.config.queryTimeoutMs)
      );
      return toLimitedResult(filterColumnMetadata(rows, selected.config.policy), selected.config);
    }
  );

  registerTool(
    "ob_get_constraints",
    {
      title: "Get Table Constraints",
      description: "Return constraints for an allowed OceanBase table.",
      inputSchema: {
        ...profileInput,
        table: z.string().min(1),
        schema: z.string().optional()
      }
    },
    async ({ profile, table, schema }) => {
      const selected = selectAuthorizedProfile(runtime, profile, context);
      const effectiveSchema = metadataSchema(selected.config, schema);
      assertTableAccess(effectiveSchema, table, policyContext(selected.config));
      const rows = await withQuerySlot(selected, () =>
        listConstraints(selected.pool, selected.config.compatibility, table, effectiveSchema, selected.config.queryTimeoutMs)
      );
      return toLimitedResult(filterColumnMetadata(rows, selected.config.policy), selected.config);
    }
  );

  registerTool(
    "ob_get_partitions",
    {
      title: "Get Table Partitions",
      description: "Return partition metadata for an allowed OceanBase table.",
      inputSchema: {
        ...profileInput,
        table: z.string().min(1),
        schema: z.string().optional()
      }
    },
    async ({ profile, table, schema }) => {
      const selected = selectAuthorizedProfile(runtime, profile, context);
      const effectiveSchema = metadataSchema(selected.config, schema);
      assertTableAccess(effectiveSchema, table, policyContext(selected.config));
      const rows = await withQuerySlot(selected, () =>
        listPartitions(selected.pool, selected.config.compatibility, table, effectiveSchema, selected.config.queryTimeoutMs)
      );
      return toLimitedResult(filterTables(rows, selected.config.policy), selected.config);
    }
  );

  registerTool(
    "ob_sample_rows",
    {
      title: "Sample Rows",
      description: "Return a small, policy-filtered sample from an allowed table. Sensitive-looking fields are always masked.",
      inputSchema: {
        ...profileInput,
        table: z.string().min(1),
        schema: z.string().optional(),
        limit: z.number().int().positive().max(100).optional()
      }
    },
    async ({ profile, table, schema, limit }) => {
      const selected = selectAuthorizedProfile(runtime, profile, context);
      const effectiveSchema = metadataSchema(selected.config, schema);
      assertTableAccess(effectiveSchema, table, policyContext(selected.config));
      const metadata = filterColumnMetadata(
        await withQuerySlot(selected, () =>
          describeTable(selected.pool, selected.config.compatibility, table, effectiveSchema, selected.config.queryTimeoutMs)
        ),
        selected.config.policy
      );
      const columns = safeSampleColumnNames(metadata).slice(0, 50);
      const sampleLimit = Math.min(limit ?? Math.min(selected.config.maxRows, 5), selected.config.maxRows, 100);
      const output = await withQuerySlot(selected, () =>
        sampleRows(
          selected.pool,
          selected.config.compatibility,
          effectiveSchema,
          table,
          columns,
          sampleLimit,
          selected.config.queryTimeoutMs,
          selected.config.maxResultBytes
        )
      );
      assertOutputAllowed(output, selected.config.policy);
      return toLimitedResult(maskOutput(output, selected.config, effectiveSchema, table), selected.config);
    }
  );
}

function safeSampleColumnNames(rows: unknown[]): string[] {
  const names: string[] = [];
  for (const row of rows) {
    if (!row || typeof row !== "object" || Array.isArray(row)) {
      continue;
    }
    const record = row as Record<string, unknown>;
    const name = stringRecordValue(record, "column_name", "COLUMN_NAME");
    if (!name) {
      continue;
    }
    const type = [
      stringRecordValue(record, "column_type", "COLUMN_TYPE"),
      stringRecordValue(record, "data_type", "DATA_TYPE")
    ].filter(Boolean).join(" ");
    if (isLargeSampleColumnType(type)) {
      continue;
    }
    names.push(name);
  }
  return [...new Set(names)];
}

function isLargeSampleColumnType(type: string): boolean {
  return /\b(blob|clob|json|xml|raw|long|binary|varbinary|geometry|geography|image|lob)\b|text\b/i.test(type);
}

function stringRecordValue(record: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}
