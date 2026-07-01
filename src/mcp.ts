import { randomUUID } from "node:crypto";

import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { buildUsageGuide, listCapabilities, SERVER_VERSION, TOOL_CAPABILITIES } from "./capabilities.js";
import type { AuthPrincipal, GatewayConfig, HttpConfig, ObConfig } from "./config.js";
import { publicConfig } from "./config.js";
import {
  describeTable,
  findColumns,
  findRelatedTables,
  getObjectMetadata,
  getTableDdlMetadata,
  getTableStats,
  listConstraints,
  listIndexes,
  listObjects,
  listPartitions,
  listSchemas,
  listSchemaMapTables,
  listTables,
  ping,
  profileColumns,
  renderStructuredTableDdl,
  runReadOnlyQuery,
  sampleRows,
  searchCatalog,
  verifyReadOnlyPermissions,
  type SchemaMapTable,
  type TableRelationship,
  type SqlParam
} from "./db.js";
import { diagnoseGateway } from "./diagnostics.js";
import { buildErDiagram, type ErEntity } from "./er.js";
import { logAudit, logError, serializeError } from "./errors.js";
import { assertJsonByteLimit, jsonByteLength, jsonText, type QueryOutput } from "./format.js";
import { metrics } from "./metrics.js";
import { analyzeQueryPlan } from "./plan-analysis.js";
import { buildPerformanceReport } from "./performance-report.js";
import { diagnoseOpenCodeSetup } from "./local-diagnostics.js";
import {
  assertOutputAllowed,
  assertObjectAccess,
  assertSqlPolicy,
  assertTableAccess,
  explainSqlPolicy,
  filterColumnMetadata,
  filterObjects,
  filterSchemas,
  filterTables,
  isSchemaAllowed,
  isDeniedColumn,
  isMaskedColumn
} from "./policy.js";
import { generateQueryTemplates, type QueryTemplateScenario } from "./query-generation.js";
import { selectRuntimeProfile, withQuerySlot, type GatewayRuntime } from "./runtime.js";
import { assertReadOnlySql, assertSqlInputLimits, buildExplainSql, buildPagedReadOnlySql, prepareReadOnlySql } from "./sql.js";

const sqlParamSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);
const buildSelectFilterSchema = z.object({
  column: z.string().min(1),
  operator: z.enum(["eq", "ne", "gt", "gte", "lt", "lte", "like", "in", "between", "is_null", "is_not_null"]),
  value: z.union([sqlParamSchema, z.array(sqlParamSchema)]).optional()
});
const buildSelectOrderBySchema = z.object({
  column: z.string().min(1),
  direction: z.enum(["asc", "desc"]).optional(),
  nulls: z.enum(["first", "last"]).optional()
});
const resultSummaryColumnSchema = z.object({
  name: z.string().min(1),
  type: z.string().optional(),
  table: z.string().optional(),
  schema: z.string().optional(),
  masked: z.boolean().optional()
});
const compatibilityModeSchema = z.enum(["mysql", "oracle"]);
const oracleObjectTypeSchema = z.enum(["view", "sequence", "synonym", "procedure", "function", "package", "package_body"]);
const queryScenarioSchema = z.enum(["by_primary_key", "pagination", "time_range", "aggregation", "join"]);
const profileInput = {
  profile: z.string().optional()
};
const SENSITIVE_SAMPLE_PATTERN =
  /(password|passwd|pwd|secret|token|api[_-]?key|private[_-]?key|credential|session|cookie|email|phone|mobile|id[_-]?card|ssn)/i;
const QUERY_SESSION_TTL_MS = 4 * 60 * 60 * 1000;
const MAX_QUERY_SESSIONS = 100;
const QUERY_TERM_STOPWORDS = new Set([
  "show",
  "list",
  "find",
  "get",
  "query",
  "select",
  "data",
  "rows",
  "table",
  "recent",
  "latest",
  "count",
  "查询",
  "查看",
  "列出",
  "数据",
  "列表",
  "最近",
  "最新",
  "统计",
  "数量"
]);

interface QuerySessionState {
  id: string;
  profile: string;
  mode: ObConfig["compatibility"];
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  businessTerm?: string;
  schema?: string;
  table?: string;
  columns: string[];
  sql?: string;
  params: SqlParam[];
  page: number;
  pageSize?: number;
  orderBy?: string;
  warnings: string[];
  masking: {
    maskedColumns: string[];
    sensitiveColumns: string[];
  };
  resultState: {
    rowCount?: number;
    hasMore?: boolean;
    truncated?: boolean;
  };
}

type RuntimeWithQuerySessions = GatewayRuntime & {
  querySessions?: Map<string, QuerySessionState>;
};

export interface McpRequestContext {
  principal?: AuthPrincipal;
  requestId?: string;
  clientId?: string;
  transport?: "stdio" | "http";
}

