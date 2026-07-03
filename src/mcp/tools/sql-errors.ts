import { z } from "zod";

import { findColumns, searchCatalog } from "../../db.js";
import { explainSqlPolicy, filterColumnMetadata, isSchemaAllowed } from "../../policy.js";
import { queryShape } from "../../query/preview.js";
import { selectRuntimeProfile, withQuerySlot, type GatewayRuntime } from "../../runtime.js";
import { selectAuthorizedProfile } from "../access.js";
import type { McpRequestContext } from "../context.js";
import { metadataSchema } from "../metadata-scope.js";
import { policyContext } from "../policy-context.js";
import {
  catalogSearchResult,
  columnSearchRows,
  dedupeColumnSearchResults,
  dedupeSearchResults,
  tableCandidatesFromSearchResults
} from "../search-results.js";
import { profileInput } from "../schemas.js";
import { errorHints, toLimitedResult } from "../tool-runtime.js";
import type { ToolRegistrar } from "../tool-registry.js";

export function registerSqlErrorTools(
  registerTool: ToolRegistrar,
  runtime: GatewayRuntime,
  context: McpRequestContext
): void {
  registerTool(
    "ob_explain_error",
    {
      title: "Explain SQL Error",
      description: "Explain a SQL error with policy context and visible metadata hints without executing the SQL.",
      inputSchema: {
        ...profileInput,
        sql: z.string().min(1),
        errorMessage: z.string().min(1),
        schema: z.string().optional(),
        limit: z.number().int().positive().max(100).optional()
      }
    },
    async ({ profile, sql, errorMessage, schema, limit }) => {
      const selected = selectAuthorizedProfile(runtime, profile, context);
      const effectiveSchema = metadataSchema(selected.config, schema);
      if (effectiveSchema && !isSchemaAllowed(effectiveSchema, selected.config.policy)) {
        throw new Error(`Schema "${effectiveSchema}" is not allowed by the configured OceanBase MCP access policy.`);
      }
      const explanation = await explainSqlErrorWithMetadata(
        selected,
        sql,
        errorMessage,
        effectiveSchema,
        Math.min(limit ?? 20, 100)
      );
      return toLimitedResult(explanation, selected.config);
    }
  );
}

async function explainSqlErrorWithMetadata(
  selected: ReturnType<typeof selectRuntimeProfile>,
  sql: string,
  errorMessage: string,
  schema: string | undefined,
  limit: number
) {
  const classification = classifySqlError(errorMessage);
  const policy = explainSqlPolicy(sql, policyContext(selected.config));
  const shape = queryShape(sql, selected.config.compatibility);
  const baseHints = errorHints(new Error(errorMessage), { sql });
  const candidates = await errorMetadataCandidates(selected, classification, errorMessage, schema, limit);
  return {
    sql,
    errorClass: classification.kind,
    extractedTerm: classification.term ?? null,
    hints: baseHints,
    policy,
    shape,
    candidates,
    warnings: candidates.truncated ? ["Metadata candidates were truncated by the requested limit."] : [],
    executed: false
  };
}

function classifySqlError(errorMessage: string): { kind: string; term?: string } {
  const lower = errorMessage.toLowerCase();
  const column =
    /unknown column ['"`]?([^'"`\s]+)['"`]?/i.exec(errorMessage)?.[1] ??
    /invalid identifier[^'"`]*['"`]([^'"`]+)['"`]/i.exec(errorMessage)?.[1] ??
    /ora-00904:\s*["']?([^"'\s]+)["']?/i.exec(errorMessage)?.[1];
  if (column || /unknown column|invalid identifier|ora-00904|1054/.test(lower)) {
    return { kind: "unknown_column", term: column };
  }
  const table =
    /ora-00942:\s*["']?([^"'\s:]+)["']?/i.exec(errorMessage)?.[1] ??
    /table ['"`]?([^'"`\s]+)['"`]?.*(?:doesn't exist|not exist|unknown)/i.exec(errorMessage)?.[1] ??
    /unknown table ['"`]?([^'"`\s]+)['"`]?/i.exec(errorMessage)?.[1] ??
    /(?:table|view) ['"`]?([^'"`\s]+)['"`]? does not exist/i.exec(errorMessage)?.[1];
  if (table || /unknown table|table .*doesn't exist|ora-00942|1146/.test(lower)) {
    return { kind: "unknown_table", term: table };
  }
  if (/not allowed|blocked|select \*|ob_denied_columns|policy/i.test(errorMessage)) {
    return { kind: "policy" };
  }
  if (/limit|offset|fetch|rownum|syntax|ora-00933|1064/i.test(errorMessage)) {
    return { kind: "dialect_or_pagination" };
  }
  if (/permission|privilege|access denied|ora-01031|1044|1142/i.test(errorMessage)) {
    return { kind: "permission" };
  }
  return { kind: "unknown" };
}

async function errorMetadataCandidates(
  selected: ReturnType<typeof selectRuntimeProfile>,
  classification: { kind: string; term?: string },
  errorMessage: string,
  schema: string | undefined,
  limit: number
) {
  const term = classification.term ?? fallbackErrorSearchTerm(errorMessage);
  if (!term) {
    return { columns: [], tables: [], truncated: false };
  }
  if (classification.kind === "unknown_column") {
    const rows = filterColumnMetadata(
      await withQuerySlot(selected, () =>
        findColumns(
          selected.pool,
          selected.config.compatibility,
          { query: term, schema },
          limit,
          selected.config.queryTimeoutMs
        )
      ),
      selected.config.policy
    );
    const columns = dedupeColumnSearchResults(rows.flatMap((row) =>
      columnSearchRows(row, term, undefined, selected.config)
    )).slice(0, limit);
    return { columns, tables: [], truncated: rows.length >= limit };
  }
  if (classification.kind === "unknown_table") {
    const rows = filterColumnMetadata(
      await withQuerySlot(selected, () =>
        searchCatalog(
          selected.pool,
          selected.config.compatibility,
          term,
          schema,
          limit,
          selected.config.queryTimeoutMs
        )
      ),
      selected.config.policy
    );
    const searchResults = dedupeSearchResults(rows.flatMap((row) =>
      catalogSearchResult(row, term, selected.config)
    ));
    return {
      columns: [],
      tables: tableCandidatesFromSearchResults(searchResults, selected.config, limit),
      truncated: rows.length >= limit
    };
  }
  return { columns: [], tables: [], truncated: false };
}

function fallbackErrorSearchTerm(errorMessage: string): string | undefined {
  return /['"`]([A-Za-z_][\w$]*)['"`]/.exec(errorMessage)?.[1];
}
