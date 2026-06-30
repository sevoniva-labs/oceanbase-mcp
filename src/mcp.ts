import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { HttpConfig, ObConfig } from "./config.js";
import { publicConfig } from "./config.js";
import {
  describeTable,
  listConstraints,
  listIndexes,
  listPartitions,
  listSchemas,
  listTables,
  ping,
  runReadOnlyQuery,
  sampleRows,
  searchCatalog,
  type SqlParam
} from "./db.js";
import { diagnoseGateway } from "./diagnostics.js";
import { logAudit, logError, serializeError } from "./errors.js";
import { jsonText, type QueryOutput } from "./format.js";
import { metrics } from "./metrics.js";
import {
  assertOutputAllowed,
  assertSqlPolicy,
  assertTableAccess,
  explainSqlPolicy,
  filterColumnMetadata,
  filterSchemas,
  filterTables,
  isDeniedColumn
} from "./policy.js";
import { selectRuntimeProfile, type GatewayRuntime } from "./runtime.js";
import { assertReadOnlySql, assertSqlInputLimits, buildExplainSql, prepareReadOnlySql } from "./sql.js";

const sqlParamSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);
const profileInput = {
  profile: z.string().optional()
};
const SENSITIVE_SAMPLE_PATTERN =
  /(password|passwd|pwd|secret|token|api[_-]?key|private[_-]?key|credential|session|cookie|email|phone|mobile|id[_-]?card|ssn)/i;

