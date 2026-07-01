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
const oracleObjectTypeSchema = z.enum(["view", "sequence", "synonym", "procedure", "function", "package", "package_body"]);
const queryScenarioSchema = z.enum(["by_primary_key", "pagination", "time_range", "aggregation", "join"]);
const profileInput = {
  profile: z.string().optional()
};
const SENSITIVE_SAMPLE_PATTERN =
  /(password|passwd|pwd|secret|token|api[_-]?key|private[_-]?key|credential|session|cookie|email|phone|mobile|id[_-]?card|ssn)/i;

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
      const relationshipResult = await withQuerySlot(selected, () =>
        findRelatedTables(selected.pool, selected.config.compatibility, table, effectiveSchema, 1, 20, selected.config.queryTimeoutMs)
      );
      const relationships = relationshipResult.relations.filter((relation) =>
        isRelationshipAllowed(relation, selected.config) &&
        relation.sourceColumns.every((column) => !isDeniedColumn(column, selected.config.policy)) &&
        relation.targetColumns.every((column) => !isDeniedColumn(column, selected.config.policy))
      );
      const generated = generateQueryTemplates({
        mode: selected.config.compatibility,
        schema: effectiveSchema,
        table,
        columns,
        constraints,
        relationships,
        scenarios: scenarios as QueryTemplateScenario[] | undefined,
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
