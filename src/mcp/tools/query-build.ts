import { z } from "zod";

import { describeTable } from "../../db.js";
import {
  assertTableAccess,
  filterColumnMetadata
} from "../../policy.js";
import { withQuerySlot, type GatewayRuntime } from "../../runtime.js";
import { selectAuthorizedProfile } from "../access.js";
import type { McpRequestContext } from "../context.js";
import { metadataSchema } from "../metadata-scope.js";
import { policyContext } from "../policy-context.js";
import { buildStructuredSelect } from "../query-builder.js";
import {
  buildSelectFilterSchema,
  buildSelectOrderBySchema,
  profileInput
} from "../schemas.js";
import { toLimitedResult } from "../tool-runtime.js";
import type { ToolRegistrar } from "../tool-registry.js";

export function registerQueryBuildTools(
  registerTool: ToolRegistrar,
  runtime: GatewayRuntime,
  context: McpRequestContext
): void {
  registerTool(
    "ob_build_select",
    {
      title: "Build SELECT",
      description: "Build a parameterized read-only SELECT from validated table, columns, filters, ordering, and pagination without executing it.",
      inputSchema: {
        ...profileInput,
        schema: z.string().optional(),
        table: z.string().min(1),
        columns: z.array(z.string().min(1)).min(1).max(100).optional(),
        filters: z.array(buildSelectFilterSchema).max(50).optional(),
        orderBy: z.array(buildSelectOrderBySchema).max(20).optional(),
        pageSize: z.number().int().positive().max(10_000).optional(),
        page: z.number().int().positive().max(100_000).optional()
      }
    },
    async ({ profile, schema, table, columns, filters, orderBy, pageSize, page }) => {
      const selected = selectAuthorizedProfile(runtime, profile, context);
      const effectiveSchema = metadataSchema(selected.config, schema);
      const normalizedTable = selected.config.compatibility === "oracle" ? table.trim().toUpperCase() : table.trim();
      assertTableAccess(effectiveSchema, normalizedTable, policyContext(selected.config));
      const rows = filterColumnMetadata(
        await withQuerySlot(selected, () =>
          describeTable(selected.pool, selected.config.compatibility, normalizedTable, effectiveSchema, selected.config.queryTimeoutMs)
        ),
        selected.config.policy
      );
      const built = buildStructuredSelect(
        selected.config,
        effectiveSchema,
        normalizedTable,
        rows,
        {
          columns,
          filters: filters ?? [],
          orderBy: orderBy ?? [],
          pageSize,
          page
        }
      );

      return toLimitedResult(
        {
          mode: selected.config.compatibility,
          schema: effectiveSchema ?? null,
          table: normalizedTable,
          ...built,
          executed: false
        },
        selected.config
      );
    }
  );
}
