import { z } from "zod";

import type { ObConfig } from "../../config.js";
import {
  describeTable,
  findRelatedTables,
  listConstraints,
  searchCatalog
} from "../../db.js";
import {
  assertTableAccess,
  explainSqlPolicy,
  filterColumnMetadata,
  isDeniedColumn,
  isSchemaAllowed
} from "../../policy.js";
import { effectiveRowLimit } from "../../query/output.js";
import { generateQueryTemplates, type QueryTemplateScenario } from "../../query-generation.js";
import { selectRuntimeProfile, withQuerySlot, type GatewayRuntime } from "../../runtime.js";
import { selectAuthorizedProfile } from "../access.js";
import {
  normalizeGlossaryText,
  searchBusinessGlossary
} from "../business-glossary.js";
import type { McpRequestContext } from "../context.js";
import { metadataSchema } from "../metadata-scope.js";
import { policyContext } from "../policy-context.js";
import {
  catalogSearchResult,
  dedupeSearchResults,
  glossarySearchResults,
  relatedTableEvidence,
  tableCandidatesFromSearchResults,
  type BusinessTableCandidate,
  type SearchEverythingResult
} from "../search-results.js";
import { explainGeneratedQuery } from "../sql-policy-explain.js";
import { profileInput } from "../schemas.js";
import { toLimitedResult } from "../tool-runtime.js";
import type { ToolRegistrar } from "../tool-registry.js";
import {
  compactSchemaColumns,
  isRelationshipAllowed,
  schemaMapPrimaryKeyColumns
} from "./schema-map.js";

const QUERY_TERM_STOPWORDS = new Set([
  "show",
  "list",
  "find",
  "get",
  "query",
  "select",
  "data",
  "rows",
  "table",
  "recent",
  "latest",
  "count",
  "查询",
  "查看",
  "列出",
  "数据",
  "列表",
  "最近",
  "最新",
  "统计",
  "数量"
]);

export function registerSqlPrepareTools(
  registerTool: ToolRegistrar,
  runtime: GatewayRuntime,
  context: McpRequestContext
): void {
  registerTool(
    "ob_prepare_query",
    {
      title: "Prepare Read-only Query",
      description: "Prepare candidate tables, fields, read-only SQL drafts, and safety previews from visible metadata without executing the target query.",
      inputSchema: {
        ...profileInput,
        question: z.string().min(1),
        businessTerm: z.string().optional(),
        schema: z.string().optional(),
        table: z.string().optional(),
        maxCandidates: z.number().int().positive().max(20).optional(),
        maxColumns: z.number().int().positive().max(50).optional(),
        maxRows: z.number().int().positive().optional()
      }
    },
    async ({ profile, question, businessTerm, schema, table, maxCandidates, maxColumns, maxRows }) => {
      const selected = selectAuthorizedProfile(runtime, profile, context);
      const effectiveSchema = metadataSchema(selected.config, schema);
      if (effectiveSchema && !isSchemaAllowed(effectiveSchema, selected.config.policy)) {
        throw new Error(`Schema "${effectiveSchema}" is not allowed by the configured OceanBase MCP access policy.`);
      }
      const candidateLimit = Math.min(maxCandidates ?? 5, 20);
      const searchTerms = prepareQuerySearchTerms(question, businessTerm, table);
      const warnings: string[] = [];
      const candidates = table
        ? explicitPrepareQueryCandidate(selected.config, effectiveSchema, table)
        : await findPrepareQueryCandidates(selected, searchTerms, effectiveSchema, candidateLimit, warnings);
      const preparedCandidates = [];
      for (const candidate of candidates.slice(0, candidateLimit)) {
        preparedCandidates.push(await buildPreparedQueryCandidate(
          selected,
          candidate,
          question,
          maxColumns ?? 12,
          effectiveRowLimit(maxRows, selected.config)
        ));
      }
      if (preparedCandidates.length === 0) {
        warnings.push("No visible candidate table was found from the supplied question or business term. Search metadata first or pass schema and table explicitly.");
      }

      return toLimitedResult(
        {
          mode: selected.config.compatibility,
          question,
          businessTerm: businessTerm ?? null,
          schema: effectiveSchema ?? null,
          table: table ?? null,
          searchTerms,
          candidateCount: preparedCandidates.length,
          candidates: preparedCandidates,
          workflow: [
            "Review candidate evidence before using a SQL draft.",
            "Run ob_query_preview before executing a query.",
            "Use ob_query_page for data inspection when paging is needed."
          ],
          executed: false,
          warnings: uniqueStrings(warnings)
        },
        selected.config
      );
    }
  );
}

