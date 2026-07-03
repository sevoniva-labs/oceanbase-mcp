import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { SERVER_VERSION } from "../capabilities.js";
import type { HttpConfig } from "../config.js";
import { ensureQuerySessionStore } from "../query/sessions.js";
import type { GatewayRuntime } from "../runtime.js";
import type { McpRequestContext } from "./context.js";
import { registerMcpResources } from "./resources.js";
import { createToolRegistrar } from "./tool-registry.js";
import { registerCatalogTools } from "./tools/catalog.js";
import { registerColumnDetectionTools } from "./tools/column-detection.js";
import { registerDataQualityTools } from "./tools/data-quality.js";
import { registerDocumentationTools } from "./tools/documentation.js";
import { buildErDiagramResult } from "./tools/er-diagram-builder.js";
import { registerErDiagramTools } from "./tools/er-diagram-tool.js";
import { registerErDocumentTools } from "./tools/er-document.js";
import { registerErEntityDiagramTools } from "./tools/er-entity-diagram.js";
import { buildErExportPlanResult } from "./tools/er-export-plan-builder.js";
import { registerErExportPlanTools } from "./tools/er-export-plan-tool.js";
import { registerErExplainRelationshipTools } from "./tools/er-explain-relationship.js";
import { registerErHtmlTools } from "./tools/er-html-tool.js";
import { registerMetadataChangeTools } from "./tools/metadata-change.js";
import { registerMetadataCompareTools } from "./tools/metadata-compare.js";
import { registerObjectMetadataTools } from "./tools/object-metadata.js";
import { registerProfileColumnTools } from "./tools/profile-columns.js";
import { registerProfileTableTools } from "./tools/profile-table.js";
import { registerValueDistributionTools } from "./tools/profile-value-distribution.js";
import { registerQueryBuildTools } from "./tools/query-build.js";
import { registerQueryExecutionTools } from "./tools/query-execution.js";
import { registerQueryPlanTools } from "./tools/query-plan.js";
import { registerQueryResultTools } from "./tools/query-results.js";
import { registerQuerySessionTools } from "./tools/query-sessions.js";
import { registerQueryTemplateTools } from "./tools/query-templates.js";
import { registerRecentRowsTools } from "./tools/recent-rows.js";
import { registerSchemaMapTools } from "./tools/schema-map.js";
import { registerSearchCatalogTools } from "./tools/search-catalog.js";
import { registerSqlConversionTools } from "./tools/sql-conversion.js";
import { registerSqlErrorTools } from "./tools/sql-errors.js";
import { registerSqlLintTools } from "./tools/sql-lint.js";
import { registerSqlMapperContextTools } from "./tools/sql-mapper-context.js";
import { registerSqlPrepareTools } from "./tools/sql-prepare.js";
import { registerSqlProjectQueryTools } from "./tools/sql-project-query.js";
import { registerSqlQueryDocTools } from "./tools/sql-query-doc.js";
import { registerSqlRewriteTools } from "./tools/sql-rewrite.js";
import { registerSqlUsageTools } from "./tools/sql-usages.js";
import { registerSqlValidationTools } from "./tools/sql-validation.js";
import { registerSqlUnknownColumnTools } from "./tools/sql-unknown-columns.js";
import { registerSystemTools } from "./tools/system.js";
import { registerTableContextTools } from "./tools/table-context.js";
import { registerTableMetadataTools } from "./tools/table-metadata.js";

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

  registerProfileTableTools(registerTool, runtime, context);
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
  registerErExplainRelationshipTools(registerTool, runtime, context);
  registerErDiagramTools(registerTool, runtime, context, buildErDiagramResult);
  registerErDocumentTools(registerTool, runtime, context, buildErDiagramResult);
  registerErEntityDiagramTools(registerTool, runtime, context, buildErDiagramResult);
  registerErExportPlanTools(registerTool, runtime, context, buildErExportPlanResult);
  registerErHtmlTools(registerTool, runtime, context, buildErDiagramResult, buildErExportPlanResult);

  return server;
}
