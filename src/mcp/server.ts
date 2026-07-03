import { randomUUID } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { extname, relative, resolve } from "node:path";

import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import {
  assertToolManifest,
  buildUsageGuide,
  getToolCapability,
  listCapabilities,
  SERVER_VERSION,
  TOOL_CAPABILITIES
} from "../capabilities.js";
import type { HttpConfig, ObConfig } from "../config.js";
import { publicConfig } from "../config.js";
import {
  describeTable,
  estimateErExportPlanStats,
  findColumns,
  findRelatedTables,
  getObjectMetadata,
  getTableDdlMetadata,
  getTableStats,
  loadErMetadataBatch,
  listErForeignKeyRelationshipsBatch,
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
  type TableRef,
  type TableRelationship,
  type SqlParam
} from "../db.js";
import { diagnoseGateway } from "../diagnostics.js";
import { buildErDiagram, renderErDot, renderErHtml, renderErMarkdown, renderErPlantUml, type ErDiagram, type ErEntity } from "../er.js";
import type { ErGraph, ErGraphDiagnostic, ErGraphStatus } from "../er-graph.js";
import { logAudit, logError, logSlowOperation, recordCrashBreadcrumb, serializeError } from "../errors.js";
import { assertJsonByteLimit, jsonByteLength, jsonText, type QueryOutput } from "../format.js";
import { captureMetadataSnapshot } from "../metadata-capture.js";
import { analyzeChangeSqlImpact, analyzeMetadataImpact } from "../metadata-impact.js";
import { compareMetadataSnapshots } from "../metadata-change.js";
import { generateMetadataChangeReport } from "../metadata-report.js";
import { metrics } from "../metrics.js";
import { analyzeQueryPlan } from "../plan-analysis.js";
import { buildPerformanceReport } from "../performance-report.js";
import { diagnoseOpenCodeSetup } from "../local-diagnostics.js";
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
  isDeniedColumn
} from "../policy.js";
import {
  effectiveRowLimit,
  enrichQueryOutput,
  markdownCell,
  maskOutput,
  pagedQueryWarnings,
  queryResultWarnings,
  shouldMaskColumnValue
} from "../query/output.js";
import { hasSqlRowLimit, queryPreviewWarnings, queryShape, sensitiveSqlTerms } from "../query/preview.js";
import { buildResultPreview, compareQueryResultRows, summarizeQueryResultRows } from "../query/result-tools.js";
import {
  cleanupQuerySessions,
  ensureQuerySessionStore,
  getQuerySessionForProfile,
  publicQuerySession,
  pruneQuerySessions,
  querySessionMasking,
  QUERY_SESSION_TTL_MS,
  validateQuerySessionColumns,
  type QuerySessionState
} from "../query/sessions.js";
import { SENSITIVE_SAMPLE_PATTERN } from "../sensitive.js";
import { generateQueryTemplates, type QueryTemplateScenario } from "../query-generation.js";
import { selectRuntimeProfile, withMetadataCache, withQuerySlot, type GatewayRuntime } from "../runtime.js";
import { assertReadOnlySql, assertSqlInputLimits, buildExplainSql, buildPagedReadOnlySql, prepareReadOnlySql } from "../sql.js";
import { extractSqlSnippetsFromContent, type SqlScanSnippet } from "../sql-scan.js";
import { findSqlUsages } from "../sql-usage.js";
import {
  assertToolAllowed,
  authorizedGatewayConfig,
  gatewayLimitConfig,
  isToolAllowed,
  publicProfiles,
  selectAuthorizedProfile,
  visibleDefaultProfile
} from "./access.js";
import type { McpRequestContext } from "./context.js";
import {
  buildSelectFilterSchema,
  buildSelectOrderBySchema,
  compatibilityModeSchema,
  dataDictionaryFormatSchema,
  entityDiagramOutputFormatSchema,
  erDocumentFormatSchema,
  erExportStrategySchema,
  erHtmlFormatSchema,
  erRelationshipModeSchema,
  metadataChangeReportFormatSchema,
  metadataDiffInputSchema,
  metadataImpactInputSchema,
  metadataSnapshotInputSchema,
  oracleObjectTypeSchema,
  profileInput,
  queryScenarioSchema,
  resultSummaryColumnSchema,
  sqlParamSchema,
  sqlUsageIndexInputSchema,
  tableDocumentFormatSchema,
  type BuildSelectFilter,
  type BuildSelectOrderBy
} from "./schemas.js";

export { effectiveRowLimit, shouldMaskColumnValue } from "../query/output.js";
export { isToolAllowed } from "./access.js";
export type { McpRequestContext } from "./context.js";

