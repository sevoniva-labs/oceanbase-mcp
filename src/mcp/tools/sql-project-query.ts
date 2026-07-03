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
  sqlParamSchema
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
  snippetMetadataFindings,
  snippetMetadataRecommendations,
  validateSnippetMetadata
} from "./sql-snippet-metadata.js";
import { resolveProjectQuerySource } from "./sql-snippet-source.js";

export function registerSqlProjectQueryTools(
  registerTool: ToolRegistrar,
  runtime: GatewayRuntime,
  context: McpRequestContext
): void {
  registerTool(
    "ob_explain_project_query",
    {
      title: "Explain Project Query",
      description: "Explain a read-only SQL snippet from text or a local project file without executing it.",
      inputSchema: {
        ...profileInput,
        sql: z.string().min(1).optional(),
        filePath: z.string().min(1).optional(),
        line: z.number().int().positive().optional(),
        params: z.array(sqlParamSchema).optional().default([]),
        schema: z.string().optional(),
        maxRows: z.number().int().positive().max(10_000).optional(),
        runExplain: z.boolean().optional().default(false)
      }
    },
    async ({ profile, sql, filePath, line, params = [], schema, maxRows, runExplain = false }) => {
      const selected = selectAuthorizedProfile(runtime, profile, context);
      const source = resolveProjectQuerySource(sql, filePath, line);
      const sqlParams = params as SqlParam[];
      const lint = await lintReadOnlySql(selected, source.sql, sqlParams, effectiveRowLimit(maxRows, selected.config), runExplain);
      const policy = explainSqlPolicy(source.sql, policyContext(selected.config));
      const metadata = await validateSnippetMetadata(selected, source.sql, policy.tableRefs, metadataSchema(selected.config, schema));
      const metadataFindings = snippetMetadataFindings(metadata);
      const findings = [...lint.findings, ...metadataFindings];
      return toLimitedResult(
        {
          source: source.source,
          sql: source.sql,
          paramCount: sqlParams.length,
          executed: false,
          allowed: lint.allowed && metadataFindings.every((finding) => finding.severity !== "high"),
          severity: lintSeverity(findings),
          structure: projectQueryStructure(source.sql, selected.config.compatibility, policy.tableRefs),
          lint,
          metadata,
          findings,
          recommendations: uniqueStrings([
            ...lint.recommendations,
            ...snippetMetadataRecommendations(metadataFindings),
            ...projectQueryRecommendations(source.source)
          ])
        },
        selected.config
      );
    }
  );
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}
