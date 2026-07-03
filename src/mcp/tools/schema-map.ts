import { z } from "zod";

import type { ObConfig } from "../../config.js";
import {
  describeTable,
  findRelatedTables,
  listConstraints,
  listSchemaMapTables,
  type SchemaMapTable,
  type TableRelationship
} from "../../db.js";
import {
  assertTableAccess,
  filterColumnMetadata,
  isDeniedColumn,
  isSchemaAllowed
} from "../../policy.js";
import { markdownCell, shouldMaskColumnValue } from "../../query/output.js";
import { selectRuntimeProfile, withMetadataCache, withQuerySlot, type GatewayRuntime } from "../../runtime.js";
import { selectAuthorizedProfile } from "../access.js";
import type { McpRequestContext } from "../context.js";
import { metadataSchema } from "../metadata-scope.js";
import { policyContext } from "../policy-context.js";
import { dataDictionaryFormatSchema, profileInput } from "../schemas.js";
import { toLimitedResult } from "../tool-runtime.js";
import type { ToolRegistrar } from "../tool-registry.js";

export function registerSchemaMapTools(
  registerTool: ToolRegistrar,
  runtime: GatewayRuntime,
  context: McpRequestContext
): void {
  registerTool(
    "ob_get_schema_map",
    {
      title: "Get Schema Map",
      description: "Return a compact, policy-filtered schema map with table summaries, key fields, and relationship hints.",
      inputSchema: {
        ...profileInput,
        schema: z.string().optional(),
        tablePattern: z.string().optional(),
        maxTables: z.number().int().positive().max(500).optional(),
        includeColumns: z.boolean().optional().default(true),
        includeRelationships: z.boolean().optional().default(true),
        maxColumnsPerTable: z.number().int().positive().max(100).optional(),
        relationshipLimit: z.number().int().positive().max(100).optional()
      }
    },
    async ({
      profile,
      schema,
      tablePattern,
      maxTables,
      includeColumns = true,
      includeRelationships = true,
      maxColumnsPerTable,
      relationshipLimit
    }) => {
      const selected = selectAuthorizedProfile(runtime, profile, context);
      const effectiveSchema = metadataSchema(selected.config, schema);
      if (effectiveSchema && !isSchemaAllowed(effectiveSchema, selected.config.policy)) {
        throw new Error(`Schema "${effectiveSchema}" is not allowed by the configured OceanBase MCP access policy.`);
      }
      const tableLimit = Math.min(maxTables ?? 30, 500);
      const rawTables = await cachedSchemaMapTables(selected, effectiveSchema, tablePattern, tableLimit + 1);
      const visibleTables = filterSchemaMapTables(rawTables, selected.config).slice(0, tableLimit);
      const summaries = [];

      for (const tableInfo of visibleTables) {
        const summary = await buildSchemaMapTableSummary(
          selected,
          tableInfo,
          includeColumns,
          maxColumnsPerTable ?? 12,
          includeRelationships,
          relationshipLimit ?? 12
        );
        summaries.push(summary);
      }

      return toLimitedResult(
        {
          mode: selected.config.compatibility,
          schema: effectiveSchema,
          tablePattern: tablePattern ?? null,
          maxTables: tableLimit,
          includeColumns,
          includeRelationships,
          truncated: rawTables.length > tableLimit,
          tableCount: summaries.length,
          schemas: groupSchemaMapTables(selected.config.compatibility, summaries),
          warnings: rawTables.length > tableLimit
            ? [`Only the first ${tableLimit} visible tables are returned. Narrow schema or tablePattern for a smaller map.`]
            : []
        },
        selected.config
      );
    }
  );

  registerTool(
    "ob_get_database_dictionary",
    {
      title: "Get Database Dictionary",
      description: "Generate a bounded JSON or Markdown data dictionary from visible table and column metadata.",
      inputSchema: {
        ...profileInput,
        schema: z.string().optional(),
        tablePattern: z.string().optional(),
        format: z.enum(["json", "markdown"]).optional().default("json"),
        maxTables: z.number().int().positive().max(500).optional(),
        maxColumnsPerTable: z.number().int().positive().max(100).optional()
      }
    },
    async ({ profile, schema, tablePattern, format = "json", maxTables, maxColumnsPerTable }) => {
      const selected = selectAuthorizedProfile(runtime, profile, context);
      const effectiveSchema = metadataSchema(selected.config, schema);
      if (effectiveSchema && !isSchemaAllowed(effectiveSchema, selected.config.policy)) {
        throw new Error(`Schema "${effectiveSchema}" is not allowed by the configured OceanBase MCP access policy.`);
      }
      const tableLimit = Math.min(maxTables ?? 30, 200);
      const columnLimit = Math.min(maxColumnsPerTable ?? 50, 100);
      const rawTables = await cachedSchemaMapTables(selected, effectiveSchema, tablePattern, tableLimit + 1);
      const visibleTables = filterSchemaMapTables(rawTables, selected.config).slice(0, tableLimit);
      const dictionary = await buildDatabaseDictionary(selected, visibleTables, columnLimit);
      const warnings = [];
      if (rawTables.length > tableLimit) {
        warnings.push(`Only the first ${tableLimit} visible tables are included. Narrow schema or tablePattern for a smaller dictionary.`);
      }
      if (dictionary.tables.some((table) => table.columnsTruncated)) {
        warnings.push(`Some tables have more than ${columnLimit} visible columns; columns were truncated.`);
      }
      const output = {
        format,
        mode: selected.config.compatibility,
        schema: effectiveSchema ?? null,
        tablePattern: tablePattern ?? null,
        tableCount: dictionary.tables.length,
        dictionary,
        markdown: format === "markdown" ? renderDatabaseDictionaryMarkdown(dictionary) : undefined,
        warnings
      };
      return toLimitedResult(output, selected.config);
    }
  );

  registerTool(
    "ob_find_related_tables",
    {
      title: "Find Related Tables",
      description: "Find foreign-key and conservative naming-based relationships for an allowed OceanBase table.",
      inputSchema: {
        ...profileInput,
        table: z.string().min(1),
        schema: z.string().optional(),
        depth: z.number().int().min(1).max(3).optional(),
        limit: z.number().int().positive().max(500).optional()
      }
    },
    async ({ profile, table, schema, depth, limit }) => {
      const selected = selectAuthorizedProfile(runtime, profile, context);
      const effectiveSchema = metadataSchema(selected.config, schema);
      assertTableAccess(effectiveSchema, table, policyContext(selected.config));
      const maxRelations = Math.min(limit ?? 50, 500);
      const result = await withQuerySlot(selected, () =>
        findRelatedTables(
          selected.pool,
          selected.config.compatibility,
          table,
          effectiveSchema,
          depth ?? 1,
          maxRelations,
          selected.config.queryTimeoutMs
        )
      );
      const relations = result.relations.filter((relation) => isRelationshipAllowed(relation, selected.config));
      return toLimitedResult(
        {
          ...result,
          relations,
          policyFiltered: relations.length !== result.relations.length
        },
        selected.config
      );
    }
  );

  registerTool(
    "ob_generate_data_dictionary",
    {
      title: "Generate Data Dictionary",
      description: "Generate bounded JSON, Markdown, or simple HTML data dictionary output from visible metadata.",
      inputSchema: {
        ...profileInput,
        schema: z.string().optional(),
        tablePattern: z.string().optional(),
        format: dataDictionaryFormatSchema.optional().default("markdown"),
        maxTables: z.number().int().positive().max(500).optional(),
        maxColumnsPerTable: z.number().int().positive().max(100).optional(),
        title: z.string().min(1).max(120).optional()
      }
    },
    async ({ profile, schema, tablePattern, format = "markdown", maxTables, maxColumnsPerTable, title }) => {
      const selected = selectAuthorizedProfile(runtime, profile, context);
      const effectiveSchema = metadataSchema(selected.config, schema);
      if (effectiveSchema && !isSchemaAllowed(effectiveSchema, selected.config.policy)) {
        throw new Error(`Schema "${effectiveSchema}" is not allowed by the configured OceanBase MCP access policy.`);
      }
      const tableLimit = Math.min(maxTables ?? 30, 200);
      const columnLimit = Math.min(maxColumnsPerTable ?? 50, 100);
      const rawTables = await cachedSchemaMapTables(selected, effectiveSchema, tablePattern, tableLimit + 1);
      const visibleTables = filterSchemaMapTables(rawTables, selected.config).slice(0, tableLimit);
      const dictionary = await buildDatabaseDictionary(selected, visibleTables, columnLimit);
      const warnings = uniqueStrings([
        rawTables.length > tableLimit ? `Only the first ${tableLimit} visible tables are included. Narrow schema or tablePattern for a smaller dictionary.` : "",
        dictionary.tables.some((table) => table.columnsTruncated) ? `Some tables have more than ${columnLimit} visible columns; columns were truncated.` : "",
        "Data dictionary output is based on metadata visible to the active MCP policy.",
        "No sample data values are included."
      ]);
      return toLimitedResult(
        {
          format,
          mode: selected.config.compatibility,
          schema: effectiveSchema ?? null,
          tablePattern: tablePattern ?? null,
          tableCount: dictionary.tables.length,
          dictionary,
          markdown: format === "markdown" ? renderDatabaseDictionaryMarkdown(dictionary) : undefined,
          html: format === "html" ? renderDataDictionaryHtml(dictionary, title) : undefined,
          contentType: format === "html" ? "text/html" : undefined,
          warnings,
          executed: false
        },
        selected.config
      );
    }
  );
}

