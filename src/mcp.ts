import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { AuthPrincipal, GatewayConfig, HttpConfig, ObConfig } from "./config.js";
import { publicConfig } from "./config.js";
import {
  describeTable,
  findRelatedTables,
  getObjectMetadata,
  getTableDdlMetadata,
  getTableStats,
  listConstraints,
  listIndexes,
  listObjects,
  listPartitions,
  listSchemas,
  listTables,
  ping,
  renderStructuredTableDdl,
  runReadOnlyQuery,
  sampleRows,
  searchCatalog,
  verifyReadOnlyPermissions,
  type TableRelationship,
  type SqlParam
} from "./db.js";
import { diagnoseGateway } from "./diagnostics.js";
import { buildErDiagram, type ErEntity } from "./er.js";
import { logAudit, logError, serializeError } from "./errors.js";
import { assertJsonByteLimit, jsonText, type QueryOutput } from "./format.js";
import { metrics } from "./metrics.js";
import { analyzeQueryPlan } from "./plan-analysis.js";
import { buildPerformanceReport } from "./performance-report.js";
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
import { assertReadOnlySql, assertSqlInputLimits, buildExplainSql, prepareReadOnlySql } from "./sql.js";

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
    version: "0.5.0"
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
      assertJsonByteLimit(output, selected.config.maxResultBytes);
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
      return toResult(output);
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
      const rows = await withQuerySlot(selected, () =>
        searchCatalog(
          selected.pool,
          selected.config.compatibility,
          query,
          schema,
          effectiveRowLimit(limit, selected.config),
          selected.config.queryTimeoutMs
        )
      );
      return toLimitedResult(filterColumnMetadata(rows, selected.config.policy), selected.config);
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

function toErrorResult(error: unknown) {
  return {
    isError: true,
    content: [
      {
        type: "text" as const,
        text: jsonText({
          ok: false,
          error: serializeError(error, { includeSqlMessage: false })
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
      return toErrorResult(error);
    } finally {
      finish();
    }
  };
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
