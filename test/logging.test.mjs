import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { logAudit, logError, logSlowOperation } from "../dist/errors.js";

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
      import { installProcessLogHandlers } from ${JSON.stringify(moduleUrl)};
      installProcessLogHandlers("logging-test");
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
  } finally {
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
