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
  snippetMetadataFindings,
  snippetMetadataRecommendations,
  validateSnippetMetadata
} from "./sql-snippet-metadata.js";

export function registerSqlValidationTools(
  registerTool: ToolRegistrar,
  runtime: GatewayRuntime,
  context: McpRequestContext
): void {
  registerTool(
    "ob_validate_sql_snippet",
    {
      title: "Validate SQL Snippet",
      description: "Validate a pasted read-only SQL snippet for policy, dialect, pagination, plan risk, and visible table or column metadata.",
      inputSchema: {
        ...profileInput,
        sql: z.string().min(1),
        params: z.array(sqlParamSchema).optional().default([]),
        schema: z.string().optional(),
        maxRows: z.number().int().positive().max(10_000).optional(),
        runExplain: z.boolean().optional().default(false)
      }
    },
    async ({ profile, sql, params = [], schema, maxRows, runExplain = false }) => {
      const selected = selectAuthorizedProfile(runtime, profile, context);
      const sqlParams = params as SqlParam[];
      const lint = await lintReadOnlySql(selected, sql, sqlParams, effectiveRowLimit(maxRows, selected.config), runExplain);
      const policy = explainSqlPolicy(sql, policyContext(selected.config));
      const metadata = await validateSnippetMetadata(selected, sql, policy.tableRefs, metadataSchema(selected.config, schema));
      const metadataFindings = snippetMetadataFindings(metadata);
      const findings = [...lint.findings, ...metadataFindings];
      return toLimitedResult(
        {
          sql,
          paramCount: sqlParams.length,
          allowed: lint.allowed && metadataFindings.every((finding) => finding.severity !== "high"),
          severity: lintSeverity(findings),
          executed: false,
          explainRun: lint.explainRun,
          lint,
          metadata,
          findings,
          recommendations: uniqueStrings([
            ...lint.recommendations,
            ...snippetMetadataRecommendations(metadataFindings)
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
