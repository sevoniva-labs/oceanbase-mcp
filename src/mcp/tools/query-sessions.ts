import { randomUUID } from "node:crypto";

import { z } from "zod";

import { describeTable, runReadOnlyQuery, type SqlParam } from "../../db.js";
import { assertJsonByteLimit } from "../../format.js";
import { metrics } from "../../metrics.js";
import {
  assertOutputAllowed,
  assertSqlPolicy,
  assertTableAccess,
  explainSqlPolicy,
  filterColumnMetadata,
  isSchemaAllowed
} from "../../policy.js";
import { enrichQueryOutput, pagedQueryWarnings } from "../../query/output.js";
import { queryShape, sensitiveSqlTerms } from "../../query/preview.js";
import {
  cleanupQuerySessions,
  getQuerySessionForProfile,
  pruneQuerySessions,
  publicQuerySession,
  QUERY_SESSION_TTL_MS,
  querySessionMasking,
  validateQuerySessionColumns,
  type QuerySessionState
} from "../../query/sessions.js";
import { withQuerySlot, type GatewayRuntime } from "../../runtime.js";
import { assertReadOnlySql, assertSqlInputLimits, buildPagedReadOnlySql } from "../../sql.js";
import { selectAuthorizedProfile } from "../access.js";
import type { McpRequestContext } from "../context.js";
import { metadataSchema } from "../metadata-scope.js";
import { policyContext } from "../policy-context.js";
import { buildStructuredSelect } from "../query-builder.js";
import {
  buildSelectFilterSchema,
  buildSelectOrderBySchema,
  profileInput,
  sqlParamSchema,
  type BuildSelectFilter,
  type BuildSelectOrderBy
} from "../schemas.js";
import { toLimitedResult, toResult } from "../tool-runtime.js";
import type { ToolRegistrar } from "../tool-registry.js";

