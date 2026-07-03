import { randomUUID } from "node:crypto";

import { getToolCapability, resolveToolBudget } from "../capabilities.js";
import type { ObConfig } from "../config.js";
import { logAudit, logError, logSlowOperation, recordCrashBreadcrumb, serializeError } from "../errors.js";
import { assertJsonByteLimit, jsonText } from "../format.js";
import { metrics } from "../metrics.js";
import { createExecutionDiagnostics, withExecutionDiagnostics, type GatewayRuntime } from "../runtime.js";
import { assertToolAllowed, gatewayLimitConfig } from "./access.js";
import type { McpRequestContext } from "./context.js";
import { resultDiagnostics, resultTextBytes } from "./tool-logging.js";

const TOOL_TIMEOUT_GRACE_MS = 250;

export type ToolResult = ReturnType<typeof toResult>;

export function toLimitedResult(data: unknown, config: ObConfig): ToolResult {
  assertJsonByteLimit(data, config.maxResultBytes);
  return toResult(data);
}

export function toGatewayLimitedResult(data: unknown, runtime: GatewayRuntime, context: McpRequestContext): ToolResult {
  return toLimitedResult(data, gatewayLimitConfig(runtime, context));
}

export function toResult(data: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: jsonText(data)
      }
    ]
  };
}

export function toErrorResult(error: unknown, args?: unknown) {
  return {
    isError: true,
    content: [
      {
        type: "text" as const,
        text: jsonText({
          ok: false,
          error: serializeError(error, { includeSqlMessage: false }),
          hints: errorHints(error, args)
        })
      }
    ]
  };
}

export function safeTool<Args>(
  name: string,
  handler: (args: Args) => Promise<ToolResult>,
  context: McpRequestContext,
  runtime: GatewayRuntime
) {
  return async (args: Args) => {
    const started = Date.now();
    const finish = metrics.startToolCall();
    const requestId = context.requestId ?? randomUUID();
    const toolCapability = getToolCapability(name);
    const resolvedBudget = toolCapability
      ? resolveToolBudget(toolCapability, gatewayLimitConfig(runtime, context))
      : undefined;
    const executionDiagnostics = createExecutionDiagnostics(resolvedBudget?.maxDbCalls ?? null, name);
    let timeoutMs: number | undefined;
    recordCrashBreadcrumb("tool_start", {
      tool: name,
      toolGroup: toolCapability?.group,
      operationType: toolCapability?.operationType,
      transport: context.transport ?? "stdio",
      requestId,
      phase: "start",
      budget: resolvedBudget,
      clientId: context.clientId,
      principal: context.principal?.name,
      ...auditArgs(args)
    });
    try {
      assertToolAllowed(name, context.principal);
      timeoutMs = toolWallTimeoutMs(name, runtime, context);
      const result = await withToolTimeout(
        withExecutionDiagnostics(executionDiagnostics, () => Promise.resolve().then(() => handler(args))),
        timeoutMs,
        name
      );
      const durationMs = Date.now() - started;
      const responseBytes = resultTextBytes(result);
      const diagnostics = resultDiagnostics(result);
      recordCrashBreadcrumb("tool_finish", {
        ok: true,
        tool: name,
        toolGroup: toolCapability?.group,
        operationType: toolCapability?.operationType,
        durationMs,
        responseBytes,
        timeoutMs,
        requestId,
        phase: "finish",
        budget: resolvedBudget,
        dbCalls: executionDiagnostics.dbCalls,
        ...diagnostics
      });
      logAudit("tool_call", {
        ok: true,
        tool: name,
        toolGroup: toolCapability?.group,
        operationType: toolCapability?.operationType,
        transport: context.transport ?? "stdio",
        requestId,
        phase: "finish",
        budget: resolvedBudget,
        clientId: context.clientId,
        principal: context.principal?.name,
        durationMs,
        timeoutMs,
        responseBytes,
        dbCalls: executionDiagnostics.dbCalls,
        ...diagnostics,
        ...auditArgs(args)
      });
      logSlowOperation("slow_tool_call", {
        ok: true,
        tool: name,
        toolGroup: toolCapability?.group,
        operationType: toolCapability?.operationType,
        transport: context.transport ?? "stdio",
        requestId,
        phase: "finish",
        budget: resolvedBudget,
        clientId: context.clientId,
        principal: context.principal?.name,
        durationMs,
        timeoutMs,
        responseBytes,
        dbCalls: executionDiagnostics.dbCalls,
        ...diagnostics,
        ...auditArgs(args)
      });
      return result;
    } catch (error) {
      const durationMs = Date.now() - started;
      const errorResult = toErrorResult(error, args);
      const responseBytes = resultTextBytes(errorResult);
      const diagnostics = resultDiagnostics(errorResult);
      const sanitizedError = serializeError(error, { includeSqlMessage: false });
      metrics.recordToolBlocked();
      metrics.recordToolError();
      recordCrashBreadcrumb("tool_finish", {
        ok: false,
        tool: name,
        toolGroup: toolCapability?.group,
        operationType: toolCapability?.operationType,
        durationMs,
        responseBytes,
        timeoutMs,
        requestId,
        phase: "finish",
        budget: resolvedBudget,
        errorCode: sanitizedError.code ?? sanitizedError.name ?? "Error",
        sanitizedError,
        dbCalls: executionDiagnostics.dbCalls,
        ...diagnostics
      });
      logAudit("tool_call", {
        ok: false,
        tool: name,
        toolGroup: toolCapability?.group,
        operationType: toolCapability?.operationType,
        transport: context.transport ?? "stdio",
        requestId,
        phase: "finish",
        budget: resolvedBudget,
        clientId: context.clientId,
        principal: context.principal?.name,
        durationMs,
        timeoutMs,
        responseBytes,
        errorCode: sanitizedError.code ?? sanitizedError.name ?? "Error",
        sanitizedError,
        dbCalls: executionDiagnostics.dbCalls,
        ...diagnostics,
        blockedReason: (error as Error).message,
        ...auditArgs(args)
      });
      logSlowOperation("slow_tool_call", {
        ok: false,
        tool: name,
        toolGroup: toolCapability?.group,
        operationType: toolCapability?.operationType,
        transport: context.transport ?? "stdio",
        requestId,
        phase: "finish",
        budget: resolvedBudget,
        clientId: context.clientId,
        principal: context.principal?.name,
        durationMs,
        timeoutMs,
        responseBytes,
        errorCode: sanitizedError.code ?? sanitizedError.name ?? "Error",
        sanitizedError,
        dbCalls: executionDiagnostics.dbCalls,
        ...diagnostics,
        blockedReason: (error as Error).message,
        ...auditArgs(args)
      });
      logError(name, error, { requestId, tool: name }, { includeSqlMessage: false });
      return errorResult;
    } finally {
      finish();
    }
  };
}

