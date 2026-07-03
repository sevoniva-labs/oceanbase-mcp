import { z } from "zod";

import type { ObConfig } from "../../config.js";
import {
  describeTable,
  listSchemas,
  listTables
} from "../../db.js";
import { jsonByteLength } from "../../format.js";
import {
  assertTableAccess,
  filterColumnMetadata,
  filterSchemas,
  filterTables
} from "../../policy.js";
import { effectiveRowLimit } from "../../query/output.js";
import { withQuerySlot, type GatewayRuntime } from "../../runtime.js";
import { selectAuthorizedProfile as selectProfileForMcp } from "../access.js";
import type { McpRequestContext } from "../context.js";
import { metadataSchema } from "../metadata-scope.js";
import { policyContext } from "../policy-context.js";
import { profileInput } from "../schemas.js";
import { toLimitedResult } from "../tool-runtime.js";
import type { ToolRegistrar } from "../tool-registry.js";

export const DESCRIBE_TABLE_DEFAULT_COLUMN_LIMIT = 1_000;

export function registerCatalogTools(
  registerTool: ToolRegistrar,
  runtime: GatewayRuntime,
  context: McpRequestContext
): void {
  registerTool(
    "ob_list_schemas",
    {
      title: "List Schemas",
      description: "List schemas/databases visible to the current OceanBase user, filtered by access policy.",
      inputSchema: profileInput
    },
    async ({ profile }) => {
      const selected = selectProfileForMcp(runtime, profile, context);
      const rows = await withQuerySlot(selected, () =>
        listSchemas(selected.pool, selected.config.compatibility, selected.config.queryTimeoutMs)
      );
      return toLimitedResult(filterSchemas(rows, selected.config.policy), selected.config);
    }
  );

  registerTool(
    "ob_list_tables",
    {
      title: "List Tables",
      description: "List tables visible to the current OceanBase user, filtered by access policy.",
      inputSchema: {
        ...profileInput,
        schema: z.string().optional(),
        limit: z.number().int().positive().max(10_000).optional()
      }
    },
    async ({ profile, schema, limit }) => {
      const selected = selectProfileForMcp(runtime, profile, context);
      if (schema) {
        assertTableAccess(schema, "*", policyContext(selected.config));
      }
      const rows = await withQuerySlot(selected, () =>
        listTables(
          selected.pool,
          selected.config.compatibility,
          schema,
          effectiveRowLimit(limit, selected.config),
          selected.config.queryTimeoutMs
        )
      );
      return toLimitedResult(filterTables(rows, selected.config.policy), selected.config);
    }
  );

  registerTool(
    "ob_describe_table",
    {
      title: "Describe Table",
      description: "Return column metadata for an allowed OceanBase table.",
      inputSchema: {
        ...profileInput,
        table: z.string().min(1),
        schema: z.string().optional(),
        maxColumns: z.number().int().positive().max(10_000).optional()
      }
    },
    async ({ profile, table, schema, maxColumns }) => {
      const selected = selectProfileForMcp(runtime, profile, context);
      const effectiveSchema = metadataSchema(selected.config, schema);
      assertTableAccess(effectiveSchema, table, policyContext(selected.config));
      const columnLimit = Math.min(maxColumns ?? DESCRIBE_TABLE_DEFAULT_COLUMN_LIMIT, 10_000);
      const rows = await withQuerySlot(selected, () =>
        describeTable(selected.pool, selected.config.compatibility, table, effectiveSchema, selected.config.queryTimeoutMs, columnLimit + 1)
      );
      const visibleRows = filterColumnMetadata(rows, selected.config.policy);
      const limitReached = visibleRows.length > columnLimit;
      return toLimitedResult(
        describeTablePayload(visibleRows, selected.config, maxColumns, {
          columnLimit,
          columnCountLowerBound: limitReached
        }),
        selected.config
      );
    }
  );
}

export function describeTablePayload(
  rows: unknown[],
  config: ObConfig,
  maxColumns: number | undefined,
  options: { columnLimit?: number; columnCountLowerBound?: boolean } = {}
): unknown {
  const columnLimit = Math.min(maxColumns ?? options.columnLimit ?? rows.length, 10_000);
  const limitedRows = rows.slice(0, columnLimit);
  const lowerBoundCount = options.columnCountLowerBound === true;
  const explicitlyTruncated = limitedRows.length < rows.length || lowerBoundCount;
  if (!maxColumns && !lowerBoundCount && !explicitlyTruncated && jsonByteLength(limitedRows) <= config.maxResultBytes) {
    return limitedRows;
  }

  const baseWarnings = lowerBoundCount
    ? [`At least ${rows.length} visible columns match; only ${limitedRows.length} are returned. Pass maxColumns to adjust the scope.`]
    : explicitlyTruncated
      ? [`Only ${limitedRows.length} of ${rows.length} visible columns are returned. Pass maxColumns to adjust the scope.`]
      : [];
  const buildPayload = (columns: unknown[], byteTruncated: boolean) => ({
    columns,
    columnCount: rows.length,
    columnCountLowerBound: lowerBoundCount || undefined,
    returnedColumns: columns.length,
    truncated: explicitlyTruncated || byteTruncated,
    warnings: byteTruncated
      ? [...baseWarnings, "Column metadata output was capped by OB_MAX_RESULT_BYTES."]
      : baseWarnings
  });

  if (jsonByteLength(buildPayload(limitedRows, false)) <= config.maxResultBytes) {
    return buildPayload(limitedRows, false);
  }

  let low = 0;
  let high = limitedRows.length;
  let best = 0;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    if (jsonByteLength(buildPayload(limitedRows.slice(0, mid), true)) <= config.maxResultBytes) {
      best = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return buildPayload(limitedRows.slice(0, best), true);
}