export function registerQuerySessionTools(
  registerTool: ToolRegistrar,
  runtime: GatewayRuntime,
  context: McpRequestContext,
  querySessions: Map<string, QuerySessionState>
): void {
  registerTool(
    "ob_start_query_session",
    {
      title: "Start Query Session",
      description: "Create an in-memory read-only query context for follow-up paging, refinement, and summarization.",
      inputSchema: {
        ...profileInput,
        businessTerm: z.string().optional(),
        schema: z.string().optional(),
        table: z.string().optional(),
        columns: z.array(z.string().min(1)).max(100).optional().default([]),
        sql: z.string().optional(),
        params: z.array(sqlParamSchema).optional().default([]),
        page: z.number().int().positive().optional().default(1),
        pageSize: z.number().int().positive().max(1_000).optional(),
        orderBy: z.string().optional(),
        warnings: z.array(z.string().min(1)).max(50).optional().default([])
      }
    },
    async ({ profile, businessTerm, schema, table, columns = [], sql, params = [], page = 1, pageSize, orderBy, warnings = [] }) => {
      const selected = selectAuthorizedProfile(runtime, profile, context);
      cleanupQuerySessions(querySessions);
      const effectiveSchema = metadataSchema(selected.config, schema);
      const sessionColumns = validateQuerySessionColumns(
        columns,
        effectiveSchema,
        table,
        selected.config,
        (schema, targetTable) => assertTableAccess(schema, targetTable, policyContext(selected.config))
      );
      if (table) {
        assertTableAccess(effectiveSchema, table, policyContext(selected.config));
      } else if (effectiveSchema && !isSchemaAllowed(effectiveSchema, selected.config.policy)) {
        throw new Error(`Schema "${effectiveSchema}" is not allowed by the configured OceanBase MCP access policy.`);
      }

      const sqlParams = params as SqlParam[];
      const trimmedSql = sql?.trim();
      let policy: ReturnType<typeof explainSqlPolicy> | undefined;
      let shape: ReturnType<typeof queryShape> | undefined;
      const sessionWarnings = [...warnings];
      if (trimmedSql) {
        assertSqlInputLimits(trimmedSql, sqlParams, selected.config);
        assertReadOnlySql(trimmedSql);
        assertSqlPolicy(trimmedSql, policyContext(selected.config));
        policy = explainSqlPolicy(trimmedSql, policyContext(selected.config));
        shape = queryShape(trimmedSql, selected.config.compatibility);
        if (!shape.hasOrderBy && !orderBy) {
          sessionWarnings.push("No ORDER BY is recorded for this session. Paged follow-up queries may have unstable ordering.");
        }
      }

      const now = new Date();
      const session: QuerySessionState = {
        id: `qs_${randomUUID()}`,
        profile: selected.profile,
        mode: selected.config.compatibility,
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + QUERY_SESSION_TTL_MS).toISOString(),
        businessTerm: cleanOptionalString(businessTerm),
        schema: effectiveSchema,
        table: cleanOptionalString(table),
        columns: sessionColumns,
        sql: trimmedSql,
        params: sqlParams,
        page,
        pageSize,
        orderBy: cleanOptionalString(orderBy),
        warnings: uniqueStrings(sessionWarnings),
        masking: querySessionMasking(sessionColumns, effectiveSchema, table, selected.config),
        resultState: {}
      };
      querySessions.set(session.id, session);
      pruneQuerySessions(querySessions);
      return toLimitedResult(
        {
          ...publicQuerySession(session),
          policy,
          shape,
          executed: false
        },
        selected.config
      );
    }
  );

  registerTool(
    "ob_get_query_session",
    {
      title: "Get Query Session",
      description: "Return a read-only query session context without exposing stored parameter values.",
      inputSchema: {
        ...profileInput,
        sessionId: z.string().min(1)
      }
    },
    async ({ profile, sessionId }) => {
      const selected = selectAuthorizedProfile(runtime, profile, context);
      cleanupQuerySessions(querySessions);
      const session = getQuerySessionForProfile(querySessions, sessionId, selected.profile);
      return toLimitedResult(publicQuerySession(session), selected.config);
    }
  );

  registerTool(
    "ob_close_query_session",
    {
      title: "Close Query Session",
      description: "Close an in-memory query session for the selected profile.",
      inputSchema: {
        ...profileInput,
        sessionId: z.string().min(1)
      }
    },
    async ({ profile, sessionId }) => {
      const selected = selectAuthorizedProfile(runtime, profile, context);
      cleanupQuerySessions(querySessions);
      const session = getQuerySessionForProfile(querySessions, sessionId, selected.profile);
      querySessions.delete(session.id);
      return toLimitedResult(
        {
          sessionId: session.id,
          closed: true,
          profile: session.profile,
          mode: session.mode
        },
        selected.config
      );
    }
  );

  registerTool(
    "ob_query_next_page",
    {
      title: "Query Next Session Page",
      description: "Run the next page for a read-only query session without bypassing row, timeout, output, or policy limits.",
      inputSchema: {
        ...profileInput,
        sessionId: z.string().min(1),
        pageSize: z.number().int().positive().max(1_000).optional(),
        orderBy: z.string().min(1).optional()
      }
    },
    async ({ profile, sessionId, pageSize, orderBy }) => {
      const selected = selectAuthorizedProfile(runtime, profile, context);
      cleanupQuerySessions(querySessions);
      const session = getQuerySessionForProfile(querySessions, sessionId, selected.profile);
      return runQuerySessionPage(selected, session, session.page + 1, pageSize, orderBy);
    }
  );

  registerTool(
    "ob_query_prev_page",
    {
      title: "Query Previous Session Page",
      description: "Run the previous page for a read-only query session without bypassing row, timeout, output, or policy limits.",
      inputSchema: {
        ...profileInput,
        sessionId: z.string().min(1),
        pageSize: z.number().int().positive().max(1_000).optional(),
        orderBy: z.string().min(1).optional()
      }
    },
    async ({ profile, sessionId, pageSize, orderBy }) => {
      const selected = selectAuthorizedProfile(runtime, profile, context);
      cleanupQuerySessions(querySessions);
      const session = getQuerySessionForProfile(querySessions, sessionId, selected.profile);
      const previousPage = Math.max(1, session.page - 1);
      const warnings = previousPage === session.page ? ["Session is already on the first page."] : [];
      return runQuerySessionPage(selected, session, previousPage, pageSize, orderBy, warnings);
    }
  );

  registerTool(
    "ob_query_refine",
    {
      title: "Refine Query Session SQL",
      description: "Build a refined read-only SELECT from a query session using structured columns, filters, ordering, and pagination without executing it.",
      inputSchema: {
        ...profileInput,
        sessionId: z.string().min(1),
        columns: z.array(z.string().min(1)).min(1).max(100).optional(),
        addColumns: z.array(z.string().min(1)).max(100).optional().default([]),
        keepExistingColumns: z.boolean().optional().default(true),
        filters: z.array(buildSelectFilterSchema).max(50).optional().default([]),
        orderBy: z.array(buildSelectOrderBySchema).max(20).optional(),
        pageSize: z.number().int().positive().max(10_000).optional(),
        page: z.number().int().positive().max(100_000).optional(),
        updateSession: z.boolean().optional().default(false)
      }
    },
    async ({ profile, sessionId, columns, addColumns = [], keepExistingColumns = true, filters = [], orderBy, pageSize, page, updateSession = false }) => {
      const selected = selectAuthorizedProfile(runtime, profile, context);
      cleanupQuerySessions(querySessions);
      const session = getQuerySessionForProfile(querySessions, sessionId, selected.profile);
      if (!session.table) {
        throw new Error(`Query session "${session.id}" does not have a table context to refine.`);
      }
      const refinedColumns = refinedQueryColumns(session, columns, addColumns, keepExistingColumns);
      const rows = filterColumnMetadata(
        await withQuerySlot(selected, () =>
          describeTable(selected.pool, selected.config.compatibility, session.table!, session.schema, selected.config.queryTimeoutMs)
        ),
        selected.config.policy
      );
      const built = buildStructuredSelect(
        selected.config,
        session.schema,
        session.table,
        rows,
        {
          columns: refinedColumns,
          filters,
          orderBy: orderBy ?? sessionOrderByForStructuredInput(session),
          pageSize: pageSize ?? session.pageSize,
          page: page ?? session.page
        }
      );
      const warnings = uniqueStrings([
        ...built.warnings,
        ...refineWarnings(session, filters, columns, addColumns)
      ]);
      if (updateSession) {
        updateSessionFromRefinedSql(
          session,
          built.sql,
          built.params,
          built.columns.map((column) => column.name),
          built.pagination.page,
          built.pagination.pageSize,
          built.orderBy,
          warnings
        );
      }
      return toLimitedResult(
        {
          sessionId: session.id,
          mode: selected.config.compatibility,
          schema: session.schema ?? null,
          table: session.table,
          sql: built.sql,
          params: built.params,
          paramHints: built.paramHints,
          changes: refinedQueryChanges(session, refinedColumns, filters, orderBy, pageSize, page),
          preview: {
            policy: built.policy,
            shape: queryShape(built.sql, selected.config.compatibility),
            sensitiveColumnRisk: sensitiveSqlTerms(built.sql, selected.config),
            warnings
          },
          columns: built.columns,
          filters: built.filters,
          orderBy: built.orderBy,
          pagination: built.pagination,
          sessionUpdated: updateSession,
          session: updateSession ? publicQuerySession(session) : undefined,
          executed: false
        },
        selected.config
      );
    }
  );
}

