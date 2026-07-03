import { z } from "zod";

import {
  describeTable,
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
  enrichColumnProfile,
  maskColumnProfileResult,
  numberRecordValue,
  selectProfileColumns,
  stringRecordValue
} from "./profile-utils.js";

export function registerValueDistributionTools(
  registerTool: ToolRegistrar,
  runtime: GatewayRuntime,
  context: McpRequestContext
): void {
  registerTool(
    "ob_get_value_distribution",
    {
      title: "Get Value Distribution",
      description: "Return bounded top-value distribution for one allowed column, with masking and sample limits enforced.",
      inputSchema: {
        ...profileInput,
        table: z.string().min(1),
        column: z.string().min(1),
        schema: z.string().optional(),
        rowLimit: z.number().int().positive().max(10_000).optional(),
        topN: z.number().int().positive().max(100).optional()
      }
    },
    async ({ profile, table, column, schema, rowLimit, topN }) => {
      const selected = selectAuthorizedProfile(runtime, profile, context);
      const effectiveSchema = metadataSchema(selected.config, schema);
      assertTableAccess(effectiveSchema, table, policyContext(selected.config));
      const metadataRows = await withQuerySlot(selected, () =>
        describeTable(selected.pool, selected.config.compatibility, table, effectiveSchema, selected.config.queryTimeoutMs)
      );
      const visibleColumns = filterColumnMetadata(metadataRows, selected.config.policy);
      const selectedColumn = selectProfileColumns(visibleColumns, selected.config.compatibility, [column], 1)[0];
      const profileRowLimit = Math.min(effectiveRowLimit(rowLimit, selected.config), 10_000);
      const effectiveTopN = Math.min(topN ?? 10, 100);
      const stats = await withQuerySlot(selected, () =>
        getTableStats(selected.pool, selected.config.compatibility, table, effectiveSchema, selected.config.queryTimeoutMs)
      );
      const result = await withQuerySlot(selected, () =>
        profileColumns(
          selected.pool,
          selected.config.compatibility,
          effectiveSchema,
          table,
          [{ name: selectedColumn.name, dataType: selectedColumn.dataType }],
          profileRowLimit,
          effectiveTopN,
          1,
          selected.config.queryTimeoutMs
        )
      );
      const masked = maskColumnProfileResult(
        {
          ...result,
          columns: result.columns.map((profileResult) =>
            enrichColumnProfile(profileResult, selectedColumn, selected.config, result.schema, result.table)
          )
        },
        selected.config,
        result.schema,
        result.table
      );
      const profiledColumn = (masked.columns?.[0] ?? {}) as Record<string, unknown>;
      const distribution = Array.isArray(profiledColumn.topValues) ? profiledColumn.topValues : [];
      return toLimitedResult(
        {
          mode: selected.config.compatibility,
          schema: result.schema,
          table: result.table,
          column: stringRecordValue(profiledColumn, "column", "COLUMN") ?? selectedColumn.name,
          dataType: profiledColumn.dataType,
          typeCategory: profiledColumn.typeCategory,
          rowLimit: profileRowLimit,
          topN: effectiveTopN,
          sampledRows: numberRecordValue(profiledColumn, "sampledRows", "sampled_rows") ?? 0,
          nulls: profiledColumn.nulls,
          distinct: profiledColumn.distinct,
          distribution,
          enumCandidate: profiledColumn.enumCandidate,
          masked: Boolean(profiledColumn.masked),
          warnings: valueDistributionWarnings(
            result.warnings,
            stats.rowEstimate?.value,
            profileRowLimit,
            effectiveTopN,
            distribution.length,
            Boolean(profiledColumn.masked)
          )
        },
        selected.config
      );
    }
  );
}

function valueDistributionWarnings(
  baseWarnings: string[],
  rowEstimate: number | undefined,
  rowLimit: number,
  topN: number,
  returnedValues: number,
  masked: boolean
): string[] {
  const warnings = new Set<string>([
    ...baseWarnings,
    "Value distribution uses a bounded sample; counts and ratios are not full-table exact values."
  ]);
  if (rowEstimate != null && rowEstimate > rowLimit) {
    warnings.add(`Table row estimate is ${rowEstimate}; distribution was limited to ${rowLimit} rows.`);
  }
  if (returnedValues >= topN) {
    warnings.add(`Only the top ${topN} values are returned.`);
  }
  if (masked) {
    warnings.add("Distribution values are masked for this column.");
  }
  return [...warnings];
}
