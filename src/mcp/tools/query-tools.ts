import type { QuerySessionState } from "../../query/sessions.js";
import type { GatewayRuntime } from "../../runtime.js";
import type { McpRequestContext } from "../context.js";
import type { ToolRegistrar } from "../tool-registry.js";
import { registerQueryBuildTools } from "./query-build.js";
import { registerQueryExecutionTools } from "./query-execution.js";
import { registerQueryPlanTools } from "./query-plan.js";
import { registerQueryResultTools } from "./query-results.js";
import { registerQuerySessionTools } from "./query-sessions.js";
import { registerQueryTemplateTools } from "./query-templates.js";
import { registerRecentRowsTools } from "./recent-rows.js";

export function registerQueryTools(
  registerTool: ToolRegistrar,
  runtime: GatewayRuntime,
  context: McpRequestContext,
  querySessions: Map<string, QuerySessionState>
): void {
  registerQueryExecutionTools(registerTool, runtime, context);
  registerQuerySessionTools(registerTool, runtime, context, querySessions);
  registerQueryResultTools(registerTool, runtime, context, querySessions);
  registerQueryPlanTools(registerTool, runtime, context);
  registerQueryBuildTools(registerTool, runtime, context);
  registerQueryTemplateTools(registerTool, runtime, context);
  registerRecentRowsTools(registerTool, runtime, context);
}
