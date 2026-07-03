import { z } from "zod";

import {
  describeTable,
  listTables
} from "../../db.js";
import {
  assertTableAccess,
  explainSqlPolicy,
  filterColumnMetadata,
  filterTables,
  isSchemaAllowed
} from "../../policy.js";
import { effectiveRowLimit } from "../../query/output.js";
import { withQuerySlot, type GatewayRuntime } from "../../runtime.js";
import { selectAuthorizedProfile } from "../access.js";
import type { McpRequestContext } from "../context.js";
import { metadataSchema } from "../metadata-scope.js";
import { policyContext } from "../policy-context.js";
import { profileInput } from "../schemas.js";
import { toLimitedResult } from "../tool-runtime.js";
import type { ToolRegistrar } from "../tool-registry.js";
import {
  profileColumnMetadata,
  stringRecordValue
} from "./profile-utils.js";
import { lintReadOnlySql } from "./sql-lint.js";
import {
  normalizedSnippetTableRef,
  validateSnippetMetadata
} from "./sql-snippet-metadata.js";
import { resolveProjectQuerySource } from "./sql-snippet-source.js";

export function registerSqlUnknownColumnTools(
  registerTool: ToolRegistrar,
  runtime: GatewayRuntime,
  context: McpRequestContext
): void {
  registerTool(
    "ob_find_unknown_columns_in_sql",
    {
      title: "Find Unknown Columns In SQL",
      description: "Find unknown tables or columns in SQL and return visible metadata-based candidates without executing the SQL.",
      inputSchema: {
        ...profileInput,
        sql: z.string().min(1).optional(),
        filePath: z.string().min(1).optional(),
        line: z.number().int().positive().optional(),
        schema: z.string().optional(),
        maxCandidates: z.number().int().positive().max(20).optional()
      }
    },
    async ({ profile, sql, filePath, line, schema, maxCandidates }) => {
      const selected = selectAuthorizedProfile(runtime, profile, context);
      const source = resolveProjectQuerySource(sql, filePath, line);
      const candidateLimit = Math.min(maxCandidates ?? 5, 20);
      const lint = await lintReadOnlySql(selected, source.sql, [], effectiveRowLimit(undefined, selected.config), false);
      const policy = explainSqlPolicy(source.sql, policyContext(selected.config));
      const metadata = await validateSnippetMetadata(selected, source.sql, policy.tableRefs, metadataSchema(selected.config, schema));
      const tableIssues = [];
      for (const table of metadata.tables.filter((item) => !item.visible)) {
        tableIssues.push({
          schema: table.schema,
          table: table.table,
          error: table.error,
          candidates: await findUnknownTableCandidates(selected, table.schema, table.table, candidateLimit)
        });
      }
      const columnIssues = [];
      for (const table of metadata.tables.filter((item) => item.visible && item.unknownColumns.length > 0)) {
        for (const column of table.unknownColumns.slice(0, 20)) {
          columnIssues.push({
            schema: table.schema,
            table: table.table,
            column,
            candidates: await findUnknownColumnCandidates(selected, table.schema, table.table, column, candidateLimit)
          });
        }
      }
      return toLimitedResult(
        {
          source: source.source,
          sql: source.sql,
          executed: false,
          lint,
          metadata,
          unknownTableCount: tableIssues.length,
          unknownColumnCount: columnIssues.length,
          tableIssues,
          columnIssues,
          warnings: uniqueStrings([
            ...(source.source.warnings ?? []),
            "Candidates are based on visible metadata only."
          ])
        },
        selected.config
      );
    }
  );
}

async function findUnknownTableCandidates(
  selected: ReturnType<typeof selectAuthorizedProfile>,
  schema: string | undefined,
  table: string,
  limit: number
): Promise<Array<{ schema?: string; table: string; score: number; evidence: string[] }>> {
  const effectiveSchema = metadataSchema(selected.config, schema);
  if (effectiveSchema && !isSchemaAllowed(effectiveSchema, selected.config.policy)) {
    return [];
  }
  const rows = filterTables(
    await withQuerySlot(selected, () =>
      listTables(
        selected.pool,
        selected.config.compatibility,
        effectiveSchema,
        500,
        selected.config.queryTimeoutMs
      )
    ),
    selected.config.policy
  );
  return rows
    .map((row) => tableRefFromMetadata(row, effectiveSchema))
    .filter((ref): ref is { schema?: string; table: string } => Boolean(ref))
    .map((ref) => ({
      schema: ref.schema,
      table: ref.table,
      score: similarityScore(table, ref.table),
      evidence: similarityEvidence(table, ref.table)
    }))
    .filter((candidate) => candidate.score >= 0.25)
    .sort((left, right) => right.score - left.score || left.table.localeCompare(right.table))
    .slice(0, limit);
}