async function runQuerySessionPage(
  selected: ReturnType<typeof selectAuthorizedProfile>,
  session: QuerySessionState,
  page: number,
  pageSize: number | undefined,
  orderBy: string | undefined,
  extraWarnings: string[] = []
) {
  if (!session.sql) {
    throw new Error(`Query session "${session.id}" does not have SQL to page.`);
  }
  const started = Date.now();
  assertSqlInputLimits(session.sql, session.params, selected.config);
  assertReadOnlySql(session.sql);
  assertSqlPolicy(session.sql, policyContext(selected.config));

  const maxPageSize = Math.max(1, Math.min(selected.config.maxRows > 1 ? selected.config.maxRows - 1 : 1, 1_000));
  const effectivePageSize = Math.min(pageSize ?? session.pageSize ?? Math.min(50, maxPageSize), maxPageSize);
  const fetchRows = Math.min(effectivePageSize + 1, selected.config.maxRows);
  const effectiveOrderBy = querySessionOrderBy(session.sql, orderBy, session.orderBy);
  const pagedSql = buildPagedReadOnlySql(session.sql, selected.config.compatibility, {
    page,
    pageSize: effectivePageSize,
    fetchRows,
    orderBy: effectiveOrderBy
  });
  const output = await withQuerySlot(selected, () =>
    runReadOnlyQuery(
      selected.pool,
      selected.config.compatibility,
      pagedSql,
      session.params,
      fetchRows,
      selected.config.queryTimeoutMs,
      selected.config.enforceReadOnlyTransaction,
      selected.config.maxResultBytes
    )
  );
  assertOutputAllowed(output, selected.config.policy);
  const rows = output.rows.slice(0, effectivePageSize);
  const hasMore = output.rows.length > effectivePageSize;
  const warnings = [
    ...extraWarnings,
    ...pagedQueryWarnings(session.sql, pageSize ?? session.pageSize, effectivePageSize, fetchRows, effectiveOrderBy)
  ];
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
  const now = new Date();
  session.page = page;
  session.pageSize = effectivePageSize;
  session.orderBy = cleanOptionalString(orderBy) ?? session.orderBy;
  session.updatedAt = now.toISOString();
  session.expiresAt = new Date(now.getTime() + QUERY_SESSION_TTL_MS).toISOString();
  session.warnings = uniqueStrings([...session.warnings, ...visibleOutput.warnings]);
  session.resultState = {
    rowCount: visibleOutput.rowCount,
    hasMore,
    truncated: visibleOutput.truncated
  };
  const result = {
    sessionId: session.id,
    mode: selected.config.compatibility,
    sql: session.sql,
    pagedSql,
    paramCount: session.params.length,
    page,
    pageSize: effectivePageSize,
    hasMore,
    truncated: visibleOutput.truncated,
    columns: visibleOutput.columns,
    rows: visibleOutput.rows,
    markdownPreview: visibleOutput.markdownPreview,
    warnings: visibleOutput.warnings,
    session: publicQuerySession(session),
    executed: true
  };
  assertJsonByteLimit(result, selected.config.maxResultBytes);
  metrics.recordQueryDuration(Date.now() - started);
  return toResult(result);
}

