import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import {
  SERVER_VERSION
} from "../capabilities.js";
import type { HttpConfig, ObConfig } from "../config.js";
import {
  describeTable,
  estimateErExportPlanStats,
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
  type TableRef,
  type TableRelationship
} from "../db.js";
import { buildErDiagram, renderErDot, renderErHtml, renderErMarkdown, renderErPlantUml, type ErDiagram, type ErEntity } from "../er.js";
import type { ErGraph, ErGraphDiagnostic, ErGraphStatus } from "../er-graph.js";
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
  maskOutput,
  pagedQueryWarnings,
  shouldMaskColumnValue
} from "../query/output.js";
import { queryPreviewWarnings } from "../query/preview.js";
import { ensureQuerySessionStore } from "../query/sessions.js";
import { selectRuntimeProfile, withQuerySlot, type GatewayRuntime } from "../runtime.js";
import {
  gatewayLimitConfig,
  publicProfiles,
  selectAuthorizedProfile,
  visibleDefaultProfile
} from "./access.js";
import {
  visibleGlossaryTargets
} from "./business-glossary.js";
import type { McpRequestContext } from "./context.js";
import { metadataSchema } from "./metadata-scope.js";
import { policyContext } from "./policy-context.js";
import {
  buildSelectColumnInfos,
  buildStructuredSelect
} from "./query-builder.js";
import { registerMcpResources } from "./resources.js";
import {
  entityDiagramOutputFormatSchema,
  erDocumentFormatSchema,
  erExportStrategySchema,
  erHtmlFormatSchema,
  erRelationshipModeSchema,
  profileInput,
  queryScenarioSchema
} from "./schemas.js";
import { toGatewayLimitedResult, toLimitedResult, toResult } from "./tool-runtime.js";
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
import { registerRecentRowsTools } from "./tools/recent-rows.js";
import { registerSearchCatalogTools } from "./tools/search-catalog.js";
import { registerDataQualityTools } from "./tools/data-quality.js";
import { registerProfileColumnTools } from "./tools/profile-columns.js";
import { registerValueDistributionTools } from "./tools/profile-value-distribution.js";
import {
  columnTypeLabel,
  normalizeTableName,
  numberRecordValue,
  selectTableProfileColumns,
  stringRecordValue,
  tableProfileIndexSummary,
  tableProfileMaskedColumns,
  tableProfileNullOverview,
  tableProfileStatusFields,
  tableProfileTimeFields,
  tableProfileWarnings
} from "./tools/profile-utils.js";
import { registerSqlConversionTools } from "./tools/sql-conversion.js";
import { registerSqlErrorTools } from "./tools/sql-errors.js";
import { registerSqlLintTools } from "./tools/sql-lint.js";
import { registerSqlMapperContextTools } from "./tools/sql-mapper-context.js";
import { registerSqlProjectQueryTools } from "./tools/sql-project-query.js";
import { registerSqlQueryDocTools } from "./tools/sql-query-doc.js";
import { registerSqlValidationTools } from "./tools/sql-validation.js";
import { registerSqlUnknownColumnTools } from "./tools/sql-unknown-columns.js";
import {
  findPrepareQueryCandidates,
  prepareQuerySearchTerms,
  registerSqlPrepareTools
} from "./tools/sql-prepare.js";
import { registerSqlRewriteTools } from "./tools/sql-rewrite.js";
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
  schemaMapPrimaryKeyColumns,
  uniqueKeyGroups
} from "./tools/schema-map.js";
import { registerTableMetadataTools } from "./tools/table-metadata.js";
import { createToolRegistrar } from "./tool-registry.js";

export { effectiveRowLimit, shouldMaskColumnValue } from "../query/output.js";
export { isToolAllowed } from "./access.js";
export type { McpRequestContext } from "./context.js";

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
  registerRecentRowsTools(registerTool, runtime, context);
  registerSearchCatalogTools(registerTool, runtime, context);
  registerSqlConversionTools(registerTool, runtime, context);
  registerSqlErrorTools(registerTool, runtime, context);
  registerSqlLintTools(registerTool, runtime, context);
  registerSqlRewriteTools(registerTool, runtime, context);
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

  registerProfileColumnTools(registerTool, runtime, context);

  registerValueDistributionTools(registerTool, runtime, context);

  registerDataQualityTools(registerTool, runtime, context);

  registerSqlValidationTools(registerTool, runtime, context);
  registerSqlProjectQueryTools(registerTool, runtime, context);
  registerSqlQueryDocTools(registerTool, runtime, context);
  registerSqlMapperContextTools(registerTool, runtime, context);
  registerSqlUnknownColumnTools(registerTool, runtime, context);

  registerSqlPrepareTools(registerTool, runtime, context);

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
