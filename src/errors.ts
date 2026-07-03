import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export interface SerializedError {
  message: string;
  name?: string;
  code?: unknown;
  errno?: unknown;
  sqlState?: unknown;
  sqlMessage?: unknown;
}

export interface CrashBreadcrumb {
  timestamp: string;
  event: string;
  data: Record<string, unknown>;
}

export interface SerializeErrorOptions {
  includeSqlMessage?: boolean;
}

const SECRET_KEY_PATTERN = /(authorization|password|passwd|pwd|token|secret|credential|cookie|api[_-]?key|private[_-]?key)/i;
const DEFAULT_SLOW_CALL_MS = 3_000;
const MAX_CRASH_BREADCRUMBS = 20;
const crashBreadcrumbs: CrashBreadcrumb[] = [];
let logFileWriteFailed = false;
let processLogHandlersInstalled = false;

export function serializeError(error: unknown, options: SerializeErrorOptions = { includeSqlMessage: true }): SerializedError {
  if (!(error instanceof Error)) {
    return { message: String(error) };
  }

  const record = error as Error & {
    code?: unknown;
    errno?: unknown;
    sqlState?: unknown;
    sqlMessage?: unknown;
  };

  return {
    message: error.message,
    name: error.name,
    code: record.code,
    errno: record.errno,
    sqlState: record.sqlState,
    sqlMessage: options.includeSqlMessage === false ? undefined : record.sqlMessage
  };
}

export function logError(
  context: string,
  error: unknown,
  data: Record<string, unknown> = {},
  options: SerializeErrorOptions = {}
): void {
  writeJsonLog({
    level: "error",
    context,
    error: serializeError(error, options),
    timestamp: new Date().toISOString(),
    ...data
  });
}

export function logAudit(event: string, data: Record<string, unknown>): void {
  writeJsonLog({
    level: "audit",
    event,
    timestamp: new Date().toISOString(),
    ...data
  });
}

export function logSlowOperation(event: string, data: Record<string, unknown>): void {
  const durationMs = Number(data.durationMs ?? 0);
  const thresholdMs = slowCallThresholdMs();
  if (thresholdMs <= 0 || !Number.isFinite(durationMs) || durationMs < thresholdMs) {
    return;
  }

  writeJsonLog({
    level: "warn",
    event,
    timestamp: new Date().toISOString(),
    thresholdMs,
    ...data
  });
}

export function recordCrashBreadcrumb(event: string, data: Record<string, unknown> = {}): void {
  crashBreadcrumbs.push({
    timestamp: new Date().toISOString(),
    event,
    data
  });
  while (crashBreadcrumbs.length > MAX_CRASH_BREADCRUMBS) {
    crashBreadcrumbs.shift();
  }
}

export function getCrashBreadcrumbs(): CrashBreadcrumb[] {
  return crashBreadcrumbs.map((breadcrumb) => ({
    timestamp: breadcrumb.timestamp,
    event: breadcrumb.event,
    data: { ...breadcrumb.data }
  }));
}

export function installProcessLogHandlers(service = "ob-mcp"): void {
  if (processLogHandlersInstalled) {
    return;
  }
  processLogHandlersInstalled = true;

  process.on("uncaughtException", (error) => {
    logError("process_uncaught_exception", error, {
      service,
      fatal: true,
      pid: process.pid,
      breadcrumbs: getCrashBreadcrumbs()
    });
    process.exit(1);
  });

  process.on("unhandledRejection", (reason) => {
    logError("process_unhandled_rejection", reason, {
      service,
      fatal: true,
      pid: process.pid,
      breadcrumbs: getCrashBreadcrumbs()
    });
    process.exit(1);
  });

  process.on("warning", (warning) => {
    logError("process_warning", warning, {
      service,
      fatal: false,
      pid: process.pid
    });
  });
}

function writeJsonLog(payload: Record<string, unknown>): void {
  const safePayload = sanitizeLogValue(payload) as Record<string, unknown>;
  const line = JSON.stringify(safePayload);
  if (logToStderr()) {
    console.error(line);
  }

  const logFile = process.env.OB_MCP_LOG_FILE?.trim();
  if (!logFile) {
    return;
  }

  try {
    mkdirSync(dirname(logFile), { recursive: true });
    appendFileSync(logFile, `${line}\n`, { encoding: "utf8" });
  } catch (error) {
    if (logFileWriteFailed || !logToStderr()) {
      return;
    }
    logFileWriteFailed = true;
    console.error(JSON.stringify({
      level: "error",
      context: "log_file_write",
      timestamp: new Date().toISOString(),
      error: serializeError(error, { includeSqlMessage: false })
    }));
  }
}

function sanitizeLogValue(value: unknown, depth = 0, key = ""): unknown {
  if (SECRET_KEY_PATTERN.test(key)) {
    return "[redacted]";
  }
  if (value == null || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (typeof value === "string") {
    return redactString(value);
  }
  if (depth >= 6) {
    return "[truncated]";
  }
  if (Array.isArray(value)) {
    return value.slice(0, 100).map((item) => sanitizeLogValue(item, depth + 1));
  }
  if (typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [entryKey, entryValue] of Object.entries(value as Record<string, unknown>)) {
      output[entryKey] = sanitizeLogValue(entryValue, depth + 1, entryKey);
    }
    return output;
  }
  return String(value);
}

function redactString(value: string): string {
  return value
    .replace(/(authorization\s*[:=]\s*bearer\s+)[^\s,;}\]]+/gi, "$1[redacted]")
    .replace(/((?:password|passwd|pwd|token|secret|credential|api[_-]?key|private[_-]?key)\s*[:=]\s*)[^\s,;}\]]+/gi, "$1[redacted]");
}

function slowCallThresholdMs(): number {
  const raw = process.env.OB_MCP_SLOW_CALL_MS?.trim();
  if (raw == null || raw === "") {
    return DEFAULT_SLOW_CALL_MS;
  }
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : DEFAULT_SLOW_CALL_MS;
}

function logToStderr(): boolean {
  const raw = process.env.OB_MCP_LOG_STDERR?.trim().toLowerCase();
  return raw == null || !["0", "false", "no", "off"].includes(raw);
}
