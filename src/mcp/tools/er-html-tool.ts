import { z } from "zod";

import { renderErHtml, type ErDiagram } from "../../er.js";
import type { GatewayRuntime } from "../../runtime.js";
import { selectAuthorizedProfile } from "../access.js";
import type { McpRequestContext } from "../context.js";
import {
  erHtmlFormatSchema,
  erRelationshipModeSchema,
  profileInput
} from "../schemas.js";
import { toLimitedResult } from "../tool-runtime.js";
import type { ToolRegistrar } from "../tool-registry.js";
import {
  buildErExportCommand,
  defaultErHtmlTitle,
  SCHEMA_INLINE_ER_TABLE_RENDER_LIMIT,
  shouldSkipSchemaInlineErHtmlRender
} from "./er-response.js";

type ErHtmlFormat = "html-static" | "html-interactive" | "html-compact" | "html-detailed";
type ErRelationshipMode = "none" | "foreign_key" | "inferred";

interface ErHtmlDiagramBuildInput {
  schema?: string;
  table?: string;
  tables?: string[];
  businessTerm?: string;
  depth?: number;
  maxTables?: number;
  maxRelationships?: number;
  minConfidence?: number;
  relationshipMode?: ErRelationshipMode;
  includeInferred: boolean;
}

interface ErHtmlExportPlanBuildInput extends ErHtmlDiagramBuildInput {
  format: ErHtmlFormat;
}

interface ErHtmlDiagramResponse {
  mode: string;
  schema?: string;
  rootTable: string | null;
  businessTerm: string | null;
  relationshipMode: ErRelationshipMode;
  maxTables: number;
  maxRelationships: number;
  tableCount: number;
  relationshipCount: number;
  mermaid: string;
  stats: unknown;
  warnings: string[];
}

interface ErHtmlExportPlanResponse {
  mode: string;
  schema?: string;
  rootTable: string | null;
  businessTerm: string | null;
  tableCount: number;
  relationshipCount: number;
  singleFileCommand: string;
  suggestedStrategy: string;
  chunkCount: number;
  recommendedNextTools: string[];
  stats: unknown;
  warnings: string[];
}

type ErHtmlDiagramResultBuilder = (
  selected: ReturnType<typeof selectAuthorizedProfile>,
  input: ErHtmlDiagramBuildInput
) => Promise<{
  diagram: ErDiagram;
  response: ErHtmlDiagramResponse;
}>;

type ErHtmlExportPlanResultBuilder = (
  selected: ReturnType<typeof selectAuthorizedProfile>,
  input: ErHtmlExportPlanBuildInput
) => Promise<ErHtmlExportPlanResponse>;

