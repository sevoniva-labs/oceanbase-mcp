import { z } from "zod";

import type { SqlParam } from "../../db.js";
import { runReadOnlyQuery } from "../../db.js";
import { logAudit } from "../../errors.js";
import { assertJsonByteLimit, type QueryOutput } from "../../format.js";
import { metrics } from "../../metrics.js";
import { analyzeQueryPlan } from "../../plan-analysis.js";
import { assertOutputAllowed, assertSqlPolicy, explainSqlPolicy } from "../../policy.js";
import {
  effectiveRowLimit,
  enrichQueryOutput,
  pagedQueryWarnings,
  queryResultWarnings
} from "../../query/output.js";
import { queryPreviewWarnings, queryShape, sensitiveSqlTerms } from "../../query/preview.js";
import { withQuerySlot, type GatewayRuntime } from "../../runtime.js";
import {
  assertReadOnlySql,
  assertSqlInputLimits,
  buildExplainSql,
  buildPagedReadOnlySql,
  prepareReadOnlySql
} from "../../sql.js";
import { selectAuthorizedProfile } from "../access.js";
import type { McpRequestContext } from "../context.js";
import { policyContext } from "../policy-context.js";
import { profileInput, sqlParamSchema } from "../schemas.js";
import { runExplainCheck } from "../sql-policy-explain.js";
import { toLimitedResult, toResult } from "../tool-runtime.js";
import type { ToolRegistrar } from "../tool-registry.js";

