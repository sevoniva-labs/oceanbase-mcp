import { readFileSync, statSync } from "node:fs";
import { extname, relative, resolve } from "node:path";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import {
  SERVER_VERSION
} from "../capabilities.js";
import type { HttpConfig, ObConfig } from "../config.js";
import {
  describeTable,
  estimateErExportPlanStats,
  findColumns,
  findRelatedTables,
  getTableDdlMetadata,
  getTableStats,
  loadErMetadataBatch,
  listErForeignKeyRelationshipsBatch,
  listConstraints,
  listIndexes,
  listPartitions,
  listTables,
  profileColumns,
  renderStructuredTableDdl,
  runReadOnlyQuery,
  sampleRows,
  searchCatalog,
  type TableRef,
  type TableRelationship,
  type SqlParam
} from "../db.js";
import { buildErDiagram, renderErDot, renderErHtml, renderErMarkdown, renderErPlantUml, type ErDiagram, type ErEntity } from "../er.js";
import type { ErGraph, ErGraphDiagnostic, ErGraphStatus } from "../er-graph.js";
import { assertJsonByteLimit, type QueryOutput } from "../format.js";
import { metrics } from "../metrics.js";
import { analyzeQueryPlan } from "../plan-analysis.js";
import {
  assertOutputAllowed,
  assertSqlPolicy,
  assertTableAccess,
  explainSqlPolicy,
  filterColumnMetadata,
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
  shouldMaskColumnValue
} from "../query/output.js";
import { hasSqlRowLimit, queryPreviewWarnings, queryShape, sensitiveSqlTerms } from "../query/preview.js";
import { ensureQuerySessionStore } from "../query/sessions.js";
import { generateQueryTemplates, type QueryTemplateScenario } from "../query-generation.js";
import { selectRuntimeProfile, withQuerySlot, type GatewayRuntime } from "../runtime.js";
import { assertReadOnlySql, assertSqlInputLimits, buildExplainSql, buildPagedReadOnlySql } from "../sql.js";
import { extractSqlSnippetsFromContent, type SqlScanSnippet } from "../sql-scan.js";
import {
  gatewayLimitConfig,
  publicProfiles,
  selectAuthorizedProfile,
  visibleDefaultProfile
} from "./access.js";
import {
  normalizeGlossaryText,
  searchBusinessGlossary,
  visibleGlossaryTargets
} from "./business-glossary.js";
import type { McpRequestContext } from "./context.js";
import {
  mapperConstraintSummary,
  mapperIndexSummary
} from "./metadata-summary.js";
import { metadataSchema, metadataTableRef } from "./metadata-scope.js";
import { policyContext } from "./policy-context.js";
import {
  buildSelectColumnInfos,
  buildStructuredSelect,
  getBuildColumn,
  selectBuildColumns,
  sqlQuoteIdentifier
} from "./query-builder.js";
import { registerMcpResources } from "./resources.js";
import {
  catalogSearchResult,
  columnSearchRows,
  dedupeColumnSearchResults,
  dedupeSearchResults,
  glossarySearchResults,
  relatedTableEvidence,
  tableCandidatesFromSearchResults,
  type BusinessTableCandidate,
  type SearchEverythingResult
} from "./search-results.js";
import { explainGeneratedQuery, runExplainCheck } from "./sql-policy-explain.js";
import {
  compatibilityModeSchema,
  entityDiagramOutputFormatSchema,
  erDocumentFormatSchema,
  erExportStrategySchema,
  erHtmlFormatSchema,
  erRelationshipModeSchema,
  profileInput,
  queryScenarioSchema,
  sqlParamSchema,
  tableDocumentFormatSchema
} from "./schemas.js";
import { errorHints, toGatewayLimitedResult, toLimitedResult, toResult } from "./tool-runtime.js";
import {
  buildErExportCommand,
  defaultErHtmlTitle,
  erDiagnosticsFromWarnings,
  fitErDiagramResponseForLimit,
  formatErColumnLimitWarnings,
  SCHEMA_INLINE_ER_TABLE_RENDER_LIMIT,
  shouldSkipSchemaInlineErHtmlRender
} from "./tools/er-response.js";
import {
  planErExportChunks,
  planErExportRelationships,
  suggestErExportStrategy,
  tableLabelForCommand,
  type ErExportStrategy
} from "./tools/er-export-plan.js";
import {
  DESCRIBE_TABLE_DEFAULT_COLUMN_LIMIT,
  describeTablePayload,
  registerCatalogTools
} from "./tools/catalog.js";
import { registerColumnDetectionTools } from "./tools/column-detection.js";
import { registerQueryResultTools } from "./tools/query-results.js";
import { registerSystemTools } from "./tools/system.js";
import { registerDocumentationTools } from "./tools/documentation.js";
import { registerMetadataChangeTools } from "./tools/metadata-change.js";
import { registerMetadataCompareTools } from "./tools/metadata-compare.js";
import { registerObjectMetadataTools } from "./tools/object-metadata.js";
import { registerQueryBuildTools } from "./tools/query-build.js";
import { registerQueryExecutionTools } from "./tools/query-execution.js";
import { registerQueryPlanTools } from "./tools/query-plan.js";
import { registerQuerySessionTools } from "./tools/query-sessions.js";
import { registerQueryTemplateTools } from "./tools/query-templates.js";
import { registerSearchCatalogTools } from "./tools/search-catalog.js";
import { registerSqlUsageTools } from "./tools/sql-usages.js";
import { registerTableContextTools } from "./tools/table-context.js";
import {
  buildSchemaMapTableSummary,
  cachedDescribeTable,
  cachedListConstraints,
  cachedRelatedTables,
  cachedSchemaMapTables,
  compactSchemaColumns,
  filterSchemaMapTables,
  groupSchemaMapTables,
  importantSchemaMapFields,
  isRelationshipAllowed,
  registerSchemaMapTools,
  schemaColumnRoles,
  schemaMapPrimaryKeyColumns,
  uniqueKeyGroups
} from "./tools/schema-map.js";
import { registerTableMetadataTools } from "./tools/table-metadata.js";
import { createToolRegistrar } from "./tool-registry.js";