export function createObMcpServer(
  runtime: GatewayRuntime,
  httpConfig?: HttpConfig,
  context: McpRequestContext = { transport: "stdio" }
): McpServer {
  const querySessions = ensureQuerySessionStore(runtime);
  const server = new McpServer({
    name: "ob-mcp",
    version: SERVER_VERSION
  });
  const toolHandler = <Args>(name: string, handler: (args: Args) => Promise<ReturnType<typeof toResult>>) =>
    safeTool(name, handler, context);
  const registerTool = (
    name: string,
    spec: {
      title: string;
      description: string;
      inputSchema: Record<string, z.ZodType>;
    },
    handler: (args: any) => Promise<ReturnType<typeof toResult>>
  ) => {
    if (!isToolAllowed(name, context.principal)) {
      return;
    }
    server.registerTool(name, spec, toolHandler(name, handler) as any);
  };

  server.registerResource(
    "connection",
    "ob://connection",
    {
      title: "Default OceanBase Connection",
      description: "Default OceanBase MCP connection settings, excluding password and SSL material.",
      mimeType: "application/json"
    },
    async (uri) => {
      const selected = selectAuthorizedProfile(runtime, undefined, context);
      return resourceResult(uri.href, publicConfig(selected.config), selected.config);
    }
  );

  server.registerResource(
    "profiles",
    "ob://profiles",
    {
      title: "OceanBase MCP Profiles",
      description: "Configured OceanBase profiles with redacted connection settings.",
      mimeType: "application/json"
    },
    async (uri) =>
      resourceResult(uri.href, {
        defaultProfile: visibleDefaultProfile(runtime, context),
        profiles: publicProfiles(runtime, context)
      }, gatewayLimitConfig(runtime, context))
  );

  server.registerResource(
    "table-schema",
    new ResourceTemplate("ob://profile/{profile}/schema/{schema}/table/{table}", { list: undefined }),
    {
      title: "OceanBase Table Schema",
      description: "Policy-filtered table schema for one profile/schema/table.",
      mimeType: "application/json"
    },
    async (uri, variables) => {
      const selected = selectAuthorizedProfile(runtime, stringVariable(variables.profile), context);
      const schema = stringVariable(variables.schema);
      const table = stringVariable(variables.table);
      assertTableAccess(schema, table, policyContext(selected.config));
      const rows = await withQuerySlot(selected, () =>
        describeTable(selected.pool, selected.config.compatibility, table, schema, selected.config.queryTimeoutMs)
      );
      return resourceResult(uri.href, filterColumnMetadata(rows, selected.config.policy), selected.config);
    }
  );

  registerTool(
    "ob_list_profiles",
    {
      title: "List OceanBase Profiles",
      description: "List configured OceanBase MCP profiles with redacted settings.",
      inputSchema: {}
    },
    async () =>
      toGatewayLimitedResult({
        defaultProfile: visibleDefaultProfile(runtime, context),
        profiles: publicProfiles(runtime, context)
      }, runtime, context)
  );

  registerTool(
    "ob_config_diagnostics",
    {
      title: "Run Config Diagnostics",
      description: "Check profile, policy, TLS, HTTP, and production hardening settings.",
      inputSchema: {}
    },
    async () =>
      toGatewayLimitedResult(
        diagnoseGateway(authorizedGatewayConfig(runtime, context), httpConfig),
        runtime,
        context
      )
  );

  registerTool(
    "ob_check_opencode_setup",
    {
      title: "Check OpenCode Setup",
      description: "Check local OpenCode config, OceanBase agent, and query skill files for the current project.",
      inputSchema: profileInput
    },
    async ({ profile }) => {
      const selected = selectAuthorizedProfile(runtime, profile, context);
      return toLimitedResult(
        diagnoseOpenCodeSetup(authorizedGatewayConfig(runtime, context)),
        selected.config
      );
    }
  );

  registerTool(
    "ob_get_usage_guide",
    {
      title: "Get OceanBase MCP Usage Guide",
      description: "Return the recommended read-only OpenCode workflow, safety rules, and MySQL/Oracle notes.",
      inputSchema: profileInput
    },
    async ({ profile }) => {
      const selected = selectAuthorizedProfile(runtime, profile, context);
      return toLimitedResult(
        buildUsageGuide({
          profile: selected.profile,
          compatibility: selected.config.compatibility
        }),
        selected.config
      );
    }
  );

  registerTool(
    "ob_list_capabilities",
    {
      title: "List OceanBase MCP Capabilities",
      description: "List supported tool groups, tool versions, active compatibility mode, and read-only limits.",
      inputSchema: profileInput
    },
    async ({ profile }) => {
      const selected = selectAuthorizedProfile(runtime, profile, context);
      const visibleTools = TOOL_CAPABILITIES.filter((tool) => isToolAllowed(tool.name, context.principal));
      return toLimitedResult(
        listCapabilities({
          profile: selected.profile,
          compatibility: selected.config.compatibility,
          tools: visibleTools
        }),
        selected.config
      );
    }
  );

  registerTool(
    "ob_verify_permissions",
    {
      title: "Verify Database Permissions",
      description: "Inspect current database grants and report whether the account appears read-only.",
      inputSchema: profileInput
    },
    async ({ profile }) => {
      const selected = selectAuthorizedProfile(runtime, profile, context);
      const result = await withQuerySlot(selected, () =>
        verifyReadOnlyPermissions(selected.pool, selected.config.compatibility, selected.config.queryTimeoutMs)
      );
      return toLimitedResult(
        {
          profile: selected.profile,
          ...result
        },
        selected.config
      );
    }
  );

  registerTool(
    "ob_ping",
    {
      title: "Ping OceanBase",
      description: "Verify the configured OceanBase connection.",
      inputSchema: profileInput
    },
    async ({ profile }) => {
      const selected = selectAuthorizedProfile(runtime, profile, context);
      const result = await withQuerySlot(selected, () => ping(selected.pool, selected.config));
      return toLimitedResult(result, selected.config);
    }
  );

  registerTool(
    "ob_policy_explain",
    {
      title: "Explain SQL Policy Decision",
      description: "Explain whether a SQL statement is allowed and which read-only or access-policy checks apply.",
      inputSchema: {
        ...profileInput,
        sql: z.string().min(1),
        params: z.array(sqlParamSchema).optional().default([])
      }
    },
    async ({ profile, sql, params = [] }) => {
      const selected = selectAuthorizedProfile(runtime, profile, context);
      const sqlParams = params as SqlParam[];
      const checks = [
        runExplainCheck("input_limits", () => assertSqlInputLimits(sql, sqlParams, selected.config)),
        runExplainCheck("read_only_sql", () => assertReadOnlySql(sql))
      ];
      const policy = explainSqlPolicy(sql, policyContext(selected.config));
      return toLimitedResult({
        profile: selected.profile,
        allowed: checks.every((check) => check.ok) && policy.allowed,
        checks,
        policy
      }, selected.config);
    }
  );

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
            selected.config.enforceReadOnlyTransaction
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
          selected.config.enforceReadOnlyTransaction
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
          selected.config.enforceReadOnlyTransaction
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
      const sessionColumns = validateQuerySessionColumns(columns, effectiveSchema, table, selected.config);
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
    "ob_list_schemas",
    {
      title: "List Schemas",
      description: "List schemas/databases visible to the current OceanBase user, filtered by access policy.",
      inputSchema: profileInput
    },
    async ({ profile }) => {
      const selected = selectAuthorizedProfile(runtime, profile, context);
      const rows = await withQuerySlot(selected, () =>
        listSchemas(selected.pool, selected.config.compatibility, selected.config.queryTimeoutMs)
      );
      return toLimitedResult(filterSchemas(rows, selected.config.policy), selected.config);
    }
  );

  registerTool(
    "ob_list_tables",
    {
      title: "List Tables",
      description: "List tables visible to the current OceanBase user, filtered by access policy.",
      inputSchema: {
        ...profileInput,
        schema: z.string().optional(),
        limit: z.number().int().positive().max(10_000).optional()
      }
    },
    async ({ profile, schema, limit }) => {
      const selected = selectAuthorizedProfile(runtime, profile, context);
      if (schema) {
        assertTableAccess(schema, "*", policyContext(selected.config));
      }
      const rows = await withQuerySlot(selected, () =>
        listTables(
          selected.pool,
          selected.config.compatibility,
          schema,
          effectiveRowLimit(limit, selected.config),
          selected.config.queryTimeoutMs
        )
      );
      return toLimitedResult(filterTables(rows, selected.config.policy), selected.config);
    }
  );

  registerTool(
    "ob_describe_table",
    {
      title: "Describe Table",
      description: "Return column metadata for an allowed OceanBase table.",
      inputSchema: {
        ...profileInput,
        table: z.string().min(1),
        schema: z.string().optional()
      }
    },
    async ({ profile, table, schema }) => {
      const selected = selectAuthorizedProfile(runtime, profile, context);
      const effectiveSchema = metadataSchema(selected.config, schema);
      assertTableAccess(effectiveSchema, table, policyContext(selected.config));
      const rows = await withQuerySlot(selected, () =>
        describeTable(selected.pool, selected.config.compatibility, table, effectiveSchema, selected.config.queryTimeoutMs)
      );
      return toLimitedResult(filterColumnMetadata(rows, selected.config.policy), selected.config);
    }
  );

  registerTool(
    "ob_get_schema_map",
    {
      title: "Get Schema Map",
      description: "Return a compact, policy-filtered schema map with table summaries, key fields, and relationship hints.",
      inputSchema: {
        ...profileInput,
        schema: z.string().optional(),
        tablePattern: z.string().optional(),
        maxTables: z.number().int().positive().max(500).optional(),
        includeColumns: z.boolean().optional().default(true),
        includeRelationships: z.boolean().optional().default(true),
        maxColumnsPerTable: z.number().int().positive().max(100).optional(),
        relationshipLimit: z.number().int().positive().max(100).optional()
      }
    },
    async ({
      profile,
      schema,
      tablePattern,
      maxTables,
      includeColumns = true,
      includeRelationships = true,
      maxColumnsPerTable,
      relationshipLimit
    }) => {
      const selected = selectAuthorizedProfile(runtime, profile, context);
      const effectiveSchema = metadataSchema(selected.config, schema);
      if (effectiveSchema && !isSchemaAllowed(effectiveSchema, selected.config.policy)) {
        throw new Error(`Schema "${effectiveSchema}" is not allowed by the configured OceanBase MCP access policy.`);
      }
      const tableLimit = Math.min(maxTables ?? 30, 500);
      const rawTables = await withQuerySlot(selected, () =>
        listSchemaMapTables(
          selected.pool,
          selected.config.compatibility,
          effectiveSchema,
          tablePattern,
          tableLimit + 1,
          selected.config.queryTimeoutMs
        )
      );
      const visibleTables = filterSchemaMapTables(rawTables, selected.config).slice(0, tableLimit);
      const summaries = [];

      for (const tableInfo of visibleTables) {
        const summary = await buildSchemaMapTableSummary(
          selected,
          tableInfo,
          includeColumns,
          maxColumnsPerTable ?? 12,
          includeRelationships,
          relationshipLimit ?? 12
        );
        summaries.push(summary);
      }

      return toLimitedResult(
        {
          mode: selected.config.compatibility,
          schema: effectiveSchema,
          tablePattern: tablePattern ?? null,
          maxTables: tableLimit,
          includeColumns,
          includeRelationships,
          truncated: rawTables.length > tableLimit,
          tableCount: summaries.length,
          schemas: groupSchemaMapTables(selected.config.compatibility, summaries),
          warnings: rawTables.length > tableLimit
            ? [`Only the first ${tableLimit} visible tables are returned. Narrow schema or tablePattern for a smaller map.`]
            : []
        },
        selected.config
      );
    }
  );

  registerTool(
    "ob_get_database_dictionary",
    {
      title: "Get Database Dictionary",
      description: "Generate a bounded JSON or Markdown data dictionary from visible table and column metadata.",
      inputSchema: {
        ...profileInput,
        schema: z.string().optional(),
        tablePattern: z.string().optional(),
        format: z.enum(["json", "markdown"]).optional().default("json"),
        maxTables: z.number().int().positive().max(200).optional(),
        maxColumnsPerTable: z.number().int().positive().max(100).optional()
      }
    },
    async ({ profile, schema, tablePattern, format = "json", maxTables, maxColumnsPerTable }) => {
      const selected = selectAuthorizedProfile(runtime, profile, context);
      const effectiveSchema = metadataSchema(selected.config, schema);
      if (effectiveSchema && !isSchemaAllowed(effectiveSchema, selected.config.policy)) {
        throw new Error(`Schema "${effectiveSchema}" is not allowed by the configured OceanBase MCP access policy.`);
      }
      const tableLimit = Math.min(maxTables ?? 30, 200);
      const columnLimit = Math.min(maxColumnsPerTable ?? 50, 100);
      const rawTables = await withQuerySlot(selected, () =>
        listSchemaMapTables(
          selected.pool,
          selected.config.compatibility,
          effectiveSchema,
          tablePattern,
          tableLimit + 1,
          selected.config.queryTimeoutMs
        )
      );
      const visibleTables = filterSchemaMapTables(rawTables, selected.config).slice(0, tableLimit);
      const dictionary = await buildDatabaseDictionary(selected, visibleTables, columnLimit);
      const warnings = [];
      if (rawTables.length > tableLimit) {
        warnings.push(`Only the first ${tableLimit} visible tables are included. Narrow schema or tablePattern for a smaller dictionary.`);
      }
      if (dictionary.tables.some((table) => table.columnsTruncated)) {
        warnings.push(`Some tables have more than ${columnLimit} visible columns; columns were truncated.`);
      }
      const output = {
        format,
        mode: selected.config.compatibility,
        schema: effectiveSchema ?? null,
        tablePattern: tablePattern ?? null,
        tableCount: dictionary.tables.length,
        dictionary,
        markdown: format === "markdown" ? renderDatabaseDictionaryMarkdown(dictionary) : undefined,
        warnings
      };
      return toLimitedResult(output, selected.config);
    }
  );

  registerTool(
    "ob_compare_tables",
    {
      title: "Compare Tables",
      description: "Compare two visible tables by columns, indexes, constraints, and partitions.",
      inputSchema: {
        ...profileInput,
        leftTable: z.string().min(1),
        leftSchema: z.string().optional(),
        rightTable: z.string().min(1),
        rightSchema: z.string().optional()
      }
    },
    async ({ profile, leftTable, leftSchema, rightTable, rightSchema }) => {
      const selected = selectAuthorizedProfile(runtime, profile, context);
      const left = metadataTableRef(selected.config, leftSchema, leftTable);
      const right = metadataTableRef(selected.config, rightSchema, rightTable);
      assertTableAccess(left.schema, left.table, policyContext(selected.config));
      assertTableAccess(right.schema, right.table, policyContext(selected.config));
      const leftMetadata = await withQuerySlot(selected, () =>
        getTableDdlMetadata(selected.pool, selected.config.compatibility, left.table, left.schema, selected.config.queryTimeoutMs)
      );
      const rightMetadata = await withQuerySlot(selected, () =>
        getTableDdlMetadata(selected.pool, selected.config.compatibility, right.table, right.schema, selected.config.queryTimeoutMs)
      );

      return toLimitedResult(
        compareTableMetadata(selected.config, leftMetadata, rightMetadata),
        selected.config
      );
    }
  );

  registerTool(
    "ob_compare_schemas",
    {
      title: "Compare Schemas",
      description: "Compare two visible schemas by table list and bounded per-table metadata differences.",
      inputSchema: {
        ...profileInput,
        leftSchema: z.string().min(1),
        rightSchema: z.string().min(1),
        tablePattern: z.string().optional(),
        maxTables: z.number().int().positive().max(200).optional(),
        compareCommonTables: z.number().int().positive().max(50).optional()
      }
    },
    async ({ profile, leftSchema, rightSchema, tablePattern, maxTables, compareCommonTables }) => {
      const selected = selectAuthorizedProfile(runtime, profile, context);
      if (!isSchemaAllowed(leftSchema, selected.config.policy)) {
        throw new Error(`Schema "${leftSchema}" is not allowed by the configured OceanBase MCP access policy.`);
      }
      if (!isSchemaAllowed(rightSchema, selected.config.policy)) {
        throw new Error(`Schema "${rightSchema}" is not allowed by the configured OceanBase MCP access policy.`);
      }
      const tableLimit = Math.min(maxTables ?? 100, 200);
      const leftVisibleTables = filterSchemaMapTables(
        await withQuerySlot(selected, () =>
          listSchemaMapTables(selected.pool, selected.config.compatibility, leftSchema, tablePattern, tableLimit + 1, selected.config.queryTimeoutMs)
        ),
        selected.config
      );
      const rightVisibleTables = filterSchemaMapTables(
        await withQuerySlot(selected, () =>
          listSchemaMapTables(selected.pool, selected.config.compatibility, rightSchema, tablePattern, tableLimit + 1, selected.config.queryTimeoutMs)
        ),
        selected.config
      );
      const leftTables = leftVisibleTables.slice(0, tableLimit);
      const rightTables = rightVisibleTables.slice(0, tableLimit);
      const comparison = await compareSchemaMetadata(
        selected,
        leftSchema,
        rightSchema,
        leftTables,
        rightTables,
        Math.min(compareCommonTables ?? 20, 50)
      );
      const warnings = [...comparison.warnings];
      const leftTableListTruncated = leftVisibleTables.length > tableLimit;
      const rightTableListTruncated = rightVisibleTables.length > tableLimit;
      if (leftTableListTruncated || rightTableListTruncated) {
        warnings.push("At least one schema has more visible tables than maxTables; narrow tablePattern or raise maxTables within the configured limit.");
      }

      return toLimitedResult(
        {
          mode: selected.config.compatibility,
          leftSchema,
          rightSchema,
          tablePattern: tablePattern ?? null,
          maxTables: tableLimit,
          ...comparison,
          leftTableListTruncated,
          rightTableListTruncated,
          warnings
        },
        selected.config
      );
    }
  );

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
          selected.config.enforceReadOnlyTransaction
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
          selected.config.enforceReadOnlyTransaction
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
          selected.config.enforceReadOnlyTransaction
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

  registerTool(
    "ob_search_catalog",
    {
      title: "Search Catalog",
      description: "Search schemas, tables, columns, and comments, filtered by access policy.",
      inputSchema: {
        ...profileInput,
        query: z.string().min(1),
        schema: z.string().optional(),
        limit: z.number().int().positive().max(1000).optional()
      }
    },
    async ({ profile, query, schema, limit }) => {
      const selected = selectAuthorizedProfile(runtime, profile, context);
      if (schema) {
        assertTableAccess(schema, "*", policyContext(selected.config));
      }
      const maxResults = effectiveRowLimit(limit, selected.config);
      const rows = await withQuerySlot(selected, () =>
        searchCatalog(
          selected.pool,
          selected.config.compatibility,
          query,
          schema,
          maxResults,
          selected.config.queryTimeoutMs
        )
      );
      const catalogRows = filterColumnMetadata(rows, selected.config.policy);
      const glossary = searchBusinessGlossary(selected.config, query, maxResults, schema);
      return toLimitedResult(
        [...glossary.matches.map(glossaryCatalogRow), ...catalogRows].slice(0, maxResults),
        selected.config
      );
    }
  );

  registerTool(
    "ob_search_everything",
    {
      title: "Search OceanBase Metadata",
      description: "Search visible schemas, tables, columns, comments, and business glossary entries with confidence and evidence.",
      inputSchema: {
        ...profileInput,
        query: z.string().min(1),
        schema: z.string().optional(),
        limit: z.number().int().positive().max(500).optional(),
        includeGlossary: z.boolean().optional().default(true)
      }
    },
    async ({ profile, query, schema, limit, includeGlossary = true }) => {
      const selected = selectAuthorizedProfile(runtime, profile, context);
      if (schema) {
        assertTableAccess(schema, "*", policyContext(selected.config));
      }
      const maxResults = Math.min(limit ?? 30, 500);
      const schemaRows = filterSchemas(
        await withQuerySlot(selected, () =>
          listSchemas(selected.pool, selected.config.compatibility, selected.config.queryTimeoutMs)
        ),
        selected.config.policy
      );
      const catalogRows = filterColumnMetadata(
        await withQuerySlot(selected, () =>
          searchCatalog(
            selected.pool,
            selected.config.compatibility,
            query,
            schema,
            maxResults,
            selected.config.queryTimeoutMs
          )
        ),
        selected.config.policy
      );
      const glossary = includeGlossary
        ? searchBusinessGlossary(selected.config, query, maxResults, schema)
        : { configured: Boolean(selected.config.businessGlossary), matches: [], policyFiltered: false, warnings: [] };
      const results = dedupeSearchResults([
        ...schemaRows.flatMap((row) => schemaSearchResult(row, query, selected.config, schema)),
        ...catalogRows.flatMap((row) => catalogSearchResult(row, query, selected.config)),
        ...glossary.matches.flatMap((match) => glossarySearchResults(match, query))
      ])
        .sort((left, right) => right.confidence - left.confidence || left.type.localeCompare(right.type))
        .slice(0, maxResults);

      return toLimitedResult(
        {
          query,
          schema: schema ?? null,
          count: results.length,
          truncated: results.length >= maxResults,
          glossaryConfigured: glossary.configured,
          policyFiltered: glossary.policyFiltered,
          results,
          warnings: glossary.warnings
        },
        selected.config
      );
    }
  );

  registerTool(
    "ob_find_tables_by_business_term",
    {
      title: "Find Tables by Business Term",
      description: "Find visible candidate tables from a business term using glossary, catalog metadata, comments, and relationship evidence.",
      inputSchema: {
        ...profileInput,
        term: z.string().min(1),
        schema: z.string().optional(),
        limit: z.number().int().positive().max(100).optional(),
        includeRelated: z.boolean().optional().default(true),
        relationshipLimit: z.number().int().positive().max(50).optional()
      }
    },
    async ({ profile, term, schema, limit, includeRelated = true, relationshipLimit }) => {
      const selected = selectAuthorizedProfile(runtime, profile, context);
      if (schema) {
        assertTableAccess(schema, "*", policyContext(selected.config));
      }
      const maxResults = Math.min(limit ?? 20, 100);
      const catalogRows = filterColumnMetadata(
        await withQuerySlot(selected, () =>
          searchCatalog(
            selected.pool,
            selected.config.compatibility,
            term,
            schema,
            maxResults,
            selected.config.queryTimeoutMs
          )
        ),
        selected.config.policy
      );
      const glossary = searchBusinessGlossary(selected.config, term, maxResults, schema);
      const searchResults = dedupeSearchResults([
        ...catalogRows.flatMap((row) => catalogSearchResult(row, term, selected.config)),
        ...glossary.matches.flatMap((match) => glossarySearchResults(match, term))
      ]);
      const candidates = tableCandidatesFromSearchResults(searchResults, selected.config, maxResults);
      if (includeRelated) {
        await attachRelatedTablesToCandidates(
          selected,
          candidates,
          Math.min(relationshipLimit ?? 8, 50)
        );
      }

      return toLimitedResult(
        {
          term,
          schema: schema ?? null,
          count: candidates.length,
          glossaryConfigured: glossary.configured,
          policyFiltered: glossary.policyFiltered,
          candidates,
          warnings: glossary.warnings
        },
        selected.config
      );
    }
  );

  registerTool(
    "ob_find_columns",
    {
      title: "Find Columns",
      description: "Find visible columns across tables by name, comment, data type, table pattern, or business term.",
      inputSchema: {
        ...profileInput,
        query: z.string().optional(),
        schema: z.string().optional(),
        tablePattern: z.string().optional(),
        dataType: z.string().optional(),
        limit: z.number().int().positive().max(500).optional(),
        includeGlossary: z.boolean().optional().default(true)
      }
    },
    async ({ profile, query, schema, tablePattern, dataType, limit, includeGlossary = true }) => {
      const selected = selectAuthorizedProfile(runtime, profile, context);
      const effectiveSchema = metadataSchema(selected.config, schema);
      if (effectiveSchema && !isSchemaAllowed(effectiveSchema, selected.config.policy)) {
        throw new Error(`Schema "${effectiveSchema}" is not allowed by the configured OceanBase MCP access policy.`);
      }
      const maxResults = Math.min(limit ?? 50, 500);
      const rows = filterColumnMetadata(
        await withQuerySlot(selected, () =>
          findColumns(
            selected.pool,
            selected.config.compatibility,
            { query, schema: effectiveSchema, tablePattern, dataType },
            maxResults,
            selected.config.queryTimeoutMs
          )
        ),
        selected.config.policy
      );
      const columns = rows.flatMap((row) =>
        columnSearchRows(row, query, dataType, selected.config)
      );
      const glossary = includeGlossary && query
        ? searchBusinessGlossary(selected.config, query, maxResults, effectiveSchema)
        : { configured: Boolean(selected.config.businessGlossary), matches: [], policyFiltered: false, warnings: [] };
      const glossaryColumns = glossary.matches.flatMap((match) =>
        glossaryColumnRows(match, query ?? "", selected.config)
      );
      const results = dedupeColumnSearchResults([...columns, ...glossaryColumns])
        .sort((left, right) => right.confidence - left.confidence || left.column.localeCompare(right.column))
        .slice(0, maxResults);

      return toLimitedResult(
        {
          query: query ?? null,
          schema: effectiveSchema ?? null,
          tablePattern: tablePattern ?? null,
          dataType: dataType ?? null,
          count: results.length,
          truncated: rows.length >= maxResults,
          glossaryConfigured: glossary.configured,
          policyFiltered: glossary.policyFiltered,
          columns: results,
          warnings: glossary.warnings
        },
        selected.config
      );
    }
  );

  registerTool(
    "ob_search_business_glossary",
    {
      title: "Search Business Glossary",
      description: "Search optional business terms mapped to allowed OceanBase schemas, tables, and columns.",
      inputSchema: {
        ...profileInput,
        query: z.string().min(1),
        schema: z.string().optional(),
        limit: z.number().int().positive().max(500).optional()
      }
    },
    async ({ profile, query, schema, limit }) => {
      const selected = selectAuthorizedProfile(runtime, profile, context);
      if (schema) {
        assertTableAccess(schema, "*", policyContext(selected.config));
      }
      return toLimitedResult(
        searchBusinessGlossary(selected.config, query, Math.min(limit ?? 20, 500), schema),
        selected.config
      );
    }
  );

  registerTool(
    "ob_list_objects",
    {
      title: "List Oracle Objects",
      description: "List policy-filtered Oracle object metadata such as views, sequences, synonyms, procedures, functions, and packages.",
      inputSchema: {
        ...profileInput,
        schema: z.string().optional(),
        query: z.string().optional(),
        objectTypes: z.array(oracleObjectTypeSchema).optional(),
        limit: z.number().int().positive().max(500).optional()
      }
    },
    async ({ profile, schema, query, objectTypes, limit }) => {
      const selected = selectAuthorizedProfile(runtime, profile, context);
      const effectiveSchema = metadataSchema(selected.config, schema);
      if (effectiveSchema && !isSchemaAllowed(effectiveSchema, selected.config.policy)) {
        throw new Error(`Schema "${effectiveSchema}" is not allowed by the configured OceanBase MCP access policy.`);
      }
      const result = await withQuerySlot(selected, () =>
        listObjects(
          selected.pool,
          selected.config.compatibility,
          effectiveSchema,
          query,
          objectTypes,
          effectiveRowLimit(limit, selected.config),
          selected.config.queryTimeoutMs
        )
      );
      const objects = filterObjects(result.objects, selected.config.policy);
      return toLimitedResult(
        {
          ...result,
          objects,
          policyFiltered: objects.length !== result.objects.length
        },
        selected.config
      );
    }
  );

  registerTool(
    "ob_get_object_metadata",
    {
      title: "Get Oracle Object Metadata",
      description: "Return bounded, policy-filtered metadata for one Oracle view, sequence, synonym, procedure, function, or package.",
      inputSchema: {
        ...profileInput,
        schema: z.string().optional(),
        objectName: z.string().min(1),
        objectType: oracleObjectTypeSchema
      }
    },
    async ({ profile, schema, objectName, objectType }) => {
      const selected = selectAuthorizedProfile(runtime, profile, context);
      const effectiveSchema = metadataSchema(selected.config, schema);
      assertObjectAccess(effectiveSchema, objectName, policyContext(selected.config));
      const metadata = await withQuerySlot(selected, () =>
        getObjectMetadata(
          selected.pool,
          selected.config.compatibility,
          objectName,
          objectType,
          effectiveSchema,
          selected.config.queryTimeoutMs
        )
      );
      return toLimitedResult(sanitizeObjectMetadata(metadata, selected.config), selected.config);
    }
  );

  registerTool(
    "ob_get_table_schema",
    {
      title: "Get Table Schema",
      description: "Return policy-filtered table columns and types for one table.",
      inputSchema: {
        ...profileInput,
        table: z.string().min(1),
        schema: z.string().optional()
      }
    },
    async ({ profile, table, schema }) => {
      const selected = selectAuthorizedProfile(runtime, profile, context);
      const effectiveSchema = metadataSchema(selected.config, schema);
      assertTableAccess(effectiveSchema, table, policyContext(selected.config));
      const rows = await withQuerySlot(selected, () =>
        describeTable(selected.pool, selected.config.compatibility, table, effectiveSchema, selected.config.queryTimeoutMs)
      );
      return toLimitedResult(filterColumnMetadata(rows, selected.config.policy), selected.config);
    }
  );

  registerTool(
    "ob_get_table_ddl",
    {
      title: "Get Table DDL",
      description: "Return native or structured DDL metadata for an allowed OceanBase table.",
      inputSchema: {
        ...profileInput,
        table: z.string().min(1),
        schema: z.string().optional()
      }
    },
    async ({ profile, table, schema }) => {
      const selected = selectAuthorizedProfile(runtime, profile, context);
      const effectiveSchema = metadataSchema(selected.config, schema);
      assertTableAccess(effectiveSchema, table, policyContext(selected.config));
      const metadata = await withQuerySlot(selected, () =>
        getTableDdlMetadata(selected.pool, selected.config.compatibility, table, effectiveSchema, selected.config.queryTimeoutMs)
      );
      const columns = filterColumnMetadata(metadata.columns, selected.config.policy);
      const indexes = filterColumnMetadata(metadata.indexes, selected.config.policy);
      const constraints = filterColumnMetadata(metadata.constraints, selected.config.policy);
      const partitions = filterTables(metadata.partitions, selected.config.policy);
      const policyFiltered =
        columns.length !== metadata.columns.length ||
        indexes.length !== metadata.indexes.length ||
        constraints.length !== metadata.constraints.length ||
        partitions.length !== metadata.partitions.length;
      const ddl =
        metadata.nativeDdl && !policyFiltered
          ? metadata.nativeDdl
          : renderStructuredTableDdl(selected.config.compatibility, metadata.schema, metadata.table, columns, indexes, constraints, partitions);

      return toLimitedResult(
        {
          mode: metadata.mode,
          schema: metadata.schema,
          table: metadata.table,
          source: metadata.nativeDdl && !policyFiltered ? "native" : "structured",
          policyFiltered,
          ddl,
          columns,
          indexes,
          constraints,
          partitions,
          warnings: policyFiltered
            ? [...metadata.warnings, "DDL was rendered from policy-filtered metadata because one or more metadata rows were hidden."]
            : metadata.warnings
        },
        selected.config
      );
    }
  );

  registerTool(
    "ob_get_table_context",
    {
      title: "Get Table Context",
      description: "Return the common read-only table context needed for SQL drafting and data inspection.",
      inputSchema: {
        ...profileInput,
        table: z.string().min(1),
        schema: z.string().optional(),
        includeSample: z.boolean().optional().default(true),
        includeRelated: z.boolean().optional().default(true),
        includeTemplates: z.boolean().optional().default(true),
        sampleLimit: z.number().int().positive().max(20).optional(),
        relationshipLimit: z.number().int().positive().max(100).optional(),
        maxTemplateColumns: z.number().int().min(1).max(50).optional()
      }
    },
    async ({
      profile,
      table,
      schema,
      includeSample = true,
      includeRelated = true,
      includeTemplates = true,
      sampleLimit,
      relationshipLimit,
      maxTemplateColumns
    }) => {
      const selected = selectAuthorizedProfile(runtime, profile, context);
      const effectiveSchema = metadataSchema(selected.config, schema);
      assertTableAccess(effectiveSchema, table, policyContext(selected.config));

      const metadata = await withQuerySlot(selected, () =>
        getTableDdlMetadata(selected.pool, selected.config.compatibility, table, effectiveSchema, selected.config.queryTimeoutMs)
      );
      const columns = filterColumnMetadata(metadata.columns, selected.config.policy);
      const indexes = filterColumnMetadata(metadata.indexes, selected.config.policy);
      const constraints = filterColumnMetadata(metadata.constraints, selected.config.policy);
      const partitions = filterTables(metadata.partitions, selected.config.policy);
      const policyFiltered =
        columns.length !== metadata.columns.length ||
        indexes.length !== metadata.indexes.length ||
        constraints.length !== metadata.constraints.length ||
        partitions.length !== metadata.partitions.length;
      const ddl =
        metadata.nativeDdl && !policyFiltered
          ? metadata.nativeDdl
          : renderStructuredTableDdl(selected.config.compatibility, metadata.schema, metadata.table, columns, indexes, constraints, partitions);
      const warnings = [...metadata.warnings];
      if (policyFiltered) {
        warnings.push("Some metadata rows were hidden by policy.");
      }

      const statistics = await withQuerySlot(selected, () =>
        getTableStats(selected.pool, selected.config.compatibility, table, effectiveSchema, selected.config.queryTimeoutMs)
      );

      let relatedTables: { relations: TableRelationship[]; policyFiltered: boolean } | undefined;
      let relationships: TableRelationship[] = [];
      if (includeRelated) {
        const result = await withQuerySlot(selected, () =>
          findRelatedTables(
            selected.pool,
            selected.config.compatibility,
            table,
            effectiveSchema,
            1,
            Math.min(relationshipLimit ?? 20, 100),
            selected.config.queryTimeoutMs
          )
        );
        relationships = result.relations.filter((relation) => isRelationshipAllowed(relation, selected.config));
        relatedTables = {
          relations: relationships,
          policyFiltered: relationships.length !== result.relations.length
        };
      }

      let queryTemplates:
        | {
            templates: ReturnType<typeof generateQueryTemplates>["templates"];
            warnings: string[];
            executed: false;
          }
        | undefined;
      if (includeTemplates) {
        const generated = generateQueryTemplates({
          mode: selected.config.compatibility,
          schema: effectiveSchema,
          table,
          columns,
          constraints,
          relationships,
          maxColumns: maxTemplateColumns ?? 12,
          rowLimit: effectiveRowLimit(undefined, selected.config)
        });
        queryTemplates = {
          templates: generated.templates.map((template) => ({
            ...template,
            policy: explainGeneratedQuery(template.sql, template.parameters.length, selected.config)
          })),
          warnings: generated.warnings,
          executed: false
        };
      }

      let sample: QueryOutput | undefined;
      if (includeSample) {
        const sampleColumns = columnNames(columns).slice(0, 50);
        if (sampleColumns.length === 0) {
          warnings.push("Sample rows were skipped because no visible columns are available.");
        } else {
          const output = await withQuerySlot(selected, () =>
            sampleRows(
              selected.pool,
              selected.config.compatibility,
              effectiveSchema,
              table,
              sampleColumns,
              Math.min(sampleLimit ?? 3, selected.config.maxRows, 20),
              selected.config.queryTimeoutMs
            )
          );
          assertOutputAllowed(output, selected.config.policy);
          sample = maskOutput(output, selected.config, effectiveSchema, table);
        }
      }

      return toLimitedResult(
        {
          mode: selected.config.compatibility,
          schema: metadata.schema,
          table: metadata.table,
          ddl: {
            source: metadata.nativeDdl && !policyFiltered ? "native" : "structured",
            policyFiltered,
            text: ddl
          },
          columns,
          indexes,
          constraints,
          partitions,
          statistics,
          relatedTables,
          queryTemplates,
          sample,
          warnings
        },
        selected.config
      );
    }
  );

  registerTool(
    "ob_get_table_summary",
    {
      title: "Get Table Summary",
      description: "Return a compact table summary with inferred purpose, key fields, relationship hints, and query entry points.",
      inputSchema: {
        ...profileInput,
        table: z.string().min(1),
        schema: z.string().optional(),
        includeRelated: z.boolean().optional().default(true),
        relationshipLimit: z.number().int().positive().max(50).optional(),
        maxColumns: z.number().int().positive().max(100).optional()
      }
    },
    async ({ profile, table, schema, includeRelated = true, relationshipLimit, maxColumns }) => {
      const selected = selectAuthorizedProfile(runtime, profile, context);
      const effectiveSchema = metadataSchema(selected.config, schema);
      assertTableAccess(effectiveSchema, table, policyContext(selected.config));
      const metadata = await withQuerySlot(selected, () =>
        getTableDdlMetadata(selected.pool, selected.config.compatibility, table, effectiveSchema, selected.config.queryTimeoutMs)
      );
      const columns = filterColumnMetadata(metadata.columns, selected.config.policy);
      const constraints = filterColumnMetadata(metadata.constraints, selected.config.policy);
      const compactColumns = compactSchemaColumns(columns, constraints, selected.config, metadata.schema, metadata.table);
      const primaryKeys = schemaMapPrimaryKeyColumns(constraints);
      const uniqueKeys = uniqueKeyGroups(constraints);
      const timeFields = compactColumns.filter((column) => column.roles.includes("time")).map((column) => column.name);
      const statusFields = compactColumns.filter((column) => column.roles.includes("status")).map((column) => column.name);
      const keyFields = importantSchemaMapFields(compactColumns, primaryKeys, timeFields, statusFields);
      const tableInfo = await findSchemaMapTableInfo(selected, metadata.schema, metadata.table);
      const statistics = await withQuerySlot(selected, () =>
        getTableStats(selected.pool, selected.config.compatibility, metadata.table, metadata.schema, selected.config.queryTimeoutMs)
      );
      const relationSummary = includeRelated
        ? await buildSchemaMapRelationshipSummary(selected, metadata.schema, metadata.table, Math.min(relationshipLimit ?? 10, 50))
        : undefined;

      return toLimitedResult(
        {
          mode: selected.config.compatibility,
          schema: metadata.schema,
          table: metadata.table,
          purpose: inferTablePurpose(metadata.table, tableInfo?.comment, compactColumns),
          rowEstimate: tableInfo?.rowEstimate ?? statistics.rowEstimate,
          statistics,
          primaryKeys,
          uniqueKeys,
          keyFields,
          timeFields,
          statusFields,
          columns: compactColumns.slice(0, Math.min(maxColumns ?? 20, 100)),
          columnsTruncated: compactColumns.length > Math.min(maxColumns ?? 20, 100),
          relatedTables: relationSummary,
          queryEntryPoints: tableSummaryQueryEntryPoints(primaryKeys, timeFields, statusFields, relationSummary),
          warnings: [
            "Purpose and field roles are inferred from visible metadata; verify with domain knowledge before using them as business facts."
          ]
        },
        selected.config
      );
    }
  );

  registerTool(
    "ob_profile_columns",
    {
      title: "Profile Table Columns",
      description: "Return bounded, policy-filtered column profiles for an allowed OceanBase table.",
      inputSchema: {
        ...profileInput,
        table: z.string().min(1),
        schema: z.string().optional(),
        columns: z.array(z.string().min(1)).max(50).optional(),
        rowLimit: z.number().int().positive().max(10_000).optional(),
        maxColumns: z.number().int().positive().max(50).optional(),
        topValues: z.number().int().positive().max(20).optional(),
        sampleValues: z.number().int().positive().max(20).optional()
      }
    },
    async ({ profile, table, schema, columns, rowLimit, maxColumns, topValues, sampleValues }) => {
      const selected = selectAuthorizedProfile(runtime, profile, context);
      const effectiveSchema = metadataSchema(selected.config, schema);
      assertTableAccess(effectiveSchema, table, policyContext(selected.config));
      const metadataRows = await withQuerySlot(selected, () =>
        describeTable(selected.pool, selected.config.compatibility, table, effectiveSchema, selected.config.queryTimeoutMs)
      );
      const visibleColumns = filterColumnMetadata(metadataRows, selected.config.policy);
      const selectedColumns = selectProfileColumns(
        visibleColumns,
        selected.config.compatibility,
        columns,
        maxColumns ?? 10
      );
      const profileRowLimit = Math.min(effectiveRowLimit(rowLimit, selected.config), 10_000);
      const effectiveTopLimit = Math.min(topValues ?? 5, 20);
      const effectiveSampleLimit = Math.min(sampleValues ?? 5, 20);
      const stats = await withQuerySlot(selected, () =>
        getTableStats(selected.pool, selected.config.compatibility, table, effectiveSchema, selected.config.queryTimeoutMs)
      );
      const result = await withQuerySlot(selected, () =>
        profileColumns(
          selected.pool,
          selected.config.compatibility,
          effectiveSchema,
          table,
          selectedColumns.map((column) => ({
            name: column.name,
            dataType: column.dataType
          })),
          profileRowLimit,
          effectiveTopLimit,
          effectiveSampleLimit,
          selected.config.queryTimeoutMs
        )
      );
      const warnings = profileWarnings(result.warnings, stats.rowEstimate?.value, profileRowLimit, selectedColumns.length, visibleColumns.length);
      return toLimitedResult(
        maskColumnProfileResult(
          {
            ...result,
            requestedColumns: columns?.length ? columns : undefined,
            tableRowEstimate: stats.rowEstimate,
            columns: result.columns.map((profileResult) => {
              const metadata = selectedColumns.find((column) => sameColumnName(selected.config.compatibility, column.name, profileResult.column));
              return {
                ...profileResult,
                dataType: metadata?.dataType,
                nullable: metadata?.nullable,
                comment: metadata?.comment,
                masked: shouldMaskColumnValue(profileResult.column, selected.config, result.schema, result.table)
              };
            }),
            warnings
          },
          selected.config,
          result.schema,
          result.table
        ),
        selected.config
      );
    }
  );

  registerTool(
    "ob_find_related_tables",
    {
      title: "Find Related Tables",
      description: "Find foreign-key and conservative naming-based relationships for an allowed OceanBase table.",
      inputSchema: {
        ...profileInput,
        table: z.string().min(1),
        schema: z.string().optional(),
        depth: z.number().int().min(1).max(3).optional(),
        limit: z.number().int().positive().max(500).optional()
      }
    },
    async ({ profile, table, schema, depth, limit }) => {
      const selected = selectAuthorizedProfile(runtime, profile, context);
      const effectiveSchema = metadataSchema(selected.config, schema);
      assertTableAccess(effectiveSchema, table, policyContext(selected.config));
      const maxRelations = Math.min(limit ?? 50, 500);
      const result = await withQuerySlot(selected, () =>
        findRelatedTables(
          selected.pool,
          selected.config.compatibility,
          table,
          effectiveSchema,
          depth ?? 1,
          maxRelations,
          selected.config.queryTimeoutMs
        )
      );
      const relations = result.relations.filter((relation) => isRelationshipAllowed(relation, selected.config));
      return toLimitedResult(
        {
          ...result,
          relations,
          policyFiltered: relations.length !== result.relations.length
        },
        selected.config
      );
    }
  );

  registerTool(
    "ob_get_table_stats",
    {
      title: "Get Table Statistics",
      description: "Return table-level optimizer statistics and metadata counts for an allowed OceanBase table.",
      inputSchema: {
        ...profileInput,
        table: z.string().min(1),
        schema: z.string().optional()
      }
    },
    async ({ profile, table, schema }) => {
      const selected = selectAuthorizedProfile(runtime, profile, context);
      const effectiveSchema = metadataSchema(selected.config, schema);
      assertTableAccess(effectiveSchema, table, policyContext(selected.config));
      const stats = await withQuerySlot(selected, () =>
        getTableStats(selected.pool, selected.config.compatibility, table, effectiveSchema, selected.config.queryTimeoutMs)
      );
      return toLimitedResult(stats, selected.config);
    }
  );

  registerTool(
    "ob_prepare_query",
    {
      title: "Prepare Read-only Query",
      description: "Prepare candidate tables, fields, read-only SQL drafts, and safety previews from visible metadata without executing the target query.",
      inputSchema: {
        ...profileInput,
        question: z.string().min(1),
        businessTerm: z.string().optional(),
        schema: z.string().optional(),
        table: z.string().optional(),
        maxCandidates: z.number().int().positive().max(20).optional(),
        maxColumns: z.number().int().positive().max(50).optional(),
        maxRows: z.number().int().positive().optional()
      }
    },
    async ({ profile, question, businessTerm, schema, table, maxCandidates, maxColumns, maxRows }) => {
      const selected = selectAuthorizedProfile(runtime, profile, context);
      const effectiveSchema = metadataSchema(selected.config, schema);
      if (effectiveSchema && !isSchemaAllowed(effectiveSchema, selected.config.policy)) {
        throw new Error(`Schema "${effectiveSchema}" is not allowed by the configured OceanBase MCP access policy.`);
      }
      const candidateLimit = Math.min(maxCandidates ?? 5, 20);
      const searchTerms = prepareQuerySearchTerms(question, businessTerm, table);
      const warnings: string[] = [];
      const candidates = table
        ? explicitPrepareQueryCandidate(selected.config, effectiveSchema, table)
        : await findPrepareQueryCandidates(selected, searchTerms, effectiveSchema, candidateLimit, warnings);
      const preparedCandidates = [];
      for (const candidate of candidates.slice(0, candidateLimit)) {
        preparedCandidates.push(await buildPreparedQueryCandidate(
          selected,
          candidate,
          question,
          maxColumns ?? 12,
          effectiveRowLimit(maxRows, selected.config)
        ));
      }
      if (preparedCandidates.length === 0) {
        warnings.push("No visible candidate table was found from the supplied question or business term. Search metadata first or pass schema and table explicitly.");
      }

      return toLimitedResult(
        {
          mode: selected.config.compatibility,
          question,
          businessTerm: businessTerm ?? null,
          schema: effectiveSchema ?? null,
          table: table ?? null,
          searchTerms,
          candidateCount: preparedCandidates.length,
          candidates: preparedCandidates,
          workflow: [
            "Review candidate evidence before using a SQL draft.",
            "Run ob_query_preview before executing a query.",
            "Use ob_query_page for data inspection when paging is needed."
          ],
          executed: false,
          warnings: uniqueStrings(warnings)
        },
        selected.config
      );
    }
  );

  registerTool(
    "ob_explain_error",
    {
      title: "Explain SQL Error",
      description: "Explain a SQL error with policy context and visible metadata hints without executing the SQL.",
      inputSchema: {
        ...profileInput,
        sql: z.string().min(1),
        errorMessage: z.string().min(1),
        schema: z.string().optional(),
        limit: z.number().int().positive().max(100).optional()
      }
    },
    async ({ profile, sql, errorMessage, schema, limit }) => {
      const selected = selectAuthorizedProfile(runtime, profile, context);
      const effectiveSchema = metadataSchema(selected.config, schema);
      if (effectiveSchema && !isSchemaAllowed(effectiveSchema, selected.config.policy)) {
        throw new Error(`Schema "${effectiveSchema}" is not allowed by the configured OceanBase MCP access policy.`);
      }
      const explanation = await explainSqlErrorWithMetadata(
        selected,
        sql,
        errorMessage,
        effectiveSchema,
        Math.min(limit ?? 20, 100)
      );
      return toLimitedResult(explanation, selected.config);
    }
  );

  registerTool(
    "ob_convert_sql_dialect",
    {
      title: "Convert SQL Dialect",
      description: "Convert read-only SQL between OceanBase MySQL and Oracle modes with documented limitations.",
      inputSchema: {
        ...profileInput,
        sql: z.string().min(1),
        targetMode: compatibilityModeSchema,
        sourceMode: compatibilityModeSchema.optional()
      }
    },
    async ({ profile, sql, targetMode, sourceMode }) => {
      const selected = selectAuthorizedProfile(runtime, profile, context);
      const converted = convertSqlDialect(selected.config, sql, sourceMode ?? selected.config.compatibility, targetMode);
      return toLimitedResult(converted, selected.config);
    }
  );

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

  registerTool(
    "ob_lint_sql",
    {
      title: "Lint SQL",
      description: "Lint read-only SQL for policy, dialect, pagination, ordering, sensitive fields, and optional EXPLAIN risk without returning data.",
      inputSchema: {
        ...profileInput,
        sql: z.string().min(1),
        params: z.array(sqlParamSchema).optional().default([]),
        maxRows: z.number().int().positive().max(10_000).optional(),
        runExplain: z.boolean().optional().default(true)
      }
    },
    async ({ profile, sql, params = [], maxRows, runExplain = true }) => {
      const selected = selectAuthorizedProfile(runtime, profile, context);
      const sqlParams = params as SqlParam[];
      const lint = await lintReadOnlySql(selected, sql, sqlParams, effectiveRowLimit(maxRows, selected.config), runExplain);
      return toLimitedResult(lint, selected.config);
    }
  );

  registerTool(
    "ob_build_select",
    {
      title: "Build SELECT",
      description: "Build a parameterized read-only SELECT from validated table, columns, filters, ordering, and pagination without executing it.",
      inputSchema: {
        ...profileInput,
        schema: z.string().optional(),
        table: z.string().min(1),
        columns: z.array(z.string().min(1)).min(1).max(100).optional(),
        filters: z.array(buildSelectFilterSchema).max(50).optional(),
        orderBy: z.array(buildSelectOrderBySchema).max(20).optional(),
        pageSize: z.number().int().positive().max(10_000).optional(),
        page: z.number().int().positive().max(100_000).optional()
      }
    },
    async ({ profile, schema, table, columns, filters, orderBy, pageSize, page }) => {
      const selected = selectAuthorizedProfile(runtime, profile, context);
      const effectiveSchema = metadataSchema(selected.config, schema);
      const normalizedTable = selected.config.compatibility === "oracle" ? table.trim().toUpperCase() : table.trim();
      assertTableAccess(effectiveSchema, normalizedTable, policyContext(selected.config));
      const rows = filterColumnMetadata(
        await withQuerySlot(selected, () =>
          describeTable(selected.pool, selected.config.compatibility, normalizedTable, effectiveSchema, selected.config.queryTimeoutMs)
        ),
        selected.config.policy
      );
      const built = buildStructuredSelect(
        selected.config,
        effectiveSchema,
        normalizedTable,
        rows,
        {
          columns,
          filters: filters ?? [],
          orderBy: orderBy ?? [],
          pageSize,
          page
        }
      );

      return toLimitedResult(
        {
          mode: selected.config.compatibility,
          schema: effectiveSchema ?? null,
          table: normalizedTable,
          ...built,
          executed: false
        },
        selected.config
      );
    }
  );

  registerTool(
    "ob_generate_query",
    {
      title: "Generate Read-only Query Templates",
      description: "Generate read-only SQL templates from policy-filtered table metadata without executing them.",
      inputSchema: {
        ...profileInput,
        table: z.string().min(1),
        schema: z.string().optional(),
        scenarios: z.array(queryScenarioSchema).optional(),
        maxColumns: z.number().int().min(1).max(50).optional(),
        maxRows: z.number().int().positive().optional()
      }
    },
    async ({ profile, table, schema, scenarios, maxColumns, maxRows }) => {
      const selected = selectAuthorizedProfile(runtime, profile, context);
      const effectiveSchema = metadataSchema(selected.config, schema);
      assertTableAccess(effectiveSchema, table, policyContext(selected.config));
      const columns = filterColumnMetadata(
        await withQuerySlot(selected, () =>
          describeTable(selected.pool, selected.config.compatibility, table, effectiveSchema, selected.config.queryTimeoutMs)
        ),
        selected.config.policy
      );
      const constraints = filterColumnMetadata(
        await withQuerySlot(selected, () =>
          listConstraints(selected.pool, selected.config.compatibility, table, effectiveSchema, selected.config.queryTimeoutMs)
        ),
        selected.config.policy
      );
      const requestedScenarios = scenarios as QueryTemplateScenario[] | undefined;
      const relationships = !requestedScenarios || requestedScenarios.includes("join")
        ? (await withQuerySlot(selected, () =>
            findRelatedTables(selected.pool, selected.config.compatibility, table, effectiveSchema, 1, 20, selected.config.queryTimeoutMs)
          )).relations.filter((relation) =>
            isRelationshipAllowed(relation, selected.config) &&
            relation.sourceColumns.every((column) => !isDeniedColumn(column, selected.config.policy)) &&
            relation.targetColumns.every((column) => !isDeniedColumn(column, selected.config.policy))
          )
        : [];
      const generated = generateQueryTemplates({
        mode: selected.config.compatibility,
        schema: effectiveSchema,
        table,
        columns,
        constraints,
        relationships,
        scenarios: requestedScenarios,
        maxColumns: maxColumns ?? 12,
        rowLimit: effectiveRowLimit(maxRows, selected.config)
      });
      const templates = generated.templates.map((template) => ({
        ...template,
        policy: explainGeneratedQuery(template.sql, template.parameters.length, selected.config)
      }));
      return toLimitedResult(
        {
          mode: selected.config.compatibility,
          schema: effectiveSchema,
          table,
          templates,
          warnings: generated.warnings,
          executed: false
        },
        selected.config
      );
    }
  );

  registerTool(
    "ob_generate_query_examples",
    {
      title: "Generate Query Examples",
      description: "Generate scenario-based read-only SQL examples from policy-filtered table metadata without executing them.",
      inputSchema: {
        ...profileInput,
        table: z.string().min(1),
        schema: z.string().optional(),
        scenarios: z.array(queryScenarioSchema).optional(),
        maxColumns: z.number().int().min(1).max(50).optional(),
        maxRows: z.number().int().positive().optional()
      }
    },
    async ({ profile, table, schema, scenarios, maxColumns, maxRows }) => {
      const selected = selectAuthorizedProfile(runtime, profile, context);
      const effectiveSchema = metadataSchema(selected.config, schema);
      assertTableAccess(effectiveSchema, table, policyContext(selected.config));
      const columns = filterColumnMetadata(
        await withQuerySlot(selected, () =>
          describeTable(selected.pool, selected.config.compatibility, table, effectiveSchema, selected.config.queryTimeoutMs)
        ),
        selected.config.policy
      );
      const constraints = filterColumnMetadata(
        await withQuerySlot(selected, () =>
          listConstraints(selected.pool, selected.config.compatibility, table, effectiveSchema, selected.config.queryTimeoutMs)
        ),
        selected.config.policy
      );
      const requestedScenarios = scenarios as QueryTemplateScenario[] | undefined;
      const relationships = !requestedScenarios || requestedScenarios.includes("join")
        ? (await withQuerySlot(selected, () =>
            findRelatedTables(selected.pool, selected.config.compatibility, table, effectiveSchema, 1, 20, selected.config.queryTimeoutMs)
          )).relations.filter((relation) =>
            isRelationshipAllowed(relation, selected.config) &&
            relation.sourceColumns.every((column) => !isDeniedColumn(column, selected.config.policy)) &&
            relation.targetColumns.every((column) => !isDeniedColumn(column, selected.config.policy))
          )
        : [];
      const generated = generateQueryTemplates({
        mode: selected.config.compatibility,
        schema: effectiveSchema,
        table,
        columns,
        constraints,
        relationships,
        scenarios: requestedScenarios,
        maxColumns: maxColumns ?? 12,
        rowLimit: effectiveRowLimit(maxRows, selected.config)
      });
      const examples = generated.templates.map((template) =>
        queryExampleFromTemplate(template, selected.config)
      );
      return toLimitedResult(
        {
          mode: selected.config.compatibility,
          schema: effectiveSchema,
          table,
          rowLimit: effectiveRowLimit(maxRows, selected.config),
          examples,
          warnings: generated.warnings,
          executed: false
        },
        selected.config
      );
    }
  );

  registerTool(
    "ob_generate_er_diagram",
    {
      title: "Generate ER Diagram",
      description: "Generate Mermaid and JSON ER metadata from allowed OceanBase table metadata and relationships.",
      inputSchema: {
        ...profileInput,
        schema: z.string().optional(),
        table: z.string().optional(),
        depth: z.number().int().min(1).max(3).optional(),
        maxTables: z.number().int().positive().max(50).optional()
      }
    },
    async ({ profile, schema, table, depth, maxTables }) => {
      const selected = selectAuthorizedProfile(runtime, profile, context);
      const effectiveSchema = metadataSchema(selected.config, schema);
      const tableLimit = Math.min(maxTables ?? (table ? 20 : 12), 50);
      const depthLimit = depth ?? 1;
      if (table) {
        assertTableAccess(effectiveSchema, table, policyContext(selected.config));
      } else if (!effectiveSchema) {
        throw new Error("Pass schema or table when generating an ER diagram without a configured default schema.");
      }

      const refs = new Map<string, { schema?: string; table: string }>();
      const relationships: TableRelationship[] = [];
      if (table) {
        addTableRef(refs, selected.config.compatibility, effectiveSchema, table, tableLimit);
        const result = await withQuerySlot(selected, () =>
          findRelatedTables(
            selected.pool,
            selected.config.compatibility,
            table,
            effectiveSchema,
            depthLimit,
            tableLimit * 4,
            selected.config.queryTimeoutMs
          )
        );
        for (const relation of result.relations.filter((item) =>
          isRelationshipAllowed(item, selected.config)
        )) {
          relationships.push(relation);
          addTableRef(refs, selected.config.compatibility, relation.sourceSchema, relation.sourceTable, tableLimit);
          addTableRef(refs, selected.config.compatibility, relation.targetSchema, relation.targetTable, tableLimit);
        }
      } else {
        const rows = filterTables(
          await withQuerySlot(selected, () =>
            listTables(
              selected.pool,
              selected.config.compatibility,
              effectiveSchema,
              tableLimit,
              selected.config.queryTimeoutMs
            )
          ),
          selected.config.policy
        );
        for (const row of rows) {
          const ref = tableRefFromMetadata(row, effectiveSchema);
          if (ref) {
            addTableRef(refs, selected.config.compatibility, ref.schema, ref.table, tableLimit);
          }
        }
        for (const ref of refs.values()) {
          const result = await withQuerySlot(selected, () =>
            findRelatedTables(
              selected.pool,
              selected.config.compatibility,
              ref.table,
              ref.schema,
              1,
              tableLimit * 4,
              selected.config.queryTimeoutMs
            )
          );
          for (const relation of result.relations.filter((item) =>
            isRelationshipAllowed(item, selected.config)
          )) {
            relationships.push(relation);
          }
        }
      }

      const entities: ErEntity[] = [];
      for (const ref of refs.values()) {
        const columns = filterColumnMetadata(
          await withQuerySlot(selected, () =>
            describeTable(
              selected.pool,
              selected.config.compatibility,
              ref.table,
              ref.schema,
              selected.config.queryTimeoutMs
            )
          ),
          selected.config.policy
        );
        const constraints = filterColumnMetadata(
          await withQuerySlot(selected, () =>
            listConstraints(
              selected.pool,
              selected.config.compatibility,
              ref.table,
              ref.schema,
              selected.config.queryTimeoutMs
            )
          ),
          selected.config.policy
        );
        entities.push(erEntityFromMetadata(selected.config.compatibility, ref.schema, ref.table, columns, constraints));
      }

      const entityKeys = new Set(
        [...refs.values()].map((ref) => tableRefKey(selected.config.compatibility, ref.schema, ref.table))
      );
      const diagramRelationships = dedupeRelationships(selected.config.compatibility, relationships).filter(
        (relation) =>
          entityKeys.has(tableRefKey(selected.config.compatibility, relation.sourceSchema, relation.sourceTable)) &&
          entityKeys.has(tableRefKey(selected.config.compatibility, relation.targetSchema, relation.targetTable))
      );
      const diagram = buildErDiagram(selected.config.compatibility, entities, diagramRelationships);
      return toLimitedResult(
        {
          mode: selected.config.compatibility,
          schema: effectiveSchema,
          rootTable: table ?? null,
          maxTables: tableLimit,
          tableCount: entities.length,
          relationshipCount: diagramRelationships.length,
          mermaid: diagram.mermaid,
          diagram: {
            entities: diagram.entities,
            relationships: diagram.relationships
          }
        },
        selected.config
      );
    }
  );

  registerTool(
    "ob_get_indexes",
    {
      title: "Get Table Indexes",
      description: "Return indexes for an allowed OceanBase table.",
      inputSchema: {
        ...profileInput,
        table: z.string().min(1),
        schema: z.string().optional()
      }
    },
    async ({ profile, table, schema }) => {
      const selected = selectAuthorizedProfile(runtime, profile, context);
      const effectiveSchema = metadataSchema(selected.config, schema);
      assertTableAccess(effectiveSchema, table, policyContext(selected.config));
      const rows = await withQuerySlot(selected, () =>
        listIndexes(selected.pool, selected.config.compatibility, table, effectiveSchema, selected.config.queryTimeoutMs)
      );
      return toLimitedResult(filterColumnMetadata(rows, selected.config.policy), selected.config);
    }
  );

  registerTool(
    "ob_get_constraints",
    {
      title: "Get Table Constraints",
      description: "Return constraints for an allowed OceanBase table.",
      inputSchema: {
        ...profileInput,
        table: z.string().min(1),
        schema: z.string().optional()
      }
    },
    async ({ profile, table, schema }) => {
      const selected = selectAuthorizedProfile(runtime, profile, context);
      const effectiveSchema = metadataSchema(selected.config, schema);
      assertTableAccess(effectiveSchema, table, policyContext(selected.config));
      const rows = await withQuerySlot(selected, () =>
        listConstraints(selected.pool, selected.config.compatibility, table, effectiveSchema, selected.config.queryTimeoutMs)
      );
      return toLimitedResult(filterColumnMetadata(rows, selected.config.policy), selected.config);
    }
  );

  registerTool(
    "ob_get_partitions",
    {
      title: "Get Table Partitions",
      description: "Return partition metadata for an allowed OceanBase table.",
      inputSchema: {
        ...profileInput,
        table: z.string().min(1),
        schema: z.string().optional()
      }
    },
    async ({ profile, table, schema }) => {
      const selected = selectAuthorizedProfile(runtime, profile, context);
      const effectiveSchema = metadataSchema(selected.config, schema);
      assertTableAccess(effectiveSchema, table, policyContext(selected.config));
      const rows = await withQuerySlot(selected, () =>
        listPartitions(selected.pool, selected.config.compatibility, table, effectiveSchema, selected.config.queryTimeoutMs)
      );
      return toLimitedResult(filterTables(rows, selected.config.policy), selected.config);
    }
  );

  registerTool(
    "ob_sample_rows",
    {
      title: "Sample Rows",
      description: "Return a small, policy-filtered sample from an allowed table. Sensitive-looking fields are always masked.",
      inputSchema: {
        ...profileInput,
        table: z.string().min(1),
        schema: z.string().optional(),
        limit: z.number().int().positive().max(100).optional()
      }
    },
    async ({ profile, table, schema, limit }) => {
      const selected = selectAuthorizedProfile(runtime, profile, context);
      const effectiveSchema = metadataSchema(selected.config, schema);
      assertTableAccess(effectiveSchema, table, policyContext(selected.config));
      const metadata = filterColumnMetadata(
        await withQuerySlot(selected, () =>
          describeTable(selected.pool, selected.config.compatibility, table, effectiveSchema, selected.config.queryTimeoutMs)
        ),
        selected.config.policy
      );
      const columns = columnNames(metadata).slice(0, 50);
      const sampleLimit = Math.min(limit ?? Math.min(selected.config.maxRows, 5), selected.config.maxRows, 100);
      const output = await withQuerySlot(selected, () =>
        sampleRows(
          selected.pool,
          selected.config.compatibility,
          effectiveSchema,
          table,
          columns,
          sampleLimit,
          selected.config.queryTimeoutMs
        )
      );
      assertOutputAllowed(output, selected.config.policy);
      return toLimitedResult(maskOutput(output, selected.config, effectiveSchema, table), selected.config);
    }
  );

  return server;
}