export function filterSchemaMapTables(rows: SchemaMapTable[], config: ObConfig): SchemaMapTable[] {
  return rows.filter((table) => {
    try {
      assertTableAccess(table.schema, table.table, policyContext(config));
      return true;
    } catch {
      return false;
    }
  });
}

export async function cachedSchemaMapTables(
  selected: ReturnType<typeof selectRuntimeProfile>,
  schema: string | undefined,
  tablePattern: string | undefined,
  limit: number
): Promise<SchemaMapTable[]> {
  return withMetadataCache(selected, "schema_map_tables", [selected.config.compatibility, schema ?? "", tablePattern ?? "", limit], () =>
    withQuerySlot(selected, () =>
      listSchemaMapTables(
        selected.pool,
        selected.config.compatibility,
        schema,
        tablePattern,
        limit,
        selected.config.queryTimeoutMs
      )
    )
  );
}

export async function findSchemaMapTableInfo(
  selected: ReturnType<typeof selectRuntimeProfile>,
  schema: string | undefined,
  table: string
): Promise<SchemaMapTable | undefined> {
  const rows = filterSchemaMapTables(
    await cachedSchemaMapTables(selected, schema, table, 20),
    selected.config
  );
  return rows.find((row) => normalizeTableName(selected.config.compatibility, row.table) === normalizeTableName(selected.config.compatibility, table));
}

