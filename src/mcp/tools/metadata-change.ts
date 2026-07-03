import { z } from "zod";

import { captureMetadataSnapshot } from "../../metadata-capture.js";
import { compareMetadataSnapshots } from "../../metadata-change.js";
import { analyzeChangeSqlImpact, analyzeMetadataImpact } from "../../metadata-impact.js";
import { generateMetadataChangeReport } from "../../metadata-report.js";
import type { GatewayRuntime } from "../../runtime.js";
import { selectAuthorizedProfile } from "../access.js";
import type { McpRequestContext } from "../context.js";
import {
  metadataChangeReportFormatSchema,
  metadataDiffInputSchema,
  metadataImpactInputSchema,
  metadataSnapshotInputSchema,
  oracleObjectTypeSchema,
  profileInput,
  sqlUsageIndexInputSchema
} from "../schemas.js";
import { toLimitedResult } from "../tool-runtime.js";
import type { ToolRegistrar } from "../tool-registry.js";

export function registerMetadataChangeTools(
  registerTool: ToolRegistrar,
  runtime: GatewayRuntime,
  context: McpRequestContext
): void {
  registerTool(
    "ob_capture_metadata_snapshot",
    {
      title: "Capture Metadata Snapshot",
      description: "Capture a bounded metadata-only OceanBase snapshot for later offline diff and impact analysis.",
      inputSchema: {
        ...profileInput,
        schema: z.string().optional(),
        tablePattern: z.string().optional(),
        objectTypes: z.array(oracleObjectTypeSchema).max(20).optional(),
        includeRelationships: z.boolean().optional().default(true),
        includeOracleObjects: z.boolean().optional().default(true),
        maxTables: z.number().int().positive().max(500).optional(),
        maxColumnsPerTable: z.number().int().positive().max(200).optional(),
        maxObjects: z.number().int().positive().max(500).optional(),
        maxRelationships: z.number().int().positive().max(1_000).optional()
      }
    },
    async ({
      profile,
      schema,
      tablePattern,
      objectTypes,
      includeRelationships = true,
      includeOracleObjects = true,
      maxTables,
      maxColumnsPerTable,
      maxObjects,
      maxRelationships
    }) => {
      const selected = selectAuthorizedProfile(runtime, profile, context);
      const snapshot = await captureMetadataSnapshot(selected, {
        schema,
        tablePattern,
        objectTypes,
        includeRelationships,
        includeOracleObjects,
        maxTables,
        maxColumnsPerTable,
        maxObjects,
        maxRelationships
      });
      return toLimitedResult(snapshot, selected.config);
    }
  );

  registerTool(
    "ob_compare_metadata_snapshots",
    {
      title: "Compare Metadata Snapshots",
      description: "Compare two metadata-only snapshots and return evidence-based structural changes.",
      inputSchema: {
        ...profileInput,
        beforeSnapshot: metadataSnapshotInputSchema,
        afterSnapshot: metadataSnapshotInputSchema,
        changedOnly: z.boolean().optional().default(true),
        riskOnly: z.boolean().optional().default(false),
        summaryOnly: z.boolean().optional().default(false)
      }
    },
    async ({ profile, beforeSnapshot, afterSnapshot, changedOnly = true, riskOnly = false, summaryOnly = false }) => {
      const selected = selectAuthorizedProfile(runtime, profile, context);
      const comparison = compareMetadataSnapshots(beforeSnapshot, afterSnapshot, {
        changedOnly,
        riskOnly,
        summaryOnly
      });
      return toLimitedResult(comparison, selected.config);
    }
  );

  registerTool(
    "ob_analyze_change_sql_impact",
    {
      title: "Analyze Change SQL Impact",
      description: "Analyze which indexed project SQL snippets are impacted by a metadata snapshot diff.",
      inputSchema: {
        ...profileInput,
        metadataDiff: metadataDiffInputSchema,
        sqlIndex: sqlUsageIndexInputSchema,
        maxResults: z.number().int().positive().max(1_000).optional()
      }
    },
    async ({ profile, metadataDiff, sqlIndex, maxResults }) => {
      const selected = selectAuthorizedProfile(runtime, profile, context);
      const result = analyzeChangeSqlImpact({ metadataDiff, sqlIndex, maxResults });
      return toLimitedResult(result, selected.config);
    }
  );

  registerTool(
    "ob_analyze_metadata_impact",
    {
      title: "Analyze Metadata Impact",
      description: "Summarize metadata diff impact using optional SQL usage index and business glossary evidence.",
      inputSchema: {
        ...profileInput,
        metadataDiff: metadataDiffInputSchema,
        sqlIndex: sqlUsageIndexInputSchema.optional(),
        businessGlossary: z.record(z.string(), z.unknown()).optional(),
        maxResults: z.number().int().positive().max(1_000).optional()
      }
    },
    async ({ profile, metadataDiff, sqlIndex, businessGlossary, maxResults }) => {
      const selected = selectAuthorizedProfile(runtime, profile, context);
      const result = analyzeMetadataImpact({ metadataDiff, sqlIndex, businessGlossary, maxResults });
      return toLimitedResult(result, selected.config);
    }
  );

  registerTool(
    "ob_generate_metadata_change_report",
    {
      title: "Generate Metadata Change Report",
      description: "Generate a Markdown or simple HTML metadata change report from diff and impact evidence.",
      inputSchema: {
        ...profileInput,
        metadataDiff: metadataDiffInputSchema,
        impact: metadataImpactInputSchema.optional(),
        title: z.string().min(1).max(160).optional(),
        format: metadataChangeReportFormatSchema.optional().default("markdown"),
        summaryOnly: z.boolean().optional().default(false)
      }
    },
    async ({ profile, metadataDiff, impact, title, format = "markdown", summaryOnly = false }) => {
      const selected = selectAuthorizedProfile(runtime, profile, context);
      const report = generateMetadataChangeReport({ metadataDiff, impact, title, format, summaryOnly });
      return toLimitedResult(report, selected.config);
    }
  );
}
