import { z } from "zod";

import type { ObConfig } from "../../config.js";
import { isSchemaAllowed } from "../../policy.js";
import { selectRuntimeProfile, type GatewayRuntime } from "../../runtime.js";
import { selectAuthorizedProfile } from "../access.js";
import {
  searchBusinessGlossary,
  visibleGlossaryTargets
} from "../business-glossary.js";
import type { McpRequestContext } from "../context.js";
import {
  inferTablePurpose,
  tableSummaryQueryEntryPoints
} from "../metadata-summary.js";
import { metadataSchema } from "../metadata-scope.js";
import { profileInput, tableDocumentFormatSchema } from "../schemas.js";
import { toLimitedResult } from "../tool-runtime.js";
import type { ToolRegistrar } from "../tool-registry.js";
import { renderOnboardingDocumentMarkdown } from "./documentation-onboarding-render.js";
import { renderSchemaDocumentMarkdown } from "./documentation-schema-render.js";
import { buildTableDocument } from "./documentation-table-build.js";
import { renderTableDocumentMarkdown } from "./documentation-table-render.js";
import {
  buildSchemaMapRelationshipSummary,
  buildSchemaMapTableSummary,
  cachedSchemaMapTables,
  filterSchemaMapTables,
} from "./schema-map.js";

export function registerDocumentationTools(
  registerTool: ToolRegistrar,
  runtime: GatewayRuntime,
  context: McpRequestContext
): void {
  registerTool(
    "ob_generate_table_doc",
    {
      title: "Generate Table Documentation",
      description: "Generate bounded JSON or Markdown documentation for one visible table without returning sample values.",
      inputSchema: {
        ...profileInput,
        table: z.string().min(1),
        schema: z.string().optional(),
        format: tableDocumentFormatSchema.optional().default("markdown"),
        includeRelationships: z.boolean().optional().default(true),
        includeQueryExamples: z.boolean().optional().default(true),
        maxColumns: z.number().int().positive().max(200).optional(),
        relationshipLimit: z.number().int().positive().max(50).optional(),
        maxExamples: z.number().int().positive().max(10).optional(),
        title: z.string().min(1).max(120).optional()
      }
    },
    async ({
      profile,
      table,
      schema,
      format = "markdown",
      includeRelationships = true,
      includeQueryExamples = true,
      maxColumns,
      relationshipLimit,
      maxExamples,
      title
    }) => {
      const selected = selectAuthorizedProfile(runtime, profile, context);
      const document = await buildTableDocument(selected, {
        schema,
        table,
        includeRelationships,
        includeQueryExamples,
        maxColumns: maxColumns ?? 80,
        relationshipLimit: relationshipLimit ?? 20,
        maxExamples: maxExamples ?? 6
      });
      return toLimitedResult(
        {
          format,
          mode: selected.config.compatibility,
          schema: document.schema,
          table: document.table,
          generatedAt: document.generatedAt,
          executed: false,
          document,
          markdown: format === "markdown" ? renderTableDocumentMarkdown(document, title) : undefined,
          warnings: document.warnings
        },
        selected.config
      );
    }
  );

  registerTool(
    "ob_generate_schema_doc",
    {
      title: "Generate Schema Documentation",
      description: "Generate bounded JSON or Markdown documentation for visible tables in one schema.",
      inputSchema: {
        ...profileInput,
        schema: z.string().optional(),
        tablePattern: z.string().optional(),
        format: tableDocumentFormatSchema.optional().default("markdown"),
        maxTables: z.number().int().positive().max(100).optional(),
        maxColumnsPerTable: z.number().int().positive().max(80).optional(),
        includeRelationships: z.boolean().optional().default(true),
        relationshipLimit: z.number().int().positive().max(50).optional(),
        title: z.string().min(1).max(120).optional()
      }
    },
    async ({
      profile,
      schema,
      tablePattern,
      format = "markdown",
      maxTables,
      maxColumnsPerTable,
      includeRelationships = true,
      relationshipLimit,
      title
    }) => {
      const selected = selectAuthorizedProfile(runtime, profile, context);
      const document = await buildSchemaDocument(selected, {
        schema,
        tablePattern,
        maxTables: maxTables ?? 20,
        maxColumnsPerTable: maxColumnsPerTable ?? 20,
        includeRelationships,
        relationshipLimit: relationshipLimit ?? 10
      });
      return toLimitedResult(
        {
          format,
          mode: selected.config.compatibility,
          schema: document.schema,
          tablePattern: document.tablePattern,
          generatedAt: document.generatedAt,
          executed: false,
          document,
          markdown: format === "markdown" ? renderSchemaDocumentMarkdown(document, title) : undefined,
          warnings: document.warnings
        },
        selected.config
      );
    }
  );

  registerTool(
    "ob_generate_onboarding_doc",
    {
      title: "Generate Onboarding Documentation",
      description: "Generate bounded onboarding documentation from visible OceanBase metadata and optional business glossary hints.",
      inputSchema: {
        ...profileInput,
        schema: z.string().optional(),
        tablePattern: z.string().optional(),
        businessTerms: z.array(z.string().min(1)).max(20).optional(),
        format: tableDocumentFormatSchema.optional().default("markdown"),
        maxTables: z.number().int().positive().max(100).optional(),
        maxColumnsPerTable: z.number().int().positive().max(50).optional(),
        maxCoreTables: z.number().int().positive().max(30).optional(),
        relationshipLimit: z.number().int().positive().max(50).optional(),
        title: z.string().min(1).max(120).optional()
      }
    },
    async ({
      profile,
      schema,
      tablePattern,
      businessTerms,
      format = "markdown",
      maxTables,
      maxColumnsPerTable,
      maxCoreTables,
      relationshipLimit,
      title
    }) => {
      const selected = selectAuthorizedProfile(runtime, profile, context);
      const document = await buildOnboardingDocument(selected, {
        schema,
        tablePattern,
        businessTerms,
        maxTables: maxTables ?? 30,
        maxColumnsPerTable: maxColumnsPerTable ?? 12,
        maxCoreTables: maxCoreTables ?? 8,
        relationshipLimit: relationshipLimit ?? 12
      });
      return toLimitedResult(
        {
          format,
          mode: selected.config.compatibility,
          schema: document.schema,
          tablePattern: document.tablePattern,
          generatedAt: document.generatedAt,
          executed: false,
          document,
          markdown: format === "markdown" ? renderOnboardingDocumentMarkdown(document, title) : undefined,
          warnings: document.warnings
        },
        selected.config
      );
    }
  );
}

