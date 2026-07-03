import { z } from "zod";

import type { GatewayRuntime } from "../../runtime.js";
import { selectAuthorizedProfile } from "../access.js";
import type { McpRequestContext } from "../context.js";
import {
  erExportStrategySchema,
  erHtmlFormatSchema,
  erRelationshipModeSchema,
  profileInput
} from "../schemas.js";
import { toLimitedResult } from "../tool-runtime.js";
import type { ToolRegistrar } from "../tool-registry.js";
import type { ErExportStrategy } from "./er-export-plan.js";

interface ErExportPlanBuildInput {
  schema?: string;
  table?: string;
  tables?: string[];
  businessTerm?: string;
  depth?: number;
  maxTables?: number;
  maxRelationships?: number;
  minConfidence?: number;
  relationshipMode?: "none" | "foreign_key" | "inferred";
  includeInferred: boolean;
  format: "html-static" | "html-interactive" | "html-compact" | "html-detailed";
  strategy?: ErExportStrategy;
  chunkSize?: number;
  maxColumnsPerTable?: number;
  outputDir?: string;
}

type ErExportPlanResultBuilder = (
  selected: ReturnType<typeof selectAuthorizedProfile>,
  input: ErExportPlanBuildInput
) => Promise<unknown>;

export function registerErExportPlanTools(
  registerTool: ToolRegistrar,
  runtime: GatewayRuntime,
  context: McpRequestContext,
  buildErExportPlanResult: ErExportPlanResultBuilder
): void {
  registerTool(
    "ob_plan_er_export",
    {
      title: "Plan ER Export",
      description: "Plan local ER HTML export commands for large OceanBase schemas without returning large inline HTML.",
      inputSchema: {
        ...profileInput,
        schema: z.string().optional(),
        table: z.string().optional(),
        tables: z.array(z.string().min(1)).max(50).optional(),
        businessTerm: z.string().min(1).optional(),
        depth: z.number().int().min(1).max(3).optional(),
        maxTables: z.number().int().positive().max(500).optional(),
        maxRelationships: z.number().int().positive().max(1000).optional(),
        minConfidence: z.number().min(0).max(1).optional(),
        relationshipMode: erRelationshipModeSchema.optional().default("foreign_key"),
        includeInferred: z.boolean().optional().default(false),
        format: erHtmlFormatSchema.optional().default("html-interactive"),
        strategy: erExportStrategySchema.optional(),
        chunkSize: z.number().int().positive().max(100).optional(),
        maxColumnsPerTable: z.number().int().positive().max(500).optional(),
        outputDir: z.string().min(1).max(240).optional()
      }
    },
    async ({ profile, schema, table, tables, businessTerm, depth, maxTables, maxRelationships, minConfidence, relationshipMode = "foreign_key", includeInferred = false, format = "html-interactive", strategy, chunkSize, maxColumnsPerTable, outputDir }) => {
      const selected = selectAuthorizedProfile(runtime, profile, context);
      const result = await buildErExportPlanResult(selected, {
        schema,
        table,
        tables,
        businessTerm,
        depth,
        maxTables,
        maxRelationships,
        minConfidence,
        relationshipMode,
        includeInferred,
        format,
        strategy,
        chunkSize,
        maxColumnsPerTable,
        outputDir
      });
      return toLimitedResult(result, selected.config);
    }
  );
}