function policyContext(config: ObConfig) {
  return {
    compatibility: config.compatibility,
    defaultSchema: config.database,
    policy: config.policy
  };
}

function filterSchemaMapTables(rows: SchemaMapTable[], config: ObConfig): SchemaMapTable[] {
  return rows.filter((table) => {
    try {
      assertTableAccess(table.schema, table.table, policyContext(config));
      return true;
    } catch {
      return false;
    }
  });
}

async function buildSchemaMapTableSummary(
  selected: ReturnType<typeof selectRuntimeProfile>,
  tableInfo: SchemaMapTable,
  includeColumns: boolean,
  maxColumnsPerTable: number,
  includeRelationships: boolean,
  relationshipLimit: number
) {
  const schema = metadataSchema(selected.config, tableInfo.schema);
  const table = tableInfo.table;
  assertTableAccess(schema, table, policyContext(selected.config));
  const columns = filterColumnMetadata(
    await withQuerySlot(selected, () =>
      describeTable(selected.pool, selected.config.compatibility, table, schema, selected.config.queryTimeoutMs)
    ),
    selected.config.policy
  );
  const constraints = filterColumnMetadata(
    await withQuerySlot(selected, () =>
      listConstraints(selected.pool, selected.config.compatibility, table, schema, selected.config.queryTimeoutMs)
    ),
    selected.config.policy
  );
  const compactColumns = compactSchemaColumns(columns, constraints, selected.config, schema, table);
  const primaryKeys = schemaMapPrimaryKeyColumns(constraints);
  const uniqueKeys = uniqueKeyGroups(constraints);
  const timeFields = compactColumns.filter((column) => column.roles.includes("time")).map((column) => column.name);
  const statusFields = compactColumns.filter((column) => column.roles.includes("status")).map((column) => column.name);
  const keyFields = importantSchemaMapFields(compactColumns, primaryKeys, timeFields, statusFields);
  const relationSummary = includeRelationships
    ? await buildSchemaMapRelationshipSummary(selected, schema, table, relationshipLimit)
    : undefined;

  return {
    schema,
    table,
    tableType: tableInfo.tableType,
    engine: tableInfo.engine,
    comment: tableInfo.comment,
    rowEstimate: tableInfo.rowEstimate,
    primaryKeys,
    uniqueKeys,
    keyFields,
    timeFields,
    statusFields,
    columns: includeColumns ? compactColumns.slice(0, Math.max(1, Math.min(maxColumnsPerTable, 100))) : undefined,
    columnsTruncated: includeColumns && compactColumns.length > Math.max(1, Math.min(maxColumnsPerTable, 100)),
    relationSummary
  };
}