const SCHEMA_INLINE_ER_TABLE_RENDER_LIMIT = 25;
const TOOL_TIMEOUT_GRACE_MS = 250;
const LARGE_TABLE_CONTEXT_SAMPLE_ROW_THRESHOLD = 100_000;
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
    safeTool(name, handler, context, runtime);
  const registerTool = (
    name: string,
    spec: {
      title: string;
      description: string;
      inputSchema: Record<string, z.ZodType>;
    },
    handler: (args: any) => Promise<ReturnType<typeof toResult>>
  ) => {
    assertToolManifest(name);
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
    "ob_refresh_metadata_cache",
    {
      title: "Refresh Metadata Cache",
      description: "Clear in-memory metadata cache entries for the active profile, optionally scoped by schema or table.",
      inputSchema: {
        ...profileInput,
        schema: z.string().optional(),
        table: z.string().optional()
      }
    },
    async ({ profile, schema, table }) => {
      const selected = selectAuthorizedProfile(runtime, profile, context);
      const effectiveSchema = metadataSchema(selected.config, schema);
      if (effectiveSchema && !isSchemaAllowed(effectiveSchema, selected.config.policy)) {
        throw new Error(`Schema "${effectiveSchema}" is not allowed by the configured OceanBase MCP access policy.`);
      }
      if (table) {
        assertTableAccess(effectiveSchema, table, policyContext(selected.config));
      }
      return toLimitedResult(
        refreshMetadataCache(selected, effectiveSchema, table),
        selected.config
      );
    }
  );

  registerTool(
    "ob_get_cache_status",
    {
      title: "Get Metadata Cache Status",
      description: "Return profile-scoped metadata cache settings and counters without exposing cached content.",
      inputSchema: profileInput
    },
    async ({ profile }) => {
      const selected = selectAuthorizedProfile(runtime, profile, context);
      return toLimitedResult(
        metadataCacheStatus(selected),
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
        schema: z.string().optional(),
        maxColumns: z.number().int().positive().max(10_000).optional()
      }
    },
    async ({ profile, table, schema, maxColumns }) => {
      const selected = selectAuthorizedProfile(runtime, profile, context);
      const effectiveSchema = metadataSchema(selected.config, schema);
      assertTableAccess(effectiveSchema, table, policyContext(selected.config));
      const rows = await withQuerySlot(selected, () =>
        describeTable(selected.pool, selected.config.compatibility, table, effectiveSchema, selected.config.queryTimeoutMs)
      );
      return toLimitedResult(
        describeTablePayload(filterColumnMetadata(rows, selected.config.policy), selected.config, maxColumns),
        selected.config
      );
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
      const rawTables = await cachedSchemaMapTables(selected, effectiveSchema, tablePattern, tableLimit + 1);
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
        maxTables: z.number().int().positive().max(500).optional(),
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
      const rawTables = await cachedSchemaMapTables(selected, effectiveSchema, tablePattern, tableLimit + 1);
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
    "ob_generate_data_dictionary",
    {
      title: "Generate Data Dictionary",
      description: "Generate bounded JSON, Markdown, or simple HTML data dictionary output from visible metadata.",
      inputSchema: {
        ...profileInput,
        schema: z.string().optional(),
        tablePattern: z.string().optional(),
        format: dataDictionaryFormatSchema.optional().default("markdown"),
        maxTables: z.number().int().positive().max(500).optional(),
        maxColumnsPerTable: z.number().int().positive().max(100).optional(),
        title: z.string().min(1).max(120).optional()
      }
    },
    async ({ profile, schema, tablePattern, format = "markdown", maxTables, maxColumnsPerTable, title }) => {
      const selected = selectAuthorizedProfile(runtime, profile, context);
      const effectiveSchema = metadataSchema(selected.config, schema);
      if (effectiveSchema && !isSchemaAllowed(effectiveSchema, selected.config.policy)) {
        throw new Error(`Schema "${effectiveSchema}" is not allowed by the configured OceanBase MCP access policy.`);
      }
      const tableLimit = Math.min(maxTables ?? 30, 200);
      const columnLimit = Math.min(maxColumnsPerTable ?? 50, 100);
      const rawTables = await cachedSchemaMapTables(selected, effectiveSchema, tablePattern, tableLimit + 1);
      const visibleTables = filterSchemaMapTables(rawTables, selected.config).slice(0, tableLimit);
      const dictionary = await buildDatabaseDictionary(selected, visibleTables, columnLimit);
      const warnings = uniqueStrings([
        rawTables.length > tableLimit ? `Only the first ${tableLimit} visible tables are included. Narrow schema or tablePattern for a smaller dictionary.` : "",
        dictionary.tables.some((table) => table.columnsTruncated) ? `Some tables have more than ${columnLimit} visible columns; columns were truncated.` : "",
        "Data dictionary output is based on metadata visible to the active MCP policy.",
        "No sample data values are included."
      ]);
      return toLimitedResult(
        {
          format,
          mode: selected.config.compatibility,
          schema: effectiveSchema ?? null,
          tablePattern: tablePattern ?? null,
          tableCount: dictionary.tables.length,
          dictionary,
          markdown: format === "markdown" ? renderDatabaseDictionaryMarkdown(dictionary) : undefined,
          html: format === "html" ? renderDataDictionaryHtml(dictionary, title) : undefined,
          contentType: format === "html" ? "text/html" : undefined,
          warnings,
          executed: false
        },
        selected.config
      );
    }
  );

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
        maxTables: z.number().int().positive().max(500).optional(),
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
        const rowEstimate = statistics.rowEstimate?.value;
        const skipLargeTableSample =
          sampleLimit == null &&
          rowEstimate != null &&
          rowEstimate >= LARGE_TABLE_CONTEXT_SAMPLE_ROW_THRESHOLD;
        if (skipLargeTableSample) {
          warnings.push(
            `Sample rows were skipped because the table row estimate is ${rowEstimate}. Pass sampleLimit explicitly to request a bounded sample.`
          );
        } else {
          const sampleColumns = safeSampleColumnNames(columns).slice(0, 50);
          const skippedLargeColumns = columnNames(columns).filter((column) => !sampleColumns.includes(column));
          if (skippedLargeColumns.length > 0) {
            warnings.push(`Sample rows skipped large or binary columns: ${skippedLargeColumns.slice(0, 10).join(", ")}${skippedLargeColumns.length > 10 ? ", ..." : ""}.`);
          }
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
                selected.config.queryTimeoutMs,
                selected.config.maxResultBytes
              )
            );
            assertOutputAllowed(output, selected.config.policy);
            sample = maskOutput(output, selected.config, effectiveSchema, table);
          }
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
    "ob_profile_table",
    {
      title: "Profile Table",
      description: "Return a bounded table-level profile with metadata counts, key fields, time/status fields, and sampled null overview.",
      inputSchema: {
        ...profileInput,
        table: z.string().min(1),
        schema: z.string().optional(),
        rowLimit: z.number().int().positive().max(10_000).optional(),
        maxProfileColumns: z.number().int().positive().max(50).optional(),
        topValues: z.number().int().positive().max(10).optional(),
        sampleValues: z.number().int().positive().max(10).optional(),
        includeColumnProfiles: z.boolean().optional().default(true)
      }
    },
    async ({ profile, table, schema, rowLimit, maxProfileColumns, topValues, sampleValues, includeColumnProfiles = true }) => {
      const selected = selectAuthorizedProfile(runtime, profile, context);
      const effectiveSchema = metadataSchema(selected.config, schema);
      assertTableAccess(effectiveSchema, table, policyContext(selected.config));
      const metadata = await withQuerySlot(selected, () =>
        getTableDdlMetadata(selected.pool, selected.config.compatibility, table, effectiveSchema, selected.config.queryTimeoutMs)
      );
      const stats = await withQuerySlot(selected, () =>
        getTableStats(selected.pool, selected.config.compatibility, metadata.table, metadata.schema, selected.config.queryTimeoutMs)
      );
      const visibleColumns = filterColumnMetadata(metadata.columns, selected.config.policy);
      const visibleIndexes = filterColumnMetadata(metadata.indexes, selected.config.policy);
      const visibleConstraints = filterColumnMetadata(metadata.constraints, selected.config.policy);
      const compactColumns = compactSchemaColumns(visibleColumns, visibleConstraints, selected.config, metadata.schema, metadata.table);
      const primaryKeys = schemaMapPrimaryKeyColumns(visibleConstraints);
      const timeFields = compactColumns.filter((column) => column.roles.includes("time")).map((column) => column.name);
      const statusFields = compactColumns.filter((column) => column.roles.includes("status")).map((column) => column.name);
      const profileRowLimit = Math.min(effectiveRowLimit(rowLimit, selected.config), 10_000);
      const effectiveTopLimit = Math.min(topValues ?? 5, 10);
      const effectiveSampleLimit = Math.min(sampleValues ?? 3, 10);
      const selectedProfileColumns = includeColumnProfiles
        ? selectTableProfileColumns(compactColumns, primaryKeys, maxProfileColumns ?? 12)
        : [];
      const rawColumnProfiles = selectedProfileColumns.length > 0
        ? await withQuerySlot(selected, () =>
            profileColumns(
              selected.pool,
              selected.config.compatibility,
              metadata.schema,
              metadata.table,
              selectedProfileColumns.map((column) => ({ name: column.name, dataType: column.type })),
              profileRowLimit,
              effectiveTopLimit,
              effectiveSampleLimit,
              selected.config.queryTimeoutMs
            )
          )
        : undefined;
      const columnProfiles = rawColumnProfiles
        ? tableProfileMaskedColumns(rawColumnProfiles, compactColumns, selected.config, metadata.schema, metadata.table)
        : [];
      const warnings = tableProfileWarnings(
        [...metadata.warnings, ...stats.warnings],
        rawColumnProfiles?.warnings ?? [],
        stats.rowEstimate?.value,
        profileRowLimit,
        compactColumns.length,
        selectedProfileColumns.length,
        includeColumnProfiles
      );

      return toLimitedResult(
        {
          mode: selected.config.compatibility,
          schema: metadata.schema,
          table: metadata.table,
          rowEstimate: stats.rowEstimate,
          objectCounts: {
            visibleColumns: compactColumns.length,
            visibleIndexes: visibleIndexes.length,
            visibleConstraints: visibleConstraints.length,
            partitions: metadata.partitions.length,
            catalog: stats.counts
          },
          storage: stats.storage,
          analyzedAt: stats.analyzedAt,
          primaryKeys,
          keyFields: importantSchemaMapFields(compactColumns, primaryKeys, timeFields, statusFields),
          timeFields: tableProfileTimeFields(timeFields, columnProfiles),
          statusFields: tableProfileStatusFields(statusFields, columnProfiles),
          nullableColumns: compactColumns.filter((column) => column.nullable).map((column) => column.name).slice(0, 50),
          nullOverview: tableProfileNullOverview(columnProfiles),
          indexSummary: tableProfileIndexSummary(visibleIndexes),
          profileScope: {
            enabled: includeColumnProfiles,
            rowLimit: profileRowLimit,
            topValues: effectiveTopLimit,
            sampleValues: effectiveSampleLimit,
            selectedColumns: selectedProfileColumns.map((column) => column.name),
            visibleColumnCount: compactColumns.length,
            selectedColumnCount: selectedProfileColumns.length
          },
          columnProfiles,
          warnings
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
              return enrichColumnProfile(profileResult, metadata, selected.config, result.schema, result.table);
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
    "ob_get_value_distribution",
    {
      title: "Get Value Distribution",
      description: "Return bounded top-value distribution for one allowed column, with masking and sample limits enforced.",
      inputSchema: {
        ...profileInput,
        table: z.string().min(1),
        column: z.string().min(1),
        schema: z.string().optional(),
        rowLimit: z.number().int().positive().max(10_000).optional(),
        topN: z.number().int().positive().max(100).optional()
      }
    },
    async ({ profile, table, column, schema, rowLimit, topN }) => {
      const selected = selectAuthorizedProfile(runtime, profile, context);
      const effectiveSchema = metadataSchema(selected.config, schema);
      assertTableAccess(effectiveSchema, table, policyContext(selected.config));
      const metadataRows = await withQuerySlot(selected, () =>
        describeTable(selected.pool, selected.config.compatibility, table, effectiveSchema, selected.config.queryTimeoutMs)
      );
      const visibleColumns = filterColumnMetadata(metadataRows, selected.config.policy);
      const selectedColumn = selectProfileColumns(visibleColumns, selected.config.compatibility, [column], 1)[0];
      const profileRowLimit = Math.min(effectiveRowLimit(rowLimit, selected.config), 10_000);
      const effectiveTopN = Math.min(topN ?? 10, 100);
      const stats = await withQuerySlot(selected, () =>
        getTableStats(selected.pool, selected.config.compatibility, table, effectiveSchema, selected.config.queryTimeoutMs)
      );
      const result = await withQuerySlot(selected, () =>
        profileColumns(
          selected.pool,
          selected.config.compatibility,
          effectiveSchema,
          table,
          [{ name: selectedColumn.name, dataType: selectedColumn.dataType }],
          profileRowLimit,
          effectiveTopN,
          1,
          selected.config.queryTimeoutMs
        )
      );
      const masked = maskColumnProfileResult(
        {
          ...result,
          columns: result.columns.map((profileResult) =>
            enrichColumnProfile(profileResult, selectedColumn, selected.config, result.schema, result.table)
          )
        },
        selected.config,
        result.schema,
        result.table
      );
      const profiledColumn = (masked.columns?.[0] ?? {}) as Record<string, unknown>;
      const distribution = Array.isArray(profiledColumn.topValues) ? profiledColumn.topValues : [];
      return toLimitedResult(
        {
          mode: selected.config.compatibility,
          schema: result.schema,
          table: result.table,
          column: stringRecordValue(profiledColumn, "column", "COLUMN") ?? selectedColumn.name,
          dataType: profiledColumn.dataType,
          typeCategory: profiledColumn.typeCategory,
          rowLimit: profileRowLimit,
          topN: effectiveTopN,
          sampledRows: numberRecordValue(profiledColumn, "sampledRows", "sampled_rows") ?? 0,
          nulls: profiledColumn.nulls,
          distinct: profiledColumn.distinct,
          distribution,
          enumCandidate: profiledColumn.enumCandidate,
          masked: Boolean(profiledColumn.masked),
          warnings: valueDistributionWarnings(
            result.warnings,
            stats.rowEstimate?.value,
            profileRowLimit,
            effectiveTopN,
            distribution.length,
            Boolean(profiledColumn.masked)
          )
        },
        selected.config
      );
    }
  );

  registerTool(
    "ob_detect_time_columns",
    {
      title: "Detect Time Columns",
      description: "Detect likely create, update, and business time columns from visible table metadata.",
      inputSchema: {
        ...profileInput,
        table: z.string().min(1),
        schema: z.string().optional(),
        maxColumns: z.number().int().positive().max(50).optional()
      }
    },
    async ({ profile, table, schema, maxColumns }) => {
      const selected = selectAuthorizedProfile(runtime, profile, context);
      const effectiveSchema = metadataSchema(selected.config, schema);
      assertTableAccess(effectiveSchema, table, policyContext(selected.config));
      const metadataRows = await withQuerySlot(selected, () =>
        describeTable(selected.pool, selected.config.compatibility, table, effectiveSchema, selected.config.queryTimeoutMs)
      );
      const visibleColumns = filterColumnMetadata(metadataRows, selected.config.policy);
      const candidates = detectTimeColumnCandidates(
        visibleColumns,
        selected.config,
        effectiveSchema,
        table,
        maxColumns ?? 20
      );
      return toLimitedResult(
        {
          mode: selected.config.compatibility,
          schema: effectiveSchema,
          table,
          candidates,
          warnings: candidates.length === 0
            ? ["No likely time columns were detected from visible metadata. Ask the user to provide the time column explicitly."]
            : ["Time-column detection is metadata-based; verify semantics before using the column as a business time filter."]
        },
        selected.config
      );
    }
  );

  registerTool(
    "ob_detect_dimension_columns",
    {
      title: "Detect Dimension Columns",
      description: "Detect likely status, type, channel, region, flag, and category columns from visible table metadata.",
      inputSchema: {
        ...profileInput,
        table: z.string().min(1),
        schema: z.string().optional(),
        maxColumns: z.number().int().positive().max(50).optional()
      }
    },
    async ({ profile, table, schema, maxColumns }) => {
      const selected = selectAuthorizedProfile(runtime, profile, context);
      const effectiveSchema = metadataSchema(selected.config, schema);
      assertTableAccess(effectiveSchema, table, policyContext(selected.config));
      const metadataRows = await withQuerySlot(selected, () =>
        describeTable(selected.pool, selected.config.compatibility, table, effectiveSchema, selected.config.queryTimeoutMs)
      );
      const visibleColumns = filterColumnMetadata(metadataRows, selected.config.policy);
      const candidates = detectDimensionColumnCandidates(
        visibleColumns,
        selected.config,
        effectiveSchema,
        table,
        maxColumns ?? 20
      );
      return toLimitedResult(
        {
          mode: selected.config.compatibility,
          schema: effectiveSchema,
          table,
          candidates,
          warnings: candidates.length === 0
            ? ["No likely dimension columns were detected from visible metadata."]
            : ["Dimension-column detection is metadata-based; verify semantics before using the column for grouping or filtering."]
        },
        selected.config
      );
    }
  );

  registerTool(
    "ob_find_recent_rows",
    {
      title: "Find Recent Rows",
      description: "Read recent rows from an allowed table using an explicit or metadata-detected time column with safe pagination.",
      inputSchema: {
        ...profileInput,
        table: z.string().min(1),
        schema: z.string().optional(),
        timeColumn: z.string().min(1).optional(),
        columns: z.array(z.string().min(1)).max(100).optional(),
        page: z.number().int().positive().optional().default(1),
        pageSize: z.number().int().positive().max(1_000).optional()
      }
    },
    async ({ profile, table, schema, timeColumn, columns, page = 1, pageSize }) => {
      const selected = selectAuthorizedProfile(runtime, profile, context);
      const effectiveSchema = metadataSchema(selected.config, schema);
      assertTableAccess(effectiveSchema, table, policyContext(selected.config));
      const metadataRows = await withQuerySlot(selected, () =>
        describeTable(selected.pool, selected.config.compatibility, table, effectiveSchema, selected.config.queryTimeoutMs)
      );
      const visibleColumns = filterColumnMetadata(metadataRows, selected.config.policy);
      const resolvedTime = resolveRecentRowsTimeColumn(visibleColumns, selected.config, effectiveSchema, table, timeColumn);
      const requestedColumns = recentRowsProjection(columns, resolvedTime.column);
      const built = buildStructuredSelect(
        selected.config,
        effectiveSchema,
        table,
        visibleColumns,
        {
          columns: requestedColumns,
          filters: [],
          orderBy: [{ column: resolvedTime.column, direction: "desc" }],
          pageSize,
          page
        }
      );
      const sqlParams = built.params as SqlParam[];
      assertSqlInputLimits(built.sql, sqlParams, selected.config);
      assertSqlPolicy(built.sql, policyContext(selected.config));
      const output = await withQuerySlot(selected, () =>
        runReadOnlyQuery(
          selected.pool,
          selected.config.compatibility,
          built.sql,
          sqlParams,
          built.pagination.pageSize,
          selected.config.queryTimeoutMs,
          selected.config.enforceReadOnlyTransaction,
          selected.config.maxResultBytes
        )
      );
      assertOutputAllowed(output, selected.config.policy);
      const visibleOutput = enrichQueryOutput(
        output,
        selected.config,
        recentRowsWarnings(built.warnings, resolvedTime, output.truncated)
      );
      const result = {
        mode: selected.config.compatibility,
        schema: effectiveSchema,
        table,
        timeColumn: resolvedTime,
        sql: built.sql,
        paramCount: sqlParams.length,
        page: built.pagination.page,
        pageSize: built.pagination.pageSize,
        columns: visibleOutput.columns,
        rows: visibleOutput.rows,
        markdownPreview: visibleOutput.markdownPreview,
        truncated: visibleOutput.truncated,
        warnings: visibleOutput.warnings,
        executed: true
      };
      assertJsonByteLimit(result, selected.config.maxResultBytes);
      return toResult(result);
    }
  );

  registerTool(
    "ob_check_data_quality",
    {
      title: "Check Data Quality",
      description: "Run bounded read-only data quality checks for nulls, duplicate key risk, dimensions, and time columns.",
      inputSchema: {
        ...profileInput,
        table: z.string().min(1),
        schema: z.string().optional(),
        columns: z.array(z.string().min(1)).max(50).optional(),
        rowLimit: z.number().int().positive().max(10_000).optional(),
        maxColumns: z.number().int().positive().max(50).optional(),
        nullRatioThreshold: z.number().min(0).max(1).optional()
      }
    },
    async ({ profile, table, schema, columns, rowLimit, maxColumns, nullRatioThreshold }) => {
      const selected = selectAuthorizedProfile(runtime, profile, context);
      const effectiveSchema = metadataSchema(selected.config, schema);
      assertTableAccess(effectiveSchema, table, policyContext(selected.config));
      const metadata = await withQuerySlot(selected, () =>
        getTableDdlMetadata(selected.pool, selected.config.compatibility, table, effectiveSchema, selected.config.queryTimeoutMs)
      );
      const visibleColumns = filterColumnMetadata(metadata.columns, selected.config.policy);
      const visibleConstraints = filterColumnMetadata(metadata.constraints, selected.config.policy);
      const compactColumns = compactSchemaColumns(visibleColumns, visibleConstraints, selected.config, metadata.schema, metadata.table);
      const primaryKeys = schemaMapPrimaryKeyColumns(visibleConstraints);
      const selectedColumns = selectDataQualityColumns(selected.config, compactColumns, primaryKeys, columns, maxColumns ?? 12);
      const profileRowLimit = Math.min(effectiveRowLimit(rowLimit, selected.config), 10_000);
      const result = selectedColumns.length > 0
        ? await withQuerySlot(selected, () =>
            profileColumns(
              selected.pool,
              selected.config.compatibility,
              metadata.schema,
              metadata.table,
              selectedColumns.map((column) => ({ name: column.name, dataType: column.type })),
              profileRowLimit,
              5,
              1,
              selected.config.queryTimeoutMs
            )
          )
        : undefined;
      const columnProfiles = result
        ? tableProfileMaskedColumns(result, compactColumns, selected.config, metadata.schema, metadata.table)
        : [];
      const checks = buildDataQualityChecks(
        columnProfiles,
        selectedColumns,
        primaryKeys,
        nullRatioThreshold ?? 0
      );

      return toLimitedResult(
        {
          mode: selected.config.compatibility,
          schema: metadata.schema,
          table: metadata.table,
          primaryKeys,
          profileScope: {
            rowLimit: profileRowLimit,
            selectedColumns: selectedColumns.map((column) => column.name),
            visibleColumnCount: compactColumns.length,
            selectedColumnCount: selectedColumns.length
          },
          checks,
          summary: summarizeDataQualityChecks(checks),
          columnProfiles,
          warnings: uniqueStrings([
            ...metadata.warnings,
            ...(result?.warnings ?? []),
            "Data quality checks use bounded samples; counts and ratios are not full-table exact values.",
            ...(compactColumns.length > selectedColumns.length
              ? [`Only ${selectedColumns.length} of ${compactColumns.length} visible columns were checked. Pass columns or maxColumns to change scope.`]
              : [])
          ])
        },
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

  registerTool(
    "ob_find_sql_usages",
    {
      title: "Find SQL Usages",
      description: "Find project SQL usages from a static SQL usage index without executing SQL or reading project files.",
      inputSchema: {
        ...profileInput,
        sqlIndex: sqlUsageIndexInputSchema,
        schema: z.string().optional(),
        table: z.string().optional(),
        column: z.string().optional(),
        businessTerm: z.string().optional(),
        maxResults: z.number().int().positive().max(200).optional()
      }
    },
    async ({ profile, sqlIndex, schema, table, column, businessTerm, maxResults }) => {
      const selected = selectAuthorizedProfile(runtime, profile, context);
      const result = findSqlUsages(sqlIndex, {
        schema: metadataSchema(selected.config, schema),
        table,
        column,
        businessTerm,
        maxResults
      });
      return toLimitedResult(result, selected.config);
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

  registerTool(
    "ob_generate_mapper_context",
    {
      title: "Generate Mapper Context",
      description: "Generate read-only table and column context for a MyBatis mapper, SQL file, or explicit table.",
      inputSchema: {
        ...profileInput,
        schema: z.string().optional(),
        table: z.string().optional(),
        sql: z.string().min(1).optional(),
        filePath: z.string().min(1).optional(),
        line: z.number().int().positive().optional(),
        format: z.enum(["json", "markdown"]).optional().default("json"),
        maxTables: z.number().int().positive().max(10).optional(),
        maxColumns: z.number().int().positive().max(200).optional()
      }
    },
    async ({ profile, schema, table, sql, filePath, line, format = "json", maxTables, maxColumns }) => {
      const selected = selectAuthorizedProfile(runtime, profile, context);
      const source = sql || filePath ? resolveProjectQuerySource(sql, filePath, line) : undefined;
      const policy = source ? explainSqlPolicy(source.sql, policyContext(selected.config)) : undefined;
      const maxTableCount = Math.min(maxTables ?? 5, 10);
      const allTableRefs = mapperContextTableRefs(
        selected.config,
        schema,
        table,
        policy?.tableRefs ?? [],
        50
      );
      const tableRefs = allTableRefs.slice(0, maxTableCount);
      if (tableRefs.length === 0) {
        throw new Error("Pass table, sql, or filePath so mapper context can identify at least one table.");
      }
      const tables = [];
      for (const ref of tableRefs) {
        tables.push(await buildMapperContextTable(selected, ref.schema, ref.table, Math.min(maxColumns ?? 80, 200)));
      }
      const payload = {
        mode: selected.config.compatibility,
        source: source?.source,
        sql: source?.sql,
        policy,
        tableCount: tables.length,
        tables,
        warnings: uniqueStrings([
          ...(source?.source.warnings ?? []),
          ...(allTableRefs.length > tableRefs.length ? ["Table list is capped by maxTables."] : [])
        ]),
        markdown: undefined as string | undefined
      };
      if (format === "markdown") {
        payload.markdown = renderMapperContextMarkdown(payload);
      }
      return toLimitedResult(payload, selected.config);
    }
  );

  registerTool(
    "ob_find_unknown_columns_in_sql",
    {
      title: "Find Unknown Columns In SQL",
      description: "Find unknown tables or columns in SQL and return visible metadata-based candidates without executing the SQL.",
      inputSchema: {
        ...profileInput,
        sql: z.string().min(1).optional(),
        filePath: z.string().min(1).optional(),
        line: z.number().int().positive().optional(),
        schema: z.string().optional(),
        maxCandidates: z.number().int().positive().max(20).optional()
      }
    },
    async ({ profile, sql, filePath, line, schema, maxCandidates }) => {
      const selected = selectAuthorizedProfile(runtime, profile, context);
      const source = resolveProjectQuerySource(sql, filePath, line);
      const candidateLimit = Math.min(maxCandidates ?? 5, 20);
      const lint = await lintReadOnlySql(selected, source.sql, [], effectiveRowLimit(undefined, selected.config), false);
      const policy = explainSqlPolicy(source.sql, policyContext(selected.config));
      const metadata = await validateSnippetMetadata(selected, source.sql, policy.tableRefs, metadataSchema(selected.config, schema));
      const tableIssues = [];
      for (const table of metadata.tables.filter((item) => !item.visible)) {
        tableIssues.push({
          schema: table.schema,
          table: table.table,
          error: table.error,
          candidates: await findUnknownTableCandidates(selected, table.schema, table.table, candidateLimit)
        });
      }
      const columnIssues = [];
      for (const table of metadata.tables.filter((item) => item.visible && item.unknownColumns.length > 0)) {
        for (const column of table.unknownColumns.slice(0, 20)) {
          columnIssues.push({
            schema: table.schema,
            table: table.table,
            column,
            candidates: await findUnknownColumnCandidates(selected, table.schema, table.table, column, candidateLimit)
          });
        }
      }
      return toLimitedResult(
        {
          source: source.source,
          sql: source.sql,
          executed: false,
          lint,
          metadata,
          unknownTableCount: tableIssues.length,
          unknownColumnCount: columnIssues.length,
          tableIssues,
          columnIssues,
          warnings: uniqueStrings([
            ...(source.source.warnings ?? []),
            "Candidates are based on visible metadata only."
          ])
        },
        selected.config
      );
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
    "ob_generate_table_doc",
    {
      title: "Generate Table Documentation",
      description: "Generate bounded JSON or Markdown documentation for one visible table without returning sample values.",
      inputSchema: {
        ...profileInput,
        table: z.string().min(1),
        schema: z.string().optional(),
        format: tableDocumentFormatSchema.optional().default("markdown"),
        includeRelationships: z.boolean().optional().default(true),
        includeQueryExamples: z.boolean().optional().default(true),
        maxColumns: z.number().int().positive().max(200).optional(),
        relationshipLimit: z.number().int().positive().max(50).optional(),
        maxExamples: z.number().int().positive().max(10).optional(),
        title: z.string().min(1).max(120).optional()
      }
    },
    async ({
      profile,
      table,
      schema,
      format = "markdown",
      includeRelationships = true,
      includeQueryExamples = true,
      maxColumns,
      relationshipLimit,
      maxExamples,
      title
    }) => {
      const selected = selectAuthorizedProfile(runtime, profile, context);
      const document = await buildTableDocument(selected, {
        schema,
        table,
        includeRelationships,
        includeQueryExamples,
        maxColumns: maxColumns ?? 80,
        relationshipLimit: relationshipLimit ?? 20,
        maxExamples: maxExamples ?? 6
      });
      return toLimitedResult(
        {
          format,
          mode: selected.config.compatibility,
          schema: document.schema,
          table: document.table,
          generatedAt: document.generatedAt,
          executed: false,
          document,
          markdown: format === "markdown" ? renderTableDocumentMarkdown(document, title) : undefined,
          warnings: document.warnings
        },
        selected.config
      );
    }
  );

  registerTool(
    "ob_generate_schema_doc",
    {
      title: "Generate Schema Documentation",
      description: "Generate bounded JSON or Markdown documentation for visible tables in one schema.",
      inputSchema: {
        ...profileInput,
        schema: z.string().optional(),
        tablePattern: z.string().optional(),
        format: tableDocumentFormatSchema.optional().default("markdown"),
        maxTables: z.number().int().positive().max(100).optional(),
        maxColumnsPerTable: z.number().int().positive().max(80).optional(),
        includeRelationships: z.boolean().optional().default(true),
        relationshipLimit: z.number().int().positive().max(50).optional(),
        title: z.string().min(1).max(120).optional()
      }
    },
    async ({
      profile,
      schema,
      tablePattern,
      format = "markdown",
      maxTables,
      maxColumnsPerTable,
      includeRelationships = true,
      relationshipLimit,
      title
    }) => {
      const selected = selectAuthorizedProfile(runtime, profile, context);
      const document = await buildSchemaDocument(selected, {
        schema,
        tablePattern,
        maxTables: maxTables ?? 20,
        maxColumnsPerTable: maxColumnsPerTable ?? 20,
        includeRelationships,
        relationshipLimit: relationshipLimit ?? 10
      });
      return toLimitedResult(
        {
          format,
          mode: selected.config.compatibility,
          schema: document.schema,
          tablePattern: document.tablePattern,
          generatedAt: document.generatedAt,
          executed: false,
          document,
          markdown: format === "markdown" ? renderSchemaDocumentMarkdown(document, title) : undefined,
          warnings: document.warnings
        },
        selected.config
      );
    }
  );

  registerTool(
    "ob_generate_onboarding_doc",
    {
      title: "Generate Onboarding Documentation",
      description: "Generate bounded onboarding documentation from visible OceanBase metadata and optional business glossary hints.",
      inputSchema: {
        ...profileInput,
        schema: z.string().optional(),
        tablePattern: z.string().optional(),
        businessTerms: z.array(z.string().min(1)).max(20).optional(),
        format: tableDocumentFormatSchema.optional().default("markdown"),
        maxTables: z.number().int().positive().max(100).optional(),
        maxColumnsPerTable: z.number().int().positive().max(50).optional(),
        maxCoreTables: z.number().int().positive().max(30).optional(),
        relationshipLimit: z.number().int().positive().max(50).optional(),
        title: z.string().min(1).max(120).optional()
      }
    },
    async ({
      profile,
      schema,
      tablePattern,
      businessTerms,
      format = "markdown",
      maxTables,
      maxColumnsPerTable,
      maxCoreTables,
      relationshipLimit,
      title
    }) => {
      const selected = selectAuthorizedProfile(runtime, profile, context);
      const document = await buildOnboardingDocument(selected, {
        schema,
        tablePattern,
        businessTerms,
        maxTables: maxTables ?? 30,
        maxColumnsPerTable: maxColumnsPerTable ?? 12,
        maxCoreTables: maxCoreTables ?? 8,
        relationshipLimit: relationshipLimit ?? 12
      });
      return toLimitedResult(
        {
          format,
          mode: selected.config.compatibility,
          schema: document.schema,
          tablePattern: document.tablePattern,
          generatedAt: document.generatedAt,
          executed: false,
          document,
          markdown: format === "markdown" ? renderOnboardingDocumentMarkdown(document, title) : undefined,
          warnings: document.warnings
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
        tables: z.array(z.string().min(1)).max(50).optional(),
        businessTerm: z.string().min(1).optional(),
        depth: z.number().int().min(1).max(3).optional(),
        maxTables: z.number().int().positive().max(500).optional(),
        maxRelationships: z.number().int().positive().max(1000).optional(),
        minConfidence: z.number().min(0).max(1).optional(),
        relationshipMode: erRelationshipModeSchema.optional().default("foreign_key"),
        includeInferred: z.boolean().optional().default(false)
      }
    },
    async ({ profile, schema, table, tables, businessTerm, depth, maxTables, maxRelationships, minConfidence, relationshipMode = "foreign_key", includeInferred = false }) => {
      const selected = selectAuthorizedProfile(runtime, profile, context);
      const result = await buildErDiagramResult(selected, { schema, table, tables, businessTerm, depth, maxTables, maxRelationships, minConfidence, relationshipMode, includeInferred });
      return toLimitedResult(fitErDiagramResponseForLimit(result.response, selected.config), selected.config);
    }
  );

  registerTool(
    "ob_generate_er_html",
    {
      title: "Generate ER HTML",
      description: "Generate a self-contained HTML ER diagram from allowed OceanBase metadata and relationship evidence.",
      inputSchema: {
        ...profileInput,
        schema: z.string().optional(),
        table: z.string().optional(),
        tables: z.array(z.string().min(1)).max(50).optional(),
        businessTerm: z.string().min(1).optional(),
        depth: z.number().int().min(1).max(3).optional(),
        maxTables: z.number().int().positive().max(500).optional(),
        maxRelationships: z.number().int().positive().max(1000).optional(),
        minConfidence: z.number().min(0).max(1).optional(),
        relationshipMode: erRelationshipModeSchema.optional().default("foreign_key"),
        includeInferred: z.boolean().optional().default(false),
        format: erHtmlFormatSchema.optional().default("html-static"),
        title: z.string().min(1).max(120).optional()
      }
    },
    async ({ profile, schema, table, tables, businessTerm, depth, maxTables, maxRelationships, minConfidence, relationshipMode = "foreign_key", includeInferred = false, format = "html-static", title }) => {
      const selected = selectAuthorizedProfile(runtime, profile, context);
      const result = await buildErDiagramResult(selected, { schema, table, tables, businessTerm, depth, maxTables, maxRelationships, minConfidence, relationshipMode, includeInferred });
      if (shouldSkipSchemaInlineErHtmlRender(result.response, { table, tables, businessTerm })) {
        return toLimitedResult(
          {
            mode: result.response.mode,
            schema: result.response.schema,
            rootTable: result.response.rootTable,
            businessTerm: result.response.businessTerm,
            tableCount: result.response.tableCount,
            relationshipCount: result.response.relationshipCount,
            contentType: "text/html",
            format,
            inline: false,
            htmlOmitted: true,
            renderSkipped: true,
            inlineLimitBytes: selected.config.erInlineHtmlMaxBytes,
            exportCommand: buildErExportCommand(result.response, format),
            stats: result.response.stats,
            warnings: uniqueStrings([
              ...result.response.warnings,
              `Schema-level ER HTML rendering was skipped because tableCount=${result.response.tableCount} exceeds ${SCHEMA_INLINE_ER_TABLE_RENDER_LIMIT}. Use ob_plan_er_export and CLI cluster export for large diagrams.`
            ])
          },
          selected.config
        );
      }
      const html = renderErHtml(result.diagram, {
        title: title ?? defaultErHtmlTitle(result.response),
        warnings: result.response.warnings,
        format,
        maxColumnsPerEntity: selected.config.erMaxColumnsPerTable
      });
      const htmlBytes = Buffer.byteLength(html, "utf8");
      if (htmlBytes > selected.config.erInlineHtmlMaxBytes) {
        return toLimitedResult(
          {
            mode: result.response.mode,
            schema: result.response.schema,
            rootTable: result.response.rootTable,
            businessTerm: result.response.businessTerm,
            tableCount: result.response.tableCount,
            relationshipCount: result.response.relationshipCount,
            contentType: "text/html",
            format,
            inline: false,
            htmlOmitted: true,
            htmlBytes,
            inlineLimitBytes: selected.config.erInlineHtmlMaxBytes,
            exportCommand: buildErExportCommand(result.response, format),
            stats: result.response.stats,
            warnings: uniqueStrings([
              ...result.response.warnings,
              `ER HTML is ${htmlBytes} bytes and exceeds OB_ER_INLINE_HTML_MAX_BYTES=${selected.config.erInlineHtmlMaxBytes}; use CLI export for the full artifact.`
            ])
          },
          selected.config
        );
      }
      return toLimitedResult(
        {
          mode: result.response.mode,
          schema: result.response.schema,
          rootTable: result.response.rootTable,
          businessTerm: result.response.businessTerm,
          tableCount: result.response.tableCount,
          relationshipCount: result.response.relationshipCount,
          contentType: "text/html",
          format,
          inline: true,
          html,
          mermaid: result.response.mermaid,
          stats: result.response.stats,
          warnings: result.response.warnings
        },
        selected.config
      );
    }
  );

  registerTool(
    "ob_plan_er_export",
    {
      title: "Plan ER Export",
      description: "Plan local ER HTML export commands for large OceanBase schemas without returning large inline HTML.",
      inputSchema: {
        ...profileInput,
        schema: z.string().optional(),
        table: z.string().optional(),
        tables: z.array(z.string().min(1)).max(50).optional(),
        businessTerm: z.string().min(1).optional(),
        depth: z.number().int().min(1).max(3).optional(),
        maxTables: z.number().int().positive().max(500).optional(),
        maxRelationships: z.number().int().positive().max(1000).optional(),
        minConfidence: z.number().min(0).max(1).optional(),
        relationshipMode: erRelationshipModeSchema.optional().default("foreign_key"),
        includeInferred: z.boolean().optional().default(false),
        format: erHtmlFormatSchema.optional().default("html-interactive"),
        strategy: erExportStrategySchema.optional(),
        chunkSize: z.number().int().positive().max(100).optional(),
        maxColumnsPerTable: z.number().int().positive().max(500).optional(),
        outputDir: z.string().min(1).max(240).optional()
      }
    },
    async ({ profile, schema, table, tables, businessTerm, depth, maxTables, maxRelationships, minConfidence, relationshipMode = "foreign_key", includeInferred = false, format = "html-interactive", strategy, chunkSize, maxColumnsPerTable, outputDir }) => {
      const selected = selectAuthorizedProfile(runtime, profile, context);
      const result = await buildErExportPlanResult(selected, {
        schema,
        table,
        tables,
        businessTerm,
        depth,
        maxTables,
        maxRelationships,
        minConfidence,
        relationshipMode,
        includeInferred,
        format,
        strategy,
        chunkSize,
        maxColumnsPerTable,
        outputDir
      });
      return toLimitedResult(result, selected.config);
    }
  );

  registerTool(
    "ob_generate_entity_diagram",
    {
      title: "Generate Entity Diagram",
      description: "Generate a local entity-focused ER diagram from a business term or table, with Mermaid, JSON, and optional HTML.",
      inputSchema: {
        ...profileInput,
        schema: z.string().optional(),
        table: z.string().optional(),
        businessTerm: z.string().min(1).optional(),
        depth: z.number().int().min(1).max(3).optional(),
        maxTables: z.number().int().positive().max(500).optional(),
        maxRelationships: z.number().int().positive().max(1000).optional(),
        minConfidence: z.number().min(0).max(1).optional(),
        relationshipMode: erRelationshipModeSchema.optional().default("foreign_key"),
        includeInferred: z.boolean().optional().default(false),
        formats: z.array(entityDiagramOutputFormatSchema).min(1).max(3).optional(),
        htmlFormat: erHtmlFormatSchema.optional().default("html-compact"),
        title: z.string().min(1).max(120).optional()
      }
    },
    async ({ profile, schema, table, businessTerm, depth, maxTables, maxRelationships, minConfidence, relationshipMode = "foreign_key", includeInferred = false, formats, htmlFormat = "html-compact", title }) => {
      if (!table && !businessTerm) {
        throw new Error("Pass table or businessTerm when generating an entity diagram.");
      }
      const selected = selectAuthorizedProfile(runtime, profile, context);
      const outputFormats = uniqueStrings(formats ?? ["mermaid", "json", "html"]) as Array<"mermaid" | "json" | "html">;
      const result = await buildErDiagramResult(selected, {
        schema,
        table,
        businessTerm,
        depth: depth ?? 1,
        maxTables: maxTables ?? 12,
        maxRelationships,
        minConfidence,
        relationshipMode,
        includeInferred
      });
      const response: Record<string, unknown> = {
        mode: result.response.mode,
        schema: result.response.schema,
        table: table ?? null,
        businessTerm: businessTerm ?? null,
        formats: outputFormats,
        tableCount: result.response.tableCount,
        relationshipCount: result.response.relationshipCount,
        relationshipEvidence: result.diagram.relationships.map(entityRelationshipEvidence),
        stats: result.response.stats,
        warnings: result.response.warnings
      };
      if (outputFormats.includes("mermaid")) {
        response.mermaid = result.response.mermaid;
      }
      if (outputFormats.includes("json")) {
        response.diagram = result.response.diagram;
        response.scope = result.response.scope;
      }
      if (outputFormats.includes("html")) {
        response.html = renderErHtml(result.diagram, {
          title: title ?? defaultErHtmlTitle(result.response),
          warnings: result.response.warnings,
          format: htmlFormat
        });
        response.htmlFormat = htmlFormat;
        response.contentType = "text/html";
      }
      return toLimitedResult(response, selected.config);
    }
  );

  registerTool(
    "ob_explain_relationship",
    {
      title: "Explain Table Relationship",
      description: "Explain visible relationship evidence between two OceanBase tables without inventing missing relationships.",
      inputSchema: {
        ...profileInput,
        schema: z.string().optional(),
        sourceSchema: z.string().optional(),
        sourceTable: z.string().min(1),
        targetSchema: z.string().optional(),
        targetTable: z.string().min(1),
        depth: z.number().int().min(1).max(3).optional(),
        minConfidence: z.number().min(0).max(1).optional(),
        includeInferred: z.boolean().optional().default(true)
      }
    },
    async ({ profile, schema, sourceSchema, sourceTable, targetSchema, targetTable, depth, minConfidence, includeInferred = true }) => {
      const selected = selectAuthorizedProfile(runtime, profile, context);
      const fallbackSchema = metadataSchema(selected.config, schema);
      const sourceRef = parseErInputTableRef(selected.config.compatibility, sourceTable, metadataSchema(selected.config, sourceSchema) ?? fallbackSchema);
      const targetRef = parseErInputTableRef(selected.config.compatibility, targetTable, metadataSchema(selected.config, targetSchema) ?? fallbackSchema);
      assertTableAccess(sourceRef.schema, sourceRef.table, policyContext(selected.config));
      assertTableAccess(targetRef.schema, targetRef.table, policyContext(selected.config));
      const depthLimit = depth ?? 2;
      const confidenceFloor = minConfidence ?? (includeInferred ? 0.5 : 0.9);
      const result = await withQuerySlot(selected, () =>
        findRelatedTables(
          selected.pool,
          selected.config.compatibility,
          sourceRef.table,
          sourceRef.schema,
          depthLimit,
          100,
          selected.config.queryTimeoutMs
        )
      );
      const visibleRelations = dedupeRelationships(selected.config.compatibility, result.relations)
        .filter((relation) => isErRelationshipVisible(relation, selected.config, confidenceFloor, includeInferred));
      const matches = visibleRelations
        .filter((relation) => relationshipConnectsTables(selected.config.compatibility, relation, sourceRef, targetRef))
        .map(entityRelationshipEvidence);
      const paths = relationshipPaths(
        selected.config.compatibility,
        visibleRelations,
        sourceRef,
        targetRef,
        depthLimit,
        10
      );

      return toLimitedResult(
        {
          mode: selected.config.compatibility,
          source: sourceRef,
          target: targetRef,
          depth: depthLimit,
          minConfidence: confidenceFloor,
          includeInferred,
          conclusion: matches.length > 0 || paths.length > 0 ? "relationship_found" : "not_found",
          relationshipCount: matches.length,
          pathCount: paths.length,
          relationships: matches,
          paths,
          warnings: matches.length > 0 || paths.length > 0
            ? []
            : ["No visible relationship was found between the two tables under the active policy and confidence settings."]
        },
        selected.config
      );
    }
  );

  registerTool(
    "ob_generate_er_document",
    {
      title: "Generate ER Documentation",
      description: "Generate Markdown, PlantUML, and DOT documentation from allowed ER metadata and relationship evidence.",
      inputSchema: {
        ...profileInput,
        schema: z.string().optional(),
        table: z.string().optional(),
        tables: z.array(z.string().min(1)).max(50).optional(),
        businessTerm: z.string().min(1).optional(),
        depth: z.number().int().min(1).max(3).optional(),
        maxTables: z.number().int().positive().max(500).optional(),
        maxRelationships: z.number().int().positive().max(1000).optional(),
        minConfidence: z.number().min(0).max(1).optional(),
        relationshipMode: erRelationshipModeSchema.optional().default("foreign_key"),
        includeInferred: z.boolean().optional().default(false),
        formats: z.array(erDocumentFormatSchema).min(1).max(3).optional(),
        title: z.string().min(1).max(120).optional()
      }
    },
    async ({ profile, schema, table, tables, businessTerm, depth, maxTables, maxRelationships, minConfidence, relationshipMode = "foreign_key", includeInferred = false, formats, title }) => {
      const selected = selectAuthorizedProfile(runtime, profile, context);
      const result = await buildErDiagramResult(selected, {
        schema,
        table,
        tables,
        businessTerm,
        depth,
        maxTables,
        maxRelationships,
        minConfidence,
        relationshipMode,
        includeInferred
      });
      const requestedFormats = uniqueStrings(formats ?? ["markdown"]) as Array<"markdown" | "plantuml" | "dot">;
      const documents: Record<string, string> = {};
      if (requestedFormats.includes("markdown")) {
        documents.markdown = renderErMarkdown(result.diagram, {
          title: title ?? defaultErHtmlTitle(result.response),
          warnings: result.response.warnings
        });
      }
      if (requestedFormats.includes("plantuml")) {
        documents.plantuml = renderErPlantUml(result.diagram);
      }
      if (requestedFormats.includes("dot")) {
        documents.dot = renderErDot(result.diagram);
      }
      return toLimitedResult(
        {
          mode: result.response.mode,
          schema: result.response.schema,
          rootTable: result.response.rootTable,
          businessTerm: result.response.businessTerm,
          formats: requestedFormats,
          tableCount: result.response.tableCount,
          relationshipCount: result.response.relationshipCount,
          relationshipEvidence: result.diagram.relationships.map(entityRelationshipEvidence),
          documents,
          warnings: result.response.warnings
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
      const columns = safeSampleColumnNames(metadata).slice(0, 50);
      const sampleLimit = Math.min(limit ?? Math.min(selected.config.maxRows, 5), selected.config.maxRows, 100);
      const output = await withQuerySlot(selected, () =>
        sampleRows(
          selected.pool,
          selected.config.compatibility,
          effectiveSchema,
          table,
          columns,
          sampleLimit,
          selected.config.queryTimeoutMs,
          selected.config.maxResultBytes
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

function describeTablePayload(rows: unknown[], config: ObConfig, maxColumns: number | undefined): unknown {
  const columnLimit = Math.min(maxColumns ?? rows.length, 10_000);
  const limitedRows = rows.slice(0, columnLimit);
  const explicitlyTruncated = limitedRows.length < rows.length;
  if (!maxColumns && !explicitlyTruncated && jsonByteLength(limitedRows) <= config.maxResultBytes) {
    return limitedRows;
  }

  const baseWarnings = explicitlyTruncated
    ? [`Only ${limitedRows.length} of ${rows.length} visible columns are returned. Pass maxColumns to adjust the scope.`]
    : [];
  const buildPayload = (columns: unknown[], byteTruncated: boolean) => ({
    columns,
    columnCount: rows.length,
    returnedColumns: columns.length,
    truncated: explicitlyTruncated || byteTruncated,
    warnings: byteTruncated
      ? [...baseWarnings, "Column metadata output was capped by OB_MAX_RESULT_BYTES."]
      : baseWarnings
  });

  if (jsonByteLength(buildPayload(limitedRows, false)) <= config.maxResultBytes) {
    return buildPayload(limitedRows, false);
  }

  let low = 0;
  let high = limitedRows.length;
  let best = 0;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    if (jsonByteLength(buildPayload(limitedRows.slice(0, mid), true)) <= config.maxResultBytes) {
      best = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return buildPayload(limitedRows.slice(0, best), true);
}

async function cachedSchemaMapTables(
  selected: ReturnType<typeof selectRuntimeProfile>,
  schema: string | undefined,
  tablePattern: string | undefined,
  limit: number
): Promise<SchemaMapTable[]> {
  return withMetadataCache(selected, "schema_map_tables", [selected.config.compatibility, schema ?? "", tablePattern ?? "", limit], () =>
    withQuerySlot(selected, () =>
      listSchemaMapTables(
        selected.pool,
        selected.config.compatibility,
        schema,
        tablePattern,
        limit,
        selected.config.queryTimeoutMs
      )
    )
  );
}

async function cachedDescribeTable(
  selected: ReturnType<typeof selectRuntimeProfile>,
  schema: string | undefined,
  table: string
): Promise<unknown[]> {
  return withMetadataCache(selected, "describe_table", [selected.config.compatibility, schema ?? "", table], () =>
    withQuerySlot(selected, () =>
      describeTable(selected.pool, selected.config.compatibility, table, schema, selected.config.queryTimeoutMs)
    )
  );
}

async function cachedListConstraints(
  selected: ReturnType<typeof selectRuntimeProfile>,
  schema: string | undefined,
  table: string
): Promise<unknown[]> {
  return withMetadataCache(selected, "list_constraints", [selected.config.compatibility, schema ?? "", table], () =>
    withQuerySlot(selected, () =>
      listConstraints(selected.pool, selected.config.compatibility, table, schema, selected.config.queryTimeoutMs)
    )
  );
}

async function cachedRelatedTables(
  selected: ReturnType<typeof selectRuntimeProfile>,
  schema: string | undefined,
  table: string,
  depth: number,
  limit: number
) {
  return withMetadataCache(selected, "related_tables", [selected.config.compatibility, schema ?? "", table, depth, limit], () =>
    withQuerySlot(selected, () =>
      findRelatedTables(
        selected.pool,
        selected.config.compatibility,
        table,
        schema,
        depth,
        limit,
        selected.config.queryTimeoutMs
      )
    )
  );
}

function refreshMetadataCache(
  selected: ReturnType<typeof selectRuntimeProfile>,
  schema: string | undefined,
  table: string | undefined
) {
  const before = selected.metadataCache.entries.size;
  let removed = 0;
  if (!schema && !table) {
    removed = before;
    selected.metadataCache.entries.clear();
  } else {
    for (const key of [...selected.metadataCache.entries.keys()]) {
      if (metadataCacheKeyMatches(selected.config.compatibility, key, schema, table)) {
        selected.metadataCache.entries.delete(key);
        removed += 1;
      }
    }
  }
  return {
    profile: selected.profile,
    mode: selected.config.compatibility,
    scope: {
      schema: schema ?? null,
      table: table ?? null
    },
    cacheEnabled: selected.config.metadataCacheEnabled,
    beforeEntries: before,
    removedEntries: removed,
    afterEntries: selected.metadataCache.entries.size,
    stats: {
      hits: selected.metadataCache.hits,
      misses: selected.metadataCache.misses,
      evictions: selected.metadataCache.evictions
    },
    executed: false,
    warnings: [
      "Only in-memory metadata cache entries for the selected profile are cleared.",
      "Query results and sample rows are not cached by the metadata cache."
    ]
  };
}

function metadataCacheStatus(selected: ReturnType<typeof selectRuntimeProfile>) {
  const now = Date.now();
  const namespaceCounts = new Map<string, number>();
  let expiredEntries = 0;
  for (const [key, entry] of selected.metadataCache.entries) {
    const parsed = parseMetadataCacheKey(key);
    const namespace = parsed && typeof parsed[0] === "string" ? parsed[0] : "unknown";
    namespaceCounts.set(namespace, (namespaceCounts.get(namespace) ?? 0) + 1);
    if (entry.expiresAt <= now) {
      expiredEntries += 1;
    }
  }
  return {
    profile: selected.profile,
    mode: selected.config.compatibility,
    enabled: selected.config.metadataCacheEnabled,
    ttlMs: selected.config.metadataCacheTtlMs,
    maxEntries: selected.config.metadataCacheMaxEntries,
    entries: selected.metadataCache.entries.size,
    expiredEntries,
    namespaces: [...namespaceCounts.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([namespace, count]) => ({ namespace, count })),
    stats: {
      hits: selected.metadataCache.hits,
      misses: selected.metadataCache.misses,
      evictions: selected.metadataCache.evictions
    },
    executed: false,
    warnings: [
      "Cache status reports counts only; cached metadata content is not returned.",
      "The metadata cache is in-memory and is cleared when the MCP process restarts."
    ]
  };
}

function metadataCacheKeyMatches(
  mode: ObConfig["compatibility"],
  key: string,
  schema: string | undefined,
  table: string | undefined
): boolean {
  const parsed = parseMetadataCacheKey(key);
  if (!parsed) {
    return false;
  }
  const [namespace, , cachedSchema, cachedTable] = parsed;
  const schemaMatches = !schema || normalizeTableName(mode, String(cachedSchema ?? "")) === normalizeTableName(mode, schema);
  if (!schemaMatches) {
    return false;
  }
  if (!table) {
    return true;
  }
  if (namespace === "schema_map_tables") {
    return true;
  }
  return normalizeTableName(mode, String(cachedTable ?? "")) === normalizeTableName(mode, table);
}

function parseMetadataCacheKey(key: string): unknown[] | undefined {
  try {
    const parsed = JSON.parse(key);
    return Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
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
    await cachedDescribeTable(selected, schema, table),
    selected.config.policy
  );
  const constraints = filterColumnMetadata(
    await cachedListConstraints(selected, schema, table),
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
  const result = await cachedRelatedTables(selected, schema, table, 1, Math.max(1, Math.min(relationshipLimit, 100)));
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
      await cachedDescribeTable(selected, schema, tableInfo.table),
      selected.config.policy
    );
    const constraints = filterColumnMetadata(
      await cachedListConstraints(selected, schema, tableInfo.table),
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

function renderDataDictionaryHtml(dictionary: Parameters<typeof renderDatabaseDictionaryMarkdown>[0], title?: string): string {
  const body = dictionary.tables.map((table) => {
    const qualifiedName = `${table.schema ? `${table.schema}.` : ""}${table.table}`;
    const rows = table.columns.map((column) => `
      <tr>
        <td>${escapeInlineHtml(column.name)}</td>
        <td>${escapeInlineHtml(column.type ?? "")}</td>
        <td>${column.nullable == null ? "" : column.nullable ? "YES" : "NO"}</td>
        <td>${escapeInlineHtml(column.roles.join(", "))}</td>
        <td>${column.masked ? "YES" : "NO"}</td>
        <td>${escapeInlineHtml(column.comment ?? "")}</td>
      </tr>
    `).join("");
    const comment = table.comment ? `<p class="comment">${escapeInlineHtml(table.comment)}</p>` : "";
    const rowEstimate = table.rowEstimate ? `<p>Row estimate: ${table.rowEstimate.value} (${escapeInlineHtml(table.rowEstimate.source)})</p>` : "";
    const primaryKeys = table.primaryKeys.length > 0 ? `<p>Primary key: ${escapeInlineHtml(table.primaryKeys.join(", "))}</p>` : "";
    const truncated = table.columnsTruncated ? `<p class="warn">Columns were truncated by maxColumnsPerTable.</p>` : "";
    return `
      <section>
        <h2>${escapeInlineHtml(qualifiedName)}</h2>
        ${comment}
        ${rowEstimate}
        ${primaryKeys}
        <table>
          <thead>
            <tr><th>Column</th><th>Type</th><th>Nullable</th><th>Roles</th><th>Masked</th><th>Comment</th></tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
        ${truncated}
      </section>
    `;
  }).join("\n");
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeInlineHtml(title ?? "OceanBase Data Dictionary")}</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 32px; color: #17202a; }
    h1 { font-size: 28px; margin-bottom: 4px; }
    h2 { font-size: 20px; margin-top: 28px; }
    table { border-collapse: collapse; width: 100%; margin-top: 12px; }
    th, td { border: 1px solid #d7dde5; padding: 8px; text-align: left; vertical-align: top; }
    th { background: #f3f6f8; }
    .meta, .comment, .warn { color: #5b6673; }
  </style>
</head>
<body>
  <h1>${escapeInlineHtml(title ?? "OceanBase Data Dictionary")}</h1>
  <p class="meta">Generated at: ${escapeInlineHtml(dictionary.generatedAt)}. Tables: ${dictionary.tables.length}. No sample data values are included.</p>
  ${body}
</body>
</html>`;
}

function escapeInlineHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

async function buildTableDocument(
  selected: ReturnType<typeof selectRuntimeProfile>,
  input: {
    schema?: string;
    table: string;
    includeRelationships: boolean;
    includeQueryExamples: boolean;
    maxColumns: number;
    relationshipLimit: number;
    maxExamples: number;
  }
) {
  const ref = metadataTableRef(selected.config, input.schema, input.table);
  assertTableAccess(ref.schema, ref.table, policyContext(selected.config));
  const metadata = await withQuerySlot(selected, () =>
    getTableDdlMetadata(selected.pool, selected.config.compatibility, ref.table, ref.schema, selected.config.queryTimeoutMs)
  );
  const columns = filterColumnMetadata(metadata.columns, selected.config.policy);
  const indexes = filterColumnMetadata(metadata.indexes, selected.config.policy);
  const constraints = filterColumnMetadata(metadata.constraints, selected.config.policy);
  const partitions = filterTables(metadata.partitions, selected.config.policy);
  const compactColumns = compactSchemaColumns(columns, constraints, selected.config, metadata.schema, metadata.table);
  const columnLimit = Math.min(input.maxColumns, 200);
  const primaryKeys = schemaMapPrimaryKeyColumns(constraints);
  const uniqueKeys = uniqueKeyGroups(constraints);
  const timeFields = compactColumns.filter((column) => column.roles.includes("time")).map((column) => column.name);
  const statusFields = compactColumns.filter((column) => column.roles.includes("status")).map((column) => column.name);
  const keyFields = importantSchemaMapFields(compactColumns, primaryKeys, timeFields, statusFields);
  const tableInfo = await findSchemaMapTableInfo(selected, metadata.schema, metadata.table);
  const statistics = await withQuerySlot(selected, () =>
    getTableStats(selected.pool, selected.config.compatibility, metadata.table, metadata.schema, selected.config.queryTimeoutMs)
  );
  const relationshipLimit = Math.min(input.relationshipLimit, 50);
  const relationships = input.includeRelationships
    ? await buildSchemaMapRelationshipSummary(selected, metadata.schema, metadata.table, relationshipLimit)
    : undefined;
  const queryExamples = input.includeQueryExamples
    ? buildTableDocumentQueryExamples(
        selected,
        metadata.schema,
        metadata.table,
        columns,
        constraints,
        relationships?.relations ?? [],
        input.maxExamples
      )
    : undefined;
  const purpose = inferTablePurpose(metadata.table, tableInfo?.comment, compactColumns);
  const warnings = uniqueStrings([
    ...metadata.warnings,
    "Document content is based on metadata visible to the active MCP policy.",
    "No sample data values are included.",
    "Purpose and field roles are inferred from visible metadata; verify with domain knowledge before using them as business facts.",
    compactColumns.length > columnLimit ? `Only the first ${columnLimit} visible columns are included.` : "",
    statistics.warnings.length > 0 ? statistics.warnings.join(" ") : "",
    relationships?.truncated ? "Relationship output was truncated by relationshipLimit." : ""
  ]);

  return {
    generatedAt: new Date().toISOString(),
    mode: selected.config.compatibility,
    schema: metadata.schema,
    table: metadata.table,
    comment: tableInfo?.comment,
    tableType: tableInfo?.tableType,
    engine: tableInfo?.engine,
    purpose,
    rowEstimate: tableInfo?.rowEstimate ?? statistics.rowEstimate,
    statistics,
    primaryKeys,
    uniqueKeys,
    keyFields,
    timeFields,
    statusFields,
    columns: compactColumns.slice(0, columnLimit),
    visibleColumnCount: compactColumns.length,
    columnsTruncated: compactColumns.length > columnLimit,
    indexes: mapperIndexSummary(indexes),
    constraints: mapperConstraintSummary(constraints),
    partitions: tableDocumentPartitionSummary(partitions),
    relationships,
    queryExamples,
    structuredDdl: metadata.structuredDdl,
    warnings
  };
}

function buildTableDocumentQueryExamples(
  selected: ReturnType<typeof selectRuntimeProfile>,
  schema: string | undefined,
  table: string,
  columns: unknown[],
  constraints: unknown[],
  relationships: Array<{
    relationType: TableRelationship["relationType"];
    direction: TableRelationship["direction"];
    confidence: number;
    sourceSchema?: string;
    sourceTable: string;
    sourceColumns: string[];
    targetSchema?: string;
    targetTable: string;
    targetColumns: string[];
    constraintName?: string;
    evidence: TableRelationship["evidence"];
  }>,
  maxExamples: number
) {
  const generated = generateQueryTemplates({
    mode: selected.config.compatibility,
    schema,
    table,
    columns,
    constraints,
    relationships: relationships as TableRelationship[],
    maxColumns: 12,
    rowLimit: effectiveRowLimit(undefined, selected.config)
  });
  return {
    examples: generated.templates
      .slice(0, Math.min(maxExamples, 10))
      .map((template) => queryExampleFromTemplate(template, selected.config)),
    warnings: generated.warnings,
    executed: false
  };
}

function tableDocumentPartitionSummary(rows: unknown[]): Array<Record<string, unknown>> {
  return rows.slice(0, 50).map((row) => {
    const record = row as Record<string, unknown>;
    return {
      name: stringRecordValue(record, "partition_name", "PARTITION_NAME"),
      subpartition: stringRecordValue(record, "subpartition_name", "SUBPARTITION_NAME"),
      method: stringRecordValue(record, "partition_method", "PARTITION_METHOD"),
      expression: stringRecordValue(record, "partition_expression", "PARTITION_EXPRESSION"),
      description: stringRecordValue(record, "partition_description", "HIGH_VALUE"),
      rowEstimate: numberRecordValue(record, "table_rows", "NUM_ROWS")
    };
  });
}

function renderTableDocumentMarkdown(document: Awaited<ReturnType<typeof buildTableDocument>>, title?: string): string {
  const qualifiedName = `${document.schema ? `${document.schema}.` : ""}${document.table}`;
  const lines = [
    `# ${title ?? `Table Documentation: ${qualifiedName}`}`,
    "",
    `Generated at: ${document.generatedAt}`,
    "",
    `Mode: ${document.mode}`,
    `Table: ${qualifiedName}`,
    ""
  ];
  if (document.comment) {
    lines.push(`Comment: ${document.comment}`, "");
  }
  if (document.rowEstimate) {
    lines.push(`Row estimate: ${document.rowEstimate.value} (${document.rowEstimate.source})`, "");
  }
  lines.push("## Purpose", "", document.purpose.summary, "");
  if (document.purpose.evidence.length > 0) {
    lines.push("| Evidence | Value | Reason |", "| --- | --- | --- |");
    for (const item of document.purpose.evidence) {
      lines.push(`| ${markdownCell(item.source)} | ${markdownCell(item.value)} | ${markdownCell(item.reason)} |`);
    }
    lines.push("");
  }
  lines.push("## Columns", "");
  lines.push("| Column | Type | Nullable | Roles | Masked | Comment |");
  lines.push("| --- | --- | --- | --- | --- | --- |");
  for (const column of document.columns) {
    lines.push(`| ${markdownCell(column.name)} | ${markdownCell(column.type ?? "")} | ${column.nullable == null ? "" : column.nullable ? "YES" : "NO"} | ${markdownCell(column.roles.join(", "))} | ${column.masked ? "YES" : "NO"} | ${markdownCell(column.comment ?? "")} |`);
  }
  if (document.columnsTruncated) {
    lines.push("", `Only the first ${document.columns.length} of ${document.visibleColumnCount} visible columns are included.`, "");
  } else {
    lines.push("");
  }
  lines.push("## Keys And Indexes", "");
  lines.push(`Primary keys: ${document.primaryKeys.length > 0 ? document.primaryKeys.map(markdownCell).join(", ") : "None visible."}`, "");
  if (document.uniqueKeys.length > 0) {
    lines.push("| Unique Key | Columns |", "| --- | --- |");
    for (const key of document.uniqueKeys) {
      lines.push(`| ${markdownCell(key.name)} | ${markdownCell(key.columns.join(", "))} |`);
    }
    lines.push("");
  }
  if (document.indexes.length > 0) {
    lines.push("| Index | Unique | Columns |", "| --- | --- | --- |");
    for (const index of document.indexes) {
      lines.push(`| ${markdownCell(index.name)} | ${index.unique == null ? "" : index.unique ? "YES" : "NO"} | ${markdownCell(index.columns.join(", "))} |`);
    }
    lines.push("");
  }
  if (document.constraints.length > 0) {
    lines.push("## Constraints", "");
    lines.push("| Constraint | Type | Columns |", "| --- | --- | --- |");
    for (const constraint of document.constraints) {
      lines.push(`| ${markdownCell(constraint.name)} | ${markdownCell(constraint.type ?? "")} | ${markdownCell(constraint.columns.join(", "))} |`);
    }
    lines.push("");
  }
  if (document.partitions.length > 0) {
    lines.push("## Partitions", "");
    lines.push("| Partition | Subpartition | Method | Rows |", "| --- | --- | --- | --- |");
    for (const partition of document.partitions) {
      lines.push(`| ${markdownCell(String(partition.name ?? ""))} | ${markdownCell(String(partition.subpartition ?? ""))} | ${markdownCell(String(partition.method ?? ""))} | ${partition.rowEstimate ?? ""} |`);
    }
    lines.push("");
  }
  if (document.relationships) {
    lines.push("## Relationships", "");
    if (document.relationships.relations.length === 0) {
      lines.push("No visible relationships were found under the active policy.", "");
    } else {
      lines.push("| Direction | Type | Table | Columns | Confidence | Evidence |", "| --- | --- | --- | --- | --- | --- |");
      for (const relation of document.relationships.relations) {
        const table = relation.direction === "outbound"
          ? `${relation.targetSchema ? `${relation.targetSchema}.` : ""}${relation.targetTable}`
          : `${relation.sourceSchema ? `${relation.sourceSchema}.` : ""}${relation.sourceTable}`;
        const columns = relation.direction === "outbound" ? relation.sourceColumns : relation.targetColumns;
        lines.push(`| ${relation.direction} | ${relation.relationType} | ${markdownCell(table)} | ${markdownCell(columns.join(", "))} | ${relation.confidence} | ${markdownCell(relation.evidence.map((item) => item.detail).join("; "))} |`);
      }
      lines.push("");
    }
  }
  if (document.queryExamples) {
    lines.push("## Query Examples", "");
    for (const example of document.queryExamples.examples) {
      lines.push(`### ${example.title}`, "", `Purpose: ${example.purpose}`, "", "```sql", example.sql, "```", "");
      if (example.parameters.length > 0) {
        lines.push("| Parameter | Type | Description |", "| --- | --- | --- |");
        for (const parameter of example.parameters) {
          lines.push(`| ${markdownCell(parameter.name)} | ${markdownCell(parameter.type ?? "")} | ${markdownCell(parameter.description)} |`);
        }
        lines.push("");
      }
    }
  }
  lines.push("## Notes", "");
  for (const warning of document.warnings) {
    lines.push(`- ${warning}`);
  }
  return lines.join("\n");
}

async function buildSchemaDocument(
  selected: ReturnType<typeof selectRuntimeProfile>,
  input: {
    schema?: string;
    tablePattern?: string;
    maxTables: number;
    maxColumnsPerTable: number;
    includeRelationships: boolean;
    relationshipLimit: number;
  }
) {
  const effectiveSchema = metadataSchema(selected.config, input.schema);
  if (effectiveSchema && !isSchemaAllowed(effectiveSchema, selected.config.policy)) {
    throw new Error(`Schema "${effectiveSchema}" is not allowed by the configured OceanBase MCP access policy.`);
  }
  const tableLimit = Math.min(input.maxTables, 100);
  const columnLimit = Math.min(input.maxColumnsPerTable, 80);
  const rawTables = await cachedSchemaMapTables(selected, effectiveSchema, input.tablePattern, tableLimit + 1);
  const visibleTables = filterSchemaMapTables(rawTables, selected.config).slice(0, tableLimit);
  const tables = [];
  for (const tableInfo of visibleTables) {
    tables.push(await buildSchemaMapTableSummary(
      selected,
      tableInfo,
      true,
      columnLimit,
      input.includeRelationships,
      input.relationshipLimit
    ));
  }
  const warnings = uniqueStrings([
    "Schema documentation is based on metadata visible to the active MCP policy.",
    "No sample data values are included.",
    rawTables.length > tableLimit ? `Only the first ${tableLimit} visible tables are included.` : "",
    tables.some((table) => table.columnsTruncated) ? `Some tables have more than ${columnLimit} visible columns; columns were truncated.` : ""
  ]);

  return {
    generatedAt: new Date().toISOString(),
    mode: selected.config.compatibility,
    schema: effectiveSchema,
    tablePattern: input.tablePattern ?? null,
    maxTables: tableLimit,
    maxColumnsPerTable: columnLimit,
    includeRelationships: input.includeRelationships,
    tableCount: tables.length,
    truncated: rawTables.length > tableLimit,
    tables,
    warnings
  };
}

function renderSchemaDocumentMarkdown(document: Awaited<ReturnType<typeof buildSchemaDocument>>, title?: string): string {
  const lines = [
    `# ${title ?? `Schema Documentation: ${document.schema ?? "default"}`}`,
    "",
    `Generated at: ${document.generatedAt}`,
    "",
    `Mode: ${document.mode}`,
    `Schema: ${document.schema ?? "default"}`,
    `Tables: ${document.tableCount}`,
    ""
  ];
  if (document.tablePattern) {
    lines.push(`Table pattern: ${document.tablePattern}`, "");
  }
  lines.push("## Tables", "");
  if (document.tables.length === 0) {
    lines.push("No visible tables matched the requested scope.", "");
  }
  for (const table of document.tables) {
    const qualifiedName = `${table.schema ? `${table.schema}.` : ""}${table.table}`;
    lines.push(`### ${qualifiedName}`, "");
    if (table.comment) {
      lines.push(`Comment: ${table.comment}`, "");
    }
    if (table.rowEstimate) {
      lines.push(`Row estimate: ${table.rowEstimate.value} (${table.rowEstimate.source})`, "");
    }
    lines.push(`Primary keys: ${table.primaryKeys.length > 0 ? table.primaryKeys.map(markdownCell).join(", ") : "None visible."}`);
    lines.push(`Key fields: ${table.keyFields.length > 0 ? table.keyFields.map(markdownCell).join(", ") : "None detected."}`);
    lines.push(`Time fields: ${table.timeFields.length > 0 ? table.timeFields.map(markdownCell).join(", ") : "None detected."}`);
    lines.push(`Status fields: ${table.statusFields.length > 0 ? table.statusFields.map(markdownCell).join(", ") : "None detected."}`, "");
    if (table.columns && table.columns.length > 0) {
      lines.push("| Column | Type | Nullable | Roles | Masked | Comment |");
      lines.push("| --- | --- | --- | --- | --- | --- |");
      for (const column of table.columns) {
        lines.push(`| ${markdownCell(column.name)} | ${markdownCell(column.type ?? "")} | ${column.nullable == null ? "" : column.nullable ? "YES" : "NO"} | ${markdownCell(column.roles.join(", "))} | ${column.masked ? "YES" : "NO"} | ${markdownCell(column.comment ?? "")} |`);
      }
      if (table.columnsTruncated) {
        lines.push("", `Columns were truncated by maxColumnsPerTable (${document.maxColumnsPerTable}).`);
      }
      lines.push("");
    }
    if (table.relationSummary) {
      lines.push(`Relationships: outbound ${table.relationSummary.outbound}, inbound ${table.relationSummary.inbound}, inferred ${table.relationSummary.inferred}.`, "");
    }
  }
  lines.push("## Notes", "");
  for (const warning of document.warnings) {
    lines.push(`- ${warning}`);
  }
  return lines.join("\n");
}

async function buildOnboardingDocument(
  selected: ReturnType<typeof selectRuntimeProfile>,
  input: {
    schema?: string;
    tablePattern?: string;
    businessTerms?: string[];
    maxTables: number;
    maxColumnsPerTable: number;
    maxCoreTables: number;
    relationshipLimit: number;
  }
) {
  const effectiveSchema = metadataSchema(selected.config, input.schema);
  if (effectiveSchema && !isSchemaAllowed(effectiveSchema, selected.config.policy)) {
    throw new Error(`Schema "${effectiveSchema}" is not allowed by the configured OceanBase MCP access policy.`);
  }
  const tableLimit = Math.min(input.maxTables, 100);
  const columnLimit = Math.min(input.maxColumnsPerTable, 50);
  const coreLimit = Math.min(input.maxCoreTables, 30);
  const relationLimit = Math.min(input.relationshipLimit, 50);
  const rawTables = await cachedSchemaMapTables(selected, effectiveSchema, input.tablePattern, tableLimit + 1);
  const visibleTables = filterSchemaMapTables(rawTables, selected.config).slice(0, tableLimit);
  const tableSummaries = [];
  for (const tableInfo of visibleTables) {
    tableSummaries.push(await buildSchemaMapTableSummary(
      selected,
      tableInfo,
      true,
      columnLimit,
      true,
      relationLimit
    ));
  }
  const coreTables = tableSummaries
    .map((table) => onboardingCoreTable(table))
    .sort((left, right) => right.score - left.score || qualifiedTableName(left).localeCompare(qualifiedTableName(right)))
    .slice(0, coreLimit);
  const relationships = onboardingRelationships(coreTables, relationLimit);
  const glossary = onboardingGlossary(selected.config, effectiveSchema, uniqueStrings(input.businessTerms ?? []), 20);
  const queryEntryPoints = coreTables.flatMap((table) =>
    table.queryEntryPoints.map((entry) => ({
      schema: table.schema,
      table: table.table,
      type: entry.type,
      fields: entry.fields,
      reason: entry.reason
    }))
  ).slice(0, 100);
  const warnings = uniqueStrings([
    "Onboarding documentation is based on metadata visible to the active MCP policy.",
    "No sample data values are included and no target query is executed.",
    "Purpose and table roles are inferred from visible metadata and business glossary hints; verify with domain knowledge before treating them as business facts.",
    rawTables.length > tableLimit ? `Only the first ${tableLimit} visible tables are included.` : "",
    tableSummaries.some((table) => table.columnsTruncated) ? `Some tables have more than ${columnLimit} visible columns; columns were truncated.` : "",
    relationships.truncated ? `Relationship output was limited to ${relationships.items.length} entries.` : "",
    ...glossary.warnings
  ]);

  return {
    generatedAt: new Date().toISOString(),
    mode: selected.config.compatibility,
    schema: effectiveSchema,
    tablePattern: input.tablePattern ?? null,
    scope: {
      maxTables: tableLimit,
      maxColumnsPerTable: columnLimit,
      maxCoreTables: coreLimit,
      relationshipLimit: relationLimit,
      tableCount: tableSummaries.length,
      truncated: rawTables.length > tableLimit
    },
    businessGlossary: glossary,
    coreTables: coreTables.map(({ score, ...table }) => table),
    relationships: relationships.items,
    queryEntryPoints,
    readingPath: onboardingReadingPath(coreTables, glossary.terms),
    warnings
  };
}

function onboardingCoreTable(table: Awaited<ReturnType<typeof buildSchemaMapTableSummary>>) {
  const columns = table.columns ?? [];
  const relationshipCount = (table.relationSummary?.outbound ?? 0) + (table.relationSummary?.inbound ?? 0);
  const purpose = inferTablePurpose(table.table, table.comment, columns);
  const queryEntryPoints = tableSummaryQueryEntryPoints(
    table.primaryKeys,
    table.timeFields,
    table.statusFields,
    table.relationSummary
  );
  return {
    schema: table.schema,
    table: table.table,
    tableType: table.tableType,
    comment: table.comment,
    rowEstimate: table.rowEstimate,
    purpose,
    primaryKeys: table.primaryKeys,
    keyFields: table.keyFields,
    timeFields: table.timeFields,
    statusFields: table.statusFields,
    relationshipCount,
    relationSummary: table.relationSummary,
    queryEntryPoints,
    columns,
    columnsTruncated: table.columnsTruncated,
    score: onboardingCoreTableScore(table, relationshipCount)
  };
}

function onboardingCoreTableScore(
  table: Awaited<ReturnType<typeof buildSchemaMapTableSummary>>,
  relationshipCount: number
): number {
  const rowEstimate = table.rowEstimate?.value ?? 0;
  return (
    relationshipCount * 6 +
    table.primaryKeys.length * 5 +
    table.keyFields.length * 2 +
    table.timeFields.length +
    table.statusFields.length +
    (table.comment ? 4 : 0) +
    Math.min(8, Math.log10(rowEstimate + 1))
  );
}

function onboardingRelationships(
  coreTables: Array<ReturnType<typeof onboardingCoreTable>>,
  limit: number
) {
  const seen = new Set<string>();
  const relationships = [];
  for (const table of coreTables) {
    for (const relation of table.relationSummary?.relations ?? []) {
      const signature = [
        relation.relationType,
        relation.sourceSchema ?? "",
        relation.sourceTable,
        relation.sourceColumns.join(","),
        relation.targetSchema ?? "",
        relation.targetTable,
        relation.targetColumns.join(",")
      ].map((part) => part.toLowerCase()).join("|");
      if (seen.has(signature)) {
        continue;
      }
      seen.add(signature);
      relationships.push({
        relationType: relation.relationType,
        direction: relation.direction,
        confidence: relation.confidence,
        sourceSchema: relation.sourceSchema,
        sourceTable: relation.sourceTable,
        sourceColumns: relation.sourceColumns,
        targetSchema: relation.targetSchema,
        targetTable: relation.targetTable,
        targetColumns: relation.targetColumns,
        evidence: relation.evidence
      });
    }
  }
  relationships.sort((left, right) => right.confidence - left.confidence || qualifiedRelationName(left).localeCompare(qualifiedRelationName(right)));
  return {
    items: relationships.slice(0, limit),
    truncated: relationships.length > limit
  };
}

function onboardingGlossary(
  config: ObConfig,
  schema: string | undefined,
  requestedTerms: string[],
  maxTerms: number
) {
  const glossary = config.businessGlossary;
  if (!glossary) {
    return {
      configured: false,
      requestedTerms,
      terms: [],
      policyFiltered: false,
      warnings: ["No business glossary is configured."]
    };
  }
  const terms = [];
  let policyFiltered = false;
  if (requestedTerms.length > 0) {
    for (const term of requestedTerms) {
      const result = searchBusinessGlossary(config, term, maxTerms, schema);
      policyFiltered = policyFiltered || result.policyFiltered;
      for (const match of result.matches) {
        terms.push({
          term: match.term,
          aliases: match.aliases,
          description: match.description,
          targets: match.targets,
          evidence: match.evidence
        });
      }
    }
  } else {
    for (const entry of glossary.entries) {
      const targets = visibleGlossaryTargets(config, entry.targets, schema);
      policyFiltered = policyFiltered || targets.policyFiltered;
      if (targets.visible.length === 0) {
        continue;
      }
      terms.push({
        term: entry.term,
        aliases: entry.aliases,
        description: entry.description,
        targets: targets.visible,
        evidence: ["Configured business glossary term."]
      });
      if (terms.length >= maxTerms) {
        break;
      }
    }
  }
  const uniqueTerms = dedupeOnboardingGlossaryTerms(terms).slice(0, maxTerms);
  const warnings = [];
  if (requestedTerms.length > 0 && uniqueTerms.length === 0) {
    warnings.push("No requested business terms matched visible glossary targets.");
  }
  if (policyFiltered) {
    warnings.push("Some business glossary targets were hidden by the active MCP access policy.");
  }
  return {
    configured: true,
    requestedTerms,
    terms: uniqueTerms,
    policyFiltered,
    warnings
  };
}

function dedupeOnboardingGlossaryTerms<T extends { term: string; targets: Array<{ schema?: string; table?: string; column?: string }> }>(terms: T[]): T[] {
  const seen = new Set<string>();
  const output = [];
  for (const term of terms) {
    const targetKey = term.targets
      .map((target) => `${target.schema ?? ""}.${target.table ?? ""}.${target.column ?? ""}`)
      .sort()
      .join("|");
    const key = `${term.term.toLowerCase()}|${targetKey.toLowerCase()}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    output.push(term);
  }
  return output;
}

function onboardingReadingPath(
  coreTables: Array<ReturnType<typeof onboardingCoreTable>>,
  terms: Array<{ term: string; targets: Array<{ schema?: string; table?: string; column?: string }> }>
) {
  const steps = [];
  const first = coreTables[0];
  if (first) {
    steps.push({
      step: "Start with the highest-signal table.",
      table: qualifiedTableName(first),
      reason: "This table has the strongest visible metadata signal from keys, relationships, comments, and row estimates."
    });
  }
  const related = coreTables.find((table) => table.relationshipCount > 0);
  if (related) {
    steps.push({
      step: "Review its related tables next.",
      table: qualifiedTableName(related),
      reason: "Visible relationship metadata or conservative relationship inference is available."
    });
  }
  const timeTable = coreTables.find((table) => table.timeFields.length > 0);
  if (timeTable) {
    steps.push({
      step: "Use time fields for recent-data exploration.",
      table: qualifiedTableName(timeTable),
      fields: timeTable.timeFields.slice(0, 5),
      reason: "Time-like columns were detected from visible column metadata."
    });
  }
  if (terms.length > 0) {
    steps.push({
      step: "Use business terms as navigation hints.",
      terms: terms.slice(0, 10).map((term) => term.term),
      reason: "Business glossary entries point to visible schema, table, or column targets."
    });
  }
  return steps;
}

function renderOnboardingDocumentMarkdown(document: Awaited<ReturnType<typeof buildOnboardingDocument>>, title?: string): string {
  const lines = [
    `# ${title ?? "OceanBase Onboarding Guide"}`,
    "",
    `Generated at: ${document.generatedAt}`,
    "",
    `Mode: ${document.mode}`,
    `Schema: ${document.schema ?? "default"}`,
    `Tables in scope: ${document.scope.tableCount}`,
    ""
  ];
  if (document.tablePattern) {
    lines.push(`Table pattern: ${document.tablePattern}`, "");
  }
  lines.push("## Core Tables", "");
  if (document.coreTables.length === 0) {
    lines.push("No visible tables matched the requested scope.", "");
  } else {
    lines.push("| Table | Purpose | Primary Keys | Key Fields | Time Fields | Status Fields | Relationships | Row Estimate |");
    lines.push("| --- | --- | --- | --- | --- | --- | --- | --- |");
    for (const table of document.coreTables) {
      lines.push(`| ${markdownCell(qualifiedTableName(table))} | ${markdownCell(table.purpose.summary)} | ${markdownCell(table.primaryKeys.join(", "))} | ${markdownCell(table.keyFields.join(", "))} | ${markdownCell(table.timeFields.join(", "))} | ${markdownCell(table.statusFields.join(", "))} | ${table.relationshipCount} | ${table.rowEstimate?.value ?? ""} |`);
    }
    lines.push("");
  }
  if (document.businessGlossary.terms.length > 0) {
    lines.push("## Business Terms", "");
    lines.push("| Term | Description | Targets | Evidence |");
    lines.push("| --- | --- | --- | --- |");
    for (const term of document.businessGlossary.terms) {
      lines.push(`| ${markdownCell(term.term)} | ${markdownCell(term.description ?? "")} | ${markdownCell(term.targets.map(glossaryTargetLabel).join(", "))} | ${markdownCell(term.evidence.join("; "))} |`);
    }
    lines.push("");
  }
  lines.push("## Relationships", "");
  if (document.relationships.length === 0) {
    lines.push("No visible relationships were found under the active policy.", "");
  } else {
    lines.push("| Type | Source | Target | Confidence | Evidence |");
    lines.push("| --- | --- | --- | --- | --- |");
    for (const relation of document.relationships) {
      const source = `${relation.sourceSchema ? `${relation.sourceSchema}.` : ""}${relation.sourceTable}(${relation.sourceColumns.join(", ")})`;
      const target = `${relation.targetSchema ? `${relation.targetSchema}.` : ""}${relation.targetTable}(${relation.targetColumns.join(", ")})`;
      lines.push(`| ${relation.relationType} | ${markdownCell(source)} | ${markdownCell(target)} | ${relation.confidence} | ${markdownCell(relation.evidence.map((item) => item.detail).join("; "))} |`);
    }
    lines.push("");
  }
  lines.push("## Query Entry Points", "");
  if (document.queryEntryPoints.length === 0) {
    lines.push("No query entry points were detected from visible metadata.", "");
  } else {
    lines.push("| Table | Type | Fields | Reason |");
    lines.push("| --- | --- | --- | --- |");
    for (const entry of document.queryEntryPoints.slice(0, 30)) {
      lines.push(`| ${markdownCell(`${entry.schema ? `${entry.schema}.` : ""}${entry.table}`)} | ${markdownCell(entry.type)} | ${markdownCell(formatQueryEntryFields(entry.fields))} | ${markdownCell(entry.reason)} |`);
    }
    lines.push("");
  }
  if (document.readingPath.length > 0) {
    lines.push("## Suggested Reading Path", "");
    for (const [index, item] of document.readingPath.entries()) {
      const subject = "table" in item && item.table ? ` ${item.table}` : "terms" in item && item.terms ? ` ${item.terms.join(", ")}` : "";
      lines.push(`${index + 1}. ${item.step}${subject ? `: ${subject}` : ""}`);
      lines.push(`   Reason: ${item.reason}`);
    }
    lines.push("");
  }
  lines.push("## Notes", "");
  for (const warning of document.warnings) {
    lines.push(`- ${warning}`);
  }
  return lines.join("\n");
}

function qualifiedTableName(table: { schema?: string; table: string }): string {
  return `${table.schema ? `${table.schema}.` : ""}${table.table}`;
}

function qualifiedRelationName(relation: { sourceSchema?: string; sourceTable: string; targetSchema?: string; targetTable: string }): string {
  return `${relation.sourceSchema ? `${relation.sourceSchema}.` : ""}${relation.sourceTable}->${relation.targetSchema ? `${relation.targetSchema}.` : ""}${relation.targetTable}`;
}

function glossaryTargetLabel(target: { schema?: string; table?: string; column?: string }): string {
  const table = `${target.schema ? `${target.schema}.` : ""}${target.table ?? "*"}`;
  return target.column ? `${table}.${target.column}` : table;
}

function formatQueryEntryFields(fields: unknown): string {
  if (!Array.isArray(fields)) {
    return "";
  }
  return fields.map((field) => {
    if (typeof field === "string") {
      return field;
    }
    if (field && typeof field === "object") {
      const record = field as Record<string, unknown>;
      const table = String(record.table ?? "");
      const columns = Array.isArray(record.columns) ? record.columns.join(", ") : "";
      return columns ? `${table}(${columns})` : table;
    }
    return String(field);
  }).filter(Boolean).join(", ");
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
    await cachedSchemaMapTables(selected, schema, table, 20),
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

interface ErScopeTable {
  schema?: string;
  table: string;
  sources: string[];
  confidence: number;
  evidence: string[];
}

interface BuildErDiagramInput {
  schema?: string;
  table?: string;
  tables?: string[];
  businessTerm?: string;
  depth?: number;
  maxTables?: number;
  maxRelationships?: number;
  minConfidence?: number;
  relationshipMode?: "none" | "foreign_key" | "inferred";
  includeInferred: boolean;
}

type ErExportStrategy = "single" | "connected-components" | "table-prefix" | "business-term" | "manual" | "window";

interface BuildErExportPlanInput extends BuildErDiagramInput {
  format: "html-static" | "html-interactive" | "html-compact" | "html-detailed";
  chunkSize?: number;
  outputDir?: string;
  strategy?: ErExportStrategy;
  maxColumnsPerTable?: number;
}

interface ErDiagramToolResponse {
  mode: ObConfig["compatibility"];
  schema?: string;
  rootTable: string | null;
  businessTerm: string | null;
  scope: ReturnType<typeof erScopeTableOutput>[];
  maxTables: number;
  maxRelationships: number;
  depth: number;
  minConfidence: number;
  relationshipMode: "none" | "foreign_key" | "inferred";
  includeInferred: boolean;
  tableCount: number;
  relationshipCount: number;
  discoveredRelationshipCount: number;
  filteredRelationshipCount: number;
  status: ErGraphStatus;
  diagnostics: ErGraphDiagnostic[];
  stats: {
    selectedTables: number;
    loadedTables: number;
    loadedColumns: number;
    relationships: number;
    queryCount: number;
    elapsedMs: number;
    cacheUsed: boolean;
    cacheStats: {
      hits: number;
      misses: number;
      evictions: number;
      entries: number;
    };
    truncated: boolean;
    skippedStages: string[];
    warnings: string[];
  };
  mermaid: string;
  diagram: {
    entities: ErEntity[];
    relationships: TableRelationship[];
  };
  graph: ErGraph;
  warnings: string[];
}

async function buildErDiagramResult(
  selected: ReturnType<typeof selectRuntimeProfile>,
  input: BuildErDiagramInput
): Promise<{ diagram: ErDiagram; response: ErDiagramToolResponse }> {
  const startedAt = Date.now();
  const effectiveSchema = metadataSchema(selected.config, input.schema);
  const configuredMaxTables = Math.max(1, selected.config.erMaxTables);
  const tableLimit = Math.min(input.maxTables ?? (input.table ? Math.min(20, configuredMaxTables) : Math.min(12, configuredMaxTables)), configuredMaxTables, 500);
  const maxRelationships = Math.min(input.maxRelationships ?? selected.config.erMaxRelationships, selected.config.erMaxRelationships, 1000);
  const depthLimit = input.depth ?? 1;
  const relationshipMode = input.includeInferred ? "inferred" : input.relationshipMode ?? "foreign_key";
  const includeInferred = relationshipMode === "inferred";
  const relationConfidenceFloor = input.minConfidence ?? (includeInferred ? 0.5 : 0.9);
  const requestedTables = uniqueStrings([input.table, ...(input.tables ?? [])].filter((value): value is string => Boolean(value)));
  if (requestedTables.length === 0 && !input.businessTerm && !effectiveSchema) {
    throw new Error("Pass schema or table when generating an ER diagram without a configured default schema.");
  }

  const scope = new Map<string, ErScopeTable>();
  const relationships: TableRelationship[] = [];
  const warnings: string[] = [];
  const skippedStages: string[] = [];
  let relationshipScopeLimited = false;
  let queryCount = 0;
  let truncated = false;
  const erTimeoutMs = Math.min(selected.config.erQueryTimeoutMs, selected.config.queryTimeoutMs);
  const timeExpired = () => Date.now() - startedAt >= selected.config.erTotalTimeoutMs;
  const stageQuery = async <T>(operation: () => Promise<T>): Promise<T> => {
    queryCount += 1;
    return withQuerySlot(selected, operation);
  };

  for (const requestedTable of requestedTables) {
    const ref = parseErInputTableRef(selected.config.compatibility, requestedTable, effectiveSchema);
    assertTableAccess(ref.schema, ref.table, policyContext(selected.config));
    addErScopeTable(scope, selected.config.compatibility, ref.schema, ref.table, tableLimit, {
      source: requestedTable === input.table ? "explicit_table" : "explicit_tables",
      confidence: 1,
      evidence: [`Requested table ${requestedTable}.`]
    });
  }

  if (input.businessTerm) {
    const candidates = await findPrepareQueryCandidates(
      selected,
      prepareQuerySearchTerms(input.businessTerm, input.businessTerm, undefined),
      effectiveSchema,
      tableLimit,
      warnings
    );
    for (const candidate of candidates) {
      addErScopeTable(scope, selected.config.compatibility, candidate.schema, candidate.table, tableLimit, {
        source: "business_term",
        confidence: candidate.confidence,
        evidence: candidate.evidence.map((item) => `${item.field}: ${item.value} (${item.reason})`).slice(0, 5)
      });
    }
    if (candidates.length === 0) {
      warnings.push("No visible table matched the supplied businessTerm.");
    }
  }

  if (scope.size === 0) {
    const rows = filterTables(
      await stageQuery(() =>
        listTables(
          selected.pool,
          selected.config.compatibility,
          effectiveSchema,
          tableLimit,
          erTimeoutMs
        )
      ),
      selected.config.policy
    );
    for (const row of rows) {
      const ref = tableRefFromMetadata(row, effectiveSchema);
      if (ref) {
        addErScopeTable(scope, selected.config.compatibility, ref.schema, ref.table, tableLimit, {
          source: "schema_scan",
          confidence: 1,
          evidence: ["Returned from visible table metadata."]
        });
      }
    }
  }

  const initialRefs = [...scope.values()];
  let discoveredRelationshipCount = 0;
  let filteredRelationshipCount = 0;
  const relationshipKeys = new Set<string>();
  if (relationshipMode === "none") {
    skippedStages.push("relationships");
    warnings.push("Relationship discovery was skipped because relationshipMode=none.");
  } else {
    let frontier: TableRef[] = initialRefs.map((ref) => ({ schema: ref.schema, table: ref.table }));
    const visitedRelationshipRefs = new Set<string>();
    for (let depth = 1; depth <= depthLimit && frontier.length > 0; depth += 1) {
      if (timeExpired()) {
        truncated = true;
        skippedStages.push("relationships_timeout");
        warnings.push(`ER relationship discovery stopped after OB_ER_TOTAL_TIMEOUT_MS=${selected.config.erTotalTimeoutMs}.`);
        break;
      }
      if (relationships.length >= maxRelationships) {
        truncated = true;
        relationshipScopeLimited = true;
        warnings.push(`Relationship discovery stopped at maxRelationships=${maxRelationships}.`);
        break;
      }
      const batchRefs = frontier.filter((ref) => {
        const key = tableRefKey(selected.config.compatibility, ref.schema, ref.table);
        if (visitedRelationshipRefs.has(key)) {
          return false;
        }
        visitedRelationshipRefs.add(key);
        return true;
      });
      frontier = [];
      if (batchRefs.length === 0) {
        continue;
      }
      const batch = relationshipMode === "foreign_key"
        ? await withQuerySlot(selected, () =>
            listErForeignKeyRelationshipsBatch(
              selected.pool,
              selected.config.compatibility,
              batchRefs,
              erTimeoutMs
            )
          )
        : await withQuerySlot(selected, () =>
            loadErMetadataBatch(selected.pool, selected.config.compatibility, batchRefs, {
              relationshipMode,
              maxRelationships: Math.max(1, maxRelationships - relationships.length),
              timeoutMs: erTimeoutMs
            })
          );
      queryCount += batch.queryCount;
      warnings.push(...batch.warnings);
      for (const relation of batch.relationships) {
        discoveredRelationshipCount += 1;
        const scopedRelation = { ...relation, depth };
        if (!isErRelationshipVisible(scopedRelation, selected.config, relationConfidenceFloor, includeInferred)) {
          filteredRelationshipCount += 1;
          continue;
        }
        const key = erRelationshipKey(selected.config.compatibility, scopedRelation);
        if (relationshipKeys.has(key)) {
          continue;
        }
        if (relationships.length >= maxRelationships) {
          truncated = true;
          relationshipScopeLimited = true;
          break;
        }
        relationshipKeys.add(key);
        relationships.push(scopedRelation);
        const evidence = scopedRelation.evidence.map((item) => item.detail).slice(0, 5);
        const sourceKey = tableRefKey(selected.config.compatibility, scopedRelation.sourceSchema, scopedRelation.sourceTable);
        const targetKey = tableRefKey(selected.config.compatibility, scopedRelation.targetSchema, scopedRelation.targetTable);
        const hadSource = scope.has(sourceKey);
        const hadTarget = scope.has(targetKey);
        const addedSource = addErScopeTable(scope, selected.config.compatibility, scopedRelation.sourceSchema, scopedRelation.sourceTable, tableLimit, {
          source: "relationship",
          confidence: scopedRelation.confidence,
          evidence
        });
        const addedTarget = addErScopeTable(scope, selected.config.compatibility, scopedRelation.targetSchema, scopedRelation.targetTable, tableLimit, {
          source: "relationship",
          confidence: scopedRelation.confidence,
          evidence
        });
        if (!addedSource || !addedTarget) {
          relationshipScopeLimited = true;
        }
        if (depth < depthLimit) {
          if (addedSource && !hadSource) {
            frontier.push({ schema: scopedRelation.sourceSchema, table: scopedRelation.sourceTable });
          }
          if (addedTarget && !hadTarget) {
            frontier.push({ schema: scopedRelation.targetSchema, table: scopedRelation.targetTable });
          }
        }
      }
      if (truncated) {
        break;
      }
    }
  }

  const entities: ErEntity[] = [];
  let loadedColumns = 0;
  const finalRefs = [...scope.values()].map((ref) => ({ schema: ref.schema, table: ref.table }));
  let columnsByTable = new Map<string, unknown[]>();
  let constraintsByTable = new Map<string, unknown[]>();
  let indexesByTable = new Map<string, unknown[]>();
  if (finalRefs.length > 0) {
    if (timeExpired()) {
      truncated = true;
      skippedStages.push("entities_timeout");
      warnings.push(`ER table metadata loading stopped after OB_ER_TOTAL_TIMEOUT_MS=${selected.config.erTotalTimeoutMs}.`);
    } else {
      const batch = await withQuerySlot(selected, () =>
        loadErMetadataBatch(selected.pool, selected.config.compatibility, finalRefs, {
          relationshipMode: "none",
          maxRelationships: 1,
          timeoutMs: erTimeoutMs
        })
      );
      queryCount += batch.queryCount;
      warnings.push(...batch.warnings);
      columnsByTable = groupErMetadataRows(selected.config.compatibility, filterColumnMetadata(batch.columns, selected.config.policy));
      constraintsByTable = groupErMetadataRows(selected.config.compatibility, filterColumnMetadata(batch.constraints, selected.config.policy));
      indexesByTable = groupErMetadataRows(selected.config.compatibility, filterColumnMetadata(batch.indexes, selected.config.policy));
    }
  }
  for (const ref of scope.values()) {
    const key = tableRefKey(selected.config.compatibility, ref.schema, ref.table);
    const columns = columnsByTable.get(key) ?? [];
    const constraints = constraintsByTable.get(key) ?? [];
    const indexes = indexesByTable.get(key) ?? [];
    loadedColumns += columns.length;
    const visibleColumns = columns.slice(0, selected.config.erMaxColumnsPerTable);
    if (columns.length > visibleColumns.length) {
      truncated = true;
      warnings.push(`Columns for ${ref.schema ? `${ref.schema}.` : ""}${ref.table} were limited to OB_ER_MAX_COLUMNS_PER_TABLE=${selected.config.erMaxColumnsPerTable}.`);
    }
    entities.push(erEntityFromMetadata(selected.config.compatibility, ref.schema, ref.table, visibleColumns, constraints, indexes));
  }

  const entityKeys = new Set(
    entities.map((entity) => tableRefKey(selected.config.compatibility, entity.schema, entity.table))
  );
  const diagramRelationships = dedupeRelationships(selected.config.compatibility, relationships).filter(
    (relation) =>
      entityKeys.has(tableRefKey(selected.config.compatibility, relation.sourceSchema, relation.sourceTable)) &&
      entityKeys.has(tableRefKey(selected.config.compatibility, relation.targetSchema, relation.targetTable))
  );
  const responseWarnings = uniqueStrings([
    ...warnings,
    ...(relationshipScopeLimited ? ["Some related tables were omitted because maxTables was reached."] : []),
    ...(relationshipMode === "foreign_key" ? ["Name-inferred relationships are disabled by default; pass relationshipMode=inferred for a bounded inferred diagram."] : []),
    ...(filteredRelationshipCount > 0
      ? [`${filteredRelationshipCount} relationship(s) were hidden by policy, minConfidence, or includeInferred.`]
      : [])
  ]);
  const graphDiagnostics = erDiagnosticsFromWarnings(responseWarnings, {
    truncated,
    relationshipScopeLimited,
    filteredRelationshipCount
  });
  const diagram = buildErDiagram(selected.config.compatibility, entities, diagramRelationships, {
    diagnostics: graphDiagnostics
  });
  const response = {
    mode: selected.config.compatibility,
    schema: effectiveSchema,
    rootTable: input.table ?? null,
    businessTerm: input.businessTerm ?? null,
    scope: [...scope.values()].map(erScopeTableOutput),
    maxTables: tableLimit,
    maxRelationships,
    depth: depthLimit,
    minConfidence: relationConfidenceFloor,
    relationshipMode,
    includeInferred,
    tableCount: entities.length,
    relationshipCount: diagramRelationships.length,
    discoveredRelationshipCount,
    filteredRelationshipCount,
    status: diagram.graph.status,
    diagnostics: diagram.graph.diagnostics,
    stats: {
      selectedTables: scope.size,
      loadedTables: entities.length,
      loadedColumns,
      relationships: diagramRelationships.length,
      queryCount,
      elapsedMs: Date.now() - startedAt,
      cacheUsed: selected.config.metadataCacheEnabled,
      cacheStats: {
        hits: selected.metadataCache.hits,
        misses: selected.metadataCache.misses,
        evictions: selected.metadataCache.evictions,
        entries: selected.metadataCache.entries.size
      },
      truncated,
      skippedStages,
      warnings
    },
    mermaid: diagram.mermaid,
    diagram: {
      entities: diagram.entities,
      relationships: diagram.relationships
    },
    graph: diagram.graph,
    warnings: responseWarnings
  };
  return { diagram, response };
}

function defaultErHtmlTitle(response: ErDiagramToolResponse): string {
  if (response.businessTerm) {
    return `OceanBase ER Diagram - ${response.businessTerm}`;
  }
  if (response.rootTable) {
    return `OceanBase ER Diagram - ${response.rootTable}`;
  }
  return response.schema ? `OceanBase ER Diagram - ${response.schema}` : "OceanBase ER Diagram";
}

function shouldSkipSchemaInlineErHtmlRender(
  response: ErDiagramToolResponse,
  input: Pick<BuildErDiagramInput, "table" | "tables" | "businessTerm">
): boolean {
  const explicitScope = Boolean(input.table || input.businessTerm || (input.tables && input.tables.length > 0));
  return !explicitScope && response.tableCount > SCHEMA_INLINE_ER_TABLE_RENDER_LIMIT;
}

function erDiagnosticsFromWarnings(
  warnings: string[],
  context: {
    truncated: boolean;
    relationshipScopeLimited: boolean;
    filteredRelationshipCount: number;
  }
): ErGraphDiagnostic[] {
  const diagnostics: ErGraphDiagnostic[] = [];
  if (context.truncated) {
    diagnostics.push({
      level: "warning",
      code: "er_scope_truncated",
      message: "ER metadata was truncated by configured limits or timeout.",
      action: "Use a narrower schema/table scope or run a chunked ER export."
    });
  }
  if (context.relationshipScopeLimited) {
    diagnostics.push({
      level: "warning",
      code: "er_relationship_scope_limited",
      message: "Some related tables were omitted from the ER scope.",
      action: "Increase maxTables within the configured limit or inspect a smaller table neighborhood."
    });
  }
  if (context.filteredRelationshipCount > 0) {
    diagnostics.push({
      level: "note",
      code: "er_relationships_filtered",
      message: `${context.filteredRelationshipCount} relationship(s) were hidden by policy or confidence settings.`,
      action: "Review relationshipMode, minConfidence, and active access policy.",
      count: context.filteredRelationshipCount
    });
  }
  if (warnings.some((warning) => /Name-inferred relationships are disabled/i.test(warning))) {
    diagnostics.push({
      level: "note",
      code: "er_inferred_relationships_disabled",
      message: "Name-inferred relationships are disabled for this ER request.",
      action: "Use relationshipMode=inferred for a bounded explicit scope when database foreign keys are not available."
    });
  }
  return diagnostics;
}

function fitErDiagramResponseForLimit(response: ErDiagramToolResponse, config: ObConfig): ErDiagramToolResponse | (Omit<ErDiagramToolResponse, "mermaid" | "diagram"> & {
  mermaidOmitted: boolean;
  diagramOmitted: boolean;
  graphOmitted: boolean;
  estimatedBytes: number;
}) {
  const estimatedBytes = jsonByteLength(response);
  if (estimatedBytes <= config.maxResultBytes * 0.75) {
    return response;
  }
  return {
    ...response,
    mermaid: "",
    diagram: {
      entities: [],
      relationships: []
    },
    graph: {
      ...response.graph,
      nodes: [],
      edges: []
    },
    mermaidOmitted: true,
    diagramOmitted: true,
    graphOmitted: true,
    estimatedBytes,
    warnings: uniqueStrings([
      ...response.warnings,
      `ER diagram metadata is ${estimatedBytes} bytes; Mermaid, graph nodes, graph edges, and JSON details were omitted to stay within OB_MAX_RESULT_BYTES. Use CLI ER export for the full artifact.`
    ])
  };
}

function buildErExportCommand(
  response: Pick<
    ErDiagramToolResponse,
    "schema" | "rootTable" | "businessTerm" | "relationshipMode" | "maxTables" | "maxRelationships"
  >,
  format: string,
  options: { tables?: string[]; output?: string; maxTables?: number; maxColumnsPerTable?: number } = {}
): string {
  const args = ["ob-mcp", "export-er"];
  if (response.schema) {
    args.push("--schema", shellArg(response.schema));
  }
  if (options.tables && options.tables.length > 0) {
    args.push("--tables", shellArg(options.tables.join(",")));
  } else if (response.rootTable) {
    args.push("--table", shellArg(response.rootTable));
  } else if (response.businessTerm) {
    args.push("--business-term", shellArg(response.businessTerm));
  }
  args.push("--relationship-mode", response.relationshipMode);
  args.push("--max-tables", String(options.maxTables ?? response.maxTables));
  args.push("--max-relationships", String(response.maxRelationships));
  if (options.maxColumnsPerTable) {
    args.push("--max-columns-per-table", String(options.maxColumnsPerTable));
  }
  args.push("--format", format.replace(/^html-/, ""));
  args.push("--out", shellArg(options.output ?? "er-output.html"));
  return args.join(" ");
}

async function buildErExportPlanResult(
  selected: ReturnType<typeof selectRuntimeProfile>,
  input: BuildErExportPlanInput
) {
  const startedAt = Date.now();
  const effectiveSchema = metadataSchema(selected.config, input.schema);
  const configuredMaxTables = Math.max(1, selected.config.erMaxTables);
  const tableLimit = Math.min(input.maxTables ?? configuredMaxTables, configuredMaxTables, 500);
  const maxRelationships = Math.min(input.maxRelationships ?? selected.config.erMaxRelationships, selected.config.erMaxRelationships, 1000);
  const relationshipMode = input.includeInferred ? "inferred" : input.relationshipMode ?? "foreign_key";
  const includeInferred = relationshipMode === "inferred";
  const erTimeoutMs = Math.min(selected.config.erQueryTimeoutMs, selected.config.queryTimeoutMs);
  const warnings: string[] = [];
  const risks: string[] = [];
  const skippedStages: string[] = [];
  let queryCount = 0;
  let truncated = false;

  if (!input.table && (!input.tables || input.tables.length === 0) && !input.businessTerm && !effectiveSchema) {
    throw new Error("Pass schema, table, tables, or businessTerm when planning an ER export.");
  }

  const planStats = effectiveSchema
    ? await withQuerySlot(selected, async () => {
        const stats = await estimateErExportPlanStats(selected.pool, selected.config.compatibility, effectiveSchema, erTimeoutMs);
        queryCount += stats.queryCount;
        return stats;
      })
    : {
        schema: effectiveSchema,
        estimatedTableCount: 0,
        estimatedColumnCount: 0,
        estimatedRelationshipCount: 0,
        largeTables: [],
        queryCount: 0,
        warnings: ["Schema-level estimates are unavailable because no schema was resolved."]
      };
  warnings.push(...planStats.warnings);

  const scope = new Map<string, ErScopeTable>();
  const requestedTables = uniqueStrings([input.table, ...(input.tables ?? [])].filter((value): value is string => Boolean(value)));
  for (const requestedTable of requestedTables) {
    const ref = parseErInputTableRef(selected.config.compatibility, requestedTable, effectiveSchema);
    assertTableAccess(ref.schema, ref.table, policyContext(selected.config));
    addErScopeTable(scope, selected.config.compatibility, ref.schema, ref.table, tableLimit, {
      source: requestedTable === input.table ? "explicit_table" : "explicit_tables",
      confidence: 1,
      evidence: [`Requested table ${requestedTable}.`]
    });
  }

  if (input.businessTerm && scope.size < tableLimit) {
    const candidates = await findPrepareQueryCandidates(
      selected,
      prepareQuerySearchTerms(input.businessTerm, input.businessTerm, undefined),
      effectiveSchema,
      tableLimit - scope.size,
      warnings
    );
    for (const candidate of candidates) {
      addErScopeTable(scope, selected.config.compatibility, candidate.schema, candidate.table, tableLimit, {
        source: "business_term",
        confidence: candidate.confidence,
        evidence: candidate.evidence.map((item) => `${item.field}: ${item.value} (${item.reason})`).slice(0, 5)
      });
    }
    if (candidates.length === 0 && requestedTables.length === 0) {
      warnings.push("No visible table matched the supplied businessTerm.");
    }
  }

  if (scope.size === 0) {
    const rows = filterTables(
      await withQuerySlot(selected, () =>
        listTables(
          selected.pool,
          selected.config.compatibility,
          effectiveSchema,
          tableLimit + 1,
          erTimeoutMs
        )
      ),
      selected.config.policy
    );
    queryCount += 1;
    for (const row of rows.slice(0, tableLimit)) {
      const ref = tableRefFromMetadata(row, effectiveSchema);
      if (ref) {
        addErScopeTable(scope, selected.config.compatibility, ref.schema, ref.table, tableLimit, {
          source: "schema_scan",
          confidence: 1,
          evidence: ["Returned from visible table metadata."]
        });
      }
    }
    if (rows.length > tableLimit || planStats.estimatedTableCount > tableLimit) {
      truncated = true;
      warnings.push(`ER export plan selected ${scope.size} table(s); schema estimate is ${planStats.estimatedTableCount}. Use --max-tables or a narrower scope for more tables.`);
    }
  }

  const refs = [...scope.values()].map((ref) => ({ schema: ref.schema, table: ref.table }));
  let relationships: TableRelationship[] = [];
  if (relationshipMode === "none") {
    skippedStages.push("relationships");
    warnings.push("Relationship discovery was skipped because relationshipMode=none.");
  } else if (refs.length > 0) {
    const batch = await withQuerySlot(selected, () =>
      listErForeignKeyRelationshipsBatch(
        selected.pool,
        selected.config.compatibility,
        refs,
        erTimeoutMs
      )
    );
    queryCount += batch.queryCount;
    warnings.push(...batch.warnings);
    relationships = dedupeRelationships(selected.config.compatibility, batch.relationships)
      .filter((relation) => isRelationshipAllowed(relation, selected.config));
    if (relationships.length > maxRelationships) {
      truncated = true;
      relationships = relationships.slice(0, maxRelationships);
      warnings.push(`Relationship planning stopped at maxRelationships=${maxRelationships}.`);
    }
    if (relationshipMode === "inferred") {
      warnings.push("Plan mode does not expand inferred relationships. Generate inferred ER only for a small explicit scope.");
    }
  }

  const strategy = input.strategy ?? suggestErExportStrategy({
    tableCount: refs.length,
    estimatedTableCount: planStats.estimatedTableCount,
    relationshipCount: relationships.length,
    businessTerm: input.businessTerm,
    explicitTables: requestedTables.length
  });
  const chunkSize = Math.max(1, Math.min(input.chunkSize ?? Math.min(25, selected.config.erMaxTables), selected.config.erMaxTables, 100));
  const chunks = planErExportChunks(selected.config.compatibility, refs, relationships, strategy, chunkSize);
  const outputDir = input.outputDir?.replace(/\/+$/g, "");
  const commandBase = {
    schema: planStats.schema ?? effectiveSchema,
    rootTable: input.table ?? null,
    businessTerm: input.businessTerm ?? null,
    relationshipMode,
    maxTables: tableLimit,
    maxRelationships
  };
  const maxColumnsPerTable = input.maxColumnsPerTable ?? selected.config.erMaxColumnsPerTable;
  const plannedChunks = chunks.map((chunk, index) => {
    const file = outputDir
      ? `${outputDir}/clusters/cluster-${String(index + 1).padStart(3, "0")}.html`
      : `cluster-${String(index + 1).padStart(3, "0")}.html`;
    const tableNames = chunk.map((item) => tableLabelForCommand(item.schema, item.table));
    return {
      index: index + 1,
      tableCount: chunk.length,
      tables: tableNames,
      file,
      command: buildErExportCommand(commandBase, input.format, {
        tables: tableNames,
        output: file,
        maxTables: chunk.length,
        maxColumnsPerTable
      })
    };
  });
  const plannedRelationships = planErExportRelationships(selected.config.compatibility, relationships, chunks);

  if (planStats.estimatedTableCount > chunkSize) {
    risks.push("Schema is larger than one ER cluster; use cluster export instead of inline ER.");
  }
  if (planStats.estimatedColumnCount > planStats.estimatedTableCount * Math.max(1, selected.config.erMaxColumnsPerTable)) {
    risks.push("Column count is high; keep main diagrams compact and open table pages for details.");
  }
  if (relationshipMode === "inferred") {
    risks.push("Inferred relationships are naming-based hints, not database constraints.");
  }

  return {
    mode: selected.config.compatibility,
    schema: planStats.schema ?? effectiveSchema,
    rootTable: input.table ?? null,
    businessTerm: input.businessTerm ?? null,
    strategy,
    suggestedStrategy: strategy,
    suggestedMaxTablesPerFile: chunkSize,
    suggestedRelationshipMode: relationshipMode === "inferred" ? "foreign_key" : relationshipMode,
    estimatedTableCount: planStats.estimatedTableCount || refs.length,
    estimatedColumnCount: planStats.estimatedColumnCount,
    estimatedRelationshipCount: planStats.estimatedRelationshipCount || relationships.length,
    largeTables: planStats.largeTables,
    risks,
    recommendedNextTools: [
      "ob_plan_er_export",
      "ob-mcp export-er --out-dir",
      "ob_generate_er_html for small explicit table scopes",
      "ob_find_related_tables for relationship evidence"
    ],
    format: input.format,
    tableCount: refs.length,
    relationshipCount: relationships.length,
    crossClusterRelationshipCount: plannedRelationships.filter((relationship) => relationship.crossCluster).length,
    chunkSize,
    chunkCount: plannedChunks.length,
    inlineHtmlLimitBytes: selected.config.erInlineHtmlMaxBytes,
    singleFileCommand: buildErExportCommand(commandBase, input.format, { maxColumnsPerTable }),
    chunks: plannedChunks,
    relationships: plannedRelationships,
    stats: {
      selectedTables: refs.length,
      loadedTables: refs.length,
      loadedColumns: 0,
      relationships: relationships.length,
      queryCount,
      elapsedMs: Date.now() - startedAt,
      cacheUsed: selected.config.metadataCacheEnabled,
      cacheStats: {
        hits: selected.metadataCache.hits,
        misses: selected.metadataCache.misses,
        evictions: selected.metadataCache.evictions,
        entries: selected.metadataCache.entries.size
      },
      truncated,
      skippedStages,
      warnings
    },
    warnings: uniqueStrings([
      ...warnings,
      ...(plannedChunks.length > 1
        ? ["Use cluster export commands for large schemas to avoid inline MCP response limits and browser rendering pressure."]
        : ["The scope fits in one planned export cluster."]),
      ...(includeInferred ? ["Use relationshipMode=inferred only for small explicit scopes."] : [])
    ])
  };
}

function planErExportRelationships(
  mode: ObConfig["compatibility"],
  relationships: TableRelationship[],
  chunks: TableRef[][]
) {
  const clusterByTable = new Map<string, number>();
  chunks.forEach((chunk, index) => {
    for (const ref of chunk) {
      clusterByTable.set(tableRefKey(mode, ref.schema, ref.table), index + 1);
    }
  });
  return relationships.map((relationship, index) => {
    const sourceKey = tableRefKey(mode, relationship.sourceSchema, relationship.sourceTable);
    const targetKey = tableRefKey(mode, relationship.targetSchema, relationship.targetTable);
    const sourceCluster = clusterByTable.get(sourceKey);
    const targetCluster = clusterByTable.get(targetKey);
    return {
      index: index + 1,
      relationType: relationship.relationType,
      direction: relationship.direction,
      confidence: Number(relationship.confidence.toFixed(3)),
      sourceRule: relationship.evidence[0]?.type ?? relationship.relationType,
      source: {
        schema: relationship.sourceSchema,
        table: relationship.sourceTable,
        label: tableLabelForCommand(relationship.sourceSchema, relationship.sourceTable),
        columns: relationship.sourceColumns,
        cluster: sourceCluster
      },
      target: {
        schema: relationship.targetSchema,
        table: relationship.targetTable,
        label: tableLabelForCommand(relationship.targetSchema, relationship.targetTable),
        columns: relationship.targetColumns,
        cluster: targetCluster
      },
      constraintName: relationship.constraintName,
      evidence: relationship.evidence.map((item) => ({
        type: item.type,
        detail: item.detail,
        columns: item.columns
      })).slice(0, 10),
      crossCluster: Boolean(sourceCluster && targetCluster && sourceCluster !== targetCluster)
    };
  });
}

function suggestErExportStrategy(input: {
  tableCount: number;
  estimatedTableCount: number;
  relationshipCount: number;
  businessTerm?: string;
  explicitTables: number;
}): ErExportStrategy {
  if (input.explicitTables > 0) {
    return "manual";
  }
  if (input.businessTerm) {
    return "business-term";
  }
  if (input.estimatedTableCount <= 25 && input.tableCount <= 25) {
    return "single";
  }
  if (input.relationshipCount > 0) {
    return "connected-components";
  }
  return "table-prefix";
}

function planErExportChunks(
  mode: ObConfig["compatibility"],
  refs: TableRef[],
  relationships: TableRelationship[],
  strategy: ErExportStrategy,
  chunkSize: number
): TableRef[][] {
  const sortedRefs = [...refs].sort((left, right) =>
    tableLabelForCommand(left.schema, left.table).localeCompare(tableLabelForCommand(right.schema, right.table))
  );
  if (strategy === "connected-components" && relationships.length > 0) {
    return packChunkGroups(connectedComponentChunks(mode, sortedRefs, relationships), chunkSize);
  }
  if (strategy === "table-prefix") {
    return packChunkGroups(prefixChunks(sortedRefs), chunkSize);
  }
  return chunkItems(sortedRefs, chunkSize);
}

function packChunkGroups(groups: TableRef[][], chunkSize: number): TableRef[][] {
  const chunks: TableRef[][] = [];
  let current: TableRef[] = [];
  const flush = () => {
    if (current.length > 0) {
      chunks.push(current);
      current = [];
    }
  };
  for (const group of groups) {
    for (const part of chunkItems(group, chunkSize)) {
      if (part.length >= chunkSize) {
        flush();
        chunks.push(part);
        continue;
      }
      if (current.length + part.length > chunkSize) {
        flush();
      }
      current.push(...part);
    }
  }
  flush();
  return chunks;
}

function prefixChunks(refs: TableRef[]): TableRef[][] {
  const groups = new Map<string, TableRef[]>();
  for (const ref of refs) {
    const prefix = tablePrefix(ref.table);
    groups.set(prefix, [...(groups.get(prefix) ?? []), ref]);
  }
  return [...groups.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, group]) => group);
}

function connectedComponentChunks(
  mode: ObConfig["compatibility"],
  refs: TableRef[],
  relationships: TableRelationship[]
): TableRef[][] {
  const refsByKey = new Map(refs.map((ref) => [tableRefKey(mode, ref.schema, ref.table), ref]));
  const parent = new Map([...refsByKey.keys()].map((key) => [key, key]));
  const find = (key: string): string => {
    const current = parent.get(key) ?? key;
    if (current === key) {
      return current;
    }
    const root = find(current);
    parent.set(key, root);
    return root;
  };
  const union = (left: string, right: string) => {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot !== rightRoot) {
      parent.set(rightRoot, leftRoot);
    }
  };
  for (const relation of relationships) {
    const sourceKey = tableRefKey(mode, relation.sourceSchema, relation.sourceTable);
    const targetKey = tableRefKey(mode, relation.targetSchema, relation.targetTable);
    if (refsByKey.has(sourceKey) && refsByKey.has(targetKey)) {
      union(sourceKey, targetKey);
    }
  }
  const groups = new Map<string, TableRef[]>();
  for (const [key, ref] of refsByKey.entries()) {
    const root = find(key);
    groups.set(root, [...(groups.get(root) ?? []), ref]);
  }
  return [...groups.values()].sort((left, right) => right.length - left.length);
}

function tablePrefix(table: string): string {
  const normalized = table.trim();
  const underscore = normalized.indexOf("_");
  if (underscore > 0) {
    return normalized.slice(0, underscore).toLowerCase();
  }
  const match = normalized.match(/^[A-Za-z]+/);
  return (match?.[0] ?? normalized).toLowerCase();
}

function tableLabelForCommand(schema: string | undefined, table: string): string {
  return schema ? `${schema}.${table}` : table;
}

function chunkItems<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

function shellArg(value: string): string {
  return /^[A-Za-z0-9_./:-]+$/.test(value) ? value : `'${value.replace(/'/g, "'\\''")}'`;
}

function entityRelationshipEvidence(relation: TableRelationship) {
  return {
    relationType: relation.relationType,
    direction: relation.direction,
    confidence: relation.confidence,
    source: {
      schema: relation.sourceSchema,
      table: relation.sourceTable,
      columns: relation.sourceColumns
    },
    target: {
      schema: relation.targetSchema,
      table: relation.targetTable,
      columns: relation.targetColumns
    },
    constraintName: relation.constraintName,
    evidence: relation.evidence.map((item) => ({
      type: item.type,
      detail: item.detail,
      columns: item.columns
    }))
  };
}

function relationshipConnectsTables(
  mode: ObConfig["compatibility"],
  relation: TableRelationship,
  left: { schema?: string; table: string },
  right: { schema?: string; table: string }
): boolean {
  const source = { schema: relation.sourceSchema, table: relation.sourceTable };
  const target = { schema: relation.targetSchema, table: relation.targetTable };
  return (
    sameTableRef(mode, source, left) &&
    sameTableRef(mode, target, right)
  ) || (
    sameTableRef(mode, source, right) &&
    sameTableRef(mode, target, left)
  );
}

function relationshipPaths(
  mode: ObConfig["compatibility"],
  relations: TableRelationship[],
  source: { schema?: string; table: string },
  target: { schema?: string; table: string },
  maxDepth: number,
  maxPaths: number
): Array<{
  tables: Array<{ schema?: string; table: string }>;
  relationshipCount: number;
  confidence: number;
  relationships: Array<ReturnType<typeof entityRelationshipEvidence>>;
  evidence: string[];
}> {
  const sourceKey = tableRefKey(mode, source.schema, source.table);
  const targetKey = tableRefKey(mode, target.schema, target.table);
  if (sourceKey === targetKey) {
    return [];
  }

  const adjacency = new Map<string, Array<{ node: { schema?: string; table: string }; relation: TableRelationship }>>();
  const addEdge = (
    from: { schema?: string; table: string },
    to: { schema?: string; table: string },
    relation: TableRelationship
  ) => {
    const key = tableRefKey(mode, from.schema, from.table);
    const next = { schema: to.schema, table: to.table };
    adjacency.set(key, [...(adjacency.get(key) ?? []), { node: next, relation }]);
  };

  for (const relation of relations) {
    const relationSource = { schema: relation.sourceSchema, table: relation.sourceTable };
    const relationTarget = { schema: relation.targetSchema, table: relation.targetTable };
    addEdge(relationSource, relationTarget, relation);
    addEdge(relationTarget, relationSource, relation);
  }

  const depthLimit = Math.max(1, Math.min(maxDepth, 3));
  const pathLimit = Math.max(1, maxPaths);
  const paths: Array<{
    tables: Array<{ schema?: string; table: string }>;
    relationshipCount: number;
    confidence: number;
    relationships: Array<ReturnType<typeof entityRelationshipEvidence>>;
    evidence: string[];
  }> = [];
  const emitted = new Set<string>();
  const queue: Array<{
    key: string;
    tables: Array<{ schema?: string; table: string }>;
    relations: TableRelationship[];
    visited: Set<string>;
  }> = [{
    key: sourceKey,
    tables: [{ schema: source.schema, table: source.table }],
    relations: [],
    visited: new Set([sourceKey])
  }];

  while (queue.length > 0 && paths.length < pathLimit) {
    const current = queue.shift()!;
    if (current.relations.length >= depthLimit) {
      continue;
    }
    for (const edge of adjacency.get(current.key) ?? []) {
      const nextKey = tableRefKey(mode, edge.node.schema, edge.node.table);
      if (current.visited.has(nextKey)) {
        continue;
      }
      const nextTables = [...current.tables, edge.node];
      const nextRelations = [...current.relations, edge.relation];
      if (nextKey === targetKey) {
        const pathKey = nextTables.map((item) => tableRefKey(mode, item.schema, item.table)).join(">");
        if (!emitted.has(pathKey)) {
          emitted.add(pathKey);
          paths.push({
            tables: nextTables,
            relationshipCount: nextRelations.length,
            confidence: Number(Math.min(...nextRelations.map((relation) => relation.confidence)).toFixed(3)),
            relationships: nextRelations.map(entityRelationshipEvidence),
            evidence: uniqueStrings(
              nextRelations.flatMap((relation) => relation.evidence.map((item) => item.detail))
            ).slice(0, 20)
          });
          if (paths.length >= pathLimit) {
            break;
          }
        }
        continue;
      }
      queue.push({
        key: nextKey,
        tables: nextTables,
        relations: nextRelations,
        visited: new Set([...current.visited, nextKey])
      });
    }
  }

  return paths;
}

function sameTableRef(
  mode: ObConfig["compatibility"],
  left: { schema?: string; table: string },
  right: { schema?: string; table: string }
): boolean {
  return tableRefKey(mode, left.schema, left.table) === tableRefKey(mode, right.schema, right.table);
}

function parseErInputTableRef(
  mode: ObConfig["compatibility"],
  value: string,
  fallbackSchema: string | undefined
): { schema?: string; table: string } {
  const trimmed = value.trim();
  const separator = trimmed.indexOf(".");
  const schema = separator > 0 ? trimmed.slice(0, separator).trim() : fallbackSchema;
  const table = separator > 0 ? trimmed.slice(separator + 1).trim() : trimmed;
  return {
    schema: mode === "oracle" && schema ? schema.toUpperCase() : schema,
    table: mode === "oracle" ? table.toUpperCase() : table
  };
}

function addErScopeTable(
  scope: Map<string, ErScopeTable>,
  mode: ObConfig["compatibility"],
  schema: string | undefined,
  table: string,
  limit: number,
  detail: { source: string; confidence: number; evidence: string[] }
): boolean {
  const normalizedSchema = mode === "oracle" && schema ? schema.toUpperCase() : schema;
  const normalizedTable = mode === "oracle" ? table.toUpperCase() : table;
  const key = tableRefKey(mode, normalizedSchema, normalizedTable);
  const existing = scope.get(key);
  if (!existing && scope.size >= limit) {
    return false;
  }
  if (!existing) {
    scope.set(key, {
      schema: normalizedSchema,
      table: normalizedTable,
      sources: [detail.source],
      confidence: detail.confidence,
      evidence: detail.evidence.slice(0, 20)
    });
    return true;
  }
  existing.sources = uniqueStrings([...existing.sources, detail.source]);
  existing.confidence = Math.max(existing.confidence, detail.confidence);
  existing.evidence = uniqueStrings([...existing.evidence, ...detail.evidence]).slice(0, 20);
  return true;
}

function erScopeTableOutput(table: ErScopeTable) {
  return {
    schema: table.schema,
    table: table.table,
    sources: table.sources,
    confidence: Number(table.confidence.toFixed(3)),
    evidence: table.evidence
  };
}

function isErRelationshipVisible(
  relation: TableRelationship,
  config: ObConfig,
  minConfidence: number,
  includeInferred: boolean
): boolean {
  if (!includeInferred && relation.relationType === "name_inference") {
    return false;
  }
  if (relation.confidence < minConfidence) {
    return false;
  }
  return isRelationshipAllowed(relation, config);
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
  constraints: unknown[],
  indexes: unknown[] = []
): ErEntity {
  const primaryKeys = new Set(primaryKeyColumns(mode, constraints));
  const indexMap = erIndexMap(mode, indexes);
  return {
    schema,
    table,
    columns: columns.map((row) => {
      const record = row as Record<string, unknown>;
      const name = stringRecordValue(record, "column_name", "COLUMN_NAME") ?? "column";
      const nullable = stringRecordValue(record, "is_nullable", "IS_NULLABLE", "nullable", "NULLABLE");
      const indexNames = indexMap.get(normalizeTableName(mode, name)) ?? [];
      return {
        name,
        type: columnTypeLabel(mode, record),
        primaryKey: primaryKeys.has(normalizeTableName(mode, name)),
        nullable: nullable ? !["NO", "N"].includes(nullable.toUpperCase()) : undefined,
        comment: stringRecordValue(record, "column_comment", "COLUMN_COMMENT", "comments", "COMMENTS"),
        indexed: indexNames.length > 0,
        indexNames
      };
    })
  };
}

function erIndexMap(mode: ObConfig["compatibility"], indexes: unknown[]): Map<string, string[]> {
  const output = new Map<string, string[]>();
  for (const row of indexes) {
    const record = row as Record<string, unknown>;
    const column = stringRecordValue(record, "column_name", "COLUMN_NAME");
    const indexName = stringRecordValue(record, "index_name", "INDEX_NAME");
    if (!column || !indexName) {
      continue;
    }
    const key = normalizeTableName(mode, column);
    output.set(key, uniqueStrings([...(output.get(key) ?? []), indexName]));
  }
  return output;
}

function groupErMetadataRows(mode: ObConfig["compatibility"], rows: unknown[]): Map<string, unknown[]> {
  const output = new Map<string, unknown[]>();
  for (const row of rows) {
    const record = row as Record<string, unknown>;
    const table = stringRecordValue(record, "table_name", "TABLE_NAME");
    if (!table) {
      continue;
    }
    const schema = stringRecordValue(record, "table_schema", "TABLE_SCHEMA", "owner", "OWNER", "table_owner", "TABLE_OWNER");
    const key = tableRefKey(mode, schema, table);
    output.set(key, [...(output.get(key) ?? []), row]);
  }
  return output;
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
    const key = erRelationshipKey(mode, relationship);
    if (!keys.has(key)) {
      keys.add(key);
      output.push(relationship);
    }
  }
  return output;
}

function erRelationshipKey(mode: ObConfig["compatibility"], relationship: TableRelationship): string {
  return [
    relationship.relationType,
    tableRefKey(mode, relationship.sourceSchema, relationship.sourceTable),
    relationship.sourceColumns.map((column) => normalizeTableName(mode, column)).join(","),
    tableRefKey(mode, relationship.targetSchema, relationship.targetTable),
    relationship.targetColumns.map((column) => normalizeTableName(mode, column)).join(",")
  ].join(":");
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

function enrichColumnProfile(
  profileResult: unknown,
  metadata: { name?: string; dataType?: string; nullable?: boolean; comment?: string; roles?: string[] } | undefined,
  config: ObConfig,
  schema: string | undefined,
  table: string
): Record<string, unknown> {
  const record = profileResult && typeof profileResult === "object" && !Array.isArray(profileResult)
    ? profileResult as Record<string, unknown>
    : {};
  const columnName = stringRecordValue(record, "column", "COLUMN") ?? metadata?.name ?? "";
  const roles = metadata?.roles ?? schemaColumnRoles(columnName, false);
  const typeCategory = profileColumnTypeCategory(metadata?.dataType);
  const sampledRows = numberRecordValue(record, "sampledRows", "sampled_rows") ?? 0;
  const distinct = record.distinct && typeof record.distinct === "object" && !Array.isArray(record.distinct)
    ? numberRecordValue(record.distinct as Record<string, unknown>, "value")
    : undefined;
  return {
    ...record,
    dataType: metadata?.dataType,
    nullable: metadata?.nullable,
    comment: metadata?.comment,
    roles,
    typeCategory,
    profileStrategy: profileColumnStrategy(typeCategory, metadata?.dataType, roles),
    enumCandidate: profileColumnEnumCandidate(columnName, typeCategory, distinct, sampledRows, roles),
    masked: shouldMaskColumnValue(columnName, config, schema, table)
  };
}

function profileColumnTypeCategory(dataType: string | undefined): string {
  const normalized = (dataType ?? "").toLowerCase();
  if (!normalized) {
    return "unknown";
  }
  if (/(date|time|timestamp|year)/.test(normalized)) {
    return "temporal";
  }
  if (/(tinyint\(1\)|boolean|bool|bit)/.test(normalized)) {
    return "boolean";
  }
  if (/(int|number|numeric|decimal|double|float|real)/.test(normalized)) {
    return "numeric";
  }
  if (/(enum|set)/.test(normalized)) {
    return "enum";
  }
  if (/(char|text|clob|string)/.test(normalized)) {
    return "string";
  }
  if (/(json|xml)/.test(normalized)) {
    return "semi_structured";
  }
  if (/(blob|binary|raw|long raw)/.test(normalized)) {
    return "binary";
  }
  return "other";
}

function profileColumnStrategy(typeCategory: string, dataType: string | undefined, roles: string[]) {
  const comparable = !["binary", "semi_structured"].includes(typeCategory) && isProfileComparableTypeLabel(dataType);
  return {
    nulls: true,
    distinct: comparable,
    topValues: comparable,
    sampleValues: comparable,
    minMax: comparable,
    numericRange: typeCategory === "numeric",
    timeRange: typeCategory === "temporal",
    textLength: typeCategory === "string",
    dimensionSignals: roles.includes("status") || typeCategory === "enum" || typeCategory === "boolean",
    notes: profileColumnStrategyNotes(typeCategory, comparable)
  };
}

function isProfileComparableTypeLabel(dataType: string | undefined): boolean {
  return !/(blob|clob|long|raw|binary|geometry|json|xml)/i.test(dataType ?? "");
}

function profileColumnStrategyNotes(typeCategory: string, comparable: boolean): string[] {
  if (!comparable) {
    return ["Value preview, distinct count, top values, and min/max can be skipped for large or non-comparable types."];
  }
  if (typeCategory === "temporal") {
    return ["Temporal fields include min/max as a sampled time range."];
  }
  if (typeCategory === "numeric") {
    return ["Numeric fields include sampled min/max as a value range."];
  }
  if (typeCategory === "string" || typeCategory === "enum") {
    return ["String-like fields include sampled top values and examples, with masking applied before output."];
  }
  return [];
}

function profileColumnEnumCandidate(
  columnName: string,
  typeCategory: string,
  distinct: number | undefined,
  sampledRows: number,
  roles: string[]
) {
  const evidence: string[] = [];
  let confidence = 0;
  if (typeCategory === "enum" || typeCategory === "boolean") {
    confidence += 0.45;
    evidence.push(`Type category is ${typeCategory}.`);
  }
  if (roles.includes("status")) {
    confidence += 0.35;
    evidence.push("Column name suggests a status, type, category, or dimension field.");
  }
  if (distinct != null && sampledRows > 0) {
    const ratioValue = distinct / sampledRows;
    if (distinct <= 20 && ratioValue <= 0.4) {
      confidence += 0.25;
      evidence.push(`Sample distinct count is ${distinct} of ${sampledRows} rows.`);
    }
  }
  if (/(status|state|type|category|kind|level|channel|region|flag)/i.test(columnName)) {
    confidence += 0.2;
    evidence.push("Column name matches common dimension naming.");
  }
  const cappedConfidence = Math.min(0.98, Number(confidence.toFixed(2)));
  return {
    likely: cappedConfidence >= 0.45,
    confidence: cappedConfidence,
    evidence
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

function valueDistributionWarnings(
  baseWarnings: string[],
  rowEstimate: number | undefined,
  rowLimit: number,
  topN: number,
  returnedValues: number,
  masked: boolean
): string[] {
  const warnings = new Set<string>([
    ...baseWarnings,
    "Value distribution uses a bounded sample; counts and ratios are not full-table exact values."
  ]);
  if (rowEstimate != null && rowEstimate > rowLimit) {
    warnings.add(`Table row estimate is ${rowEstimate}; distribution was limited to ${rowLimit} rows.`);
  }
  if (returnedValues >= topN) {
    warnings.add(`Only the top ${topN} values are returned.`);
  }
  if (masked) {
    warnings.add("Distribution values are masked for this column.");
  }
  return [...warnings];
}

function detectTimeColumnCandidates(
  rows: unknown[],
  config: ObConfig,
  schema: string | undefined,
  table: string,
  maxColumns: number
) {
  return rows
    .map((row, index) => {
      const metadata = profileColumnMetadata(row, config.compatibility);
      if (!metadata) {
        return undefined;
      }
      const signal = timeColumnSignal(metadata.name, metadata.dataType, metadata.comment);
      if (signal.confidence < 0.35) {
        return undefined;
      }
      return {
        column: metadata.name,
        kind: signal.kind,
        confidence: signal.confidence,
        evidence: signal.evidence,
        dataType: metadata.dataType,
        nullable: metadata.nullable,
        comment: metadata.comment,
        masked: shouldMaskColumnValue(metadata.name, config, schema, table),
        ordinalPosition: numberRecordValue(row as Record<string, unknown>, "ordinal_position", "ORDINAL_POSITION", "column_id", "COLUMN_ID") ?? index + 1
      };
    })
    .filter((item): item is NonNullable<typeof item> => Boolean(item))
    .sort((left, right) => right.confidence - left.confidence || left.ordinalPosition - right.ordinalPosition)
    .slice(0, Math.max(1, Math.min(maxColumns, 50)));
}

function timeColumnSignal(
  columnName: string,
  dataType: string | undefined,
  comment: string | undefined
): { kind: string; confidence: number; evidence: string[] } {
  const normalized = columnName.trim().toLowerCase();
  const commentText = (comment ?? "").trim().toLowerCase();
  const typeCategory = profileColumnTypeCategory(dataType);
  const evidence: string[] = [];
  let confidence = 0;
  let kind = "generic_time";

  if (typeCategory === "temporal") {
    confidence += 0.35;
    evidence.push(`Data type "${dataType}" is temporal.`);
  }
  if (/^(created_at|created_time|create_time|gmt_create|insert_time|created)$/.test(normalized)) {
    confidence += 0.5;
    kind = "created_time";
    evidence.push("Column name matches common create-time naming.");
  } else if (/^(updated_at|updated_time|update_time|modified_at|modified_time|gmt_modified|last_update|last_modified)$/.test(normalized)) {
    confidence += 0.5;
    kind = "updated_time";
    evidence.push("Column name matches common update-time naming.");
  } else if (/(event|occur|trade|order|pay|paid|biz|business|effective|start|end).*(time|date|day)$/.test(normalized) || /^(biz_date|business_date)$/.test(normalized)) {
    confidence += 0.45;
    kind = "business_time";
    evidence.push("Column name suggests a business event time.");
  } else if (/(^|_)(time|date|day|timestamp)$/.test(normalized) || /(time|date|timestamp)/.test(normalized)) {
    confidence += 0.2;
    evidence.push("Column name contains a time-related token.");
  }
  if (/(created|create time|updated|update time|modified|event time|business time|occurred|trade time|pay time)/.test(commentText)) {
    confidence += 0.15;
    evidence.push("Column comment contains time-related wording.");
  }
  return {
    kind,
    confidence: Math.min(0.98, Number(confidence.toFixed(2))),
    evidence
  };
}

function detectDimensionColumnCandidates(
  rows: unknown[],
  config: ObConfig,
  schema: string | undefined,
  table: string,
  maxColumns: number
) {
  return rows
    .map((row, index) => {
      const metadata = profileColumnMetadata(row, config.compatibility);
      if (!metadata) {
        return undefined;
      }
      const signal = dimensionColumnSignal(metadata.name, metadata.dataType, metadata.comment);
      if (signal.confidence < 0.35) {
        return undefined;
      }
      return {
        column: metadata.name,
        kind: signal.kind,
        confidence: signal.confidence,
        evidence: signal.evidence,
        dataType: metadata.dataType,
        typeCategory: profileColumnTypeCategory(metadata.dataType),
        nullable: metadata.nullable,
        comment: metadata.comment,
        masked: shouldMaskColumnValue(metadata.name, config, schema, table),
        ordinalPosition: numberRecordValue(row as Record<string, unknown>, "ordinal_position", "ORDINAL_POSITION", "column_id", "COLUMN_ID") ?? index + 1
      };
    })
    .filter((item): item is NonNullable<typeof item> => Boolean(item))
    .sort((left, right) => right.confidence - left.confidence || left.ordinalPosition - right.ordinalPosition)
    .slice(0, Math.max(1, Math.min(maxColumns, 50)));
}

function dimensionColumnSignal(
  columnName: string,
  dataType: string | undefined,
  comment: string | undefined
): { kind: string; confidence: number; evidence: string[] } {
  const normalized = columnName.trim().toLowerCase();
  const commentText = (comment ?? "").trim().toLowerCase();
  const typeCategory = profileColumnTypeCategory(dataType);
  const evidence: string[] = [];
  let confidence = 0;
  let kind = "generic_dimension";

  const namedKind = dimensionKindFromName(normalized);
  if (namedKind) {
    kind = namedKind;
    confidence += 0.55;
    evidence.push(`Column name matches common ${namedKind.replace(/_/g, " ")} naming.`);
  }
  if (["enum", "boolean"].includes(typeCategory)) {
    confidence += 0.3;
    evidence.push(`Type category is ${typeCategory}.`);
  } else if (typeCategory === "string" && /(char|varchar|text|string)/i.test(dataType ?? "")) {
    confidence += 0.15;
    evidence.push("String type can represent a categorical value.");
  } else if (typeCategory === "numeric" && /(tinyint|smallint|number\(1|int\(1)/i.test(dataType ?? "")) {
    confidence += 0.15;
    evidence.push("Small numeric type can represent a code or flag.");
  }
  if (/(status|state|type|category|channel|region|city|province|country|source|platform|flag|level|kind|gender)/.test(commentText)) {
    confidence += 0.15;
    evidence.push("Column comment contains dimension-related wording.");
  }
  return {
    kind,
    confidence: Math.min(0.98, Number(confidence.toFixed(2))),
    evidence
  };
}

function dimensionKindFromName(name: string): string | undefined {
  if (/(^|_)(status|state)(_|$)/.test(name)) {
    return "status";
  }
  if (/(^|_)(type|category|kind|level)(_|$)/.test(name)) {
    return "type";
  }
  if (/(^|_)(channel|source|platform|scene)(_|$)/.test(name)) {
    return "channel";
  }
  if (/(^|_)(region|city|province|country|area)(_|$)/.test(name)) {
    return "region";
  }
  if (/(^|_)(flag|enabled|disabled|deleted|active|valid)(_|$)/.test(name)) {
    return "flag";
  }
  if (/(^|_)(gender|grade|segment|bucket|group)(_|$)/.test(name)) {
    return "category";
  }
  return undefined;
}

function resolveRecentRowsTimeColumn(
  rows: unknown[],
  config: ObConfig,
  schema: string | undefined,
  table: string,
  requestedTimeColumn: string | undefined
) {
  if (requestedTimeColumn) {
    const column = getBuildColumn(config, buildSelectColumnInfos(config, schema, table, rows), requestedTimeColumn);
    const signal = timeColumnSignal(column.name, column.type, column.comment);
    return {
      column: column.name,
      source: "explicit",
      confidence: Math.max(signal.confidence, 0.5),
      kind: signal.kind,
      evidence: signal.evidence.length > 0 ? signal.evidence : ["Time column was supplied explicitly."],
      dataType: column.type,
      masked: column.masked
    };
  }
  const candidates = detectTimeColumnCandidates(rows, config, schema, table, 5);
  const best = candidates[0];
  if (!best || best.confidence < 0.5) {
    throw new Error("No reliable time column was detected. Pass timeColumn explicitly.");
  }
  return {
    column: best.column,
    source: "detected",
    confidence: best.confidence,
    kind: best.kind,
    evidence: best.evidence,
    dataType: best.dataType,
    masked: best.masked,
    alternatives: candidates.slice(1, 5).map((candidate) => ({
      column: candidate.column,
      kind: candidate.kind,
      confidence: candidate.confidence,
      evidence: candidate.evidence
    }))
  };
}

function recentRowsProjection(columns: string[] | undefined, timeColumn: string): string[] | undefined {
  if (!columns || columns.length === 0) {
    return undefined;
  }
  return uniqueStrings([timeColumn, ...columns]);
}

function recentRowsWarnings(baseWarnings: string[], timeColumn: { source: string; alternatives?: unknown[] }, truncated: boolean): string[] {
  const warnings = new Set(baseWarnings);
  if (timeColumn.source === "detected") {
    warnings.add("Time column was selected from metadata detection; pass timeColumn explicitly if this is not the business time field.");
  }
  if (Array.isArray(timeColumn.alternatives) && timeColumn.alternatives.length > 0) {
    warnings.add("Other time-like columns were found; review alternatives before using this query for business decisions.");
  }
  if (truncated) {
    warnings.add("Rows were truncated by the configured row or output limit.");
  }
  return [...warnings];
}

function selectDataQualityColumns(
  config: ObConfig,
  columns: Array<{ name: string; type?: string; nullable?: boolean; roles: string[]; masked: boolean }>,
  primaryKeys: string[],
  requestedColumns: string[] | undefined,
  maxColumns: number
) {
  if (requestedColumns && requestedColumns.length > 0) {
    const available = columns.map((column) => ({
      name: column.name,
      type: column.type,
      nullable: column.nullable,
      masked: column.masked
    }));
    return requestedColumns.map((column) => {
      const match = getBuildColumn(config, available, column);
      const full = columns.find((item) => normalizeTableName(config.compatibility, item.name) === normalizeTableName(config.compatibility, match.name));
      return full ?? { ...match, roles: [] };
    });
  }
  return selectTableProfileColumns(columns, primaryKeys, maxColumns);
}

function buildDataQualityChecks(
  profiles: Array<Record<string, unknown>>,
  metadataColumns: Array<{ name: string; type?: string; nullable?: boolean; roles: string[]; masked: boolean }>,
  primaryKeys: string[],
  nullRatioThreshold: number
) {
  const checks: Array<Record<string, unknown>> = [];
  const primaryKeySet = new Set(primaryKeys.map((column) => column.toLowerCase()));
  for (const profile of profiles) {
    const column = stringRecordValue(profile, "column", "COLUMN") ?? "";
    if (!column) {
      continue;
    }
    const metadata = metadataColumns.find((item) => item.name.toLowerCase() === column.toLowerCase());
    const sampledRows = numberRecordValue(profile, "sampledRows", "sampled_rows") ?? 0;
    const nulls = profile.nulls && typeof profile.nulls === "object" && !Array.isArray(profile.nulls)
      ? profile.nulls as Record<string, unknown>
      : {};
    const nullCount = numberRecordValue(nulls, "count") ?? 0;
    const nullRatio = numberRecordValue(nulls, "ratio") ?? 0;
    if (nullCount > 0 && nullRatio >= nullRatioThreshold) {
      checks.push({
        rule: "null_values",
        severity: nullRatio >= 0.5 ? "high" : "warn",
        column,
        evidence: [`${nullCount} of ${sampledRows} sampled rows are null.`],
        ratio: nullRatio,
        recommendation: "Confirm whether nulls are valid for this field before using it as a required filter or join key."
      });
    }
    const distinct = profile.distinct && typeof profile.distinct === "object" && !Array.isArray(profile.distinct)
      ? numberRecordValue(profile.distinct as Record<string, unknown>, "value")
      : undefined;
    if (primaryKeySet.has(column.toLowerCase()) && distinct != null && sampledRows > 0 && distinct < sampledRows - nullCount) {
      checks.push({
        rule: "duplicate_key_risk",
        severity: "high",
        column,
        evidence: [`Primary-key-like column has ${distinct} distinct values in ${sampledRows} sampled rows.`],
        recommendation: "Review key uniqueness with a scoped query before relying on this column as a unique identifier."
      });
    }
    if (metadata?.roles.includes("status") && distinct != null && sampledRows > 0 && distinct / sampledRows > 0.8) {
      checks.push({
        rule: "high_cardinality_dimension",
        severity: "warn",
        column,
        evidence: [`Dimension-like column has ${distinct} distinct values in ${sampledRows} sampled rows.`],
        recommendation: "Check whether this field is suitable for grouping, or use a different business dimension."
      });
    }
    if (metadata?.roles.includes("time") && nullRatio > 0.1) {
      checks.push({
        rule: "time_column_nulls",
        severity: "warn",
        column,
        evidence: [`Time-like column null ratio is ${nullRatio}.`],
        recommendation: "Pass an explicit timeColumn when querying recent rows if this field is incomplete."
      });
    }
  }
  return checks;
}

function summarizeDataQualityChecks(checks: Array<Record<string, unknown>>) {
  const high = checks.filter((check) => check.severity === "high").length;
  const warn = checks.filter((check) => check.severity === "warn").length;
  return {
    high,
    warn,
    total: checks.length,
    status: high > 0 ? "attention_required" : warn > 0 ? "review" : "no_sampled_issues"
  };
}

function selectTableProfileColumns(
  columns: Array<{ name: string; type?: string; nullable?: boolean; roles: string[]; masked: boolean }>,
  primaryKeys: string[],
  maxColumns: number
): Array<{ name: string; type?: string; nullable?: boolean; roles: string[]; masked: boolean }> {
  const cappedMax = Math.max(1, Math.min(maxColumns, 50));
  const primaryKeySet = new Set(primaryKeys.map((column) => column.toLowerCase()));
  return columns
    .map((column, index) => ({
      column,
      index,
      score: tableProfileColumnScore(column, primaryKeySet)
    }))
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .slice(0, cappedMax)
    .map((item) => item.column);
}

function tableProfileColumnScore(
  column: { name: string; type?: string; nullable?: boolean; roles: string[] },
  primaryKeySet: Set<string>
): number {
  let score = 0;
  if (primaryKeySet.has(column.name.toLowerCase()) || column.roles.includes("primary_key")) {
    score += 100;
  }
  if (column.roles.includes("time")) {
    score += 90;
  }
  if (column.roles.includes("status")) {
    score += 85;
  }
  if (column.nullable) {
    score += 55;
  }
  if (column.roles.includes("identifier")) {
    score += 35;
  }
  if (/(int|number|decimal|numeric|float|double|date|time|timestamp|char|text)/i.test(column.type ?? "")) {
    score += 20;
  }
  return score;
}

function tableProfileMaskedColumns(
  result: { schema?: string; table: string; columns: unknown[] },
  metadataColumns: Array<{ name: string; type?: string; nullable?: boolean; comment?: string; roles: string[] }>,
  config: ObConfig,
  schema: string | undefined,
  table: string
): Array<Record<string, unknown>> {
  const metadata = new Map(metadataColumns.map((column) => [normalizeTableName(config.compatibility, column.name), column]));
  const enriched = {
    ...result,
    columns: result.columns.map((profileResult) => {
      const record = profileResult && typeof profileResult === "object" && !Array.isArray(profileResult)
        ? profileResult as Record<string, unknown>
        : {};
      const columnName = stringRecordValue(record, "column", "COLUMN") ?? "";
      const column = metadata.get(normalizeTableName(config.compatibility, columnName));
      return enrichColumnProfile(
        record,
        column
          ? {
              name: column.name,
              dataType: column.type,
              nullable: column.nullable,
              comment: column.comment,
              roles: column.roles
            }
          : undefined,
        config,
        schema,
        table
      );
    })
  };
  const masked = maskColumnProfileResult(enriched, config, schema, table);
  return (masked.columns ?? [])
    .filter((column) => Boolean(column && typeof column === "object" && !Array.isArray(column)))
    .map((column) => column as Record<string, unknown>);
}

function tableProfileWarnings(
  metadataWarnings: string[],
  columnWarnings: string[],
  rowEstimate: number | undefined,
  rowLimit: number,
  visibleColumnCount: number,
  selectedColumnCount: number,
  includeColumnProfiles: boolean
): string[] {
  const warnings = new Set<string>([
    ...metadataWarnings,
    ...columnWarnings,
    "Table profile combines metadata with bounded column samples; row estimates and sampled values are not full-table exact values."
  ]);
  if (!includeColumnProfiles) {
    warnings.add("Column profiling was disabled, so null overview, time ranges, and value distributions are metadata-only.");
  } else {
    for (const warning of profileWarnings([], rowEstimate, rowLimit, selectedColumnCount, visibleColumnCount)) {
      warnings.add(warning);
    }
  }
  return [...warnings];
}

function tableProfileNullOverview(profiles: Array<Record<string, unknown>>) {
  return profiles
    .map((profile) => {
      const nulls = profile.nulls && typeof profile.nulls === "object" && !Array.isArray(profile.nulls)
        ? profile.nulls as Record<string, unknown>
        : {};
      return {
        column: stringRecordValue(profile, "column", "COLUMN") ?? "",
        nullable: Boolean(profile.nullable),
        masked: Boolean(profile.masked),
        sampledRows: numberRecordValue(profile, "sampledRows", "sampled_rows") ?? 0,
        nullCount: numberRecordValue(nulls, "count") ?? 0,
        nullRatio: numberRecordValue(nulls, "ratio") ?? 0,
        source: stringRecordValue(nulls, "source")
      };
    })
    .filter((item) => item.column)
    .sort((left, right) => right.nullRatio - left.nullRatio || right.nullCount - left.nullCount || left.column.localeCompare(right.column))
    .slice(0, 20);
}

function tableProfileTimeFields(timeFields: string[], profiles: Array<Record<string, unknown>>) {
  return timeFields.map((column) => {
    const profile = profileByColumn(profiles, column);
    const timeRange = profile?.timeRange && typeof profile.timeRange === "object" && !Array.isArray(profile.timeRange)
      ? profile.timeRange as Record<string, unknown>
      : undefined;
    return {
      column,
      confidence: 0.72,
      evidence: ["Column name or metadata role suggests a time field."],
      sampledRows: profile ? numberRecordValue(profile, "sampledRows", "sampled_rows") ?? 0 : undefined,
      min: timeRange?.min,
      max: timeRange?.max,
      masked: profile ? Boolean(profile.masked) : undefined
    };
  });
}

function tableProfileStatusFields(statusFields: string[], profiles: Array<Record<string, unknown>>) {
  return statusFields.map((column) => {
    const profile = profileByColumn(profiles, column);
    const distinct = profile?.distinct && typeof profile.distinct === "object" && !Array.isArray(profile.distinct)
      ? profile.distinct as Record<string, unknown>
      : undefined;
    return {
      column,
      confidence: 0.72,
      evidence: ["Column name or metadata role suggests a status or dimension field."],
      sampledRows: profile ? numberRecordValue(profile, "sampledRows", "sampled_rows") ?? 0 : undefined,
      distinct: distinct ? { value: numberRecordValue(distinct, "value"), exact: false } : undefined,
      topValues: Array.isArray(profile?.topValues) ? profile?.topValues : undefined,
      masked: profile ? Boolean(profile.masked) : undefined
    };
  });
}

function profileByColumn(profiles: Array<Record<string, unknown>>, column: string): Record<string, unknown> | undefined {
  return profiles.find((profile) => {
    const name = stringRecordValue(profile, "column", "COLUMN");
    return Boolean(name && name.toLowerCase() === column.toLowerCase());
  });
}

function tableProfileIndexSummary(indexes: unknown[]) {
  const grouped = new Map<string, { name: string; unique?: boolean; type?: string; columns: string[] }>();
  for (const row of indexes) {
    const record = row && typeof row === "object" && !Array.isArray(row) ? row as Record<string, unknown> : {};
    const name = stringRecordValue(record, "index_name", "INDEX_NAME");
    const column = stringRecordValue(record, "column_name", "COLUMN_NAME");
    if (!name) {
      continue;
    }
    const nonUnique = record.non_unique ?? record.NON_UNIQUE;
    const uniqueness = stringRecordValue(record, "uniqueness", "UNIQUENESS");
    const existing = grouped.get(name) ?? {
      name,
      unique: uniqueness ? uniqueness.toUpperCase() === "UNIQUE" : nonUnique == null ? undefined : String(nonUnique) === "0",
      type: stringRecordValue(record, "index_type", "INDEX_TYPE"),
      columns: []
    };
    if (column) {
      existing.columns = uniqueStrings([...existing.columns, column]);
    }
    grouped.set(name, existing);
  }
  return [...grouped.values()].slice(0, 20);
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
        selected.config.enforceReadOnlyTransaction,
        selected.config.maxResultBytes
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

interface SnippetMetadataValidation {
  tables: Array<{
    schema?: string;
    table: string;
    visible: boolean;
    visibleColumnCount: number;
    checkedColumns: string[];
    unknownColumns: string[];
    error?: string;
  }>;
  qualifiedColumnRefs: Array<{
    qualifier: string;
    column: string;
    schema?: string;
    table?: string;
    ok?: boolean;
  }>;
  bareColumnRefs: Array<{
    column: string;
    schema?: string;
    table?: string;
    ok?: boolean;
    ambiguous?: boolean;
  }>;
  warnings: string[];
}

async function validateSnippetMetadata(
  selected: ReturnType<typeof selectRuntimeProfile>,
  sql: string,
  tableRefs: Array<{ schema?: string; table: string }>,
  fallbackSchema: string | undefined
): Promise<SnippetMetadataValidation> {
  const warnings = [
    "Metadata validation is conservative; complex expressions, nested queries, and dynamic SQL may require manual review."
  ];
  const tables: SnippetMetadataValidation["tables"] = [];
  const tableMetadata = new Map<string, { schema?: string; table: string; columns: Set<string> }>();

  for (const ref of uniqueTableRefs(tableRefs).slice(0, 10)) {
    const metadataRef = normalizedSnippetTableRef(selected.config, ref.schema ?? fallbackSchema, ref.table);
    try {
      assertTableAccess(metadataRef.schema, metadataRef.table, policyContext(selected.config));
      const rows = filterColumnMetadata(
        await withQuerySlot(selected, () =>
          describeTable(
            selected.pool,
            selected.config.compatibility,
            metadataRef.table,
            metadataRef.schema,
            selected.config.queryTimeoutMs
          )
        ),
        selected.config.policy
      );
      const columnNames = rows
        .map((row) => profileColumnMetadata(row, selected.config.compatibility)?.name)
        .filter((value): value is string => Boolean(value));
      tableMetadata.set(tableRefKey(selected.config.compatibility, metadataRef.schema, metadataRef.table), {
        schema: metadataRef.schema,
        table: metadataRef.table,
        columns: new Set(columnNames.map((column) => normalizeTableName(selected.config.compatibility, column)))
      });
      tables.push({
        schema: metadataRef.schema,
        table: metadataRef.table,
        visible: rows.length > 0,
        visibleColumnCount: rows.length,
        checkedColumns: [],
        unknownColumns: []
      });
    } catch (error) {
      tables.push({
        schema: metadataRef.schema,
        table: metadataRef.table,
        visible: false,
        visibleColumnCount: 0,
        checkedColumns: [],
        unknownColumns: [],
        error: (error as Error).message
      });
    }
  }

  if (tables.length === 0) {
    warnings.push("No table reference was parsed from the SQL snippet.");
  }

  const aliasMap = snippetAliasMap(sql, selected.config.compatibility, tableMetadata);
  const qualifiedColumnRefs = snippetQualifiedColumnRefs(sql, selected.config.compatibility, aliasMap, tableMetadata, tables);
  const bareColumnRefs = snippetBareColumnRefs(sql, selected.config.compatibility, tableMetadata, tables);

  return { tables, qualifiedColumnRefs, bareColumnRefs, warnings };
}

function normalizedSnippetTableRef(config: ObConfig, schema: string | undefined, table: string): { schema?: string; table: string } {
  const ref = metadataTableRef(config, schema, table);
  if (config.compatibility !== "oracle") {
    return ref;
  }
  return {
    schema: ref.schema?.toUpperCase(),
    table: ref.table.toUpperCase()
  };
}

function snippetMetadataFindings(metadata: SnippetMetadataValidation): LintFinding[] {
  const findings: LintFinding[] = [];
  for (const table of metadata.tables) {
    if (!table.visible) {
      findings.push({
        rule: "metadata_table_unavailable",
        severity: "high",
        message: `Table ${formatSchemaTable(table.schema, table.table)} is not visible or is blocked by policy.`,
        evidence: [table.error ?? formatSchemaTable(table.schema, table.table)]
      });
    }
    if (table.unknownColumns.length > 0) {
      findings.push({
        rule: "metadata_unknown_column",
        severity: "high",
        message: `SQL references columns that are not visible on ${formatSchemaTable(table.schema, table.table)}.`,
        evidence: table.unknownColumns.slice(0, 20)
      });
    }
  }

  for (const column of metadata.bareColumnRefs.filter((ref) => ref.ambiguous)) {
    findings.push({
      rule: "metadata_ambiguous_column",
      severity: "warn",
      message: `Column ${column.column} is visible on multiple referenced tables; qualify it before execution.`,
      evidence: [column.column]
    });
  }
  return findings;
}

function snippetMetadataRecommendations(findings: LintFinding[]): string[] {
  const output: string[] = [];
  if (findings.some((finding) => finding.rule === "metadata_table_unavailable")) {
    output.push("Search visible schemas and tables before executing the snippet.");
  }
  if (findings.some((finding) => finding.rule === "metadata_unknown_column")) {
    output.push("Use ob_get_table_context or ob_find_columns to confirm column names before execution.");
  }
  if (findings.some((finding) => finding.rule === "metadata_ambiguous_column")) {
    output.push("Qualify ambiguous columns with a table name or alias.");
  }
  return output;
}

function formatSchemaTable(schema: string | undefined, table: string): string {
  return schema ? `${schema}.${table}` : table;
}

type ProjectQuerySource = {
  type: "inline";
  warnings: string[];
} | {
  type: "file";
  file: string;
  line: number;
  requestedLine?: number;
  snippetSource: SqlScanSnippet["source"];
  dynamic: boolean;
  snippetCount: number;
  warnings: string[];
};

const PROJECT_QUERY_ALLOWED_EXTENSIONS = new Set([".sql", ".xml", ".ts", ".js", ".java"]);
const PROJECT_QUERY_MAX_FILE_BYTES = 512 * 1024;

function resolveProjectQuerySource(
  sql: string | undefined,
  filePath: string | undefined,
  line: number | undefined
): { sql: string; source: ProjectQuerySource } {
  const inlineSql = sql?.trim();
  const projectFile = filePath?.trim();
  if (Boolean(inlineSql) === Boolean(projectFile)) {
    throw new Error("Pass exactly one of sql or filePath.");
  }
  if (inlineSql) {
    return { sql: inlineSql, source: { type: "inline", warnings: [] } };
  }

  const root = process.cwd();
  const absPath = resolve(root, projectFile!);
  const relPath = relative(root, absPath);
  if (!relPath || relPath.startsWith("..") || relPath.startsWith("/")) {
    throw new Error("filePath must point to a file under the current project directory.");
  }
  const ext = extname(absPath).toLowerCase();
  if (!PROJECT_QUERY_ALLOWED_EXTENSIONS.has(ext)) {
    throw new Error("filePath must use one of .sql, .xml, .ts, .js, or .java.");
  }
  const stat = statSync(absPath);
  if (!stat.isFile()) {
    throw new Error("filePath must point to a regular file.");
  }
  if (stat.size > PROJECT_QUERY_MAX_FILE_BYTES) {
    throw new Error(`filePath exceeds the ${PROJECT_QUERY_MAX_FILE_BYTES} byte scan limit.`);
  }
  const content = readFileSync(absPath, "utf8");
  const snippets = extractSqlSnippetsFromContent(ext, content);
  if (snippets.length === 0) {
    throw new Error("No SQL snippet was found in filePath.");
  }
  const snippet = selectProjectSqlSnippet(snippets, line);
  return {
    sql: snippet.sql,
    source: {
      type: "file",
      file: relPath,
      line: snippet.line,
      requestedLine: line,
      snippetSource: snippet.source,
      dynamic: snippet.dynamic,
      snippetCount: snippets.length,
      warnings: snippet.dynamic
        ? ["SQL contains dynamic placeholders or template interpolation; validate the rendered SQL before execution."]
        : []
    }
  };
}

function selectProjectSqlSnippet(snippets: SqlScanSnippet[], line: number | undefined): SqlScanSnippet {
  if (!line) {
    return snippets[0];
  }
  return snippets.reduce((best, item) => {
    const bestDistance = Math.abs(best.line - line);
    const itemDistance = Math.abs(item.line - line);
    return itemDistance < bestDistance ? item : best;
  }, snippets[0]);
}

function projectQueryStructure(
  sql: string,
  mode: ObConfig["compatibility"],
  tableRefs: Array<{ schema?: string; table: string }>
) {
  const shape = queryShape(sql, mode);
  return {
    statementType: firstProjectSqlKeyword(sql) ?? "unknown",
    tables: uniqueTableRefs(tableRefs).map((ref) => ({
      schema: ref.schema,
      table: ref.table
    })),
    selectedColumns: projectSelectedColumns(sql),
    filtersPreview: projectClausePreview(sql, "where"),
    orderByPreview: projectClausePreview(sql, "order\\s+by"),
    shape
  };
}

function projectQueryRecommendations(source: ProjectQuerySource): string[] {
  if (source.type === "file" && source.dynamic) {
    return ["Validate the rendered SQL after dynamic mapper or template conditions are applied."];
  }
  return [];
}

function renderQueryDocumentMarkdown(document: {
  generatedAt: string;
  mode: ObConfig["compatibility"];
  source: ProjectQuerySource;
  sql: string;
  paramCount: number;
  executed: boolean;
  explainRun: boolean;
  allowed: boolean;
  severity: "low" | "medium" | "high";
  structure: ReturnType<typeof projectQueryStructure>;
  metadata: SnippetMetadataValidation;
  findings: LintFinding[];
  recommendations: string[];
  warnings: string[];
}, title?: string): string {
  const lines = [
    `# ${title ?? "Query Documentation"}`,
    "",
    `Generated at: ${document.generatedAt}`,
    "",
    `Mode: ${document.mode}`,
    `Executed: ${document.executed ? "yes" : "no"}`,
    `Allowed by current checks: ${document.allowed ? "yes" : "no"}`,
    `Severity: ${document.severity}`,
    `EXPLAIN run: ${document.explainRun ? "yes" : "no"}`,
    "",
    "## SQL",
    "",
    "```sql",
    document.sql,
    "```",
    ""
  ];
  lines.push("## Structure", "");
  lines.push(`Statement type: ${document.structure.statementType}`);
  lines.push(`Parameters: ${document.paramCount}`);
  lines.push(`Has WHERE: ${document.structure.shape.hasWhere ? "yes" : "no"}`);
  lines.push(`Has ORDER BY: ${document.structure.shape.hasOrderBy ? "yes" : "no"}`);
  lines.push(`Has row limit: ${document.structure.shape.hasRowLimit ? "yes" : "no"}`);
  lines.push(`Has JOIN: ${document.structure.shape.hasJoin ? "yes" : "no"}`, "");
  if (document.structure.filtersPreview) {
    lines.push(`Filter preview: ${document.structure.filtersPreview}`, "");
  }
  if (document.structure.orderByPreview) {
    lines.push(`Order preview: ${document.structure.orderByPreview}`, "");
  }
  lines.push("## Tables", "");
  if (document.structure.tables.length === 0) {
    lines.push("No table reference was parsed from the SQL.", "");
  } else {
    lines.push("| Schema | Table | Visible | Columns Checked | Unknown Columns |");
    lines.push("| --- | --- | --- | --- | --- |");
    for (const table of document.metadata.tables) {
      lines.push(`| ${markdownCell(table.schema ?? "")} | ${markdownCell(table.table)} | ${table.visible ? "YES" : "NO"} | ${markdownCell(table.checkedColumns.join(", "))} | ${markdownCell(table.unknownColumns.join(", "))} |`);
    }
    lines.push("");
  }
  lines.push("## Field Sources", "");
  const fieldRefs = [
    ...document.metadata.qualifiedColumnRefs.map((ref) => ({ kind: "qualified", ...ref })),
    ...document.metadata.bareColumnRefs.map((ref) => ({ kind: "bare", ...ref }))
  ];
  if (fieldRefs.length === 0) {
    lines.push("No column reference was parsed from the SQL.", "");
  } else {
    lines.push("| Kind | Column | Schema | Table | Status |");
    lines.push("| --- | --- | --- | --- | --- |");
    for (const ref of fieldRefs.slice(0, 80)) {
      const status = "ambiguous" in ref && ref.ambiguous ? "ambiguous" : ref.ok === false ? "unknown" : ref.ok === true ? "ok" : "";
      lines.push(`| ${ref.kind} | ${markdownCell(ref.column)} | ${markdownCell(ref.schema ?? "")} | ${markdownCell(ref.table ?? "")} | ${status} |`);
    }
    lines.push("");
  }
  if (document.findings.length > 0) {
    lines.push("## Findings", "");
    lines.push("| Severity | Rule | Message | Evidence |");
    lines.push("| --- | --- | --- | --- |");
    for (const finding of document.findings) {
      lines.push(`| ${finding.severity} | ${markdownCell(finding.rule)} | ${markdownCell(finding.message)} | ${markdownCell(finding.evidence.join("; "))} |`);
    }
    lines.push("");
  }
  if (document.recommendations.length > 0) {
    lines.push("## Recommendations", "");
    for (const recommendation of document.recommendations) {
      lines.push(`- ${recommendation}`);
    }
    lines.push("");
  }
  lines.push("## Notes", "");
  for (const warning of document.warnings) {
    lines.push(`- ${warning}`);
  }
  return lines.join("\n");
}

function mapperContextTableRefs(
  config: ObConfig,
  schema: string | undefined,
  table: string | undefined,
  sqlRefs: Array<{ schema?: string; table: string }>,
  maxTables: number
): Array<{ schema?: string; table: string }> {
  const refs: Array<{ schema?: string; table: string }> = [];
  if (table?.trim()) {
    refs.push(normalizedSnippetTableRef(config, schema, table));
  }
  for (const ref of sqlRefs) {
    refs.push(normalizedSnippetTableRef(config, ref.schema ?? schema, ref.table));
  }
  return uniqueTableRefs(refs).slice(0, maxTables);
}

async function buildMapperContextTable(
  selected: ReturnType<typeof selectRuntimeProfile>,
  schema: string | undefined,
  table: string,
  maxColumns: number
) {
  const metadataRef = normalizedSnippetTableRef(selected.config, schema, table);
  assertTableAccess(metadataRef.schema, metadataRef.table, policyContext(selected.config));
  const columns = filterColumnMetadata(
    await withQuerySlot(selected, () =>
      describeTable(
        selected.pool,
        selected.config.compatibility,
        metadataRef.table,
        metadataRef.schema,
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
        metadataRef.table,
        metadataRef.schema,
        selected.config.queryTimeoutMs
      )
    ),
    selected.config.policy
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
  const compactColumns = compactSchemaColumns(columns, constraints, selected.config, metadataRef.schema, metadataRef.table);
  const columnLimit = Math.max(1, Math.min(maxColumns, 200));
  return {
    schema: metadataRef.schema,
    table: metadataRef.table,
    visibleColumnCount: compactColumns.length,
    columnsTruncated: compactColumns.length > columnLimit,
    columns: compactColumns.slice(0, columnLimit),
    primaryKeys: schemaMapPrimaryKeyColumns(constraints),
    uniqueKeys: uniqueKeyGroups(constraints),
    indexes: mapperIndexSummary(indexes),
    constraints: mapperConstraintSummary(constraints),
    notes: mapperContextNotes(compactColumns)
  };
}

function mapperIndexSummary(rows: unknown[]): Array<{ name: string; unique?: boolean; columns: string[] }> {
  const grouped = new Map<string, { unique?: boolean; columns: string[] }>();
  for (const row of rows) {
    const record = row as Record<string, unknown>;
    const name = stringRecordValue(record, "index_name", "INDEX_NAME");
    const column = stringRecordValue(record, "column_name", "COLUMN_NAME");
    if (!name || !column) {
      continue;
    }
    const uniqueness = stringRecordValue(record, "uniqueness", "UNIQUENESS");
    const nonUnique = numberRecordValue(record, "non_unique", "NON_UNIQUE");
    const existing = grouped.get(name) ?? { unique: undefined, columns: [] };
    existing.unique = uniqueness ? uniqueness.toUpperCase() === "UNIQUE" : nonUnique != null ? nonUnique === 0 : existing.unique;
    existing.columns = uniqueStrings([...existing.columns, column]);
    grouped.set(name, existing);
  }
  return [...grouped.entries()].map(([name, value]) => ({
    name,
    unique: value.unique,
    columns: value.columns
  })).slice(0, 50);
}

function mapperConstraintSummary(rows: unknown[]): Array<{ name: string; type?: string; columns: string[] }> {
  const grouped = new Map<string, { type?: string; columns: string[] }>();
  for (const row of rows) {
    const record = row as Record<string, unknown>;
    const name = stringRecordValue(record, "constraint_name", "CONSTRAINT_NAME");
    const column = stringRecordValue(record, "column_name", "COLUMN_NAME");
    if (!name) {
      continue;
    }
    const existing = grouped.get(name) ?? { type: stringRecordValue(record, "constraint_type", "CONSTRAINT_TYPE"), columns: [] };
    if (column) {
      existing.columns = uniqueStrings([...existing.columns, column]);
    }
    grouped.set(name, existing);
  }
  return [...grouped.entries()].map(([name, value]) => ({
    name,
    type: value.type,
    columns: value.columns
  })).slice(0, 50);
}

function mapperContextNotes(columns: Array<{ name: string; roles: string[]; masked: boolean }>): string[] {
  const notes: string[] = [];
  const maskedColumns = columns.filter((column) => column.masked).map((column) => column.name);
  const timeColumns = columns.filter((column) => column.roles.includes("time")).map((column) => column.name);
  const statusColumns = columns.filter((column) => column.roles.includes("status")).map((column) => column.name);
  if (maskedColumns.length > 0) {
    notes.push(`Masked columns: ${maskedColumns.slice(0, 10).join(", ")}.`);
  }
  if (timeColumns.length > 0) {
    notes.push(`Likely time columns: ${timeColumns.slice(0, 10).join(", ")}.`);
  }
  if (statusColumns.length > 0) {
    notes.push(`Likely dimension/status columns: ${statusColumns.slice(0, 10).join(", ")}.`);
  }
  return notes;
}

function renderMapperContextMarkdown(payload: {
  mode: ObConfig["compatibility"];
  source?: ProjectQuerySource;
  sql?: string;
  tableCount: number;
  tables: Array<Awaited<ReturnType<typeof buildMapperContextTable>>>;
  warnings: string[];
}): string {
  const lines = ["# OceanBase Mapper Context", "", `Mode: ${payload.mode}`, `Tables: ${payload.tableCount}`, ""];
  if (payload.source?.type === "file") {
    lines.push(`Source: ${payload.source.file}:${payload.source.line}`, "");
  }
  if (payload.sql) {
    lines.push("```sql", payload.sql, "```", "");
  }
  for (const table of payload.tables) {
    const title = `${table.schema ? `${table.schema}.` : ""}${table.table}`;
    lines.push(`## ${title}`, "");
    if (table.primaryKeys.length > 0) {
      lines.push(`Primary key: ${table.primaryKeys.join(", ")}`, "");
    }
    if (table.indexes.length > 0) {
      lines.push(`Indexes: ${table.indexes.map((index) => `${index.name}(${index.columns.join(", ")})`).join("; ")}`, "");
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
      lines.push("", `More columns exist for ${title}; output was truncated by maxColumns.`);
    }
    for (const note of table.notes) {
      lines.push("", `Note: ${note}`);
    }
    lines.push("");
  }
  if (payload.warnings.length > 0) {
    lines.push("## Warnings", "");
    lines.push(...payload.warnings.map((warning) => `- ${warning}`));
    lines.push("");
  }
  return lines.join("\n");
}

async function findUnknownTableCandidates(
  selected: ReturnType<typeof selectRuntimeProfile>,
  schema: string | undefined,
  table: string,
  limit: number
): Promise<Array<{ schema?: string; table: string; score: number; evidence: string[] }>> {
  const effectiveSchema = metadataSchema(selected.config, schema);
  if (effectiveSchema && !isSchemaAllowed(effectiveSchema, selected.config.policy)) {
    return [];
  }
  const rows = filterTables(
    await withQuerySlot(selected, () =>
      listTables(
        selected.pool,
        selected.config.compatibility,
        effectiveSchema,
        500,
        selected.config.queryTimeoutMs
      )
    ),
    selected.config.policy
  );
  return rows
    .map((row) => tableRefFromMetadata(row, effectiveSchema))
    .filter((ref): ref is { schema?: string; table: string } => Boolean(ref))
    .map((ref) => ({
      schema: ref.schema,
      table: ref.table,
      score: similarityScore(table, ref.table),
      evidence: similarityEvidence(table, ref.table)
    }))
    .filter((candidate) => candidate.score >= 0.25)
    .sort((left, right) => right.score - left.score || left.table.localeCompare(right.table))
    .slice(0, limit);
}

async function findUnknownColumnCandidates(
  selected: ReturnType<typeof selectRuntimeProfile>,
  schema: string | undefined,
  table: string,
  column: string,
  limit: number
): Promise<Array<{ schema?: string; table: string; column: string; type?: string; score: number; evidence: string[] }>> {
  try {
    const metadataRef = normalizedSnippetTableRef(selected.config, schema, table);
    assertTableAccess(metadataRef.schema, metadataRef.table, policyContext(selected.config));
    const rows = filterColumnMetadata(
      await withQuerySlot(selected, () =>
        describeTable(
          selected.pool,
          selected.config.compatibility,
          metadataRef.table,
          metadataRef.schema,
          selected.config.queryTimeoutMs
        )
      ),
      selected.config.policy
    );
    return rows
      .map((row) => profileColumnMetadata(row, selected.config.compatibility))
      .filter((item): item is { name: string; dataType?: string; nullable?: boolean; comment?: string } => Boolean(item))
      .map((item) => ({
        schema: metadataRef.schema,
        table: metadataRef.table,
        column: item.name,
        type: item.dataType,
        score: similarityScore(column, item.name),
        evidence: similarityEvidence(column, item.name)
      }))
      .filter((candidate) => candidate.score >= 0.25)
      .sort((left, right) => right.score - left.score || left.column.localeCompare(right.column))
      .slice(0, limit);
  } catch {
    return [];
  }
}

function similarityScore(left: string, right: string): number {
  const a = normalizeSimilarityText(left);
  const b = normalizeSimilarityText(right);
  if (!a || !b) {
    return 0;
  }
  if (a === b) {
    return 1;
  }
  if (a.includes(b) || b.includes(a)) {
    return 0.86;
  }
  const distance = levenshteinDistance(a, b);
  const ratio = 1 - distance / Math.max(a.length, b.length);
  const prefix = commonPrefixLength(a, b) / Math.max(a.length, b.length);
  return Number(Math.max(ratio, prefix * 0.9).toFixed(3));
}

function similarityEvidence(left: string, right: string): string[] {
  const a = normalizeSimilarityText(left);
  const b = normalizeSimilarityText(right);
  const evidence = [];
  if (a === b) {
    evidence.push("normalized_exact_match");
  }
  if (a.includes(b) || b.includes(a)) {
    evidence.push("substring_match");
  }
  if (commonPrefixLength(a, b) >= 3) {
    evidence.push("common_prefix");
  }
  if (levenshteinDistance(a, b) <= 2) {
    evidence.push("edit_distance_le_2");
  }
  return evidence.length > 0 ? evidence : ["name_similarity"];
}

function normalizeSimilarityText(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]/g, "");
}

function commonPrefixLength(left: string, right: string): number {
  let index = 0;
  while (index < left.length && index < right.length && left[index] === right[index]) {
    index += 1;
  }
  return index;
}

function levenshteinDistance(left: string, right: string): number {
  const previous = Array.from({ length: right.length + 1 }, (_value, index) => index);
  for (let i = 0; i < left.length; i += 1) {
    const current = [i + 1];
    for (let j = 0; j < right.length; j += 1) {
      const cost = left[i] === right[j] ? 0 : 1;
      current[j + 1] = Math.min(
        current[j] + 1,
        previous[j + 1] + 1,
        previous[j] + cost
      );
    }
    previous.splice(0, previous.length, ...current);
  }
  return previous[right.length] ?? 0;
}

function firstProjectSqlKeyword(sql: string): string | undefined {
  return /^[\s(]*(select|with|explain|show|describe|insert|update|delete|merge|create|alter|drop|truncate)\b/i.exec(sql)?.[1]?.toLowerCase();
}

function projectSelectedColumns(sql: string): string[] {
  const match = /\bselect\s+([\s\S]*?)\s+\bfrom\b/i.exec(sql);
  return match?.[1] ? simpleSelectColumns(match[1]).slice(0, 50) : [];
}

function projectClausePreview(sql: string, clause: "where" | "order\\s+by"): string | undefined {
  const end = clause === "where"
    ? String.raw`\b(group\s+by|order\s+by|having|limit|offset|fetch|union)\b`
    : String.raw`\b(limit|offset|fetch|union)\b`;
  const pattern = new RegExp(String.raw`\b${clause}\b\s+([\s\S]*?)(?=${end}|$)`, "i");
  const value = pattern.exec(sql)?.[1]?.trim();
  if (!value) {
    return undefined;
  }
  const compact = value.replace(/\s+/g, " ");
  return compact.length > 300 ? `${compact.slice(0, 300)}...` : compact;
}

function snippetAliasMap(
  sql: string,
  mode: ObConfig["compatibility"],
  tableMetadata: Map<string, { schema?: string; table: string; columns: Set<string> }>
): Map<string, { schema?: string; table: string; columns: Set<string> }> {
  const aliases = new Map<string, { schema?: string; table: string; columns: Set<string> }>();
  const byTableName = new Map<string, { schema?: string; table: string; columns: Set<string> }>();
  for (const metadata of tableMetadata.values()) {
    const tableKey = normalizeTableName(mode, metadata.table);
    byTableName.set(tableKey, metadata);
    aliases.set(tableKey, metadata);
    if (metadata.schema) {
      aliases.set(`${normalizeTableName(mode, metadata.schema)}.${tableKey}`, metadata);
    }
  }

  for (const tableRef of snippetTableAliases(sql)) {
    const metadata = byTableName.get(normalizeTableName(mode, tableRef.table));
    if (!metadata) {
      continue;
    }
    if (tableRef.alias) {
      aliases.set(normalizeTableName(mode, tableRef.alias), metadata);
    }
    aliases.set(normalizeTableName(mode, tableRef.table), metadata);
  }
  return aliases;
}

const SQL_SNIPPET_ALIAS_STOPWORDS = new Set([
  "where",
  "on",
  "join",
  "inner",
  "left",
  "right",
  "full",
  "cross",
  "group",
  "order",
  "having",
  "limit",
  "offset",
  "fetch",
  "union",
  "connect",
  "start",
  "with"
]);

function snippetTableAliases(sql: string): Array<{ table: string; alias?: string }> {
  const refs: Array<{ table: string; alias?: string }> = [];
  const identifier = String.raw`(?:"[^"]+"|` + "`[^`]+`" + String.raw`|[A-Za-z_][\w$#]*)`;
  const pattern = new RegExp(
    String.raw`\b(?:from|join)\s+((?:${identifier})(?:\s*\.\s*(?:${identifier}))?)(?:\s+(?:as\s+)?(${identifier}))?`,
    "gi"
  );
  for (const match of sql.matchAll(pattern)) {
    const rawRef = match[1];
    if (!rawRef) {
      continue;
    }
    const parts = rawRef.split(".").map((part) => unquoteIdentifier(part));
    const table = parts[parts.length - 1];
    const alias = match[2] ? unquoteIdentifier(match[2]) : undefined;
    const normalizedAlias = alias?.toLowerCase();
    refs.push({
      table,
      alias: alias && normalizedAlias && !SQL_SNIPPET_ALIAS_STOPWORDS.has(normalizedAlias) ? alias : undefined
    });
  }
  return refs;
}

function snippetQualifiedColumnRefs(
  sql: string,
  mode: ObConfig["compatibility"],
  aliasMap: Map<string, { schema?: string; table: string; columns: Set<string> }>,
  tableMetadata: Map<string, { schema?: string; table: string; columns: Set<string> }>,
  tables: SnippetMetadataValidation["tables"]
): SnippetMetadataValidation["qualifiedColumnRefs"] {
  const refs: SnippetMetadataValidation["qualifiedColumnRefs"] = [];
  const seen = new Set<string>();
  const identifier = String.raw`(?:"[^"]+"|` + "`[^`]+`" + String.raw`|[A-Za-z_][\w$#]*)`;
  const pattern = new RegExp(String.raw`(${identifier})\s*\.\s*(${identifier})`, "g");
  for (const match of sql.matchAll(pattern)) {
    const qualifier = unquoteIdentifier(match[1] ?? "");
    const column = unquoteIdentifier(match[2] ?? "");
    if (!qualifier || !column || isSchemaTableReference(mode, qualifier, column, tableMetadata)) {
      continue;
    }
    const key = `${normalizeTableName(mode, qualifier)}.${normalizeTableName(mode, column)}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    const metadata = aliasMap.get(normalizeTableName(mode, qualifier));
    const columnKey = normalizeTableName(mode, column);
    const ok = metadata ? metadata.columns.has(columnKey) : undefined;
    if (metadata) {
      markSnippetColumn(tables, mode, metadata.schema, metadata.table, column, ok === true);
    }
    refs.push({
      qualifier,
      column,
      schema: metadata?.schema,
      table: metadata?.table,
      ok
    });
  }
  return refs.slice(0, 50);
}

function snippetBareColumnRefs(
  sql: string,
  mode: ObConfig["compatibility"],
  tableMetadata: Map<string, { schema?: string; table: string; columns: Set<string> }>,
  tables: SnippetMetadataValidation["tables"]
): SnippetMetadataValidation["bareColumnRefs"] {
  const match = /\bselect\s+([\s\S]*?)\s+\bfrom\b/i.exec(sql);
  if (!match?.[1] || hasSelectStar(sql)) {
    return [];
  }
  const refs: SnippetMetadataValidation["bareColumnRefs"] = [];
  const seen = new Set<string>();
  for (const column of simpleSelectColumns(match[1])) {
    const columnKey = normalizeTableName(mode, column);
    if (seen.has(columnKey)) {
      continue;
    }
    seen.add(columnKey);
    const matches = [...tableMetadata.values()].filter((metadata) => metadata.columns.has(columnKey));
    if (matches.length === 1) {
      const metadata = matches[0];
      markSnippetColumn(tables, mode, metadata.schema, metadata.table, column, true);
      refs.push({ column, schema: metadata.schema, table: metadata.table, ok: true });
    } else if (matches.length > 1) {
      for (const metadata of matches) {
        markSnippetColumn(tables, mode, metadata.schema, metadata.table, column, true);
      }
      refs.push({ column, ok: true, ambiguous: true });
    } else if (tableMetadata.size === 1) {
      const metadata = [...tableMetadata.values()][0];
      markSnippetColumn(tables, mode, metadata.schema, metadata.table, column, false);
      refs.push({ column, schema: metadata.schema, table: metadata.table, ok: false });
    } else {
      refs.push({ column, ok: false });
    }
  }
  return refs.slice(0, 50);
}

function isSchemaTableReference(
  mode: ObConfig["compatibility"],
  qualifier: string,
  column: string,
  tableMetadata: Map<string, { schema?: string; table: string; columns: Set<string> }>
): boolean {
  for (const metadata of tableMetadata.values()) {
    if (
      metadata.schema &&
      normalizeTableName(mode, metadata.schema) === normalizeTableName(mode, qualifier) &&
      normalizeTableName(mode, metadata.table) === normalizeTableName(mode, column)
    ) {
      return true;
    }
  }
  return false;
}

function simpleSelectColumns(selectList: string): string[] {
  return splitTopLevelSqlComma(selectList)
    .map((item) => item.trim())
    .filter((item) => item && !/[()*/+-]/.test(item))
    .map((item) => item.replace(/\s+as\s+.+$/i, "").replace(/\s+[\w$#"`]+$/i, "").trim())
    .map((item) => item.split(".").pop() ?? "")
    .map(unquoteIdentifier)
    .filter((item) => /^[A-Za-z_][\w$#]*$/.test(item));
}

function splitTopLevelSqlComma(value: string): string[] {
  const segments: string[] = [];
  let current = "";
  let depth = 0;
  let quote: string | undefined;
  for (let i = 0; i < value.length; i += 1) {
    const char = value[i];
    if (quote) {
      current += char;
      if (char === quote) {
        quote = undefined;
      } else if (char === "\\") {
        i += 1;
        current += value[i] ?? "";
      }
      continue;
    }
    if (char === "'" || char === '"' || char === "`") {
      quote = char;
      current += char;
      continue;
    }
    if (char === "(") {
      depth += 1;
      current += char;
      continue;
    }
    if (char === ")") {
      depth = Math.max(0, depth - 1);
      current += char;
      continue;
    }
    if (char === "," && depth === 0) {
      segments.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  if (current.trim()) {
    segments.push(current);
  }
  return segments;
}

function markSnippetColumn(
  tables: SnippetMetadataValidation["tables"],
  mode: ObConfig["compatibility"],
  schema: string | undefined,
  table: string,
  column: string,
  ok: boolean
): void {
  const target = tables.find((item) => tableRefKey(mode, item.schema, item.table) === tableRefKey(mode, schema, table));
  if (!target) {
    return;
  }
  target.checkedColumns = uniqueStrings([...target.checkedColumns, column]).slice(0, 50);
  if (!ok) {
    target.unknownColumns = uniqueStrings([...target.unknownColumns, column]).slice(0, 50);
  }
}

function unquoteIdentifier(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith("`") && trimmed.endsWith("`")) ||
    (trimmed.startsWith('"') && trimmed.endsWith('"'))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

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

function safeSampleColumnNames(rows: unknown[]): string[] {
  const names: string[] = [];
  for (const row of rows) {
    if (!row || typeof row !== "object" || Array.isArray(row)) {
      continue;
    }
    const record = row as Record<string, unknown>;
    const name = stringRecordValue(record, "column_name", "COLUMN_NAME");
    if (!name) {
      continue;
    }
    const type = [
      stringRecordValue(record, "column_type", "COLUMN_TYPE"),
      stringRecordValue(record, "data_type", "DATA_TYPE")
    ].filter(Boolean).join(" ");
    if (isLargeSampleColumnType(type)) {
      continue;
    }
    names.push(name);
  }
  return [...new Set(names)];
}

function isLargeSampleColumnType(type: string): boolean {
  return /\b(blob|clob|json|xml|raw|long|binary|varbinary|geometry|geography|image|lob)\b|text\b/i.test(type);
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

function toolWallTimeoutMs(name: string, runtime: GatewayRuntime, context: McpRequestContext): number {
  const config = gatewayLimitConfig(runtime, context);
  const budget = getToolCapability(name)?.budget.timeoutMs;
  const configuredTimeout = budget === "profile.erTotalTimeoutMs"
    ? config.erTotalTimeoutMs
    : config.queryTimeoutMs;
  return Math.max(1, configuredTimeout + TOOL_TIMEOUT_GRACE_MS);
}

async function withToolTimeout<T>(operation: Promise<T>, timeoutMs: number, name: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`Tool "${name}" exceeded configured timeout budget ${timeoutMs}ms.`));
    }, timeoutMs);
  });
  try {
    return await Promise.race([operation, timeout]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

function safeTool<Args>(
  name: string,
  handler: (args: Args) => Promise<ReturnType<typeof toResult>>,
  context: McpRequestContext,
  runtime: GatewayRuntime
) {
  return async (args: Args) => {
    const started = Date.now();
    const finish = metrics.startToolCall();
    let timeoutMs: number | undefined;
    recordCrashBreadcrumb("tool_start", {
      tool: name,
      toolGroup: getToolCapability(name)?.group,
      operationType: getToolCapability(name)?.operationType,
      transport: context.transport ?? "stdio",
      requestId: context.requestId,
      clientId: context.clientId,
      principal: context.principal?.name,
      ...auditArgs(args)
    });
    try {
      assertToolAllowed(name, context.principal);
      timeoutMs = toolWallTimeoutMs(name, runtime, context);
      const result = await withToolTimeout(Promise.resolve().then(() => handler(args)), timeoutMs, name);
      const durationMs = Date.now() - started;
      const responseBytes = resultTextBytes(result);
      recordCrashBreadcrumb("tool_finish", {
        ok: true,
        tool: name,
        durationMs,
        responseBytes,
        timeoutMs
      });
      logAudit("tool_call", {
        ok: true,
        tool: name,
        toolGroup: getToolCapability(name)?.group,
        operationType: getToolCapability(name)?.operationType,
        transport: context.transport ?? "stdio",
        requestId: context.requestId,
        clientId: context.clientId,
        principal: context.principal?.name,
        durationMs,
        timeoutMs,
        responseBytes,
        ...auditArgs(args)
      });
      logSlowOperation("slow_tool_call", {
        ok: true,
        tool: name,
        toolGroup: getToolCapability(name)?.group,
        operationType: getToolCapability(name)?.operationType,
        transport: context.transport ?? "stdio",
        requestId: context.requestId,
        clientId: context.clientId,
        principal: context.principal?.name,
        durationMs,
        timeoutMs,
        responseBytes,
        ...auditArgs(args)
      });
      return result;
    } catch (error) {
      const durationMs = Date.now() - started;
      const errorResult = toErrorResult(error, args);
      const responseBytes = resultTextBytes(errorResult);
      metrics.recordToolBlocked();
      metrics.recordToolError();
      recordCrashBreadcrumb("tool_finish", {
        ok: false,
        tool: name,
        durationMs,
        responseBytes,
        timeoutMs,
        error: (error as Error).message
      });
      logAudit("tool_call", {
        ok: false,
        tool: name,
        toolGroup: getToolCapability(name)?.group,
        operationType: getToolCapability(name)?.operationType,
        transport: context.transport ?? "stdio",
        requestId: context.requestId,
        clientId: context.clientId,
        principal: context.principal?.name,
        durationMs,
        timeoutMs,
        responseBytes,
        blockedReason: (error as Error).message,
        ...auditArgs(args)
      });
      logSlowOperation("slow_tool_call", {
        ok: false,
        tool: name,
        toolGroup: getToolCapability(name)?.group,
        operationType: getToolCapability(name)?.operationType,
        transport: context.transport ?? "stdio",
        requestId: context.requestId,
        clientId: context.clientId,
        principal: context.principal?.name,
        durationMs,
        timeoutMs,
        responseBytes,
        blockedReason: (error as Error).message,
        ...auditArgs(args)
      });
      logError(name, error);
      return errorResult;
    } finally {
      finish();
    }
  };
}

function resultTextBytes(result: ReturnType<typeof toResult>): number {
  return result.content.reduce((sum, item) => sum + Buffer.byteLength(item.text ?? "", "utf8"), 0);
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
  if (/exceeded configured timeout budget|timeout|timed out|query execution was interrupted/.test(lower)) {
    hints.push("The request exceeded the configured timeout. Narrow the schema, table scope, row limit, or ER export window before retrying.");
    hints.push("For large ER diagrams, use ob_plan_er_export and export smaller chunks instead of requesting a full inline diagram.");
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