async function findUnknownColumnCandidates(
  selected: ReturnType<typeof selectAuthorizedProfile>,
  schema: string | undefined,
  table: string,
  column: string,
  limit: number
): Promise<Array<{ schema?: string; table: string; column: string; type?: string; score: number; evidence: string[] }>> {
  try {
    const metadataRef = normalizedSnippetTableRef(selected.config, schema, table);
    assertTableAccess(metadataRef.schema, metadataRef.table, policyContext(selected.config));
    const rows = filterColumnMetadata(
      await withQuerySlot(selected, () =>
        describeTable(
          selected.pool,
          selected.config.compatibility,
          metadataRef.table,
          metadataRef.schema,
          selected.config.queryTimeoutMs
        )
      ),
      selected.config.policy
    );
    return rows
      .map((row) => profileColumnMetadata(row, selected.config.compatibility))
      .filter((item): item is { name: string; dataType?: string; nullable?: boolean; comment?: string } => Boolean(item))
      .map((item) => ({
        schema: metadataRef.schema,
        table: metadataRef.table,
        column: item.name,
        type: item.dataType,
        score: similarityScore(column, item.name),
        evidence: similarityEvidence(column, item.name)
      }))
      .filter((candidate) => candidate.score >= 0.25)
      .sort((left, right) => right.score - left.score || left.column.localeCompare(right.column))
      .slice(0, limit);
  } catch {
    return [];
  }
}

function tableRefFromMetadata(
  row: unknown,
  fallbackSchema: string | undefined
): { schema?: string; table: string } | undefined {
  const record = row as Record<string, unknown>;
  const table = stringRecordValue(record, "table_name", "TABLE_NAME");
  if (!table) {
    return undefined;
  }
  return {
    schema:
      stringRecordValue(record, "table_schema", "TABLE_SCHEMA", "owner", "OWNER", "table_owner", "TABLE_OWNER") ??
      fallbackSchema,
    table
  };
}

function similarityScore(left: string, right: string): number {
  const a = normalizeSimilarityText(left);
  const b = normalizeSimilarityText(right);
  if (!a || !b) {
    return 0;
  }
  if (a === b) {
    return 1;
  }
  if (a.includes(b) || b.includes(a)) {
    return 0.86;
  }
  const distance = levenshteinDistance(a, b);
  const ratio = 1 - distance / Math.max(a.length, b.length);
  const prefix = commonPrefixLength(a, b) / Math.max(a.length, b.length);
  return Number(Math.max(ratio, prefix * 0.9).toFixed(3));
}

function similarityEvidence(left: string, right: string): string[] {
  const a = normalizeSimilarityText(left);
  const b = normalizeSimilarityText(right);
  const evidence = [];
  if (a === b) {
    evidence.push("normalized_exact_match");
  }
  if (a.includes(b) || b.includes(a)) {
    evidence.push("substring_match");
  }
  if (commonPrefixLength(a, b) >= 3) {
    evidence.push("common_prefix");
  }
  if (levenshteinDistance(a, b) <= 2) {
    evidence.push("edit_distance_le_2");
  }
  return evidence.length > 0 ? evidence : ["name_similarity"];
}

function normalizeSimilarityText(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]/g, "");
}

function commonPrefixLength(left: string, right: string): number {
  let index = 0;
  while (index < left.length && index < right.length && left[index] === right[index]) {
    index += 1;
  }
  return index;
}

function levenshteinDistance(left: string, right: string): number {
  const previous = Array.from({ length: right.length + 1 }, (_value, index) => index);
  for (let i = 0; i < left.length; i += 1) {
    const current = [i + 1];
    for (let j = 0; j < right.length; j += 1) {
      const cost = left[i] === right[j] ? 0 : 1;
      current[j + 1] = Math.min(
        current[j] + 1,
        previous[j + 1] + 1,
        previous[j] + cost
      );
    }
    previous.splice(0, previous.length, ...current);
  }
  return previous[right.length] ?? 0;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}
