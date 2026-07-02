import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { loadConfig } from "../dist/config.js";
import { logAudit, logError, logSlowOperation } from "../dist/errors.js";
import { createObMcpServer } from "../dist/mcp.js";

test("json logs can be written to a file with sensitive values redacted", () => {
  const dir = mkdtempSync(join(tmpdir(), "ob-mcp-log-"));
  const previousFile = process.env.OB_MCP_LOG_FILE;
  const previousStderr = process.env.OB_MCP_LOG_STDERR;
  const previousSlow = process.env.OB_MCP_SLOW_CALL_MS;
  try {
    const file = join(dir, "ob-mcp.jsonl");
    process.env.OB_MCP_LOG_FILE = file;
    process.env.OB_MCP_LOG_STDERR = "false";
    process.env.OB_MCP_SLOW_CALL_MS = "1";

    logAudit("test_event", {
      token: "plain-token",
      message: "authorization: Bearer secret-token password=secret"
    });
    logError("test_error", new Error("connection failed password=secret token=secret"));
    logSlowOperation("slow_tool_call", {
      tool: "ob_query",
      durationMs: 5,
      sqlLength: 10
    });

    const lines = readFileSync(file, "utf8").trim().split(/\n/).map((line) => JSON.parse(line));
    assert.equal(lines.length, 3);
    assert.equal(lines[0].event, "test_event");
    assert.equal(lines[0].token, "[redacted]");
    assert.match(lines[0].message, /Bearer \[redacted\]/);
    assert.match(lines[0].message, /password=\[redacted\]/);
    assert.match(lines[1].error.message, /password=\[redacted\]/);
    assert.equal(lines[2].level, "warn");
    assert.equal(lines[2].event, "slow_tool_call");
    assert.equal(lines[2].thresholdMs, 1);
  } finally {
    restoreEnv("OB_MCP_LOG_FILE", previousFile);
    restoreEnv("OB_MCP_LOG_STDERR", previousStderr);
    restoreEnv("OB_MCP_SLOW_CALL_MS", previousSlow);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("process crash handler writes a redacted JSONL entry before exit", () => {
  const dir = mkdtempSync(join(tmpdir(), "ob-mcp-crash-log-"));
  try {
    const file = join(dir, "crash.jsonl");
    const moduleUrl = pathToFileURL(resolve("dist/errors.js")).href;
    const script = `
      import { installProcessLogHandlers, recordCrashBreadcrumb } from ${JSON.stringify(moduleUrl)};
      installProcessLogHandlers("logging-test");
      recordCrashBreadcrumb("tool_start", {
        tool: "ob_query",
        phase: "execute",
        password: "secret",
        token: "secret"
      });
      setImmediate(() => { throw new Error("boom password=secret token=secret"); });
    `;
    const result = spawnSync(process.execPath, ["--input-type=module", "--eval", script], {
      env: {
        ...process.env,
        OB_MCP_LOG_FILE: file,
        OB_MCP_LOG_STDERR: "false"
      },
      encoding: "utf8",
      timeout: 5_000
    });

    assert.notEqual(result.status, 0);
    const lines = readFileSync(file, "utf8").trim().split(/\n/).map((line) => JSON.parse(line));
    assert.equal(lines.length, 1);
    assert.equal(lines[0].context, "process_uncaught_exception");
    assert.equal(lines[0].service, "logging-test");
    assert.equal(lines[0].fatal, true);
    assert.match(lines[0].error.message, /password=\[redacted\]/);
    assert.match(lines[0].error.message, /token=\[redacted\]/);
    assert.equal(lines[0].breadcrumbs[0].event, "tool_start");
    assert.equal(lines[0].breadcrumbs[0].data.tool, "ob_query");
    assert.equal(lines[0].breadcrumbs[0].data.password, "[redacted]");
    assert.equal(lines[0].breadcrumbs[0].data.token, "[redacted]");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("tool audit logs include bounded response size", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ob-mcp-tool-log-"));
  const previousFile = process.env.OB_MCP_LOG_FILE;
  const previousStderr = process.env.OB_MCP_LOG_STDERR;
  try {
    const file = join(dir, "tool.jsonl");
    process.env.OB_MCP_LOG_FILE = file;
    process.env.OB_MCP_LOG_STDERR = "false";
    const config = loadConfig({
      OB_ALLOWED_SCHEMAS: "biz_test",
      OB_ENFORCE_READ_ONLY_TX: "false"
    });
    const server = createObMcpServer({
      defaultProfile: "default",
      configs: { default: config },
      pools: {
        default: {
          async query() {
            return [[{ id: 1, select_type: "SIMPLE", table: "orders", type: "const", key: "PRIMARY" }], []];
          }
        }
      },
      queryLimiters: { default: { active: 0, limit: 5 } }
    });

    await server.executeToolHandler(server._registeredTools.ob_query_preview, {
      sql: "SELECT id FROM biz_test.orders WHERE id = ? LIMIT 1",
      params: [1]
    }, {});

    const lines = readFileSync(file, "utf8").trim().split(/\n/).map((line) => JSON.parse(line));
    const toolCall = lines.find((line) => line.event === "tool_call" && line.tool === "ob_query_preview");
    assert.ok(toolCall);
    assert.equal(toolCall.ok, true);
    assert.equal(typeof toolCall.responseBytes, "number");
    assert(toolCall.responseBytes > 0);
    assert.equal(toolCall.paramCount, 1);
    assert.equal(toolCall.sqlLength, 51);
  } finally {
    restoreEnv("OB_MCP_LOG_FILE", previousFile);
    restoreEnv("OB_MCP_LOG_STDERR", previousStderr);
    rmSync(dir, { recursive: true, force: true });
  }
});

function restoreEnv(name, value) {
  if (value == null) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}