export async function cachedDescribeTable(
  selected: ReturnType<typeof selectRuntimeProfile>,
  schema: string | undefined,
  table: string
): Promise<unknown[]> {
  return withMetadataCache(selected, "describe_table", [selected.config.compatibility, schema ?? "", table], () =>
    withQuerySlot(selected, () =>
      describeTable(selected.pool, selected.config.compatibility, table, schema, selected.config.queryTimeoutMs)
    )
  );
}

export async function cachedListConstraints(
  selected: ReturnType<typeof selectRuntimeProfile>,
  schema: string | undefined,
  table: string
): Promise<unknown[]> {
  return withMetadataCache(selected, "list_constraints", [selected.config.compatibility, schema ?? "", table], () =>
    withQuerySlot(selected, () =>
      listConstraints(selected.pool, selected.config.compatibility, table, schema, selected.config.queryTimeoutMs)
    )
  );
}

export async function cachedRelatedTables(
  selected: ReturnType<typeof selectRuntimeProfile>,
  schema: string | undefined,
  table: string,
  depth: number,
  limit: number
) {
  return withMetadataCache(selected, "related_tables", [selected.config.compatibility, schema ?? "", table, depth, limit], () =>
    withQuerySlot(selected, () =>
      findRelatedTables(
        selected.pool,
        selected.config.compatibility,
        table,
        schema,
        depth,
        limit,
        selected.config.queryTimeoutMs
      )
    )
  );
}

