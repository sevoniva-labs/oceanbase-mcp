#!/usr/bin/env node
import "dotenv/config";

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { loadGatewayConfig } from "./config.js";
import { runDoctorCommand } from "./doctor-runner.js";
import { runExportErCommand } from "./er-export.js";
import { installProcessLogHandlers, logAudit } from "./errors.js";
import { runInitCommand } from "./init.js";
import { runMetadataCommand } from "./metadata-cli.js";
import { createObMcpServer } from "./mcp.js";
import { closeGatewayRuntime, createGatewayRuntime } from "./runtime.js";
import { runScanSqlCommand } from "./sql-scan.js";

installProcessLogHandlers("ob-mcp-stdio");

const [command, ...args] = process.argv.slice(2);

if (command === "init") {
  process.exitCode = await runInitCommand(args);
} else if (command === "doctor") {
  process.exitCode = await runDoctorCommand(args);
} else if (command === "export-er" || command === "ob_export_er_artifact") {
  process.exitCode = await runExportErCommand(args);
} else if (command === "metadata") {
  process.exitCode = await runMetadataCommand(args);
} else if (command === "scan-sql") {
  process.exitCode = await runScanSqlCommand(args);
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
  logAudit("stdio_start", {
    pid: process.pid,
    profileCount: Object.keys(gatewayConfig.profiles).length,
    logFileEnabled: Boolean(process.env.OB_MCP_LOG_FILE?.trim())
  });

  async function shutdown() {
    logAudit("shutdown", {
      transport: "stdio",
      pid: process.pid
    });
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
  ob-mcp metadata <command>  Capture or compare metadata artifacts
  ob-mcp scan-sql [options]  Scan project files for SQL snippets

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
  --depth <n>
  --max-tables <n>
  --max-columns-per-table <n>
  --max-relationships <n>
  --relationship-mode none|foreign_key|inferred
  --strategy single|connected-components|table-prefix|business-term|manual|window
  --no-include-inferred
  --format static|interactive|compact|detailed
  --out <file>
  --out-dir <dir>        Write index.html, overview.html, chunks/, tables/, and metadata/
  --chunk-size <n>
  --overwrite

Scan SQL options:
  --path <path>
  --ignore <pattern>
  --extensions <sql,xml,ts,js,java>
  --max-files <n>
  --max-bytes <n>
  --format json|text
  --fail-on-risk
  --index-out <file>
  --index-overwrite

Metadata commands:
  snapshot                  Capture a metadata-only JSON snapshot
  diff                      Compare two metadata snapshot files
  report                    Generate a metadata change report
`);
}
