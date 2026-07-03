import type { HttpConfig } from "../../config.js";
import type { QuerySessionState } from "../../query/sessions.js";
import type { GatewayRuntime } from "../../runtime.js";
import type { McpRequestContext } from "../context.js";
import type { ToolRegistrar } from "../tool-registry.js";
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
import { registerMetadataTools } from "./metadata-tools.js";
import { registerProfileColumnTools } from "./profile-columns.js";
import { registerProfileTableTools } from "./profile-table.js";
import { registerValueDistributionTools } from "./profile-value-distribution.js";
import { registerQueryTools } from "./query-tools.js";
import { registerSqlTools } from "./sql-tools.js";
import { registerSystemTools } from "./system.js";

export function registerMcpTools(
  registerTool: ToolRegistrar,
  runtime: GatewayRuntime,
  context: McpRequestContext,
  querySessions: Map<string, QuerySessionState>,
  httpConfig?: HttpConfig
): void {
  registerSystemTools(registerTool, runtime, context, httpConfig);
  registerQueryTools(registerTool, runtime, context, querySessions);
  registerMetadataTools(registerTool, runtime, context);

  registerMetadataChangeTools(registerTool, runtime, context);
  registerMetadataCompareTools(registerTool, runtime, context);
  registerSqlTools(registerTool, runtime, context);

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