async function buildSchemaDocument(
  selected: ReturnType<typeof selectRuntimeProfile>,
  input: {
    schema?: string;
    tablePattern?: string;
    maxTables: number;
    maxColumnsPerTable: number;
    includeRelationships: boolean;
    relationshipLimit: number;
  }
) {
  const effectiveSchema = metadataSchema(selected.config, input.schema);
  if (effectiveSchema && !isSchemaAllowed(effectiveSchema, selected.config.policy)) {
    throw new Error(`Schema "${effectiveSchema}" is not allowed by the configured OceanBase MCP access policy.`);
  }
  const tableLimit = Math.min(input.maxTables, 100);
  const columnLimit = Math.min(input.maxColumnsPerTable, 80);
  const rawTables = await cachedSchemaMapTables(selected, effectiveSchema, input.tablePattern, tableLimit + 1);
  const visibleTables = filterSchemaMapTables(rawTables, selected.config).slice(0, tableLimit);
  const tables = [];
  for (const tableInfo of visibleTables) {
    tables.push(await buildSchemaMapTableSummary(
      selected,
      tableInfo,
      true,
      columnLimit,
      input.includeRelationships,
      input.relationshipLimit
    ));
  }
  const warnings = uniqueStrings([
    "Schema documentation is based on metadata visible to the active MCP policy.",
    "No sample data values are included.",
    rawTables.length > tableLimit ? `Only the first ${tableLimit} visible tables are included.` : "",
    tables.some((table) => table.columnsTruncated) ? `Some tables have more than ${columnLimit} visible columns; columns were truncated.` : ""
  ]);

  return {
    generatedAt: new Date().toISOString(),
    mode: selected.config.compatibility,
    schema: effectiveSchema,
    tablePattern: input.tablePattern ?? null,
    maxTables: tableLimit,
    maxColumnsPerTable: columnLimit,
    includeRelationships: input.includeRelationships,
    tableCount: tables.length,
    truncated: rawTables.length > tableLimit,
    tables,
    warnings
  };
}

