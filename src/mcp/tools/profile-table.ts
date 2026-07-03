import { z } from "zod";

import {
  getTableDdlMetadata,
  getTableStats,
  profileColumns
} from "../../db.js";
import {
  assertTableAccess,
  filterColumnMetadata
} from "../../policy.js";
import { effectiveRowLimit } from "../../query/output.js";
import { withQuerySlot, type GatewayRuntime } from "../../runtime.js";
import { selectAuthorizedProfile } from "../access.js";
import type { McpRequestContext } from "../context.js";
import { metadataSchema } from "../metadata-scope.js";
import { policyContext } from "../policy-context.js";
import { profileInput } from "../schemas.js";
import { toLimitedResult } from "../tool-runtime.js";
import type { ToolRegistrar } from "../tool-registry.js";
import {
  importantSchemaMapFields,
  compactSchemaColumns,
  schemaMapPrimaryKeyColumns
} from "./schema-map.js";
import {
  selectTableProfileColumns,
  tableProfileIndexSummary,
  tableProfileMaskedColumns,
  tableProfileNullOverview,
  tableProfileStatusFields,
  tableProfileTimeFields,
  tableProfileWarnings
} from "./profile-utils.js";

export function registerProfileTableTools(
  registerTool: ToolRegistrar,
  runtime: GatewayRuntime,
  context: McpRequestContext
): void {
  registerTool(
    "ob_profile_table",
    {
      title: "Profile Table",
      description: "Return a bounded table-level profile with metadata counts, key fields, time/status fields, and sampled null overview.",
      inputSchema: {
        ...profileInput,
        table: z.string().min(1),
        schema: z.string().optional(),
        rowLimit: z.number().int().positive().max(10_000).optional(),
        maxProfileColumns: z.number().int().positive().max(50).optional(),
        topValues: z.number().int().positive().max(10).optional(),
        sampleValues: z.number().int().positive().max(10).optional(),
        includeColumnProfiles: z.boolean().optional().default(true)
      }
    },
    async ({ profile, table, schema, rowLimit, maxProfileColumns, topValues, sampleValues, includeColumnProfiles = true }) => {
      const selected = selectAuthorizedProfile(runtime, profile, context);
      const effectiveSchema = metadataSchema(selected.config, schema);
      assertTableAccess(effectiveSchema, table, policyContext(selected.config));
      const metadata = await withQuerySlot(selected, () =>
        getTableDdlMetadata(selected.pool, selected.config.compatibility, table, effectiveSchema, selected.config.queryTimeoutMs)
      );
      const stats = await withQuerySlot(selected, () =>
        getTableStats(selected.pool, selected.config.compatibility, metadata.table, metadata.schema, selected.config.queryTimeoutMs)
      );
      const visibleColumns = filterColumnMetadata(metadata.columns, selected.config.policy);
      const visibleIndexes = filterColumnMetadata(metadata.indexes, selected.config.policy);
      const visibleConstraints = filterColumnMetadata(metadata.constraints, selected.config.policy);
      const compactColumns = compactSchemaColumns(visibleColumns, visibleConstraints, selected.config, metadata.schema, metadata.table);
      const primaryKeys = schemaMapPrimaryKeyColumns(visibleConstraints);
      const timeFields = compactColumns.filter((column) => column.roles.includes("time")).map((column) => column.name);
      const statusFields = compactColumns.filter((column) => column.roles.includes("status")).map((column) => column.name);
      const profileRowLimit = Math.min(effectiveRowLimit(rowLimit, selected.config), 10_000);
      const effectiveTopLimit = Math.min(topValues ?? 5, 10);
      const effectiveSampleLimit = Math.min(sampleValues ?? 3, 10);
      const selectedProfileColumns = includeColumnProfiles
        ? selectTableProfileColumns(compactColumns, primaryKeys, maxProfileColumns ?? 12)
        : [];
      const rawColumnProfiles = selectedProfileColumns.length > 0
        ? await withQuerySlot(selected, () =>
            profileColumns(
              selected.pool,
              selected.config.compatibility,
              metadata.schema,
              metadata.table,
              selectedProfileColumns.map((column) => ({ name: column.name, dataType: column.type })),
              profileRowLimit,
              effectiveTopLimit,
              effectiveSampleLimit,
              selected.config.queryTimeoutMs
            )
          )
        : undefined;
      const columnProfiles = rawColumnProfiles
        ? tableProfileMaskedColumns(rawColumnProfiles, compactColumns, selected.config, metadata.schema, metadata.table)
        : [];
      const warnings = tableProfileWarnings(
        [...metadata.warnings, ...stats.warnings],
        rawColumnProfiles?.warnings ?? [],
        stats.rowEstimate?.value,
        profileRowLimit,
        compactColumns.length,
        selectedProfileColumns.length,
        includeColumnProfiles
      );

      return toLimitedResult(
        {
          mode: selected.config.compatibility,
          schema: metadata.schema,
          table: metadata.table,
          rowEstimate: stats.rowEstimate,
          objectCounts: {
            visibleColumns: compactColumns.length,
            visibleIndexes: visibleIndexes.length,
            visibleConstraints: visibleConstraints.length,
            partitions: metadata.partitions.length,
            catalog: stats.counts
          },
          storage: stats.storage,
          analyzedAt: stats.analyzedAt,
          primaryKeys,
          keyFields: importantSchemaMapFields(compactColumns, primaryKeys, timeFields, statusFields),
          timeFields: tableProfileTimeFields(timeFields, columnProfiles),
          statusFields: tableProfileStatusFields(statusFields, columnProfiles),
          nullableColumns: compactColumns.filter((column) => column.nullable).map((column) => column.name).slice(0, 50),
          nullOverview: tableProfileNullOverview(columnProfiles),
          indexSummary: tableProfileIndexSummary(visibleIndexes),
          profileScope: {
            enabled: includeColumnProfiles,
            rowLimit: profileRowLimit,
            topValues: effectiveTopLimit,
            sampleValues: effectiveSampleLimit,
            selectedColumns: selectedProfileColumns.map((column) => column.name),
            visibleColumnCount: compactColumns.length,
            selectedColumnCount: selectedProfileColumns.length
          },
          columnProfiles,
          warnings
        },
        selected.config
      );
    }
  );
}
