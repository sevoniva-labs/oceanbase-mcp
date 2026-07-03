import type { GatewayRuntime } from "../../runtime.js";
import type { McpRequestContext } from "../context.js";
import type { ToolRegistrar } from "../tool-registry.js";
import { buildErDiagramResult } from "./er-diagram-builder.js";
import { registerErDiagramTools } from "./er-diagram-tool.js";
import { registerErDocumentTools } from "./er-document.js";
import { registerErEntityDiagramTools } from "./er-entity-diagram.js";
import { buildErExportPlanResult } from "./er-export-plan-builder.js";
import { registerErExportPlanTools } from "./er-export-plan-tool.js";
import { registerErExplainRelationshipTools } from "./er-explain-relationship.js";
import { registerErHtmlTools } from "./er-html-tool.js";

export function registerErTools(
  registerTool: ToolRegistrar,
  runtime: GatewayRuntime,
  context: McpRequestContext
): void {
  registerErExplainRelationshipTools(registerTool, runtime, context);
  registerErDiagramTools(registerTool, runtime, context, buildErDiagramResult);
  registerErDocumentTools(registerTool, runtime, context, buildErDiagramResult);
  registerErEntityDiagramTools(registerTool, runtime, context, buildErDiagramResult);
  registerErExportPlanTools(registerTool, runtime, context, buildErExportPlanResult);
  registerErHtmlTools(registerTool, runtime, context, buildErDiagramResult, buildErExportPlanResult);
}
