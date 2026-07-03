import { z } from "zod";

import type { SqlParam } from "../../db.js";
import { explainSqlPolicy } from "../../policy.js";
import { effectiveRowLimit } from "../../query/output.js";
import type { GatewayRuntime } from "../../runtime.js";
import { selectAuthorizedProfile } from "../access.js";
import type { McpRequestContext } from "../context.js";
import { metadataSchema } from "../metadata-scope.js";
import { policyContext } from "../policy-context.js";
import {
  profileInput,
  sqlParamSchema,
  tableDocumentFormatSchema
} from "../schemas.js";
import { toLimitedResult } from "../tool-runtime.js";
import type { ToolRegistrar } from "../tool-registry.js";
import {
  lintReadOnlySql,
  lintSeverity
} from "./sql-lint.js";
import {
  projectQueryRecommendations,
  projectQueryStructure,
  renderQueryDocumentMarkdown,
  snippetMetadataFindings,
  snippetMetadataRecommendations,
  validateSnippetMetadata
} from "./sql-snippet-metadata.js";
import { resolveProjectQuerySource } from "./sql-snippet-source.js";

export function registerSqlQueryDocTools(
  registerTool: ToolRegistrar,
  runtime: GatewayRuntime,
  context: McpRequestContext
): void {
  registerTool(
    "ob_generate_query_doc",
    {
      title: "Generate Query Documentation",
      description: "Generate bounded JSON or Markdown documentation for a SQL snippet without executing the target query.",
      inputSchema: {
        ...profileInput,
        sql: z.string().min(1).optional(),
        filePath: z.string().min(1).optional(),
        line: z.number().int().positive().optional(),
        params: z.array(sqlParamSchema).optional().default([]),
        schema: z.string().optional(),
        format: tableDocumentFormatSchema.optional().default("markdown"),
        maxRows: z.number().int().positive().max(10_000).optional(),
        runExplain: z.boolean().optional().default(false),
        title: z.string().min(1).max(120).optional()
      }
    },
    async ({ profile, sql, filePath, line, params = [], schema, format = "markdown", maxRows, runExplain = false, title }) => {
      const selected = selectAuthorizedProfile(runtime, profile, context);
      const source = resolveProjectQuerySource(sql, filePath, line);
      const sqlParams = params as SqlParam[];
      const lint = await lintReadOnlySql(selected, source.sql, sqlParams, effectiveRowLimit(maxRows, selected.config), runExplain);
      const policy = explainSqlPolicy(source.sql, policyContext(selected.config));
      const metadata = await validateSnippetMetadata(selected, source.sql, policy.tableRefs, metadataSchema(selected.config, schema));
      const metadataFindings = snippetMetadataFindings(metadata);
      const findings = [...lint.findings, ...metadataFindings];
      const document = {
        generatedAt: new Date().toISOString(),
        mode: selected.config.compatibility,
        source: source.source,
        sql: source.sql,
        paramCount: sqlParams.length,
        executed: false,
        explainRun: lint.explainRun,
        allowed: lint.allowed && metadataFindings.every((finding) => finding.severity !== "high"),
        severity: lintSeverity(findings),
        structure: projectQueryStructure(source.sql, selected.config.compatibility, policy.tableRefs),
        metadata,
        findings,
        recommendations: uniqueStrings([
          ...lint.recommendations,
          ...snippetMetadataRecommendations(metadataFindings),
          ...projectQueryRecommendations(source.source)
        ]),
        warnings: uniqueStrings([
          ...metadata.warnings,
          "Query documentation is based on parsed SQL and visible metadata; dynamic SQL may need review after rendering."
        ])
      };
      return toLimitedResult(
        {
          format,
          mode: selected.config.compatibility,
          generatedAt: document.generatedAt,
          executed: false,
          document,
          markdown: format === "markdown" ? renderQueryDocumentMarkdown(document, title) : undefined,
          warnings: document.warnings
        },
        selected.config
      );
    }
  );
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}