export async function buildSchemaMapTableSummary(
  selected: ReturnType<typeof selectRuntimeProfile>,
  tableInfo: SchemaMapTable,
  includeColumns: boolean,
  maxColumnsPerTable: number,
  includeRelationships: boolean,
  relationshipLimit: number
) {
  const schema = metadataSchema(selected.config, tableInfo.schema);
  const table = tableInfo.table;
  assertTableAccess(schema, table, policyContext(selected.config));
  const columns = filterColumnMetadata(
    await cachedDescribeTable(selected, schema, table),
    selected.config.policy
  );
  const constraints = filterColumnMetadata(
    await cachedListConstraints(selected, schema, table),
    selected.config.policy
  );
  const compactColumns = compactSchemaColumns(columns, constraints, selected.config, schema, table);
  const primaryKeys = schemaMapPrimaryKeyColumns(constraints);
  const uniqueKeys = uniqueKeyGroups(constraints);
  const timeFields = compactColumns.filter((column) => column.roles.includes("time")).map((column) => column.name);
  const statusFields = compactColumns.filter((column) => column.roles.includes("status")).map((column) => column.name);
  const keyFields = importantSchemaMapFields(compactColumns, primaryKeys, timeFields, statusFields);
  const relationSummary = includeRelationships
    ? await buildSchemaMapRelationshipSummary(selected, schema, table, relationshipLimit)
    : undefined;

  return {
    schema,
    table,
    tableType: tableInfo.tableType,
    engine: tableInfo.engine,
    comment: tableInfo.comment,
    rowEstimate: tableInfo.rowEstimate,
    primaryKeys,
    uniqueKeys,
    keyFields,
    timeFields,
    statusFields,
    columns: includeColumns ? compactColumns.slice(0, Math.max(1, Math.min(maxColumnsPerTable, 100))) : undefined,
    columnsTruncated: includeColumns && compactColumns.length > Math.max(1, Math.min(maxColumnsPerTable, 100)),
    relationSummary
  };
}

export async function buildSchemaMapRelationshipSummary(
  selected: ReturnType<typeof selectRuntimeProfile>,
  schema: string | undefined,
  table: string,
  relationshipLimit: number
) {
  const result = await cachedRelatedTables(selected, schema, table, 1, Math.max(1, Math.min(relationshipLimit, 100)));
  const relations = result.relations.filter((relation) => isRelationshipAllowed(relation, selected.config));
  const outbound = relations.filter((relation) => relation.direction === "outbound").length;
  const inbound = relations.filter((relation) => relation.direction === "inbound").length;
  const inferred = relations.filter((relation) => relation.relationType === "name_inference").length;

  return {
    outbound,
    inbound,
    inferred,
    policyFiltered: relations.length !== result.relations.length,
    truncated: result.truncated,
    relations: relations.slice(0, Math.max(1, Math.min(relationshipLimit, 100))).map((relation) => ({
      relationType: relation.relationType,
      direction: relation.direction,
      confidence: relation.confidence,
      sourceSchema: relation.sourceSchema,
      sourceTable: relation.sourceTable,
      sourceColumns: relation.sourceColumns,
      targetSchema: relation.targetSchema,
      targetTable: relation.targetTable,
      targetColumns: relation.targetColumns,
      evidence: relation.evidence.map((item) => ({
        type: item.type,
        detail: item.detail,
        columns: item.columns
      }))
    }))
  };
}