async function buildSchemaMapRelationshipSummary(
  selected: ReturnType<typeof selectRuntimeProfile>,
  schema: string | undefined,
  table: string,
  relationshipLimit: number
) {
  const result = await withQuerySlot(selected, () =>
    findRelatedTables(
      selected.pool,
      selected.config.compatibility,
      table,
      schema,
      1,
      Math.max(1, Math.min(relationshipLimit, 100)),
      selected.config.queryTimeoutMs
    )
  );
  const relations = result.relations.filter((relation) => isRelationshipAllowed(relation, selected.config));
  const outbound = relations.filter((relation) => relation.direction === "outbound").length;
  const inbound = relations.filter((relation) => relation.direction === "inbound").length;
  const inferred = relations.filter((relation) => relation.relationType === "name_inference").length;

  return {
    outbound,
    inbound,
    inferred,
    policyFiltered: relations.length !== result.relations.length,
    truncated: result.truncated,
    relations: relations.slice(0, Math.max(1, Math.min(relationshipLimit, 100))).map((relation) => ({
      relationType: relation.relationType,
      direction: relation.direction,
      confidence: relation.confidence,
      sourceSchema: relation.sourceSchema,
      sourceTable: relation.sourceTable,
      sourceColumns: relation.sourceColumns,
      targetSchema: relation.targetSchema,
      targetTable: relation.targetTable,
      targetColumns: relation.targetColumns,
      evidence: relation.evidence.map((item) => ({
        type: item.type,
        detail: item.detail,
        columns: item.columns
      }))
    }))
  };
}

function compactSchemaColumns(
  rows: unknown[],
  constraints: unknown[],
  config: ObConfig,
  schema: string | undefined,
  table: string
): Array<{
  name: string;
  type?: string;
  nullable?: boolean;
  comment?: string;
  roles: string[];
  masked: boolean;
}> {
  const primaryKeys = new Set(schemaMapPrimaryKeyColumns(constraints).map((column) => normalizeTableName(config.compatibility, column)));
  return rows
    .map((row) => profileColumnMetadata(row, config.compatibility))
    .filter((column): column is { name: string; dataType?: string; nullable?: boolean; comment?: string } => Boolean(column))
    .map((column) => {
      const normalized = normalizeTableName(config.compatibility, column.name);
      const roles = schemaColumnRoles(column.name, primaryKeys.has(normalized));
      return {
        name: column.name,
        type: column.dataType,
        nullable: column.nullable,
        comment: column.comment,
        roles,
        masked: shouldMaskColumnValue(column.name, config, schema, table)
      };
    });
}

function schemaMapPrimaryKeyColumns(constraints: unknown[]): string[] {
  return uniqueStrings(
    constraints
      .map((row) => {
        const record = row as Record<string, unknown>;
        const type = stringRecordValue(record, "constraint_type", "CONSTRAINT_TYPE");
        if (!type || !["PRIMARY KEY", "P"].includes(type.toUpperCase())) {
          return undefined;
        }
        return stringRecordValue(record, "column_name", "COLUMN_NAME");
      })
      .filter((value): value is string => Boolean(value))
  );
}

function uniqueKeyGroups(constraints: unknown[]): Array<{ name: string; columns: string[] }> {
  const grouped = new Map<string, string[]>();
  for (const row of constraints) {
    const record = row as Record<string, unknown>;
    const type = stringRecordValue(record, "constraint_type", "CONSTRAINT_TYPE");
    if (!type || !["UNIQUE", "U"].includes(type.toUpperCase())) {
      continue;
    }
    const name = stringRecordValue(record, "constraint_name", "CONSTRAINT_NAME") ?? "UNIQUE";
    const column = stringRecordValue(record, "column_name", "COLUMN_NAME");
    if (!column) {
      continue;
    }
    grouped.set(name, [...(grouped.get(name) ?? []), column]);
  }
  return [...grouped.entries()].map(([name, columns]) => ({ name, columns: uniqueStrings(columns) }));
}

function schemaColumnRoles(columnName: string, primaryKey: boolean): string[] {
  const roles = [];
  if (primaryKey) {
    roles.push("primary_key");
  }
  if (/(^id$|_id$)/i.test(columnName)) {
    roles.push("identifier");
  }
  if (/(created|updated|modified|time|date|timestamp|gmt_)/i.test(columnName)) {
    roles.push("time");
  }
  if (/(status|state|type|category|kind|level|channel|region)/i.test(columnName)) {
    roles.push("status");
  }
  return roles;
}

function importantSchemaMapFields(
  columns: Array<{ name: string; roles: string[] }>,
  primaryKeys: string[],
  timeFields: string[],
  statusFields: string[]
): string[] {
  return uniqueStrings([
    ...primaryKeys,
    ...columns.filter((column) => column.roles.includes("identifier")).map((column) => column.name),
    ...timeFields,
    ...statusFields
  ]).slice(0, 20);
}

