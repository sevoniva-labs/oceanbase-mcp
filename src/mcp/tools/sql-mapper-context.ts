import { z } from "zod";

import type { ObConfig } from "../../config.js";
import {
  describeTable,
  listConstraints,
  listIndexes
} from "../../db.js";
import {
  assertTableAccess,
  explainSqlPolicy,
  filterColumnMetadata
} from "../../policy.js";
import { markdownCell } from "../../query/output.js";
import { withQuerySlot, type GatewayRuntime } from "../../runtime.js";
import { selectAuthorizedProfile } from "../access.js";
import type { McpRequestContext } from "../context.js";
import {
  mapperConstraintSummary,
  mapperIndexSummary
} from "../metadata-summary.js";
import { policyContext } from "../policy-context.js";
import { profileInput } from "../schemas.js";
import { toLimitedResult } from "../tool-runtime.js";
import type { ToolRegistrar } from "../tool-registry.js";
import {
  compactSchemaColumns,
  schemaMapPrimaryKeyColumns,
  uniqueKeyGroups
} from "./schema-map.js";
import { normalizedSnippetTableRef } from "./sql-snippet-metadata.js";
import {
  resolveProjectQuerySource,
  type ProjectQuerySource
} from "./sql-snippet-source.js";

export function registerSqlMapperContextTools(
  registerTool: ToolRegistrar,
  runtime: GatewayRuntime,
  context: McpRequestContext
): void {
  registerTool(
    "ob_generate_mapper_context",
    {
      title: "Generate Mapper Context",
      description: "Generate read-only table and column context for a MyBatis mapper, SQL file, or explicit table.",
      inputSchema: {
        ...profileInput,
        schema: z.string().optional(),
        table: z.string().optional(),
        sql: z.string().min(1).optional(),
        filePath: z.string().min(1).optional(),
        line: z.number().int().positive().optional(),
        format: z.enum(["json", "markdown"]).optional().default("json"),
        maxTables: z.number().int().positive().max(10).optional(),
        maxColumns: z.number().int().positive().max(200).optional()
      }
    },
    async ({ profile, schema, table, sql, filePath, line, format = "json", maxTables, maxColumns }) => {
      const selected = selectAuthorizedProfile(runtime, profile, context);
      const source = sql || filePath ? resolveProjectQuerySource(sql, filePath, line) : undefined;
      const policy = source ? explainSqlPolicy(source.sql, policyContext(selected.config)) : undefined;
      const maxTableCount = Math.min(maxTables ?? 5, 10);
      const allTableRefs = mapperContextTableRefs(
        selected.config,
        schema,
        table,
        policy?.tableRefs ?? [],
        50
      );
      const tableRefs = allTableRefs.slice(0, maxTableCount);
      if (tableRefs.length === 0) {
        throw new Error("Pass table, sql, or filePath so mapper context can identify at least one table.");
      }
      const tables = [];
      for (const ref of tableRefs) {
        tables.push(await buildMapperContextTable(selected, ref.schema, ref.table, Math.min(maxColumns ?? 80, 200)));
      }
      const payload = {
        mode: selected.config.compatibility,
        source: source?.source,
        sql: source?.sql,
        policy,
        tableCount: tables.length,
        tables,
        warnings: uniqueStrings([
          ...(source?.source.warnings ?? []),
          ...(allTableRefs.length > tableRefs.length ? ["Table list is capped by maxTables."] : [])
        ]),
        markdown: undefined as string | undefined
      };
      if (format === "markdown") {
        payload.markdown = renderMapperContextMarkdown(payload);
      }
      return toLimitedResult(payload, selected.config);
    }
  );
}

function mapperContextTableRefs(
  config: ObConfig,
  schema: string | undefined,
  table: string | undefined,
  sqlRefs: Array<{ schema?: string; table: string }>,
  maxTables: number
): Array<{ schema?: string; table: string }> {
  const refs: Array<{ schema?: string; table: string }> = [];
  if (table?.trim()) {
    refs.push(normalizedSnippetTableRef(config, schema, table));
  }
  for (const ref of sqlRefs) {
    refs.push(normalizedSnippetTableRef(config, ref.schema ?? schema, ref.table));
  }
  return uniqueTableRefs(refs).slice(0, maxTables);
}

