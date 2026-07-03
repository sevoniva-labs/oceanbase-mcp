import { z } from "zod";

import { buildResultPreview, compareQueryResultRows, summarizeQueryResultRows } from "../../query/result-tools.js";
import {
  cleanupQuerySessions,
  getQuerySessionForProfile,
  type QuerySessionState
} from "../../query/sessions.js";
import type { GatewayRuntime } from "../../runtime.js";
import { selectAuthorizedProfile } from "../access.js";
import type { McpRequestContext } from "../context.js";
import { profileInput, resultSummaryColumnSchema } from "../schemas.js";
import { toLimitedResult } from "../tool-runtime.js";
import type { ToolRegistrar } from "../tool-registry.js";

export function registerQueryResultTools(
  registerTool: ToolRegistrar,
  runtime: GatewayRuntime,
  context: McpRequestContext,
  querySessions: Map<string, QuerySessionState>
): void {
  registerTool(
    "ob_summarize_result",
    {
      title: "Summarize Query Result",
      description: "Summarize already returned query rows without reading the database.",
      inputSchema: {
        ...profileInput,
        sessionId: z.string().optional(),
        rows: z.array(z.record(z.string(), z.unknown())).max(1_000),
        columns: z.array(resultSummaryColumnSchema).max(200).optional(),
        maxTopValues: z.number().int().positive().max(50).optional()
      }
    },
    async ({ profile, sessionId, rows, columns, maxTopValues }) => {
      const selected = selectAuthorizedProfile(runtime, profile, context);
      cleanupQuerySessions(querySessions);
      const session = sessionId ? getQuerySessionForProfile(querySessions, sessionId, selected.profile) : undefined;
      const summary = summarizeQueryResultRows(
        rows as Array<Record<string, unknown>>,
        columns ?? [],
        selected.config,
        Math.min(maxTopValues ?? 10, 50)
      );
      return toLimitedResult(
        {
          sessionId: session?.id ?? null,
          mode: selected.config.compatibility,
          rowCount: rows.length,
          ...summary,
          executed: false
        },
        selected.config
      );
    }
  );

  registerTool(
    "ob_compare_query_results",
    {
      title: "Compare Query Results",
      description: "Compare two already returned query results without reading the database or storing row values.",
      inputSchema: {
        ...profileInput,
        leftName: z.string().optional(),
        rightName: z.string().optional(),
        leftRows: z.array(z.record(z.string(), z.unknown())).max(1_000),
        rightRows: z.array(z.record(z.string(), z.unknown())).max(1_000),
        columns: z.array(resultSummaryColumnSchema).max(200).optional(),
        keyColumns: z.array(z.string().min(1)).max(20).optional(),
        compareColumns: z.array(z.string().min(1)).max(100).optional(),
        maxDifferences: z.number().int().positive().max(100).optional()
      }
    },
    async ({ profile, leftName, rightName, leftRows, rightRows, columns, keyColumns, compareColumns, maxDifferences }) => {
      const selected = selectAuthorizedProfile(runtime, profile, context);
      const comparison = compareQueryResultRows(
        leftRows as Array<Record<string, unknown>>,
        rightRows as Array<Record<string, unknown>>,
        columns ?? [],
        keyColumns ?? [],
        compareColumns,
        selected.config,
        Math.min(maxDifferences ?? 20, 100)
      );
      return toLimitedResult(
        {
          mode: selected.config.compatibility,
          leftName: leftName ?? "left",
          rightName: rightName ?? "right",
          ...comparison,
          executed: false
        },
        selected.config
      );
    }
  );

  registerTool(
    "ob_export_result_preview",
    {
      title: "Export Result Preview",
      description: "Generate a bounded Markdown or CSV preview string from already returned rows without writing files.",
      inputSchema: {
        ...profileInput,
        rows: z.array(z.record(z.string(), z.unknown())).max(1_000),
        columns: z.array(resultSummaryColumnSchema).max(200).optional(),
        format: z.enum(["markdown", "csv"]).optional().default("markdown"),
        maxRows: z.number().int().positive().max(1_000).optional()
      }
    },
    async ({ profile, rows, columns, format = "markdown", maxRows }) => {
      const selected = selectAuthorizedProfile(runtime, profile, context);
      const preview = buildResultPreview(
        rows as Array<Record<string, unknown>>,
        columns ?? [],
        format,
        Math.min(maxRows ?? 50, 1_000),
        selected.config
      );
      return toLimitedResult(
        {
          format,
          ...preview,
          executed: false
        },
        selected.config
      );
    }
  );
}
