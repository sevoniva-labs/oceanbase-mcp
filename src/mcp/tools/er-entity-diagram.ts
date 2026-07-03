import { z } from "zod";

import { renderErHtml, type ErDiagram } from "../../er.js";
import type { GatewayRuntime } from "../../runtime.js";
import { selectAuthorizedProfile } from "../access.js";
import type { McpRequestContext } from "../context.js";
import {
  entityDiagramOutputFormatSchema,
  erHtmlFormatSchema,
  erRelationshipModeSchema,
  profileInput
} from "../schemas.js";
import { toLimitedResult } from "../tool-runtime.js";
import type { ToolRegistrar } from "../tool-registry.js";
import { defaultErHtmlTitle } from "./er-response.js";
import { entityRelationshipEvidence } from "./er-relationships.js";

interface EntityDiagramBuildInput {
  schema?: string;
  table?: string;
  businessTerm?: string;
  depth?: number;
  maxTables?: number;
  maxRelationships?: number;
  minConfidence?: number;
  relationshipMode?: "none" | "foreign_key" | "inferred";
  includeInferred: boolean;
}

type EntityDiagramResultBuilder = (
  selected: ReturnType<typeof selectAuthorizedProfile>,
  input: EntityDiagramBuildInput
) => Promise<{
  diagram: ErDiagram;
  response: {
    mode: string;
    schema?: string;
    rootTable: string | null;
    businessTerm: string | null;
    tableCount: number;
    relationshipCount: number;
    diagram: unknown;
    scope: unknown;
    mermaid: string;
    stats: unknown;
    warnings: string[];
  };
}>;

export function registerErEntityDiagramTools(
  registerTool: ToolRegistrar,
  runtime: GatewayRuntime,
  context: McpRequestContext,
  buildErDiagramResult: EntityDiagramResultBuilder
): void {
  registerTool(
    "ob_generate_entity_diagram",
    {
      title: "Generate Entity Diagram",
      description: "Generate a local entity-focused ER diagram from a business term or table, with Mermaid, JSON, and optional HTML.",
      inputSchema: {
        ...profileInput,
        schema: z.string().optional(),
        table: z.string().optional(),
        businessTerm: z.string().min(1).optional(),
        depth: z.number().int().min(1).max(3).optional(),
        maxTables: z.number().int().positive().max(500).optional(),
        maxRelationships: z.number().int().positive().max(1000).optional(),
        minConfidence: z.number().min(0).max(1).optional(),
        relationshipMode: erRelationshipModeSchema.optional().default("foreign_key"),
        includeInferred: z.boolean().optional().default(false),
        formats: z.array(entityDiagramOutputFormatSchema).min(1).max(3).optional(),
        htmlFormat: erHtmlFormatSchema.optional().default("html-compact"),
        title: z.string().min(1).max(120).optional()
      }
    },
    async ({ profile, schema, table, businessTerm, depth, maxTables, maxRelationships, minConfidence, relationshipMode = "foreign_key", includeInferred = false, formats, htmlFormat = "html-compact", title }) => {
      if (!table && !businessTerm) {
        throw new Error("Pass table or businessTerm when generating an entity diagram.");
      }
      const selected = selectAuthorizedProfile(runtime, profile, context);
      const outputFormats = uniqueStrings(formats ?? ["mermaid", "json", "html"]) as Array<"mermaid" | "json" | "html">;
      const result = await buildErDiagramResult(selected, {
        schema,
        table,
        businessTerm,
        depth: depth ?? 1,
        maxTables: maxTables ?? 12,
        maxRelationships,
        minConfidence,
        relationshipMode,
        includeInferred
      });
      const response: Record<string, unknown> = {
        mode: result.response.mode,
        schema: result.response.schema,
        table: table ?? null,
        businessTerm: businessTerm ?? null,
        formats: outputFormats,
        tableCount: result.response.tableCount,
        relationshipCount: result.response.relationshipCount,
        relationshipEvidence: result.diagram.relationships.map(entityRelationshipEvidence),
        stats: result.response.stats,
        warnings: result.response.warnings
      };
      if (outputFormats.includes("mermaid")) {
        response.mermaid = result.response.mermaid;
      }
      if (outputFormats.includes("json")) {
        response.diagram = result.response.diagram;
        response.scope = result.response.scope;
      }
      if (outputFormats.includes("html")) {
        response.html = renderErHtml(result.diagram, {
          title: title ?? defaultErHtmlTitle(result.response),
          warnings: result.response.warnings,
          format: htmlFormat
        });
        response.htmlFormat = htmlFormat;
        response.contentType = "text/html";
      }
      return toLimitedResult(response, selected.config);
    }
  );
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