export function createObMcpServer(runtime: GatewayRuntime, httpConfig?: HttpConfig): McpServer {
  const server = new McpServer({
    name: "ob-mcp",
    version: "0.3.0"
  });

  server.registerResource(
    "connection",
    "ob://connection",
    {
      title: "Default OceanBase Connection",
      description: "Default OceanBase MCP connection settings, excluding password and SSL material.",
      mimeType: "application/json"
    },
    async (uri) => {
      const selected = selectRuntimeProfile(runtime);
      return resourceResult(uri.href, publicConfig(selected.config));
    }
  );

  server.registerResource(
    "profiles",
    "ob://profiles",
    {
      title: "OceanBase MCP Profiles",
      description: "Configured OceanBase profiles with redacted connection settings.",
      mimeType: "application/json"
    },
    async (uri) =>
      resourceResult(uri.href, {
        defaultProfile: runtime.defaultProfile,
        profiles: Object.fromEntries(Object.entries(runtime.configs).map(([name, config]) => [name, publicConfig(config)]))
      })
  );

  server.registerResource(
    "table-schema",
    new ResourceTemplate("ob://profile/{profile}/schema/{schema}/table/{table}", { list: undefined }),
    {
      title: "OceanBase Table Schema",
      description: "Policy-filtered table schema for one profile/schema/table.",
      mimeType: "application/json"
    },
    async (uri, variables) => {
      const selected = selectRuntimeProfile(runtime, stringVariable(variables.profile));
      const schema = stringVariable(variables.schema);
      const table = stringVariable(variables.table);
      assertTableAccess(schema, table, policyContext(selected.config));
      const rows = await describeTable(selected.pool, selected.config.compatibility, table, schema, selected.config.queryTimeoutMs);
      return resourceResult(uri.href, filterColumnMetadata(rows, selected.config.policy));
    }
  );

  server.registerTool(
    "ob_list_profiles",
    {
      title: "List OceanBase Profiles",
      description: "List configured OceanBase MCP profiles with redacted settings.",
      inputSchema: {}
    },
    safeTool("ob_list_profiles", async () =>
      toResult({
        defaultProfile: runtime.defaultProfile,
        profiles: Object.fromEntries(Object.entries(runtime.configs).map(([name, config]) => [name, publicConfig(config)]))
      })
    )
  );

  server.registerTool(
    "ob_config_diagnostics",
    {
      title: "Run Config Diagnostics",
      description: "Check profile, policy, TLS, HTTP, and production hardening settings.",
      inputSchema: {}
    },
    safeTool("ob_config_diagnostics", async () =>
      toResult(
        diagnoseGateway(
          {
            defaultProfile: runtime.defaultProfile,
            profiles: runtime.configs
          },
          httpConfig
        )
      )
    )
  );

  server.registerTool(
    "ob_ping",
    {
      title: "Ping OceanBase",
      description: "Verify the configured OceanBase connection.",
      inputSchema: profileInput
    },
    safeTool("ob_ping", async ({ profile }) => {
      const selected = selectRuntimeProfile(runtime, profile);
      return toResult(await ping(selected.pool, selected.config));
    })
  );

  server.registerTool(
    "ob_policy_explain",
    {
      title: "Explain SQL Policy Decision",
      description: "Explain whether a SQL statement is allowed and which read-only or access-policy checks apply.",
      inputSchema: {
        ...profileInput,
        sql: z.string().min(1),
        params: z.array(sqlParamSchema).optional().default([])
      }
    },
    safeTool("ob_policy_explain", async ({ profile, sql, params = [] }) => {
      const selected = selectRuntimeProfile(runtime, profile);
      const sqlParams = params as SqlParam[];
      const checks = [
        runExplainCheck("input_limits", () => assertSqlInputLimits(sql, sqlParams, selected.config)),
        runExplainCheck("read_only_sql", () => assertReadOnlySql(sql))
      ];
      const policy = explainSqlPolicy(sql, policyContext(selected.config));
      return toResult({
        profile: selected.profile,
        allowed: checks.every((check) => check.ok) && policy.allowed,
        checks,
        policy
      });
    })
  );

  server.registerTool(
    "ob_query",
    {
      title: "Run Strict Read-Only Query",
      description: "Run a strictly read-only SQL statement against OceanBase.",
      inputSchema: {
        ...profileInput,
        sql: z.string().min(1),
        params: z.array(sqlParamSchema).optional().default([]),
        maxRows: z.number().int().positive().max(10_000).optional()
      }
    },
    safeTool("ob_query", async ({ profile, sql, params = [], maxRows }) => {
      const selected = selectRuntimeProfile(runtime, profile);
      const started = Date.now();
      const sqlParams = params as SqlParam[];
      assertSqlInputLimits(sql, sqlParams, selected.config);
      assertSqlPolicy(sql, policyContext(selected.config));
      const effectiveMaxRows = maxRows ?? selected.config.maxRows;
      const limitedSql = prepareReadOnlySql(sql, effectiveMaxRows, selected.config.compatibility);
      const output = await runReadOnlyQuery(
        selected.pool,
        selected.config.compatibility,
        limitedSql,
        sqlParams,
        effectiveMaxRows,
        selected.config.queryTimeoutMs,
        selected.config.enforceReadOnlyTransaction
      );
      assertOutputAllowed(output, selected.config.policy);
      const durationMs = Date.now() - started;
      metrics.recordQueryDuration(durationMs);
      logAudit("ob_query", {
        ok: true,
        tool: "ob_query",
        profile: selected.profile,
        durationMs,
        rowCount: output.rowCount,
        truncated: output.truncated,
        sqlLength: sql.length,
        paramCount: sqlParams.length
      });
      return toResult(output);
    })
  );

  server.registerTool(
    "ob_list_schemas",
    {
      title: "List Schemas",
      description: "List schemas/databases visible to the current OceanBase user, filtered by access policy.",
      inputSchema: profileInput
    },
    safeTool("ob_list_schemas", async ({ profile }) => {
      const selected = selectRuntimeProfile(runtime, profile);
      return toResult(filterSchemas(await listSchemas(selected.pool, selected.config.compatibility, selected.config.queryTimeoutMs), selected.config.policy));
    })
  );

  server.registerTool(
    "ob_list_tables",
    {
      title: "List Tables",
      description: "List tables visible to the current OceanBase user, filtered by access policy.",
      inputSchema: {
        ...profileInput,
        schema: z.string().optional(),
        limit: z.number().int().positive().max(10_000).optional()
      }
    },
    safeTool("ob_list_tables", async ({ profile, schema, limit }) => {
      const selected = selectRuntimeProfile(runtime, profile);
      if (schema) {
        assertTableAccess(schema, "*", policyContext(selected.config));
      }
      const rows = await listTables(selected.pool, selected.config.compatibility, schema, limit ?? selected.config.maxRows, selected.config.queryTimeoutMs);
      return toResult(filterTables(rows, selected.config.policy));
    })
  );

  server.registerTool(
    "ob_describe_table",
    {
      title: "Describe Table",
      description: "Return column metadata for an allowed OceanBase table.",
      inputSchema: {
        ...profileInput,
        table: z.string().min(1),
        schema: z.string().optional()
      }
    },
    safeTool("ob_describe_table", async ({ profile, table, schema }) => {
      const selected = selectRuntimeProfile(runtime, profile);
      const effectiveSchema = metadataSchema(selected.config, schema);
      assertTableAccess(effectiveSchema, table, policyContext(selected.config));
      const rows = await describeTable(selected.pool, selected.config.compatibility, table, effectiveSchema, selected.config.queryTimeoutMs);
      return toResult(filterColumnMetadata(rows, selected.config.policy));
    })
  );

  server.registerTool(
    "ob_explain",
    {
      title: "Explain Query",
      description: "Run EXPLAIN for a strictly read-only SQL statement.",
      inputSchema: {
        ...profileInput,
        sql: z.string().min(1),
        params: z.array(sqlParamSchema).optional().default([]),
        maxRows: z.number().int().positive().max(10_000).optional()
      }
    },
    safeTool("ob_explain", async ({ profile, sql, params = [], maxRows }) => {
      const selected = selectRuntimeProfile(runtime, profile);
      const sqlParams = params as SqlParam[];
      assertSqlInputLimits(sql, sqlParams, selected.config);
      assertReadOnlySql(sql);
      assertSqlPolicy(sql, policyContext(selected.config));
      const explainSql = buildExplainSql(sql);
      const started = Date.now();
      const output = await runReadOnlyQuery(
        selected.pool,
        selected.config.compatibility,
        explainSql,
        sqlParams,
        maxRows ?? selected.config.maxRows,
        selected.config.queryTimeoutMs,
        selected.config.enforceReadOnlyTransaction
      );
      metrics.recordQueryDuration(Date.now() - started);
      return toResult(output);
    })
  );

  server.registerTool(
    "ob_search_catalog",
    {
      title: "Search Catalog",
      description: "Search schemas, tables, columns, and comments, filtered by access policy.",
      inputSchema: {
        ...profileInput,
        query: z.string().min(1),
        schema: z.string().optional(),
        limit: z.number().int().positive().max(1000).optional()
      }
    },
    safeTool("ob_search_catalog", async ({ profile, query, schema, limit }) => {
      const selected = selectRuntimeProfile(runtime, profile);
      if (schema) {
        assertTableAccess(schema, "*", policyContext(selected.config));
      }
      const rows = await searchCatalog(selected.pool, selected.config.compatibility, query, schema, limit ?? selected.config.maxRows, selected.config.queryTimeoutMs);
      return toResult(filterColumnMetadata(rows, selected.config.policy));
    })
  );

  server.registerTool(
    "ob_get_table_schema",
    {
      title: "Get Table Schema",
      description: "Return policy-filtered table columns and types for one table.",
      inputSchema: {
        ...profileInput,
        table: z.string().min(1),
        schema: z.string().optional()
      }
    },
    safeTool("ob_get_table_schema", async ({ profile, table, schema }) => {
      const selected = selectRuntimeProfile(runtime, profile);
      const effectiveSchema = metadataSchema(selected.config, schema);
      assertTableAccess(effectiveSchema, table, policyContext(selected.config));
      const rows = await describeTable(selected.pool, selected.config.compatibility, table, effectiveSchema, selected.config.queryTimeoutMs);
      return toResult(filterColumnMetadata(rows, selected.config.policy));
    })
  );

  server.registerTool(
    "ob_get_indexes",
    {
      title: "Get Table Indexes",
      description: "Return indexes for an allowed OceanBase table.",
      inputSchema: {
        ...profileInput,
        table: z.string().min(1),
        schema: z.string().optional()
      }
    },
    safeTool("ob_get_indexes", async ({ profile, table, schema }) => {
      const selected = selectRuntimeProfile(runtime, profile);
      const effectiveSchema = metadataSchema(selected.config, schema);
      assertTableAccess(effectiveSchema, table, policyContext(selected.config));
      const rows = await listIndexes(selected.pool, selected.config.compatibility, table, effectiveSchema, selected.config.queryTimeoutMs);
      return toResult(filterTables(rows, selected.config.policy));
    })
  );

  server.registerTool(
    "ob_get_constraints",
    {
      title: "Get Table Constraints",
      description: "Return constraints for an allowed OceanBase table.",
      inputSchema: {
        ...profileInput,
        table: z.string().min(1),
        schema: z.string().optional()
      }
    },
    safeTool("ob_get_constraints", async ({ profile, table, schema }) => {
      const selected = selectRuntimeProfile(runtime, profile);
      const effectiveSchema = metadataSchema(selected.config, schema);
      assertTableAccess(effectiveSchema, table, policyContext(selected.config));
      const rows = await listConstraints(selected.pool, selected.config.compatibility, table, effectiveSchema, selected.config.queryTimeoutMs);
      return toResult(filterColumnMetadata(rows, selected.config.policy));
    })
  );

  server.registerTool(
    "ob_get_partitions",
    {
      title: "Get Table Partitions",
      description: "Return partition metadata for an allowed OceanBase table.",
      inputSchema: {
        ...profileInput,
        table: z.string().min(1),
        schema: z.string().optional()
      }
    },
    safeTool("ob_get_partitions", async ({ profile, table, schema }) => {
      const selected = selectRuntimeProfile(runtime, profile);
      const effectiveSchema = metadataSchema(selected.config, schema);
      assertTableAccess(effectiveSchema, table, policyContext(selected.config));
      const rows = await listPartitions(selected.pool, selected.config.compatibility, table, effectiveSchema, selected.config.queryTimeoutMs);
      return toResult(filterTables(rows, selected.config.policy));
    })
  );

  server.registerTool(
    "ob_sample_rows",
    {
      title: "Sample Rows",
      description: "Return a small, policy-filtered sample from an allowed table. Sensitive-looking fields are always masked.",
      inputSchema: {
        ...profileInput,
        table: z.string().min(1),
        schema: z.string().optional(),
        limit: z.number().int().positive().max(100).optional()
      }
    },
    safeTool("ob_sample_rows", async ({ profile, table, schema, limit }) => {
      const selected = selectRuntimeProfile(runtime, profile);
      const effectiveSchema = metadataSchema(selected.config, schema);
      assertTableAccess(effectiveSchema, table, policyContext(selected.config));
      const metadata = filterColumnMetadata(
        await describeTable(selected.pool, selected.config.compatibility, table, effectiveSchema, selected.config.queryTimeoutMs),
        selected.config.policy
      );
      const columns = columnNames(metadata).slice(0, 50);
      const sampleLimit = Math.min(limit ?? Math.min(selected.config.maxRows, 5), selected.config.maxRows, 100);
      const output = await sampleRows(
        selected.pool,
        selected.config.compatibility,
        effectiveSchema,
        table,
        columns,
        sampleLimit,
        selected.config.queryTimeoutMs
      );
      assertOutputAllowed(output, selected.config.policy);
      return toResult(maskOutput(output, selected.config));
    })
  );

  return server;
}