export function registerQueryExecutionTools(
  registerTool: ToolRegistrar,
  runtime: GatewayRuntime,
  context: McpRequestContext
): void {
  registerTool(
    "ob_query_preview",
    {
      title: "Preview Read-only Query",
      description: "Preview policy, sensitive-column, and EXPLAIN risk for a read-only SQL statement without executing the target query.",
      inputSchema: {
        ...profileInput,
        sql: z.string().min(1),
        params: z.array(sqlParamSchema).optional().default([]),
        maxRows: z.number().int().positive().max(10_000).optional()
      }
    },
    async ({ profile, sql, params = [], maxRows }) => {
      const selected = selectAuthorizedProfile(runtime, profile, context);
      const sqlParams = params as SqlParam[];
      const checks = [
        runExplainCheck("input_limits", () => assertSqlInputLimits(sql, sqlParams, selected.config)),
        runExplainCheck("read_only_sql", () => assertReadOnlySql(sql))
      ];
      const policy = explainSqlPolicy(sql, policyContext(selected.config));
      const allowed = checks.every((check) => check.ok) && policy.allowed;
      const shape = queryShape(sql, selected.config.compatibility);
      const sensitiveColumnRisk = sensitiveSqlTerms(sql, selected.config);
      const warnings = queryPreviewWarnings(shape, sensitiveColumnRisk);

      let plan: QueryOutput | undefined;
      let analysis: ReturnType<typeof analyzeQueryPlan> | undefined;
      if (allowed) {
        const explainSql = buildExplainSql(sql);
        const started = Date.now();
        plan = await withQuerySlot(selected, () =>
          runReadOnlyQuery(
            selected.pool,
            selected.config.compatibility,
            explainSql,
            sqlParams,
            effectiveRowLimit(maxRows, selected.config),
            selected.config.queryTimeoutMs,
            selected.config.enforceReadOnlyTransaction,
            selected.config.maxResultBytes
          )
        );
        metrics.recordQueryDuration(Date.now() - started);
        analysis = analyzeQueryPlan(plan, sql);
        if (analysis.riskLevel !== "low") {
          warnings.push(`EXPLAIN risk level is ${analysis.riskLevel}. Review findings before running the query.`);
        }
      } else {
        warnings.push("EXPLAIN was skipped because SQL is not allowed by the current policy checks.");
      }

      return toLimitedResult(
        {
          sql,
          paramCount: sqlParams.length,
          allowed,
          executed: false,
          explainRun: Boolean(plan),
          checks: [...checks, ...policy.checks],
          policy,
          shape,
          sensitiveColumnRisk,
          analysis,
          plan,
          warnings
        },
        selected.config
      );
    }
  );

  registerTool(
    "ob_query",
    {
      title: "Run Strict Read-Only Query",
      description: "Run a strictly read-only SQL statement against OceanBase.",
      inputSchema: {
        ...profileInput,
        sql: z.string().min(1),
        params: z.array(sqlParamSchema).optional().default([]),
        maxRows: z.number().int().positive().max(10_000).optional()
      }
    },
    async ({ profile, sql, params = [], maxRows }) => {
      const selected = selectAuthorizedProfile(runtime, profile, context);
      const started = Date.now();
      const sqlParams = params as SqlParam[];
      assertSqlInputLimits(sql, sqlParams, selected.config);
      assertSqlPolicy(sql, policyContext(selected.config));
      const effectiveMaxRows = effectiveRowLimit(maxRows, selected.config);
      const limitedSql = prepareReadOnlySql(sql, effectiveMaxRows, selected.config.compatibility);
      const output = await withQuerySlot(selected, () =>
        runReadOnlyQuery(
          selected.pool,
          selected.config.compatibility,
          limitedSql,
          sqlParams,
          effectiveMaxRows,
          selected.config.queryTimeoutMs,
          selected.config.enforceReadOnlyTransaction,
          selected.config.maxResultBytes
        )
      );
      assertOutputAllowed(output, selected.config.policy);
      const enrichedOutput = enrichQueryOutput(output, selected.config, queryResultWarnings(sql, output, selected.config));
      assertJsonByteLimit(enrichedOutput, selected.config.maxResultBytes);
      const durationMs = Date.now() - started;
      metrics.recordQueryDuration(durationMs);
      logAudit("ob_query", {
        ok: true,
        tool: "ob_query",
        profile: selected.profile,
        transport: context.transport ?? "stdio",
        requestId: context.requestId,
        clientId: context.clientId,
        principal: context.principal?.name,
        durationMs,
        rowCount: output.rowCount,
        truncated: output.truncated,
        sqlLength: sql.length,
        paramCount: sqlParams.length
      });
      return toResult(enrichedOutput);
    }
  );

  registerTool(
    "ob_query_page",
    {
      title: "Run Paged Read-Only Query",
      description: "Run a strictly read-only SELECT/WITH query with server-side pagination.",
      inputSchema: {
        ...profileInput,
        sql: z.string().min(1),
        params: z.array(sqlParamSchema).optional().default([]),
        page: z.number().int().positive().optional().default(1),
        pageSize: z.number().int().positive().max(1_000).optional(),
        orderBy: z.string().min(1).optional()
      }
    },
    async ({ profile, sql, params = [], page = 1, pageSize, orderBy }) => {
      const selected = selectAuthorizedProfile(runtime, profile, context);
      const started = Date.now();
      const sqlParams = params as SqlParam[];
      assertSqlInputLimits(sql, sqlParams, selected.config);
      assertReadOnlySql(sql);
      assertSqlPolicy(sql, policyContext(selected.config));

      const maxPageSize = Math.max(1, Math.min(selected.config.maxRows > 1 ? selected.config.maxRows - 1 : 1, 1_000));
      const effectivePageSize = Math.min(pageSize ?? Math.min(50, maxPageSize), maxPageSize);
      const fetchRows = Math.min(effectivePageSize + 1, selected.config.maxRows);
      const pagedSql = buildPagedReadOnlySql(sql, selected.config.compatibility, {
        page,
        pageSize: effectivePageSize,
        fetchRows,
        orderBy
      });
      const output = await withQuerySlot(selected, () =>
        runReadOnlyQuery(
          selected.pool,
          selected.config.compatibility,
          pagedSql,
          sqlParams,
          fetchRows,
          selected.config.queryTimeoutMs,
          selected.config.enforceReadOnlyTransaction,
          selected.config.maxResultBytes
        )
      );
      assertOutputAllowed(output, selected.config.policy);
      const rows = output.rows.slice(0, effectivePageSize);
      const hasMore = output.rows.length > effectivePageSize;
      const warnings = pagedQueryWarnings(sql, pageSize, effectivePageSize, fetchRows, orderBy);
      if (output.truncated) {
        warnings.push("Result was truncated by the configured row limit.");
      }
      const visibleOutput = enrichQueryOutput(
        {
          ...output,
          rowCount: rows.length,
          rows,
          truncated: output.truncated || hasMore
        },
        selected.config,
        warnings
      );
      const result = {
        sql,
        pagedSql,
        paramCount: sqlParams.length,
        page,
        pageSize: effectivePageSize,
        hasMore,
        truncated: visibleOutput.truncated,
        columns: visibleOutput.columns,
        rows: visibleOutput.rows,
        markdownPreview: visibleOutput.markdownPreview,
        warnings: visibleOutput.warnings,
        executed: true
      };
      assertJsonByteLimit(result, selected.config.maxResultBytes);
      metrics.recordQueryDuration(Date.now() - started);
      return toResult(result);
    }
  );
}
