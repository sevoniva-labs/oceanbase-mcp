import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { SERVER_VERSION } from "../capabilities.js";
import type { HttpConfig } from "../config.js";
import { ensureQuerySessionStore } from "../query/sessions.js";
import type { GatewayRuntime } from "../runtime.js";
import type { McpRequestContext } from "./context.js";
import { registerMcpResources } from "./resources.js";
import { createToolRegistrar } from "./tool-registry.js";
import { registerMcpTools } from "./tools/index.js";

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
  registerMcpTools(registerTool, runtime, context, querySessions, httpConfig);

  return server;
}