export { effectiveRowLimit, shouldMaskColumnValue } from "../query/output.js";
export { isToolAllowed } from "./access.js";
export type { McpRequestContext } from "./context.js";

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
  const registerTool = createToolRegistrar(server, runtime, context);
  registerMcpResources(server, runtime, context);
  registerSystemTools(registerTool, runtime, context, httpConfig);
  registerQueryExecutionTools(registerTool, runtime, context);
  registerQuerySessionTools(registerTool, runtime, context, querySessions);

  registerQueryResultTools(registerTool, runtime, context, querySessions);
  registerCatalogTools(registerTool, runtime, context);
  registerSchemaMapTools(registerTool, runtime, context);

  registerMetadataChangeTools(registerTool, runtime, context);
  registerMetadataCompareTools(registerTool, runtime, context);

  registerQueryPlanTools(registerTool, runtime, context);
  registerQueryBuildTools(registerTool, runtime, context);
  registerQueryTemplateTools(registerTool, runtime, context);
  registerSearchCatalogTools(registerTool, runtime, context);
  registerSqlUsageTools(registerTool, runtime, context);

  registerObjectMetadataTools(registerTool, runtime, context);
  registerTableMetadataTools(registerTool, runtime, context);
  registerTableContextTools(registerTool, runtime, context);
  registerColumnDetectionTools(registerTool, runtime, context);

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

  registerDocumentationTools(registerTool, runtime, context);

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
      const broadSchemaScope = !table && (!tables || tables.length === 0) && !businessTerm;
      const configuredMaxTables = Math.max(1, selected.config.erMaxTables);
      const requestedTableLimit = Math.min(maxTables ?? configuredMaxTables, configuredMaxTables, 500);
      if (broadSchemaScope && requestedTableLimit > SCHEMA_INLINE_ER_TABLE_RENDER_LIMIT) {
        const plan = await buildErExportPlanResult(selected, {
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
          format
        });
        if (plan.tableCount > SCHEMA_INLINE_ER_TABLE_RENDER_LIMIT) {
          return toLimitedResult(
            {
              mode: plan.mode,
              schema: plan.schema,
              rootTable: plan.rootTable,
              businessTerm: plan.businessTerm,
              tableCount: plan.tableCount,
              relationshipCount: plan.relationshipCount,
              contentType: "text/html",
              format,
              inline: false,
              htmlOmitted: true,
              renderSkipped: true,
              inlineLimitBytes: selected.config.erInlineHtmlMaxBytes,
              exportCommand: plan.singleFileCommand,
              suggestedStrategy: plan.suggestedStrategy,
              chunkCount: plan.chunkCount,
              recommendedNextTools: plan.recommendedNextTools,
              stats: plan.stats,
              warnings: uniqueStrings([
                ...plan.warnings,
                `Schema-level ER HTML rendering was skipped because tableCount=${plan.tableCount} exceeds ${SCHEMA_INLINE_ER_TABLE_RENDER_LIMIT}. Use ob_plan_er_export and CLI cluster export for large diagrams.`
              ])
            },
            selected.config
          );
        }
      }
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

  return server;
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
    truncatedTables: number;
    truncatedColumns: number;
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
              maxColumnsPerTable: selected.config.erMaxColumnsPerTable,
              maxIndexRowsPerTable: selected.config.erMaxColumnsPerTable * 4,
              maxConstraintRowsPerTable: selected.config.erMaxColumnsPerTable * 4,
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
  let truncatedColumns = 0;
  const truncatedColumnTables: string[] = [];
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
          maxColumnsPerTable: selected.config.erMaxColumnsPerTable,
          maxIndexRowsPerTable: selected.config.erMaxColumnsPerTable * 4,
          maxConstraintRowsPerTable: selected.config.erMaxColumnsPerTable * 4,
          timeoutMs: erTimeoutMs
        })
      );
      queryCount += batch.queryCount;
      warnings.push(...batch.warnings);
      if (batch.truncated) {
        truncated = true;
        truncatedColumnTables.push(...batch.truncatedColumnTables);
        truncatedColumns += batch.truncatedColumns;
      }
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
      truncatedColumns += columns.length - visibleColumns.length;
      truncatedColumnTables.push(ref.schema ? `${ref.schema}.${ref.table}` : ref.table);
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
    ...formatErColumnLimitWarnings(truncatedColumnTables, selected.config.erMaxColumnsPerTable, truncatedColumns),
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
      truncatedTables: truncatedColumnTables.length,
      truncatedColumns,
      skippedStages,
      warnings: responseWarnings
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