export function compactSchemaColumns(
  rows: unknown[],
  constraints: unknown[],
  config: ObConfig,
  schema: string | undefined,
  table: string
): Array<{
  name: string;
  type?: string;
  nullable?: boolean;
  comment?: string;
  roles: string[];
  masked: boolean;
}> {
  const primaryKeys = new Set(schemaMapPrimaryKeyColumns(constraints).map((column) => normalizeTableName(config.compatibility, column)));
  return rows
    .map((row) => profileColumnMetadata(row, config.compatibility))
    .filter((column): column is { name: string; dataType?: string; nullable?: boolean; comment?: string } => Boolean(column))
    .map((column) => {
      const normalized = normalizeTableName(config.compatibility, column.name);
      const roles = schemaColumnRoles(column.name, primaryKeys.has(normalized));
      return {
        name: column.name,
        type: column.dataType,
        nullable: column.nullable,
        comment: column.comment,
        roles,
        masked: shouldMaskColumnValue(column.name, config, schema, table)
      };
    });
}

export function schemaMapPrimaryKeyColumns(constraints: unknown[]): string[] {
  return uniqueStrings(
    constraints
      .map((row) => {
        const record = row as Record<string, unknown>;
        const type = stringRecordValue(record, "constraint_type", "CONSTRAINT_TYPE");
        if (!type || !["PRIMARY KEY", "P"].includes(type.toUpperCase())) {
          return undefined;
        }
        return stringRecordValue(record, "column_name", "COLUMN_NAME");
      })
      .filter((value): value is string => Boolean(value))
  );
}

export function uniqueKeyGroups(constraints: unknown[]): Array<{ name: string; columns: string[] }> {
  const grouped = new Map<string, string[]>();
  for (const row of constraints) {
    const record = row as Record<string, unknown>;
    const type = stringRecordValue(record, "constraint_type", "CONSTRAINT_TYPE");
    if (!type || !["UNIQUE", "U"].includes(type.toUpperCase())) {
      continue;
    }
    const name = stringRecordValue(record, "constraint_name", "CONSTRAINT_NAME") ?? "UNIQUE";
    const column = stringRecordValue(record, "column_name", "COLUMN_NAME");
    if (!column) {
      continue;
    }
    grouped.set(name, [...(grouped.get(name) ?? []), column]);
  }
  return [...grouped.entries()].map(([name, columns]) => ({ name, columns: uniqueStrings(columns) }));
}

export function schemaColumnRoles(columnName: string, primaryKey: boolean): string[] {
  const roles = [];
  if (primaryKey) {
    roles.push("primary_key");
  }
  if (/(^id$|_id$)/i.test(columnName)) {
    roles.push("identifier");
  }
  if (/(created|updated|modified|time|date|timestamp|gmt_)/i.test(columnName)) {
    roles.push("time");
  }
  if (/(status|state|type|category|kind|level|channel|region)/i.test(columnName)) {
    roles.push("status");
  }
  return roles;
}

export function importantSchemaMapFields(
  columns: Array<{ name: string; roles: string[] }>,
  primaryKeys: string[],
  timeFields: string[],
  statusFields: string[]
): string[] {
  return uniqueStrings([
    ...primaryKeys,
    ...columns.filter((column) => column.roles.includes("identifier")).map((column) => column.name),
    ...timeFields,
    ...statusFields
  ]).slice(0, 20);
}

export function groupSchemaMapTables(
  mode: ObConfig["compatibility"],
  tables: Array<{ schema?: string; table: string }>
) {
  const grouped = new Map<string, Array<Record<string, unknown>>>();
  for (const table of tables) {
    const schema = table.schema ?? "";
    grouped.set(schema, [...(grouped.get(schema) ?? []), table as Record<string, unknown>]);
  }
  return [...grouped.entries()]
    .sort(([left], [right]) => normalizeTableName(mode, left).localeCompare(normalizeTableName(mode, right)))
    .map(([schema, schemaTables]) => ({
      schema: schema || undefined,
      tableCount: schemaTables.length,
      tables: schemaTables.sort((left, right) =>
        normalizeTableName(mode, String(left.table ?? "")).localeCompare(normalizeTableName(mode, String(right.table ?? "")))
      )
    }));
}