function querySessionOrderBy(
  sql: string,
  requestedOrderBy: string | undefined,
  sessionOrderBy: string | undefined
): string | undefined {
  if (requestedOrderBy) {
    return requestedOrderBy;
  }
  if (/\border\s+by\b/i.test(sql)) {
    return undefined;
  }
  return sessionOrderBy;
}

function refinedQueryColumns(
  session: QuerySessionState,
  columns: string[] | undefined,
  addColumns: string[],
  keepExistingColumns: boolean
): string[] | undefined {
  if (columns && columns.length > 0) {
    return uniqueStrings(columns.map((column) => column.trim()).filter(Boolean));
  }
  const base = keepExistingColumns ? session.columns : [];
  const output = uniqueStrings([...base, ...addColumns].map((column) => column.trim()).filter(Boolean));
  return output.length > 0 ? output : undefined;
}

function sessionOrderByForStructuredInput(session: QuerySessionState): BuildSelectOrderBy[] {
  if (!session.orderBy || session.orderBy.includes(",") || /\s/.test(session.orderBy.trim())) {
    return [];
  }
  return [{ column: session.orderBy }];
}

function refineWarnings(
  session: QuerySessionState,
  filters: BuildSelectFilter[],
  columns: string[] | undefined,
  addColumns: string[]
): string[] {
  const warnings: string[] = [];
  if (session.sql && /\bwhere\b/i.test(session.sql) && filters.length === 0) {
    warnings.push("Previous WHERE conditions were not parsed. Pass required filters explicitly when refining a session query.");
  }
  if (!columns && addColumns.length > 0) {
    warnings.push("Added columns are selected from table metadata; verify they match the intended application projection.");
  }
  return warnings;
}

function refinedQueryChanges(
  session: QuerySessionState,
  columns: string[] | undefined,
  filters: BuildSelectFilter[],
  orderBy: BuildSelectOrderBy[] | undefined,
  pageSize: number | undefined,
  page: number | undefined
): string[] {
  const changes: string[] = [];
  if (columns && columns.length > 0) {
    const previous = session.columns.length > 0 ? session.columns.join(", ") : "default visible columns";
    changes.push(`Projection changed from ${previous} to ${columns.join(", ")}.`);
  }
  if (filters.length > 0) {
    changes.push(`Added ${filters.length} structured filter${filters.length === 1 ? "" : "s"}.`);
  }
  if (orderBy && orderBy.length > 0) {
    changes.push(`Updated ordering to ${orderBy.map((item) => `${item.column}${item.direction ? ` ${item.direction}` : ""}`).join(", ")}.`);
  }
  if (pageSize || page) {
    changes.push(`Updated pagination to page ${page ?? session.page}, pageSize ${pageSize ?? session.pageSize ?? "default"}.`);
  }
  return changes.length > 0 ? changes : ["Rebuilt SELECT from the current query session context."];
}

function updateSessionFromRefinedSql(
  session: QuerySessionState,
  sql: string,
  params: SqlParam[],
  columns: string[],
  page: number,
  pageSize: number,
  orderBy: BuildSelectOrderBy[],
  warnings: string[]
) {
  const now = new Date();
  session.sql = sql;
  session.params = params;
  session.columns = columns;
  session.page = page;
  session.pageSize = pageSize;
  if (orderBy.length === 1) {
    session.orderBy = orderBy[0].column;
  }
  session.updatedAt = now.toISOString();
  session.expiresAt = new Date(now.getTime() + QUERY_SESSION_TTL_MS).toISOString();
  session.warnings = uniqueStrings([...session.warnings, ...warnings]);
}

function cleanOptionalString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
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
