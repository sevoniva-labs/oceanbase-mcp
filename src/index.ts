#!/usr/bin/env node
import "dotenv/config";

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { loadGatewayConfig } from "./config.js";
import { runDoctorCommand } from "./doctor-runner.js";
import { runExportErCommand } from "./er-export.js";
import { runInitCommand } from "./init.js";
import { createObMcpServer } from "./mcp.js";
import { closeGatewayRuntime, createGatewayRuntime } from "./runtime.js";

const [command, ...args] = process.argv.slice(2);

if (command === "init") {
  process.exitCode = await runInitCommand(args);
} else if (command === "doctor") {
  process.exitCode = await runDoctorCommand(args);
} else if (command === "export-er" || command === "ob_export_er_artifact") {
  process.exitCode = await runExportErCommand(args);
} else if (command === "--help" || command === "-h" || command === "help") {
  printHelp();
} else if (command) {
  console.error(`Unknown command: ${command}`);
  printHelp();
  process.exitCode = 1;
} else {
  await startStdioServer();
}

async function startStdioServer() {
  const gatewayConfig = loadGatewayConfig();
  const runtime = createGatewayRuntime(gatewayConfig);
  const server = createObMcpServer(runtime);

  const transport = new StdioServerTransport();
  await server.connect(transport);

  async function shutdown() {
    await server.close();
    await closeGatewayRuntime(runtime);
    process.exit(0);
  }

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

function printHelp() {
  console.log(`OceanBase MCP

Usage:
  ob-mcp                     Start the stdio MCP server
  ob-mcp init [options]      Create local OpenCode and OceanBase MCP files
  ob-mcp doctor              Check local setup, config, and OceanBase connectivity
  ob-mcp export-er [options] Export a local ER HTML artifact

Init options:
  --mode mysql|oracle
  --host <host>
  --port <port>
  --schema <schema>
  --username <name>
  --tenant <tenant>
  --cluster <cluster>
  --dry-run
  --force

Doctor options:
  --skip-connect

Export ER options:
  --schema <schema>
  --table <table>
  --tables <table_a,table_b>
  --business-term <term>
  --format static|interactive|compact|detailed
  --out <file>
  --overwrite
`);
}