export async function buildDatabaseDictionary(
  selected: ReturnType<typeof selectRuntimeProfile>,
  tables: SchemaMapTable[],
  maxColumnsPerTable: number
) {
  const dictionaryTables = [];
  for (const tableInfo of tables) {
    const schema = metadataSchema(selected.config, tableInfo.schema);
    assertTableAccess(schema, tableInfo.table, policyContext(selected.config));
    const columns = filterColumnMetadata(
      await cachedDescribeTable(selected, schema, tableInfo.table),
      selected.config.policy
    );
    const constraints = filterColumnMetadata(
      await cachedListConstraints(selected, schema, tableInfo.table),
      selected.config.policy
    );
    const compactColumns = compactSchemaColumns(columns, constraints, selected.config, schema, tableInfo.table);
    dictionaryTables.push({
      schema,
      table: tableInfo.table,
      comment: tableInfo.comment,
      rowEstimate: tableInfo.rowEstimate,
      primaryKeys: schemaMapPrimaryKeyColumns(constraints),
      columns: compactColumns.slice(0, maxColumnsPerTable).map((column) => ({
        name: column.name,
        type: column.type,
        nullable: column.nullable,
        comment: column.comment,
        roles: column.roles,
        masked: column.masked
      })),
      columnsTruncated: compactColumns.length > maxColumnsPerTable
    });
  }
  return {
    generatedAt: new Date().toISOString(),
    tables: dictionaryTables
  };
}