function explicitPrepareQueryCandidate(
  config: ObConfig,
  schema: string | undefined,
  table: string
): BusinessTableCandidate[] {
  const normalizedSchema = config.compatibility === "oracle" && schema ? schema.trim().toUpperCase() : schema;
  const normalizedTable = config.compatibility === "oracle" ? table.trim().toUpperCase() : table.trim();
  assertTableAccess(normalizedSchema, normalizedTable, policyContext(config));
  return [{
    schema: normalizedSchema,
    table: normalizedTable,
    confidence: 1,
    sources: ["explicit_input"],
    matchedColumns: [],
    terms: [],
    evidence: [{
      source: "explicit_input",
      type: "table",
      field: "table",
      value: normalizedTable,
      reason: "The caller supplied an explicit table."
    }]
  }];
}

export async function findPrepareQueryCandidates(
  selected: ReturnType<typeof selectRuntimeProfile>,
  searchTerms: string[],
  schema: string | undefined,
  limit: number,
  warnings: string[]
): Promise<BusinessTableCandidate[]> {
  const results: SearchEverythingResult[] = [];
  const warningSet = new Set(warnings);
  for (const term of searchTerms.slice(0, 8)) {
    const rows = filterColumnMetadata(
      await withQuerySlot(selected, () =>
        searchCatalog(
          selected.pool,
          selected.config.compatibility,
          term,
          schema,
          Math.max(limit * 8, 20),
          selected.config.queryTimeoutMs
        )
      ),
      selected.config.policy
    );
    results.push(...rows.flatMap((row) => catalogSearchResult(row, term, selected.config)));
    const glossary = searchBusinessGlossary(selected.config, term, limit * 4, schema);
    results.push(...glossary.matches.flatMap((match) => glossarySearchResults(match, term)));
    for (const warning of glossary.warnings) {
      warningSet.add(warning);
    }
  }
  warnings.splice(0, warnings.length, ...warningSet);
  return tableCandidatesFromSearchResults(
    dedupeSearchResults(results),
    selected.config,
    limit
  );
}

async function buildPreparedQueryCandidate(
  selected: ReturnType<typeof selectRuntimeProfile>,
  candidate: BusinessTableCandidate,
  question: string,
  maxColumns: number,
  rowLimit: number
) {
  const schema = metadataSchema(selected.config, candidate.schema);
  assertTableAccess(schema, candidate.table, policyContext(selected.config));
  const columns = filterColumnMetadata(
    await withQuerySlot(selected, () =>
      describeTable(selected.pool, selected.config.compatibility, candidate.table, schema, selected.config.queryTimeoutMs)
    ),
    selected.config.policy
  );
  const constraints = filterColumnMetadata(
    await withQuerySlot(selected, () =>
      listConstraints(selected.pool, selected.config.compatibility, candidate.table, schema, selected.config.queryTimeoutMs)
    ),
    selected.config.policy
  );
  const relationshipResult = await withQuerySlot(selected, () =>
    findRelatedTables(selected.pool, selected.config.compatibility, candidate.table, schema, 1, 20, selected.config.queryTimeoutMs)
  );
  const relationships = relationshipResult.relations.filter((relation) =>
    isRelationshipAllowed(relation, selected.config) &&
    relation.sourceColumns.every((column) => !isDeniedColumn(column, selected.config.policy)) &&
    relation.targetColumns.every((column) => !isDeniedColumn(column, selected.config.policy))
  );
  const compactColumns = compactSchemaColumns(columns, constraints, selected.config, schema, candidate.table);
  const primaryKeys = schemaMapPrimaryKeyColumns(constraints);
  const timeFields = compactColumns.filter((column) => column.roles.includes("time")).map((column) => column.name);
  const statusFields = compactColumns.filter((column) => column.roles.includes("status")).map((column) => column.name);
  const generated = generateQueryTemplates({
    mode: selected.config.compatibility,
    schema,
    table: candidate.table,
    columns,
    constraints,
    relationships,
    scenarios: prepareQueryScenarios(question),
    maxColumns,
    rowLimit
  });
  const templates = generated.templates.slice(0, 5).map((template) => ({
    ...template,
    policy: explainGeneratedQuery(template.sql, template.parameters.length, selected.config)
  }));
  const matchedColumns = candidate.matchedColumns.filter((column) => !isDeniedColumn(column, selected.config.policy));

  return {
    schema,
    table: candidate.table,
    confidence: candidate.confidence,
    sources: candidate.sources,
    terms: candidate.terms,
    matchedColumns,
    evidence: candidate.evidence.slice(0, 20),
    fields: compactColumns.slice(0, Math.max(1, Math.min(maxColumns, 50))),
    fieldCount: compactColumns.length,
    primaryKeys,
    timeFields,
    statusFields,
    relatedTables: relationships.slice(0, 8).map((relation) => relatedTableEvidence(candidate, relation, selected.config.compatibility)).filter(Boolean),
    queryTemplates: templates,
    suggestedSql: templates[0] ?? null,
    pagination: preparePaginationSuggestion(rowLimit, primaryKeys, timeFields),
    riskPreview: {
      executed: false,
      generatedSqlCount: templates.length,
      allDraftsPassPolicy: templates.every((template) => template.policy.allowed),
      warnings: [
        ...generated.warnings,
        "No target query was executed. Use ob_query_preview before running a draft."
      ]
    }
  };
}

