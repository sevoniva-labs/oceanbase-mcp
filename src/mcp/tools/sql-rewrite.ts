import { z } from "zod";

import type { SqlParam } from "../../db.js";
import { describeTable } from "../../db.js";
import {
  assertTableAccess,
  explainSqlPolicy,
  filterColumnMetadata
} from "../../policy.js";
import { effectiveRowLimit } from "../../query/output.js";
import { hasSqlRowLimit } from "../../query/preview.js";
import { selectRuntimeProfile, withQuerySlot, type GatewayRuntime } from "../../runtime.js";
import { assertReadOnlySql, assertSqlInputLimits, buildPagedReadOnlySql } from "../../sql.js";
import { selectAuthorizedProfile } from "../access.js";
import type { McpRequestContext } from "../context.js";
import { metadataSchema } from "../metadata-scope.js";
import { policyContext } from "../policy-context.js";
import {
  buildSelectColumnInfos,
  selectBuildColumns,
  sqlQuoteIdentifier
} from "../query-builder.js";
import { profileInput, sqlParamSchema } from "../schemas.js";
import { runExplainCheck } from "../sql-policy-explain.js";
import { toLimitedResult } from "../tool-runtime.js";
import type { ToolRegistrar } from "../tool-registry.js";

export function registerSqlRewriteTools(
  registerTool: ToolRegistrar,
  runtime: GatewayRuntime,
  context: McpRequestContext
): void {
  registerTool(
    "ob_rewrite_sql",
    {
      title: "Rewrite SQL",
      description: "Rewrite SELECT/WITH SQL into a safer read-only form without executing it.",
      inputSchema: {
        ...profileInput,
        sql: z.string().min(1),
        params: z.array(sqlParamSchema).optional().default([]),
        maxRows: z.number().int().positive().max(10_000).optional(),
        orderBy: z.string().optional(),
        maxColumns: z.number().int().positive().max(50).optional()
      }
    },
    async ({ profile, sql, params = [], maxRows, orderBy, maxColumns }) => {
      const selected = selectAuthorizedProfile(runtime, profile, context);
      const rewritten = await rewriteReadOnlySql(
        selected,
        sql,
        params as SqlParam[],
        effectiveRowLimit(maxRows, selected.config),
        orderBy,
        maxColumns ?? 12
      );
      return toLimitedResult(rewritten, selected.config);
    }
  );
}

async function rewriteReadOnlySql(
  selected: ReturnType<typeof selectRuntimeProfile>,
  sql: string,
  params: SqlParam[],
  maxRows: number,
  orderBy: string | undefined,
  maxColumns: number
) {
  const checks = [
    runExplainCheck("input_limits", () => assertSqlInputLimits(sql, params, selected.config)),
    runExplainCheck("read_only_sql", () => assertReadOnlySql(sql))
  ];
  const originalPolicy = explainSqlPolicy(sql, policyContext(selected.config));
  if (!checks.every((check) => check.ok)) {
    return {
      sql,
      rewrittenSql: null,
      changed: false,
      allowed: false,
      executed: false,
      checks,
      originalPolicy,
      rewrittenPolicy: originalPolicy,
      changes: [],
      warnings: ["SQL was not rewritten because it did not pass read-only input checks."]
    };
  }

  const warnings: string[] = [];
  const changes = [];
  let rewrittenSql = trimRewriteSql(sql);
  if (hasSelectStar(rewrittenSql)) {
    const replacement = await rewriteSelectStar(selected, rewrittenSql, originalPolicy.tableRefs, maxColumns, warnings);
    if (replacement.changed) {
      rewrittenSql = replacement.sql;
      changes.push({
        rule: "replace_select_star",
        reason: "Replaced SELECT * with visible columns from metadata.",
        evidence: replacement.columns
      });
    }
  }
  if (!hasSqlRowLimit(rewrittenSql, selected.config.compatibility)) {
    rewrittenSql = buildPagedReadOnlySql(rewrittenSql, selected.config.compatibility, {
      page: 1,
      pageSize: maxRows,
      fetchRows: maxRows,
      orderBy
    });
    changes.push({
      rule: "add_pagination",
      reason: "Added a dialect-correct row cap for safer inspection.",
      evidence: [`maxRows:${maxRows}`]
    });
  }

  const rewrittenPolicy = explainSqlPolicy(rewrittenSql, policyContext(selected.config));
  const outputChecks = [
    runExplainCheck("rewritten_input_limits", () => assertSqlInputLimits(rewrittenSql, params, selected.config)),
    runExplainCheck("rewritten_read_only_sql", () => assertReadOnlySql(rewrittenSql))
  ];
  return {
    sql,
    rewrittenSql,
    changed: rewrittenSql !== trimRewriteSql(sql),
    allowed: outputChecks.every((check) => check.ok) && rewrittenPolicy.allowed,
    executed: false,
    checks: [...checks, ...outputChecks],
    originalPolicy,
    rewrittenPolicy,
    changes,
    warnings
  };
}