export function renderDatabaseDictionaryMarkdown(dictionary: {
  generatedAt: string;
  tables: Array<{
    schema?: string;
    table: string;
    comment?: string;
    rowEstimate?: { value: number; exact: false; source: string };
    primaryKeys: string[];
    columns: Array<{
      name: string;
      type?: string;
      nullable?: boolean;
      comment?: string;
      roles: string[];
      masked: boolean;
    }>;
    columnsTruncated: boolean;
  }>;
}): string {
  const lines = [
    "# OceanBase Data Dictionary",
    "",
    `Generated at: ${dictionary.generatedAt}`,
    "",
    `Tables: ${dictionary.tables.length}`,
    ""
  ];
  for (const table of dictionary.tables) {
    const title = `${table.schema ? `${table.schema}.` : ""}${table.table}`;
    lines.push(`## ${title}`, "");
    if (table.comment) {
      lines.push(`Comment: ${table.comment}`, "");
    }
    if (table.rowEstimate) {
      lines.push(`Row estimate: ${table.rowEstimate.value} (${table.rowEstimate.source})`, "");
    }
    if (table.primaryKeys.length > 0) {
      lines.push(`Primary key: ${table.primaryKeys.join(", ")}`, "");
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
      lines.push("", `More columns exist for ${title}; output was truncated by maxColumnsPerTable.`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

export function renderDataDictionaryHtml(dictionary: Parameters<typeof renderDatabaseDictionaryMarkdown>[0], title?: string): string {
  const body = dictionary.tables.map((table) => {
    const qualifiedName = `${table.schema ? `${table.schema}.` : ""}${table.table}`;
    const rows = table.columns.map((column) => `
      <tr>
        <td>${escapeInlineHtml(column.name)}</td>
        <td>${escapeInlineHtml(column.type ?? "")}</td>
        <td>${column.nullable == null ? "" : column.nullable ? "YES" : "NO"}</td>
        <td>${escapeInlineHtml(column.roles.join(", "))}</td>
        <td>${column.masked ? "YES" : "NO"}</td>
        <td>${escapeInlineHtml(column.comment ?? "")}</td>
      </tr>
    `).join("");
    const comment = table.comment ? `<p class="comment">${escapeInlineHtml(table.comment)}</p>` : "";
    const rowEstimate = table.rowEstimate ? `<p>Row estimate: ${table.rowEstimate.value} (${escapeInlineHtml(table.rowEstimate.source)})</p>` : "";
    const primaryKeys = table.primaryKeys.length > 0 ? `<p>Primary key: ${escapeInlineHtml(table.primaryKeys.join(", "))}</p>` : "";
    const truncated = table.columnsTruncated ? `<p class="warn">Columns were truncated by maxColumnsPerTable.</p>` : "";
    return `
      <section>
        <h2>${escapeInlineHtml(qualifiedName)}</h2>
        ${comment}
        ${rowEstimate}
        ${primaryKeys}
        <table>
          <thead>
            <tr><th>Column</th><th>Type</th><th>Nullable</th><th>Roles</th><th>Masked</th><th>Comment</th></tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
        ${truncated}
      </section>
    `;
  }).join("\n");
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeInlineHtml(title ?? "OceanBase Data Dictionary")}</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 32px; color: #17202a; }
    h1 { font-size: 28px; margin-bottom: 4px; }
    h2 { font-size: 20px; margin-top: 28px; }
    table { border-collapse: collapse; width: 100%; margin-top: 12px; }
    th, td { border: 1px solid #d7dde5; padding: 8px; text-align: left; vertical-align: top; }
    th { background: #f3f6f8; }
    .meta, .comment, .warn { color: #5b6673; }
  </style>
</head>
<body>
  <h1>${escapeInlineHtml(title ?? "OceanBase Data Dictionary")}</h1>
  <p class="meta">Generated at: ${escapeInlineHtml(dictionary.generatedAt)}. Tables: ${dictionary.tables.length}. No sample data values are included.</p>
  ${body}
</body>
</html>`;
}

export function isRelationshipAllowed(relation: TableRelationship, config: ObConfig): boolean {
  try {
    assertTableAccess(relation.sourceSchema, relation.sourceTable, policyContext(config));
    assertTableAccess(relation.targetSchema, relation.targetTable, policyContext(config));
  } catch {
    return false;
  }
  return [...relation.sourceColumns, ...relation.targetColumns].every(
    (column) => !isDeniedColumn(column, config.policy)
  );
}

function profileColumnMetadata(
  row: unknown,
  mode: ObConfig["compatibility"]
): { name: string; dataType?: string; nullable?: boolean; comment?: string } | undefined {
  const record = row as Record<string, unknown>;
  const name = stringRecordValue(record, "column_name", "COLUMN_NAME");
  if (!name) {
    return undefined;
  }
  const nullableText = stringRecordValue(record, "is_nullable", "IS_NULLABLE", "nullable", "NULLABLE");
  return {
    name,
    dataType: columnTypeLabel(mode, record),
    nullable: nullableText ? !["NO", "N"].includes(nullableText.toUpperCase()) : undefined,
    comment: stringRecordValue(record, "column_comment", "COLUMN_COMMENT", "comments", "COMMENTS")
  };
}

function columnTypeLabel(mode: ObConfig["compatibility"], record: Record<string, unknown>): string | undefined {
  const mysqlType = stringRecordValue(record, "column_type", "COLUMN_TYPE");
  if (mysqlType) {
    return mysqlType;
  }
  const dataType = stringRecordValue(record, "data_type", "DATA_TYPE");
  const length = numberRecordValue(record, "data_length", "DATA_LENGTH");
  if (
    mode === "oracle" &&
    dataType &&
    length &&
    ["CHAR", "NCHAR", "VARCHAR2", "NVARCHAR2", "RAW"].includes(dataType)
  ) {
    return `${dataType}(${length})`;
  }
  return dataType;
}

function normalizeTableName(mode: ObConfig["compatibility"], value: string): string {
  return mode === "oracle" ? value.trim().toUpperCase() : value.trim().toLowerCase();
}

function stringRecordValue(record: Record<string, unknown>, ...keys: string[]): string | undefined {
  const value = keys.map((key) => record[key]).find((item) => typeof item === "string" && item.trim());
  return typeof value === "string" ? value.trim() : undefined;
}

function numberRecordValue(record: Record<string, unknown>, ...keys: string[]): number | undefined {
  const value = keys
    .map((key) => record[key])
    .find((item) => typeof item === "number" || typeof item === "string");
  if (typeof value === "number") {
    return value;
  }
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return undefined;
}

function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const output = [];
  for (const value of values) {
    const normalized = value.trim().toLowerCase();
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    output.push(value);
  }
  return output;
}

function escapeInlineHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
