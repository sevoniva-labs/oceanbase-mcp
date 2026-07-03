import type { GatewayRuntime } from "../../runtime.js";
import type { McpRequestContext } from "../context.js";
import type { ToolRegistrar } from "../tool-registry.js";
import { registerDataQualityTools } from "./data-quality.js";
import { registerProfileColumnTools } from "./profile-columns.js";
import { registerProfileTableTools } from "./profile-table.js";
import { registerValueDistributionTools } from "./profile-value-distribution.js";

export function registerDataUnderstandingTools(
  registerTool: ToolRegistrar,
  runtime: GatewayRuntime,
  context: McpRequestContext
): void {
  registerProfileTableTools(registerTool, runtime, context);
  registerProfileColumnTools(registerTool, runtime, context);
  registerValueDistributionTools(registerTool, runtime, context);
  registerDataQualityTools(registerTool, runtime, context);
}