export function errorHints(error: unknown, args: unknown): string[] {
  const message = (error as Error)?.message ?? String(error);
  const lower = message.toLowerCase();
  const sql = args && typeof args === "object" && "sql" in args ? String((args as Record<string, unknown>).sql ?? "") : "";
  const hints: string[] = [];

  if (/unknown column|invalid identifier|ora-00904|1054/.test(lower)) {
    hints.push("Column was not found. Search visible metadata with ob_search_catalog, then read table details with ob_get_table_context.");
    hints.push("In Oracle mode, check object and column casing. Unquoted identifiers are usually uppercase.");
  }
  if (/unknown table|table .* doesn't exist|ora-00942|1146/.test(lower)) {
    hints.push("Table was not found or is not visible. Search visible schemas and tables with ob_search_catalog or ob_list_tables.");
    hints.push("Check whether the SQL uses the configured schema and whether that schema is allowed by policy.");
  }
  if (/not allowed by the configured oceanbase mcp access policy|not allowed for token|blocked by ob_denied_columns|select \*/.test(lower)) {
    hints.push("The request was blocked by MCP policy. Use ob_policy_explain or ob_query_preview to inspect the failing check.");
    hints.push("Use explicit columns and allowed schema-qualified tables.");
  }
  if (/only read-only sql|write\/control keyword|multiple sql statements|side-effect|explain analyze|nextval/.test(lower)) {
    hints.push("Only read-only SELECT, WITH, and safe EXPLAIN statements are allowed.");
    hints.push("Remove writes, DDL, DCL, procedure calls, sequence NEXTVAL, locks, sleeps, file functions, and extra statements.");
  }
  if (/limit|offset|fetch|rownum|orderby must contain|paged query input/.test(lower)) {
    hints.push("For ob_query_page, pass SQL without existing LIMIT, OFFSET/FETCH, or ROWNUM pagination.");
    hints.push("Use orderBy only with simple identifiers, optional ASC/DESC, and comma separators.");
  }
  if (/access denied|permission|privilege|ora-01031|1044|1142/.test(lower)) {
    hints.push("The database account may not have the required read or metadata privilege. Run ob_verify_permissions and check grants.");
  }
  if (/exceeded configured timeout budget|timeout|timed out|query execution was interrupted/.test(lower)) {
    hints.push("The request exceeded the configured timeout. Narrow the schema, table scope, row limit, or ER export window before retrying.");
    hints.push("For large ER diagrams, use ob_plan_er_export and export smaller chunks instead of requesting a full inline diagram.");
  }
  if (sql && !/\border\s+by\b/i.test(sql) && /ob_query_page|paged/i.test(lower)) {
    hints.push("Add a stable ORDER BY for repeatable pagination.");
  }

  return [...new Set(hints)];
}

function toolWallTimeoutMs(name: string, runtime: GatewayRuntime, context: McpRequestContext): number {
  const config = gatewayLimitConfig(runtime, context);
  const configuredTimeout = resolveToolBudget(name, config).timeoutMs;
  return Math.max(1, configuredTimeout + TOOL_TIMEOUT_GRACE_MS);
}

async function withToolTimeout<T>(operation: Promise<T>, timeoutMs: number, name: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`Tool "${name}" exceeded configured timeout budget ${timeoutMs}ms.`));
    }, timeoutMs);
  });
  try {
    return await Promise.race([operation, timeout]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

function auditArgs(args: unknown): Record<string, unknown> {
  if (!args || typeof args !== "object") {
    return {};
  }
  const record = args as Record<string, unknown>;
  const output: Record<string, unknown> = {};
  for (const key of ["profile", "schema", "table", "objectName", "objectType", "depth", "limit", "maxRows", "mask"]) {
    if (record[key] != null) {
      output[key] = record[key];
    }
  }
  if (Array.isArray(record.objectTypes)) {
    output.objectTypes = record.objectTypes;
  }
  if (typeof record.sql === "string") {
    output.sqlLength = record.sql.length;
  }
  if (Array.isArray(record.params)) {
    output.paramCount = record.params.length;
  }
  if (typeof record.query === "string") {
    output.queryLength = record.query.length;
  }
  return output;
}