async function buildOnboardingDocument(
  selected: ReturnType<typeof selectRuntimeProfile>,
  input: {
    schema?: string;
    tablePattern?: string;
    businessTerms?: string[];
    maxTables: number;
    maxColumnsPerTable: number;
    maxCoreTables: number;
    relationshipLimit: number;
  }
) {
  const effectiveSchema = metadataSchema(selected.config, input.schema);
  if (effectiveSchema && !isSchemaAllowed(effectiveSchema, selected.config.policy)) {
    throw new Error(`Schema "${effectiveSchema}" is not allowed by the configured OceanBase MCP access policy.`);
  }
  const tableLimit = Math.min(input.maxTables, 100);
  const columnLimit = Math.min(input.maxColumnsPerTable, 50);
  const coreLimit = Math.min(input.maxCoreTables, 30);
  const relationLimit = Math.min(input.relationshipLimit, 50);
  const rawTables = await cachedSchemaMapTables(selected, effectiveSchema, input.tablePattern, tableLimit + 1);
  const visibleTables = filterSchemaMapTables(rawTables, selected.config).slice(0, tableLimit);
  const tableSummaries = [];
  for (const tableInfo of visibleTables) {
    tableSummaries.push(await buildSchemaMapTableSummary(
      selected,
      tableInfo,
      true,
      columnLimit,
      true,
      relationLimit
    ));
  }
  const coreTables = tableSummaries
    .map((table) => onboardingCoreTable(table))
    .sort((left, right) => right.score - left.score || qualifiedTableName(left).localeCompare(qualifiedTableName(right)))
    .slice(0, coreLimit);
  const relationships = onboardingRelationships(coreTables, relationLimit);
  const glossary = onboardingGlossary(selected.config, effectiveSchema, uniqueStrings(input.businessTerms ?? []), 20);
  const queryEntryPoints = coreTables.flatMap((table) =>
    table.queryEntryPoints.map((entry) => ({
      schema: table.schema,
      table: table.table,
      type: entry.type,
      fields: entry.fields,
      reason: entry.reason
    }))
  ).slice(0, 100);
  const warnings = uniqueStrings([
    "Onboarding documentation is based on metadata visible to the active MCP policy.",
    "No sample data values are included and no target query is executed.",
    "Purpose and table roles are inferred from visible metadata and business glossary hints; verify with domain knowledge before treating them as business facts.",
    rawTables.length > tableLimit ? `Only the first ${tableLimit} visible tables are included.` : "",
    tableSummaries.some((table) => table.columnsTruncated) ? `Some tables have more than ${columnLimit} visible columns; columns were truncated.` : "",
    relationships.truncated ? `Relationship output was limited to ${relationships.items.length} entries.` : "",
    ...glossary.warnings
  ]);

  return {
    generatedAt: new Date().toISOString(),
    mode: selected.config.compatibility,
    schema: effectiveSchema,
    tablePattern: input.tablePattern ?? null,
    scope: {
      maxTables: tableLimit,
      maxColumnsPerTable: columnLimit,
      maxCoreTables: coreLimit,
      relationshipLimit: relationLimit,
      tableCount: tableSummaries.length,
      truncated: rawTables.length > tableLimit
    },
    businessGlossary: glossary,
    coreTables: coreTables.map(({ score, ...table }) => table),
    relationships: relationships.items,
    queryEntryPoints,
    readingPath: onboardingReadingPath(coreTables, glossary.terms),
    warnings
  };
}

function onboardingCoreTable(table: Awaited<ReturnType<typeof buildSchemaMapTableSummary>>) {
  const columns = table.columns ?? [];
  const relationshipCount = (table.relationSummary?.outbound ?? 0) + (table.relationSummary?.inbound ?? 0);
  const purpose = inferTablePurpose(table.table, table.comment, columns);
  const queryEntryPoints = tableSummaryQueryEntryPoints(
    table.primaryKeys,
    table.timeFields,
    table.statusFields,
    table.relationSummary
  );
  return {
    schema: table.schema,
    table: table.table,
    tableType: table.tableType,
    comment: table.comment,
    rowEstimate: table.rowEstimate,
    purpose,
    primaryKeys: table.primaryKeys,
    keyFields: table.keyFields,
    timeFields: table.timeFields,
    statusFields: table.statusFields,
    relationshipCount,
    relationSummary: table.relationSummary,
    queryEntryPoints,
    columns,
    columnsTruncated: table.columnsTruncated,
    score: onboardingCoreTableScore(table, relationshipCount)
  };
}

function onboardingCoreTableScore(
  table: Awaited<ReturnType<typeof buildSchemaMapTableSummary>>,
  relationshipCount: number
): number {
  const rowEstimate = table.rowEstimate?.value ?? 0;
  return (
    relationshipCount * 6 +
    table.primaryKeys.length * 5 +
    table.keyFields.length * 2 +
    table.timeFields.length +
    table.statusFields.length +
    (table.comment ? 4 : 0) +
    Math.min(8, Math.log10(rowEstimate + 1))
  );
}

function onboardingRelationships(
  coreTables: Array<ReturnType<typeof onboardingCoreTable>>,
  limit: number
) {
  const seen = new Set<string>();
  const relationships = [];
  for (const table of coreTables) {
    for (const relation of table.relationSummary?.relations ?? []) {
      const signature = [
        relation.relationType,
        relation.sourceSchema ?? "",
        relation.sourceTable,
        relation.sourceColumns.join(","),
        relation.targetSchema ?? "",
        relation.targetTable,
        relation.targetColumns.join(",")
      ].map((part) => part.toLowerCase()).join("|");
      if (seen.has(signature)) {
        continue;
      }
      seen.add(signature);
      relationships.push({
        relationType: relation.relationType,
        direction: relation.direction,
        confidence: relation.confidence,
        sourceSchema: relation.sourceSchema,
        sourceTable: relation.sourceTable,
        sourceColumns: relation.sourceColumns,
        targetSchema: relation.targetSchema,
        targetTable: relation.targetTable,
        targetColumns: relation.targetColumns,
        evidence: relation.evidence
      });
    }
  }
  relationships.sort((left, right) => right.confidence - left.confidence || qualifiedRelationName(left).localeCompare(qualifiedRelationName(right)));
  return {
    items: relationships.slice(0, limit),
    truncated: relationships.length > limit
  };
}

