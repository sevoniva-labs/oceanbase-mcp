import { z } from "zod";

import {
  renderErDot,
  renderErMarkdown,
  renderErPlantUml,
  type ErDiagram
} from "../../er.js";
import type { GatewayRuntime } from "../../runtime.js";
import { selectAuthorizedProfile } from "../access.js";
import type { McpRequestContext } from "../context.js";
import {
  erDocumentFormatSchema,
  erRelationshipModeSchema,
  profileInput
} from "../schemas.js";
import { toLimitedResult } from "../tool-runtime.js";
import type { ToolRegistrar } from "../tool-registry.js";
import { defaultErHtmlTitle } from "./er-response.js";
import { entityRelationshipEvidence } from "./er-relationships.js";

interface ErDocumentBuildInput {
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
  input: ErDocumentBuildInput
) => Promise<{
  diagram: ErDiagram;
  response: {
    mode: string;
    schema?: string;
    rootTable: string | null;
    businessTerm: string | null;
    tableCount: number;
    relationshipCount: number;
    warnings: string[];
  };
}>;

export function registerErDocumentTools(
  registerTool: ToolRegistrar,
  runtime: GatewayRuntime,
  context: McpRequestContext,
  buildErDiagramResult: ErDiagramResultBuilder
): void {
  registerTool(
    "ob_generate_er_document",
    {
      title: "Generate ER Documentation",
      description: "Generate Markdown, PlantUML, and DOT documentation from allowed ER metadata and relationship evidence.",
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
        formats: z.array(erDocumentFormatSchema).min(1).max(3).optional(),
        title: z.string().min(1).max(120).optional()
      }
    },
    async ({ profile, schema, table, tables, businessTerm, depth, maxTables, maxRelationships, minConfidence, relationshipMode = "foreign_key", includeInferred = false, formats, title }) => {
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
      const requestedFormats = uniqueStrings(formats ?? ["markdown"]) as Array<"markdown" | "plantuml" | "dot">;
      const documents: Record<string, string> = {};
      if (requestedFormats.includes("markdown")) {
        documents.markdown = renderErMarkdown(result.diagram, {
          title: title ?? defaultErHtmlTitle(result.response),
          warnings: result.response.warnings
        });
      }
      if (requestedFormats.includes("plantuml")) {
        documents.plantuml = renderErPlantUml(result.diagram);
      }
      if (requestedFormats.includes("dot")) {
        documents.dot = renderErDot(result.diagram);
      }
      return toLimitedResult(
        {
          mode: result.response.mode,
          schema: result.response.schema,
          rootTable: result.response.rootTable,
          businessTerm: result.response.businessTerm,
          formats: requestedFormats,
          tableCount: result.response.tableCount,
          relationshipCount: result.response.relationshipCount,
          relationshipEvidence: result.diagram.relationships.map(entityRelationshipEvidence),
          documents,
          warnings: result.response.warnings
        },
        selected.config
      );
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