async function buildMapperContextTable(
  selected: ReturnType<typeof selectAuthorizedProfile>,
  schema: string | undefined,
  table: string,
  maxColumns: number
) {
  const metadataRef = normalizedSnippetTableRef(selected.config, schema, table);
  assertTableAccess(metadataRef.schema, metadataRef.table, policyContext(selected.config));
  const columns = filterColumnMetadata(
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
  const constraints = filterColumnMetadata(
    await withQuerySlot(selected, () =>
      listConstraints(
        selected.pool,
        selected.config.compatibility,
        metadataRef.table,
        metadataRef.schema,
        selected.config.queryTimeoutMs
      )
    ),
    selected.config.policy
  );
  const indexes = filterColumnMetadata(
    await withQuerySlot(selected, () =>
      listIndexes(
        selected.pool,
        selected.config.compatibility,
        metadataRef.table,
        metadataRef.schema,
        selected.config.queryTimeoutMs
      )
    ),
    selected.config.policy
  );
  const compactColumns = compactSchemaColumns(columns, constraints, selected.config, metadataRef.schema, metadataRef.table);
  const columnLimit = Math.max(1, Math.min(maxColumns, 200));
  return {
    schema: metadataRef.schema,
    table: metadataRef.table,
    visibleColumnCount: compactColumns.length,
    columnsTruncated: compactColumns.length > columnLimit,
    columns: compactColumns.slice(0, columnLimit),
    primaryKeys: schemaMapPrimaryKeyColumns(constraints),
    uniqueKeys: uniqueKeyGroups(constraints),
    indexes: mapperIndexSummary(indexes),
    constraints: mapperConstraintSummary(constraints),
    notes: mapperContextNotes(compactColumns)
  };
}

function mapperContextNotes(columns: Array<{ name: string; roles: string[]; masked: boolean }>): string[] {
  const notes: string[] = [];
  const maskedColumns = columns.filter((column) => column.masked).map((column) => column.name);
  const timeColumns = columns.filter((column) => column.roles.includes("time")).map((column) => column.name);
  const statusColumns = columns.filter((column) => column.roles.includes("status")).map((column) => column.name);
  if (maskedColumns.length > 0) {
    notes.push(`Masked columns: ${maskedColumns.slice(0, 10).join(", ")}.`);
  }
  if (timeColumns.length > 0) {
    notes.push(`Likely time columns: ${timeColumns.slice(0, 10).join(", ")}.`);
  }
  if (statusColumns.length > 0) {
    notes.push(`Likely dimension/status columns: ${statusColumns.slice(0, 10).join(", ")}.`);
  }
  return notes;
}

function renderMapperContextMarkdown(payload: {
  mode: ObConfig["compatibility"];
  source?: ProjectQuerySource;
  sql?: string;
  tableCount: number;
  tables: Array<Awaited<ReturnType<typeof buildMapperContextTable>>>;
  warnings: string[];
}): string {
  const lines = ["# OceanBase Mapper Context", "", `Mode: ${payload.mode}`, `Tables: ${payload.tableCount}`, ""];
  if (payload.source?.type === "file") {
    lines.push(`Source: ${payload.source.file}:${payload.source.line}`, "");
  }
  if (payload.sql) {
    lines.push("```sql", payload.sql, "```", "");
  }
  for (const table of payload.tables) {
    const title = `${table.schema ? `${table.schema}.` : ""}${table.table}`;
    lines.push(`## ${title}`, "");
    if (table.primaryKeys.length > 0) {
      lines.push(`Primary key: ${table.primaryKeys.join(", ")}`, "");
    }
    if (table.indexes.length > 0) {
      lines.push(`Indexes: ${table.indexes.map((index) => `${index.name}(${index.columns.join(", ")})`).join("; ")}`, "");
    }
    lines.push("| Column | Type | Nullable | Roles | Masked | Comment |");
    lines.push("| --- | --- | --- | --- | --- | --- |");
    for (const column of table.columns) {
      lines.push([
        markdownCell(column.name),
        markdownCell(column.type ?? ""),
        column.nullable == null ? "" : column.nullable ? "YES" : "NO",
        markdownCell(column.roles.join(", ")),
        column.masked ? "YES" : "NO",
        markdownCell(column.comment ?? "")
      ].join(" | ").replace(/^/, "| ").replace(/$/, " |"));
    }
    if (table.columnsTruncated) {
      lines.push("", `More columns exist for ${title}; output was truncated by maxColumns.`);
    }
    for (const note of table.notes) {
      lines.push("", `Note: ${note}`);
    }
    lines.push("");
  }
  if (payload.warnings.length > 0) {
    lines.push("## Warnings", "");
    lines.push(...payload.warnings.map((warning) => `- ${warning}`));
    lines.push("");
  }
  return lines.join("\n");
}

function uniqueTableRefs(refs: Array<{ schema?: string; table: string }>): Array<{ schema?: string; table: string }> {
  const output: Array<{ schema?: string; table: string }> = [];
  const seen = new Set<string>();
  for (const ref of refs) {
    const key = `${ref.schema ?? ""}.${ref.table}`.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    output.push(ref);
  }
  return output;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}
