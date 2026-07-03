import { z } from "zod";

import {
  getTableStats,
  listIndexes,
  runReadOnlyQuery,
  type SqlParam
} from "../../db.js";
import { metrics } from "../../metrics.js";
import { analyzeQueryPlan } from "../../plan-analysis.js";
import { buildPerformanceReport } from "../../performance-report.js";
import {
  assertSqlPolicy,
  assertTableAccess,
  explainSqlPolicy,
  filterColumnMetadata
} from "../../policy.js";
import { effectiveRowLimit } from "../../query/output.js";
import { withQuerySlot, type GatewayRuntime } from "../../runtime.js";
import { assertReadOnlySql, assertSqlInputLimits, buildExplainSql } from "../../sql.js";
import { selectAuthorizedProfile } from "../access.js";
import type { McpRequestContext } from "../context.js";
import { metadataTableRef } from "../metadata-scope.js";
import { policyContext } from "../policy-context.js";
import { profileInput, sqlParamSchema } from "../schemas.js";
import { toLimitedResult } from "../tool-runtime.js";
import type { ToolRegistrar } from "../tool-registry.js";

export function registerQueryPlanTools(
  registerTool: ToolRegistrar,
  runtime: GatewayRuntime,
  context: McpRequestContext
): void {
  registerTool(
    "ob_explain",
    {
      title: "Explain Query",
      description: "Run EXPLAIN for a strictly read-only SQL statement.",
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
      assertSqlInputLimits(sql, sqlParams, selected.config);
      assertReadOnlySql(sql);
      assertSqlPolicy(sql, policyContext(selected.config));
      const explainSql = buildExplainSql(sql);
      const started = Date.now();
      const output = await withQuerySlot(selected, () =>
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
      return toLimitedResult(output, selected.config);
    }
  );

  registerTool(
    "ob_analyze_query_plan",
    {
      title: "Analyze Query Plan",
      description: "Run EXPLAIN for a strictly read-only SQL statement and return evidence-based plan findings.",
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
      assertSqlInputLimits(sql, sqlParams, selected.config);
      assertReadOnlySql(sql);
      assertSqlPolicy(sql, policyContext(selected.config));
      const explainSql = buildExplainSql(sql);
      const started = Date.now();
      const plan = await withQuerySlot(selected, () =>
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
      return toLimitedResult(
        {
          sql,
          analysis: analyzeQueryPlan(plan, sql),
          plan
        },
        selected.config
      );
    }
  );

  registerTool(
    "ob_generate_performance_report",
    {
      title: "Generate Performance Report",
      description: "Generate a read-only SQL performance advisory report from EXPLAIN, table statistics, and index metadata.",
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
      assertSqlInputLimits(sql, sqlParams, selected.config);
      assertReadOnlySql(sql);
      assertSqlPolicy(sql, policyContext(selected.config));
      const policy = explainSqlPolicy(sql, policyContext(selected.config));
      const explainSql = buildExplainSql(sql);
      const started = Date.now();
      const plan = await withQuerySlot(selected, () =>
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
      const planAnalysis = analyzeQueryPlan(plan, sql);
      const tableContexts = [];
      for (const ref of uniqueTableRefs(policy.tableRefs).slice(0, 5)) {
        const metadataRef = metadataTableRef(selected.config, ref.schema, ref.table);
        assertTableAccess(metadataRef.schema, metadataRef.table, policyContext(selected.config));
        const stats = await withQuerySlot(selected, () =>
          getTableStats(
            selected.pool,
            selected.config.compatibility,
            metadataRef.table,
            metadataRef.schema,
            selected.config.queryTimeoutMs
          )
        );
        const indexes = filterColumnMetadata(
          await withQuerySlot(selected, () =>
            listIndexes(
              selected.pool,
              selected.config.compatibility,
              metadataRef.table,
              metadataRef.schema,
              selected.config.queryTimeoutMs
            )
          ),
          selected.config.policy
        );
        tableContexts.push({
          schema: metadataRef.schema,
          table: metadataRef.table,
          stats,
          indexes
        });
      }
      return toLimitedResult(
        {
          sql,
          executed: false,
          report: buildPerformanceReport(planAnalysis, tableContexts),
          planAnalysis,
          tables: tableContexts.map((item) => ({
            schema: item.schema,
            table: item.table,
            stats: item.stats,
            indexRows: item.indexes.length
          })),
          plan
        },
        selected.config
      );
    }
  );
}

function uniqueTableRefs(refs: Array<{ schema?: string; table: string }>): Array<{ schema?: string; table: string }> {
  const seen = new Set<string>();
  const output = [];
  for (const ref of refs) {
    const key = `${ref.schema ?? ""}.${ref.table}`.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    output.push(ref);
  }
  return output;
}
