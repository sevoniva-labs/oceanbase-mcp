import type { HttpConfig } from "../../config.js";
import type { QuerySessionState } from "../../query/sessions.js";
import type { GatewayRuntime } from "../../runtime.js";
import type { McpRequestContext } from "../context.js";
import type { ToolRegistrar } from "../tool-registry.js";
import { registerDataUnderstandingTools } from "./data-understanding-tools.js";
import { registerDocumentationTools } from "./documentation.js";
import { registerErTools } from "./er-tools.js";
import { registerMetadataChangeTools } from "./metadata-change.js";
import { registerMetadataCompareTools } from "./metadata-compare.js";
import { registerMetadataTools } from "./metadata-tools.js";
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
  registerDataUnderstandingTools(registerTool, runtime, context);

  registerDocumentationTools(registerTool, runtime, context);
  registerErTools(registerTool, runtime, context);
}