async function rewriteSelectStar(
  selected: ReturnType<typeof selectRuntimeProfile>,
  sql: string,
  tableRefs: Array<{ schema?: string; table: string; raw: string }>,
  maxColumns: number,
  warnings: string[]
): Promise<{ changed: boolean; sql: string; columns: string[] }> {
  const refs = uniqueTableRefs(tableRefs);
  if (refs.length !== 1) {
    warnings.push("SELECT * was not replaced because the query does not have exactly one visible table reference.");
    return { changed: false, sql, columns: [] };
  }
  if (!canRewriteDirectSelectStar(sql)) {
    warnings.push("SELECT * was not replaced because the projection is not a simple single-table SELECT * form.");
    return { changed: false, sql, columns: [] };
  }
  const ref = refs[0];
  const schema = metadataSchema(selected.config, ref.schema);
  const table = selected.config.compatibility === "oracle" ? ref.table.trim().toUpperCase() : ref.table;
  assertTableAccess(schema, table, policyContext(selected.config));
  const rows = filterColumnMetadata(
    await withQuerySlot(selected, () =>
      describeTable(selected.pool, selected.config.compatibility, table, schema, selected.config.queryTimeoutMs)
    ),
    selected.config.policy
  );
  const columns = selectBuildColumns(
    selected.config,
    buildSelectColumnInfos(selected.config, schema, table, rows),
    undefined,
    warnings
  ).slice(0, Math.max(1, Math.min(maxColumns, 50)));
  if (columns.length === 0) {
    warnings.push("SELECT * was not replaced because no visible columns were available.");
    return { changed: false, sql, columns: [] };
  }
  const selectList = columns.map((column) => sqlQuoteIdentifier(selected.config.compatibility, column.name)).join(", ");
  return {
    changed: true,
    sql: sql.replace(/\bselect\s+((?:(?:all|distinct|distinctrow|unique)\s+)*)\*\s+\bfrom\b/i, (_match, modifier: string) =>
      `SELECT ${modifier ?? ""}${selectList} FROM`
    ),
    columns: columns.map((column) => column.name)
  };
}

function canRewriteDirectSelectStar(sql: string): boolean {
  return /\bselect\s+(?:(?:all|distinct|distinctrow|unique)\s+)*\*\s+\bfrom\b/i.test(sql);
}

function hasSelectStar(sql: string): boolean {
  return /\bselect\s+(?:\/\*.*?\*\/\s*)?\*/is.test(sql) || /,\s*\*/.test(sql);
}

function trimRewriteSql(sql: string): string {
  return sql.trim().replace(/;+$/, "").trimEnd();
}

function uniqueTableRefs(refs: Array<{ schema?: string; table: string }>): Array<{ schema?: string; table: string }> {
  const output: Array<{ schema?: string; table: string }> = [];
  const seen = new Set<string>();
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