function groupSchemaMapTables(
  mode: ObConfig["compatibility"],
  tables: Array<{ schema?: string; table: string }>
) {
  const grouped = new Map<string, Array<Record<string, unknown>>>();
  for (const table of tables) {
    const schema = table.schema ?? "";
    grouped.set(schema, [...(grouped.get(schema) ?? []), table as Record<string, unknown>]);
  }
  return [...grouped.entries()]
    .sort(([left], [right]) => normalizeTableName(mode, left).localeCompare(normalizeTableName(mode, right)))
    .map(([schema, schemaTables]) => ({
      schema: schema || undefined,
      tableCount: schemaTables.length,
      tables: schemaTables.sort((left, right) =>
        normalizeTableName(mode, String(left.table ?? "")).localeCompare(normalizeTableName(mode, String(right.table ?? "")))
      )
    }));
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

async function buildDatabaseDictionary(
  selected: ReturnType<typeof selectRuntimeProfile>,
  tables: SchemaMapTable[],
  maxColumnsPerTable: number
) {
  const dictionaryTables = [];
  for (const tableInfo of tables) {
    const schema = metadataSchema(selected.config, tableInfo.schema);
    assertTableAccess(schema, tableInfo.table, policyContext(selected.config));
    const columns = filterColumnMetadata(
      await withQuerySlot(selected, () =>
        describeTable(selected.pool, selected.config.compatibility, tableInfo.table, schema, selected.config.queryTimeoutMs)
      ),
      selected.config.policy
    );
    const constraints = filterColumnMetadata(
      await withQuerySlot(selected, () =>
        listConstraints(selected.pool, selected.config.compatibility, tableInfo.table, schema, selected.config.queryTimeoutMs)
      ),
      selected.config.policy
    );
    const compactColumns = compactSchemaColumns(columns, constraints, selected.config, schema, tableInfo.table);
    dictionaryTables.push({
      schema,
      table: tableInfo.table,
      comment: tableInfo.comment,
      rowEstimate: tableInfo.rowEstimate,
      primaryKeys: schemaMapPrimaryKeyColumns(constraints),
      columns: compactColumns.slice(0, maxColumnsPerTable).map((column) => ({
        name: column.name,
        type: column.type,
        nullable: column.nullable,
        comment: column.comment,
        roles: column.roles,
        masked: column.masked
      })),
      columnsTruncated: compactColumns.length > maxColumnsPerTable
    });
  }
  return {
    generatedAt: new Date().toISOString(),
    tables: dictionaryTables
  };
}

function renderDatabaseDictionaryMarkdown(dictionary: {
  generatedAt: string;
  tables: Array<{
    schema?: string;
    table: string;
    comment?: string;
    rowEstimate?: { value: number; exact: false; source: string };
    primaryKeys: string[];
    columns: Array<{
      name: string;
      type?: string;
      nullable?: boolean;
      comment?: string;
      roles: string[];
      masked: boolean;
    }>;
    columnsTruncated: boolean;
  }>;
}): string {
  const lines = [
    "# OceanBase Data Dictionary",
    "",
    `Generated at: ${dictionary.generatedAt}`,
    "",
    `Tables: ${dictionary.tables.length}`,
    ""
  ];
  for (const table of dictionary.tables) {
    const title = `${table.schema ? `${table.schema}.` : ""}${table.table}`;
    lines.push(`## ${title}`, "");
    if (table.comment) {
      lines.push(`Comment: ${table.comment}`, "");
    }
    if (table.rowEstimate) {
      lines.push(`Row estimate: ${table.rowEstimate.value} (${table.rowEstimate.source})`, "");
    }
    if (table.primaryKeys.length > 0) {
      lines.push(`Primary key: ${table.primaryKeys.join(", ")}`, "");
    }
    lines.push("| Column | Type | Nullable | Roles | Masked | Comment |");
    lines.push("| --- | --- | --- | --- | --- | --- |");
    for (const column of table.columns) {
      lines.push([
        markdownCell(column.name),
        markdownCell(column.type ?? ""),
        column.nullable == null ? "" : column.nullable ? "YES" : "NO",
        markdownCell(column.roles.join(", ")),
        column.masked ? "YES" : "NO",
        markdownCell(column.comment ?? "")
      ].join(" | ").replace(/^/, "| ").replace(/$/, " |"));
    }
    if (table.columnsTruncated) {
      lines.push("", `More columns exist for ${title}; output was truncated by maxColumnsPerTable.`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

function compareTableMetadata(
  config: ObConfig,
  left: Awaited<ReturnType<typeof getTableDdlMetadata>>,
  right: Awaited<ReturnType<typeof getTableDdlMetadata>>
) {
  const leftColumns = filterColumnMetadata(left.columns, config.policy);
  const rightColumns = filterColumnMetadata(right.columns, config.policy);
  const leftIndexes = filterColumnMetadata(left.indexes, config.policy);
  const rightIndexes = filterColumnMetadata(right.indexes, config.policy);
  const leftConstraints = filterColumnMetadata(left.constraints, config.policy);
  const rightConstraints = filterColumnMetadata(right.constraints, config.policy);
  const leftPartitions = filterTables(left.partitions, config.policy);
  const rightPartitions = filterTables(right.partitions, config.policy);

  return {
    mode: config.compatibility,
    left: { schema: left.schema, table: left.table },
    right: { schema: right.schema, table: right.table },
    columns: compareColumnMetadata(config.compatibility, leftColumns, rightColumns),
    indexes: compareMetadataRows(config.compatibility, leftIndexes, rightIndexes, ["index_name", "INDEX_NAME", "column_name", "COLUMN_NAME"]),
    constraints: compareMetadataRows(config.compatibility, leftConstraints, rightConstraints, ["constraint_name", "CONSTRAINT_NAME", "column_name", "COLUMN_NAME"]),
    partitions: compareMetadataRows(config.compatibility, leftPartitions, rightPartitions, ["partition_name", "PARTITION_NAME", "subpartition_name", "SUBPARTITION_NAME"]),
    warnings: [
      "Comparison uses metadata visible to the active MCP policy; hidden columns or objects are not included."
    ]
  };
}

async function compareSchemaMetadata(
  selected: ReturnType<typeof selectRuntimeProfile>,
  leftSchema: string,
  rightSchema: string,
  leftTables: SchemaMapTable[],
  rightTables: SchemaMapTable[],
  commonCompareLimit: number
) {
  const leftByName = new Map(leftTables.map((table) => [normalizeTableName(selected.config.compatibility, table.table), table]));
  const rightByName = new Map(rightTables.map((table) => [normalizeTableName(selected.config.compatibility, table.table), table]));
  const leftOnlyTables = [...leftByName.entries()]
    .filter(([key]) => !rightByName.has(key))
    .map(([, table]) => table);
  const rightOnlyTables = [...rightByName.entries()]
    .filter(([key]) => !leftByName.has(key))
    .map(([, table]) => table);
  const commonNames = [...leftByName.keys()].filter((key) => rightByName.has(key)).sort();
  const comparedTables = [];
  for (const key of commonNames.slice(0, commonCompareLimit)) {
    const leftTable = leftByName.get(key)!;
    const rightTable = rightByName.get(key)!;
    const leftMetadata = await withQuerySlot(selected, () =>
      getTableDdlMetadata(selected.pool, selected.config.compatibility, leftTable.table, leftSchema, selected.config.queryTimeoutMs)
    );
    const rightMetadata = await withQuerySlot(selected, () =>
      getTableDdlMetadata(selected.pool, selected.config.compatibility, rightTable.table, rightSchema, selected.config.queryTimeoutMs)
    );
    const diff = compareTableMetadata(selected.config, leftMetadata, rightMetadata);
    if (hasTableMetadataDiff(diff)) {
      comparedTables.push(diff);
    }
  }
  return {
    leftTableCount: leftTables.length,
    rightTableCount: rightTables.length,
    commonTableCount: commonNames.length,
    comparedCommonTables: Math.min(commonNames.length, commonCompareLimit),
    comparisonTruncated: commonNames.length > commonCompareLimit,
    leftOnlyTables,
    rightOnlyTables,
    changedTables: comparedTables,
    warnings: [
      "Schema comparison is bounded by maxTables and compareCommonTables.",
      "Only metadata visible to the active MCP policy is included."
    ]
  };
}

function hasTableMetadataDiff(diff: ReturnType<typeof compareTableMetadata>): boolean {
  return (
    diff.columns.leftOnly.length > 0 ||
    diff.columns.rightOnly.length > 0 ||
    diff.columns.changed.length > 0 ||
    diff.indexes.leftOnly.length > 0 ||
    diff.indexes.rightOnly.length > 0 ||
    diff.constraints.leftOnly.length > 0 ||
    diff.constraints.rightOnly.length > 0 ||
    diff.partitions.leftOnly.length > 0 ||
    diff.partitions.rightOnly.length > 0
  );
}

function compareColumnMetadata(
  mode: ObConfig["compatibility"],
  leftRows: unknown[],
  rightRows: unknown[]
) {
  const left = columnCompareMap(mode, leftRows);
  const right = columnCompareMap(mode, rightRows);
  const leftOnly = [];
  const rightOnly = [];
  const changed = [];
  for (const [key, leftColumn] of left) {
    const rightColumn = right.get(key);
    if (!rightColumn) {
      leftOnly.push(leftColumn);
      continue;
    }
    const changes = [];
    for (const field of ["type", "nullable", "comment"] as const) {
      if (leftColumn[field] !== rightColumn[field]) {
        changes.push({ field, left: leftColumn[field], right: rightColumn[field] });
      }
    }
    if (changes.length > 0) {
      changed.push({ column: leftColumn.name, left: leftColumn, right: rightColumn, changes });
    }
  }
  for (const [key, rightColumn] of right) {
    if (!left.has(key)) {
      rightOnly.push(rightColumn);
    }
  }
  return {
    leftOnly,
    rightOnly,
    changed,
    commonCount: [...left.keys()].filter((key) => right.has(key)).length
  };
}

function columnCompareMap(mode: ObConfig["compatibility"], rows: unknown[]) {
  const output = new Map<string, { name: string; type?: string; nullable?: boolean; comment?: string }>();
  for (const row of rows) {
    const column = profileColumnMetadata(row, mode);
    if (!column) {
      continue;
    }
    output.set(normalizeTableName(mode, column.name), {
      name: column.name,
      type: column.dataType,
      nullable: column.nullable,
      comment: column.comment
    });
  }
  return output;
}

function compareMetadataRows(
  mode: ObConfig["compatibility"],
  leftRows: unknown[],
  rightRows: unknown[],
  preferredKeys: string[]
) {
  const left = metadataSignatureMap(mode, leftRows, preferredKeys);
  const right = metadataSignatureMap(mode, rightRows, preferredKeys);
  return {
    leftOnly: [...left.entries()].filter(([key]) => !right.has(key)).map(([, row]) => row),
    rightOnly: [...right.entries()].filter(([key]) => !left.has(key)).map(([, row]) => row),
    commonCount: [...left.keys()].filter((key) => right.has(key)).length
  };
}

function metadataSignatureMap(
  mode: ObConfig["compatibility"],
  rows: unknown[],
  preferredKeys: string[]
) {
  const output = new Map<string, Record<string, unknown>>();
  for (const row of rows) {
    if (!row || typeof row !== "object" || Array.isArray(row)) {
      continue;
    }
    const record = row as Record<string, unknown>;
    const parts = preferredKeys
      .map((key) => record[key])
      .filter((value) => value != null)
      .map((value) => normalizeTableName(mode, String(value)));
    const signature = parts.length > 0
      ? parts.join(":")
      : JSON.stringify(record, Object.keys(record).sort());
    output.set(signature, record);
  }
  return output;
}

async function findSchemaMapTableInfo(
  selected: ReturnType<typeof selectRuntimeProfile>,
  schema: string | undefined,
  table: string
): Promise<SchemaMapTable | undefined> {
  const rows = filterSchemaMapTables(
    await withQuerySlot(selected, () =>
      listSchemaMapTables(
        selected.pool,
        selected.config.compatibility,
        schema,
        table,
        20,
        selected.config.queryTimeoutMs
      )
    ),
    selected.config
  );
  return rows.find((row) => sameTableName(selected.config.compatibility, row.table, table));
}

function inferTablePurpose(
  table: string,
  tableComment: string | undefined,
  columns: Array<{ name: string; comment?: string; roles: string[] }>
) {
  const evidence: Array<{ source: string; value: string; reason: string }> = [];
  if (tableComment) {
    evidence.push({
      source: "table_comment",
      value: tableComment,
      reason: "Uses database table comment."
    });
  }
  evidence.push({
    source: "table_name",
    value: table,
    reason: "Uses visible table name."
  });
  for (const column of columns.filter((item) => item.comment).slice(0, 5)) {
    evidence.push({
      source: "column_comment",
      value: `${column.name}: ${column.comment}`,
      reason: "Uses visible column comment."
    });
  }
  const roleSummary = [
    columns.some((column) => column.roles.includes("primary_key")) ? "primary key" : undefined,
    columns.some((column) => column.roles.includes("time")) ? "time fields" : undefined,
    columns.some((column) => column.roles.includes("status")) ? "status or dimension fields" : undefined
  ].filter((item): item is string => Boolean(item));

  return {
    inferred: true,
    summary: tableComment
      ? `Likely purpose is described by the table comment: ${tableComment}`
      : `Likely represents data named by table "${table}".`,
    confidence: tableComment ? 0.78 : 0.58,
    roleSummary,
    evidence: evidence.slice(0, 10)
  };
}

function tableSummaryQueryEntryPoints(
  primaryKeys: string[],
  timeFields: string[],
  statusFields: string[],
  relationSummary: Awaited<ReturnType<typeof buildSchemaMapRelationshipSummary>> | undefined
) {
  const entries = [];
  if (primaryKeys.length > 0) {
    entries.push({
      type: "primary_key_lookup",
      fields: primaryKeys,
      reason: "Primary-key metadata is available."
    });
  }
  if (timeFields.length > 0) {
    entries.push({
      type: "time_range",
      fields: timeFields.slice(0, 5),
      reason: "Time-like fields were detected from column names."
    });
  }
  if (statusFields.length > 0) {
    entries.push({
      type: "status_filter",
      fields: statusFields.slice(0, 5),
      reason: "Status or dimension-like fields were detected from column names."
    });
  }
  if (relationSummary && relationSummary.relations.length > 0) {
    entries.push({
      type: "join",
      fields: relationSummary.relations.slice(0, 5).map((relation) => ({
        table: relation.direction === "outbound" ? relation.targetTable : relation.sourceTable,
        columns: relation.direction === "outbound" ? relation.sourceColumns : relation.targetColumns,
        confidence: relation.confidence
      })),
      reason: "Relationship metadata or conservative relationship inference is available."
    });
  }
  entries.push({
    type: "paged_scan",
    fields: primaryKeys.length > 0 ? primaryKeys : timeFields.slice(0, 1),
    reason: "Use only with explicit columns, a row limit, and stable ORDER BY when available."
  });
  return entries;
}

function sameTableName(mode: ObConfig["compatibility"], left: string, right: string): boolean {
  return normalizeTableName(mode, left) === normalizeTableName(mode, right);
}

function isRelationshipAllowed(relation: TableRelationship, config: ObConfig): boolean {
  try {
    assertTableAccess(relation.sourceSchema, relation.sourceTable, policyContext(config));
    assertTableAccess(relation.targetSchema, relation.targetTable, policyContext(config));
  } catch {
    return false;
  }
  return [...relation.sourceColumns, ...relation.targetColumns].every(
    (column) => !isDeniedColumn(column, config.policy)
  );
}

function addTableRef(
  refs: Map<string, { schema?: string; table: string }>,
  mode: ObConfig["compatibility"],
  schema: string | undefined,
  table: string,
  limit: number
): void {
  if (refs.size >= limit) {
    return;
  }
  refs.set(tableRefKey(mode, schema, table), { schema, table: mode === "oracle" ? table.toUpperCase() : table });
}

function tableRefFromMetadata(
  row: unknown,
  fallbackSchema: string | undefined
): { schema?: string; table: string } | undefined {
  const record = row as Record<string, unknown>;
  const table = stringRecordValue(record, "table_name", "TABLE_NAME");
  if (!table) {
    return undefined;
  }
  return {
    schema:
      stringRecordValue(record, "table_schema", "TABLE_SCHEMA", "owner", "OWNER", "table_owner", "TABLE_OWNER") ??
      fallbackSchema,
    table
  };
}

function erEntityFromMetadata(
  mode: ObConfig["compatibility"],
  schema: string | undefined,
  table: string,
  columns: unknown[],
  constraints: unknown[]
): ErEntity {
  const primaryKeys = new Set(primaryKeyColumns(mode, constraints));
  return {
    schema,
    table,
    columns: columns.map((row) => {
      const record = row as Record<string, unknown>;
      const name = stringRecordValue(record, "column_name", "COLUMN_NAME") ?? "column";
      const nullable = stringRecordValue(record, "is_nullable", "IS_NULLABLE", "nullable", "NULLABLE");
      return {
        name,
        type: columnTypeLabel(mode, record),
        primaryKey: primaryKeys.has(normalizeTableName(mode, name)),
        nullable: nullable ? !["NO", "N"].includes(nullable.toUpperCase()) : undefined
      };
    })
  };
}

function primaryKeyColumns(mode: ObConfig["compatibility"], constraints: unknown[]): string[] {
  return constraints
    .filter((row) => {
      const type = stringRecordValue(row as Record<string, unknown>, "constraint_type", "CONSTRAINT_TYPE");
      return type === "PRIMARY KEY" || type === "P";
    })
    .map((row) => stringRecordValue(row as Record<string, unknown>, "column_name", "COLUMN_NAME"))
    .filter((value): value is string => Boolean(value))
    .map((value) => normalizeTableName(mode, value));
}

function columnTypeLabel(mode: ObConfig["compatibility"], record: Record<string, unknown>): string | undefined {
  const mysqlType = stringRecordValue(record, "column_type", "COLUMN_TYPE");
  if (mysqlType) {
    return mysqlType;
  }
  const dataType = stringRecordValue(record, "data_type", "DATA_TYPE");
  const length = numberRecordValue(record, "data_length", "DATA_LENGTH");
  if (
    mode === "oracle" &&
    dataType &&
    length &&
    ["CHAR", "NCHAR", "VARCHAR2", "NVARCHAR2", "RAW"].includes(dataType)
  ) {
    return `${dataType}(${length})`;
  }
  return dataType;
}

function dedupeRelationships(mode: ObConfig["compatibility"], relationships: TableRelationship[]): TableRelationship[] {
  const output: TableRelationship[] = [];
  const keys = new Set<string>();
  for (const relationship of relationships) {
    const key = [
      relationship.relationType,
      tableRefKey(mode, relationship.sourceSchema, relationship.sourceTable),
      relationship.sourceColumns.map((column) => normalizeTableName(mode, column)).join(","),
      tableRefKey(mode, relationship.targetSchema, relationship.targetTable),
      relationship.targetColumns.map((column) => normalizeTableName(mode, column)).join(",")
    ].join(":");
    if (!keys.has(key)) {
      keys.add(key);
      output.push(relationship);
    }
  }
  return output;
}

function tableRefKey(mode: ObConfig["compatibility"], schema: string | undefined, table: string): string {
  return `${schema ? normalizeTableName(mode, schema) : ""}.${normalizeTableName(mode, table)}`;
}

function normalizeTableName(mode: ObConfig["compatibility"], value: string): string {
  return mode === "oracle" ? value.trim().toUpperCase() : value.trim().toLowerCase();
}

function stringRecordValue(record: Record<string, unknown>, ...keys: string[]): string | undefined {
  const value = keys.map((key) => record[key]).find((item) => typeof item === "string" && item.trim());
  return typeof value === "string" ? value.trim() : undefined;
}

function numberRecordValue(record: Record<string, unknown>, ...keys: string[]): number | undefined {
  const value = keys
    .map((key) => record[key])
    .find((item) => typeof item === "number" || typeof item === "string");
  if (typeof value === "number") {
    return value;
  }
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return undefined;
}

function selectProfileColumns(
  rows: unknown[],
  mode: ObConfig["compatibility"],
  requestedColumns: string[] | undefined,
  maxColumns: number
): Array<{ name: string; dataType?: string; nullable?: boolean; comment?: string }> {
  const cappedMax = Math.max(1, Math.min(maxColumns, 50));
  const metadata = rows
    .map((row) => profileColumnMetadata(row, mode))
    .filter((row): row is { name: string; dataType?: string; nullable?: boolean; comment?: string } => Boolean(row));
  if (metadata.length === 0) {
    throw new Error("No visible columns are available for ob_profile_columns.");
  }

  if (requestedColumns && requestedColumns.length > 0) {
    if (requestedColumns.length > cappedMax) {
      throw new Error(`Requested ${requestedColumns.length} columns, but maxColumns is ${cappedMax}.`);
    }
    const byName = new Map(metadata.map((column) => [normalizeTableName(mode, column.name), column]));
    const selected: Array<{ name: string; dataType?: string; nullable?: boolean; comment?: string }> = [];
    const seen = new Set<string>();
    for (const requested of requestedColumns) {
      const key = normalizeTableName(mode, requested);
      const column = byName.get(key);
      if (!column) {
        throw new Error(`Unknown column "${requested}" or column is hidden by policy.`);
      }
      if (!seen.has(key)) {
        selected.push(column);
        seen.add(key);
      }
    }
    return selected;
  }

  return metadata.slice(0, cappedMax);
}

function profileColumnMetadata(
  row: unknown,
  mode: ObConfig["compatibility"]
): { name: string; dataType?: string; nullable?: boolean; comment?: string } | undefined {
  const record = row as Record<string, unknown>;
  const name = stringRecordValue(record, "column_name", "COLUMN_NAME");
  if (!name) {
    return undefined;
  }
  const nullableText = stringRecordValue(record, "is_nullable", "IS_NULLABLE", "nullable", "NULLABLE");
  return {
    name,
    dataType: columnTypeLabel(mode, record),
    nullable: nullableText ? !["NO", "N"].includes(nullableText.toUpperCase()) : undefined,
    comment: stringRecordValue(record, "column_comment", "COLUMN_COMMENT", "comments", "COMMENTS")
  };
}

function sameColumnName(mode: ObConfig["compatibility"], left: string, right: string): boolean {
  return normalizeTableName(mode, left) === normalizeTableName(mode, right);
}

function profileWarnings(
  baseWarnings: string[],
  rowEstimate: number | undefined,
  rowLimit: number,
  selectedColumnCount: number,
  visibleColumnCount: number
): string[] {
  const warnings = new Set(baseWarnings);
  warnings.add("Column profiling uses a bounded sample; returned counts and value distributions are not full-table exact values.");
  if (rowEstimate != null && rowEstimate > rowLimit) {
    warnings.add(`Table row estimate is ${rowEstimate}; profiling was limited to ${rowLimit} rows.`);
  }
  if (visibleColumnCount > selectedColumnCount) {
    warnings.add(`Only ${selectedColumnCount} of ${visibleColumnCount} visible columns were profiled. Pass columns or maxColumns to change scope.`);
  }
  return [...warnings];
}

function maskColumnProfileResult<T extends { columns?: unknown[] }>(
  result: T,
  config: ObConfig,
  schema: string | undefined,
  table: string
): T {
  if (!Array.isArray(result.columns)) {
    return result;
  }
  return {
    ...result,
    columns: result.columns.map((column) => maskColumnProfile(column, config, schema, table))
  };
}

function maskColumnProfile(
  column: unknown,
  config: ObConfig,
  schema: string | undefined,
  table: string
): unknown {
  if (!column || typeof column !== "object" || Array.isArray(column)) {
    return column;
  }
  const record = column as Record<string, unknown>;
  const columnName = stringRecordValue(record, "column", "COLUMN") ?? "";
  const masked = Boolean(record.masked) || shouldMaskColumnValue(columnName, config, schema, table);
  if (!masked) {
    return { ...record, masked };
  }
  const timeRange = record.timeRange && typeof record.timeRange === "object" && !Array.isArray(record.timeRange)
    ? {
        ...(record.timeRange as Record<string, unknown>),
        min: maskProfileValue((record.timeRange as Record<string, unknown>).min),
        max: maskProfileValue((record.timeRange as Record<string, unknown>).max)
      }
    : record.timeRange;
  return {
    ...record,
    masked,
    min: maskProfileValue(record.min),
    max: maskProfileValue(record.max),
    timeRange,
    topValues: Array.isArray(record.topValues)
      ? record.topValues.map((item) => {
          const valueRecord = item && typeof item === "object" && !Array.isArray(item) ? item as Record<string, unknown> : {};
          return { ...valueRecord, value: maskProfileValue(valueRecord.value) };
        })
      : record.topValues,
    sampleValues: Array.isArray(record.sampleValues) ? record.sampleValues.map(maskProfileValue) : record.sampleValues
  };
}

function maskProfileValue(value: unknown): unknown {
  return value == null ? value : "***MASKED***";
}

function searchBusinessGlossary(
  config: ObConfig,
  query: string,
  limit: number,
  schemaFilter?: string
) {
  const glossary = config.businessGlossary;
  const maxResults = Math.max(1, Math.min(limit, 500));
  if (!glossary) {
    return {
      configured: false,
      query,
      matches: [],
      policyFiltered: false,
      warnings: ["No business glossary is configured."]
    };
  }

  const matches = [];
  let policyFiltered = false;
  for (const entry of glossary.entries) {
    if (!businessGlossaryEntryMatches(entry, query)) {
      continue;
    }
    const targets = visibleGlossaryTargets(config, entry.targets, schemaFilter);
    if (targets.policyFiltered) {
      policyFiltered = true;
    }
    if (targets.visible.length === 0) {
      continue;
    }
    matches.push({
      term: entry.term,
      aliases: entry.aliases,
      description: entry.description,
      targets: targets.visible,
      evidence: businessGlossaryEvidence(entry, query)
    });
    if (matches.length >= maxResults) {
      break;
    }
  }

  return {
    configured: true,
    query,
    matches,
    policyFiltered,
    warnings: policyFiltered ? ["Some glossary targets were hidden by the active MCP access policy."] : []
  };
}

function glossaryCatalogRow(match: {
  term: string;
  aliases: string[];
  description?: string;
  targets: unknown[];
  evidence: string[];
}) {
  return {
    match_type: "business_glossary",
    source: "business_glossary",
    term: match.term,
    aliases: match.aliases,
    description: match.description,
    targets: match.targets,
    evidence: match.evidence
  };
}

interface SearchEverythingResult {
  type: "schema" | "table" | "column" | "business_glossary";
  source: "catalog" | "schema" | "business_glossary";
  schema?: string;
  table?: string;
  column?: string;
  term?: string;
  description?: string;
  comment?: string;
  matchedField: string;
  confidence: number;
  evidence: Array<{ field: string; value: string; reason: string }>;
}

interface BusinessTableCandidate {
  schema?: string;
  table: string;
  confidence: number;
  sources: string[];
  matchedColumns: string[];
  terms: string[];
  evidence: Array<{ source: string; type: string; field: string; value: string; reason: string }>;
  relatedTables?: Array<{
    schema?: string;
    table: string;
    relationType: string;
    direction: string;
    confidence: number;
    columns: string[];
    evidence: string[];
  }>;
}

interface ColumnSearchResult {
  source: "catalog" | "business_glossary";
  schema?: string;
  table: string;
  column: string;
  type?: string;
  nullable?: boolean;
  comment?: string;
  ordinalPosition?: number;
  masked: boolean;
  confidence: number;
  evidence: Array<{ source: string; field: string; value: string; reason: string }>;
}

function schemaSearchResult(
  row: unknown,
  query: string,
  config: ObConfig,
  schemaFilter?: string
): SearchEverythingResult[] {
  const record = row as Record<string, unknown>;
  const schema = stringRecordValue(record, "Database", "schema_name", "SCHEMA_NAME", "username", "USERNAME");
  if (!schema) {
    return [];
  }
  if (schemaFilter && normalizeTableName(config.compatibility, schema) !== normalizeTableName(config.compatibility, schemaFilter)) {
    return [];
  }
  const match = textMatchEvidence("schema", schema, query);
  if (!match) {
    return [];
  }
  return [{
    type: "schema",
    source: "schema",
    schema,
    matchedField: "schema",
    confidence: match.confidence,
    evidence: [match.evidence]
  }];
}

function catalogSearchResult(row: unknown, query: string, config: ObConfig): SearchEverythingResult[] {
  const record = row as Record<string, unknown>;
  const matchType = stringRecordValue(record, "match_type", "MATCH_TYPE") ?? "table";
  const schema = stringRecordValue(record, "table_schema", "TABLE_SCHEMA", "owner", "OWNER");
  const table = stringRecordValue(record, "table_name", "TABLE_NAME");
  const column = stringRecordValue(record, "column_name", "COLUMN_NAME");
  const comment = stringRecordValue(record, "comment_text", "COMMENT_TEXT");
  const type = matchType.toLowerCase() === "column" && column ? "column" : "table";
  const candidates = [
    { field: "schema", value: schema },
    { field: "table", value: table },
    { field: "column", value: column },
    { field: "comment", value: comment }
  ];
  const matches = candidates
    .map((candidate) => candidate.value ? textMatchEvidence(candidate.field, candidate.value, query) : undefined)
    .filter((match): match is { confidence: number; evidence: SearchEverythingResult["evidence"][number] } => Boolean(match));

  if (!table || matches.length === 0) {
    return [];
  }
  const best = matches.reduce((left, right) => left.confidence >= right.confidence ? left : right);
  const allowed = type === "column"
    ? !column || !shouldMaskColumnValue(column, config, schema, table)
    : true;
  if (!allowed) {
    return [];
  }
  return [{
    type,
    source: "catalog",
    schema,
    table,
    column: type === "column" ? column : undefined,
    comment,
    matchedField: best.evidence.field,
    confidence: best.confidence,
    evidence: matches.map((match) => match.evidence)
  }];
}

function glossarySearchResults(
  match: {
    term: string;
    aliases: string[];
    description?: string;
    targets: Array<{ schema?: string; table?: string; column?: string; description?: string }>;
    evidence: string[];
  },
  query: string
): SearchEverythingResult[] {
  const termMatch = textMatchEvidence("term", match.term, query);
  const aliasMatches = match.aliases
    .map((alias) => textMatchEvidence("alias", alias, query))
    .filter((item): item is { confidence: number; evidence: SearchEverythingResult["evidence"][number] } => Boolean(item));
  const baseEvidence = [
    ...(termMatch ? [termMatch.evidence] : []),
    ...aliasMatches.map((item) => item.evidence),
    ...match.evidence.map((item) => ({ field: "glossary", value: item, reason: "Matched configured business glossary evidence." }))
  ];
  const confidence = Math.max(0.72, termMatch?.confidence ?? 0, ...aliasMatches.map((item) => item.confidence));
  return match.targets.map((target) => ({
    type: "business_glossary" as const,
    source: "business_glossary" as const,
    schema: target.schema,
    table: target.table,
    column: target.column,
    term: match.term,
    description: target.description ?? match.description,
    matchedField: termMatch ? "term" : aliasMatches.length > 0 ? "alias" : "target",
    confidence,
    evidence: baseEvidence.slice(0, 10)
  }));
}

function textMatchEvidence(
  field: string,
  value: string,
  query: string
): { confidence: number; evidence: SearchEverythingResult["evidence"][number] } | undefined {
  const normalizedValue = normalizeGlossaryText(value);
  const normalizedQuery = normalizeGlossaryText(query);
  if (!normalizedValue || !normalizedQuery) {
    return undefined;
  }
  if (normalizedValue === normalizedQuery) {
    return {
      confidence: field === "comment" ? 0.82 : 1,
      evidence: { field, value, reason: "Exact match." }
    };
  }
  if (normalizedValue.includes(normalizedQuery)) {
    return {
      confidence: field === "comment" ? 0.66 : 0.86,
      evidence: { field, value, reason: "Contains query text." }
    };
  }
  if (normalizedQuery.includes(normalizedValue)) {
    return {
      confidence: field === "comment" ? 0.58 : 0.74,
      evidence: { field, value, reason: "Query contains this metadata term." }
    };
  }
  return undefined;
}

function dedupeSearchResults(results: SearchEverythingResult[]): SearchEverythingResult[] {
  const best = new Map<string, SearchEverythingResult>();
  for (const result of results) {
    const key = [
      result.type,
      result.schema ?? "",
      result.table ?? "",
      result.column ?? "",
      result.term ?? ""
    ].join(":").toLowerCase();
    const previous = best.get(key);
    if (!previous || result.confidence > previous.confidence) {
      best.set(key, result);
    }
  }
  return [...best.values()];
}

function columnSearchRows(
  row: unknown,
  query: string | undefined,
  dataType: string | undefined,
  config: ObConfig
): ColumnSearchResult[] {
  const record = row as Record<string, unknown>;
  const schema = stringRecordValue(record, "table_schema", "TABLE_SCHEMA", "owner", "OWNER");
  const table = stringRecordValue(record, "table_name", "TABLE_NAME");
  const column = stringRecordValue(record, "column_name", "COLUMN_NAME");
  if (!table || !column) {
    return [];
  }
  const metadata = profileColumnMetadata(row, config.compatibility);
  const type = metadata?.dataType ?? columnTypeLabel(config.compatibility, record);
  const comment = metadata?.comment;
  const evidence = [
    ...(query ? columnSearchEvidence(query, schema, table, column, type, comment) : []),
    ...(dataType && type ? dataTypeEvidence(type, dataType) : [])
  ];
  if (evidence.length === 0 && !query && !dataType) {
    evidence.push({ source: "catalog", field: "metadata", value: column, reason: "Returned from visible column metadata." });
  }
  if (evidence.length === 0) {
    return [];
  }
  return [{
    source: "catalog",
    schema,
    table,
    column,
    type,
    nullable: metadata?.nullable,
    comment,
    ordinalPosition: numberRecordValue(record, "ordinal_position", "ORDINAL_POSITION", "column_id", "COLUMN_ID"),
    masked: shouldMaskColumnValue(column, config, schema, table),
    confidence: Math.max(...evidence.map((item) => evidenceConfidence(item.field))),
    evidence
  }];
}

function columnSearchEvidence(
  query: string,
  schema: string | undefined,
  table: string,
  column: string,
  type: string | undefined,
  comment: string | undefined
): ColumnSearchResult["evidence"] {
  return [
    { field: "schema", value: schema },
    { field: "table", value: table },
    { field: "column", value: column },
    { field: "type", value: type },
    { field: "comment", value: comment }
  ]
    .map((item) => item.value ? textMatchEvidence(item.field, item.value, query) : undefined)
    .filter((item): item is { confidence: number; evidence: SearchEverythingResult["evidence"][number] } => Boolean(item))
    .map((item) => ({
      source: "catalog",
      field: item.evidence.field,
      value: item.evidence.value,
      reason: item.evidence.reason
    }));
}

function dataTypeEvidence(type: string, expectedType: string): ColumnSearchResult["evidence"] {
  const match = textMatchEvidence("type", type, expectedType);
  return match
    ? [{ source: "catalog", field: match.evidence.field, value: match.evidence.value, reason: match.evidence.reason }]
    : [];
}

function evidenceConfidence(field: string): number {
  if (field === "column") {
    return 0.95;
  }
  if (field === "table") {
    return 0.78;
  }
  if (field === "type") {
    return 0.72;
  }
  if (field === "comment") {
    return 0.66;
  }
  if (field === "business_glossary") {
    return 0.9;
  }
  return 0.58;
}

function glossaryColumnRows(
  match: {
    term: string;
    targets: Array<{ schema?: string; table?: string; column?: string; description?: string }>;
    evidence: string[];
  },
  query: string,
  config: ObConfig
): ColumnSearchResult[] {
  const termEvidence = textMatchEvidence("business_glossary", match.term, query);
  return match.targets
    .filter((target) => target.table && target.column)
    .map((target) => ({
      source: "business_glossary" as const,
      schema: target.schema,
      table: target.table!,
      column: target.column!,
      comment: target.description,
      masked: shouldMaskColumnValue(target.column!, config, target.schema, target.table),
      confidence: Math.max(0.9, termEvidence?.confidence ?? 0),
      evidence: [
        ...(termEvidence
          ? [{ source: "business_glossary", field: termEvidence.evidence.field, value: termEvidence.evidence.value, reason: termEvidence.evidence.reason }]
          : []),
        ...match.evidence.map((item) => ({
          source: "business_glossary",
          field: "business_glossary",
          value: item,
          reason: "Matched configured business glossary evidence."
        }))
      ].slice(0, 10)
    }));
}

function dedupeColumnSearchResults(results: ColumnSearchResult[]): ColumnSearchResult[] {
  const best = new Map<string, ColumnSearchResult>();
  for (const result of results) {
    const key = [result.schema ?? "", result.table, result.column].join(":").toLowerCase();
    const previous = best.get(key);
    if (!previous) {
      best.set(key, result);
      continue;
    }
    best.set(key, {
      ...previous,
      ...Object.fromEntries(Object.entries(result).filter(([, value]) => value != null)),
      masked: previous.masked || result.masked,
      confidence: Math.max(previous.confidence, result.confidence),
      evidence: [...previous.evidence, ...result.evidence].slice(0, 20)
    });
  }
  return [...best.values()];
}

function tableCandidatesFromSearchResults(
  results: SearchEverythingResult[],
  config: ObConfig,
  limit: number
): BusinessTableCandidate[] {
  const candidates = new Map<string, BusinessTableCandidate>();
  for (const result of results) {
    if (!result.table) {
      continue;
    }
    try {
      assertTableAccess(result.schema, result.table, policyContext(config));
    } catch {
      continue;
    }
    const key = tableRefKey(config.compatibility, result.schema, result.table);
    const current = candidates.get(key) ?? {
      schema: result.schema,
      table: result.table,
      confidence: 0,
      sources: [],
      matchedColumns: [],
      terms: [],
      evidence: []
    };
    current.confidence = Math.max(current.confidence, tableCandidateConfidence(result));
    current.sources = uniqueStrings([...current.sources, result.source]);
    if (result.column) {
      current.matchedColumns = uniqueStrings([...current.matchedColumns, result.column]);
    }
    if (result.term) {
      current.terms = uniqueStrings([...current.terms, result.term]);
    }
    current.evidence = [
      ...current.evidence,
      ...result.evidence.map((item) => ({
        source: result.source,
        type: result.type,
        field: item.field,
        value: item.value,
        reason: item.reason
      }))
    ].slice(0, 20);
    candidates.set(key, current);
  }
  return [...candidates.values()]
    .sort((left, right) => right.confidence - left.confidence || left.table.localeCompare(right.table))
    .slice(0, limit);
}

function tableCandidateConfidence(result: SearchEverythingResult): number {
  if (result.source === "business_glossary") {
    return Math.max(result.confidence, 0.9);
  }
  if (result.type === "table") {
    return result.confidence;
  }
  if (result.type === "column") {
    return Math.min(result.confidence, 0.82);
  }
  return Math.min(result.confidence, 0.7);
}

function explicitPrepareQueryCandidate(
  config: ObConfig,
  schema: string | undefined,
  table: string
): BusinessTableCandidate[] {
  const normalizedSchema = config.compatibility === "oracle" && schema ? schema.trim().toUpperCase() : schema;
  const normalizedTable = config.compatibility === "oracle" ? table.trim().toUpperCase() : table.trim();
  assertTableAccess(normalizedSchema, normalizedTable, policyContext(config));
  return [{
    schema: normalizedSchema,
    table: normalizedTable,
    confidence: 1,
    sources: ["explicit_input"],
    matchedColumns: [],
    terms: [],
    evidence: [{
      source: "explicit_input",
      type: "table",
      field: "table",
      value: normalizedTable,
      reason: "The caller supplied an explicit table."
    }]
  }];
}

async function findPrepareQueryCandidates(
  selected: ReturnType<typeof selectRuntimeProfile>,
  searchTerms: string[],
  schema: string | undefined,
  limit: number,
  warnings: string[]
): Promise<BusinessTableCandidate[]> {
  const results: SearchEverythingResult[] = [];
  const warningSet = new Set(warnings);
  for (const term of searchTerms.slice(0, 8)) {
    const rows = filterColumnMetadata(
      await withQuerySlot(selected, () =>
        searchCatalog(
          selected.pool,
          selected.config.compatibility,
          term,
          schema,
          Math.max(limit * 8, 20),
          selected.config.queryTimeoutMs
        )
      ),
      selected.config.policy
    );
    results.push(...rows.flatMap((row) => catalogSearchResult(row, term, selected.config)));
    const glossary = searchBusinessGlossary(selected.config, term, limit * 4, schema);
    results.push(...glossary.matches.flatMap((match) => glossarySearchResults(match, term)));
    for (const warning of glossary.warnings) {
      warningSet.add(warning);
    }
  }
  warnings.splice(0, warnings.length, ...warningSet);
  return tableCandidatesFromSearchResults(
    dedupeSearchResults(results),
    selected.config,
    limit
  );
}

async function buildPreparedQueryCandidate(
  selected: ReturnType<typeof selectRuntimeProfile>,
  candidate: BusinessTableCandidate,
  question: string,
  maxColumns: number,
  rowLimit: number
) {
  const schema = metadataSchema(selected.config, candidate.schema);
  assertTableAccess(schema, candidate.table, policyContext(selected.config));
  const columns = filterColumnMetadata(
    await withQuerySlot(selected, () =>
      describeTable(selected.pool, selected.config.compatibility, candidate.table, schema, selected.config.queryTimeoutMs)
    ),
    selected.config.policy
  );
  const constraints = filterColumnMetadata(
    await withQuerySlot(selected, () =>
      listConstraints(selected.pool, selected.config.compatibility, candidate.table, schema, selected.config.queryTimeoutMs)
    ),
    selected.config.policy
  );
  const relationshipResult = await withQuerySlot(selected, () =>
    findRelatedTables(selected.pool, selected.config.compatibility, candidate.table, schema, 1, 20, selected.config.queryTimeoutMs)
  );
  const relationships = relationshipResult.relations.filter((relation) =>
    isRelationshipAllowed(relation, selected.config) &&
    relation.sourceColumns.every((column) => !isDeniedColumn(column, selected.config.policy)) &&
    relation.targetColumns.every((column) => !isDeniedColumn(column, selected.config.policy))
  );
  const compactColumns = compactSchemaColumns(columns, constraints, selected.config, schema, candidate.table);
  const primaryKeys = schemaMapPrimaryKeyColumns(constraints);
  const timeFields = compactColumns.filter((column) => column.roles.includes("time")).map((column) => column.name);
  const statusFields = compactColumns.filter((column) => column.roles.includes("status")).map((column) => column.name);
  const generated = generateQueryTemplates({
    mode: selected.config.compatibility,
    schema,
    table: candidate.table,
    columns,
    constraints,
    relationships,
    scenarios: prepareQueryScenarios(question),
    maxColumns,
    rowLimit
  });
  const templates = generated.templates.slice(0, 5).map((template) => ({
    ...template,
    policy: explainGeneratedQuery(template.sql, template.parameters.length, selected.config)
  }));
  const matchedColumns = candidate.matchedColumns.filter((column) => !isDeniedColumn(column, selected.config.policy));

  return {
    schema,
    table: candidate.table,
    confidence: candidate.confidence,
    sources: candidate.sources,
    terms: candidate.terms,
    matchedColumns,
    evidence: candidate.evidence.slice(0, 20),
    fields: compactColumns.slice(0, Math.max(1, Math.min(maxColumns, 50))),
    fieldCount: compactColumns.length,
    primaryKeys,
    timeFields,
    statusFields,
    relatedTables: relationships.slice(0, 8).map((relation) => relatedTableEvidence(candidate, relation, selected.config.compatibility)).filter(Boolean),
    queryTemplates: templates,
    suggestedSql: templates[0] ?? null,
    pagination: preparePaginationSuggestion(rowLimit, primaryKeys, timeFields),
    riskPreview: {
      executed: false,
      generatedSqlCount: templates.length,
      allDraftsPassPolicy: templates.every((template) => template.policy.allowed),
      warnings: [
        ...generated.warnings,
        "No target query was executed. Use ob_query_preview before running a draft."
      ]
    }
  };
}

function prepareQueryScenarios(question: string): QueryTemplateScenario[] {
  const text = question.toLowerCase();
  const scenarios: QueryTemplateScenario[] = [];
  if (/(count|total|summary|group|aggregate|统计|数量|汇总|聚合)/i.test(text)) {
    scenarios.push("aggregation");
  }
  if (/(recent|latest|time|date|range|最近|最新|时间|日期)/i.test(text)) {
    scenarios.push("time_range");
  }
  if (/(id|primary key|主键|编号)/i.test(text)) {
    scenarios.push("by_primary_key");
  }
  if (/(join|related|detail|关联|联表|明细)/i.test(text)) {
    scenarios.push("join");
  }
  scenarios.push("pagination", "by_primary_key", "time_range", "aggregation", "join");
  return uniqueStrings(scenarios) as QueryTemplateScenario[];
}

function preparePaginationSuggestion(
  rowLimit: number,
  primaryKeys: string[],
  timeFields: string[]
) {
  const orderBy = primaryKeys[0] ?? timeFields[0];
  return {
    tool: "ob_query_page",
    pageSize: Math.min(rowLimit, 50),
    orderBy: orderBy ?? null,
    stableOrder: primaryKeys.length > 0,
    warning: orderBy
      ? primaryKeys.length > 0
        ? "Primary-key ordering is available for repeatable pages."
        : "A time-like column is available, but ordering may not be unique."
      : "No stable ordering field was detected; pass orderBy before paging."
  };
}

function prepareQuerySearchTerms(
  question: string,
  businessTerm: string | undefined,
  table: string | undefined
): string[] {
  const terms = [
    businessTerm,
    table,
    question.trim().length <= 80 ? question : undefined,
    ...extractAsciiQueryTerms(question),
    ...extractHanQueryTerms(question)
  ];
  return uniqueStrings(
    terms
      .filter((value): value is string => typeof value === "string")
      .map((value) => value.trim())
      .filter(isUsefulQueryTerm)
  ).slice(0, 8);
}

function extractAsciiQueryTerms(value: string): string[] {
  return value.match(/[A-Za-z0-9_]{2,}/g) ?? [];
}

function extractHanQueryTerms(value: string): string[] {
  const output: string[] = [];
  const runs = value.match(/[\u4e00-\u9fff]{2,}/g) ?? [];
  for (const run of runs) {
    for (const size of [2, 3]) {
      for (let index = 0; index <= run.length - size; index += 1) {
        output.push(run.slice(index, index + size));
        if (output.length >= 24) {
          return output;
        }
      }
    }
  }
  return output;
}

function isUsefulQueryTerm(value: string): boolean {
  const normalized = normalizeGlossaryText(value);
  return normalized.length >= 2 && !QUERY_TERM_STOPWORDS.has(normalized);
}

type BuildSelectFilter = z.infer<typeof buildSelectFilterSchema>;
type BuildSelectOrderBy = z.infer<typeof buildSelectOrderBySchema>;

function buildStructuredSelect(
  config: ObConfig,
  schema: string | undefined,
  table: string,
  columnRows: unknown[],
  input: {
    columns?: string[];
    filters: BuildSelectFilter[];
    orderBy: BuildSelectOrderBy[];
    pageSize?: number;
    page?: number;
  }
) {
  const warnings: string[] = [];
  const columns = buildSelectColumnInfos(config, schema, table, columnRows);
  if (columns.length === 0) {
    throw new Error("No visible columns are available for this table under the active MCP policy.");
  }
  const selectedColumns = selectBuildColumns(config, columns, input.columns, warnings);
  const where = buildSelectWhereClause(config, columns, input.filters);
  const orderClause = buildSelectOrderClause(config, columns, input.orderBy, warnings);
  const safePageSize = effectiveRowLimit(input.pageSize ?? Math.min(config.maxRows, 50), config);
  const safePage = input.page ?? 1;
  const offset = (safePage - 1) * safePageSize;
  const tableRef = sqlQualifiedTable(config.compatibility, schema, table);
  const selectList = selectedColumns.map((column) => sqlQuoteIdentifier(config.compatibility, column.name)).join(", ");
  const baseSql = [
    `SELECT ${selectList}`,
    `FROM ${tableRef}`,
    where.clause ? `WHERE ${where.clause}` : undefined,
    orderClause
  ].filter((part): part is string => Boolean(part)).join(" ");
  const paginationSql = config.compatibility === "oracle"
    ? `${baseSql} OFFSET ? ROWS FETCH NEXT ? ROWS ONLY`
    : `${baseSql} LIMIT ? OFFSET ?`;
  const paginationParams: SqlParam[] = config.compatibility === "oracle"
    ? [offset, safePageSize]
    : [safePageSize, offset];
  const params = [...where.params, ...paginationParams];
  const paramHints = [
    ...where.paramHints,
    ...(config.compatibility === "oracle"
      ? [
          { name: "offset", type: "number", value: offset, description: "Rows to skip." },
          { name: "pageSize", type: "number", value: safePageSize, description: "Rows to return, capped by OB_MAX_ROWS." }
        ]
      : [
          { name: "pageSize", type: "number", value: safePageSize, description: "Rows to return, capped by OB_MAX_ROWS." },
          { name: "offset", type: "number", value: offset, description: "Rows to skip." }
        ])
  ];
  const policy = explainGeneratedQuery(paginationSql, params.length, config);

  return {
    sql: paginationSql,
    params,
    paramHints,
    columns: selectedColumns.map((column) => ({
      name: column.name,
      type: column.type,
      nullable: column.nullable,
      masked: column.masked
    })),
    filters: input.filters,
    orderBy: input.orderBy,
    pagination: {
      page: safePage,
      pageSize: safePageSize,
      offset,
      dialect: config.compatibility
    },
    policy,
    warnings
  };
}

function buildSelectColumnInfos(
  config: ObConfig,
  schema: string | undefined,
  table: string,
  rows: unknown[]
): Array<{ name: string; type?: string; nullable?: boolean; comment?: string; masked: boolean }> {
  return rows
    .map((row) => profileColumnMetadata(row, config.compatibility))
    .filter((column): column is { name: string; dataType?: string; nullable?: boolean; comment?: string } => Boolean(column))
    .map((column) => ({
      name: column.name,
      type: column.dataType,
      nullable: column.nullable,
      comment: column.comment,
      masked: shouldMaskColumnValue(column.name, config, schema, table)
    }));
}

function selectBuildColumns(
  config: ObConfig,
  available: Array<{ name: string; type?: string; nullable?: boolean; comment?: string; masked: boolean }>,
  requested: string[] | undefined,
  warnings: string[]
) {
  if (requested && requested.length > 0) {
    return requested.map((column) => getBuildColumn(config, available, column));
  }
  const unmasked = available.filter((column) => !column.masked).slice(0, 12);
  const selected = unmasked.length > 0 ? unmasked : available.slice(0, 12);
  if (available.length > selected.length) {
    warnings.push(`Only the first ${selected.length} visible columns are included by default. Pass columns for a specific projection.`);
  }
  if (unmasked.length === 0 && selected.some((column) => column.masked)) {
    warnings.push("Default projection contains masked columns because no unmasked visible columns were available.");
  }
  return selected;
}

function buildSelectWhereClause(
  config: ObConfig,
  available: Array<{ name: string; type?: string; nullable?: boolean; comment?: string; masked: boolean }>,
  filters: BuildSelectFilter[]
) {
  const clauses: string[] = [];
  const params: SqlParam[] = [];
  const paramHints: Array<{ name: string; column: string; operator: string; value?: SqlParam; description: string }> = [];
  for (const filter of filters) {
    const column = getBuildColumn(config, available, filter.column);
    const columnRef = sqlQuoteIdentifier(config.compatibility, column.name);
    const operator = filter.operator;
    if (operator === "is_null" || operator === "is_not_null") {
      clauses.push(`${columnRef} IS ${operator === "is_null" ? "" : "NOT "}NULL`);
      continue;
    }
    if (operator === "in") {
      const values = assertSqlParamArray(filter.value, filter.column, operator);
      if (values.length === 0 || values.length > 100) {
        throw new Error("IN filters require between 1 and 100 values.");
      }
      clauses.push(`${columnRef} IN (${values.map(() => "?").join(", ")})`);
      for (const value of values) {
        params.push(value);
        paramHints.push({ name: filter.column, column: column.name, operator, value, description: "IN-list value." });
      }
      continue;
    }
    if (operator === "between") {
      const values = assertSqlParamArray(filter.value, filter.column, operator);
      if (values.length !== 2) {
        throw new Error("BETWEEN filters require exactly two values.");
      }
      clauses.push(`${columnRef} BETWEEN ? AND ?`);
      for (const value of values) {
        params.push(value);
        paramHints.push({ name: filter.column, column: column.name, operator, value, description: "BETWEEN boundary value." });
      }
      continue;
    }
    const value = assertSingleSqlParam(filter.value, filter.column, operator);
    clauses.push(`${columnRef} ${sqlOperator(operator)} ?`);
    params.push(value);
    paramHints.push({ name: filter.column, column: column.name, operator, value, description: "Filter value." });
  }
  return {
    clause: clauses.join(" AND "),
    params,
    paramHints
  };
}

function buildSelectOrderClause(
  config: ObConfig,
  available: Array<{ name: string; type?: string; nullable?: boolean; comment?: string; masked: boolean }>,
  orderBy: BuildSelectOrderBy[],
  warnings: string[]
): string | undefined {
  if (orderBy.length === 0) {
    warnings.push("No ORDER BY was provided. Page order may be unstable.");
    return undefined;
  }
  const items = orderBy.map((item) => {
    const column = getBuildColumn(config, available, item.column);
    const direction = item.direction ? ` ${item.direction.toUpperCase()}` : "";
    const nulls = item.nulls ? ` NULLS ${item.nulls.toUpperCase()}` : "";
    return `${sqlQuoteIdentifier(config.compatibility, column.name)}${direction}${nulls}`;
  });
  return `ORDER BY ${items.join(", ")}`;
}

function getBuildColumn(
  config: ObConfig,
  available: Array<{ name: string; type?: string; nullable?: boolean; comment?: string; masked: boolean }>,
  column: string
) {
  const normalized = normalizeTableName(config.compatibility, column);
  const match = available.find((item) => normalizeTableName(config.compatibility, item.name) === normalized);
  if (!match) {
    throw new Error(`Column "${column}" is not visible on this table under the active MCP policy.`);
  }
  return match;
}

function assertSingleSqlParam(value: unknown, column: string, operator: string): SqlParam {
  if (Array.isArray(value)) {
    throw new Error(`Filter "${column}" with operator "${operator}" expects a single value.`);
  }
  if (value === undefined) {
    throw new Error(`Filter "${column}" with operator "${operator}" requires a value.`);
  }
  return value as SqlParam;
}

function assertSqlParamArray(value: unknown, column: string, operator: string): SqlParam[] {
  if (!Array.isArray(value)) {
    throw new Error(`Filter "${column}" with operator "${operator}" expects an array value.`);
  }
  return value as SqlParam[];
}

function sqlOperator(operator: BuildSelectFilter["operator"]): string {
  switch (operator) {
    case "eq":
      return "=";
    case "ne":
      return "<>";
    case "gt":
      return ">";
    case "gte":
      return ">=";
    case "lt":
      return "<";
    case "lte":
      return "<=";
    case "like":
      return "LIKE";
    default:
      throw new Error(`Unsupported filter operator "${operator}".`);
  }
}

function sqlQualifiedTable(mode: ObConfig["compatibility"], schema: string | undefined, table: string): string {
  return schema
    ? `${sqlQuoteIdentifier(mode, mode === "oracle" ? schema.trim().toUpperCase() : schema.trim())}.${sqlQuoteIdentifier(mode, table)}`
    : sqlQuoteIdentifier(mode, table);
}

function sqlQuoteIdentifier(mode: ObConfig["compatibility"], value: string): string {
  if (mode === "oracle") {
    return `"${value.replace(/"/g, "\"\"")}"`;
  }
  return `\`${value.replace(/`/g, "``")}\``;
}

async function attachRelatedTablesToCandidates(
  selected: ReturnType<typeof selectRuntimeProfile>,
  candidates: BusinessTableCandidate[],
  relationshipLimit: number
): Promise<void> {
  for (const candidate of candidates.slice(0, 10)) {
    const relationships = await withQuerySlot(selected, () =>
      findRelatedTables(
        selected.pool,
        selected.config.compatibility,
        candidate.table,
        candidate.schema,
        1,
        relationshipLimit,
        selected.config.queryTimeoutMs
      )
    );
    const related = relationships.relations
      .filter((relation) => isRelationshipAllowed(relation, selected.config))
      .map((relation) => relatedTableEvidence(candidate, relation, selected.config.compatibility))
      .filter((item): item is NonNullable<BusinessTableCandidate["relatedTables"]>[number] => Boolean(item))
      .slice(0, relationshipLimit);
    if (related.length > 0) {
      candidate.relatedTables = related;
    }
  }
}

function relatedTableEvidence(
  candidate: BusinessTableCandidate,
  relation: TableRelationship,
  mode: ObConfig["compatibility"]
): NonNullable<BusinessTableCandidate["relatedTables"]>[number] | undefined {
  const sourceMatches =
    normalizeTableName(mode, relation.sourceTable) === normalizeTableName(mode, candidate.table) &&
    normalizeTableName(mode, relation.sourceSchema ?? "") === normalizeTableName(mode, candidate.schema ?? "");
  const schema = sourceMatches ? relation.targetSchema : relation.sourceSchema;
  const table = sourceMatches ? relation.targetTable : relation.sourceTable;
  const columns = sourceMatches ? relation.sourceColumns : relation.targetColumns;
  if (!table || normalizeTableName(mode, table) === normalizeTableName(mode, candidate.table)) {
    return undefined;
  }
  return {
    schema,
    table,
    relationType: relation.relationType,
    direction: sourceMatches ? "outbound" : "inbound",
    confidence: relation.confidence,
    columns,
    evidence: relation.evidence.map((item) => item.detail).slice(0, 5)
  };
}

function businessGlossaryEntryMatches(
  entry: NonNullable<ObConfig["businessGlossary"]>["entries"][number],
  query: string
): boolean {
  const needle = normalizeGlossaryText(query);
  const haystack = [
    entry.term,
    entry.description,
    ...entry.aliases,
    ...entry.targets.flatMap((target) => [target.schema, target.table, target.column, target.description])
  ]
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .map(normalizeGlossaryText);
  return haystack.some((value) => value.includes(needle) || needle.includes(value));
}

function businessGlossaryEvidence(
  entry: NonNullable<ObConfig["businessGlossary"]>["entries"][number],
  query: string
): string[] {
  const needle = normalizeGlossaryText(query);
  const evidence: string[] = [];
  if (normalizeGlossaryText(entry.term).includes(needle) || needle.includes(normalizeGlossaryText(entry.term))) {
    evidence.push("term");
  }
  for (const alias of entry.aliases) {
    if (normalizeGlossaryText(alias).includes(needle) || needle.includes(normalizeGlossaryText(alias))) {
      evidence.push(`alias:${alias}`);
    }
  }
  for (const target of entry.targets) {
    for (const value of [target.schema, target.table, target.column]) {
      if (value && (normalizeGlossaryText(value).includes(needle) || needle.includes(normalizeGlossaryText(value)))) {
        evidence.push(`target:${value}`);
      }
    }
  }
  return [...new Set(evidence)].slice(0, 10);
}

function visibleGlossaryTargets(
  config: ObConfig,
  targets: NonNullable<ObConfig["businessGlossary"]>["entries"][number]["targets"],
  schemaFilter?: string
) {
  const visible = [];
  let policyFiltered = false;
  for (const target of targets) {
    const schema = metadataSchema(config, target.schema ?? schemaFilter);
    if (schemaFilter && schema && normalizeTableName(config.compatibility, schema) !== normalizeTableName(config.compatibility, schemaFilter)) {
      policyFiltered = true;
      continue;
    }
    if (!glossaryTargetAllowed(config, schema, target.table, target.column)) {
      policyFiltered = true;
      continue;
    }
    visible.push({
      schema,
      table: target.table,
      column: target.column,
      description: target.description
    });
  }
  return { visible, policyFiltered };
}

function glossaryTargetAllowed(
  config: ObConfig,
  schema: string | undefined,
  table: string | undefined,
  column: string | undefined
): boolean {
  if (column && isDeniedColumn(column, config.policy)) {
    return false;
  }
  if (table) {
    try {
      assertTableAccess(schema, table, policyContext(config));
      return true;
    } catch {
      return false;
    }
  }
  return schema != null && isSchemaAllowed(schema, config.policy);
}

function normalizeGlossaryText(value: string): string {
  return value.trim().toLowerCase();
}

function metadataSchema(config: ObConfig, schema: string | undefined): string | undefined {
  return schema ?? config.database ?? (config.policy.allowedSchemas.length === 1 ? config.policy.allowedSchemas[0] : undefined);
}

function metadataTableRef(config: ObConfig, schema: string | undefined, table: string): { schema?: string; table: string } {
  return {
    schema: metadataSchema(config, schema),
    table
  };
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

function queryShape(sql: string, mode: ObConfig["compatibility"]) {
  return {
    hasRowLimit: hasSqlRowLimit(sql, mode),
    hasOrderBy: /\border\s+by\b/i.test(sql),
    hasWhere: /\bwhere\b/i.test(sql),
    hasJoin: /\bjoin\b/i.test(sql)
  };
}

function hasSqlRowLimit(sql: string, mode: ObConfig["compatibility"]): boolean {
  if (/\blimit\s+\d+/i.test(sql) || /\bfetch\s+first\s+\d+\s+rows\b/i.test(sql) || /\brownum\b/i.test(sql)) {
    return true;
  }
  return mode === "oracle" && /\boffset\s+\d+\s+rows\s+fetch\s+next\s+\d+\s+rows\b/i.test(sql);
}

function sensitiveSqlTerms(sql: string, config: ObConfig) {
  const normalizedSql = sql.toLowerCase();
  const terms = new Set<string>();
  for (const match of sql.matchAll(/[A-Za-z_][\w$]*/g)) {
    const value = match[0];
    if (SENSITIVE_SAMPLE_PATTERN.test(value)) {
      terms.add(value);
    }
  }
  for (const pattern of [...config.policy.deniedColumns, ...config.policy.maskedColumns]) {
    for (const part of pattern.split(/[.*,\s]+/).filter(Boolean)) {
      if (part !== "*" && normalizedSql.includes(part.toLowerCase())) {
        terms.add(part);
      }
    }
  }
  return {
    detected: terms.size > 0,
    terms: [...terms].slice(0, 20)
  };
}

function queryPreviewWarnings(
  shape: ReturnType<typeof queryShape>,
  sensitiveColumnRisk: ReturnType<typeof sensitiveSqlTerms>
): string[] {
  const warnings: string[] = [];
  if (!shape.hasRowLimit) {
    warnings.push("No row limit was detected. Prefer a paged query or an explicit row cap for data inspection.");
  }
  if (!shape.hasOrderBy) {
    warnings.push("No ORDER BY was detected. Result order may be unstable.");
  }
  if (sensitiveColumnRisk.detected) {
    warnings.push("The SQL references fields that look sensitive or are configured for masking.");
  }
  return warnings;
}

function ensureQuerySessionStore(runtime: GatewayRuntime): Map<string, QuerySessionState> {
  const shared = runtime as RuntimeWithQuerySessions;
  if (!shared.querySessions) {
    shared.querySessions = new Map();
  }
  return shared.querySessions;
}

function cleanupQuerySessions(store: Map<string, QuerySessionState>) {
  const now = Date.now();
  for (const [id, session] of store.entries()) {
    if (Date.parse(session.expiresAt) <= now) {
      store.delete(id);
    }
  }
}

function pruneQuerySessions(store: Map<string, QuerySessionState>) {
  if (store.size <= MAX_QUERY_SESSIONS) {
    return;
  }
  const sessions = [...store.values()].sort((left, right) =>
    Date.parse(left.updatedAt) - Date.parse(right.updatedAt)
  );
  for (const session of sessions.slice(0, store.size - MAX_QUERY_SESSIONS)) {
    store.delete(session.id);
  }
}

function getQuerySessionForProfile(
  store: Map<string, QuerySessionState>,
  sessionId: string,
  profile: string
): QuerySessionState {
  const session = store.get(sessionId);
  if (!session) {
    throw new Error(`Query session "${sessionId}" was not found or has expired.`);
  }
  if (session.profile !== profile) {
    throw new Error(`Query session "${sessionId}" does not belong to profile "${profile}".`);
  }
  return session;
}

function validateQuerySessionColumns(
  columns: string[],
  schema: string | undefined,
  table: string | undefined,
  config: ObConfig
): string[] {
  const output = uniqueStrings(columns.map((column) => column.trim()).filter(Boolean));
  for (const column of output) {
    if (isDeniedColumn(column, config.policy)) {
      throw new Error(`Column "${column}" is blocked by OB_DENIED_COLUMNS.`);
    }
  }
  if (table) {
    assertTableAccess(schema, table, policyContext(config));
  }
  return output;
}

function querySessionMasking(
  columns: string[],
  schema: string | undefined,
  table: string | undefined,
  config: ObConfig
) {
  const maskedColumns = columns.filter((column) => isMaskedColumn(column, config.policy, schema, table));
  const sensitiveColumns = columns.filter((column) => SENSITIVE_SAMPLE_PATTERN.test(column));
  return {
    maskedColumns: uniqueStrings(maskedColumns),
    sensitiveColumns: uniqueStrings(sensitiveColumns)
  };
}

function publicQuerySession(session: QuerySessionState) {
  return {
    sessionId: session.id,
    profile: session.profile,
    mode: session.mode,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    expiresAt: session.expiresAt,
    businessTerm: session.businessTerm ?? null,
    schema: session.schema ?? null,
    table: session.table ?? null,
    columns: session.columns,
    sql: session.sql ?? null,
    paramCount: session.params.length,
    page: session.page,
    pageSize: session.pageSize ?? null,
    orderBy: session.orderBy ?? null,
    warnings: session.warnings,
    masking: session.masking,
    resultState: session.resultState
  };
}

async function runQuerySessionPage(
  selected: ReturnType<typeof selectRuntimeProfile>,
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
      selected.config.enforceReadOnlyTransaction
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

type ResultSummaryColumn = z.infer<typeof resultSummaryColumnSchema>;

function summarizeQueryResultRows(
  rows: Array<Record<string, unknown>>,
  columns: ResultSummaryColumn[],
  config: ObConfig,
  maxTopValues: number
) {
  const columnNames = resultSummaryColumnNames(rows, columns);
  const columnMetadata = new Map(columns.map((column) => [column.name.toLowerCase(), column]));
  const summaries = columnNames.map((name) =>
    summarizeResultColumn(name, rows, columnMetadata.get(name.toLowerCase()), config, maxTopValues)
  );
  const maskedColumns = summaries.filter((column) => column.masked).map((column) => column.name);
  const timeColumns = summaries
    .filter((column) => column.timeRange)
    .map((column) => column.name);
  const dimensionColumns = summaries
    .filter((column) => column.distinct.count > 0 && column.distinct.count <= Math.max(20, Math.ceil(rows.length / 2)))
    .map((column) => column.name);
  return {
    empty: rows.length === 0,
    columns: summaries,
    maskedColumns,
    timeColumns,
    dimensionColumns,
    nextSteps: resultSummaryNextSteps(rows.length, maskedColumns, timeColumns, dimensionColumns)
  };
}

function resultSummaryColumnNames(
  rows: Array<Record<string, unknown>>,
  columns: ResultSummaryColumn[]
): string[] {
  const names = columns.map((column) => column.name);
  for (const row of rows) {
    names.push(...Object.keys(row));
  }
  return uniqueStrings(names.filter(Boolean)).slice(0, 200);
}

function summarizeResultColumn(
  name: string,
  rows: Array<Record<string, unknown>>,
  metadata: ResultSummaryColumn | undefined,
  config: ObConfig,
  maxTopValues: number
) {
  const values = rows.map((row) => row[name]);
  const nullCount = values.filter((value) => value == null).length;
  const nonNullValues = values.filter((value) => value != null);
  const masked = Boolean(metadata?.masked) || shouldMaskColumnValue(name, config, metadata?.schema, metadata?.table);
  const counts = valueCounts(nonNullValues, maxTopValues);
  const numericRange = masked ? undefined : numericSummary(nonNullValues);
  const timeRange = masked ? undefined : timeSummary(name, metadata?.type, nonNullValues);
  return {
    name,
    type: metadata?.type,
    table: metadata?.table,
    schema: metadata?.schema,
    masked,
    nulls: {
      count: nullCount,
      ratio: rows.length === 0 ? 0 : nullCount / rows.length
    },
    distinct: {
      count: new Set(nonNullValues.map(summaryValueKey)).size,
      exact: rows.length <= 1_000
    },
    topValues: masked
      ? []
      : counts.map((item) => ({
          value: item.value,
          count: item.count,
          ratio: rows.length === 0 ? 0 : item.count / rows.length
        })),
    numericRange,
    timeRange,
    warnings: masked ? ["Values are hidden because the column is marked or detected as sensitive."] : []
  };
}

function valueCounts(values: unknown[], limit: number): Array<{ value: unknown; count: number }> {
  const counts = new Map<string, { value: unknown; count: number }>();
  for (const value of values) {
    const key = summaryValueKey(value);
    const current = counts.get(key);
    if (current) {
      current.count += 1;
    } else {
      counts.set(key, { value: summaryValue(value), count: 1 });
    }
  }
  return [...counts.values()]
    .sort((left, right) => right.count - left.count || String(left.value).localeCompare(String(right.value)))
    .slice(0, limit);
}

function numericSummary(values: unknown[]) {
  const numbers = values
    .map((value) => typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN)
    .filter((value) => Number.isFinite(value));
  if (numbers.length === 0) {
    return undefined;
  }
  return {
    min: Math.min(...numbers),
    max: Math.max(...numbers)
  };
}

function timeSummary(name: string, type: string | undefined, values: unknown[]) {
  const looksTemporal = /(time|date|created|updated|modified|gmt_)/i.test(`${name} ${type ?? ""}`);
  if (!looksTemporal) {
    return undefined;
  }
  const timestamps = values
    .map((value) => {
      if (value instanceof Date) {
        return value.getTime();
      }
      if (typeof value === "string" || typeof value === "number") {
        const time = Date.parse(String(value));
        return Number.isFinite(time) ? time : NaN;
      }
      return NaN;
    })
    .filter((value) => Number.isFinite(value));
  if (timestamps.length === 0) {
    return undefined;
  }
  return {
    min: new Date(Math.min(...timestamps)).toISOString(),
    max: new Date(Math.max(...timestamps)).toISOString()
  };
}

function summaryValue(value: unknown): unknown {
  if (value == null || ["string", "number", "boolean"].includes(typeof value)) {
    return value;
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  return "[complex]";
}

function summaryValueKey(value: unknown): string {
  const safeValue = summaryValue(value);
  return `${typeof safeValue}:${String(safeValue)}`;
}

function resultSummaryNextSteps(
  rowCount: number,
  maskedColumns: string[],
  timeColumns: string[],
  dimensionColumns: string[]
): string[] {
  const steps: string[] = [];
  if (rowCount === 0) {
    steps.push("Check whether filters are too narrow or whether the selected schema/table is correct.");
  }
  if (timeColumns.length > 0) {
    steps.push(`Use ${timeColumns[0]} for bounded recent-data queries when investigating changes.`);
  }
  if (dimensionColumns.length > 0) {
    steps.push(`Use ${dimensionColumns[0]} for grouped counts or value-distribution checks.`);
  }
  if (maskedColumns.length > 0) {
    steps.push("Masked columns were summarized without exposing raw values.");
  }
  if (steps.length === 0) {
    steps.push("Use ob_query_refine to add filters, ordering, or pagination before running a follow-up query.");
  }
  return steps;
}

function compareQueryResultRows(
  leftRows: Array<Record<string, unknown>>,
  rightRows: Array<Record<string, unknown>>,
  columns: ResultSummaryColumn[],
  keyColumns: string[],
  compareColumns: string[] | undefined,
  config: ObConfig,
  maxDifferences: number
) {
  const allColumns = resultSummaryColumnNames([...leftRows, ...rightRows], columns);
  const selectedColumns = compareColumns && compareColumns.length > 0
    ? uniqueStrings(compareColumns)
    : allColumns;
  const metadata = new Map(columns.map((column) => [column.name.toLowerCase(), column]));
  const columnPresence = allColumns.map((name) => ({
    name,
    inLeft: leftRows.some((row) => Object.prototype.hasOwnProperty.call(row, name)),
    inRight: rightRows.some((row) => Object.prototype.hasOwnProperty.call(row, name))
  }));
  const valueDifferences = selectedColumns
    .filter((name) => columnPresence.some((column) => column.name === name && column.inLeft && column.inRight))
    .map((name) => compareResultColumn(name, leftRows, rightRows, metadata.get(name.toLowerCase()), config, maxDifferences))
    .filter((item) => item.changed);
  const keyComparison = keyColumns.length > 0
    ? compareResultKeys(leftRows, rightRows, keyColumns, metadata, config)
    : undefined;
  return {
    rowCounts: {
      left: leftRows.length,
      right: rightRows.length,
      delta: rightRows.length - leftRows.length
    },
    columnPresence,
    keyComparison,
    valueDifferences,
    warnings: compareResultWarnings(columns, keyColumns, compareColumns)
  };
}

function compareResultColumn(
  name: string,
  leftRows: Array<Record<string, unknown>>,
  rightRows: Array<Record<string, unknown>>,
  metadata: ResultSummaryColumn | undefined,
  config: ObConfig,
  maxDifferences: number
) {
  const masked = Boolean(metadata?.masked) || shouldMaskColumnValue(name, config, metadata?.schema, metadata?.table);
  const leftValues = leftRows.map((row) => row[name]).filter((value) => value != null);
  const rightValues = rightRows.map((row) => row[name]).filter((value) => value != null);
  const leftCounts = new Map(valueCounts(leftValues, maxDifferences * 2).map((item) => [summaryValueKey(item.value), item]));
  const rightCounts = new Map(valueCounts(rightValues, maxDifferences * 2).map((item) => [summaryValueKey(item.value), item]));
  const keys = uniqueStrings([...leftCounts.keys(), ...rightCounts.keys()]);
  const valueDeltas = keys
    .map((key) => {
      const left = leftCounts.get(key);
      const right = rightCounts.get(key);
      return {
        value: masked ? "[masked]" : left?.value ?? right?.value,
        leftCount: left?.count ?? 0,
        rightCount: right?.count ?? 0,
        delta: (right?.count ?? 0) - (left?.count ?? 0)
      };
    })
    .filter((item) => item.delta !== 0)
    .sort((left, right) => Math.abs(right.delta) - Math.abs(left.delta))
    .slice(0, maxDifferences);
  const leftNumeric = masked ? undefined : numericSummary(leftValues);
  const rightNumeric = masked ? undefined : numericSummary(rightValues);
  return {
    column: name,
    masked,
    changed: valueDeltas.length > 0 || JSON.stringify(leftNumeric) !== JSON.stringify(rightNumeric),
    distinct: {
      left: new Set(leftValues.map(summaryValueKey)).size,
      right: new Set(rightValues.map(summaryValueKey)).size
    },
    valueDeltas,
    numericRange: {
      left: leftNumeric,
      right: rightNumeric
    }
  };
}

function compareResultKeys(
  leftRows: Array<Record<string, unknown>>,
  rightRows: Array<Record<string, unknown>>,
  keyColumns: string[],
  metadata: Map<string, ResultSummaryColumn>,
  config: ObConfig
) {
  const keyMasked = keyColumns.some((column) => {
    const columnMetadata = metadata.get(column.toLowerCase());
    return Boolean(columnMetadata?.masked) || shouldMaskColumnValue(column, config, columnMetadata?.schema, columnMetadata?.table);
  });
  const leftKeys = new Set(leftRows.map((row) => resultRowKey(row, keyColumns)));
  const rightKeys = new Set(rightRows.map((row) => resultRowKey(row, keyColumns)));
  const onlyLeft = [...leftKeys].filter((key) => !rightKeys.has(key));
  const onlyRight = [...rightKeys].filter((key) => !leftKeys.has(key));
  return {
    keyColumns,
    keyValuesHidden: keyMasked,
    onlyInLeftCount: onlyLeft.length,
    onlyInRightCount: onlyRight.length,
    sampleOnlyInLeft: keyMasked ? [] : onlyLeft.slice(0, 10),
    sampleOnlyInRight: keyMasked ? [] : onlyRight.slice(0, 10)
  };
}

function resultRowKey(row: Record<string, unknown>, keyColumns: string[]): string {
  return keyColumns.map((column) => String(summaryValue(row[column]))).join("|");
}

function compareResultWarnings(
  columns: ResultSummaryColumn[],
  keyColumns: string[],
  compareColumns: string[] | undefined
): string[] {
  const warnings: string[] = [];
  if (keyColumns.length === 0) {
    warnings.push("No keyColumns were supplied; row-level comparison is limited to row counts and column value distributions.");
  }
  if (compareColumns && compareColumns.length > 0) {
    warnings.push("Only requested compareColumns were compared for value differences.");
  }
  if (columns.some((column) => column.masked)) {
    warnings.push("Masked columns are compared by counts only; raw values are not returned.");
  }
  return warnings;
}

function cleanOptionalString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function queryExampleFromTemplate(
  template: ReturnType<typeof generateQueryTemplates>["templates"][number],
  config: ObConfig
) {
  return {
    scenario: template.scenario,
    title: template.title,
    purpose: queryExamplePurpose(template.scenario),
    sql: template.sql,
    parameters: template.parameters.map((parameter) => ({
      ...parameter,
      exampleValue: queryExampleParameterValue(parameter.name, parameter.type, config)
    })),
    policy: explainGeneratedQuery(template.sql, template.parameters.length, config),
    recommendedWorkflow: queryExampleWorkflow(template.scenario),
    notes: template.notes,
    executed: false
  };
}

function queryExamplePurpose(scenario: QueryTemplateScenario): string {
  const purposes: Record<QueryTemplateScenario, string> = {
    by_primary_key: "Read one row by a key column.",
    pagination: "Inspect rows in bounded pages.",
    time_range: "Read rows within a bounded time range.",
    aggregation: "Count rows or groups for quick data understanding.",
    join: "Inspect rows with a related table using visible relationship evidence."
  };
  return purposes[scenario];
}

function queryExampleWorkflow(scenario: QueryTemplateScenario): string[] {
  const workflow = [
    "Review the visible metadata and policy result before using the SQL.",
    "Run ob_lint_sql or ob_query_preview before executing the query.",
    "Bind parameters explicitly; do not inline user input."
  ];
  if (scenario === "pagination") {
    workflow.push("For repeated browsing, prefer ob_query_page with a stable order.");
  }
  return workflow;
}

function queryExampleParameterValue(name: string, type: string | undefined, config: ObConfig): unknown {
  const normalized = name.toLowerCase();
  if (normalized === "limit") {
    return Math.min(config.maxRows, 50);
  }
  if (normalized === "offset") {
    return 0;
  }
  if (normalized.includes("start") && normalized.includes("time")) {
    return "YYYY-MM-DD 00:00:00";
  }
  if (normalized.includes("end") && normalized.includes("time")) {
    return "YYYY-MM-DD 23:59:59";
  }
  if (/\b(number|int|decimal|numeric|bigint)\b/i.test(type ?? "")) {
    return 1;
  }
  return `<${name}>`;
}

async function explainSqlErrorWithMetadata(
  selected: ReturnType<typeof selectRuntimeProfile>,
  sql: string,
  errorMessage: string,
  schema: string | undefined,
  limit: number
) {
  const classification = classifySqlError(errorMessage);
  const policy = explainSqlPolicy(sql, policyContext(selected.config));
  const shape = queryShape(sql, selected.config.compatibility);
  const baseHints = errorHints(new Error(errorMessage), { sql });
  const candidates = await errorMetadataCandidates(selected, classification, errorMessage, schema, limit);
  return {
    sql,
    errorClass: classification.kind,
    extractedTerm: classification.term ?? null,
    hints: baseHints,
    policy,
    shape,
    candidates,
    warnings: candidates.truncated ? ["Metadata candidates were truncated by the requested limit."] : [],
    executed: false
  };
}

function classifySqlError(errorMessage: string): { kind: string; term?: string } {
  const lower = errorMessage.toLowerCase();
  const column =
    /unknown column ['"`]?([^'"`\s]+)['"`]?/i.exec(errorMessage)?.[1] ??
    /invalid identifier[^'"`]*['"`]([^'"`]+)['"`]/i.exec(errorMessage)?.[1] ??
    /ora-00904:\s*["']?([^"'\s]+)["']?/i.exec(errorMessage)?.[1];
  if (column || /unknown column|invalid identifier|ora-00904|1054/.test(lower)) {
    return { kind: "unknown_column", term: column };
  }
  const table =
    /ora-00942:\s*["']?([^"'\s:]+)["']?/i.exec(errorMessage)?.[1] ??
    /table ['"`]?([^'"`\s]+)['"`]?.*(?:doesn't exist|not exist|unknown)/i.exec(errorMessage)?.[1] ??
    /unknown table ['"`]?([^'"`\s]+)['"`]?/i.exec(errorMessage)?.[1] ??
    /(?:table|view) ['"`]?([^'"`\s]+)['"`]? does not exist/i.exec(errorMessage)?.[1];
  if (table || /unknown table|table .*doesn't exist|ora-00942|1146/.test(lower)) {
    return { kind: "unknown_table", term: table };
  }
  if (/not allowed|blocked|select \*|ob_denied_columns|policy/i.test(errorMessage)) {
    return { kind: "policy" };
  }
  if (/limit|offset|fetch|rownum|syntax|ora-00933|1064/i.test(errorMessage)) {
    return { kind: "dialect_or_pagination" };
  }
  if (/permission|privilege|access denied|ora-01031|1044|1142/i.test(errorMessage)) {
    return { kind: "permission" };
  }
  return { kind: "unknown" };
}

async function errorMetadataCandidates(
  selected: ReturnType<typeof selectRuntimeProfile>,
  classification: { kind: string; term?: string },
  errorMessage: string,
  schema: string | undefined,
  limit: number
) {
  const term = classification.term ?? fallbackErrorSearchTerm(errorMessage);
  if (!term) {
    return { columns: [], tables: [], truncated: false };
  }
  if (classification.kind === "unknown_column") {
    const rows = filterColumnMetadata(
      await withQuerySlot(selected, () =>
        findColumns(
          selected.pool,
          selected.config.compatibility,
          { query: term, schema },
          limit,
          selected.config.queryTimeoutMs
        )
      ),
      selected.config.policy
    );
    const columns = dedupeColumnSearchResults(rows.flatMap((row) =>
      columnSearchRows(row, term, undefined, selected.config)
    )).slice(0, limit);
    return { columns, tables: [], truncated: rows.length >= limit };
  }
  if (classification.kind === "unknown_table") {
    const rows = filterColumnMetadata(
      await withQuerySlot(selected, () =>
        searchCatalog(
          selected.pool,
          selected.config.compatibility,
          term,
          schema,
          limit,
          selected.config.queryTimeoutMs
        )
      ),
      selected.config.policy
    );
    const searchResults = dedupeSearchResults(rows.flatMap((row) =>
      catalogSearchResult(row, term, selected.config)
    ));
    return {
      columns: [],
      tables: tableCandidatesFromSearchResults(searchResults, selected.config, limit),
      truncated: rows.length >= limit
    };
  }
  return { columns: [], tables: [], truncated: false };
}

function fallbackErrorSearchTerm(errorMessage: string): string | undefined {
  return /['"`]([A-Za-z_][\w$]*)['"`]/.exec(errorMessage)?.[1];
}

function convertSqlDialect(
  config: ObConfig,
  sql: string,
  sourceMode: ObConfig["compatibility"],
  targetMode: ObConfig["compatibility"]
) {
  const checks = [
    runExplainCheck("input_limits", () => assertSqlInputLimits(sql, [], config)),
    runExplainCheck("read_only_sql", () => assertReadOnlySql(sql))
  ];
  if (!checks.every((check) => check.ok)) {
    return {
      sql,
      convertedSql: null,
      sourceMode,
      targetMode,
      changed: false,
      checks,
      warnings: ["SQL was not converted because it did not pass read-only input checks."],
      limitations: []
    };
  }
  if (sourceMode === targetMode) {
    return {
      sql,
      convertedSql: trimRewriteSql(sql),
      sourceMode,
      targetMode,
      changed: false,
      checks,
      policy: explainSqlPolicy(sql, policyContext(config)),
      warnings: ["Source and target modes are the same; SQL was normalized only."],
      limitations: []
    };
  }

  const warnings = [
    "Review converted SQL before use; function behavior and date arithmetic may not be fully equivalent."
  ];
  const limitations: string[] = [];
  let convertedSql = trimRewriteSql(sql);
  if (sourceMode === "mysql" && targetMode === "oracle") {
    convertedSql = convertedSql.replace(/`([^`]+)`/g, (_match, name: string) => `"${name.replace(/"/g, "\"\"").toUpperCase()}"`);
    convertedSql = convertedSql.replace(/\bIFNULL\s*\(/gi, "NVL(");
    convertedSql = convertedSql.replace(/\bNOW\s*\(\s*\)/gi, "SYSTIMESTAMP");
    convertedSql = convertedSql.replace(/\bCURDATE\s*\(\s*\)/gi, "TRUNC(SYSDATE)");
    convertedSql = convertLimitToOracle(convertedSql);
    if (/\bdate_format\s*\(/i.test(sql)) {
      limitations.push("DATE_FORMAT was not converted; rewrite it manually with TO_CHAR.");
    }
  } else {
    convertedSql = convertedSql.replace(/"([A-Za-z_][\w$]*)"/g, (_match, name: string) => `\`${name}\``);
    convertedSql = convertedSql.replace(/\bNVL\s*\(/gi, "IFNULL(");
    convertedSql = convertedSql.replace(/\bSYSTIMESTAMP\b/gi, "NOW()");
    convertedSql = convertedSql.replace(/\bSYSDATE\b/gi, "NOW()");
    convertedSql = convertFetchToMysql(convertedSql);
    convertedSql = convertSimpleRownumToMysql(convertedSql, limitations);
    if (/\bto_char\s*\(/i.test(sql)) {
      limitations.push("TO_CHAR was not converted; rewrite it manually with DATE_FORMAT if needed.");
    }
  }
  const outputChecks = [
    runExplainCheck("converted_read_only_sql", () => assertReadOnlySql(convertedSql))
  ];
  const policy = explainSqlPolicy(convertedSql, policyContext(config));
  return {
    sql,
    convertedSql,
    sourceMode,
    targetMode,
    changed: convertedSql !== trimRewriteSql(sql),
    checks: [...checks, ...outputChecks],
    policy,
    allowed: outputChecks.every((check) => check.ok) && policy.allowed,
    warnings,
    limitations,
    executed: false
  };
}

function convertLimitToOracle(sql: string): string {
  let output = sql.replace(/\s+limit\s+(\d+)\s+offset\s+(\d+)\s*$/i, (_match, limit: string, offset: string) =>
    ` OFFSET ${offset} ROWS FETCH NEXT ${limit} ROWS ONLY`
  );
  output = output.replace(/\s+limit\s+(\d+)\s*$/i, (_match, limit: string) =>
    ` FETCH FIRST ${limit} ROWS ONLY`
  );
  return output;
}

function convertFetchToMysql(sql: string): string {
  let output = sql.replace(/\s+offset\s+(\d+)\s+rows\s+fetch\s+next\s+(\d+)\s+rows\s+only\s*$/i, (_match, offset: string, limit: string) =>
    ` LIMIT ${limit} OFFSET ${offset}`
  );
  output = output.replace(/\s+fetch\s+first\s+(\d+)\s+rows\s+only\s*$/i, (_match, limit: string) =>
    ` LIMIT ${limit}`
  );
  return output;
}

function convertSimpleRownumToMysql(sql: string, limitations: string[]): string {
  const converted = sql.replace(/\s+where\s+rownum\s*<=\s*(\d+)\s*$/i, (_match, limit: string) => ` LIMIT ${limit}`);
  if (converted === sql && /\brownum\b/i.test(sql)) {
    limitations.push("ROWNUM predicates were not fully converted; use LIMIT/OFFSET manually.");
  }
  return converted;
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

function trimRewriteSql(sql: string): string {
  return sql.trim().replace(/;+$/, "").trimEnd();
}

async function lintReadOnlySql(
  selected: ReturnType<typeof selectRuntimeProfile>,
  sql: string,
  params: SqlParam[],
  maxRows: number,
  runExplain: boolean
) {
  const checks = [
    runExplainCheck("input_limits", () => assertSqlInputLimits(sql, params, selected.config)),
    runExplainCheck("read_only_sql", () => assertReadOnlySql(sql))
  ];
  const policy = explainSqlPolicy(sql, policyContext(selected.config));
  const allowed = checks.every((check) => check.ok) && policy.allowed;
  const shape = queryShape(sql, selected.config.compatibility);
  const sensitiveColumnRisk = sensitiveSqlTerms(sql, selected.config);
  const findings: LintFinding[] = [
    ...lintCheckFindings(checks, policy.checks),
    ...lintShapeFindings(sql, selected.config.compatibility, shape),
    ...lintSensitiveFindings(sensitiveColumnRisk),
    ...lintDialectFindings(sql, selected.config.compatibility)
  ];

  let plan: QueryOutput | undefined;
  let analysis: ReturnType<typeof analyzeQueryPlan> | undefined;
  let explainRun = false;
  if (allowed && runExplain) {
    const explainSql = buildExplainSql(sql);
    const started = Date.now();
    plan = await withQuerySlot(selected, () =>
      runReadOnlyQuery(
        selected.pool,
        selected.config.compatibility,
        explainSql,
        params,
        maxRows,
        selected.config.queryTimeoutMs,
        selected.config.enforceReadOnlyTransaction
      )
    );
    metrics.recordQueryDuration(Date.now() - started);
    analysis = analyzeQueryPlan(plan, sql);
    explainRun = true;
    findings.push(...analysis.findings.map((finding) => ({
      rule: `explain_${finding.rule}`,
      severity: finding.severity,
      message: finding.message,
      evidence: finding.evidence
    })));
  } else if (!allowed) {
    findings.push({
      rule: "explain_skipped",
      severity: "info" as const,
      message: "EXPLAIN was skipped because SQL is not allowed by the current policy checks.",
      evidence: []
    });
  } else if (!runExplain) {
    findings.push({
      rule: "explain_skipped",
      severity: "info" as const,
      message: "EXPLAIN was skipped by request.",
      evidence: []
    });
  }

  const severity = lintSeverity(findings);
  return {
    sql,
    paramCount: params.length,
    allowed,
    severity,
    executed: false,
    explainRun,
    checks: [...checks, ...policy.checks],
    policy,
    shape,
    sensitiveColumnRisk,
    findings,
    recommendations: lintRecommendations(findings, analysis?.recommendations ?? []),
    plan: plan ? { rowCount: plan.rowCount, rows: plan.rows.slice(0, 20), truncated: plan.truncated } : undefined
  };
}

type LintFinding = {
  rule: string;
  severity: "info" | "warn" | "high";
  message: string;
  evidence: string[];
};

function lintCheckFindings(
  checks: Array<{ name: string; ok: boolean; message: string }>,
  policyChecks: Array<{ name: string; ok: boolean; message: string }>
): LintFinding[] {
  return [...checks, ...policyChecks]
    .filter((check) => !check.ok)
    .map((check) => ({
      rule: check.name,
      severity: "high" as const,
      message: check.message,
      evidence: [check.name]
    }));
}

function lintShapeFindings(
  sql: string,
  mode: ObConfig["compatibility"],
  shape: ReturnType<typeof queryShape>
): LintFinding[] {
  const findings: LintFinding[] = [];
  if (hasSelectStar(sql)) {
    findings.push({
      rule: "select_star",
      severity: "high" as const,
      message: "SELECT * is not allowed by the MCP SQL policy. Use explicit columns.",
      evidence: ["SELECT *"]
    });
  }
  if (!shape.hasRowLimit) {
    findings.push({
      rule: "missing_limit",
      severity: "warn" as const,
      message: "No row limit or pagination clause was detected.",
      evidence: [mode === "oracle" ? "Use FETCH FIRST/OFFSET or ob_query_page." : "Use LIMIT or ob_query_page."]
    });
  }
  if (!shape.hasOrderBy) {
    findings.push({
      rule: "missing_order_by",
      severity: "warn" as const,
      message: "No ORDER BY was detected. Result order may be unstable.",
      evidence: []
    });
  }
  if (!shape.hasWhere && !shape.hasRowLimit) {
    findings.push({
      rule: "broad_scan_shape",
      severity: "warn" as const,
      message: "The query has no WHERE clause and no row limit; it may scan a large table.",
      evidence: []
    });
  }
  return findings;
}

function lintSensitiveFindings(sensitiveColumnRisk: ReturnType<typeof sensitiveSqlTerms>): LintFinding[] {
  if (!sensitiveColumnRisk.detected) {
    return [];
  }
  return [{
    rule: "sensitive_field_reference",
    severity: "warn" as const,
    message: "SQL references fields that look sensitive or are configured for masking.",
    evidence: sensitiveColumnRisk.terms
  }];
}

function lintDialectFindings(sql: string, mode: ObConfig["compatibility"]): LintFinding[] {
  const findings: LintFinding[] = [];
  if (mode === "oracle" && /\blimit\s+\d+/i.test(sql)) {
    findings.push({
      rule: "dialect_pagination",
      severity: "warn" as const,
      message: "Oracle mode should use OFFSET/FETCH or ROWNUM instead of LIMIT.",
      evidence: ["LIMIT"]
    });
  }
  if (mode === "mysql" && (/\bfetch\s+(?:first|next)\s+\d+\s+rows\b/i.test(sql) || /\brownum\b/i.test(sql))) {
    findings.push({
      rule: "dialect_pagination",
      severity: "warn" as const,
      message: "MySQL mode should use LIMIT/OFFSET instead of Oracle pagination syntax.",
      evidence: ["FETCH/ROWNUM"]
    });
  }
  return findings;
}

function hasSelectStar(sql: string): boolean {
  return /\bselect\s+(?:\/\*.*?\*\/\s*)?\*/is.test(sql) || /,\s*\*/.test(sql);
}

function lintSeverity(findings: LintFinding[]): "low" | "medium" | "high" {
  if (findings.some((finding) => finding.severity === "high")) {
    return "high";
  }
  if (findings.some((finding) => finding.severity === "warn")) {
    return "medium";
  }
  return "low";
}

function lintRecommendations(
  findings: LintFinding[],
  planRecommendations: string[]
): string[] {
  const output: string[] = [];
  if (findings.some((finding) => finding.rule === "select_star")) {
    output.push("Select explicit columns from metadata before running the query.");
  }
  if (findings.some((finding) => finding.rule === "missing_limit")) {
    output.push("Use ob_query_page or add a dialect-correct row limit for inspection queries.");
  }
  if (findings.some((finding) => finding.rule === "missing_order_by")) {
    output.push("Add a stable ORDER BY for repeatable pagination.");
  }
  if (findings.some((finding) => finding.rule === "sensitive_field_reference")) {
    output.push("Avoid selecting sensitive fields unless the configured masking policy is acceptable for the task.");
  }
  return uniqueStrings([...output, ...planRecommendations]).slice(0, 10);
}

function pagedQueryWarnings(
  sql: string,
  requestedPageSize: number | undefined,
  effectivePageSize: number,
  fetchRows: number,
  orderBy: string | undefined
): string[] {
  const warnings: string[] = [];
  if (!/\border\s+by\b/i.test(sql) && !orderBy) {
    warnings.push("No ORDER BY was provided. Page order may be unstable.");
  }
  if (requestedPageSize && requestedPageSize !== effectivePageSize) {
    warnings.push(`pageSize was capped to ${effectivePageSize} by the configured row limit.`);
  }
  if (fetchRows === effectivePageSize) {
    warnings.push("hasMore may be false when the configured row limit does not allow fetching an extra row.");
  }
  return warnings;
}

function queryResultWarnings(sql: string, output: QueryOutput, config: ObConfig): string[] {
  const warnings: string[] = [];
  if (output.truncated) {
    warnings.push("Result was truncated by the configured row limit.");
  }
  if (!/\border\s+by\b/i.test(sql) && output.rows.length > 1) {
    warnings.push("No ORDER BY was detected. Result order may be unstable.");
  }
  if (jsonByteLength(output) > config.maxResultBytes * 0.8) {
    warnings.push("Result size is close to OB_MAX_RESULT_BYTES.");
  }
  return warnings;
}

function enrichQueryOutput(output: QueryOutput, config: ObConfig, warnings: string[] = []) {
  const columns = queryOutputColumns(output, config);
  const maskedRows = maskQueryRows(output.rows, columns);
  const maskedColumns = columns.filter((column) => column.masked).map((column) => column.name);
  const combinedWarnings = [...warnings];
  if (maskedColumns.length > 0) {
    combinedWarnings.push(`Masked result columns: ${maskedColumns.join(", ")}.`);
  }
  return {
    ...output,
    rows: maskedRows,
    columns,
    markdownPreview: renderMarkdownPreview(maskedRows, columns.map((column) => column.name)),
    warnings: [...new Set(combinedWarnings)]
  };
}

function queryOutputColumns(output: QueryOutput, config: ObConfig) {
  if (output.fields && output.fields.length > 0) {
    return output.fields.map((field) => ({
      name: field.name,
      table: field.table,
      schema: field.database,
      columnType: field.columnType,
      masked: shouldMaskColumnValue(field.name, config, field.database, field.table)
    }));
  }

  const firstRow = output.rows.find((row) => row && typeof row === "object" && !Array.isArray(row));
  if (!firstRow || typeof firstRow !== "object" || Array.isArray(firstRow)) {
    return [];
  }
  return Object.keys(firstRow as Record<string, unknown>).map((name) => ({
    name,
    masked: shouldMaskColumnValue(name, config)
  }));
}

function maskQueryRows(rows: unknown[], columns: Array<{ name: string; masked: boolean }>): unknown[] {
  if (columns.length === 0) {
    return rows;
  }
  const masked = new Set(columns.filter((column) => column.masked).map((column) => column.name));
  if (masked.size === 0) {
    return rows;
  }
  return rows.map((row) => {
    if (!row || typeof row !== "object" || Array.isArray(row)) {
      return row;
    }
    const output: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(row)) {
      output[key] = masked.has(key) ? "***MASKED***" : value;
    }
    return output;
  });
}

function renderMarkdownPreview(rows: unknown[], columnNames: string[]): string {
  if (rows.length === 0 || columnNames.length === 0) {
    return "";
  }
  const visibleColumns = columnNames.slice(0, 12);
  const visibleRows = rows.slice(0, 10);
  const header = `| ${visibleColumns.map(markdownCell).join(" | ")} |`;
  const divider = `| ${visibleColumns.map(() => "---").join(" | ")} |`;
  const body = visibleRows.map((row) => {
    const record = row && typeof row === "object" && !Array.isArray(row) ? row as Record<string, unknown> : {};
    return `| ${visibleColumns.map((column) => markdownCell(formatPreviewValue(record[column]))).join(" | ")} |`;
  });
  return [header, divider, ...body].join("\n");
}

function formatPreviewValue(value: unknown): string {
  if (value == null) {
    return "";
  }
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length > 80 ? `${text.slice(0, 77)}...` : text;
}

function markdownCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

export function effectiveRowLimit(requested: number | undefined, config: ObConfig): number {
  return Math.min(requested ?? config.maxRows, config.maxRows);
}

function selectAuthorizedProfile(runtime: GatewayRuntime, profile: string | undefined, context: McpRequestContext) {
  const selected = selectRuntimeProfile(runtime, profile?.trim() || visibleDefaultProfile(runtime, context));
  assertProfileAllowed(selected.profile, context.principal);
  return selected;
}

function assertProfileAllowed(profile: string, principal: AuthPrincipal | undefined): void {
  if (!principal?.profiles || principal.profiles.length === 0) {
    return;
  }
  if (!principal.profiles.includes(profile)) {
    throw new Error(`Profile "${profile}" is not allowed for token "${principal.name}".`);
  }
}

function assertToolAllowed(tool: string, principal: AuthPrincipal | undefined): void {
  if (!isToolAllowed(tool, principal)) {
    throw new Error(`Tool "${tool}" is not allowed for token "${principal?.name ?? "unknown"}".`);
  }
}

export function isToolAllowed(tool: string, principal: AuthPrincipal | undefined): boolean {
  return !principal?.tools || principal.tools.length === 0 || principal.tools.includes(tool);
}

function visibleDefaultProfile(runtime: GatewayRuntime, context: McpRequestContext): string {
  if (isProfileVisible(runtime.defaultProfile, context.principal)) {
    return runtime.defaultProfile;
  }
  const firstVisible = Object.keys(runtime.configs).find((profile) => isProfileVisible(profile, context.principal));
  if (!firstVisible) {
    throw new Error(`No OceanBase MCP profile is allowed for token "${context.principal?.name ?? "unknown"}".`);
  }
  return firstVisible;
}

function publicProfiles(runtime: GatewayRuntime, context: McpRequestContext) {
  return Object.fromEntries(
    Object.entries(runtime.configs)
      .filter(([name]) => isProfileVisible(name, context.principal))
      .map(([name, config]) => [name, publicConfig(config)])
  );
}

function authorizedGatewayConfig(runtime: GatewayRuntime, context: McpRequestContext): GatewayConfig {
  return {
    defaultProfile: visibleDefaultProfile(runtime, context),
    profiles: Object.fromEntries(
      Object.entries(runtime.configs).filter(([name]) => isProfileVisible(name, context.principal))
    )
  };
}

function isProfileVisible(profile: string, principal: AuthPrincipal | undefined): boolean {
  return !principal?.profiles || principal.profiles.length === 0 || principal.profiles.includes(profile);
}

function gatewayLimitConfig(runtime: GatewayRuntime, context: McpRequestContext): ObConfig {
  return runtime.configs[visibleDefaultProfile(runtime, context)];
}

function columnNames(rows: unknown[]): string[] {
  const names: string[] = [];
  for (const row of rows) {
    const record = row as Record<string, unknown>;
    const value = record.column_name ?? record.COLUMN_NAME;
    if (typeof value === "string" && value.trim()) {
      names.push(value.trim());
    }
  }
  return [...new Set(names)];
}

function maskOutput(output: QueryOutput, config: ObConfig, schema?: string, table?: string): QueryOutput {
  return {
    ...output,
    rows: output.rows.map((row) => {
      if (!row || typeof row !== "object" || Array.isArray(row)) {
        return row;
      }
      const masked: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(row)) {
        masked[key] = shouldMaskColumnValue(key, config, schema, table) ? "***MASKED***" : value;
      }
      return masked;
    })
  };
}

export function shouldMaskColumnValue(column: string, config: ObConfig, schema?: string, table?: string): boolean {
  return (
    isMaskedColumn(column, config.policy, schema, table) ||
    isDeniedColumn(column, config.policy) ||
    SENSITIVE_SAMPLE_PATTERN.test(column)
  );
}

function sanitizeObjectMetadata(metadata: unknown, config: ObConfig): Record<string, unknown> {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return { value: metadata };
  }
  const record = metadata as Record<string, unknown>;
  const columns = Array.isArray(record.columns) ? filterColumnMetadata(record.columns, config.policy) : undefined;
  const argumentRows = Array.isArray(record.arguments) ? filterArgumentMetadata(record.arguments, config) : undefined;
  const sourcePreview = sanitizeSourcePreview(record.sourcePreview, config);
  const policyFiltered =
    (Array.isArray(record.columns) && columns && columns.length !== record.columns.length) ||
    (Array.isArray(record.arguments) && argumentRows && argumentRows.length !== record.arguments.length);

  return {
    ...record,
    ...(columns ? { columns } : {}),
    ...(argumentRows ? { arguments: argumentRows } : {}),
    ...(sourcePreview ? { sourcePreview } : {}),
    policyFiltered
  };
}

function filterArgumentMetadata(rows: unknown[], config: ObConfig): unknown[] {
  return rows.filter((row) => {
    const record = row as Record<string, unknown>;
    const argument = stringRecordValue(record, "argument_name", "ARGUMENT_NAME");
    return !argument || !isDeniedColumn(argument, config.policy);
  });
}

function sanitizeSourcePreview(sourcePreview: unknown, config: ObConfig): unknown {
  if (!sourcePreview || typeof sourcePreview !== "object" || Array.isArray(sourcePreview)) {
    return sourcePreview;
  }
  const preview = sourcePreview as Record<string, unknown>;
  const lines = Array.isArray(preview.lines)
    ? preview.lines.map((line) => {
        if (!line || typeof line !== "object" || Array.isArray(line)) {
          return line;
        }
        const record = line as Record<string, unknown>;
        return {
          ...record,
          text: typeof record.text === "string" ? redactSensitiveText(record.text, config) : record.text
        };
      })
    : preview.lines;

  return {
    ...preview,
    lines,
    text: typeof preview.text === "string" ? redactSensitiveText(preview.text, config) : preview.text
  };
}

function redactSensitiveText(text: string, config: ObConfig): string {
  let redacted = text.replace(new RegExp(SENSITIVE_SAMPLE_PATTERN.source, "gi"), "***MASKED***");
  for (const pattern of config.policy.deniedColumns) {
    for (const token of deniedColumnTokens(pattern)) {
      redacted = redacted.replace(new RegExp(escapeRegExp(token), "gi"), "***MASKED***");
    }
  }
  return redacted;
}

function deniedColumnTokens(pattern: string): string[] {
  return [
    pattern,
    ...pattern.split(".")
  ]
    .map((part) => part.replace(/\*/g, "").trim())
    .filter((part) => part.length >= 3);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function stringVariable(value: string | string[] | undefined): string {
  if (Array.isArray(value)) {
    return value[0] ?? "";
  }
  return value ?? "";
}

function resourceResult(uri: string, data: unknown, config?: ObConfig) {
  if (config) {
    assertJsonByteLimit(data, config.maxResultBytes);
  }
  return {
    contents: [
      {
        uri,
        mimeType: "application/json",
        text: jsonText(data)
      }
    ]
  };
}

function toLimitedResult(data: unknown, config: ObConfig) {
  assertJsonByteLimit(data, config.maxResultBytes);
  return toResult(data);
}

function toGatewayLimitedResult(data: unknown, runtime: GatewayRuntime, context: McpRequestContext) {
  return toLimitedResult(data, gatewayLimitConfig(runtime, context));
}

function toResult(data: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: jsonText(data)
      }
    ]
  };
}

function toErrorResult(error: unknown, args?: unknown) {
  return {
    isError: true,
    content: [
      {
        type: "text" as const,
        text: jsonText({
          ok: false,
          error: serializeError(error, { includeSqlMessage: false }),
          hints: errorHints(error, args)
        })
      }
    ]
  };
}

function runExplainCheck(name: string, check: () => void) {
  try {
    check();
    return { name, ok: true, message: "Allowed." };
  } catch (error) {
    return { name, ok: false, message: (error as Error).message };
  }
}

function explainGeneratedQuery(sql: string, paramCount: number, config: ObConfig) {
  const params = Array.from({ length: paramCount }, () => null);
  const sqlChecks = [
    runExplainCheck("input_limits", () => assertSqlInputLimits(sql, params, config)),
    runExplainCheck("read_only_sql", () => assertReadOnlySql(sql))
  ];
  const policy = explainSqlPolicy(sql, policyContext(config));
  return {
    allowed: sqlChecks.every((check) => check.ok) && policy.allowed,
    checks: [...sqlChecks, ...policy.checks],
    tableRefs: policy.tableRefs
  };
}

function safeTool<Args>(
  name: string,
  handler: (args: Args) => Promise<ReturnType<typeof toResult>>,
  context: McpRequestContext
) {
  return async (args: Args) => {
    const started = Date.now();
    const finish = metrics.startToolCall();
    try {
      assertToolAllowed(name, context.principal);
      const result = await handler(args);
      logAudit("tool_call", {
        ok: true,
        tool: name,
        transport: context.transport ?? "stdio",
        requestId: context.requestId,
        clientId: context.clientId,
        principal: context.principal?.name,
        durationMs: Date.now() - started,
        ...auditArgs(args)
      });
      return result;
    } catch (error) {
      metrics.recordToolBlocked();
      metrics.recordToolError();
      logAudit("tool_call", {
        ok: false,
        tool: name,
        transport: context.transport ?? "stdio",
        requestId: context.requestId,
        clientId: context.clientId,
        principal: context.principal?.name,
        durationMs: Date.now() - started,
        blockedReason: (error as Error).message,
        ...auditArgs(args)
      });
      logError(name, error);
      return toErrorResult(error, args);
    } finally {
      finish();
    }
  };
}

function errorHints(error: unknown, args: unknown): string[] {
  const message = (error as Error)?.message ?? String(error);
  const lower = message.toLowerCase();
  const sql = args && typeof args === "object" && "sql" in args ? String((args as Record<string, unknown>).sql ?? "") : "";
  const hints: string[] = [];

  if (/unknown column|invalid identifier|ora-00904|1054/.test(lower)) {
    hints.push("Column was not found. Search visible metadata with ob_search_catalog, then read table details with ob_get_table_context.");
    hints.push("In Oracle mode, check object and column casing. Unquoted identifiers are usually uppercase.");
  }
  if (/unknown table|table .* doesn't exist|ora-00942|1146/.test(lower)) {
    hints.push("Table was not found or is not visible. Search visible schemas and tables with ob_search_catalog or ob_list_tables.");
    hints.push("Check whether the SQL uses the configured schema and whether that schema is allowed by policy.");
  }
  if (/not allowed by the configured oceanbase mcp access policy|not allowed for token|blocked by ob_denied_columns|select \*/.test(lower)) {
    hints.push("The request was blocked by MCP policy. Use ob_policy_explain or ob_query_preview to inspect the failing check.");
    hints.push("Use explicit columns and allowed schema-qualified tables.");
  }
  if (/only read-only sql|write\/control keyword|multiple sql statements|side-effect|explain analyze|nextval/.test(lower)) {
    hints.push("Only read-only SELECT, WITH, and safe EXPLAIN statements are allowed.");
    hints.push("Remove writes, DDL, DCL, procedure calls, sequence NEXTVAL, locks, sleeps, file functions, and extra statements.");
  }
  if (/limit|offset|fetch|rownum|orderby must contain|paged query input/.test(lower)) {
    hints.push("For ob_query_page, pass SQL without existing LIMIT, OFFSET/FETCH, or ROWNUM pagination.");
    hints.push("Use orderBy only with simple identifiers, optional ASC/DESC, and comma separators.");
  }
  if (/access denied|permission|privilege|ora-01031|1044|1142/.test(lower)) {
    hints.push("The database account may not have the required read or metadata privilege. Run ob_verify_permissions and check grants.");
  }
  if (sql && !/\border\s+by\b/i.test(sql) && /ob_query_page|paged/i.test(lower)) {
    hints.push("Add a stable ORDER BY for repeatable pagination.");
  }

  return [...new Set(hints)];
}

function auditArgs(args: unknown): Record<string, unknown> {
  if (!args || typeof args !== "object") {
    return {};
  }
  const record = args as Record<string, unknown>;
  const output: Record<string, unknown> = {};
  for (const key of ["profile", "schema", "table", "objectName", "objectType", "depth", "limit", "maxRows", "mask"]) {
    if (record[key] != null) {
      output[key] = record[key];
    }
  }
  if (Array.isArray(record.objectTypes)) {
    output.objectTypes = record.objectTypes;
  }
  if (typeof record.sql === "string") {
    output.sqlLength = record.sql.length;
  }
  if (Array.isArray(record.params)) {
    output.paramCount = record.params.length;
  }
  if (typeof record.query === "string") {
    output.queryLength = record.query.length;
  }
  return output;
}
