import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ZodType } from "zod";

import { assertToolManifest } from "../capabilities.js";
import type { GatewayRuntime } from "../runtime.js";
import { isToolAllowed } from "./access.js";
import type { McpRequestContext } from "./context.js";
import { safeTool, type ToolResult } from "./tool-runtime.js";

export interface ToolSpec {
  title: string;
  description: string;
  inputSchema: Record<string, ZodType>;
}

export type ToolHandler<Args = any> = (args: Args) => Promise<ToolResult>;

export function createToolRegistrar(server: McpServer, runtime: GatewayRuntime, context: McpRequestContext) {
  return <Args = any>(name: string, spec: ToolSpec, handler: ToolHandler<Args>): void => {
    assertToolManifest(name);
    if (!isToolAllowed(name, context.principal)) {
      return;
    }
    server.registerTool(name, spec, safeTool(name, handler, context, runtime) as any);
  };
}