export function registerErHtmlTools(
  registerTool: ToolRegistrar,
  runtime: GatewayRuntime,
  context: McpRequestContext,
  buildErDiagramResult: ErHtmlDiagramResultBuilder,
  buildErExportPlanResult: ErHtmlExportPlanResultBuilder
): void {
  registerTool(
    "ob_generate_er_html",
    {
      title: "Generate ER HTML",
      description: "Generate a self-contained HTML ER diagram from allowed OceanBase metadata and relationship evidence.",
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
        format: erHtmlFormatSchema.optional().default("html-static"),
        title: z.string().min(1).max(120).optional()
      }
    },
    async ({ profile, schema, table, tables, businessTerm, depth, maxTables, maxRelationships, minConfidence, relationshipMode = "foreign_key", includeInferred = false, format = "html-static", title }) => {
      const selected = selectAuthorizedProfile(runtime, profile, context);
      const broadSchemaScope = !table && (!tables || tables.length === 0) && !businessTerm;
      const configuredMaxTables = Math.max(1, selected.config.erMaxTables);
      const requestedTableLimit = Math.min(maxTables ?? configuredMaxTables, configuredMaxTables, 500);
      if (broadSchemaScope && requestedTableLimit > SCHEMA_INLINE_ER_TABLE_RENDER_LIMIT) {
        const plan = await buildErExportPlanResult(selected, {
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
          format
        });
        if (plan.tableCount > SCHEMA_INLINE_ER_TABLE_RENDER_LIMIT) {
          return toLimitedResult(
            {
              mode: plan.mode,
              schema: plan.schema,
              rootTable: plan.rootTable,
              businessTerm: plan.businessTerm,
              tableCount: plan.tableCount,
              relationshipCount: plan.relationshipCount,
              contentType: "text/html",
              format,
              inline: false,
              htmlOmitted: true,
              renderSkipped: true,
              inlineLimitBytes: selected.config.erInlineHtmlMaxBytes,
              exportCommand: plan.singleFileCommand,
              suggestedStrategy: plan.suggestedStrategy,
              chunkCount: plan.chunkCount,
              recommendedNextTools: plan.recommendedNextTools,
              stats: plan.stats,
              warnings: uniqueStrings([
                ...plan.warnings,
                `Schema-level ER HTML rendering was skipped because tableCount=${plan.tableCount} exceeds ${SCHEMA_INLINE_ER_TABLE_RENDER_LIMIT}. Use ob_plan_er_export and CLI cluster export for large diagrams.`
              ])
            },
            selected.config
          );
        }
      }
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
      if (shouldSkipSchemaInlineErHtmlRender(result.response, { table, tables, businessTerm })) {
        return toLimitedResult(
          {
            mode: result.response.mode,
            schema: result.response.schema,
            rootTable: result.response.rootTable,
            businessTerm: result.response.businessTerm,
            tableCount: result.response.tableCount,
            relationshipCount: result.response.relationshipCount,
            contentType: "text/html",
            format,
            inline: false,
            htmlOmitted: true,
            renderSkipped: true,
            inlineLimitBytes: selected.config.erInlineHtmlMaxBytes,
            exportCommand: buildErExportCommand(result.response, format),
            stats: result.response.stats,
            warnings: uniqueStrings([
              ...result.response.warnings,
              `Schema-level ER HTML rendering was skipped because tableCount=${result.response.tableCount} exceeds ${SCHEMA_INLINE_ER_TABLE_RENDER_LIMIT}. Use ob_plan_er_export and CLI cluster export for large diagrams.`
            ])
          },
          selected.config
        );
      }
      const html = renderErHtml(result.diagram, {
        title: title ?? defaultErHtmlTitle(result.response),
        warnings: result.response.warnings,
        format,
        maxColumnsPerEntity: selected.config.erMaxColumnsPerTable
      });
      const htmlBytes = Buffer.byteLength(html, "utf8");
      if (htmlBytes > selected.config.erInlineHtmlMaxBytes) {
        return toLimitedResult(
          {
            mode: result.response.mode,
            schema: result.response.schema,
            rootTable: result.response.rootTable,
            businessTerm: result.response.businessTerm,
            tableCount: result.response.tableCount,
            relationshipCount: result.response.relationshipCount,
            contentType: "text/html",
            format,
            inline: false,
            htmlOmitted: true,
            htmlBytes,
            inlineLimitBytes: selected.config.erInlineHtmlMaxBytes,
            exportCommand: buildErExportCommand(result.response, format),
            stats: result.response.stats,
            warnings: uniqueStrings([
              ...result.response.warnings,
              `ER HTML is ${htmlBytes} bytes and exceeds OB_ER_INLINE_HTML_MAX_BYTES=${selected.config.erInlineHtmlMaxBytes}; use CLI export for the full artifact.`
            ])
          },
          selected.config
        );
      }
      return toLimitedResult(
        {
          mode: result.response.mode,
          schema: result.response.schema,
          rootTable: result.response.rootTable,
          businessTerm: result.response.businessTerm,
          tableCount: result.response.tableCount,
          relationshipCount: result.response.relationshipCount,
          contentType: "text/html",
          format,
          inline: true,
          html,
          mermaid: result.response.mermaid,
          stats: result.response.stats,
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
