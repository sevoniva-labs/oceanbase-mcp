import { z } from "zod";

import type { ErDiagram } from "../../er.js";
import type { GatewayRuntime } from "../../runtime.js";
import { selectAuthorizedProfile } from "../access.js";
import type { McpRequestContext } from "../context.js";
import {
  erRelationshipModeSchema,
  profileInput
} from "../schemas.js";
import { toLimitedResult } from "../tool-runtime.js";
import type { ToolRegistrar } from "../tool-registry.js";
import { fitErDiagramResponseForLimit, type ErResponsePayload } from "./er-response.js";

interface ErDiagramBuildInput {
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
}

type ErDiagramResultBuilder = (
  selected: ReturnType<typeof selectAuthorizedProfile>,
  input: ErDiagramBuildInput
) => Promise<{
  diagram: ErDiagram;
  response: ErResponsePayload;
}>;

export function registerErDiagramTools(
  registerTool: ToolRegistrar,
  runtime: GatewayRuntime,
  context: McpRequestContext,
  buildErDiagramResult: ErDiagramResultBuilder
): void {
  registerTool(
    "ob_generate_er_diagram",
    {
      title: "Generate ER Diagram",
      description: "Generate Mermaid and JSON ER metadata from allowed OceanBase table metadata and relationships.",
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
        includeInferred: z.boolean().optional().default(false)
      }
    },
    async ({ profile, schema, table, tables, businessTerm, depth, maxTables, maxRelationships, minConfidence, relationshipMode = "foreign_key", includeInferred = false }) => {
      const selected = selectAuthorizedProfile(runtime, profile, context);
      const result = await buildErDiagramResult(selected, {
        schema,
        table,
        tables,
        businessTerm,
        depth,
        maxTables,
        maxRelationships,
        minConfidence,
        relationshipMode,
        includeInferred
      });
      return toLimitedResult(fitErDiagramResponseForLimit(result.response, selected.config), selected.config);
    }
  );
}
