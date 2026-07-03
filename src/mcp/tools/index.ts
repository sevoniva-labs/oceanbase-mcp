import type { HttpConfig } from "../../config.js";
import type { QuerySessionState } from "../../query/sessions.js";
import type { GatewayRuntime } from "../../runtime.js";
import type { McpRequestContext } from "../context.js";
import type { ToolRegistrar } from "../tool-registry.js";
import { registerCatalogTools } from "./catalog.js";
import { registerColumnDetectionTools } from "./column-detection.js";
import { registerDataQualityTools } from "./data-quality.js";
import { registerDocumentationTools } from "./documentation.js";
import { buildErDiagramResult } from "./er-diagram-builder.js";
import { registerErDiagramTools } from "./er-diagram-tool.js";
import { registerErDocumentTools } from "./er-document.js";
import { registerErEntityDiagramTools } from "./er-entity-diagram.js";
import { buildErExportPlanResult } from "./er-export-plan-builder.js";
import { registerErExportPlanTools } from "./er-export-plan-tool.js";
import { registerErExplainRelationshipTools } from "./er-explain-relationship.js";
import { registerErHtmlTools } from "./er-html-tool.js";
import { registerMetadataChangeTools } from "./metadata-change.js";
import { registerMetadataCompareTools } from "./metadata-compare.js";
import { registerObjectMetadataTools } from "./object-metadata.js";
import { registerProfileColumnTools } from "./profile-columns.js";
import { registerProfileTableTools } from "./profile-table.js";
import { registerValueDistributionTools } from "./profile-value-distribution.js";
import { registerQueryTools } from "./query-tools.js";
import { registerSchemaMapTools } from "./schema-map.js";
import { registerSearchCatalogTools } from "./search-catalog.js";
import { registerSqlConversionTools } from "./sql-conversion.js";
import { registerSqlErrorTools } from "./sql-errors.js";
import { registerSqlLintTools } from "./sql-lint.js";
import { registerSqlMapperContextTools } from "./sql-mapper-context.js";
import { registerSqlPrepareTools } from "./sql-prepare.js";
import { registerSqlProjectQueryTools } from "./sql-project-query.js";
import { registerSqlQueryDocTools } from "./sql-query-doc.js";
import { registerSqlRewriteTools } from "./sql-rewrite.js";
import { registerSqlUsageTools } from "./sql-usages.js";
import { registerSqlValidationTools } from "./sql-validation.js";
import { registerSqlUnknownColumnTools } from "./sql-unknown-columns.js";
import { registerSystemTools } from "./system.js";
import { registerTableContextTools } from "./table-context.js";
import { registerTableMetadataTools } from "./table-metadata.js";

export function registerMcpTools(
  registerTool: ToolRegistrar,
  runtime: GatewayRuntime,
  context: McpRequestContext,
  querySessions: Map<string, QuerySessionState>,
  httpConfig?: HttpConfig
): void {
  registerSystemTools(registerTool, runtime, context, httpConfig);
  registerQueryTools(registerTool, runtime, context, querySessions);

  registerCatalogTools(registerTool, runtime, context);
  registerSchemaMapTools(registerTool, runtime, context);
  registerSearchCatalogTools(registerTool, runtime, context);
  registerTableMetadataTools(registerTool, runtime, context);
  registerTableContextTools(registerTool, runtime, context);
  registerObjectMetadataTools(registerTool, runtime, context);
  registerColumnDetectionTools(registerTool, runtime, context);

  registerMetadataChangeTools(registerTool, runtime, context);
  registerMetadataCompareTools(registerTool, runtime, context);

  registerSqlConversionTools(registerTool, runtime, context);
  registerSqlErrorTools(registerTool, runtime, context);
  registerSqlLintTools(registerTool, runtime, context);
  registerSqlRewriteTools(registerTool, runtime, context);
  registerSqlUsageTools(registerTool, runtime, context);
  registerSqlValidationTools(registerTool, runtime, context);
  registerSqlProjectQueryTools(registerTool, runtime, context);
  registerSqlQueryDocTools(registerTool, runtime, context);
  registerSqlMapperContextTools(registerTool, runtime, context);
  registerSqlUnknownColumnTools(registerTool, runtime, context);
  registerSqlPrepareTools(registerTool, runtime, context);

  registerProfileTableTools(registerTool, runtime, context);
  registerProfileColumnTools(registerTool, runtime, context);
  registerValueDistributionTools(registerTool, runtime, context);
  registerDataQualityTools(registerTool, runtime, context);

  registerDocumentationTools(registerTool, runtime, context);
  registerErExplainRelationshipTools(registerTool, runtime, context);
  registerErDiagramTools(registerTool, runtime, context, buildErDiagramResult);
  registerErDocumentTools(registerTool, runtime, context, buildErDiagramResult);
  registerErEntityDiagramTools(registerTool, runtime, context, buildErDiagramResult);
  registerErExportPlanTools(registerTool, runtime, context, buildErExportPlanResult);
  registerErHtmlTools(registerTool, runtime, context, buildErDiagramResult, buildErExportPlanResult);
}
