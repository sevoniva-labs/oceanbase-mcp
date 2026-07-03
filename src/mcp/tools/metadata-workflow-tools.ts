import type { GatewayRuntime } from "../../runtime.js";
import type { McpRequestContext } from "../context.js";
import type { ToolRegistrar } from "../tool-registry.js";
import { registerMetadataChangeTools } from "./metadata-change.js";
import { registerMetadataCompareTools } from "./metadata-compare.js";

export function registerMetadataWorkflowTools(
  registerTool: ToolRegistrar,
  runtime: GatewayRuntime,
  context: McpRequestContext
): void {
  registerMetadataChangeTools(registerTool, runtime, context);
  registerMetadataCompareTools(registerTool, runtime, context);
}