function prepareQueryScenarios(question: string): QueryTemplateScenario[] {
  const text = question.toLowerCase();
  const scenarios: QueryTemplateScenario[] = [];
  if (/(count|total|summary|group|aggregate|统计|数量|汇总|聚合)/i.test(text)) {
    scenarios.push("aggregation");
  }
  if (/(recent|latest|time|date|range|最近|最新|时间|日期)/i.test(text)) {
    scenarios.push("time_range");
  }
  if (/(id|primary key|主键|编号)/i.test(text)) {
    scenarios.push("by_primary_key");
  }
  if (/(join|related|detail|关联|联表|明细)/i.test(text)) {
    scenarios.push("join");
  }
  scenarios.push("pagination", "by_primary_key", "time_range", "aggregation", "join");
  return uniqueStrings(scenarios) as QueryTemplateScenario[];
}

function preparePaginationSuggestion(
  rowLimit: number,
  primaryKeys: string[],
  timeFields: string[]
) {
  const orderBy = primaryKeys[0] ?? timeFields[0];
  return {
    tool: "ob_query_page",
    pageSize: Math.min(rowLimit, 50),
    orderBy: orderBy ?? null,
    stableOrder: primaryKeys.length > 0,
    warning: orderBy
      ? primaryKeys.length > 0
        ? "Primary-key ordering is available for repeatable pages."
        : "A time-like column is available, but ordering may not be unique."
      : "No stable ordering field was detected; pass orderBy before paging."
  };
}

export function prepareQuerySearchTerms(
  question: string,
  businessTerm: string | undefined,
  table: string | undefined
): string[] {
  const terms = [
    businessTerm,
    table,
    question.trim().length <= 80 ? question : undefined,
    ...extractAsciiQueryTerms(question),
    ...extractHanQueryTerms(question)
  ];
  return uniqueStrings(
    terms
      .filter((value): value is string => typeof value === "string")
      .map((value) => value.trim())
      .filter(isUsefulQueryTerm)
  ).slice(0, 8);
}

function extractAsciiQueryTerms(value: string): string[] {
  return value.match(/[A-Za-z0-9_]{2,}/g) ?? [];
}

function extractHanQueryTerms(value: string): string[] {
  const output: string[] = [];
  const runs = value.match(/[\u4e00-\u9fff]{2,}/g) ?? [];
  for (const run of runs) {
    for (const size of [2, 3]) {
      for (let index = 0; index <= run.length - size; index += 1) {
        output.push(run.slice(index, index + size));
        if (output.length >= 24) {
          return output;
        }
      }
    }
  }
  return output;
}

function isUsefulQueryTerm(value: string): boolean {
  const normalized = normalizeGlossaryText(value);
  return normalized.length >= 2 && !QUERY_TERM_STOPWORDS.has(normalized);
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