function onboardingGlossary(
  config: ObConfig,
  schema: string | undefined,
  requestedTerms: string[],
  maxTerms: number
) {
  const glossary = config.businessGlossary;
  if (!glossary) {
    return {
      configured: false,
      requestedTerms,
      terms: [],
      policyFiltered: false,
      warnings: ["No business glossary is configured."]
    };
  }
  const terms = [];
  let policyFiltered = false;
  if (requestedTerms.length > 0) {
    for (const term of requestedTerms) {
      const result = searchBusinessGlossary(config, term, maxTerms, schema);
      policyFiltered = policyFiltered || result.policyFiltered;
      for (const match of result.matches) {
        terms.push({
          term: match.term,
          aliases: match.aliases,
          description: match.description,
          targets: match.targets,
          evidence: match.evidence
        });
      }
    }
  } else {
    for (const entry of glossary.entries) {
      const targets = visibleGlossaryTargets(config, entry.targets, schema);
      policyFiltered = policyFiltered || targets.policyFiltered;
      if (targets.visible.length === 0) {
        continue;
      }
      terms.push({
        term: entry.term,
        aliases: entry.aliases,
        description: entry.description,
        targets: targets.visible,
        evidence: ["Configured business glossary term."]
      });
      if (terms.length >= maxTerms) {
        break;
      }
    }
  }
  const uniqueTerms = dedupeOnboardingGlossaryTerms(terms).slice(0, maxTerms);
  const warnings = [];
  if (requestedTerms.length > 0 && uniqueTerms.length === 0) {
    warnings.push("No requested business terms matched visible glossary targets.");
  }
  if (policyFiltered) {
    warnings.push("Some business glossary targets were hidden by the active MCP access policy.");
  }
  return {
    configured: true,
    requestedTerms,
    terms: uniqueTerms,
    policyFiltered,
    warnings
  };
}

function dedupeOnboardingGlossaryTerms<T extends { term: string; targets: Array<{ schema?: string; table?: string; column?: string }> }>(terms: T[]): T[] {
  const seen = new Set<string>();
  const output = [];
  for (const term of terms) {
    const targetKey = term.targets
      .map((target) => `${target.schema ?? ""}.${target.table ?? ""}.${target.column ?? ""}`)
      .sort()
      .join("|");
    const key = `${term.term.toLowerCase()}|${targetKey.toLowerCase()}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    output.push(term);
  }
  return output;
}

function onboardingReadingPath(
  coreTables: Array<ReturnType<typeof onboardingCoreTable>>,
  terms: Array<{ term: string; targets: Array<{ schema?: string; table?: string; column?: string }> }>
) {
  const steps = [];
  const first = coreTables[0];
  if (first) {
    steps.push({
      step: "Start with the highest-signal table.",
      table: qualifiedTableName(first),
      reason: "This table has the strongest visible metadata signal from keys, relationships, comments, and row estimates."
    });
  }
  const related = coreTables.find((table) => table.relationshipCount > 0);
  if (related) {
    steps.push({
      step: "Review its related tables next.",
      table: qualifiedTableName(related),
      reason: "Visible relationship metadata or conservative relationship inference is available."
    });
  }
  const timeTable = coreTables.find((table) => table.timeFields.length > 0);
  if (timeTable) {
    steps.push({
      step: "Use time fields for recent-data exploration.",
      table: qualifiedTableName(timeTable),
      fields: timeTable.timeFields.slice(0, 5),
      reason: "Time-like columns were detected from visible column metadata."
    });
  }
  if (terms.length > 0) {
    steps.push({
      step: "Use business terms as navigation hints.",
      terms: terms.slice(0, 10).map((term) => term.term),
      reason: "Business glossary entries point to visible schema, table, or column targets."
    });
  }
  return steps;
}

function qualifiedTableName(table: { schema?: string; table: string }): string {
  return `${table.schema ? `${table.schema}.` : ""}${table.table}`;
}

function qualifiedRelationName(relation: { sourceSchema?: string; sourceTable: string; targetSchema?: string; targetTable: string }): string {
  return `${relation.sourceSchema ? `${relation.sourceSchema}.` : ""}${relation.sourceTable}->${relation.targetSchema ? `${relation.targetSchema}.` : ""}${relation.targetTable}`;
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