function policyContext(config: ObConfig) {
  return {
    compatibility: config.compatibility,
    defaultSchema: config.database,
    policy: config.policy
  };
}

function metadataSchema(config: ObConfig, schema: string | undefined): string | undefined {
  return schema ?? config.database ?? (config.policy.allowedSchemas.length === 1 ? config.policy.allowedSchemas[0] : undefined);
}

function columnNames(rows: unknown[]): string[] {
  const names: string[] = [];
  for (const row of rows) {
    const record = row as Record<string, unknown>;
    const value = record.column_name ?? record.COLUMN_NAME;
    if (typeof value === "string" && value.trim()) {
      names.push(value.trim());
    }
  }
  return [...new Set(names)];
}

function maskOutput(output: QueryOutput, config: ObConfig): QueryOutput {
  return {
    ...output,
    rows: output.rows.map((row) => {
      if (!row || typeof row !== "object" || Array.isArray(row)) {
        return row;
      }
      const masked: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(row)) {
        masked[key] = isDeniedColumn(key, config.policy) || SENSITIVE_SAMPLE_PATTERN.test(key) ? "***MASKED***" : value;
      }
      return masked;
    })
  };
}

function stringVariable(value: string | string[] | undefined): string {
  if (Array.isArray(value)) {
    return value[0] ?? "";
  }
  return value ?? "";
}

