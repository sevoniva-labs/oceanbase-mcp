#!/usr/bin/env node
import "dotenv/config";

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { loadGatewayConfig } from "./config.js";
import { createObMcpServer } from "./mcp.js";
import { closeGatewayRuntime, createGatewayRuntime } from "./runtime.js";

const gatewayConfig = loadGatewayConfig();
const runtime = createGatewayRuntime(gatewayConfig);
const server = createObMcpServer(runtime);

const transport = new StdioServerTransport();
await server.connect(transport);

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

async function shutdown() {
  await server.close();
  await closeGatewayRuntime(runtime);
  process.exit(0);
}