function resourceResult(uri: string, data: unknown) {
  return {
    contents: [
      {
        uri,
        mimeType: "application/json",
        text: jsonText(data)
      }
    ]
  };
}

function toResult(data: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: jsonText(data)
      }
    ]
  };
}

function toErrorResult(error: unknown) {
  return {
    isError: true,
    content: [
      {
        type: "text" as const,
        text: jsonText({
          ok: false,
          error: serializeError(error)
        })
      }
    ]
  };
}

function runExplainCheck(name: string, check: () => void) {
  try {
    check();
    return { name, ok: true, message: "Allowed." };
  } catch (error) {
    return { name, ok: false, message: (error as Error).message };
  }
}

function safeTool<Args>(name: string, handler: (args: Args) => Promise<ReturnType<typeof toResult>>) {
  return async (args: Args) => {
    const started = Date.now();
    const finish = metrics.startToolCall();
    try {
      const result = await handler(args);
      logAudit("tool_call", {
        ok: true,
        tool: name,
        durationMs: Date.now() - started,
        ...auditArgs(args)
      });
      return result;
    } catch (error) {
      metrics.recordToolBlocked();
      metrics.recordToolError();
      logAudit("tool_call", {
        ok: false,
        tool: name,
        durationMs: Date.now() - started,
        blockedReason: (error as Error).message,
        ...auditArgs(args)
      });
      logError(name, error);
      return toErrorResult(error);
    } finally {
      finish();
    }
  };
}

function auditArgs(args: unknown): Record<string, unknown> {
  if (!args || typeof args !== "object") {
    return {};
  }
  const record = args as Record<string, unknown>;
  const output: Record<string, unknown> = {};
  for (const key of ["profile", "schema", "table", "limit", "maxRows", "mask"]) {
    if (record[key] != null) {
      output[key] = record[key];
    }
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
